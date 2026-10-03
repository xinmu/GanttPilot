/**
 * **唯一声明处**：门禁阈值、数据集规格、测量参数、手工期望值表、差分契约、负向对照阈值。
 *
 * 纪律（照 S2 的口径）：判定基准是**声明式期望值表**，不是"内核的再次序列化"。
 * 手工用例的期望值是人工推导的（推导过程见 `结论.md`），内核与参照实现都无权修改它。
 */

import { isoToDayNumber } from './calendar.ts';
import type { DatasetKind, DatasetSpec } from './graph-gen.ts';
import { PROJECT_START_DAY, PROJECT_START_ISO } from './graph-gen.ts';
import { linkTypeOf, type CalendarSpec, type LinkSpec } from './model.ts';

export const SPIKE_ID = 'G0-S-S3';
export const SPIKE_TITLE = 'CPM 性能定标与拖拽 DoD 边界';

// ---------------------------------------------------------------- 日历口径

export const CAL_DEFAULT: CalendarSpec = {
  id: 'default-mon-fri',
  workDays: [1, 2, 3, 4, 5],
  exceptions: { nonWorking: [], working: [] },
};

/** 一周整周放假（周一至周五），用于验证 `exceptions` 真的参与算术。 */
const HOLIDAY_WEEK_START = PROJECT_START_DAY + 7; // 2026-10-12（周一）
export const CAL_HOLIDAY_WEEK: CalendarSpec = {
  id: 'mon-fri-one-week-holiday',
  workDays: [1, 2, 3, 4, 5],
  exceptions: {
    nonWorking: [
      HOLIDAY_WEEK_START,
      HOLIDAY_WEEK_START + 1,
      HOLIDAY_WEEK_START + 2,
      HOLIDAY_WEEK_START + 3,
      HOLIDAY_WEEK_START + 4,
    ],
    working: [],
  },
};

/** 周六上班（6 天工作周），用于验证 `workDays` 真的驱动算术。 */
export const CAL_SIX_DAY: CalendarSpec = {
  id: 'mon-sat',
  workDays: [1, 2, 3, 4, 5, 6],
  exceptions: { nonWorking: [], working: [] },
};

// ---------------------------------------------------------------- 门禁阈值

export const GATE_THRESHOLDS_MS = {
  /** G3-a：1,000 任务 / 1,500 依赖的全量重算 p99。 */
  fullRecompute: 100,
  /** G3-b：非关键编辑的**后继闭包正向传播** p99。 */
  localPropagation: 10,
  /** IX-04：松手后合并重算（含浮动/关键路径）p99。 */
  commitRecompute: 200,
} as const;

export const MEASUREMENT_QUANTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;

export interface MeasureConfig {
  readonly warmup: number;
  readonly iterations: number;
  readonly suites: number;
}

/** 门禁数据集（1,000 / 1,500）用的测量参数。 */
export const GATE_MEASURE: MeasureConfig = { warmup: 50, iterations: 1000, suites: 5 };
/** 非门禁观测点（2,000 / 3,000 与 5,000 / 7,500）与负向对照用的参数。 */
export const OBSERVATION_MEASURE: MeasureConfig = { warmup: 20, iterations: 100, suites: 3 };
export const NEGATIVE_CONTROL_MEASURE: MeasureConfig = { warmup: 5, iterations: 10, suites: 3 };

// ---------------------------------------------------------------- 数据集

export const GATE_DATASETS: readonly DatasetSpec[] = [
  {
    id: 'D1-wide-shallow',
    kind: 'wide-shallow' as DatasetKind,
    taskCount: 1000,
    linkCount: 1500,
    seed: 20261005,
    maxDuration: 10,
  },
  {
    id: 'D2-deep-chain',
    kind: 'deep-chain' as DatasetKind,
    taskCount: 1000,
    linkCount: 1500,
    seed: 20261006,
    maxDuration: 3,
  },
  {
    id: 'D3-dense-cross',
    kind: 'dense-cross' as DatasetKind,
    taskCount: 1000,
    linkCount: 1500,
    seed: 20261007,
    maxDuration: 20,
    milestoneRatio: 0.05,
  },
];

