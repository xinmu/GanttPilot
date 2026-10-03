import { describe, expect, it } from 'vitest';

import { Calendar, addDays, dayNumberToIso, isoToDayNumber } from './date.js';
import { type ProjectDocument } from './schema.js';
import { LEAF_SENTINEL, compute, type ScheduleResult, type SessionAnchor } from './schedule.js';
import {
  SCHEDULE_BASE_DAY,
  SCHEDULE_CALENDARS,
  fixtureDocument,
  fixtureTask,
  generateProject,
  makeCalendar,
} from './scheduleFixtures.spec.js';
import { checkScheduleInvariants } from './scheduleInvariants.spec.js';

/**
 * **手工推导用例表**（ADR 0004 §9 第二层证据）。
 *
 * 期望值全部由人工推导后写在这里，**内核无权修改基准**；覆盖面按出口条件要求：
 * 4 类关系 × lag（正/负/0）× 跨层级 × 日历例外 × 无日期节点 × 汇总端点 × 里程碑 × 锚点四情形。
 *
 * 每个用例都**同时**跑一遍独立的不变量检查器（`checkScheduleInvariants`），
 * 因此"声明的期望值"与"结构性不变量"是两套互相独立的判据。
 *
 * 坐标约定：`baseDay` 默认 2026-10-05（周一）；序号 0 就是这一天（周内工作制下），
 * 因此 `es = k` ⇔ ISO 上从 2026-10-05 起数第 k+1 个工作日。
 */

type Ordinal = number | null; // null = LEAF_SENTINEL（汇总任务）

interface IsoCheck {
  readonly index: number;
  readonly which: 'es' | 'ef';
  readonly iso: string;
}

interface ManualCase {
  readonly name: string;
  readonly doc: ProjectDocument;
  readonly calendarIndex?: number;
  readonly baseDayIso?: string;
  readonly anchors?: readonly SessionAnchor[];
  readonly es: readonly Ordinal[];
  readonly ef: readonly Ordinal[];
  readonly anchored?: readonly number[];
  readonly driven?: readonly number[];
  readonly summaryEs?: readonly Ordinal[];
  readonly summaryEf?: readonly Ordinal[];
  readonly summaryProgress?: readonly Ordinal[];
  readonly projectStart?: number;
  readonly projectFinish?: number;
  readonly milestoneCount?: number;
  readonly clampedStarts?: number;
  /** 排序后的 `code:taskId`（诊断顺序不在契约里）。 */
  readonly diagnostics?: readonly string[];
  readonly iso?: readonly IsoCheck[];
}

function summarizeDiagnostics(result: ScheduleResult): string[] {
  if (!result.ok) {
    return result.cyclePath.map((id) => `cycle:${id}`);
  }
  return result.schedule.diagnostics
    .map((entry) => `${entry.code}:${entry.taskId ?? entry.linkId ?? ''}`)
    .sort();
}

function toSigned(value: Ordinal): number {
  return value === null ? LEAF_SENTINEL : value;
}

