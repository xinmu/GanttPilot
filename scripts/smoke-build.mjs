#!/usr/bin/env node
/**
 * **打包产物冒烟**（G6 起进 `pnpm gate`）。
 *
 * ## 为什么需要它
 *
 * 维护者的报文：「`pnpm build` 后打开 `apps/web/dist/index.html` 页面空白」——根因是
 * **ES module 在 `file://` 下会被浏览器拒绝**（CORS），不是产物坏了。但这件事暴露了一个真缺口：
 * 在此之前，**没有任何门禁碰过 `dist/`**。全部 700+ 条判据都在包源码上（Node），
 * 记录制测量又只跑「已就绪」之后的路径；于是"打包产物能不能起来"完全靠人记得看一眼。
 *
 * 本脚本补上那一环：**用 HTTP 伺服 `dist/`，无头 Chrome 打开，断言"没有应用级错误、界面真的渲染了"**。
 *
 * ## 与记录制测量的分工
 *
 * | 层 | 手段 | 进 `pnpm gate`？ |
 * |---|---|---|
 * | **产物能起来** | 本脚本（零新增依赖：`node:http` + 内置 `WebSocket` 走 CDP） | **进** |
 * | 性能数字（首屏/滚动/拖拽/持久化） | `scripts/measure-render.mjs`（本机 Chrome，快照会随版本变） | **不进**（记录制，P-9/P-17） |
 *
 * 缺 Chrome 时**失败而不是跳过**（P-12 口径：判据要么真跑，要么别写）。
 *
 * 用法：
 *   node scripts/smoke-build.mjs
 *   GANTTPILOT_CHROME=<path> node scripts/smoke-build.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { closeChromeSession, connectCdp, findChrome, spawnChrome, startStaticServer, waitForDevToolsPort } from './cdp.mjs';
import { repoRoot } from './paths.mjs';

const distRoot = join(repoRoot, 'apps', 'web', 'dist');

/**
 * 打包产物是否就绪（缺 `index.html` 即"还没构建"，那是用法错误，直接说清）。
 *
 * `--file` 模式判的是**离线单文件产物**（`apps/web/dist-offline/index.html`，P-49），
 * 因此那一套就绪检查与在线产物的口径互不代替。
 */
const offlineRoot = join(repoRoot, 'apps', 'web', 'dist-offline');
const fileMode = process.argv.includes('--file');
if (fileMode) {
  if (!existsSync(join(offlineRoot, 'index.html'))) {
    console.error('[smoke] 找不到离线单文件产物：apps/web/dist-offline/index.html —— 先跑 `node scripts/bundle-offline.mjs`。');
    process.exit(1);
  }
} else if (!existsSync(join(distRoot, 'index.html'))) {
  console.error('[smoke] 找不到打包产物：apps/web/dist/index.html —— 先跑 `pnpm build`。');
  process.exit(1);
}

/**
 * 本脚本给无头 Chrome 的固定口径（公共启动件在 `scripts/cdp.mjs`；P3/C1 抽出去的那一份）。
 *
 * - `--disable-gpu`：门禁不依赖 GPU；
 * - **必须给窗口尺寸**（P-44 落地时发现）：不给时 Chrome 用默认 ~800×600，而左表列本身就占 ~785 px
 *   ⇒ 图表列被挤到 **0 px 宽**，于是"布局稳态 / 窗格客户区"这类判据在**退化布局**上量数（量不到东西）、
 *   导出检查也失去意义。固定 1600×900 让两栏都有真实宽度；
 * - profile 根按模式分开（离线单文件与在线产物各自取证，互不干扰）。
 */
const chromeArgs = (extraArgs = []) => ({
  profileRoot: fileMode ? 'offline-profile' : 'smoke-profile',
  extraArgs: ['--disable-gpu', ...extraArgs],
  windowSize: { width: 1600, height: 900 },
});

/**
 * **首屏主 chunk 不得含 pptxgenjs**（G7，ADR 0010 §1）。
 *
 * 这与 `exceljs` 是同一条纪律（ADR 0006 §11）：导出库只准由用户动作触发时 `import()`。
 * 判据有判别力：`pptxgenjs` 的 min 产物 **271 KB**，一旦被打进主 chunk，
 * 首屏预算（G4 的 3–15 ms / G8 的分包）立刻被它吃掉——而"界面看起来正常"完全掩盖这件事。
 *
 * 同时断言"某个 chunk 里**确实**有它"：否则"主 chunk 干净"可能只是因为导出功能压根没被打进去。
 */
function checkExportChunking() {
  const problems = [];
  const assetsDir = join(distRoot, 'assets');
  const html = readFileSync(join(distRoot, 'index.html'), 'utf8');
  const entryMatch = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html);
  if (entryMatch?.[1] === undefined) {
    problems.push('index.html 里找不到 module 入口脚本');
    return problems;
  }
  const entryPath = join(distRoot, entryMatch[1].replace(/^\.?\//, ''));
  if (!existsSync(entryPath)) {
    problems.push(`index.html 引用的入口不存在：${entryMatch[1]}`);
    return problems;
  }
  const entry = readFileSync(entryPath, 'utf8');
  if (/pptxgen/i.test(entry)) {
    problems.push(`首屏主 chunk 含 pptxgenjs（${entryMatch[1]}）——导出库必须动态 import()`);
  }
  if (!existsSync(assetsDir)) {
    problems.push('找不到 dist/assets（无法确认导出库被打进某个 chunk）');
    return problems;
  }
  const chunks = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
  const withPptx = chunks.filter((name) => /pptxgen/i.test(readFileSync(join(assetsDir, name), 'utf8')));
  if (withPptx.length === 0) {
    problems.push('没有任何 chunk 含 pptxgenjs —— PPTX 导出在产物里不可用');
  }
  return problems;
}

/**
 * **读 xlsx 的页签名**（零新增依赖：zip 的条目名与内容都是明文 + 可 `inflateRawSync`）。
 *
 * 为什么冒烟脚本自己解包而不是 `import` 协议包：这里要判的是"**真的落盘的那个文件**"，
 * 而不是"再生成一次的同名字节"——只有读产物才能把"点了按钮 → 落盘 → 内容对不对"连成一条。
 * 解析范围刻意只有两件事：条目名（`xl/workbook.xml` 的位置）与 `workbook.xml` 的 `<sheet name>`。
 */
function sheetNamesOfXlsx(bytes) {
  const entries = unzipEntries(bytes);
  const workbook = entries.get('xl/workbook.xml');
  if (workbook === undefined) return { names: [], reason: 'zip 里没有 xl/workbook.xml' };
  const xml = workbook.toString('utf8');
  const names = [...xml.matchAll(/<sheet[^>]*\sname="([^"]*)"/g)].map((match) => match[1]);
  return { names, reason: names.length === 0 ? '<sheet name> 一个都没解析出来' : '' };
}

/**
 * 极简 zip 读取器（**只服务判据**：条目名 + 条目内容）。
 *
 * 支持"存储"（0）与"deflate"（8）两种压缩法——`exceljs` 写出来的是后者。
 * 不做 CRC 校验、不解目录树：多做事就会多一份需要维护的实现。
 */
function unzipEntries(buffer) {
  const out = new Map();
  const END_SIG = 0x06054b50;
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66_000; index -= 1) {
    if (buffer.readUInt32LE(index) === END_SIG) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      out.set(name, method === 0 ? raw : inflateRawSync(raw));
    } catch {
      out.set(name, Buffer.alloc(0));
    }
  }
  return out;
}

/** 跑冒烟：导航 → 等界面 → 读断言。 */
async function smoke(cdp, url) {
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    errors.push(String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? '异常'));
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params?.entry ?? {};
    const url = String(entry.url ?? '');
    const text = String(entry.text ?? '');
    // 浏览器默认会请求 `/favicon.ico`，本项目没有这个文件 ⇒ 那条 404 是噪声。
    if (entry.level === 'error' && !text.includes('favicon') && !url.includes('favicon')) {
      errors.push(url === '' ? text : `${text} @ ${url}`);
    }
  });
  await cdp.call('Log.enable');
  await cdp.call('Page.navigate', { url });
  await new Promise((settle) => setTimeout(settle, 6_000));
  const result = await cdp.call('Runtime.evaluate', {
    expression: [
      'JSON.stringify({',
      '  title: document.title,',
      '  brand: (document.querySelector(".brand") || {}).textContent || null,',
      '  pane: Boolean(document.getElementById("chart-pane")),',
      '  svg: Boolean(document.querySelector(".gantt-svg")),',
      '  exportUi: Boolean(document.querySelector("[data-export]")),',
      '  exportRun: Boolean(document.querySelector("[data-export-run]")),',
      '  status: (document.querySelector(".status") || {}).textContent || null,',
      '  persist: (document.querySelector(".status .persist") || {}).textContent || null,',
      '  error: window.__GANTTPILOT_ERROR__ ?? null,',
      '})',
    ].join(''),
    returnByValue: true,
  });
  return { probe: JSON.parse(result.result.value), errors };
}

