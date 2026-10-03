/**
 * 最小可用 CPM（spike 版）：拓扑序 + 检环 + 正向传播 + 逆向传播 + 总/自由浮动 + 关键路径
 * + **受影响子图的正向传播**（G5 拖拽期的模型）。
 *
 * 三条与性能结论直接相关的设计（都被本 spike 实测，见结论 §G2 交接清单）：
 * 1. **序号空间**：ES/EF/LS/LF 全是「工作日序号」（整数）。日历不参与传播——它只负责
 *    容量规划与序号 → 日期翻译。于是 `EF = ES + duration` 是整数加法，热路径上没有 `Date`；
 * 2. **扁平数组 + CSR 邻接**（`Int32Array` / `Uint8Array`），无对象图、无 `Map`；
 * 3. **预分配复用**：`computeInto` 把结果写进调用方提供的 `Schedule`，热路径零分配；
 *    `ForwardPropagator` 复用 DFS 状态数组，按脏标记复位（只清用过的项）。
 *
 * `noUncheckedIndexedAccess` 下类型化数组的读取结果含 `undefined`，因此热循环内的
 * 索引读取统一用 `!` 断言（索引在结构上必然有界）。这是有意识的取舍，不是疏漏。
 *
 * 关系方程（`s`/`f` 为起/止序号，`D` 为工期，`L` 为 lag）：
 * | 类型 | 正向约束 | 逆向界（作用在 pred 的 LS 上） | 自由浮动的裕量 |
 * |---|---|---|---|
 * | FS | `s_succ ≥ f_pred + L` | `ls_pred ≤ ls_succ − L − D_pred` | `es_succ − ef_pred − L` |
 * | SS | `s_succ ≥ s_pred + L` | `ls_pred ≤ ls_succ − L` | `es_succ − es_pred − L` |
 * | FF | `f_succ ≥ f_pred + L` | `ls_pred ≤ ls_succ + D_succ − L − D_pred` | `ef_succ − ef_pred − L` |
 * | SF | `f_succ ≥ s_pred + L` | `ls_pred ≤ ls_succ + D_succ − L` | `ef_succ − es_pred − L` |
 */

import {
  createCalendar,
  horizonDaysFor,
  type Calendar,
} from './calendar.ts';
import {
  allocateSchedule,
  type CalendarSpec,
  type Diagnostic,
  type LinkSpec,
  type Schedule,
} from './model.ts';

/** 整数哨兵，代表「尚无界」。 */
const NO_BOUND = 0x3fff_ffff;

export interface Graph {
  readonly taskCount: number;
  readonly linkCount: number;
  readonly succOffset: Int32Array;
  readonly succTarget: Int32Array;
  readonly succType: Uint8Array;
  readonly succLag: Int32Array;
  readonly predOffset: Int32Array;
  readonly predSource: Int32Array;
  readonly predType: Uint8Array;
  readonly predLag: Int32Array;
}

export interface BuildGraphResult {
  readonly graph: Graph;
  readonly diagnostics: readonly Diagnostic[];
}

export function buildGraph(taskCount: number, links: readonly LinkSpec[]): BuildGraphResult {
  const diagnostics: Diagnostic[] = [];
  const succDeg = new Int32Array(taskCount + 1);
  const predDeg = new Int32Array(taskCount + 1);
  let valid = 0;
  for (const link of links) {
    if (
      !Number.isInteger(link.pred) ||
      !Number.isInteger(link.succ) ||
      link.pred < 0 ||
      link.pred >= taskCount ||
      link.succ < 0 ||
      link.succ >= taskCount
    ) {
      diagnostics.push({
        code: 'unknown-predecessor',
        detail: `丢弃越界依赖：${String(link.pred)} → ${String(link.succ)}`,
      });
      continue;
    }
    succDeg[link.pred] = succDeg[link.pred]! + 1;
    predDeg[link.succ] = predDeg[link.succ]! + 1;
    valid += 1;
  }

  const succOffset = new Int32Array(taskCount + 1);
  const predOffset = new Int32Array(taskCount + 1);
  let acc = 0;
  for (let i = 0; i < taskCount; i += 1) {
    succOffset[i] = acc;
    acc += succDeg[i]!;
  }
  succOffset[taskCount] = acc;
  acc = 0;
  for (let i = 0; i < taskCount; i += 1) {
    predOffset[i] = acc;
    acc += predDeg[i]!;
  }
  predOffset[taskCount] = acc;

  const succTarget = new Int32Array(valid);
  const succType = new Uint8Array(valid);
  const succLag = new Int32Array(valid);
  const predSource = new Int32Array(valid);
  const predType = new Uint8Array(valid);
  const predLag = new Int32Array(valid);

  const succCursor = succOffset.slice();
  const predCursor = predOffset.slice();
  const seen = new Set<number>();
  for (const link of links) {
    if (
      !Number.isInteger(link.pred) ||
      !Number.isInteger(link.succ) ||
      link.pred < 0 ||
      link.pred >= taskCount ||
      link.succ < 0 ||
      link.succ >= taskCount
    ) {
      continue;
    }
    const key = (link.pred * taskCount + link.succ) * 4 + link.type;
    if (seen.has(key)) {
      diagnostics.push({
        code: 'duplicate-link',
        detail: `重复依赖（保留并按并行约束参与计算）：${String(link.pred)} → ${String(link.succ)} ${String(link.type)}`,
      });
    }
    seen.add(key);
    const si = succCursor[link.pred]!;
    succCursor[link.pred] = si + 1;
    succTarget[si] = link.succ;
    succType[si] = link.type;
    succLag[si] = link.lag;
    const pi = predCursor[link.succ]!;
    predCursor[link.succ] = pi + 1;
    predSource[pi] = link.pred;
    predType[pi] = link.type;
    predLag[pi] = link.lag;
  }

  return {
    graph: {
      taskCount,
      linkCount: valid,
      succOffset,
      succTarget,
      succType,
      succLag,
      predOffset,
      predSource,
      predType,
      predLag,
    },
    diagnostics,
  };
}

