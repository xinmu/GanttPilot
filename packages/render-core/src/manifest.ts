/**
 * `@ganttpilot/render-core` 的**常量与判据唯一声明处**（ADR 0007 §11 的数值落地）。
 *
 * 为什么常量与判据放在同一个文件：ADR 0007 §11 的七项回填值**不是选的，而是判据推出来的**
 * （G4-S 的 `scale-params.mjs` 逐候选求值后取"通过全部判据的最小/最大者"）。把它们与判据一起声明，
 * "改了常量却忘了改判据"就会由 `evaluateScaleCriteria().consistent` 当场报出来。
 *
 * 本文件同时是**渲染层与 G7 导出投影共享常量**的载体：两处都从这里取值，
 * 不各自抄一份（ADR 0007 §2 的"双投影共享几何"）。
 *
 * 契约出处：`docs/02-adr/0007-渲染几何与裁剪契约.md` §3 / §5 / §6 / §11；
 * 实测出处：`spikes/g0-s4-svg-clipping/结论.md`（该目录已随 G4 落地删除，数字转入本包 spec）。
 */

/** 刻度档位（季刻度延后，ADR 0007 §3）。 */
export type ZoomKey = 'day' | 'week' | 'month';

/** 档位顺序（日 / 周 / 月）。 */
export const ZOOM_ORDER = ['day', 'week', 'month'] as const;

/**
 * `pxPerDay` 三档（ADR 0007 §11 第 1 项：**日 24 / 周 8 / 月 3**）。
 *
 * 选取规则：① 日档下 1 工作日的条宽（= `pxPerDay`）≥ {@link THRESHOLDS.minBarWidthPx}；
 * ② 刻度间距 ≥ 标签宽度估算 + 2 px；③ 回绕走廊可容（`pxPerDay × AXIS_LEFT_GUTTER_DAYS ≥ stub + wrap`）；
 * **取通过全部判据的最小候选**。档位切换是**离散**的：只改 `pxPerDay` 与表头分组，
 * **不改变任何序号 ↔ 日期的对应**。
 */
export const ZOOM_PX_PER_DAY: Readonly<Record<ZoomKey, number>> = { day: 24, week: 8, month: 3 };

/** 每档位的刻度单位（自然日）与标签格式——可读性判据的输入，也是轴的输入。 */
export const ZOOM_UNIT_DAYS: Readonly<Record<ZoomKey, number>> = { day: 1, week: 7, month: 30 };

/** 轴标签形态：日档 `DD`、周档 `MM-DD`（取周一）、月档 `YYYY-MM`（取 1 日）。 */
export const ZOOM_LABEL_FORMAT: Readonly<Record<ZoomKey, { readonly label: string; readonly chars: number }>> = {
  day: { label: '日（DD）', chars: 2 },
  week: { label: '周（MM-DD，取周一）', chars: 5 },
  month: { label: '月（YYYY-MM，取 1 日）', chars: 7 },
};

/** 档位标签（界面显示用）。 */
export const ZOOM_LABEL: Readonly<Record<ZoomKey, string>> = { day: '日', week: '周', month: '月' };

/** 标签宽度估算：字符宽 + 内边距（判据②用；不引入字体度量依赖）。 */
export const LABEL_CHAR_PX = 6;
export const LABEL_PADDING_PX = 2;

/** 档位 → `pxPerDay`。 */
export function zoomPxPerDay(zoom: ZoomKey): number {
  return ZOOM_PX_PER_DAY[zoom];
}

// ---------------------------------------------------------------- 视口与行模型

/** 固定行高（虚拟化的前提；ADR 0007 §4）。 */
export const ROW_HEIGHT = 24;

/**
 * 渲染窗口在可见行上下各留的缓冲行数（ADR 0007 §6.1）。
 *
 * 选取规则：**取满足判据的最小候选**——缓冲的唯一作用是遮住"滚动事件到下一帧重绘"之间的空白，
 * 故必须 ≥ 一次滚轮档位跨过的行数 `ceil(WHEEL_NOTCH_PX / ROW_HEIGHT)`。
 */
export const ROW_BUFFER = 5;

/** 一次滚轮档位在 Windows 上的典型像素跨度（解析判据的输入）。 */
export const WHEEL_NOTCH_PX = 100;

