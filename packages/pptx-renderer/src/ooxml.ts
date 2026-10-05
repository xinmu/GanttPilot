/**
 * OOXML 片段的构造与解析（`<p:sp>` / `<p:cxnSp>` / `<p:grpSp>` / `<a:custGeom>`）。
 *
 * ## 形态基准：WPS 的**原生产物**，不是文档记忆
 *
 * 全部形态取自 S1 的对照实验（[结论 §二/§三](../../../spikes/g0-s1-pptx-connector/结论.md)）：
 *
 * - 吸附锚点在 `p:nvCxnSpPr > p:cNvCxnSpPr` 下，元素是 **`a:stCxn` / `a:endCxn`**；
 * - `a:stCxn@idx` 是 **preset geometry 的连接点序列**（roundRect：0=上 1=左 2=下 3=右），
 *   不是 PowerPoint COM 的枚举值（后者相差 1）；
 * - **不写 `<a:cxnSpLocks/>`**（原生也没有）；
 * - `p:grpSp` 的 `off/ext` 与 `chOff/chExt` **均显式**，且 **等比**（非等比会把圆角矩形与菱形拉变形）；
 * - `a:custGeom` 的折线用 `pathLst/moveTo/lnTo`，点用**形状局部坐标**。
 *
 * ## 一条纪律：**shapeName 是唯一定位锚点**
 *
 * pptxgenjs 分配的 `id` 会随创建顺序变化，`name` 不会。因此补丁**一律按 name 定位**，
 * `id` 只用于"分配一个未被占用的新值"（`IdAllocator`），绝不硬编码 `idx + 2`。
 */

import type { RouteSide } from '@ganttpilot/render-core';

import { EMU_PER_PT } from './units.js';

/** OOXML 的 preset 连接点序列（`roundRect`/`rect`）。 */
export const SITES = { top: 0, left: 1, bottom: 2, right: 3 } as const;

/** 连接点总数（`idx` 越界断言用）。 */
export const SITE_COUNT = 4;

/** `RouteSide` → OOXML `idx`（**唯一映射处**；出/入侧本身的口径登记在 P-8 第 1 条）。 */
export function siteForSide(side: RouteSide): number {
  return side === 'right' ? SITES.right : SITES.left;
}

/** 形状名（**唯一定位锚点**；也是 WPS 里人工核对时可读的标识）。 */
export const NAMES = {
  title: 'title',
  group: (summaryTaskId: string): string => `grp-${summaryTaskId}`,
  bar: (taskId: string): string => `bar-${taskId}`,
  progress: (taskId: string): string => `prog-${taskId}`,
  milestone: (taskId: string): string => `ms-${taskId}`,
  edge: (linkId: string): string => `dep-${linkId}`,
  label: (taskId: string): string => `lbl-${taskId}`,
  legend: (index: number): string => `legend-${String(index)}`,
  summary: (index: number): string => `summary-${String(index)}`,
  /** 日期刻度的文本框（第 N 个刻度）。 */
  axis: (index: number): string => `axis-${String(index)}`,
  /** 周末/节假日灰度带。 */
  band: (index: number): string => `band-${String(index)}`,
  /** 背景网格线。 */
  grid: (index: number): string => `grid-${String(index)}`,
  /** 图例色块/箭头（按 styleKey 命名）。 */
  legendSwatch: (styleKey: string): string => `legend-swatch-${styleKey}`,
} as const;

/** XML 属性转义。 */
export function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 轴对齐矩形（EMU）。 */
export interface EmuRect {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
}

/** 点（EMU）。 */
export interface EmuPoint {
  readonly x: number;
  readonly y: number;
}

function xfrmXml(rect: EmuRect, extra = ''): string {
  return (
    `<a:xfrm${extra}>` +
    `<a:off x="${String(rect.x)}" y="${String(rect.y)}"/>` +
    `<a:ext cx="${String(rect.cx)}" cy="${String(rect.cy)}"/>` +
    `</a:xfrm>`
  );
}

function styleXml(): string {
  return (
    `<p:style>` +
    `<a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>` +
    `<a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>` +
    `<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>` +
    `<a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef>` +
    `</p:style>`
  );
}

