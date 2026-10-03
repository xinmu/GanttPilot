/**
 * 证据渲染（Markdown）。
 *
 * 稳定性纪律（照 S2 的口径）：
 * - 除性能报告（**测量快照**，允许重跑不同）外，其余证据文件不含时间戳、不含运行时版本，
 *   重跑应逐字节一致；换 Node 版本重跑不应改动它们；
 * - 所有文件以 LF 写入（`writeFile` 直接写 `\n`）。
 */

import { formatUs, type MeasureResult } from './harness.ts';
import { GATE_THRESHOLDS_MS } from './manifest.ts';
import type { DatasetPerf, PerfCase } from './perf.ts';
import type { Check, EngineProbe, HandCaseOutcome, InvariantSummary, NegativeControlOutcome } from './verify.ts';

export type GateVerdictState = 'pass' | 'fail' | 'quantified' | 'not-measured';

export interface GateVerdict {
  readonly id: string;
  readonly criterion: string;
  readonly measured: string;
  readonly state: GateVerdictState;
}

function renderCheckTable(checks: readonly Check[]): string {
  const failed = checks.filter((check) => !check.passed).length;
  return [
    `共 ${String(checks.length)} 条，通过 ${String(checks.length - failed)} 条，失败 ${String(failed)} 条。`,
    '',
    '| 检查 | 结果 | 实测 |',
    '|---|---|---|',
    ...checks.map(
      (check) =>
        `| \`${check.name}\` | ${check.passed ? '✅ 通过' : '❌ 失败'} | ${check.detail.replace(/\|/g, '\\|')} |`,
    ),
  ].join('\n');
}

export function renderHandCaseSection(outcomes: readonly HandCaseOutcome[]): string {
  const allChecks = outcomes.flatMap((outcome) => [...outcome.checks]);
  const lines: string[] = ['### L1-a 手工推导用例（4 关系 × lag 正/负/0 × 跨层级 × 日历例外）', ''];
  lines.push(renderCheckTable(allChecks));
  lines.push('', '用例明细：', '', '| 用例 | 说明 | ES（工作日序号） | EF | 各任务开始日（ISO） |', '|---|---|---|---|---|');
  for (const outcome of outcomes) {
    const es = outcome.ordinals === null ? '—（成环）' : `[${outcome.ordinals.es.join(', ')}]`;
    const ef = outcome.ordinals === null ? '—' : `[${outcome.ordinals.ef.join(', ')}]`;
    const iso = outcome.startIso === null ? '—' : `[${outcome.startIso.join(', ')}]`;
    lines.push(`| \`${outcome.caseId}\` | ${outcome.title} | ${es} | ${ef} | ${iso} |`);
  }
  return lines.join('\n');
}

export function renderCalendarCrossCheckSection(checks: readonly Check[]): string {
  return ['### L1-b 两套日历实现互证（索引前缀和 vs 逐日循环）', '', renderCheckTable(checks)].join('\n');
}

export function renderInvariantSection(summary: InvariantSummary): string {
  const lines = ['### L1-c 不变量（随机图）', ''];
  const total = Object.values(summary.byInvariant).reduce((sum, entry) => sum + entry.count, 0);
  lines.push(
    `在 **${String(summary.graphs)}** 张随机项目图（5–${String(120)} 任务、四类关系、lag ∈ [−3, 3]、含 5% 里程碑）上运行。`,
    '',
    `违规总数：**${String(total)}**；每条不变量的违规计数：`,
    '',
    '| 不变量 | 违规数 |',
    '|---|---|',
  );
  const invariants = [
    'EF = ES + duration',
    'LF = LS + duration',
    'TF = LS − ES',
    'TF ≥ 0',
    'FF ≥ 0',
    'TF ≥ FF',
    '关系边界方程',
    'FF 独立重算',
    '关键任务非空（纯 FS 图）',
    '随机图不应成环',
  ];
  const counts = new Map(summary.byInvariant.map((entry) => [entry.invariant, entry.count]));
  for (const invariant of invariants) {
    lines.push(`| ${invariant} | ${String(counts.get(invariant) ?? 0)} |`);
  }
  lines.push(
    '',
    `> **发现（不是违规）**：${String(summary.emptyCriticalOnMixedGraphs)}/${String(summary.graphs)} 张随机图的` +
      '「关键集合」为空——它们都含 SS/FF/SF 混合关系。此时"完成最晚的任务"不一定是任何终端的祖先，' +
      '因此所有任务的总浮动都 > 0。**纯 FS 图不存在该现象**（上表最后一条只对纯 FS 图生效）。',
    '> 这条对 v0.5 分析层有直接含义：关键路径高亮不能只判 `totalFloat === 0`，还要处理"关键集合为空"的退化情形。',
  );
  if (summary.violations.length > 0) {
    lines.push('', '前若干条违规明细：', '', '| 数据集 | 不变量 | 明细 |', '|---|---|---|');
    for (const violation of summary.violations.slice(0, 20)) {
      lines.push(
        `| \`${violation.datasetId}\` | ${violation.invariant} | ${violation.detail.replace(/\|/g, '\\|')} |`,
      );
    }
  }
  return lines.join('\n');
}

