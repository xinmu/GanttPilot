import { describe, expect, it } from 'vitest';

import { countWorkdays, DEFAULT_WORK_DAYS, isWorkday, parseIsoDate } from './date.js';

/** 2025-01-06 为周一；2025-01-03 为周五；2025-01-04 为周六。 */
const MONDAY = '2025-01-06';
const FRIDAY = '2025-01-03';
const SATURDAY = '2025-01-04';

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
});

describe('countWorkdays', () => {
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
});