const CASES: readonly ManualCase[] = [
  {
    // 跨层级（顶层叶子 → 嵌套两层深的叶子）+ FS 0/+2 lag + 0 工期里程碑。
    name: '① FS 链（跨层级 + lag 0/+2）+ 里程碑参与传播',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-10-05', endDate: '2026-10-08', durationDays: 3 }),
        fixtureTask({ id: 's', name: '阶段' }),
        fixtureTask({ id: 'b', parentId: 's', durationDays: 2 }),
        fixtureTask({ id: 'c', parentId: 's', durationDays: 1 }),
        fixtureTask({ id: 'm', milestone: true, durationDays: 0 }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'b', to: 'c', type: 'FS', lagDays: 2 },
        { id: 'l3', from: 'a', to: 'm', type: 'FS', lagDays: 0 },
      ],
      '2026-10-05',
    ),
    // a: 情形①（锚在 0）→ 0..3；b: 3..5；c: 5+2=7..8；m: 3..3；s 是汇总行。
    // 汇总只聚合**自己的子树**（b/c/m），不含顶层兄弟 a ⇒ summaryEs = min(3,7,3) = 3。
    es: [0, null, 3, 7, 3],
    ef: [3, null, 5, 8, 3],
    anchored: [1, 0, 0, 0, 0],
    driven: [0, 0, 0, 0, 0],
    summaryEs: [null, 3, null, null, null],
    summaryEf: [null, 8, null, null, null],
    projectStart: 0,
    projectFinish: 8,
    milestoneCount: 1,
    clampedStarts: 0,
    diagnostics: [],
    iso: [
      { index: 0, which: 'es', iso: '2026-10-05' },
      { index: 3, which: 'es', iso: '2026-10-14' }, // 序号 7：10-05 起第 8 个工作日（中间跨了周末）
      { index: 4, which: 'ef', iso: '2026-10-08' }, // 序号 3
    ],
  },
  {
    // 4 类关系：SS +3、FF +2、SF +5 各自的边界方程。
    name: '② SS/FF/SF 的正向边界（lag 正）',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-10-05', durationDays: 4 }),
        fixtureTask({ id: 'b', durationDays: 2 }),
        fixtureTask({ id: 'c', durationDays: 3 }),
        fixtureTask({ id: 'd', durationDays: 1 }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'SS', lagDays: 3 },
        { id: 'l2', from: 'a', to: 'c', type: 'FF', lagDays: 2 },
        { id: 'l3', from: 'a', to: 'd', type: 'SF', lagDays: 5 },
      ],
      '2026-10-05',
    ),
    // a: 0..4
    // b: SS → es ≥ 0+3 = 3 → 3..5
    // c: FF → ef ≥ 4+2 = 6 → es ≥ 6-3 = 3 → 3..6
    // d: SF → ef ≥ 0+5 = 5 → es ≥ 5-1 = 4 → 4..5
    es: [0, 3, 3, 4],
    ef: [4, 5, 6, 5],
    projectStart: 0,
    projectFinish: 6,
    clampedStarts: 0,
    diagnostics: [],
  },
  {
    // 负 lag 越到项目起点之前：截断 + 计数 + 诊断，不产出负序号（ADR 0004 §4）。
    name: '③ 负 lag 越界 ⇒ 截断到项目起点',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-10-12', durationDays: 2 }),
        fixtureTask({ id: 'b', durationDays: 1 }),
        fixtureTask({ id: 'c', durationDays: 1 }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: -3 },
        { id: 'l2', from: 'a', to: 'c', type: 'SS', lagDays: -10 },
      ],
      '2026-10-05',
    ),
    // a: 序号 5（10-12 是 baseDay 起第 6 个工作日）→ 5..7
    // b: FS -3 → es ≥ 7-3 = 4 → 4..5
    // c: SS -10 → es ≥ 5-10 = -5 → 截断到项目起点 0 → 0..1
    es: [5, 4, 0],
    ef: [7, 5, 1],
    projectStart: 0,
    projectFinish: 7,
    clampedStarts: 1,
    diagnostics: ['clampedStart:c'],
    iso: [
      { index: 0, which: 'es', iso: '2026-10-12' },
      { index: 2, which: 'es', iso: '2026-10-05' },
    ],
  },
  {
    // DM-05：无日期节点回落项目起点；已有日期被推导覆盖 ⇒ driven + dateOverridden。
    name: '④ 无日期节点容错 + 文档日期被推导覆盖',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', durationDays: 2 }),
        fixtureTask({ id: 'b', startDate: '2026-10-07', endDate: '2026-10-08', durationDays: 1 }),
      ],
      [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }],
      null,
    ),
    // 无 project.startDate ⇒ 项目起点 = 全部非空开始日期的最小序号 = ordinal(10-07) = 2。
    // a: 情形② → 2..4 + undated；b: 情形③ → es = max(ef_a) = 4（文档日期 2 被覆盖）→ 4..5。
    es: [2, 4],
    ef: [4, 5],
    anchored: [1, 0],
    driven: [0, 1],
    projectStart: 2,
    projectFinish: 5,
    clampedStarts: 0,
    diagnostics: ['dateOverridden:b', 'undated:a'],
    iso: [
      { index: 0, which: 'es', iso: '2026-10-07' },
      { index: 1, which: 'ef', iso: '2026-10-12' },
    ],
  },
  {
    // 日历例外真的参与算术：整周放假把序号 5 从 10-12 推到 10-19。
    name: '⑤ 日历例外（整周放假）参与算术',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-10-05', durationDays: 5 }),
        fixtureTask({ id: 'b', milestone: true, durationDays: 0 }),
      ],
      [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }],
      '2026-10-05',
    ),
    calendarIndex: 1,
    es: [0, 5],
    ef: [5, 5],
    projectFinish: 5,
    milestoneCount: 1,
    diagnostics: [],
    iso: [
      { index: 0, which: 'ef', iso: '2026-10-19' }, // 10-12 那一周整周放假
      { index: 1, which: 'es', iso: '2026-10-19' },
    ],
  },
  {
    // 六天工作周（周一至周六）+ 周日补班：序号 5 = 周六 10-10，序号 6 = 周日 10-11（补班），序号 7 = 周一 10-12。
    name: '⑤b 日历例外（六天工作周 + 周日补班）参与算术',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-10-05', durationDays: 7 }),
        fixtureTask({ id: 'b', durationDays: 1 }),
      ],
      [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }],
      '2026-10-05',
    ),
    calendarIndex: 2,
    es: [0, 7],
    ef: [7, 8],
    iso: [
      { index: 0, which: 'ef', iso: '2026-10-12' }, // 序号 7 = 10-12（周一）
      { index: 1, which: 'es', iso: '2026-10-12' },
    ],
  },
  {
    // 汇总端点边在传播中被忽略（等同不存在），汇总值由引擎聚合，里程碑照常参与。
    name: '⑥ 汇总端点边被忽略 + 汇总聚合 + 里程碑',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'w1', name: '阶段' }),
        fixtureTask({ id: 'a', parentId: 'w1', startDate: '2026-10-05', durationDays: 2, progress: 0.25 }),
        fixtureTask({ id: 'b', parentId: 'w1', durationDays: 2 }),
        fixtureTask({ id: 'm', parentId: 'w1', milestone: true, durationDays: 0 }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'b', to: 'w1', type: 'FS', lagDays: 0 },
        { id: 'l3', from: 'a', to: 'w1', type: 'FS', lagDays: 0 },
      ],
      '2026-10-05',
    ),
    // a: 0..2；b: 2..4；m: 无日期无有效入边 → 项目起点 0..0。
    // 汇总：summaryEs = min(0,2,0) = 0；summaryEf = max(2,4,0) = 4；
    // summaryProgress = (2×0.25 + 2×0 + 0×0) / (2+2+0) = 0.5/4 = 0.125。
    es: [null, 0, 2, 0],
    ef: [null, 2, 4, 0],
    summaryEs: [0, null, null, null],
    summaryEf: [4, null, null, null],
    summaryProgress: [0.125, null, null, null],
    projectStart: 0,
    projectFinish: 4,
    milestoneCount: 1,
    diagnostics: ['summaryIgnored:l2', 'summaryIgnored:l3', 'undated:m'],
  },
  {
    // 锚点四情形：①（文档日期）②（项目起点）③（入边推导）④（会话锚点）。
    name: '⑦ 锚点四情形 + 会话锚点健壮性',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-10-05', durationDays: 2 }),
        fixtureTask({ id: 'b', durationDays: 1 }),
        fixtureTask({ id: 'c', durationDays: 1 }),
        fixtureTask({ id: 'd', durationDays: 1 }),
        fixtureTask({ id: 'e', durationDays: 1 }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'a', to: 'd', type: 'FS', lagDays: 0 },
        { id: 'l3', from: 'a', to: 'e', type: 'FS', lagDays: 0 },
      ],
      '2026-10-05',
    ),
    anchors: [
      { taskId: 'a', startOrdinal: 4 },
      { taskId: 'b', startOrdinal: 1 },
      { taskId: 'd', startOrdinal: 10 },
      { taskId: 'ghost', startOrdinal: 3 },
    ],
    // a: 情形④ → max(4) = 4（文档日期 0 被覆盖，但情形④不设 driven）→ 4..6
    // b: 情形④ → max(1, ef_a=6) = 6；锚定更早 ⇒ anchorConflict → 6..7
    // c: 情形② → 项目起点 0..1 + undated
    // d: 情形④ → max(10, 6) = 10 → 10..11
    // e: 情形③ → 6..7（无日期 ⇒ 无 dateOverridden）
    es: [4, 6, 0, 10, 6],
    ef: [6, 7, 1, 11, 7],
    anchored: [1, 1, 1, 1, 0],
    driven: [0, 0, 0, 0, 0],
    projectStart: 0,
    projectFinish: 11,
    clampedStarts: 0,
    diagnostics: ['anchorConflict:b', 'anchorUnknown:ghost', 'undated:c'],
  },
  {
    // 文档级一致性诊断：endDate 与工期不一致（且对汇总任务同样判定）。
    name: '⑧ endDateStale 与留位字段诊断（含汇总任务）',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'w1', name: '阶段', startDate: '2026-10-05', endDate: '2026-10-06', durationDays: 3 }),
        fixtureTask({
          id: 'a',
          parentId: 'w1',
          startDate: '2026-10-05',
          endDate: '2026-10-06',
          durationDays: 3,
          constraints: [{ kind: 'startNoEarlierThan', date: '2026-10-05' }],
        }),
        fixtureTask({
          id: 'b',
          parentId: 'w1',
          startDate: '2026-10-05',
          endDate: '2026-10-09',
          durationDays: 4,
          manual: true,
        }),
      ],
    ),
    // a: 工期字段优先（3）→ 0..3；b: 4 → 0..4。workdaysBetween(10-05, 10-06) = 1 ≠ 3 ⇒ 两条 endDateStale。
    es: [null, 0, 0],
    ef: [null, 3, 4],
    summaryEs: [0, null, null],
    summaryEf: [4, null, null],
    projectStart: 0,
    projectFinish: 4,
    diagnostics: [
      'constraintsUnused:a',
      'constraintsUnused:b',
      'endDateStale:a',
      'endDateStale:w1',
    ],
    iso: [{ index: 1, which: 'ef', iso: '2026-10-08' }],
  },
  {
    // 跨年：2026-12-28（周一）起 5 个工作日 ⇒ 排他结束落在 2027-01-04（周一）。
    name: '⑨ 跨年边界的序号 ↔ 日期翻译',
    doc: fixtureDocument(
      [
        fixtureTask({ id: 'a', startDate: '2026-12-28', durationDays: 5 }),
        fixtureTask({ id: 'b', durationDays: 2 }),
      ],
      [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }],
      '2026-12-28',
    ),
    baseDayIso: '2026-12-28',
    projectStart: 0,
    projectFinish: 7,
    es: [0, 5],
    ef: [5, 7],
    diagnostics: [],
    iso: [
      { index: 0, which: 'es', iso: '2026-12-28' },
      { index: 0, which: 'ef', iso: '2027-01-04' },
      { index: 1, which: 'es', iso: '2027-01-04' },
      { index: 1, which: 'ef', iso: '2027-01-06' },
    ],
  },
];

