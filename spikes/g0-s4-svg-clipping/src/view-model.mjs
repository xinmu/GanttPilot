/**
 * 几何真相源（ADR 0007 §2–§5 的可执行形式）。**纯函数、零 DOM、零 SVG 字符串**：
 * 只出数字与枚举，`apps/web` 与 G7 的导出投影都只消费它（铁律 #2）。
 *
 * 本模块是**探针**，不是 `packages/render-core` 的终稿：函数名与返回形状刻意沿用
 * ADR 0007 §2 的签名（`buildView` / `visibleRows` / `visibleEdges` / `dayAtX`），
 * 以便 G4 落地时能对照迁移；**迁移不在本 spike 范围内**。
 *
 * 一处必要的签名偏离：ADR 0007 §2 写的是 `ordinalAtX(view, x)`，而"序号"只有 `Calendar` 能算。
 * 为了让 `ViewModel` 保持"只有数字与枚举"（§2 的硬要求），这里把日历作为**显式入参**：
 * `ordinalAtX(view, x, calendar)`。语义与 §3 的分工不变（G4 出吸附候选、G5 决定何时吸附）。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').Calendar} Calendar
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').Schedule} Schedule
 * @typedef {import('./manifest.mjs').ZoomKey} ZoomKey
 * @typedef {import('./manifest.mjs').ClipMode} ClipMode
 * @typedef {'left' | 'right'} Side
 *
 * @typedef {object} RowBox
 * @property {number} row 可见行序号
 * @property {number} docIndex 文档序索引（`Schedule` 的索引约定）
 * @property {string} id 任务 id
 * @property {'leaf' | 'summary'} kind
 * @property {boolean} isMilestone
 * @property {number} es
 * @property {number} ef
 * @property {number} y 行顶（内容坐标）
 * @property {number} barY 条顶（内容坐标）
 * @property {number} barHeight
 * @property {number} xLeft
 * @property {number} xRight
 * @property {boolean} hasProgress
 * @property {number} progressRatio
 * @property {number} progressWidth
 * @property {{ cx: number, cy: number, size: number } | null} milestone
 * @property {string} styleKey
 *
 * @typedef {object} EdgeGeom
 * @property {number} linkIndex `document.links` 的下标
 * @property {string} linkId
 * @property {string} type
 * @property {boolean} ignored 端点含汇总任务 ⇒ 传播忽略它（ADR 0007 §6.4），但**照画**
 * @property {number} fromRow
 * @property {number} toRow
 * @property {number} fromDoc
 * @property {number} toDoc
 * @property {[number, number][]} points 正交折线点列
 * @property {number} verticalX 竖直段 x
 * @property {boolean} wrapped
 * @property {number} exitStubX
 * @property {number} enterStubX
 * @property {number} arrowDir 箭头朝向（+1 = +x）
 * @property {string} styleKey
 *
 * @typedef {{ kind: 'band', x: number, width: number } | { kind: 'gridline', x: number } | { kind: 'label', x: number, text: string }} AxisElement
 *
 * @typedef {object} ViewModel
 * @property {ZoomKey} zoom
 * @property {ClipMode} clipMode
 * @property {number} pxPerDay
 * @property {number} rowHeight
 * @property {number} axisOriginDay
 * @property {number} scrollTop
 * @property {number} scrollLeft
 * @property {number} width
 * @property {number} height
 * @property {number} rowCount
 * @property {number} firstVisible
 * @property {number} visibleLast
 * @property {number} renderFirst
 * @property {number} renderLast
 * @property {readonly number[]} order
 * @property {RowBox[]} rows
 * @property {EdgeGeom[]} edges
 * @property {AxisElement[]} axis
 * @property {readonly number[]} spanningEdges 「跨屏长边」的 `links` 下标
 * @property {readonly number[]} hiddenEdges 因折叠隐藏端点而不画的边
 * @property {number} unroutableEdges 端点不可解析的边数（应为 0）
 */

import { weekdayOf } from '../../../packages/engine/dist/index.js';
import { rowIndexOfOrder, rowWindow, selectEdges, visibleRowOrder } from './clip.mjs';
import { AXIS_LEFT_GUTTER_DAYS, EDGE_STUB_PX, EDGE_WRAP_PX, ROUTE_SIDES, SPACING, zoomPxPerDay } from './manifest.mjs';

/** 视口：唯一的滚动/尺寸真相源（ADR 0007 §2 的 `Viewport` + 滚动位置）。 */
export const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 640,
  rowHeight: 24,
  rowBuffer: 5,
  scrollTop: 0,
  scrollLeft: 0,
};

