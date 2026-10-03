/**
 * 日期算术内核（零 DOM、零框架依赖）。
 *
 * 语义基准（裁决 D-4 / R-1 / P-10）：
 * - 日期以「项目时区的日期」为准，无时刻、无时区漂移——一律用 ISO 日期字符串（`YYYY-MM-DD`）
 *   表示，内部按 **UTC 日序号**（`1970-01-01 = 0`）做整数运算；
 * - 工期、lag、浮动一律按**工作日**计；
 * - 默认工作日历 = 周一至周五（`DEFAULT_WORK_DAYS`）；
 * - `exceptions` 表达「工作日→非工作日」与「休息日→工作日」两类覆盖，
 *   **同日冲突时非工作日优先**（DM-06；v0.1 仅项目日历生效）。
 *
 * 区间约定：`[start, end)` —— 半开区间，起算日计入、结束日不计入。
 * 该约定与「工期 = 结束日 - 开始日（工作日）」自洽，使 G2 的 `EF = ES + duration` 可直接成立。
 *
 * ## 为什么要有工作日序号
 *
 * [G0-S-S3 结论 §五.1](../../../spikes/g0-s3-cpm-perf/结论.md) 的架构结论是：
 * 日期一旦用**工作日序号（整数）**承载，传播就是纯整数加法/比较，`Date` 只出现在
 * 「序号 ↔ 日期」翻译时——日历因此**不进入传播热路径**。代价是这份翻译必须做快：
 * 本文件用**索引前缀和 + 序号表**把它做成 O(1)（`Calendar`），
 * 而主干原来的逐日循环 `countWorkdays` 在同一工作负载上慢约 **340×**（S3 §五.5）。
 *
 * ## 序号的锚点（本块冻结的口径）
 *
 * 序号**相对 `Calendar` 的 `baseDay`（地平线起点）**计数，而不是相对 1970-01-01：
 * - `ordinalOfDay(d)` = `[baseDay, d)` 内的工作日数量（d 为工作日时即该工作日的 0 基序号）；
 * - `dayOfOrdinal(0)` = `baseDay` 当天或之后的**首个工作日**；
 * - `workdaysBetween(a, b) === ordinalOfDay(b) - ordinalOfDay(a)`。
 *
 * 于是序号区间与旧 API 的 ISO 半开区间是同一个东西，`countWorkdays` 可直接等价转换。
 * **负数序号无定义**：负向推进只允许落到 `>= 0`，越界抛 `RangeError`（截断属 G2 的
 * `clampedStarts` 语义，见 S3 §五.4）。
 *
 * ## 地平线（容量）
 *
 * 索引只覆盖 `[baseDay, baseDay + spanDays]`：`exceptions` 与稀疏 `workDays` 使「周内算术」
 * 无法闭式表达，前缀和是唯一 O(1) 的路子。容量按「全部工期 + 正 lag」的上界规划
 * （`horizonDaysFor`），不足时用 `withHorizon()` 扩容重算（S3 §八 C.11）。
 */

/** 工作日计数（品牌类型，避免与普通数字混淆）。 */
export type WorkdayCount = number & { readonly __workdayCount: unique symbol };

/** UTC 日序号：`1970-01-01 = 0`（与 `parseIsoDate` 的毫秒口径整除一致）。 */
export type DayNumber = number;

/** 默认工作日历：周一至周五（`weekdayOf` 口径：0=周日 … 6=周六）。 */
export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5] as const;

/** 默认地平线起点：序号 0 落在该日或其后的首个工作日。 */
export const DEFAULT_PROJECT_BASE_DAY_ISO = '2025-01-01';

/** 默认地平线长度（自然日，约 4 年 ≈ 1,043 个工作日）。 */
export const DEFAULT_HORIZON_DAYS = 1460;

