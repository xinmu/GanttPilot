import { describe, expect, it } from 'vitest';

import { applyCommand } from './command.js';
import {
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
  type DocumentJournal,
} from './journal.js';
import { flatDocument, wbsDocument } from './fixtures.spec.js';

/**
 * G1.3 的**日志（before 镜像）**单测。
 *
 * 判据分四层：
 * 1. **代数律**：对合（`invert` 两次回到原日志）、往返（正逆两个方向都能精确还原）、空日志无操作；
 * 2. **引用纪律**：日志值 clone-then-freeze、与输入/输出文档**零共享引用**、
 *    构造日志后改写源文档不影响回滚（这正是 G1.3 出口条件第 3 条要防的失败模式）；
 * 3. **守卫有牙**：过期日志必须被 `RangeError` 拒绝，而不是静默产出错误文档；
 * 4. **负向对照**：证明上述判据不是恒真式（日志条目承重、逆操作承重）。
 */

function updatedJournal(): {
  readonly base: ReturnType<typeof wbsDocument>;
  readonly document: ReturnType<typeof wbsDocument>;
  readonly journal: DocumentJournal;
} {
  const base = wbsDocument();
  const result = applyCommand(base, {
    kind: 'task.update',
    id: 'w1a1',
    patch: { name: '冻结检查', progress: 0.5 },
  });
  if (!result.ok || !result.changed) {
    throw new Error('夹具命令应当成功且产生变更');
  }
  return { base, document: result.document, journal: result.journal };
}

describe('G1.3 日志：代数律', () => {
  it('invert 是对合：两次取逆深比较等于原日志（delta 与 document 两种形态）', () => {
    const base = wbsDocument();
    const delta = diffDocument(base, { ...base, project: { ...base.project, name: '改名' } });
    expect(delta.kind).toBe('delta');
    expect(invertDocumentJournal(invertDocumentJournal(delta))).toStrictEqual(delta);

    const bulk = createBulkJournal(base, flatDocument());
    expect(bulk.kind).toBe('document');
    expect(invertDocumentJournal(invertDocumentJournal(bulk))).toStrictEqual(bulk);
  });

  it('往返律：正逆两个方向都能精确还原（含 WBS 调级与跨字段变更）', () => {
    const base = wbsDocument();
    const cases = [
      { kind: 'task.update', id: 'w1a1', patch: { name: '改', progress: 0.5, notes: 'n' } },
      { kind: 'task.indent', id: 'w1b' },
      { kind: 'task.move', id: 'w2a', target: { parentId: 'w1', afterTaskId: 'w1a1' } },
      { kind: 'link.remove', id: 'l1' },
      { kind: 'project.update', patch: { name: '项目改名' } },
    ] as const;

    for (const command of cases) {
      const result = applyCommand(base, command);
      expect(result.ok, command.kind).toBe(true);
      if (!result.ok || !result.changed) {
        throw new Error(`${command.kind} 应当成功且产生变更`);
      }
      const journal = result.journal;
      const inverse = invertDocumentJournal(journal);
      // 逆向：撤销后必须逐项回到变更前
      const undoed = applyDocumentJournal(result.document, inverse);
      expect(undoed, command.kind).toStrictEqual(base);
      // 正向：撤销后再应用原日志，必须逐项回到变更后
      expect(applyDocumentJournal(undoed, journal), command.kind).toStrictEqual(result.document);
    }
  });

  it('负向对照：逆操作是承重的——正逆两个方向必须得到不同文档', () => {
    const base = wbsDocument();
    const result = applyCommand(base, { kind: 'task.update', id: 'w1b', patch: { name: '承重' } });
    if (!result.ok || !result.changed) {
      throw new Error('夹具命令应当成功');
    }
    const forward = applyDocumentJournal(base, result.journal);
    const backward = applyDocumentJournal(result.document, invertDocumentJournal(result.journal));
    expect(forward).toStrictEqual(result.document);
    expect(backward).toStrictEqual(base);
    // 若"取逆"其实什么都没做，两者就会相等——因此这条断言证明逆操作是承重的
    expect(forward).not.toStrictEqual(backward);
  });

  it('负向对照：抽掉日志条目就会漏掉变更（每条条目都是承重的）', () => {
    const { base, document, journal } = updatedJournal();
    if (journal.kind !== 'delta') {
      throw new Error('应当得到 delta 日志');
    }
    const crippled: DocumentJournal = { ...journal, tasks: [] };
    expect(applyDocumentJournal(base, crippled)).not.toStrictEqual(document);
  });

  it('空日志：无操作，且 isJournalEmpty 只对真正的空日志为真', () => {
    const base = wbsDocument();
    const empty = diffDocument(base, base);
    expect(isJournalEmpty(empty)).toBe(true);
    expect(applyDocumentJournal(base, empty)).toStrictEqual(base);
    expect(invertDocumentJournal(empty)).toStrictEqual(empty);

    const changed = diffDocument(base, { ...base, project: { ...base.project, name: 'X' } });
    expect(isJournalEmpty(changed)).toBe(false);
    expect(isJournalEmpty(createBulkJournal(base, flatDocument()))).toBe(false);
  });
});

