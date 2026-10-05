/**
 * 打包产物的**记录制测量钩子**（ADR 0007 §9 第 ⑤ 层；不进 `pnpm gate`，裁决 P-17）。
 *
 * ## 为什么它在应用里而不是在探针页里
 *
 * G4-S 的首屏数字来自**无打包器**的探针页，其结论 §六 明确要求
 * "**G4/G8 必须在打包产物上复测**"。本模块挂在打包后的真实应用上，
 * 因此测的就是"外壳 + 排程 + 几何 + 首帧 + 依赖线"这一段；
 * 与 `scripts/measure-render.mjs`（零依赖 CDP 驱动）通过 `window.__GANTTPILOT_MEASURE__` 通信。
 *
 * ## 口径（必须与数字一起引用）
 *
 * - **报告值**：`ready → firstFrame` 的一轮实测（`primaryMs`）；
 * - **首帧用双 rAF**（单帧会把布局/绘制时间漏掉）；
 * - **10× 滚动用单帧 rAF 步进**，并分开记"主线程耗时"（判据用它）与
 *   "连续 rAF 的真实帧间隔"——**不能用双 rAF 测帧时长**（会把约 33 ms 的等待算进去，
 *   G4-S 第一版就是这么错的）；
 * - 数据来源 = 合成夹具 + 页面内 `createScheduleCalendar` + `compute`（**不含 xlsx 导入**）；
 * - 环境（浏览器与版本、headed/headless、DPR、视口、档位、数据集、轮数）**与数字一起登记**。
 *
 * ## 只在 `?measure=` 出现时才加载
 *
 * `main.ts` 用 `await import('./measure.js')` 动态引入，因此普通用户的首屏主 chunk **不含**本模块。
 */

import { nextTick } from 'vue';

import { compute } from '@ganttpilot/engine';
import { estimateStorage } from './composables/usePersistence.js';
import {
  buildView,
  CONNECT_SIZE_PX,
  countElements,
  createScheduleCalendar,
  DATASETS,
  diagnoseResizeMigration,
  diagnoseRowAlignment,
  diagnoseScrollCoverage,
  entryConstraintFor,
  handleOffsetsFor,
  PRIMARY_DATASET_KEY,
  REFERENCE_DATASET,
  ROW_BUFFER,
  ROW_HEIGHT,
  scaleGradient,
  summarizeAlignment,
  THRESHOLDS,
  ZOOM_ORDER,
  ZOOM_UNIT_DAYS,
  type FixtureSpec,
  type PointerInput,
  type ProjectDocument,
  type ResizeMigrationVerdict,
  type RowAlignProbe,
  type RowAlignSample,
  type RowAlignVerdict,
  type Schedule,
  type ScrollCoverage,
  type ViewModel,
  type ZoomKey,
} from '@ganttpilot/render-core';

/** 测量结果（CDP 侧原样取走并渲染成证据）。 */
export interface MeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  readonly zoom: ZoomKey;
  readonly rounds: number;
  readonly viewport: { readonly width: number; readonly height: number; readonly rowHeight: number; readonly rowBuffer: number };
  /** 夹具就绪耗时（生成文档 + `compute`；口径里"就绪"的起点）。 */
  readonly prepareMs: number;
  /** 首屏：就绪 → 含依赖线首帧。 */
  readonly firstScreen: {
    readonly primaryMs: number;
    readonly runs: readonly number[];
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly layers: readonly { readonly geometryMs: number; readonly renderMs: number; readonly fromReadyMs: number }[];
    readonly counts: {
      readonly renderedRows: number;
      readonly renderedEdges: number;
      readonly elements: number;
      readonly bound: number;
      readonly c3: number;
      readonly withinBudget: boolean;
    };
    /** 实际 DOM 的计数（与元素模型互证：预算不能是恒真式）。 */
    readonly domCounts: {
      readonly renderedRows: number;
      readonly renderedEdges: number;
      readonly svgElements: number;
    };
  } | null;
  /** 10× 滚动。 */
  readonly scroll: {
    readonly steps: readonly { readonly step: number; readonly scrollTop: number; readonly workMs: number; readonly elements: number; readonly blankRows: number }[];
    readonly totalWallMs: number;
    readonly totalWorkMs: number;
    readonly p50WorkMs: number;
    readonly p95WorkMs: number;
    readonly rafP50Ms: number;
    readonly rafP95Ms: number;
    readonly longTaskCount: number;
    readonly blankRowGaps: number;
  } | null;
  readonly referenceDatasetLinks: number;
  readonly firstScreenBudgetMs: number;
  readonly scrollReferenceMs: number;
  readonly frameBudgetP95Ms: number;
}

/** 测量控制器：由 `App.vue` 注入（它持有文档与"把 ViewModel 画出来"的能力）。 */
export interface MeasureController {
  readonly document: ProjectDocument;
  /**
   * **热路径**：把 `ViewModel` 提交给真实渲染器（返回 Promise，完成时 DOM 已更新）。
   *
   * `awaitFrame = false` 时**只等 DOM 更新**（不等帧）——这样测量方能把
   * "主线程同步工作量"与"帧等待"分开记（不能用双 rAF 测帧时长）。
   */
  readonly applyView: (view: ViewModel, scrollTop: number, awaitFrame?: boolean) => Promise<void>;
}

/** 取数据集规格（`dense` 是主口径；`dense2200` 是《评估报告》§5.4 的同尺对照）。 */
/** 出口条件④的规模：2,000 任务（**依赖密度与主口径同比**，见 `scaleGradient`）。 */
export const STORAGE_METRICS_DATASET_KEY = 'dense-2000';

/** 2,000 任务夹具的规格（首次用到时生成一次并缓存——它要跑一遍 `compute`，不便宜）。 */
let storageMetricsSpec: FixtureSpec | null = null;
function storageMetricsSpecOf(): FixtureSpec {
  storageMetricsSpec ??= scaleGradient(
    DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY) ?? DATASETS[0]!,
    [2000],
  )[0]!.fixture.spec;
  return storageMetricsSpec;
}

export function specOfDataset(key: string): FixtureSpec {
  if (key === STORAGE_METRICS_DATASET_KEY) return storageMetricsSpecOf();
  if (key === REFERENCE_DATASET.key) return REFERENCE_DATASET;
  const match = DATASETS.find((item) => item.key === key);
  if (match !== undefined) return match;
  const primary = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY);
  if (primary === undefined) throw new Error('缺少主口径数据集');
  return primary;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** 双 rAF：第一帧提交 DOM，第二帧才算"画完"。 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** 单帧：只等下一次 rAF（滚动步进用它——用双 rAF 会把自己的等待算进"帧时长"）。 */
function oneFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * 稳定读数的帧预算（**记录制口径的一部分**，证据文件必须一起登记）。
 *
 * 取 12 帧的理由：正常路径 **2 帧**就稳定（见 {@link settleStableRead}），余量留给"一帧做不完"
 * 的大夹具与首帧布局；超过它就不再是抖动，而是"应用没有收敛"。
 */
export const STABLE_READ_BUDGET_FRAMES = 12;

export interface StableReadResult {
  readonly frames: number;
  readonly stable: boolean;
  readonly elapsedMs: number;
}

/**
 * 滚动后**读数的稳定判据**（P-40 批次② 的 ②-β/γ，**全仓唯一实现**）。
 *
 * ## 它取代了什么
 *
 * 此前是"设 `scrollTop` → `nextTick` + **两帧**"（P-23 遗留 6）。那个常量**没有任何判据守着**：
 * rAF 被节流、或应用一帧做不完时，读到的可能是"状态已变、DOM 未变"的中间态 ⇒
 * 判据给出**假红**（把"没画完"读成"没对齐"）或**假绿**（旧值恰好通过），而且**不会报警**。
 *
 * ## 现在的口径
 *
 * 每帧读一次**指纹**（{@link scrollFingerprint}：DOM 真值 + 应用状态 + 行中心 + spacer 尺寸），
 * **连续两帧一致**即认为应用已处理完并返回；到 {@link STABLE_READ_BUDGET_FRAMES} 帧仍不一致 ⇒
 * `stable: false`，调用方必须**判红**（P-12"缺失即失败，不静默跳过"）。
 * 快路径仍是 2 帧 ⇒ 正常运行**没有额外开销**。
 *
 * ## 为什么指纹里要含 `view.scrollTop/scrollLeft`（②-γ 的安全子集）
 *
 * "应用已应用该滚动位置"的最强信号是应用自己的状态，但它**不能单独作为终止条件**——
 * 那会让"应用真的不同步"被读成"还没轮到我"，从而**掩盖**真缺陷（而 `scroll-out-of-sync`
 * 正在断言这件事）。所以它只作为指纹的一部分：既参与"稳没稳"，又不独占判定权。
 */
async function settleStableRead(args: {
  readonly fingerprint: () => string;
  readonly budgetFrames?: number;
}): Promise<StableReadResult> {
  const budget = args.budgetFrames ?? STABLE_READ_BUDGET_FRAMES;
  const started = performance.now();
  let previous: string | null = null;
  for (let frame = 1; frame <= budget; frame += 1) {
    await oneFrame();
    const current = args.fingerprint();
    if (previous !== null && current === previous) {
      return { frames: frame, stable: true, elapsedMs: performance.now() - started };
    }
    previous = current;
  }
  return { frames: budget, stable: false, elapsedMs: performance.now() - started };
}

/**
 * 图表行 `<g>` 的选择器：SVG 是滚动容器的**兄弟**（修后）或子元素（修前/负向对照）——
 * 判据必须能在"坏结构"上照样采到数，否则负向对照无从谈起。
 */
const CHART_ROW_SELECTOR = '.chart-pane-wrap .rows > g[data-task-id], #chart-pane .rows > g[data-task-id]';

/** 指纹里的"应用侧"输入（DOM 真值从 `pane` 与 DOM 直接读）。 */
interface FingerprintExpectation {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly contentWidth: number;
}

/** 稳定性指纹：把"应用状态 + DOM 真值 + 可见几何"压成一个字符串（相等即认为这一帧没有新变化）。 */
function scrollFingerprint(pane: HTMLElement, expected: FingerprintExpectation): string {
  const parts: (number | string)[] = [
    pane.scrollTop,
    pane.scrollLeft,
    expected.scrollTop,
    expected.scrollLeft,
    expected.contentWidth,
    pane.clientWidth,
    pane.clientHeight,
  ];
  // 前 3 行的行中心：滚动/重算会让它整体平移，因此它对"DOM 还没跟上"最敏感。
  for (const row of [...document.querySelectorAll(CHART_ROW_SELECTOR)].slice(0, 3)) {
    const box = boxOf(row);
    parts.push(box === null ? 'x' : Math.round(box.top * 100) / 100);
  }
  const spacer = boxOf(document.querySelector('#chart-pane .chart-spacer'));
  parts.push(spacer === null ? 'x' : Math.round(spacer.width * 100) / 100);
  parts.push(spacer === null ? 'x' : Math.round(spacer.height * 100) / 100);
  return parts.join('|');
}

/** 渲染窗口是否覆盖了全部可见行（缓冲行的唯一作用）。 */
function blankRowsOf(view: ViewModel): number {
  const rendered = new Set(view.rows.map((row) => row.row));
  let blank = 0;
  for (let row = view.firstVisible; row <= view.visibleLast; row += 1) if (!rendered.has(row)) blank += 1;
  return blank;
}

