/**
 * 入边约束与吸附：{@link entryConstraintFor}（与 `Schedule` 的边界方程同式）与
 * {@link snapCandidate}（`snap` 模式的 `[0, 入边约束]` 夹取），外加**按模式的候选夹取**
 * （`dragCandidate`，包内可见——调用方是状态机）。
 *
 * 分工必须写清，否则两处夹取会打架：`snap` 夹**开始**语义的候选、`resize-duration` **不夹**
 * （它的候选是"新完成序号"，夹取在 {@link resolveDragOutcome} 里按结果处理）。
 * 三条口径与两处落地期订正见 [`./index.ts`](./index.ts)。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';

import type { ViewModel } from '../viewModel.js';
import type { DragMode } from '../zones.js';
import { candidateOrdinalFor, deltaFor } from './pointer.js';
import type { AnchorMode } from './state.js';

/**
 * 调度语义下**允许的最小序号**（入边边界），`-Infinity` 表示无约束。
 *
 * 与 `Schedule` 的边界方程同式（[SCHEDULE.md](../../engine/SCHEDULE.md) §九 不变量 2）：
 * FS `es_pred + 工期_pred + lag`、SS `es_pred + lag`、FF `ef_pred + lag − 工期`、SF `es_pred + lag − 工期`。
 * 只考虑**有效入边**（排除端点含汇总任务的边，SCHEDULE.md §四.6）。
 * 汇总行与未知 id 一律返回 `-Infinity`（汇总不参与传播）。
 */
export function entryConstraintFor(args: {
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly taskId: string;
  readonly durationDays: number;
}): number {
  const { document, schedule, taskId } = args;
  const indexOfId = new Map<string, number>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined) indexOfId.set(task.id, index);
  }
  const selfIndex = indexOfId.get(taskId);
  if (selfIndex === undefined) return Number.NEGATIVE_INFINITY;
  if ((schedule.es[selfIndex] ?? -1) === -1) return Number.NEGATIVE_INFINITY; // 汇总不参与传播

  let constraint = Number.NEGATIVE_INFINITY;
  for (const link of document.links) {
    if (link.to !== taskId) continue;
    const fromIndex = indexOfId.get(link.from);
    if (fromIndex === undefined) continue;
    const fromEs = schedule.es[fromIndex] ?? -1;
    const fromEf = schedule.ef[fromIndex] ?? -1;
    if (fromEs < 0 || fromEf < 0) continue; // 汇总端点 ⇒ 有效图中不存在（§四.6）
    const lag = link.lagDays;
    const candidate =
      link.type === 'FS'
        ? fromEf + lag
        : link.type === 'SS'
          ? fromEs + lag
          : link.type === 'FF'
            ? fromEf + lag - args.durationDays
            : fromEs + lag - args.durationDays;
    if (candidate > constraint) constraint = candidate;
  }
  return constraint;
}

/**
 * `snap` 模式的候选：把候选**夹**到 `[0, 入边约束]`。
 *
 * ```
 * lower = max(minOrdinal, 0)                  // 0 = Calendar.baseDay 的序号，负序号无定义（G1.1 冻结）
 * upper = max(constraint, lower)              // 无约束 ⇒ +∞；约束早于项目起点时不制造空区间
 * return min(max(candidate, lower), upper)
 * ```
 *
 * **落地期实测订正（两处，同一行）**：初稿把约束同时当成了**下界**，于是
 * ① 返回的不是"夹"而是 `max(candidate, 约束)` —— 一个**早于**约束的候选会被**抬到约束之上**，
 * 恰好与要防的事情相反；② 而且这个方向**永远不会被"违反约束"的断言抓到**（它只会让锚点更晚），
 * 只有"约束之前的位置必须留在约束之前"这条**上界断言**能抓出来。
 * `gesture.spec.ts` 的 `snapCandidate({candidate: 约束−3, constraint})` 正是那条上界断言。
 */
export function snapCandidate(args: {
  readonly candidate: number;
  readonly constraint: number;
  readonly minOrdinal: number;
}): number {
  const lower = Math.max(args.minOrdinal, 0);
  const upper = Number.isFinite(args.constraint) ? Math.max(args.constraint, lower) : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(args.candidate, lower), upper);
}

/** 日历上最后一个可表示的**工作日**序号（上界一律夹回，与 `ordinalAtClamped` 同精神）。 */
function maxOrdinalOf(calendar: Calendar): number {
  return Math.max(0, calendar.workdayCount - 1);
}

/**
 * 候选序号（**含按模式的夹取**，ADR 0008 §13）。
 *
 * 分工必须写清，否则两处夹取会打架：
 * - `snap`：把**开始**语义的候选夹到 `[0, 入边约束]`（`snapCandidate`）。约束是"开始"的上界，
 *   而 `es ≥ 约束` 恒成立（`ES = max(约束, 锚点)`），因此**按下第一帧不会跳位**；
 * - `allow`：原样放行（早于约束时由 `compute` 报 `anchorConflict`，UI 标红）；
 * - `resize-duration`：**不夹取**——它的候选是"新完成序号"，约束与 0 下界都在
 *   {@link resolveDragOutcome} 里按结果处理（完成序号允许先落到低于开始的位置，再由最小工期兜住）。
 *
 * **入参一律来自"被拖的那个任务"**（`taskId` + `durationDays` + `originOrdinal`），
 * 不取"指针当前所在行"：跨行拖动时也不该换一个基准（v0.1 不支持改层级）。
 */
export function dragCandidate(args: {
  readonly mode: DragMode;
  readonly pointerX: number;
  /** 位移的**绝对基准** = 按下时该任务的开始序号。 */
  readonly originOrdinal: number;
  readonly durationDays: number;
  readonly taskId: string;
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
  readonly anchorMode: AnchorMode;
  readonly grabOrdinal: number;
  /** 可省略（省略时按指针重算）。 */
  readonly delta?: number;
}): number {
  const delta =
    args.delta ??
    deltaFor({
      view: args.view,
      calendar: args.calendar,
      pointerX: args.pointerX,
      grabOrdinal: args.grabOrdinal,
    });
  const raw = candidateOrdinalFor({
    mode: args.mode,
    originOrdinal: args.originOrdinal,
    durationDays: args.durationDays,
    delta,
  });
  // 上界夹回日历地平线（`isoOfOrdinal` 越界会抛错；下界交给各模式的结果解析，`allow` 刻意放行负数）。
  const bounded = Math.min(raw, maxOrdinalOf(args.calendar));
  if (args.mode === 'resize-duration' || args.anchorMode === 'allow') return bounded;
  const constraint = entryConstraintFor({
    document: args.document,
    schedule: args.schedule,
    taskId: args.taskId,
    durationDays: args.durationDays,
  });
  return snapCandidate({ candidate: bounded, constraint, minOrdinal: 0 });
}
