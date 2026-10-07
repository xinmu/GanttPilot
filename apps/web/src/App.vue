<script setup lang="ts">
/**
 * 应用外壳（G4 + G5 + G6）：左表右图分屏 + 滚动同步 + 档位切换 + 折叠 + 行内编辑 + xlsx 导入
 * + **拖拽三语义 / 建线 / 撤销重做 / 冲突与成环标记 / 诊断清单**
 * + **自动保存与跨会话恢复**（G6：策略在引擎、时序与 DOM 在 `usePersistence`，本文件只接线）。
 *
 * ## 分工：本文件只做接线（P3/C6-f 起）
 *
 * 各块逻辑各有住所，本文件**不重复它们的口径**：
 *
 * | 块 | 住所 |
 * |---|---|
 * | 会话 / 排程 / 诊断（三层） | `useProject` + `useDiagnostics` |
 * | 视口与几何（`ViewModel`、滚动、档位） | `useChart` |
 * | 指针换算与窗格上的指针事件 | `useChartPointer` |
 * | 悬停三态（连接点显形 / 行带 / 左表联动） | `useHover` |
 * | 手势（拖动 / 建线 / 预检拒绝） | `useGesture`（纯内核在 `render-core`） |
 * | 键盘快捷键 | `useKeyboardShortcuts` |
 * | 导入接线与重置为演示 | `useImport` |
 * | 持久化与恢复 | `usePersistence` |
 * | 测量钩子（`?measure=` 才加载） | `measureHost`（**懒 chunk**） |
 *
 * ## 两条不变的口径
 *
 * - **手势逻辑在 `render-core`**（纯函数、进门禁）：本文件只把窗格矩形与滚动位置喂给
 *   `pointerFromClient`（屏幕坐标 → 内容坐标，ADR 0008 §13），再把 `PointerInput` 交给 `useGesture`；
 * - **拖动期不写文档**：位置经**会话锚点**进 `compute`（`useProject` 的 `anchors`），
 *   松手才提交命令（一次手势 = 一层撤销，IX-03）。
 *
 * ## 滚动与坐标（唯一真相源）
 *
 * 图表窗格是原生滚动容器：spacer 撑到 `可见行数 × 行高`，SVG 钉在窗格可视区并用
 * `translate(−scrollTop, −scrollLeft)` 抵消滚动；左表同样用 `translateY(−scrollTop)` 的窗口。
 * 因此 `ViewModel.scrollTop` / `scrollLeft` 就是真实滚动位置，反算函数（`dayAtX`/`ordinalAtX`）自洽。
 */

import { computed, onMounted, ref, watch } from 'vue';
import {
  collapseToCommand,
  countElements,
  countOverlays,
  dragPreviewFor,
  editToCommand,
  formatProgress,
  HEADER_HEIGHT_PX,
  RENDER_CORE_VERSION,
  ROW_HEIGHT,
  type ColumnKey,
  type DocumentLink,
  type ZoomKey,
} from '@ganttpilot/render-core';
import GanttChart from './components/GanttChart.vue';
import TaskTable from './components/TaskTable.vue';
import Toolbar from './components/Toolbar.vue';
import { useChart } from './composables/useChart.js';
import { useChartPointer } from './composables/useChartPointer.js';
import { useDiagnostics } from './composables/useDiagnostics.js';
import { useExport } from './composables/useExport.js';
import { useGesture } from './composables/useGesture.js';
import { useHover } from './composables/useHover.js';
import { useImport } from './composables/useImport.js';
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts.js';
import { usePersistence } from './composables/usePersistence.js';
import { useProject, type DispatchResult } from './composables/useProject.js';
import { useTemplate } from './composables/useTemplate.js';

const project = useProject();
const chart = useChart({
  document: project.document,
  schedule: project.schedule,
  calendar: project.calendar,
  renderCalendar: project.renderCalendar,
});

