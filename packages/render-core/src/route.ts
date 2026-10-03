/**
 * 依赖线的**路由几何**：出/入边策略、正交折点、4 类箭头形态（ADR 0007 §5）。
 *
 * ## 两处口径（不要在这里重述成第二处真相源）
 *
 * 1. **出/入边策略的唯一登记处是[裁决 P-8](../../../docs/00-baseline/裁决记录.md) 第 1 条**
 *    （FS 右出→左入、SS 左出→左入、FF 右出→右入、SF 左出→右入；左右连接点 = 该边中点）。
 *    本文件的 {@link ROUTE_SIDES} 只是它的**可执行副本**——改它之前先改裁决。
 * 2. **同侧多线分道/避让 v0.1 不做**（P-8 遗留 3）。G4-S 已量化触发依据
 *    （70.7% 的边其竖向段穿过条形，最小间距 −264 px）：出现真实取舍时**另立 ADR**，
 *    不要在这里顺手实现。
 *
 * 本模块是**纯函数、零 DOM**：只出数字与枚举。
 */

import type { LinkType } from '@ganttpilot/engine';

import {
  ARROW_FILL,
  ARROW_RASTER,
  EDGE_STUB_PX,
  EDGE_WRAP_PX,
  ROW_HEIGHT,
  SPACING,
  THRESHOLDS,
} from './manifest.js';

/** 连接点的左右侧。 */
export type RouteSide = 'left' | 'right';

/** 一条边的正交折线点（内容坐标）。 */
export type Point = readonly [x: number, y: number];

/**
 * P-8 第 1 条的可执行副本（**唯一登记处仍是 P-8**）。
 *
 * `exit` / `enter` 取 `'left' | 'right'`；箭头方向 = "线从哪侧进入"的反向
 * （左入 ⇒ 箭头朝 +x、右入 ⇒ 朝 −x）。
 */
export const ROUTE_SIDES: Readonly<Record<string, { readonly exit: RouteSide; readonly enter: RouteSide }>> = {
  FS: { exit: 'right', enter: 'left' },
  SS: { exit: 'left', enter: 'left' },
  FF: { exit: 'right', enter: 'right' },
  SF: { exit: 'left', enter: 'right' },
};

/** 取某类关系的出入边（未知类型退化为 FS，与 G4-S 同口径）。 */
export function routeSides(type: LinkType | string): { readonly exit: RouteSide; readonly enter: RouteSide } {
  return ROUTE_SIDES[type] ?? { exit: 'right', enter: 'left' };
}

/** 正交路由的产出。 */
export interface RouteGeometry {
  /** 去重后的折线点列（首点 = 出端、末点 = 入端）。 */
  readonly points: readonly Point[];
  /** 竖直段的 x。 */
  readonly verticalX: number;
  /** 是否走了回绕（左出且目标 stub 在出端 stub 左侧）。 */
  readonly wrapped: boolean;
  /** 出端 stub 末点的 x。 */
  readonly exitStubX: number;
  /** 入端 stub 起点的 x。 */
  readonly enterStubX: number;
  /** 箭头朝向（+1 = +x）。 */
  readonly arrowDir: 1 | -1;
}

/**
 * 正交路由（ADR 0007 §5）：`出端水平 stub → 竖直段 → 入端水平 stub`，折点全部正交。
 *
 * 竖直段 x 的规则（§5 原文）：
 * - 常规情形 = 两端 stub 末点的**中点**；
 * - **需要回绕**（左出且目标 stub 在出端 stub 左侧 —— 即 SS/SF 且目标在前置左侧）
 *   取 `min(两端 x) − EDGE_WRAP_PX`，落在 §3 的左侧 gutter 内。
 *
 * 共线/重合点会被去掉（同 x 同 y 的连续点），因此 `points` 长度在 4–6 之间。
 */