function calendarFor(testCase: ManualCase): Calendar {
  const index = testCase.calendarIndex ?? 0;
  return new Calendar(SCHEDULE_CALENDARS[index]!, {
    baseDay: isoToDayNumber(testCase.baseDayIso ?? '2026-10-05'),
    spanDays: 20_000,
  });
}

describe('G2 手工推导用例（声明式期望值表）', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const calendar = calendarFor(testCase);
    const result = compute(testCase.doc, calendar, testCase.anchors ?? []);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const schedule = result.schedule;

    expect(Array.from(schedule.es, toSigned), 'es').toStrictEqual(testCase.es.map(toSigned));
    expect(Array.from(schedule.ef, toSigned), 'ef').toStrictEqual(testCase.ef.map(toSigned));
    if (testCase.anchored !== undefined) {
      expect(Array.from(schedule.anchored), 'anchored').toStrictEqual([...testCase.anchored]);
    }
    if (testCase.driven !== undefined) {
      expect(Array.from(schedule.driven), 'driven').toStrictEqual([...testCase.driven]);
    }
    if (testCase.summaryEs !== undefined) {
      expect(Array.from(schedule.summaryEs, toSigned), 'summaryEs').toStrictEqual(testCase.summaryEs.map(toSigned));
    }
    if (testCase.summaryEf !== undefined) {
      expect(Array.from(schedule.summaryEf, toSigned), 'summaryEf').toStrictEqual(testCase.summaryEf.map(toSigned));
    }
    if (testCase.summaryProgress !== undefined) {
      const actual = Array.from(schedule.summaryProgress, (value) => (value === LEAF_SENTINEL ? null : value));
      expect(actual, 'summaryProgress').toStrictEqual([...testCase.summaryProgress]);
    }
    if (testCase.projectStart !== undefined) {
      expect(schedule.projectStart, 'projectStart').toBe(testCase.projectStart);
    }
    if (testCase.projectFinish !== undefined) {
      expect(schedule.projectFinish, 'projectFinish').toBe(testCase.projectFinish);
    }
    if (testCase.milestoneCount !== undefined) {
      expect(schedule.milestoneCount, 'milestoneCount').toBe(testCase.milestoneCount);
    }
    if (testCase.clampedStarts !== undefined) {
      expect(schedule.clampedStarts, 'clampedStarts').toBe(testCase.clampedStarts);
    }
    if (testCase.diagnostics !== undefined) {
      expect(summarizeDiagnostics(result), 'diagnostics').toStrictEqual([...testCase.diagnostics].sort());
    }
    for (const check of testCase.iso ?? []) {
      const ordinal = check.which === 'es' ? schedule.es[check.index]! : schedule.ef[check.index]!;
      expect(calendar.isoOfOrdinal(ordinal), `${check.which}[${String(check.index)}]`).toBe(check.iso);
    }

    // 每个用例都跑一遍独立的不变量检查器（两套判据互证）。
    expect(checkScheduleInvariants(testCase.doc, calendar, result, testCase.anchors ?? [])).toStrictEqual([]);
  });
});

