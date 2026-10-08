/**
 * "受影响行 + 受影响边"（ADR 0007 §8 的出口条件：**行内编辑不破坏虚拟化与裁剪**，
 * 走"受影响行 + 受影响边"路径而**不触发整表重建**）。
 *
 * 判据必须在 Node 侧可判定——它不是"看起来没重建"，而是"重绘集合恰好是这些行与边"：
 * - **闭包承重**：改动一个任务，其后继闭包必须在集合里；
 * - **祖先承重**：汇总条的几何依赖整棵子树，祖先链必须在集合里（`affectedClosure` 不含祖先，
 *   SCHEDULE.md §八 已声明这是调用方责任）；
 * - **最小性**：与两次编辑都无关的行与边不得入选；
 * - **确定性**：同一输入两次调用结果逐项相同，且与种子顺序无关。
 */

import { describe, expect, it } from 'vitest';

import type { ProjectDocument } from '@ganttpilot/engine';

import { affectedRenderSet } from './affected.js';
import { buildFixture } from './fixtures.js';
import { datasetOf } from '../test/fixtures.testkit.js';

const fixture = buildFixture(datasetOf('dense'));

function taskOf(document: ProjectDocument, id: string): number {
  return document.tasks.findIndex((task) => task.id === id);
}

describe('受影响渲染集（ADR 0007 §8）', () => {
  it('改动一个叶子：闭包含其后继、祖先链含其所有祖先', () => {
    // 找一个有入边也有出边、且挂在汇总下的叶子。
    const target = fixture.document.tasks.find(
      (task) =>
        task.parentId !== null &&
        fixture.document.links.some((link) => link.from === task.id) &&
        fixture.document.links.some((link) => link.to === task.id),
    );
    expect(target).toBeDefined();
    if (target === undefined) return;

    const affected = affectedRenderSet(fixture.document, [target.id]);
    const closureIds = new Set(affected.closure);
    const ancestorIds = new Set(affected.ancestors);

    // 后继闭包在集合里。
    const successors = fixture.document.links.filter((link) => link.from === target.id).map((link) => link.to);
    expect(successors.length).toBeGreaterThan(0);
    for (const id of successors) {
      expect(closureIds.has(id)).toBe(true);
      expect(affected.rows).toContain(taskOf(fixture.document, id));
    }
    // 祖先链在集合里（`affectedClosure` 不含祖先）。
    expect(ancestorIds.has(target.parentId ?? '')).toBe(true);
    expect(affected.rows).toContain(taskOf(fixture.document, target.parentId ?? ''));
    // 种子自身也在（`affectedClosure` 含种子本身）。
    expect(closureIds.has(target.id)).toBe(true);
  });

  it('边集合 = 任一端点受影响的全部边（边的几何只由两端点决定）', () => {
    const target = fixture.document.tasks[5];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const affected = affectedRenderSet(fixture.document, [target.id]);
    const rows = new Set(affected.rows);
    const expectedEdges: number[] = [];
    fixture.document.links.forEach((link, index) => {
      const from = taskOf(fixture.document, link.from);
      const to = taskOf(fixture.document, link.to);
      if (rows.has(from) || rows.has(to)) expectedEdges.push(index);
    });
    expect(affected.edges).toStrictEqual(expectedEdges);
  });

  it('最小性：与编辑无关的行不入选（存在大量无关行与无关边）', () => {
    // 深链上"受影响子图可达全图"是已知事实（SCHEDULE.md §八），所以种子取**文档末段**的任务：
    // 它没有后继、祖先链也短，受影响集必须显著小于全图。
    const target = fixture.document.tasks[fixture.document.tasks.length - 3];
    if (target === undefined) throw new Error('缺少测试任务');
    const affected = affectedRenderSet(fixture.document, [target.id]);
    expect(affected.rows.length).toBeLessThan(fixture.document.tasks.length / 2);
    expect(affected.edges.length).toBeLessThan(fixture.document.links.length / 2);
    // 确实存在无关行（否则"最小性"没有观测对象）。
    const rows = new Set(affected.rows);
    const unrelated = fixture.document.tasks.filter((_, index) => !rows.has(index));
    expect(unrelated.length).toBeGreaterThan(0);
  });

  it('确定性：同一输入两次调用逐项相同，且与种子顺序无关', () => {
    const seeds = ['t1', 't50', 't900'];
    const first = affectedRenderSet(fixture.document, seeds);
    const second = affectedRenderSet(fixture.document, [...seeds].reverse());
    expect(second.rows).toStrictEqual(first.rows);
    expect(second.edges).toStrictEqual(first.edges);
    // 文档序：rows 升序去重。
    expect([...first.rows].sort((left, right) => left - right)).toStrictEqual(first.rows);
    expect(new Set(first.rows).size).toBe(first.rows.length);
  });

  it('负向对照①：抽掉祖先链，汇总条所在的行必须漏项', () => {
    const target = fixture.document.tasks.find((task) => task.parentId !== null);
    if (target === undefined) throw new Error('缺少挂在汇总下的任务');
    const withAncestors = affectedRenderSet(fixture.document, [target.id]);
    const parentIndex = taskOf(fixture.document, target.parentId ?? '');
    expect(withAncestors.rows).toContain(parentIndex);
    // 模拟"只取闭包、不补祖先"的错误实现：父行必须不在闭包投影里。
    const closureOnlyRows = withAncestors.closure
      .map((id) => taskOf(fixture.document, id))
      .filter((index) => index >= 0);
    expect(closureOnlyRows).not.toContain(parentIndex);
  });

  it('负向对照②：抽掉闭包，后继所在的行必须漏项', () => {
    const link = fixture.document.links.find((item) => item.from !== item.to);
    if (link === undefined) throw new Error('缺少依赖边');
    const target = link.from;
    const affected = affectedRenderSet(fixture.document, [target]);
    const toIndex = taskOf(fixture.document, link.to);
    expect(affected.rows).toContain(toIndex);
    // 只报种子本身的错误实现会漏掉它。
    expect([taskOf(fixture.document, target)]).not.toContain(toIndex);
  });

  it('未知 taskId 的种子被忽略（不抛错、不产生诊断）', () => {
    const affected = affectedRenderSet(fixture.document, ['不存在-1', '不存在-2']);
    expect(affected.rows).toStrictEqual([]);
    expect(affected.edges).toStrictEqual([]);
  });
});
