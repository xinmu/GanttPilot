/**
 * 只跑性能层（L2）并写性能证据：用于按运行时版本分别取数，不重复跑 L1/L1b。
 *
 * 用法：`node src/bench.mts`（Node 26）或
 *       `& "$env:LOCALAPPDATA\nvm\v24.15.0\node.exe" src/bench.mts`（Node 24，主口径）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDataset } from './graph-gen.ts';
import { formatUs, measureTimerResolutionNs } from './harness.ts';
import { GATE_DATASETS, GATE_MEASURE, OBSERVATION_DATASETS, OBSERVATION_MEASURE } from './manifest.ts';
import { runDatasetPerf, type DatasetPerf } from './perf.ts';
import { computeGateVerdicts, renderPerfReport } from './report.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(spikeRoot, 'evidence');
mkdirSync(evidenceDir, { recursive: true });

const nodeMajor = process.versions.node.split('.')[0] ?? 'unknown';
const nodeLabel = `Node ${process.versions.node}`;
const resolutionNs = measureTimerResolutionNs();
console.log(`[bench] ${nodeLabel}，计时器分辨率 ${String(resolutionNs)} ns`);

const gatePerfs: DatasetPerf[] = GATE_DATASETS.map((spec, index) =>
  runDatasetPerf(generateDataset(spec), GATE_MEASURE, 'gate', resolutionNs, index === 0),
);
const observationPerfs: DatasetPerf[] = OBSERVATION_DATASETS.map((spec) =>
  runDatasetPerf(generateDataset(spec), OBSERVATION_MEASURE, 'observation', resolutionNs, false),
);
const verdicts = computeGateVerdicts(gatePerfs);

const report = renderPerfReport({ nodeLabel, gateDatasets: gatePerfs, observationDatasets: observationPerfs, verdicts });
writeFileSync(join(evidenceDir, `perf-node${nodeMajor}.md`), report.endsWith('\n') ? report : `${report}\n`, 'utf8');

for (const verdict of verdicts) {
  console.log(`[bench] ${verdict.id}：${verdict.state} —— ${verdict.measured}`);
}
for (const perf of gatePerfs) {
  const full = perf.cases.find((item) => item.operation === 'full-recompute');
  console.log(`[bench] ${perf.datasetId} 全量重算 p99=${formatUs(full?.result.p99 ?? Number.NaN)}`);
}
