/**
 * **模板 A**：单页总览 = 标题 + 甘特（含左列任务名）+ 图例 + 自动摘要（EX-06）。零 DOM，**进 `pnpm gate`**。
 *
 * ## 管线（与 S1 实证的完全一致）
 *
 * ```
 * pptxgenjs 造容器（版面/母版/主题 + 文本） → JSZip 解包
 *   → 注入原生形状（条 / 进度 / 菱形 / 一级组 / 吸附 connector）
 *   → 归一化时间戳（core.xml 时间字段 + 全部 zip 条目日期）
 *   → 重新打包 → Uint8Array
 * ```
 *
 * **为什么文本走 pptxgenjs、几何走补丁**：文本由库负责最稳（字体/行距/换行是渲染器的约定），
 * 而几何必须由我们说了算——补丁写出的是**同一份 `ViewModel`**（与屏幕、与 SVG 同源）。
 * 反过来说，**补丁是几何的唯一作者**：库的 API 变化不会挪动我们画出来的位置。
 *
 * ## 三条硬约束
 *
 * 1. **零 DOM**：只允许 `outputType: 'uint8array'`（`Blob` 路径留给 `apps/web`）；
 * 2. **容器尺寸读回断言**：`p:sldSz` 必须等于 {@link TEMPLATE_A_PAGE}（S1 教训 1）；
 * 3. **归一化**：ADR 0010 §9 的三步（S7-c 已证字节级 golden 可达）。
 */

import type { Calendar, DocumentTask, ProjectDocument, Schedule } from '@ganttpilot/engine';
import JSZip from 'jszip';
import {
  buildExportView,
  exportLabelStyleOf,
  exportLabelTextOf,
  exportLegendItems,
  exportSummaryLines,
  exportSummaryOf,
  EXPORT_LABEL_PADDING_PX,
  EXPORT_LABEL_WIDTH_PX,
  fitScaleFor,
  HEADER_HEIGHT_PX,
  LABEL_CHAR_PX,
  ROUTE_SIDES,
  ROW_HEIGHT,
  type EdgeGeom,
  type ExportLegendItem,
  type ExportSummary,
  type ExportView,
  type FitTransform,
  type RowBox,
  type RouteSide,
  type ZoomKey,
} from '@ganttpilot/render-core';

import {
  COLOR,
  FONT,
  TEMPLATE_A_MARGIN_PX,
  TEMPLATE_A_PAGE,
  TEMPLATE_A_PAGE_PX,
  TEMPLATE_A_SIDEBAR_GAP_PX,
  TEMPLATE_A_SIDEBAR_PX,
  TEMPLATE_A_TITLE_PX,
  pxToEmu,
  pxToInch,
  pxToPt,
} from './units.js';
import {
  IdAllocator,
  NAMES,
  barSpXml,
  buildIdMap,
  connectorSpXml,
  custGeomSpXml,
  extractSpTree,
  groupSpXml,
  injectIntoSpTree,
  milestoneSpXml,
  parseShapeRefs,
  plainRectSpXml,
  progressSpXml,
  siteForSide,
  triangleSpXml,
  type EmuRect,
  type GroupChildXml,
} from './ooxml.js';

/** 归一化用的固定时间（ADR 0010 §9）：`2000-01-01T00:00:00Z`。 */
export const FIXED_TIMESTAMP_ISO = '2000-01-01T00:00:00Z';

/**
 * pptxgenjs 的**最小结构类型**：只声明本包用到的面（容器 + 文本）。
 *
 * 为什么不直接 `import PptxGenJS from 'pptxgenjs'`：该包的 `exports` 字段没有 `.` 键
 * （写成 `{"types": …, "import": …, "require": …}`），在 `moduleResolution: nodenext` 下
 * TypeScript 解析出的默认导入不是构造函数（S1 的 spike 用 `Bundler` 解析因此没暴露这个问题）。
 * 这里改为**动态 import + 结构类型**：既绕开包的导出映射瑕疵，又让"我们依赖了库的哪几样东西"
 * 在类型层面一目了然（换库/升级时编译器会告诉我们）。
 */