/**
 * 直接暴露 ref/computed，模板里无需 `.value`（`<script setup>` 的模板解包）。
 *
 * `useProject()` / `useChart()` 返回的是**普通对象**（不是 `reactive`），因此这里的解构
 * **不会**丢失响应性；但反过来说，`project.documentDiagnostics` 是 `ComputedRef` 而不是数组
 * ——所以下面一律用解构出来的名字，不再经 `project.*` 取值（这是本文件最容易踩的一处）。
 */
const { view, zoom, scrollTop, columnHeight, contentHeight, contentWidth, paneRef, hoverRow } = chart;
const {
  document,
  session,
  schedule,
  scheduleError,
  calendar,
  renderCalendar,
  canUndo,
  canRedo,
  revision,
  documentDiagnostics,
  scheduleDiagnostics,
  anchors,
  notice,
  setNotice,
} = project;

/** 状态栏提示条的唯一出口（`useProject` 的 `setNotice`）。 */
function show(level: 'info' | 'error', text: string): void {
  setNotice({ level, text });
}

/**
 * 诊断面板（三层拼接 + 冲突行集合）。P3/C6-f 从本文件迁出。
 */
const diagnostics = useDiagnostics({ documentDiagnostics, scheduleDiagnostics });
const { diagnostics: allDiagnostics, diagnosticCount, conflictTaskIds, open: diagnosticsOpen } = diagnostics;

/**
 * 导出接线（G7，ADR 0010）：几何与 SVG 来自 `render-core`，PPTX 来自 `pptx-renderer`（**动态导入**），
 * DOM 只在 `useExport` 里（PNG 光栅化、下载）。`zoom` 来自图表 composable ⇒ 导出跟随当前档位。
 */
const exporter = useExport({
  document,
  schedule,
  calendar,
  renderCalendar,
  zoom,
  notify: show,
});

/**
 * **模板下载接线**（P-46；ADR 0006 附录 §1）：字节由协议层的纯函数运行时生成
 * （因此仓库内不放 `.xlsx` 二进制），本层只做"按钮 → 动态 `import('exceljs')` → 下载"。
 */
const template = useTemplate({ notify: show });

/**
 * 命令派发：成功且真的改了，就把"受影响行 + 受影响边"标出来（ADR 0007 §8）。
 *
 * **提示条不在这里管**：它由 `useProject()` 的 `commit()` 统一迁移（`noticeAfterDispatch`，裁决 P-30 / P-31）——
 * 那样连手势自己的回调（拖动与建线的松手提交）也跑不掉；本层只负责渲染。
 */
function applyCommandResult(result: DispatchResult): void {
  if (!result.ok) return;
  if (!result.changed) return; // 无操作（恒等 patch）不压撤销栈，也不需要重绘
  chart.markEdited(result.touchedTaskIds);
}

/**
 * 手势接线（G5）：**DOM 只到 `useChartPointer` 为止**，其余交给 `render-core` 的纯内核。
 *
 * 落库走命令层唯一通道：`task.update` 与 `link.insert` 各一条命令 ⇒ 一次手势 = 一层撤销（IX-03）。
 */
const gesture = useGesture({
  view,
  document,
  schedule,
  calendar,
  renderCalendar,
  dispatch: (command) => project.dispatch(command),
  dispatchLink: (link: DocumentLink) => project.dispatch({ kind: 'link.insert', link }),
  setAnchors: project.setAnchors,
  clearAnchors: project.clearAnchors,
  /**
   * P-45：拖动期的**未提交文档副本**。`patch` 的唯一来源是内核的 `GestureUpdate.dragOutcome`
   * （本文件不推第二份"这次拖动改了几天"），落库仍然只有上面 `dispatch` 那条路。
   */
  setPreviewPatch: project.setPreviewPatch,
  notify: (commit) => {
    if (commit.kind === 'rejected') {
      // 两种预检拒绝的呈现不同：成环**高亮路径**；重复边**只提示**（它不改变图，高亮会误导）。
      show(
        'error',
        commit.reason === 'duplicate'
          ? '建线被拒绝：这条依赖已经存在（同类型、同 lag）——未重复插入'
          : `建线被拒绝：会形成环（${commit.cyclePath.join(' → ')}）——已高亮成环路径`,
      );
      return;
    }
    if (commit.code !== undefined) {
      show('error', `命令被拒绝：${commit.code} —— ${commit.message ?? ''}`);
    }
  },
});