/**
 * 两栏**表头带**的外高（px）。ADR 0007 §14（裁决 P-23）；**两级刻度起上调**（P-46 增补 §3）。
 *
 * 它不是"由判据推出的数值"——它的**判据是"两栏表头外高实测相等"**（左表表头与图表表头带同高），
 * 由 {@link diagnoseRowAlignment} 的 `headerAligned` 与
 * `node scripts/measure-render.mjs --align` 的记录制证据守住。
 *
 * **28 → 40 的来历**：刻度行按 [ADR 0007 附录 §3](../../docs/02-adr/附录/0007-增补.md) 改为**两级**，
 * 带内因此要容下**两行文本**（下级刻度在上、上级分段带的标签在下）。40 px 的分配是
 * "上 0–20 px 归下级标签、下 20–40 px 归上级标签（基线 33）"，两行各留出 10 px 字号的余量；
 * 它是一个**视觉取值**（判据只要求两栏相等、且刻度文本整体落在带内）。
 *
 * 用途（**唯一来源**）：`TaskTable.vue` 的表头与表体高、`App.vue` 的图表表头带、`useChart` 的
 * `columnHeight`。两栏因此共享同一条行屏幕几何
 * `列顶 + HEADER_HEIGHT_PX + row × ROW_HEIGHT − scrollTop`（ADR 0007 §14）。
 *
 * **不进元素预算**：它是 HTML 布局的一部分，不产生任何 SVG 元素（`c₁`/`c₂`/`c₃`/`c₄` 都不动）。
 * 两栏都必须 `box-sizing: border-box`——否则"40 + 1 px 边框"与"−40"会差 1 px。
 */
export const HEADER_HEIGHT_PX = 40;

/**
 * 上级刻度（分段带）与悬停行带的两条**颜色**常量（P-46 §2.2／§3）。
 *
 * 两条都必须与既有色系**区分开**，否则判据（与）目视都会失效：
 *
 * | 用途 | 值 | 为什么不是别的 |
 * |---|---|---|
 * | 上级分段带 | `#eef1f5` | 与**周末/假日色带** `#f4f6f8` 区分——否则"周末"与"上级段"混为一色（P-37 的"背景层先注入"同口径） |
 * | 上级段边线 | `#d0d5dd` | 与**网格线** `#e4e7ec` 区分：上级段的边界是"月的边界"，比网格线更醒目 |
 * | 悬停行带 | `#e8f1fb` | 浅蓝（与条体 `#2e75b6` 同色系、但远浅）；与上面两条灰/蓝灰**都**不同 |
 *
 * 三处一律从这里取值：屏幕 SVG（`GanttChart.vue`）、导出 SVG（`svgExport.ts`）、左表 CSS
 * （`TaskTable.vue` 的 `.row:hover` 需要同值，写在 CSS 里但注释指向本常量）。
 */
export const AXIS_MAJOR_FILL = '#eef1f5';
export const AXIS_MAJOR_EDGE = '#d0d5dd';
export const HOVER_ROW_FILL = '#e8f1fb';

/**
 * 两级刻度的**文本基线**（表头带内的 y，px；**屏幕 SVG 与导出 SVG 共用同值**）。
 *
 * 两级刻度是"一个带子里的两行文本"，因此基线必须有单点声明——否则屏幕画在上半、
 * 导出画在下半，"所见 = 所导出"当场破裂（三者同源是 ADR 0007 §2 的铁律）。
 *
 * 与 `HEADER_HEIGHT_PX = 40` 的关系：上级段是带内**下半**的主体（基线 33，字号 10），
 * 下级标签在**上半**（基线 17）。两者间距 16 px > 字号，因此不重叠。
 */
export const MINOR_LABEL_BASELINE_PX = 17;
export const MAJOR_LABEL_BASELINE_PX = 33;

/**
 * 轴线左侧留白（**天数**，不是像素）——SS/SF"左出回绕"走线的空间（ADR 0007 §3）。
 *
 * 由回绕走廊反推：`ceil((EDGE_STUB_PX + EDGE_WRAP_PX + 4) / min(pxPerDay))` = `ceil(24 / 3)` = **8 天**。
 * **代价（已实测记录）**：日档下 8 天 = 192 px 的左侧空白，占 1280 px 视口的 15%。
 * 这是"gutter 以天数表达"这一 §3 口径的固有代价；改成本档位推导属**语义变更**（须另立 ADR）。
 */
