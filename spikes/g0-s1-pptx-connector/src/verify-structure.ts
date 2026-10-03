/**
 * L1 结构自检：对**打补丁后的** `slide1.xml` 做可证伪的断言。
 *
 * 设计原则：每条检查都返回「名称 + 通过与否 + 实测细节」，明细写入
 * `evidence/structure-report.md`。**任何一条失败即非零退出**——
 * 结构正确是后续所有证据（视觉、往返、拖动）的前提。
 *
 * 与《证伪实验计划》Day 2 第 8 步的对应关系：
 * 「断言无 id 重复且 idx < 目标连接点数量」在这里被拆成 `ids-unique` /
 * `idx-in-range` 两条独立检查，便于失败时定位。
 */

import { compareRectMaps, recomputeAbsoluteFromMapping, type RectMap } from './flatten-group.ts';
import {
  DEP_1,
  GRP_1,
  PT,
  ROUND_RECT_SITE_COUNT,
  SHAPES,
  SLIDE,
  connectionPoint,
  type Rect,
} from './manifest.ts';
import { checkIdRule, extractSpTree, parseShapeRefs } from './xml.ts';

/** 单条检查结果。 */
export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerifyInput {
  /** 打补丁后的完整 `slide1.xml`。 */
  readonly slideXml: string;
  /** 补丁器计算的 group 子形状绝对矩形（**独立于 XML** 的一份声明）。 */
  readonly groupAbsolute: RectMap;
  /** 补丁器声明的 group 组框绝对矩形（用于「组底边是否越出画布」断言）。 */
  readonly groupFrame: Rect;
  /** 容器的**实测**幻灯片尺寸（由 `p:sldSz` 读回），用于抓「manifest 与容器漂移」。 */
  readonly containerSlideSize: { cx: number; cy: number };
}

/** 一个形状在 XML 中的解析结果（够用于断言）。 */
interface ParsedShape {
  readonly kind: 'sp' | 'cxnSp' | 'grpSp';
  readonly id: number;
  readonly name: string;
  readonly fragment: string;
}

/**
 * 按文档顺序切出形状片段。
 *
 * 刻意用「标签配对」而不是完整 XML 解析：本 spike 的形状树是扁平的
 * （`p:sp` / `p:cxnSp` / `p:grpSp`，其中 `p:grpSp` 内嵌 `p:sp`），
 * 用栈匹配即可，且能精确看出 id 落在哪个容器里。
 */
function sliceShapes(spTree: string): ParsedShape[] {
  const shapes: ParsedShape[] = [];
  const re = /<p:(sp|cxnSp|grpSp)>([\s\S]*?)<\/p:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spTree)) !== null) {
    const kind = m[1] as ParsedShape['kind'];
    const body = m[2];
    if (body === undefined) continue;
    const head = /<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"/.exec(body);
    if (head?.[1] === undefined || head[2] === undefined) continue;
    shapes.push({ kind, id: Number(head[1]), name: head[2], fragment: m[0] });
  }
  return shapes;
}

/** 读取 `grpSpPr/xfrm` 的四个值。 */
function readGroupXfrm(fragment: string): {
  off: { x: number; y: number };
  ext: { cx: number; cy: number };
  chOff: { x: number; y: number };
  chExt: { cx: number; cy: number };
} | null {
  const block = /<p:grpSpPr>\s*<a:xfrm>([\s\S]*?)<\/a:xfrm>/.exec(fragment);
  if (block?.[1] === undefined) return null;
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block[1]);
  const ext = /<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(block[1]);
  const chOff = /<a:chOff x="(-?\d+)" y="(-?\d+)"\/>/.exec(block[1]);
  const chExt = /<a:chExt cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(block[1]);
  if (!off || !ext || !chOff || !chExt) return null;
  return {
    off: { x: Number(off[1]), y: Number(off[2]) },
    ext: { cx: Number(ext[1]), cy: Number(ext[2]) },
    chOff: { x: Number(chOff[1]), y: Number(chOff[2]) },
    chExt: { cx: Number(chExt[1]), cy: Number(chExt[2]) },
  };
}

/** 从 `<p:grpSp>` 片段中取出**直接子形状**（`<p:sp>`）。 */
function sliceGroupChildren(groupFragment: string): ParsedShape[] {
  const children: ParsedShape[] = [];
  const re = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(groupFragment)) !== null) {
    const body = m[1];
    if (body === undefined) continue;
    const head = /<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"/.exec(body);
    if (head?.[1] === undefined || head[2] === undefined) continue;
    children.push({ kind: 'sp', id: Number(head[1]), name: head[2], fragment: m[0] });
  }
  return children;
}

