/* global document, performance, requestAnimationFrame, PerformanceObserver, fetch, window, location, setTimeout, URLSearchParams, SVGSVGElement, HTMLElement */
/**
 * G4-S 浏览器探针页（**丢弃式**，不进主干）。
 *
 * ## 它测什么（S4-c，记录制）
 *
 * 1. **首屏**：起止事件 = "**文档与 Schedule 就绪**"→"**含依赖线的首帧完成**"（ADR 0007 §9）；
 *    同时记录从 `navigationStart` 起的分层数字（模块加载 / JSON / 排程 / 几何 / 首帧），
 *    以便按 §9 的"外壳 / 排程 / 首帧 / 依赖线"分层定位；
 * 2. **10× 滚动**：连续 10 次"一屏"滚动，每步重算窗口 + 几何 + DOM，记录每步主线程耗时与帧时长、
 *    以及 `longtask` 计数——与《评估报告》§5.4 的 2,200 边 / 约 2.0s **同尺**对照；
 * 3. **零空白行**：每步都断言"渲染行覆盖可见行"（缓冲行的唯一作用）。
 *
 * ## 三条纪律
 *
 * - **几何与计数都用共享模块**（`../view-model.mjs`、`../count.mjs`、`../manifest.mjs`），
 *   与 Node 侧跑的是**同一批文件**——否则"元素数与规模无关"会被两份实现污染的；
 * - **页内不构造 `Date`**：日期一律经引擎的序号↔ISO 翻译（S2 记录的时区陷阱）；
 * - **元素模型与 `count.mjs` 一一对应**：行 = `<g>`+条/菱形+进度；边 = `<path>`+箭头+透明热区。
 */

import { compute, createScheduleCalendar } from '../../../../packages/engine/dist/index.js';
import { formsForRelations } from '../arrows.mjs';
import { countElements } from '../count.mjs';
import { SCROLL_STEPS, VIEWPORT, ZOOM_LABEL } from '../manifest.mjs';
import { buildView } from '../view-model.mjs';

const NS = 'http://www.w3.org/2000/svg';
const params = new URLSearchParams(location.search);
const fixtureKey = params.get('fixture') ?? 'dense';
const rounds = Number(params.get('rounds') ?? '5');
/** 一次导航只测**一个档位**——否则"就绪 → 首帧"会累积前一个档位的轮次（第一版就踩过这个坑）。 */
const zoom = params.get('zoom') ?? 'day';
const measureScroll = (params.get('scroll') ?? '1') === '1';
const fixtureUrl = `/spikes/g0-s4-svg-clipping/out/fixture-${fixtureKey}.json`;

const svgNode = document.getElementById('chart');
if (!(svgNode instanceof SVGSVGElement)) throw new Error('探针页缺少 #chart 的 SVG 根节点');
const svg = svgNode;
svg.setAttribute('width', String(VIEWPORT.width));
svg.setAttribute('height', String(VIEWPORT.height));
const statusNode = document.getElementById('status');
if (!(statusNode instanceof HTMLElement)) throw new Error('探针页缺少 #status');

/** `window.__G4S__` 的宿主（CDP 侧靠它取结果；显式转型以免 `checkJs` 抱怨全局未声明）。 */
const hostWindow = /** @type {{ __G4S__?: unknown }} */ (/** @type {unknown} */ (window));

/** 探针完成 Promise（CDP 侧 `awaitPromise` 直接等它）。 */
/** @type {((value: unknown) => void) | undefined} */
let resolveDone;
const done = new Promise((settle) => {
  resolveDone = settle;
});
/** @type {{ status: string, fixture: string, done: Promise<unknown>, result: ProbeResult | null }} */
const g4sState = { status: 'running', fixture: fixtureKey, done, result: null };
hostWindow.__G4S__ = g4sState;

const arrowForms = formsForRelations();

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * @param {readonly number[]} values
 * @param {number} ratio
 */
function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** 双 rAF：第一帧提交 DOM，第二帧才算"画完"（单帧会把布局/绘制时间漏掉）。 */
function nextFrame() {
  return new Promise((settle) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => settle(undefined));
    });
  });
}

/** 单帧：只等下一次 rAF（滚动步进用它——用双 rAF 会把我们自己的等待算进"帧时长"）。 */
function oneFrame() {
  return new Promise((settle) => {
    requestAnimationFrame(() => settle(undefined));
  });
}

