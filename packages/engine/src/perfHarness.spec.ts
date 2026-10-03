import { describe, expect, it } from 'vitest';

import { Calendar, isoToDayNumber } from './date.js';
import { type DocumentLink, type ProjectDocument } from './schema.js';
import { LEAF_SENTINEL, compute } from './schedule.js';

/**
 * **测试侧计时设施 + 性能负向对照**（故意写成 `*.spec.ts` 以便被 `schedule.performance.spec.ts` import，
 * 且不进发布产物）。
 *
 * 计时口径照 [S3 结论 §三.3/§五.6](../../../spikes/g0-s3-cpm-perf/结论.md)：
 * - `process.hrtime.bigint()`；
 * - **批量计时**（单次预算只有几十微秒，本机计时器分辨率约 100 ns，不批量会把 p50 测成"等于分辨率"）；
 * - **median-of-suites**（每场景多个 suite，各 suite 内取分位数，再对 suite 取中位数）。
 *
 * `naiveSchedule` 是 ADR 0004 §9 ⑤ 要求的**性能侧负向对照**：一份**已知更慢**但结果相同的实现
 * （`Map` + 对象邻接 + 定点松弛，无拓扑序、无 CSR、无类型化数组——与 S3 的 NC3 同思路）。
 * 若"快实现"与它的差距量不出来，说明计时骨架没有判别力。
 */

/** 分位数（0..1）。 */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface Measured {
  /** 每个 suite 的 p50，再取中位数（纳秒）。 */
  readonly medianP50: number;
  readonly medianP95: number;
  readonly medianP99: number;
  /** 最差 suite 的 p99（S3 的留痕口径）。 */
  readonly worstP99: number;
  readonly batchSize: number;
  readonly suites: number;
  readonly batchesPerSuite: number;
  readonly minBatchNs: number;
}

export interface MeasureOptions {
  readonly suites?: number;
  readonly batchesPerSuite?: number;
  /**
   * 单批的最小耗时（纳秒）；批量大小按它校准。默认 **2 ms**——
   * 单次 `compute` 约 0.3 ms，若阈值太小（如 200 µs）校准会把 `batchSize` 留在 1，
   * 于是每次迭代只测一次，GC/调度噪声会直接落在 p99 上（实测最差 suite p99 会因此虚高 3–4×）。
   */
  readonly minBatchNs?: number;
}

/**
 * 测量单次操作耗时（纳秒）。
 *
 * 先校准 `batchSize`，使一批的耗时 ≥ `minBatchNs`（本机分辨率约 100 ns，留 2000× 余量）；
 * 再在多个 suite 上各跑 `batchesPerSuite` 批，记录每批的"单次均摊耗时"，对 suite 内取分位数，
 * 最后对 suite 取中位数。
 */
export function measureOps(run: () => void, options: MeasureOptions = {}): Measured {
  const suites = options.suites ?? 5;
  const batchesPerSuite = options.batchesPerSuite ?? 200;
  const minBatchNs = options.minBatchNs ?? 2_000_000;

  // **先预热**（JIT + 内联缓存），否则校准会把"首次调用最慢"当成校准依据：
  // 实测过 `batchSize` 卡在 1 的情况——那会让 p99 被单次 GC/调度噪声主导（虚高 3–5×）。
  const warmupStart = process.hrtime.bigint();
  let warmups = 0;
  while (Number(process.hrtime.bigint() - warmupStart) < 50_000_000 && warmups < 100_000) {
    run();
    warmups += 1;
  }

  let batchSize = 1;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < batchSize; i += 1) {
      run();
    }
    const elapsed = Number(process.hrtime.bigint() - start);
    if (elapsed >= minBatchNs) {
      break;
    }
    const factor = elapsed <= 0 ? 8 : Math.min(8, Math.max(2, Math.ceil((minBatchNs / elapsed) * 1.2)));
    batchSize *= factor;
  }

  const suiteP50: number[] = [];
  const suiteP95: number[] = [];
  const suiteP99: number[] = [];
  for (let suite = 0; suite < suites; suite += 1) {
    const perOp: number[] = [];
    for (let batch = 0; batch < batchesPerSuite; batch += 1) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < batchSize; i += 1) {
        run();
      }
      perOp.push(Number(process.hrtime.bigint() - start) / batchSize);
    }
    perOp.sort((a, b) => a - b);
    suiteP50.push(percentile(perOp, 0.5));
    suiteP95.push(percentile(perOp, 0.95));
    suiteP99.push(percentile(perOp, 0.99));
  }

  return {
    medianP50: median(suiteP50),
    medianP95: median(suiteP95),
    medianP99: median(suiteP99),
    worstP99: Math.max(...suiteP99),
    batchSize,
    suites,
    batchesPerSuite,
    minBatchNs,
  };
}

