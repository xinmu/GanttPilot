/**
 * `@ganttpilot/render-core` 公共入口。
 *
 * 本包是 **G4（纯 SVG 甘特渲染）的几何与裁剪真相源**：纯函数、零 DOM、零框架，
 * 承载"文档 + `Schedule` + `Calendar` + 视口 → 视图模型"的全部计算。
 * `apps/web` 与 G7 的导出投影**共用**它（架构铁律 #2 的载体：双投影共享几何，不截屏）。
 *
 * 契约出处：[ADR 0007 渲染几何与裁剪契约](../../../docs/02-adr/0007-渲染几何与裁剪契约.md)
 * （冻结面：§2 包边界、§3 时间轴与 x 坐标、§4 行模型、§5 路由几何、§6 裁剪四条、
 * §9 验证矩阵、§11 数值回填 + §11.1 三条口径澄清）；
 * 权威说明见本包 [`SPEC.md`](../SPEC.md)。
 *
 * 铁律（以可执行检查保证，见 ADR 0007 §2 与 CONTRIBUTING）：
 * 本包**不得** import 任何框架（Vue/React/…），**不得**访问 DOM 全局，
 * `tsconfig` 不引入 `DOM` lib。`ViewModel` **只出数字与枚举**，不出 SVG 字符串、不出 DOM。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const RENDER_CORE_VERSION = '0.0.0';

/** 本包最新完成的能力块编号（完整清单见 `COMPLETED_GATES`）。 */
export const PLANNED_GATE = 'G7' as const;

/** 已落地能力块清单（G4 的几何与裁剪 + G7 的导出投影与 SVG 序列化）。 */
export const COMPLETED_GATES = ['G4', 'G7'] as const;

// ---------------------------------------------------------------- 常量与判据（ADR 0007 §11）
export {
  ARROW_FILL,
  ARROW_RASTER,
  AXIS_LEFT_GUTTER_DAYS,
  CONNECT_HIT_PAD_PX,
  CONNECT_INSET_PX,
  CONNECT_REVEAL_FACTOR,
  CONNECT_SIZE_PX,
  CONTENT_RIGHT_PAD_PX,
  EDGE_STUB_CANDIDATES,
  EDGE_STUB_PX,
  EDGE_WRAP_CANDIDATES,
  EDGE_WRAP_PX,
  ELEMENT_MODEL,
  evaluateScaleCriteria,
  HANDLE_HEIGHT_PX,
  HANDLE_WIDTH_PX,
  HEADER_HEIGHT_PX,
  HIT_TOLERANCE_PX,
  MIN_MOVE_ZONE_PX,
  LABEL_CHAR_PX,
  LABEL_PADDING_PX,
  MIN_VISIBLE_ROWS,
  ROW_BUFFER,
  ROW_BUFFER_CANDIDATES,
  ROW_HEIGHT,
  ROW_HEIGHT_CANDIDATES,
  SPACING,
  THRESHOLDS,
  VIEWPORT_DEFAULT,
  WHEEL_NOTCH_PX,
  ZOOM_LABEL,
  ZOOM_LABEL_FORMAT,
  ZOOM_ORDER,
  ZOOM_PX_PER_DAY,
  ZOOM_UNIT_DAYS,
  zoomPxPerDay,
  type ZoomKey,
} from './manifest.js';

// ---------------------------------------------------------------- 路由几何（ADR 0007 §5）
export {
  ARROW_METRICS,
  arrowDistinguishability,
  arrowFormsForRelations,
  arrowPolygons,
  arrowVertices,
  jaccardDistance,
  pointInTriangle,
  rasterizeArrow,
  routeEdge,
  routeSides,
  ROUTE_SIDES,
  type Point,
  type RouteGeometry,
  type RouteSide,
} from './route.js';

// ---------------------------------------------------------------- 领域层几何（ADR 0007 §3/§4）
export {
  barXRange,
  DEFAULT_ROW_HEIGHT,
  milestoneCenterX,
  rowIndexOfOrder,
  taskBounds,
  visibleRowOrder,
  type AxisParams,
  type RowKind,
  type TaskBounds,
  type TaskBoundsArgs,
} from './domain.js';

// ---------------------------------------------------------------- 裁剪（ADR 0007 §6 + §11.1）
export {
  axisOriginDayFor,
  buildAxis,
  isRenderedRow,
  rowWindow,
  selectEdges,
  type AxisCalendarLike,
  type AxisElement,
  type ClipMode,
  type EdgeSelection,
  type RowWindow,
} from './clip.js';

