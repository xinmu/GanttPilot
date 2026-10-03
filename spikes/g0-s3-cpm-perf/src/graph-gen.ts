/**
 * 确定性数据生成（同一 `seed` + 同一规格 ⇒ 逐字节同一张图）。
 *
 * 三族数据集对应 [证伪实验计划 §Spike-3](../../../docs/00-baseline/证伪实验计划.md) 的步骤 2：
 * - `wide-shallow`：宽而浅（大量并行、少层级）；
 * - `deep-chain`：深链（1,000 节点单链 + 少量前向跨链）；
 * - `dense-cross`：密集交叉（跨层级、扇入扇出、含少量里程碑）。
 *
 * 另有 `random-dag` / `random-cyclic` 供**独立参照实现差分测试**使用。
 * 所有边都按「拓扑序向前」构造，因此生成物必为 DAG（`random-cyclic` 除外，它刻意加回边）。
 */

import { isoToDayNumber } from './calendar.ts';
import { LINK_TYPE_COUNT, type LinkSpec, type LinkType } from './model.ts';

export const PROJECT_START_ISO = '2026-10-05';
export const PROJECT_START_DAY = isoToDayNumber(PROJECT_START_ISO);

/** mulberry32：32 位确定性 PRNG。 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type DatasetKind = 'wide-shallow' | 'deep-chain' | 'dense-cross' | 'random-dag' | 'random-cyclic';

export interface DatasetSpec {
  readonly id: string;
  readonly kind: DatasetKind;
  readonly taskCount: number;
  readonly linkCount: number;
  readonly seed: number;
  readonly maxDuration: number;
  readonly maxLag?: number;
  readonly milestoneRatio?: number;
}

export interface Dataset {
  readonly id: string;
  readonly kind: DatasetKind;
  readonly taskCount: number;
  readonly linkCount: number;
  readonly durations: Int32Array;
  /** WBS 层级（0 基，仅用于证据与"跨层级"描述，不参与计算）。 */
  readonly level: Int32Array;
  readonly links: LinkSpec[];
  readonly baseDay: number;
}

/** 洗牌：返回 `[0, n)` 的随机排列（Fisher–Yates，确定性）。 */
function shuffledIndices(n: number, rng: () => number): number[] {
  const order: number[] = [];
  for (let i = 0; i < n; i += 1) {
    order.push(i);
  }
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = order[i]!;
    const b = order[j]!;
    order[i] = b;
    order[j] = a;
  }
  return order;
}

function buildDurations(spec: DatasetSpec, rng: () => number): Int32Array {
  const durations = new Int32Array(spec.taskCount);
  const milestoneRatio = spec.milestoneRatio ?? 0;
  for (let i = 0; i < spec.taskCount; i += 1) {
    durations[i] = rng() < milestoneRatio ? 0 : 1 + Math.floor(rng() * spec.maxDuration);
  }
  return durations;
}

/** 宽而浅：3 层（20% / 50% / 30%），边只跨一层，扇入扇出都高。 */
function buildWideShallow(spec: DatasetSpec): Dataset {
  const rng = createRng(spec.seed);
  const first = Math.floor(spec.taskCount * 0.2);
  const second = Math.floor(spec.taskCount * 0.5);
  const levelSizes = [first, second, spec.taskCount - first - second];
  const level = new Int32Array(spec.taskCount);
  const levelStart: number[] = [];
  let cursor = 0;
  for (const [index, size] of levelSizes.entries()) {
    levelStart.push(cursor);
    for (let i = 0; i < size; i += 1) {
      level[cursor] = index;
      cursor += 1;
    }
  }
  const durations = buildDurations(spec, rng);
  const links: LinkSpec[] = [];
  for (let i = 0; i < spec.linkCount; i += 1) {
    const fromLevel = i % 2;
    const pred = levelStart[fromLevel]! + Math.floor(rng() * levelSizes[fromLevel]!);
    const succ = levelStart[fromLevel + 1]! + Math.floor(rng() * levelSizes[fromLevel + 1]!);
    links.push({ pred, succ, type: 0, lag: 0 });
  }
  return {
    id: spec.id,
    kind: spec.kind,
    taskCount: spec.taskCount,
    linkCount: links.length,
    durations,
    level,
    links,
    baseDay: PROJECT_START_DAY,
  };
}

/** 深链：骨干单链占 `N-1` 条边，其余为前向跨链（仍为 DAG）。 */
function buildDeepChain(spec: DatasetSpec): Dataset {
  const rng = createRng(spec.seed);
  const level = new Int32Array(spec.taskCount);
  for (let i = 0; i < spec.taskCount; i += 1) {
    level[i] = Math.min(3, Math.floor((i / Math.max(1, spec.taskCount)) * 4));
  }
  const durations = buildDurations(spec, rng);
  const links: LinkSpec[] = [];
  for (let i = 0; i + 1 < spec.taskCount; i += 1) {
    links.push({ pred: i, succ: i + 1, type: 0, lag: 0 });
  }
  let remaining = spec.linkCount - links.length;
  let attempts = 0;
  const guard = Math.max(64, spec.linkCount * 4);
  while (remaining > 0 && attempts < guard) {
    attempts += 1;
    const pred = Math.floor(rng() * Math.max(1, spec.taskCount - 2));
    const span = 2 + Math.floor(rng() * 40);
    const succ = pred + span;
    if (succ >= spec.taskCount) {
      continue;
    }
    links.push({ pred, succ, type: 0, lag: 0 });
    remaining -= 1;
  }
  return {
    id: spec.id,
    kind: spec.kind,
    taskCount: spec.taskCount,
    linkCount: links.length,
    durations,
    level,
    links,
    baseDay: PROJECT_START_DAY,
  };
}