/**
 * 轴线起点（ADR 0007 §3）：`dayOfOrdinal(projectStart)` 按档位**向前取整到该档位起点**，
 * 再向左留 `AXIS_LEFT_GUTTER_DAYS`（**左边距不是装饰**：SS/SF 的左出回绕走线需要它）。
 *
 * @param {Calendar} calendar
 * @param {number} projectStartOrdinal
 * @param {ZoomKey} zoom
 */
export function axisOriginDayFor(calendar, projectStartOrdinal, zoom) {
  const startDay = calendar.dayOfOrdinal(projectStartOrdinal);
  let aligned = startDay;
  if (zoom === 'week') {
    aligned = startDay - ((weekdayOf(startDay) + 6) % 7); // 周一（0=周日…6=周六）
  } else if (zoom === 'month') {
    aligned = calendar.dayOfIso(`${calendar.isoOfDay(startDay).slice(0, 8)}01`);
  }
  return aligned - AXIS_LEFT_GUTTER_DAYS;
}

/**
 * 条形的 x 区间（ADR 0007 §3 的**映射公式**）。`-1` 是哨兵，**绝不可喂进来**。
 *
 * @param {object} args
 * @param {Calendar} args.calendar
 * @param {number} args.es
 * @param {number} args.ef
 * @param {number} args.axisOriginDay
 * @param {number} args.pxPerDay
 */
export function barXRange({ calendar, es, ef, axisOriginDay, pxPerDay }) {
  if (!Number.isInteger(es) || !Number.isInteger(ef) || es < 0 || ef < 0) {
    throw new RangeError(`条形的序号非法：es=${String(es)} ef=${String(ef)}（-1 是哨兵，不可用于几何）`);
  }
  if (ef < es) throw new RangeError(`条形的序号区间非法：es=${String(es)} > ef=${String(ef)}`);
  const leftDay = calendar.dayOfOrdinal(es);
  // 右边界必须用 ef − 1 再 +1：直接用 dayOfOrdinal(ef) 会让跨周末的条多出整段空隙（ADR 0007 §3）。
  const rightDay = calendar.dayOfOrdinal(ef - 1) + 1;
  return {
    xLeft: (leftDay - axisOriginDay) * pxPerDay,
    xRight: (rightDay - axisOriginDay) * pxPerDay,
    leftDay,
    rightDay,
  };
}

/**
 * 里程碑的几何中心：所在工作日**格的中点**（ADR 0007 §3 的视觉约定）。
 * @param {object} args
 * @param {Calendar} args.calendar
 * @param {number} args.es
 * @param {number} args.axisOriginDay
 * @param {number} args.pxPerDay
 */
export function milestoneCenterX({ calendar, es, axisOriginDay, pxPerDay }) {
  return (calendar.dayOfOrdinal(es) + 0.5 - axisOriginDay) * pxPerDay;
}

/**
 * 正交路由（ADR 0007 §5）：`出端水平 stub → 竖直段 → 入端水平 stub`，折点全部正交。
 *
 * 竖直段 x 的规则（§5 原文）：
 * - 常规情形 = 两端 stub 末点的**中点**；
 * - **需要回绕**（左出且目标 stub 在出端 stub 左侧 —— 即 SS/SF 且目标在前置左侧）
 *   取 `min(两端 x) − EDGE_WRAP_PX`，落在 §3 的左侧 gutter 内。
 *
 * @param {object} args
 * @param {Side} args.exitSide
 * @param {Side} args.enterSide
 * @param {number} args.exitX
 * @param {number} args.enterX
 * @param {number} args.yFrom
 * @param {number} args.yTo
 * @param {number} [args.stubPx]
 * @param {number} [args.wrapPx]
 */
export function routeEdge({
  exitSide,
  enterSide,
  exitX,
  enterX,
  yFrom,
  yTo,
  stubPx = EDGE_STUB_PX,
  wrapPx = EDGE_WRAP_PX,
}) {
  const exitDir = exitSide === 'right' ? 1 : -1;
  const enterDir = enterSide === 'right' ? 1 : -1;
  const exitStubX = exitX + exitDir * stubPx;
  const enterStubX = enterX + enterDir * stubPx;
  const wrapped = exitSide === 'left' && enterStubX < exitStubX;
  const verticalX = wrapped ? Math.min(exitStubX, enterStubX) - wrapPx : (exitStubX + enterStubX) / 2;
  /** @type {[number, number][]} */
  const raw = [
    [exitX, yFrom],
    [exitStubX, yFrom],
    [verticalX, yFrom],
    [verticalX, yTo],
    [enterStubX, yTo],
    [enterX, yTo],
  ];
  /** @type {[number, number][]} */
  const points = [];
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
    arrowDir: enterSide === 'left' ? 1 : -1,
  };
}

