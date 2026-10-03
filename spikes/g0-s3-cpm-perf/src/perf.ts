/**
 * L2 性能测量：把 `edit-sim` 的场景接到 `harness` 的计时骨架上。
 *
 * 三个层面分开测（这是本 spike 最核心的一条口径）：
 * 1. **全量重算**（`computeInto`，含逆向/浮动/关键路径）——门禁 G3-a / IX-04；
 * 2. **后继闭包正向传播**（`ForwardPropagator`，G5 帧内模型）——门禁 G3-b / G3-c；
 * 3. **增删边**（CSR 重建 + 重算）——动态拓扑序维护的代价。
 */

import { ForwardPropagator, buildGraph, computeInto, topologicalOrder } from './cpm.ts';
import { applyScenario, computeState, planScenarios } from './edit-sim.ts';
import { createCalendar } from './calendar.ts';
import type { Dataset } from './graph-gen.ts';
import { measure, type MeasureResult } from './harness.ts';
import { CAL_DEFAULT, type MeasureConfig } from './manifest.ts';
import { ObjectGraphModel, makeCalendarWorkload, makePerHopRecompute } from './negative-control.ts';
import { allocateSchedule } from './model.ts';

export type CaseGrade = 'gate' | 'observation' | 'negative-control';

export interface CalendarNegativeControl {
  readonly queries: number;
  readonly indexed: MeasureResult;
  readonly loopCalendar: MeasureResult;
}

/** NC1：同一批"序号 ↔ 日期"查询，索引日历 vs 逐日循环日历（对齐主干 `countWorkdays` 的实现口径）。 */
export function runCalendarNegativeControl(
  dataset: Dataset,
  config: MeasureConfig,
  resolutionNs: number,
): CalendarNegativeControl {
  const queries = 120;
  const workload = makeCalendarWorkload(dataset, queries);
  const indexed = createCalendar('indexed', CAL_DEFAULT, dataset.baseDay, 900);
  const loopCalendar = createCalendar('loop', CAL_DEFAULT, dataset.baseDay, 900);
  const options = { ...config, resolutionNs };
  return {
    queries,
    indexed: measure('nc1-indexed-calendar', () => void workload.run(indexed), options),
    loopCalendar: measure('nc1-loop-calendar', () => void workload.run(loopCalendar), options),
  };
}

export interface PerfCase {
  readonly id: string;
  readonly datasetId: string;
  readonly operation: string;
  readonly grade: CaseGrade;
  readonly result: MeasureResult;
  /** 结构性事实（访问量、规模），与计时无关，用于解释数字。 */
  readonly structural: string;
}

export interface SkippedCase {
  readonly id: string;
  readonly reason: string;
}

export interface DatasetPerf {
  readonly datasetId: string;
  readonly taskCount: number;
  readonly linkCount: number;
  readonly levelCount: number;
  readonly criticalTasks: number;
  readonly projectFinish: number;
  readonly cases: readonly PerfCase[];
  readonly skipped: readonly SkippedCase[];
  /** 供负向对照计算比值：闭包传播基准（µs）。 */
  readonly nonCriticalPropagationUs: number | null;
  readonly criticalPropagationUs: number | null;
  readonly perHopRecomputeUs: number | null;
  readonly objectGraphPropagationUs: number | null;
  readonly visitedNonCritical: number | null;
  readonly visitedCritical: number | null;
}

function caseOf(
  datasetId: string,
  operation: string,
  grade: CaseGrade,
  result: MeasureResult,
  structural: string,
): PerfCase {
  return { id: `${datasetId}/${operation}`, datasetId, operation, grade, result, structural };
}

