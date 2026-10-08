/**
 * ADR 0007 §9 的第 ② ④ 层（**进 `pnpm gate`**）：裁剪结构断言与元素预算，外加两条**必须存在**的负向对照。
 *
 * 没有负向对照，"元素数与文档总规模无关"就可能是恒真式（§6.8 点名要求）：
 * - **NC1**：把求交换成端点可见性裁剪，必须被检出丢边；
 * - **NC2**：关掉窗口裁剪，必须被检出元素数随规模增长。
 *
 * 期望数字来自 G4-S（`spikes/g0-s4-svg-clipping/evidence/clipping-report.md`，该目录已随 G4 落地删除，
 * 数字转入本 spec 作为回归锚）：
 * - 12/12 组在预算内；
 * - `c₃ = 122 / 89 / 94`（日/周/月；**P-46 两级刻度后重锚**，原单级口径为 116 / 70 / 89）；
 * - 4 个滚动位置误裁 **33 / 97 / 96 / 88 = 314** 条（其中跨屏长边 268）；
 * - 关掉窗口裁剪的元素数 **1,348 / 3,524 / 7,170 / 14,439**（比值 10.71×；
 *   批次 B 之后锚值为 ≈10.8×，见 NC2 的注释）。
 */

import { describe, expect, it } from 'vitest';

