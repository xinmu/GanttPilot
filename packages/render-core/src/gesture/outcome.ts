/**
 * 拖动**结果**解析、预览几何与**未提交文档副本**：
 * {@link resolveDragOutcome}（锚点、预览区间、松手 patch 的唯一来源）、
 * {@link dragPreviewFor} / {@link drawnBarForRow}（覆盖层与逐行几何）、
 * {@link previewDocumentFor}（P-45 的未提交副本）。
 *
 * "看到的"与"松手得到的"共用 {@link resolveDragOutcome} ⇒ 不可能分叉；本文件因此同时是
 * ADR 0008 §13/§14 与**附录 §3**（拖动期的下游）的落点。口径见 [`./index.ts`](./index.ts)。
 */

import type { Calendar, ProjectDocument } from '@ganttpilot/engine';

import { barXRange, milestoneCenterX } from '../domain.js';
import { SPACING } from '../manifest.js';
import type { RowBox, ViewModel } from '../viewModel.js';
import { candidateOrdinalFor } from './pointer.js';
import type { GestureState } from './state.js';

/**
 * 序号 → ISO：**越界返回 `undefined` 而不抛错**（地平线之外 = 无法表示）。
 *
 * 为什么必须有这一层：`Calendar.isoOfOrdinal` 在 `序号 > workdayCount` 时**抛错**
 * （`date.ts` 的 `dayOfOrdinal`），而拖动可以把结果推到地平线之外。旧实现直接调它，
 * 于是"拖到最右侧"会从事件处理器里抛出异常；批次 A 又把同一批换算用进了**渲染期的预览**，
 * 抛错会升级成渲染错误——因此这里统一收口为"不可表示"。
 */
function isoOfOrdinalSafe(calendar: Calendar, ordinal: number): string | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 0) return undefined;
  try {
    return calendar.isoOfOrdinal(ordinal);
  } catch {
    return undefined;
  }
}

/** {@link resolveDragOutcome} 的产出：拖动**结果**的完整描述（锚点、预览区间、松手命令）。 */
export interface DragOutcome {
  /** 相对抓取点的**工作日位移**（0 = 按下不动）。 */
  readonly delta: number;
  /** 会话锚点的开始序号（`resize-duration` 用原开始 ⇒ 条体本体不动）。 */
  readonly anchorOrdinal: number;
  /** 结果的开始序号（条形分支的 `es`）。 */
  readonly es: number;
  /** 结果的**排他**结束序号（条形分支的 `ef`；`resultDuration ≤ 0` 时等于 `es`）。 */
  readonly ef: number;
  /** 结果的工期（正数 = 条形；`≤ 0` = 仍是里程碑/零时长）。 */
  readonly resultDuration: number;
  /** 松手要提交的 patch；**`null` = 本次手势无操作**（按下不动）。 */
  readonly patch: Record<string, unknown> | null;
}

/**
 * 拖动结果解析：**锚点、预览几何与松手命令的唯一来源**（ADR 0008 §13）。
 *
 * 三件事都在这里定，因此"看到的预览"与"松手得到的文档"不可能分叉：
 * 1. **候选 → 结果序号**按模式分工（`move`/`resize-start` 的候选是新开始；
 *    `resize-duration` 的候选是新完成，并夹到不早于原开始）；
 * 2. **零位移不产出命令**：`resize-duration` 按 `delta === 0` 判定
 *    （按住里程碑右半区不动**不得**把它变成 1 天任务），其余两模式按"结果开始 == 原开始"判定
 *    （指针拖到项目起点左侧被夹回时也算无操作）；
 * 3. **零时长的完成日 = 开始日**：与 `derivedEndIso` / `cellText` 同口径
 *    （P-20 在显示层修过同一个式子，拖拽 patch 此前漏了）。
 */
