/**
 * **依赖线：连线与吸附**（P3/C3 从 `template.ts` 拆出）。
 *
 * 两条纪律：
 * 1. 端点按**侧向表**（唯一登记处是 P-8 第 1 条，代码里是 `ROUTE_SIDES`）取条边，**不硬编码 idx**；
 * 2. 箭头用 OOXML 原生 `a:tailEnd`（随线重算、跟随端点），`SS`/`SF` 用开放箭头——
 *    自绘形状没有 `stCxn/endCxn` 锚点，WPS 拖动时它会留在原地（P-38 的实测结论）。
 */

import {
  EXPORT_LABEL_WIDTH_PX,
  HEADER_HEIGHT_PX,
  ROUTE_SIDES,
  type RowBox,
  type RouteSide,
} from '@ganttpilot/render-core';

import { COLOR, pxToEmu } from '../units.js';
import { connectorSpXml, custGeomSpXml, IdAllocator, NAMES, siteForSide } from '../ooxml.js';
import { slidePointOf, type TemplateAPlan } from './plan.js';
import type { RowShapes } from './rows.js';

/** 侧向表的类型化视图（唯一登记处是 P-8 第 1 条；本处只消费）。 */
const SIDES: Readonly<Record<string, { readonly exit: RouteSide; readonly enter: RouteSide }>> = ROUTE_SIDES;

/** 条形中心的**内层** y（连接点的竖向位置；里程碑取菱形中心）。 */
function barCenterInnerY(row: RowBox): number {
  if (row.isMilestone && row.milestone !== null) return row.milestone.cy;
  return row.barY + row.barHeight / 2;
}

/** 依赖线端点的**内层** x（出/入侧取条边；里程提取菱形左右顶点）。 */
function sideInnerX(row: RowBox, side: RouteSide): number {
  if (row.isMilestone && row.milestone !== null) {
    const half = row.milestone.size / 2;
    return EXPORT_LABEL_WIDTH_PX + row.milestone.cx + (side === 'right' ? half : -half);
  }
  return EXPORT_LABEL_WIDTH_PX + (side === 'right' ? row.xRight : row.xLeft);
}

/**
 * 全部依赖线的片段（按 `view.edges` 顺序，id 由同一分配器给出 ⇒ golden 可复现）。
 *
 * `degradeConnectors` 为真时走**降级②**：`custGeom` 折线（三条 `lnTo` 点、仍带 `tailEnd`）。
 */
export function edgesXmlOf(args: {
  readonly plan: TemplateAPlan;
  readonly shapesOf: ReadonlyMap<string, RowShapes>;
  readonly allocator: IdAllocator;
  readonly degradeConnectors: boolean;
}): readonly string[] {
  const { plan, shapesOf, allocator, degradeConnectors } = args;
  const rowByDocIndex = new Map<number, RowBox>();
  for (const row of plan.projection.view.rows) rowByDocIndex.set(row.docIndex, row);
  const edgeXml: string[] = [];
  for (const edge of plan.projection.view.edges) {
    const fromRow = rowByDocIndex.get(edge.fromDoc);
    const toRow = rowByDocIndex.get(edge.toDoc);
    const fromShapes = fromRow === undefined ? undefined : shapesOf.get(fromRow.id);
    const toShapes = toRow === undefined ? undefined : shapesOf.get(toRow.id);
    if (fromRow === undefined || toRow === undefined || fromShapes === undefined || toShapes === undefined) continue;
    const sides = SIDES[edge.type] ?? SIDES.FS;
    if (sides === undefined) continue;
    const fromPoint = slidePointOf(
      plan,
      sideInnerX(fromRow, sides.exit),
      HEADER_HEIGHT_PX + barCenterInnerY(fromRow),
    );
    const toPoint = slidePointOf(plan, sideInnerX(toRow, sides.enter), HEADER_HEIGHT_PX + barCenterInnerY(toRow));
    const id = allocator.next();
    const color = edge.ignored ? COLOR.edgeIgnored : COLOR.edge;
    /**
     * 箭头形态：`FS`/`FF` 实心三角、`SS`/`SF` 开放箭头（"→"）。
     *
     * **为什么 `SS`/`SF` 不用"自绘空心三角"**（P-38 的实测结论）：自绘形状没有 `stCxn/endCxn`
     * 吸附锚点 ⇒ **WPS 从不重算它的位置**，拖动入端那条任务条时箭头会留在原地，
     * 而依赖线本身会重走线。G7 的招牌行为是"拖动后端点跟随"，优先级高于形状一致
     * （维护者亦认可该差异"不影响理解"）。见 [ADR 0010 附录 §2](../../../../docs/02-adr/附录/0010-增补.md)。
     */
    const arrow: 'solid' | 'open' = edge.type === 'SS' || edge.type === 'SF' ? 'open' : 'solid';
    if (degradeConnectors) {
      const left = Math.min(fromPoint.x, toPoint.x);
      const top = Math.min(fromPoint.y, toPoint.y);
      edgeXml.push(
        custGeomSpXml({
          id,
          name: NAMES.edge(edge.linkId),
          rect: {
            x: pxToEmu(left),
            y: pxToEmu(top),
            cx: Math.max(1, pxToEmu(Math.abs(toPoint.x - fromPoint.x))),
            cy: Math.max(1, pxToEmu(Math.abs(toPoint.y - fromPoint.y))),
          },
          points: [
            { x: pxToEmu(fromPoint.x), y: pxToEmu(fromPoint.y) },
            { x: pxToEmu(toPoint.x), y: pxToEmu(fromPoint.y) },
            { x: pxToEmu(toPoint.x), y: pxToEmu(toPoint.y) },
          ],
          color,
          arrow,
        }),
      );
      continue;
    }
    edgeXml.push(
      connectorSpXml({
        id,
        name: NAMES.edge(edge.linkId),
        fromId: fromShapes.barId,
        fromIdx: siteForSide(sides.exit),
        toId: toShapes.barId,
        toIdx: siteForSide(sides.enter),
        fromPoint: { x: pxToEmu(fromPoint.x), y: pxToEmu(fromPoint.y) },
        toPoint: { x: pxToEmu(toPoint.x), y: pxToEmu(toPoint.y) },
        color,
        ignored: edge.ignored,
        arrow,
      }),
    );
  }
  return edgeXml;
}
