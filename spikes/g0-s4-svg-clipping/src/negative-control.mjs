/**
 * 负向对照（ADR 0007 §6.8 的两条 + 一条正确性对照）。
 *
 * 没有这些对照，"元素数与文档总规模无关""求交裁剪有效"都可能是**恒真式**——
 * 所以它们和判据本身同等重要（P-9 的方法论教训：判据必须有判别力）。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').Calendar} Calendar
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').Schedule} Schedule
 */

import { THRESHOLDS } from './manifest.mjs';
import { buildView } from './view-model.mjs';
import { countElements } from './count.mjs';
import { checkManualCases } from './invariants.mjs';

/**
 * NC1：**求交裁剪**（路径 A）与**端点可见性裁剪**（路径 B）的差集必须是"被误裁的跨屏长边"。
 *
 * @param {object} args
 * @param {ProjectDocument} args.document
 * @param {Schedule} args.schedule
 * @param {Calendar} args.calendar
 * @param {readonly number[]} args.scrollRowOffsets
 * @param {{ width: number, height: number, rowHeight: number, rowBuffer: number }} args.viewport
 */
export function negativeControlEndpointClipping({ document, schedule, calendar, scrollRowOffsets, viewport }) {
  /** @type {{ offset: number, intersectEdges: number, endpointEdges: number, lost: number, lostSpanning: number }[]} */
  const positions = [];
  for (const offset of scrollRowOffsets) {
    const scrollTop = offset * viewport.rowHeight;
    const base = { document, schedule, calendar, viewport: { ...viewport, scrollTop }, zoom: 'day' };
    const intersectView = buildView({ ...base, clipMode: 'intersect' });
    const endpointView = buildView({ ...base, clipMode: 'endpoints' });
    const intersectIds = new Set(intersectView.edges.map((edge) => edge.linkId));
    const endpointIds = new Set(endpointView.edges.map((edge) => edge.linkId));
    const lost = [...intersectIds].filter((id) => !endpointIds.has(id));
    const spanningIds = new Set(
      intersectView.spanningEdges
        .map((index) => document.links[index]?.id)
        .filter((id) => id !== undefined),
    );
    positions.push({
      offset,
      intersectEdges: intersectIds.size,
      endpointEdges: endpointIds.size,
      lost: lost.length,
      lostSpanning: lost.filter((id) => spanningIds.has(id)).length,
    });
  }
  const totalLost = positions.reduce((acc, row) => acc + row.lost, 0);
  const everyPositionLoses = positions.every(
    (row) => row.lost >= THRESHOLDS.minCrossScreenLossPerPosition,
  );
  return {
    positions,
    totalLost,
    everyPositionLoses,
    pass: everyPositionLoses && totalLost >= THRESHOLDS.totalCrossScreenLoss,
    thresholds: {
      minPerPosition: THRESHOLDS.minCrossScreenLossPerPosition,
      total: THRESHOLDS.totalCrossScreenLoss,
    },
  };
}

/**
 * NC2：**关掉窗口裁剪**后，元素数必须随文档总规模增长（否则"与规模无关"是恒真式）。
 *
 * @param {object} args
 * @param {readonly { size: number, document: ProjectDocument, schedule: Schedule }[]} args.fixtures
 * @param {Calendar} args.calendar
 * @param {{ width: number, height: number, rowHeight: number, rowBuffer: number }} args.viewport
 */
export function negativeControlNoWindowClipping({ fixtures, calendar, viewport }) {
  /** @type {{ size: number, total: number, rows: number, edges: number }[]} */
  const rows = [];
  let minTotal = Number.POSITIVE_INFINITY;
  let maxTotal = 0;
  for (const fixture of fixtures) {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar,
      viewport: { ...viewport, scrollTop: 0, rowBuffer: fixture.document.tasks.length },
      zoom: 'day',
      clipMode: 'none',
    });
    const counts = countElements(view);
    rows.push({ size: fixture.size, total: counts.total, rows: counts.renderedRows, edges: counts.renderedEdges });
    minTotal = Math.min(minTotal, counts.total);
    maxTotal = Math.max(maxTotal, counts.total);
  }
  const ratio = minTotal === 0 ? Number.POSITIVE_INFINITY : maxTotal / minTotal;
  return {
    rows,
    ratio,
    threshold: THRESHOLDS.nc2GrowthRatio,
    pass: ratio > THRESHOLDS.nc2GrowthRatio,
  };
}

/**
 * NC3：**故意错的几何**必须被声明式期望值表检出（三条：右边界规则、出/入边、箭头朝向）。
 *
 * @param {{ calendar: Calendar }} args
 */
export function negativeControlWrongGeometry({ calendar }) {
  const mutations = [
    { key: '右边界用 dayOfOrdinal(ef)（ADR 0007 §3 点名的错法）', options: { mutateRightBoundary: true } },
    { key: '交换出/入边（P-8 第 1 条的错法）', options: { mutateRouteSides: true } },
    { key: '箭头朝向取反', options: { mutateArrowDir: true } },
  ];
  /** @type {{ key: string, detected: number, checked: number }[]} */
  const results = [];
  for (const mutation of mutations) {
    const checked = checkManualCases({ calendar, ...mutation.options });
    const detected = checked.filter((result) => !result.pass).length;
    results.push({ key: mutation.key, detected, checked: checked.length });
  }
  return {
    results,
    pass: results.every((row) => row.detected > 0),
  };
}
