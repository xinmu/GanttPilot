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
  buildExportView,
  buildFixture,
  createDemoPlanDocument,
  createScheduleCalendar,
  DATASETS,
  EXPORT_LABEL_WIDTH_PX,
  exportLabelTextOf,
  exportLegendItems,
  exportSummaryLines,
  exportSummaryOf,
  LABEL_CHAR_PX,
  PRIMARY_DATASET_KEY,
  svgString,
} from '@ganttpilot/render-core';

import { bytesEqual, entryDigests, diffDigests } from './fingerprint.js';
import { buildIdMap, parseShapeRefs, extractSpTree } from './ooxml.js';
import { planTemplateA, renderTemplateA, readPptxEntry, readSlideSize, FIXED_TIMESTAMP_ISO } from './template/index.js';
import { TEMPLATE_A_PAGE, TEMPLATE_A_PAGE_PX } from './units.js';

function demoFixture() {
  const document = createDemoPlanDocument();
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) throw new Error('演示计划不可排程');
  return { document, calendar, schedule: result.schedule };
}

function denseFixture() {
  // `noUncheckedIndexedAccess` 下 `DATASETS.find(...)` 是 `FixtureSpec | undefined`，
  // `generateDocument(spec).document` 于是报 TS2345（旧 program 不含 spec ⇒ 从未被看见）。
  // 这里改用本包公开的**装配口** `buildFixture`：它做的事与下面三行逐条相同
  // （`reindexDocument` → `validateDocument` 无 error → `createScheduleCalendar` → `compute`），
  // 并且直接给出 `{ document, calendar, schedule }`，不需要在 spec 里再写一遍取用逻辑。
  const found = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY);
  if (found === undefined) throw new Error(`未知数据集 key：${String(PRIMARY_DATASET_KEY)}`);
  return buildFixture(found);
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

    const badIdx = slideXml.replace('idx="3"/>', 'idx="4"/>');
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

