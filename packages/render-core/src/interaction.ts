/**
 * 交互几何：**判定区 → 端点手柄 / 连接点 → 光标提示 → 建线起手位置**（ADR 0008 §16，裁决 P-32）。
 *
 * ## 依赖方向（为什么判定区在 `zones.ts` 而不在这里）
 *
 * §16.1 把判定区公式定为**唯一一条**，而它的消费者分布在一个环上：`gesture.ts` 用它决定拖动语义，
 * 本模块用它决定手柄位置与光标提示。因此公式自己住一层（`zones.ts`），本模块只做**派生**：
 *
 * ```
 * zones.ts（唯一公式）──┬── gesture.ts（拖动语义、连接点前置）
 *                      └── interaction.ts（手柄 / 连接点 / 光标 / 建线类型）── apps/web
 * ```
 *
 * ## 为什么手柄落在"判定区边界"而不是"条的两端"
 *
 * P-21 的 R3 是"没有可拖动区域的视觉暗示"。若在条的两端画小方块，就立刻产生**第二个真相源**
 * （视觉端点 vs 判定区边界），窄条上尤其明显：月档 1 个工作日的条只有 3 px，
 * 两端各画一个 2 px 方块就把它铺满了，而判定区此时已退化成"只在一点上有端点区"。
 * 因此手柄 x = `zones.edgeL.x2` / `zones.edgeR.x1`——**"看起来能抓的那一点"与"真的按判定区分类的那一点"
 * 是同一个数**，窄条两端退到同一处也就**如实可见**。
 *
 * ## 坐标口径（ADR 0007 §16）
 *
 * 本模块的入参 `pointer.x/y` 与全部返回值都是**内容坐标**；
 * **不得再叠加 `scrollLeft` / `scrollTop`**（P-25 的 R13/R14 就是这两处）。
 *
 * ## 零 DOM / 零框架
 *
 * 光标提示是**枚举**（`CursorHint`），由 `apps/web` 赋给 `style.cursor`——
 * 这样"入口层算出来的输入"留在门禁里（P-19/P-21 两次的教训）。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import { taskBounds, type TaskBounds } from './domain.js';
import {
  barHitFor,
  resolvePointerTarget,
  type PointerInput,
} from './gesture.js';
import {
  CONNECT_REVEAL_FACTOR,
  CONNECT_SIZE_PX,
  HANDLE_HEIGHT_PX,
  HIT_TOLERANCE_PX,
  SPACING,
} from './manifest.js';
import type { ViewModel } from './viewModel.js';
import {
  cursorForZone,
  dragModeOfZones,
  zonesFor,
  type CursorHint,
  type DragZones,
} from './zones.js';

/**
 * 判定区/光标/建线类型（`zones.ts`）由本包公共入口（`index.ts`）暴露，本模块**不重复导出**——
 * 否则同一个符号会有两条公共路径，而那正是本仓库反复禁止的"第二个真相源"。
 */

/** 端点手柄的几何（内容坐标）。 */
export interface Handle {
  readonly side: 'left' | 'right';
  /** 手柄的 x（= **判定区边界**，见 {@link handleXFor}）。 */
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
}

/** 连接点的几何（内容坐标）。 */
export interface ConnectPoint {
  readonly side: 'left' | 'right';
  /** 连接点的**左缘** x。 */
  readonly x: number;
  /** 连接点的竖向中心。 */
  readonly y: number;
  readonly size: number;
}

/** 一行要画的交互图元（ADR 0008 §16.2）。 */
export interface RowHandles {
  readonly taskId: string;
  readonly row: number;
  readonly xLeft: number;
  readonly xRight: number;
  readonly y: number;
  readonly barHeight: number;
  /** 端点手柄：**有条形端**才有（汇总行、里程碑都没有）。 */
  readonly handles: readonly Handle[];
  /** 连接点：**有可画条形的行**都有（含汇总行与里程碑，两侧对称）。 */
  readonly connectPoints: readonly ConnectPoint[];
}

// ---------------------------------------------------------------- 手柄与连接点（§16.2）

/**
 * 端点手柄的 x：**判定区的外缘**（`edgeL` 的右端 / `edgeR` 的左端）。
 *
 * 里程碑与退化条没有条形端 ⇒ `null`（调用方据此不发射该侧手柄）。
 */
