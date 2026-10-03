import { describe, expect, it } from 'vitest';

import { addDays, isoToDayNumber, type Calendar } from './date.js';
import { type DocumentLink, type ProjectDocument } from './schema.js';
import { summaryTaskIds } from './wbs.js';
import { LEAF_SENTINEL, compute, type Schedule, type ScheduleResult, type SessionAnchor } from './schedule.js';
import { generateProject, makeCalendar } from './scheduleFixtures.spec.js';

/**
 * **独立的不变量检查器**（测试侧手段，故意写成 `*.spec.ts` 以便被其他 spec import）。
 *
 * 它与内核**不共享实现**：
 * - 工期用**逐日循环 + `Calendar.isWorkday`** 重算（内核用 `workdaysBetween` 的索引前缀和）；
 * - 汇总值用**每个叶子向上走父链**重算（内核用逆文档序一遍累加）；
 * - 边界方程、`anchored`/`driven`、诊断条数按 SCHEDULE.md 的定义独立判定。
 *
 * 因此它同时是"逐日 vs 索引"与"父链 vs 逆序累加"两组互证（S3 结论 §三.1 的手法）。
 * **它不是恒真式**：`schedule.contract.spec.ts` 里有一条负向对照——手工篡改排程结果后，
 * 本检查器必须报出违规。
 */

export interface InvariantViolation {
  readonly rule: string;
  readonly detail: string;
}

function countWorkdaysLoop(calendar: Calendar, startDay: number, endDayExclusive: number): number {
  let count = 0;
  for (let day = startDay; day < endDayExclusive; day = addDays(day, 1)) {
    if (calendar.isWorkday(day)) {
      count += 1;
    }
  }
  return count;
}

function clampedDay(calendar: Calendar, day: number): number {
  return day < calendar.baseDay ? calendar.baseDay : day;
}

function isSummaryId(summaryIds: ReadonlySet<string>, id: string): boolean {
  return summaryIds.has(id);
}

/** 有效入边 = 任一端点都不是汇总任务的边（SCHEDULE.md §四.6）。 */
function hasEffectiveInEdge(links: readonly DocumentLink[], summaryIds: ReadonlySet<string>, taskId: string): boolean {
  return links.some(
    (link) =>
      link.to === taskId && !isSummaryId(summaryIds, link.from) && !isSummaryId(summaryIds, link.to),
  );
}

