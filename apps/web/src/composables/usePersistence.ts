/**
 * 持久化接线（G6 的应用侧编排；契约见 [ADR 0009](../../../../docs/02-adr/0009-持久化契约.md)）。
 *
 * ## 分工：**策略在引擎、时序与 DOM 在这里**
 *
 * - 触发条件（去抖 / 最大间隔 / 检查点阈值 / 手势期不落盘）是 `@ganttpilot/engine` 的
 *   **纯状态机**（`policyReduce`）：它进 `pnpm gate`、用假时钟逐条断言；
 *   本文件只负责"喂事件"——`rev` 变化 → `change`、手势切换 → `activity`、
 *   定时器 → `tick`、写成功 → `flushed` / `checkpointed`。
 * - 时间与 DOM（`setInterval` / `requestIdleCallback` / `visibilitychange` /
 *   `indexedDB`）只在这里出现：引擎包碰它们就是破铁律（`lint-boundary` 会红）。
 *
 * ## 三件不能省的事
 *
 * 1. **恢复完成前不写盘**（`ready` 门闩）：否则"打开页面的那一刻"的演示数据会把用户数据盖掉；
 * 2. **序列化只在空闲回调里做**，且手势活动期**根本不会被调度**（策略层不产出 `flush`）——
 *   出口条件①"拖拽期间不产生可见掉帧"因此不依赖运气；
 * 3. **失败一律走既有 `notice` 通道**：多标签冲突**停写**、配额超限**降级**，
 *   两者都**不改编辑行为**（ADR 0009 §3/§7）。
 */

import { onMounted, onUnmounted, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import {
  CHECKPOINT_KEEP,
  createPolicyState,
  createRetentionPolicy,
  decodeCandidates,
  effectiveKeep,
  planCheckpoint,
  planRestoreOf,
  policyReduce,
  sessionRecordOf,
  type DocumentSession,
  type GestureActivity,
  type PolicyState,
  type ProjectDocument,
  type RetentionPolicy,
  type SessionStep,
  type SnapshotStore,
  type StoredSnapshot,
} from '@ganttpilot/engine';
import type { StatusNotice } from '@ganttpilot/render-core';
import { createSnapshotStore } from '../persistence/idb.js';

/** 文档 id：v0.1 只有"当前这一份文档"，因此是常量；将来多文档时这里是唯一改动点。 */
export const DEFAULT_DOC_ID = 'current';

/** 写入者身份（多标签防护；每次打开页面新生成，因此"另一个标签页"必然可辨识）。 */
function newWriterId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `tab-${Date.now().toString(36)}-${random}`;
}

/** 持久化状态（**只读快照**，给状态栏用）。 */
export interface PersistenceStatus {
  /** 自动保存当前是否在工作（IDB 可用、未被多标签停写、未被测量旁路关掉）。 */
  readonly enabled: boolean;
  /** 停写/降级的原因（`null` = 正常）。 */
  readonly degradedReason: string | null;
  /** 最近一次成功写盘的时刻（`null` = 还没写过）。 */
  readonly lastSavedAtMs: number | null;
  /** 已保留的检查点份数。 */
  readonly checkpoints: number;
  /**
   * **尚未落盘的步数**（= 当前 `session.revision` − 最近一次成功写盘时的 `revision`）。
   *
   * 这条是"自动保存真的发生了"的**可观察证据**：显示"已保存"之后它必须是 0；
   * 它 >0 就说明"改了但还没写下去"（≤5s 内会被写掉）。
   */
  readonly unsavedSteps: number;
  /** 因配额超限而降级为"只保留最近 1 份"。 */
  readonly quotaDegraded: boolean;
}

/** 测量钩子用的**只读**样本（`--persist-drag` / `--storage-metrics` 采的就是它）。 */
export interface PersistenceProbe {
  readonly writes: number;
  readonly checkpoints: number;
  /**
   * **最近一次写入**覆盖的增量步数（= 那次写入的 `post` 长度）。
   *
   * 它与 `PersistenceStatus.unsavedSteps`（**待落**步数）是**两件事**：
   * 前者是"刚写下去的那一份有多大"（判"写入量只与变更量同阶"），
   * 后者是"还没写下去的还有多少"（"已保存"之后必须是 0）。
   */
  readonly lastWriteIncrementSteps: number;
  /** 最近一次"变更 → 落盘完成"的墙钟（ms；`null` = 还没有过）。 */
  readonly lastFlushMs: number | null;
  readonly degradedReason: string | null;
  /** 手势期间的写入次数（**期望 0**：出口条件①的可判定形式）。 */
  readonly writesDuringGesture: number;
  /** 最近一次写入记录的字节数（判"写入量"用）。 */
  readonly recordBytes: number;
  /** 最近一次写入记录的**构成**（记录制诊断：各部分的字节数，判“增量口径”用它）。 */
  readonly recordBreakdown: {
    readonly baseBytes: number;
    readonly postBytes: number;
    readonly redoBytes: number;
    readonly postSteps: number;
  } | null;
}

