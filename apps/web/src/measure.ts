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
import {
  buildView,
  CONNECT_SIZE_PX,
  countElements,
  createScheduleCalendar,
  DATASETS,
  diagnoseRowAlignment,
  entryConstraintFor,
  handleOffsetsFor,
  PRIMARY_DATASET_KEY,
  REFERENCE_DATASET,
  ROW_BUFFER,
  ROW_HEIGHT,
  summarizeAlignment,
  THRESHOLDS,
  ZOOM_ORDER,
  ZOOM_UNIT_DAYS,
  type FixtureSpec,
  type PointerInput,
  type ProjectDocument,
  type RowAlignProbe,
  type RowAlignSample,
  type RowAlignVerdict,
  type Schedule,
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
export function specOfDataset(key: string): FixtureSpec {
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
      // 帧等待在这里，单独计时，**不计入** `workMs`。
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
    const steps: { step: number; scrollTop: number; workMs: number; elements: number; blankRows: number }[] = [];
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
}): void {
  const host = window as unknown as { __GANTTPILOT_MEASURE__?: unknown; __GANTTPILOT_MEASURE_DRAG__?: unknown; __GANTTPILOT_MEASURE_ALIGN__?: unknown };
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
    }): Promise<DragMeasureResult> => {
      const spec = specOfDataset(options.dataset ?? PRIMARY_DATASET_KEY);
      const document = args.buildFixtureDocument(spec.key);
      await args.loadDocument(document);
      return runDragMeasurement({
        host: dragHost,
        fixtureSpec: spec,
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
      readonly positions?: readonly { readonly top: number; readonly left: number }[];
    }): Promise<AlignMeasureResult> => {
      const spec = specOfDataset(options.dataset ?? PRIMARY_DATASET_KEY);
      const document = args.buildFixtureDocument(spec.key);
      await args.loadDocument(document);
      const requested = Array.isArray(options.positions) ? options.positions : [];
      return runAlignMeasurement({
        host: alignHost,
        dataset: spec.key,
        positions:
          requested.length > 0
            ? requested.map((item) => ({
                top: Math.max(0, Math.trunc(Number(item.top) || 0)),
                left: Math.max(0, Math.trunc(Number(item.left) || 0)),
              }))
            : [...ALIGN_PROBES],
      });
    };
  }
}
// ---------------------------------------------------------------- G5：拖动测量（记录制，ADR 0008 §11）

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
  /** 批次 B 的记录制采样：手柄可见性、连接点起手、光标分类（ADR 0008 §16.2/§16.3）。 */
  readonly handles: {
    /** 渲染行组数（`data-task-id` 的 `<g>`）。 */
    readonly rowGroups: number;
    /** DOM 上手柄的条数（`line.handle`）。 */
    readonly domHandles: number;
    /**
     * DOM 上连接点的条数（`rect.connect-point`）。
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
 */export async function runDragMeasurement(args: {
  readonly host: DragMeasurementHost;
  readonly fixtureSpec: FixtureSpec;
  readonly dayDelta: number;
  readonly frames: number;
  /** 先把窗格滚到这里再拖（P-25：R13/R14 都**只在滚动后**现形）。 */
  readonly scrollTop?: number;
  readonly scrollLeft?: number;
}): Promise<DragMeasureResult> {
  const errors: string[] = [];
  const pane = document.getElementById('chart-pane');
  if (pane === null) {
    return emptyDragResult(args, ['找不到图表窗格（#chart-pane）']);
  }

  // 滚动到指定位置：**等两帧**（`scroll` 事件先于下一帧派发；不等帧就会在"状态已变、DOM 未变"的
  // 中间态上挑目标行与换算坐标——那样判据测的是别的东西）。
  pane.scrollTop = args.scrollTop ?? 0;
  pane.scrollLeft = args.scrollLeft ?? 0;
  await nextTick();
  await oneFrame();
  await oneFrame();

  const target = pickDragTarget(args.host);
  if (target === null) {
    return emptyDragResult(args, ['渲染窗口内没有可拖动的叶子任务']);
  }

  // **绝对基准**：拖动前该行的开始序号（拖动期视图会带着锚点重算，不能事后取）。
  const anchorOrdinal = args.host.view()?.rows.find((item) => item.id === target.taskId)?.es ?? null;
  if (anchorOrdinal === null) {
    return emptyDragResult(args, ['无法取到目标任务在拖动前的开始序号（位移判据需要它作基准）']);
  }

  const start = dragScreenPoint(args.host, pane, target.taskId, anchorOrdinal, 0);
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

  dispatch('down', start);
  await nextTick();
  if (args.host.gestureKind() !== 'dragging') {
    errors.push(`按下后未进入拖动（实际 ${args.host.gestureKind()}）`);
  }

  let lastFrameAt = performance.now();
  const frames = args.frames;
  for (let index = 1; index <= frames; index += 1) {
    const offset = Math.round((args.dayDelta * index) / frames);
    const point = dragScreenPoint(args.host, pane, target.taskId, anchorOrdinal, offset) ?? start;    const started = performance.now();
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

  const releaseStart = performance.now();
  const endPoint = dragScreenPoint(args.host, pane, target.taskId, anchorOrdinal, args.dayDelta) ?? start;  dispatch('up', endPoint);
  await nextTick();
  const releaseMs = round(performance.now() - releaseStart);

  // **位移判据**（P-22 补上）：松手后的 `startDate` 必须等于"拖动前的开始序号 + dayDelta"。
  // 旧证据只断言"非空"，于是 `2026-10-05`（与拖前相同的项目起点）也被算作通过 —— 那是恒真式。
  const documentStartAfter = args.host.startDateOf(target.taskId);
  const expectedStartAfter = args.host.calendar().isoOfOrdinal(anchorOrdinal + args.dayDelta) ?? null;
  if (documentStartAfter !== expectedStartAfter) {
    errors.push(
      `拖动位移与文档不符：startDate = ${String(documentStartAfter)}，期望 ${String(expectedStartAfter)}` +
        `（拖动前开始序号 ${String(anchorOrdinal)} + ${String(args.dayDelta)} 个工作日）`,
    );
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
    scrollTop: pane.scrollTop,
    scrollLeft: pane.scrollLeft,
    handles,
  };}

/**
 * 挑一个可拖的目标行：渲染窗口内、**非里程碑、非汇总、且无有效入边约束**。
 *
 * 最后一条不可省（P-25 落地时踩到）：`snap` 模式会把候选夹到入边约束之下，
 * 于是"拖 3 个工作日"这条位移判据对有前置约束的行**必然**报错——那是判据自己选错了样本，
 * 不是应用错了。`gesture.spec.ts` 的 `pickLeaf` 一直是这么过滤的，记录制这一侧必须同口径。
 */
function pickDragTarget(host: DragMeasurementHost): { readonly taskId: string } | null {
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
  const domConnectPointsAfterHover =
    rowGroup === null ? 0 : rowGroup.querySelectorAll('rect.connect-point').length;
  const connectNodesAfterHover =
    rowGroup === null ? [] : [...rowGroup.querySelectorAll('rect.connect-point')];
  const connectContentX = connectNodesAfterHover
    .map((node) => attrX(node))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
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
    // 采样用的方块左缘（`null` 说明该行没发射连接点 —— 上面那条会报出来）。
    connectLeftEdge: connectContentX ?? null,
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
    scrollTop: args.scrollTop ?? 0,
    scrollLeft: args.scrollLeft ?? 0,
    handles: null,
  };}

// ---------------------------------------------------------------- G5 批次 D：两栏行对齐（记录制，ADR 0007 §14 / 裁决 P-23）

/** 对齐测量的宿主：由 `App.vue` 提供的**只读**入口。 */
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
}

