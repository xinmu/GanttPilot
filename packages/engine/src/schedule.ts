/**
 * 排程内核（**G2**）：全量正向传播 + 汇总聚合 + 检环 + 结构查询。
 *
 * 规范说明见 [`SCHEDULE.md`](../SCHEDULE.md)；决策依据见
 * [ADR 0004 排程契约](../../../docs/02-adr/0004-排程契约.md)（冻结面）与
 * [ADR 0005 排程内核落地补齐与结果形状](../../../docs/02-adr/0005-排程内核落地补齐与结果形状.md)（口岸补齐）。
 *
 * 三条与性能结论直接相关的设计（全部来自 [S3 结论 §八](../../../spikes/g0-s3-cpm-perf/结论.md)）：
 * 1. **序号空间**：`es`/`ef` 全是「工作日序号」（整数），日历**不进热路径**——正向传播是整数加法
 *    与比较，`Date` 只出现在"序号 ↔ 日期"的边界；
 * 2. **扁平数组 + CSR 邻接**（`Int32Array` / `Uint8Array`），无对象图、无 `Map`（对照实验：慢 2.8–3.4×）；
 * 3. **零递归**：拓扑序、成环路径、后继闭包全部迭代实现（1,000 节点深链不得依赖调用栈）。
 *
 * 关系方程（`s`/`f` 为起/止序号，`D` 为解析工期，`L` 为 lag；`v0.1` 只做**正向**）：
 *
 * | 类型 | 正向约束 |
 * |---|---|
 * | FS | `s_succ ≥ f_pred + L` |
 * | SS | `s_succ ≥ s_pred + L` |
 * | FF | `f_succ ≥ f_pred + L`（等价于 `s_succ ≥ f_pred + L − D_succ`） |
 * | SF | `f_succ ≥ s_pred + L`（等价于 `s_succ ≥ s_pred + L − D_succ`） |
 *
 * `noUncheckedIndexedAccess` 下类型化数组的读取含 `undefined`，热循环内的索引读取统一用 `!`
 * 断言（索引在结构上必然有界）。这是有意识的取舍，不是疏漏。
 */

import {
  Calendar,
  DEFAULT_PROJECT_BASE_DAY_ISO,
  dayNumberToIso,
  HORIZON_GUARD_DAYS,
  horizonDaysFor,
  isoToDayNumber,
  type CalendarSpec,
  type DayNumber,
} from './date.js';
import { type DocumentLink, type LinkType, type ProjectDocument } from './schema.js';
import { summaryTaskIds, type DiagnosticLike } from './wbs.js';

/** 汇总任务（不参与排程）在 `es`/`ef` 与 `summary*` 里的哨兵；不是合法序号（负数序号无定义）。 */
export const LEAF_SENTINEL = -1;

/** 关系类型 → 内部整数（与 S3 的 `model.ts` 同序）。 */
const LINK_TYPE_INDEX: Readonly<Record<LinkType, number>> = { FS: 0, SS: 1, FF: 2, SF: 3 };

const FS = 0;
const SS = 1;
const FF = 2;

// ---------------------------------------------------------------- 类型

/** 会话内锚点（G5 的"允许 + 标红"）：不进文档、不落盘（ADR 0004 §2）。 */
export interface SessionAnchor {
  readonly taskId: string;
  readonly startOrdinal: number;
}

/** 排程侧诊断码（ADR 0004 §5 冻结的**闭集**；与文档侧的 `SCREAMING_SNAKE` 是两个码空间）。 */
export type ScheduleDiagnosticCode =
  | 'undated'
  | 'dateOverridden'
  | 'clampedStart'
  | 'anchorConflict'
  | 'anchorUnknown'
  | 'summaryIgnored'
  | 'endDateStale'
  | 'constraintsUnused'
  | 'cycle';

/** 一条排程诊断。形状复用 `wbs.ts` 的 `DiagnosticLike`（`{code, severity, message, path?, taskId?, linkId?}`）。 */
export interface ScheduleDiagnostic extends DiagnosticLike {
  readonly code: ScheduleDiagnosticCode;
}

/**
 * 排程结果。日期维度一律是**工作日序号**（相对 `Calendar.baseDay`）。
 *
 * **索引约定**：每个数组都按 `document.tasks` 的**文档序**索引。
 * **哨兵 `-1`**：汇总行的 `es`/`ef` 为 -1、`anchored`/`driven` 为 0；叶子行的 `summary*` 为 -1。
 * 因此 `es[i] === -1` 就是"第 i 行是汇总任务"的判别式（G4 用它选汇总条分支）。
 */
export interface Schedule {
  readonly taskCount: number;

  // —— 序号空间 ——
  readonly es: Int32Array;
  readonly ef: Int32Array;
  readonly anchored: Uint8Array;
  readonly driven: Uint8Array;

  // —— 汇总任务派生值（叶子任务为 -1）——
  readonly summaryEs: Int32Array;
  readonly summaryEf: Int32Array;
  readonly summaryProgress: Float64Array;

  readonly milestoneCount: number;
  readonly projectStart: number;
  readonly projectFinish: number;
  readonly clampedStarts: number;
  readonly diagnostics: readonly ScheduleDiagnostic[];
}

