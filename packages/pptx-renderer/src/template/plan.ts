/**
 * **模板 A 的布局与适配**（纯几何，不含任何 XML；P3/C3 从 `template.ts` 拆出）。
 *
 * 布局是"渲染与判据共用"的单一真相源：`planTemplateA` 算出框、缩放与侧栏排版，
 * `template.spec.ts` 与文本/图元注入都读同一份 `TemplateAPlan`——因此"文本与图元两处各排一次版"
 * 这类缺陷在类型层就不可能发生（人工复验第 3/4 条的教训）。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';
import {
  buildExportView,
  exportLegendItems,
  exportSummaryOf,
  EXPORT_MILESTONE_LIST_MAX,
  fitScaleFor,
  ROW_HEIGHT,
  type ExportLegendItem,
  type ExportSummary,
  type ExportView,
  type FitTransform,
  type ZoomKey,
} from '@ganttpilot/render-core';

import {
  FONT,
  pxToPt,
  TEMPLATE_A_MARGIN_PX,
  TEMPLATE_A_PAGE_PX,
  TEMPLATE_A_SIDEBAR_GAP_PX,
  TEMPLATE_A_SIDEBAR_PX,
  TEMPLATE_A_TITLE_PX,
} from '../units.js';

/** {@link renderTemplateA} 的入参。 */
export interface TemplateAInput {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  /** **必须**是 `createScheduleCalendar(document)`。 */
  readonly calendar: Calendar;
  readonly zoom: ZoomKey;
  /** 标题（默认取文档的 `project.name`）。 */
  readonly title?: string;
  /**
   * connector 异常时的**降级②**：用 `custGeom` 折线（ADR 0010 §6；默认关闭，走 `bentConnector3`）。
   * 两种形态都有判据（正例 + 降级例）。
   */
  readonly degradeConnectors?: boolean;
}

/** 页面内的一个矩形（px）。 */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 模板 A 的纯几何布局（**渲染与判据共用**；不含任何 XML）。 */
export interface TemplateAPlan {
  readonly projection: ExportView;
  readonly summary: ExportSummary;
  readonly fit: FitTransform;
  readonly pageWidthPx: number;
  readonly pageHeightPx: number;
  readonly titleBox: Box;
  readonly ganttBox: Box;
  readonly sidebarBox: Box;
  /** 一行在页面上的高度（pt）——可读性与"画不画标签"的判据输入。 */
  readonly rowHeightPt: number;
  /** 行标签的**有效**字号（pt）；< 6 ⇒ 不画标签（避免 1,000 行生成上千个不可读文本框）。 */
  readonly labelFontPt: number;
  /**
   * 侧栏图例的**排版结果**（页面上每一条的 y 与色块 y）。
   *
   * 文本（pptxgenjs）与色块（补丁注入）必须用**同一份坐标**——否则就是人工复验第 4 条
   * "图例摘要与 SVG/PNG 不一致"的翻版（两处各排一次版）。
   */
  readonly legendRows: readonly { readonly item: ExportLegendItem; readonly y: number }[];
  /** 摘要段的顶端（页 px）；由 {@link planTemplateA} 与文本/图元注入共用。 */
  readonly summaryTop: number;
  /** 侧栏内容块的顶端与总高（页 px）——**垂直居中的单一真相处**（判据与排版都读它）。 */
  readonly sidebarContentTop: number;
  readonly sidebarContentHeight: number;
}

/** 侧栏各段的高度常量（px）——排版与图元注入共用，避免两处各排一次版。 */
export const SIDEBAR_TITLE_PX = 16;
export const SIDEBAR_LEGEND_ROW_PX = 14;
export const SIDEBAR_SUMMARY_ROW_PX = 13;
export const SIDEBAR_GAP_PX = 12;

/** 摘要的**行数**（两行统计 + 里程碑清单，含"…共 N 个"那行）。 */
export function summaryLineCountOf(summary: ExportSummary): number {
  const shown = Math.min(summary.milestones.length, EXPORT_MILESTONE_LIST_MAX);
  return 2 + shown + (summary.milestones.length > shown ? 1 : 0);
}