export function renderEngineProbeSection(probe: EngineProbe): string {
  return [
    '### L1-d 与主干 `packages/engine/src/date.ts` 的语义一致性',
    '',
    renderCheckTable(probe.checks),
    '',
    '> 本文件只放**语义等价性**；两套实现的**常数因子对照**（实测耗时）属于测量快照，',
    '> 见 `breakdown-node<版本>.md` §一。',
  ].join('\n');
}

export function renderCorrectnessNegativeSection(outcomes: readonly NegativeControlOutcome[]): string {
  const lines = [
    '### L1-e 正确性侧负向对照（证明判定集有判别力）',
    '',
    '| 编号 | 变造 | 是否被检出 | 报出的判据 |',
    '|---|---|---|---|',
  ];
  for (const outcome of outcomes) {
    lines.push(
      `| ${outcome.id} | ${outcome.description} | ${outcome.detected ? '✅ 检出' : '❌ 未检出'} | ${
        outcome.detail === '' ? '—' : outcome.detail.replace(/\|/g, '\\|')
      } |`,
    );
  }
  return lines.join('\n');
}

export function renderCorrectnessReport(input: {
  readonly handCases: readonly HandCaseOutcome[];
  readonly calendarChecks: readonly Check[];
  readonly invariants: InvariantSummary;
  readonly engineProbe: EngineProbe;
  readonly negativeControls: readonly NegativeControlOutcome[];
}): string {
  return [
    '# S3 · L1 正确性证据（可重跑、逐字节稳定）',
    '',
    '> 由 `node src/run-all.mts` 生成。判定基准是 `src/manifest.ts` 的**声明式期望值表**与不变量定义，',
    '> 不是"内核的再次序列化"。本文件不含时间戳与运行时版本，重跑应逐字节一致。',
    '',
    renderHandCaseSection(input.handCases),
    '',
    renderCalendarCrossCheckSection(input.calendarChecks),
    '',
    renderInvariantSection(input.invariants),
    '',
    renderEngineProbeSection(input.engineProbe),
    '',
    renderCorrectnessNegativeSection(input.negativeControls),
    '',
  ].join('\n');
}

function renderCaseRow(perfCase: PerfCase): string {
  const result = perfCase.result;
  return `| \`${perfCase.operation}\` | ${formatUs(result.p50)} | ${formatUs(result.p95)} | ${formatUs(result.p99)} | ${formatUs(result.worstP99)} | ${String(result.iterations)}×${String(result.suites)} | ${perfCase.structural.replace(/\|/g, '\\|')} |`;
}

