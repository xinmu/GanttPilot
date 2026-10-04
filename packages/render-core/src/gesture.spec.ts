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

import { compute, wouldCreateCycle } from '@ganttpilot/engine';

import { buildView, type ViewModel, type Viewport } from './viewModel.js';
import { ROW_HEIGHT, ROW_BUFFER, ZOOM_PX_PER_DAY } from './manifest.js';
import { buildFixture, DATASETS } from './fixtures.js';
import {
  beginGesture,
  dragModeFor,
  entryConstraintFor,
  reduceGesture,
  resolvePointerTarget,
  snapCandidate,
  type BeginGestureArgs,
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

function viewOf(zoom: 'day' | 'week' | 'month' = 'day'): ViewModel {
  return buildView({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    viewport,
    zoom,
  });
}

const view = viewOf('day');

/** 序号 → 该序号所在工作日格的**左端** x（内容坐标）。 */
function xForOrdinal(ordinal: number): number {
  return (fixture.calendar.dayOfOrdinal(ordinal) - view.axisOriginDay) * view.pxPerDay;
}

function rowCenterY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function boundsOfRow(row: number): TaskBounds {
  const docIndex = view.order[row];
  if (docIndex === undefined) throw new Error(`行 ${String(row)} 不在可见行序列里`);
  const bounds = taskBounds({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    rowOfDocIndex: view.rowOfDocIndex,
    axisOriginDay: view.axisOriginDay,
    pxPerDay: view.pxPerDay,
    rowHeight: view.rowHeight,
    docIndex,
  });
  if (bounds === null) throw new Error(`行 ${String(row)} 没有可画的条`);
  return bounds;
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

function dragArgs(): Omit<BeginGestureArgs, 'pointer' | 'anchorMode'> {
  return {
    view,
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
  };
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
      pointer: { x: (bounds.xLeft + bounds.xRight) / 2, y: rowCenterY(row), buttons: 1 },
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
      pointer: { x: (bounds.xLeft + bounds.xRight) / 2, y: rowCenterY(row), buttons: 1 },
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
      pointer: { x: (bounds.xLeft + bounds.xRight) / 2, y: rowCenterY(row), buttons: 1 },
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
      pointer: { x: (bounds.xLeft + bounds.xRight) / 2, y: rowCenterY(row), buttons: 1 },
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
    const startX = (bounds.xLeft + bounds.xRight) / 2;

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