export function checkScheduleInvariants(
  document: ProjectDocument,
  calendar: Calendar,
  result: ScheduleResult,
  anchors: readonly SessionAnchor[] = [],
): readonly InvariantViolation[] {
  if (!result.ok) {
    // 成环时不产出排程，没有任何可检查的不变量（成环判定由 cycles spec 覆盖）。
    return [];
  }
  const violations: InvariantViolation[] = [];
  const push = (rule: string, detail: string): void => {
    violations.push({ rule, detail });
  };

  const schedule: Schedule = result.schedule;
  const tasks = document.tasks;
  const n = tasks.length;
  const byId = new Map(tasks.map((task, index) => [task.id, index]));
  const summaryIds = summaryTaskIds(tasks);

  if (schedule.taskCount !== n) {
    push('taskCount', `Schedule.taskCount=${String(schedule.taskCount)} 与 tasks.length=${String(n)} 不一致`);
    return violations; // 后续检查都按索引，直接停
  }
  for (const [name, array] of [
    ['es', schedule.es],
    ['ef', schedule.ef],
    ['anchored', schedule.anchored],
    ['driven', schedule.driven],
    ['summaryEs', schedule.summaryEs],
    ['summaryEf', schedule.summaryEf],
    ['summaryProgress', schedule.summaryProgress],
  ] as const) {
    if (array.length !== n) {
      push('array-length', `${name}.length=${String(array.length)} 与 taskCount=${String(n)} 不一致`);
    }
  }

  // —— 会话锚点（有效者 = 存在 + 叶子 + 有限整数序号；重复后者胜）——
  const anchorByIndex = new Map<number, number>();
  for (const anchor of anchors) {
    const index = byId.get(anchor.taskId);
    if (index === undefined) {
      continue;
    }
    if (summaryIds.has(anchor.taskId)) {
      continue;
    }
    if (!Number.isFinite(anchor.startOrdinal) || !Number.isInteger(anchor.startOrdinal)) {
      continue;
    }
    anchorByIndex.set(index, anchor.startOrdinal);
  }

  // —— 独立重算工期（逐日循环，且早于 baseDay 的日期归一到 baseDay）——
  const durations = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (summaryIds.has(task.id)) {
      continue;
    }
    if (task.durationDays !== null) {
      durations[i] = task.durationDays;
    } else if (task.startDate !== null && task.endDate !== null) {
      durations[i] = countWorkdaysLoop(
        calendar,
        clampedDay(calendar, isoToDayNumber(task.startDate)),
        clampedDay(calendar, isoToDayNumber(task.endDate)),
      );
    }
  }

  let computedFinish = schedule.projectStart;
  let milestoneCount = 0;
  let clampedDiagnostics = 0;
  let dateOverriddenDiagnostics = 0;
  let undatedDiagnostics = 0;
  for (const diagnostic of schedule.diagnostics) {
    if (diagnostic.code === 'clampedStart') {
      clampedDiagnostics += 1;
    }
    if (diagnostic.code === 'dateOverridden') {
      dateOverriddenDiagnostics += 1;
    }
    if (diagnostic.code === 'undated') {
      undatedDiagnostics += 1;
    }
  }

  let drivenCount = 0;
  let undatedCount = 0;
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    const isSummary = summaryIds.has(task.id);
    if (isSummary) {
      if (schedule.es[i] !== LEAF_SENTINEL || schedule.ef[i] !== LEAF_SENTINEL) {
        push('summary-sentinel', `汇总行 ${task.id} 的 es/ef 必须是 ${String(LEAF_SENTINEL)}`);
      }
      if (schedule.anchored[i] !== 0 || schedule.driven[i] !== 0) {
        push('summary-flags', `汇总行 ${task.id} 的 anchored/driven 必须为 0`);
      }
      if (schedule.summaryEs[i] === LEAF_SENTINEL || schedule.summaryEf[i] === LEAF_SENTINEL) {
        push('summary-aggregate', `汇总行 ${task.id} 缺少聚合值`);
      }
      continue;
    }

    if (schedule.summaryEs[i] !== LEAF_SENTINEL || schedule.summaryEf[i] !== LEAF_SENTINEL) {
      push('leaf-sentinel', `叶子行 ${task.id} 的 summaryEs/summaryEf 必须是 ${String(LEAF_SENTINEL)}`);
    }
    if (schedule.summaryProgress[i] !== LEAF_SENTINEL) {
      push('leaf-sentinel', `叶子行 ${task.id} 的 summaryProgress 必须是 ${String(LEAF_SENTINEL)}`);
    }

    const es = schedule.es[i]!;
    const ef = schedule.ef[i]!;
    if (ef !== es + durations[i]!) {
      push('ef', `${task.id}: ef=${String(ef)} ≠ es=${String(es)} + 工期=${String(durations[i]!)}`);
    }
    if (es < schedule.projectStart) {
      push('floor', `${task.id}: es=${String(es)} 小于项目起点 ${String(schedule.projectStart)}`);
    }
    if (es < 0) {
      push('negative', `${task.id}: 出现负序号 ${String(es)}`);
    }
    if (ef > computedFinish) {
      computedFinish = ef;
    }
    if (task.milestone || task.durationDays === 0) {
      milestoneCount += 1;
    }

    const hasPredecessor = hasEffectiveInEdge(document.links, summaryIds, task.id);
    const anchor = anchorByIndex.get(i);
    if (!hasPredecessor || anchor !== undefined) {
      if (schedule.anchored[i] !== 1) {
        push('anchored', `${task.id}: 应 anchored=1（无有效入边或有会话锚点）`);
      }
    } else if (schedule.anchored[i] !== 0) {
      push('anchored', `${task.id}: 应 anchored=0（有有效入边且无会话锚点）`);
    }

    const startOrdinal =
      task.startDate === null
        ? null
        : (calendar.ordinalOfDay(clampedDay(calendar, isoToDayNumber(task.startDate))) as number);
    const expectDriven = hasPredecessor && anchor === undefined && startOrdinal !== null && startOrdinal !== es;
    if (expectDriven) {
      drivenCount += 1;
      if (schedule.driven[i] !== 1) {
        push('driven', `${task.id}: 文档日期被推导覆盖，应 driven=1`);
      }
    } else if (schedule.driven[i] !== 0) {
      push('driven', `${task.id}: 不应 driven=1`);
    }

    if (!hasPredecessor && anchor === undefined) {
      const expectedStart = startOrdinal === null ? schedule.projectStart : Math.max(startOrdinal, schedule.projectStart);
      if (es !== expectedStart) {
        push('anchor-rule', `${task.id}: 情形①②的 es=${String(es)}，应为 ${String(expectedStart)}`);
      }
      if (startOrdinal === null) {
        undatedCount += 1;
      }
    }
  }

  if (computedFinish !== schedule.projectFinish) {
    push('projectFinish', `projectFinish=${String(schedule.projectFinish)}，按 max(ef) 应为 ${String(computedFinish)}`);
  }
  if (milestoneCount !== schedule.milestoneCount) {
    push('milestoneCount', `milestoneCount=${String(schedule.milestoneCount)}，应为 ${String(milestoneCount)}`);
  }
  if (clampedDiagnostics !== schedule.clampedStarts) {
    push(
      'clampedStarts',
      `clampedStarts=${String(schedule.clampedStarts)}，与 clampedStart 诊断条数 ${String(clampedDiagnostics)} 不一致`,
    );
  }
  if (dateOverriddenDiagnostics !== drivenCount) {
    push(
      'dateOverridden',
      `dateOverridden 诊断 ${String(dateOverriddenDiagnostics)} 条，与 driven=1 的行数 ${String(drivenCount)} 不一致`,
    );
  }
  if (undatedDiagnostics !== undatedCount) {
    push('undated', `undated 诊断 ${String(undatedDiagnostics)} 条，应为 ${String(undatedCount)} 条`);
  }

  // —— 边界方程（仅叶子—叶子的边）——
  for (const link of document.links) {
    const fi = byId.get(link.from);
    const ti = byId.get(link.to);
    if (fi === undefined || ti === undefined) {
      continue;
    }
    if (summaryIds.has(link.from) || summaryIds.has(link.to)) {
      continue;
    }
    const predEs = schedule.es[fi]!;
    const predEf = schedule.ef[fi]!;
    const succEs = schedule.es[ti]!;
    const succEf = schedule.ef[ti]!;
    const succDuration = durations[ti]!;
    let ok: boolean;
    switch (link.type) {
      case 'FS':
        ok = succEs >= predEf + link.lagDays;
        break;
      case 'SS':
        ok = succEs >= predEs + link.lagDays;
        break;
      case 'FF':
        ok = succEf >= predEf + link.lagDays;
        break;
      default:
        ok = succEf >= predEs + link.lagDays;
        break;
    }
    if (!ok) {
      push(
        'boundary',
        `${link.from} -${link.type}(${String(link.lagDays)})-> ${link.to} 不满足前向边界方程` +
          `（pred es/ef=${String(predEs)}/${String(predEf)}，succ es/ef=${String(succEs)}/${String(succEf)}，succ 工期=${String(succDuration)}）`,
      );
    }
  }

  // —— 汇总聚合：每个叶子沿父链向上累加（独立于内核的逆序一遍）——
  const aggMin = new Map<string, number>();
  const aggMax = new Map<string, number>();
  const weight = new Map<string, number>();
  const weighted = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (summaryIds.has(task.id)) {
      continue;
    }
    let current: string | null = task.parentId;
    const es = schedule.es[i]!;
    const ef = schedule.ef[i]!;
    const duration = durations[i]!;
    const progress = task.progress ?? 0;
    while (current !== null) {
      const previousMin = aggMin.get(current);
      if (previousMin === undefined || es < previousMin) {
        aggMin.set(current, es);
      }
      const previousMax = aggMax.get(current);
      if (previousMax === undefined || ef > previousMax) {
        aggMax.set(current, ef);
      }
      weight.set(current, (weight.get(current) ?? 0) + duration);
      weighted.set(current, (weighted.get(current) ?? 0) + duration * progress);
      const parentIndex = byId.get(current);
      if (parentIndex === undefined) {
        break;
      }
      current = tasks[parentIndex]!.parentId;
    }
  }
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (!summaryIds.has(task.id)) {
      continue;
    }
    if (schedule.summaryEs[i] !== (aggMin.get(task.id) ?? LEAF_SENTINEL)) {
      push('summaryEs', `${task.id}: summaryEs=${String(schedule.summaryEs[i]!)}，独立重算为 ${String(aggMin.get(task.id) ?? LEAF_SENTINEL)}`);
    }
    if (schedule.summaryEf[i] !== (aggMax.get(task.id) ?? LEAF_SENTINEL)) {
      push('summaryEf', `${task.id}: summaryEf=${String(schedule.summaryEf[i]!)}，独立重算为 ${String(aggMax.get(task.id) ?? LEAF_SENTINEL)}`);
    }
    const total = weight.get(task.id) ?? 0;
    const expected = total > 0 ? (weighted.get(task.id) ?? 0) / total : Number.NaN;
    const actual = schedule.summaryProgress[i]!;
    if (Number.isNaN(expected)) {
      if (!Number.isNaN(actual)) {
        push('summaryProgress', `${task.id}: 权重和为 0，应为 NaN，实际 ${String(actual)}`);
      }
    } else if (Math.abs(expected - actual) > 1e-9) {
      push('summaryProgress', `${task.id}: summaryProgress=${String(actual)}，独立重算为 ${String(expected)}`);
    }
  }

  return violations;
}

