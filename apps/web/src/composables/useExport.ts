/**
 * 导出接线（G7）：把 `render-core` 的导出投影/SVG 与 `pptx-renderer` 的模板 A 接到浏览器上。
 *
 * ## 分工（ADR 0010 §1）
 *
 * - **几何与文本**来自 `render-core`（零 DOM，进门禁）：本文件一个坐标都不算；
 * - **PPTX** 来自 `pptx-renderer`（零 DOM，进门禁）：本文件**动态 `import()`** 它，
 *   因此 `pptxgenjs`（271 KB min）**不进首屏主 chunk**（与 `exceljs` 同一纪律，见 ADR 0006 §11）；
 * - **DOM 只在这里**：PNG 光栅化（`Image` + `canvas`）、下载（`Blob` + `<a download>`）——
 *   这是"应用层是 DOM 唯一合法落点"那半条铁律的落点。
 *
 * ## 两条产品口径（ADR 0010 §7/§11）
 *
 * - 「含图例与摘要」是**开关**：SVG/PNG 由用户选；**PPTX 模板 A 固定含**（EX-06），
 *   因此该开关对 PPTX 置灰（界面上说明，而不是悄悄忽略）；
 * - **可读性提示**：按当前档位算一遍适配字号，偏小就提示"建议切换档位/先折叠"——**不阻断导出**
 *   （用户可能就是要一张全量图）。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Calendar } from '@ganttpilot/engine';
import {
  buildExportView,
  exportAdvisoryFor,
  exportSummaryOf,
  EXPORT_PAGE_16_9,
  EXPORT_PNG_MAX_PIXELS,
  svgInnerSizeOf,
  svgString,
  ZOOM_LABEL,
  type ProjectDocument,
  type Schedule,
  type ZoomKey,
} from '@ganttpilot/render-core';

/** 导出格式。 */
export type ExportFormat = 'svg' | 'png' | 'pptx';

/** PNG 倍率选项（EX-02 的"多倍率"）。 */
export const PNG_SCALES = [1, 2, 3] as const;

/** {@link useExport} 的入参。 */
export interface UseExportArgs {
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  readonly calendar: ComputedRef<Calendar>;
  readonly zoom: Ref<ZoomKey>;
  /** 提示通道（沿用既有 `notice`，P-30/P-31 的落点）。 */
  readonly notify: (level: 'info' | 'error', text: string) => void;
}

/** 导出控制器（App.vue 只消费它）。 */
export interface ExportController {
  readonly format: Ref<ExportFormat>;
  readonly pngScale: Ref<number>;
  readonly includeSidebar: Ref<boolean>;
  readonly busy: Ref<boolean>;
  /** 导出前的可读性提示（状态栏那一栏直接渲染它；ADR 0010 §11）。 */
  readonly advisory: ComputedRef<string>;
  exportNow: () => Promise<void>;
}

/** 文件名的安全化（去路径分隔符与常见非法字符）。 */
function safeName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').trim();
  return cleaned === '' ? 'gantt' : cleaned;
}

/** `Blob` → 下载（应用层是 DOM 的唯一合法落点）。 */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻回收会把还在走的下载打断，给一个宏任务窗口。
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * SVG → PNG（**用自研几何序列化出来的 SVG**，不是截屏）。
 *
 * 白底是必须的：SVG 本身透明，PNG 贴进 PPT/文档里需要不透明底（否则在深色主题下像"缺了一块"）。
 */
async function rasterizePng(svg: string, widthPx: number, heightPx: number): Promise<Blob> {
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(widthPx));
    canvas.height = Math.max(1, Math.round(heightPx));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d 上下文不可用');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (blob === null) throw new Error('canvas.toBlob 返回 null');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 导出接线（见文件头）。 */
