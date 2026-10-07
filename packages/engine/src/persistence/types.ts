/**
 * 持久化的**形状与常量**（P3/C4-c 从 \`persistence.ts\` 拆出）：记录版本与数值常量、失败码闭集、
 * 记录形状（\`StoredStep\` / \`StoredSnapshot\` / \`StoredSession\`）、存储接口（\`SnapshotStore\`）
 * 与恢复候选/计划的类型。
 *
 * 本文件**不含任何逻辑**（除 \`failure\` 这个三行的构造助手）：它是记录形状的**唯一定义处**，
 * 因此"域类型"与"策略/适配器实现"可以分别演进而不互相牵动。
 */

import type { DocumentCommand } from '../command.js';
import type { DocumentJournal } from '../journal.js';
import type { ProjectDocument } from '../schema.js';
import type { DocumentSession } from '../session.js';

/** 记录形状版本。与文档的 `CURRENT_DOCUMENT_VERSION` **分开**：两者的演进不是一回事。 */
export const PERSIST_RECORD_VERSION = 1;

// ---------------------------------------------------------------- 数值（ADR 0009 §3 / PERSISTENCE.md §二）

/** 连续编辑只写一次（去抖窗口）。 */
export const AUTOSAVE_DEBOUNCE_MS = 2000;
/** 去抖上限：**"自动保存 ≤5s"的落地方式**——它封顶的是"变更 → 落盘"的最坏延迟。 */
export const AUTOSAVE_MAX_INTERVAL_MS = 5000;
/** 检查点的时间阈值（R-2 建议值）。 */
export const CHECKPOINT_INTERVAL_MS = 300_000;
/** 检查点的步数阈值（R-2 建议值）。 */
export const CHECKPOINT_EVERY_STEPS = 200;
/** 正常态保留的检查点份数（R-2 的"保留 2–3 份"，取上界）。 */
export const CHECKPOINT_KEEP = 3;
/** 配额超限后的保留份数（降级）。 */
export const QUOTA_DEGRADED_KEEP = 1;

// ---------------------------------------------------------------- 失败码（闭集）

/** 持久化失败码（**闭集**；`persistence.spec.ts` 断言它与联合类型逐值一致）。 */
export const PERSIST_FAILURE_CODES = [
  'PERSIST_UNAVAILABLE',
  'PERSIST_QUOTA_EXCEEDED',
  'PERSIST_BLOCKED_BY_OTHER_TAB',
  'PERSIST_RECORD_INVALID',
  'PERSIST_RECORD_VERSION_UNSUPPORTED',
  'PERSIST_WRITE_FAILED',
] as const;

export type PersistFailureCode = (typeof PERSIST_FAILURE_CODES)[number];

export interface PersistFailure {
  readonly ok: false;
  readonly code: PersistFailureCode;
  readonly message: string;
}

/** 结构化结果（与 `WbsResult` / `SessionResult` 同风格：**不抛错**）。 */
export type PersistResult<T> = { readonly ok: true; readonly value: T } | PersistFailure;

