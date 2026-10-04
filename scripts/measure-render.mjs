#!/usr/bin/env node
/**
 * G4 的**打包产物测量**（记录制，**不进 `pnpm gate`**；ADR 0007 §9 第 ⑤ 层 / 裁决 P-17）。
 *
 * ## 为什么它是一个独立脚本而不是门禁步骤
 *
 * ① 它需要**本机 Chrome**（门禁必须在任何机器上可跑）；② 它是"测量快照"，换 Chrome 大版本
 * 数值必变（证据按大版本分文件）；③ **真正需要门禁的判据（几何期望值表、裁剪结构断言、
 * 不变量、负向对照）已全部落在 Node 侧的 spec 里**。缺 Chrome 时**失败而不是跳过**（P-12 口径）。
 *
 * ## 零新增依赖
 *
 * 用 Node 内置 `fetch` + 内置 `WebSocket` 通过 **CDP** 驱动本机 Chrome，静态资源用 `node:http`。
 * 不引入 Playwright / Puppeteer / jsdom（ADR 0007 §9 的"优先零新增依赖"由此落地）。
 *
 * ## 它测什么（每一项都对应一条出口条件）
 *
 * - **首屏**：`文档与 Schedule 就绪 → 含依赖线的首帧完成`，对 1,000 任务 ≤ 1,000 ms；
 * - **10× 滚动**：总墙钟、主线程 p50/p95、连续 rAF 帧间隔、longtask、空白行
 *   ——与《评估报告》§5.4 的"2,200 边 / 约 2.0 s"**同尺**对照；
 * - **元素预算**：渲染行/边与元素总数、`c₃`、是否在 `c₁·rows + c₂·edges + c₃` 之内。
 *
 * 用法：
 *   node scripts/measure-render.mjs                  # 主口径（dense·日档）+ 2,200 边对照
 *   node scripts/measure-render.mjs --zoom=week      # 只测某档位
 *   GANTTPILOT_CHROME=<path> node scripts/measure-render.mjs
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(repoRoot, 'apps', 'web', 'dist');
const evidenceDir = join(repoRoot, 'apps', 'web', 'evidence');
const chromeProfileRoot = join(repoRoot, 'tmp', 'measure-chrome-profile');

const ZOOM_KEYS = ['day', 'week', 'month'];
const PRIMARY_DATASET = 'dense';
const REFERENCE_DATASET = 'dense2200';

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    zooms: [...ZOOM_KEYS],
    rounds: 5,
    scrollSteps: 10,
    includeReference: true,
    /** G5：只跑拖动测量（记录制），并写 `drag-timing-chrome<大版本>.md`。 */
    drag: false,
    /** G5：拖动跨越的工作日数（US-2 的口径是 3 天）。 */
    dayDelta: 3,
    /** G5：拖动期的测试帧数。 */
    dragFrames: 12,
    /**
     * 记录制：把一份 xlsx 交给**真实导入入口**并读回应用的反应
     * （`--import=<path>`；裁决 P-21 遗留 3 / P-22 的收口动作）。
     */
    importPath: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--zoom=')) {
      const value = arg.slice('--zoom='.length);
      options.zooms = value === 'all' ? [...ZOOM_KEYS] : [value].filter((key) => ZOOM_KEYS.includes(key));
    } else if (arg.startsWith('--rounds=')) {
      options.rounds = Number(arg.slice('--rounds='.length)) || options.rounds;
    } else if (arg.startsWith('--steps=')) {
      options.scrollSteps = Number(arg.slice('--steps='.length)) || options.scrollSteps;
    } else if (arg === '--no-reference') {
      options.includeReference = false;
    } else if (arg === '--drag') {
      options.drag = true;
    } else if (arg.startsWith('--day-delta=')) {
      options.dayDelta = Number(arg.slice('--day-delta='.length)) || options.dayDelta;
    } else if (arg.startsWith('--drag-frames=')) {
      options.dragFrames = Number(arg.slice('--drag-frames='.length)) || options.dragFrames;
    } else if (arg.startsWith('--import=')) {
      options.importPath = arg.slice('--import='.length);
    }
  }
  return options;
}

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

/** 静态服务器（只绑 127.0.0.1、临时端口、白名单范围内的路径）。 */
function startStaticServer(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = normalize(join(root, relative));
    if (!filePath.startsWith(normalize(root)) || !existsSync(filePath)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
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
      resolvePromise({ server, origin: `http://127.0.0.1:${String(port)}` });
    });
  });
}

/** 找 Chrome：显式环境变量优先，其次常见安装位置（找不到就抛错，**不跳过**）。 */
function findChrome() {
  const explicit = process.env.GANTTPILOT_CHROME;
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome：用 GANTTPILOT_CHROME 指定可执行文件（缺失即失败，不跳过）');
}

