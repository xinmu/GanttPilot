/**
 * 夹具口径：把 URL/钩子给的键解析成 `render-core` 的 `FixtureSpec`。
 *
 * **规模口径与演示口径是两件事**（见 `useProject` 的说明）：本文件只管前者；
 * `dense-2000` 这个键**只在这里**被认识（G6 出口条件④ 的载体），因此
 * `App.vue` 的 `buildFixtureDocument` 必须走 {@link specOfDataset}，否则会静默退回主口径。
 */

import { DATASETS, PRIMARY_DATASET_KEY, REFERENCE_DATASET, scaleGradient, type FixtureSpec } from '@ganttpilot/render-core';

/** 取数据集规格（`dense` 是主口径；`dense2200` 是《评估报告》§5.4 的同尺对照）。 */
/** 出口条件④的规模：2,000 任务（**依赖密度与主口径同比**，见 `scaleGradient`）。 */
export const STORAGE_METRICS_DATASET_KEY = 'dense-2000';

/** 2,000 任务夹具的规格（首次用到时生成一次并缓存——它要跑一遍 `compute`，不便宜）。 */
let storageMetricsSpec: FixtureSpec | null = null;

function storageMetricsSpecOf(): FixtureSpec {
  storageMetricsSpec ??= scaleGradient(
    DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY) ?? DATASETS[0]!,
    [2000],
  )[0]!.fixture.spec;
  return storageMetricsSpec;
}

export function specOfDataset(key: string): FixtureSpec {
  if (key === STORAGE_METRICS_DATASET_KEY) return storageMetricsSpecOf();
  if (key === REFERENCE_DATASET.key) return REFERENCE_DATASET;
  const match = DATASETS.find((item) => item.key === key);
  if (match !== undefined) return match;
  const primary = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY);
  if (primary === undefined) throw new Error('缺少主口径数据集');
  return primary;
}
