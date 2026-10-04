<script setup lang="ts">
/**
 * 应用外壳（G4 + G5）：左表右图分屏 + 滚动同步 + 档位切换 + 折叠 + 行内编辑 + xlsx 导入
 * + **拖拽三语义 / 建线 / 撤销重做 / 冲突与成环标记 / 诊断清单**。
 *
 * ## 分工（G5 的落地口径，ADR 0008 §4）
 *
 * - **手势逻辑在 `render-core`**（纯函数、进门禁）：本文件只把窗格矩形与滚动位置喂给
 *   `pointerFromClient`（屏幕坐标 → 内容坐标，ADR 0008 §13），再把 `PointerInput`
 *   交给 `useGesture`； * - **拖动期不写文档**：位置经**会话锚点**进 `compute`（`useProject` 的 `anchors`），
 *   松手才提交命令（一次手势 = 一层撤销，IX-03）；
 * - **冲突与成环的判据来自引擎**：`anchorConflict` 诊断 / `wouldCreateCycle` 的 `path`，
 *   本层只做样式映射（不新开诊断码、不自己判"算不算冲突"）。
 *
 * ## 滚动与坐标（唯一真相源）
 *
 * 图表窗格是原生滚动容器：spacer 撑到 `可见行数 × 行高`，SVG 钉在窗格可视区并用
 * `translate(−scrollTop, −scrollLeft)` 抵消滚动；左表同样用 `translateY(−scrollTop)` 的窗口。
 * 因此 `ViewModel.scrollTop` / `scrollLeft` 就是真实滚动位置，反算函数（`dayAtX`/`ordinalAtX`）自洽。
 */

import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';import {
  collapseToCommand,
  countElements,
  countOverlays,
  cursorForPointer,
  dragPreviewFor,
  editToCommand,
  formatProgress,
  HEADER_HEIGHT_PX,
  linkEntryFor,
  pointerFromClient,
  resolvePointerTarget,
  RENDER_CORE_VERSION,
  ROW_HEIGHT,
  type ColumnKey,
  type CursorHint,
  type DocumentLink,
  type PointerInput,
  type ZoomKey,
} from '@ganttpilot/render-core';
import GanttChart from './components/GanttChart.vue';
import TaskTable from './components/TaskTable.vue';
import Toolbar from './components/Toolbar.vue';
import { useChart } from './composables/useChart.js';
import { useGesture } from './composables/useGesture.js';
import { useProject, type DispatchResult } from './composables/useProject.js';
import { createDemoDocumentOf, createPrimaryDemoDocument } from './demo.js';

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
const { view, zoom, scrollTop, columnHeight, contentHeight, contentWidth, paneRef } = chart;
const {
  document,
  schedule,
  scheduleError,
  calendar,
  canUndo,
  canRedo,
  revision,
  documentDiagnostics,
  scheduleDiagnostics,
  anchors,
  notice,
  setNotice,
} = project;

/**
 * 手势接线（G5）：**DOM 只到这里为止**，其余交给 `render-core` 的纯内核。
 *
 * 落库走命令层唯一通道：`task.update` 与 `link.insert` 各一条命令 ⇒ 一次手势 = 一层撤销（IX-03）。
 */