export interface UsePersistence {
  readonly status: Ref<PersistenceStatus>;
  readonly ready: Ref<boolean>;
  readonly probe: ShallowRef<PersistenceProbe>;
  /**
   * **强制**落盘一次（`松手` / `pagehide` / 文档隐藏 / 测量脚本用）。
   *
   * "强制"的含义：**不等去抖窗口**——这些时刻本身就是硬收口点（用户认为"已经停了"），
   * 出口条件①的可判定形式是"变更 → 落盘完成 ≤5s"，而等待去抖会把它拖成"看起来没写"。
   * 返回是否真的走了写入路径。
   */
  readonly flushNow: () => Promise<boolean>;
  /**
   * **不理会策略**，直接序列化并写一条"最新状态"记录（测量"写入耗时"用它）。
   *
   * 存在的理由：`flushNow` 在"没有未落盘变更"时是**空操作**（策略给的动作为 `none`），
   * 于是量到的是 0 ms——那不是写入耗时。本入口只服务**记录制测量**，不进产品路径。
   */
  readonly writeRecordNow: () => Promise<boolean>;
  /**
   * **硬重定基线**：立刻为当前文档写一份新检查点，并把基线指向它。
   *
   * 用在"**文档被整份替换**"的场景（导入、测量换夹具）：不重定的话，基线还是上一份文档的快照，
   * 于是每次"最新状态"写入都把旧文档一起带上——R-2 的增量口径就失效了（那是**实测抓到的**：
   * 记录 316 KB，而当时的文档本身只有 300 KB 级）。
   */
  readonly rebaseNow: () => Promise<boolean>;
  /** 手势活动态（`useGesture` 的 state 驱动它；策略据此暂停/补写）。 */
  readonly setGesture: (active: GestureActivity) => void;
  /**
   * **初始恢复的结算点**（`enabled === false` 时立即结算）。
   *
   * 存在的理由（P3/C6-b 的 N11）：初始恢复是**异步**的（IndexedDB），而它会
   * `args.restore(...)` **整份替换会话**。测量方要把夹具装进应用时，若那次恢复在夹具
   * **之后**落地，就会把文档换回**上一次持久化的那份**——于是"测量方的模型"与"页面上的 DOM"
   * 是两份文档（实测报文：`DOM 行/边 = 15/14`（演示计划）vs `模型 = 31/41`（夹具）），
   * 而 IndexedDB 按 **origin** 隔离、同一轮测量里多次导航共享 origin ⇒ 第一次导航写下的
   * "全新会话基线"会被第二次导航恢复回来。因此"夹具必须是**最后一个写入者**"这件事
   * 需要一个可等待的信号，而不是靠"恢复通常很快"。
   *
   * 失败的恢复也**必须结算**（`finally`）：否则等待方会永远挂着，把一个可判定的问题变成挂死。
   */
  readonly restoreSettled: Promise<void>;
}

/** 空闲时执行（`requestIdleCallback` 不可用时退化为下一个宏任务）。 */
function onIdle(): Promise<void> {
  return new Promise<void>((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => {
        resolve();
      });
      return;
    }
    setTimeout(resolve, 0);
  });
}

/** 取 `navigator.storage.estimate()`（记录制用它报"存储占用"）。 */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  const storage: StorageManager | undefined = navigator.storage;
  if (storage === undefined || typeof storage.estimate !== 'function') return null;
  const estimate = await storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

/**
 * 建立持久化。
 *
 * `document` / `revision` / `session` 由 `useProject()` 提供（**同一个**会话真相源）；
 * `restore` 回调把恢复出的文档与两个栈交回 `useProject`（只有它知道怎么换会话）。
 */
