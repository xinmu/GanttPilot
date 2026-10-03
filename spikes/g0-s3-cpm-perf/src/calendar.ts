/**
 * 工作日历与日期算术（零 DOM、零框架、零依赖）。
 *
 * 语义基准（裁决 D-4 / R-1）：
 * - 日期一律以「项目时区的日期」为准（无时刻、无时区漂移），内部表示为 **UTC 日序号**
 *   （1970-01-01 = 0），对外的可读形态是 ISO 日期字符串 `YYYY-MM-DD`；
 * - 工期、lag、浮动一律以**工作日**为单位；
 * - 默认工作日历 = 周一至周五；`exceptions` 表达「工作日→非工作日」与「休息日→工作日」两类覆盖
 *   （DM-06：`calendars[]` 字段保留，v0.1 仅项目日历生效）。
 *
 * 本文件提供**两套同接口实现**，用途不同：
 * - `IndexedCalendar`：前缀和 + 序号表，查询 O(1)，是 CPM 内核与"方案 A"的口径；
 * - `LoopCalendar`：逐日循环，语义上对齐 `packages/engine/src/date.ts` 的
 *   `countWorkdays`（当前主干实现），是"方案 B"，同时充当**常数因子负向对照**与**互证**手段。
 *
 * 序号约定（与主干 `countWorkdays(start, end)` 半开区间语义自洽）：
 * `ordinalOfDay(d)` = 严格早于 `d` 的工作日数量。于是
 * `workdaysBetween(start, end) === ordinalOfDay(end) - ordinalOfDay(start)`。
 */

import type { CalendarSpec } from './model.ts';

export type { CalendarSpec };

export const MS_PER_DAY = 86_400_000;

/** CPM 内部的最小/最大可用序号（防溢出哨兵）。 */
export const HORIZON_GUARD_DAYS = 4_000_000;

export function isoToDayNumber(iso: string): number {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (matched === null) {
    throw new RangeError(`非法 ISO 日期：${JSON.stringify(iso)}（要求 YYYY-MM-DD）`);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`非法 ISO 日期：${iso}（该日期在日历上不存在）`);
  }
  return timestamp / MS_PER_DAY;
}

export function dayNumberToIso(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 星期（0=周日 … 6=周六），与 `Date#getUTCDay()` 同口径。 */
export function weekdayOf(day: number): number {
  return new Date(day * MS_PER_DAY).getUTCDay();
}

export interface Calendar {
  readonly id: string;
  readonly baseDay: number;
  /** 本日历可表达的工作日总数（合法序号区间为 `[0, workdayCount]`）。 */
  readonly workdayCount: number;
  isWorkday(day: number): boolean;
  ordinalOfDay(day: number): number;
  dayOfOrdinal(k: number): number;
  workdaysBetween(startDay: number, endDayExclusive: number): number;
  isoOfOrdinal(k: number): string;
}

/**
 * 依据「需要多少个工作日」估算地平线天数。
 *
 * 以「一周内的工作日数」为上界：`workDays` 为 5 天时 1 个工作日最多摊到 1.4 个自然日；
 * 再加 60 天缓冲吸收 `exceptions`（假期会把工作日继续向后推）。
 */
export function horizonDaysFor(neededWorkdays: number, spec: CalendarSpec): number {
  const perWeek = Math.max(1, spec.workDays.length);
  const natural = Math.ceil((Math.max(0, neededWorkdays) * 7) / perWeek) + 60;
  return Math.min(HORIZON_GUARD_DAYS, natural);
}

/** 前缀和 + 序号表的 O(1) 日历。 */
export class IndexedCalendar implements Calendar {
  readonly id: string;
  readonly baseDay: number;
  readonly workdayCount: number;

  /** `mask[i]` = baseDay + i 是否为工作日。 */
  private readonly mask: Uint8Array;
  /** `prefix[i]` = [baseDay, baseDay + i) 内的工作日数。 */
  private readonly prefix: Int32Array;
  /** `ordinalToDay[k]` = 第 k 个工作日（0 基）。 */
  private readonly ordinalToDay: Int32Array;
  private readonly isWorkdayFn: (day: number) => boolean;

  constructor(spec: CalendarSpec, baseDay: number, days: number) {
    if (!Number.isInteger(days) || days <= 0) {
      throw new RangeError(`地平线天数必须为正整数，收到 ${String(days)}`);
    }
    this.id = spec.id;
    this.baseDay = baseDay;
    this.mask = new Uint8Array(days);
    this.prefix = new Int32Array(days + 1);
    const isWorkday = makeWorkdayPredicate(spec);
    this.isWorkdayFn = isWorkday;
    let count = 0;
    for (let i = 0; i < days; i += 1) {
      if (isWorkday(baseDay + i)) {
        this.mask[i] = 1;
        count += 1;
      }
      this.prefix[i + 1] = count;
    }
    this.workdayCount = count;
    const ordinalToDay = new Int32Array(count);
    let cursor = 0;
    for (let i = 0; i < days; i += 1) {
      if (this.mask[i] === 1) {
        ordinalToDay[cursor] = baseDay + i;
        cursor += 1;
      }
    }
    this.ordinalToDay = ordinalToDay;
  }

  isWorkday(day: number): boolean {
    const i = day - this.baseDay;
    return i >= 0 && i < this.mask.length && this.mask[i] === 1;
  }

  ordinalOfDay(day: number): number {
    const i = day - this.baseDay;
    if (i < 0) {
      throw new RangeError(`日期 ${dayNumberToIso(day)} 早于地平线起点 ${dayNumberToIso(this.baseDay)}`);
    }
    if (i > this.mask.length) {
      throw new RangeError(`日期 ${dayNumberToIso(day)} 超出地平线（${String(this.mask.length)} 天）`);
    }
    return this.prefix[i]!;
  }

  dayOfOrdinal(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k > this.workdayCount) {
      throw new RangeError(`工作日序号越界：${String(k)}（合法范围 0..${String(this.workdayCount)}）`);
    }
    if (k === this.workdayCount) {
      // EF 落在项目末尾时的「排他结束日」：**最后一个工作日之后的首个工作日**。
      // 该约定与地平线长度无关（否则差分测试会因容量差异而假失败）。
      for (let cursor = this.baseDay + this.mask.length; ; cursor += 1) {
        if (this.isWorkdayFn(cursor)) {
          return cursor;
        }
      }
    }
    return this.ordinalToDay[k]!;
  }

  workdaysBetween(startDay: number, endDayExclusive: number): number {
    return this.ordinalOfDay(endDayExclusive) - this.ordinalOfDay(startDay);
  }

  isoOfOrdinal(k: number): string {
    return dayNumberToIso(this.dayOfOrdinal(k));
  }
}

