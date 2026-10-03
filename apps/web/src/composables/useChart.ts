/**
 * 视口与几何接线：`文档 + Schedule + Calendar + 视口 → ViewModel`（ADR 0007 §2/§4/§6）。
 *
 * ## 滚动模型（唯一坐标口径）
 *
 * 图表窗格是**原生滚动容器**：内层 spacer 撑出 `rowCount × ROW_HEIGHT` 的高度，
 * SVG 用 `translate(scrollLeft, scrollTop)` **钉在窗格可视区**。
 * 于是：
 * - 滚动条长度天然正确（内容高 = 渲染行数 × 行高）；
 * - `ViewModel` 的 `scrollTop` / `scrollLeft` 就是窗格的真实滚动位置；
 * - `dayAtX` / `ordinalAtX` 的坐标自洽：SVG 的 x 轴保持"内容坐标系"，
 *   屏幕 x = SVG x − `scrollLeft` ⇒ 事件在 SVG 内取 `offsetX` 后无需再修正滚动偏移。
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
  ROW_BUFFER,
  ROW_HEIGHT,
  zoomPxPerDay,
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
  readonly paneHeight: Ref<number>;
  readonly viewport: ComputedRef<Viewport>;
  readonly view: ComputedRef<ViewModel | null>;
  /** 渲染窗口占用的内容宽度（spacer 宽度）。 */
  readonly contentWidth: ComputedRef<number>;
  readonly contentHeight: ComputedRef<number>;
  /** 最近一次编辑的受影响行/边（ADR 0007 §8 的"不整表重建"通道）。 */
  readonly affected: Ref<{ readonly rows: readonly number[]; readonly edges: readonly number[] } | null>;
  setZoom: (next: ZoomKey) => void;
  handleScroll: () => void;
  /** 标记一次编辑：计算受影响子图（纯函数），供重绘通道使用。 */
  markEdited: (taskIds: readonly string[]) => void;
}

export function useChart(args: {
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  readonly calendar: ComputedRef<Calendar>;
  readonly initialZoom?: ZoomKey;
}): UseChart {
  const paneRef = ref<HTMLElement | null>(null);
  const zoom = ref<ZoomKey>(args.initialZoom ?? 'day');
  const scrollTop = ref(0);
  const scrollLeft = ref(0);
  const paneWidth = ref(1280);
  const paneHeight = ref(640);
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
      calendar: args.calendar.value,
      viewport: viewport.value,
      zoom: zoom.value,
      clipMode: 'intersect',
    });
  });

  const contentWidth = computed(() => {
    const vm = view.value;
    if (vm === null) return paneWidth.value;
    const lastRowBottom = vm.rowCount * vm.rowHeight;
    // 内容宽度：轴线起点之前留出 gutter（SS/SF 的回绕走廊），之后按可见天数铺开。
    const days = Math.max(60, vm.width / vm.pxPerDay + 32);
    return lastRowBottom > 0 ? Math.ceil(days * vm.pxPerDay) + 32 : paneWidth.value;
  });

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
    viewport,
    view,
    contentWidth,
    contentHeight,
    affected,
    setZoom,
    handleScroll,
    markEdited,
  };
}

/** 档位对应的 `pxPerDay`（界面显示与调试用）。 */
export function pxPerDayOf(zoom: ZoomKey): number {
  return zoomPxPerDay(zoom);
}
