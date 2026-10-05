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
import { exportLegendItems, formatCompletionRatio, type ExportSummary } from './exportSummary.js';
import { HEADER_HEIGHT_PX, LABEL_CHAR_PX } from './manifest.js';
import { arrowPolygons } from './route.js';
import type { EdgeGeom, RowBox, ViewModel } from './viewModel.js';

/** 颜色常量（与屏幕同值；ADR 0010 §4 的"同源"）。 */
const COLOR = {
  band: '#f4f6f8',
  gridline: '#e4e7ec',
  axisText: '#667085',
  rowText: '#1f2933',
  bar: '#2e75b6',
  barSummary: '#7a8699',
  progress: '#1f4e79',
  milestone: '#ed7d31',
  milestoneStroke: '#b1551a',
  edge: '#475467',
  edgeIgnored: '#c9ccd1',
  hollowFill: '#ffffff',
  legendBg: '#fcfcfd',
} as const;

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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round(value: number): number {
  return Math.round(value);
}

/** 点串 → `<polygon points>`（整数化）。 */
function pointsAttr(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${String(round(x))},${String(round(y))}`).join(' ');
}

/** 折线点列 → `<path d>`（整数化）。 */
function pathData(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${String(round(x))} ${String(round(y))}`).join('');
}

/** 箭头填充形态：SS/SF 空心、FS/FF 实心（`ARROW_FILL` 的口径）。 */
function arrowForm(edge: EdgeGeom): 'solid' | 'hollow' {
  return edge.type === 'SS' || edge.type === 'SF' ? 'hollow' : 'solid';
}