export interface PptxTextOptions {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fontSize: number;
  readonly color: string;
  readonly bold: boolean;
  readonly align: 'left';
  readonly valign: 'top';
  readonly margin: number;
  readonly objectName: string;
}

/** 幻灯片（只用到 `addText`）。 */
export interface PptxSlideLike {
  addText(text: string, options: PptxTextOptions): unknown;
}

/** 演示文稿（只用到版面、属性、加页与写出）。 */
export interface PptxPresentationLike {
  layout: string;
  subject: string;
  title: string;
  author: string;
  company: string;
  defineLayout(layout: { readonly name: string; readonly width: number; readonly height: number }): void;
  addSlide(): PptxSlideLike;
  write(options: { readonly outputType: 'uint8array' }): Promise<unknown>;
}

/** pptxgenjs 的构造函数签名。 */
export type PptxConstructor = new () => PptxPresentationLike;

/** 取 pptxgenjs 的构造函数（**动态 import**：浏览器里它因此不进首屏主 chunk）。 */
export async function loadPptxGenJS(): Promise<PptxConstructor> {
  const loaded = (await import('pptxgenjs')) as unknown as { default?: PptxConstructor };
  const ctor = loaded.default;
  if (typeof ctor !== 'function') throw new Error('pptxgenjs 未导出构造函数（上游导出映射变了？）');
  return ctor;
}

/** 归一化用的固定 zip 条目日期。 */
export const FIXED_ZIP_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/** 侧向表的类型化视图（唯一登记处是 P-8 第 1 条；本处只消费）。 */
const SIDES: Readonly<Record<string, { readonly exit: RouteSide; readonly enter: RouteSide }>> = ROUTE_SIDES;

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
interface Box {
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

  // 侧栏图例排版（文本与色块共用这些 y）
  const legendRows: { item: ExportLegendItem; y: number }[] = [];
  let legendY = sidebarBox.y + 16 + 16; // 「图例」标题 + 间距
  for (const item of exportLegendItems()) {
    legendRows.push({ item, y: legendY });
    legendY += 14;
  }

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
  };
}

/** 内部内容坐标 → 页面 px（`innerX` 含左侧标签列偏移，与 `svgString` 同一套口径）。 */
export function slidePointOf(plan: TemplateAPlan, innerX: number, innerY: number): { x: number; y: number } {
  return {
    x: plan.ganttBox.x + plan.fit.offsetX + innerX * plan.fit.scale,
    y: plan.ganttBox.y + plan.fit.offsetY + innerY * plan.fit.scale,
  };
}

/** 一行条形（或菱形）在内层坐标系里的矩形。 */
function innerRectOfRow(row: RowBox): { x: number; y: number; width: number; height: number } {
  if (row.isMilestone && row.milestone !== null) {
    const half = row.milestone.size / 2;
    return {
      x: EXPORT_LABEL_WIDTH_PX + row.milestone.cx - half,
      y: row.milestone.cy - half,
      width: row.milestone.size,
      height: row.milestone.size,
    };
  }
  return {
    x: EXPORT_LABEL_WIDTH_PX + row.xLeft,
    y: row.barY,
    width: Math.max(1, row.xRight - row.xLeft),
    height: row.barHeight,
  };
}

/** 内层矩形 → 页面 EMU 矩形（`y` 要加上表头带，与 `svgString` 的 `offsetY` 同口径）。 */
function emuRectOf(plan: TemplateAPlan, rect: { x: number; y: number; width: number; height: number }): EmuRect {
  const topLeft = slidePointOf(plan, rect.x, HEADER_HEIGHT_PX + rect.y);
  return {
    x: pxToEmu(topLeft.x),
    y: pxToEmu(topLeft.y),
    cx: Math.max(1, pxToEmu(rect.width * plan.fit.scale)),
    cy: Math.max(1, pxToEmu(rect.height * plan.fit.scale)),
  };
}

/** 条形中心的**内层** y（连接点的竖向位置；里程碑取菱形中心）。 */
function barCenterInnerY(row: RowBox): number {
  if (row.isMilestone && row.milestone !== null) return row.milestone.cy;
  return row.barY + row.barHeight / 2;
}

