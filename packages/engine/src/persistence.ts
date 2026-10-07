/**
 * 持久化：**记录形状 + 触发策略 + 存储接口**（G6 的引擎侧）。
 *
 * ## 契约出处
 *
 * 形状与语义冻结在 [`docs/02-adr/0009-持久化契约.md`](../../../docs/02-adr/0009-持久化契约.md)；
 * 数值、公共 API 与验证矩阵见 [`../PERSISTENCE.md`](../PERSISTENCE.md)。
 *
 * ## 本模块的边界（三条，全是可执行的）
 *
 * 1. **纯函数与纯状态机**：本文件不出现 `indexedDB` / `window` / `document` / 定时器 /
 *    `Date.now()` / `Math.random()`——时间（`atMs`）、手势活动态（`active`）与写者身份
 *    （`writerId`）一律是**显式入参**。理由是这一层是"正确性关键模块"，必须能进 `pnpm gate`：
 *    "每 5 分钟 / 每 200 步 / 关闭时"这些触发条件因此可以用**假时钟**逐条断言。
 * 2. **不重写任何既有规则**：文档合法性用 `validateDocument`、命令形状用 `checkCommandShape`、
 *    日志一致性与应用用 `applyDocumentJournal`——同 ADR 0002 §8 / ADR 0003 §4 的手法
 *    （"命令产出的文档"与"合法文档"不可能分叉；本模块同样不制造第二条校验实现）。
 * 3. **失败是结构化码，不是异常**：配额溢出、IndexedDB 不可用、多标签冲突都是**用户级事件**，
 *    要提示而不是中断编辑（同 `WbsResult` / `SessionResult` 的取舍）。
 *
 * ## 为什么落盘的是「基线快照 + 其后的增量」（ADR 0009 §1）
 *
 * R-2 的瓶颈**不是容量而是写入延迟与主线程占用**：2,000 任务的一份快照 300–600 KB，
 * "每 ≤5s 序列化一次"在拖拽时是可见的掉帧；而单条命令 delta 只有 0.1–2 KB。
 * 因此自动保存写的是 `{ base, post, redo }`——**写入量只与"距上次检查点的变更量"同阶**，
 * 而不是与文档规模同阶。
 *
 * ## 为什么恢复不"从基线重放命令"
 *
 * `post` 里每一步都带 `journal`（before/after 镜像，G1.3 的产物）：正向
 * `applyDocumentJournal` 就是那一步的结果。因此恢复**不需要命令可重放**，
 * 也不需要跑 `applyCommand` 的 O(N) 校验链——语义精确、失败面更小。
 */

import {
  applyDocumentJournal,
  cloneJsonValue,
  findNonJsonValue,
  invertDocumentJournal,
  jsonDeepEqual,
  type DocumentJournal,
} from './journal.js';
import { checkCommandShape, type DocumentCommand } from './command.js';
import {
  CURRENT_DOCUMENT_VERSION,
  reindexDocument,
  validateDocument,
  type ProjectDocument,
} from './schema.js';
import { isRecord } from './wbs.js';
import {
  restoreSession,
  type DocumentSession,
  type SessionStep,
} from './session.js';

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

