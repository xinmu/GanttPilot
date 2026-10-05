/**
 * 导出物**左列标签**的样式与文本（ADR 0010 §4/§7；G7 人工复验的第 3 条反馈）。
 *
 * ## 为什么单独成模块
 *
 * 屏幕左表有独立的两栏几何（`TaskTable.vue`）、SVG/PPTX 导出只有**一列**标签——
 * 少了"层级缩进"与"汇总加粗"这两个视觉线索，15 行里"哪三条是阶段"就看不出来
 * （人工复验报文原话："父节点没有加粗，子节点没有缩进，视觉区分度不够"）。
 *
 * 因此把"缩进 + 加粗 + 截断"三件事收在一处：**SVG 与 PPTX 必须逐字同源**
 * （否则又会出现"图例/摘要两处不一致"那类缺陷）。
 *
 * ## 口径
 *
 * - **加粗 = 汇总行**（`durationDays === null`，与 `-1` 哨兵同源的判别式）；
 * - **缩进 = WBS 层级深度**（`outlineNumber` 的段数 − 1），上限 {@link EXPORT_LABEL_MAX_DEPTH} 级；
 * - **截断**按"可用宽度 ÷ 单字宽"估算（`LABEL_CHAR_PX`），超出加 `…`——不引入字体度量依赖。
 */

import type { DocumentTask } from '@ganttpilot/engine';

/** 每级缩进（px）。 */
export const EXPORT_LABEL_INDENT_PX = 12;

/** 最多缩进到第几级（更深的层级不再叠加缩进，避免窄列被吃光）。 */
export const EXPORT_LABEL_MAX_DEPTH = 3;

/** 标签左内边距（px）。 */
export const EXPORT_LABEL_PADDING_PX = 6;

/** 一个标签的样式。 */
export interface ExportLabelStyle {
  readonly indentPx: number;
  readonly bold: boolean;
}

/** 由任务推出标签样式（汇总加粗；缩进按 WBS 深度）。 */
export function exportLabelStyleOf(task: DocumentTask | undefined): ExportLabelStyle {
  if (task === undefined) return { indentPx: 0, bold: false };
  const segments = task.outlineNumber === '' ? 1 : task.outlineNumber.split('.').length;
  const depth = Math.max(0, Math.min(EXPORT_LABEL_MAX_DEPTH, segments - 1));
  return { indentPx: depth * EXPORT_LABEL_INDENT_PX, bold: task.durationDays === null };
}

/** {@link exportLabelTextOf} 的入参。 */
export interface ExportLabelTextArgs {
  readonly task: DocumentTask | undefined;
  /** 回落到任务 id（任务不存在时用）。 */
  readonly fallback: string;
  /** 该列**总**可用宽度（px）；缩进由本函数内部扣除。 */
  readonly availablePx: number;
  /** 单字宽估算（px）——SVG 用 `LABEL_CHAR_PX`，PPTX 按字号折算。 */
  readonly charPx: number;
}

/**
 * 标签文本：`<outlineNumber> <name>`，按"总宽 − 内边距 − 缩进"截断。
 *
 * **不含缩进空格**：缩进是画法（SVG 的 `x`、PPTX 的文本框 `x`），不是文本的一部分——
 * 这样两边的文本逐字符相同，只有坐标不同（判据因此可以逐字比）。
 */
export function exportLabelTextOf(args: ExportLabelTextArgs): string {
  const { task } = args;
  if (task === undefined) return args.fallback;
  const prefix = task.outlineNumber === '' ? '' : `${task.outlineNumber} `;
  const full = `${prefix}${task.name}`;
  const style = exportLabelStyleOf(task);
  const usable = Math.max(args.charPx * 3, args.availablePx - EXPORT_LABEL_PADDING_PX - style.indentPx);
  const maxChars = Math.max(3, Math.floor(usable / args.charPx));
  return full.length <= maxChars ? full : `${full.slice(0, Math.max(2, maxChars - 1))}…`;
}
