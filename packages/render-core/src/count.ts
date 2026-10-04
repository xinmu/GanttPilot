/**
 * 元素计数（ADR 0007 §6.7 的 `#elements ≤ c₁·visibleRows + c₂·visibleEdges + c₃`；
 * **ADR 0008 §16.4 把 `c₄` 扩成 `3·rows + 12`**——裁决 P-32）。
 *
 * ## 为什么这个模块是"判据的承重墙"
 *
 * 计数口径必须与**渲染层真的发射了哪些元素**一致，否则预算就是恒真式。
 * 因此这里的每一项都对应 `apps/web` 的 `GanttChart.vue` 会创建的一个 SVG 元素：
 *
 * | 项 | 元素 | 何时发射 |
 * |---|---|---|
 * | 每渲染行 | `<g>` | 总是 |
 * | 叶子条 / 汇总条 | `<rect class="bar">` | 非里程碑行 |
 * | 里程碑 | `<polygon class="milestone">` | 里程碑行（取代条） |
 * | 进度填充 | `<rect>` | 进度已知（汇总进度为 `NaN` 时不画） |
 * | **每渲染行的端点手柄** | 2 × `<line class="handle">` | **有条形端的行**（非汇总、非里程碑） |
 * | **每渲染行的连接点** | 2 × `<rect class="connect-point">` | **有可画条形的行**（含汇总行、含里程碑） |
 * | 每条渲染边 | `<path>` + 箭头 `<polygon>` + 透明热区 `<path>` | 总是（热区是 §5 的要求） |
 * | 轴 | 色带 `<rect>` / 网格线 `<line>` / 标签 `<text>` | 按档位与**视口水平范围**（与文档规模无关） |
 *
 * **维护纪律（对 G5/G7 同样有效）**：改 `apps/web` 的 SVG 模板时，
 * 必须同步 {@link ELEMENT_MODEL} / {@link ELEMENT_MODEL_G5} 的常数，
 * 并让本模块的两路计数继续逐项相等——否则"元素数与文档总规模解耦"这句话就失去了载体。
 */

import { ELEMENT_MODEL, ELEMENT_MODEL_G5 } from './manifest.js';
import type { ViewModel } from './viewModel.js';

/**
 * G5 覆盖层的计数入参（不传即 0——覆盖层只在手势/高亮期间存在）。
 *
 * 与 `c₁`/`c₂`/`c₃` 的**根本区别**：这一组是**每帧的固定开销**，
 * 不随行数、边数或文档规模增长（ADR 0008 §11 的原文口径）。
 *
 * **注意（ADR 0008 §16.4／裁决 P-32）**：`c₄` 现在由**两部分**组成——
 * 本结构描述的是"**每帧固定**"那部分（`ELEMENT_MODEL_G5.overlay = 12`）；
 * 而"**每渲染行**"那部分（端点手柄 2 + 连接点 2 ≤ 3/行）是**结构性**的，
 * 由 {@link countElements} 直接按 `view.rows.length` 计入，**不在本结构的开关里**。
 * 后者仍与文档总规模无关——`rows ≤ 视口行数 + ROW_BUFFER`（ADR 0007 §6.1）。
 */
export interface OverlayCounts {
  /** 拖动覆盖层（轮廓 1 + 起止标记 ≤ 2）。 */
  readonly dragOverlay?: boolean;
  /** 建线预览（折线 1 + 箭头 1）。 */
  readonly linkPreview?: boolean;
  /** 冲突标红（描边 1）。 */
  readonly conflict?: boolean;
  /** 高亮集合的描边条数（行 1 条 / 边 1 条）。 */
  readonly highlightRows?: number;
  readonly highlightEdges?: number;
}

/** 覆盖层元素数（与 `apps/web` 的覆盖层模板**一一对应**，改模板必须改这里）。 */
export function countOverlays(overlays: OverlayCounts = {}): number {
  let count = 0;
  if (overlays.dragOverlay === true) count += 3; // 轮廓 + 两条起止标记
  if (overlays.linkPreview === true) count += 2; // 预览折线 + 箭头
  if (overlays.conflict === true) count += 1; // 冲突描边
  count += Math.max(0, overlays.highlightRows ?? 0);
  count += Math.max(0, overlays.highlightEdges ?? 0);
  return count;
}

/** 元素计数结果与预算判定。 */
export interface ElementCounts {
  readonly renderedRows: number;
  readonly renderedEdges: number;
  readonly rowGroups: number;
  readonly bars: number;
  readonly milestones: number;
  readonly progressFills: number;
  /** 端点手柄的元素数（**每渲染行 ≤ 2**，仅非汇总、非里程碑行）。 */
  readonly handles: number;
  /** 连接点的元素数（**每渲染行 2**，含汇总行与里程碑）。 */
  readonly connectPoints: number;
  readonly edgePaths: number;
  readonly edgeArrows: number;
  readonly edgeHitAreas: number;
  /** 轴元素总数（= `c₃`）。 */
  readonly axis: number;
  readonly axisBreakdown: { readonly bands: number; readonly gridlines: number; readonly labels: number };
  /** G5 覆盖层已发射的元素数（手势/高亮期，≤ `c₄` 的固定部分）。 */
  readonly overlays: number;
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
  /**
   * G5 的 `c₄`（ADR 0008 §16.4／裁决 P-32）：**每渲染行 6 + 每帧固定 12**。
   *
   * `c₄ = perRenderedRow · rows + overlay`，本字段给出**本视图**的该值
   * （因此它是"与文档总规模无关"的那一项：`rows` 由视口决定）。
   */
  readonly c4: number;
  /** `c₄` 里"每帧固定"的那部分（手势/高亮覆盖层）。 */
  readonly c4Fixed: number;
  readonly total: number;
  readonly bound: number;
  /** §6.7 + ADR 0008 §16.4：实际元素数必须不超过上界。 */
  readonly withinBudget: boolean;
  /** 余量（模型是紧的 ⇒ 余量来自"里程碑行少一个矩形""进度缺失不画填充""覆盖层未满"）。 */
  readonly slack: number;
}

