/**
 * 模板 A 的判据（**进 `pnpm gate`**，ADR 0010 §5/§6/§9/§11）。
 *
 * 覆盖面：
 * 1. **结构**：`p:sldSz` 与声明一致、形状 id 全树唯一、`stCxn/endCxn` 的站点合法且指向存在的形状、
 *    一级 `p:grpSp` 有显式 `chOff/chExt` 且与 `off/ext` 等比、**不写 `cxnSpLocks`**；
 * 2. **golden**：同一文档两次导出**逐字节相等**（出口条件⑤）；
 * 3. **负向对照**：错 idx / 复用 id / 非等比组 —— 必须被检出（否则上面的绿是恒真式）；
 * 4. **降级②**：`custGeom` 折线替代 connector 后仍是合法形状；
 * 5. **可读性纪律**：行标签只在行高撑得下时画（1,000 行不生成上千个文本框）。
 */

import { describe, expect, it } from 'vitest';
import { compute } from '@ganttpilot/engine';
import {
  createDemoPlanDocument,
  createScheduleCalendar,
  DATASETS,
  generateDocument,
  PRIMARY_DATASET_KEY,
  reindexDocument,
} from '@ganttpilot/render-core';

import { bytesEqual, entryDigests, diffDigests } from './fingerprint.js';
import { buildIdMap, parseShapeRefs, extractSpTree } from './ooxml.js';
import { planTemplateA, renderTemplateA, readPptxEntry, readSlideSize, FIXED_TIMESTAMP_ISO } from './template.js';
import { TEMPLATE_A_PAGE, TEMPLATE_A_PAGE_PX } from './units.js';

function demoFixture() {
  const document = createDemoPlanDocument();
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) throw new Error('演示计划不可排程');
  return { document, calendar, schedule: result.schedule };
}

function denseFixture() {
  const document = reindexDocument(generateDocument(DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY)).document);
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) throw new Error('dense 夹具不可排程');
  return { document, calendar, schedule: result.schedule };
}

/** 结构自检（判据本体；负向对照直接复用同一份实现 ⇒ 它真的在判"合法性"）。 */
function structureViolations(slideXml: string): readonly string[] {
  const violations: string[] = [];
  const refs = parseShapeRefs(extractSpTree(slideXml));
  try {
    buildIdMap(refs);
  } catch (error) {
    violations.push(`id/name 冲突：${error instanceof Error ? error.message : String(error)}`);
  }
  const ids = new Set(refs.map((ref) => ref.id));

  const anchors = [...slideXml.matchAll(/<a:(stCxn|endCxn) id="(\d+)" idx="(\d+)"/g)];
  for (const match of anchors) {
    const targetId = Number(match[2]);
    const idx = Number(match[3]);
    if (!ids.has(targetId)) violations.push(`${String(match[1])} 指向不存在的形状 id=${String(targetId)}`);
    if (!(idx >= 0 && idx <= 3)) violations.push(`${String(match[1])} 的 idx=${String(idx)} 越界（roundRect 只有 0..3）`);
  }
  if (/cxnSpLocks/.test(slideXml)) violations.push('写入了 <a:cxnSpLocks/>（WPS 原生产物不含它）');

  for (const match of slideXml.matchAll(/<p:grpSp>[\s\S]*?<\/p:grpSp>/g)) {
    const block = match[0];
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
    const chOff = /<a:chOff x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
    const chExt = /<a:chExt cx="(\d+)" cy="(\d+)"\/>/.exec(block);
    if (off === null || ext === null || chOff === null || chExt === null) {
      violations.push('grpSp 缺少显式 off/ext 或 chOff/chExt');
      continue;
    }
    const childCount = (block.match(/<p:sp>/g) ?? []).length;
    if (childCount === 0) violations.push('grpSp 没有子形状');
    // 等比：本实现取 chExt == ext（scale 1）
    if (chExt[1] !== ext[1] || chExt[2] !== ext[2]) {
      violations.push(`grpSp 非等比：ext=${String(ext[1])}×${String(ext[2])} chExt=${String(chExt[1])}×${String(chExt[2])}`);
    }
  }
  return violations;
}