export function handleXFor(zones: DragZones, bounds: TaskBounds, side: 'left' | 'right'): number | null {
  if (bounds.isMilestone) return null;
  if (side === 'left') return zones.edgeL === null ? null : zones.edgeL.x2;
  return zones.edgeR === null ? null : zones.edgeR.x1;
}

/** 一行的条高（竖向居中由 `bounds.y` 表达）。 */
export function barHeightOf(bounds: TaskBounds, rowHeight: number): number {
  if (bounds.isMilestone) return rowHeight * SPACING.milestoneSizeRatio;
  return rowHeight * (bounds.kind === 'summary' ? SPACING.summaryBarHeightRatio : SPACING.barHeightRatio);
}

/**
 * 一行的交互图元（ADR 0008 §16.2 的表）。
 *
 * | 图元 | 数量 | 何时发射 |
 * |---|---|---|
 * | 端点手柄 | 2 | **有条形端**的行（非汇总、非里程碑） |
 * | 连接点 | 2 | **有可画条形的行**（含汇总行、含里程碑） |
 *
 * **每渲染行 ≤ 3 个元素**——这正是 `ELEMENT_MODEL_G5.perRenderedRow = 3` 的来源
 * （`count.ts` 的两路计数必须与本函数逐项对应）。
 */
export function rowHandlesFor(args: {
  readonly taskId: string;
  readonly bounds: TaskBounds;
  readonly rowHeight: number;
  /**
   * **条形/菱形的竖向中心**（内容坐标）。
   *
   * **必须由调用方给**（`row.barY + row.barHeight / 2`），不能用 `bounds.y`：
   * 两个类型的 `y` 语义**不同**——`TaskBounds.y` 是"条/菱形竖向中心"，而 `RowBox.y` 是**行顶**
   * （`viewModel.ts` 的注释如此，`barY` 才是条的顶）。
   *
   * 这正是 P-32 第二次人工复验（2026-10-04）的两条报文的根因：
   * "两端仍有向上的突起"与"连接点仍偏上"——渲染层把**行顶**当成了条心，
   * 于是手柄画在 `行顶 ± 2`（浮在条体上方 4.8 px、与条体不相连）、连接点也整体上移了 12 px。
   * 省略时回落到 `bounds.y`（`TaskBounds` 的语义本来就是条心，供纯函数与判据使用）。
   */
  readonly barCenterY?: number;
}): RowHandles {
  const { bounds, rowHeight } = args;
  const zones = zonesFor(bounds);
  const y = args.barCenterY ?? bounds.y;
  const half = HANDLE_HEIGHT_PX / 2;
  const hasBarEnds = !bounds.isMilestone && bounds.kind !== 'summary';

  const handles: Handle[] = [];
  if (hasBarEnds) {
    const leftX = handleXFor(zones, bounds, 'left');
    const rightX = handleXFor(zones, bounds, 'right');
    if (leftX !== null) handles.push({ side: 'left', x: leftX, y1: y - half, y2: y + half });
    if (rightX !== null) handles.push({ side: 'right', x: rightX, y1: y - half, y2: y + half });
  }

  // 连接点**两侧对称**（§16.2）：内缘与条端对齐、整体向**外**伸（P-32 人工复验的订正）。
  // 汇总行只有连接点（可作建线端点、不可拖）；里程碑同理（菱形的"端"不是条形的端）。
  const connectPoints: ConnectPoint[] = [
    { side: 'left', x: connectLeftEdgeFor(bounds, 'left'), y, size: CONNECT_SIZE_PX },
    { side: 'right', x: connectLeftEdgeFor(bounds, 'right'), y, size: CONNECT_SIZE_PX },
  ];

  return {
    taskId: args.taskId,
    row: bounds.row,
    xLeft: bounds.xLeft,
    xRight: bounds.xRight,
    y,
    barHeight: barHeightOf(bounds, rowHeight),
    handles,
    connectPoints,
  };
}

// ---------------------------------------------------------------- 光标提示（§16.2）

