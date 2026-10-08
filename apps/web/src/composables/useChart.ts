/**
 * 视口与几何接线：`文档 + Schedule + Calendar + 视口 → ViewModel`（ADR 0007 §2/§4/§6/§14）。
 *
 * ## 两栏布局与滚动模型（唯一坐标口径）
 *
 * 图表列 = **表头带**（`HEADER_HEIGHT_PX`，与左表表头同高）+ **原生滚动容器**（绘制区）；
 * 左表 = 同高的表头 + 表体。两栏因此共享同一条行屏幕几何（ADR 0007 §14）：
 *
 * ```
 * 行屏幕 y = 列顶 + HEADER_HEIGHT_PX + row × ROW_HEIGHT − scrollTop
 * ```
 *
 * - **SVG 是滚动容器的兄弟，不是它的子元素**：`<svg>` 若作为滚动容器的 abspos 子元素，
 *   会**随内容滚动**（abspos 子元素定位在内容原点），再叠加内层
 *   `translate(−scrollLeft, −scrollTop)` 就是**双重偏移**——图形区滚动比左表快一倍、下方留白、
 *   轴元素移出绘制区（P-21 第 5/14.2 项；P-23 诊断实测 = 机制③）；
 * - **`paneHeight` = 绘制区高**（滚动容器 `clientHeight`，已扣表头带与滚动条），行窗口与轴高都用它；
 *   **`columnHeight` = 整列外高**（= 表头带 + 绘制区），左表用它定高，否则两栏底边会差一个表头；
 * - 滚动条长度天然正确（内容高 = 渲染行数 × 行高）；
 * - `ViewModel` 的 `scrollTop` / `scrollLeft` 就是窗格的真实滚动位置；
 * - `dayAtX` / `ordinalAtX` 的坐标自洽：内层 `<g>` 抵消滚动后，SVG 的 y 轴就是"内容坐标系"，
 *   屏幕坐标 = 内容坐标 − `scroll*`（`pointerFromClient` 的唯一口径，ADR 0008 §13）。
 *
 * ## 响应式口径（T-1）
 *
 * 文档是 `shallowRef` + `markRaw`；几何只对**渲染窗口 + 受影响子图**（`affectedRenderSet`）
 * 做计算。折叠/展开会改变可见行集合，因此允许重算窗口；**行内编辑不得整表重建**。
 */