export const AXIS_LEFT_GUTTER_DAYS = 8;

/**
 * 内容坐标系右侧的**固定留白**（px）。ADR 0007 §15（裁决 P-24）。
 *
 * 为什么需要它：内容的横向范围由 `ViewModel.contentWidth` 给出（= 最末任务右缘 + 引出段 + 回绕走廊 + 本值），
 * 它是**滚动范围**（spacer 宽）的真相源——范围给少了，用户就滚不到项目末端
 * （P-24 实测：旧式"按窗格宽推导"的公式在 1,000 任务夹具上只给到约 61 天）。
 * 留白保证最末任务之后还有可滚的余地，并容下依赖线的引出段与回绕走廊。
 */
export const CONTENT_RIGHT_PAD_PX = 32;

/** 行高候选（判据复推用）。 */
export const ROW_HEIGHT_CANDIDATES = [20, 24, 28] as const;

/** 判据④：固定视口下至少要能同时看到多少行（决定行高上限）。 */
export const MIN_VISIBLE_ROWS = 26;

/** 缓冲行候选（判据复推用）。 */
export const ROW_BUFFER_CANDIDATES = [2, 5, 10] as const;

// ---------------------------------------------------------------- 依赖线路由

/**
 * 出端水平 stub 的固定像素长度（ADR 0007 §5 / §11 第 3 项：**8 px**）。
 *
 * **不随 `pxPerDay` 缩放**：以免缩放时折点跳变，并让 G7 在给定 `pxPerDay` 下拿到同一几何。
 */
export const EDGE_STUB_PX = 8;

/** 回绕时竖直段的额外左移量（ADR 0007 §11 第 3 项：**12 px**）。 */
export const EDGE_WRAP_PX = 12;

/** 折点候选（判据复推用）。 */
export const EDGE_STUB_CANDIDATES = [6, 8, 10, 12] as const;
export const EDGE_WRAP_CANDIDATES = [8, 12, 16] as const;

/**
 * 呈现常量（ADR 0007 §11 第 6 项）。
 *
 * 元素预算刻意保持"每行 3 / 每边 3"：**汇总条不加端帽**（加了就要把它算进 `c₁`）。
 * 箭头半宽由**长度**按比例推出，不是由行高直接推——否则"长 12 px、半宽 14.4 px"会得到
 * 一个比行还高的箭头（G4-S 第一版即如此，已订正）。
 */
export const SPACING = {
  /** 条高 = 行高 × 该比例，垂直居中。 */
  barHeightRatio: 0.6,
  /** 里程碑菱形边长 = 行高 × 该比例。 */
  milestoneSizeRatio: 0.5,
  /** 汇总条高 = 行高 × 该比例（比叶子条细，这是汇总行的视觉约定）。 */
  summaryBarHeightRatio: 0.35,
  /** 箭头长度 = 行高 × 该比例。 */
  arrowLengthRatio: 0.5,
  /** 箭头半宽 = 箭头长度 × 该比例。 */
  arrowHalfWidthRatio: 0.6,
  /** 空心箭头内缩比例（外三角缩向重心）。 */
  hollowInnerRatio: 0.45,
  /** 进度填充相对条形的上下内缩（px）。 */
  progressInsetPx: 1,
} as const;

/**
 * 4 类关系的箭头**填充**（ADR 0007 §11 第 3 项）。
 *
 * 可区分性由"填充（实心/空心）× 朝向（+x/−x）"承担；**朝向由 P-8 第 1 条的入边侧决定**，
 * 不由关系直接指定，因此本表只声明填充。
 */
export const ARROW_FILL: Readonly<Record<string, 'solid' | 'hollow'>> = {
  FS: 'solid',
  FF: 'solid',
  SS: 'hollow',
  SF: 'hollow',
};

/** 箭头可区分性光栅化的采样参数（1 CSS px 网格 + 四周留白）。 */
export const ARROW_RASTER = { paddingPx: 1 } as const;

