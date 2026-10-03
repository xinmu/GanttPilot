#!/usr/bin/env node
/**
 * G4-S 一键入口（Node 侧：L0 几何 → L1 裁剪 → L2 定标 → 写 `evidence/`）。
 *
 * ## 退出码口径（沿 S3 的先例）
 *
 * **非零 = 测量基础设施不可信**：夹具不可排程、期望值表/不变量违规、负向对照未检出、
 * 引擎 `dist` 缺失或过期、常量与判据不自洽。
 *
 * **门禁判定（S4-a…S4-d）是数据，不是退出码**：某条"不通过"意味着按协议改写 DoD 或触发降级，
 * 而不是脚本失败（唯一例外是 S4-b 的"丢边为 0"——协议明文规定那是**数据无效、必须重造**）。
 *
 * 浏览器计时（S4-c）单独入口：`node src/browser-run.mts`（依赖本机 Chrome、记录制）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compute,
  createScheduleCalendar,
  CURRENT_DOCUMENT_VERSION,
  PLANNED_GATE,
  reindexDocument,
  serializeDocument,
  validateDocument,
  weekdayOf,
} from '../../../packages/engine/dist/index.js';
import { arrowDistinguishability } from './arrows.mjs';
import { countElements, countElementsByEnumeration } from './count.mjs';
import { buildFixture, describeValidation, fixtureJson, scaleGradientFixtures } from './fixture.mjs';
import { measureStubClearance, stubConstancySweep } from './fold-stability.mjs';
import {
  checkClipSoundness,
  checkEdgeEndpointsAndSummaryCoverage,
  checkManualCases,
  checkRoundTrip,
  checkSentinelGuard,
} from './invariants.mjs';
import {
  DATASETS,
  EXIT_CODES,
  REFERENCE_DATASET,
  S4B_SCROLL_ROW_OFFSETS,
  SCALE_GRADIENT_LINK_RATIO,
  SCALE_GRADIENT_TASKS,
  THRESHOLDS,
  VIEWPORT,
  ZOOM_ORDER,
} from './manifest.mjs';
import {
  negativeControlEndpointClipping,
  negativeControlNoWindowClipping,
  negativeControlWrongGeometry,
} from './negative-control.mjs';
import {
  renderClippingReport,
  renderEnv,
  renderGeometryExpectations,
  renderInvariantsReport,
  renderRoutingReport,
  renderScaleParams,
} from './report.mjs';
import { scaleParams } from './scale-params.mjs';
import { buildView } from './view-model.mjs';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(spikeRoot, '..', '..');
const evidenceDir = join(spikeRoot, 'evidence');
const outDir = join(spikeRoot, 'out');
const engineDist = join(repoRoot, 'packages', 'engine', 'dist', 'index.js');
const engineSrcDir = join(repoRoot, 'packages', 'engine', 'src');

const failures: string[] = [];
/** @param {boolean} condition @param {string} message */
function require_(condition, message) {
  if (!condition) failures.push(message);
}

// ---------------------------------------------------------------- L0 前置校验
//
// 为什么不用"比较 dist 与 src 的 mtime"：`tsc -b` 是**增量**构建，源码没变时它**不会重写产物**，
// mtime 必然比 src 旧——那会把"dist 正常"误报成"dist 过期"。这里改为**行为化漂移检查**：
// ① 产物存在；② 探针用到的 API 面齐全；③ 产物里"文档版本 / 已落地能力块"与**源码文本**一致。
if (!existsSync(engineDist)) {
  console.error(`[G4-S] 缺少引擎构建产物：${engineDist}`);
  console.error('[G4-S] 先跑：pnpm --filter @ganttpilot/engine build');
  process.exit(EXIT_CODES.infrastructure);
}
const apiSurface = { compute, createScheduleCalendar, reindexDocument, serializeDocument, validateDocument, weekdayOf };
const missingApi = Object.entries(apiSurface)
  .filter(([, value]) => typeof value !== 'function')
  .map(([name]) => name);