export interface ScheduleSuccess {
  readonly ok: true;
  readonly schedule: Schedule;
  /**
   * `compute` 本次调用**真正用到**的日历（ADR 0005 附录 §1，裁决 P-48）。
   *
   * = 入参日历按 `expandToCoverDates` 覆盖到"本次调用里出现过的全部文档日期（含项目开始日）"
   * 之后的那一份。**凡把本结果的序号翻译成日期（或把日期翻译成序号），一律用它**——
   * 它是"这次计算可翻译"的载体，与 `schedule` 同源同次。
   *
   * 三条边界（与形状同等重要）：
   * - **`Schedule` 一字不改**：索引约定、哨兵、`es/ef`、汇总派生值、"序号与容量无关"全部不变，
   *   本字段只是"可翻译性"的载体；
   * - **不是第二真相源**：它是**派生量**（同一 `document` + 同一入参日历 ⇒ 逐值相同），
   *   **不落盘、不进文档、不进 xlsx/PPTX 导出物**；
   * - **`ok: false`（成环）时不产出**（照 ADR 0005 §1："失败结果不产出半成品"）。
   */
  readonly renderCalendar: Calendar;
}

export interface ScheduleFailure {
  readonly ok: false;
  readonly code: 'cycle';
  readonly message: string;
  /** 成环路径（任务 id 序列，**首尾同一 id**）——G5 据此高亮（ADR 0004 §6）。 */
  readonly cyclePath: readonly string[];
  /** 本情形下只含一条 `cycle`（severity `error`）；其余诊断不产出。 */
  readonly diagnostics: readonly ScheduleDiagnostic[];
}

export type ScheduleResult = ScheduleSuccess | ScheduleFailure;

// ---------------------------------------------------------------- 内部结构

/** 有效边（已解析成文档索引；`ignored` = 端点含汇总任务 ⇒ 传播时"等同不存在"）。 */
interface ResolvedLinks {
  readonly from: Int32Array;
  readonly to: Int32Array;
  readonly type: Uint8Array;
  readonly lag: Int32Array;
  readonly ignored: Uint8Array;
  readonly linkIds: readonly string[];
}

/** CSR 邻接（一出一入两份视图，共用同一份边序）。 */
interface Graph {
  readonly taskCount: number;
  readonly edgeCount: number;
  readonly succOffset: Int32Array;
  readonly succTarget: Int32Array;
  readonly succType: Uint8Array;
  readonly succLag: Int32Array;
  readonly succIgnored: Uint8Array;
  readonly predOffset: Int32Array;
  readonly predSource: Int32Array;
  readonly predType: Uint8Array;
  readonly predLag: Int32Array;
  readonly predIgnored: Uint8Array;
}

function report(
  diagnostics: ScheduleDiagnostic[],
  code: ScheduleDiagnosticCode,
  severity: DiagnosticLike['severity'],
  message: string,
  extra: { readonly taskId?: string; readonly linkId?: string } = {},
): void {
  diagnostics.push({ code, severity, message, ...extra });
}

function resolveLinks(
  document: ProjectDocument,
  indexById: ReadonlyMap<string, number>,
  isSummary: Uint8Array,
  diagnostics: ScheduleDiagnostic[],
): ResolvedLinks {
  const from: number[] = [];
  const to: number[] = [];
  const type: number[] = [];
  const lag: number[] = [];
  const ignored: number[] = [];
  const linkIds: string[] = [];

  for (const link of document.links) {
    const fi = indexById.get(link.from);
    const ti = indexById.get(link.to);
    // 悬空/不可解析的边：忽略且不报告（前置条件 = validateDocument 无 error，SPEC §六）。
    if (fi === undefined || ti === undefined) {
      continue;
    }
    const isIgnored = isSummary[fi] === 1 || isSummary[ti] === 1 ? 1 : 0;
    if (isIgnored === 1) {
      report(
        diagnostics,
        'summaryIgnored',
        'warning',
        '依赖边的端点是汇总任务：只有叶子任务参与排程，该边在传播中被忽略（等同不存在）',
        { linkId: link.id },
      );
    }
    from.push(fi);
    to.push(ti);
    type.push(LINK_TYPE_INDEX[link.type]);
    lag.push(link.lagDays);
    ignored.push(isIgnored);
    linkIds.push(link.id);
  }

  return {
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    type: Uint8Array.from(type),
    lag: Int32Array.from(lag),
    ignored: Uint8Array.from(ignored),
    linkIds,
  };
}

