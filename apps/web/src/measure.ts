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
  countElements,
  createScheduleCalendar,
  DATASETS,
  PRIMARY_DATASET_KEY,
  REFERENCE_DATASET,
  ROW_BUFFER,
  ROW_HEIGHT,
  THRESHOLDS,
  ZOOM_ORDER,
  type FixtureSpec,
  type ProjectDocument,
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
        const paneAfter = window.document.getElementById('chart-pane');
        domCounts.renderedRows = paneAfter?.querySelectorAll('.gantt-svg .rows > g').length ?? 0;
        domCounts.renderedEdges = paneAfter?.querySelectorAll('.gantt-svg .edges > g').length ?? 0;
        domCounts.svgElements = paneAfter?.querySelectorAll('.gantt-svg *').length ?? 0;
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
      status: 'ok',
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
}): void {
  const host = window as unknown as { __GANTTPILOT_MEASURE__?: unknown; __GANTTPILOT_MEASURE_DRAG__?: unknown };
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
      });
    };
  }
}

// ---------------------------------------------------------------- G5：拖动测量（记录制，ADR 0008 §11）

/** 拖动测量的宿主：由 `App.vue` 提供的实时状态与真实指针入口。 */
export interface DragMeasurementHost {
  /** 当前渲染的视图模型（含 `scrollTop` / `pxPerDay` / 行序），用于把任务换算成屏幕坐标。 */
  readonly view: () => ViewModel | null;
  readonly calendar: () => { dayOfOrdinal(ordinal: number): number };
  /** 真实指针入口（**与用户操作走同一条路径**）。 */
  readonly pointer: {
    readonly down: (event: MouseEvent) => void;
    readonly move: (event: MouseEvent) => void;
    readonly up: (event: MouseEvent) => void;
  };
  /** 拖动是否仍在进行（用于断言"松手后锚点已清空"）。 */
  readonly gestureKind: () => string;
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
  readonly observedWidthChanges: number;
  readonly anchorsAfterRelease: number;
  readonly documentStartAfter: string | null;
}

/** 把任务换算成"按住条体中部"的屏幕坐标（内容坐标 + 窗格偏移）。 */
function dragScreenPoint(
  host: DragMeasurementHost,
  pane: HTMLElement,
  taskId: string,
  ordinalOffset: number,
): { readonly clientX: number; readonly clientY: number } | null {
  const view = host.view();
  if (view === null) return null;
  const row = view.rows.find((item) => item.id === taskId);
  if (row === undefined) return null;
  const calendar = host.calendar();
  const targetDay = calendar.dayOfOrdinal(row.es + ordinalOffset);
  const contentX = (targetDay - view.axisOriginDay) * view.pxPerDay + view.pxPerDay / 2;
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
 * - **松手耗时** = `mouseup` → 命令落库 + `compute` + 覆盖层清空 的墙钟。
 */
export async function runDragMeasurement(args: {
  readonly host: DragMeasurementHost;
  readonly fixtureSpec: FixtureSpec;
  readonly dayDelta: number;
  readonly frames: number;
}): Promise<DragMeasureResult> {
  const errors: string[] = [];
  const pane = document.getElementById('chart-pane');
  if (pane === null) {
    return emptyDragResult(args, ['找不到图表窗格（#chart-pane）']);
  }

  const target = pickDragTarget(args.host);
  if (target === null) {
    return emptyDragResult(args, ['渲染窗口内没有可拖动的叶子任务']);
  }

  const start = dragScreenPoint(args.host, pane, target.taskId, 0);
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
  let observedWidthChanges = 0;
  let previousWidths = collectBarWidths();

  dispatch('down', start);
  await nextTick();
  if (args.host.gestureKind() !== 'dragging') {
    errors.push(`按下后未进入拖动（实际 ${args.host.gestureKind()}）`);
  }

  let lastFrameAt = performance.now();
  const frames = args.frames;
  for (let index = 1; index <= frames; index += 1) {
    const offset = Math.round((args.dayDelta * index) / frames);
    const point = dragScreenPoint(args.host, pane, target.taskId, offset) ?? start;
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

    // "下游跟随"的间接证据：拖动期条宽/位置变化过（而不是只有覆盖层在动）。
    const widths = collectBarWidths();
    if (widths !== previousWidths) observedWidthChanges += 1;
    previousWidths = widths;
  }

  const releaseStart = performance.now();
  const endPoint = dragScreenPoint(args.host, pane, target.taskId, args.dayDelta) ?? start;
  dispatch('up', endPoint);
  await nextTick();
  const releaseMs = round(performance.now() - releaseStart);

  let longTasks = 0;
  if (typeof PerformanceObserver !== 'undefined') {
    // 记录制：只统计拖动期间已经产生的 longtask 条目（观察者本身不阻塞）。
    try {
      const entries = performance.getEntriesByType('longtask');
      longTasks = entries.length;
    } catch {
      longTasks = 0;
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
    observedWidthChanges,
    anchorsAfterRelease: args.host.anchors(),
    documentStartAfter: args.host.startDateOf(target.taskId),
  };
}

function pickDragTarget(host: DragMeasurementHost): { readonly taskId: string } | null {
  const view = host.view();
  if (view === null) return null;
  // 取第一个"可见行内、非里程碑、非汇总"的行（渲染窗口内的行才可交互）。
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const bounded = view.rows.find((item) => item.row === row);
    if (bounded === undefined) continue;
    if (bounded.isMilestone || bounded.kind === 'summary') continue;
    return { taskId: bounded.id };
  }
  return null;
}

/** 当前 DOM 上全部条形的宽度串（用于判断"渲染侧真的更新了"）。 */
function collectBarWidths(): string {
  const rects = document.querySelectorAll('#chart-pane .rows rect, #chart-pane .rows polygon');
  const parts: string[] = [];
  rects.forEach((node) => {
    parts.push(node.getAttribute('width') ?? node.getAttribute('points') ?? '');
  });
  return parts.join('|');
}

function emptyDragResult(
  args: { readonly fixtureSpec: FixtureSpec; readonly dayDelta: number; readonly frames: number },
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
    observedWidthChanges: 0,
    anchorsAfterRelease: 0,
    documentStartAfter: null,
  };
}

/** 供 CDP 侧核对：本测量钩子的版本标记（避免与旧产物混淆）。 */
export const MEASURE_HOOK_VERSION = 'g5-1';
