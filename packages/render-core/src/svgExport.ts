/**
 * **语义化 SVG 导出**（ADR 0010 §4）。纯字符串、零 DOM，**进 `pnpm gate`**。
 *
 * ## 与屏幕 SVG 的关系
 *
 * 屏幕上的 SVG 由 `apps/web` 的模板写出来（`GanttChart.vue`），它包含**交互图元**
 * （端点手柄、连接点、透明热区、拖动/建线/冲突/成环覆盖层）——那些**一律不导出**。
 * 本模块只画"这是一张图"该有的东西：日期轴、行、依赖线；可选图例与摘要。
 *
 * 几何**一个数字都不新造**：全部取自 `ViewModel`（`row.xLeft/xRight/barY/barHeight`、
 * `row.milestone`、`edge.points`、`edge.arrowDir`），箭头多边形取自 `route.ts` 的 `arrowPolygons`
 * （与屏幕同一处），颜色常量与屏幕同值。因此"所见 = 所导出"是**几何同源**，不是截屏。
 *
 * ## 两条工程纪律
 *
 * - **整数坐标**：一律 `Math.round`。浮点串会让 golden 比对变成噪声探测（ADR 0010 §4）；
 * - **不含时间戳/随机 id**：同一份输入两次调用必须**逐字符相等**（进 gate 的判据）。
 */

import type { ProjectDocument } from '@ganttpilot/engine';

import { EXPORT_LABEL_FONT_PX, EXPORT_LABEL_WIDTH_PX } from './exportView.js';
import { EXPORT_AXIS_FONT_PX } from './exportView.js';
import { exportLabelOf } from './exportLabels.js';
import { exportLegendItems, exportSummaryLines, type ExportSummary } from './exportSummary.js';
import {
  AXIS_BAND_FILL,
  AXIS_GRIDLINE_STROKE,
  AXIS_MAJOR_BODY_FILL,
  AXIS_MAJOR_EDGE,
  AXIS_MAJOR_HEADER_FILL,
  BAR_FILL,
  BAR_SUMMARY_FILL,
  HEADER_HEIGHT_PX,
  MAJOR_LABEL_BASELINE_PX,
  MINOR_LABEL_BASELINE_PX,
} from './manifest.js';
import { arrowPolygons } from './route.js';
import type { EdgeGeom, RowBox, ViewModel } from './viewModel.js';

/**
 * 颜色常量（与屏幕同值；ADR 0010 §4 的"同源"）。
 *
 * 轴的**三层视觉**各自一个字段，名字与 `manifest.ts` 的 `AXIS_*` 单点常量一一对应
 * （`band` = `AXIS_BAND_FILL`、`majorBody` = `AXIS_MAJOR_BODY_FILL`、
 * `majorHeader` = `AXIS_MAJOR_HEADER_FILL`、`majorEdge` = `AXIS_MAJOR_EDGE`、
 * `gridline` = `AXIS_GRIDLINE_STROKE`）——**谁是整高、谁先画**见 `svgString` 的轴注释。
 */
const COLOR = {
  band: AXIS_BAND_FILL,
  gridline: AXIS_GRIDLINE_STROKE,
  axisText: '#667085',
  /** 上级分段带的**正文**（近乎白：它整高覆盖全宽，不能与周末带抢对比度）。 */
  majorBody: AXIS_MAJOR_BODY_FILL,
  /** 上级分段带的**表头底**（比正文明显一档，一眼看出"这是哪个月"）。 */
  majorHeader: AXIS_MAJOR_HEADER_FILL,
  /** 上级分段的**边界线**（全高；"月的边界"比刻度线醒目）。 */
  majorEdge: AXIS_MAJOR_EDGE,
  rowText: '#1f2933',
  bar: BAR_FILL,
  barSummary: BAR_SUMMARY_FILL,
  progress: '#1f4e79',
  milestone: '#ed7d31',
  milestoneStroke: '#b1551a',
  edge: '#475467',
  edgeIgnored: '#c9ccd1',
  hollowFill: '#ffffff',
  legendBg: '#fcfcfd',
} as const;

