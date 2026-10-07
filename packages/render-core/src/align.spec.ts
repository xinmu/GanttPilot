/**
 * 两栏行对齐判读的判据（ADR 0007 §14 / 裁决 P-23）。**进 `pnpm gate`**。
 *
 * 这一份 spec 的作用与 `clipping.spec.ts` 的 NC1/NC2 相同：**证明判读有判别力**。
 * 判读函数收到的全是数字，所以故障签名可以用合成输入精确构造——每条机制一条：
 *
 * | 例 | 变造 | 必须被报出的机制 |
 * |---|---|---|
 * | 正例 | 无（两栏对齐、SVG 钉住、盒 = viewBox） | **`mechanisms` 必须为空**（"未变造时零检出"） |
 * | ① | `viewHeight ≠ paneHeight` | `pane-measure-stale` |
 * | ② | 行差恒 = −表头高 | `table-header-offset-missing` |
 * | ③ | `svgTop − paneTop = −scrollTop` | `svg-scrolls-with-content` |
 * | R8 | SVG 盒 ≠ `viewBox`（等比缩放 ⇒ 条形 x 也漂） | `svg-box-not-1to1`（+ `bar-x-offset`） |
 * | 单行 | 只有一行差一行高 | `row-offset`（**不允许**多数票放过） |
 * | 同步 | `viewScrollTop ≠ scrollTop` | `scroll-out-of-sync` |
 * | 所见=所点 | `pointerFromClient` 的内容 y 与行中心不符 | `hit-test-mismatch` |
 * | 表头高 / 表体高 / 空白带 / 轴覆盖 | 各自变造 | `header-height-mismatch` / `table-body-height-mismatch` / `coverage-gap` / `axis-not-covering` |
 */

import { describe, expect, it } from 'vitest';

import {
  diagnoseResizeMigration,
  diagnoseRowAlignment,
  diagnoseScrollCoverage,
  summarizeAlignment,
  type RowAlignProbe,
  type RowAlignSample,
} from './align.js';
import { HEADER_HEIGHT_PX, ROW_HEIGHT, THRESHOLDS } from './manifest.js';

/**
 * 基准探测：**修好之后**的样子——两栏行中心逐行相等、SVG 钉在绘制区左上、盒 = `viewBox`。
 *
 * 样本覆盖绘制区上下（含缓冲行）——这正是测脚本的做法，也是 `coverage` 判据有意义的前提：
 * 只取"完全落在绘制区内"的几行会让空白带恒 > 0，判据立刻变成噪声。
 */
function baselineProbe(): RowAlignProbe {
  const scrollTop = 300;
  const paneTop = 100;
  const paneLeft = 200;
  const paneHeight = 600;
  const paneWidth = 1200;
  const rowCenter = (row: number): number => paneTop + row * ROW_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
  const rows = [7, 12, 20, 30, 41];
  const samples: RowAlignSample[] = rows.map((row) => {
    const center = rowCenter(row);
    const barLeft = paneLeft + 400 - scrollTop / 4;
    return {
      id: `t${String(row)}`,
      row,
      chartCenterY: center,
      tableCenterY: center,
      barLeft,
      barRight: barLeft + 240,
      expectedBarLeft: barLeft,
      expectedBarRight: barLeft + 240,
    };
  });
  return {
    scrollTop,
    viewScrollTop: scrollTop,
    // 修好之后**可以向右滚**（P-24 的 R11）：基线取一个非 0 的 scrollLeft。
    scrollLeft: 240,
    viewScrollLeft: 240,
    paneTop,
    paneLeft,
    paneHeight,
    paneWidth,
    headerHeightChart: HEADER_HEIGHT_PX,
    headerHeightTable: HEADER_HEIGHT_PX,
    tableBodyHeight: paneHeight,
    tableRowHeight: ROW_HEIGHT,
    // SVG 覆盖**整列**：上缘 = 绘制区顶 − 表头带，盒高 = 绘制区高 + 表头带（ADR 0007 §15）。
    svgTop: paneTop - HEADER_HEIGHT_PX,
    svgLeft: paneLeft,
    svgWidth: paneWidth,
    svgHeight: paneHeight + HEADER_HEIGHT_PX,
    viewWidth: paneWidth,
    viewHeight: paneHeight,
    spacerHeight: 12_000,
    spacerWidth: 12_000,
    viewContentWidth: 12_000,
    rowCount: 500,
    rowHeight: ROW_HEIGHT,
    samples,
    /**
     * **轴的纵向覆盖基准是 SVG 的盒**（G8 复验第 ⑤ 条）：轴画在那一个覆盖整列的 SVG 里，
     * `y ∈ [0, svgHeight]` = 表头带 + 绘制区，因此 `top = svgTop`、`bottom = svgTop + svgHeight`
     * （= `paneTop + paneHeight`）。旧 fixture 写的是 `paneTop .. paneTop + paneHeight`
     * ——它只在"轴最高只到绘制区顶"时与上式同值。
     */
    axisCoverage: {
      top: paneTop - HEADER_HEIGHT_PX,
      bottom: paneTop + paneHeight,
      left: paneLeft,
      right: paneLeft + paneWidth,
    },
    // 刻度铺满视口：第一个刻度 ≈ 左缘、最后一个 ≈ 右缘（允许 1.5 个刻度间距的相位容差）。
    axisTicks: { left: paneLeft + 2, right: paneLeft + paneWidth - 2 },
    tickSpacingPx: ROW_HEIGHT,
    // 刻度文本落在表头带内：带 = [paneTop − HEADER, paneTop]。
    axisLabels: { top: paneTop - HEADER_HEIGHT_PX + 4, bottom: paneTop - 6 },
    hitTest: {
      id: 't20',
      row: 20,
      clientY: rowCenter(20),
      expectedContentY: 20 * ROW_HEIGHT + ROW_HEIGHT / 2,
      actualContentY: 20 * ROW_HEIGHT + ROW_HEIGHT / 2,
    },
  };
}