const { anchorMode, highlight, preview } = gesture;

/**
 * 悬停三态（连接点显形 / 行带 / 左表联动）。P3/C6-f 从本文件迁出。
 *
 * 它必须**先于** `useChartPointer`（后者把 `updateHover` 当作入参）。
 */
const hover = useHover({ view, document, schedule, renderCalendar, hoverRow });
const { hoverTaskId, hoverX } = hover;

/** 指针换算与窗格上的指针事件（P3/C6-f 从本文件迁出）。 */
const pointer = useChartPointer({ view, document, schedule, renderCalendar, paneRef, gesture, updateHover: hover.updateHover });

/**
 * **测量旁路**（`?persist=0` / `localStorage['ganttpilot:persist']='0'`）：关掉自动保存。
 *
 * 存在的理由：出口条件①要"自动保存**不**吃拖拽帧预算"，那就必须有**同一台机器上的对照组**
 * （开/关持久化各跑一次，同尺比较）。默认开启，关掉只影响这一个标签页。
 */
function readPersistenceEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('persist') === '0') return false;
  try {
    return window.localStorage.getItem('ganttpilot:persist') !== '0';
  } catch {
    return true;
  }
}

/**
 * **持久化接线**（G6；ADR 0009）。
 *
 * 本文件只做三件事：把 `session`/`revision` 交给 `usePersistence`、把恢复结果交回 `useProject`、
 * 把**手势活动态**喂给策略（"拖动期不落盘"靠它，不靠运气）。
 * 触发条件、检查点阈值、去抖与封顶全部是引擎侧的纯状态机（`pnpm gate` 里有假时钟用例）。
 */
const persistenceEnabled = readPersistenceEnabled();
const persistence = usePersistence({
  document,
  revision,
  session,
  restore: (restored) => {
    project.restore(restored);
  },
  notify: (next) => {
    setNotice(next);
  },
  enabled: persistenceEnabled,
});
const { status: persistenceStatus } = persistence;

/** 手势活动态 → 策略（回到 `idle` 时若还有积压会立刻补写，见 `usePersistence.setGesture`）。 */
watch(
  () => gesture.state.value.kind,
  (kind) => {
    persistence.setGesture(kind === 'dragging' || kind === 'linking' ? 'dragging' : 'idle');
  },
);

/** 状态栏那一栏的文案（**只有一处**：不在模板里拼字符串）。 */
const persistenceText = computed(() => {
  const state = persistenceStatus.value;
  if (!persistence.ready.value) return '持久化：启动中';
  if (!state.enabled) {
    const reason =
      state.degradedReason === 'blocked-by-other-tab'
        ? '另一个标签页正在编辑'
        : (state.degradedReason ?? '测量旁路');
    return `持久化：已停用（${reason}）`;
  }
  const saved =
    state.lastSavedAtMs === null ? '尚未写入' : `已保存 ${new Date(state.lastSavedAtMs).toLocaleTimeString()}`;
  // **只显示"未落盘步数"且只在 >0 时显示**：`已保存` 之后它必须消失（这是自动保存真的发生的
  // 可观察证据）。旧文案写的"待落步数"其实是"最近一次写入覆盖的增量步数"，两者不是一回事——
  // 维护者的报文（拖动后显示 3）当场把这处**名不副实**抓了出来。
  const pending = state.unsavedSteps > 0 ? ` · 未落盘 ${String(state.unsavedSteps)} 步` : '';
  return `持久化：${saved} · 检查点 ${String(state.checkpoints)} 份${pending}${state.quotaDegraded ? ' · 配额降级' : ''}`;
});

/**
 * 左表可见性。
 *
 * 这不是"测量专用开关"——它是真实的功能（把图表放到全宽看），测量只是复用它：
 * 元素预算里的 `c₃` 只取决于"图表窗格宽 ÷ `pxPerDay`"，所以**只有全宽图表**才与
 * ADR 0007 §11 的回填口径（图表独占 1280 px）可比；分屏下的 `c₃` 必然更小，属布局差异。
 */