/**
 * 逐日循环的日历：语义与主干 `countWorkdays` 对齐，但每次查询都是 O(天数)。
 *
 * 它同时是：
 * - 互证手段（与 `IndexedCalendar` 在小规模用例上必须逐项一致）；
 * - 常数因子负向对照 NC1（若两套实现的耗时差 < 3×，说明计时骨架无判别力）。
 */
export class LoopCalendar implements Calendar {
  readonly id: string;
  readonly baseDay: number;
  readonly workdayCount: number;

  private readonly isWorkdayFn: (day: number) => boolean;

  constructor(spec: CalendarSpec, baseDay: number, days: number) {
    if (!Number.isInteger(days) || days <= 0) {
      throw new RangeError(`地平线天数必须为正整数，收到 ${String(days)}`);
    }
    this.id = spec.id;
    this.baseDay = baseDay;
    this.isWorkdayFn = makeWorkdayPredicate(spec);
    let count = 0;
    for (let i = 0; i < days; i += 1) {
      if (this.isWorkdayFn(baseDay + i)) {
        count += 1;
      }
    }
    this.workdayCount = count;
  }

  isWorkday(day: number): boolean {
    return this.isWorkdayFn(day);
  }

  ordinalOfDay(day: number): number {
    if (day < this.baseDay) {
      throw new RangeError(`日期 ${dayNumberToIso(day)} 早于地平线起点 ${dayNumberToIso(this.baseDay)}`);
    }
    let count = 0;
    for (let cursor = this.baseDay; cursor < day; cursor += 1) {
      if (this.isWorkdayFn(cursor)) {
        count += 1;
      }
    }
    return count;
  }

  dayOfOrdinal(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k > this.workdayCount) {
      throw new RangeError(`工作日序号越界：${String(k)}（合法范围 0..${String(this.workdayCount)}）`);
    }
    let remaining = k;
    for (let cursor = this.baseDay; cursor < this.baseDay + HORIZON_GUARD_DAYS; cursor += 1) {
      if (this.isWorkdayFn(cursor)) {
        if (remaining === 0) {
          return cursor;
        }
        remaining -= 1;
      }
    }
    throw new RangeError(`工作日序号 ${String(k)} 超出逐日循环的搜索上限`);
  }

  workdaysBetween(startDay: number, endDayExclusive: number): number {
    return this.ordinalOfDay(endDayExclusive) - this.ordinalOfDay(startDay);
  }

  isoOfOrdinal(k: number): string {
    return dayNumberToIso(this.dayOfOrdinal(k));
  }
}

export type CalendarKind = 'indexed' | 'loop';

export function createCalendar(
  kind: CalendarKind,
  spec: CalendarSpec,
  baseDay: number,
  days: number,
): Calendar {
  return kind === 'indexed'
    ? new IndexedCalendar(spec, baseDay, days)
    : new LoopCalendar(spec, baseDay, days);
}

/** 把 `workDays` + `exceptions` 编译成一个 O(1) 判定函数。 */
function makeWorkdayPredicate(spec: CalendarSpec): (day: number) => boolean {
  const workDays = new Set(spec.workDays);
  const nonWorking = new Set(spec.exceptions.nonWorking);
  const working = new Set(spec.exceptions.working);
  for (const candidate of workDays) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > 6) {
      throw new RangeError(`workDays 含非法日序号：${String(candidate)}（要求 0–6 的整数）`);
    }
  }
  return (day: number): boolean => {
    if (nonWorking.has(day)) {
      return false;
    }
    if (working.has(day)) {
      return true;
    }
    return workDays.has(weekdayOf(day));
  };
}
