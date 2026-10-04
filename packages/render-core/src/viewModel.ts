/**
 * 几何真相源（ADR 0007 §2–§5 的可执行形式）。**纯函数、零 DOM、零 SVG 字符串**：
 * 只出数字、枚举与文本锚点；`apps/web` 与 G7 的导出投影都只消费它（铁律 #2 的载体）。
 *
 * 一处**有意偏离** ADR §2 的签名（已由 G4-S 记载并继承）：ADR 写的是 `ordinalAtX(view, x)`，
 * 而"序号"只有 `Calendar` 能算。为了让 `ViewModel` 保持"只有数字与枚举"（§2 的硬要求），
 * 这里把日历作为**显式入参**：{@link ordinalAtX}`(view, x, calendar)`。语义与 §3 的分工不变
 * （G4 出吸附候选、G5 决定何时吸附）。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import {
  axisOriginDayFor,
  buildAxis,
  isRenderedRow,
  rowWindow,
  selectEdges,
  type AxisElement,
  type ClipMode,
  type EdgeSelection,
  type RowWindow,
} from './clip.js';
import { rowIndexOfOrder, taskBounds, visibleRowOrder } from './domain.js';
import {
  AXIS_LEFT_GUTTER_DAYS,
  CONTENT_RIGHT_PAD_PX,
  EDGE_STUB_PX,
  EDGE_WRAP_PX,
  ROW_BUFFER,
  ROW_HEIGHT,
  SPACING,
  zoomPxPerDay,
  type ZoomKey,
} from './manifest.js';
import { routeEdge, routeSides, type RouteSide } from './route.js';

/** 视口：唯一的滚动/尺寸真相源（ADR 0007 §2 的 `Viewport` + 滚动位置）。 */
export interface Viewport {
  /** 内容坐标（不含表头）。 */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** SVG 视口宽（CSS 像素）。 */
  readonly width: number;
  readonly height: number;
  /** 固定行高（虚拟化前提）。 */
  readonly rowHeight: number;
  /** 渲染窗口在可见行上下各留的缓冲行数（ADR 0007 §6.1）。 */
  readonly rowBuffer: number;
}

/** 一行（**渲染窗口内**）的视图模型：渲染层只做"把数字写成 SVG 属性"。 */
export interface RowBox {
  /** 可见行序号。 */
  readonly row: number;
  /** 文档序索引（`Schedule` 的索引约定）。 */
  readonly docIndex: number;
  readonly id: string;
  readonly kind: 'leaf' | 'summary';
  readonly isMilestone: boolean;
  readonly es: number;
  readonly ef: number;
  /** 行顶（内容坐标）。 */
  readonly y: number;
  /** 条/进度矩形的顶（内容坐标）。 */
  readonly barY: number;
  readonly barHeight: number;
  readonly xLeft: number;
  readonly xRight: number;
  readonly hasProgress: boolean;
  readonly progressRatio: number;
  readonly progressWidth: number;
  /** 仅里程碑行：菱形中心与边长。 */
  readonly milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null;
  /** 样式键（ADR 0007 §11 第 7 项：被传播忽略的边用 `edge-ignored`；行侧为 `bar`/`bar-summary`/`milestone`）。 */
  readonly styleKey: 'bar' | 'bar-summary' | 'milestone';
}

/** 一条依赖线的视图模型。 */
export interface EdgeGeom {
  /** `document.links` 的下标。 */
  readonly linkIndex: number;
  readonly linkId: string;
  readonly type: string;
  /** 端点含汇总任务 ⇒ 传播忽略它（ADR 0007 §6.4），但**照画**、用样式区分。 */
  readonly ignored: boolean;
  readonly fromRow: number;
  readonly toRow: number;
  readonly fromDoc: number;
  readonly toDoc: number;
  /** 正交折线点列（首点 = 出端、末点 = 入端）。 */
  readonly points: readonly (readonly [number, number])[];
  readonly verticalX: number;
  readonly wrapped: boolean;
  readonly exitStubX: number;
  readonly enterStubX: number;
  /** 箭头朝向（+1 = +x）。 */
  readonly arrowDir: 1 | -1;
  /** `edge` / `edge-ignored`（ADR 0007 §11 第 7 项）。 */
  readonly styleKey: 'edge' | 'edge-ignored';
}

