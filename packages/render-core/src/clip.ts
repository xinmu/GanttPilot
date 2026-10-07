/**
 * 裁剪（ADR 0007 §6 的四条契约 + §11.1 的三条口径澄清）。**纯函数、零 DOM**。
 *
 * 本模块刻意只做"选哪些行 / 选哪些边 / 出哪些轴元素"，**不做任何几何计算**——
 * 这正是 §6.5「**裁剪先于几何计算**」的可执行形式：调用方先把窗口筛出来，再算 path 与坐标。
 *
 * ## 三条必须一起读的口径
 *
 * 1. **"可见行窗口" = §6.1 的渲染窗口（可见行 + 上下 `ROW_BUFFER` 行）**。
 *    §6.2 写的是"边所跨行区间 ∩ **可见行窗口**"，而 §6.1 已把渲染行定义为"可见行 + 缓冲"；
 *    若把 §6.2 的窗口读成"不含缓冲"，缓冲行内出现的边会被漏画——与 §6.1 自相矛盾。
 *    G4-S 按"渲染窗口"实现并写进结论，本实现照此（ADR 0007 §11.1 ②）。
 * 2. **折叠隐藏的行不画其边**（§6.3）**由同一遍求交自然完成**：隐藏行没有可见行序号，
 *    端点映射为 `-1` ⇒ 该边被排除，不需要第二条规则。
 * 3. **轴与刻度还有第三维：水平窗口**（§11.1 ③）。轴只发射视口 x 范围内的刻度与色带，
 *    因此 `c₃` 只与"视口宽 ÷ `pxPerDay`"有关，**与文档总规模无关**。
 *
 * ## 两个反例路径（负向对照的载体，不是可选开关）
 *
 * - `clipMode: 'endpoints'`：仅当**两端点都可见**才画（T-4/《评估报告》§5.4 点名要避免的写法）。
 *   G4-S 实测它在 4 个滚动位置误裁 33/97/96/88 = **314** 条边（其中跨屏长边 268）——
 *   判据"求交是必需的"靠它才有判别力。
 * - `clipMode: 'none'`：关掉窗口裁剪（可见行内的边全画、缓冲行设为整篇）。
 *   G4-S 实测元素数在 10× 规模跨度上增长 **10.71×**——判据"与规模解耦"靠它才有判别力。
 */

import type { DayNumber, DocumentLink } from '@ganttpilot/engine';

import type { ZoomKey } from './manifest.js';

/** 边窗口的三种口径（`intersect` 是产品路径，另两条只作负向对照）。 */
export type ClipMode = 'intersect' | 'endpoints' | 'none';

/** 行窗口（行序号；`renderFirst`/`renderLast` 是**渲染**窗口，含缓冲）。 */
export interface RowWindow {
  readonly rowCount: number;
  readonly firstVisible: number;
  readonly visibleLast: number;
  readonly renderFirst: number;
  readonly renderLast: number;
}

/**
 * 行窗口：可见行 + 上下各 `rowBuffer`（ADR 0007 §6.1）。
 *
 * 空文档（`rowCount === 0`）时 `visibleLast = -1`、`renderLast = -1`，调用方的循环自然不执行。
 */
export function rowWindow(args: {
  readonly rowCount: number;
  readonly scrollTop: number;
  readonly height: number;
  readonly rowHeight: number;
  readonly rowBuffer: number;
}): RowWindow {
  const { rowCount, scrollTop, height, rowHeight, rowBuffer } = args;
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visibleCount = Math.max(1, Math.ceil(height / rowHeight));
  const visibleLast = Math.min(rowCount - 1, firstVisible + visibleCount - 1);
  const renderFirst = Math.max(0, firstVisible - rowBuffer);
  const renderLast = Math.min(rowCount - 1, visibleLast + rowBuffer);
  return { rowCount, firstVisible, visibleLast, renderFirst, renderLast };
}

