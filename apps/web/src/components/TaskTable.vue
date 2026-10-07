<script setup lang="ts">
/**
 * 左表（ADR 0007 §4/§8）。列集合**锚 G3 的 9 列契约**（`COLUMN_SPECS`，不新造第四套列语义）；
 * `wbs` 列显示派生值 `outlineNumber`（真相源是层级 + 文档序）。
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
 * ① 表头与图表表头带**同高**（`HEADER_HEIGHT_PX`；`box-sizing: border-box` 使这个值就是**外高**。
 *    该常量在刻度改为两级时上调过，取值与来历见 `manifest.ts` 的声明处），
 *    表体高 = `columnHeight − HEADER_HEIGHT_PX`；
 * ② **行外高必须等于模型行高**（`box-sizing: border-box`）——`content-box` 下 24 + 1 px 边框 = 25 px，
 *    32 行就漂 32 px（R9）。
 * 判据：`node scripts/measure-render.mjs --align`（记录制）+ `render-core/align.spec.ts`（进 `pnpm gate`）。
 */

import { computed, ref, watch } from 'vue';
import {
  AXIS_GRIDLINE_STROKE,
  cellText,
  HEADER_HEIGHT_PX,
  HOVER_ROW_FILL,
  INDENT_PX_PER_LEVEL,
  isEditStale,
  rawCellText,
  TABLE_COLUMNS,
  tableColumnTemplate,
  type ColumnKey,
  type ProjectDocument,
  type Schedule,
  type ViewModel,
} from '@ganttpilot/render-core';
import { computeDepths, type Calendar } from '@ganttpilot/engine';

/**
 * 与图表**同值**的两枚样式令牌（P3/C5）：值只在 `render-core` 的 `manifest.ts` 声明，
 * 这里只把它注入成 CSS 变量——左表是 CSS 渲染的，没法直接引用 TS 常量，
 * 而"值的第二份"正是常量检查（`constantCheck` 的 `axis-colors`）要挡的东西。
 */
const styleTokens = {
  '--axis-gridline-stroke': AXIS_GRIDLINE_STROKE,
  '--hover-row-fill': HOVER_ROW_FILL,
} as const;

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
 * **网格模板：左表列宽的唯一真相源（现在在 `render-core`）**。
 *
 * P3/C6-e 把这张表的**换算规则与语义下限整段收回了 `render-core/src/columns.ts`**
 * （`tableColumnTemplate()`）：`COLUMN_SPECS.width` 是**导出用的字符宽度**（`wbs: 10`、
 * `name: 32`），不是像素；它归一成像素的规则与"每列至少多宽"的下限表，和**列身份**是
 * 同一件事的两面——分居两处就一定会漂（P-48 的 ①②：表头排成两行、`WBS` 被省略号吃掉，
 * 两次都是"手写的 `grid-template-columns` 与 `COLUMN_SPECS` 已经不一致"）。
 *
 * 本组件的职责就此只剩**注入**：把同一串喂给两行表头与表体（表头与表体同源是两栏内部对齐的前提）。
 */
const columnTemplate = computed(() => tableColumnTemplate());

/**
 * 任务 id → **层级深度**（缩进用；口径来自引擎，P3/C6-e）。
 *
 * `engine.computeDepths` 与 `buildTaskTree` 是**同一个根判定**（`parentId` 为空 / 悬空 / 自指
 * ⇒ 根），因此"左表缩进"与"WBS 编号 / 行序"永远同源。此前这里自己数 `parentId` 跳数并用
 * `depth < 64` 截断防环，于是：**成环的文档整列缩进 768 px**、**悬空 `parentId` 的任务缩进
 * 12 px**（而它的 WBS 编号显示为根）——两处口径不一致，且深链在第 64 级被静默压平。
 * 判据：`packages/engine/src/wbs.spec.ts` 的「`computeDepths` 与 `buildTaskTree` 的 depth
 * 逐节点一致」（含悬空 / 自环 / 成环 / 100 级深链四类脏数据）。
 *
 * 这里也顺手删掉了原先那个 `docIndex` 字段：它建了却没人读（消费者一律用
 * `row.docIndex`——那是 `ViewModel` 给的渲染行口径）。
 */
const taskDepths = computed(() => computeDepths(props.document.tasks));

/** 名称列的缩进（CSS 长度）：层级深度 × 每级缩进。 */
function rowIndentPx(taskId: string): string {
  return `${String((taskDepths.value.get(taskId) ?? 0) * INDENT_PX_PER_LEVEL)}px`;
}

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
    :style="{ height: `${String(columnHeight)}px`, '--header-h': `${String(HEADER_HEIGHT_PX)}px`, ...styleTokens }"
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
                :style="column.key === 'name' ? { paddingLeft: rowIndentPx(row.id) } : undefined"
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
  border-right: 1px solid var(--axis-gridline-stroke);
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
  border-bottom: 1px solid var(--axis-gridline-stroke);
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
  border-top: 1px solid var(--axis-gridline-stroke);
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
 * 因此"条体 ↔ 左表"的对照成立（P-46 的复验反馈第 ⑥ 条：原来的浅蓝太接近周末灰度带的
 * `AXIS_BAND_FILL` ⇒ 加深到 `HOVER_ROW_FILL`；第 ⑦ 条要求跨两栏一致）。**色值不在本文件复述**——
 * 上面两枚 CSS 变量就是它的注入通道。
 *
 * 三条 CSS 规则的**优先级是刻意写清的**（都是单类 + 单伪类，同级）：
 * ① `.row.summary` 的底色比 `.row` 更具体 ⇒ 汇总行的悬停要**同等具体**才生效；
 * ② 冲突行压过悬停（"事实"不该被"临时视图状态"盖住）。
 */
.row:hover,
.row.hovered {
  background: var(--hover-row-fill);
}

.row.summary:hover,
.row.summary.hovered {
  background: var(--hover-row-fill);
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
