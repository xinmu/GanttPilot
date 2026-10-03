/**
 * 数据模型（spike 口径的**最小**表示，不是 G1 的文档 schema）。
 *
 * 两条刻意的设计选择，都是本 spike 要验证的对象（见结论的「G2 交接清单」）：
 * - **全程整数**：任务日期不以 `Date` 承载，而以「工作日序号」承载；日历只负责
 *   序号 ↔ ISO 日期 的翻译。于是 `EF = ES + duration` 是整数加法，浮动是整数比较；
 * - **扁平数组 + CSR 邻接**：不用 `Map<string, Task>` 的对象图（后者作为常数因子负向对照 NC3）。
 */

/** 关系类型：`0=FS 1=SS 2=FF 3=SF`（DM-03）。 */
export type LinkType = 0 | 1 | 2 | 3;

export const LINK_TYPE_NAMES = ['FS', 'SS', 'FF', 'SF'] as const;
export const LINK_TYPE_COUNT = 4;

export function linkTypeOf(name: string): LinkType {
  const index = LINK_TYPE_NAMES.indexOf(name as (typeof LINK_TYPE_NAMES)[number]);
  if (index < 0) {
    throw new RangeError(`未知关系类型：${JSON.stringify(name)}（要求 FS/SS/FF/SF）`);
  }
  return index as LinkType;
}

export function linkTypeName(type: LinkType): string {
  return LINK_TYPE_NAMES[type];
}

/** 工作日历规格（DM-06；v0.1 仅项目日历生效）。 */
export interface CalendarSpec {
  readonly id: string;
  /** 工作日：0=周日 … 6=周六。 */
  readonly workDays: readonly number[];
  readonly exceptions: {
    /** 「工作日 → 非工作日」。 */
    readonly nonWorking: readonly number[];
    /** 「休息日 → 工作日」。 */
    readonly working: readonly number[];
  };
}

export interface LinkSpec {
  readonly pred: number;
  readonly succ: number;
  readonly type: LinkType;
  /** 工作日；可为负（lead）。 */
  readonly lag: number;
}

/**
 * 排程结果。日期维度一律是**工作日序号**：
 * - `es` = 任务的第一个工作日序号；`ef = es + duration`（排他结束序号）；
 * - `ls`/`lf` = 逆向遍历得到的最晚起止序号；
 * - `totalFloat = ls - es`；`freeFloat` = 后继不动的前提下本任务可整体后移的工作日数。
 */
export interface Schedule {
  readonly taskCount: number;
  es: Int32Array;
  ef: Int32Array;
  ls: Int32Array;
  lf: Int32Array;
  totalFloat: Int32Array;
  freeFloat: Int32Array;
  /** 1 = 关键任务（`totalFloat === 0`）。 */
  critical: Uint8Array;
  /** 项目最早完成序号 = `max(ef)`。 */
  projectFinish: number;
  /** 正向遍历中被 0 截断的 ES 次数（负 lag / 逆向约束导致的越界诊断，DM-05 之外的诚实记录）。 */
  clampedStarts: number;
}

export function allocateSchedule(taskCount: number): Schedule {
  return {
    taskCount,
    es: new Int32Array(taskCount),
    ef: new Int32Array(taskCount),
    ls: new Int32Array(taskCount),
    lf: new Int32Array(taskCount),
    totalFloat: new Int32Array(taskCount),
    freeFloat: new Int32Array(taskCount),
    critical: new Uint8Array(taskCount),
    projectFinish: 0,
    clampedStarts: 0,
  };
}

export type DiagnosticCode =
  | 'cycle'
  | 'clamped-start'
  | 'unknown-predecessor'
  | 'duplicate-link';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly detail: string;
  readonly task?: number;
}
