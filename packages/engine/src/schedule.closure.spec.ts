import { describe, expect, it } from 'vitest';

import { type DocumentLink, type DocumentTask } from './schema.js';
import { affectedClosure } from './schedule.js';
import { fixtureDocument, fixtureTask, largeScheduleProject } from './scheduleFixtures.spec.js';

/**
 * **受影响闭包**（ADR 0004 §8）：G4 的"不做整表重建"与 G5 的"受影响子图"都建在它上面。
 *
 * 按裁决 P-12 **只断言结构性事实**（闭包规模、深链覆盖全图、文档序、与种子顺序无关），
 * **不加时序门禁**——会抖动的 p99 断言只制造假失败。
 *
 * 已知边界（SCHEDULE.md §八）：它只做**后继**闭包，**不含祖先**——
 * G4 渲染汇总条时需自行沿 `parentId` 补祖先链。
 */

function chain(length: number): { tasks: DocumentTask[]; links: DocumentLink[] } {
  const tasks: DocumentTask[] = [];
  const links: DocumentLink[] = [];
  for (let i = 0; i < length; i += 1) {
    tasks.push(fixtureTask({ id: `t${String(i)}`, durationDays: 1 }));
    if (i > 0) {
      links.push({ id: `l${String(i)}`, from: `t${String(i - 1)}`, to: `t${String(i)}`, type: 'FS', lagDays: 0 });
    }
  }
  return { tasks, links };
}

describe('G2 闭包：结构性事实', () => {
  it('链上的闭包是"后缀"，种子本身在内（含自身）', () => {
    const { tasks, links } = chain(6);
    const doc = fixtureDocument(tasks, links);
    expect(affectedClosure(doc, ['t0'])).toStrictEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    expect(affectedClosure(doc, ['t4'])).toStrictEqual(['t4', 't5']);
    expect(affectedClosure(doc, ['t5'])).toStrictEqual(['t5']);
    expect(affectedClosure(doc, [])).toStrictEqual([]);
    expect(affectedClosure(doc, ['不存在'])).toStrictEqual([]);
  });

  it('分支与扇入：闭包取可达集合，不重复也不漏', () => {
    const doc = fixtureDocument(
      [
        fixtureTask({ id: 'a' }),
        fixtureTask({ id: 'b' }),
        fixtureTask({ id: 'c' }),
        fixtureTask({ id: 'd' }),
        fixtureTask({ id: 'e' }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'a', to: 'c', type: 'FS', lagDays: 0 },
        { id: 'l3', from: 'b', to: 'd', type: 'FS', lagDays: 0 },
        { id: 'l4', from: 'c', to: 'd', type: 'FS', lagDays: 0 },
        { id: 'l5', from: 'd', to: 'e', type: 'FS', lagDays: 0 },
      ],
    );
    expect(affectedClosure(doc, ['a'])).toStrictEqual(['a', 'b', 'c', 'd', 'e']);
    expect(affectedClosure(doc, ['b', 'c'])).toStrictEqual(['b', 'c', 'd', 'e']);
    expect(affectedClosure(doc, ['d'])).toStrictEqual(['d', 'e']);
    // 结果与种子顺序、重复种子无关（去重 + 文档序输出）。
    expect(affectedClosure(doc, ['c', 'b'])).toStrictEqual(affectedClosure(doc, ['b', 'c']));
    expect(affectedClosure(doc, ['a', 'a', 'b'])).toStrictEqual(affectedClosure(doc, ['a']));
  });

  it('沿全部出边遍历（含传播上被忽略的汇总端点边），但不含祖先', () => {
    const doc = fixtureDocument(
      [
        fixtureTask({ id: 'w1', name: '阶段' }),
        fixtureTask({ id: 'leaf', parentId: 'w1', durationDays: 2 }),
        fixtureTask({ id: 'other', parentId: 'w1', durationDays: 1 }),
        fixtureTask({ id: 'downstream', durationDays: 1 }),
      ],
      [
        { id: 'l1', from: 'leaf', to: 'w1', type: 'FS', lagDays: 0 }, // 汇总端点：传播忽略，闭包照收
        { id: 'l2', from: 'w1', to: 'downstream', type: 'FS', lagDays: 0 },
      ],
    );
    // 宽进：leaf → w1 → downstream 全部收进来（多收行不会出错，少收行会留下脏几何）。
    expect(affectedClosure(doc, ['leaf'])).toStrictEqual(['w1', 'leaf', 'downstream']);
    // 反向不是后继关系：从 other 出发只有它自己（它不是任何边的起点）。
    expect(affectedClosure(doc, ['other'])).toStrictEqual(['other']);
  });

  it('深链上闭包覆盖全图，且与图规模解耦（不是恒为全图）', () => {
    const { tasks, links } = chain(1000);
    const doc = fixtureDocument(tasks, links);
    const fromHead = affectedClosure(doc, ['t0']);
    expect(fromHead).toHaveLength(1000);
    expect(fromHead[0]).toBe('t0');
    expect(fromHead[999]).toBe('t999');
    expect(affectedClosure(doc, ['t999'])).toStrictEqual(['t999']);
    expect(affectedClosure(doc, ['t500'])).toHaveLength(500);
  });

  it('性能规模的数据集上闭包仍然是纯结构查询（不依赖排程结果）', () => {
    const project = largeScheduleProject(1000, 1500, 4242);
    const ids = project.document.tasks.map((task) => task.id);
    // 取一条真实依赖的起点作种子（保证它至少有 1 个后继）。
    const seed = project.document.links[0]!.from;
    const closure = affectedClosure(project.document, [seed]);
    expect(closure).toContain(seed);
    expect(closure.length).toBeGreaterThan(1);
    expect(closure.length).toBeLessThanOrEqual(ids.length);
    for (const id of closure) {
      expect(ids).toContain(id);
    }
    // 闭包结果与"是否调用过 compute"无关（它是纯结构查询）。
    expect(affectedClosure(project.document, [seed])).toStrictEqual(closure);
  });
});
