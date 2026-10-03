/**
 * 折点参数定标（ADR 0007 §5 / §11 第 3 项，S4-d 的后半）。
 *
 * ## 把"折点不跳变"落成可判定形式
 *
 * ADR 0007 §5 的原话是「`EDGE_STUB_PX`：固定像素常数（**不随 `pxPerDay` 缩放**，
 * 以免缩放时折点跳变、并让 G7 在给定 `pxPerDay` 下拿到同一几何）」。
 *
 * "折点在缩放时连续"本身**不可判别**（任何浮点实现都连续），所以本实验把它落成**两条可测的等价命题**：
 * ① 折点相对条边的偏移（stub 长度、回绕走廊宽度）在 `pxPerDay` 细扫 + 三档下**逐值等于声明的常量**；
 * ② 用**比例式 stub**（`stub ∝ pxPerDay`，一个看起来同样自然的错设计）做负向对照，
 * 它必须**被同一条判据检出**——否则判据没有判别力。
 *
 * 另有一条**规则固有的不连续性**被量化并记录（不是实现缺陷）：回绕判据
 * （`exitSide === 'left' && enterStubX < exitStubX`）会随 `pxPerDay` 变化而**翻转**，
 * 翻转点竖向段位置会跳变。G4/G5 若要消掉它，只能改 §5 的规则（另立 ADR）。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').Calendar} Calendar
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').Schedule} Schedule
 */

import { EDGE_STUB_PX, EDGE_WRAP_PX, ROUTE_SIDES, THRESHOLDS, VIEWPORT } from './manifest.mjs';
import { rowIndexOfOrder, visibleRowOrder } from './clip.mjs';
import { routeEdge, taskBounds } from './view-model.mjs';

/** 比例式对照的基准档位（在该档位上两种模式给出同一个 stub）。 */
export const STUB_REFERENCE_PX_PER_DAY = 28;

/**
 * stub / 回绕走廊的常数性扫描。
 *
 * @param {object} args
 * @param {ProjectDocument} args.document
 * @param {Schedule} args.schedule
 * @param {Calendar} args.calendar
 * @param {readonly number[]} args.linkIndices
 * @param {'fixed' | 'proportional'} args.mode
 * @param {readonly number[]} [args.sweep]
 */
