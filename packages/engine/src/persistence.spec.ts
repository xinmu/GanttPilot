import { describe, expect, it } from 'vitest';

import { commandBaseDocument, longCommandSequence } from './commandFixtures.spec.js';
import { largeDocument } from './fixtures.spec.js';
import { type DocumentCommand } from './command.js';
import { applyDocumentJournal, deepFreezeJson, invertDocumentJournal } from './journal.js';
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  CHECKPOINT_EVERY_STEPS,
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
  restoreSessionOf,
  sameRecord,
  sessionRecordOf,
  type PolicyAction,
  type PolicyState,
  type RetentionPolicy,
  type StoredSession,
  type StoredSnapshot,
} from './persistence.js';
import { applyToSession, createSession, type DocumentSession } from './session.js';
import { redoSession, undoSession } from './session.js';
import type { ProjectDocument } from './schema.js';

/**
 * G6 持久化的**门禁判据**（形状见 ADR 0009，数值与矩阵见 `../PERSISTENCE.md` §四）。
 *
 * 五组：
 * 1. **记录形状**：`sessionRecordOf` → `restoreSessionOf` 逐字段等价（含 JSON 往返）；
 * 2. **恢复**：≥50 步以**可逐步撤销**的方式回来（出口条件②）、跨检查点不丢、
 *    重做栈在"post 为空"时完整恢复、坏候选**只跳过它**（出口条件③的 Node 侧形态）；
 * 3. **负向对照**：每条失败码至少一例（闭集断言）；
 * 4. **策略**（假时钟）：去抖 / 最大间隔 / 手势期不落盘 / 检查点两条触发 / 保留份数 / 配额降级；
 * 5. **存储适配器**：多标签防护、降级路径与 IDB 路径**同一组断言**（内存适配器就是降级路径）。
 */

const DOC_ID = 'doc-1';
const WRITER = 'tab-a';

/**
 * 造一个"每步都真的改了文档"的长序列。
 *
 * **`document.replace` 必须排在最前**（原夹具把它放在序列中段）：本文件大量依赖
 * "应用前缀 N 步后的会话"与"应用 N 步再撤销 K 步后的会话"逐值一致——
 * 中段的整份替换会临时抹掉之前所有任务，撤销回去当然对不上（那是夹具的性质，不是缺陷）。
 */
function sequence(steps: number): readonly DocumentCommand[] {
  const head = longCommandSequence(0);
  const replace = head.filter((command) => command.kind === 'document.replace');
  const rest = head.filter((command) => command.kind !== 'document.replace');
  // 保证**总数恰好是 `steps`**（前缀命令数不变，后缀补足）：测试里的 `checkpointRev` 与
  // "前缀 N 步"都以它为口径，多一条少一条都会让"检查点在链的第 N 步"这句话不成立。
  const tailCount = Math.max(0, steps - head.length);
  const tail: DocumentCommand[] = [];
  for (let index = 0; index < tailCount; index += 1) {
    tail.push({
      kind: 'task.update',
      id: 'w1b',
      // **每一步的值都必须不同**：重复值会命中命令层的 `changed: false`（无操作），
      // 于是"50 步"就退化成"十几步 + 一堆恒等 patch"。
      patch: { notes: `持久化步 ${String(index + 1)}`, progress: index / Math.max(1, tailCount) },
    });
  }
  return [...replace, ...rest, ...tail];
}

/** 应用一段命令，并断言每一步都真的产生变更（否则"50 步"是假的）。 */
function sessionAt(base: ProjectDocument, commands: readonly DocumentCommand[]): DocumentSession {
  let session = createSession(base);
  let step = 0;
  for (const command of commands) {
    const result = applyToSession(session, command);
    if (!result.ok) throw new Error(`第 ${String(step)} 步失败：${command.kind} ${result.code}`);
    expect(result.changed, `第 ${String(step)} 步应当真的改变文档`).toBe(true);
    session = result.session;
    step += 1;
  }
  return session;
}

/** 造一份"与给定会话同一时刻"的检查点快照（`rev` 与 `undoDepth` 都取自会话）。 */
function snapshotOf(session: DocumentSession, id: number, rev: number, createdAtMs: number): StoredSnapshot {
  return {
    id,
    docId: DOC_ID,
    rev,
    undoDepth: session.undoStack.length,
    createdAtMs,
    document: session.document,
  };
}

/**
 * 造一份"链上第 N 步处"的检查点快照（`rev` 与 `undoDepth` 都显式给出）。
 *
 * 测试里同时要两个视角：**链上第 N 步**（`checkpoint` 的位置）与**由第 N 步出发的会话**
 * （`checkpointSession`，它的栈长只有 N）。前者用本函数，后者用 `sessionAt`。
 */
function snapshotAt(
  id: number,
  rev: number,
  undoDepth: number,
  document: ProjectDocument,
  createdAtMs = 1,
): StoredSnapshot {
  return { id, docId: DOC_ID, rev, undoDepth, createdAtMs, document };
}

/** 结构化深拷贝（模拟落盘的 JSON 往返；`StoredSession` 全是普通 JSON 值）。 */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordOf(session: DocumentSession, base: StoredSnapshot | null): StoredSession {
  return sessionRecordOf(session, base, {
    docId: DOC_ID,
    updatedAtMs: 1_000 + session.revision,
    writerId: WRITER,
  });
}

/** 解开 `restoreSessionOf` 的失败（测试里"期望成功"时用它，免得逐处写判别）。 */
function mustRestore(record: StoredSession): DocumentSession {
  const result = restoreSessionOf(record);
  if (!result.ok) throw new Error(`恢复失败：${result.code} ${result.message}`);
  return result.value;
}

/** 把 `DocumentSession` 克隆成可比较的普通值（`revision` 与两个栈的整体形状）。 */
function cloneSession(session: DocumentSession): DocumentSession {
  return structuredClone(session) as DocumentSession;
}