/** 纳秒 → 人类可读（用于把实测数值写进日志与落地记录）。 */
export function formatNs(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} ms`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)} µs`;
  }
  return `${value.toFixed(1)} ns`;
}

// ---------------------------------------------------------------- 负向对照实现

/**
 * **已知更慢**的等价实现（只用 `Map` + 对象邻接 + 定点松弛）。
 *
 * 限制（刻意）：只支持"每个叶子都有显式 `durationDays`"的文档，且不支持会话锚点——
 * 性能对照只需要一份能算出同样 ES/EF 的慢实现。
 */
export function naiveSchedule(
  document: ProjectDocument,
  calendar: Calendar,
): { readonly es: Map<string, number>; readonly ef: Map<string, number>; readonly passes: number } {
  const tasks = document.tasks;
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((id): id is string => id !== null));
  const isSummary = (id: string): boolean => parentIds.has(id);

  const predecessors = new Map<string, { from: string; type: string; lag: number }[]>();
  for (const task of tasks) {
    predecessors.set(task.id, []);
  }
  for (const link of document.links) {
    if (isSummary(link.from) || isSummary(link.to)) {
      continue;
    }
    predecessors.get(link.to)?.push({ from: link.from, type: link.type, lag: link.lagDays });
  }

  const clampDay = (day: number): number => (day < calendar.baseDay ? calendar.baseDay : day);
  const ordinalOf = (iso: string | null): number | null =>
    iso === null ? null : (calendar.ordinalOfDay(clampDay(isoToDayNumber(iso))) as number);

  const projectStart =
    ordinalOf(document.project.startDate) ??
    (() => {
      const known = tasks.map((task) => ordinalOf(task.startDate)).filter((value): value is number => value !== null);
      return known.length > 0 ? Math.min(...known) : 0;
    })();

  const durations = new Map<string, number>();
  const documentStarts = new Map<string, number | null>();
  const leaves: string[] = [];
  for (const task of tasks) {
    if (isSummary(task.id)) {
      continue;
    }
    leaves.push(task.id);
    durations.set(task.id, task.durationDays ?? 0);
    documentStarts.set(task.id, ordinalOf(task.startDate));
  }

  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of leaves) {
    es.set(id, projectStart);
    ef.set(id, projectStart + (durations.get(id) ?? 0));
  }

  let passes = 0;
  const maxPasses = leaves.length + 2;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    passes = pass + 1;
    let changed = false;
    for (const id of leaves) {
      const edges = predecessors.get(id) ?? [];
      const duration = durations.get(id) ?? 0;
      let raw: number;
      if (edges.length === 0) {
        raw = documentStarts.get(id) ?? projectStart;
      } else {
        raw = Number.NEGATIVE_INFINITY;
        for (const edge of edges) {
          const predEs = es.get(edge.from) ?? projectStart;
          const predEf = ef.get(edge.from) ?? projectStart;
          const bound =
            edge.type === 'FS'
              ? predEf + edge.lag
              : edge.type === 'SS'
                ? predEs + edge.lag
                : edge.type === 'FF'
                  ? predEf + edge.lag - duration
                  : predEs + edge.lag - duration;
          if (bound > raw) {
            raw = bound;
          }
        }
      }
      if (raw < projectStart) {
        raw = projectStart;
      }
      if (es.get(id) !== raw || ef.get(id) !== raw + duration) {
        es.set(id, raw);
        ef.set(id, raw + duration);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return { es, ef, passes };
}

/** 对照实现与本实现的深比较（证明它不是"什么都没做"的稻草人）。 */
export function naiveMatchesCompute(document: ProjectDocument, calendar: Calendar): boolean {
  const result = compute(document, calendar);
  if (!result.ok) {
    return false;
  }
  const naive = naiveSchedule(document, calendar);
  for (let i = 0; i < document.tasks.length; i += 1) {
    const task = document.tasks[i]!;
    if (result.schedule.es[i] === LEAF_SENTINEL) {
      continue;
    }
    if (naive.es.get(task.id) !== result.schedule.es[i] || naive.ef.get(task.id) !== result.schedule.ef[i]) {
      return false;
    }
  }
  return true;
}

/** 造一条 1,000 节点的深链（用于"深链不得依赖调用栈"的结构性断言）。 */
export function deepChainDocument(length: number): { readonly document: ProjectDocument; readonly links: DocumentLink[] } {
  const tasks = Array.from({ length }, (_, index) => ({
    id: `t${String(index)}`,
    parentId: null,
    outlineNumber: String(index + 1),
    name: `任务 ${String(index)}`,
    startDate: index === 0 ? '2026-10-05' : null,
    endDate: null,
    durationDays: 2,
    progress: null,
    milestone: false,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
  }));
  const links: DocumentLink[] = [];
  for (let i = 0; i + 1 < length; i += 1) {
    links.push({ id: `l${String(i)}`, from: `t${String(i)}`, to: `t${String(i + 1)}`, type: 'FS', lagDays: 0 });
  }
  return {
    document: {
      version: 3,
      project: { name: '深链', description: null, baseCalendarId: 'project', startDate: '2026-10-05', finishDate: null },
      calendars: [{ id: 'project', exceptions: { nonWorking: [], working: [] } }],
      tasks,
      links,
      baselines: [],
    },
    links,
  };
}

describe('计时设施与负向对照的自检', () => {
  it('measureOps 给出有序分位数，且分批大小经过校准（>1，不是单次测量）', () => {
    let counter = 0;
    const measured = measureOps(
      () => {
        counter += 1;
      },
      { suites: 2, batchesPerSuite: 20, minBatchNs: 1_000_000 },
    );
    expect(counter).toBeGreaterThan(0);
    expect(measured.batchSize).toBeGreaterThan(1);
    expect(measured.medianP50).toBeGreaterThan(0);
    expect(measured.medianP50).toBeLessThanOrEqual(measured.medianP95);
    expect(measured.medianP95).toBeLessThanOrEqual(measured.medianP99);
    expect(measured.worstP99).toBeGreaterThanOrEqual(measured.medianP99);
    expect(formatNs(measured.medianP50)).toMatch(/(ns|µs|ms)$/);
  });

  it('朴素实现在小文档上与 compute 一致（不是稻草人），深链夹具形状正确', () => {
    const chain = deepChainDocument(5);
    expect(chain.document.tasks).toHaveLength(5);
    expect(chain.document.links).toHaveLength(4);
    const calendar = new Calendar(chain.document.calendars[0]!, {
      baseDay: isoToDayNumber('2026-10-05'),
      spanDays: 400,
    });
    expect(naiveMatchesCompute(chain.document, calendar)).toBe(true);
    const naive = naiveSchedule(chain.document, calendar);
    expect(naive.es.get('t4')).toBe(8);
    expect(naive.ef.get('t4')).toBe(10);
    // `passes` 会随链长增长：说明它真的是定点松弛，不是一次遍历。
    expect(naive.passes).toBeGreaterThan(1);
  });
});