/** 执行全部 L1 检查。 */
export function verifyStructure(input: VerifyInput): Check[] {
  const checks: Check[] = [];
  const push = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  // ---------------------------------------------------------------- 基础可解析
  let spTree: string;
  try {
    spTree = extractSpTree(input.slideXml);
    push('sptree-present', true, `形状树长度 ${String(spTree.length)} 字符`);
  } catch (error) {
    push('sptree-present', false, String(error instanceof Error ? error.message : error));
    return checks;
  }

  let shapes: ParsedShape[];
  try {
    shapes = sliceShapes(spTree);
    push('shapes-sliced', shapes.length > 0, `解析出 ${String(shapes.length)} 个形状（含组内子形状）`);
  } catch (error) {
    push('shapes-sliced', false, String(error instanceof Error ? error.message : error));
    return checks;
  }

  // ---------------------------------------------------------------- id 唯一性
  const idCounts = new Map<number, string[]>();
  for (const shape of shapes) {
    const owners = idCounts.get(shape.id) ?? [];
    owners.push(shape.name);
    idCounts.set(shape.id, owners);
  }
  const dupIds = [...idCounts.entries()].filter(([, owners]) => owners.length > 1);
  push(
    'ids-unique',
    dupIds.length === 0,
    dupIds.length === 0
      ? `${String(idCounts.size)} 个 id 全树唯一（含组内子形状）`
      : `重复 id：${dupIds.map(([id, owners]) => `id=${String(id)} ← ${owners.join(' / ')}`).join('; ')}`,
  );

  // ------------------------------------------------- id 规则（仅作断言，不作依据）
  const containerRefs = parseShapeRefs(spTree).filter((ref) =>
    Object.keys(SHAPES).includes(ref.name),
  );
  const idRule = checkIdRule(containerRefs);
  push(
    'id-equals-idx-plus-2',
    idRule.matchesIdxPlusTwo,
    idRule.matchesIdxPlusTwo
      ? '容器形状满足 pptxgenjs 的 id = idx + 2 规则（补丁器不依赖该规则，仅断言）'
      : `不符：${idRule.rows.map((r) => `${r.name} idx=${String(r.idx)} id=${String(r.id)} 期望 ${String(r.expected)}`).join('; ')}`,
  );

  // ---------------------------------------------------------------- connector
  const cxn = shapes.find((shape) => shape.kind === 'cxnSp');
  push('connector-exists', cxn !== undefined, cxn === undefined ? '未找到 <p:cxnSp>' : `name=${cxn.name} id=${String(cxn.id)}`);

  if (cxn !== undefined) {
    push('connector-name', cxn.name === DEP_1.name, `期望 ${DEP_1.name}，实测 ${cxn.name}`);
    // 锚点必须在 p:nvCxnSpPr > p:cNvCxnSpPr 下，且为 a: 前缀元素
    const anchorOk = /<p:nvCxnSpPr>[\s\S]*?<p:cNvCxnSpPr>[\s\S]*?<a:stCxn id="\d+" idx="\d+"\/>[\s\S]*?<a:endCxn id="\d+" idx="\d+"\/>/.test(
      cxn.fragment,
    );
    push('connector-anchors-a-namespace', anchorOk, anchorOk ? 'stCxn/endCxn 位于 p:nvCxnSpPr > p:cNvCxnSpPr 且为 a: 前缀' : '锚点位置或命名空间不符');

    const st = /<a:stCxn id="(\d+)" idx="(\d+)"\/>/.exec(cxn.fragment);
    const en = /<a:endCxn id="(\d+)" idx="(\d+)"\/>/.exec(cxn.fragment);
    if (st?.[1] !== undefined && st[2] !== undefined && en?.[1] !== undefined && en[2] !== undefined) {
      const stId = Number(st[1]);
      const stIdx = Number(st[2]);
      const enId = Number(en[1]);
      const enIdx = Number(en[2]);
      const byId = new Map(shapes.map((shape) => [shape.id, shape.name]));
      push('stcxn-target-resolves', byId.get(stId) === DEP_1.from.shape, `stCxn id=${String(stId)} → ${byId.get(stId) ?? '(不存在)'}，期望 ${DEP_1.from.shape}`);
      push('endcxn-target-resolves', byId.get(enId) === DEP_1.to.shape, `endCxn id=${String(enId)} → ${byId.get(enId) ?? '(不存在)'}，期望 ${DEP_1.to.shape}`);
      push('stcxn-idx-in-range', stIdx >= 0 && stIdx < ROUND_RECT_SITE_COUNT, `stCxn idx=${String(stIdx)}，roundRect 合法范围 0..${String(ROUND_RECT_SITE_COUNT - 1)}`);
      push('endcxn-idx-in-range', enIdx >= 0 && enIdx < ROUND_RECT_SITE_COUNT, `endCxn idx=${String(enIdx)}，roundRect 合法范围 0..${String(ROUND_RECT_SITE_COUNT - 1)}`);
      push('stcxn-idx-matches-manifest', stIdx === DEP_1.from.site, `stCxn idx=${String(stIdx)}，manifest 期望 ${String(DEP_1.from.site)}`);
      push('endcxn-idx-matches-manifest', enIdx === DEP_1.to.site, `endCxn idx=${String(enIdx)}，manifest 期望 ${String(DEP_1.to.site)}`);
      push('connector-no-cxnSpLocks', !cxn.fragment.includes('cxnSpLocks'), cxn.fragment.includes('cxnSpLocks') ? '出现了 cxnSpLocks（与原生产物不一致）' : '与原生产物一致：未写 cxnSpLocks');
    } else {
      push('connector-anchors-parseable', false, '无法从 connector 片段中解析出 stCxn/endCxn');
    }

    const prst = /<a:prstGeom prst="([^"]+)"/.exec(cxn.fragment);
    push('connector-prstgeom', prst?.[1] === DEP_1.prst, `prstGeom=${prst?.[1] ?? '(缺失)'}，期望 ${DEP_1.prst}`);
  }

  // ---------------------------------------------------------------- group
  const grp = shapes.find((shape) => shape.kind === 'grpSp');
  push('group-exists', grp !== undefined, grp === undefined ? '未找到 <p:grpSp>' : `name=${grp.name} id=${String(grp.id)}`);

  if (grp !== undefined) {
    push('group-name', grp.name === GRP_1.name, `期望 ${GRP_1.name}，实测 ${grp.name}`);
    const xfrm = readGroupXfrm(grp.fragment);
    if (xfrm === null) {
      push('group-xfrm-complete', false, 'grpSpPr/xfrm 缺少 off/ext/chOff/chExt 中的至少一项');
    } else {
      push(
        'group-xfrm-complete',
        xfrm.ext.cx > 0 && xfrm.ext.cy > 0 && xfrm.chExt.cx > 0 && xfrm.chExt.cy > 0,
        `off=(${String(xfrm.off.x)},${String(xfrm.off.y)}) ext=cx ${String(xfrm.ext.cx)} cy ${String(xfrm.ext.cy)}；chOff=(${String(xfrm.chOff.x)},${String(xfrm.chOff.y)}) chExt=cx ${String(xfrm.chExt.cx)} cy ${String(xfrm.chExt.cy)}`,
      );
      // 组坐标与绝对坐标必须是两套数字，否则换算写了也没被检验
      const distinct =
        xfrm.chOff.x !== xfrm.off.x ||
        xfrm.chOff.y !== xfrm.off.y ||
        xfrm.chExt.cx !== xfrm.ext.cx ||
        xfrm.chExt.cy !== xfrm.ext.cy;
      push('group-child-space-distinct', distinct, distinct ? 'chOff/chExt 与 off/ext 是两套数值，换算公式确实参与' : '两套数值相同：坐标换算未被真正检验（fixture 退化）');

      // 组内子形状必须在组坐标系内（即落在 chOff..chOff+chExt 内）
      const childShapes = sliceGroupChildren(grp.fragment);
      push('group-children-count', childShapes.length === GRP_1.children.length, `组内子形状 ${String(childShapes.length)} 个，期望 ${String(GRP_1.children.length)} 个`);
      const inChildSpace = childShapes.every((child) => {
        const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(child.fragment);
        if (!off?.[1] || !off[2]) return false;
        const x = Number(off[1]);
        const y = Number(off[2]);
        return (
          x >= xfrm.chOff.x &&
          y >= xfrm.chOff.y &&
          x <= xfrm.chOff.x + xfrm.chExt.cx &&
          y <= xfrm.chOff.y + xfrm.chExt.cy
        );
      });
      push('group-children-in-child-space', inChildSpace, inChildSpace ? '所有子形状坐标落在 chOff/chExt 定义的组坐标系内' : '存在子形状坐标落在组坐标系之外（换算必错）');

      // 独立复算：**只依据 XML 里解析出的 off/ext/chOff/chExt** 重推子形状绝对矩形，
      // 与补丁器在内存中声明的绝对矩形逐值比对。两条路径若分叉，说明写进 XML 的映射有误。
      const recomputed = recomputeAbsoluteFromMapping(GRP_1.children, {
        off: xfrm.off,
        ext: xfrm.ext,
        chOff: xfrm.chOff,
        chExt: xfrm.chExt,
        scaleX: xfrm.ext.cx / xfrm.chExt.cx,
        scaleY: xfrm.ext.cy / xfrm.chExt.cy,
      });
      const crossCheckRows = compareRectMaps(recomputed, input.groupAbsolute);
      push(
        'group-absolute-crosscheck',
        crossCheckRows.every((row) => row.passed),
        crossCheckRows.map((row) => `${row.name}: ${row.detail}`).join('; '),
      );
    }
  }

  // ---------------------------------------------------------------- 边界内
  // 先抓「manifest 与容器漂移」：这是最容易让后续所有边界断言集体失灵的根因。
  push(
    'container-slide-size-matches-manifest',
    input.containerSlideSize.cx === SLIDE.cx && input.containerSlideSize.cy === SLIDE.cy,
    `容器实测 p:sldSz=${String(input.containerSlideSize.cx)}×${String(input.containerSlideSize.cy)} EMU（${String(input.containerSlideSize.cx / PT)}×${String(input.containerSlideSize.cy / PT)} pt）；manifest 声明 ${String(SLIDE.cx)}×${String(SLIDE.cy)} EMU（${String(SLIDE.cx / PT)}×${String(SLIDE.cy / PT)} pt）`,
  );

  const outOfBounds: string[] = [];
  for (const name of Object.keys(SHAPES)) {
    const rect = SHAPES[name];
    if (rect === undefined) continue;
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.cx > SLIDE.cx || rect.y + rect.cy > SLIDE.cy) {
      outOfBounds.push(name);
    }
  }
  push('fixture-shapes-in-slide-bounds', outOfBounds.length === 0, outOfBounds.length === 0 ? `三个基础形状都在 ${String(SLIDE.cx / PT)}×${String(SLIDE.cy / PT)} pt 幻灯片内（越界形状会渲染到画布外）` : `越界：${outOfBounds.join(', ')}`);

  // 组框与每个子形状都必须完整落在画布内——曾经 group 底边越界被裁，而其它断言全绿。
  const frameInBounds =
    input.groupFrame.x >= 0 &&
    input.groupFrame.y >= 0 &&
    input.groupFrame.x + input.groupFrame.cx <= SLIDE.cx &&
    input.groupFrame.y + input.groupFrame.cy <= SLIDE.cy;
  push(
    'group-frame-in-slide-bounds',
    frameInBounds,
    `组框 x=${String(input.groupFrame.x)} y=${String(input.groupFrame.y)} cx=${String(input.groupFrame.cx)} cy=${String(input.groupFrame.cy)}；底边 ${String((input.groupFrame.y + input.groupFrame.cy) / PT)} pt，画布高 ${String(SLIDE.cy / PT)} pt`,
  );

  const childrenOutOfBounds = [...input.groupAbsolute.entries()].filter(([, rect]) => {
    return rect.x < 0 || rect.y < 0 || rect.x + rect.cx > SLIDE.cx || rect.y + rect.cy > SLIDE.cy;
  });
  push(
    'group-children-in-slide-bounds',
    childrenOutOfBounds.length === 0,
    childrenOutOfBounds.length === 0
      ? `全部 ${String(input.groupAbsolute.size)} 个子形状绝对矩形都在画布内`
      : `越界：${childrenOutOfBounds.map(([name, rect]) => `${name}(y+h=${String((rect.y + rect.cy) / PT)}pt)`).join(', ')}`,
  );

  // 连线两端点也必须落在幻灯片内
  const fromRect = SHAPES[DEP_1.from.shape];
  const toRect = SHAPES[DEP_1.to.shape];
  if (fromRect !== undefined && toRect !== undefined) {
    const p1 = connectionPoint(fromRect, DEP_1.from.site);
    const p2 = connectionPoint(toRect, DEP_1.to.site);
    const inBounds = (p: { x: number; y: number }): boolean => p.x >= 0 && p.y >= 0 && p.x <= SLIDE.cx && p.y <= SLIDE.cy;
    push('connector-points-in-slide-bounds', inBounds(p1) && inBounds(p2), `从 (${String(p1.x)},${String(p1.y)}) 到 (${String(p2.x)},${String(p2.y)})`);
  }

  return checks;
}