/**
 * **布局稳态判据**（P-43，**进 `pnpm gate`**）：状态栏的高度必须与它的文案长度**无关**。
 *
 * 背景（人工复核报文）："刷新页面会发生短暂的画面抖动，点击『重置演示数据』会发生持续抖动，
 * 再次点击恢复。" 根因是自激环——状态栏文案含**视图派生的数字**（可见行/渲染行/渲染边/元素），
 * 而它原先 `flex-wrap: wrap`：文案跨过换行临界值 ⇒ footer 变高 ⇒ 窗格变矮 ⇒ 视图重新裁剪 ⇒
 * **文案里的数字又变** ⇒ 再决定换行……两态互为因果。
 *
 * 判据：连续 `frames` 帧内，**根元素不出现纵向滚动条**且 `(根高, 根滚动高, footer 高,
 * 窗格 clientWidth/clientHeight/scrollHeight)` 的**组合只有一种取值**。任一帧不同即抖动。
 */
async function probeLayoutStability(cdp, label, frames = 60) {
  const problems = [];
  const result = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const pane = document.getElementById('chart-pane');
      const footer = document.querySelector('.status');
      const root = document.documentElement;
      const samples = [];
      for (let index = 0; index < ${String(frames)}; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        samples.push([
          root.clientHeight,
          root.scrollHeight,
          footer === null ? -1 : footer.offsetHeight,
          pane === null ? -1 : pane.clientWidth,
          pane === null ? -1 : pane.clientHeight,
          pane === null ? -1 : pane.scrollHeight,
        ].join('|'));
      }
      const distinct = [...new Set(samples)];
      return JSON.stringify({
        frames: samples.length,
        distinct,
        first: distinct[0] ?? null,
        last: distinct[distinct.length - 1] ?? null,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const snapshot = JSON.parse(result.result.value);
  if (snapshot.distinct.length !== 1) {
    problems.push(
      `[布局稳态·${label}] ${String(snapshot.frames)} 帧内不收敛（自激环）：出现 ${String(snapshot.distinct.length)} 种状态，首/末 = ${String(snapshot.first)} / ${String(snapshot.last)}`,
    );
  }
  const [rootClient, rootScroll] = String(snapshot.first ?? '').split('|');
  if (Number(rootScroll) > Number(rootClient)) {
    problems.push(
      `[布局稳态·${label}] 根元素出现纵向滚动条（scrollHeight ${String(rootScroll)} > clientHeight ${String(rootClient)}）`,
    );
  }

  /**
   * **机制判据**（比"等 60 帧看它抖不抖"更硬）：**状态栏的高度必须与文案长度无关**。
   *
   * 为什么要这一条：自激环的**驱动项**就是"文案长度 → footer 高度"。只靠"等帧观察"会受环境摆布
   * ——headless 的宽度下状态栏没到换行临界值，旧口径（`flex-wrap: wrap`）也能 60 帧不动
   * （本判据的负向对照因此**测不出来**）。这里改为**直接把文案变长**：往 footer 末尾塞 200 个字，
   * 重新量高度。`nowrap` 下高度**必须一字不变**；`wrap` 下必然多出一行 ⇒ 判据必然变红。
   */
  const textProbe = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const footer = document.querySelector('.status');
      if (footer === null) return JSON.stringify({ reason: 'no-footer' });
      // **改现有 span 的文本**（不能新建 span：scoped style 会给页面的 span 加 data-v-* 属性，
      // 新建的那个不带属性、绕过了页面 CSS，量到的就不是真实机制——负向对照当场抓到了这一点）。
      const first = footer.querySelector('span');
      if (first === null) return JSON.stringify({ reason: 'no-span' });
      const original = first.textContent ?? '';
      const before = footer.offsetHeight;
      first.textContent = original + '测'.repeat(200);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const after = footer.offsetHeight;
      first.textContent = original;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return JSON.stringify({ before, after, restored: footer.offsetHeight === before });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const text = JSON.parse(textProbe.result.value);
  if (text.reason === 'no-footer' || text.reason === 'no-span') {
    problems.push(`[布局稳态·${label}] 找不到状态栏 / 它的第一段（${String(text.reason)}）`);
  } else if (text.after !== text.before) {
    problems.push(
      `[布局稳态·${label}] 状态栏高度**随文案长度变化**（${String(text.before)} → ${String(text.after)} px）：` +
        '这正是 P-43 自激环的驱动项（文案 ⇒ 换行 ⇒ footer 变高 ⇒ 窗格变矮 ⇒ 视图重裁 ⇒ 文案又变）',
    );
  }
  if (text.restored === false) problems.push(`[布局稳态·${label}] 探针未能把状态栏文本还原（测量污染了页面）`);
  /**
   * **单行判据**（这条是本判据的判别力来源）：状态栏必须**只有一行**。
   *
   * 上界按 `getComputedStyle` 现推（字号 × 1.6 + 上下 padding + 上边框），不写死像素；
   * 旧口径（`flex-wrap: wrap`）实测 98 / 133 px（2–3 行）⇒ 必然越界，负向对照因此**可判定地变红**。
   */
  const line = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const footer = document.querySelector('.status');
      if (footer === null) return JSON.stringify({ reason: 'no-footer' });
      const cs = getComputedStyle(footer);
      const bound = Number.parseFloat(cs.fontSize) * 1.6 + Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) + 1;
      return JSON.stringify({ height: footer.offsetHeight, bound: Math.ceil(bound) });
    })()`,
    returnByValue: true,
  });
  const single = JSON.parse(line.result.value);
  if (single.reason === 'no-footer') {
    problems.push(`[布局稳态·${label}] 找不到状态栏（.status）`);
  } else if (single.height > single.bound) {
    problems.push(
      `[布局稳态·${label}] 状态栏不是单行：高 ${String(single.height)} px > 单行上界 ${String(single.bound)} px（P-43 的自激环就是靠"换行 ⇒ 变高"驱动的）`,
    );
  }
  /**
   * **窗格客户区必须与"滚动条是否被需要"无关**（P-44，本判据里**确定性可验证**的那一条）。
   *
   * 机制：`pane.clientWidth/clientHeight` 是 `contentWidth`（`max(窗格宽, 内容最右缘…)`，ADR 0007 §15.1）
   * 与滚动范围的**输入**，而"滚动条要不要出现"又由**输出**决定 ⇒ `overflow: auto` 下是自引用环。
   *
   * 判据：**把内容缩到不需要滚动**（spacer → 10×10）再量，客户区必须**一字不变**。
   * （第一版判据写错了：它把 `overflow` 换成 `hidden`，那等于**移除**滚动条 ⇒ 客户区当然会变——
   *  负向对照当场把我自己的错判据抓了出来。）**负向对照**：`auto` 下缩内容后滚动条消失 ⇒ 客户区必变 ⇒ 判据有判别力。
   */
  const boxProbe = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const pane = document.getElementById('chart-pane');
      if (pane === null) return JSON.stringify({ reason: 'no-pane' });
      const spacer = pane.querySelector('.chart-spacer');
      if (spacer === null) return JSON.stringify({ reason: 'no-spacer' });
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const read = () => [pane.clientWidth, pane.clientHeight].join('x');
      const withContent = read();
      const originalWidth = spacer.style.width;
      const originalHeight = spacer.style.height;
      spacer.style.width = '10px';
      spacer.style.height = '10px';
      await frame();
      await frame();
      const withoutContent = read();
      spacer.style.width = originalWidth;
      spacer.style.height = originalHeight;
      await frame();
      await frame();
      return JSON.stringify({ withContent, withoutContent, restored: read() === withContent });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const box = JSON.parse(boxProbe.result.value);
  if (box.reason !== undefined) {
    problems.push(`[布局稳态·${label}] 找不到图表窗格 / 它的 spacer（${String(box.reason)}）`);
  } else if (box.withContent !== box.withoutContent) {
    problems.push(
      `[布局稳态·${label}] 窗格客户区**随"滚动条是否被需要"而变**（${String(box.withContent)} → ${String(box.withoutContent)}）：` +
        '这是 P-44 的自引用环（`contentWidth = max(窗格宽, …)` 的输入就是 `clientWidth`）；窗格应常驻滚动条（`overflow: scroll`）',
    );
  }
  if (box.restored === false) problems.push(`[布局稳态·${label}] 探针未能还原 spacer 尺寸（测量污染了页面）`);
  return problems;
}

/**
 * **真的点一次导出**（G7 端到端）：SVG / PNG / PPTX 三条路径各点一次，检查落盘文件。
 *
 * 为什么必须有这一条：几何与 OOXML 的判据都在 Node 侧（`render-core` / `pptx-renderer` 的 spec），
 * 但"浏览器里点下去到底能不能出文件"是**另一件事**——PNG 要走 `Image`+`canvas` 光栅化，
 * PPTX 要在浏览器里动态加载 `pptxgenjs`（Vite 的 `browser` 字段会把 `https`/`image-size` 替空）。
 * 这两条路径在 Node 测试里结构上覆盖不到（P-9/P-17 的分层口径）。
 */
async function exerciseExports(cdp, downloadDir = null, formats = ['svg', 'png', 'pptx']) {
  const problems = [];
  const dir = downloadDir ?? join(repoRoot, 'tmp', 'smoke-downloads', String(Date.now()));
  mkdirSync(dir, { recursive: true });
  /**
   * 下载行为（`Browser.setDownloadBehavior`）**必须在 `Page.navigate` 之前设**：
   * 导航会把 target 换掉，之后再设的下载目录对当前页面不生效（实测：导出点下去没有任何文件）。
   * 本函数因此接受一个**调用方已经设过**下载目录（`prepareDownloads`）的页面——
   * 这里只重设一次作为兜底（同一目录，幂等）。
   */
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

  const setAndRun = async (format, scale) => {
    // 直接驱动真实控件（与用户操作同一条路：改 select → 触发 change → 点导出按钮）
    await cdp.call('Runtime.evaluate', {
      expression: [
        `(() => {`,
        `  const select = document.querySelector('[data-export-format]');`,
        `  if (!select) return 'no-select';`,
        `  select.value = ${JSON.stringify(format)};`,
        `  select.dispatchEvent(new Event('change', { bubbles: true }));`,
        `  return 'ok';`,
        `})()`,
      ].join('\n'),
      returnByValue: true,
    });
    await new Promise((settle) => setTimeout(settle, 400));
    if (format === 'png') {
      // PNG 倍率控件**只在 `format === 'png'` 时存在**（`v-if`）⇒ 必须在切完格式之后再改它。
      await cdp.call('Runtime.evaluate', {
        expression: [
          `(() => {`,
          `  const scale = document.querySelector('[data-export-scale]');`,
          `  if (!scale) return 'no-scale';`,
          `  scale.value = ${JSON.stringify(String(scale))};`,
          `  scale.dispatchEvent(new Event('change', { bubbles: true }));`,
          `  return 'ok';`,
          `})()`,
        ].join('\n'),
        returnByValue: true,
      });
      await new Promise((settle) => setTimeout(settle, 300));
    }
    await cdp.call('Runtime.evaluate', {
      expression: `(() => { const btn = document.querySelector('[data-export-run]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()`,
      returnByValue: true,
    });
    await new Promise((settle) => setTimeout(settle, 3_500));
  };

  const files = () => (existsSync(dir) ? readdirSync(dir) : []);
  /** 页面上的提示条：导出失败的原因就在那里（`notice` 是产品自己的失败通道）。 */
  const noticeText = async () => {
    const result = await cdp.call('Runtime.evaluate', {
      expression: `(() => { const node = document.querySelector('.status .notice'); return node ? node.textContent : ''; })()`,
      returnByValue: true,
    });
    return String(result.result.value ?? '');
  };
  const waitFor = async (extension, attempts = 8) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const hit = files().find((name) => name.toLowerCase().endsWith(extension));
      if (hit !== undefined) return hit;
      await new Promise((settle) => setTimeout(settle, 1_000));
    }
    return null;
  };

  // ① SVG
  if (formats.includes('svg')) {
    await setAndRun('svg', 1);
    const svg = await waitFor('.svg');
    if (svg === null) {
      problems.push(`导出 SVG：没有落盘文件（页面提示：${await noticeText()}）`);
    } else {
      const text = readFileSync(join(dir, svg), 'utf8');
      if (!text.includes('<svg')) problems.push('导出 SVG：内容里没有 <svg>');
      if (text.length < 2_000) problems.push(`导出 SVG：内容过小（${String(text.length)} 字符）`);
      if (/handle|connect-point|transparent/.test(text)) problems.push('导出 SVG：含交互图元（手柄/连接点/热区）');
    }
  }

  // ② PNG（1× 就够：验的是"光栅化这条路通"）
  if (formats.includes('png')) {
    await setAndRun('png', 1);
    const png = await waitFor('.png');
    if (png === null) {
      problems.push(`导出 PNG：没有落盘文件（光栅化失败？页面提示：${await noticeText()}）`);
    } else {
      const buffer = readFileSync(join(dir, png));
      const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
      if (!isPng) problems.push('导出 PNG：文件不是 PNG（magic 不符）');
      if (buffer.length < 1_000) problems.push(`导出 PNG：文件过小（${String(buffer.length)} 字节）`);
    }
  }

  // ③ PPTX（浏览器里动态加载 pptxgenjs + 打补丁）
  if (formats.includes('pptx')) {
    await setAndRun('pptx', 1);
    const pptx = await waitFor('.pptx');
    if (pptx === null) {
      problems.push(`导出 PPTX：没有落盘文件（浏览器侧 pptxgenjs 路径失败？页面提示：${await noticeText()}）`);
    } else {
      const buffer = readFileSync(join(dir, pptx));
      if (!(buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b)) {
        problems.push('导出 PPTX：文件不是 zip（magic 不符）');
      }
      if (buffer.length < 5_000) problems.push(`导出 PPTX：文件过小（${String(buffer.length)} 字节）`);
    }
  }

  return { problems, dir };
}