/** 导出物里下级刻度线的长度（px）——与屏幕的 `TICK_LENGTH_PX` 同值（"刻度只属于刻度区"）。 */
export const EXPORT_TICK_LENGTH_PX = 6;

/** 侧栏（图例 + 摘要）宽度（px）；`svgString` 与适配公式共用。 */
export const EXPORT_SIDEBAR_WIDTH_PX = 260;

/** 侧栏与绘制区之间的间距（px）。 */
export const EXPORT_SIDEBAR_GAP_PX = 12;

/** {@link svgString} 的可选项。 */
export interface SvgExportOptions {
  readonly title?: string;
  /** 附图例（导出面板的开关；模板 A 固定含）。 */
  readonly includeLegend?: boolean;
  /** 附自动摘要（需同时给 `summary`）。 */
  readonly includeSummary?: boolean;
  readonly summary?: ExportSummary;
}

/** {@link svgString} 的入参。 */
export interface SvgExportArgs {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly options?: SvgExportOptions;
}

/**
 * XML 转义（**本仓库的唯一实现**；P3/C3 起 `pptx-renderer` 的属性转义 `attr()` 也走这里）。
 *
 * 五个字符都转：文本节点与属性值共用同一份，因此属性里出现的 `'` 也会变成 `&apos;`
 * （合法实体，XML 解析器等价处理）。
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * **整数 px 舍入**（导出坐标的口径，ADR 0010 §4：浮点串会让 golden 比对变成噪声探测）。
 *
 * 别与 `align.ts` 的 `roundSubPx`（保留 3 位小数的亚像素舍入）混用——两者曾经同名异义。
 */
function roundPx(value: number): number {
  return Math.round(value);
}

/** 点串 → `<polygon points>`（整数化）。 */
function pointsAttr(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${String(roundPx(x))},${String(roundPx(y))}`).join(' ');
}

/** 折线点列 → `<path d>`（整数化）。 */
function pathData(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${String(roundPx(x))} ${String(roundPx(y))}`).join('');
}

/** 箭头填充形态：SS/SF 空心、FS/FF 实心（`ARROW_FILL` 的口径）。 */
function arrowForm(edge: EdgeGeom): 'solid' | 'hollow' {
  return edge.type === 'SS' || edge.type === 'SF' ? 'hollow' : 'solid';
}

/**
 * 图例里"依赖线"那一格的图元：短线 + **与真实箭头同形态的箭头**（FS/FF 实心、SS/SF 空心）。
 *
 * 为什么要在图例里画出箭头：图例的职责是"教会读者看图"。若图例只画一条灰线，
 * 四类关系的实心/空心差别就没被解释（人工复验第 4 条"图例摘要与 SVG/PNG 内容不一致"的同类问题）。
 */
function legendEdgeSwatch(x: number, y: number, styleKey: string): string {
  const type = styleKey.replace('edge-', '');
  const fill = type === 'SS' || type === 'SF' ? 'hollow' : 'solid';
  const tipX = x + 26;
  const [origin, left, right] = arrowPolygons({ dir: 1, fill }).outer;
  const arrow = pointsAttr([
    [tipX + origin[0], y + origin[1]],
    [tipX + left[0], y + left[1]],
    [tipX + right[0], y + right[1]],
  ]);
  return (
    `<line x1="${String(roundPx(x))}" y1="${String(roundPx(y))}" x2="${String(roundPx(tipX - 8))}" y2="${String(roundPx(y))}" stroke="${COLOR.edge}" stroke-width="1"/>` +
    `<polygon points="${arrow}" fill="${fill === 'hollow' ? COLOR.hollowFill : COLOR.edge}" stroke="${COLOR.edge}" stroke-width="1"/>`
  );
}

