import { describe, expect, it } from 'vitest';

import {
  applyCommand,
  COMMAND_KINDS,
  parseCommand,
  replayCommands,
  serializeCommand,
  suggestLinkId,
  suggestTaskId,
  type CommandFailureCode,
  type DocumentCommand,
  type TaskFieldPatch,
} from './command.js';
import { applyDocumentJournal, deepFreezeJson, invertDocumentJournal } from './journal.js';
import { hasDocumentErrors, parseDocument, serializeDocument, validateDocument } from './schema.js';
import type { DocumentTask, ProjectDocument } from './schema.js';
import { indentTask, moveTask, outdentTask, reindexTasks, type TaskHierarchyInput } from './wbs.js';
import {
  commandBaseDocument,
  commandSequence,
  insertedTask,
  longCommandSequence,
} from './commandFixtures.spec.js';
import { flatDocument, task } from './fixtures.spec.js';

/**
 * G1.3 的**命令层**单测。
 *
 * 三类判据：
 * 1. **逐命令的正确性**：每条命令产出零 `error`、可序列化往返、且**入参文档未被改写**
 *    （输入被 `deepFreezeJson` 深冻结——任何就地写入都会在严格模式下抛 `TypeError`）；
 * 2. **双路互证**：命令产出的文档必须与"**既有领域函数 + 手工数组操作**"独立算出的结果逐项一致
 *    ——被验证的是本块新增的"日志应用"路径，参照物是 G1.2 已被测试过的领域函数；
 * 3. **失败与无操作**：稳定失败码表 + 无操作不压栈的语义。
 */

const collectSubtree = (tasks: readonly TaskHierarchyInput[], id: string): ReadonlySet<string> => {
  const subtree = new Set<string>([id]);
  for (const item of tasks) {
    if (item.parentId !== null && subtree.has(item.parentId)) {
      subtree.add(item.id);
    }
  }
  return subtree;
};

/**
 * **独立的第二路实现**：只用 G1.2 的领域函数与手工数组操作算出"命令应当得到的文档"。
 *
 * 刻意不调用命令层内部的构造逻辑——否则互证就成了恒真式。
 */
function expectedAfter(document: ProjectDocument, command: DocumentCommand): ProjectDocument {
  switch (command.kind) {
    case 'document.replace':
      return command.document;
    case 'project.update':
      return { ...document, project: { ...document.project, ...command.patch } };
    case 'task.update':
      return {
        ...document,
        tasks: document.tasks.map((item) =>
          item.id === command.id ? ({ ...item, ...command.patch } as DocumentTask) : item,
        ),
      };
    case 'link.insert':
      return { ...document, links: [...document.links, command.link] };
    case 'link.update':
      return {
        ...document,
        links: document.links.map((link) =>
          link.id === command.id ? { ...link, ...command.patch } : link,
        ),
      };
    case 'link.remove':
      return { ...document, links: document.links.filter((link) => link.id !== command.id) };
    case 'task.indent': {
      const result = indentTask(document.tasks, command.id);
      if (!result.ok) {
        throw new Error(`indent 应当成功：${result.message}`);
      }
      return { ...document, tasks: result.value };
    }
    case 'task.outdent': {
      const result = outdentTask(document.tasks, command.id);
      if (!result.ok) {
        throw new Error(`outdent 应当成功：${result.message}`);
      }
      return { ...document, tasks: result.value };
    }
    case 'task.move': {
      const result = moveTask(document.tasks, command.id, command.target);
      if (!result.ok) {
        throw new Error(`move 应当成功：${result.message}`);
      }
      return { ...document, tasks: result.value };
    }
    case 'task.remove': {
      const subtree = collectSubtree(document.tasks, command.id);
      return {
        ...document,
        tasks: reindexTasks(document.tasks.filter((item) => !subtree.has(item.id))),
        links: document.links.filter((link) => !subtree.has(link.from) && !subtree.has(link.to)),
      };
    }
    case 'task.insert': {
      const appended = [...document.tasks, command.task];
      const moved = moveTask(appended, command.task.id, {
        parentId: command.parentId,
        ...(command.index === undefined ? {} : { index: command.index }),
        ...(command.afterTaskId === undefined ? {} : { afterTaskId: command.afterTaskId }),
      });
      if (moved.ok) {
        return { ...document, tasks: moved.value };
      }
      if (moved.code === 'WBS_SAME_POSITION') {
        return { ...document, tasks: reindexTasks(appended) };
      }
      throw new Error(`insert 应当成功：${moved.message}`);
    }
  }
}