function failure<T>(code: PersistFailureCode, message: string): PersistResult<T> {
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

// ---------------------------------------------------------------- 构造（纯）

/**
 * 由会话与"当前基线快照"算出**要写的那条记录**。
 *
 * `post` = `session.undoStack` 里**基线之后**的那些步：
 *
 * - 基线**为 `null`**（还没有检查点）时 `post` 是整个栈；
 * - 基线存在时按"位置"切：`base.undoDepth` 是**基线处可撤销的步数**，`post = undoStack.slice(undoDepth)`。
 *   用 `undoDepth` 而不是 `base.rev`：跨会话恢复后的会话里，检查点之前的历史被折叠成基线本身，
 *   此时 `undoStack.length` 可以小于 `rev`（见 `StoredSnapshot` 的说明）。
 *   切分前先夹到 `[0, undoStack.length]`——那是一条**静默数据丢失**的防线。
 *
 * 入参一律只读：本函数不修改会话，写出的记录是**新鲜克隆**（落盘侧不会持有调用方的引用，
 * 也不会被调用方后续的改动影响）。
 */
export function sessionRecordOf(
  session: DocumentSession,
  base: StoredSnapshot | null,
  meta: RecordMeta,
): StoredSession {
  const undoDepth = session.undoStack.length;
  const from = base === null ? 0 : Math.min(Math.max(0, Math.trunc(base.undoDepth)), undoDepth);
  const post = session.undoStack.slice(from);
  return {
    recordVersion: PERSIST_RECORD_VERSION,
    docId: meta.docId,
    rev: session.revision,
    undoDepth,
    base: base === null ? null : cloneJsonValue(base),
    post: post.map(cloneStep),
    redo: session.redoStack.map(cloneStep),
    writerId: meta.writerId,
    updatedAtMs: meta.updatedAtMs,
  };
}

function cloneStep(step: SessionStep): StoredStep {
  return { commands: cloneJsonValue(step.commands), journal: cloneJsonValue(step.journal) };
}

// ---------------------------------------------------------------- 恢复（带三道守卫）

/**
 * 由记录还原会话（**唯一的恢复入口**）。
 *
 * 守卫顺序（任一失败即 `PERSIST_RECORD_INVALID` / `PERSIST_RECORD_VERSION_UNSUPPORTED`）：
 * 记录版本 → 文档（`validateDocument`，复用 G1.2）→ 命令形状（`checkCommandShape`，复用 G1.3）
 * → `post`/`redo` 的免费不变量 → 逐步 `applyDocumentJournal`（它的 before 守卫**就是**
 * "日志与文档自相矛盾"的检测器）。
 *
 * `post` 非空时 `redo` 必须为空：任何成功的命令都会清空 redo 栈，因此"基线之后有步、却还留着
 * 可重做的步"在语义上不可能——这条不变量**免费**地把一类坏记录挡在门外。
 */
export function restoreSessionOf(record: StoredSession): PersistResult<DocumentSession> {
  if (record.recordVersion !== PERSIST_RECORD_VERSION) {
    return failure(
      'PERSIST_RECORD_VERSION_UNSUPPORTED',
      `不支持的记录版本 ${String(record.recordVersion)}（本版本只认识 ${String(PERSIST_RECORD_VERSION)}）`,
    );
  }
  if (!Number.isInteger(record.rev) || record.rev < 0) {
    return failure('PERSIST_RECORD_INVALID', `\`rev\` 必须是非负整数，收到 ${JSON.stringify(record.rev)}`);
  }
  if (!Number.isInteger(record.undoDepth) || record.undoDepth < 0) {
    return failure(
      'PERSIST_RECORD_INVALID',
      `\`undoDepth\` 必须是非负整数，收到 ${JSON.stringify(record.undoDepth)}`,
    );
  }
  const problem = findNonJsonValue(record);
  if (problem !== null) {
    return failure('PERSIST_RECORD_INVALID', `记录含非 JSON 值：${problem}`);
  }
  if (record.post.length > 0 && record.redo.length > 0) {
    return failure(
      'PERSIST_RECORD_INVALID',
      `\`post\` 非空时 \`redo\` 必须为空（基线之后还有步 ⇒ redo 栈早该被清空），实得 ${String(record.redo.length)} 步`,
    );
  }
  if (record.base !== null && !Number.isInteger(record.base.undoDepth)) {
    return failure(
      'PERSIST_RECORD_INVALID',
      `检查点的 \`undoDepth\` 必须是整数，收到 ${JSON.stringify(record.base.undoDepth)}`,
    );
  }
  if (record.base !== null && record.base.undoDepth + record.post.length !== record.undoDepth) {
    return failure(
      'PERSIST_RECORD_INVALID',
      `撤销深度与增量步数不自洽：基线 ${String(record.base.undoDepth)} + 增量 ${String(record.post.length)} ≠ \`undoDepth\` ${String(record.undoDepth)}`,
    );
  }

  let document = record.base === null ? null : record.base.document;
  if (document === null) {
    return failure(
      'PERSIST_RECORD_INVALID',
      '记录没有检查点基线：本版本要求 `base` 非空（检查点在首次写入前必须已建立）',
    );
  }
  const documentProblem = checkRestorableDocument(document);
  if (documentProblem !== null) {
    return failure('PERSIST_RECORD_INVALID', documentProblem);
  }
  // `reindexDocument` 是**幂等**的（`outlineNumber` 是层级的像，ADR 0002 §6）：
  // 它把"存值与层级不符"这一种坏记录修好，而不是拒绝整份数据。
  document = reindexDocument(cloneJsonValue(document));

  const post: SessionStep[] = [];
  for (const [index, step] of record.post.entries()) {
    const checked = checkStep(step, `post[${String(index)}]`);
    if (!checked.ok) {
      return checked;
    }
    try {
      document = applyDocumentJournal(document, checked.value.journal);
    } catch (error) {
      return failure(
        'PERSIST_RECORD_INVALID',
        `post[${String(index)}] 的日志与文档自相矛盾：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    post.push(checked.value);
  }

  const resultProblems = validateDocument(document).filter((item) => item.severity === 'error');
  if (resultProblems.length > 0) {
    const first = resultProblems[0];
    return failure(
      'PERSIST_RECORD_INVALID',
      `恢复后的文档未通过 schema 校验：${first?.code ?? '未知'} ${first?.message ?? ''}`.trim(),
    );
  }

  /**
   * 恢复出的撤销栈 = `post` 的日志按 LIFO 挂好。
   *
   * 注意"**撤销深度不因检查点而缩水**"这句话的准确形态：基线**之前**那些步的日志不在记录里
   * （它们由基线快照本身承载），因此恢复出的 `undoStack.length` 只等于 `post.length`，
   * 而 `revision` 取记录里的值——**不再拿 `base.rev + post.length` 去合成**，
   * 因为"基线之前的步"无法凭空造出来。撤销到底之后会话给出的就是基线文档，
   * 即"文档最初的状态"对用户而言完全等价（它本来就是同一份文档）。
   */
  const undo: SessionStep[] = [];
  let current = document;
  for (let index = post.length - 1; index >= 0; index -= 1) {
    const step = post[index];
    if (step === undefined) {
      return failure('PERSIST_RECORD_INVALID', `post[${String(index)}] 缺失`);
    }
    try {
      current = applyDocumentJournal(current, invertDocumentJournal(step.journal));
    } catch (error) {
      return failure(
        'PERSIST_RECORD_INVALID',
        `post[${String(index)}] 的逆日志与文档自相矛盾：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    undo.unshift(step);
  }

  const redo: SessionStep[] = [];
  for (const [index, step] of record.redo.entries()) {
    const checked = checkStep(step, `redo[${String(index)}]`);
    if (!checked.ok) {
      return checked;
    }
    redo.push(checked.value);
  }

  return {
    ok: true,
    value: restoreSession(document, record.rev, { undo, redo }),
  };
}

/** 检查点快照 → 建议会（`post`/`redo` 为空；`resolvedFrom` 由 `planRestoreOf` 给出）。 */
export function restoreFromSnapshot(snapshot: StoredSnapshot): PersistResult<DocumentSession> {
  return restoreSessionOf({
    recordVersion: PERSIST_RECORD_VERSION,
    docId: snapshot.docId,
    rev: snapshot.rev,
    undoDepth: snapshot.undoDepth,
    base: snapshot,
    post: [],
    redo: [],
    writerId: '',
    updatedAtMs: snapshot.createdAtMs,
  });
}

/**
 * 恢复优先级：**最新状态 → 检查点（`createdAtMs` 新到旧）→ 无**。
 *
 * 一个候选坏掉**只跳过它**（并把原因如实报告），后面的候选照旧生效——
 * 这是"容忍而不静默"：一份被写坏的 L3 不该让用户连检查点也丢掉。
 */
export function planRestoreOf(candidates: RestoreCandidates, docId: string): RestorePlan {
  const rejected: { source: 'latest' | 'checkpoint'; code: PersistFailureCode; message: string }[] = [];

  const latest = candidates.latest;
  if (latest !== null) {
    if (latest.docId !== docId) {
      rejected.push({
        source: 'latest',
        code: 'PERSIST_RECORD_INVALID',
        message: `记录的 \`docId\` 是 ${JSON.stringify(latest.docId)}，期望 ${JSON.stringify(docId)}`,
      });
    } else {
      const restored = restoreSessionOf(latest);
      if (restored.ok) {
        return {
          session: restored.value,
          resolvedFrom: 'latest',
          rev: latest.rev,
          stepsApplied: latest.post.length,
          rejected,
        };
      }
      rejected.push({ source: 'latest', code: restored.code, message: restored.message });
    }
  }

  const ordered = [...candidates.snapshots].sort((left, right) =>
    left.createdAtMs === right.createdAtMs ? 0 : right.createdAtMs - left.createdAtMs,
  );
  for (const snapshot of ordered) {
    if (snapshot.docId !== docId) {
      rejected.push({
        source: 'checkpoint',
        code: 'PERSIST_RECORD_INVALID',
        message: `检查点的 \`docId\` 是 ${JSON.stringify(snapshot.docId)}，期望 ${JSON.stringify(docId)}`,
      });
      continue;
    }
    const restored = restoreFromSnapshot(snapshot);
    if (restored.ok) {
      return {
        session: restored.value,
        resolvedFrom: 'checkpoint',
        rev: snapshot.rev,
        stepsApplied: 0,
        rejected,
      };
    }
    rejected.push({ source: 'checkpoint', code: restored.code, message: restored.message });
  }

  return { session: null, resolvedFrom: 'none', rev: null, stepsApplied: 0, rejected };
}

/** 文档能否作为恢复起点（复用 `validateDocument`，不重写任何文档规则）。 */
function checkRestorableDocument(document: unknown): string | null {
  if (typeof document !== 'object' || document === null) {
    return '检查点里的 `document` 不是对象';
  }
  const version = (document as { version?: unknown }).version;
  if (version !== CURRENT_DOCUMENT_VERSION) {
    return `检查点里的文档版本是 ${JSON.stringify(version)}，本版本只认识 ${String(CURRENT_DOCUMENT_VERSION)}`;
  }
  const problems = validateDocument(document).filter((item) => item.severity === 'error');
  if (problems.length > 0) {
    const first = problems[0];
    return `检查点里的文档未通过 schema 校验：${first?.code ?? '未知'} ${first?.message ?? ''}`.trim();
  }
  return null;
}

/** 一步的形状守卫（命令形状复用 `checkCommandShape`；日志形状由 `applyDocumentJournal` 兜底）。 */
function checkStep(step: unknown, label: string): PersistResult<SessionStep> {
  if (!isRecord(step)) {
    return failure('PERSIST_RECORD_INVALID', `${label} 不是对象`);
  }
  const commands = step['commands'];
  if (!Array.isArray(commands)) {
    return failure('PERSIST_RECORD_INVALID', `${label}.commands 必须是数组`);
  }
  const journalProblem = checkJournalShape(step['journal']);
  if (journalProblem !== null) {
    return failure('PERSIST_RECORD_INVALID', `${label}: ${journalProblem}`);
  }
  const normalized: DocumentCommand[] = [];
  for (const [index, command] of commands.entries()) {
    const shape = checkCommandShape(command);
    if (!shape.ok) {
      return failure(
        'PERSIST_RECORD_INVALID',
        `${label}.commands[${String(index)}] 形状非法：${shape.code} ${shape.message}`,
      );
    }
    normalized.push(shape.command);
  }
  return { ok: true, value: { commands: normalized, journal: step['journal'] as DocumentJournal } };
}

/**
 * 日志的**顶层**形状守卫。
 *
 * 不做逐字段深校验：`applyDocumentJournal` 的 before 守卫**就是**权威检测器
 * （"日志与文档自相矛盾"会得到 `RangeError` 并被本模块转成 `PERSIST_RECORD_INVALID`）。
 * 这里只挡住"连判别标签都不对"的输入，让错误信息能指出是哪一步。
 */
export function checkJournalShape(journal: unknown): string | null {
  if (!isRecord(journal)) {
    return 'journal 不是对象';
  }
  const kind = journal['kind'];
  if (kind === 'delta') {
    if (!Array.isArray(journal['tasks']) || !Array.isArray(journal['links'])) {
      return 'delta 日志的 `tasks` / `links` 必须是数组';
    }
    return null;
  }
  if (kind === 'document') {
    if (journal['before'] === undefined || journal['after'] === undefined) {
      return 'document 日志必须同时有 `before` 与 `after`';
    }
    return null;
  }
  return `未知的日志形态：${JSON.stringify(kind)}`;
}

/**
 * 两条记录是否"讲的是同一件事"（供"该不该写"的去重判定与 spec 互证使用）。
 *
 * **键序无关**：记录在落盘前会经 `JSON.stringify`/`JSON.parse`（一次往返），
 * 那一步不改变语义，因此"我构造的记录"与"我读回来的记录"必须深比较相等。
 */
export function sameRecord(left: StoredSession, right: StoredSession): boolean {
  return jsonDeepEqual(left, right);
}

// ---------------------------------------------------------------- 恢复候选的构造

/**
 * 把一批记录整理成 `planRestoreOf` 的候选。
 *
 * 存在的理由：**坏的检查点不必让整个候选集报废**——`decodeRecord`/`decodeSnapshot`
 * 把"连 JSON 形状都不对"的输入变成 `null`（并计入 `invalid`），剩下的照旧参与恢复。
 */
export interface DecodedCandidates {
  readonly candidates: RestoreCandidates;
  readonly invalid: number;
}

export function decodeCandidates(raw: {
  readonly latest: unknown;
  readonly snapshots: readonly unknown[];
}): DecodedCandidates {
  const snapshots: StoredSnapshot[] = [];
  let invalid = 0;
  for (const item of raw.snapshots) {
    const decoded = decodeSnapshot(item);
    if (decoded === null) {
      invalid += 1;
      continue;
    }
    snapshots.push(decoded);
  }
  const latest = raw.latest === null ? null : decodeRecord(raw.latest);
  if (raw.latest !== null && latest === null) {
    invalid += 1;
  }
  return { candidates: { latest, snapshots }, invalid };
}

function decodeSnapshot(value: unknown): StoredSnapshot | null {
  if (!isRecord(value)) return null;
  const { id, docId, rev, undoDepth, createdAtMs, document } = value;
  if (typeof id !== 'number' || typeof docId !== 'string' || typeof rev !== 'number') {
    return null;
  }
  if (typeof undoDepth !== 'number') return null;
  if (typeof createdAtMs !== 'number' || !isRecord(document)) return null;
  return {
    id,
    docId,
    rev,
    undoDepth,
    createdAtMs,
    document: document as unknown as ProjectDocument,
  };
}

function decodeRecord(value: unknown): StoredSession | null {
  if (!isRecord(value)) return null;
  const { recordVersion, docId, rev, undoDepth, base, post, redo, writerId, updatedAtMs } = value;
  if (typeof recordVersion !== 'number' || typeof docId !== 'string' || typeof rev !== 'number') {
    return null;
  }
  if (typeof undoDepth !== 'number') return null;
  if (!Array.isArray(post) || !Array.isArray(redo)) return null;
  if (typeof writerId !== 'string' || typeof updatedAtMs !== 'number') return null;
  const decodedBase = base === null || base === undefined ? null : decodeSnapshot(base);
  if (base !== null && base !== undefined && decodedBase === null) return null;
  const steps: StoredStep[] = [];
  for (const item of post) {
    if (!isRecord(item)) return null;
    steps.push({ commands: item['commands'] as DocumentCommand[], journal: item['journal'] as DocumentJournal });
  }
  const redoSteps: StoredStep[] = [];
  for (const item of redo) {
    if (!isRecord(item)) return null;
    redoSteps.push({
      commands: item['commands'] as DocumentCommand[],
      journal: item['journal'] as DocumentJournal,
    });
  }
  return {
    recordVersion,
    docId,
    rev,
    undoDepth,
    base: decodedBase,
    post: steps,
    redo: redoSteps,
    writerId,
    updatedAtMs,
  };
}

// ---------------------------------------------------------------- 检查点保留策略

/** 保留计划：`keep` 留下、`remove` 从存储里删掉。 */
export interface CheckpointKeepPlan {
  readonly keep: readonly CheckpointRef[];
  readonly remove: readonly CheckpointRef[];
}

/**
 * 保留计划（**确定性**：与时钟、插入顺序无关——只按 `createdAtMs` 排序后取最新 `keep` 份）。
 *
 * `keep <= 0` 视为"不留"（`keep: []`、其余全删）——配额降级的极端情形由调用方给
 * `QUOTA_DEGRADED_KEEP`（= 1），不会走到这里，但语义要有定义。
 */
export function planCheckpoint(
  existing: readonly StoredSnapshot[],
  keep: number,
  incoming: StoredSnapshot | null = null,
): CheckpointKeepPlan {
  const all = [...existing, ...(incoming === null ? [] : [incoming])];
  const unique = new Map<string, StoredSnapshot>();
  for (const snapshot of all) {
    unique.set(`${snapshot.docId}#${String(snapshot.id)}`, snapshot);
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.createdAtMs === right.createdAtMs
      ? right.id - left.id
      : right.createdAtMs - left.createdAtMs,
  );
  const limit = Math.max(0, Math.trunc(keep));
  const ref = (snapshot: StoredSnapshot): CheckpointRef => ({ docId: snapshot.docId, id: snapshot.id });
  return { keep: ordered.slice(0, limit).map(ref), remove: ordered.slice(limit).map(ref) };
}

// ---------------------------------------------------------------- 触发状态机

/** 手势活动态（**显式入参**：策略自己不去问手势，因此"拖动期不写盘"是可断言的）。 */
export type GestureActivity = 'idle' | 'dragging' | 'linking';

export interface RetentionPolicy {
  /** 去抖窗口（连续编辑只写一次）。 */
  readonly debounceMs: number;
  /** 去抖上限（"变更 → 落盘"的最坏延迟）。 */
  readonly maxIntervalMs: number;
  /** 检查点的时间阈值。 */
  readonly checkpointIntervalMs: number;
  /** 检查点的步数阈值。 */
  readonly checkpointEverySteps: number;
  /** 正常态保留份数。 */
  readonly keep: number;
  /** 降级后保留份数。 */
  readonly degradedKeep: number;
}

export interface PolicyState {
  /** 是否已有未落盘的变更。 */
  readonly dirty: boolean;
  /** 首次变脏的时刻（`null` = 不脏）。 */
  readonly dirtySinceMs: number | null;
  /** 最近一次落盘的时刻。 */
  readonly lastFlushMs: number | null;
  /** 最近一次检查点的时刻（`null` = 还没有检查点）。 */
  readonly lastCheckpointMs: number | null;
  /** 最近一次检查点时的 `rev`（`null` = 还没有检查点）。 */
  readonly lastCheckpointRev: number | null;
  /** 当前 `rev`。 */
  readonly rev: number;
  /** 当前手势活动态。 */
  readonly active: GestureActivity;
  /** 是否已降级（配额超限后为真，此后只保留 `degradedKeep` 份）。 */
  readonly degraded: boolean;
}

export type PolicyEvent =
  | { readonly kind: 'change'; readonly rev: number; readonly atMs: number }
  | { readonly kind: 'activity'; readonly active: GestureActivity }
  | { readonly kind: 'tick'; readonly atMs: number }
  | { readonly kind: 'flushed'; readonly atMs: number }
  | { readonly kind: 'checkpointed'; readonly atMs: number; readonly rev: number }
  | { readonly kind: 'quotaExceeded' };

export type PolicyAction = 'none' | 'flush' | 'checkpoint' | 'degrade';

export interface PolicyStep {
  readonly state: PolicyState;
  readonly action: PolicyAction;
}

/** 建策略（数值来自本文件顶部的常量；测试用 `overrides` 打小时间尺）。 */
export function createRetentionPolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    debounceMs: AUTOSAVE_DEBOUNCE_MS,
    maxIntervalMs: AUTOSAVE_MAX_INTERVAL_MS,
    checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
    checkpointEverySteps: CHECKPOINT_EVERY_STEPS,
    keep: CHECKPOINT_KEEP,
    degradedKeep: QUOTA_DEGRADED_KEEP,
    ...overrides,
  };
}

export function createPolicyState(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    dirty: false,
    dirtySinceMs: null,
    lastFlushMs: null,
    lastCheckpointMs: null,
    lastCheckpointRev: null,
    rev: 0,
    active: 'idle',
    degraded: false,
    ...overrides,
  };
}

