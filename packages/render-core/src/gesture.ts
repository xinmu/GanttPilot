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
 *
 * ## 第三处订正：候选序号是**抓取点相对**的，且按模式分别定义（裁决 P-22，ADR 0008 §13）
 *
 * P-21 的人工复核把"按下即跳位 / 右侧空白点击工期翻倍"归给 R1（指针坐标参照物取错）。
 * 落地批次 A 时发现**归因不完整**：`pointerStartX` 存了却从未被使用，而候选一直是
 * `ordinalAtX(pointer.x)` 的**绝对**语义——于是修好 R1 之后，"条体左端跳到鼠标位置"仍然成立；
 * 而 `resize-duration` 的 patch 写作 `候选 − 原开始 + 工期`，在右端**按下不移动**就会把工期
 * 翻成约 `2D − 1`。这正是复核第 7 项"向右拉条体跟手、**松手回原位**但日期仍变"的字面成因。
 *
 * 现在的口径（三条一起读）：
 *
 * | 模式 | 候选的语义 | 松手 patch |
 * |---|---|---|
 * | `move` | 新**开始**序号 = `originOrdinal + delta` | `{startDate, endDate}`（工期不变） |
 * | `resize-start` | 新**开始**序号 = `originOrdinal + delta` | `{startDate, durationDays}`（**不含** `endDate` ⇒ 完成日不变） |
 * | `resize-duration` | 新**完成**序号 = `originOrdinal + max(1, D) − 1 + delta` | `{durationDays, endDate}`（**不含** `startDate`） |
 *
 * `delta` 一律是"当前指针的序号 − **抓取点**的序号"（{@link deltaFor}），因此**按下不动 = 零位移**：
 * 手势不产出任何命令，文档一字不改（这是"按下即重绘"的负向对照）。
 * `resize-duration` 拖动期条体**本体不动**（会话锚点只有 `startOrdinal`，ADR 0004 §2 的形状不扩），
 * 用户看到的是 {@link dragPreviewFor} 给出的**预览轮廓**——预览与松手提交共用
 * {@link resolveDragOutcome}，所以"看到的"与"松手得到的"不可能分叉。
 */

import {
  wouldCreateCycle,
  type Calendar,
  type DocumentLink,
  type ProjectDocument,
  type Schedule,
  type SessionAnchor,
} from '@ganttpilot/engine';

import { barXRange, milestoneCenterX, taskBounds, type TaskBounds } from './domain.js';
import { HIT_TOLERANCE_PX, SPACING, type ZoomKey } from './manifest.js';
import { routeSides } from './route.js';
import { dayAtX, type RowBox, type ViewModel } from './viewModel.js';
import { dragModeOfZones, enterXFor, exitXFor, linkEnterSideFor, linkTypeFor, zonesFor } from './zones.js';

/** 拖拽语义（ADR 0008 §5）：判定区决定 `mode`。 */
export type DragMode = 'move' | 'resize-start' | 'resize-duration';

/** 违反依赖时的策略（IX-05 / ADR 0008 §6）。 */
export type AnchorMode = 'snap' | 'allow';

/** 归一化指针输入：**绝不是** DOM 事件对象。 */
export interface PointerInput {
  /**
   * **内容坐标系**的 `x` / `y`：屏幕坐标必须先经 `pointerFromClient` 归一化
   * （`x = clientX − paneLeft + scrollLeft`、`y = clientY − paneTop + scrollTop`，ADR 0008 §13.1）。
   * 本包内**所有**几何消费方（`resolvePointerTarget`、`dayAtX`/`ordinalAtX`、`barHitFor`、
   * `dragModeFor`）都按内容坐标取值，**任何一处再叠加一次 `scroll*` 都是重复计数**
   * （P-25 的 R13/R14 就是这两处）。
   */
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
  readonly shiftKey?: boolean;
  /** `Esc` 被按下（取消手势）。 */
  readonly escPressed?: boolean;
}

