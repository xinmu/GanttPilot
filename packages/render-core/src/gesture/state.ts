/**
 * 状态机：六个不变值状态（{@link GestureState}）、按下与推进
 * （{@link beginGesture} / {@link reduceGesture}）与**产出构造**
 * （{@link GestureUpdate} / {@link idleGesture}）。
 *
 * 判定三语义的**公式**在 `zones.ts`（唯一实现处），这里只做"区域 → 模式"的转发
 * （{@link dragModeFor}）——"看起来能抓的那一点"与"真的按判定区分类的那一点"因此必然是同一个数。
 * 口径见 [`./index.ts`](./index.ts)（尤其"拖动期不写文档"与"每帧都吸附"两条）。
 */

import {
  type Calendar,
  type DocumentLink,
  type ProjectDocument,
  type Schedule,
  type SessionAnchor,
} from '@ganttpilot/engine';

import type { TaskBounds } from '../domain.js';
import type { ViewModel } from '../viewModel.js';
import { dragModeOfZones, zonesFor, type DragMode } from '../zones.js';
import { dragCandidate } from './candidates.js';
import { beginLinking, linkIndexesTouching, updateForLink, type LinkPreview } from './linking.js';
import { resolveDragOutcome, type DragOutcome } from './outcome.js';
import {
  barHitFor,
  deltaFor,
  ordinalAtClamped,
  resolvePointerTarget,
  type HitTarget,
  type PointerInput,
} from './pointer.js';

/** 违反依赖时的策略（IX-05 / ADR 0008 §6）。 */
export type AnchorMode = 'snap' | 'allow';

/** 手势状态机（不可变值）。 */
export type GestureState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'dragging';
      readonly taskId: string;
      readonly sourceRow: number;
      readonly mode: DragMode;
      /** 按下时的序号（改工期的基准）。 */
      readonly originOrdinal: number;
      /**
       * **抓取点**所在的工作日序号（按下那一刻由 `ordinalAtClamped` 得到）。
       *
       * 位移一律相对它计算（{@link deltaFor}）——这是"按下不动 = 零位移"的唯一依据，
       * 也是 P-22 批次 A 订正 R7 的落点（初稿存的是 `pointerStartX` 像素值，但**从未被使用**）。
       */
      readonly grabOrdinal: number;
      /**
       * 候选序号（已按 `anchorMode` 处理）。
       *
       * **语义按模式而定**（ADR 0008 §13）：`move`/`resize-start` 是**新开始**，
       * `resize-duration` 是**新完成**（可能为负——结果解析处才夹取到项目起点之上）。
       */
      readonly candidate: number;
    }
  | {
      readonly kind: 'linking';
      readonly fromTaskId: string;
      readonly sourceRow: number;
      readonly toTaskId: string | null;
      readonly toRow: number | null;
      /**
       * 出端侧：**由所抓的连接点决定**（ADR 0008 §16.3／裁决 P-32）。
       *
       * `Alt` 兼容路径（§7 的旧入口）按"指针在条的水平位置"给侧：左半 ⇒ 左出，右半 ⇒ 右出。
       */
      readonly exitSide: 'left' | 'right';
    }
  | {
      /** 松手但尚未提交（调用方读 `update.apply` 后即回到 `idle`）。 */
      readonly kind: 'released';
      readonly taskId: string;
    }
  | {
      /** 建线被预检拒绝（成环 = `cycle`；重复边 = `duplicate`）。 */
      readonly kind: 'rejected';
      readonly fromTaskId: string;
      readonly toTaskId: string;
      readonly reason: 'cycle' | 'duplicate';
    }
  | {
      /** 指针移出可判定区域（回调上一帧的候选仍然有效，但状态显式标记）。 */
      readonly kind: 'outside';
      readonly previous: GestureState;
    };

/** 命名锚点（会话内锚点 + 它的用途，便于 debug 与测试断言）。 */
export interface AnchorEntry {
  readonly anchor: SessionAnchor;
  /** `gesture` = 拖动中的跟手位置；`suggestion` = 域函数给出的建议值（仍由调用方决定是否提交）。 */
  readonly role: 'gesture' | 'suggestion';
}

