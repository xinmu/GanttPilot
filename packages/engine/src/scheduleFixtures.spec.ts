import { describe, expect, it } from 'vitest';

import {
  addDays,
  Calendar,
  dayNumberToIso,
  isoToDayNumber,
  type CalendarSpec,
} from './date.js';
import {
  CURRENT_DOCUMENT_VERSION,
  reindexDocument,
  type DocumentLink,
  type DocumentTask,
  type LinkType,
  type ProjectDocument,
} from './schema.js';
import { summaryTaskIds } from './wbs.js';
import { type SessionAnchor } from './schedule.js';

/**
 * G2 排程内核的**测试夹具**（供 contract / manual / invariants / cycles / closure /
 * performance / differential 七个 spec 共享）。
 *
 * 为什么写成 `*.spec.ts`：它必须可被其他 spec import，而 `*.spec.ts` 已被 `tsconfig.json`
 * 的 `exclude` 排除在发布产物之外（与 G1.2 的 `fixtures.spec.ts` 同一手法）。
 *
 * 随机数据全部**由种子决定**（mulberry32，移植自 [S3 的 `graph-gen.ts`](../../../spikes/g0-s3-cpm-perf/src/graph-gen.ts)）：
 * 同一 `seed` + 同一规格 ⇒ 逐字节同一张图，因此差分/不变量"失败即复现"。
 */

/** 参照项目的日历基准日：2026-10-05（周一）。 */
export const SCHEDULE_BASE_ISO = '2026-10-05';

export const SCHEDULE_BASE_DAY = isoToDayNumber(SCHEDULE_BASE_ISO);

/** mulberry32：32 位确定性 PRNG。 */
export function createScheduleRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * 三套项目日历（v0.1 只有项目日历生效）：
 * A 默认周一至周五；B 整周放假（`nonWorking` 打掉 2026-10-12 那一周，用于验证"日历真的参与算术"）；
 * C 六天工作周（周一至周六）+ 周日补班（`working` 打掉 2026-10-11 这个休息日）。
 */
export const SCHEDULE_CALENDARS: readonly CalendarSpec[] = [
  { id: 'project', exceptions: { nonWorking: [], working: [] } },
  {
    id: 'project',
    exceptions: {
      nonWorking: [
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
      ],
      working: [],
    },
  },
  {
    id: 'project',
    workDays: [1, 2, 3, 4, 5, 6],
    exceptions: { nonWorking: [], working: ['2026-10-11'] },
  },
];

export interface GraphLink {
  readonly pred: number;
  readonly succ: number;
  readonly type: LinkType;
  readonly lag: number;
}

export interface GeneratedGraph {
  readonly taskCount: number;
  readonly durations: Int32Array;
  readonly links: readonly GraphLink[];
  /** 生成时的拓扑序（仅用于构造"必然成环"的回边与证据）。 */
  readonly order: readonly number[];
}

const LINK_TYPE_CYCLE: readonly LinkType[] = ['FS', 'SS', 'FF', 'SF'];

function shuffledIndices(n: number, rng: () => number): number[] {
  const order: number[] = [];
  for (let i = 0; i < n; i += 1) {
    order.push(i);
  }
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = order[i]!;
    const b = order[j]!;
    order[i] = b;
    order[j] = a;
  }
  return order;
}

export interface GraphSpec {
  readonly seed: number;
  readonly taskCount: number;
  readonly linkCount: number;
  readonly maxDuration?: number;
  readonly maxLag?: number;
  readonly milestoneRatio?: number;
  readonly cyclic?: boolean;
}

/**
 * 随机图：随机拓扑序 + 随机树保证连通（全是 DAG 边）+ 随机四类关系与正负 lag。
 *
 * `cyclic: true` 时补一条 `order[last] → order[0]` 的**必然成环**回边
 * （随机树的每条边都指向拓扑序更靠后的节点，因此 `order[0]` 是所有节点的祖先）。
 */
