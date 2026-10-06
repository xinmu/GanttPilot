<script setup lang="ts">
/**
 * 左表（ADR 0007 §4/§8）。列集合**锚 G3 的 9 列契约**（`COLUMN_SPECS`，不新造第四套列语义）， * `wbs` 列显示派生值 `outlineNumber`（真相源是层级 + 文档序）。
 *
 * ## 行内编辑（G4 的出口条件之一）
 *
 * - 组件**不构造命令**：只把"用户输入的文本"发给父级（`cellEdit`），
 *   由 `edit.ts` 的纯函数 `editToCommand` 映射成 `task.update` —— 值到命令的映射只有一处；
 * - **不整表重建**：本组件只渲染"渲染窗口内的行"，`key` 用任务 id，
 *   编辑一个单元格不会重建整张表（折叠/展开才会改变可见行集合，那是必要的重算）；
 * - `wbs` / `predecessors` 只读（前者是派生值，后者改边归 G5 的建线）；
 * - **编辑态只在"该任务该列的原始值真的变了"时才结束**（P-21 批次 C 的 R5：判据 `isEditStale`
 *   在 `render-core`、进 `pnpm gate`）——别的任务、别的列变化不再关掉输入框（原先 `watch(revision)` 会）。
 *
 * ## 滚动模型与两栏对齐（ADR 0007 §4/§14）
 *
 * 与图表同一坐标系：内容高 = 可见行数 × 行高，行块用 `translateY(−scrollTop)` 钉在可视区。
 * `scrollTop` 由图表窗格驱动（唯一真相源），两栏因此天然同步。
 *
 * **两条硬约束**（P-23 的诊断实测各抓出过一条，都表现为"逐行漂移"）：
 * ① 表头与图表表头带**同高**（`HEADER_HEIGHT_PX`，`box-sizing: border-box` 使 28 px 是外高），
 *    表体高 = `columnHeight − HEADER_HEIGHT_PX`；
 * ② **行外高必须等于模型行高**（`box-sizing: border-box`）——`content-box` 下 24 + 1 px 边框 = 25 px，
 *    32 行就漂 32 px（R9）。
 * 判据：`node scripts/measure-render.mjs --align`（记录制）+ `render-core/align.spec.ts`（进 `pnpm gate`）。
 */

import { computed, ref, watch } from 'vue';
import {
  cellText,
  COLUMN_SPECS,
  HEADER_HEIGHT_PX,
  isEditStale,
  rawCellText,
  TABLE_COLUMNS,
  type ColumnKey,
  type ProjectDocument,
  type Schedule,
  type ViewModel,
} from '@ganttpilot/render-core';
import type { Calendar } from '@ganttpilot/engine';

const props = defineProps<{
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule | null;
  /** **与图表同一个日历**（`createScheduleCalendar(document)`）——左表日期与图表同源的唯一前提（P-19）。 */
  readonly calendar: Calendar;
  readonly scrollTop: number;
  /** **整列外高** = 表头带 + 表体（= 图表列的外高；由 `useChart.columnHeight` 给出）。 */
  readonly columnHeight: number;
  readonly contentHeight: number;
  /** 冲突行（`anchorConflict` 的任务 id；判据来自引擎，ADR 0008 §6）。 */
  readonly conflictTaskIds: readonly string[];
  /**
   * **指针当前所在的渲染行**（任务 id；与图表侧同一个事实，`GanttChart.hoverTaskId`）。
   *
   * 它让"悬停高亮"**跨两栏一致**（G8 人工复验第 ⑦ 条：在图表上悬停时，左表对应行也应当有同样的指示）——
   * 否则用户只能靠肉眼在两张表之间对齐行号，而"条体 ↔ 左表"的对齐正是这一层的用途。
   *
   * 它与 `.row:hover`（纯 CSS）**不是同一件事**：CSS 那半只在指针**物理落在左表上**时生效，
   * 而这一半跟着**图表**指针走。两者同色，因此视觉上是一条连续的指示。
   */
  readonly hoverTaskId?: string | null;
  readonly disabled: boolean;
}>();