/** 一次手势状态推进的**全部产出**（调用方据此重算/提交/绘制）。 */
export interface GestureUpdate {
  readonly state: GestureState;
  /** 令牌：`null` 表示没有手势作用域（回到 idle）。 */
  readonly gestureToken: string | null;
  /** 会话内锚点（喂给 `compute`；**不进文档**）。 */
  readonly anchors: readonly SessionAnchor[];
  /** 松手时要提交的命令（至多一条；`null` = 不提交）。 */
  readonly commands: readonly { readonly kind: 'task.update'; readonly id: string; readonly patch: Record<string, unknown> }[];
  /** 松手时要提交的建线（至多一条）。 */
  readonly link: DocumentLink | null;
  /** 需要重绘的行（**文档序索引**）——拖动行与建线两端。 */
  readonly rows: readonly number[];
  /** 需要重绘的边（`links` 下标）——建线两端的相关边。 */
  readonly edges: readonly number[];
  /** 成环路径（`rejected` 时非空；首尾同一 id）。 */
  readonly cyclePath: readonly string[];
  /** 建线预览（`linking` 时非空）。 */
  readonly preview: LinkPreview | null;
  /**
   * **拖动结果**（凡由 {@link updateForDrag} 产出的更新都非空——`dragging` 与松手的 `released` 帧都带上，
   * 其余状态一律 `null`；裁决 P-45）。
   *
   * 为什么它必须跟着 `GestureUpdate` 一起出来：拖动期的"所见"有两半——
   * 几何那半由 {@link dragPreviewFor} / {@link drawnBarForRow} 画，
   * **工期那半（下游跟随）只能经文档进 `compute`**。把结果本身放进产出，
   * 应用层就能用**同一个** `patch` 去造未提交副本（{@link previewDocumentFor}），
   * 而不是自己再推一遍"这次拖动改了几天"——那样"预览"与"松手提交"会分叉。
   *
   * `patch === null` = 零位移（按下不动）：没有要预览的东西，副本也不必造。
   */
  readonly dragOutcome: DragOutcome | null;
}

/** 空闲手势的产出。 */
export function idleGesture(): GestureUpdate {
  return {
    state: { kind: 'idle' },
    gestureToken: null,
    anchors: [],
    commands: [],
    link: null,
    rows: [],
    edges: [],
    cyclePath: [],
    preview: null,
    dragOutcome: null,
  };
}

// ---------------------------------------------------------------- 手势推进

/** `beginGesture` 的入参。 */
export interface BeginGestureArgs {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly pointer: PointerInput;
  readonly anchorMode: AnchorMode;
  /**
   * **建线的起手位置**（ADR 0008 §16.3／裁决 P-32）：由 `interaction.ts` 的 `linkEntryFor`
   * 从内容坐标算出——指针落在某行的**连接点**上时非空。
   *
   * 为什么由调用方给而不是本文件自己算：本包内不得出现 `gesture → interaction → gesture` 的环，
   * 而 `interaction.ts` 需要本目录（`gesture/pointer.ts`）的 `resolvePointerTarget`/`barHitFor`。
   * 归一化的入口因此收在 `apps/web`（它本来就要调 `pointerFromClient`），
   * **换算本身仍是纯函数、仍在门禁内**。
   */
  readonly entryPoint?: { readonly taskId: string; readonly exitSide: 'left' | 'right' } | undefined;
}

/** `reduceGesture` 的入参。 */
export interface ReduceGestureArgs extends BeginGestureArgs {
  readonly state: GestureState;
}

