/**
 * **指针接线**（P3/C6-f 从 `App.vue` 迁出）：屏幕坐标 → 归一化指针（内容坐标），
 * 以及图表窗格上的**全部指针事件**（按下 / 移动 / 松手 / 光标提示 / 指针捕获）。
 *
 * ## 只有一条换算路（ADR 0008 §13）
 *
 * `pointerFromClientPoint` 是"屏幕 → 内容"的唯一实现，它把窗格的 `getBoundingClientRect()`
 * 与滚动位置喂给 `render-core` 的纯函数 `pointerFromClient`。
 * **绝不用 `event.offsetX/offsetY`**：它们**相对事件目标元素**，`mousedown` 落在条体 `<rect>` 上时
 * 会被当成内容坐标（P-21 §2 的 R1：按下即跳位、条体外点击改日期）。
 *
 * **测量钩子与用户操作共用本函数**（`measureHost` 的 `pointerFromClientOf` / `pointerFrom` 同源）：
 * `--align` 的"所见 = 所点"判据必须走同一条换算，否则它证明的只是一条平行的公式。
 *
 * ## 手势期的 window 兜底
 *
 * 拖动期行的 `<g>` 会因为"指针所在行"改变（连接点按需显形）被 Vue 重建，
 * 绑在窗格路径上的派发可能随之中断 ⇒ `mousemove` / `mouseup` **同时**挂在 window 上。
 * 本模块自己在 `onMounted` / `onUnmounted` 里登记这两个监听（调用方不再手写配对）。
 */

import { onMounted, onUnmounted, type ComputedRef, type Ref } from 'vue';
import {
  cursorForPointer,
  linkEntryFor,
  pointerFromClient,
  type CursorHint,
  type PointerInput,
  type ProjectDocument,
  type Schedule,
  type ViewModel,
} from '@ganttpilot/render-core';
import type { Calendar } from '@ganttpilot/engine';

import type { UseGesture } from './useGesture.js';

/** 建线的起手位置（指针落在某行的连接点上时非空）。 */
export interface LinkEntry {
  readonly taskId: string;
  readonly exitSide: 'left' | 'right';
}

export interface UseChartPointerArgs {
  readonly view: ComputedRef<ViewModel | null>;
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  /** `compute` **交出的**日历（几何一律用它，见 `useChart` 的同名说明）。 */
  readonly renderCalendar: ComputedRef<Calendar>;
  /** 图表窗格元素（模板 `ref`）。 */
  readonly paneRef: Ref<HTMLElement | null>;
  readonly gesture: UseGesture;
  /** 指针位置的记录处（`useHover` 的 `updateHover`）。 */
  readonly updateHover: (pointer: PointerInput) => void;
}

export interface UseChartPointer {
  /** 屏幕坐标 → 内容坐标（**唯一实现**；`null` = 窗格或视图还没就绪）。 */
  pointerFromClientPoint: (
    clientX: number,
    clientY: number,
    buttons: number,
    modifiers?: { readonly shiftKey?: boolean },
  ) => PointerInput | null;
  /** DOM 事件 → 归一化指针（松手挂在 window 上，走**同一个**换算）。 */
  pointerFrom: (event: MouseEvent) => PointerInput | null;
  /** 建线的起手判定（纯函数 `linkEntryFor`；与用户操作同一条路）。 */
  linkEntryOf: (pointer: PointerInput) => LinkEntry | null;
  /** 某个**屏幕点**上的光标分类（记录制也读它）。 */
  cursorAt: (clientX: number, clientY: number) => CursorHint;
  /** 指针捕获（第四次人工复验的修法之二）。 */
  onPanePointerDown: (event: PointerEvent) => void;
  /** 窗格 `mousedown`：起手势。 */
  onChartPointerDown: (event: MouseEvent) => void;
  /** 窗格 `mousemove` 的**唯一入口**（模板上只能有一个 `@mousemove`）。 */
  onChartMouseMove: (event: MouseEvent) => void;
  /** 建线期推进"指针所在行"（只影响可见性，不参与命中判定）。 */
  advanceLinkHover: (event: MouseEvent) => void;
  onWindowPointerMove: (event: MouseEvent) => void;
  onWindowPointerUp: (event: MouseEvent) => void;
}

