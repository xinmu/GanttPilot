/**
 * L1 正确性判定集：手工用例 + 不变量 + 两套日历互证 + 主干 `date.ts` 对照
 * + **正确性侧的负向对照**（证明判定集有判别力）。
 *
 * 判定基准是 `manifest.ts` 的声明式期望值表；本文件只做比对，不改期望值。
 */

import { countWorkdays, parseIsoDate } from '../../../packages/engine/src/date.ts';
import { createCalendar, dayNumberToIso, isoToDayNumber, type Calendar } from './calendar.ts';
import { computeSchedule, materializeDates } from './cpm.ts';
import { generateDataset, PROJECT_START_DAY } from './graph-gen.ts';
import { measure, type MeasureResult } from './harness.ts';
import { CAL_DEFAULT, HAND_CASES, INVARIANT_CONFIG, type HandCase } from './manifest.ts';
import type { Schedule } from './model.ts';
import type { Graph } from './cpm.ts';

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface HandCaseOutcome {
  readonly caseId: string;
  readonly title: string;
  readonly checks: readonly Check[];
  readonly ordinals: { readonly es: number[]; readonly ef: number[] } | null;
  readonly startIso: readonly string[] | null;
}

function compareField(caseId: string, field: string, actual: Int32Array, expected: readonly number[]): Check {
  const mismatches: string[] = [];
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i] && mismatches.length < 3) {
      mismatches.push(`#${String(i)} 期望 ${String(expected[i])} 实得 ${String(actual[i])}`);
    }
  }
  return {
    name: `${caseId}/${field}`,
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? `[${expected.join(', ')}]` : `不一致（${mismatches.join('；')}）`,
  };
}

function compareIso(caseId: string, field: string, actual: readonly string[], expected: readonly string[]): Check {
  const mismatches: string[] = [];
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i] && mismatches.length < 3) {
      mismatches.push(`#${String(i)} 期望 ${String(expected[i])} 实得 ${String(actual[i])}`);
    }
  }
  return {
    name: `${caseId}/${field}`,
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? `[${expected.join(', ')}]` : mismatches.join('；'),
  };
}

function evaluateHandCase(handCase: HandCase): HandCaseOutcome {
  const checks: Check[] = [];
  const result = computeSchedule({
    taskCount: handCase.durations.length,
    durations: handCase.durations,
    links: handCase.links,
    calendar: handCase.calendar,
    baseDay: PROJECT_START_DAY,
  });

  if (handCase.expectCycle) {
    checks.push({
      name: `${handCase.id}/cycle-detected`,
      passed: result.cycleNodes !== null,
      detail:
        result.cycleNodes === null
          ? '未检出环（期望检出）'
          : `检出 ${String(result.cycleNodes.length)} 个成环节点：${Array.from(result.cycleNodes).join(',')}`,
    });
    checks.push({
      name: `${handCase.id}/no-schedule-on-cycle`,
      passed: result.schedule === null,
      detail: result.schedule === null ? '成环时不产出排程结果' : '成环却产出了排程结果（不一致）',
    });
    return { caseId: handCase.id, title: handCase.title, checks, ordinals: null, startIso: null };
  }

  const schedule = result.schedule;
  const expected = handCase.expected;
  if (schedule === null || expected === null) {
    checks.push({
      name: `${handCase.id}/computed`,
      passed: false,
      detail: schedule === null ? '意外成环，未得到排程结果' : '用例缺少期望值',
    });
    return { caseId: handCase.id, title: handCase.title, checks, ordinals: null, startIso: null };
  }

  const fieldPairs: readonly (readonly [string, Int32Array, readonly number[]])[] = [
    ['es', schedule.es, expected.es],
    ['ef', schedule.ef, expected.ef],
    ['ls', schedule.ls, expected.ls],
    ['lf', schedule.lf, expected.lf],
    ['tf', schedule.totalFloat, expected.tf],
    ['ff', schedule.freeFloat, expected.ff],
  ];
  for (const [field, actual, wanted] of fieldPairs) {
    checks.push(compareField(handCase.id, field, actual, wanted));
  }
  checks.push({
    name: `${handCase.id}/projectFinish`,
    passed: schedule.projectFinish === expected.projectFinish,
    detail: `期望 ${String(expected.projectFinish)} 实得 ${String(schedule.projectFinish)}`,
  });
  checks.push({
    name: `${handCase.id}/no-clamped-start`,
    passed: schedule.clampedStarts === 0,
    detail: `clampedStarts = ${String(schedule.clampedStarts)}`,
  });

  const dates = materializeDates(schedule, result.calendar);
  if (expected.startIso !== undefined) {
    checks.push(compareIso(handCase.id, 'startIso', dates.startIso, expected.startIso));
  }

  return {
    caseId: handCase.id,
    title: handCase.title,
    checks,
    ordinals: { es: Array.from(schedule.es), ef: Array.from(schedule.ef) },
    startIso: dates.startIso,
  };
}

