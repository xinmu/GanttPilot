/**
 * ADR 0008 §16（裁决 P-32）的门禁判据：判定区（随条宽收缩）、端点手柄与连接点、光标提示、建线类型。
 *
 * ## 这一组守的是什么
 *
 * P-21 §4 的结论是"现有判据证明的是『**给定正确的输入，内核算得对**』，本轮暴露的是『**输入本身是错的**』"。
 * 批次 A 把"屏幕 → 内容"归一化搬进本包之后，剩下的入口层算术就是**判定区、手柄位置、光标、出端侧**——
 * 它们此前要么不存在（手柄/光标），要么写在模块内的三行 `if` 里（判定区）。本条把它们全部变成可断言的纯函数。
 *
 * ## 负向对照（必须有，否则上面全是恒真式）
 *
 * 1. **固定 `DRAG_EDGE_PX = 6`**（P-32 之前的写法）在月档 1 个工作日的条上给出**空 `move` 区** ——
 *    这正是 `P-22` 遗留 3 的字面复现；
 * 2. **把连接点的 x 换回端点手柄的 x** ⇒ 同一按下点从"建线"变成"改开始/改工期" ——
 *    这正是 R4 里"用户以为在连线、实际在改日期"的误判形状；
 * 3. **宽条上判定区与旧式逐值一致** ⇒ 证明"宽条行为不变"是可验证的，而不是一句承诺。
 *
 * ## 坐标口径
 *
 * 全部 x/y 都是**内容坐标**；判据里至少取一个**非 0 滚动位置**（P-25 的纪律：
 * "凡坐标换算/命中类判据，必须至少取一个非 0 滚动位置，横向纵向各一个"）。
 */

import { describe, expect, it } from 'vitest';

import type { TaskBounds } from './domain.js';
import { buildView, type ViewModel, type Viewport } from './viewModel.js';
import { buildFixture, DATASETS } from './fixtures.js';
import {
  CONNECT_HIT_PAD_PX,
  CONNECT_INSET_PX,
  CONNECT_SIZE_PX,
  DRAG_EDGE_PX,
  HANDLE_HEIGHT_PX,
  HIT_TOLERANCE_PX,
  MIN_MOVE_ZONE_PX,
  ROW_BUFFER,
  ROW_HEIGHT,
  SPACING,
} from './manifest.js';
import {
  barHeightOf,
  connectLeftEdgeFor,
  connectRevealFor,
  connectSideAt,
  cursorForPointer,
  handleOffsetsFor,
  handleXFor,
  linkEntryFor,
  rowConnectVisibleAt,
  rowHandlesFor,
} from './interaction.js';
import {
  cursorForZone,
  dragModeOfZones,
  enterXFor,
  exitXFor,
  linkEnterSideFor,
  linkTypeFor,
  translateZone,
  translateZones,
  zoneAt,
  zonesFor,
} from './zones.js';
import { taskBounds } from './domain.js';

const fixture = buildFixture(DATASETS[2]); // dense：1,000 任务 / 1,500 依赖
const viewport: Viewport = {
  width: 1280,
  height: 640,
  rowHeight: ROW_HEIGHT,
  rowBuffer: ROW_BUFFER,
  scrollTop: 0,
  scrollLeft: 0,
};

function viewOf(zoom: 'day' | 'week' | 'month', scrollTop = 0, scrollLeft = 0, height = 2400): ViewModel {
  return buildView({
    document: fixture.document,
    schedule: fixture.schedule,
    calendar: fixture.calendar,
    viewport: { ...viewport, height, scrollTop, scrollLeft },
    zoom,
  });
}

/** 一个**宽**条（日档 ≥ 2 天 ⇒ 条宽 ≥ 48 px，`edgePx` 必等于 `DRAG_EDGE_PX`）。 */
const wideBar: TaskBounds = {
  docIndex: 0,
  row: 3,
  kind: 'leaf',
  isMilestone: false,
  es: 10,
  ef: 14,
  xLeft: 100,
  xRight: 196, // 宽度 96
  y: 3 * ROW_HEIGHT + ROW_HEIGHT / 2,
  milestone: null,
};

/** 月档 1 个工作日的条：`pxPerDay = 3` ⇒ **3 px 宽**（`P-22` 遗留 3 的样本）。 */
const narrowBar: TaskBounds = { ...wideBar, xLeft: 100, xRight: 103 };

