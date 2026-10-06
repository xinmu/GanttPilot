/**
 * **拖动不得把预览推出渲染地平线**（人工报障 2026-10-05 的回归判据）。
 *
 * ## 报障与根因（两半，现已**两半都收口**）
 *
 * 维护者在**打包产物**上把演示计划的任务 1.1（`t1`：链路起点、显式锚定项目开始日）向左拖，
 * **整页变白**、刷新可恢复。浏览器里抓到的渲染期异常：
 *
 * ```
 * [组件] App / RangeError: 工作日序号越界：102（合法范围 0..95；…）
 *     at Calendar.dayOfOrdinal → buildView → contentWidthFor
 * ```
 *
 * **(a) 可判定的一半**（[P-47](../../docs/00-baseline/裁决R46.md)，已修）：夹取方向猜错——
 * `gesture.ts` 的 `ordinalAtClamped` 旧实现在 `day < baseDay` 抛错后按 `x <= 0` 猜方向，
 * 而 `baseDay` 左侧在屏幕上**不是 `x <= 0`**（轴线起点 = `dayOfOrdinal(projectStart) − AXIS_LEFT_GUTTER_DAYS`），
 * 于是"向左拖一点点"被判成"向右越界"，候选被甩到**最右序号**（4 → 94）。
 *
 * **(b) 契约的一半**（[P-48](../../docs/00-baseline/裁决R47.md)，本轮的修复）：即便候选被正确夹住，
 * **向右**拖远时"起点 + 工期 + 级联"的**完成序号**仍会越过**调用方日历**的可表示域。
 * `SCHEDULE.md` §七 当时把容量写成**调用方义务**，实践证伪了这条。
 * 裁定（**采"交出日历"这一路**，而不是"给规划加一个猜的余量"）：`compute` 把**它真正用到**
 * 的那份日历作为 `ScheduleResult.renderCalendar` 交出，渲染层改用它——于是
 * "序号是否可翻译"从调用方义务变成**结构性事实**，与链长、拖动幅度都无关。
 *
 * ## 本文件的判据（**本文件的管线 = 产品管线的字面形式**）
 *
 * `dragTo()` 的每一帧都重走"真实手势 → 补丁 → 预览文档 → `compute` → **用 `compute` 交出的日历**
 * → `buildView`"。因此这里的绿就是"打包产物上拖不白屏"的 Node 侧对应物。
 */

import { describe, expect, it } from 'vitest';

import { compute, createScheduleCalendar, type Calendar, type ProjectDocument, type Schedule } from '@ganttpilot/engine';

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

/**
 * 把日历包一层：**凡在入参日历上翻译"越出它容量"的序号，当场现形**。
 *
 * ## 为什么不是"一律禁止"
 *
 * 拖动的正确性确实要求**渲染路径调用的每一条反算**都落在 `renderCalendar` 上，但产品里
 * 仍有一些**语义上合法**的入参日历用法（例如 `linkEntryFor`/`cursorForPointer` 用它反算
 * 抓取点所在的序号——那是"指针落在哪一天"，与渲染容量无关）。一律禁止会把它们一起判死，
 * 于是判据变成"实现必须长成我想象的样子"，而不是"缺陷不得复发"。
 *
 * 因此本包装器判的是**缺陷本身**：入参日历收到一个**超出它自身可表示域**的序号。
 * 那正是报障当天的形态（`projectFinish − 1 = 129 > 95`）——一个漏改的消费点会在这里抛，
 * 并在消息里点名是哪个方法、收到了多大的序号。
 */
function guardAgainstOverflow(calendar: Calendar): Calendar {
  const probes = ['isoOfOrdinal', 'dayOfOrdinal'] as const;
  return new Proxy(calendar, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || !(probes as readonly string[]).includes(property)) {
        return value;
      }
      return (...callArgs: unknown[]): unknown => {
        const ordinal = callArgs[0];
        if (typeof ordinal === 'number' && ordinal > target.workdayCount) {
          throw new Error(
            `渲染层把序号 ${String(ordinal)} 交给了**入参日历**（容量仅 ${String(target.workdayCount)}）` +
              '去翻译 —— 必须改用 compute 交出的那份（P-48）',
          );
        }
        return (value as (...rest: unknown[]) => unknown).apply(target, callArgs);
      };
    },
  });
}

/** 把条体拖到 `dragX`，返回"松手前预览"能否建出视图（**渲染用 `renderCalendar`**）。 */
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
    // **产品管线的字面形式**：日历用 `compute` 交出的那一份，而入参日历被包上"越界即现形"的守卫
    // （于是"渲染层还在用入参日历翻译远期序号"这个漏改会立刻红，而不是靠"恰好没越界"逃过）。
    buildView({
      document: next,
      schedule: result.schedule,
      calendar: guardAgainstOverflow(result.renderCalendar),
      viewport,
      zoom: 'day',
    });
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
   * **另一半（P-48）的看门人 —— 本用例由"必须抛错"改写为"必须能建出视图"。**
   *
   * 改写前的形态（保留记录，见 [裁决 R46 §4](../../docs/00-baseline/裁决R46.md)）：断言
   * `result.built === false` 且 `error` 匹配 `/工作日序号越界/`——那是把"当前行为即缺陷"钉住，
   * 好让修好之后它翻红。本轮修好（渲染层改用 `compute` 交出的 `renderCalendar`）⇒ 断言按原计划改写。
   *
   * 向右拖 90 个工作日会把 `projectFinish` 推到**入参日历容量之外**（那正是当年白屏的形态），
   * 因此这条用例同时是"结构性而非余量"的证据：无论拖多远，交出的日历都覆盖得住。
   */
  it('向右拖远（越过入参日历容量）：必须能建出视图，且候选仍被夹在容量内', () => {
    const { calendar, view } = pipeline();
    const { grabX } = grabXOf(view, 't1');
    const result = dragTo('t1', grabX + 90 * view.pxPerDay);
    expect(result.built).toBe(true);
    expect(result.error).toBeNull();
    expect(result.candidate).toBeLessThanOrEqual(calendar.workdayCount - 1);
  });

  it('`renderCalendar` 覆盖完成序号（**入参日历明显偏小**也成立）——白屏的根因判据', () => {
    const { document, calendar } = pipeline();
    // 把入参日历缩到 30 个自然日：它按 ADR 0005 §7 不影响任何序号，只是无法翻译 —— 正是报障当时的形态。
    const tiny = calendar.withHorizon(30);
    const result = compute(document, tiny);
    if (!result.ok) throw new Error('演示计划不可排程');
    const finishOrdinal = result.schedule.projectFinish - 1;
    // 前提自证：入参日历**真的不够用**（否则这条判据没有判别力）。
    expect(() => tiny.dayOfOrdinal(finishOrdinal)).toThrow(/越界/);
    // 交出的那份能翻译它，且严格更大。
    expect(() => result.renderCalendar.dayOfOrdinal(finishOrdinal)).not.toThrow();
    expect(result.renderCalendar.workdayCount).toBeGreaterThan(tiny.workdayCount);
    // 且用它建的视图是完整的（这就是"向右拖远不再白屏"）。
    expect(() =>
      buildView({
        document,
        schedule: result.schedule,
        calendar: result.renderCalendar,
        viewport,
        zoom: 'day',
      }),
    ).not.toThrow();
  });
});
