/**
 * 元素计数（ADR 0007 §6.7 的 `#elements ≤ c₁·visibleRows + c₂·visibleEdges + c₃`）。
 *
 * **计数口径必须与"真的发射了哪些元素"一致**，否则预算就是恒真式。因此这里的每一项都对应
 * 渲染器会创建的一个 SVG 元素（见 `browser/probe.mjs` 的同一份元素模型）：
 *
 * | 项 | 元素 | 何时发射 |
 * |---|---|---|
 * | 每渲染行 | `<g>` | 总是 |
 * | 叶子条 / 汇总条 | `<rect>` | 非里程碑行 |
 * | 里程碑 | `<polygon>` | 里程碑行（取代条） |
 * | 进度填充 | `<rect>` | 进度已知（汇总进度为 `NaN` 时不画） |
 * | 每条渲染边 | `<path>` + 箭头 `<polygon>` + 透明热区 `<path>` | 总是（热区是 ADR 0007 §5 的要求） |
 * | 轴 | 色带 `<rect>` / 网格线 `<line>` / 标签 `<text>` | 按档位与**视口水平范围**（与文档规模无关） |
 *
 * @typedef {import('./view-model.mjs').ViewModel} ViewModel
 */

import { ELEMENT_MODEL } from './manifest.mjs';

/**
 * @param {ViewModel} view
 */
export function countElements(view) {
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
  const bound =
    ELEMENT_MODEL.perRenderedRow * view.rows.length + ELEMENT_MODEL.perRenderedEdge * view.edges.length + axis;
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
    // 预算是否成立（§6.7）：实际元素数必须不超过上界。
    withinBudget: total <= bound,
    // 余量（上界内还剩多少元素）。模型是紧的 ⇒ 余量来自"里程碑行少一个矩形""进度缺失不画填充"。
    slack: bound - total,
  };
}

/**
 * 独立第二路计数（互证）：直接数"渲染器要发射的元素描述"的条数。
 *
 * 与 `countElements` 的差别在于**它从行/边描述里逐项枚举**，而不是按类别累加；
 * 两者必须逐项相等——否则计数逻辑本身有 bug（这是"计数不是恒真式"的第一道保险）。
 *
 * @param {ViewModel} view
 */
export function countElementsByEnumeration(view) {
  /** @type {string[]} */
  const emitted = [];
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
  return { total: emitted.length, kinds: tally(emitted) };
}

/** @param {readonly string[]} items */
function tally(items) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}