/** 启动 Chrome 与一个 CDP 会话（`--remote-debugging-port=0` + 读 `DevToolsActivePort`）。 */
async function launchChrome(executable) {
  const profileDir = join(chromeProfileRoot, String(Date.now()));
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--force-device-scale-factor=1',
      '--window-size=1280,640',
      'about:blank',
    ],
    // 受限沙箱下用管道捕获子进程输出会 EPERM：这里显式忽略 stdio。
    { stdio: 'ignore', detached: false },
  );
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  let port = 0;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const text = readFileSync(portFile, 'utf8').split('\n');
      port = Number(text[0]);
      if (port > 0) break;
    }
    await new Promise((settle) => setTimeout(settle, 120));
  }
  if (port === 0) {
    child.kill();
    throw new Error('Chrome 未在 20 秒内写出 DevToolsActivePort');
  }
  return { child, port, profileDir };
}

/** 极简 CDP 客户端（内置 WebSocket；一次一个页目标）。 */
async function connectCdp(port) {
  let targetId = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && targetId === '') {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
    const targets = await response.json();
    const page = targets.find((item) => item.type === 'page');
    if (page !== undefined) targetId = page.webSocketDebuggerUrl;
    else await new Promise((settle) => setTimeout(settle, 150));
  }
  if (targetId === '') throw new Error('未找到可用的 page 目标');

  const socket = new WebSocket(targetId);
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

  const on = (method, handler) => {
    const handlers = listeners.get(method) ?? [];
    handlers.push(handler);
    listeners.set(method, handlers);
  };

  /** 导航并等 `Page.loadEventFired`。 */
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
 * 跑一组测量（一个数据集 × 一个档位，一次导航）。
 *
 * 注意两点：
 * 1. `?table=0` 隐藏左表 —— 元素预算的 `c₃` 只取决于"图表窗格宽 ÷ `pxPerDay`"，
 *    只有**全宽图表**才与 ADR 0007 §11 的回填口径可比（分屏下 `c₃` 必然更小，是布局差异）；
 * 2. `?measure=` 的钩子是**动态 `import()`** 装上去的，`Page.loadEventFired` 之后还没就绪，
 *    因此这里轮询等它出现，而不是假定"加载完就有"。
 */
async function measureOne(cdp, origin, args) {
  const url = `${origin}/?measure=1&table=0&dataset=${encodeURIComponent(args.dataset)}&zoom=${String(args.zoom)}`;
  await cdp.navigate(url);
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await cdp.evaluate(
      'Boolean(window.__GANTTPILOT_READY__) && typeof window.__GANTTPILOT_MEASURE__ === "function"',
    );
    if (ready === true) break;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  if (ready !== true) {
    const captured = await cdp.evaluate('window.__GANTTPILOT_ERROR__ ?? "(空)"');
    throw new Error(`测量钩子未就绪：${String(captured)}`);
  }
  return cdp.evaluate(
    `window.__GANTTPILOT_MEASURE__({ dataset: ${JSON.stringify(args.dataset)}, zoom: ${JSON.stringify(args.zoom)}, rounds: ${String(args.rounds)}, scrollSteps: ${String(args.scrollSteps)} })`,
  );
}

/** @param {number} value */
function ms(value) {
  return `${value.toFixed(1)} ms`;
}

/** @param {number} value */
function ratio(value) {
  return `${value.toFixed(3)}×`;
}