describe('两栏行对齐判读（ADR 0007 §14，P-23）', () => {
  it('正例：修好之后的输入必须零检出（否则判据无判别力）', () => {
    const verdict = diagnoseRowAlignment(baselineProbe());
    expect(verdict.mechanisms).toStrictEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.maxAbsRowDeltaPx).toBe(0);
    expect(verdict.maxAbsBarXDeltaPx).toBe(0);
    expect(verdict.pinned).toBe(true);
    expect(verdict.svgBoxAligned).toBe(true);
    expect(verdict.headerAligned).toBe(true);
    expect(verdict.heightAligned).toBe(true);
    expect(verdict.rowHeightAligned).toBe(true);
    expect(verdict.scrollInSync).toBe(true);
    expect(verdict.contentRangeAligned).toBe(true);
    expect(verdict.labelsInHeader).toBe(true);
    expect(verdict.coverage).toStrictEqual({ topBandPx: 0, bottomBandPx: 0 });
  });

  it('① 窗格测量过期：`viewHeight ≠ paneHeight` ⇒ `pane-measure-stale`', () => {
    const verdict = diagnoseRowAlignment({ ...baselineProbe(), viewHeight: 560, svgHeight: 560 + HEADER_HEIGHT_PX });
    expect(verdict.mechanisms).toStrictEqual(['pane-measure-stale']);
    expect(verdict.ok).toBe(false);
  });

  it('② 缺表头带：行差恒 = −表头高 ⇒ `table-header-offset-missing`（不是笼统的 row-offset）', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      samples: probe.samples.map((sample) => ({
        ...sample,
        tableCenterY: sample.chartCenterY + HEADER_HEIGHT_PX,
      })),
    });
    expect(verdict.mechanisms).toContain('table-header-offset-missing');
    expect(verdict.maxAbsRowDeltaPx).toBe(HEADER_HEIGHT_PX);
  });

  it('③ 双重偏移：`svgTop − paneTop = −scrollTop` ⇒ `svg-scrolls-with-content`（且行差随滚动变）', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      svgTop: probe.paneTop - HEADER_HEIGHT_PX - probe.scrollTop,
    });
    expect(verdict.mechanisms).toContain('svg-scrolls-with-content');
    expect(verdict.pinned).toBe(false);
  });

  it('③ 的静默版（滚动位置为 0 时不可见）：`scrollTop = 0` 且 SVG 未偏移 ⇒ 只报钉住失败', () => {
    const probe = { ...baselineProbe(), scrollTop: 0, viewScrollTop: 0 };
    const verdict = diagnoseRowAlignment({ ...probe, svgTop: probe.paneTop - HEADER_HEIGHT_PX - 20 });
    expect(verdict.mechanisms).toContain('svg-not-pinned');
    expect(verdict.mechanisms).not.toContain('svg-scrolls-with-content');
  });

  it('R8 SVG 盒 ≠ viewBox：等比缩放 ⇒ `svg-box-not-1to1` 与 `bar-x-offset` 同时成立', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      svgWidth: probe.viewWidth + 15,
      svgHeight: probe.viewHeight + HEADER_HEIGHT_PX + 15,
      samples: probe.samples.map((sample) => ({
        ...sample,
        barLeft: (sample.barLeft ?? 0) + 9,
        barRight: (sample.barRight ?? 0) + 9,
      })),
    });
    expect(verdict.mechanisms).toContain('svg-box-not-1to1');
    expect(verdict.mechanisms).toContain('bar-x-offset');
    expect(verdict.svgBoxAligned).toBe(false);
    expect(verdict.maxAbsBarXDeltaPx).toBe(9);
  });

  it('单行漂移一行高：必须报 `row-offset`（多数行对齐不能把它掩盖掉）', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      samples: probe.samples.map((sample) =>
        sample.row === 20 ? { ...sample, chartCenterY: sample.chartCenterY + ROW_HEIGHT } : sample,
      ),
    });
    expect(verdict.mechanisms).toContain('row-offset');
    expect(verdict.maxAbsRowDeltaPx).toBe(ROW_HEIGHT);
  });

  it('滚动状态不同步 ⇒ `scroll-out-of-sync`', () => {
    const verdict = diagnoseRowAlignment({ ...baselineProbe(), viewScrollTop: 280 });
    expect(verdict.mechanisms).toContain('scroll-out-of-sync');
    expect(verdict.scrollInSync).toBe(false);
  });

  it('所见 ≠ 所点：`pointerFromClient` 的内容 y 与行中心不符 ⇒ `hit-test-mismatch`', () => {
    const probe = baselineProbe();
    const hitTest = probe.hitTest;
    expect(hitTest).not.toBeNull();
    if (hitTest === null) return;
    const verdict = diagnoseRowAlignment({
      ...probe,
      hitTest: { ...hitTest, actualContentY: hitTest.expectedContentY + THRESHOLDS.rowAlignTolerancePx * 3 },
    });
    expect(verdict.mechanisms).toContain('hit-test-mismatch');
  });

  it('两栏表头高不等 ⇒ `header-height-mismatch`', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({ ...probe, headerHeightChart: HEADER_HEIGHT_PX + 12 });
    expect(verdict.mechanisms).toContain('header-height-mismatch');
    expect(verdict.headerAligned).toBe(false);
  });

  it('R9 左表行外高 ≠ 模型行高（25 vs 24 ⇒ 逐行累积漂移）⇒ `table-row-height-mismatch`', () => {
    const probe = baselineProbe();
    const drift = 1;
    // 累积漂移以**第一个采样行**为基准。`noUncheckedIndexedAccess` 下 `probe.samples[0]` 可能是
    // `undefined`，而这里直接写 `.row` 会报 TS2532——旧 program 不含 spec 所以从未被看见。
    // 空数组时 `map` 不会执行，回落值不参与任何断言，故取 `0` 只影响"不可能发生的分支"。
    const firstRow = probe.samples[0]?.row ?? 0;
    const verdict = diagnoseRowAlignment({
      ...probe,
      tableRowHeight: ROW_HEIGHT + drift,
      samples: probe.samples.map((sample) => ({
        ...sample,
        tableCenterY: sample.tableCenterY + (sample.row - firstRow) * drift,
      })),
    });
    expect(verdict.mechanisms).toContain('table-row-height-mismatch');
    expect(verdict.rowHeightAligned).toBe(false);
  });

  it('表体高 ≠ 绘制区高 ⇒ `table-body-height-mismatch`', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({ ...probe, tableBodyHeight: probe.paneHeight - 15 });
    expect(verdict.mechanisms).toContain('table-body-height-mismatch');
    expect(verdict.heightAligned).toBe(false);
  });

  it('底部空白带（最末行没滚进绘制区）⇒ `coverage-gap`', () => {
    const probe = baselineProbe();
    const last = probe.samples[probe.samples.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    // 最末行整体（两栏一起）落在绘制区底之上 100 px：不是"行错位"，而是"内容没铺满"。
    const shortCenter = probe.paneTop + probe.paneHeight - ROW_HEIGHT / 2 - 100;
    const verdict = diagnoseRowAlignment({
      ...probe,
      samples: [
        ...probe.samples.slice(0, -1),
        { ...last, chartCenterY: shortCenter, tableCenterY: shortCenter },
      ],
    });
    expect(verdict.coverage?.bottomBandPx).toBe(100);
    expect(verdict.mechanisms).toContain('coverage-gap');
  });

  it('R11 滚动范围不够（spacer 宽 ≠ `ViewModel.contentWidth`）⇒ `content-range-mismatch`', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({ ...probe, spacerWidth: probe.viewContentWidth - 20_000 });
    expect(verdict.mechanisms).toContain('content-range-mismatch');
    expect(verdict.contentRangeAligned).toBe(false);
  });

  it('标尺位置（P-24 第 ③ 条）：刻度文本侵入**第一行**图形区 ⇒ `axis-labels-not-in-header`', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      // 刻度被画在绘制区顶部（批次 D 的表头带曾是空带时的样子）：下缘越过绘制区顶。
      axisLabels: { top: probe.paneTop - 16, bottom: probe.paneTop + 10 },
    });
    expect(verdict.mechanisms).toContain('axis-labels-not-in-header');
    expect(verdict.labelsInHeader).toBe(false);
  });

  it('轴只在**横向**不覆盖（P-24 的"右侧新区域空白"）⇒ 同样必须报 `axis-not-covering`', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      // 轴的横向窗口整体左移 300 px（横向双重偏移的典型形态）；纵向仍然完好。
      axisTicks: { left: probe.axisTicks === null ? 0 : probe.axisTicks.left - 300, right: 0 },
    });
    expect(verdict.mechanisms).toContain('axis-not-covering');
  });

  it('轴不覆盖绘制区（14.2：新滚出的区域没有网格线/灰度带）⇒ `axis-not-covering`', () => {
    expect(diagnoseRowAlignment({ ...baselineProbe(), axisCoverage: null }).mechanisms).toContain('axis-not-covering');
    expect(
      diagnoseRowAlignment({
        ...baselineProbe(),
        axisCoverage: { top: 120, bottom: 700, left: 200, right: 1400 },
      }).mechanisms,
    ).toContain('axis-not-covering');
  });

  it('空样本 ⇒ `no-samples`（不假装通过）', () => {
    const verdict = diagnoseRowAlignment({ ...baselineProbe(), samples: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.mechanisms).toStrictEqual(['no-samples']);
  });

  it('文档比绘制区短时**不做**空白带断言（否则判据会误报）', () => {
    const probe = baselineProbe();
    const verdict = diagnoseRowAlignment({
      ...probe,
      rowCount: 5,
      samples: probe.samples
        .slice(0, 2)
        .map((sample) => ({ ...sample, chartCenterY: probe.paneTop + 52, tableCenterY: probe.paneTop + 52 })),
    });
    expect(verdict.coverage).toBeNull();
    expect(verdict.mechanisms).toStrictEqual([]);
  });

  it('`summarizeAlignment`：多位置取并集，任一位置失败即整体失败', () => {
    const good = diagnoseRowAlignment(baselineProbe());
    const bad = diagnoseRowAlignment({ ...baselineProbe(), viewHeight: 560, svgHeight: 560 + HEADER_HEIGHT_PX });
    const summary = summarizeAlignment([good, bad]);
    expect(summary.ok).toBe(false);
    expect(summary.probes).toBe(2);
    expect(summary.failingProbes).toBe(1);
    expect(summary.mechanisms).toStrictEqual(['pane-measure-stale']);
    expect(summarizeAlignment([]).ok).toBe(false);
  });

  // ---------------------------------------------------------------- P-40 批次②：判"判据的前提"

  it('覆盖度正例：横向与纵向都真的滚过 ⇒ 零检出，且不把请求值当实际值', () => {
    const coverage = diagnoseScrollCoverage([
      { requestedTop: 0, requestedLeft: 0, actualTop: 0, actualLeft: 0 },
      { requestedTop: 9_999_999, requestedLeft: 0, actualTop: 22_910, actualLeft: 0 },
      { requestedTop: 0, requestedLeft: 9_999_999, actualTop: 0, actualLeft: 9_347 },
      { requestedTop: 9_999_999, requestedLeft: 9_999_999, actualTop: 22_910, actualLeft: 9_347 },
    ]);
    expect(coverage.ok).toBe(true);
    expect(coverage.horizontalCovered).toBe(true);
    expect(coverage.verticalCovered).toBe(true);
    expect(coverage.clampedPositions).toBe(0);
    expect(coverage.mechanisms).toStrictEqual([]);
    expect(coverage.maxScrollLeft).toBe(9_347);
    expect(coverage.maxScrollTop).toBe(22_910);
  });

  it('覆盖度负向对照：内容整幅不滚动（请求被夹回 0）⇒ 必须报 `no-horizontal-travel`（**不是** ✅）', () => {
    // 周/月档的小文档：`contentWidth ≤ 窗格宽` ⇒ 浏览器把"超大值"夹回 0，
    // 于是 (0, max) 与 (0, 0) 完全等价。旧口径会输出"位置数 ≥ 2、机制为空"⇒ 假绿。
    const coverage = diagnoseScrollCoverage([
      { requestedTop: 0, requestedLeft: 0, actualTop: 0, actualLeft: 0 },
      { requestedTop: 480, requestedLeft: 600, actualTop: 480, actualLeft: 0 },
      { requestedTop: 0, requestedLeft: 9_999_999, actualTop: 0, actualLeft: 0 },
      { requestedTop: 9_999_999, requestedLeft: 9_999_999, actualTop: 1_200, actualLeft: 0 },
    ]);
    expect(coverage.ok).toBe(false);
    expect(coverage.horizontalCovered).toBe(false);
    expect(coverage.verticalCovered).toBe(true);
    // 三处"请求了非 0 横向却被夹回 0"必须被数出来（它是这条判据的可读证据）。
    expect(coverage.clampedPositions).toBe(3);
    expect(coverage.mechanisms).toStrictEqual(['no-horizontal-travel']);
  });

  it('覆盖度负向对照：完全没有纵向行程 ⇒ `no-vertical-travel`（两个方向各自独立判定）', () => {
    const coverage = diagnoseScrollCoverage([
      { requestedTop: 0, requestedLeft: 0, actualTop: 0, actualLeft: 0 },
      { requestedTop: 0, requestedLeft: 9_999_999, actualTop: 0, actualLeft: 5_000 },
    ]);
    expect(coverage.mechanisms).toStrictEqual(['no-vertical-travel']);
    expect(coverage.horizontalCovered).toBe(true);
  });

  it('汇总把覆盖度并进判定：位置全绿但**没有横向行程**时，整体必须判失败', () => {
    const good = diagnoseRowAlignment(baselineProbe());
    const noTravel = diagnoseScrollCoverage([
      { requestedTop: 0, requestedLeft: 0, actualTop: 0, actualLeft: 0 },
      { requestedTop: 480, requestedLeft: 600, actualTop: 480, actualLeft: 0 },
    ]);
    expect(noTravel.ok).toBe(false);
    const summary = summarizeAlignment([good], noTravel);
    expect(summary.ok).toBe(false);
    expect(summary.failingProbes).toBe(0);
    expect(summary.mechanisms).toStrictEqual(['no-horizontal-travel']);
    expect(summary.coverage).toStrictEqual(noTravel);
    // 不给覆盖度输入时是老的语义（`coverage: null`、`ok` 只看位置）。
    const legacy = summarizeAlignment([good]);
    expect(legacy.ok).toBe(true);
    expect(legacy.coverage).toBeNull();
  });

  it('迁移前提自证：窗格尺寸真的变了 ⇒ 零检出；**没变** ⇒ `resize-not-observed`（"没变"不能与"变好了"共用一个绿）', () => {
    const observed = diagnoseResizeMigration({
      beforeWidth: 1_280,
      beforeHeight: 640,
      afterWidth: 1_024,
      afterHeight: 520,
    });
    expect(observed.observed).toBe(true);
    expect(observed.deltaWidth).toBe(-256);
    expect(observed.deltaHeight).toBe(-120);
    expect(observed.mechanisms).toStrictEqual([]);

    const notObserved = diagnoseResizeMigration({
      beforeWidth: 1_280,
      beforeHeight: 640,
      afterWidth: 1_280,
      afterHeight: 640,
    });
    expect(notObserved.observed).toBe(false);
    expect(notObserved.mechanisms).toStrictEqual(['resize-not-observed']);
  });

  it('迁移后"过期重算"的签名必须被**现有机制表**抓住（不新开机制码：`pane-measure-stale` / 表体高 / 盒≠viewBox）', () => {
    // resize 到 1024×520 后应用没重算：`ViewModel` 还停在 1280×640 那一版。
    const stale = diagnoseRowAlignment({
      ...baselineProbe(),
      paneHeight: 520,
      paneWidth: 1_024,
      svgHeight: 520 + HEADER_HEIGHT_PX,
      svgWidth: 1_024,
      tableBodyHeight: 640,
      spacerHeight: 8_000,
    });
    expect(stale.mechanisms).toContain('pane-measure-stale');
    expect(stale.mechanisms).toContain('table-body-height-mismatch');
    expect(stale.ok).toBe(false);
  });

  it('迁移后"滚动位置没跟上"必须报 `scroll-out-of-sync`（resize 会在浏览器侧夹 scrollTop）', () => {
    const verdict = diagnoseRowAlignment({
      ...baselineProbe(),
      scrollTop: 120,
      viewScrollTop: 0,
    });
    expect(verdict.mechanisms).toContain('scroll-out-of-sync');
    expect(verdict.scrollInSync).toBe(false);
  });
});
