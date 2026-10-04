<script setup lang="ts">
/**
 * 纯 SVG 甘特图（ADR 0007 §2/§3/§5/§6/§7）。T-4：刻度、色带、条形、进度、里程碑、汇总条、
 * 依赖线（正交折线 + 类型箭头）**全部为 SVG**，不用 Canvas，也不做位图。
 *
 * ## 坐标口径（唯一）
 *
 * 图表窗格是原生滚动容器，SVG 与窗格可视区等大并固定在其中（`overflow: hidden`）。
 * **全部内容放在一个 `<g>` 里，用 `translate(−scrollLeft, −scrollTop)` 抵消滚动**——
 * 于是行与边直接使用 `ViewModel` 的内容坐标（`row.y`、`points`），不需要任何二次换算。
 * 这也让 `dayAtX` / `ordinalAtX` 保持自洽：SVG 的 x 轴就是内容坐标系。
 *
 * ## 元素模型与 `render-core` 的计数一一对应（**维护纪律**）
 *
 * `packages/render-core/src/count.ts` 的 `countElements()` 是元素预算判据的载体，
 * 它假定的发射模型是：
 * - 每渲染行 = `<g>` + 条/菱形（里程碑用 `<polygon>` 取代条）+ 进度 `<rect>`（进度已知才画）；
 * - 每条渲染边 = 折线 `<path>` + 箭头 `<polygon>` + **透明热区 `<path>`**（§5 要求，
 *   不得给可见图元加大热区）；
 * - 轴 = 色带 `<rect>` + 网格线 `<line>` + 标签 `<text>`。
 *
 * **改本模板必须同步 ADR 0007 §11 第 4 项的 `c₁`/`c₂`**（G5 若给行加交互热区，必须另加常数）。
 *
 * ## Vue 落地约束（T-1）
 *
 * 行与边都是 `v-for` + 稳定 `key`；`ViewModel` 已经裁剪过（渲染窗口），
 * 所以循环规模与文档总规模无关——这正是"元素数与规模解耦"在视图层的表现。
 */

import { computed } from 'vue';
import {
  arrowPolygons,
  emptyHighlight,
  type DragPreview,
  type GestureUpdate,
  type HighlightSet,
  type ViewModel,
} from '@ganttpilot/render-core';
const props = withDefaults(
  defineProps<{
    readonly view: ViewModel | null;
    readonly cycleMessage: string | null;
    /** 成环路径（`compute` 失败时非空）——用于提示文案。 */
    readonly cyclePath?: readonly string[];
    /** 成环路径的**可读标注**（`编号 名称`；不可排程态没有行/边可高亮，用列表代替）。 */
    readonly cycleLabels?: readonly string[];
    /** G5 的交互态高亮（成环 / 选中 / 冲突 / 建线端点）。 */
    readonly highlight?: HighlightSet;
    /** 建线预览（端点由 `render-core` 给出；折点在这里按 STUB 口径序列化）。 */
    readonly preview?: GestureUpdate['preview'];
    /** 冲突行（`anchorConflict` 的任务 id；判据来自引擎，ADR 0008 §6）。 */
    readonly conflictTaskIds?: readonly string[];
    /**
     * 拖动预览几何：`dragPreviewFor` 的产物，**与松手提交同源**（ADR 0008 §13）。
     *
     * 覆盖层画的是**结果**轮廓（`resize-duration` 拖动期条体本体不动，可见反馈靠它）。
     * `null` = 当前没有拖动，或该行不在渲染窗口内。
     */
    readonly dragPreview?: DragPreview | null;
  }>(),
  {
    cyclePath: () => [],
    cycleLabels: () => [],
    highlight: () => emptyHighlight(),
    preview: null,
    conflictTaskIds: () => [],
    dragPreview: null,
  },
);
type Edge = ViewModel['edges'][number];
type Row = ViewModel['rows'][number];

// ---------------------------------------------------------------- G5 覆盖层（元素计入 `c₄`）

/** 高亮命中的渲染行。 */
const highlightedRows = computed<Row[]>(() => {
  const view = props.view;
  if (view === null) return [];
  const wanted = new Set(props.highlight.rows);
  return view.rows.filter((row) => wanted.has(row.docIndex));
});

/** 高亮命中的渲染边。 */
const highlightedEdges = computed<Edge[]>(() => {
  const view = props.view;
  if (view === null) return [];
  const wanted = new Set(props.highlight.edges);
  return view.edges.filter((edge) => wanted.has(edge.linkIndex));
});