/**
 * 地平线长度上限（自然日）。
 *
 * 取 1e7（约 2.7 万年）是为了让 `baseDay + span` 与 `Int32Array` 索引都远离
 * `2^31 - 1`，同时给容量规划一个明确的截断点——超出即说明调用方的容量规划本身有问题，
 * 应当抛错而不是静默分配几百 MB。
 */
export const HORIZON_GUARD_DAYS = 10_000_000;

/** 一周七天的日序号取值范围（用于校验外部传入的 `workDays`）。 */
const DAYS_IN_WEEK = 7;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** 公历年份的合法区间：超出即 `Date#toISOString()` 无法产出 `YYYY-MM-DD` 往返形态。 */
const MIN_YEAR = 0;
const MAX_YEAR = 9999;

// ---------------------------------------------------------------- 日期 ↔ 日序号

/**
 * 解析 ISO 日期（`YYYY-MM-DD`）为 **UTC 日序号**。
 *
 * 只接受严格格式：不接受时刻、不接受时区后缀——日期语义必须无歧义。
 * @throws RangeError 格式非法、年份越界（要求 0–9999），或该日期在日历上不存在（如 `2025-02-30`）
 */
export function isoToDayNumber(iso: string): DayNumber {
  const matched = ISO_DATE_PATTERN.exec(iso);
  if (matched === null) {
    throw new RangeError(`非法 ISO 日期：${JSON.stringify(iso)}（要求 YYYY-MM-DD）`);
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(
      `非法 ISO 日期：${iso}（年份要求 ${String(MIN_YEAR)}–${String(MAX_YEAR)}）`,
    );
  }

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

  return timestamp / MS_PER_DAY;
}

