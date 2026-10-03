/**
 * 确定性夹具生成（**生产导出**：演示数据、测量口径与测试共用同一份生成器）。
 *
 * ## 为什么它在生产包里而不是 `*.spec.ts`
 *
 * - `apps/web` 的演示数据与 `scripts/measure-render.mjs` 的首屏测量必须与 spec 用**同一份文档形状**，
 *   否则"1,000 任务 / 1,500 依赖"这句话在演示、测量、测试三处含义不同；
 * - 纪律与 G4-S 的 `graph-gen.mjs` 一致：**零 `Math.random`**（全部随机性来自 `mulberry32(spec.seed)`，
 *   同一 spec 逐字节复现）、依赖边**一律沿文档序向前**（不可能成环，不必借引擎检环做数据校验）、
 *   生成器**精确命中** `spec.links` 条边（否则"1,500 依赖"不成立）。
 *
 * ## 规模梯度的"局部结构一致"（G4-S 的第一处实测订正）
 *
 * `maxJump` 与"每 20 个任务一个汇总"必须**固定**，不能随规模推算：
 * 否则"元素数与文档总规模无关"会被边的跨度分布变化污染，判据就不可读了。
 */

import {
  compute,
  createScheduleCalendar,
  reindexDocument,
  validateDocument,
  type Calendar,
  type DocumentLink,
  type DocumentTask,
  type LinkType,
  type ProjectDocument,
  type Schedule,
} from '@ganttpilot/engine';

/** 基准项目起点（周一）。序号锚点由此决定：序号 0 = `2026-10-05`。 */
export const FIXTURE_PROJECT_START_ISO = '2026-10-05';

/** 夹具规格（数据集声明）。 */
export interface FixtureSpec {
  readonly key: string;
  readonly name: string;
  readonly tasks: number;
  readonly links: number;
  readonly summaries: number;
  readonly milestones: number;
  /** 声明的跨屏长边条数（"求交必要性"判据的来源，固定种子 ⇒ 可复现）。 */
  readonly longEdges: number;
  /** 汇总端点边条数（被传播忽略但**照画**的那些）。 */
  readonly summaryEdges: number;
  readonly seed: number;
  /** 随机边的最大前向跨度（**规模梯度必须固定它**）。 */
  readonly maxJump?: number;
  /** 声明要折叠的汇总任务序号（1 基），用于"折叠隐藏行不画其边"。 */
  readonly collapsedSummaries: readonly number[];
}

/** 三种形态 × 1,000 任务 / 1,500 依赖（与 S3/G4-S 的图生成器同构的口径）。 */
export const DATASETS: readonly FixtureSpec[] = [
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

/** 主口径数据集（首屏与滚动判定用它；"密集交叉最能暴露问题"）。 */
export const PRIMARY_DATASET_KEY = 'dense';

/**
 * 额外的"同尺对照"数据集：《评估报告》§5.4 的反例是 **2,200 条边**，
 * 必须有一个 2,200 边的观测点才能说"更好还是更差"。
 */
export const REFERENCE_DATASET: FixtureSpec = {
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

/** 规模梯度（同一形态、不同规模；依赖密度同比）。 */
export const SCALE_GRADIENT_TASKS = [200, 500, 1000, 2000] as const;

/** 规模梯度的依赖密度（与主口径同比）。 */
export const SCALE_GRADIENT_LINK_RATIO = 1.5;

/** `kind: 'endpoints'` 负向对照的声明滚动位置（**可见行序号**，不是像素）。 */
export const SCROLL_ROW_OFFSETS = [0, 250, 500, 750] as const;

/** 确定性 PRNG（mulberry32）：32 位种子，序列固定。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 生成统计（供 spec 与报告断言）。 */
export interface FixtureStats {
  readonly key: string;
  readonly name: string;
  readonly taskCount: number;
  readonly linkCount: number;
  readonly summaryCount: number;
  readonly leafCount: number;
  readonly milestoneCount: number;
  readonly longEdgeIds: readonly string[];
  readonly summaryEdgeIds: readonly string[];
  /** 因端点被折叠隐藏而不画的边 id（"折叠隐藏行不画其边"的判据来源）。 */
  readonly hiddenEdgeIds: readonly string[];
  readonly collapsedSummaryIds: readonly string[];
  readonly hiddenIds: readonly string[];
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly layerWidth: number;
}

/** 每层的并行宽度（决定项目的时间跨度与"跨屏"程度）。 */
function layerWidthFor(key: string): number {
  if (key === 'chain') return 1;
  if (key === 'wide') return 50;
  return 20;
}

/** 被折叠隐藏的任务 id（折叠汇总的**全部后代**）。 */
export function hiddenChildren(tasks: readonly DocumentTask[], collapsedSummaries: readonly number[]): Set<string> {
  const collapsedIds = new Set(collapsedSummaries.map((index) => `s${String(index)}`));
  const childrenOf = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [task.id]);
    else bucket.push(task.id);
  }
  const hidden = new Set<string>();
  const stack = [...collapsedIds];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (parent === undefined) continue;
    for (const child of childrenOf.get(parent) ?? []) {
      if (hidden.has(child)) continue;
      hidden.add(child);
      stack.push(child);
    }
  }
  return hidden;
}

