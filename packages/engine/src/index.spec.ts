import { describe, expect, it } from 'vitest';

import * as engine from './index.js';

describe('@ganttpilot/engine 公共入口', () => {
  it('导出 G1.1 的日历与日期算术 API 与包标识', () => {
    expect(engine.ENGINE_VERSION).toBe('0.0.0');
    expect(engine.PLANNED_GATE).toBe('G1.1');

    // G0 的兼容面必须保持可用。
    expect(typeof engine.countWorkdays).toBe('function');
    expect(typeof engine.isWorkday).toBe('function');
    expect(typeof engine.parseIsoDate).toBe('function');
    expect(engine.DEFAULT_WORK_DAYS).toStrictEqual([1, 2, 3, 4, 5]);

    // G1.1 新增的序号化日历面。
    expect(typeof engine.Calendar).toBe('function');
    expect(typeof engine.isoToDayNumber).toBe('function');
    expect(typeof engine.dayNumberToIso).toBe('function');
    expect(typeof engine.weekdayOf).toBe('function');
    expect(typeof engine.addDays).toBe('function');
    expect(typeof engine.diffDays).toBe('function');
    expect(typeof engine.horizonDaysFor).toBe('function');
    expect(engine.DEFAULT_PROJECT_BASE_DAY_ISO).toBe('2025-01-01');
    expect(engine.DEFAULT_HORIZON_DAYS).toBeGreaterThan(0);
    expect(engine.HORIZON_GUARD_DAYS).toBeGreaterThan(engine.DEFAULT_HORIZON_DAYS);
  });

  it('通过公共入口就能走完「ISO → 序号 → ISO」与工作日推演', () => {
    const baseDay = engine.isoToDayNumber('2025-01-06'); // 周一
    const calendar = new engine.Calendar({}, { baseDay, spanDays: 120 });
    const ef = calendar.addWorkdays(baseDay, 5); // 半开区间：起算日计入、结束日不计入
    expect(calendar.isoOfDay(ef)).toBe('2025-01-13');
    expect(calendar.ordinalOfDay(ef)).toBe(5);
  });

  it('是纯函数：相同输入得到相同输出，且不产生外部状态', () => {
    const first = engine.countWorkdays('2025-01-06', '2025-01-13');
    const second = engine.countWorkdays('2025-01-06', '2025-01-13');
    expect(first).toBe(second);
    expect(first).toBe(5);

    const a = new engine.Calendar({}, { baseDay: 0, spanDays: 60 });
    const b = new engine.Calendar({}, { baseDay: 0, spanDays: 60 });
    expect(a.workdayCount).toBe(b.workdayCount);
    expect(a.isoOfOrdinal(3)).toBe(b.isoOfOrdinal(3));
  });
});