export function renderPerfReport(input: {
  readonly nodeLabel: string;
  readonly gateDatasets: readonly DatasetPerf[];
  readonly observationDatasets: readonly DatasetPerf[];
  readonly verdicts: readonly GateVerdict[];
}): string {
  const lines = [
    `# S3 · L2 性能证据（测量快照 · ${input.nodeLabel}）`,
    '',
    '> 由 `node src/run-all.mts` 生成。**本文件是测量快照**：数值随机器、负载与运行时版本变化，',
    '> 重跑必然不同（这是唯一允许逐字节变化的证据，见 README 的稳定性纪律）。',
    '',
    '口径：`p50/p95/p99` 为 **median-of-suites**（同一场景跑多个 suite 后取中位数），',
    '同时给出最差 suite 的 p99；单位自适应（低于 1 ms 用 µs 显示）。日期维度一律是**工作日序号**（整数），因此热路径上没有 `Date`。',
    '',
    '## 一、门禁判定',
    '',
    '| 门禁 | 判据 | 实测 | 判定 |',
    '|---|---|---|---|',
    ...input.verdicts.map(
      (verdict) =>
        `| **${verdict.id}** | ${verdict.criterion} | ${verdict.measured} | ${
          verdict.state === 'pass'
            ? '✅ 通过'
            : verdict.state === 'fail'
              ? '❌ 不通过'
              : verdict.state === 'quantified'
                ? '📏 已量化'
                : '⚠️ 未测量'
        } |`,
    ),
    '',
    '## 二、门禁数据集（1,000 任务 / 1,500 依赖）',
    '',
  ];

  for (const dataset of input.gateDatasets) {
    lines.push(
      `### ${dataset.datasetId}（V=${String(dataset.taskCount)}，E=${String(dataset.linkCount)}，层级 ${String(dataset.levelCount)}，关键任务 ${String(dataset.criticalTasks)}，项目完成序号 ${String(dataset.projectFinish)}）`,
      '',
      '| 操作 | p50 | p95 | p99 | 最差 suite p99 | 迭代 | 结构性说明 |',
      '|---|---|---|---|---|---|---|',
      ...dataset.cases.map(renderCaseRow),
      '',
    );
    if (dataset.skipped.length > 0) {
      for (const skipped of dataset.skipped) {
        lines.push(`> 跳过：${skipped.reason}`);
      }
      lines.push('');
    }
  }

  lines.push('## 三、非门禁观测点（规模上探）', '');
  lines.push('| 数据集 | V | E | 操作 | p50 | p99 | 结构性说明 |', '|---|---|---|---|---|---|---|');
  for (const dataset of input.observationDatasets) {
    for (const perfCase of dataset.cases) {
      lines.push(
        `| ${dataset.datasetId} | ${String(dataset.taskCount)} | ${String(dataset.linkCount)} | \`${perfCase.operation}\` | ${formatUs(perfCase.result.p50)} | ${formatUs(perfCase.result.p99)} | ${perfCase.structural.replace(/\|/g, '\\|')} |`,
      );
    }
  }
  lines.push(
    '',
    '> 观测点用于支撑 README 的规模承诺（≤2,000 任务 / 3,000 依赖）；**不作为门禁**。',
    '> 2,000 任务的正式压测按 [首版能力顺序 §五](../../../docs/01-roadmap/首版能力顺序.md) 留在 v0.5。',
    '',
  );
  return lines.join('\n');
}

