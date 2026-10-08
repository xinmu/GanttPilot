#!/usr/bin/env node
/**
 * **无头 Chrome 的启动、CDP 客户端与静态产物伺服**（`scripts/` 共用；零新增依赖）。
 *
 * ## 为什么存在（P3/C1）
 *
 * `measure-render.mjs` / `smoke-build.mjs` / `offline-artifact-probe.mjs` 原先各自重写了一遍
 * 「找 Chrome / 启动 / 读 `DevToolsActivePort` / CDP 客户端 / 静态服务器 + MIME 表」（约 440 行）。
 * 抽出来之后，各脚本**只保留自己的模式差异**，并且它们作为参数传进来：
 *
 * | 差异 | 由谁传 |
 * |---|---|
 * | `--disable-gpu` | `smoke-build`（两种模式）/ `offline-artifact-probe` |
 * | `--allow-file-access-from-files` | `smoke-build --file` / `offline-artifact-probe` |
 * | `--disable-extensions` / `--disable-background-networking` / `--force-device-scale-factor=1` | `measure-render` |
 * | 窗口尺寸（`--window-size`） | `smoke-build` / `offline-artifact-probe` 传 1600×900；`measure-render` **不传**（有效视口由 `Emulation.setDeviceMetricsOverride` 固定） |
 * | profile 根名 | 各自（`measure-chrome-profile` / `smoke-profile` / `offline-profile`） |
 * | 端口等待预算 | `measure-render` 20 s；其余默认 10 s |
 * | `file:` 目标优先 | `smoke-build --file` |
 * | 是否删 profile 目录 | `smoke-build` / `offline-artifact-probe` 删；`measure-render` 不删（`tmp/` 清理策略见 C7） |
 * | Chrome 回退到 Edge | **只有** `measure-render`（沿用它的现状） |
 *
 * ## 什么**不**在这里
 *
 * 收尾（profile 白名单闸、协议级 `Browser.close`、PID 树兜底）仍在 `scripts/chrome-harness.mjs`
 * ——那份文件是不可逆动作的唯一落点，且本文件反过来复用它（`readDevToolsEndpoint` /
 * `closeOwnChrome` / `ensureProfileDir`）。所以 `DevToolsActivePort` 在本仓库只被两处读：
 * 这里的**启动等待**与那里的**收尾**（两个不同用途）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import {
  closeOwnChrome,
  ensureProfileDir,
  profileDirFor,
  psCommandLine,
  readDevToolsEndpoint,
} from './chrome-harness.mjs';

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

/** 静态服务器的 MIME 表（模块私有：只有 `startStaticServer` 用）。 */
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

/**
 * 找 Chrome：显式环境变量优先，其次常见安装位置（找不到就抛错，**不跳过**）。
 *
 * `allowEdge` 是**刻意保留的差异**：只有 `measure-render.mjs` 的现状会回退到 Edge，
 * 因此只有它传 `true`；门禁侧两个脚本不引入新的回退（否则"绿"可能来自另一个浏览器）。
 */
export function findChrome({ allowEdge = false } = {}) {
  const explicit = process.env.GANTTPILOT_CHROME;
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit;
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          // 环境变量缺失时的硬编码回退（原 `measure-render.mjs` 的那一份）。
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ...(allowEdge ? ['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'] : []),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome；用 GANTTPILOT_CHROME=<path> 指定（缺 Chrome 即失败，不跳过）。');
}

/**
 * 拉起无头 Chrome（`--remote-debugging-port=0`，端口由 `DevToolsActivePort` 落盘给出）。
 *
 * **只接受白名单 profile 根名**（不是任意目录）：目录由 `profileDirFor` + `ensureProfileDir` 造，
 * 后者内含 `chrome-harness.mjs` 的 profile 闸 ⇒ 收尾闸不可能被绕过。
 *
 * 不做 spawn 的 `error` 监听（与抽取前的三个脚本一致：`findChrome` 已 `existsSync` 兜住 ENOENT）。
 */
export function spawnChrome(executable, { profileRoot, extraArgs = [], windowSize = null } = {}) {
  const profileDir = ensureProfileDir(profileDirFor(profileRoot));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(windowSize === null ? [] : [`--window-size=${String(windowSize.width)},${String(windowSize.height)}`]),
      ...extraArgs,
      'about:blank',
    ],
    // 受限沙箱下用管道捕获子进程输出会 EPERM：这里显式忽略 stdio。
    { stdio: 'ignore', detached: false },
  );
  return { child, profileDir };
}

/**
 * 等 `DevToolsActivePort`（复用收尾闸那份解析，不写第二份）。
 *
 * 超时抛错并**如实报出秒数**；起不来时的兜底由调用方决定（各脚本的现状不同：
 * `measure-render` 在失败路径上再关一次，`smoke-build` / `offline-artifact-probe` 靠外层 `finally`）。
 */