const emit = defineEmits<{
  /** 用户提交了一个单元格的文本（由父级映射成命令；空串表示清空）。 */
  readonly cellEdit: [payload: { readonly taskId: string; readonly column: ColumnKey; readonly text: string }];
  /** 折叠开关（同样由父级映射成 `task.update`）。 */
  readonly toggleCollapse: [payload: { readonly taskId: string }];
  /** 编辑被拒绝时的提示（例如日期格式错）。 */
  readonly rejected: [message: string];
  /**
   * **指针进出某一行的渲染行**（`null` = 指针离开了表格）。
   *
   * 它是"悬停高亮**跨两栏一致**"的**反向那一半**（G8 第二次复验第 ② 条）：
   * 指针在**左表**上时，右图对应行也要有一条行带。左表自己没有"行带"这种图形
   * （它是纯 CSS 底色），所以"图上那一条"只能由父级按这个事件去设 `hoverTaskId`——
   * 于是 `GanttChart` 的 `hoverBand` 与左表的 `:hover` 同时亮，两栏看起来是一整条。
   *
   * 为什么用 `pointerenter`/`pointerleave` 而不是 `mousemove`：它们在**行的层面**
   * 天然成对（一次进出只发一次），不需要自己抖去重；`mousemove` 会在每一帧都发。
   */
  readonly hoverRow: [payload: { readonly taskId: string | null }];
}>();

/** 编辑态：同一时刻只编辑一个单元格。 */
const editing = ref<{ readonly taskId: string; readonly column: ColumnKey } | null>(null);
const draft = ref('');

const columns = TABLE_COLUMNS;

/**
 * **左表的列宽与网格模板（左表与表体的唯一真相源）**。
 *
 * ## 为什么不再手写 `grid-template-columns`
 *
 * 此前表头与表体各写了一遍 `28px 200px …`，而 `COLUMN_SPECS.width` 是**导出用的字符宽度**
 * （`wbs: 10`、`name: 32`）——两者语义不同，手写值一旦被抄错（或只改一处）就会让
 * **表头与表体的列宽不一致**。现在只有一处：`COLUMN_SPECS.width` 归一成像素 + 语义下限。
 *
 * ## 像素换算与下限
 *
 * `px = max(minPx, round(width × 6.5))`：6.5 px/字符 ≈ 12 px 系统的汉字宽（略宽于英文），
 * 下限保的是"这一列至少能放下它自己的表头与典型内容"：
 *
 * | 列 | 导出宽度 | 归一 | 下限的来历 |
 * |---|---|---|---|
 * | `WBS` | 10 | 65 | `1.2.3` + **折叠按钮 18 px** |
 * | `任务名称` | 32 | 208 | 名称 + 12 px/级的缩进 |
 * | `开始`/`完成` | 12 | 78 | 十字符日期 |
 * | `工期` | 8 | 56 | 三字符数字 + 右对齐内边距 |
 * | `前置任务` | 20 | 130 | `1.3FS` / `1.3SS-2` 可直接照抄 |
 * | `进度`/`里程碑` | 8 | 56 | 百分比 / 是·否 |
 * | `备注` | 28 | 182 | 略窄于名称列 |
 *
 * 合计 **992 px**（下限之和 906 px）；`.table-pane` 是 `flex: 0 0 auto`（不拉伸），
 * 剩余宽度全给图表——与既有布局口径一致。
 */
const COLUMN_MIN_PX: Readonly<Record<ColumnKey, number>> = {
  wbs: 65,
  name: 208,
  start: 78,
  end: 78,
  duration: 56,
  predecessors: 130,
  progress: 56,
  milestone: 56,
  notes: 182,
};

const columnWidths = computed<number[]>(() =>
  COLUMN_SPECS.map((spec) => Math.max(COLUMN_MIN_PX[spec.key], Math.round(spec.width * 6.5))),
);

/** 网格模板（表头与表体**共用**它——这是两栏内部对齐的前提）。 */
const columnTemplate = computed(() => columnWidths.value.map((width) => `${String(width)}px`).join(' '));

