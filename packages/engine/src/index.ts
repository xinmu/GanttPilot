/**
 * `@ganttpilot/engine` 公共入口。
 *
 * 已落地：
 * - **G1.1 工作日序号化的日历与日期算术**（`date.ts`）；
 * - **G1.2 文档 schema、版本迁移与 WBS 层级**（`schema.ts` / `wbs.ts`）；
 * - **G1.3 命令层与事务**（`journal.ts` / `command.ts` / `session.ts`：
 *   before 镜像日志（唯一变更内核）、命令唯一变更通道、事务与撤销/重做栈）；
 * - **G2 排程内核**（`schedule.ts`）：全量正向传播 `compute()`（含锚点规则、汇总聚合、
 *   检环与截断）、建边预检 `wouldCreateCycle()`、纯结构查询 `affectedClosure()`、容量规划
 *   `createScheduleCalendar()`。形状与语义见 `packages/engine/SCHEDULE.md`、
 *   `docs/02-adr/0004-排程契约.md`（冻结面）与 `docs/02-adr/0005-排程内核落地补齐与结果形状.md`；
 * - **G6 持久化**（`persistence.ts`）：记录形状（`StoredSession` = 检查点基线 + 其后的增量）、
 *   恢复语义（`planRestoreOf` / `restoreSessionOf`）、检查点保留与触发策略（纯状态机）、
 *   存储接口 `SnapshotStore` 与内存适配器。形状见 `docs/02-adr/0009-持久化契约.md`，
 *   数值与验证矩阵见 `packages/engine/PERSISTENCE.md`。
 *
 * 铁律（以可执行检查保证）：本包不得 import 任何框架（Vue/React/…），
 * 也不得访问 DOM 全局。见 `docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md`。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const ENGINE_VERSION = '0.0.0';

/**
 * **本包最新完成**的能力块编号（G1 的合集语义：日历见 G1.1、文档 schema 见 G1.2、
 * 命令层见 G1.3；传播内核见 G2；持久化见 G6）。分解依据见裁决 P-10。
 *
 * 注意语义：它是"最新一个"，不是"唯一一个"——完整清单见 `COMPLETED_GATES`。
 *
 * 名字里的两处都改过（P3/C7-h；改的是**名字在说谎**，不是语义）：
 * - 旧名 `PLANNED_GATE` 的 `PLANNED` 是错的——它的值跟踪的是**最新一个已完成**的能力块（现为 `'G8'`）；
 * - `GATE` **刻意丢掉**：本仓的 GATE 专指**质量门禁**（`pnpm gate` 九步，ADR 0001），
 *   沿用会让人误以为这个常量是门禁的一环。
 */
export const LATEST_COMPLETED_BLOCK = 'G8' as const;

/** 已落地能力块清单（G0 的护栏不在本包内，故不计入；G6 的应用侧接线在 `apps/web`）。 */
export const COMPLETED_GATES = ['G1.1', 'G1.2', 'G1.3', 'G2', 'G6', 'G8'] as const;

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
  DocumentError,
  DocumentVersionError,
  hasDocumentErrors,
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

// ---------------------------------------------------------------- G1.3 before 镜像日志
export {
  applyDocumentJournal,
  cloneJsonValue,
  createBulkJournal,
  deepFreezeJson,
  diffDocument,
  findNonJsonValue,
  invertDocumentJournal,
  isJournalEmpty,
  jsonDeepEqual,
  journalScope,
  type BulkJournal,
  type DeltaJournal,
  type DocumentJournal,
  type EntityChange,
  type JournalScope,
  type LinkChange,
  type OrderChange,
  type ProjectChange,
  type TaskChange,
} from './journal.js';

// ---------------------------------------------------------------- G1.3 命令层（唯一变更通道）
export {
  applyCommand,
  checkCommandShape,
  COMMAND_KINDS,
  parseCommand,
  replayCommands,
  serializeCommand,
  suggestLinkId,
  suggestTaskId,
  type CommandFailure,
  type CommandFailureCode,
  type CommandParseResult,
  type CommandResult,
  type CommandShapeCheck,
  type DocumentCommand,
  type DocumentCommandKind,
  type DocumentReplaceCommand,
  type LinkFieldPatch,
  type LinkInsertCommand,
  type LinkRemoveCommand,
  type LinkUpdateCommand,
  type ProjectMetaPatch,
  type ProjectUpdateCommand,
  type ReplayResult,
  type TaskFieldPatch,
  type TaskIndentCommand,
  type TaskInsertCommand,
  type TaskMoveCommand,
  type TaskOutdentCommand,
  type TaskRemoveCommand,
  type TaskUpdateCommand,
} from './command.js';

// ---------------------------------------------------------------- G1.3 会话与事务（撤销/重做）
export {
  addToTransaction,
  applyToSession,
  commitTransaction,
  createSession,
  createTransaction,
  redoSession,
  restoreSession,
  undoSession,
  type DocumentSession,
  type SessionFailureCode,
  type SessionResult,
  type SessionStacks,
  type SessionStep,
  type Transaction,
} from './session.js';

// ---------------------------------------------------------------- G2 排程内核（正向传播）
export {
  affectedClosure,
  compute,
  createScheduleCalendar,
  LEAF_SENTINEL,
  wouldCreateCycle,
  type Schedule,
  type ScheduleDiagnostic,
  type ScheduleDiagnosticCode,
  type ScheduleFailure,
  type ScheduleResult,
  type ScheduleSuccess,
  type SessionAnchor,
} from './schedule.js';

// ---------------------------------------------------------------- G6 持久化（记录形状 / 恢复 / 策略）
export {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  CHECKPOINT_EVERY_STEPS,
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_KEEP,
  checkJournalShape,
  createMemorySnapshotStore,
  createPolicyState,
  createRetentionPolicy,
  decodeCandidates,
  effectiveKeep,
  PERSIST_FAILURE_CODES,
  PERSIST_RECORD_VERSION,
  planCheckpoint,
  planRestoreOf,
  policyReduce,
  QUOTA_DEGRADED_KEEP,
  restoreFromSnapshot,
  restoreSessionOf,
  sameRecord,
  sessionRecordOf,
  type CheckpointKeepPlan,
  type CheckpointRef,
  type DecodedCandidates,
  type GestureActivity,
  type PersistFailure,
  type PersistFailureCode,
  type PersistResult,
  type PolicyAction,
  type PolicyEvent,
  type PolicyState,
  type PolicyStep,
  type RecordMeta,
  type RestoreCandidates,
  type RestorePlan,
  type RetentionPolicy,
  type SnapshotStore,
  type StoredSession,
  type StoredSnapshot,
  type StoredStep,
} from './persistence/index.js';