// ---------------------------------------------------------------- 渲染（元素模型与 count.mjs 对应）
/** @param {ReturnType<typeof buildView>} view */
function renderView(view) {
  const fragment = document.createDocumentFragment();

  // 轴：色带 + 网格线 + 标签（不做垂直位移，标签固定在顶部）
  const axisGroup = document.createElementNS(NS, 'g');
  for (const element of view.axis) {
    if (element.kind === 'band') {
      const band = document.createElementNS(NS, 'rect');
      band.setAttribute('x', String(element.x));
      band.setAttribute('y', '0');
      band.setAttribute('width', String(element.width));
      band.setAttribute('height', String(view.height));
      band.setAttribute('fill', '#f2f4f7');
      axisGroup.appendChild(band);
    } else if (element.kind === 'gridline') {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(element.x));
      line.setAttribute('x2', String(element.x));
      line.setAttribute('y1', '0');
      line.setAttribute('y2', String(view.height));
      line.setAttribute('stroke', '#e4e7ec');
      line.setAttribute('stroke-width', '1');
      axisGroup.appendChild(line);
    } else {
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(element.x + 2));
      label.setAttribute('y', '10');
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', '#667085');
      label.textContent = element.text ?? '';
      axisGroup.appendChild(label);
    }
  }
  fragment.appendChild(axisGroup);

  // 行（内容坐标 → 屏幕坐标用一次 translate，避免每行算两次）
  const rowsGroup = document.createElementNS(NS, 'g');
  rowsGroup.setAttribute('transform', `translate(0 ${String(-view.scrollTop)})`);
  for (const row of view.rows) {
    const group = document.createElementNS(NS, 'g');
    if (row.isMilestone && row.milestone !== null) {
      const { cx, cy, size } = row.milestone;
      const diamond = document.createElementNS(NS, 'polygon');
      diamond.setAttribute(
        'points',
        `${String(cx)},${String(cy - size / 2)} ${String(cx + size / 2)},${String(cy)} ${String(cx)},${String(cy + size / 2)} ${String(cx - size / 2)},${String(cy)}`,
      );
      diamond.setAttribute('fill', '#ed7d31');
      group.appendChild(diamond);
    } else {
      const bar = document.createElementNS(NS, 'rect');
      bar.setAttribute('x', String(row.xLeft));
      bar.setAttribute('y', String(row.barY));
      bar.setAttribute('width', String(Math.max(1, row.xRight - row.xLeft)));
      bar.setAttribute('height', String(row.barHeight));
      bar.setAttribute('fill', row.kind === 'summary' ? '#7a8699' : '#2e75b6');
      group.appendChild(bar);
      if (row.hasProgress) {
        const progress = document.createElementNS(NS, 'rect');
        progress.setAttribute('x', String(row.xLeft));
        progress.setAttribute('y', String(row.barY));
        progress.setAttribute('width', String(Math.max(0, row.progressWidth)));
        progress.setAttribute('height', String(row.barHeight));
        progress.setAttribute('fill', '#1f4e79');
        group.appendChild(progress);
      }
    }
    rowsGroup.appendChild(group);
  }
  fragment.appendChild(rowsGroup);

  // 依赖线：折线 + 箭头 + 透明热区（ADR 0007 §5）
  const edgesGroup = document.createElementNS(NS, 'g');
  edgesGroup.setAttribute('transform', `translate(0 ${String(-view.scrollTop)})`);
  for (const edge of view.edges) {
    const d = `M${edge.points.map(([x, y]) => `${String(x)} ${String(y)}`).join('L')}`;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', edge.ignored ? '#c9ccd1' : '#475467');
    path.setAttribute('stroke-width', '1');
    edgesGroup.appendChild(path);

    const form = arrowForms[edge.type] ?? { dir: 1, fill: 'solid' };
    const tip = edge.points[edge.points.length - 1];
    const arrow = document.createElementNS(NS, 'polygon');
    if (tip !== undefined) {
      const length = view.rowHeight * 0.5;
      const halfWidth = length * 0.6;
      const sign = edge.arrowDir >= 0 ? 1 : -1;
      arrow.setAttribute(
        'points',
        `${String(tip[0])},${String(tip[1])} ${String(tip[0] - sign * length)},${String(tip[1] + halfWidth)} ${String(tip[0] - sign * length)},${String(tip[1] - halfWidth)}`,
      );
    }
    arrow.setAttribute('fill', form.fill === 'hollow' ? '#ffffff' : edge.ignored ? '#c9ccd1' : '#475467');
    if (form.fill === 'hollow') arrow.setAttribute('stroke', '#475467');
    edgesGroup.appendChild(arrow);

    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '8');
    edgesGroup.appendChild(hit);
  }
  fragment.appendChild(edgesGroup);

  svg.replaceChildren(fragment);
}