/** 任务 id → 文档序索引与层级深度（一次性构建，避免 O(n²) 查找）。 */
const taskMeta = computed(() => {
  const parentOf = new Map<string, string | null>();
  const indexOf = new Map<string, number>();
  props.document.tasks.forEach((task, index) => {
    parentOf.set(task.id, task.parentId);
    indexOf.set(task.id, index);
  });
  const meta = new Map<string, { readonly docIndex: number; readonly depth: number }>();
  for (const [id, docIndex] of indexOf) {
    let depth = 0;
    let current = parentOf.get(id) ?? null;
    while (current !== null && depth < 64) {
      depth += 1;
      current = parentOf.get(current) ?? null;
    }
    meta.set(id, { docIndex, depth });
  }
  return meta;
});

const rowBlockTop = computed(() => Math.max(0, props.view.renderFirst * props.view.rowHeight));

function displayOf(docIndex: number, column: ColumnKey): { text: string; derived: boolean } {
  const schedule = props.schedule;
  if (schedule === null) return { text: '', derived: false };
  return cellText({
    key: column,
    document: props.document,
    schedule,
    docIndex,
    calendar: props.calendar,
  });
}

function isEditing(taskId: string, column: ColumnKey): boolean {
  return editing.value !== null && editing.value.taskId === taskId && editing.value.column === column;
}

function beginEdit(docIndex: number, column: ColumnKey, editable: boolean): void {
  if (props.disabled || !editable) return;
  const task = props.document.tasks[docIndex];
  if (task === undefined) return;
  editing.value = { taskId: task.id, column };
  // 草稿种子 = 原始字段文本（`rawCellText`，与陈旧判据同源；显示值可能带 `≈`，不能当种子）。
  draft.value = rawCellText({ document: props.document, taskId: task.id, column }) ?? '';
}

function cancelEdit(): void {
  editing.value = null;
  draft.value = '';
}

function commitEdit(): void {
  const state = editing.value;
  if (state === null) return;
  const text = draft.value;
  cancelEdit();
  emit('cellEdit', { taskId: state.taskId, column: state.column, text });
}

/**
 * 文档变化后**按值**决定是否结束编辑态（P-21 批次 C 的 R5，取代原先"任何版本变化都取消"）。
 *
 * 判据在 `render-core`（`isEditStale`，进 `pnpm gate`）：只有"**该任务该列**的原始值真的变了"
 * （或任务消失）才关掉输入框——别的任务被拖动、别的列被改，草稿都留着
 * （ADR 0008 §10 的"编辑态优先"由此在事实上成立）。行被折叠隐藏或滚出渲染窗口**不算**变化。
 */
watch(
  () => props.document,
  (after, before) => {
    const state = editing.value;
    if (state === null) return;
    if (isEditStale({ before, after, taskId: state.taskId, column: state.column })) cancelEdit();
  },
);

function requestToggle(taskId: string): void {
  if (props.disabled) return;
  emit('toggleCollapse', { taskId });
}

function collapsedOf(docIndex: number): boolean {
  return props.document.tasks[docIndex]?.collapsed ?? false;
}

/** 该行是否处于 `anchorConflict`（拖动"允许"模式下的标红；判据来自 `compute`）。 */
function isConflicting(taskId: string): boolean {
  return props.conflictTaskIds.includes(taskId);
}

void emit;
</script>

