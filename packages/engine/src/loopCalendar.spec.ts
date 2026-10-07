import { describe, expect, it } from 'vitest';

import {
  Calendar,
  type CalendarLike,
  type CalendarSpec,
  countWorkdays,
  dayNumberToIso,
  isoToDayNumber,
  weekdayOf,
  type WorkdayCount,
} from './date.js';
import { LoopCalendar } from '../test/loopCalendar.js';

/**
 * G1.1 出口条件「索引前缀和与逐日循环两套实现互证一致」的证据层。
 *
 * 做法沿用 [G0-S-S3 结论 §三.1](../../../spikes/g0-s3-cpm-perf/结论.md)：
 * 同一批「日 → 序号」「序号 → 日」「区间计数」查询在两套实现上逐项比对。
 * 本文件末尾还有一条**负向对照**，证明这套比对不是恒真式。
 */

const BASE_ISO = '2025-01-01';
const baseDay = isoToDayNumber(BASE_ISO);

/** 互证的三个日历：默认、整周放假、6 天工作周。 */
const CASES: readonly { readonly id: string; readonly spec: CalendarSpec }[] = [
  { id: 'default', spec: {} },
  {
    id: 'holiday-week',
    spec: {
      exceptions: {
        nonWorking: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'],
      },
    },
  },
  { id: 'six-day-week', spec: { workDays: [0, 1, 2, 3, 4, 5] } },
];

const SPAN_DAYS = 1200;

function indexed(spec: CalendarSpec): Calendar {
  return new Calendar(spec, { baseDay, spanDays: SPAN_DAYS });
}

function looped(spec: CalendarSpec): LoopCalendar {
  return new LoopCalendar(spec, { baseDay, spanDays: SPAN_DAYS });
}

/** 与 `Calendar` 接口一致，但 `ordinalOfDay` 被故意改坏——用于负向对照。 */
class BrokenCalendar extends LoopCalendar implements CalendarLike {
  override ordinalOfDay(day: number): WorkdayCount {
    return (super.ordinalOfDay(day) + 1) as WorkdayCount;
  }
}

describe('索引日历 vs 逐日循环：互证', () => {
  for (const { id, spec } of CASES) {
    it(`${id}：600 天逐日判定 + 序号映射逐项一致`, () => {
      const fast = indexed(spec);
      const slow = looped(spec);

      // 逐日：isWorkday 与 ordinalOfDay 必须完全一致。
      for (let day = baseDay; day < baseDay + 600; day += 1) {
        expect(slow.isWorkday(day), `isWorkday(${dayNumberToIso(day)})`).toBe(fast.isWorkday(day));
        expect(slow.ordinalOfDay(day), `ordinalOfDay(${dayNumberToIso(day)})`).toBe(
          fast.ordinalOfDay(day),
        );
      }

      // 序号映射：含 k = workdayCount 的边界（两实现的边界语义必须同为
      // "最后一个工作日之后的首个工作日"）。
      expect(slow.workdayCount).toBe(fast.workdayCount);
      for (let k = 0; k <= 200; k += 1) {
        expect(slow.dayOfOrdinal(k), `dayOfOrdinal(${String(k)})`).toBe(fast.dayOfOrdinal(k));
      }
      expect(slow.dayOfOrdinal(slow.workdayCount)).toBe(fast.dayOfOrdinal(fast.workdayCount));

      // 区间计数：三方一致（两套实现 + 兼容入口 countWorkdays）。
      for (let i = 0; i < 120; i += 1) {
        const startDay = baseDay + ((i * 7) % 500);
        const endDay = startDay + 1 + ((i * 13) % 200);
        const startIso = dayNumberToIso(startDay);
        const endIso = dayNumberToIso(endDay);
        const expected = countWorkdays(
          startIso,
          endIso,
          spec.workDays,
          spec.exceptions,
        );
        expect(fast.workdaysBetween(startDay, endDay), `${startIso} → ${endIso}`).toBe(expected);
        expect(slow.workdaysBetween(startDay, endDay), `${startIso} → ${endIso}`).toBe(expected);
      }
    });
  }

  it('负向对照：把逐日实现的序号偏移 1，互证必须失败', () => {
    const fast = indexed({});
    const broken = new BrokenCalendar({}, { baseDay, spanDays: SPAN_DAYS });
    // 逐日判定仍然一致（只改了序号），但序号比对必须报出差异——说明互证有判别力。
    expect(broken.isWorkday(baseDay)).toBe(fast.isWorkday(baseDay));
    expect(broken.ordinalOfDay(baseDay)).not.toBe(fast.ordinalOfDay(baseDay));
  });

  it('weekdayOf 与逐日实现的周内判定同源', () => {
    const slow = looped({ workDays: [0, 1, 2, 3, 4, 5] });
    for (let offset = 0; offset < 14; offset += 1) {
      const day = baseDay + offset;
      expect(slow.isWorkday(day)).toBe(weekdayOf(day) !== 6);
    }
  });
});
