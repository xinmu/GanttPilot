/**
 * 演示数据与"夹具文档"的构造入口。
 *
 * 与 spec、`scripts/measure-render.mjs` **同源**：都是 `render-core` 的确定性夹具生成器。
 * 单独成文件的原因：`App.vue` 与 `measure.ts` 的接线都要它，而 `App.vue` 里不应出现
 * "怎么造文档"的细节。
 */

import {
  DATASETS,
  generateDocument,
  PRIMARY_DATASET_KEY,
  REFERENCE_DATASET,
  reindexDocument,
  scaleGradient,
  type FixtureSpec,
  type ProjectDocument,
} from '@ganttpilot/render-core';

/** 按数据集键造一份"落库前规范化过"的文档（`outlineNumber` 是派生值，ADR 0002 ③）。 */
export function createDemoDocumentOf(key?: string): ProjectDocument {
  const spec = specOf(key);
  return reindexDocument(generateDocument(spec).document);
}

/** 主口径演示文档（1,000 任务 / 1,500 依赖的密集交叉）。 */
export function createPrimaryDemoDocument(): ProjectDocument {
  return createDemoDocumentOf(PRIMARY_DATASET_KEY);
}

/** 数据集规格（未知键回落到主口径）。 */
export function specOf(key?: string): FixtureSpec {
  if (key === REFERENCE_DATASET.key) return REFERENCE_DATASET;
  const match = DATASETS.find((item) => item.key === key);
  if (match !== undefined) return match;
  const primary = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY);
  if (primary === undefined) throw new Error('缺少主口径数据集');
  return primary;
}

/** 可选的数据集清单（工具栏"换夹具"用；规模梯度只取 200/500 两个小档避免误点）。 */
export function demoDatasetChoices(): readonly { readonly key: string; readonly label: string; readonly tasks: number; readonly links: number }[] {
  const base = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY) ?? DATASETS[0];
  const small = base === undefined ? [] : scaleGradient(base, [200, 500], 1.5);
  return [
    ...DATASETS.map((spec) => ({ key: spec.key, label: spec.name, tasks: spec.tasks, links: spec.links })),
    { key: REFERENCE_DATASET.key, label: REFERENCE_DATASET.name, tasks: REFERENCE_DATASET.tasks, links: REFERENCE_DATASET.links },
    ...small.map((item) => ({
      key: item.fixture.spec.key,
      label: item.fixture.spec.name,
      tasks: item.fixture.spec.tasks,
      links: item.fixture.spec.links,
    })),
  ];
}

/** 小档夹具（"轻量演示"用，避免每次改文档都等大夹具生成）。 */
export function createSmallDemoDocument(size: 200 | 500 = 200): ProjectDocument {
  const base = DATASETS.find((item) => item.key === PRIMARY_DATASET_KEY) ?? DATASETS[0];
  if (base === undefined) throw new Error('缺少主口径数据集');
  const item = scaleGradient(base, [size], 1.5)[0];
  if (item === undefined) throw new Error('规模梯度生成失败');
  return reindexDocument(generateDocument(item.fixture.spec).document);
}