/** 按类别累加的计数（第一路）。 */
export function countElements(view: ViewModel, overlays: OverlayCounts = {}): ElementCounts {
  let rowGroups = 0;
  let bars = 0;
  let milestones = 0;
  let progressFills = 0;
  let handles = 0;
  let connectPoints = 0;
  for (const row of view.rows) {
    rowGroups += 1;
    if (row.isMilestone) milestones += 1;
    else bars += 1;
    if (row.hasProgress) progressFills += 1;
    // ADR 0008 §16.2 的发射规则（与 `interaction.ts` 的 `rowHandlesFor` 同源：
    // 手柄只给**有条形端**的行；连接点给**有可画条形的行**，两侧对称）。
    if (!row.isMilestone && row.kind !== 'summary') handles += 2;
    connectPoints += 2;
  }

  const edgePaths = view.edges.length;
  const edgeArrows = view.edges.length;
  const edgeHitAreas = view.edges.length;

  let bands = 0;
  let gridlines = 0;
  let labels = 0;
  for (const element of view.axis) {
    if (element.kind === 'band') bands += 1;
    else if (element.kind === 'gridline') gridlines += 1;
    else labels += 1;
  }
  const axis = bands + gridlines + labels;
  const overlayElements = countOverlays(overlays);
  const total =
    rowGroups +
    bars +
    milestones +
    progressFills +
    handles +
    connectPoints +
    edgePaths +
    edgeArrows +
    edgeHitAreas +
    axis +
    overlayElements;
  const c4Fixed = ELEMENT_MODEL_G5.overlay;
  const c4 = ELEMENT_MODEL_G5.perRenderedRow * view.rows.length + c4Fixed;
  const bound =
    ELEMENT_MODEL.perRenderedRow * view.rows.length +
    ELEMENT_MODEL.perRenderedEdge * view.edges.length +
    axis +
    c4;

  return {
    renderedRows: view.rows.length,
    renderedEdges: view.edges.length,
    rowGroups,
    bars,
    milestones,
    progressFills,
    handles,
    connectPoints,
    edgePaths,
    edgeArrows,
    edgeHitAreas,
    axis,
    axisBreakdown: { bands, gridlines, labels },
    overlays: overlayElements,
    c1: ELEMENT_MODEL.perRenderedRow,
    c2: ELEMENT_MODEL.perRenderedEdge,
    c3: axis,
    c4,
    c4Fixed,
    total,
    bound,
    withinBudget: total <= bound,
    slack: bound - total,
  };
}

/**
 * **独立第二路**计数（互证）：直接枚举"渲染层要发射的元素描述"。
 *
 * 与 {@link countElements} 的差别在于它**从行/边描述里逐项枚举**，而不是按类别累加；
 * 两者必须逐项相等——否则计数逻辑本身有 bug（这是"计数不是恒真式"的第一道保险）。
 */
export function countElementsByEnumeration(
  view: ViewModel,
  overlays: OverlayCounts = {},
): {
  readonly total: number;
  readonly kinds: Readonly<Record<string, number>>;
} {
  const emitted: string[] = [];
  for (const row of view.rows) {
    emitted.push('row-group');
    if (row.isMilestone) emitted.push('milestone-polygon');
    else emitted.push('bar-rect');
    if (row.hasProgress) emitted.push('progress-rect');
    // G5 的手柄与连接点（ADR 0008 §16.2）：**逐项枚举**，必须与 `countElements` 的分类累加逐项相等。
    if (!row.isMilestone && row.kind !== 'summary') {
      emitted.push('row-handle-left');
      emitted.push('row-handle-right');
    }
    emitted.push('row-connect-point-left');
    emitted.push('row-connect-point-right');
  }
  for (let index = 0; index < view.edges.length; index += 1) {
    emitted.push('edge-path');
    emitted.push('edge-arrow');
    emitted.push('edge-hit-area');
  }
  for (const element of view.axis) emitted.push(`axis-${element.kind}`);

  // G5 覆盖层：**逐项枚举**，其条数必须与 `countOverlays` 的分类累加一致（两路互证）。
  if (overlays.dragOverlay === true) {
    emitted.push('overlay-drag-outline');
    emitted.push('overlay-drag-marker');
    emitted.push('overlay-drag-marker');
  }
  if (overlays.linkPreview === true) {
    emitted.push('overlay-link-path');
    emitted.push('overlay-link-arrow');
  }
  if (overlays.conflict === true) emitted.push('overlay-conflict');
  for (let index = 0; index < Math.max(0, overlays.highlightRows ?? 0); index += 1) {
    emitted.push('overlay-highlight-row');
  }
  for (let index = 0; index < Math.max(0, overlays.highlightEdges ?? 0); index += 1) {
    emitted.push('overlay-highlight-edge');
  }

  const kinds: Record<string, number> = {};
  for (const item of emitted) kinds[item] = (kinds[item] ?? 0) + 1;
  return { total: emitted.length, kinds };
}

/**
 * 预算常数 `c₃`：轴元素数**只与"视口宽 ÷ `pxPerDay`"有关**，与文档总规模无关（§11.1 ③）。
 *
 * 它是 {@link countElements} 的 `c3` 字段的同义入口，供只想拿常数的调用方使用
 * （例如验证"同一档位 + 同一视口下 `c₃` 恒定"）。
 */
export function budgetConstantFor(view: ViewModel): number {
  return countElements(view).c3;
}
