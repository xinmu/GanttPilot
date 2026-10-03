import type { DocumentCommand } from './command.js';
import type { DocumentTask, ProjectDocument } from './schema.js';
import { flatDocument, task, wbsDocument } from './fixtures.spec.js';

/**
 * G1.3 命令层的共享测试夹具。
 *
 * 为什么也写成 `*.spec.ts`：与 `fixtures.spec.ts` 同一手法——可被其他 spec import，
 * 且被 `tsconfig.json` 的 `exclude` 排除在发布产物之外（不必为夹具改构建配置）。
 *
 * **关键契约**：`commandSequence()` 覆盖 `COMMAND_KINDS` 的**每一个** kind，
 * 且**按序**应用到 `wbsDocument()` 上时每一条都必须成功（`command.spec.ts` 里有完备性断言）。
 * 顺序是刻意设计的：后面的命令依赖前面命令留下的状态（这正是"一次手势 = 一条命令"的链路）。
 */

/** 命令序列的起点文档（每次返回新对象，避免测试间共享引用）。 */
export function commandBaseDocument(): ProjectDocument {
  return wbsDocument();
}

/** `task.insert` 的完整任务载荷（`outlineNumber` 是派生值，插入时按层级重算）。 */
export function insertedTask(): DocumentTask {
  return task({
    id: 'n1',
    parentId: 'w1',
    outlineNumber: '',
    name: '新增任务',
    startDate: '2025-04-01',
    endDate: '2025-04-03',
    durationDays: 2,
    progress: 0,
  });
}

/**
 * 覆盖全部命令类型的序列（11 条 = 11 个 kind）。
 *
 * 最后一条是 `document.replace`（整份替换），因此它之后的文档与起点**完全不同**——
 * undo/redo 测试若要用长序列，请用 `longCommandSequence()`（它不含整份替换）。
 */
export function commandSequence(): readonly DocumentCommand[] {
  return [
    // 1. 跨字段更新（名称/日期/工期/进度/备注/折叠一起改）
    {
      kind: 'task.update',
      id: 'w1a1',
      patch: {
        name: '叶子任务（改）',
        startDate: '2025-02-10',
        endDate: '2025-02-14',
        durationDays: 4,
        progress: 0.25,
        notes: '跨字段',
        collapsed: true,
      },
    },
    // 2. 插入（落到 w1 的最后一个子节点：w1b 的整棵子树之后）
    { kind: 'task.insert', task: insertedTask(), parentId: 'w1', afterTaskId: 'w1b' },
    // 3. Tab：成为前一个兄弟 w1b 的子节点
    { kind: 'task.indent', id: 'n1' },
    // 4. Shift+Tab：回到 w1 之下
    { kind: 'task.outdent', id: 'n1' },
    // 5. 跨层级移动：w2a 挂到 w1 之下、紧跟 w1a1
    { kind: 'task.move', id: 'w2a', target: { parentId: 'w1', afterTaskId: 'w1a1' } },
    // 6. 建边
    { kind: 'link.insert', link: { id: 'l3', from: 'w1b', to: 'w2', type: 'FF', lagDays: -1 } },
    // 7. 改边（类型 + lag）
    { kind: 'link.update', id: 'l3', patch: { type: 'SS', lagDays: 2 } },
    // 8. 删边
    { kind: 'link.remove', id: 'l2' },
    // 9. 项目元数据
    {
      kind: 'project.update',
      patch: { name: '改动后的项目', startDate: '2025-03-01', finishDate: '2025-06-30' },
    },
    // 10. 删任务：w1a 带走整棵子树（w1a1）并级联删掉 l1
    { kind: 'task.remove', id: 'w1a' },
    // 11. 整份替换（导入 / 新建的通道）
    { kind: 'document.replace', document: flatDocument() },
  ];
}

/**
 * 用于撤销/重做的**长序列**（不含整份替换，故每一步都作用在同一份文档上）。
 *
 * 前缀是 10 条"结构 + 跨字段"命令（覆盖 11 个 kind 里的 10 个），
 * 后缀是 `repeats` 条 `task.update`（每个值都不同，保证每一步都真的改变文档）。
 */
export function longCommandSequence(repeats = 60): readonly DocumentCommand[] {
  const head = commandSequence().filter((command) => command.kind !== 'document.replace');
  const tail: DocumentCommand[] = [];
  for (let index = 0; index < repeats; index += 1) {
    tail.push({
      kind: 'task.update',
      id: 'w1b',
      patch: { notes: `步 ${String(index + 1)}`, progress: index / repeats },
    });
  }
  return [...head, ...tail];
}
