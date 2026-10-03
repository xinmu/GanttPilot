/**
 * G4-S 准入定标实验的**唯一声明处**：数据集规格、视口与呈现常量候选、判据阈值、声明式期望值表。
 *
 * 为什么单独成文件（同 S3 的 `src/manifest.ts` 手法）：判据与数字必须能被"读"，而不是散落在
 * 各模块里；负向对照与阈值也都从这里取，避免"改阈值让测试变绿"。
 *
 * 本文件既被 Node 侧驱动（`*.mts`）import，也被浏览器探针页直接 import（无打包器），
 * 因此必须是**纯 ESM、零 DOM、零依赖**的 `.mjs`。
 *
 * @typedef {'day' | 'week' | 'month'} ZoomKey
 * @typedef {'FS' | 'SS' | 'FF' | 'SF'} LinkType
 * @typedef {'intersect' | 'endpoints' | 'none'} ClipMode
 */

// ---------------------------------------------------------------- 刻度档位

/** 档位顺序（与 ADR 0007 §3 一致：日 / 周 / 月；季刻度延后）。 */
export const ZOOM_ORDER = /** @type {readonly ZoomKey[]} */ (['day', 'week', 'month']);

/**
 * `pxPerDay` 候选（回填 ADR 0007 §11 第 1 项）。
 *
 * 选取规则（`scale-params.mjs` 逐条求值，**取满足判据的最小候选**——档位越密越紧凑）：
 * ① 条宽可辨：日档下 1 工作日的条宽（= `pxPerDay`）≥ `THRESHOLDS.minBarWidthPx`；
 * ② 标签不重叠：`刻度间距(px) = pxPerDay × 单位天数` ≥ 标签宽度估算 + 2 px
 *    （标签宽度 = 字符数 × `LABEL_CHAR_PX`；每档位的标签格式见 `ZOOM_LABEL_FORMAT`）；
 * ③ 回绕走廊可容：`pxPerDay × AXIS_LEFT_GUTTER_DAYS ≥ EDGE_STUB_PX + EDGE_WRAP_PX`。
 */
export const ZOOM_CANDIDATES = {
  day: [24, 28, 32],
  week: [8, 10, 14],
  month: [3, 4, 6],
};

/** 选定值（= `ZOOM_CANDIDATES` 中通过全部判据的最小者）。 */
export const ZOOM_SELECTED = { day: 24, week: 8, month: 3 };

/** 每档位的刻度单位（自然日）与标签格式——**可读性判据的输入，也是渲染器的输入**。 */
export const ZOOM_UNIT_DAYS = { day: 1, week: 7, month: 30 };

export const ZOOM_LABEL_FORMAT = {
  day: { label: '日（DD）', chars: 2 },
  week: { label: '周（MM-DD，取周一）', chars: 5 },
  month: { label: '月（YYYY-MM，取 1 日）', chars: 7 },
};

/** 标签宽度估算：字符宽 + 内边距（判据②用；不引入字体度量依赖）。 */
export const LABEL_CHAR_PX = 6;
export const LABEL_PADDING_PX = 2;

/** @param {ZoomKey} zoom */
export function zoomPxPerDay(zoom) {
  return ZOOM_SELECTED[zoom];
}

/** 档位的中文标签（证据渲染用）。 */
export const ZOOM_LABEL = { day: '日', week: '周', month: '月' };

// ---------------------------------------------------------------- 视口与行模型

/**
 * 固定视口（测量口径的一部分：换视口必须重新登记数字）。
 *
 * `rowBuffer` 为候选 `ROW_BUFFER_CANDIDATES` 的选定值（回填 ADR 0007 §11 第 2 项）。
 */
export const VIEWPORT = {
  width: 1280,
  height: 640,
  rowHeight: 24,
  /** 可见行上下各留的缓冲行数。 */
  rowBuffer: 5,
};

/**
 * `ROW_HEIGHT` 候选（回填 ADR 0007 §11 第 2 项）。
 *
 * 选取规则（**取满足判据的最大候选**——行高越大越易读，受"视口至少容纳 N 行"约束）：
 * ① 条高（`SPACING.barHeightRatio × rowHeight`）≥ 12 px；
 * ② 里程碑菱形边长（`SPACING.milestoneSizeRatio × rowHeight`）≥ 10 px；
 * ③ 行高为 4 的整数倍（避开 1 px 抖动与 DPR 取整问题）；
 * ④ `VIEWPORT.height / rowHeight ≥ MIN_VISIBLE_ROWS`。
 */