<template>
  <div
    class="table-pane"
    :style="{ height: `${String(columnHeight)}px`, '--header-h': `${String(HEADER_HEIGHT_PX)}px` }"
  >
    <div class="table-header">
      <!--
        第一行：九列列名。**两行要显式成两层列表**（下面是第二行），而不是"18 个格子靠
        `grid-auto-flow` 自动折行"——`grid-auto-flow: column` 会把 9 列扩成 18 列、
        让表头与表体彻底错位（G8 复验当场抓到的一处回归）。
        **`gridTemplateColumns` 必须落在 `.header-row` 上**（不是外面的 `.table-header`）：
        真正的网格容器是这两行，写在父级上等于没写（列名会一格一行地竖排）。
      -->
      <div
        class="header-row"
        :style="{ gridTemplateColumns: columnTemplate }"
      >
        <div
          v-for="column in columns"
          :key="column.key"
          class="cell"
          :class="{ numeric: ['duration', 'progress', 'milestone'].includes(column.key) }"
          :title="column.header"
        >
          {{ column.header }}
        </div>
      </div>
      <!--
        **第二行：留白**（P-46 §3 的当场定值）。
        它只保高度与分隔线——**不放任何文字**：表头带的内容集合仍是"时间刻度"
        （[ADR 0007 附录 §2](../docs/02-adr/附录/0007-增补.md)），放"档位提示"一类文字须先改附录。
        高度由 `.header-row` 的 `flex: 1 1 0` 等分承担，因此两栏外高仍严格相等。
      -->
      <div
        class="header-row header-row-blank"
        :style="{ gridTemplateColumns: columnTemplate }"
        aria-hidden="true"
      >
        <div
          v-for="column in columns"
          :key="`blank-${column.key}`"
          class="cell cell-blank"
        />
      </div>
    </div>

    <div
      class="table-body"
      :style="{ height: `${String(Math.max(0, columnHeight - HEADER_HEIGHT_PX))}px` }"
    >
      <div
        class="spacer"
        :style="{ height: `${String(contentHeight)}px` }"
      />
      <div
        class="row-block"
        :style="{ transform: `translateY(${String(-scrollTop)}px)`, top: `${String(rowBlockTop)}px` }"
      >
        <div
          v-for="row in view.rows"
          :key="row.id"
          class="row"
          :data-task-id="row.id"
          :class="{ summary: row.kind === 'summary', conflict: isConflicting(row.id), hovered: props.hoverTaskId === row.id }"
          :style="{ height: `${String(view.rowHeight)}px`, gridTemplateColumns: columnTemplate }"
          @pointerenter="emit('hoverRow', { taskId: row.id })"
          @pointerleave="emit('hoverRow', { taskId: null })"
        >
          <template
            v-for="column in columns"
            :key="column.key"
          >
            <div
              class="cell"
              :class="{
                numeric: ['duration', 'progress', 'milestone'].includes(column.key),
                editable: column.editable && !disabled,
                derived: displayOf(row.docIndex, column.key).derived,
              }"
            >
              <button
                v-if="column.key === 'wbs'"
                class="toggle"
                type="button"
                :disabled="disabled || row.kind !== 'summary'"
                :title="row.kind === 'summary' ? '折叠/展开（经 task.update，因此可撤销）' : ''"
                @click="requestToggle(row.id)"
              >
                {{ row.kind === 'summary' ? (collapsedOf(row.docIndex) ? '▸' : '▾') : '' }}
              </button>

              <input
                v-if="isEditing(row.id, column.key)"
                v-model="draft"
                class="editor"
                autofocus
                @keydown.enter.prevent="commitEdit()"
                @keydown.esc.prevent="cancelEdit()"
                @blur="commitEdit()"
              >
              <span
                v-else
                :style="column.key === 'name' ? { paddingLeft: `${String((taskMeta.get(row.id)?.depth ?? 0) * 12)}px` } : undefined"
                @dblclick="beginEdit(row.docIndex, column.key, column.editable)"
              >
                {{ displayOf(row.docIndex, column.key).text }}
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-pane {
  display: flex;
  flex-direction: column;
  /* 左表宽度 = 列宽之和（`COLUMN_SPECS` 的 9 列），**不参与拉伸**；剩余宽度全给图表。 */
  flex: 0 0 auto;
  border-right: 1px solid #e4e7ec;
  background: #ffffff;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 12px;
}

.table-header {
  /**
   * **两行表头**（P-46 §3）：第一行九列列名、第二行**留白**（只保高度与分隔线）。
   *
   * 两行是**两个独立的网格行**（`.header-row`），每行各自 `display: grid` 并共用
   * `gridTemplateColumns`（由 `COLUMN_SPECS` 归一而来，**表头与表体同源**）。
   *
   * **为什么不用单个网格 + `grid-auto-flow`**：18 个格子靠自动流折行时，
   * `grid-auto-flow: column` 会把 9 列扩成 18 列（表头与表体彻底错位），
   * 而默认的 `row` 也只对"格子数 = 列数 × 行数"成立；显式两层更稳、也更能表达意图。
   *
   * 表头高由 `HEADER_HEIGHT_PX` 经 `--header-h` 喂进来（**两栏同源**，ADR 0007 §14）；
   * `border-box` 让"40 px"是**外高**（含 1 px 下边框），否则与表体高差 1 px。
   */
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: var(--header-h);
  background: #f9fafb;
  border-bottom: 1px solid #e4e7ec;
  font-weight: 600;
  color: #475467;
}

