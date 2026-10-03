/**
 * `@ganttpilot/engine` 公共入口。
 *
 * 已落地：
 * - **G1.1 工作日序号化的日历与日期算术**（`date.ts`）；
 * - **G1.2 文档 schema、版本迁移与 WBS 层级**（`schema.ts` / `wbs.ts`：
 *   文档模型 + 规范化序列化 + 结构化校验 + v1→v2→v3 迁移 + 层级不变量与调级）。
 *
 * 命令层在 G1.3、`compute()` 排程内核在 G2 落地，届时本文件的导出面会继续扩张——
 * **此处不承诺最终 API 形状**。
 *
 * 铁律（以可执行检查保证）：本包不得 import 任何框架（Vue/React/…），
 * 也不得访问 DOM 全局。见 `docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md`。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const ENGINE_VERSION = '0.0.0';

/**
 * **本包最新完成**的能力块编号（G1 的合集语义：日历见 G1.1、文档 schema 见 G1.2、
 * 命令层见 G1.3，传播内核见 G2）。分解依据见裁决 P-10。
 *
 * 注意语义：它是"最新一个"，不是"唯一一个"——完整清单见 `COMPLETED_GATES`。
 */
export const PLANNED_GATE = 'G1.2' as const;

/** 已落地能力块清单（G0 的护栏不在本包内，故不计入）。 */
export const COMPLETED_GATES = ['G1.1', 'G1.2'] as const;

// ---------------------------------------------------------------- G1.1 日期与日历
export {
  addDays,
  Calendar,
  countWorkdays,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_PROJECT_BASE_DAY_ISO,
  DEFAULT_WORK_DAYS,
  dayNumberToIso,
  diffDays,
  HORIZON_GUARD_DAYS,
  horizonDaysFor,
  isWorkday,
  isoToDayNumber,
  parseIsoDate,
  weekdayOf,
  type CalendarExceptionsSpec,
  type CalendarLike,
  type CalendarOptions,
  type CalendarSpec,
  type DayNumber,
  type WorkdayCount,
} from './date.js';

// ---------------------------------------------------------------- G1.2 文档模型与迁移
export {
  canonicalizeDocument,
  createEmptyDocument,
  CURRENT_DOCUMENT_VERSION,
  dayNumberToIsoDate,
  DocumentError,
  DocumentVersionError,
  hasDocumentErrors,
  isoDateToDayNumber,
  LINK_TYPES,
  MAX_DURATION_DAYS,
  MAX_LAG_DAYS,
  migrateDocument,
  MIN_SUPPORTED_DOCUMENT_VERSION,
  parseDocument,
  reindexDocument,
  serializeDocument,
  SUPPORTED_DOCUMENT_VERSIONS,
  validateDocument,
  type DocumentBaseline,
  type DocumentDiagnostic,
  type DocumentDiagnosticCode,
  type DocumentDiagnosticSeverity,
  type DocumentLink,
  type DocumentTask,
  type JsonArray,
  type JsonObject,
  type JsonValue,
  type LinkType,
  type ProjectDocument,
  type ProjectMeta,
  type TaskConstraint,
} from './schema.js';

// ---------------------------------------------------------------- G1.2 WBS 层级
export {
  assertOutlineNumber,
  buildTaskTree,
  computeDepths,
  computeOutlineNumbers,
  computeOutlineNumbersByScan,
  flattenTaskTree,
  indentTask,
  isValidOutlineNumber,
  MAX_OUTLINE_DEPTH,
  moveTask,
  outdentTask,
  OUTLINE_SEPARATOR,
  outlineDepth,
  parentOutlineNumber,
  reindexTasks,
  summaryTaskIds,
  type TaskHierarchyInput,
  type TaskTreeNode,
  type WbsFailureCode,
  type WbsMoveTarget,
  type WbsResult,
} from './wbs.js';
