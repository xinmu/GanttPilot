/**
 * **两级刻度与悬停行带**的读数（DOM 真值）。判据侧在 `smoke:build`（门禁）与
 * `scripts/offline-artifact-probe.mjs`（记录制）两条通道共用这一份读数口（P-40 的两条通道口径）。
 *
 * **命名**（P3/C6-c）：本模块原叫 `g8.ts`——按**能力块编号**命名。能力块代号（G0–G8）
 * 是**工程阶段**的编号，不是功能语义：G8 那一块是"发布面（刻度 / 悬停带 / 模板 / 离线单文件）"，
 * 而本模块只负责**它的两条读数的读数口**。代号随版本消失，读数对象不会 ⇒ 按读数对象改名。
 * 文档里的"G8 复验第 ③ 条"一类措辞**保留**：那里的代号是**记录指针**（指哪一轮裁决/复验），不是标识符。
 */

import { type ViewModel, type ZoomKey } from '@ganttpilot/render-core';

/**
 * **两级刻度与悬停行带的可判定读数**（P-46 的「刻度行两级」与「指针所在整行高亮」）。
 *
 * ## 为什么这两条需要入口
 *
 * 它们的判据侧写不进 `packages/*`：**刻度是否画成了两行**、**指针所在行有没有浅色底**
 * 都是 DOM 事实（一个在 SVG 的 `<text y>`、一个在 `getComputedStyle`）。
 * 按 [P-40](../../docs/00-baseline/裁决R39.md) 的两条通道口径，这类事实走
 * **`smoke:build`（门禁）+ 记录制（打包产物）**——本接口就是那两条通道共用的读数口。
 *
 * ## 口径（一次读完，不做增量）
 *
 * - `axis`：**从 DOM 读回**两行刻度的证据（不是从 `ViewModel` 复述一遍——那样判据会变成恒真式）；
 * - `hover.at`：把指针放到第 N 个**可见行**的条体上（走用户同一条 `hoverAt`），再读三件事：
 *   ① SVG 里有没有 `.hover-row`、② 它的纵向范围是否落在那一行、③ 左表对应行是否真的变了底色。
 */
export interface AxisHoverMeasurementHost {
  /** 指针挪到第 N 个可见行的竖向中心（走 `App.vue` 与用户同一条 hover 入口）。 */
  readonly hoverRowAt: (rowIndex: number) => void;
  /** 清掉指针（读"没有高亮"的对照）。 */
  readonly clearHover: () => void;
  /** 当前档位（判"上级标签随档位变化"的前提）。 */
  readonly zoom: () => ZoomKey;
  /** 切档位（与用户点工具栏同一条 `chart.setZoom`）。 */
  readonly setZoom: (zoom: ZoomKey) => void;
  /** 当前视图模型（稳定读的指纹要它，与 `--drag`/`--align` 同源）。 */
  readonly view: () => ViewModel | null;
  /**
   * **已提交的会话修订号**（`session.revision`）。
   *
   * 为什么读它而不是从状态栏文案里正则解析：文案是**给人看的**（格式随文案调整而变），
   * 而"插桩要证明『松手真的落了库』"必须有一个**结构性**的读数。与 `--drag`/`--persist-drag`
   * 的"预览不落库"判据同源（P-45 的口径：修订号只有真的落库才前进）。
   */
  readonly revision: () => number;
}

/** `__GANTTPILOT_MEASURE_AXIS_HOVER__` 的产出（**全是 DOM 真值 + 一个结构性读数**）。 */
export interface AxisHoverMeasureResult {
  /**
   * 读数期的**自证失败**原因（空 = 全部自证通过：档位切换与三次悬停后的读数都在稳定读预算内稳定）。
   *
   * **为什么不走 `window` 上的错误槽**（P3/C6-d 的订正）：那要求调用方读两处状态（返回值 + 全局），
   * 而"这一轮到底稳不稳"是**这一轮结果的一部分**。字段跟着结果一起回，读数口就只有一处出口。
   */
  readonly errors: readonly string[];
  readonly zoom: string;
  /** 读这几个读数时**已提交**的会话修订号（松手前后各读一次即可证明"真的落库了"）。 */
  readonly revision: number;
  readonly axis: {
    /** 表头带内 `<text>` 的总数（两级之和）。 */
    readonly texts: number;
    /** `y` 较小那一行的文本样本（下级刻度）。 */
    readonly minorY: number | null;
    readonly minorSamples: readonly string[];
    /** `y` 较大那一行的文本样本（上级刻度）。 */
    readonly majorY: number | null;
    readonly majorSamples: readonly string[];
    /** 上级分段带（`.axis-major-band`）的元素数。 */
    readonly majorBands: number;
    /** 左表表头的外高与图表表头带的外高（必须相等）。 */
    readonly headerTable: number;
    readonly headerChart: number;
    /** 左表表头第二行的**文本**（P-46 定值：必须是空串）。 */
    readonly tableHeaderSecondRowText: string;
  };
  readonly hover: {
    /** 未悬停时的读法（对照）。 */
    readonly idle: HoverReading;
    /** 指针落在第 1 个可见行时的读法。 */
    readonly onRow: HoverReading;
    /** 指针落在第 3 个可见行时的读法（证明它**跟着指针走**，不是一个固定的带）。 */
    readonly onThirdRow: HoverReading;
  };
}