/**
 * 把记录修剪成"运行时真正会写出的形态"。
 *
 * 理由（**这是一条真实的形状不变量，不是测试的将就**）：只有"撤销过、之后没再编辑"的会话才有
 * 非空 redo 栈；而"撤销过"意味着有新的 `change` 要落盘，那一刻 `post` 必然为空。
 * 测试里为了同时构造出"基线 + 增量"，会显式保留 redo 栈——那在运行时不可能出现，
 * 因此这里按运行时的口径修剪（恢复侧的免费不变量也会把这种记录拒掉，见负向对照）。
 */
function trimRecord(record: StoredSession): StoredSession {
  return record.post.length === 0 ? record : { ...record, redo: [] };
}

// ---------------------------------------------------------------- ① 记录形状

describe('G6 记录形状：构造 → 恢复', () => {
  it('无检查点：`post` 是完整历史，恢复后逐字段等价（含 JSON 往返）', () => {
    const base = commandBaseDocument();
    const commands = sequence(12);
    const session = sessionAt(base, commands);
    const record = recordOf(session, null);
    expect(record.recordVersion).toBe(PERSIST_RECORD_VERSION);
    expect(record.post).toHaveLength(commands.length);
    expect(record.redo).toHaveLength(0);
    expect(record.base).toBeNull();

    // 但本版本的恢复要求基线非空 ⇒ 无基线的记录是**结构不全**的，必须被拒（不是静默半恢复）。
    const withoutBase = restoreSessionOf(record);
    expect(withoutBase.ok).toBe(false);
    if (withoutBase.ok) throw new Error('不该成功');
    expect(withoutBase.code).toBe('PERSIST_RECORD_INVALID');
  });

  it('有检查点：`post` 恰是"基线之后"的那些步（写入量只与变更量同阶）', () => {
    const base = commandBaseDocument();
    const commands = sequence(30);
    const total = commands.length;
    const checkpointRev = 20;
    // 会话是**一条链**跑到底；检查点是**同一条链**在第 20 步处的快照。
    const session = sessionAt(base, commands);
    const checkpoint = snapshotAt(1, checkpointRev, checkpointRev, sessionAt(base, commands.slice(0, checkpointRev)).document);

    const record = recordOf(session, checkpoint);
    expect(record.post).toHaveLength(total - checkpointRev);
    // **写入量口径**：记录里不含整份历史的镜像，`post` 只装增量。
    expect(record.rev).toBe(total);

    // 落盘一次 JSON 往返（idb 实现就是 JSON / structured clone）后仍逐字段等价。
    const restored = mustRestore(roundTrip(trimRecord(record)));
    expect(restored.revision).toBe(total);
    // 撤销深度 = 基线之后的步数（基线之前的步由快照承载；撤销到栈底即基线文档）。
    expect(restored.undoStack).toHaveLength(total - checkpointRev);
    expect(restored.undoStack).not.toBe(session.undoStack);
    // 文档逐字段等价（`createdAtMs` 等元信息不在文档里，故直接深比较）。
    expect(restored.document).toStrictEqual(session.document);
  });

  it('写入量：单步增量的体积**与文档规模无关**（R-2 的收益，不变量①）', () => {
    // 用命令层的既有夹具（小文档）与**放大到 500 任务**的文档各测一次：
    // 同一个"只改一个字段"的命令，其日志条目数必须只与**变更量**同阶。
    const measureOf = (document: ProjectDocument): { stepBytes: number; entries: number } => {
      // 取该文档自己的第一个任务（两份夹具的 id 命名不同，不能写死）。
      const target = document.tasks[0];
      if (target === undefined) throw new Error('夹具应当有任务');
      const session = sessionAt(document, [
        { kind: 'task.update', id: target.id, patch: { notes: '写入量探针' } },
      ]);
      const base = snapshotAt(1, 0, 0, document);
      const record = recordOf(session, base);
      expect(record.post).toHaveLength(1);
      const step = record.post[0];
      if (step === undefined) throw new Error('应当有一步');
      const journal = step.journal;
      if (journal.kind !== 'delta') throw new Error('单步应当是细粒度 delta 日志');
      return {
        stepBytes: new TextEncoder().encode(JSON.stringify(step)).length,
        entries: journal.tasks.length + journal.links.length,
      };
    };

    const small = measureOf(commandBaseDocument());
    // 放大 500 任务的夹具（同一份 `render-core` 的确定性生成器，见 `fixtures.ts`）。
    const large = measureOf(largeDocument(500));

    // **条目数不随规模增长**：一次改一个字段 ⇒ 1 条任务条目（R-2 的"O(变更量)"）。
    expect(small.entries).toBe(1);
    expect(large.entries).toBe(1);
    // 体积也不随规模增长（同一量级内；小夹具的文档本身只有 KB 级，故不比"倍数"）。
    expect(Math.abs(large.stepBytes - small.stepBytes)).toBeLessThan(64);
  });

  it('`sessionRecordOf` 不改入参：会话与基线快照都保持原样', () => {
    const base = commandBaseDocument();
    const session = sessionAt(base, sequence(6));
    const checkpoint = snapshotOf(session, 1, 3, 100);
    const before = JSON.stringify({ session: cloneSession(session), checkpoint });
    recordOf(session, checkpoint);
    expect(JSON.stringify({ session: cloneSession(session), checkpoint })).toBe(before);
  });
});

// ---------------------------------------------------------------- ② 恢复与撤销栈

