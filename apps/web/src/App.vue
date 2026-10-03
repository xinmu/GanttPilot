<script setup lang="ts">
/**
 * 应用外壳（G4）：左表右图分屏 + 滚动同步 + 档位切换 + 折叠 + 行内编辑 + xlsx 导入。
 *
 * ## 范围（ADR 0007 §1/§10）
 *
 * **不做**：拖拽三语义、拖拽建线、撤销/重做 UI、冲突标记、诊断清单 UI、导出（G5/G6/G7）。
 * 诊断只被**计数**（"G4 不呈现任何诊断"），清单与标记归 G5。
 *
 * ## 滚动与坐标（唯一真相源）
 *
 * 图表窗格是原生滚动容器：spacer 撑到 `可见行数 × 行高`，SVG 钉在窗格可视区并用
 * `translate(−scrollTop, −scrollLeft)` 抵消滚动；左表同样用 `translateY(−scrollTop)` 的窗口。
 * 因此 `ViewModel.scrollTop` / `scrollLeft` 就是真实滚动位置，反算函数（`dayAtX`/`ordinalAtX`）自洽。
 */

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { countElements, RENDER_CORE_VERSION, ROW_HEIGHT, type ZoomKey } from '@ganttpilot/render-core';

import GanttChart from './components/GanttChart.vue';
import TaskTable from './components/TaskTable.vue';
import Toolbar from './components/Toolbar.vue';
import { useChart } from './composables/useChart.js';
import { useProject, type DispatchResult } from './composables/useProject.js';
import { createDemoDocumentOf, createPrimaryDemoDocument } from './demo.js';
import { collapseToCommand, editToCommand } from './edit.js';
import { formatProgress } from './shared.js';
import type { ColumnKey } from '@ganttpilot/xlsx-protocol';

const project = useProject();
const chart = useChart({
  document: project.document,
  schedule: project.schedule,
  calendar: project.calendar,
});

/**
 * 直接暴露 ref/computed，模板里无需 `.value`（`<script setup>` 的模板解包）。
 *
 * `useProject()` / `useChart()` 返回的是**普通对象**（不是 `reactive`），因此这里的解构
 * **不会**丢失响应性；但反过来说，`project.documentDiagnostics` 是 `ComputedRef` 而不是数组
 * ——所以下面一律用解构出来的名字，不再经 `project.*` 取值（这是本文件最容易踩的一处）。
 */
const { view, zoom, scrollTop, paneHeight, contentHeight, contentWidth, paneRef } = chart;
const {
  document,
  schedule,
  scheduleError,
  canUndo,
  canRedo,
  revision,
  documentDiagnostics,
  scheduleDiagnostics,
} = project;

const notice = ref<{ readonly level: 'info' | 'error'; readonly text: string } | null>(null);

/**
 * 左表可见性。
 *
 * 这不是"测量专用开关"——它是真实的功能（把图表放到全宽看），测量只是复用它：
 * 元素预算里的 `c₃` 只取决于"图表窗格宽 ÷ `pxPerDay`"，所以**只有全宽图表**才与
 * ADR 0007 §11 的回填口径（图表独占 1280 px）可比；分屏下的 `c₃` 必然更小，属布局差异。
 */
const tableVisible = ref(true);

/** 渲染窗口内的元素计数（状态栏显示；判据本体在 `render-core` 的 spec 里）。 */
const counts = computed(() => {
  const current = view.value;
  return current === null ? null : countElements(current);
});

const diagnosticCount = computed(() => documentDiagnostics.value.length + scheduleDiagnostics.value.length);

/** `compute` 失败时不画条形与连线，只显示占位（ADR 0007 §7）。 */
const cycleMessage = computed(() => scheduleError.value?.message ?? null);

function show(level: 'info' | 'error', text: string): void {
  notice.value = { level, text };
}