export function renderBreakdownReport(input: {
  readonly nodeLabel: string;
  readonly nc1: { readonly queries: number; readonly indexed: MeasureResult; readonly loopCalendar: MeasureResult };
  readonly engineProbe: EngineProbe;
  readonly datasetPerfs: readonly DatasetPerf[];
  readonly thresholds: { readonly nc1: number; readonly nc2: number; readonly nc3: number };
}): string {
  const { nc1, engineProbe, datasetPerfs, thresholds } = input;
  const lines = [
    `# S3 · L3 常数因子分解与负向对照（测量快照 · ${input.nodeLabel}）`,
    '',
    '> 由 `node src/run-all.mts` 生成。本文件是**测量快照**（含实测耗时），允许重跑不同；',
    '> 与之相对，`correctness-report.md` 与 `differential-report.md` 不含计时与时间戳，重跑应逐字节一致。',
    '',
    '> 本文件的用途**不是**给性能定标，而是回答两个问题：',
    '> ① 耗时花在算法上还是实现细节上；② 计时骨架**能否分辨差别**（否则前面的数字不构成结论）。',
    '',
    '> 范围：NC1（日期算术）与主干对照用 D1 的工作负载；NC2/NC3 只在 **D1** 上运行',
    '> （`runDatasetPerf` 的 `withNegativeControls` 只对第一个门禁数据集打开），其余数据集只出性能数字。',
    '',
    '## 一、日期算术：索引前缀和 vs 逐日循环',
    '',
    '| 实现 | 查询数 | p50 | p99 | 倍率（p50） |',
    '|---|---|---|---|---|',
    `| \`indexed.ordinalOfDay/dayOfOrdinal\` | ${String(nc1.queries)} | ${formatUs(nc1.indexed.p50)} | ${formatUs(nc1.indexed.p99)} | 1.00× |`,
    `| \`loop.ordinalOfDay/dayOfOrdinal\`（对齐主干口径） | ${String(nc1.queries)} | ${formatUs(nc1.loopCalendar.p50)} | ${formatUs(nc1.loopCalendar.p99)} | ${(nc1.loopCalendar.p50 / nc1.indexed.p50).toFixed(1)}× |`,
    '',
    `阈值：≥${String(thresholds.nc1)}× ⇒ 判定 ${nc1.loopCalendar.p50 / nc1.indexed.p50 >= thresholds.nc1 ? '**有判别力**' : '**测量无力**'}`,
    '',
    '主干的 `countWorkdays` 在同一工作负载上的实测（与索引日历对照；两者的**语义等价性**在',
    '`correctness-report.md` §L1-d 判定，这里只比常数因子）：',
    '',
    '| 实现 | p50 | p99 |',
    '|---|---|---|',
    ...engineProbe.measurements.map(
      (measurement) => `| \`${measurement.label}\` | ${formatUs(measurement.p50)} | ${formatUs(measurement.p99)} |`,
    ),
    '',
    '> 关键结论：**日历不参与 CPM 传播**。序号空间把"日期算术"完全移出热路径，',
    '> 只有渲染/导出（1,000 任务 × 2 个日期）需要翻译，因此索引日历的收益体现在 I/O 边界而非传播。',
    '',
    '## 二、增量 vs 全量：闭包传播 vs 每跳全量重算（NC2）',
    '',
    '对照刻意绑在**闭包最大**的场景（`propagate-critical`）上：非关键编辑的闭包常只有几个节点，',
    '在那个规模上比值会被噪声淹没（实测同机可在 0.5×–2× 间跳）。',
    '',
    '| 数据集 | 闭包传播 p50 | 每跳全量重算 p50 | 倍率 | 闭包规模 | 判定 |',
    '|---|---|---|---|---|---|',
  ];
  for (const dataset of datasetPerfs) {
    if (dataset.criticalPropagationUs === null || dataset.perHopRecomputeUs === null) {
      continue;
    }
    const base = dataset.cases.find((item) => item.operation === 'propagate-critical');
    const control = dataset.cases.find((item) => item.operation === 'nc2-per-hop-recompute');
    if (base === undefined || control === undefined) {
      continue;
    }
    const ratio = control.result.p50 / base.result.p50;
    lines.push(
      `| ${dataset.datasetId} | ${formatUs(base.result.p50)} | ${formatUs(control.result.p50)} | ${ratio.toFixed(1)}× | ${String(dataset.visitedCritical ?? 0)} | ${ratio >= thresholds.nc2 ? '✅ 有判别力' : '❌ 测量无力'} |`,
    );
  }
  lines.push(
    '',
    '## 三、数据布局：扁平数组 + CSR vs Map + 对象图（NC3）',
    '',
    '| 数据集 | 扁平数组 p50 | 对象图 p50 | 倍率 | 判定 |',
    '|---|---|---|---|---|',
  );
  for (const dataset of datasetPerfs) {
    const base = dataset.cases.find((item) => item.operation === 'propagate-critical');
    const control = dataset.cases.find((item) => item.operation === 'nc3-object-graph-propagation');
    if (base === undefined || control === undefined) {
      continue;
    }
    const ratio = control.result.p50 / base.result.p50;
    lines.push(
      `| ${dataset.datasetId} | ${formatUs(base.result.p50)} | ${formatUs(control.result.p50)} | ${ratio.toFixed(1)}× | ${ratio >= thresholds.nc3 ? '✅ 有判别力' : '❌ 测量无力'} |`,
    );
  }
  lines.push(
    '',
    '## 四、计时器分辨率的处理',
    '',
    '性能证据的「迭代」列形如 `1000×5`（每次 suite 的迭代数 × suite 数）；',
    '单次操作耗时低于 10 × 计时器分辨率时，骨架自动按 `batchSize` 批量计时再折算到单次，',
    '因此 p50 不会退化成"等于分辨率"。',
    '',
  );
  return lines.join('\n');
}

