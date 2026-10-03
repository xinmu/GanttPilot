#!/usr/bin/env node
/**
 * G4-S 的浏览器计时入口（S4-c，**记录制**）。
 *
 * 流程：起零依赖静态服务器（把**仓库根**当文档根，于是浏览器里的相对 import 与 Node 完全一致）
 * → 起 Chrome（`--headless=new`、临时 profile、`--remote-debugging-port=0`）
 * → 连 CDP → 逐个夹具导航并等探针的完成 Promise → 写证据 → 清理。
 *
 * **缺 Chrome 即失败，不静默跳过**（P-12 口径）：可用 `GANTTPILOT_CHROME` 指定可执行文件。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from './browser/host.mjs';
import { chromeVersion, connectCdp, evaluate, launchChrome, listTargets, navigate, resolveChromePath } from './cdp.mjs';
import { BROWSER_RUNS, DATASETS, EXIT_CODES, PRIMARY_DATASET_KEY, REFERENCE_DATASET, THRESHOLDS, VIEWPORT } from './manifest.mjs';
import { renderBrowserTiming } from './report.mjs';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(spikeRoot, '..', '..');
const evidenceDir = join(spikeRoot, 'evidence');
const outDir = join(spikeRoot, 'out');

const chromePath = resolveChromePath();
if (chromePath === null) {
  console.error('[G4-S] 找不到 Chrome。浏览器计时**不跳过**（P-12 口径）：装 Chrome 或用 GANTTPILOT_CHROME 指定路径。');
  process.exit(EXIT_CODES.infrastructure);
}
console.log(`[G4-S] Chrome: ${chromePath}`);

const primary = DATASETS.find((spec) => spec.key === PRIMARY_DATASET_KEY) ?? DATASETS[0];
if (primary === undefined) throw new Error('缺少主口径数据集');
const targets = [primary, REFERENCE_DATASET];
for (const spec of targets) {
  const fixturePath = join(outDir, `fixture-${spec.key}.json`);
  if (!existsSync(fixturePath)) {
    console.error(`[G4-S] 缺少夹具 ${fixturePath}；先跑：node src/run-all.mts`);
    process.exit(EXIT_CODES.infrastructure);
  }
}

mkdirSync(evidenceDir, { recursive: true });
const server = await startStaticServer({
  root: repoRoot,
  // 白名单：只放行探针与引擎产物（服务器仍绑定 127.0.0.1 + 临时端口）。
  prefixes: ['spikes/g0-s4-svg-clipping', 'packages/engine/dist'],
});
const profileDir = join(tmpdir(), `ganttpilot-g4s-${String(Date.now())}`);
const chrome = await launchChrome({ chromePath, userDataDir: profileDir });
console.log(`[G4-S] 静态服务器 ${server.origin}；DevTools 端口 ${String(chrome.port)}`);

/** 探针页返回的结果形状（页面侧是 `.mjs`，这里只声明浏览器计时用到的字段）。 */
type ProbeRunResult = {
  status?: string;
  errors?: string[];
  marks: Record<string, number>;
  documentShape?: { tasks: number; links: number; diagnostics: number };
  firstScreen: {
    zoom: string;
    label: string;
    primaryFromReadyMs: number;
    counts: { renderedRows: number; renderedEdges: number; elements: number };
    samples: { frameMs: number; geometryMs: number; renderMs: number }[];
  }[];
  scroll: {
    steps: unknown[];
    totalWallMs: number;
    totalWorkMs: number;
    p50WorkMs: number;
    p95WorkMs: number;
    rafP50Ms: number;
    rafP95Ms: number;
    longTaskCount: number;
    longTaskTotalMs: number;
  } | null;
  blankRowGaps: number;
};

type RunRecord = {
  key: string;
  zoom: string;
  spec: { key: string; name: string; tasks: number; links: number };
  result: ProbeRunResult;
};