/**
 * **G8 ①：两级刻度 + 悬停行高亮 + 表头两行**（P-46；打包产物上真的读 DOM）。
 *
 * ## 为什么这些判据必须在这里
 *
 * "刻度画成了两行""指针所在行有浅色底"是 **DOM 事实**（SVG 文本盒的竖向中心、
 * `getComputedStyle` 的底色），按 [P-40](../../docs/00-baseline/裁决R39.md) 的两条通道口径，
 * 这类事实的**门禁侧**就在 `smoke:build`（记录制侧是 `measure-render.mjs --g8`）。
 *
 * ## 三条对照缺一不可
 *
 * 1. **未悬停**：`.hover-row` 必须不存在（否则"高亮"是常亮装饰）；
 * 2. **悬停第 1 行 vs 第 3 行**：`.hover-row` 的竖向范围必须**跟着指针走**——
 *    只读一次无法区分"跟着指针"与"画了一条固定带"；
 * 3. **左表那一行的底色**必须真的变了——**两条路径各测一次**：
 *    ① 指针落在**左表**上（纯 CSS `:hover`，CDP 的 `Input.dispatchMouseEvent` 会真的产生命中）；
 *    ② 指针落在**图表**上（`.row.hovered`，跟着 `hoverTaskId` 走，G8 复验第 ⑦ 条）。
 */