/** 模板 A 的布局（纯函数；ADR 0010 §2/§3/§7/§11）。 */
export function planTemplateA(input: TemplateAInput): TemplateAPlan {
  const projection = buildExportView({
    document: input.document,
    schedule: input.schedule,
    calendar: input.calendar,
    zoom: input.zoom,
  });
  const summary = exportSummaryOf({
    document: input.document,
    schedule: input.schedule,
    calendar: input.calendar,
  });

  const pageWidthPx = TEMPLATE_A_PAGE_PX.width;
  const pageHeightPx = TEMPLATE_A_PAGE_PX.height;
  const titleBox: Box = {
    x: TEMPLATE_A_MARGIN_PX,
    y: TEMPLATE_A_MARGIN_PX,
    width: pageWidthPx - TEMPLATE_A_MARGIN_PX * 2,
    height: TEMPLATE_A_TITLE_PX,
  };
  const sidebarBox: Box = {
    x: pageWidthPx - TEMPLATE_A_MARGIN_PX - TEMPLATE_A_SIDEBAR_PX,
    y: TEMPLATE_A_MARGIN_PX + TEMPLATE_A_TITLE_PX,
    width: TEMPLATE_A_SIDEBAR_PX,
    height: pageHeightPx - TEMPLATE_A_MARGIN_PX * 2 - TEMPLATE_A_TITLE_PX,
  };
  const ganttBox: Box = {
    x: TEMPLATE_A_MARGIN_PX,
    y: TEMPLATE_A_MARGIN_PX + TEMPLATE_A_TITLE_PX,
    width: Math.max(1, sidebarBox.x - TEMPLATE_A_SIDEBAR_GAP_PX - TEMPLATE_A_MARGIN_PX),
    height: pageHeightPx - TEMPLATE_A_MARGIN_PX * 2 - TEMPLATE_A_TITLE_PX,
  };

  const fit = fitScaleFor({
    innerWidth: projection.innerWidth,
    innerHeight: projection.innerHeight,
    pageWidthPx: ganttBox.width,
    pageHeightPx: ganttBox.height,
    marginPx: 0,
  });

  const rowHeightPt = pxToPt(ROW_HEIGHT * fit.scale);
  const labelFontPt = Math.min(FONT.task, Math.max(0, rowHeightPt - 1.5));

  /**
   * 侧栏内容**垂直居中**（人工复验第 4 条：原先侧栏从顶端排版、而甘特内容在框内居中 ⇒
   * 侧栏"浮在右上方"，既不对齐也不省空间）。
   *
   * 口径：算出侧栏内容总高，把它居中对齐到侧栏框——与甘特内容的居中基准同一个
   * （`fit.offsetY` 也是居中），于是两块的视觉中心一致。
   */
  const legendCount = exportLegendItems().length;
  const summaryLineCount = summaryLineCountOf(summary);
  const sidebarContentHeight =
    SIDEBAR_TITLE_PX +
    legendCount * SIDEBAR_LEGEND_ROW_PX +
    SIDEBAR_GAP_PX +
    SIDEBAR_TITLE_PX +
    summaryLineCount * SIDEBAR_SUMMARY_ROW_PX;
  const sidebarContentTop = sidebarBox.y + Math.max(0, (sidebarBox.height - sidebarContentHeight) / 2);
  let legendY = sidebarContentTop + SIDEBAR_TITLE_PX;
  const legendRows: { item: ExportLegendItem; y: number }[] = [];
  for (const item of exportLegendItems()) {
    legendRows.push({ item, y: legendY });
    legendY += SIDEBAR_LEGEND_ROW_PX;
  }
  const summaryTop = legendY + SIDEBAR_GAP_PX;

  return {
    projection,
    summary,
    fit,
    pageWidthPx,
    pageHeightPx,
    titleBox,
    ganttBox,
    sidebarBox,
    rowHeightPt,
    labelFontPt,
    legendRows,
    summaryTop,
    sidebarContentTop,
    sidebarContentHeight,
  };
}

/** 内部内容坐标 → 页面 px（`innerX` 含左侧标签列偏移，与 `svgString` 同一套口径）。 */
export function slidePointOf(plan: TemplateAPlan, innerX: number, innerY: number): { x: number; y: number } {
  return {
    x: plan.ganttBox.x + plan.fit.offsetX + innerX * plan.fit.scale,
    y: plan.ganttBox.y + plan.fit.offsetY + innerY * plan.fit.scale,
  };
}