/** 当前生效的保留份数。 */
export function effectiveKeep(policy: RetentionPolicy, state: PolicyState): number {
  return state.degraded ? policy.degradedKeep : policy.keep;
}

/**
 * 触发状态机（**纯函数**：同一个 `(state, event)` 永远给同一个 `(state', action)`）。
 *
 * 三条口径（ADR 0009 §2/§3）：
 * 1. **手势活动期不产出 `flush`**——因此"自动保存不吃拖拽帧预算"不依赖运气；
 * 2. `tick` 是**唯一**的时间驱动事件（调用方按自己的节奏喂），去抖与"最大间隔"都在这里判；
 * 3. 检查点是 `flush` 的**附加**动作（先落最新状态，再决定是否需要新检查点）——
 *    顺序不能反，否则"基线变了、post 还没清"的窗口就会把最新状态写丢。
 */
export function policyReduce(
  policy: RetentionPolicy,
  state: PolicyState,
  event: PolicyEvent,
): PolicyStep {
  switch (event.kind) {
    case 'change':
      return {
        state: {
          ...state,
          rev: event.rev,
          dirty: true,
          // 首次变脏的时刻**只在变脏那一刻**记：连续编辑不得把去抖窗口往后推（否则
          // "最大间隔"就白设了——那正是 R-2 要避免的"整会话不写"）。
          dirtySinceMs: state.dirty ? state.dirtySinceMs : event.atMs,
        },
        action: 'none',
      };
    case 'activity':
      return { state: { ...state, active: event.active }, action: 'none' };
    case 'quotaExceeded':
      return { state: { ...state, degraded: true }, action: 'degrade' };
    case 'flushed':
      return {
        state: { ...state, dirty: false, dirtySinceMs: null, lastFlushMs: event.atMs },
        action: 'none',
      };
    case 'checkpointed':
      return {
        state: { ...state, lastCheckpointMs: event.atMs, lastCheckpointRev: event.rev },
        action: 'none',
      };
    case 'tick':
      return tickReduce(policy, state, event.atMs);
  }
}