function buildGraph(taskCount: number, links: ResolvedLinks): Graph {
  const edgeCount = links.from.length;
  const succOffset = new Int32Array(taskCount + 1);
  const predOffset = new Int32Array(taskCount + 1);

  for (let e = 0; e < edgeCount; e += 1) {
    succOffset[links.from[e]! + 1] = succOffset[links.from[e]! + 1]! + 1;
    predOffset[links.to[e]! + 1] = predOffset[links.to[e]! + 1]! + 1;
  }
  for (let i = 0; i < taskCount; i += 1) {
    succOffset[i + 1] = succOffset[i + 1]! + succOffset[i]!;
    predOffset[i + 1] = predOffset[i + 1]! + predOffset[i]!;
  }

  const succTarget = new Int32Array(edgeCount);
  const succType = new Uint8Array(edgeCount);
  const succLag = new Int32Array(edgeCount);
  const succIgnored = new Uint8Array(edgeCount);
  const predSource = new Int32Array(edgeCount);
  const predType = new Uint8Array(edgeCount);
  const predLag = new Int32Array(edgeCount);
  const predIgnored = new Uint8Array(edgeCount);

  const succCursor = succOffset.slice();
  const predCursor = predOffset.slice();
  for (let e = 0; e < edgeCount; e += 1) {
    const f = links.from[e]!;
    const t = links.to[e]!;
    const si = succCursor[f]!;
    succCursor[f] = si + 1;
    succTarget[si] = t;
    succType[si] = links.type[e]!;
    succLag[si] = links.lag[e]!;
    succIgnored[si] = links.ignored[e]!;
    const pi = predCursor[t]!;
    predCursor[t] = pi + 1;
    predSource[pi] = f;
    predType[pi] = links.type[e]!;
    predLag[pi] = links.lag[e]!;
    predIgnored[pi] = links.ignored[e]!;
  }

  return {
    taskCount,
    edgeCount,
    succOffset,
    succTarget,
    succType,
    succLag,
    succIgnored,
    predOffset,
    predSource,
    predType,
    predLag,
    predIgnored,
  };
}

/** Kahn 入度法拓扑排序（**全部边**，结构性；ADR 0005 §8）。 */
function topologicalOrder(graph: Graph): {
  readonly order: Int32Array;
  readonly residual: Uint8Array;
  readonly hasCycle: boolean;
} {
  const n = graph.taskCount;
  const inDegree = new Int32Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    const degree = graph.predOffset[i + 1]! - graph.predOffset[i]!;
    inDegree[i] = degree;
    if (degree === 0) {
      queue[tail] = i;
      tail += 1;
    }
  }

  const order = new Int32Array(n);
  let head = 0;
  let processed = 0;
  while (head < tail) {
    const node = queue[head]!;
    head += 1;
    order[processed] = node;
    processed += 1;
    const end = graph.succOffset[node + 1]!;
    for (let k = graph.succOffset[node]!; k < end; k += 1) {
      const succ = graph.succTarget[k]!;
      const remaining = inDegree[succ]! - 1;
      inDegree[succ] = remaining;
      if (remaining === 0) {
        queue[tail] = succ;
        tail += 1;
      }
    }
  }
  if (processed === n) {
    return { order, residual: new Uint8Array(n), hasCycle: false };
  }
  // 未被移除的节点 = 环上的节点 + 其下游节点（Kahn 结束时入度仍 > 0）。
  const residual = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    residual[i] = inDegree[i]! > 0 ? 1 : 0;
  }
  return { order, residual, hasCycle: true };
}

/**
 * 从未被移除的节点里**还原一条真实环路径**（G5 的高亮对象）。
 *
 * 用迭代 DFS（白/灰/黑三色 + 显式栈）：只有灰色的后继才构成环，因此不会把"从环上分叉出去的死路"
 * 误当成环。起点取最小的残余下标，后继按 CSR 序遍历 ⇒ 结论确定。
 */
function extractCyclePath(graph: Graph, residual: Uint8Array): number[] {
  const n = graph.taskCount;
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Uint8Array(n);
  const stack = new Int32Array(n);
  const cursor = new Int32Array(n);

  for (let start = 0; start < n; start += 1) {
    if (residual[start] === 0 || color[start] !== WHITE) {
      continue;
    }
    let size = 0;
    stack[size] = start;
    size += 1;
    color[start] = GRAY;
    cursor[start] = graph.succOffset[start]!;

    while (size > 0) {
      const node = stack[size - 1]!;
      const end = graph.succOffset[node + 1]!;
      const k = cursor[node]!;
      if (k < end) {
        cursor[node] = k + 1;
        const succ = graph.succTarget[k]!;
        if (residual[succ] === 0) {
          continue;
        }
        if (color[succ] === GRAY) {
          // 找到环：栈里从 succ 首次出现处到栈顶即为环。
          let at = -1;
          for (let i = 0; i < size; i += 1) {
            if (stack[i] === succ) {
              at = i;
              break;
            }
          }
          const cycle: number[] = [];
          for (let i = at; i < size; i += 1) {
            cycle.push(stack[i]!);
          }
          cycle.push(succ);
          return cycle;
        }
        if (color[succ] === WHITE) {
          color[succ] = GRAY;
          cursor[succ] = graph.succOffset[succ]!;
          stack[size] = succ;
          size += 1;
        }
      } else {
        color[node] = BLACK;
        size -= 1;
      }
    }
  }
  return [];
}

/** 文档日期 → 序号。早于 `baseDay` ⇒ 序号 0（并计入截断）；超出可表示域 ⇒ 抛出（SPEC §四.5）。 */
function ordinalOfDocumentDay(calendar: Calendar, day: DayNumber): { readonly ordinal: number; readonly clamped: boolean } {
  if (day < calendar.baseDay) {
    return { ordinal: 0, clamped: true };
  }
  if (day > calendar.lastDay) {
    throw new RangeError(
      `文档日期 ${dayNumberToIso(day)} 超出可表示域（baseDay=${dayNumberToIso(calendar.baseDay)}，` +
        `上限 ${String(HORIZON_GUARD_DAYS)} 天）：请检查文档日期`,
    );
  }
  return { ordinal: calendar.ordinalOfDay(day) as number, clamped: false };
}

