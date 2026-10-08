/**
 * **悬停三态**（P3/C6-f 从 `App.vue` 迁出）：指针在哪一行、x 是多少、哪一行要带行带。
 *
 * 它是应用层唯一持有"指针位置"的地方，三个消费者各不相同：
 * - `hoverTaskId` / `hoverX` → `GanttChart` 的**连接点显形**（只驱动可见性，不参与命中判定）；
 * - `hoverTaskId` → `TaskTable` 的 `.hovered`（跨两栏一致的悬停指示）；
 * - `hoverRow`（住在 `useChart`）→ **悬停行带**（`ViewModel.axis` 的 `hover-band`，P-46 §2.2）。
 *
 * ## 为什么是三个独立的 ref、而不是一个对象
 *
 * 赋值时可以做**相等短路**（同一行 + 同一个 x 就不触发更新），否则每次 `mousemove` 都会让
 * `GanttChart` 的那一行重算，拖拽帧预算要为"没变化"付费（ADR 0008 §11 的判据）。
 *
 * ## 两条"行集合"口径必须一致
 *
 * 行号一律走 `resolvePointerTarget`（渲染窗口内的可见行；缓冲行与折叠行不可交互），
 * 因此"连接点显形 / 行带高亮"与"能不能点中"用的是**同一个行集合**——
 * 左表那一半（`setHoverFromTable`）虽然是另一条判据来源，但同样按 `rows` 收口。
 */

import { ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  resolvePointerTarget,
  type PointerInput,
  type ProjectDocument,
  type Schedule,
  type ViewModel,
} from '@ganttpilot/render-core';
import type { Calendar } from '@ganttpilot/engine';

/** `useHover` 的入参（四个几何输入 + 悬停行带那个 ref）。 */
export interface UseHoverArgs {
  readonly view: ComputedRef<ViewModel | null>;
  readonly document: Ref<ProjectDocument>;
  readonly schedule: ComputedRef<Schedule | null>;
  /** `compute` **交出的**日历（几何一律用它，见 `useChart` 的同名说明）。 */
  readonly renderCalendar: ComputedRef<Calendar>;
  /** 悬停行带（`useChart` 的 `hoverRow`）：`null` = 不高亮。 */
  readonly hoverRow: Ref<number | null>;
}

/** 悬停状态与两条推进路径。 */
export interface UseHover {
  readonly hoverTaskId: Ref<string | null>;
  readonly hoverX: Ref<number | null>;
  /** 由**坐标**推进（窗格上的指针事件走它）。 */
  updateHover: (pointer: PointerInput) => void;
  /** 指针离开窗格：连接点立刻消失（不留"悬空的方块"），悬停行带一并清掉（P-46）。 */
  clearHover: () => void;
  /** 由**左表**推进（G8 第二次复验第 ② 条：反向联动）。 */
  setHoverFromTable: (taskId: string | null) => void;
}

