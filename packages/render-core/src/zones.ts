/**
 * 判定区：**三语义的边界公式**（ADR 0008 §5，**由 §16.1 修订**／裁决 P-32）。
 *
 * ## 为什么它独立成一个模块
 *
 * ADR 0008 §16.1 把"判定区随条宽收缩"定为**唯一一条公式**，而它的消费者分布在一个环上：
 * `gesture.ts` 需要它决定拖动语义（`dragModeFor`），`interaction.ts` 需要它决定手柄位置与光标提示。
 * 若把公式放在两者之一，就必然出现"谁 import 谁"的环。因此公式自己住一层：
 *
 * ```
 * manifest ── domain ──┐
 *                      ├── zones.ts ──┬── gesture.ts
 *                      └──────────────┴── interaction.ts
 * ```
 *
 * 本模块**零 DOM、零框架、零副作用**，只做纯算术（因此它的判据可以在 Node 侧逐值断言）。
 *
 * ## 唯一公式（§16.1）
 *
 * ```
 * halfGap = max(0, (条宽 − MIN_MOVE_ZONE_PX) / 2)
 * edgePx  = min(DRAG_EDGE_PX, halfGap)          // 6 是**上界**，不是定值
 * edgeL   = [xLeft,          xLeft + edgePx]
 * move    = [xLeft + edgePx, xRight − edgePx]
 * edgeR   = [xRight − edgePx, xRight]
 * ```
 *
 * **宽条（条宽 ≥ 18 px）与 P-32 之前逐值相同**；**窄条不再出现空集**
 * （月档 `pxPerDay = 3` 的 1 个工作日条只有 3 px，"整体移动"因此永远存在）。
 */

import type { TaskBounds } from './domain.js';
import { DRAG_EDGE_PX, MIN_MOVE_ZONE_PX } from './manifest.js';

/** 判定区的语义（`link-out` 是 §16.3 的建线连接点，不是条体上的区）。 */
export type DragZoneKind = 'resize-start' | 'move' | 'resize-duration' | 'link-out';

/** 一段判定区（**闭区间**，内容坐标）。 */
export interface DragZone {
  readonly kind: DragZoneKind;
  readonly x1: number;
  readonly x2: number;
}

/** 一行条/菱形的判定区（`null` = 该语义在本行不存在）。 */
export interface DragZones {
  readonly edgeL: DragZone | null;
  readonly move: DragZone | null;
  readonly edgeR: DragZone | null;
}

/** 光标提示（**枚举**；由 `apps/web` 赋给 `pane.style.cursor`，本包不碰 DOM）。 */
export type CursorHint = 'col-resize' | 'move' | 'crosshair' | 'default';

/**
 * 判定区的**唯一**产出函数（ADR 0008 §16.1）。
 *
 * - **里程碑**不适用本条（§5 已冻结"按菱形中心分半"）⇒ `edgeL = edgeR = null`、`move` 覆盖整条；
 * - **退化条**（条宽 ≤ 0，理论上不出现）同样只给 `move`，以免出现"没有任何判定区"的行。
 */
export function zonesFor(bounds: TaskBounds): DragZones {
  const width = bounds.xRight - bounds.xLeft;
  if (bounds.isMilestone || width <= 0) {
    return { edgeL: null, move: { kind: 'move', x1: bounds.xLeft, x2: bounds.xRight }, edgeR: null };
  }
  const halfGap = Math.max(0, (width - MIN_MOVE_ZONE_PX) / 2);
  const edgePx = Math.min(DRAG_EDGE_PX, halfGap);
  return {
    edgeL: { kind: 'resize-start', x1: bounds.xLeft, x2: bounds.xLeft + edgePx },
    move: { kind: 'move', x1: bounds.xLeft + edgePx, x2: bounds.xRight - edgePx },
    edgeR: { kind: 'resize-duration', x1: bounds.xRight - edgePx, x2: bounds.xRight },
  };
}

/** 判定区是否包含 `x`（**闭区间**）。 */
export function zoneContains(zone: DragZone, x: number): boolean {
  return x >= zone.x1 && x <= zone.x2;
}

/**
 * `x` 落在哪一段判定区（`null` = 不在任何判定区内）。
 *
 * 归属规则（§16.3 的"选中规则"）：**近者优先**——同时落在两段内时（窄条退化、相邻段的公共边界点），
 * 取离该段中心更近的那一段；距离并列时 `link-out` 优先。**不做**"更远者胜"：
 * 那会让连接点吃掉整个端点判定区。
 */
