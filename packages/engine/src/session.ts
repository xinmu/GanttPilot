/**
 * 会话与事务：撤销/重做的**唯一真相源**（G1.3 交付给 G5/G6 的单元）。
 *
 * ## 边界（ADR 0003）
 *
 * | 概念 | 含义 |
 * |---|---|
 * | `DocumentCommand` | 一次原子、可重放、可逆的变更（`command.ts`） |
 * | `Transaction` | 一组按序执行、**原子**提交的命令，作为**一个**撤销单元（= 一次手势） |
 * | `DocumentSession` | 不可变值：当前文档 + 单调 `revision` + undo/redo 两栈 |
 *
 * IX-03 的口径"一次手势 = 一个 Command"在本层的落地方式是：
 * **能表达成一条命令的手势就是一条命令**（`applyToSession`）；
 * 需要多条原始命令的手势（级联写回、批量调级）提交为一个事务——
 * 仍然只压**一条** step，所以一次 Ctrl+Z 回退整次手势。
 *
 * ## 会话是不可变值 + 纯函数（不是类、不是事件总线）
 *
 * 与 `wbs.ts`/`schema.ts` 风格一致：`applyToSession` 等既不修改入参会话，也不产生副作用，
 * 因此天然可测试、可在 `apps/web` 里用 `ref` 持有、可整体 JSON 序列化交给 G6。
 * **不做**订阅/事件/持久化——那是 G4/G5/G6 的事。
 *
 * ## 成本
 *
 * - `applyToSession`：一次 `applyCommand`（O(N)，见 `command.ts`）；
 * - `commitTransaction`：成员命令各自的 O(N) + 一次端点差分 O(N)；
 * - `undoSession`/`redoSession`：日志应用 O(变更量)，**与命令本身无关**（这是 R-2 的收益）。
 *
 * 本文件零 DOM、零框架依赖。
 */

import {
  applyCommand,
  type CommandFailureCode,
  type DocumentCommand,
} from './command.js';
import {
  applyDocumentJournal,
  diffDocument,
  invertDocumentJournal,
  isJournalEmpty,
  type DocumentJournal,
} from './journal.js';
import type { DocumentDiagnostic, ProjectDocument } from './schema.js';

/** 撤销栈/重做栈里的一步：一次手势（一条命令或一个事务）+ 它的 before 镜像。 */
export interface SessionStep {
  readonly commands: readonly DocumentCommand[];
  readonly journal: DocumentJournal;
}

/**
 * 编辑会话（**不可变值**）。
 *
 * `revision` 是**状态版本计数**：任何一次成功的状态变化（应用/撤销/重做）都 +1，单调不减。
 * 它的用途是缓存失效（G4 判断"视图是否落后"）与 G6 落盘摘要——**不是**栈深度。
 */
export interface DocumentSession {
  readonly document: ProjectDocument;
  readonly revision: number;
  /** 栈顶在末位（LIFO）。 */
  readonly undoStack: readonly SessionStep[];
  readonly redoStack: readonly SessionStep[];
}

/** 会话层失败码（命令层失败码 + 两个栈空码）。 */
export type SessionFailureCode =
  | CommandFailureCode
  | 'SESSION_NOTHING_TO_UNDO'
  | 'SESSION_NOTHING_TO_REDO';

/** 会话操作结果。`failedIndex` 只在事务提交失败时出现（指出是哪一条成员命令失败）。 */
export type SessionResult =
  | { readonly ok: true; readonly changed: true; readonly session: DocumentSession }
  | { readonly ok: true; readonly changed: false; readonly session: DocumentSession }
  | {
      readonly ok: false;
      readonly code: SessionFailureCode;
      readonly message: string;
      readonly failedIndex?: number;
      readonly diagnostics?: readonly DocumentDiagnostic[];
    };

/**
 * 事务：一组命令，**原子**（全部成功才改会话）且**整体**（一个撤销单元）。
 *
 * 不可变值：`addToTransaction` 返回新事务——UI 可以在拖拽过程中逐步累积，
 * 松手时 `commitTransaction` 一次落地。
 */
export interface Transaction {
  readonly commands: readonly DocumentCommand[];
}

function failed(
  code: SessionFailureCode,
  message: string,
  extra: { readonly failedIndex?: number; readonly diagnostics?: readonly DocumentDiagnostic[] } = {},
): SessionResult {
  return {
    ok: false,
    code,
    message,
    ...(extra.failedIndex === undefined ? {} : { failedIndex: extra.failedIndex }),
    ...(extra.diagnostics === undefined ? {} : { diagnostics: extra.diagnostics }),
  };
}