export function runHandCases(): HandCaseOutcome[] {
  return HAND_CASES.map(evaluateHandCase);
}

/**
 * 两套日历实现的互证：同一批日期/序号查询必须逐项一致。
 * 这一步与 CPM 无关——它验证的是"序号 ↔ 日期"的翻译（索引前缀和 vs 逐日循环）。
 */
export function runCalendarCrossCheck(): Check[] {
  const checks: Check[] = [];
  const calendars = new Map<string, Calendar>();
  for (const handCase of HAND_CASES) {
    if (calendars.has(handCase.calendar.id)) {
      continue;
    }
    const indexed = createCalendar('indexed', handCase.calendar, PROJECT_START_DAY, 1200);
    const loop = createCalendar('loop', handCase.calendar, PROJECT_START_DAY, 1200);
    let mismatches = 0;
    let detail = '';
    for (let day = PROJECT_START_DAY; day < PROJECT_START_DAY + 600; day += 1) {
      if (indexed.isWorkday(day) !== loop.isWorkday(day)) {
        mismatches += 1;
        detail ||= `isWorkday(${dayNumberToIso(day)})`;
      }
      if (indexed.ordinalOfDay(day) !== loop.ordinalOfDay(day)) {
        mismatches += 1;
        detail ||= `ordinalOfDay(${dayNumberToIso(day)})`;
      }
    }
    for (let k = 0; k <= 200; k += 1) {
      if (indexed.dayOfOrdinal(k) !== loop.dayOfOrdinal(k)) {
        mismatches += 1;
        detail ||= `dayOfOrdinal(${String(k)})`;
      }
    }
    checks.push({
      name: `${handCase.calendar.id}/loop-vs-indexed`,
      passed: mismatches === 0,
      detail:
        mismatches === 0
          ? '600 天逐日判定 + 201 个序号映射 + 全部区间计数逐项一致'
          : `不一致 ${String(mismatches)} 处，首处：${detail}`,
    });
    calendars.set(handCase.calendar.id, indexed);
  }
  return checks;
}

export interface InvariantViolation {
  readonly datasetId: string;
  readonly invariant: string;
  readonly detail: string;
}

/**
 * 不变量判定（可作用于任意 `Schedule`，因此也是负向对照的判据）。覆盖：
 * `EF = ES + D`、`LF = LS + D`、`TF = LS − ES`、`TF ≥ FF ≥ 0`、四类关系的前向边界方程、
 * 自由浮动的**独立重算**、关键任务非空。
 */