/** 文档序索引 → 该行是否落在**渲染**窗口内。 */
export function isRenderedRow(
  rowOfDocIndex: Int32Array,
  renderFirst: number,
  renderLast: number,
  docIndex: number,
): boolean {
  const row = rowOfDocIndex[docIndex];
  return row !== undefined && row >= renderFirst && row <= renderLast;
}

/** {@link selectEdges} 的产出。 */
export interface EdgeSelection {
  /** 要画的边（`document.links` 的下标）。 */
  readonly ids: readonly number[];
  /** 「跨屏长边」：至少一个端点不在**可见**窗口内，但区间与可见窗口相交。 */
  readonly spanning: readonly number[];
  /**
   * **结构上不可画**的边：端点悬空、或端点被折叠隐藏（`§6.3`）。
   *
   * 它与 `mode` **无关**——因此可以直接断言"求交路径与端点可见性路径隐藏的边逐条相同"
   * （折叠健全性）；落进行窗口之外的边**不在这里**（那是窗口裁剪的结果，见 `ids` 的补集）。
   */
  readonly hidden: readonly number[];
  /** 反例路径（`mode: 'endpoints'`）实际选中的边——只用于负向对照的差集计算。 */
  readonly byEndpoints: readonly number[];
}

/**
 * 边窗口裁剪：**「边所跨行区间 ∩ 渲染窗口」求交**（ADR 0007 §6.2）。
 *
 * 与"端点可见性裁剪"的差别正是要量化的那个差别：跨屏长边的两端都不在窗口里，
 * 但它的**区间**穿过窗口 ⇒ 必须画。
 *
 * 「边所跨行区间」= 两端点**可见行序号**的闭区间（折叠隐藏的端点行号是 `-1` ⇒ 整条边不画）。
 */
export function selectEdges(args: {
  readonly links: readonly DocumentLink[];
  readonly docIndexOfTask: ReadonlyMap<string, number>;
  readonly rowOfDocIndex: Int32Array;
  readonly renderFirst: number;
  readonly renderLast: number;
  readonly visibleFirst: number;
  readonly visibleLast: number;
  readonly mode: ClipMode;
}): EdgeSelection {
  const { links, docIndexOfTask, rowOfDocIndex, renderFirst, renderLast, visibleFirst, visibleLast, mode } = args;
  const ids: number[] = [];
  const spanning: number[] = [];
  const hidden: number[] = [];
  const byEndpoints: number[] = [];

  const isVisible = (row: number): boolean => row >= visibleFirst && row <= visibleLast;

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) continue;
    const fromDoc = docIndexOfTask.get(link.from);
    const toDoc = docIndexOfTask.get(link.to);
    if (fromDoc === undefined || toDoc === undefined) {
      hidden.push(index); // 端点悬空（前置条件已保证合法文档不会有，防御性）
      continue;
    }
    const fromRow = rowOfDocIndex[fromDoc] ?? -1;
    const toRow = rowOfDocIndex[toDoc] ?? -1;
    if (fromRow < 0 || toRow < 0) {
      hidden.push(index); // 端点被折叠隐藏 ⇒ 悬空线不可画（§6.3，与求交同一遍）
      continue;
    }
    const low = Math.min(fromRow, toRow);
    const high = Math.max(fromRow, toRow);

    if (mode === 'none') {
      // NC2 的"关掉窗口裁剪"：不按行区间过滤（端点行必然存在，折叠过滤已在上面去掉隐藏行）。
      ids.push(index);
      continue;
    }

    if (mode === 'intersect') {
      if (low <= renderLast && high >= renderFirst) {
        ids.push(index);
        const touchesVisible = low <= visibleLast && high >= visibleFirst;
        const endpointsVisible = isVisible(fromRow) && isVisible(toRow);
        if (touchesVisible && !endpointsVisible) spanning.push(index);
      }
      continue;
    }

    // 反例路径：仅当两端点都在**可见**窗口内才画（T-4 点名要避免的实现）。
    if (isVisible(fromRow) && isVisible(toRow)) {
      ids.push(index);
      byEndpoints.push(index);
    }
  }

  return { ids, spanning, hidden, byEndpoints };
}