export function resolveDragOutcome(args: {
  readonly state: Extract<GestureState, { kind: 'dragging' }>;
  readonly document: ProjectDocument;
  readonly calendar: Calendar;
}): DragOutcome | null {
  const { state } = args;
  const task = args.document.tasks.find((item) => item.id === state.taskId);
  if (task === undefined) return null;
  const duration = task.durationDays ?? 0;
  const origin = state.originOrdinal;
  const base = candidateOrdinalFor({
    mode: state.mode,
    originOrdinal: origin,
    durationDays: duration,
    delta: 0,
  });
  const delta = state.candidate - base;

  if (state.mode === 'resize-duration') {
    const endOrdinal = Math.max(origin, state.candidate);
    const resultDuration = Math.max(1, endOrdinal - origin + 1);
    // 完成日超出地平线 ⇒ `null`（**派生显示值**的既有口径：与 `editToCommand` 的工期分支同形，
    // 左表会回落到"开始 + 工期"的显示值，而不是一个错的日期，也不抛错）。
    const endIso = isoOfOrdinalSafe(args.calendar, origin + resultDuration - 1);
    return {
      delta,
      anchorOrdinal: origin,
      es: origin,
      ef: origin + resultDuration,
      resultDuration,
      // 按住不动 ⇒ 无操作（否则里程碑会被"按一下"变成 1 天任务）。
      patch: delta === 0 ? null : { durationDays: resultDuration, endDate: endIso ?? null },
    };
  }

  const es = Math.max(0, state.candidate);
  const startIso = isoOfOrdinalSafe(args.calendar, es);

  if (state.mode === 'resize-start') {
    // 改开始：完成日**不动** ⇒ 工期随之变化（不小于 1）。patch 不含 `endDate`。
    const resultDuration = Math.max(1, duration - (es - origin));
    return {
      delta,
      anchorOrdinal: es,
      es,
      ef: es + resultDuration,
      resultDuration,
      patch:
        es === origin || startIso === undefined
          ? // 开始序号不可表示（地平线之外）⇒ 整条手势无从落地，按"无操作"处理。
            null
          : {
              startDate: startIso,
              durationDays: resultDuration,
            },
    };
  }

  // `move`：工期不变（含零时长——里程碑始终是里程碑），两端一起走。
  const endOrdinal = duration <= 0 ? es : es + duration - 1;
  const endIso = isoOfOrdinalSafe(args.calendar, endOrdinal);
  return {
    delta,
    anchorOrdinal: es,
    es,
    ef: duration <= 0 ? es : es + duration,
    resultDuration: duration,
    patch:
      es === origin || startIso === undefined
        ? null
        : { startDate: startIso, endDate: endIso ?? null },
  };
}

/** {@link dragPreviewFor} 的产出：拖动覆盖层要画的那一段几何（内容坐标）。 */
export interface DragPreview {
  readonly taskId: string;
  /** 可见行序号（`-1` 不可能出现——行不可见时本函数返回 `null`）。 */
  readonly row: number;
  readonly xLeft: number;
  readonly xRight: number;
  /** 条/菱形的竖向中心。 */
  readonly y: number;
  readonly barY: number;
  readonly barHeight: number;
  readonly isMilestone: boolean;
  readonly milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null;
}

/**
 * 拖动预览几何：**与松手提交同源**（ADR 0008 §13）。
 *
 * 为什么需要它：会话锚点只有 `startOrdinal`（ADR 0004 §2 的形状不扩），因此
 * `resize-duration` 拖动期**条体本体不会动**、`resize-start` 拖动期的右端也会先"跟着走再回弹"。
 * 覆盖层改画**结果轮廓**（`move`/`resize-start` 用 `[候选, 候选 + 工期 − 1]`；
 * `resize-duration` 用 `[原开始, 候选]`），于是三种语义在拖动期都有诚实的可见反馈，
 * 而"看到的"与"松手得到的"共用 {@link resolveDragOutcome}，不会分叉。
 *
 * 里程碑：结果仍是零时长时按**菱形**出几何（`barXRange` 在 `ef − 1 = −1` 时按 `domain.ts`
 * 的口径会抛错，因此必须走菱形分支——与 `taskBounds` 的同一处判断同源）。
 */
export function dragPreviewFor(args: {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly calendar: Calendar;
  readonly state: GestureState;
}): DragPreview | null {
  const { view, state } = args;
  if (state.kind !== 'dragging') return null;
  const outcome = resolveDragOutcome({ state, document: args.document, calendar: args.calendar });
  if (outcome === null) return null;
  const docIndex = args.document.tasks.findIndex((task) => task.id === state.taskId);
  if (docIndex < 0) return null;
  const row = view.rowOfDocIndex[docIndex] ?? -1;
  if (row < 0) return null; // 折叠隐藏 ⇒ 没有可画的条（与 `taskBounds` 同口径）

  const rowHeight = view.rowHeight;
  const y = row * rowHeight + rowHeight / 2;

  /**
   * 几何一律**不许抛错**：本函数在渲染期被调用，而 `barXRange` / `milestoneCenterX` 在
   * 序号越出日历经线时会 `RangeError`/`fail`。拖到地平线之外时**没有可画的预览**（返回 `null`），
   * 由调用方保持上一帧的呈现——这与 `ordinalAtClamped`"越界夹回、不抛错"是同一条精神。
   */
  try {
    if (outcome.resultDuration <= 0) {
      const cx = milestoneCenterX({
        calendar: args.calendar,
        es: outcome.es,
        axisOriginDay: view.axisOriginDay,
        pxPerDay: view.pxPerDay,
      });
      const size = rowHeight * SPACING.milestoneSizeRatio;
      return {
        taskId: state.taskId,
        row,
        xLeft: cx - size / 2,
        xRight: cx + size / 2,
        y,
        barY: y - size / 2,
        barHeight: size,
        isMilestone: true,
        milestone: { cx, cy: y, size },
      };
    }

    const range = barXRange({
      calendar: args.calendar,
      es: outcome.es,
      ef: outcome.ef,
      axisOriginDay: view.axisOriginDay,
      pxPerDay: view.pxPerDay,
    });
    const barHeight = rowHeight * SPACING.barHeightRatio;
    return {
      taskId: state.taskId,
      row,
      xLeft: range.xLeft,
      xRight: range.xRight,
      y,
      barY: y - barHeight / 2,
      barHeight,
      isMilestone: false,
      milestone: null,
    };
  } catch {
    return null;
  }
}

