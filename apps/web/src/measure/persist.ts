/**
 * 持久化测量（`--persist` / `--storage-metrics`）：开/关两组**同尺**对照（G6 出口条件①）
 * 与 2,000 任务的存储占用（出口条件④）。
 */

import { nextTick } from 'vue';

import { type FixtureSpec } from '@ganttpilot/render-core';
import { estimateStorage } from '../composables/usePersistence.js';

import { percentile, round } from './dom.js';
import { dragScreenPoint, type DragMeasurementHost } from './drag.js';

// ---------------------------------------------------------------- G6：持久化测量（记录制，ADR 0009 §5）

/** 持久化测量的宿主：由 `App.vue` 提供的**只读**入口。 */
export interface PersistenceMeasurementHost {
  /** 是否已接入持久化（`?persist=0` 时为假——它就是"关掉自动保存"的对照组）。 */
  readonly enabled: () => boolean;
  /** 测量钩子就绪（恢复流程跑完）后才允许开始采数。 */
  readonly ready: () => boolean;
  /** 立即写一次（并等它完成）。 */
  readonly flush: () => Promise<boolean>;
  /** 不理会策略，直接写一条记录（量"写入耗时"用；`flush` 在没变更时是空操作）。 */
  readonly writeRecord: () => Promise<boolean>;
  /** **硬重定基线**（换夹具之后必须做：否则记录里带着上一份文档的基线）。 */
  readonly rebase: () => Promise<boolean>;

  /** 只读样本（写次数 / 手势期写次数 / 最近一次延迟 / 记录字节数 / 检查点份数）。 */
  readonly probe: () => {
    readonly writes: number;
    readonly checkpoints: number;
    readonly lastWriteIncrementSteps: number;
    readonly lastFlushMs: number | null;
    readonly degradedReason: string | null;
    readonly writesDuringGesture: number;
    readonly recordBytes: number;
    /** 该记录的构成（基线 / 增量 / redo 各自多少字节）。 */
    readonly recordBreakdown: {
      readonly baseBytes: number;
      readonly postBytes: number;
      readonly redoBytes: number;
      readonly postSteps: number;
    } | null;
  };
  /** 拖动宿主（与 G5 的 `--drag` 完全同一条路：真实指针事件 + 真实手势状态机）。 */
  readonly drag: DragMeasurementHost;
}

/** 持久化测量的结果（记录制：出口条件①与④的数字都在这里）。 */
export interface PersistMeasureResult {
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  readonly dataset: string;
  /** 是否接入了持久化（对照组为假）。 */
  readonly enabled: boolean;
  /** 拖动期帧间隔（与 G5 `--drag` 同尺：p95 ≤ 33.3 ms 即 ≥30 fps）。 */
  readonly frameGapsMs: readonly number[];
  readonly frameGapP50Ms: number;
  readonly frameGapP95Ms: number;
  /** 拖动期主线程同步工作量（事件派发 + Vue 更新）。 */
  readonly mainThreadMs: readonly number[];
  readonly mainThreadP50Ms: number;
  readonly mainThreadP95Ms: number;
  readonly longTasks: number;
  /** **拖动期间的持久化写入次数（期望 0；出口条件①的可判定形式）。** */
  readonly writesDuringGesture: number;
  /** 拖动前/后的写入计数（用来断言"拖动期没有落盘"）。 */
  readonly writesBefore: number;
  readonly writesAfter: number;
  /** 拖动结束后等一次 `flush`，记录"松手 → 落盘完成"的墙钟（G6 出口条件①的时效数字）。 */
  readonly flushAfterReleaseMs: number | null;
  /** 2,000 任务夹具的存储占用与写入耗时（G6 出口条件④）。 */
  readonly storage: StorageMeasurement | null;
}

/** 存储占用与写入耗时（**单独一次采样**；夹具由调用方给）。 */
export interface StorageMeasurement {
  readonly tasks: number;
  readonly links: number;
  /** 整份规范文档文本的字节数（= 一份检查点的体积下界）。 */
  readonly documentBytes: number;
  readonly serializeMs: number;
  /** 单条"最新状态"记录的字节数（增量口径：与文档规模脱钩）。 */
  readonly recordBytes: number;
  /** 该记录的构成（记录制诊断：基线 / 增量 / redo 各自多少字节）。 */
  readonly recordBreakdown: {
    readonly baseBytes: number;
    readonly postBytes: number;
    readonly redoBytes: number;
    readonly postSteps: number;
  } | null;
  /** 采样前「最近一次写入记录」里的增量步数（0 = 基线就是当前状态）。 */
  readonly probeLastWriteIncrementSteps: number;
  /** 逐条 `put` 的墙钟（ms；p50/p95）。 */
  readonly putMs: readonly number[];
  readonly putP50Ms: number;
  readonly putP95Ms: number;
  /** `navigator.storage.estimate()` 的用量（字节）。 */
  readonly estimate: { readonly usage: number; readonly quota: number } | null;
}

