<script setup lang="ts">
/**
 * 纯 SVG 甘特图（ADR 0007 §2/§3/§5/§6/§7）。T-4：刻度、色带、条形、进度、里程碑、汇总条、
 * 依赖线（正交折线 + 类型箭头）**全部为 SVG**，不用 Canvas，也不做位图。
 *
 * ## 坐标口径（唯一，ADR 0007 §14）
 *
 * 滚动容器（绘制区）在 `App.vue` 里是 `.chart-pane`，**SVG 是它的兄弟**（同在 `.chart-pane-wrap` 内），
 * 因此 SVG **不随内容滚动**——这一点是硬要求：SVG 若作为滚动容器的 abspos 子元素，
 * 会随内容一起滚，再叠加内层 `translate(−scrollLeft, −scrollTop)` 就是**双重偏移**
 * （图形区滚动比左表快一倍、下方留白、轴元素移出绘制区；P-23 诊断实测 = 机制③）。
 *
 * **全部内容放在一个 `<g>` 里，用 `translate(−scrollLeft, −scrollTop)` 抵消滚动**——
 * 于是行与边直接使用 `ViewModel` 的内容坐标（`row.y`、`points`），不需要任何二次换算。
 * 这也让 `dayAtX` / `ordinalAtX` 保持自洽：SVG 的 x 轴就是内容坐标系。
 *
 * **尺寸必须 1 用户单位 = 1 CSS px**：SVG 的盒子由上方的 `width`/`height` **属性**给出
 * （= `view.width/height` = 绘制区 `clientWidth/clientHeight`），CSS **不再**用 `inset: 0` 拉伸——
 * 盒与 `viewBox` 一旦不等，默认 `preserveAspectRatio` 会等比缩放 + 居中留白，
 * 让条形既偏 x 又偏 y（判据 `svgBoxAligned`）。
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
  drawnBarForRow,
  emptyHighlight,
  HEADER_HEIGHT_PX,
  rowHandlesFor,
  rowConnectVisibleAt,
  type AxisElement,
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
    /**
     * **当前指针所在的渲染行**（任务 id；`null` = 指针不在任何渲染行上）。
     *
     * 用途**只有一个**：让该行的连接点显形（ADR 0008 §16.2 的可见性，P-32 人工复验的订正）。
     * 命中判定不读它——那是纯几何（`barHitFor` / `connectSideAt`），
     * 因此"显示时机"与"能不能点中"是两件事，不会因为 hover 抖动而改变语义。
     */
    readonly hoverTaskId?: string | null;
    /** 指针的内容坐标 x（用于判断是否"靠近条端"）；`null` = 无指针。 */
    readonly hoverX?: number | null;
    /**
     * 是否正在**建线**（`GestureState.kind === 'linking'`）。
     *
     * 建线期间：① `hoverTaskId` 会跟着指针走（拖到哪一行、哪一行就显形），
     * 于是"可落点"在全图上**可见**（第五次人工复验的第 1 条：拖动时其他条体的连接点不显示）。
     */
    readonly linking?: boolean;
  }>(),
  {
    cyclePath: () => [],
    cycleLabels: () => [],
    highlight: () => emptyHighlight(),
    preview: null,
    conflictTaskIds: () => [],
    dragPreview: null,
    hoverTaskId: null,
    hoverX: null,
    linking: false,
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

/** 里程碑菱形的点串（中心与边长来自 `ViewModel` **或拖动预览**）。 */
function diamondPoints(milestone: { readonly cx: number; readonly cy: number; readonly size: number } | null): string {
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

/**
 * SVG 盒高 = **表头带 + 绘制区**（ADR 0007 §15）。盒与 `viewBox` 同时取它 ⇒ 1 用户单位 = 1 CSS px。
 */
const svgHeight = computed(() => (props.view === null ? 0 : props.view.height + HEADER_HEIGHT_PX));

/** 行 / 边 / 覆盖层的滚动抵消（内容坐标系 → 屏幕）；绘制区在 SVG 里的起点是 `HEADER_HEIGHT_PX`。 */
const scrollTransform = computed(() => {
  const view = props.view;
  if (view === null) return 'translate(0 0)';
  return `translate(${String(-view.scrollLeft)} ${String(HEADER_HEIGHT_PX - view.scrollTop)})`;
});

/**
 * **轴**住在**窗口坐标**里（`buildAxis` 已扣 `scrollLeft`、只发射视口内的元素，ADR 0007 §11.1 ③）。
 *
 * 两条硬约束（都由 P-24 的实测抓出，见 ADR 0007 §15）：
 * 1. 轴**不得**放进上面的内容滚动组——那会再叠一次 `−scrollLeft`（**横向双重偏移**；
 *    `scrollLeft = 0` 处不可见），右侧新滚出的区域因此没有任何网格线与灰度带；
 * 2. 色带与网格线要落在**绘制区**（`y = 0 .. height`）⇒ 整体下移 `HEADER_HEIGHT_PX`；
 *    日期标签要落在**表头带**里 ⇒ 标签组不偏移（`y` 取带内基线）。
 */
const axisBandsTransform = `translate(0 ${String(HEADER_HEIGHT_PX)})`;
const axisBands = computed<readonly AxisElement[]>(() =>
  props.view === null ? [] : props.view.axis.filter((element) => element.kind !== 'label'),
);
const axisLabels = computed<readonly Extract<AxisElement, { kind: 'label' }>[]>(() =>
  props.view === null ? [] : props.view.axis.filter((element): element is Extract<AxisElement, { kind: 'label' }> => element.kind === 'label'),
);

/**
 * 每行**要画的条**与**交互图元**（ADR 0008 §14/§16）：
 *
 * - 条：被拖行改用**预览结果几何**（§14／裁决 P-24），其余行用自身几何；
 * - 端点手柄与连接点：位置由 `rowHandlesFor` 从**判定区**派生（§16.1/§16.2），
 *   因此"看起来能抓的那一点"与"真的按判定区分类的那一点"是同一个数。
 *
 * 逐行预先算一次（而不是在模板里反复调用）：每帧每行一个对象，渲染窗口内最多几十个。
 */
const drawnRows = computed(() =>
  props.view === null
    ? []
    : props.view.rows.map((row) => ({
        row,
        drawn: drawnBarForRow(row, props.dragPreview),
        // `barY + barHeight / 2` = **条形/菱形的竖向中心**（`RowBox.y` 是**行顶**，不是条心——
        // 这正是第二次人工复验"突起仍在、连接点仍偏上"的根因）。
        handles: rowHandlesFor({
          taskId: row.id,
          bounds: row,
          rowHeight: props.view?.rowHeight ?? 0,
          barCenterY: row.barY + row.barHeight / 2,
        }),
        // 连接点**只在指针靠近该行条端时**发射（P-32 复验第 3.2 条：常显会画面杂乱）。
        // 手柄恒显（它是"可拖动区域"的暗示，且只占 2×4 px 的短竖线）。
        // 只有"指针就在这一行"时才继续判断"是否靠近条端"（`hoverX` 在两行之间漂移不会误显）。
        /**
         * 连接点显形规则（第五次人工复验第 1 条的订正）：
         *
         * - **拖动（`dragPreview` 非空）**：一律不显示。那时行画的是"结果几何"（§14），
         *   显示连接点会变成幽灵方块；
         * - **建线（`linking`）**：指针所在的**任意一行**都显示 ⇒ "可落点"在全图上可见
         *   （旧规则要求"指针靠近该行条端"，于是拖到别的条上时那一行什么都不显示）；
         * - **空闲**：只有"指针在该行且靠近条端"时才显示（避免满屏白框）。
         */
        connectVisible:
          props.dragPreview === null &&
          props.hoverTaskId === row.id &&
          (props.linking || (props.hoverX !== null && rowConnectVisibleAt(row, props.hoverX, true))),
      })),
);
</script>

<template>
  <!--
    SVG 覆盖**整列**（表头带 + 绘制区）：盒与 `viewBox` 同时取 `svgHeight` ⇒ 1 用户单位 = 1 CSS px。
    表头带的底色/边框仍由 `App.vue` 的 `.chart-header` 出（本 SVG 背景透明），日期刻度画在带内。
  -->
  <svg
    v-if="view !== null"
    class="gantt-svg"
    :width="view.width"
    :height="svgHeight"
    :viewBox="`0 0 ${view.width} ${svgHeight}`"
    shape-rendering="crispEdges"
  >
    <!-- 轴（窗口坐标）：色带 + 网格线落在**绘制区**（下移一个表头带） -->
    <g
      class="axis"
      :transform="axisBandsTransform"
    >
      <template
        v-for="element in axisBands"
        :key="`axis-band-${String(element.x)}`"
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
          v-else
          :x1="element.x"
          :x2="element.x"
          y1="0"
          :y2="view.height"
          stroke="#e4e7ec"
          stroke-width="1"
        />
      </template>
    </g>

    <!-- 日期刻度：画在**表头带**内（0 .. HEADER_HEIGHT_PX），不侵入第一行的条形区 -->
    <g class="axis-labels">
      <text
        v-for="element in axisLabels"
        :key="`axis-label-${String(element.x)}`"
        :x="element.x + 2"
        y="18"
        font-size="10"
        fill="#667085"
      >{{ element.text }}</text>
    </g>

    <!-- 内容坐标系（行 / 边 / 覆盖层）：抵消滚动，绘制区起点 = HEADER_HEIGHT_PX -->
    <g :transform="scrollTransform">
      <!-- 行：条 / 进度 / 里程碑菱形（被拖行画的是**预览结果几何**，ADR 0008 §14） -->
      <g class="rows">
        <g
          v-for="item in drawnRows"
          :key="`row-${item.row.id}`"
          :data-task-id="item.row.id"
        >
          <!--
            **交互图元画在条/菱形之前**（否则方块跨进条内的那 2 px 会被条盖住）——
            第三次人工复验把连接点改成"跨在条端上"，因此顺序有了语义。
            端点手柄（ADR 0008 §16.2／P-32 的 R3）：x = **判定区边界**（`zones.edgeL.x2` / `zones.edgeR.x1`），
            因此它同时是"可拖动区域的视觉暗示"与"判定区本身"。全部 `pointer-events: none`：
            命中判定走几何（`barHitFor` / `zonesFor`），不靠 DOM。
            **把"第一个 rect"当条形是错的**——本行有 `.bar` / `.bar-progress` / `.connect-point` 多个 rect；
            记录制与诊断一律用 `rect.bar`（P-32 落地时当场修过两处）。
          -->
          <line
            v-for="handle in item.drawn.fromPreview ? [] : item.handles.handles"
            :key="`handle-${String(item.row.id)}-${handle.side}`"
            class="handle"
            :x1="handle.x"
            :x2="handle.x"
            :y1="handle.y1"
            :y2="handle.y2"
          />

          <!--
            连接点（§16.3 的建线起手位置）：**跨在条端上的圆**——命中盒从条端内 2 px 起、向外一个边长
            （`CONNECT_INSET_PX` / `CONNECT_SIZE_PX`），可见的圆**直径略小于条高**且 ≤ 命中盒边长
            （P-42 批次③的人工裁决：原来的"与条体等高的正方形白框"改成圆圈）。
            圆心 = 命中盒中点 + 条心 ⇒ 与 P-32 的三条不变量同源；命中区一字未改。
            只在指针靠近该行条端时发射（§16.7 第二次复验的第 3.2 条）。
          -->
          <circle
            v-for="point in item.connectVisible ? item.handles.connectPoints : []"
            :key="`connect-${String(item.row.id)}-${point.side}`"
            class="connect-point"
            :cx="point.x + point.size / 2"
            :cy="point.y"
            :r="point.diameter / 2"
          />
          <polygon
            v-if="item.drawn.isMilestone"
            class="milestone"
            :points="diamondPoints(item.drawn.milestone)"
            fill="#ed7d31"
            stroke="#b1551a"
            stroke-width="1"
          />
          <template v-else>
            <rect
              class="bar"
              :x="item.drawn.xLeft"
              :y="item.drawn.barY"
              :width="Math.max(1, item.drawn.xRight - item.drawn.xLeft)"
              :height="item.drawn.barHeight"
              :fill="item.row.kind === 'summary' ? '#7a8699' : '#2e75b6'"
              :rx="item.row.kind === 'summary' ? 0 : 2"
            />
            <rect
              v-if="item.row.hasProgress"
              class="bar-progress"
              :x="item.drawn.xLeft"
              :y="item.drawn.barY + 1"
              :width="Math.max(0, (item.drawn.xRight - item.drawn.xLeft) * item.row.progressRatio)"
              :height="Math.max(0, item.drawn.barHeight - 2)"
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
   * 覆盖**整列**：定位祖先是 `.chart-column`（表头带 + 绘制区），因此 `top: 0` 就是表头带顶。
   *
   * 尺寸**只由 `width`/`height` 属性决定**（`view.width` × `svgHeight = view.height + 表头带`），
   * 这里刻意**不写** `right`/`bottom`/`width`/`height`：
   * `inset: 0` 会把盒子撑到定位祖先的 padding box（比客户区多出滚动条那 15 px），
   * 与 `viewBox` 不等 ⇒ 默认 `preserveAspectRatio` 等比缩放 + 居中留白，行与条形一起偏
   * （判据 `align.ts` 的 `svg-box-not-1to1`）。让出去的那 15 px 落在窗格自己的滚动条上，
   * 两处底色都是白，视觉无差。
   *
   * **背景必须透明**：表头带的底色/边框由 `.chart-header` 出、绘制区的白底由 `.chart-pane` 出；
   * 本 SVG 只在它们之上画图元（含画在表头带内的日期刻度）。
   *
   * `pointer-events: none`：SVG 覆盖在滚动容器**之上**，若参与命中就会抢走条体/边的交互热区。
   * 命中判定走几何（`barHitFor`），不靠 DOM 事件目标。
   */
  position: absolute;
  left: 0;
  top: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 轴标签不参与命中，避免遮住边的热区（`.axis` 的色带/网格线 + `.axis-labels` 的刻度文本） */
/**
 * 端点手柄（ADR 0008 §16.2／裁决 P-32 的 R3）：画在**判定区边界**上，竖向居中。
 * 它是"可拖动区域的视觉暗示"，也是"判定区本身"——不是第二个真相源。
 * 视觉宽由 `HANDLE_WIDTH_PX` 的口径给出（`stroke-width`），与判定区宽度**无关**。
 */
.handle {
  stroke: #175cd3;
  stroke-width: 2;
  stroke-linecap: round;
  pointer-events: none;
}

/**
 * 连接点（ADR 0008 §16.3／**P-42 批次③**）：**跨在条端上的圆**，直径略小于条高、且 ≤ 命中盒边长
 * （`connectDiameterFor`）；白底 + 蓝描边，与端点手柄同色系但形状不同（圆 ↔ 短竖线）。
 * 光标由窗格承担（`App.vue` 的 `paneCursor` ⇒ `cursor: crosshair`）。
 */
.connect-point {
  fill: #ffffff;
  stroke: #175cd3;
  stroke-width: 1;
  pointer-events: none;
}

/* 轴标签不参与命中，避免遮住边的热区（`.axis` 的色带/网格线 + `.axis-labels` 的刻度文本） */
.axis text,
.axis-labels text {
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
  /* 退化占位现在是滚动容器的**兄弟**（覆盖层），因此自己负责铺满绘制区。 */
  position: absolute;
  inset: 0;
  overflow: auto;
  padding: 2rem;
  background: #ffffff;
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