/**
 * 任一行（**含渲染窗口之外的行**）的条形/菱形几何。
 *
 * 为什么必须是模块级导出：边的端点在窗口外时也必须能算出坐标，否则跨屏长边画不出来；
 * 而折点定标（`fold-stability.mjs`）也要用**同一份**几何——两处各写一份就会分叉。
 *
 * 里程碑（含解析工期为 0 的叶子）走**菱形分支**，几何取"所在工作日格的中点" + 菱形包围盒。
 *
 * **实测发现**：ADR 0007 §3 的右边界公式 `dayOfOrdinal(ef − 1) + 1` 在 `ef === 0`
 * （项目起点处的零时长任务）时**未定义**——`dayOfOrdinal(-1)` 会让引擎抛 `RangeError`。
 * 里程碑本来就该画菱形而不是条形，因此该分支不再调用该公式；口径澄清已写进结论（不改语义）。
 *
 * @param {object} args
 * @param {ProjectDocument} args.document
 * @param {Schedule} args.schedule
 * @param {Calendar} args.calendar
 * @param {Int32Array} args.rowOfDocIndex
 * @param {number} args.axisOriginDay
 * @param {number} args.pxPerDay
 * @param {number} args.rowHeight
 * @param {number} args.docIndex
 */
export function taskBounds({
  document,
  schedule,
  calendar,
  rowOfDocIndex,
  axisOriginDay,
  pxPerDay,
  rowHeight,
  docIndex,
}) {
  const task = document.tasks[docIndex];
  if (task === undefined) return null;
  const row = rowOfDocIndex[docIndex] ?? -1;
  if (row < 0) return null; // 折叠隐藏 ⇒ 无边（ADR 0007 §6.3）
  const summary = (schedule.es[docIndex] ?? -1) === -1;
  const es = summary ? (schedule.summaryEs[docIndex] ?? -1) : (schedule.es[docIndex] ?? -1);
  const ef = summary ? (schedule.summaryEf[docIndex] ?? -1) : (schedule.ef[docIndex] ?? -1);
  if (es < 0 || ef < 0) return null; // 无叶子后代的空汇总：没有可画的条
  const isMilestone = !summary && (task.milestone || (task.durationDays ?? 0) === 0 || ef <= es);
  if (isMilestone) {
    const cx = milestoneCenterX({ calendar, es, axisOriginDay, pxPerDay });
    const size = rowHeight * SPACING.milestoneSizeRatio;
    return {
      docIndex,
      row,
      summary,
      isMilestone: true,
      es,
      ef,
      cx,
      size,
      xLeft: cx - size / 2,
      xRight: cx + size / 2,
      y: row * rowHeight + rowHeight / 2,
    };
  }
  const range = barXRange({ calendar, es, ef, axisOriginDay, pxPerDay });
  return {
    docIndex,
    row,
    summary,
    isMilestone: false,
    es,
    ef,
    xLeft: range.xLeft,
    xRight: range.xRight,
    y: row * rowHeight + rowHeight / 2,
  };
}

/**
 * 主入口：`文档 + Schedule + Calendar + 视口 → ViewModel`。
 *
 * @param {object} args
 * @param {ProjectDocument} args.document
 * @param {Schedule} args.schedule
 * @param {Calendar} args.calendar
 * @param {{ width: number, height: number, rowHeight: number, rowBuffer: number, scrollTop?: number, scrollLeft?: number }} args.viewport
 * @param {ZoomKey} args.zoom
 * @param {ClipMode} [args.clipMode]
 */
