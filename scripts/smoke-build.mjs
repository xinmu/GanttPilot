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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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

/**
 * **首屏主 chunk 不得含 pptxgenjs**（G7，ADR 0010 §1）。
 *
 * 这与 `exceljs` 是同一条纪律（ADR 0006 §11）：导出库只准由用户动作触发时 `import()`。
 * 判据有判别力：`pptxgenjs` 的 min 产物 **271 KB**，一旦被打进主 chunk，
 * 首屏预算（G4 的 3–15 ms / G8 的分包）立刻被它吃掉——而"界面看起来正常"完全掩盖这件事。
 *
 * 同时断言"某个 chunk 里**确实**有它"：否则"主 chunk 干净"可能只是因为导出功能压根没被打进去。
 */
function checkExportChunking() {
  const problems = [];
  const assetsDir = join(distRoot, 'assets');
  const html = readFileSync(join(distRoot, 'index.html'), 'utf8');
  const entryMatch = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html);
  if (entryMatch?.[1] === undefined) {
    problems.push('index.html 里找不到 module 入口脚本');
    return problems;
  }
  const entryPath = join(distRoot, entryMatch[1].replace(/^\.?\//, ''));
  if (!existsSync(entryPath)) {
    problems.push(`index.html 引用的入口不存在：${entryMatch[1]}`);
    return problems;
  }
  const entry = readFileSync(entryPath, 'utf8');
  if (/pptxgen/i.test(entry)) {
    problems.push(`首屏主 chunk 含 pptxgenjs（${entryMatch[1]}）——导出库必须动态 import()`);
  }
  if (!existsSync(assetsDir)) {
    problems.push('找不到 dist/assets（无法确认导出库被打进某个 chunk）');
    return problems;
  }
  const chunks = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
  const withPptx = chunks.filter((name) => /pptxgen/i.test(readFileSync(join(assetsDir, name), 'utf8')));
  if (withPptx.length === 0) {
    problems.push('没有任何 chunk 含 pptxgenjs —— PPTX 导出在产物里不可用');
  }
  return problems;
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
      /**
       * **必须给窗口尺寸**（P-44 落地时发现）：不给时 Chrome 用默认 ~800×600，而左表列本身就占 ~785 px
       * ⇒ 图表列被挤到 **0 px 宽**，于是"布局稳态 / 窗格客户区"这类判据在**退化布局**上量数（量不到东西）、
       * 导出检查也失去意义。固定 1600×900 让两栏都有真实宽度。
       */
      '--window-size=1600,900',
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
      '  exportUi: Boolean(document.querySelector("[data-export]")),',
      '  exportRun: Boolean(document.querySelector("[data-export-run]")),',
      '  status: (document.querySelector(".status") || {}).textContent || null,',
      '  persist: (document.querySelector(".status .persist") || {}).textContent || null,',
      '  error: window.__GANTTPILOT_ERROR__ ?? null,',
      '})',
    ].join(''),
    returnByValue: true,
  });
  return { probe: JSON.parse(result.result.value), errors };
}

/**
 * **布局稳态判据**（P-43，**进 `pnpm gate`**）：状态栏的高度必须与它的文案长度**无关**。
 *
 * 背景（人工复核报文）："刷新页面会发生短暂的画面抖动，点击『重置演示数据』会发生持续抖动，
 * 再次点击恢复。" 根因是自激环——状态栏文案含**视图派生的数字**（可见行/渲染行/渲染边/元素），
 * 而它原先 `flex-wrap: wrap`：文案跨过换行临界值 ⇒ footer 变高 ⇒ 窗格变矮 ⇒ 视图重新裁剪 ⇒
 * **文案里的数字又变** ⇒ 再决定换行……两态互为因果。
 *
 * 判据：连续 `frames` 帧内，**根元素不出现纵向滚动条**且 `(根高, 根滚动高, footer 高,
 * 窗格 clientWidth/clientHeight/scrollHeight)` 的**组合只有一种取值**。任一帧不同即抖动。
 */