describe('模板 A · 人工复验四项返工（ADR 0010 增补 §1–§4）', () => {
  it('① 日期刻度：刻度文本框数 == `view.axis` 的 label 数，且文案逐条相同', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const projection = buildExportView({ ...fixture, zoom: 'week' });
    const expected = projection.view.axis.filter((element) => element.kind === 'label').map((element) => element.text);
    expect(expected.length).toBeGreaterThan(0);
    const actual = [...slideXml.matchAll(/name="axis-\d+"[\s\S]{0,1200}?<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
    expect(actual).toStrictEqual(expected);
  });

  /**
   * **P-46 的两级刻度必须同时进 PPTX**（ADR 0007 附录 §3 的硬约束：跨投影同步）。
   *
   * 三条判据：
   * 1. 上级分段带的三个投影（**绘制区正文 / 全高边界 / 表头底**）都在，且
   *    `major-band-N` 的条数 == `view.axis` 的 `major-band` 数（与屏幕/SVG 逐条同源）；
   * 2. **大刻度在上、小刻度在下**：同一份 `view.axis` 的 `level` 决定基线——
   *    这是"两行"这件事在 PPTX 里的可判定形式（只画一行会立刻红）；
   * 3. 上级标签数严格少于下级（日档）——"段内只写一次"的判别力。
   */
  it('①-b 两级刻度：上级分段带与上级标签同步进 PPTX，且两行基线不同', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'day' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const projection = buildExportView({ ...fixture, zoom: 'day' });
    const majorBands = projection.view.axis.filter((element) => element.kind === 'major-band');
    const majorLabels = projection.view.axis.filter((element) => element.kind === 'label' && element.level === 1);
    const minorLabels = projection.view.axis.filter((element) => element.kind === 'label' && element.level !== 1);
    expect(majorBands.length).toBeGreaterThan(0);
    expect(majorLabels.length).toBe(majorBands.length);
    expect(majorLabels.length).toBeLessThan(minorLabels.length);
    expect(slideXml.match(/name="major-band-\d+"/g) ?? []).toHaveLength(majorBands.length);

    // PPTX 的文本框 `y` 由 `slidePointOf(plan, x, baseline)` 给出：两者都是 `baseline × scale` 的单调函数，
    // 因此"上级标签的 y 严格小于下级标签的 y"就是"**大刻度在上**"的可判定形式（不带像素口径；
    // 行序在 G8 人工复验第 ③ 条被订正为首版的反面）。
    const yOfAxisName = (index: number): number =>
      Number(new RegExp(`name="axis-${String(index)}"[\\s\\S]{0,600}?<a:off x="-?\\d+" y="(-?\\d+)"`).exec(slideXml)?.[1] ?? '-1');
    const axisOrder = projection.view.axis;
    const yOfLevel = (level: 1 | 2): readonly number[] =>
      axisOrder
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => element.kind === 'label' && (element.level ?? 2) === level)
        .map(({ index }) => yOfAxisName(index));
    const minorYs = yOfLevel(2);
    const majorYs = yOfLevel(1);
    expect(minorYs.length).toBeGreaterThan(0);
    /**
     * **大刻度在上、小刻度在下**（G8 人工复验第 ③ 条订正）。
     *
     * PPTX 的文本框 `y` 由 `slidePointOf(plan, x, baseline)` 给出：两者都是 `baseline × scale`
     * 的单调函数，因此"上级标签的 y 全都小于下级标签的 y"就是"上级在第一行"的可判定形式。
     */
    expect(Math.max(...majorYs)).toBeLessThan(Math.min(...minorYs));
  });

  it('② 背景：周末/节假日灰度带在绘制区、刻度线在表头带，且**都在条形之下**', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const projection = buildExportView({ ...fixture, zoom: 'week' });
    const bands = projection.view.axis.filter((element) => element.kind === 'band').length;
    const grids = projection.view.axis.filter((element) => element.kind === 'gridline').length;
    expect(bands).toBeGreaterThan(0);
    expect(grids).toBeGreaterThan(0);
    expect(slideXml.match(/name="band-\d+"/g)).toHaveLength(bands);
    expect(slideXml.match(/name="grid-\d+"/g)).toHaveLength(grids);

    /**
     * **刻度线只画在表头带内**（G8 人工复验第 ⑤ 条：首版把刻度线画满了绘制区 ⇒
     * "刻度线画到了条体区"）。判据：`grid-*` 形状的**高度**必须明显小于 `band-*` 的
     * （带是整高、刻度是表头带里的短线），且刻度线整体落在表头带的上沿附近。
     */
    const heightOf = (name: string): number =>
      Number(new RegExp(`name="${name}"[\\s\\S]{0,300}?<a:ext cx="\\d+" cy="(\\d+)"`).exec(slideXml)?.[1] ?? '-1');
    const bandHeight = heightOf('band-0');
    const gridHeight = heightOf('grid-0');
    expect(bandHeight).toBeGreaterThan(0);
    expect(gridHeight).toBeGreaterThan(0);
    expect(gridHeight).toBeLessThan(bandHeight / 4);

    // 绘制顺序：背景（周末带 → 月份正文 → 表头底/边界 → 刻度）→ 条形 → 依赖线
    const order = ['name="major-band-0"', 'name="band-0"', 'name="grid-0"', 'name="bar-s1"', '<p:cxnSp>'].map((needle) =>
      slideXml.indexOf(needle),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toStrictEqual([...order].sort((left, right) => left - right));
  });

  it('③ 箭头：FS/FF 实心三角、SS/SF 开放箭头（原生 `type="arrow"`）——**都带 `tailEnd`，因此都会跟随端点**', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const types = fixture.document.links.map((link) => link.type);
    const solid = types.filter((type) => type === 'FS' || type === 'FF').length;
    const open = types.filter((type) => type === 'SS' || type === 'SF').length;
    expect(slideXml.match(/<p:cxnSp>/g)).toHaveLength(types.length);
    expect(slideXml.match(/<a:tailEnd type="triangle"/g)).toHaveLength(solid);
    expect(slideXml.match(/<a:tailEnd type="arrow"/g)).toHaveLength(open);
    // **每条**依赖线都带 tailEnd（P-38：不接受"没有吸附锚点的自绘箭头"——它不会跟随端点）
    expect(slideXml.match(/<a:tailEnd/g)).toHaveLength(types.length);
    expect(slideXml.match(/name="dep-l\d+-head"/g)).toBeNull();
    expect(slideXml.match(/<a:headEnd/g)).toBeNull();
  });

  it('④ 图例/摘要与 SVG 同源：条目文案取自 `exportLegendItems`/`exportSummaryLines`，且每条都有图元', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const summary = exportSummaryOf({ ...fixture });

    // 文案：图例 7 条 + 摘要行，逐字与共享函数一致
    const texts = [...slideXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
    for (const item of exportLegendItems()) expect(texts).toContain(item.label);
    const lines = exportSummaryLines(summary);
    for (const line of [...lines.headline, ...lines.milestones]) expect(texts).toContain(line);
    expect(texts).not.toContain('任务：蓝条'); // 旧的"PPTX 自己写一套文案"必须消失

    // 图元：条/汇总/里程碑 + 四类依赖（线 + 箭头）
    for (const key of ['bar', 'bar-summary', 'milestone', 'edge-FS', 'edge-SS', 'edge-FF', 'edge-SF']) {
      expect(slideXml).toContain(`name="legend-swatch-${key}"`);
    }
    for (const key of ['edge-FS', 'edge-SS', 'edge-FF', 'edge-SF']) {
      // 实心两类 = 三角；开放两类 = 两条臂（与画布的 `type="arrow"` 同形）
      const head =
        key === 'edge-SS' || key === 'edge-SF'
          ? `name="legend-swatch-${key}-head-arm1"`
          : `name="legend-swatch-${key}-head"`;
      expect(slideXml).toContain(head);
    }
    // 箭头颜色：四种都是边色（深灰）——形态差别在"实心三角 vs 开放箭头"，不在颜色
    const swatchFill = (key: string): string =>
      new RegExp(`name="legend-swatch-${key}-head[^"]*"[\\s\\S]{0,600}?<a:srgbClr val="([0-9A-F]{6})"`).exec(slideXml)?.[1] ??
      '(未找到)';
    expect(swatchFill('edge-FS')).toBe('475467');
    expect(swatchFill('edge-SS')).toBe('475467');
  });

  it('⑤ 样式：汇总行标签加粗、子行按缩进右移，且标签文本与 SVG 逐字相同', async () => {
    const fixture = demoFixture();
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    const runOf = (name: string): string =>
      new RegExp(`name="${name}"[\\s\\S]{0,1200}?<a:rPr([^>]*)>`).exec(slideXml)?.[1] ?? '(未找到)';
    expect(runOf('lbl-s1')).toContain('b="1"');
    expect(runOf('lbl-t1')).not.toContain('b="1"');
    const offXOf = (name: string): number =>
      Number(new RegExp(`name="${name}"[\\s\\S]{0,900}?<a:off x="(\\d+)"`).exec(slideXml)?.[1] ?? '-1');
    expect(offXOf('lbl-t1')).toBeGreaterThan(offXOf('lbl-s1'));

    // 与 SVG 同源：每一行的标签文本逐字相同
    const projection = buildExportView({ ...fixture, zoom: 'week' });
    const svg = svgString({ view: projection.view, document: fixture.document });
    const texts = [...slideXml.matchAll(/name="lbl-[^"]+"[\s\S]{0,1200}?<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
    for (const row of projection.view.rows) {
      const task = fixture.document.tasks.find((item) => item.id === row.id);
      const text = exportLabelTextOf({
        task,
        fallback: row.id,
        availablePx: EXPORT_LABEL_WIDTH_PX,
        charPx: LABEL_CHAR_PX,
      });
      expect(texts).toContain(text);
      expect(svg).toContain(`>${text}</text>`);
    }
    expect(texts).toHaveLength(projection.view.rows.length);
  });
  it('⑦ 图例与侧栏排版：图元**垂直居中**于文本、左右间距 ≥ 8 px、侧栏内容与甘特**同基准居中**', async () => {
    const fixture = demoFixture();
    const plan = planTemplateA({ ...fixture, zoom: 'week' });
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');

    // ① 图元的垂直中心 == 文本行的中心（`legendRows[i].y`）——人工复验第 3 条
    for (const row of plan.legendRows) {
      const key = row.item.styleKey;
      const rect = new RegExp(`name="legend-swatch-${key}"[\\s\\S]{0,500}?<a:off x="-?\\d+" y="(-?\\d+)"/><a:ext cx="\\d+" cy="(\\d+)"`).exec(slideXml);
      expect(rect).not.toBeNull();
      const topEmu = Number(rect?.[1]);
      const heightEmu = Number(rect?.[2]);
      const centerPx = (topEmu + heightEmu / 2) / (12700 * (72 / 96));
      expect(Math.abs(centerPx - row.y)).toBeLessThan(1.5);
    }

    // ② 图元右缘到文本左缘的净间距 ≥ 8 px（色块占 [x+6, x+24]，文本从 x+34 起）
    const textX = Number(/name="legend-1"[\s\S]{0,900}?<a:off x="(\d+)"/.exec(slideXml)?.[1] ?? '0') / (12700 * (72 / 96));
    const swatchRight = plan.sidebarBox.x + 6 + 18;
    expect(textX - swatchRight).toBeGreaterThanOrEqual(8);

    // ③ 侧栏内容块与甘特内容块**同基准居中**（判据：中心差 < 6 px；演示计划实测 0 px）——人工复验第 4 条
    const sidebarCenter = plan.sidebarContentTop + plan.sidebarContentHeight / 2;
    const ganttCenter = plan.ganttBox.y + plan.fit.offsetY + (plan.projection.innerHeight * plan.fit.scale) / 2;
    expect(Math.abs(sidebarCenter - ganttCenter)).toBeLessThan(6);
  });
  it('⑧ 图例的箭头形态与画布**同形**，且开放箭头**朝向正确**（"→"而不是"<"）', async () => {
    const fixture = demoFixture();
    const plan = planTemplateA({ ...fixture, zoom: 'week' });
    const bytes = await renderTemplateA({ ...fixture, zoom: 'week' });
    const slideXml = await readPptxEntry(bytes, 'ppt/slides/slide1.xml');
    // 实心两类：三角形 preset
    for (const key of ['edge-FS', 'edge-FF']) {
      expect(new RegExp(`name="legend-swatch-${key}-head"[\\s\\S]{0,600}?prst="triangle"`).test(slideXml)).toBe(true);
    }

    const pxOf = (emu: number): number => emu / (12700 * (72 / 96));
    /** 由 `<a:xfrm rot>` + `<a:off>/<a:ext>` 还原一条臂的**两个端点**（px，旋转绕包围盒中心）。 */
    const endsOf = (name: string): readonly (readonly [number, number])[] => {
      const m = new RegExp(
        `name="${name}"[\\s\\S]{0,700}?<a:xfrm(?: rot="(-?\\d+)")?><a:off x="(-?\\d+)" y="(-?\\d+)"/><a:ext cx="(\\d+)" cy="(\\d+)"`,
      ).exec(slideXml);
      expect(m).not.toBeNull();
      if (m === null) return [];
      const theta = (Number(m[1] ?? '0') / 60_000) * (Math.PI / 180);
      const left = pxOf(Number(m[2]));
      const top = pxOf(Number(m[3]));
      const cx = pxOf(Number(m[4]));
      const cy = pxOf(Number(m[5]));
      const centerX = left + cx / 2;
      const centerY = top + cy / 2;
      const half = cx / 2;
      return [
        [centerX + half * Math.cos(theta), centerY + half * Math.sin(theta)],
        [centerX - half * Math.cos(theta), centerY - half * Math.sin(theta)],
      ];
    };

    for (const row of plan.legendRows) {
      const key = row.item.styleKey;
      if (key !== 'edge-SS' && key !== 'edge-SF') continue;
      const tipX = plan.sidebarBox.x + 6 + 23;
      const tipY = row.y;
      for (const arm of ['arm1', 'arm2']) {
        const ends = endsOf(`legend-swatch-${key}-head-${arm}`);
        expect(ends).toHaveLength(2);
        // 一条端点必须落在尖端（≤0.6 px）：尖角由两条臂**交于右端**构成
        const atTip = ends.some(([ex, ey]) => Math.hypot(ex - tipX, ey - tipY) < 0.6);
        expect(atTip).toBe(true);
        // 另一条端点必须在**左侧** ⇒ 尖角朝右（"→"；写反 rot 会得到"<"）
        const farEnd = ends.find(([ex, ey]) => Math.hypot(ex - tipX, ey - tipY) >= 0.6);
        expect(farEnd).toBeDefined();
        expect(farEnd?.[0] ?? tipX).toBeLessThan(tipX - 3);
      }
    }
    // 开放两类不再用三角形 preset
    for (const key of ['edge-SS', 'edge-SF']) {
      expect(new RegExp(`name="legend-swatch-${key}-head"[\\s\\S]{0,400}?prst="triangle"`).test(slideXml)).toBe(false);
    }
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