/**
 * 手工篡改排程结果（**负向对照**用）：返回一个各项数值被改动的副本。
 * 检查器必须能对它报出违规，否则"不变量全过"就是恒真式。
 */
export function tamperSchedule(schedule: Schedule): Schedule {
  const es = schedule.es.slice();
  const ef = schedule.ef.slice();
  // 打坏三条不同类别的不变量：叶子 es（连带 ef）、汇总聚合、截断计数。
  for (let i = 0; i < es.length; i += 1) {
    if (es[i] !== LEAF_SENTINEL) {
      es[i] = es[i]! + 7;
      break;
    }
  }
  for (let i = 0; i < schedule.summaryEs.length; i += 1) {
    if (schedule.summaryEs[i] !== LEAF_SENTINEL) {
      ef[i] = ef[i]! + 3;
      break;
    }
  }
  return {
    ...schedule,
    es,
    ef,
    summaryEf: schedule.summaryEf.slice().fill(LEAF_SENTINEL),
    summaryProgress: schedule.summaryProgress.slice().fill(LEAF_SENTINEL),
    clampedStarts: schedule.clampedStarts + 5,
  };
}

describe('不变量检查器自检', () => {
  it('对合法排程零违规、对篡改结果必有违规（不是恒真式）', () => {
    const project = generateProject({ id: 'checker', seed: 31_337, taskCount: 30, linkCount: 44 });
    const calendar = makeCalendar(project);
    const result = compute(project.document, calendar, project.anchors);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(checkScheduleInvariants(project.document, calendar, result, project.anchors)).toStrictEqual([]);

    const tampered = { ok: true as const, schedule: tamperSchedule(result.schedule) };
    const violations = checkScheduleInvariants(project.document, calendar, tampered, project.anchors);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.rule)).toContain('clampedStarts');

    // 成环结果没有可检查的不变量（不产出排程）。
    const cyclic = compute(
      { ...project.document, links: [...project.document.links, { id: 'cx', from: 't1', to: 't1', type: 'FS', lagDays: 0 }] },
      calendar,
    );
    expect(cyclic.ok).toBe(false);
    expect(checkScheduleInvariants(project.document, calendar, cyclic, project.anchors)).toStrictEqual([]);
  });
});