function tickReduce(policy: RetentionPolicy, state: PolicyState, atMs: number): PolicyStep {
  if (state.active !== 'idle') {
    // 手势活动期**不落盘**；但 `rev`/`dirty` 照常记账（`idle` 之后的 `tick` 会立刻补写）。
    return { state, action: 'none' };
  }
  if (!state.dirty) {
    return { state, action: 'none' };
  }
  // 首次变脏的时刻缺失时按"现在就够久"处理：宁可早写，也不要把变更无限期扣在内存里。
  const since = state.dirtySinceMs ?? atMs;
  const dueByDebounce = atMs - since >= policy.debounceMs;
  const dueByMax = atMs - since >= policy.maxIntervalMs;
  if (!dueByDebounce && !dueByMax) {
    return { state, action: 'none' };
  }
  const stepsSince = state.lastCheckpointRev === null ? Number.POSITIVE_INFINITY : state.rev - state.lastCheckpointRev;
  // **没有基线就一定要建基线**：记录形状要求 `base` 非空（"检查点基线 + 其后的增量"），
  // 因此第一次真正落盘必须是 `checkpoint` —— 否则写出来的记录是结构不全的。
  const noBase = state.lastCheckpointMs === null;
  const dueByTime = !noBase && atMs - (state.lastCheckpointMs ?? 0) >= policy.checkpointIntervalMs;
  const dueBySteps = stepsSince >= policy.checkpointEverySteps;
  return {
    // 状态推进交给 `flushed`/`checkpointed` 事件（调用方在写盘成功后喂回来）——
    // 这样"写了才算数"是事实，而不是乐观假设。
    state,
    action: noBase || dueByTime || dueBySteps ? 'checkpoint' : 'flush',
  };
}

