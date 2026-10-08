/**
 * 采样原语：帧等待、**稳定即止**的读数、滚动指纹与少量统计工具。
 *
 * 这些是五个测量族**共用**的那一层——口径只在这里写一遍（P-41：`settleStableRead` 全仓唯一）。
 * 只碰 DOM 与时间，不含任何测量判据。
 */

import { type ViewModel } from '@ganttpilot/render-core';

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** 双 rAF：第一帧提交 DOM，第二帧才算"画完"。 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** 单帧：只等下一次 rAF（滚动步进用它——用双 rAF 会把自己的等待算进"帧时长"）。 */
export function oneFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * 稳定读数的帧预算（**记录制口径的一部分**，证据文件必须一起登记）。
 *
 * 取 12 帧的理由：正常路径 **2 帧**就稳定（见 {@link settleStableRead}），余量留给"一帧做不完"
 * 的大夹具与首帧布局；超过它就不再是抖动，而是"应用没有收敛"。
 */
export const STABLE_READ_BUDGET_FRAMES = 12;

export interface StableReadResult {
  readonly frames: number;
  readonly stable: boolean;
  readonly elapsedMs: number;
}

/**
 * 滚动后**读数的稳定判据**（P-40 批次② 的 ②-β/γ，**全仓唯一实现**）。
 *
 * ## 它取代了什么
 *
 * 此前是"设 `scrollTop` → `nextTick` + **两帧**"（P-23 遗留 6）。那个常量**没有任何判据守着**：
 * rAF 被节流、或应用一帧做不完时，读到的可能是"状态已变、DOM 未变"的中间态 ⇒
 * 判据给出**假红**（把"没画完"读成"没对齐"）或**假绿**（旧值恰好通过），而且**不会报警**。
 *
 * ## 现在的口径
 *
 * 每帧读一次**指纹**（{@link scrollFingerprint}：DOM 真值 + 应用状态 + 行中心 + spacer 尺寸），
 * **连续两帧一致**即认为应用已处理完并返回；到 {@link STABLE_READ_BUDGET_FRAMES} 帧仍不一致 ⇒
 * `stable: false`，调用方必须**判红**（P-12"缺失即失败，不静默跳过"）。
 * 快路径仍是 2 帧 ⇒ 正常运行**没有额外开销**。
 *
 * ## 为什么指纹里要含 `view.scrollTop/scrollLeft`（②-γ 的安全子集）
 *
 * "应用已应用该滚动位置"的最强信号是应用自己的状态，但它**不能单独作为终止条件**——
 * 那会让"应用真的不同步"被读成"还没轮到我"，从而**掩盖**真缺陷（而 `scroll-out-of-sync`
 * 正在断言这件事）。所以它只作为指纹的一部分：既参与"稳没稳"，又不独占判定权。
 */
export async function settleStableRead(args: {
  readonly fingerprint: () => string;
  readonly budgetFrames?: number;
}): Promise<StableReadResult> {
  const budget = args.budgetFrames ?? STABLE_READ_BUDGET_FRAMES;
  const started = performance.now();
  let previous: string | null = null;
  for (let frame = 1; frame <= budget; frame += 1) {
    await oneFrame();
    const current = args.fingerprint();
    if (previous !== null && current === previous) {
      return { frames: frame, stable: true, elapsedMs: performance.now() - started };
    }
    previous = current;
  }
  return { frames: budget, stable: false, elapsedMs: performance.now() - started };
}

/**
 * 图表行 `<g>` 的选择器：SVG 是滚动容器的**兄弟**（修后）或子元素（修前/负向对照）——
 * 判据必须能在"坏结构"上照样采到数，否则负向对照无从谈起。
 */
export const CHART_ROW_SELECTOR = '.chart-pane-wrap .rows > g[data-task-id], #chart-pane .rows > g[data-task-id]';

/** 指纹里的"应用侧"输入（DOM 真值从 `pane` 与 DOM 直接读）。 */
interface FingerprintExpectation {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly contentWidth: number;
}

/** 稳定性指纹：把"应用状态 + DOM 真值 + 可见几何"压成一个字符串（相等即认为这一帧没有新变化）。 */
export function scrollFingerprint(pane: HTMLElement, expected: FingerprintExpectation): string {
  const parts: (number | string)[] = [
    pane.scrollTop,
    pane.scrollLeft,
    expected.scrollTop,
    expected.scrollLeft,
    expected.contentWidth,
    pane.clientWidth,
    pane.clientHeight,
  ];
  // 前 3 行的行中心：滚动/重算会让它整体平移，因此它对"DOM 还没跟上"最敏感。
  for (const row of [...document.querySelectorAll(CHART_ROW_SELECTOR)].slice(0, 3)) {
    const box = boxOf(row);
    parts.push(box === null ? 'x' : Math.round(box.top * 100) / 100);
  }
  const spacer = boxOf(document.querySelector('#chart-pane .chart-spacer'));
  parts.push(spacer === null ? 'x' : Math.round(spacer.width * 100) / 100);
  parts.push(spacer === null ? 'x' : Math.round(spacer.height * 100) / 100);
  return parts.join('|');
}

/** 只读地取一个元素的外接矩形（`null` = 元素不存在）。 */
export function boxOf(
  element: { getBoundingClientRect(): { readonly top: number; readonly left: number; readonly width: number; readonly height: number } } | null,
): { readonly top: number; readonly left: number; readonly width: number; readonly height: number } | null {
  return element === null ? null : element.getBoundingClientRect();
}

/** 渲染窗口是否覆盖了全部可见行（缓冲行的唯一作用）。 */
export function blankRowsOf(view: ViewModel): number {
  const rendered = new Set(view.rows.map((row) => row.row));
  let blank = 0;
  for (let row = view.firstVisible; row <= view.visibleLast; row += 1) if (!rendered.has(row)) blank += 1;
  return blank;
}