/** 圆角矩形任务条 / 汇总条（`roundRect`；汇总条直角、更矮由调用方给 rect）。 */
export function barSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly rect: EmuRect;
  readonly fill: string;
  readonly round: boolean;
}): string {
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvSpPr/><p:nvPr/>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    xfrmXml(params.rect) +
    `<a:prstGeom prst="${params.round ? 'roundRect' : 'rect'}"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${attr(params.fill)}"/></a:solidFill>` +
    `<a:ln><a:solidFill><a:srgbClr val="${attr(params.fill)}"/></a:solidFill></a:ln>` +
    `</p:spPr>` +
    styleXml() +
    `</p:sp>`
  );
}

/** 进度条（`rect`，无描边）——即"纯色实心矩形"，与刻度线/周末灰度/图例色块同一条实现。 */
export function progressSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly rect: EmuRect;
  readonly fill: string;
}): string {
  return plainRectSpXml(params);
}

/**
 * 纯色矩形（无描边）：进度条、**周末/节假日灰度带**、**背景刻度线**、图例色块都用它。
 *
 * 单独成函数的原因：这四样都必须**零描边**——带上默认细线会让"背景灰度"变成"一堆框"，
 * 也会让 1 px 的网格线渲成 2 px（人工复验回来的 PPTX 就少了这两种背景图元）。
 */
export function plainRectSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly rect: EmuRect;
  readonly fill: string;
}): string {
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvSpPr/><p:nvPr/>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    xfrmXml(params.rect) +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${attr(params.fill)}"/></a:solidFill>` +
    `<a:ln><a:noFill/></a:ln>` +
    `</p:spPr>` +
    `</p:sp>`
  );
}

/**
 * 三角形（`prstGeom prst="triangle"`，默认朝上）——图例里的**箭头**用它，
 * 靠 `rot`（60000 分之一度）转到朝右。
 *
 * 为什么不给图例用"自由 connector"：`<p:cxnSp>` 不带 `a:stCxn/endCxn` 的形态
 * 在本仓库没有实测过（S1 与 S-G7 验的都是带锚点的）；图例只是装饰，
 * 用**已验证过的 preset 形状**最省风险。
 */
export function triangleSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly rect: EmuRect;
  /** `rot`（度）。 */
  readonly rotateDeg: number;
  readonly fill: string;
  readonly stroke: string;
}): string {
  const rot = Math.round(params.rotateDeg * 60_000);
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvSpPr/><p:nvPr/>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    xfrmXml(params.rect, rot !== 0 ? ` rot="${String(rot)}"` : '') +
    `<a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${attr(params.fill)}"/></a:solidFill>` +
    `<a:ln w="9525"><a:solidFill><a:srgbClr val="${attr(params.stroke)}"/></a:solidFill></a:ln>` +
    `</p:spPr>` +
    `</p:sp>`
  );
}

/** 里程碑（**菱形 preset**，EX-03 点名）。 */
export function milestoneSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly rect: EmuRect;
  readonly fill: string;
  readonly stroke: string;
}): string {
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvSpPr/><p:nvPr/>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    xfrmXml(params.rect) +
    `<a:prstGeom prst="diamond"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${attr(params.fill)}"/></a:solidFill>` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${attr(params.stroke)}"/></a:solidFill></a:ln>` +
    `</p:spPr>` +
    styleXml() +
    `</p:sp>`
  );
}

/** 由两端点推导 connector 的包围盒（ext 不可为 0；矩形框架表达不了对角时用翻转位）。 */
export function connectorFrame(from: EmuPoint, to: EmuPoint): { rect: EmuRect; flipH: boolean; flipV: boolean } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let cx = Math.abs(dx);
  let cy = Math.abs(dy);
  if (cx === 0 && cy === 0) {
    cx = EMU_PER_PT;
    cy = EMU_PER_PT;
  } else if (cx === 0) cx = EMU_PER_PT;
  else if (cy === 0) cy = EMU_PER_PT;
  return {
    rect: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), cx, cy },
    flipH: (dx < 0 && dy < 0) || (dx > 0 && dy < 0),
    flipV: (dx < 0 && dy < 0) || (dx < 0 && dy > 0),
  };
}

/**
 * 双端吸附的 `<p:cxnSp>`（`bentConnector3`）。
 *
 * 两个端点都写在 `<a:stCxn id idx>` / `<a:endCxn id idx>` 上 ⇒ PowerPoint/WPS 会在**形状移动后**
 * 重算走线（S1 的 L4 与 S-G7 的 S7-a 都实测过）。
 *
 * `arrow`（人工复验的第 3 条）：**必须显式写 `a:tailEnd`**，否则渲染出来只有线没有箭头。
 * 形态与 SVG 对齐——`FS`/`FF` 实心（`triangle`）、`SS`/`SF` 空心（`arrow`，即开放箭头）。
 */
