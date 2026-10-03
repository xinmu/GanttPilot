import { describe, expect, it } from 'vitest';

import { PLANNED_GATE, XLSX_PROTOCOL_VERSION } from './index.js';

describe('@ganttpilot/xlsx-protocol 包骨架', () => {
  it('可独立构建并被消费（G0 出口条件：三包可独立构建）', () => {
    expect(XLSX_PROTOCOL_VERSION).toBe('0.0.0');
    expect(PLANNED_GATE).toBe('G3');
  });
});
