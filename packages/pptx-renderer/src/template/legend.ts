/**
 * **图例的图元与开放箭头**（P3/C3 从 `template.ts` 拆出）。
 *
 * 坐标与文本取自**同一份** `plan.legendRows`（文本在 `text.ts`）——两处各排一次版就是
 * 人工复验第 4 条"图例摘要与 SVG/PNG 不一致"的翻版。
 */

import { COLOR, pxToEmu } from '../units.js';
import { IdAllocator, milestoneSpXml, NAMES, plainRectSpXml, triangleSpXml } from '../ooxml.js';
import type { TemplateAPlan } from './plan.js';

/**
 * 图例的**图元**（人工复验第 4 条）：与 `exportLegendItems()` 的条目一一对应，
 * 坐标与文本取自同一份 `plan.legendRows`。
 *
 * 四类依赖的箭头形态必须与条形图里一致（FS/FF 实心三角、SS/SF 空心箭头）——
 * 图例的职责就是"教会读者看图"，只画一条灰线等于没解释。
 */
export function legendSwatchXmlOf(args: {
  readonly plan: TemplateAPlan;
  readonly allocator: IdAllocator;
}): readonly string[] {
  const { plan, allocator } = args;
  const out: string[] = [];
  for (const row of plan.legendRows) {
    const styleKey = row.item.styleKey;
    const x = plan.sidebarBox.x + 6;
    /**
     * **垂直居中**（人工复验第 3 条）：文本盒以 `row.y - 6` 起、字号 9 pt（≈12 px 行高），
     * 因此文本的视觉中心 ≈ `row.y`；图元一律以 `row.y` 为中心摆放（而不是 `row.y - 9`）。
     */
    const centerY = row.y;
    if (styleKey === 'bar' || styleKey === 'bar-summary') {
      const height = styleKey === 'bar' ? 10 : 6;
      out.push(
        plainRectSpXml({
          id: allocator.next(),
          name: NAMES.legendSwatch(styleKey),
          rect: {
            x: pxToEmu(x),
            y: pxToEmu(centerY - height / 2),
            cx: pxToEmu(18),
            cy: pxToEmu(height),
          },
          fill: styleKey === 'bar' ? COLOR.bar : COLOR.barSummary,
        }),
      );
      continue;
    }
    if (styleKey === 'milestone') {
      out.push(
        milestoneSpXml({
          id: allocator.next(),
          name: NAMES.legendSwatch(styleKey),
          rect: { x: pxToEmu(x + 3), y: pxToEmu(centerY - 6), cx: pxToEmu(12), cy: pxToEmu(12) },
          fill: COLOR.milestone,
          stroke: COLOR.milestoneStroke,
        }),
      );
      continue;
    }
    const type = styleKey.replace('edge-', '');
    const hollow = type === 'SS' || type === 'SF';
    out.push(
      plainRectSpXml({
        id: allocator.next(),
        name: NAMES.legendSwatch(styleKey),
        rect: { x: pxToEmu(x), y: pxToEmu(centerY - 0.75), cx: pxToEmu(14), cy: pxToEmu(1.5) },
        fill: COLOR.edge,
      }),
    );
    if (hollow) {
      // 与画布同形：`SS`/`SF` 在 PPT 里是 OOXML 原生 `type="arrow"`（"→"），图例照画
      out.push(
        ...openArrowXml({
          allocator,
          name: `${NAMES.legendSwatch(styleKey)}-head`,
          tipX: x + 23,
          tipY: centerY,
          color: COLOR.edge,
        }),
      );
      continue;
    }
    out.push(
      triangleSpXml({
        id: allocator.next(),
        name: `${NAMES.legendSwatch(styleKey)}-head`,
        rect: { x: pxToEmu(x + 13), y: pxToEmu(centerY - 3), cx: pxToEmu(10), cy: pxToEmu(6) },
        rotateDeg: 90,
        fill: COLOR.edge,
        stroke: COLOR.edge,
      }),
    );
  }
  return out;
}

/**
 * **开放箭头（"→"）**：两条细矩形各旋转 ±45°，拼成一个**朝右**的尖角，尖端落在 `tipX`。
 *
 * ## 几何（`rot` 的正负是这里的全部难点）
 *
 * OOXML 的 `rot` 以**顺时针为正**，且旋转绕**自身包围盒中心**。一根水平细矩形（长 `L`）转 `θ` 后，
 * 它的两端在 `center ± (L/2)·(cosθ, sinθ)`。要让两条臂的**右端交于尖端** `(tipX, tipY)`：
 *
 * - **上臂**：另一端在左上方 ⇒ 方向 `(1,1)` ⇒ `θ = +45°`，中心 `= (tipX − d, tipY − d)`
 * - **下臂**：另一端在左下方 ⇒ 方向 `(1,−1)` ⇒ `θ = −45°`，中心 `= (tipX − d, tipY + d)`
 *
 * 其中 `d = (L/2)/√2`。**把两个 `θ` 写反就会得到"-<"**（两条臂改为共用**左端**顶点、
 * 尖角朝左）——这正是人工复验抓到的那次错误，判据已按"右端必须在尖端"写死。
 */
export function openArrowXml(args: {
  readonly allocator: IdAllocator;
  readonly name: string;
  readonly tipX: number;
  readonly tipY: number;
  readonly color: string;
}): readonly string[] {
  const armLength = 7;
  const armThickness = 1.5;
  const half = armLength / 2;
  const diag = half / Math.SQRT2;
  const arms: readonly { readonly centerY: number; readonly rotateDeg: number }[] = [
    { centerY: args.tipY - diag, rotateDeg: 45 },
    { centerY: args.tipY + diag, rotateDeg: -45 },
  ];
  return arms.map((arm, index) =>
    plainRectSpXml({
      id: args.allocator.next(),
      name: `${args.name}-arm${String(index + 1)}`,
      rect: {
        x: pxToEmu(args.tipX - diag - half),
        y: pxToEmu(arm.centerY - armThickness / 2),
        cx: pxToEmu(armLength),
        cy: pxToEmu(armThickness),
      },
      fill: args.color,
      rotateDeg: arm.rotateDeg,
    }),
  );
}
