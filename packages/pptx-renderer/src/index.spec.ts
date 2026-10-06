/**
 * `@ganttpilot/pptx-renderer` 公共入口（手法同 engine / render-core 的 `index.spec.ts`：
 * 断言**面齐全**而不是逐个实现细节——面被误删/改名时立即失败）。
 */

import { describe, expect, it } from 'vitest';

import * as pptx from './index.js';

describe('@ganttpilot/pptx-renderer 公共入口', () => {
  it('导出包标识与能力块', () => {
    expect(pptx.PPTX_RENDERER_VERSION).toBe('0.0.0');
    expect(pptx.PLANNED_GATE).toBe('G8');
    expect(pptx.COMPLETED_GATES).toStrictEqual(['G7', 'G8']);
  });

  it('导出模板 A 的渲染面与布局面（ADR 0010）', () => {
    expect(typeof pptx.renderTemplateA).toBe('function');
    expect(typeof pptx.planTemplateA).toBe('function');
    expect(typeof pptx.slidePointOf).toBe('function');
    expect(typeof pptx.readSlideSize).toBe('function');
    expect(typeof pptx.readPptxEntry).toBe('function');
    expect(typeof pptx.normalizePptx).toBe('function');
    expect(typeof pptx.loadPptxGenJS).toBe('function');
    expect(pptx.FIXED_TIMESTAMP_ISO).toBe('2000-01-01T00:00:00Z');
  });

  it('导出 OOXML 构造面（形状 / connector / group / custGeom）与站点表', () => {
    expect(pptx.SITES).toStrictEqual({ top: 0, left: 1, bottom: 2, right: 3 });
    expect(pptx.SITE_COUNT).toBe(4);
    expect(pptx.siteForSide('right')).toBe(3);
    expect(pptx.siteForSide('left')).toBe(1);
    const surface = pptx as unknown as Record<string, unknown>;
    for (const name of [
      'barSpXml',
      'progressSpXml',
      'plainRectSpXml',
      'triangleSpXml',
      'milestoneSpXml',
      'connectorSpXml',
      'custGeomSpXml',
      'groupSpXml',
      'injectIntoSpTree',
      'extractSpTree',
      'parseShapeRefs',
      'buildIdMap',
    ]) {
      expect(typeof surface[name]).toBe('function');
    }
    expect(typeof pptx.IdAllocator).toBe('function');
    expect(pptx.NAMES.bar('t1')).toBe('bar-t1');
    expect(pptx.NAMES.milestone('m1')).toBe('ms-m1');
    expect(pptx.NAMES.edge('l1')).toBe('dep-l1');
    expect(pptx.NAMES.group('s1')).toBe('grp-s1');
    // 返工新增的四类图元名（人工复验 §1–§4）
    expect(pptx.NAMES.axis(3)).toBe('axis-3');
    expect(pptx.NAMES.band(1)).toBe('band-1');
    expect(pptx.NAMES.grid(2)).toBe('grid-2');
    expect(pptx.NAMES.legendSwatch('edge-FS')).toBe('legend-swatch-edge-FS');
  });

  it('导出单位与页面常量（S1 教训 1：页面常量必须与容器实测一致）', () => {
    expect(pptx.EMU_PER_PT).toBe(12700);
    expect(pptx.pxToPt(96)).toBeCloseTo(72, 10);
    expect(pptx.pxToEmu(96)).toBe(914400);
    expect(pptx.TEMPLATE_A_PAGE).toStrictEqual({ widthEmu: 9144000, heightEmu: 5143500, widthPt: 720, heightPt: 405 });
    expect(pptx.TEMPLATE_A_PAGE_PX).toStrictEqual({ width: 960, height: 540 });
    expect(pptx.TEMPLATE_A_SIDEBAR_PX).toBe(260);
  });

  it('导出指纹面（golden 判据的载体；**不含 node:crypto**，理由见 fingerprint.ts 文件头）', () => {
    expect(typeof pptx.bytesEqual).toBe('function');
    expect(typeof pptx.crc32Hex).toBe('function');
    expect(typeof pptx.entryDigests).toBe('function');
    expect(typeof pptx.diffDigests).toBe('function');
    // CRC-32 标准向量（"123456789" → 0xCBF43926）
    expect(pptx.crc32Hex(new TextEncoder().encode('123456789'))).toBe('cbf43926');
  });
});