export const ROW_HEIGHT_CANDIDATES = [20, 24, 28];

/** 判据④：固定视口下至少要能同时看到多少行（决定行高上限）。 */
export const MIN_VISIBLE_ROWS = 26;

/**
 * `ROW_BUFFER` 候选（回填 ADR 0007 §11 第 2 项）。
 *
 * 选取规则：**取满足判据的最小候选**——缓冲行的唯一作用是遮住"滚动事件到下一帧重绘"之间的空白，
 * 因此它必须 ≥ 一次滚轮档位跨过的行数：`ceil(WHEEL_NOTCH_PX / ROW_HEIGHT)`。
 * （实测侧另有"10× 滚动期间零空白行"的页内断言，但那条在同步重绘下恒真，
 * 故**主判据是这条解析式**，实测只作佐证。）
 */
export const ROW_BUFFER_CANDIDATES = [2, 5, 10];

/** 一次滚轮档位在 Windows 上的典型像素跨度（解析判据的输入）。 */
export const WHEEL_NOTCH_PX = 100;

/**
 * 轴线左侧留白（**天数**，不是像素）——SS/SF"左出回绕"走线的空间（ADR 0007 §3）。
 *
 * 由回绕走廊反推：`ceil((EDGE_STUB_PX + EDGE_WRAP_PX + 4) / min(pxPerDay))`
 * = `ceil((8 + 12 + 4) / 3)` = **8 天**（最窄档位 = 月档，`pxPerDay = 3`）。
 *
 * **代价（已实测记录）**：日档下 8 天 = **192 px** 的左侧空白，占 1280 px 视口的 15%。
 * 这是"gutter 以天数表达"这一 §3 口径的固有代价；改成本档位推导（`/ pxPerDay(zoom)`）
 * 属于**语义变更**，须另立 ADR，不在本实验内顺手决定。
 */
export const AXIS_LEFT_GUTTER_DAYS = 8;

// ---------------------------------------------------------------- 依赖线路由

/** `EDGE_STUB_PX` 候选（固定像素常数，**不随 `pxPerDay` 缩放**；ADR 0007 §5）。 */
export const EDGE_STUB_CANDIDATES = [6, 8, 10, 12];

/** `EDGE_WRAP_PX` 候选（回绕时竖向段的额外左移量）。 */
export const EDGE_WRAP_CANDIDATES = [8, 12, 16];

/** 选定值（判据：竖向段与任何条形矩形的最小间距 ≥ `THRESHOLDS.minStubClearancePx`，取满足者中最小跨度）。 */
export const EDGE_STUB_PX = 8;
export const EDGE_WRAP_PX = 12;

/**
 * 呈现常量候选（回填 ADR 0007 §11 第 6 项）。
 *
 * 元素预算刻意保持"每行 3 / 每边 3"：**汇总条不加端帽**（加了就要把它算进 c₁）。
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
};

// ---------------------------------------------------------------- 元素预算

/**
 * 元素模型（ADR 0007 §6.7 的 `c₁`/`c₂` 来源）。
 *
 * - 每渲染行 ≤ 3：`<g>` + 条 `<rect>` + 进度 `<rect>`（里程碑行为 `<g>` + `<polygon>` = 2；
 *   进度未知（`null`）或汇总进度为 `NaN` 时不画填充 ⇒ 实际 ≤ 3）；
 * - 每条渲染边 = 3：折线 `<path>` + 箭头 `<polygon>` + **ADR 0007 §5 要求的透明热区 `<path>`**；
 * - `c₃`（轴与刻度）**按档位各一个常数**：只随可见水平跨度（视口宽 / `pxPerDay`）变化，
 *   与文档总规模无关——这正是 S4-a 要证明的"与规模解耦"。
 */
export const ELEMENT_MODEL = {
  perRenderedRow: 3,
  perRenderedEdge: 3,
};

// ---------------------------------------------------------------- 判据阈值

