/**
 * 两栏行对齐的**判读内核**（ADR 0007 §14 / 裁决 P-23）。**纯函数、零 DOM**。
 *
 * ## 为什么这一层在包里而不是在测量脚本里
 *
 * P-21 的人工复核（R6）与 P-22 的线索都指向同一类缺陷：**"图表画在哪里"与"左表画在哪里"
 * 是两处各自算出来的**，而它们之间的差只能靠肉眼发现。把它做成可判定的检查需要两半：
 *
 * - **采数**（`apps/web/src/measure/` 的 `__GANTTPILOT_MEASURE_ALIGN__`）：只从真实 DOM 读
 *   `getBoundingClientRect()` 与 `clientWidth/clientHeight` —— 这一半只能在浏览器里做；
 * - **判读**（本文件）：只做减法和阈值比较 —— 这一半是纯的，因此**进 `pnpm gate`**，
 *   并且可以用**合成的故障签名**（每条机制一条）证明它真的有判别力。
 *
 * 与 P-19/P-22 同一条教训：判据住在 `apps/web` 就等于不住在门禁里（`apps/web` 至今没有测试入口）。
 *
 * ## 三条机制与它们的签名（每条都有一个负向对照）
 *
 * | 机制 | 签名（本文件的判据） |
 * |---|---|
 * | **③ 双重偏移**：SVG 是滚动容器的 abspos 子元素 ⇒ 随内容滚动，再叠加内层 `translate(−scrollTop)` | `svgTop − paneTop ≈ −scrollTop`（`scrollTop > 0` 时） |
 * | **② 缺表头带**：左表行从表头之下开始、图表行从列顶开始 | 行差**恒** ≈ `−headerHeightTable`（且 SVG 已钉住） |
 * | **① 测量时机**：`paneHeight` 是过期值 ⇒ 行窗口与真实绘制区不一致 | `\|viewHeight − paneHeight\| > tol` |
 *
 * 另有三条同族签名在本批次一并被抓出（P-23 记录为 **R8** 及两条收尾项）：
 *
 * | 机制 | 签名 |
 * |---|---|
 * | **R8 SVG 盒 ≠ viewBox**：`inset: 0` 的盒是"padding box"（含滚动条），而 `viewBox` 取 `clientWidth/clientHeight` ⇒ 默认 `preserveAspectRatio` 给出**等比缩放 + 居中留白** | `\|svgWidth − viewWidth\| > tol` 或 `\|svgHeight − viewHeight\| > tol`（并使行差**随行号增长**）。**P-23 诊断实测：本环境不存在（盒 = viewBox），保留判据以防复发** |
 * | **表体高 ≠ 绘制区高** | `\|tableBodyHeight − paneHeight\| > tol` |
 * | **R9 左表行外高 ≠ 模型行高**：`.row { height: 24px; border-bottom: 1px }` 在 `content-box` 下外高 25 px ⇒ **每行多 1 px、逐行累积漂移**（P-23 实测：32 行漂 32 px） | `\|tableRowHeight − rowHeight\| > tol` |
 * | **轴不覆盖绘制区**（水平 + 垂直）：轴住错坐标系（横向双重偏移）或随纵向滚动上移 ⇒ 新滚出的区域没有网格线/灰度带（P-23 的 14.2、P-24 的"右侧空白"） | 轴元素并集矩形不覆盖绘制区的**四边** |
 * | **R11 内容宽（滚动范围）给少了**：按窗格宽外推而不是按文档日期范围推 ⇒ 向右滚不到项目末端 | `\|spacerWidth − viewContentWidth\| > 1 px` |
 *
 * **坐标系约定**：本文件收到的全部是**视口坐标**（`getBoundingClientRect()` 的原样值），
 * 不涉及内容坐标；`expectedBarLeft` 由调用方按 `paneLeft + xLeft − scrollLeft` 预先算好。
 *
 * ## P-40 批次② 新增的两条：判**判据的前提**
 *
 * 上面那些判据都假定"这次测量真的激活了机制"。本批次把这条假定也做成判据——
 * 因为**覆盖静默消失时，输出长得像通过**（P-24 的 R12 就是先例）：
 *
 * | 判据 | 签名 |
 * |---|---|
 * | **滚动覆盖度**（{@link diagnoseScrollCoverage}） | 本次测量**没有任何位置**的 `scrollLeft > 0` ⇒ `no-horizontal-travel`；`scrollTop` 同理 ⇒ `no-vertical-travel`。**覆盖不足即判失败**（"这次测量不构成该方向的判据"，而不是 ✅） |
 * | **迁移前提自证**（{@link diagnoseResizeMigration}） | 请求了 resize 但窗格尺寸没变 ⇒ `resize-not-observed`（"没变"不能与"变好了"共用一个绿） |
 */

