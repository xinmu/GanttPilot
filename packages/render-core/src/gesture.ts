/**
 * 拖拽手势的**纯内核**（ADR 0008 §4–§8 的可执行形式）。
 *
 * ## 为什么它在 `render-core` 而不是组件里
 *
 * 手势逻辑是"指针 + 几何 → 该写什么命令"的**映射**，与 Vue 无关；而组件里的逻辑
 * **不在门禁覆盖内**（P-19 §4 的教训：`apps/web` 的 spec 收不进来）。
 * 因此这里只收**归一化指针**（`{x, y, buttons, altKey, escPressed}`，绝不碰 `PointerEvent`），
 * 由 `apps/web` 的 `useGesture.ts` 做事件归一化与 DOM 提交。
 *
 * ## 三条口径（ADR 0008 冻结，本文件只是它的实现）
 *
 * 1. **拖动期不写文档**：位置经 **会话锚点**（`compute(document, calendar, anchors)` 的入参）生效，
 *    松手才提交 `task.update` / `link.insert`（§6 的表）；
 * 2. **每帧都吸附**：候选 = `ordinalAtX(view, x, calendar)`（ADR 0007 §3 已把"出候选"归 G4、
 *    "定时机"归 G5）。`snap` 模式把候选**夹到入边约束**（拖动因此永远"顶住"边界）；
 *    `allow` 模式原样放行 —— 当候选**早于**入边约束时，`compute` 会报 `anchorConflict`
 *    （[SCHEDULE.md](../../engine/SCHEDULE.md) §四.3 情形④ + §六），UI 据此标红。
 *    **冲突判据只有这一处**：UI 不自己判"算不算冲突"（ADR 0008 §6）；
 * 3. **成环预检即拒绝**：建线前先 `wouldCreateCycle`，成环则不提交并把路径交给高亮层（§7/§8）。
 *
 * ## 一处**语义订正**（落地期实测，ADR 0008 §12 的"落地"段记录）
 *
 * 初稿把"允许 + 标红"读成"候选**晚于**约束即冲突"，于是 `allow` 模式的标红条件设成了
 * `candidate > constraint` —— **方向反了**：晚于约束根本不冲突（`compute` 取 `max(约束, 锚点)`，
 * 结果是"任务往后排、下游一起往后"，用户要的正是这个）。真正的冲突是**早于约束**
 * （`SCHEDULE.md` §四.3 情形④ 的原文："锚定早于入边约束 → `anchorConflict`"）。
 * 于是两种模式的分工是：
 *
 * | 模式 | 候选 | 引擎行为 | 冲突 |
 * |---|---|---|---|
 * | `snap` | 夹到 `[0, 约束]` | `ES = 约束`/候选（**永不触发** `anchorConflict`） | 无 |
 * | `allow` | 原样（可能 < 0 或 < 约束） | `ES = max(约束, 锚点)` = 约束（任务顶在边界上） | **有**（`anchorConflict`） |
 *
 * 两种模式下"任务最终落在哪"是同一个答案（引擎说了算），差别在**用户是否被告知"你拖过头了"**——
 * 这正是 IX-05 要的那个切换：默认帮用户夹住，或如实放行并标红。
 */

import {
  wouldCreateCycle,
  type Calendar,
  type DocumentLink,
  type ProjectDocument,
  type Schedule,
  type SessionAnchor,
} from '@ganttpilot/engine';

import { taskBounds, type TaskBounds } from './domain.js';
import { DRAG_EDGE_PX, type ZoomKey } from './manifest.js';
import type { ViewModel } from './viewModel.js';

/** 拖拽语义（ADR 0008 §5）：判定区决定 `mode`。 */
export type DragMode = 'move' | 'resize-start' | 'resize-duration';

/** 违反依赖时的策略（IX-05 / ADR 0008 §6）。 */
export type AnchorMode = 'snap' | 'allow';

