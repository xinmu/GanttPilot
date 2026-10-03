/**
 * 应用侧的小工具：日期算术只经引擎（**不自己写一套**，CONTRIBUTING 铁律），
 * 列格式化只读 `Schedule`/文档，不重复聚合。
 */

import { Calendar, dayNumberToIsoDate, isoDateToDayNumber } from '@ganttpilot/engine';
import type { ProjectDocument, Schedule } from '@ganttpilot/engine';
import { COLUMN_SPECS, type ColumnKey } from '@ganttpilot/xlsx-protocol';

/** 应用层唯一的项目日历（缺省工作日：周一至周五 8h，R-1：v0.1 只有项目日历生效）。 */
export const APP_CALENDAR = new Calendar({ id: 'project', exceptions: { nonWorking: [], working: [] } });

/** 日序号 → ISO；非法输入返回 `undefined`（界面显示占位，不抛错）。 */
export function isoOfDaySafe(day: number): string | undefined {
  if (!Number.isFinite(day)) return undefined;
  try {
    return dayNumberToIsoDate(day);
  } catch {
    return undefined;
  }
}

/** ISO → 日序号；非法输入返回 `undefined`。 */
export function dayOfIsoSafe(iso: string | null | undefined): number | undefined {
  if (iso === null || iso === undefined || iso.trim() === '') return undefined;
  try {
    return isoDateToDayNumber(iso.trim());
  } catch {
    return undefined;
  }
}

/**
 * 解析用户输入的 ISO 日期；只有 `YYYY-MM-DD` 且真实存在才返回字符串。
 *
 * 用引擎的 `isoDateToDayNumber` 往返一次做校验——**不自己写正则**，
 * 这样"导入能识别的日期"与"行内编辑能接受的日期"不会分叉。
 */
export function parseIsoInput(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const day = dayOfIsoSafe(trimmed);
  if (day === undefined) return undefined;
  const normalized = isoOfDaySafe(day);
  if (normalized === undefined || normalized !== trimmed) return undefined;
  return normalized;
}

/** 解析工期（正整数工作日，含 0；越界按 `MAX_DURATION_DAYS` 拒绝）。 */
export function parseIntInput(text: string, options: { readonly min?: number; readonly max?: number } = {}): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return undefined;
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) return undefined;
  return value;
}

/** 进度：接受 `0`–`1` 的小数或 `0`–`100` 的百分数文本；归一为 0–1。 */
export function parseProgressInput(text: string): number | undefined {
  const trimmed = text.trim().replace(/%$/, '');
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const ratio = value > 1 ? value / 100 : value;
  if (ratio > 1) return undefined;
  return Math.round(ratio * 100) / 100;
}

/** 百分比显示（`null` 显示空）。 */
export function formatProgress(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '';
  return `${String(Math.round(ratio * 100))}%`;
}

/** 任务字段的列集合（锚 G3 的 9 列契约，**列序与表头都从这里取**）。 */
export const TABLE_COLUMNS: readonly { readonly key: ColumnKey; readonly header: string; readonly editable: boolean }[] =
  COLUMN_SPECS.map((spec) => ({
    key: spec.key,
    header: spec.header,
    // 行内编辑只走 `task.update`；`wbs` 是派生值、`predecessors` 归 G5 的建线/改边。
    editable: ['name', 'start', 'end', 'duration', 'progress', 'milestone', 'notes'].includes(spec.key),
  }));

/**
 * 单元格显示值（只读呈现；不聚合任何派生量）。
 *
 * `start` / `end` 取**文档字段**：`end` 为空时显示派生显示值"开始 + 工期"，
 * 并加 `≈` 前缀提示它不是文档里的字段（`endDate` 是派生显示值，SCHEDULE.md §四.2）。
 */
export function cellText(args: {
  readonly key: ColumnKey;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly docIndex: number;
}): { readonly text: string; readonly derived: boolean } {
  const task = args.document.tasks[args.docIndex];
  if (task === undefined) return { text: '', derived: false };
  const es = args.schedule.es[args.docIndex] ?? -1;
  const ef = args.schedule.ef[args.docIndex] ?? -1;
  const summaryEs = args.schedule.summaryEs[args.docIndex] ?? -1;
  const summaryEf = args.schedule.summaryEf[args.docIndex] ?? -1;
  const isSummary = es === -1;

  switch (args.key) {
    case 'wbs':
      return { text: task.outlineNumber, derived: true };
    case 'name':
      return { text: task.name, derived: false };
    case 'start': {
      if (isSummary) {
        const iso = summaryEs >= 0 ? isoOfDaySafe(APP_CALENDAR.dayOfOrdinal(summaryEs)) : undefined;
        return { text: iso ?? '', derived: true };
      }
      if (task.startDate !== null) return { text: task.startDate, derived: false };
      const iso = es >= 0 ? isoOfDaySafe(APP_CALENDAR.dayOfOrdinal(es)) : undefined;
      return { text: iso ?? '', derived: true };
    }
    case 'end': {
      if (isSummary) {
        const iso = summaryEf > 0 ? isoOfDaySafe(APP_CALENDAR.dayOfOrdinal(summaryEf - 1)) : undefined;
        return { text: iso ?? '', derived: true };
      }
      if (task.endDate !== null) return { text: task.endDate, derived: false };
      if (ef > 0 && task.durationDays !== null) {
        const iso = isoOfDaySafe(APP_CALENDAR.dayOfOrdinal(ef - 1));
        return { text: iso === undefined ? '' : `≈${iso}`, derived: true };
      }
      return { text: '', derived: true };
    }
    case 'duration':
      return { text: task.durationDays === null ? '' : String(task.durationDays), derived: false };
    case 'predecessors': {
      const text = args.document.links
        .filter((link) => link.to === task.id)
        .map((link) => {
          const from = args.document.tasks.find((item) => item.id === link.from);
          const lag = link.lagDays === 0 ? '' : link.lagDays > 0 ? `+${String(link.lagDays)}` : String(link.lagDays);
          return `${from?.outlineNumber ?? link.from}${link.type === 'FS' ? '' : link.type}${lag}`;
        })
        .join('; ');
      return { text, derived: true };
    }
    case 'progress':
      return { text: formatProgress(task.progress), derived: false };
    case 'milestone':
      return { text: task.milestone ? '是' : '否', derived: false };
    case 'notes':
      return { text: task.notes ?? '', derived: false };
    default:
      return { text: '', derived: false };
  }
}