/** @returns {ViewModel} */
export function buildView({
  document,
  schedule,
  calendar,
  viewport,
  zoom,
  clipMode = /** @type {ClipMode} */ ('intersect'),
}) {
  const scrollTop = viewport.scrollTop ?? 0;
  const scrollLeft = viewport.scrollLeft ?? 0;
  const rowHeight = viewport.rowHeight;
  const pxPerDay = zoomPxPerDay(zoom);
  const axisOriginDay = axisOriginDayFor(calendar, schedule.projectStart, zoom);
  const order = visibleRowOrder(document);
  const rowOfDocIndex = rowIndexOfOrder(order, document.tasks.length);
  /** @type {Map<string, number>} */
  const docIndexOfTask = new Map();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined) docIndexOfTask.set(task.id, index);
  }

  const win = rowWindow({
    rowCount: order.length,
    scrollTop,
    height: viewport.height,
    rowHeight,
    rowBuffer: viewport.rowBuffer,
  });

  /**
   * 窗口内外的行都用同一份几何（见 `taskBounds`）。
   * @param {number} docIndex
   */
  const boundsFor = (docIndex) =>
    taskBounds({
      document,
      schedule,
      calendar,
      rowOfDocIndex,
      axisOriginDay,
      pxPerDay,
      rowHeight,
      docIndex,
    });

  /** @type {RowBox[]} */
  const rows = [];
  for (let row = win.renderFirst; row <= win.renderLast; row += 1) {
    const docIndex = order[row];
    if (docIndex === undefined) continue;
    const task = document.tasks[docIndex];
    const bounds = boundsFor(docIndex);
    if (task === undefined || bounds === null) continue;
    const y = row * rowHeight;
    const barHeight = rowHeight * (bounds.summary ? SPACING.summaryBarHeightRatio : SPACING.barHeightRatio);
    const barY = y + (rowHeight - barHeight) / 2;
    let hasProgress = false;
    let progressRatio = 0;
    if (bounds.summary) {
      const value = schedule.summaryProgress[docIndex] ?? Number.NaN;
      if (Number.isFinite(value)) {
        hasProgress = true;
        progressRatio = clamp01(value);
      }
    } else if (!bounds.isMilestone && task.progress !== null && task.progress !== undefined) {
      hasProgress = true;
      progressRatio = clamp01(task.progress);
    }
    rows.push({
      row,
      docIndex,
      id: task.id,
      kind: bounds.summary ? 'summary' : 'leaf',
      isMilestone: bounds.isMilestone,
      es: bounds.es,
      ef: bounds.ef,
      y,
      barY,
      barHeight,
      xLeft: bounds.xLeft,
      xRight: bounds.xRight,
      hasProgress: hasProgress && !bounds.isMilestone,
      progressRatio,
      progressWidth: (bounds.xRight - bounds.xLeft) * progressRatio,
      milestone: bounds.isMilestone
        ? {
            cx: bounds.cx ?? 0,
            cy: y + rowHeight / 2,
            size: bounds.size ?? rowHeight * SPACING.milestoneSizeRatio,
          }
        : null,
      styleKey: bounds.summary ? 'bar-summary' : bounds.isMilestone ? 'milestone' : 'bar',
    });
  }

  const selection = selectEdges({
    links: document.links,
    docIndexOfTask,
    rowOfDocIndex,
    renderFirst: win.renderFirst,
    renderLast: win.renderLast,
    visibleFirst: win.firstVisible,
    visibleLast: win.visibleLast,
    mode: clipMode,
  });

  /** @type {EdgeGeom[]} */
  const edges = [];
  let unroutable = 0;
  for (const linkIndex of selection.ids) {
    const link = document.links[linkIndex];
    if (link === undefined) continue;
    const fromDoc = docIndexOfTask.get(link.from);
    const toDoc = docIndexOfTask.get(link.to);
    if (fromDoc === undefined || toDoc === undefined) {
      unroutable += 1;
      continue;
    }
    const fromBounds = boundsFor(fromDoc);
    const toBounds = boundsFor(toDoc);
    if (fromBounds === null || toBounds === null) {
      unroutable += 1;
      continue;
    }
    const sides = ROUTE_SIDES[link.type] ?? ROUTE_SIDES.FS;
    const route = routeEdge({
      exitSide: sides.exit,
      enterSide: sides.enter,
      exitX: sides.exit === 'right' ? fromBounds.xRight : fromBounds.xLeft,
      enterX: sides.enter === 'right' ? toBounds.xRight : toBounds.xLeft,
      yFrom: fromBounds.y,
      yTo: toBounds.y,
    });
    edges.push({
      linkIndex,
      linkId: link.id,
      type: link.type,
      ignored: fromBounds.summary || toBounds.summary,
      fromRow: fromBounds.row,
      toRow: toBounds.row,
      fromDoc,
      toDoc,
      ...route,
      styleKey: fromBounds.summary || toBounds.summary ? 'edge-ignored' : 'edge',
    });
  }

  const axis = buildAxis({ calendar, axisOriginDay, pxPerDay, scrollLeft, width: viewport.width, zoom });

  return {
    zoom,
    clipMode,
    pxPerDay,
    rowHeight,
    axisOriginDay,
    scrollTop,
    scrollLeft,
    width: viewport.width,
    height: viewport.height,
    rowCount: order.length,
    firstVisible: win.firstVisible,
    visibleLast: win.visibleLast,
    renderFirst: win.renderFirst,
    renderLast: win.renderLast,
    order,
    rows,
    edges,
    axis,
    spanningEdges: selection.spanning,
    hiddenEdges: selection.hidden,
    unroutableEdges: unroutable,
  };
}

