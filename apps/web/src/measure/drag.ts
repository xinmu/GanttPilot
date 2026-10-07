/**
 * 拖动测量（`--drag` / `--persist-drag`）：走`App.vue` 的**真实指针入口**，不另开测试后门。
 *
 * 判据见 ADR 0008 §11 与 [附录 §3（细则）](../../../docs/02-adr/附录/0008-增补.md)：
 * 抓取点自证（`gestureMode`）、位移、下游跟随、预览不落库、手柄/光标/连接点三类读数。
 */

import { nextTick } from 'vue';

import {
  CONNECT_SIZE_PX,
  entryConstraintFor,
  handleOffsetsFor,
  workdayCellCenterX,
  type FixtureSpec,
  type ProjectDocument,
  type Schedule,
  type ViewModel,
} from '@ganttpilot/render-core';

import { STABLE_READ_BUDGET_FRAMES, percentile, round, scrollFingerprint, settleStableRead } from './dom.js';

/**
 * `resize-duration` 轮的抓取点：条右端**内** 4 px（裁决 P-45）。
 *
 * 为什么是 4 而不是 2：右端那一带有**两个**判定面，抓在哪一侧是两件事——
 *
 * | 面 | 区间（内容坐标） | 谁赢 |
 * |---|---|---|
 * | 连接点（建线） | `[xRight − CONNECT_INSET_PX, …]` = **`[xRight − 2, …]`** | **优先**（ADR 0008 §16.3） |
 * | 端点判定区（改工期） | `[xRight − edgePx, xRight]` = `[xRight − 6, xRight]`（宽条） | 次之 |
 *
 * ⇒ 真正能起"改工期"的窗口是 `[xRight − 6, xRight − 2)`，取其中点 **4**。
 * 取 2 会落进连接点、起的是**建线**手势（本轮实测：`按下后未进入拖动（实际 linking）`）——
 * 所以判据另外用 `gestureMode` 自证真的判成了 `resize-duration`。
 *
 * 而"最后一个工作日格的中点"（= `move` 轮的抓法）离条右端有半个格子（日档 12 px），
 * 落在 `move` 判定区里 ⇒ 量到的会是整体移动。
 */
const RESIZE_GRAB_INSET_PX = 4;

/** 拖动测量的宿主：由 `App.vue` 提供的实时状态与真实指针入口。 */
export interface DragMeasurementHost {
  /** 当前渲染的视图模型（含 `scrollTop` / `pxPerDay` / 行序），用于把任务换算成屏幕坐标。 */
  readonly view: () => ViewModel | null;
  /** 文档与排程（挑选目标行：位移判据要求该行**无有效入边约束**，否则 `snap` 会夹住候选）。 */
  readonly document: () => ProjectDocument;
  readonly schedule: () => Schedule | null;
  readonly calendar: () => { dayOfOrdinal(ordinal: number): number; isoOfOrdinal(ordinal: number): string | undefined };  /** 真实指针入口（**与用户操作走同一条路径**）。 */
  readonly pointer: {
    readonly down: (event: MouseEvent) => void;
    readonly move: (event: MouseEvent) => void;
    readonly up: (event: MouseEvent) => void;
  };
  /** 拖动是否仍在进行（用于断言"松手后锚点已清空"）。 */
  readonly gestureKind: () => string;
  /**
   * 建线入口的判定（ADR 0008 §16.3／裁决 P-32）：走**与用户操作同一条路**的 `linkEntryFor`。
   *
   * 记录制用它核对"连接点真的能起建线、端点手柄真的不能"——这两条都是**入口层**的性质，
   * 而入口层此前没有判据（P-19/P-21 的同一教训）。纯函数的判据在 `interaction.spec.ts`（进门禁）。
   */
  readonly entryPointOf?: (clientX: number, clientY: number) => { readonly taskId: string; readonly exitSide: 'left' | 'right' } | null;
  /** 光标提示的分类（记录制核对"端点/中部/连接点"给出三种不同光标）。 */
  readonly cursorAt?: (clientX: number, clientY: number) => string;
  /**
   * 把"指针在某屏幕点"这件事交给应用（= 触发连接点的显形判定）。
   *
   * 连接点**只在指针靠近该行条端时**发射（P-32 复验第 3.2 条），因此记录制必须先
   * "把指针放到那里"，再读 DOM 上的条数——否则量到的是 0（**假红**）。
   */
  readonly hoverAt?: (clientX: number, clientY: number) => void;
  /** 指针离开（收尾复位）。 */
  readonly clearHover?: () => void;
  readonly anchors: () => number;
  /** 松手后落到文档里的 `startDate`（断言"命令真的落库了"）。 */
  readonly startDateOf: (taskId: string) => string | null;
  /**
   * 松手后落到文档里的**工期**（P-45：`resize-duration` 的位移判据是工期，不是 `startDate`）。
   */
  readonly durationOf: (taskId: string) => number | null;
  /**
   * 会话的**已提交修订号**（P-45 的"预览不落库"判据：拖动期它必须**一字不动**）。
   *
   * 它只随命令/事务前进（ADR 0003），因此"预览副本进 `compute`"与"文档被改"是两件
   * 可区分的事——判据要的正是这个区分，而不是"看起来没变"。
   */
  readonly revision: () => number;
  /**
   * 手势内核**当前把这一帧判成了什么语义**（`move` / `resize-start` / `resize-duration`；非拖动为 `null`）。
   *
   * 记录制必须能自证"真的抓在右端"：否则"拖了但抓成了中部"会让 P-45 的采样
   * 悄悄退化成整体移动（那种绿是**恒真式**）。
   */
  readonly gestureMode: () => string | null;
}