async function probeG8AxisAndHover(cdp) {
  const problems = [];
  const read = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.result.value;
  };

  const axis = JSON.parse(
    await read(`(() => {
      const texts = [...document.querySelectorAll('.axis-labels text')];
      const measured = texts.map((element) => {
        const rect = element.getBoundingClientRect();
        return { text: (element.textContent || '').trim(), centerY: Math.round((rect.top + rect.bottom) / 2) };
      });
      const ys = [...new Set(measured.map((item) => item.centerY))].sort((a, b) => a - b);
      // **大刻度在上**（G8 复验第 ③ 条）：最小中心 y = 上级行、最大 = 下级行。
      const majorY = ys.length > 0 ? ys[0] : null;
      const minorY = ys.length > 1 ? ys[ys.length - 1] : null;
      const pick = (y) => y === null ? [] : measured.filter((item) => item.centerY === y).map((item) => item.text);
      const header = (selector) => {
        const node = document.querySelector(selector);
        return node === null ? -1 : Math.round(node.getBoundingClientRect().height * 10) / 10;
      };
      const blank = document.querySelector('.table-header .cell-blank');
      const tick = document.querySelector('.axis-tick');
      const chartHeader = document.querySelector('.chart-header');
      return JSON.stringify({
        texts: texts.length,
        minorY, majorY,
        minor: pick(minorY), major: pick(majorY),
        // 上级分段带在屏幕侧拆成两个元素（绘制区正文 + 表头底），取较大者（每个轴元素各一份）。
        majorBands: Math.max(
          document.querySelectorAll('.axis .axis-major-body').length,
          document.querySelectorAll('.axis-header .axis-major-header').length,
        ),
        // **刻度线只属于刻度区**（G8 复验第 ⑤ 条）：短刻度必须整条落在表头带内。
        tick: tick === null ? null : {
          top: Math.round(tick.getBoundingClientRect().top),
          bottom: Math.round(tick.getBoundingClientRect().bottom),
          bandTop: chartHeader === null ? -1 : Math.round(chartHeader.getBoundingClientRect().top),
          bandBottom: chartHeader === null ? -1 : Math.round(chartHeader.getBoundingClientRect().bottom),
        },
        // 背景分层（第 ④ 条）：周末色带 / 月份正文底 / 表头底 三色必须互不相同。
        fills: {
          band: document.querySelector('.axis .axis-band')?.getAttribute('fill') ?? null,
          majorBody: document.querySelector('.axis .axis-major-body')?.getAttribute('fill') ?? null,
          majorHeader: document.querySelector('.axis-header .axis-major-header')?.getAttribute('fill') ?? null,
          hover: document.querySelector('.hover-row')?.getAttribute('fill') ?? null,
        },
        headerTable: header('.table-header'),
        headerChart: header('.chart-header'),
        blankText: (blank === null ? '(没有第二行)' : (blank.textContent || '').trim()),
      });
    })()`),
  );

  if (axis.texts === 0) problems.push('[G8 刻度] 表头带里一条刻度文本都没有');
  if (axis.majorY === null) problems.push('[G8 刻度] 刻度只有一行（两级刻度未生效）');
  if (axis.majorBands === 0) problems.push('[G8 刻度] 没有上级分段带（.axis-major-body / .axis-major-header）');
  // 上级标签随档位：默认日档 ⇒ 上级 `YYYY-MM`、下级 `DD`。
  if (!axis.minor.every((text) => /^\d{2}$/.test(text))) {
    problems.push(`[G8 刻度] 日档下级（下方那一行）标签不是 DD：${axis.minor.slice(0, 4).join('/')}`);
  }
  if (!axis.major.every((text) => /^\d{4}-\d{2}$/.test(text))) {
    problems.push(`[G8 刻度] 日档上级（上方那一行）标签不是 YYYY-MM：${axis.major.slice(0, 4).join('/')}`);
  }
  // **行序**：上级那一行的文本盒中心必须**小于**下级（大刻度在上，第 ③ 条）。
  if (axis.majorY !== null && axis.minorY !== null && !(axis.majorY < axis.minorY)) {
    problems.push(`[G8 刻度] 两级刻度行序反了：上级中心 y=${String(axis.majorY)} ≥ 下级 y=${String(axis.minorY)}`);
  }
  // **刻度线只画在表头带内**（第 ⑤ 条）：短刻度的上下端都必须落在表头带的区间里。
  if (axis.tick === null) {
    problems.push('[G8 刻度] 表头带里没有刻度线（.axis-tick）');
  } else if (axis.tick.top < axis.tick.bandTop - 1 || axis.tick.bottom > axis.tick.bandBottom + 1) {
    problems.push(
      `[G8 刻度] 刻度线越出刻度区：刻度 ${String(axis.tick.top)}..${String(axis.tick.bottom)} / 表头带 ${String(axis.tick.bandTop)}..${String(axis.tick.bandBottom)}`,
    );
  }
  // **背景三层必须互不相同**（第 ④ 条：月份底曾与周末带同量级 ⇒ 整块浅色）。
  if (axis.fills.band !== null && axis.fills.majorBody !== null && axis.fills.band === axis.fills.majorBody) {
    problems.push(`[G8 背景] 周末色带与月份正文底同色（${String(axis.fills.band)}）⇒ 周末看不出来`);
  }
  if (axis.fills.majorHeader !== null && axis.fills.majorBody !== null && axis.fills.majorHeader === axis.fills.majorBody) {
    problems.push('[G8 背景] 月份表头底与正文底同色 ⇒ 上级分段看不出来');
  }
  if (axis.headerTable !== axis.headerChart) {
    problems.push(`[G8 刻度] 两栏表头外高不等：左表 ${String(axis.headerTable)} px / 图表 ${String(axis.headerChart)} px`);
  }
  if (axis.blankText !== '') {
    problems.push(`[G8 刻度] 左表表头第二行不是留白："${String(axis.blankText)}"`);
  }

  /**
   * 把指针放到第 N 个**可见**行的条体上（真实鼠标事件 ⇒ `mousemove` 真的发生）。
   *
   * "可见"是必需的：窗格横向滚到最右之后，靠左的条形会滚出视口，
   * 这时若还去点它，鼠标事件落在窗格之外 ⇒ `mousemove` 不发生 ⇒ 行带不出现，
   * 而那是**探针的错**、不是产品的（本轮就踩到过一次：`向右滚动后读不到行带`）。
   * 因此候选行必须**整条都在窗格可见矩形内**。
   */
  const hoverBar = async (index) => {
    const target = JSON.parse(
      await read(`(() => {
        const pane = document.getElementById('chart-pane');
        const svgRows = [...document.querySelectorAll('.rows > g[data-task-id]')];
        if (!pane) return JSON.stringify({ ok: false });
        const paneBox = pane.getBoundingClientRect();
        const usable = svgRows.filter((row) => {
          const bar = row.querySelector('rect.bar') || row.querySelector('polygon.milestone');
          if (!bar) return false;
          const box = bar.getBoundingClientRect();
          const x = box.left + Math.min(6, box.width / 2);
          const y = box.top + box.height / 2;
          return x >= paneBox.left && x <= paneBox.right && y >= paneBox.top && y <= paneBox.bottom;
        });
        const row = usable[${String(index)}] || usable[0];
        if (!row) return JSON.stringify({ ok: false });
        const bar = row.querySelector('rect.bar') || row.querySelector('polygon.milestone');
        const barBox = bar.getBoundingClientRect();
        return JSON.stringify({
          ok: true,
          x: barBox.left + Math.min(6, barBox.width / 2),
          y: barBox.top + barBox.height / 2,
          taskId: row.getAttribute('data-task-id'),
        });
      })()`),
    );
    if (!target.ok) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
       
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
       
      await new Promise((settle) => setTimeout(settle, 120));
    }
    const reading = JSON.parse(
      await read(`(() => {
        const hoverNodes = [...document.querySelectorAll('.hover-row')];
        const first = hoverNodes[0] || null;
        const box = first === null ? null : first.getBoundingClientRect();
        return JSON.stringify({
          svgHoverRows: hoverNodes.length,
          svgTop: box === null ? null : Math.round(box.top * 10) / 10,
          svgBottom: box === null ? null : Math.round(box.bottom * 10) / 10,
          svgLeft: box === null ? null : Math.round(box.left * 10) / 10,
          svgRight: box === null ? null : Math.round(box.right * 10) / 10,
          svgFill: first === null ? '' : first.getAttribute('fill'),
        });
      })()`),
    );
    return { ...reading, taskId: target.taskId, pointerY: target.y };
  };

  /**
   * **左表侧那半**：指针必须**物理落在左表那一行上**，`:hover` 才会命中。
   *
   * 这一条是 P-46 §2.2 里"两侧不共享判据"的落地形式：图表侧的高亮是 SVG 元素（跟着指针走、
   * 计入元素预算），左表侧是纯 CSS（只有指针真的在左表上才生效）——**不能**用一次悬停同时断言两侧。
   */
  const hoverTableRow = async (index) => {
    const target = JSON.parse(
      await read(`(() => {
        const rows = [...document.querySelectorAll('.table-body .row-block .row[data-task-id]')];
        const row = rows[${String(index)}];
        if (!row) return JSON.stringify({ ok: false });
        const box = row.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: box.left + 12, y: box.top + box.height / 2, taskId: row.getAttribute('data-task-id') });
      })()`),
    );
    if (!target.ok) return null;
    // 先挪开再回来：指针"已经在那一行上"时浏览器不会再派发一次进入事件（实测会读不到 :hover）。
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y - 200, button: 'none' });
    await new Promise((settle) => setTimeout(settle, 120));
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
    await new Promise((settle) => setTimeout(settle, 250));
    const reading = JSON.parse(
      await read(`(() => {
        const rows = [...document.querySelectorAll('.table-body .row-block .row[data-task-id]')];
        const row = rows.find((item) => item.getAttribute('data-task-id') === ${JSON.stringify(target.taskId)}) || null;
        const others = rows
          .filter((item) => item.getAttribute('data-task-id') !== ${JSON.stringify(target.taskId)})
          .map((item) => getComputedStyle(item).backgroundColor);
        return JSON.stringify({
          tableBackground: row === null ? '' : getComputedStyle(row).backgroundColor,
          hovered: row === null ? false : row.matches(':hover'),
          otherBackgrounds: [...new Set(others)],
          error: window.__GANTTPILOT_ERROR__ ?? null,
        });
      })()`),
    );
    return { ...reading, taskId: target.taskId };
  };

  const clearPointer = async () => {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' });
    await new Promise((settle) => setTimeout(settle, 250));
    return JSON.parse(
      await read(`JSON.stringify({
        hoverRows: document.querySelectorAll('.hover-row').length,
        hoveredTableRows: document.querySelectorAll('.table-body .row-block .row[data-task-id]:hover').length,
      })`),
    );
  };

  const idle = await clearPointer();
  if (idle.hoverRows !== 0) problems.push(`[G8 悬停] 未悬停时已有 ${String(idle.hoverRows)} 个 .hover-row（高亮必须按需）`);
  if (idle.hoveredTableRows !== 0) problems.push('[G8 悬停] 未悬停时左表已有行处于 :hover');

  const first = await hoverBar(0);
  const third = await hoverBar(2);
  if (first === null || third === null) {
    problems.push('[G8 悬停] 图表侧找不到可悬停的渲染行（SVG 行或它的条体）');
  } else {
    if (first.svgHoverRows !== 1) problems.push(`[G8 悬停] 悬停第 1 行时 .hover-row 有 ${String(first.svgHoverRows)} 个（期望 1）`);
    if (third.svgHoverRows !== 1) problems.push(`[G8 悬停] 悬停第 3 行时 .hover-row 有 ${String(third.svgHoverRows)} 个（期望 1）`);
    // **跟着指针走**：两个位置的竖向范围必须不同（固定带会得到同一个值）。
    if (first.svgTop !== null && third.svgTop !== null && Math.abs(first.svgTop - third.svgTop) < 10) {
      problems.push(
        `[G8 悬停] 悬停第 1/3 行的行带几乎同高（${String(first.svgTop)} / ${String(third.svgTop)}）——它没有跟着指针走`,
      );
    }
    // 行带必须**只有一行高**（放大成整幅就变成"整页变色"，那同样是错的）。
    if (first.svgTop !== null && first.svgBottom !== null && first.svgBottom - first.svgTop > 40) {
      problems.push(`[G8 悬停] 行带高 ${String(first.svgBottom - first.svgTop)} px（远超一个行高 24 px）`);
    }
    if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
      console.log(
        `[smoke] G8 图表侧：刻度 ${String(axis.texts)} 条（上级 ${String(axis.major.length)} / 下级 ${String(axis.minor.length)}）、` +
          `分段带 ${String(axis.majorBands)} 个、表头 ${String(axis.headerTable)}/${String(axis.headerChart)} px；` +
          `悬停行带 ${String(first.svgTop)} → ${String(third.svgTop)}（fill ${String(first.svgFill)}）`,
      );
    }
  }

  // 左表侧（纯 CSS）：指针落在**左表**上时那一行必须变色，别的行不变。
  const tableOn = await hoverTableRow(3);
  if (tableOn === null) {
    problems.push('[G8 悬停] 找不到左表的第 4 行（无法验证左表侧高亮）');
  } else {
    if (tableOn.hovered !== true) problems.push('[G8 悬停] 左表那一行没有进入 :hover（指针未命中）');
    const value = String(tableOn.tableBackground);
    if (value === '' || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') {
      problems.push(`[G8 悬停] 左表被悬停的行没有底色（${value || '空'}）——纯 CSS :hover 未生效`);
    }
    if (tableOn.otherBackgrounds.includes(value)) {
      problems.push('[G8 悬停] 左表"别的行"底色与悬停行相同——高亮没有限定在指针所在行');
    }
    /**
     * **跨栏一致（图表 → 左表）**（G8 复验第 ⑦ 条）：指针移到**图表**上时，左表**对应那一行**必须也带上
     * 高亮底色（`.row.hovered`，跟着图表指针走），而**别的行**不变。
     *
     * 这与上面那条"指针在左表上"是**两条不同的路径**，因此要分别断言：
     * ① `.row:hover` 只在指针物理落在左表时生效（上面那条）；
     * ② `.row.hovered` 跟着图表的 `hoverTaskId` 走（这条）。
     */
    const chartAgain = await hoverBar(3);
    if (chartAgain === null) {
      problems.push('[G8 悬停] 无法把指针移到图表上（跨栏一致无法验证）');
    } else {
      const after = JSON.parse(await read(`(() => {
        const rows = [...document.querySelectorAll('.table-body .row-block .row[data-task-id]')];
        const row = rows.find((item) => item.getAttribute('data-task-id') === ${JSON.stringify(tableOn.taskId)}) || null;
        const other = rows.find((item) => item.getAttribute('data-task-id') !== ${JSON.stringify(tableOn.taskId)}) || null;
        return JSON.stringify({
          bg: row === null ? '' : getComputedStyle(row).backgroundColor,
          hovered: row === null ? false : row.classList.contains('hovered'),
          otherBg: other === null ? '' : getComputedStyle(other).backgroundColor,
        });
      })()`));
      if (after.hovered !== true) {
        problems.push('[G8 悬停] 指针在图表上时，左表对应行没有 `.hovered`（跨两栏的高亮没有联动）');
      }
      if (String(after.bg) === '' || String(after.bg) === 'rgba(0, 0, 0, 0)' || String(after.bg) === 'transparent') {
        problems.push(`[G8 悬停] 指针在图表上时，左表对应行没有底色（${String(after.bg) || '空'}）`);
      }
      if (String(after.otherBg) === String(after.bg)) {
        problems.push('[G8 悬停] 跨栏高亮没有限定在对应那一行（别的行也同色）');
      }
      if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
        console.log(`[smoke] G8 跨栏：图表悬停 → 左表 ${tableOn.taskId} 底色 ${String(after.bg)}（别的行 ${String(after.otherBg)}）`);
      }
    }
    if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
      console.log(`[smoke] G8 左表侧：${tableOn.taskId} 底色 ${value}（未悬停值集合 ${tableOn.otherBackgrounds.join(' / ')}）`);
    }

    /**
     * **跨栏一致（左表 → 图表）**（G8 **第二次**复验第 ② 条）：指针只落在**左表**上时，
     * 右图**对应那一行**也必须出现那条行带。
     *
     * 它与上面那条互为反向，且**实现路径完全不同**：这条靠左表的 `pointerenter` 事件把
     * `hoverTaskId` 推给父级（`setHoverFromTable`），上面那条靠图表的 `mousemove` 坐标反解。
     * 只测一个方向就会漏掉"另一侧根本不在同一条链上"这类缺陷。
     */
    if (tableOn.hovered === true) {
      const mirrored = JSON.parse(await read(`(() => {
        const nodes = [...document.querySelectorAll('.hover-row')];
        const row = [...document.querySelectorAll('.table-body .row-block .row[data-task-id]')]
          .find((item) => item.getAttribute('data-task-id') === ${JSON.stringify(tableOn.taskId)}) || null;
        return JSON.stringify({
          count: nodes.length,
          fill: nodes[0] === undefined ? null : nodes[0].getAttribute('fill'),
          tableBg: row === null ? '' : getComputedStyle(row).backgroundColor,
        });
      })()`));
      if (mirrored.count !== 1) {
        problems.push(
          `[G8 悬停] 指针只落在左表上时，右图没有出现行带（.hover-row 数 = ${String(mirrored.count)}）——左表→图表的联动缺失`,
        );
      }
      if (mirrored.fill === null || mirrored.fill === '') {
        problems.push('[G8 悬停] 左表悬停时右图行带没有填充色');
      }
      if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
        console.log(`[smoke] G8 跨栏（反向）：左表悬停 ${tableOn.taskId} → 右图行带 ${String(mirrored.count)} 个（${String(mirrored.fill)}）`);
      }
    }
  }
  await clearPointer();

  /**
   * **悬停行带必须贯穿整行**（G8 **第二次**复验第 ① 条）。
   *
   * 形态：行带画在内容滚动组里、宽度取**内容宽**。若宽度取的是**视口宽**，
   * 那么"向右滚动后新露出的那段行"就没有高亮 —— 而**这一条在 `scrollLeft = 0` 处看不出来**
   * （首屏那一段照样是亮的），所以必须**先把窗格滚到最右**再断言。
   *
   * 判据（三条，缺一不可）：
   * ① 行带的**盒子右缘必须越过窗格右缘**（说明它铺的比一屏宽）；
   * ② 行带在**滚到最右之后仍然覆盖窗格的整个可见宽度**（左缘 ≤ 窗格左缘、右缘 ≥ 窗格右缘）；
   * ③ 行带的**内容宽必须真的大于视口宽**（否则"整行"与"首屏"不可区分，判据没有判别力）。
   */
  const scrollPaneToRight = async () => {
    await read(`(() => {
      const pane = document.querySelector('#chart-pane');
      if (pane !== null) pane.scrollLeft = pane.scrollWidth;
      return true;
    })()`);
    await new Promise((settle) => setTimeout(settle, 300));
  };
  const bandCoverage = async () => JSON.parse(await read(`(() => {
    const pane = document.querySelector('#chart-pane');
    const band = document.querySelector('.hover-row');
    const svg = document.querySelector('.gantt-svg');
    if (pane === null || band === null || svg === null) return JSON.stringify({ ok: false });
    const p = pane.getBoundingClientRect();
    const b = band.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      paneLeft: p.left, paneRight: p.right,
      svgLeft: s.left, svgRight: s.right, svgWidth: s.width,
      bandLeft: b.left, bandRight: b.right,
      scrollLeft: pane.scrollLeft, scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth,
    });
  })()`));

  /**
   * **"贯穿整行"的判据要拿 SVG 的盒比，不是窗格的盒**：
   * 窗格的 padding box 含**竖向滚动条**（约 15 px），而 SVG 宽 = `view.width`（客户区宽）⇒
   * 行带铺到内容宽之后会被 SVG 自己裁在"窗格右缘 − 滚动条"处。拿窗格右缘比会**差一条滚动条而恒红**
   * （本轮踩到过：带 1569 / 窗格 1584）。正确的不变量是"行带铺满 **SVG 的整个可见宽度**"。
   */
  const coversSvg = (reading) =>
    reading.bandLeft <= reading.svgLeft + 1 && reading.bandRight >= reading.svgRight - 1;

  const beforeScroll = await hoverBar(3);
  if (beforeScroll !== null) {
    const narrow = await bandCoverage();
    if (narrow.ok === true && !(narrow.scrollWidth > narrow.clientWidth + 1)) {
      problems.push('[G8 悬停] 窗格横向不可滚动 ⇒ "贯穿整行"这条判据没有判别力（无法验证）');
    }
  }
  await scrollPaneToRight();
  const afterScroll = await hoverBar(3);
  if (afterScroll !== null) {
    const wide = await bandCoverage();
    if (wide.ok !== true) {
      problems.push('[G8 悬停] 向右滚动后读不到行带/窗格几何');
    } else {
      if (!coversSvg(wide)) {
        problems.push(
          `[G8 悬停] 滚到最右后行带没有铺满可见宽度（带 ${String(Math.round(wide.bandLeft))}..${String(Math.round(wide.bandRight))} / SVG ${String(Math.round(wide.svgLeft))}..${String(Math.round(wide.svgRight))}）⇒ 它只铺了一屏宽，不是整行`,
        );
      }
      if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
        console.log(
          `[smoke] G8 行带宽度：scrollLeft=${String(Math.round(wide.scrollLeft))}/${String(Math.round(wide.scrollWidth - wide.clientWidth))}、带 ${String(Math.round(wide.bandLeft))}..${String(Math.round(wide.bandRight))}、SVG ${String(Math.round(wide.svgLeft))}..${String(Math.round(wide.svgRight))}`,
        );
      }
    }
  }
  await clearPointer();
  return problems;
}