export function generateGraph(spec: GraphSpec): GeneratedGraph {
  const rng = createScheduleRng(spec.seed);
  const n = spec.taskCount;
  const order = shuffledIndices(n, rng);
  const maxDuration = spec.maxDuration ?? 8;
  const maxLag = spec.maxLag ?? 3;
  const milestoneRatio = spec.milestoneRatio ?? 0.05;

  const durations = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    durations[i] = rng() < milestoneRatio ? 0 : 1 + Math.floor(rng() * maxDuration);
  }

  const links: GraphLink[] = [];
  for (let i = 1; i < n; i += 1) {
    const back = Math.floor(rng() * i);
    links.push({
      pred: order[back]!,
      succ: order[i]!,
      type: 'FS',
      lag: Math.floor(rng() * (maxLag + 1)),
    });
  }

  const guard = Math.max(64, spec.linkCount * 6);
  let attempts = 0;
  while (links.length < spec.linkCount && attempts < guard) {
    attempts += 1;
    const a = Math.floor(rng() * n);
    const b = Math.floor(rng() * n);
    if (a === b) {
      continue;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    links.push({
      pred: order[lo]!,
      succ: order[hi]!,
      type: LINK_TYPE_CYCLE[Math.floor(rng() * LINK_TYPE_CYCLE.length)]!,
      lag: Math.floor(rng() * (maxLag * 2 + 1)) - maxLag,
    });
  }

  if (spec.cyclic === true && n >= 4) {
    links.push({ pred: order[n - 1]!, succ: order[0]!, type: 'FS', lag: 0 });
  }

  return { taskCount: n, durations, links, order };
}

export interface ProjectSpec extends GraphSpec {
  readonly id: string;
  /** 成为一个"有父任务"的节点的概率（父索引必然小于自身索引）。 */
  readonly hierarchyRatio?: number;
  /** 有 `startDate` 的概率。 */
  readonly dateRatio?: number;
  /** `durationDays` 显式给出的概率（否则由日期解析，或为 0）。 */
  readonly explicitDurationRatio?: number;
  /** `progress` 为 `null` 的概率。 */
  readonly progressNullRatio?: number;
  /** `manual === true` 的概率。 */
  readonly manualRatio?: number;
  /** 带非空 `constraints` 的概率。 */
  readonly constraintRatio?: number;
  /** 日历 `baseDay` 相对"文档最早日期"的自然日偏移（负 = 日历起点更早）。 */
  readonly baseDayOffset?: number;
  readonly calendarIndex?: number;
  /** 日期窗口长度（自然日，自 `SCHEDULE_BASE_ISO` 起）。 */
  readonly dateWindowDays?: number;
  /** 刻意制造 `endDate` 与工期不一致（`endDateStale`）的概率。 */
  readonly staleEndDateRatio?: number;
}

export interface GeneratedProject {
  readonly document: ProjectDocument;
  readonly graph: GeneratedGraph;
  readonly calendarIndex: number;
  readonly baseDayOffset: number;
  /** 该文档的最早日期（日序号）；无日期时为 `null`。 */
  readonly earliestDay: number | null;
  /** 确定性生成的会话锚点：覆盖合法 / 未知任务 / 汇总任务 / 重复 / 负序号 / 非整数。 */
  readonly anchors: readonly SessionAnchor[];
}

/** 文档中全部非空日期的最小日序号（`createScheduleCalendar` 的 `baseDay` 同口径）。 */
export function earliestDocumentDay(document: ProjectDocument): number | null {
  let earliest: number | null = null;
  const consider = (iso: string | null): void => {
    if (iso === null) {
      return;
    }
    const day = isoToDayNumber(iso);
    if (earliest === null || day < earliest) {
      earliest = day;
    }
  };
  consider(document.project.startDate);
  for (const task of document.tasks) {
    consider(task.startDate);
    consider(task.endDate);
  }
  return earliest;
}

/**
 * 生成一个**规范且可通过校验**的随机项目（含层级、日期、四类关系、里程碑、留位字段）。
 *
 * 日期窗口刻意很窄（默认 45 自然日），这样"整周放假"那套日历真的会参与算术；
 * 工期/链路长度则让序号空间远远跑出日期窗口——两种坐标不会互相掩盖。
 */