/** 拖动测量的结果（记录制：帧预算与松手耗时都不进 `pnpm gate`）。 */
export interface DragMeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  readonly taskId: string;
  readonly dayDelta: number;
  readonly frames: number;
  /** 拖动期每个测试帧的"主线程同步工作量"（只含事件派发 + Vue 更新，不含帧等待）。 */
  readonly mainThreadMs: readonly number[];
  readonly mainThreadP50Ms: number;
  readonly mainThreadP95Ms: number;
  /** 拖动期连续 rAF 的帧间隔（记录用；目标 ≥30 fps ⇒ ≤33.3 ms）。 */
  readonly frameGapsMs: readonly number[];
  readonly frameGapP50Ms: number;
  readonly frameGapP95Ms: number;
  readonly longTasks: number;
  /** 松手 → 命令落库 + 重算 + 冲突标记完成 的墙钟。 */
  readonly releaseMs: number;
  /** 拖动中是否观察到 DOM 上的条形位置变化（"下游跟随"的间接证据）。 */
  readonly observedGeometryChanges: number;
  readonly anchorsAfterRelease: number;
  readonly documentStartAfter: string | null;
  /** 拖动前该行的开始序号（**绝对基准**：位移按它 + `dayDelta` 断言）。 */
  readonly anchorOrdinal: number | null;
  /** 本轮的滚动位置（P-25：滚动状态下的拖动必须与未滚动时同样成立）。 */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** 期望的松手后 `startDate`（= `isoOfOrdinal(anchorOrdinal + dayDelta)`）。 */
  readonly expectedStartAfter: string | null;
  /** 本轮采样的语义：`move`（整体移动）或 `resize-duration`（改工期；P-45 的探针）。 */
  readonly mode: 'move' | 'resize-duration';
  /** 内核判定的语义（自证"抓对了地方"；`null` = 按下后没进拖动）。 */
  readonly gestureMode: string | null;
  /** 拖动前的工期（`resize-duration` 的位移基准）。 */
  readonly durationBefore: number | null;
  readonly durationAfter: number | null;
  /** 期望的松手后工期（= `durationBefore + dayDelta`）。 */
  readonly expectedDurationAfter: number | null;
  /** 拖动前 / 拖动期 / 松手后的**已提交修订号**（P-45：拖动期必须相等）。 */
  readonly revisionBefore: number;
  readonly revisionDuringDrag: number;
  readonly revisionAfterRelease: number;
  /**
   * **下游跟随的正面判据**（P-45，只在 `resize-duration` 轮有值）。
   *
   * 取一条**真正由被拖任务的有效完成日决定**的后继边（FS/FF/SF，且该边是它的**紧约束**），
   * 记录它的开始序号在三个时刻的值：拖动前 / 拖动期（预览副本生效）/ 松手后（落库）。
   * 判据 = `during === after`（预览 == 提交）**且** `after !== before`
   *   （后者是**前提自证**：这条边真的会跟着动，否则"相等"是恒真式）。
   */
  readonly downstream: {
    readonly taskId: string;
    readonly linkType: string;
    readonly before: number;
    readonly during: number;
    readonly after: number;
  } | null;
  /** 批次 B 的记录制采样：手柄可见性、连接点起手、光标分类（ADR 0008 §16.2/§16.3）。 */
  readonly handles: {
    /** 渲染行组数（`data-task-id` 的 `<g>`）。 */
    readonly rowGroups: number;
    /** DOM 上手柄的条数（`line.handle`）。 */
    readonly domHandles: number;
    /**
     * DOM 上连接点的条数（`.connect-point`，**不限定标签**：批次③起它是 `<circle>`）。
     *
     * **只对"指针所在的那一行"计数**（连接点按需显形，P-32 复验第 3.2 条），
     * 因此判据是 `= 2`（该行的左右两点）而不是"等于全部渲染行的 2×n"。
     */
    readonly domConnectPoints: number;
    /** 模型侧应当发射的手柄条数（`handleOffsetsFor` 的合计）。 */
    readonly modelHandles: number;
    /** 模型侧应当发射的连接点条数（**全部渲染行** × 2；与 DOM 的口径差在"按需显形"）。 */
    readonly modelConnectPoints: number;
    /** 按下"条体中部"时的光标（期望 `move`）。 */
    readonly cursorOnBar: string;
    /** 按下"端点手柄"处的光标（期望 `col-resize`）。 */
    readonly cursorOnEdge: string;
    /** 按下"连接点"处的光标（期望 `crosshair`）。 */
    readonly cursorOnConnect: string;
    /** 从连接点按下是否真的进入 `linking`（**R4 的可判定形式**）。 */
    readonly connectDownEntersLinking: boolean;
    /** 采样到的连接点**左缘**（内容坐标；`null` = 该行没发射连接点）。 */
    readonly connectLeftEdge: number | null;
    /** 连接点的 DOM 标签（P-42 批次③：必须是 `circle`）。 */
    readonly connectTag: string;
    /** 连接点可见盒的宽 × 高（px；圆的外接盒必须**是正方形**）。 */
    readonly connectBox: { readonly width: number; readonly height: number } | null;
  } | null;
}

/**
 * 把任务换算成屏幕坐标（内容坐标 + 窗格偏移）。
 *
 * **必须传 `anchorOrdinal`（拖动前的开始序号），不能用当前视图里的 `row.es`**：
 * 拖动期视图带着**会话锚点**重算，`row.es` 会跟着候选走，用它当基准会让
 * "每帧按当前位置再前进一段"累积成加速拖动——那样"拖 3 个工作日"就不成立了。
 * 抓取点是第一个工作日格的**中点**（其序号恰好是 `anchorOrdinal`）——
 * 公式住在 `render-core` 的 `workdayCellCenterX`（**唯一实现处**；P3/C6-a 之前这里与
 * 持久化探针各写了一遍）。
 */