const tableVisible = ref(true);

/** 行内编辑（G4）：值 → 命令的映射只有一处（`editToCommand`）。 */
function onCellEdit(payload: { readonly taskId: string; readonly column: ColumnKey; readonly text: string }): void {
  const outcome = editToCommand({
    document: document.value,
    taskId: payload.taskId,
    column: payload.column,
    text: payload.text,
    // P-19：派生 `endDate` 必须用**与图表同一个**日历（`createScheduleCalendar`）。
    calendar: renderCalendar.value,
  });
  if (!outcome.ok) {
    show('error', outcome.reason);
    return;
  }
  applyCommandResult(project.dispatch(outcome.command));
}

/** 折叠开关（G4）：同样映射成 `task.update`（因此可撤销）。 */
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

// ---------------------------------------------------------------- G5：撤销 / 重做

function undo(): void {
  applyCommandResult(project.undo());
}

function redo(): void {
  applyCommandResult(project.redo());
}

/** `Esc` / `Ctrl+Z` / `Ctrl+Y`（编辑态优先；监护 window 的登记在模块内）。 */
useKeyboardShortcuts({ undo, redo, cancel: gesture.cancel });

/**
 * **导入接线 + 重置为演示**（P3/C6-f 从本文件迁出）。
 *
 * 它与诊断面板是一对：协议层诊断的快照落点是 `diagnostics.setImportDiagnostics`。
 */
const importer = useImport({
  document,
  ingestDocument: project.ingestDocument,
  scheduleError,
  showCyclePath: gesture.showCyclePath,
  applyCommandResult,
  setImportDiagnostics: diagnostics.setImportDiagnostics,
  reset: () => {
    // 不带参数 ⇒ `useProject` 走**演示口径**（`render-core/demoPlan.ts` 的小型计划，裁决 P-34）。
    project.reset();
  },
  notify: show,
});

/**
 * 拖动预览几何（ADR 0008 §13）：**与松手提交同源**的纯函数产物。
 *
 * 会话锚点只有 `startOrdinal`，因此 `resize-duration` 拖动期条体本体不会移动；
 * 覆盖层改画"结果轮廓"，三种语义在拖动期都有诚实的可见反馈。
 */
const dragPreview = computed(() =>
  view.value === null
    ? null
    : dragPreviewFor({
        view: view.value,
        document: document.value,
        calendar: renderCalendar.value,
        state: gesture.state.value,
      }),
);

/** 渲染窗口内的元素计数（含 G5 覆盖层；判据本体在 `render-core` 的 spec 里）。 */
const counts = computed(() => {
  const current = view.value;
  if (current === null) return null;
  const overlays = {
    dragOverlay: gesture.state.value.kind === 'dragging',
    linkPreview: preview.value !== null,
    conflict: conflictTaskIds.value.length > 0,
    highlightRows: highlight.value.rows.length,
    highlightEdges: highlight.value.edges.length,
  };
  return { ...countElements(current, overlays), overlays: countOverlays(overlays) };
});

/** `compute` 失败时不画条形与连线，只显示占位（ADR 0007 §7）；G5 额外给出成环路径摘要。 */
const cycleMessage = computed(() => scheduleError.value?.message ?? null);
const cyclePath = computed(() => scheduleError.value?.cyclePath ?? []);

/**
 * 成环路径的**可读标注**（`compute` 失败时没有 `ViewModel`，因此没有行/边可高亮——
 * 这一份列表就是"高亮成环路径"在不可排程态下的等价物；出口条件⑤的可判定形式）。
 */
