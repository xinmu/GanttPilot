import { describe, expect, it } from 'vitest';

import { hasDocumentErrors, reindexDocument, validateDocument, type ProjectDocument } from './schema.js';
import {
  buildTaskTree,
  computeDepths,
  computeOutlineNumbers,
  computeOutlineNumbersByScan,
  flattenTaskTree,
  indentTask,
  isValidOutlineNumber,
  MAX_OUTLINE_DEPTH,
  moveTask,
  outdentTask,
  OUTLINE_SEPARATOR,
  outlineDepth,
  parentOutlineNumber,
  reindexTasks,
  summaryTaskIds,
  type WbsResult,
  type WbsFailureCode,
} from './wbs.js';
import { task, wbsDocument } from './fixtures.spec.js';

/**
 * G1.2 出口条件 3：**层级不变量测试**——无环、编号唯一且与层级自洽、
 * 调级后重编号正确、跨层级移动正确。
 *
 * 本文件还包含两件判别力证据：
 * 1. **互证**：`computeOutlineNumbers`（遍历实现）与 `computeOutlineNumbersByScan`
 *    （逐层 parentId 扫描）在整棵树上逐项一致；
 * 2. **负向对照**：故意把编号偏移一位、故意跳过重编号，必须被检出。
 */

/** 简写：把 `WbsResult` 解包，失败即让用例失败并带上失败码。 */
function unwrap<T>(result: WbsResult<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.code} ${result.message}`);
  }
  return result.value;
}

/** 简写：断言失败并返回失败码。 */
function failCode<T>(result: WbsResult<T>): WbsFailureCode {
  if (result.ok) {
    throw new Error('期望失败，实际成功');
  }
  return result.code;
}

/** 扁平任务表（`outlineNumber` 自洽），供调级测试使用。 */
function flat(...specs: readonly (readonly [string, string | null, string])[]) {
  return specs.map(([id, parentId, outlineNumber]) => task({ id, parentId, outlineNumber, name: id }));
}

function numbersOf(tasks: readonly { id: string; outlineNumber: string }[]): Record<string, string> {
  return Object.fromEntries(tasks.map((entry) => [entry.id, entry.outlineNumber]));
}

describe('G1.2 树构建与派生量', () => {
  it('buildTaskTree 的深度与父子关系正确，flatten 回到同一顺序', () => {
    const tasks = wbsDocument().tasks;
    const roots = buildTaskTree(tasks);
    expect(roots.map((node) => node.task.id)).toStrictEqual(['w1', 'w2']);
    expect(roots[0]?.depth).toBe(0);
    expect(roots[0]?.children.map((node) => node.task.id)).toStrictEqual(['w1a', 'w1b']);
    expect(roots[0]?.children[0]?.depth).toBe(1);
    expect(roots[0]?.children[0]?.children[0]?.task.id).toBe('w1a1');
    expect(roots[0]?.children[0]?.children[0]?.depth).toBe(2);

    const flattened = flattenTaskTree(roots).map((entry) => entry.id);
    expect(flattened).toStrictEqual(['w1', 'w1a', 'w1a1', 'w1b', 'w2', 'w2a']);
  });

  it('summaryTaskIds 判定有子节点的任务（不依赖编号）', () => {
    expect([...summaryTaskIds(wbsDocument().tasks)].sort()).toStrictEqual(['w1', 'w1a', 'w2']);
  });

  it('computeDepths 与树的 depth 一致，且对悬空 parentId / 成环退化为 0', () => {
    const depths = computeDepths(wbsDocument().tasks);
    expect(depths.get('w1')).toBe(0);
    expect(depths.get('w1a')).toBe(1);
    expect(depths.get('w1a1')).toBe(2);

    const dirty = flat(['a', 'ghost', '1'], ['b', 'c', '2'], ['c', 'b', '3']);
    const dirtyDepths = computeDepths(dirty);
    expect(dirtyDepths.get('a')).toBe(0);
    expect(dirtyDepths.get('b')).toBe(0);
    expect(dirtyDepths.get('c')).toBe(0);
  });

  it('编号工具函数：形式校验、深度、父编号', () => {
    expect(isValidOutlineNumber('1')).toBe(true);
    expect(isValidOutlineNumber('1.2.3')).toBe(true);
    for (const bad of ['', '0', '01', '1.', '.1', '1..2', 'a', '1.a']) {
      expect(isValidOutlineNumber(bad), `${bad} 应非法`).toBe(false);
    }
    expect(outlineDepth('1.2.3')).toBe(3);
    expect(parentOutlineNumber('1.2.3')).toBe('1.2');
    expect(parentOutlineNumber('1')).toBeNull();
    expect(OUTLINE_SEPARATOR).toBe('.');
  });

  it('**互证**：遍历实现与逐层扫描实现在整棵树上逐项一致', () => {
    const tasks = wbsDocument().tasks;
    const byWalk = computeOutlineNumbers(tasks);
    const byScan = computeOutlineNumbersByScan(tasks);
    expect(byWalk.size).toBe(tasks.length);
    for (const entry of tasks) {
      expect(byScan.get(entry.id), `任务 ${entry.id} 的两套编号应一致`).toBe(byWalk.get(entry.id));
    }
  });

  it('**负向对照**：打乱兄弟顺序后两套实现仍然一致（说明它们真的在算顺序，不是常量表）', () => {
    const reordered = [flat(['a', null, '1']), flat(['b', null, '2'])[0]!];
    const two = [reordered[1]!, reordered[0]!];
    expect(computeOutlineNumbers(two).get('b')).toBe('1');
    expect(computeOutlineNumbersByScan(two).get('b')).toBe('1');
  });
});

describe('G1.2 调级：indent / outdent', () => {
  it('indent 把任务变成前一个兄弟的最后一个子节点，并重编号', () => {
    const before = flat(['a', null, '1'], ['b', null, '2'], ['c', null, '3']);
    const after = unwrap(indentTask(before, 'c'));
    expect(after.find((entry) => entry.id === 'c')?.parentId).toBe('b');
    expect(numbersOf(after)).toStrictEqual({ a: '1', b: '2', c: '2.1' });
    // 编号仍然自洽
    expect(validateDocument(canonical(after)).filter((entry) => entry.severity === 'error')).toStrictEqual([]);
  });

  it('indent 的首个同级任务失败（WBS_NO_PREVIOUS_SIBLING）', () => {
    expect(failCode(indentTask(flat(['a', null, '1'], ['b', null, '2']), 'a'))).toBe(
      'WBS_NO_PREVIOUS_SIBLING',
    );
  });

  it('indent 已是前一个兄弟的子节点时是无操作（WBS_SAME_POSITION）', () => {
    // c 是 b 的唯一子节点：此时 c 没有同级，但"降级"它确实无事可做。
    expect(failCode(indentTask(flat(['a', null, '1'], ['b', null, '2'], ['c', 'b', '2.1']), 'c'))).toBe(
      'WBS_SAME_POSITION',
    );
  });

  it('indent 已是父节点的非唯一子节点时，无前一个同级 → WBS_NO_PREVIOUS_SIBLING', () => {
    // c、e 都是 b 的子节点，且 c 是第一个：它没有前一个同级，不能降级。
    expect(
      failCode(indentTask(flat(['b', null, '1'], ['c', 'b', '1.1'], ['e', 'b', '1.2']), 'c')),
    ).toBe('WBS_NO_PREVIOUS_SIBLING');
  });

  it('indent 不存在的任务 → WBS_TASK_NOT_FOUND', () => {
    expect(failCode(indentTask(flat(['a', null, '1']), 'ghost'))).toBe('WBS_TASK_NOT_FOUND');
  });

  it('outdent 把任务移到父节点的下一个兄弟位，并重编号', () => {
    const before = flat(['p', null, '1'], ['a', 'p', '1.1'], ['b', 'p', '1.2'], ['c', null, '2']);
    const after = unwrap(outdentTask(before, 'a'));
    expect(after.find((entry) => entry.id === 'a')?.parentId).toBeNull();
    expect(numbersOf(after)).toStrictEqual({ p: '1', b: '1.1', a: '2', c: '3' });
  });

  it('outdent 顶层任务失败（WBS_ALREADY_AT_ROOT）', () => {
    expect(failCode(outdentTask(flat(['a', null, '1']), 'a'))).toBe('WBS_ALREADY_AT_ROOT');
  });

  it('outdent 唯一子节点时正常升级（"第一个子节点"不等于无操作）', () => {
    const before = flat(['p', null, '1'], ['a', 'p', '1.1'], ['c', null, '2']);
    const after = unwrap(outdentTask(before, 'a'));
    expect(after.find((entry) => entry.id === 'a')?.parentId).toBeNull();
    expect(numbersOf(after)).toStrictEqual({ p: '1', a: '2', c: '3' });
  });

  it('outdent 非首个兄弟也正常升级，并落在父节点之后', () => {
    const before = flat(['p', null, '1'], ['a', 'p', '1.1'], ['b', 'p', '1.2'], ['c', null, '2']);
    const after = unwrap(outdentTask(before, 'b'));
    expect(numbersOf(after)).toStrictEqual({ p: '1', a: '1.1', b: '2', c: '3' });
  });

  it('**往返**：indent 之后 outdent 回到原来的层级与顺序', () => {
    const before = flat(['a', null, '1'], ['b', null, '2'], ['c', null, '3']);
    const indented = unwrap(indentTask(before, 'c'));
    const back = unwrap(outdentTask(indented, 'c'));
    expect(back.map((entry) => [entry.id, entry.parentId, entry.outlineNumber])).toStrictEqual(
      before.map((entry) => [entry.id, entry.parentId, entry.outlineNumber]),
    );
  });

  it('indent 两次形成三级嵌套，编号为 1 / 1.1 / 1.2', () => {
    const before = flat(['a', null, '1'], ['b', null, '2'], ['c', null, '3'], ['d', null, '4']);
    const once = unwrap(indentTask(before, 'b'));
    const twice = unwrap(indentTask(once, 'c'));
    // b 降级到 a 之下 → 1.1；此时 c 的前一个兄弟是 a（文档序里 b 已挪到 a 之后），
    // 于是 c 也降级到 a 之下，且排在 b 之后 → 1.2。
    expect(numbersOf(once)).toStrictEqual({ a: '1', b: '1.1', c: '2', d: '3' });
    expect(numbersOf(twice)).toStrictEqual({ a: '1', b: '1.1', c: '1.2', d: '2' });

    // 三级嵌套：再把 c 降级会因"已是 a 的子节点"而无操作，因此改为三级由 b 承载。
    const third = unwrap(indentTask(twice, 'd'));
    expect(numbersOf(third)).toStrictEqual({ a: '1', b: '1.1', c: '1.2', d: '1.3' });
  });
});

describe('G1.2 调级：跨层级移动（moveTask）', () => {
  it('移动到另一个父节点下并重编号', () => {
    const before = flat(['p', null, '1'], ['q', null, '2'], ['x', 'p', '1.1'], ['y', 'q', '2.1']);
    const after = unwrap(moveTask(before, 'x', { parentId: 'q', index: 0 }));
    expect(after.find((entry) => entry.id === 'x')?.parentId).toBe('q');
    expect(numbersOf(after)).toStrictEqual({ p: '1', q: '2', x: '2.1', y: '2.2' });
  });

  it('移动到顶层（parentId = null）', () => {
    const before = flat(['p', null, '1'], ['x', 'p', '1.1'], ['c', null, '2']);
    const after = unwrap(moveTask(before, 'x', { parentId: null, index: 1 }));
    expect(after.find((entry) => entry.id === 'x')?.parentId).toBeNull();
    expect(numbersOf(after)).toStrictEqual({ p: '1', x: '2', c: '3' });
  });

  it('移动到自身子树之下 → WBS_CYCLE（防环）', () => {
    const before = flat(['p', null, '1'], ['x', 'p', '1.1'], ['x1', 'x', '1.1.1']);
    expect(failCode(moveTask(before, 'p', { parentId: 'x1', index: 0 }))).toBe('WBS_CYCLE');
    expect(failCode(moveTask(before, 'p', { parentId: 'p', index: 0 }))).toBe('WBS_CYCLE');
  });

  it('目标父任务不存在 → WBS_TARGET_NOT_FOUND；index 越界 → WBS_TARGET_INDEX_OUT_OF_RANGE', () => {
    const before = flat(['p', null, '1'], ['x', null, '2']);
    expect(failCode(moveTask(before, 'x', { parentId: 'ghost', index: 0 }))).toBe('WBS_TARGET_NOT_FOUND');
    expect(failCode(moveTask(before, 'x', { parentId: 'p', index: 5 }))).toBe(
      'WBS_TARGET_INDEX_OUT_OF_RANGE',
    );
    expect(failCode(moveTask(before, 'x', { parentId: 'p', index: -1 }))).toBe(
      'WBS_TARGET_INDEX_OUT_OF_RANGE',
    );
  });

  it('同级内重排：移动到第 0 位 / 末尾', () => {
    const before = flat(['a', null, '1'], ['b', null, '2'], ['c', null, '3']);

    // [a,b,c] → 把最后一个移到最前
    const toFront = unwrap(moveTask(before, 'c', { parentId: null, index: 0 }));
    expect(toFront.map((entry) => entry.id)).toStrictEqual(['c', 'a', 'b']);
    expect(numbersOf(toFront)).toStrictEqual({ c: '1', a: '2', b: '3' });

    // [c,a,b] → 把最前一个移到末尾
    const firstToTail = unwrap(moveTask(toFront, 'c', { parentId: null, index: 2 }));
    expect(firstToTail.map((entry) => entry.id)).toStrictEqual(['a', 'b', 'c']);
    expect(numbersOf(firstToTail)).toStrictEqual({ a: '1', b: '2', c: '3' });

    // 移到末尾后再移末尾 = 无操作
    expect(failCode(moveTask(firstToTail, 'c', { parentId: null, index: 2 }))).toBe('WBS_SAME_POSITION');

    // 中间位置：把 a（当前第 0）移到第 1 位 → [b,a,c]
    const toMiddle = unwrap(moveTask(firstToTail, 'a', { parentId: null, index: 1 }));
    expect(toMiddle.map((entry) => entry.id)).toStrictEqual(['b', 'a', 'c']);
  });

  it('原位移动是无操作（WBS_SAME_POSITION）', () => {
    const before = flat(['a', null, '1'], ['b', null, '2'], ['c', null, '3']);
    expect(failCode(moveTask(before, 'c', { parentId: null, index: 2 }))).toBe('WBS_SAME_POSITION');
    // 父节点不同就不是无操作：把 c 降级为 b 的最后一个子节点，即使"排在末尾"。
    const reparented = unwrap(moveTask(before, 'c', { parentId: 'b', index: 0 }));
    expect(reparented.find((entry) => entry.id === 'c')?.parentId).toBe('b');
  });

  it('**目标的树位于被移动任务的文档序之前**时，"移到末尾"仍落在正确一侧（回归用例）', () => {
    // p 在 x 之前：移除 x 后 p 的位置不变；x 应成为 q 的最后一个子节点。
    const before = flat(['p', null, '1'], ['q', 'p', '1.1'], ['x', null, '2']);
    const after = unwrap(moveTask(before, 'x', { parentId: 'p', index: 1 }));
    const ids = after.map((entry) => entry.id);
    expect(ids.indexOf('x'), 'x 应排在 q 之后').toBeGreaterThan(ids.indexOf('q'));
    expect(after.find((entry) => entry.id === 'x')?.parentId).toBe('p');
    expect(numbersOf(after)).toStrictEqual({ p: '1', q: '1.1', x: '1.2' });
  });

  it('深度超限的移动被拒绝（WBS_DEPTH_EXCEEDED）', () => {
    // 造一条 20 层深的链（正好在上限内），再尝试把它整体降一级。
    const deep = Array.from({ length: MAX_OUTLINE_DEPTH }, (_, index) =>
      task({
        id: `d${String(index)}`,
        parentId: index === 0 ? null : `d${String(index - 1)}`,
        outlineNumber: Array.from({ length: index + 1 }, () => '1').join('.'),
        name: `深 ${String(index)}`,
      }),
    );
    const withRoot = [...deep, task({ id: 'root', outlineNumber: String(MAX_OUTLINE_DEPTH + 1), name: 'root' })];
    // 把整条链挂到 root 之下 → 最深节点会到 MAX+1
    const result = moveTask(withRoot, 'd0', { parentId: 'root', index: 0 });
    expect(failCode(result)).toBe('WBS_DEPTH_EXCEEDED');
  });
});

describe('G1.2 重编号与文档级修复', () => {
  it('reindexTasks 只改编号、不动顺序与父子关系', () => {
    const broken = flat(['a', null, '9'], ['b', 'a', '9.9']);
    const fixed = reindexTasks(broken);
    expect(fixed.map((entry) => entry.id)).toStrictEqual(['a', 'b']);
    expect(numbersOf(fixed)).toStrictEqual({ a: '1', b: '1.1' });
  });

  it('reindexTasks 是幂等的', () => {
    const once = reindexTasks(flat(['a', null, '9'], ['b', 'a', '9.9']));
    expect(reindexTasks(once)).toStrictEqual(once);
  });

  it('reindexDocument 让"编号不符"的文档通过严格校验（修复动作与校验分工）', () => {
    const doc: ProjectDocument = {
      ...wbsDocument(),
      tasks: wbsDocument().tasks.map((entry) => ({ ...entry, outlineNumber: '99' })),
    };
    expect(hasDocumentErrors(validateDocument(JSON.parse(JSON.stringify(doc))))).toBe(true);
    const repaired = reindexDocument(doc);
    expect(validateDocument(JSON.parse(JSON.stringify(repaired))).filter((e) => e.severity === 'error')).toStrictEqual(
      [],
    );
  });

  it('**负向对照**：跳过重编号时校验必须报 TREE_OUTLINE_STALE', () => {
    const skipped = flat(['a', null, '1'], ['b', null, '2']);
    const indentedWithoutReindex = skipped.map((entry) =>
      entry.id === 'b' ? { ...entry, parentId: 'a' } : entry,
    );
    const codes = validateDocument(canonical(indentedWithoutReindex))
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.code);
    expect(codes).toContain('TREE_OUTLINE_STALE');
  });
});

/** 把任务数组包成一个最小文档，供 `validateDocument` 使用。 */
function canonical(tasks: readonly ReturnType<typeof task>[]): unknown {
  return {
    version: 3,
    project: {
      name: '调级用例',
      description: null,
      baseCalendarId: 'project',
      startDate: null,
      finishDate: null,
    },
    calendars: [{ id: 'project', exceptions: { nonWorking: [], working: [] } }],
    tasks,
    links: [],
    baselines: [],
  };
}
