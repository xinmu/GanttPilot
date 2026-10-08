/**
 * **记录制测量宿主**（P3/C6-f 从 `App.vue` 迁出；原文约 250 行挤在 `onMounted` 里）。
 *
 * ## 为什么它是**独立模块**、而不是 `src/measure/` 的一分子
 *
 * `src/measure/` 是**测量协议**（零几何常量、零业务逻辑：钩子名、夹具规格、读数）；
 * 本文件是**应用侧接线**——它必须抓住应用的真实入口（`useGesture` 的指针路径、
 * `useChart` 的档位、`usePersistence` 的收口函数、`useProject` 的换会话）。
 * 两者混在一起，协议层就会被应用状态污染，"测量测的是产品行为"这条也就无从守起。
 *
 * ## 为什么它仍然在懒 chunk 里
 *
 * `App.vue` 用 `await import('./measureHost.js')` 加载本模块（**不是**静态 import），
 * 而本模块才 static import `./measure/index.js` ⇒ 整条测量链（含 34.7 KB 的协议代码）
 * 都只挂在这次动态 import 之下，**普通首屏主 chunk 不含它**（ADR 0006 §11 的分包纪律）。
 *
 * ## 四条纪律（迁移时一字未改）
 *
 * 1. **不另开测试后门**：读数口一律调用产品路径上的同一个函数
 *    （`updateHover` / `linkEntryFor` / `pointerFromClientPoint` / `chart.setZoom` / `flushNow`），
 *    否则测的是一条平行公式；
 * 2. **`loadDocument` 等"恢复已结算"**（N11，P3/C6-b）：夹具必须是**最后一个写入者**，
 *    理由见下面那段注释；
 * 3. `applyView` 的 `awaitFrame = false` 只等 Vue 的 DOM 更新 ⇒ 量到的是"主线程上的同步工作量"；
 * 4. `?measure=` 才加载（门在 `App.vue`），因此这里可以假定"用户就是测量脚本"。
 */

import { nextTick, type ComputedRef, type Ref } from 'vue';
import {
  generateDocument,
  reindexDocument,
  type ProjectDocument,
  type Schedule,
  type SessionAnchor,
  type ViewModel,
  type ZoomKey,
} from '@ganttpilot/render-core';
import type { Calendar } from '@ganttpilot/engine';

import { exposeMeasurement, specOfDataset } from './measure/index.js';
import type { UseChartPointer } from './composables/useChartPointer.js';
import type { UseGesture } from './composables/useGesture.js';
import type { UseHover } from './composables/useHover.js';
import type { UsePersistence } from './composables/usePersistence.js';

/** 测量宿主需要抓住的**应用侧入口**（每一项都是产品路径上的同一个函数）。 */
export interface MeasurementHostDeps {
  readonly view: ComputedRef<ViewModel | null>;
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  /** `compute` **交出的**日历（几何一律用它）。 */
  readonly renderCalendar: ComputedRef<Calendar>;
  /** 已提交修订号（命令/事务才前进；P-45 的"预览不落库"判据读它）。 */
  readonly revision: ComputedRef<number>;
  readonly zoom: Ref<ZoomKey>;
  readonly anchors: Ref<readonly SessionAnchor[]>;
  readonly paneRef: Ref<HTMLElement | null>;
  readonly gesture: UseGesture;
  readonly pointer: UseChartPointer;
  readonly hover: UseHover;
  readonly persistence: UsePersistence;
  /** `?persist=0` / `localStorage['ganttpilot:persist']='0'`（测量旁路）。 */
  readonly persistenceEnabled: boolean;
  /** 档位切换（与工具栏同一个入口：`chart.setZoom`）。 */
  readonly setZoom: (next: ZoomKey) => void;
  /** 换掉整份会话（夹具装载；`useProject.reset`）。 */
  readonly reset: (next: ProjectDocument) => void;
  readonly notify: (level: 'info' | 'error', text: string) => void;
}

/**
 * 装载测量钩子，并把 `window.__GANTTPILOT_READY__` 置位（记录制入口在等它）。
 *
 * 调用方负责 `try` / `catch`（加载失败要报给用户看），本函数不在内部吞错——
 * 那样 `App.vue` 的报错文案就只能写"测量钩子加载失败"而拿不到原因。
 */
