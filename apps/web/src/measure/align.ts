/**
 * 两栏行对齐（`--align`）：**只采数**——判读在 `render-core` 的 `align.ts`（`align.spec.ts` 27 例）。
 *
 * 采数走用户的同一条指针换算（`pointerFromClientOf`）与同一条 `setZoom`，
 * 因此"所见 = 所点"不是一条平行公式（ADR 0007 §14）。
 */

import { nextTick } from 'vue';

import { diagnoseResizeMigration, diagnoseRowAlignment, diagnoseScrollCoverage, summarizeAlignment, type ResizeMigrationVerdict, type RowAlignProbe, type RowAlignSample, type RowAlignVerdict, type ScrollCoverage } from '@ganttpilot/render-core/align';
import { ZOOM_UNIT_DAYS, type PointerInput, type ViewModel, type ZoomKey } from '@ganttpilot/render-core';

import { CHART_ROW_SELECTOR, STABLE_READ_BUDGET_FRAMES, boxOf, scrollFingerprint, settleStableRead } from './dom.js';

/** 对齐测量的宿主：由 `measureHost.ts`（应用侧接线）提供（除 `setZoom` 外全部**只读**）。 */
export interface AlignMeasurementHost {
  /** 当前渲染的视图模型（提供行序、行高、条形的**内容坐标**）。 */
  readonly view: () => ViewModel | null;
  /** 滚动容器（绘制区）元素。 */
  readonly pane: () => HTMLElement | null;
  /**
   * 屏幕坐标 → 内容坐标（**与用户操作同一条路**：`useChartPointer.ts` 的 `pointerFrom` 走的纯函数）。
   * **只读**：不派发事件、不进入手势状态机。
   */
  readonly pointerFromClientOf: (clientX: number, clientY: number) => PointerInput | null;
  /**
   * 切档位（P-40 批次②）：`--align` 必须覆盖周/月档，而**档位住在页面状态里**——
   * 记录制因此走**用户点工具栏的同一个** `chart.setZoom`，不另开测试后门。
   */
  readonly setZoom?: (zoom: ZoomKey) => void;
}

/** 探测位置：**比例**（`0..1`，按真实可滚动行程解析）或绝对像素（诊断用）。 */
export interface AlignPositionSpec {
  readonly top: number;
  readonly left: number;
}

/** 一次探测（一个滚动位置）的结果。 */
export interface AlignProbeResult {
  /** 请求的 `scrollTop` / `scrollLeft`；浏览器会夹到可表示范围，**真值**见 `probe`。 */
  readonly requestedScrollTop: number;
  readonly requestedScrollLeft: number;
  /** 该位置"等应用处理完"用掉的帧数（稳定判据的读数；证据里登记它）。 */
  readonly settleFrames: number;
  readonly probe: RowAlignProbe;
  readonly verdict: RowAlignVerdict;
}

/** 对齐测量的结果（判读逻辑在 `render-core/align.ts`，**那份进 `pnpm gate`**）。 */
export interface AlignMeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  /** **实际生效**的档位（从 `ViewModel` 读回，不信调用方传了什么）。 */
  readonly zoom: string;
  /** `positions` = 逐个位置设滚动后读；`reread` = **不设滚动**、只重读当前状态（resize 迁移的第二步）。 */
  readonly mode: 'positions' | 'reread';
  readonly probes: readonly AlignProbeResult[];
  /** 稳定读的帧预算（**从实现里读回**，证据要登记它，不在脚本里抄第二份）。 */
  readonly stableReadBudgetFrames: number;
  /** 滚动覆盖度（`reread` 模式为 `null`：单点无法证明"有行程"）。 */
  readonly coverage: ScrollCoverage | null;
  readonly migration: ResizeMigrationVerdict | null;
  readonly summary: {
    readonly ok: boolean;
    readonly probes: number;
    readonly failingProbes: number;
    readonly maxAbsRowDeltaPx: number;
    readonly maxAbsBarXDeltaPx: number;
    readonly mechanisms: readonly string[];
    readonly coverage: ScrollCoverage | null;
  };
}