const cycleLabels = computed(() =>
  cyclePath.value.map((taskId) => {
    const task = document.value.tasks.find((item) => item.id === taskId);
    if (task === undefined) return taskId;
    return `${task.outlineNumber} ${task.name}`;
  }),
);

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

  /**
   * 测量钩子：只在 `?measure=` 出现时**动态**加载（普通首屏主 chunk 不含它）。
   *
   * 宿主本体（约 250 行）住在 `measureHost.ts`，它自己 static import `./measure/index.js`
   * ⇒ 整条测量链都只挂在这次动态 import 之下。P3/C6-f 从本文件迁出。
   */
  if (!params.has('measure')) return;
  void (async () => {
    try {
      const { installMeasurementHost } = await import('./measureHost.js');
      installMeasurementHost({
        view,
        document,
        schedule,
        renderCalendar,
        revision,
        zoom,
        anchors,
        paneRef,
        gesture,
        pointer,
        hover,
        persistence,
        persistenceEnabled,
        setZoom: chart.setZoom,
        reset: (nextDocument) => {
          project.reset(nextDocument);
        },
        notify: show,
      });
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
      :anchor-mode="anchorMode"
      :diagnostic-count="diagnosticCount"
      :diagnostics-open="diagnosticsOpen"
      :drag-active="gesture.state.value.kind === 'dragging'"
      :export-format="exporter.format.value"
      :export-png-scale="exporter.pngScale.value"
      :export-with-sidebar="exporter.includeSidebar.value"
      :exporting="exporter.busy.value"
      :template-busy="template.busy.value"
      @zoom="onZoom"
      @import-file="importer.onImportFile"
      @template="template.downloadTemplate"
      @reset="importer.resetToDemo"
      @toggle-table="tableVisible = !tableVisible"
      @undo="undo"
      @redo="redo"
      @set-anchor-mode="gesture.setAnchorMode"
      @toggle-diagnostics="diagnostics.toggleOpen"
      @set-export-format="exporter.format.value = $event"
      @set-export-png-scale="exporter.pngScale.value = $event"
      @set-export-with-sidebar="exporter.includeSidebar.value = $event"
      @export-now="exporter.exportNow"
    />

    <main class="split">
      <TaskTable
        v-if="view !== null && tableVisible"
        :view="view"
        :document="document"
        :schedule="schedule"
        :calendar="renderCalendar"
        :scroll-top="scrollTop"
        :column-height="columnHeight"
        :content-height="contentHeight"
        :conflict-task-ids="conflictTaskIds"
        :hover-task-id="hoverTaskId"
        :disabled="false"
        @cell-edit="onCellEdit"
        @toggle-collapse="onToggleCollapse"
        @hover-row="(payload: { taskId: string | null }) => hover.setHoverFromTable(payload.taskId)"
        @rejected="(message: string) => show('error', message)"
      />
      <div
        v-else-if="view === null"
        class="table-placeholder"
      >
        不可排程：左表只显示占位
      </div>

      <!--
        图表列 = **表头带**（与左表表头同高，ADR 0007 §14）+ 滚动容器（绘制区）+ SVG 覆盖层。
        SVG 必须是滚动容器的**兄弟**（同在 `.chart-pane-wrap` 内）：若作为滚动容器的 abspos
        子元素，它会随内容滚动，再叠加内层 `translate(−scrollLeft, −scrollTop)` 就是**双重偏移**
        （P-23 诊断实测 = 机制③）。
      -->
      <div class="chart-column">
        <div
          class="chart-header"
          :style="{ height: `${String(HEADER_HEIGHT_PX)}px` }"
        />
        <div class="chart-pane-wrap">
          <div
            id="chart-pane"
            ref="paneRef"
            class="chart-pane"
            @scroll="chart.handleScroll()"
            @mousemove="pointer.onChartMouseMove"
            @mouseleave="hover.clearHover"
            @pointerdown="pointer.onPanePointerDown"
            @mousedown="pointer.onChartPointerDown"
          >
            <div
              class="chart-spacer"
              :style="{ width: `${String(contentWidth)}px`, height: `${String(contentHeight)}px` }"
            />
          </div>
          <GanttChart
            :view="view"
            :cycle-message="cycleMessage"
            :cycle-path="cyclePath"
            :cycle-labels="cycleLabels"
            :highlight="highlight"
            :preview="preview"
            :conflict-task-ids="conflictTaskIds"
            :drag-preview="dragPreview"
            :hover-task-id="hoverTaskId"
            :hover-x="hoverX"
            :linking="gesture.state.value.kind === 'linking'"
          />
        </div>
      </div>
    </main>

    <section
      v-if="diagnosticsOpen"
      class="diagnostics"
    >
      <header>
        <strong>诊断清单（{{ diagnosticCount }} 条）</strong>
        <span class="hint">协议层 + 文档校验层 + 排程层三层拼接（ADR 0006 §7）；G5 只呈现，不改判据</span>
      </header>
      <ul>
        <li
          v-for="(item, index) in allDiagnostics"
          :key="`diag-${String(index)}`"
          :class="item.severity"
        >
          <code>{{ item.code }}</code>
          <span>{{ item.message }}</span>
          <em v-if="item.taskId !== undefined">{{ item.taskId }}</em>
        </li>
      </ul>
      <p
        v-if="allDiagnostics.length === 0"
        class="hint"
      >
        没有诊断。
      </p>
    </section>

    <footer class="status">
      <span>
        任务 {{ document.tasks.length }} · 依赖 {{ document.links.length }} ·
        可见行 {{ view?.rowCount ?? 0 }} · 渲染行 {{ view?.rows.length ?? 0 }} ·
        渲染边 {{ view?.edges.length ?? 0 }} ·
        元素 {{ counts?.total ?? 0 }}/{{ counts?.bound ?? 0 }}（c₃ = {{ counts?.c3 ?? 0 }}、c₄ = {{ counts?.c4 ?? 0 }}、
        覆盖层 {{ counts?.overlays ?? 0 }}）
      </span>
      <span>
        档位 {{ zoom }}（px/day {{ view?.pxPerDay ?? 0 }}）· 行高 {{ ROW_HEIGHT }} px ·
        render-core {{ RENDER_CORE_VERSION }}
      </span>
      <span :class="{ warn: diagnosticCount > 0 }">
        诊断 {{ diagnosticCount }} 条（{{ diagnosticsOpen ? '已展开' : '点击工具栏「诊断」查看' }}）
      </span>
      <span :class="{ warn: conflictTaskIds.length > 0 }">
        锚点 {{ anchors.length }} · 冲突 {{ conflictTaskIds.length }}
      </span>
      <span v-if="schedule !== null">
        首个汇总进度 {{ formatProgress(schedule.summaryProgress[0]) }}
      </span>
      <span
        v-if="exporter.advisory.value !== ''"
        class="export-hint"
        title="导出前的可读性提示（ADR 0010 §11）：按当前档位等比缩到单页后的**有效字号**；不阻断导出"
      >{{ exporter.advisory.value }}</span>
      <span
        class="persist"
        title="命令级撤销/重做 + 低频检查点恢复（ADR 0009）；会话锚点、滚动位置与档位不跨会话恢复"
      >{{ persistenceText }}</span>
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

/**
 * 图表列 = 表头带 + 绘制区。**外高与左表列相同**，因此两栏的行屏幕几何同式（ADR 0007 §14）：
 * `行屏幕 y = 列顶 + HEADER_HEIGHT_PX + row × ROW_HEIGHT − scrollTop`。
 */
.chart-column {
  /* `position: relative` 是**必需的**：SVG（`.gantt-svg`）的定位祖先是本列，
     它的 `top: 0` 就是表头带顶、盒高 = 表头带 + 绘制区（ADR 0007 §15）。 */
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

/* 与 `.table-header` 同高、同底色：两栏表头连成一条带（高度由 `HEADER_HEIGHT_PX` 内联喂入）。 */
.chart-header {
  flex: 0 0 auto;
  /* `border-box` 让 `HEADER_HEIGHT_PX` 是**外高**（含 1 px 下边框）——与左表表头同口径，
     否则两栏差 1 px、整列行都偏（P-23 诊断实测 `header-height-mismatch`）。 */
  box-sizing: border-box;
  border-bottom: 1px solid #e4e7ec;
  background: #f9fafb;
}

/* SVG 与滚动容器是**兄弟**（SVG 不随内容滚动 = "钉住"），二者的定位祖先是 `.chart-column`。 */
.chart-pane-wrap {
  flex: 1;
  min-height: 0;
}

/**
 * 图表窗格的滚动容器（P-44）。
 *
 * **`overflow: scroll`（常驻两轴滚动条）是必须的，不是样式偏好**：`pane.clientWidth/clientHeight`
 * 是 `contentWidth`（`ViewModel.contentWidth = max(窗格宽, 最末任务右缘 + …)`，ADR 0007 §15.1）
 * 与滚动范围的**输入**，而"滚动条要不要出现"又由**输出**（内容宽/高）决定 ⇒ `overflow: auto` 下
 * 这是一条**自引用环**（滚动条出现 ⇒ 客户区变小 ⇒ 内容/滚动范围变 ⇒ 滚动条又变）。
 * `scroll` 让客户区**与滚动条无关**（两轴永久占用 15 px），环从构造上消失。
 *
 * 代价（明确接受）：**小文档也会看到灰掉的滚动条**；记录制的 `c₃` 与窗格尺寸随之刷新
 * （ADR 0007 §11 的回填锚值定义在**合成视口 1280×640** 上、由 spec 断言，**不受影响**）。
 * 判据在 `scripts/smoke-build.mjs` 的「布局稳态」：临时把 `overflow` 换成 `hidden`
 * （等价于"永远没有滚动条"）再量，客户区必须**一字不变**——`auto` 下必然不同，判据因此可判定地有判别力。
 */
.chart-pane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: scroll;
  background: #ffffff;
}

.chart-spacer {
  pointer-events: none;
}

.table-placeholder {
  padding: 1rem;
  color: #b42318;
}

/**
 * 状态栏（P-43 的**布局稳态**要求）：**高度必须与文案长度无关**。
 *
 * 人工复核报文："刷新页面会发生短暂的画面抖动，点击'重置演示数据'会发生持续抖动，再次点击恢复。"
 * 根因是一个**自激环**：状态栏文案里含**视图派生的数字**（可见行/渲染行/渲染边/元素…），
 * 而它原先 `flex-wrap: wrap` ⇒ 文案跨过换行临界值时 footer 变高 ⇒ 图表窗格变矮 ⇒
 * 视图重新裁剪 ⇒ **文案里的数字又变** ⇒ 再决定换行……两态互为因果、无法收敛。
 *
 * 修法：`nowrap + overflow: hidden`（**永远单行**）+ 各段 `white-space: nowrap`；
 * 最长的那一段允许**省略号截断**而不是换行。判据在 `scripts/smoke-build.mjs` 的
 * 「布局稳态」（进 `pnpm gate`）：60 帧内根元素不滚动、footer 高度与窗格尺寸恒定。
 */
.status {
  display: flex;
  flex-wrap: nowrap;
  gap: 1.25rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid #e4e7ec;
  background: #f9fafb;
  font-size: 12px;
  color: #475467;
  overflow: hidden;
}

.status > span {
  white-space: nowrap;
}

/* 第一段最长（任务/依赖/可见行/渲染行/渲染边/元素）：**只让它截断**，其余各段保持完整。 */
.status > span:first-child {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status .warn {
  color: #b54708;
}

.status .persist {
  color: #475467;
}

.notice.info {
  color: #175cd3;
}

.notice.error {
  color: #b42318;
}

.diagnostics {
  max-height: 30vh;
  overflow: auto;
  padding: 0.4rem 0.75rem;
  border-top: 1px solid #e4e7ec;
  background: #fcfcfd;
  font-size: 12px;
}

.diagnostics header {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  margin-bottom: 0.25rem;
}

.diagnostics ul {
  margin: 0;
  padding-left: 1rem;
}

.diagnostics li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.diagnostics li.error {
  color: #b42318;
}

.diagnostics li.warning {
  color: #b54708;
}

.diagnostics li.info {
  color: #475467;
}

.diagnostics code {
  font-family: ui-monospace, Consolas, monospace;
}

.diagnostics em {
  color: #98a2b3;
  font-style: normal;
}

.hint {
  color: #667085;
}
</style>
