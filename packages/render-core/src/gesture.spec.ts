/**
 * ADR 0008 §4–§8 的门禁判据：拖拽三语义、吸附与锚点、松手命令、建线与检环。
 *
 * ## 判据的分层（ADR 0008 §11）
 *
 * 这里只断言**Node 侧可判定的部分**：手势状态机、候选序号、会话锚点、松手命令、成环拒绝。
 * 帧预算与松手墙钟属**记录制**（`node scripts/measure-render.mjs --drag`），不进 `pnpm gate`。
 *
 * ## 坐标口径（本文件最容易写错的地方）
 *
 * 每个断言都先把**想要的序号**换成像素（`xForOrdinal`），而不是反过来猜 x 会落在哪个序号上。
 * 起算点是 `axisOriginDay`（ADR 0007 §3 的轴线起点，含左侧 gutter），因此它**不是**
 * `dayOfOrdinal(0)`：拿 `bounds.xLeft + n·pxPerDay` 当"第 n 天"会得到偏了几天的结果。
 *
 * ## 负向对照（必须有，否则上面全是恒真式）
 *
 * - `allow` 模式拖到入边约束**之前** ⇒ `compute` 必须报 `anchorConflict`；
 *   `snap` 模式在同一位置**必须不报**（同一位置、两种模式给出不同判定 ⇒ 判据有判别力）；
 * - 成环建线必须被 `rejected` 且带回环路径；不成环的同一手势必须产出 `link`。
 */

import { describe, expect, it } from 'vitest';

import { compute, wouldCreateCycle, type ProjectDocument, type Schedule } from '@ganttpilot/engine';

import { buildView, type ViewModel, type Viewport } from './viewModel.js';
import { HIT_TOLERANCE_PX, ROW_HEIGHT, ROW_BUFFER, ZOOM_PX_PER_DAY } from './manifest.js';
import { buildFixture, DATASETS } from './fixtures.js';
import {
  barHitFor,
  beginGesture,
  dragModeFor,
  dragPreviewFor,
  entryConstraintFor,
  ordinalAtClamped,
  pointerFromClient,
  reduceGesture,
  resolveDragOutcome,
  resolvePointerTarget,
  snapCandidate,
  type BeginGestureArgs,
  type GestureState,
} from './gesture.js';
import { highlightForCyclePath } from './highlight.js';
import { taskBounds, type TaskBounds } from './domain.js';

const fixture = buildFixture(DATASETS[2]); // dense：1,000 任务 / 1,500 依赖
const viewport: Viewport = {
  width: 1280,
  height: 640,
  rowHeight: ROW_HEIGHT,
  rowBuffer: ROW_BUFFER,
  scrollTop: 0,
  scrollLeft: 0,
};

function viewOf(zoom: 'day' | 'week' | 'month' = 'day', height = viewport.height): ViewModel {
  return buildView({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    viewport: { ...viewport, height },
    zoom,
  });
}

/** 用**指定的 `Schedule`** 建视图（拖动期视图带着会话锚点重算时用它，见新判据）。 */
function viewWith(schedule: Schedule, height = viewport.height): ViewModel {
  return buildView({
    document: fixture.document,
    schedule,
    calendar: fixture.calendar,
    viewport: { ...viewport, height },
    zoom: 'day',
  });
}

const view = viewOf('day');

/**
 * 更高的视口（覆盖更多行）——批次 A 的新用例要在更宽的行集合里挑样本
 * （例如"原开始序号 ≥ 3 的无约束叶子"，它未必落在 640 px 的窗口里）。
 * **只改窗口，不改几何**：`axisOriginDay`/`pxPerDay`/各行 `bounds` 与 640 px 时逐值相同。
 */
const tallView = viewOf('day', 2400);

/** 序号 → 该序号所在工作日格的**左端** x（内容坐标）。 */
function xForOrdinal(ordinal: number): number {
  return (fixture.calendar.dayOfOrdinal(ordinal) - view.axisOriginDay) * view.pxPerDay;
}

function rowCenterY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * 「整体移动」的**抓取点**：条体第一个工作日格的**中点**。
 *
 * 这是 P-22 批次 A 之后唯一正确的口径：候选序号是**抓取点相对**的
 * （`候选 = 原开始 + (指针序号 − 抓取点序号)`），因此"按一下不动"必须得到 `delta === 0`。
 * 取第一个工作日格的中点同时满足两件事：① 落在 `move` 判定区内（`pxPerDay/2 > DRAG_EDGE_PX`）；
 * ② 其序号恰好是 `es`。`apps/web/src/measure.ts` 的 `dragScreenPoint` 一直用的是这个点。
 */
function moveGrabX(bounds: TaskBounds): number {
  return xForOrdinal(bounds.es) + view.pxPerDay / 2;
}

function boundsIn(target: ViewModel, row: number): TaskBounds {
  const docIndex = target.order[row];
  if (docIndex === undefined) throw new Error(`行 ${String(row)} 不在可见行序列里`);
  const bounds = taskBounds({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    rowOfDocIndex: target.rowOfDocIndex,
    axisOriginDay: target.axisOriginDay,
    pxPerDay: target.pxPerDay,
    rowHeight: target.rowHeight,
    docIndex,
  });
  if (bounds === null) throw new Error(`行 ${String(row)} 没有可画的条`);
  return bounds;
}

function boundsOfRow(row: number): TaskBounds {
  return boundsIn(view, row);
}

function constraintOfRow(row: number): number {
  const docIndex = view.order[row];
  const task = docIndex === undefined ? undefined : fixture.document.tasks[docIndex];
  if (task === undefined) throw new Error('行不存在');
  return entryConstraintFor({
    document: fixture.document,
    schedule: fixture.schedule,
    taskId: task.id,
    durationDays: task.durationDays ?? 0,
  });
}

/** 找一个"渲染窗口内、叶子、非里程碑、且无有效入边"的行（拖动判据最干净的样本）。 */
function firstFreeLeafRow(): { readonly row: number; readonly taskId: string } {
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const docIndex = view.order[row];
    const task = docIndex === undefined ? undefined : fixture.document.tasks[docIndex];
    if (task === undefined || task.durationDays === null) continue;
    const bounds = boundsOfRow(row);
    if (bounds.isMilestone) continue;
    if (!Number.isFinite(constraintOfRow(row))) return { row, taskId: task.id };
  }
  throw new Error('夹具里没有"无有效入边的叶子"行');
}

