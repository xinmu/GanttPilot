#!/usr/bin/env node
/**
 * G4 的**打包产物测量**（记录制，**不进 `pnpm gate`**；ADR 0007 §9 第 ⑤ 层 / 裁决 P-17）。
 *
 * ## 为什么它是一个独立脚本而不是门禁步骤
 *
 * ① 它需要**本机 Chrome**（门禁必须在任何机器上可跑）；② 它是"测量快照"，换 Chrome 大版本
 * 数值必变（证据按大版本分文件）；③ **真正需要门禁的判据（几何期望值表、裁剪结构断言、
 * 不变量、负向对照）已全部落在 Node 侧的 spec 里**。缺 Chrome 时**失败而不是跳过**（P-12 口径）。
 *
 * ## 零新增依赖
 *
 * 用 Node 内置 `fetch` + 内置 `WebSocket` 通过 **CDP** 驱动本机 Chrome，静态资源用 `node:http`。
 * 不引入 Playwright / Puppeteer / jsdom（ADR 0007 §9 的"优先零新增依赖"由此落地）。
 *
 * ## 它测什么（每一项都对应一条出口条件）
 *
 * - **首屏**：`文档与 Schedule 就绪 → 含依赖线的首帧完成`，对 1,000 任务 ≤ 1,000 ms；
 * - **10× 滚动**：总墙钟、主线程 p50/p95、连续 rAF 帧间隔、longtask、空白行
 *   ——与《评估报告》§5.4 的"2,200 边 / 约 2.0 s"**同尺**对照；
 * - **元素预算**：渲染行/边与元素总数、`c₃`、是否在 `c₁·rows + c₂·edges + c₃ + c₄` 之内
 *   （`c₄` 的系数与逐档位锚值**只在声明处**：`render-core` 的 `manifest.ts` 的 `ELEMENT_MODEL_G5`
 *   与 `clipping.spec.ts` 的 `expectedC3`；ADR 0008 §16.4 + P-46 的悬停行带）。
 *
 * 用法：
 *   node scripts/measure-render.mjs                  # 主口径（dense·日档）+ 2,200 边对照
 *   node scripts/measure-render.mjs --zoom=week      # 只测某档位
 *   node scripts/measure-render.mjs --align          # G5 批次 D：两栏行对齐（左表在场；记录制）
 *   node scripts/measure-render.mjs --align=<label>  # 同上，证据文件名加后缀（诊断/复测各留一份）
 *   node scripts/measure-render.mjs --persist-drag   # G6：开/关自动保存两组同尺的拖拽帧预算
 *   node scripts/measure-render.mjs --storage-metrics # G6：2,000 任务的存储占用与写入耗时
 *   GANTTPILOT_CHROME=<path> node scripts/measure-render.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeChromeSession, connectCdp, findChrome, spawnChrome, startStaticServer, waitForDevToolsPort } from './cdp.mjs';
import { rel, repoRoot } from './paths.mjs';

const distRoot = join(repoRoot, 'apps', 'web', 'dist');
const evidenceDir = join(repoRoot, 'apps', 'web', 'evidence');

const ZOOM_KEYS = ['day', 'week', 'month'];
const PRIMARY_DATASET = 'dense';
const REFERENCE_DATASET = 'dense2200';

/**
 * 基视口（CSS 像素 / DPR 1）：**所有记录制测量共用**，也是 `--align` 迁移轮的起点。
 *
 * 为什么是 800（而不是 640）：产品界面在 640 的视口里只给得起约 570 px 的图表高度，
 * 而 ADR 0007 §11 的预算常数按**约 640 px 的图表窗格**（27 可见行 + 缓冲 = 32 渲染行）标定；
 * 取 800 后窗格正好约 640 px。
 */
const BASE_VIEWPORT = { width: 1280, height: 800 };

/** 行对齐容差（**与 `THRESHOLDS.rowAlignTolerancePx` 同值**；证据里只是把它写出来）。 */
const ALIGN_TOLERANCE_PX = 0.5;

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    zooms: [...ZOOM_KEYS],
    rounds: 5,
    scrollSteps: 10,
    includeReference: true,
    /** G5：只跑拖动测量（记录制），并写 `drag-timing-chrome<大版本>.md`。 */
    drag: false,
    /** G5：拖动跨越的工作日数（US-2 的口径是 3 天）。 */
    dayDelta: 3,
    /** G5：拖动期的测试帧数。 */
    dragFrames: 12,
    /**
     * G5：拖动测量的夹具（默认主口径 `dense` = 1,000 任务 / 1,500 依赖）。
     *
     * 为什么需要它（P-45）：拖动期新增的那一份"未提交副本"是 **O(n) 指针拷贝**，
     * 因此"帧预算够不够"这件事**与规模有关**——规模对照必须能复现，不能只留一张小夹具的快照。
     * 非主口径的证据文件名带数据集后缀（与 `--align=<label>` 同精神），不会覆盖主口径快照。
     */
    dragDataset: PRIMARY_DATASET,
    /**
     * 记录制：把一份 xlsx 交给**真实导入入口**并读回应用的反应
     * （`--import=<path>`；裁决 P-21 遗留 3 / P-22 的收口动作）。
     */
    importPath: null,
    /** G5 批次 D：两栏行对齐的**诊断/复测**（记录制），写 `chart-align[-<label>]-chrome<大版本>.md`。 */
    align: false,
    /** `--align=<label>`：证据文件名后缀（诊断与复测互不覆盖）。 */
    alignLabel: '',
    /** **两级刻度与悬停行带**的记录制快照（写 `chart-axis-hover-chrome<大版本>.md`；见 `--axis-hover`）。 */
    axisHover: false,
    /**
     * P-40 批次②：`--align` 覆盖的档位（默认全档）。
     * 档位盲区是 P-25 遗留的那一处——`pxPerDay` 变小 ⇒ 条宽进入 3 px 区、命中容差到边界。
     */
    alignZooms: [...ZOOM_KEYS],
    /**
     * P-40 批次②：resize 迁移的目标视口（默认 `1024x640`；`off` = 不做迁移轮）。
     *
     * 迁移判据 = "尺寸变化后两栏仍自洽"：A 视口设滚动 → resize 到 B → **不重设滚动**再读。
     * 这是 R6 家族（"几何来自一个被测量出来的尺寸"）里**唯一没有覆盖**的那一半。
     */
    alignResize: { width: 1024, height: 640 },
    /** G6：**开/关持久化两组同尺**的拖拽测量（出口条件①）。两组必须分别导航。 */
    persistDrag: false,
    /** G6：2,000 任务的存储占用与写入耗时（出口条件④）。 */
    storageMetrics: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--zoom=')) {
      const value = arg.slice('--zoom='.length);
      options.zooms = value === 'all' ? [...ZOOM_KEYS] : [value].filter((key) => ZOOM_KEYS.includes(key));
    } else if (arg.startsWith('--rounds=')) {
      options.rounds = Number(arg.slice('--rounds='.length)) || options.rounds;
    } else if (arg.startsWith('--steps=')) {
      options.scrollSteps = Number(arg.slice('--steps='.length)) || options.scrollSteps;
    } else if (arg === '--no-reference') {
      options.includeReference = false;
    } else if (arg === '--drag') {
      options.drag = true;
    } else if (arg.startsWith('--day-delta=')) {
      options.dayDelta = Number(arg.slice('--day-delta='.length)) || options.dayDelta;
    } else if (arg.startsWith('--drag-frames=')) {
      options.dragFrames = Number(arg.slice('--drag-frames='.length)) || options.dragFrames;
    } else if (arg.startsWith('--drag-dataset=')) {
      options.dragDataset = arg.slice('--drag-dataset='.length) || options.dragDataset;
    } else if (arg.startsWith('--import=')) {
      options.importPath = arg.slice('--import='.length);
    } else if (arg === '--persist-drag') {
      options.persistDrag = true;
    } else if (arg === '--storage-metrics') {
      options.storageMetrics = true;
    } else if (arg.startsWith('--align-zooms=')) {
      const value = arg.slice('--align-zooms='.length);
      options.alignZooms = value === 'all' ? [...ZOOM_KEYS] : value.split(',').filter((key) => ZOOM_KEYS.includes(key));
      if (options.alignZooms.length === 0) throw new Error(`--align-zooms 没有可用档位：${value}`);
    } else if (arg.startsWith('--align-resize=')) {
      const value = arg.slice('--align-resize='.length);
      if (value === 'off') {
        options.alignResize = null;
      } else {
        const match = /^(\d+)x(\d+)$/.exec(value);
        if (match === null) throw new Error(`--align-resize 需要 WxH 或 off：${value}`);
        options.alignResize = { width: Number(match[1]), height: Number(match[2]) };
      }
    } else if (arg === '--align' || arg.startsWith('--align=')) {
      // G5 批次 D：诊断与复测各留一份证据 ⇒ `--align=<label>` 只影响输出文件名。
      options.align = true;
      const label = arg.slice('--align'.length).replace(/^=/, '');
      if (label !== '') options.alignLabel = label;
    } else if (arg === '--axis-hover') {
      /**
       * **两级刻度与悬停行带**的记录制快照（P-46 的事实；判据本体在 `smoke:build` 的门禁侧）。
       *
       * 页面的读数口是 `__GANTTPILOT_MEASURE_AXIS_HOVER__`
       * （`apps/web/src/measure/axisHover.ts`）——它在 P3/C6-d 之前**零调用方**（见
       * [登记与本轮不做](../docs/04-refactor/05-登记与本轮不做.md) §四.16 的 `N15`），本模式就是它的驱动器。
       */
      options.axisHover = true;
    }
  }
  return options;
}

/**
 * 本次运行里页面报告的**钩子版本**（由 {@link openMeasuredPage} 记录）。
 *
 * 为什么要它：记录制最容易出的错不是数字不准，而是**测了一个不是当前代码的产物**
 * （页面装的钩子是旧的、或压根没装上）。脚本**不硬编码版本**（那会变成又一处常量分叉），
 * 只要求"页面报出版本"并把它登记进证据的 `环境` 块（P3/C6-d 兑现 `MEASURE_HOOK_VERSION`
 * 那条一直没人核对的承诺）。
 */
let measuredHookVersion = '';
/** 证据的 `环境` 块统一带这一行（见 {@link measuredHookVersion}）。 */
const hookVersionEnv = () => ({ 钩子版本: measuredHookVersion === '' ? '(未记录)' : measuredHookVersion });

/**
 * **记录制入口（唯一）**：导航 → 等钩子就绪 → **核对页面报告的钩子版本**。
 *
 * 为什么收成一个函数（P3/C6-d）：这段循环此前在**四处**各写一遍（主口径 / `--align` / `--persist` /
 * `--drag` 的预热），而"等的是什么"只有一处能写对；更要紧的是它顺带承担版本核对——
 * 这正是记录制与门禁的差别所在：门禁测的是刚构建的产物，记录制可能测**任何**产物。
 *
 * @param {object} cdp
 * @param {string} url
 * @param {{ hook: string, timeoutMs?: number, label?: string }} options `hook` 是钩子在 `window` 上的名字（含 `__` 前后缀）
 * @returns {Promise<{ version: string }>}
 */
