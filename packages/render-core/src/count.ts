/**
 * 元素计数（ADR 0007 §6.7 的 `#elements ≤ c₁·visibleRows + c₂·visibleEdges + c₃`）。
 *
 * ## 为什么这个模块是"判据的承重墙"
 *
 * 计数口径必须与**渲染层真的发射了哪些元素**一致，否则预算就是恒真式。
 * 因此这里的每一项都对应 `apps/web` 的 `GanttChart.vue` 会创建的一个 SVG 元素：
 *
 * | 项 | 元素 | 何时发射 |
 * |---|---|---|
 * | 每渲染行 | `<g>` | 总是 |
 * | 叶子条 / 汇总条 | `<rect>` | 非里程碑行 |
 * | 里程碑 | `<polygon>` | 里程碑行（取代条） |
 * | 进度填充 | `<rect>` | 进度已知（汇总进度为 `NaN` 时不画） |
 * | 每条渲染边 | `<path>` + 箭头 `<polygon>` + 透明热区 `<path>` | 总是（热区是 §5 的要求） |
 * | 轴 | 色带 `<rect>` / 网格线 `<line>` / 标签 `<text>` | 按档位与**视口水平范围**（与文档规模无关） |
 *
 * **维护纪律（对 G5/G7 同样有效）**：改 `apps/web` 的 SVG 模板时，
 * 必须同步 {@link ELEMENT_MODEL} 的 `c₁` / `c₂`（G5 若给行加交互热区，**必须另加常数**），
 * 并让本模块的两路计数继续逐项相等——否则"元素数与文档总规模解耦"这句话就失去了载体。
 */

import { ELEMENT_MODEL } from './manifest.js';
import type { ViewModel } from './viewModel.js';

/** 元素计数结果与预算判定。 */
export interface ElementCounts {
  readonly renderedRows: number;
  readonly renderedEdges: number;
  readonly rowGroups: number;
  readonly bars: number;
  readonly milestones: number;
  readonly progressFills: number;
  readonly edgePaths: number;
  readonly edgeArrows: number;
  readonly edgeHitAreas: number;
  /** 轴元素总数（= `c₃`）。 */
  readonly axis: number;
  readonly axisBreakdown: { readonly bands: number; readonly gridlines: number; readonly labels: number };
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
  readonly total: number;
  readonly bound: number;
  /** §6.7：实际元素数必须不超过上界。 */
  readonly withinBudget: boolean;
  /** 余量（模型是紧的 ⇒ 余量来自"里程碑行少一个矩形""进度缺失不画填充"）。 */
  readonly slack: number;
}

/** 按类别累加的计数（第一路）。 */
export function countElements(view: ViewModel): ElementCounts {
  let rowGroups = 0;
  let bars = 0;
  let milestones = 0;
  let progressFills = 0;
  for (const row of view.rows) {
    rowGroups += 1;
    if (row.isMilestone) milestones += 1;
    else bars += 1;
    if (row.hasProgress) progressFills += 1;
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
  const total = rowGroups + bars + milestones + progressFills + edgePaths + edgeArrows + edgeHitAreas + axis;
  const bound = ELEMENT_MODEL.perRenderedRow * view.rows.length + ELEMENT_MODEL.perRenderedEdge * view.edges.length + axis;

  return {
    renderedRows: view.rows.length,
    renderedEdges: view.edges.length,
    rowGroups,
    bars,
    milestones,
    progressFills,
    edgePaths,
    edgeArrows,
    edgeHitAreas,
    axis,
    axisBreakdown: { bands, gridlines, labels },
    c1: ELEMENT_MODEL.perRenderedRow,
    c2: ELEMENT_MODEL.perRenderedEdge,
    c3: axis,
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
export function countElementsByEnumeration(view: ViewModel): {
  readonly total: number;
  readonly kinds: Readonly<Record<string, number>>;
} {
  const emitted: string[] = [];
  for (const row of view.rows) {
    emitted.push('row-group');
    if (row.isMilestone) emitted.push('milestone-polygon');
    else emitted.push('bar-rect');
    if (row.hasProgress) emitted.push('progress-rect');
  }
  for (let index = 0; index < view.edges.length; index += 1) {
    emitted.push('edge-path');
    emitted.push('edge-arrow');
    emitted.push('edge-hit-area');
  }
  for (const element of view.axis) emitted.push(`axis-${element.kind}`);

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