/**
 * 跑一次测量。
 *
 * 注意：一次导航只测**一个档位**——多档同页会让后续档位的"自就绪起"累计前面轮次的时间
 * （G4-S 第一版踩过：周档被报成 183.9 ms、月档 351.6 ms，均为污染值）。
 */
export async function runMeasurement(args: {
  readonly controller: MeasureController;
  readonly fixtureSpec: FixtureSpec;
  readonly zoom: ZoomKey;
  readonly rounds: number;
  readonly scrollSteps: number;
}): Promise<MeasureResult> {
  const errors: string[] = [];
  const pane = document.getElementById('chart-pane');
  const viewport = {
    width: pane?.clientWidth ?? window.innerWidth,
    height: pane?.clientHeight ?? 480,
    rowHeight: ROW_HEIGHT,
    rowBuffer: ROW_BUFFER,
  };

  const base = {
    errors,
    dataset: args.fixtureSpec.key,
    zoom: args.zoom,
    rounds: args.rounds,
    viewport,
    referenceDatasetLinks: REFERENCE_DATASET.links,
    firstScreenBudgetMs: THRESHOLDS.firstScreenMs,
    scrollReferenceMs: THRESHOLDS.scrollReferenceMs,
    frameBudgetP95Ms: THRESHOLDS.frameBudgetP95Ms,
  };

  try {
    // 注意：`document` 这个名字在这里被"项目文档"占用（浏览器全局请写 `window.document`）。
    const projectDocument = args.controller.document;
    const calendar = createScheduleCalendar(projectDocument);
    const tPrepareStart = performance.now();
    const computed = compute(projectDocument, calendar);
    const tReady = performance.now();
    if (!computed.ok) throw new Error(`页面内 compute 失败：${computed.code}`);
    const schedule = computed.schedule;
    const prepareMs = round(tReady - tPrepareStart);
    // 窗格尺寸也要登记：渲染行/边与 `c₃` 都直接由它决定（不是"随便都能对上的"数字）。
    const paneElement = window.document.getElementById('chart-pane');
    viewport.width = paneElement?.clientWidth ?? viewport.width;
    viewport.height = paneElement?.clientHeight ?? viewport.height;

    /** 算几何 → 提交渲染 → 等一帧。返回本轮的计数与耗时分层。 */
    const paintOnce = async (
      scrollTop: number,
    ): Promise<{
      counts: ReturnType<typeof countElements>;
      blankRows: number;
      geometryMs: number;
      renderMs: number;
      workMs: number;
      frameMs: number;
    }> => {
      const t0 = performance.now();
      const view = buildView({
        document: projectDocument,
        schedule,
        calendar,
        viewport: { ...viewport, scrollTop, scrollLeft: 0 },
        zoom: args.zoom,
        clipMode: 'intersect',
      });
      const t1 = performance.now();
      const counts = countElements(view);
      // **不等帧**：`renderMs` 因此是"提交 + DOM 更新"的同步工作量。
      await args.controller.applyView(view, scrollTop, false);
      const t2 = performance.now();
      /**
       * 帧等待在这里，单独计时，**不计入** `workMs`。
       *
       * **为什么主口径不用 {@link settleStableRead}**（P-41 §4 的例外，两个理由）：
       * ① `frameMs` 的**口径定义**就是"提交 + DOM 更新 + **双 rAF 等待**"（"就绪 → 含依赖线首帧"），
       *    换掉它等于改口径、历次首屏数字全不可比；
       * ② 这条路**不把夹具装进应用**：`runMeasurement` 自己 `buildView` 再 `applyView`，
       *    而页面自己的文档仍是演示计划 ⇒ 任何后台重算（`ResizeObserver → measure()`）都会
       *    用"应用自己的视图"覆盖掉刚推上去的视图。**多等帧会把这条已知脆弱的窗口拉宽**
       *    （P-41 落地时当场踩到：`DOM 行/边 = 15/14`（演示计划）vs `模型 = 30/41`）。
       *    这里的一致性由**两路互证**守着（`errors` 非空即 `status: error`），
       *    而它刚刚证明了判别力（P-23 §5 修的就是这条互证曾经失效）。
       */
      await nextFrame();
      const t3 = performance.now();
      return {
        counts,
        blankRows: blankRowsOf(view),
        geometryMs: round(t1 - t0),
        renderMs: round(t2 - t1),
        // **主线程同步工作量**（判据用它）——不含 rAF 等待。
        workMs: round(t2 - t0),
        // 含双 rAF 等待的整轮耗时（记录用，**不是**帧时长）。
        frameMs: round(t3 - t0),
      };
    };

    // -------- 首屏（轮 1 就是"就绪 → 含依赖线首帧"的口径数字）
    const runs: number[] = [];
    const layers: { geometryMs: number; renderMs: number; fromReadyMs: number }[] = [];
    // 注意：`document` 这个名字在 `runMeasurement` 里被项目文档占用，
    // 因此引用浏览器全局时一律写 `window.document`（本文件唯一一处这种坑）。
    const domCounts: { renderedRows: number; renderedEdges: number; svgElements: number } = {
      renderedRows: 0,
      renderedEdges: 0,
      svgElements: 0,
    };
    let counts = {
      renderedRows: 0,
      renderedEdges: 0,
      elements: 0,
      bound: 0,
      c3: 0,
      withinBudget: true,
    };
    for (let roundIndex = 0; roundIndex < args.rounds; roundIndex += 1) {
      const result = await paintOnce(0);
      if (result.blankRows > 0) {
        errors.push(`首屏第 ${String(roundIndex + 1)} 轮出现 ${String(result.blankRows)} 个空白行`);
      }
      // 口径："就绪 → 含依赖线的首帧完成"，因此起点是 `tReady`（`prepareMs` 单独分层记）。
      runs.push(result.frameMs);
      layers.push({ geometryMs: result.geometryMs, renderMs: result.renderMs, fromReadyMs: result.frameMs });
      if (roundIndex === 0) {
        counts = {
          renderedRows: result.counts.renderedRows,
          renderedEdges: result.counts.renderedEdges,
          elements: result.counts.total,
          bound: result.counts.bound,
          c3: result.counts.c3,
          withinBudget: result.counts.withinBudget,
        };
        // 选择器**不锚在 `#chart-pane` 上**：SVG 是滚动容器的**兄弟**（ADR 0007 §14），
        // 锚在窗格内会恒得 0，于是"元素预算两路互证"变成假绿（P-23 落地时当场抓到）。
        const svgAfter = window.document.querySelector('.chart-pane-wrap .gantt-svg, #chart-pane .gantt-svg');
        domCounts.renderedRows = svgAfter?.querySelectorAll('.rows > g').length ?? 0;
        domCounts.renderedEdges = svgAfter?.querySelectorAll('.edges > g').length ?? 0;
        domCounts.svgElements = svgAfter?.querySelectorAll('*').length ?? 0;
        if (!result.counts.withinBudget) {
          errors.push(
            `元素超预算：${String(result.counts.total)} > ${String(result.counts.bound)}（c₁·rows + c₂·edges + c₃）`,
          );
        }
        if (domCounts.renderedRows !== counts.renderedRows || domCounts.renderedEdges !== counts.renderedEdges) {
          errors.push(
            `实际 DOM 与元素模型不一致：DOM 行/边 = ${String(domCounts.renderedRows)}/${String(domCounts.renderedEdges)}，` +
              `模型 = ${String(counts.renderedRows)}/${String(counts.renderedEdges)}`,
          );
        }
      }
    }
    const firstScreen: MeasureResult['firstScreen'] = {
      primaryMs: runs[0] ?? 0,
      runs,
      p50Ms: round(percentile(runs, 0.5)),
      p95Ms: round(percentile(runs, 0.95)),
      layers,
      counts,
      domCounts,
    };

    // -------- 10× 滚动（与《评估报告》§5.4 同尺：连续滚动 10 步）
    const longTasks: number[] = [];
    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: 'longtask', buffered: false });
      } catch {
        observer = null;
      }
    }

    const rafDeltas: number[] = [];
    let rafRunning = true;
    let rafLast = performance.now();
    const rafLoop = (): void => {
      if (!rafRunning) return;
      const now = performance.now();
      rafDeltas.push(now - rafLast);
      rafLast = now;
      requestAnimationFrame(rafLoop);
    };
    requestAnimationFrame(rafLoop);

    const probeView = buildView({
      document: projectDocument,
      schedule,
      calendar,
      viewport: { ...viewport, scrollTop: 0, scrollLeft: 0 },
      zoom: args.zoom,
      clipMode: 'intersect',
    });
    const visibleRows = Math.max(1, Math.ceil(viewport.height / viewport.rowHeight));
    const maxScrollTop = Math.max(0, (probeView.rowCount - visibleRows) * viewport.rowHeight);
    const pixelsPerStep = visibleRows * viewport.rowHeight;
    const steps: {
      step: number;
      scrollTop: number;
      workMs: number;
      elements: number;
      blankRows: number;
    }[] = [];
    let blankRowGaps = 0;
    const wallStart = performance.now();
    for (let step = 1; step <= args.scrollSteps; step += 1) {
      const scrollTop = Math.min(maxScrollTop, step * pixelsPerStep);
      const result = await paintOnce(scrollTop);
      blankRowGaps += result.blankRows;
      steps.push({
        step,
        scrollTop,
        // 判据用**主线程同步工作量**（`workMs`），不含随后那一帧的等待。
        workMs: result.workMs,
        elements: result.counts.total,
        blankRows: result.blankRows,
      });
      await oneFrame();
    }
    const wallMs = performance.now() - wallStart;
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    rafRunning = false;
    observer?.disconnect();

    const workTimes = steps.map((step) => step.workMs);
    const warmDeltas = rafDeltas.slice(1); // 第一个 delta 含"启动采样"的等待
    return {
      // `errors` 非空即 `error`（此前恒 `ok`，于是"DOM 与元素模型不一致"只会安静地写进 raw JSON）。
      status: errors.length === 0 ? 'ok' : 'error',
      ...base,
      prepareMs,
      firstScreen,
      scroll: {
        steps,
        totalWallMs: round(wallMs),
        totalWorkMs: round(workTimes.reduce((acc, value) => acc + value, 0)),
        p50WorkMs: round(percentile(workTimes, 0.5)),
        p95WorkMs: round(percentile(workTimes, 0.95)),
        rafP50Ms: round(percentile(warmDeltas, 0.5)),
        rafP95Ms: round(percentile(warmDeltas, 0.95)),
        longTaskCount: longTasks.length,
        blankRowGaps,
      },
    };
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return { status: 'error', ...base, prepareMs: 0, firstScreen: null, scroll: null };
  }
}

/**
 * 在 `window` 上暴露测量入口；CDP 侧用 `Runtime.evaluate` 直接 `await` 它。
 *
 * `buildFixtureDocument` 由调用方给出（通常是"生成演示夹具"的同一个函数），
 * 因此测量用的文档形状与演示**完全一致**（同一份 `render-core/fixtures`）。
 */
