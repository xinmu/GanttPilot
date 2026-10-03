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

import { computed, markRaw, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import {
  applyToSession,
  createScheduleCalendar,
  createSession,
  DATASETS,
  generateDocument,
  PRIMARY_DATASET_KEY,
  reindexDocument,
  redoSession,
  undoSession,
  validateDocument,
  type DocumentCommand,
  type DocumentDiagnostic,
  type DocumentSession,
  type ProjectDocument,
  type Schedule,
  type ScheduleDiagnostic,
  type ScheduleResult,
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
 * 演示数据：与 spec、测量脚本**同源**的确定性夹具（`render-core/fixtures`）。
 *
 * `outlineNumber` 是派生值，落库前必须 `reindexDocument`（ADR 0002 ③）——
 * `generateDocument` 产出的是"待规范化"的文档，这里顺手补齐，因此演示数据直接可渲染。
 */
export function createDemoDocument(): ProjectDocument {
  const spec = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY) ?? DATASETS[0];
  if (spec === undefined) throw new Error('缺少演示数据集');
  return reindexDocument(generateDocument(spec).document);
}

/** 应用级项目状态：会话 + 排程 + 诊断（**不含**任何渲染几何）。 */
export interface UseProject {
  readonly document: Ref<ProjectDocument>;
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
  readonly lastFailure: Ref<{ readonly code: string; readonly message: string } | null>;
  dispatch: (command: DocumentCommand) => DispatchResult;
  ingestDocument: (document: ProjectDocument) => DispatchResult;
  undo: () => DispatchResult;
  redo: () => DispatchResult;
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

  const calendar = computed<Calendar>(() => markRaw(createScheduleCalendar(documentRef.value)));
  const scheduleResult = computed<ScheduleResult>(() => compute(documentRef.value, calendar.value));

  function commit(result: ReturnType<typeof applyToSession>, touchedTaskIds: readonly string[]): DispatchResult {
    if (!result.ok) {
      lastFailure.value = { code: result.code, message: result.message };
      return { ok: false, changed: false, code: result.code, message: result.message, touchedTaskIds };
    }
    lastFailure.value = null;
    if (result.changed) {
      sessionRef.value = markRaw(result.session);
      documentRef.value = markRaw(result.session.document);
    }
    return { ok: true, changed: result.changed, touchedTaskIds };
  }

  function dispatch(command: DocumentCommand): DispatchResult {
    // 命令层是唯一变更通道；形状预检与 schema 复用由 `applyToSession` 内部完成。
    return commit(applyToSession(sessionRef.value, command), touchedTaskIdsOf(command));
  }

  return {
    document: documentRef,
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
    dispatch,
    ingestDocument: (document: ProjectDocument) =>
      commit(applyToSession(sessionRef.value, { kind: 'document.replace', document }), []),
    undo: () => commit(undoSession(sessionRef.value), []),
    redo: () => commit(redoSession(sessionRef.value), []),
    reset: (next?: ProjectDocument) => {
      const value = markRaw(next ?? createDemoDocument());
      documentRef.value = value;
      sessionRef.value = markRaw(createSession(value));
      lastFailure.value = null;
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
