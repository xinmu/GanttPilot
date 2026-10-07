/**
 * 主口径：首屏（就绪 → 含依赖线首帧）与 10× 滚动。
 *
 * ADR 0007 §9 第 ⑤ 层的数字从这里出来；口径（双 rAF、`workMs` 不含帧等待）见文件头与
 * {@link runMeasurement} 的注释，**改口径等于历次首屏数字不可比**。
 */

import { compute } from '@ganttpilot/engine';
import { REFERENCE_DATASET, ROW_BUFFER, ROW_HEIGHT, THRESHOLDS, buildView, countElements, createScheduleCalendar, type FixtureSpec, type ProjectDocument, type ViewModel, type ZoomKey } from '@ganttpilot/render-core';

import { blankRowsOf, nextFrame, oneFrame, percentile, round } from './dom.js';

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

/** 测量控制器：由 `measureHost.ts` 注入（它持有文档与"把 ViewModel 画出来"的能力）。 */
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