export function exposeMeasurement(args: {
  readonly buildFixtureDocument: (key: string) => ProjectDocument;
  readonly controllerOf: (document: ProjectDocument) => MeasureController;
  readonly loadDocument: (document: ProjectDocument) => Promise<void>;
  /** G5：拖动测量所需的实时状态与控制入口（不传则 `__GANTTPILOT_MEASURE_DRAG__` 不存在）。 */
  readonly drag?: DragMeasurementHost;
  /** G5 批次 D：两栏行对齐所需的只读入口（不传则 `__GANTTPILOT_MEASURE_ALIGN__` 不存在）。 */
  readonly align?: AlignMeasurementHost;
  /** G6：持久化所需的只读入口（不传则 `__GANTTPILOT_MEASURE_PERSIST__` 不存在）。 */
  readonly persist?: PersistenceMeasurementHost;
}): void {
  const host = window as unknown as {
    __GANTTPILOT_MEASURE__?: unknown;
    __GANTTPILOT_MEASURE_DRAG__?: unknown;
    __GANTTPILOT_MEASURE_ALIGN__?: unknown;
    __GANTTPILOT_MEASURE_PERSIST__?: unknown;
  };
  host.__GANTTPILOT_MEASURE__ = async (options: {
    readonly dataset?: string;
    readonly zoom?: string;
    readonly rounds?: number;
    readonly scrollSteps?: number;
  }): Promise<MeasureResult> => {
    const spec = specOfDataset(options.dataset ?? PRIMARY_DATASET_KEY);
    const requested = (options.zoom ?? 'day') as ZoomKey;
    const zoom: ZoomKey = ZOOM_ORDER.includes(requested) ? requested : 'day';
    const document = args.buildFixtureDocument(spec.key);
    // 先把夹具装进应用（否则测量跑在一个与视口无关的文档上）。
    await args.loadDocument(document);
    return runMeasurement({
      controller: args.controllerOf(document),
      fixtureSpec: spec,
      zoom,
      rounds:
        Number.isFinite(options.rounds) && (options.rounds ?? 0) > 0
          ? Math.min(50, Math.floor(options.rounds ?? 5))
          : 5,
      scrollSteps:
        Number.isFinite(options.scrollSteps) && (options.scrollSteps ?? 0) > 0
          ? Math.min(50, Math.floor(options.scrollSteps ?? 10))
          : 10,
    });
  };

  if (args.drag !== undefined) {
    const dragHost = args.drag;
    host.__GANTTPILOT_MEASURE_DRAG__ = async (options: {
      readonly dataset?: string;
      readonly dayDelta?: number;
      readonly frames?: number;
      readonly scrollTop?: number;
      readonly scrollLeft?: number;
      /** 采样的语义（P-45；缺省 = `move`）。 */
      readonly mode?: string;
    }): Promise<DragMeasureResult> => {
      const spec = specOfDataset(options.dataset ?? PRIMARY_DATASET_KEY);
      const document = args.buildFixtureDocument(spec.key);
      await args.loadDocument(document);
      return runDragMeasurement({
        host: dragHost,
        fixtureSpec: spec,
        mode: options.mode === 'resize-duration' ? 'resize-duration' : 'move',
        dayDelta: Number.isFinite(options.dayDelta) ? Math.trunc(options.dayDelta ?? 3) : 3,
        frames:
          Number.isFinite(options.frames) && (options.frames ?? 0) > 2
            ? Math.min(120, Math.floor(options.frames ?? 12))
            : 12,
        scrollTop: Number.isFinite(options.scrollTop) ? Math.max(0, Math.trunc(options.scrollTop ?? 0)) : 0,
        scrollLeft: Number.isFinite(options.scrollLeft) ? Math.max(0, Math.trunc(options.scrollLeft ?? 0)) : 0,
      });
    };
  }

  if (args.align !== undefined) {
    const alignHost = args.align;
    host.__GANTTPILOT_MEASURE_ALIGN__ = async (options: {
      readonly dataset?: string;
      /** 档位（`day`/`week`/`month`）：走**用户点工具栏的同一个** `setZoom`。 */
      readonly zoom?: string;
      /** `positions`（默认）= 重载夹具 + 逐位置设滚动；`reread` = 不重载、不设滚动（resize 迁移第二步）。 */
      readonly mode?: 'positions' | 'reread';
      /** 绝对像素位置（诊断用）。 */
      readonly positions?: readonly { readonly top: number; readonly left: number }[];
      /** 比例位置（`0..1`；按真实可滚动行程解析）。 */
      readonly fractions?: readonly { readonly top: number; readonly left: number }[];
      /** "前一次"窗格尺寸 ⇒ 判 resize 迁移的前提自证。 */
      readonly previousPane?: { readonly width: number; readonly height: number } | null;
      /** 采完**不复位滚动**（迁移轮必须：复位会抹掉"resize 前的滚动位置"）。 */
      readonly keepScroll?: boolean;
      /** `reread` 下"应该还在"的滚动位置（位置存活性判读）。 */
      readonly expectedScroll?: { readonly top: number; readonly left: number } | null;
    }): Promise<AlignMeasureResult> => {
      const requested = Array.isArray(options.positions) ? options.positions : [];
      const fractionSpecs = Array.isArray(options.fractions) ? options.fractions : [];
      const absolute =
        requested.length > 0
          ? requested.map((item) => ({
              top: Math.max(0, Math.trunc(Number(item.top) || 0)),
              left: Math.max(0, Math.trunc(Number(item.left) || 0)),
            }))
          : undefined;
      const fractions =
        fractionSpecs.length > 0
          ? fractionSpecs.map((item) => ({
              top: Math.min(1, Math.max(0, Number(item.top) || 0)),
              left: Math.min(1, Math.max(0, Number(item.left) || 0)),
            }))
          : undefined;
      const mode = options.mode === 'reread' ? 'reread' : 'positions';
      let dataset = options.dataset ?? PRIMARY_DATASET_KEY;

      if (mode === 'positions') {
        const spec = specOfDataset(dataset);
        dataset = spec.key;
        const document = args.buildFixtureDocument(spec.key);
        await args.loadDocument(document);
        // 档位：**没有静默回退**——请求了档位却没有接线就显式失败（否则会安静地用日档，判据变成假的）。
        const zoom = options.zoom;
        if (typeof zoom === 'string' && zoom !== '') {
          if (!(ZOOM_ORDER as readonly string[]).includes(zoom)) {
            throw new Error(`未知档位：${zoom}（可用：${ZOOM_ORDER.join(' / ')}）`);
          }
          if (alignHost.setZoom === undefined) {
            throw new Error('对齐宿主没有 setZoom（App.vue 未接线）：无法切档位，拒绝静默用日档');
          }
          alignHost.setZoom(zoom as ZoomKey);
          await nextTick();
        }
      }

      return runAlignMeasurement({
        host: alignHost,
        dataset,
        mode,
        previousPane: options.previousPane ?? null,
        keepScroll: options.keepScroll === true,
        expectedScroll: options.expectedScroll ?? null,
        // `exactOptionalPropertyTypes`：只有真的给了才带这个键（`undefined` 不等于"没给"）。
        ...(absolute === undefined ? {} : { positions: absolute }),
        ...(fractions === undefined ? {} : { fractions }),
      });
    };
  }

  if (args.persist !== undefined) {
    const persistHost = args.persist;
    host.__GANTTPILOT_MEASURE_PERSIST__ = async (options: {
      readonly dataset?: string;
      readonly dayDelta?: number;
      readonly frames?: number;
      readonly samples?: number;
      /** 存储模式用它跳过拖动（拖动只服务出口条件①）。 */
      readonly skipDrag?: boolean;
    }): Promise<PersistMeasureResult> => {
      const spec = specOfDataset(options.dataset ?? PRIMARY_DATASET_KEY);
      // **必须**把夹具装进应用：页面的初始文档是**演示口径**的小型计划（`demoPlan.ts`，裁决 P-34），
      // 与测量口径无关；而 `dense-2000`（2,000 任务）只在 `specOfDataset` 里认识 ⇒
      // 不装的话规模会**静默用错**（实测踩到过：存储测量落到 1,000 任务）。
      await args.loadDocument(args.buildFixtureDocument(spec.key));
      // 注意：`loadDocument` 走 `project.reset()`（换掉整份会话）——这里**正要**它这么做：
      // 存储测量要的是"干净起点 + 明确的规模"，因此先把夹具装进去、再清库、再落盘。
      // （曾经的缺陷是"在拖动/编辑之后又 reset 会话"，那会把刚写下去的东西丢掉。）
      return runPersistMeasurement({
        host: persistHost,
        fixtureSpec: spec,
        dayDelta: Number.isFinite(options.dayDelta) ? Math.trunc(options.dayDelta ?? 3) : 3,
        frames:
          Number.isFinite(options.frames) && (options.frames ?? 0) > 2
            ? Math.min(120, Math.floor(options.frames ?? 12))
            : 12,
        samples:
          Number.isFinite(options.samples) && (options.samples ?? 0) > 0
            ? Math.min(20, Math.floor(options.samples ?? 3))
            : 3,
        skipDrag: options.skipDrag === true,
      });
    };
  }
}
// ---------------------------------------------------------------- G5：拖动测量（记录制，ADR 0008 §11）

/**
 * `resize-duration` 轮的抓取点：条右端**内** 4 px（裁决 P-45）。
 *
 * 为什么是 4 而不是 2：右端那一带有**两个**判定面，抓在哪一侧是两件事——
 *
 * | 面 | 区间（内容坐标） | 谁赢 |
 * |---|---|---|
 * | 连接点（建线） | `[xRight − CONNECT_INSET_PX, …]` = **`[xRight − 2, …]`** | **优先**（ADR 0008 §16.3） |
 * | 端点判定区（改工期） | `[xRight − edgePx, xRight]` = `[xRight − 6, xRight]`（宽条） | 次之 |
 *
 * ⇒ 真正能起"改工期"的窗口是 `[xRight − 6, xRight − 2)`，取其中点 **4**。
 * 取 2 会落进连接点、起的是**建线**手势（本轮实测：`按下后未进入拖动（实际 linking）`）——
 * 所以判据另外用 `gestureMode` 自证真的判成了 `resize-duration`。
 *
 * 而"最后一个工作日格的中点"（= `move` 轮的抓法）离条右端有半个格子（日档 12 px），
 * 落在 `move` 判定区里 ⇒ 量到的会是整体移动。
 */
const RESIZE_GRAB_INSET_PX = 4;