import { THRESHOLDS } from './manifest.js';

/** 一行样本（两栏同一行的实测量 + 条形的期望屏幕 x）。 */
export interface RowAlignSample {
  readonly id: string;
  /** 可见行序号（两栏用同一个行序）。 */
  readonly row: number;
  /**
   * 图表行的**行中心** y（视口坐标）。
   *
   * 为什么是中心而不是行顶：图表行的 `<g>` **没有自己的盒子**，`getBoundingClientRect()`
   * 返回的是其子元素（条 / 菱形）的并集——条上下各内缩 `(rowHeight − barHeight) / 2`。
   * 用行顶会把"条内缩 4.8 px"当成错位（P-23 的诊断**第一版就是这么错的**，当场改掉）。
   * 条在行内**垂直居中**（`ViewModel.barY`），因此"条中心 = 行中心"，两栏可比。
   */
  readonly chartCenterY: number;
  /** 左表同一行的**行中心** = DOM 行顶 + `rowHeight / 2`（按**模型行高**，不按 DOM 外高——外高含边框）。 */
  readonly tableCenterY: number;
  /** 条形矩形的左右边（视口坐标）；`null` = 该行没有条形（里程碑只有菱形，槽位/进度不进样本）。 */
  readonly barLeft: number | null;
  readonly barRight: number | null;
  /** 由 `ViewModel` 几何推出的**期望**屏幕 x（`paneLeft + xLeft − scrollLeft`）。 */
  readonly expectedBarLeft: number | null;
  readonly expectedBarRight: number | null;
}