export function dragScreenPoint(
  host: DragMeasurementHost,
  pane: HTMLElement,
  taskId: string,
  anchorOrdinal: number,
  ordinalOffset: number,
): { readonly clientX: number; readonly clientY: number } | null {
  const view = host.view();
  if (view === null) return null;
  const row = view.rows.find((item) => item.id === taskId);
  if (row === undefined) return null;
  const calendar = host.calendar();
  const contentX = workdayCellCenterX({
    calendar,
    ordinal: anchorOrdinal + ordinalOffset,
    axisOriginDay: view.axisOriginDay,
    pxPerDay: view.pxPerDay,
  });
  const contentY = row.row * view.rowHeight + view.rowHeight / 2;
  const rect = pane.getBoundingClientRect();
  return {
    clientX: rect.left + contentX - view.scrollLeft,
    clientY: rect.top + contentY - view.scrollTop,
  };
}

/**
 * 跑一次拖动测量（G5 出口条件 ① ②，**记录制**）。
 *
 * 口径（必须与数字一起引用）：
 * - 用**真实指针事件**驱动（`mousedown → mousemove×N → mouseup`），与用户路径一致；
 * - **主线程工作量** = 派发事件 + `await nextTick()`（不含帧等待）——与 G4 的滚动口径同源；
 * - **帧间隔**用连续 rAF 记录，只作记录（≥30 fps ⇒ p95 ≤ 33.3 ms）；
 * - **松手耗时** = `mouseup` → 命令落库 + `compute` + 覆盖层清空 的墙钟；
 * - **位移判据（P-22 补上）**：松手后的文档 `startDate` 必须等于「拖动前的开始序号 + `dayDelta`
 *   个工作日」。旧证据只断言"非空"，因此"拖了但没有效位移"也会算通过（该恒真式已删除）。
 * - **`mode = 'resize-duration'`**（P-45 的探针）：抓**条右端**改工期，位移判据换成
 *   "松手后的 `durationDays` = 拖动前工期 + `dayDelta`"，并额外采**下游跟随**与**预览不落库**
 *   两条这个模式独有的判据（见 {@link DragMeasureResult.downstream}）。
 */export async function runDragMeasurement(args: {
  readonly host: DragMeasurementHost;
  readonly fixtureSpec: FixtureSpec;
  readonly dayDelta: number;
  readonly frames: number;
  /** 先把窗格滚到这里再拖（P-25：R13/R14 都**只在滚动后**现形）。 */
  readonly scrollTop?: number;
  readonly scrollLeft?: number;
  /** 采样的语义（默认整体移动；`resize-duration` 是 P-45 的探针）。 */
  readonly mode?: 'move' | 'resize-duration';
}): Promise<DragMeasureResult> {
  const mode = args.mode ?? 'move';
  const errors: string[] = [];
  const pane = document.getElementById('chart-pane');
  if (pane === null) {
    return emptyDragResult(args, ['找不到图表窗格（#chart-pane）']);
  }

  // 滚动到指定位置：**等读数稳定**（P-40 批次②；旧口径是写死的"两帧"）。
  // 不等就会在"状态已变、DOM 未变"的中间态上挑目标行与换算坐标——那样判据测的是别的东西；
  // 不稳定则直接判红，不静默用一个中间态的数字（P-12"缺失即失败"）。
  pane.scrollTop = args.scrollTop ?? 0;
  pane.scrollLeft = args.scrollLeft ?? 0;
  await nextTick();
  const settled = await settleStableRead({
    fingerprint: () => {
      const current = args.host.view();
      return scrollFingerprint(pane, {
        scrollTop: current?.scrollTop ?? -1,
        scrollLeft: current?.scrollLeft ?? -1,
        contentWidth: current?.contentWidth ?? -1,
      });
    },
  });
  if (!settled.stable) {
    return emptyDragResult(args, [
      `滚动到 (${String(args.scrollTop ?? 0)}, ${String(args.scrollLeft ?? 0)}) 后读数在 ` +
        `${String(STABLE_READ_BUDGET_FRAMES)} 帧内未稳定（应用未在预算内处理完滚动）`,
    ]);
  }

  /**
   * 目标行：两种语义的过滤条件**不同**（这也是为什么它不是一个函数）。
   *
   * - `move`：必须**无有效入边约束**——`snap` 会把候选夹到约束之下，否则"拖 N 天"这条
   *   位移判据对有前置的行**必然**报错（P-25 踩过：判据选错了样本，不是应用错了）；
   * - `resize-duration`：约束不影响它（该模式的候选不做吸附），但必须有一条**由它的完成日决定**
   *   的后继边——否则"下游跟随"没有可判定的载体。
   */
  const picked = mode === 'move' ? pickDragTarget(args.host) : pickResizeTarget(args.host);
  if (picked === null) {
    return emptyDragResult(args, [
      mode === 'move' ? '渲染窗口内没有可拖动的叶子任务' : '渲染窗口内没有"带有效后继边的叶子任务"（下游跟随判据的载体）',
    ]);
  }
  const target = picked;

  // **绝对基准**：拖动前该行的开始序号（拖动期视图会带着锚点重算，不能事后取）。
  const rowBefore = args.host.view()?.rows.find((item) => item.id === target.taskId) ?? null;
  const anchorOrdinal = rowBefore?.es ?? null;
  if (anchorOrdinal === null) {
    return emptyDragResult(args, ['无法取到目标任务在拖动前的开始序号（位移判据需要它作基准）']);
  }

  const durationBefore = args.host.durationOf(target.taskId);
  /**
   * 指针的序号基准：
   * - `move`：开始序号本身（抓的是第一个工作日格的中点）；
   * - `resize-duration`：**最后一个工作日**的序号 `origin + D − 1`（抓的是条右端）。
   */
  const pointerBaseOrdinal = mode === 'move' ? anchorOrdinal : anchorOrdinal + Math.max(1, durationBefore ?? 1) - 1;

  /**
   * 按下点：`move` 取第一个工作日格的中点；`resize-duration` 取**条右端内 2 px**
   * （必须落在 `edgeR = [xRight − edgePx, xRight]` 里——宽条 `edgePx = 6`）。
   * 右端由**视图自己的** `xRight` 给，不在这里重算几何。
   */
  const start =
    mode === 'move'
      ? dragScreenPoint(args.host, pane, target.taskId, pointerBaseOrdinal, 0)
      : rowBefore === null
        ? null
        : contentPointToScreen(pane, args.host, rowBefore.xRight - RESIZE_GRAB_INSET_PX, rowBefore.y);
  if (start === null) {
    return emptyDragResult(args, ['无法把目标任务换算成屏幕坐标']);
  }
  const dispatch = (type: 'down' | 'move' | 'up', point: { clientX: number; clientY: number }): void => {
    const event = new MouseEvent(type === 'down' ? 'mousedown' : type === 'move' ? 'mousemove' : 'mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
      buttons: type === 'up' ? 0 : 1,
      view: window,
    });
    if (type === 'down') args.host.pointer.down(event);
    else if (type === 'move') args.host.pointer.move(event);
    else args.host.pointer.up(event);
  };

  const mainThreadMs: number[] = [];
  const frameGapsMs: number[] = [];
  let observedGeometryChanges = 0;
  let previousGeometry = collectBarGeometry();

  const revisionBefore = args.host.revision();
  dispatch('down', start);
  await nextTick();
  const gestureModeOnDown = args.host.gestureMode();
  if (args.host.gestureKind() !== 'dragging') {
    errors.push(`按下后未进入拖动（实际 ${args.host.gestureKind()}）`);
  }
  /**
   * **自证抓对了地方**：`resize-duration` 轮里按下点必须真的被判成"改工期"。
   * 否则探针会悄悄退化成整体移动，而"下游跟随"在这种退化下**换个理由**也能成立——那样的绿是恒真式。
   */
  if (mode === 'resize-duration' && gestureModeOnDown !== 'resize-duration') {
    errors.push(`按下点未判成 resize-duration（实际 ${String(gestureModeOnDown)}）——条右端的抓取点没落在 edgeR 里`);
  }
  if (mode === 'move' && gestureModeOnDown !== 'move') {
    errors.push(`按下点未判成 move（实际 ${String(gestureModeOnDown)}）`);
  }

  let lastFrameAt = performance.now();
  const frames = args.frames;
  for (let index = 1; index <= frames; index += 1) {
    const offset = Math.round((args.dayDelta * index) / frames);
    const point = dragScreenPoint(args.host, pane, target.taskId, pointerBaseOrdinal, offset) ?? start;    const started = performance.now();
    dispatch('move', point);
    await nextTick();
    mainThreadMs.push(round(performance.now() - started));

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const now = performance.now();
        frameGapsMs.push(round(now - lastFrameAt));
        lastFrameAt = now;
        resolve();
      });
    });

    // "下游跟随"的间接证据：拖动期条形的几何（x/y/宽/高/点列）变化过（而不是只有覆盖层在动）。
    const geometry = collectBarGeometry();
    if (geometry !== previousGeometry) observedGeometryChanges += 1;
    previousGeometry = geometry;
  }

  /**
   * **拖动期最后一眼**（P-45）：两条判据都在"命令落地之前"取——
   * ① 已提交修订号（预览副本**不得**让它前进）；② 后继行的开始序号（它**应当**已经跟着预览走了）。
   */
  const revisionDuringDrag = args.host.revision();
  const downstreamDuring = target.successorId === undefined ? null : esOf(args.host, target.successorId);

  const releaseStart = performance.now();
  const endPoint = dragScreenPoint(args.host, pane, target.taskId, pointerBaseOrdinal, args.dayDelta) ?? start;  dispatch('up', endPoint);
  await nextTick();
  const releaseMs = round(performance.now() - releaseStart);
  const revisionAfterRelease = args.host.revision();

  // **位移判据**（P-22 补上）：`move` 看开始日、`resize-duration` 看工期。
  // 旧证据只断言"非空"，于是 `2026-10-05`（与拖前相同的项目起点）也被算作通过 —— 那是恒真式。
  const documentStartAfter = args.host.startDateOf(target.taskId);
  const durationAfter = args.host.durationOf(target.taskId);
  const expectedDurationAfter = durationBefore === null ? null : durationBefore + args.dayDelta;
  const expectedStartAfter = args.host.calendar().isoOfOrdinal(anchorOrdinal + args.dayDelta) ?? null;
  if (mode === 'move') {
    if (documentStartAfter !== expectedStartAfter) {
      errors.push(
        `拖动位移与文档不符：startDate = ${String(documentStartAfter)}，期望 ${String(expectedStartAfter)}` +
          `（拖动前开始序号 ${String(anchorOrdinal)} + ${String(args.dayDelta)} 个工作日）`,
      );
    }
  } else if (durationAfter !== expectedDurationAfter) {
    errors.push(
      `改工期的位移与文档不符：durationDays = ${String(durationAfter)}，期望 ${String(expectedDurationAfter)}` +
        `（拖动前工期 ${String(durationBefore)} + ${String(args.dayDelta)} 个工作日）`,
    );
  }

  /**
   * **P-45 的两条判据**（只在 `resize-duration` 轮）。
   *
   * ① **预览不落库**：拖动期已提交修订号必须与拖动前**逐位相等**——预览副本只进 `compute`，
   *    落库仍然只有"松手 → `task.update` 经命令层"这一条路（ADR 0003）；
   * ② **下游所见即所提交**：后继行的开始序号在"拖动期（预览生效）"与"松手后（已落库）"必须相等，
   *    且**与拖动前不同**（前提自证：这条边真的会跟着动；否则相等是恒真式）。
   */
  const downstream =
    target.successorId === undefined
      ? null
      : {
          taskId: target.successorId,
          linkType: target.linkType ?? '',
          before: target.successorEsBefore ?? -1,
          during: downstreamDuring ?? -1,
          after: esOf(args.host, target.successorId) ?? -1,
        };
  if (mode === 'resize-duration') {
    if (revisionDuringDrag !== revisionBefore) {
      errors.push(
        `拖动期文档被写了：revision ${String(revisionBefore)} → ${String(revisionDuringDrag)}（预览副本必须**不落库**）`,
      );
    }
    if (revisionAfterRelease === revisionBefore) {
      errors.push(`松手后 revision 未前进（${String(revisionAfterRelease)}）——命令没有落库`);
    }
    if (downstream === null) {
      errors.push('没有采到下游后继行（判据没有载体）');
    } else if (downstream.before === downstream.after) {
      errors.push(
        `下游跟随的前提不成立：后继 \`${downstream.taskId}\` 在拖动前后开始序号都是 ${String(downstream.after)}` +
          `（这条 ${downstream.linkType} 边不是它的紧约束 ⇒ 该样本判不了"预览 == 提交"）`,
      );
    } else if (downstream.during !== downstream.after) {
      errors.push(
        `下游未跟随预览：后继 \`${downstream.taskId}\` 拖动期 es = ${String(downstream.during)}，` +
          `松手后 = ${String(downstream.after)}（拖动期的下游仍按文档里的**旧工期**算）`,
      );
    }
  }

  let longTasks = 0;  if (typeof PerformanceObserver !== 'undefined') {
    // 记录制：只统计拖动期间已经产生的 longtask 条目（观察者本身不阻塞）。
    try {
      const entries = performance.getEntriesByType('longtask');
      longTasks = entries.length;
    } catch {
      longTasks = 0;
    }
  }

  // -------- 批次 B 的记录制采样（ADR 0008 §16.2/§16.3／裁决 P-32）
  // 这几条都属**入口层**性质（手柄是否在、光标是否分三类、连接点是否真的起建线）：
  // 纯函数判据在 `interaction.spec.ts`（进门禁），这里只采"打包产物上的真实 DOM"。
  const handles = await collectHandleSample(args.host, target.taskId);
  if (handles !== null) {
    if (handles.domHandles !== handles.modelHandles) {
      errors.push(`手柄条数与模型不符：DOM ${String(handles.domHandles)} vs 模型 ${String(handles.modelHandles)}`);
    }
    // 连接点按需显形：指针在目标行的条端上时，DOM 上应当只有**那一个行组**的两点。
    if (handles.domConnectPoints !== 2) {
      errors.push(
        `连接点未按需显形：指针在条端时该行应有 2 个（左右各一），实际 ${String(handles.domConnectPoints)}`,
      );
    }
    if (handles.cursorOnBar !== 'move') {
      errors.push(`条体中部按下点的光标应为 move，实际 ${handles.cursorOnBar}`);
    }
    if (handles.cursorOnEdge !== 'col-resize') {
      errors.push(`端点手柄处按下点的光标应为 col-resize，实际 ${handles.cursorOnEdge}`);
    }
    if (handles.cursorOnConnect !== 'crosshair') {
      errors.push(`连接点处按下点的光标应为 crosshair，实际 ${handles.cursorOnConnect}`);
    }
    if (!handles.connectDownEntersLinking) {
      errors.push('从连接点按下未进入建线手势（linking）——R4 的修法未生效');
    }
    /**
     * P-42 批次③ 的**形状口径**（连接点从"与条体等高的正方形白框"改成"圆圈，直径略小于条高"）：
     * 纯函数侧守"直径 ≤ 命中盒边长 ≤ …"（`interaction.spec.ts`），这里守"DOM 真的画成了圆"。
     */
    if (handles.connectTag !== 'circle') {
      errors.push(`连接点应为 \`circle\`（P-42 批次③的圆点口径），实际 \`${handles.connectTag || '(缺)'}\``);
    }
    if (handles.connectBox !== null && Math.abs(handles.connectBox.width - handles.connectBox.height) > 0.5) {
      errors.push(
        `连接点的可见盒必须是**正方形**（圆的外接盒），实际 ${String(handles.connectBox.width)}×${String(handles.connectBox.height)}`,
      );
    }
    if (handles.connectBox !== null && handles.connectBox.width > CONNECT_SIZE_PX + 0.5) {
      errors.push(
        `连接点的可见直径 ${String(handles.connectBox.width)} 超过命中盒边长 ${String(CONNECT_SIZE_PX)}（可见 ⊆ 命中盒）`,
      );
    }
  }
  return {
    status: errors.length === 0 ? 'ok' : 'error',
    errors,
    dataset: args.fixtureSpec.key,
    taskId: target.taskId,
    dayDelta: args.dayDelta,
    frames,
    mainThreadMs,
    mainThreadP50Ms: percentile(mainThreadMs, 0.5),
    mainThreadP95Ms: percentile(mainThreadMs, 0.95),
    frameGapsMs,
    frameGapP50Ms: percentile(frameGapsMs, 0.5),
    frameGapP95Ms: percentile(frameGapsMs, 0.95),
    longTasks,
    releaseMs,
    observedGeometryChanges,
    anchorsAfterRelease: args.host.anchors(),
    documentStartAfter,
    anchorOrdinal,
    expectedStartAfter,
    mode,
    gestureMode: gestureModeOnDown,
    durationBefore,
    durationAfter,
    expectedDurationAfter,
    revisionBefore,
    revisionDuringDrag,
    revisionAfterRelease,
    downstream,
    scrollTop: pane.scrollTop,
    scrollLeft: pane.scrollLeft,
    handles,
  };
}
/**
 * 记录制挑出来的目标行（`move` 与 `resize-duration` 共用这个形状）。
 *
 * `successor*` 只在 `resize-duration` 轮有值：那是"下游跟随"判据的载体
 * （一条**由被拖任务的完成日决定**的后继边 + 它拖动前的开始序号）。
 */