export function checkInvariants(
  datasetId: string,
  graph: Graph,
  durations: Int32Array,
  schedule: Schedule,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const n = graph.taskCount;
  const push = (invariant: string, detail: string): void => {
    if (violations.length < 20) {
      violations.push({ datasetId, invariant, detail });
    }
  };

  for (let i = 0; i < n; i += 1) {
    const duration = durations[i]!;
    if (schedule.ef[i] !== schedule.es[i]! + duration) {
      push(
        'EF = ES + duration',
        `#${String(i)}: ${String(schedule.ef[i])} ≠ ${String(schedule.es[i])}+${String(duration)}`,
      );
    }
    if (schedule.lf[i] !== schedule.ls[i]! + duration) {
      push('LF = LS + duration', `#${String(i)}`);
    }
    if (schedule.totalFloat[i] !== schedule.ls[i]! - schedule.es[i]!) {
      push('TF = LS − ES', `#${String(i)}`);
    }
    if (schedule.totalFloat[i]! < 0) {
      push('TF ≥ 0', `#${String(i)}: ${String(schedule.totalFloat[i])}`);
    }
    if (schedule.freeFloat[i]! < 0) {
      push('FF ≥ 0', `#${String(i)}: ${String(schedule.freeFloat[i])}`);
    }
    if (schedule.freeFloat[i]! > schedule.totalFloat[i]!) {
      push(
        'TF ≥ FF',
        `#${String(i)}: TF=${String(schedule.totalFloat[i])} FF=${String(schedule.freeFloat[i])}`,
      );
    }

    const end = graph.succOffset[i + 1]!;
    for (let k = graph.succOffset[i]!; k < end; k += 1) {
      const succ = graph.succTarget[k]!;
      const lag = graph.succLag[k]!;
      const type = graph.succType[k]!;
      let boundMet: boolean;
      let equation: string;
      if (type === 0) {
        boundMet = schedule.es[succ]! >= schedule.ef[i]! + lag;
        equation = `es[${String(succ)}] ≥ ef[${String(i)}] + ${String(lag)}`;
      } else if (type === 1) {
        boundMet = schedule.es[succ]! >= schedule.es[i]! + lag;
        equation = `es[${String(succ)}] ≥ es[${String(i)}] + ${String(lag)}`;
      } else if (type === 2) {
        boundMet = schedule.ef[succ]! >= schedule.ef[i]! + lag;
        equation = `ef[${String(succ)}] ≥ ef[${String(i)}] + ${String(lag)}`;
      } else {
        boundMet = schedule.ef[succ]! >= schedule.es[i]! + lag;
        equation = `ef[${String(succ)}] ≥ es[${String(i)}] + ${String(lag)}`;
      }
      if (!boundMet) {
        push('关系边界方程', `不成立：${equation}`);
      }
    }

    let expectedFree: number;
    if (graph.succOffset[i] === end) {
      expectedFree = schedule.projectFinish - schedule.ef[i]!;
    } else {
      expectedFree = Number.POSITIVE_INFINITY;
      for (let k = graph.succOffset[i]!; k < end; k += 1) {
        const succ = graph.succTarget[k]!;
        const lag = graph.succLag[k]!;
        const type = graph.succType[k]!;
        let slack: number;
        if (type === 0) {
          slack = schedule.es[succ]! - schedule.ef[i]! - lag;
        } else if (type === 1) {
          slack = schedule.es[succ]! - schedule.es[i]! - lag;
        } else if (type === 2) {
          slack = schedule.ef[succ]! - schedule.ef[i]! - lag;
        } else {
          slack = schedule.ef[succ]! - schedule.es[i]! - lag;
        }
        if (slack < expectedFree) {
          expectedFree = slack;
        }
      }
    }
    if (schedule.freeFloat[i] !== expectedFree) {
      push(
        'FF 独立重算',
        `#${String(i)}: 实现 ${String(schedule.freeFloat[i])} ≠ 重算 ${String(expectedFree)}`,
      );
    }
  }

  let criticalCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (schedule.critical[i] === 1) {
      criticalCount += 1;
    }
  }
  // 「关键路径非空」只在**纯 FS 图**上成立：SS/FF/SF 混合时可能出现
  // "完成最晚的任务不是任何终端的祖先"（例如并行链用 SS 与长任务相连），此时所有任务的
  // 总浮动都 > 0，关键集合为空——这是数学事实，不是缺陷。见结论 §五.3。
  if (criticalCount === 0 && isFsOnly(graph)) {
    push('关键任务非空（纯 FS 图）', '纯 FS 图上没有任何 totalFloat === 0 的任务');
  }
  return violations;
}

/** 图是否只含 FS 关系（关键路径"浮动为 0"的经典前提）。 */
export function isFsOnly(graph: Graph): boolean {
  for (let k = 0; k < graph.linkCount; k += 1) {
    if (graph.succType[k] !== 0) {
      return false;
    }
  }
  return true;
}