describe('G6 恢复：≥50 步 LIFO、跨检查点、重做栈', () => {
  it('出口条件②：检查点之后的 50 步恢复后**可逐步撤销** 50 次，且每次都与原会话逐值一致', () => {
    const base = commandBaseDocument();
    /** 250 步（=`sequence(250)` 的 10 条前缀命令 + 250 条后缀），检查点取第 200 步。 */
    const commands = sequence(250);
    const total = commands.length;
    const checkpointRev = 200;
    // 一条链跑到底；检查点取第 200 步处的快照。
    const session = sessionAt(base, commands);
    const checkpointSession = sessionAt(base, commands.slice(0, checkpointRev));
    const checkpoint = snapshotAt(1, checkpointRev, checkpointRev, checkpointSession.document);
    expect(total - checkpointRev).toBeGreaterThanOrEqual(50);

    const restored = mustRestore(roundTrip(trimRecord(recordOf(session, checkpoint))));
    expect(restored.revision).toBe(total);
    // **撤销深度不因检查点而缩水**：基线之前的步由快照承载，因此恢复出的栈长 = 基线之后的步数；
    // "能撤销到哪"对用户是等价的（撤销到底给出的就是基线文档）。
    expect(restored.undoStack.length).toBe(total - checkpointRev);
    expect(restored.document).toStrictEqual(session.document);

    // 逐步撤销 50 次：每一步都要与"未持久化的原会话"在**同一位置**逐值相等。
    let restoredCursor = restored;
    let reference = cloneSession(session);
    for (let step = 0; step < 50; step += 1) {
      const undone = undoSession(restoredCursor);
      const referenceUndone = undoSession(reference);
      if (!undone.ok || !referenceUndone.ok) throw new Error('撤销应当成功');
      expect(undone.session.document).toStrictEqual(referenceUndone.session.document);
      expect(undone.session.revision).toBe(referenceUndone.session.revision);
      restoredCursor = undone.session;
      reference = referenceUndone.session;
    }

    // 撤销到"检查点基线状态"：栈恰好清空（基线之前的步由基线快照承载，不再有日志可撤）。
    expect(restoredCursor.undoStack.length).toBe(0);
    expect(restoredCursor.document).toStrictEqual(checkpointSession.document);

    // 再做 50 次重做，回到终点（重做同样不依赖命令重放）。
    for (let step = 0; step < 50; step += 1) {
      const redone = redoSession(restoredCursor);
      if (!redone.ok) throw new Error('重做应当成功');
      restoredCursor = redone.session;
    }
    expect(restoredCursor.document).toStrictEqual(session.document);
  });

  it('`post` 为空时 redo 栈完整恢复（重做在跨会话后仍可用）', () => {
    const base = commandBaseDocument();
    const commands = sequence(5);
    const full = sessionAt(base, commands);
    let session = full;
    for (let step = 0; step < 2; step += 1) {
      const undone = undoSession(session);
      if (!undone.ok) throw new Error('撤销应当成功');
      session = undone.session;
    }
    expect(session.redoStack).toHaveLength(2);

    // 参考状态：**再由公共 `undoSession` 从完整会话走两遍**（而不是重跑前缀命令——
    // `document.replace` 会让"前缀 + 撤销"与"跑前缀"在中间态上不可比）。
    let reference = full;
    for (let step = 0; step < 2; step += 1) {
      const undone = undoSession(reference);
      if (!undone.ok) throw new Error('撤销应当成功');
      reference = undone.session;
    }
    expect(session.document).toStrictEqual(reference.document);
    // `revision` 是**状态版本计数**（撤销也 +1），不是栈深度——两者要分开断言。
    expect(session.revision).toBe(full.revision + 2);
    expect(session.undoStack.length).toBe(full.undoStack.length - 2);

    // 运行时口径：`post` 为空 ⇒ 写盘时**不需要**基线（`base` 可以留在当时的状态）；
    // 这里给的是"当前状态"处的基线，因此恢复只需原样还原。
    const checkpoint = snapshotOf(session, 1, session.revision, 1);
    const restored = mustRestore(roundTrip(recordOf(session, checkpoint)));
    expect(restored.redoStack).toHaveLength(2);
    expect(restored.document).toStrictEqual(session.document);
    // 记录里的 `base` 就是**当前状态**（撤销两次之后），因此 `post` 为空：
    // 恢复出的撤销栈也为空，而 redo 栈完整保留——"撤销过、之后没再编辑"的会话就是这样落盘的。
    expect(restored.undoStack).toHaveLength(0);

    // 重做两步回到完整会话的状态（与未持久化的原会话逐值一致）。
    let cursor = restored;
    for (let step = 0; step < 2; step += 1) {
      const redone = redoSession(cursor);
      if (!redone.ok) throw new Error('重做应当成功');
      cursor = redone.session;
    }
    expect(cursor.document).toStrictEqual(full.document);
    // 注意：这一路的撤销栈只有"恢复出来的那一段"（基线快照把更早的历史折叠成一步），
    // 因此重做两次后的栈长是 2、`revision` 在恢复值上继续累加——两者都不再与"连续跑下来的会话"相等。
    expect(cursor.revision).toBe(session.revision + 2);
    expect(cursor.undoStack.length).toBe(2);
  });

  it('互证律：恢复路径上 `apply(apply(d, j), invert(j)) ≡ d` 仍成立（不重写对合律）', () => {
    const base = commandBaseDocument();
    const commands = sequence(8);
    const session = sessionAt(base, commands);
    const record = recordOf(session, null);
    expect(record.post.length).toBe(session.undoStack.length);

    // 从终点**逆序**走回起点（这正是恢复/撤销共用的那条便宜路径：日志自带 before/after）。
    let backwards = session.document;
    for (let index = record.post.length - 1; index >= 0; index -= 1) {
      const step = record.post[index];
      if (step === undefined) throw new Error(`应当有第 ${String(index)} 步`);
      if (step.journal.kind !== 'delta') throw new Error('尾步应当是细粒度 delta 日志');
      backwards = applyDocumentJournal(backwards, invertDocumentJournal(step.journal));
    }
    expect(backwards).toStrictEqual(base);

    // 正序再走一遍：回到终点（`apply(j)` 与 `apply(swap(j))` 的互证律）。
    let forward = backwards;
    for (const step of record.post) {
      forward = applyDocumentJournal(forward, step.journal);
    }
    expect(forward).toStrictEqual(session.document);
  });
});