/**
 * 跑一次持久化测量（**记录制**）。
 *
 * 口径（必须与数字一起引用）：
 * - 拖动用**真实指针事件**驱动（与 G5 `--drag` 同一条路），因此"拖拽期间不产生可见掉帧"
 *   这一条测的是产品路径，不是平行公式；
 * - **关掉持久化的对照组**由 `?persist=0` 提供（同一次采集里跑两组更可靠的做法是分别导航，故此处
 *   只采当前页面这一个口径，脚本负责跑两次）；
 * - 拖动前先 `flush`（把"之前积压的变更"清干净），否则"拖动期有没有落盘"会被旧账污染。
 */
export async function runPersistMeasurement(args: {
  readonly host: PersistenceMeasurementHost;
  readonly fixtureSpec: FixtureSpec;
  readonly dayDelta: number;
  readonly frames: number;
  readonly samples: number;
  /** 只测"存储占用与写入耗时"（出口条件④）：**不碰拖动**。 */
  readonly skipDrag?: boolean;
}): Promise<PersistMeasureResult> {
  const errors: string[] = [];
  const empty = (messages: readonly string[]): PersistMeasureResult => ({
    status: 'error',
    errors: messages,
    dataset: args.fixtureSpec.key,
    enabled: false,
    frameGapsMs: [],
    frameGapP50Ms: 0,
    frameGapP95Ms: 0,
    mainThreadMs: [],
    mainThreadP50Ms: 0,
    mainThreadP95Ms: 0,
    longTasks: 0,
    writesDuringGesture: 0,
    writesBefore: 0,
    writesAfter: 0,
    flushAfterReleaseMs: null,
    storage: null,
  });

  const pane = document.getElementById('chart-pane');
  if (pane === null) return empty(['找不到图表窗格（#chart-pane）']);
  if (!args.host.ready()) return empty(['持久化还没就绪（启动恢复未完成）']);

  if (args.skipDrag === true) {
    // 只测存储（出口条件④）：**不拖**，因此帧预算那几条在结果里保持空值。
    // **先硬重定基线**：换夹具之后的记录才有意义（基线 = 当前文档）。
    await args.host.rebase();
    let storageOnly: StorageMeasurement | null = null;
    try {
      storageOnly = await measureStorage(args.host, args.samples);
    } catch (error) {
      errors.push(`存储测量失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      ...empty([]),
      status: errors.length === 0 ? 'ok' : 'error',
      errors,
      enabled: args.host.enabled(),
      writesAfter: args.host.probe().writes,
      storage: storageOnly,
    };
  }

  // 换夹具之后**先硬重定基线**（否则记录里带着上一份文档的基线），再把积压清干净——
  // 这样"拖动期写入次数"才只反映拖动期。（跨轮污染由**脚本侧**在导航前清库解决。）
  await args.host.rebase();
  await args.host.flush();
  const writesBefore = args.host.probe().writes;

  const drag = args.host.drag;
  const target = (() => {
    const view = drag.view();
    if (view === null) return null;
    for (let row = view.renderFirst; row <= view.renderLast; row += 1) {
      const bounded = view.rows.find((item) => item.row === row);
      if (bounded === undefined) continue;
      if (bounded.isMilestone || bounded.kind === 'summary') continue;
      return { taskId: bounded.id, anchorOrdinal: bounded.es };
    }
    return null;
  })();
  if (target === null) return empty(['渲染窗口内没有可拖动的叶子任务']);

  /**
   * 第 `ordinalOffset` 个工作日的**格中点**对应的屏幕坐标。
   *
   * **直接复用 `--drag` 的 {@link dragScreenPoint}**（P3/C6-a）：这段此前是它的逐字副本
   * （row 查找 + 格中点 + 窗格偏移），而"抓取点"正是"按下不动 = 零位移"的锚——
   * 两份实现在**同一台机器上**给出同一个点这件事，没有任何门禁能证明。
   */
  const pointAt = (ordinalOffset: number): { readonly clientX: number; readonly clientY: number } | null =>
    dragScreenPoint(drag, pane, target.taskId, target.anchorOrdinal, ordinalOffset);

  const dispatch = (type: 'down' | 'move' | 'up', point: { clientX: number; clientY: number }): void => {
    const event = new MouseEvent(type === 'down' ? 'mousedown' : type === 'move' ? 'mousemove' : 'mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
      buttons: type === 'up' ? 0 : 1,
      view: window,
    });
    if (type === 'down') drag.pointer.down(event);
    else if (type === 'move') drag.pointer.move(event);
    else drag.pointer.up(event);
  };

  const start = pointAt(0);
  const end = pointAt(args.dayDelta);
  if (start === null || end === null) return empty(['无法把目标任务换算成屏幕坐标']);

  const mainThreadMs: number[] = [];
  const frameGapsMs: number[] = [];
  let lastFrameAt = performance.now();
  dispatch('down', start);
  await nextTick();
  if (drag.gestureKind() !== 'dragging') {
    errors.push(`按下后未进入拖动（实际 ${drag.gestureKind()}）`);
  }
  for (let index = 1; index <= args.frames; index += 1) {
    const offset = Math.round((args.dayDelta * index) / args.frames);
    const point = pointAt(offset) ?? start;
    const started = performance.now();
    dispatch('move', point);
    await nextTick();
    mainThreadMs.push(round(performance.now() - started));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const now = performance.now();
        frameGapsMs.push(round(now - lastFrameAt));
        lastFrameAt = now;
        resolve();
      });
    });
  }
  dispatch('up', end);
  await nextTick();

  const probeAfterDrag = args.host.probe();
  const writesDuringGesture = probeAfterDrag.writesDuringGesture;
  if (writesDuringGesture !== 0) {
    errors.push(`拖动期发生了 ${String(writesDuringGesture)} 次持久化写入（期望 0）`);
  }
  // 松手之后的合法终态包括 `released`/`rejected`/`outside`（状态机使然，见 GestureState）；
  // 这里只拒"**还在拖**"这两种——那才是真的没收尾。
  if (drag.gestureKind() === 'dragging' || drag.gestureKind() === 'linking') {
    errors.push(`松手后手势仍在 ${drag.gestureKind()}（期望已收尾）`);
  }

  // 松手 → 落盘完成：G6 出口条件①的时效数字（≤5s 的口径，实际应远小于它）。
  const releaseAt = performance.now();
  const flushed = await args.host.flush();
  const flushAfterReleaseMs = flushed ? round(performance.now() - releaseAt) : null;

  let storage: StorageMeasurement | null = null;
  try {
    storage = await measureStorage(args.host, args.samples);
  } catch (error) {
    errors.push(`存储测量失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const longTasks = (() => {
    try {
      return performance.getEntriesByType('longtask').length;
    } catch {
      return 0;
    }
  })();

  return {
    status: errors.length === 0 ? 'ok' : 'error',
    errors,
    dataset: args.fixtureSpec.key,
    enabled: args.host.enabled(),
    frameGapsMs,
    frameGapP50Ms: percentile(frameGapsMs, 0.5),
    frameGapP95Ms: percentile(frameGapsMs, 0.95),
    mainThreadMs,
    mainThreadP50Ms: percentile(mainThreadMs, 0.5),
    mainThreadP95Ms: percentile(mainThreadMs, 0.95),
    longTasks,
    writesDuringGesture,
    writesBefore,
    writesAfter: args.host.probe().writes,
    flushAfterReleaseMs,
    storage,
  };
}

/**
 * 存储占用与写入耗时（G6 出口条件④）。
 *
 * 三件事各自量一次：**整份文档的规范文本体积与序列化耗时**（一份检查点的下界）、
 * **逐条 `put` 的墙钟**（写入耗时；p50/p95）、**`estimate()` 的用量**。
 * 注意"整份文档序列化一次"正是 R-2 点名的成本项：本块的设计让它**只在检查点发生**。
 */
async function measureStorage(
  host: PersistenceMeasurementHost,
  samples: number,
): Promise<StorageMeasurement> {
  const projectDocument = host.drag.document();
  const t0 = performance.now();
  const serialized = JSON.stringify(projectDocument);
  const serializeMs = round(performance.now() - t0);
  const documentBytes = new TextEncoder().encode(serialized).length;

  // 写入采样：**每条都真的写一条记录**（`flush()` 在"没有未落盘变更"时是空操作 ⇒ 量不到耗时）。
  const putMs: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await host.writeRecord();
    const elapsed = round(performance.now() - started);
    if (elapsed > 0) putMs.push(elapsed);
  }
  const estimate = await estimateStorage();
  return {
    tasks: projectDocument.tasks.length,
    links: projectDocument.links.length,
    documentBytes,
    serializeMs,
    recordBytes: host.probe().recordBytes,
    recordBreakdown: host.probe().recordBreakdown,
    probeLastWriteIncrementSteps: host.probe().lastWriteIncrementSteps,
    // 说明：`recordBytes` 取自最近一次写入的记录（只含基线之后的增量）。
    putMs,
    putP50Ms: percentile(putMs, 0.5),
    putP95Ms: percentile(putMs, 0.95),
    estimate,
  };
}
