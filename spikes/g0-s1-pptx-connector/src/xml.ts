/**
 * XML / zip 层的最小工具：解析 `ppt/slides/slideN.xml`、建立 `name → id` 映射、注入形状。
 *
 * 刻意**不**引入 XML 库：spike 的依赖面越小越好，且这里只需要「按 name 找 id」与
 * 「在 `</p:spTree>` 前插入」两个操作，正则足够且行为完全可控。
 */

/** 幻灯片 XML 的固定路径（本 spike 只用第 1 张幻灯片）。 */
export const SLIDE_XML_PATH = 'ppt/slides/slide1.xml';

/** 演示文稿 XML 路径（含 `p:sldSz` 幻灯片尺寸声明）。 */
export const PRESENTATION_XML_PATH = 'ppt/presentation.xml';

/** 从 `ppt/presentation.xml` 中读出幻灯片尺寸（EMU）。 */
export function parseSlideSize(presentationXml: string): { cx: number; cy: number } {
  const match = /<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/.exec(presentationXml);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error('未在 presentation.xml 中找到 p:sldSz：无法确认幻灯片尺寸');
  }
  return { cx: Number(match[1]), cy: Number(match[2]) };
}

/** 幻灯片名称空间的固定前缀声明（与 pptxgenjs / WPS 产物一致）。 */
export const SLIDE_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/**
 * 抽取幻灯片形状树（`<p:spTree>` 的内层内容）。
 *
 * 返回的形状顺序即文档顺序，也是形状 `id` 的分配顺序依据。
 */
export function extractSpTree(slideXml: string): string {
  const match = /<p:spTree>(.*)<\/p:spTree>/s.exec(slideXml);
  if (match?.[1] === undefined) {
    throw new Error('未找到 <p:spTree>：slide XML 结构不符预期');
  }
  return match[1];
}

/** 一个形状的标识信息。 */
export interface ShapeRef {
  readonly name: string;
  readonly id: number;
}

/**
 * 建立 `name → id` 映射，**按文档顺序**解析。
 *
 * 这是补丁器的关键设计：**绝不硬编码 `id = idx + 2`**。
 * 该规则虽是 pptxgenjs 的当前实现（`${idx + 2}`，idx 为零基创建序），
 * 但把它当常量会让补丁在库升级或产物来源变化时静默错位。
 * 因此运行时解析，并把「实测是否等于 idx+2」作为 L1 的一条断言。
 *
 * 会同时捕获嵌套在 `<p:grpSp>` 内的子形状——OOXML 的 id 唯一性是**整棵形状树**范围的，
 * 这一点由 WPS 原生产物佐证（组 id=8，子形状 id=6、7，全树唯一）。
 */
export function parseShapeRefs(spTreeXml: string): ShapeRef[] {
  const refs: ShapeRef[] = [];
  const re = /<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spTreeXml)) !== null) {
    const idRaw = m[1];
    const name = m[2];
    if (idRaw === undefined || name === undefined) continue;
    // `id="1" name=""` 是 spTree 自身的 nvGrpSpPr，不是形状。
    if (name === '') continue;
    refs.push({ name, id: Number(idRaw) });
  }
  return refs;
}

/** 由形状引用数组建立 `name → id` 查找表，并对重名/重复 id 直接报错。 */
export function buildIdMap(refs: readonly ShapeRef[]): Map<string, number> {
  const byName = new Map<string, number>();
  const seenIds = new Map<number, string>();
  for (const ref of refs) {
    const existing = byName.get(ref.name);
    if (existing !== undefined && existing !== ref.id) {
      throw new Error(`形状名重名且 id 不同：${ref.name} → ${String(existing)} / ${String(ref.id)}`);
    }
    const idOwner = seenIds.get(ref.id);
    if (idOwner !== undefined && idOwner !== ref.name) {
      throw new Error(`形状 id 重复：id=${String(ref.id)} 被 ${idOwner} 与 ${ref.name} 共用`);
    }
    byName.set(ref.name, ref.id);
    seenIds.set(ref.id, ref.name);
  }
  return byName;
}

/** 形状 `id` 在文档顺序与 `idx + 2` 规则下的一致性结论。 */
export interface IdRuleResult {
  /** 是否**每个**形状都满足 `id === idx + 2`。 */
  readonly matchesIdxPlusTwo: boolean;
  /** 逐形状实测明细。 */
  readonly rows: ReadonlyArray<{ name: string; idx: number; id: number; expected: number }>;
}

/**
 * 校验 pptxgenjs 的 `id = idx + 2` 规则，但**只作为断言**，不作为补丁依据。
 *
 * 来源：pptxgenjs dist 中 `<p:cNvPr id="${idx + 2}" name="…">`（idx 为零基创建序）。
 * 若哪天该规则变了，这里会失败，从而暴露「有人悄悄依赖了不成立的假设」。
 */
export function checkIdRule(refs: readonly ShapeRef[]): IdRuleResult {
  const rows = refs.map((ref, idx) => ({ name: ref.name, idx, id: ref.id, expected: idx + 2 }));
  return { matchesIdxPlusTwo: rows.every((row) => row.id === row.expected), rows };
}

/** 在 `</p:spTree>` 之前插入 XML 片段（形状追加到树尾）。 */
export function injectIntoSpTree(slideXml: string, fragment: string): string {
  const marker = '</p:spTree>';
  const index = slideXml.lastIndexOf(marker);
  if (index === -1) {
    throw new Error('未找到 </p:spTree>：无法注入形状');
  }
  return slideXml.slice(0, index) + fragment + slideXml.slice(index);
}