// ---------------------------------------------------------------- ③ 负向对照

describe('G6 负向对照：每条失败码至少一例', () => {
  const base = commandBaseDocument();
  const session = sessionAt(base, sequence(4));
  const good = (): StoredSession => roundTrip(recordOf(session, snapshotOf(createSession(base), 1, 0, 1)));

  it('失败码是**闭集**，且与联合类型逐值一致', () => {
    expect([...PERSIST_FAILURE_CODES]).toStrictEqual([
      'PERSIST_UNAVAILABLE',
      'PERSIST_QUOTA_EXCEEDED',
      'PERSIST_BLOCKED_BY_OTHER_TAB',
      'PERSIST_RECORD_INVALID',
      'PERSIST_RECORD_VERSION_UNSUPPORTED',
      'PERSIST_WRITE_FAILED',
    ]);
  });

  it('记录版本不受支持 ⇒ `PERSIST_RECORD_VERSION_UNSUPPORTED`', () => {
    const result = restoreSessionOf({ ...good(), recordVersion: PERSIST_RECORD_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_VERSION_UNSUPPORTED');
  });

  it('`rev` 非有限/负数 ⇒ `PERSIST_RECORD_INVALID`', () => {
    for (const rev of [-1, 1.5, Number.NaN]) {
      const result = restoreSessionOf({ ...good(), rev });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('不该成功');
      expect(result.code).toBe('PERSIST_RECORD_INVALID');
    }
  });

  it('`post` 非空且 `redo` 非空 ⇒ 拒（免费不变量：新命令早该清空 redo 栈）', () => {
    const record = good();
    const step = record.post[0];
    if (step === undefined) throw new Error('应当有步');
    const result = restoreSessionOf({ ...record, redo: [step] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_INVALID');
    expect(result.message).toContain('redo');
  });

  it('日志 `before` 与文档不符（自相矛盾）⇒ 拒，且信息指出是哪一步', () => {
    const record = good();
    // 把第二步的日志换成第一步的：它的 before 与"第一步之后的文档"不同。
    const first = record.post[0];
    if (first === undefined) throw new Error('应当有第一步');
    const tampered: StoredSession = { ...record, post: [first, first, ...record.post.slice(2)] };
    const result = restoreSessionOf(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_INVALID');
    expect(result.message).toContain('post[1]');
  });

  it('命令形状非法 ⇒ 拒（命令层守卫被复用，不重写）', () => {
    const record = good();
    const first = record.post[0];
    if (first === undefined) throw new Error('应当有第一步');
    const broken = { ...record, post: [{ ...first, commands: [{ kind: 'task.update' }] }, ...record.post.slice(1)] };
    const result = restoreSessionOf(broken as unknown as StoredSession);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_INVALID');
    expect(result.message).toContain('commands[0]');
  });

  it('日志形态未知 / `tasks` 不是数组 ⇒ `checkJournalShape` 给出原因', () => {
    expect(checkJournalShape(null)).toContain('不是对象');
    expect(checkJournalShape({ kind: 'nope' })).toContain('未知的日志形态');
    expect(checkJournalShape({ kind: 'delta', tasks: {}, links: [] })).toContain('tasks');
    expect(checkJournalShape({ kind: 'document', before: {} })).toContain('after');
    expect(checkJournalShape({ kind: 'delta', tasks: [], links: [] })).toBeNull();
  });

  it('检查点文档版本不认识 ⇒ 拒（不重写文档规则：版本守卫在恢复侧也要有）', () => {
    const record = good();
    const snapshot = record.base;
    if (snapshot === null) throw new Error('应当有基线');
    const result = restoreSessionOf({
      ...record,
      base: { ...snapshot, document: { ...snapshot.document, version: 99 } as unknown as ProjectDocument },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_INVALID');
    expect(result.message).toContain('文档版本');
  });

  it('检查点文档含 error 级诊断 ⇒ 拒（复用 `validateDocument`）', () => {
    const record = good();
    const snapshot = record.base;
    if (snapshot === null) throw new Error('应当有基线');
    const tasks = snapshot.document.tasks;
    if (tasks.length === 0) throw new Error('夹具应当有任务');
    const first = tasks[0];
    if (first === undefined) throw new Error('夹具应当有任务');
    const brokenDocument: ProjectDocument = {
      ...snapshot.document,
      tasks: [{ ...first, id: '' }, ...tasks.slice(1)],
    };
    const result = restoreSessionOf({ ...record, base: { ...snapshot, document: brokenDocument } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_INVALID');
  });

  it('非 JSON 值（`undefined`/函数）在记录里 ⇒ 拒', () => {
    const record = good();
    const result = restoreSessionOf({ ...record, writerId: undefined as unknown as string });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.code).toBe('PERSIST_RECORD_INVALID');
  });
});

// ---------------------------------------------------------------- ③ 恢复优先级与容错

describe('G6 恢复优先级：L3 → 检查点 → 无（坏候选只跳过）', () => {
  const base = commandBaseDocument();
  const commands = sequence(20);
  /** 前缀会话（与"连跑前缀"逐值一致，因为命令是纯函数、无时钟无随机）。 */
  const prefix = (steps: number): DocumentSession => sessionAt(base, commands.slice(0, steps));
  const session = prefix(12);
  const checkpoint1 = snapshotOf(prefix(4), 1, 4, 100);
  const checkpoint2 = snapshotOf(prefix(8), 2, 8, 200);
  const goodRecord = trimRecord(
    sessionRecordOf(session, checkpoint2, {
      docId: DOC_ID,
      updatedAtMs: 300,
      writerId: WRITER,
    }),
  );

  it('最新状态可用 ⇒ 用它（`resolvedFrom: latest`，`stepsApplied` = post 长度）', () => {
    const plan = planRestoreOf({ latest: roundTrip(goodRecord), snapshots: [checkpoint1, checkpoint2] }, DOC_ID);
    expect(plan.resolvedFrom).toBe('latest');
    expect(plan.rev).toBe(12);
    expect(plan.stepsApplied).toBe(12 - 8);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.session?.document).toStrictEqual(session.document);
    expect(plan.session?.undoStack.length).toBe(12 - 8);
  });

  it('最新状态**坏掉** ⇒ 自动回落到最新检查点（且如实报告被跳过的原因）', () => {
    const broken: StoredSession = { ...roundTrip(goodRecord), recordVersion: 99 };
    const plan = planRestoreOf({ latest: broken, snapshots: [checkpoint1, checkpoint2] }, DOC_ID);
    expect(plan.resolvedFrom).toBe('checkpoint');
    expect(plan.rev).toBe(8);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.source).toBe('latest');
    expect(plan.rejected[0]?.code).toBe('PERSIST_RECORD_VERSION_UNSUPPORTED');
    expect(plan.session?.document).toStrictEqual(prefix(8).document);
  });

  it('最新状态坏 + **最新检查点也坏** ⇒ 只能退到更旧的检查点（坏候选不阻断后面的候选）', () => {
    const plan = planRestoreOf(
      {
        latest: { ...roundTrip(goodRecord), recordVersion: 99 },
        snapshots: [
          { ...checkpoint2, document: { ...checkpoint2.document, version: 99 } as unknown as ProjectDocument },
          checkpoint1,
        ],
      },
      DOC_ID,
    );
    expect(plan.resolvedFrom).toBe('checkpoint');
    expect(plan.rev).toBe(4);
    expect(plan.rejected.map((item) => item.source)).toStrictEqual(['latest', 'checkpoint']);
  });

  it('候选的 `docId` 不匹配 ⇒ 拒（不许把别份文档接进来）', () => {
    const plan = planRestoreOf(
      { latest: { ...roundTrip(goodRecord), docId: 'other' }, snapshots: [{ ...checkpoint1, docId: 'other' }] },
      DOC_ID,
    );
    expect(plan.session).toBeNull();
    expect(plan.resolvedFrom).toBe('none');
    expect(plan.rejected).toHaveLength(2);
  });

  it('全无 ⇒ `session: null`（调用方回落演示文档，不在这里造空文档）', () => {
    const plan = planRestoreOf({ latest: null, snapshots: [] }, DOC_ID);
    expect(plan.session).toBeNull();
    expect(plan.rev).toBeNull();
    expect(plan.stepsApplied).toBe(0);
  });

  it('出口条件③（Node 侧）：写者被"杀掉"后，仍能恢复到**最后一次成功写入**（rev ≥ 最近检查点）', async () => {
    const written = prefix(12);
    const checkpointAt = prefix(8);
    const store = createMemorySnapshotStore();
    const saved = await store.saveCheckpoint({
      docId: DOC_ID,
      rev: checkpointAt.revision,
      undoDepth: checkpointAt.undoStack.length,
      createdAtMs: 200,
      document: checkpointAt.document,
    });
    expect(saved.ok).toBe(true);
    const wrote = await store.saveLatest(
      sessionRecordOf(written, snapshotAt(0, checkpointAt.revision, checkpointAt.undoStack.length, checkpointAt.document, 200), {
        docId: DOC_ID,
        updatedAtMs: 400,
        writerId: WRITER,
      }),
    );
    expect(wrote.ok).toBe(true);

    const latest = await store.loadLatest(DOC_ID);
    const snapshots = await store.loadCheckpoints(DOC_ID);
    const decoded = decodeCandidates({
      latest: latest.ok ? latest.value : null,
      snapshots: snapshots.ok ? snapshots.value : [],
    });
    expect(decoded.invalid).toBe(0);
    const plan = planRestoreOf(decoded.candidates, DOC_ID);
    const checkpointRev = decoded.candidates.snapshots[0]?.rev ?? 0;
    expect(plan.rev ?? 0).toBeGreaterThanOrEqual(checkpointRev);
    expect(plan.session?.document).toStrictEqual(written.document);
  });

  it('`decodeCandidates` 把"连形状都不对"的输入计为 invalid，但不作废其余候选', () => {
    const decoded = decodeCandidates({
      latest: 42,
      snapshots: ['nope', roundTrip(checkpoint1)],
    });
    expect(decoded.invalid).toBe(2);
    expect(decoded.candidates.latest).toBeNull();
    expect(decoded.candidates.snapshots).toHaveLength(1);
    const plan = planRestoreOf(decoded.candidates, DOC_ID);
    expect(plan.resolvedFrom).toBe('checkpoint');
    expect(plan.rev).toBe(4);
  });
});

// ---------------------------------------------------------------- ④ 触发策略（假时钟）

describe('G6 触发状态机（假时钟）', () => {
  const policy: RetentionPolicy = createRetentionPolicy({
    debounceMs: 100,
    maxIntervalMs: 250,
    checkpointIntervalMs: 1000,
    checkpointEverySteps: 5,
    keep: 3,
    degradedKeep: 1,
  });

  /** 依次喂事件，返回最后一次的动作轨迹。 */
  function run(start: PolicyState, events: readonly Parameters<typeof policyReduce>[2][]): {
    state: PolicyState;
    actions: readonly PolicyAction[];
  } {
    let state = start;
    const actions: PolicyAction[] = [];
    for (const event of events) {
      const step = policyReduce(policy, state, event);
      state = step.state;
      actions.push(step.action);
    }
    return { state, actions };
  }

  it('默认数值就是 ADR/PERSISTENCE 登记的那一套', () => {
    const defaults = createRetentionPolicy();
    expect(defaults.debounceMs).toBe(AUTOSAVE_DEBOUNCE_MS);
    expect(defaults.maxIntervalMs).toBe(AUTOSAVE_MAX_INTERVAL_MS);
    expect(defaults.checkpointEverySteps).toBe(CHECKPOINT_EVERY_STEPS);
    expect(defaults.keep).toBe(CHECKPOINT_KEEP);
    expect(defaults.degradedKeep).toBe(QUOTA_DEGRADED_KEEP);
  });

  it('去抖：**首次写必须先建基线**；此后未到窗口 ⇒ `none`、到窗口 ⇒ `flush`', () => {
    const first = run(createPolicyState(), [{ kind: 'change', rev: 1, atMs: 0 }, { kind: 'tick', atMs: 50 }]);
    expect(first.actions).toStrictEqual(['none', 'none']);
    expect(first.state.dirty).toBe(true);

    // 首次落盘：没有检查点 ⇒ 必须是 `checkpoint`（记录形状要求基线非空）。
    const second = policyReduce(policy, first.state, { kind: 'tick', atMs: 100 });
    expect(second.action).toBe('checkpoint');
    // **写了才算数**：`tick` 不改 `dirty`，由调用方在写成功后喂 `flushed`/`checkpointed`。
    expect(second.state.dirty).toBe(true);

    // 基线建好之后：同一份变更（已 flushed）不该再触发写。
    const third = run(second.state, [
      { kind: 'checkpointed', atMs: 101, rev: 1 },
      { kind: 'flushed', atMs: 101 },
      { kind: 'tick', atMs: 400 },
    ]);
    expect(third.state.dirty).toBe(false);
    expect(third.state.dirtySinceMs).toBeNull();
    expect(third.actions).toStrictEqual(['none', 'none', 'none']);

    // 新的变更：到去抖窗口 ⇒ `flush`（基线还在，不需要再来一次检查点）。
    const fourth = run(third.state, [
      { kind: 'change', rev: 2, atMs: 500 },
      { kind: 'tick', atMs: 550 },
      { kind: 'tick', atMs: 600 },
    ]);
    expect(fourth.actions).toStrictEqual(['none', 'none', 'flush']);
  });

  it('连续编辑不推迟落盘：`dirtySinceMs` 只在变脏那一刻记（最大间隔因此真的成立）', () => {
    // 先建基线（首次写必须是检查点），再观察"连续编辑"的去抖与封顶。
    const withBase = run(createPolicyState(), [
      { kind: 'change', rev: 1, atMs: 0 },
      { kind: 'tick', atMs: 100 },
      { kind: 'checkpointed', atMs: 100, rev: 1 },
      { kind: 'flushed', atMs: 100 },
    ]);
    expect(withBase.actions.at(-1)).toBe('none');

    const { state, actions } = run(withBase.state, [
      { kind: 'change', rev: 2, atMs: 200 },
      { kind: 'change', rev: 3, atMs: 290 },
      { kind: 'change', rev: 4, atMs: 380 },
      { kind: 'tick', atMs: 300 },
      { kind: 'tick', atMs: 400 },
      { kind: 'tick', atMs: 450 },
    ]);
    expect(state.dirtySinceMs).toBe(200);
    // 300 / 400 / 450 都已越过去抖窗口（首次变脏 200 + 100）⇒ 三次都该写；
    // **`dirtySinceMs` 不会被后续编辑推后**（它一直等于 200），所以"最大间隔"是真的封顶。
    expect(actions).toStrictEqual(['none', 'none', 'none', 'flush', 'flush', 'flush']);
  });

  it('手势活动期**不落盘**；回到 `idle` 后立刻补写（出口条件①的策略层事实）', () => {
    const withBase = run(createPolicyState(), [
      { kind: 'change', rev: 1, atMs: 0 },
      { kind: 'tick', atMs: 100 },
      { kind: 'checkpointed', atMs: 100, rev: 1 },
      { kind: 'flushed', atMs: 100 },
    ]);
    const dragging = run(withBase.state, [
      { kind: 'change', rev: 2, atMs: 200 },
      { kind: 'activity', active: 'dragging' },
      { kind: 'tick', atMs: 300 },
      { kind: 'tick', atMs: 450 },
      { kind: 'tick', atMs: 5000 },
    ]);
    expect(dragging.actions).toStrictEqual(['none', 'none', 'none', 'none', 'none']);
    expect(dragging.state.dirty).toBe(true);

    // 回到 `idle`：**去抖窗口早已越界** ⇒ 立刻补写（写发生在"松手之后"，不在帧内）。
    const afterIdle = policyReduce(policy, dragging.state, { kind: 'activity', active: 'idle' });
    expect(policyReduce(policy, afterIdle.state, { kind: 'tick', atMs: 450 }).action).toBe('flush');
    // 走得更久会撞上**检查点**的时间阈值（`checkpointIntervalMs = 1000`，基线在 100）——
    // 那是另一条触发条件，不是"补写"失效。
    expect(policyReduce(policy, afterIdle.state, { kind: 'tick', atMs: 1400 }).action).toBe('checkpoint');
  });


  it('检查点：首次写必须建基线；此后按时间阈值或步数阈值触发', () => {
    const idle = policyReduce(policy, createPolicyState(), { kind: 'tick', atMs: 0 });
    expect(idle.action).toBe('none'); // 还不脏 ⇒ 什么都不做

    const dirty = run(createPolicyState(), [
      { kind: 'change', rev: 1, atMs: 0 },
      { kind: 'tick', atMs: 100 },
    ]);
    expect(dirty.actions.at(-1)).toBe('checkpoint'); // 没有基线 ⇒ 必须建

    const checkpointed = run(dirty.state, [
      { kind: 'checkpointed', atMs: 100, rev: 1 },
      { kind: 'flushed', atMs: 100 },
      { kind: 'change', rev: 2, atMs: 200 },
      { kind: 'tick', atMs: 300 },
    ]);
    expect(checkpointed.actions.at(-1)).toBe('flush'); // 时间与步数都没到

    // 步数阈值：基线在 `rev = 1`，`checkpointEverySteps = 5` ⇒ `rev = 6` 时到阈值；
    // 每步都按**真实调用顺序**喂事件：change → tick（拿动作）→ 写成功后回喂 flushed/checkpointed。
    let state = checkpointed.state;
    const actions: PolicyAction[] = [];
    for (let rev = 3; rev <= 8; rev += 1) {
      // 每步之间留出**足够**的时间（`debounceMs = 100`），确保"去抖已到"不再是变量。
      const atMs = 300 + 100 * rev;
      // 真实调用顺序：先记账变更 → 问 tick 拿动作 → **写成功后**才回喂 flushed/checkpointed
      // （回喂 `flushed` 会推进 `lastFlushMs`，把下一次的去抖窗口一起重置——不写就不能回喂）。
      state = policyReduce(policy, state, { kind: 'change', rev, atMs }).state;
      const step = policyReduce(policy, state, { kind: 'tick', atMs });
      state = step.state;
      actions.push(step.action);
      if (step.action === 'checkpoint') {
        state = policyReduce(policy, state, { kind: 'checkpointed', atMs, rev }).state;
        state = policyReduce(policy, state, { kind: 'flushed', atMs }).state;
      } else if (step.action === 'flush') {
        state = policyReduce(policy, state, { kind: 'flushed', atMs }).state;
      }
    }
    // 逐步读法：`rev = 3` 落盘（`flush`，因为 rev 4 的去抖还没到）；`rev = 4` 不够时间 ⇒ `none`；
    // `rev = 5` 落盘；`rev = 6` 距基线（rev 1）**5 步** ⇒ 到步数阈值 ⇒ `checkpoint`；此后窗口重新开始。
    expect(actions).toStrictEqual(['flush', 'none', 'flush', 'none', 'checkpoint', 'none']);

    // 时间阈值：`rev = 9` 的变更拖到基线之后很久才 tick ⇒ 时间阈值（1000 ms）先到。
    state = policyReduce(policy, state, { kind: 'change', rev: 9, atMs: 1200 }).state;
    expect(policyReduce(policy, state, { kind: 'tick', atMs: 1400 }).action).toBe('flush');
    expect(policyReduce(policy, state, { kind: 'tick', atMs: 2300 }).action).toBe('checkpoint');
  });

  it('配额超限 ⇒ `degrade`，此后只保留 1 份（不改编辑行为）', () => {
    const step = policyReduce(policy, createPolicyState(), { kind: 'quotaExceeded' });
    expect(step.action).toBe('degrade');
    expect(step.state.degraded).toBe(true);
    expect(effectiveKeep(policy, step.state)).toBe(QUOTA_DEGRADED_KEEP);
    expect(effectiveKeep(policy, createPolicyState())).toBe(CHECKPOINT_KEEP);
  });
});

// ---------------------------------------------------------------- ④ 保留份数

describe('G6 检查点保留：确定性裁剪', () => {
  const refs = [
    { id: 1, docId: DOC_ID, rev: 1, createdAtMs: 100, document: commandBaseDocument() },
    { id: 2, docId: DOC_ID, rev: 2, createdAtMs: 200, document: commandBaseDocument() },
    { id: 3, docId: DOC_ID, rev: 3, createdAtMs: 300, document: commandBaseDocument() },
  ];

  it('`keep = 3` 下新增第 4 份 ⇒ 删掉最旧那份', () => {
    const incoming = { id: 4, docId: DOC_ID, rev: 4, createdAtMs: 400, document: commandBaseDocument() };
    const plan = planCheckpoint(refs, 3, incoming);
    expect(plan.keep.map((item) => item.id)).toStrictEqual([4, 3, 2]);
    expect(plan.remove.map((item) => item.id)).toStrictEqual([1]);
  });

  it('与插入顺序无关（同一集合、不同排列 ⇒ 同一个计划）', () => {
    const incoming = { id: 4, docId: DOC_ID, rev: 4, createdAtMs: 400, document: commandBaseDocument() };
    const forward = planCheckpoint(refs, 3, incoming);
    const reversed = planCheckpoint([...refs].reverse(), 3, incoming);
    expect(reversed.keep).toStrictEqual(forward.keep);
    expect(reversed.remove).toStrictEqual(forward.remove);
  });

  it('降级 `keep = 1` ⇒ 只留最新一份', () => {
    const plan = planCheckpoint(refs, QUOTA_DEGRADED_KEEP);
    expect(plan.keep.map((item) => item.id)).toStrictEqual([3]);
    expect(plan.remove.map((item) => item.id)).toStrictEqual([2, 1]);
  });

  it('`keep = 0` 语义有定义（全删），且同毫秒写入按自增 id 区分', () => {
    expect(planCheckpoint(refs, 0).keep).toStrictEqual([]);
    expect(planCheckpoint(refs, 0).remove).toHaveLength(3);
    const sameMs = [
      { id: 10, docId: DOC_ID, rev: 1, createdAtMs: 500, document: commandBaseDocument() },
      { id: 11, docId: DOC_ID, rev: 2, createdAtMs: 500, document: commandBaseDocument() },
    ];
    const plan = planCheckpoint(sameMs, 1);
    expect(plan.keep.map((item) => item.id)).toStrictEqual([11]);
  });
});

// ---------------------------------------------------------------- ⑤ 存储适配器

describe('G6 存储适配器（内存实现 = 浏览器降级路径）', () => {
  const base = commandBaseDocument();
  const session = sessionAt(base, sequence(6));

  it('往返：写进去、读回来逐字段等价（并且零共享引用）', async () => {
    const store = createMemorySnapshotStore();
    const record = sessionRecordOf(session, snapshotOf(session, 0, 3, 1), {
      docId: DOC_ID,
      updatedAtMs: 10,
      writerId: WRITER,
    });
    const saved = await store.saveLatest(record);
    expect(saved.ok).toBe(true);

    const loaded = await store.loadLatest(DOC_ID);
    if (!loaded.ok || loaded.value === null) throw new Error('应当读到记录');
    expect(sameRecord(loaded.value, record)).toBe(true);

    // 零共享引用：改读回来的对象不影响存储；再读一次仍是原值。
    const mutable = loaded.value as { rev: number };
    mutable.rev = 999;
    const again = await store.loadLatest(DOC_ID);
    if (!again.ok || again.value === null) throw new Error('应当读到记录');
    expect(again.value.rev).toBe(record.rev);
  });

  it('多标签防护：别的标签页更新更晚 ⇒ 拒写、且**不覆盖**已有记录', async () => {
    const store = createMemorySnapshotStore();
    const mine = { docId: DOC_ID, rev: 6, undoDepth: 6, updatedAtMs: 10, writerId: WRITER };
    const first = await store.saveLatest({
      recordVersion: PERSIST_RECORD_VERSION,
      base: null,
      post: [],
      redo: [],
      ...mine,
    });
    expect(first.ok).toBe(true);

    const otherWriter = await store.saveLatest({
      recordVersion: PERSIST_RECORD_VERSION,
      base: null,
      post: [],
      redo: [],
      docId: DOC_ID,
      rev: 7,
      undoDepth: 7,
      updatedAtMs: 20,
      writerId: 'tab-b',
    });
    expect(otherWriter.ok).toBe(true);

    const stale = await store.saveLatest({
      recordVersion: PERSIST_RECORD_VERSION,
      base: null,
      post: [],
      redo: [],
      docId: DOC_ID,
      rev: 8,
      undoDepth: 8,
      updatedAtMs: 15,
      writerId: WRITER,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('不该成功');
    expect(stale.code).toBe('PERSIST_BLOCKED_BY_OTHER_TAB');

    const loaded = await store.loadLatest(DOC_ID);
    if (!loaded.ok || loaded.value === null) throw new Error('应当读到记录');
    expect(loaded.value.writerId).toBe('tab-b');
    expect(loaded.value.rev).toBe(7);
  });

  it('同一写者继续写 ⇒ 正常覆盖（防的是"别的标签页"，不是"同一标签页的多次写"）', async () => {
    const store = createMemorySnapshotStore();
    const make = (rev: number, at: number): StoredSession => ({
      recordVersion: PERSIST_RECORD_VERSION,
      docId: DOC_ID,
      rev,
      undoDepth: rev,
      base: null,
      post: [],
      redo: [],
      writerId: WRITER,
      updatedAtMs: at,
    });
    await store.saveLatest(make(1, 10));
    const second = await store.saveLatest(make(2, 20));
    expect(second.ok).toBe(true);
    const loaded = await store.loadLatest(DOC_ID);
    if (!loaded.ok || loaded.value === null) throw new Error('应当读到记录');
    expect(loaded.value.rev).toBe(2);
  });

  it('检查点：写入分配递增 id；按 id 删除（引用自 `planCheckpoint`）', async () => {
    const store = createMemorySnapshotStore();
    const first = await store.saveCheckpoint(snapshotOf(session, 0, 3, 100));
    const second = await store.saveCheckpoint(snapshotOf(session, 0, 4, 200));
    expect(first.ok && second.ok).toBe(true);

    const loaded = await store.loadCheckpoints(DOC_ID);
    if (!loaded.ok) throw new Error('应当读到检查点');
    expect(loaded.value.map((item) => item.id)).toStrictEqual([1, 2]);
    const plan = planCheckpoint(loaded.value, 1);
    expect(plan.keep.map((item) => item.id)).toStrictEqual([2]);

    const deleted = await store.deleteCheckpoints(plan.remove);
    expect(deleted.ok).toBe(true);
    const after = await store.loadCheckpoints(DOC_ID);
    if (!after.ok) throw new Error('应当读到检查点');
    expect(after.value.map((item) => item.id)).toStrictEqual([2]);
  });

  it('空库：`loadLatest` 给 `null`（不是失败）、`loadCheckpoints` 给空数组', async () => {
    const store = createMemorySnapshotStore();
    const latest = await store.loadLatest('nothing-here');
    expect(latest.ok).toBe(true);
    if (latest.ok) expect(latest.value).toBeNull();
    const checkpoints = await store.loadCheckpoints('nothing-here');
    expect(checkpoints.ok).toBe(true);
    if (checkpoints.ok) expect(checkpoints.value).toStrictEqual([]);
  });

  it('保存的记录不会被调用方后续修改影响（深拷贝后冻结语义等价）', async () => {
    const store = createMemorySnapshotStore();
    const record: StoredSession = {
      recordVersion: PERSIST_RECORD_VERSION,
      docId: DOC_ID,
      rev: 3,
      base: snapshotOf(session, 0, 3, 1),
      post: [],
      redo: [],
      writerId: WRITER,
      updatedAtMs: 5,
    };
    await store.saveLatest(deepFreezeJson(record));
    const loaded = await store.loadLatest(DOC_ID);
    if (!loaded.ok || loaded.value === null) throw new Error('应当读到记录');
    expect(loaded.value.rev).toBe(3);
    expect(Object.isFrozen(loaded.value)).toBe(false);
  });
});