export async function waitForDevToolsPort(profileDir, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = readDevToolsEndpoint(profileDir);
    if (endpoint !== null) return endpoint.port;
    await sleep(intervalMs);
  }
  throw new Error(`Chrome 未在 ${String(timeoutMs / 1000)} 秒内写出 DevToolsActivePort`);
}

/**
 * 极简 CDP 客户端（内置 `WebSocket`；一次一个页目标）。
 *
 * `preferFileUrl`：`file://` 下页面目标可能是 `file:` 而不是 `about:blank`，`smoke-build --file`
 * 需要优先挑它（否则会在别的目标上量数）；其余脚本取第一个 page 目标（= 现状）。
 *
 * 返回值：`call` / `on` / `evaluate` / `navigate` / `close`。
 * - `evaluate` 在页面抛异常时**抛错**（现状只有 `measure-render` 用它；其余脚本保留各自的
 *   `read` / `readEvaluate` 薄包装，因而失败语义不变）；
 * - `navigate` 等 `Page.loadEventFired`，**前置条件是调用方已 `Page.enable`**（现状即如此）。
 */
export async function connectCdp(port, { preferFileUrl = false, timeoutMs = 15_000 } = {}) {
  let target = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && target === '') {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
    const targets = await response.json();
    const preferred = preferFileUrl
      ? targets.find((item) => item.type === 'page' && item.url.startsWith('file:'))
      : undefined;
    const page = preferred ?? targets.find((item) => item.type === 'page');
    if (page !== undefined) target = page.webSocketDebuggerUrl;
    else await sleep(150);
  }
  if (target === '') throw new Error('未找到可用的 page 目标');

  const socket = new WebSocket(target);
  await new Promise((settle, reject) => {
    socket.addEventListener('open', () => settle(), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: resolvePromise, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) reject(new Error(`${message.error.message ?? 'CDP 错误'}`));
      else resolvePromise(message.result);
      return;
    }
    const handlers = listeners.get(message.method) ?? [];
    for (const handler of handlers) handler(message.params);
  });

  const call = (method, params = {}) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolvePromise, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const on = (method, handler) => {
    const handlers = listeners.get(method) ?? [];
    handlers.push(handler);
    listeners.set(method, handlers);
  };

  /** `Runtime.evaluate`：`awaitPromise` 求值一个表达式并返回其值。 */
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails;
      const description =
        details.exception?.description ?? details.exception?.value ?? details.text ?? JSON.stringify(details);
      throw new Error(`页面内异常：${String(description)}`);
    }
    return result.result?.value;
  };

  /** 导航并等 `Page.loadEventFired`（调用方需先 `Page.enable`）。 */
  const navigate = async (url) => {
    const loaded = new Promise((settle) => on('Page.loadEventFired', () => settle()));
    await call('Page.navigate', { url });
    await Promise.race([loaded, new Promise((settle) => setTimeout(settle, 30_000))]);
  };

  return {
    call,
    evaluate,
    navigate,
    on,
    close: () => socket.close(),
  };
}

/**
 * 静态服务器（只绑 127.0.0.1、临时端口、只伺服 `root` 之内的路径）。
 *
 * 404 分支取**较严的那一份**（原 `smoke-build.mjs`）：路径越界 **或** 不存在 **或** 是目录。
 * 返回值同时给 `origin`（原 `measure-render.mjs` 用）与 `port`（原 `smoke-build.mjs` 用）。
 */
export async function startStaticServer(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = normalize(join(root, relative));
    if (!filePath.startsWith(normalize(root)) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME.get(extname(filePath)) ?? 'application/octet-stream' });
    response.end(readFileSync(filePath));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolvePromise({ server, origin: `http://127.0.0.1:${String(port)}`, port });
    });
  });
}

/**
 * 收尾一个由本模块拉起的无头 Chrome：三件事合成一次调用。
 *
 * 1. 走 `chrome-harness.mjs` 的闸（协议级 `Browser.close` 优先，超时才按 PID 树）；
 * 2. `removeProfile` 时删掉临时 profile 目录（等 500 ms 让 Chrome 放开它；删不掉就算了，它已 gitignore）；
 * 3. 没有 profile 目录可指（启动前就失败了）⇒ 直接返回"无需收尾"，不去触发闸的拒绝分支。
 */
export async function closeChromeSession({ profileDir, pid, removeProfile = false, timeoutMs = 10_000 }) {
  if (typeof profileDir !== 'string' || profileDir === '') {
    return { closedBy: 'none', note: '', killed: false };
  }
  const outcome = await closeOwnChrome({ profileDir, pid, lookup: psCommandLine, timeoutMs });
  if (removeProfile) {
    // 等 Chrome 放开配置目录再删（Windows 上占用中的目录删不掉，删不掉就算了——它已 gitignore）。
    await sleep(500);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 忽略：留给下次运行覆盖
    }
  }
  return outcome;
}