describe('G1.3 日志：引用纪律（防止共享可变对象）', () => {
  it('日志值就地深冻结（含嵌套的 constraints 数组）', () => {
    const { journal } = updatedJournal();
    if (journal.kind !== 'delta') {
      throw new Error('应当得到 delta 日志');
    }
    const change = journal.tasks[0];
    if (change === undefined) {
      throw new Error('日志应当有任务条目');
    }

    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change.before)).toBe(true);
    expect(Object.isFrozen(change.after)).toBe(true);
    expect(Object.isFrozen(change.after?.constraints)).toBe(true);
    expect(() => {
      (change.after as unknown as { name: string }).name = '试图改写';
    }).toThrow(TypeError);
  });

  it('日志与输入/输出文档零共享引用，且**不冻结调用方的文档**', () => {
    const { base, document, journal } = updatedJournal();
    if (journal.kind !== 'delta') {
      throw new Error('应当得到 delta 日志');
    }
    const change = journal.tasks[0];
    if (change === undefined || change.before === null || change.after === null) {
      throw new Error('日志条目应当是"改前改后"');
    }

    const sourceTask = base.tasks.find((task) => task.id === 'w1a1');
    const storedTask = document.tasks.find((task) => task.id === 'w1a1');
    expect(change.before).not.toBe(sourceTask);
    expect(change.after).not.toBe(storedTask);

    // 引擎绝不冻结调用方的文档（否则会污染 apps/web 的响应式）
    expect(Object.isFrozen(base)).toBe(false);
    expect(Object.isFrozen(base.tasks)).toBe(false);
    expect(Object.isFrozen(base.tasks[0])).toBe(false);
    expect(Object.isFrozen(document)).toBe(false);
  });

  it('project 镜像同样不冻结调用方的 project 对象（实测踩到过的漏洞）', () => {
    const base = wbsDocument();
    const result = applyCommand(base, { kind: 'project.update', patch: { name: '改名' } });
    if (!result.ok || !result.changed || result.journal.kind !== 'delta') {
      throw new Error('项目更新应当成功并产生 delta 日志');
    }
    const change = result.journal.project;
    expect(change).not.toBeNull();
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change?.before)).toBe(true);

    // 调用方的 project / 文档未被冻结，且日志与它们零共享引用
    expect(Object.isFrozen(base.project)).toBe(false);
    expect(Object.isFrozen(result.document.project)).toBe(false);
    expect(change?.before).not.toBe(base.project);
    expect(change?.after).not.toBe(result.document.project);
  });

  it('构造日志后改写源文档的对象，回滚仍然还原**原值**（否则就是共享引用）', () => {
    const { base, document, journal } = updatedJournal();
    const sourceTask = base.tasks.find((task) => task.id === 'w1a1');
    if (sourceTask === undefined) {
      throw new Error('夹具应当有 w1a1');
    }
    const originalName = sourceTask.name;

    // 模拟"调用方持有旧文档并就地改写"：日志里的 before 必须是独立副本
    (sourceTask as unknown as { name: string }).name = '被外部改坏';

    const undone = applyDocumentJournal(document, invertDocumentJournal(journal));
    expect(undone.tasks.find((task) => task.id === 'w1a1')?.name).toBe(originalName);
    expect(undone.tasks.find((task) => task.id === 'w1a1')?.name).not.toBe('被外部改坏');
  });

  it('应用日志写出的是新鲜（未冻结）克隆', () => {
    const { base, journal } = updatedJournal();
    const next = applyDocumentJournal(base, journal);
    expect(Object.isFrozen(next)).toBe(false);
    expect(next.tasks.every((task) => !Object.isFrozen(task))).toBe(true);
  });
});