// ---------------------------------------------------------------- 元素模型与预算

/**
 * 元素模型（ADR 0007 §6.7 的 `c₁` / `c₂` 来源）。
 *
 * - 每渲染行 ≤ **3**：`<g>` + 条 `<rect>` + 进度 `<rect>`（里程碑行为 `<g>` + `<polygon>` = 2；
 *   进度未知或汇总进度为 `NaN` 时不画填充 ⇒ 实际 ≤ 3）；
 * - 每条渲染边 = **3**：折线 `<path>` + 箭头 `<polygon>` + §5 要求的**透明热区 `<path>`**；
 * - `c₃`（轴与刻度）按档位各一个常数，只随"视口宽 ÷ `pxPerDay`"变化，
 *   **与文档总规模无关**——这正是"与规模解耦"判据的被测对象；
 * - 轴的**水平窗口裁剪**（ADR 0007 §11.1 ③）是 `c₃` 与文档规模无关的前提。
 */
export const ELEMENT_MODEL = { perRenderedRow: 3, perRenderedEdge: 3 } as const;

// ---------------------------------------------------------------- G5 交互常量（ADR 0008 §5/§11）

/**
 * 判定区宽度（px）：指针落在条的左右端 `DRAG_EDGE_PX` 内即"改开始 / 改工期"，其余为"整体移动"
 * （ADR 0008 §5 的表）。取值与 `EDGE_STUB_PX`（8）同阶但**更小**：判定区压住折点引出段即可，
 * 过大只会让"整体移动"（最常用的语义）变难命中。
 */
export const DRAG_EDGE_PX = 6;

/**
 * 命中条体的容差（px）：指针必须落在条体包围盒 ± 本值内，否则**不产生手势**（ADR 0008 §13）。
 *
 * 为什么需要它：判定区（`DRAG_EDGE_PX`）的前提是"指针落在条体上"，
 * 而 P-21 的人工复核证实实现里**没有这一道**——同一行的空白处按下会按 `dragModeFor` 落到
 * `resize-start`/`resize-duration`，于是"条体左侧空白点击改开始、右侧空白点击工期翻倍"。
 *
 * 取值：与 `DRAG_EDGE_PX` 同阶但**更小**。它只用来补 1–2 px 的手抖，
 * **不改变判定区本身**（判定区仍在条体内部按 `DRAG_EDGE_PX` 分三档）。
 */
export const HIT_TOLERANCE_PX = 2;

/**
 * `move` 判定区的**最小宽度**（px）——ADR 0008 §16.1（裁决 P-32）。
 *
 * 为什么需要它：`DRAG_EDGE_PX = 6` 是**上界**而不是定值。条宽 < 12 px 时若两端各占 6 px，
 * `move` 区就是**空集**（`P-22` 遗留 3：月档 `pxPerDay = 3`，1 个工作日的条只有 3 px）。
 * "整体移动"是三条语义里最常用的，让它永远存在优先于让端点区永远够宽。
 *
 * 公式（唯一实现处 = `interaction.ts` 的 `zonesFor`）：
 * ```
 * halfGap = max(0, (条宽 − MIN_MOVE_ZONE_PX) / 2)
 * edgePx  = min(DRAG_EDGE_PX, halfGap)
 * ```
 * 条宽 ≥ 18 px 时 `edgePx = DRAG_EDGE_PX = 6` ⇒ **宽条行为与 P-32 之前逐值相同**。
 */
export const MIN_MOVE_ZONE_PX = 6;

/**
 * 端点手柄的**视觉**尺寸（px）——ADR 0008 §16.2（裁决 P-32）。
 *
 * 手柄画在**判定区边界**上（`zones.edgeL.end` / `zones.edgeR.start`），不是条的两端：
 * 这样"看起来能抓的那一点"与"真的按判定区分类的那一点"是同一个数，
 * 于是窄条上两端退化成同一处也**如实可见**（ADR 0008 §16.2 的理由）。
 *
 * **高必须小于条高**（`ROW_HEIGHT × SPACING.barHeightRatio = 24 × 0.6 = 14.4`）：
 * 它是**条上**的一段短竖线，不是"从条里长出来的尖角"——P-32 的人工复验（2026-10-04）
 * 报的第一条视觉问题是"条体两端各有一向上的突出"（初值 8 与里程碑菱形同高、
 * 视觉上越过了条体的上沿），因此取值改为 **4**（并对"汇总条 8.4 px 高"也仍然成立）。
 */