/** 拖动测量的宿主：由 `App.vue` 提供的实时状态与真实指针入口。 */
export interface DragMeasurementHost {
  /** 当前渲染的视图模型（含 `scrollTop` / `pxPerDay` / 行序），用于把任务换算成屏幕坐标。 */
  readonly view: () => ViewModel | null;
  /** 文档与排程（挑选目标行：位移判据要求该行**无有效入边约束**，否则 `snap` 会夹住候选）。 */
  readonly document: () => ProjectDocument;
  readonly schedule: () => Schedule | null;
  readonly calendar: () => { dayOfOrdinal(ordinal: number): number; isoOfOrdinal(ordinal: number): string | undefined };  /** 真实指针入口（**与用户操作走同一条路径**）。 */
  readonly pointer: {
    readonly down: (event: MouseEvent) => void;
    readonly move: (event: MouseEvent) => void;
    readonly up: (event: MouseEvent) => void;
  };
  /** 拖动是否仍在进行（用于断言"松手后锚点已清空"）。 */
  readonly gestureKind: () => string;
  /**
   * 建线入口的判定（ADR 0008 §16.3／裁决 P-32）：走**与用户操作同一条路**的 `linkEntryFor`。
   *
   * 记录制用它核对"连接点真的能起建线、端点手柄真的不能"——这两条都是**入口层**的性质，
   * 而入口层此前没有判据（P-19/P-21 的同一教训）。纯函数的判据在 `interaction.spec.ts`（进门禁）。
   */
  readonly entryPointOf?: (clientX: number, clientY: number) => { readonly taskId: string; readonly exitSide: 'left' | 'right' } | null;
  /** 光标提示的分类（记录制核对"端点/中部/连接点"给出三种不同光标）。 */
  readonly cursorAt?: (clientX: number, clientY: number) => string;
  /**
   * 把"指针在某屏幕点"这件事交给应用（= 触发连接点的显形判定）。
   *
   * 连接点**只在指针靠近该行条端时**发射（P-32 复验第 3.2 条），因此记录制必须先
   * "把指针放到那里"，再读 DOM 上的条数——否则量到的是 0（**假红**）。
   */
  readonly hoverAt?: (clientX: number, clientY: number) => void;
  /** 指针离开（收尾复位）。 */
  readonly clearHover?: () => void;
  readonly anchors: () => number;
  /** 松手后落到文档里的 `startDate`（断言"命令真的落库了"）。 */
  readonly startDateOf: (taskId: string) => string | null;
  /**
   * 松手后落到文档里的**工期**（P-45：`resize-duration` 的位移判据是工期，不是 `startDate`）。
   */
  readonly durationOf: (taskId: string) => number | null;
  /**
   * 会话的**已提交修订号**（P-45 的"预览不落库"判据：拖动期它必须**一字不动**）。
   *
   * 它只随命令/事务前进（ADR 0003），因此"预览副本进 `compute`"与"文档被改"是两件
   * 可区分的事——判据要的正是这个区分，而不是"看起来没变"。
   */
  readonly revision: () => number;
  /**
   * 手势内核**当前把这一帧判成了什么语义**（`move` / `resize-start` / `resize-duration`；非拖动为 `null`）。
   *
   * 记录制必须能自证"真的抓在右端"：否则"拖了但抓成了中部"会让 P-45 的采样
   * 悄悄退化成整体移动（那种绿是**恒真式**）。
   */
  readonly gestureMode: () => string | null;
}

/** 拖动测量的结果（记录制：帧预算与松手耗时都不进 `pnpm gate`）。 */
export interface DragMeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  readonly taskId: string;
  readonly dayDelta: number;
  readonly frames: number;
  /** 拖动期每个测试帧的"主线程同步工作量"（只含事件派发 + Vue 更新，不含帧等待）。 */
  readonly mainThreadMs: readonly number[];
  readonly mainThreadP50Ms: number;
  readonly mainThreadP95Ms: number;
  /** 拖动期连续 rAF 的帧间隔（记录用；目标 ≥30 fps ⇒ ≤33.3 ms）。 */
  readonly frameGapsMs: readonly number[];
  readonly frameGapP50Ms: number;
  readonly frameGapP95Ms: number;
  readonly longTasks: number;
  /** 松手 → 命令落库 + 重算 + 冲突标记完成 的墙钟。 */
  readonly releaseMs: number;
  /** 拖动中是否观察到 DOM 上的条形位置变化（"下游跟随"的间接证据）。 */
  readonly observedGeometryChanges: number;
  readonly anchorsAfterRelease: number;
  readonly documentStartAfter: string | null;
  /** 拖动前该行的开始序号（**绝对基准**：位移按它 + `dayDelta` 断言）。 */
  readonly anchorOrdinal: number | null;
  /** 本轮的滚动位置（P-25：滚动状态下的拖动必须与未滚动时同样成立）。 */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** 期望的松手后 `startDate`（= `isoOfOrdinal(anchorOrdinal + dayDelta)`）。 */
  readonly expectedStartAfter: string | null;
  /** 本轮采样的语义：`move`（整体移动）或 `resize-duration`（改工期；P-45 的探针）。 */
  readonly mode: 'move' | 'resize-duration';
  /** 内核判定的语义（自证"抓对了地方"；`null` = 按下后没进拖动）。 */
  readonly gestureMode: string | null;
  /** 拖动前的工期（`resize-duration` 的位移基准）。 */
  readonly durationBefore: number | null;
  readonly durationAfter: number | null;
  /** 期望的松手后工期（= `durationBefore + dayDelta`）。 */
  readonly expectedDurationAfter: number | null;
  /** 拖动前 / 拖动期 / 松手后的**已提交修订号**（P-45：拖动期必须相等）。 */
  readonly revisionBefore: number;
  readonly revisionDuringDrag: number;
  readonly revisionAfterRelease: number;
  /**
   * **下游跟随的正面判据**（P-45，只在 `resize-duration` 轮有值）。
   *
   * 取一条**真正由被拖任务的有效完成日决定**的后继边（FS/FF/SF，且该边是它的**紧约束**），
   * 记录它的开始序号在三个时刻的值：拖动前 / 拖动期（预览副本生效）/ 松手后（落库）。
   * 判据 = `during === after`（预览 == 提交）**且** `after !== before`
   *   （后者是**前提自证**：这条边真的会跟着动，否则"相等"是恒真式）。
   */
  readonly downstream: {
    readonly taskId: string;
    readonly linkType: string;
    readonly before: number;
    readonly during: number;
    readonly after: number;
  } | null;
  /** 批次 B 的记录制采样：手柄可见性、连接点起手、光标分类（ADR 0008 §16.2/§16.3）。 */
  readonly handles: {
    /** 渲染行组数（`data-task-id` 的 `<g>`）。 */
    readonly rowGroups: number;
    /** DOM 上手柄的条数（`line.handle`）。 */
    readonly domHandles: number;
    /**
     * DOM 上连接点的条数（`.connect-point`，**不限定标签**：批次③起它是 `<circle>`）。
     *
     * **只对"指针所在的那一行"计数**（连接点按需显形，P-32 复验第 3.2 条），
     * 因此判据是 `= 2`（该行的左右两点）而不是"等于全部渲染行的 2×n"。
     */
    readonly domConnectPoints: number;
    /** 模型侧应当发射的手柄条数（`handleOffsetsFor` 的合计）。 */
    readonly modelHandles: number;
    /** 模型侧应当发射的连接点条数（**全部渲染行** × 2；与 DOM 的口径差在"按需显形"）。 */
    readonly modelConnectPoints: number;
    /** 按下"条体中部"时的光标（期望 `move`）。 */
    readonly cursorOnBar: string;
    /** 按下"端点手柄"处的光标（期望 `col-resize`）。 */
    readonly cursorOnEdge: string;
    /** 按下"连接点"处的光标（期望 `crosshair`）。 */
    readonly cursorOnConnect: string;
    /** 从连接点按下是否真的进入 `linking`（**R4 的可判定形式**）。 */
    readonly connectDownEntersLinking: boolean;
    /** 采样到的连接点**左缘**（内容坐标；`null` = 该行没发射连接点）。 */
    readonly connectLeftEdge: number | null;
    /** 连接点的 DOM 标签（P-42 批次③：必须是 `circle`）。 */
    readonly connectTag: string;
    /** 连接点可见盒的宽 × 高（px；圆的外接盒必须**是正方形**）。 */
    readonly connectBox: { readonly width: number; readonly height: number } | null;
  } | null;
}
/**
 * 把任务换算成屏幕坐标（内容坐标 + 窗格偏移）。
 *
 * **必须传 `anchorOrdinal`（拖动前的开始序号），不能用当前视图里的 `row.es`**：
 * 拖动期视图带着**会话锚点**重算，`row.es` 会跟着候选走，用它当基准会让
 * "每帧按当前位置再前进一段"累积成加速拖动——那样"拖 3 个工作日"就不成立了。
 * 抓取点是第一个工作日格的**中点**（`+ pxPerDay / 2`），其序号恰好是 `anchorOrdinal`。
 */
function dragScreenPoint(
  host: DragMeasurementHost,
  pane: HTMLElement,
  taskId: string,
  anchorOrdinal: number,
  ordinalOffset: number,
): { readonly clientX: number; readonly clientY: number } | null {
  const view = host.view();
  if (view === null) return null;
  const row = view.rows.find((item) => item.id === taskId);
  if (row === undefined) return null;
  const calendar = host.calendar();
  const targetDay = calendar.dayOfOrdinal(anchorOrdinal + ordinalOffset);  const contentX = (targetDay - view.axisOriginDay) * view.pxPerDay + view.pxPerDay / 2;
  const contentY = row.row * view.rowHeight + view.rowHeight / 2;
  const rect = pane.getBoundingClientRect();
  return {
    clientX: rect.left + contentX - view.scrollLeft,
    clientY: rect.top + contentY - view.scrollTop,
  };
}