/** 一次探测（一个滚动位置）的全部实测量。 */
export interface RowAlignProbe {
  /** 滚动容器的真实 `scrollTop`（**DOM 真值**，判据用它）。 */
  readonly scrollTop: number;
  /** 应用状态里的 `ViewModel.scrollTop`（与 `scrollTop` 必须相等）。 */
  readonly viewScrollTop: number;
  /** 滚动容器的真实 `scrollLeft`。 */
  readonly scrollLeft: number;
  /** 应用状态里的 `ViewModel.scrollLeft`（与 `scrollLeft` 必须相等）。 */
  readonly viewScrollLeft: number;
  readonly paneTop: number;
  readonly paneLeft: number;
  /** 绘制区高宽 = 滚动容器的 `clientHeight/clientWidth`（**已扣滚动条，也已扣表头带**）。 */
  readonly paneHeight: number;
  readonly paneWidth: number;
  readonly headerHeightChart: number;
  readonly headerHeightTable: number;
  readonly tableBodyHeight: number;
  readonly svgTop: number;
  readonly svgLeft: number;
  /** SVG **元素盒**的尺寸（`getBoundingClientRect()`；不是 `viewBox`）。 */
  readonly svgWidth: number;
  readonly svgHeight: number;
  /** `ViewModel.width/height`（= `viewBox` 的尺寸，也 = 绘制区尺寸）。 */
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly spacerHeight: number;
  /** 滚动容器的 spacer **宽**（= 横向滚动范围；必须等于 `viewContentWidth`）。 */
  readonly spacerWidth: number;
  /** `ViewModel.contentWidth`（= 内容坐标系下的横向范围，ADR 0007 §15）。 */
  readonly viewContentWidth: number;
  readonly rowCount: number;
  readonly rowHeight: number;
  /**
   * 左表一行的**DOM 外高**（`getBoundingClientRect().height`）。
   *
   * 它必须等于 {@link rowHeight}（ADR 0007 §4 的"固定行高"）：左表 `.row` 的 `height: 24px`
   * 加 `border-bottom: 1px` 在 `content-box` 下外高是 **25 px** ⇒ 每行多 1 px，
   * 32 行就漂 32 px（P-23 诊断实测的 **R9**）。
   */
  readonly tableRowHeight: number;
  readonly samples: readonly RowAlignSample[];
  /** 色带（无则退到网格线）的并集矩形；`null` = 该位置没有轴元素。**纵向**覆盖用它。 */
  readonly axisCoverage: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  } | null;
  /**
   * **刻度（网格线）**的并集横向范围；`null` = 该位置没有刻度。**横向**覆盖用它。
   *
   * 为什么不用色带：色带是**稀疏**的（只有周末/假日），它的并集本来就不该触到绘制区左右缘，
   * 拿它判横向覆盖会恒红（P-24 落地时当场踩到）。刻度按档位步进、铺满视口，
   * 因此"第一个刻度离左缘不超过一个刻度间距、最后一个离右缘不超过一个刻度间距"才是可判定的形式。
   */
  readonly axisTicks: { readonly left: number; readonly right: number } | null;
  /** 一个刻度的像素间距（`pxPerDay × 该档位单位天数`）：横向覆盖的容差。 */
  readonly tickSpacingPx: number;
  /**
   * **日期刻度文本**的并集矩形；`null` = 该位置没有刻度文本。
   *
   * 判据：它必须落在**表头带**内（`[paneTop − headerHeightChart, paneTop]`）——
   * 否则刻度会压在**第一行**的条形上（P-24 复核第 ③ 条：批次 D 的表头带曾是空带、
   * 刻度仍画在绘制区顶部）。
   */
  readonly axisLabels: { readonly top: number; readonly bottom: number } | null;
  /**
   * **所见 = 所点**：把某一行行中心的屏幕 y 喂给应用**自己的** `pointerFromClient`，
   * 再与"该行的内容坐标中心"比较（`rowCenterY`）。
   */
  readonly hitTest: {
    readonly id: string;
    readonly row: number;
    readonly clientY: number;
    readonly expectedContentY: number;
    readonly actualContentY: number;
  } | null;
}

/** 机制标签（判读结论，不是"诊断码"——诊断码表是闭集，这里不新开码）。 */
export type AlignMechanism =
  | 'no-samples'
  | 'svg-not-pinned'
  | 'svg-scrolls-with-content'
  | 'svg-box-not-1to1'
  | 'pane-measure-stale'
  | 'table-body-height-mismatch'
  | 'table-row-height-mismatch'
  | 'header-height-mismatch'
  | 'scroll-out-of-sync'
  | 'table-header-offset-missing'
  | 'row-offset'
  | 'bar-x-offset'
  | 'hit-test-mismatch'
  | 'coverage-gap'
  | 'axis-not-covering'
  | 'axis-labels-not-in-header'
  | 'content-range-mismatch'
  /** P-40 批次②：本次测量**没有横向行程** ⇒ 横向机制（R12/R14）结构上不可见。 */
  | 'no-horizontal-travel'
  /** P-40 批次②：本次测量**没有纵向行程** ⇒ 纵向机制（R10/R13）结构上不可见。 */
  | 'no-vertical-travel'
  /** P-40 批次②：请求了 resize 但窗格尺寸没变 ⇒ 迁移判据的**前提不成立**，该轮无效。 */
  | 'resize-not-observed';