/** 里程碑菱形点串（中心与边长来自 `ViewModel`）。 */
function diamondPoints(milestone: RowBox['milestone']): string {
  if (milestone === null) return '';
  const half = milestone.size / 2;
  return pointsAttr([
    [milestone.cx, milestone.cy - half],
    [milestone.cx + half, milestone.cy],
    [milestone.cx, milestone.cy + half],
    [milestone.cx - half, milestone.cy],
  ]);
}

/**
 * 一张图例/摘要侧栏的 SVG（内联在同一个 `<svg>` 里：一个文件即一张图）。
 *
 * 侧栏放在**绘制区右侧**而不是下方：既不改动甘特的几何，也不挤压行高。
 */
function sidebarSvg(args: {
  readonly x: number;
  readonly height: number;
  readonly options: SvgExportOptions;
}): string {
  const parts: string[] = [];
  const { options } = args;
  let y = HEADER_HEIGHT_PX + 8;
  parts.push(
    `<rect x="${String(roundPx(args.x))}" y="0" width="${String(EXPORT_SIDEBAR_WIDTH_PX)}" height="${String(roundPx(args.height))}" fill="${COLOR.legendBg}"/>`,
  );

  if (options.includeLegend === true) {
    parts.push(
      `<g class="legend">` +
        `<text x="${String(roundPx(args.x + 8))}" y="${String(roundPx(y + 10))}" font-size="${String(EXPORT_LABEL_FONT_PX)}" fill="${COLOR.rowText}">图例</text>`,
    );
    y += 22;
    for (const item of exportLegendItems()) {
      const swatch =
        item.styleKey === 'bar'
          ? `<rect x="${String(roundPx(args.x + 8))}" y="${String(roundPx(y - 8))}" width="18" height="10" rx="2" fill="${COLOR.bar}"/>`
          : item.styleKey === 'bar-summary'
            ? `<rect x="${String(roundPx(args.x + 8))}" y="${String(roundPx(y - 8))}" width="18" height="6" fill="${COLOR.barSummary}"/>`
            : item.styleKey === 'milestone'
              ? `<polygon points="${pointsAttr([
                  [args.x + 17, y - 12],
                  [args.x + 23, y - 6],
                  [args.x + 17, y],
                  [args.x + 11, y - 6],
                ])}" fill="${COLOR.milestone}"/>`
              : legendEdgeSwatch(args.x + 8, y - 4, item.styleKey);
      parts.push(
        `<g class="legend-item" data-style-key="${escapeXml(item.styleKey)}">${swatch}` +
          `<text x="${String(roundPx(args.x + 32))}" y="${String(roundPx(y))}" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.rowText}">${escapeXml(item.label)}</text>` +
          `</g>`,
      );
      y += 16;
    }
    parts.push(`</g>`);
    y += 8;
  }

  if (options.includeSummary === true && options.summary !== undefined) {
    const summary = options.summary;
    const lines = exportSummaryLines(summary);
    parts.push(
      `<g class="summary">` +
        `<text x="${String(roundPx(args.x + 8))}" y="${String(roundPx(y + 10))}" font-size="${String(EXPORT_LABEL_FONT_PX)}" fill="${COLOR.rowText}">摘要</text>`,
    );
    y += 24;
    for (const line of [...lines.headline, ...lines.milestones]) {
      parts.push(
        `<text x="${String(roundPx(args.x + 8))}" y="${String(roundPx(y))}" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.rowText}">${escapeXml(line)}</text>`,
      );
      y += 14;
    }
    parts.push(`</g>`);
  }

  return parts.join('');
}

/** 导出 SVG 的内层尺寸（**适配公式的输入**；含可选侧栏）。 */
export interface SvgInnerSize {
  readonly innerWidth: number;
  readonly innerHeight: number;
  /** 侧栏占用（0 = 不含图例/摘要）。 */
  readonly sidebarWidth: number;
}

/**
 * `svgString` 会写多大的画布——**适配必须用这个值**，否则"含图例"时缩放比会算小、
 * 侧栏会被挤到页面外（图例/摘要开关是用户可选项，两处公式必须同源）。
 */