describe('G1.3 命令层：夹具完备性', () => {
  it('夹具序列覆盖 COMMAND_KINDS 的每一个 kind（新增命令类型不可能漏测）', () => {
    const kinds = new Set(commandSequence().map((command) => command.kind));
    for (const kind of COMMAND_KINDS) {
      expect(kinds.has(kind), `夹具缺少 ${kind} 的用例`).toBe(true);
    }
    expect(kinds.size).toBe(COMMAND_KINDS.length);
  });
});

describe('G1.3 命令层：按序应用全部命令', () => {
  it('每步都 changed、产出零 error、可序列化往返，且**入参文档从未被改写**', () => {
    let current: ProjectDocument = deepFreezeJson(commandBaseDocument());
    let steps = 0;

    for (const command of commandSequence()) {
      const result = applyCommand(current, command);
      expect(result.ok, `${command.kind} 应当成功`).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.changed, `${command.kind} 应当真的改变文档`).toBe(true);
      if (!result.changed) {
        return;
      }
      current = deepFreezeJson(result.document);
      expect(hasDocumentErrors(validateDocument(current)), `${command.kind} 产出应当零 error`).toBe(
        false,
      );
      expect(parseDocument(serializeDocument(current)), command.kind).toStrictEqual(current);
      steps += 1;
    }

    expect(steps).toBe(commandSequence().length);
    expect(current).not.toStrictEqual(commandBaseDocument());
  });

  it('互证：命令产出与"领域函数 + 手工数组操作"逐项一致', () => {
    let current = commandBaseDocument();
    for (const command of commandSequence()) {
      const result = applyCommand(current, command);
      expect(result.ok, command.kind).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.document, command.kind).toStrictEqual(expectedAfter(current, command));
      current = result.document;
    }
  });

  it('每条命令的 before 镜像都能精确回滚一步（含调级与跨字段变更）', () => {
    let current = commandBaseDocument();
    for (const command of commandSequence()) {
      const result = applyCommand(current, command);
      if (!result.ok || !result.changed) {
        throw new Error(`${command.kind} 应当成功且产生变更`);
      }
      expect(
        applyDocumentJournal(result.document, invertDocumentJournal(result.journal)),
        command.kind,
      ).toStrictEqual(current);
      current = result.document;
    }
  });
});