/** 归一化指针输入：**绝不是** DOM 事件对象。 */
export interface PointerInput {
  /** SVG 内容坐标系的 x（已含滚动偏移，见 `dayAtX` 的口径）。 */
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  /** `Esc` 被按下（取消手势）。 */
  readonly escPressed?: boolean;
}

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
      readonly pointerStartX: number;
      /** 候选序号（已按 `anchorMode` 处理）。 */
      readonly candidate: number;
    }
  | {
      readonly kind: 'linking';
      readonly fromTaskId: string;
      readonly sourceRow: number;
      readonly toTaskId: string | null;
      readonly toRow: number | null;
    }
  | {
      /** 松手但尚未提交（调用方读 `update.apply` 后即回到 `idle`）。 */
      readonly kind: 'released';
      readonly taskId: string;
    }
  | {
      /** 建线被预检拒绝（成环）。 */
      readonly kind: 'rejected';
      readonly fromTaskId: string;
      readonly toTaskId: string;
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

/** 建线预览（正交折线的两个端点；完整路径由渲染层用 `routeEdge` 生成）。 */
export interface LinkPreview {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly type: DocumentLink['type'];
  readonly lagDays: number;
  readonly exitPoint: readonly [number, number];
  readonly enterPoint: readonly [number, number];
  readonly cyclic: boolean;
  readonly cyclePath: readonly string[];
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
  };
}

// ---------------------------------------------------------------- 几何：命中与坐标

/** 命中结果（`resolvePointerTarget` 的产出）。 */
export interface HitTarget {
  readonly row: number;
  readonly docIndex: number;
  readonly taskId: string;
  readonly isMilestone: boolean;
  readonly isSummary: boolean;
  readonly bounds: TaskBounds;
}

/** `resolvePointerTarget` 的入参（`buildView` 的入参 + 指针）。 */
export interface ResolvePointerArgs {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly x: number;
  readonly y: number;
}

/**
 * 指针 → 命中行（`null` = 空白 / 缓冲行 / 越界）。
 *
 * 只认**渲染窗口内的可见行**：缓冲行与折叠隐藏行不可交互（ADR 0007 §6 的裁剪口径）。
 * 汇总行**可命中**（建线允许以汇总为端点，会得到 `edge-ignored` 样式；但不允许拖动，见 `beginGesture`）。
 */
export function resolvePointerTarget(args: ResolvePointerArgs): HitTarget | null {
  const { view, document, schedule, calendar } = args;
  const row = Math.floor((args.y + view.scrollTop) / view.rowHeight);
  if (!Number.isInteger(row) || row < view.renderFirst || row > view.renderLast) return null;
  const docIndex = view.order[row];
  if (docIndex === undefined) return null;
  const task = document.tasks[docIndex];
  if (task === undefined) return null;
  const bounds = taskBounds({
    document,
    schedule,
    calendar,
    rowOfDocIndex: view.rowOfDocIndex,
    axisOriginDay: view.axisOriginDay,
    pxPerDay: view.pxPerDay,
    rowHeight: view.rowHeight,
    docIndex,
  });
  if (bounds === null) return null;
  return {
    row,
    docIndex,
    taskId: task.id,
    isMilestone: bounds.isMilestone,
    isSummary: bounds.kind === 'summary',
    bounds,
  };
}

/** 档位无关的"移动量 → 天数"换算（拖动时用整日拖动，避免半像素抖动）。 */
export function dayDeltaFor(view: ViewModel, deltaX: number): number {
  return deltaX / view.pxPerDay;
}

// ---------------------------------------------------------------- 入边约束（§6）

/**
 * 调度语义下**允许的最小序号**（入边边界），`-Infinity` 表示无约束。
 *
 * 与 `Schedule` 的边界方程同式（[SCHEDULE.md](../../engine/SCHEDULE.md) §九 不变量 2）：
 * FS `es_pred + 工期_pred + lag`、SS `es_pred + lag`、FF `ef_pred + lag − 工期`、SF `es_pred + lag − 工期`。
 * 只考虑**有效入边**（排除端点含汇总任务的边，SCHEDULE.md §四.6）。
 * 汇总行与未知 id 一律返回 `-Infinity`（汇总不参与传播）。
 */
export function entryConstraintFor(args: {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly taskId: string;
  readonly durationDays: number;
}): number {
  const { document, schedule, taskId } = args;
  const indexOfId = new Map<string, number>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined) indexOfId.set(task.id, index);
  }
  const selfIndex = indexOfId.get(taskId);
  if (selfIndex === undefined) return Number.NEGATIVE_INFINITY;
  if ((schedule.es[selfIndex] ?? -1) === -1) return Number.NEGATIVE_INFINITY; // 汇总不参与传播

  let constraint = Number.NEGATIVE_INFINITY;
  for (const link of document.links) {
    if (link.to !== taskId) continue;
    const fromIndex = indexOfId.get(link.from);
    if (fromIndex === undefined) continue;
    const fromEs = schedule.es[fromIndex] ?? -1;
    const fromEf = schedule.ef[fromIndex] ?? -1;
    if (fromEs < 0 || fromEf < 0) continue; // 汇总端点 ⇒ 有效图中不存在（§四.6）
    const lag = link.lagDays;
    const candidate =
      link.type === 'FS'
        ? fromEf + lag
        : link.type === 'SS'
          ? fromEs + lag
          : link.type === 'FF'
            ? fromEf + lag - args.durationDays
            : fromEs + lag - args.durationDays;
    if (candidate > constraint) constraint = candidate;
  }
  return constraint;
}