/** 一次探测（一个 `scrollTop` × `scrollLeft` 位置）的结果。 */
export interface AlignProbeResult {
  /** 请求的 `scrollTop` / `scrollLeft`；浏览器会夹到可表示范围，**真值**见 `probe`。 */
  readonly requestedScrollTop: number;
  readonly requestedScrollLeft: number;
  readonly probe: RowAlignProbe;
  readonly verdict: RowAlignVerdict;
}

/** 对齐测量的结果（判读逻辑在 `render-core/align.ts`，**那份进 `pnpm gate`**）。 */
export interface AlignMeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  readonly probes: readonly AlignProbeResult[];
  readonly summary: {
    readonly ok: boolean;
    readonly probes: number;
    readonly failingProbes: number;
    readonly maxAbsRowDeltaPx: number;
    readonly maxAbsBarXDeltaPx: number;
    readonly mechanisms: readonly string[];
  };
}

/**
 * 默认探测位置：**横向与纵向都必须含 0 与"尽量大"**（`9_999_999` 由浏览器夹到 `maxScroll`）。
 *
 * 三条硬要求：
 * ① 双重偏移在 `scrollTop = 0` 处恒为 0（机制**不可见**）⇒ 至少两个位置才判得出机制（P-22 遗留 1）；
 * ② 最末那个大值由浏览器夹到 `maxScroll` ⇒ 空白带（"下方/右侧新区域空白"）也在被测范围内；
 * ③ **横向同样要探**（P-24）：轴的横向双重偏移在 `scrollLeft = 0` 处同样不可见，
 *    只探纵向会漏掉"右侧新区域没有网格线/灰度带"。
 */
