/**
 * 夹具装配：`generateDocument` → `reindexDocument` → `validateDocument` → `createScheduleCalendar` + `compute`。
 *
 * **本模块消费引擎的构建产物（`packages/engine/dist`），不重复实现排程**：
 * 探针要回答的是"渲染几何与裁剪"，排程的真相源必须是 G2 的产品代码本身。
 * 前置条件（`dist` 存在且比 `src` 新）由 `run-all.mts` 在跑之前校验。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').Calendar} Calendar
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').Schedule} Schedule
 */

import {
  compute,
  createScheduleCalendar,
  reindexDocument,
  serializeDocument,
  validateDocument,
} from '../../../packages/engine/dist/index.js';
import { generateDocument } from './graph-gen.mjs';

/**
 * 造一份可排程的夹具。
 * @param {Parameters<typeof generateDocument>[0]} spec
 */
export function buildFixture(spec) {
  const generated = generateDocument(spec);
  const document = reindexDocument(generated.document);
  const validation = validateDocument(document);
  const errors = validation.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`夹具 ${spec.key} 未通过 schema 校验：${JSON.stringify(errors.slice(0, 3))}`);
  }
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) {
    throw new Error(`夹具 ${spec.key} 不可排程（code=${result.code}）：${result.message}`);
  }
  return {
    spec,
    document,
    stats: generated.stats,
    calendar,
    schedule: result.schedule,
    validation: { errors, count: validation.length, diagnostics: validation },
    diagnostics: result.schedule.diagnostics,
  };
}

/**
 * 规模梯度：同一形态、不同规模（依赖密度同比），用于 S4-a 的"与规模无关"。
 * @param {Parameters<typeof generateDocument>[0]} baseSpec
 * @param {readonly number[]} sizes
 * @param {number} linkRatio
 */
export function scaleGradientFixtures(baseSpec, sizes, linkRatio) {
  return sizes.map((size) => {
    // **局部结构必须与规模无关**：每 20 个任务一个汇总（即每个汇总 19 个子任务），
    // 否则"窗口内容"会随规模变化，"元素数与规模无关"就测成了别的东西。
    const summaries = Math.max(1, Math.round(size / 20));
    const spec = {
      ...baseSpec,
      key: `${baseSpec.key}-${String(size)}`,
      name: `${baseSpec.name}·${String(size)} 任务`,
      tasks: size,
      links: Math.round(size * linkRatio),
      summaries,
      milestones: Math.max(1, Math.round(size * 0.05)),
      longEdges: baseSpec.longEdges,
      summaryEdges: summaries > 0 ? baseSpec.summaryEdges : 0,
    };
    return { size, fixture: buildFixture(spec) };
  });
}

/** 规范化序列化（同时证明夹具是合法文档：`serializeDocument` 内部会校验）。 */
export function fixtureJson(fixture) {
  return serializeDocument(fixture.document);
}

/**
 * 便于证据渲染：把诊断码压成一行。
 * @param {ReturnType<typeof buildFixture>} fixture
 */
export function describeValidation(fixture) {
  const codes = new Map();
  for (const diagnostic of fixture.validation.diagnostics) {
    codes.set(diagnostic.code, (codes.get(diagnostic.code) ?? 0) + 1);
  }
  return [...codes.entries()]
    .map(([code, count]) => `${code}×${String(count)}`)
    .join('、');
}