/**
 * 跑一次拖动测量（G5 出口条件 ① ②，**记录制**）。
 *
 * 口径（必须与数字一起引用）：
 * - 用**真实指针事件**驱动（`mousedown → mousemove×N → mouseup`），与用户路径一致；
 * - **主线程工作量** = 派发事件 + `await nextTick()`（不含帧等待）——与 G4 的滚动口径同源；
 * - **帧间隔**用连续 rAF 记录，只作记录（≥30 fps ⇒ p95 ≤ 33.3 ms）；
 * - **松手耗时** = `mouseup` → 命令落库 + `compute` + 覆盖层清空 的墙钟；
 * - **位移判据（P-22 补上）**：松手后的文档 `startDate` 必须等于「拖动前的开始序号 + `dayDelta`
 *   个工作日」。旧证据只断言"非空"，因此"拖了但没有效位移"也会算通过（该恒真式已删除）。
 * - **`mode = 'resize-duration'`**（P-45 的探针）：抓**条右端**改工期，位移判据换成
 *   "松手后的 `durationDays` = 拖动前工期 + `dayDelta`"，并额外采**下游跟随**与**预览不落库**
 *   两条这个模式独有的判据（见 {@link DragMeasureResult.downstream}）。
 */export async function runDragMeasurement(args: {
  readonly host: DragMeasurementHost;
  readonly fixtureSpec: FixtureSpec;
  readonly dayDelta: number;
  readonly frames: number;
  /** 先把窗格滚到这里再拖（P-25：R13/R14 都**只在滚动后**现形）。 */
  readonly scrollTop?: number;
  readonly scrollLeft?: number;
  /** 采样的语义（默认整体移动；`resize-duration` 是 P-45 的探针）。 */
  readonly mode?: 'move' | 'resize-duration';
}): Promise<DragMeasureResult> {
  const mode = args.mode ?? 'move';
  const errors: string[] = [];
  const pane = document.getElementById('chart-pane');
  if (pane === null) {
    return emptyDragResult(args, ['找不到图表窗格（#chart-pane）']);
  }

  // 滚动到指定位置：**等读数稳定**（P-40 批次②；旧口径是写死的"两帧"）。
  // 不等就会在"状态已变、DOM 未变"的中间态上挑目标行与换算坐标——那样判据测的是别的东西；
  // 不稳定则直接判红，不静默用一个中间态的数字（P-12"缺失即失败"）。
  pane.scrollTop = args.scrollTop ?? 0;
  pane.scrollLeft = args.scrollLeft ?? 0;
  await nextTick();
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
    return emptyDragResult(args, [
      `滚动到 (${String(args.scrollTop ?? 0)}, ${String(args.scrollLeft ?? 0)}) 后读数在 ` +
        `${String(STABLE_READ_BUDGET_FRAMES)} 帧内未稳定（应用未在预算内处理完滚动）`,
    ]);
  }

  /**
   * 目标行：两种语义的过滤条件**不同**（这也是为什么它不是一个函数）。
   *
   * - `move`：必须**无有效入边约束**——`snap` 会把候选夹到约束之下，否则"拖 N 天"这条
   *   位移判据对有前置的行**必然**报错（P-25 踩过：判据选错了样本，不是应用错了）；
   * - `resize-duration`：约束不影响它（该模式的候选不做吸附），但必须有一条**由它的完成日决定**
   *   的后继边——否则"下游跟随"没有可判定的载体。
   */
  const picked = mode === 'move' ? pickDragTarget(args.host) : pickResizeTarget(args.host);
  if (picked === null) {
    return emptyDragResult(args, [
      mode === 'move' ? '渲染窗口内没有可拖动的叶子任务' : '渲染窗口内没有"带有效后继边的叶子任务"（下游跟随判据的载体）',
    ]);
  }
  const target = picked;

  // **绝对基准**：拖动前该行的开始序号（拖动期视图会带着锚点重算，不能事后取）。
  const rowBefore = args.host.view()?.rows.find((item) => item.id === target.taskId) ?? null;
  const anchorOrdinal = rowBefore?.es ?? null;
  if (anchorOrdinal === null) {
    return emptyDragResult(args, ['无法取到目标任务在拖动前的开始序号（位移判据需要它作基准）']);
  }

  const durationBefore = args.host.durationOf(target.taskId);
  /**
   * 指针的序号基准：
   * - `move`：开始序号本身（抓的是第一个工作日格的中点）；
   * - `resize-duration`：**最后一个工作日**的序号 `origin + D − 1`（抓的是条右端）。
   */
  const pointerBaseOrdinal = mode === 'move' ? anchorOrdinal : anchorOrdinal + Math.max(1, durationBefore ?? 1) - 1;

  /**
   * 按下点：`move` 取第一个工作日格的中点；`resize-duration` 取**条右端内 2 px**
   * （必须落在 `edgeR = [xRight − edgePx, xRight]` 里——宽条 `edgePx = 6`）。
   * 右端由**视图自己的** `xRight` 给，不在这里重算几何。
   */
  const start =
    mode === 'move'
      ? dragScreenPoint(args.host, pane, target.taskId, pointerBaseOrdinal, 0)
      : rowBefore === null
        ? null
        : contentPointToScreen(pane, args.host, rowBefore.xRight - RESIZE_GRAB_INSET_PX, rowBefore.y);
  if (start === null) {
    return emptyDragResult(args, ['无法把目标任务换算成屏幕坐标']);
  }
  const dispatch = (type: 'down' | 'move' | 'up', point: { clientX: number; clientY: number }): void => {
    const event = new MouseEvent(type === 'down' ? 'mousedown' : type === 'move' ? 'mousemove' : 'mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
      buttons: type === 'up' ? 0 : 1,
      view: window,
    });
    if (type === 'down') args.host.pointer.down(event);
    else if (type === 'move') args.host.pointer.move(event);
    else args.host.pointer.up(event);
  };

  const mainThreadMs: number[] = [];
  const frameGapsMs: number[] = [];
  let observedGeometryChanges = 0;
  let previousGeometry = collectBarGeometry();

  const revisionBefore = args.host.revision();
  dispatch('down', start);
  await nextTick();
  const gestureModeOnDown = args.host.gestureMode();
  if (args.host.gestureKind() !== 'dragging') {
    errors.push(`按下后未进入拖动（实际 ${args.host.gestureKind()}）`);
  }
  /**
   * **自证抓对了地方**：`resize-duration` 轮里按下点必须真的被判成"改工期"。
   * 否则探针会悄悄退化成整体移动，而"下游跟随"在这种退化下**换个理由**也能成立——那样的绿是恒真式。
   */
  if (mode === 'resize-duration' && gestureModeOnDown !== 'resize-duration') {
    errors.push(`按下点未判成 resize-duration（实际 ${String(gestureModeOnDown)}）——条右端的抓取点没落在 edgeR 里`);
  }
  if (mode === 'move' && gestureModeOnDown !== 'move') {
    errors.push(`按下点未判成 move（实际 ${String(gestureModeOnDown)}）`);
  }

  let lastFrameAt = performance.now();
  const frames = args.frames;
  for (let index = 1; index <= frames; index += 1) {
    const offset = Math.round((args.dayDelta * index) / frames);
    const point = dragScreenPoint(args.host, pane, target.taskId, pointerBaseOrdinal, offset) ?? start;    const started = performance.now();
    dispatch('move', point);
    await nextTick();
    mainThreadMs.push(round(performance.now() - started));

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const now = performance.now();
        frameGapsMs.push(round(now - lastFrameAt));
        lastFrameAt = now;
        resolve();
      });
    });

    // "下游跟随"的间接证据：拖动期条形的几何（x/y/宽/高/点列）变化过（而不是只有覆盖层在动）。
    const geometry = collectBarGeometry();
    if (geometry !== previousGeometry) observedGeometryChanges += 1;
    previousGeometry = geometry;
  }

  /**
   * **拖动期最后一眼**（P-45）：两条判据都在"命令落地之前"取——
   * ① 已提交修订号（预览副本**不得**让它前进）；② 后继行的开始序号（它**应当**已经跟着预览走了）。
   */
  const revisionDuringDrag = args.host.revision();
  const downstreamDuring = target.successorId === undefined ? null : esOf(args.host, target.successorId);

  const releaseStart = performance.now();
  const endPoint = dragScreenPoint(args.host, pane, target.taskId, pointerBaseOrdinal, args.dayDelta) ?? start;  dispatch('up', endPoint);
  await nextTick();
  const releaseMs = round(performance.now() - releaseStart);
  const revisionAfterRelease = args.host.revision();

  // **位移判据**（P-22 补上）：`move` 看开始日、`resize-duration` 看工期。
  // 旧证据只断言"非空"，于是 `2026-10-05`（与拖前相同的项目起点）也被算作通过 —— 那是恒真式。
  const documentStartAfter = args.host.startDateOf(target.taskId);
  const durationAfter = args.host.durationOf(target.taskId);
  const expectedDurationAfter = durationBefore === null ? null : durationBefore + args.dayDelta;
  const expectedStartAfter = args.host.calendar().isoOfOrdinal(anchorOrdinal + args.dayDelta) ?? null;
  if (mode === 'move') {
    if (documentStartAfter !== expectedStartAfter) {
      errors.push(
        `拖动位移与文档不符：startDate = ${String(documentStartAfter)}，期望 ${String(expectedStartAfter)}` +
          `（拖动前开始序号 ${String(anchorOrdinal)} + ${String(args.dayDelta)} 个工作日）`,
      );
    }
  } else if (durationAfter !== expectedDurationAfter) {
    errors.push(
      `改工期的位移与文档不符：durationDays = ${String(durationAfter)}，期望 ${String(expectedDurationAfter)}` +
        `（拖动前工期 ${String(durationBefore)} + ${String(args.dayDelta)} 个工作日）`,
    );
  }

  /**
   * **P-45 的两条判据**（只在 `resize-duration` 轮）。
   *
   * ① **预览不落库**：拖动期已提交修订号必须与拖动前**逐位相等**——预览副本只进 `compute`，
   *    落库仍然只有"松手 → `task.update` 经命令层"这一条路（ADR 0003）；
   * ② **下游所见即所提交**：后继行的开始序号在"拖动期（预览生效）"与"松手后（已落库）"必须相等，
   *    且**与拖动前不同**（前提自证：这条边真的会跟着动；否则相等是恒真式）。
   */
  const downstream =
    target.successorId === undefined
      ? null
      : {
          taskId: target.successorId,
          linkType: target.linkType ?? '',
          before: target.successorEsBefore ?? -1,
          during: downstreamDuring ?? -1,
          after: esOf(args.host, target.successorId) ?? -1,
        };
  if (mode === 'resize-duration') {
    if (revisionDuringDrag !== revisionBefore) {
      errors.push(
        `拖动期文档被写了：revision ${String(revisionBefore)} → ${String(revisionDuringDrag)}（预览副本必须**不落库**）`,
      );
    }
    if (revisionAfterRelease === revisionBefore) {
      errors.push(`松手后 revision 未前进（${String(revisionAfterRelease)}）——命令没有落库`);
    }
    if (downstream === null) {
      errors.push('没有采到下游后继行（判据没有载体）');
    } else if (downstream.before === downstream.after) {
      errors.push(
        `下游跟随的前提不成立：后继 \`${downstream.taskId}\` 在拖动前后开始序号都是 ${String(downstream.after)}` +
          `（这条 ${downstream.linkType} 边不是它的紧约束 ⇒ 该样本判不了"预览 == 提交"）`,
      );
    } else if (downstream.during !== downstream.after) {
      errors.push(
        `下游未跟随预览：后继 \`${downstream.taskId}\` 拖动期 es = ${String(downstream.during)}，` +
          `松手后 = ${String(downstream.after)}（拖动期的下游仍按文档里的**旧工期**算）`,
      );
    }
  }

  let longTasks = 0;  if (typeof PerformanceObserver !== 'undefined') {
    // 记录制：只统计拖动期间已经产生的 longtask 条目（观察者本身不阻塞）。
    try {
      const entries = performance.getEntriesByType('longtask');
      longTasks = entries.length;
    } catch {
      longTasks = 0;
    }
  }

  // -------- 批次 B 的记录制采样（ADR 0008 §16.2/§16.3／裁决 P-32）
  // 这几条都属**入口层**性质（手柄是否在、光标是否分三类、连接点是否真的起建线）：
  // 纯函数判据在 `interaction.spec.ts`（进门禁），这里只采"打包产物上的真实 DOM"。
  const handles = await collectHandleSample(args.host, target.taskId);
  if (handles !== null) {
    if (handles.domHandles !== handles.modelHandles) {
      errors.push(`手柄条数与模型不符：DOM ${String(handles.domHandles)} vs 模型 ${String(handles.modelHandles)}`);
    }
    // 连接点按需显形：指针在目标行的条端上时，DOM 上应当只有**那一个行组**的两点。
    if (handles.domConnectPoints !== 2) {
      errors.push(
        `连接点未按需显形：指针在条端时该行应有 2 个（左右各一），实际 ${String(handles.domConnectPoints)}`,
      );
    }
    if (handles.cursorOnBar !== 'move') {
      errors.push(`条体中部按下点的光标应为 move，实际 ${handles.cursorOnBar}`);
    }
    if (handles.cursorOnEdge !== 'col-resize') {
      errors.push(`端点手柄处按下点的光标应为 col-resize，实际 ${handles.cursorOnEdge}`);
    }
    if (handles.cursorOnConnect !== 'crosshair') {
      errors.push(`连接点处按下点的光标应为 crosshair，实际 ${handles.cursorOnConnect}`);
    }
    if (!handles.connectDownEntersLinking) {
      errors.push('从连接点按下未进入建线手势（linking）——R4 的修法未生效');
    }
    /**
     * P-42 批次③ 的**形状口径**（连接点从"与条体等高的正方形白框"改成"圆圈，直径略小于条高"）：
     * 纯函数侧守"直径 ≤ 命中盒边长 ≤ …"（`interaction.spec.ts`），这里守"DOM 真的画成了圆"。
     */
    if (handles.connectTag !== 'circle') {
      errors.push(`连接点应为 \`circle\`（P-42 批次③的圆点口径），实际 \`${handles.connectTag || '(缺)'}\``);
    }
    if (handles.connectBox !== null && Math.abs(handles.connectBox.width - handles.connectBox.height) > 0.5) {
      errors.push(
        `连接点的可见盒必须是**正方形**（圆的外接盒），实际 ${String(handles.connectBox.width)}×${String(handles.connectBox.height)}`,
      );
    }
    if (handles.connectBox !== null && handles.connectBox.width > CONNECT_SIZE_PX + 0.5) {
      errors.push(
        `连接点的可见直径 ${String(handles.connectBox.width)} 超过命中盒边长 ${String(CONNECT_SIZE_PX)}（可见 ⊆ 命中盒）`,
      );
    }
  }
  return {
    status: errors.length === 0 ? 'ok' : 'error',
    errors,
    dataset: args.fixtureSpec.key,
    taskId: target.taskId,
    dayDelta: args.dayDelta,
    frames,
    mainThreadMs,
    mainThreadP50Ms: percentile(mainThreadMs, 0.5),
    mainThreadP95Ms: percentile(mainThreadMs, 0.95),
    frameGapsMs,
    frameGapP50Ms: percentile(frameGapsMs, 0.5),
    frameGapP95Ms: percentile(frameGapsMs, 0.95),
    longTasks,
    releaseMs,
    observedGeometryChanges,
    anchorsAfterRelease: args.host.anchors(),
    documentStartAfter,
    anchorOrdinal,
    expectedStartAfter,
    mode,
    gestureMode: gestureModeOnDown,
    durationBefore,
    durationAfter,
    expectedDurationAfter,
    revisionBefore,
    revisionDuringDrag,
    revisionAfterRelease,
    downstream,
    scrollTop: pane.scrollTop,
    scrollLeft: pane.scrollLeft,
    handles,
  };}