export function runDatasetPerf(
  dataset: Dataset,
  config: MeasureConfig,
  grade: CaseGrade,
  resolutionNs: number,
  withNegativeControls: boolean,
): DatasetPerf {
  const options = { ...config, resolutionNs };
  const state = computeState(dataset);
  const { graph, order, schedule } = state;
  const durations = dataset.durations;
  const out = allocateSchedule(dataset.taskCount);
  const cases: PerfCase[] = [];
  const skipped: SkippedCase[] = [];

  const fullStructural = `V=${String(dataset.taskCount)}，E=${String(graph.linkCount)}，访问 ${
    dataset.taskCount + graph.linkCount
  } 个元素`;

  cases.push(
    caseOf(
      dataset.id,
      'full-recompute',
      grade,
      measure(`${dataset.id}/full-recompute`, () => {
        computeInto(graph, durations, order, out);
      }, options),
      fullStructural,
    ),
  );
  // 后续测量共用 `out`；`computeInto` 每次都完整写入，无需额外同步。

  let criticalTasks = 0;
  for (let i = 0; i < dataset.taskCount; i += 1) {
    if (schedule.critical[i] === 1) {
      criticalTasks += 1;
    }
  }

  const propagator = new ForwardPropagator(graph);
  const propagationOut = allocateSchedule(dataset.taskCount);
  let nonCriticalPropagationUs: number | null = null;
  let criticalPropagationUs: number | null = null;
  let perHopRecomputeUs: number | null = null;
  let objectGraphPropagationUs: number | null = null;
  let visitedNonCritical: number | null = null;
  let visitedCritical: number | null = null;

  let levelCount = 0;
  for (let i = 0; i < dataset.taskCount; i += 1) {
    levelCount = Math.max(levelCount, dataset.level[i]! + 1);
  }

  const plans = planScenarios(dataset, state);
  for (const plan of plans) {
    if (plan.scenario === null) {
      skipped.push({ id: `${dataset.id}/${plan.reason}`, reason: plan.reason });
      continue;
    }
    const scenario = plan.scenario;
    const variants = applyScenario(dataset, scenario);

    if (scenario.kind === 'duration-noncritical' || scenario.kind === 'duration-critical') {
      const seeds = [scenario.target];
      propagationOut.es.set(schedule.es);
      propagationOut.ef.set(schedule.ef);
      const firstRun = propagator.run(seeds, variants.durations, propagationOut);
      const operation =
        scenario.kind === 'duration-noncritical' ? 'propagate-noncritical' : 'propagate-critical';
      const result = measure(
        `${dataset.id}/${operation}`,
        () => {
          propagator.run(seeds, variants.durations, propagationOut);
        },
        options,
      );
      cases.push(
        caseOf(
          dataset.id,
          operation,
          grade,
          result,
          `后继闭包 ${String(firstRun.visited)} 个任务、${String(firstRun.updated)} 个被更新（${scenario.note}）`,
        ),
      );

      if (scenario.kind === 'duration-noncritical') {
        nonCriticalPropagationUs = result.p99;
        visitedNonCritical = firstRun.visited;
      } else {
        visitedCritical = firstRun.visited;
        criticalPropagationUs = result.p99;
        // 松手后的合并重算（IX-04 口径）
        cases.push(
          caseOf(
            dataset.id,
            'full-recompute-after-critical-edit',
            grade,
            measure(
              `${dataset.id}/full-recompute-after-critical-edit`,
              () => {
                computeInto(graph, variants.durations, order, out);
              },
              options,
            ),
            `含逆向/浮动/关键路径（${scenario.note}）`,
          ),
        );

        // 负向对照刻意绑在**闭包最大**的场景上：非关键编辑的闭包往往只有几个节点，
        // 在这种规模上比较"数据布局/每跳重算"会被噪声淹没（实测同一台机器上比值可在 0.5×–2× 间跳）。
        if (withNegativeControls) {
          const hops = firstRun.visited;
          const perHop = makePerHopRecompute(graph, variants.durations, order, out, hops);
          const perHopResult = measure(`${dataset.id}/nc2-per-hop-recompute`, perHop, {
            ...options,
            iterations: Math.max(3, Math.min(10, config.iterations)),
            suites: 3,
          });
          cases.push(
            caseOf(
              dataset.id,
              'nc2-per-hop-recompute',
              'negative-control',
              perHopResult,
              `对闭包内 ${String(hops)} 个任务各做一次全量重算（与 \`propagate-critical\` 对照）`,
            ),
          );
          perHopRecomputeUs = perHopResult.p99;

          const objectModel = new ObjectGraphModel(dataset);
          objectModel.seedFrom(schedule.es, schedule.ef);
          objectModel.setDuration(scenario.target, variants.durations[scenario.target]!);
          const objectResult = measure(
            `${dataset.id}/nc3-object-graph-propagation`,
            () => {
              objectModel.propagate(seeds);
            },
            options,
          );
          cases.push(
            caseOf(
              dataset.id,
              'nc3-object-graph-propagation',
              'negative-control',
              objectResult,
              `同一编辑、同一语义，改为 Map + 对象图（闭包 ${String(hops)} 个任务，与 \`propagate-critical\` 对照）`,
            ),
          );
          objectGraphPropagationUs = objectResult.p99;
        }
      }
      continue;
    }

    // 增删边：CSR 重建 + 重算（+ 闭包传播）
    const operation = scenario.kind === 'edge-add' ? 'edge-add' : 'edge-remove';
    const rebuildResult = measure(
      `${dataset.id}/${operation}-rebuild`,
      () => {
        buildGraph(dataset.taskCount, variants.links);
      },
      options,
    );
    cases.push(
      caseOf(
        dataset.id,
        `${operation}-rebuild`,
        grade,
        rebuildResult,
        `重建 CSR 邻接（V=${String(dataset.taskCount)}，E=${String(variants.links.length)}）`,
      ),
    );

    const rebuilt = buildGraph(dataset.taskCount, variants.links).graph;
    const rebuiltOrder = topologicalOrder(rebuilt).order;
    const rebuiltOut = allocateSchedule(dataset.taskCount);
    cases.push(
      caseOf(
        dataset.id,
        `${operation}-recompute`,
        grade,
        measure(
          `${dataset.id}/${operation}-recompute`,
          () => {
            computeInto(rebuilt, variants.durations, rebuiltOrder, rebuiltOut);
          },
          options,
        ),
        `重建后的全量重算（${scenario.note}）`,
      ),
    );

    const rebuiltPropagator = new ForwardPropagator(rebuilt);
    const rebuiltPropagationOut = allocateSchedule(dataset.taskCount);
    rebuiltPropagationOut.es.set(schedule.es);
    rebuiltPropagationOut.ef.set(schedule.ef);
    const seed = scenario.kind === 'edge-add' ? scenario.target : (scenario.link?.succ ?? 0);
    const closureVisited = rebuiltPropagator.run([seed], variants.durations, rebuiltPropagationOut).visited;
    cases.push(
      caseOf(
        dataset.id,
        `${operation}-propagate`,
        grade,
        measure(
          `${dataset.id}/${operation}-propagate`,
          () => {
            rebuiltPropagator.run([seed], variants.durations, rebuiltPropagationOut);
          },
          options,
        ),
        `重建后只传播受影响子图（闭包 ${String(closureVisited)} 个任务）`,
      ),
    );
  }

  return {
    datasetId: dataset.id,
    taskCount: dataset.taskCount,
    linkCount: dataset.linkCount,
    levelCount,
    criticalTasks,
    projectFinish: schedule.projectFinish,
    cases,
    skipped,
    nonCriticalPropagationUs,
    criticalPropagationUs,
    perHopRecomputeUs,
    objectGraphPropagationUs,
    visitedNonCritical,
    visitedCritical,
  };
}
