/**
 * 单位换算与页面/形状常量（`@ganttpilot/pptx-renderer` 的**唯一真相处**）。
 *
 * 三条口径（ADR 0010 §8）：
 * 1. **仿射只在这里做**：`px → pt → EMU`。其余模块只消费本文件的函数，不自己乘除；
 * 2. **写出整数 EMU**：`Math.round` 收口，避免浮点尾巴破坏 golden（ADR 0010 §9）；
 * 3. **常量与判据同处**：`p:sldSz` 的声明值在 `TEMPLATE_A_PAGE`，写出后由 `template.spec.ts`
 *    **读回断言**（S1 教训 1：常量与容器漂移会让下游断言集体失灵）。
 *
 * 1 pt = 12700 EMU；1 英寸 = 72 pt = 96 px（CSS 像素口径）。
 */

/** 1 pt 的 EMU 数。 */
export const EMU_PER_PT = 12700;

/** 1 px（CSS 像素）的 pt 数（96 dpi）。 */
export const PT_PER_PX = 72 / 96;

/** 1 px 的 EMU 数。 */
export const EMU_PER_PX = EMU_PER_PT / (96 / 72);

/** px → pt。 */
export function pxToPt(px: number): number {
  return px * PT_PER_PX;
}

/** px → EMU（整数）。 */
export function pxToEmu(px: number): number {
  return Math.round((px * EMU_PER_PT * 72) / 96);
}

/** pt → EMU（整数）。 */
export function ptToEmu(pt: number): number {
  return Math.round(pt * EMU_PER_PT);
}

/** px → 英寸（pptxgenjs 的原生单位）。 */
export function pxToInch(px: number): number {
  return px / 96;
}

/**
 * 模板 A 的默认页面：**16:9**。
 *
 * 数值是 **pptxgenjs 的 `LAYOUT_16x9`（10 × 5.625 英寸）实测**得到的 `p:sldSz`，
 * 不是"我们希望它是什么"：S1 曾把常量写成 960 × 540 pt，而容器实际是 720 × 405 pt，
 * 结果边界断言全部拿错常量比较。写出后必须读回断言。
 */
export const TEMPLATE_A_PAGE = { widthEmu: 9144000, heightEmu: 5143500, widthPt: 720, heightPt: 405 } as const;

/** 页面在 CSS 像素口径下的尺寸（960 × 540 px）。 */
export const TEMPLATE_A_PAGE_PX = { width: 960, height: 540 } as const;

/** 模板 A 的内边距（px）。 */
export const TEMPLATE_A_MARGIN_PX = 16;

/** 右侧图例/摘要栏宽（px）；与 `render-core` 的 `EXPORT_SIDEBAR_WIDTH_PX` 同值（两处由 spec 断言相等）。 */
export const TEMPLATE_A_SIDEBAR_PX = 260;

/** 侧栏与甘特区之间的间距（px）。 */
export const TEMPLATE_A_SIDEBAR_GAP_PX = 12;

/** 标题带高（px）。 */
export const TEMPLATE_A_TITLE_PX = 34;

/** 字号（**pt**，PPTX 的原生单位；模板 A 不随适配缩放，最小可读性由 S7-d 定标 + 提示兜底）。 */
export const FONT = {
  title: 16,
  stage: 11,
  task: 10,
  axis: 9,
  legend: 9,
  summary: 9,
} as const;

/** 颜色（OOXML 用不带 `#` 的十六进制；与 `apps/web` 的 SVG 同值）。 */
export const COLOR = {
  bar: '2E75B6',
  barSummary: '7A8699',
  progress: '1F4E79',
  milestone: 'ED7D31',
  milestoneStroke: 'B1551A',
  edge: '475467',
  edgeIgnored: 'C9CCD1',
  text: '1F2933',
  muted: '667085',
  band: 'F4F6F8',
  gridline: 'E4E7EC',
  /** 上级刻度分段带（P-46 的两级刻度；与 `render-core` 的 `AXIS_MAJOR_FILL` 同值）。 */
  majorBand: 'EEF1F5',
  white: 'FFFFFF',
} as const;