/**
 * 轴与刻度（§3：自然日连续，非工作日照常占位并视觉区分）。
 *
 * **水平裁剪在这里发生**：轴只画视口 x 范围内的刻度与色带——`c₃` 因此只与
 * "视口宽 / pxPerDay"有关，**与文档总规模无关**（这是 S4-a 的第三维裁剪）。
 *
 * @param {object} args
 * @param {Calendar} args.calendar
 * @param {number} args.axisOriginDay
 * @param {number} args.pxPerDay
 * @param {number} args.scrollLeft
 * @param {number} args.width
 * @param {ZoomKey} args.zoom
 */
/** @returns {AxisElement[]} */
export function buildAxis({ calendar, axisOriginDay, pxPerDay, scrollLeft, width, zoom }) {
  /** @type {AxisElement[]} */
  const elements = [];
  const dayFrom = axisOriginDay + Math.floor(scrollLeft / pxPerDay);
  const dayTo = axisOriginDay + Math.ceil((scrollLeft + width) / pxPerDay);
  const toX = (day) => (day - axisOriginDay) * pxPerDay - scrollLeft;

  // 非工作日色带：合并成极大连续段（一个 `<rect>` 代表一段，而不是一天一个）。
  let day = dayFrom;
  while (day <= dayTo) {
    if (calendar.isWorkday(day)) {
      day += 1;
      continue;
    }
    const start = day;
    while (day <= dayTo && !calendar.isWorkday(day)) day += 1;
    const x = toX(start);
    const bandWidth = (day - start) * pxPerDay;
    if (x + bandWidth >= 0 && x <= width) elements.push({ kind: 'band', x, width: bandWidth });
  }

  for (let tick = dayFrom; tick <= dayTo; tick += 1) {
    const isTick =
      zoom === 'day' ? true : zoom === 'week' ? weekdayOf(tick) === 1 : calendar.isoOfDay(tick).endsWith('-01');
    if (!isTick) continue;
    const x = toX(tick);
    if (x < -1 || x > width + 1) continue; // 水平裁剪
    const iso = calendar.isoOfDay(tick);
    // 标签长度随档位递减（可读性判据②）：日档 'DD'（2 字符）、周档 'MM-DD'（5）、月档 'YYYY-MM'（7）。
    const label = zoom === 'day' ? iso.slice(8) : zoom === 'week' ? iso.slice(5) : iso.slice(0, 7);
    elements.push({ kind: 'gridline', x });
    elements.push({ kind: 'label', x, text: label });
  }
  return elements;
}

/** 渲染出的行（**文档序索引**；ADR 0007 §2 的 `visibleRows`）。 */
export function visibleRows(view) {
  return view.rows.map((row) => row.docIndex);
}

/** 渲染出的边（**`links` 数组索引**；ADR 0007 §2 的 `visibleEdges`）。 */
export function visibleEdges(view) {
  return view.edges.map((edge) => edge.linkIndex);
}

/** x 像素 → 自然日序号（`DayNumber`，可为小数）。 */
export function dayAtX(view, x) {
  return view.axisOriginDay + (x + view.scrollLeft) / view.pxPerDay;
}

/**
 * x 像素 → 工作日序号（吸附候选）。
 *
 * 口径：取 `x` 所在**自然日之前**的工作日数 ⇒ 落在周末时得到的正是"下一个工作日"的序号，
 * 也就是一次吸附会落到的位置。**何时吸附由 G5 决定**（ADR 0007 §3 的分工）。
 *
 * @param {ReturnType<typeof buildView>} view
 * @param {number} x
 * @param {Calendar} calendar
 */
export function ordinalAtX(view, x, calendar) {
  return calendar.ordinalOfDay(Math.floor(dayAtX(view, x)));
}

/** @param {number} value */
function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

