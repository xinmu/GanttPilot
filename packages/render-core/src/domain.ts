/**
 * 领域层几何：`文档 + Schedule + Calendar + 轴参数 → 条形/菱形几何`（ADR 0007 §3 / §4）。
 *
 * ## 三条硬口径（写在最前面，因为踩过）
 *
 * 1. **`-1` 是哨兵，绝不可喂进来**：`es[i] === -1` ⟺ 第 i 行是汇总任务，
 *    这是 `Schedule` 形状里**唯一的**汇总判别式（`packages/engine/SCHEDULE.md` §三）。
 *    {@link barXRange} 对非法/负序号**抛 `RangeError`**，不静默出 `NaN`（有负向对照守住）。
 * 2. **右边界 = `dayOfOrdinal(ef − 1) + 1`**，不能用 `dayOfOrdinal(ef)`：`ef` 是**排他**结束序号，
 *    跨周末的任务（周五 + 周一）用后者会多出一整段空隙。**但该公式在 `ef === 0` 时未定义**
 *    （`dayOfOrdinal(-1)` 抛错）——项目起点处的零时长任务（典型是里程碑）因此走**菱形分支**，
 *    条形分支的公式一字未改（ADR 0007 §11.1 ①）。
 * 3. **窗口外的行也必须能算出几何**：跨屏长边的两端常常都在渲染窗口之外，
 *    折点定标也要用同一份几何。因此 {@link taskBounds} 是**模块级导出**，
 *    调用方（`buildView` 与检查器）都复用它，**不复制公式**（G4-S 第一版就是在检查器里
 *    重写了右边界公式，于是里程碑端点被误判 8 px——两个真相源的经典陷阱）。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import { ROW_HEIGHT, SPACING } from './manifest.js';

/** 行的几何身份：叶子 / 汇总 / 里程碑。 */
export type RowKind = 'leaf' | 'summary';

/** 一行（**任意行**，含渲染窗口之外）的条形或菱形几何。 */
export interface TaskBounds {
  /** `document.tasks` 的下标。 */
  readonly docIndex: number;
  /** 可见行序号（折叠隐藏 ⇒ 本函数返回 `null`）。 */
  readonly row: number;
  readonly kind: RowKind;
  readonly isMilestone: boolean;
  /** 参与几何的序号（汇总行取 `summaryEs`）。 */
  readonly es: number;
  /** 参与几何的序号（汇总行取 `summaryEf`）。 */
  readonly ef: number;
  readonly xLeft: number;
  readonly xRight: number;
  /** 条/菱形竖向中心（内容坐标，行顶 = row × rowHeight）。 */
  readonly y: number;
  /** 仅里程碑行：菱形中心与边长。 */
  readonly milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null;
}

/** 轨道参数（几何的坐标基准）。 */
export interface AxisParams {
  /** 轴线起点（自然日序号，可为负——左侧 gutter 在起点之前）。 */
  readonly axisOriginDay: number;
  readonly pxPerDay: number;
  readonly rowHeight: number;
}

/**
 * 可见行序列 = 树序（**文档序**，父先于子）经**折叠过滤**后的子序列（ADR 0007 §4）。
 *
 * 返回的是**文档序索引**（`document.tasks` 的下标），不是任务 id：
 * `Schedule` 的数组按文档序索引，渲染层负责这次映射，**不改变 `Schedule` 的索引约定**。
 *
 * 折叠语义：`task.collapsed === true` 时**整棵子树**不进可见行（其边也不画，否则悬空线）。
 */
export function visibleRowOrder(document: ProjectDocument): readonly number[] {
  const tasks = document.tasks;
  const childrenOf = new Map<string | null, number[]>();
  for (let index = 0; index < tasks.length; index += 1) {
    const parentId = tasks[index]?.parentId ?? null;
    const bucket = childrenOf.get(parentId);
    if (bucket === undefined) childrenOf.set(parentId, [index]);
    else bucket.push(index);
  }

  const order: number[] = [];
  const walk = (parentId: string | null): void => {
    for (const index of childrenOf.get(parentId) ?? []) {
      order.push(index);
      const task = tasks[index];
      if (task === undefined) continue;
      if (task.collapsed) continue; // 折叠 ⇒ 整棵子树不进可见行
      walk(task.id);
    }
  };
  walk(null);
  return order;
}

/** 文档序索引 → 可见行序号（`-1` = 不可见 / 被折叠隐藏）。 */
export function rowIndexOfOrder(order: readonly number[], taskCount: number): Int32Array {
  const map = new Int32Array(taskCount).fill(-1);
  for (let row = 0; row < order.length; row += 1) {
    const docIndex = order[row];
    if (docIndex !== undefined) map[docIndex] = row;
  }
  return map;
}

