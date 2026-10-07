/**
 * **记录的构造与恢复**（P3/C4-c 从 \`persistence.ts\` 拆出）。
 *
 * 三条纪律（原文件头已登记，这里只留与本文件相关的那条）：**不重写任何既有规则**——
 * 文档合法性用 \`validateDocument\`、命令形状用 \`checkCommandShape\`、日志应用用 \`applyDocumentJournal\`；
 * 恢复不需要"重放命令"（\`post\` 里每步都带 journal 镜像）。
 */

import {
  applyDocumentJournal,
  cloneJsonValue,
  findNonJsonValue,
  invertDocumentJournal,
} from '../journal.js';
import { reindexDocument, validateDocument } from '../schema.js';
import { restoreSession, type DocumentSession, type SessionStep } from '../session.js';
import { checkRestorableDocument, checkStep } from './guards.js';
import {
  failure,
  PERSIST_RECORD_VERSION,
  type PersistFailureCode,
  type PersistResult,
  type RecordMeta,
  type RestoreCandidates,
  type RestorePlan,
  type StoredSession,
  type StoredSnapshot,
  type StoredStep,
} from './types.js';

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