export function useHover(args: UseHoverArgs): UseHover {
  const hoverTaskId = ref<string | null>(null);
  const hoverX = ref<number | null>(null);

  /** 记录"指针在哪一行、x 是多少"（**只驱动连接点的显形**）。 */
  function updateHover(pointer: PointerInput): void {
    const current = args.view.value;
    const currentSchedule = args.schedule.value;
    if (current === null || currentSchedule === null) {
      // 没有视图（不可排程）时把悬停行带一并清掉，免得它挂在上一帧的行号上。
      if (args.hoverRow.value !== null) args.hoverRow.value = null;
      return;
    }
    const target = resolvePointerTarget({
      view: current,
      document: args.document.value,
      schedule: currentSchedule,
      calendar: args.renderCalendar.value,
      x: pointer.x,
      y: pointer.y,
    });
    const nextId = target === null ? null : target.taskId;
    const nextX = target === null ? null : Math.round(pointer.x);
    if (hoverTaskId.value !== nextId) hoverTaskId.value = nextId;
    if (hoverX.value !== nextX) hoverX.value = nextX;
    /**
     * **悬停行带**（P-46 §2.2）：只认"`rows` 里真的有一行"的情况（`row` 是**可见行序号**，
     * `ViewModel.hoverBand` 与 `view.axis` 的 `hover-band` 都以它为准）。
     * 缓冲行/折叠行的 `taskId` 不在 `rows` 里 ⇒ 自然不高亮（高亮与"能否交互"同一个行集合）。
     */
    const nextRow = nextId === null ? null : (current.rows.find((row) => row.id === nextId)?.row ?? null);
    if (args.hoverRow.value !== nextRow) args.hoverRow.value = nextRow;
  }

  function clearHover(): void {
    hoverTaskId.value = null;
    hoverX.value = null;
    args.hoverRow.value = null;
  }

  /**
   * **指针落在左表某一行**时的悬停推进（G8 第二次复验第 ② 条：反向联动）。
   *
   * 它做的事与 `updateHover` 的"命中某一行"分支**完全一样**（设 `hoverTaskId` + `hoverRow`），
   * 但**判据来源完全不同**：`updateHover` 从坐标反解（`resolvePointerTarget`），
   * 这里直接用左表告诉我们的行 id。**不合并成一条路**的理由是硬的：
   * 左表行在**图表坐标系之外**（它在另一栏），拿它的屏幕坐标去 `resolvePointerTarget`
   * 只会得到 `null`（或误命中相邻行）——那是把"两栏对齐"这件事重新算一遍，而不是复用既有事实。
   *
   * `hoverX` 明确置 `null`：连接点（`connectVisible`）要求"指针靠近该行的**条端**"，
   * 而指针根本不在图上 ⇒ 不显示才是对的（否则左表悬停会在图上凭空冒出白框）。
   */
  function setHoverFromTable(taskId: string | null): void {
    const nextRow =
      taskId === null ? null : (args.view.value?.rows.find((row) => row.id === taskId)?.row ?? null);
    /**
     * 缓冲行/折叠行的 id 不在 `rows` 里 ⇒ `nextRow === null` ⇒ **整条不清**：
     * 这与 `updateHover` 的口径一致（"高亮与能否交互同一个行集合"），也避免"图上有带、左表没有行"
     * 这种半亮状态。注意此时 `hoverTaskId` 也一并清掉，否则左表会留一条 `.hovered` 底色。
     */
    hoverTaskId.value = nextRow === null ? null : taskId;
    args.hoverRow.value = nextRow;
    hoverX.value = null;
  }

  /**
   * **悬停行号必须与当前视图一致**（P-46 §2.2 的收尾条件）。
   *
   * `hoverRow` 是"指针在哪一行"的**上一帧**读数，而 `view` 会因为滚动/折叠/编辑瞬时重建：
   * 旧行号可能指到别的任务上（或指到渲染窗口之外）。`ViewModel` 侧已经夹了一道
   * （`visibleHoverRow` 只认渲染窗口），这里再按"该行号上的行是否还在 `rows` 里"收一次口——
   * 否则会留下一条**高亮错任务**的行带（比"没有高亮"更坏：它看起来像选中）。
   *
   * **`flush: 'post'` 是必需的**：默认的 `pre` flush 会让本回调在"指针读数已更新、
   * 而视图尚未重建"的中间态上跑，于是它会把一次**刚发生的**悬停当成过期读数清掉
   * （实测：`updateHover` 刚设好 `hoverRow`，本回调立刻把它置回 `null` ⇒
   * 图表侧与左表侧的高亮都不出现）。`post` 表示"等 DOM 更新之后再判"，那时视图与指针同源。
   */
  watch(
    () => args.view.value,
    (current) => {
      const row = args.hoverRow.value;
      if (row === null) return;
      if (current === null || !current.rows.some((item) => item.row === row)) args.hoverRow.value = null;
    },
    { flush: 'post' },
  );

  return { hoverTaskId, hoverX, updateHover, clearHover, setHoverFromTable };
}