describe('模板 A · 结构（ADR 0010 §5）', () => {
  it('页面尺寸与声明一致；容器/组/锚点/连接线都在', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const size = await readSlideSize(bytes);
    expect(size).toStrictEqual({ cx: TEMPLATE_A_PAGE.widthEmu, cy: TEMPLATE_A_PAGE.heightEmu });

    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    expect(structureViolations(slideXml)).toStrictEqual([]);
    expect(slideXml.match(/<p:cxnSp>/g)).toHaveLength(14);
    expect(slideXml.match(/<p:grpSp>/g)).toHaveLength(3);
    expect(slideXml).toContain('<a:prstGeom prst="bentConnector3">');
    expect(slideXml).toContain('<a:prstGeom prst="diamond">');
    expect(slideXml).not.toContain('cxnSpLocks');
    // 条名按任务 id 命名（人工在 WPS 里也能直接对上）
    expect(slideXml).toContain('name="bar-t1"');
    expect(slideXml).toContain('name="ms-m1"');
    expect(slideXml).toContain('name="dep-l1"');
  });

  it('父子的 `grpSp` 指向**正确的子形状集合**（一级分组）', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const group = /<p:grpSp>[\s\S]*?<\/p:grpSp>/.exec(slideXml)?.[0] ?? '';
    expect(group).toContain('name="grp-s1"');
    // 阶段一：汇总条 + t1..t3 的条与进度 + m1 菱形
    expect(group).toContain('name="bar-s1"');
    expect(group).toContain('name="bar-t1"');
    expect(group).toContain('name="ms-m1"');
    expect(group).not.toContain('name="bar-t5"'); // 别的阶段不在这一组里
  });

  it('依赖线两端**吸附在条形上**（站点来自 P-8 的侧向表，不是硬编码）', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const refs = parseShapeRefs(extractSpTree(slideXml));
    const idOf = new Map(refs.map((ref) => [ref.name, ref.id]));
    // l1 = t1 → t2，FS ⇒ 右出（idx=3）→ 左入（idx=1）
    const block = /<p:cxnSp>[\s\S]*?name="dep-l1"[\s\S]*?<\/p:cxnSp>/.exec(slideXml)?.[0] ?? '';
    expect(block).toContain(`<a:stCxn id="${String(idOf.get('bar-t1'))}" idx="3"/>`);
    expect(block).toContain(`<a:endCxn id="${String(idOf.get('bar-t2'))}" idx="1"/>`);
    // l2 = t1 → t3，SS ⇒ 左出（idx=1）→ 左入（idx=1）
    const ss = /<p:cxnSp>[\s\S]*?name="dep-l2"[\s\S]*?<\/p:cxnSp>/.exec(slideXml)?.[0] ?? '';
    expect(ss).toContain(`idx="1"/>`);
  });
});

describe('模板 A · golden（出口条件⑤）', () => {
  it('同一文档两次导出**逐字节相等**；归一化把时间戳钉死', async () => {
    const fixture = demoFixture();
    const first = await renderTemplateA({ ...fixture, zoom: 'week' });
    const second = await renderTemplateA({ ...fixture, zoom: 'week' });
    expect(bytesEqual(first, second)).toBe(true);

    const digests = await entryDigests(first);
    const core = digests.find((entry) => entry.name === 'docProps/core.xml');
    expect(core).toBeDefined();
    const coreXml = await readPptxEntry(first, 'docProps/core.xml');
    expect(coreXml).toContain(FIXED_TIMESTAMP_ISO);
    expect(diffDigests(digests, await entryDigests(second))).toStrictEqual([]);
    // 归一化后条目日期是固定值（zip 的 DOS 时间口径）
    expect(digests.every((entry) => entry.dateIso.startsWith('2000-01-01'))).toBe(true);
  });
});