/** {@link cursorForPointer} / {@link linkEntryFor} 的公共入参。 */
export interface PointerGeometryArgs {
  readonly point: PointerInput;
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
}

/**
 * 连接点的**左缘 x**（渲染层直接把它写进 `<rect x>`）。
 *
 * 右点 = `xRight`（内缘贴条端，向外伸 `CONNECT_SIZE_PX`）；
 * 左点 = `xLeft − CONNECT_SIZE_PX`。
 * **"看得见的方块一定点得中"**：命中区 = 方块本身 ± 外缘的 `HIT_TOLERANCE_PX`（见 {@link connectSideAt}）。
 */
export function connectLeftEdgeFor(bounds: { readonly xLeft: number; readonly xRight: number }, side: 'left' | 'right'): number {
  return side === 'right' ? bounds.xRight : bounds.xLeft - CONNECT_SIZE_PX;
}

/**
 * 指针是否落在某个连接点的**命中区**上（返回所抓的那一侧；`null` = 不在任何连接点上）。
 *
 * 命中区（ADR 0008 §16.2／P-32 复验的订正）：
 *
 * ```
 * 右点：[xRight − HIT_TOLERANCE_PX, xRight + CONNECT_SIZE_PX + HIT_TOLERANCE_PX]
 * 左点：[xLeft − CONNECT_SIZE_PX − HIT_TOLERANCE_PX, xLeft + HIT_TOLERANCE_PX]
 * ```
 *
 * 即**有向容差**：方块**内侧**只留 `HIT_TOLERANCE_PX`（不抢端点手柄的判定区），
 * **外侧**留 `CONNECT_SIZE_PX + HIT_TOLERANCE_PX`（覆盖整个可见方块）。
 * 初版是"以一条线为中心的 ± 容差"，与可见方块不重合 ⇒ 按"看到的位置"点下去落空
 * （P-32 的人工复验第 3.3 条）。
 */
export function connectSideAt(bounds: TaskBounds, x: number): 'left' | 'right' | null {
  if (x >= bounds.xRight - HIT_TOLERANCE_PX && x <= bounds.xRight + CONNECT_SIZE_PX + HIT_TOLERANCE_PX) {
    return 'right';
  }
  if (x >= bounds.xLeft - CONNECT_SIZE_PX - HIT_TOLERANCE_PX && x <= bounds.xLeft + HIT_TOLERANCE_PX) {
    return 'left';
  }
  return null;
}

/**
 * 指针是否"靠近条端"（⇒ 该行的连接点应当显示；ADR 0008 §16.2 的可见性）。
 *
 * **判据是"命中区向外扩一圈"，不是"以条端为中心的一条带"**——这一点初稿写错了，
 * 由判据当场抓出（`connectRevealFor(条中部)` 返回了 `true`）：`x <= xRight + reach || x >= xLeft − reach`
 * 对**条内的任何一点**都成立（它只约束了一侧）。正确的关系是
 * **显示区 ⊇ 命中区**（看得见的方块 === 点得中的区域），因此直接用同两个带、把容差乘以
 * `CONNECT_REVEAL_FACTOR` 即可：指针离开方块一个容差的距离，方块消失。
 */
export function connectRevealFor(bounds: TaskBounds, x: number): boolean {
  const reach = HIT_TOLERANCE_PX * CONNECT_REVEAL_FACTOR;
  return (
    (x >= bounds.xRight - reach && x <= bounds.xRight + CONNECT_SIZE_PX + reach) ||
    (x >= bounds.xLeft - CONNECT_SIZE_PX - reach && x <= bounds.xLeft + reach)
  );
}

/** 指针是否落在**本条**的条体上（连接点显示与否的前置：行内、且靠近条端）。 */
export function rowConnectVisibleAt(bounds: TaskBounds, x: number, insideRow: boolean): boolean {
  return insideRow && connectRevealFor(bounds, x);
}