/**
 * 默认探测位置（**比例**，`0..1`）：横向与纵向都必须含 **0 与 1**。
 *
 * 四条硬要求：
 * ① 双重偏移在 `scrollTop = 0` 处恒为 0（机制**不可见**）⇒ 至少两个位置才判得出机制（P-22 遗留 1）；
 * ② `1` 由**真实可滚动行程**解析 ⇒ 空白带（"下方/右侧新区域空白"）也在被测范围内；
 * ③ **横向同样要探**（P-24）：轴的横向双重偏移在 `scrollLeft = 0` 处同样不可见；
 * ④ **比例而非绝对像素**（P-40 批次②）：绝对像素在"内容整幅不滚动"的档位下会被夹回 0，
 *    于是 `(0, max)` 与 `(0, 0)` 等价、横向**静默没测**——比例解析后这件事由
 *    `diagnoseScrollCoverage` 显式判出（`no-horizontal-travel`），而不是记成 ✅。
 */
const ALIGN_POSITION_FRACTIONS: readonly AlignPositionSpec[] = [
  { top: 0, left: 0 },
  { top: 0.5, left: 0 },
  { top: 1, left: 0 },
  { top: 0, left: 0.5 },
  { top: 0, left: 1 },
  { top: 1, left: 1 },
];

/**
 * 跑一次两栏行对齐测量（G5 批次 D + P-40 批次②，**记录制**）。
 *
 * 口径（必须与数字一起引用）：
 * - **只读**：只设滚动位置并读矩形，**不改文档、不派发指针事件、不进手势**；结束把滚动复位 0；
 * - 每个位置：设滚动 → `nextTick` → **等读数稳定**（{@link settleStableRead}：连续两帧指纹一致；
 *   预算 `STABLE_READ_BUDGET_FRAMES` 帧内不稳定 ⇒ **判红**）。旧口径是写死的"两帧"、无人守；
 * - **位置按比例解析**（`fractions`，`0..1` × 真实可滚动行程）：绝对像素在"整幅不滚动"的档位下会被夹回 0；
 * - **覆盖度**由 `diagnoseScrollCoverage` 判：整次测量没有横向/纵向行程 ⇒ 判失败，不记 ✅；
 * - `mode: 'reread'`（resize 迁移的第二步）：**不重载夹具、不设滚动**，只重读当前状态；
 *   此模式下不判覆盖度（单点无法证明"有行程"）；
 * - 行按 `data-task-id` 配对（图表 `<g>` ↔ 左表 `.row`），**两侧计数必须与被渲染行数相等**；
 * - 判读全部交 `diagnoseRowAlignment` / `diagnoseScrollCoverage` / `diagnoseResizeMigration`
 *   （纯函数、进门禁），本函数只负责采数。
 */
