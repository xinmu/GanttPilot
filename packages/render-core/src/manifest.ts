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
 * 轴线左侧留白（**天数**，不是像素）——SS/SF"左出回绕"走线的空间（ADR 0007 §3）。
 *
 * 由回绕走廊反推：`ceil((EDGE_STUB_PX + EDGE_WRAP_PX + 4) / min(pxPerDay))` = `ceil(24 / 3)` = **8 天**。
 * **代价（已实测记录）**：日档下 8 天 = 192 px 的左侧空白，占 1280 px 视口的 15%。
 * 这是"gutter 以天数表达"这一 §3 口径的固有代价；改成本档位推导属**语义变更**（须另立 ADR）。
 */
export const AXIS_LEFT_GUTTER_DAYS = 8;

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
 * G5 每帧新增元素的常数 **`c₄`**（ADR 0008 §11）。
 *
 * 与 `c₁`/`c₂`/`c₃` 一样，它必须与渲染层**真的发射了哪些元素**一一对应；
 * 与它们不同的是：`c₄` 是**每帧的固定开销**，不随行数、边数或文档规模增长——
 * 拖动覆盖层（轮廓 + 起止标记）、建线预览线 + 箭头、冲突标红描边、成环路径高亮描边。
 *
 * | 项 | 元素 | 何时发射 |
 * |---|---|---|
 * | 拖动轮廓 | `<rect>` | 拖动中（1 个） |
 * | 拖动起止标记 | 2 × `<line>` | 拖动中（改开始/改工期各 1 条，整体移动 2 条） |
 * | 建线预览 | `<path>` + 箭头 `<polygon>` | 建线中（2 个） |
 * | 冲突/成环描边 | `<path>` 或 `<rect>` | 有冲突或高亮时（≤ 2 个） |
 *
 * **维护纪律**：改 `GanttChart.vue` 的覆盖层模板必须同步这里的 `c4` 与 `countElements` 的分类计数；
 * `countElements` 与 `countElementsByEnumeration` 必须继续逐项相等。
 */
export const ELEMENT_MODEL_G5 = { overlay: 12 } as const;

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
 * `c₃` 的逐档位锚值（116 / 70 / 89）不在这里——它是**视口与夹具的函数**，
 * 由 spec 断言（与 G4-S 的 `clipping-report.md` 对齐），不是手选常量。
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