/** 把 UTC 日序号渲染为 ISO 日期（`YYYY-MM-DD`）。 */
export function dayNumberToIso(day: DayNumber): string {
  if (!Number.isInteger(day)) {
    throw new RangeError(`日序号不是整数：${String(day)}`);
  }
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * 解析 ISO 日期为 **UTC 毫秒时间戳**。
 *
 * @deprecated 仅保留给既有调用方与不变量断言；新代码请用 `Calendar`（工作日序号）
 * 或 `isoToDayNumber`——日期在编排逻辑里不应变成毫秒。
 * @throws RangeError 同 `isoToDayNumber`
 */
export function parseIsoDate(iso: string): number {
  return isoToDayNumber(iso) * MS_PER_DAY;
}

/** 星期（0=周日 … 6=周六），与 `Date#getUTCDay()` 同口径。 */
export function weekdayOf(day: DayNumber): number {
  // Howard Hinnant 的 `weekday_from_days`：1970-01-01（day 0）为周四，故以 4 为基准。
  // 双重取模使负数日序号同样得到 0–6 的正值。
  const dayNumber = assertDayNumber(day, 'weekdayOf 的 day');
  return (((dayNumber + 4) % DAYS_IN_WEEK) + DAYS_IN_WEEK) % DAYS_IN_WEEK;
}

/** 日序号加减自然日。 */
export function addDays(day: DayNumber, deltaDays: number): DayNumber {
  return day + deltaDays;
}

/** 两个日序号之间的自然日差（`to - from`）。 */
export function diffDays(from: DayNumber, to: DayNumber): number {
  return to - from;
}

// ---------------------------------------------------------------- 日历规格

/** 日历例外（DM-06）：两个集合都用 ISO 日期字符串表达。 */
export interface CalendarExceptionsSpec {
  /** 「工作日 → 非工作日」，如法定假日。 */
  readonly nonWorking?: readonly string[];
  /** 「休息日 → 工作日」，如调休上班。 */
  readonly working?: readonly string[];
}

/**
 * 工作日历规格（DM-06）。
 *
 * **v0.1 仅项目日历生效**（R-1）：`calendars[]` 字段在文档 schema 中保留（G1.2），
 * 但引擎只使用项目日历这一份；`id` 仅供文档追溯。
 */
export interface CalendarSpec {
  /** 日历标识（文档追溯用；缺省 `'project'`）。 */
  readonly id?: string;
  /** 工作日：0=周日 … 6=周六；缺省 `DEFAULT_WORK_DAYS`（周一至周五）。 */
  readonly workDays?: readonly number[];
  readonly exceptions?: CalendarExceptionsSpec;
}

/** 日历查询的公共契约（供互证实现与调用方对齐形状）。 */
export interface CalendarLike {
  isWorkday(day: DayNumber): boolean;
  ordinalOfDay(day: DayNumber): WorkdayCount;
  dayOfOrdinal(ordinal: WorkdayCount | number): DayNumber;
  workdaysBetween(startDay: DayNumber, endDayExclusive: DayNumber): WorkdayCount;
  isoOfOrdinal(ordinal: WorkdayCount | number): string;
}

/** `Calendar` 的构造选项。 */
export interface CalendarOptions {
  /** 地平线起点（序号锚点）；缺省 `DEFAULT_PROJECT_BASE_DAY_ISO`。 */
  readonly baseDay?: DayNumber;
  /** 地平线长度（自然日，> 0）；缺省 `DEFAULT_HORIZON_DAYS`。 */
  readonly spanDays?: number;
}

/** 编译后的日历规格：热路径谓词 + 例外日序号列表（供区间修正）。 */
interface NormalizedCalendar {
  readonly id: string;
  readonly workDays: readonly number[];
  /** 周内规则（不含例外）：该日是否落在 `workDays` 里。 */
  isScheduledWorkday(day: DayNumber): boolean;
  /** 完整判定：**非工作日优先**（`nonWorking` 命中直接 false，再看 `working` 与周内规则）。 */
  isWorkday(day: DayNumber): boolean;
  /** 「工作日 → 非工作日」的日序号。 */
  readonly nonWorkingDays: readonly DayNumber[];
  /** 「休息日 → 工作日」的日序号（同日冲突时已剔除，故与上一项互斥）。 */
  readonly workingDays: readonly DayNumber[];
}

/**
 * 抛出 `RangeError`。
 *
 * 返回类型是 `never`，因此在构造函数里写 `return fail(...)` 能让 TS 的控制流分析
 * 认出「后面的属性赋值不会执行」——否则 `strictPropertyInitialization` 会对
 * `Calendar` 的每个字段报 TS2564。
 */
function fail(message: string): never {
  throw new RangeError(message);
}

/** 传进来的"日序号"必须是整数；NaN / 小数一律拒绝。 */
function assertDayNumber(day: number, label: string): DayNumber {
  if (Number.isInteger(day)) {
    return day;
  }
  return fail(`${label} 不是整数日序号：${String(day)}`);
}

/** 传进来的"工作日序号"必须是非负整数。 */
function assertOrdinal(ordinal: number, label: string): number {
  if (Number.isInteger(ordinal) && ordinal >= 0) {
    return ordinal;
  }
  return fail(`${label} 不是非负整数工作日序号：${String(ordinal)}`);
}

/** 校验并规范化 `workDays`（要求 0–6 的整数、至少一项）。 */
function assertWorkDays(workDays: readonly number[]): readonly number[] {
  if (workDays.length === 0) {
    return fail('workDays 为空：至少需要一个工作日（如默认的周一至周五）');
  }
  for (const candidate of workDays) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > DAYS_IN_WEEK - 1) {
      return fail(`workDays 含非法日序号：${String(candidate)}（要求 0–6 的整数）`);
    }
  }
  return [...new Set(workDays)].sort((left, right) => left - right);
}

/** 把 `exceptions` 的一个集合编译成去重的日序号列表。 */
function compileExceptionDays(dates: readonly string[] | undefined): DayNumber[] {
  if (dates === undefined) {
    return [];
  }
  return [...new Set(dates.map((iso) => isoToDayNumber(iso)))];
}

/**
 * 把 `CalendarSpec` 编译成判定闭包 + 例外日序号列表。
 *
 * 例外在这里已按「**非工作日优先**」去重（同日冲突时从 `working` 里剔除），
 * 因此热路径判定与区间修正都不会重复计数。
 */
