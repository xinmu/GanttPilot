/**
 * 手势接线（ADR 0008 §4–§10）：**把 DOM 事件归一化，其余一律交给纯内核**。
 *
 * ## 分工（本文件是唯一允许碰 DOM 的地方）
 *
 * | 层 | 职责 |
 * |---|---|
 * | `packages/render-core/src/gesture.ts` | 指针（归一化）→ 状态机 → `{anchors, commands, link}`（**纯函数、进门禁**） |
 * | 本文件 | 事件 → 归一化指针；把产出落到会话（`applyToSession` 唯一通道）；维护高亮集合 |
 * | `GanttChart.vue` | 把数字写成 SVG 属性（覆盖层） |
 *
 * ## 坐标口径
 *
 * 指针的 **x 是内容坐标**（含 `scrollLeft`）、**y 是内容坐标**（含 `scrollTop`）——
 * 与 `ViewModel.scrollTop` / `scrollLeft` 的定义一致（ADR 0007 §3）。
 * **换算已经完成**：组件的 `pointerFrom` 走 `pointerFromClient`（ADR 0008 §13），
 * 绝不用 `offsetX/offsetY`（它们相对事件目标，是 P-21 的 R1）。本文件只做转发，不做坐标算术。 */

import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import {
  beginGesture,
  affectedRenderSetWithAnchors,
  emptyHighlight,
  highlightForConflict,
  highlightForCyclePath,
  highlightForLinkEndpoints,
  highlightForTask,
  reduceGesture,
  type AnchorMode,
  type GestureState,
  type GestureUpdate,
  type HighlightSet,
  type PointerInput,
  type ProjectDocument,
  type Schedule,
  type SessionAnchor,
  type ViewModel,
} from '@ganttpilot/render-core';
import type { Calendar, DocumentLink } from '@ganttpilot/engine';

/** 一次手势提交后需要告诉调用方的东西。 */
export interface GestureCommit {
  readonly kind: 'command' | 'link' | 'rejected';
  readonly code?: string;
  readonly message?: string;
  readonly cyclePath: readonly string[];
  /** 仅 `rejected` 有值：`cycle` = 成环（已高亮路径）；`duplicate` = 该依赖已存在（不改变图）。 */
  readonly reason?: 'cycle' | 'duplicate';
}

/** `useGesture` 的入参。 */
export interface UseGestureArgs {
  readonly view: ComputedRef<ViewModel | null>;
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  /** `compute` 的**入参**日历（`createScheduleCalendar(已提交文档)`）。 */
  readonly calendar: ComputedRef<Calendar>;
  /**
   * `compute` **交出的**日历（ADR 0005 附录 §1／裁决 P-48）：手势内核一律用它。
   *
   * 为什么手势也要它：内核的入参里既有"文档"也有"日历"，而**拖动期的文档是未提交副本**
   * （`previewPatch` ⇒ `compute` 用另一份文档重算）⇒ 那份文档的 `renderCalendar` 才是
   * "这一帧的序号在哪份日历里可翻译"的答案。用已提交文档的日历会把候选夹早、并在
   * `resolveDragOutcome` 的 ISO 翻译处越界（那两个函数都是有 `try` 的安全层，于是缺陷会
   * 表现为"拖不动"而不是报错——更难查）。
   */
  readonly renderCalendar: ComputedRef<Calendar>;
  /** 落库（命令层唯一通道）。 */
  readonly dispatch: (command: {
    readonly kind: 'task.update';
    readonly id: string;
    readonly patch: Record<string, unknown>;
  }) => { readonly ok: boolean; readonly changed: boolean; readonly code?: string; readonly message?: string };
  readonly dispatchLink: (link: DocumentLink) => {
    readonly ok: boolean;
    readonly changed: boolean;
    readonly code?: string;
    readonly message?: string;
  };
  readonly setAnchors: (anchors: readonly SessionAnchor[]) => void;
  readonly clearAnchors: () => void;
  /**
   * **拖动期的未提交文档副本**（裁决 P-45）：把本帧 `dragOutcome.patch` 交给会话。
   *
   * 为什么由本文件转手而不是组件：`patch` 的唯一来源是内核的 `GestureUpdate.dragOutcome`，
   * 而"哪一帧该有预览、哪一帧该清"就是手势状态机的事（`dragging` 有、其余没有）。
   * 传 `null` = 清预览（`useProject` 侧任何真实落库也会把它清掉）。
   */
  readonly setPreviewPatch: (next: { readonly taskId: string; readonly patch: Record<string, unknown> } | null) => void;
  /** 松手（或建线）之后的提示出口。 */
  readonly notify?: (commit: GestureCommit) => void;
}