/**
 * 判据阈值。**单点声明**：任何"让测试变绿"的调整都必须改这里，因而必然留下 diff。
 */
export const THRESHOLDS = {
  /** S4-d：4 类箭头两两光栅化 Jaccard 距离的下限。 */
  arrowMinJaccard: 0.15,
  /** S4-d：折点随 `pxPerDay` 的漂移上限（只允许取整噪声）。 */
  foldMaxDeltaPx: 1,
  /** 折点扫描的 `pxPerDay` 细扫序列。 */
  foldSweepPxPerDay: [4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 56, 80],
  /** NC2：关掉窗口裁剪后，最大/最小规模文档的元素数比值必须超过它。 */
  nc2GrowthRatio: 5,
  /**
   * S4-a：**窗口路径**的元素数在 10× 规模跨度（200 → 2,000 任务）上的增长比上限。
   *
   * 与 `nc2GrowthRatio` 必须拉开数量级，否则判据没有判别力：窗口路径 ≈ 1.0×，
   * 关掉裁剪 ≈ 9.4×（实测，见 `evidence/clipping-report.md`）。
   */
  windowedGrowthRatio: 1.5,
  /** S4-b：**每个**声明滚动位置至少要丢的跨屏长边条数。 */
  minCrossScreenLossPerPosition: 1,
  /** S4-b：全部声明位置合计至少丢的条数。 */
  totalCrossScreenLoss: 5,
  /** S4-c：首屏（含依赖线的首帧）预算（原文口径）。 */
  firstScreenMs: 1000,
  /** S4-c：《评估报告》§5.4 反例的同尺对照值（2,200 边 / 10× 滚动约 2.0s）。 */
  scrollReferenceMs: 2000,
  /** 刻度档位可读性：1 工作日任务的条宽下限。 */
  minBarWidthPx: 6,
  /** 折点与条形矩形的最小间距（px）。 */
  minStubClearancePx: 2,
  /** 走线最小可辨引出段（px）。 */
  minStubPx: 4,
  maxStubPx: 16,
  /** 元素预算的"必须有余量"要求：实际元素数 ≤ 预算。 */
  budgetMustHold: true,
};

// ---------------------------------------------------------------- 数据集

/**
 * 三种形态 × 1,000 任务 / 1,500 依赖（与 S3 的图生成器同构的口径）。
 *
 * `links` 是**目标条数**，生成器必须精确命中（`run-all.mts` 断言）。
 * `longEdges` 是**声明的跨屏长边**条数（S4-b 的判据来源，固定种子 → 逐字节可复现）。
 * `collapsedSummaries` 是**声明要折叠**的汇总任务序号（1 基），用于"折叠隐藏行不画其边"。
 */
export const DATASETS = [
  {
    key: 'wide',
    name: '宽而浅',
    tasks: 1000,
    links: 1500,
    summaries: 20,
    milestones: 50,
    longEdges: 6,
    summaryEdges: 12,
    maxJump: 40,
    seed: 404001,
    collapsedSummaries: [2],
  },
  {
    key: 'chain',
    name: '深链',
    tasks: 1000,
    links: 1500,
    summaries: 0,
    milestones: 20,
    longEdges: 10,
    summaryEdges: 0,
    maxJump: 60,
    seed: 404002,
    collapsedSummaries: [],
  },
  {
    key: 'dense',
    name: '密集交叉',
    tasks: 1000,
    links: 1500,
    summaries: 50,
    milestones: 50,
    longEdges: 8,
    summaryEdges: 20,
    maxJump: 40,
    seed: 404003,
    collapsedSummaries: [3],
  },
];

/** 主口径数据集（首屏与滚动判定用它；S3 的口径是"密集交叉最能暴露问题"）。 */
export const PRIMARY_DATASET_KEY = 'dense';

/**
 * 额外的"同尺对照"数据集：《评估报告》§5.4 的反例是 **2,200 条边**，
 * 因此必须有一个 2,200 边的观测点才能说"更好还是更差"。
 */
export const REFERENCE_DATASET = {
  key: 'dense2200',
  name: '密集交叉（§5.4 同尺：2,200 边）',
  tasks: 1000,
  links: 2200,
  summaries: 50,
  milestones: 50,
  longEdges: 8,
  summaryEdges: 20,
  maxJump: 40,
  seed: 404004,
  collapsedSummaries: [3],
};