function normalizeCalendarSpec(spec: CalendarSpec): NormalizedCalendar {
  const workDays = assertWorkDays(spec.workDays ?? DEFAULT_WORK_DAYS);
  const nonWorkingDays = compileExceptionDays(spec.exceptions?.nonWorking);
  const nonWorking = new Set(nonWorkingDays);
  const workingDays = compileExceptionDays(spec.exceptions?.working).filter(
    (day) => !nonWorking.has(day),
  );
  const working = new Set(workingDays);

  const isScheduledWorkday = (day: DayNumber): boolean => workDays.includes(weekdayOf(day));

  return {
    id: spec.id ?? 'project',
    workDays,
    isScheduledWorkday,
    isWorkday(day: DayNumber): boolean {
      if (nonWorking.has(day)) {
        return false;
      }
      if (working.has(day)) {
        return true;
      }
      return isScheduledWorkday(day);
    },
    nonWorkingDays,
    workingDays,
  };
}

// ---------------------------------------------------------------- 容量规划

/**
 * 依据「需要多少个工作日」估算地平线天数（自然日）。
 *
 * 以「一周内的工作日数」为上界（`workDays = 5` 时 1 个工作日最多摊到 1.4 个自然日），
 * 再加 60 天缓冲吸收 `exceptions`（假日会把工作日继续向后推）；
 * 最后按 `HORIZON_GUARD_DAYS` 截断。
 */
export function horizonDaysFor(neededWorkdays: number, spec: CalendarSpec = {}): number {
  const workDays = spec.workDays ?? DEFAULT_WORK_DAYS;
  const perWeek = Math.max(1, workDays.length);
  const needed = Number.isFinite(neededWorkdays) ? Math.max(0, neededWorkdays) : 0;
  const natural = Math.ceil((needed * DAYS_IN_WEEK) / perWeek) + 60;
  return Math.min(HORIZON_GUARD_DAYS, natural);
}

// ---------------------------------------------------------------- 周内算术（O(1)）

/** 把自然日数拆成「整周 + 余数」；余数归一到 `[0, 7)`。 */
function splitWeeks(days: number): { weeks: number; remainder: number } {
  const weeks = Math.floor(days / DAYS_IN_WEEK);
  return { weeks, remainder: days - weeks * DAYS_IN_WEEK };
}

/**
 * 统计**自 1970-01-01（day 0）起、严格早于 `day`** 的工作日数量（不含 `exceptions`）。
 *
 * 闭式算法：整周数 × 每周工作日数 + 余数段逐日判定（余数段最多 7 天）。
 * 这是取代原有逐日循环的实现——后者在同一工作负载上慢约 340×（S3 §五.5）。
 *
 * 只接受非负 `day`：负向区间由调用方归一到 `[start, end)` 后再作差。
 */
function countWorkdaysFromEpoch(day: number, workDays: readonly number[]): number {
  const { weeks, remainder } = splitWeeks(day);
  let count = weeks * workDays.length;
  for (let offset = 0; offset < remainder; offset += 1) {
    // 余数段从 day 0（周四）起算，与 `weekdayOf` 同一基准公式。
    const weekday = (((offset + 4) % DAYS_IN_WEEK) + DAYS_IN_WEEK) % DAYS_IN_WEEK;
    if (workDays.includes(weekday)) {
      count += 1;
    }
  }
  return count;
}

/** 半开区间 `[startDay, endDayExclusive)` 内的（忽略例外的）工作日数量。 */
function countBaseWorkdaysBetween(
  startDay: DayNumber,
  endDayExclusive: DayNumber,
  workDays: readonly number[],
): number {
  if (endDayExclusive <= startDay) {
    return 0;
  }
  return (
    countWorkdaysFromEpoch(endDayExclusive, workDays) - countWorkdaysFromEpoch(startDay, workDays)
  );
}

// ---------------------------------------------------------------- O(1) 索引日历

