/**
 * **导出投影**与单页适配（ADR 0010 §1–§3/§9–§11）。纯函数、零 DOM，**进 `pnpm gate`**。
 *
 * ## 与屏幕投影的关系：同一份几何，两种"窗口"
 *
 * 屏幕上，`buildView` 只对**视口窗口**算几何（ADR 0007 §6 的四条裁剪）——那是虚拟化的前提。
 * 导出没有"视口"这回事：产物是**整幅图**（ADR 0007 §10 的"导出是全量渲染"）。
 * 因此本模块**不新开几何**，只做两件事：
 *
 * 1. 用足够大的视口 + `clipMode: 'none'` 调 `buildView`，得到"全部可见行 + 全部可画边"的 `ViewModel`；
 * 2. 把内容尺寸按**唯一公式**等比映射到页面上（{@link fitScaleFor}）。
 *
 * ## 一处必须写清的偏离：**不得用视口宽抬升 `contentWidth`**
 *
 * `contentWidthFor` 的实现是 `max(视口宽, 右缘 + …)`——屏幕上那个 `max` 是**滚动容器**的需要
 * （范围给少了就滚不到项目末端）。导出没有视口，因此这里以 `viewportWidth: 0` 求值，
 * 取到的就是"文档右缘 + 引出段 + 回绕走廊 + 右留白"。
 *
 * ## 折叠跟随
 *
 * `rowCount` 取的是**折叠过滤后**的可见行数：折叠隐藏的行与其边不画（ADR 0007 §6.3 的既有语义）。
 * 因此"导出的行集合"= "用户对可见集的显式选择"，与屏幕一致。
 *
 * 契约出处：[ADR 0010 导出契约](../../../docs/02-adr/0010-导出契约.md)；
 * 数值回填：S-G7 的 `S7-d`（[证据](../../../packages/pptx-renderer/evidence/g7-s7-d-fit.md)）。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import { HEADER_HEIGHT_PX, ROW_HEIGHT, ZOOM_ORDER, ZOOM_PX_PER_DAY, type ZoomKey } from './manifest.js';
import { buildView, contentWidthFor, type ViewModel } from './viewModel.js';

/** 导出画布左侧**任务名列**的宽度（px；ADR 0010 §11 回填值）。 */
export const EXPORT_LABEL_WIDTH_PX = 200;

/** 页边距（px；ADR 0010 §11 回填值，16 px = 12 pt）。 */
export const EXPORT_MARGIN_PX = 16;

/** 模板 A 的默认页面：**16:9**（pt 与 px 两套口径；px 按 96 dpi）。 */
export const EXPORT_PAGE_16_9 = { widthPt: 720, heightPt: 405, widthPx: 960, heightPx: 540 } as const;

/** 行标签 / 轴标签的字号（**逻辑 px**，随 `scale` 一起缩放；与屏幕同源）。 */
export const EXPORT_LABEL_FONT_PX = 11;
export const EXPORT_AXIS_FONT_PX = 10;

/** 可读性判读阈值（pt）：≥8 可读、6–8 偏小、<6 不可读（ADR 0010 §11）。 */
export const EXPORT_READABLE_FONT_PT = 8;
export const EXPORT_MIN_FONT_PT = 6;

/** PNG 像素上限（ADR 0010 §11；超出给 `EXPORT_PNG_TOO_LARGE` 提示，不静默失败）。 */
export const EXPORT_PNG_MAX_PIXELS = 32_000_000;

/** 模板 A 的里程碑清单上限（超出截断并注明"…共 N 个"）。 */
export const EXPORT_MILESTONE_LIST_MAX = 8;

/** 导出投影（全量渲染的视图模型 + 画布尺寸）。 */
export interface ExportView {
  readonly view: ViewModel;
  /** 文档右缘推出的内容宽（**未**被视口宽抬升）。 */
  readonly contentWidth: number;
  /** 画布宽 = 任务名列 + 内容宽。 */
  readonly innerWidth: number;
  /** 画布高 = 表头带 + 可见行 × 行高。 */
  readonly innerHeight: number;
  readonly rowCount: number;
}

/** {@link buildExportView} 的入参。 */
export interface BuildExportViewArgs {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  /** **必须**是 `createScheduleCalendar(document)`（ADR 0007 §3）。 */
  readonly calendar: Calendar;
  readonly zoom: ZoomKey;
}

/**
 * 全量渲染的导出投影（ADR 0010 §2）。
 *
 * 两遍构造：第一遍只为取 `axisOriginDay` 与文档右缘（`contentWidth`），第二遍用"整篇尺寸"的视口
 * 重建——`buildView` 的行窗口由视口高推出，因此"全量"= 视口高恰好等于全部行。
 */
export function buildExportView(args: BuildExportViewArgs): ExportView {
  const { document, schedule, calendar, zoom } = args;
  const pxPerDay = ZOOM_PX_PER_DAY[zoom];

  const probe = buildView({
    document,
    schedule,
    calendar,
    zoom,
    viewport: { scrollTop: 0, scrollLeft: 0, width: 0, height: 0, rowHeight: ROW_HEIGHT, rowBuffer: 0 },
  });

  // 视口宽 0：导出没有视口，不得让 `max(视口宽, 右缘)` 改变内容宽（本模块文件头第 2 条）。
  const contentWidth = contentWidthFor({
    calendar,
    projectFinish: schedule.projectFinish,
    axisOriginDay: probe.axisOriginDay,
    pxPerDay,
    viewportWidth: 0,
  });

  const rowCount = probe.rowCount;
  const view = buildView({
    document,
    schedule,
    calendar,
    zoom,
    clipMode: 'none',
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      width: contentWidth,
      height: HEADER_HEIGHT_PX + rowCount * ROW_HEIGHT,
      rowHeight: ROW_HEIGHT,
      rowBuffer: 0,
    },
  });

  const innerWidth = EXPORT_LABEL_WIDTH_PX + contentWidth;
  const innerHeight = HEADER_HEIGHT_PX + rowCount * ROW_HEIGHT;
  return { view, contentWidth, innerWidth, innerHeight, rowCount };
}