interface DragTargetPick {
  readonly taskId: string;
  readonly successorId?: string;
  readonly linkType?: string;
  readonly successorEsBefore?: number;
}

/**
 * 挑一个可拖的目标行：渲染窗口内、**非里程碑、非汇总、且无有效入边约束**。
 *
 * 最后一条不可省（P-25 落地时踩到）：`snap` 模式会把候选夹到入边约束之下，
 * 于是"拖 3 个工作日"这条位移判据对有前置约束的行**必然**报错——那是判据自己选错了样本，
 * 不是应用错了。`gesture.spec.ts` 的 `pickLeaf` 一直是这么过滤的，记录制这一侧必须同口径。
 */
function pickDragTarget(host: DragMeasurementHost): DragTargetPick | null {
  const view = host.view();
  const document = host.document();
  const schedule = host.schedule();
  if (view === null || schedule === null) return null;
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const bounded = view.rows.find((item) => item.row === row);
    if (bounded === undefined) continue;
    if (bounded.isMilestone || bounded.kind === 'summary') continue;
    const constraint = entryConstraintFor({
      document,
      schedule,
      taskId: bounded.id,
      durationDays: document.tasks.find((task) => task.id === bounded.id)?.durationDays ?? 0,
    });
    if (Number.isFinite(constraint)) continue;
    return { taskId: bounded.id };
  }
  return null;
}