/**
 * O(1) 索引日历：**工作日序号 ↔ 日期**的唯一权威翻译器（G2/G3 的入参边界）。
 *
 * 内部结构（可移植自 [G0-S-S3 结论 §八 C.9](../../../spikes/g0-s3-cpm-perf/结论.md) 的
 * `IndexedCalendar`）：
 * - `mask[i]`         = `baseDay + i` 是否工作日；
 * - `prefix[i]`       = `[baseDay, baseDay + i)` 内的工作日数（长度 `spanDays + 1`）；
 * - `ordinalToDay[k]` = 第 k 个工作日（0 基）。
 *
 * 查询全部 O(1)；唯一的例外是 `dayOfOrdinal(workdayCount)`——语义是
 * 「**最后一个工作日之后的首个工作日**」（S3 §八 C.10），它向后线性扫描到首个工作日，
 * 与地平线长度无关，因此差分/黄金比对不会因容量差异而假失败。
 */
export class Calendar implements CalendarLike {
  /** 日历标识（文档追溯用）。 */
  readonly id: string;
  /** 地平线起点（序号锚点）。 */
  readonly baseDay: DayNumber;
  /** 地平线长度（自然日）。 */
  readonly spanDays: number;
  /** 被索引覆盖的最后一个日序号。 */
  readonly lastDay: DayNumber;
  /** 本日历可表达的工作日总数（合法序号区间为 `[0, workdayCount]`）。 */
  readonly workdayCount: number;

  /** 原始规格：`withHorizon()` 据此重建实例（同一份日历语义）。 */
  private readonly spec: CalendarSpec;
  private readonly isWorkdayPredicate: (day: DayNumber) => boolean;
  private readonly prefix: Int32Array;
  private readonly ordinalToDay: Int32Array;

  constructor(spec: CalendarSpec = {}, options: CalendarOptions = {}) {
    const baseDay = assertDayNumber(
      options.baseDay ?? isoToDayNumber(DEFAULT_PROJECT_BASE_DAY_ISO),
      'baseDay',
    );
    const spanDays = options.spanDays ?? DEFAULT_HORIZON_DAYS;
    if (!Number.isInteger(spanDays) || spanDays <= 0) {
      fail(`地平线天数必须为正整数，收到 ${String(spanDays)}`);
    }
    if (spanDays > HORIZON_GUARD_DAYS) {
      fail(
        `地平线天数 ${String(spanDays)} 超过上限 ${String(HORIZON_GUARD_DAYS)}（HORIZON_GUARD_DAYS）`,
      );
    }

    const normalized = normalizeCalendarSpec(spec);
    this.id = normalized.id;
    this.baseDay = baseDay;
    this.spanDays = spanDays;
    this.lastDay = baseDay + spanDays;
    this.spec = spec;
    this.isWorkdayPredicate = normalized.isWorkday;

    const mask = new Uint8Array(spanDays);
    const prefix = new Int32Array(spanDays + 1);
    let count = 0;
    for (let offset = 0; offset < spanDays; offset += 1) {
      if (normalized.isWorkday(baseDay + offset)) {
        mask[offset] = 1;
        count += 1;
      }
      prefix[offset + 1] = count;
    }
    this.prefix = prefix;
    this.workdayCount = count;
    const ordinalToDay = new Int32Array(count);
    let cursor = 0;
    for (let offset = 0; offset < spanDays; offset += 1) {
      if (mask[offset] === 1) {
        ordinalToDay[cursor] = baseDay + offset;
        cursor += 1;
      }
    }
    this.ordinalToDay = ordinalToDay;
  }

  /** 该日是否工作日（例外优先；**可回答地平线之外**的日期——谓词不依赖索引）。 */
  isWorkday(day: DayNumber): boolean {
    return this.isWorkdayPredicate(assertDayNumber(day, 'isWorkday 的 day'));
  }