export function failure<T>(code: PersistFailureCode, message: string): PersistResult<T> {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------- 记录形状

/** 一步的可落盘形态（`SessionStep` 的 JSON 形态；`journal` 是 before/after 镜像）。 */
export interface StoredStep {
  readonly commands: readonly DocumentCommand[];
  readonly journal: DocumentJournal;
}

/**
 * 检查点快照（含**整份文档**；整份文档只有检查点才会序列化）。
 *
 * `rev` 是**这份快照对应的状态版本**（= 当时的 `DocumentSession.revision`）；
 * `undoDepth` 是**当时可撤销的步数**（= 当时的 `session.undoStack.length`，常规路径下等于 `rev`）。
 *
 * **为什么两个都要**：恢复时"基线之后"的步只能按**位置**切开，而跨会话恢复后的会话其
 * `undoStack` 长度未必等于 `revision`（检查点之前的日志不在记录里，无法逐条合成）。
 * 位置口径用 `undoDepth`，缓存失效口径用 `rev`——两者不混用，`post` 的切分因此永远是精确的。
 *
 * 调用方必须给**当前状态**处的文档：`document` 与 `undoDepth` 是同一时刻的两面。
 */
export interface StoredSnapshot {
  /** 快照自增序号（同一毫秒写多份时用它区分；由存储实现保证唯一）。 */
  readonly id: number;
  readonly docId: string;
  readonly rev: number;
  /** 这份快照处**可撤销的步数**（`post` 的切分位置）。 */
  readonly undoDepth: number;
  readonly createdAtMs: number;
  readonly document: ProjectDocument;
}

/** 检查点的引用（删除时只需要它）。 */
export interface CheckpointRef {
  readonly docId: string;
  readonly id: number;
}

/** 最新状态记录（ADR 0009 §1）。 */
export interface StoredSession {
  readonly recordVersion: number;
  readonly docId: string;
  readonly rev: number;
  /** 当前会话**可撤销的步数**（= 写入时的 `undoStack.length`；`post` 的切分位置由它推出）。 */
  readonly undoDepth: number;
  /** 最近一次检查点；`null` = 还没有检查点（`post` 此时是完整历史）。 */
  readonly base: StoredSnapshot | null;
  /** undo 步（LIFO：**栈顶在末位**），恰是基线之后的那一段。 */
  readonly post: readonly StoredStep[];
  /**
   * redo 栈（LIFO）。**只有 `post` 为空时才可能非空**——任何新命令都会清空 redo 栈，
   * 因此"基线之后有步"与"还有可重做的步"不可能同时成立（恢复侧把这条当**免费不变量**校验）。
   */
  readonly redo: readonly StoredStep[];
  /** 写者标签页 id（多标签防护；ADR 0009 §7）。 */
  readonly writerId: string;
  readonly updatedAtMs: number;
}

/**
 * 构造记录所需的元信息（三个字段都是显式入参——本模块自己不取时钟、不取随机数）。
 *
 * **`rev` 与 `undoDepth` 不在这里**：它们必须与 `session` 一致，从会话里取，
 * 不给调用方写错的机会（写错会让 `post` 的切分静默错位）。
 */
export interface RecordMeta {
  readonly docId: string;
  readonly updatedAtMs: number;
  readonly writerId: string;
}

// ---------------------------------------------------------------- 存储接口

/** 存储适配器（浏览器实现见 `apps/web/src/persistence/idb.ts`；内存实现见本文件末）。 */
export interface SnapshotStore {
  loadLatest(docId: string): Promise<PersistResult<StoredSession | null>>;
  saveLatest(record: StoredSession): Promise<PersistResult<void>>;
  loadCheckpoints(docId: string): Promise<PersistResult<readonly StoredSnapshot[]>>;
  saveCheckpoint(snapshot: StoredSnapshot): Promise<PersistResult<void>>;
  deleteCheckpoints(refs: readonly CheckpointRef[]): Promise<PersistResult<void>>;
}

/** 恢复计划的候选（调用方按"最新状态 + 检查点集合"给出，本模块负责**优先级与守卫**）。 */
export interface RestoreCandidates {
  readonly latest: StoredSession | null;
  readonly snapshots: readonly StoredSnapshot[];
}

/** 恢复结果：`session` 为 `null` 即"没有可恢复的东西"（调用方回落演示文档）。 */
export interface RestorePlan {
  readonly session: DocumentSession | null;
  readonly resolvedFrom: 'latest' | 'checkpoint' | 'none';
  readonly rev: number | null;
  /** 恢复时应用过的增量步数（`0` = 会话就是从基线状态开始的）。 */
  readonly stepsApplied: number;
  /** 被跳过的坏候选（**如实报告**：仓库存量数据的原则是"容忍而不静默"）。 */
  readonly rejected: readonly { readonly source: 'latest' | 'checkpoint'; readonly code: PersistFailureCode; readonly message: string }[];
}