export function connectorSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly fromId: number;
  readonly fromIdx: number;
  readonly toId: number;
  readonly toIdx: number;
  readonly fromPoint: EmuPoint;
  readonly toPoint: EmuPoint;
  readonly color: string;
  readonly ignored: boolean;
  readonly arrow: 'solid' | 'hollow';
}): string {
  const { rect, flipH, flipV } = connectorFrame(params.fromPoint, params.toPoint);
  const flags = (flipH ? ' flipH="1"' : '') + (flipV ? ' flipV="1"' : '');
  const arrowType = params.arrow === 'hollow' ? 'arrow' : 'triangle';
  return (
    `<p:cxnSp>` +
    `<p:nvCxnSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvCxnSpPr>` +
    `<a:stCxn id="${String(params.fromId)}" idx="${String(params.fromIdx)}"/>` +
    `<a:endCxn id="${String(params.toId)}" idx="${String(params.toIdx)}"/>` +
    `</p:cNvCxnSpPr>` +
    `<p:nvPr/>` +
    `</p:nvCxnSpPr>` +
    `<p:spPr>` +
    xfrmXml(rect, flags) +
    `<a:prstGeom prst="bentConnector3"><a:avLst/></a:prstGeom>` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${attr(params.color)}"/></a:solidFill>` +
    `<a:tailEnd type="${arrowType}" w="med" len="med"/></a:ln>` +
    `</p:spPr>` +
    styleXml() +
    `</p:cxnSp>`
  );
}

/**
 * **降级②**：`custGeom` 折线（connector 不可交付时的形态，ADR 0010 §6）。
 *
 * 点列**直接取自导出 SVG 的 path 端点**（T-4 的收益）：降级后的视觉差异最小。
 * S7-b 已证 WPS 接受该形态（无修复弹窗、另存后 `custGeom` 存活）。
 */
export function custGeomSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly rect: EmuRect;
  readonly points: readonly EmuPoint[];
  readonly color: string;
  /** 降级路径同样要带箭头（否则"降级"会悄悄丢掉四类关系的箭头形态）。 */
  readonly arrow: 'solid' | 'hollow';
}): string {
  const points = params.points;
  const first = points[0];
  if (first === undefined || points.length < 2) throw new Error('custGeom 折线至少需要两个点');
  const local = points.map((point) => ({ x: point.x - params.rect.x, y: point.y - params.rect.y }));
  const head = local[0];
  if (head === undefined) throw new Error('custGeom 折线至少需要两个点');
  const path =
    `<a:path w="${String(Math.max(1, params.rect.cx))}" h="${String(Math.max(1, params.rect.cy))}">` +
    `<a:moveTo><a:pt x="${String(head.x)}" y="${String(head.y)}"/></a:moveTo>` +
    local
      .slice(1)
      .map((point) => `<a:lnTo><a:pt x="${String(point.x)}" y="${String(point.y)}"/></a:lnTo>`)
      .join('') +
    `</a:path>`;
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvSpPr/><p:nvPr/>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    xfrmXml(params.rect) +
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>` +
    `<a:rect l="0" t="0" r="0" b="0"/>` +
    `<a:pathLst>${path}</a:pathLst>` +
    `</a:custGeom>` +
    `<a:noFill/>` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${attr(params.color)}"/></a:solidFill>` +
    `<a:tailEnd type="${params.arrow === 'hollow' ? 'arrow' : 'triangle'}" w="med" len="med"/></a:ln>` +
    `</p:spPr>` +
    `</p:sp>`
  );
}

/** 组内的一个子形状（**组坐标**由调用方给；见 `groupSpXml`）。 */
export interface GroupChildXml {
  readonly id: number;
  readonly name: string;
  readonly xml: string;
}

/**
 * `<p:grpSp>`：显式 `off/ext` + `chOff/chExt`，且**等比**（ADR 0010 §5）。
 *
 * 本实现取 `chOff = (0,0)`、`chExt = 包围盒`、`off = 包围盒落点`、`ext = 包围盒尺寸`
 * ⇒ 缩放恒为 1：子形状在组内保持自己的相对位置，整体随组平移。
 * "两套坐标必须不同"这条纪律由此有载体（`chOff ≠ off`，除非包围盒左上正好在原点）。
 */