export function svgInnerSizeOf(args: {
  readonly view: ViewModel;
  readonly options?: SvgExportOptions;
}): SvgInnerSize {
  const options = args.options ?? {};
  const hasSidebar = options.includeLegend === true || (options.includeSummary === true && options.summary !== undefined);
  const sidebarWidth = hasSidebar ? EXPORT_SIDEBAR_GAP_PX + EXPORT_SIDEBAR_WIDTH_PX : 0;
  return {
    innerWidth: EXPORT_LABEL_WIDTH_PX + args.view.width + sidebarWidth,
    innerHeight: HEADER_HEIGHT_PX + args.view.rowCount * args.view.rowHeight,
    sidebarWidth,
  };
}

/**
 * 导出 SVG 字符串（ADR 0010 §4）。
 *
 * 画布：左侧任务名列 `[0, EXPORT_LABEL_WIDTH_PX)`、上侧日期刻画带 `[0, HEADER_HEIGHT_PX)`、
 * 绘制区自 `(EXPORT_LABEL_WIDTH_PX, HEADER_HEIGHT_PX)` 起；可选的图例/摘要侧栏在绘制区右侧。
 */
export function svgString(args: SvgExportArgs): string {
  const { view, document } = args;
  const options = args.options ?? {};
  const hasSidebar = options.includeLegend === true || (options.includeSummary === true && options.summary !== undefined);
  const chartWidth = view.width;
  const rowsHeight = view.rowCount * view.rowHeight;
  const width = EXPORT_LABEL_WIDTH_PX + chartWidth + (hasSidebar ? EXPORT_SIDEBAR_GAP_PX + EXPORT_SIDEBAR_WIDTH_PX : 0);
  const height = HEADER_HEIGHT_PX + rowsHeight;
  const offsetX = EXPORT_LABEL_WIDTH_PX;
  const offsetY = HEADER_HEIGHT_PX;
  const title = options.title ?? '甘特图';

  const chunks: string[] = [];
  chunks.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" ` +
      `viewBox="0 0 ${String(width)} ${String(height)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<desc>${escapeXml(`甘特图导出：${String(view.rowCount)} 行 / ${String(view.edges.length)} 条依赖，档位 ${view.zoom}（${String(view.pxPerDay)} px/天），几何与屏幕同源`)}</desc>`,
    `<rect x="0" y="0" width="${String(width)}" height="${String(height)}" fill="#ffffff"/>`,
  );

  /**
   * 轴：**三层视觉**（与屏幕 `GanttChart.vue` 逐层同源，ADR 0007 §2 的"双投影共享几何"）。
   *
   * **表的行序即绘制顺序**：
   *
   * | 顺序 | 层 | 元素 | 画在哪 | 颜色 |
   * |---|---|---|---|---|
   * | ① | 上级分段的**正文** | `major-band` | 绘制区（整高，**近乎白**） | `COLOR.majorBody` |
   * | ② | 周末/假日色带 | `band` | 绘制区（整高，**压在正文之上**） | `COLOR.band` |
   * | ③ | 上级分段的**全高边界线** | 由 `major-band` 派生 | **全高**（表头带 + 绘制区） | `COLOR.majorEdge` |
   * | ④ | 上级分段的**表头底** | 由 `major-band` 派生 | **表头带** | `COLOR.majorHeader` |
   * | ⑤ | 下级**短刻度** | `gridline` | **只画在表头带内**（`EXPORT_TICK_LENGTH_PX`） | `COLOR.gridline` |
   *
   * **为什么正文必须最先画**（G8 人工复验第 ④ 条）：正文整高、月段又首尾相接 ⇒ 它连续覆盖
   * 整个绘制区宽；首版既把它的填充取成与周末灰同量级的 `#eef1f5`，又把它画在周末带**之后**，
   * "白周中 + 灰周末"的对比因此被整体盖掉（看起来是一整块浅色）——两半都已订正。
   * **刻度线只属于刻度区**是第 ⑤ 条的订正（首版是整高竖线 ⇒ 刻度画进了条体区）。
   * 计数**仍与 `view.axis` 逐条一致**：派生出来的线与底不算新元素——全高边界线是 `major-band`
   * 的第三个投影，短刻度仍是 `gridline` 本身（判重口径见 `clip.ts` 的 `buildAxis`）。
   */
  chunks.push(`<g class="axis">`);
  // ① 上级分段的正文（近乎白，整高）——**先画**：它在周末色带之下
  for (const element of view.axis) {
    if (element.kind !== 'major-band') continue;
    const x = Math.min(Math.max(element.x, 0), chartWidth);
    const width = Math.max(1, Math.min(element.width, chartWidth - x));
    chunks.push(
      `<rect x="${String(roundPx(offsetX + x))}" y="${String(offsetY)}" width="${String(roundPx(width))}" height="${String(rowsHeight)}" fill="${COLOR.majorBody}"/>`,
    );
  }
  // ② 周末/假日色带——画在月份分组底**之后**，因此永远看得见
  for (const element of view.axis) {
    if (element.kind !== 'band') continue;
    // 裁到绘制区右缘（不裁会露进侧栏/间隙）；**计数仍与 `view.axis` 一致**（夹到 ≥1 px，不跳过）
    const width = Math.max(1, Math.min(element.width, chartWidth - Math.max(0, element.x)));
    chunks.push(
      `<rect x="${String(roundPx(offsetX + element.x))}" y="${String(offsetY)}" width="${String(roundPx(width))}" height="${String(rowsHeight)}" fill="${COLOR.band}"/>`,
    );
  }
  // ③ 上级分段的边界（全高）与表头底
  for (const element of view.axis) {
    if (element.kind !== 'major-band') continue;
    const x = Math.min(Math.max(element.x, 0), chartWidth);
    const width = Math.max(1, Math.min(element.width, chartWidth - x));
    chunks.push(
      `<line x1="${String(roundPx(offsetX + x))}" x2="${String(roundPx(offsetX + x))}" y1="0" y2="${String(offsetY + rowsHeight)}" stroke="${COLOR.majorEdge}" stroke-width="1"/>`,
      `<rect x="${String(roundPx(offsetX + x))}" y="0" width="${String(roundPx(width))}" height="${String(HEADER_HEIGHT_PX)}" fill="${COLOR.majorHeader}"/>`,
    );
  }
  chunks.push(`</g>`);
  // ④ 下级刻度线：只画在表头带内的短刻度（"刻度归刻度区"）
  for (const element of view.axis) {
    if (element.kind !== 'gridline') continue;
    const x = Math.min(Math.max(element.x, 0), chartWidth);
    chunks.push(
      `<line class="axis-tick" x1="${String(roundPx(offsetX + x))}" x2="${String(roundPx(offsetX + x))}" y1="${String(HEADER_HEIGHT_PX - EXPORT_TICK_LENGTH_PX)}" y2="${String(HEADER_HEIGHT_PX)}" stroke="${COLOR.gridline}" stroke-width="1"/>`,
    );
  }

  /**
   * 刻度文本（**两级**，都在表头带内；**大刻度在上、小刻度在下**）：
   *
   * - **上级**（`level: 1`）画在带内的**第一行**（基线 `MAJOR_LABEL_BASELINE_PX`），
   *   段内由 `buildAxis` 保证只在左端发一次；
   * - **下级**（`level` 缺省或 2）画在**第二行**（基线 `MINOR_LABEL_BASELINE_PX`）。
   *
   * 两者共用同一份 `view.axis`（与屏幕同源，铁律 #2）。
   */
  chunks.push(`<g class="axis-labels">`);
  for (const element of view.axis) {
    if (element.kind !== 'label') continue;
    const baseline = element.level === 1 ? MAJOR_LABEL_BASELINE_PX : MINOR_LABEL_BASELINE_PX;
    chunks.push(
      `<text x="${String(roundPx(offsetX + element.x + 2))}" y="${String(baseline)}" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.axisText}">${escapeXml(element.text)}</text>`,
    );
  }
  chunks.push(`</g>`);

  // 行：条 / 进度 / 里程碑（不含手柄、连接点、热区、覆盖层）
  chunks.push(`<g class="rows">`);
  for (const row of view.rows) {
    const task = document.tasks[row.docIndex];
    const label = exportLabelOf({ task, fallback: row.id });
    const y = roundPx(offsetY + row.y);
    chunks.push(
      `<g class="row" data-task-id="${escapeXml(row.id)}" data-kind="${row.kind}">` +
        `<title>${escapeXml(label.text)}</title>` +
        `<text x="${String(roundPx(8 + label.indentPx))}" y="${String(y + view.rowHeight - 8)}" font-size="${String(EXPORT_LABEL_FONT_PX)}"${label.bold ? ' font-weight="bold"' : ''} fill="${COLOR.rowText}">${escapeXml(label.text)}</text>`,
    );
    if (row.isMilestone && row.milestone !== null) {
      chunks.push(
        `<polygon class="milestone" points="${diamondPoints({ ...row.milestone, cx: offsetX + row.milestone.cx, cy: offsetY + row.milestone.cy })}" fill="${COLOR.milestone}" stroke="${COLOR.milestoneStroke}" stroke-width="1"/>`,
      );
    } else {
      const barWidth = Math.max(1, roundPx(row.xRight - row.xLeft));
      chunks.push(
        `<rect class="bar" x="${String(roundPx(offsetX + row.xLeft))}" y="${String(roundPx(offsetY + row.barY))}" width="${String(barWidth)}" height="${String(roundPx(row.barHeight))}" rx="${row.kind === 'summary' ? '0' : '2'}" fill="${row.kind === 'summary' ? COLOR.barSummary : COLOR.bar}"/>`,
      );
      if (row.hasProgress) {
        chunks.push(
          `<rect class="bar-progress" x="${String(roundPx(offsetX + row.xLeft))}" y="${String(roundPx(offsetY + row.barY + 1))}" width="${String(Math.max(0, roundPx((row.xRight - row.xLeft) * row.progressRatio)))}" height="${String(Math.max(0, roundPx(row.barHeight - 2)))}" fill="${COLOR.progress}"/>`,
        );
      }
    }
    chunks.push(`</g>`);
  }
  chunks.push(`</g>`);

  // 依赖线：折线 + 箭头（**不导出透明热区**——那是交互图元）
  chunks.push(`<g class="edges">`);
  for (const edge of view.edges) {
    const stroke = edge.ignored ? COLOR.edgeIgnored : COLOR.edge;
    const tip = edge.points[edge.points.length - 1];
    const shifted = edge.points.map(([x, y]) => [offsetX + x, offsetY + y] as const);
    chunks.push(
      `<g class="edge" data-link-id="${escapeXml(edge.linkId)}" data-link-type="${escapeXml(edge.type)}">` +
        `<path d="${pathData(shifted)}" fill="none" stroke="${stroke}" stroke-width="1"/>`,
    );
    if (tip !== undefined) {
      const [origin, left, right] = arrowPolygons({ dir: edge.arrowDir, fill: arrowForm(edge) }).outer;
      const arrowPoints = [
        [offsetX + tip[0] + origin[0], offsetY + tip[1] + origin[1]] as const,
        [offsetX + tip[0] + left[0], offsetY + tip[1] + left[1]] as const,
        [offsetX + tip[0] + right[0], offsetY + tip[1] + right[1]] as const,
      ];
      chunks.push(
        `<polygon points="${pointsAttr(arrowPoints)}" fill="${arrowForm(edge) === 'hollow' ? COLOR.hollowFill : stroke}" stroke="${stroke}" stroke-width="1"/>`,
      );
    }
    chunks.push(`</g>`);
  }
  chunks.push(`</g>`);

  if (hasSidebar) {
    chunks.push(sidebarSvg({ x: EXPORT_LABEL_WIDTH_PX + chartWidth + EXPORT_SIDEBAR_GAP_PX, height, options }));
  }

  chunks.push(`</svg>`);
  return chunks.join('');
}
