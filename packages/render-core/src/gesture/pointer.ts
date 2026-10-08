/**
 * 坐标与命中：**屏幕坐标 → 内容坐标**的唯一换算（{@link pointerFromClient}）、条体命中
 * （{@link barHitFor}）、命中反算（{@link resolvePointerTarget}），以及拖动期的
 * **位移 → 工作日序号**换算（{@link dayDeltaFor} / {@link deltaFor} /
 * {@link candidateOrdinalFor} / {@link ordinalAtClamped}）。
 *
 * 纯内核里"纯几何"的那一层：只做算术与查表，零 DOM、零框架、零副作用。
 * 几何一律复用 `domain.ts`（`taskBounds` / `barXRange` / `milestoneCenterX`），**不重推公式**。
 *
 * 四条冻结口径与模块表见 [`./index.ts`](./index.ts)；ADR 0008 §13 的三处坐标订正
 * （R1 偏移物、R13 重复加 `scrollTop`、R7 抓取点）都落在本文件的注释里。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import { taskBounds, type TaskBounds } from '../domain.js';
import { HIT_TOLERANCE_PX } from '../manifest.js';
import { dayAtX, type ViewModel } from '../viewModel.js';
import type { DragMode } from '../zones.js';

/** 归一化指针输入：**绝不是** DOM 事件对象。 */
export interface PointerInput {
  /**
   * **内容坐标系**的 `x` / `y`：屏幕坐标必须先经 `pointerFromClient` 归一化
   * （`x = clientX − paneLeft + scrollLeft`、`y = clientY − paneTop + scrollTop`，ADR 0008 §13.1）。
   * 本包内**所有**几何消费方（`resolvePointerTarget`、`dayAtX`/`ordinalAtX`、`barHitFor`、
   * `dragModeFor`）都按内容坐标取值，**任何一处再叠加一次 `scroll*` 都是重复计数**
   * （P-25 的 R13/R14 就是这两处）。
   */
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
  readonly shiftKey?: boolean;
  /** `Esc` 被按下（取消手势）。 */
  readonly escPressed?: boolean;
}

/** {@link pointerFromClient} 的入参：**只有数字**（本包零 DOM，不收 `MouseEvent`/`DOMRect`）。 */
export interface ClientPointerArgs {
  readonly clientX: number;
  readonly clientY: number;
  /** 图表窗格（内容视口）左上角的**屏幕**坐标——即 `pane.getBoundingClientRect()` 的 `left`/`top`。 */
  readonly paneLeft: number;
  readonly paneTop: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly buttons: number;
  readonly shiftKey?: boolean;
  readonly escPressed?: boolean;
}

/**
 * **屏幕坐标 → 内容坐标**的唯一换算（ADR 0008 §13；P-22 批次 A 的 R1）。
 *
 * ```
 * x = clientX − paneLeft + scrollLeft
 * y = clientY − paneTop  + scrollTop
 * ```
 *
 * 为什么不能再用 `MouseEvent.offsetX` / `offsetY`：它们**相对事件目标元素**——
 * `mousedown` 落在条体 `<rect>` 上时目标就是那个条，于是 `offsetX ≈ 0` 被当成内容坐标，
 * 候选序号随即变成"鼠标所在的屏幕位置"（P-21 §2 的 R1）。
 * 归一化放在本包而不是组件里，是因为"入口层算出来的输入"正是 P-19/P-21 两次都漏掉的判据面。
 */
export function pointerFromClient(args: ClientPointerArgs): PointerInput {
  return {
    x: args.clientX - args.paneLeft + args.scrollLeft,
    y: args.clientY - args.paneTop + args.scrollTop,
    buttons: args.buttons,
    ...(args.shiftKey === true ? { shiftKey: true } : {}),
    ...(args.escPressed === true ? { escPressed: true } : {}),
  };
}

