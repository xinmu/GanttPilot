/**
 * 4 类关系箭头的**可区分性度量**（ADR 0007 §5 的"两两不同"，S4-d 的前半）。
 *
 * 为什么不是目视（P-9 的方法论教训）："看起来不一样"不是判据。这里的判据是
 * **在真实渲染尺寸下把形态光栅化到 1 CSS px 网格，再算两两 Jaccard 距离**——
 * 距离越大越可区分；阈值在 `manifest.mjs` 的 `THRESHOLDS.arrowMinJaccard`。
 *
 * 形态由两件事决定（两者都不是"随手画的"）：
 * - **填充**：`ARROW_FILL`（FS/FF 实心、SS/SF 空心）；
 * - **朝向**：由 P-8 第 1 条的**入边侧**决定（左入 ⇒ 朝 +x，右入 ⇒ 朝 −x）。
 *
 * @typedef {import('./manifest.mjs').LinkType} LinkType
 */

import { ARROW_FILL, ARROW_RASTER, ROUTE_SIDES, SPACING, THRESHOLDS, VIEWPORT } from './manifest.mjs';

/**
 * 实际渲染尺寸（与 `browser/probe.mjs` 用同一组常量，保证"同尺"）。
 *
 * 半宽由**长度**按比例推出（`length × arrowHalfWidthRatio`），不是由行高直接推——
 * 否则"长 12 px 半宽 14.4 px"会得到一个比行还高的箭头（本探针第一版就是这样，已订正）。
 */
export const ARROW_METRICS = (() => {
  const length = VIEWPORT.rowHeight * SPACING.arrowLengthRatio;
  return {
    length,
    halfWidth: length * SPACING.arrowHalfWidthRatio,
    hollowRatio: SPACING.hollowInnerRatio,
  };
})();

/**
 * 箭头三角形（局部坐标：**尖端在原点**，`dir = +1` 指向 +x）。
 * @param {{ dir: number, length?: number, halfWidth?: number }} args
 * @returns {[[number, number], [number, number], [number, number]]}
 */
export function arrowVertices({ dir, length = ARROW_METRICS.length, halfWidth = ARROW_METRICS.halfWidth }) {
  const sign = dir >= 0 ? 1 : -1;
  return [
    [0, 0],
    [-sign * length, halfWidth],
    [-sign * length, -halfWidth],
  ];
}

/**
 * 箭头的内外三角形（空心 = 外三角减去按重心缩放的内心三角）。
 * @param {{ dir: number, fill: string, length?: number, halfWidth?: number }} form
 */
export function arrowPolygons(form) {
  const outer = arrowVertices({ dir: form.dir, length: form.length, halfWidth: form.halfWidth });
  if (form.fill !== 'hollow') return { outer, inner: null };
  const centroid = /** @type {[number, number]} */ ([
    (outer[0][0] + outer[1][0] + outer[2][0]) / 3,
    (outer[0][1] + outer[1][1] + outer[2][1]) / 3,
  ]);
  const scale = 1 - ARROW_METRICS.hollowRatio;
  const inner = outer.map(
    (point) =>
      /** @type {[number, number]} */ ([
        centroid[0] + (point[0] - centroid[0]) * scale,
        centroid[1] + (point[1] - centroid[1]) * scale,
      ]),
  );
  return { outer, inner };
}

/**
 * 点是否在三角形内（边界算"在内"，保证确定性：同一份输入在两侧运行时得到同一集合）。
 * @param {[number, number]} p
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {[number, number]} c
 */
export function pointInTriangle(p, a, b, c) {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {[number, number]} p
 */
function cross(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/**
 * 光栅化一个箭头形态为 1 CSS px 采样格集合（`"i,j"`）；采样点在像素中心。
 * @param {{ dir: number, fill: string }} form
 * @param {{ length?: number, halfWidth?: number, padding?: number }} [options]
 */
export function rasterizeArrow(form, options = {}) {
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
  /** @type {Set<string>} */
  const cells = new Set();
  const [a, b, c] = polygons.outer;
  const inner = polygons.inner;
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const point = /** @type {[number, number]} */ ([x + 0.5, y + 0.5]);
      if (!pointInTriangle(point, a, b, c)) continue;
      if (inner !== null && pointInTriangle(point, inner[0], inner[1], inner[2])) continue;
      cells.add(`${String(x)},${String(y)}`);
    }
  }
  return { cells, bbox: { minX, maxX, minY, maxY } };
}

/**
 * Jaccard 距离 = `1 − |A ∩ B| / |A ∪ B|`（0 = 完全一致，1 = 完全不相交）。
 * @param {ReadonlySet<string>} setA
 * @param {ReadonlySet<string>} setB
 */
export function jaccardDistance(setA, setB) {
  let intersection = 0;
  for (const cell of setA) if (setB.has(cell)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}

/** 4 类关系的形态 = 填充（manifest）× 朝向（P-8 的入边侧）。 */
export function formsForRelations() {
  /** @type {Record<string, { dir: number, fill: string }>} */
  const forms = {};
  for (const relation of /** @type {const} */ (['FS', 'SS', 'FF', 'SF'])) {
    const sides = ROUTE_SIDES[relation] ?? ROUTE_SIDES.FS;
    // 箭头朝条内：左入 ⇒ +x，右入 ⇒ −x（与 `view-model.routeEdge` 的 `arrowDir` 同口径）。
    const dir = sides.enter === 'left' ? 1 : -1;
    forms[relation] = { dir, fill: ARROW_FILL[relation] ?? 'solid' };
  }
  return forms;
}

/**
 * S4-d 的判据本体：4×4 Jaccard 距离矩阵 + 最小值 + 判定。
 * @param {{ arrowMinJaccard?: number }} [options]
 */
export function arrowDistinguishability(options = {}) {
  const threshold = options.arrowMinJaccard ?? THRESHOLDS.arrowMinJaccard;
  const forms = formsForRelations();
  const keys = /** @type {const} */ (['FS', 'SS', 'FF', 'SF']);
  /** @type {Record<string, ReturnType<typeof rasterizeArrow>>} */
  const rasterized = {};
  for (const key of keys) rasterized[key] = rasterizeArrow(forms[key]);
  /** @type {{ pair: string, distance: number }[]} */
  const pairs = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const left = keys[i];
      const right = keys[j];
      if (left === undefined || right === undefined) continue;
      pairs.push({
        pair: `${left}|${right}`,
        distance: jaccardDistance(rasterized[left].cells, rasterized[right].cells),
      });
    }
  }
  const min = pairs.reduce((acc, item) => Math.min(acc, item.distance), Number.POSITIVE_INFINITY);
  return {
    forms,
    cellCounts: Object.fromEntries(keys.map((key) => [key, rasterized[key].cells.size])),
    pairs,
    minDistance: min,
    threshold,
    pass: min >= threshold,
    metrics: ARROW_METRICS,
  };
}