export const HANDLE_WIDTH_PX = 2;
export const HANDLE_HEIGHT_PX = 4;

/**
 * 连接点的边长（px）——ADR 0008 §16.2/§16.3（裁决 P-32，**尺寸由第三次人工复验回填**）。
 *
 * **位置规则**：连接点**跨在条端上**——右点 = `[xRight − CONNECT_INSET_PX, xRight + CONNECT_SIZE_PX − CONNECT_INSET_PX]`
 * （x 属性 = `xRight − CONNECT_INSET_PX`），左点镜像。这样它既"长在条端上"（视觉上相连、居中），
 * 又**命中区 ⊇ 可见方块**（判据 §16.7 第三次复验）。
 *
 * 为什么是 12 而不是 8：8 px + 只向外补 2 px 的容差 ⇒ 命中区只有 14 px 宽，
 * 而"从连接点按下并拖出线"需要**按住**再拖——手抖 3–4 px 就落空（第三次复验："仍不可通过拖动连接点来拉线"，
 * 实测条端右侧 `dx = -1..+2` 全部落空）。12 px 的方块 + 外侧 4 px 容差把可用宽度提到 20 px。
 */
export const CONNECT_SIZE_PX = 12;

/**
 * 连接点**跨进条形内部**的像素数（px）：方块从 `xRight − CONNECT_INSET_PX` 起画。
 *
 * 取 2 px 的理由：① 视觉上"挂在条端"而不是浮在条外；② 与端点判定区（`DRAG_EDGE_PX = 6`）的
 * 重叠只有 2 px ⇒ "改工期"的拖动手感不受影响。
 */
export const CONNECT_INSET_PX = 2;

/**
 * 连接点命中区在**方块之外**额外补的容差（px）。
 *
 * 与 `HIT_TOLERANCE_PX`（补手抖、判"是否落在条体上"）分工不同：本值是"按住连接点"的宽容度，
 * 只在方块的**外侧**计算（内侧留给 `CONNECT_INSET_PX`，不再多占端点判定区）。
 */
export const CONNECT_HIT_PAD_PX = 4;

/**
 * 连接点的**视觉直径**相对条高的内缩（每侧，px）——P-42 批次③的人工裁决。
 *
 * `diameter = min(CONNECT_SIZE_PX, barHeight − 2 × 本值)`，下限见 {@link CONNECT_MIN_DIAMETER_PX}。
 *
 * **为什么改**：连接点原来是"与条体等高的**正方形白框**"，在 1,000 任务的画面里与条体抢注意力
 * （P-32 的"常显杂乱"是同一条线索）；批次③把它改成**圆圈**、直径**略小于条高** ——
 * 视觉上像挂在条端的一颗"铆钉"。三条不变量必须同时保住（否则会重演 P-32 的"看得见却点不中"）：
 * ① 圆心仍在条端的**命中盒中点**上（跨在条端上）；② 圆心竖向 = **条心**；③ **可见 ⊆ 命中盒**
 * （因此直径上限是 `CONNECT_SIZE_PX`）。命中区与判定区**一字未改**（它本来就只按 x 判定）。
 */
export const CONNECT_DIAMETER_GAP_PX = 1;

/** 连接点视觉直径的下限（px）：汇总条（条高 8.4）与里程碑（菱形 12）上也不能小到看不见。 */
export const CONNECT_MIN_DIAMETER_PX = 6;

/**
 * 连接点的**显示时机**：指针与条端的距离在 `HIT_TOLERANCE_PX × N` 内才显示
 * （ADR 0008 §16.2 的可见性，由 P-32 的人工复验修订）。
 *
 * 为什么：初版**常显**，1,000 任务下 32 个渲染行 = 64 个白框，画面杂乱
 * （复验第 3.2 条）。改为一行的连接点在**指针靠近该行的条端**时出现、移开即消失。
 * 只改"何时发射"，**命中区与起手语义一字不变**（`connectSideAt` 仍然按条端 ± 容差判定）。
 */
