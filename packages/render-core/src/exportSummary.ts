/**
 * 模板 A 的**自动摘要**与**图例数据**（ADR 0010 §7）。纯函数、零 DOM，**进 `pnpm gate`**。
 *
 * 为什么它住在 `render-core` 而不是 `pptx-renderer`：**两个消费者**——PPTX 模板 A 与
 * SVG/PNG 的"含图例与摘要"开关（用户可选）。放进 `pptx-renderer` 会让 `apps/web` 为了一张图例
 * 去 import 整个 OOXML 写出器；放进 `apps/web` 则进不了门禁（`apps/web` 没有判据入口，P-19/P-24）。
 *
 * ## 完成率必须与引擎**同一公式**（否则同一个数字有两个口径）
 *
 * 引擎的汇总进度口径是"**按工期加权**、`progress === null` 按 0 计"
 * （`schedule.ts`：叶子 `weight = duration`、`weightedProgress = duration × (progress ?? 0)`；
 * 汇总 `ΣweightedProgress / Σweight`）。项目级完成率就是"把整篇叶子当一棵树"的同一式子：
 *
 * ```
 * completionRatio = Σ_leaf (duration × (progress ?? 0)) / Σ_leaf duration      // 分母 0 ⇒ null（显示「—」）
 * ```
 *
 * 其中 `duration` **取排程的解析工期** `ef − es`（而不是 `tasks[].durationDays`）——
 * 这正是引擎 `duration[]` 的含义（`ef = es + 解析工期`，SCHEDULE.md §九 不变量 1），
 * 因此"有日期没工期"这类任务不会被漏算。这一条由 spec 与引擎的 `summaryProgress` **互证**。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import { EXPORT_MILESTONE_LIST_MAX } from './exportView.js';
import { isoOfOrdinalSafe } from './viewText.js';

/** 里程碑清单的一项。 */
export interface ExportMilestone {
  readonly id: string;
  readonly outlineNumber: string;
  readonly name: string;
  /** 里程碑所在工作日（`isoOfOrdinalSafe`；序号越界时为 `''`）。 */
  readonly dateIso: string;
  /** 排程序号（排序用；-1 = 未定位）。 */
  readonly ordinal: number;
}

/** 模板 A 的摘要数据。 */
export interface ExportSummary {
  readonly taskCount: number;
  readonly linkCount: number;
  /** 里程碑数（**直接用引擎的 `schedule.milestoneCount`**，不自己重数一遍）。 */
  readonly milestoneCount: number;
  /** 完成率 `[0,1]`；`null` = 全部工期为 0（无权重），显示为「—」。 */
  readonly completionRatio: number | null;
  /** 里程碑清单，按（排程序号, WBS）升序；**未截断**（截断是呈现层的事，上限见 `EXPORT_MILESTONE_LIST_MAX`）。 */
  readonly milestones: readonly ExportMilestone[];
}

/** {@link exportSummaryOf} 的入参。 */
export interface ExportSummaryArgs {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  /** **必须**是 `createScheduleCalendar(document)`。 */
  readonly calendar: Calendar;
}

/** 模板 A 的自动摘要（ADR 0010 §7）。 */
export function exportSummaryOf(args: ExportSummaryArgs): ExportSummary {
  const { document, schedule, calendar } = args;

  let weightSum = 0;
  let progressSum = 0;
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task === undefined) continue;
    const es = schedule.es[index] ?? -1;
    const ef = schedule.ef[index] ?? -1;
    // `es === -1` 是**唯一**的汇总判别式（`ViewModel` 与引擎共用这一条，ADR 0007 铁律 3）。
    if (es === -1 || ef === -1) continue;
    const duration = ef - es;
    weightSum += duration;
    progressSum += duration * (task.progress ?? 0);
  }

  const milestones: ExportMilestone[] = [];
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task === undefined || !task.milestone) continue;
    const ordinal = schedule.es[index] ?? -1;
    milestones.push({
      id: task.id,
      outlineNumber: task.outlineNumber,
      name: task.name,
      dateIso: ordinal >= 0 ? (isoOfOrdinalSafe(calendar, ordinal) ?? '') : '',
      ordinal,
    });
  }
  milestones.sort((left, right) => {
    if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
    return left.outlineNumber.localeCompare(right.outlineNumber, 'zh-Hans-CN');
  });

  return {
    taskCount: document.tasks.length,
    linkCount: document.links.length,
    milestoneCount: schedule.milestoneCount,
    completionRatio: weightSum > 0 ? progressSum / weightSum : null,
    milestones,
  };
}

/** 图例的一项（呈现层把 `styleKey` 映射成自己的画法；数据只有"是什么"）。 */
export interface ExportLegendItem {
  readonly styleKey: 'bar' | 'bar-summary' | 'milestone' | 'edge-FS' | 'edge-SS' | 'edge-FF' | 'edge-SF';
  readonly label: string;
}

/**
 * 图例条目（ADR 0010 §7）：条 / 汇总条 / 里程碑 / 四类依赖。
 *
 * **只出枚举，不出颜色**——颜色是各渲染器的样式常量（SVG 与 PPTX 各有一套同源取值），
 * 这里定的是"图例里有哪几项、叫什么"。
 */
export function exportLegendItems(): readonly ExportLegendItem[] {
  return [
    { styleKey: 'bar', label: '任务' },
    { styleKey: 'bar-summary', label: '阶段汇总' },
    { styleKey: 'milestone', label: '里程碑' },
    { styleKey: 'edge-FS', label: '完成 → 开始（FS）' },
    { styleKey: 'edge-SS', label: '开始 → 开始（SS）' },
    { styleKey: 'edge-FF', label: '完成 → 完成（FF）' },
    { styleKey: 'edge-SF', label: '开始 → 完成（SF）' },
  ];
}

/**
 * 完成率的显示文本（`null` ⇒ `—`；否则四舍五入到整数百分比）。
 *
 * 与 `viewText.ts` 的 `formatProgress` 同形（`82%`），供摘要与图例共用。
 */
export function formatCompletionRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${String(Math.round(value * 100))}%`;
}

/** 摘要的**文本行**（SVG 与 PPTX 必须逐字相同 ⇒ 只在这里生成一次）。 */
export interface ExportSummaryLines {
  /** 两行统计：`任务 N · 依赖 N`、`里程碑 N 个 · 完成率 X%`。 */
  readonly headline: readonly string[];
  /** 里程碑清单（已按上限截断；超出时最后一行是 `…共 N 个`）。 */
  readonly milestones: readonly string[];
}

/**
 * 由摘要数据生成**文本行**（ADR 0010 §7）。
 *
 * 为什么单独抽出来：人工复验第 4 条指出"图例摘要和 SVG/PNG 内容不一致"——
 * 根源是两处渲染器各写了一遍文案。文案属于**契约**，只准有一处。
 */
export function exportSummaryLines(
  summary: ExportSummary,
  maxMilestones = EXPORT_MILESTONE_LIST_MAX,
): ExportSummaryLines {
  const headline = [
    `任务 ${String(summary.taskCount)} · 依赖 ${String(summary.linkCount)}`,
    `里程碑 ${String(summary.milestoneCount)} 个 · 完成率 ${formatCompletionRatio(summary.completionRatio)}`,
  ];
  const shown = summary.milestones.slice(0, Math.max(0, maxMilestones));
  const milestones = shown.map((item) => `${item.outlineNumber} ${item.name} · ${item.dateIso}`);
  if (summary.milestones.length > shown.length) {
    milestones.push(`…共 ${String(summary.milestones.length)} 个`);
  }
  return { headline, milestones };
}