/** 依赖线端点的**内层** x（出/入侧取条边；里程提取菱形左右顶点）。 */
function sideInnerX(row: RowBox, side: RouteSide): number {
  if (row.isMilestone && row.milestone !== null) {
    const half = row.milestone.size / 2;
    return EXPORT_LABEL_WIDTH_PX + row.milestone.cx + (side === 'right' ? half : -half);
  }
  return EXPORT_LABEL_WIDTH_PX + (side === 'right' ? row.xRight : row.xLeft);
}

/** 一行的形状片段（补丁的注入单位）。 */
interface RowFragment {
  readonly xml: string;
  readonly emu: EmuRect;
}

/** 一行的注入结果：片段清单 + 供 connector 引用的形状 id/name。 */
interface RowShapes {
  readonly fragments: readonly RowFragment[];
  readonly barId: number;
  readonly barName: string;
}

/** 一段文本（模板 A 的标题/标签/图例/摘要）。 */
interface TextLine {
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
function labelOf(task: DocumentTask | undefined, fallback: string): {
  readonly text: string;
  readonly indentPx: number;
  readonly bold: boolean;
} {
  const style = exportLabelStyleOf(task);
  return {
    text: exportLabelTextOf({ task, fallback, availablePx: EXPORT_LABEL_WIDTH_PX, charPx: LABEL_CHAR_PX }),
    indentPx: style.indentPx,
    bold: style.bold,
  };
}

/** 模板 A 的全部文本块（标题 + 日期刻度 + 行标签 + 图例 + 摘要）。 */
function textLinesOf(plan: TemplateAPlan, document: ProjectDocument, title: string): readonly TextLine[] {
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
  for (const [index, element] of plan.projection.view.axis.entries()) {
    if (element.kind !== 'label') continue;
    const point = slidePointOf(plan, EXPORT_LABEL_WIDTH_PX + element.x + 2, 4);
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
    y: plan.sidebarBox.y,
    width: plan.sidebarBox.width,
    fontSize: FONT.legend + 1,
    color: COLOR.text,
    bold: true,
    objectName: NAMES.legend(0),
  });
  for (const [index, row] of plan.legendRows.entries()) {
    lines.push({
      text: row.item.label,
      x: plan.sidebarBox.x + 24,
      y: row.y - 6,
      width: plan.sidebarBox.width - 24,
      fontSize: FONT.legend,
      color: COLOR.text,
      bold: false,
      objectName: NAMES.legend(index + 1),
    });
  }

  // 侧栏：摘要（文案与 SVG 同源：`exportSummaryLines`）
  const summaryLines = exportSummaryLines(plan.summary);
  let y = plan.sidebarBox.y + 16 + plan.legendRows.length * 14 + 14;
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
  y += 16;
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
    y += 13;
  }
  return lines;
}

/** 一行的形状片段构造（条 / 进度 / 菱形）。 */
function buildRowShapes(args: {
  readonly plan: TemplateAPlan;
  readonly row: RowBox;
  readonly allocator: IdAllocator;
}): RowShapes {
  const { plan, row, allocator } = args;
  if (row.isMilestone && row.milestone !== null) {
    const emu = emuRectOf(plan, innerRectOfRow(row));
    const id = allocator.next();
    return {
      fragments: [
        {
          xml: milestoneSpXml({
            id,
            name: NAMES.milestone(row.id),
            rect: emu,
            fill: COLOR.milestone,
            stroke: COLOR.milestoneStroke,
          }),
          emu,
        },
      ],
      barId: id,
      barName: NAMES.milestone(row.id),
    };
  }

  const emu = emuRectOf(plan, innerRectOfRow(row));
  const barId = allocator.next();
  const fragments: RowFragment[] = [
    {
      xml: barSpXml({
        id: barId,
        name: NAMES.bar(row.id),
        rect: emu,
        fill: row.kind === 'summary' ? COLOR.barSummary : COLOR.bar,
        round: row.kind !== 'summary',
      }),
      emu,
    },
  ];
  if (row.hasProgress && emu.cx > 1) {
    const progressEmu: EmuRect = {
      x: emu.x,
      y: emu.y + 1,
      cx: Math.max(1, Math.round(emu.cx * row.progressRatio)),
      cy: Math.max(1, emu.cy - 2),
    };
    fragments.push({
      xml: progressSpXml({ id: allocator.next(), name: NAMES.progress(row.id), rect: progressEmu, fill: COLOR.progress }),
      emu: progressEmu,
    });
  }
  return { fragments, barId, barName: NAMES.bar(row.id) };
}