/**
 * `snap` 模式的候选：把候选**夹**到 `[0, 入边约束]`。
 *
 * ```
 * lower = max(minOrdinal, 0)                  // 0 = Calendar.baseDay 的序号，负序号无定义（G1.1 冻结）
 * upper = max(constraint, lower)              // 无约束 ⇒ +∞；约束早于项目起点时不制造空区间
 * return min(max(candidate, lower), upper)
 * ```
 *
 * **落地期实测订正（两处，同一行）**：初稿把约束同时当成了**下界**，于是
 * ① 返回的不是"夹"而是 `max(candidate, 约束)` —— 一个**早于**约束的候选会被**抬到约束之上**，
 * 恰好与要防的事情相反；② 而且这个方向**永远不会被"违反约束"的断言抓到**（它只会让锚点更晚），
 * 只有"约束之前的位置必须留在约束之前"这条**上界断言**能抓出来。
 * `gesture.spec.ts` 的 `snapCandidate({candidate: 约束−3, constraint})` 正是那条上界断言。
 */
export function snapCandidate(args: {
  readonly candidate: number;
  readonly constraint: number;
  readonly minOrdinal: number;
}): number {
  const lower = Math.max(args.minOrdinal, 0);
  const upper = Number.isFinite(args.constraint) ? Math.max(args.constraint, lower) : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(args.candidate, lower), upper);
}

/** 在 `views` 的地平线内安全地取 `x` 处的工作日序号（越界时**夹回**边界，不抛错）。 */
export function ordinalAtClamped(view: ViewModel, x: number, calendar: Calendar): number {
  try {
    return ordinalAtXSafe(view, x, calendar);
  } catch {
    // 落在地平线之外（视图比文档宽得多）：按 x 的方向取边界。
    const atLeft = x <= 0;
    const bound = atLeft ? 0 : Math.max(0, calendar.workdayCount - 1);
    try {
      return atLeft ? 0 : calendar.ordinalOfDay(calendar.dayOfOrdinal(bound));
    } catch {
      return 0;
    }
  }
}

/** `render-core` 的反算（这里再包一层只是为了让 catch 有明确的落点）。 */
function ordinalAtXSafe(view: ViewModel, x: number, calendar: Calendar): number {
  const day = view.axisOriginDay + (x + view.scrollLeft) / view.pxPerDay;
  return calendar.ordinalOfDay(Math.floor(day));
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
}

/** `reduceGesture` 的入参。 */
export interface ReduceGestureArgs extends BeginGestureArgs {
  readonly state: GestureState;
}

/** 判定三语义（ADR 0008 §5 的表）。 */
export function dragModeFor(bounds: TaskBounds, x: number): DragMode {
  if (bounds.isMilestone) {
    // 里程碑只有"整体移动"，但拖右半边是"把它变成有长度的任务"（改工期）。
    // `DRAG_EDGE_PX` 相对 12 px 宽的菱形太大（菱形中心距边只有 6 px），因此这里按**中心**分半。
    const cx = bounds.milestone?.cx ?? (bounds.xLeft + bounds.xRight) / 2;
    return x >= cx ? 'resize-duration' : 'move';
  }
  if (x <= bounds.xLeft + DRAG_EDGE_PX) return 'resize-start';
  if (x >= bounds.xRight - DRAG_EDGE_PX) return 'resize-duration';
  return 'move';
}

/** 按下左键：开始拖动或建线（建线需要 `altKey`——避免与拖动抢同一个手势）。 */
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
  if (target.isSummary) {
    // 汇总条不可拖（汇总日期是聚合结果，改它要改子树）；但**可以**作为建线端点。
    return args.pointer.altKey === true ? beginLinking(args, target) : idleGesture();
  }
  if (args.pointer.altKey === true) return beginLinking(args, target);

  const mode = dragModeFor(target.bounds, args.pointer.x);
  const candidate = snapForMode({
    mode,
    pointer: args.pointer,
    target,
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    anchorMode: args.anchorMode,
  });
  const state: GestureState = {
    kind: 'dragging',
    taskId: target.taskId,
    sourceRow: target.row,
    mode,
    originOrdinal: target.bounds.es,
    pointerStartX: args.pointer.x,
    candidate,
  };
  return updateForDrag(state, args);
}