// ---------------------------------------------------------------- 轴（第三维裁剪）

/**
 * 轴元素（ADR 0007 §11 第 6 项 + [附录 §3](../…/docs/02-adr/附录/0007-增补.md) 的两级刻度）。
 *
 * ## 两级结构（P-46 增补）
 *
 * 刻度从**一级**改为**两级**：
 *
 * - **下级**（`level: 2`，缺省即此）：既有语义一字未改——日档每天、周档周一、月档 1 日，
 *   各发一对 `gridline` + `label`；
 * - **上级**（`level: 1`）：按**分段带**表达——**段内只在左端**发一次文本（`label`）、
 *   一条自带左竖线的 `major-band`。日/周档上级标签取 `YYYY-MM`、月档取 `YYYY`。
 *   **段与下级刻度同 x 时不再重复发 `gridline`**（一次绘制画两条线没有意义，且会让
 *   `c₃` 与 DOM 两路计数对不上）。
 *
 * 两级元素**共用同一处水平窗口裁剪**（§11.1 ③）——这是"`c₃` 仍与文档总规模无关"的前提。
 *
 * ## `hover-band`（P-46 §2.2：指针所在整行的浅色高亮）
 *
 * 它是**每帧固定开销**的那 1 个覆盖层元素（`c₄` 的 `overlay` 项），由 `buildAxis` 在最后追加
 * （`row` 由调用方给出）。**画在窗口坐标的 `x` 起点、但宽度取内容宽**：行高亮是"指针所在的那一行"，
 * 而"那一行"在横向是有长度的（= 内容宽）；放进**内容滚动组**（横向不翻译）⇒ 它跟着行滚到任何位置。
 * 用视口宽会表现为"首屏那一段亮、向右滚动后的新部分不亮"（G8 第二次复验第 ① 条）。
 */
export type AxisElement =
  /** 非工作日色带（极大连续段）；`level: 2` = 下级（缺省）。 */
  | { readonly kind: 'band'; readonly x: number; readonly width: number; readonly level?: 2 }
  | { readonly kind: 'gridline'; readonly x: number }
  /** 下级刻度文本（既有语义不变）。 */
  | { readonly kind: 'label'; readonly x: number; readonly text: string; readonly level?: 2 }
  /** 上级刻度文本（分段带的左端，段内只发一次）。 */
  | { readonly kind: 'label'; readonly x: number; readonly text: string; readonly level: 1 }
  /**
   * 上级分段带：`x` = 段左边界、`width` = 段宽（**允许越过绘制区右缘**，由消费方裁剪——
   * 与既有 `band` 同口径）。左边界即该段的竖线，因此**不再单独发 `gridline`**。
   */
  | { readonly kind: 'major-band'; readonly x: number; readonly width: number; readonly level: 1 }
  /** 指针所在整行的浅色行带（覆盖层；**x 起点在窗口坐标、宽度取内容宽**，高 = 可视行高）。 */
  | {
      readonly kind: 'hover-band';
      readonly x: number;
      readonly width: number;
      readonly y: number;
      readonly height: number;
    };

/** 轴元素计算所需的日历面（`Calendar` 的结构子集，便于测试注入最小实现）。 */
export interface AxisCalendarLike {
  isWorkday(day: number): boolean;
  isoOfDay(day: number): string;
}

/** 星期几（0 = 周日 … 6 = 周六）。与 `@ganttpilot/engine` 的 `weekdayOf` 同口径。 */
function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/**
 * 上级分段的键（**纯字符串切分，不做第二套日期算术**）。
 *
 * 日/周档取 `YYYY-MM`、月档取 `YYYY`——即 [ADR 0007 附录 §3](../…/docs/02-adr/附录/0007-增补.md) 的定值。
 */
function majorKeyOf(iso: string, zoom: ZoomKey): string {
  return zoom === 'month' ? iso.slice(0, 4) : iso.slice(0, 7);
}