export function renderDifferentialReport(input: {
  readonly projects: number;
  readonly cyclicProjects: number;
  readonly compared: number;
  readonly mismatches: readonly { readonly field: string; readonly projectIndex: number; readonly detail: string }[];
  readonly cycledDetectedByBoth: number;
  readonly cycleMismatches: readonly number[];
  readonly skippedReason: string | null;
  readonly referenceBytes: number;
}): string {
  const lines = [
    '# S3 · L1b 独立参照实现差分测试（可重跑、逐字节稳定）',
    '',
    '> 由 `node src/differential.mts`（经 `run-all.mts` 调用）生成。参照实现是**独立写法**的 Python 程序',
    '> （`reference/cpm_reference.py`：递归 + `datetime.date` + 显式工作日集合 + DFS 染色检环），',
    '> 与 TS 侧（迭代 + 整数序号 + CSR + Kahn）不共享任何代码，只共享 `manifest.ts` 声明的字段契约。',
    '',
  ];
  if (input.skippedReason !== null) {
    lines.push(
      `**本层未运行：${input.skippedReason}**。按协议，差分未通过 ⇒ L1b 判为「未验证」，**不得静默通过**。`,
      '',
    );
    return lines.join('\n');
  }
  lines.push(
    `- 随机 DAG：**${String(input.projects)}** 个（5–200 任务、四类关系、lag ∈ [−3, 3]、含 5% 里程碑）；`,
    `- 含环图：**${String(input.cyclicProjects)}** 个（两侧必须一致报环，其余判定不计入）；`,
    `- 日历轮换：默认 Mon–Fri、整周放假、Mon–Sat 三种（按项目序号取模），两侧用各自的日历实现翻译日期；`,
    `- 逐字段比对的项目数：**${String(input.compared)}**；`,
    `- 字段不一致总数：**${String(input.mismatches.length)}**；`,
    `- 两侧一致检出成环的图：**${String(input.cycledDetectedByBoth)}/${String(input.cyclicProjects)}**；`,
    `- 参照实现脚本体积：${String(input.referenceBytes)} 字节。`,
    '',
    '比对字段：`es / ef / ls / lf / totalFloat / freeFloat / critical / projectFinish / esIso / efIso`。',
    '其中 `esIso/efIso` 由两侧**各自的日历实现**翻译，因此这一层同时交叉验证了"工作日序号 ↔ ISO 日期"的语义。',
    '',
  );
  if (input.mismatches.length === 0 && input.cycleMismatches.length === 0) {
    lines.push('**结论：0 处不一致。**');
  } else {
    lines.push('| 字段 | 项目序号 | 明细 |', '|---|---|---|');
    for (const mismatch of input.mismatches.slice(0, 20)) {
      lines.push(`| ${mismatch.field} | ${String(mismatch.projectIndex)} | ${mismatch.detail.replace(/\|/g, '\\|')} |`);
    }
    if (input.cycleMismatches.length > 0) {
      lines.push('', `成环判定不一致的项目序号：${input.cycleMismatches.join(', ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function renderEnvReport(): string {
  return [
    '# S3 · 环境口径（固定字符串，重跑逐字节一致）',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 平台 | Windows x64 |',
    '| CPU | 13th Gen Intel Core i7-13700K |',
    '| 内存 | 32 GB |',
    '| 时区 | UTC+08:00（系统默认） |',
    '| 主口径运行时 | Node **24.15.0**（与 CONTRIBUTING / CI 口径一致） |',
    '| 记录口径运行时 | Node **26.7.0** |',
    '| 参照实现运行时 | Python 3.14.5（仅差分测试使用，不是发行依赖） |',
    '| 测量前提 | 测量期间机器空闲；判定值取 median-of-suites，同时记录最差 suite |',
    '',
    '> 刻意写固定字符串而不写 `process.version`：本文件用于固定环境口径，不是版本探测器。',
    '> 性能报告按运行时大版本分别落盘（`perf-node24.md` / `perf-node26.md`）。',
    '',
    '## 未覆盖（必须与性能结论一起读）',
    '',
    '1. **浏览器与绘制侧未测量**：没有 `requestAnimationFrame`、样式/布局/GC 停顿的界面表现数据，',
    '   因此"拖拽 ≥30fps"（G5 门禁）**未被本 spike 验证**，Node 数字不能替代它；',
    '2. 未测 Worker 化、增量拓扑序维护的工程实现、约束类型（G-3/G-4）、2,000 任务的正式压测（v0.5）；',
    '3. 未做 Microsoft PowerPoint/Excel 类第三方工具验证（本 spike 与 WPS 无关）。',
    '',
  ].join('\n');
}

export function computeGateVerdicts(datasetPerfs: readonly DatasetPerf[]): GateVerdict[] {
  const gate = datasetPerfs.filter((dataset) => dataset.cases.some((item) => item.grade === 'gate'));
  const full = gate
    .map((dataset) => dataset.cases.find((item) => item.operation === 'full-recompute'))
    .filter((item): item is PerfCase => item !== undefined);
  const maxFullMs = Math.max(...full.map((item) => item.result.p99 / 1000));
  const fullPass = maxFullMs <= GATE_THRESHOLDS_MS.fullRecompute;

  const localCases = gate
    .map((dataset) => dataset.cases.find((item) => item.operation === 'propagate-noncritical'))
    .filter((item): item is PerfCase => item !== undefined);
  const maxLocalMs = localCases.length === 0 ? Number.NaN : Math.max(...localCases.map((item) => item.result.p99 / 1000));
  const localPass = localCases.length > 0 && maxLocalMs <= GATE_THRESHOLDS_MS.localPropagation;

  const criticalCases = gate
    .map((dataset) => dataset.cases.find((item) => item.operation === 'propagate-critical'))
    .filter((item): item is PerfCase => item !== undefined);
  const maxCriticalMs = Math.max(...criticalCases.map((item) => item.result.p99 / 1000));

  const commitCases = gate
    .map((dataset) => dataset.cases.find((item) => item.operation === 'full-recompute-after-critical-edit'))
    .filter((item): item is PerfCase => item !== undefined);
  const maxCommitMs = Math.max(...commitCases.map((item) => item.result.p99 / 1000));
  const commitPass = commitCases.length > 0 && maxCommitMs <= GATE_THRESHOLDS_MS.commitRecompute;

  const visited = gate
    .map((dataset) => `${dataset.datasetId}:${String(dataset.visitedCritical ?? 0)}/${String(dataset.taskCount)}`)
    .join('，');

  return [
    {
      id: 'G3-a',
      criterion: `全量重算 p99 ≤ ${String(GATE_THRESHOLDS_MS.fullRecompute)} ms @1,000/1,500`,
      measured: `最差数据集 p99 = ${formatUs(maxFullMs * 1000)}（${String(full.length)} 个数据集）`,
      state: fullPass ? 'pass' : 'fail',
    },
    {
      id: 'G3-b',
      criterion: `非关键编辑的后继闭包传播 p99 ≤ ${String(GATE_THRESHOLDS_MS.localPropagation)} ms`,
      measured:
        localCases.length === 0
          ? '无可测数据集'
          : `最差数据集 p99 = ${formatUs(maxLocalMs * 1000)}（${String(localCases.length)} 个数据集）`,
      state: localPass ? 'pass' : 'fail',
    },
    {
      id: 'G3-c',
      criterion: '关键路径编辑的耗时被量化（预期不满足 10 ms）',
      measured: `关键编辑闭包传播最差 p99 = ${formatUs(maxCriticalMs * 1000)}；受影响子图规模 ${visited}`,
      state: 'quantified',
    },
    {
      id: 'IX-04',
      criterion: `松手后合并重算（含逆向/浮动/关键路径）p99 ≤ ${String(GATE_THRESHOLDS_MS.commitRecompute)} ms`,
      measured: `最差数据集 p99 = ${formatUs(maxCommitMs * 1000)}（${String(commitCases.length)} 个数据集）`,
      state: commitPass ? 'pass' : 'fail',
    },
  ];
}