export function zoneAt(zones: DragZones, x: number): DragZone | null {
  const candidates: DragZone[] = [];
  if (zones.edgeL !== null && zoneContains(zones.edgeL, x)) candidates.push(zones.edgeL);
  if (zones.move !== null && zoneContains(zones.move, x)) candidates.push(zones.move);
  if (zones.edgeR !== null && zoneContains(zones.edgeR, x)) candidates.push(zones.edgeR);
  if (candidates.length === 0) return null;
  let best = candidates[0] as DragZone;
  let bestDistance = Math.abs(x - (best.x1 + best.x2) / 2);
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(x - (candidate.x1 + candidate.x2) / 2);
    const preferLinkOut = distance === bestDistance && candidate.kind === 'link-out' && best.kind !== 'link-out';
    if (distance < bestDistance || preferLinkOut) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 判定区 → 拖动语义（**里程碑按菱形中心分半**，§5 的既有口径由 §16.1 保留）。
 *
 * `x` 落在判定区之外（条外、空白）时返回 `'move'`——调用方必须先过 `barHitFor`/连接点判定，
 * 本函数**不承担命中检查**（那是 `gesture.ts` 的前置）。
 */
export function dragModeOfZones(
  bounds: TaskBounds,
  zones: DragZones,
  x: number,
): 'move' | 'resize-start' | 'resize-duration' {
  if (bounds.isMilestone) {
    // 里程碑只有"整体移动"，但拖右半边是"把它变成有长度的任务"（改工期）。
    // `DRAG_EDGE_PX` 相对 12 px 宽的菱形太大（菱形中心距边只有 6 px），因此这里按**中心**分半。
    const cx = bounds.milestone?.cx ?? (bounds.xLeft + bounds.xRight) / 2;
    return x >= cx ? 'resize-duration' : 'move';
  }
  const zone = zoneAt(zones, x);
  if (zone === null) return 'move';
  return zone.kind === 'link-out' ? 'move' : zone.kind;
}

/** 判定区语义 → 光标（`col-resize` = 可改宽度，`move` = 可整体移动，`crosshair` = 可从连接点拉线）。 */
export function cursorForZone(kind: DragZoneKind | null): CursorHint {
  if (kind === 'resize-start' || kind === 'resize-duration') return 'col-resize';
  if (kind === 'move') return 'move';
  if (kind === 'link-out') return 'crosshair';
  return 'default';
}

/** 判定区整体平移 `dx`（拖动期"画出来的条 = 结果几何"的配套，ADR 0008 §14）。 */
export function translateZone(zone: DragZone | null, dx: number): DragZone | null {
  if (zone === null) return null;
  return { kind: zone.kind, x1: zone.x1 + dx, x2: zone.x2 + dx };
}

/** 平移后的判定区集合（`dx = 0` 时逐值等于 {@link zonesFor} 的结果）。 */
export function translateZones(zones: DragZones, dx: number): DragZones {
  return {
    edgeL: translateZone(zones.edgeL, dx),
    move: translateZone(zones.move, dx),
    edgeR: translateZone(zones.edgeR, dx),
  };
}

// ---------------------------------------------------------------- 建线类型（§16.3 的四格表）

/** 出端的端点 x（右出 ⇒ 条右缘；左出 ⇒ 条左缘）。 */
export function exitXFor(bounds: { readonly xLeft: number; readonly xRight: number }, exitSide: 'left' | 'right'): number {
  return exitSide === 'right' ? bounds.xRight : bounds.xLeft;
}

/** 入端的端点 x（左入 ⇒ 条左缘；右入 ⇒ 条右缘）。 */
export function enterXFor(bounds: { readonly xLeft: number; readonly xRight: number }, enterSide: 'left' | 'right'): number {
  return enterSide === 'left' ? bounds.xLeft : bounds.xRight;
}

/**
 * 入端侧：目标在出端的**右侧** ⇒ 入端为目标的**左**缘；否则为**右**缘。
 *
 * `exitSide` 是语义常量（它决定出端取哪个 x 端点），入端侧**只**由横向相对位置决定——
 * 两个输入因此**不共变量**，四类关系都可产出（旧式只按 `to.xLeft >= from.xLeft` 两分支，
 * 永远只能得到 `FS`/`SS`）。
 */
export function linkEnterSideFor(args: {
  readonly exitSide: 'left' | 'right';
  readonly fromXLeft: number;
  readonly toXLeft: number;
}): 'left' | 'right' {
  void args.exitSide;
  return args.toXLeft >= args.fromXLeft ? 'left' : 'right';
}

/** 出端侧 × 入端侧 → 关系类型（ADR 0008 §16.3 的四格表）。 */
export function linkTypeFor(exitSide: 'left' | 'right', enterSide: 'left' | 'right'): 'FS' | 'FF' | 'SS' | 'SF' {
  if (exitSide === 'right') return enterSide === 'left' ? 'FS' : 'FF';
  return exitSide === 'left' && enterSide === 'left' ? 'SS' : 'SF';
}