/**
 * **G8 ②：向右拖远不白屏**（P-48 的人工复核入口变成可判定的一条）。
 *
 * 报障的形态是"拖动预览越过调用方日历容量 ⇒ `buildView` 抛 `RangeError` ⇒ Vue 卸载整棵树 ⇒
 * 整页空白"。判据：把 `t1` 向右拖 **120 个工作日格**（远超入参日历容量）、松手之后，
 * 页面结构仍在（`#app` 有子节点、SVG 在、条体在）且 `__GANTTPILOT_ERROR__` 为空。
 */
async function probeRightDragHorizon(cdp) {
  const problems = [];
  const read = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.result.value;
  };
  const target = JSON.parse(
    await read(`(() => {
      const row = document.querySelector('.rows > g[data-task-id="t1"]');
      if (!row) return JSON.stringify({ ok: false, reason: '演示计划里找不到 t1 的行' });
      const bar = row.querySelector('rect.bar');
      if (!bar) return JSON.stringify({ ok: false, reason: 't1 不是条形（找不到 rect.bar）' });
      const box = bar.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: box.left + Math.min(6, box.width / 2), y: box.top + box.height / 2 });
    })()`),
  );
  if (!target.ok) {
    problems.push(`[G8 地平线] 无法起手势：${String(target.reason)}`);
    return problems;
  }
  const steps = 24;
  const totalDx = 120 * 24; // 120 个工作日格（日档 24 px/天）
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= steps; step += 1) {
     
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x + (totalDx * step) / steps,
      y: target.y,
      button: 'left',
      buttons: 1,
    });
     
    await new Promise((settle) => setTimeout(settle, 16));
  }
  const during = JSON.parse(
    await read(`JSON.stringify({
      error: window.__GANTTPILOT_ERROR__ ?? null,
      svg: document.querySelectorAll('.gantt-svg').length,
      bars: document.querySelectorAll('rect.bar').length,
    })`),
  );
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x + totalDx,
    y: target.y,
    button: 'left',
    clickCount: 1,
    buttons: 0,
  });
  await new Promise((settle) => setTimeout(settle, 400));
  const after = JSON.parse(
    await read(`JSON.stringify({
      error: window.__GANTTPILOT_ERROR__ ?? null,
      appChildren: document.getElementById('app')?.childElementCount ?? 0,
      svg: document.querySelectorAll('.gantt-svg').length,
      bars: document.querySelectorAll('rect.bar').length,
      status: (document.querySelector('.status') || {}).textContent || null,
    })`),
  );
  if (during.error !== null) problems.push(`[G8 地平线] 拖动期出现应用级错误（白屏形态）：${String(during.error)}`);
  if (during.svg === 0 || during.bars === 0) {
    problems.push(`[G8 地平线] 拖动期页面结构被卸载（svg ${String(during.svg)}、条体 ${String(during.bars)}）`);
  }
  if (after.error !== null) problems.push(`[G8 地平线] 松手后仍有应用级错误：${String(after.error)}`);
  if (after.appChildren === 0 || after.svg === 0 || after.bars === 0) {
    problems.push(
      `[G8 地平线] 向右拖 120 个工作日后页面不再完整（#app 子节点 ${String(after.appChildren)}、svg ${String(after.svg)}、条体 ${String(after.bars)}）`,
    );
  }
  if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
    console.log(`[smoke] G8 地平线：拖动期 error=${String(during.error)}、松手后条体 ${String(after.bars)} 个`);
  }
  return problems;
}

