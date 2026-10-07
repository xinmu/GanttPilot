/**
 * **记录守卫与恢复候选的解析**（P3/C4-c 从 \`persistence.ts\` 拆出）。
 *
 * 这里的每个函数都只回答"这个 \`unknown\` 能不能当记录/步骤用"，以及"两条记录是否同一份"——
 * 它们被 \`record.ts\`（恢复）与调用方（读存储后的解码）共用，**不碰策略、不碰存储**。
 */

import { checkCommandShape } from '../command.js';
import { jsonDeepEqual, type DocumentJournal } from '../journal.js';
import { CURRENT_DOCUMENT_VERSION, validateDocument, type ProjectDocument } from '../schema.js';
import { isRecord } from '../wbs.js';
import type { DocumentCommand } from '../command.js';
import type { SessionStep } from '../session.js';
import {
  failure,
  type PersistResult,
  type RestoreCandidates,
  type StoredSession,
  type StoredSnapshot,
  type StoredStep,
} from './types.js';

export function checkRestorableDocument(document: unknown): string | null {
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
export function checkStep(step: unknown, label: string): PersistResult<SessionStep> {
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