/** 一行的差值（`chartCenterY − tableCenterY`；对齐 = 0，图表比左表**高**时 < 0）。 */
export interface RowAlignDelta {
  readonly id: string;
  readonly row: number;
  readonly deltaPx: number;
}

/** 一次探测的判读。 */
export interface RowAlignVerdict {
  /** 全部判据通过（等价于 `mechanisms` 为空）。 */
  readonly ok: boolean;
  readonly maxAbsRowDeltaPx: number;
  /** 条形左/右边相对期望屏幕 x 的最大偏差（两栏**横向**对齐；R8 会在这里现形）。 */
  readonly maxAbsBarXDeltaPx: number;
  readonly rowDeltas: readonly RowAlignDelta[];
  /** SVG 钉在 scrollport 上（不随内容滚动）。 */
  readonly pinned: boolean;
  /** SVG **元素盒** = `viewBox`（1 用户单位 = 1 CSS px，R8）。 */
  readonly svgBoxAligned: boolean;
  readonly headerAligned: boolean;
  readonly heightAligned: boolean;
  /** 左表行外高 = 模型行高（ADR 0007 §4 的"固定行高"；否则逐行累积漂移）。 */
  readonly rowHeightAligned: boolean;
  /** 日期刻度落在**表头带**内（不侵入第一行）。 */
  readonly labelsInHeader: boolean;
  readonly scrollInSync: boolean;
  /** spacer 宽 = `ViewModel.contentWidth`（滚动范围真的够到项目末端，R11）。 */
  readonly contentRangeAligned: boolean;
  /** 顶/底空白带（px）；`null` = 文档比绘制区短，不做该断言。 */
  readonly coverage: { readonly topBandPx: number; readonly bottomBandPx: number } | null;
  readonly mechanisms: readonly AlignMechanism[];
}

/**
 * **亚像素舍入**（保留 3 位小数）。
 *
 * 名字里带 `SubPx` 是刻意的：本文件判读的是"差了多少 px"，差值的分辨率到 0.001 px 就够，
 * 因此这里**不做整数化**。别与 `svgExport.ts` 的 `roundPx`（整数化，导出坐标的口径）混用——
 * 两者曾经同名，正是 `noUncheckedIndexedAccess` 时代留下的同名异义。
 */