/**
 * 把日历扩容到"覆盖全部文档日期"为止（`withHorizon(spanDays × 2)` 循环）。
 *
 * 与 ADR 0004 §7 的对应关系见 ADR 0005 §7：传播本身是纯整数算术、不需要地平线，
 * 因此"容量不足 ⇒ 扩容重算"在实现里只会影响**日期 → 序号**这一步；
 * **序号与容量无关**是本节承诺的不变量。
 */
function expandToCoverDates(calendar: Calendar, maxDocumentDay: DayNumber | null): Calendar {
  return expandToCoverDay(calendar, maxDocumentDay);
}

/**
 * 把日历扩容到"能翻译序号 `maxOrdinal`"为止（P-48／ADR 0005 附录 §1 的第二半）。
 *
 * ## 为什么 `expandToCoverDates` 不够
 *
 * 文档日期只能定住"**日期 → 序号**"这一步的容量，而**计算出来的完成序号可以超出它**：
 * 一旦有依赖链把任务推到远期，`projectFinish` 就落在文档日期之外。渲染层要画这张图，
 * 就必须能翻译 `projectFinish − 1`（`contentWidthFor` 的公式），否则 `buildView` 抛
 * `RangeError` ⇒ Vue 卸载整棵树 ⇒ **整页空白**（人工报障 2026-10-05 的原始形态）。
 *
 * ## 为什么用"工作日数上界"而不是 `dayOfOrdinal` 反推
 *
 * 反推（`dayOfOrdinal(k + 1)`）在容量不足时**自己就会抛**——那正是要修的状态。
 * 这里改用一条**不依赖日历容量**的上界：一周只有一个"休息日集合"周的**工作日数 ≤ 7**，
 * 因此 `k + 1` 个工作日最多跨 `ceil((k + 1) × 7 / 5) + 14` 个自然日
 * （`7 / 5` 来自"一轮 7 天至少 5 个工作日"这一日历结构约束；`+ 14` 兜住例外把某几周压到 5 天以下）。
 * 于是 `withHorizon` 的目标**单调且必然足够**：`workdayCount ≥ (span − 14) × 5 / 7 ≥ k + 1`。
 */
function expandToCoverOrdinal(calendar: Calendar, maxOrdinal: number): Calendar {
  if (!Number.isFinite(maxOrdinal) || maxOrdinal < 0) {
    return calendar;
  }
  const needed = Math.ceil((Math.floor(maxOrdinal) + 1) * (7 / 5)) + 14;
  if (needed <= calendar.spanDays) {
    return calendar;
  }
  let spanDays = calendar.spanDays;
  while (spanDays < needed && spanDays < HORIZON_GUARD_DAYS) {
    spanDays = Math.min(HORIZON_GUARD_DAYS, spanDays * 2);
  }
  return calendar.withHorizon(spanDays);
}

/** 扩容到"至少覆盖自然日 `target`"（与 `expandToCoverDates` 同一手法：翻倍 + `HORIZON_GUARD_DAYS` 封顶）。 */
function expandToCoverDay(calendar: Calendar, target: DayNumber | null): Calendar {
  if (target === null) {
    return calendar;
  }
  const needed = target - calendar.baseDay + 1;
  if (needed <= calendar.spanDays) {
    return calendar;
  }
  let spanDays = calendar.spanDays;
  while (spanDays < needed && spanDays < HORIZON_GUARD_DAYS) {
    spanDays = Math.min(HORIZON_GUARD_DAYS, spanDays * 2);
  }
  return calendar.withHorizon(spanDays);
}

function inboundBound(type: number, predEs: number, predEf: number, duration: number, lag: number): number {
  switch (type) {
    case FS:
      return predEf + lag;
    case SS:
      return predEs + lag;
    case FF:
      return predEf + lag - duration;
    default:
      return predEs + lag - duration;
  }
}

// ---------------------------------------------------------------- 公共 API：compute

/**
 * 全量正向传播：`compute(document, calendar, anchors?) → ScheduleResult`。
 *
 * 纯函数：**绝不修改**入参（文档 / 日历 / 锚点），同一输入 ⇒ 深比较相同的 `Schedule`。
 * 排程结果**不写回文档**（ADR 0004 §2）。语义逐条见 [`SCHEDULE.md`](../SCHEDULE.md)。
 */
