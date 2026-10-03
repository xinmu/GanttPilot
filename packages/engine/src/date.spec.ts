import { describe, expect, it } from 'vitest';

import {
  Calendar,
  countWorkdays,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_PROJECT_BASE_DAY_ISO,
  DEFAULT_WORK_DAYS,
  dayNumberToIso,
  HORIZON_GUARD_DAYS,
  horizonDaysFor,
  isWorkday,
  isoToDayNumber,
  parseIsoDate,
  weekdayOf,
} from './date.js';

/** 2025-01-06 为周一；2025-01-03 为周五；2025-01-04 为周六。 */
const MONDAY = '2025-01-06';
const FRIDAY = '2025-01-03';
const SATURDAY = '2025-01-04';

/** 日历起点统一取 2025-01-01（周三）；序号 0 因此落在 2025-01-01 当天。 */
const BASE_ISO = '2025-01-01';
const baseDay = isoToDayNumber(BASE_ISO);

/** S3 结论 §三.1 的日历事实：整周放假 / 6 天工作周。 */
const HOLIDAY_WEEK = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
const SIX_DAY_WEEK = [0, 1, 2, 3, 4, 5];

function calendar(spec: ConstructorParameters<typeof Calendar>[0] = {}, spanDays = 1460): Calendar {
  return new Calendar(spec, { baseDay, spanDays });
}

describe('parseIsoDate', () => {
  it('把严格 ISO 日期解析为 UTC 毫秒', () => {
    expect(parseIsoDate('1970-01-01')).toBe(0);
    expect(parseIsoDate('2025-01-06')).toBe(Date.UTC(2025, 0, 6));
  });

  it('拒绝含时刻或用 / 分隔的写法', () => {
    expect(() => parseIsoDate('2025-01-06T00:00:00Z')).toThrow(RangeError);
    expect(() => parseIsoDate('2025/01/06')).toThrow(RangeError);
    expect(() => parseIsoDate('2025-1-6')).toThrow(RangeError);
  });

  it('拒绝日历上不存在的日期', () => {
    expect(() => parseIsoDate('2025-02-30')).toThrow(RangeError);
    expect(() => parseIsoDate('2025-13-01')).toThrow(RangeError);
  });
});

describe('isoToDayNumber / dayNumberToIso', () => {
  it('日序号与毫秒口径自洽（1970-01-01 = 0）', () => {
    expect(isoToDayNumber('1970-01-01')).toBe(0);
    expect(isoToDayNumber('1970-01-02')).toBe(1);
    expect(isoToDayNumber('1969-12-31')).toBe(-1);
    expect(isoToDayNumber('2025-01-06')).toBe(parseIsoDate('2025-01-06') / 86_400_000);
  });

  it('序号 ↔ ISO 往返一致（含纪元前、闰日、上界年）', () => {
    for (const iso of ['1970-01-01', '1969-12-31', '2024-02-29', MONDAY, '9999-12-31']) {
      expect(dayNumberToIso(isoToDayNumber(iso))).toBe(iso);
    }
    expect(dayNumberToIso(0)).toBe('1970-01-01');
  });

  it('拒绝超出可往返年份区间或非法的日期串', () => {
    expect(() => isoToDayNumber('10000-01-01')).toThrow(RangeError);
    expect(() => isoToDayNumber('999-01-01')).toThrow(RangeError);
    expect(() => isoToDayNumber('2025-02-30')).toThrow(RangeError);
    expect(() => dayNumberToIso(1.5)).toThrow(RangeError);
  });
});

describe('weekdayOf', () => {
  it('与 Date#getUTCDay 同口径', () => {
    // 1970-01-01 为周四（4）；2025-01-06 为周一（1）。
    expect(weekdayOf(0)).toBe(4);
    expect(weekdayOf(isoToDayNumber(MONDAY))).toBe(1);
    expect(weekdayOf(isoToDayNumber(SATURDAY))).toBe(6);
    expect(weekdayOf(-1)).toBe(3);
  });
});

