/**
 * **检查点保留 + 触发状态机**（P3/C4-c 从 \`persistence.ts\` 拆出）。
 *
 * 全是**纯函数与纯状态机**：时间（\`atMs\`）、手势活动态（\`active\`）与配额事件一律是**显式入参**，
 * 因此"每 5 分钟 / 每 200 步 / 关闭时"这些触发条件可以用**假时钟**逐条断言（见 \`persistence.spec.ts\`）。
 */

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  CHECKPOINT_EVERY_STEPS,
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_KEEP,
  QUOTA_DEGRADED_KEEP,
  type CheckpointRef,
  type StoredSnapshot,
} from './types.js';

// ---------------------------------------------------------------- 检查点保留策略

/** 保留计划：`keep` 留下、`remove` 从存储里删掉。 */
export interface CheckpointKeepPlan {
  readonly keep: readonly CheckpointRef[];
  readonly remove: readonly CheckpointRef[];
}

/**
 * 保留计划（**确定性**：与时钟、插入顺序无关——只按 `createdAtMs` 排序后取最新 `keep` 份）。
 *
 * `keep <= 0` 视为"不留"（`keep: []`、其余全删）——配额降级的极端情形由调用方给
 * `QUOTA_DEGRADED_KEEP`（= 1），不会走到这里，但语义要有定义。
 */
export function planCheckpoint(
  existing: readonly StoredSnapshot[],
  keep: number,
  incoming: StoredSnapshot | null = null,
): CheckpointKeepPlan {
  const all = [...existing, ...(incoming === null ? [] : [incoming])];
  const unique = new Map<string, StoredSnapshot>();
  for (const snapshot of all) {
    unique.set(`${snapshot.docId}#${String(snapshot.id)}`, snapshot);
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.createdAtMs === right.createdAtMs
      ? right.id - left.id
      : right.createdAtMs - left.createdAtMs,
  );
  const limit = Math.max(0, Math.trunc(keep));
  const ref = (snapshot: StoredSnapshot): CheckpointRef => ({ docId: snapshot.docId, id: snapshot.id });
  return { keep: ordered.slice(0, limit).map(ref), remove: ordered.slice(limit).map(ref) };
}

// ---------------------------------------------------------------- 触发状态机

/** 手势活动态（**显式入参**：策略自己不去问手势，因此"拖动期不写盘"是可断言的）。 */
export type GestureActivity = 'idle' | 'dragging' | 'linking';

export interface RetentionPolicy {
  /** 去抖窗口（连续编辑只写一次）。 */
  readonly debounceMs: number;
  /** 去抖上限（"变更 → 落盘"的最坏延迟）。 */
  readonly maxIntervalMs: number;
  /** 检查点的时间阈值。 */
  readonly checkpointIntervalMs: number;
  /** 检查点的步数阈值。 */
  readonly checkpointEverySteps: number;
  /** 正常态保留份数。 */
  readonly keep: number;
  /** 降级后保留份数。 */
  readonly degradedKeep: number;
}

export interface PolicyState {
  /** 是否已有未落盘的变更。 */
  readonly dirty: boolean;
  /** 首次变脏的时刻（`null` = 不脏）。 */
  readonly dirtySinceMs: number | null;
  /** 最近一次落盘的时刻。 */
  readonly lastFlushMs: number | null;
  /** 最近一次检查点的时刻（`null` = 还没有检查点）。 */
  readonly lastCheckpointMs: number | null;
  /** 最近一次检查点时的 `rev`（`null` = 还没有检查点）。 */
  readonly lastCheckpointRev: number | null;
  /** 当前 `rev`。 */
  readonly rev: number;
  /** 当前手势活动态。 */
  readonly active: GestureActivity;
  /** 是否已降级（配额超限后为真，此后只保留 `degradedKeep` 份）。 */
  readonly degraded: boolean;
}

export type PolicyEvent =
  | { readonly kind: 'change'; readonly rev: number; readonly atMs: number }
  | { readonly kind: 'activity'; readonly active: GestureActivity }
  | { readonly kind: 'tick'; readonly atMs: number }
  | { readonly kind: 'flushed'; readonly atMs: number }
  | { readonly kind: 'checkpointed'; readonly atMs: number; readonly rev: number }
  | { readonly kind: 'quotaExceeded' };

export type PolicyAction = 'none' | 'flush' | 'checkpoint' | 'degrade';

export interface PolicyStep {
  readonly state: PolicyState;
  readonly action: PolicyAction;
}