export function generateProject(spec: ProjectSpec): GeneratedProject {
  const rng = createScheduleRng(spec.seed ^ 0x5f37_59df);
  const graph = generateGraph(spec);
  const n = graph.taskCount;
  const hierarchyRatio = spec.hierarchyRatio ?? 0.15;
  const dateRatio = spec.dateRatio ?? 0.7;
  const explicitDurationRatio = spec.explicitDurationRatio ?? 0.8;
  const progressNullRatio = spec.progressNullRatio ?? 0.3;
  const manualRatio = spec.manualRatio ?? 0.03;
  const constraintRatio = spec.constraintRatio ?? 0.03;
  const dateWindowDays = spec.dateWindowDays ?? 45;
  const staleEndDateRatio = spec.staleEndDateRatio ?? 0.15;
  const calendarIndex = (spec.calendarIndex ?? 0) % SCHEDULE_CALENDARS.length;

  const tasks: DocumentTask[] = [];
  for (let i = 0; i < n; i += 1) {
    const hasDate = rng() < dateRatio;
    const startDay = hasDate ? SCHEDULE_BASE_DAY + Math.floor(rng() * dateWindowDays) : null;
    const duration = graph.durations[i]!;
    let endDay: number | null = null;
    if (startDay !== null) {
      // 常规形状：endDate ≈ startDate 后 `ceil(工期 × 1.4)` 自然日（≈ 同数量的工作日）；
      // `staleEndDateRatio` 那部分刻意偏离，用来覆盖 `endDateStale`。
      endDay =
        rng() < staleEndDateRatio
          ? addDays(startDay, duration + 3)
          : addDays(startDay, Math.ceil(duration * 1.4));
    }

    const parentIndex = i > 0 && rng() < hierarchyRatio ? Math.floor(rng() * i) : null;
    const explicitDuration = rng() < explicitDurationRatio;
    tasks.push({
      id: `t${String(i)}`,
      parentId: parentIndex === null ? null : `t${String(parentIndex)}`,
      outlineNumber: '', // 由 reindexDocument 归一（派生值不是真相源）
      name: `任务 ${String(i)}`,
      startDate: startDay === null ? null : dayNumberToIso(startDay),
      endDate: endDay === null ? null : dayNumberToIso(endDay),
      durationDays: explicitDuration ? duration : null,
      progress: rng() < progressNullRatio ? null : Math.round(rng() * 20) / 20,
      milestone: duration === 0,
      collapsed: false,
      notes: null,
      manual: rng() < manualRatio,
      constraints: rng() < constraintRatio ? [{ kind: 'startNoEarlierThan', date: '2026-10-05' }] : [],
    });
  }

  const links: DocumentLink[] = graph.links.map((link, index) => ({
    id: `l${String(index)}`,
    from: `t${String(link.pred)}`,
    to: `t${String(link.succ)}`,
    type: link.type,
    lagDays: link.lag,
  }));

  const projectStartDate =
    rng() < 0.5 ? null : dayNumberToIso(SCHEDULE_BASE_DAY + Math.floor(rng() * 10));

  const document = reindexDocument({
    version: CURRENT_DOCUMENT_VERSION,
    project: {
      name: `夹具项目 ${spec.id}`,
      description: null,
      baseCalendarId: 'project',
      startDate: projectStartDate,
      finishDate: null,
    },
    calendars: [SCHEDULE_CALENDARS[calendarIndex]!],
    tasks,
    links,
    baselines: [],
  });

  const earliest = earliestDocumentDay(document);
  const summaryIds = [...summaryTaskIds(document.tasks)];
  const leafIds = document.tasks.filter((task) => !summaryIds.includes(task.id)).map((task) => task.id);
  const anchors: SessionAnchor[] = [];
  const pick = (offset: number): string | null => (leafIds.length > offset ? leafIds[offset]! : null);
  const first = pick(0);
  const second = pick(1);
  const third = pick(2);
  const fourth = pick(3);
  if (first !== null) {
    anchors.push({ taskId: first, startOrdinal: 3 });
    anchors.push({ taskId: 'ghost-task', startOrdinal: 0 });
  }
  if (summaryIds.length > 0) {
    anchors.push({ taskId: summaryIds[0]!, startOrdinal: 1 });
  }
  if (second !== null) {
    anchors.push({ taskId: second, startOrdinal: 5 });
    anchors.push({ taskId: second, startOrdinal: 2 }); // 重复：后者胜
  }
  if (third !== null) {
    anchors.push({ taskId: third, startOrdinal: -4 }); // 负序号：参与截断
  }
  if (fourth !== null) {
    anchors.push({ taskId: fourth, startOrdinal: 2.5 }); // 非整数：忽略 + anchorUnknown
  }

  return {
    document,
    graph,
    calendarIndex,
    baseDayOffset: spec.baseDayOffset ?? 0,
    earliestDay: earliest,
    anchors,
  };
}