function beginLinking(args: BeginGestureArgs, target: HitTarget): GestureUpdate {
  const state: GestureState = {
    kind: 'linking',
    fromTaskId: target.taskId,
    sourceRow: target.row,
    toTaskId: null,
    toRow: null,
  };
  return updateForLink(state, args);
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
    const next: GestureState = { ...state, candidate: candidateFor({ ...args, target }) };
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

function candidateFor(args: ReduceGestureArgs & { readonly target: HitTarget }): number {
  return snapForMode({
    mode: args.state.kind === 'dragging' ? args.state.mode : 'move',
    pointer: args.pointer,
    target: args.target,
    view: args.view,
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    anchorMode: args.anchorMode,
  });
}

function snapForMode(args: {
  readonly mode: DragMode;
  readonly pointer: PointerInput;
  readonly target: HitTarget;
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly anchorMode: AnchorMode;
}): number {
  const raw = ordinalAtClamped(args.view, args.pointer.x, args.calendar);
  if (args.anchorMode === 'allow') return raw;
  const task = args.document.tasks[args.target.docIndex];
  const durationDays = task?.durationDays ?? 0;
  const constraint = entryConstraintFor({
    document: args.document,
    schedule: args.schedule,
    taskId: args.target.taskId,
    durationDays,
  });
  const out = snapCandidate({ candidate: raw, constraint, minOrdinal: 0 });
  return out;
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
  const duration = task.durationDays ?? 0;
  const anchor: SessionAnchor = { taskId: state.taskId, startOrdinal: state.candidate };
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
    };
  }

  // 松手：把候选换算成文档字段（ADR 0008 §5 的命令映射）。
  const startIso = args.calendar.isoOfOrdinal(Math.max(0, state.candidate));
  const endIso = args.calendar.isoOfOrdinal(Math.max(0, state.candidate + duration - 1));
  const patch: Record<string, unknown> =
    state.mode === 'resize-start'
      ? // 改开始：完成日不动 ⇒ 工期随之变化（不小于 1）。
        { startDate: startIso, durationDays: Math.max(1, state.originOrdinal + duration - state.candidate) }
      : state.mode === 'resize-duration'
        ? { durationDays: Math.max(1, state.candidate - state.originOrdinal + duration), endDate: endIso }
        : { startDate: startIso, endDate: endIso };

  return {
    state: { kind: 'released', taskId: state.taskId },
    gestureToken: null,
    anchors: [],
    commands: [{ kind: 'task.update', id: state.taskId, patch }],
    link: null,
    rows,
    edges,
    cyclePath: [],
    preview: null,
  };
}

function updateForLink(
  state: Extract<GestureState, { kind: 'linking' }>,
  args: BeginGestureArgs,
  releasing = false,
): GestureUpdate {
  const fromIndex = args.document.tasks.findIndex((task) => task.id === state.fromTaskId);
  const rows = new Set<number>();
  const edges = new Set<number>();
  if (fromIndex >= 0) {
    rows.add(fromIndex);
    for (const index of linkIndexesTouching(args.document, state.fromTaskId)) edges.add(index);
  }
  if (state.toTaskId !== null) {
    const toIndex = args.document.tasks.findIndex((task) => task.id === state.toTaskId);
    if (toIndex >= 0) rows.add(toIndex);
    for (const index of linkIndexesTouching(args.document, state.toTaskId)) edges.add(index);
  }

  if (state.toTaskId === null) {
    return {
      state,
      gestureToken: `link:${state.fromTaskId}`,
      anchors: [],
      commands: [],
      link: null,
      rows: [...rows].sort((left, right) => left - right),
      edges: [...edges].sort((left, right) => left - right),
      cyclePath: [],
      preview: null,
    };
  }

  const candidate = buildCandidateLink({
    document: args.document,
    schedule: args.schedule,
    view: args.view,
    calendar: args.calendar,
    fromTaskId: state.fromTaskId,
    toTaskId: state.toTaskId,
  });
  if (candidate === null) return idleGesture();

  const cycle = wouldCreateCycle(args.document.links, candidate.link);
  const preview: LinkPreview = {
    fromTaskId: state.fromTaskId,
    toTaskId: state.toTaskId,
    type: candidate.link.type,
    lagDays: candidate.link.lagDays,
    exitPoint: candidate.exitPoint,
    enterPoint: candidate.enterPoint,
    cyclic: cycle.cyclic,
    cyclePath: cycle.path,
  };

  if (!releasing) {
    return {
      state,
      gestureToken: `link:${state.fromTaskId}`,
      anchors: [],
      commands: [],
      link: null,
      rows: [...rows].sort((left, right) => left - right),
      edges: [...edges].sort((left, right) => left - right),
      cyclePath: cycle.cyclic ? cycle.path : [],
      preview,
    };
  }

  if (cycle.cyclic) {
    // 预检即拒绝（ADR 0008 §7）：不提交、只高亮成环路径。
    return {
      state: { kind: 'rejected', fromTaskId: state.fromTaskId, toTaskId: state.toTaskId },
      gestureToken: null,
      anchors: [],
      commands: [],
      link: null,
      rows: [...rows].sort((left, right) => left - right),
      edges: [...edges].sort((left, right) => left - right),
      cyclePath: cycle.path,
      preview,
    };
  }

  return {
    state: { kind: 'released', taskId: state.toTaskId },
    gestureToken: null,
    anchors: [],
    commands: [],
    link: candidate.link,
    rows: [...rows].sort((left, right) => left - right),
    edges: [...edges].sort((left, right) => left - right),
    cyclePath: [],
    preview,
  };
}