export const CONNECT_REVEAL_FACTOR = 2;

/**
 * G5 每帧/每渲染行新增元素的常数（ADR 0008 §11，**由 §16.4 修订**／裁决 P-32）。
 *
 * `c₄` 现在是**两部分**（§11 原文的"每帧固定开销"这句由 §16.4 取代）：
 *
 * | 项 | 值 | 何时发射 |
 * |---|---|---|
 * | `perRenderedRow` | **6** | **每渲染行**：条/菱形 1 + 进度 1 + 端点手柄 2（仅非汇总、非里程碑）+ 连接点 2 |
 * | `overlay` | **13** | **每帧固定**：拖动轮廓（1）+ 起止标记（2）+ 建线预览（2）+ 冲突描边（1）+ 成环/选中高亮（≤ 6）+ **悬停行带（1，P-46）** |
 *
 * 于是预算写成（与 `count.ts` 同式）：
 *
 * ```
 * #elements ≤ (c₁ + perRenderedRow)·rows + c₂·edges + c₃ + overlay
 * c₄(rows)  = perRenderedRow · rows + overlay = 6 · rows + 13
 * ```
 *
 * **`overlay = 13` 的来历**（P-46 §2.2 的预算登记）：指针所在整行的**浅色行带是 1 个覆盖层元素**
 * （`buildAxis` 的 `hover-band`，画在窗口坐标、不随内容滚动）。它是**每帧固定开销**，
 * 因此进的是 `overlay` 而不是 `perRenderedRow`——**不得**在 `drawnRows` 的逐行模板里加 `rect`
 * （那会把它塞进逐行 diff 路径，并与"每帧固定开销"的口径打架）。左表那半是**纯 CSS `:hover`**，
 * 零 SVG 元素、不进预算。
 *
 * **`perRenderedRow = 6` 的来历**（不是估的，是逐类点位相加的上界）：最"胖"的行是**有进度的叶子**——
 * 条 `<rect>` 1 + 进度 `<rect>` 1 + 端点手柄 `<line>` 2 + 连接点 `<rect>` 2 = **6**；
 * 汇总行 1 + 2 = 3、里程碑行 1 + 2 = 3、无进度叶子 1 + 2 + 2 = 5，都在这条上界之下。
 *
 * **"与文档总规模无关"这条性质不变**：`rows ≤ 视口行数 + ROW_BUFFER`（ADR 0007 §6.1），
 * 10× 规模跨度下 `rows` 不变 ⇒ 元素总数仍与规模解耦（`S4-a` 的判据口径不变）。
 *
 * **维护纪律**：改 `GanttChart.vue` 的覆盖层/手柄模板必须同步这里的常数，
 * 并让 `countElements` 与 `countElementsByEnumeration` 继续逐项相等；
 * **负向对照**：把 `perRenderedRow` 改回 `0` 时，`apps/web` 的 DOM 互证必须报
 * 「实际 DOM 与元素模型不一致」（这正是"计数不是恒真式"的证据）；把 `overlay` 改回 `12`
 * 时，两路计数必须报"悬停行带没有被计入"（P-46 的 `hoverRow` 项）。
 */
export const ELEMENT_MODEL_G5 = { perRenderedRow: 6, overlay: 13 } as const;

/** 视口默认值（测量口径的一部分：换视口必须重新登记数字）。 */
export const VIEWPORT_DEFAULT = {
  width: 1280,
  height: 640,
  rowHeight: ROW_HEIGHT,
  rowBuffer: ROW_BUFFER,
  scrollTop: 0,
  scrollLeft: 0,
} as const;

// ---------------------------------------------------------------- 判据阈值

/**
 * 判据阈值。**单点声明**：任何"让测试变绿"的调整都必须改这里，因而必然留下 diff。
 *
 * `c₃` 的逐档位锚值（116 / 70 / 89，两级刻度前的单级口径）不在这里——它是**视口与夹具的函数**，
 * 由 spec 断言（与 `clipping.spec.ts` 的实测锚对齐），不是手选常量。
 * **两级刻度（P-46）后 `c₃` 同轮重锚**：见 `clipping.spec.ts` 的 `expectedC3`（本节不重复登记数值）。
 */