/** 冲突行（只画描边，不改条形填充——"条形 = 文档数据"这条语义不动）。 */
const conflictRows = computed<Row[]>(() => {
  const view = props.view;
  if (view === null || props.conflictTaskIds.length === 0) return [];
  const wanted = new Set(props.conflictTaskIds);
  return view.rows.filter((row) => wanted.has(row.id));
});

/**
 * 建线预览的正交路径：出端 → 竖直段 → 入端。
 *
 * STUB 用固定 8 px（与 `EDGE_STUB_PX` 同值、同样**不随 `pxPerDay` 缩放**）：
 * 预览只是"将从哪里连到哪里"的示意，真正的几何在提交后由 `routeEdge` 给出。
 */
const previewPath = computed(() => {
  const preview = props.preview;
  if (preview === null) return '';
  const [ex, ey] = preview.exitPoint;
  const [nx, ny] = preview.enterPoint;
  const midX = nx >= ex ? Math.min(ex + 8, Math.max(ex, nx)) : Math.max(ex - 8, Math.min(ex, nx));
  return `M${String(ex)} ${String(ey)}H${String(midX)}V${String(ny)}H${String(nx)}`;
});

/** 预览箭头：朝向由入端相对出端决定（+1 = +x）。 */
function previewArrowPoints(): string {
  const preview = props.preview;
  if (preview === null) return '';
  const [tipX, tipY] = preview.enterPoint;
  const dir: 1 | -1 = preview.enterPoint[0] >= preview.exitPoint[0] ? 1 : -1;
  const [origin, left, right] = arrowPolygons({ dir, fill: 'solid' }).outer;
  return [
    [tipX + origin[0], tipY + origin[1]],
    [tipX + left[0], tipY + left[1]],
    [tipX + right[0], tipY + right[1]],
  ]
    .map(([x, y]) => `${String(x)},${String(y)}`)
    .join(' ');
}

/** 预览线是否被预检判为成环（成环时用警示色、并在提示里给出路径）。 */
const previewCyclic = computed(() => props.preview?.cyclic === true);