/** 一次悬停读数。 */
export interface HoverReading {
  /** SVG 里 `.hover-row` 的个数（期望 0 或 1）。 */
  readonly svgHoverRows: number;
  /** 该 `<rect>` 的屏幕矩形（`null` = 不存在）。 */
  readonly svgRect: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number } | null;
  /** 左表第 N 行的 `background-color`（`getComputedStyle`；空串 = 找不到那一行）。 */
  readonly tableBackground: string;
  /** 读的是左表哪一行（`data-task-id`；空串 = 没有行）。 */
  readonly tableTaskId: string;
}

function roundRect(box: { top: number; bottom: number; left: number; right: number } | null): HoverReading['svgRect'] {
  if (box === null) return null;
  return {
    top: Math.round(box.top * 10) / 10,
    bottom: Math.round(box.bottom * 10) / 10,
    left: Math.round(box.left * 10) / 10,
    right: Math.round(box.right * 10) / 10,
  };
}

/** 从 DOM 读一次"两级刻度"的证据（**判据要的是 DOM 真值**）。 */
export function readAxisFacts(): AxisHoverMeasureResult['axis'] {
  /**
   * 两行刻度的证据取自**文本盒的竖向中心**（不是 `y` 属性）：文字盒反映的是"屏幕上真的分了两行"
   * 这件事本身，而 `y` 只是它的因；两者取其一就够，取盒更接近判据要回答的问题。
   *
   * **行序的命名**（G8 复验第 ③ 条订正后）：**大刻度在上**（`majorY` = 最小中心 y，
   * 日/周档 `YYYY-MM`、月档 `YYYY`）、**小刻度在下**（`minorY` = 最大中心 y，`DD`/`MM-DD`）。
   * 首版把这两个字段的含义写反了（`minorY` 装的是上级行），于是判据会"两边都通过"
   * ——这正是"读数口本身也要有判据"的例子。
   */
  const texts = [...document.querySelectorAll('.chart-pane-wrap .axis-labels text, #chart-pane .axis-labels text')];
  const measured = texts.map((element) => {
    const rect = element.getBoundingClientRect();
    return { text: element.textContent ?? '', centerY: Math.round((rect.top + rect.bottom) / 2) };
  });
  const ys = [...new Set(measured.map((item) => item.centerY))].sort((left, right) => left - right);
  const majorY = ys.length > 0 ? (ys[0] ?? null) : null;
  const minorY = ys.length > 1 ? (ys[ys.length - 1] ?? null) : null;
  const headerTable = document.querySelector('.table-header')?.getBoundingClientRect().height ?? 0;
  const headerChart = document.querySelector('.chart-header')?.getBoundingClientRect().height ?? 0;
  const blank = document.querySelector('.table-header .cell-blank');
  return {
    texts: texts.length,
    minorY,
    minorSamples: minorY === null ? [] : measured.filter((item) => item.centerY === minorY).map((item) => item.text).slice(0, 6),
    majorY,
    majorSamples: majorY === null ? [] : measured.filter((item) => item.centerY === majorY).map((item) => item.text).slice(0, 6),
    /**
     * 上级分段带的元素数：屏幕侧它现在拆成**两个**元素（`axis-major-body` 绘制区底 +
     * `axis-major-header` 表头底）——两者都是"同一个 `major-band` 轴元素"的投影，
     * 因此读数取**较大者**（每个轴元素恰好各有一份），而不是把两者相加。
     * 这一条与导出 SVG / PPTX 的口径一致（那边也是"一个轴元素 → 多个图形"）。
     */
    majorBands: Math.max(
      document.querySelectorAll('.axis .axis-major-body').length,
      document.querySelectorAll('.axis-header .axis-major-header').length,
    ),
    headerTable: Math.round(headerTable * 10) / 10,
    headerChart: Math.round(headerChart * 10) / 10,
    tableHeaderSecondRowText: (blank?.textContent ?? '').trim(),
  };
}

/** 从 DOM 读一次"悬停行带"的证据（三处：SVG 元素、它的矩形、左表那一行的底色）。 */
export function readHoverFacts(rowIndex: number): HoverReading {
  const rows = [...document.querySelectorAll('.table-body .row-block .row[data-task-id]')];
  const row = rows[rowIndex] ?? null;
  const background = row === null ? '' : getComputedStyle(row).backgroundColor;
  const hoverNodes = [...document.querySelectorAll('.chart-pane-wrap .hover-row, #chart-pane .hover-row')];
  const first = hoverNodes[0] ?? null;
  const box = first === null ? null : first.getBoundingClientRect();
  return {
    svgHoverRows: hoverNodes.length,
    svgRect: roundRect(box === null ? null : { top: box.top, bottom: box.bottom, left: box.left, right: box.right }),
    tableBackground: background,
    tableTaskId: row?.getAttribute('data-task-id') ?? '',
  };
}

// ---------------------------------------------------------------- G5 批次 D：两栏行对齐（记录制，ADR 0007 §14 / 裁决 P-23）