export function routeEdge(args: {
  readonly exitSide: RouteSide;
  readonly enterSide: RouteSide;
  readonly exitX: number;
  readonly enterX: number;
  readonly yFrom: number;
  readonly yTo: number;
  readonly stubPx?: number;
  readonly wrapPx?: number;
}): RouteGeometry {
  const stubPx = args.stubPx ?? EDGE_STUB_PX;
  const wrapPx = args.wrapPx ?? EDGE_WRAP_PX;
  const exitDir = args.exitSide === 'right' ? 1 : -1;
  const enterDir = args.enterSide === 'right' ? 1 : -1;
  const exitStubX = args.exitX + exitDir * stubPx;
  const enterStubX = args.enterX + enterDir * stubPx;
  const wrapped = args.exitSide === 'left' && enterStubX < exitStubX;
  const verticalX = wrapped ? Math.min(exitStubX, enterStubX) - wrapPx : (exitStubX + enterStubX) / 2;

  const raw: Point[] = [
    [args.exitX, args.yFrom],
    [exitStubX, args.yFrom],
    [verticalX, args.yFrom],
    [verticalX, args.yTo],
    [enterStubX, args.yTo],
    [args.enterX, args.yTo],
  ];
  const points: Point[] = [];
  for (const point of raw) {
    const last = points[points.length - 1];
    if (last !== undefined && last[0] === point[0] && last[1] === point[1]) continue;
    points.push(point);
  }

  return {
    points,
    verticalX,
    wrapped,
    exitStubX,
    enterStubX,
    // 箭头朝"条内"：从左侧进入 ⇒ 朝 +x；从右侧进入 ⇒ 朝 −x。
    arrowDir: args.enterSide === 'left' ? 1 : -1,
  };
}

// ---------------------------------------------------------------- 箭头几何

/** 箭头的真实渲染尺寸（与 ADR 0007 §11 第 3 项的 12 × 7.2 px 对齐；行高 24 时成立）。 */
export const ARROW_METRICS = {
  length: ROW_HEIGHT * SPACING.arrowLengthRatio,
  halfWidth: ROW_HEIGHT * SPACING.arrowLengthRatio * SPACING.arrowHalfWidthRatio,
  hollowRatio: SPACING.hollowInnerRatio,
} as const;

/** 箭头三角形的局部坐标（**尖端在原点**，`dir = +1` 指向 +x）。 */
export function arrowVertices(args: {
  readonly dir: number;
  readonly length?: number | undefined;
  readonly halfWidth?: number | undefined;
}): readonly [Point, Point, Point] {
  const sign = args.dir >= 0 ? 1 : -1;
  const length = args.length ?? ARROW_METRICS.length;
  const halfWidth = args.halfWidth ?? ARROW_METRICS.halfWidth;
  return [
    [0, 0],
    [-sign * length, halfWidth],
    [-sign * length, -halfWidth],
  ];
}

/**
 * 箭头的内外三角形（空心 = 外三角减去按重心缩放的内心三角）。
 *
 * 空心形态**需要一个内三角**：渲染层用"外三角填充白 + 描边"或"两三角 path"实现都可，
 * 但几何必须由这里给，否则 `apps/web` 与 G7 会各自算一份。
 */
export function arrowPolygons(form: {
  readonly dir: number;
  readonly fill: string;
  readonly length?: number | undefined;
  readonly halfWidth?: number | undefined;
}): { readonly outer: readonly [Point, Point, Point]; readonly inner: readonly [Point, Point, Point] | null } {
  const outer = arrowVertices({ dir: form.dir, length: form.length, halfWidth: form.halfWidth });
  if (form.fill !== 'hollow') return { outer, inner: null };
  const centroid: Point = [
    (outer[0][0] + outer[1][0] + outer[2][0]) / 3,
    (outer[0][1] + outer[1][1] + outer[2][1]) / 3,
  ];
  const scale = 1 - ARROW_METRICS.hollowRatio;
  const inner = outer.map(
    (point): Point => [
      centroid[0] + (point[0] - centroid[0]) * scale,
      centroid[1] + (point[1] - centroid[1]) * scale,
    ],
  );
  return { outer, inner: [inner[0] ?? outer[0], inner[1] ?? outer[1], inner[2] ?? outer[2]] };
}

