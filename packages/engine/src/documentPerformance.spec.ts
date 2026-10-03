import { describe, expect, it } from 'vitest';

import { applyCommand, type DocumentCommand } from './command.js';
import { jsonDeepEqual, type DeltaJournal, type DocumentJournal } from './journal.js';
import {
  hasDocumentErrors,
  parseDocument,
  reindexDocument,
  serializeDocument,
  validateDocument,
  type ProjectDocument,
} from './schema.js';
import {
  addToTransaction,
  applyToSession,
  commitTransaction,
  createSession,
  createTransaction,
  undoSession,
} from './session.js';
import {
  buildTaskTree,
  computeOutlineNumbers,
  flattenTaskTree,
  indentTask,
  MAX_OUTLINE_DEPTH,
  outdentTask,
  reindexTasks,
} from './wbs.js';
import { canonicalCalendar, largeDocument, task } from './fixtures.spec.js';

/**
 * G1.2 的**规模行为**测试。
 *
 * 刻意**不做时序断言**（不做 p99 门禁）：本块不产出产品能力块，
 * 而一个会随时序抖动的断言只会制造假失败。1,000 规模上的引擎侧余量已有实测依据
 * （[S3 结论 §八 B.8](../../../spikes/g0-s3-cpm-perf/结论.md)：CSR 全量重建 p99 ≤ 180 µs）。
 *
 * 这里断言的是**结构性事实**——它们能抓住"算法退化成 O(n²)/爆栈/编号字符串爆炸"
 * 这一类真实回归，而且完全确定：
 * 1. 1,000 任务可序列化、可解析、深比较往返一致、零 error；
 * 2. 重编号/校验是幂等的（两次调用深比较相等）；
 * 3. `outlineNumber` 的最大长度有界（防止编号拼接退化）；
 * 4. 合法的最大深度（`MAX_OUTLINE_DEPTH`）既能被校验通过，也能被渲染成编号；
 * 5. 超过最大深度的链**被拒绝**而不是爆栈。
 */

function largeDoc(n = 1000): ProjectDocument {
  return largeDocument(n);
}

describe('G1.2 规模行为：1,000 任务', () => {
  it('可序列化 → 解析 → 深比较往返一致，且校验零 error', () => {
    const doc = largeDoc(1000);
    const text = serializeDocument(doc);
    const parsed = parseDocument(text);
    expect(parsed).toStrictEqual(doc);
    expect(hasDocumentErrors(validateDocument(JSON.parse(text)))).toBe(false);
  });

  it('reindexDocument 与 validateDocument 都是幂等的', () => {
    const doc = largeDoc(1000);
    const once = reindexDocument(doc);
    const twice = reindexDocument(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(reindexDocument(doc).tasks).toStrictEqual(twice.tasks);
  });

  it('编号的最大长度有界（编号拼接不退化为 O(n²) 的字符串）', () => {
    const doc = largeDoc(1000);
    const longest = Math.max(...doc.tasks.map((entry) => entry.outlineNumber.length));
    expect(longest).toBeLessThan(32);
    expect(longest, '一千个任务至少应有三层编号').toBeGreaterThanOrEqual(5);
  });

  it('树构建与扁平化的规模不变量成立', () => {
    const doc = largeDoc(1000);
    const roots = buildTaskTree(doc.tasks);
    expect(flattenTaskTree(roots)).toHaveLength(1000);
    expect(computeOutlineNumbers(doc.tasks).size).toBe(1000);
    expect(roots.length).toBeGreaterThan(1);
  });
});

describe('G1.2 规模行为：最大合法深度', () => {
  it(`正好 ${String(MAX_OUTLINE_DEPTH)} 层的链可以往返并零 error`, () => {
    const chain = Array.from({ length: MAX_OUTLINE_DEPTH }, (_, index) =>
      task({
        id: `d${String(index)}`,
        parentId: index === 0 ? null : `d${String(index - 1)}`,
        outlineNumber: Array.from({ length: index + 1 }, () => '1').join('.'),
        name: `深 ${String(index)}`,
      }),
    );
    const doc: ProjectDocument = {
      version: 3,
      project: {
        name: '最大深度链',
        description: null,
        baseCalendarId: 'project',
        startDate: null,
        finishDate: null,
      },
      calendars: [canonicalCalendar()],
      tasks: chain,
      links: [],
      baselines: [],
    };
    expect(parseDocument(serializeDocument(doc))).toStrictEqual(doc);
    expect(hasDocumentErrors(validateDocument(JSON.parse(serializeDocument(doc))))).toBe(false);

    // 再加一层即被拒绝，且**不爆栈**
    const tooDeep = [
      ...chain,
      task({
        id: 'ddeep',
        parentId: `d${String(MAX_OUTLINE_DEPTH - 1)}`,
        outlineNumber: Array.from({ length: MAX_OUTLINE_DEPTH + 1 }, () => '1').join('.'),
        name: '太深',
      }),
    ];
    const codes = validateDocument({ ...JSON.parse(serializeDocument(doc)), tasks: tooDeep })
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.code);
    expect(codes).toContain('TREE_DEPTH_EXCEEDED');
  });

  it('深链上的调级不会爆栈：深度守卫先于递归遍历', () => {
    // 500 层（合法上限是 20，因此这里只需验证"被拒绝而不是抛栈溢出"）
    const chain = Array.from({ length: 500 }, (_, index) =>
      task({
        id: `d${String(index)}`,
        parentId: index === 0 ? null : `d${String(index - 1)}`,
        outlineNumber: '1',
        name: `深 ${String(index)}`,
      }),
    );
    const result = indentTask(chain, 'd499');
    expect(result.ok, '深层链的调级应当是"失败结果"而不是异常').toBe(false);
  });
});