import { countElements, countElementsByEnumeration, countOverlays, hoverRowOf } from './count.js';
import { buildAxis } from './clip.js';
import { DATASETS, REFERENCE_DATASET, SCROLL_ROW_OFFSETS, buildFixture, scaleGradient } from './fixtures.js';
import { datasetOf } from '../test/fixtures.testkit.js';
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

  it('渲染行恒为 32、`c₃` 逐档位为 122 / 89 / 94（**P-46 两级刻度后重锚**；单级口径原为 116 / 70 / 89）', () => {
    const expectedC3: Record<string, number> = { day: 122, week: 89, month: 94 };
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
    const fixture = buildFixture(datasetOf('dense'));
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

/**
 * **两级刻度与悬停行带**（P-46 增补；[ADR 0007 附录 §3](../../docs/02-adr/附录/0007-增补.md)）。
 *
 * 三条判据（缺一条就会退化成"看起来实现了"）：
 * 1. **上级标签随档位**：日/周档 `YYYY-MM`、月档 `YYYY`；下级标签仍是 §11 第 6 项的 `DD`/`MM-DD`/`YYYY-MM`；
 * 2. **上级分段带"段内只写一次"**（防满屏重复文本）——上级标签数 == 段数，且严格少于下级标签数（日档）；
 * 3. **悬停行带恰好 1 个**、且进 `overlay`（不是 `c₃`）——那 1 个元素必须被两路计数都看见。
 */
describe('两级刻度与悬停行带（P-46）', () => {
  it('上级标签随档位：日/周档 `YYYY-MM`、月档 `YYYY`；下级保持既有语义', () => {
    const fixture = buildFixture(datasetOf('dense'));
    const expectMinor: Record<string, RegExp> = { day: /^\d{2}$/, week: /^\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/ };
    const expectMajor: Record<string, RegExp> = { day: /^\d{4}-\d{2}$/, week: /^\d{4}-\d{2}$/, month: /^\d{4}$/ };
    for (const zoom of ZOOM_ORDER) {
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport,
        zoom,
      });
      const minor = view.axis.filter((element) => element.kind === 'label' && element.level !== 1);
      const major = view.axis.filter((element) => element.kind === 'label' && element.level === 1);
      const majorBands = view.axis.filter((element) => element.kind === 'major-band');
      expect(minor.length).toBeGreaterThan(0);
      expect(major.length).toBeGreaterThan(0);
      for (const element of minor) expect(element.text).toMatch(expectMinor[zoom]!);
      for (const element of major) expect(element.text).toMatch(expectMajor[zoom]!);
      // "段内只在左端写一次"：上级标签与上级分段带一一对应。
      expect(major.length).toBe(majorBands.length);
      // 判据的判别力来源：日档下上级明显**少**于下级（"一天写一次"的实现会翻红）。
      if (zoom === 'day') expect(major.length).toBeLessThan(minor.length);
    }
  });

  it('上级分段带与下级刻度同 x 时不重复发 `gridline`（且没有下级刻度时由上级补发；否则 `c₃` 与 DOM 两路计数对不上）', () => {
    const fixture = buildFixture(datasetOf('dense'));
    for (const zoom of ZOOM_ORDER) {
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport,
        zoom,
      });
      const gridlines = view.axis.filter((element) => element.kind === 'gridline');
      const xs = gridlines.map((element) => element.x);
      // 第一半：同一个 `x` 只有一条（下级刻度发过，上级就不重复发）。
      expect(new Set(xs).size).toBe(xs.length);
      // 第二半：下级没发线的那些 `x` 由上级**补发** —— 每一条上级分段带的左边界，要么有一条
      // `gridline` 与它重合，要么它落在水平裁剪之外（不发射）。
      for (const band of view.axis.filter((element) => element.kind === 'major-band')) {
        const hasLine = gridlines.some((element) => Math.abs(element.x - band.x) < 1e-9);
        const clipped = band.x < -1 || band.x > viewport.width + 1;
        expect(hasLine || clipped).toBe(true);
      }
    }
  });

  it('悬停行带：给定 `hoverRow` 时恰好 1 个元素、**按内容宽贯穿整行**，且计入 `overlay` 而不是 `c₃`', () => {
    const fixture = buildFixture(datasetOf('dense'));
    const base = {
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport,
      zoom: 'day' as const,
    };
    const without = buildView(base);
    expect(without.hoverBand).toBeNull();
    expect(hoverRowOf(without)).toBe(false);
    expect(without.axis.some((element) => element.kind === 'hover-band')).toBe(false);

    const hoverRow = 3;
    const withHover = buildView({ ...base, hoverRow });
    expect(withHover.hoverBand).toStrictEqual({ row: hoverRow });
    const hoverBands = withHover.axis.filter((element) => element.kind === 'hover-band');
    expect(hoverBands).toHaveLength(1);
    /**
     * **宽度 = 内容宽**（G8 第二次复验第 ① 条：行带要"贯穿整行"，不是只盖住首屏那一屏）。
     *
     * 行带画在**内容滚动组**里（横向不翻译）⇒ 铺到内容宽就等于"整行"。
     * 负向对照在下面第 ⑤ 条（用视口宽会被本断言拦下）。
     */
    expect(hoverBands[0]).toMatchObject({
      x: 0,
      width: withHover.contentWidth,
      y: hoverRow * ROW_HEIGHT,
      height: ROW_HEIGHT,
    });
    // 内容宽必须**严格大于**视口宽，否则这个断言没有判别力（"整行"与"首屏"不可区分）。
    expect(withHover.contentWidth).toBeGreaterThan(viewport.width);
    expect(hoverRowOf(withHover)).toBe(true);

    // ① 覆盖层计数 +1（`overlay` 是每帧固定开销）；② `c₃` **一字不变**（行带不是轴刻度）。
    const overlays = { hoverRow: hoverRowOf(withHover) };
    expect(countOverlays(overlays)).toBe(countOverlays() + 1);
    expect(countElements(withHover, overlays).axis).toBe(countElements(without).axis);
    // ③ 两路计数仍然逐项相等（这一条是"没有双重计数"的机关）。
    const byCategory = countElements(withHover, overlays);
    const byEnumeration = countElementsByEnumeration(withHover, overlays);
    expect(byEnumeration.total).toBe(byCategory.total);
    expect(byEnumeration.kinds['overlay-hover-row']).toBe(1);
    expect(byEnumeration.kinds['axis-hover-band']).toBeUndefined();

    // ④ **负向对照**：把 `hoverRow` 输入关掉（模拟"忘了登记这 1 个元素"）⇒ 计数与实际发射不一致。
    const wrong = countElements(withHover);
    expect(wrong.overlays).toBe(byCategory.overlays - 1);
    expect(wrong.total).toBe(byCategory.total - 1);

    // ⑤ **负向对照（宽度的判别力）**：直接把"视口宽"喂成 `contentWidth` ⇒ 行带就只有首屏那么宽。
    //    这一条是在说"**两种写法真的不同**"：旧实现（按视口宽）会得到这里的值。
    const narrowed = buildAxis({
      calendar: fixture.calendar,
      axisOriginDay: withHover.axisOriginDay,
      pxPerDay: withHover.pxPerDay,
      scrollLeft: 0,
      width: viewport.width,
      contentWidth: viewport.width,
      zoom: 'day',
      hoverRow,
      rowHeight: ROW_HEIGHT,
    }).find((element) => element.kind === 'hover-band');
    expect(narrowed).toBeDefined();
    expect(narrowed?.width).toBe(viewport.width);
    // 而真实视图给的是内容宽 ⇒ 两者**必须不相等**（否则"贯穿整行"这条断言没有判别力）。
    expect(narrowed?.width).not.toBe(hoverBands[0]?.width);
  });

  it('悬停行在渲染窗口之外时不发射（高亮与"能否交互"同一个行集合）', () => {
    const fixture = buildFixture(datasetOf('dense'));
    const base = {
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport,
      zoom: 'day' as const,
    };
    const view = buildView(base);
    for (const outside of [view.renderLast + 1, view.renderLast + 100, view.rowCount + 5]) {
      expect(buildView({ ...base, hoverRow: outside }).hoverBand).toBeNull();
    }
    // 边界内则必须发射（否则上面的"不发射"没有判别力）。
    expect(buildView({ ...base, hoverRow: view.renderLast }).hoverBand).toStrictEqual({ row: view.renderLast });
  });

  it('悬停行带在**非 0 横向滚动位置**（`scrollLeft = 600`）下逐值不变（P-25 的口径，决策 7 的落点）', () => {
    /**
     * ADR 0007 §16.3 要求"**凡坐标换算类判据至少取一个非 0 滚动位置**"（R13/R14 只在滚动后现形）。
     * 悬停行带是最容易漏掉的一处：它的 `x` 起点在**窗口坐标**、宽度取**内容宽**（画在内容滚动组里
     * ⇒ 横向不翻译），因此横向滚动**不该改变它的任何取值**——本用例就是那个"不该"。
     */
    const fixture = buildFixture(datasetOf('dense'));
    const hoverRow = 3;
    const base = {
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      zoom: 'day' as const,
      hoverRow,
    };
    const still = buildView({ ...base, viewport });
    const scrolled = buildView({ ...base, viewport: { ...viewport, scrollLeft: 600 } });

    // **前提自证**：这一次真的取到了横向行程——非行带的轴元素必须整体跟着 `scrollLeft` 平移。
    // （否则"逐值不变"可能只是因为两份视图恰好一样，判据没有判别力。）
    const axisXsOf = (view: typeof still): number[] =>
      view.axis.filter((element) => element.kind !== 'hover-band').map((element) => element.x);
    expect(axisXsOf(scrolled)).not.toStrictEqual(axisXsOf(still));
    expect(scrolled.contentWidth).toBe(still.contentWidth); // 内容宽与横向滚动无关

    // 行带：恰好 1 个，且**逐值**等于不滚动的那一个（`x` 仍是窗口坐标的 0、宽度仍是内容宽）。
    const stillBand = still.axis.find((element) => element.kind === 'hover-band');
    const scrolledBand = scrolled.axis.find((element) => element.kind === 'hover-band');
    expect(stillBand).toBeDefined();
    expect(scrolledBand).toStrictEqual(stillBand);
    expect(scrolledBand).toMatchObject({ x: 0, width: scrolled.contentWidth, y: hoverRow * ROW_HEIGHT });
    expect(scrolledBand?.width).toBeGreaterThan(viewport.width);

    // 计数口径与滚动无关：行带仍计 `overlay`（+1）、**不计** `c₃`，且两路计数继续互证。
    const overlays = { hoverRow: hoverRowOf(scrolled) };
    expect(hoverRowOf(scrolled)).toBe(true);
    const byCategory = countElements(scrolled, overlays);
    const byEnumeration = countElementsByEnumeration(scrolled, overlays);
    expect(byCategory.axis).toBe(countElements(scrolled).axis); // 行带不进 `c₃`
    expect(byCategory.overlays).toBe(countElements(scrolled).overlays + 1);
    expect(byEnumeration.total).toBe(byCategory.total);
    expect(byEnumeration.kinds['overlay-hover-row']).toBe(1);
    expect(byEnumeration.kinds['axis-hover-band']).toBeUndefined();
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
    const fixture = buildFixture(datasetOf('dense'));
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
  it('元素数随规模单调增长，10× 规模跨度的比值 ≈10.8× > 5×', () => {
    const totals: number[] = [];
    const renderedRows: number[] = [];
    for (const { fixture } of scaleGradient(datasetOf('dense'))) {
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
    // G4-S 的原始锚是 **10.71×**（1,348 / 3,524 / 7,170 / 14,439）。批次 B（ADR 0008 §16.4／裁决 P-32）
    // 给每渲染行加了端点手柄与连接点：**分子与分母同时平移**（关掉裁剪时渲染行数随规模增长，
    // 因此平移量也随规模增长），比值随之从 10.71 微升到 ≈10.80。
    // **判据的本体不变**（"关掉裁剪必须随规模增长、且与窗口路径差一个数量级"），只更新锚值。
    expect(ratio).toBeCloseTo(10.8, 1);
    expect(ratio).toBeGreaterThan(THRESHOLDS.nc2GrowthRatio);
    // 判别力：与窗口路径（≈1.1×）差一个数量级。
    expect(ratio).toBeGreaterThan(5 * THRESHOLDS.windowedGrowthRatio);
    // 渲染行数也从 162 → 1,962 增长（10× 以上），与"恒 32 行"形成对照。
    expect(renderedRows[0]).toBeLessThan(200);
    expect(renderedRows[renderedRows.length - 1] ?? 0).toBeGreaterThan(1900);
  });
});
