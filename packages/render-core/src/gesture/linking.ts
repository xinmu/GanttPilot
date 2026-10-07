/**
 * 建线：出端侧（**由用户抓的连接点给**）× 入端侧（**由关系类型给**）→ 关系类型与两个端点，
 * 外加**重复边预检**（拖动期即标红、松手拒绝）与产出构造（`updateForLink`，包内可见）。
 *
 * 口径（ADR 0008 §16.3／裁决 P-32）：入端侧**不由相对位置取端点**，而由 {@link linkTypeFor}
 * 定下的类型经 `routeSides(type)` 决定——否则会出现"边声明 FS、端点却落在目标右缘"的自相矛盾
 * （预览与提交的几何因此会分叉）。成环预检与"这一帧没有目标 ≠ 取消整条手势"见
 * {@link updateForLink} 的注释与 [`./index.ts`](./index.ts)。
 */

import {
  wouldCreateCycle,
  type Calendar,
  type DocumentLink,
  type ProjectDocument,
  type Schedule,
} from '@ganttpilot/engine';

import { taskBounds, type TaskBounds } from '../domain.js';
import { routeSides } from '../route.js';
import type { ViewModel } from '../viewModel.js';
import { enterXFor, exitXFor, linkEnterSideFor, linkTypeFor } from '../zones.js';
import type { HitTarget } from './pointer.js';
import type { BeginGestureArgs, GestureState, GestureUpdate } from './state.js';

/** 建线预览（正交折线的两个端点；完整路径由渲染层用 `routeEdge` 生成）。 */
export interface LinkPreview {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly type: DocumentLink['type'];
  readonly lagDays: number;
  readonly exitPoint: readonly [number, number];
  readonly enterPoint: readonly [number, number];
  readonly cyclic: boolean;
  /** 该候选边**已经存在**（同 from/to/type/lag）⇒ 拖动期即标红、松手拒绝（§16.8）。 */
  readonly duplicate: boolean;
  readonly cyclePath: readonly string[];
  /** 预检拒绝的原因（`cyclic` 与 `duplicate` 的呈现不同：前者高亮成环路径，后者只提示重复）。 */
  readonly reason: 'cycle' | 'duplicate' | null;
}

/** 按下连接点 ⇒ 进 `linking`（**包内可见**：调用方是状态机；不进包入口）。 */
export function beginLinking(args: BeginGestureArgs, target: HitTarget, exitSide: 'left' | 'right'): GestureUpdate {
  const state: GestureState = {
    kind: 'linking',
    fromTaskId: target.taskId,
    sourceRow: target.row,
    toTaskId: null,
    toRow: null,
    exitSide,
  };
  return updateForLink(state, args);
}

/** 建线的每一帧与松手（**包内可见**：调用方是状态机；不进包入口）。 */
export function updateForLink(
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
      dragOutcome: null,
    };
  }

  const candidate = buildCandidateLink({
    document: args.document,
    schedule: args.schedule,
    view: args.view,
    calendar: args.calendar,
    fromTaskId: state.fromTaskId,
    toTaskId: state.toTaskId,
    exitSide: state.exitSide,
  });
  /**
   * **不能解析出候选边时保持手势存活**（第五次人工复验的**真正根因**）。
   *
   * 旧写法是 `return idleGesture()` —— 那一刻手势被**终止**：锚点清空、后续 `mousemove` 因为
   * `state.kind === 'idle'` 被全部忽略、松手也不提交。而"指针还在源任务那一行"（拖动开始时几乎必然
   * 出现：手指先按在方块的左内缘、再往右拖；或拖到同一行的另一处）就会让
   * `fromTaskId === toTaskId` ⇒ 候选为 `null` ⇒ **整条手势作废**。
   * 实测（CDP 真实指针 + 页内探针）：`link-target=t3`（= 源任务）→ `candidate NULL` → 状态 `idle`，
   * 之后 5 次移动全部被忽略、松手不落库。
   *
   * 正确语义：**这一帧没有目标**，而不是"取消整条手势"。因此回到 `toTaskId: null` 的
   * `linking` 状态（与"刚按下、还没移到任何目标行"同态），把预览清空、把锚点与手势一起保留。
   */
  if (candidate === null) {
    return {
      state: { ...state, toTaskId: null, toRow: null },
      gestureToken: `link:${state.fromTaskId}`,
      anchors: [],
      commands: [],
      link: null,
      rows: [...rows].sort((left, right) => left - right),
      edges: [...edges].sort((left, right) => left - right),
      cyclePath: [],
      preview: null,
      dragOutcome: null,
    };
  }

  const cycle = wouldCreateCycle(args.document.links, candidate.link);
  const rejected = cycle.cyclic || candidate.duplicate;
  const reason: 'cycle' | 'duplicate' | null = cycle.cyclic ? 'cycle' : candidate.duplicate ? 'duplicate' : null;
  const preview: LinkPreview = {
    fromTaskId: state.fromTaskId,
    toTaskId: state.toTaskId,
    type: candidate.link.type,
    lagDays: candidate.link.lagDays,
    exitPoint: candidate.exitPoint,
    enterPoint: candidate.enterPoint,
    // 拖动期就用"警戒色"呈现两种拒绝（`cyclic` 在渲染层同时驱动成环路径的高亮）。
    cyclic: rejected,
    duplicate: candidate.duplicate,
    cyclePath: cycle.path,
    reason,
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
      dragOutcome: null,
    };
  }

  if (rejected) {
    // 预检即拒绝（ADR 0008 §7）：不提交、只高亮成环路径。
    return {
      state: { kind: 'rejected', fromTaskId: state.fromTaskId, toTaskId: state.toTaskId, reason: reason ?? 'cycle' },
      gestureToken: null,
      anchors: [],
      commands: [],
      link: null,
      rows: [...rows].sort((left, right) => left - right),
      edges: [...edges].sort((left, right) => left - right),
      cyclePath: cycle.path,
      preview,
      dragOutcome: null,
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
    dragOutcome: null,
  };
}