/**
 * 记录制挑出来的目标行（`move` 与 `resize-duration` 共用这个形状）。
 *
 * `successor*` 只在 `resize-duration` 轮有值：那是"下游跟随"判据的载体
 * （一条**由被拖任务的完成日决定**的后继边 + 它拖动前的开始序号）。
 */
interface DragTargetPick {
  readonly taskId: string;
  readonly successorId?: string;
  readonly linkType?: string;
  readonly successorEsBefore?: number;
}

/**
 * 挑一个可拖的目标行：渲染窗口内、**非里程碑、非汇总、且无有效入边约束**。
 *
 * 最后一条不可省（P-25 落地时踩到）：`snap` 模式会把候选夹到入边约束之下，
 * 于是"拖 3 个工作日"这条位移判据对有前置约束的行**必然**报错——那是判据自己选错了样本，
 * 不是应用错了。`gesture.spec.ts` 的 `pickLeaf` 一直是这么过滤的，记录制这一侧必须同口径。
 */
function pickDragTarget(host: DragMeasurementHost): DragTargetPick | null {
  const view = host.view();
  const document = host.document();
  const schedule = host.schedule();
  if (view === null || schedule === null) return null;
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const bounded = view.rows.find((item) => item.row === row);
    if (bounded === undefined) continue;
    if (bounded.isMilestone || bounded.kind === 'summary') continue;
    const constraint = entryConstraintFor({
      document,
      schedule,
      taskId: bounded.id,
      durationDays: document.tasks.find((task) => task.id === bounded.id)?.durationDays ?? 0,
    });
    if (Number.isFinite(constraint)) continue;
    return { taskId: bounded.id };
  }
  return null;
}

/**
 * 挑一个「带**有效**后继边的叶子行」——`resize-duration` 轮的样本（裁决 P-45）。
 *
 * 三条前提，缺一条"下游跟随"就判不了：
 * 1. 目标行在渲染窗口内、非里程碑/非汇总（要抓得住条右端）；
 * 2. 它有一条出边 **`FS`/`FF`**——只有这两类关系的下游边界**含被拖任务的完成日**
 *    （`FS`：`es后 = ef前 + lag`；`FF`：`ef后 = ef前 + lag`）。
 *    `SS`（只看开始日）与 `SF`（`ef后 = es前 + lag`，**根本不含完成日**）在"改工期"下
 *    本来就不该动——拿它们当载体是判据自己错了（本轮实测踩到：SF 的 `before === after`）；
 * 3. 该边是那个后继的**紧约束**（后继确实顶在这条边上）——否则后继被别的入边顶住，
 *    `before === after`，"预览 == 提交"就退化成恒真式。边界式与
 *    `entryConstraintFor`（= SCHEDULE.md §九 不变量 2）逐字同式。
 */
function pickResizeTarget(host: DragMeasurementHost): DragTargetPick | null {
  const view = host.view();
  const document = host.document();
  const schedule = host.schedule();
  if (view === null || schedule === null) return null;
  const indexOfId = new Map<string, number>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined) indexOfId.set(task.id, index);
  }
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const bounded = view.rows.find((item) => item.row === row);
    if (bounded === undefined) continue;
    if (bounded.isMilestone || bounded.kind === 'summary') continue;
    const durationDays = document.tasks.find((task) => task.id === bounded.id)?.durationDays ?? 0;
    if (durationDays < 1) continue;
    /**
     * **必须无有效入边约束**（与 `move` 轮同一条前提，P-25 的教训在这一轮同样成立）：
     * 有前置时引擎按"前置优先"算 `ES`，而拖动期是**锚点**定位置——
     * 于是"松手前在锚点上、松手后被约束拉回去"这件事会被误读成"预览与提交分叉"。
     * 那是判据选错了样本（实测踩到：`t35` 拖动期 10、松手后 9），不是应用错了。
     */
    if (
      Number.isFinite(
        entryConstraintFor({ document, schedule, taskId: bounded.id, durationDays }),
      )
    ) {
      continue;
    }
    const fromIndex = indexOfId.get(bounded.id) ?? -1;
    const fromEs = schedule.es[fromIndex] ?? -1;
    const fromEf = schedule.ef[fromIndex] ?? -1;
    if (fromEs < 0 || fromEf < 0) continue;
    for (const link of document.links) {
      if (link.from !== bounded.id) continue;
      if (link.type !== 'FS' && link.type !== 'FF') continue;
      const successorIndex = indexOfId.get(link.to);
      if (successorIndex === undefined) continue;
      const toEs = schedule.es[successorIndex] ?? -1;
      const toEf = schedule.ef[successorIndex] ?? -1;
      if (toEs < 0 || toEf < 0) continue; // 汇总端点在有效图里不存在（SCHEDULE.md §四.6）
      // **紧约束**：后继确实顶在这条边上（`FS` 决定开始日、`FF` 决定完成日）。
      const binding = link.type === 'FS' ? toEs === fromEf + link.lagDays : toEf === fromEf + link.lagDays;
      if (!binding) continue;
      return {
        taskId: bounded.id,
        successorId: link.to,
        linkType: link.type,
        successorEsBefore: toEs,
      };
    }
  }
  return null;
}

/**
 * 内容坐标 → 屏幕坐标（唯一的换算处；与 {@link dragScreenPoint} 同一个式子）。
 *
 * 为什么需要它：`resize-duration` 的抓取点是"条右端内 2 px"，它**不是**某个工作日格的
 * 中点，因此不能复用"按序号取中点"的那条路径。
 */
function contentPointToScreen(
  pane: HTMLElement,
  host: DragMeasurementHost,
  contentX: number,
  contentY: number,
): { readonly clientX: number; readonly clientY: number } | null {
  const view = host.view();
  if (view === null) return null;
  const rect = pane.getBoundingClientRect();
  return {
    clientX: rect.left + contentX - view.scrollLeft,
    clientY: rect.top + contentY - view.scrollTop,
  };
}

/** 某个任务**当前排程**里的开始序号（`null` = 不在文档里 / 汇总行）。 */
function esOf(host: DragMeasurementHost, taskId: string): number | null {
  const schedule = host.schedule();
  const document = host.document();
  if (schedule === null) return null;
  const index = document.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const ordinal = schedule.es[index];
  return ordinal === undefined || ordinal < 0 ? null : ordinal;
}

/**
 * 批次 B 的记录制采样：**手柄可见性 + 光标分类 + 连接点起建线**（ADR 0008 §16.2/§16.3／裁决 P-32）。
 *
 * 三条纪律：
 * 1. **只读**：只读 DOM 与调 `cursorAt` / `entryPointOf`（后者走与用户同一条纯函数路径，
 *    不派发事件、不进手势状态机）；
 * 2. **选择器必须用 `line.handle` / `rect.connect-point`**：行组里现在有多个 `rect`
 *    （`.bar` / `.bar-progress` / `.connect-point`），用"第一个 rect"会量到手柄
 *    （P-32 落地时当场修过 `--align` 的同一处）；
 * 3. **模型侧用 `handleOffsetsFor`**（与渲染同源），因此"模型 vs DOM"这条是**互证**而不是自证。
 */