async function probeLayoutStability(cdp, label, frames = 60) {
  const problems = [];
  const result = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const pane = document.getElementById('chart-pane');
      const footer = document.querySelector('.status');
      const root = document.documentElement;
      const samples = [];
      for (let index = 0; index < ${String(frames)}; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        samples.push([
          root.clientHeight,
          root.scrollHeight,
          footer === null ? -1 : footer.offsetHeight,
          pane === null ? -1 : pane.clientWidth,
          pane === null ? -1 : pane.clientHeight,
          pane === null ? -1 : pane.scrollHeight,
        ].join('|'));
      }
      const distinct = [...new Set(samples)];
      return JSON.stringify({
        frames: samples.length,
        distinct,
        first: distinct[0] ?? null,
        last: distinct[distinct.length - 1] ?? null,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const snapshot = JSON.parse(result.result.value);
  if (snapshot.distinct.length !== 1) {
    problems.push(
      `[布局稳态·${label}] ${String(snapshot.frames)} 帧内不收敛（自激环）：出现 ${String(snapshot.distinct.length)} 种状态，首/末 = ${String(snapshot.first)} / ${String(snapshot.last)}`,
    );
  }
  const [rootClient, rootScroll] = String(snapshot.first ?? '').split('|');
  if (Number(rootScroll) > Number(rootClient)) {
    problems.push(
      `[布局稳态·${label}] 根元素出现纵向滚动条（scrollHeight ${String(rootScroll)} > clientHeight ${String(rootClient)}）`,
    );
  }

  /**
   * **机制判据**（比"等 60 帧看它抖不抖"更硬）：**状态栏的高度必须与文案长度无关**。
   *
   * 为什么要这一条：自激环的**驱动项**就是"文案长度 → footer 高度"。只靠"等帧观察"会受环境摆布
   * ——headless 的宽度下状态栏没到换行临界值，旧口径（`flex-wrap: wrap`）也能 60 帧不动
   * （本判据的负向对照因此**测不出来**）。这里改为**直接把文案变长**：往 footer 末尾塞 200 个字，
   * 重新量高度。`nowrap` 下高度**必须一字不变**；`wrap` 下必然多出一行 ⇒ 判据必然变红。
   */
  const textProbe = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const footer = document.querySelector('.status');
      if (footer === null) return JSON.stringify({ reason: 'no-footer' });
      // **改现有 span 的文本**（不能新建 span：scoped style 会给页面的 span 加 data-v-* 属性，
      // 新建的那个不带属性、绕过了页面 CSS，量到的就不是真实机制——负向对照当场抓到了这一点）。
      const first = footer.querySelector('span');
      if (first === null) return JSON.stringify({ reason: 'no-span' });
      const original = first.textContent ?? '';
      const before = footer.offsetHeight;
      first.textContent = original + '测'.repeat(200);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const after = footer.offsetHeight;
      first.textContent = original;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return JSON.stringify({ before, after, restored: footer.offsetHeight === before });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const text = JSON.parse(textProbe.result.value);
  if (text.reason === 'no-footer' || text.reason === 'no-span') {
    problems.push(`[布局稳态·${label}] 找不到状态栏 / 它的第一段（${String(text.reason)}）`);
  } else if (text.after !== text.before) {
    problems.push(
      `[布局稳态·${label}] 状态栏高度**随文案长度变化**（${String(text.before)} → ${String(text.after)} px）：` +
        '这正是 P-43 自激环的驱动项（文案 ⇒ 换行 ⇒ footer 变高 ⇒ 窗格变矮 ⇒ 视图重裁 ⇒ 文案又变）',
    );
  }
  if (text.restored === false) problems.push(`[布局稳态·${label}] 探针未能把状态栏文本还原（测量污染了页面）`);
  /**
   * **单行判据**（这条是本判据的判别力来源）：状态栏必须**只有一行**。
   *
   * 上界按 `getComputedStyle` 现推（字号 × 1.6 + 上下 padding + 上边框），不写死像素；
   * 旧口径（`flex-wrap: wrap`）实测 98 / 133 px（2–3 行）⇒ 必然越界，负向对照因此**可判定地变红**。
   */
  const line = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const footer = document.querySelector('.status');
      if (footer === null) return JSON.stringify({ reason: 'no-footer' });
      const cs = getComputedStyle(footer);
      const bound = Number.parseFloat(cs.fontSize) * 1.6 + Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) + 1;
      return JSON.stringify({ height: footer.offsetHeight, bound: Math.ceil(bound) });
    })()`,
    returnByValue: true,
  });
  const single = JSON.parse(line.result.value);
  if (single.reason === 'no-footer') {
    problems.push(`[布局稳态·${label}] 找不到状态栏（.status）`);
  } else if (single.height > single.bound) {
    problems.push(
      `[布局稳态·${label}] 状态栏不是单行：高 ${String(single.height)} px > 单行上界 ${String(single.bound)} px（P-43 的自激环就是靠"换行 ⇒ 变高"驱动的）`,
    );
  }
  /**
   * **窗格客户区必须与"滚动条是否被需要"无关**（P-44，本判据里**确定性可验证**的那一条）。
   *
   * 机制：`pane.clientWidth/clientHeight` 是 `contentWidth`（`max(窗格宽, 内容最右缘…)`，ADR 0007 §15.1）
   * 与滚动范围的**输入**，而"滚动条要不要出现"又由**输出**决定 ⇒ `overflow: auto` 下是自引用环。
   *
   * 判据：**把内容缩到不需要滚动**（spacer → 10×10）再量，客户区必须**一字不变**。
   * （第一版判据写错了：它把 `overflow` 换成 `hidden`，那等于**移除**滚动条 ⇒ 客户区当然会变——
   *  负向对照当场把我自己的错判据抓了出来。）**负向对照**：`auto` 下缩内容后滚动条消失 ⇒ 客户区必变 ⇒ 判据有判别力。
   */
  const boxProbe = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const pane = document.getElementById('chart-pane');
      if (pane === null) return JSON.stringify({ reason: 'no-pane' });
      const spacer = pane.querySelector('.chart-spacer');
      if (spacer === null) return JSON.stringify({ reason: 'no-spacer' });
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const read = () => [pane.clientWidth, pane.clientHeight].join('x');
      const withContent = read();
      const originalWidth = spacer.style.width;
      const originalHeight = spacer.style.height;
      spacer.style.width = '10px';
      spacer.style.height = '10px';
      await frame();
      await frame();
      const withoutContent = read();
      spacer.style.width = originalWidth;
      spacer.style.height = originalHeight;
      await frame();
      await frame();
      return JSON.stringify({ withContent, withoutContent, restored: read() === withContent });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const box = JSON.parse(boxProbe.result.value);
  if (box.reason !== undefined) {
    problems.push(`[布局稳态·${label}] 找不到图表窗格 / 它的 spacer（${String(box.reason)}）`);
  } else if (box.withContent !== box.withoutContent) {
    problems.push(
      `[布局稳态·${label}] 窗格客户区**随"滚动条是否被需要"而变**（${String(box.withContent)} → ${String(box.withoutContent)}）：` +
        '这是 P-44 的自引用环（`contentWidth = max(窗格宽, …)` 的输入就是 `clientWidth`）；窗格应常驻滚动条（`overflow: scroll`）',
    );
  }
  if (box.restored === false) problems.push(`[布局稳态·${label}] 探针未能还原 spacer 尺寸（测量污染了页面）`);
  return problems;
}

/**
 * **真的点一次导出**（G7 端到端）：SVG / PNG / PPTX 三条路径各点一次，检查落盘文件。
 *
 * 为什么必须有这一条：几何与 OOXML 的判据都在 Node 侧（`render-core` / `pptx-renderer` 的 spec），
 * 但"浏览器里点下去到底能不能出文件"是**另一件事**——PNG 要走 `Image`+`canvas` 光栅化，
 * PPTX 要在浏览器里动态加载 `pptxgenjs`（Vite 的 `browser` 字段会把 `https`/`image-size` 替空）。
 * 这两条路径在 Node 测试里结构上覆盖不到（P-9/P-17 的分层口径）。
 */
async function exerciseExports(cdp) {
  const problems = [];
  const dir = join(repoRoot, 'tmp', 'smoke-downloads', String(Date.now()));
  mkdirSync(dir, { recursive: true });
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

  const setAndRun = async (format, scale) => {
    // 直接驱动真实控件（与用户操作同一条路：改 select → 触发 change → 点导出按钮）
    await cdp.call('Runtime.evaluate', {
      expression: [
        `(() => {`,
        `  const select = document.querySelector('[data-export-format]');`,
        `  if (!select) return 'no-select';`,
        `  select.value = ${JSON.stringify(format)};`,
        `  select.dispatchEvent(new Event('change', { bubbles: true }));`,
        `  ${
          format === 'png'
            ? `const scale = document.querySelector('[data-export-scale]'); if (scale) { scale.value = ${JSON.stringify(String(scale ?? 1))}; scale.dispatchEvent(new Event('change', { bubbles: true })); }`
            : ''
        }`,
        `  return 'ok';`,
        `})()`,
      ].join('\n'),
      returnByValue: true,
    });
    await new Promise((settle) => setTimeout(settle, 400));
    await cdp.call('Runtime.evaluate', {
      expression: `(() => { const btn = document.querySelector('[data-export-run]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()`,
      returnByValue: true,
    });
    await new Promise((settle) => setTimeout(settle, 3_500));
  };

  const files = () => (existsSync(dir) ? readdirSync(dir) : []);
  /** 页面上的提示条：导出失败的原因就在那里（`notice` 是产品自己的失败通道）。 */
  const noticeText = async () => {
    const result = await cdp.call('Runtime.evaluate', {
      expression: `(() => { const node = document.querySelector('.status .notice'); return node ? node.textContent : ''; })()`,
      returnByValue: true,
    });
    return String(result.result.value ?? '');
  };
  const waitFor = async (extension, attempts = 8) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const hit = files().find((name) => name.toLowerCase().endsWith(extension));
      if (hit !== undefined) return hit;
      await new Promise((settle) => setTimeout(settle, 1_000));
    }
    return null;
  };

  // ① SVG
  await setAndRun('svg', 1);
  const svg = await waitFor('.svg');
  if (svg === null) {
    problems.push(`导出 SVG：没有落盘文件（页面提示：${await noticeText()}）`);
  } else {
    const text = readFileSync(join(dir, svg), 'utf8');
    if (!text.includes('<svg')) problems.push('导出 SVG：内容里没有 <svg>');
    if (text.length < 2_000) problems.push(`导出 SVG：内容过小（${String(text.length)} 字符）`);
    if (/handle|connect-point|transparent/.test(text)) problems.push('导出 SVG：含交互图元（手柄/连接点/热区）');
  }

  // ② PNG（1× 就够：验的是"光栅化这条路通"）
  await setAndRun('png', 1);
  const png = await waitFor('.png');
  if (png === null) {
    problems.push(`导出 PNG：没有落盘文件（光栅化失败？页面提示：${await noticeText()}）`);
  } else {
    const buffer = readFileSync(join(dir, png));
    const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    if (!isPng) problems.push('导出 PNG：文件不是 PNG（magic 不符）');
    if (buffer.length < 1_000) problems.push(`导出 PNG：文件过小（${String(buffer.length)} 字节）`);
  }

  // ③ PPTX（浏览器里动态加载 pptxgenjs + 打补丁）
  await setAndRun('pptx', 1);
  const pptx = await waitFor('.pptx');
  if (pptx === null) {
    problems.push(`导出 PPTX：没有落盘文件（浏览器侧 pptxgenjs 路径失败？页面提示：${await noticeText()}）`);
  } else {
    const buffer = readFileSync(join(dir, pptx));
    if (!(buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      problems.push('导出 PPTX：文件不是 zip（magic 不符）');
    }
    if (buffer.length < 5_000) problems.push(`导出 PPTX：文件过小（${String(buffer.length)} 字节）`);
  }

  return { problems, dir };
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
  /**
   * P-43 的**布局稳态**：首屏一次、**点一次"重置演示数据"之后再一次**
   * （人工复核报的是"重置后持续抖动"，那是最容易复现的一段）。
   */
  const layoutProblems = [];
  layoutProblems.push(...(await probeLayoutStability(cdp, '首屏')));
  /**
   * ⚠️ **临时诊断（P-43 抖动追查，跑完即删）**：扫视口尺寸找复现点。
   *
   * 报文的线索是"与**横向**滚动条是否出现有关" ⇒ 反馈环走"滚动条 ↔ 窗格客户区尺寸"
   * （横向条占 clientHeight、纵向条占 clientWidth），而它只在**特定视口**才跨过临界值。
   * 这里把若干尺寸逐个套上去，每个采 24 帧，只**打印**不判定。
   */
  if (process.env.SMOKE_LAYOUT_SWEEP === '1') {
    const sizes = [];
    for (const width of [1024, 1088, 1152, 1216, 1280, 1344, 1408, 1472]) sizes.push({ width, height: 800 });
    for (const height of [620, 680, 740, 860, 920]) sizes.push({ width: 1280, height });
    for (const size of sizes) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
      await new Promise((settle) => setTimeout(settle, 400));
      const jitter = await cdp.call('Runtime.evaluate', {
        expression: `(async () => {
          const pane = document.getElementById('chart-pane');
          const table = document.querySelector('.table-body');
          const samples = [];
          for (let index = 0; index < 24; index += 1) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            samples.push([
              pane === null ? -1 : pane.clientWidth,
              pane === null ? -1 : pane.clientHeight,
              pane === null ? -1 : pane.scrollWidth,
              pane === null ? -1 : pane.scrollHeight,
              table === null ? -1 : table.clientWidth,
              table === null ? -1 : table.scrollWidth,
              table === null ? -1 : table.scrollHeight,
            ].join('|'));
          }
          const distinct = [...new Set(samples)];
          return JSON.stringify({ distinct, first: distinct[0] ?? null, last: distinct[distinct.length - 1] ?? null });
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const snapshot = JSON.parse(jitter.result.value);
      console.log(
        `[布局扫描] ${String(size.width)}×${String(size.height)}：状态 ${String(snapshot.distinct.length)} 种` +
          (snapshot.distinct.length === 1 ? '' : ` ⇒ 首 ${String(snapshot.first)} / 末 ${String(snapshot.last)}`),
      );
    }
    await cdp.call('Emulation.clearDeviceMetricsOverride');
    await new Promise((settle) => setTimeout(settle, 400));
  }
  const resetClick = await cdp.call('Runtime.evaluate', {
    expression:
      "(() => { const btn = document.querySelector('[data-reset]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()",
    returnByValue: true,
  });
  if (resetClick.result.value !== 'clicked') {
    layoutProblems.push(`找不到「重置演示数据」按钮（selector [data-reset]）：${String(resetClick.result.value)}`);
  } else {
    await new Promise((settle) => setTimeout(settle, 500));
    layoutProblems.push(...(await probeLayoutStability(cdp, '重置后')));
  }
  const exports = await exerciseExports(cdp);
  cdp.close();

  const problems = [];
  problems.push(...layoutProblems);
  // G7：导出库的分包纪律（首屏主 chunk 不得含 pptxgenjs；且某个 chunk 里必须真有它）
  problems.push(...checkExportChunking());
  // G7：三条导出路径端到端（真的点、真的落盘）
  problems.push(...exports.problems);
  if (probe.error !== null) problems.push(`应用级错误：${String(probe.error)}`);
  if (errors.length > 0) problems.push(`控制台/异常：${errors.slice(0, 3).join(' | ')}`);
  if (errors.length > 0) problems.push(`控制台/异常：${errors.slice(0, 3).join(' | ')}`);
  if (probe.title !== 'GanttPilot') problems.push(`标题不符：${String(probe.title)}`);
  if (probe.brand === null) problems.push('工具栏未渲染（找不到 .brand）');
  if (!probe.pane) problems.push('图表窗格未渲染（找不到 #chart-pane）');
  if (!probe.svg) problems.push('SVG 未渲染（找不到 .gantt-svg）');
  if (!probe.exportUi) problems.push('导出面板未渲染（找不到 [data-export]）');
  if (!probe.exportRun) problems.push('导出按钮未渲染（找不到 [data-export-run]）');
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
    console.log(`  持久化：${String(probe.persist)}`);
    console.log(`  导出端到端：SVG / PNG / PPTX 三条路径均已落盘（目录 ${exports.dir}）`);
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