/**
 * 判定三语义（ADR 0008 §5 的表，**边界宽度由 §16.1 修订**／裁决 P-32）。
 *
 * 公式本身在 `zones.ts` 的 `zonesFor`（**唯一实现处**）——同一条公式还决定端点手柄的位置，
 * 因此"看起来能抓的那一点"与"真的按判定区分类的那一点"必然是同一个数。
 *
 * 里程碑不走判定区：它按**菱形中心**分半（左半 `move`、右半 `resize-duration`），
 * 因为 `DRAG_EDGE_PX` 相对 12 px 宽的菱形太大（菱形中心距边只有 6 px）。
 */
export function dragModeFor(bounds: TaskBounds, x: number): DragMode {
  return dragModeOfZones(bounds, zonesFor(bounds), x);
}

/**
 * 按下左键：开始拖动或建线。
 *
 * 四条前置（顺序即语义）：
 * ① 必须落在**渲染窗口内的可见行**（`resolvePointerTarget`）；
 * ② **连接点优先** ⇒ 建线（ADR 0008 §16.3／P-32；`entryPoint` 由 `interaction.ts` 的纯函数给出）；
 * ③ **必须命中条体**（`barHitFor`，ADR 0008 §13——P-21 的 R2）；
 * ④ 汇总行不可拖、只可建线。
 *
 * **`Alt` 入口已删除**（[P-32](../../../docs/00-baseline/裁决记录.md) 的人工复验第 ⑤ 条：
 * "Alt 仍然无效，这个入口可以直接取消"）。它在 Windows 上被窗口管理器的"移动窗口"手势吃掉
 * （事件到不了页面），**没有可用平台**——保留一个"在某个平台上永远不生效"的别名只会制造
 * "为什么我这里不能用"的支持成本，因此**只留连接点**这一条入口（`entryPoint`）。
 */
export function beginGesture(args: BeginGestureArgs): GestureUpdate {
  const target = resolvePointerTarget({
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    x: args.pointer.x,
    y: args.pointer.y,
  });
  if (target === null) return idleGesture();
  // ② 连接点：出端侧由**用户抓的那一侧**决定（§16.3），不由几何反推。
  if (args.entryPoint !== undefined && args.entryPoint.taskId === target.taskId) {
    return beginLinking(args, target, args.entryPoint.exitSide);
  }
  // 汇总条不可拖（汇总日期是聚合结果，改它要改子树）；但**可以**作为建线端点（连接点）。
  if (target.isSummary) return idleGesture();
  // ③ 条体命中：同一行的空白处按下不得产生手势（否则"左侧空白改开始、右侧空白工期翻倍"）。
  if (!barHitFor({ bounds: target.bounds, x: args.pointer.x })) return idleGesture();

  const mode = dragModeFor(target.bounds, args.pointer.x);
  const grabOrdinal = ordinalAtClamped(args.view, args.pointer.x, args.calendar);
  const candidate = dragCandidate({
    mode,
    pointerX: args.pointer.x,
    // 按下这一刻，`bounds.es` **就是**原开始序号（此后视图才会带着锚点走）。
    originOrdinal: target.bounds.es,
    durationDays: taskDurationOf(args.document, target.taskId),
    taskId: target.taskId,
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    anchorMode: args.anchorMode,
    grabOrdinal,
  });
  const state: GestureState = {
    kind: 'dragging',
    taskId: target.taskId,
    sourceRow: target.row,
    mode,
    originOrdinal: target.bounds.es,
    grabOrdinal,
    candidate,
  };
  return updateForDrag(state, args);
}

/** 任务工期（`null` 视为 0；找不到任务也返回 0）。 */
function taskDurationOf(document: ProjectDocument, taskId: string): number {
  return document.tasks.find((task) => task.id === taskId)?.durationDays ?? 0;
}