/**
 * 建线的四件事：**出端侧**由连接点（或 `Alt` 兼容路径）给、**入端侧**由目标相对位置给、
 * **类型**由两者经 {@link linkTypeFor} 判定、**id** 由调用方给（命令层不生成 id）、`lagDays = 0`。
 *
 * ADR 0008 §16.3（裁决 P-32）取代 §7 的"起点 = 条的上/下沿中点、类型由相对位置两分支"：
 * 旧式只能产出 `FS`/`SS`，因为出端侧被"目标在右就在右"绑死了；现在出端侧是**用户的显式选择**，
 * 四类关系都可达（右出+左入 = `FS`、右出+右入 = `FF`、左出+左入 = `SS`、左出+右入 = `SF`）。
 */
function buildCandidateLink(args: {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly view: ViewModel;
  readonly calendar: Calendar;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly exitSide: 'left' | 'right';
}): {
  readonly link: DocumentLink;
  readonly duplicate: boolean;
  readonly exitPoint: readonly [number, number];
  readonly enterPoint: readonly [number, number];
} | null {
  if (args.fromTaskId === args.toTaskId) return null;
  const from = boundsOf(args, args.fromTaskId);
  const to = boundsOf(args, args.toTaskId);
  if (from === null || to === null) return null;
  /**
   * **入端侧由关系类型给，不由相对位置给**（P-32 落地时的一次订正）。
   *
   * 相对位置的作用是**判定类型**（`linkEnterSideFor`）；一旦类型定了，出入边就由
   * **P-8 第 1 条**背书的 `routeSides(type)` 决定（`FS`/`SS` 左入、`FF`/`SF` 右入）。
   * 若这里再按"目标在左就在右"取一次端点，就会出现**边自身声明 FS、端点却落在目标右缘**
   * 这种自相矛盾（`routeEdge` 按类型把折点引到左缘）——预览与提交的几何因此会分叉。
   */
  const decideEnterSide = linkEnterSideFor({
    exitSide: args.exitSide,
    fromXLeft: from.xLeft,
    toXLeft: to.xLeft,
  });
  const type = linkTypeFor(args.exitSide, decideEnterSide);
  const enterSide = routeSides(type).enter;
  const lagDays = 0;
  /**
   * **重复边**（第五次人工复验的第 3 条）：同 `from`/`to`/`type`/`lagDays` 的边已存在 ⇒ 拒绝建线。
   *
   * 为什么放在这里而不是只在松手时查：拖动期就该**看得见**（预览标红），否则用户会先看到一条
   * 像模像样的预览、以为能连，松手却什么都没发生（等于"静默失败"——本仓库明确否掉的降级方案）。
   * 与 `wouldCreateCycle` 的关系：两者都是**预检拒绝**，但"重复"不是环（既不改变图，也不该高亮路径）。
   */
  const duplicate = args.document.links.some(
    (link) => link.from === args.fromTaskId && link.to === args.toTaskId && link.type === type && link.lagDays === lagDays,
  );
  const link: DocumentLink = {
    id: suggestLinkIdFor(args.document, args.fromTaskId, args.toTaskId, type),
    from: args.fromTaskId,
    to: args.toTaskId,
    type,
    lagDays,
  };
  return {
    link,
    duplicate,
    exitPoint: [exitXFor(from, args.exitSide), from.y],
    enterPoint: [enterXFor(to, enterSide), to.y],
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

/**
 * 与 `taskId` 相关的边（`document.links` 的下标）——**包内可见**：拖动期与建线期都要给
 * {@link GestureUpdate.edges} 出"要重绘哪些边"，两处必须同一口径（边的几何只由两端点决定）。
 */
export function linkIndexesTouching(document: ProjectDocument, taskId: string): readonly number[] {
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
