/**
 * 编辑场景：把「拖拽/编辑」抽象成四类，供性能测量使用。
 *
 * - `duration-noncritical`：非关键任务工期 +3 工作日（G5 帧内传播的典型情形）；
 * - `duration-critical`：关键任务工期 +3 工作日（预期引发 O(V) 的浮动/关键路径位移，G3-c）；
 * - `edge-add` / `edge-remove`：增删依赖边（动态拓扑序维护的最坏情形）。
 *
 * 场景只描述"改什么"，不描述"怎么测"（测量在 `perf.ts`）。
 */

import { ForwardPropagator, buildGraph, computeInto, topologicalOrder, type Graph } from './cpm.ts';
import type { Dataset } from './graph-gen.ts';
import { createRng } from './graph-gen.ts';
import { allocateSchedule, type LinkSpec, type Schedule } from './model.ts';

export type ScenarioKind = 'duration-noncritical' | 'duration-critical' | 'edge-add' | 'edge-remove';

export interface Scenario {
  readonly id: string;
  readonly kind: ScenarioKind;
  readonly datasetId: string;
  /** 被改动的任务（工期编辑的种子）。 */
  readonly target: number;
  readonly delta: number;
  /** 边编辑涉及的依赖（`edge-remove` 时为被删掉的那条）。 */
  readonly link: LinkSpec | null;
  /** 边编辑在 `dataset.links` 中的下标（`edge-remove` 用）。 */
  readonly linkIndex: number;
  readonly note: string;
}

export interface ScenarioPlan {
  readonly scenario: Scenario | null;
  readonly reason: string;
}

export interface GraphState {
  readonly graph: Graph;
  readonly order: Int32Array;
  readonly schedule: Schedule;
}

export function computeState(dataset: Dataset): GraphState {
  const { graph } = buildGraph(dataset.taskCount, dataset.links);
  const { order, cycleNodes } = topologicalOrder(graph);
  if (cycleNodes !== null) {
    throw new RangeError(`数据集 ${dataset.id} 含环，无法用于性能场景`);
  }
  const schedule = allocateSchedule(dataset.taskCount);
  computeInto(graph, dataset.durations, order, schedule);
  return { graph, order, schedule };
}

export interface EditVariants {
  readonly durations: Int32Array;
  readonly links: LinkSpec[];
}

export function applyScenario(dataset: Dataset, scenario: Scenario): EditVariants {
  const durations = Int32Array.from(dataset.durations);
  const links = [...dataset.links];
  if (scenario.kind === 'duration-noncritical' || scenario.kind === 'duration-critical') {
    const current = durations[scenario.target]!;
    durations[scenario.target] = Math.max(0, current + scenario.delta);
  } else if (scenario.kind === 'edge-add' && scenario.link !== null) {
    links.push(scenario.link);
  } else if (scenario.kind === 'edge-remove') {
    links.splice(scenario.linkIndex, 1);
  }
  return { durations, links };
}

function successorClosureSize(state: GraphState, seed: number): number {
  const durations = new Int32Array(state.schedule.taskCount);
  const scratch = allocateSchedule(state.schedule.taskCount);
  const propagator = new ForwardPropagator(state.graph);
  return propagator.run([seed], durations, scratch).visited;
}