/**
 * 生成一份文档 + 统计。
 *
 * 边全部沿文档序向前（`to` 的文档序 > `from` 的文档序）⇒ **不可能成环**。
 * 精确命中 `spec.links` 条边，否则抛错（"1,500 依赖"这句话必须成立）。
 */
export function generateDocument(spec: FixtureSpec): { readonly document: ProjectDocument; readonly stats: FixtureStats } {
  const rng = mulberry32(spec.seed);
  const tasks: DocumentTask[] = [];
  const summaryIds: string[] = [];
  const leafIds: string[] = [];

  const summaryCount = spec.summaries;
  const leafCount = spec.tasks - summaryCount;
  if (leafCount <= 0) throw new Error(`数据集规格非法（${spec.key}）：叶子数必须为正`);

  const milestoneEvery = spec.milestones > 0 ? Math.max(1, Math.round(leafCount / spec.milestones)) : 0;
  const width = layerWidthFor(spec.key);

  let leafSeq = 0;
  const pushLeaf = (parentId: string | null): void => {
    const id = `t${String(leafSeq + 1)}`;
    const isMilestone = milestoneEvery > 0 && leafSeq % milestoneEvery === milestoneEvery - 1;
    const slot = leafSeq;
    leafSeq += 1;
    leafIds.push(id);
    const durationDays = isMilestone ? 0 : 1 + Math.floor(rng() * 9);
    // 第一层（无前置）显式给文档日期 ⇒ 走锚点情形①，避免整片 `undated` 诊断噪声。
    const anchoredByDate = slot < width && !isMilestone;
    tasks.push({
      id,
      parentId,
      outlineNumber: '',
      name: isMilestone ? `里程碑 ${String(slot + 1)}` : `任务 ${String(slot + 1)}`,
      startDate: anchoredByDate ? FIXTURE_PROJECT_START_ISO : null,
      endDate: null,
      durationDays,
      progress: isMilestone ? 0 : rng() < 0.2 ? null : Math.round(rng() * 20) / 20,
      milestone: isMilestone,
      collapsed: false,
      notes: null,
      manual: false,
      constraints: [],
    });
  };

  const pushSummary = (index: number): void => {
    const id = `s${String(index)}`;
    summaryIds.push(id);
    tasks.push({
      id,
      parentId: null,
      outlineNumber: '',
      name: `阶段 ${String(index)}`,
      startDate: null,
      endDate: null,
      durationDays: null,
      progress: null,
      milestone: false,
      collapsed: spec.collapsedSummaries.includes(index),
      notes: null,
      manual: false,
      constraints: [],
    });
  };

  if (summaryCount > 0) {
    const per = Math.floor(leafCount / summaryCount);
    const remainder = leafCount % summaryCount;
    for (let s = 1; s <= summaryCount; s += 1) {
      pushSummary(s);
      const count = per + (s <= remainder ? 1 : 0);
      for (let k = 0; k < count; k += 1) pushLeaf(`s${String(s)}`);
    }
  } else {
    for (let k = 0; k < leafCount; k += 1) pushLeaf(null);
  }

  // ---------------------------------------------------------------- 依赖边
  const links: DocumentLink[] = [];
  const seen = new Set<string>();
  const TYPES: readonly LinkType[] = ['FS', 'FS', 'FS', 'FS', 'SS', 'FF', 'SF'];
  const LAGS = [-2, 0, 0, 0, 1, 2, 3];
  const longEdgeIds: string[] = [];

  const addLink = (from: string | undefined, to: string | undefined, id?: string): boolean => {
    if (from === undefined || to === undefined || from === to) return false;
    const key = `${from}->${to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const type = TYPES[Math.floor(rng() * TYPES.length)] ?? 'FS';
    const lagDays = LAGS[Math.floor(rng() * LAGS.length)] ?? 0;
    links.push({ id: id ?? `l${String(links.length + 1)}`, from, to, type, lagDays });
    return true;
  };

  // ① 声明的跨屏长边：从最前面的行指向文档末段的行。
  const leaves = leafIds.length;
  for (let k = 0; k < spec.longEdges; k += 1) {
    const fromIdx = Math.min(2 + k, leaves - 1);
    const toIdx = Math.min(Math.floor(leaves * 0.9) + k, leaves - 1);
    const id = `long-${String(k + 1)}`;
    if (addLink(leafIds[fromIdx], leafIds[toIdx], id)) longEdgeIds.push(id);
  }

  // ② 分层列边：i → i+width（保证图是"层状"的，第一层无前置）。
  for (let i = 0; i + width < leaves; i += 1) {
    addLink(leafIds[i], leafIds[i + width]);
  }

  // ③ 汇总端点边（**被传播忽略**，但文档里存在 ⇒ 必须照画、用样式区分）。
  // 注意：`document` 里必须先建任务再连边 —— 汇总任务出现在它自己的叶子之前，
  // 所以汇总端点边一律连向**文档序更靠后的叶子**（保持"边只向前"这条纪律）。
  for (let k = 0; k < spec.summaryEdges; k += 1) {
    const from = summaryIds[k % Math.max(1, summaryIds.length)];
    const fromIndex = tasks.findIndex((task) => task.id === from);
    if (fromIndex < 0) continue;
    for (let step = 100 + k * 37; step < leaves; step += 37) {
      if (step > fromIndex && addLink(from, leafIds[step])) break;
    }
  }

  // ④ 随机前向边（补齐到目标条数）：j = i + 1 + floor(rng() * maxJump)。
  const maxJump = spec.maxJump ?? 40;
  let guard = 0;
  while (links.length < spec.links && guard < spec.links * 200) {
    guard += 1;
    const i = Math.floor(rng() * leaves);
    const j = i + 1 + Math.floor(rng() * maxJump);
    if (j >= leaves) continue;
    addLink(leafIds[i], leafIds[j]);
  }

  if (links.length !== spec.links) {
    throw new Error(
      `数据集 ${spec.key} 未能精确命中依赖条数：期望 ${String(spec.links)}、实得 ${String(links.length)}`,
    );
  }

  const hiddenIds = hiddenChildren(tasks, spec.collapsedSummaries);
  const summaryEdgeIds = links
    .filter((link) => summaryIds.includes(link.from) || summaryIds.includes(link.to))
    .map((link) => link.id);
  const hiddenEdgeIds = links
    .filter((link) => hiddenIds.has(link.from) || hiddenIds.has(link.to))
    .map((link) => link.id);

  const document: ProjectDocument = {
    version: 3,
    project: {
      name: `夹具·${spec.name}`,
      description: null,
      baseCalendarId: 'project',
      startDate: FIXTURE_PROJECT_START_ISO,
      finishDate: null,
    },
    calendars: [{ id: 'project', exceptions: { nonWorking: [], working: [] } }],
    tasks,
    links,
    baselines: [],
  };

  return {
    document,
    stats: {
      key: spec.key,
      name: spec.name,
      taskCount: tasks.length,
      linkCount: links.length,
      summaryCount,
      leafCount,
      milestoneCount: tasks.filter((task) => task.milestone || task.durationDays === 0).length,
      longEdgeIds,
      summaryEdgeIds,
      hiddenEdgeIds,
      collapsedSummaryIds: spec.collapsedSummaries.map((index) => `s${String(index)}`),
      hiddenIds: [...hiddenIds],
      typeCounts: countTypes(links),
      layerWidth: width,
    },
  };
}

function countTypes(links: readonly DocumentLink[]): Record<string, number> {
  const counts: Record<string, number> = { FS: 0, SS: 0, FF: 0, SF: 0 };
  for (const link of links) counts[link.type] = (counts[link.type] ?? 0) + 1;
  return counts;
}

/** 装配好的一份夹具（文档 + 日历 + 排程 + 统计）。 */
export interface RenderFixture {
  readonly spec: FixtureSpec;
  readonly document: ProjectDocument;
  readonly calendar: Calendar;
  readonly schedule: Schedule;
  readonly stats: FixtureStats;
}

/**
 * 夹具装配：`generateDocument` → `reindexDocument` → `validateDocument`（**无 error**）
 * → `createScheduleCalendar` → `compute`。
 *
 * 任何一步不成立都抛错——夹具是判据的基准，**不能是"大概能用"的文档**。
 */
export function buildFixture(spec: FixtureSpec): RenderFixture {
  const generated = generateDocument(spec);
  const document = reindexDocument(generated.document);
  const errors = validateDocument(document).filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `夹具 ${spec.key} 未通过 schema 校验：${JSON.stringify(errors.slice(0, 3))}`,
    );
  }
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) {
    throw new Error(`夹具 ${spec.key} 不可排程（code=${result.code}）：${result.message}`);
  }
  return { spec, document, calendar, schedule: result.schedule, stats: generated.stats };
}

/**
 * 规模梯度：同一形态、不同规模（依赖密度同比），**局部结构保持一致**。
 *
 * "每 20 个任务一个汇总 + 固定 `maxJump`"是 G4-S 实测订正过的口径：
 * 让它们随规模变化会把"元素数与规模无关"测成别的东西。
 */
export function scaleGradient(
  baseSpec: FixtureSpec,
  sizes: readonly number[] = SCALE_GRADIENT_TASKS,
  linkRatio = SCALE_GRADIENT_LINK_RATIO,
): readonly { readonly size: number; readonly fixture: RenderFixture }[] {
  return sizes.map((size) => {
    const summaries = Math.max(1, Math.round(size / 20));
    const spec: FixtureSpec = {
      ...baseSpec,
      key: `${baseSpec.key}-${String(size)}`,
      name: `${baseSpec.name}·${String(size)} 任务`,
      tasks: size,
      links: Math.round(size * linkRatio),
      summaries,
      milestones: Math.max(1, Math.round(size * 0.05)),
      summaryEdges: summaries > 0 ? baseSpec.summaryEdges : 0,
    };
    return { size, fixture: buildFixture(spec) };
  });
}

/** 全部 1,000 任务夹具（主口径 + 同尺对照）。 */
export function allDatasets(): readonly FixtureSpec[] {
  return [...DATASETS, REFERENCE_DATASET];
}