const ALIGN_PROBES: readonly { readonly top: number; readonly left: number }[] = [
  { top: 0, left: 0 },
  { top: 120, left: 0 },
  { top: 480, left: 600 },
  { top: 9_999_999, left: 0 },
  { top: 0, left: 9_999_999 },
  { top: 9_999_999, left: 9_999_999 },
];

/** 只读地取一个元素的外接矩形（`null` = 元素不存在）。 */
function boxOf(
  element: { getBoundingClientRect(): { readonly top: number; readonly left: number; readonly width: number; readonly height: number } } | null,
): { readonly top: number; readonly left: number; readonly width: number; readonly height: number } | null {
  return element === null ? null : element.getBoundingClientRect();
}

/**
 * 跑一次两栏行对齐测量（G5 批次 D，**记录制**）。
 *
 * 口径（必须与数字一起引用）：
 * - **只读**：只设 `scrollTop` 并读矩形，**不改文档、不派发指针事件、不进手势**；结束把 `scrollTop` 复位 0；
 * - 每个位置读 DOM 后等 `nextTick` + **两帧**：`scroll` 事件先于下一帧派发，
 *   不等帧会读到"状态已变、DOM 未变"或反之的中间态（那正是会把结论判反的读法）；
 * - 行按 `data-task-id` 配对（图表 `<g>` ↔ 左表 `.row`），**两侧计数必须与被渲染行数相等**；
 * - 判读全部交 `diagnoseRowAlignment`（纯函数、进门禁），本函数只负责采数。
 */
export async function runAlignMeasurement(args: {
  readonly host: AlignMeasurementHost;
  readonly dataset: string;
  readonly positions: readonly { readonly top: number; readonly left: number }[];
}): Promise<AlignMeasureResult> {
  const emptySummary = {
    ok: false,
    probes: 0,
    failingProbes: 0,
    maxAbsRowDeltaPx: 0,
    maxAbsBarXDeltaPx: 0,
    mechanisms: [] as readonly string[],
  };
  const failed = (errors: readonly string[]): AlignMeasureResult => ({
    status: 'error',
    errors,
    dataset: args.dataset,
    probes: [],
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

  for (const requested of args.positions) {
    // 先设纵向再设横向：两个方向都要等帧（`scroll` 事件先于下一帧派发）。
    pane.scrollTop = requested.top;
    pane.scrollLeft = requested.left;
    await nextTick();
    await oneFrame();
    await oneFrame();

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

    // 选择器同时覆盖两种排布：SVG 是滚动容器的**兄弟**（修后）或子元素（修前/负向对照）——
    // 判据必须能在"坏结构"上照样采到数，否则负向对照无从谈起。
    const rowGroups = [
      ...document.querySelectorAll(
        '.chart-pane-wrap .rows > g[data-task-id], #chart-pane .rows > g[data-task-id]',
      ),
    ];
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
      probe,
      verdict: diagnoseRowAlignment(probe),
    });
  }

  // 复位（诊断是只读的：不给下一次测量留下滚动位置）。
  pane.scrollTop = 0;
  pane.scrollLeft = 0;

  if (probes.length !== args.positions.length) {
    errors.push(`有效探测 ${String(probes.length)} / 请求 ${String(args.positions.length)}`);
  }
  const summary = summarizeAlignment(probes.map((item) => item.verdict));
  if (!summary.ok) {
    errors.push(
      `两栏行对齐未通过：最大行差 ${summary.maxAbsRowDeltaPx.toFixed(3)} px、` +
        `最大条形 x 偏差 ${summary.maxAbsBarXDeltaPx.toFixed(3)} px、机制 ${summary.mechanisms.join(' / ') || '(无)'}`,
    );
  }

  return {
    status: errors.length === 0 && summary.ok ? 'ok' : 'error',
    errors,
    dataset: args.dataset,
    probes,
    summary,
  };
}

/** 供 CDP 侧核对：本测量钩子的版本标记（避免与旧产物混淆）。 */
export const MEASURE_HOOK_VERSION = 'g5-2';