export const THRESHOLDS = {
  /** S4-d：4 类箭头两两光栅化 Jaccard 距离的下限。 */
  arrowMinJaccard: 0.15,
  /** S4-d：折点随 `pxPerDay` 的漂移上限（只允许取整噪声）。 */
  foldMaxDeltaPx: 1,
  /** 折点扫描的 `pxPerDay` 细扫序列。 */
  foldSweepPxPerDay: [4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 56, 80] as readonly number[],
  /** NC2：关掉窗口裁剪后，最大/最小规模文档的元素数比值必须超过它。 */
  nc2GrowthRatio: 5,
  /**
   * S4-a：**窗口路径**的元素数在 10× 规模跨度（200 → 2,000 任务）上的增长比上限。
   *
   * 与 `nc2GrowthRatio` 必须拉开数量级，否则判据没有判别力：窗口路径 ≈ 1.0×，
   * 关掉窗口裁剪 ≈ 10.7×（G4-S 实测）。
   */
  windowedGrowthRatio: 1.5,
  /** S4-b：**每个**声明滚动位置至少要丢的跨屏长边条数。 */
  minCrossScreenLossPerPosition: 1,
  /** S4-b：全部声明位置合计至少丢的条数。 */
  totalCrossScreenLoss: 5,
  /** 首屏（含依赖线的首帧）预算（原文口径：1,000 任务 ≤1s）。 */
  firstScreenMs: 1000,
  /** 与《评估报告》§5.4 反例的同尺对照值（2,200 边 / 10× 滚动约 2.0s）。 */
  scrollReferenceMs: 2000,
  /** 帧预算（记录制候选）：主线程 p95。 */
  frameBudgetP95Ms: 16.7,
  /** 刻度档位可读性：1 工作日任务的条宽下限。 */
  minBarWidthPx: 6,
  /** 折点与条形矩形的最小间距（px）。 */
  minStubClearancePx: 2,
  /** 走线最小可辨引出段（px）。 */
  minStubPx: 4,
  maxStubPx: 16,
  /**
   * 两栏行对齐的容差（px，ADR 0007 §14 / 裁决 P-23）。
   *
   * 记录制判据（`--align`）用**真实 `getBoundingClientRect()`** 逐行比对手眼能分辨的最小量；
   * 取 0.5 px 而不是 0：`clientHeight` 是整数、`rect` 可含亚像素，1 px 的取整噪声不构成错位。
   * 三条机制（双重偏移 / 缺表头带 / 测量时机）造成的偏差都在 1 px 以上，故判别力不受影响。
   */
  rowAlignTolerancePx: 0.5,
} as const;

// ---------------------------------------------------------------- 判据复推

/** 判据①：日档下 1 工作日的条宽下限（条宽 = `pxPerDay`）。 */
function barWidthOk(zoom: ZoomKey, pxPerDay: number): boolean {
  if (zoom !== 'day') return true; // 周/月档的条宽由"每档至少一天"保证，主判据在日档
  return pxPerDay >= THRESHOLDS.minBarWidthPx;
}

/** 判据②：刻度间距 ≥ 标签宽度估算 + 2 px。 */
function labelCriteria(zoom: ZoomKey, pxPerDay: number): { spacingPx: number; labelWidthPx: number; ok: boolean } {
  const spacingPx = pxPerDay * (ZOOM_UNIT_DAYS[zoom] ?? 1);
  const chars = ZOOM_LABEL_FORMAT[zoom]?.chars ?? 2;
  const labelWidthPx = chars * LABEL_CHAR_PX + LABEL_PADDING_PX;
  return { spacingPx, labelWidthPx, ok: spacingPx >= labelWidthPx + 2 };
}

/** 判据③：最窄档位下回绕走廊仍能落在 gutter 内。 */
function corridorCriteria(pxPerDay: number): { neededPx: number; availablePx: number; ok: boolean } {
  const neededPx = EDGE_STUB_PX + EDGE_WRAP_PX;
  const availablePx = pxPerDay * AXIS_LEFT_GUTTER_DAYS;
  return { neededPx, availablePx, ok: availablePx >= neededPx };
}