/**
 * 一行**要画出来的条**（ADR 0008 §14 / 裁决 P-24）：拖动中的那一行画**结果几何**。
 *
 * 为什么需要它：会话锚点只有 `startOrdinal`（ADR 0004 §2 的形状不扩），因此拖动期
 * `compute` 给这一行的 `ef` 仍是"新开始 + **文档里的旧工期**"——
 * `resize-start` 于是表现成"整条平移、右端不固定"，`resize-duration` 则"条体本体不动"。
 * 而 {@link dragPreviewFor} 已经给出**与松手提交同源**的结果几何，本函数把它接到渲染侧：
 *
 * - 被拖行（`preview.taskId === row.id`）⇒ 用预览几何（`fromPreview: true`）；
 * - 其余行 ⇒ 原样用 `row` 自己的几何（不受影响）。
 *
 * **进度按比例跟随**：拖动期不重算进度，进度填充按 `结果宽度 × row.progressRatio` 画，
 * 这样 `resize-*` 期间它不会与轮廓脱节。
 */
export interface DrawnBar {
  readonly xLeft: number;
  readonly xRight: number;
  readonly y: number;
  readonly barY: number;
  readonly barHeight: number;
  readonly isMilestone: boolean;
  readonly milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null;
  /** `true` = 该行正在被拖动，几何来自预览（见 {@link dragPreviewFor}）。 */
  readonly fromPreview: boolean;
}

/** 该行要画的条：被拖行用**预览结果几何**，其余行用自身几何（ADR 0008 §14）。 */
export function drawnBarForRow(row: RowBox, preview: DragPreview | null): DrawnBar {
  if (preview !== null && preview.taskId === row.id) {
    return {
      xLeft: preview.xLeft,
      xRight: preview.xRight,
      y: preview.y,
      barY: preview.barY,
      barHeight: preview.barHeight,
      isMilestone: preview.isMilestone,
      milestone: preview.milestone,
      fromPreview: true,
    };
  }
  return {
    xLeft: row.xLeft,
    xRight: row.xRight,
    y: row.y,
    barY: row.barY,
    barHeight: row.barHeight,
    isMilestone: row.isMilestone,
    milestone: row.milestone,
    fromPreview: false,
  };
}

/**
 * 拖动期的**未提交文档副本**（裁决 P-45）：把"松手才会提交的 patch"提前应用到一份副本上。
 *
 * **它解决的是什么**：会话锚点只承载**位置**（ADR 0004 §2 的 `{taskId, startOrdinal}` 形状不扩），
 * 因此 `resize-duration` 拖动期 `compute` 看到的仍是**文档里的旧工期**——条体本体已由
 * {@link drawnBarForRow} 画成结果几何（ADR 0008 §14），但**下游**要等松手才一次到位。
 * 想让下游也"所见即所提交"，只能让 `compute` 看见**新工期**；而工期是文档字段
 * （不是锚点字段）⇒ 唯一的零契约变更做法就是"喂它一份改了这一个字段的副本"。
 *
 * **为什么不是扩锚点形状**：锚点不落盘（[ADR 0009 §6](../../../docs/02-adr/0009-持久化契约.md)），
 * 扩它没有跨会话收益；而 [ADR 0004 §2](../../../docs/02-adr/0004-排程契约.md) 已写明 v0.5 会随
 * `constraints`/`manual` **重做锚点解析** ⇒ 现在扩形状可能是一次注定被覆盖的契约变更
 * （与 ADR 0004 §1 拒绝把 `constraints` 写进签名的理由同族）。
 *
 * **口径（三条，缺一条就会分叉）**：
 * 1. `patch` **必须是** {@link resolveDragOutcome} 的产出（= 松手命令的同一个 `patch`）——
 *    调用方从 {@link GestureUpdate.dragOutcome} 取，**不得自己再推一遍**；
 * 2. 副本只用于 `compute` / `buildView`；**不得进命令通道、不得进撤销栈、不得落盘**。
 *    落库仍然只有一条路：松手时 `task.update` 经命令层（ADR 0003）；
 * 3. **只替换那一个任务对象**，其余任务与数组元素**按引用共享**（结构性共享，不深拷贝）——
 *    1,000 任务的副本因此是 O(n) 的指针拷贝，不是 O(文档体积) 的克隆。
 *
 * 返回 `null` = **没有预览**（`patch` 为 `null`，即零位移；或该 id 不在文档里）——
 * 调用方据此回落到已提交文档，而不是造一份"内容相同、身份不同"的副本。
 */
export function previewDocumentFor(args: {
  readonly document: ProjectDocument;
  readonly taskId: string;
  readonly patch: Record<string, unknown> | null;
}): ProjectDocument | null {
  if (args.patch === null) return null;
  const index = args.document.tasks.findIndex((task) => task.id === args.taskId);
  if (index < 0) return null;
  return {
    ...args.document,
    tasks: args.document.tasks.map((task, at) =>
      at === index ? { ...task, ...(args.patch as Partial<ProjectDocument['tasks'][number]>) } : task,
    ),
  };
}