/** 新建会话（`revision` 供 G6 恢复快照时对齐；默认 0）。 */
export function createSession(document: ProjectDocument, revision = 0): DocumentSession {
  return { document, revision, undoStack: [], redoStack: [] };
}

/** 新建空事务。 */
export function createTransaction(commands: readonly DocumentCommand[] = []): Transaction {
  return { commands: [...commands] };
}

/** 追加一条命令（返回新事务，不改入参）。 */
export function addToTransaction(transaction: Transaction, command: DocumentCommand): Transaction {
  return { commands: [...transaction.commands, command] };
}

/**
 * 应用一条命令到会话。
 *
 * - 失败 → 会话原样（含栈），只返回失败码；
 * - 无操作（`changed:false`）→ 会话原样，**且不清空 redo 栈**（什么都没发生，重做仍应可用）；
 * - 真的变了 → 压一条 step、清空 redo 栈、`revision + 1`。
 */
export function applyToSession(session: DocumentSession, command: DocumentCommand): SessionResult {
  const result = applyCommand(session.document, command);
  if (!result.ok) {
    return failed(result.code, result.message, {
      ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
    });
  }
  if (!result.changed) {
    return { ok: true, changed: false, session };
  }
  return {
    ok: true,
    changed: true,
    session: {
      document: result.document,
      revision: session.revision + 1,
      undoStack: [...session.undoStack, { commands: [command], journal: result.journal }],
      redoStack: [],
    },
  };
}

/**
 * 提交一个事务：成员命令按序执行，**任一失败则会话完全不变**（原子性）。
 *
 * 合并日志 = **起点与终点的差分**（`diffDocument`）——它天然处理"插入后又删除"这类相互抵消，
 * 且与"一条手势 = 一个撤销单元"的口径一致：中间态不需要被回放。
 * 单命令事务直接用该命令自己的日志（这样 `document.replace` 保留整份文档镜像形态）。
 */
export function commitTransaction(
  session: DocumentSession,
  transaction: Transaction,
): SessionResult {
  if (transaction.commands.length === 0) {
    return { ok: true, changed: false, session };
  }
  if (transaction.commands.length === 1) {
    const only = transaction.commands[0];
    if (only === undefined) {
      return { ok: true, changed: false, session };
    }
    return applyToSession(session, only);
  }

  let current = session.document;
  for (const [index, command] of transaction.commands.entries()) {
    const result = applyCommand(current, command);
    if (!result.ok) {
      return failed(result.code, result.message, {
        failedIndex: index,
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      });
    }
    current = result.document;
  }

  const journal = diffDocument(session.document, current);
  if (isJournalEmpty(journal)) {
    return { ok: true, changed: false, session };
  }
  return {
    ok: true,
    changed: true,
    session: {
      document: current,
      revision: session.revision + 1,
      undoStack: [...session.undoStack, { commands: transaction.commands, journal }],
      redoStack: [],
    },
  };
}

/** 撤销一步（LIFO）。日志应用的是 `invertDocumentJournal(step.journal)`，**无需任何手写逆逻辑**。 */
export function undoSession(session: DocumentSession): SessionResult {
  const step = session.undoStack[session.undoStack.length - 1];
  if (step === undefined) {
    return failed('SESSION_NOTHING_TO_UNDO', '没有可撤销的步骤');
  }
  return {
    ok: true,
    changed: true,
    session: {
      document: applyDocumentJournal(session.document, invertDocumentJournal(step.journal)),
      revision: session.revision + 1,
      undoStack: session.undoStack.slice(0, -1),
      redoStack: [...session.redoStack, step],
    },
  };
}

/** 重做一步（redo 栈 LIFO）；正向应用同一份日志即可（`after` 已在镜像里，不必重跑命令）。 */
export function redoSession(session: DocumentSession): SessionResult {
  const step = session.redoStack[session.redoStack.length - 1];
  if (step === undefined) {
    return failed('SESSION_NOTHING_TO_REDO', '没有可重做的步骤');
  }
  return {
    ok: true,
    changed: true,
    session: {
      document: applyDocumentJournal(session.document, step.journal),
      revision: session.revision + 1,
      undoStack: [...session.undoStack, step],
      redoStack: session.redoStack.slice(0, -1),
    },
  };
}