export function compute(
  document: ProjectDocument,
  calendar: Calendar,
  anchors: readonly SessionAnchor[] = [],
): ScheduleResult {
  const tasks = document.tasks;
  const n = tasks.length;
  const diagnostics: ScheduleDiagnostic[] = [];

  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    indexById.set(tasks[i]!.id, i);
  }

  const summaryIdSet = summaryTaskIds(tasks);
  const isSummary = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (summaryIdSet.has(tasks[i]!.id)) {
      isSummary[i] = 1;
    }
  }

  // 父索引 + G1.2 的"父先于子出现在文档序"不变量（汇总聚合依赖它；违反即抛，不静默算错）。
  const parentIndex = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const parentId = tasks[i]!.parentId;
    if (parentId === null) {
      continue;
    }
    const pi = indexById.get(parentId);
    if (pi === undefined) {
      continue; // 悬空 parentId：validateDocument 的职责
    }
    if (pi >= i) {
      throw new RangeError(
        `任务 ${tasks[i]!.id} 的父节点 ${parentId} 出现在文档序之后：` +
          'G1.2 要求"父节点先于子节点"，请先用 reindexDocument/命令层修正层级',
      );
    }
    parentIndex[i] = pi;
  }

  const links = resolveLinks(document, indexById, isSummary, diagnostics);
  const graph = buildGraph(n, links);
  const topo = topologicalOrder(graph);
  if (topo.hasCycle) {
    const cycleNodes = extractCyclePath(graph, topo.residual);
    const cyclePath = cycleNodes.map((index) => tasks[index]!.id);
    // 失败结果**只带这一条**诊断：成环时不产出排程，因此传播期的诊断本来就不存在——
    // 给一个"看起来完整"的部分列表会误导 G3 的问题清单（ADR 0005 §1）。
    const cycleDiagnostic: ScheduleDiagnostic = {
      code: 'cycle',
      severity: 'error',
      message:
        cycleNodes.length > 0
          ? `检测到依赖环，涉及 ${String(cycleNodes.length - 1)} 个任务：${cyclePath.join(' → ')}`
          : '检测到依赖环',
    };
    return {
      ok: false,
      code: 'cycle',
      message: cycleDiagnostic.message,
      cyclePath,
      diagnostics: [cycleDiagnostic],
    };
  }

  // —— 文档日期：**每个日期只解析一次**（同一次调用内再按 ISO 字符串去重）——
  // `isoToDayNumber` 要做正则 + `Date.UTC` + 反查（G1.2 已冻结的 API，不改），单次成本不低；
  // 1,000 任务的文档里有约 2,000 个日期，逐处重复解析会让热路径被 I/O 边界拖住
  // （实测：不缓存时全量传播 p99 约 2.5 ms，缓存后进入数百微秒量级）。
  // 缓存是**调用内局部**的 `Map`——不改结果、不进全局状态，纯函数性质不受影响。
  const dayCache = new Map<string, DayNumber>();
  const dayOf = (iso: string): DayNumber => {
    const cached = dayCache.get(iso);
    if (cached !== undefined) {
      return cached;
    }
    const day = isoToDayNumber(iso);
    dayCache.set(iso, day);
    return day;
  };

  const noDay = Number.NaN;
  const startDayOf = new Float64Array(n).fill(noDay);
  const endDayOf = new Float64Array(n).fill(noDay);
  let maxDocumentDay: DayNumber | null = null;
  const considerDay = (day: DayNumber): void => {
    if (maxDocumentDay === null || day > maxDocumentDay) {
      maxDocumentDay = day;
    }
  };
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (task.startDate !== null) {
      const day = dayOf(task.startDate);
      startDayOf[i] = day;
      considerDay(day);
    }
    if (task.endDate !== null) {
      const day = dayOf(task.endDate);
      endDayOf[i] = day;
      considerDay(day);
    }
  }
  const projectStartDay =
    document.project.startDate === null ? null : dayOf(document.project.startDate);
  if (projectStartDay !== null) {
    considerDay(projectStartDay);
  }
  const cal = expandToCoverDates(calendar, maxDocumentDay);

  // 每个任务的 startDate 序号（无日期 ⇒ null）；早于 baseDay 计入截断。
  // `clampedStarts` 与 `clampedStart` 诊断**同源同数**：每一次截断都既计数、又报一条
  // （SCHEDULE.md §六的不变量；含"文档日期早于 baseDay"与"项目开始日早于 baseDay"两类）。
  // 序号同时充当"工期解析"与"endDateStale"的入参：`[startOrdinal, endOrdinal)` 的工作日数就是
  // 两者的差（`workdaysBetween` 的同义式，省掉每任务两次 `ordinalOfDay`）。
  let clampedStarts = 0;
  const startOrdinal = new Int32Array(n).fill(LEAF_SENTINEL);
  for (let i = 0; i < n; i += 1) {
    const day = startDayOf[i]!;
    if (Number.isNaN(day)) {
      continue;
    }
    const resolved = ordinalOfDocumentDay(cal, day);
    startOrdinal[i] = resolved.ordinal;
    if (resolved.clamped) {
      clampedStarts += 1;
      report(
        diagnostics,
        'clampedStart',
        'warning',
        `任务日期 ${String(tasks[i]!.startDate)} 早于日历起点 ${dayNumberToIso(cal.baseDay)}：按序号 0 处理（负数序号无定义）`,
        { taskId: tasks[i]!.id },
      );
    }
  }
  const endOrdinal = new Int32Array(n).fill(LEAF_SENTINEL);
  for (let i = 0; i < n; i += 1) {
    const day = endDayOf[i]!;
    if (Number.isNaN(day)) {
      continue;
    }
    endOrdinal[i] = ordinalOfDocumentDay(cal, day).ordinal;
  }
  const spanOf = (i: number): number =>
    startOrdinal[i] === LEAF_SENTINEL || endOrdinal[i] === LEAF_SENTINEL
      ? 0
      : Math.max(0, endOrdinal[i]! - startOrdinal[i]!);

  // —— 工期解析 + endDateStale（完全不改写文档）——
  const duration = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (isSummary[i] === 1) {
      continue;
    }
    const task = tasks[i]!;
    if (task.durationDays !== null) {
      duration[i] = task.durationDays;
    } else if (startOrdinal[i] !== LEAF_SENTINEL && endOrdinal[i] !== LEAF_SENTINEL) {
      duration[i] = spanOf(i);
    } else {
      duration[i] = 0;
    }
  }

  // `endDateStale` 是**文档级一致性**诊断（只依赖任务自己的三个字段），因此对**所有任务**判定——
  // 包括汇总任务（汇总任务的工期不参与排程，但它的 `endDate` 与工期不一致同样不该被静默吞掉）。
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (task.durationDays === null || startOrdinal[i] === LEAF_SENTINEL || endOrdinal[i] === LEAF_SENTINEL) {
      continue;
    }
    const spanDays = spanOf(i);
    if (spanDays !== task.durationDays) {
      report(
        diagnostics,
        'endDateStale',
        'info',
        `endDate ${String(task.endDate)} 与「startDate ${String(task.startDate)} + 工期 ${String(task.durationDays)} 个工作日」不一致（按 ${String(spanDays)} 计）：工期为准，不回写文档`,
        { taskId: task.id },
      );
    }
  }

  // —— 项目起点：project.startDate → 全部任务日期最小值 → 0 —— 
  let projectStart: number | null = null;
  if (projectStartDay !== null) {
    const base = ordinalOfDocumentDay(cal, projectStartDay);
    projectStart = base.ordinal;
    if (base.clamped) {
      clampedStarts += 1;
      report(
        diagnostics,
        'clampedStart',
        'warning',
        `项目开始日 ${String(document.project.startDate)} 早于日历起点 ${dayNumberToIso(cal.baseDay)}：项目起点按序号 0 处理`,
      );
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      if (Number.isNaN(startDayOf[i]!)) {
        continue;
      }
      const ordinal = startOrdinal[i]!;
      if (projectStart === null || ordinal < projectStart) {
        projectStart = ordinal;
      }
    }
  }
  const startFloor = projectStart ?? 0;

  // —— 会话锚点（未知 ⇒ 忽略；重复 ⇒ 后者胜）——
  const anchorByIndex = new Map<number, number>();
  for (const anchor of anchors) {
    const index = indexById.get(anchor.taskId);
    if (index === undefined) {
      report(diagnostics, 'anchorUnknown', 'warning', `会话锚点指向不存在的任务：${anchor.taskId}（已忽略）`, {
        taskId: anchor.taskId,
      });
      continue;
    }
    if (isSummary[index] === 1) {
      report(diagnostics, 'summaryIgnored', 'warning', `会话锚点指向汇总任务 ${anchor.taskId}（已忽略：汇总任务不参与排程）`, {
        taskId: anchor.taskId,
      });
      continue;
    }
    if (!Number.isFinite(anchor.startOrdinal) || !Number.isInteger(anchor.startOrdinal)) {
      report(
        diagnostics,
        'anchorUnknown',
        'warning',
        `会话锚点的 startOrdinal 不是有限整数：${String(anchor.startOrdinal)}（已忽略）`,
        { taskId: anchor.taskId },
      );
      continue;
    }
    anchorByIndex.set(index, anchor.startOrdinal);
  }

  // —— 正向传播 ——
  const es = new Int32Array(n).fill(LEAF_SENTINEL);
  const ef = new Int32Array(n).fill(LEAF_SENTINEL);
  const anchored = new Uint8Array(n);
  const driven = new Uint8Array(n);

  for (let position = 0; position < n; position += 1) {
    const i = topo.order[position]!;
    if (isSummary[i] === 1) {
      continue;
    }
    const task = tasks[i]!;
    const taskDuration = duration[i]!;
    let raw = Number.NEGATIVE_INFINITY;
    let hasPredecessor = false;
    const predEnd = graph.predOffset[i + 1]!;
    for (let k = graph.predOffset[i]!; k < predEnd; k += 1) {
      if (graph.predIgnored[k] === 1) {
        continue; // 汇总端点边"等同不存在"
      }
      hasPredecessor = true;
      const bound = inboundBound(
        graph.predType[k]!,
        es[graph.predSource[k]!]!,
        ef[graph.predSource[k]!]!,
        taskDuration,
        graph.predLag[k]!,
      );
      if (bound > raw) {
        raw = bound;
      }
    }

    const anchorOrdinal = anchorByIndex.get(i);
    const documentStart = task.startDate === null ? null : startOrdinal[i]!;
    let caseThree = false;
    if (anchorOrdinal !== undefined) {
      // 情形④（含只有被忽略入边的"事实源任务"）：锚点参与 max。
      anchored[i] = 1;
      if (hasPredecessor && anchorOrdinal < raw) {
        report(
          diagnostics,
          'anchorConflict',
          'warning',
          `会话锚点（序号 ${String(anchorOrdinal)}）早于入边约束（序号 ${String(raw)}）：按入边约束排程`,
          { taskId: task.id },
        );
      }
      raw = hasPredecessor ? Math.max(raw, anchorOrdinal) : anchorOrdinal;
    } else if (!hasPredecessor) {
      // 情形①②：无有效入边 ⇒ 文档日期是锚点；无日期则回落项目起点（DM-05）。
      anchored[i] = 1;
      if (documentStart === null) {
        report(diagnostics, 'undated', 'warning', `任务没有任何日期且没有前置：回落项目起点（DM-05）`, {
          taskId: task.id,
        });
        raw = startFloor;
      } else {
        raw = documentStart;
      }
    } else {
      caseThree = true;
    }

    if (raw < startFloor) {
      raw = startFloor;
      clampedStarts += 1;
      report(
        diagnostics,
        'clampedStart',
        'warning',
        `推导的开始（含负 lag）早于项目起点（序号 ${String(startFloor)}）：截断到项目起点`,
        { taskId: task.id },
      );
    }

    es[i] = raw;
    ef[i] = raw + taskDuration;

    if (caseThree && documentStart !== null && documentStart !== raw) {
      driven[i] = 1;
      report(
        diagnostics,
        'dateOverridden',
        'warning',
        `文档日期（序号 ${String(documentStart)}）被推导覆盖为序号 ${String(raw)}（ADR 0004 §2 的"前置优先"）`,
        { taskId: task.id },
      );
    }
  }

  // —— 汇总聚合（逆文档序一遍累加；依赖 G1.2 的"父先于子"不变量）——
  const aggMin = new Int32Array(n);
  const aggMax = new Int32Array(n);
  const weight = new Float64Array(n);
  const weightedProgress = new Float64Array(n);
  const hasAggregate = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (isSummary[i] === 1) {
      continue;
    }
    aggMin[i] = es[i]!;
    aggMax[i] = ef[i]!;
    weight[i] = duration[i]!;
    weightedProgress[i] = duration[i]! * (tasks[i]!.progress ?? 0);
    hasAggregate[i] = 1;
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const parent = parentIndex[i]!;
    if (parent < 0 || hasAggregate[i] === 0) {
      continue;
    }
    if (hasAggregate[parent] === 0) {
      aggMin[parent] = aggMin[i]!;
      aggMax[parent] = aggMax[i]!;
      hasAggregate[parent] = 1;
    } else {
      if (aggMin[i]! < aggMin[parent]!) {
        aggMin[parent] = aggMin[i]!;
      }
      if (aggMax[i]! > aggMax[parent]!) {
        aggMax[parent] = aggMax[i]!;
      }
    }
    weight[parent] = weight[parent]! + weight[i]!;
    weightedProgress[parent] = weightedProgress[parent]! + weightedProgress[i]!;
  }

  const summaryEs = new Int32Array(n).fill(LEAF_SENTINEL);
  const summaryEf = new Int32Array(n).fill(LEAF_SENTINEL);
  const summaryProgress = new Float64Array(n).fill(LEAF_SENTINEL);
  for (let i = 0; i < n; i += 1) {
    if (isSummary[i] === 0) {
      continue;
    }
    summaryEs[i] = aggMin[i]!;
    summaryEf[i] = aggMax[i]!;
    summaryProgress[i] = weight[i]! > 0 ? weightedProgress[i]! / weight[i]! : Number.NaN;
  }

  let milestoneCount = 0;
  let projectFinish = startFloor;
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (isSummary[i] === 0 && (task.milestone || task.durationDays === 0)) {
      milestoneCount += 1;
    }
    if (isSummary[i] === 0 && ef[i]! > projectFinish) {
      projectFinish = ef[i]!;
    }
  }

  // —— 留位字段（R-3：语义 v0.5，v0.1 只报不解释）——
  for (let i = 0; i < n; i += 1) {
    const task = tasks[i]!;
    if (task.constraints.length > 0 || task.manual) {
      report(
        diagnostics,
        'constraintsUnused',
        'info',
        task.constraints.length > 0 && task.manual
          ? 'constraints 与 manual 的语义按 R-3 在 v0.5 细化：v0.1 不参与排程'
          : task.constraints.length > 0
            ? 'constraints 的语义按 R-3 在 v0.5 细化：v0.1 不参与排程'
            : 'manual 的语义按 R-3 在 v0.5 细化：v0.1 不参与排程',
        { taskId: task.id },
      );
    }
  }

  return {
    ok: true,
    // P-48／ADR 0005 附录 §1：交出"这份序号真正能被翻译"的那份日历。
    // 两半：① 上面 `expandToCoverDates(calendar, maxDocumentDay)` 覆盖**文档日期**；
    // ② 这里再按 `projectFinish` 覆盖**计算出来的序号**——文档日期定不住后者，
    // 而渲染层要画完整张图就必须能翻译它（`contentWidthFor` 用 `projectFinish − 1`）。
    // 两项都是"够用就原样返回"的幂等扩容，代价为零。
    renderCalendar: expandToCoverOrdinal(cal, projectFinish - 1),
    schedule: {
      taskCount: n,
      es,
      ef,
      anchored,
      driven,
      summaryEs,
      summaryEf,
      summaryProgress,
      milestoneCount,
      projectStart: startFloor,
      projectFinish,
      clampedStarts,
      diagnostics,
    },
  };
}