/** 按夹具的 `baseDayOffset` 构造日历（默认给足容量，便于直接翻译 ISO）。 */
export function makeCalendar(project: GeneratedProject, spanDays = 20_000): Calendar {
  const baseDay = (project.earliestDay ?? SCHEDULE_BASE_DAY) + project.baseDayOffset;
  return new Calendar(project.document.calendars[0]!, { baseDay, spanDays });
}

/** 手工用例的任务工厂：只写"想测的字段"，其余走规范默认值。 */
export function fixtureTask(overrides: Partial<DocumentTask> & Pick<DocumentTask, 'id'>): DocumentTask {
  return {
    parentId: null,
    outlineNumber: '',
    name: overrides.id,
    startDate: null,
    endDate: null,
    durationDays: null,
    progress: null,
    milestone: false,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
    ...overrides,
  };
}

/** 手工用例的文档工厂（默认周内工作制日历、无项目开始日）。 */
export function fixtureDocument(
  tasks: readonly DocumentTask[],
  links: readonly DocumentLink[] = [],
  projectStartDate: string | null = null,
): ProjectDocument {
  return {
    version: CURRENT_DOCUMENT_VERSION,
    project: {
      name: '手工用例',
      description: null,
      baseCalendarId: 'project',
      startDate: projectStartDate,
      finishDate: null,
    },
    calendars: [SCHEDULE_CALENDARS[0]!],
    tasks,
    links,
    baselines: [],
  };
}

/** 1,000 任务 / 1,500 依赖的性能数据集（全叶子，与 S3 的口径对齐）。 */
export function largeScheduleProject(taskCount = 1000, linkCount = 1500, seed = 990_001): GeneratedProject {
  return generateProject({
    id: `perf-${String(taskCount)}`,
    seed,
    taskCount,
    linkCount,
    maxDuration: 20,
    maxLag: 3,
    milestoneRatio: 0.05,
    hierarchyRatio: 0,
    dateRatio: 1,
    explicitDurationRatio: 1,
    progressNullRatio: 0.3,
    manualRatio: 0,
    constraintRatio: 0,
    staleEndDateRatio: 0.1,
    dateWindowDays: 120,
  });
}

describe('G2 夹具自检', () => {
  it('同一 seed 生成逐字节相同的文档（差分/不变量失败即可复现）', () => {
    const first = generateProject({ id: 'repro', seed: 20_261_005, taskCount: 30, linkCount: 40 });
    const second = generateProject({ id: 'repro', seed: 20_261_005, taskCount: 30, linkCount: 40 });
    expect(second.document).toStrictEqual(first.document);
    expect(second.anchors).toStrictEqual(first.anchors);
    expect(second.graph.links).toStrictEqual(first.graph.links);

    const other = generateProject({ id: 'repro', seed: 20_261_006, taskCount: 30, linkCount: 40 });
    expect(other.document).not.toStrictEqual(first.document);
  });

  it('夹具覆盖到了汇总任务、里程碑、四类关系与三套日历', () => {
    const seenTypes = new Set<string>();
    let sawSummary = false;
    let sawMilestone = false;
    let sawAnchorKinds = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const project = generateProject({ id: `probe-${String(seed)}`, seed, taskCount: 24, linkCount: 36 });
      const parents = new Set(
        project.document.tasks.map((task) => task.parentId).filter((id): id is string => id !== null),
      );
      if (parents.size > 0) {
        sawSummary = true;
      }
      if (project.document.tasks.some((task) => task.milestone)) {
        sawMilestone = true;
      }
      if (project.document.tasks.some((task) => task.startDate === null)) {
        sawAnchorKinds += 1;
      }
      for (const link of project.document.links) {
        seenTypes.add(link.type);
      }
    }
    expect(sawSummary).toBe(true);
    expect(sawMilestone).toBe(true);
    expect(sawAnchorKinds).toBeGreaterThan(0);
    expect([...seenTypes].sort()).toStrictEqual(['FF', 'FS', 'SF', 'SS']);
    expect(SCHEDULE_CALENDARS).toHaveLength(3);
    expect(SCHEDULE_CALENDARS[2]?.workDays).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });
});