/** 非门禁观测点：README 的规模承诺（≤2,000 任务 / 3,000 依赖）与一档余量。 */
export const OBSERVATION_DATASETS: readonly DatasetSpec[] = [
  {
    id: 'D4-dense-cross-2000',
    kind: 'dense-cross' as DatasetKind,
    taskCount: 2000,
    linkCount: 3000,
    seed: 20261008,
    maxDuration: 20,
    milestoneRatio: 0.05,
  },
  {
    id: 'D5-dense-cross-5000',
    kind: 'dense-cross' as DatasetKind,
    taskCount: 5000,
    linkCount: 7500,
    seed: 20261009,
    maxDuration: 20,
    milestoneRatio: 0.05,
  },
];

// ---------------------------------------------------------------- 差分测试契约

export const DIFFERENTIAL_CONFIG = {
  /** 随机项目图数量（协议要求 ≥1,000）。 */
  projects: 1000,
  /** 含环图数量（要求两侧一致报环）。 */
  cyclicProjects: 200,
  minTasks: 5,
  maxTasks: 200,
  maxDuration: 8,
  maxLag: 3,
  milestoneRatio: 0.05,
  seedBase: 770_000,
  /** 参照实现路径（相对 spike 根目录）。 */
  referenceScript: 'reference/cpm_reference.py',
} as const;

/**
 * 差分测试轮换使用的日历（按项目序号取模）：默认 5 天、整周放假、6 天工作周。
 * 三者在**两侧各自实现**的日历里都要给出同一批 ISO 日期，这是对"序号 ↔ 日期"语义的交叉验证。
 */
export const DIFFERENTIAL_CALENDARS: readonly CalendarSpec[] = [CAL_DEFAULT, CAL_HOLIDAY_WEEK, CAL_SIX_DAY];

export function differentialCalendarFor(index: number): CalendarSpec {
  return DIFFERENTIAL_CALENDARS[index % DIFFERENTIAL_CALENDARS.length]!;
}

/**
 * 差分字段契约（TS 与 Python 两侧共用）：**日期维度一律是工作日序号**，
 * 另附 ISO 日期（由各自实现的日历翻译得出，用于交叉验证日历语义）。
 */
export const DIFFERENTIAL_FIELDS = [
  'es',
  'ef',
  'ls',
  'lf',
  'totalFloat',
  'freeFloat',
  'critical',
  'projectFinish',
  'esIso',
  'efIso',
] as const;

// ---------------------------------------------------------------- 手工用例

export interface HandExpectation {
  readonly es: readonly number[];
  readonly ef: readonly number[];
  readonly ls: readonly number[];
  readonly lf: readonly number[];
  readonly tf: readonly number[];
  readonly ff: readonly number[];
  readonly projectFinish: number;
  /** 可选：项目起点之后每个任务开始日的 ISO（用于验证日历/例外）。 */
  readonly startIso?: readonly string[];
}

export interface HandCase {
  readonly id: string;
  readonly title: string;
  readonly calendar: CalendarSpec;
  readonly durations: readonly number[];
  readonly links: readonly LinkSpec[];
  /** `null` = 只断言成环。 */
  readonly expected: HandExpectation | null;
  readonly expectCycle: boolean;
  readonly note: string;
}

function fs(pred: number, succ: number, lag = 0): LinkSpec {
  return { pred, succ, type: linkTypeOf('FS'), lag };
}
function ss(pred: number, succ: number, lag = 0): LinkSpec {
  return { pred, succ, type: linkTypeOf('SS'), lag };
}
function ff(pred: number, succ: number, lag = 0): LinkSpec {
  return { pred, succ, type: linkTypeOf('FF'), lag };
}
function sf(pred: number, succ: number, lag = 0): LinkSpec {
  return { pred, succ, type: linkTypeOf('SF'), lag };
}

/**
 * 十个人工推导用例。期望值推导口径：`baseDay` = 2026-10-05（周一）= 序号 0，
 * 工期/lag 单位为工作日，`ef = es + duration`。
 */