/**
 * 常量必须能由判据**复推出来**（G4-S 的 `scaleParams().consistent` 手法）。
 *
 * 若有人改了常量却没同步判据，本函数返回 `consistent: false`，spec 立即失败——
 * 这样"为什么是 24 / 5 / 8 / 8 / 12"在代码里始终是可复核的。
 */
export function evaluateScaleCriteria(): {
  readonly zoom: Readonly<Record<ZoomKey, { readonly pxPerDay: number; readonly pass: boolean }>>;
  readonly rowHeight: { readonly selected: number | null; readonly declared: number };
  readonly rowBuffer: { readonly selected: number | null; readonly declared: number };
  readonly gutter: { readonly derived: number; readonly declared: number };
  readonly consistent: boolean;
} {
  const zoom: Record<ZoomKey, { pxPerDay: number; pass: boolean }> = {
    day: { pxPerDay: ZOOM_PX_PER_DAY.day, pass: false },
    week: { pxPerDay: ZOOM_PX_PER_DAY.week, pass: false },
    month: { pxPerDay: ZOOM_PX_PER_DAY.month, pass: false },
  };
  for (const key of ZOOM_ORDER) {
    const pxPerDay = ZOOM_PX_PER_DAY[key];
    const pass = barWidthOk(key, pxPerDay) && labelCriteria(key, pxPerDay).ok && corridorCriteria(pxPerDay).ok;
    zoom[key] = { pxPerDay, pass };
  }

  /**
   * 行高：**取通过全部判据的最大候选**（判据④ = `VIEWPORT.height / rowHeight >= MIN_VISIBLE_ROWS`）。
   *
   * G4-S 的 `scale-params.mjs` 在判据④ 上写的是 `Math.floor(height / rowHeight) >= 26`
   * （640/28 = 22.86 ⇒ floor 22 < 26 不通过；640/24 = 26.67 ⇒ floor 26 ≥ 26 通过），
   * 与 ADR 0007 §11 第 2 项的**原文判据**（真除法）**在候选 24 上给出同一个结果**，
   * 因此选定值不变，无需改契约；复推按原文实现（真除法）。
   */
  const passingRowHeights = ROW_HEIGHT_CANDIDATES.filter((rowHeight) => {
    const barOk = rowHeight * SPACING.barHeightRatio >= 12;
    const diamondOk = rowHeight * SPACING.milestoneSizeRatio >= 10;
    const multipleOfFour = rowHeight % 4 === 0;
    const rowsOk = VIEWPORT_DEFAULT.height / rowHeight >= MIN_VISIBLE_ROWS;
    return barOk && diamondOk && multipleOfFour && rowsOk;
  });
  const selectedRowHeight = passingRowHeights.length > 0 ? Math.max(...passingRowHeights) : null;

  /** 缓冲行：**取通过判据的最小候选**（解析判据 = 一次滚轮档位跨过的行数）。 */
  const requiredBufferRows = Math.ceil(WHEEL_NOTCH_PX / ROW_HEIGHT);
  const passingBuffers = ROW_BUFFER_CANDIDATES.filter((rowBuffer) => rowBuffer >= requiredBufferRows);
  const selectedRowBuffer = passingBuffers.length > 0 ? Math.min(...passingBuffers) : null;

  /** gutter：由回绕走廊反推（**天数**）。 */
  const minPxPerDay = Math.min(...ZOOM_ORDER.map((key) => ZOOM_PX_PER_DAY[key]));
  const derivedGutter = Math.ceil((EDGE_STUB_PX + EDGE_WRAP_PX + 4) / minPxPerDay);

  const consistent =
    ZOOM_ORDER.every((key) => zoom[key].pass) &&
    selectedRowHeight === ROW_HEIGHT &&
    selectedRowBuffer === ROW_BUFFER &&
    derivedGutter === AXIS_LEFT_GUTTER_DAYS;

  return {
    zoom,
    rowHeight: { selected: selectedRowHeight, declared: ROW_HEIGHT },
    rowBuffer: { selected: selectedRowBuffer, declared: ROW_BUFFER },
    gutter: { derived: derivedGutter, declared: AXIS_LEFT_GUTTER_DAYS },
    consistent,
  };
}