/**
 * 挑一个「带**有效**后继边的叶子行」——`resize-duration` 轮的样本（裁决 P-45）。
 *
 * 三条前提，缺一条"下游跟随"就判不了：
 * 1. 目标行在渲染窗口内、非里程碑/非汇总（要抓得住条右端）；
 * 2. 它有一条出边 **`FS`/`FF`**——只有这两类关系的下游边界**含被拖任务的完成日**
 *    （`FS`：`es后 = ef前 + lag`；`FF`：`ef后 = ef前 + lag`）。
 *    `SS`（只看开始日）与 `SF`（`ef后 = es前 + lag`，**根本不含完成日**）在"改工期"下
 *    本来就不该动——拿它们当载体是判据自己错了（本轮实测踩到：SF 的 `before === after`）；
 * 3. 该边是那个后继的**紧约束**（后继确实顶在这条边上）——否则后继被别的入边顶住，
 *    `before === after`，"预览 == 提交"就退化成恒真式。边界式与
 *    `entryConstraintFor`（= SCHEDULE.md §九 不变量 2）逐字同式。
 */
function pickResizeTarget(host: DragMeasurementHost): DragTargetPick | null {
  const view = host.view();
  const document = host.document();
  const schedule = host.schedule();
  if (view === null || schedule === null) return null;
  const indexOfId = new Map<string, number>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined) indexOfId.set(task.id, index);
  }
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const bounded = view.rows.find((item) => item.row === row);
    if (bounded === undefined) continue;
    if (bounded.isMilestone || bounded.kind === 'summary') continue;
    const durationDays = document.tasks.find((task) => task.id === bounded.id)?.durationDays ?? 0;
    if (durationDays < 1) continue;
    /**
     * **必须无有效入边约束**（与 `move` 轮同一条前提，P-25 的教训在这一轮同样成立）：
     * 有前置时引擎按"前置优先"算 `ES`，而拖动期是**锚点**定位置——
     * 于是"松手前在锚点上、松手后被约束拉回去"这件事会被误读成"预览与提交分叉"。
     * 那是判据选错了样本（实测踩到：`t35` 拖动期 10、松手后 9），不是应用错了。
     */
    if (
      Number.isFinite(
        entryConstraintFor({ document, schedule, taskId: bounded.id, durationDays }),
      )
    ) {
      continue;
    }
    const fromIndex = indexOfId.get(bounded.id) ?? -1;
    const fromEs = schedule.es[fromIndex] ?? -1;
    const fromEf = schedule.ef[fromIndex] ?? -1;
    if (fromEs < 0 || fromEf < 0) continue;
    for (const link of document.links) {
      if (link.from !== bounded.id) continue;
      if (link.type !== 'FS' && link.type !== 'FF') continue;
      const successorIndex = indexOfId.get(link.to);
      if (successorIndex === undefined) continue;
      const toEs = schedule.es[successorIndex] ?? -1;
      const toEf = schedule.ef[successorIndex] ?? -1;
      if (toEs < 0 || toEf < 0) continue; // 汇总端点在有效图里不存在（SCHEDULE.md §四.6）
      // **紧约束**：后继确实顶在这条边上（`FS` 决定开始日、`FF` 决定完成日）。
      const binding = link.type === 'FS' ? toEs === fromEf + link.lagDays : toEf === fromEf + link.lagDays;
      if (!binding) continue;
      return {
        taskId: bounded.id,
        successorId: link.to,
        linkType: link.type,
        successorEsBefore: toEs,
      };
    }
  }
  return null;
}