export function useExport(args: UseExportArgs): ExportController {
  const format = ref<ExportFormat>('svg');
  const pngScale = ref<number>(2);
  const includeSidebar = ref(false);
  const busy = ref(false);

  /** 导出前的可读性提示（按当前档位算；`advice === null` 时只报字号）。 */
  const advisoryText = computed<string>(() => {
    const schedule = args.schedule.value;
    if (schedule === null) return '';
    const advisory = exportAdvisoryFor({
      document: args.document.value,
      schedule,
      calendar: args.calendar.value,
      zoom: args.zoom.value,
    });
    const font = advisory.current.labelFontPt.toFixed(1);
    if (advisory.advice === null) return `导出预估字号 ${font} pt（可读）`;
    if (advisory.advice === 'switch-zoom') {
      const names = advisory.readableZooms.map((zoom) => ZOOM_LABEL[zoom]).join('/');
      return `当前档位导出后字号约 ${font} pt（偏小）：建议切到「${names}」档再导出`;
    }
    return `内容超出单页可读范围（字号约 ${font} pt）：建议先折叠阶段或导出后自行取舍`;
  });

  async function exportSvgOrPng(kind: 'svg' | 'png'): Promise<void> {
    const schedule = args.schedule.value;
    if (schedule === null) {
      args.notify('error', '当前文档不可排程：先修掉成环依赖（EXPORT_UNSCHEDULABLE）');
      return;
    }
    const projection = buildExportView({
      document: args.document.value,
      schedule,
      calendar: args.calendar.value,
      zoom: args.zoom.value,
    });
    if (projection.rowCount === 0) {
      args.notify('error', '没有可导出的行：请先展开至少一个阶段（EXPORT_NO_ROWS）');
      return;
    }
    const options = {
      title: args.document.value.project.name,
      includeLegend: includeSidebar.value,
      includeSummary: includeSidebar.value,
      summary: exportSummaryOf({
        document: args.document.value,
        schedule,
        calendar: args.calendar.value,
      }),
    };
    const svg = svgString({ view: projection.view, document: args.document.value, options });
    const inner = svgInnerSizeOf({ view: projection.view, options });
    const base = `${safeName(args.document.value.project.name)}-${args.zoom.value}`;

    if (kind === 'svg') {
      download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${base}.svg`);
      args.notify('info', `已导出 SVG（${String(inner.innerWidth)}×${String(inner.innerHeight)} px，${String(projection.rowCount)} 行）`);
      return;
    }

    const width = inner.innerWidth * pngScale.value;
    const height = inner.innerHeight * pngScale.value;
    if (width * height > EXPORT_PNG_MAX_PIXELS) {
      args.notify(
        'error',
        `PNG 尺寸超限（${String(Math.round(width))}×${String(Math.round(height))}）：请降低倍率或先折叠（EXPORT_PNG_TOO_LARGE）`,
      );
      return;
    }
    const blob = await rasterizePng(svg, width, height);
    download(blob, `${base}@${String(pngScale.value)}x.png`);
    args.notify('info', `已导出 PNG ${String(pngScale.value)}×（${String(Math.round(width))}×${String(Math.round(height))} px）`);
  }

  async function exportPptx(): Promise<void> {
    const schedule = args.schedule.value;
    if (schedule === null) {
      args.notify('error', '当前文档不可排程：先修掉成环依赖（EXPORT_UNSCHEDULABLE）');
      return;
    }
    let renderTemplateA: (input: {
      readonly document: ProjectDocument;
      readonly schedule: Schedule;
      readonly calendar: Calendar;
      readonly zoom: ZoomKey;
    }) => Promise<Uint8Array>;
    try {
      ({ renderTemplateA } = await import('@ganttpilot/pptx-renderer'));
    } catch (error) {
      args.notify('error', `导出库加载失败：本次可用 SVG/PNG（EXPORT_LIB_LOAD_FAILED）——${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const bytes = await renderTemplateA({
      document: args.document.value,
      schedule,
      calendar: args.calendar.value,
      zoom: args.zoom.value,
    });
    // `Blob` 只出现在这里：`pptx-renderer` 只准产出 `Uint8Array`（零 DOM 的硬约束）。
    download(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), `${safeName(args.document.value.project.name)}-模板A.pptx`);
    args.notify('info', `已导出 PPTX 模板 A（${String(bytes.length)} 字节；原生形状，可在 WPS 里拖动任务条看端点跟随）`);
  }

  async function exportNow(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      if (format.value === 'svg') await exportSvgOrPng('svg');
      else if (format.value === 'png') await exportSvgOrPng('png');
      else await exportPptx();
    } catch (error) {
      args.notify('error', `导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.value = false;
    }
  }

  return { format, pngScale, includeSidebar, busy, advisory: advisoryText, exportNow };
}

/** 页面尺寸（供测试与提示复用）。 */
export const EXPORT_PAGE = EXPORT_PAGE_16_9;