/** 点是否在三角形内（边界算"在内"，保证确定性）。 */
export function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function cross(a: Point, b: Point, p: Point): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** 把箭头形态光栅化到 1 CSS px 采样格（`"i,j"`；采样点在像素中心）。 */
export function rasterizeArrow(
  form: { readonly dir: number; readonly fill: string },
  options: {
    readonly length?: number | undefined;
    readonly halfWidth?: number | undefined;
    readonly padding?: number | undefined;
  } = {},
): { readonly cells: ReadonlySet<string>; readonly bbox: { minX: number; maxX: number; minY: number; maxY: number } } {
  const length = options.length ?? ARROW_METRICS.length;
  const halfWidth = options.halfWidth ?? ARROW_METRICS.halfWidth;
  const padding = options.padding ?? ARROW_RASTER.paddingPx;
  const polygons = arrowPolygons({ dir: form.dir, fill: form.fill, length, halfWidth });
  const xs = polygons.outer.map((point) => point[0]);
  const ys = polygons.outer.map((point) => point[1]);
  const minX = Math.floor(Math.min(...xs) - padding);
  const maxX = Math.ceil(Math.max(...xs) + padding);
  const minY = Math.floor(Math.min(...ys) - padding);
  const maxY = Math.ceil(Math.max(...ys) + padding);
  const cells = new Set<string>();
  const [a, b, c] = polygons.outer;
  const inner = polygons.inner;
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const point: Point = [x + 0.5, y + 0.5];
      if (!pointInTriangle(point, a, b, c)) continue;
      if (inner !== null && pointInTriangle(point, inner[0], inner[1], inner[2])) continue;
      cells.add(`${String(x)},${String(y)}`);
    }
  }
  return { cells, bbox: { minX, maxX, minY, maxY } };
}

/** Jaccard 距离 = `1 − |A ∩ B| / |A ∪ B|`（0 = 完全一致，1 = 完全不相交）。 */
export function jaccardDistance(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  let intersection = 0;
  for (const cell of setA) if (setB.has(cell)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}

/** 4 类关系的箭头形态 = 填充（{@link ARROW_FILL}）× 朝向（P-8 的入边侧）。 */
export function arrowFormsForRelations(): Readonly<Record<string, { readonly dir: number; readonly fill: string }>> {
  const forms: Record<string, { dir: number; fill: string }> = {};
  for (const relation of ['FS', 'SS', 'FF', 'SF'] as const) {
    const sides = routeSides(relation);
    // 箭头朝条内：左入 ⇒ +x，右入 ⇒ −x（与 routeEdge 的 arrowDir 同口径）。
    const dir = sides.enter === 'left' ? 1 : -1;
    forms[relation] = { dir, fill: ARROW_FILL[relation] ?? 'solid' };
  }
  return forms;
}

/** 「4 类箭头两两可区分」的判据本体（同尺量化，**不得目视**，P-9 方法论）。 */
export function arrowDistinguishability(options: { readonly arrowMinJaccard?: number } = {}): {
  readonly forms: Readonly<Record<string, { readonly dir: number; readonly fill: string }>>;
  readonly cellCounts: Readonly<Record<string, number>>;
  readonly pairs: readonly { readonly pair: string; readonly distance: number }[];
  readonly minDistance: number;
  readonly threshold: number;
  readonly pass: boolean;
  readonly metrics: typeof ARROW_METRICS;
} {
  const threshold = options.arrowMinJaccard ?? THRESHOLDS.arrowMinJaccard;
  const forms = arrowFormsForRelations();
  const keys = ['FS', 'SS', 'FF', 'SF'] as const;
  const rasterized: Record<string, ReturnType<typeof rasterizeArrow>> = {};
  const cellCounts: Record<string, number> = {};
  for (const key of keys) {
    rasterized[key] = rasterizeArrow(forms[key] ?? { dir: 1, fill: 'solid' });
    cellCounts[key] = rasterized[key].cells.size;
  }
  const pairs: { pair: string; distance: number }[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const left = keys[i];
      const right = keys[j];
      if (left === undefined || right === undefined) continue;
      pairs.push({
        pair: `${left}|${right}`,
        distance: jaccardDistance(rasterized[left]?.cells ?? new Set(), rasterized[right]?.cells ?? new Set()),
      });
    }
  }
  const min = pairs.reduce((acc, item) => Math.min(acc, item.distance), Number.POSITIVE_INFINITY);
  return {
    forms,
    cellCounts,
    pairs,
    minDistance: min,
    threshold,
    pass: min >= threshold,
    metrics: ARROW_METRICS,
  };
}
