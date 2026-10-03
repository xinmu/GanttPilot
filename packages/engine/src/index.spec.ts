import { describe, expect, it } from 'vitest';

import * as engine from './index.js';

describe('@ganttpilot/engine 公共入口', () => {
  it('导出 G0 阶段的日期算术 API 与包标识', () => {
    expect(engine.ENGINE_VERSION).toBe('0.0.0');
    expect(engine.PLANNED_GATE).toBe('G1');
    expect(typeof engine.countWorkdays).toBe('function');
    expect(typeof engine.isWorkday).toBe('function');
    expect(typeof engine.parseIsoDate).toBe('function');
    expect(engine.DEFAULT_WORK_DAYS).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('是纯函数：相同输入得到相同输出，且不产生外部状态', () => {
    const first = engine.countWorkdays('2025-01-06', '2025-01-13');
    const second = engine.countWorkdays('2025-01-06', '2025-01-13');
    expect(first).toBe(second);
    expect(first).toBe(5);
  });
});
