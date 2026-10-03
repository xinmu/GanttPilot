/**
 * 最小补丁器：把 `<p:cxnSp>`（双端吸附）与 `<p:grpSp>`（含坐标换算）注入 `slide1.xml`。
 *
 * **形态基准来自 WPS 原生产物**（`evidence/wps/D-native-slide1.xml`），而不是文档记忆：
 *
 * ```xml
 * <p:cxnSp>
 *   <p:nvCxnSpPr>
 *     <p:cNvPr id="5" name="dep-1"/>
 *     <p:cNvCxnSpPr>
 *       <a:stCxn id="2" idx="2"/>
 *       <a:endCxn id="3" idx="0"/>
 *     </p:cNvCxnSpPr>
 *     <p:nvPr/>
 *   </p:nvCxnSpPr>
 *   …
 * ```
 *
 * 三个必须写进结论的形态要点：
 * 1. 锚点位于 `p:nvCxnSpPr > p:cNvCxnSpPr` 下，元素是 **`a:stCxn` / `a:endCxn`**。
 *    《证伪实验计划》写的 `p:cNvCxnSpPr` 是笔误，正确前缀是 `a:`。
 * 2. `a:stCxn@idx` 是 **preset geometry 的连接点序列**，不是 COM 枚举（见 manifest 注释）。
 * 3. 与 2016+ 习惯写法不同，**原生不含 `<a:cxnSpLocks/>`**（全局检索 0 次命中）。
 */

import type { FlatShape } from './flatten-group.ts';
import {
  DEP_1,
  GRP_1,
  ROUND_RECT_SITE_COUNT,
  SHAPES,
  connectorTransform,
  connectionPoint,
  type Rect,
} from './manifest.ts';
import { buildIdMap, type ShapeRef } from './xml.ts';

