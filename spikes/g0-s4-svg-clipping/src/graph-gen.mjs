/**
 * 确定性夹具生成：三种形态（宽而浅 / 深链 / 密集交叉）+ 规模梯度。
 *
 * 纪律：
 * - **零 import**（不认识引擎，只产文档数据），因此可在浏览器与 Node 两侧复用；
 * - **零 `Math.random`**：全部随机性来自 `mulberry32(spec.seed)`，同一 spec 必须逐字节复现；
 * - 依赖边**一律沿文档序向前**（`to` 的文档序 > `from` 的文档序）⇒ 不可能成环，
 *   也不必依赖引擎的检环来做数据校验；
 * - 生成器**精确命中** `spec.links` 条边（`run-all.mts` 会断言），否则"1,500 依赖"这句话不成立。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').DocumentTask} DocumentTask
 * @typedef {import('../../../packages/engine/dist/index.js').DocumentLink} DocumentLink
 * @typedef {import('../../../packages/engine/dist/index.js').LinkType} LinkType
 */

import { ROUTE_SIDES } from './manifest.mjs';

/** 基准项目起点（周一）。序号锚点由此决定：序号 0 = 2026-10-05。 */
export const PROJECT_START_ISO = '2026-10-05';

/** 确定性 PRNG（mulberry32）：32 位种子，序列固定。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 每层的并行宽度（决定项目的时间跨度与"跨屏"程度）。 */
function layerWidthFor(key) {
  if (key === 'chain') return 1;
  if (key === 'wide') return 50;
  return 20;
}

/**
 * 生成一份文档 + 统计。
 *
 * @param {{
 *   key: string, name: string, tasks: number, links: number, summaries: number,
 *   milestones: number, longEdges: number, summaryEdges: number, seed: number,
 *   maxJump?: number, collapsedSummaries: readonly number[],
 * }} spec
 */