/** 标签列内的显示名（超出则截断加省略号；用 `LABEL_CHAR_PX` 估宽，不引入字体度量依赖）。 */
function labelText(outlineNumber: string, name: string, widthPx: number): string {
  const prefix = outlineNumber === '' ? '' : `${outlineNumber} `;
  const full = `${prefix}${name}`;
  const maxChars = Math.max(4, Math.floor((widthPx - 12) / LABEL_CHAR_PX));
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars - 1)}…`;
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
    `<rect x="${String(round(args.x))}" y="0" width="${String(EXPORT_SIDEBAR_WIDTH_PX)}" height="${String(round(args.height))}" fill="${COLOR.legendBg}"/>`,
  );

  if (options.includeLegend === true) {
    parts.push(
      `<g class="legend">` +
        `<text x="${String(round(args.x + 8))}" y="${String(round(y + 10))}" font-size="${String(EXPORT_LABEL_FONT_PX)}" fill="${COLOR.rowText}">图例</text>`,
    );
    y += 22;
    for (const item of exportLegendItems()) {
      const swatch =
        item.styleKey === 'bar'
          ? `<rect x="${String(round(args.x + 8))}" y="${String(round(y - 8))}" width="18" height="10" rx="2" fill="${COLOR.bar}"/>`
          : item.styleKey === 'bar-summary'
            ? `<rect x="${String(round(args.x + 8))}" y="${String(round(y - 8))}" width="18" height="6" fill="${COLOR.barSummary}"/>`
            : item.styleKey === 'milestone'
              ? `<polygon points="${pointsAttr([
                  [args.x + 17, y - 12],
                  [args.x + 23, y - 6],
                  [args.x + 17, y],
                  [args.x + 11, y - 6],
                ])}" fill="${COLOR.milestone}"/>`
              : `<line x1="${String(round(args.x + 8))}" y1="${String(round(y - 4))}" x2="${String(round(args.x + 26))}" y2="${String(round(y - 4))}" stroke="${COLOR.edge}" stroke-width="1"/>`;
      parts.push(
        `<g class="legend-item" data-style-key="${escapeXml(item.styleKey)}">${swatch}` +
          `<text x="${String(round(args.x + 32))}" y="${String(round(y))}" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.rowText}">${escapeXml(item.label)}</text>` +
          `</g>`,
      );
      y += 16;
    }
    parts.push(`</g>`);
    y += 8;
  }

  if (options.includeSummary === true && options.summary !== undefined) {
    const summary = options.summary;
    parts.push(
      `<g class="summary">` +
        `<text x="${String(round(args.x + 8))}" y="${String(round(y + 10))}" font-size="${String(EXPORT_LABEL_FONT_PX)}" fill="${COLOR.rowText}">摘要</text>`,
    );
    y += 24;
    const lines = [
      `任务 ${String(summary.taskCount)} · 依赖 ${String(summary.linkCount)}`,
      `里程碑 ${String(summary.milestoneCount)} · 完成率 ${formatCompletionRatio(summary.completionRatio)}`,
    ];
    for (const line of lines) {
      parts.push(
        `<text x="${String(round(args.x + 8))}" y="${String(round(y))}" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.rowText}">${escapeXml(line)}</text>`,
      );
      y += 14;
    }
    y += 6;
    for (const milestone of summary.milestones) {
      parts.push(
        `<text x="${String(round(args.x + 8))}" y="${String(round(y))}" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.axisText}">` +
          `${escapeXml(`${milestone.outlineNumber} ${milestone.name} · ${milestone.dateIso}`)}</text>`,
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

  // 轴：色带与网格线（只落在绘制区；与屏幕同一致）
  chunks.push(`<g class="axis">`);
  for (const element of view.axis) {
    if (element.kind === 'band') {
      chunks.push(
        `<rect x="${String(round(offsetX + element.x))}" y="${String(offsetY)}" width="${String(round(element.width))}" height="${String(rowsHeight)}" fill="${COLOR.band}"/>`,
      );
    } else if (element.kind === 'gridline') {
      chunks.push(
        `<line x1="${String(round(offsetX + element.x))}" x2="${String(round(offsetX + element.x))}" y1="${String(offsetY)}" y2="${String(offsetY + rowsHeight)}" stroke="${COLOR.gridline}" stroke-width="1"/>`,
      );
    }
  }
  chunks.push(`</g>`);

  // 日期刻度（表头带内，与屏幕的 y=18 同口径）
  chunks.push(`<g class="axis-labels">`);
  for (const element of view.axis) {
    if (element.kind !== 'label') continue;
    chunks.push(
      `<text x="${String(round(offsetX + element.x + 2))}" y="18" font-size="${String(EXPORT_AXIS_FONT_PX)}" fill="${COLOR.axisText}">${escapeXml(element.text)}</text>`,
    );
  }
  chunks.push(`</g>`);

  // 行：条 / 进度 / 里程碑（不含手柄、连接点、热区、覆盖层）
  chunks.push(`<g class="rows">`);
  for (const row of view.rows) {
    const task = document.tasks[row.docIndex];
    const name = task === undefined ? row.id : labelText(task.outlineNumber, task.name, EXPORT_LABEL_WIDTH_PX);
    const y = round(offsetY + row.y);
    chunks.push(
      `<g class="row" data-task-id="${escapeXml(row.id)}" data-kind="${row.kind}">` +
        `<title>${escapeXml(name)}</title>` +
        `<text x="8" y="${String(y + view.rowHeight - 8)}" font-size="${String(EXPORT_LABEL_FONT_PX)}" fill="${COLOR.rowText}">${escapeXml(name)}</text>`,
    );
    if (row.isMilestone && row.milestone !== null) {
      chunks.push(
        `<polygon class="milestone" points="${diamondPoints({ ...row.milestone, cx: offsetX + row.milestone.cx, cy: offsetY + row.milestone.cy })}" fill="${COLOR.milestone}" stroke="${COLOR.milestoneStroke}" stroke-width="1"/>`,
      );
    } else {
      const barWidth = Math.max(1, round(row.xRight - row.xLeft));
      chunks.push(
        `<rect class="bar" x="${String(round(offsetX + row.xLeft))}" y="${String(round(offsetY + row.barY))}" width="${String(barWidth)}" height="${String(round(row.barHeight))}" rx="${row.kind === 'summary' ? '0' : '2'}" fill="${row.kind === 'summary' ? COLOR.barSummary : COLOR.bar}"/>`,
      );
      if (row.hasProgress) {
        chunks.push(
          `<rect class="bar-progress" x="${String(round(offsetX + row.xLeft))}" y="${String(round(offsetY + row.barY + 1))}" width="${String(Math.max(0, round((row.xRight - row.xLeft) * row.progressRatio)))}" height="${String(Math.max(0, round(row.barHeight - 2)))}" fill="${COLOR.progress}"/>`,
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