/** 下级刻度的判据与标签（ADR 0007 §11 第 6 项：日档 `DD`、周档 `MM-DD`、月档 `YYYY-MM`）。 */
function tickLabelOf(calendar: AxisCalendarLike, day: number, zoom: ZoomKey): string | null {
  const iso = calendar.isoOfDay(day);
  if (zoom === 'day') return iso.slice(8);
  if (zoom === 'week') return weekdayOf(day) === 1 ? iso.slice(5) : null;
  return iso.endsWith('-01') ? iso.slice(0, 7) : null;
}

/**
 * 轴与刻度（ADR 0007 §3 / §11 第 6 项 + 附录 §3 的两级结构）：自然日连续，
 * 非工作日照常占位并视觉区分。
 *
 * **水平裁剪在这里发生**（§11.1 ③）：
 * - 非工作日色带**合并成极大连续段**（一个 `<rect>` 代表一段，而不是一天一个）；
 * - 下级网格线与标签按档位步进（日档每天、周档周一、月档 1 日）；
 * - 上级刻度按**分段带**表达（段内只在左端发一次文本）；
 * - 只发射落在视口 x 范围内的元素（色带的判据 `x + width >= 0 && x <= width`，
 *   刻度与标签的判据 `x >= -1 && x <= width + 1`）。
 *
 * **数组顺序只是构造顺序，不是绘制顺序**：本函数的发射次序是"下级色带 → 下级网格线 → 下级标签 →
 * 上级分段带 → 上级标签"，而**绘制顺序由消费方按层决定**（屏幕/导出 SVG 与 PPTX 都是
 * 「上级正文 → 周末色带 → 上级边界/表头底 → 下级短刻度 → 标签」，见 `SPEC.md` §三 的表与 `svgExport.ts` 的轴注释）；
 * `hoverRow` 给定时**最后**追加一个 `hover-band`（覆盖层，画在各层之下还是要由消费方定序，
 * 本函数只负责"它在轴元素里、计数为 1"）。
 */