/**
 * 背景图元（人工复验第 2 条）：**周末/节假日灰度带 + 背景网格线**。
 *
 * 与 SVG 取自**同一份** `view.axis`（`band` / `gridline`），因此两边的"哪几天是休息日"逐格一致。
 * 注入顺序在条形之前 ⇒ 天然在底层（OOXML 按文档序绘制）。
 */
function backgroundXmlOf(args: {
  readonly plan: TemplateAPlan;
  readonly allocator: IdAllocator;
}): readonly string[] {
  const { plan, allocator } = args;
  const rowsHeight = plan.projection.view.rowCount * plan.projection.view.rowHeight * plan.fit.scale;
  const top = slidePointOf(plan, 0, HEADER_HEIGHT_PX).y;
  const left = slidePointOf(plan, EXPORT_LABEL_WIDTH_PX, 0).x;
  const out: string[] = [];
  let bandIndex = 0;
  let gridIndex = 0;
  for (const element of plan.projection.view.axis) {
    if (element.kind === 'band') {
      const x = plan.ganttBox.x + plan.fit.offsetX + (EXPORT_LABEL_WIDTH_PX + element.x) * plan.fit.scale;
      // **裁到绘制区内**：`buildAxis` 允许色带越过右缘（SVG 里由侧栏底色盖住），
      // PPTX 的侧栏是透明的 ⇒ 不裁就会在侧栏区里露出一条灰带。
      // 注意：**计数必须与 `view.axis` 的 band 数一致**（判据断言"逐条同源"），因此夹到 ≥1 px 而不是跳过。
      const widthPx = Math.max(1, Math.min(element.width, plan.projection.view.width - Math.max(0, element.x)));
      out.push(
        plainRectSpXml({
          id: allocator.next(),
          name: NAMES.band(bandIndex),
          rect: {
            x: pxToEmu(x),
            y: pxToEmu(top),
            cx: Math.max(1, pxToEmu(widthPx * plan.fit.scale)),
            cy: Math.max(1, pxToEmu(rowsHeight)),
          },
          fill: COLOR.band,
        }),
      );
      bandIndex += 1;
      continue;
    }
    if (element.kind === 'gridline') {
      const clamped = Math.min(Math.max(element.x, 0), plan.projection.view.width);
      const x = plan.ganttBox.x + plan.fit.offsetX + (EXPORT_LABEL_WIDTH_PX + clamped) * plan.fit.scale;
      out.push(
        plainRectSpXml({
          id: allocator.next(),
          name: NAMES.grid(gridIndex),
          rect: {
            x: pxToEmu(x),
            y: pxToEmu(top),
            cx: Math.max(1, pxToEmu(1)),
            cy: Math.max(1, pxToEmu(rowsHeight)),
          },
          fill: COLOR.gridline,
        }),
      );
      gridIndex += 1;
    }
  }
  void left;
  return out;
}

/**
 * 图例的**图元**（人工复验第 4 条）：与 `exportLegendItems()` 的条目一一对应，
 * 坐标与文本取自同一份 `plan.legendRows`。
 *
 * 四类依赖的箭头形态必须与条形图里一致（FS/FF 实心三角、SS/SF 空心箭头）——
 * 图例的职责就是"教会读者看图"，只画一条灰线等于没解释。
 */
