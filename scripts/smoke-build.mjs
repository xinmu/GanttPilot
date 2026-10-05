#!/usr/bin/env node
/**
 * **打包产物冒烟**（G6 起进 `pnpm gate`）。
 *
 * ## 为什么需要它
 *
 * 维护者的报文：「`pnpm build` 后打开 `apps/web/dist/index.html` 页面空白」——根因是
 * **ES module 在 `file://` 下会被浏览器拒绝**（CORS），不是产物坏了。但这件事暴露了一个真缺口：
 * 在此之前，**没有任何门禁碰过 `dist/`**。全部 700+ 条判据都在包源码上（Node），
 * 记录制测量又只跑「已就绪」之后的路径；于是"打包产物能不能起来"完全靠人记得看一眼。
 *
 * 本脚本补上那一环：**用 HTTP 伺服 `dist/`，无头 Chrome 打开，断言"没有应用级错误、界面真的渲染了"**。
 *
 * ## 与记录制测量的分工
 *
 * | 层 | 手段 | 进 `pnpm gate`？ |
 * |---|---|---|
 * | **产物能起来** | 本脚本（零新增依赖：`node:http` + 内置 `WebSocket` 走 CDP） | **进** |
 * | 性能数字（首屏/滚动/拖拽/持久化） | `scripts/measure-render.mjs`（本机 Chrome，快照会随版本变） | **不进**（记录制，P-9/P-17） |
 *
 * 缺 Chrome 时**失败而不是跳过**（P-12 口径：判据要么真跑，要么别写）。
 *
 * 用法：
 *   node scripts/smoke-build.mjs
 *   GANTTPILOT_CHROME=<path> node scripts/smoke-build.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOwnProfile, closeOwnChrome, profileDirFor, psCommandLine } from './chrome-harness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(repoRoot, 'apps', 'web', 'dist');
/**
 * 本轮用的配置目录（跑完删掉：`tmp/` 虽已 gitignore，但"只增不减"是运行卫生问题）。
 * 形状由 `chrome-harness.mjs` 的白名单定死，收尾**只认这个目录**（见那里的三条闸）。
 */
let currentProfileDir = null;

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

/** 打包产物是否就绪（缺 `index.html` 即"还没构建"，那是用法错误，直接说清）。 */
if (!existsSync(join(distRoot, 'index.html'))) {
  console.error('[smoke] 找不到打包产物：apps/web/dist/index.html —— 先跑 `pnpm build`。');
  process.exit(1);
}

/** 静态服务器（只绑 127.0.0.1、临时端口、白名单范围内的路径）。 */
function startStaticServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = normalize(join(distRoot, relative));
    if (!filePath.startsWith(normalize(distRoot)) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME.get(extname(filePath)) ?? 'application/octet-stream',
    });
    response.end(readFileSync(filePath));
  });
  return new Promise((settle) => {
    server.listen(0, '127.0.0.1', () => {
      settle({ server, port: server.address().port });
    });
  });
}

/** 找一个可用的 Chrome（与 `measure-render.mjs` 同口径：优先环境变量，其次常见安装位置）。 */
function findChrome() {
  const candidates = [
    process.env.GANTTPILOT_CHROME,
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter((item) => typeof item === 'string' && item !== '');
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome；用 GANTTPILOT_CHROME=<path> 指定（缺 Chrome 即失败，不跳过）。');
}

/** 启动无头 Chrome 并等 DevTools 端口落盘。 */
function launchChrome(executable) {
  const profileDir = assertOwnProfile(profileDirFor('smoke-profile'));
  currentProfileDir = profileDir;
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  return { child, profileDir };
}

/** 等 DevToolsActivePort（与 `measure-render.mjs` 同一手法）。 */
async function readDevToolsPort(profileDir) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').split('\n');
      const value = Number(port);
      if (Number.isInteger(value) && value > 0) return value;
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
  throw new Error('Chrome 未在 10 秒内写出 DevToolsActivePort');
}

/** 极简 CDP 客户端（零新增依赖：内置 `fetch` + 内置 `WebSocket`）。 */
async function connect(port) {
  let target = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && target === '') {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
    const targets = await response.json();
    const page = targets.find((item) => item.type === 'page');
    if (page !== undefined) target = page.webSocketDebuggerUrl;
    else await new Promise((settle) => setTimeout(settle, 150));
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
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) reject(new Error(String(message.error.message ?? 'CDP 错误')));
      else ok(message.result);
      return;
    }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params);
  });
  const call = (method, params = {}) =>
    new Promise((ok, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, handler) => {
    const handlers = listeners.get(method) ?? [];
    handlers.push(handler);
    listeners.set(method, handlers);
  };
  return {
    call,
    on,
    close: () => socket.close(),
  };
}