export function generateDocument(spec) {
  const rng = mulberry32(spec.seed);
  /** @type {DocumentTask[]} */
  const tasks = [];
  /** @type {string[]} */
  const summaryIds = [];
  /** @type {string[]} */
  const leafIds = [];
  /** 叶子在"叶子序"里的序号（不含汇总任务），用于连边规划。 */
  const leafSlot = new Map();

  // ---------------------------------------------------------------- 任务与层级
  const summaryCount = spec.summaries;
  const leafCount = spec.tasks - summaryCount;
  if (leafCount <= 0) throw new Error('数据集规格非法：叶子数必须为正');

  const milestoneEvery = spec.milestones > 0 ? Math.max(1, Math.round(leafCount / spec.milestones)) : 0;
  const width = layerWidthFor(spec.key);

  let leafSeq = 0;
  const pushLeaf = (parentId) => {
    const id = `t${String(leafSeq + 1)}`;
    const isMilestone = milestoneEvery > 0 && leafSeq % milestoneEvery === milestoneEvery - 1;
    const slot = leafSeq;
    leafSeq += 1;
    leafSlot.set(id, slot);
    leafIds.push(id);
    const durationDays = isMilestone ? 0 : 1 + Math.floor(rng() * 9);
    // 第一层（无前置）显式给文档日期 ⇒ 走锚点情形①，避免整片 `undated` 诊断噪声。
    const anchoredByDate = slot < width && !isMilestone;
    tasks.push({
      id,
      parentId,
      outlineNumber: '',
      name: isMilestone ? `里程碑 ${String(slot + 1)}` : `任务 ${String(slot + 1)}`,
      startDate: anchoredByDate ? PROJECT_START_ISO : null,
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

  const pushSummary = (index) => {
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
  /** @type {DocumentLink[]} */
  const links = [];
  const seen = new Set();
  const TYPES = /** @type {readonly LinkType[]} */ (['FS', 'FS', 'FS', 'FS', 'SS', 'FF', 'SF']);
  const LAGS = [-2, 0, 0, 0, 1, 2, 3];
  /** @type {string[]} */
  const longEdgeIds = [];

  const addLink = (from, to, id) => {
    if (from === to) return false;
    const key = `${from}->${to}`;
    if (seen.has(key)) return false;
    if (to === undefined || from === undefined) return false;
    seen.add(key);
    const type = TYPES[Math.floor(rng() * TYPES.length)] ?? 'FS';
    const lagDays = LAGS[Math.floor(rng() * LAGS.length)] ?? 0;
    links.push({ id: id ?? `l${String(links.length + 1)}`, from, to, type, lagDays });
    return true;
  };

  // ① 声明的跨屏长边（S4-b 的判据来源）：从最前面的行指向文档末段的行。
  const leaves = leafIds.length;
  for (let k = 0; k < spec.longEdges; k += 1) {
    const fromIdx = Math.min(2 + k, leaves - 1);
    const toIdx = Math.min(Math.floor(leaves * 0.9) + k, leaves - 1);
    const from = leafIds[fromIdx];
    const to = leafIds[toIdx];
    if (from === undefined || to === undefined) continue;
    if (addLink(from, to, `long-${String(k + 1)}`)) longEdgeIds.push(`long-${String(k + 1)}`);
  }

  // ② 分层列边：i → i+width（保证图是"层状"的，第一层无前置）。
  for (let i = 0; i + width < leaves; i += 1) {
    const from = leafIds[i];
    const to = leafIds[i + width];
    if (from !== undefined && to !== undefined) addLink(from, to);
  }

  // ③ 汇总端点边（**被传播忽略**，但文档里存在 ⇒ 必须照画、用样式区分）。
  for (let k = 0; k < spec.summaryEdges; k += 1) {
    const from = summaryIds[k % Math.max(1, summaryIds.length)];
    const toIdx = Math.min(100 + k * 37, leaves - 1);
    const to = leafIds[toIdx];
    if (from !== undefined && to !== undefined) addLink(from, to);
  }

  // ④ 随机前向边（补齐到目标条数）：j = i + 1 + floor(rng() * maxJump)。
  // `maxJump` 由 spec 声明（而不是按规模推算）：规模梯度的**局部结构必须一致**，
  // 否则"元素数与文档总规模无关"会被边的跨度分布变化污染，判据就不可读了。
  const maxJump = spec.maxJump ?? 40;
  let guard = 0;
  while (links.length < spec.links && guard < spec.links * 200) {
    guard += 1;
    const i = Math.floor(rng() * leaves);
    const j = i + 1 + Math.floor(rng() * maxJump);
    if (j >= leaves) continue;
    const from = leafIds[i];
    const to = leafIds[j];
    if (from !== undefined && to !== undefined) addLink(from, to);
  }

  if (links.length !== spec.links) {
    throw new Error(
      `数据集 ${spec.key} 未能精确命中依赖条数：期望 ${String(spec.links)}、实得 ${String(links.length)}`,
    );
  }

  // ---------------------------------------------------------------- 派生统计
  const hiddenIds = hiddenChildren(tasks, spec.collapsedSummaries);
  const summaryEdgeIds = links
    .filter((link) => summaryIds.includes(link.from) || summaryIds.includes(link.to))
    .map((link) => link.id);
  const hiddenEdgeIds = links
    .filter((link) => hiddenIds.has(link.from) || hiddenIds.has(link.to))
    .map((link) => link.id);

  /** @type {ProjectDocument} */
  const document = {
    version: 3,
    project: {
      name: `G4-S 夹具·${spec.name}`,
      description: null,
      baseCalendarId: 'project',
      startDate: PROJECT_START_ISO,
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

/**
 * 被折叠隐藏的任务 id（折叠汇总的全部后代）。
 * @param {readonly DocumentTask[]} tasks
 * @param {readonly number[]} collapsedSummaries
 */
export function hiddenChildren(tasks, collapsedSummaries) {
  const collapsedIds = new Set(collapsedSummaries.map((index) => `s${String(index)}`));
  /** @type {Map<string, string[]>} */
  const childrenOf = new Map();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [task.id]);
    else bucket.push(task.id);
  }
  const hidden = new Set();
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

/** @param {readonly DocumentLink[]} links */
function countTypes(links) {
  /** @type {Record<string, number>} */
  const counts = { FS: 0, SS: 0, FF: 0, SF: 0 };
  for (const link of links) counts[link.type] = (counts[link.type] ?? 0) + 1;
  return counts;
}

/** P-8 第 1 条的出/入边（供探测页与 Node 侧共用同一张表）。 */
export function routeSides(type) {
  return ROUTE_SIDES[type] ?? ROUTE_SIDES.FS;
}