/** 视图模型：几何的唯一产出。 */
export interface ViewModel {
  readonly zoom: ZoomKey;
  readonly clipMode: ClipMode;
  readonly pxPerDay: number;
  readonly rowHeight: number;
  /** 轴线起点（自然日序号，可为负）。 */
  readonly axisOriginDay: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly width: number;
  readonly height: number;
  /**
   * **内容坐标系**下的横向范围（px）——滚动容器 spacer 的宽度，即"向右能滚到哪里"。
   *
   * 它由**文档的日期范围**（`Schedule.projectFinish`）推出，而不是由窗格宽推出
   * （ADR 0007 §15 / 裁决 P-24）：否则大项目只能滚到开头几十天。
   */
  readonly contentWidth: number;
  /** 可见行数（折叠过滤后）。 */
  readonly rowCount: number;
  readonly firstVisible: number;
  readonly visibleLast: number;
  readonly renderFirst: number;
  readonly renderLast: number;
  /** 可见行序列（**文档序索引**；左表按它渲染整列，不随窗口裁剪）。 */
  readonly order: readonly number[];
  /** 文档序索引 → 可见行序号（`-1` = 折叠隐藏）。 */
  readonly rowOfDocIndex: Int32Array;
  readonly rows: readonly RowBox[];
  readonly edges: readonly EdgeGeom[];
  readonly axis: readonly AxisElement[];
  /** 「跨屏长边」的 `links` 下标（判据与负向对照用）。 */
  readonly spanningEdges: readonly number[];
  /** 结构上不可画的边（端点悬空 / 被折叠隐藏）——与 `clipMode` 无关。 */
  readonly hiddenEdges: readonly number[];
  /** 端点不可解析的边数（合法文档 + 合法 `Schedule` 下应为 0）。 */
  readonly unroutableEdges: number;
}

/** 默认视口（与 ADR 0007 §11 的测量口径一致：1280×640 / 行高 24 / 缓冲 5）。 */
export const DEFAULT_VIEWPORT: Viewport = {
  width: 1280,
  height: 640,
  rowHeight: ROW_HEIGHT,
  rowBuffer: ROW_BUFFER,
  scrollTop: 0,
  scrollLeft: 0,
};

/**
 * 内容的横向范围（px）——滚动范围（spacer 宽）的**唯一真相源**（ADR 0007 §15）。
 *
 * ```
 * contentWidth = max(窗格宽, 最末任务右缘 + EDGE_STUB_PX + EDGE_WRAP_PX + CONTENT_RIGHT_PAD_PX)
 * 最末任务右缘   = (dayOfOrdinal(projectFinish − 1) + 1 − axisOriginDay) × pxPerDay
 * ```
 *
 * - 用 `Schedule.projectFinish`（**叶子**的最大排他完成序号）而不是扫行：O(1)，
 *   且与 §3 的右边界公式（`dayOfOrdinal(ef − 1) + 1`）同源；
 * - `projectFinish ≤ 0`（空文档/退化）时回落到窗格宽 ⇒ 不可滚，也不给负范围；
 * - `-1` 哨兵绝不可喂给 `dayOfOrdinal`（§3 的硬约束）。
 */
export function contentWidthFor(args: {
  readonly calendar: { dayOfOrdinal(ordinal: number): number };
  readonly projectFinish: number;
  readonly axisOriginDay: number;
  readonly pxPerDay: number;
  readonly viewportWidth: number;
}): number {
  const { calendar, projectFinish, axisOriginDay, pxPerDay, viewportWidth } = args;
  if (!Number.isFinite(projectFinish) || projectFinish <= 0) return viewportWidth;
  const lastDay = calendar.dayOfOrdinal(projectFinish - 1) + 1;
  const right = (lastDay - axisOriginDay) * pxPerDay + EDGE_STUB_PX + EDGE_WRAP_PX + CONTENT_RIGHT_PAD_PX;
  return Math.max(viewportWidth, Math.ceil(right));
}

/** {@link buildView} 的入参（形状照 ADR 0007 §2；`zoom` 决定 `pxPerDay` 与表头分组）。 */
export interface BuildViewArgs {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly viewport: Viewport;
  readonly zoom: ZoomKey;
  /** 默认 `'intersect'`；`'endpoints'` / `'none'` 是**负向对照**路径（见 `clip.ts` 文件头）。 */
  readonly clipMode?: ClipMode;
}

/**
 * 主入口：`文档 + Schedule + Calendar + 视口 → ViewModel`。
 *
 * **`-1` 哨兵绝不可喂给 `dayOfOrdinal`**：汇总行取 `summaryEs`/`summaryEf`、进度取
 * `summaryProgress`；没有叶子后代的空汇总**不产出行**（`taskBounds` 返回 `null`）。
 */