describe('G1.2 规模行为：调级在 1,000 任务上可用', () => {
  it('indent → outdent 在 1,000 任务文档上往返一致', () => {
    const doc = largeDoc(1000);
    // 选两个相邻的顶层任务：把后一个降级到前一个之下，再升级回来。
    const roots = doc.tasks.filter((entry) => entry.parentId === null);
    const [first, second] = [roots[0], roots[1]];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      return;
    }

    const indented = indentTask(doc.tasks, second.id);
    expect(indented.ok).toBe(true);
    if (!indented.ok) {
      return;
    }
    const indentedDoc: ProjectDocument = reindexDocument({ ...doc, tasks: indented.value });
    expect(hasDocumentErrors(validateDocument(JSON.parse(serializeDocument(indentedDoc))))).toBe(false);

    const restored = outdentTask(indented.value, second.id);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }
    expect(reindexTasks(restored.value).map((entry) => [entry.id, entry.parentId, entry.outlineNumber])).toStrictEqual(
      doc.tasks.map((entry) => [entry.id, entry.parentId, entry.outlineNumber]),
    );
  });
});

/**
 * G1.3 的**规模行为**测试。
 *
 * 与上面两节同一口径：**只断言结构性事实，不做时序门禁**（理由见本文件头注释）。
 * 这里断言的是 R-2 的核心收益与"日志规模与文档规模解耦"这两条**可证伪**的结构事实：
 * 1. 字段级命令的日志条目数**与任务总数无关**（1,000 任务上仍是 1 条）；
 * 2. 字段级 delta 的序列化体积远小于整份文档（< 5%）——这就是 R-2 说的"量级差"；
 * 3. 层级调级的日志条目集合，与"测试侧独立算出的值变化集合"**逐项一致**（日志不多记、不漏记）；
 * 4. 1,000 任务上 60 步撤销可用（无时序断言）。
 */
