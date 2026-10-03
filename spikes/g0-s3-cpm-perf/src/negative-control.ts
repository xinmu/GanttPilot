/**
 * 负向对照（**证明判据有判别力**，不是性能结论本身）。
 *
 * 计时类结论最大的风险是"骨架测不出差别"——所以每个被测量的层面都配一个**已知更慢**的实现：
 *
 * | 编号 | 基准（快） | 对照（慢） | 阈值 | 证明什么 |
 * |---|---|---|---|---|
 * | NC1 | 索引日历（前缀和） | 逐日循环日历（对齐主干 `countWorkdays`） | ≥3× | 序号 ↔ 日期 翻译的常数因子可测 |
 * | NC2 | 后继闭包传播（`ForwardPropagator`） | 每个受影响节点做一次全量重算 | ≥10× | "增量 vs 全量"的差别可测 |
 * | NC3 | 扁平数组 + CSR | `Map` + 对象图 + 邻接对象数组 | ≥2× | 数据布局的差别可测 |
 *
 * 任一条未达阈值 ⇒ 对应层面的性能数字**不构成结论**（结论里必须写「测量无力」）。
 */

import { computeInto, type Graph } from './cpm.ts';
import type { Calendar } from './calendar.ts';
import type { Dataset } from './graph-gen.ts';
import type { LinkType, Schedule } from './model.ts';

export interface CalendarWorkload {
  readonly queries: number;
  readonly run: (calendar: Calendar) => number;
}

/** 同一组查询在任意日历实现上执行（workload 相同，实现不同）。 */
export function makeCalendarWorkload(dataset: Dataset, queries: number): CalendarWorkload {
  const daySpan = 400;
  const sampleDays: number[] = [];
  const workdayIndices: number[] = [];
  for (let i = 0; i < queries; i += 1) {
    sampleDays.push(dataset.baseDay + ((i * 7) % daySpan));
    workdayIndices.push((i * 13) % 500);
  }
  return {
    queries,
    run: (calendar: Calendar): number => {
      let accumulator = 0;
      for (let i = 0; i < queries; i += 1) {
        accumulator += calendar.ordinalOfDay(sampleDays[i]!);
        accumulator += calendar.dayOfOrdinal(Math.min(workdayIndices[i]!, calendar.workdayCount));
      }
      return accumulator;
    },
  };
}

/** NC2：对每个受影响节点跑一次全量重算（"增量退化为全量"的下限）。 */
export function makePerHopRecompute(
  graph: Graph,
  durations: Int32Array,
  order: Int32Array,
  out: Schedule,
  hops: number,
): () => void {
  return () => {
    for (let i = 0; i < hops; i += 1) {
      computeInto(graph, durations, order, out);
    }
  };
}

interface ObjectLink {
  readonly pred: number;
  readonly succ: number;
  readonly type: LinkType;
  readonly lag: number;
}

interface ObjectNode {
  readonly id: number;
  duration: number;
  readonly successors: ObjectLink[];
  readonly predecessors: ObjectLink[];
}

/** NC3：`Map` + 对象图（"直觉写法"）——同一编辑、同一语义，只是数据布局不同。 */
export class ObjectGraphModel {
  private readonly index = new Map<number, ObjectNode>();
  private readonly nodes: ObjectNode[];
  readonly es: Int32Array;
  readonly ef: Int32Array;

  constructor(dataset: Dataset) {
    const n = dataset.taskCount;
    this.nodes = [];
    for (let i = 0; i < n; i += 1) {
      const node: ObjectNode = {
        id: i,
        duration: dataset.durations[i]!,
        successors: [],
        predecessors: [],
      };
      this.nodes.push(node);
      this.index.set(i, node);
    }
    for (const link of dataset.links) {
      const pred = this.index.get(link.pred);
      const succ = this.index.get(link.succ);
      if (pred === undefined || succ === undefined) {
        continue;
      }
      const edge: ObjectLink = { pred: link.pred, succ: link.succ, type: link.type, lag: link.lag };
      pred.successors.push(edge);
      succ.predecessors.push(edge);
    }
    this.es = new Int32Array(n);
    this.ef = new Int32Array(n);
    for (const node of this.nodes) {
      this.es[node.id] = 0;
      this.ef[node.id] = node.duration;
    }
  }

  setDuration(task: number, duration: number): void {
    const node = this.nodes[task];
    if (node !== undefined) {
      node.duration = duration;
    }
  }

  /** 让对象图从与扁平数组实现**完全相同**的初始状态出发（公平对照的前提）。 */
  seedFrom(es: Int32Array, ef: Int32Array): void {
    this.es.set(es);
    this.ef.set(ef);
  }

  /** 与 `ForwardPropagator` 等价的后继闭包传播（对象图 + Map 版本）。 */
  propagate(seeds: readonly number[]): number {
    const seen = new Set<number>();
    const cursors = new Map<number, number>();
    const postOrder: number[] = [];
    const stack: number[] = [];
    for (const seed of seeds) {
      if (!seen.has(seed)) {
        seen.add(seed);
        stack.push(seed);
      }
    }
    while (stack.length > 0) {
      const node = stack[stack.length - 1]!;
      const current = this.index.get(node);
      if (current === undefined) {
        stack.pop();
        continue;
      }
      const cursor = cursors.get(node) ?? 0;
      if (cursor < current.successors.length) {
        cursors.set(node, cursor + 1);
        const succ = current.successors[cursor]!.succ;
        if (!seen.has(succ)) {
          seen.add(succ);
          stack.push(succ);
        }
      } else {
        stack.pop();
        postOrder.push(node);
      }
    }
    let updated = 0;
    for (let i = postOrder.length - 1; i >= 0; i -= 1) {
      const node = this.index.get(postOrder[i]!)!;
      let start = 0;
      for (const link of node.predecessors) {
        const predStart = this.es[link.pred]!;
        const predFinish = this.ef[link.pred]!;
        let bound: number;
        if (link.type === 0) {
          bound = predFinish + link.lag;
        } else if (link.type === 1) {
          bound = predStart + link.lag;
        } else if (link.type === 2) {
          bound = predFinish + link.lag - node.duration;
        } else {
          bound = predStart + link.lag - node.duration;
        }
        if (bound > start) {
          start = bound;
        }
      }
      if (start < 0) {
        start = 0;
      }
      if (this.es[node.id] !== start || this.ef[node.id] !== start + node.duration) {
        updated += 1;
      }
      this.es[node.id] = start;
      this.ef[node.id] = start + node.duration;
    }
    return updated;
  }
}