export function buildView(args: BuildViewArgs): ViewModel {
  const { document, schedule, calendar, viewport, zoom } = args;
  const clipMode: ClipMode = args.clipMode ?? 'intersect';
  const pxPerDay = zoomPxPerDay(zoom);
  const axisOriginDay = axisOriginDayFor({
    calendar,
    projectStartOrdinal: schedule.projectStart,
    zoom,
    gutterDays: AXIS_LEFT_GUTTER_DAYS,
  });

  const order = visibleRowOrder(document);
  const rowOfDocIndex = rowIndexOfOrder(order, document.tasks.length);
  const docIndexOfTask = new Map<string, number>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined) docIndexOfTask.set(task.id, index);
  }

  const win: RowWindow = rowWindow({
    rowCount: order.length,
    scrollTop: viewport.scrollTop,
    height: viewport.height,
    rowHeight: viewport.rowHeight,
    rowBuffer: viewport.rowBuffer,
  });

  const boundsFor = (docIndex: number): ReturnType<typeof taskBounds> =>
    taskBounds({
      document,
      schedule,
      calendar,
      rowOfDocIndex,
      axisOriginDay,
      pxPerDay,
      rowHeight: viewport.rowHeight,
      docIndex,
    });

  // -------- 行：**裁剪先于几何**（§6.5）——只对渲染窗口内的行算几何
  const rows: RowBox[] = [];
  for (let row = win.renderFirst; row <= win.renderLast; row += 1) {
    const docIndex = order[row];
    if (docIndex === undefined) continue;
    const task = document.tasks[docIndex];
    if (task === undefined) continue;
    const bounds = boundsFor(docIndex);
    if (bounds === null) continue;
    const y = row * viewport.rowHeight;
    const barHeight = viewport.rowHeight * (bounds.kind === 'summary' ? SPACING.summaryBarHeightRatio : SPACING.barHeightRatio);
    const barY = y + (viewport.rowHeight - barHeight) / 2;
    let hasProgress = false;
    let progressRatio = 0;
    if (bounds.kind === 'summary') {
      const value = schedule.summaryProgress[docIndex] ?? Number.NaN;
      if (Number.isFinite(value)) {
        hasProgress = true;
        progressRatio = clamp01(value);
      }
    } else if (!bounds.isMilestone && task.progress !== null && task.progress !== undefined) {
      hasProgress = true;
      progressRatio = clamp01(task.progress);
    }
    rows.push({
      row,
      docIndex,
      id: task.id,
      kind: bounds.kind,
      isMilestone: bounds.isMilestone,
      es: bounds.es,
      ef: bounds.ef,
      y,
      barY,
      barHeight,
      xLeft: bounds.xLeft,
      xRight: bounds.xRight,
      hasProgress: hasProgress && !bounds.isMilestone,
      progressRatio,
      progressWidth: (bounds.xRight - bounds.xLeft) * progressRatio,
      milestone: bounds.milestone,
      styleKey: bounds.kind === 'summary' ? 'bar-summary' : bounds.isMilestone ? 'milestone' : 'bar',
    });
  }

  // -------- 边：裁剪（行区间 ∩ 渲染窗口）先于几何
  const selection: EdgeSelection = selectEdges({
    links: document.links,
    docIndexOfTask,
    rowOfDocIndex,
    renderFirst: win.renderFirst,
    renderLast: win.renderLast,
    visibleFirst: win.firstVisible,
    visibleLast: win.visibleLast,
    mode: clipMode,
  });

  const edges: EdgeGeom[] = [];
  let unroutable = 0;
  for (const linkIndex of selection.ids) {
    const link = document.links[linkIndex];
    if (link === undefined) continue;
    const fromDoc = docIndexOfTask.get(link.from);
    const toDoc = docIndexOfTask.get(link.to);
    if (fromDoc === undefined || toDoc === undefined) {
      unroutable += 1;
      continue;
    }
    const fromBounds = boundsFor(fromDoc);
    const toBounds = boundsFor(toDoc);
    if (fromBounds === null || toBounds === null) {
      unroutable += 1;
      continue;
    }
    const sides: { readonly exit: RouteSide; readonly enter: RouteSide } = routeSides(link.type);
    const route = routeEdge({
      exitSide: sides.exit,
      enterSide: sides.enter,
      exitX: sides.exit === 'right' ? fromBounds.xRight : fromBounds.xLeft,
      enterX: sides.enter === 'right' ? toBounds.xRight : toBounds.xLeft,
      yFrom: fromBounds.y,
      yTo: toBounds.y,
    });
    const ignored = fromBounds.kind === 'summary' || toBounds.kind === 'summary';
    edges.push({
      linkIndex,
      linkId: link.id,
      type: link.type,
      ignored,
      fromRow: fromBounds.row,
      toRow: toBounds.row,
      fromDoc,
      toDoc,
      points: route.points,
      verticalX: route.verticalX,
      wrapped: route.wrapped,
      exitStubX: route.exitStubX,
      enterStubX: route.enterStubX,
      arrowDir: route.arrowDir,
      styleKey: ignored ? 'edge-ignored' : 'edge',
    });
  }

  const axis = buildAxis({
    calendar,
    axisOriginDay,
    pxPerDay,
    scrollLeft: viewport.scrollLeft,
    width: viewport.width,
    zoom,
  });

  return {
    zoom,
    clipMode,
    pxPerDay,
    rowHeight: viewport.rowHeight,
    axisOriginDay,
    scrollTop: viewport.scrollTop,
    scrollLeft: viewport.scrollLeft,
    width: viewport.width,
    height: viewport.height,
    contentWidth: contentWidthFor({
      calendar,
      projectFinish: schedule.projectFinish,
      axisOriginDay,
      pxPerDay,
      viewportWidth: viewport.width,
    }),
    rowCount: order.length,
    firstVisible: win.firstVisible,
    visibleLast: win.visibleLast,
    renderFirst: win.renderFirst,
    renderLast: win.renderLast,
    order,
    rowOfDocIndex,
    rows,
    edges,
    axis,
    spanningEdges: selection.spanning,
    hiddenEdges: selection.hidden,
    unroutableEdges: unroutable,
  };
}