if (missingApi.length > 0) {
  console.error(`[G4-S] 引擎产物缺少探针依赖的 API：${missingApi.join('、')}——先重新构建。`);
  process.exit(EXIT_CODES.infrastructure);
}
const schemaSource = readFileSync(join(engineSrcDir, 'schema.ts'), 'utf8');
const indexSource = readFileSync(join(engineSrcDir, 'index.ts'), 'utf8');
const sourceVersion = Number(/CURRENT_DOCUMENT_VERSION\s*=\s*(\d+)/.exec(schemaSource)?.[1] ?? Number.NaN);
const sourceGate = /PLANNED_GATE\s*=\s*'([^']+)'/.exec(indexSource)?.[1] ?? '';
if (sourceVersion !== CURRENT_DOCUMENT_VERSION || sourceGate !== PLANNED_GATE) {
  console.error(
    `[G4-S] 引擎产物与源码不一致：dist 的 version/gate = ${String(CURRENT_DOCUMENT_VERSION)}/${PLANNED_GATE}，` +
      `源码 = ${String(sourceVersion)}/${sourceGate}。先跑：pnpm --filter @ganttpilot/engine build`,
  );
  process.exit(EXIT_CODES.infrastructure);
}

mkdirSync(evidenceDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

console.log('[G4-S] 装配夹具…');
const fixtures = DATASETS.map((spec) => buildFixture(spec));
const referenceFixture = buildFixture(REFERENCE_DATASET);
const primary = fixtures[2];
if (primary === undefined) throw new Error('缺少主口径数据集');
const gradient = scaleGradientFixtures(DATASETS[2], SCALE_GRADIENT_TASKS, SCALE_GRADIENT_LINK_RATIO);

for (const spec of DATASETS) {
  const fixture = fixtures.find((item) => item.spec.key === spec.key);
  if (fixture === undefined) continue;
  require_(
    fixture.stats.linkCount === spec.links && fixture.stats.taskCount === spec.tasks,
    `夹具 ${spec.key} 规模不符：任务 ${String(fixture.stats.taskCount)}/依赖 ${String(fixture.stats.linkCount)}`,
  );
  require_(fixture.validation.errors.length === 0, `夹具 ${spec.key} 有 schema error`);
}

// ---------------------------------------------------------------- L0 几何期望值表
console.log('[G4-S] L0 几何期望值表 + 哨兵守卫…');
const manual = checkManualCases({ calendar: primary.calendar });
const sentinel = checkSentinelGuard({ calendar: primary.calendar });
const nc3 = negativeControlWrongGeometry({ calendar: primary.calendar });
require_(manual.every((row) => row.pass), `几何期望值表未全过：${String(manual.filter((r) => !r.pass).length)} 条失败`);
require_(sentinel.every((row) => row.pass), '哨兵守卫未通过（-1 喂进几何未抛错）');
require_(nc3.pass, 'NC3 未检出（期望值表可能是恒真式）');

// ---------------------------------------------------------------- L1 裁剪与不变量
console.log('[G4-S] L1 裁剪、元素预算与不变量…');
const perDataset: { dataset: string; zoom: string; counts: ReturnType<typeof countElements> }[] = [];
const invariantChecks: { name: string; pass: boolean; detail: string }[] = [];
const budgetChecks: { name: string; pass: boolean; detail: string }[] = [];

for (const fixture of [...fixtures, referenceFixture]) {
  for (const zoom of ZOOM_ORDER) {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: VIEWPORT,
      zoom,
    });
    const counts = countElements(view);
    const byEnumeration = countElementsByEnumeration(view);
    require_(
      counts.total === byEnumeration.total,
      `元素计数两路不一致（${fixture.spec.key}/${zoom}）：${String(counts.total)} vs ${String(byEnumeration.total)}`,
    );
    require_(counts.withinBudget, `元素超预算（${fixture.spec.key}/${zoom}）：${String(counts.total)} > ${String(counts.bound)}`);
    perDataset.push({ dataset: fixture.spec.name, zoom, counts });
    budgetChecks.push({
      name: `预算成立：${fixture.spec.name}·${zoom}（${String(counts.total)} ≤ ${String(counts.bound)}）`,
      pass: counts.withinBudget,
      detail: `渲染行 ${String(counts.renderedRows)}、渲染边 ${String(counts.renderedEdges)}、c₃=${String(counts.c3)}、余量 ${String(counts.slack)}`,
    });
  }
}

