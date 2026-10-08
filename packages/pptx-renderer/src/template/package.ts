/**
 * **产物的读回与归一化重打包**（P3/C3 从 `template.ts` 拆出）。
 *
 * 归一化（ADR 0010 §9）三步：① `docProps/core.xml` 的时间字段 → 常量；② 全部 zip 条目日期 → 常量；
 * ③ 固定压缩参数与条目顺序（按名排序）。**只准 `uint8array`**：JSZip 的 `nodebuffer`
 * 在浏览器里不可用，而本包要同时跑在 Node 与浏览器。
 */

import JSZip from 'jszip';

/** 归一化用的固定时间（ADR 0010 §9）：`2000-01-01T00:00:00Z`。 */
export const FIXED_TIMESTAMP_ISO = '2000-01-01T00:00:00Z';

/** 归一化用的固定 zip 条目日期。 */
export const FIXED_ZIP_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/** 解包后的产物尺寸（`p:sldSz`）。 */
export async function readSlideSize(bytes: Uint8Array): Promise<{ readonly cx: number; readonly cy: number }> {
  const xml = await readPptxEntry(bytes, 'ppt/presentation.xml');
  const match = /<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/.exec(xml);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('未在 presentation.xml 里找到 p:sldSz');
  return { cx: Number(match[1]), cy: Number(match[2]) };
}

/** 读产物里的任一文本条目（判据与证据用）。 */
export async function readPptxEntry(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  if (file === null) throw new Error(`产物里没有 ${path}`);
  return file.async('string');
}

/**
 * 归一化重打包（ADR 0010 §9）：① `docProps/core.xml` 的时间字段；② 全部 zip 条目日期；
 * ③ 固定压缩参数与条目顺序（按名排序）。
 */
export async function normalizePptx(bytes: Uint8Array, slideXml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file('ppt/slides/slide1.xml', slideXml);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const out = new JSZip();
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    if (entry === undefined || entry.dir) continue;
    // **只准 `uint8array`**：JSZip 的 `nodebuffer` 在浏览器里不可用（本包要同时跑在 Node 与浏览器）。
    let data = await entry.async('uint8array');
    if (name === 'docProps/core.xml') {
      const text = decoder
        .decode(data)
        .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/g, `$1${FIXED_TIMESTAMP_ISO}$2`)
        .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/g, `$1${FIXED_TIMESTAMP_ISO}$2`);
      data = encoder.encode(text);
    }
    out.file(name, data, { date: FIXED_ZIP_DATE, compression: 'DEFLATE', createFolders: false });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' });
}