/** 找一个"渲染窗口内、叶子、非里程碑、且有入边约束"的行。 */
function firstConstrainedRow(): { readonly row: number; readonly taskId: string; readonly constraint: number } {
  for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
    const docIndex = view.order[row];
    const task = docIndex === undefined ? undefined : fixture.document.tasks[docIndex];
    if (task === undefined || task.durationDays === null) continue;
    if (boundsOfRow(row).isMilestone) continue;
    const constraint = constraintOfRow(row);
    // 需要约束**严格大于 0**：否则"拖到约束之前"会撞上下界 0，测不出 allow/snap 的差别。
    if (Number.isFinite(constraint) && constraint >= 3) return { row, taskId: task.id, constraint };
  }
  throw new Error('夹具里没有"约束 ≥ 3 的叶子"行');
}

type FixtureTask = ProjectDocument['tasks'][number];

/** 在 `tallView` 的可见行序里挑一个满足条件的叶子（批次 A 的新用例用）。 */
function pickLeaf(predicate: (args: {
  readonly row: number;
  readonly bounds: TaskBounds;
  readonly task: FixtureTask;
  readonly constraint: number;
}) => boolean): { readonly row: number; readonly bounds: TaskBounds; readonly task: FixtureTask } {
  for (let row = 0; row < tallView.order.length; row += 1) {
    const docIndex = tallView.order[row];
    const task = docIndex === undefined ? undefined : fixture.document.tasks[docIndex];
    if (task === undefined) continue;
    const bounds = boundsIn(tallView, row);
    if (bounds.kind === 'summary') continue;
    const constraint = entryConstraintFor({
      document: fixture.document,
      schedule: fixture.schedule,
      taskId: task.id,
      durationDays: task.durationDays ?? 0,
    });
    if (predicate({ row, bounds, task, constraint })) return { row, bounds, task };
  }
  throw new Error('夹具里没有满足条件的叶子（前提不成立）');
}

function dragArgsFor(target: ViewModel): Omit<BeginGestureArgs, 'pointer' | 'anchorMode'> {
  return {
    view: target,
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
  };
}

function dragArgs(): Omit<BeginGestureArgs, 'pointer' | 'anchorMode'> {
  return dragArgsFor(view);
}

/** 把松手 patch 落到文档上（用于"预览与提交同源"——判据必须看到**落库之后**的几何）。 */
function withPatch(taskId: string, patch: Record<string, unknown>): ProjectDocument {
  return {
    ...fixture.document,
    tasks: fixture.document.tasks.map((task) =>
      task.id === taskId ? { ...task, ...(patch as Partial<FixtureTask>) } : task,
    ),
  };
}

/** 落库 + 重算之后，某个任务在该视图下的条形/菱形几何。 */
function boundsAfterPatch(taskId: string, patch: Record<string, unknown>): TaskBounds {
  const document = withPatch(taskId, patch);
  const result = compute(document, fixture.calendar);
  if (!result.ok) throw new Error(`patch 之后不可排程：${result.code}`);
  const docIndex = document.tasks.findIndex((task) => task.id === taskId);
  const bounds = taskBounds({
    document,
    schedule: result.schedule,
    calendar: fixture.calendar,
    rowOfDocIndex: tallView.rowOfDocIndex,
    axisOriginDay: tallView.axisOriginDay,
    pxPerDay: tallView.pxPerDay,
    rowHeight: tallView.rowHeight,
    docIndex,
  });
  if (bounds === null) throw new Error('patch 之后该行没有可画的条');
  return bounds;
}

describe('三语义的判定区（ADR 0008 §5）', () => {
  it('条的左端 ⇒ 改开始；右端 ⇒ 改工期；中间 ⇒ 整体移动', () => {
    const bounds = boundsOfRow(0);
    if (bounds.isMilestone) throw new Error('第 0 行是里程碑，夹具前提不成立');
    expect(dragModeFor(bounds, bounds.xLeft)).toBe('resize-start');
    expect(dragModeFor(bounds, bounds.xLeft + 5)).toBe('resize-start');
    expect(dragModeFor(bounds, (bounds.xLeft + bounds.xRight) / 2)).toBe('move');
    expect(dragModeFor(bounds, bounds.xRight)).toBe('resize-duration');
    expect(dragModeFor(bounds, bounds.xRight - 5)).toBe('resize-duration');
  });

  it('里程碑没有"两端"：左右半区分别对应整体移动与改工期', () => {
    let milestoneRow: number | null = null;
    for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
      if (boundsOfRow(row).isMilestone) {
        milestoneRow = row;
        break;
      }
    }
    expect(milestoneRow).not.toBeNull();
    if (milestoneRow === null) return;
    const bounds = boundsOfRow(milestoneRow);
    const cx = bounds.milestone?.cx ?? bounds.xLeft;
    expect(dragModeFor(bounds, cx - 1)).toBe('move');
    expect(dragModeFor(bounds, cx + 1)).toBe('resize-duration');
    expect(dragModeFor(bounds, cx)).toBe('resize-duration');
  });
});