/**
 * 条形的 x 区间（ADR 0007 §3 的映射公式）。
 *
 * `es` / `ef` 必须是 `≥ 0` 的整数：`-1` 是汇总哨兵、负序号无定义（G1.1 冻结），
 * 静默截断会让"没画出来"变成"画错了"，所以这里**抛 `RangeError`**。
 */
export function barXRange(args: {
  readonly calendar: Calendar;
  readonly es: number;
  readonly ef: number;
  readonly axisOriginDay: number;
  readonly pxPerDay: number;
}): { readonly xLeft: number; readonly xRight: number; readonly leftDay: number; readonly rightDay: number } {
  const { calendar, es, ef, axisOriginDay, pxPerDay } = args;
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

/** 里程碑的几何中心 x：所在工作日**格的中点**（ADR 0007 §3 的视觉约定，不改变"零时长"语义）。 */
export function milestoneCenterX(args: {
  readonly calendar: Calendar;
  readonly es: number;
  readonly axisOriginDay: number;
  readonly pxPerDay: number;
}): number {
  const { calendar, es, axisOriginDay, pxPerDay } = args;
  if (!Number.isInteger(es) || es < 0) {
    throw new RangeError(`里程碑的序号非法：es=${String(es)}（-1 是哨兵，不可用于几何）`);
  }
  return (calendar.dayOfOrdinal(es) + 0.5 - axisOriginDay) * pxPerDay;
}

/** {@link taskBounds} 的入参。 */
export interface TaskBoundsArgs {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly rowOfDocIndex: Int32Array;
  readonly axisOriginDay: number;
  readonly pxPerDay: number;
  readonly rowHeight: number;
  readonly docIndex: number;
}

/**
 * 任一行（**含渲染窗口之外的行**）的条形/菱形几何；**没有可画条形的行返回 `null`**。
 *
 * 三种返回 `null` 的情形：
 * - 折叠隐藏（没有可见行序号）——ADR 0007 §6.3 的"折叠隐藏的行不画其边"由此自然成立；
 * - 空汇总（没有任何叶子后代 ⇒ `summaryEs/ summaryEf` 仍是 `-1`）——没有可画的区间；
 * - 越界的 `docIndex`。
 *
 * 里程碑的判别式：**非汇总** 且（`milestone === true` ∨ `durationDays === 0` ∨ `ef <= es`）。
 * 第三项是防御性补足：`compute` 已保证叶子 `ef = es + 解析工期`，`ef <= es` 只在零时长时出现。
 */
export function taskBounds(args: TaskBoundsArgs): TaskBounds | null {
  const task = args.document.tasks[args.docIndex];
  if (task === undefined) return null;
  const row = args.rowOfDocIndex[args.docIndex] ?? -1;
  if (row < 0) return null; // 折叠隐藏 ⇒ 无边（ADR 0007 §6.3）

  const summary = (args.schedule.es[args.docIndex] ?? -1) === -1;
  const es = summary ? (args.schedule.summaryEs[args.docIndex] ?? -1) : (args.schedule.es[args.docIndex] ?? -1);
  const ef = summary ? (args.schedule.summaryEf[args.docIndex] ?? -1) : (args.schedule.ef[args.docIndex] ?? -1);
  if (es < 0 || ef < 0) return null; // 无叶子后代的空汇总：没有可画的条

  const rowHeight = args.rowHeight;
  const y = row * rowHeight + rowHeight / 2;
  const isMilestone = !summary && (task.milestone || (task.durationDays ?? 0) === 0 || ef <= es);

  if (isMilestone) {
    const cx = milestoneCenterX({
      calendar: args.calendar,
      es,
      axisOriginDay: args.axisOriginDay,
      pxPerDay: args.pxPerDay,
    });
    const size = rowHeight * SPACING.milestoneSizeRatio;
    return {
      docIndex: args.docIndex,
      row,
      kind: 'leaf',
      isMilestone: true,
      es,
      ef,
      xLeft: cx - size / 2,
      xRight: cx + size / 2,
      y,
      milestone: { cx, cy: y, size },
    };
  }

  const range = barXRange({
    calendar: args.calendar,
    es,
    ef,
    axisOriginDay: args.axisOriginDay,
    pxPerDay: args.pxPerDay,
  });
  return {
    docIndex: args.docIndex,
    row,
    kind: summary ? 'summary' : 'leaf',
    isMilestone: false,
    es,
    ef,
    xLeft: range.xLeft,
    xRight: range.xRight,
    y,
    milestone: null,
  };
}

/** 默认行高（几何糖：调用方通常直接用 `ROW_HEIGHT`）。 */
export const DEFAULT_ROW_HEIGHT = ROW_HEIGHT;