const runs: RunRecord[] = [];
const failures: string[] = [];
let session: Awaited<ReturnType<typeof connectCdp>> | null = null;
let version = { browser: 'unknown', userAgent: '', protocolVersion: '' };
try {
  version = await chromeVersion(chrome.port);
  const targets2 = await listTargets(chrome.port);
  const page = targets2.find((target) => target.type === 'page');
  if (page === undefined || page.webSocketDebuggerUrl === undefined) {
    throw new Error('未找到可用的页面 target');
  }
  session = await connectCdp(page.webSocketDebuggerUrl);
  // 页面里的错误必须**显式打出来**：模块 404 / import 解析失败在 CDP 侧只表现为"页面什么都没挂上"，
  // 不打日志的话排查成本极高（本探针第一版就踩过：`../../..` 少了一级 ⇒ 引擎 404）。
  session.onEvent((event) => {
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      const text = details.exceptionDetails?.exception?.description ?? details.exceptionDetails?.text ?? '';
      console.error(`[page] 异常：${text}`);
      failures.push(`页面异常：${text}`);
    }
    if (event.method === 'Log.entryAdded') {
      const entry = (event.params as { entry?: { level?: string; text?: string; url?: string } }).entry;
      if (entry !== undefined && entry.level === 'error') {
        console.error(`[page] ${entry.level}：${entry.text ?? ''}（${entry.url ?? ''}）`);
        failures.push(`页面日志错误：${entry.text ?? ''}`);
      }
    }
  });

  // 一次导航只测一个 (夹具 × 档位)：首屏口径是"就绪 → 首帧"，多档同页会让计时互相污染（第一版踩过）。
  const navigations = [
    { spec: primary, zoom: 'day', scroll: true },
    { spec: primary, zoom: 'week', scroll: false },
    { spec: primary, zoom: 'month', scroll: false },
    { spec: REFERENCE_DATASET, zoom: 'day', scroll: true },
  ];
  for (const job of navigations) {
    const url =
      `${server.origin}/spikes/g0-s4-svg-clipping/src/browser/index.html` +
      `?fixture=${encodeURIComponent(job.spec.key)}&zoom=${job.zoom}&rounds=${String(BROWSER_RUNS)}&scroll=${job.scroll ? '1' : '0'}`;
    const key = `${job.spec.name}·${job.spec.links} 依赖·${job.zoom === 'day' ? '日档' : job.zoom === 'week' ? '周档' : '月档'}`;
    console.log(`[G4-S] 导航：${key}`);
    await navigate(session, url);
    const result = (await evaluate(session, 'window.__G4S__.done.then(() => window.__G4S__.result)', {
      awaitPromise: true,
      timeoutMs: 120_000,
    })) as ProbeRunResult | null;
    if (result === null || result === undefined) throw new Error(`${key}：页面未返回结果`);
    runs.push({ key, zoom: job.zoom, spec: job.spec, result });
    console.log(
      `[G4-S]   ${key}：${result.status}，首屏 ${String(result.firstScreen?.[0]?.primaryFromReadyMs ?? 0)} ms、` +
        `元素 ${String(result.firstScreen?.[0]?.counts?.elements ?? 0)}、` +
        (job.scroll ? `10× 滚动 ${String(result.scroll?.totalWallMs ?? 0)} ms / 主线程 p95 ${String(result.scroll?.p95WorkMs ?? 0)} ms` : '（不测滚动）'),
    );
    if (result.status !== 'ok') failures.push(`${key} 探针报错：${(result.errors ?? []).join('；')}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  session?.close();
  await chrome.close();
  await server.close();
}

// ---------------------------------------------------------------- 判定（S4-c）
const firstScreenRuns = runs.filter((run) => run.result.firstScreen.length > 0);
const primaryFirstScreen = firstScreenRuns.filter((run) => run.spec.key === PRIMARY_DATASET_KEY);
const worstFirstScreen = primaryFirstScreen.length === 0
  ? Number.POSITIVE_INFINITY
  : Math.max(...primaryFirstScreen.map((run) => run.result.firstScreen[0].primaryFromReadyMs));
/** 只保留真的测了滚动的运行，并在类型上收紧（`scroll` 非空）。 */
const scrollRuns = runs
  .map((run) => ({ key: run.key, scroll: run.result.scroll }))
  .filter((entry): entry is { key: string; scroll: NonNullable<ProbeRunResult['scroll']> } => entry.scroll !== null);
const worstScroll = scrollRuns.length === 0
  ? Number.POSITIVE_INFINITY
  : Math.max(...scrollRuns.map((entry) => entry.scroll.totalWallMs));
const blankRows = runs.reduce((acc, run) => acc + (run.result.blankRowGaps ?? 0), 0);
const worstWorkP95 = scrollRuns.reduce((acc, entry) => Math.max(acc, entry.scroll.p95WorkMs), 0);

const checks = [
  {
    name: `S4-c：1,000 任务 / 1,500 依赖首屏 ≤ ${String(THRESHOLDS.firstScreenMs)} ms（口径：就绪→含依赖线首帧；取三档中最差）`,
    pass: worstFirstScreen <= THRESHOLDS.firstScreenMs,
    detail: primaryFirstScreen
      .map((run) => `${run.key.split('·')[2] ?? run.zoom}=${run.result.firstScreen[0].primaryFromReadyMs.toFixed(1)} ms`)
      .join('、'),
  },
  {
    name: `S4-c：10× 滚动与《评估报告》§5.4（2,200 边 / 约 ${String(THRESHOLDS.scrollReferenceMs)} ms）同尺对照`,
    pass: worstScroll <= THRESHOLDS.scrollReferenceMs,
    detail: scrollRuns.map((entry) => `${entry.key}=${entry.scroll.totalWallMs.toFixed(1)} ms`).join('、'),
  },
  {
    name: 'S4-c：滚动期间零空白行（缓冲行的唯一作用）',
    pass: blankRows === 0,
    detail: `空白行合计 ${String(blankRows)}`,
  },
  {
    name: 'S4-c（记录制）：滚动步的主线程 p95 ≤ 16.7 ms（"无可见掉帧"的量化形式）',
    pass: worstWorkP95 <= 16.7,
    detail: `实测最差 p95 = ${worstWorkP95.toFixed(2)} ms（帧间隔 p95 见证据表，含浏览器空闲/节流，不作门禁）`,
  },
];

const major = /Chrome\/(\d+)/.exec(version.browser)?.[1] ?? 'unknown';
writeFileSync(
  join(evidenceDir, `browser-timing-chrome${major}.md`),
  renderBrowserTiming({
    chrome: { browser: version.browser, mode: 'headless=new' },
    runs: runs.map((run) => ({ key: run.key, result: run.result })),
    checks,
  }),
  'utf8',
);
writeFileSync(
  join(outDir, `browser-raw-chrome${major}.json`),
  `${JSON.stringify({ chrome: version, viewport: VIEWPORT, runs }, null, 2)}\n`,
  'utf8',
);

console.log('');
console.log('=== G4-S · S4-c 判定（记录制）===');
for (const check of checks) console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name} —— ${check.detail}`);
console.log('');
console.log(`证据：evidence/browser-timing-chrome${major}.md（原始 JSON 在 out/，不入库）`);

if (failures.length > 0) {
  console.error('');
  console.error('=== 浏览器计时失败（基础设施，退出码非零）===');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(EXIT_CODES.infrastructure);
}