function legendSwatchXmlOf(args: {
  readonly plan: TemplateAPlan;
  readonly allocator: IdAllocator;
}): readonly string[] {
  const { plan, allocator } = args;
  const out: string[] = [];
  for (const row of plan.legendRows) {
    const styleKey = row.item.styleKey;
    const x = plan.sidebarBox.x + 4;
    if (styleKey === 'bar' || styleKey === 'bar-summary') {
      const height = styleKey === 'bar' ? 10 : 6;
      out.push(
        plainRectSpXml({
          id: allocator.next(),
          name: NAMES.legendSwatch(styleKey),
          rect: {
            x: pxToEmu(x),
            y: pxToEmu(row.y - 9),
            cx: pxToEmu(18),
            cy: pxToEmu(height),
          },
          fill: styleKey === 'bar' ? COLOR.bar : COLOR.barSummary,
        }),
      );
      continue;
    }
    if (styleKey === 'milestone') {
      out.push(
        milestoneSpXml({
          id: allocator.next(),
          name: NAMES.legendSwatch(styleKey),
          rect: { x: pxToEmu(x), y: pxToEmu(row.y - 15), cx: pxToEmu(12), cy: pxToEmu(12) },
          fill: COLOR.milestone,
          stroke: COLOR.milestoneStroke,
        }),
      );
      continue;
    }
    const type = styleKey.replace('edge-', '');
    const hollow = type === 'SS' || type === 'SF';
    out.push(
      plainRectSpXml({
        id: allocator.next(),
        name: NAMES.legendSwatch(styleKey),
        rect: { x: pxToEmu(x), y: pxToEmu(row.y - 8), cx: pxToEmu(14), cy: pxToEmu(1.5) },
        fill: COLOR.edge,
      }),
    );
    out.push(
      triangleSpXml({
        id: allocator.next(),
        name: `${NAMES.legendSwatch(styleKey)}-head`,
        rect: { x: pxToEmu(x + 13), y: pxToEmu(row.y - 10), cx: pxToEmu(10), cy: pxToEmu(6) },
        rotateDeg: 90,
        fill: hollow ? COLOR.white : COLOR.edge,
        stroke: COLOR.edge,
      }),
    );
  }
  return out;
}

/** 解包后的产物尺寸（`p:sldSz`）。 */
export async function readSlideSize(bytes: Uint8Array): Promise<{ readonly cx: number; readonly cy: number }> {
  const xml = await readPptxEntry(bytes, 'ppt/presentation.xml');
  const match = /<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/.exec(xml);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('未在 presentation.xml 里找到 p:sldSz');
  return { cx: Number(match[1]), cy: Number(match[2]) };
}

/** 读产物里的任一文本条目（判据与证据用）。 */
export async function readPptxEntry(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  if (file === null) throw new Error(`产物里没有 ${path}`);
  return file.async('string');
}

/**
 * 归一化重打包（ADR 0010 §9）：① `docProps/core.xml` 的时间字段；② 全部 zip 条目日期；
 * ③ 固定压缩参数与条目顺序（按名排序）。
 */
export async function normalizePptx(bytes: Uint8Array, slideXml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file('ppt/slides/slide1.xml', slideXml);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const out = new JSZip();
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    if (entry === undefined || entry.dir) continue;
    // **只准 `uint8array`**：JSZip 的 `nodebuffer` 在浏览器里不可用（本包要同时跑在 Node 与浏览器）。
    let data = await entry.async('uint8array');
    if (name === 'docProps/core.xml') {
      const text = decoder
        .decode(data)
        .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/g, `$1${FIXED_TIMESTAMP_ISO}$2`)
        .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/g, `$1${FIXED_TIMESTAMP_ISO}$2`);
      data = encoder.encode(text);
    }
    out.file(name, data, { date: FIXED_ZIP_DATE, compression: 'DEFLATE', createFolders: false });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' });
}

/**
 * 渲染模板 A（ADR 0010 §1/§5/§9）：容器 → 补丁 → 归一化 → 读回断言。
 *
 * 只允许 `outputType: 'uint8array'`（零 DOM 的硬约束；`Blob` 只出现在 `apps/web`）。
 */