export function usePersistence(args: {
  readonly document: Ref<ProjectDocument>;
  readonly revision: ComputedRef<number>;
  readonly session: ShallowRef<DocumentSession>;
  readonly restore: (restored: {
    readonly document: ProjectDocument;
    readonly undo: readonly SessionStep[];
    readonly redo: readonly SessionStep[];
    readonly revision: number;
  }) => void;
  readonly notify: (notice: StatusNotice) => void;
  /** 测量旁路：`false` 时**完全不接入**（`--persist-drag` 的对照组）。 */
  readonly enabled?: boolean;
  readonly policy?: Partial<RetentionPolicy>;
}): UsePersistence {
  const policy = createRetentionPolicy(args.policy ?? {});
  const docId = DEFAULT_DOC_ID;
  const writerId = newWriterId();
  const { store, degraded }: { store: SnapshotStore; degraded: boolean } = createSnapshotStore();

  const status = ref<PersistenceStatus>({
    enabled: args.enabled !== false && !degraded,
    degradedReason: degraded ? '这个环境没有可用的 IndexedDB（隐私模式或策略禁用）' : null,
    lastSavedAtMs: null,
    checkpoints: 0,
    unsavedSteps: 0,
    quotaDegraded: false,
  });
  const ready = ref(false);
  const probe = shallowRef<PersistenceProbe>({
    writes: 0,
    checkpoints: 0,
    lastWriteIncrementSteps: 0,
    lastFlushMs: null,
    degradedReason: degraded ? 'indexeddb-unavailable' : null,
    writesDuringGesture: 0,
    recordBytes: 0,
    recordBreakdown: null,
  });

  let state: PolicyState = createPolicyState();
  let base: StoredSnapshot | null = null;
  let blocked = false;
  let timer: number | null = null;
  /** "变更发生"的时刻（算"变更 → 落盘"的延迟；出口条件①的数字就是它）。 */
  let dirtyAtMs: number | null = null;
  /** 最近一次**成功写盘**时的 `session.revision`（`null` = 还没写过）。 */
  let flushedAtRev: number | null = null;
  let checkpoints: StoredSnapshot[] = [];

  const writeAllowed = (): boolean => ready.value && !blocked && args.enabled !== false;

  function publish(): void {
    status.value = {
      enabled: writeAllowed(),
      degradedReason: status.value.degradedReason,
      lastSavedAtMs: status.value.lastSavedAtMs,
      checkpoints: checkpoints.length,
      unsavedSteps: flushedAtRev === null ? 0 : Math.max(0, args.session.value.revision - flushedAtRev),
      quotaDegraded: state.degraded,
    };
  }

  /** 写"最新状态"（`post` = 基线之后的步；**永不序列化整份文档**）。 */
  async function writeLatest(atMs: number): Promise<boolean> {
    const session = args.session.value;
    const record = sessionRecordOf(session, base, { docId, updatedAtMs: atMs, writerId });
    const saved = await store.saveLatest(record);
    if (!saved.ok) {
      if (saved.code === 'PERSIST_BLOCKED_BY_OTHER_TAB') {
        blocked = true;
        status.value = { ...status.value, degradedReason: 'blocked-by-other-tab' };
        args.notify({
          level: 'error',
          text: `另一个标签页正在编辑本文档 —— 本标签页已停止自动保存（${saved.message}）`,
        });
      } else if (saved.code === 'PERSIST_QUOTA_EXCEEDED') {
        state = policyReduce(policy, state, { kind: 'quotaExceeded' }).state;
        status.value = { ...status.value, degradedReason: 'quota-degraded' };
        args.notify({ level: 'error', text: '浏览器存储配额已满：已降级为「只保留最近 1 份检查点」' });
      } else {
        status.value = { ...status.value, degradedReason: saved.code };
        args.notify({ level: 'error', text: `自动保存失败：${saved.code} ${saved.message}` });
      }
      probe.value = { ...probe.value, degradedReason: status.value.degradedReason };
      publish();
      return false;
    }
    const now = Date.now();
    state = policyReduce(policy, state, { kind: 'flushed', atMs }).state;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(JSON.stringify(record)).length;
    const recordBreakdown = {
      baseBytes: encoder.encode(JSON.stringify(record.base)).length,
      postBytes: encoder.encode(JSON.stringify(record.post)).length,
      redoBytes: encoder.encode(JSON.stringify(record.redo)).length,
      postSteps: record.post.length,
    };
    probe.value = {
      ...probe.value,
      writes: probe.value.writes + 1,
      lastWriteIncrementSteps: record.post.length,
      lastFlushMs: dirtyAtMs === null ? probe.value.lastFlushMs : now - dirtyAtMs,
      recordBytes: bytes,
      recordBreakdown,
      writesDuringGesture:
        state.active === 'idle' ? probe.value.writesDuringGesture : probe.value.writesDuringGesture + 1,
    };
    dirtyAtMs = null;
    flushedAtRev = session.revision;
    status.value = { ...status.value, lastSavedAtMs: now };
    // **写完就镜像**：这样"读回来的版本"必然等于"已经写下去的那一版"。
    publishRevisionMirror();
    publish();
    return true;
  }

  /** 写一份检查点（**整份文档唯一会被序列化的地方**）+ 修剪保留份数。 */
  async function writeCheckpoint(atMs: number): Promise<boolean> {
    const session = args.session.value;
    const saved = await store.saveCheckpoint({
      id: 0,
      docId,
      rev: session.revision,
      undoDepth: session.undoStack.length,
      createdAtMs: atMs,
      document: session.document,
    });
    if (!saved.ok) {
      if (saved.code === 'PERSIST_QUOTA_EXCEEDED') {
        state = policyReduce(policy, state, { kind: 'quotaExceeded' }).state;
        status.value = { ...status.value, degradedReason: 'quota-degraded' };
        args.notify({ level: 'error', text: '浏览器存储配额已满：已降级为「只保留最近 1 份检查点」' });
      } else {
        status.value = { ...status.value, degradedReason: saved.code };
        args.notify({ level: 'error', text: `检查点写入失败：${saved.code} ${saved.message}` });
      }
      probe.value = { ...probe.value, degradedReason: status.value.degradedReason };
      publish();
      return false;
    }

    // 基线要带**存储分配的真实 id**（自增主键）：写完读回来按 `createdAtMs` 认领它。
    const listed = await store.loadCheckpoints(docId);
    checkpoints = listed.ok ? [...listed.value] : [];
    base = [...checkpoints].sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null;
    state = policyReduce(policy, state, { kind: 'checkpointed', atMs, rev: session.revision }).state;

    const plan = planCheckpoint(checkpoints, effectiveKeep(policy, state));
    if (plan.remove.length > 0) {
      const removed = await store.deleteCheckpoints(plan.remove);
      if (removed.ok) {
        const remaining = new Set(plan.keep.map((item) => item.id));
        checkpoints = checkpoints.filter((item) => remaining.has(item.id));
      }
    }
    probe.value = { ...probe.value, checkpoints: probe.value.checkpoints + 1 };
    publish();
    return true;
  }

  /** 处理一次 `tick`：按策略动作落盘（`checkpoint` 先写基线，再写最新状态）。 */
  async function pump(atMs: number, respectGesture: boolean): Promise<void> {
    if (!writeAllowed()) return;
    const step = policyReduce(policy, state, { kind: 'tick', atMs });
    state = step.state;
    if (step.action === 'none') return;
    if (respectGesture && state.active !== 'idle') return; // 手势期不落盘（策略层已保证；第二道保险）
    await onIdle();
    if (step.action === 'checkpoint') {
      const wroteCheckpoint = await writeCheckpoint(atMs);
      if (!wroteCheckpoint) return;
    }
    await writeLatest(atMs);
  }

  /**
   * 强制收口：**不看去抖窗口**，直接按"是否需要新检查点"决定写什么。
   *
   * 检查点仍按步数阈值触发（写最新状态不检查它就会**无界增长**——那正是"检查点"存在的意义）。
   * 状态机里的 `flushed` / `checkpointed` 事件照旧回喂，因此策略与产品路径**同一套账**。
   */
  const flushNow = async (): Promise<boolean> => {
    if (!writeAllowed()) return false;
    const atMs = Date.now();
    const stepsSince =
      state.lastCheckpointRev === null
        ? Number.POSITIVE_INFINITY
        : state.rev - state.lastCheckpointRev;
    if (state.lastCheckpointMs === null || stepsSince >= policy.checkpointEverySteps) {
      const wroteCheckpoint = await writeCheckpoint(atMs);
      if (!wroteCheckpoint) return false;
    }
    return writeLatest(atMs);
  };

  /**
   * 把当前 `revision` 暴露到 `window`（**只服务记录制测量**）。
   *
   * 用途：出口条件③要"重开之后读回恢复到哪一版"，而版本计数器住在会话里、页面外拿不到。
   * 这是一个**只读镜像**，不参与任何产品逻辑（改它不会改变文档）。
   */
  function publishRevisionMirror(): void {
    if (typeof window === 'undefined') return;
    // 来源取**会话本身**：镜像必须与"已经写下去的那一版"严格一致，直接读会话少一层转发
    // （实测在测量路径上 `args.revision` 给过 0，而同一时刻 `session.revision` 是 1）。
    (window as unknown as { __GANTTPILOT_REVISION__?: number }).__GANTTPILOT_REVISION__ =
      args.session.value.revision;
  }
  // 镜像随**会话**变化（这才是当前版本的真值；revision 只是它的转发）。
  watch(
    () => args.session.value.revision,
    () => {
      publishRevisionMirror();
    },
    { flush: 'sync' },
  );

  watch(
    () => args.revision.value,
    (rev) => {
      state = policyReduce(policy, state, { kind: 'change', rev, atMs: Date.now() }).state;
      dirtyAtMs ??= Date.now();
      publishRevisionMirror();
      publish();
    },
    { flush: 'sync' },
  );


  /**
   * 初始恢复的结算点（见 {@link UsePersistence.restoreSettled}）。
   *
   * `enabled === false`（`?persist=0`）与恢复抛错都要结算；恢复成功时在 `args.restore(...)`
   * 与其后的检查点写入**之后**结算——等待方由此拿到"应用不会再偷偷换文档"的那一刻。
   */
  let settleRestore: () => void = () => {};
  const restoreSettled = new Promise<void>((resolve) => {
    settleRestore = resolve;
  });

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') void flushNow();
  }

  const onPageHide = (): void => {
    void flushNow();
  };

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    if (args.enabled === false) {
      ready.value = true;
      publish();
      settleRestore();
      return;
    }
    void (async () => {
      const latest = await store.loadLatest(docId);
      const listed = await store.loadCheckpoints(docId);
      const decoded = decodeCandidates({
        latest: latest.ok ? latest.value : null,
        snapshots: listed.ok ? listed.value : [],
      });
      checkpoints = [...decoded.candidates.snapshots];
      const plan = planRestoreOf(decoded.candidates, docId);
      const now = Date.now();
      if (plan.session === null) {
        // 全新会话：**当前状态**就是基线 ⇒ 先建检查点（记录形状要求 `base` 非空）。
        ready.value = true;
        const wroteCheckpoint = await writeCheckpoint(now);
        if (wroteCheckpoint) await writeLatest(now);
        publishRevisionMirror();
      } else {
        args.restore({
          document: plan.session.document,
          undo: plan.session.undoStack,
          redo: plan.session.redoStack,
          revision: plan.session.revision,
        });
        base = decoded.candidates.latest?.base ?? null;
        state = createPolicyState({
          rev: plan.session.revision,
          lastCheckpointMs: now,
          lastCheckpointRev: plan.session.revision,
        });
        ready.value = true;
        publishRevisionMirror();
        publish();
        if (plan.rejected.length > 0) {
          args.notify({
            level: 'error',
            text: `上次的保存记录有 ${String(plan.rejected.length)} 处不可用，已回退到${plan.resolvedFrom === 'checkpoint' ? '最近检查点' : '最新状态'}：${plan.rejected[0]?.message ?? ''}`,
          });
        }
      }
      if (timer === null) {
        timer = window.setInterval(() => {
          void pump(Date.now(), true);
        }, 250);
      }
      // 成功与失败都要结算：等待方（测量方的"夹具必须是最后一个写入者"）不能被挂死。
    })().finally(settleRestore);
  });

  onUnmounted(() => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  });

  return {
    status,
    ready,
    probe,
    flushNow,
    writeRecordNow: async () => {
      if (!writeAllowed()) return false;
      return writeLatest(Date.now());
    },
    rebaseNow: async () => {
      if (!writeAllowed()) return false;
      const atMs = Date.now();
      // 先清掉内存里的基线（否则 `post` 会按旧基线的位置切），再写新检查点。
      base = null;
      const wroteCheckpoint = await writeCheckpoint(atMs);
      if (!wroteCheckpoint) return false;
      return writeLatest(atMs);
    },
    setGesture: (next: GestureActivity) => {
      const wasActive = state.active !== 'idle';
      state = policyReduce(policy, state, { kind: 'activity', active: next }).state;
      // 手势结束：**立刻**补写（"拖动期不落盘"与"松手后必须落盘"是一对）。
      if (wasActive && next === 'idle') void flushNow();
    },
    restoreSettled,
  };
}

/** 保留份数的口径（状态栏与测量脚本引用同一处，不在两处各写一遍）。 */
export { CHECKPOINT_KEEP };