// ---------------------------------------------------------------- 公共 API：检环

/**
 * 建边预检：`candidate` 是否会让**已有的边集合**成环（ADR 0004 §6、ADR 0005 §13）。
 *
 * 签名里没有文档 ⇒ **看不到任务层级**，因此它按 `links` 给的边**结构性**判定
 * （与 `compute` 的检环同一口径，见 ADR 0005 §8）；调用方若要与"传播忽略汇总端点"一致，
 * 需自行过滤后再传入（默认不滤 = 保守拒绝）。
 */
export function wouldCreateCycle(
  links: readonly DocumentLink[],
  candidate: DocumentLink,
): { readonly cyclic: boolean; readonly path: readonly string[] } {
  if (candidate.from === candidate.to) {
    return { cyclic: true, path: [candidate.from, candidate.from] };
  }

  const successors = new Map<string, string[]>();
  for (const link of links) {
    const bucket = successors.get(link.from);
    if (bucket === undefined) {
      successors.set(link.from, [link.to]);
    } else {
      bucket.push(link.to);
    }
  }

  // 从 candidate.to 出发找 candidate.from：迭代 DFS + 显式路径栈。
  const path: string[] = [candidate.to];
  const onPath = new Set<string>([candidate.to]);
  const visited = new Set<string>();
  const cursors = new Map<string, number>();

  while (path.length > 0) {
    const node = path[path.length - 1]!;
    const bucket = successors.get(node);
    const cursor = cursors.get(node) ?? 0;
    if (bucket === undefined || cursor >= bucket.length) {
      cursors.delete(node);
      onPath.delete(node);
      visited.add(node);
      path.pop();
      continue;
    }
    cursors.set(node, cursor + 1);
    const next = bucket[cursor]!;
    if (next === candidate.from) {
      // 环 = candidate.from → candidate.to → … → candidate.from
      return { cyclic: true, path: [candidate.from, ...path, candidate.from] };
    }
    if (onPath.has(next) || visited.has(next)) {
      continue;
    }
    onPath.add(next);
    path.push(next);
  }

  return { cyclic: false, path: [] };
}