for (const fixture of fixtures) {
  const view = buildView({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    viewport: VIEWPORT,
    zoom: 'day',
  });
  const endpointView = buildView({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    viewport: VIEWPORT,
    zoom: 'day',
    clipMode: 'endpoints',
  });
  for (const check of checkRoundTrip({ view, calendar: fixture.calendar })) {
    invariantChecks.push({ ...check, name: `${fixture.spec.name}·${check.name}` });
  }
  for (const check of checkEdgeEndpointsAndSummaryCoverage({
    view,
    schedule: fixture.schedule,
    document: fixture.document,
    calendar: fixture.calendar,
  })) {
    invariantChecks.push({ ...check, name: `${fixture.spec.name}·${check.name}` });
  }
  for (const check of checkClipSoundness({ intersectView: view, endpointView })) {
    invariantChecks.push({ ...check, name: `${fixture.spec.name}·${check.name}` });
  }
}
invariantChecks.push(...sentinel);
require_(invariantChecks.every((row) => row.pass), '不变量有失败项');

// ---------------------------------------------------------------- S4-a / S4-b
console.log('[G4-S] S4-a（规模无关）与 S4-b（求交必要性）…');
const gradientRows = gradient.map((item) => {
  const view = buildView({
    document: item.fixture.document,
    schedule: item.fixture.schedule,
    calendar: item.fixture.calendar,
    viewport: VIEWPORT,
    zoom: 'day',
  });
  const counts = countElements(view);
  return {
    size: item.size,
    linkCount: item.fixture.stats.linkCount,
    renderedRows: counts.renderedRows,
    renderedEdges: counts.renderedEdges,
    total: counts.total,
  };
});
const totals = gradientRows.map((row) => row.total);
const gradientRatio = Math.max(...totals) / Math.min(...totals);
const renderedRowsConstant = new Set(gradientRows.map((row) => row.renderedRows)).size === 1;

const nc1 = negativeControlEndpointClipping({
  document: primary.document,
  schedule: primary.schedule,
  calendar: primary.calendar,
  scrollRowOffsets: S4B_SCROLL_ROW_OFFSETS,
  viewport: VIEWPORT,
});
const nc2 = negativeControlNoWindowClipping({
  fixtures: gradient.map((item) => ({
    size: item.size,
    document: item.fixture.document,
    schedule: item.fixture.schedule,
  })),
  calendar: primary.calendar,
  viewport: VIEWPORT,
});

if (nc1.totalLost === 0) {
  console.error('[G4-S] S4-b **数据无效**：端点可见性裁剪一条边都没丢 ⇒ 测试数据未覆盖跨屏长边，必须重造。');
  process.exit(EXIT_CODES.infrastructure);
}

const s4aChecks = [
  {
    name: `S4-a：元素预算在全部（数据集 × 档位）上成立`,
    pass: budgetChecks.every((row) => row.pass),
    detail: `检查 ${String(budgetChecks.length)} 组；失败 ${String(budgetChecks.filter((row) => !row.pass).length)} 组`,
  },
  {
    name: `S4-a：10× 规模跨度下元素总数增长 ≤ ${String(THRESHOLDS.windowedGrowthRatio)}×`,
    pass: gradientRatio <= THRESHOLDS.windowedGrowthRatio,
    detail: `实测 ${gradientRatio.toFixed(3)}×（${String(Math.min(...totals))} → ${String(Math.max(...totals))}）；对照：关掉裁剪 ${nc2.ratio.toFixed(2)}×`,
  },
  {
    name: 'S4-a：渲染行数与文档总规模无关',
    pass: renderedRowsConstant,
    detail: `规模梯度上的渲染行数 = ${gradientRows.map((row) => String(row.renderedRows)).join('/')}`,
  },
  {
    name: `S4-b：求交裁剪必要性（每位置丢 ≥ ${String(THRESHOLDS.minCrossScreenLossPerPosition)}、合计 ≥ ${String(THRESHOLDS.totalCrossScreenLoss)}）`,
    pass: nc1.pass,
    detail: `合计误裁 ${String(nc1.totalLost)} 条；按位置 ${nc1.positions.map((row) => String(row.lost)).join('/')}`,
  },
  {
    name: `NC2：关掉窗口裁剪后元素数必须随规模增长（> ${String(THRESHOLDS.nc2GrowthRatio)}×）`,
    pass: nc2.pass,
    detail: `实测 ${nc2.ratio.toFixed(2)}×（${nc2.rows.map((row) => String(row.total)).join('/')}）`,
  },
];

// ---------------------------------------------------------------- L2 定标探针
console.log('[G4-S] L2 箭头、折点与规模常量定标…');
const arrows = arrowDistinguishability();
const sampleLinkIndices = primary.document.links
  .map((_, index) => index)
  .filter((index) => index < 400)
  .slice(0, 120);
