/**
 * **任务条 / 进度 / 菱形**的补丁片段（P3/C3 从 `template.ts` 拆出）。
 *
 * 一行在内层坐标系里的矩形 → 页面 EMU 矩形 → 一个或多个 `<p:sp>` 片段；
 * 片段清单同时供**一级组**（按包围盒分组）与**依赖线**（取 `barId` 吸附）使用，
 * 因此这里返回的是"片段 + 主形状 id"而不是裸字符串。
 */

import {
  EXPORT_LABEL_WIDTH_PX,
  HEADER_HEIGHT_PX,
  type RowBox,
} from '@ganttpilot/render-core';

import { COLOR, pxToEmu } from '../units.js';
import {
  IdAllocator,
  barSpXml,
  milestoneSpXml,
  NAMES,
  progressSpXml,
  type EmuRect,
} from '../ooxml.js';
import { slidePointOf, type TemplateAPlan } from './plan.js';

/** 一行的形状片段（补丁的注入单位）。 */
export interface RowFragment {
  readonly xml: string;
  readonly emu: EmuRect;
}

/** 一行的注入结果：片段清单 + 供 connector 引用的形状 id/name。 */
export interface RowShapes {
  readonly fragments: readonly RowFragment[];
  readonly barId: number;
  readonly barName: string;
}

/** 一行条形（或菱形）在内层坐标系里的矩形。 */
export function innerRectOfRow(row: RowBox): { x: number; y: number; width: number; height: number } {
  if (row.isMilestone && row.milestone !== null) {
    const half = row.milestone.size / 2;
    return {
      x: EXPORT_LABEL_WIDTH_PX + row.milestone.cx - half,
      y: row.milestone.cy - half,
      width: row.milestone.size,
      height: row.milestone.size,
    };
  }
  return {
    x: EXPORT_LABEL_WIDTH_PX + row.xLeft,
    y: row.barY,
    width: Math.max(1, row.xRight - row.xLeft),
    height: row.barHeight,
  };
}

/** 内层矩形 → 页面 EMU 矩形（`y` 要加上表头带，与 `svgString` 的 `offsetY` 同口径）。 */
export function emuRectOf(
  plan: TemplateAPlan,
  rect: { x: number; y: number; width: number; height: number },
): EmuRect {
  const topLeft = slidePointOf(plan, rect.x, HEADER_HEIGHT_PX + rect.y);
  return {
    x: pxToEmu(topLeft.x),
    y: pxToEmu(topLeft.y),
    cx: Math.max(1, pxToEmu(rect.width * plan.fit.scale)),
    cy: Math.max(1, pxToEmu(rect.height * plan.fit.scale)),
  };
}

/** 一行的形状片段构造（条 / 进度 / 菱形）。 */
export function buildRowShapes(args: {
  readonly plan: TemplateAPlan;
  readonly row: RowBox;
  readonly allocator: IdAllocator;
}): RowShapes {
  const { plan, row, allocator } = args;
  if (row.isMilestone && row.milestone !== null) {
    const emu = emuRectOf(plan, innerRectOfRow(row));
    const id = allocator.next();
    return {
      fragments: [
        {
          xml: milestoneSpXml({
            id,
            name: NAMES.milestone(row.id),
            rect: emu,
            fill: COLOR.milestone,
            stroke: COLOR.milestoneStroke,
          }),
          emu,
        },
      ],
      barId: id,
      barName: NAMES.milestone(row.id),
    };
  }

  const emu = emuRectOf(plan, innerRectOfRow(row));
  const barId = allocator.next();
  const fragments: RowFragment[] = [
    {
      xml: barSpXml({
        id: barId,
        name: NAMES.bar(row.id),
        rect: emu,
        fill: row.kind === 'summary' ? COLOR.barSummary : COLOR.bar,
        round: row.kind !== 'summary',
      }),
      emu,
    },
  ];
  if (row.hasProgress && emu.cx > 1) {
    /**
     * 进度的内缩：**在 EMU 上做 `y+1` / `cy-2`**（≈ 0 内缩），而 SVG 孪生实现用 **px** 内缩。
     *
     * 这不是笔误，是**已登记的跨投影差异**（决策 4「只登记不修」）：统一它必然改变 PPTX 的
     * golden 字节，属 v0.5 的"未来实现"。如实描述见 `PPTX.md` §三；接手要点（含 golden 重锚的纪律）见
     * `docs/01-roadmap/首版-记录-v0.2.md` §三.2。
     */
    const progressEmu: EmuRect = {
      x: emu.x,
      y: emu.y + 1,
      cx: Math.max(1, Math.round(emu.cx * row.progressRatio)),
      cy: Math.max(1, emu.cy - 2),
    };
    fragments.push({
      xml: progressSpXml({
        id: allocator.next(),
        name: NAMES.progress(row.id),
        rect: progressEmu,
        fill: COLOR.progress,
      }),
      emu: progressEmu,
    });
  }
  return { fragments, barId, barName: NAMES.bar(row.id) };
}