export async function renderTemplateA(input: TemplateAInput): Promise<Uint8Array> {
  const title = input.title ?? input.document.project.name;
  const plan = planTemplateA(input);
  const document = input.document;

  // ---------------------------------------------------------------- 容器（文本走 pptxgenjs）
  const PptxGenJS = await loadPptxGenJS();
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'G7_16_9', width: 10, height: 5.625 });
  pptx.layout = 'G7_16_9';
  pptx.subject = 'GanttPilot 甘特图导出（模板 A）';
  pptx.title = title;
  pptx.author = 'GanttPilot';
  pptx.company = 'GanttPilot';
  const slide = pptx.addSlide();
  for (const line of textLinesOf(plan, document, title)) {
    slide.addText(line.text, {
      x: pxToInch(line.x),
      y: pxToInch(line.y),
      w: pxToInch(line.width),
      h: pxToInch(Math.max(10, line.fontSize * 1.4)),
      fontSize: line.fontSize,
      color: line.color,
      bold: line.bold,
      align: 'left',
      valign: 'top',
      margin: 0,
      objectName: line.objectName,
    });
  }
  const written = await pptx.write({ outputType: 'uint8array' });
  if (!(written instanceof Uint8Array)) throw new Error('pptx.write 未返回 Uint8Array（本包禁止 blob 输出）');

  // ---------------------------------------------------------------- 补丁（几何由我们写）
  const zip = await JSZip.loadAsync(written);
  const slideFile = zip.file('ppt/slides/slide1.xml');
  if (slideFile === null) throw new Error('容器里没有 ppt/slides/slide1.xml');
  const slideXml = await slideFile.async('string');

  const refs = parseShapeRefs(extractSpTree(slideXml));
  buildIdMap(refs); // 容器自身必须自洽（重名/重 id 直接报错）
  const allocator = new IdAllocator(refs);

  // 逐行造形状（按文档序，id 分配因此稳定 ⇒ golden 可复现）
  const shapesOf = new Map<string, RowShapes>();
  for (const row of [...plan.projection.view.rows].sort((left, right) => left.docIndex - right.docIndex)) {
    shapesOf.set(row.id, buildRowShapes({ plan, row, allocator }));
  }

  // 一级组：每个"有可见直接子行"的汇总行一组；包围盒 = 自身条 + 直接子行的形状并集
  const childrenOf = new Map<string, string[]>();
  for (const task of document.tasks) {
    if (task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [task.id]);
    else bucket.push(task.id);
  }
  const groupedXml: string[] = [];
  const groupedRowIds = new Set<string>();
  for (const summary of document.tasks) {
    if (summary.durationDays !== null) continue;
    const members = [summary.id, ...(childrenOf.get(summary.id) ?? [])]
      .map((id) => shapesOf.get(id))
      .filter((entry): entry is RowShapes => entry !== undefined);
    if (members.length < 2) continue; // 只有自己一条不成组
    const fragments = members.flatMap((member) => member.fragments);
    const minX = Math.min(...fragments.map((fragment) => fragment.emu.x));
    const minY = Math.min(...fragments.map((fragment) => fragment.emu.y));
    const maxX = Math.max(...fragments.map((fragment) => fragment.emu.x + fragment.emu.cx));
    const maxY = Math.max(...fragments.map((fragment) => fragment.emu.y + fragment.emu.cy));
    const childXml: GroupChildXml[] = fragments.map((fragment) => ({ id: -1, name: 'child', xml: fragment.xml }));
    groupedXml.push(
      groupSpXml({
        id: allocator.next(),
        name: NAMES.group(summary.id),
        frame: { x: minX, y: minY, cx: Math.max(1, maxX - minX), cy: Math.max(1, maxY - minY) },
        children: childXml,
      }),
    );
    for (const id of [summary.id, ...(childrenOf.get(summary.id) ?? [])]) groupedRowIds.add(id);
  }

  const ungroupedXml = plan.projection.view.rows
    .filter((row) => !groupedRowIds.has(row.id))
    .flatMap((row) => shapesOf.get(row.id)?.fragments.map((fragment) => fragment.xml) ?? []);

  // 依赖线：端点按 P-8 的侧向表取条边；形状 id 取自本次注入结果
  const rowByDocIndex = new Map<number, RowBox>();
  for (const row of plan.projection.view.rows) rowByDocIndex.set(row.docIndex, row);
  const edgeXml: string[] = [];
  for (const edge of plan.projection.view.edges) {
    const fromRow = rowByDocIndex.get(edge.fromDoc);
    const toRow = rowByDocIndex.get(edge.toDoc);
    const fromShapes = fromRow === undefined ? undefined : shapesOf.get(fromRow.id);
    const toShapes = toRow === undefined ? undefined : shapesOf.get(toRow.id);
    if (fromRow === undefined || toRow === undefined || fromShapes === undefined || toShapes === undefined) continue;
    const sides = SIDES[edge.type] ?? SIDES.FS;
    if (sides === undefined) continue;
    const fromPoint = slidePointOf(
      plan,
      sideInnerX(fromRow, sides.exit),
      HEADER_HEIGHT_PX + barCenterInnerY(fromRow),
    );
    const toPoint = slidePointOf(plan, sideInnerX(toRow, sides.enter), HEADER_HEIGHT_PX + barCenterInnerY(toRow));
    const id = allocator.next();
    const color = edge.ignored ? COLOR.edgeIgnored : COLOR.edge;
    // 箭头形态与 SVG 的 `ARROW_FILL` 同口径：FS/FF 实心、SS/SF 空心
    const arrow: 'solid' | 'hollow' = edge.type === 'SS' || edge.type === 'SF' ? 'hollow' : 'solid';
    if (input.degradeConnectors === true) {
      const left = Math.min(fromPoint.x, toPoint.x);
      const top = Math.min(fromPoint.y, toPoint.y);
      edgeXml.push(
        custGeomSpXml({
          id,
          name: NAMES.edge(edge.linkId),
          rect: {
            x: pxToEmu(left),
            y: pxToEmu(top),
            cx: Math.max(1, pxToEmu(Math.abs(toPoint.x - fromPoint.x))),
            cy: Math.max(1, pxToEmu(Math.abs(toPoint.y - fromPoint.y))),
          },
          points: [
            { x: pxToEmu(fromPoint.x), y: pxToEmu(fromPoint.y) },
            { x: pxToEmu(toPoint.x), y: pxToEmu(fromPoint.y) },
            { x: pxToEmu(toPoint.x), y: pxToEmu(toPoint.y) },
          ],
          color,
          arrow,
        }),
      );
      continue;
    }
    edgeXml.push(
      connectorSpXml({
        id,
        name: NAMES.edge(edge.linkId),
        fromId: fromShapes.barId,
        fromIdx: siteForSide(sides.exit),
        toId: toShapes.barId,
        toIdx: siteForSide(sides.enter),
        fromPoint: { x: pxToEmu(fromPoint.x), y: pxToEmu(fromPoint.y) },
        toPoint: { x: pxToEmu(toPoint.x), y: pxToEmu(toPoint.y) },
        color,
        ignored: edge.ignored,
        arrow,
      }),
    );
  }

  // 注入顺序 = 绘制顺序：**背景（灰度带 + 网格线）→ 图例图元 → 组/条 → 依赖线**
  const backgroundXml = backgroundXmlOf({ plan, allocator });
  const legendSwatchXml = legendSwatchXmlOf({ plan, allocator });
  const patched = injectIntoSpTree(
    slideXml,
    [...backgroundXml, ...legendSwatchXml, ...groupedXml, ...ungroupedXml, ...edgeXml].join(''),
  );
  const bytes = await normalizePptx(written, patched);

  // ---------------------------------------------------------------- 读回断言（S1 教训 1）
  const size = await readSlideSize(bytes);
  if (size.cx !== TEMPLATE_A_PAGE.widthEmu || size.cy !== TEMPLATE_A_PAGE.heightEmu) {
    throw new Error(
      `容器 p:sldSz 与声明不一致：实测 ${String(size.cx)}×${String(size.cy)}，` +
        `声明 ${String(TEMPLATE_A_PAGE.widthEmu)}×${String(TEMPLATE_A_PAGE.heightEmu)}`,
    );
  }
  return bytes;
}

/** 供判据使用的边信息（`EdgeGeom` 已是"渲染侧"的形状；这里只补类型别名，不新增语义）。 */
export type TemplateEdge = EdgeGeom;