async function collectHandleSample(
  host: DragMeasurementHost,
  taskId: string,
): Promise<NonNullable<DragMeasureResult['handles']> | null> {
  const view = host.view();
  const document = host.document();
  const schedule = host.schedule();
  const pane = window.document.getElementById('chart-pane');
  if (view === null || schedule === null || pane === null) return null;
  const row = view.rows.find((item) => item.id === taskId);
  if (row === undefined) return null;

  const described = handleOffsetsFor({
    view,
    document,
    schedule,
    calendar: host.calendar() as unknown as Parameters<typeof handleOffsetsFor>[0]['calendar'],
  });
  let modelHandles = 0;
  let modelConnectPoints = 0;
  for (const item of described) {
    modelHandles += item.handleCount;
    modelConnectPoints += item.connectCount;
  }

  const svg = window.document.querySelector('.chart-pane-wrap .gantt-svg, #chart-pane .gantt-svg');
  const domHandles = svg?.querySelectorAll('.rows line.handle').length ?? 0;
  const rowGroups = svg?.querySelectorAll('.rows > g').length ?? 0;

  // 采样点（屏幕坐标）：条体中部 / 端点手柄 / 连接点——都用**模型几何**换算，与用户路径同源。
  const rect = pane.getBoundingClientRect();
  const toClient = (contentX: number, contentY: number): { readonly clientX: number; readonly clientY: number } => ({
    clientX: rect.left + contentX - view.scrollLeft,
    clientY: rect.top + contentY - view.scrollTop,
  });
  /**
   * 采样点的 x **从 DOM 属性读**，不在这里重算公式。
   *
   * 理由（P-32 落地时当场踩到）：`row.xRight` 是条形的**端**，而端点手柄画在**判定区边界**
   * （§16.2：`zones.edgeR.x1`，比端更靠内 6 px）。若在这里用 `row.xRight` 当"手柄处"，
   * 采样点会落到**连接点**上（`xRight + 2` 与 `xRight` 相距 2 px），于是判据报
   * "端点手柄处光标应为 col-resize，实际 crosshair"——那是**采错了点**，不是实现错了。
   * 从 DOM 读同时还有第二个好处：它顺带断言了"手柄真的发射了"。
   */
  const rowGroup = [...(svg?.querySelectorAll('.rows > g[data-task-id]') ?? [])].find((node) => node.getAttribute('data-task-id') === taskId) ?? null;
  const handleNodes = rowGroup === null ? [] : [...rowGroup.querySelectorAll('line.handle')];
  const attrX = (node: Element): number => Number(node.getAttribute('x') ?? node.getAttribute('x1') ?? Number.NaN);
  const handleContentX = handleNodes.map((node) => attrX(node)).filter((value) => Number.isFinite(value)).sort((a, b) => b - a)[0];
  // **条心**（不是 `row.row * rowHeight + rowHeight / 2` 的近似：`row.y` 是行顶，两者必须同源）。
  const y = row.barY + row.barHeight / 2;
  const mid = toClient((row.xLeft + row.xRight) / 2, y);
  const edge = toClient(handleContentX ?? row.xRight, y);

  /**
   * 连接点：**先把指针放到"条端外侧的方块"上，再读 DOM**。
   *
   * 它按需显形（P-32 复验第 3.2 条），所以顺序不能反：先 hover ⇒ 应用把该行的连接点发射出来 ⇒
   * 才能量到条数。`CONNECT_SIZE_PX / 2` = 方块的中心线（在条端的**外侧** 4 px）。
   */
  const connect = toClient(row.xRight + CONNECT_SIZE_PX / 2, y);
  host.hoverAt?.(connect.clientX, connect.clientY);
  // **必须等 Vue 把连接点渲染出来**再读 DOM：`hoverAt` 只改了响应式状态，
  // 同一个 microtask 里读 DOM 会恒得 0（这条在落地记录制时当场踩到）。
  await nextTick();
  // **只数"指针所在那一行"的连接点**：连接点按需显形（复验第 3.2 条），
  // `domConnectPoints` 若沿用 hover 之前的全图计数，这条判据会恒红。
  // 选择器**不限定标签**（P-42 批次③起可见图形是 `<circle>`）——"可见盒"一律按 DOM 矩形量。
  const connectNodesAfterHover =
    rowGroup === null ? [] : [...rowGroup.querySelectorAll('.connect-point')];
  const domConnectPointsAfterHover = connectNodesAfterHover.length;
  /** 连接点的**内容坐标**左缘：从 DOM 矩形反推（`x`/`cx` 两种标签都能量到，不在这里重算公式）。 */
  const contentLeftOf = (node: Element): number => node.getBoundingClientRect().left - rect.left + view.scrollLeft;
  const connectContentX = connectNodesAfterHover
    .map((node) => contentLeftOf(node))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  const firstConnectBox =
    connectNodesAfterHover.length === 0
      ? null
      : (() => {
          const box = connectNodesAfterHover[0]?.getBoundingClientRect();
          return box === undefined ? null : { width: round(box.width), height: round(box.height) };
        })();
  host.clearHover?.();

  const entry = host.entryPointOf?.(connect.clientX, connect.clientY) ?? null;
  return {
    rowGroups,
    domHandles,
    domConnectPoints: domConnectPointsAfterHover,
    modelHandles,
    modelConnectPoints,
    cursorOnBar: host.cursorAt?.(mid.clientX, mid.clientY) ?? '',
    cursorOnEdge: host.cursorAt?.(edge.clientX, edge.clientY) ?? '',
    cursorOnConnect: host.cursorAt?.(connect.clientX, connect.clientY) ?? '',
    connectDownEntersLinking: entry !== null && entry.taskId === taskId,
    // 采样用的连接点左缘（`null` 说明该行没发射连接点 —— 上面那条会报出来）。
    connectLeftEdge: connectContentX ?? null,
    connectTag: connectNodesAfterHover[0]?.tagName.toLowerCase() ?? '',
    connectBox: firstConnectBox,
  };
}
/**
 * 当前 DOM 上**全部条形的几何串**（用于判断"渲染侧真的更新了"= 下游跟随的间接证据）。
 *
 * 两处口径（P-23 落地时当场抓到第一处）：
 * - **选择器**同时覆盖两种排布（SVG 是滚动容器的**兄弟**〔修后〕或子元素〔修前 / 负向对照〕）：
 *   修后只查 `#chart-pane .rows` 会恒得空串 ⇒ 假阴性；
 * - **必须带上 `x`/`y`**：`move`（整体移动）只改位置、不改宽度，只串 `width`/`points`
 *   会把"正在跟随的一次 `move`"报成 0 帧变化。
 * 覆盖层不在此列（只查 `.rows`），因此任何变化都意味着**条形本身**被重绘了。
 */
function collectBarGeometry(): string {
  const nodes = document.querySelectorAll(
    // **只串条形与菱形**（`.bar` / `.milestone`）：行组里现在还有 `.bar-progress` 与
    // `.connect-point`（批次 B 的端点手柄是 `<line>`，不在本选择器内）。不排除它们会让
    // "手柄/连接点变了"被算成"条形变了" ⇒ `--drag` 的"DOM 变化 N/12 帧"变成**假绿**
    // （P-23 修过一次同族假阴性）。
    '.chart-pane-wrap .rows rect.bar, .chart-pane-wrap .rows polygon.milestone, #chart-pane .rows rect.bar, #chart-pane .rows polygon.milestone',
  );
  const parts: string[] = [];
  nodes.forEach((node) => {
    parts.push(
      [
        node.getAttribute('x') ?? '',
        node.getAttribute('y') ?? '',
        node.getAttribute('width') ?? '',
        node.getAttribute('height') ?? '',
        node.getAttribute('points') ?? '',
      ].join(','),
    );
  });
  return parts.join('|');
}

function emptyDragResult(
  args: {
    readonly fixtureSpec: FixtureSpec;
    readonly dayDelta: number;
    readonly frames: number;
    readonly scrollTop?: number;
    readonly scrollLeft?: number;
    readonly mode?: 'move' | 'resize-duration';
  },
  errors: readonly string[],
): DragMeasureResult {
  return {
    status: 'error',
    errors,
    dataset: args.fixtureSpec.key,
    taskId: '',
    dayDelta: args.dayDelta,
    frames: args.frames,
    mainThreadMs: [],
    mainThreadP50Ms: 0,
    mainThreadP95Ms: 0,
    frameGapsMs: [],
    frameGapP50Ms: 0,
    frameGapP95Ms: 0,
    longTasks: 0,
    releaseMs: 0,
    observedGeometryChanges: 0,
    anchorsAfterRelease: 0,
    documentStartAfter: null,
    anchorOrdinal: null,
    expectedStartAfter: null,
    mode: args.mode ?? 'move',
    gestureMode: null,
    durationBefore: null,
    durationAfter: null,
    expectedDurationAfter: null,
    revisionBefore: 0,
    revisionDuringDrag: 0,
    revisionAfterRelease: 0,
    downstream: null,
    scrollTop: args.scrollTop ?? 0,
    scrollLeft: args.scrollLeft ?? 0,
    handles: null,
  };}

// ---------------------------------------------------------------- G5 批次 D：两栏行对齐（记录制，ADR 0007 §14 / 裁决 P-23）

/** 对齐测量的宿主：由 `App.vue` 提供（除 `setZoom` 外全部**只读**）。 */
export interface AlignMeasurementHost {
  /** 当前渲染的视图模型（提供行序、行高、条形的**内容坐标**）。 */
  readonly view: () => ViewModel | null;
  /** 滚动容器（绘制区）元素。 */
  readonly pane: () => HTMLElement | null;
  /**
   * 屏幕坐标 → 内容坐标（**与用户操作同一条路**：`App.vue` 的 `pointerFrom` 走的纯函数）。
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

/** 只读地取一个元素的外接矩形（`null` = 元素不存在）。 */
function boxOf(
  element: { getBoundingClientRect(): { readonly top: number; readonly left: number; readonly width: number; readonly height: number } } | null,
): { readonly top: number; readonly left: number; readonly width: number; readonly height: number } | null {
  return element === null ? null : element.getBoundingClientRect();
}

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

    // 轴覆盖：优先用色带（矩形，无描边误差），没有色带时退到网格线（±0.5 px 描边）。
    // **四边都要量**（P-24）：轴的横向双重偏移在 `scrollLeft = 0` 处不可见，
    // 只看纵向会让"右侧新区域空白"从判据下溜走。
    const bandBoxes = [
      ...document.querySelectorAll('.chart-pane-wrap .axis rect, #chart-pane .axis rect'),
    ]
      .map((element) => boxOf(element))
      .filter((box) => box !== null);
    const lineBoxes =
      bandBoxes.length > 0
        ? []
        : [...document.querySelectorAll('.chart-pane-wrap .axis line, #chart-pane .axis line')]
            .map((element) => boxOf(element))
            .filter((box) => box !== null);
    const axisBoxes = bandBoxes.length > 0 ? bandBoxes : lineBoxes;
    const axisCoverage =
      axisBoxes.length === 0
        ? null
        : {
            top: Math.min(...axisBoxes.map((box) => box.top)),
            bottom: Math.max(...axisBoxes.map((box) => box.top + box.height)),
            left: Math.min(...axisBoxes.map((box) => box.left)),
            right: Math.max(...axisBoxes.map((box) => box.left + box.width)),
          };
    // **横向覆盖**用刻度（网格线）：色带是稀疏的，它的并集本来就不该触到左右缘。
    const tickBoxes = [...document.querySelectorAll('.chart-pane-wrap .axis line, #chart-pane .axis line')]
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

/** 供 CDP 侧核对：本测量钩子的版本标记（避免与旧产物混淆）。 */
export const MEASURE_HOOK_VERSION = 'g5-2';

// ---------------------------------------------------------------- G6：持久化测量（记录制，ADR 0009 §5）

/** 持久化测量的宿主：由 `App.vue` 提供的**只读**入口。 */
export interface PersistenceMeasurementHost {
  /** 是否已接入持久化（`?persist=0` 时为假——它就是"关掉自动保存"的对照组）。 */
  readonly enabled: () => boolean;
  /** 测量钩子就绪（恢复流程跑完）后才允许开始采数。 */
  readonly ready: () => boolean;
  /** 立即写一次（并等它完成）。 */
  readonly flush: () => Promise<boolean>;
  /** 不理会策略，直接写一条记录（量"写入耗时"用；`flush` 在没变更时是空操作）。 */
  readonly writeRecord: () => Promise<boolean>;
  /** **硬重定基线**（换夹具之后必须做：否则记录里带着上一份文档的基线）。 */
  readonly rebase: () => Promise<boolean>;

  /** 只读样本（写次数 / 手势期写次数 / 最近一次延迟 / 记录字节数 / 检查点份数）。 */
  readonly probe: () => {
    readonly writes: number;
    readonly checkpoints: number;
    readonly lastWriteIncrementSteps: number;
    readonly lastFlushMs: number | null;
    readonly degradedReason: string | null;
    readonly writesDuringGesture: number;
    readonly recordBytes: number;
    /** 该记录的构成（基线 / 增量 / redo 各自多少字节）。 */
    readonly recordBreakdown: {
      readonly baseBytes: number;
      readonly postBytes: number;
      readonly redoBytes: number;
      readonly postSteps: number;
    } | null;
  };
  /** 拖动宿主（与 G5 的 `--drag` 完全同一条路：真实指针事件 + 真实手势状态机）。 */
  readonly drag: DragMeasurementHost;
}

/** 持久化测量的结果（记录制：出口条件①与④的数字都在这里）。 */
export interface PersistMeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  /** 是否接入了持久化（对照组为假）。 */
  readonly enabled: boolean;
  /** 拖动期帧间隔（与 G5 `--drag` 同尺：p95 ≤ 33.3 ms 即 ≥30 fps）。 */
  readonly frameGapsMs: readonly number[];
  readonly frameGapP50Ms: number;
  readonly frameGapP95Ms: number;
  /** 拖动期主线程同步工作量（事件派发 + Vue 更新）。 */
  readonly mainThreadMs: readonly number[];
  readonly mainThreadP50Ms: number;
  readonly mainThreadP95Ms: number;
  readonly longTasks: number;
  /** **拖动期间的持久化写入次数（期望 0；出口条件①的可判定形式）。** */
  readonly writesDuringGesture: number;
  /** 拖动前/后的写入计数（用来断言"拖动期没有落盘"）。 */
  readonly writesBefore: number;
  readonly writesAfter: number;
  /** 拖动结束后等一次 `flush`，记录"松手 → 落盘完成"的墙钟（G6 出口条件①的时效数字）。 */
  readonly flushAfterReleaseMs: number | null;
  /** 2,000 任务夹具的存储占用与写入耗时（G6 出口条件④）。 */
  readonly storage: StorageMeasurement | null;
}

