/**
 * **拖动不得把预览推出渲染地平线**（人工报障 2026-10-05 的回归判据）。
 *
 * ## 报障与根因
 *
 * 维护者在**打包产物**上把演示计划的任务 1.1（`t1`：链路起点、显式锚定项目开始日）向左拖，
 * **整页变白**、刷新可恢复。浏览器里抓到的渲染期异常：
 *
 * ```
 * [组件] App / RangeError: 工作日序号越界：102（合法范围 0..95；…）
 *     at Calendar.dayOfOrdinal → buildView → contentWidthFor
 * ```
 *
 * 其中**可判定的一半**是夹取方向猜错（`gesture.ts` 的 `ordinalAtClamped`）：
 * 旧实现在 `day < baseDay` 抛错后按 `x <= 0` 猜方向，而 `baseDay` 左侧在屏幕上**不是 `x <= 0`**
 * （轴线起点 = `dayOfOrdinal(projectStart) − AXIS_LEFT_GUTTER_DAYS`），于是"向左拖一点点"
 * 被判成"向右越界"，候选被甩到**最右序号**（4 → 94）⇒ patch 写成远期日期 ⇒
 * 完成序号随即超出调用方日历容量 ⇒ 渲染抛错、Vue 卸载整棵树。
 *
 * 本文件把**这一半**钉死；"预览超出调用方日历容量"那一半（`SCHEDULE.md` §七 的调用方义务）
 * 由工程记录登记为**待裁决的独立缺口**——它与本条同源但不同因，修法要动
 * `createScheduleCalendar` 的口径或 `ScheduleResult` 的形状（契约面），不在本轮擅自改。
 */

import { describe, expect, it } from 'vitest';

import { compute, createScheduleCalendar, type ProjectDocument, type Schedule } from '@ganttpilot/engine';

import { createDemoPlanDocument } from './demoPlan.js';
import { buildView, type ViewModel, type Viewport } from './viewModel.js';
import { ROW_BUFFER, ROW_HEIGHT } from './manifest.js';
import { beginGesture, ordinalAtClamped, previewDocumentFor, resolveDragOutcome, type GestureState } from './gesture.js';

const viewport: Viewport = {
  width: 1280,
  height: 640,
  rowHeight: ROW_HEIGHT,
  rowBuffer: ROW_BUFFER,
  scrollTop: 0,
  scrollLeft: 0,
};

interface Pipeline {
  readonly document: ProjectDocument;
  readonly calendar: ReturnType<typeof createScheduleCalendar>;
  readonly schedule: Schedule;
  readonly view: ViewModel;
}

/** 与页面默认文档**同一份**演示计划（P-34），走与 App 相同的构造顺序。 */
function pipeline(): Pipeline {
  const document = createDemoPlanDocument();
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) throw new Error('演示计划不可排程（夹具前提不成立）');
  const view = buildView({ document, schedule: result.schedule, calendar, viewport, zoom: 'day' });
  return { document, calendar, schedule: result.schedule, view };
}

/** 抓取点：条体第一个工作日格的中点（按下不动 = 零位移，与 `measure.ts` 同口径）。 */
function grabXOf(view: ViewModel, taskId: string): { readonly grabX: number; readonly y: number; readonly xLeft: number } {
  const row = view.rows.find((item) => item.id === taskId);
  if (row === undefined) throw new Error(`${taskId} 不在渲染窗口内`);
  return { grabX: row.xLeft + view.pxPerDay / 2, y: row.row * view.rowHeight + view.rowHeight / 2, xLeft: row.xLeft };
}