export interface TopoResult {
  readonly order: Int32Array;
  readonly cycleNodes: Int32Array | null;
}

/** Kahn 拓扑排序；返回的 `order` 在成环时只覆盖已处理的节点（长度恒为 taskCount，尾部为 0）。 */
export function topologicalOrder(graph: Graph): TopoResult {
  const n = graph.taskCount;
  const inDegree = new Int32Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    const degree = graph.predOffset[i + 1]! - graph.predOffset[i]!;
    inDegree[i] = degree;
    if (degree === 0) {
      queue[tail] = i;
      tail += 1;
    }
  }
  const order = new Int32Array(n);
  let head = 0;
  let processed = 0;
  while (head < tail) {
    const node = queue[head]!;
    head += 1;
    order[processed] = node;
    processed += 1;
    const end = graph.succOffset[node + 1]!;
    for (let k = graph.succOffset[node]!; k < end; k += 1) {
      const succ = graph.succTarget[k]!;
      const remaining = inDegree[succ]! - 1;
      inDegree[succ] = remaining;
      if (remaining === 0) {
        queue[tail] = succ;
        tail += 1;
      }
    }
  }
  if (processed === n) {
    return { order, cycleNodes: null };
  }
  // 成环节点 = 未被移除的节点（入度仍 > 0）
  const cycle = new Int32Array(n - processed);
  let cursor = 0;
  const removed = new Uint8Array(n);
  for (let i = 0; i < processed; i += 1) {
    removed[order[i]!] = 1;
  }
  for (let i = 0; i < n; i += 1) {
    if (removed[i] === 0) {
      cycle[cursor] = i;
      cursor += 1;
    }
  }
  return { order, cycleNodes: cycle };
}