export function installMeasurementHost(deps: MeasurementHostDeps): void {
  const { view, document, schedule, renderCalendar, revision, zoom, paneRef, gesture, pointer, hover } =
    deps;
  const { updateHover, clearHover } = hover;

  /**
   * **记录制专用的"强制收口"入口**：不等去抖窗口就把当前状态写下去。
   *
   * 与产品路径同一个函数（`persistence.flushNow`：松手 / 文档隐藏 / `pagehide` 都走它），
   * 因此"重启恢复"这条对照测的是产品行为；只是由测量脚本显式触发，免得依赖定时器时机。
   */
  (window as unknown as { __GANTTPILOT_MEASURE_PERSIST_FLUSH__?: () => Promise<boolean> })
    .__GANTTPILOT_MEASURE_PERSIST_FLUSH__ = () => deps.persistence.flushNow();

  // G5：拖动测量的宿主——**走真实指针入口**（`useGesture`），不另开测试后门。
  const dragHost = {
    view: () => view.value,
    document: () => document.value,
    schedule: () => schedule.value,
    calendar: () => renderCalendar.value,
    pointer: {
      down: (event: MouseEvent) => {
        const current = pointer.pointerFrom(event);
        if (current === null) return;
        const entry = pointer.linkEntryOf(current);
        gesture.onPointerDown(entry === null ? { pointer: current } : { pointer: current, entryPoint: entry });
      },
      move: (event: MouseEvent) => {
        const current = pointer.pointerFrom(event);
        if (current !== null) gesture.onPointerMove(current);
      },
      up: (event: MouseEvent) => {
        const current = pointer.pointerFrom(event);
        if (current !== null) gesture.onPointerUp({ ...current, buttons: 0 });
      },
    },
    gestureKind: () => gesture.state.value.kind,
    /** 建线入口的判定（**与用户操作同一条路**：linkEntryFor 的纯函数）。 */
    entryPointOf: (clientX: number, clientY: number) => {
      const current = pointer.pointerFromClientPoint(clientX, clientY, 1);
      return current === null ? null : pointer.linkEntryOf(current);
    },
    /** 把"指针在某屏幕点"交给应用（触发连接点的显形判定；记录制先 hover 再读 DOM）。 */
    hoverAt: (clientX: number, clientY: number) => {
      const current = pointer.pointerFromClientPoint(clientX, clientY, 1);
      if (current !== null) updateHover(current);
    },
    clearHover: () => {
      clearHover();
    },
    /** 光标提示的分类（记录制用它核对"手柄/连接点/判定区"的光标真的不同）。 */
    cursorAt: (clientX: number, clientY: number) => pointer.cursorAt(clientX, clientY),
    anchors: () => deps.anchors.value.length,
    startDateOf: (taskId: string) =>
      document.value.tasks.find((task) => task.id === taskId)?.startDate ?? null,
    /** P-45：`resize-duration` 轮的位移基准（工期，不是 `startDate`）。 */
    durationOf: (taskId: string) =>
      document.value.tasks.find((task) => task.id === taskId)?.durationDays ?? null,
    /**
     * P-45 的"预览不落库"判据：**已提交**修订号（命令/事务才前进）。
     *
     * 读 `session.revision` 而不是"文档对象是否变了"——副本每帧都是新对象，
     * 而修订号只有真的落库才动（ADR 0003）。两者一个说"喂给 compute 的是什么"，
     * 一个说"文档事实是什么"，判据要的正是这个区分。
     */
    revision: () => revision.value,
    /** P-45：自证抓取点真的被判成了 `resize-duration`（否则探针会退化成整体移动）。 */
    gestureMode: () => (gesture.state.value.kind === 'dragging' ? gesture.state.value.mode : null),
  };

  // G5 批次 D：两栏行对齐的**只读**采数入口（判读在 `render-core` 的 `diagnoseRowAlignment`）。
  // `pointerFromClientOf` 走**用户操作的同一个换算**（`pointer.pointerFromClientPoint`）——
  // "所见 = 所点"判据因此不是一条平行公式（ADR 0007 §14）。
  const alignHost = {
    view: () => view.value,
    pane: () => paneRef.value,
    pointerFromClientOf: (clientX: number, clientY: number) =>
      pointer.pointerFromClientPoint(clientX, clientY, 1),
    /**
     * P-40 批次②：`--align` 必须能覆盖周/月档，而档位住在页面状态里 ⇒
     * 记录制走**用户点工具栏的同一个** `chart.setZoom`（工具栏的 `onZoom` 也走它），不另开测试后门。
     */
    setZoom: (next: ZoomKey) => {
      deps.setZoom(next);
    },
  };

  /**
   * **两级刻度与悬停行带**的读数入口（P-46；原文写 "G8 读数入口"——能力块代号不是功能语义，P3/C6-c）。
   *
   * 两条口径（与既有记录制一致）：
   * - `hoverRowAt` 走 `updateHover`（**用户 `mousemove` 的同一个函数**），不另开后门——
   *   否则"悬停高亮"测的是一条平行公式；
   * - `setZoom` 复用 `alignHost` 的同一个 `chart.setZoom`（档位住在页面状态里）。
   */
  const axisHoverHost = {
    view: () => view.value,
    zoom: () => zoom.value,
    revision: () => revision.value,
    setZoom: (next: ZoomKey) => {
      deps.setZoom(next);
    },
    hoverRowAt: (rowIndex: number) => {
      const current = view.value;
      const pane = paneRef.value;
      if (current === null || pane === null) return;
      const row = current.rows[rowIndex];
      if (row === undefined) return;
      const rect = pane.getBoundingClientRect();
      const contentX = Math.max(0, row.xLeft + current.pxPerDay / 2);
      const contentY = row.row * current.rowHeight + current.rowHeight / 2;
      const currentPointer = pointer.pointerFromClientPoint(
        rect.left + contentX - current.scrollLeft,
        rect.top + contentY - current.scrollTop,
        1,
      );
      if (currentPointer !== null) updateHover(currentPointer);
    },
    clearHover: () => {
      clearHover();
    },
  };

  exposeMeasurement({
    // G6：测量用的夹具解析必须与 `measure/` 的 `specOfDataset` 同源——
    // 否则 `dense-2000`（2,000 任务）会静默退回主口径（**出口条件④就测错规模了**）。
    buildFixtureDocument: (key) => {
      const spec = specOfDataset(key);
      // 由 spec 现场产文档：**规模口径**的键表只由 `specOfDataset` 认识（含 `dense-2000`）；
      // 页面初始的**演示口径**文档（`demoPlan.ts`，P-34）是另一回事，不能拿来当 2,000 任务用。
      return reindexDocument(generateDocument(spec).document);
    },
    loadDocument: async (nextDocument) => {
      /**
       * **N11 的修法（P3/C6-b）**：夹具必须是**最后一个写入者**。
       *
       * 初始会话恢复是**异步**的（IndexedDB），而它会 `project.restore(...)` 整份换会话。
       * 若那次恢复在夹具之后落地，页面就回到**上一次持久化的那份文档**——测量方的模型与
       * 页面上的 DOM 于是是两份文档（实测报文：`DOM 行/边 = 15/14`（演示计划）vs
       * `模型 = 31/41`（夹具））。**为什么同一轮里必然存在这个风险**：IndexedDB 按
       * **origin** 隔离，而同一轮测量里多次导航共用同一个 origin ⇒ **第一次导航**
       * （演示计划）写下的"全新会话基线"会被**第二次导航**恢复回来。
       *
       * 因此这里等"恢复已结算"再装夹具——`await` 发生在 `runMeasurement` 的计时起点
       * **之前**，所以**不动任何口径**（`primaryMs` 仍是"装好夹具 → 含依赖线首帧"）。
       */
      await deps.persistence.restoreSettled;
      deps.reset(nextDocument);
      await nextTick();
    },
    controllerOf: (nextDocument) => ({
      document: nextDocument,
      /**
       * 把 `ViewModel` 交给**真实渲染路径**。
       *
       * `awaitFrame = false` 时只等 Vue 的 DOM 更新（`nextTick`）——
       * 这样测量方能量到"主线程上的同步工作量"；帧等待由测量方显式施加，
       * **不混进"每帧耗时"**（否则双 rAF 的约 33 ms 会被算成工作量）。
       */
      applyView: async (_next, nextScrollTop, awaitFrame = false) => {
        const pane = paneRef.value;
        if (pane !== null) pane.scrollTop = nextScrollTop;
        await nextTick();
        if (awaitFrame) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
        }
      },
    }),
    drag: dragHost,
    // G6：持久化测量（记录制）。`drag` **复用同一个宿主**——同一条真实指针路径，
    // 因此"拖拽期间不产生可见掉帧"测的是产品行为，不是平行公式。
    persist: {
      enabled: () => deps.persistenceEnabled,
      ready: () => deps.persistence.ready.value,
      flush: () => deps.persistence.flushNow(),
      writeRecord: () => deps.persistence.writeRecordNow(),
      rebase: () => deps.persistence.rebaseNow(),
      probe: () => deps.persistence.probe.value,
      drag: dragHost,
    },
    // 两级刻度与悬停行带（P-46）。判据走 `smoke:build`（门禁）+ 记录制（打包产物）。
    axisHover: axisHoverHost,
    align: alignHost,
  });
  window.__GANTTPILOT_READY__ = true;
}