/** 把条体拖到 `dragX`，返回"松手前预览"能否建出视图。 */
function dragTo(taskId: string, dragX: number): { readonly candidate: number; readonly built: boolean; readonly error: string | null } {
  const { document, calendar, schedule, view } = pipeline();
  const { grabX, y } = grabXOf(view, taskId);
  const begin = beginGesture({ view, document, schedule, calendar, pointer: { x: grabX, y, buttons: 1 }, anchorMode: 'snap' });
  if (begin.state.kind !== 'dragging') throw new Error(`按下未进入拖动：${begin.state.kind}`);
  const state: GestureState = { ...begin.state, candidate: ordinalAtClamped(view, dragX, calendar) };
  const outcome = resolveDragOutcome({ state, document, calendar });
  const patch = outcome === null ? null : outcome.patch;
  const preview = patch === null ? null : previewDocumentFor({ document, taskId, patch });
  const next = preview ?? document;
  const result = compute(next, calendar);
  if (!result.ok) throw new Error('预览文档不可排程');
  try {
    buildView({ document: next, schedule: result.schedule, calendar, viewport, zoom: 'day' });
    return { candidate: state.candidate, built: true, error: null };
  } catch (error) {
    return { candidate: state.candidate, built: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe('拖动期的反算夹取（人工报障 2026-10-05）', () => {
  it('`ordinalAtClamped`：项目起点左侧一律夹到 0，不退化成"地平线的另一端"', () => {
    const { calendar, view } = pipeline();
    const { xLeft } = grabXOf(view, 't1');
    // 条体左缘**左侧一点**——正是"不再位于 `x <= 0`"的那一段（旧实现把它判成向右越界）。
    expect(ordinalAtClamped(view, xLeft - 1, calendar)).toBe(0);
    expect(ordinalAtClamped(view, xLeft - view.pxPerDay, calendar)).toBe(0);
    expect(ordinalAtClamped(view, 0, calendar)).toBe(0);
    expect(ordinalAtClamped(view, -1000, calendar)).toBe(0);
    // 右侧越界仍夹到最后一个可表示的工作日（既定语义不变）。
    expect(ordinalAtClamped(view, view.contentWidth + 10_000, calendar)).toBe(calendar.workdayCount - 1);
    // 区间内逐值不回归：条体左缘仍映射到该行 `es`（§16.3 的既有判据口径）。
    const row = view.rows.find((item) => item.id === 't1');
    expect(ordinalAtClamped(view, xLeft, calendar)).toBe(row?.es);
  });

  it('向左拖（含远超条体的距离）：每一步都能建出视图，且候选不会跳到别处', () => {
    const { view, calendar } = pipeline();
    const { grabX, xLeft } = grabXOf(view, 't1');
    const row = view.rows.find((item) => item.id === 't1');
    const failures: string[] = [];
    for (const dragX of [xLeft - 1, xLeft - view.pxPerDay, grabX - 4 * view.pxPerDay, grabX - 40 * view.pxPerDay, -5000]) {
      const result = dragTo('t1', dragX);
      if (!result.built) failures.push(`dragX=${String(Math.round(dragX))}：建视图失败 —— ${String(result.error)}`);
      if (result.candidate !== 0) failures.push(`dragX=${String(Math.round(dragX))}：候选 = ${String(result.candidate)}（期望 0）`);
    }
    expect(failures).toStrictEqual([]);
    // 前提自证：`t1` 原本就在项目起点（因此"向左拖"必然触到左夹取这条路径）。
    expect(row?.es).toBe(0);
    expect(calendar.workdayCount).toBeGreaterThan(0);
  });

  /**
   * **同源但不同因的第二半 —— 登记为已知缺口（当前行为即缺陷，不是判据的期望）。**
   *
   * 左拖那半修好后，**向右**把 `t1` 拖远**仍能把页面弄白**：候选被夹到 `workdayCount − 1` 之内，
   * 但"起点 + 工期（+ 级联）"的**完成序号**可以越过同一个日历的可表示域，
   * 而渲染用的是**已提交文档**规划的那份日历（`SCHEDULE.md` §七："调用方自己的日历容量不足时
   * `isoOfOrdinal` 会抛错——用 `calendar.withHorizon(...)` 扩容后翻译"）。
   *
   * 修法要动**契约面**（`createScheduleCalendar` 的口径，或让 `ScheduleResult` 交出真正用到的日历），
   * 因此**不在本轮的缺陷修复里顺手改**。这条用例把"当前行为"钉住：
   * **它现在必须"抛错"才能通过**；一旦有人修好，这条会翻红，并迫使把断言改成"必须能建出视图"。
   */
  it('已知缺口（向右拖远仍溢出）：修好后本用例必须翻红并改写', () => {
    const { calendar, view } = pipeline();
    const { grabX } = grabXOf(view, 't1');
    const result = dragTo('t1', grabX + 90 * view.pxPerDay);
    expect(result.built).toBe(false);
    expect(result.error).toMatch(/工作日序号越界/);
    expect(result.candidate).toBeLessThanOrEqual(calendar.workdayCount - 1);
  });
});