/**
 * 内容坐标 → 屏幕坐标（唯一的换算处；与 {@link dragScreenPoint} 同一个式子）。
 *
 * 为什么需要它：`resize-duration` 的抓取点是"条右端内 2 px"，它**不是**某个工作日格的
 * 中点，因此不能复用"按序号取中点"的那条路径。
 */
function contentPointToScreen(
  pane: HTMLElement,
  host: DragMeasurementHost,
  contentX: number,
  contentY: number,
): { readonly clientX: number; readonly clientY: number } | null {
  const view = host.view();
  if (view === null) return null;
  const rect = pane.getBoundingClientRect();
  return {
    clientX: rect.left + contentX - view.scrollLeft,
    clientY: rect.top + contentY - view.scrollTop,
  };
}

/** 某个任务**当前排程**里的开始序号（`null` = 不在文档里 / 汇总行）。 */
function esOf(host: DragMeasurementHost, taskId: string): number | null {
  const schedule = host.schedule();
  const document = host.document();
  if (schedule === null) return null;
  const index = document.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const ordinal = schedule.es[index];
  return ordinal === undefined || ordinal < 0 ? null : ordinal;
}

/**
 * 批次 B 的记录制采样：**手柄可见性 + 光标分类 + 连接点起建线**（ADR 0008 §16.2/§16.3／裁决 P-32）。
 *
 * 三条纪律：
 * 1. **只读**：只读 DOM 与调 `cursorAt` / `entryPointOf`（后者走与用户同一条纯函数路径，
 *    不派发事件、不进手势状态机）；
 * 2. **选择器必须用 `line.handle` / `rect.connect-point`**：行组里现在有多个 `rect`
 *    （`.bar` / `.bar-progress` / `.connect-point`），用"第一个 rect"会量到手柄
 *    （P-32 落地时当场修过 `--align` 的同一处）；
 * 3. **模型侧用 `handleOffsetsFor`**（与渲染同源），因此"模型 vs DOM"这条是**互证**而不是自证。
 */