describe('G2 手工用例的负向对照（判据不是恒真式）', () => {
  it('把 FS 改成 SS 必须让结果改变（关系类型真的承重）', () => {
    const base = CASES[0]!;
    const calendar = calendarFor(base);
    const before = compute(base.doc, calendar);
    expect(before.ok).toBe(true);
    if (!before.ok) {
      return;
    }
    const mutated: ProjectDocument = {
      ...base.doc,
      links: base.doc.links.map((link) => (link.id === 'l1' ? { ...link, type: 'SS' as const } : link)),
    };
    const after = compute(mutated, calendar);
    expect(after.ok).toBe(true);
    if (!after.ok) {
      return;
    }
    expect(Array.from(after.schedule.es)).not.toStrictEqual(Array.from(before.schedule.es));
    // 并且**旧期望值**不再成立（说明期望值表确实在承重）。
    expect(Array.from(after.schedule.es, toSigned)).not.toStrictEqual(base.es.map(toSigned));
  });

  it('打坏期望值必须被检出：把 ① 的 ef 期望值改 1 会与实现不一致', () => {
    const testCase = CASES[0]!;
    const result = compute(testCase.doc, calendarFor(testCase));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const tampered = testCase.ef.map((value) => (value === null ? null : value + 1));
    expect(Array.from(result.schedule.ef, toSigned)).not.toStrictEqual(tampered);
  });
});

