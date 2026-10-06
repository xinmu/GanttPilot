/**
 * `@ganttpilot/pptx-renderer` 公共入口。
 *
 * **模板 A**：单页总览（标题 + 甘特 + 左列任务名 + 图例 + 自动摘要），
 * 管线 = `pptxgenjs 容器` →（JSZip 补丁：条 / 进度 / 菱形 / 一级组 / 吸附 connector）→ 归一化重打包。
 *
 * 本包与 `@ganttpilot/engine`、`@ganttpilot/render-core` 一样受「零 DOM / 零框架依赖」铁律约束：
 * **只允许 `outputType: 'uint8array'`**（`Blob`/`URL` 只出现在 `apps/web`）。
 *
 * 契约出处：[ADR 0010 导出契约](../../../docs/02-adr/0010-导出契约.md)；
 * 包级权威规范见 [`PPTX.md`](../PPTX.md)。
 */

export const PPTX_RENDERER_VERSION = '0.0.0';

/** 本包能力落地的能力块编号。 */
export const PLANNED_GATE = 'G8' as const;

/** 已落地能力块清单（G0 的护栏不在本包内）。 */
export const COMPLETED_GATES = ['G7', 'G8'] as const;

export {
  FIXED_TIMESTAMP_ISO,
  FIXED_ZIP_DATE,
  loadPptxGenJS,
  normalizePptx,
  planTemplateA,
  readPptxEntry,
  readSlideSize,
  renderTemplateA,
  slidePointOf,
  type PptxConstructor,
  type PptxPresentationLike,
  type PptxSlideLike,
  type PptxTextOptions,
  type TemplateAInput,
  type TemplateAPlan,
} from './template.js';

export {
  attr,
  buildIdMap,
  connectorFrame,
  connectorSpXml,
  custGeomSpXml,
  extractSpTree,
  groupSpXml,
  IdAllocator,
  injectIntoSpTree,
  milestoneSpXml,
  NAMES,
  parseShapeRefs,
  plainRectSpXml,
  SITE_COUNT,
  SITES,
  siteForSide,
  barSpXml,
  progressSpXml,
  triangleSpXml,
  type EmuPoint,
  type EmuRect,
  type GroupChildXml,
  type ShapeRef,
} from './ooxml.js';

export {
  COLOR,
  EMU_PER_PT,
  EMU_PER_PX,
  FONT,
  pxToEmu,
  pxToInch,
  pxToPt,
  ptToEmu,
  TEMPLATE_A_MARGIN_PX,
  TEMPLATE_A_PAGE,
  TEMPLATE_A_PAGE_PX,
  TEMPLATE_A_SIDEBAR_GAP_PX,
  TEMPLATE_A_SIDEBAR_PX,
  TEMPLATE_A_TITLE_PX,
} from './units.js';

export {
  bytesEqual,
  crc32Hex,
  diffDigests,
  entryDigests,
  type EntryDiff,
  type EntryDigest,
} from './fingerprint.js';