  /** `[baseDay, day)` 内的工作日数量；`day` 为工作日时即其 0 基序号。 */
  ordinalOfDay(day: DayNumber): WorkdayCount {
    const offset = this.assertWithinHorizon(day, 'ordinalOfDay');
    return this.prefix[offset]! as WorkdayCount;
  }

  /** 第 k 个工作日（0 基）；`k === workdayCount` 返回最后一个工作日之后的首个工作日。 */
  dayOfOrdinal(ordinal: WorkdayCount | number): DayNumber {
    const k = assertOrdinal(ordinal, 'dayOfOrdinal 的序号');
    if (k > this.workdayCount) {
      return fail(
        `工作日序号越界：${String(k)}（合法范围 0..${String(this.workdayCount)}；` +
          '容量不足时用 withHorizon() 扩容后重算）',
      );
    }
    if (k === this.workdayCount) {
      // 排他结束日：最后一个工作日之后的首个工作日（与地平线长度无关，见 S3 §八 C.10）。
      // 循环上界是防御性的：非工作日连续再多也远小于 `spanDays + HORIZON_GUARD_DAYS`。
      let cursor = this.baseDay + this.spanDays;
      for (let steps = 0; steps <= this.spanDays + HORIZON_GUARD_DAYS; steps += 1) {
        if (this.isWorkdayPredicate(cursor)) {
          return cursor;
        }
        cursor += 1;
      }
      return fail(`工作日序号 ${String(k)} 之后找不到工作日（日历无工作日？）`);
    }
    return this.ordinalToDay[k]!;
  }

  /**
   * 半开区间 `[startDay, endDayExclusive)` 内的工作日数量。
   *
   * 与 `countWorkdays` 同口径：区间为空或倒置时返回 **0**（不做负向推进——负向推进属
   * G2 的传播语义）。
   */
  workdaysBetween(startDay: DayNumber, endDayExclusive: DayNumber): WorkdayCount {
    if (endDayExclusive <= startDay) {
      return 0 as WorkdayCount;
    }
    return (this.ordinalOfDay(endDayExclusive) -
      this.ordinalOfDay(startDay)) as WorkdayCount;
  }

  /** 第 k 个工作日的 ISO 日期。 */
  isoOfOrdinal(ordinal: WorkdayCount | number): string {
    return dayNumberToIso(this.dayOfOrdinal(ordinal));
  }

  /** 日序号 → ISO 日期（翻译糖，供出图/导出用）。 */
  isoOfDay(day: DayNumber): string {
    return dayNumberToIso(assertDayNumber(day, 'isoOfDay 的 day'));
  }

  /** ISO 日期 → 日序号（翻译糖，供导入用）。 */
  dayOfIso(iso: string): DayNumber {
    return isoToDayNumber(iso);
  }

  /** 从 `startDay` 起向前推进 `count` 个工作日（`count >= 0`）。 */
  addWorkdays(startDay: DayNumber, count: number): DayNumber {
    return this.dayOfOrdinal(this.shiftedOrdinal(startDay, count, 'addWorkdays'));
  }

  /** 从 `startDay` 起向后回退 `count` 个工作日（结果越到 `baseDay` 之前即抛错）。 */
  subtractWorkdays(startDay: DayNumber, count: number): DayNumber {
    return this.dayOfOrdinal(this.shiftedOrdinal(startDay, -count, 'subtractWorkdays'));
  }

  /** 工作日推进（可为负）：`dayOfOrdinal(ordinalOfDay(day) + delta)`。 */
  offsetWorkdays(day: DayNumber, delta: number): DayNumber {
    return this.dayOfOrdinal(this.shiftedOrdinal(day, delta, 'offsetWorkdays'));
  }

  /** 同一份日历规格、更大/更小地平线的新实例（容量不足时扩容重算，S3 §八 C.11）。 */
  withHorizon(spanDays: number): Calendar {
    return new Calendar(this.spec, { baseDay: this.baseDay, spanDays });
  }