// ---------------------------------------------------------------- 视图模型（ADR 0007 §2）
export {
  buildView,
  contentWidthFor,
  dayAtX,
  DEFAULT_VIEWPORT,
  isRowRendered,
  ordinalAtX,
  rowCenterY,
  visibleEdges,
  visibleRows,
  type BuildViewArgs,
  type EdgeGeom,
  type RowBox,
  type ViewModel,
  type Viewport,
} from './viewModel.js';

// ---------------------------------------------------------------- 元素预算（ADR 0007 §6.7 + ADR 0008 §11）
export {
  budgetConstantFor,
  countElements,
  countElementsByEnumeration,
  countOverlays,
  type ElementCounts,
  type OverlayCounts,
} from './count.js';

// ---------------------------------------------------------------- 拖拽手势内核（ADR 0008 §4–§8 + §13）
export {
  barHitFor,
  beginGesture,
  candidateOrdinalFor,
  dayDeltaFor,
  deltaFor,
  dragModeFor,
  dragPreviewFor,
  drawnBarForRow,
  entryConstraintFor,
  idleGesture,
  ordinalAtClamped,
  pointerFromClient,
  reduceGesture,
  resolveDragOutcome,
  resolvePointerTarget,
  snapCandidate,
  type AnchorMode,
  type BeginGestureArgs,
  type ClientPointerArgs,
  type DragMode,
  type DragOutcome,
  type DragPreview,
  type DrawnBar,
  type GestureState,
  type GestureUpdate,
  type HitTarget,
  type LinkPreview,
  type PointerInput,
  type ReduceGestureArgs,
  type ResolvePointerArgs,
} from './gesture.js';

// ---------------------------------------------------------------- 交互态高亮（ADR 0008 §8/§9）
export {
  affectedRenderSetWithAnchors,
  emptyHighlight,
  highlightForConflict,
  highlightForCyclePath,
  highlightForLinkEndpoints,
  highlightForTask,
  type HighlightSet,
} from './highlight.js';

// ---------------------------------------------------------------- 受影响子图（ADR 0007 §8）
export { affectedRenderSet, type AffectedRenderSet } from './affected.js';

// ---------------------------------------------------------------- 判定区与建线类型（ADR 0008 §16／裁决 P-32）
export {
  cursorForZone,
  dragModeOfZones,
  enterXFor,
  exitXFor,
  linkEnterSideFor,
  linkTypeFor,
  translateZone,
  translateZones,
  zoneAt,
  zoneContains,
  zonesFor,
  type CursorHint,
  type DragZone,
  type DragZoneKind,
  type DragZones,
} from './zones.js';

// ---------------------------------------------------------------- 交互几何：手柄与连接点（ADR 0008 §16.2）
export {
  barHeightOf,
  connectDiameterFor,
  connectLeftEdgeFor,
  connectRevealFor,
  connectSideAt,
  cursorForPointer,
  handleOffsetsFor,
  handleXFor,
  linkEntryFor,
  rowConnectVisibleAt,
  rowHandlesFor,
  type ConnectPoint,
  type Handle,
  type LinkEntry,
  type PointerGeometryArgs,
  type RowHandles,
} from './interaction.js';

// ---------------------------------------------------------------- 两栏行对齐（ADR 0007 §14 / 裁决 P-23；覆盖度与迁移见 P-40）
export {
  diagnoseResizeMigration,
  diagnoseRowAlignment,
  diagnoseScrollCoverage,
  summarizeAlignment,
  type AlignMechanism,
  type ResizeMigrationVerdict,
  type RowAlignDelta,
  type RowAlignProbe,
  type RowAlignSample,
  type RowAlignVerdict,
  type ScrollCoverage,
  type ScrollPositionFact,
} from './align.js';

// ---------------------------------------------------------------- 列身份（ADR 0008 §1–§3；唯一真相源）
export {
  COLUMN_SPECS,
  columnIndexOfKey,
  columnKeyOfIndex,
  columnSpecOfHeader,
  DATE_LIKE_COLUMNS,
  EDITABLE_COLUMNS,
  HEADER_ROW,
  SHEET_NAME,
  TABLE_COLUMNS,
  type ColumnKey,
  type ColumnRequirement,
  type ColumnSpec,
  type TableColumn,
} from './columns.js';