/** 规划一个数据集上的四类场景（无法构造时给出明确原因，不静默跳过）。 */
export function planScenarios(dataset: Dataset, state: GraphState): ScenarioPlan[] {
  const rng = createRng(dataset.taskCount * 7919 + 13);
  const { schedule, graph, order } = state;
  const plans: ScenarioPlan[] = [];
  const delta = 3;

  // 1) 非关键任务：在"有后继且总浮动 > 0"的任务里取**后继闭包最大**者。
  //    刻意取最坏情形：只挑一个叶子任务会把 G3-b 测成"什么都不做"（实测闭包可只有 1 个任务）。
  const nonCriticalCandidates: number[] = [];
  for (let i = 0; i < dataset.taskCount; i += 1) {
    if (schedule.totalFloat[i]! > 0 && graph.succOffset[i + 1]! > graph.succOffset[i]!) {
      nonCriticalCandidates.push(i);
    }
  }
  let nonCritical = -1;
  let nonCriticalClosure = -1;
  let nonCriticalFloat = 0;
  const nonCriticalSample = Math.min(nonCriticalCandidates.length, 60);
  for (let s = 0; s < nonCriticalSample; s += 1) {
    const candidate = nonCriticalCandidates[Math.floor(rng() * nonCriticalCandidates.length)]!;
    const closure = successorClosureSize(state, candidate);
    if (closure > nonCriticalClosure) {
      nonCriticalClosure = closure;
      nonCritical = candidate;
      nonCriticalFloat = schedule.totalFloat[candidate]!;
    }
  }
  if (nonCritical < 0) {
    // 退路：允许没有后继的任务（此时"传播"退化为单点 EF 更新，证据里会显式说明闭包规模）
    for (let i = 0; i < dataset.taskCount; i += 1) {
      if (schedule.totalFloat[i]! > nonCriticalFloat) {
        nonCriticalFloat = schedule.totalFloat[i]!;
        nonCritical = i;
      }
    }
  }
  plans.push(
    nonCritical >= 0
      ? {
          scenario: {
            id: `${dataset.id}:duration-noncritical`,
            kind: 'duration-noncritical',
            datasetId: dataset.id,
            target: nonCritical,
            delta,
            link: null,
            linkIndex: -1,
            note:
              nonCriticalClosure >= 0
                ? `非关键任务 #${String(nonCritical)}（总浮动 ${String(nonCriticalFloat)} 个工作日，后继闭包 ${String(nonCriticalClosure)} 个任务）`
                : `非关键任务 #${String(nonCritical)}（总浮动 ${String(nonCriticalFloat)} 个工作日，无后继）`,
          },
          reason: '',
        }
      : { scenario: null, reason: '该数据集没有浮动任务（深链上全部任务都关键）' },
  );

  // 2) 关键任务：在所有关键且有后继的任务里取后继闭包最大者（抽样 60 个，避免规划自身成为瓶颈）
  const criticalCandidates: number[] = [];
  for (let i = 0; i < dataset.taskCount; i += 1) {
    if (schedule.critical[i] === 1 && graph.succOffset[i + 1]! > graph.succOffset[i]!) {
      criticalCandidates.push(i);
    }
  }
  let critical = -1;
  let criticalClosure = -1;
  const sample = Math.min(criticalCandidates.length, 60);
  for (let s = 0; s < sample; s += 1) {
    const candidate = criticalCandidates[Math.floor(rng() * criticalCandidates.length)]!;
    const closure = successorClosureSize(state, candidate);
    if (closure > criticalClosure) {
      criticalClosure = closure;
      critical = candidate;
    }
  }
  plans.push(
    critical >= 0
      ? {
          scenario: {
            id: `${dataset.id}:duration-critical`,
            kind: 'duration-critical',
            datasetId: dataset.id,
            target: critical,
            delta,
            link: null,
            linkIndex: -1,
            note: `关键任务 #${String(critical)}（后继闭包 ${String(criticalClosure)} 个任务）`,
          },
          reason: '',
        }
      : { scenario: null, reason: '该数据集没有带后继的关键任务' },
  );

  // 3) 增边：拓扑序上相隔 ≥3 且尚不存在的边
  const existing = new Set<string>();
  for (const link of dataset.links) {
    existing.add(`${String(link.pred)}:${String(link.succ)}`);
  }
  let addScenario: Scenario | null = null;
  for (let i = 0; i < order.length - 3; i += 1) {
    const pred = order[i]!;
    const succ = order[i + 3]!;
    if (!existing.has(`${String(pred)}:${String(succ)}`)) {
      addScenario = {
        id: `${dataset.id}:edge-add`,
        kind: 'edge-add',
        datasetId: dataset.id,
        target: succ,
        delta: 0,
        link: { pred, succ, type: 0, lag: 0 },
        linkIndex: -1,
        note: `新增 FS 依赖 ${String(pred)} → ${String(succ)}`,
      };
      break;
    }
  }
  plans.push(
    addScenario === null
      ? { scenario: null, reason: '未找到可新增的依赖对' }
      : { scenario: addScenario, reason: '' },
  );

  // 4) 删边：删掉中间那条（尽量对关键路径有影响）
  let removeIndex = -1;
  if (dataset.links.length > 0) {
    for (let i = 0; i < dataset.links.length; i += 1) {
      const link = dataset.links[i]!;
      if (schedule.critical[link.pred] === 1 && schedule.critical[link.succ] === 1) {
        removeIndex = i;
        break;
      }
    }
    if (removeIndex < 0) {
      removeIndex = Math.floor(dataset.links.length / 2);
    }
  }
  plans.push(
    removeIndex >= 0
      ? {
          scenario: {
            id: `${dataset.id}:edge-remove`,
            kind: 'edge-remove',
            datasetId: dataset.id,
            target: -1,
            delta: 0,
            link: dataset.links[removeIndex]!,
            linkIndex: removeIndex,
            note: `删除依赖（第 ${String(removeIndex)} 条）`,
          },
          reason: '',
        }
      : { scenario: null, reason: '该数据集没有依赖边' },
  );

  return plans;
}
