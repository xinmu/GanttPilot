/**
 * `@ganttpilot/xlsx-protocol` 公共入口。
 *
 * 本包是「**字节流 ↔ 文档**」的双向协议（G3 已落地）：把用户手里的 xlsx 解析成 `ProjectDocument`，
 * 把文档写成规范的 xlsx。核心口径：
 *
 * - **只交协议层纯函数**：`detectColumns` / `importXlsx` / `importCsv` / `exportXlsx` / `assembleReport`；
 *   **不交任何 UI**（列映射向导、拖拽导入、文件对话框都在 `apps/web`），**不接触 DOM**；
 * - 契约已在开工前冻结（裁决 P-14）：列契约、单元格容差、公式口径、成环边丢弃顺序、
 *   导出物白名单与协议层诊断码表见 `docs/02-adr/0006-xlsx-协议契约.md`；
 *   落地期的四条口径补齐见 `docs/00-baseline/裁决记录.md` 第十五轮（P-15）；
 *   权威规范见本包 `PROTOCOL.md`（与 `engine/SCHEDULE.md` 同构）；
 * - **四个入口都是 `async`**：ADR 0006 §11 要求浏览器侧**动态 `import('exceljs')`**，
 *   使 925.5 KB min / 251.6 KB gzip 不进入首屏主 chunk（代价是一次不可避免的 Promise）。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const XLSX_PROTOCOL_VERSION = '0.0.0';

/** 本包最新完成的能力块编号（与 engine 同语义：它是"最新一个"，完整清单见 `COMPLETED_GATES`）。 */
export const PLANNED_GATE = 'G8' as const;

/** 已落地能力块清单。 */
export const COMPLETED_GATES = ['G3', 'G8'] as const;

// ---------------------------------------------------------------- 公共 API
export { detectColumns, importCsv, importXlsx, type ImportResult } from './import.js';
export { exportXlsx, formatDependencyText, NUM_FMT_DATE, NUM_FMT_PROGRESS, type ExportOptions, type ExportResult } from './export.js';
// 模板文件（多页签 xlsx；P-46／ADR 0006 附录 §1）：**运行时生成**，仓库内不放二进制。
export {
  buildTemplateXlsx,
  TEMPLATE_GUIDE_LINES,
  TEMPLATE_SHEET_GUIDE,
  TEMPLATE_SHEET_ORDER,
  TEMPLATE_SHEET_SAMPLE,
  TEMPLATE_SHEET_TASK,
  type TemplateResult,
} from './template.js';

// ---------------------------------------------------------------- 列契约
export {
  COLUMN_SPECS,
  DATE_LIKE_COLUMNS,
  HEADER_ROW,
  SHEET_NAME,
  columnIndexOfKey,
  columnKeyOfIndex,
  columnSpecOfHeader,
  type ColumnKey,
  type ColumnRequirement,
  type ColumnSpec,
} from './columns.js';

// ---------------------------------------------------------------- 诊断
export {
  assembleReport,
  columnLetter,
  DiagnosticBag,
  XLSX_DIAGNOSTIC_CODES,
  XLSX_DIAGNOSTIC_SEVERITY,
  type ReportDiagnostic,
  type XlsxDiagnostic,
  type XlsxDiagnosticCode,
  type XlsxDiagnosticSeverity,
  type XlsxLocator,
} from './diagnostics.js';

// ---------------------------------------------------------------- 列探测 / 导入选项
export type { ColumnDetection, ColumnDetectionResult, ColumnBinding } from './header.js';
export type { ColumnMapping, ColumnTarget, ImportOptions, RowParseResult } from './buildDocument.js';

// ---------------------------------------------------------------- 日期与容差（供 G4/G7 复用，避免第二套算术）
export {
  MAX_DATE_SERIAL,
  MIN_DATE_SERIAL,
  isoFromDate,
  isoFromSerial,
  parseDateText,
  utcMidnight,
  utcMidnightFromIso,
} from './dates.js';