/** XML 属性值转义（形状名可能被用户改成含引号的文本）。 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xfrmXml(
  off: { x: number; y: number },
  ext: { cx: number; cy: number },
  rot: number,
  flipH: boolean,
  flipV: boolean,
): string {
  const flags =
    (rot !== 0 ? ` rot="${String(rot)}"` : '') +
    (flipH ? ' flipH="1"' : '') +
    (flipV ? ' flipV="1"' : '');
  return (
    `<a:xfrm${flags}>` +
    `<a:off x="${String(off.x)}" y="${String(off.y)}"/>` +
    `<a:ext cx="${String(ext.cx)}" cy="${String(ext.cy)}"/>` +
    `</a:xfrm>`
  );
}

/** 组装一条双端吸附的 connector（`<p:cxnSp>`）。 */
export function buildConnectorXml(params: {
  id: number;
  name: string;
  fromId: number;
  fromIdx: number;
  toId: number;
  toIdx: number;
  fromPoint: { x: number; y: number };
  toPoint: { x: number; y: number };
  prst: string;
  color: string;
}): string {
  const t = connectorTransform(params.fromPoint, params.toPoint);
  return (
    `<p:cxnSp>` +
    `<p:nvCxnSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    // 吸附锚点：仅在 a: 命名空间下有效，且刻意不写 <a:cxnSpLocks/>（与原生产物一致）
    `<p:cNvCxnSpPr>` +
    `<a:stCxn id="${String(params.fromId)}" idx="${String(params.fromIdx)}"/>` +
    `<a:endCxn id="${String(params.toId)}" idx="${String(params.toIdx)}"/>` +
    `</p:cNvCxnSpPr>` +
    `<p:nvPr/>` +
    `</p:nvCxnSpPr>` +
    `<p:spPr>` +
    xfrmXml(t.off, t.ext, t.rot, t.flipH, t.flipV) +
    `<a:prstGeom prst="${attr(params.prst)}"><a:avLst/></a:prstGeom>` +
    `<a:ln><a:solidFill><a:srgbClr val="${attr(params.color)}"/></a:solidFill></a:ln>` +
    `</p:spPr>` +
    `<p:style>` +
    `<a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>` +
    `<a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>` +
    `<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>` +
    `<a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef>` +
    `</p:style>` +
    `</p:cxnSp>`
  );
}

/** 一个子形状在**组坐标**中的声明。 */
export interface GroupChild {
  readonly name: string;
  readonly rect: Rect;
  readonly color: string;
}

/** 组坐标 → EMU 的仿射映射。 */
export interface GroupMapping {
  readonly chOff: { x: number; y: number };
  readonly chExt: { cx: number; cy: number };
  readonly off: { x: number; y: number };
  readonly ext: { cx: number; cy: number };
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * 由子形状的组坐标包围盒 + 期望的幻灯片落点，推导 `grpSpPr/xfrm`。
 *
 * 按 ECMA-376 的组映射公式：
 * `abs = off + (childLocal - chOff) * (ext / chExt)`
 * 这里取 `chOff = ` 子包围盒左上、`chExt = ` 子包围盒尺寸，于是子形状在组内**保持原坐标**，
 * 而整体被平移到 `off`。
 *
 * 断言 `scaleX === scaleY`：本 fixture 只允许**等比**缩放，避免引入非等比失真
 * （X/Y 缩放不一致时，圆角矩形与菱形会被拉变形）。
 */
export function buildGroupMapping(children: readonly GroupChild[], target: Rect): GroupMapping {
  if (children.length === 0) throw new Error('group 至少需要一个子形状');
  const minX = Math.min(...children.map((c) => c.rect.x));
  const minY = Math.min(...children.map((c) => c.rect.y));
  const maxX = Math.max(...children.map((c) => c.rect.x + c.rect.cx));
  const maxY = Math.max(...children.map((c) => c.rect.y + c.rect.cy));
  const chExt = { cx: maxX - minX, cy: maxY - minY };
  if (chExt.cx <= 0 || chExt.cy <= 0) throw new Error('group 子形状包围盒退化（cx/cy 必须为正）');

  const scaleX = target.cx / chExt.cx;
  const scaleY = target.cy / chExt.cy;
  if (Math.abs(scaleX - scaleY) > 1e-6) {
    throw new Error(
      `group 非等比缩放会拉变形子形状：scaleX=${String(scaleX)} scaleY=${String(scaleY)}`,
    );
  }
  return {
    chOff: { x: minX, y: minY },
    chExt,
    off: { x: target.x, y: target.y },
    ext: { cx: target.cx, cy: target.cy },
    scaleX,
    scaleY,
  };
}

/** 组坐标 → 幻灯片绝对坐标（ECMA-376 映射公式）。 */
export function childToAbsolute(mapping: GroupMapping, local: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(mapping.off.x + (local.x - mapping.chOff.x) * mapping.scaleX),
    y: Math.round(mapping.off.y + (local.y - mapping.chOff.y) * mapping.scaleY),
  };
}

/** 幻灯片绝对坐标 → 组坐标（上式的逆，用于 `flatten-group.ts` 的可逆性验证）。 */
export function absoluteToChild(mapping: GroupMapping, abs: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(mapping.chOff.x + (abs.x - mapping.off.x) / mapping.scaleX),
    y: Math.round(mapping.chOff.y + (abs.y - mapping.off.y) / mapping.scaleY),
  };
}

/** 组装一个 `<p:grpSp>`，含显式的 `off/ext` 与 `chOff/chExt`，以及已换算的子形状。 */
export function buildGroupXml(params: {
  id: number;
  name: string;
  children: readonly GroupChild[];
  mapping: GroupMapping;
  childIds: readonly number[];
}): { xml: string; absoluteShapes: readonly FlatShape[] } {
  if (params.children.length !== params.childIds.length) {
    throw new Error('子形状数量与分配到的 id 数量不一致');
  }
  const absoluteShapes: FlatShape[] = [];
  const childXml = params.children
    .map((child, index) => {
      const childId = params.childIds[index];
      if (childId === undefined) throw new Error('缺少子形状 id');
      const absOff = childToAbsolute(params.mapping, { x: child.rect.x, y: child.rect.y });
      // 子形状的 ext 直接按组缩放换算，保证最终绝对尺寸与等比缩放一致
      const absExt = {
        cx: Math.round(child.rect.cx * params.mapping.scaleX),
        cy: Math.round(child.rect.cy * params.mapping.scaleY),
      };
      absoluteShapes.push({
        name: child.name,
        rect: { ...absOff, ...absExt },
        color: child.color,
      });
      return (
        `<p:sp>` +
        `<p:nvSpPr>` +
        `<p:cNvPr id="${String(childId)}" name="${attr(child.name)}"/>` +
        `<p:cNvSpPr/><p:nvPr/>` +
        `</p:nvSpPr>` +
        `<p:spPr>` +
        // 子形状使用**组坐标系**（即 chOff/chExt 所指的空间），不是幻灯片绝对坐标
        xfrmXml(
          { x: child.rect.x, y: child.rect.y },
          { cx: child.rect.cx, cy: child.rect.cy },
          0,
          false,
          false,
        ) +
        `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>` +
        `<a:solidFill><a:srgbClr val="${attr(child.color)}"/></a:solidFill>` +
        `</p:spPr>` +
        `<p:style>` +
        `<a:lnRef idx="2"><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:lnRef>` +
        `<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>` +
        `<a:effectRef idx="0"><a:srgbClr val="FFFFFF"/></a:effectRef>` +
        `<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>` +
        `</p:style>` +
        `</p:sp>`
      );
    })
    .join('');

  const xml =
    `<p:grpSp>` +
    `<p:nvGrpSpPr>` +
    `<p:cNvPr id="${String(params.id)}" name="${attr(params.name)}"/>` +
    `<p:cNvGrpSpPr/><p:nvPr/>` +
    `</p:nvGrpSpPr>` +
    `<p:grpSpPr>` +
    `<a:xfrm>` +
    `<a:off x="${String(params.mapping.off.x)}" y="${String(params.mapping.off.y)}"/>` +
    `<a:ext cx="${String(params.mapping.ext.cx)}" cy="${String(params.mapping.ext.cy)}"/>` +
    `<a:chOff x="${String(params.mapping.chOff.x)}" y="${String(params.mapping.chOff.y)}"/>` +
    `<a:chExt cx="${String(params.mapping.chExt.cx)}" cy="${String(params.mapping.chExt.cy)}"/>` +
    `</a:xfrm>` +
    `</p:grpSpPr>` +
    childXml +
    `</p:grpSp>`;
  return { xml, absoluteShapes };
}

/** 形状 id 的分配器：绝不复用既有 id。 */
export class IdAllocator {
  readonly #used: Set<number>;

  constructor(refs: readonly ShapeRef[]) {
    this.#used = new Set(refs.map((ref) => ref.id));
  }

  /** 取下一个未使用的 id（从容器现有最大值 +1 起，且跳过空洞不会造成冲突）。 */
  next(): number {
    let candidate = Math.max(0, ...this.#used) + 1;
    while (this.#used.has(candidate)) candidate += 1;
    this.#used.add(candidate);
    return candidate;
  }

  has(id: number): boolean {
    return this.#used.has(id);
  }
}

/** 补丁结果：注入的两段 XML 与用于断言的元数据。 */
export interface PatchResult {
  readonly connectorXml: string;
  readonly groupXml: string;
  /** group 子形状的**绝对**矩形（由补丁器算出，供交叉验证用）。 */
  readonly groupAbsoluteShapes: readonly FlatShape[];
  readonly groupMapping: GroupMapping;
  readonly connectorIds: { dep: number; group: number; groupChildren: number[] };
  /** 连线两端的绝对坐标与形状 id，供断言使用。 */
  readonly connectorPoints: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    fromId: number;
    toId: number;
  };
}

/**
 * 为给定的容器形状树构造补丁片段。
 *
 * 调用的前置条件：`refs` 由 `parseShapeRefs(extractSpTree(slideXml))` 得到。
 * 所有定位都通过 **name** 完成，因此对 id 分配规则的变化免疫。
 */
export function buildPatch(refs: readonly ShapeRef[], refs2Name = ''): PatchResult {
  const idMap = buildIdMap(refs);
  const allocator = new IdAllocator(refs);

  const fromId = idMap.get(DEP_1.from.shape);
  const toId = idMap.get(DEP_1.to.shape);
  if (fromId === undefined) throw new Error(`找不到起点形状：${DEP_1.from.shape}${refs2Name}`);
  if (toId === undefined) throw new Error(`找不到终点形状：${DEP_1.to.shape}`);

  const fromRect = SHAPES[DEP_1.from.shape];
  const toRect = SHAPES[DEP_1.to.shape];
  if (fromRect === undefined || toRect === undefined) throw new Error('manifest 缺少连线端点形状几何');

  // 断言：连接点索引必须在 preset 的连接点范围内
  for (const [label, site] of [
    ['stCxn', DEP_1.from.site],
    ['endCxn', DEP_1.to.site],
  ] as const) {
    if (site < 0 || site >= ROUND_RECT_SITE_COUNT) {
      throw new Error(`${label} 的 idx=${String(site)} 越界（roundRect 只有 0..3）`);
    }
  }

  const depId = allocator.next();
  const fromPoint = connectionPoint(fromRect, DEP_1.from.site);
  const toPoint = connectionPoint(toRect, DEP_1.to.site);
  const connectorXml = buildConnectorXml({
    id: depId,
    name: DEP_1.name,
    fromId,
    fromIdx: DEP_1.from.site,
    toId,
    toIdx: DEP_1.to.site,
    fromPoint,
    toPoint,
    prst: DEP_1.prst,
    color: DEP_1.color,
  });

  // group：目标落点放在任务条下方、**仍在 720×405 pt 幻灯片内**的空白带。
  // y 取 330 pt 而非 400 pt：后者会让 group 底边落到画布外（实测被裁掉），
  // 而"越界"正是 L1 的 `fixture-shapes-in-slide-bounds` / 组底边断言要拦住的情况。
  // 宽高比必须与子形状包围盒一致（chExt = 2500×200 = 12.5:1），否则会因非等比缩放报错。
  // 刻意用「由 ratio 推导」而不是手写两个数字：手写时极易写错比例，
  // 而这条守卫的价值恰恰是让「比例不匹配」立刻暴露（非等比缩放会把圆角矩形与菱形拉变形）。
  const childBoundsCx = Math.max(...GRP_1.children.map((c) => c.rect.x + c.rect.cx)) - Math.min(...GRP_1.children.map((c) => c.rect.x));
  const childBoundsCy = Math.max(...GRP_1.children.map((c) => c.rect.y + c.rect.cy)) - Math.min(...GRP_1.children.map((c) => c.rect.y));
  const groupWidthEmu = 220 * 12700;
  const groupTarget: Rect = {
    x: 60 * 12700,
    y: 310 * 12700,
    cx: groupWidthEmu,
    cy: Math.round((groupWidthEmu * childBoundsCy) / childBoundsCx),
  };
  const mapping = buildGroupMapping(GRP_1.children, groupTarget);
  const groupId = allocator.next();
  const childIds = GRP_1.children.map(() => allocator.next());
  if (childIds.some((id) => id === depId || id === groupId)) {
    throw new Error('group 子形状 id 与连线/组 id 冲突');
  }
  const { xml: groupXml, absoluteShapes } = buildGroupXml({
    id: groupId,
    name: GRP_1.name,
    children: GRP_1.children,
    mapping,
    childIds,
  });

  return {
    connectorXml,
    groupXml,
    groupAbsoluteShapes: absoluteShapes,
    groupMapping: mapping,
    connectorIds: { dep: depId, group: groupId, groupChildren: childIds },
    connectorPoints: { from: fromPoint, to: toPoint, fromId, toId },
  };
}