/** 正交折线的 `d`（点列由 `render-core` 给出，这里只做序列化）。 */
function pathData(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${String(x)} ${String(y)}`).join('');
}

/** 箭头形态：填充由关系类型决定（`ARROW_FILL` 的口径，`render-core` 已声明）。 */
function arrowForm(edge: Edge): 'solid' | 'hollow' {
  return edge.type === 'SS' || edge.type === 'SF' ? 'hollow' : 'solid';
}

/**
 * 箭头多边形点串：几何来自 `render-core` 的 `arrowPolygons`（`apps/web` 与 G7 共用，
 * 不在这里重算），把"尖端在原点"的局部三角形平移到线的末点。
 */
function arrowPoints(edge: Edge): string {
  const tip = edge.points[edge.points.length - 1];
  if (tip === undefined) return '';
  const [origin, left, right] = arrowPolygons({ dir: edge.arrowDir, fill: arrowForm(edge) }).outer;
  return [
    [tip[0] + origin[0], tip[1] + origin[1]],
    [tip[0] + left[0], tip[1] + left[1]],
    [tip[0] + right[0], tip[1] + right[1]],
  ]
    .map(([x, y]) => `${String(x)},${String(y)}`)
    .join(' ');
}

function arrowFill(edge: Edge): string {
  if (edge.ignored) return '#c9ccd1';
  return arrowForm(edge) === 'hollow' ? '#ffffff' : '#475467';
}

/** 里程碑菱形的点串（中心与边长来自 `ViewModel`）。 */
function diamondPoints(row: Row): string {
  const milestone = row.milestone;
  if (milestone === null) return '';
  const half = milestone.size / 2;
  return [
    [milestone.cx, milestone.cy - half],
    [milestone.cx + half, milestone.cy],
    [milestone.cx, milestone.cy + half],
    [milestone.cx - half, milestone.cy],
  ]
    .map(([x, y]) => `${String(x)},${String(y)}`)
    .join(' ');
}

const scrollTransform = computed(() => {
  const view = props.view;
  if (view === null) return 'translate(0 0)';
  return `translate(${String(-view.scrollLeft)} ${String(-view.scrollTop)})`;
});
</script>

<template>
  <!-- 视口与窗格可视区等大；全部内容在一个 `<g>` 里抵消滚动 -->
  <svg
    v-if="view !== null"
    class="gantt-svg"
    :width="view.width"
    :height="view.height"
    :viewBox="`0 0 ${view.width} ${view.height}`"
    shape-rendering="crispEdges"
  >
    <g :transform="scrollTransform">
      <!-- 轴：非工作日色带 + 网格线 + 标签（水平窗口裁剪已在 render-core 完成） -->
      <g class="axis">
        <template
          v-for="(element, index) in view.axis"
          :key="`axis-${String(index)}`"
        >
          <rect
            v-if="element.kind === 'band'"
            :x="element.x"
            y="0"
            :width="element.width"
            :height="view.height"
            fill="#f4f6f8"
          />
          <line
            v-else-if="element.kind === 'gridline'"
            :x1="element.x"
            :x2="element.x"
            y1="0"
            :y2="view.height"
            stroke="#e4e7ec"
            stroke-width="1"
          />
          <text
            v-else
            :x="element.x + 2"
            y="12"
            font-size="10"
            fill="#667085"
          >{{ element.text }}</text>
        </template>
      </g>

      <!-- 行：条 / 进度 / 里程碑菱形 -->
      <g class="rows">
        <g
          v-for="row in view.rows"
          :key="`row-${row.id}`"
        >
          <polygon
            v-if="row.isMilestone"
            :points="diamondPoints(row)"
            fill="#ed7d31"
            stroke="#b1551a"
            stroke-width="1"
          />
          <template v-else>
            <rect
              :x="row.xLeft"
              :y="row.barY"
              :width="Math.max(1, row.xRight - row.xLeft)"
              :height="row.barHeight"
              :fill="row.kind === 'summary' ? '#7a8699' : '#2e75b6'"
              :rx="row.kind === 'summary' ? 0 : 2"
            />
            <rect
              v-if="row.hasProgress"
              :x="row.xLeft"
              :y="row.barY + 1"
              :width="Math.max(0, row.progressWidth)"
              :height="Math.max(0, row.barHeight - 2)"
              fill="#1f4e79"
            />
          </template>
        </g>
      </g>

      <!-- 依赖线：折线 + 箭头 + 透明热区 -->
      <g class="edges">
        <g
          v-for="edge in view.edges"
          :key="`edge-${edge.linkId}`"
        >
          <path
            :d="pathData(edge.points)"
            fill="none"
            :stroke="edge.ignored ? '#c9ccd1' : '#475467'"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <polygon
            :points="arrowPoints(edge)"
            :fill="arrowFill(edge)"
            :stroke="edge.ignored ? '#c9ccd1' : '#475467'"
            stroke-width="1"
          />
          <!-- ADR 0007 §5：交互热区必须独立，不得给可见图元加大热区 -->
          <path
            :d="pathData(edge.points)"
            fill="none"
            stroke="transparent"
            stroke-width="8"
          />
        </g>
      </g>

      <!--
        G5 覆盖层（元素数计入 `c₄`，ADR 0008 §11）：
        拖动轮廓 + 起止标记（取 `dragPreviewFor` 的**结果几何**，ADR 0008 §13）、建线预览、
        冲突描边、成环/选中高亮。
        **全部是独立图元**：不给可见条形/连线加大热区（ADR 0007 §5），也不改它们的填充。
      -->      <g class="overlays">
        <!--
          拖动预览：**结果轮廓**（`dragPreviewFor`，与松手提交同源，ADR 0008 §13）。
          轮廓 1 + 起止标记 2 = 3 个元素，`c₄` 与两路计数的口径不变。
        -->
        <template v-if="dragPreview !== null">
          <rect
            class="drag-outline"
            :x="dragPreview.xLeft - 3"
            :y="dragPreview.barY - 3"
            :width="Math.max(6, dragPreview.xRight - dragPreview.xLeft + 6)"
            :height="dragPreview.barHeight + 6"
            :rx="3"
          />
          <line
            class="drag-marker"
            :x1="dragPreview.xLeft"
            :x2="dragPreview.xLeft"
            :y1="dragPreview.y - 6"
            :y2="dragPreview.y + 6"
          />
          <line
            class="drag-marker"
            :x1="dragPreview.xRight"
            :x2="dragPreview.xRight"
            :y1="dragPreview.y - 6"
            :y2="dragPreview.y + 6"
          />
        </template>
        <!-- 冲突（`anchorConflict`）：只描边，不动填充 -->
        <rect
          v-for="row in conflictRows"
          :key="`conflict-${row.id}`"
          class="conflict-outline"
          :x="row.xLeft - 2"
          :y="row.barY - 2"
          :width="Math.max(4, row.xRight - row.xLeft + 4)"
          :height="row.barHeight + 4"
          :rx="2"
        />

        <!-- 高亮：成环路径的行与边 -->
        <rect
          v-for="row in highlightedRows"
          :key="`hl-row-${row.id}`"
          class="highlight-outline"
          :x="row.xLeft - 3"
          :y="row.barY - 3"
          :width="Math.max(6, row.xRight - row.xLeft + 6)"
          :height="row.barHeight + 6"
          :rx="2"
        />
        <path
          v-for="edge in highlightedEdges"
          :key="`hl-edge-${edge.linkId}`"
          class="highlight-edge"
          :d="pathData(edge.points)"
        />

        <!-- 建线预览：折线 + 箭头 -->
        <template v-if="preview !== null">
          <path
            class="preview-path"
            :class="{ cyclic: previewCyclic }"
            :d="previewPath"
          />
          <polygon
            class="preview-arrow"
            :class="{ cyclic: previewCyclic }"
            :points="previewArrowPoints()"
          />
        </template>
      </g>
    </g>
  </svg>

  <!-- 退化状态（ADR 0007 §7）：`compute` 失败时不画条形与连线，只渲染占位 -->
  <div
    v-else
    class="unschedulable"
  >
    <p>不可排程：{{ cycleMessage ?? '排程失败' }}</p>
    <template v-if="cycleLabels.length > 0">
      <p class="hint">
        成环路径（{{ cycleLabels.length }} 个节点）——「高亮成环路径」在不可排程态下的呈现方式：
      </p>
      <ol class="cycle-list">
        <li
          v-for="(label, index) in cycleLabels"
          :key="`cycle-${String(index)}`"
        >
          {{ label }}
        </li>
      </ol>
    </template>
    <p class="hint">
      （诊断清单见工具栏「诊断」；导入的成环边已由协议层按确定性顺序丢弃并进问题清单）
    </p>
  </div>
</template>

<style scoped>
.gantt-svg {
  /**
   * 与窗格可视区重合。
   *
   * `view.width/height` 取窗格的 `clientWidth/clientHeight`（**不含滚动条**），
   * 而 `left/top/right/bottom: 0` 让 SVG 铺满 `padding box`（含滚动条那条）。
   * 两者相差约 15 px——把这点差额让出去，图表右侧就不会露出空白；
   * 坐标映射（`dayAtX` 等）仍以 `scrollLeft` 为基准，不受这点宽度差影响。
   */
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  background: #ffffff;
}

/* 轴标签不参与命中，避免遮住边的热区 */
.axis text {
  pointer-events: none;
  user-select: none;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

/**
 * G5 覆盖层：**全部 `pointer-events: none`**。
 *
 * 理由：覆盖层是为"看得见"而存在的，若它参与命中，就会抢走条体/边的交互热区——
 * 那样"按住条拖动"会在有高亮时失效（ADR 0007 §5 的同一条纪律：不得给可见图元加大热区）。
 */
.overlays {
  pointer-events: none;
}

.drag-outline {
  fill: none;
  stroke: #175cd3;
  stroke-width: 2;
  stroke-dasharray: 4 2;
}

.drag-marker {
  stroke: #175cd3;
  stroke-width: 2;
}

.conflict-outline {
  fill: none;
  stroke: #b42318;
  stroke-width: 2;
}

.highlight-outline {
  fill: none;
  stroke: #b54708;
  stroke-width: 2;
  stroke-dasharray: 3 2;
}

.highlight-edge {
  fill: none;
  stroke: #b54708;
  stroke-width: 2.5;
  vector-effect: non-scaling-stroke;
}

.preview-path {
  fill: none;
  stroke: #175cd3;
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
  vector-effect: non-scaling-stroke;
}

.preview-arrow {
  fill: #175cd3;
  stroke: #175cd3;
  stroke-width: 1;
}

.preview-path.cyclic,
.preview-arrow.cyclic {
  stroke: #b42318;
  fill: #b42318;
}

.unschedulable {
  padding: 2rem;
  color: #b42318;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.hint {
  color: #667085;
  font-size: 0.85rem;
}

.cycle-list {
  max-height: 40vh;
  overflow: auto;
  margin: 0.25rem 0;
  padding-left: 1.5rem;
  color: #b42318;
  font-size: 0.85rem;
}
</style>