export function stubConstancySweep({ document, schedule, calendar, linkIndices, mode, sweep }) {
  const pxPerDayValues = sweep ?? THRESHOLDS.foldSweepPxPerDay;
  const axisOriginDay = calendar.dayOfOrdinal(0); // 档位对齐固定在"日档"语义，只让 pxPerDay 变化
  const docIndexOfTask = new Map(document.tasks.map((task, index) => [task.id, index]));
  const rowOfDocIndex = rowIndexOfOrder(visibleRowOrder(document), document.tasks.length);

  /** @type {{ pxPerDay: number, maxStubDeviation: number, maxWrapDeviation: number, wrapCount: number, maxVerticalX: number }[]} */
  const series = [];
  /** @type {{ linkId: string, values: { pxPerDay: number, verticalX: number, wrapped: boolean, stubOut: number }[] }[]} */
  const samples = [];
  /** @type {string[]} */
  const flipped = [];

  for (const linkIndex of linkIndices) {
    const link = document.links[linkIndex];
    if (link === undefined) continue;
    samples.push({ linkId: link.id, values: [] });
  }

  let previousWrap = new Map();

  for (const pxPerDay of pxPerDayValues) {
    const stubPx = mode === 'fixed' ? EDGE_STUB_PX : EDGE_STUB_PX * (pxPerDay / STUB_REFERENCE_PX_PER_DAY);
    const wrapPx = mode === 'fixed' ? EDGE_WRAP_PX : EDGE_WRAP_PX * (pxPerDay / STUB_REFERENCE_PX_PER_DAY);
    let maxStubDeviation = 0;
    let maxWrapDeviation = 0;
    let wrapCount = 0;
    let maxVerticalX = 0;
    let sampleSlot = 0;
    /** @type {Map<string, boolean>} */
    const wrapNow = new Map();

    for (const linkIndex of linkIndices) {
      const link = document.links[linkIndex];
      const sample = samples[sampleSlot];
      sampleSlot += 1;
      if (link === undefined || sample === undefined) continue;
      const fromDoc = docIndexOfTask.get(link.from);
      const toDoc = docIndexOfTask.get(link.to);
      if (fromDoc === undefined || toDoc === undefined) continue;
      const fromBounds = boundsOf(fromDoc, pxPerDay);
      const toBounds = boundsOf(toDoc, pxPerDay);
      if (fromBounds === null || toBounds === null) continue;
      const sides = ROUTE_SIDES[link.type] ?? ROUTE_SIDES.FS;
      const exitX = sides.exit === 'right' ? fromBounds.xRight : fromBounds.xLeft;
      const enterX = sides.enter === 'right' ? toBounds.xRight : toBounds.xLeft;
      const route = routeEdge({
        exitSide: sides.exit,
        enterSide: sides.enter,
        exitX,
        enterX,
        yFrom: 0,
        yTo: 40,
        stubPx,
        wrapPx,
      });
      const stubOut = Math.abs(route.exitStubX - exitX);
      maxStubDeviation = Math.max(maxStubDeviation, Math.abs(stubOut - EDGE_STUB_PX));
      if (route.wrapped) {
        wrapCount += 1;
        maxWrapDeviation = Math.max(
          maxWrapDeviation,
          Math.abs(Math.min(route.exitStubX, route.enterStubX) - route.verticalX - EDGE_WRAP_PX),
        );
      }
      maxVerticalX = Math.max(maxVerticalX, Math.abs(route.verticalX));
      sample.values.push({ pxPerDay, verticalX: route.verticalX, wrapped: route.wrapped, stubOut });
      wrapNow.set(link.id, route.wrapped);
      if (previousWrap.has(link.id) && previousWrap.get(link.id) !== route.wrapped) {
        flipped.push(`${link.id}（${link.type}）@ pxPerDay=${String(pxPerDay)}`);
      }
    }
    previousWrap = wrapNow;
    series.push({ pxPerDay, maxStubDeviation, maxWrapDeviation, wrapCount, maxVerticalX });
  }

  return {
    mode,
    series,
    samples,
    wrapFlips: flipped,
    maxStubDeviation: series.reduce((acc, row) => Math.max(acc, row.maxStubDeviation), 0),
    maxWrapDeviation: series.reduce((acc, row) => Math.max(acc, row.maxWrapDeviation), 0),
    declaredStubPx: EDGE_STUB_PX,
    declaredWrapPx: EDGE_WRAP_PX,
  };

  /** @param {number} docIndex @param {number} pxPerDay */
  function boundsOf(docIndex, pxPerDay) {
    return taskBounds({
      document,
      schedule,
      calendar,
      rowOfDocIndex,
      axisOriginDay,
      pxPerDay,
      rowHeight: VIEWPORT.rowHeight,
      docIndex,
    });
  }
}

/**
 * 竖向段与条形矩形的水平间距（**发现型指标，不是 S4-d 的判据**）。
 *
 * v0.1 明确不做"同侧多线避让"（P-8 遗留 3），走线穿过条形是可接受的现状；
 * 这里量化"穿过比例"以便日后触发"另立 ADR"的取舍。
 *
 * @param {{ view: ReturnType<import('./view-model.mjs').buildView> }} args
 */
export function measureStubClearance({ view }) {
  let minClearance = Number.POSITIVE_INFINITY;
  let crossingEdges = 0;
  let closeEdges = 0;
  let measuredEdges = 0;
  for (const edge of view.edges) {
    const third = edge.points[2];
    const fourth = edge.points[3];
    if (third === undefined || fourth === undefined) continue;
    const yLow = Math.min(third[1], fourth[1]);
    const yHigh = Math.max(third[1], fourth[1]);
    let edgeMin = Number.POSITIVE_INFINITY;
    for (const row of view.rows) {
      const rowTop = row.y;
      const rowBottom = row.y + view.rowHeight;
      if (rowBottom < yLow || rowTop > yHigh) continue;
      const left = row.isMilestone && row.milestone !== null ? row.milestone.cx - row.milestone.size / 2 : row.xLeft;
      const right = row.isMilestone && row.milestone !== null ? row.milestone.cx + row.milestone.size / 2 : row.xRight;
      const gap =
        edge.verticalX < left
          ? left - edge.verticalX
          : edge.verticalX > right
            ? edge.verticalX - right
            : -Math.min(edge.verticalX - left, right - edge.verticalX);
      edgeMin = Math.min(edgeMin, gap);
    }
    if (!Number.isFinite(edgeMin)) continue;
    measuredEdges += 1;
    if (edgeMin < 0) crossingEdges += 1;
    else if (edgeMin < THRESHOLDS.minStubClearancePx) closeEdges += 1;
    minClearance = Math.min(minClearance, edgeMin);
  }
  return {
    measuredEdges,
    crossingEdges,
    closeEdges,
    minClearance: Number.isFinite(minClearance) ? minClearance : null,
    crossingRatio: measuredEdges === 0 ? 0 : crossingEdges / measuredEdges,
  };
}
