/**
 * S3 一键入口：L1（正确性） → L1b（独立参照实现差分） → L2（性能） → L3（常数因子与判别力）
 * → 写 `evidence/` 与 `out/` → 打印门禁判定。
 *
 * **报告先写后断言**：即使失败也留下现场（照 S2 的口径）。
 *
 * 退出码口径（写进 `结论.md`）：非零退出表示**测量基础设施不可信**——
 * L1/L1b 失败、不变量违规、负向对照未检出、或负向对照未达判别力阈值。
 * 门禁 G3-a/G3-b/G3-c 的判定是**数据**（可能"不通过"），按协议进入 DoD 改写分支，不改变退出码。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDifferential } from './differential.mts';
import { generateDataset } from './graph-gen.ts';
import { formatUs, measureTimerResolutionNs } from './harness.ts';
import {
  GATE_DATASETS,
  GATE_MEASURE,
  NEGATIVE_CONTROL_MEASURE,
  NEGATIVE_CONTROL_THRESHOLDS,
  OBSERVATION_DATASETS,
  OBSERVATION_MEASURE,
  SPIKE_ID,
  SPIKE_TITLE,
} from './manifest.ts';
import { runCalendarNegativeControl, runDatasetPerf, type DatasetPerf } from './perf.ts';
import {
  computeGateVerdicts,
  renderBreakdownReport,
  renderCorrectnessReport,
  renderDifferentialReport,
  renderEnvReport,
  renderPerfReport,
} from './report.ts';
import {
  runCalendarCrossCheck,
  runCorrectnessNegativeControls,
  runEngineProbe,
  runHandCases,
  runInvariants,
  type Check,
} from './verify.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(spikeRoot, 'evidence');
const outDir = join(spikeRoot, 'out');
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(join(outDir, 'raw'), { recursive: true });

const nodeMajor = process.versions.node.split('.')[0] ?? 'unknown';
const nodeLabel = `Node ${process.versions.node}`;

function writeText(path: string, content: string): void {
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

console.log(`=== ${SPIKE_ID} ${SPIKE_TITLE} ===`);
console.log(`运行时：${nodeLabel}`);

const resolutionNs = measureTimerResolutionNs();
console.log(`计时器分辨率：${String(resolutionNs)} ns`);

// ------------------------------------------------------------------ L1

console.log('\n[L1-a] 手工推导用例…');
const handCases = runHandCases();
console.log('[L1-b] 两套日历互证…');
const calendarChecks = runCalendarCrossCheck();
console.log('[L1-c] 不变量（随机图）…');
const invariants = runInvariants();
console.log('[L1-d] 主干 date.ts 对照…');
const engineProbe = runEngineProbe(resolutionNs);
console.log('[L1-e] 正确性负向对照…');
const correctnessNegativeControls = runCorrectnessNegativeControls();

// ------------------------------------------------------------------ L1b

console.log('\n[L1b] 独立参照实现差分…');
const differential = runDifferential();
if (differential.skippedReason === null) {
  console.log(
    `      比对 ${String(differential.compared)} 个项目，字段不一致 ${String(differential.mismatches.length)} 处，` +
      `成环一致 ${String(differential.cycledDetectedByBoth)}/${String(differential.cyclicProjects)}`,
  );
} else {
  console.log(`      未运行：${differential.skippedReason}`);
}

// ------------------------------------------------------------------ L2

console.log('\n[L2] 门禁数据集性能测量…');
const gatePerfs: DatasetPerf[] = GATE_DATASETS.map((spec, index) =>
  runDatasetPerf(generateDataset(spec), GATE_MEASURE, 'gate', resolutionNs, index === 0),
);
for (const perf of gatePerfs) {
  const full = perf.cases.find((item) => item.operation === 'full-recompute');
  const local = perf.cases.find((item) => item.operation === 'propagate-noncritical');
  console.log(
    `      ${perf.datasetId}: 全量重算 p99=${formatUs(full?.result.p99 ?? Number.NaN)}；` +
      `非关键传播 p99=${local === undefined ? '（无浮动任务）' : formatUs(local.result.p99)}`,
  );
}

console.log('[L2] 非门禁观测点…');
const observationPerfs: DatasetPerf[] = OBSERVATION_DATASETS.map((spec) =>
  runDatasetPerf(generateDataset(spec), OBSERVATION_MEASURE, 'observation', resolutionNs, false),
);

const verdicts = computeGateVerdicts(gatePerfs);

// ------------------------------------------------------------------ L3

console.log('\n[L3] 常数因子与负向对照…');
const firstGateDataset = generateDataset(GATE_DATASETS[0]!);
const nc1 = runCalendarNegativeControl(firstGateDataset, NEGATIVE_CONTROL_MEASURE, resolutionNs);
const nc1Ratio = nc1.loopCalendar.p50 / nc1.indexed.p50;

let bestNc2 = 0;
let bestNc3 = 0;
for (const perf of gatePerfs) {
  const base = perf.cases.find((item) => item.operation === 'propagate-critical');
  const nc2 = perf.cases.find((item) => item.operation === 'nc2-per-hop-recompute');
  const nc3 = perf.cases.find((item) => item.operation === 'nc3-object-graph-propagation');
  if (base !== undefined && nc2 !== undefined) {
    bestNc2 = Math.max(bestNc2, nc2.result.p50 / base.result.p50);
  }
  if (base !== undefined && nc3 !== undefined) {
    bestNc3 = Math.max(bestNc3, nc3.result.p50 / base.result.p50);
  }
}
console.log(`      NC1 逐日循环 / 索引日历 = ${nc1Ratio.toFixed(1)}×`);
console.log(`      NC2 每跳全量重算 / 闭包传播 = ${bestNc2.toFixed(1)}×`);
console.log(`      NC3 对象图 / 扁平数组 = ${bestNc3.toFixed(1)}×`);

// ------------------------------------------------------------------ 证据

writeText(
  join(evidenceDir, 'correctness-report.md'),
  renderCorrectnessReport({
    handCases,
    calendarChecks,
    invariants,
    engineProbe,
    negativeControls: correctnessNegativeControls,
  }),
);
writeText(
  join(evidenceDir, 'differential-report.md'),
  renderDifferentialReport({
    projects: differential.projects,
    cyclicProjects: differential.cyclicProjects,
    compared: differential.compared,
    mismatches: differential.mismatches,
    cycledDetectedByBoth: differential.cycledDetectedByBoth,
    cycleMismatches: differential.cycleMismatches,
    skippedReason: differential.skippedReason,
    referenceBytes: differential.referenceBytes,
  }),
);
writeText(
  join(evidenceDir, `perf-node${nodeMajor}.md`),
  renderPerfReport({ nodeLabel, gateDatasets: gatePerfs, observationDatasets: observationPerfs, verdicts }),
);
writeText(
  join(evidenceDir, `breakdown-node${nodeMajor}.md`),
  renderBreakdownReport({
    nodeLabel,
    nc1,
    engineProbe,
    datasetPerfs: gatePerfs,
    thresholds: NEGATIVE_CONTROL_THRESHOLDS,
  }),
);
writeText(join(evidenceDir, 'env.md'), renderEnvReport());

writeText(
  join(outDir, 'raw', `perf-node${nodeMajor}.json`),
  JSON.stringify(
    {
      nodeLabel,
      resolutionNs,
      verdicts,
      datasets: gatePerfs.map((perf) => ({
        datasetId: perf.datasetId,
        cases: perf.cases.map((item) => ({
          operation: item.operation,
          grade: item.grade,
          p50: item.result.p50,
          p95: item.result.p95,
          p99: item.result.p99,
          worstP99: item.result.worstP99,
          minUs: item.result.minUs,
          maxUs: item.result.maxUs,
          suiteP50: item.result.suiteP50,
          suiteP95: item.result.suiteP95,
          suiteP99: item.result.suiteP99,
          iterations: item.result.iterations,
          suites: item.result.suites,
          batchSize: item.result.batchSize,
          structural: item.structural,
        })),
      })),
      observation: observationPerfs.map((perf) => ({
        datasetId: perf.datasetId,
        cases: perf.cases.map((item) => ({
          operation: item.operation,
          p50: item.result.p50,
          p99: item.result.p99,
        })),
      })),
      negativeControls: { nc1Ratio, bestNc2, bestNc3 },
    },
    null,
    2,
  ),
);

// ------------------------------------------------------------------ 判定

const l1Checks: Check[] = [
  ...handCases.flatMap((outcome) => [...outcome.checks]),
  ...calendarChecks,
  ...engineProbe.checks,
];
const failedL1 = l1Checks.filter((check) => !check.passed);
const undetected = correctnessNegativeControls.filter((outcome) => !outcome.detected);

console.log('\n=== 汇总 ===');
console.log(`L1 判定：${String(l1Checks.length - failedL1.length)}/${String(l1Checks.length)} 通过`);
console.log(
  `L1 不变量：${String(invariants.graphs)} 张随机图，违规 ${String(
    invariants.byInvariant.reduce((sum, entry) => sum + entry.count, 0),
  )} 条`,
);
console.log(`L1 负向对照：检出 ${String(correctnessNegativeControls.length - undetected.length)}/${String(correctnessNegativeControls.length)}`);
console.log(
  `L1b 差分：${differential.skippedReason === null ? `不一致 ${String(differential.mismatches.length)} 处` : `未运行（${differential.skippedReason}）`}`,
);
console.log(`L3 判别力：NC1=${nc1Ratio.toFixed(1)}×（阈值 ${String(NEGATIVE_CONTROL_THRESHOLDS.nc1)}×）`);
console.log(`           NC2=${bestNc2.toFixed(1)}×（阈值 ${String(NEGATIVE_CONTROL_THRESHOLDS.nc2)}×）`);
console.log(`           NC3=${bestNc3.toFixed(1)}×（阈值 ${String(NEGATIVE_CONTROL_THRESHOLDS.nc3)}×）`);
for (const verdict of verdicts) {
  console.log(`门禁 ${verdict.id}：${verdict.state} —— ${verdict.measured}`);
}

assert.equal(failedL1.length, 0, `L1 有 ${String(failedL1.length)} 条判定失败`);
assert.equal(
  invariants.byInvariant.reduce((sum, entry) => sum + entry.count, 0),
  0,
  '不变量出现违规',
);
assert.equal(undetected.length, 0, `正确性负向对照未被检出：${undetected.map((item) => item.id).join(',')}`);
assert.equal(differential.skippedReason, null, `差分未运行：${String(differential.skippedReason)}`);
assert.equal(differential.mismatches.length, 0, `差分不一致 ${String(differential.mismatches.length)} 处`);
assert.equal(differential.cycleMismatches.length, 0, '成环判定不一致');
assert.equal(
  differential.cycledDetectedByBoth,
  differential.cyclicProjects,
  '成环图未被两侧一致检出',
);
assert.ok(nc1Ratio >= NEGATIVE_CONTROL_THRESHOLDS.nc1, `NC1 未达判别力阈值（${nc1Ratio.toFixed(2)}×）`);
assert.ok(bestNc2 >= NEGATIVE_CONTROL_THRESHOLDS.nc2, `NC2 未达判别力阈值（${bestNc2.toFixed(2)}×）`);
assert.ok(bestNc3 >= NEGATIVE_CONTROL_THRESHOLDS.nc3, `NC3 未达判别力阈值（${bestNc3.toFixed(2)}×）`);

console.log(
  `\n[run-all] 测量基础设施全绿：L1 / L1b / 判别力对照均通过。证据已写入 evidence/（性能报告为测量快照）。`,
);