// ---------------------------------------------------------------- 公共 API：后继闭包

/**
 * 纯结构查询：`taskIds` 的后继闭包（含种子本身），按**文档序**输出。
 *
 * 只回答"哪些行/边的排程值可能变化"（G4 的"不做整表重建"、G5 的受影响子图）。
 * 沿**全部出边**遍历（含被传播忽略的汇总端点边：宽进不出错）；**不含祖先**——
 * 汇总条需调用方沿 `parentId` 自行补祖先链（见 SCHEDULE.md §八）。
 */
export function affectedClosure(document: ProjectDocument, taskIds: readonly string[]): readonly string[] {
  const tasks = document.tasks;
  const n = tasks.length;
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    indexById.set(tasks[i]!.id, i);
  }

  const successors: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    successors.push([]);
  }
  for (const link of document.links) {
    const fi = indexById.get(link.from);
    const ti = indexById.get(link.to);
    if (fi === undefined || ti === undefined) {
      continue;
    }
    successors[fi]!.push(ti);
  }

  const reached = new Uint8Array(n);
  const stack: number[] = [];
  for (const taskId of taskIds) {
    const index = indexById.get(taskId);
    if (index === undefined || reached[index] === 1) {
      continue;
    }
    reached[index] = 1;
    stack.push(index);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const succ of successors[node]!) {
      if (reached[succ] === 0) {
        reached[succ] = 1;
        stack.push(succ);
      }
    }
  }

  const closure: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (reached[i] === 1) {
      closure.push(tasks[i]!.id);
    }
  }
  return closure;
}

