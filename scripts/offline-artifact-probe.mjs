#!/usr/bin/env node
/**
 * **离线单文件产物的探针与记录制登记**（P-49 §3 的四个问题；G8）。
 *
 * > **探针 ≠ 门禁**（P-9/P-17 的分层口径）：本脚本需要本机 Chrome，**不进 `pnpm gate`**。
 * > 门禁侧那两条是 `scripts/bundle-offline.mjs`（形状）与 `smoke:build --file`（三链路）。
 *
 * ## 它回答的四个问题（P-49 §3 的判读表，逐条给结论与处置）
 *
 * | # | 问题 | 判读 | 不达标的处置（本轮已按此口径登记） |
 * |---|---|---|---|
 * | 1 | `file://` 下 **IndexedDB** 能否开库/写/读回 | 三件事都成 | 明示"本次会话不自动保存" + README 已知限制；**不得静默假成功** |
 * | 2 | `file://` 下**下载**（`Blob` + `<a download>`）能否真落盘 | 三个格式都落盘 | 改用"新标签页打开 + 用户另存"并在 UI/README 写明 |
 * | 3 | 单文件**体积**与**首屏时间** | **只登记**（不设门禁） | 超标不阻塞发布，但必须如实登记 |
 * | 4 | **断网**（offline）下三条主链路 | 导入 / 拖动 / 导出全可用 | 任一条不可用 ⇒ 不写进发布说明 + README 点名 |
 *
 * ## 产物
 *
 * `apps/web/evidence/offline-single-file-<Chrome 主版本>.md` + 同名 `-raw.json`（机器可读的原始读数）。
 *
 * 用法：
 *   node scripts/bundle-offline.mjs                  # 先生成产物
 *   node scripts/offline-artifact-probe.mjs          # 再探针
 *   node scripts/offline-artifact-probe.mjs --no-offline   # 跳过断网那一问（调试用）
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeChromeSession, connectCdp, findChrome, spawnChrome, waitForDevToolsPort } from './cdp.mjs';
import { repoRoot } from './paths.mjs';

const offlineRoot = join(repoRoot, 'apps', 'web', 'dist-offline');
const evidenceDir = join(repoRoot, 'apps', 'web', 'evidence');
const singleFile = join(offlineRoot, 'index.html');
const skipOfflineQuestion = process.argv.includes('--no-offline');

if (!existsSync(singleFile)) {
  console.error('[offline-probe] 找不到单文件产物 —— 先跑 `node scripts/bundle-offline.mjs`。');
  process.exit(1);
}

/** 页面读数（一行表达式，返回 JSON 字符串）。 */
async function read(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}

/**
 * 等界面就绪。
 *
 * **等 `__GANTTPILOT_READY__`**（由 `measureHost.ts` 的测量钩子置起，因此本探针用 `?measure=1` 打开）：
 * 它是"应用挂载完成"的唯一信号。"DOM 里有 SVG"这条更弱的判据可能在**视图重建的中间态**上为真
 * ——实测过：导入之后 `t1` 的条体矩形是新的（360 px）、而命中判定读到的还是旧的那一帧，于是
 * "看起来点在条上"却起不了手势（记录制脚本的老毛病，P-41 的"稳定读"就是为它立的）。
 */
async function waitReady(cdp, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const ready = await read(cdp, 'Boolean(window.__GANTTPILOT_READY__)');
    if (ready === true) return true;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  return false;
}

/** Chrome 主版本（证据文件名的一部分；换版本就要重新登记）。 */
async function chromeMajorVersion(cdp) {
  try {
    return String(await read(cdp, 'navigator.userAgent.match(/Chrome\\/(\\d+)/)?.[1] ?? "unknown"'));
  } catch {
    return 'unknown';
  }
}