/**
 * 建线的四件事：**类型**由相对位置决定、**id** 由调用方给（命令层不生成 id）、
 * **端点**落在两条边的连接点、`lagDays = 0`（ADR 0008 §7）。
 */
function buildCandidateLink(args: {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly view: ViewModel;
  readonly calendar: Calendar;
  readonly fromTaskId: string;
  readonly toTaskId: string;
}): {
  readonly link: DocumentLink;
  readonly exitPoint: readonly [number, number];
  readonly enterPoint: readonly [number, number];
} | null {
  if (args.fromTaskId === args.toTaskId) return null;
  const from = boundsOf(args, args.fromTaskId);
  const to = boundsOf(args, args.toTaskId);
  if (from === null || to === null) return null;
  // 类型由相对位置决定（与 P-8 第 1 条同式的反推）：目标在右 ⇒ FS（右出→左入），否则 SS（左出→左入）。
  const type: DocumentLink['type'] = to.xLeft >= from.xLeft ? 'FS' : 'SS';
  const link: DocumentLink = {
    id: suggestLinkIdFor(args.document, args.fromTaskId, args.toTaskId, type),
    from: args.fromTaskId,
    to: args.toTaskId,
    type,
    lagDays: 0,
  };
  return {
    link,
    exitPoint: [type === 'FS' ? from.xRight : from.xLeft, from.y],
    enterPoint: [to.xLeft, to.y],
  };
}

/** 任一条形几何（复用 `taskBounds`，不复制公式——ADR 0007 §3 的右边界口径只有一处）。 */
function boundsOf(
  args: {
    readonly document: ProjectDocument;
    readonly schedule: Schedule;
    readonly view: ViewModel;
    readonly calendar: Calendar;
  },
  taskId: string,
): TaskBounds | null {
  const docIndex = args.document.tasks.findIndex((task) => task.id === taskId);
  if (docIndex < 0) return null;
  return taskBounds({
    document: args.document,
    schedule: args.schedule,
    calendar: args.calendar,
    rowOfDocIndex: args.view.rowOfDocIndex,
    axisOriginDay: args.view.axisOriginDay,
    pxPerDay: args.view.pxPerDay,
    rowHeight: args.view.rowHeight,
    docIndex,
  });
}

function linkIndexesTouching(document: ProjectDocument, taskId: string): readonly number[] {
  const indexes: number[] = [];
  for (let index = 0; index < document.links.length; index += 1) {
    const link = document.links[index];
    if (link === undefined) continue;
    if (link.from === taskId || link.to === taskId) indexes.push(index);
  }
  return indexes;
}

function suggestLinkIdFor(
  document: ProjectDocument,
  from: string,
  to: string,
  type: string,
): string {
  const base = `l-${from}-${to}${type === 'FS' ? '' : type}`;
  const existing = new Set(document.links.map((link) => link.id));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${String(suffix)}`)) suffix += 1;
  return `${base}-${String(suffix)}`;
}

export type { ZoomKey };