/** 渲染出的行（**文档序索引**；ADR 0007 §2 的 `visibleRows`）。 */
export function visibleRows(view: ViewModel): readonly number[] {
  return view.rows.map((row) => row.docIndex);
}

/** 渲染出的边（**`links` 数组索引**；ADR 0007 §2 的 `visibleEdges`）。 */
export function visibleEdges(view: ViewModel): readonly number[] {
  return view.edges.map((edge) => edge.linkIndex);
}

/**
 * x 像素 → **自然日**序号（`DayNumber`，可为小数）。
 *
 * **`x` 是内容坐标**（与 `row.xLeft/xRight`、`points`、`bounds` 同一坐标系），因此这里
 * **不得**再加 `view.scrollLeft`：屏幕坐标先经 `pointerFromClient` 归一化成内容坐标
 * （ADR 0008 §13.1 的唯一入口：`x = clientX − paneLeft + scrollLeft`）。
 *
 * **历史坑（P-25 的 R14）**：本函数原来写的是 `(x + view.scrollLeft) / pxPerDay`——
 * 那是"指针来自 SVG 内 `offsetX`（窗口坐标）"时代的写法。自批次 A 把指针改成内容坐标后，
 * 这一项就变成了**重复计数**：`scrollLeft = 0` 处完全不可见（所有判据都取 0），
 * 而一旦向右滚动，反算结果就整体偏 `scrollLeft / pxPerDay` 天（实测 600 px ⇒ 偏 25 天），
 * 拖动候选随之"跳位"。判据：`geometryExpectations.spec` 的**滚动视图**往返、
 * `gesture.spec` 的滚动状态用例。
 */
export function dayAtX(view: ViewModel, x: number): number {
  return view.axisOriginDay + x / view.pxPerDay;
}

/**
 * x 像素 → **工作日序号**（吸附候选）。
 *
 * 口径：取 `x` 所在**自然日**（向下取整）的工作日序号 ⇒ 落在周末时得到的正是"下一个工作日"的序号，
 * 也就是一次吸附会落到的位置。**何时吸附由 G5 的手势状态机决定**（ADR 0007 §3 的分工）。
 *
 * 日历作为**显式入参**：`ViewModel` 只有数字与枚举，不持日历。
 */
export function ordinalAtX(view: ViewModel, x: number, calendar: Calendar): number {
  return calendar.ordinalOfDay(Math.floor(dayAtX(view, x)));
}

/** 某个文档序索引是否在渲染窗口内（左表按需取景用）。 */
export function isRowRendered(view: ViewModel, docIndex: number): boolean {
  return isRenderedRow(view.rowOfDocIndex, view.renderFirst, view.renderLast, docIndex);
}

/** 某可见行序号的竖向中心（内容坐标）。 */
export function rowCenterY(view: ViewModel, row: number): number {
  return row * view.rowHeight + view.rowHeight / 2;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
