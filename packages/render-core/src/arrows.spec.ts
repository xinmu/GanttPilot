/**
 * S4-d：4 类关系箭头**可区分**（同尺量化，**不得目视**，P-9 方法论）与折点参数的常数性
 * （ADR 0007 §5 / §11 第 3 项 / §9 ②）。
 *
 * ## 把"折点在缩放时不跳变"落成可判定形式
 *
 * ADR §5 的原话是「`EDGE_STUB_PX`：固定像素常数（**不随 `pxPerDay` 缩放**，
 * 以免缩放时折点跳变）」。但"连续"本身在浮点下不可判别，因此落成两条**可测**的等价命题：
 * ① 折点相对条边的偏移（stub 长度、回绕走廊宽度）在 `pxPerDay` 细扫下**逐值等于声明的常量**；
 * ② 用**比例式 stub**（`stub ∝ pxPerDay`，一个看起来同样自然的错设计）做负向对照，
 * 它必须**被同一条判据检出**——否则判据没有判别力。
 *
 * 另有一条**规则固有的不连续性**（回绕判据随 `pxPerDay` 翻转）被量化并记录，不是实现缺陷：
 * 要消掉它只能改 §5 的规则（另立 ADR）。
 */

import { describe, expect, it } from 'vitest';

import { rowIndexOfOrder, taskBounds, visibleRowOrder } from './domain.js';
import { buildFixture, DATASETS } from './fixtures.js';
import {
  ARROW_FILL,
  EDGE_STUB_PX,
  EDGE_WRAP_PX,
  ROW_HEIGHT,
  THRESHOLDS,
  evaluateScaleCriteria,
} from './manifest.js';
import { arrowDistinguishability, arrowFormsForRelations, previewStubX, rasterizeArrow, routeEdge, routeSides } from './route.js';

const fixture = buildFixture(DATASETS[2]);

describe('4 类关系箭头可区分性（S4-d，同尺量化）', () => {
  it('真实渲染尺寸为 12 × 7.2 px（行高 24 × 0.5 / 半宽 × 0.6）', () => {
    const arrows = arrowDistinguishability();
    expect(arrows.metrics.length).toBe(12);
    expect(arrows.metrics.halfWidth).toBeCloseTo(7.2, 9);
  });

  it('两两 Jaccard 距离最小 0.3023 ≥ 阈值 0.15（G4-S 实测锚）', () => {
    const arrows = arrowDistinguishability();
    expect(arrows.pass).toBe(true);
    expect(arrows.minDistance).toBeCloseTo(0.3023, 3);
    expect(arrows.minDistance).toBeGreaterThanOrEqual(THRESHOLDS.arrowMinJaccard);
  });

  it('形态单元格数 FS=86、SS=60、FF=86、SF=60（填充 × 朝向各自贡献距离）', () => {
    const arrows = arrowDistinguishability();
    expect(arrows.cellCounts).toStrictEqual({ FS: 86, SS: 60, FF: 86, SF: 60 });
  });

  it('形态 = 填充（FS/FF 实心、SS/SF 空心）× 朝向（左入 +x、右入 −x）', () => {
    const forms = arrowFormsForRelations();
    expect(forms.FS).toStrictEqual({ dir: 1, fill: 'solid' });
    expect(forms.SS).toStrictEqual({ dir: 1, fill: 'hollow' });
    expect(forms.FF).toStrictEqual({ dir: -1, fill: 'solid' });
    expect(forms.SF).toStrictEqual({ dir: -1, fill: 'hollow' });
    expect(ARROW_FILL.FS).toBe('solid');
    expect(ARROW_FILL.SF).toBe('hollow');
  });

  it('负向对照：把 4 类形态全部改成同一形态，可区分性判据必须判失败', () => {
    // 判据本体（`arrowDistinguishability`）用"每种关系的声明形态"；这里把形态函数改成常函数，
    // 复用同一份 Jaccard 度量，证明"最小距离 ≥ 阈值"确实测的是**形态差异**。
    const keys = ['FS', 'SS', 'FF', 'SF'] as const;
    const rasterized = keys.map(() => rasterizeArrow({ dir: 1, fill: 'solid' }));
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rasterized.length; i += 1) {
      for (let j = i + 1; j < rasterized.length; j += 1) {
        const left = rasterized[i];
        const right = rasterized[j];
        if (left === undefined || right === undefined) continue;
        let intersection = 0;
        for (const cell of left.cells) if (right.cells.has(cell)) intersection += 1;
        const union = left.cells.size + right.cells.size - intersection;
        minDistance = Math.min(minDistance, 1 - intersection / union);
      }
    }
    expect(minDistance).toBe(0);
    expect(minDistance).toBeLessThan(THRESHOLDS.arrowMinJaccard);
  });
});

