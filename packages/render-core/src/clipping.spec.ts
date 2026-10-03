/**
 * ADR 0007 §9 的第 ② ④ 层（**进 `pnpm gate`**）：裁剪结构断言与元素预算，外加两条**必须存在**的负向对照。
 *
 * 没有负向对照，"元素数与文档总规模无关"就可能是恒真式（§6.8 点名要求）：
 * - **NC1**：把求交换成端点可见性裁剪，必须被检出丢边；
 * - **NC2**：关掉窗口裁剪，必须被检出元素数随规模增长。
 *
 * 期望数字来自 G4-S（`spikes/g0-s4-svg-clipping/evidence/clipping-report.md`，该目录已随 G4 落地删除，
 * 数字转入本 spec 作为回归锚）：
 * - 12/12 组在预算内；`c₃ = 116 / 70 / 89`（日/周/月）；
 * - 4 个滚动位置误裁 **33 / 97 / 96 / 88 = 314** 条（其中跨屏长边 268）；
 * - 关掉窗口裁剪的元素数 **1,348 / 3,524 / 7,170 / 14,439**（比值 10.71×）。
 */

import { describe, expect, it } from 'vitest';

import { countElements, countElementsByEnumeration } from './count.js';
import { DATASETS, REFERENCE_DATASET, SCROLL_ROW_OFFSETS, buildFixture, scaleGradient } from './fixtures.js';
import { ELEMENT_MODEL, ROW_HEIGHT, THRESHOLDS, VIEWPORT_DEFAULT, ZOOM_ORDER } from './manifest.js';
import { buildView } from './viewModel.js';
import { checkClipSoundness } from './checkers.spec.js';

const viewport = { ...VIEWPORT_DEFAULT, scrollTop: 0, scrollLeft: 0 };

describe('元素预算（ADR 0007 §6.7，S4-a）', () => {
  it('12 组（4 数据集 × 3 档位）全部满足 `#elements ≤ c₁·rows + c₂·edges + c₃`', () => {
    const failures: string[] = [];
    for (const spec of [...DATASETS, REFERENCE_DATASET]) {
      const fixture = buildFixture(spec);
      for (const zoom of ZOOM_ORDER) {
        const view = buildView({
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
          viewport,
          zoom,
        });
        const counts = countElements(view);
        if (!counts.withinBudget) {
          failures.push(`${spec.key}/${zoom}: ${String(counts.total)} > ${String(counts.bound)}`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it('渲染行恒为 32、`c₃` 逐档位为 116 / 70 / 89（G4-S 实测锚）', () => {
    const expectedC3: Record<string, number> = { day: 116, week: 70, month: 89 };
    const worst: string[] = [];
    for (const spec of [...DATASETS, REFERENCE_DATASET]) {
      const fixture = buildFixture(spec);
      for (const zoom of ZOOM_ORDER) {
        const view = buildView({
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
          viewport,
          zoom,
        });
        const counts = countElements(view);
        if (counts.renderedRows !== 32 || counts.c3 !== expectedC3[zoom]) {
          worst.push(
            `${spec.key}/${zoom}: rows=${String(counts.renderedRows)} c3=${String(counts.c3)}（期望 32 / ${String(expectedC3[zoom])}）`,
          );
        }
      }
    }
    expect(worst).toStrictEqual([]);
  });

  it('元素模型与预算常数是同一处声明（`c₁ = 3`、`c₂ = 3`）', () => {
    expect(ELEMENT_MODEL).toStrictEqual({ perRenderedRow: 3, perRenderedEdge: 3 });
    const fixture = buildFixture(DATASETS[2]);
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport,
      zoom: 'day',
    });
    const counts = countElements(view);
    expect(counts.c1).toBe(ELEMENT_MODEL.perRenderedRow);
    expect(counts.c2).toBe(ELEMENT_MODEL.perRenderedEdge);
  });

  it('两路计数逐项相等（分类累加 vs 逐项枚举）——否则预算是恒真式', () => {
    for (const spec of DATASETS) {
      const fixture = buildFixture(spec);
      for (const zoom of ZOOM_ORDER) {
        const view = buildView({
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
          viewport,
          zoom,
        });
        const byCategory = countElements(view);
        const byEnumeration = countElementsByEnumeration(view);
        expect(byEnumeration.total).toBe(byCategory.total);
        expect(byEnumeration.kinds['row-group']).toBe(byCategory.rowGroups);
        expect((byEnumeration.kinds['bar-rect'] ?? 0) + (byEnumeration.kinds['milestone-polygon'] ?? 0)).toBe(
          byCategory.bars + byCategory.milestones,
        );
        expect(byEnumeration.kinds['progress-rect'] ?? 0).toBe(byCategory.progressFills);
        expect(byEnumeration.kinds['edge-path']).toBe(byCategory.edgePaths);
        expect(byEnumeration.kinds['edge-arrow']).toBe(byCategory.edgeArrows);
        expect(byEnumeration.kinds['edge-hit-area']).toBe(byCategory.edgeHitAreas);
      }
    }
  });
});

describe('裁剪健全性（S4-b 的正面表述）', () => {
  for (const spec of DATASETS) {
    it(`${spec.name}·求交路径一条边都不丢；折叠隐藏的行在两条路径下都不画其边`, () => {
      const fixture = buildFixture(spec);
      const intersect = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport,
        zoom: 'day',
      });
      const endpoints = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport,
        zoom: 'day',
        clipMode: 'endpoints',
      });
      const checks = checkClipSoundness({ intersectView: intersect, endpointView: endpoints });
      expect(checks.filter((row) => !row.pass).map((row) => `${row.name} —— ${row.detail}`)).toStrictEqual([]);
      // 折叠隐藏边：两条路径都不渲染（这就是 §6.3 的可执行判据）。
      const hiddenIds = new Set(fixture.stats.hiddenEdgeIds);
      expect(fixture.stats.hiddenEdgeIds.length).toBe(intersect.hiddenEdges.length);
      for (const index of intersect.hiddenEdges) {
        expect(hiddenIds.has(fixture.document.links[index]?.id ?? '')).toBe(true);
      }
    });
  }
});