/**
 * 指针是否**命中条体**（ADR 0008 §13；P-22 批次 A 的 R2）。
 *
 * 判据只有横向一条：`x ∈ [xLeft − 容差, xRight + 容差]`。
 * - 里程碑的 `xLeft`/`xRight` 已经是**菱形包围盒**的左右界（`domain.ts` 的菱形分支），
 *   因此"含里程碑包围盒"不需要第二条规则；
 * - **竖向不设限**：行（固定行高，ADR 0007 §4）就是竖向单位——再加一条"必须落在条高内"
 *   只会新增"点在行内条的上下 3 px 就拖不动"的失败面，而它并不是复核指出的缺陷。
 */
export function barHitFor(args: {
  readonly bounds: TaskBounds;
  readonly x: number;
  readonly tolerancePx?: number;
}): boolean {
  const tolerance = args.tolerancePx ?? HIT_TOLERANCE_PX;
  return args.x >= args.bounds.xLeft - tolerance && args.x <= args.bounds.xRight + tolerance;
}

// ---------------------------------------------------------------- 命中反算

/** 命中结果（`resolvePointerTarget` 的产出）。 */
export interface HitTarget {
  readonly row: number;
  readonly docIndex: number;
  readonly taskId: string;
  readonly isMilestone: boolean;
  readonly isSummary: boolean;
  readonly bounds: TaskBounds;
}

/** `resolvePointerTarget` 的入参（`buildView` 的入参 + 指针）。 */
export interface ResolvePointerArgs {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly x: number;
  readonly y: number;
}

/**
 * 指针 → 命中行（`null` = 空白 / 缓冲行 / 越界）。
 *
 * 只认**渲染窗口内的可见行**：缓冲行与折叠隐藏行不可交互（ADR 0007 §6 的裁剪口径）。
 * 汇总行**可命中**（建线允许以汇总为端点，会得到 `edge-ignored` 样式；但不允许拖动，见 `beginGesture`）。
 */
export function resolvePointerTarget(args: ResolvePointerArgs): HitTarget | null {
  const { view, document, schedule, calendar } = args;
  // **`args.y` 已是内容坐标**（`pointerFromClient` 归一化时已加 `scrollTop`）⇒ 这里不得再加一次。
  // 历史坑（P-25 的 R13）：原来是 `(y + view.scrollTop) / rowHeight`，于是**一向下滚动就再也命不中**
  // （行号凭空多出 `scrollTop / rowHeight` 行、落到渲染窗口之外），而 `scrollTop = 0` 处完全正常。
  const row = Math.floor(args.y / view.rowHeight);
  if (!Number.isInteger(row) || row < view.renderFirst || row > view.renderLast) return null;
  const docIndex = view.order[row];
  if (docIndex === undefined) return null;
  const task = document.tasks[docIndex];
  if (task === undefined) return null;
  const bounds = taskBounds({
    document,
    schedule,
    calendar,
    rowOfDocIndex: view.rowOfDocIndex,
    axisOriginDay: view.axisOriginDay,
    pxPerDay: view.pxPerDay,
    rowHeight: view.rowHeight,
    docIndex,
  });
  if (bounds === null) return null;
  return {
    row,
    docIndex,
    taskId: task.id,
    isMilestone: bounds.isMilestone,
    isSummary: bounds.kind === 'summary',
    bounds,
  };
}

// ---------------------------------------------------------------- 位移与候选序号

/** 档位无关的"移动量 → 天数"换算（拖动时用整日拖动，避免半像素抖动）。 */
export function dayDeltaFor(view: ViewModel, deltaX: number): number {
  return deltaX / view.pxPerDay;
}

/**
 * 当前指针相对**抓取点**的工作日位移（ADR 0008 §13 的唯一换算处）。
 *
 * 两个序号都由 {@link ordinalAtClamped} 产出（越界夹回边界，不抛错），因此
 * "指针拖出地平线"不会让位移变成 `NaN`，而是停在一个有界值上。
 */
export function deltaFor(args: {
  readonly view: ViewModel;
  readonly calendar: Calendar;
  readonly pointerX: number;
  readonly grabOrdinal: number;
}): number {
  return ordinalAtClamped(args.view, args.pointerX, args.calendar) - args.grabOrdinal;
}