import { computed, onMounted, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import {
  affectedRenderSet,
  buildView,
  HEADER_HEIGHT_PX,
  ROW_BUFFER,
  ROW_HEIGHT,
  type ProjectDocument,
  type Schedule,
  type ViewModel,
  type Viewport,
  type ZoomKey,
} from '@ganttpilot/render-core';
import type { Calendar } from '@ganttpilot/engine';

/** 图表的全部状态与操作。 */
export interface UseChart {
  /** 图表窗格元素（模板 `ref`）。 */
  readonly paneRef: Ref<HTMLElement | null>;
  readonly zoom: Ref<ZoomKey>;
  readonly scrollTop: Ref<number>;
  readonly scrollLeft: Ref<number>;
  readonly paneWidth: Ref<number>;
  /** **绘制区高**（滚动容器 `clientHeight`；已扣表头带与滚动条）。 */
  readonly paneHeight: Ref<number>;
  /** **整列外高** = `paneHeight + HEADER_HEIGHT_PX`（左表用它定高，两栏底边才对得上）。 */
  readonly columnHeight: ComputedRef<number>;
  readonly viewport: ComputedRef<Viewport>;
  readonly view: ComputedRef<ViewModel | null>;
  /** 渲染窗口占用的内容宽度（spacer 宽度）。 */
  readonly contentWidth: ComputedRef<number>;
  readonly contentHeight: ComputedRef<number>;
  /** 最近一次编辑的受影响行/边（ADR 0007 §8 的"不整表重建"通道）。 */
  readonly affected: Ref<{ readonly rows: readonly number[]; readonly edges: readonly number[] } | null>;
  /** 指针所在的**可见行序号**（P-46 §2.2 的悬停行带；`null` = 不高亮）。 */
  readonly hoverRow: Ref<number | null>;
  setZoom: (next: ZoomKey) => void;
  handleScroll: () => void;
  /** 标记一次编辑：计算受影响子图（纯函数），供重绘通道使用。 */
  markEdited: (taskIds: readonly string[]) => void;
}

export function useChart(args: {
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  /** `compute` 的**入参**日历（`createScheduleCalendar(已提交文档)`）。 */
  readonly calendar: ComputedRef<Calendar>;
  /**
   * `compute` **交出的**日历（ADR 0005 附录 §1／裁决 P-48）：几何一律用它。
   *
   * 入参与结果必须分开传（而不是在内部二选一）：`ordinalAtX` 这类纯函数的公开签名收的是
   * "能把序号翻译成日期的日历"，而拖动预览喂的文档与入参日历容量可能分叉——把选择写死在
   * 调用方，才不会有第二个口径。
   */
  readonly renderCalendar: ComputedRef<Calendar>;
  readonly initialZoom?: ZoomKey;
}): UseChart {
  const paneRef = ref<HTMLElement | null>(null);
  const zoom = ref<ZoomKey>(args.initialZoom ?? 'day');
  const scrollTop = ref(0);
  const scrollLeft = ref(0);
  const paneWidth = ref(1280);
  const paneHeight = ref(640);
  /** 指针所在的**可见行序号**（P-46 的悬停行带；`null` = 不高亮）。 */
  const hoverRow = ref<number | null>(null);
  const affected = shallowRef<{ rows: readonly number[]; edges: readonly number[] } | null>(null);

  const viewport = computed<Viewport>(() => ({
    scrollTop: scrollTop.value,
    scrollLeft: scrollLeft.value,
    width: paneWidth.value,
    height: paneHeight.value,
    // 固定行高（虚拟化的前提，ADR 0007 §4）；缓冲行来自 §11 的冻结常数。
    rowHeight: ROW_HEIGHT,
    rowBuffer: ROW_BUFFER,
  }));

  const view = computed<ViewModel | null>(() => {
    const schedule = args.schedule.value;
    if (schedule === null) return null;
    return buildView({
      document: args.document.value,
      schedule,
      // **几何用 `compute` 交出的那份日历**（P-48）：拖动预览喂的是另一份文档，
      // 用入参日历翻译它的完成序号会抛 `RangeError` ⇒ Vue 卸载整棵树 ⇒ 整页空白。
      calendar: args.renderCalendar.value,
      viewport: viewport.value,
      zoom: zoom.value,
      clipMode: 'intersect',
      // 悬停行带（P-46 §2.2）：交互态只影响 `view.axis` 里那 1 个覆盖层元素。
      hoverRow: hoverRow.value,
    });
  });

  const columnHeight = computed(() => paneHeight.value + HEADER_HEIGHT_PX);

  /**
   * 内容宽度 = 滚动范围（spacer 宽）。
   *
   * **真相源在 `render-core`**（`ViewModel.contentWidth`，ADR 0007 §15 / 裁决 P-24）：
   * 它由文档的日期范围（`Schedule.projectFinish`）推出，不是"按窗格宽 + 若干天"外推——
   * 后者会让大项目只能向右滚开头几十天（P-24 实测：1,000 任务夹具只给到约 61 天）。
   */
  const contentWidth = computed(() => view.value?.contentWidth ?? paneWidth.value);

  const contentHeight = computed(() => {
    const vm = view.value;
    if (vm === null) return paneHeight.value;
    return Math.max(vm.rowCount * vm.rowHeight, paneHeight.value);
  });

  function measure(): void {
    const pane = paneRef.value;
    if (pane === null) return;
    paneWidth.value = pane.clientWidth;
    paneHeight.value = pane.clientHeight;
    scrollTop.value = pane.scrollTop;
    scrollLeft.value = pane.scrollLeft;
  }

  function handleScroll(): void {
    const pane = paneRef.value;
    if (pane === null) return;
    scrollTop.value = pane.scrollTop;
    scrollLeft.value = pane.scrollLeft;
  }

  function setZoom(next: ZoomKey): void {
    zoom.value = next;
  }

  function markEdited(taskIds: readonly string[]): void {
    if (taskIds.length === 0) {
      affected.value = null;
      return;
    }
    const result = affectedRenderSet(args.document.value, taskIds);
    affected.value = { rows: result.rows, edges: result.edges };
  }

  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== 'undefined' && paneRef.value !== null) {
      const observer = new ResizeObserver(() => measure());
      observer.observe(paneRef.value);
    }
  });

  // 文档变化后重新测量（任务数变化会改变滚动范围）。
  watch(() => args.document.value, () => measure());

  return {
    paneRef,
    zoom,
    scrollTop,
    scrollLeft,
    paneWidth,
    paneHeight,
    columnHeight,
    viewport,
    view,
    contentWidth,
    contentHeight,
    affected,
    hoverRow,
    setZoom,
    handleScroll,
    markEdited,
  };
}
