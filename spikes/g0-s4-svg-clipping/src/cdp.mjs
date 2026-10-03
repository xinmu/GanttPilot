/* global fetch, WebSocket, setTimeout */
/**
 * 零依赖 CDP 驱动：用 Node 内置 `fetch` + 内置 `WebSocket` 控制本机 Chrome。
 *
 * 为什么不用 Playwright/Puppeteer（CONTRIBUTING 的依赖准入流程 + ADR 0007 §9 的"优先零新增依赖"）：
 * - 本机已有 Chrome；CDP 只需要"启动 → 读端口 → 连 WebSocket → `Runtime.evaluate`"四步；
 * - 缺 Chrome 时**失败而不是跳过**（P-12 口径），零依赖方案在这条上也更简单。
 *
 * 两条踩过的坑（都已写进实现）：
 * 1. **子进程只能用 `stdio: 'ignore'`**：受限沙箱下 Node 用管道捕获子进程输出会 `EPERM`，
 *    而这里也根本不需要读 Chrome 的 stdout——它把端口写到 `DevToolsActivePort`；
 * 2. **必须用 `--remote-debugging-port=0` 再读端口文件**：硬编码端口会和用户已开的 Chrome 冲突。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** 常见的 Chrome 安装位置（可用 `GANTTPILOT_CHROME` 覆盖）。 */
export const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** @returns {string | null} */
export function resolveChromePath() {
  const override = process.env.GANTTPILOT_CHROME;
  if (override !== undefined && override !== '' && existsSync(override)) return override;
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * @param {{ chromePath: string, userDataDir: string, windowSize?: string, extraArgs?: readonly string[] }} options
 */
export async function launchChrome({ chromePath, userDataDir, windowSize = '1280,720', extraArgs = [] }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--force-device-scale-factor=1',
    `--window-size=${windowSize}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(portFile)) {
      const value = readFileSync(portFile, 'utf8').split('\n')[0]?.trim();
      if (value !== undefined && value !== '') {
        port = Number(value);
        break;
      }
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (port === null) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    throw new Error(`Chrome 未在 20 秒内暴露 DevTools 端口（端口文件：${portFile}）`);
  }
  /** @returns {Promise<void>} */
  const close = async () => {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  };
  return { child, port, close };
}

/** @param {number} port @returns {Promise<{ browser: string, userAgent: string, protocolVersion: string }>} */
export async function chromeVersion(port) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
  const json = /** @type {Record<string, string>} */ (await response.json());
  return {
    browser: json.Browser ?? '',
    userAgent: json['User-Agent'] ?? '',
    protocolVersion: json['Protocol-Version'] ?? '',
  };
}

/**
 * @param {number} port
 * @returns {Promise<{ type: string, url: string, webSocketDebuggerUrl?: string }[]>}
 */
export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
  return /** @type {{ type: string, url: string, webSocketDebuggerUrl?: string }[]} */ (await response.json());
}

/**
 * 极简 CDP 会话：只需要 `send(method, params)`。
 * @param {string} webSocketUrl
 */
export async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;
  /** @type {((event: { method: string, params: unknown }) => void) | null} */
  let eventHandler = null;

  await new Promise((settle, fail) => {
    socket.onopen = () => settle(undefined);
    socket.onerror = () => fail(new Error('CDP WebSocket 连接失败'));
  });

  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
      return;
    }
    if (eventHandler !== null && typeof message.method === 'string') {
      eventHandler({ method: message.method, params: message.params });
    }
  };

  /** @param {string} method @param {Record<string, unknown>} [params] @param {number} [timeoutMs] */
  const send = (method, params = {}, timeoutMs = 180_000) =>
    new Promise((settle, fail) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: settle, reject: fail });
      socket.send(JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          fail(new Error(`CDP ${method} 超时（${String(timeoutMs)} ms）`));
        }
      }, timeoutMs);
      timer.unref?.();
    });

  return {
    send,
    /** @param {(event: { method: string, params: unknown }) => void} handler */
    onEvent: (handler) => {
      eventHandler = handler;
    },
    close: () => {
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 在页面里求值（`awaitPromise` 用于等待探针页的完成 Promise）。
 * @param {Awaited<ReturnType<typeof connectCdp>>} session
 * @param {string} expression
 * @param {{ awaitPromise?: boolean, timeoutMs?: number }} [options]
 */
export async function evaluate(session, expression, options = {}) {
  const result = await session.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: options.awaitPromise ?? false,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: false,
    },
    options.timeoutMs ?? 180_000,
  );
  if (result.exceptionDetails !== undefined && result.exceptionDetails !== null) {
    throw new Error(`页面内异常：${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

/** @param {Awaited<ReturnType<typeof connectCdp>>} session @param {string} url */
export async function navigate(session, url) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Page.navigate', { url });
  // 等页面把探针 Promise 挂上来。刚导航时旧的执行上下文会被销毁，`evaluate` 可能报错——
  // 那是**预期**的，重试即可（这是唯一需要轮询的地方）。
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const ready = await evaluate(session, 'Boolean(window.__G4S__ && window.__G4S__.done)');
      if (ready === true) return;
    } catch {
      /* 导航中途的正常抖动 */
    }
    await sleep(100);
  }
  throw new Error('页面未在 60 秒内挂载 __G4S__.done');
}
