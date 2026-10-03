import { describe, expect, it } from 'vitest';

import * as engine from './index.js';

describe('@ganttpilot/engine 包骨架', () => {
  it('可独立构建并被消费（G0 出口条件：三包可独立构建）', () => {
    expect(engine.ENGINE_VERSION).toBe('0.0.0');
    expect(engine.PLANNED_GATE).toBe('G1');
  });
});