describe('NC1 负向对照：端点可见性裁剪必须丢边（ADR 0007 §6.8，S4-b）', () => {
  it('4 个滚动位置分别误裁 33 / 97 / 96 / 88 条，合计 314（其中跨屏长边 268）', () => {
    const fixture = buildFixture(DATASETS[2]);
    const expectedLost = [33, 97, 96, 88];
    const expectedSpanning = [32, 84, 81, 71];
    const positions: { lost: number; lostSpanning: number }[] = [];

    SCROLL_ROW_OFFSETS.forEach((offset) => {
      const base = {
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport: { ...viewport, scrollTop: offset * ROW_HEIGHT },
        zoom: 'day' as const,
      };
      const intersect = buildView({ ...base, clipMode: 'intersect' });
      const endpoints = buildView({ ...base, clipMode: 'endpoints' });
      const intersectIds = new Set(intersect.edges.map((edge) => edge.linkId));
      const endpointIds = new Set(endpoints.edges.map((edge) => edge.linkId));
      const lost = [...intersectIds].filter((id) => !endpointIds.has(id));
      const spanningIds = new Set(
        intersect.spanningEdges
          .map((index) => fixture.document.links[index]?.id)
          .filter((id): id is string => id !== undefined),
      );
      positions.push({ lost: lost.length, lostSpanning: lost.filter((id) => spanningIds.has(id)).length });
    });

    expect(positions.map((row) => row.lost)).toStrictEqual(expectedLost);
    expect(positions.map((row) => row.lostSpanning)).toStrictEqual(expectedSpanning);
    expect(positions.reduce((acc, row) => acc + row.lost, 0)).toBe(314);
    expect(positions.reduce((acc, row) => acc + row.lostSpanning, 0)).toBe(268);

    // 判据形式（与协议一致）：每个位置至少丢 1 条、合计至少丢 5 条。
    expect(
      positions.every((row) => row.lost >= THRESHOLDS.minCrossScreenLossPerPosition),
    ).toBe(true);
    expect(positions.reduce((acc, row) => acc + row.lost, 0)).toBeGreaterThanOrEqual(
      THRESHOLDS.totalCrossScreenLoss,
    );
  });
});

describe('NC2 负向对照：关掉窗口裁剪必须随规模增长（ADR 0007 §6.8，S4-a）', () => {
  it('元素数随规模单调增长，10× 规模跨度的比值 10.71× > 5×', () => {
    const totals: number[] = [];
    const renderedRows: number[] = [];
    for (const { fixture } of scaleGradient(DATASETS[2])) {
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        // "关掉窗口裁剪" = 缓冲行设为整篇，于是"渲染行 = 全部可见行"。
        viewport: { ...viewport, scrollTop: 0, rowBuffer: fixture.document.tasks.length },
        zoom: 'day',
        clipMode: 'none',
      });
      const counts = countElements(view);
      totals.push(counts.total);
      renderedRows.push(counts.renderedRows);
      // 关掉裁剪后，渲染行数必须与文档规模同阶（这就是判据的被测对象）。
      expect(counts.renderedRows).toBe(fixture.document.tasks.length - fixture.stats.hiddenIds.length);
    }

    // 单调增长（每一档都比上一档大一个量级）。
    for (let index = 1; index < totals.length; index += 1) {
      expect(totals[index] ?? 0).toBeGreaterThan(totals[index - 1] ?? 0);
    }
    const ratio = Math.max(...totals) / Math.min(...totals);
    expect(ratio).toBeCloseTo(10.71, 1);
    expect(ratio).toBeGreaterThan(THRESHOLDS.nc2GrowthRatio);
    // 判别力：与窗口路径（≈1.1×）差一个数量级。
    expect(ratio).toBeGreaterThan(5 * THRESHOLDS.windowedGrowthRatio);
    // 渲染行数也从 162 → 1,962 增长（10× 以上），与"恒 32 行"形成对照。
    expect(renderedRows[0]).toBeLessThan(200);
    expect(renderedRows[renderedRows.length - 1] ?? 0).toBeGreaterThan(1900);
  });
});