/** 密集交叉：6 层，边可跨 1–4 层，含扇入热点与少量里程碑。 */
function buildDenseCross(spec: DatasetSpec): Dataset {
  const rng = createRng(spec.seed);
  const levelCount = 6;
  const perLevel = Math.max(1, Math.floor(spec.taskCount / levelCount));
  const level = new Int32Array(spec.taskCount);
  const levelStart = new Int32Array(levelCount);
  const levelSize = new Int32Array(levelCount);
  for (let l = 0; l < levelCount; l += 1) {
    levelStart[l] = l * perLevel;
    levelSize[l] = l === levelCount - 1 ? spec.taskCount - l * perLevel : perLevel;
  }
  for (let l = 0; l < levelCount; l += 1) {
    for (let i = 0; i < levelSize[l]!; i += 1) {
      level[levelStart[l]! + i] = l;
    }
  }
  const durations = buildDurations(spec, rng);
  const links: LinkSpec[] = [];
  const guard = Math.max(64, spec.linkCount * 6);
  let attempts = 0;
  let hotSource = levelStart[0]!;
  while (links.length < spec.linkCount && attempts < guard) {
    attempts += 1;
    const fromLevel = Math.floor(rng() * (levelCount - 1));
    const span = 1 + Math.floor(rng() * 4);
    const toLevel = Math.min(levelCount - 1, fromLevel + span);
    if (toLevel === fromLevel) {
      continue;
    }
    // 一半边从同一「热点」源出发（高扇出），另一半随机（高扇入）。
    const pred =
      rng() < 0.5
        ? hotSource
        : levelStart[fromLevel]! + Math.floor(rng() * levelSize[fromLevel]!);
    if (rng() < 0.1) {
      hotSource = pred;
    }
    const succ = levelStart[toLevel]! + Math.floor(rng() * levelSize[toLevel]!);
    if (succ <= pred) {
      continue;
    }
    links.push({ pred, succ, type: 0, lag: 0 });
  }
  return {
    id: spec.id,
    kind: spec.kind,
    taskCount: spec.taskCount,
    linkCount: links.length,
    durations,
    level,
    links,
    baseDay: PROJECT_START_DAY,
  };
}

/** 随机 DAG：随机拓扑序 + 随机树保证连通 + 随机四类关系与正负 lag。 */
function buildRandomDagInternal(spec: DatasetSpec): { dataset: Dataset; order: readonly number[] } {
  const rng = createRng(spec.seed);
  const n = spec.taskCount;
  const order = shuffledIndices(n, rng);
  const durations = buildDurations(spec, rng);
  const level = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    level[order[i]!] = Math.min(3, Math.floor((i / Math.max(1, n)) * 4));
  }
  const maxLag = spec.maxLag ?? 3;
  const links: LinkSpec[] = [];
  for (let i = 1; i < n; i += 1) {
    const back = Math.floor(rng() * i);
    links.push({
      pred: order[back]!,
      succ: order[i]!,
      type: 0,
      lag: Math.floor(rng() * (maxLag + 1)),
    });
  }
  const guard = Math.max(64, spec.linkCount * 6);
  let attempts = 0;
  while (links.length < spec.linkCount && attempts < guard) {
    attempts += 1;
    const a = Math.floor(rng() * n);
    const b = Math.floor(rng() * n);
    if (a === b) {
      continue;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const type = Math.floor(rng() * LINK_TYPE_COUNT) as LinkType;
    const lag = Math.floor(rng() * (maxLag * 2 + 1)) - maxLag;
    links.push({ pred: order[lo]!, succ: order[hi]!, type, lag });
  }
  return {
    dataset: {
      id: spec.id,
      kind: spec.kind,
      taskCount: n,
      linkCount: links.length,
      durations,
      level,
      links,
      baseDay: PROJECT_START_DAY,
    },
    order,
  };
}

function buildRandomDag(spec: DatasetSpec): Dataset {
  return buildRandomDagInternal(spec).dataset;
}

/**
 * 成环图（差分手）：先建 DAG，再加一条**必然成环**的回边。
 *
 * 构造保证：随机树的每条边都指向拓扑序更靠后的节点，因此 `order[0]` 是所有节点的祖先；
 * 于是 `order[last] → order[0]` 一定成环。
 */
function buildRandomCyclic(spec: DatasetSpec): Dataset {
  const { dataset, order } = buildRandomDagInternal({ ...spec, kind: 'random-dag' });
  const n = dataset.taskCount;
  if (n < 4) {
    throw new RangeError('成环图至少需要 4 个任务');
  }
  const links = [
    ...dataset.links,
    { pred: order[n - 1]!, succ: order[0]!, type: 0 as LinkType, lag: 0 },
  ];
  return {
    ...dataset,
    id: spec.id,
    kind: 'random-cyclic',
    links,
    linkCount: links.length,
  };
}

export function generateDataset(spec: DatasetSpec): Dataset {
  switch (spec.kind) {
    case 'wide-shallow':
      return buildWideShallow(spec);
    case 'deep-chain':
      return buildDeepChain(spec);
    case 'dense-cross':
      return buildDenseCross(spec);
    case 'random-dag':
      return buildRandomDag(spec);
    case 'random-cyclic':
      return buildRandomCyclic(spec);
    default: {
      const exhaustive: never = spec.kind;
      throw new RangeError(`未知数据集类型：${String(exhaustive)}`);
    }
  }
}