// ---------------------------------------------------------------- 内存适配器

/**
 * 内存适配器（**测试与浏览器降级共用同一实现**）。
 *
 * 两条纪律：
 * - 写入**深拷贝后冻结**：读出来的记录与写进去的对象零共享引用（否则测试里
 *   "改一下再读"会假绿）；
 * - **多标签防护只在这一条降级路径上成立**：已有记录的 `writerId` 与本次不同、且**更新**
 *   （`existing.updatedAtMs > record.updatedAtMs`）时拒绝本次写入。**IndexedDB 路径暂不做
 *   互斥写保护**（`apps/web` 的 `saveLatest` 是裸 `put`，`PERSIST_BLOCKED_BY_OTHER_TAB`
 *   在正常浏览器路径不可达）——这是**已登记**的差异，归 v0.5 实现，见 `PERSISTENCE.md`
 *   的「多标签与已知限制」一节。
 */
export function createMemorySnapshotStore(): SnapshotStore {
  const latest = new Map<string, StoredSession>();
  const checkpoints = new Map<string, StoredSnapshot[]>();
  let nextId = 1;

  const writerConflict = (record: StoredSession, existing: StoredSession | undefined): boolean =>
    existing !== undefined &&
    existing.writerId !== record.writerId &&
    existing.updatedAtMs > record.updatedAtMs;

  return {
    loadLatest(docId) {
      const found = latest.get(docId);
      return Promise.resolve({ ok: true, value: found === undefined ? null : cloneJsonValue(found) });
    },
    saveLatest(record) {
      const existing = latest.get(record.docId);
      if (writerConflict(record, existing)) {
        return Promise.resolve(
          failure(
            'PERSIST_BLOCKED_BY_OTHER_TAB',
            `另一个标签页（${existing?.writerId ?? '?'}）在 ${String(existing?.updatedAtMs ?? 0)} 更新过这份文档；本标签页已停止写入`,
          ),
        );
      }
      latest.set(record.docId, cloneJsonValue(record));
      return Promise.resolve({ ok: true, value: undefined });
    },
    loadCheckpoints(docId) {
      return Promise.resolve({
        ok: true,
        value: (checkpoints.get(docId) ?? []).map((item) => cloneJsonValue(item)),
      });
    },
    saveCheckpoint(snapshot) {
      const list = checkpoints.get(snapshot.docId) ?? [];
      const stored: StoredSnapshot = { ...cloneJsonValue(snapshot), id: nextId };
      nextId += 1;
      checkpoints.set(snapshot.docId, [...list, stored]);
      return Promise.resolve({ ok: true, value: undefined });
    },
    deleteCheckpoints(refs) {
      for (const ref of refs) {
        const list = checkpoints.get(ref.docId) ?? [];
        checkpoints.set(
          ref.docId,
          list.filter((item) => item.id !== ref.id),
        );
      }
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