/**
 * **G8 ③：模板下载 → 回导**（P-46；ADR 0006 附录 §1 的打包产物那半）。
 *
 * 判据链：点「模板下载」→ 文件**真的落盘** → 页签集合与顺序正确 →
 * **用应用自己的导入入口把它读回来**（任务数与文档计数一致、诊断里 **error 0**）。
 * "模板与协议随时对齐"因此是可判定的，而不是靠人记得同步。
 */
async function probeTemplateDownload(cdp, repoRootPath, downloadDir = null) {
  const problems = [];
  const dir = downloadDir ?? join(repoRootPath, 'tmp', 'smoke-downloads', `template-${String(Date.now())}`);
  mkdirSync(dir, { recursive: true });
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  const run = await cdp.call('Runtime.evaluate', {
    expression: `(() => { const btn = document.querySelector('[data-template]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()`,
    returnByValue: true,
  });
  if (run.result.value !== 'clicked') {
    problems.push(`[G8 模板] 工具栏没有「模板下载」按钮（selector [data-template]）：${String(run.result.value)}`);
    return problems;
  }
  let file = null;
  for (let attempt = 0; attempt < 10 && file === null; attempt += 1) {
     
    await new Promise((settle) => setTimeout(settle, 1_000));
    file = (existsSync(dir) ? readdirSync(dir) : []).find((name) => name.toLowerCase().endsWith('.xlsx')) ?? null;
  }
  if (file === null) {
    problems.push('[G8 模板] 点了「模板下载」但没有任何 .xlsx 落盘');
    return problems;
  }
  const bytes = readFileSync(join(dir, file));
  const { names, reason } = sheetNamesOfXlsx(bytes);
  const expected = ['任务', '填写说明与约束', '最小示例'];
  if (names.length === 0) {
    problems.push(`[G8 模板] 页签名解析失败：${reason}`);
  } else if (JSON.stringify(names) !== JSON.stringify(expected)) {
    problems.push(`[G8 模板] 页签集合/顺序不符：${names.join(' / ')}（期望 ${expected.join(' / ')}）`);
  }

  // **回导**：走应用自己的隐藏 file input（真实导入入口）。
  const setFiles = await cdp.call('DOM.getDocument', { depth: -1 });
  const inputQuery = await cdp.call('DOM.querySelector', {
    nodeId: setFiles.root.nodeId,
    selector: 'input[type=file]',
  });
  if (inputQuery.nodeId === 0) {
    problems.push('[G8 模板] 找不到导入用的 file input');
    return problems;
  }
  await cdp.call('DOM.setFileInputFiles', { nodeId: inputQuery.nodeId, files: [join(dir, file)] });
  await new Promise((settle) => setTimeout(settle, 2_500));
  const after = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const status = (document.querySelector('.status') || {}).textContent || '';
      const notice = (document.querySelector('.status .notice') || {}).textContent || '';
      const diagnostics = [...document.querySelectorAll('.diagnostics li')].map((item) => item.textContent || '');
      return JSON.stringify({ status, notice, diagnostics, error: window.__GANTTPILOT_ERROR__ ?? null });
    })()`,
    returnByValue: true,
  });
  const reading = JSON.parse(after.result.value);
  if (reading.error !== null) problems.push(`[G8 模板] 回导出现应用级错误：${String(reading.error)}`);
  const counts = /任务 (\d+) · 依赖 (\d+)/.exec(reading.status ?? '');
  if (counts === null || Number(counts[1]) < 8) {
    problems.push(`[G8 模板] 回导后状态栏没有合理的任务计数：${String(reading.status)}（提示：${String(reading.notice)}）`);
  }
  if (/导入失败/.test(String(reading.notice))) {
    problems.push(`[G8 模板] 回导失败：${String(reading.notice)}`);
  }
  // 诊断项里的 error 级（面板把 severity 写成 CSS class，文案里带诊断码）必须为 0。
  const errorLines = reading.diagnostics.filter((line) => /XLSX_[A-Z_]*/.test(line) && /required_column_missing|REQUIRED_COLUMN_MISSING/i.test(line));
  if (errorLines.length > 0) {
    problems.push(`[G8 模板] 回导后仍有"必需列缺失"类错误：${errorLines.slice(0, 3).join(' | ')}`);
  }
  if (process.env.GANTTPILOT_SMOKE_VERBOSE === '1') {
    console.log(
      `[smoke] G8 模板：${file}（${String(bytes.length)} 字节）、页签 ${names.join('/')}、回导后 ${String(counts?.[0] ?? '(未解析)')}`,
    );
  }
  return problems;
}

/** 把下载目录设成固定路径（`file://` 与"回导刚落盘的模板"两处都需要它）。 */
function prepareDownloadDir(label) {
  const dir = join(repoRoot, 'tmp', 'smoke-downloads', label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * **离线单文件模式**（`--file`；P-49 §3 的判据 2）。
 *
 * 判据链（缺一条，"双击即用"就只是口号）：
 * 1. 以 `file://` 打开**单文件产物** → 界面真的渲染（标题/工具栏/图表窗格/SVG/状态栏）；
 * 2. **三条主链路各走一次**：导入（模板回导）→ 拖动（松手后文档真的变了）→ 导出（SVG 落盘）；
 * 3. **`file://` 下的两条实测登记**（P-49 §3 的探针问题①②）：IndexedDB 可用性、
 *    `Blob` + `<a download>` 是否真落盘——**不得静默假成功**：不可用时 UI 必须明示。
 *
 * 注意：`file://` 与 HTTP 的差别**不在几何**，而在"存储与下载这两个浏览器能力有没有"，
 * 因此这里不重跑记录制性能，也不重跑在线产物的分包断言（那一套只对 `dist/` 有意义）。
 */
async function runFileMode() {
  const problems = [];
  const downloadDir = prepareDownloadDir('offline');
  // `--allow-file-access-from-files`：让 `file://` 页面能读同一目录下的文件（`DOM.setFileInputFiles`
  // 用它把模板文件喂回导入入口）；**不改变任何几何或渲染行为**。
  chromeHandle = spawnChrome(findChrome(), chromeArgs(['--allow-file-access-from-files']));
  const port = await waitForDevToolsPort(chromeHandle.profileDir);
  const url = `file:///${join(offlineRoot, 'index.html').replace(/\\/g, '/')}`;
  const cdp = await connectCdp(port, { preferFileUrl: url.startsWith('file:') });
  // 下载目录：`Page.navigate` **之前**设（导航会换 target）。
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  const { probe, errors } = await smoke(cdp, url);
  if (probe.error !== null) problems.push(`应用级错误（file://）：${String(probe.error)}`);
  if (errors.length > 0) problems.push(`控制台/异常（file://）：${errors.slice(0, 3).join(' | ')}`);
  if (probe.title !== 'GanttPilot') problems.push(`标题不符：${String(probe.title)}`);
  if (probe.brand === null) problems.push('工具栏未渲染（找不到 .brand）');
  if (!probe.pane) problems.push('图表窗格未渲染（找不到 #chart-pane）');
  if (!probe.svg) problems.push('SVG 未渲染（找不到 .gantt-svg）');
  if (!probe.exportUi) problems.push('导出面板未渲染（找不到 [data-export]）');
  // **在线产物的分包断言在这里不适用**（单文件变体必须内联两个库）；但"内联是否真的生效"
  // 由 `scripts/bundle-offline.mjs` 的形状判据守着。

  // ① 导入（回导模板文件 ⇒ 顺带证明"模板下载"在 file:// 下也落盘）。
  problems.push(...(await probeTemplateDownload(cdp, repoRoot, downloadDir)));
  // ② 拖动（真实指针）：松手后文档真的变了，且没有应用级错误。
  const before = await readEvaluate(cdp, `(() => {
    const status = (document.querySelector('.status') || {}).textContent || '';
    const node = [...document.querySelectorAll('.table-body .row-block .row[data-task-id="t1"] .cell')][2] || null;
    return JSON.stringify({ status, startText: (node === null ? '' : node.textContent || '').trim() });
  })()`);
  problems.push(...(await probeDragChangesDocument(cdp, before)));

  // ③ 导出 SVG（真的落盘）。
  const exports = await exerciseExports(cdp, downloadDir);

  // ④ `file://` 的两条实测登记（存储与下载）。
  const storage = await probeIndexedDb(cdp);
  const downloads = exports.dir === downloadDir ? readdirSync(downloadDir) : [];
  cdp.close();

  problems.push(...exports.problems.filter((item) => item.includes('导出 SVG')));
  if (downloads.length === 0) {
    // 这一条**不判红**、只登记：P-49 §3 的判读是"若被拦 ⇒ 改用新标签页另存 + 明示"，
    // 而"落盘失败"是浏览器策略，不是实现缺陷。真正要判的是"UI 有没有如实说"。
    console.log('[smoke] 注意：`file://` 下没有任何导出物落盘（浏览器策略？）——见下面的索引化存储/下载登记');
  }
  console.log(`[smoke] file:// 存储登记：IndexedDB ${storage.idb}；状态栏持久化那一栏 = ${String(probe.persist)}`);
  console.log(`[smoke] file:// 下载登记：导出物 ${downloads.length} 个（${downloads.slice(0, 4).join(' / ') || '无'}）`);

  // **诚实登记**：IndexedDB 不可用时，状态栏必须明示"已停用"，而不是显示"已保存"。
  if (storage.idb === 'unavailable' && /已保存/.test(String(probe.persist))) {
    problems.push(
      `[G8 单文件] IndexedDB 在 file:// 下不可用，但状态栏显示"已保存"（${String(probe.persist)}）——静默假成功`,
    );
  }
  if (storage.idb === 'unavailable' && !/停用|不自动保存/.test(String(probe.persist))) {
    problems.push(`[G8 单文件] IndexedDB 不可用时状态栏没有明示停用原因：${String(probe.persist)}`);
  }
  return { problems, url };
}

/** 通用的一次 `Runtime.evaluate`（`--file` 模式的几条判据共用）。 */
async function readEvaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}

/**
 * **`file://` 下的 IndexedDB 探针**（P-49 §3 问题①）。
 *
 * 判读三件事：能开库、能写、能读回。它**不改产品行为**（用一个独立库名），
 * 结论由调用方登记（不可用时要求 UI 明示，见 `runFileMode`）。
 */
async function probeIndexedDb(cdp) {
  const raw = await readEvaluate(cdp, `(async () => {
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
    if (db === null) return JSON.stringify({ idb: 'unavailable' });
    const write = await new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put('ok', 'probe');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (error) { resolve(false); }
    });
    const read = await new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readonly');
        const request = tx.objectStore('kv').get('probe');
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      } catch (error) { resolve(null); }
    });
    return JSON.stringify({ idb: write && read === 'ok' ? 'available' : 'write-failed', read });
  })()`);
  return JSON.parse(raw);
}

/**
 * **拖动真的改变了文档**（`--file` 模式的第 2 条链路）。
 *
 * 判据取"左表「开始」列的文本变了"（来自文档事实，不是视图派生值）：
 * 拖完之后那一段文本必须与拖动前不同 —— 否则"能拖"只是画面在动。
 */
async function probeDragChangesDocument(cdp, before) {
  const problems = [];
  const target = JSON.parse(
    await readEvaluate(cdp, `(() => {
      const row = document.querySelector('.rows > g[data-task-id="t1"]');
      const bar = row === null ? null : row.querySelector('rect.bar');
      if (bar === null) return JSON.stringify({ ok: false });
      const box = bar.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: box.left + Math.min(6, box.width / 2), y: box.top + box.height / 2 });
    })()`),
  );
  if (!target.ok) {
    problems.push('[G8 单文件] 拖动链路：找不到 t1 的条体');
    return problems;
  }
  const dx = 5 * 24; // 5 个工作日（日档 24 px/天）
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= 10; step += 1) {
     
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x + (dx * step) / 10,
      y: target.y,
      button: 'left',
      buttons: 1,
    });
     
    await new Promise((settle) => setTimeout(settle, 20));
  }
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x + dx,
    y: target.y,
    button: 'left',
    clickCount: 1,
    buttons: 0,
  });
  await new Promise((settle) => setTimeout(settle, 500));
  const after = await readEvaluate(cdp, `(() => {
    const node = [...document.querySelectorAll('.table-body .row-block .row[data-task-id="t1"] .cell')][2] || null;
    return JSON.stringify({
      startText: (node === null ? '' : node.textContent || '').trim(),
      error: window.__GANTTPILOT_ERROR__ ?? null,
      bars: document.querySelectorAll('rect.bar').length,
    });
  })()`);
  const reading = JSON.parse(after);
  if (reading.error !== null) problems.push(`[G8 单文件] 拖动后出现应用级错误：${String(reading.error)}`);
  if (reading.bars === 0) problems.push('[G8 单文件] 拖动后条体全部消失（页面被卸载？）');
  if (String(reading.startText) === String(before.startText) || String(reading.startText) === '') {
    problems.push(
      `[G8 单文件] 拖动链路：松手后「开始」列没有变化（前 "${String(before.startText)}" / 后 "${String(reading.startText)}"）`,
    );
  }
  return problems;
}

