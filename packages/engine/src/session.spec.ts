import { describe, expect, it } from 'vitest';

import { applyCommand, parseCommand, serializeCommand, type DocumentCommand } from './command.js';
import { applyDocumentJournal, deepFreezeJson, invertDocumentJournal } from './journal.js';
import { hasDocumentErrors, validateDocument, type ProjectDocument } from './schema.js';
import {
  addToTransaction,
  applyToSession,
  commitTransaction,
  createSession,
  createTransaction,
  redoSession,
  undoSession,
  type DocumentSession,
} from './session.js';
import { commandBaseDocument, commandSequence, longCommandSequence } from './commandFixtures.spec.js';

/**
 * G1.3 的**会话与事务**单测（IX-03 的落地判据）。
 *
 * 关键判据：
 * 1. 应用 N 条命令后撤销 N 条 → 文档回到初始状态的**深比较相等**（含 WBS 调级与跨字段变更）；
 * 2. LIFO 语义正确、重做按原顺序恢复、新命令清空 redo 栈；
 * 3. 事务**原子**（任一成员失败则会话完全不变）且**整体**（一次 Ctrl+Z 回退整次手势）；
 * 4. 会话/文档都是不可变值（入参被深冻结也能正常工作）；
 * 5. **负向对照**：精确还原靠的是 LIFO 栈与日志守卫，不是"日志可以随便重复应用"。
 */

/** 按序应用到会话；任一步失败即抛错（测试应当立刻暴露）。 */
function runAll(document: ProjectDocument, commands: readonly DocumentCommand[]): DocumentSession {
  let session = createSession(document);
  for (const command of commands) {
    const result = applyToSession(session, command);
    if (!result.ok) {
      throw new Error(`命令应用失败：${command.kind} ${result.code}`);
    }
    expect(result.changed, `${command.kind} 应当产生变更`).toBe(true);
    session = result.session;
  }
  return session;
}