/** 正向 + 逆向遍历，结果写入 `out`（复用，零分配）。要求 `order` 是最完整的拓扑序。 */
export function computeInto(
  graph: Graph,
  durations: Int32Array,
  order: Int32Array,
  out: Schedule,
): Schedule {
  const n = graph.taskCount;
  const { es, ef, ls, lf, totalFloat, freeFloat, critical } = out;
  let clamped = 0;

  // ---------- 正向：ES/EF ----------
  for (let idx = 0; idx < n; idx += 1) {
    const node = order[idx]!;
    const duration = durations[node]!;
    let start = 0;
    const end = graph.predOffset[node + 1]!;
    for (let k = graph.predOffset[node]!; k < end; k += 1) {
      const pred = graph.predSource[k]!;
      const lag = graph.predLag[k]!;
      const type = graph.predType[k]!;
      let bound: number;
      if (type === 0) {
        bound = ef[pred]! + lag;
      } else if (type === 1) {
        bound = es[pred]! + lag;
      } else if (type === 2) {
        bound = ef[pred]! + lag - duration;
      } else {
        bound = es[pred]! + lag - duration;
      }
      if (bound > start) {
        start = bound;
      }
    }
    if (start < 0) {
      // 负 lag 可能把开始推到项目起点之前：按 0 截断并计数（诚实诊断，不静默）。
      start = 0;
      clamped += 1;
    }
    es[node] = start;
    ef[node] = start + duration;
  }

  // ---------- 项目完成 ----------
  let finish = 0;
  for (let i = 0; i < n; i += 1) {
    if (ef[i]! > finish) {
      finish = ef[i]!;
    }
  }
  out.projectFinish = finish;
  out.clampedStarts = clamped;

  // ---------- 逆向：LS/LF ----------
  for (let idx = n - 1; idx >= 0; idx -= 1) {
    const node = order[idx]!;
    const duration = durations[node]!;
    const end = graph.succOffset[node + 1]!;
    const start = graph.succOffset[node]!;
    let latest: number;
    if (start === end) {
      latest = finish - duration;
    } else {
      latest = NO_BOUND;
      for (let k = start; k < end; k += 1) {
        const succ = graph.succTarget[k]!;
        const lag = graph.succLag[k]!;
        const type = graph.succType[k]!;
        let bound: number;
        if (type === 0) {
          bound = ls[succ]! - lag - duration;
        } else if (type === 1) {
          bound = ls[succ]! - lag;
        } else if (type === 2) {
          bound = ls[succ]! + durations[succ]! - lag - duration;
        } else {
          bound = ls[succ]! + durations[succ]! - lag;
        }
        if (bound < latest) {
          latest = bound;
        }
      }
    }
    ls[node] = latest;
    lf[node] = latest + duration;
  }

  // ---------- 浮动与关键路径 ----------
  for (let i = 0; i < n; i += 1) {
    const end = graph.succOffset[i + 1]!;
    const start = graph.succOffset[i]!;
    let free: number;
    if (start === end) {
      free = finish - ef[i]!;
    } else {
      free = NO_BOUND;
      for (let k = start; k < end; k += 1) {
        const succ = graph.succTarget[k]!;
        const lag = graph.succLag[k]!;
        const type = graph.succType[k]!;
        let slack: number;
        if (type === 0) {
          slack = es[succ]! - ef[i]! - lag;
        } else if (type === 1) {
          slack = es[succ]! - es[i]! - lag;
        } else if (type === 2) {
          slack = ef[succ]! - ef[i]! - lag;
        } else {
          slack = ef[succ]! - es[i]! - lag;
        }
        if (slack < free) {
          free = slack;
        }
      }
    }
    freeFloat[i] = free;
    const total = ls[i]! - es[i]!;
    totalFloat[i] = total;
    critical[i] = total === 0 ? 1 : 0;
  }
  return out;
}

export interface ProjectSpec {
  readonly taskCount: number;
  readonly durations: readonly number[];
  readonly links: readonly LinkSpec[];
  readonly calendar: CalendarSpec;
  /** 项目起点（UTC 日序号）；序号 0 = 该日起的第一个工作日。 */
  readonly baseDay: number;
}

export interface ComputeResult {
  readonly schedule: Schedule | null;
  readonly order: Int32Array;
  readonly cycleNodes: Int32Array | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly calendar: Calendar;
  readonly graph: Graph;
  readonly horizonDays: number;
}

/** 便利入口：容量规划（含成环/溢出重试） + 拓扑 + 遍历。测的是 `computeInto`，不是这里。 */
export function computeSchedule(project: ProjectSpec): ComputeResult {
  const durations = Int32Array.from(project.durations);
  const { graph, diagnostics } = buildGraph(project.taskCount, project.links);
  const topo = topologicalOrder(graph);
  const needed = plannedWorkdays(durations, project.links);
  let horizonDays = horizonDaysFor(needed, project.calendar);
  let calendar = createCalendar('indexed', project.calendar, project.baseDay, horizonDays);
  if (topo.cycleNodes !== null) {
    return {
      schedule: null,
      order: topo.order,
      cycleNodes: topo.cycleNodes,
      diagnostics: [...diagnostics, { code: 'cycle', detail: `检测到环，涉及 ${String(topo.cycleNodes.length)} 个任务` }],
      calendar,
      graph,
      horizonDays,
    };
  }
  const out = allocateSchedule(project.taskCount);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    computeInto(graph, durations, topo.order, out);
    if (out.projectFinish <= calendar.workdayCount) {
      break;
    }
    // 地平线不足（例外放假等把工作日推远）：扩容重算。
    horizonDays *= 2;
    calendar = createCalendar('indexed', project.calendar, project.baseDay, horizonDays);
  }
  return {
    schedule: out,
    order: topo.order,
    cycleNodes: null,
    diagnostics,
    calendar,
    graph,
    horizonDays,
  };
}

