<script setup lang="ts">
/**
 * 工具栏：档位切换（日/周/月，**离散切换**，ADR 0007 §3）、xlsx 导入、重置演示数据，
 * 以及 G5 的**撤销/重做**、`snap`/`allow` 策略切换与诊断清单开关。
 *
 * ## 范围（ADR 0008 §4/§10 + ADR 0010）
 *
 * - **做**：撤销/重做按钮（与 `Ctrl+Z`/`Ctrl+Y` 等价）、`anchorMode` 切换、诊断清单开关、**导出**（G7）；
 * - **导出**：格式（SVG / PNG / PPTX 模板 A）+ PNG 倍率 + 「含图例与摘要」开关。
 *   该开关**只对 SVG/PNG 生效**——PPTX 模板 A 固定含图例与摘要（EX-06），因此对它置灰并说明，
 *   而不是悄悄忽略（用户会以为开关坏了）。
 */

import { ref } from 'vue';
import { ZOOM_LABEL, ZOOM_ORDER, type AnchorMode, type ZoomKey } from '@ganttpilot/render-core';

import { PNG_SCALES, type ExportFormat } from '../composables/useExport.js';

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
  readonly exportFormat: ExportFormat;
  readonly exportPngScale: number;
  readonly exportWithSidebar: boolean;
  readonly exporting: boolean;
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
  readonly setExportFormat: [format: ExportFormat];
  readonly setExportPngScale: [scale: number];
  readonly setExportWithSidebar: [value: boolean];
  readonly exportNow: [];
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
      data-reset
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

    <!-- 导出（G7，ADR 0010）：格式 + PNG 倍率 + 图例/摘要开关 -->
    <div
      class="export"
      data-export
      title="导出（ADR 0010）：几何与屏幕同源（非截屏）；PPTX 为原生形状，永不为位图"
    >
      <span class="export-label">导出</span>
      <select
        data-export-format
        :value="exportFormat"
        @change="emit('setExportFormat', ($event.target as HTMLSelectElement).value as ExportFormat)"
      >
        <option value="svg">
          SVG
        </option>
        <option value="png">
          PNG
        </option>
        <option value="pptx">
          PPTX（模板 A）
        </option>
      </select>
      <select
        v-if="exportFormat === 'png'"
        data-export-scale
        :value="String(exportPngScale)"
        title="PNG 倍率（EX-02）：像素上限 32 MP"
        @change="emit('setExportPngScale', Number(($event.target as HTMLSelectElement).value))"
      >
        <option
          v-for="scale in PNG_SCALES"
          :key="scale"
          :value="String(scale)"
        >
          {{ scale }}×
        </option>
      </select>
      <label
        class="export-check"
        :class="{ disabled: exportFormat === 'pptx' }"
        :title="
          exportFormat === 'pptx'
            ? 'PPTX 模板 A 固定含图例与自动摘要（EX-06），该开关只对 SVG/PNG 生效'
            : '导出物是否附「图例 + 自动摘要」侧栏'
        "
      >
        <input
          data-export-sidebar
          type="checkbox"
          :checked="exportWithSidebar"
          :disabled="exportFormat === 'pptx'"
          @change="emit('setExportWithSidebar', ($event.target as HTMLInputElement).checked)"
        >
        含图例与摘要
      </label>
      <button
        type="button"
        class="action"
        data-export-run
        :disabled="exporting"
        @click="emit('exportNow')"
      >
        {{ exporting ? '导出中…' : '导出' }}
      </button>
    </div>

    <span class="spacer" />

    <span
      class="stacks"
      :title="'会话修订号与撤销/重做栈状态（锚点不进撤销栈）'"
    >
      修订 {{ revision }} · 可撤销 {{ canUndo ? '有' : '无' }} · 可重做 {{ canRedo ? '有' : '无' }}
    </span>

    <span class="note">
      {{ dragActive ? '拖动中：下游实时跟随（Esc 取消）' : '拖动条体改开始/工期/整体移动；从条端外侧的连接点拖出建线；导出为 SVG / PNG / PPTX 模板 A' }}
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

.export {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.export-label {
  color: #667085;
  font-size: 12px;
}

.export select {
  padding: 0.15rem 0.3rem;
  border: 1px solid #d0d5dd;
  border-radius: 4px;
  background: #ffffff;
  font: inherit;
}

.export-check {
  display: inline-flex;
  gap: 0.25rem;
  align-items: center;
  color: #475467;
  font-size: 12px;
}

.export-check.disabled {
  opacity: 0.5;
}

.stacks,
.note {
  color: #667085;
  font-size: 12px;
}
</style>