/**
 * @typedef {object} ProbeSample
 * @property {number} round
 * @property {number} geometryMs
 * @property {number} renderMs
 * @property {number} frameMs
 * @property {number} fromReadyMs
 * @property {number} fromNavigationMs
 * @property {number} renderedRows
 * @property {number} renderedEdges
 * @property {number} elements
 *
 * @typedef {object} FirstScreenEntry
 * @property {string} zoom
 * @property {string} label
 * @property {ProbeSample[]} samples
 * @property {number} primaryFromReadyMs
 * @property {number} p50FrameMs
 * @property {number} p95FrameMs
 * @property {{ renderedRows: number, renderedEdges: number, elements: number }} counts
 *
 * @typedef {object} ProbeResult
 * @property {string} fixture
 * @property {string} userAgent
 * @property {object} viewport
 * @property {string} zoom
 * @property {boolean} measureScroll
 * @property {Record<string, number>} marks
 * @property {FirstScreenEntry[]} firstScreen
 * @property {any} scroll
 * @property {number} blankRowGaps
 * @property {string[]} errors
 * @property {string} [status]
 * @property {{ tasks: number, links: number, diagnostics: number }} [documentShape]
 */

// ---------------------------------------------------------------- 主流程
const result = /** @type {ProbeResult} */ ({
  fixture: fixtureKey,
  userAgent: window.navigator.userAgent,
  viewport: VIEWPORT,
  zoom,
  measureScroll,
  marks: {},
  firstScreen: [],
  scroll: null,
  blankRowGaps: 0,
  errors: [],
});