/** S4-a 的规模梯度（同视口/档位/滚动位置下，元素数必须与该列表无关）。 */
export const SCALE_GRADIENT_TASKS = [200, 500, 1000, 2000];

/** 规模梯度用的依赖密度（与主口径同比）。 */
export const SCALE_GRADIENT_LINK_RATIO = 1.5;

/** S4-b 的声明滚动位置（**可见行序号**，不是像素）。 */
export const S4B_SCROLL_ROW_OFFSETS = [0, 250, 500, 750];

/** S4-c 的 10× 滚动步数。 */
export const SCROLL_STEPS = 10;

/** 浏览器计时的重复轮数（p50/p95 口径，与 S3 的 median-of-suites 同精神）。 */
export const BROWSER_RUNS = 5;

// ---------------------------------------------------------------- 声明式期望值表

/**
 * 声明式期望值表的形状。
 *
 * `expect` 刻意留成 `any`：它是**声明式数据**（检查器按 `kind` 分支逐字段比对字符串与数字），
 * 给它建联合类型只会让"加一条期望值"变成改三处类型；判据的判别力由 NC3 保证（故意错的几何必须被检出）。
 *
 * @typedef {object} ManualCase
 * @property {string} name
 * @property {'bar' | 'milestone' | 'route'} kind
 * @property {ZoomKey} zoom
 * @property {number} [es]
 * @property {number} [ef]
 * @property {'FS' | 'SS' | 'FF' | 'SF'} [relation]
 * @property {{ es: number, ef: number }} [from]
 * @property {{ es: number, ef: number }} [to]
 * @property {any} expect
 */

/**
 * 几何声明式期望值表（**内核无权改基准**，同 `schedule.manual.spec.ts` 的手法）。
 *
 * 口径：
 * - 基准日历的 `baseDay` = `2026-10-05`（周一），因此序号 0 = 2026-10-05、
 *   4 = 2026-10-09（周五）、5 = 2026-10-12（周一）、8 = 2026-10-15（周四）、
 *   20 = 2026-11-02、21 = 2026-11-03、22 = 2026-11-04；
 * - `xLeft` 的期望写成 **ISO 日期**（`dayOfOrdinal(es)`），`xRight` 的期望写成
 *   `dayOfOrdinal(ef − 1) + 1` 的 ISO 日期——**这是 ADR 0007 §3 的右边界规则本身**；
 *   `naiveRightIso` 是"误用 `dayOfOrdinal(ef)`"会得到的值，用它证明判据有判别力；
 * - 路由用例声明的是**枚举与方向**（出/入边、箭头朝向、是否需要回绕），
 *   这是 P-8 第 1 条的**内容**；px 数值由声明式 ISO 边界 + 冻结公式导出（因此不写成魔数）。
 *
 * @type {readonly ManualCase[]}
 */