/** 建策略（数值来自本文件顶部的常量；测试用 `overrides` 打小时间尺）。 */
export function createRetentionPolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    debounceMs: AUTOSAVE_DEBOUNCE_MS,
    maxIntervalMs: AUTOSAVE_MAX_INTERVAL_MS,
    checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
    checkpointEverySteps: CHECKPOINT_EVERY_STEPS,
    keep: CHECKPOINT_KEEP,
    degradedKeep: QUOTA_DEGRADED_KEEP,
    ...overrides,
  };
}

export function createPolicyState(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    dirty: false,
    dirtySinceMs: null,
    lastFlushMs: null,
    lastCheckpointMs: null,
    lastCheckpointRev: null,
    rev: 0,
    active: 'idle',
    degraded: false,
    ...overrides,
  };
}

/** 当前生效的保留份数。 */
export function effectiveKeep(policy: RetentionPolicy, state: PolicyState): number {
  return state.degraded ? policy.degradedKeep : policy.keep;
}

/**
 * 触发状态机（**纯函数**：同一个 `(state, event)` 永远给同一个 `(state', action)`）。
 *
 * 三条口径（ADR 0009 §2/§3）：
 * 1. **手势活动期不产出 `flush`**——因此"自动保存不吃拖拽帧预算"不依赖运气；
 * 2. `tick` 是**唯一**的时间驱动事件（调用方按自己的节奏喂），去抖与"最大间隔"都在这里判；
 * 3. 检查点是 `flush` 的**附加**动作（先落最新状态，再决定是否需要新检查点）——
 *    顺序不能反，否则"基线变了、post 还没清"的窗口就会把最新状态写丢。
 */
export function policyReduce(
  policy: RetentionPolicy,
  state: PolicyState,
  event: PolicyEvent,
): PolicyStep {
  switch (event.kind) {
    case 'change':
      return {
        state: {
          ...state,
          rev: event.rev,
          dirty: true,
          // 首次变脏的时刻**只在变脏那一刻**记：连续编辑不得把去抖窗口往后推（否则
          // "最大间隔"就白设了——那正是 R-2 要避免的"整会话不写"）。
          dirtySinceMs: state.dirty ? state.dirtySinceMs : event.atMs,
        },
        action: 'none',
      };
    case 'activity':
      return { state: { ...state, active: event.active }, action: 'none' };
    case 'quotaExceeded':
      return { state: { ...state, degraded: true }, action: 'degrade' };
    case 'flushed':
      return {
        state: { ...state, dirty: false, dirtySinceMs: null, lastFlushMs: event.atMs },
        action: 'none',
      };
    case 'checkpointed':
      return {
        state: { ...state, lastCheckpointMs: event.atMs, lastCheckpointRev: event.rev },
        action: 'none',
      };
    case 'tick':
      return tickReduce(policy, state, event.atMs);
  }
}

function tickReduce(policy: RetentionPolicy, state: PolicyState, atMs: number): PolicyStep {
  if (state.active !== 'idle') {
    // 手势活动期**不落盘**；但 `rev`/`dirty` 照常记账（`idle` 之后的 `tick` 会立刻补写）。
    return { state, action: 'none' };
  }
  if (!state.dirty) {
    return { state, action: 'none' };
  }
  // 首次变脏的时刻缺失时按"现在就够久"处理：宁可早写，也不要把变更无限期扣在内存里。
  const since = state.dirtySinceMs ?? atMs;
  const dueByDebounce = atMs - since >= policy.debounceMs;
  const dueByMax = atMs - since >= policy.maxIntervalMs;
  if (!dueByDebounce && !dueByMax) {
    return { state, action: 'none' };
  }
  const stepsSince = state.lastCheckpointRev === null ? Number.POSITIVE_INFINITY : state.rev - state.lastCheckpointRev;
  // **没有基线就一定要建基线**：记录形状要求 `base` 非空（"检查点基线 + 其后的增量"），
  // 因此第一次真正落盘必须是 `checkpoint` —— 否则写出来的记录是结构不全的。
  const noBase = state.lastCheckpointMs === null;
  const dueByTime = !noBase && atMs - (state.lastCheckpointMs ?? 0) >= policy.checkpointIntervalMs;
  const dueBySteps = stepsSince >= policy.checkpointEverySteps;
  return {
    // 状态推进交给 `flushed`/`checkpointed` 事件（调用方在写盘成功后喂回来）——
    // 这样"写了才算数"是事实，而不是乐观假设。
    state,
    action: noBase || dueByTime || dueBySteps ? 'checkpoint' : 'flush',
  };
}

