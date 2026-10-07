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
 * `App.vue` 用 `await import('./measure/index.js')` 动态引入，因此普通用户的首屏主 chunk
 * **不含**本模块。
 *
 * ## 模块表（P3/C6-a 的拆分）
 *
 * 本文件此前是单文件 `measure.ts`（2,625 行）。拆分**不改任何测量口径**：
 *
 * | 模块 | 职责 |
 * |---|---|
 * | `spec.ts` | 夹具口径（含 `dense-2000` 这个键的唯一认识处） |
 * | `dom.ts` | 采样原语：帧等待、稳定即止、滚动指纹、统计 |
 * | `perf.ts` | 主口径：首屏 + 10× 滚动 |
 * | `drag.ts` | 拖动族：目标挑选、抓取点、手柄/光标/连接点读数 |
 * | `g8.ts` | G8：两级刻度与悬停行带的 DOM 读数 |
 * | `align.ts` | 两栏行对齐的采数（判读在 `render-core/align`） |
 * | `persist.ts` | 持久化：开/关同尺对照与存储占用 |
 *
 * 本文件是**门面**：{@link exposeMeasurement}（把五个族的钩子挂到 `window`）+ 逐符号再导出
 * （公共面与原 `measure.ts` 相同）。
 */

import { nextTick } from 'vue';

import { PRIMARY_DATASET_KEY, ZOOM_ORDER, type ProjectDocument, type ZoomKey } from '@ganttpilot/render-core';

import { specOfDataset } from './spec.js';
import { STABLE_READ_BUDGET_FRAMES, scrollFingerprint, settleStableRead } from './dom.js';
import { runMeasurement, type MeasureController, type MeasureResult } from './perf.js';
import { runDragMeasurement, type DragMeasureResult, type DragMeasurementHost } from './drag.js';
import { readAxisFacts, readHoverFacts, type G8MeasureResult, type G8MeasurementHost } from './g8.js';
import { runAlignMeasurement, type AlignMeasureResult, type AlignMeasurementHost } from './align.js';
import { runPersistMeasurement, type PersistMeasureResult, type PersistenceMeasurementHost } from './persist.js';

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
  /** G8：两级刻度与悬停行带的读数入口（不传则 `__GANTTPILOT_MEASURE_G8__` 不存在）。 */
  readonly g8?: G8MeasurementHost;
}): void {
  const host = window as unknown as {
    __GANTTPILOT_MEASURE__?: unknown;
    __GANTTPILOT_MEASURE_DRAG__?: unknown;
    __GANTTPILOT_MEASURE_ALIGN__?: unknown;
    __GANTTPILOT_MEASURE_PERSIST__?: unknown;
    __GANTTPILOT_MEASURE_G8__?: unknown;
    __GANTTPILOT_MEASURE_G8_META__?: unknown;
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
    host.__GANTTPILOT_MEASURE_ALIGN__ = async (options: {      readonly dataset?: string;
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

  if (args.g8 !== undefined) {
    const g8Host = args.g8;
    /**
     * **G8 的只读元读数**（当前档位 + 已提交修订号）——**无副作用**，因此可以在任意时刻读。
     *
     * 为什么与下面那个"读一次两级刻度与悬停"的入口分开：下面那个会**切档位、挪指针**，
     * 而"松手真的落了库"这类判据需要的是一个**随手可读、不改动任何状态**的读数
     * （与 `--drag`/`--persist-drag` 的"预览不落库"判据同源，P-45 的口径）。
     */
    host.__GANTTPILOT_MEASURE_G8_META__ = (): { readonly zoom: string; readonly revision: number } => ({
      zoom: g8Host.zoom(),
      revision: g8Host.revision(),
    });
    /**
     * **G8 的两级刻度与悬停行带**（P-46）。
     *
     * 一次调用读三组对照：**未悬停** / 指针在第 1 个可见行 / 指针在第 3 个可见行——
     * 三条一起读才说明"高亮**跟着指针走**"（只有一个读数无法区分"跟着指针"与"画了一条固定带"）。
     * 档位可切（上级标签随档位变化是 §3 的定值），左右表表头高与"第二行留白"一并登记。
     */
    host.__GANTTPILOT_MEASURE_G8__ = async (options: {
      /** 以哪个档位读刻度（默认 `day`）。 */
      readonly zoom?: string;
    } = {}): Promise<G8MeasureResult> => {
      const requested = (options.zoom ?? 'day') as ZoomKey;
      const zoom: ZoomKey = ZOOM_ORDER.includes(requested) ? requested : 'day';
      /** 等应用把这一帧处理完（**全仓唯一**的稳定读实现；不稳定则判红，不静默用中间态）。 */
      const settle = async (): Promise<string[]> => {
        const pane = document.getElementById('chart-pane');
        if (pane === null) return ['找不到图表窗格（#chart-pane）'];
        const settled = await settleStableRead({
          fingerprint: () => {
            const current = g8Host.view();
            return scrollFingerprint(pane, {
              scrollTop: current?.scrollTop ?? -1,
              scrollLeft: current?.scrollLeft ?? -1,
              contentWidth: current?.contentWidth ?? -1,
            });
          },
        });
        return settled.stable
          ? []
          : [`读数在 ${String(STABLE_READ_BUDGET_FRAMES)} 帧内未稳定（应用未在预算内处理完）`];
      };
      const errors: string[] = [];
      if (g8Host.zoom() !== zoom) {
        g8Host.setZoom(zoom);
        errors.push(...(await settle()));
      }
      g8Host.clearHover();
      errors.push(...(await settle()));
      const idle = readHoverFacts(1);
      g8Host.hoverRowAt(1);
      errors.push(...(await settle()));
      const onRow = readHoverFacts(1);
      g8Host.hoverRowAt(3);
      errors.push(...(await settle()));
      const onThirdRow = readHoverFacts(3);
      g8Host.clearHover();
      if (errors.length > 0) {
        // 读数不稳定 ⇒ 把失败原因原样带出去（调用方判红），不在这里抛。
        (window as unknown as { __GANTTPILOT_MEASURE_G8_ERRORS__?: readonly string[] }).__GANTTPILOT_MEASURE_G8_ERRORS__ =
          errors;
      }
      return { zoom: g8Host.zoom(), revision: g8Host.revision(), axis: readAxisFacts(), hover: { idle, onRow, onThirdRow } };
    };
  }
}
// ---------------------------------------------------------------- G5：拖动测量（记录制，ADR 0008 §11）

// ---------------------------------------------------------------- 再导出（公共面 = 拆分前逐符号相同）

export { STABLE_READ_BUDGET_FRAMES, type StableReadResult } from './dom.js';
export { STORAGE_METRICS_DATASET_KEY, specOfDataset } from './spec.js';
export { runMeasurement, type MeasureController, type MeasureResult } from './perf.js';
export { runDragMeasurement, type DragMeasureResult, type DragMeasurementHost } from './drag.js';
export { type G8MeasureResult, type G8MeasurementHost, type HoverReading } from './g8.js';
export { runAlignMeasurement, type AlignMeasureResult, type AlignMeasurementHost, type AlignPositionSpec, type AlignProbeResult } from './align.js';
export { MEASURE_HOOK_VERSION, runPersistMeasurement, type PersistMeasureResult, type PersistenceMeasurementHost, type StorageMeasurement } from './persist.js';