describe('G2 手工用例：负 lag 的日历例外组合（跨周）', () => {
  it('整周放假 + 负 lag 时仍然只截断到项目起点，不产出负序号（且这批数据确实触发了截断）', () => {
    let clampedSeen = 0;
    let checked = 0;
    for (let offset = 0; offset < 20; offset += 1) {
      const project = generateProject({
        id: `manual-exception-${String(offset)}`,
        seed: 20_261_005 + offset,
        taskCount: 12,
        linkCount: 16,
        maxLag: 3,
        calendarIndex: 1,
      });
      const calendar = makeCalendar(project);
      const result = compute(project.document, calendar, project.anchors);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      checked += 1;
      for (let i = 0; i < result.schedule.taskCount; i += 1) {
        if (result.schedule.es[i] === LEAF_SENTINEL) {
          continue;
        }
        expect(result.schedule.es[i]!).toBeGreaterThanOrEqual(result.schedule.projectStart);
        expect(result.schedule.es[i]!).toBeGreaterThanOrEqual(0);
      }
      expect(checkScheduleInvariants(project.document, calendar, result, project.anchors)).toStrictEqual([]);
      if (result.schedule.clampedStarts > 0) {
        clampedSeen += 1;
      }
    }
    // 20 个种子里必须出现过截断，否则上面的"不产出负序号"断言没有判别力。
    expect(checked).toBe(20);
    expect(clampedSeen).toBeGreaterThan(0);
    expect(dayNumberToIso(addDays(SCHEDULE_BASE_DAY, 0))).toBe('2026-10-05');
  });
});