describe('按下 → 拖动 → 松手（ADR 0008 §5/§6）', () => {
  it('按下左键进入拖动（`move`），产出**一个**手势锚点，且拖动期不写文档', () => {
    const { row, taskId } = firstFreeLeafRow();
    const bounds = boundsOfRow(row);
    const update = beginGesture({
      ...dragArgs(),
      pointer: { x: moveGrabX(bounds), y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
    });
    expect(update.state.kind).toBe('dragging');
    expect(update.gestureToken).toBe(`drag:${taskId}`);
    expect(update.anchors).toHaveLength(1);
    expect(update.anchors[0]?.taskId).toBe(taskId);
    expect(update.commands).toStrictEqual([]);
    expect(update.link).toBeNull();
    expect(update.rows.length).toBeGreaterThan(0);
    expect(update.edges.length).toBeGreaterThan(0);
  });

  it('移动 3 个工作日 ⇒ 锚点序号恰好 +3；松手提交的 `startDate`/`endDate` 与候选同源', () => {
    const { row, taskId } = firstFreeLeafRow();
    const bounds = boundsOfRow(row);
    const started = beginGesture({
      ...dragArgs(),
      pointer: { x: moveGrabX(bounds), y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
    });
    if (started.state.kind !== 'dragging') throw new Error('未进入拖动');
    // 起点：显式取"条左端所在序号"，避免被判定区（中点）带偏。
    const originOrdinal = fixture.calendar.ordinalOfDay(
      Math.floor(view.axisOriginDay + (bounds.xLeft + view.scrollLeft) / view.pxPerDay),
    );

    const moved = reduceGesture({
      ...dragArgs(),
      pointer: { x: xForOrdinal(originOrdinal + 3), y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
      state: started.state,
    });
    if (moved.state.kind !== 'dragging') throw new Error('拖动状态丢失');
    expect(moved.state.candidate).toBe(originOrdinal + 3);
    expect(moved.anchors[0]?.startOrdinal).toBe(originOrdinal + 3);

    const released = reduceGesture({
      ...dragArgs(),
      pointer: { x: 0, y: 0, buttons: 0 },
      anchorMode: 'snap',
      state: moved.state,
    });
    expect(released.state.kind).toBe('released');
    expect(released.anchors).toStrictEqual([]); // 松手即清锚点
    expect(released.commands).toHaveLength(1);
    const command = released.commands[0];
    expect(command?.kind).toBe('task.update');
    expect(command?.id).toBe(taskId);

    const task = fixture.document.tasks.find((item) => item.id === taskId);
    const duration = task?.durationDays ?? 0;
    expect(command?.patch.startDate).toBe(fixture.calendar.isoOfOrdinal(originOrdinal + 3));
    expect(command?.patch.endDate).toBe(fixture.calendar.isoOfOrdinal(originOrdinal + 3 + duration - 1));
  });

  it('「整体移动」保持工期：`durationDays` 不出现在 patch 里', () => {
    const { row, taskId } = firstFreeLeafRow();
    const bounds = boundsOfRow(row);
    const started = beginGesture({
      ...dragArgs(),
      pointer: { x: moveGrabX(bounds), y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
    });
    const moved = reduceGesture({
      ...dragArgs(),
      pointer: { x: (bounds.xLeft + bounds.xRight) / 2 + view.pxPerDay * 2, y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
      state: started.state,
    });
    const released = reduceGesture({
      ...dragArgs(),
      pointer: { x: 0, y: 0, buttons: 0 },
      anchorMode: 'snap',
      state: moved.state,
    });
    const patch = released.commands[0]?.patch ?? {};
    expect(Object.keys(patch).sort()).toStrictEqual(['endDate', 'startDate']);
    expect(patch).not.toHaveProperty('durationDays');
    void taskId;
  });

  it('`Esc` 取消：回到 `idle`、清锚点、**不提交任何命令**', () => {
    const { row } = firstFreeLeafRow();
    const bounds = boundsOfRow(row);
    const started = beginGesture({
      ...dragArgs(),
      pointer: { x: moveGrabX(bounds), y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
    });
    const cancelled = reduceGesture({
      ...dragArgs(),
      pointer: { x: bounds.xRight + 40, y: rowCenterY(row), buttons: 1, escPressed: true },
      anchorMode: 'snap',
      state: started.state,
    });
    expect(cancelled.state.kind).toBe('idle');
    expect(cancelled.anchors).toStrictEqual([]);
    expect(cancelled.commands).toStrictEqual([]);
    expect(cancelled.gestureToken).toBeNull();
  });

  it('汇总条不可拖（改汇总要改子树），但可以作为建线端点', () => {
    let summaryRow: number | null = null;
    for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
      const docIndex = view.order[row];
      if (docIndex === undefined) continue;
      if ((fixture.schedule.es[docIndex] ?? -1) === -1) {
        summaryRow = row;
        break;
      }
    }
    expect(summaryRow).not.toBeNull();
    if (summaryRow === null) return;
    const dragged = beginGesture({
      ...dragArgs(),
      pointer: { x: 300, y: rowCenterY(summaryRow), buttons: 1 },
      anchorMode: 'snap',
    });
    expect(dragged.state.kind).toBe('idle');
    const linking = beginGesture({
      ...dragArgs(),
      pointer: { x: 300, y: rowCenterY(summaryRow), buttons: 1, altKey: true },
      anchorMode: 'snap',
    });
    expect(linking.state.kind).toBe('linking');
  });

  it('空白处按下不产生任何手势', () => {
    const update = beginGesture({
      ...dragArgs(),
      pointer: { x: 10, y: -500, buttons: 1 },
      anchorMode: 'snap',
    });
    expect(update.state.kind).toBe('idle');
    expect(update.gestureToken).toBeNull();
  });
});

describe('`snap` vs `allow`（IX-05 / ADR 0008 §6）——判据有判别力的地方', () => {
  it('拖到入边约束之前：`snap` 让任务停在**不少于约束**的位置且自报无冲突；`allow` 如实放行并报冲突', () => {
    const { row, taskId, constraint } = firstConstrainedRow();
    const bounds = boundsOfRow(row);
    const startX = moveGrabX(bounds);

    // 情形 A：拖到**约束之前** 3 个工作日。`compute` 的 `ES = max(约束, 锚点)` 会把它抬回约束
    // —— 于是"任务最终落在哪"两种模式**一致**（引擎说了算），差别只在 `allow` **如实报告**冲突。
    const before = constraint - 3;
    const earlyX = xForOrdinal(before);
    const start = beginGesture({
      ...dragArgs(),
      pointer: { x: startX, y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
    });
    if (start.state.kind !== 'dragging') throw new Error('未进入拖动');

    const snappedEarly = reduceGesture({
      ...dragArgs(),
      pointer: { x: earlyX, y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
      state: start.state,
    });
    if (snappedEarly.state.kind !== 'dragging') throw new Error('snap 状态丢失');
    expect(snappedEarly.state.candidate).toBe(before); // 早于约束的候选在 snap 下**保持原样**（它就是允许区）

    const allowedEarly = reduceGesture({
      ...dragArgs(),
      pointer: { x: earlyX, y: rowCenterY(row), buttons: 1 },
      anchorMode: 'allow',
      state: start.state,
    });
    if (allowedEarly.state.kind !== 'dragging') throw new Error('allow 状态丢失');
    expect(allowedEarly.state.candidate).toBe(before);

    // 情形 B：拖到**约束之后** 3 个工作日。
    // - `snap`：夹回约束（拖动"顶住"边界）；
    // - `allow`：如实放行（晚于约束**不是**冲突——排程取 max，任务跟手往后走，用户要的正是这个）。
    const after = constraint + 3;
    const lateX = xForOrdinal(after);
    const snappedLate = reduceGesture({
      ...dragArgs(),
      pointer: { x: lateX, y: rowCenterY(row), buttons: 1 },
      anchorMode: 'snap',
      state: start.state,
    });
    if (snappedLate.state.kind !== 'dragging') throw new Error('snap 状态丢失');
    expect(snappedLate.state.candidate).toBe(constraint);

    const allowedLate = reduceGesture({
      ...dragArgs(),
      pointer: { x: lateX, y: rowCenterY(row), buttons: 1 },
      anchorMode: 'allow',
      state: start.state,
    });
    if (allowedLate.state.kind !== 'dragging') throw new Error('allow 状态丢失');
    expect(allowedLate.state.candidate).toBe(after);
    expect(allowedLate.state.candidate).toBeGreaterThan(constraint);

    // 纯函数的边界口径（不依赖手势路径）：夹的是**上界**，不是下界。
    expect(snapCandidate({ candidate: before, constraint, minOrdinal: 0 })).toBe(before);
    expect(snapCandidate({ candidate: after, constraint, minOrdinal: 0 })).toBe(constraint);
    expect(snapCandidate({ candidate: -99, constraint, minOrdinal: 0 })).toBe(0);
    expect(snapCandidate({ candidate: 5, constraint: Number.NEGATIVE_INFINITY, minOrdinal: 0 })).toBe(5);

    const docIndex = fixture.document.tasks.findIndex((item) => item.id === taskId);
    // 冲突判据**只有 `compute` 一处**：早于约束 ⇒ 报 `anchorConflict`。
    const earlyResult = compute(fixture.document, fixture.calendar, [{ taskId, startOrdinal: before }]);
    expect(earlyResult.ok).toBe(true);
    if (!earlyResult.ok) return;
    expect(
      earlyResult.schedule.diagnostics.some((item) => item.code === 'anchorConflict' && item.taskId === taskId),
    ).toBe(true);
    expect(earlyResult.schedule.es[docIndex]).toBeGreaterThanOrEqual(constraint);

    // 晚于约束 ⇒ **不报**冲突（这是"allow 不是"允许违反"，而是"允许排到约束之后"）。
    const lateResult = compute(fixture.document, fixture.calendar, [{ taskId, startOrdinal: after }]);
    expect(lateResult.ok).toBe(true);
    if (!lateResult.ok) return;
    expect(
      lateResult.schedule.diagnostics.some((item) => item.code === 'anchorConflict' && item.taskId === taskId),
    ).toBe(false);
    expect(lateResult.schedule.es[docIndex]).toBe(after);

    // 拖动路径与 `compute` 的口径必须一致：snap 夹住的那个值**不得**触发冲突。
    const snapResult = compute(fixture.document, fixture.calendar, [
      { taskId, startOrdinal: snappedLate.state.candidate },
    ]);
    expect(snapResult.ok).toBe(true);
    if (!snapResult.ok) return;
    expect(
      snapResult.schedule.diagnostics.some((item) => item.code === 'anchorConflict' && item.taskId === taskId),
    ).toBe(false);
  });
});

describe('建线与检环（ADR 0008 §7）', () => {
  it('`altKey` 按下 → 悬停另一行 → 松手产出一条 `link.insert`，且 `lagDays = 0`', () => {
    const from = firstFreeLeafRow();
    let toRow: number | null = null;
    for (let row = from.row + 1; row <= Math.min(view.renderLast, from.row + 6); row += 1) {
      const docIndex = view.order[row];
      const task = docIndex === undefined ? undefined : fixture.document.tasks[docIndex];
      if (task === undefined || task.durationDays === null) continue;
      if (boundsOfRow(row).isMilestone) continue;
      toRow = row;
      break;
    }
    expect(toRow).not.toBeNull();
    if (toRow === null) return;

    const fromBounds = boundsOfRow(from.row);
    const toBounds = boundsOfRow(toRow);
    const started = beginGesture({
      ...dragArgs(),
      pointer: { x: fromBounds.xRight, y: rowCenterY(from.row), buttons: 1, altKey: true },
      anchorMode: 'snap',
    });
    expect(started.state.kind).toBe('linking');

    const hovered = reduceGesture({
      ...dragArgs(),
      pointer: { x: (toBounds.xLeft + toBounds.xRight) / 2, y: rowCenterY(toRow), buttons: 1, altKey: true },
      anchorMode: 'snap',
      state: started.state,
    });
    expect(hovered.preview).not.toBeNull();
    expect(hovered.preview?.type).toBe(toBounds.xLeft >= fromBounds.xLeft ? 'FS' : 'SS');
    expect(hovered.preview?.cyclic).toBe(false);
    expect(hovered.preview?.exitPoint[1]).toBe(fromBounds.y);
    expect(hovered.preview?.enterPoint[1]).toBe(toBounds.y);

    const dropped = reduceGesture({
      ...dragArgs(),
      pointer: { x: 0, y: 0, buttons: 0 },
      anchorMode: 'snap',
      state: hovered.state,
    });
    expect(dropped.link).not.toBeNull();
    expect(dropped.link?.from).toBe(from.taskId);
    expect(dropped.link?.to).toBe(fixture.document.tasks[view.order[toRow] ?? 0]?.id);
    expect(dropped.link?.lagDays).toBe(0);
    expect(dropped.commands).toStrictEqual([]);
    // 新边的 id 不得与文档里已有的 id 冲突（命令层会拒绝重复 id）。
    expect(fixture.document.links.some((link) => link.id === dropped.link?.id)).toBe(false);
  });

  it('成环建线被**拒绝**，并带回环路径（首尾同一 id）+ 高亮覆盖回路', () => {
    const existing = fixture.document.links.find((link) => {
      const fromIndex = fixture.document.tasks.findIndex((task) => task.id === link.from);
      const toIndex = fixture.document.tasks.findIndex((task) => task.id === link.to);
      return fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex;
    });
    if (existing === undefined) throw new Error('夹具没有可用的边');
    const reversed = { ...existing, id: 'reverse-candidate', from: existing.to, to: existing.from };
    const cycle = wouldCreateCycle(fixture.document.links, reversed);
    expect(cycle.cyclic).toBe(true);
    expect(cycle.path[0]).toBe(reversed.from);
    expect(cycle.path[cycle.path.length - 1]).toBe(reversed.from);
    expect(cycle.path.length).toBeGreaterThan(1);

    const highlight = highlightForCyclePath(fixture.document, cycle.path);
    expect(highlight.styleKey).toBe('cycle');
    expect(highlight.rows.length).toBeGreaterThan(0);
    expect(highlight.edges.length).toBeGreaterThan(0);
    const existingIndex = fixture.document.links.findIndex((link) => link.id === existing.id);
    expect(highlight.edges).toContain(existingIndex);
  });
});

describe('命中反算（ADR 0007 §3 的分工 + ADR 0008 §5）', () => {
  it('`resolvePointerTarget` 只认渲染窗口内的可见行', () => {
    const inside = resolvePointerTarget({ ...dragArgs(), x: 400, y: rowCenterY(view.renderFirst) });
    expect(inside?.row).toBe(view.renderFirst);
    expect(resolvePointerTarget({ ...dragArgs(), x: 400, y: -10 })).toBeNull();
    expect(resolvePointerTarget({ ...dragArgs(), x: 400, y: (view.rowCount + 5) * ROW_HEIGHT })).toBeNull();
  });

  it('三种档位下命中同一行的 y 与其 `pxPerDay` 无关（行坐标只由行高决定）', () => {
    for (const zoom of ['day', 'week', 'month'] as const) {
      const zoomedView = viewOf(zoom);
      const target = resolvePointerTarget({
        view: zoomedView,
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        x: 0,
        y: rowCenterY(zoomedView.renderFirst),
      });
      expect(target?.row).toBe(zoomedView.renderFirst);
      expect(zoomedView.pxPerDay).toBe(ZOOM_PX_PER_DAY[zoom]);
    }
  });
});

// ---------------------------------------------------------------- 批次 A（P-22）：入口判据

/**
 * 这一组是 **P-22 批次 A** 的判据（ADR 0008 §13）。它守的是 P-19/P-21 两次都漏掉的那一类：
 * **"纯内核的入参是怎么算出来的"**——坐标归一化、是否命中条体、候选如何随模式定义。
 *
 * 每条都配一个**负向对照**（旧写法在同一输入上必须给出不同结果），否则这些断言可能只是恒真式。
 */
describe('批次 A 的入口判据（P-22：指针归一化 / 条体命中 / 按模式的候选）', () => {
  const grabPointOf = (target: ViewModel, bounds: TaskBounds): number =>
    xForOrdinalIn(target, bounds.es) + target.pxPerDay / 2;

  function xForOrdinalIn(target: ViewModel, ordinal: number): number {
    return (fixture.calendar.dayOfOrdinal(ordinal) - target.axisOriginDay) * target.pxPerDay;
  }

  /** 三语义各取一个"按下点"（都落在条体上，都在对应的判定区内）。 */
  function downPoints(target: ViewModel, bounds: TaskBounds): {
    readonly move: number;
    readonly resizeStart: number;
    readonly resizeDuration: number;
  } {
    void target;
    return {
      move: grabPointOf(target, bounds),
      resizeStart: bounds.xLeft + 1,
      resizeDuration: bounds.xRight - 1,
    };
  }

  it('屏幕坐标 → 内容坐标只由「窗格矩形 + 滚动位置」决定，**与事件目标无关**（R1）', () => {
    const scrollLeft = 137;
    const scrollTop = 61;
    const base = {
      clientX: 500.5,
      clientY: 300.25,
      paneLeft: 120,
      paneTop: 40,
      scrollLeft,
      scrollTop,
      buttons: 1,
    } as const;

    // 同一个屏幕点：事件目标无论是条体还是窗格，都必须得到同一个内容坐标。
    const onBar = pointerFromClient(base);
    const onPane = pointerFromClient({ ...base });
    expect(onBar).toStrictEqual(onPane);
    expect(onBar.x).toBe(500.5 - 120 + scrollLeft);
    expect(onBar.y).toBe(300.25 - 40 + scrollTop);

    // NC：旧口径把 `offsetX/offsetY` 当内容坐标 —— 它们是**相对事件目标**的，
    // 因此同一个屏幕点在两个目标上给出两个答案（这正是 R1 的成因）。
    const offsetOnBar = 36; // 目标 = 条体
    const offsetOnPane = 416; // 目标 = 窗格
    expect(offsetOnBar + scrollLeft).not.toBe(offsetOnPane + scrollLeft);
    expect(onBar.x).not.toBe(offsetOnBar + scrollLeft);
  });

  it('条体命中：包围盒 ± 容差之外按下**不产生手势**（R2）——同一行的空白不再改日期', () => {
    const target = tallView;
    const pick = pickLeaf(({ bounds: b }) => !b.isMilestone && b.xRight - b.xLeft >= 24);
    const bounds = pick.bounds;
    const y = rowCenterY(pick.row);
    const down = (x: number) =>
      beginGesture({ ...dragArgsFor(target), pointer: { x, y, buttons: 1 }, anchorMode: 'snap' });

    expect(barHitFor({ bounds, x: bounds.xLeft - HIT_TOLERANCE_PX - 1 })).toBe(false);
    expect(barHitFor({ bounds, x: bounds.xRight + HIT_TOLERANCE_PX + 1 })).toBe(false);
    expect(barHitFor({ bounds, x: bounds.xLeft })).toBe(true);
    expect(barHitFor({ bounds, x: bounds.xRight })).toBe(true);

    expect(down(bounds.xLeft - HIT_TOLERANCE_PX - 1).state.kind).toBe('idle');
    expect(down(bounds.xRight + HIT_TOLERANCE_PX + 1).state.kind).toBe('idle');
    expect(down(bounds.xLeft - HIT_TOLERANCE_PX).state.kind).toBe('dragging');
    expect(down(bounds.xRight + HIT_TOLERANCE_PX).state.kind).toBe('dragging');
  });

  it('里程碑的命中区是**菱形包围盒**（判据不是"条体"这个特例）', () => {
    const target = tallView;
    const pick = pickLeaf(({ bounds: b }) => b.isMilestone && b.milestone !== null);
    const size = pick.bounds.milestone?.size ?? 0;
    const cx = pick.bounds.milestone?.cx ?? 0;
    const y = rowCenterY(pick.row);
    const down = (x: number) =>
      beginGesture({ ...dragArgsFor(target), pointer: { x, y, buttons: 1 }, anchorMode: 'snap' });

    expect(size).toBeGreaterThan(0);
    expect(barHitFor({ bounds: pick.bounds, x: cx })).toBe(true);
    expect(barHitFor({ bounds: pick.bounds, x: cx - size / 2 - HIT_TOLERANCE_PX })).toBe(true);
    expect(barHitFor({ bounds: pick.bounds, x: cx - size / 2 - HIT_TOLERANCE_PX - 1 })).toBe(false);
    expect(barHitFor({ bounds: pick.bounds, x: cx + size / 2 + HIT_TOLERANCE_PX })).toBe(true);
    expect(barHitFor({ bounds: pick.bounds, x: cx + size / 2 + HIT_TOLERANCE_PX + 1 })).toBe(false);

    expect(down(cx).state.kind).toBe('dragging');
    expect(down(cx - size / 2 - HIT_TOLERANCE_PX - 1).state.kind).toBe('idle');
    expect(down(cx + size / 2 + HIT_TOLERANCE_PX + 1).state.kind).toBe('idle');
  });

  it('三语义「按下不动即松手」⇒ **不产出任何命令**（文档一字不改，也不压撤销栈）', () => {
    const target = tallView;
    const pick = pickLeaf(({ bounds: b, constraint: c }) => !b.isMilestone && !Number.isFinite(c));
    const points = downPoints(target, pick.bounds);
    const y = rowCenterY(pick.row);

    for (const x of [points.move, points.resizeStart, points.resizeDuration]) {
      const started = beginGesture({ ...dragArgsFor(target), pointer: { x, y, buttons: 1 }, anchorMode: 'snap' });
      expect(started.state.kind).toBe('dragging');

      const released = reduceGesture({
        ...dragArgsFor(target),
        pointer: { x, y, buttons: 0 },
        anchorMode: 'snap',
        state: started.state,
      });
      expect(released.state.kind).toBe('released');
      expect(released.commands).toStrictEqual([]);
      expect(released.anchors).toStrictEqual([]);
    }
  });

  it('`move`：按下**不跳位**；位移多少就是多少（R7）', () => {
    const target = tallView;
    // 工期 ≥ 3 ⇒ 条体中部与左端**隔着至少一个工作日格**，这样"中部抓取的候选必须等于原开始"
    // 才真正区分"抓取点相对"与"指针绝对"两种语义（工期 1 的条两者恰好同值）；
    // `es ≥ 3` ⇒ 原开始不为 0，否则"绝对 = 原开始 + 绝对"这一巧合会让判据失效
    // （无入边的叶子一律从 0 起算，所以这里必须挑**有约束**的行）。
    const pick = pickLeaf(
      ({ bounds: b, task }) => !b.isMilestone && b.es >= 3 && (task.durationDays ?? 0) >= 3,
    );
    const origin = pick.bounds.es;
    const y = rowCenterY(pick.row);
    const duration = pick.task.durationDays ?? 0;

    // **判别力最强的按下点：条体中部**（用户自然抓的地方）。
    // 旧的绝对语义在这里给出的候选是"指针所在序号"（≈ origin + 中间格数），条体左端随即跳到抓取点；
    // 抓取点相对语义给出的候选必须**就是原开始**。
    const centerX = (pick.bounds.xLeft + pick.bounds.xRight) / 2;
    expect(dragModeFor(pick.bounds, centerX)).toBe('move');
    const atCenter = beginGesture({
      ...dragArgsFor(target),
      pointer: { x: centerX, y, buttons: 1 },
      anchorMode: 'allow',
    });
    if (atCenter.state.kind !== 'dragging') throw new Error('未进入拖动');
    expect(atCenter.state.candidate).toBe(origin);
    expect(atCenter.state.candidate).not.toBe(ordinalAtClamped(target, centerX, fixture.calendar));

    const started = beginGesture({
      ...dragArgsFor(target),
      pointer: { x: grabPointOf(target, pick.bounds), y, buttons: 1 },
      anchorMode: 'allow',
    });
    if (started.state.kind !== 'dragging') throw new Error('未进入拖动');
    expect(started.state.candidate).toBe(origin);
    expect(started.state.grabOrdinal).toBe(origin);
    expect(started.state.mode).toBe('move');

    const moved = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + 3), y, buttons: 1 },
      anchorMode: 'allow',
      state: started.state,
    });
    if (moved.state.kind !== 'dragging') throw new Error('拖动状态丢失');
    expect(moved.state.candidate).toBe(origin + 3);

    const released = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + 3), y, buttons: 0 },
      anchorMode: 'allow',
      state: moved.state,
    });
    const patch = released.commands[0]?.patch ?? {};
    expect(patch.startDate).toBe(fixture.calendar.isoOfOrdinal(origin + 3));
    expect(patch.endDate).toBe(fixture.calendar.isoOfOrdinal(origin + 3 + duration - 1));
    expect(Object.keys(patch).sort()).toStrictEqual(['endDate', 'startDate']);
  });

  it('`resize-start`：按下不产出命令；向右拖 n 天 ⇒ 开始右移、**完成日不动**', () => {
    const target = tallView;
    // 无有效入边的叶子 ⇒ `es` 由文档日期/项目起点决定，patch 的日期在重算后**不会被覆盖**；
    // 工期 ≥ n + 1 才能向右拖（改开始 = 调工期，完成日不动）。
    const pick = pickLeaf(
      ({ bounds: b, constraint: c, task }) =>
        !b.isMilestone && !Number.isFinite(c) && (task.durationDays ?? 0) >= 4,
    );
    const origin = pick.bounds.es;
    const duration = pick.task.durationDays ?? 0;
    const y = rowCenterY(pick.row);
    const length = 3;

    const started = beginGesture({
      ...dragArgsFor(target),
      pointer: { x: pick.bounds.xLeft + 1, y, buttons: 1 },
      anchorMode: 'snap',
    });
    if (started.state.kind !== 'dragging') throw new Error('未进入改开始');
    expect(started.state.mode).toBe('resize-start');
    expect(started.state.candidate).toBe(origin);

    const moved = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + length), y, buttons: 1 },
      anchorMode: 'snap',
      state: started.state,
    });
    expect(moved.state.kind).toBe('dragging');
    const released = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + length), y, buttons: 0 },
      anchorMode: 'snap',
      state: moved.state,
    });
    const patch = released.commands[0]?.patch ?? {};
    expect(patch.startDate).toBe(fixture.calendar.isoOfOrdinal(origin + length));
    expect(patch.durationDays).toBe(duration - length);
    // 完成日**不动**：patch 不含 `endDate`（原有字段仍然成立）。
    expect(patch).not.toHaveProperty('endDate');
    // 与引擎的口径一致：新开始 + 新工期 − 1 = 原开始 + 原工期 − 1。
    expect((origin + length) + (duration - length) - 1).toBe(origin + duration - 1);
  });

  it('`resize-duration`：按下不产出命令（**工期不翻倍**）；向右拖 n 天 ⇒ 工期 +n、开始不动', () => {
    const target = tallView;
    const pick = pickLeaf(
      ({ bounds: b, constraint: c, task }) =>
        !b.isMilestone && !Number.isFinite(c) && (task.durationDays ?? 0) >= 2,
    );
    const origin = pick.bounds.es;
    const duration = pick.task.durationDays ?? 0;
    const y = rowCenterY(pick.row);
    const length = 3;

    const started = beginGesture({
      ...dragArgsFor(target),
      pointer: { x: pick.bounds.xRight - 1, y, buttons: 1 },
      anchorMode: 'snap',
    });
    if (started.state.kind !== 'dragging') throw new Error('未进入改工期');
    expect(started.state.mode).toBe('resize-duration');
    // 抓取点语义：按下时的候选 = 原**完成**序号 ⇒ 松手不得改任何东西。
    expect(started.state.candidate).toBe(origin + duration - 1);
    expect(started.state.grabOrdinal).toBe(origin + duration - 1);

    const stayed = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: pick.bounds.xRight - 1, y, buttons: 0 },
      anchorMode: 'snap',
      state: started.state,
    });
    expect(stayed.state.kind).toBe('released');
    expect(stayed.commands).toStrictEqual([]);
    // NC：旧式在"按下不动"时也会提交 —— `候选 − 原开始 + 工期 = 2D − 1`（"工期翻倍"的字面成因）。
    expect(2 * duration - 1).not.toBe(duration);

    const moved = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + duration - 1 + length), y, buttons: 1 },
      anchorMode: 'snap',
      state: started.state,
    });
    // `resize-duration` 的锚点是**原开始** ⇒ 拖动期条体本体不移动（可见反馈由预览轮廓承担）。
    expect(moved.anchors[0]?.startOrdinal).toBe(origin);

    const released = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + duration - 1 + length), y, buttons: 0 },
      anchorMode: 'snap',
      state: moved.state,
    });
    const patch = released.commands[0]?.patch ?? {};
    expect(patch.durationDays).toBe(duration + length);
    expect(patch.endDate).toBe(fixture.calendar.isoOfOrdinal(origin + duration + length - 1));
    expect(patch).not.toHaveProperty('startDate');
  });

  it('里程碑：`move` 的完成日 = 开始日（R7c）；右半区拖动把它变成有长度的任务', () => {
    const target = tallView;
    const pick = pickLeaf(({ bounds: b, constraint: c }) => b.isMilestone && !Number.isFinite(c));
    const origin = pick.bounds.es;
    const y = rowCenterY(pick.row);
    const cx = pick.bounds.milestone?.cx ?? 0;

    // move（菱形左半区）：零时长 ⇒ patch 的完成日必须等于开始日。
    const moving = beginGesture({
      ...dragArgsFor(target),
      pointer: { x: cx - 1, y, buttons: 1 },
      anchorMode: 'snap',
    });
    if (moving.state.kind !== 'dragging') throw new Error('未进入拖动');
    expect(moving.state.mode).toBe('move');
    const moved = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + 2) , y, buttons: 1 },
      anchorMode: 'snap',
      state: moving.state,
    });
    const movedRelease = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + 2), y, buttons: 0 },
      anchorMode: 'snap',
      state: moved.state,
    });
    const movePatch = movedRelease.commands[0]?.patch ?? {};
    expect(movePatch.startDate).toBe(fixture.calendar.isoOfOrdinal(origin + 2));
    expect(movePatch.endDate).toBe(movePatch.startDate);
    // NC：旧式用 `候选 + 工期 − 1 = 候选 − 1` ⇒ 完成日跑到**前一个工作日**。
    expect(fixture.calendar.isoOfOrdinal(origin + 2 - 1)).not.toBe(fixture.calendar.isoOfOrdinal(origin + 2));

    // 右半区（resize-duration）：按下不动 ⇒ 仍是里程碑（不产出命令）；向右 3 天 ⇒ 3 个工作日的任务。
    const resizing = beginGesture({
      ...dragArgsFor(target),
      pointer: { x: cx + 1, y, buttons: 1 },
      anchorMode: 'snap',
    });
    if (resizing.state.kind !== 'dragging') throw new Error('未进入改工期');
    expect(resizing.state.mode).toBe('resize-duration');
    const zero = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: cx + 1, y, buttons: 0 },
      anchorMode: 'snap',
      state: resizing.state,
    });
    expect(zero.commands).toStrictEqual([]);

    const grown = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + 2), y, buttons: 1 },
      anchorMode: 'snap',
      state: resizing.state,
    });
    const grownRelease = reduceGesture({
      ...dragArgsFor(target),
      pointer: { x: xForOrdinalIn(target, origin + 2), y, buttons: 0 },
      anchorMode: 'snap',
      state: grown.state,
    });
    const grownPatch = grownRelease.commands[0]?.patch ?? {};
    expect(grownPatch.durationDays).toBe(3);
    expect(grownPatch.endDate).toBe(fixture.calendar.isoOfOrdinal(origin + 2));
    expect(grownPatch).not.toHaveProperty('startDate');
  });

  it('拖动期视图带**会话锚点**重算也不会累积：基准是按下时的开始序号（R7 的第二道判据）', () => {
    // 这一条守的是**应用层真实的样子**：每帧 `compute(document, calendar, anchors)` →
    // `buildView` → 内核。缺陷正是"基准取成了指针当前所在行的 `es`"（它已经跟着锚点走了），
    // 于是每帧"再前进一段"累积成加速拖动 —— 只喂**未锚定**的视图的判据抓不到它，
    // 因此它是由记录制 `--drag` 的位移断言（`startDate` 必须 = 原开始 + dayDelta）当场抓出的。
    const pick = pickLeaf(
      ({ bounds: b, task }) => !b.isMilestone && b.es >= 3 && (task.durationDays ?? 0) >= 2,
    );
    const origin = pick.bounds.es;
    const y = rowCenterY(pick.row);
    const height = 2400;

    let schedule: Schedule = fixture.schedule;
    let currentView = viewWith(schedule, height);
    const started = beginGesture({
      view: currentView,
      document: fixture.document,
      schedule,
      calendar: fixture.calendar,
      pointer: { x: xForOrdinalIn(currentView, origin) + currentView.pxPerDay / 2, y, buttons: 1 },
      anchorMode: 'allow',
    });
    if (started.state.kind !== 'dragging') throw new Error('未进入拖动');
    let state = started.state;
    const candidates: number[] = [state.candidate];

    for (const offset of [1, 1, 1, 2, 2, 3]) {
      const anchored = compute(fixture.document, fixture.calendar, [
        { taskId: pick.task.id, startOrdinal: state.candidate },
      ]);
      if (!anchored.ok) throw new Error(`带锚点的排程失败：${anchored.code}`);
      schedule = anchored.schedule;
      currentView = viewWith(schedule, height);
      const moved = reduceGesture({
        view: currentView,
        document: fixture.document,
        schedule,
        calendar: fixture.calendar,
        pointer: { x: xForOrdinalIn(currentView, origin + offset), y, buttons: 1 },
        anchorMode: 'allow',
        state,
      });
      if (moved.state.kind !== 'dragging') throw new Error('拖动状态丢失');
      state = moved.state;
      candidates.push(state.candidate);
    }

    expect(candidates).toStrictEqual([
      origin,
      origin + 1,
      origin + 1,
      origin + 1,
      origin + 2,
      origin + 2,
      origin + 3,
    ]);
  });

  it('拖动结果超出日历地平线：**不抛错**，完成日退化为 `null`（与编辑通道同口径）', () => {
    const target = tallView;
    const pick = pickLeaf(
      ({ bounds: b, constraint: c, task }) =>
        !b.isMilestone && !Number.isFinite(c) && (task.durationDays ?? 0) >= 3,
    );
    const lastOrdinal = fixture.calendar.workdayCount - 1;
    // 直接构造"拖到最右"的状态：指针到不了地平线之外，但**结果**（开始 + 工期）可以。
    const state: GestureState = {
      kind: 'dragging',
      taskId: pick.task.id,
      sourceRow: pick.row,
      mode: 'move',
      originOrdinal: pick.bounds.es,
      grabOrdinal: pick.bounds.es,
      candidate: lastOrdinal,
    };

    const outcome = resolveDragOutcome({ state, document: fixture.document, calendar: fixture.calendar });
    expect(outcome).not.toBeNull();
    expect(outcome?.patch?.startDate).toBe(fixture.calendar.isoOfOrdinal(lastOrdinal));
    // 完成日越界 ⇒ `null`（派生显示值；与 `editToCommand` 的 `duration` 分支同形）——**不抛错**。
    expect(outcome?.patch?.endDate).toBeNull();

    // 预览同样不得抛错：地平线之外没有可画的几何 ⇒ `null`（调用方保持上一帧的呈现）。
    const preview = dragPreviewFor({
      view: target,
      document: fixture.document,
      calendar: fixture.calendar,
      state,
    });
    expect(preview === null || preview.xRight > preview.xLeft).toBe(true);
  });

  it('预览与提交**同源**：三语义的预览区间 == 落库 + 重算后该行的条形区间', () => {
    const target = tallView;
    const cases: readonly { readonly mode: 'move' | 'resize-start' | 'resize-duration'; readonly length: number }[] = [
      { mode: 'move', length: 3 },
      { mode: 'resize-start', length: 3 },
      { mode: 'resize-duration', length: 3 },
    ];

    for (const item of cases) {
      // 一律挑**无有效入边**的叶子：patch 的日期在重算后不会被 `dateOverridden` 覆盖，
      // 因此"预览 == 落库重算后的几何"这条断言检验的是预览本身，而不是引擎的锚点规则。
      const pick = pickLeaf(
        ({ bounds: b, constraint: c, task }) =>
          !b.isMilestone &&
          !Number.isFinite(c) &&
          (item.mode !== 'resize-start' || (task.durationDays ?? 0) >= 4),
      );
      const origin = pick.bounds.es;
      const duration = pick.task.durationDays ?? 0;
      const y = rowCenterY(pick.row);
      const downX =
        item.mode === 'move'
          ? grabPointOf(target, pick.bounds)
          : item.mode === 'resize-start'
            ? pick.bounds.xLeft + 1
            : pick.bounds.xRight - 1;
      const targetOrdinal =
        item.mode === 'resize-start'
          ? origin + item.length
          : item.mode === 'move'
            ? origin + item.length
            : origin + duration - 1 + item.length;

      const started = beginGesture({
        ...dragArgsFor(target),
        pointer: { x: downX, y, buttons: 1 },
        anchorMode: 'snap',
      });
      if (started.state.kind !== 'dragging') throw new Error('未进入拖动');
      const moved = reduceGesture({
        ...dragArgsFor(target),
        pointer: { x: xForOrdinalIn(target, targetOrdinal), y, buttons: 1 },
        anchorMode: 'snap',
        state: started.state,
      });

      const preview = dragPreviewFor({
        view: target,
        document: fixture.document,
        calendar: fixture.calendar,
        state: moved.state,
      });
      expect(preview).not.toBeNull();

      const released = reduceGesture({
        ...dragArgsFor(target),
        pointer: { x: xForOrdinalIn(target, targetOrdinal), y, buttons: 0 },
        anchorMode: 'snap',
        state: moved.state,
      });
      const patch = released.commands[0]?.patch ?? {};
      expect(Object.keys(patch).length).toBeGreaterThan(0);
      const committed = boundsAfterPatch(pick.task.id, patch);

      expect(preview?.xLeft).toBeCloseTo(committed.xLeft, 6);
      expect(preview?.xRight).toBeCloseTo(committed.xRight, 6);
    }
  });
});