/** 渲染成证据 Markdown（不稳定层：**按 Chrome 大版本分文件**）。 */
function renderEvidence({ env, runs, options }) {
  const lines = [];
  lines.push('# G4 打包产物测量（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `scripts/measure-render.mjs` 采集；**这是测量快照，不是门禁**（[ADR 0007 §9 ⑤](../../../docs/02-adr/0007-渲染几何与裁剪契约.md)、[裁决 P-17](../../../docs/00-baseline/裁决记录.md)）。');
  lines.push('> 换机器、换 Chrome 大版本、headed 或 DPR>1 都必然改变绝对值；引用时必须连口径一起读。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 数据来源 = 合成夹具 + 页面内 `createScheduleCalendar` + `compute`（**不含 xlsx 导入**，`exceljs` 只准动态 `import()`）；');
  lines.push('- **首屏**：`文档与 Schedule 就绪 → 含依赖线的首帧完成`；首帧用**双 rAF**；');
  lines.push('- **10× 滚动**：单帧 rAF 步进，分开记"主线程耗时"（判据）与"连续 rAF 帧间隔"（记录）——');
  lines.push('  **不用双 rAF 测帧时长**（那会把约 33 ms 的等待算进去）；');
  lines.push('- 页面 = `apps/web/dist` 的**打包产物**（不是 G4-S 的无打包器探针页，两者数字不可直接比较）；');
  lines.push('- 首屏的**起点是"文档与 `Schedule` 就绪"**（`compute` 单列在原始 JSON 的 `prepareMs`）；');
  lines.push('- 10× 滚动用**单帧 rAF** 步进；"主线程耗时"只含同步工作量（几何 + 提交 + DOM 更新），');
  lines.push('  **不含帧等待**——双 rAF 的约 33 ms 一旦混进来，1 ms 的工作量会被报成 33 ms（G4-S 踩过）。');
  lines.push('');
  lines.push('## 首屏（`ready → 首帧`）');
  lines.push('');
  lines.push('> 视口与窗格：页面按 `Emulation.setDeviceMetricsOverride` 固定为 **1280×800、DPR 1**；');
  lines.push('> 图表窗格是 `视口 − 工具栏 − 状态栏` 之后的实际尺寸（脚本按真实 `clientWidth/clientHeight` 登记，不是假定值）。');
  lines.push('');
  lines.push('| 数据集 | 档位 | 窗格 h×w | 可见行 | 渲染行 | 渲染边 | 元素 | c₃ | DOM 行/边 | 在预算内 | 首屏（就绪→首帧） | 各轮 p50 / p95 | 几何 p50 | 渲染 p50 | 对 1,000 ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const first = run.result?.firstScreen;
    if (first === undefined || first === null) {
      lines.push(`| ${run.dataset} | ${run.zoom} | — | — | — | — | — | — | — | — | 失败 | — | — | — | — |`);
      continue;
    }
    const viewport = run.result.viewport ?? {};
    const visibleRows = Math.max(1, Math.ceil((viewport.height ?? 0) / (viewport.rowHeight ?? 24)));
    const geometry = first.layers.map((layer) => layer.geometryMs);
    const render = first.layers.map((layer) => layer.renderMs);
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    lines.push(
      `| ${run.dataset} | ${run.zoom} | ${String(viewport.height ?? '?')}×${String(viewport.width ?? '?')} | ${String(visibleRows)} | ${String(first.counts.renderedRows)} | ${String(first.counts.renderedEdges)} | ${String(first.counts.elements)} | ${String(first.counts.c3)} | ${String(first.domCounts?.renderedRows ?? -1)} / ${String(first.domCounts?.renderedEdges ?? -1)} | ${first.counts.withinBudget ? '✅' : '❌'} | ${ms(first.primaryMs)} | ${ms(first.p50Ms)} / ${ms(first.p95Ms)} | ${ms(median(geometry))} | ${ms(median(render))} | ${ratio(1000 / Math.max(first.primaryMs, 0.001))} 余量 |`,
    );
  }
  lines.push('');
  lines.push('> 首屏的**起点是"文档与 `Schedule` 就绪"**（`compute` 的耗时单列在原始 JSON 的 `prepareMs`）；');
  lines.push('> `primaryMs` 是第 1 轮、`p50/p95` 是全部轮次——**双 rAF 的下界就是约 33 ms**，所以轮次间的抖动是调度噪声，不要当回归；');
  lines.push('> "渲染行/边"来自元素模型，"DOM 行/边"是页面上真实存在的 `<g>` 数：');
  lines.push('> 两者必须相等，否则"元素预算"就是恒真式（脚本把不一致直接记进 `errors`）。');
  lines.push('> **`c₃` 与 G4-S 的回填值可比，但不是同一个数**：本轮页面用 `?table=0` 把图表放成全宽');
  lines.push('> （1265 px，比 G4-S 探针页的 1280 px 少一条滚动条宽），因此日/周/月的 `c₃` 是');
  lines.push('> **114 / 69 / 88**，与 ADR 0007 §11 的 **116 / 70 / 89** 差 1–2（就是那点宽度差）；');
  lines.push('> 分屏下（隐藏左表之前）同一页面的 `c₃` 只有 35 / 21 / 26——`c₃` 只取决于"窗格宽 ÷ `pxPerDay`"，');
  lines.push('> 与文档总规模无关，这是 §11.1 ③ 那条口径的直接后果。');
  lines.push('');
  lines.push('## 10× 滚动');
  lines.push('');
  lines.push('| 数据集 | 档位 | 总墙钟 | 主线程合计 | 主线程 p50 / p95 | 帧间隔 p50 / p95 | longtask | 空白行 | 对 §5.4（约 2.0 s） |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const scroll = run.result?.scroll;
    if (scroll === undefined || scroll === null) {
      lines.push(`| ${run.dataset} | ${run.zoom} | 失败 | — | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${run.dataset} | ${run.zoom} | ${ms(scroll.totalWallMs)} | ${ms(scroll.totalWorkMs)} | ${ms(scroll.p50WorkMs)} / ${ms(scroll.p95WorkMs)} | ${ms(scroll.rafP50Ms)} / ${ms(scroll.rafP95Ms)} | ${String(scroll.longTaskCount)} | ${String(scroll.blankRowGaps)} | ${ratio(2000 / Math.max(scroll.totalWallMs, 0.001))} 余量 |`,
    );
  }
  lines.push('');
  lines.push('## 判定');
  lines.push('');
  const firstScreenWorst = Math.max(...runs.map((run) => run.result?.firstScreen?.primaryMs ?? Number.POSITIVE_INFINITY));
  const budgetOk = firstScreenWorst <= 1000;
  const budgetInAll = runs.every((run) => run.result?.firstScreen?.counts?.withinBudget !== false);
  const blankOk = runs.every((run) => (run.result?.scroll?.blankRowGaps ?? 1) === 0);
  const frameOk = runs.every((run) => (run.result?.scroll?.p95WorkMs ?? Number.POSITIVE_INFINITY) <= 16.7);
  lines.push(`- **1,000 任务首屏 ≤ 1 s**：最差 ${ms(firstScreenWorst)} ⇒ ${budgetOk ? '**通过**' : '**不通过（按 ADR 0007 §9 分层定位后再决定降级）**'}；`);
  lines.push(`- **元素预算**：${budgetInAll ? '**全部在 `c₁·rows + c₂·edges + c₃` 之内**' : '**有超预算项**'}；`);
  lines.push(`- **零空白行**：${blankOk ? '**成立**' : '**出现空白行**'}；`);
  lines.push(`- **主线程 p95 ≤ 16.7 ms**（记录制候选）：${frameOk ? '**成立**' : '**超出**'}。`);
  lines.push('');
  lines.push(`> 生成参数：${JSON.stringify(options)}`);
  lines.push('');
  return lines.join('\n');
}

/** G5 拖动证据（记录制）：帧预算 ≥30 fps、松手 ≤200 ms、下游跟随、松手清锚点。 */
function renderDragEvidence({ env, result, options }) {
  const lines = [];
  const mainP95 = Number(result?.mainThreadP95Ms ?? 0);
  const gapP50 = Number(result?.frameGapP50Ms ?? 0);
  const gapP95 = Number(result?.frameGapP95Ms ?? 0);
  const releaseMs = Number(result?.releaseMs ?? 0);
  const followObserved = Number(result?.observedWidthChanges ?? 0) > 0;
  const anchorsCleared = Number(result?.anchorsAfterRelease ?? -1) === 0;
  const fpsOk = gapP95 > 0 && gapP95 <= 1000 / 30;
  const releaseOk = releaseMs > 0 && releaseMs <= 200;
  const wroteDocument = result?.documentStartAfter !== null && result?.documentStartAfter !== undefined;
  const expectedAfter = result?.expectedStartAfter ?? null;
  const movedExactly = wroteDocument && expectedAfter !== null && result?.documentStartAfter === expectedAfter;

  lines.push('# G5 拖动测量（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/measure-render.mjs --drag` 采集；**这是测量快照，不是门禁**');
  lines.push('> （[ADR 0008 §11](../../../docs/02-adr/0008-列身份所有权与拖拽交互契约.md)、[裁决 P-9/P-17](../../../docs/00-baseline/裁决记录.md)）。');
  lines.push('> 拖动的判据本身（手势状态机、候选序号、松手命令、成环拒绝）在 `packages/render-core/src/gesture.spec.ts` 里，**进 `pnpm gate`**。');
  lines.push('> **位移判据**（裁决 [P-22](../../../docs/00-baseline/裁决记录.md) 补上）：松手后的 `startDate` 必须等于');
  lines.push('> 「拖动前该行的开始序号 + 拖动天数」——旧证据只断言"非空"，因此"拖了但没有效位移"也会算通过。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 数据来源 = 合成夹具 + 页面内 `createScheduleCalendar` + `compute`（**不含 xlsx 导入**，`exceljs` 只准动态 `import()`）；');
  lines.push('- 驱动方式 = **真实指针事件**（`mousedown → mousemove×N → mouseup`）走 `useGesture` 的同一条入口，不另开测试后门；');
  lines.push(`- 拖动跨度 = **${String(options.dayDelta)} 个工作日**（US-2 的口径），拆成 **${String(options.dragFrames)}** 个测试帧；`);
  lines.push('- **主线程工作量** = 派发事件 + `await nextTick()`（**不含帧等待**）——与 G4 的滚动口径同源；');
  lines.push('- **帧间隔** = 连续 rAF 的间隔（只作记录；**不能用双 rAF 测帧时长**，那会把等待算进来）；');
  lines.push('- **松手耗时** = `mouseup` → 命令落库 + `compute` + 覆盖层清空 的墙钟；');
  lines.push('- **下游跟随**的间接证据 = 拖动期 DOM 上条形的宽度/位置串发生过变化（不是只有覆盖层在动）；');
  lines.push(`- **位移** = 抓取点取条体**第一个工作日格的中点**，逐帧移到「该格 + offset」个工作日；`);
  lines.push('  因此"拖 N 个工作日"是一个**线性**位移（基准是拖动前的开始序号，不是拖动期视图里跟着动的 `es`）。');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push('| 量 | 值 | 判据 | 判定 |');
  lines.push('|---|---|---|---|');
  lines.push(`| 主线程同步工作量 p50 | ${mainP95 === 0 ? '—' : `${Number(result?.mainThreadP50Ms ?? 0).toFixed(2)} ms`} | 记录 | — |`);
  lines.push(`| 主线程同步工作量 p95 | ${mainP95.toFixed(2)} ms | ≤ 16.7 ms（帧预算候选） | ${mainP95 <= 16.7 ? '✅' : '⚠️'} |`);
  lines.push(`| 帧间隔 p50 | ${gapP50.toFixed(1)} ms | 记录 | — |`);
  lines.push(`| 帧间隔 p95 | ${gapP95.toFixed(1)} ms | ≥30 fps ⇒ ≤ 33.3 ms | ${fpsOk ? '✅' : '⚠️'} |`);
  lines.push(`| 松手 → 重算 + 冲突标记 | ${releaseMs.toFixed(1)} ms | ≤ 200 ms（IX-04） | ${releaseOk ? '✅' : '⚠️'} |`);
  lines.push(`| 拖动期 DOM 变化帧数 | ${String(result?.observedWidthChanges ?? 0)} / ${String(result?.frames ?? 0)} | > 0（下游跟随） | ${followObserved ? '✅' : '❌'} |`);
  lines.push(`| longtask 条目 | ${String(result?.longTasks ?? 0)} | 记录 | — |`);
  lines.push(`| 松手后锚点数 | ${String(result?.anchorsAfterRelease ?? '-')} | = 0（锚点不进文档、松手即清） | ${anchorsCleared ? '✅' : '❌'} |`);
  lines.push(`| 拖动前开始序号 | ${String(result?.anchorOrdinal ?? '—')} | 记录（位移的绝对基准） | — |`);
  lines.push(`| 期望的松手后 startDate | ${String(expectedAfter ?? '—')} | = 拖动前开始序号 + ${String(options.dayDelta)} 个工作日 | — |`);
  lines.push(`| 松手后文档 startDate | ${String(result?.documentStartAfter ?? '—')} | = 期望值（**位移判据**） | ${movedExactly ? '✅' : '❌'} |`);
  lines.push('');
  lines.push(`> 拖动目标任务：\`${String(result?.taskId ?? '')}\`；数据集 \`${String(result?.dataset ?? '')}\`。`);
  if ((result?.errors ?? []).length > 0) {
    lines.push('');
    lines.push('**页面内报错**：');
    for (const error of result.errors) lines.push(`- ${String(error)}`);
  }
  lines.push('');
  lines.push(`> 生成参数：${JSON.stringify(options)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 记录制：**把一份 xlsx 交给真实导入入口**，读回应用的反应（裁决 P-21 遗留 3 / P-22）。
 *
 * 口径：
 * - 文件走 CDP 的 `DOM.setFileInputFiles` 打到工具栏的 `input[type=file]` ——
 *   **不碰应用源码**，也不给导入路径开后门；
 * - 结果**全部从 DOM 读**：页脚的任务/依赖/诊断计数、诊断清单（点击工具栏「诊断」展开）、
 *   是否出现"不可排程"占位；
 * - 判据（缺一即 `status: 'error'`）：6 任务 / 5 依赖、恰有 **1** 条
 *   `XLSX_CYCLE_EDGE_DROPPED` 且消息里带成环路径、**没有**"不可排程"。
 */
async function importSample(cdp, origin, filePath) {
  const errors = [];
  const base = {
    file: filePath,
    sizeBytes: statSync(filePath).size,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    footer: '',
    tasks: null,
    links: null,
    diagnostics: [],
    cycleDropped: 0,
    unschedulable: null,
    chartRows: 0,
    chartEdges: 0,
  };

  await cdp.navigate(`${origin}/`);
  // 应用启动 + 演示文档（1,000 任务）就位。
  await new Promise((settle) => setTimeout(settle, 800));

  await cdp.call('DOM.enable');
  const root = await cdp.call('DOM.getDocument', { depth: -1 });
  const input = await cdp.call('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector: 'input[type=file]',
  });
  if (input?.nodeId === undefined || input.nodeId === 0) {
    return { ...base, status: 'error', errors: ['找不到文件输入框（工具栏的 input[type=file]）'] };
  }

  const before = await cdp.evaluate(`document.querySelector('footer.status')?.textContent ?? ''`);
  await cdp.call('DOM.setFileInputFiles', { files: [filePath], nodeId: input.nodeId });

  // 等导入完成：exceljs 是动态 import，页脚计数会从演示文档变成导入文档。
  const deadline = Date.now() + 30_000;
  let footer = before;
  while (Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 250));
    footer = await cdp.evaluate(`document.querySelector('footer.status')?.textContent ?? ''`);
    if (footer !== before) break;
  }
  if (footer === before) {
    errors.push('导入后页脚计数未变化（导入可能未触发或仍在进行）');
  }

  // 展开诊断清单（工具栏按钮文案是「诊断 N」）。
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('诊断'));
    if (button !== undefined) button.click();
    return true;
  })()`);
  await new Promise((settle) => setTimeout(settle, 250));

  const snapshot = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.diagnostics li')].map((li) => ({
      code: li.querySelector('code')?.textContent ?? '',
      severity: li.className,
      message: [...li.querySelectorAll('span')].map((span) => span.textContent).join(''),
      taskId: li.querySelector('em')?.textContent ?? null,
    }));
    return {
      footer: document.querySelector('footer.status')?.textContent ?? '',
      diagnostics: items,
      unschedulable: document.querySelector('.unschedulable') !== null,
      chartRows: document.querySelectorAll('#chart-pane .rows > g').length,
      chartEdges: document.querySelectorAll('#chart-pane .edges > g').length,
    };
  })()`);

  const footerText = String(snapshot?.footer ?? '');
  const parsed = /任务\s*(\d+)\s*·\s*依赖\s*(\d+)/.exec(footerText);
  const diagnostics = Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : [];
  const dropped = diagnostics.filter((item) => item.code === 'XLSX_CYCLE_EDGE_DROPPED');

  const result = {
    ...base,
    footer: footerText,
    tasks: parsed === null ? null : Number(parsed[1]),
    links: parsed === null ? null : Number(parsed[2]),
    diagnostics,
    cycleDropped: dropped.length,
    unschedulable: snapshot?.unschedulable === true,
    chartRows: Number(snapshot?.chartRows ?? 0),
    chartEdges: Number(snapshot?.chartEdges ?? 0),
  };

  if (result.tasks !== 6) errors.push(`任务数不是 6：${String(result.tasks)}`);
  if (result.links !== 5) errors.push(`依赖数不是 5：${String(result.links)}`);
  if (result.cycleDropped !== 1) {
    errors.push(`XLSX_CYCLE_EDGE_DROPPED 不是恰好 1 条：${String(result.cycleDropped)}`);
  }
  if (dropped.length > 0 && !String(dropped[0].message).includes('成环路径')) {
    errors.push(`成环丢弃的诊断里没有成环路径：${String(dropped[0].message)}`);
  }
  if (result.unschedulable) errors.push('导入产物被判为"不可排程"（成环边本该被确定性丢弃）');

  return { ...result, status: errors.length === 0 ? 'ok' : 'error', errors };
}

/** 导入记录制的证据（Markdown）。 */
function renderImportEvidence({ env, result }) {
  const lines = [];
  lines.push('# xlsx 导入记录制（成环样本，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/make-sample.mjs` + `node scripts/measure-render.mjs --import=<path>` 采集');
  lines.push('> （[裁决 P-21](../../../docs/00-baseline/裁决记录.md) §5 遗留 3、[P-22](../../../docs/00-baseline/裁决记录.md)）。');
  lines.push('> 成环边**丢弃**的语义本身由 `packages/xlsx-protocol/src/xlsxDependencies.spec.ts` 在门禁里覆盖；');
  lines.push('> 这一份证据守的是**应用层那一遍**：导入 → 诊断清单 → 任务/依赖计数。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 样本');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 路径 | \`${String(result.file)}\` |`);
  lines.push(`| 体积 | ${String(result.sizeBytes)} 字节 |`);
  lines.push(`| sha256 | \`${String(result.sha256)}\` |`);
  lines.push('| 形状 | 表 `任务`，表头 `WBS / 任务名称 / 前置任务`（**仅三列**），6 行 |');
  lines.push('| 环 | 第 6 行的 `前置任务=5` 闭合 `t5→t6`，被 `wouldCreateCycle` 判为成环 ⇒ 丢弃 |');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push('| 量 | 值 | 判据 | 判定 |');
  lines.push('|---|---|---|---|');
  lines.push(`| 任务数 | ${String(result.tasks ?? '—')} | = 6 | ${result.tasks === 6 ? '✅' : '❌'} |`);
  lines.push(`| 依赖数 | ${String(result.links ?? '—')} | = 5（第 6 条被丢弃） | ${result.links === 5 ? '✅' : '❌'} |`);
  lines.push(
    `| \`XLSX_CYCLE_EDGE_DROPPED\` 条数 | ${String(result.cycleDropped)} | = 1（带成环路径） | ${result.cycleDropped === 1 ? '✅' : '❌'} |`,
  );
  lines.push(
    `| 不可排程占位 | ${result.unschedulable ? '有' : '无'} | 无（丢弃后应为无环） | ${result.unschedulable ? '❌' : '✅'} |`,
  );
  lines.push(`| 渲染行 / 边 | ${String(result.chartRows)} / ${String(result.chartEdges)} | 记录 | — |`);
  lines.push('');
  lines.push(`> 页脚原文：\`${String(result.footer)}\``);
  lines.push('');
  lines.push('## 诊断清单（应用层读回的全部条目）');
  lines.push('');
  if ((result.diagnostics ?? []).length === 0) {
    lines.push('（空）');
  } else {
    lines.push('| # | severity | code | message | 定位 |');
    lines.push('|---|---|---|---|---|');
    result.diagnostics.forEach((item, index) => {
      lines.push(
        `| ${String(index + 1)} | ${String(item.severity)} | \`${String(item.code)}\` | ${String(item.message)} | ${String(item.taskId ?? '—')} |`,
      );
    });
  }
  if ((result.errors ?? []).length > 0) {
    lines.push('');
    lines.push('**判定失败**：');
    for (const error of result.errors) lines.push(`- ${String(error)}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(distRoot, 'index.html'))) {
    console.error('[measure] 缺少打包产物：先跑 `pnpm --filter @ganttpilot/web build`');
    process.exit(1);
  }
  mkdirSync(evidenceDir, { recursive: true });

  const { server, origin } = await startStaticServer(distRoot);
  const executable = findChrome();
  const { child, port } = await launchChrome(executable);
  const cdp = await connectCdp(port);

  try {
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    /**
     * 固定视口 1280×800（CSS 像素 / DPR 1）。
     *
     * 为什么必须显式覆盖：测量的是**打包产物**，而图表窗格的高度取决于真实窗口尺寸；
     * 不固定的话"可见行数"会随窗口变化，元素预算与首屏数字就无法复现、也无法跨机器比较。
     * **为什么是 800**：产品界面在 640 的视口里只给得起约 570 px 的图表高度
     * （工具栏 + 状态栏占掉其余），而 ADR 0007 §11 的预算常数是按**约 640 px 的图表窗格**
     * （27 可见行 + 缓冲 = 32 渲染行）标定的；取 800 后窗格正好约 640 px，渲染行数因此是 32。
     * 窗格真实的 `clientWidth/clientHeight` 会随结果一起登记（不假定它等于 1280×640）。
     */
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // 页面内的报错必须能被看到（否则"钩子没装好"只会表现为一个空异常）。
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {};
      const text = details.exception?.description ?? details.text ?? JSON.stringify(details);
      console.error(`[measure] 页面异常：${String(text)}`);
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const text = (params.args ?? []).map((item) => item.description ?? item.value ?? '').join(' ');
        console.error(`[measure] 页面 console.error：${String(text)}`);
      }
    });
    const version = await cdp.call('Browser.getVersion');
    const chromeVersion = String(version.product ?? 'unknown');

    // ---------------------------------------------------------------- 记录制：xlsx 导入（P-21 遗留 3）
    if (options.importPath !== null) {
      const filePath = resolve(options.importPath);
      if (!existsSync(filePath)) {
        console.error(`[import] 找不到样本文件：${filePath}`);
        console.error('[import] 先生成：node scripts/make-sample.mjs');
        process.exitCode = 1;
        return;
      }
      const result = await importSample(cdp, origin, filePath);
      const env = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        视口: '1280×800',
        样本: 'cyclic-dependency.xlsx（三列 / 6 行 / t5→t6 成环）',
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
      const evidencePath = join(evidenceDir, `import-cyclic-sample-chrome${major}.md`);
      writeFileSync(evidencePath, renderImportEvidence({ env, result }), 'utf8');
      writeFileSync(
        join(evidenceDir, 'import-cyclic-sample-raw.json'),
        `${JSON.stringify({ env, result }, null, 2)}\n`,
        'utf8',
      );
      console.log(
        `[import] 任务 ${String(result.tasks ?? '-')} / 依赖 ${String(result.links ?? '-')} / ` +
          `成环丢弃 ${String(result.cycleDropped)} / 不可排程 ${result.unschedulable ? '有' : '无'}`,
      );
      if (result.status === 'error') {
        console.error(`[import] errors: ${(result.errors ?? []).join('；')}`);
        process.exitCode = 1;
      }
      console.log(`[measure] 导入证据已写入 ${evidencePath}`);
      return;
    }

    // 预热一次导航（模块加载与首次布局的冷启动不进数字）。
    await cdp.navigate(`${origin}/?measure=1`);
    await new Promise((settle) => setTimeout(settle, 600));
    // 先读"应用级错误"抓手，再判断就绪——否则 `evaluate` 自身抛错会把抓手埋掉。
    let captured = '';
    try {
      captured = String(await cdp.evaluate('window.__GANTTPILOT_ERROR__ ?? ""'));
    } catch (error) {
      captured = `(读取抓手失败：${error instanceof Error ? error.message : String(error)})`;
    }
    const ready = await cdp.evaluate(
      'Boolean(window.__GANTTPILOT_READY__) && typeof window.__GANTTPILOT_MEASURE__ === "function"',
    );
    if (ready !== true) {
      throw new Error(`测量钩子未就绪。应用级错误抓手：${captured === '' ? '(空)' : captured}`);
    }

    const plans = [];
    for (const zoom of options.zooms) plans.push({ dataset: PRIMARY_DATASET, zoom });
    if (options.includeReference) plans.push({ dataset: REFERENCE_DATASET, zoom: 'day' });

    // ---------------------------------------------------------------- G5：拖动测量（记录制）
    if (options.drag) {
      const dragReady = await cdp.evaluate('typeof window.__GANTTPILOT_MEASURE_DRAG__ === "function"');
      if (dragReady !== true) throw new Error('拖动测量钩子未就绪（页面里没有 __GANTTPILOT_MEASURE_DRAG__）');
      const dragResult = await cdp.evaluate(
        `window.__GANTTPILOT_MEASURE_DRAG__(${JSON.stringify({
          dataset: PRIMARY_DATASET,
          dayDelta: options.dayDelta,
          frames: options.dragFrames,
        })})`,
      );
      const env = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        视口: '1280×800（窗格尺寸随结果登记）',
        数据集: PRIMARY_DATASET,
        拖动天数: options.dayDelta,
        测试帧数: options.dragFrames,
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
      const dragEvidencePath = join(evidenceDir, `drag-timing-chrome${major}.md`);
      writeFileSync(dragEvidencePath, renderDragEvidence({ env, result: dragResult, options }), 'utf8');
      writeFileSync(
        join(evidenceDir, 'drag-timing-raw.json'),
        `${JSON.stringify({ env, result: dragResult }, null, 2)}\n`,
        'utf8',
      );
      console.log(
        `[drag] 主线程 p95 ${Number(dragResult?.mainThreadP95Ms ?? 0).toFixed(2)} ms、` +
          `帧间隔 p50/p95 ${Number(dragResult?.frameGapP50Ms ?? 0).toFixed(1)}/${Number(dragResult?.frameGapP95Ms ?? 0).toFixed(1)} ms、` +
          `松手 ${Number(dragResult?.releaseMs ?? 0).toFixed(1)} ms、` +
          `DOM 变化帧 ${String(dragResult?.observedWidthChanges ?? 0)}、` +
          `松手后锚点 ${String(dragResult?.anchorsAfterRelease ?? '-')}、` +
          `startDate ${String(dragResult?.documentStartAfter ?? '-')}` +
          `（期望 ${String(dragResult?.expectedStartAfter ?? '-')}）`,
      );
      if (dragResult?.status === 'error') {
        console.error(`[drag] errors: ${(dragResult.errors ?? []).join('；')}`);
        process.exitCode = 1;
      }
      console.log(`[measure] 拖动证据已写入 ${dragEvidencePath}`);
      return;
    }

    const runs = [];
    for (const plan of plans) {
      const result = await measureOne(cdp, origin, { ...plan, rounds: options.rounds, scrollSteps: options.scrollSteps });
      runs.push({ ...plan, result });
      const first = result?.firstScreen;
      const scroll = result?.scroll;
      console.log(
        `[measure] ${plan.dataset}/${String(plan.zoom)}：首屏 ${first === null || first === undefined ? '失败' : `${first.primaryMs.toFixed(1)} ms`}、` +
          `10× 滚动 ${scroll === null || scroll === undefined ? '失败' : `${scroll.totalWallMs.toFixed(1)} ms`}、` +
          `主线程 p95 ${scroll === null || scroll === undefined ? '-' : `${scroll.p95WorkMs.toFixed(2)} ms`}、` +
          `空白行 ${scroll === null || scroll === undefined ? '-' : String(scroll.blankRowGaps)}`,
      );
      if (result?.status === 'error') console.error(`[measure]   errors: ${result.errors.join('；')}`);
    }

    const env = {
      采集时刻: new Date().toISOString(),
      机器: process.env.COMPUTERNAME ?? 'local',
      系统: `${process.platform} ${process.arch}`,
      Node: process.version,
      Chrome: chromeVersion,
      'Chrome 模式': '--headless=new',
      DPR: 1,
      视口: '1280×640',
      档位: options.zooms.join(' / '),
      数据集: plans.map((plan) => plan.dataset).join(' / '),
      轮数: options.rounds,
      滚动步数: options.scrollSteps,
    };

    const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
    const evidencePath = join(evidenceDir, `render-timing-chrome${major}.md`);
    writeFileSync(evidencePath, renderEvidence({ env, runs, options }), 'utf8');
    writeFileSync(join(evidenceDir, 'render-timing-raw.json'), `${JSON.stringify({ env, runs }, null, 2)}\n`, 'utf8');
    console.log(`[measure] 证据已写入 ${evidencePath}`);

    const failed = runs.filter((run) => run.result?.status === 'error');
    if (failed.length > 0) {
      console.error(`[measure] ${String(failed.length)} 组测量失败（基础设施不可信）`);
      process.exitCode = 1;
    }
  } finally {
    cdp.close();
    child.kill();
    server.close();
  }
}

await main();