/** {@link pointerFromClient} 的入参：**只有数字**（本包零 DOM，不收 `MouseEvent`/`DOMRect`）。 */
export interface ClientPointerArgs {
  readonly clientX: number;
  readonly clientY: number;
  /** 图表窗格（内容视口）左上角的**屏幕**坐标——即 `pane.getBoundingClientRect()` 的 `left`/`top`。 */
  readonly paneLeft: number;
  readonly paneTop: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly buttons: number;
  readonly shiftKey?: boolean;
  readonly escPressed?: boolean;
}

/**
 * **屏幕坐标 → 内容坐标**的唯一换算（ADR 0008 §13；P-22 批次 A 的 R1）。
 *
 * ```
 * x = clientX − paneLeft + scrollLeft
 * y = clientY − paneTop  + scrollTop
 * ```
 *
 * 为什么不能再用 `MouseEvent.offsetX` / `offsetY`：它们**相对事件目标元素**——
 * `mousedown` 落在条体 `<rect>` 上时目标就是那个条，于是 `offsetX ≈ 0` 被当成内容坐标，
 * 候选序号随即变成"鼠标所在的屏幕位置"（P-21 §2 的 R1）。
 * 归一化放在本包而不是组件里，是因为"入口层算出来的输入"正是 P-19/P-21 两次都漏掉的判据面。
 */
export function pointerFromClient(args: ClientPointerArgs): PointerInput {
  return {
    x: args.clientX - args.paneLeft + args.scrollLeft,
    y: args.clientY - args.paneTop + args.scrollTop,
    buttons: args.buttons,
    ...(args.shiftKey === true ? { shiftKey: true } : {}),
    ...(args.escPressed === true ? { escPressed: true } : {}),
  };
}

/**
 * 指针是否**命中条体**（ADR 0008 §13；P-22 批次 A 的 R2）。
 *
 * 判据只有横向一条：`x ∈ [xLeft − 容差, xRight + 容差]`。
 * - 里程碑的 `xLeft`/`xRight` 已经是**菱形包围盒**的左右界（`domain.ts` 的菱形分支），
 *   因此"含里程碑包围盒"不需要第二条规则；
 * - **竖向不设限**：行（固定行高，ADR 0007 §4）就是竖向单位——再加一条"必须落在条高内"
 *   只会新增"点在行内条的上下 3 px 就拖不动"的失败面，而它并不是复核指出的缺陷。
 */