async function collectHandleSample(
  host: DragMeasurementHost,
  taskId: string,
): Promise<NonNullable<DragMeasureResult['handles']> | null> {
  const view = host.view();
  const document = host.document();
  const schedule = host.schedule();
  const pane = window.document.getElementById('chart-pane');
  if (view === null || schedule === null || pane === null) return null;
  const row = view.rows.find((item) => item.id === taskId);
  if (row === undefined) return null;

  const described = handleOffsetsFor({
    view,
    document,
    schedule,
    calendar: host.calendar() as unknown as Parameters<typeof handleOffsetsFor>[0]['calendar'],
  });
  let modelHandles = 0;
  let modelConnectPoints = 0;
  for (const item of described) {
    modelHandles += item.handleCount;
    modelConnectPoints += item.connectCount;
  }

  const svg = window.document.querySelector('.chart-pane-wrap .gantt-svg, #chart-pane .gantt-svg');
  const domHandles = svg?.querySelectorAll('.rows line.handle').length ?? 0;
  const rowGroups = svg?.querySelectorAll('.rows > g').length ?? 0;

  // 采样点（屏幕坐标）：条体中部 / 端点手柄 / 连接点——都用**模型几何**换算，与用户路径同源。
  const rect = pane.getBoundingClientRect();
  const toClient = (contentX: number, contentY: number): { readonly clientX: number; readonly clientY: number } => ({
    clientX: rect.left + contentX - view.scrollLeft,
    clientY: rect.top + contentY - view.scrollTop,
  });
  /**
   * 采样点的 x **从 DOM 属性读**，不在这里重算公式。
   *
   * 理由（P-32 落地时当场踩到）：`row.xRight` 是条形的**端**，而端点手柄画在**判定区边界**
   * （§16.2：`zones.edgeR.x1`，比端更靠内 6 px）。若在这里用 `row.xRight` 当"手柄处"，
   * 采样点会落到**连接点**上（`xRight + 2` 与 `xRight` 相距 2 px），于是判据报
   * "端点手柄处光标应为 col-resize，实际 crosshair"——那是**采错了点**，不是实现错了。
   * 从 DOM 读同时还有第二个好处：它顺带断言了"手柄真的发射了"。
   */
  const rowGroup = [...(svg?.querySelectorAll('.rows > g[data-task-id]') ?? [])].find((node) => node.getAttribute('data-task-id') === taskId) ?? null;
  const handleNodes = rowGroup === null ? [] : [...rowGroup.querySelectorAll('line.handle')];
  const attrX = (node: Element): number => Number(node.getAttribute('x') ?? node.getAttribute('x1') ?? Number.NaN);
  const handleContentX = handleNodes.map((node) => attrX(node)).filter((value) => Number.isFinite(value)).sort((a, b) => b - a)[0];
  // **条心**（不是 `row.row * rowHeight + rowHeight / 2` 的近似：`row.y` 是行顶，两者必须同源）。
  const y = row.barY + row.barHeight / 2;
  const mid = toClient((row.xLeft + row.xRight) / 2, y);
  const edge = toClient(handleContentX ?? row.xRight, y);

  /**
   * 连接点：**先把指针放到"条端外侧的方块"上，再读 DOM**。
   *
   * 它按需显形（P-32 复验第 3.2 条），所以顺序不能反：先 hover ⇒ 应用把该行的连接点发射出来 ⇒
   * 才能量到条数。`CONNECT_SIZE_PX / 2` = 方块的中心线（在条端的**外侧** 4 px）。
   */
  const connect = toClient(row.xRight + CONNECT_SIZE_PX / 2, y);
  host.hoverAt?.(connect.clientX, connect.clientY);
  // **必须等 Vue 把连接点渲染出来**再读 DOM：`hoverAt` 只改了响应式状态，
  // 同一个 microtask 里读 DOM 会恒得 0（这条在落地记录制时当场踩到）。
  await nextTick();
  // **只数"指针所在那一行"的连接点**：连接点按需显形（复验第 3.2 条），
  // `domConnectPoints` 若沿用 hover 之前的全图计数，这条判据会恒红。
  // 选择器**不限定标签**（P-42 批次③起可见图形是 `<circle>`）——"可见盒"一律按 DOM 矩形量。
  const connectNodesAfterHover =
    rowGroup === null ? [] : [...rowGroup.querySelectorAll('.connect-point')];
  const domConnectPointsAfterHover = connectNodesAfterHover.length;
  /** 连接点的**内容坐标**左缘：从 DOM 矩形反推（`x`/`cx` 两种标签都能量到，不在这里重算公式）。 */
  const contentLeftOf = (node: Element): number => node.getBoundingClientRect().left - rect.left + view.scrollLeft;
  const connectContentX = connectNodesAfterHover
    .map((node) => contentLeftOf(node))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  const firstConnectBox =
    connectNodesAfterHover.length === 0
      ? null
      : (() => {
          const box = connectNodesAfterHover[0]?.getBoundingClientRect();
          return box === undefined ? null : { width: round(box.width), height: round(box.height) };
        })();
  host.clearHover?.();

  const entry = host.entryPointOf?.(connect.clientX, connect.clientY) ?? null;
  return {
    rowGroups,
    domHandles,
    domConnectPoints: domConnectPointsAfterHover,
    modelHandles,
    modelConnectPoints,
    cursorOnBar: host.cursorAt?.(mid.clientX, mid.clientY) ?? '',
    cursorOnEdge: host.cursorAt?.(edge.clientX, edge.clientY) ?? '',
    cursorOnConnect: host.cursorAt?.(connect.clientX, connect.clientY) ?? '',
    connectDownEntersLinking: entry !== null && entry.taskId === taskId,
    // 采样用的连接点左缘（`null` 说明该行没发射连接点 —— 上面那条会报出来）。
    connectLeftEdge: connectContentX ?? null,
    connectTag: connectNodesAfterHover[0]?.tagName.toLowerCase() ?? '',
    connectBox: firstConnectBox,
  };
}

