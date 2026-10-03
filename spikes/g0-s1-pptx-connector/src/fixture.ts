/**
 * fixture 生成：用 pptxgenjs 造出「容器骨架」，再在 zip 层重写 `slide1.xml` 注入补丁。
 *
 * 本文件只负责 **容器**（形状 + 打包/解包），补丁由 `patch.ts` 负责。
 * 之所以复用 pptxgenjs 的容器而不是手写整个 OOXML 包：协议（证伪实验计划 Day 1 第 2 步）
 * 明确要求「同时验证容器可打补丁」——即真实管线（G7 会用 pptxgenjs + JSZip）的可行性。
 */

import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';

import { BAR_A, BAR_B, MS_1, SHAPES, emuToPx } from './manifest.ts';
import { SLIDE_XML_PATH, PRESENTATION_XML_PATH, extractSpTree, parseShapeRefs, parseSlideSize, type ShapeRef } from './xml.ts';

/** 每个形状在容器中的创建顺序（决定 pptxgenjs 分配的 id = idx + 2）。 */
export const CREATION_ORDER = [BAR_A, BAR_B, MS_1] as const;

/** 容器构建结果。 */
export interface Container {
  /** 未打补丁的 pptx 字节。 */
  readonly bytes: Uint8Array;
  /** 容器里形状的 `name → id` 解析结果（补丁器的输入）。 */
  readonly refs: ShapeRef[];
  /** 容器原始 `slide1.xml`。 */
  readonly slideXml: string;
}

/**
 * 构建 pptxgenjs 容器：两个圆角矩形任务条 + 一个菱形里程碑。
 *
 * 注意 `objectName`：pptxgenjs 把它写进 `<p:cNvPr name="…">`，这正是补丁器
 * 用来定位形状的**稳定锚点**（id 会随创建顺序变化，name 不会）。
 * 形状尺寸使用幻灯片 960×540 pt 的 EMU 几何，按 96px/英寸换算成 pptxgenjs 的英寸口径。
 */
export async function buildContainer(): Promise<Container> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'S1_16_9', width: 10, height: 5.625 });
  pptx.layout = 'S1_16_9';
  pptx.subject = 'G0-S-S1 spike container';

  const slide = pptx.addSlide();

  const px = (emu: number): number => emuToPx(emu) / 96; // 英寸

  for (const name of CREATION_ORDER) {
    const rect = SHAPES[name];
    if (rect === undefined) throw new Error(`manifest 缺少形状 ${name}`);
    const isMilestone = name === MS_1;
    slide.addShape(isMilestone ? 'diamond' : 'roundRect', {
      x: px(rect.x),
      y: px(rect.y),
      w: px(rect.cx),
      h: px(rect.cy),
      objectName: name,
      fill: { color: isMilestone ? 'ED7D31' : name === BAR_A ? '2E75B6' : 'C00000' },
      line: { color: '404040', width: 0.75 },
    });
  }

  const written = await pptx.write({ outputType: 'uint8array' });
  if (!(written instanceof Uint8Array)) {
    throw new Error('pptx.write 未返回 Uint8Array');
  }

  const slideXml = await readSlideXml(written);
  const refs = parseShapeRefs(extractSpTree(slideXml));
  return { bytes: written, refs, slideXml };
}

/** 从 pptx 字节中读出 `ppt/slides/slide1.xml`。 */
export async function readSlideXml(bytes: Uint8Array): Promise<string> {
  return readEntry(bytes, SLIDE_XML_PATH);
}

/** 从 pptx 字节中读出任一文本 entry。 */
export async function readEntry(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  if (file === null) {
    throw new Error(`容器中找不到 ${path}`);
  }
  return file.async('string');
}

/** 读出容器的幻灯片尺寸（EMU），用于校验 manifest 的 `SLIDE` 未与容器漂移。 */
export async function readSlideSize(bytes: Uint8Array): Promise<{ cx: number; cy: number }> {
  return parseSlideSize(await readEntry(bytes, PRESENTATION_XML_PATH));
}

/** 用替换后的 `slide1.xml` 重新打包 pptx。 */
export async function repackSlideXml(bytes: Uint8Array, slideXml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(SLIDE_XML_PATH, slideXml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