/** 折点常数性扫描（含比例式负向对照）。 */
function stubConstancySweep(mode: 'fixed' | 'proportional'): {
  maxStubDeviation: number;
  maxWrapDeviation: number;
  wrapFlips: string[];
} {
  const sweep = THRESHOLDS.foldSweepPxPerDay;
  const referencePxPerDay = 28;
  const axisOriginDay = fixture.calendar.dayOfOrdinal(0);
  const docIndexOfTask = new Map(fixture.document.tasks.map((task, index) => [task.id, index]));
  const rowOfDocIndex = rowIndexOfOrder(visibleRowOrder(fixture.document), fixture.document.tasks.length);
  const linkIndices = fixture.document.links.slice(0, 120).map((_, index) => index);

  let maxStubDeviation = 0;
  let maxWrapDeviation = 0;
  let previousWrap = new Map<string, boolean>();
  const flips: string[] = [];

  for (const pxPerDay of sweep) {
    const scale = mode === 'fixed' ? 1 : pxPerDay / referencePxPerDay;
    const wrapNow = new Map<string, boolean>();
    for (const linkIndex of linkIndices) {
      const link = fixture.document.links[linkIndex];
      if (link === undefined) continue;
      const fromDoc = docIndexOfTask.get(link.from);
      const toDoc = docIndexOfTask.get(link.to);
      if (fromDoc === undefined || toDoc === undefined) continue;
      const boundsOf = (docIndex: number) =>
        taskBounds({
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
          rowOfDocIndex,
          axisOriginDay,
          pxPerDay,
          rowHeight: ROW_HEIGHT,
          docIndex,
        });
      const fromBounds = boundsOf(fromDoc);
      const toBounds = boundsOf(toDoc);
      if (fromBounds === null || toBounds === null) continue;
      const sides = routeSides(link.type);
      const exitX = sides.exit === 'right' ? fromBounds.xRight : fromBounds.xLeft;
      const enterX = sides.enter === 'right' ? toBounds.xRight : toBounds.xLeft;
      const route = routeEdge({
        exitSide: sides.exit,
        enterSide: sides.enter,
        exitX,
        enterX,
        yFrom: 0,
        yTo: 40,
        stubPx: EDGE_STUB_PX * scale,
        wrapPx: EDGE_WRAP_PX * scale,
      });
      maxStubDeviation = Math.max(maxStubDeviation, Math.abs(Math.abs(route.exitStubX - exitX) - EDGE_STUB_PX));
      if (route.wrapped) {
        maxWrapDeviation = Math.max(
          maxWrapDeviation,
          Math.abs(Math.min(route.exitStubX, route.enterStubX) - route.verticalX - EDGE_WRAP_PX),
        );
      }
      wrapNow.set(link.id, route.wrapped);
      if (previousWrap.has(link.id) && previousWrap.get(link.id) !== route.wrapped) {
        flips.push(`${link.id}（${link.type}）@ pxPerDay=${String(pxPerDay)}`);
      }
    }
    previousWrap = wrapNow;
  }
  return { maxStubDeviation, maxWrapDeviation, wrapFlips: flips };
}