let serverHandle = null;
let chromeHandle = null;
try {
  if (fileMode) {
    const { problems, url } = await runFileMode();
    if (problems.length > 0) {
      console.error(`[smoke] 离线单文件冒烟未通过（${url}）：`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(`[smoke] 通过（file://）：${url}`);
    }
  } else {
  serverHandle = await startStaticServer(distRoot);
  const url = `http://127.0.0.1:${String(serverHandle.port)}/`;
  chromeHandle = spawnChrome(findChrome(), chromeArgs());
  const port = await waitForDevToolsPort(chromeHandle.profileDir);
  const cdp = await connectCdp(port);
  const { probe, errors } = await smoke(cdp, url);
  /**
   * P-43 的**布局稳态**：首屏一次、**点一次"重置演示数据"之后再一次**
   * （人工复核报的是"重置后持续抖动"，那是最容易复现的一段）。
   */
  const layoutProblems = [];
  layoutProblems.push(...(await probeLayoutStability(cdp, '首屏')));
  const resetClick = await cdp.call('Runtime.evaluate', {
    expression:
      "(() => { const btn = document.querySelector('[data-reset]'); if (!btn) return 'no-button'; btn.click(); return 'clicked'; })()",
    returnByValue: true,
  });
  if (resetClick.result.value !== 'clicked') {
    layoutProblems.push(`找不到「重置演示数据」按钮（selector [data-reset]）：${String(resetClick.result.value)}`);
  } else {
    await new Promise((settle) => setTimeout(settle, 500));
    layoutProblems.push(...(await probeLayoutStability(cdp, '重置后')));
  }
  const exports = await exerciseExports(cdp);
  /**
   * **G8 的三组判据**（P-46/P-48）：
   * ① 两级刻度 + 悬停行高亮 + 表头两行；② 向右拖远不白屏；③ 模板下载 → 回导。
   *
   * 顺序刻意放在导出之后：模板与拖动的判据都会**改变文档/下载目录外的状态**，
   * 而导出那三条依赖"页面上还是演示计划"这个前提（导出物会落进同一个下载目录）。
   */
  const g8Problems = [];
  g8Problems.push(...(await probeG8AxisAndHover(cdp)));
  g8Problems.push(...(await probeRightDragHorizon(cdp)));
  g8Problems.push(...(await probeTemplateDownload(cdp, repoRoot)));
  cdp.close();

  const problems = [];
  problems.push(...layoutProblems);
  problems.push(...g8Problems);
  // G7：导出库的分包纪律（首屏主 chunk 不得含 pptxgenjs；且某个 chunk 里必须真有它）
  problems.push(...checkExportChunking());
  // G7：三条导出路径端到端（真的点、真的落盘）
  problems.push(...exports.problems);
  if (probe.error !== null) problems.push(`应用级错误：${String(probe.error)}`);
  if (errors.length > 0) problems.push(`控制台/异常：${errors.slice(0, 3).join(' | ')}`);
  if (probe.title !== 'GanttPilot') problems.push(`标题不符：${String(probe.title)}`);
  if (probe.brand === null) problems.push('工具栏未渲染（找不到 .brand）');
  if (!probe.pane) problems.push('图表窗格未渲染（找不到 #chart-pane）');
  if (!probe.svg) problems.push('SVG 未渲染（找不到 .gantt-svg）');
  if (!probe.exportUi) problems.push('导出面板未渲染（找不到 [data-export]）');
  if (!probe.exportRun) problems.push('导出按钮未渲染（找不到 [data-export-run]）');
  if (typeof probe.persist !== 'string' || !probe.persist.startsWith('持久化：')) {
    problems.push(`状态栏缺少持久化那一栏：${String(probe.persist)}`);
  }
  // 演示口径（裁决 P-34）：默认文档必须是**小型演示计划**，而不是 1,000 任务夹具——
  // 这是唯一能抓到"产物仍然开在大夹具上"的门禁。上界编码的是"单页 16:9 可读"这个口径本身，
  // 具体数字（15 行 / 14 条依赖）的唯一权威陈述在 `render-core/src/demoPlan.spec.ts`。
  const counts = /任务 (\d+) · 依赖 (\d+)/.exec(probe.status ?? '');
  if (counts === null) {
    problems.push(`状态栏缺少任务/依赖计数：${String(probe.status)}`);
  } else {
    const tasks = Number(counts[1]);
    const links = Number(counts[2]);
    if (tasks < 8 || tasks > 40) {
      problems.push(`演示口径不是小型计划：任务 ${String(tasks)} 条（期望 8–40）`);
    }
    if (links < 1) {
      problems.push(`演示计划没有依赖：${String(links)} 条`);
    }
  }

  if (problems.length > 0) {
    console.error(`[smoke] 打包产物冒烟未通过（${url}）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`[smoke] 通过：${url}`);
    console.log(`  持久化：${String(probe.persist)}`);
    console.log(`  导出端到端：SVG / PNG / PPTX 三条路径均已落盘（目录 ${exports.dir}）`);
    console.log(`  演示口径：${counts?.[0] ?? '（未解析）'}`);
  }
  }
} catch (error) {
  console.error(`[smoke] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // 收尾走 `chrome-harness.mjs` 的三条闸：正常路径是协议级 `Browser.close`（不杀进程），
  // 只有它超时才按**我们自己的 PID 树**兜底——绝不按名字匹配 chrome.exe。
  // profile 目录跑完删掉：`tmp/` 虽已 gitignore，但"只增不减"是运行卫生问题；形状由白名单定死。
  const outcome = await closeChromeSession({
    profileDir: chromeHandle?.profileDir ?? null,
    pid: chromeHandle?.child.pid,
    removeProfile: true,
  });
  if (outcome.closedBy === 'pid-tree') console.log('[smoke] 协议级关闭未生效，已按 PID 树兜底');
  if (outcome.note !== '') console.log(`[smoke] 收尾说明：${outcome.note}`);
  serverHandle?.server.close();
}
