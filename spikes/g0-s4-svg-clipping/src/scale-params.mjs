/**
 * 刻度/行高/缓冲/gutter 的**定标判据**（回填 ADR 0007 §11 第 1、2 项）。
 *
 * 纪律：常量不是"选的"，而是"判据推出来的"。本模块把每条判据写成可求值的式子，
 * 并给出**每个候选的通过情况**——这样"为什么是 24/8/3"在证据里是可复核的，
 * 而改变其中一个常量必然会在报告里留下 diff。
 *
 * @typedef {import('./manifest.mjs').ZoomKey} ZoomKey
 */

import {
  AXIS_LEFT_GUTTER_DAYS,
  EDGE_STUB_PX,
  EDGE_WRAP_PX,
  LABEL_CHAR_PX,
  LABEL_PADDING_PX,
  MIN_VISIBLE_ROWS,
  ROW_BUFFER_CANDIDATES,
  ROW_HEIGHT_CANDIDATES,
  SPACING,
  THRESHOLDS,
  VIEWPORT,
  WHEEL_NOTCH_PX,
  ZOOM_CANDIDATES,
  ZOOM_LABEL_FORMAT,
  ZOOM_ORDER,
  ZOOM_SELECTED,
  ZOOM_UNIT_DAYS,
  zoomPxPerDay,
} from './manifest.mjs';

/** 判据①：日档下 1 工作日的条宽下限（条宽 = `pxPerDay`）。 */
function barWidthOk(zoom, pxPerDay) {
  if (zoom !== 'day') return true; // 周/月档的条宽由"每档至少一天"保证，主判据在日档
  return pxPerDay >= THRESHOLDS.minBarWidthPx;
}

/** 判据②：刻度间距 ≥ 标签宽度估算 + 2 px。 */
function labelCriteria(zoom, pxPerDay) {
  const spacingPx = pxPerDay * (ZOOM_UNIT_DAYS[zoom] ?? 1);
  const chars = ZOOM_LABEL_FORMAT[zoom]?.chars ?? 2;
  const labelWidthPx = chars * LABEL_CHAR_PX + LABEL_PADDING_PX;
  return { spacingPx, labelWidthPx, ok: spacingPx >= labelWidthPx + 2 };
}

/** 判据③：最窄档位下回绕走廊仍能落在 gutter 内。 */
function corridorCriteria(pxPerDay) {
  const neededPx = EDGE_STUB_PX + EDGE_WRAP_PX;
  const availablePx = pxPerDay * AXIS_LEFT_GUTTER_DAYS;
  return { neededPx, availablePx, ok: availablePx >= neededPx };
}

/** 逐档位 × 逐候选求值（选取规则：**取通过全部判据的最小候选**）。 */
export function evaluateZoomCandidates() {
  /** @type {Record<string, { candidates: { pxPerDay: number, pass: boolean, barWidthPx: number, barOk: boolean, spacingPx: number, labelWidthPx: number, ok: boolean, neededPx: number, availablePx: number }[], selected: number }>} */
  const result = {};
  for (const zoom of ZOOM_ORDER) {
    const candidates = ZOOM_CANDIDATES[zoom] ?? [];
    const rows = candidates.map((pxPerDay) => {
      const label = labelCriteria(zoom, pxPerDay);
      const corridor = corridorCriteria(pxPerDay);
      const bar = barWidthOk(zoom, pxPerDay);
      const pass = bar && label.ok && corridor.ok;
      return {
        pxPerDay,
        barWidthPx: pxPerDay,
        barOk: bar,
        ...label,
        ...corridor,
        pass,
      };
    });
    result[zoom] = { candidates: rows, selected: zoomPxPerDay(zoom) };
  }
  return result;
}

/** 行高：**取通过全部判据的最大候选**（越大越易读，受"视口至少 N 行"约束）。 */
export function evaluateRowHeightCandidates() {
  const rows = ROW_HEIGHT_CANDIDATES.map((rowHeight) => {
    const barHeightPx = rowHeight * SPACING.barHeightRatio;
    const diamondPx = rowHeight * SPACING.milestoneSizeRatio;
    const barOk = barHeightPx >= 12;
    const diamondOk = diamondPx >= 10;
    const multipleOfFour = rowHeight % 4 === 0;
    const visibleRows = Math.floor(VIEWPORT.height / rowHeight);
    const rowsOk = visibleRows >= MIN_VISIBLE_ROWS;
    return {
      rowHeight,
      barHeightPx,
      diamondPx,
      barOk,
      diamondOk,
      multipleOfFour,
      visibleRows,
      rowsOk,
      pass: barOk && diamondOk && multipleOfFour && rowsOk,
    };
  });
  const passing = rows.filter((row) => row.pass);
  return {
    rows,
    selected: passing.length > 0 ? Math.max(...passing.map((row) => row.rowHeight)) : null,
    declared: VIEWPORT.rowHeight,
  };
}

/** 缓冲行：**取通过判据的最小候选**（解析判据 = 一次滚轮档位跨过的行数）。 */
export function evaluateRowBufferCandidates() {
  const required = Math.ceil(WHEEL_NOTCH_PX / VIEWPORT.rowHeight);
  const rows = ROW_BUFFER_CANDIDATES.map((rowBuffer) => ({
    rowBuffer,
    coveredPx: rowBuffer * VIEWPORT.rowHeight,
    pass: rowBuffer >= required,
  }));
  const passing = rows.filter((row) => row.pass);
  return {
    rows,
    requiredRows: required,
    selected: passing.length > 0 ? Math.min(...passing.map((row) => row.rowBuffer)) : null,
    declared: VIEWPORT.rowBuffer,
  };
}

/** gutter：由回绕走廊反推（**天数**），并给出各档位的实际像素余量。 */
export function deriveGutterDays() {
  const neededPx = EDGE_STUB_PX + EDGE_WRAP_PX;
  const minPxPerDay = Math.min(...ZOOM_ORDER.map((zoom) => zoomPxPerDay(zoom)));
  const derived = Math.ceil((neededPx + 4) / minPxPerDay);
  return {
    neededPx,
    minPxPerDay,
    derived,
    declared: AXIS_LEFT_GUTTER_DAYS,
    // 代价：gutter 以"天数"表达 ⇒ 日档下的像素空白 = 天数 × pxPerDay。
    perZoomPx: Object.fromEntries(ZOOM_ORDER.map((zoom) => [zoom, AXIS_LEFT_GUTTER_DAYS * zoomPxPerDay(zoom)])),
    viewportWidth: VIEWPORT.width,
  };
}

/** 一次性汇总（报告与断言共用）。 */
export function scaleParams() {
  const zoom = evaluateZoomCandidates();
  const rowHeight = evaluateRowHeightCandidates();
  const rowBuffer = evaluateRowBufferCandidates();
  const gutter = deriveGutterDays();
  const consistent =
    ZOOM_ORDER.every((key) => zoom[key].candidates.some((row) => row.pxPerDay === zoom[key].selected && row.pass)) &&
    rowHeight.selected === rowHeight.declared &&
    rowBuffer.selected === rowBuffer.declared &&
    gutter.derived === gutter.declared;
  return { zoom, rowHeight, rowBuffer, gutter, consistent, selected: ZOOM_SELECTED };
}
