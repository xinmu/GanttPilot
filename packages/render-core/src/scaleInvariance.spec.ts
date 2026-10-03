/**
 * "元素数与文档总规模解耦"（ADR 0007 §6.7 / §9 ②，S4-a）。
 *
 * 判据形式：
 * - 规模梯度 200 → 2,000 任务（**10×**），同一视口/档位/滚动位置下
 *   `#elements ≤ c₁·rows + c₂·edges + c₃` 成立；
 * - 渲染行数**与规模无关**（恒 32）；
 * - 元素总数增长比 ≤ `THRESHOLDS.windowedGrowthRatio`（1.5×），G4-S 实测 **1.104×**；
 * - 对照（关掉窗口裁剪）**10.71×**（在 `clipping.spec.ts` 的 NC2 里断言）。
 *
 * **局部结构必须一致**（G4-S 的第一处实测订正）：`maxJump` 与"每 20 个任务一个汇总"固定，
 * 否则比值会被边的跨度分布污染——这是 `scaleGradient()` 存在的唯一理由。
 */

import { describe, expect, it } from 'vitest';

import { countElements } from './count.js';
import { DATASETS, SCALE_GRADIENT_LINK_RATIO, SCALE_GRADIENT_TASKS, scaleGradient } from './fixtures.js';
import { THRESHOLDS, VIEWPORT_DEFAULT, ZOOM_ORDER } from './manifest.js';
import { buildView } from './viewModel.js';

const viewport = { ...VIEWPORT_DEFAULT, scrollTop: 0, scrollLeft: 0 };
const gradient = scaleGradient(DATASETS[2], SCALE_GRADIENT_TASKS, SCALE_GRADIENT_LINK_RATIO);

describe('规模解耦（S4-a：元素预算与文档总规模无关）', () => {
  it('规模梯度是 200 / 500 / 1000 / 2000 任务，依赖数 = 1.5 × 任务数', () => {
    expect(gradient.map((item) => item.size)).toStrictEqual([...SCALE_GRADIENT_TASKS]);
    for (const { size, fixture } of gradient) {
      expect(fixture.document.tasks.length).toBe(size);
      expect(fixture.document.links.length).toBe(Math.round(size * SCALE_GRADIENT_LINK_RATIO));
    }
  });

  it('渲染行数与文档总规模无关（10× 规模跨度下恒为 32）', () => {
    const renderedRows = gradient.map(({ fixture }) => {
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport,
        zoom: 'day',
      });
      return countElements(view).renderedRows;
    });
    expect(new Set(renderedRows).size).toBe(1);
    expect(renderedRows[0]).toBe(32);
  });

  it('元素总数增长比 ≤ 1.5×（G4-S 实测 1.104×：317 → 350）', () => {
    const totals = gradient.map(({ fixture }) => {
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport,
        zoom: 'day',
      });
      return countElements(view).total;
    });
    const ratio = Math.max(...totals) / Math.min(...totals);
    expect(ratio).toBeLessThanOrEqual(THRESHOLDS.windowedGrowthRatio);
    // G4-S 的锚：200 → 2,000 任务是 350 / 317 / 329 / 335；比值 1.1041×。
    expect(totals).toStrictEqual([350, 317, 329, 335]);
    expect(ratio).toBeCloseTo(1.1041, 3);
  });

  it('三个档位下预算在全部规模上都成立，且 `c₃` 与规模无关', () => {
    for (const zoom of ZOOM_ORDER) {
      const c3Values = gradient.map(({ fixture }) => {
        const view = buildView({
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
          viewport,
          zoom,
        });
        const counts = countElements(view);
        expect(counts.withinBudget).toBe(true);
        return counts.c3;
      });
      // c₃ 只与"视口宽 ÷ pxPerDay"有关 —— 同一档位下必须恒定。
      expect(new Set(c3Values).size).toBe(1);
    }
  });

  it('文档总边数在 10× 规模上确实增长了（否则"与规模无关"没有观测对象）', () => {
    const linkCounts = gradient.map(({ fixture }) => fixture.document.links.length);
    expect(Math.max(...linkCounts) / Math.min(...linkCounts)).toBeCloseTo(10, 0);
  });
});