/** 手势接线暴露给组件的全部状态与操作。 */
export interface UseGesture {
  readonly state: Ref<GestureState>;
  readonly anchorMode: Ref<AnchorMode>;
  readonly highlight: Ref<HighlightSet>;
  readonly preview: Ref<GestureUpdate['preview']>;
  readonly activeTaskId: ComputedRef<string | null>;
  /** 拖动/建线期需要重绘的行与边（渲染侧最小重建，ADR 0008 §11）。 */
  readonly affectedRows: ComputedRef<{ readonly rows: readonly number[]; readonly edges: readonly number[] }>;
  setAnchorMode: (mode: AnchorMode) => void;
  /**
   * 指针按下（**内容坐标** + 原始 `buttons`）。
   *
   * `entryPoint` 非空 = 指针落在某行的**连接点**上（`interaction.ts` 的 `linkEntryFor`，
   * ADR 0008 §16.3／裁决 P-32）⇒ 建线手势的起手位置，**不需要任何修饰键**
   * （`Alt` 在 Windows 上被窗口管理器吃掉，已在 P-32 的复验里**删除**，见 P-21 的 R4）。
   */
  onPointerDown: (args: { readonly pointer: PointerInput; readonly entryPoint?: { readonly taskId: string; readonly exitSide: 'left' | 'right' } }) => void;
  onPointerMove: (pointer: PointerInput) => void;
  onPointerUp: (pointer: PointerInput) => void;
  /** 显式取消（`Esc`）。 */
  cancel: () => void;
  /** 把"外部产生的成环路径"交给高亮层（例如导入清单里点一条环）。 */
  showCyclePath: (path: readonly string[]) => void;
}

/**
 * 建手势接线。
 *
 * 关键口径（ADR 0008 §6）：**拖动期文档一字不改**——每帧只更新锚点，
 * 由 `useProject` 的 `schedule` 计算属性带着锚点重算；松手才提交命令并清锚点。
 */