/** 命令派发：成功且真的改了，就把"受影响行 + 受影响边"标出来（ADR 0007 §8）。 */
function applyCommandResult(result: DispatchResult): void {
  if (!result.ok) {
    show('error', `命令被拒绝：${result.code ?? '未知'} —— ${result.message ?? ''}`);
    return;
  }
  if (!result.changed) return; // 无操作（恒等 patch）不压撤销栈，也不需要重绘
  chart.markEdited(result.touchedTaskIds);
}

function onCellEdit(payload: { readonly taskId: string; readonly column: ColumnKey; readonly text: string }): void {
  const outcome = editToCommand({
    document: document.value,
    taskId: payload.taskId,
    column: payload.column,
    text: payload.text,
  });
  if (!outcome.ok) {
    show('error', outcome.reason);
    return;
  }
  applyCommandResult(project.dispatch(outcome.command));
}

function onToggleCollapse(payload: { readonly taskId: string }): void {
  const outcome = collapseToCommand({ document: document.value, taskId: payload.taskId });
  if (!outcome.ok) {
    show('error', outcome.reason);
    return;
  }
  applyCommandResult(project.dispatch(outcome.command));
}

function onZoom(next: ZoomKey): void {
  chart.setZoom(next);
}

/**
 * xlsx 导入（G3 的协议层 + 本块的接线）。
 *
 * - 入口是**用户动作**，因此 925 KB 的 `exceljs` **只准动态 `import()`**（ADR 0006 §11）；
 * - 导入产物经 `document.replace` 落库（命令层唯一通道）；
 * - 问题清单**只计数**（呈现归 G5 的 G-8）。
 */
async function onImportFile(file: File): Promise<void> {
  show('info', `正在导入 ${file.name}…`);
  try {
    const { importXlsx } = await import('@ganttpilot/xlsx-protocol');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await importXlsx(bytes);
    const problems = result.diagnostics.length;
    if (!result.ok) {
      show('error', `导入失败：${String(problems)} 条问题（清单归 G5；G4 只计数）`);
      return;
    }
    applyCommandResult(project.ingestDocument(result.document));
    show(
      'info',
      `已导入 ${file.name}：${String(result.document.tasks.length)} 个任务、${String(result.document.links.length)} 条依赖；问题 ${String(problems)} 条`,
    );
  } catch (error) {
    show('error', `导入出错：${error instanceof Error ? error.message : String(error)}`);
  }
}

function resetToDemo(): void {
  project.reset(createPrimaryDemoDocument());
  show('info', '已重置为演示数据（1,000 任务 / 1,500 依赖的确定性夹具）');
}

/**
 * 折叠/展开会改变**可见行集合**，因此窗口必须重算——这不是出口条件禁止的"整表重建"
 * （禁止的是**行内编辑**触发整表重建）；`v-for` 的 `key` 仍是任务 id，DOM 复用不受影响。
 * 这里只做一件事：把可能越界的滚动位置夹回合法范围。
 */