describe('G1.3 命令层：无操作语义（不压撤销栈）', () => {
  it('恒等 patch → changed:false，文档保持同一引用', () => {
    const base = commandBaseDocument();
    const current = base.tasks.find((item) => item.id === 'w1b');
    if (current === undefined) {
      throw new Error('夹具应当有 w1b');
    }

    const result = applyCommand(base, {
      kind: 'task.update',
      id: 'w1b',
      patch: { name: current.name, progress: current.progress },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.changed).toBe(false);
    expect(result.document).toBe(base);

    // 空 patch 也是无操作
    const emptyPatch = applyCommand(base, { kind: 'task.update', id: 'w1b', patch: {} });
    expect(emptyPatch.ok).toBe(true);
    if (!emptyPatch.ok) {
      return;
    }
    expect(emptyPatch.changed).toBe(false);
  });

  it('WBS_SAME_POSITION 归为无操作（正常交互，不是失败）', () => {
    const base = commandBaseDocument();
    // w1a1 已是其父节点的唯一子节点：再 Tab 就是无操作
    const indented = applyCommand(base, { kind: 'task.indent', id: 'w1a1' });
    expect(indented.ok).toBe(true);
    if (!indented.ok) {
      return;
    }
    expect(indented.changed).toBe(false);
    expect(indented.document).toBe(base);

    // 移到原位也是无操作
    const moved = applyCommand(base, { kind: 'task.move', id: 'w2a', target: { parentId: 'w2', index: 0 } });
    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    expect(moved.changed).toBe(false);
    expect(moved.document).toBe(base);
  });

  it('插入的载荷不会被别名进文档（命令层产出自己的克隆）', () => {
    const base = commandBaseDocument();
    const payload = insertedTask();
    const result = applyCommand(base, { kind: 'task.insert', task: payload, parentId: 'w1' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const stored = result.document.tasks.find((item) => item.id === 'n1');
    expect(stored).toBeDefined();
    expect(stored).not.toBe(payload);
    expect(base.tasks.some((item) => item.id === 'n1')).toBe(false);
    expect(base.tasks).toHaveLength(6);
  });
});

describe('G1.3 命令层：失败码（稳定契约）', () => {
  const base = commandBaseDocument();
  const cases: readonly (readonly [string, DocumentCommand, CommandFailureCode])[] = [
    ['任务不存在（更新）', { kind: 'task.update', id: 'nope', patch: { name: 'x' } }, 'CMD_TASK_NOT_FOUND'],
    ['任务不存在（删除）', { kind: 'task.remove', id: 'nope' }, 'CMD_TASK_NOT_FOUND'],
    ['目标父任务不存在', { kind: 'task.move', id: 'w2', target: { parentId: 'nope' } }, 'CMD_PARENT_NOT_FOUND'],
    [
      '落点任务不存在',
      { kind: 'task.move', id: 'w2', target: { parentId: null, afterTaskId: 'nope' } },
      'CMD_ANCHOR_TASK_NOT_FOUND',
    ],
    [
      '任务 id 重复',
      { kind: 'task.insert', task: { ...insertedTask(), id: 'w1a' }, parentId: 'w1' },
      'CMD_TASK_ID_DUPLICATE',
    ],
    [
      '依赖边 id 重复',
      { kind: 'link.insert', link: { id: 'l1', from: 'w1', to: 'w2', type: 'FS', lagDays: 0 } },
      'CMD_LINK_ID_DUPLICATE',
    ],
    [
      '依赖边端点悬空',
      { kind: 'link.insert', link: { id: 'lx', from: 'w1', to: 'nope', type: 'FS', lagDays: 0 } },
      'CMD_LINK_ENDPOINT_NOT_FOUND',
    ],
    [
      '依赖边自环',
      { kind: 'link.insert', link: { id: 'lx', from: 'w1', to: 'w1', type: 'FS', lagDays: 0 } },
      'CMD_LINK_SELF_REFERENCE',
    ],
    ['日历不存在', { kind: 'project.update', patch: { baseCalendarId: 'nope' } }, 'CMD_CALENDAR_NOT_FOUND'],
    ['Tab 没有前一个兄弟', { kind: 'task.indent', id: 'w1' }, 'WBS_NO_PREVIOUS_SIBLING'],
    ['Shift+Tab 已在顶层', { kind: 'task.outdent', id: 'w1' }, 'WBS_ALREADY_AT_ROOT'],
    ['移入自身后代', { kind: 'task.move', id: 'w1', target: { parentId: 'w1a1' } }, 'WBS_CYCLE'],
    ['依赖边不存在（更新）', { kind: 'link.update', id: 'nope', patch: { lagDays: 1 } }, 'CMD_LINK_NOT_FOUND'],
    ['调级目标位置越界', { kind: 'task.move', id: 'w2', target: { parentId: null, index: 99 } }, 'WBS_TARGET_INDEX_OUT_OF_RANGE'],
    [
      '载荷含不允许字段',
      {
        kind: 'task.update',
        id: 'w1',
        patch: { parentId: 'w2' } as unknown as TaskFieldPatch,
      },
      'CMD_INVALID_PAYLOAD',
    ],
    ['载荷日期非法', { kind: 'task.update', id: 'w1', patch: { startDate: '2025-13-01' } }, 'CMD_INVALID_PAYLOAD'],
    ['载荷 lag 越界', { kind: 'link.update', id: 'l1', patch: { lagDays: 100_000_000 } }, 'CMD_INVALID_PAYLOAD'],
    ['载荷 id 为空', { kind: 'task.remove', id: '' }, 'CMD_INVALID_PAYLOAD'],
    [
      '结果非法：结束早于开始',
      { kind: 'task.update', id: 'w1a1', patch: { endDate: '2020-01-01' } },
      'CMD_RESULT_INVALID',
    ],
    ['未知命令类型', { kind: 'task.explode', id: 'w1' } as unknown as DocumentCommand, 'CMD_UNKNOWN_KIND'],
  ];

  for (const [name, command, code] of cases) {
    it(`失败：${name} → ${code}`, () => {
      const result = applyCommand(base, command);
      expect(result.ok, name).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code, name).toBe(code);
      expect(result.message.length, name).toBeGreaterThan(0);
    });
  }

  it('失败的命令不会改动文档，也不返回日志', () => {
    const result = applyCommand(base, { kind: 'task.update', id: 'nope', patch: { name: 'x' } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect('document' in result).toBe(false);
    expect('journal' in result).toBe(false);
  });

  it('CMD_RESULT_INVALID 携带 schema 的结构化诊断（不重复实现规则）', () => {
    const result = applyCommand(base, {
      kind: 'task.update',
      id: 'w1a1',
      patch: { endDate: '2020-01-01' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('CMD_RESULT_INVALID');
    expect(result.diagnostics?.some((entry) => entry.code === 'TASK_END_BEFORE_START')).toBe(true);
  });

  it('版本不是当前版本的文档被拒绝（迁移属 parseDocument，不在命令层）', () => {
    const result = applyCommand(
      { ...base, version: 2 },
      { kind: 'task.update', id: 'w1b', patch: { name: 'x' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('CMD_VERSION_MISMATCH');
  });
});

describe('G1.3 命令层：整份替换（document.replace）', () => {
  it('合法文档可以整份替换，且产出是自己的克隆', () => {
    const base = commandBaseDocument();
    const payload = flatDocument();
    const result = applyCommand(base, { kind: 'document.replace', document: payload });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.changed) {
      throw new Error('整份替换应当成功且产生变更');
    }
    expect(result.document).toStrictEqual(payload);
    expect(result.document).not.toBe(payload);
    expect(result.journal.kind).toBe('document');
    expect(applyDocumentJournal(result.document, invertDocumentJournal(result.journal))).toStrictEqual(base);
  });

  it('非法文档被拒绝：悬空依赖边 / 编号与层级不符', () => {
    const base = commandBaseDocument();
    const dangling = applyCommand(base, {
      kind: 'document.replace',
      document: {
        ...flatDocument(),
        links: [{ id: 'lx', from: 't1', to: 'nope', type: 'FS', lagDays: 0 }],
      },
    });
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      expect(dangling.code).toBe('CMD_RESULT_INVALID');
      expect(dangling.diagnostics?.some((entry) => entry.code === 'LINK_DANGLING_TO')).toBe(true);
    }

    const staleOutline = applyCommand(base, {
      kind: 'document.replace',
      document: {
        ...flatDocument(),
        tasks: flatDocument().tasks.map((item) => ({ ...item, outlineNumber: '9' })),
      },
    });
    expect(staleOutline.ok).toBe(false);
    if (!staleOutline.ok) {
      expect(staleOutline.code).toBe('CMD_RESULT_INVALID');
      expect(staleOutline.diagnostics?.some((entry) => entry.code === 'TREE_OUTLINE_NOT_UNIQUE')).toBe(
        true,
      );
    }
  });

  it('版本不符或五段不全的载荷被拒绝', () => {
    const base = commandBaseDocument();
    const wrongVersion = applyCommand(base, {
      kind: 'document.replace',
      document: { ...flatDocument(), version: 2 },
    });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) {
      expect(wrongVersion.code).toBe('CMD_VERSION_MISMATCH');
    }

    const shortShape = applyCommand(base, {
      kind: 'document.replace',
      document: { version: 3, project: flatDocument().project } as unknown as ProjectDocument,
    });
    expect(shortShape.ok).toBe(false);
    if (!shortShape.ok) {
      expect(shortShape.code).toBe('CMD_INVALID_PAYLOAD');
    }
  });

  it('与当前文档相同的整份替换是无操作', () => {
    const base = commandBaseDocument();
    const result = applyCommand(base, { kind: 'document.replace', document: base });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.changed).toBe(false);
    expect(result.document).toBe(base);
  });
});

describe('G1.3 命令层：重放与序列化', () => {
  it('重放：同一序列两次结果一致，命令经 JSON 往返后仍一致', () => {
    const base = commandBaseDocument();
    const commands = longCommandSequence(20);

    const first = replayCommands(base, commands);
    const second = replayCommands(base, commands);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.applied).toBe(commands.length);
    expect(first.changed).toBe(commands.length);
    expect(first.document).toStrictEqual(second.document);

    const reparsed = commands.map((command) => {
      const parsed = parseCommand(serializeCommand(command));
      if (!parsed.ok) {
        throw new Error(`命令应当可解析：${parsed.message}`);
      }
      return parsed.command;
    });
    const third = replayCommands(base, reparsed);
    expect(third.ok).toBe(true);
    if (!third.ok) {
      return;
    }
    expect(third.document).toStrictEqual(first.document);
  });

  it('重放遇到失败即停，返回前缀状态与失败下标（不静默跳过）', () => {
    const base = commandBaseDocument();
    const head = longCommandSequence(3);
    const commands: readonly DocumentCommand[] = [
      ...head,
      { kind: 'task.update', id: 'nope', patch: { name: 'x' } },
      { kind: 'task.remove', id: 'w1b' },
    ];

    const result = replayCommands(base, commands);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.index).toBe(head.length);
    expect(result.code).toBe('CMD_TASK_NOT_FOUND');

    const prefix = replayCommands(base, head);
    expect(prefix.ok).toBe(true);
    if (!prefix.ok) {
      return;
    }
    expect(result.document).toStrictEqual(prefix.document);
  });

  it('序列化 → 解析往返一致（每种命令）', () => {
    for (const command of commandSequence()) {
      const parsed = parseCommand(serializeCommand(command));
      expect(parsed.ok, command.kind).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.command, command.kind).toStrictEqual(command);
    }
  });

  it('parseCommand：拒绝未知 kind 与语法错误，忽略命令顶层多余键', () => {
    const syntax = parseCommand('{');
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) {
      expect(syntax.code).toBe('CMD_INVALID_PAYLOAD');
    }

    const unknown = parseCommand('{"kind":"task.explode","id":"w1"}');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe('CMD_UNKNOWN_KIND');
    }

    const missing = parseCommand('{"kind":"task.update"}');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('CMD_INVALID_PAYLOAD');
    }

    const extra = parseCommand('{"kind":"task.remove","id":"w1b","futureField":42}');
    expect(extra.ok).toBe(true);
    if (extra.ok) {
      expect(extra.command).toStrictEqual({ kind: 'task.remove', id: 'w1b' });
    }
  });

  it('serializeCommand 拒绝非法命令（程序员错误，抛 RangeError）', () => {
    expect(() => serializeCommand({ kind: 'task.remove', id: '' })).toThrow(RangeError);
  });
});