export function barHitFor(args: {
  readonly bounds: TaskBounds;
  readonly x: number;
  readonly tolerancePx?: number;
}): boolean {
  const tolerance = args.tolerancePx ?? HIT_TOLERANCE_PX;
  return args.x >= args.bounds.xLeft - tolerance && args.x <= args.bounds.xRight + tolerance;
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
  // **`args.y` 已是内容坐标**（`pointerFromClient` 归一化时已加 `scrollTop`）⇒ 这里不得再加一次。
  // 历史坑（P-25 的 R13）：原来是 `(y + view.scrollTop) / rowHeight`，于是**一向下滚动就再也命不中**
  // （行号凭空多出 `scrollTop / rowHeight` 行、落到渲染窗口之外），而 `scrollTop = 0` 处完全正常。
  const row = Math.floor(args.y / view.rowHeight);
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

/**
 * 当前指针相对**抓取点**的工作日位移（ADR 0008 §13 的唯一换算处）。
 *
 * 两个序号都由 {@link ordinalAtClamped} 产出（越界夹回边界，不抛错），因此
 * "指针拖出地平线"不会让位移变成 `NaN`，而是停在一个有界值上。
 */
export function deltaFor(args: {
  readonly view: ViewModel;
  readonly calendar: Calendar;
  readonly pointerX: number;
  readonly grabOrdinal: number;
}): number {
  return ordinalAtClamped(args.view, args.pointerX, args.calendar) - args.grabOrdinal;
}

/**
 * 候选序号：**按模式**给基线再加位移（ADR 0008 §13 的语义表）。
 *
 * - `move` / `resize-start`：基线 = 原**开始**序号（`originOrdinal`）；
 * - `resize-duration`：基线 = 原**完成**序号，即 `originOrdinal + max(1, D) − 1`。
 *   零时长任务（里程碑）的基线因此是 `originOrdinal` 本身（它"占着"一个工作日格），
 *   于是"把它往右拖到第 n 天"得到 n 个工作日的工期（`dragModeFor` 对里程碑右半区的注释正是这个意思）；
 *   而**按下不动**由 {@link resolveDragOutcome} 的"零位移"分支兜住，不会把里程碑变成 1 天。
 *
 * **不在这里夹取**：夹取按模式分工在 {@link dragCandidate}（`snap` 的上界）与
 * {@link resolveDragOutcome}（结果的 0 下界）里做，以免把"位移"与"结果"混在一起算。
 */
export function candidateOrdinalFor(args: {
  readonly mode: DragMode;
  readonly originOrdinal: number;
  readonly durationDays: number;
  readonly delta: number;
}): number {
  if (args.mode === 'resize-duration') {
    return args.originOrdinal + Math.max(1, args.durationDays) - 1 + args.delta;
  }
  return args.originOrdinal + args.delta;
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

/**
 * `render-core` 的反算（这里再包一层只是为了让 catch 有明确的落点）。
 *
 * **必须委托给 `dayAtX`**：这里原来把同一个公式**抄了第二份**（且同样多加了 `view.scrollLeft`），
 * 于是"修了 `dayAtX` 却漏了这一处"是必然的（P-25 实测：向右滚 600 px 时候选偏约 19 个工作日）。
 * 反算公式**只有一处**（`viewModel.ts` 的 `dayAtX`）。
 */
function ordinalAtXSafe(view: ViewModel, x: number, calendar: Calendar): number {
  return calendar.ordinalOfDay(Math.floor(dayAtX(view, x)));
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
   * 而 `interaction.ts` 需要 `gesture.ts` 的 `resolvePointerTarget`/`barHitFor`。
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

/**
 * 序号 → ISO：**越界返回 `undefined` 而不抛错**（地平线之外 = 无法表示）。
 *
 * 为什么必须有这一层：`Calendar.isoOfOrdinal` 在 `序号 > workdayCount` 时**抛错**
 * （`date.ts` 的 `dayOfOrdinal`），而拖动可以把结果推到地平线之外。旧实现直接调它，
 * 于是"拖到最右侧"会从事件处理器里抛出异常；批次 A 又把同一批换算用进了**渲染期的预览**，
 * 抛错会升级成渲染错误——因此这里统一收口为"不可表示"。
 */
function isoOfOrdinalSafe(calendar: Calendar, ordinal: number): string | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 0) return undefined;
  try {
    return calendar.isoOfOrdinal(ordinal);
  } catch {
    return undefined;
  }
}

/** 日历上最后一个可表示的**工作日**序号（上界一律夹回，与 `ordinalAtClamped` 同精神）。 */
function maxOrdinalOf(calendar: Calendar): number {
  return Math.max(0, calendar.workdayCount - 1);
}

function beginLinking(args: BeginGestureArgs, target: HitTarget, exitSide: 'left' | 'right'): GestureUpdate {
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

/**
 * 候选序号（**含按模式的夹取**，ADR 0008 §13）。
 *
 * 分工必须写清，否则两处夹取会打架：
 * - `snap`：把**开始**语义的候选夹到 `[0, 入边约束]`（`snapCandidate`）。约束是"开始"的上界，
 *   而 `es ≥ 约束` 恒成立（`ES = max(约束, 锚点)`），因此**按下第一帧不会跳位**；
 * - `allow`：原样放行（早于约束时由 `compute` 报 `anchorConflict`，UI 标红）；
 * - `resize-duration`：**不夹取**——它的候选是"新完成序号"，约束与 0 下界都在
 *   {@link resolveDragOutcome} 里按结果处理（完成序号允许先落到低于开始的位置，再由最小工期兜住）。
 *
 * **入参一律来自"被拖的那个任务"**（`taskId` + `durationDays` + `originOrdinal`），
 * 不取"指针当前所在行"：跨行拖动时也不该换一个基准（v0.1 不支持改层级）。
 */
function dragCandidate(args: {
  readonly mode: DragMode;
  readonly pointerX: number;
  /** 位移的**绝对基准** = 按下时该任务的开始序号。 */
  readonly originOrdinal: number;
  readonly durationDays: number;
  readonly taskId: string;
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly anchorMode: AnchorMode;
  readonly grabOrdinal: number;
  /** 可省略（省略时按指针重算）。 */
  readonly delta?: number;
}): number {
  const delta =
    args.delta ??
    deltaFor({
      view: args.view,
      calendar: args.calendar,
      pointerX: args.pointerX,
      grabOrdinal: args.grabOrdinal,
    });
  const raw = candidateOrdinalFor({
    mode: args.mode,
    originOrdinal: args.originOrdinal,
    durationDays: args.durationDays,
    delta,
  });
  // 上界夹回日历地平线（`isoOfOrdinal` 越界会抛错；下界交给各模式的结果解析，`allow` 刻意放行负数）。
  const bounded = Math.min(raw, maxOrdinalOf(args.calendar));
  if (args.mode === 'resize-duration' || args.anchorMode === 'allow') return bounded;
  const constraint = entryConstraintFor({
    document: args.document,
    schedule: args.schedule,
    taskId: args.taskId,
    durationDays: args.durationDays,
  });
  return snapCandidate({ candidate: bounded, constraint, minOrdinal: 0 });
}

function releaseGesture(args: ReduceGestureArgs): GestureUpdate {
  const { state } = args;
  if (state.kind === 'dragging') return updateForDrag(state, args, true);
  if (state.kind === 'linking') return updateForLink(state, args, true);
  return idleGesture();
}

// ---------------------------------------------------------------- 产出构造

/** {@link resolveDragOutcome} 的产出：拖动**结果**的完整描述（锚点、预览区间、松手命令）。 */
export interface DragOutcome {
  /** 相对抓取点的**工作日位移**（0 = 按下不动）。 */
  readonly delta: number;
  /** 会话锚点的开始序号（`resize-duration` 用原开始 ⇒ 条体本体不动）。 */
  readonly anchorOrdinal: number;
  /** 结果的开始序号（条形分支的 `es`）。 */
  readonly es: number;
  /** 结果的**排他**结束序号（条形分支的 `ef`；`resultDuration ≤ 0` 时等于 `es`）。 */
  readonly ef: number;
  /** 结果的工期（正数 = 条形；`≤ 0` = 仍是里程碑/零时长）。 */
  readonly resultDuration: number;
  /** 松手要提交的 patch；**`null` = 本次手势无操作**（按下不动）。 */
  readonly patch: Record<string, unknown> | null;
}

/**
 * 拖动结果解析：**锚点、预览几何与松手命令的唯一来源**（ADR 0008 §13）。
 *
 * 三件事都在这里定，因此"看到的预览"与"松手得到的文档"不可能分叉：
 * 1. **候选 → 结果序号**按模式分工（`move`/`resize-start` 的候选是新开始；
 *    `resize-duration` 的候选是新完成，并夹到不早于原开始）；
 * 2. **零位移不产出命令**：`resize-duration` 按 `delta === 0` 判定
 *    （按住里程碑右半区不动**不得**把它变成 1 天任务），其余两模式按"结果开始 == 原开始"判定
 *    （指针拖到项目起点左侧被夹回时也算无操作）；
 * 3. **零时长的完成日 = 开始日**：与 `derivedEndIso` / `cellText` 同口径
 *    （P-20 在显示层修过同一个式子，拖拽 patch 此前漏了）。
 */
export function resolveDragOutcome(args: {
  readonly state: Extract<GestureState, { kind: 'dragging' }>;
  readonly document: ProjectDocument;
  readonly calendar: Calendar;
}): DragOutcome | null {
  const { state } = args;
  const task = args.document.tasks.find((item) => item.id === state.taskId);
  if (task === undefined) return null;
  const duration = task.durationDays ?? 0;
  const origin = state.originOrdinal;
  const base = candidateOrdinalFor({
    mode: state.mode,
    originOrdinal: origin,
    durationDays: duration,
    delta: 0,
  });
  const delta = state.candidate - base;

  if (state.mode === 'resize-duration') {
    const endOrdinal = Math.max(origin, state.candidate);
    const resultDuration = Math.max(1, endOrdinal - origin + 1);
    // 完成日超出地平线 ⇒ `null`（**派生显示值**的既有口径：与 `editToCommand` 的工期分支同形，
    // 左表会回落到"开始 + 工期"的显示值，而不是一个错的日期，也不抛错）。
    const endIso = isoOfOrdinalSafe(args.calendar, origin + resultDuration - 1);
    return {
      delta,
      anchorOrdinal: origin,
      es: origin,
      ef: origin + resultDuration,
      resultDuration,
      // 按住不动 ⇒ 无操作（否则里程碑会被"按一下"变成 1 天任务）。
      patch: delta === 0 ? null : { durationDays: resultDuration, endDate: endIso ?? null },
    };
  }

  const es = Math.max(0, state.candidate);
  const startIso = isoOfOrdinalSafe(args.calendar, es);

  if (state.mode === 'resize-start') {
    // 改开始：完成日**不动** ⇒ 工期随之变化（不小于 1）。patch 不含 `endDate`。
    const resultDuration = Math.max(1, duration - (es - origin));
    return {
      delta,
      anchorOrdinal: es,
      es,
      ef: es + resultDuration,
      resultDuration,
      patch:
        es === origin || startIso === undefined
          ? // 开始序号不可表示（地平线之外）⇒ 整条手势无从落地，按"无操作"处理。
            null
          : {
              startDate: startIso,
              durationDays: resultDuration,
            },
    };
  }

  // `move`：工期不变（含零时长——里程碑始终是里程碑），两端一起走。
  const endOrdinal = duration <= 0 ? es : es + duration - 1;
  const endIso = isoOfOrdinalSafe(args.calendar, endOrdinal);
  return {
    delta,
    anchorOrdinal: es,
    es,
    ef: duration <= 0 ? es : es + duration,
    resultDuration: duration,
    patch:
      es === origin || startIso === undefined
        ? null
        : { startDate: startIso, endDate: endIso ?? null },
  };
}

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
  };
}