const fixed = stubConstancySweep({
  document: primary.document,
  schedule: primary.schedule,
  calendar: primary.calendar,
  linkIndices: sampleLinkIndices,
  mode: 'fixed',
});
const proportional = stubConstancySweep({
  document: primary.document,
  schedule: primary.schedule,
  calendar: primary.calendar,
  linkIndices: sampleLinkIndices,
  mode: 'proportional',
});
const clearance = measureStubClearance({
  view: buildView({
    document: primary.document,
    schedule: primary.schedule,
    calendar: primary.calendar,
    viewport: VIEWPORT,
    zoom: 'day',
  }),
});
const params = scaleParams();
require_(params.consistent, '规模常量与定标判据不自洽（改了常量却没改判据？）');
require_(arrows.pass, 'S4-d：箭头两两可区分性未达阈值');
require_(
  fixed.maxStubDeviation === 0 && fixed.maxWrapDeviation === 0,
  'S4-d：固定像素 stub/wrap 的常数性不成立',
);
require_(proportional.maxStubDeviation > 0, 'S4-d 负向对照无效：比例式 stub 竟然也常数（判据无判别力）');

const s4dPass =
  arrows.pass && fixed.maxStubDeviation === 0 && fixed.maxWrapDeviation === 0 && proportional.maxStubDeviation > 0;

// ---------------------------------------------------------------- 写证据
console.log('[G4-S] 写 evidence/…');
const date = new Date().toISOString().slice(0, 10);
void date; // 稳定层不写时间戳（由 git 历史承担）；这里只保留一句说明，避免误以为"数字与日期绑定"。
writeFileSync(join(evidenceDir, 'env.md'), renderEnv({ nodeVersion: process.version, chromeVersion: '见 browser-timing-*.md', chromeMode: '见 browser-timing-*.md' }), 'utf8');
writeFileSync(
  join(evidenceDir, 'geometry-expectations.md'),
  renderGeometryExpectations({ manual, nc3, fixtures: [...fixtures, referenceFixture] }),
  'utf8',
);
writeFileSync(
  join(evidenceDir, 'clipping-report.md'),
  renderClippingReport({
    perDataset,
    gradient: gradientRows,
    nc1,
    nc2,
    judgement: {
      checks: [...s4aChecks, ...budgetChecks.slice(0, 6)],
    },
  }),
  'utf8',
);
writeFileSync(join(evidenceDir, 'invariants-report.md'), renderInvariantsReport({ checks: invariantChecks }), 'utf8');
writeFileSync(
  join(evidenceDir, 'routing-report.md'),
  renderRoutingReport({ arrows, fixed, proportional, clearance, pass: s4dPass }),
  'utf8',
);
writeFileSync(
  join(evidenceDir, 'scale-params-report.md'),
  renderScaleParams({ params }),
  'utf8',
);
writeFileSync(join(outDir, `fixture-${primary.spec.key}.json`), fixtureJson(primary), 'utf8');
writeFileSync(join(outDir, `fixture-${referenceFixture.spec.key}.json`), fixtureJson(referenceFixture), 'utf8');
for (const fixture of fixtures) {
  writeFileSync(join(outDir, `fixture-${fixture.spec.key}.json`), fixtureJson(fixture), 'utf8');
}

// ---------------------------------------------------------------- 汇总
console.log('');
console.log('=== G4-S 门禁判定（数据，不是退出码）===');
for (const check of s4aChecks) console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name} —— ${check.detail}`);
console.log(`  ${s4dPass ? 'PASS' : 'FAIL'}  S4-d：箭头可区分 + 折点常数性 —— min=${arrows.minDistance.toFixed(4)}、fixed stub/wrap 偏差=${String(fixed.maxStubDeviation)}/${String(fixed.maxWrapDeviation)}、比例式对照=${proportional.maxStubDeviation.toFixed(3)}`);
console.log('  INFO  S4-c：浏览器首屏与滚动见 `node src/browser-run.mts`（记录制）');
console.log('');
console.log('=== 夹具 ===');
for (const fixture of [...fixtures, referenceFixture]) {
  console.log(
    `  ${fixture.stats.name}: 任务 ${String(fixture.stats.taskCount)}、依赖 ${String(fixture.stats.linkCount)}、校验 ${describeValidation(fixture) || '无诊断'}`,
  );
}
console.log('');
if (failures.length > 0) {
  console.error('=== 基础设施失败（退出码非零）===');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(EXIT_CODES.infrastructure);
}
console.log('=== [G4-S] L0–L2 全部基础设施检查通过；判定与数字见 evidence/ ===');