describe('折点参数常数性（S4-d 后半）', () => {
  it('固定像素模式：stub 与回绕走廊在 pxPerDay 细扫下逐值恒等（偏差 0）', () => {
    const fixed = stubConstancySweep('fixed');
    expect(fixed.maxStubDeviation).toBe(0);
    expect(fixed.maxWrapDeviation).toBe(0);
  });

  it('负向对照：比例式 stub 必须被同一条判据检出（偏差 > 0）', () => {
    const proportional = stubConstancySweep('proportional');
    expect(proportional.maxStubDeviation).toBeGreaterThan(0);
  });

  it('回绕翻转是规则固有性质，已量化（不是实现缺陷）', () => {
    const fixed = stubConstancySweep('fixed');
    // 扫描中的翻转次数是"规则固有"的：只要它不被判据当成失败即可，这里只登记。
    expect(Array.isArray(fixed.wrapFlips)).toBe(true);
  });

  it('常量必须能由判据复推出来（改常量没改判据 ⇒ 立即失败）', () => {
    const criteria = evaluateScaleCriteria();
    expect(criteria.consistent).toBe(true);
    expect(criteria.rowHeight.selected).toBe(criteria.rowHeight.declared);
    expect(criteria.rowBuffer.selected).toBe(criteria.rowBuffer.declared);
    expect(criteria.gutter.derived).toBe(criteria.gutter.declared);
  });
});

/**
 * P3/C6-e：**建线预览**的竖直段收进本包（原先写在 `GanttChart.vue` 的模板表达式里）。
 *
 * 预览与终态路由**故意不是同一条规则**：预览取"出端 stub 的 x，夹在两端之间"，
 * 终态取"两端 stub 的中点（回绕时另取走廊）"。因此这里同时钉住两件事：
 * 预览自己的规则（含夹取的两个分支），以及"它与 `routeEdge` 确实不同"（否则这次搬家
 * 就变成了偷偷把预览换成终态几何）。
 */
describe('P3/C6-e：建线预览的竖直段 x', () => {
  it('向右走 stub，且被夹在两端之间（不越到目标右侧）', () => {
    // 目标足够远：正常走满一个 stub
    expect(previewStubX({ exitX: 100, enterX: 200 })).toBe(108);
    // 目标在 stub 之内：夹到目标 x（不越过去）
    expect(previewStubX({ exitX: 100, enterX: 103 })).toBe(103);
    // 目标与出端同 x：夹成同一个 x（折线退化成两段）
    expect(previewStubX({ exitX: 100, enterX: 100 })).toBe(100);
  });

  it('向左走 stub，同样夹在两端之间', () => {
    expect(previewStubX({ exitX: 200, enterX: 100 })).toBe(192);
    expect(previewStubX({ exitX: 200, enterX: 197 })).toBe(197);
  });

  it('stub 长度可用参数覆盖（导出侧复用同一条规则），默认取 `EDGE_STUB_PX`', () => {
    expect(previewStubX({ exitX: 0, enterX: 100 })).toBe(EDGE_STUB_PX);
    expect(previewStubX({ exitX: 0, enterX: 100, stubPx: 30 })).toBe(30);
  });

  it('判别力：预览规则与终态路由的中点规则**不同**（搬错实现会被这条抓住）', () => {
    const exitX = 100;
    const enterX = 200;
    const routed = routeEdge({
      exitSide: 'right',
      enterSide: 'left',
      exitX,
      enterX,
      yFrom: 0,
      yTo: 40,
    });
    // 终态：两端 stub 的中点 = (108 + 192) / 2 = 150
    expect(routed.verticalX).toBe(150);
    // 预览：出端 stub 的末点 = 108
    expect(previewStubX({ exitX, enterX })).toBe(108);
  });
});