/** {@link dragPreviewFor} 的产出：拖动覆盖层要画的那一段几何（内容坐标）。 */
export interface DragPreview {
  readonly taskId: string;
  /** 可见行序号（`-1` 不可能出现——行不可见时本函数返回 `null`）。 */
  readonly row: number;
  readonly xLeft: number;
  readonly xRight: number;
  /** 条/菱形的竖向中心。 */
  readonly y: number;
  readonly barY: number;
  readonly barHeight: number;
  readonly isMilestone: boolean;
  readonly milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null;
}

/**
 * 拖动预览几何：**与松手提交同源**（ADR 0008 §13）。
 *
 * 为什么需要它：会话锚点只有 `startOrdinal`（ADR 0004 §2 的形状不扩），因此
 * `resize-duration` 拖动期**条体本体不会动**、`resize-start` 拖动期的右端也会先"跟着走再回弹"。
 * 覆盖层改画**结果轮廓**（`move`/`resize-start` 用 `[候选, 候选 + 工期 − 1]`；
 * `resize-duration` 用 `[原开始, 候选]`），于是三种语义在拖动期都有诚实的可见反馈，
 * 而"看到的"与"松手得到的"共用 {@link resolveDragOutcome}，不会分叉。
 *
 * 里程碑：结果仍是零时长时按**菱形**出几何（`barXRange` 在 `ef − 1 = −1` 时按 `domain.ts`
 * 的口径会抛错，因此必须走菱形分支——与 `taskBounds` 的同一处判断同源）。
 */
