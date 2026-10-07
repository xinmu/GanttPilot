/**
 * **模板 A 的文本与标签**（标题 / 日期刻度 / 行标签 / 图例 / 摘要；P3/C3 从 `template.ts` 拆出）。
 *
 * 本模块只产出 {@link TextLine} 数据，真正的 `slide.addText` 由管线（`index.ts`）执行——
 * 这样"画什么文本、放在哪"可以脱离 pptxgenjs 被单测，也保证文本与几何读的是**同一份** `TemplateAPlan`。
 *
 * 三条同源纪律（人工复验第 1/3/4 条的教训）：
 * 1. **刻度文案**取自 `view.axis`（与屏幕/SVG 同源），两级基线共用 `render-core` 的常量；
 * 2. **行标签**走 `render-core` 的 `exportLabelOf`（缩进/加粗/截断只有一份实现）；
 * 3. **图例与摘要**的文案与坐标分别取自 `exportLegendItems()` / `exportSummaryLines()` 与 `plan.legendRows`。
 */

import type { DocumentTask, ProjectDocument } from '@ganttpilot/engine';
import {
  exportLabelOf,
  exportSummaryLines,
  EXPORT_LABEL_PADDING_PX,
  EXPORT_LABEL_WIDTH_PX,
  HEADER_HEIGHT_PX,
  MAJOR_LABEL_BASELINE_PX,
  MINOR_LABEL_BASELINE_PX,
} from '@ganttpilot/render-core';

import { COLOR, FONT } from '../units.js';
import { NAMES } from '../ooxml.js';
import { SIDEBAR_SUMMARY_ROW_PX, SIDEBAR_TITLE_PX, slidePointOf, type TemplateAPlan } from './plan.js';

/** 一段文本（模板 A 的标题/标签/图例/摘要）。 */
export interface TextLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
  readonly color: string;
  readonly bold: boolean;
  readonly objectName: string;
}

/** 行标签文本（**与 SVG 同源**：共享 `exportLabels` 的缩进/加粗/截断口径）。 */
export function labelOf(task: DocumentTask | undefined, fallback: string): {
  readonly text: string;
  readonly indentPx: number;
  readonly bold: boolean;
} {
  return exportLabelOf({ task, fallback });
}

/** 模板 A 的全部文本块（标题 + 日期刻度 + 行标签 + 图例 + 摘要）。 */
export function textLinesOf(plan: TemplateAPlan, document: ProjectDocument, title: string): readonly TextLine[] {
  const lines: TextLine[] = [
    {
      text: title,
      x: plan.titleBox.x,
      y: plan.titleBox.y,
      width: plan.titleBox.width,
      fontSize: FONT.title,
      color: COLOR.text,
      bold: true,
      objectName: NAMES.title,
    },
  ];

  // 日期刻度（人工复验第 1 条：PPTX 原先根本没有刻度）——文案与 SVG 取自**同一份** `view.axis`
  //
  // **两级刻度**（P-46，ADR 0007 附录 §3）：下级标签（`level` 缺省/2）画在表头带**上半**、
  // 上级标签（`level: 1`）画在**下半**，基线与屏幕/SVG 同源（`MINOR_LABEL_BASELINE_PX` /
  // `MAJOR_LABEL_BASELINE_PX`）——三处不许各写一个数字，否则"所见 = 所导出"当场破裂。
  for (const [index, element] of plan.projection.view.axis.entries()) {
    if (element.kind !== 'label') continue;
    const baseline = element.level === 1 ? MAJOR_LABEL_BASELINE_PX : MINOR_LABEL_BASELINE_PX;
    const point = slidePointOf(plan, EXPORT_LABEL_WIDTH_PX + element.x + 2, baseline);
    lines.push({
      text: element.text,
      x: point.x,
      y: point.y,
      width: Math.max(14, plan.fit.scale * (plan.projection.view.pxPerDay * 4 + 16)),
      fontSize: FONT.axis,
      color: COLOR.muted,
      bold: false,
      objectName: NAMES.axis(index),
    });
  }

  // 左列任务名：**只在行高撑得下时**画（1,000 行会生成上千个不可读文本框，且必然糊）
  if (plan.labelFontPt >= 6) {
    for (const row of plan.projection.view.rows) {
      const label = labelOf(document.tasks[row.docIndex], row.id);
      const point = slidePointOf(plan, EXPORT_LABEL_PADDING_PX + label.indentPx, HEADER_HEIGHT_PX + row.y);
      lines.push({
        text: label.text,
        x: point.x,
        y: point.y,
        width: Math.max(8, (EXPORT_LABEL_WIDTH_PX - label.indentPx - EXPORT_LABEL_PADDING_PX) * plan.fit.scale),
        fontSize: plan.labelFontPt,
        color: COLOR.text,
        bold: label.bold,
        objectName: NAMES.label(row.id),
      });
    }
  }

  // 侧栏：图例（标题 + 逐条标签；色块由补丁按同一份 `legendRows` 注入）
  lines.push({
    text: '图例',
    x: plan.sidebarBox.x,
    y: plan.legendRows[0] === undefined ? plan.sidebarBox.y : plan.legendRows[0].y - 20,
    width: plan.sidebarBox.width,
    fontSize: FONT.legend + 1,
    color: COLOR.text,
    bold: true,
    objectName: NAMES.legend(0),
  });
  for (const [index, row] of plan.legendRows.entries()) {
    lines.push({
      text: row.item.label,
      // 左右间距：色块占 [x+6, x+24]，文本从 x+34 起 ⇒ 净间距 10 px（人工复验第 3 条）
      x: plan.sidebarBox.x + 34,
      y: row.y - 6,
      width: plan.sidebarBox.width - 34,
      fontSize: FONT.legend,
      color: COLOR.text,
      bold: false,
      objectName: NAMES.legend(index + 1),
    });
  }

  // 侧栏：摘要（文案与 SVG 同源：`exportSummaryLines`）
  const summaryLines = exportSummaryLines(plan.summary);
  let y = plan.summaryTop;
  lines.push({
    text: '摘要',
    x: plan.sidebarBox.x,
    y,
    width: plan.sidebarBox.width,
    fontSize: FONT.summary + 1,
    color: COLOR.text,
    bold: true,
    objectName: NAMES.summary(0),
  });
  y += SIDEBAR_TITLE_PX;
  for (const [index, text] of [...summaryLines.headline, ...summaryLines.milestones].entries()) {
    lines.push({
      text,
      x: plan.sidebarBox.x,
      y,
      width: plan.sidebarBox.width,
      fontSize: FONT.summary,
      color: COLOR.text,
      bold: false,
      objectName: NAMES.summary(index + 1),
    });
    y += SIDEBAR_SUMMARY_ROW_PX;
  }
  return lines;
}