describe('G1.3 命令层：id 建议（确定性）', () => {
  it('给出最小未占用 id，且同一文档多次调用结果一致', () => {
    const base = commandBaseDocument();
    expect(suggestTaskId(base)).toBe('t1');
    expect(suggestTaskId(base)).toBe(suggestTaskId(base));
    expect(suggestLinkId(base)).toBe('l3');

    const withSuggested: ProjectDocument = {
      ...base,
      tasks: [...base.tasks, task({ id: 't1', outlineNumber: '7' })],
    };
    expect(suggestTaskId(withSuggested)).toBe('t2');
    expect(suggestTaskId(base, 'p')).toBe('p1');
  });
});

describe('G1.3 命令层：结果只依赖入参（无隐藏状态）', () => {
  it('同一文档 + 同一命令两次调用得到相同结果', () => {
    const base = commandBaseDocument();
    const command: DocumentCommand = { kind: 'task.update', id: 'w1b', patch: { name: '纯性' } };
    const first = applyCommand(base, command);
    const second = applyCommand(base, command);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    // **改名的补丁必须真的产生变更**：结果类型里 `changed: false` 那一支**没有** `journal`
    // （无变更就没有可撤销的一步），所以"两次的 journal 相等"这条断言必须先站在
    // "确实变了"这一支上——这既满足类型，也让断言本身有内容（P3/C7-b）。
    if (!first.changed || !second.changed) {
      throw new Error('期望 task.update 产生变更（否则 journal 无从比较）');
    }
    expect(first.document).toStrictEqual(second.document);
    expect(first.journal).toStrictEqual(second.journal);
  });

  it('深冻结的输入文档也能被处理（证明命令层不就地写入）', () => {
    const base = deepFreezeJson(commandBaseDocument());
    const result = applyCommand(base, { kind: 'task.indent', id: 'w1b' });
    expect(result.ok).toBe(true);
    expect(base.tasks.find((item) => item.id === 'w1b')?.parentId).toBe('w1');
  });
});
