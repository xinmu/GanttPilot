/**
 * 日期算术内核（零 DOM、零框架依赖）。
 *
 * 语义基准（裁决 D-4 / R-1）：
 * - 日期以「项目时区的日期」为准，无时刻、无时区漂移，故一律用 ISO 日期字符串（`YYYY-MM-DD`）
 *   表示，内部按 UTC 日序号做整数运算；
 * - 工期与 lag 一律按**工作日**计；
 * - 默认工作日历 = 周一至周五（`DEFAULT_WORK_DAYS`）。
 *
 * 区间约定：`[startIso, endIsoExclusive)` —— 半开区间，起算日计入、结束日不计入。
 * 该约定与「工期 = 结束日 - 开始日（工作日）」自洽，使 G2 的 `EF = ES + duration` 可直接成立。
 */

/** 工作日计数（品牌类型，避免与普通数字混淆）。 */
export type WorkdayCount = number & { readonly __workdayCount: unique symbol };

/** 默认工作日历：周一至周五（`Date#getUTCDay()` 口径：0=周日 … 6=周六）。 */
export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5] as const;

/** 一周七天的日序号取值范围（用于校验外部传入的 `workDays`）。 */
const DAYS_IN_WEEK = 7;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * 解析 ISO 日期（`YYYY-MM-DD`）为 UTC 毫秒时间戳。
 *
 * 只接受严格格式：不接受时刻、不接受时区后缀——日期语义必须无歧义。
 * @throws RangeError 格式非法或该日期在日历上不存在（如 `2025-02-30`）。
 */
export function parseIsoDate(iso: string): number {
  const matched = ISO_DATE_PATTERN.exec(iso);
  if (matched === null) {
    throw new RangeError(`非法 ISO 日期：${JSON.stringify(iso)}（要求 YYYY-MM-DD）`);
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  // 反查：捕捉 2025-02-30 这类被 Date 静默滚动的非法日期。
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`非法 ISO 日期：${iso}（该日期在日历上不存在）`);
  }

  return timestamp;
}

/**
 * 判断给定时刻是否为工作日。
 *
 * @param timestampUtcMs UTC 毫秒时间戳
 * @param workDays 工作日日序号集合（0=周日 … 6=周六）
 * @throws RangeError `workDays` 含非 0–6 的整数
 */
export function isWorkday(timestampUtcMs: number, workDays: readonly number[] = DEFAULT_WORK_DAYS): boolean {
  const day = new Date(timestampUtcMs).getUTCDay();
  for (const candidate of workDays) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > DAYS_IN_WEEK - 1) {
      throw new RangeError(`workDays 含非法日序号：${String(candidate)}（要求 0–6 的整数）`);
    }
    if (candidate === day) {
      return true;
    }
  }
  return false;
}

/**
 * 统计半开区间 `[startIso, endIsoExclusive)` 内的工作日数量。
 *
 * - 区间为空（`end <= start`）或倒置时返回 0（不做负向推进——负向推进属 G2 的传播语义）；
 * - 起算日计入、结束日不计入，故「周一起算、工期 5 个工作日」的结束日为下周一，
 *   与本函数 `countWorkdays('2025-01-06', '2025-01-13') === 5` 自洽。
 *
 * @throws RangeError 日期格式非法，或 `workDays` 含非法日序号
 */
export function countWorkdays(
  startIso: string,
  endIsoExclusive: string,
  workDays: readonly number[] = DEFAULT_WORK_DAYS,
): WorkdayCount {
  const startMs = parseIsoDate(startIso);
  const endMs = parseIsoDate(endIsoExclusive);

  if (endMs <= startMs) {
    return 0 as WorkdayCount;
  }

  let count = 0;
  for (let cursor = startMs; cursor < endMs; cursor += MS_PER_DAY) {
    if (isWorkday(cursor, workDays)) {
      count += 1;
    }
  }
  return count as WorkdayCount;
}