export function dragPreviewFor(args: {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly calendar: Calendar;
  readonly state: GestureState;
}): DragPreview | null {
  const { view, state } = args;
  if (state.kind !== 'dragging') return null;
  const outcome = resolveDragOutcome({ state, document: args.document, calendar: args.calendar });
  if (outcome === null) return null;
  const docIndex = args.document.tasks.findIndex((task) => task.id === state.taskId);
  if (docIndex < 0) return null;
  const row = view.rowOfDocIndex[docIndex] ?? -1;
  if (row < 0) return null; // 折叠隐藏 ⇒ 没有可画的条（与 `taskBounds` 同口径）

  const rowHeight = view.rowHeight;
  const y = row * rowHeight + rowHeight / 2;

  /**
   * 几何一律**不许抛错**：本函数在渲染期被调用，而 `barXRange` / `milestoneCenterX` 在
   * 序号越出日历经线时会 `RangeError`/`fail`。拖到地平线之外时**没有可画的预览**（返回 `null`），
   * 由调用方保持上一帧的呈现——这与 `ordinalAtClamped`"越界夹回、不抛错"是同一条精神。
   */
  try {
    if (outcome.resultDuration <= 0) {
      const cx = milestoneCenterX({
        calendar: args.calendar,
        es: outcome.es,
        axisOriginDay: view.axisOriginDay,
        pxPerDay: view.pxPerDay,
      });
      const size = rowHeight * SPACING.milestoneSizeRatio;
      return {
        taskId: state.taskId,
        row,
        xLeft: cx - size / 2,
        xRight: cx + size / 2,
        y,
        barY: y - size / 2,
        barHeight: size,
        isMilestone: true,
        milestone: { cx, cy: y, size },
      };
    }

    const range = barXRange({
      calendar: args.calendar,
      es: outcome.es,
      ef: outcome.ef,
      axisOriginDay: view.axisOriginDay,
      pxPerDay: view.pxPerDay,
    });
    const barHeight = rowHeight * SPACING.barHeightRatio;
    return {
      taskId: state.taskId,
      row,
      xLeft: range.xLeft,
      xRight: range.xRight,
      y,
      barY: y - barHeight / 2,
      barHeight,
      isMilestone: false,
      milestone: null,
    };
  } catch {
    return null;
  }
}