  private shiftedOrdinal(day: DayNumber, delta: number, label: string): number {
    if (!Number.isInteger(delta)) {
      return fail(`${label} 的偏移量不是整数：${String(delta)}`);
    }
    const shifted = this.ordinalOfDay(day) + delta;
    if (shifted < 0) {
      return fail(
        `${label} 会把工作日序号推到 0 之前（${String(shifted)}）：` +
          '负数序号无定义，请把 baseDay 前移或改用 G2 的截断语义',
      );
    }
    return shifted;
  }

  private assertWithinHorizon(day: DayNumber, label: string): number {
    const offset = assertDayNumber(day, `${label} 的 day`) - this.baseDay;
    if (offset < 0) {
      return fail(
        `${label}：日期 ${dayNumberToIso(day)} 早于地平线起点 ${dayNumberToIso(this.baseDay)}（负数序号无定义）`,
      );
    }
    if (offset > this.spanDays) {
      return fail(
        `${label}：日期 ${dayNumberToIso(day)} 超出地平线（${String(this.spanDays)} 天，` +
          `终点 ${dayNumberToIso(this.lastDay)}）；用 withHorizon() 扩容后重算`,
      );
    }
    return offset;
  }
}

// ---------------------------------------------------------------- 兼容层（既有 API）

/**
 * 判断给定时刻是否为工作日。
 *
 * @param timestampUtcMs UTC 毫秒时间戳（如 `parseIsoDate` 的返回值）
 * @param workDays 工作日日序号集合（0=周日 … 6=周六）
 * @throws RangeError `workDays` 为空或含非 0–6 的整数
 */
export function isWorkday(
  timestampUtcMs: number,
  workDays: readonly number[] = DEFAULT_WORK_DAYS,
): boolean {
  if (!Number.isFinite(timestampUtcMs)) {
    return fail(`时间戳不是有限数：${String(timestampUtcMs)}`);
  }
  const valid = assertWorkDays(workDays);
  return valid.includes(weekdayOf(Math.floor(timestampUtcMs / MS_PER_DAY)));
}

/**
 * 统计半开区间 `[startIso, endIsoExclusive)` 内的工作日数量。
 *
 * - 区间为空（`end <= start`）或倒置时返回 0（不做负向推进——负向推进属 G2 的传播语义）；
 * - 起算日计入、结束日不计入，故「周一起算、工期 5 个工作日」的结束日为下周一，
 *   与本函数 `countWorkdays('2025-01-06', '2025-01-13') === 5` 自洽；
 * - `exceptions` 与 `CalendarSpec` 同形状：**工作日→非工作日** 减计数、
 *   **休息日→工作日** 加计数，同日冲突时非工作日优先。
 *
 * **性能说明**：本函数是兼容入口，例外修正按**例外日数量**（而非区间天数）迭代；
 * 热路径（G2 传播、G3 批量导入）请用 `Calendar`——它的查询是 O(1) 索引。
 *
 * @throws RangeError 日期格式非法，或 `workDays` / `exceptions` 非法
 */
export function countWorkdays(
  startIso: string,
  endIsoExclusive: string,
  workDays: readonly number[] = DEFAULT_WORK_DAYS,
  exceptions?: CalendarExceptionsSpec,
): WorkdayCount {
  const startDay = isoToDayNumber(startIso);
  const endDay = isoToDayNumber(endIsoExclusive);
  if (endDay <= startDay) {
    return 0 as WorkdayCount;
  }

  const normalized = normalizeCalendarSpec({
    ...(exceptions === undefined ? {} : { exceptions }),
    workDays,
  });
  let count = countBaseWorkdaysBetween(startDay, endDay, normalized.workDays);
  for (const day of normalized.nonWorkingDays) {
    if (day >= startDay && day < endDay && normalized.isScheduledWorkday(day)) {
      count -= 1;
    }
  }
  for (const day of normalized.workingDays) {
    if (day >= startDay && day < endDay && !normalized.isScheduledWorkday(day)) {
      count += 1;
    }
  }
  return count as WorkdayCount;
}
