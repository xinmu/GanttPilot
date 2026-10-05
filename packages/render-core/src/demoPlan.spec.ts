/**
 * 演示计划的判据（**进 `pnpm gate`**，裁决 P-34）。
 *
 * 演示计划是**页面默认文档**、也是 G7「模板 A 可重复生成」的 golden 主体，
 * 因此它自己要被验：规模、四类关系、无 error、良性 warning 的**条数钉住**、
 * 可排程、跨度上界（"单页可容纳"的可判定形式）、两次调用逐字节一致。
 *
 * ## 为什么 warning 也要钉住条数
 *
 * "有工期、无日期"（DM-05）是**合法表达**，它必然产出 `TASK_DURATION_WITHOUT_DATES`；
 * 演示计划不许靠给每个任务硬塞 `startDate` 消掉它（那会破坏"拖动改期"的演示语义）。
 * 因此这里把 warning 的**码集合与条数**都写成期望值：良性噪声有登记，
 * 真问题就藏不进"反正有一堆 warning"里。
 */

import { describe, expect, it } from 'vitest';
import { compute, createScheduleCalendar, LEAF_SENTINEL, serializeDocument, validateDocument } from '@ganttpilot/engine';

import { createDemoPlanDocument } from './demoPlan.js';

/** 汇总行的下标（`durationDays === null` ⇒ 不参与传播）。 */
function summaryIndexesOf(tasks: readonly { readonly durationDays: number | null }[]): readonly number[] {
  return tasks.flatMap((task, index) => (task.durationDays === null ? [index] : []));
}

describe('演示计划（演示口径：单页可读 + 四类关系齐备）', () => {
  it('规模固定为 15 行 / 14 条依赖（3 汇总 + 10 任务 + 2 里程碑）', () => {
    const document = createDemoPlanDocument();
    expect(document.tasks.length).toBe(15);
    expect(document.links.length).toBe(14);
    expect(document.tasks.filter((task) => task.durationDays === null)).toHaveLength(3);
    expect(document.tasks.filter((task) => task.milestone)).toHaveLength(2);
    expect(document.baselines).toStrictEqual([]);
    expect(document.project.startDate).toBe('2026-10-05');
  });

  it('WBS 编号由层级派生（`reindexDocument` 已应用）', () => {
    const document = createDemoPlanDocument();
    expect(document.tasks.map((task) => task.outlineNumber)).toStrictEqual([
      '1',
      '1.1',
      '1.2',
      '1.3',
      '1.4',
      '2',
      '2.1',
      '2.2',
      '2.3',
      '2.4',
      '2.5',
      '3',
      '3.1',
      '3.2',
      '3.3',
    ]);
  });

  it('schema 零 `error`；良性 warning 恰为 11 条且同码', () => {
    const diagnostics = validateDocument(createDemoPlanDocument());
    expect(diagnostics.filter((item) => item.severity === 'error')).toStrictEqual([]);
    expect(new Set(diagnostics.map((item) => item.code))).toStrictEqual(new Set(['TASK_DURATION_WITHOUT_DATES']));
    expect(diagnostics).toHaveLength(11);
  });

  it('依赖四类关系齐备、含负 lag，且 id 唯一、端点存在、只沿文档序向前', () => {
    const document = createDemoPlanDocument();
    expect(new Set(document.links.map((link) => link.type))).toStrictEqual(new Set(['FS', 'SS', 'FF', 'SF']));
    expect(document.links.some((link) => link.lagDays < 0)).toBe(true);

    const ids = document.links.map((link) => link.id);
    expect(new Set(ids).size).toBe(ids.length);
    const indexOf = new Map(document.tasks.map((task, index) => [task.id, index]));
    for (const link of document.links) {
      const from = indexOf.get(link.from);
      const to = indexOf.get(link.to);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect((to ?? 0) > (from ?? 0)).toBe(true);
    }
  });

  it('里程碑工期为 0 且标记为里程碑；非汇总非里程碑的工期为正；链路起点显式锚定在项目起点', () => {
    const document = createDemoPlanDocument();
    for (const task of document.tasks) {
      if (task.durationDays === null) {
        // 汇总行：不参与传播，工期一律 `null`（SCHEMA.md §2.1）。
        expect(task.milestone).toBe(false);
        continue;
      }
      expect(task.milestone).toBe(task.durationDays === 0);
      if (task.milestone) expect(task.durationDays).toBe(0);
      else expect(task.durationDays).toBeGreaterThan(0);
    }
    const anchored = document.tasks.filter((task) => task.startDate !== null).map((task) => task.id);
    expect(anchored).toStrictEqual(['t1']);
  });

  it('可排程：`compute` ok、零排程诊断、三个汇总进度 82% / 24% / 0（P-34 的演示形态）', () => {
    const document = createDemoPlanDocument();
    const result = compute(document, createScheduleCalendar(document));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schedule.diagnostics).toStrictEqual([]);
    const summaryIndexes = summaryIndexesOf(document.tasks);
    expect(summaryIndexes).toStrictEqual([0, 5, 11]);
    const summaryProgress = summaryIndexes.map((index) => result.schedule.summaryProgress[index] ?? Number.NaN);
    // (5×1.0 + 3×0.8 + 4×0.6 + 0×1.0) / (5+3+4+0) = 9.8 / 12 = 49/60。
    expect(summaryProgress[0]).toBeCloseTo(49 / 60, 10);
    // (3×0.5 + 8×0.25 + 8×0.25 + 4×0 + 0×0) / (3+8+8+4+0) = 5.5 / 23。
    expect(summaryProgress[1]).toBeCloseTo(5.5 / 23, 10);
    expect(summaryProgress[2]).toBe(0);
    // 非汇总行的哨兵不被写坏（形状与引擎不变量一致）。
    expect(result.schedule.summaryProgress[1]).toBe(LEAF_SENTINEL);
  });

  it('跨度 ≤ 40 个工作日（"单页 16:9 可容纳"的可判定形式）', () => {
    const document = createDemoPlanDocument();
    const result = compute(document, createScheduleCalendar(document));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const es = [...result.schedule.es].filter((value) => value >= 0);
    const ef = [...result.schedule.ef].filter((value) => value >= 0);
    const span = Math.max(...ef) - Math.min(...es);
    expect(span).toBeLessThanOrEqual(40);
  });

  it('两次调用逐字节一致（零随机；"模板 A 可重复生成"的 golden 前置）', () => {
    expect(serializeDocument(createDemoPlanDocument())).toBe(serializeDocument(createDemoPlanDocument()));
  });
});
