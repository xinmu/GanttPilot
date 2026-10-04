<script setup lang="ts">
/**
 * 工具栏：档位切换（日/周/月，**离散切换**，ADR 0007 §3）、xlsx 导入、重置演示数据，
 * 以及 G5 的**撤销/重做**、`snap`/`allow` 策略切换与诊断清单开关。
 *
 * ## 范围（ADR 0008 §4/§10）
 *
 * - **做**：撤销/重做按钮（与 `Ctrl+Z`/`Ctrl+Y` 等价）、`anchorMode` 切换、诊断清单开关；
 * - **不做**导出按钮（G7）。`allow` 模式那句提示必须留住：**"允许"的落点是会话锚点**，
 *   不写文档、不进撤销栈、重开后不保留（ADR 0004 §2）——不写清楚，用户会以为它改了文档。
 */

import { ref } from 'vue';
import { ZOOM_LABEL, ZOOM_ORDER, type AnchorMode, type ZoomKey } from '@ganttpilot/render-core';

const props = defineProps<{
  readonly zoom: ZoomKey;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly tableVisible: boolean;
  readonly anchorMode: AnchorMode;
  readonly diagnosticCount: number;
  readonly diagnosticsOpen: boolean;
  readonly dragActive: boolean;
}>();

const emit = defineEmits<{
  readonly zoom: [zoom: ZoomKey];
  readonly importFile: [file: File];
  readonly reset: [];
  readonly toggleTable: [];
  readonly undo: [];
  readonly redo: [];
  readonly setAnchorMode: [mode: AnchorMode];
  readonly toggleDiagnostics: [];
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

    <button
      type="button"
      class="action"
      :disabled="!canUndo"
      title="撤销（Ctrl+Z）：一次手势 = 一层撤销（IX-03）"
      @click="emit('undo')"
    >
      撤销
    </button>
    <button
      type="button"
      class="action"
      :disabled="!canRedo"
      title="重做（Ctrl+Y / Ctrl+Shift+Z）"
      @click="emit('redo')"
    >
      重做
    </button>

    <div
      class="mode"
      :title="
        anchorMode === 'snap'
          ? '拖拽策略：吸附（默认）——候选被夹到入边约束，拖动不会越过前置'
          : '拖拽策略：允许——候选原样送进 compute；早于入边约束时按 anchorConflict 标红（锚点不写文档、不进撤销栈）'
      "
    >
      <button
        type="button"
        :class="{ active: anchorMode === 'snap' }"
        @click="emit('setAnchorMode', 'snap')"
      >
        吸附
      </button>
      <button
        type="button"
        :class="{ active: anchorMode === 'allow' }"
        @click="emit('setAnchorMode', 'allow')"
      >
        允许（标红）
      </button>
    </div>

    <button
      type="button"
      class="action"
      :class="{ warn: diagnosticCount > 0 }"
      title="诊断清单：协议层 + 文档校验层 + 排程层三层拼接（ADR 0006 §7）"
      @click="emit('toggleDiagnostics')"
    >
      诊断 {{ diagnosticCount }}{{ diagnosticsOpen ? ' ▴' : ' ▾' }}
    </button>

    <span class="spacer" />

    <span
      class="stacks"
      :title="'会话修订号与撤销/重做栈状态（锚点不进撤销栈）'"
    >
      修订 {{ revision }} · 可撤销 {{ canUndo ? '有' : '无' }} · 可重做 {{ canRedo ? '有' : '无' }}
    </span>

    <span class="note">
      {{ dragActive ? '拖动中：下游实时跟随（Alt+拖动 = 建线；Esc 取消）' : '拖动条体改开始/工期/整体移动；Alt+拖动建线；导出（SVG/PNG/PPTX）归 G7' }}
    </span>
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

.mode {
  display: inline-flex;
  border: 1px solid #d0d5dd;
  border-radius: 4px;
  overflow: hidden;
}

.mode button {
  padding: 0.2rem 0.6rem;
  border: none;
  border-right: 1px solid #d0d5dd;
  background: #ffffff;
  cursor: pointer;
  font: inherit;
}

.mode button:last-child {
  border-right: none;
}

.mode button.active {
  background: #7a8699;
  color: #ffffff;
}

.action:disabled {
  cursor: default;
  opacity: 0.45;
}

.action.warn {
  color: #b54708;
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