/** 存储占用与写入耗时（**单独一次采样**；夹具由调用方给）。 */
export interface StorageMeasurement {
  readonly tasks: number;
  readonly links: number;
  /** 整份规范文档文本的字节数（= 一份检查点的体积下界）。 */
  readonly documentBytes: number;
  readonly serializeMs: number;
  /** 单条"最新状态"记录的字节数（增量口径：与文档规模脱钩）。 */
  readonly recordBytes: number;
  /** 该记录的构成（记录制诊断：基线 / 增量 / redo 各自多少字节）。 */
  readonly recordBreakdown: {
    readonly baseBytes: number;
    readonly postBytes: number;
    readonly redoBytes: number;
    readonly postSteps: number;
  } | null;
  /** 采样前「最近一次写入记录」里的增量步数（0 = 基线就是当前状态）。 */
  readonly probeLastWriteIncrementSteps: number;
  /** 逐条 `put` 的墙钟（ms；p50/p95）。 */
  readonly putMs: readonly number[];
  readonly putP50Ms: number;
  readonly putP95Ms: number;
  /** `navigator.storage.estimate()` 的用量（字节）。 */
  readonly estimate: { readonly usage: number; readonly quota: number } | null;
}

/**
 * 跑一次持久化测量（**记录制**）。
 *
 * 口径（必须与数字一起引用）：
 * - 拖动用**真实指针事件**驱动（与 G5 `--drag` 同一条路），因此"拖拽期间不产生可见掉帧"
 *   这一条测的是产品路径，不是平行公式；
 * - **关掉持久化的对照组**由 `?persist=0` 提供（同一次采集里跑两组更可靠的做法是分别导航，故此处
 *   只采当前页面这一个口径，脚本负责跑两次）；
 * - 拖动前先 `flush`（把"之前积压的变更"清干净），否则"拖动期有没有落盘"会被旧账污染。
 */
export async function runPersistMeasurement(args: {
  readonly host: PersistenceMeasurementHost;
  readonly fixtureSpec: FixtureSpec;
  readonly dayDelta: number;
  readonly frames: number;
  readonly samples: number;
  /** 只测"存储占用与写入耗时"（出口条件④）：**不碰拖动**。 */
  readonly skipDrag?: boolean;
}): Promise<PersistMeasureResult> {
  const errors: string[] = [];
  const empty = (messages: readonly string[]): PersistMeasureResult => ({
    status: 'error',
    errors: messages,
    dataset: args.fixtureSpec.key,
    enabled: false,
    frameGapsMs: [],
    frameGapP50Ms: 0,
    frameGapP95Ms: 0,
    mainThreadMs: [],
    mainThreadP50Ms: 0,
    mainThreadP95Ms: 0,
    longTasks: 0,
    writesDuringGesture: 0,
    writesBefore: 0,
    writesAfter: 0,
    flushAfterReleaseMs: null,
    storage: null,
  });

  const pane = document.getElementById('chart-pane');
  if (pane === null) return empty(['找不到图表窗格（#chart-pane）']);
  if (!args.host.ready()) return empty(['持久化还没就绪（启动恢复未完成）']);

  if (args.skipDrag === true) {
    // 只测存储（出口条件④）：**不拖**，因此帧预算那几条在结果里保持空值。
    // **先硬重定基线**：换夹具之后的记录才有意义（基线 = 当前文档）。
    await args.host.rebase();
    let storageOnly: StorageMeasurement | null = null;
    try {
      storageOnly = await measureStorage(args.host, args.samples);
    } catch (error) {
      errors.push(`存储测量失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      ...empty([]),
      status: errors.length === 0 ? 'ok' : 'error',
      errors,
      enabled: args.host.enabled(),
      writesAfter: args.host.probe().writes,
      storage: storageOnly,
    };
  }

  // 换夹具之后**先硬重定基线**（否则记录里带着上一份文档的基线），再把积压清干净——
  // 这样"拖动期写入次数"才只反映拖动期。（跨轮污染由**脚本侧**在导航前清库解决。）
  await args.host.rebase();
  await args.host.flush();
  const writesBefore = args.host.probe().writes;

  const drag = args.host.drag;
  const target = (() => {
    const view = drag.view();
    if (view === null) return null;
    for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
      const bounded = view.rows.find((item) => item.row === row);
      if (bounded === undefined) continue;
      if (bounded.isMilestone || bounded.kind === 'summary') continue;
      return { taskId: bounded.id, anchorOrdinal: bounded.es };
    }
    return null;
  })();
  if (target === null) return empty(['渲染窗口内没有可拖动的叶子任务']);

  const toClient = (contentX: number, contentY: number): { clientX: number; clientY: number } => {
    const view = drag.view();
    const rect = pane.getBoundingClientRect();
    return {
      clientX: rect.left + contentX - (view?.scrollLeft ?? 0),
      clientY: rect.top + contentY - (view?.scrollTop ?? 0),
    };
  };
  const pointAt = (ordinalOffset: number): { clientX: number; clientY: number } | null => {
    const view = drag.view();
    if (view === null) return null;
    const row = view.rows.find((item) => item.id === target.taskId);
    if (row === undefined) return null;
    const day = drag.calendar().dayOfOrdinal(target.anchorOrdinal + ordinalOffset);
    const contentX = (day - view.axisOriginDay) * view.pxPerDay + view.pxPerDay / 2;
    const contentY = row.row * view.rowHeight + view.rowHeight / 2;
    return toClient(contentX, contentY);
  };

  const dispatch = (type: 'down' | 'move' | 'up', point: { clientX: number; clientY: number }): void => {
    const event = new MouseEvent(type === 'down' ? 'mousedown' : type === 'move' ? 'mousemove' : 'mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
      buttons: type === 'up' ? 0 : 1,
      view: window,
    });
    if (type === 'down') drag.pointer.down(event);
    else if (type === 'move') drag.pointer.move(event);
    else drag.pointer.up(event);
  };

  const start = pointAt(0);
  const end = pointAt(args.dayDelta);
  if (start === null || end === null) return empty(['无法把目标任务换算成屏幕坐标']);

  const mainThreadMs: number[] = [];
  const frameGapsMs: number[] = [];
  let lastFrameAt = performance.now();
  dispatch('down', start);
  await nextTick();
  if (drag.gestureKind() !== 'dragging') {
    errors.push(`按下后未进入拖动（实际 ${drag.gestureKind()}）`);
  }
  for (let index = 1; index <= args.frames; index += 1) {
    const offset = Math.round((args.dayDelta * index) / args.frames);
    const point = pointAt(offset) ?? start;
    const started = performance.now();
    dispatch('move', point);
    await nextTick();
    mainThreadMs.push(round(performance.now() - started));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const now = performance.now();
        frameGapsMs.push(round(now - lastFrameAt));
        lastFrameAt = now;
        resolve();
      });
    });
  }
  dispatch('up', end);
  await nextTick();

  const probeAfterDrag = args.host.probe();
  const writesDuringGesture = probeAfterDrag.writesDuringGesture;
  if (writesDuringGesture !== 0) {
    errors.push(`拖动期发生了 ${String(writesDuringGesture)} 次持久化写入（期望 0）`);
  }
  // 松手之后的合法终态包括 `released`/`rejected`/`outside`（状态机使然，见 GestureState）；
  // 这里只拒"**还在拖**"这两种——那才是真的没收尾。
  if (drag.gestureKind() === 'dragging' || drag.gestureKind() === 'linking') {
    errors.push(`松手后手势仍在 ${drag.gestureKind()}（期望已收尾）`);
  }

  // 松手 → 落盘完成：G6 出口条件①的时效数字（≤5s 的口径，实际应远小于它）。
  const releaseAt = performance.now();
  const flushed = await args.host.flush();
  const flushAfterReleaseMs = flushed ? round(performance.now() - releaseAt) : null;

  let storage: StorageMeasurement | null = null;
  try {
    storage = await measureStorage(args.host, args.samples);
  } catch (error) {
    errors.push(`存储测量失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const longTasks = (() => {
    try {
      return performance.getEntriesByType('longtask').length;
    } catch {
      return 0;
    }
  })();

  return {
    status: errors.length === 0 ? 'ok' : 'error',
    errors,
    dataset: args.fixtureSpec.key,
    enabled: args.host.enabled(),
    frameGapsMs,
    frameGapP50Ms: percentile(frameGapsMs, 0.5),
    frameGapP95Ms: percentile(frameGapsMs, 0.95),
    mainThreadMs,
    mainThreadP50Ms: percentile(mainThreadMs, 0.5),
    mainThreadP95Ms: percentile(mainThreadMs, 0.95),
    longTasks,
    writesDuringGesture,
    writesBefore,
    writesAfter: args.host.probe().writes,
    flushAfterReleaseMs,
    storage,
  };
}

/**
 * 存储占用与写入耗时（G6 出口条件④）。
 *
 * 三件事各自量一次：**整份文档的规范文本体积与序列化耗时**（一份检查点的下界）、
 * **逐条 `put` 的墙钟**（写入耗时；p50/p95）、**`estimate()` 的用量**。
 * 注意"整份文档序列化一次"正是 R-2 点名的成本项：本块的设计让它**只在检查点发生**。
 */
async function measureStorage(
  host: PersistenceMeasurementHost,
  samples: number,
): Promise<StorageMeasurement> {
  const projectDocument = host.drag.document();
  const t0 = performance.now();
  const serialized = JSON.stringify(projectDocument);
  const serializeMs = round(performance.now() - t0);
  const documentBytes = new TextEncoder().encode(serialized).length;

  // 写入采样：**每条都真的写一条记录**（`flush()` 在"没有未落盘变更"时是空操作 ⇒ 量不到耗时）。
  const putMs: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await host.writeRecord();
    const elapsed = round(performance.now() - started);
    if (elapsed > 0) putMs.push(elapsed);
  }
  const estimate = await estimateStorage();
  return {
    tasks: projectDocument.tasks.length,
    links: projectDocument.links.length,
    documentBytes,
    serializeMs,
    recordBytes: host.probe().recordBytes,
    recordBreakdown: host.probe().recordBreakdown,
    probeLastWriteIncrementSteps: host.probe().lastWriteIncrementSteps,
    // 说明：`recordBytes` 取自最近一次写入的记录（只含基线之后的增量）。
    putMs,
    putP50Ms: percentile(putMs, 0.5),
    putP95Ms: percentile(putMs, 0.95),
    estimate,
  };
}
