/**
 * 计时骨架。
 *
 * 三条纪律（写进结论的边界章节）：
 * 1. **用 `process.hrtime.bigint()`**（纳秒），不用 `Date.now()`；
 * 2. **计时器分辨率守卫**：单次操作的实测耗时若低于「10 × 分辨率」，就按 `batchSize` 批量计时
 *    再折算到单次——否则 p50 会等于分辨率、结论失真；
 * 3. **median-of-suites**：同一场景跑多个 suite，取各 suite 分位数的中位数作为门禁判定值
 *    （单次 suite 的 p99 受瞬时负载影响，不能直接当判据），同时记录最差 suite。
 */

export interface MeasureOptions {
  readonly warmup: number;
  readonly iterations: number;
  readonly suites: number;
  readonly resolutionNs: number;
}

export interface MeasureResult {
  readonly label: string;
  /** 单位统一为微秒（µs）；报告里再换成 ms。 */
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** 最差 suite 的 p99（透明度用，不作为判据）。 */
  readonly worstP99: number;
  readonly minUs: number;
  readonly maxUs: number;
  readonly suiteP50: number[];
  readonly suiteP95: number[];
  readonly suiteP99: number[];
  readonly iterations: number;
  readonly suites: number;
  readonly batchSize: number;
  readonly belowResolution: boolean;
}

export function measureTimerResolutionNs(): number {
  let minDelta = Number.POSITIVE_INFINITY;
  let previous = process.hrtime.bigint();
  for (let i = 0; i < 200_000; i += 1) {
    const current = process.hrtime.bigint();
    const delta = Number(current - previous);
    if (delta > 0 && delta < minDelta) {
      minDelta = delta;
    }
    previous = current;
  }
  return Number.isFinite(minDelta) ? minDelta : 1;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** nearest-rank 分位（`q` ∈ (0,1]）。 */
export function percentile(values: Float64Array, q: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = Float64Array.from(values).sort();
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

export function measure(label: string, fn: () => void, options: MeasureOptions): MeasureResult {
  const { warmup, iterations, suites, resolutionNs } = options;

  // 校准：估计单次耗时，据此决定批量大小（保证每个样本 ≥ 10 × 分辨率）。
  const calibrationIterations = 32;
  const calibrationStart = process.hrtime.bigint();
  for (let i = 0; i < calibrationIterations; i += 1) {
    fn();
  }
  const calibrationNs = Number(process.hrtime.bigint() - calibrationStart) / calibrationIterations;
  const targetNs = Math.max(1, resolutionNs * 10);
  const batchSize = calibrationNs > 0 ? Math.max(1, Math.ceil(targetNs / calibrationNs)) : 1;

  const suiteP50: number[] = [];
  const suiteP95: number[] = [];
  const suiteP99: number[] = [];
  let globalMin = Number.POSITIVE_INFINITY;
  let globalMax = 0;
  let minBatchElapsedNs = Number.POSITIVE_INFINITY;

  for (let suite = 0; suite < suites; suite += 1) {
    for (let i = 0; i < warmup; i += 1) {
      fn();
    }
    const samples = new Float64Array(iterations);
    for (let i = 0; i < iterations; i += 1) {
      const start = process.hrtime.bigint();
      for (let b = 0; b < batchSize; b += 1) {
        fn();
      }
      const elapsedNs = Number(process.hrtime.bigint() - start);
      if (elapsedNs < minBatchElapsedNs) {
        minBatchElapsedNs = elapsedNs;
      }
      const perOpUs = elapsedNs / batchSize / 1000;
      samples[i] = perOpUs;
      if (perOpUs < globalMin) {
        globalMin = perOpUs;
      }
      if (perOpUs > globalMax) {
        globalMax = perOpUs;
      }
    }
    suiteP50.push(percentile(samples, 0.5));
    suiteP95.push(percentile(samples, 0.95));
    suiteP99.push(percentile(samples, 0.99));
  }

  return {
    label,
    p50: median(suiteP50),
    p95: median(suiteP95),
    p99: median(suiteP99),
    worstP99: Math.max(...suiteP99),
    minUs: globalMin,
    maxUs: globalMax,
    suiteP50,
    suiteP95,
    suiteP99,
    iterations,
    suites,
    batchSize,
    // 分辨率守卫针对**批次耗时**：批量计时后单次耗时由 ≥10× 分辨率的批次折算得出。
    belowResolution: minBatchElapsedNs < resolutionNs * 10,
  };
}

export function usToMs(us: number, digits = 3): string {
  return (us / 1000).toFixed(digits);
}

export function formatUs(us: number): string {
  if (us >= 1000) {
    return `${(us / 1000).toFixed(3)} ms`;
  }
  return `${us.toFixed(2)} µs`;
}