export interface InvariantSummary {
  readonly graphs: number;
  readonly violations: readonly InvariantViolation[];
  readonly byInvariant: readonly { invariant: string; count: number }[];
  /** 发现（非违规）：关系类型混合时"关键集合为空"的图数量。 */
  readonly emptyCriticalOnMixedGraphs: number;
}

/** 在 `INVARIANT_CONFIG.graphs` 张随机图上跑全部不变量。 */
export function runInvariants(): InvariantSummary {
  const violations: InvariantViolation[] = [];
  const counts = new Map<string, number>();
  let graphs = 0;
  let emptyCriticalOnMixedGraphs = 0;
  for (let index = 0; index < INVARIANT_CONFIG.graphs; index += 1) {
    const span = INVARIANT_CONFIG.maxTasks - INVARIANT_CONFIG.minTasks + 1;
    const taskCount = INVARIANT_CONFIG.minTasks + (index % span);
    const dataset = generateDataset({
      id: `inv-${String(index)}`,
      kind: 'random-dag',
      taskCount,
      linkCount: Math.max(taskCount - 1, Math.floor(taskCount * 1.5)),
      seed: INVARIANT_CONFIG.seedBase + index,
      maxDuration: 8,
      maxLag: 3,
      milestoneRatio: 0.05,
    });
    const result = computeSchedule({
      taskCount: dataset.taskCount,
      durations: Array.from(dataset.durations),
      links: dataset.links,
      calendar: CAL_DEFAULT,
      baseDay: dataset.baseDay,
    });
    if (result.schedule === null) {
      const key = '随机图不应成环';
      violations.push({ datasetId: dataset.id, invariant: key, detail: '成环' });
      counts.set(key, (counts.get(key) ?? 0) + 1);
      continue;
    }
    graphs += 1;
    const found = checkInvariants(
      dataset.id,
      result.graph,
      Int32Array.from(dataset.durations),
      result.schedule,
    );
    for (const violation of found) {
      counts.set(violation.invariant, (counts.get(violation.invariant) ?? 0) + 1);
      if (violations.length < 40) {
        violations.push(violation);
      }
    }
    let criticalCount = 0;
    for (let i = 0; i < dataset.taskCount; i += 1) {
      if (result.schedule.critical[i] === 1) {
        criticalCount += 1;
      }
    }
    if (criticalCount === 0 && !isFsOnly(result.graph)) {
      emptyCriticalOnMixedGraphs += 1;
    }
  }
  return {
    graphs,
    violations,
    byInvariant: [...counts.entries()]
      .map(([invariant, count]) => ({ invariant, count }))
      .sort((a, b) => a.invariant.localeCompare(b.invariant)),
    emptyCriticalOnMixedGraphs,
  };
}

export interface EngineProbe {
  readonly checks: readonly Check[];
  readonly equivalenceSamples: number;
  readonly measurements: readonly MeasureResult[];
}

/** 与主干 `packages/engine/src/date.ts` 的语义等价性 + 常数因子对照。 */
export function runEngineProbe(resolutionNs: number): EngineProbe {
  const checks: Check[] = [];
  const calendar = createCalendar('indexed', CAL_DEFAULT, PROJECT_START_DAY, 4000);

  const sampleCount = 400;
  let isoMismatch = 0;
  let countMismatch = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const offsetA = (i * 7) % 1400;
    const offsetB = offsetA + 1 + ((i * 13) % 200);
    const dayA = PROJECT_START_DAY + offsetA;
    const dayB = PROJECT_START_DAY + offsetB;
    const isoA = dayNumberToIso(dayA);
    const isoB = dayNumberToIso(dayB);
    if (isoToDayNumber(isoA) !== parseIsoDate(isoA) / 86_400_000) {
      isoMismatch += 1;
    }
    if (calendar.workdaysBetween(dayA, dayB) !== countWorkdays(isoA, isoB)) {
      countMismatch += 1;
    }
  }
  checks.push({
    name: 'engine/iso-parse-equivalence',
    passed: isoMismatch === 0,
    detail: `${String(sampleCount)} 个日期样本，不一致 ${String(isoMismatch)} 个`,
  });
  checks.push({
    name: 'engine/workdays-between-equivalence',
    passed: countMismatch === 0,
    detail: `${String(sampleCount)} 个区间样本（Mon–Fri 口径），不一致 ${String(countMismatch)} 个`,
  });

  const workload = 200;
  const dayPairs: number[][] = [];
  for (let i = 0; i < workload; i += 1) {
    const offsetA = (i * 7) % 1400;
    dayPairs.push([
      PROJECT_START_DAY + offsetA,
      PROJECT_START_DAY + offsetA + 1 + ((i * 13) % 200),
    ]);
  }
  const options = { warmup: 20, iterations: 200, suites: 3, resolutionNs };
  const indexedMeasurement = measure(
    'calendar-indexed.workdaysBetween ×200',
    (): void => {
      for (const [dayA, dayB] of dayPairs) {
        calendar.workdaysBetween(dayA!, dayB!);
      }
    },
    options,
  );
  const engineMeasurement = measure(
    'engine.countWorkdays ×200',
    (): void => {
      for (const [dayA, dayB] of dayPairs) {
        countWorkdays(dayNumberToIso(dayA!), dayNumberToIso(dayB!));
      }
    },
    options,
  );

  return { checks, equivalenceSamples: sampleCount, measurements: [indexedMeasurement, engineMeasurement] };
}