async function openMeasuredPage(cdp, url, { hook, timeoutMs = 20_000, label = '测量钩子' }) {
  await cdp.navigate(url);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await cdp.evaluate(`(() => ({
      ready: Boolean(window.__GANTTPILOT_READY__),
      hook: typeof window.${hook} === 'function',
      version: window.__GANTTPILOT_MEASURE_VERSION__ ?? null,
    }))()`);
    if (state.ready === true && state.hook === true) {
      if (typeof state.version !== 'string' || state.version === '') {
        throw new Error(
          `${label}没有报告版本（window.__GANTTPILOT_MEASURE_VERSION__ 为空）` +
            '——测的可能是比本脚本更旧的产物（见 apps/web/src/measure/index.ts 的 MEASURE_HOOK_VERSION）',
        );
      }
      measuredHookVersion = state.version;
      return { version: state.version };
    }
    if (Date.now() > deadline) {
      const captured = await cdp.evaluate('window.__GANTTPILOT_ERROR__ ?? "(空)"');
      throw new Error(`${label}未就绪（${hook}）：${String(captured)}`);
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

/**
 * 跑一组测量（一个数据集 × 一个档位，一次导航）。
 *
 * 注意两点：
 * 1. `?table=0` 隐藏左表 —— 元素预算的 `c₃` 只取决于"图表窗格宽 ÷ `pxPerDay`"，
 *    只有**全宽图表**才与 ADR 0007 §11 的回填口径可比（分屏下 `c₃` 必然更小，是布局差异）；
 * 2. `?measure=` 的钩子是**动态 `import()`** 装上去的 ⇒ 就绪由 {@link openMeasuredPage} 轮询等待
 *    （并顺带核对钩子版本）。
 */
async function measureOne(cdp, origin, args) {
  const url = `${origin}/?measure=1&table=0&dataset=${encodeURIComponent(args.dataset)}&zoom=${String(args.zoom)}`;
  await openMeasuredPage(cdp, url, { hook: '__GANTTPILOT_MEASURE__' });
  return cdp.evaluate(
    `window.__GANTTPILOT_MEASURE__({ dataset: ${JSON.stringify(args.dataset)}, zoom: ${JSON.stringify(args.zoom)}, rounds: ${String(args.rounds)}, scrollSteps: ${String(args.scrollSteps)} })`,
  );
}

/** @param {number} value */
function ms(value) {
  return `${value.toFixed(1)} ms`;
}

/** @param {number} value */
function ratio(value) {
  return `${value.toFixed(3)}×`;
}

/** 渲染成证据 Markdown（不稳定层：**按 Chrome 大版本分文件**）。 */
function renderEvidence({ env, runs, options }) {
  const lines = [];
  lines.push('# G4 打包产物测量（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `scripts/measure-render.mjs` 采集；**这是测量快照，不是门禁**（[ADR 0007 §9 ⑤](../../../docs/02-adr/0007-渲染几何与裁剪契约.md)、[裁决 P-17](../../../docs/00-baseline/裁决记录.md)）。');
  lines.push('> 换机器、换 Chrome 大版本、headed 或 DPR>1 都必然改变绝对值；引用时必须连口径一起读。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 数据来源 = 合成夹具 + 页面内 `createScheduleCalendar` + `compute`（**不含 xlsx 导入**，`exceljs` 只准动态 `import()`）；');
  lines.push('- **首屏**：`文档与 Schedule 就绪 → 含依赖线的首帧完成`；首帧用**双 rAF**；');
  lines.push('- **10× 滚动**：单帧 rAF 步进，分开记"主线程耗时"（判据）与"连续 rAF 帧间隔"（记录）——');
  lines.push('  **不用双 rAF 测帧时长**（那会把约 33 ms 的等待算进去）；');
  lines.push('- 页面 = `apps/web/dist` 的**打包产物**（不是 G4-S 的无打包器探针页，两者数字不可直接比较）；');
  lines.push('- 首屏的**起点是"文档与 `Schedule` 就绪"**（`compute` 单列在原始 JSON 的 `prepareMs`）；');
  lines.push('- 10× 滚动用**单帧 rAF** 步进；"主线程耗时"只含同步工作量（几何 + 提交 + DOM 更新），');
  lines.push('  **不含帧等待**——双 rAF 的约 33 ms 一旦混进来，1 ms 的工作量会被报成 33 ms（G4-S 踩过）。');
  lines.push('');
  lines.push('## 首屏（`ready → 首帧`）');
  lines.push('');
  lines.push('> 视口与窗格：页面按 `Emulation.setDeviceMetricsOverride` 固定为 **1280×800、DPR 1**；');
  lines.push('> 图表窗格是 `视口 − 工具栏 − 状态栏` 之后的实际尺寸（脚本按真实 `clientWidth/clientHeight` 登记，不是假定值）。');
  lines.push('');
  lines.push('| 数据集 | 档位 | 窗格 h×w | 可见行 | 渲染行 | 渲染边 | 元素 | c₃ | DOM 行/边 | 在预算内 | 首屏（就绪→首帧） | 各轮 p50 / p95 | 几何 p50 | 渲染 p50 | 对 1,000 ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const first = run.result?.firstScreen;
    if (first === undefined || first === null) {
      lines.push(`| ${run.dataset} | ${run.zoom} | — | — | — | — | — | — | — | — | 失败 | — | — | — | — |`);
      continue;
    }
    const viewport = run.result.viewport ?? {};
    const visibleRows = Math.max(1, Math.ceil((viewport.height ?? 0) / (viewport.rowHeight ?? 24)));
    const geometry = first.layers.map((layer) => layer.geometryMs);
    const render = first.layers.map((layer) => layer.renderMs);
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    lines.push(
      `| ${run.dataset} | ${run.zoom} | ${String(viewport.height ?? '?')}×${String(viewport.width ?? '?')} | ${String(visibleRows)} | ${String(first.counts.renderedRows)} | ${String(first.counts.renderedEdges)} | ${String(first.counts.elements)} | ${String(first.counts.c3)} | ${String(first.domCounts?.renderedRows ?? -1)} / ${String(first.domCounts?.renderedEdges ?? -1)} | ${first.counts.withinBudget ? '✅' : '❌'} | ${ms(first.primaryMs)} | ${ms(first.p50Ms)} / ${ms(first.p95Ms)} | ${ms(median(geometry))} | ${ms(median(render))} | ${ratio(1000 / Math.max(first.primaryMs, 0.001))} 余量 |`,
    );
  }
  lines.push('');
  lines.push('> 首屏的**起点是"文档与 `Schedule` 就绪"**（`compute` 的耗时单列在原始 JSON 的 `prepareMs`）；');
  lines.push('> `primaryMs` 是第 1 轮、`p50/p95` 是全部轮次——**双 rAF 的下界就是约 33 ms**，所以轮次间的抖动是调度噪声，不要当回归；');
  lines.push('> "渲染行/边"来自元素模型，"DOM 行/边"是页面上真实存在的 `<g>` 数：');
  lines.push('> 两者必须相等，否则"元素预算"就是恒真式（脚本把不一致直接记进 `errors`）。');
  lines.push('> **`c₃` 与 G4-S 的回填值可比，但不是同一个数**：本轮页面用 `?table=0` 把图表放成全宽');
  lines.push('> （本页窗格宽见上面的实测列，比 G4-S 探针页的视口少一条滚动条宽），因此日/周/月的 `c₃`');
  lines.push('> 比 ADR 0007 §11 的单级回填值小 1–2（就是那点宽度差）；**逐档位锚值只在声明处**');
  lines.push('> （`render-core/src/clipping.spec.ts` 的 `expectedC3`），本文件的表格里给的是**本次实测值**；');
  lines.push('> 分屏下（隐藏左表之前）同一页面的 `c₃` 只有全宽口径的约三分之一——`c₃` 只取决于"窗格宽 ÷ `pxPerDay`"，');
  lines.push('> 与文档总规模无关，这是 §11.1 ③ 那条口径的直接后果。');
  lines.push('');
  lines.push('## 10× 滚动');
  lines.push('');
  lines.push('| 数据集 | 档位 | 总墙钟 | 主线程合计 | 主线程 p50 / p95 | 帧间隔 p50 / p95 | longtask | 空白行 | 对 §5.4（约 2.0 s） |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const scroll = run.result?.scroll;
    if (scroll === undefined || scroll === null) {
      lines.push(`| ${run.dataset} | ${run.zoom} | 失败 | — | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${run.dataset} | ${run.zoom} | ${ms(scroll.totalWallMs)} | ${ms(scroll.totalWorkMs)} | ${ms(scroll.p50WorkMs)} / ${ms(scroll.p95WorkMs)} | ${ms(scroll.rafP50Ms)} / ${ms(scroll.rafP95Ms)} | ${String(scroll.longTaskCount)} | ${String(scroll.blankRowGaps)} | ${ratio(2000 / Math.max(scroll.totalWallMs, 0.001))} 余量 |`,
    );
  }
  lines.push('');
  lines.push('## 判定');
  lines.push('');
  const firstScreenWorst = Math.max(...runs.map((run) => run.result?.firstScreen?.primaryMs ?? Number.POSITIVE_INFINITY));
  const budgetOk = firstScreenWorst <= 1000;
  const budgetInAll = runs.every((run) => run.result?.firstScreen?.counts?.withinBudget !== false);
  const blankOk = runs.every((run) => (run.result?.scroll?.blankRowGaps ?? 1) === 0);
  const frameOk = runs.every((run) => (run.result?.scroll?.p95WorkMs ?? Number.POSITIVE_INFINITY) <= 16.7);
  lines.push(`- **1,000 任务首屏 ≤ 1 s**：最差 ${ms(firstScreenWorst)} ⇒ ${budgetOk ? '**通过**' : '**不通过（按 ADR 0007 §9 分层定位后再决定降级）**'}；`);
  lines.push(`- **元素预算**：${budgetInAll ? '**全部在 `c₁·rows + c₂·edges + c₃ + c₄` 之内**（`c₄` 的系数与 `c₃` 的锚值只在声明处：`render-core` 的 `manifest.ts` 的 `ELEMENT_MODEL_G5` 与 `clipping.spec.ts` 的 `expectedC3`；ADR 0008 §16.4 + P-46 的悬停行带）' : '**有超预算项**'}；`);
  lines.push(`- **零空白行**：${blankOk ? '**成立**' : '**出现空白行**'}；`);
  lines.push(`- **主线程 p95 ≤ 16.7 ms**（记录制候选）：${frameOk ? '**成立**' : '**超出**'}。`);
  const collectErrors = runs.flatMap((run) =>
    (run.result?.errors ?? []).map((error) => `${run.dataset}/${run.zoom}：${String(error)}`),
  );
  if (collectErrors.length > 0) {
    lines.push('');
    lines.push('**页面内报错 / 判据失败**：');
    for (const error of collectErrors) lines.push(`- ${String(error)}`);
  }
  lines.push('');
  lines.push(`> 生成参数：${JSON.stringify(options)}`);
  lines.push('');
  return lines.join('\n');
}

/** G5 拖动证据（记录制）：帧预算 ≥30 fps、松手 ≤200 ms、下游跟随、松手清锚点。 */
function renderDragEvidence({ env, result, resize = null, options }) {
  const lines = [];
  const mainP95 = Number(result?.mainThreadP95Ms ?? 0);
  const gapP50 = Number(result?.frameGapP50Ms ?? 0);
  const gapP95 = Number(result?.frameGapP95Ms ?? 0);
  const releaseMs = Number(result?.releaseMs ?? 0);
  const followObserved = Number(result?.observedGeometryChanges ?? 0) > 0;
  const anchorsCleared = Number(result?.anchorsAfterRelease ?? -1) === 0;
  const fpsOk = gapP95 > 0 && gapP95 <= 1000 / 30;
  const releaseOk = releaseMs > 0 && releaseMs <= 200;
  const wroteDocument = result?.documentStartAfter !== null && result?.documentStartAfter !== undefined;
  const expectedAfter = result?.expectedStartAfter ?? null;
  const movedExactly = wroteDocument && expectedAfter !== null && result?.documentStartAfter === expectedAfter;

  lines.push('# G5 拖动测量（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/measure-render.mjs --drag` 采集；**这是测量快照，不是门禁**');
  lines.push('> （[ADR 0008 §11](../../../docs/02-adr/0008-列身份所有权与拖拽交互契约.md)、[裁决 P-9/P-17](../../../docs/00-baseline/裁决记录.md)）。');
  lines.push('> 拖动的判据本身（手势状态机、候选序号、松手命令、成环拒绝）在 `packages/render-core/src/gesture.spec.ts` 里，**进 `pnpm gate`**。');
  lines.push('> **位移判据**（裁决 [P-22](../../../docs/00-baseline/裁决记录.md) 补上）：松手后的 `startDate` 必须等于');
  lines.push('> 「拖动前该行的开始序号 + 拖动天数」——旧证据只断言"非空"，因此"拖了但没有效位移"也会算通过。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 数据来源 = 合成夹具 + 页面内 `createScheduleCalendar` + `compute`（**不含 xlsx 导入**，`exceljs` 只准动态 `import()`）；');
  lines.push('- 驱动方式 = **真实指针事件**（`mousedown → mousemove×N → mouseup`）走 `useGesture` 的同一条入口，不另开测试后门；');
  lines.push(`- 拖动跨度 = **${String(options.dayDelta)} 个工作日**（US-2 的口径），拆成 **${String(options.dragFrames)}** 个测试帧；`);
  lines.push('- **主线程工作量** = 派发事件 + `await nextTick()`（**不含帧等待**）——与 G4 的滚动口径同源；');
  lines.push('- **帧间隔** = 连续 rAF 的间隔（只作记录；**不能用双 rAF 测帧时长**，那会把等待算进来）；');
  lines.push('- **松手耗时** = `mouseup` → 命令落库 + `compute` + 覆盖层清空 的墙钟；');
  lines.push('- **下游跟随**的间接证据 = 拖动期 DOM 上条形的宽度/位置串发生过变化（不是只有覆盖层在动）；');
  lines.push(`- **位移** = 抓取点取条体**第一个工作日格的中点**，逐帧移到「该格 + offset」个工作日；`);
  lines.push('  因此"拖 N 个工作日"是一个**线性**位移（基准是拖动前的开始序号，不是拖动期视图里跟着动的 `es`）。');
  lines.push('- **两种语义各跑一轮**（P-45 起）：① `move`（整体移动）——位移判据看 `startDate`；');
  lines.push('  ② `resize-duration`（改工期）——抓条右端内 2 px，位移判据看 `durationDays`，');
  lines.push('  另加"下游跟随"（拖动期 == 松手后 **且** ≠ 拖动前）与"预览不落库"（拖动期 `revision` 不变）两条。');
  lines.push('');
  lines.push('## ① 整体移动（`move`）：两个滚动状态各一次（P-25）');
  lines.push('');
  lines.push('| 滚动位置 (top,left) | 目标任务 | 松手后锚点 | 期望 `startDate` | 实际 `startDate` | 判定 |');
  lines.push('|---|---|---|---|---|---|');
  for (const run of result?.runs ?? []) {
    const item = run.result ?? {};
    const expected = item.expectedStartAfter ?? null;
    const actual = item.documentStartAfter ?? null;
    const moved = actual !== null && expected !== null && actual === expected;
    const anchored = Number(item.anchorsAfterRelease ?? -1) === 0;
    lines.push(
      `| (${String(run.scrollTop)}, ${String(run.scrollLeft)}) | \`${String(item.taskId ?? '')}\` | ${anchored ? '0（已清）' : String(item.anchorsAfterRelease ?? '-')} | ${String(expected ?? '—')} | ${String(actual ?? '—')} | ${moved ? '✅' : '❌'} |`,
    );
  }
  lines.push('');
  lines.push('> **滚动状态是 P-25 新增的判据**：R13（命中反算多加一次 `scrollTop`）会让"按下后根本没进拖动"；');
  lines.push('> R14（`dayAtX` 多加一次 `scrollLeft`）会让候选整体偏 `scrollLeft / pxPerDay` 天（600 px ⇒ 偏 25 个自然日）。');
  lines.push('> `(0,0)` 那一行在两处缺陷下**都是绿的**——只跑首屏的判据证明不了这一半。');
  lines.push('');
  lines.push('## 手柄、光标与连接点（批次 B／裁决 P-32 的记录制采样）');
  lines.push('');
  lines.push('| 量 | 值 | 判据 | 判定 |');
  lines.push('|---|---|---|---|');
  const handleSample = result?.handles ?? null;
  if (handleSample === null) {
    lines.push('| 采样 | — | 页面未提供 `handles` 宿主 | ⚠️ |');
  } else {
    lines.push(`| DOM 手柄条数 | ${String(handleSample.domHandles)} | = 模型（恒显） | ${handleSample.domHandles === handleSample.modelHandles ? '✅' : '❌'} |`);
    lines.push(`| 模型手柄条数 | ${String(handleSample.modelHandles)} | 与 \`rowHandlesFor\` 同源 | — |`);
    lines.push(`| DOM 连接点条数（指针所在行） | ${String(handleSample.domConnectPoints)} | = 2（**按需显形**） | ${handleSample.domConnectPoints === 2 ? '✅' : '❌'} |`);
    lines.push(`| 模型连接点条数（全部渲染行） | ${String(handleSample.modelConnectPoints)} | 与 \`rowHandlesFor\` 同源 | — |`);
    lines.push(`| 采样到的连接点左缘 | ${handleSample.connectLeftEdge === null ? '—' : String(handleSample.connectLeftEdge)} | = 条右缘 − CONNECT_INSET_PX（**跨在条端上**） | ${handleSample.connectLeftEdge === null ? '❌' : '✅'} |`);
    lines.push(`| 条体中部光标 | \`${String(handleSample.cursorOnBar)}\` | = \`move\` | ${handleSample.cursorOnBar === 'move' ? '✅' : '❌'} |`);
    lines.push(`| 端点手柄处光标 | \`${String(handleSample.cursorOnEdge)}\` | = \`col-resize\` | ${handleSample.cursorOnEdge === 'col-resize' ? '✅' : '❌'} |`);
    lines.push(`| 连接点处光标 | \`${String(handleSample.cursorOnConnect)}\` | = \`crosshair\` | ${handleSample.cursorOnConnect === 'crosshair' ? '✅' : '❌'} |`);
    lines.push(`| 从连接点按下进入建线 | ${handleSample.connectDownEntersLinking ? '是' : '否'} | 必须为"是"（R4 的修法） | ${handleSample.connectDownEntersLinking ? '✅' : '❌'} |`);
    lines.push(
      `| 连接点的 DOM 形状 | \`<${String(handleSample.connectTag || '?')}>\` | = \`circle\`（**P-42 批次③ 的圆点口径**） | ${handleSample.connectTag === 'circle' ? '✅' : '❌'} |`,
    );
    const connectBox = handleSample.connectBox;
    lines.push(
      `| 连接点可见盒（宽 × 高） | ${connectBox === null ? '—' : `${String(connectBox.width)} × ${String(connectBox.height)}`} | **正方形**（圆的外接盒）且 ≤ \`CONNECT_SIZE_PX\`（可见 ⊆ 命中盒） | ${
        connectBox !== null && Math.abs(connectBox.width - connectBox.height) <= 0.5 && connectBox.width <= 12.5 ? '✅' : '❌'
      } |`,
    );
  }
  lines.push('');
  lines.push('> 采样点的 x **从 DOM 矩形反推**（不在这里重算公式）：端点手柄画在**判定区边界**上，');
  lines.push('> 与条形的端相差 `edgePx`（宽条 6 px）；连接点则**跨在条端上**（`[xRight − CONNECT_INSET_PX, xRight − CONNECT_INSET_PX + CONNECT_SIZE_PX]`）');
  lines.push('> ——"看得见的图形一定点得中"（P-32 第三次复验把命中区扩到"可见图形 + 外侧 `CONNECT_HIT_PAD_PX`"，实测可用宽度 14 → 20 px）。');
  lines.push('> **P-42 批次③**把连接点从"与条体等高的正方形白框"改成**圆圈**（直径略小于条高、且 ≤ 命中盒边长，');
  lines.push('> 圆心 = 命中盒中点 + 条心）：命中区与判定区**一字未改**，改的只是外观与 DOM 标签。');
  lines.push('> 这三条是**入口层**性质（手柄是否在、光标是否分三类、连接点是否真的起建线），');
  lines.push('> 纯函数判据在 `interaction.spec.ts`（进 `pnpm gate`），这里只采打包产物上的真实 DOM。');
  lines.push('');
  lines.push('## ① 整体移动（`move`）的结果（两次运行取最差 / 并集）');
  lines.push('');
  lines.push('| 量 | 值 | 判据 | 判定 |');
  lines.push('|---|---|---|---|');
  lines.push(`| 主线程同步工作量 p50 | ${mainP95 === 0 ? '—' : `${Number(result?.mainThreadP50Ms ?? 0).toFixed(2)} ms`} | 记录 | — |`);
  lines.push(`| 主线程同步工作量 p95 | ${mainP95.toFixed(2)} ms | ≤ 16.7 ms（帧预算候选） | ${mainP95 <= 16.7 ? '✅' : '⚠️'} |`);
  lines.push(`| 帧间隔 p50 | ${gapP50.toFixed(1)} ms | 记录 | — |`);
  lines.push(`| 帧间隔 p95 | ${gapP95.toFixed(1)} ms | ≥30 fps ⇒ ≤ 33.3 ms | ${fpsOk ? '✅' : '⚠️'} |`);
  lines.push(`| 松手 → 重算 + 冲突标记 | ${releaseMs.toFixed(1)} ms | ≤ 200 ms（IX-04） | ${releaseOk ? '✅' : '⚠️'} |`);
  lines.push(`| 拖动期 DOM 变化帧数 | ${String(result?.observedGeometryChanges ?? 0)} / ${String(result?.frames ?? 0)} | > 0（下游跟随） | ${followObserved ? '✅' : '❌'} |`);
  lines.push(`| longtask 条目 | ${String(result?.longTasks ?? 0)} | 记录 | — |`);
  lines.push(`| 松手后锚点数 | ${String(result?.anchorsAfterRelease ?? '-')} | = 0（锚点不进文档、松手即清） | ${anchorsCleared ? '✅' : '❌'} |`);
  lines.push(`| 拖动前开始序号 | ${String(result?.anchorOrdinal ?? '—')} | 记录（位移的绝对基准） | — |`);
  lines.push(`| 期望的松手后 startDate | ${String(expectedAfter ?? '—')} | = 拖动前开始序号 + ${String(options.dayDelta)} 个工作日 | — |`);
  lines.push(`| 松手后文档 startDate | ${String(result?.documentStartAfter ?? '—')} | = 期望值（**位移判据**） | ${movedExactly ? '✅' : '❌'} |`);
  lines.push('');
  lines.push(`> 拖动目标任务：\`${String(result?.taskId ?? '')}\`；数据集 \`${String(result?.dataset ?? '')}\`。`);
  if ((result?.errors ?? []).length > 0) {
    lines.push('');
    lines.push('**页面内报错**：');
    for (const error of result.errors) lines.push(`- ${String(error)}`);
  }

  // ---------------------------------------------------------------- ② 改工期（P-45）
  if (resize !== null && resize !== undefined) {
    const rMainP95 = Number(resize.mainThreadP95Ms ?? 0);
    const rGapP50 = Number(resize.frameGapP50Ms ?? 0);
    const rGapP95 = Number(resize.frameGapP95Ms ?? 0);
    const rDurationOk =
      resize.durationAfter !== null &&
      resize.expectedDurationAfter !== null &&
      Number(resize.durationAfter) === Number(resize.expectedDurationAfter);
    const rNotPersisted = Number(resize.revisionDuringDrag) === Number(resize.revisionBefore);
    const rLanded = Number(resize.revisionAfterRelease) > Number(resize.revisionBefore);
    const downstream = resize.downstream ?? null;
    const downstreamMoved = downstream !== null && Number(downstream.after) !== Number(downstream.before);
    const downstreamMatches = downstream !== null && Number(downstream.during) === Number(downstream.after);

    lines.push('');
    lines.push('## ② 改工期（`resize-duration`）——下游跟随与"预览不落库"（P-45 新增）');
    lines.push('');
    lines.push('> 抓取点 = **条右端内 4 px**（`edgeR = [xRight − edgePx, xRight]`，而连接点的命中区从 `xRight − CONNECT_INSET_PX` 起');
    lines.push('> ⇒ 能起"改工期"的窗口是 `[xRight − 6, xRight − 2)`，取中点 4）。判据先用 `gestureMode`');
    lines.push('> **自证**内核真的把它判成了 `resize-duration`——否则探针会退化成整体移动，');
    lines.push('> 而"下游跟随"在退化下换个理由也能成立（那种绿是恒真式）。');
    lines.push('');
    lines.push('| 滚动位置 (top,left) | 目标任务 | 工期 拖动前 → 松手后 | 期望 | 判定 |');
    lines.push('|---|---|---|---|---|');
    for (const run of resize.runs ?? []) {
      const item = run.result ?? {};
      const ok = Number(item.durationAfter) === Number(item.expectedDurationAfter) && item.status === 'ok';
      lines.push(
        `| (${String(run.scrollTop)}, ${String(run.scrollLeft)}) | \`${String(item.taskId ?? '')}\` | ${String(item.durationBefore ?? '-')} → ${String(item.durationAfter ?? '-')} | ${String(item.expectedDurationAfter ?? '-')} | ${ok ? '✅' : '❌'} |`,
      );
    }
    lines.push('');
    lines.push('### 下游跟随（预览 == 提交）');
    lines.push('');
    lines.push('| 后继任务 | 边 | 拖动前 es | 拖动期 es（预览副本） | 松手后 es（已落库） | 判定 |');
    lines.push('|---|---|---|---|---|---|');
    if (downstream === null) {
      lines.push('| — | — | — | — | — | ❌（没采到载体） |');
    } else {
      lines.push(
        `| \`${String(downstream.taskId)}\` | ${String(downstream.linkType)} | ${String(downstream.before)} | ${String(downstream.during)} | ${String(downstream.after)} | ${downstreamMatches ? '✅' : '❌'} |`,
      );
    }
    lines.push('');
    lines.push('> 判据两条一起读：**拖动期 == 松手后**（预览与提交同源）**且 松手后 ≠ 拖动前**');
    lines.push('> （前提自证：这条边真的由被拖任务的完成日决定，否则"相等"是恒真式）。');
    lines.push('');
    lines.push('### 预览不落库（修订号）');
    lines.push('');
    lines.push('| 时刻 | 已提交 `revision` | 判据 | 判定 |');
    lines.push('|---|---|---|---|');
    lines.push(`| 拖动前 | ${String(resize.revisionBefore ?? '-')} | 基准 | — |`);
    lines.push(`| 拖动期（预览副本生效） | ${String(resize.revisionDuringDrag ?? '-')} | = 拖动前（预览**不进命令通道**） | ${rNotPersisted ? '✅' : '❌'} |`);
    lines.push(`| 松手后 | ${String(resize.revisionAfterRelease ?? '-')} | > 拖动前（命令真的落库） | ${rLanded ? '✅' : '❌'} |`);
    lines.push('');
    lines.push('### 帧预算（同尺）');
    lines.push('');
    lines.push('| 量 | 值 | 判据 | 判定 |');
    lines.push('|---|---|---|---|');
    lines.push(`| 主线程同步工作量 p50 | ${rMainP95 === 0 ? '—' : `${Number(resize.mainThreadP50Ms ?? 0).toFixed(2)} ms`} | 记录 | — |`);
    lines.push(`| 主线程同步工作量 p95 | ${rMainP95.toFixed(2)} ms | ≤ 16.7 ms（帧预算候选） | ${rMainP95 <= 16.7 ? '✅' : '⚠️'} |`);
    lines.push(`| 帧间隔 p50 | ${rGapP50.toFixed(1)} ms | 记录 | — |`);
    lines.push(`| 帧间隔 p95 | ${rGapP95.toFixed(1)} ms | ≥30 fps ⇒ ≤ 33.3 ms | ${rGapP95 > 0 && rGapP95 <= 1000 / 30 ? '✅' : '⚠️'} |`);
    lines.push(`| 松手 → 重算 + 冲突标记 | ${Number(resize.releaseMs ?? 0).toFixed(1)} ms | ≤ 200 ms（IX-04） | ${Number(resize.releaseMs ?? 0) <= 200 ? '✅' : '⚠️'} |`);
    lines.push(`| 拖动期 DOM 变化帧数 | ${String(resize.observedGeometryChanges ?? 0)} / ${String(resize.frames ?? 0)} | > 0 | ${Number(resize.observedGeometryChanges ?? 0) > 0 ? '✅' : '❌'} |`);
    lines.push(`| 内核判定的语义 | \`${String(resize.gestureMode ?? '-')}\` | = \`resize-duration\`（自证抓对了地方） | ${resize.gestureMode === 'resize-duration' ? '✅' : '❌'} |`);
    lines.push(`| 工期位移 | ${String(resize.durationBefore ?? '-')} → ${String(resize.durationAfter ?? '-')} | = 拖动前 + ${String(options.dayDelta)} | ${rDurationOk ? '✅' : '❌'} |`);
    lines.push(`| 下游跟随 | ${downstream === null ? '—' : `${String(downstream.before)} → ${String(downstream.during)} → ${String(downstream.after)}`} | 拖动期 == 松手后 **且** ≠ 拖动前 | ${downstreamMoved && downstreamMatches ? '✅' : '❌'} |`);
    lines.push('');
    if ((resize.errors ?? []).length > 0) {
      lines.push('**页面内报错**：');
      for (const error of resize.errors) lines.push(`- ${String(error)}`);
      lines.push('');
    }
  }

  lines.push('');
  lines.push(`> 生成参数：${JSON.stringify(options)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 记录制：**把一份 xlsx 交给真实导入入口**，读回应用的反应（裁决 P-21 遗留 3 / P-22）。
 *
 * 口径：
 * - 文件走 CDP 的 `DOM.setFileInputFiles` 打到工具栏的 `input[type=file]` ——
 *   **不碰应用源码**，也不给导入路径开后门；
 * - 结果**全部从 DOM 读**：页脚的任务/依赖/诊断计数、诊断清单（点击工具栏「诊断」展开）、
 *   是否出现"不可排程"占位；
 * - 判据（缺一即 `status: 'error'`）：6 任务 / 5 依赖、恰有 **1** 条
 *   `XLSX_CYCLE_EDGE_DROPPED` 且消息里带成环路径、**没有**"不可排程"。
 */
async function importSample(cdp, origin, filePath) {
  const errors = [];
  const base = {
    file: filePath,
    sizeBytes: statSync(filePath).size,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    footer: '',
    tasks: null,
    links: null,
    diagnostics: [],
    cycleDropped: 0,
    unschedulable: null,
    chartRows: 0,
    chartEdges: 0,
  };

  await cdp.navigate(`${origin}/`);
  // 应用启动 + 演示文档（1,000 任务）就位。
  await new Promise((settle) => setTimeout(settle, 800));

  await cdp.call('DOM.enable');
  const root = await cdp.call('DOM.getDocument', { depth: -1 });
  const input = await cdp.call('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector: 'input[type=file]',
  });
  if (input?.nodeId === undefined || input.nodeId === 0) {
    return { ...base, status: 'error', errors: ['找不到文件输入框（工具栏的 input[type=file]）'] };
  }

  const before = await cdp.evaluate(`document.querySelector('footer.status')?.textContent ?? ''`);
  await cdp.call('DOM.setFileInputFiles', { files: [filePath], nodeId: input.nodeId });

  // 等导入完成：exceljs 是动态 import，页脚计数会从演示文档变成导入文档。
  const deadline = Date.now() + 30_000;
  let footer = before;
  while (Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 250));
    footer = await cdp.evaluate(`document.querySelector('footer.status')?.textContent ?? ''`);
    if (footer !== before) break;
  }
  if (footer === before) {
    errors.push('导入后页脚计数未变化（导入可能未触发或仍在进行）');
  }

  // 展开诊断清单（工具栏按钮文案是「诊断 N」）。
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('诊断'));
    if (button !== undefined) button.click();
    return true;
  })()`);
  await new Promise((settle) => setTimeout(settle, 250));

  const snapshot = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.diagnostics li')].map((li) => ({
      code: li.querySelector('code')?.textContent ?? '',
      severity: li.className,
      message: [...li.querySelectorAll('span')].map((span) => span.textContent).join(''),
      taskId: li.querySelector('em')?.textContent ?? null,
    }));
    return {
      footer: document.querySelector('footer.status')?.textContent ?? '',
      diagnostics: items,
      unschedulable: document.querySelector('.unschedulable') !== null,
      chartRows: document.querySelectorAll('.chart-pane-wrap .rows > g, #chart-pane .rows > g').length,
      chartEdges: document.querySelectorAll('.chart-pane-wrap .edges > g, #chart-pane .edges > g').length,
    };
  })()`);

  const footerText = String(snapshot?.footer ?? '');
  const parsed = /任务\s*(\d+)\s*·\s*依赖\s*(\d+)/.exec(footerText);
  const diagnostics = Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : [];
  const dropped = diagnostics.filter((item) => item.code === 'XLSX_CYCLE_EDGE_DROPPED');

  const result = {
    ...base,
    footer: footerText,
    tasks: parsed === null ? null : Number(parsed[1]),
    links: parsed === null ? null : Number(parsed[2]),
    diagnostics,
    cycleDropped: dropped.length,
    unschedulable: snapshot?.unschedulable === true,
    chartRows: Number(snapshot?.chartRows ?? 0),
    chartEdges: Number(snapshot?.chartEdges ?? 0),
  };

  if (result.tasks !== 6) errors.push(`任务数不是 6：${String(result.tasks)}`);
  if (result.links !== 5) errors.push(`依赖数不是 5：${String(result.links)}`);
  if (result.cycleDropped !== 1) {
    errors.push(`XLSX_CYCLE_EDGE_DROPPED 不是恰好 1 条：${String(result.cycleDropped)}`);
  }
  if (dropped.length > 0 && !String(dropped[0].message).includes('成环路径')) {
    errors.push(`成环丢弃的诊断里没有成环路径：${String(dropped[0].message)}`);
  }
  if (result.unschedulable) errors.push('导入产物被判为"不可排程"（成环边本该被确定性丢弃）');

  return { ...result, status: errors.length === 0 ? 'ok' : 'error', errors };
}

/**
 * 证据末尾附一行**具名**的"原始读数"链接（P4-d）。
 *
 * 为什么需要它：raw 与 `.md` 是成对写出的，但正文此前只写"逐行值见 raw JSON"这类**不带文件名**的
 * 说法 ⇒ 链接图里 raw 成了孤儿（C8-a 的"引用方向不可解析"）。生成器侧与已提交证据必须**同批**落盘，
 * 否则盘上的证据就不再是生成器的输出（见 `docs/04-refactor/04-验收与门禁.md` §四）。
 */
function withRawLink(markdown, rawName) {
  return `${markdown.replace(/\s*$/, '')}\n\n> **原始读数**：[\`${rawName}\`](${rawName})（机器可读，便于日后重比）。\n`;
}
/** 导入记录制的证据（Markdown）。 */
function renderImportEvidence({ env, result }) {
  const lines = [];
  lines.push('# xlsx 导入记录制（成环样本，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/make-sample.mjs` + `node scripts/measure-render.mjs --import=<path>` 采集');
  lines.push('> （[裁决 P-21](../../../docs/00-baseline/裁决记录.md) §5 遗留 3、[P-22](../../../docs/00-baseline/裁决记录.md)）。');
  lines.push('> 成环边**丢弃**的语义本身由 `packages/xlsx-protocol/src/xlsxDependencies.spec.ts` 在门禁里覆盖；');
  lines.push('> 这一份证据守的是**应用层那一遍**：导入 → 诊断清单 → 任务/依赖计数。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 样本');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  // P4-d：输入路径写**仓库根相对 + 声明词**（本机绝对路径是采集时的机器事实，不进证据正文）。
  lines.push(`| 路径 | \`${rel(result.file)}\`（临时输入：不入库，由 \`node scripts/make-sample.mjs\` 再生） |`);
  lines.push(`| 体积 | ${String(result.sizeBytes)} 字节 |`);
  lines.push(`| sha256 | \`${String(result.sha256)}\` |`);
  lines.push('| 形状 | 表 `任务`，表头 `WBS / 任务名称 / 前置任务`（**仅三列**），6 行 |');
  lines.push('| 环 | 第 6 行的 `前置任务=5` 闭合 `t5→t6`，被 `wouldCreateCycle` 判为成环 ⇒ 丢弃 |');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push('| 量 | 值 | 判据 | 判定 |');
  lines.push('|---|---|---|---|');
  lines.push(`| 任务数 | ${String(result.tasks ?? '—')} | = 6 | ${result.tasks === 6 ? '✅' : '❌'} |`);
  lines.push(`| 依赖数 | ${String(result.links ?? '—')} | = 5（第 6 条被丢弃） | ${result.links === 5 ? '✅' : '❌'} |`);
  lines.push(
    `| \`XLSX_CYCLE_EDGE_DROPPED\` 条数 | ${String(result.cycleDropped)} | = 1（带成环路径） | ${result.cycleDropped === 1 ? '✅' : '❌'} |`,
  );
  lines.push(
    `| 不可排程占位 | ${result.unschedulable ? '有' : '无'} | 无（丢弃后应为无环） | ${result.unschedulable ? '❌' : '✅'} |`,
  );
  lines.push(`| 渲染行 / 边 | ${String(result.chartRows)} / ${String(result.chartEdges)} | 记录 | — |`);
  lines.push('');
  lines.push(`> 页脚原文：\`${String(result.footer)}\``);
  lines.push('');
  lines.push('## 诊断清单（应用层读回的全部条目）');
  lines.push('');
  if ((result.diagnostics ?? []).length === 0) {
    lines.push('（空）');
  } else {
    lines.push('| # | severity | code | message | 定位 |');
    lines.push('|---|---|---|---|---|');
    result.diagnostics.forEach((item, index) => {
      lines.push(
        `| ${String(index + 1)} | ${String(item.severity)} | \`${String(item.code)}\` | ${String(item.message)} | ${String(item.taskId ?? '—')} |`,
      );
    });
  }
  if ((result.errors ?? []).length > 0) {
    lines.push('');
    lines.push('**判定失败**：');
    for (const error of result.errors) lines.push(`- ${String(error)}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- G5 批次 D：两栏行对齐（记录制，ADR 0007 §14 / 裁决 P-23）

/**
 * 探测位置（**比例**，P-40 批次②）：两个方向都必须含 **0 与 1**。
 *
 * P-22 遗留 1 的两条硬要求仍然成立：① 双重偏移在 `scrollTop = 0` 处恒为 0（机制不可见）
 * ⇒ 至少两个位置才判得出机制；② 最末位置要能摸到 `maxScroll`（"最下方/最右侧新区域空白"）。
 * **为什么从绝对像素改成比例**：绝对像素 + 一个"超大值"在**内容整幅不滚动**的档位下会被浏览器
 * 夹回 0（周/月档的小文档：`contentWidth ≤ 窗格宽`）⇒ `(0, max)` 与 `(0, 0)` 完全等价、
 * 横向**静默没测**，而输出长得像"6 位置全绿"。比例在**钩子内**按真实可滚动行程解析，
 * 覆盖度由 `diagnoseScrollCoverage` 显式判出（`no-horizontal-travel` / `no-vertical-travel`）。
 */
const ALIGN_FRACTIONS = [
  { top: 0, left: 0 },
  { top: 0.5, left: 0 },
  { top: 1, left: 0 },
  { top: 0, left: 0.5 },
  { top: 0, left: 1 },
  { top: 1, left: 1 },
];

/** resize 迁移用"行程中点"：两个方向都非 0，才能同时观察横向与纵向在尺寸变化后的同步。 */
const ALIGN_MIGRATION_FRACTION = [{ top: 0.5, left: 0.5 }];

/** 数字格式化（证据表用；`null`/`undefined` 显示 `—`）。 */
function num(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * 对齐探测：**左表必须在场**（不带 `?table=0`），因此这里不改 `measureOne` 的 URL 口径。
 *
 * `navigate: false` 复用**当前页面**（P-40 批次② 的 resize 迁移必须如此：迁移判的是
 * "同一个会话经历尺寸变化后的自洽性"，重新导航会把会话换掉、也就把判据换掉了）。
 *
 * 与 `--drag` / `--import` 的分层相同：**判读逻辑**在 `packages/render-core/src/align.ts`
 * （`align.spec.ts` 进 `pnpm gate`），本函数只负责驱动页面、取回数字。
 */
async function alignProbe(cdp, origin, args, { navigate = true } = {}) {
  if (navigate) await openMeasuredPage(cdp, `${origin}/?measure=1`, { hook: '__GANTTPILOT_MEASURE_ALIGN__', label: '对齐测量钩子' });
  return cdp.evaluate(`window.__GANTTPILOT_MEASURE_ALIGN__(${JSON.stringify(args)})`);
}

/** 对齐证据（记录制 Markdown；**档位 × 覆盖度 + resize 迁移**，P-40 批次②）。 */
function renderAlignEvidence({ env, runs, migration, options }) {
  const lines = [];
  lines.push('# 两栏行对齐 + resize 迁移（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/measure-render.mjs --align[=<label>]` 采集；**这是测量快照，不是门禁**');
  lines.push('> （[ADR 0007 §14](../../../docs/02-adr/0007-渲染几何与裁剪契约.md)、[裁决 P-23](../../../docs/00-baseline/裁决记录.md)、');
  lines.push('> **批次②的档位/覆盖度/迁移**见 [裁决 R40](../../../docs/00-baseline/裁决R40.md)）。');
  lines.push('> **判读逻辑**在 `packages/render-core/src/align.ts`，它的判别力由 `align.spec.ts`');
  lines.push('> （正例"未变造时零检出" + 每条机制一条负向对照 + 覆盖度/迁移的负向对照）**在 `pnpm gate` 里**守住；');
  lines.push('> 本文件守的是**应用层那一遍**：真实 DOM 的两栏行矩形、SVG 盒与滚动几何。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 页面 = `apps/web/dist` 的**打包产物**；**左表在场**（不带 `?table=0`，否则判据没有对手可比）；');
  lines.push(
    `- **位置 = 可滚动行程的比例** ${ALIGN_FRACTIONS.map((item) => `(${String(item.top)},${String(item.left)})`).join(' ')}，` +
      '在**钩子内**按真实 `maxScroll` 解析成像素（绝对像素在"整幅不滚动"的档位下会被夹回 0）；',
  );
  lines.push(
    '- **读数 = 稳定即止**：设滚动 → `nextTick` → 每帧读一次**指纹**（DOM 真值 + `ViewModel.scroll` +' +
      ' 前 3 行行中心 + spacer 尺寸），**连续两帧一致**即止；预算不够就**判红**（不是"等两帧"这种无人守的常量）；',
  );
  lines.push('- **档位**：`day` / `week` / `month` 各一轮（`--align-zooms=` 可裁）；**档位在同一次导航内切换**（它不是计时测量）；');
  lines.push('- **覆盖度**（P-40）：整次测量必须真的**有横向与纵向行程**，否则报 `no-horizontal-travel` / `no-vertical-travel` 并判失败——"没测到"不能记成 ✅；');
  lines.push(
    `- **迁移**（P-40）：${migration === null ? '本轮**未做**（`--align-resize=off`）' : '基视口设滚动到行程中点（**不复位**）→ resize 到目标视口 → **不重设滚动**再读一次'}；` +
      '两条前提自证 = 窗格尺寸**真的变了**（`resize-not-observed`）+ 滚动位置**活下来了**（读到 0 ⇒ 该轮不构成判据）；',
  );
  lines.push('- **只读**：不改文档、不派发指针事件、不进手势；每轮结束把滚动复位 0；');
  lines.push('- 行差 = `图表行中心 − 左表行中心`（**对齐时 = 0**；图表比左表高时为负）；');
  lines.push('- 条形 x 判据 = DOM 条形左边 − (`paneLeft + xLeft − scrollLeft`)：守"所见 = 所点"的横向一半；');
  lines.push(`- 容差 = \`THRESHOLDS.rowAlignTolerancePx\` = **${String(ALIGN_TOLERANCE_PX)} px**；`);
  lines.push('- 轴覆盖优先用**色带矩形**（无描边误差），无色带时退到网格线（含 ±0.5 px 描边）；');
  lines.push('');
  lines.push('## 汇总：档位 × 覆盖度');
  lines.push('');
  lines.push(
    '| 档位（实际） | 位置数 | 失败 | 最大行差 | 最大条形 x 偏差 | setttle 帧（max） | 横向行程 | 纵向行程 | 请求非 0 被夹回 0 | 机制 | 判定 |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const summary = run.result?.summary ?? {};
    const coverage = run.result?.coverage ?? null;
    const settleFrames = (run.result?.probes ?? []).map((item) => Number(item.settleFrames ?? 0));
    const mechanisms = mechanismList(run.result);
    lines.push(
      `| \`${String(run.zoom)}\`（\`${String(run.result?.zoom ?? '?')}\`） | ${String(summary.probes ?? 0)} | ` +
        `${String(summary.failingProbes ?? 0)} | ${num(summary.maxAbsRowDeltaPx, 3)} px | ${num(summary.maxAbsBarXDeltaPx, 3)} px | ` +
        `${settleFrames.length === 0 ? '—' : String(Math.max(...settleFrames))} | ` +
        `${coverage === null ? '—' : coverage.horizontalCovered ? `✅ ${num(coverage.maxScrollLeft, 0)} px` : '❌ 无'} | ` +
        `${coverage === null ? '—' : coverage.verticalCovered ? `✅ ${num(coverage.maxScrollTop, 0)} px` : '❌ 无'} | ` +
        `${coverage === null ? '—' : String(coverage.clampedPositions)} | ` +
        `${mechanisms.length === 0 ? '(无)' : mechanisms.join(' / ')} | ` +
        `${run.result?.status === 'ok' ? '**通过**' : '**不通过**'} |`,
    );
  }
  lines.push('');
  lines.push('## 汇总：resize 迁移');
  lines.push('');
  if (migration === null) {
    lines.push('- 本轮未做迁移（`--align-resize=off`）。');
  } else {
    const before = migration.before?.probes?.[0]?.probe ?? null;
    const after = migration.after?.probes?.[0]?.probe ?? null;
    const afterVerdict = migration.after?.probes?.[0]?.verdict ?? {};
    const afterMechanisms = mechanismList(migration.after);
    const migrationVerdict = migration.after?.migration ?? null;
    lines.push('| 项 | 值 | 判据 | 判定 |');
    lines.push('|---|---|---|---|');
    lines.push(
      `| 迁移前窗格 w×h | ${before === null ? '—' : `${num(before.paneWidth, 0)}×${num(before.paneHeight, 0)}`} | 记录（基视口） | — |`,
    );
    lines.push(
      `| 迁移前滚动位置（**不复位**，留给迁移后观察） | ${before === null ? '—' : `${num(before.scrollTop, 0)}·${num(before.scrollLeft, 0)}`} | 非 0（否则机制不可见） | ${
        before !== null && (before.scrollTop > 0 || before.scrollLeft > 0) ? '✅' : '❌'
      } |`,
    );
    lines.push(
      `| 迁移后窗格 w×h | ${after === null ? '—' : `${num(after.paneWidth, 0)}×${num(after.paneHeight, 0)}`} | 记录（目标视口） | — |`,
    );
    lines.push(
      `| Δ（宽 × 高） | ${migrationVerdict === null ? '—' : `${num(migrationVerdict.deltaWidth, 0)} × ${num(migrationVerdict.deltaHeight, 0)}`} | **≠ 0**（前提自证） | ${migrationVerdict?.observed === true ? '✅' : '❌'} |`,
    );
    const afterCoverage = migration.after?.coverage ?? null;
    lines.push(
      `| 迁移后滚动位置（期望 vs 实际） | ${before === null || after === null ? '—' : `${num(before.scrollTop, 0)}·${num(before.scrollLeft, 0)} vs ${num(after.scrollTop, 0)}·${num(after.scrollLeft, 0)}`} | **位置活下来**（实际为 0 ⇒ 该轮不构成判据） | ${
        afterCoverage === null ? '—' : afterCoverage.ok ? '✅' : '❌'
      } |`,
    );
    lines.push(
      `| 迁移后最大行差 / 条形 x 偏差 | ${num(afterVerdict.maxAbsRowDeltaPx, 3)} / ${num(afterVerdict.maxAbsBarXDeltaPx, 3)} px | ≤ ${String(ALIGN_TOLERANCE_PX)} | ${
        Number(afterVerdict.maxAbsRowDeltaPx ?? 1) <= ALIGN_TOLERANCE_PX && Number(afterVerdict.maxAbsBarXDeltaPx ?? 1) <= ALIGN_TOLERANCE_PX ? '✅' : '❌'
      } |`,
    );
    lines.push(
      `| 迁移后 \`ViewModel\` 高 vs 绘制区高 | ${after === null ? '—' : `${num(after.viewHeight, 0)} vs ${num(after.paneHeight, 0)}`} | 相等（否则"过期重算"） | ${afterVerdict.heightAligned === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| 迁移后滚动同步（DOM vs \`ViewModel\`） | ${after === null ? '—' : `${num(after.scrollTop, 0)}·${num(after.scrollLeft, 0)} vs ${num(after.viewScrollTop, 0)}·${num(after.viewScrollLeft, 0)}`} | 两个方向都相等 | ${afterVerdict.scrollInSync === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| 迁移后机制 | ${afterMechanisms.length === 0 ? '(无)' : afterMechanisms.join(' / ')} | 空 | ${afterMechanisms.length === 0 ? '✅' : '❌'} |`,
    );
    lines.push(`| 迁移总体 | ${migration.after?.status === 'ok' ? '**通过**' : '**不通过**'} | — | — |`);
  }
  lines.push('');
  lines.push('## 逐位置明细');
  for (const run of runs) {
    lines.push('');
    lines.push(`### 档位 \`${String(run.zoom)}\`（实际 \`${String(run.result?.zoom ?? '?')}\`）`);
    for (const item of run.result?.probes ?? []) {
      pushProbeDetail(lines, item, mechanismList(run.result));
    }
  }
  if (migration !== null) {
    lines.push('');
    lines.push(`### resize 迁移（不重设滚动；目标视口见环境表）`);
    for (const item of migration.after?.probes ?? []) {
      pushProbeDetail(lines, item, mechanismList(migration.after));
    }
  }
  pushFailures(lines, runs, migration);
  lines.push('');
  lines.push(`> 生成参数：${JSON.stringify(options)}`);
  lines.push('');
  return lines.join('\n');
}

/** 逐位置明细表（档位轮与迁移轮共用；`mechanisms` = 该轮汇总的机制集合）。 */
function pushProbeDetail(lines, item, mechanisms) {
    const probe = item.probe ?? {};
    const verdict = item.verdict ?? {};
    lines.push('');
    lines.push(
      `### 请求 top/left = ${String(item.requestedScrollTop)}/${String(item.requestedScrollLeft)}` +
        `（实际 ${String(probe.scrollTop)}/${String(probe.scrollLeft)}）`,
    );
    lines.push('');
    lines.push('| 量 | 值 | 判据 | 判定 |');
    lines.push('|---|---|---|---|');
    lines.push(`| 绘制区 w×h | ${String(probe.paneWidth)}×${String(probe.paneHeight)} | 记录 | — |`);
    lines.push(`| 内容高（spacer） | ${num(probe.spacerHeight, 1)} | 记录（最末行可达性） | — |`);
    lines.push(
      `| 内容宽（spacer / \`ViewModel\`） | ${num(probe.spacerWidth, 1)} / ${num(probe.viewContentWidth, 1)} | 滚动范围要够到项目末端（R11） | ${verdict.contentRangeAligned === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| 两栏表头高（图表 / 左表） | ${num(probe.headerHeightChart)} / ${num(probe.headerHeightTable)} | 相等 | ${verdict.headerAligned === true ? '✅' : '❌'} |`,
    );
    lines.push(`| 左表表体高 | ${num(probe.tableBodyHeight)} | = 绘制区高 | ${verdict.heightAligned === true ? '✅' : '❌'} |`);
    lines.push(
      `| 左表行外高（DOM） | ${num(probe.tableRowHeight)} | = 模型行高 ${String(probe.rowHeight)}（否则逐行累积漂移，R9） | ${verdict.rowHeightAligned === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| SVG 盒（left / top / w×h） | ${num(probe.svgLeft)} / ${num(probe.svgTop)} / ${num(probe.svgWidth)}×${num(probe.svgHeight)} | 钉在**列**左上（= 绘制区顶 − 表头带） | ${verdict.pinned === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| SVG 盒 = viewBox（期望 ${num(probe.viewWidth)}×${num(probe.viewHeight + probe.headerHeightChart)}） | ${num(probe.svgWidth)}×${num(probe.svgHeight)} | 1:1（盒高 = 绘制区 + 表头带） | ${verdict.svgBoxAligned === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| \`ViewModel\` w×h / scroll | ${String(probe.viewWidth)}×${String(probe.viewHeight)} / ${num(probe.viewScrollTop)}·${num(probe.viewScrollLeft)} | 两个方向都 = DOM | ${verdict.scrollInSync === true ? '✅' : '❌'} |`,
    );
    const axis = probe.axisCoverage;
    lines.push(
      `| 轴覆盖（色带上下 / 刻度左右） | ${
        axis === null || axis === undefined ? '—' : `${num(axis.top)}..${num(axis.bottom)}`
      } / ${
        probe.axisTicks === null || probe.axisTicks === undefined
          ? '—'
          : `${num(probe.axisTicks.left)}..${num(probe.axisTicks.right)}`
      } | 纵向铺满绘制区 + 横向铺满视口（P-24 加了横向） | ${mechanisms.includes('axis-not-covering') ? '❌' : '✅'} |`,
    );
    lines.push(
      `| 刻度文本（上..下） | ${
        probe.axisLabels === null || probe.axisLabels === undefined
          ? '—'
          : `${num(probe.axisLabels.top)}..${num(probe.axisLabels.bottom)}`
      } | 落在**表头带**内（不压第一行；P-24 第 ③ 条） | ${verdict.labelsInHeader === true ? '✅' : '❌'} |`,
    );
    lines.push(
      `| 空白带（顶 / 底） | ${verdict.coverage === null || verdict.coverage === undefined ? '（文档比绘制区短，不断言）' : `${num(verdict.coverage.topBandPx)} / ${num(verdict.coverage.bottomBandPx)}`} | = 0 | ${verdict.coverage === null || verdict.coverage === undefined || (verdict.coverage.topBandPx <= ALIGN_TOLERANCE_PX && verdict.coverage.bottomBandPx <= ALIGN_TOLERANCE_PX) ? '✅' : '❌'} |`,
    );
    lines.push(
      `| 最大行差 / 条形 x 偏差 | ${num(verdict.maxAbsRowDeltaPx, 3)} / ${num(verdict.maxAbsBarXDeltaPx, 3)} px | ≤ ${String(ALIGN_TOLERANCE_PX)} | ${Number(verdict.maxAbsRowDeltaPx ?? 1) <= ALIGN_TOLERANCE_PX && Number(verdict.maxAbsBarXDeltaPx ?? 1) <= ALIGN_TOLERANCE_PX ? '✅' : '❌'} |`,
    );
    const hit = probe.hitTest;
    lines.push(
      `| 所见 = 所点（内容 y） | ${hit === null || hit === undefined ? '—' : `${num(hit.expectedContentY)} vs ${num(hit.actualContentY)}`} | ≤ ${String(ALIGN_TOLERANCE_PX)} | ${mechanisms.includes('hit-test-mismatch') ? '❌' : '✅'} |`,
    );
    const probeMechanisms = Array.isArray(verdict.mechanisms) ? verdict.mechanisms : [];
    lines.push(`| 机制 | ${probeMechanisms.length === 0 ? '(无)' : probeMechanisms.join(' / ')} | 空 | ${probeMechanisms.length === 0 ? '✅' : '❌'} |`);
    lines.push('');
    lines.push('| 行 | 任务 | 图表行中心 | 左表行中心 | 行差 | 条形左边（DOM / 期望） |');
    lines.push('|---|---|---|---|---|---|');
    const deltas = verdict.rowDeltas ?? [];
    const shown = deltas.length <= 14 ? deltas : [...deltas.slice(0, 10), ...deltas.slice(-4)];
    for (const delta of shown) {
      const sample = (probe.samples ?? []).find((item2) => item2.id === delta.id) ?? {};
      lines.push(
        `| ${String(delta.row)} | \`${String(delta.id)}\` | ${num(sample.chartCenterY)} | ${num(sample.tableCenterY)} | ${num(delta.deltaPx, 3)} | ` +
          `${num(sample.barLeft)} / ${num(sample.expectedBarLeft)} |`,
      );
    }
    if (shown.length !== deltas.length) {
      lines.push(`| … | （共 ${String(deltas.length)} 行；证据表只列首 10 + 末 4 行，逐行值见 raw JSON） | | | |`);
    }
}

/** 机制列表（容错：钩子未回或字段缺失时给空数组，不抛）。 */
function mechanismList(result) {
  return Array.isArray(result?.summary?.mechanisms) ? result.summary.mechanisms : [];
}

/** 汇总"采数失败 / 判定失败"（档位轮 + 迁移轮；**不静默吞掉任何一条**）。 */
function pushFailures(lines, runs, migration) {
  const entries = [
    ...runs.flatMap((run) => (run.result?.errors ?? []).map((error) => `[${String(run.zoom)}] ${String(error)}`)),
    ...(migration?.before?.errors ?? []).map((error) => `[迁移·迁移前] ${String(error)}`),
    ...(migration?.after?.errors ?? []).map((error) => `[迁移·迁移后] ${String(error)}`),
  ];
  if (entries.length === 0) return;
  lines.push('');
  lines.push('**判定失败 / 采数失败**：');
  for (const entry of entries) lines.push(`- ${entry}`);
}

// ---------------------------------------------------------------- G6：持久化（记录制，ADR 0009 §5）

/**
 * G6 的**打包产物测量**（记录制，**不进 `pnpm gate`**）。
 *
 * 两个模式：
 * - `--persist-drag`：**开/关自动保存两组同尺**的拖拽帧预算（出口条件①）。两组必须分别导航
 *   （`?persist=0` 是应用层的测量旁路，决定"这个标签页接不接自动保存"）；
 * - `--storage-metrics`：**2,000 任务**的存储占用与写入耗时（出口条件④）。
 *
 * 判据本体（去抖 / 最大间隔 / 手势期不落盘 / 检查点阈值 / 保留份数 / 记录形状）在
 * `packages/engine/src/persistence.spec.ts`（假时钟，**进 `pnpm gate`**）；这里只测打包产物。
 */
const PERSIST_DATASET = 'dense';
const STORAGE_DATASET = 'dense-2000';

/** 导航到应用并等持久化钩子就绪（应用级错误抓手与其它模式同口径）。 */
async function persistNavigate(cdp, url) {
  // 注意：URL 必须带 `dataset`——夹具是在**页面里**按 `?dataset=` 建的，钩子参数不能替代它。
  await openMeasuredPage(cdp, url, { hook: '__GANTTPILOT_MEASURE_PERSIST__', timeoutMs: 30_000, label: '持久化测量钩子' });
}

/** 读回页面上的当前 `revision` 镜像（`null` = 还没暴露）。 */
async function persistRevision(cdp) {
  const value = await cdp.evaluate(
    'typeof window.__GANTTPILOT_REVISION__ === "number" ? window.__GANTTPILOT_REVISION__ : null',
  );
  return typeof value === 'number' ? value : null;
}

/**
 * 调一次 `__GANTTPILOT_MEASURE_PERSIST__`（参数是字面量，不含外部输入）。
 *
 * **先清库再导航**：否则上一轮的检查点会被启动恢复接进来，量到的"最近一次写入记录"里
 * 带着旧文档的基线（跨轮污染）。
 */
/** 在**页面已经打开的连接**上清空两个 store（比 `deleteDatabase` 安全：不会被 blocked）。 */
async function persistClear(cdp) {
  return cdp.evaluate(
    'new Promise((resolve) => {' +
      'const request = indexedDB.open("GanttPilotPersistence");' +
      'request.onsuccess = () => {' +
      '  const db = request.result;' +
      '  const names = [...db.objectStoreNames];' +
      '  if (names.length === 0) { db.close(); resolve(true); return; }' +
      '  const tx = db.transaction(names, "readwrite");' +
      '  for (const name of names) { const store = tx.objectStore(name); const cursor = store.openCursor();' +
      '    cursor.onsuccess = () => { const c = cursor.result; if (c) { c.delete(); c.continue(); } };' +
      '  }' +
      '  tx.oncomplete = () => { db.close(); resolve(true); };' +
      '  tx.onerror = () => { db.close(); resolve(true); };' +
    '  };' +
    '  request.onerror = () => resolve(true);' +
    '})',
  );
}

/**
 * 调一次 `__GANTTPILOT_MEASURE_PERSIST__`（参数是字面量，不含外部输入）。
 *
 * `fresh = true` 时**先清库**：否则上一轮的检查点会被启动恢复接进来，量到的"最近一次写入记录"里
 * 带着旧文档的基线（跨轮污染）。清理用**页面自己的连接**（`persistClear`）——
 * `deleteDatabase` 会被页面持有的连接 blocked，随后新页面的 open 也跟着卡住（实测于 Chrome 154）。
 */
async function persistProbe(cdp, args, url) {
  await persistNavigate(cdp, url);
  return cdp.evaluate(`window.__GANTTPILOT_MEASURE_PERSIST__(${JSON.stringify(args)})`);
}

/** 一轮"开/关持久化"的拖拽测量（关的那一轮走 `?persist=0`）。 */
async function persistDragRound(cdp, origin, { enabled, dayDelta, frames }) {
  const url = `${origin}/?measure=1&table=1&persist=${enabled ? '1' : '0'}&dataset=${PERSIST_DATASET}`;
  // **整轮只清一次库**（干净起点）：清库会作废页面上已有的基线，
  // 因此绝不能在"编辑之后"再清（否则"编辑 → 写盘 → 重开"这条对照会被抹掉）。
  await persistNavigate(cdp, url);
  await persistClear(cdp);
  const result = await persistProbe(cdp, { dataset: PERSIST_DATASET, dayDelta, frames }, url);
  if (!enabled) return { label: '关', enabled, url, result };

  /**
   * 出口条件③的**记录制形态：重启恢复**。
   *
   * 干净重载再读回版本——它证明"写下去的东西能被重开读到"（L3 的耐久性）。
   * 与"强制杀进程 / 关页"同属"重开"路径，但**不伪造"未收到收口事件"这一半**：
   * 因果是"杀进程不触 `beforeunload` ⇒ 活下来的只是最后一次已完成的写入"，
   * 因此**强制杀进程**按 ADR 0009 §8 的口径归**人工复验**（证据文件里写明）。
   */
  // 写一次并等它完成（skipDrag 模式只做 rebase + 落一次），再导航。
  await persistProbe(cdp, { dataset: PERSIST_DATASET, skipDrag: true, samples: 0 }, url);
  // **编辑一次 → 强制收口写盘 → 重开 → 比对**。
  //
  // 三条纪律（都是实测踩出来的）：
  //  ① 不要在编辑之后清库（会抹掉刚写下去的东西）；
  //  ② 不要在编辑与写盘之间**导航**（导航就是重开，会把编辑丢掉）；
  //  ③ 比对前必须确认 `writtenRev > 0`（否则退化成 0 == 0，那不是判据）。
  await cdp.evaluate('window.__GANTTPILOT_MEASURE_PERSIST_FLUSH__()');
  const writtenRev = await persistRevision(cdp);
  await persistNavigate(cdp, url);
  const restoredRev = await persistRevision(cdp);
  if (!(Number(writtenRev) > 0)) {
    console.error('[persist-drag] 重启恢复对照无效：写盘前 revision = ' + String(writtenRev) + '（期望 > 0）');
  }
  return {
    label: '开',
    enabled,
    url,
    result: { ...result, crash: { writtenRev, restoredRev } },
  };
}

/** G6 拖拽帧预算证据：开/关两组同尺对照。 */
function renderPersistDragEvidence({ env, runs }) {
  const lines = [];
  lines.push('# G6 自动保存与拖拽帧预算（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/measure-render.mjs --persist-drag` 采集（**打包产物**口径）；**这是测量快照，不是门禁**');
  lines.push('> （[ADR 0009 §3](../../../docs/02-adr/0009-持久化契约.md)、[G6 出口条件①](../../../docs/01-roadmap/首版能力顺序.md)）。');
  lines.push('> 判据本体（去抖 / 最大间隔 / 手势期不落盘 / 检查点阈值 / 保留份数 / 记录形状）在');
  lines.push('> `packages/engine/src/persistence.spec.ts`（假时钟，**进 `pnpm gate`**）；这里只测"打包产物上的帧预算"。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 驱动方式 = **真实指针事件**（`mousedown → mousemove×N → mouseup`）走 `useGesture` 的同一条入口；');
  lines.push('- **开关两组**分别导航：`?persist=0` 关掉自动保存（应用层测量旁路，默认开启）；');
  lines.push('- 拖动**之前**先 `flush` 一次（把之前积压的变更清干净）⇒ "拖动期写入次数"只反映拖动期；');
  lines.push(`- 拖动跨度 = **${String(env.拖动天数)} 个工作日**，拆成 **${String(env.测试帧数)}** 个测试帧；`);
  lines.push('- **帧间隔** = 连续 rAF 的间隔（记录用；**不能用双 rAF 测帧时长**）；');
  lines.push('- **主线程工作量** = 派发事件 + `await nextTick()`（不含帧等待）——与 G4 的滚动口径同源；');
  lines.push('- **松手 → 落盘** = 松手后调一次 `flush()` 的墙钟（≤5s 那条出口条件的时效数字）；');
  lines.push('');
  lines.push('## 两组同尺对照');
  lines.push('');
  lines.push('| 持久化 | 帧间隔 p50 | 帧间隔 p95 | 主线程 p50 | 主线程 p95 | longtask | 拖动期写入 | 松手→落盘 | 判定 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const item = run.result ?? {};
    const gapP95 = Number(item.frameGapP95Ms ?? 0);
    const fpsOk = gapP95 > 0 && gapP95 <= 1000 / 30;
    const noWrite = Number(item.writesDuringGesture ?? -1) === 0;
    const flushText =
      item.flushAfterReleaseMs === null || item.flushAfterReleaseMs === undefined
        ? '—'
        : `${Number(item.flushAfterReleaseMs).toFixed(1)} ms`;
    lines.push(
      `| ${run.label} | ${Number(item.frameGapP50Ms ?? 0).toFixed(1)} ms | ${gapP95.toFixed(1)} ms | ` +
        `${Number(item.mainThreadP50Ms ?? 0).toFixed(2)} ms | ${Number(item.mainThreadP95Ms ?? 0).toFixed(2)} ms | ` +
        `${String(item.longTasks ?? 0)} | ${String(item.writesDuringGesture ?? '-')} | ${flushText} | ` +
        `${fpsOk && noWrite ? '通过' : '不通过'} |`,
    );
  }
  lines.push('');
  lines.push('## 出口条件③：杀进程后重开（人工复验项）');
  lines.push('');
  lines.push('| 组 | 写盘前的 revision | 重开后的 revision | 备注 |');
  lines.push('|---|---|---|---|');
  for (const run of runs) {
    const restart = run.result?.crash ?? null;
    if (restart === null) continue;
    lines.push(
      `| ${run.label} | ${String(restart.writtenRev ?? '—')} | ${String(restart.restoredRev ?? '—')} | 供参考，**不作判定** |`,
    );
  }
  lines.push('');
  lines.push('> **这一栏不作判定**：`--persist-drag` 的场景是「页面被换成测量夹具」，而重开时页面会');
  lines.push('> `project.reset` 成演示文档（测量钩子只加载夹具、不加载「用户文档」）⇒ 重开后的 revision');
  lines.push('> 必然回到 0 —— 这条对照在该场景里**没有判别力**（实测确认，如实登记以免被读成「已通过」）。');
  lines.push('>');
  lines.push('> **出口条件③的判据在引擎侧**：恢复优先级与「坏候选只跳过」、以及「写者被杀后仍能恢复到');
  lines.push('> 最后一次成功写入（`rev` ≥ 最近检查点）」的 killsim —— 都在 `persistence.spec.ts`，**进 `pnpm gate`**。');
  lines.push('> **真机形态（强制杀进程 / 关页后重开）按 ADR 0009 §8 归人工复验**：浏览器杀进程不触');
  lines.push('> `beforeunload`，活下来的只是「最后一次已完成的写入」，口径是「恢复到**不早于**最近检查点」，');
  lines.push('> 而不是「崩溃前最后一步」。');
  lines.push('## 判定口径');
  lines.push('');
  lines.push('- **拖拽期间不产生可见掉帧**：帧间隔 p95 ≤ 33.3 ms（≥30 fps），**两组都要成立**；');
  lines.push('- **回退栈相对全量快照的收益**：拖动期自动保存写入次数 = **0**（写盘不落在拖动帧里）；');
  lines.push('- **自动保存 ≤5s**：松手 → 落盘完成的墙钟必须远小于 5,000 ms；');
  lines.push('- 开了持久化的那一组**不得比关掉的那组更差**（帧间隔 p95 差 ≤ 1 帧）；');
  lines.push('');
  for (const run of runs) {
    const errors = run.result?.errors ?? [];
    if (errors.length > 0) lines.push(`- **${run.label}组 errors**：${errors.join('；')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** G6 存储占用与写入耗时证据（2,000 任务）：出口条件④。 */
function renderStorageMetricsEvidence({ env, run }) {
  const lines = [];
  const storage = run?.result?.storage ?? null;
  lines.push('# G6 存储占用与写入耗时（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/measure-render.mjs --storage-metrics` 采集（**打包产物**口径，**2,000 任务**）；');
  lines.push('> **这是测量快照，不是门禁**（[ADR 0009](../../../docs/02-adr/0009-持久化契约.md)、[G6 出口条件④](../../../docs/01-roadmap/首版能力顺序.md)）。');
  lines.push('');
  lines.push('## 环境（与数字一起登记）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 数字');
  lines.push('');
  lines.push('| 项 | 值 | 说明 |');
  lines.push('|---|---|---|');
  if (storage === null) {
    lines.push('| — | — | 未采到（见下方 errors） |');
  } else {
    lines.push(`| 任务数 | ${String(storage.tasks)} | 夹具规模（依赖密度与主口径同比） |`);
    lines.push(`| 依赖数 | ${String(storage.links)} | 同上 |`);
    lines.push(
      `| 整份文档规范文本 | ${(Number(storage.documentBytes) / 1024).toFixed(1)} KB | **一份检查点的体积下界**；序列化 ${Number(storage.serializeMs).toFixed(1)} ms |`,
    );
    lines.push(
      `| 单条最新状态记录 | ${(Number(storage.recordBytes) / 1024).toFixed(2)} KB | 增量口径：**与文档规模脱钩** |`,
    );
    lines.push(
      `| 写入墙钟 p50 / p95 | ${Number(storage.putP50Ms).toFixed(1)} / ${Number(storage.putP95Ms).toFixed(1)} ms | ${String((storage.putMs ?? []).length)} 次采样 |`,
    );
    const estimate =
      storage.estimate === null || storage.estimate === undefined
        ? '—'
        : `${(Number(storage.estimate.usage) / 1024).toFixed(1)} KB / ${(Number(storage.estimate.quota) / 1024 / 1024).toFixed(0)} MB`;
    lines.push(`| 存储用量 / 配额 | ${estimate} | \`navigator.storage.estimate()\` |`);
  }
  lines.push('');
  lines.push('## 判定口径');
  lines.push('');
  lines.push('- **写入量只与变更量同阶**：单条最新状态记录应远小于整份文档（R-2 的 0.1–2 KB 对 300–600 KB）；');
  lines.push('- **写入延迟**：p95 应远小于"每 ≤5s 一次"的预算；');
  lines.push('- 本模式**不判**渲染性能（那是 `--persist-drag` 与 `--drag` 的事）。');
  lines.push('');
  const errors = run?.result?.errors ?? [];
  if (errors.length > 0) lines.push(`- **errors**：${errors.join('；')}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * `--axis-hover` 的**前提自证**（不是判据本体）。
 *
 * 判据本体在**门禁**里：`smoke-build.mjs` 的 `probeAxisAndHover` 在打包产物上直接读 DOM
 * （两级刻度的行序/上下、短刻度只落在表头带、悬停行带跟着指针走、左右表联动）。
 * 本函数只回答一件事：**这一轮快照有没有可读性**——即"两行刻度真的分成两行且大刻度在上"、
 * "未悬停时没有行带（对照存在）"、"指针换行时行带真的动了"、"两栏表头同高（坐标基准）"。
 * 少了任一条，文件里的数字就没有解释力（而它们看起来仍然"很整齐"）。
 *
 * @returns {{ problems: string[], checks: { name: string, ok: boolean, detail: string }[] }}
 */
function judgeAxisHoverSnapshot(run) {
  const result = run?.result ?? {};
  const axis = result.axis ?? {};
  const hover = result.hover ?? {};
  const idle = hover.idle ?? {};
  const onRow = hover.onRow ?? {};
  const onThird = hover.onThirdRow ?? {};
  const checks = [
    {
      name: '钩子自证（三次悬停 + 可能的切档位都在稳定读预算内）',
      ok: (result.errors ?? []).length === 0,
      detail: (result.errors ?? []).length === 0 ? 'errors 空' : (result.errors ?? []).join('；'),
    },
    {
      name: '两级刻度真的分成两行、且**大刻度在上**',
      ok:
        typeof axis.majorY === 'number' &&
        typeof axis.minorY === 'number' &&
        Number(axis.minorY) > Number(axis.majorY),
      detail: `majorY=${String(axis.majorY)} minorY=${String(axis.minorY)}（上级样本 ${(axis.majorSamples ?? []).slice(0, 2).join('/')}；下级 ${(axis.minorSamples ?? []).slice(0, 2).join('/')}）`,
    },
    {
      name: '两栏表头同高（悬停读数的坐标基准）',
      ok: Number(axis.headerTable) === Number(axis.headerChart) && Number(axis.headerTable) > 0,
      detail: `左表 ${String(axis.headerTable)} / 图表 ${String(axis.headerChart)}`,
    },
    {
      name: '未悬停时**没有**行带（否则"跟着指针走"没有对照）',
      ok: Number(idle.svgHoverRows) === 0,
      detail: `svgHoverRows=${String(idle.svgHoverRows)}`,
    },
    {
      name: '指针换行时行带**真的动了**（第 1 行 vs 第 3 行）',
      ok:
        onRow.svgRect !== null &&
        onThird.svgRect !== null &&
        Math.abs(Number(onRow.svgRect?.top) - Number(onThird.svgRect?.top)) > 1,
      detail: `top=${String(onRow.svgRect?.top)} vs ${String(onThird.svgRect?.top)}；左表底色 ${String(idle.tableBackground)} → ${String(onRow.tableBackground)}`,
    },
  ];
  return { problems: checks.filter((check) => !check.ok).map((check) => check.name), checks };
}

/** 两级刻度与悬停行带的记录制证据（`--axis-hover`）。 */
function renderAxisHoverEvidence({ env, runs }) {
  const lines = [];
  lines.push('# 两级刻度与悬停行带（记录制，不进 `pnpm gate`）');
  lines.push('');
  lines.push('> 由 `node scripts/measure-render.mjs --axis-hover` 采集；**这是测量快照，不是门禁**');
  lines.push('> （[ADR 0007 §三](../../../docs/02-adr/0007-渲染几何与裁剪契约.md)、[裁决 P-46](../../../docs/00-baseline/裁决R45.md)）。');
  lines.push('> **判据本体在门禁里**：`scripts/smoke-build.mjs` 的 `probeAxisAndHover` 在打包产物上直接读 DOM');
  lines.push('> （两行刻度的行序与上下、短刻度只落在表头带内、悬停行带跟着指针走、左右表联动）。');
  lines.push('> 本文件提供的是**同族读数的可复现快照** + **前提自证**（见下），用来在改动前后做对照。');
  lines.push('');
  lines.push('## 环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${key} | ${String(value)} |`);
  lines.push('');
  lines.push('## 读数');
  lines.push('');
  lines.push('| 档位 | 上级行 y | 上级样本 | 下级行 y | 下级样本 | 上级分段带 | 表头（左表/图表） | 表头第二行文本 | 未悬停行带 | 第 1 行行带 | 第 3 行行带 | 左表底色（未悬停 → 第 1 行） | revision |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const axis = run.result?.axis ?? {};
    const hover = run.result?.hover ?? {};
    const box = (reading) =>
      reading?.svgRect === null || reading?.svgRect === undefined
        ? `—（${String(reading?.svgHoverRows ?? '?')} 个）`
        : `top ${String(reading.svgRect.top)}–${String(reading.svgRect.bottom)}`;
    lines.push(
      `| ${String(run.zoom)} | ${String(axis.majorY)} | ${(axis.majorSamples ?? []).slice(0, 3).join(' / ')} | ` +
        `${String(axis.minorY)} | ${(axis.minorSamples ?? []).slice(0, 3).join(' / ')} | ${String(axis.majorBands)} | ` +
        `${String(axis.headerTable)} / ${String(axis.headerChart)} | ${JSON.stringify(String(axis.tableHeaderSecondRowText ?? ''))} | ` +
        `${box(hover.idle)} | ${box(hover.onRow)} | ${box(hover.onThirdRow)} | ` +
        `${String(hover.idle?.tableBackground ?? '')} → ${String(hover.onRow?.tableBackground ?? '')} | ${String(run.result?.revision)} |`,
    );
  }
  lines.push('');
  lines.push('## 前提自证（不是判据；缺一条则上面的数字没有解释力）');
  lines.push('');
  for (const run of runs) {
    const verdict = judgeAxisHoverSnapshot(run);
    lines.push(`**${String(run.zoom)}**：${verdict.problems.length === 0 ? '✅ 全部通过' : `❌ ${verdict.problems.join('；')}`}`);
    lines.push('');
    lines.push('| 前提 | 结果 | 读数 |');
    lines.push('|---|---|---|');
    for (const check of verdict.checks) lines.push(`| ${check.name} | ${check.ok ? '✅' : '❌'} | ${check.detail} |`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(distRoot, 'index.html'))) {
    console.error('[measure] 缺少打包产物：先跑 `pnpm --filter @ganttpilot/web build`');
    process.exit(1);
  }
  mkdirSync(evidenceDir, { recursive: true });

  const { server, origin } = await startStaticServer(distRoot);
  /** 起不来时的兜底也走同一道闸；`finally` 里只收尾**还活着**的那一份（见下面的置空）。 */
  let chrome = null;
  let cdp = null;
  let serverClosed = false;
  const closeServer = () => {
    if (!serverClosed) {
      serverClosed = true;
      server.close();
    }
  };

  try {
    chrome = spawnChrome(findChrome({ allowEdge: true }), {
      profileRoot: 'measure-chrome-profile',
      extraArgs: ['--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1'],
      /**
       * **不给 `--window-size`**：有效视口由下面的 `Emulation.setDeviceMetricsOverride` 固定；
       * 原先那一行 `--window-size=1280,640` 是 G4 的残留，与证据头写的视口不一致（P3/C1 删）。
       */
      windowSize: null,
    });
    let port = 0;
    try {
      port = await waitForDevToolsPort(chrome.profileDir, { timeoutMs: 20_000 });
    } catch (error) {
      // 起不来时的兜底：2 秒预算 + 不删 profile（与抽取前的行为一致），然后把句柄置空避免二次收尾。
      await closeChromeSession({ profileDir: chrome.profileDir, pid: chrome.child.pid, timeoutMs: 2_000 });
      chrome = null;
      throw error;
    }
    cdp = await connectCdp(port);

    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    /**
     * 固定视口 1280×800（CSS 像素 / DPR 1）。
     *
     * 为什么必须显式覆盖：测量的是**打包产物**，而图表窗格的高度取决于真实窗口尺寸；
     * 不固定的话"可见行数"会随窗口变化，元素预算与首屏数字就无法复现、也无法跨机器比较。
     * 取 `BASE_VIEWPORT`（1280×800）：理由与迁移轮的起点口径见该常量的注释。
     * 窗格真实的 `clientWidth/clientHeight` 会随结果一起登记（不假定它等于 `BASE_VIEWPORT`）。
     */
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      ...BASE_VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // 页面内的报错必须能被看到（否则"钩子没装好"只会表现为一个空异常）。
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {};
      const text = details.exception?.description ?? details.text ?? JSON.stringify(details);
      console.error(`[measure] 页面异常：${String(text)}`);
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const text = (params.args ?? []).map((item) => item.description ?? item.value ?? '').join(' ');
        console.error(`[measure] 页面 console.error：${String(text)}`);
      }
    });
    const version = await cdp.call('Browser.getVersion');
    const chromeVersion = String(version.product ?? 'unknown');

    // ---------------------------------------------------------------- 记录制：xlsx 导入（P-21 遗留 3）
    if (options.importPath !== null) {
      const filePath = resolve(options.importPath);
      if (!existsSync(filePath)) {
        console.error(`[import] 找不到样本文件：${filePath}`);
        console.error('[import] 先生成：node scripts/make-sample.mjs');
        process.exitCode = 1;
        return;
      }
      const result = await importSample(cdp, origin, filePath);
      const env = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        视口: '1280×800',
        样本: 'cyclic-dependency.xlsx（三列 / 6 行 / t5→t6 成环）',
        ...hookVersionEnv(),
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
      const evidencePath = join(evidenceDir, `import-cyclic-sample-chrome${major}.md`);
      writeFileSync(evidencePath, withRawLink(renderImportEvidence({ env, result }), 'import-cyclic-sample-raw.json'), 'utf8');
      writeFileSync(
        join(evidenceDir, 'import-cyclic-sample-raw.json'),
        `${JSON.stringify({ env, result }, null, 2)}\n`,
        'utf8',
      );
      console.log(
        `[import] 任务 ${String(result.tasks ?? '-')} / 依赖 ${String(result.links ?? '-')} / ` +
          `成环丢弃 ${String(result.cycleDropped)} / 不可排程 ${result.unschedulable ? '有' : '无'}`,
      );
      if (result.status === 'error') {
        console.error(`[import] errors: ${(result.errors ?? []).join('；')}`);
        process.exitCode = 1;
      }
      console.log(`[measure] 导入证据已写入 ${evidencePath}`);
      return;
    }

    // ---------------------------------------------------------------- 两栏行对齐 + resize 迁移（记录制，P-23 / P-40 批次②）
    if (options.align) {
      const runs = [];
      for (const [index, zoom] of options.alignZooms.entries()) {
        // 第一轮导航；之后**复用同一页面**——`--align` 不是计时测量，档位可以就地切换。
        const result = await alignProbe(
          cdp,
          origin,
          { dataset: PRIMARY_DATASET, zoom, fractions: ALIGN_FRACTIONS },
          { navigate: index === 0 },
        );
        runs.push({ zoom, result });
        const summary = result?.summary ?? {};
        const coverage = result?.coverage ?? null;
        console.log(
          `[align] ${zoom}：位置 ${String(summary.probes ?? 0)}（失败 ${String(summary.failingProbes ?? 0)}）、` +
            `最大行差 ${Number(summary.maxAbsRowDeltaPx ?? 0).toFixed(3)} px、` +
            `覆盖 横/纵 ${coverage?.horizontalCovered === true ? '✅' : '❌'}/${coverage?.verticalCovered === true ? '✅' : '❌'}、` +
            `机制 ${(summary.mechanisms ?? []).join(' / ') || '(无)'}`,
        );
        if (result?.status === 'error') {
          console.error(`[align] ${zoom} errors: ${(result.errors ?? []).join('；')}`);
        }
      }

      /**
       * resize 迁移（P-40 批次② 的 ②-C）：**同一个会话**里改视口，**不重设滚动**再读一次。
       * 重新导航会把会话换掉 —— 那测的就不是"迁移"了（`navigate: false`）。
       */
      let migration = null;
      if (options.alignResize !== null) {
        await cdp.call('Emulation.setDeviceMetricsOverride', {
          ...BASE_VIEWPORT,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const before = await alignProbe(
          cdp,
          origin,
          {
            dataset: PRIMARY_DATASET,
            zoom: options.alignZooms[0],
            fractions: ALIGN_MIGRATION_FRACTION,
            // **不复位**：复位会把"resize 前的滚动位置"抹掉，迁移后只能读到 0·0（机制恰在 0 处不可见）。
            keepScroll: true,
          },
          { navigate: false },
        );
        const beforePane = before?.probes?.[0]?.probe ?? null;
        await cdp.call('Emulation.setDeviceMetricsOverride', {
          width: options.alignResize.width,
          height: options.alignResize.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const after = await alignProbe(
          cdp,
          origin,
          {
            mode: 'reread',
            dataset: PRIMARY_DATASET,
            previousPane:
              beforePane === null ? null : { width: beforePane.paneWidth, height: beforePane.paneHeight },
            expectedScroll:
              beforePane === null ? null : { top: beforePane.scrollTop, left: beforePane.scrollLeft },
          },
          { navigate: false },
        );
        const afterPane = after?.probes?.[0]?.probe ?? null;
        migration = { baseViewport: BASE_VIEWPORT, target: options.alignResize, before, after };
        console.log(
          `[align] 迁移 ${String(BASE_VIEWPORT.width)}×${String(BASE_VIEWPORT.height)} → ` +
            `${String(options.alignResize.width)}×${String(options.alignResize.height)}：` +
            `窗格 ${String(beforePane?.paneWidth ?? '?')}×${String(beforePane?.paneHeight ?? '?')} → ` +
            `${String(afterPane?.paneWidth ?? '?')}×${String(afterPane?.paneHeight ?? '?')}、` +
            `机制 ${(after?.summary?.mechanisms ?? []).join(' / ') || '(无)'}、` +
            `前提自证 ${after?.migration?.observed === true ? '✅' : '❌'}`,
        );
        if (after?.status === 'error') {
          console.error(`[align] 迁移 errors: ${(after.errors ?? []).join('；')}`);
        }
        // 复位基视口：不给同一次运行里的其它分支留一个被改过的视口。
        await cdp.call('Emulation.setDeviceMetricsOverride', { ...BASE_VIEWPORT, deviceScaleFactor: 1, mobile: false });
      }

      const budget = runs[0]?.result?.stableReadBudgetFrames ?? 0;
      const env = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        基视口: `${String(BASE_VIEWPORT.width)}×${String(BASE_VIEWPORT.height)}（Emulation.setDeviceMetricsOverride；窗格尺寸随结果登记）`,
        数据集: PRIMARY_DATASET,
        左表: '在场（不带 ?table=0）',
        档位: options.alignZooms.join(' / '),
        探测位置: `比例 ${ALIGN_FRACTIONS.map((item) => `(${String(item.top)},${String(item.left)})`).join(' / ')}（钩子内按真实行程解析）`,
        稳定读预算: `${String(budget)} 帧（连续两帧指纹一致即止；超预算判红）`,
        迁移: options.alignResize === null
          ? '未做（--align-resize=off）'
          : `${String(BASE_VIEWPORT.width)}×${String(BASE_VIEWPORT.height)} → ${String(options.alignResize.width)}×${String(options.alignResize.height)}（不重设滚动）`,
        ...hookVersionEnv(),
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
      const suffix = options.alignLabel === '' ? '' : `-${options.alignLabel}`;
      const alignPath = join(evidenceDir, `chart-align${suffix}-chrome${major}.md`);
      writeFileSync(alignPath, withRawLink(renderAlignEvidence({ env, runs, migration, options }), `chart-align${suffix}-raw.json`), 'utf8');
      writeFileSync(
        join(evidenceDir, `chart-align${suffix}-raw.json`),
        `${JSON.stringify({ env, runs, migration }, null, 2)}\n`,
        'utf8',
      );
      if (runs.some((run) => run.result?.status === 'error') || (migration !== null && migration.after?.status === 'error')) {
        process.exitCode = 1;
      }
      console.log(`[measure] 对齐证据已写入 ${alignPath}`);
      return;
    }

    // ---------------------------------------------------------------- 两级刻度与悬停行带（记录制）
    if (options.axisHover) {
      const runs = [];
      for (const zoom of options.zooms) {
        // **左表必须在场**：悬停读数要读"左表那一行的底色"（`?table=0` 会让它恒为空串）。
        const url = `${origin}/?measure=1&table=1&dataset=${PRIMARY_DATASET}&zoom=${String(zoom)}`;
        await openMeasuredPage(cdp, url, { hook: '__GANTTPILOT_MEASURE_AXIS_HOVER__', label: '两级刻度与悬停读数钩子' });
        const result = await cdp.evaluate(
          `window.__GANTTPILOT_MEASURE_AXIS_HOVER__({ zoom: ${JSON.stringify(zoom)} })`,
        );
        runs.push({ dataset: PRIMARY_DATASET, zoom, result });
        const verdict = judgeAxisHoverSnapshot({ result });
        console.log(
          `[axis-hover] ${String(zoom)}：上级 ${String(result?.axis?.majorY ?? '?')} / 下级 ${String(result?.axis?.minorY ?? '?')}、` +
            `行带 ${String(result?.hover?.idle?.svgHoverRows ?? '?')} → ${String(result?.hover?.onRow?.svgHoverRows ?? '?')}、` +
            `前提自证 ${verdict.problems.length === 0 ? '✅' : `❌ ${verdict.problems.join('；')}`}`,
        );
      }
      const env = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        基视口: `${String(BASE_VIEWPORT.width)}×${String(BASE_VIEWPORT.height)}（Emulation.setDeviceMetricsOverride）`,
        数据集: PRIMARY_DATASET,
        左表: '在场（不带 ?table=0）——悬停读数要读左表那一行的底色',
        档位: options.zooms.join(' / '),
        ...hookVersionEnv(),
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
      const evidencePath = join(evidenceDir, `chart-axis-hover-chrome${major}.md`);
      writeFileSync(evidencePath, withRawLink(renderAxisHoverEvidence({ env, runs }), 'chart-axis-hover-raw.json'), 'utf8');
      writeFileSync(
        join(evidenceDir, 'chart-axis-hover-raw.json'),
        `${JSON.stringify({ env, runs }, null, 2)}\n`,
        'utf8',
      );
      if (runs.some((run) => judgeAxisHoverSnapshot(run).problems.length > 0)) process.exitCode = 1;
      console.log(`[measure] 刻度与悬停证据已写入 ${evidencePath}`);
      return;
    }

    // 预热一次导航（模块加载与首次布局的冷启动不进数字）。
    await openMeasuredPage(cdp, `${origin}/?measure=1`, { hook: '__GANTTPILOT_MEASURE__' });
    await new Promise((settle) => setTimeout(settle, 600));

    const plans = [];
    for (const zoom of options.zooms) plans.push({ dataset: PRIMARY_DATASET, zoom });
    if (options.includeReference) plans.push({ dataset: REFERENCE_DATASET, zoom: 'day' });

    // ---------------------------------------------------------------- G6：持久化（记录制）
    if (options.persistDrag || options.storageMetrics) {
      const envBase = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        口径: '打包产物（apps/web/dist）',
        数据集: options.storageMetrics ? STORAGE_DATASET : PERSIST_DATASET,
        拖动天数: options.dayDelta,
        测试帧数: options.dragFrames,
        ...hookVersionEnv(),
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';

      if (options.storageMetrics) {
        const storageUrl = `${origin}/?measure=1&persist=1&dataset=${STORAGE_DATASET}`;
        await persistNavigate(cdp, storageUrl);
        await persistClear(cdp);
        const run = {
          dataset: STORAGE_DATASET,
          result: await persistProbe(
            cdp,
            {
              dataset: STORAGE_DATASET,
              samples: 3,
              skipDrag: true,
              frames: options.dragFrames,
              dayDelta: options.dayDelta,
            },
            storageUrl,
          ),
        };
        const storage = run.result?.storage ?? null;
        // 量完就清库：estimate() 报的是**整个源**的用量，不清的话下一轮会报累计值
        // （实测：0.15 KB 的单条记录却配着 490 KB 的「用量」）。
        await persistClear(cdp);
        const evidencePath = join(evidenceDir, `persist-storage-2000-chrome${major}.md`);
        writeFileSync(evidencePath, withRawLink(renderStorageMetricsEvidence({ env: envBase, run }), 'persist-storage-2000-raw.json'), 'utf8');
        writeFileSync(
          join(evidenceDir, 'persist-storage-2000-raw.json'),
          `${JSON.stringify({ env: envBase, run }, null, 2)}\n`,
          'utf8',
        );
        if (storage !== null) {
          console.log(
            `[storage] 任务 ${String(storage.tasks)} / 依赖 ${String(storage.links)}：整份文档 ${(Number(storage.documentBytes) / 1024).toFixed(1)} KB ` +
              `（序列化 ${Number(storage.serializeMs).toFixed(1)} ms）、单条记录 ${(Number(storage.recordBytes) / 1024).toFixed(2)} KB、` +
              `写入 p50/p95 ${Number(storage.putP50Ms).toFixed(1)}/${Number(storage.putP95Ms).toFixed(1)} ms`,
          );
        }
        if (run.result?.status === 'error') {
          console.error(`[storage] errors: ${(run.result.errors ?? []).join('；')}`);
          process.exitCode = 1;
        }
        console.log(`[measure] 存储证据已写入 ${evidencePath}`);
        return;
      }

      const runs = [];
      for (const enabled of [true, false]) {
        runs.push(
          await persistDragRound(cdp, origin, {
            enabled,
            dayDelta: options.dayDelta,
            frames: options.dragFrames,
          }),
        );
      }
      const evidencePath = join(evidenceDir, `persist-drag-timing-chrome${major}.md`);
      writeFileSync(evidencePath, withRawLink(renderPersistDragEvidence({ env: envBase, runs }), 'persist-drag-timing-raw.json'), 'utf8');
      writeFileSync(
        join(evidenceDir, 'persist-drag-timing-raw.json'),
        `${JSON.stringify({ env: envBase, runs }, null, 2)}\n`,
        'utf8',
      );
      for (const run of runs) {
        const item = run.result ?? {};
        const flushText =
          item.flushAfterReleaseMs === null || item.flushAfterReleaseMs === undefined
            ? '-'
            : `${Number(item.flushAfterReleaseMs).toFixed(1)} ms`;
        console.log(
          `[persist-drag] 持久化 ${run.label}：帧间隔 p50/p95 ${Number(item.frameGapP50Ms ?? 0).toFixed(1)}/${Number(item.frameGapP95Ms ?? 0).toFixed(1)} ms、` +
            `主线程 p95 ${Number(item.mainThreadP95Ms ?? 0).toFixed(2)} ms、拖动期写入 ${String(item.writesDuringGesture ?? '-')}、` +
            `松手→落盘 ${flushText}`,
        );
      }
      if (runs.some((run) => run.result?.status === 'error')) {
        console.error(`[persist-drag] errors: ${runs.flatMap((run) => run.result?.errors ?? []).join('；')}`);
        process.exitCode = 1;
      }
      console.log(`[measure] 持久化拖拽证据已写入 ${evidencePath}`);
      return;
    }

    // ---------------------------------------------------------------- G5：拖动测量（记录制）
    if (options.drag) {
      const dragReady = await cdp.evaluate('typeof window.__GANTTPILOT_MEASURE_DRAG__ === "function"');
      if (dragReady !== true) throw new Error('拖动测量钩子未就绪（页面里没有 __GANTTPILOT_MEASURE_DRAG__）');
      // **两个状态各跑一次**（P-25：R13/R14 只在滚动后现形——只拖首屏的判据结构上抓不到它们）。
      // 两种语义各跑这两个状态（P-45：`resize-duration` 的下游跟随与"预览不落库"是**另一族**判据，
      // 而它同样只在滚动后才有判别力——P-25 的教训对每一族都成立）。
      const DRAG_SCROLL_STATES = [
        { scrollTop: 0, scrollLeft: 0 },
        { scrollTop: 480, scrollLeft: 600 },
      ];
      const runDragMode = async (mode) => {
        const runs = [];
        for (const scroll of DRAG_SCROLL_STATES) {
          const run = await cdp.evaluate(
            `window.__GANTTPILOT_MEASURE_DRAG__(${JSON.stringify({
              dataset: options.dragDataset,
              mode,
              dayDelta: options.dayDelta,
              frames: options.dragFrames,
              scrollTop: scroll.scrollTop,
              scrollLeft: scroll.scrollLeft,
            })})`,
          );
          runs.push({ ...scroll, result: run });
        }
        return runs;
      };
      /**
       * 把一轮（同语义、多滚动状态）的结果并成一行证据：**取最差 / 并集**。
       *
       * 两族共用一个聚合函数（P-45 起）：数字口径必须逐字相同，否则"两种语义的帧预算"不可比。
       */
      const aggregateDrag = (runs, mode) => {
        const first = runs[0]?.result ?? {};
        return {
          status: runs.every((run) => run.result?.status === 'ok') ? 'ok' : 'error',
          errors: runs.flatMap((run) =>
            (run.result?.errors ?? []).map(
              (error) => `scroll(${String(run.scrollTop)},${String(run.scrollLeft)})：${String(error)}`,
            ),
          ),
          runs,
          mode,
          dataset: first.dataset ?? PRIMARY_DATASET,
          taskId: first.taskId ?? '',
          dayDelta: options.dayDelta,
          frames: options.dragFrames,
          mainThreadP50Ms: Number(first.mainThreadP50Ms ?? 0),
          mainThreadP95Ms: Math.max(...runs.map((run) => Number(run.result?.mainThreadP95Ms ?? 0))),
          frameGapP50Ms: Number(first.frameGapP50Ms ?? 0),
          frameGapP95Ms: Math.max(...runs.map((run) => Number(run.result?.frameGapP95Ms ?? 0))),
          releaseMs: Math.max(...runs.map((run) => Number(run.result?.releaseMs ?? 0))),
          longTasks: 0,
          observedGeometryChanges: Math.min(
            ...runs.map((run) => Number(run.result?.observedGeometryChanges ?? 0)),
          ),
          anchorsAfterRelease: Math.max(...runs.map((run) => Number(run.result?.anchorsAfterRelease ?? 0))),
          documentStartAfter: first.documentStartAfter ?? null,
          anchorOrdinal: first.anchorOrdinal ?? null,
          expectedStartAfter: first.expectedStartAfter ?? null,
          durationBefore: first.durationBefore ?? null,
          durationAfter: first.durationAfter ?? null,
          expectedDurationAfter: first.expectedDurationAfter ?? null,
          gestureMode: first.gestureMode ?? null,
          revisionBefore: first.revisionBefore ?? 0,
          revisionDuringDrag: first.revisionDuringDrag ?? 0,
          revisionAfterRelease: first.revisionAfterRelease ?? 0,
          downstream: first.downstream ?? null,
          // 批次 B 的记录制采样（ADR 0008 §16.2/§16.3／裁决 P-32）：手柄可见性、光标分类、连接点起手。
          handles: first.handles ?? null,
        };
      };
      const dragRuns = await runDragMode('move');
      const dragResult = aggregateDrag(dragRuns, 'move');
      const resizeRuns = await runDragMode('resize-duration');
      const resizeResult = aggregateDrag(resizeRuns, 'resize-duration');
      const env = {
        采集时刻: new Date().toISOString(),
        机器: process.env.COMPUTERNAME ?? 'local',
        系统: `${process.platform} ${process.arch}`,
        Node: process.version,
        Chrome: chromeVersion,
        'Chrome 模式': '--headless=new',
        DPR: 1,
        视口: '1280×800（窗格尺寸随结果登记）',
        数据集: options.dragDataset,
        拖动天数: options.dayDelta,
        测试帧数: options.dragFrames,
        ...hookVersionEnv(),
      };
      const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
      // 非主口径的数据集**不覆盖**主口径快照（同一次采集可以留多份规模对照；与 `--align=<label>` 同精神）。
      const dragSuffix = options.dragDataset === PRIMARY_DATASET ? '' : `-${options.dragDataset}`;
      const dragEvidencePath = join(evidenceDir, `drag-timing${dragSuffix}-chrome${major}.md`);
      writeFileSync(
        dragEvidencePath,
        withRawLink(renderDragEvidence({ env, result: dragResult, resize: resizeResult, options }), `drag-timing${dragSuffix}-raw.json`),
        'utf8',
      );
      writeFileSync(
        join(evidenceDir, `drag-timing${dragSuffix}-raw.json`),
        `${JSON.stringify({ env, result: dragResult, resize: resizeResult }, null, 2)}\n`,
        'utf8',
      );
      console.log(
        `[drag] 主线程 p95 ${Number(dragResult?.mainThreadP95Ms ?? 0).toFixed(2)} ms、` +
          `帧间隔 p50/p95 ${Number(dragResult?.frameGapP50Ms ?? 0).toFixed(1)}/${Number(dragResult?.frameGapP95Ms ?? 0).toFixed(1)} ms、` +
          `松手 ${Number(dragResult?.releaseMs ?? 0).toFixed(1)} ms、` +
          `DOM 变化帧 ${String(dragResult?.observedGeometryChanges ?? 0)}、` +
          `松手后锚点 ${String(dragResult?.anchorsAfterRelease ?? '-')}、` +
          `startDate ${String(dragResult?.documentStartAfter ?? '-')}` +
          `（期望 ${String(dragResult?.expectedStartAfter ?? '-')}）`,
      );
      const resizeDownstream = resizeResult?.downstream ?? null;
      console.log(
        `[drag/resize-duration] 主线程 p95 ${Number(resizeResult?.mainThreadP95Ms ?? 0).toFixed(2)} ms、` +
          `帧间隔 p50/p95 ${Number(resizeResult?.frameGapP50Ms ?? 0).toFixed(1)}/${Number(resizeResult?.frameGapP95Ms ?? 0).toFixed(1)} ms、` +
          `松手 ${Number(resizeResult?.releaseMs ?? 0).toFixed(1)} ms、` +
          `工期 ${String(resizeResult?.durationBefore ?? '-')} → ${String(resizeResult?.durationAfter ?? '-')}` +
          `（期望 ${String(resizeResult?.expectedDurationAfter ?? '-')}）、` +
          `下游 \`${String(resizeDownstream?.taskId ?? '-')}\` es ${String(resizeDownstream?.before ?? '-')} → ` +
          `拖动期 ${String(resizeDownstream?.during ?? '-')} → 松手 ${String(resizeDownstream?.after ?? '-')}、` +
          `revision ${String(resizeResult?.revisionBefore ?? '-')} --拖动期--> ${String(resizeResult?.revisionDuringDrag ?? '-')}` +
          ` --松手--> ${String(resizeResult?.revisionAfterRelease ?? '-')}`,
      );
      if (dragResult?.status === 'error') {
        console.error(`[drag] errors: ${(dragResult.errors ?? []).join('；')}`);
        process.exitCode = 1;
      }
      if (resizeResult?.status === 'error') {
        console.error(`[drag/resize-duration] errors: ${(resizeResult.errors ?? []).join('；')}`);
        process.exitCode = 1;
      }
      console.log(`[measure] 拖动证据已写入 ${dragEvidencePath}`);
      return;
    }

    const runs = [];
    for (const plan of plans) {
      const result = await measureOne(cdp, origin, { ...plan, rounds: options.rounds, scrollSteps: options.scrollSteps });
      runs.push({ ...plan, result });
      const first = result?.firstScreen;
      const scroll = result?.scroll;
      console.log(
        `[measure] ${plan.dataset}/${String(plan.zoom)}：首屏 ${first === null || first === undefined ? '失败' : `${first.primaryMs.toFixed(1)} ms`}、` +
          `10× 滚动 ${scroll === null || scroll === undefined ? '失败' : `${scroll.totalWallMs.toFixed(1)} ms`}、` +
          `主线程 p95 ${scroll === null || scroll === undefined ? '-' : `${scroll.p95WorkMs.toFixed(2)} ms`}、` +
          `空白行 ${scroll === null || scroll === undefined ? '-' : String(scroll.blankRowGaps)}`,
      );
      if (result?.status === 'error') console.error(`[measure]   errors: ${result.errors.join('；')}`);
    }

    const env = {
      采集时刻: new Date().toISOString(),
      机器: process.env.COMPUTERNAME ?? 'local',
      系统: `${process.platform} ${process.arch}`,
      Node: process.version,
      Chrome: chromeVersion,
      'Chrome 模式': '--headless=new',
      DPR: 1,
      视口: `${String(BASE_VIEWPORT.width)}×${String(BASE_VIEWPORT.height)}`,
      档位: options.zooms.join(' / '),
      数据集: plans.map((plan) => plan.dataset).join(' / '),
      轮数: options.rounds,
      滚动步数: options.scrollSteps,
        ...hookVersionEnv(),
    };

    const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? 'unknown';
    const evidencePath = join(evidenceDir, `render-timing-chrome${major}.md`);
    writeFileSync(evidencePath, withRawLink(renderEvidence({ env, runs, options }), 'render-timing-raw.json'), 'utf8');
    writeFileSync(join(evidenceDir, 'render-timing-raw.json'), `${JSON.stringify({ env, runs }, null, 2)}\n`, 'utf8');
    console.log(`[measure] 证据已写入 ${evidencePath}`);

    const failed = runs.filter((run) => run.result?.status === 'error');
    if (failed.length > 0) {
      console.error(`[measure] ${String(failed.length)} 组测量失败（基础设施不可信）`);
      process.exitCode = 1;
    }
  } finally {
    cdp?.close();
    // 收尾：协议级 `Browser.close` 优先，超时才按 PID 树；两条路都先过 profile 闸
    // （不杀进程、不按名字匹配——见 `scripts/chrome-harness.mjs`）。
    // **不删 profile 目录**：`tmp/` 的清理策略属 C7，本批保持原行为。
    const outcome = await closeChromeSession({
      profileDir: chrome?.profileDir ?? null,
      pid: chrome?.child.pid,
    });
    if (outcome.closedBy === 'pid-tree') console.error('[measure] 协议级关闭未生效，已按 PID 树兜底');
    if (outcome.note !== '') console.error(`[measure] 收尾说明：${outcome.note}`);
    closeServer();
  }
}

await main();