describe('模板 A · 负向对照（判据必须有判别力）', () => {
  it('站点越界 / 引用不存在的形状 / 复用 id / 非等比组 —— 逐条必须被检出', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    expect(structureViolations(slideXml)).toStrictEqual([]); // 前提自证：正例干净

    const badIdx = slideXml.replace('<a:stCxn id=', '<a:stCxn id=').replace('idx="3"/>', 'idx="4"/>');
    expect(structureViolations(badIdx).some((item) => item.includes('越界'))).toBe(true);

    const dangling = slideXml.replace(/<a:endCxn id="\d+"/, '<a:endCxn id="99999"');
    expect(structureViolations(dangling).some((item) => item.includes('不存在的形状'))).toBe(true);

    const locks = slideXml.replace('</p:nvCxnSpPr>', '<a:cxnSpLocks/></p:nvCxnSpPr>');
    expect(structureViolations(locks).some((item) => item.includes('cxnSpLocks'))).toBe(true);

    // 非等比组：只改**组内**的 chExt（slide 根的 spTreePr 也有一个 chExt，先定位到 grpSp 内）
    const nonEqualGroup = slideXml.replace(
      /(<p:grpSp>[\s\S]*?)<a:chExt cx="\d+" cy="\d+"\/>/,
      '$1<a:chExt cx="7" cy="7"/>',
    );
    expect(structureViolations(nonEqualGroup).some((item) => item.includes('非等比'))).toBe(true);

    // id 复用：把**全部** connector 的 id 改成同一个值（同一 id 被多个形状共用必须被检出）
    const firstId = /<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="(\d+)"/.exec(slideXml)?.[1] ?? '0';
    const reuse = slideXml.replace(/(<p:cxnSp><p:nvCxnSpPr><p:cNvPr id=")\d+(")/g, `$1${firstId}$2`);
    expect(structureViolations(reuse).length).toBeGreaterThan(0);
  });
});

describe('模板 A · 降级②（ADR 0010 §6）', () => {
  it('`degradeConnectors` 时用 `custGeom` 折线替代 connector（仍是原生形状）', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week', degradeConnectors: true });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    expect(slideXml).not.toContain('<p:cxnSp>');
    expect(slideXml.match(/<a:custGeom>/g)).toHaveLength(14);
    expect(slideXml.match(/<a:lnTo>/g)).toHaveLength(28); // 每条折线 3 点 ⇒ 2 段
    expect(structureViolations(slideXml)).toStrictEqual([]);
  });
});

describe('模板 A · 布局与可读性纪律（ADR 0010 §7/§11）', () => {
  it('甘特区与侧栏不重叠；适配等比', () => {
    const fixture = demoFixture();
    const plan = planTemplateA({ ...fixture, zoom: 'week' });
    expect(plan.ganttBox.x + plan.ganttBox.width).toBeLessThan(plan.sidebarBox.x);
    expect(plan.sidebarBox.x + plan.sidebarBox.width).toBeLessThanOrEqual(TEMPLATE_A_PAGE_PX.width);
    expect(plan.fit.scale).toBeGreaterThan(0);
    expect(plan.rowHeightPt).toBeGreaterThan(6);
    expect(plan.labelFontPt).toBeGreaterThanOrEqual(6);
  });

  it('1,000 行：行高压到不可读 ⇒ **不画任何行标签**（不生成上千个文本框）', async () => {
    const fixture = denseFixture();
    const plan = planTemplateA({ ...fixture, zoom: 'day' });
    expect(plan.labelFontPt).toBeLessThan(6);
    const bytes = await renderTemplateA({ ...fixture, zoom: 'day' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    expect(slideXml).not.toContain('name="lbl-');
    // 条形仍然全画（导出=全量渲染），只是没有文字标签
    expect(slideXml).toContain('name="bar-t1"');
  });
});