function roundSubPx(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * 判读一次探测（ADR 0007 §14 的可执行形式）。
 *
 * 口径：
 * - 全部比较用 `THRESHOLDS.rowAlignTolerancePx`；容差不逐个判据另设（避免"把阈值调到刚好变绿"）；
 * - 行差取 `max |chartCenterY − tableCenterY|`——**不允许**用"多数行对就算对"的多数票（单行漂移也要报）；
 * - `coverage` 只在"文档比绘制区长"时断言（否则最末行本来就在窗格内部，无所谓空白带）。
 */
export function diagnoseRowAlignment(probe: RowAlignProbe): RowAlignVerdict {
  const tol = THRESHOLDS.rowAlignTolerancePx;
  const mechanisms: AlignMechanism[] = [];

  if (probe.samples.length === 0) {
    return {
      ok: false,
      maxAbsRowDeltaPx: 0,
      maxAbsBarXDeltaPx: 0,
      rowDeltas: [],
      pinned: false,
      svgBoxAligned: false,
      headerAligned: false,
      heightAligned: false,
      rowHeightAligned: false,
      labelsInHeader: false,
      scrollInSync: false,
      contentRangeAligned: false,
      coverage: null,
      mechanisms: ['no-samples'],
    };
  }

  const rowDeltas: RowAlignDelta[] = probe.samples.map((sample) => ({
    id: sample.id,
    row: sample.row,
    deltaPx: roundSubPx(sample.chartCenterY - sample.tableCenterY),
  }));
  const maxAbsRowDeltaPx = roundSubPx(Math.max(...rowDeltas.map((item) => Math.abs(item.deltaPx))));

  const barDeltas: number[] = [];
  for (const sample of probe.samples) {
    if (sample.barLeft !== null && sample.expectedBarLeft !== null) {
      barDeltas.push(Math.abs(sample.barLeft - sample.expectedBarLeft));
    }
    if (sample.barRight !== null && sample.expectedBarRight !== null) {
      barDeltas.push(Math.abs(sample.barRight - sample.expectedBarRight));
    }
  }
  const maxAbsBarXDeltaPx = roundSubPx(barDeltas.length === 0 ? 0 : Math.max(...barDeltas));

  /**
   * SVG 钉在 scrollport 上：横向与绘制区左缘对齐，纵向 = 绘制区顶 **减一个表头带**
   * （ADR 0007 §15：SVG 覆盖整列，表头带 + 绘制区）。
   */
  const pinned =
    Math.abs(probe.svgLeft - probe.paneLeft) <= tol &&
    Math.abs(probe.svgTop - (probe.paneTop - probe.headerHeightChart)) <= tol;
  /** SVG 盒 = `viewBox`：宽 = 绘制区宽，高 = 绘制区高 + 表头带（1 用户单位 = 1 CSS px）。 */
  const svgBoxAligned =
    Math.abs(probe.svgWidth - probe.viewWidth) <= tol &&
    Math.abs(probe.svgHeight - (probe.viewHeight + probe.headerHeightChart)) <= tol;
  const headerAligned = Math.abs(probe.headerHeightChart - probe.headerHeightTable) <= tol;
  const heightAligned = Math.abs(probe.tableBodyHeight - probe.paneHeight) <= tol;
  const rowHeightAligned = Math.abs(probe.tableRowHeight - probe.rowHeight) <= tol;
  const scrollInSync =
    Math.abs(probe.viewScrollTop - probe.scrollTop) <= tol &&
    Math.abs(probe.viewScrollLeft - probe.scrollLeft) <= tol;
  const contentRangeAligned = Math.abs(probe.spacerWidth - probe.viewContentWidth) <= 1;
  /** 刻度文本必须整体落在表头带内：带的范围是 `[paneTop − 表头高, paneTop]`。 */
  const labelsInHeader =
    probe.axisLabels === null ||
    (probe.axisLabels.top >= probe.paneTop - probe.headerHeightChart - tol &&
      probe.axisLabels.bottom <= probe.paneTop + tol);
  const coverage =
    probe.rowCount * probe.rowHeight >= probe.paneHeight
      ? {
          topBandPx: roundSubPx(
            Math.max(
              0,
              Math.min(...probe.samples.map((item) => item.chartCenterY)) - probe.rowHeight / 2 - probe.paneTop,
            ),
          ),
          bottomBandPx: roundSubPx(
            Math.max(
              0,
              probe.paneTop +
                probe.paneHeight -
                Math.max(...probe.samples.map((item) => item.chartCenterY + probe.rowHeight / 2)),
            ),
          ),
        }
      : null;

  // -------- 机制判读（顺序 = 报告顺序；多条可同时成立）
  if (!contentRangeAligned) mechanisms.push('content-range-mismatch');
  if (!labelsInHeader) mechanisms.push('axis-labels-not-in-header');
  if (!pinned) {
    const shift = probe.svgTop - (probe.paneTop - probe.headerHeightChart);
    mechanisms.push(
      probe.scrollTop > tol && Math.abs(shift + probe.scrollTop) <= tol
        ? 'svg-scrolls-with-content'
        : 'svg-not-pinned',
    );
  }
  if (!svgBoxAligned) mechanisms.push('svg-box-not-1to1');
  if (Math.abs(probe.viewHeight - probe.paneHeight) > tol) mechanisms.push('pane-measure-stale');
  if (!heightAligned) mechanisms.push('table-body-height-mismatch');
  if (!rowHeightAligned) mechanisms.push('table-row-height-mismatch');
  if (!headerAligned) mechanisms.push('header-height-mismatch');
  if (!scrollInSync) mechanisms.push('scroll-out-of-sync');

  if (maxAbsRowDeltaPx > tol) {
    // ②的签名：SVG 已钉住、行差**恒**等于"少了一个表头带"。
    const constantHeaderOffset =
      pinned && Math.abs(median(rowDeltas.map((item) => item.deltaPx)) + probe.headerHeightTable) <= tol;
    mechanisms.push(constantHeaderOffset ? 'table-header-offset-missing' : 'row-offset');
  }
  if (probe.hitTest !== null) {
    if (Math.abs(probe.hitTest.actualContentY - probe.hitTest.expectedContentY) > tol) {
      mechanisms.push('hit-test-mismatch');
    }
  }
  if (maxAbsBarXDeltaPx > tol) mechanisms.push('bar-x-offset');
  if (coverage !== null && (coverage.topBandPx > tol || coverage.bottomBandPx > tol)) mechanisms.push('coverage-gap');
  /**
   * **纵向覆盖**：轴的**背景层**（周末色带 / 月份正文底 ∪ 月边界线）必须铺满 **SVG 的整高**
   * （= 表头带 + 绘制区）。
   *
   * ## 基准为什么是 `svgTop`/`svgHeight` 而不是 `paneTop`/`paneHeight`（G8 复验第 ⑤ 条连带订正）
   *
   * 轴的载体是那一个 SVG：`<svg :height="svgHeight">` 覆盖**整列**，`y ∈ [0, svgHeight]`；
   * 而 `paneTop` 是**绘制区**的顶（= `svgTop + headerHeight`）。旧写法拿"轴顶 vs 绘制区顶"比，
   * 在"刻度线整高、轴最高只到绘制区顶"时恰好相等；G8 把月边界线画成**含表头带的全高**之后，
   * 轴的并集顶自然变成 `svgTop`，于是旧写法恒红 **40 px**（= 一个表头带）——
   * **画面完全正确**。⇒ 基准改成 SVG 的盒（那才是这一层真正要铺满的范围）。
   *
   * 这条也顺带把"表头带里没有轴元素"这类漏画抓在同一个判据里。
   */
  const axisCoversVertically =
    probe.axisCoverage !== null &&
    Math.abs(probe.axisCoverage.top - probe.svgTop) <= tol &&
    probe.axisCoverage.bottom >= probe.svgTop + probe.svgHeight - tol;
  /**
   * **横向"铺满"：容差是「一个刻度间距 + 相位」——即最多 1.5 个间距**（G8 复验第 ⑤ 条的连带订正）。
   *
   * ## 为什么要改（这不是放宽阈值，是把判据改回它要说的事）
   *
   * 旧写法是"最左刻度 ≤ 左缘 + 1 间距 且 最右刻度 ≥ 右缘 − 1 间距"，它只在
   * **网格线被画成整高**时成立——那时"刻度"是一条条铺满绘制区的竖线，
   * "有没有刻度铺满宽度"就等价于"轴有没有横向错位"。
   *
   * G8 起刻度线只标记**该档位的边界日**（日档每天、周档周一、月档 30 天单位），
   * 而窗格两端**不必落在边界日上**，于是最右刻度离右缘可以到"接近一个完整间距"：
   * 实测周档间距 56 px、窗格右缘 1265 px、最右刻度 1254 px（差 11 px，旧判据恰好能过）；
   * 月档间距 90 px、最右刻度 1210 px（差 55 px，**画面完全正确而旧判据必红**）。
   *
   * ## 现在的形式（仍然能抓住"横向错位"）
   *
   * 轴元素的并集必须**与可见的窗格区间有实质重叠**：左端不晚于"左缘 + 1.5 间距"、
   * 右端不早于"右缘 − 1.5 间距"。一个横向偏了半个屏幕的轴会**立刻**越出这两条
   * （`--align` 在六个滚动位置 × 三档位上各跑一遍，横向错位原本就会由
   * `maxAbsBarXDeltaPx` / `content-range-mismatch` / `scrollInSync` 更直接地报出来）。
   */
  const axisHorizon = probe.tickSpacingPx * 1.5;
  const axisCoversHorizontally =
    probe.axisTicks !== null &&
    probe.axisTicks.left <= probe.paneLeft + axisHorizon + tol &&
    probe.axisTicks.right >= probe.paneLeft + probe.paneWidth - axisHorizon - tol;
  if (!axisCoversVertically || !axisCoversHorizontally) mechanisms.push('axis-not-covering');

  return {
    ok: mechanisms.length === 0,
    maxAbsRowDeltaPx,
    maxAbsBarXDeltaPx,
    rowDeltas,
    pinned,
    svgBoxAligned,
    headerAligned,
    heightAligned,
    rowHeightAligned,
    labelsInHeader,
    scrollInSync,
    contentRangeAligned,
    coverage,
    mechanisms,
  };
}

/**
 * 一次滚动位置的"**请求 vs 实际**"。
 *
 * 为什么不从 {@link RowAlignProbe} 派生：`RowAlignProbe` 是**判据的输入**（只含 DOM 真值与
 * 应用状态），而"请求过什么"是**采数过程的事实**。分开之后，覆盖度判读可以独立于采数实现被检验
 * （`align.spec.ts` 直接合成请求/实际对即可）。
 */
export interface ScrollPositionFact {
  readonly requestedTop: number;
  readonly requestedLeft: number;
  /** 该位置读到的**真实** `scrollTop`（浏览器会把请求值夹进可表示范围）。 */
  readonly actualTop: number;
  readonly actualLeft: number;
}

/**
 * 该次测量**覆盖到的滚动行程**（P-40 批次②）。
 *
 * ## 为什么这是一条判据而不是一句描述
 *
 * P-24 的教训是"**只探纵向的判据结构上抓不到横向机制**"（R12 在 `scrollLeft = 0` 处恒为 0）；
 * P-40 批次②把它推到底：**判据必须覆盖"机制被激活"的那片区域，而且这件事本身要被判定**。
 * 两种情况会让覆盖静默消失：
 *
 * 1. 内容**整幅不滚动**（周/月档的小文档：`contentWidth ≤ 窗格宽`）⇒ 浏览器把"超大值"位置
 *    夹回 `0`，于是 `(0, max)` 与 `(0, 0)` 完全等价——探针输出"6 位置全绿"，**横向什么都没测**；
 * 2. 反过来的极端（只探到横向、没有纵向行程）同理。
 *
 * 因此覆盖度**不足即判失败**（P-12 的"缺失即失败，不静默跳过"）：一次无法激活机制的测量
 * 不能记成 ✅，只能记成"这次测量不构成该方向的判据"。
 */
export interface ScrollCoverage {
  readonly maxScrollTop: number;
  readonly maxScrollLeft: number;
  /** 至少一个位置真的 `scrollLeft > 0`（否则横向机制不可见）。 */
  readonly horizontalCovered: boolean;
  readonly verticalCovered: boolean;
  /** 请求了非 0 却被夹回**比请求值小得多**的位置数（"超大值被夹住"的显式计数）。 */
  readonly clampedPositions: number;
  readonly mechanisms: readonly AlignMechanism[];
  readonly ok: boolean;
}

/** 判读滚动覆盖度（纯函数；输入是"请求 vs 实际"，见 {@link ScrollPositionFact}）。 */
export function diagnoseScrollCoverage(facts: readonly ScrollPositionFact[]): ScrollCoverage {
  const maxScrollTop = facts.length === 0 ? 0 : Math.max(...facts.map((fact) => fact.actualTop));
  const maxScrollLeft = facts.length === 0 ? 0 : Math.max(...facts.map((fact) => fact.actualLeft));
  // "被夹住"只统计**请求非 0 而实际为 0**的位置：这正是"位置退化成与 (0,0) 等价"的字面形式。
  const clampedPositions = facts.filter(
    (fact) => (fact.requestedTop > 0 && fact.actualTop === 0) || (fact.requestedLeft > 0 && fact.actualLeft === 0),
  ).length;
  const horizontalCovered = maxScrollLeft > 0;
  const verticalCovered = maxScrollTop > 0;
  const mechanisms: AlignMechanism[] = [];
  if (!horizontalCovered) mechanisms.push('no-horizontal-travel');
  if (!verticalCovered) mechanisms.push('no-vertical-travel');
  return {
    maxScrollTop,
    maxScrollLeft,
    horizontalCovered,
    verticalCovered,
    clampedPositions,
    mechanisms,
    ok: mechanisms.length === 0,
  };
}

/** resize 迁移的前提与结论（P-40 批次② 的 ②-C）。 */
export interface ResizeMigrationVerdict {
  /** 窗格尺寸**真的变了**（否则这一轮测量不构成迁移判据）。 */
  readonly observed: boolean;
  readonly deltaWidth: number;
  readonly deltaHeight: number;
  readonly mechanisms: readonly AlignMechanism[];
}

/**
 * 判读一次"resize 迁移"的**前提自证**：迁移前后的窗格尺寸必须真的不同。
 *
 * 为什么需要它：迁移判据（"尺寸变化后两栏仍自洽"）在**尺寸没变**时会退化成"又量了一次同一状态"，
 * 于是"没变"与"变好了"给出同一个绿。同族的先例是 `textFixtures.spec.ts` 的**前提自证**
 * （20089 vs 20731）——凡"对照"都要先证明对照真的发生了。
 *
 * 迁移**本身的**一致性判据不在这里：它复用 {@link diagnoseRowAlignment}（同一份机制表），
 * 因为"过期重算"的签名就是 `pane-measure-stale` / `table-body-height-mismatch` /
 * `svg-box-not-1to1` / `scroll-out-of-sync` 这几条。
 */
export function diagnoseResizeMigration(input: {
  readonly beforeWidth: number;
  readonly beforeHeight: number;
  readonly afterWidth: number;
  readonly afterHeight: number;
}): ResizeMigrationVerdict {
  const deltaWidth = roundSubPx(input.afterWidth - input.beforeWidth);
  const deltaHeight = roundSubPx(input.afterHeight - input.beforeHeight);
  const observed = Math.abs(deltaWidth) > 0 || Math.abs(deltaHeight) > 0;
  return {
    observed,
    deltaWidth,
    deltaHeight,
    mechanisms: observed ? [] : ['resize-not-observed'],
  };
}

/** 一次完整测量（多个滚动位置）的汇总判读。 */
export function summarizeAlignment(
  verdicts: readonly RowAlignVerdict[],
  coverage?: ScrollCoverage,
): {
  readonly ok: boolean;
  readonly probes: number;
  readonly failingProbes: number;
  readonly maxAbsRowDeltaPx: number;
  readonly maxAbsBarXDeltaPx: number;
  readonly mechanisms: readonly AlignMechanism[];
  /** 未提供覆盖度输入时为 `null`（老调用点/诊断用）。 */
  readonly coverage: ScrollCoverage | null;
} {
  const mechanisms = [
    ...new Set([...verdicts.flatMap((verdict) => [...verdict.mechanisms]), ...(coverage?.mechanisms ?? [])]),
  ];
  return {
    ok: verdicts.length > 0 && verdicts.every((verdict) => verdict.ok) && (coverage === undefined || coverage.ok),
    probes: verdicts.length,
    failingProbes: verdicts.filter((verdict) => !verdict.ok).length,
    maxAbsRowDeltaPx: verdicts.length === 0 ? 0 : Math.max(...verdicts.map((verdict) => verdict.maxAbsRowDeltaPx)),
    maxAbsBarXDeltaPx: verdicts.length === 0 ? 0 : Math.max(...verdicts.map((verdict) => verdict.maxAbsBarXDeltaPx)),
    mechanisms,
    coverage: coverage ?? null,
  };
}