/**
 * 一行**要画出来的条**（ADR 0008 §14 / 裁决 P-24）：拖动中的那一行画**结果几何**。
 *
 * 为什么需要它：会话锚点只有 `startOrdinal`（ADR 0004 §2 的形状不扩），因此拖动期
 * `compute` 给这一行的 `ef` 仍是"新开始 + **文档里的旧工期**"——
 * `resize-start` 于是表现成"整条平移、右端不固定"，`resize-duration` 则"条体本体不动"。
 * 而 {@link dragPreviewFor} 已经给出**与松手提交同源**的结果几何，本函数把它接到渲染侧：
 *
 * - 被拖行（`preview.taskId === row.id`）⇒ 用预览几何（`fromPreview: true`）；
 * - 其余行 ⇒ 原样用 `row` 自己的几何（不受影响）。
 *
 * **进度按比例跟随**：拖动期不重算进度，进度填充按 `结果宽度 × row.progressRatio` 画，
 * 这样 `resize-*` 期间它不会与轮廓脱节。
 */
export interface DrawnBar {
  readonly xLeft: number;
  readonly xRight: number;
  readonly y: number;
  readonly barY: number;
  readonly barHeight: number;
  readonly isMilestone: boolean;
  readonly milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null;
  /** `true` = 该行正在被拖动，几何来自预览（见 {@link dragPreviewFor}）。 */
  readonly fromPreview: boolean;
}

/** 该行要画的条：被拖行用**预览结果几何**，其余行用自身几何（ADR 0008 §14）。 */
export function drawnBarForRow(row: RowBox, preview: DragPreview | null): DrawnBar {
  if (preview !== null && preview.taskId === row.id) {
    return {
      xLeft: preview.xLeft,
      xRight: preview.xRight,
      y: preview.y,
      barY: preview.barY,
      barHeight: preview.barHeight,
      isMilestone: preview.isMilestone,
      milestone: preview.milestone,
      fromPreview: true,
    };
  }
  return {
    xLeft: row.xLeft,
    xRight: row.xRight,
    y: row.y,
    barY: row.barY,
    barHeight: row.barHeight,
    isMilestone: row.isMilestone,
    milestone: row.milestone,
    fromPreview: false,
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