// ---------------------------------------------------------------- 日期文本与编辑映射（P-19 迁落点 + P-21 批次 C）
export {
  cellText,
  collapseToCommand,
  dayOfIsoSafe,
  derivedEndIso,
  editToCommand,
  formatProgress,
  isEditStale,
  isoOfDaySafe,
  isoOfOrdinalSafe,
  noticeAfterDispatch,
  parseIntInput,
  parseIsoInput,
  parseProgressInput,
  rawCellText,
  rejectionNotice,
  type CellTextArgs,
  type EditCommand,
  type EditOutcome,
  type EditToCommandArgs,
  type StatusNotice,
} from './viewText.js';

// ---------------------------------------------------------------- 确定性夹具（演示 / 测量 / 测试同源）
export {
  allDatasets,
  buildFixture,
  DATASETS,
  FIXTURE_PROJECT_START_ISO,
  generateDocument,
  hiddenChildren,
  mulberry32,
  PRIMARY_DATASET_KEY,
  REFERENCE_DATASET,
  SCALE_GRADIENT_LINK_RATIO,
  SCALE_GRADIENT_TASKS,
  scaleGradient,
  SCROLL_ROW_OFFSETS,
  type FixtureSpec,
  type FixtureStats,
  type RenderFixture,
} from './fixtures.js';

// ---------------------------------------------------------------- 演示口径（页面默认文档 / 导出演示与 golden）
// 与上面那块的**规模口径**分工（演示要单页可读、规模要 1,000+ 任务）见 `demoPlan.ts` 与裁决 P-34。
export { createDemoPlanDocument } from './demoPlan.js';

// ---------------------------------------------------------------- 导出投影与 SVG 序列化（ADR 0010，G7）
export {
  buildExportView,
  exportAdvisoryFor,
  exportReadabilityOf,
  EXPORT_AXIS_FONT_PX,
  EXPORT_LABEL_FONT_PX,
  EXPORT_LABEL_WIDTH_PX,
  EXPORT_MARGIN_PX,
  EXPORT_MILESTONE_LIST_MAX,
  EXPORT_MIN_FONT_PT,
  EXPORT_PAGE_16_9,
  EXPORT_PNG_MAX_PIXELS,
  EXPORT_READABLE_FONT_PT,
  fitScaleFor,
  pxToPt,
  type BuildExportViewArgs,
  type ExportAdvisory,
  type ExportAdvisoryArgs,
  type ExportReadability,
  type ExportView,
  type FitTransform,
} from './exportView.js';
export {
  exportLegendItems,
  exportSummaryLines,
  exportSummaryOf,
  formatCompletionRatio,
  type ExportLegendItem,
  type ExportMilestone,
  type ExportSummary,
  type ExportSummaryArgs,
  type ExportSummaryLines,
} from './exportSummary.js';
export {
  EXPORT_LABEL_INDENT_PX,
  EXPORT_LABEL_MAX_DEPTH,
  EXPORT_LABEL_PADDING_PX,
  exportLabelStyleOf,
  exportLabelTextOf,
  type ExportLabelStyle,
  type ExportLabelTextArgs,
} from './exportLabels.js';
export {
  EXPORT_SIDEBAR_GAP_PX,
  EXPORT_SIDEBAR_WIDTH_PX,
  svgInnerSizeOf,
  svgString,
  type SvgExportArgs,
  type SvgExportOptions,
  type SvgInnerSize,
} from './svgExport.js';

/**
 * 命令层、文档规范化与排程结果的**门面**（重导出）。
 *
 * 为什么在这里重导出：应用层（`apps/web`）需要"落库 + 校验 + 撤销"的能力与 `Schedule` 类型，
 * 但不该自己从 `@ganttpilot/engine` 拼一条隐式路径——**几何由本包拥有，排程由引擎拥有**，
 * 两者都经本入口暴露，边界才不会分叉。
 */
export {
  applyCommand,
  applyToSession,
  createScheduleCalendar,
  createSession,
  redoSession,
  reindexDocument,
  restoreSession,
  undoSession,
  validateDocument,
} from '@ganttpilot/engine';
export type {
  CommandResult,
  DocumentCommand,
  DocumentDiagnostic,
  DocumentLink,
  DocumentSession,
  ProjectDocument,
  Schedule,
  ScheduleDiagnostic,
  ScheduleResult,
  SessionAnchor,
  SessionResult,
  SessionStep,
  SessionStacks,
} from '@ganttpilot/engine';

/** 任务字段上限（行内编辑用它做范围校验；值与 ADR 0002 的 schema 约束同源）。 */
export { MAX_DURATION_DAYS, MAX_LAG_DAYS } from '@ganttpilot/engine';