/** 跑冒烟：导航 → 等界面 → 读断言。 */
async function smoke(cdp, url) {
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    errors.push(String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? '异常'));
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params?.entry ?? {};
    const url = String(entry.url ?? '');
    const text = String(entry.text ?? '');
    // 浏览器默认会请求 `/favicon.ico`，本项目没有这个文件 ⇒ 那条 404 是噪声。
    if (entry.level === 'error' && !text.includes('favicon') && !url.includes('favicon')) {
      errors.push(url === '' ? text : `${text} @ ${url}`);
    }
  });
  await cdp.call('Log.enable');
  await cdp.call('Page.navigate', { url });
  await new Promise((settle) => setTimeout(settle, 6_000));
  const result = await cdp.call('Runtime.evaluate', {
    expression: [
      'JSON.stringify({',
      '  title: document.title,',
      '  brand: (document.querySelector(".brand") || {}).textContent || null,',
      '  pane: Boolean(document.getElementById("chart-pane")),',
      '  svg: Boolean(document.querySelector(".gantt-svg")),',
      '  status: (document.querySelector(".status") || {}).textContent || null,',
      '  persist: (document.querySelector(".status .persist") || {}).textContent || null,',
      '  error: window.__GANTTPILOT_ERROR__ ?? null,',
      '})',
    ].join(''),
    returnByValue: true,
  });
  return { probe: JSON.parse(result.result.value), errors };
}

let serverHandle = null;
let chromeHandle = null;
try {
  serverHandle = await startStaticServer();
  const url = `http://127.0.0.1:${String(serverHandle.port)}/`;
  const executable = findChrome();
  chromeHandle = launchChrome(executable);
  const port = await readDevToolsPort(chromeHandle.profileDir);
  const cdp = await connect(port);
  const { probe, errors } = await smoke(cdp, url);
  cdp.close();

  const problems = [];
  if (probe.error !== null) problems.push(`应用级错误：${String(probe.error)}`);
  if (errors.length > 0) problems.push(`控制台/异常：${errors.slice(0, 3).join(' | ')}`);
  if (probe.title !== 'GanttPilot') problems.push(`标题不符：${String(probe.title)}`);
  if (probe.brand === null) problems.push('工具栏未渲染（找不到 .brand）');
  if (!probe.pane) problems.push('图表窗格未渲染（找不到 #chart-pane）');
  if (!probe.svg) problems.push('SVG 未渲染（找不到 .gantt-svg）');
  if (typeof probe.persist !== 'string' || !probe.persist.startsWith('持久化：')) {
    problems.push(`状态栏缺少持久化那一栏：${String(probe.persist)}`);
  }
  // 演示口径（裁决 P-34）：默认文档必须是**小型演示计划**，而不是 1,000 任务夹具——
  // 这是唯一能抓到"产物仍然开在大夹具上"的门禁。上界编码的是"单页 16:9 可读"这个口径本身，
  // 具体数字（15 行 / 14 条依赖）的唯一权威陈述在 `render-core/src/demoPlan.spec.ts`。
  const counts = /任务 (\d+) · 依赖 (\d+)/.exec(probe.status ?? '');
  if (counts === null) {
    problems.push(`状态栏缺少任务/依赖计数：${String(probe.status)}`);
  } else {
    const tasks = Number(counts[1]);
    const links = Number(counts[2]);
    if (tasks < 8 || tasks > 40) {
      problems.push(`演示口径不是小型计划：任务 ${String(tasks)} 条（期望 8–40）`);
    }
    if (links < 1) {
      problems.push(`演示计划没有依赖：${String(links)} 条`);
    }
  }

  if (problems.length > 0) {
    console.error(`[smoke] 打包产物冒烟未通过（${url}）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`[smoke] 通过：${url}`);
    console.log(`  ${String(probe.persist)}`);
    console.log(`  演示口径：${counts?.[0] ?? '（未解析）'}`);
  }
} catch (error) {
  console.error(`[smoke] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // 收尾走 `chrome-harness.mjs` 的三条闸：正常路径是协议级 `Browser.close`（不杀进程），
  // 只有它超时才按**我们自己的 PID 树**兜底——绝不按名字匹配 chrome.exe。
  const outcome = await closeOwnChrome({
    profileDir: currentProfileDir,
    pid: chromeHandle?.child.pid,
    lookup: psCommandLine,
  });
  if (outcome.closedBy === 'pid-tree') console.log('[smoke] 协议级关闭未生效，已按 PID 树兜底');
  if (outcome.note !== '') console.log(`[smoke] 收尾说明：${outcome.note}`);
  serverHandle?.server.close();
  // 等 Chrome 放开配置目录再删（Windows 上占用中的目录删不掉，删不掉就算了——它已 gitignore）。
  if (currentProfileDir !== null) {
    await new Promise((settle) => setTimeout(settle, 500));
    try {
      rmSync(currentProfileDir, { recursive: true, force: true });
    } catch {
      // 忽略：留给下次运行覆盖
    }
  }
}