const gesture = useGesture({
  view,
  document,
  schedule,
  calendar,
  dispatch: (command) => project.dispatch(command),
  dispatchLink: (link: DocumentLink) => project.dispatch({ kind: 'link.insert', link }),
  setAnchors: project.setAnchors,
  clearAnchors: project.clearAnchors,
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

const {
  anchorMode,
  highlight,
  preview,
} = gesture;

/**
 * 左表可见性。
 *
 * 这不是"测量专用开关"——它是真实的功能（把图表放到全宽看），测量只是复用它：
 * 元素预算里的 `c₃` 只取决于"图表窗格宽 ÷ `pxPerDay`"，所以**只有全宽图表**才与
 * ADR 0007 §11 的回填口径（图表独占 1280 px）可比；分屏下的 `c₃` 必然更小，属布局差异。
 */
const tableVisible = ref(true);

/**
 * 窗格上的 `mousemove`：**一条事件、两件事**（顺序不可换）。
 *
 * 1. **光标提示**（R3 后半）：只有 `idle` 时才更新——拖动/建线期间光标必须保持"正在操作"的语义，
 *    否则拖到端点区会被 `col-resize` 打断；
 * 2. **手势推进**（拖动中的候选）：`useGesture` 只在非 `idle` 时才会真正重算。
 *
 * 光标提示（ADR 0008 §16.2 的 R3 后半）**不走 Vue 响应式**：它是逐 `mousemove` 变化的 DOM 表现，
 * 由 `onMouseMoveHint` 直接写 `pane.style.cursor`（放进响应式会让拖拽帧预算为此付费，
 * ADR 0008 §11 的判据）。因此模板上**不**绑 `:style`——两处都写会互相打架。
 */

/** 诊断清单是否展开（G-8 的**受控收口**：计数 + 可展开列表；完整向导形态归后续）。 */
/**
 * 指针所在的渲染行与内容坐标（**只驱动连接点的显形**，不参与命中判定）。
 *
 * 为什么放两个 ref 而不是一个对象：赋值时可以做**相等短路**（同一行 + 同一个 x 就不触发更新），
 * 否则每次 `mousemove` 都会让 `GanttChart` 的那一行重算，拖拽帧预算要为"没变化"付费
 * （ADR 0008 §11 的判据）。
 */
const hoverTaskId = ref<string | null>(null);
const hoverX = ref<number | null>(null);
const diagnosticsOpen = ref(false);

/**
 * 协议层诊断（**导入那一刻的快照**）。
 *
 * 为什么必须存下来：`importXlsx` 的诊断只在导入时存在（成环丢弃、未识别列、公式无缓存值…），
 * 而文档校验层与排程层的诊断是**每帧重算**的。G5 出口条件⑤要求"导入的成环边进问题清单"，
 * 但此前应用层只把**条数**写进提示、没有保留数组，于是 `XLSX_CYCLE_EDGE_DROPPED` 从未进过面板
 * （P-22 由第 13 条的记录制导入当场抓出）。
 *
 * 类型写成**结构子集**而不是 `import type { XlsxDiagnostic }`：对协议包的静态 import 会在
 * 类型图上造出指向 `exceljs` 的边（ADR 0008 §1 的候选 B 正是因此被否），而本层只消费四个字段。
 */
interface ImportDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly taskId?: string;
}

const importDiagnostics = shallowRef<readonly ImportDiagnostic[]>([]);

/** 全部诊断（**三层拼接**：协议层 = 上一次导入的快照，后两层每帧重算；ADR 0006 §7）。 */
const diagnostics = computed(() => [
  ...importDiagnostics.value,
  ...documentDiagnostics.value,
  ...scheduleDiagnostics.value,
]);
/** `anchorConflict` 的行（**判据来自引擎**，ADR 0008 §6）——冲突标红的唯一来源。 */
const conflictTaskIds = computed(() =>
  scheduleDiagnostics.value
    .filter((item) => item.code === 'anchorConflict' && item.taskId !== undefined)
    .map((item) => item.taskId as string),
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

const diagnosticCount = computed(() => diagnostics.value.length);

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

function show(level: 'info' | 'error', text: string): void {
  setNotice({ level, text });
}

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

function onCellEdit(payload: { readonly taskId: string; readonly column: ColumnKey; readonly text: string }): void {
  const outcome = editToCommand({
    document: document.value,
    taskId: payload.taskId,
    column: payload.column,
    text: payload.text,
    // P-19：派生 `endDate` 必须用**与图表同一个**日历（`createScheduleCalendar`）。
    calendar: calendar.value,
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

// ---------------------------------------------------------------- G5：指针 → 手势

/**
 * 屏幕坐标 → **归一化指针**（内容坐标）的唯一实现。
 *
 * **只有一条路**：`pointerFromClient`（`render-core` 的纯函数，ADR 0008 §13）。
 * 本函数只负责把窗格的 `getBoundingClientRect()` 与滚动位置喂给它——
 * 绝不用 `event.offsetX/offsetY`：它们**相对事件目标元素**，`mousedown` 落在条体 `<rect>` 上时
 * 会被当成内容坐标（P-21 §2 的 R1：按下即跳位、条体外点击改日期）。
 * 返回 `null` = 窗格或视图还没就绪，调用方直接丢弃这次事件。
 *
 * **测量钩子（G5 批次 D）与用户操作共用本函数**：`--align` 的"所见 = 所点"判据必须走同一条换算，
 * 否则它证明的只是一条平行的公式。
 */
function pointerFromClientPoint(
  clientX: number,
  clientY: number,
  buttons: number,
  modifiers: { readonly shiftKey?: boolean } = {},
): PointerInput | null {
  const pane = paneRef.value;
  const current = view.value;
  if (pane === null || current === null) return null;
  const rect = pane.getBoundingClientRect();
  return pointerFromClient({
    clientX,
    clientY,
    paneLeft: rect.left,
    paneTop: rect.top,
    scrollLeft: current.scrollLeft,
    scrollTop: current.scrollTop,
    buttons,
    ...(modifiers.shiftKey === true ? { shiftKey: true } : {}),
  });
}

/**
 * DOM 事件 → 归一化指针。松手（`mouseup` 挂在 window 上）走**同一个**换算——
 * 拖出窗格时坐标仍然自洽。
 */
function pointerFrom(event: MouseEvent): PointerInput | null {
  // `Alt` **不是**手势修饰键（P-32 的复验已把它删除）：它被 Windows 的"移动窗口"占用，
  // 事件到不了页面 ⇒ 只保留 `shiftKey`（将来"约束拖动"之类会用到）。
  return pointerFromClientPoint(event.clientX, event.clientY, event.buttons, {
    ...(event.shiftKey ? { shiftKey: true } : {}),
  });
}

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
        calendar: calendar.value,
        state: gesture.state.value,
      }),
);

/**
 * **建线的起手位置**（ADR 0008 §16.3／裁决 P-32）：指针落在某行的**连接点**上时非空。
 *
 * 纯函数在 `render-core` 的 `linkEntryFor`（进门禁），这里只负责调用——与 `pointerFromClient`
 * 同一条纪律："入口层算出来的输入"必须落在可断言的地方（P-19/P-21 两次的教训）。
 */
function linkEntryOf(pointer: PointerInput): { readonly taskId: string; readonly exitSide: 'left' | 'right' } | null {
  const current = view.value;
  const currentSchedule = schedule.value;
  if (current === null || currentSchedule === null) return null;
  const entry = linkEntryFor({
    point: pointer,
    view: current,
    document: document.value,
    schedule: currentSchedule,
    calendar: calendar.value,
  });
  return entry === null ? null : { taskId: entry.taskId, exitSide: entry.exitSide };
}

/**
 * 光标提示（ADR 0008 §16.2 的 R3 后半）：**纯函数给枚举，本层只做赋值**。
 *
 * 为什么不留响应式状态：它是逐 `mousemove` 变化的 DOM 表现，放进 Vue 响应式会让拖拽帧预算
 * 为此付费（ADR 0008 §11 的判据）。因此这里写的是原始 DOM 元素（`HTMLElement` 之外的用法不收）。
 */
function onMouseMoveHint(event: MouseEvent): void {
  const pane = paneRef.value;
  if (pane === null) return;
  const current = view.value;
  const currentSchedule = schedule.value;
  if (current === null || currentSchedule === null) {
    pane.style.cursor = 'default';
    return;
  }
  const pointer = pointerFromClientPoint(event.clientX, event.clientY, event.buttons);
  if (pointer === null) return;
  updateHover(pointer);
  // 顺序与 `cursorForPointer` 一致：**连接点（建线）优先**于条体上的判定区。
  const hint: CursorHint =
    linkEntryFor({
      point: pointer,
      view: current,
      document: document.value,
      schedule: currentSchedule,
      calendar: calendar.value,
    }) !== null
      ? 'crosshair'
      : cursorForPointer({
          point: pointer,
          view: current,
          document: document.value,
          schedule: currentSchedule,
          calendar: calendar.value,
        });
  pane.style.cursor = hint;
}

/**
 * **指针捕获**（第四次人工复验的修法之二）：在 `pointerdown` 时把指针捕获到窗格上。
 *
 * 捕获之后，浏览器把**后续所有** `pointermove`/`pointerup` 都派发给该元素，
 * 与"指针下面现在是哪个元素""那些元素有没有被重建"完全无关——
 * 这正是拖动建线需要的行为（拖动期行元素会因为连接点显形/消失被 Vue 重建）。
 * 用 `try` 包住：合成事件（记录制脚本）没有真实指针，`setPointerCapture` 会抛。
 */
function onPanePointerDown(event: PointerEvent): void {
  const pane = paneRef.value;
  if (pane === null || event.button !== 0) return;
  try {
    pane.setPointerCapture(event.pointerId);
  } catch {
    // 合成事件没有可捕获的指针：忽略（拖动仍由 window 级 mousemove 兜住）。
  }
}

function onChartPointerDown(event: MouseEvent): void {
  if (event.button !== 0) return;
  /**
   * **必须阻止原生行为**（第四次人工复验的修法）。
   *
   * 不阻止时 `mousedown` 会启动浏览器的**文本选择**（实测事件顺序 `mousedown → selectstart → mousemove …`），
   * 随后 `mousemove` 不再按窗格路径派发：实测"按下之后只收到 1 次移动"，
   * 表现即"能从连接点起手势、但拖不出线"（`mouseup` 同样收不到，连接预览停住不动）。
   */
  event.preventDefault();  const pointer = pointerFrom(event);
  if (pointer === null) return;
  const entry = linkEntryOf(pointer);
  gesture.onPointerDown(entry === null ? { pointer } : { pointer, entryPoint: entry });
}

function onChartPointerMove(event: MouseEvent): void {
  if (gesture.state.value.kind === 'idle') return;
  const pointer = pointerFrom(event);
  if (pointer === null) return;
  gesture.onPointerMove(pointer);
}

/**
 * 记录"指针在哪一行、x 是多少"（**只驱动连接点的显形**）。
 *
 * 行号走 `resolvePointerTarget`（渲染窗口内的可见行；缓冲行与折叠行不可交互），
 * 因此"连接点显形"与"能不能点中"用的是**同一个行集合**。
 * 相等短路是必需的：`mousemove` 的频率远高于"行或 x 真的变了"的频率。
 */
function updateHover(pointer: PointerInput): void {
  const current = view.value;
  const currentSchedule = schedule.value;
  if (current === null || currentSchedule === null) return;
  const target = resolvePointerTarget({
    view: current,
    document: document.value,
    schedule: currentSchedule,
    calendar: calendar.value,
    x: pointer.x,
    y: pointer.y,
  });
  const nextId = target === null ? null : target.taskId;
  const nextX = target === null ? null : Math.round(pointer.x);
  if (hoverTaskId.value !== nextId) hoverTaskId.value = nextId;
  if (hoverX.value !== nextX) hoverX.value = nextX;
}

/**
 * 建线期推进"指针所在行"（**只影响可见性**，不参与命中判定）。
 *
 * 与 `updateHover` 的差别只有一处：空闲时靠窗格的 `mousemove` 就够，而建线期必须**同时**在
 * window 级推进——拖动期行的 `<g>` 会因为连接点显隐被重建，窗格路径的派发可能中断（见 `onWindowPointerMove`）。
 */
function advanceLinkHover(event: MouseEvent): void {
  const pointer = pointerFromClientPoint(event.clientX, event.clientY, 1);
  if (pointer !== null) updateHover(pointer);
}

/** 指针离开窗格：连接点立刻消失（不留"悬空的方块"）。 */
function clearHover(): void {
  hoverTaskId.value = null;
  hoverX.value = null;
}
/** 窗格 `mousemove` 的**唯一入口**（模板上只能有一个 `@mousemove`，否则 Vue 报重复属性）。 */
function onChartMouseMove(event: MouseEvent): void {
  const kind = gesture.state.value.kind;
  if (kind === 'idle') onMouseMoveHint(event);
  else if (kind === 'linking') advanceLinkHover(event);
  onChartPointerMove(event);
}

/**
 * 手势期的 `mousemove` 同时挂在 `window` 上（与 `mouseup` 同一手法，第二道保险）。
 *
 * 拖动期行的 `<g>` 会因为"指针所在行"改变（连接点按需显形）被 Vue 重建，
 * 绑在窗格路径上的派发可能随之中断；挂 `window` 不依赖任何行元素的生命周期。
 */
function onWindowPointerMove(event: MouseEvent): void {
  const kind = gesture.state.value.kind;
  if (kind === 'idle') return;
  // 建线期也要推进"指针所在行"：可落点因此跟着指针走（第五次人工复验第 1 条）。
  if (kind === 'linking') advanceLinkHover(event);
  onChartPointerMove(event);
}

function onWindowPointerUp(event: MouseEvent): void {
  if (gesture.state.value.kind === 'idle') return;
  // 松手可能在图表之外（拖出窗格），因此监听挂在 window 上；坐标仍按内容坐标系换算。
  const pointer = pointerFrom(event);
  if (pointer === null) {
    gesture.cancel();
    return;
  }
  gesture.onPointerUp({ ...pointer, buttons: 0 });
}

// ---------------------------------------------------------------- G5：撤销 / 重做

function undo(): void {
  applyCommandResult(project.undo());
}

function redo(): void {
  applyCommandResult(project.redo());
}

/**
 * `Ctrl+Z` / `Ctrl+Y`（`Ctrl+Shift+Z` 等价）。
 *
 * **编辑态优先**：左表单元格正在编辑时（焦点在 `input` / `textarea` 上）把快捷键让给输入框的
 * 原生撤销——否则用户想撤掉刚敲的字，结果整份文档回退了一步（ADR 0008 §10）。
 */
function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  const editing =
    target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  if (event.key === 'Escape') {
    gesture.cancel();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && editing) return;
  if (key === 'z' && event.shiftKey) {
    event.preventDefault();
    redo();
    return;
  }
  if (key === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (key === 'y') {
    event.preventDefault();
    redo();
  }
}

/**
 * xlsx 导入（G3 的协议层 + 本块的接线）。
 *
 * - 入口是**用户动作**，因此 925 KB 的 `exceljs` **只准动态 `import()`**（ADR 0006 §11）；
 * - 导入产物经 `document.replace` 落库（命令层唯一通道）；
 * - 问题清单进**诊断面板**（G-8 的受控收口：计数 + 可展开列表）。
 */
async function onImportFile(file: File): Promise<void> {
  show('info', `正在导入 ${file.name}…`);
  try {
    const { importXlsx } = await import('@ganttpilot/xlsx-protocol');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await importXlsx(bytes);
    // 协议层诊断**必须留下来**（见 `importDiagnostics` 的说明）——它只在导入那一刻存在。
    importDiagnostics.value = result.diagnostics;
    const problems = result.diagnostics.length;    if (!result.ok) {
      show('error', `导入失败：${String(problems)} 条问题 —— 详见诊断清单`);
      return;
    }
    applyCommandResult(project.ingestDocument(result.document));
    show(
      'info',
      `已导入 ${file.name}：${String(result.document.tasks.length)} 个任务、${String(result.document.links.length)} 条依赖；问题 ${String(problems)} 条`,
    );
    // 导入的成环边已由 G3 按确定性顺序丢弃（ADR 0006 §1）——这里把"是否还有环"如实呈现：
    // 若导入产物仍不可排程，`scheduleError` 会带出 `cyclePath`，由图表层高亮。
    const failed = project.scheduleError.value;
    if (failed !== null && failed.cyclePath.length > 0) {
      gesture.showCyclePath(failed.cyclePath);
      show('error', `导入产物仍不可排程：${failed.message}`);
    }
  } catch (error) {
    show('error', `导入出错：${error instanceof Error ? error.message : String(error)}`);
  }
}

function resetToDemo(): void {
  project.reset(createPrimaryDemoDocument());
  // 重置会换掉整份文档：上一次导入的协议层诊断随之作废（否则面板会显示别份文档的问题）。
  importDiagnostics.value = [];
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
        // G5：拖动测量的宿主——**走真实指针入口**（`useGesture`），不另开测试后门。
        drag: {
          view: () => view.value,
          document: () => document.value,
          schedule: () => schedule.value,
          calendar: () => calendar.value,
          pointer: {
            down: (event) => {
              const pointer = pointerFrom(event);
              if (pointer === null) return;
              const entry = linkEntryOf(pointer);
              gesture.onPointerDown(entry === null ? { pointer } : { pointer, entryPoint: entry });
            },
            move: (event) => {
              const pointer = pointerFrom(event);
              if (pointer !== null) gesture.onPointerMove(pointer);
            },
            up: (event) => {
              const pointer = pointerFrom(event);
              if (pointer !== null) gesture.onPointerUp({ ...pointer, buttons: 0 });
            },
          },          gestureKind: () => gesture.state.value.kind,
          /** 建线入口的判定（**与用户操作同一条路**：linkEntryFor 的纯函数）。 */
          entryPointOf: (clientX: number, clientY: number) => {
            const pointer = pointerFromClientPoint(clientX, clientY, 1);
            return pointer === null ? null : linkEntryOf(pointer);
          },
          /** 把"指针在某屏幕点"交给应用（触发连接点的显形判定；记录制先 hover 再读 DOM）。 */
          hoverAt: (clientX: number, clientY: number) => {
            const pointer = pointerFromClientPoint(clientX, clientY, 1);
            if (pointer !== null) updateHover(pointer);
          },
          clearHover: () => {
            clearHover();
          },
          /** 光标提示的分类（记录制用它核对"手柄/连接点/判定区"的光标真的不同）。 */
          cursorAt: (clientX: number, clientY: number) => {
            const pointer = pointerFromClientPoint(clientX, clientY, 1);
            const current = view.value;
            const currentSchedule = schedule.value;
            if (pointer === null || current === null || currentSchedule === null) return 'default';
            if (
              linkEntryFor({
                point: pointer,
                view: current,
                document: document.value,
                schedule: currentSchedule,
                calendar: calendar.value,
              }) !== null
            ) {
              return 'crosshair';
            }
            return cursorForPointer({
              point: pointer,
              view: current,
              document: document.value,
              schedule: currentSchedule,
              calendar: calendar.value,
            });
          },
          anchors: () => anchors.value.length,
          startDateOf: (taskId: string) =>
            document.value.tasks.find((task) => task.id === taskId)?.startDate ?? null,
        },
        // G5 批次 D：两栏行对齐的**只读**采数入口（判读在 `render-core` 的 `diagnoseRowAlignment`）。
        // `pointerFromClientOf` 走**用户操作的同一个换算**（`pointerFromClientPoint`）——
        // "所见 = 所点"判据因此不是一条平行公式（ADR 0007 §14）。
        align: {
          view: () => view.value,
          pane: () => paneRef.value,
          pointerFromClientOf: (clientX: number, clientY: number) =>
            pointerFromClientPoint(clientX, clientY, 1),
        },
      });
      window.__GANTTPILOT_READY__ = true;
    } catch (error) {
      show('error', `测量钩子加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  })();
});

// G5：`Esc` 取消手势、`Ctrl+Z` / `Ctrl+Y` 撤销重做；松手监听挂 window（拖出窗格也能收尾）。
onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('mouseup', onWindowPointerUp);
  window.addEventListener('mousemove', onWindowPointerMove);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('mouseup', onWindowPointerUp);
  window.removeEventListener('mousemove', onWindowPointerMove);
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
      @zoom="onZoom"
      @import-file="onImportFile"
      @reset="resetToDemo"
      @toggle-table="tableVisible = !tableVisible"
      @undo="undo"
      @redo="redo"
      @set-anchor-mode="gesture.setAnchorMode"
      @toggle-diagnostics="diagnosticsOpen = !diagnosticsOpen"
    />

    <main class="split">
      <TaskTable
        v-if="view !== null && tableVisible"
        :view="view"
        :document="document"
        :schedule="schedule"
        :calendar="calendar"
        :scroll-top="scrollTop"
        :column-height="columnHeight"
        :content-height="contentHeight"
        :conflict-task-ids="conflictTaskIds"
        :disabled="false"
        @cell-edit="onCellEdit"
        @toggle-collapse="onToggleCollapse"
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
            @mousemove="onChartMouseMove"
            @mouseleave="clearHover"
            @pointerdown="onPanePointerDown"
            @mousedown="onChartPointerDown"
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
          v-for="(item, index) in diagnostics"
          :key="`diag-${String(index)}`"
          :class="item.severity"
        >
          <code>{{ item.code }}</code>
          <span>{{ item.message }}</span>
          <em v-if="item.taskId !== undefined">{{ item.taskId }}</em>
        </li>
      </ul>
      <p
        v-if="diagnostics.length === 0"
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

.chart-pane {
  position: relative;
  width: 100%;
  height: 100%;
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