export function useChartPointer(args: UseChartPointerArgs): UseChartPointer {
  /**
   * 屏幕坐标 → **归一化指针**（内容坐标）。
   *
   * 返回 `null` = 窗格或视图还没就绪，调用方直接丢弃这次事件。
   */
  function pointerFromClientPoint(
    clientX: number,
    clientY: number,
    buttons: number,
    modifiers: { readonly shiftKey?: boolean } = {},
  ): PointerInput | null {
    const pane = args.paneRef.value;
    const current = args.view.value;
    if (pane === null || current === null) return null;
    const rect = pane.getBoundingClientRect();
    return pointerFromClient({
      clientX,
      clientY,
      paneLeft: rect.left,
      paneTop: rect.top,
      scrollLeft: current.scrollLeft,
      scrollTop: current.scrollTop,
      buttons,
      ...(modifiers.shiftKey === true ? { shiftKey: true } : {}),
    });
  }

  function pointerFrom(event: MouseEvent): PointerInput | null {
    // `Alt` **不是**手势修饰键（P-32 的复验已把它删除）：它被 Windows 的"移动窗口"占用，
    // 事件到不了页面 ⇒ 只保留 `shiftKey`（将来"约束拖动"之类会用到）。
    return pointerFromClientPoint(event.clientX, event.clientY, event.buttons, {
      ...(event.shiftKey ? { shiftKey: true } : {}),
    });
  }

  /**
   * **建线的起手位置**（ADR 0008 §16.3／裁决 P-32）：指针落在某行的**连接点**上时非空。
   *
   * 纯函数在 `render-core` 的 `linkEntryFor`（进门禁），这里只负责调用——与 `pointerFromClient`
   * 同一条纪律："入口层算出来的输入"必须落在可断言的地方（P-19/P-21 两次的教训）。
   */
  function linkEntryOf(pointer: PointerInput): LinkEntry | null {
    const current = args.view.value;
    const currentSchedule = args.schedule.value;
    if (current === null || currentSchedule === null) return null;
    const entry = linkEntryFor({
      point: pointer,
      view: current,
      document: args.document.value,
      schedule: currentSchedule,
      calendar: args.renderCalendar.value,
    });
    return entry === null ? null : { taskId: entry.taskId, exitSide: entry.exitSide };
  }

  /**
   * 光标提示（ADR 0008 §16.2 的 R3 后半）：**纯函数给枚举**，本层只做赋值。
   *
   * 顺序与 `cursorForPointer` 一致：**连接点（建线）优先**于条体上的判定区。
   */
  function cursorAt(clientX: number, clientY: number): CursorHint {
    const pointer = pointerFromClientPoint(clientX, clientY, 1);
    const current = args.view.value;
    const currentSchedule = args.schedule.value;
    if (pointer === null || current === null || currentSchedule === null) return 'default';
    if (linkEntryOf(pointer) !== null) return 'crosshair';
    return cursorForPointer({
      point: pointer,
      view: current,
      document: args.document.value,
      schedule: currentSchedule,
      calendar: args.renderCalendar.value,
    });
  }

  /**
   * 光标提示的**事件入口**。
   *
   * 为什么不留响应式状态：它是逐 `mousemove` 变化的 DOM 表现，放进 Vue 响应式会让拖拽帧预算
   * 为此付费（ADR 0008 §11 的判据）。因此这里写的是原始 DOM 元素（`HTMLElement` 之外的用法不收）。
   * 模板上**不**绑 `:style`——两处都写会互相打架。
   *
   * 只有 `idle` 时才更新（拖动/建线期间光标必须保持"正在操作"的语义，
   * 否则拖到端点区会被 `col-resize` 打断）——这个判断在 `onChartMouseMove` 里。
   */
  function refreshCursor(event: MouseEvent): void {
    const pane = args.paneRef.value;
    if (pane === null) return;
    const current = args.view.value;
    const currentSchedule = args.schedule.value;
    if (current === null || currentSchedule === null) {
      pane.style.cursor = 'default';
      return;
    }
    const pointer = pointerFromClientPoint(event.clientX, event.clientY, event.buttons);
    if (pointer === null) return;
    args.updateHover(pointer);
    pane.style.cursor = cursorAt(event.clientX, event.clientY);
  }

  /**
   * **指针捕获**（第四次人工复验的修法之二）：在 `pointerdown` 时把指针捕获到窗格上。
   *
   * 捕获之后，浏览器把**后续所有** `pointermove`/`pointerup` 都派发给该元素，
   * 与"指针下面现在是哪个元素""那些元素有没有被重建"完全无关——
   * 这正是拖动建线需要的行为（拖动期行元素会因为连接点显形/消失被 Vue 重建）。
   * 用 `try` 包住：合成事件（记录制脚本）没有真实指针，`setPointerCapture` 会抛。
   */
  function onPanePointerDown(event: PointerEvent): void {
    const pane = args.paneRef.value;
    if (pane === null || event.button !== 0) return;
    try {
      pane.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件没有可捕获的指针：忽略（拖动仍由 window 级 mousemove 兜住）。
    }
  }

  function onChartPointerDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    /**
     * **必须阻止原生行为**（第四次人工复验的修法）。
     *
     * 不阻止时 `mousedown` 会启动浏览器的**文本选择**（实测事件顺序 `mousedown → selectstart → mousemove …`），
     * 随后 `mousemove` 不再按窗格路径派发：实测"按下之后只收到 1 次移动"，
     * 表现即"能从连接点起手势、但拖不出线"（`mouseup` 同样收不到，连接预览停住不动）。
     */
    event.preventDefault();
    const pointer = pointerFrom(event);
    if (pointer === null) return;
    const entry = linkEntryOf(pointer);
    args.gesture.onPointerDown(entry === null ? { pointer } : { pointer, entryPoint: entry });
  }

  function onChartPointerMove(event: MouseEvent): void {
    if (args.gesture.state.value.kind === 'idle') return;
    const pointer = pointerFrom(event);
    if (pointer === null) return;
    args.gesture.onPointerMove(pointer);
  }

  /**
   * 建线期推进"指针所在行"（**只影响可见性**，不参与命中判定）。
   *
   * 与 `refreshCursor` 的差别只有一处：空闲时靠窗格的 `mousemove` 就够，而建线期必须**同时**在
   * window 级推进——拖动期行的 `<g>` 会因为连接点显隐被重建，窗格路径的派发可能中断。
   */
  function advanceLinkHover(event: MouseEvent): void {
    const pointer = pointerFromClientPoint(event.clientX, event.clientY, 1);
    if (pointer !== null) args.updateHover(pointer);
  }

  /**
   * 窗格 `mousemove` 的**唯一入口**（模板上只能有一个 `@mousemove`，否则 Vue 报重复属性）。
   *
   * **一条事件、两件事**（顺序不可换）：
   * 1. **光标提示**（R3 后半）：只有 `idle` 时才更新——拖动/建线期间光标必须保持"正在操作"的语义；
   * 2. **手势推进**（拖动中的候选）：`useGesture` 只在非 `idle` 时才会真正重算。
   */
  function onChartMouseMove(event: MouseEvent): void {
    const kind = args.gesture.state.value.kind;
    if (kind === 'idle') refreshCursor(event);
    else if (kind === 'linking') advanceLinkHover(event);
    onChartPointerMove(event);
  }

  function onWindowPointerMove(event: MouseEvent): void {
    const kind = args.gesture.state.value.kind;
    if (kind === 'idle') return;
    // 建线期也要推进"指针所在行"：可落点因此跟着指针走（第五次人工复验第 1 条）。
    if (kind === 'linking') advanceLinkHover(event);
    onChartPointerMove(event);
  }

  function onWindowPointerUp(event: MouseEvent): void {
    if (args.gesture.state.value.kind === 'idle') return;
    // 松手可能在图表之外（拖出窗格），因此监听挂在 window 上；坐标仍按内容坐标系换算。
    const pointer = pointerFrom(event);
    if (pointer === null) {
      args.gesture.cancel();
      return;
    }
    args.gesture.onPointerUp({ ...pointer, buttons: 0 });
  }

  onMounted(() => {
    window.addEventListener('mouseup', onWindowPointerUp);
    window.addEventListener('mousemove', onWindowPointerMove);
  });
  onUnmounted(() => {
    window.removeEventListener('mouseup', onWindowPointerUp);
    window.removeEventListener('mousemove', onWindowPointerMove);
  });

  return {
    pointerFromClientPoint,
    pointerFrom,
    linkEntryOf,
    cursorAt,
    onPanePointerDown,
    onChartPointerDown,
    onChartMouseMove,
    advanceLinkHover,
    onWindowPointerMove,
    onWindowPointerUp,
  };
}
