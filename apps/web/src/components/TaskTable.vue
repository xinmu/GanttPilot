<script setup lang="ts">
/**
 * 左表（ADR 0007 §4/§8）。列集合**锚 G3 的 9 列契约**（`COLUMN_SPECS`，不新造第四套列语义），
 * `wbs` 列显示派生值 `outlineNumber`（真相源是层级 + 文档序）。
 *
 * ## 行内编辑（G4 的出口条件之一）
 *
 * - 组件**不构造命令**：只把"用户输入的文本"发给父级（`cellEdit`），
 *   由 `edit.ts` 的纯函数 `editToCommand` 映射成 `task.update` —— 值到命令的映射只有一处；
 * - **不整表重建**：本组件只渲染"渲染窗口内的行"，`key` 用任务 id，
 *   编辑一个单元格不会重建整张表（折叠/展开才会改变可见行集合，那是必要的重算）；
 * - `wbs` / `predecessors` 只读（前者是派生值，后者改边归 G5 的建线）。
 *
 * ## 滚动模型
 *
 * 与图表同一坐标系：内容高 = 可见行数 × 行高，行块用 `translateY(−scrollTop)` 钉在可视区。
 * `scrollTop` 由图表窗格驱动（唯一真相源），两栏因此天然同步。
 */

import { computed, ref, watch } from 'vue';
import type { ProjectDocument, Schedule, ViewModel } from '@ganttpilot/render-core';
import type { ColumnKey } from '@ganttpilot/xlsx-protocol';

import { TABLE_COLUMNS, cellText } from '../shared.js';

const props = defineProps<{
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule | null;
  readonly revision: number;
  readonly scrollTop: number;
  readonly paneHeight: number;
  readonly contentHeight: number;
  readonly disabled: boolean;
}>();

const emit = defineEmits<{
  /** 用户提交了一个单元格的文本（由父级映射成命令；空串表示清空）。 */
  readonly cellEdit: [payload: { readonly taskId: string; readonly column: ColumnKey; readonly text: string }];
  /** 折叠开关（同样由父级映射成 `task.update`）。 */
  readonly toggleCollapse: [payload: { readonly taskId: string }];
  /** 编辑被拒绝时的提示（例如日期格式错）。 */
  readonly rejected: [message: string];
}>();

/** 编辑态：同一时刻只编辑一个单元格。 */
const editing = ref<{ readonly taskId: string; readonly column: ColumnKey } | null>(null);
const draft = ref('');

const columns = TABLE_COLUMNS;

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
  return cellText({ key: column, document: props.document, schedule, docIndex });
}

function rawOf(docIndex: number, column: ColumnKey): string {
  const task = props.document.tasks[docIndex];
  if (task === undefined) return '';
  switch (column) {
    case 'name':
      return task.name;
    case 'start':
      return task.startDate ?? '';
    case 'end':
      return task.endDate ?? '';
    case 'duration':
      return task.durationDays === null ? '' : String(task.durationDays);
    case 'progress':
      return task.progress === null ? '' : String(task.progress);
    case 'milestone':
      return task.milestone ? '是' : '否';
    case 'notes':
      return task.notes ?? '';
    default:
      return '';
  }
}

function isEditing(taskId: string, column: ColumnKey): boolean {
  return editing.value !== null && editing.value.taskId === taskId && editing.value.column === column;
}

function beginEdit(docIndex: number, column: ColumnKey, editable: boolean): void {
  if (props.disabled || !editable) return;
  const task = props.document.tasks[docIndex];
  if (task === undefined) return;
  editing.value = { taskId: task.id, column };
  draft.value = rawOf(docIndex, column);
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

/** 文档变化（编辑成功/撤销）后结束编辑态，避免对着旧文本继续编辑。 */
watch(
  () => props.revision,
  () => cancelEdit(),
);

function requestToggle(taskId: string): void {
  if (props.disabled) return;
  emit('toggleCollapse', { taskId });
}

function collapsedOf(docIndex: number): boolean {
  return props.document.tasks[docIndex]?.collapsed ?? false;
}

void emit;
</script>

<template>
  <div
    class="table-pane"
    :style="{ height: `${String(paneHeight)}px` }"
  >
    <div class="table-header">
      <div
        v-for="column in columns"
        :key="column.key"
        class="cell"
        :class="{ numeric: ['duration', 'progress', 'milestone'].includes(column.key) }"
      >
        {{ column.header }}
      </div>
    </div>

    <div
      class="table-body"
      :style="{ height: `${String(Math.max(0, paneHeight - 28))}px` }"
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
          :class="{ summary: row.kind === 'summary' }"
          :style="{ height: `${String(view.rowHeight)}px` }"
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
  display: grid;
  grid-template-columns: 28px 200px 92px 92px 56px 150px 56px 56px 160px;
  height: 28px;
  line-height: 28px;
  background: #f9fafb;
  border-bottom: 1px solid #e4e7ec;
  font-weight: 600;
  color: #475467;
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
  grid-template-columns: 28px 200px 92px 92px 56px 150px 56px 56px 160px;
  align-items: center;
  border-bottom: 1px solid #f2f4f7;
  white-space: nowrap;
}

.row.summary {
  font-weight: 600;
  background: #fbfcfd;
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
