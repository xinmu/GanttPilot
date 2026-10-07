/**
 * `@ganttpilot/render-core` 公共入口（G4 出口条件之一：spec 落在 `pnpm test` 的收集范围内）。
 *
 * 手法同 engine 的 `index.spec.ts`：断言**面齐全**而不是逐个实现细节——
 * 面被误删/改名时立即失败，而 ADR 0007 §2 的"命名可微调但语义不可变"由此有护栏。
 */

import { describe, expect, it } from 'vitest';

import * as renderCore from './index.js';

describe('@ganttpilot/render-core 公共入口', () => {
  it('导出包标识与能力块', () => {
    expect(renderCore.RENDER_CORE_VERSION).toBe('0.0.0');
    expect(renderCore.LATEST_COMPLETED_BLOCK).toBe('G8');
    expect(renderCore.COMPLETED_GATES).toStrictEqual(['G4', 'G7', 'G8']);
  });

  it('导出 ADR 0007 §2 的几何 API（含 G4-S 记载的一处签名偏离）', () => {
    expect(typeof renderCore.buildView).toBe('function');
    expect(typeof renderCore.visibleRows).toBe('function');
    expect(typeof renderCore.visibleEdges).toBe('function');
    expect(typeof renderCore.dayAtX).toBe('function');
    // ADR §2 写的是 `ordinalAtX(view, x)`；G4-S 记载的必要偏离是显式收日历（序号只有 Calendar 能算）。
    expect(renderCore.ordinalAtX.length).toBe(3);
    expect(typeof renderCore.taskBounds).toBe('function');
    expect(typeof renderCore.barXRange).toBe('function');
    expect(typeof renderCore.milestoneCenterX).toBe('function');
    expect(typeof renderCore.routeEdge).toBe('function');
    expect(typeof renderCore.selectEdges).toBe('function');
    expect(typeof renderCore.rowWindow).toBe('function');
    expect(typeof renderCore.isRowRendered).toBe('function');
    expect(typeof renderCore.buildAxis).toBe('function');
    expect(typeof renderCore.axisOriginDayFor).toBe('function');
    expect(typeof renderCore.visibleRowOrder).toBe('function');
    expect(typeof renderCore.rowIndexOfOrder).toBe('function');
  });

  it('导出元素预算与受影响子图 API', () => {
    expect(typeof renderCore.countElements).toBe('function');
    expect(typeof renderCore.countElementsByEnumeration).toBe('function');
    expect(typeof renderCore.budgetConstantFor).toBe('function');
    expect(typeof renderCore.affectedRenderSet).toBe('function');
  });

  it('导出 ADR 0007 §11 的七项回填值', () => {
    expect(renderCore.ZOOM_PX_PER_DAY).toStrictEqual({ day: 24, week: 8, month: 3 });
    expect(renderCore.ROW_HEIGHT).toBe(24);
    expect(renderCore.ROW_BUFFER).toBe(5);
    expect(renderCore.AXIS_LEFT_GUTTER_DAYS).toBe(8);
    expect(renderCore.EDGE_STUB_PX).toBe(8);
    expect(renderCore.EDGE_WRAP_PX).toBe(12);
    expect(renderCore.ELEMENT_MODEL).toStrictEqual({ perRenderedRow: 3, perRenderedEdge: 3 });
    expect(renderCore.ARROW_FILL.FS).toBe('solid');
    expect(renderCore.ARROW_FILL.FF).toBe('solid');
    expect(renderCore.ARROW_FILL.SS).toBe('hollow');
    expect(renderCore.ARROW_FILL.SF).toBe('hollow');
    expect(renderCore.SPACING.barHeightRatio).toBe(0.6);
    expect(renderCore.SPACING.summaryBarHeightRatio).toBe(0.35);
    expect(renderCore.SPACING.milestoneSizeRatio).toBe(0.5);
  });

  it('导出确定性夹具生成器（规模口径：测量 / 测试同源）', () => {
    expect(typeof renderCore.mulberry32).toBe('function');
    expect(typeof renderCore.generateDocument).toBe('function');
    expect(typeof renderCore.buildFixture).toBe('function');
    expect(typeof renderCore.scaleGradient).toBe('function');
    expect(renderCore.DATASETS).toHaveLength(3);
    expect(renderCore.PRIMARY_DATASET_KEY).toBe('dense');
    expect(renderCore.REFERENCE_DATASET.links).toBe(2200);
    expect(renderCore.SCALE_GRADIENT_TASKS).toStrictEqual([200, 500, 1000, 2000]);
  });

  it('导出演示计划工厂（演示口径：页面默认文档 / 导出演示与 golden，P-34）', () => {
    expect(typeof renderCore.createDemoPlanDocument).toBe('function');
    const document = renderCore.createDemoPlanDocument();
    expect(document.tasks.length).toBe(15);
    expect(document.links.length).toBe(14);
    expect(document.project.name).toBe('演示计划 · Pilot 项目');
  });

  it('ROUTE_SIDES 是 P-8 第 1 条的可执行副本（唯一登记处仍是 P-8）', () => {
    expect(renderCore.ROUTE_SIDES).toStrictEqual({
      FS: { exit: 'right', enter: 'left' },
      SS: { exit: 'left', enter: 'left' },
      FF: { exit: 'right', enter: 'right' },
      SF: { exit: 'left', enter: 'right' },
    });
  });
});
