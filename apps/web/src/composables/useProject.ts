/**
 * 会话与命令接线（ADR 0003 的**唯一变更通道**）。
 *
 * G4 的边界（ADR 0007 §1/§8）：
 * - **不写文档**：一切编辑经 `applyCommand` → `applyToSession`；
 * - **不做诊断 UI**：`validateDocument` / `Schedule` 的诊断只被**持有**并计数，
 *   呈现归 G5（G-8/IX-04）——G4 只保证"有日期可画、没日期不崩"；
 * - **不提供** `task.insert`/`task.remove`/`task.indent`/`task.outdent`/`task.move`/`link.*`
 *   的交互入口（G5/G6）。
 *
 * 响应式口径（T-1）：文档与任务集合用 `shallowRef` + `markRaw` 承载，
 * **只对可见窗口 + 受影响子图做响应式**——深度代理 1,000 个任务会把首屏变成响应式开销。
 *
 * 依赖口径：`compute` 是**排程的真相源**，只在 `packages/engine` 里；应用层直接依赖它
 * （而不是再由 `render-core` 转发一个同义函数）——**几何**由 `render-core` 拥有，
 * **排程**由 `engine` 拥有，两处各一个真相源。
 */

import { computed, markRaw, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import {
  applyToSession,
  createDemoPlanDocument,
  createScheduleCalendar,
  createSession,
  noticeAfterDispatch,
  previewDocumentFor,
  redoSession,
  restoreSession,
  undoSession,
  validateDocument,
  type DocumentCommand,
  type DocumentDiagnostic,
  type DocumentSession,
  type ProjectDocument,
  type Schedule,
  type ScheduleDiagnostic,
  type ScheduleResult,
  type SessionAnchor,
  type SessionStep,
  type StatusNotice,
} from '@ganttpilot/render-core';
import { compute, type Calendar } from '@ganttpilot/engine';

/** 命令派发结果（结构化，不抛错——失败码原样透出，由调用方决定怎么提示）。 */
export interface DispatchResult {
  readonly ok: boolean;
  /** `changed: false` 表示"无操作"（恒等 patch / 同位置调级），调用方应跳过撤销栈。 */
  readonly changed: boolean;
  readonly code?: string;
  readonly message?: string;
  /** 本次编辑触碰的任务 id（供"受影响行 + 受影响边"重绘用）。 */
  readonly touchedTaskIds: readonly string[];
}

/**
 * 演示文档：**演示口径**的唯一定义处是 `render-core/demoPlan.ts`（裁决 P-34）——
 * 手写的 15 行小型计划（单页可读、四类依赖齐备），**不再是** 1,000 任务的主口径夹具。
 *
 * 1,000 任务夹具（`fixtures.ts`）仍是**规模口径**：记录制测量与各包 spec 用它；
 * 页面只在 `?measure=` 下由 `measure.ts` 的 `specOfDataset` 显式装载它。
 * 两条口径的分工见 `demoPlan.ts` 头部与 [P-34](../../../docs/00-baseline/裁决R33.md)。
 */
export function createDemoDocument(): ProjectDocument {
  return createDemoPlanDocument();
}

/** 应用级项目状态：会话 + 排程 + 诊断（**不含**任何渲染几何）。 */
export interface UseProject {
  readonly document: Ref<ProjectDocument>;
  /**
   * **会话本身**（G6 的持久化需要它：`undoStack`/`redoStack`/`revision` 都是落盘内容）。
   *
   * 此前只暴露 `revision`/`canUndo`/`canRedo` 三个派生值——够 G4/G5 用，但 G6 要"把会话交出去"，
   * 因此这里如实暴露（**只读**：改会话仍然只有 `dispatch`/`undo`/`redo`/`restore`/重置 几条路）。
   */
  readonly session: ShallowRef<DocumentSession>;
  readonly revision: ComputedRef<number>;
  readonly canUndo: ComputedRef<boolean>;
  readonly canRedo: ComputedRef<boolean>;
  readonly calendar: ComputedRef<Calendar>;
  readonly scheduleResult: ComputedRef<ScheduleResult>;
  readonly schedule: ComputedRef<Schedule | null>;
  readonly scheduleError: ComputedRef<{
    readonly code: string;
    readonly message: string;
    readonly cyclePath: readonly string[];
  } | null>;
  readonly documentDiagnostics: ComputedRef<readonly DocumentDiagnostic[]>;
  readonly scheduleDiagnostics: ComputedRef<readonly ScheduleDiagnostic[]>;
  /** 最近一次命令失败的**原始记录**（`code` + `message`）；呈现见 `notice`，成功即一起清。 */
  readonly lastFailure: Ref<{ readonly code: string; readonly message: string } | null>;
  /**
   * **状态栏提示条**（`info` 呈报 / `error` 失败）。
   *
   * 它的迁移**只在本文件的 `commit()` 里发生**（`noticeAfterDispatch`，进 `pnpm gate`）——
   * 于是"成功且真的改了 ⇒ 清掉失败提示"对**每一条命令通道**都成立：行内编辑 / 折叠 /
   * **拖动与建线的松手提交**（手势自己的 `dispatch` 回调）/ 导入 / 撤销 / 重做。
   * 裁决 P-30 定的规则 + P-31 的落点修正：`apps/web` 的任何调用点都**不再自己碰它**。
   */
  readonly notice: Ref<StatusNotice | null>;
  /** 直接呈报（**非命令**消息：导入进度与结果、手势被拒绝、重置提示、测量钩子报错）。 */
  setNotice: (notice: StatusNotice | null) => void;
  /**
   * 会话内锚点（G5 的拖拽跟手位置，ADR 0004 §2 / ADR 0008 §6）。
   *
   * **不进文档、不进撤销栈、重开后不保留**：它只影响 `compute` 的入参。
   */
  readonly anchors: Ref<readonly SessionAnchor[]>;
  dispatch: (command: DocumentCommand) => DispatchResult;
  /** 拖动期设锚点（替换式：会话里最后一次拖动才是用户意图）。 */
  setAnchors: (anchors: readonly SessionAnchor[]) => void;
  clearAnchors: () => void;
  /**
   * 拖动期设**未提交文档副本**的 `patch`（裁决 P-45；`null` = 清掉预览）。
   *
   * 它承载**工期**那一半（锚点只承载位置）：拖动期喂给 `compute`，于是**下游**也所见即所提交。
   * **不进命令通道、不进撤销栈、不落盘**——任何一次真的落库（`commit` 的 `changed`）
   * 都会把它清掉（"预览不得比它描述的事实活得更久"，与 P-30 的提示口径同源）。
   * `patch` 一律取自 `GestureUpdate.dragOutcome`，应用层**不得**自己推第二份"这次拖动改了几天"。
   *
   * 单一入口（不是一对 set/clear）：少一条"忘了清"的路径。
   */
  setPreviewPatch: (next: { readonly taskId: string; readonly patch: Record<string, unknown> } | null) => void;
  ingestDocument: (document: ProjectDocument) => DispatchResult;
  undo: () => DispatchResult;
  redo: () => DispatchResult;
  /**
   * **跨会话恢复**（G6，ADR 0009 §4）：换掉整份会话——文档、两个栈与 `revision` 一起换。
   *
   * 与 `reset` 的分工：`reset` 是"新建一份会话"（栈必空）；本函数是"续上一个会话"，
   * 因此**保留**撤销/重做栈——"会话内可逐步撤销 ≥50 步"必须对"重开之后"同样成立。
   */
  restore: (restored: {
    readonly document: ProjectDocument;
    readonly undo: readonly SessionStep[];
    readonly redo: readonly SessionStep[];
    readonly revision: number;
  }) => void;
  reset: (document?: ProjectDocument) => void;
}

/**
 * 建立项目状态。
 *
 * `compute` 与 `buildView` 都是纯函数，这里只为它们准备**同一个** `createScheduleCalendar`——
 * ADR 0007 §3 要求"序号 ↔ 日期的翻译必须用同一个日历"，渲染层因此不需要自己构造日历。
 */
export function useProject(initial?: ProjectDocument): UseProject {
  const documentRef = shallowRef<ProjectDocument>(markRaw(initial ?? createDemoDocument()));
  const sessionRef = shallowRef<DocumentSession>(markRaw(createSession(documentRef.value)));
  const lastFailure = ref<{ code: string; message: string } | null>(null);
  const notice = ref<StatusNotice | null>(null);
  const anchors = shallowRef<readonly SessionAnchor[]>([]);
  const previewPatch = shallowRef<{ readonly taskId: string; readonly patch: Record<string, unknown> } | null>(null);

  /**
   * **日历只由已提交文档派生**（不由副本）：`createScheduleCalendar` 扫全表的日期与工期总和来定
   * `baseDay` / `horizonDays`（引擎侧口径），而 `baseDay` 决定**序号 ↔ 日期的映射**——
   * 让一份每帧都在变的副本参与，会把"拖动期用锚点、松手后落库"的既有语义也一起改掉
   * （拖动往左越过最早日期时，映射会当场整体平移）。副本只喂给 `compute`：
   * 它读的是**任务字段**，与日历容量无关。
   */
  const calendar = computed<Calendar>(() => markRaw(createScheduleCalendar(documentRef.value)));

  /** 拖动期的未提交副本（`null` = 没有预览）。 */
  const previewDocument = computed<ProjectDocument | null>(() => {
    const pending = previewPatch.value;
    if (pending === null) return null;
    return previewDocumentFor({
      document: documentRef.value,
      taskId: pending.taskId,
      patch: pending.patch,
    });
  });

  /** 喂给 `compute` 的文档：有预览用副本，否则用已提交文档。 */
  const effectiveDocument = computed<ProjectDocument>(() => previewDocument.value ?? documentRef.value);

  // 锚点是 `compute` 的**第三个入参**（唯一可选入参）：拖拽期间的跟手位置由此进入排程，文档一字不改。
  // 副本是**第一个入参**的替身（P-45）：它承载工期那一半，于是拖动期的**下游**也所见即所提交。
  const scheduleResult = computed<ScheduleResult>(() =>
    compute(effectiveDocument.value, calendar.value, anchors.value),
  );

  function commit(result: ReturnType<typeof applyToSession>, touchedTaskIds: readonly string[]): DispatchResult {
    const outcome: DispatchResult = result.ok
      ? { ok: true, changed: result.changed, touchedTaskIds }
      : { ok: false, changed: false, code: result.code, message: result.message, touchedTaskIds };
    /**
     * **提示条随命令通道走**（P-30 的规则 + P-31 的落点修正）。
     *
     * 放在这里而不是 `App.vue` 的 `applyCommandResult`：**所有**命令都经过本函数——行内编辑、折叠、
     * **拖动/建线的松手提交**（`useGesture` 直接调 `dispatch`）、导入、撤销、重做。
     * P-30 第一版把规则放在 `App.vue`，而拖动提交走的是手势自己的回调，于是那条路径漏掉了
     * （维护者的报文实测：拖动后"没有可撤销的步骤"仍挂着）。
     */
    notice.value = noticeAfterDispatch(notice.value, outcome);
    if (!result.ok) {
      lastFailure.value = { code: result.code, message: result.message };
      return outcome;
    }
    lastFailure.value = null;
    if (result.changed) {
      sessionRef.value = markRaw(result.session);
      documentRef.value = markRaw(result.session.document);
      /**
       * **一落库就作废预览**（P-45 的口径，与 P-30 的提示规则同源："预览不得比它描述的事实活得更久"）。
       *
       * 放在 `commit()` 里而不是手势那一侧：于是**所有**落库路径都覆盖到了
       * （拖动松手、行内编辑、导入、撤销、重做、重置）。松手那一帧的顺序也由此天然正确——
       * 命令先落地、预览后清，中间**不会**出现"锚点已清、工期还是旧的"那一帧回弹。
       */
      previewPatch.value = null;
    }
    return outcome;
  }

  function dispatch(command: DocumentCommand): DispatchResult {
    // 命令层是唯一变更通道；形状预检与 schema 复用由 `applyToSession` 内部完成。
    return commit(applyToSession(sessionRef.value, command), touchedTaskIdsOf(command));
  }

  /**
   * 恢复会话：文档、两个栈与 `revision` 一起换。
   *
   * 走引擎给出的**唯一**入口 `restoreSession`（不在应用层手搓 `DocumentSession` 字面量）。
   * 恢复之后：锚点清空（ADR 0009 §6：拖动期的临时意图不跨会话）、提示作废
   * （P-30 的口径：提示不得比它描述的事实活得更久）。
   */
  function restore(restored: {
    readonly document: ProjectDocument;
    readonly undo: readonly SessionStep[];
    readonly redo: readonly SessionStep[];
    readonly revision: number;
  }): void {
    const session = restoreSession(restored.document, restored.revision, {
      undo: restored.undo,
      redo: restored.redo,
    });
    sessionRef.value = markRaw(session);
    documentRef.value = markRaw(session.document);
    lastFailure.value = null;
    notice.value = null;
    anchors.value = [];
    previewPatch.value = null;
  }

  return {
    document: documentRef,
    session: sessionRef,
    revision: computed(() => sessionRef.value.revision),
    canUndo: computed(() => sessionRef.value.undoStack.length > 0),
    canRedo: computed(() => sessionRef.value.redoStack.length > 0),
    calendar,
    scheduleResult,
    schedule: computed<Schedule | null>(() => {
      const result = scheduleResult.value;
      return result.ok ? markRaw(result.schedule) : null;
    }),
    scheduleError: computed(() => {
      const result = scheduleResult.value;
      return result.ok ? null : { code: result.code, message: result.message, cyclePath: result.cyclePath };
    }),
    // 诊断**全量持有**（含 `info`）：呈现归 G5，G4 只做计数与占位。
    // 两个都必须是 `ComputedRef<数组>`（调用方解构后按 ref 用；见 `App.vue` 的说明）。
    documentDiagnostics: computed<readonly DocumentDiagnostic[]>(() => validateDocument(documentRef.value)),
    scheduleDiagnostics: computed<readonly ScheduleDiagnostic[]>(() => scheduleDiagnosticsOf(scheduleResult.value)),
    lastFailure,
    notice,
    setNotice: (next: StatusNotice | null) => {
      notice.value = next;
    },
    anchors,
    dispatch,
    setAnchors: (next: readonly SessionAnchor[]) => {
      anchors.value = next;
    },
    clearAnchors: () => {
      anchors.value = [];
    },
    setPreviewPatch: (next) => {
      previewPatch.value = next;
    },
    ingestDocument: (document: ProjectDocument) =>
      commit(applyToSession(sessionRef.value, { kind: 'document.replace', document }), []),
    undo: () => commit(undoSession(sessionRef.value), []),
    redo: () => commit(redoSession(sessionRef.value), []),
    restore,
    reset: (next?: ProjectDocument) => {
      const value = markRaw(next ?? createDemoDocument());
      documentRef.value = value;
      sessionRef.value = markRaw(createSession(value));
      lastFailure.value = null;
      // 整份换文档 ⇒ 旧提示讲的是**上一份文档**上的尝试，一并作废（新会话的栈本来就是空的）。
      notice.value = null;
      // 锚点不属于文档：重置时一并清空，避免"锚在一个已经不存在的任务上"。
      anchors.value = [];
      previewPatch.value = null;
    },
  };
}

/**
 * 从排程结果里取诊断。
 *
 * **两路字段不同**（`packages/engine/SCHEDULE.md` §三）：成功时诊断挂在 `schedule` 上，
 * 失败时（只有一条 `cycle`）挂在结果本身。写成显式判别而不是直接取属性——
 * `ScheduleSuccess` 上根本没有 `diagnostics` 这个字段。
 */
function scheduleDiagnosticsOf(result: ScheduleResult): readonly ScheduleDiagnostic[] {
  return result.ok ? result.schedule.diagnostics : result.diagnostics;
}

/** 命令触碰的任务 id（"受影响行 + 受影响边"的种子；与 G5 的手势粒度同义）。 */export function touchedTaskIdsOf(command: DocumentCommand): readonly string[] {
  switch (command.kind) {
    case 'task.update':
    case 'task.remove':
    case 'task.indent':
    case 'task.outdent':
    case 'task.move':
      return [command.id];
    case 'task.insert':
      return [command.task.id];
    case 'link.insert':
      return [command.link.from, command.link.to];
    default:
      return [];
  }
}