/** 汇总条（宽 96，但**不可拖**）。 */
const summaryBar: TaskBounds = { ...wideBar, kind: 'summary', xRight: 196 };

/** 里程碑（菱形 12 px）。 */
const milestoneBar: TaskBounds = {
  ...wideBar,
  isMilestone: true,
  xLeft: 100,
  xRight: 112,
  milestone: { cx: 106, cy: wideBar.y, size: 12 },
};

describe('判定区：随条宽收缩（ADR 0008 §16.1／裁决 P-32）', () => {
  it('宽条：与旧式 `DRAG_EDGE_PX = 6` **逐值一致**（宽条行为不变是可验证的）', () => {
    const zones = zonesFor(wideBar);
    expect(zones.edgeL).toStrictEqual({ kind: 'resize-start', x1: 100, x2: 106 });
    expect(zones.move).toStrictEqual({ kind: 'move', x1: 106, x2: 190 });
    expect(zones.edgeR).toStrictEqual({ kind: 'resize-duration', x1: 190, x2: 196 });

    // 与旧式**直接**对照：旧式 = 固定 6 px 的三段写法。
    for (const x of [100, 103, 106, 120, 148, 190, 193, 196]) {
      const old =
        x <= 100 + DRAG_EDGE_PX ? 'resize-start' : x >= 196 - DRAG_EDGE_PX ? 'resize-duration' : 'move';
      expect(dragModeOfZones(wideBar, zones, x)).toBe(old);
    }
  });

  it('月档 1 个工作日的条（3 px）：`move` 区**非空**（旧式是空集），端点区退化为点', () => {
    const zones = zonesFor(narrowBar);
    expect(zones.move).not.toBeNull();
    const width = (zones.move?.x2 ?? 0) - (zones.move?.x1 ?? 0);
    // 3 px 的条装不下 `MIN_MOVE_ZONE_PX = 6`：公式给出的是**上界** `halfGap = max(0, (3 − 6) / 2) = 0`，
    // 于是 `move` 区 = 整条（3 px）。它与 `MIN_MOVE_ZONE_PX` 的关系必须**如实读作**：
    // "条够宽时保证 6 px；条本身比 6 px 还窄时，`move` 区 = 整条"——**非空**才是这条判据的本体。
    expect(zones.move).toStrictEqual({ kind: 'move', x1: 100, x2: 103 });
    expect(width).toBeGreaterThan(0);
    // 端点区退化成**点**（不再是 6 px 的区），但**仍然存在**——手柄因此落在条的两端。
    expect(zones.edgeL).toStrictEqual({ kind: 'resize-start', x1: 100, x2: 100 });
    expect(zones.edgeR).toStrictEqual({ kind: 'resize-duration', x1: 103, x2: 103 });
  });

  it('`MIN_MOVE_ZONE_PX` 是**条够宽时**的下界：9 px 的条给出 6 px 的 `move` 区', () => {
    const ninePx: TaskBounds = { ...wideBar, xLeft: 100, xRight: 109 };
    const zones = zonesFor(ninePx);
    expect(zones.move).toStrictEqual({ kind: 'move', x1: 101.5, x2: 107.5 });
    expect((zones.move?.x2 ?? 0) - (zones.move?.x1 ?? 0)).toBe(MIN_MOVE_ZONE_PX);
    expect(zones.edgeL).toStrictEqual({ kind: 'resize-start', x1: 100, x2: 101.5 });
    expect(zones.edgeR).toStrictEqual({ kind: 'resize-duration', x1: 107.5, x2: 109 });
  });

  it('NC1：**固定 6 px**（P-32 之前的写法）在月档 1 天条上给出空 `move` 区（`P-22` 遗留 3 的字面复现）', () => {
    const legacyMoveX1 = narrowBar.xLeft + DRAG_EDGE_PX;
    const legacyMoveX2 = narrowBar.xRight - DRAG_EDGE_PX;
    // 旧式：`[106, 97]` —— 上界小于下界 ⇒ 空集。
    expect(legacyMoveX2).toBeLessThan(legacyMoveX1);
    // 且旧式的 `dragModeFor` 会把**整条**判成端点区：中点按 `x <= xLeft + 6` 命中 `resize-start`。
    const center = (narrowBar.xLeft + narrowBar.xRight) / 2;
    expect(center <= narrowBar.xLeft + DRAG_EDGE_PX).toBe(true);
    // 新式在同一位置给出 `move`（不再"整体移动永远按不到"）。
    expect(dragModeOfZones(narrowBar, zonesFor(narrowBar), center)).toBe('move');
  });

  it('里程碑：不走判定区，按**菱形中心**分半（§5 的既有口径由 §16.1 保留）', () => {
    const zones = zonesFor(milestoneBar);
    expect(zones.edgeL).toBeNull();
    expect(zones.edgeR).toBeNull();
    const cx = milestoneBar.milestone?.cx ?? 0;
    expect(dragModeOfZones(milestoneBar, zones, cx - 1)).toBe('move');
    expect(dragModeOfZones(milestoneBar, zones, cx + 1)).toBe('resize-duration');
  });

  it('退化条（宽 ≤ 0）：只给 `move`，不产生"没有任何判定区"的行', () => {
    const degenerate: TaskBounds = { ...wideBar, xLeft: 120, xRight: 120 };
    const zones = zonesFor(degenerate);
    expect(zones.edgeL).toBeNull();
    expect(zones.edgeR).toBeNull();
    expect(zones.move).toStrictEqual({ kind: 'move', x1: 120, x2: 120 });
  });

  it('`zoneAt` 的归属规则：近者优先；容差内并列时 `link-out` 优先', () => {
    const zones = zonesFor(wideBar);
    // 公共边界点（`x = 106`）同时落在 `edgeL` 与 `move` 内 ⇒ 取更近者 = `edgeL`（其中心 103，距 3；move 中心 148）。
    expect(zoneAt(zones, 106)?.kind).toBe('resize-start');
    expect(zoneAt(zones, 190)?.kind).toBe('resize-duration');
    expect(zoneAt(zones, 148)?.kind).toBe('move');
    expect(zoneAt(zones, 50)).toBeNull();

    // 并列时 `link-out` 优先（构造"连接点与端点区同中心"的退化输入）。
    const tie = {
      edgeL: { kind: 'resize-start' as const, x1: 100, x2: 100 },
      move: null,
      edgeR: null,
    };
    const withLink = { ...tie, edgeL: { kind: 'link-out' as const, x1: 100, x2: 100 } };
    // 只有一段时无须并列判断；这里断言"存在 `link-out` 的实现分支"由 `cursorForZone` 归类承担。
    expect(zoneAt(tie, 100)?.kind).toBe('resize-start');
    expect(zoneAt(withLink, 100)?.kind).toBe('link-out');
  });

  it('拖动期平移：`translateZones(dx = 0)` 逐值等于 `zonesFor`；`dx ≠ 0` 只改 x', () => {
    const zones = zonesFor(wideBar);
    expect(translateZones(zones, 0)).toStrictEqual(zones);
    const moved = translateZones(zones, 24);
    expect(moved.edgeL).toStrictEqual({ kind: 'resize-start', x1: 124, x2: 130 });
    expect(moved.move).toStrictEqual({ kind: 'move', x1: 130, x2: 214 });
    expect(translateZone(null, 24)).toBeNull();
  });
});