export const HAND_CASES: readonly HandCase[] = [
  {
    id: 'C1-fs-chain-cross-weekend',
    title: 'FS 链 + 跨周末 + 正 lag',
    calendar: CAL_DEFAULT,
    durations: [3, 2, 5],
    links: [fs(0, 1), fs(1, 2, 2)],
    expected: {
      es: [0, 3, 7],
      ef: [3, 5, 12],
      ls: [0, 3, 7],
      lf: [3, 5, 12],
      tf: [0, 0, 0],
      ff: [0, 0, 0],
      projectFinish: 12,
    },
    expectCycle: false,
    note: 't1 从周四起 2 个工作日跨越周末；t2 带 +2 lag，末任务决定项目完成',
  },
  {
    id: 'C2-parallel-float',
    title: '并行分支 + 总浮动/自由浮动',
    calendar: CAL_DEFAULT,
    durations: [2, 5, 2, 3],
    links: [fs(0, 1), fs(0, 2), fs(1, 3), fs(2, 3)],
    expected: {
      es: [0, 2, 2, 7],
      ef: [2, 7, 4, 10],
      ls: [0, 2, 5, 7],
      lf: [2, 7, 7, 10],
      tf: [0, 0, 3, 0],
      ff: [0, 0, 3, 0],
      projectFinish: 10,
    },
    expectCycle: false,
    note: '短分支 t2 有 3 个工作日浮动；t0 的自由浮动由两条后继共同约束为 0',
  },
  {
    id: 'C3-ss-relation',
    title: 'SS 关系（开始—开始）',
    calendar: CAL_DEFAULT,
    durations: [3, 2, 2],
    links: [ss(0, 1), fs(1, 2), fs(0, 2)],
    expected: {
      es: [0, 0, 3],
      ef: [3, 2, 5],
      ls: [0, 1, 3],
      lf: [3, 3, 5],
      tf: [0, 1, 0],
      ff: [0, 1, 0],
      projectFinish: 5,
    },
    expectCycle: false,
    note: 'SS 只约束开始；t0 的 LS 由 FS 后继（t2）而非 SS 后继（t1）决定',
  },
  {
    id: 'C4-ff-relation',
    title: 'FF 关系（完成—完成）',
    calendar: CAL_DEFAULT,
    durations: [6, 4, 2],
    links: [ff(0, 1), fs(1, 2)],
    expected: {
      es: [0, 2, 6],
      ef: [6, 6, 8],
      ls: [0, 2, 6],
      lf: [6, 6, 8],
      tf: [0, 0, 0],
      ff: [0, 0, 0],
      projectFinish: 8,
    },
    expectCycle: false,
    note: 'FF 把 t1 的开始推后（2），使两者同时完成；常量性由 `es = ef_pred + lag − dur` 给出',
  },
  {
    id: 'C5-sf-relation',
    title: 'SF 关系（开始—完成）+ 一条浮动分支',
    calendar: CAL_DEFAULT,
    durations: [3, 5, 2, 1],
    links: [sf(0, 1, 10), fs(1, 2), fs(0, 3)],
    expected: {
      es: [0, 5, 10, 3],
      ef: [3, 10, 12, 4],
      ls: [0, 5, 10, 11],
      lf: [3, 10, 12, 12],
      tf: [0, 0, 0, 8],
      ff: [0, 0, 0, 8],
      projectFinish: 12,
    },
    expectCycle: false,
    note: 'SF 的逆向界只作用在 pred 的**开始**上（`ls_pred ≤ ls_succ + D_succ − L`），不减 D_pred',
  },
  {
    id: 'C6-negative-lag',
    title: '负 lag（lead）与 SS 负 lag',
    calendar: CAL_DEFAULT,
    durations: [5, 2, 3, 2],
    links: [fs(0, 1, -2), ss(1, 2, -1), fs(2, 3)],
    expected: {
      es: [0, 3, 2, 5],
      ef: [5, 5, 5, 7],
      ls: [0, 3, 2, 5],
      lf: [5, 5, 5, 7],
      tf: [0, 0, 0, 0],
      ff: [0, 0, 0, 0],
      projectFinish: 7,
    },
    expectCycle: false,
    note: '负 lag 是"重叠"，不触发任何 0 截断（clampedStarts 应为 0）',
  },
  {
    id: 'C7-calendar-exception',
    title: '日历例外：整周放假',
    calendar: CAL_HOLIDAY_WEEK,
    durations: [3, 2, 2],
    links: [fs(0, 1), fs(1, 2)],
    expected: {
      es: [0, 3, 5],
      ef: [3, 5, 7],
      ls: [0, 3, 5],
      lf: [3, 5, 7],
      tf: [0, 0, 0],
      ff: [0, 0, 0],
      projectFinish: 7,
      startIso: ['2026-10-05', '2026-10-08', '2026-10-19'],
    },
    expectCycle: false,
    note: '等价于序号 5 从 2026-10-12 顺延到 2026-10-19；这是"例外真的参与算术"的判据',
  },
  {
    id: 'C8-cross-level-milestone-isolated',
    title: '跨层级（跳层依赖）+ 里程碑 + 游离节点',
    calendar: CAL_DEFAULT,
    durations: [1, 2, 0, 4, 2],
    links: [fs(0, 1), fs(0, 2), fs(1, 3), fs(2, 3)],
    expected: {
      es: [0, 1, 1, 3, 0],
      ef: [1, 3, 1, 7, 2],
      ls: [0, 1, 3, 3, 5],
      lf: [1, 3, 3, 7, 7],
      tf: [0, 0, 2, 0, 5],
      ff: [0, 0, 2, 0, 5],
      projectFinish: 7,
    },
    expectCycle: false,
    note: 't2 为 0 工期里程碑（跳层依赖的另一端）；t4 无任何关联，仍得到 0/0 与浮动 5（DM-05）',
  },
  {
    id: 'C9-six-day-calendar',
    title: '6 天工作周（Mon–Sat）',
    calendar: CAL_SIX_DAY,
    durations: [6, 1],
    links: [fs(0, 1)],
    expected: {
      es: [0, 6],
      ef: [6, 7],
      ls: [0, 6],
      lf: [6, 7],
      tf: [0, 0],
      ff: [0, 0],
      projectFinish: 7,
      startIso: ['2026-10-05', '2026-10-12'],
    },
    expectCycle: false,
    note: '`workDays` 决定"序号 6"落在 2026-10-12（周一）而非 10-11（周日）',
  },
  {
    id: 'C10-cycle',
    title: '成环必须被报出，而不是死循环',
    calendar: CAL_DEFAULT,
    durations: [1, 1, 1],
    links: [fs(0, 1), fs(1, 2), fs(2, 0)],
    expected: null,
    expectCycle: true,
    note: '三节点环；判据是"检出环"与"不崩"，不是具体数值',
  },
];

// ---------------------------------------------------------------- 不变量与负向对照

export const INVARIANT_CONFIG = {
  /** 不变量测试覆盖的随机图数量（协议要求 ≥1,000）。 */
  graphs: 1000,
  minTasks: 5,
  maxTasks: 120,
  seedBase: 880_000,
} as const;

/** 负向对照阈值（判别力下限）；未达阈值 ⇒ 对应层面"测量无力"。 */
export const NEGATIVE_CONTROL_THRESHOLDS = {
  /** NC1：索引日历 vs 逐日循环日历（实测约 2,600×）。 */
  nc1: 3,
  /** NC2：闭包传播 vs 每跳全量重算（实测约 390×）。 */
  nc2: 10,
  /**
   * NC3：扁平数组 vs 对象图 + Map。
   * 实测约 2×，故阈值取 1.5×：**阈值要低于实测值并留出余量**，
   * 否则跨机器/跨运行时会因噪声把"有判别力"误判为"测量无力"。
   */
  nc3: 1.5,
} as const;

export { PROJECT_START_DAY, PROJECT_START_ISO, isoToDayNumber };