try {
  const tFixtureStart = performance.now();
  const response = await fetch(fixtureUrl, { cache: 'no-store' });
  const documentJson = await response.json();
  const tFixtureParsed = performance.now();
  result.marks.fixtureFetchAndParseMs = round(tFixtureParsed - tFixtureStart);

  const scheduleCalendar = createScheduleCalendar(documentJson);
  const tComputeStart = performance.now();
  const computed = compute(documentJson, scheduleCalendar);
  const tReady = performance.now();
  result.marks.computeMs = round(tReady - tComputeStart);
  if (!computed.ok) throw new Error(`页面内 compute 失败：${computed.code}`);
  const { schedule } = computed;
  result.marks.readyFromNavigationMs = round(tReady);
  result.documentShape = {
    tasks: documentJson.tasks.length,
    links: documentJson.links.length,
    diagnostics: schedule.diagnostics.length,
  };

  // 首屏：本档位重复 N 轮（第 1 轮就是"文档与 Schedule 就绪 → 含依赖线首帧"的口径数字）
  /** @type {object[]} */
  const samples = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const t0 = performance.now();
    const view = buildView({
      document: documentJson,
      schedule,
      calendar: scheduleCalendar,
      viewport: { ...VIEWPORT, scrollTop: 0, scrollLeft: 0 },
      zoom,
    });
    const t1 = performance.now();
    renderView(view);
    const t2 = performance.now();
    await nextFrame();
    const t3 = performance.now();
    samples.push({
      round: roundIndex,
      geometryMs: round(t1 - t0),
      renderMs: round(t2 - t1),
      frameMs: round(t3 - t0),
      fromReadyMs: round(t3 - tReady),
      fromNavigationMs: round(t3),
      renderedRows: view.rows.length,
      renderedEdges: view.edges.length,
      elements: countElements(view).total,
    });
  }
  const frameSamples = samples.map((sample) => sample.frameMs);
  result.firstScreen.push({
    zoom,
    label: ZOOM_LABEL[zoom] ?? zoom,
    samples,
    primaryFromReadyMs: samples[0]?.fromReadyMs ?? 0,
    p50FrameMs: round(percentile(frameSamples, 0.5)),
    p95FrameMs: round(percentile(frameSamples, 0.95)),
    counts: {
      renderedRows: samples[0]?.renderedRows ?? 0,
      renderedEdges: samples[0]?.renderedEdges ?? 0,
      elements: samples[0]?.elements ?? 0,
    },
  });

  // 10× 滚动（与《评估报告》§5.4 同尺：连续滚动 10 步）
  if (measureScroll) {
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: round(entry.startTime), duration: round(entry.duration) });
      }
    });
    observer.observe({ type: 'longtask', buffered: false });

    // 连续的 rAF 采样：**真实的帧间隔**（不受"我们自己等了两帧"污染）
    const rafDeltas = [];
    let rafRunning = true;
    let rafLast = performance.now();
    const rafLoop = () => {
      if (!rafRunning) return;
      const now = performance.now();
      rafDeltas.push(now - rafLast);
      rafLast = now;
      requestAnimationFrame(rafLoop);
    };
    requestAnimationFrame(rafLoop);

    const probeView = buildView({
      document: documentJson,
      schedule,
      calendar: scheduleCalendar,
      viewport: { ...VIEWPORT, scrollTop: 0, scrollLeft: 0 },
      zoom,
    });
    const visibleRowCount = Math.max(1, Math.ceil(VIEWPORT.height / VIEWPORT.rowHeight));
    const maxScrollTop = Math.max(0, (probeView.rowCount - visibleRowCount) * VIEWPORT.rowHeight);
    const pixelsPerStep = visibleRowCount * VIEWPORT.rowHeight;
    const steps = [];
    const wallStart = performance.now();
    for (let step = 1; step <= SCROLL_STEPS; step += 1) {
      const scrollTop = Math.min(maxScrollTop, step * pixelsPerStep);
      const t0 = performance.now();
      const view = buildView({
        document: documentJson,
        schedule,
        calendar: scheduleCalendar,
        viewport: { ...VIEWPORT, scrollTop, scrollLeft: 0 },
        zoom,
      });
      renderView(view);
      const t1 = performance.now();
      const renderedRows = new Set(view.rows.map((row) => row.row));
      let gaps = 0;
      for (let row = view.firstVisible; row <= view.visibleLast; row += 1) {
        if (!renderedRows.has(row)) gaps += 1;
      }
      result.blankRowGaps += gaps;
      await oneFrame();
      const t2 = performance.now();
      steps.push({
        step,
        scrollTop,
        workMs: round(t1 - t0),
        stepMs: round(t2 - t0),
        renderedRows: view.rows.length,
        renderedEdges: view.edges.length,
        elements: countElements(view).total,
        blankRows: gaps,
      });
    }
    const wallMs = performance.now() - wallStart;
    await new Promise((settle) => {
      setTimeout(settle, 400);
    });
    rafRunning = false;
    observer.disconnect();

    const workTimes = steps.map((step) => step.workMs);
    const warmDeltas = rafDeltas.slice(1); // 第一个 delta 含"启动采样"的等待
    result.scroll = {
      zoom,
      steps,
      totalWallMs: round(wallMs),
      totalWorkMs: round(workTimes.reduce((acc, value) => acc + value, 0)),
      p50WorkMs: round(percentile(workTimes, 0.5)),
      p95WorkMs: round(percentile(workTimes, 0.95)),
      maxWorkMs: round(Math.max(...workTimes)),
      rafSampleCount: warmDeltas.length,
      rafP50Ms: round(percentile(warmDeltas, 0.5)),
      rafP95Ms: round(percentile(warmDeltas, 0.95)),
      longTaskCount: longTasks.length,
      longTaskTotalMs: round(longTasks.reduce((acc, entry) => acc + entry.duration, 0)),
      longTasks: longTasks.slice(0, 10),
    };
  }

  result.status = 'ok';
} catch (error) {
  result.status = 'error';
  result.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

g4sState.status = result.status ?? 'unknown';
g4sState.result = result;
statusNode.textContent =
  result.status === 'ok'
    ? `G4-S 探针完成：档位 ${ZOOM_LABEL[zoom] ?? zoom}、首屏 ${String(result.firstScreen[0]?.primaryFromReadyMs ?? 0)} ms（就绪→首帧）、10× 滚动 ${String(result.scroll?.totalWallMs ?? 0)} ms、空白行 ${String(result.blankRowGaps)}`
    : `探针出错：${result.errors.join('；')}`;
resolveDone?.(result);