describe('isWorkday', () => {
  it('默认日历下周一为工作日、周六不是', () => {
    expect(isWorkday(parseIsoDate(MONDAY))).toBe(true);
    expect(isWorkday(parseIsoDate(SATURDAY))).toBe(false);
  });

  it('接受自定义工作日历（全周 7 天）', () => {
    expect(isWorkday(parseIsoDate(SATURDAY), [0, 1, 2, 3, 4, 5, 6])).toBe(true);
  });

  it('工作日历含非法日序号时抛错', () => {
    expect(() => isWorkday(parseIsoDate(MONDAY), [7])).toThrow(RangeError);
    expect(() => isWorkday(parseIsoDate(MONDAY), [1.5])).toThrow(RangeError);
  });

  it('空工作日历与非有限时间戳被拒绝', () => {
    expect(() => isWorkday(parseIsoDate(MONDAY), [])).toThrow(RangeError);
    expect(() => isWorkday(Number.NaN)).toThrow(RangeError);
  });
});

describe('countWorkdays（兼容入口）', () => {
  it('周一至周五整周计 5 个工作日', () => {
    expect(countWorkdays(MONDAY, '2025-01-13')).toBe(5);
  });

  it('区间跨越周末时只计工作日', () => {
    // 2025-01-03（周五）→ 2025-01-07（周二，不含）：周五 + 周一 = 2
    expect(countWorkdays(FRIDAY, '2025-01-07')).toBe(2);
  });

  it('起算日计入、结束日不计入（半开区间）', () => {
    expect(countWorkdays(MONDAY, '2025-01-07')).toBe(1);
    expect(countWorkdays('2025-01-07', MONDAY)).toBe(0);
  });

  it('空区间与倒置区间返回 0', () => {
    expect(countWorkdays(MONDAY, MONDAY)).toBe(0);
    expect(countWorkdays('2026-01-02', '2025-12-31')).toBe(0);
  });

  it('可跨年计算', () => {
    // 2025-12-31（周三）→ 2026-01-05（周一，不含）：周三、周四、周五 = 3
    expect(countWorkdays('2025-12-31', '2026-01-05')).toBe(3);
  });

  it('全周工作日历时等于日历天数', () => {
    expect(countWorkdays(MONDAY, '2025-01-13', [0, 1, 2, 3, 4, 5, 6])).toBe(7);
  });

  it('默认工作日历为周一至周五', () => {
    expect(DEFAULT_WORK_DAYS).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('整周放假（工作日 → 非工作日）各减 1', () => {
    // 2026-10-05（周一）→ 2026-10-19（周一，不含）：14 个自然日内的 10 个理论工作日 - 5 = 5
    expect(countWorkdays('2026-10-05', '2026-10-19')).toBe(10);
    expect(countWorkdays('2026-10-05', '2026-10-19', DEFAULT_WORK_DAYS, {
      nonWorking: HOLIDAY_WEEK,
    })).toBe(5);
  });

  it('6 天工作周（休息日 → 工作日）各加 1', () => {
    // 2026-10-05（周一）→ 2026-10-19（不含）：6 天周自带的周日也计入（2 个周日）
    expect(countWorkdays('2026-10-05', '2026-10-19', SIX_DAY_WEEK)).toBe(12);
  });

  it('同日冲突时非工作日优先（不重复计数）', () => {
    // 2026-10-12 是周一：既在 nonWorking 又在 working，非工作日优先 ⇒ 净减 5（都是 5 个工作日）。
    expect(
      countWorkdays('2026-10-05', '2026-10-19', DEFAULT_WORK_DAYS, {
        nonWorking: HOLIDAY_WEEK,
        working: ['2026-10-12'],
      }),
    ).toBe(5);
    // 周六（非工作日）被 working 覆盖时加 1 ⇒ 周五 + 周六 + 周一 = 3。
    expect(countWorkdays('2026-10-09', '2026-10-13', DEFAULT_WORK_DAYS, {
      working: ['2026-10-10'],
    })).toBe(3);
    // 同一天再被 nonWorking 覆盖，非工作日优先 ⇒ 回到 2（周五 + 周一）。
    expect(countWorkdays('2026-10-09', '2026-10-13', DEFAULT_WORK_DAYS, {
      working: ['2026-10-10'],
      nonWorking: ['2026-10-10'],
    })).toBe(2);
  });

  it('例外只在落入半开区间内时才影响计数', () => {
    // [10-05, 10-13) = 10-05..10-12 共 6 个理论工作日；10-12 落入区间 ⇒ 6 − 1 = 5。
    expect(countWorkdays('2026-10-05', '2026-10-13', DEFAULT_WORK_DAYS, {
      nonWorking: ['2026-10-12'],
    })).toBe(5);
    // [10-05, 10-09) 不含 10-12：理论 4 个工作日，例外不生效（不被区间外的例外误伤）。
    expect(countWorkdays('2026-10-05', '2026-10-09', DEFAULT_WORK_DAYS, {
      nonWorking: ['2026-10-12'],
    })).toBe(4);
    // 节日之后的一周：例外完全在区间之外 ⇒ 计数回归纯周内规则。
    expect(countWorkdays('2026-10-19', '2026-10-26', DEFAULT_WORK_DAYS, {
      nonWorking: HOLIDAY_WEEK,
    })).toBe(5);
  });
});

describe('Calendar：基数与序号翻译', () => {
  it('默认起点与容量', () => {
    const cal = new Calendar();
    expect(cal.baseDay).toBe(isoToDayNumber(DEFAULT_PROJECT_BASE_DAY_ISO));
    expect(cal.spanDays).toBe(DEFAULT_HORIZON_DAYS);
    expect(cal.workdayCount).toBeGreaterThan(1000);
  });

  it('ordinalOfDay 是 [baseDay, day) 内的工作日数', () => {
    const cal = calendar();
    // 2025-01-01（周三）已是工作日 ⇒ 序号 0。
    expect(cal.ordinalOfDay(baseDay)).toBe(0);
    expect(cal.isoOfOrdinal(0)).toBe('2025-01-01');
    expect(cal.isoOfOrdinal(2)).toBe('2025-01-03'); // 周三、周四、周五
    expect(cal.isoOfOrdinal(3)).toBe('2025-01-06'); // 跳过周末
    expect(cal.ordinalOfDay(isoToDayNumber(SATURDAY))).toBe(3); // 周六仍未计入
  });

  it('序号 ↔ 日期在窗口内逐项往返一致', () => {
    const cal = calendar();
    for (let k = 0; k < 260; k += 1) {
      const day = cal.dayOfOrdinal(k);
      expect(cal.isWorkday(day)).toBe(true);
      expect(cal.ordinalOfDay(day)).toBe(k);
      expect(cal.isoOfOrdinal(k)).toBe(dayNumberToIso(day));
    }
  });

  it('workdaysBetween 与旧 API 的半开区间语义一致', () => {
    const cal = calendar();
    const start = isoToDayNumber(FRIDAY);
    const end = isoToDayNumber('2025-01-07');
    expect(cal.workdaysBetween(start, end)).toBe(2);
    expect(cal.workdaysBetween(start, end)).toBe(countWorkdays(FRIDAY, '2025-01-07'));
    expect(cal.workdaysBetween(end, start)).toBe(0);
  });

  it('跨年计数与起点落在休息日的情形', () => {
    expect(calendar().workdaysBetween(isoToDayNumber('2025-12-31'), isoToDayNumber('2026-01-05'))).toBe(3);

    // 2025-01-04 是周六：序号 0 应落在其后的首个工作日（2025-01-06）。
    const weekendBase = new Calendar({}, { baseDay: isoToDayNumber(SATURDAY), spanDays: 60 });
    expect(weekendBase.isoOfOrdinal(0)).toBe(MONDAY);
    expect(weekendBase.isWorkday(isoToDayNumber(SATURDAY))).toBe(false);
    expect(weekendBase.ordinalOfDay(isoToDayNumber(SATURDAY))).toBe(0);
  });
});

describe('Calendar：工作日推演（正/负/0）', () => {
  it('addWorkdays / subtractWorkdays / offsetWorkdays', () => {
    const cal = calendar();
    const start = isoToDayNumber(MONDAY); // 序号 3
    expect(cal.isoOfDay(cal.addWorkdays(start, 5))).toBe('2025-01-13');
    expect(cal.isoOfDay(cal.addWorkdays(start, 0))).toBe(MONDAY);
    expect(cal.isoOfDay(cal.subtractWorkdays(start, 1))).toBe('2025-01-03'); // 回退到周五
    expect(cal.isoOfDay(cal.offsetWorkdays(start, -3))).toBe(BASE_ISO);
    expect(cal.ordinalOfDay(cal.offsetWorkdays(start, -3))).toBe(0);
  });

  it('月中起算：起点落在月中任意工作日', () => {
    // 2025-01-15 是周三。
    const midMonth = new Calendar({}, { baseDay: isoToDayNumber('2025-01-15'), spanDays: 10 });
    expect(midMonth.isoOfOrdinal(0)).toBe('2025-01-15');
    expect(midMonth.isoOfOrdinal(2)).toBe('2025-01-17');
    expect(midMonth.isoOfOrdinal(3)).toBe('2025-01-20'); // 跳过周末
    expect(midMonth.workdayCount).toBe(8); // 10 天窗口 [01-15, 01-24] 内 8 个工作日
  });

  it('负向推进越到 baseDay 之前即抛错（不做静默截断）', () => {
    const cal = calendar();
    expect(() => cal.subtractWorkdays(isoToDayNumber(MONDAY), 4)).toThrow(RangeError);
    expect(() => cal.offsetWorkdays(isoToDayNumber(MONDAY), -4)).toThrow(RangeError);
    expect(() => cal.dayOfOrdinal(-1)).toThrow(RangeError);
    expect(() => cal.offsetWorkdays(isoToDayNumber(MONDAY), 0.5)).toThrow(RangeError);
  });
});

describe('Calendar：exceptions', () => {
  it('整周放假把序号 5 从 2026-10-12 推到 2026-10-19（S3 §三.1 事实）', () => {
    // 起点取 2026-10-05（周一），故序号 5 在无例外的默认日历下正是 2026-10-12。
    const spec = { exceptions: { nonWorking: HOLIDAY_WEEK } };
    const holidayBase = new Calendar({}, { baseDay: isoToDayNumber('2026-10-05'), spanDays: 1200 });
    expect(holidayBase.isoOfOrdinal(5)).toBe('2026-10-12'); // 对照：无例外

    const cal = new Calendar(spec, { baseDay: isoToDayNumber('2026-10-05'), spanDays: 1200 });
    expect(cal.isoOfOrdinal(5)).toBe('2026-10-19');
    expect(cal.dayOfIso('2026-10-12')).toBe(isoToDayNumber('2026-10-12')); // 翻译糖不受影响
    expect(cal.isWorkday(isoToDayNumber('2026-10-12'))).toBe(false);
    expect(cal.isWorkday(isoToDayNumber('2026-10-19'))).toBe(true);
  });

  it('6 天工作周把序号 6 落在 2026-10-12（周一）', () => {
    const sixDay = new Calendar(
      { workDays: SIX_DAY_WEEK },
      { baseDay: isoToDayNumber('2026-10-05'), spanDays: 1200 },
    );
    expect(sixDay.isoOfOrdinal(6)).toBe('2026-10-12');
    expect(sixDay.isWorkday(isoToDayNumber('2026-10-12'))).toBe(true);
    expect(sixDay.isWorkday(isoToDayNumber('2026-10-11'))).toBe(true); // 周日成为工作日
  });

  it('同日冲突：非工作日优先（workDays 下的周一被 nonWorking 覆盖）', () => {
    const both = calendar(
      { exceptions: { nonWorking: ['2026-10-12'], working: ['2026-10-12'] } },
      1200,
    );
    expect(both.isWorkday(isoToDayNumber('2026-10-12'))).toBe(false);
  });

  it('working 例外可把休息日变成工作日', () => {
    const makeup = calendar({ exceptions: { working: ['2025-01-04'] } }, 60); // 周六
    expect(makeup.isWorkday(isoToDayNumber('2025-01-04'))).toBe(true);
    expect(makeup.isoOfOrdinal(3)).toBe('2025-01-04');
  });

  it('例外日期串非法时抛错', () => {
    expect(() => new Calendar({ exceptions: { nonWorking: ['2025/01/04'] } })).toThrow(RangeError);
    expect(() => new Calendar({ exceptions: { working: ['2025-02-30'] } })).toThrow(RangeError);
  });
});

describe('Calendar：k = workdayCount 边界', () => {
  it('返回最后一个工作日之后的首个工作日，且与地平线长度无关', () => {
    const narrow = new Calendar({}, { baseDay: isoToDayNumber('2025-01-15'), spanDays: 10 });
    // 窗口 [2025-01-15, 2025-01-24]，最后一个工作日是 2025-01-24（周五）。
    expect(narrow.isoOfOrdinal(narrow.workdayCount - 1)).toBe('2025-01-24');
    expect(narrow.isoOfOrdinal(narrow.workdayCount)).toBe('2025-01-27'); // 下周一

    const sameWindow = new Calendar({}, { baseDay: isoToDayNumber('2025-01-15'), spanDays: 30 });
    expect(sameWindow.isoOfOrdinal(8)).toBe('2025-01-27'); // 同一序号，同一日期
    expect(sameWindow.workdayCount).toBeGreaterThan(narrow.workdayCount);
  });

  it('跨过连续非工作日例外仍返回首个工作日', () => {
    // 窗口末端 2026-10-09（周五），其后整周放假，故 k = workdayCount 落在 2026-10-19。
    const cal = new Calendar(
      { exceptions: { nonWorking: HOLIDAY_WEEK } },
      { baseDay: isoToDayNumber('2026-10-01'), spanDays: 9 }, // [10-01, 10-10)
    );
    expect(cal.workdayCount).toBe(7); // 10-01、10-02、10-05..10-09
    expect(cal.isoOfOrdinal(cal.workdayCount)).toBe('2026-10-19');
  });

  it('越界序号抛错并给出扩容指引', () => {
    const cal = calendar({}, 30);
    expect(() => cal.dayOfOrdinal(cal.workdayCount + 1)).toThrow(/withHorizon/);
  });
});

describe('Calendar：地平线容量与扩容', () => {
  it('默认起点落在 2025-01-01', () => {
    expect(DEFAULT_PROJECT_BASE_DAY_ISO).toBe(BASE_ISO);
  });

  it('早于起点或超出地平线的查询抛错并给出扩容指引', () => {
    const cal = new Calendar({}, { baseDay, spanDays: 30 });
    expect(() => cal.ordinalOfDay(baseDay - 1)).toThrow(/早于地平线起点/);
    expect(() => cal.ordinalOfDay(baseDay + 31)).toThrow(/withHorizon/);
    expect(() => cal.workdaysBetween(baseDay, baseDay + 31)).toThrow(RangeError);
  });

  it('withHorizon 扩容后与直接构造大窗口逐项相同（扩容重算路径）', () => {
    const narrow = new Calendar({}, { baseDay, spanDays: 40 });
    const target = isoToDayNumber('2026-06-01');
    expect(() => narrow.ordinalOfDay(target)).toThrow(RangeError);

    const expanded = narrow.withHorizon(1460);
    const direct = new Calendar({}, { baseDay, spanDays: 1460 });
    expect(expanded.ordinalOfDay(target)).toBe(direct.ordinalOfDay(target));
    expect(expanded.workdayCount).toBe(direct.workdayCount);
    for (let k = 0; k <= 200; k += 1) {
      expect(expanded.dayOfOrdinal(k)).toBe(direct.dayOfOrdinal(k));
    }
  });

  it('withHorizon 保留日历规格（workDays 与 exceptions）', () => {
    const spec = { workDays: SIX_DAY_WEEK, exceptions: { nonWorking: HOLIDAY_WEEK } };
    const expanded = new Calendar(spec, { baseDay, spanDays: 40 }).withHorizon(1200);
    const direct = new Calendar(spec, { baseDay, spanDays: 1200 });
    expect(expanded.isoOfOrdinal(5)).toBe(direct.isoOfOrdinal(5));
    expect(expanded.workdayCount).toBe(direct.workdayCount);
    expect(expanded.id).toBe(direct.id);
  });

  it('地平线非法或超过上限时抛错', () => {
    expect(() => new Calendar({}, { spanDays: 0 })).toThrow(RangeError);
    expect(() => new Calendar({}, { spanDays: 1.5 })).toThrow(RangeError);
    expect(() => new Calendar({}, { spanDays: HORIZON_GUARD_DAYS + 1 })).toThrow(RangeError);
  });
});

describe('horizonDaysFor', () => {
  it('按周内工作日数估算并加缓冲', () => {
    expect(horizonDaysFor(1000)).toBe(Math.ceil((1000 * 7) / 5) + 60);
    expect(horizonDaysFor(0)).toBe(60);
    expect(horizonDaysFor(-5)).toBe(60);
    expect(horizonDaysFor(1000, { workDays: SIX_DAY_WEEK })).toBe(Math.ceil((1000 * 7) / 6) + 60);
  });

  it('按 HORIZON_GUARD_DAYS 截断', () => {
    expect(horizonDaysFor(1e9)).toBe(HORIZON_GUARD_DAYS);
  });
});

describe('Calendar：规格校验', () => {
  it('workDays 为空或含非法项时抛错', () => {
    expect(() => new Calendar({ workDays: [] })).toThrow(RangeError);
    expect(() => new Calendar({ workDays: [7] })).toThrow(RangeError);
    expect(() => new Calendar({ workDays: [1.5] })).toThrow(RangeError);
  });
});
