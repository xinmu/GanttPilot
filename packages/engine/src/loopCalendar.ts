/**
 * 逐日循环日历（**测试侧**的独立实现，不是产品代码）。
 *
 * 用途有两个，都与 G1.1 的出口条件绑定：
 * 1. **互证**：与 `Calendar`（索引前缀和）在同一批日期/序号查询上必须逐项一致——
 *    这是 G1.1「索引前缀和与逐日循环两套实现互证一致」的证据来源；
 * 2. **常数因子对照**：算法刻意写"笨"（`ordinalOfDay` 逐日累加、`dayOfOrdinal` 逐日扫描），
 *    是 S3 结论 §三.4 NC1（索引日历 vs 逐日循环，实测 2,360×）在主干的对应物。
 *
 * 它与 `Calendar` **只共享规格校验、不共享任何索引算法**——否则互证就是恒真式。
 * 本文件**不经 `index.ts` 导出**：它不是公共 API，只是验证手段。
 */

import {
  type CalendarLike,
  type CalendarSpec,
  type DayNumber,
  dayNumberToIso,
  DEFAULT_WORK_DAYS,
  isoToDayNumber,
  weekdayOf,
  type WorkdayCount,
} from './date.js';

const DAYS_IN_WEEK = 7;

/** 逐日扫描的搜索上限（防病态日历导致死循环）。 */
const SCAN_LIMIT_DAYS = 4_000_000;

/** 抛出 `RangeError`（`never` 返回类型让构造函数里的校验不干扰字段的确定性赋值分析）。 */
function fail(message: string): never {
  throw new RangeError(message);
}

function assertWorkDays(workDays: readonly number[]): readonly number[] {
  if (workDays.length === 0) {
    return fail('workDays 为空：至少需要一个工作日（如默认的周一至周五）');
  }
  for (const candidate of workDays) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > DAYS_IN_WEEK - 1) {
      return fail(`workDays 含非法日序号：${String(candidate)}（要求 0–6 的整数）`);
    }
  }
  return workDays;
}

/**
 * 逐日循环的日历实现。
 *
 * 序号锚点与 `Calendar` 完全一致：`ordinalOfDay(d)` = `[baseDay, d)` 内的工作日数，
 * `dayOfOrdinal(k)` = `baseDay` 起的第 k 个工作日。
 */
export class LoopCalendar implements CalendarLike {
  readonly id: string;
  readonly baseDay: DayNumber;
  readonly spanDays: number;
  readonly workdayCount: number;

  private readonly workDays: readonly number[];
  private readonly nonWorking: ReadonlySet<DayNumber>;
  private readonly working: ReadonlySet<DayNumber>;

  constructor(spec: CalendarSpec = {}, options: { baseDay?: DayNumber; spanDays?: number } = {}) {
    const baseDay = options.baseDay ?? isoToDayNumber('2025-01-01');
    const spanDays = options.spanDays ?? 1460;
    if (!Number.isInteger(spanDays) || spanDays <= 0) {
      fail(`地平线天数必须为正整数，收到 ${String(spanDays)}`);
    }
    const workDays = assertWorkDays(spec.workDays ?? DEFAULT_WORK_DAYS);
    const nonWorkingDays = (spec.exceptions?.nonWorking ?? []).map((iso) => isoToDayNumber(iso));
    const nonWorking = new Set(nonWorkingDays);
    const working = new Set(
      (spec.exceptions?.working ?? [])
        .map((iso) => isoToDayNumber(iso))
        // 「非工作日优先」：同日冲突时从 working 里剔除，与 `Calendar` 同口径。
        .filter((day) => !nonWorking.has(day)),
    );

    this.id = spec.id ?? 'project';
    this.baseDay = baseDay;
    this.spanDays = spanDays;
    this.workDays = workDays;
    this.nonWorking = nonWorking;
    this.working = working;

    let count = 0;
    for (let day = baseDay; day < baseDay + spanDays; day += 1) {
      if (this.isWorkday(day)) {
        count += 1;
      }
    }
    this.workdayCount = count;
  }

  /** 精确复刻 S3 验证集里 `CalendarLike` 的参数类型（含 `WorkdayCount | number`）。 */
  isWorkday(day: DayNumber): boolean {
    if (this.nonWorking.has(day)) {
      return false;
    }
    if (this.working.has(day)) {
      return true;
    }
    return this.workDays.includes(weekdayOf(day));
  }

  ordinalOfDay(day: DayNumber): WorkdayCount {
    if (day < this.baseDay) {
      return fail(`日期 ${dayNumberToIso(day)} 早于地平线起点 ${dayNumberToIso(this.baseDay)}`);
    }
    let count = 0;
    for (let cursor = this.baseDay; cursor < day; cursor += 1) {
      if (this.isWorkday(cursor)) {
        count += 1;
      }
    }
    return count as WorkdayCount;
  }

  dayOfOrdinal(ordinal: WorkdayCount | number): DayNumber {
    const k = ordinal as number;
    if (!Number.isInteger(k) || k < 0 || k > this.workdayCount) {
      return fail(`工作日序号越界：${String(k)}（合法范围 0..${String(this.workdayCount)}）`);
    }
    // 逐日扫描到第 k 个工作日；k === workdayCount 时自然落在「最后一个工作日之后的首个工作日」，
    // 与 `Calendar` 的边界语义相同（这是互证能覆盖 `k = workdayCount` 的前提）。
    let remaining = k;
    for (let cursor = this.baseDay; cursor < this.baseDay + SCAN_LIMIT_DAYS; cursor += 1) {
      if (this.isWorkday(cursor)) {
        if (remaining === 0) {
          return cursor;
        }
        remaining -= 1;
      }
    }
    return fail(`工作日序号 ${String(k)} 超出逐日循环的搜索上限`);
  }

  /** 与 `Calendar.workdaysBetween` 同口径：区间为空或倒置时返回 0。 */
  workdaysBetween(startDay: DayNumber, endDayExclusive: DayNumber): WorkdayCount {
    if (endDayExclusive <= startDay) {
      return 0 as WorkdayCount;
    }
    return (this.ordinalOfDay(endDayExclusive) -
      this.ordinalOfDay(startDay)) as WorkdayCount;
  }

  isoOfOrdinal(ordinal: WorkdayCount | number): string {
    return dayNumberToIso(this.dayOfOrdinal(ordinal));
  }
}
