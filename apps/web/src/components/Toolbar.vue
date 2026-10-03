<script setup lang="ts">
/**
 * 工具栏：档位切换（日/周/月，**离散切换**，ADR 0007 §3）、xlsx 导入入口、重置演示数据。
 *
 * ## 范围（ADR 0007 §1/§10）
 *
 * - **不做**导出按钮（G7）、**不做**撤销/重做按钮（G5）；
 * - 撤销/重做栈的状态只作为**只读指示**显示——G4 的编辑直接提交到会话，
 *   但"撤销 UI"归 G5；
 * - 导入入口是**用户动作**：文件读出后交给 `App.vue`，`exceljs` 在那里才被动态 `import()`。
 */

import { ref } from 'vue';
import { ZOOM_LABEL, ZOOM_ORDER, type ZoomKey } from '@ganttpilot/render-core';

const props = defineProps<{
  readonly zoom: ZoomKey;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly tableVisible: boolean;
}>();

const emit = defineEmits<{
  readonly zoom: [zoom: ZoomKey];
  readonly importFile: [file: File];
  readonly reset: [];
  readonly toggleTable: [];
}>();

const fileInput = ref<HTMLInputElement | null>(null);

const zoomOrder = ZOOM_ORDER;
const zoomLabel = ZOOM_LABEL;

function pickFile(): void {
  fileInput.value?.click();
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  emit('importFile', file);
  // 允许重复选择同一个文件（否则第二次选它不会触发 change）。
  input.value = '';
}

void props;
</script>

<template>
  <header class="toolbar">
    <strong class="brand">GanttPilot</strong>

    <div class="zoom">
      <button
        v-for="key in zoomOrder"
        :key="key"
        type="button"
        :class="{ active: key === zoom }"
        :title="`刻度档位：${zoomLabel[key]}（离散切换，不改变序号 ↔ 日期的对应）`"
        @click="emit('zoom', key)"
      >
        {{ zoomLabel[key] }}
      </button>
    </div>

    <button
      type="button"
      class="action"
      @click="pickFile"
    >
      导入 xlsx
    </button>
    <input
      ref="fileInput"
      class="hidden-input"
      type="file"
      accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
      @change="onFileChange"
    >

    <button
      type="button"
      class="action"
      @click="emit('reset')"
    >
      重置演示数据
    </button>

    <button
      type="button"
      class="action"
      :title="'切换左表（全宽图表时 `c₃` 才与 ADR 0007 §11 的图表宽度口径可比）'"
      @click="emit('toggleTable')"
    >
      {{ tableVisible ? '隐藏左表' : '显示左表' }}
    </button>

    <span class="spacer" />

    <span
      class="stacks"
      :title="'撤销/重做栈状态（撤销 UI 归 G5）'"
    >
      修订 {{ revision }} · 可撤销 {{ canUndo ? '有' : '无' }} · 可重做 {{ canRedo ? '有' : '无' }}
    </span>

    <span class="note">导出（SVG/PNG/PPTX）归 G7；拖拽三语义与撤销 UI 归 G5</span>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: #ffffff;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 13px;
  color: #1f2933;
}

.brand {
  font-size: 15px;
}

.zoom {
  display: inline-flex;
  border: 1px solid #d0d5dd;
  border-radius: 4px;
  overflow: hidden;
}

.zoom button {
  padding: 0.2rem 0.6rem;
  border: none;
  border-right: 1px solid #d0d5dd;
  background: #ffffff;
  cursor: pointer;
  font: inherit;
}

.zoom button:last-child {
  border-right: none;
}

.zoom button.active {
  background: #2e75b6;
  color: #ffffff;
}

.action {
  padding: 0.2rem 0.6rem;
  border: 1px solid #d0d5dd;
  border-radius: 4px;
  background: #ffffff;
  cursor: pointer;
  font: inherit;
}

.hidden-input {
  display: none;
}

.spacer {
  flex: 1;
}

.stacks,
.note {
  color: #667085;
  font-size: 12px;
}
</style>
