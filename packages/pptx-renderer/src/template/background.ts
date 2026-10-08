/**
 * **背景图元：层序与注入**（P3/C3 从 `template.ts` 拆出）。
 *
 * 顺序即"谁能盖住谁"（OOXML 按文档序绘制）——四层顺序是**判据**而不是实现细节，
 * 因此本文件刻意按层拆成四段、不合并成一个循环。
 */

import { EXPORT_LABEL_WIDTH_PX, EXPORT_TICK_LENGTH_PX, HEADER_HEIGHT_PX } from '@ganttpilot/render-core';

import { COLOR, pxToEmu } from '../units.js';
import { IdAllocator, NAMES, plainRectSpXml } from '../ooxml.js';
import { slidePointOf, type TemplateAPlan } from './plan.js';

/**
 * 背景图元（人工复验第 2 条 + G8 复验第 ④⑤ 条的订正）：**按层画**，与屏幕/SVG **同顺序**。
 *
 * 顺序即"谁能盖住谁"（OOXML 按文档序绘制）：
 *
 * | # | 层 | 名称 | 为什么在这个位置 |
 * |---|---|---|---|
 * | ① | 上级分段的**正文**（绘制区、近乎白、整高） | `major-band-N` | 它整高覆盖全宽 ⇒ **必须最先**，否则会把周末灰度带盖掉（首版的错） |
 * | ② | **周末/假日灰度带**（绘制区、整高） | `band-N` | 压在月份分组底**之上** ⇒ "哪几天不上班"永远看得见 |
 * | ③ | 上级分段的**全高边界线**与**表头底** | `major-band-N-edge` / `-head` | 边界压在背景之上；表头底在表头带内 |
 * | ④ | **下级刻度线**（只在表头带内的短线） | `grid-N` | 刻度归刻度区 ⇒ **不得**画进条体区（首版画满了绘制区） |
 *
 * 与 SVG 取自**同一份** `view.axis`（`band` / `major-band` / `gridline`），因此"哪几天是休息日"
 * 与"月从哪里开始"逐格一致。全部注入在条形之前 ⇒ 天然在底层（OOXML 按文档序绘制）。
 */
export function backgroundXmlOf(args: {
  readonly plan: TemplateAPlan;
  readonly allocator: IdAllocator;
}): readonly string[] {
  const { plan, allocator } = args;
  const rowsHeight = plan.projection.view.rowCount * plan.projection.view.rowHeight * plan.fit.scale;
  const top = slidePointOf(plan, 0, HEADER_HEIGHT_PX).y;
  const headerTop = slidePointOf(plan, 0, 0).y;
  const headerHeight = (HEADER_HEIGHT_PX - top) * plan.fit.scale;
  const chartWidth = plan.projection.view.width;
  const out: string[] = [];
  let bandIndex = 0;
  let gridIndex = 0;
  let majorIndex = 0;
  const xPxOf = (xInView: number): number =>
    plan.ganttBox.x + plan.fit.offsetX + (EXPORT_LABEL_WIDTH_PX + xInView) * plan.fit.scale;
  const majorBands = plan.projection.view.axis.filter((element) => element.kind === 'major-band');

  // ① 上级分段的正文（近乎白，整高）——**最先画**
  for (const element of majorBands) {
    const clampedX = Math.min(Math.max(element.x, 0), chartWidth);
    const widthPx = Math.max(1, Math.min(element.width, chartWidth - clampedX));
    out.push(
      plainRectSpXml({
        id: allocator.next(),
        name: NAMES.majorBand(majorIndex),
        rect: {
          x: pxToEmu(xPxOf(clampedX)),
          y: pxToEmu(top),
          cx: Math.max(1, pxToEmu(widthPx * plan.fit.scale)),
          cy: Math.max(1, pxToEmu(rowsHeight)),
        },
        fill: COLOR.majorBody,
      }),
    );
    majorIndex += 1;
  }
  // ② 周末/假日灰度带——压在月份分组底之上
  for (const element of plan.projection.view.axis) {
    if (element.kind !== 'band') continue;
    const x = xPxOf(element.x);
    // **裁到绘制区内**：`buildAxis` 允许色带越过右缘（SVG 里由侧栏底色盖住），
    // PPTX 的侧栏是透明的 ⇒ 不裁就会在侧栏区里露出一条灰带。
    // 注意：**计数必须与 `view.axis` 的 band 数一致**（判据断言"逐条同源"），因此夹到 ≥1 px 而不是跳过。
    const widthPx = Math.max(1, Math.min(element.width, chartWidth - Math.max(0, element.x)));
    out.push(
      plainRectSpXml({
        id: allocator.next(),
        name: NAMES.band(bandIndex),
        rect: {
          x: pxToEmu(x),
          y: pxToEmu(top),
          cx: Math.max(1, pxToEmu(widthPx * plan.fit.scale)),
          cy: Math.max(1, pxToEmu(rowsHeight)),
        },
        fill: COLOR.band,
      }),
    );
    bandIndex += 1;
  }
  // ③ 上级分段的边界（全高）与表头底
  majorIndex = 0;
  for (const element of majorBands) {
    const clampedX = Math.min(Math.max(element.x, 0), chartWidth);
    const widthPx = Math.max(1, Math.min(element.width, chartWidth - clampedX));
    out.push(
      plainRectSpXml({
        id: allocator.next(),
        name: `${NAMES.majorBand(majorIndex)}-edge`,
        rect: {
          x: pxToEmu(xPxOf(clampedX)),
          y: pxToEmu(headerTop),
          cx: Math.max(1, pxToEmu(1)),
          cy: Math.max(1, pxToEmu(headerHeight + rowsHeight)),
        },
        fill: COLOR.majorEdge,
      }),
      plainRectSpXml({
        id: allocator.next(),
        name: `${NAMES.majorBand(majorIndex)}-head`,
        rect: {
          x: pxToEmu(xPxOf(clampedX)),
          y: pxToEmu(headerTop),
          cx: Math.max(1, pxToEmu(widthPx * plan.fit.scale)),
          cy: Math.max(1, pxToEmu(headerHeight)),
        },
        fill: COLOR.majorHeader,
      }),
    );
    majorIndex += 1;
  }
  // ④ 下级刻度线：只在表头带内的**短刻度**（"刻度归刻度区"）
  for (const element of plan.projection.view.axis) {
    if (element.kind !== 'gridline') continue;
    const clamped = Math.min(Math.max(element.x, 0), chartWidth);
    const tickTop = top - EXPORT_TICK_LENGTH_PX * plan.fit.scale;
    out.push(
      plainRectSpXml({
        id: allocator.next(),
        name: NAMES.grid(gridIndex),
        rect: {
          x: pxToEmu(xPxOf(clamped)),
          y: pxToEmu(tickTop),
          cx: Math.max(1, pxToEmu(1)),
          cy: Math.max(1, pxToEmu(top - tickTop)),
        },
        fill: COLOR.gridline,
      }),
    );
    gridIndex += 1;
  }
  return out;
}