/** 适配变换（等比 + 居中；ADR 0010 §3）。 */
export interface FitTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly availableWidth: number;
  readonly availableHeight: number;
}

/**
 * 单页适配：**等比**缩放到页面可用区并居中。
 *
 * 等比是硬约束：非等比缩放会把圆角矩形与菱形拉变形（S1 结论 §六 教训 2）。
 * 退化输入（`innerWidth`/`innerHeight` ≤ 0）返回 `scale = 1` 且不抛错——空文档也要能导出（一张空页）。
 */
export function fitScaleFor(args: {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly pageWidthPx: number;
  readonly pageHeightPx: number;
  readonly marginPx?: number;
}): FitTransform {
  const margin = args.marginPx ?? EXPORT_MARGIN_PX;
  const availableWidth = Math.max(1, args.pageWidthPx - margin * 2);
  const availableHeight = Math.max(1, args.pageHeightPx - margin * 2);
  if (!(args.innerWidth > 0) || !(args.innerHeight > 0)) {
    return { scale: 1, offsetX: margin, offsetY: margin, availableWidth, availableHeight };
  }
  const scale = Math.min(availableWidth / args.innerWidth, availableHeight / args.innerHeight);
  return {
    scale,
    offsetX: margin + (availableWidth - args.innerWidth * scale) / 2,
    offsetY: margin + (availableHeight - args.innerHeight * scale) / 2,
    availableWidth,
    availableHeight,
  };
}

/** 适配后的**有效字号**判读（导出前可读性提示的判据来源）。 */
export interface ExportReadability {
  readonly scale: number;
  readonly rowHeightPt: number;
  readonly labelFontPt: number;
  readonly axisFontPt: number;
  readonly verdict: 'readable' | 'small' | 'unreadable';
}

/** px → pt（96 dpi）。 */
export function pxToPt(px: number): number {
  return (px * 72) / 96;
}

/** 由适配变换推出"这一页上的字号有多大"（ADR 0010 §11 的阈值判据）。 */
export function exportReadabilityOf(transform: FitTransform): ExportReadability {
  const labelFontPt = pxToPt(EXPORT_LABEL_FONT_PX * transform.scale);
  const axisFontPt = pxToPt(EXPORT_AXIS_FONT_PX * transform.scale);
  const rowHeightPt = pxToPt(ROW_HEIGHT * transform.scale);
  const verdict: ExportReadability['verdict'] =
    labelFontPt >= EXPORT_READABLE_FONT_PT ? 'readable' : labelFontPt >= EXPORT_MIN_FONT_PT ? 'small' : 'unreadable';
  return { scale: transform.scale, rowHeightPt, labelFontPt, axisFontPt, verdict };
}

/** 导出前的可读性提示（ADR 0010 §11 的"提示动作"；**不阻断**）。 */
export interface ExportAdvisory {
  readonly current: ExportReadability;
  /** 除当前档位外、**可读**的档位（按 `ZOOM_ORDER`）。 */
  readonly readableZooms: readonly ZoomKey[];
  /** `null` = 当前档位已可读；`switch-zoom` = 换档可救；`collapse` = 三档都不可读，只能折叠。 */
  readonly advice: 'switch-zoom' | 'collapse' | null;
}

/** {@link exportAdvisoryFor} 的入参。 */
export interface ExportAdvisoryArgs extends BuildExportViewArgs {
  readonly pageWidthPx?: number;
  readonly pageHeightPx?: number;
}

/**
 * 逐档位算一遍适配，给出"这一档导出会不会糊、以及该建议什么"。
 *
 * 判据（ADR 0010 §11）：
 * - 当前档位可读 ⇒ `advice: null`；
 * - 当前档位不可读、但另一档位可读 ⇒ `switch-zoom`（如演示计划：日档 4.9 pt、周/月档 10.8 pt）；
 * - 三档都不可读（如 1,000 行：0.2 pt）⇒ `collapse`。
 */
export function exportAdvisoryFor(args: ExportAdvisoryArgs): ExportAdvisory {
  const pageWidthPx = args.pageWidthPx ?? EXPORT_PAGE_16_9.widthPx;
  const pageHeightPx = args.pageHeightPx ?? EXPORT_PAGE_16_9.heightPx;
  const readability = new Map<ZoomKey, ExportReadability>();
  for (const zoom of ZOOM_ORDER) {
    const projection = buildExportView({
      document: args.document,
      schedule: args.schedule,
      calendar: args.calendar,
      zoom,
    });
    const transform = fitScaleFor({
      innerWidth: projection.innerWidth,
      innerHeight: projection.innerHeight,
      pageWidthPx,
      pageHeightPx,
    });
    readability.set(zoom, exportReadabilityOf(transform));
  }
  const current = readability.get(args.zoom) ?? exportReadabilityOf(
    fitScaleFor({ innerWidth: 1, innerHeight: 1, pageWidthPx, pageHeightPx }),
  );
  if (current.verdict === 'readable') return { current, readableZooms: [], advice: null };
  const readableZooms = ZOOM_ORDER.filter((zoom) => zoom !== args.zoom && readability.get(zoom)?.verdict === 'readable');
  return { current, readableZooms, advice: readableZooms.length > 0 ? 'switch-zoom' : 'collapse' };
}