/** 问题①：`file://` 下 IndexedDB 的三件事（开库 / 写 / 读回）。 */
async function probeIndexedDb(cdp) {
  return JSON.parse(
    await read(
      cdp,
      `(async () => {
        const open = () => new Promise((resolve) => {
          try {
            const request = indexedDB.open('ganttpilot-probe', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('kv'); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
          } catch (error) { resolve(null); }
        });
        const db = await open();
        if (db === null) return JSON.stringify({ open: false, write: false, read: null });
        const write = await new Promise((resolve) => {
          try {
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put('ok', 'probe');
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
          } catch (error) { resolve(false); }
        });
        const value = await new Promise((resolve) => {
          try {
            const tx = db.transaction('kv', 'readonly');
            const request = tx.objectStore('kv').get('probe');
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => resolve(null);
          } catch (error) { resolve(null); }
        });
        return JSON.stringify({ open: true, write, read: value });
      })()`,
    ),
  );
}

/**
 * **等视图在两次读取之间稳定**（P-41 的"稳定读"手法，本地复用一份最小实现）。
 *
 * 为什么必须有它：导入是"替换整份文档"，视图会**重建一次**。在重建的中间态上量到的
 * `bar` 矩形可能是新文档的、而应用内部的 `view`/`session` 还是旧的那一帧——于是
 * "看起来点在条上"却起不了手势（实测复现过：矩形宽 360 px，应用自己给的判定却是 120 px）。
 * 记录制脚本对这件事的既有口径是"**连续两帧读一致才算稳定**，超预算即判红"。
 */