describe('G1.3 日志：守卫、序列化与作用域', () => {
  it('守卫有牙：过期日志（与当前文档不符）被 RangeError 拒绝，而非静默产出错误文档', () => {
    const { base, document, journal } = updatedJournal();
    expect(() => applyDocumentJournal(document, journal)).toThrow(RangeError);
    expect(() => applyDocumentJournal(base, invertDocumentJournal(journal))).toThrow(RangeError);
  });

  it('守卫有牙：taskOrder 的 id 集与实体集不符时抛错', () => {
    const { base } = updatedJournal();
    // **只让 taskOrder 不符**：`linkOrder` 必须与实体一致，否则这条用例可能由另一条守卫先抛错，
    // 断言虽绿但测的不是它（P3/C7-b 把 spec 纳入 tsc 时发现这里少写了一个必填字段）。
    const linkIds = base.links.map((link) => link.id);
    const broken: DocumentJournal = {
      kind: 'delta',
      project: null,
      tasks: [],
      links: [],
      taskOrder: { before: base.tasks.map((task) => task.id), after: ['w1'] },
      linkOrder: { before: linkIds, after: linkIds },
    };
    expect(() => applyDocumentJournal(base, broken)).toThrow(RangeError);
  });

  it('日志可 JSON 往返：往返后的日志应用结果与原来逐项一致', () => {
    const { base, document, journal } = updatedJournal();
    const parsed = JSON.parse(JSON.stringify(journal)) as DocumentJournal;
    expect(parsed).toStrictEqual(journal);
    expect(applyDocumentJournal(base, parsed)).toStrictEqual(document);
    expect(applyDocumentJournal(document, invertDocumentJournal(parsed))).toStrictEqual(base);
  });

  it('journalScope 如实报告影响范围（细粒度 vs 整份替换）', () => {
    const { journal } = updatedJournal();
    const scope = journalScope(journal);
    expect(scope.wholeDocument).toBe(false);
    expect(scope.taskIds).toStrictEqual(['w1a1']);
    expect(scope.linkIds).toStrictEqual([]);
    expect(scope.projectChanged).toBe(false);
    expect(scope.taskOrderChanged).toBe(false);

    const base = wbsDocument();
    const bulk = journalScope(createBulkJournal(base, flatDocument()));
    expect(bulk.wholeDocument).toBe(true);
    expect(bulk.taskIds).toStrictEqual(flatDocument().tasks.map((task) => task.id));
  });

  it('顺序变更会被表达成 taskOrder（值变化之外的第二类变更）', () => {
    const base = wbsDocument();
    const result = applyCommand(base, { kind: 'task.move', id: 'w2', target: { parentId: null, index: 0 } });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.changed || result.journal.kind !== 'delta') {
      throw new Error('移动应当成功并产生 delta 日志');
    }
    const order = result.journal.taskOrder;
    expect(order).not.toBeNull();
    expect(order?.before).toStrictEqual(base.tasks.map((task) => task.id));
    expect(order?.after[0]).toBe('w2');
    expect(applyDocumentJournal(result.document, invertDocumentJournal(result.journal))).toStrictEqual(
      base,
    );
  });

  it('依赖边的顺序也被记录：删边后回滚必须回到原位置（不是追加到末尾）', () => {
    const base = wbsDocument();
    const removed = applyCommand(base, { kind: 'link.remove', id: 'l1' });
    expect(removed.ok).toBe(true);
    if (!removed.ok || !removed.changed || removed.journal.kind !== 'delta') {
      throw new Error('删边应当成功并产生 delta 日志');
    }
    expect(removed.journal.linkOrder).not.toBeNull();
    const undone = applyDocumentJournal(removed.document, invertDocumentJournal(removed.journal));
    expect(undone.links.map((link) => link.id)).toStrictEqual(base.links.map((link) => link.id));
    expect(undone).toStrictEqual(base);
  });
});

describe('G1.3 日志：JSON 值守卫', () => {
  it('findNonJsonValue 精确指出第一处非 JSON 值', () => {
    expect(findNonJsonValue({ a: [1, 'x', null, true, { b: 2 }] })).toBeNull();
    expect(findNonJsonValue({ a: Number.NaN })).toContain('非有限数字');
    expect(findNonJsonValue({ a: { b: undefined } })).toContain('非 JSON 值');
    expect(findNonJsonValue({ a: () => 1 })).toContain('非 JSON 值');
    expect(findNonJsonValue(new Date())).toContain('非普通对象');
    expect(findNonJsonValue({ a: 1n })).toContain('非 JSON 值');

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(findNonJsonValue(cyclic)).toContain('循环引用');
    expect(findNonJsonValue({ a: { b: [cyclic] } }, 'payload')).toContain(
      '`payload.a.b[0].self` 含循环引用',
    );
  });

  it('cloneJsonValue 深拷贝（零共享引用）并拒绝非 JSON 值', () => {
    const source = { a: { b: [1, 2] }, c: null };
    const copy = cloneJsonValue(source);
    expect(copy).toStrictEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.a).not.toBe(source.a);
    expect(copy.a.b).not.toBe(source.a.b);

    expect(() => cloneJsonValue({ a: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => cloneJsonValue(cyclic)).toThrow(RangeError);
  });

  it('deepFreezeJson 逐层冻结且可重复调用（幂等）', () => {
    const value = deepFreezeJson({ a: { b: 1 }, c: [1, { d: 2 }] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.c)).toBe(true);
    expect(Object.isFrozen(value.c[1])).toBe(true);
    expect(deepFreezeJson(value)).toBe(value);
  });

  it('jsonDeepEqual 键序无关、且能识别多/少键', () => {
    expect(jsonDeepEqual({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonDeepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonDeepEqual(null, null)).toBe(true);
    expect(jsonDeepEqual(1, '1')).toBe(false);
  });
});