export function useGesture(args: UseGestureArgs): UseGesture {
  const state = shallowRef<GestureState>({ kind: 'idle' });
  const anchorMode = ref<AnchorMode>('snap');
  const highlight = shallowRef<HighlightSet>(emptyHighlight());
  const preview = shallowRef<GestureUpdate['preview']>(null);

  const activeTaskId = computed<string | null>(() => {
    const current = state.value;
    switch (current.kind) {
      case 'dragging':
      case 'released':
        return current.taskId;
      case 'linking':
      case 'rejected':
        return current.fromTaskId;
      default:
        return null;
    }
  });

  /** 内核入参（`view` / `schedule` 缺席时手势不成立）。 */
  function baseArgs(): {
    readonly view: ViewModel;
    readonly document: ProjectDocument;
    readonly schedule: Schedule;
    readonly calendar: Calendar;
  } | null {
    const view = args.view.value;
    const schedule = args.schedule.value;
    if (view === null || schedule === null) return null;
    return { view, document: args.document.value, schedule, calendar: args.renderCalendar.value };
  }

  /** 把内核产出落到会话与高亮（唯一的"副作用"集中点）。 */
  function apply(update: GestureUpdate): void {
    state.value = update.state;
    preview.value = update.preview;

    if (update.anchors.length > 0) args.setAnchors(update.anchors);
    else if (update.state.kind === 'idle' || update.state.kind === 'released' || update.state.kind === 'rejected') {
      args.clearAnchors();
    }

    // 高亮：成环路径优先（它是"拒绝"的可见依据），其次建线预览、拖动行、冲突行。
    const document = args.document.value;
    if (update.cyclePath.length > 0) {
      highlight.value = highlightForCyclePath(document, update.cyclePath);
    } else if (update.state.kind === 'linking') {
      highlight.value = highlightForLinkEndpoints(document, update.state.fromTaskId, update.state.toTaskId);
    } else if (update.state.kind === 'dragging') {
      highlight.value = highlightForTask(document, update.state.taskId);
    } else if (update.state.kind === 'rejected') {
      highlight.value = highlightForTask(document, update.state.fromTaskId);
    } else {
      highlight.value = emptyHighlight();
    }

    // 松手提交：命令 / 建线（各至多一条 ⇒ IX-03 的"一次手势 = 一层撤销"）。
    for (const command of update.commands) {
      const result = args.dispatch(command);
      args.notify?.({
        kind: 'command',
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.message === undefined ? {} : { message: result.message }),
        cyclePath: [],
      });
    }
    if (update.link !== null) {
      const result = args.dispatchLink(update.link);
      args.notify?.({
        kind: 'link',
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.message === undefined ? {} : { message: result.message }),
        cyclePath: [],
      });
    }
    // 两种预检拒绝都要报（成环**有路径**、重复边**没有路径**，因此判据不能只看 `cyclePath.length`）。
    if (update.state.kind === 'rejected') {
      args.notify?.({ kind: 'rejected', cyclePath: update.cyclePath, reason: update.state.reason });
    }

    /**
     * **预览副本最后更新**（裁决 P-45）：落库优先。
     *
     * 顺序是有意的：松手那一帧 `update.state` 已经是 `released`，命令已在上面落地
     * （`useProject.commit` 也会清预览）⇒ 这里再清一次是幂等的，
     * 而"预览先清、命令后落"那一帧回弹因此**不可能出现**。
     * 零位移松手（没有命令）同样在这里清：图形回到与预览**相同**的几何。
     */
    if (update.state.kind === 'dragging' && update.dragOutcome !== null && update.dragOutcome.patch !== null) {
      args.setPreviewPatch({ taskId: update.state.taskId, patch: update.dragOutcome.patch });
    } else {
      args.setPreviewPatch(null);
    }
  }

  function onPointerDown(args2: {
    readonly pointer: PointerInput;
    readonly entryPoint?: { readonly taskId: string; readonly exitSide: 'left' | 'right' };
  }): void {
    const base = baseArgs();
    if (base === null || (args2.pointer.buttons & 1) === 0) return;
    apply(
      beginGesture({
        ...base,
        pointer: args2.pointer,
        anchorMode: anchorMode.value,
        ...(args2.entryPoint === undefined ? {} : { entryPoint: args2.entryPoint }),
      }),
    );
  }

  function onPointerMove(pointer: PointerInput): void {
    const base = baseArgs();
    if (base === null) return;
    if (state.value.kind === 'idle') return;
    apply(reduceGesture({ ...base, pointer, anchorMode: anchorMode.value, state: state.value }));
  }

  function onPointerUp(pointer: PointerInput): void {
    const base = baseArgs();
    if (base === null) {
      state.value = { kind: 'idle' };
      args.clearAnchors();
      return;
    }
    if (state.value.kind === 'idle') return;
    apply(reduceGesture({ ...base, pointer: { ...pointer, buttons: 0 }, anchorMode: anchorMode.value, state: state.value }));
  }

  function cancel(): void {
    state.value = { kind: 'idle' };
    preview.value = null;
    highlight.value = emptyHighlight();
    args.clearAnchors();
  }

  /**
   * 拖动期的"受影响行 + 受影响边"（ADR 0008 §11 的**渲染侧最小重建**）。
   * 松手前后共用同一判据：拖动中用锚点做种子，松手后用命令触碰的 id 做种子。
   */
  const affectedRows = computed<{ readonly rows: readonly number[]; readonly edges: readonly number[] }>(() => {
    const document = args.document.value;
    const seedIds: readonly string[] =
      state.value.kind === 'dragging'
        ? [state.value.taskId]
        : state.value.kind === 'released'
          ? [state.value.taskId]
          : state.value.kind === 'linking'
            ? state.value.toTaskId === null
              ? [state.value.fromTaskId]
              : [state.value.fromTaskId, state.value.toTaskId]
            : [];
    if (seedIds.length === 0) return { rows: [], edges: [] };
    const affected = affectedRenderSetWithAnchors(
      document,
      seedIds.map((taskId) => ({ taskId })),
    );
    return { rows: affected.rows, edges: affected.edges };
  });

  return {
    state,
    anchorMode,
    highlight,
    preview,
    activeTaskId,
    affectedRows,
    setAnchorMode: (mode: AnchorMode) => {
      anchorMode.value = mode;
    },
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancel,
    showCyclePath: (path: readonly string[]) => {
      highlight.value = path.length === 0 ? emptyHighlight() : highlightForCyclePath(args.document.value, path);
    },
  };
}

/** 把 `Schedule` 的 `anchorConflict` 诊断映射成"标红集合"（**判据来自引擎**，见 ADR 0008 §6）。 */
export function conflictHighlightOf(
  document: ProjectDocument,
  diagnostics: readonly { readonly code: string; readonly taskId?: string }[],
): HighlightSet {
  const ids = diagnostics
    .filter((item) => item.code === 'anchorConflict' && item.taskId !== undefined)
    .map((item) => item.taskId as string);
  return highlightForConflict(document, ids);
}