/** 指针移动 / 松手 / 取消的统一入口。 */
export function reduceGesture(args: ReduceGestureArgs): GestureUpdate {
  const { state, pointer } = args;
  if (state.kind === 'idle' || state.kind === 'released' || state.kind === 'rejected') return idleGesture();
  if (state.kind === 'outside') return reduceGesture({ ...args, state: state.previous });
  if (pointer.escPressed === true) return idleGesture(); // 取消：清锚点、不提交
  if ((pointer.buttons & 1) === 0) return releaseGesture(args);

  const target = resolvePointerTarget({
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    x: pointer.x,
    y: pointer.y,
  });

  if (state.kind === 'dragging') {
    if (target === null) {
      // 拖出可判定区域：保留上一帧状态（调用方按需画"移出"提示），不改变候选。
      return { ...updateForDrag(state, args), state: { kind: 'outside', previous: state } };
    }
    // 拖动行本身变了（跨行拖动）：v0.1 不支持"拖到别的行"（改层级归 v0.5 的 move 命令），
    // 因此跨行时按"仍在原行"处理，只在提示里体现。
    const next: GestureState = { ...state, candidate: nextCandidateFor({ ...args, target }) };
    return updateForDrag(next, { ...args, pointer });
  }

  // linking
  const next: GestureState = {
    ...state,
    toTaskId: target === null ? null : target.taskId,
    toRow: target === null ? null : target.row,
  };
  return updateForLink(next, { ...args, pointer });
}

function nextCandidateFor(args: ReduceGestureArgs & { readonly target: HitTarget }): number {
  const state = args.state;
  if (state.kind !== 'dragging') return 0;
  const task = args.document.tasks.find((item) => item.id === state.taskId);
  if (task === undefined) return 0;
  const delta = deltaFor({
    view: args.view,
    calendar: args.calendar,
    pointerX: args.pointer.x,
    grabOrdinal: state.grabOrdinal,
  });
  return dragCandidate({
    mode: state.mode,
    pointerX: args.pointer.x,
    // **基准必须是按下时捕获的序号**：拖动期视图带着会话锚点重算，
    // `target.bounds.es`（指针当前所在行）已经跟着候选走了 —— 用它当基准会让
    // 每帧"再前进一段"累积成加速拖动（P-22 由记录制 `--drag` 当场抓出）。
    originOrdinal: state.originOrdinal,
    durationDays: task.durationDays ?? 0,
    taskId: state.taskId,
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    anchorMode: args.anchorMode,
    grabOrdinal: state.grabOrdinal,
    delta,
  });
}

function releaseGesture(args: ReduceGestureArgs): GestureUpdate {
  const { state } = args;
  if (state.kind === 'dragging') return updateForDrag(state, args, true);
  if (state.kind === 'linking') return updateForLink(state, args, true);
  return idleGesture();
}

// ---------------------------------------------------------------- 产出构造

function updateForDrag(
  state: Extract<GestureState, { kind: 'dragging' }>,
  args: BeginGestureArgs,
  releasing = false,
): GestureUpdate {
  const docIndex = args.document.tasks.findIndex((task) => task.id === state.taskId);
  const task = docIndex >= 0 ? args.document.tasks[docIndex] : undefined;
  if (task === undefined) return idleGesture();
  const outcome = resolveDragOutcome({ state, document: args.document, calendar: args.calendar });
  if (outcome === null) return idleGesture();
  const anchor: SessionAnchor = { taskId: state.taskId, startOrdinal: outcome.anchorOrdinal };
  const rows = [docIndex];
  const edges = linkIndexesTouching(args.document, state.taskId);
  const token = `drag:${state.taskId}`;

  if (!releasing) {
    return {
      state,
      gestureToken: token,
      anchors: [anchor],
      commands: [],
      link: null,
      rows,
      edges,
      cyclePath: [],
      preview: null,
      dragOutcome: outcome,
    };
  }

  return {
    state: { kind: 'released', taskId: state.taskId },
    gestureToken: null,
    anchors: [],
    // 零位移 ⇒ 不产出命令（文档一字不改，也不压撤销栈，IX-03 的"无操作不压栈"由此提前到手势层）。
    commands: outcome.patch === null ? [] : [{ kind: 'task.update', id: state.taskId, patch: outcome.patch }],
    link: null,
    rows,
    edges,
    cyclePath: [],
    preview: null,
    dragOutcome: outcome,
  };
}