/* 两行等分表头带高（各 20 px）：列名在上、留白在下。 */
.header-row {
  display: grid;
  flex: 1 1 0;
  min-height: 0;
  align-items: center;
}

/* 第二行留白（P-46 §3）：只画一条行间分隔线，**不放任何文字**。 */
.header-row-blank {
  border-top: 1px solid #e4e7ec;
}

.cell-blank {
  min-height: 0;
}

.table-body {
  position: relative;
  overflow: hidden;
}

.spacer {
  width: 100%;
}

.row-block {
  position: absolute;
  left: 0;
  right: 0;
  will-change: transform;
}

.row {
  display: grid;
  /* 列宽**不在这里写死**：`.row` 与 `.header-row` 共用模板里内联喂进来的 `columnTemplate`
     （由 `COLUMN_SPECS` 归一而来）——两处各写一遍就是"表头与表体列宽不一致"的来源。 */
  align-items: center;
  /* **外高必须 = 模型行高**（ADR 0007 §4 的固定行高）：`content-box` 下 24 + 1 px 边框 = 25 px，
     每行多 1 px ⇒ 逐行累积漂移（P-23 诊断实测的 R9）。 */
  box-sizing: border-box;
  border-bottom: 1px solid #f2f4f7;
  white-space: nowrap;
}

.row.summary {
  font-weight: 600;
  background: #fbfcfd;
}

/**
 * **悬停行高亮（左表侧）**：两条来源、**同一个颜色**。
 *
 * | 来源 | 触发条件 | 机制 |
 * |---|---|---|
 * | `.row:hover` | 指针**物理落在左表**这一行上 | **纯 CSS**（P-46 §2.2 的口径——零 SVG 元素、零预算） |
 * | `.row.hovered` | **图表**的指针在这一行上（`GanttChart.hoverTaskId`） | 由父级传 `hoverTaskId` 派生 |
 *
 * 颜色与图表侧那 1 个 `hover-band` 覆盖层**同值**（`render-core` 的 `HOVER_ROW_FILL`），
 * 因此"条体 ↔ 左表"的对照成立（P-46 的复验反馈第 ⑥ 条：原来的 `#e8f1fb` 太浅、
 * 与周末灰度带 `#f4f6f8` 混在一起 ⇒ 加深到 `#cfe3fa`；第 ⑦ 条要求跨两栏一致）。
 *
 * 三条 CSS 规则的**优先级是刻意写清的**（都是单类 + 单伪类，同级）：
 * ① `.row.summary` 的底色比 `.row` 更具体 ⇒ 汇总行的悬停要**同等具体**才生效；
 * ② 冲突行压过悬停（"事实"不该被"临时视图状态"盖住）。
 */
.row:hover,
.row.hovered {
  background: #cfe3fa;
}

.row.summary:hover,
.row.summary.hovered {
  background: #cfe3fa;
}

.row.conflict:hover,
.row.conflict.hovered {
  background: #fde3e1;
}

/* 冲突行（`anchorConflict`）：与图表覆盖层的 `.conflict-outline` 同色，两处一眼对得上 */
.row.conflict {
  background: #fef3f2;
  box-shadow: inset 2px 0 0 #b42318;
}

.cell {
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell.numeric {
  text-align: right;
}

.cell.derived {
  color: #667085;
}

.cell.editable {
  cursor: text;
}

.cell.editable:hover {
  background: #f0f7ff;
}

.toggle {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #475467;
}

.toggle:disabled {
  cursor: default;
  opacity: 0.35;
}

.editor {
  width: 100%;
  border: 1px solid #3d7ea6;
  font: inherit;
  padding: 0 2px;
}
</style>