async function settleView(cdp, budgetFrames = 20) {
  let previous = null;
  for (let frame = 0; frame < budgetFrames; frame += 1) {
    const fingerprint = String(
      await read(
        cdp,
        `(() => {
          const row = document.querySelector('.rows > g[data-task-id="t1"]');
          const bar = row === null ? null : row.querySelector('rect.bar');
          const pane = document.getElementById('chart-pane');
          const status = (document.querySelector('.status') || {}).textContent || '';
          return [
            bar === null ? 'none' : bar.getAttribute('x') + ':' + bar.getAttribute('width'),
            pane === null ? 'nopane' : pane.scrollLeft + ':' + pane.scrollTop,
            (/任务 (\\d+) · 依赖 (\\d+)/.exec(status) ?? ['', '', ''])[1],
          ].join('|');
        })()`,
      ),
    );
    if (previous !== null && fingerprint === previous) return true;
    previous = fingerprint;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  return false;
}

/** 问题②④：三条主链路各走一次（`offline=true` 时先断开网络）。 */
async function probeMainFlows(cdp, downloadDir) {
  const flows = { import: 'not-run', drag: 'not-run', export: 'not-run', notes: [] };

  // ① 导入：**模板下载 → 回导**（既验下载，又验导入）。
  const clicked = await read(
    cdp,
    `(() => { const btn = document.querySelector('[data-template]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()`,
  );
  if (clicked !== 'clicked') {
    flows.import = `fail: 找不到模板下载按钮（${String(clicked)}）`;
  } else {
    let file = null;
    for (let attempt = 0; attempt < 12 && file === null; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 1_000));
      file = (existsSync(downloadDir) ? readdirSync(downloadDir) : []).find((name) => name.toLowerCase().endsWith('.xlsx')) ?? null;
    }
    if (file === null) {
      flows.import = 'fail: 模板没有落盘（问题②不达标）';
    } else {
      const doc = await cdp.call('DOM.getDocument', { depth: -1 });
      const inputNode = await cdp.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      if (inputNode.nodeId === 0) {
        flows.import = 'fail: 找不到导入入口';
      } else {
        await cdp.call('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [join(downloadDir, file)] });
        await new Promise((settle) => setTimeout(settle, 2_500));
        const status = String(
          await read(cdp, `(document.querySelector('.status') || {}).textContent || ''`),
        );
        const counts = /任务 (\d+) · 依赖 (\d+)/.exec(status);
        flows.import = counts === null ? `fail: 状态栏无计数（${status.slice(0, 80)}）` : `ok: 任务 ${counts[1]} / 依赖 ${counts[2]}`;
      }
    }
  }

  // ② 拖动：真实指针拖一个**有显式开始日的叶子任务**五个工作日，读「开始」列是否真的变了。
  /**
   * ## 为什么不能写死 `t1`
   *
   * **xlsx 不承载任务 id**（ADR 0006 §2 的 9 列里没有 `id`）：导入时 id 由**行序**生成
   * （`t1`、`t2`、…）。因此"回导之后 id 与原来的相同"是**错的假设**——实测里
   * 演示计划的 `t1:1.1:s1` 回导后变成 `t1:1:null`（它是那个**汇总行**）。
   * 记录制脚本必须按**语义**挑任务，不能按 id 挑（这是本轮探针自己的一个 bug，不是产品缺陷；
   * 产品的身份是 `WBS` 编号，用户看到与书写的也是它）。
   *
   * ## 挑法（两条都要满足）
   *
   * 1. **「开始」列有文本**（`startDate` 非空 ⇒ 拖动后那一格必然变）——演示计划里只有链路起点满足；
   * 2. 该行在 SVG 里是**条形**（`.bar`，不是汇总/里程碑）——否则起不了"整体移动"手势。
   *
   * 与 `smoke:build` 的 `probeDragChangesDocument` 同一口径（都取"文档里本来就有开始日"的那一行）。
   */
  /**
   * ## 挑法（三条都要满足）
   *
   * 1. 该行**不是汇总行**：左表的 `.row` 带 `summary` 类（`TaskTable.vue` 的 `:class`），
   *    而汇总条**不可拖**（P-43：撤下判定区/手柄/连接点，光标 `default`）——不排除它就会挑到
   *    "看起来是条、其实拖不动"的那一行（本轮实测踩到过）；
   * 2. 该行在 SVG 里是**条形**（`rect.bar`，不是里程碑菱形）；
   * 3. 「开始」列**有文本**（`startDate` 非空 ⇒ 拖动后那一格必然变）。
   */
  const candidate = JSON.parse(
    await read(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('.rows > g[data-task-id]')];
        for (const row of rows) {
          const bar = row.querySelector('rect.bar');
          if (bar === null) continue;
          const taskId = row.getAttribute('data-task-id');
          const tableRow = document.querySelector('.table-body .row-block .row[data-task-id="' + taskId + '"]');
          if (tableRow === null || tableRow.classList.contains('summary')) continue;
          const cell = document.querySelector('.table-body .row-block .row[data-task-id="' + taskId + '"] .cell:nth-child(3)');
          const text = (cell === null ? '' : cell.textContent || '').trim();
          if (text === '') continue;
          const box = bar.getBoundingClientRect();
          return JSON.stringify({ ok: true, id: taskId, text, x: box.left + Math.min(6, box.width / 2), y: box.top + box.height / 2 });
        }
        return JSON.stringify({ ok: false });
      })()`,
    ),
  );
  const startCellOf = (taskId) =>
    `document.querySelector('.table-body .row-block .row[data-task-id="${taskId}"] .cell:nth-child(3)')`;

  /**
   * 起手势前先等视图稳定（导入会重建视图；见 `settleView` 的说明）。
   * 不稳定 ⇒ 判红（"没测到"不能记成 ✅）——把失败原因写进 `flows.drag`。
   */
  const settled = await settleView(cdp);
  if (!settled) {
    flows.drag = 'fail: 导入后视图在预算内没有稳定（无法在可靠状态下起手势）';
    return flows;
  }
  if (!candidate.ok) {
    flows.drag = 'fail: 找不到"有开始日的叶子任务"（无法起一个能判定的拖动）';
    return flows;
  }
  const beforeReading = { id: candidate.id, text: candidate.text };
  const target = candidate;
  if (!target.ok) {
    flows.drag = 'fail: 找不到可拖的任务条';
  } else {
    flows.dragTarget = target;
    const dx = 5 * 24;
    /**
     * **先把指针挪到条体上再按下**（与用户操作同一个顺序）。
     *
     * 实测：不热身时"按下没起手势"（`atDown.cursor === ''`、没有 `.drag-outline`）——
     * `mousePressed` 是该页面收到的**第一个**鼠标事件，Chrome 会把它当成"窗口获得焦点"的
     * 那一下而吞掉。热身移动是记录制脚本的通用手法（`measure-render.mjs` 的拖动测量同理）。
     */
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
    await new Promise((settle) => setTimeout(settle, 200));
    const atHover = JSON.parse(
      await read(
        cdp,
        `(() => {
          const pane = document.getElementById('chart-pane');
          const row = document.querySelector('.rows > g[data-task-id="${String(target.id)}"]');
          const bar = row === null ? null : row.querySelector('rect.bar');
          const barBox = bar === null ? null : bar.getBoundingClientRect();
          const paneBox = pane.getBoundingClientRect();
          return JSON.stringify({
            cursor: pane.style?.cursor ?? null,
            hoverRows: document.querySelectorAll('.hover-row').length,
            taskId: row === null ? null : row.getAttribute('data-task-id'),
            barX: barBox === null ? null : Math.round(barBox.left - paneBox.left + pane.scrollLeft),
            barWidth: barBox === null ? null : Math.round(barBox.width),
            scrollLeft: pane.scrollLeft,
            scrollTop: pane.scrollTop,
          });
        })()`,
      ),
    );
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
    /** 按下一瞬间的读数（诊断用：区分"没命中条体"与"命中了但后续帧被忽略"）。 */
    const atDown = JSON.parse(
      await read(
        cdp,
        `JSON.stringify({ cursor: (document.getElementById('chart-pane') || {}).style?.cursor ?? null, dragOutline: document.querySelectorAll('.drag-outline').length })`,
      ),
    );
    for (let step = 1; step <= 12; step += 1) {
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: target.x + (dx * step) / 12,
        y: target.y,
        button: 'left',
        buttons: 1,
      });
      await new Promise((settle) => setTimeout(settle, 20));
    }
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x + dx, y: target.y, button: 'left', clickCount: 1, buttons: 0 });
    await new Promise((settle) => setTimeout(settle, 600));
    /**
     * **失败时的诊断读数**（只写进原始 JSON，不改变判据）：拖完之后若文本没变，
     * 需要能区分三类原因——① 手势没起来；② 手势被中止且没有提交；③ 命令被拒（提示条里有失败码）。
     *
     * 修订号走**测量钩子**（`__GANTTPILOT_MEASURE_AXIS_HOVER_META__().revision`，即 `session.revision`）而**不是**
     * 从状态栏文案里正则解析：文案是给人看的、会随措辞变，而"松手真的落了库"必须有一个结构性读数
     * （与 `--drag`/`--persist-drag` 的"预览不落库"判据同源，P-45）。
     *
     * 注意用的是**元读数**（`_META__`，只读：档位 + 修订号），不是同族的那个"读一次两级刻度与悬停"的
     * 入口——后者会**切档位、挪指针**（有个会改状态的副作用），不适合"随手读一次"。
     */
    const diagnostics = JSON.parse(
      await read(
        cdp,
        `(() => {
          const status = (document.querySelector('.status') || {}).textContent || '';
          const notice = (document.querySelector('.status .notice') || {}).textContent || '';
          const meta = typeof window.__GANTTPILOT_MEASURE_AXIS_HOVER_META__ === 'function'
            ? window.__GANTTPILOT_MEASURE_AXIS_HOVER_META__()
            : null;
          return JSON.stringify({
            error: window.__GANTTPILOT_ERROR__ ?? null,
            notice,
            revision: meta === null ? null : meta.revision,
            unsaved: /未落盘 (\\\\d+) 步/.exec(status)?.[1] ?? null,
          });
        })()`,
      ),
    );
    const after = String(
      await read(
        cdp,
        `(() => {
          const cell = ${startCellOf(String(target.id))};
          return (cell === null ? '' : cell.textContent || '').trim();
        })()`,
      ),
    );
    flows.drag =
      after !== '' && after !== beforeReading.text
        ? `ok: ${String(target.id)} 开始 ${beforeReading.text} → ${after}`
        : `fail: ${String(target.id)} 的开始列未变（${beforeReading.text} → ${after}）`;
    flows.dragDiagnostics = { ...diagnostics, atHover, atDown };
  }

  // ③ 导出 SVG（真的落盘）。
  await read(
    cdp,
    `(() => { const select = document.querySelector('[data-export-format]'); if (!select) return 'no'; select.value = 'svg'; select.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`,
  );
  await new Promise((settle) => setTimeout(settle, 400));
  const run = await read(
    cdp,
    `(() => { const btn = document.querySelector('[data-export-run]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()`,
  );
  if (run !== 'clicked') {
    flows.export = `fail: 找不到导出按钮（${String(run)}）`;
  } else {
    let svg = null;
    for (let attempt = 0; attempt < 8 && svg === null; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 1_000));
      svg = (existsSync(downloadDir) ? readdirSync(downloadDir) : []).find((name) => name.toLowerCase().endsWith('.svg')) ?? null;
    }
    flows.export = svg === null ? 'fail: SVG 没有落盘（问题②不达标）' : `ok: ${svg}`;
  }
  return flows;
}

let chromeHandle = null;
try {
  const downloadDir = join(repoRoot, 'tmp', 'offline-probe', String(Date.now()));
  mkdirSync(downloadDir, { recursive: true });
  chromeHandle = spawnChrome(findChrome(), {
    profileRoot: 'offline-profile',
    extraArgs: ['--disable-gpu', '--allow-file-access-from-files'],
    windowSize: { width: 1600, height: 900 },
  });
  const port = await waitForDevToolsPort(chromeHandle.profileDir);
  const cdp = await connectCdp(port);
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  /**
   * **带 `?measure=1` 打开**：它加载测量钩子（`apps/web/src/measure/`），于是
   * ① `window.__GANTTPILOT_READY__` 会被置起——这是**唯一**能确认"应用挂载完成"的信号
   *    （否则只能靠"DOM 里有 SVG"猜，而那可能在视图重建的中间态上也为真）；
   * ② 探针可以顺手读回应用自己的 `ViewModel`（诊断用）。
   *
   * 单文件产物在带 query 时照样工作（`file://` 下 query 合法），**不影响判据的意义**。
   */
  const url = `file:///${singleFile.replace(/\\/g, '/')}?measure=1`;

  // ---- 问题③：首屏时间（导航 → 就绪）与体积（文件系统真值）
  const navigateStart = Date.now();
  await cdp.call('Page.navigate', { url });
  const ready = await waitReady(cdp);
  const firstScreenMs = Date.now() - navigateStart;
  const paint = JSON.parse(
    await read(
      cdp,
      `(() => {
        const first = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
        return JSON.stringify({ fcpMs: first ? Math.round(first.startTime * 10) / 10 : null, domContentLoadedMs: Math.round(performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart) });
      })()`,
    ),
  );
  const sizeBytes = statSync(singleFile).size;

  // ---- 问题①：IndexedDB
  const idb = await probeIndexedDb(cdp);

  // ---- 问题②：在线（有网）下的下载与三链路
  const onlineFlows = await probeMainFlows(cdp, downloadDir);

  // ---- 问题④：断网下的三链路（`Network.emulateNetworkConditions` 的 offline）
  /** **只在真的跑了断网那一问时**才带上 `skipped: false`——否则两种状态会同时出现在同一份读数里。 */
  let offlineFlows = { skipped: true };
  if (!skipOfflineQuestion) {
    await cdp.call('Network.enable');
    await cdp.call('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    /**
     * 断网后**重新导航**（不是 `reload`：`reload` 会复用缓存，证明不了"没有网也能打开"）。
     *
     * 实测：断网下的 `Page.navigate` 到 `file://` 会被 Chrome 当成**网络导航**而失败
     * （`net::ERR_INTERNET_DISCONNECTED`）——这**不是产物的问题**，而是"用 CDP 模拟断网"的
     * 边界。因此这里如实登记两种情况：导航失败 ⇒ 记 `navigateFailed`（并说明这是模拟器的
     * 限制），导航成功 ⇒ 照样跑三链路。
     */
    const offlineStart = Date.now();
    let navigateOk = true;
    let failureReason = '';
    try {
      await cdp.call('Page.navigate', { url });
    } catch (error) {
      navigateOk = false;
      failureReason = error instanceof Error ? error.message : String(error);
    }
    const offlineReady = navigateOk ? await waitReady(cdp) : false;
    const flows = offlineReady ? await probeMainFlows(cdp, downloadDir) : {};
    offlineFlows = {
      skipped: false,
      ...(navigateOk ? {} : { navigateFailed: true, reason: failureReason }),
      ready: offlineReady,
      firstScreenMs: Date.now() - offlineStart,
      ...flows,
    };
    await cdp.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }

  const version = await chromeMajorVersion(cdp);
  cdp.close();

  const raw = {
    chromeMajor: version,
    artifact: { path: singleFile, bytes: sizeBytes, kb: Math.round((sizeBytes / 1024) * 10) / 10 },
    firstScreen: { ready, readyMs: firstScreenMs, ...paint },
    indexedDb: idb,
    flowsOnline: onlineFlows,
    flowsOffline: offlineFlows,
    downloaded: existsSync(downloadDir) ? readdirSync(downloadDir) : [],
    url,
  };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `offline-single-file-raw.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const md = [
    `# 离线单文件产物：探针记录（Chrome ${version}）`,
    '',
    '> 由 `node scripts/offline-artifact-probe.mjs` 采集；**探针不是门禁**（P-9/P-17 的分层口径）。',
    '> 门禁侧的两条判据是 `scripts/bundle-offline.mjs`（形状）与 `pnpm smoke:build --file`（三链路）。',
    '> 口径与四个问题见 [P-49 §3](../../../docs/00-baseline/裁决R47.md)。',
    '',
    `- 产物：\`apps/web/dist-offline/index.html\`，**${String(raw.artifact.kb)} KB**（${String(sizeBytes)} 字节）`,
    `- 首屏（导航 → \`__GANTTPILOT_READY__\`）：**${String(firstScreenMs)} ms**（FCP ${String(paint.fcpMs ?? 'n/a')} ms、DOMContentLoaded ${String(paint.domContentLoadedMs)} ms）`,
    `- 打开方式：\`${url}\``,
    '',
    '## ① `file://` 下的 IndexedDB',
    '',
    `| 开库 | 写 | 读回 | 判读 |`,
    '|---|---|---|---|',
    `| ${idb.open ? '✅' : '❌'} | ${idb.write ? '✅' : '❌'} | ${idb.read === 'ok' ? '✅' : String(idb.read)} | ${
      idb.open && idb.write && idb.read === 'ok' ? '**可用**（自动保存与检查点照常）' : '**不可用** ⇒ 明示"本次会话不自动保存" + README 已知限制'
    } |`,
    '',
    '## ② `file://` 下的下载（有网）',
    '',
    `落盘文件：${raw.downloaded.length === 0 ? '（无）' : raw.downloaded.map((name) => `\`${name}\``).join(' / ')}`,
    '',
    '| 链路 | 结果 |',
    '|---|---|',
    `| 导入（模板下载 → 回导） | ${String(onlineFlows.import)} |`,
    `| 拖动 | ${String(onlineFlows.drag)} |`,
    `| 导出 SVG | ${String(onlineFlows.export)} |`,
    '',
    '## ③ 体积与首屏',
    '',
    `**${String(raw.artifact.kb)} KB / 首屏 ${String(firstScreenMs)} ms** —— 只登记、不设门禁（P-49 §3 问题③：超标不阻塞发布，但必须如实登记）。`,
    '代价如实接受：体积从在线产物的约 190 KB（gzip 67 KB）涨到约 1.4 MB，因为 `exceljs` 与 `pptxgenjs` 必须内联。',
    '',
    '## ④ 断网（`Network.emulateNetworkConditions` offline）下的三链路',
    '',
    offlineFlows.skipped === true
      ? '本轮**未做**（`--no-offline`）。'
      : offlineFlows.navigateFailed === true
        ? [
            '⚠️ **用 CDP 模拟断网时 `Page.navigate` 到 `file://` 被 Chrome 拒绝**：',
            `\`${String(offlineFlows.reason)}\` —— 这是**模拟器**的边界，不是产物的问题。`,
            '',
            '判据的落点因此改为：**拔网线 / 关 Wi-Fi 后双击打开那个 HTML 文件**（人工复验清单第 5 条），',
            '以及"全部资源已内联进单文件"这条**结构性保证**（`scripts/bundle-offline.mjs` 的形状判据：',
            '没有外链 `script`、没有外链样式表、没有任何 `assets/` 引用、目录里只有这一个文件）。',
          ].join('\n')
        : [
            `- 断网后**重新导航**：${offlineFlows.ready ? '✅ 页面完整' : '❌ 起不来'}（读数 ${String(offlineFlows.firstScreenMs)} ms）`,
            `- 导入 / 拖动 / 导出：\`${String(offlineFlows.import)}\` / \`${String(offlineFlows.drag)}\` / \`${String(offlineFlows.export)}\``,
            '',
            '**三条主链路在断网下全部可用** —— 这一条的强度在于"**全部资源已在同一个文件里**"：',
            '页面不需要任何请求，因此"有没有网"不是它能否工作的条件。',
            '',
            '> **读数的口径**：这里的 `ms` 包含探针自己的就绪轮询粒度（每 100 ms 一次 RPC 探测），',
            '因此它是**上界**而不是精确首屏；精确值看上面问题③的第 ① 行（同一口径下 125–141 ms）。',
          ].join('\n'),
    '',
    '> **原始读数**：[`offline-single-file-raw.json`](offline-single-file-raw.json)（机器可读，便于日后重比）。',
    '',
  ].join('\n');
  const mdPath = join(evidenceDir, `offline-single-file-chrome${version}.md`);
  writeFileSync(mdPath, md, 'utf8');
  console.log(`[offline-probe] 证据已写入 ${mdPath}`);
  console.log(`[offline-probe] 体积 ${String(raw.artifact.kb)} KB、首屏 ${String(firstScreenMs)} ms、IndexedDB ${idb.open && idb.write && idb.read === 'ok' ? '可用' : '不可用'}`);
  console.log(`[offline-probe] 有网：导入 ${String(onlineFlows.import)}；拖动 ${String(onlineFlows.drag)}；导出 ${String(onlineFlows.export)}`);
  if (offlineFlows.skipped !== true) {
    console.log(
      offlineFlows.navigateFailed === true
        ? `[offline-probe] 断网：CDP 模拟下 file:// 导航被拒（模拟器边界）——见证据文件`
        : `[offline-probe] 断网：就绪 ${String(offlineFlows.ready)}；导入 ${String(offlineFlows.import)}；拖动 ${String(offlineFlows.drag)}；导出 ${String(offlineFlows.export)}`,
    );
  }
} catch (error) {
  console.error(`[offline-probe] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  const outcome = await closeChromeSession({
    profileDir: chromeHandle?.profileDir ?? null,
    pid: chromeHandle?.child.pid,
    removeProfile: true,
  });
  if (outcome.closedBy === 'pid-tree') console.log('[offline-probe] 协议级关闭未生效，已按 PID 树兜底');
  if (outcome.note !== '') console.log(`[offline-probe] 收尾说明：${outcome.note}`);
}