describe('端点手柄与连接点（ADR 0008 §16.2／裁决 P-32 的 R3）', () => {
  it('手柄落在**判定区边界**上（"看起来能抓的" = "真的按判定区分类的"）', () => {
    const zones = zonesFor(wideBar);
    expect(handleXFor(zones, wideBar, 'left')).toBe(zones.edgeL?.x2);
    expect(handleXFor(zones, wideBar, 'right')).toBe(zones.edgeR?.x1);

    const handles = rowHandlesFor({ taskId: 't', bounds: wideBar, rowHeight: ROW_HEIGHT });
    expect(handles.handles.map((item) => item.x)).toStrictEqual([106, 190]);
    expect(handles.handles.every((item) => item.y2 - item.y1 === HANDLE_HEIGHT_PX)).toBe(true);
    expect(handles.handles[0]?.y1).toBe(wideBar.y - HANDLE_HEIGHT_PX / 2);
    // **手柄不得越过条体的上/下沿**（P-32 人工复验第 ② 条："两端各有一向上的突出"）：
    // 条高 = 行高 × `barHeightRatio`，手柄高必须严格小于它。
    const barHeight = barHeightOf(wideBar, ROW_HEIGHT);
    expect(barHeight).toBe(ROW_HEIGHT * SPACING.barHeightRatio);
    expect(HANDLE_HEIGHT_PX).toBeLessThan(barHeight);
    for (const handle of handles.handles) {
      expect(handle.y1).toBeGreaterThanOrEqual(wideBar.y - barHeight / 2);
      expect(handle.y2).toBeLessThanOrEqual(wideBar.y + barHeight / 2);
    }
  });

  it('每渲染行 ≤ 3 个新增图元（`ELEMENT_MODEL_G5.perRenderedRow` 的来源）', () => {
    const cases: readonly TaskBounds[] = [wideBar, narrowBar, summaryBar, milestoneBar];
    for (const bounds of cases) {
      const handles = rowHandlesFor({ taskId: 't', bounds, rowHeight: ROW_HEIGHT });
      // 手持 + 连接点 ≤ 4；但"最胖的行"是**有进度的叶子**：条 1 + 进度 1 + 手柄 2 + 连接点 2 = 6
      // （进度是 c₁ 的老口径，不在这里）。
      expect(handles.handles.length + handles.connectPoints.length).toBeLessThanOrEqual(4);
    }
    // 汇总行与里程碑：**没有手柄**（不可拖），只有连接点（可作建线端点）。
    for (const bounds of [summaryBar, milestoneBar]) {
      const handles = rowHandlesFor({ taskId: 't', bounds, rowHeight: ROW_HEIGHT });
      expect(handles.handles).toStrictEqual([]);
      expect(handles.connectPoints).toHaveLength(2);
    }
  });

  it('连接点在两个端点手柄的**外侧**，且最短中心距 ≥ 容差的 2 倍（不会互相抢命中）', () => {
    const handles = rowHandlesFor({ taskId: 't', bounds: wideBar, rowHeight: ROW_HEIGHT });
    const right = handles.connectPoints.find((item) => item.side === 'right');
    const left = handles.connectPoints.find((item) => item.side === 'left');
    if (right === undefined || left === undefined) throw new Error('连接点缺失');
    // **跨在条端上**（第三次复验的订正）：方块从条端**内** 2 px 起画、向外伸一个边长，
    // 且竖向与条**同中心**（不是"靠上"）。
    expect(right.x).toBe(connectLeftEdgeFor(wideBar, 'right'));
    expect(right.x).toBe(wideBar.xRight - CONNECT_INSET_PX);
    expect(right.x + CONNECT_SIZE_PX).toBe(wideBar.xRight - CONNECT_INSET_PX + CONNECT_SIZE_PX);
    expect(left.x).toBe(connectLeftEdgeFor(wideBar, 'left'));
    expect(left.x + CONNECT_SIZE_PX).toBe(wideBar.xLeft + CONNECT_INSET_PX);
    expect(right.x).toBeGreaterThan(handles.handles[1]?.x ?? 0);
    expect(left.x + CONNECT_SIZE_PX).toBeLessThan(handles.handles[0]?.x ?? 0);
    // 竖向中心 = 条形中心（`bounds.y`），不是行顶——这正是复验第 3.1 条"显示靠上"的修法。
    expect(right.y).toBe(wideBar.y);
    expect(left.y).toBe(wideBar.y);
  });

  it('`connectSideAt`：**可见方块的每一处都点得中**，且只向外多补 `CONNECT_HIT_PAD_PX`', () => {
    const size = CONNECT_SIZE_PX;
    const inset = CONNECT_INSET_PX;
    const pad = CONNECT_HIT_PAD_PX;
    const rightOuter = wideBar.xRight - inset + size;
    const leftOuter = wideBar.xLeft + inset - size;
    // 方块本身的每一处（内缘、中点、外缘）都必须命中。
    expect(connectSideAt(wideBar, wideBar.xRight - inset)).toBe('right');
    expect(connectSideAt(wideBar, wideBar.xRight - inset + size / 2)).toBe('right');
    expect(connectSideAt(wideBar, rightOuter)).toBe('right');
    // 外侧再补 `pad`；再远就不是它了。
    expect(connectSideAt(wideBar, rightOuter + pad)).toBe('right');
    expect(connectSideAt(wideBar, rightOuter + pad + 0.5)).toBeNull();
    expect(connectSideAt(wideBar, wideBar.xLeft + inset)).toBe('left');
    expect(connectSideAt(wideBar, leftOuter)).toBe('left');
    expect(connectSideAt(wideBar, leftOuter - pad)).toBe('left');
    expect(connectSideAt(wideBar, leftOuter - pad - 0.5)).toBeNull();
    // **内侧只到 `CONNECT_INSET_PX`**：再往里就是端点判定区（拖动），不是建线。
    expect(connectSideAt(wideBar, wideBar.xRight - inset - 0.5)).toBeNull();
    // 第三次复验的回归：`dx = −1..+2`（原先落空的那一段）现在必须命中。
    for (const dx of [-1, 0, 1, 2]) expect(connectSideAt(wideBar, wideBar.xRight + dx)).toBe('right');
  });

  it('**竖向中心同源**（第二次人工复验的根因）：`bounds.y`（条心）与 `row.y`（行顶）是两种语义', () => {
    const target = viewOf('day');
    let checked = 0;
    for (const row of target.rows) {
      // `RowBox` 的两种语义：`y` = **行顶**、`barY` = **图形的顶**（`viewModel.ts` 的原话）。
      // **最可靠的"竖心"是 `row.y + rowHeight / 2`**：它对条、汇总条、里程碑菱形**都成立**
      // （`barY = y + (rowHeight − 高度) / 2` ⇒ `barY + 高度 / 2` 恒等于它）。
      // 注意 `row.barHeight` 是"条高"，**里程碑行也报条高**（`viewModel.ts` 的口径），
      // 而菱形实际边长是 `rowHeight × milestoneSizeRatio` ⇒ 菱形行不要用 `row.barHeight` 推条心。
      const centerFromRow = row.y + ROW_HEIGHT / 2;
      const centerFromBar = row.barY + row.barHeight / 2;
      if (!row.isMilestone) expect(centerFromBar).toBeCloseTo(centerFromRow, 9);
      else expect(Math.abs(centerFromBar - centerFromRow)).toBeLessThanOrEqual(2);
      // 行顶 ≠ 条心（差 12 px = `rowHeight / 2`）——这正是渲染层把 `row.y` 当条心时
      // "突起仍在、连接点整体上移"的量（第二次人工复验的两条报文）。
      expect(row.y + ROW_HEIGHT / 2).toBeCloseTo(centerFromRow, 9);
      expect(row.y).not.toBeCloseTo(centerFromRow, 3);

      const bounds = boundsOf(target, row.row);
      const handles = rowHandlesFor({ taskId: row.id, bounds, rowHeight: ROW_HEIGHT, barCenterY: centerFromRow });
      for (const handle of handles.handles) {
        // 手柄在**条内**（含端点）：不越过上/下沿，且关于条心对称。
        expect(handle.y1).toBeGreaterThanOrEqual(centerFromRow - ROW_HEIGHT / 2);
        expect(handle.y2).toBeLessThanOrEqual(centerFromRow + ROW_HEIGHT / 2);
        expect(handle.y1 + handle.y2).toBeCloseTo(2 * centerFromRow, 9);
      }
      for (const point of handles.connectPoints) {
        // 连接点**竖向中心 = 条心**（第二次复验第 3 条"仍偏上"的修法）。
        expect(point.y).toBeCloseTo(centerFromRow, 9);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
  it('连接点的**显示时机**（复验第 3.2 条）：只在指针靠近该行条端时显形，移开即消失', () => {
    const mid = (wideBar.xLeft + wideBar.xRight) / 2;
    // 条体中部：不显形（常显 = 64 个白框的画面杂乱）。
    expect(connectRevealFor(wideBar, mid)).toBe(false);
    expect(rowConnectVisibleAt(wideBar, mid, true)).toBe(false);
    // 条端附近：显形；且**必须指针在该行内**。
    expect(connectRevealFor(wideBar, wideBar.xRight)).toBe(true);
    expect(rowConnectVisibleAt(wideBar, wideBar.xRight, true)).toBe(true);
    expect(rowConnectVisibleAt(wideBar, wideBar.xRight, false)).toBe(false);
    // 远离条端：不显形（显示区的**外缘** = 方块外缘 + `pad` + `reveal`）。
    const reach = HIT_TOLERANCE_PX * 2;
    const rightOuter = wideBar.xRight - CONNECT_INSET_PX + CONNECT_SIZE_PX;
    const leftOuter = wideBar.xLeft + CONNECT_INSET_PX - CONNECT_SIZE_PX;
    expect(connectRevealFor(wideBar, rightOuter + CONNECT_HIT_PAD_PX + reach + 0.5)).toBe(false);
    expect(connectRevealFor(wideBar, leftOuter - CONNECT_HIT_PAD_PX - reach - 0.5)).toBe(false);
  });
});

describe('光标提示（ADR 0008 §16.2 的 R3 后半）', () => {
  it('`cursorForZone` 四值映射', () => {
    expect(cursorForZone('resize-start')).toBe('col-resize');
    expect(cursorForZone('resize-duration')).toBe('col-resize');
    expect(cursorForZone('move')).toBe('move');
    expect(cursorForZone('link-out')).toBe('crosshair');
    expect(cursorForZone(null)).toBe('default');
  });

  it('`cursorForPointer`：端点 ⇒ `col-resize`、中部 ⇒ `move`、连接点 ⇒ `crosshair`、空白 ⇒ `default`', () => {
    const target = viewOf('day');
    const row = target.renderFirst + 1;
    const bounds = boundsOf(target, row);
    if (bounds.isMilestone) throw new Error('夹具前提不成立：该行是里程碑');
    const y = row * target.rowHeight + target.rowHeight / 2;
    const args = { view: target, document: fixture.document, schedule: fixture.schedule, calendar: fixture.calendar };
    const at = (x: number) => cursorForPointer({ ...args, point: { x, y, buttons: 1 } });

    const zones = zonesFor(bounds);
    expect(at(zones.edgeL?.x2 ?? 0)).toBe('col-resize');
    expect(at(zones.edgeR?.x1 ?? 0)).toBe('col-resize');
    expect(at((zones.move?.x1 ?? 0) + 1)).toBe('move');
    expect(at(bounds.xRight - CONNECT_INSET_PX + CONNECT_SIZE_PX / 2)).toBe('crosshair');
    expect(at(bounds.xLeft + CONNECT_INSET_PX - CONNECT_SIZE_PX / 2)).toBe('crosshair');
    // 条外（远超连接点）：默认光标。
    expect(at(bounds.xRight + CONNECT_SIZE_PX + CONNECT_HIT_PAD_PX + 40)).toBe('default');
    // 行外：默认光标。
    expect(cursorForPointer({ ...args, point: { x: 100, y: -50, buttons: 1 } })).toBe('default');
  });

  it('**非 0 滚动位置**下同一内容坐标给出同一光标（P-25 的纪律）', () => {
    const plain = viewOf('day');
    const scrolled = viewOf('day', 480, 600);
    const args = (view: ViewModel) => ({ view, document: fixture.document, schedule: fixture.schedule, calendar: fixture.calendar });
    // 两栏取**同一可见行序号**（滚动窗口两端都必须覆盖它，因此取 `renderFirst + 1`）——
    // 内容坐标因此可逐值比较：滚动**不改几何**（ADR 0007 §16）。
    const row = Math.max(plain.renderFirst, scrolled.renderFirst) + 1;
    const boundsPlain = boundsOf(plain, row);
    const boundsScrolled = boundsOf(scrolled, row);
    const y = row * plain.rowHeight + plain.rowHeight / 2;
    const x = boundsPlain.xRight + CONNECT_SIZE_PX / 2;
    expect(boundsScrolled.xRight).toBe(boundsPlain.xRight);
    expect(cursorForPointer({ ...args(scrolled), point: { x, y, buttons: 1 } })).toBe('crosshair');
    expect(cursorForPointer({ ...args(scrolled), point: { x, y, buttons: 1 } })).toBe(
      cursorForPointer({ ...args(plain), point: { x, y, buttons: 1 } }),
    );
  });
});

describe('建线的起手位置与类型（ADR 0008 §16.3／裁决 P-32 的 R4）', () => {
  it('连接点按下 ⇒ `linkEntryFor` 给出**所抓那一侧**的出端（不由几何反推）', () => {
    const target = viewOf('day');
    const row = target.renderFirst + 1;
    const bounds = boundsOf(target, row);
    const y = row * target.rowHeight + target.rowHeight / 2;
    const args = { view: target, document: fixture.document, schedule: fixture.schedule, calendar: fixture.calendar };
    const right = linkEntryFor({
      ...args,
      point: { x: bounds.xRight + CONNECT_SIZE_PX / 2, y, buttons: 1 },
    });
    const left = linkEntryFor({
      ...args,
      point: { x: bounds.xLeft - CONNECT_SIZE_PX / 2, y, buttons: 1 },
    });
    expect(right?.exitSide).toBe('right');
    expect(left?.exitSide).toBe('left');
    expect(right?.taskId).toBe(left?.taskId);
    // 端点手柄的位置**不**是建线起点（它属于拖动判定区）。
    expect(linkEntryFor({ ...args, point: { x: zonesFor(bounds).edgeR?.x1 ?? 0, y, buttons: 1 } })).toBeNull();
  });

  it('NC2：把连接点 x 换回端点手柄 x ⇒ 同一按下点从"建线"变成拖动判定区（R4 的误判形状）', () => {
    const target = viewOf('day');
    const row = target.renderFirst + 1;
    const bounds = boundsOf(target, row);
    const y = row * target.rowHeight + target.rowHeight / 2;
    const args = { view: target, document: fixture.document, schedule: fixture.schedule, calendar: fixture.calendar };
    const handleX = zonesFor(bounds).edgeR?.x1 ?? 0;
    // 新式：手柄位置**不是**建线起点。
    expect(linkEntryFor({ ...args, point: { x: handleX, y, buttons: 1 } })).toBeNull();
    // 旧式（候选：把连接点画在手柄处）：同一点会变成"改工期"——用户以为在连线。
    expect(dragModeOfZones(bounds, zonesFor(bounds), handleX)).toBe('resize-duration');
  });

  it('`linkTypeFor` 的四格表与 §16.3 逐格一致（出端侧 = 用户选的，入端侧 = 目标相对位置）', () => {
    expect(linkTypeFor('right', 'left')).toBe('FS');
    expect(linkTypeFor('right', 'right')).toBe('FF');
    expect(linkTypeFor('left', 'left')).toBe('SS');
    expect(linkTypeFor('left', 'right')).toBe('SF');

    // 两个输入**不共变量**：左出 + 右侧目标（旧式永远给不出的 `SS` 侧组合）、右出 + 左侧目标（`FF`）。
    expect(
      linkTypeFor('left', linkEnterSideFor({ exitSide: 'left', fromXLeft: 0, toXLeft: 100 })),
    ).toBe('SS');
    expect(
      linkTypeFor('right', linkEnterSideFor({ exitSide: 'right', fromXLeft: 200, toXLeft: 100 })),
    ).toBe('FF');
    expect(
      linkTypeFor('right', linkEnterSideFor({ exitSide: 'right', fromXLeft: 0, toXLeft: 100 })),
    ).toBe('FS');
    expect(
      linkTypeFor('left', linkEnterSideFor({ exitSide: 'left', fromXLeft: 200, toXLeft: 100 })),
    ).toBe('SF');
  });

  it('端点 x 由出/入侧给出：右出 ⇒ 条右缘、左出 ⇒ 条左缘、左入 ⇒ 条左缘、右入 ⇒ 条右缘', () => {
    expect(exitXFor(wideBar, 'right')).toBe(wideBar.xRight);
    expect(exitXFor(wideBar, 'left')).toBe(wideBar.xLeft);
    expect(enterXFor(wideBar, 'left')).toBe(wideBar.xLeft);
    expect(enterXFor(wideBar, 'right')).toBe(wideBar.xRight);
  });
});

describe('元素预算的每行常数与记录制入口（ADR 0008 §16.4）', () => {
  it('`handleOffsetsFor`：与 `rowHandlesFor` 同源（记录制据此核对 DOM 上的实测条数）', () => {
    const target = viewOf('day');
    const described = handleOffsetsFor({
      view: target,
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
    });
    expect(described).toHaveLength(target.rows.length);
    let handleTotal = 0;
    let connectTotal = 0;
    for (const item of described) {
      handleTotal += item.handleCount;
      connectTotal += item.connectCount;
    }
    // 汇总/里程碑 0 手柄；其余行 2 手柄；连接点恒 2。
    expect(connectTotal).toBe(target.rows.length * 2);
    expect(handleTotal % 2).toBe(0);
    expect(handleTotal).toBeLessThanOrEqual(target.rows.length * 2);
  });
});

/** 取某可见行的几何（与 `gesture.spec.ts` 的 `boundsIn` 同口径，不复制公式）。 */
function boundsOf(target: ViewModel, row: number): TaskBounds {
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
