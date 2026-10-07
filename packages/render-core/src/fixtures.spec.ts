/**
 * 夹具自检（判据的基准必须自身可靠）。
 *
 * 夹具是**所有几何/裁剪判据的输入**，所以它自己也要被验：
 * 精确命中声明的规模、schema 零 `error`、可排程、两次生成逐字节一致、
 * 声明的"跨屏长边 / 汇总端点边 / 折叠隐藏边"与文档一致。
 *
 * 这些数字同时是"判据有判别力"的前提：
 * 若夹具没有跨屏长边，NC1 的"端点可见性必须丢边"就会是 0，协议明文规定那是**数据无效、必须重造**。
 */

import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@ganttpilot/engine';

import {
  allDatasets,
  buildFixture,
  DATASETS,
  generateDocument,
  hiddenChildren,
  mulberry32,
  REFERENCE_DATASET,
  SCALE_GRADIENT_TASKS,
  scaleGradient,
} from './fixtures.js';
// `datasetOf` 的落点是 `fixtures.testkit.ts`（**不是本文件**）：
// 实测"把工具放进 `*.spec.ts` 再被别的 spec import"会让 vitest **连那份 spec 自己的用例
// 一起收**，本包因此从 297 例涨到 387 例。理由与探针数字写在 `fixtures.testkit.ts` 的文件头。
import { datasetOf } from '../test/fixtures.testkit.js';

describe('夹具生成器（确定性、精确规模）', () => {
  it('mulberry32 同种子逐值复现（零 Math.random）', () => {
    const a = mulberry32(404003);
    const b = mulberry32(404003);
    const seriesA = [a(), a(), a(), a(), a()];
    const seriesB = [b(), b(), b(), b(), b()];
    expect(seriesA).toStrictEqual(seriesB);
    const c = mulberry32(404004);
    expect(c()).not.toBe(seriesA[0]);
  });

  it('全部数据集精确命中任务数与依赖条数', () => {
    for (const spec of allDatasets()) {
      const { document, stats } = generateDocument(spec);
      expect(document.tasks.length).toBe(spec.tasks);
      expect(document.links.length).toBe(spec.links);
      expect(stats.taskCount).toBe(spec.tasks);
      expect(stats.linkCount).toBe(spec.links);
    }
  });

  it('两次生成逐字节一致（规范化序列化逐字符相等）', () => {
    for (const spec of DATASETS) {
      const first = buildFixture(spec);
      const second = buildFixture(spec);
      expect(serializeDocument(second.document)).toBe(serializeDocument(first.document));
      expect(second.schedule.es).toStrictEqual(first.schedule.es);
      expect(second.schedule.ef).toStrictEqual(first.schedule.ef);
      expect(second.schedule.summaryEs).toStrictEqual(first.schedule.summaryEs);
    }
  });

  it('夹具通过 schema 校验且可排程（`buildFixture` 内部已断言，这里再确认规模）', () => {
    for (const spec of allDatasets()) {
      expect(() => buildFixture(spec)).not.toThrow();
    }
  });

  it('依赖边一律沿文档序向前（不可能成环）', () => {
    for (const spec of DATASETS) {
      const { document } = generateDocument(spec);
      const indexOf = new Map(document.tasks.map((task, index) => [task.id, index]));
      const violations: string[] = [];
      for (const link of document.links) {
        const from = indexOf.get(link.from);
        const to = indexOf.get(link.to);
        if (!(typeof from === 'number' && typeof to === 'number' && to > from)) {
          violations.push(`${link.id}: ${link.from}(${String(from)}) → ${link.to}(${String(to)})`);
        }
      }
      expect(violations.slice(0, 5)).toStrictEqual([]);
    }
  });

  it('声明的跨屏长边确实存在且方向正确（长跃度）', () => {
    for (const spec of DATASETS) {
      const { document, stats } = generateDocument(spec);
      expect(stats.longEdgeIds.length).toBe(spec.longEdges);
      const indexOf = new Map(document.tasks.map((task, index) => [task.id, index]));
      for (const id of stats.longEdgeIds) {
        const link = document.links.find((item) => item.id === id);
        expect(link).toBeDefined();
        if (link === undefined) continue;
        const jump = (indexOf.get(link.to) ?? 0) - (indexOf.get(link.from) ?? 0);
        expect(jump).toBeGreaterThan(300); // 远大于一屏（32 行）
      }
    }
  });

  it('汇总端点边与折叠隐藏边与文档一致（传播忽略 / 折叠不画 的判据来源）', () => {
    for (const spec of DATASETS) {
      const { document, stats } = generateDocument(spec);
      const summaryIds = new Set(document.tasks.filter((task) => task.parentId === null && task.durationDays === null).map((task) => task.id));
      const expectedSummaryEdges = document.links
        .filter((link) => summaryIds.has(link.from) || summaryIds.has(link.to))
        .map((link) => link.id);
      expect(stats.summaryEdgeIds).toStrictEqual(expectedSummaryEdges);

      const hidden = hiddenChildren(document.tasks, spec.collapsedSummaries);
      const expectedHiddenEdges = document.links
        .filter((link) => hidden.has(link.from) || hidden.has(link.to))
        .map((link) => link.id);
      expect(stats.hiddenEdgeIds).toStrictEqual(expectedHiddenEdges);
    }
  });

  it('密集交叉夹具同时具备三种形态（汇总端点边 / 折叠隐藏边 / 跨屏长边）', () => {
    const { stats } = generateDocument(datasetOf('dense'));
    expect(stats.longEdgeIds.length).toBeGreaterThan(0);
    expect(stats.summaryEdgeIds.length).toBeGreaterThan(0);
    expect(stats.hiddenEdgeIds.length).toBeGreaterThan(0);
    expect(stats.collapsedSummaryIds.length).toBeGreaterThan(0);
  });

  it('规模梯度保持局部结构一致（每 20 个任务一个汇总 + 固定 maxJump）', () => {
    const gradient = scaleGradient(datasetOf('dense'), SCALE_GRADIENT_TASKS, 1.5);
    for (const { size, fixture } of gradient) {
      expect(fixture.document.tasks.length).toBe(size);
      expect(fixture.stats.summaryCount).toBe(Math.max(1, Math.round(size / 20)));
    }
    const keys = gradient.map((item) => item.fixture.spec.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('同尺对照数据集是 2,200 边（《评估报告》§5.4 的对标点）', () => {
    expect(REFERENCE_DATASET.links).toBe(2200);
    const { document } = generateDocument(REFERENCE_DATASET);
    expect(document.links.length).toBe(2200);
  });
});
