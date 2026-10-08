/**
 * **模板 A**：单页总览 = 标题 + 甘特（含左列任务名）+ 图例 + 自动摘要（EX-06）。零 DOM，**进 `pnpm gate`**。
 *
 * ## 管线（与 S1 实证的完全一致）
 *
 * ```
 * pptxgenjs 造容器（版面/母版/主题 + 文本） → JSZip 解包
 *   → 注入原生形状（条 / 进度 / 菱形 / 一级组 / 吸附 connector）
 *   → 归一化时间戳（core.xml 时间字段 + 全部 zip 条目日期）
 *   → 重新打包 → Uint8Array
 * ```
 *
 * **为什么文本走 pptxgenjs、几何走补丁**：文本由库负责最稳（字体/行距/换行是渲染器的约定），
 * 而几何必须由我们说了算——补丁写出的是**同一份 `ViewModel`**（与屏幕、与 SVG 同源）。
 * 反过来说，**补丁是几何的唯一作者**：库的 API 变化不会挪动我们画出来的位置。
 *
 * ## 三条硬约束
 *
 * 1. **零 DOM**：只允许 `outputType: 'uint8array'`（`Blob` 路径留给 `apps/web`）；
 * 2. **容器尺寸读回断言**：`p:sldSz` 必须等于 {@link TEMPLATE_A_PAGE}（S1 教训 1）；
 * 3. **归一化**：ADR 0010 §9 的三步（S7-c 已证字节级 golden 可达）。
 *
 * ## 本目录（P3/C3 的拆分）
 *
 * 原先 1,045 行的单文件按职责拆成：`plan.ts`（布局与适配）、`text.ts`（文本与标签）、
 * `rows.ts`（条/进度/菱形）、`background.ts`（背景层序）、`legend.ts`（图例与开放箭头）、
 * `connectors.ts`（连线与吸附）、`package.ts`（zip 读回与归一化）、`container.ts`（与 pptxgenjs
 * 的唯一接触面），本文件只留**管线 + 回读断言**并按原样再导出公共面。
 *
 * > **调用顺序 = id 分配顺序 = golden 的一部分**：`renderTemplateA` 里
 * > 「逐行形状 → 一级组 → 依赖线 → 背景 → 图例图元」的次序**不得调整**（`IdAllocator` 的编号
 * > 会随之变化 ⇒ 产物字节变化）。
 */

import JSZip from 'jszip';

import { buildIdMap, extractSpTree, groupSpXml, IdAllocator, injectIntoSpTree, NAMES, parseShapeRefs, type GroupChildXml } from '../ooxml.js';
import { pxToInch, TEMPLATE_A_PAGE } from '../units.js';
import { backgroundXmlOf } from './background.js';
import { edgesXmlOf } from './connectors.js';
import { loadPptxGenJS } from './container.js';
import { legendSwatchXmlOf } from './legend.js';
import { normalizePptx, readSlideSize } from './package.js';
import { planTemplateA, type TemplateAInput } from './plan.js';
import { buildRowShapes, type RowShapes } from './rows.js';
import { textLinesOf } from './text.js';

export { loadPptxGenJS, type PptxConstructor, type PptxPresentationLike, type PptxSlideLike, type PptxTextOptions } from './container.js';
export { planTemplateA, slidePointOf, type Box, type TemplateAInput, type TemplateAPlan } from './plan.js';
export { FIXED_TIMESTAMP_ISO, FIXED_ZIP_DATE, normalizePptx, readPptxEntry, readSlideSize } from './package.js';

/**
 * 渲染模板 A（ADR 0010 §1/§5/§9）：容器 → 补丁 → 归一化 → 读回断言。
 *
 * 只允许 `outputType: 'uint8array'`（零 DOM 的硬约束；`Blob` 只出现在 `apps/web`）。
 */