describe('G1.3 会话：应用 / 撤销 / 重做', () => {
  it('一次应用 → 撤销 → 重做：文档与 revision 的变化符合约定', () => {
    const base = commandBaseDocument();
    const start = createSession(base);
    expect(start.revision).toBe(0);
    expect(start.undoStack).toHaveLength(0);

    const applied = applyToSession(start, { kind: 'task.update', id: 'w1b', patch: { name: '改名' } });
    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.changed) {
      throw new Error('应当成功且产生变更');
    }
    expect(applied.session.document).not.toStrictEqual(base);
    expect(applied.session.revision).toBe(1);
    expect(applied.session.undoStack).toHaveLength(1);
    expect(applied.session.redoStack).toHaveLength(0);
    // 入参会话未被改写
    expect(start.document).toBe(base);
    expect(start.undoStack).toHaveLength(0);

    const undone = undoSession(applied.session);
    expect(undone.ok).toBe(true);
    if (!undone.ok) {
      return;
    }
    expect(undone.session.document).toStrictEqual(base);
    expect(undone.session.revision).toBe(2);
    expect(undone.session.undoStack).toHaveLength(0);
    expect(undone.session.redoStack).toHaveLength(1);

    const redone = redoSession(undone.session);
    expect(redone.ok).toBe(true);
    if (!redone.ok) {
      return;
    }
    expect(redone.session.document).toStrictEqual(applied.session.document);
    expect(redone.session.revision).toBe(3);
    expect(redone.session.undoStack).toHaveLength(1);
    expect(redone.session.redoStack).toHaveLength(0);
  });

  it('栈空时给出稳定的失败码', () => {
    const session = createSession(commandBaseDocument());
    const undo = undoSession(session);
    expect(undo.ok).toBe(false);
    if (!undo.ok) {
      expect(undo.code).toBe('SESSION_NOTHING_TO_UNDO');
    }
    const redo = redoSession(session);
    expect(redo.ok).toBe(false);
    if (!redo.ok) {
      expect(redo.code).toBe('SESSION_NOTHING_TO_REDO');
    }
  });

  it('无操作命令不压栈、不清空 redo 栈', () => {
    const base = commandBaseDocument();
    const applied = applyToSession(createSession(base), {
      kind: 'task.update',
      id: 'w1b',
      patch: { name: '有变化' },
    });
    if (!applied.ok || !applied.changed) {
      throw new Error('前置应用应当成功');
    }
    const undone = undoSession(applied.session);
    if (!undone.ok) {
      throw new Error('撤销应当成功');
    }
    // 撤销后 redo 栈有一步；此时提交一条"无实际变化"的命令不该把它清掉
    const noop = applyToSession(undone.session, {
      kind: 'task.update',
      id: 'w1b',
      patch: { name: base.tasks.find((item) => item.id === 'w1b')?.name ?? '' },
    });
    expect(noop.ok).toBe(true);
    if (!noop.ok) {
      return;
    }
    expect(noop.changed).toBe(false);
    expect(noop.session.redoStack).toHaveLength(1);
    expect(noop.session).toBe(undone.session);
  });

  it('新命令清空 redo 栈（分支后不能重做旧分支）', () => {
    const base = commandBaseDocument();
    const applied = applyToSession(createSession(base), { kind: 'task.indent', id: 'w1b' });
    if (!applied.ok || !applied.changed) {
      throw new Error('前置应用应当成功');
    }
    const undone = undoSession(applied.session);
    if (!undone.ok) {
      throw new Error('撤销应当成功');
    }
    expect(undone.session.redoStack).toHaveLength(1);

    const branched = applyToSession(undone.session, { kind: 'task.outdent', id: 'w1a1' });
    expect(branched.ok).toBe(true);
    if (!branched.ok) {
      return;
    }
    expect(branched.session.redoStack).toHaveLength(0);
    expect(branched.session.undoStack).toHaveLength(1);
  });

  it('失败命令不改动会话（含栈）', () => {
    const base = commandBaseDocument();
    const session = createSession(base);
    const result = applyToSession(session, { kind: 'task.update', id: 'nope', patch: { name: 'x' } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('CMD_TASK_NOT_FOUND');
    expect(session.document).toBe(base);
    expect(session.undoStack).toHaveLength(0);
  });
});

describe('G1.3 会话：≥50 步的逐步撤销与重做（出口条件的核心判据）', () => {
  it('应用 70 条命令 → 撤销 70 条回到初始态 → 重做 70 条回到峰值态', () => {
    const base = commandBaseDocument();
    const commands = longCommandSequence(60);
    expect(commands.length).toBeGreaterThanOrEqual(50);

    let session = runAll(base, commands);
    const peak = session.document;
    expect(session.undoStack).toHaveLength(commands.length);
    expect(session.revision).toBe(commands.length);
    expect(hasDocumentErrors(validateDocument(peak))).toBe(false);

    for (let step = 0; step < commands.length; step += 1) {
      const result = undoSession(session);
      expect(result.ok, `第 ${String(step + 1)} 次撤销应当成功`).toBe(true);
      if (!result.ok) {
        return;
      }
      session = result.session;
    }
    expect(session.document).toStrictEqual(base);
    expect(session.undoStack).toHaveLength(0);
    expect(session.redoStack).toHaveLength(commands.length);

    for (let step = 0; step < commands.length; step += 1) {
      const result = redoSession(session);
      expect(result.ok, `第 ${String(step + 1)} 次重做应当成功`).toBe(true);
      if (!result.ok) {
        return;
      }
      session = result.session;
    }
    expect(session.document).toStrictEqual(peak);
    expect(session.undoStack).toHaveLength(commands.length);
    expect(session.redoStack).toHaveLength(0);
  });

  it('逐步撤销：每一步都回到对应的中间态（LIFO 顺序正确）', () => {
    const base = commandBaseDocument();
    const commands = longCommandSequence(5);
    const states: ProjectDocument[] = [base];
    let session = createSession(base);
    for (const command of commands) {
      const result = applyToSession(session, command);
      if (!result.ok) {
        throw new Error(result.message);
      }
      session = result.session;
      states.push(session.document);
    }

    for (let index = states.length - 2; index >= 0; index -= 1) {
      const result = undoSession(session);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      session = result.session;
      expect(session.document, `撤销到第 ${String(index)} 个中间态`).toStrictEqual(states[index]);
    }

    for (let index = 1; index < states.length; index += 1) {
      const result = redoSession(session);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      session = result.session;
      expect(session.document, `重做到第 ${String(index)} 个中间态`).toStrictEqual(states[index]);
    }
  });

  it('覆盖全部命令类型的序列也能整体撤销回初始态', () => {
    const base = commandBaseDocument();
    const commands = commandSequence();
    const session = runAll(base, commands);
    let current = session;
    for (let index = 0; index < commands.length; index += 1) {
      const result = undoSession(current);
      if (!result.ok) {
        throw new Error(result.message);
      }
      current = result.session;
    }
    expect(current.document).toStrictEqual(base);
  });
});

describe('G1.3 会话：事务（一次手势 = 一个撤销单元）', () => {
  it('事务的全部成员成功时只压一步，一次撤销即回退整次手势', () => {
    const base = commandBaseDocument();
    const session = createSession(base);
    const transaction = createTransaction([
      { kind: 'task.update', id: 'w1a1', patch: { name: '事务内改 A', progress: 0.4 } },
      { kind: 'task.update', id: 'w1b', patch: { name: '事务内改 B' } },
      { kind: 'task.indent', id: 'w1b' },
    ]);

    const committed = commitTransaction(session, transaction);
    expect(committed.ok).toBe(true);
    if (!committed.ok || !committed.changed) {
      throw new Error('事务应当成功且产生变更');
    }
    expect(committed.session.undoStack).toHaveLength(1);
    expect(committed.session.document.tasks.find((item) => item.id === 'w1a1')?.name).toBe('事务内改 A');
    expect(committed.session.document.tasks.find((item) => item.id === 'w1b')?.parentId).toBe('w1a');
    expect(hasDocumentErrors(validateDocument(committed.session.document))).toBe(false);

    const undone = undoSession(committed.session);
    expect(undone.ok).toBe(true);
    if (!undone.ok) {
      return;
    }
    expect(undone.session.document).toStrictEqual(base);
  });

  it('事务原子：任一成员失败则会话完全不变，并指出失败下标', () => {
    const base = commandBaseDocument();
    const session = createSession(base);
    const failing = createTransaction([
      { kind: 'task.update', id: 'w1a1', patch: { name: '不应生效' } },
      { kind: 'task.update', id: 'w1b', patch: { name: '也不应生效' } },
      { kind: 'link.insert', link: { id: 'l9', from: 'w1b', to: 'nope', type: 'SS', lagDays: 1 } },
    ]);

    const result = commitTransaction(session, failing);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('CMD_LINK_ENDPOINT_NOT_FOUND');
    expect(result.failedIndex).toBe(2);
    expect(session.document).toBe(base);
    expect(session.undoStack).toHaveLength(0);
    expect(session.revision).toBe(0);
  });

  it('空事务与"净效果为空"的事务都是无操作', () => {
    const base = commandBaseDocument();
    const session = createSession(base);

    const empty = commitTransaction(session, createTransaction());
    expect(empty.ok).toBe(true);
    if (!empty.ok) {
      return;
    }
    expect(empty.changed).toBe(false);
    expect(empty.session).toBe(session);

    const originalName = base.tasks.find((item) => item.id === 'w1b')?.name ?? '';
    const cancelled = commitTransaction(
      session,
      createTransaction([
        { kind: 'task.update', id: 'w1b', patch: { name: '中间态' } },
        { kind: 'task.update', id: 'w1b', patch: { name: originalName } },
      ]),
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) {
      return;
    }
    expect(cancelled.changed).toBe(false);
    expect(cancelled.session).toBe(session);
  });

  it('单命令事务等价于直接应用该命令（整份替换保留整份文档镜像）', () => {
    const base = commandBaseDocument();
    const session = createSession(base);
    const command: DocumentCommand = { kind: 'task.outdent', id: 'w1a1' };
    const viaTransaction = commitTransaction(session, createTransaction([command]));
    const viaApply = applyToSession(session, command);
    expect(viaTransaction.ok).toBe(true);
    expect(viaApply.ok).toBe(true);
    if (!viaTransaction.ok || !viaApply.ok) {
      return;
    }
    expect(viaTransaction.session.document).toStrictEqual(viaApply.session.document);
    if (!viaTransaction.changed || !viaApply.changed) {
      throw new Error('两条路径都应当产生变更');
    }
    expect(viaTransaction.session.undoStack[0]?.journal).toStrictEqual(
      viaApply.session.undoStack[0]?.journal,
    );
  });

  it('事务可以在拖拽过程中逐步累积（不可变值）', () => {
    const base = commandBaseDocument();
    let transaction = createTransaction();
    transaction = addToTransaction(transaction, { kind: 'task.update', id: 'w1b', patch: { name: '甲' } });
    transaction = addToTransaction(transaction, { kind: 'task.update', id: 'w1b', patch: { name: '乙' } });
    expect(transaction.commands).toHaveLength(2);

    const committed = commitTransaction(createSession(base), transaction);
    expect(committed.ok).toBe(true);
    if (!committed.ok || !committed.changed) {
      throw new Error('事务应当成功');
    }
    expect(committed.session.document.tasks.find((item) => item.id === 'w1b')?.name).toBe('乙');
    expect(committed.session.undoStack).toHaveLength(1);
  });
});

describe('G1.3 会话：不可变性、确定性与负向对照', () => {
  it('深冻结的会话也能被继续编辑（不可变值语义）', () => {
    const base = commandBaseDocument();
    const session = deepFreezeJson(createSession(base));
    const applied = applyToSession(session, { kind: 'task.update', id: 'w1b', patch: { name: '冻结会话' } });
    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.changed) {
      throw new Error('应当成功且产生变更');
    }
    const undone = undoSession(deepFreezeJson(applied.session));
    expect(undone.ok).toBe(true);
    if (!undone.ok) {
      return;
    }
    expect(undone.session.document).toStrictEqual(base);
  });

  it('确定性：同一序列（命令经 JSON 往返）得到同一会话文档与同一步数', () => {
    const commands = commandSequence();
    const first = runAll(commandBaseDocument(), commands);
    const reparsed = commands.map((command) => {
      const parsed = parseCommand(serializeCommand(command));
      if (!parsed.ok) {
        throw new Error(parsed.message);
      }
      return parsed.command;
    });
    const second = runAll(commandBaseDocument(), reparsed);

    expect(second.document).toStrictEqual(first.document);
    expect(second.revision).toBe(first.revision);
    expect(second.undoStack).toHaveLength(first.undoStack.length);
  });

  it('负向对照：精确还原靠 LIFO 栈 + 日志守卫，而不是"日志可以重复应用"', () => {
    const base = commandBaseDocument();
    const applied = applyCommand(base, { kind: 'task.update', id: 'w1b', patch: { name: '一次' } });
    if (!applied.ok || !applied.changed) {
      throw new Error('前置应用应当成功');
    }
    const inverse = invertDocumentJournal(applied.journal);

    const once = applyDocumentJournal(applied.document, inverse);
    expect(once).toStrictEqual(base);

    // 同一份逆日志再应用一次：守卫必须拒绝（而不是静默产出错误文档）
    expect(() => applyDocumentJournal(once, inverse)).toThrow(RangeError);
    // 正向日志直接重复应用同样被拒绝
    expect(() => applyDocumentJournal(applied.document, applied.journal)).toThrow(RangeError);
  });

  it('撤销/重做走的是日志而不是重跑命令（无需重新求值即可恢复）', () => {
    const base = commandBaseDocument();
    const commands = longCommandSequence(4);
    let session = runAll(base, commands);
    const peak = session.document;

    // 连续撤销再重做，文档必须与峰值态逐项相同（日志携带 after 镜像）
    for (let index = 0; index < commands.length; index += 1) {
      const undone = undoSession(session);
      if (!undone.ok) {
        throw new Error(undone.message);
      }
      session = undone.session;
    }
    for (let index = 0; index < commands.length; index += 1) {
      const redone = redoSession(session);
      if (!redone.ok) {
        throw new Error(redone.message);
      }
      session = redone.session;
    }
    expect(session.document).toStrictEqual(peak);
  });
});