export async function runAlignMeasurement(args: {
  readonly host: AlignMeasurementHost;
  readonly dataset: string;
  readonly mode?: 'positions' | 'reread';
  /** 绝对像素位置（诊断用；与 `fractions` 二者取一）。 */
  readonly positions?: readonly AlignPositionSpec[];
  /** 比例位置（`0..1`；默认 {@link ALIGN_POSITION_FRACTIONS}）。 */
  readonly fractions?: readonly AlignPositionSpec[];
  /** 迁移判据的**前一次**窗格尺寸（给了就判 `resize-not-observed`）。 */
  readonly previousPane?: { readonly width: number; readonly height: number } | null;
  /**
   * 采完**不复位滚动**（P-40 批次② 的迁移轮必须这样：复位会把"resize 前的滚动位置"抹掉，
   * 于是迁移后只能读到 `0·0`——而机制**恰在 0 处不可见**）。
   */
  readonly keepScroll?: boolean;
  /**
   * `reread` 模式下"应该还在"的滚动位置（迁移前设的那个）：
   * 给了就用它做**位置存活性**判读（实际读到 0 ⇒ 覆盖度判失败 ⇒ 这一轮不构成迁移判据）。
   */
  readonly expectedScroll?: { readonly top: number; readonly left: number } | null;
}): Promise<AlignMeasureResult> {
  const mode = args.mode ?? 'positions';
  const emptySummary = {
    ok: false,
    probes: 0,
    failingProbes: 0,
    maxAbsRowDeltaPx: 0,
    maxAbsBarXDeltaPx: 0,
    mechanisms: [] as readonly string[],
    coverage: null as ScrollCoverage | null,
  };
  const failed = (errors: readonly string[]): AlignMeasureResult => ({
    status: 'error',
    errors,
    dataset: args.dataset,
    zoom: 'unknown',
    mode,
    probes: [],
    stableReadBudgetFrames: STABLE_READ_BUDGET_FRAMES,
    coverage: null,
    migration: null,
    summary: emptySummary,
  });

  const pane = args.host.pane() ?? document.getElementById('chart-pane');
  if (pane === null) return failed(['找不到图表窗格（#chart-pane，或宿主未就绪）']);
  if (document.querySelector('.table-body') === null) {
    return failed([
      '找不到左表表体（.table-body）——`--align` 必须在**左表可见**的页面上跑（不要加 `?table=0`）',
    ]);
  }

  const errors: string[] = [];
  const probes: AlignProbeResult[] = [];

  // 位置解析：`reread` 只读**当前**位置；否则 绝对像素优先，其次比例 × 真实可滚动行程。
  const maxTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
  const maxLeft = Math.max(0, pane.scrollWidth - pane.clientWidth);
  const requestedPositions: readonly AlignPositionSpec[] =
    mode === 'reread'
      ? [{ top: pane.scrollTop, left: pane.scrollLeft }]
      : (args.positions ??
        (args.fractions ?? ALIGN_POSITION_FRACTIONS).map((fraction) => ({
          top: Math.round(fraction.top * maxTop),
          left: Math.round(fraction.left * maxLeft),
        })));
  const applyScroll = mode === 'positions';

  for (const requested of requestedPositions) {
    if (applyScroll) {
      pane.scrollTop = requested.top;
      pane.scrollLeft = requested.left;
      await nextTick();
    }
    // **等读数稳定**（不是"等两帧"）：连续两帧指纹一致才算应用处理完；预算耗尽 ⇒ 判红。
    const settled = await settleStableRead({
      fingerprint: () => {
        const current = args.host.view();
        return scrollFingerprint(pane, {
          scrollTop: current?.scrollTop ?? -1,
          scrollLeft: current?.scrollLeft ?? -1,
          contentWidth: current?.contentWidth ?? -1,
        });
      },
    });
    if (!settled.stable) {
      errors.push(
        `top=${String(requested.top)}/left=${String(requested.left)}：读数在 ${String(STABLE_READ_BUDGET_FRAMES)} 帧内未稳定` +
          `（应用未在预算内处理完滚动——判据此时取到的是中间态，故判红）`,
      );
    }

    const view = args.host.view();
    if (view === null) {
      errors.push(`top=${String(requested.top)}/left=${String(requested.left)}：ViewModel 为 null（不可排程？）`);
      continue;
    }

    const paneBox = boxOf(pane);
    if (paneBox === null) {
      errors.push(`top=${String(requested.top)}/left=${String(requested.left)}：读不到窗格矩形`);
      continue;
    }

    const rowGroups = [...document.querySelectorAll(CHART_ROW_SELECTOR)];
    const tableRows = [...document.querySelectorAll('.table-body .row-block .row[data-task-id]')];
    // 左表行的 **DOM 外高**（R9 的直接签名：它必须等于模型行高）。
    const tableRowHeight = tableRows.length === 0 ? 0 : (boxOf(tableRows[0] ?? null)?.height ?? 0);
    if (rowGroups.length !== view.rows.length || tableRows.length !== view.rows.length) {
      errors.push(
        `scrollTop=${String(pane.scrollTop)}：两侧行数与渲染行数不一致（图表 ${String(rowGroups.length)} / 左表 ${String(tableRows.length)} / 渲染 ${String(view.rows.length)}）`,
      );
    }

    const chartById = new Map<
      string,
      { readonly centerY: number | null; readonly barLeft: number | null; readonly barRight: number | null }
    >();
    for (const group of rowGroups) {
      const id = group.getAttribute('data-task-id');
      if (id === null) continue;
      /**
       * **行中心必须从"垂直居中的那一个图元"取**，不能用 `<g>` 的矩形。
       *
       * 理由（批次 B／P-32 落地时当场踩到）：`<g>` 没有自己的盒子，它返回的是**子元素并集**。
       * 批次 B 给每行加了端点手柄（8 px `<line>`）与连接点（8 px `<rect>`），
       * 于是并集不再等于"条/菱形"的盒子——实测把行中心整体抬高了 **4.4 px**，
       * 判据报 `row-offset` / `hit-test-mismatch`（**是采错了量，不是对齐坏了**：条形 x 偏差仍是 0.000）。
       *
       * 正确取法：条（`rect.bar` 或菱形 `polygon.milestone`）在行内**垂直居中**（`ViewModel.barY`），
       * 因此"该图元的中心 = 行中心"。取不到任何几何图元时记 `null`（该行不参与判读）。
       *
       * **选择器必须点名 class**：行组里还有 `.bar-progress` 与 `.connect-point`（两者也是 `<rect>`），
       * 取"第一个 rect"会量到手柄/连接点。
       */
      const barNode = group.querySelector('rect.bar, polygon.milestone');
      const bar = boxOf(barNode);
      const isDiamond = barNode !== null && barNode.tagName === 'polygon';
      chartById.set(id, {
        centerY: bar === null ? null : bar.top + bar.height / 2,
        barLeft: bar === null || isDiamond ? null : bar.left,
        barRight: bar === null || isDiamond ? null : bar.left + bar.width,
      });
    }

    const geometryOf = new Map(view.rows.map((row) => [row.id, row]));
    const samples: RowAlignSample[] = [];
    for (const tableRow of tableRows) {
      const id = tableRow.getAttribute('data-task-id');
      if (id === null) continue;
      const chart = chartById.get(id);
      const table = boxOf(tableRow);
      const geometry = geometryOf.get(id);
      if (chart === undefined || chart.centerY === null || table === null || geometry === undefined) continue;
      const expectedBarLeft = geometry.isMilestone ? null : paneBox.left + geometry.xLeft - view.scrollLeft;
      samples.push({
        id,
        row: geometry.row,
        chartCenterY: chart.centerY,
        // 左表按**模型行高**取行中心（不按 DOM 外高——外高含 1 px 边框，那正是 R9 被抓住的地方）。
        tableCenterY: table.top + view.rowHeight / 2,
        barLeft: chart.barLeft,
        barRight: chart.barRight,
        expectedBarLeft,
        expectedBarRight: expectedBarLeft === null ? null : paneBox.left + geometry.xRight - view.scrollLeft,
      });
    }
    if (samples.length < 8) {
      errors.push(`scrollTop=${String(pane.scrollTop)}：可配对的行不足 8 行（实际 ${String(samples.length)}）`);
      continue;
    }

    // 所见 = 所点：取中间那一行的**行中心屏幕 y**，走应用自己的换算。
    const middle = samples[Math.floor(samples.length / 2)];
    let hitTest: RowAlignProbe['hitTest'] = null;
    if (middle !== undefined) {
      const clientY = middle.chartCenterY;
      const pointer = args.host.pointerFromClientOf(paneBox.left + 1, clientY);
      hitTest = {
        id: middle.id,
        row: middle.row,
        clientY,
        expectedContentY: middle.row * view.rowHeight + view.rowHeight / 2,
        actualContentY: pointer === null ? Number.NaN : pointer.y,
      };
    }

    /**
     * **轴的覆盖范围**（P-24 的四边口径；G8 复验第 ⑤ 条后重新定义"哪些元素算轴"）。
     *
     * ## 两层要分开看（这是本轮的关键订正）
     *
     * | 层 | 元素 | 量什么 |
     * |---|---|---|
     * | **纵向** | `.axis rect`（周末色带 / 月份正文底）**∪** `.axis-major-edge`（全高月边界线） | 轴是否铺满绘制区的高度（`top = 窗格顶`、`bottom ≥ 窗格底`） |
     * | **横向** | `.axis-tick`（表头带内的短刻度）**∪** `.axis-major-edge` | 刻度是否铺满视口宽度（左右各留不超过一个刻度间距） |
     *
     * **为什么不能只看色带**：色带是**稀疏**的（只有周末/假日），它的并集本来就不该触到绘制区上下缘——
     * 拿它判纵向覆盖会恒红（P-24 落地时当场踩到过）。旧口径"有色带就只用色带、否则用网格线"
     * 在网格线**整高**时恰好能过；而 G8 把刻度线收进表头带之后，
     * `line` 的纵向范围只剩表头那 6 px ⇒ 旧口径必然判红。
     * 现在按"**轴背景（整高）** 与 **刻度（表头带内）**"分别取并集，两边的语义各自成立。
     *
     * `.hover-row` 仍**显式排除**（P-46）：它是内容滚动的覆盖层，混进来会让纵向判据读到"那一行"的上下界。
     */
    const verticalBoxes = [
      ...document.querySelectorAll(
        '.chart-pane-wrap .axis rect:not(.hover-row), #chart-pane .axis rect:not(.hover-row)',
      ),
      ...document.querySelectorAll(
        '.chart-pane-wrap .axis-major-edge, #chart-pane .axis-major-edge',
      ),
    ]
      .map((element) => boxOf(element))
      .filter((box) => box !== null);
    const axisCoverage =
      verticalBoxes.length === 0
        ? null
        : {
            top: Math.min(...verticalBoxes.map((box) => box.top)),
            bottom: Math.max(...verticalBoxes.map((box) => box.top + box.height)),
            left: Math.min(...verticalBoxes.map((box) => box.left)),
            right: Math.max(...verticalBoxes.map((box) => box.left + box.width)),
          };
    /**
     * **横向覆盖**用刻度：色带是稀疏的（其并集本来就不该触到左右缘）。
     *
     * G8 起刻度线只画在表头带内 ⇒ 这里取 `.axis-tick`（表头带内的短刻度）
     * **∪** `.axis-major-edge`（全高月边界线）的横向并集——两者都落在"这一天的位置"上。
     *
     * **边距容差按档位放宽到"刻度间距"**（G8 复验第 ⑤ 条的连带订正）：刻度线只标记
     * **该档位的边界日**（日档每天、周档周一、月档 1 日），而视口两端**不必落在边界日上**——
     * 例如周档下窗格右缘在周四时，最右的刻度离右缘还有 3 天（= 半个刻度间距）。
     * 旧口径（`axisTicks.right >= paneRight − tickSpacing`）在"刻度线整高"时代恰好能过，
     * 现在必须允许最多**一个刻度间距**（那是"刻度日之间的最大间隔"本身）。
     */
    const tickBoxes = [
      ...document.querySelectorAll('.chart-pane-wrap .axis-tick, #chart-pane .axis-tick'),
      ...document.querySelectorAll('.chart-pane-wrap .axis-major-edge, #chart-pane .axis-major-edge'),
    ]
      .map((element) => boxOf(element))
      .filter((box) => box !== null);
    const axisTicks =
      tickBoxes.length === 0
        ? null
        : {
            left: Math.min(...tickBoxes.map((box) => box.left)),
            right: Math.max(...tickBoxes.map((box) => box.left + box.width)),
          };

    // 日期刻度文本的并集：判"刻度在表头带内、不侵入第一行"（P-24 第 ③ 条）。
    const labelBoxes = [
      ...document.querySelectorAll('.chart-pane-wrap .axis-labels text, #chart-pane .axis-labels text'),
    ]
      .map((element) => boxOf(element))
      .filter((box) => box !== null);
    const axisLabels =
      labelBoxes.length === 0
        ? null
        : {
            top: Math.min(...labelBoxes.map((box) => box.top)),
            bottom: Math.max(...labelBoxes.map((box) => box.top + box.height)),
          };

    const headerChart = boxOf(document.querySelector('.chart-header'));
    const headerTable = boxOf(document.querySelector('.table-header'));
    const tableBody = boxOf(document.querySelector('.table-body'));
    const svg = boxOf(document.querySelector('.chart-pane-wrap .gantt-svg, #chart-pane .gantt-svg'));
    const spacer = boxOf(document.querySelector('#chart-pane .chart-spacer'));

    const probe: RowAlignProbe = {
      scrollTop: pane.scrollTop,
      viewScrollTop: view.scrollTop,
      scrollLeft: pane.scrollLeft,
      viewScrollLeft: view.scrollLeft,
      paneTop: paneBox.top,
      paneLeft: paneBox.left,
      paneHeight: pane.clientHeight,
      paneWidth: pane.clientWidth,
      headerHeightChart: headerChart === null ? 0 : headerChart.height,
      headerHeightTable: headerTable === null ? 0 : headerTable.height,
      tableBodyHeight: tableBody === null ? 0 : tableBody.height,
      svgTop: svg === null ? paneBox.top : svg.top,
      svgLeft: svg === null ? paneBox.left : svg.left,
      svgWidth: svg === null ? 0 : svg.width,
      svgHeight: svg === null ? 0 : svg.height,
      viewWidth: view.width,
      viewHeight: view.height,
      spacerHeight: spacer === null ? 0 : spacer.height,
      spacerWidth: spacer === null ? 0 : spacer.width,
      viewContentWidth: view.contentWidth,
      rowCount: view.rowCount,
      rowHeight: view.rowHeight,
      tableRowHeight,
      samples,
      axisCoverage,
      axisTicks,
      tickSpacingPx: view.pxPerDay * (ZOOM_UNIT_DAYS[view.zoom] ?? 1),
      axisLabels,
      hitTest,
    };
    probes.push({
      requestedScrollTop: requested.top,
      requestedScrollLeft: requested.left,
      settleFrames: settled.frames,
      probe,
      verdict: diagnoseRowAlignment(probe),
    });
  }

  // 复位（诊断是只读的：不给下一次测量留下滚动位置）——迁移轮用 `keepScroll` 明确豁免。
  if (args.keepScroll !== true) {
    pane.scrollTop = 0;
    pane.scrollLeft = 0;
  }

  if (probes.length !== requestedPositions.length) {
    errors.push(`有效探测 ${String(probes.length)} / 请求 ${String(requestedPositions.length)}`);
  }

  /**
   * 覆盖度只在 `positions` 模式下按**本次采到的行程**判；
   * `reread`（迁移第二步）用"期望位置 vs 实际位置"判**位置存活性**——
   * 实际读到 0 时该轮不构成迁移判据（机制在 0 处不可见），而不是记成 ✅。
   */
  const coverage =
    mode === 'positions'
      ? diagnoseScrollCoverage(
          probes.map((item) => ({
            requestedTop: item.requestedScrollTop,
            requestedLeft: item.requestedScrollLeft,
            actualTop: item.probe.scrollTop,
            actualLeft: item.probe.scrollLeft,
          })),
        )
      : args.expectedScroll === undefined || args.expectedScroll === null || probes.length === 0
        ? null
        : diagnoseScrollCoverage([
            {
              requestedTop: args.expectedScroll.top,
              requestedLeft: args.expectedScroll.left,
              actualTop: probes[0]?.probe.scrollTop ?? 0,
              actualLeft: probes[0]?.probe.scrollLeft ?? 0,
            },
          ]);
  if (coverage !== null && !coverage.ok) {
    errors.push(
      `滚动覆盖度不足（这次测量不构成对应方向的判据）：机制 ${coverage.mechanisms.join(' / ')}；` +
        `实测最大 scrollTop/scrollLeft = ${String(coverage.maxScrollTop)} / ${String(coverage.maxScrollLeft)}` +
        `（请求非 0 却被夹回 0 的位置数 ${String(coverage.clampedPositions)}）`,
    );
  }

  // 迁移判据：给了"前一次窗格尺寸"就判前提自证 + 复用同一份行对齐机制表。
  const firstProbe = probes[0]?.probe ?? null;
  const migration =
    args.previousPane !== undefined && args.previousPane !== null && firstProbe !== null
      ? diagnoseResizeMigration({
          beforeWidth: args.previousPane.width,
          beforeHeight: args.previousPane.height,
          afterWidth: firstProbe.paneWidth,
          afterHeight: firstProbe.paneHeight,
        })
      : null;
  if (migration !== null && !migration.observed) {
    errors.push(
      `resize 迁移的前提不成立：窗格尺寸没有变化（Δ ${String(migration.deltaWidth)} × ${String(migration.deltaHeight)}）` +
        `——"没变"不能与"变好了"共用一个绿`,
    );
  }

  const summary = summarizeAlignment(
    probes.map((item) => item.verdict),
    coverage ?? undefined,
  );
  if (!summary.ok) {
    errors.push(
      `两栏行对齐未通过：最大行差 ${summary.maxAbsRowDeltaPx.toFixed(3)} px、` +
        `最大条形 x 偏差 ${summary.maxAbsBarXDeltaPx.toFixed(3)} px、机制 ${summary.mechanisms.join(' / ') || '(无)'}`,
    );
  }

  return {
    status: errors.length === 0 && summary.ok && (migration === null || migration.observed) ? 'ok' : 'error',
    errors,
    dataset: args.dataset,
    zoom: firstProbe === null ? 'unknown' : args.host.view()?.zoom ?? 'unknown',
    mode,
    probes,
    stableReadBudgetFrames: STABLE_READ_BUDGET_FRAMES,
    coverage,
    migration,
    summary,
  };
}