/** 任意路径长度的上界：全部工期 + 全部正 lag（截断不会让序号超过它）。 */
export function plannedWorkdays(durations: Int32Array, links: readonly LinkSpec[]): number {
  let total = 0;
  for (let i = 0; i < durations.length; i += 1) {
    total += Math.max(0, durations[i]!);
  }
  for (const link of links) {
    total += Math.max(0, link.lag);
  }
  return total + durations.length;
}

export interface PropagationResult {
  readonly visited: number;
  readonly updated: number;
}

/**
 * 受影响子图的正向传播（G5 帧内模型）。
 *
 * 只访问「种子的后继闭包」：DFS 收集闭包（迭代、显式栈），再按闭包的**逆后序**（即闭包上的拓扑序）
 * 重算 ES/EF。闭包之外的节点保持原值，因此结果与全量重算在 ES/EF 上等价
 * （浮动/关键路径仍需松手后的全量重算，见结论 §四）。
 */
export class ForwardPropagator {
  private readonly graph: Graph;
  private readonly state: Uint8Array;
  private readonly cursor: Int32Array;
  private readonly stack: Int32Array;
  private readonly postOrder: Int32Array;
  private readonly dirty: Int32Array;

  constructor(graph: Graph) {
    this.graph = graph;
    const n = graph.taskCount;
    this.state = new Uint8Array(n);
    this.cursor = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.postOrder = new Int32Array(n);
    this.dirty = new Int32Array(n);
  }

  run(seeds: readonly number[], durations: Int32Array, out: Schedule): PropagationResult {
    const { graph, state, cursor, stack, postOrder, dirty } = this;
    let dirtyCount = 0;
    let stackSize = 0;
    for (const seed of seeds) {
      if (seed < 0 || seed >= graph.taskCount || state[seed] !== 0) {
        continue;
      }
      state[seed] = 1;
      cursor[seed] = graph.succOffset[seed]!;
      dirty[dirtyCount] = seed;
      dirtyCount += 1;
      stack[stackSize] = seed;
      stackSize += 1;
    }

    let postCount = 0;
    while (stackSize > 0) {
      const node = stack[stackSize - 1]!;
      const end = graph.succOffset[node + 1]!;
      const k = cursor[node]!;
      if (k < end) {
        cursor[node] = k + 1;
        const succ = graph.succTarget[k]!;
        if (state[succ] === 0) {
          state[succ] = 1;
          cursor[succ] = graph.succOffset[succ]!;
          dirty[dirtyCount] = succ;
          dirtyCount += 1;
          stack[stackSize] = succ;
          stackSize += 1;
        }
      } else {
        stackSize -= 1;
        state[node] = 2;
        postOrder[postCount] = node;
        postCount += 1;
      }
    }

    const { es, ef } = out;
    let updated = 0;
    for (let i = postCount - 1; i >= 0; i -= 1) {
      const node = postOrder[i]!;
      const duration = durations[node]!;
      let start = 0;
      const end = graph.predOffset[node + 1]!;
      for (let k = graph.predOffset[node]!; k < end; k += 1) {
        const pred = graph.predSource[k]!;
        const lag = graph.predLag[k]!;
        const type = graph.predType[k]!;
        let bound: number;
        if (type === 0) {
          bound = ef[pred]! + lag;
        } else if (type === 1) {
          bound = es[pred]! + lag;
        } else if (type === 2) {
          bound = ef[pred]! + lag - duration;
        } else {
          bound = es[pred]! + lag - duration;
        }
        if (bound > start) {
          start = bound;
        }
      }
      if (start < 0) {
        start = 0;
      }
      if (es[node] !== start || ef[node] !== start + duration) {
        updated += 1;
      }
      es[node] = start;
      ef[node] = start + duration;
    }

    for (let i = 0; i < dirtyCount; i += 1) {
      state[dirty[i]!] = 0;
    }
    return { visited: postCount, updated };
  }
}

/** 序号 → ISO 日期（只用于证据与可读性，不进热路径）。 */
export interface MaterializedDates {
  readonly startIso: string[];
  readonly finishExclusiveIso: string[];
}

export function materializeDates(schedule: Schedule, calendar: Calendar): MaterializedDates {
  const startIso: string[] = [];
  const finishExclusiveIso: string[] = [];
  for (let i = 0; i < schedule.taskCount; i += 1) {
    startIso.push(calendar.isoOfOrdinal(schedule.es[i]!));
    finishExclusiveIso.push(calendar.isoOfOrdinal(schedule.ef[i]!));
  }
  return { startIso, finishExclusiveIso };
}