export async function renderTemplateA(input: TemplateAInput): Promise<Uint8Array> {
  const title = input.title ?? input.document.project.name;
  const plan = planTemplateA(input);
  const document = input.document;

  // ---------------------------------------------------------------- 容器（文本走 pptxgenjs）
  const PptxGenJS = await loadPptxGenJS();
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'G7_16_9', width: 10, height: 5.625 });
  pptx.layout = 'G7_16_9';
  pptx.subject = 'GanttPilot 甘特图导出（模板 A）';
  pptx.title = title;
  pptx.author = 'GanttPilot';
  pptx.company = 'GanttPilot';
  const slide = pptx.addSlide();
  for (const line of textLinesOf(plan, document, title)) {
    slide.addText(line.text, {
      x: pxToInch(line.x),
      y: pxToInch(line.y),
      w: pxToInch(line.width),
      h: pxToInch(Math.max(10, line.fontSize * 1.4)),
      fontSize: line.fontSize,
      color: line.color,
      bold: line.bold,
      align: 'left',
      valign: 'top',
      margin: 0,
      objectName: line.objectName,
    });
  }
  const written = await pptx.write({ outputType: 'uint8array' });
  if (!(written instanceof Uint8Array)) throw new Error('pptx.write 未返回 Uint8Array（本包禁止 blob 输出）');

  // ---------------------------------------------------------------- 补丁（几何由我们写）
  const zip = await JSZip.loadAsync(written);
  const slideFile = zip.file('ppt/slides/slide1.xml');
  if (slideFile === null) throw new Error('容器里没有 ppt/slides/slide1.xml');
  const slideXml = await slideFile.async('string');

  const refs = parseShapeRefs(extractSpTree(slideXml));
  buildIdMap(refs); // 容器自身必须自洽（重名/重 id 直接报错）
  const allocator = new IdAllocator(refs);

  // 逐行造形状（按文档序，id 分配因此稳定 ⇒ golden 可复现）
  const shapesOf = new Map<string, RowShapes>();
  for (const row of [...plan.projection.view.rows].sort((left, right) => left.docIndex - right.docIndex)) {
    shapesOf.set(row.id, buildRowShapes({ plan, row, allocator }));
  }

  // 一级组：每个"有可见直接子行"的汇总行一组；包围盒 = 自身条 + 直接子行的形状并集
  const childrenOf = new Map<string, string[]>();
  for (const task of document.tasks) {
    if (task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [task.id]);
    else bucket.push(task.id);
  }
  const groupedXml: string[] = [];
  const groupedRowIds = new Set<string>();
  for (const summary of document.tasks) {
    if (summary.durationDays !== null) continue;
    const members = [summary.id, ...(childrenOf.get(summary.id) ?? [])]
      .map((id) => shapesOf.get(id))
      .filter((entry): entry is RowShapes => entry !== undefined);
    if (members.length < 2) continue; // 只有自己一条不成组
    const fragments = members.flatMap((member) => member.fragments);
    const minX = Math.min(...fragments.map((fragment) => fragment.emu.x));
    const minY = Math.min(...fragments.map((fragment) => fragment.emu.y));
    const maxX = Math.max(...fragments.map((fragment) => fragment.emu.x + fragment.emu.cx));
    const maxY = Math.max(...fragments.map((fragment) => fragment.emu.y + fragment.emu.cy));
    const childXml: GroupChildXml[] = fragments.map((fragment) => ({ id: -1, name: 'child', xml: fragment.xml }));
    groupedXml.push(
      groupSpXml({
        id: allocator.next(),
        name: NAMES.group(summary.id),
        frame: { x: minX, y: minY, cx: Math.max(1, maxX - minX), cy: Math.max(1, maxY - minY) },
        children: childXml,
      }),
    );
    for (const id of [summary.id, ...(childrenOf.get(summary.id) ?? [])]) groupedRowIds.add(id);
  }

  const ungroupedXml = plan.projection.view.rows
    .filter((row) => !groupedRowIds.has(row.id))
    .flatMap((row) => shapesOf.get(row.id)?.fragments.map((fragment) => fragment.xml) ?? []);

  // 依赖线（id 分配必须在背景/图例之前——见文件头的"调用顺序"）
  const edgeXml = edgesXmlOf({
    plan,
    shapesOf,
    allocator,
    degradeConnectors: input.degradeConnectors === true,
  });

  // 注入顺序 = 绘制顺序：**背景（灰度带 + 网格线）→ 图例图元 → 组/条 → 依赖线**
  const backgroundXml = backgroundXmlOf({ plan, allocator });
  const legendSwatchXml = legendSwatchXmlOf({ plan, allocator });
  const patched = injectIntoSpTree(
    slideXml,
    [...backgroundXml, ...legendSwatchXml, ...groupedXml, ...ungroupedXml, ...edgeXml].join(''),
  );
  const bytes = await normalizePptx(written, patched);

  // ---------------------------------------------------------------- 读回断言（S1 教训 1）
  const size = await readSlideSize(bytes);
  if (size.cx !== TEMPLATE_A_PAGE.widthEmu || size.cy !== TEMPLATE_A_PAGE.heightEmu) {
    throw new Error(
      `容器 p:sldSz 与声明不一致：实测 ${String(size.cx)}×${String(size.cy)}，` +
        `声明 ${String(TEMPLATE_A_PAGE.widthEmu)}×${String(TEMPLATE_A_PAGE.heightEmu)}`,
    );
  }
  return bytes;
}