/**
 * 候选序号：**按模式**给基线再加位移（ADR 0008 §13 的语义表）。
 *
 * - `move` / `resize-start`：基线 = 原**开始**序号（`originOrdinal`）；
 * - `resize-duration`：基线 = 原**完成**序号，即 `originOrdinal + max(1, D) − 1`。
 *   零时长任务（里程碑）的基线因此是 `originOrdinal` 本身（它"占着"一个工作日格），
 *   于是"把它往右拖到第 n 天"得到 n 个工作日的工期（`dragModeFor` 对里程碑右半区的注释正是这个意思）；
 *   而**按下不动**由 {@link resolveDragOutcome} 的"零位移"分支兜住，不会把里程碑变成 1 天。
 *
 * **不在这里夹取**：夹取按模式分工在 {@link dragCandidate}（`snap` 的上界）与
 * {@link resolveDragOutcome}（结果的 0 下界）里做，以免把"位移"与"结果"混在一起算。
 */
export function candidateOrdinalFor(args: {
  readonly mode: DragMode;
  readonly originOrdinal: number;
  readonly durationDays: number;
  readonly delta: number;
}): number {
  if (args.mode === 'resize-duration') {
    return args.originOrdinal + Math.max(1, args.durationDays) - 1 + args.delta;
  }
  return args.originOrdinal + args.delta;
}

/**
 * 在日历的地平线内安全地取 `x` 处的工作日序号（越界时**夹回边界**，不抛错）。
 *
 * ## 为什么必须先用 `dayAtX` 把 `x` 夹成**自然日**（白屏缺陷的根因，2026-10-05）
 *
 * 旧实现是"先算序号、抛错后按 `x <= 0` 猜方向"：
 *
 * ```ts
 * try { return calendar.ordinalOfDay(Math.floor(dayAtX(view, x))); }   // ← 左侧越界时抛
 * catch { return x <= 0 ? 0 : lastOrdinal; }                            // ← 猜方向
 * ```
 *
 * 两处都错，且**只有向左拖动时才现形**：
 * 1. `Calendar.ordinalOfDay(day)` 对 `day < baseDay` **抛错**（G1.1 冻结：负序号无定义），
 *    而 `baseDay` 左侧在屏幕上**不是 `x <= 0`**——轴线起点 = `dayOfOrdinal(projectStart) − gutter`，
 *    因此"条体左缘左边的正常位置"（`x` 仍是正数）已经落在 `baseDay` 左侧 ⇒ 抛错；
 * 2. catch 于是把这种 x 判成"向右越界"，返回**最右序号**（日档下 = `workdayCount − 1`）。
 *    ⇒ 向左拖动 96 px 会把候选**甩到约 130 个工作日之后**（实测 4 → 94），
 *    patch 写成远期日期，`compute` 的完成序号随即超出调用方日历的容量，
 *    渲染期 `buildView` 抛 `RangeError` ⇒ **Vue 整棵树卸载、页面全白**（人工报障 2026-10-05）。
 *
 * 新实现只做两件事：**先用唯一的反算式 `dayAtX` 得到自然日，把日夹进可表示域，再算序号**。
 * 于是"越界"退化成一次钳制，不再需要猜方向，也不会返回地平线的另一端。
 *
 * **为什么在日这一层夹、而不是在序号那一层夹**：`ordinalOfDay` 是"自然日 → 序号"的唯一口径
 * （含周末吸附：落在周末的日会吸附到下一个工作日）。先算序号再夹会丢掉这层语义，
 * 并让"哪一天"与"哪个序号"两套边界各写一遍——那正是 R13/R14 的同族陷阱。
 */
export function ordinalAtClamped(view: ViewModel, x: number, calendar: Calendar): number {
  const firstDay = calendar.baseDay;
  const lastDay = calendar.dayOfOrdinal(Math.max(0, calendar.workdayCount - 1));
  const day = Math.floor(dayAtX(view, x));
  const clamped = Math.min(Math.max(day, firstDay), lastDay);
  return Math.min(Math.max(calendar.ordinalOfDay(clamped), 0), Math.max(0, calendar.workdayCount - 1));
}