// ---------------------------------------------------------------- 公共 API：容量规划

/** 生效的项目日历规格（R-1：v0.1 只有 `project.baseCalendarId` 指向的那份生效）。 */
function effectiveCalendarSpec(document: ProjectDocument): CalendarSpec {
  const id = document.project.baseCalendarId;
  if (id !== '') {
    const found = document.calendars.find((spec) => spec.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return document.calendars[0] ?? {};
}

/**
 * 按 ADR 0004 §7 的容量口径构造排程日历（G3/G4/G7 都该用它，而不是各自拼）。
 *
 * - `baseDay` = 文档中最早的非空日期（`project.startDate` 与全部 `task.startDate`/`endDate` 取最小）；
 * - `spanDays` = `horizonDaysFor(文档日期跨度 + Σ叶子工期上界 + Σ正 lag)`；
 * - 用它构造的日历**永不触发 `compute` 的内部扩容**，因此调用方的 `isoOfOrdinal` 也不会越界。
 */
export function createScheduleCalendar(document: ProjectDocument): Calendar {
  const spec = effectiveCalendarSpec(document);
  let earliest: DayNumber | null = null;
  let latest: DayNumber | null = null;
  const consider = (iso: string | null): void => {
    if (iso === null) {
      return;
    }
    const day = isoToDayNumber(iso);
    if (earliest === null || day < earliest) {
      earliest = day;
    }
    if (latest === null || day > latest) {
      latest = day;
    }
  };

  consider(document.project.startDate);
  let plannedDays = 0;
  const isSummary = summaryTaskIds(document.tasks);
  for (const task of document.tasks) {
    consider(task.startDate);
    consider(task.endDate);
    if (isSummary.has(task.id)) {
      continue;
    }
    // 解析工期的上界：显式工期优先，否则用日期的自然日差（工作日数 ≤ 自然日数）。
    if (task.durationDays !== null) {
      plannedDays += Math.max(0, task.durationDays);
    } else if (task.startDate !== null && task.endDate !== null) {
      plannedDays += Math.max(0, isoToDayNumber(task.endDate) - isoToDayNumber(task.startDate));
    }
  }
  for (const link of document.links) {
    plannedDays += Math.max(0, link.lagDays);
  }

  const baseDay = earliest ?? isoToDayNumber(DEFAULT_PROJECT_BASE_DAY_ISO);
  const dateSpan = latest === null ? 0 : latest - baseDay + 1;
  const spanDays = horizonDaysFor(dateSpan + plannedDays, spec);
  return new Calendar(spec, { baseDay, spanDays });
}