/**
 * 指针处的光标提示（**纯函数**，`apps/web` 只做赋值）。
 *
 * 顺序即语义：① **连接点**（§16.3 的建线起手位置）⇒ `crosshair`；
 * ② 条体上的判定区 ⇒ `col-resize` / `move`；③ 其余（空白、行外、条外）⇒ `default`。
 *
 * **为什么连接点优先**：连接点的命中区**向内**只伸 `HIT_TOLERANCE_PX = 2 px`（§16.2），
 * 在宽条上与端点判定区**不相交**；但在**窄条**上（端点区退化成点）两者会重叠——
 * 那里"这一点还能拉线"比"再往里 2 px 才能改工期"更贴用户意图（且端点区本来就能从条端内侧取到）。
 */
export function cursorForPointer(args: PointerGeometryArgs): CursorHint {
  const target = targetOf(args);
  if (target === null) return 'default';
  if (connectSideAt(target.bounds, args.point.x) !== null) return cursorForZone('link-out');
  if (!barHitFor({ bounds: target.bounds, x: args.point.x })) return 'default';
  return cursorForZone(dragModeOfZones(target.bounds, zonesFor(target.bounds), args.point.x));
}

// ---------------------------------------------------------------- 建线的起手位置（§16.3）

/** {@link linkEntryFor} 的产出：从哪个任务的哪一侧出线。 */
export interface LinkEntry {
  readonly taskId: string;
  readonly docIndex: number;
  readonly row: number;
  readonly exitSide: 'left' | 'right';
  readonly bounds: TaskBounds;
}

/**
 * 指针是否落在某行的**连接点**上（是 ⇒ 建线手势的起手位置，ADR 0008 §16.3）。
 *
 * **出端侧由所抓的连接点决定**（用户的显式选择），不由几何反推——这是 R4 的修法：
 * `Alt` 不再是入口，出端侧也不再需要"靠相对位置猜"。
 * 汇总行**允许**作为出端（§5/§13 的既有口径：汇总可作建线端点）。
 */
export function linkEntryFor(args: PointerGeometryArgs): LinkEntry | null {
  const target = targetOf(args);
  if (target === null) return null;
  const side = connectSideAt(target.bounds, args.point.x);
  if (side === null) return null;
  return {
    taskId: target.taskId,
    docIndex: target.docIndex,
    row: target.row,
    exitSide: side,
    bounds: target.bounds,
  };
}

function targetOf(args: PointerGeometryArgs): { readonly taskId: string; readonly docIndex: number; readonly row: number; readonly bounds: TaskBounds } | null {
  return resolvePointerTarget({
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    x: args.point.x,
    y: args.point.y,
  });
}

// ---------------------------------------------------------------- 建线类型（§16.3 的四格表）

/**
 * 建线类型与端点 x 的**实现**在 `zones.ts`（同一层理由：`gesture.ts` 也要用它们，
 * 而 `gesture` 不得反向依赖本模块）。它们与判定区一起由本包的公共入口（`index.ts`）暴露；
 * 本模块**不重复导出**，以免出现第二个"公共面"。
 */

// ---------------------------------------------------------------- 记录制：手柄的存在性检查

/**
 * 每个渲染行**应当**发射的手柄/连接点条数（**记录制**用：`--drag` 在打包产物上核对）。
 *
 * 为什么放在本包：`apps/web` 没有判据入口（P-19 遗留 3），而"手柄是否真的发射了"
 * 是**可从 `ViewModel` + 文档判定**的（渲染行 + 行高 ⇒ 每行的图元数）。
 * 记录制只负责把 DOM 上的实测条数喂给这里比对。
 */
export function handleOffsetsFor(args: {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
}): readonly {
  readonly taskId: string;
  readonly handleCount: number;
  readonly connectCount: number;
}[] {
  const out: { taskId: string; handleCount: number; connectCount: number }[] = [];
  for (const row of args.view.rows) {
    const bounds = taskBounds({
      document: args.document,
      schedule: args.schedule,
      calendar: args.calendar,
      rowOfDocIndex: args.view.rowOfDocIndex,
      axisOriginDay: args.view.axisOriginDay,
      pxPerDay: args.view.pxPerDay,
      rowHeight: args.view.rowHeight,
      docIndex: row.docIndex,
    });
    if (bounds === null) continue;
    const handles = rowHandlesFor({ taskId: row.id, bounds, rowHeight: args.view.rowHeight });
    out.push({ taskId: row.id, handleCount: handles.handles.length, connectCount: handles.connectPoints.length });
  }
  return out;
}