export function groupSpXml(params: {
  readonly id: number;
  readonly name: string;
  readonly frame: EmuRect;
  readonly children: readonly GroupChildXml[];
}): string {
  if (params.children.length === 0) throw new Error('group 至少需要一个子形状');
  const frame = params.frame;
  if (frame.cx <= 0 || frame.cy <= 0) throw new Error('group 包围盒退化');
  const childrenXml = params.children
    .map((child) => {
      const wrapped = child.xml.replace(
        /<a:off x="(-?\d+)" y="(-?\d+)"\/>/,
        (_match, x: string, y: string) =>
          `<a:off x="${String(Number(x) - frame.x)}" y="${String(Number(y) - frame.y)}"/>`,
      );
      return wrapped;
    })
    .join('');
  return (
    `<p:grpSp>` +
    `<p:nvGrpSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvGrpSpPr/><p:nvPr/>` +
    `</p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm>` +
    `<a:off x="${String(frame.x)}" y="${String(frame.y)}"/>` +
    `<a:ext cx="${String(frame.cx)}" cy="${String(frame.cy)}"/>` +
    `<a:chOff x="0" y="0"/>` +
    `<a:chExt cx="${String(frame.cx)}" cy="${String(frame.cy)}"/>` +
    `</a:xfrm></p:grpSpPr>` +
    childrenXml +
    `</p:grpSp>`
  );
}

// ---------------------------------------------------------------- slide XML 上的操作

/** `spTree` 的内层内容（形状树）。 */
export function extractSpTree(slideXml: string): string {
  const match = /<p:spTree>([\s\S]*)<\/p:spTree>/.exec(slideXml);
  if (match?.[1] === undefined) throw new Error('未找到 <p:spTree>：slide XML 结构不符预期');
  return match[1];
}

/** 在 `</p:spTree>` 之前注入片段（形状追加到树尾）。 */
export function injectIntoSpTree(slideXml: string, fragment: string): string {
  const marker = '</p:spTree>';
  const index = slideXml.lastIndexOf(marker);
  if (index === -1) throw new Error('未找到 </p:spTree>：无法注入形状');
  return slideXml.slice(0, index) + fragment + slideXml.slice(index);
}

/** 一个形状的标识（`name` 是定位锚点，`id` 只用于查重）。 */
export interface ShapeRef {
  readonly name: string;
  readonly id: number;
}

/** 按文档顺序解析 `name → id`（**含组内子形状**：id 唯一性是整棵树的）。 */
export function parseShapeRefs(spTreeXml: string): readonly ShapeRef[] {
  const refs: ShapeRef[] = [];
  const re = /<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(spTreeXml)) !== null) {
    const idRaw = match[1];
    const name = match[2];
    if (idRaw === undefined || name === undefined || name === '') continue;
    refs.push({ name, id: Number(idRaw) });
  }
  return refs;
}

/** `name → id` 查找表（重名不同 id / 同 id 不同名 ⇒ 直接报错）。 */
export function buildIdMap(refs: readonly ShapeRef[]): Map<string, number> {
  const byName = new Map<string, number>();
  const seenId = new Map<number, string>();
  for (const ref of refs) {
    const existing = byName.get(ref.name);
    if (existing !== undefined && existing !== ref.id) {
      throw new Error(`形状名重名且 id 不同：${ref.name} → ${String(existing)} / ${String(ref.id)}`);
    }
    const owner = seenId.get(ref.id);
    if (owner !== undefined && owner !== ref.name) {
      throw new Error(`形状 id 重复：${String(ref.id)} 被 ${owner} 与 ${ref.name} 共用`);
    }
    byName.set(ref.name, ref.id);
    seenId.set(ref.id, ref.name);
  }
  return byName;
}

/**
 * 形状 id 分配器：**绝不复用**容器里已有的 id，也绝不复用本次分配过的 id。
 *
 * 为什么不做 `id = idx + 2`：那是 pptxgenjs 的当前实现细节，把它当常量会让补丁在
 * 库升级/容器来源变化时**静默错位**（S1 结论点名）。这里一律从容器实测值出发。
 */
export class IdAllocator {
  readonly #used: Set<number>;

  constructor(refs: readonly ShapeRef[]) {
    this.#used = new Set(refs.map((ref) => ref.id));
  }

  next(): number {
    let candidate = Math.max(0, ...this.#used) + 1;
    while (this.#used.has(candidate)) candidate += 1;
    this.#used.add(candidate);
    return candidate;
  }

  /** 批量取 `count` 个（顺序稳定，供 golden 复现）。 */
  take(count: number): readonly number[] {
    const out: number[] = [];
    for (let index = 0; index < count; index += 1) out.push(this.next());
    return out;
  }
}