export interface NegativeControlOutcome {
  readonly id: string;
  readonly description: string;
  readonly detected: boolean;
  readonly detail: string;
}

/**
 * 正确性侧负向对照：把判据"打坏"（改期望值 / 改语义 / 篡改结果），判定集必须报出。
 * 这一层证明 L1 判定不是恒真式。
 */
export function runCorrectnessNegativeControls(): NegativeControlOutcome[] {
  const outcomes: NegativeControlOutcome[] = [];

  const c1 = HAND_CASES.find((item) => item.id === 'C1-fs-chain-cross-weekend')!;
  const mutatedC1: HandCase = { ...c1, expected: { ...c1.expected!, ef: [3, 6, 12] } };
  const c1Outcome = evaluateHandCase(mutatedC1);
  outcomes.push({
    id: 'NC-C1',
    description: '把 C1 的 ef[1] 期望值从 5 改成 6',
    detected: c1Outcome.checks.some((check) => !check.passed),
    detail: c1Outcome.checks
      .filter((check) => !check.passed)
      .map((check) => check.name)
      .join(', '),
  });

  const c3 = HAND_CASES.find((item) => item.id === 'C3-ss-relation')!;
  const mutatedC3: HandCase = {
    ...c3,
    links: c3.links.map((link, index) => (index === 0 ? { ...link, type: 0 as const } : link)),
  };
  const c3Outcome = evaluateHandCase(mutatedC3);
  outcomes.push({
    id: 'NC-C2',
    description: '把 C3 的第 1 条 SS 依赖改成 FS（期望值不变）',
    detected: c3Outcome.checks.some((check) => !check.passed),
    detail: c3Outcome.checks
      .filter((check) => !check.passed)
      .map((check) => check.name)
      .join(', '),
  });

  const dataset = generateDataset({
    id: 'nc-c3',
    kind: 'random-dag',
    taskCount: 40,
    linkCount: 60,
    seed: 424_242,
    maxDuration: 6,
    maxLag: 2,
  });
  const result = computeSchedule({
    taskCount: dataset.taskCount,
    durations: Array.from(dataset.durations),
    links: dataset.links,
    calendar: CAL_DEFAULT,
    baseDay: dataset.baseDay,
  });
  let detected = false;
  let detail = '';
  if (result.schedule !== null) {
    const victim = Math.floor(dataset.taskCount / 2);
    result.schedule.es[victim] = result.schedule.es[victim]! + 1;
    const violations = checkInvariants(
      'nc-c3',
      result.graph,
      Int32Array.from(dataset.durations),
      result.schedule,
    );
    detected = violations.length > 0;
    detail = violations
      .slice(0, 3)
      .map((violation) => `${violation.invariant} @ ${violation.detail}`)
      .join('；');
  }
  outcomes.push({ id: 'NC-C3', description: '把某任务的 ES 手工加 1 个工作日', detected, detail });

  return outcomes;
}