/**
 * 当前 DOM 上**全部条形的几何串**（用于判断"渲染侧真的更新了"= 下游跟随的间接证据）。
 *
 * 两处口径（P-23 落地时当场抓到第一处）：
 * - **选择器**同时覆盖两种排布（SVG 是滚动容器的**兄弟**〔修后〕或子元素〔修前 / 负向对照〕）：
 *   修后只查 `#chart-pane .rows` 会恒得空串 ⇒ 假阴性；
 * - **必须带上 `x`/`y`**：`move`（整体移动）只改位置、不改宽度，只串 `width`/`points`
 *   会把"正在跟随的一次 `move`"报成 0 帧变化。
 * 覆盖层不在此列（只查 `.rows`），因此任何变化都意味着**条形本身**被重绘了。
 */
function collectBarGeometry(): string {
  const nodes = document.querySelectorAll(
    // **只串条形与菱形**（`.bar` / `.milestone`）：行组里现在还有 `.bar-progress` 与
    // `.connect-point`（批次 B 的端点手柄是 `<line>`，不在本选择器内）。不排除它们会让
    // "手柄/连接点变了"被算成"条形变了" ⇒ `--drag` 的"DOM 变化 N/12 帧"变成**假绿**
    // （P-23 修过一次同族假阴性）。
    '.chart-pane-wrap .rows rect.bar, .chart-pane-wrap .rows polygon.milestone, #chart-pane .rows rect.bar, #chart-pane .rows polygon.milestone',
  );
  const parts: string[] = [];
  nodes.forEach((node) => {
    parts.push(
      [
        node.getAttribute('x') ?? '',
        node.getAttribute('y') ?? '',
        node.getAttribute('width') ?? '',
        node.getAttribute('height') ?? '',
        node.getAttribute('points') ?? '',
      ].join(','),
    );
  });
  return parts.join('|');
}

function emptyDragResult(
  args: {
    readonly fixtureSpec: FixtureSpec;
    readonly dayDelta: number;
    readonly frames: number;
    readonly scrollTop?: number;
    readonly scrollLeft?: number;
    readonly mode?: 'move' | 'resize-duration';
  },
  errors: readonly string[],
): DragMeasureResult {
  return {
    status: 'error',
    errors,
    dataset: args.fixtureSpec.key,
    taskId: '',
    dayDelta: args.dayDelta,
    frames: args.frames,
    mainThreadMs: [],
    mainThreadP50Ms: 0,
    mainThreadP95Ms: 0,
    frameGapsMs: [],
    frameGapP50Ms: 0,
    frameGapP95Ms: 0,
    longTasks: 0,
    releaseMs: 0,
    observedGeometryChanges: 0,
    anchorsAfterRelease: 0,
    documentStartAfter: null,
    anchorOrdinal: null,
    expectedStartAfter: null,
    mode: args.mode ?? 'move',
    gestureMode: null,
    durationBefore: null,
    durationAfter: null,
    expectedDurationAfter: null,
    revisionBefore: 0,
    revisionDuringDrag: 0,
    revisionAfterRelease: 0,
    downstream: null,
    scrollTop: args.scrollTop ?? 0,
    scrollLeft: args.scrollLeft ?? 0,
    handles: null,
  };
}