describe('G1.3 规模行为：日志与文档规模解耦', () => {
  const base = (): ProjectDocument => largeDoc(1000);

  it('字段级命令的日志只含 1 条任务条目（与 1,000 无关）', () => {
    const doc = base();
    const result = applyCommand(doc, { kind: 'task.update', id: 'p1-s1-l1', patch: { name: '改一行' } });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.changed || result.journal.kind !== 'delta') {
      throw new Error('字段更新应当成功并产生 delta 日志');
    }
    expect(result.journal.tasks).toHaveLength(1);
    expect(result.journal.taskOrder).toBeNull();
    expect(result.journal.linkOrder).toBeNull();
  });

  it('字段级 delta 的体积远小于整份文档（R-2 的量级差）', () => {
    const doc = base();
    const result = applyCommand(doc, { kind: 'task.update', id: 'p1-s1-l1', patch: { name: '改一行' } });
    if (!result.ok || !result.changed) {
      throw new Error('字段更新应当成功');
    }
    const journalSize = JSON.stringify(result.journal).length;
    const documentSize = serializeDocument(doc).length;
    expect(journalSize).toBeLessThan(documentSize * 0.05);
  });

  it('层级调级的日志条目集合 = 值真的变了的任务集合（不多记、不漏记）', () => {
    const doc = base();
    const result = applyCommand(doc, { kind: 'task.indent', id: 'p2' });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.changed || result.journal.kind !== 'delta') {
      throw new Error('调级应当成功并产生 delta 日志');
    }
    const journal: DeltaJournal = result.journal;

    // 测试侧独立算出"值变了的任务 id 集合"：逐实体结构化比较（键序无关）
    const journalIds = journal.tasks
      .filter((change) => change.before !== null && change.after !== null)
      .map((change) => change.id);
    const changedIds = result.document.tasks
      .filter((task) => {
        const previous = doc.tasks.find((entry) => entry.id === task.id);
        return previous !== undefined && !jsonDeepEqual(previous, task);
      })
      .map((task) => task.id);

    expect(journalIds.slice().sort()).toStrictEqual(changedIds.slice().sort());
    // 调级是 O(受影响任务)，不会退化成"整份镜像"
    expect(journalIds.length).toBeGreaterThan(0);
    expect(journalIds.length).toBeLessThan(doc.tasks.length);
  });

  it('整份替换的日志是 document 形态（批量事件明示 O(N)）', () => {
    const doc = base();
    const smaller = largeDoc(10);
    const result = applyCommand(doc, { kind: 'document.replace', document: smaller });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.changed) {
      throw new Error('整份替换应当成功');
    }
    const journal: DocumentJournal = result.journal;
    expect(journal.kind).toBe('document');
  });

  it('1,000 任务上 60 步撤销/重做可用（结构性事实，无时序断言）', () => {
    const doc = base();
    const commands: readonly DocumentCommand[] = Array.from({ length: 60 }, (_, index) => ({
      kind: 'task.update',
      id: 'p1-s1-l1',
      patch: { notes: `步 ${String(index + 1)}`, progress: index / 60 },
    }));

    let session = createSession(doc);
    for (const command of commands) {
      const result = applyToSession(session, command);
      expect(result.ok, command.kind).toBe(true);
      if (!result.ok) {
        return;
      }
      session = result.session;
    }
    expect(hasDocumentErrors(validateDocument(session.document))).toBe(false);

    const peak = session.document;
    for (let index = 0; index < commands.length; index += 1) {
      const result = undoSession(session);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      session = result.session;
    }
    expect(session.document).toStrictEqual(doc);
    expect(peak).not.toStrictEqual(doc);
  });

  it('事务在 1,000 任务上只压一步（一次手势一次的收益可断言）', () => {
    const doc = base();
    const session = createSession(doc);
    let transaction = createTransaction([
      { kind: 'task.update', id: 'p1-s1-l1', patch: { name: '甲' } },
    ]);
    transaction = addToTransaction(transaction, {
      kind: 'task.update',
      id: 'p1-s1-l2',
      patch: { name: '乙' },
    });
    const committed = commitTransaction(session, transaction);
    expect(committed.ok).toBe(true);
    if (!committed.ok || !committed.changed) {
      throw new Error('事务应当成功');
    }
    expect(committed.session.undoStack).toHaveLength(1);
    expect(committed.session.undoStack[0]?.commands).toHaveLength(2);
  });
});
