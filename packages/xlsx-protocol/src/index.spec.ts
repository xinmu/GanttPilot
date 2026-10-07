import { describe, expect, it } from 'vitest';

import { LATEST_COMPLETED_BLOCK, XLSX_PROTOCOL_VERSION } from './index.js';

describe('@ganttpilot/xlsx-protocol 包骨架', () => {
  it('可独立构建并被消费（G0 出口条件：三包可独立构建）', () => {
    expect(XLSX_PROTOCOL_VERSION).toBe('0.0.0');
    expect(LATEST_COMPLETED_BLOCK).toBe('G8');
  });
});