export const MANUAL_CASES = [
  {
    name: '日档·单日任务',
    kind: 'bar',
    zoom: 'day',
    es: 0,
    ef: 1,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-06', naiveRightIso: '2026-10-06' },
  },
  {
    name: '日档·周一至周五（跨周末右边界）',
    kind: 'bar',
    zoom: 'day',
    es: 0,
    ef: 5,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-10', naiveRightIso: '2026-10-12' },
  },
  {
    name: '日档·周五+周一（ef−1 恰落在周一，两种写法一致）',
    kind: 'bar',
    zoom: 'day',
    es: 4,
    ef: 6,
    expect: { xLeftIso: '2026-10-09', xRightIso: '2026-10-13', naiveRightIso: '2026-10-13' },
  },
  {
    name: '日档·跨月',
    kind: 'bar',
    zoom: 'day',
    es: 20,
    ef: 22,
    expect: { xLeftIso: '2026-11-02', xRightIso: '2026-11-04', naiveRightIso: '2026-11-04' },
  },
  {
    name: '周档·同任务（ISO 边界不变，只有 pxPerDay 变）',
    kind: 'bar',
    zoom: 'week',
    es: 0,
    ef: 5,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-10', naiveRightIso: '2026-10-12' },
  },
  {
    name: '月档·同任务（ISO 边界不变）',
    kind: 'bar',
    zoom: 'month',
    es: 0,
    ef: 5,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-10', naiveRightIso: '2026-10-12' },
  },
  {
    name: '里程碑·取所在工作日格的中点',
    kind: 'milestone',
    zoom: 'day',
    es: 8,
    ef: 8,
    expect: { centerIso: '2026-10-15', centerOffsetDays: 0.5 },
  },
  {
    name: 'FS：右出 → 左入（前置在后置左侧）',
    kind: 'route',
    zoom: 'day',
    relation: 'FS',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    // 箭头朝向：从左侧进入 ⇒ 朝 +x（箭头指向条内）。
    expect: { exitSide: 'right', enterSide: 'left', arrowDir: 1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SS：左出 → 左入（目标在右侧，不回绕）',
    kind: 'route',
    zoom: 'day',
    relation: 'SS',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'left', enterSide: 'left', arrowDir: 1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SS：左出 → 左入（目标在前置左侧 ⇒ 必须回绕）',
    kind: 'route',
    zoom: 'day',
    relation: 'SS',
    from: { es: 8, ef: 12 },
    to: { es: 0, ef: 5 },
    expect: { exitSide: 'left', enterSide: 'left', arrowDir: 1, wrapped: true, verticalXRule: 'minMinusWrap' },
  },
  {
    name: 'FF：右出 → 右入（前置在后置左侧）',
    kind: 'route',
    zoom: 'day',
    relation: 'FF',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'right', enterSide: 'right', arrowDir: -1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SF：左出 → 右入（前置在后置左侧）',
    kind: 'route',
    zoom: 'day',
    relation: 'SF',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'left', enterSide: 'right', arrowDir: -1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SF：左出 → 右入（目标在前置左侧 ⇒ 必须回绕）',
    kind: 'route',
    zoom: 'day',
    relation: 'SF',
    from: { es: 8, ef: 12 },
    to: { es: 0, ef: 5 },
    expect: { exitSide: 'left', enterSide: 'right', arrowDir: -1, wrapped: true, verticalXRule: 'minMinusWrap' },
  },
];

/**
 * P-8 第 1 条的出/入边策略（**唯一登记处是裁决 P-8，本表只是它的可执行副本**）。
 *
 * `exit` / `enter` 取 `'left' | 'right'`；箭头方向 = `-enter`（线从右侧进入 ⇒ 箭头朝左）。
 */
export const ROUTE_SIDES =
  /** @type {Record<string, { exit: 'left' | 'right', enter: 'left' | 'right' }>} */ ({
    FS: { exit: 'right', enter: 'left' },
    SS: { exit: 'left', enter: 'left' },
    FF: { exit: 'right', enter: 'right' },
    SF: { exit: 'left', enter: 'right' },
  });

/**
 * 4 类关系的箭头**候选形态**（回填 ADR 0007 §11 第 3 项）。
 *
 * 两两可区分由"填充（实心/空心）× 朝向（+x/−x）"承担；朝向由 `enter` 侧决定，不由关系直接指定，
 * 因此本表只声明填充。
 */
export const ARROW_FILL = { FS: 'solid', FF: 'solid', SS: 'hollow', SF: 'hollow' };

/** 箭头可区分性光栅化的采样参数（1 CSS px 网格 + 四周留白）。 */
export const ARROW_RASTER = { paddingPx: 1 };

// ---------------------------------------------------------------- 环境口径

/** 浏览器计时必须与数字一起登记的环境字段（ADR 0007 §9）。 */
export const ENV_FIELDS = [
  'machine',
  'os',
  'nodeVersion',
  'chromeVersion',
  'chromeMode',
  'deviceScaleFactor',
  'viewport',
  'zoom',
  'dataset',
  'runs',
];

/** 机器标识（本机口径，随数字一起写进证据）。 */
export const MACHINE = 'local-dev-windows';

/** 诊断：主口径 Node 版本（CONTRIBUTING / CI）与本机默认版本分开记录。 */
export const NODE_PRIMARY = '24.15.0';

/** 退出码口径：非零 = **测量基础设施不可信**（门禁判定本身是数据，不是退出码）。 */
export const EXIT_CODES = {
  ok: 0,
  infrastructure: 1,
};