export function buildAxis(args: {
  readonly calendar: AxisCalendarLike;
  readonly axisOriginDay: number;
  readonly pxPerDay: number;
  readonly scrollLeft: number;
  readonly width: number;
  /**
   * **内容总宽**（`ViewModel.contentWidth`）：只给 `hover-band` 用。
   *
   * 悬停行带的语义是"**整行**高亮"，因此它必须铺到**行的实际宽度**（= 内容宽），
   * 而不是视口宽——用视口宽会表现为"**首屏那一段亮、向右滚动后新的部分不亮**"
   * （G8 第二次复验第 ① 条）。**只有它**用这个值：其余轴元素的裁剪仍按视口宽
   * （`c₃` 与文档总规模无关这条不变量依赖 `width`，不能混）。
   *
   * 缺省回落到 `width`（既有调用方与测试不必都改；行为与"视口宽"等价）。
   */
  readonly contentWidth?: number;
  readonly zoom: ZoomKey;
  /** 指针所在的**渲染行序号**（`null` = 无高亮）。它决定 `hover-band` 的 `y`。 */
  readonly hoverRow?: number | null;
  /** 行高（`hover-band` 的 `height`；缺省 0 时**不发射**，避免零高元素混进计数）。 */
  readonly rowHeight?: number;
}): readonly AxisElement[] {
  const { calendar, axisOriginDay, pxPerDay, scrollLeft, width, zoom } = args;
  const elements: AxisElement[] = [];
  const dayFrom = axisOriginDay + Math.floor(scrollLeft / pxPerDay);
  const dayTo = axisOriginDay + Math.ceil((scrollLeft + width) / pxPerDay);
  const toX = (day: number): number => (day - axisOriginDay) * pxPerDay - scrollLeft;

  // 非工作日色带：合并成极大连续段。
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

  // 下级刻度：网格线 + 文本（**先发**，上级分段带据此判重）。
  const tickX = new Set<number>();
  for (let tick = dayFrom; tick <= dayTo; tick += 1) {
    const label = tickLabelOf(calendar, tick, zoom);
    if (label === null) continue;
    const x = toX(tick);
    if (x < -1 || x > width + 1) continue; // 水平裁剪
    tickX.add(x);
    elements.push({ kind: 'gridline', x });
    elements.push({ kind: 'label', x, text: label, level: 2 });
  }

  // 上级分段带（P-46）：段内只在左端发一次文本；段的左边界即竖线（与下级刻度同 x 则不重复发）。
  let segmentStart: DayNumber | null = null;
  let segmentKey = '';
  let segmentLabel: string | null = null;
  const pushSegment = (endDayExclusive: DayNumber): void => {
    if (segmentStart === null || segmentLabel === null) return;
    const x = toX(segmentStart);
    const segmentWidth = (endDayExclusive - segmentStart) * pxPerDay;
    if (x + segmentWidth >= 0 && x <= width) {
      elements.push({ kind: 'major-band', x, width: segmentWidth, level: 1 });
      if (x >= -1 && x <= width + 1) {
        if (!tickX.has(x)) elements.push({ kind: 'gridline', x });
        elements.push({ kind: 'label', x, text: segmentLabel, level: 1 });
      }
    }
    segmentStart = null;
    segmentLabel = null;
  };
  for (let tick = dayFrom; tick <= dayTo + 1; tick += 1) {
    const iso = tick <= dayTo ? calendar.isoOfDay(tick) : null;
    const key = iso === null ? null : majorKeyOf(iso, zoom);
    if (segmentStart === null) {
      if (key === null) continue;
      segmentStart = tick;
      segmentKey = key;
      segmentLabel = key;
      continue;
    }
    if (key === segmentKey) continue;
    pushSegment(tick);
    if (key !== null) {
      segmentStart = tick;
      segmentKey = key;
      segmentLabel = key;
    }
  }
  pushSegment(dayTo + 1);

  // 指针所在整行的浅色行带（P-46 §2.2；窗口坐标、每帧 1 个元素）。
  //
  // **宽度取内容宽**（`contentWidth`，缺省回落视口宽）：行带要"贯穿整行"，
  // 而它画在内容滚动组里（横向不翻译）⇒ 铺到内容宽即跟着行滚到任何位置。
  // 用视口宽的话只有首屏那一段会亮（G8 第二次复验第 ① 条）。
  const hoverRow = args.hoverRow ?? null;
  const rowHeight = args.rowHeight ?? 0;
  if (hoverRow !== null && rowHeight > 0) {
    elements.push({
      kind: 'hover-band',
      x: 0,
      width: Math.max(width, args.contentWidth ?? width),
      y: hoverRow * rowHeight,
      height: rowHeight,
    });
  }

  return elements;
}

/**
 * 轴线起点（ADR 0007 §3）：`dayOfOrdinal(projectStart)` 按档位**向前取整到该档位的起点**
 * （日档 = 当天；周档 = 该周周一；月档 = 该月 1 日），再向左留 `AXIS_LEFT_GUTTER_DAYS`。
 *
 * **左边距不是装饰**：P-8 的 SS/SF"左出回绕"走线需要图表左侧有空间，否则折线会压在左表上。
 */
export function axisOriginDayFor(args: {
  readonly calendar: {
    dayOfOrdinal(ordinal: number): number;
    dayOfIso(iso: string): number;
    isoOfDay(day: number): string;
  };
  readonly projectStartOrdinal: number;
  readonly zoom: ZoomKey;
  readonly gutterDays: number;
}): number {
  const startDay = args.calendar.dayOfOrdinal(args.projectStartOrdinal);
  let aligned = startDay;
  if (args.zoom === 'week') {
    aligned = startDay - ((weekdayOf(startDay) + 6) % 7); // 周一（0=周日…6=周六）
  } else if (args.zoom === 'month') {
    // 该月 1 日：ISO 的 `YYYY-MM-` + `01`。用 `dayOfIso` 而不是自算月长，避免第二套日期算术。
    aligned = args.calendar.dayOfIso(`${args.calendar.isoOfDay(startDay).slice(0, 8)}01`);
  }
  return aligned - args.gutterDays;
}