watch(
  () => view.value?.rowCount,
  () => {
    const pane = paneRef.value;
    const current = view.value;
    if (pane === null || current === null) return;
    const maxScrollTop = Math.max(0, current.rowCount * current.rowHeight - current.height);
    if (pane.scrollTop > maxScrollTop) pane.scrollTop = maxScrollTop;
  },
);

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  // `?table=0` 隐藏左表（全宽图表）。测量脚本用它对齐 ADR 0007 §11 的图表宽度口径。
  if (params.get('table') === '0') tableVisible.value = false;

  // 测量钩子：只在 `?measure=` 出现时动态加载（普通首屏主 chunk 不含它）。
  if (!params.has('measure')) return;
  void (async () => {
    try {
      const { exposeMeasurement } = await import('./measure.js');
      exposeMeasurement({
        buildFixtureDocument: (key) => createDemoDocumentOf(key),
        loadDocument: async (nextDocument) => {
          project.reset(nextDocument);
          await nextTick();
        },
        controllerOf: (nextDocument) => ({
          document: nextDocument,
          /**
           * 把 `ViewModel` 交给**真实渲染路径**。
           *
           * `awaitFrame = false` 时只等 Vue 的 DOM 更新（`nextTick`）——
           * 这样测量方能量到"主线程上的同步工作量"；帧等待由测量方显式施加，
           * **不混进"每帧耗时"**（否则双 rAF 的约 33 ms 会被算成工作量）。
           */
          applyView: async (_next, nextScrollTop, awaitFrame = false) => {
            const pane = paneRef.value;
            if (pane !== null) pane.scrollTop = nextScrollTop;
            await nextTick();
            if (awaitFrame) {
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => resolve());
                });
              });
            }
          },
        }),
      });
      window.__GANTTPILOT_READY__ = true;
    } catch (error) {
      show('error', `测量钩子加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  })();
});
</script>

<template>
  <div class="app">
    <Toolbar
      :zoom="zoom"
      :revision="revision"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :table-visible="tableVisible"
      @zoom="onZoom"
      @import-file="onImportFile"
      @reset="resetToDemo"
      @toggle-table="tableVisible = !tableVisible"
    />

    <main class="split">
      <TaskTable
        v-if="view !== null && tableVisible"
        :view="view"
        :document="document"
        :schedule="schedule"
        :revision="revision"
        :scroll-top="scrollTop"
        :pane-height="paneHeight"
        :content-height="contentHeight"
        :disabled="false"
        @cell-edit="onCellEdit"
        @toggle-collapse="onToggleCollapse"
        @rejected="(message: string) => show('error', message)"
      />
      <div
        v-else-if="view === null"
        class="table-placeholder"
      >
        不可排程：左表只显示占位（诊断 UI 归 G5）
      </div>

      <div
        id="chart-pane"
        ref="paneRef"
        class="chart-pane"
        @scroll="chart.handleScroll()"
      >
        <div
          class="chart-spacer"
          :style="{ width: `${String(contentWidth)}px`, height: `${String(contentHeight)}px` }"
        />
        <GanttChart
          :view="view"
          :cycle-message="cycleMessage"
        />
      </div>
    </main>

    <footer class="status">
      <span>
        任务 {{ document.tasks.length }} · 依赖 {{ document.links.length }} ·
        可见行 {{ view?.rowCount ?? 0 }} · 渲染行 {{ view?.rows.length ?? 0 }} ·
        渲染边 {{ view?.edges.length ?? 0 }} ·
        元素 {{ counts?.total ?? 0 }}/{{ counts?.bound ?? 0 }}（c₃ = {{ counts?.c3 ?? 0 }}）
      </span>
      <span>
        档位 {{ zoom }}（px/day {{ view?.pxPerDay ?? 0 }}）· 行高 {{ ROW_HEIGHT }} px ·
        render-core {{ RENDER_CORE_VERSION }}
      </span>
      <span :class="{ warn: diagnosticCount > 0 }">诊断 {{ diagnosticCount }} 条（G4 只计数，呈现归 G5）</span>
      <span v-if="schedule !== null">
        首个汇总进度 {{ formatProgress(schedule.summaryProgress[0]) }}
      </span>
      <span
        v-if="notice !== null"
        :class="['notice', notice.level]"
      >{{ notice.text }}</span>
    </footer>
  </div>
</template>

<style>
html,
body {
  margin: 0;
  height: 100%;
  background: #ffffff;
}

#app {
  height: 100%;
}
</style>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #1f2933;
}

.split {
  display: flex;
  flex: 1;
  min-height: 0;
  border-top: 1px solid #e4e7ec;
}

.chart-pane {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: auto;
  background: #ffffff;
}

.chart-spacer {
  pointer-events: none;
}

.table-placeholder {
  padding: 1rem;
  color: #b42318;
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid #e4e7ec;
  background: #f9fafb;
  font-size: 12px;
  color: #475467;
}

.status .warn {
  color: #b54708;
}

.notice.info {
  color: #175cd3;
}

.notice.error {
  color: #b42318;
}
</style>
