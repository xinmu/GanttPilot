#!/usr/bin/env node
/**
 * **离线单文件分发的产物生成 + 形状判据**（P-49 §2/§3；G8）。
 *
 * ## 它解决的问题（一句话）
 *
 * 现在的分发方式是"打包产物 + 一个本地 HTTP 服务"（`pnpm preview`），
 * **它把环境要求推给了用户**——没有 Node 或 Python 的人拿到的是一堆打不开的文件。
 * 而"断网可用"（US-4）此前的实现只是"**零后端依赖**"，不是"**不需要网络就能打开**"。
 *
 * ## 三步（第 3 步是判据，进 `pnpm gate`）
 *
 * 1. `pnpm --filter @ganttpilot/web build:offline`（`apps/web/bundle.config.ts`：
 *    单个 chunk + 内联动态导入 + 单文件 CSS）；
 * 2. **内联** `index.html` 里的 `type="module"` 与外链 `<link rel=stylesheet>`：
 *    `file://` 下浏览器按 **CORS 拒绝**加载 ES module（README 里"不要直接打开 `dist/index.html`"
 *    的真因就是这个），因此脚本必须变成**无 `type="module"` 的内联 `<script>`**；
 * 3. **形状判据**（可判定、零依赖）：产物目录里**恰好一个** HTML 文件、
 *    没有任何外部 `assets/` 引用、没有 `type="module"` 的外链。
 *
 * ## 为什么不用现成插件
 *
 * 与 `smoke-build.mjs` 同一条纪律：**零新增依赖**。这里要做的字符串替换只有两处
 * （一个 `<script>`、一个 `<link>`），引入一个单文件打包插件会让"依赖面"多一个长期维护项。
 *
 * 用法：
 *   node scripts/bundle-offline.mjs            # 构建 + 内联 + 判据
 *   node scripts/bundle-offline.mjs --check    # 只跑判据（不重新构建）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(repoRoot, 'apps', 'web');
const distRoot = join(webRoot, 'dist-offline');
/**
 * 单文件产物的文件名 = **`index.html`**（Vite 的产物名）。
 *
 * 为什么不做成 `ganttpilot.html`：用户拿到的是一个**要双击**的文件，`index.html` 在任何
 * 文件管理器/浏览器里都是"打开这个文件夹"的默认落点，改名只会让人多找一步；
 * 而"这是单文件分发"由**目录里只有它一个文件**来保证（判据 ①）——
 * 与在线产物（`dist/`）也天然分开。
 */
const SINGLE_FILE = 'index.html';
const checkOnly = process.argv.includes('--check');

/** 跑一次离线构建（`--check` 时跳过）。 */
function runOfflineBuild() {
  console.log('[offline] 构建单文件变体（apps/web/bundle.config.ts）…');
  const result = spawnSync('pnpm --filter @ganttpilot/web build:offline', {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error !== undefined) {
    console.error(`[offline] 无法执行构建：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[offline] 构建失败（退出码 ${String(result.status)}）。`);
    process.exit(result.status ?? 1);
  }
}

/**
 * 把 `index.html` 变成**自包含**的单文件（返回 HTML 文本 + 被内联的条目清单）。
 *
 * 三处替换：
 * 1. `<script type="module" src="./assets/xxx.js"></script>` → **`<script type="module">…</script>`**
 *    （内容原样内联，**保留 `type="module"`**——见下面"为什么不能降级成 classic script"）；
 * 2. `<link rel="stylesheet" href="./assets/xxx.css">` → `<style>…</style>`；
 * 3. `modulepreload` 的 `<link>` 一律删除（内联之后没有可预载的东西）。
 *
 * ## 为什么不能降级成 classic `<script>`
 *
 * 实测（`tmp/fileurl-exp` 的四组对照，2026-10-05）：
 *
 * | 形态 | 结果 |
 * |---|---|
 * | `<script type="module">` 内联 + 外部 chunk 的 `import('./chunk.mjs')` | ✅ 两者都成功 |
 * | `blob:` URL 的 module + 内联的嵌套 `blob:` 子模块 | ✅ 两者都成功 |
 * | classic `<script>`（去掉 `type="module"`） | ❌ `import.meta` **语法错误** —— 产物脚本必然报错 |
 * | `data:` URL 的 module（`src="data:text/javascript,…"`） | ❌ 相对导入解析不了 |
 *
 * 结论：**唯一可靠的内联形态是"原样内联 + 保留 `type="module"`"**。早期计划里"去掉
 * `type="module"`"的写法会让产物在 `file://` 下直接白屏（`SyntaxError: Cannot use 'import.meta'
 * outside a module`），已被实测否掉。
 *
 * 顺带订正一条**历史说法**：README 里"`file://` 下浏览器拒绝加载 ES module"这条
 * 对**外链** module 不成立（实测外链 module 与其相对 `import()` 都能加载）；
 * 单文件分发的真需求是"**只有一个文件**"，不是"CORS 逼着内联"。
 * 该订正会写进 README 的对应段落。
 */
function inlineIntoHtml(html) {
  const inlined = [];
  let out = html;

  out = out.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '');

  /**
   * **外链 module 脚本 → 内联 module 脚本**。
   *
   * 属性顺序由 Vite 决定（实测是 `type="module" crossorigin src="…"`），因此用
   * "*`src` 之前的属性 / `src` 本身 / 之后的属性*"三段来切——**注入式防护**：
   * 不假设 `type` 与 `src` 谁在前，也不假设它们之间有几个属性。
   * 匹配到之后**原样保留其余属性**（只去掉 `src`），因为 `type="module"` 必须留下（见文件头）。
   */
  out = out.replace(
    /<script([^>]*?)\ssrc="([^"]+)"([^>]*)><\/script>/g,
    (_match, before, src, after) => {
      const path = join(distRoot, String(src).replace(/^\.?\//, ''));
      if (!existsSync(path)) return _match;
      inlined.push(String(src));
      // 内联脚本里出现 `</script>` 会提前结束标签；JS 里它只在字符串里合法，
      // 转义成 `<\/script>` 对 JS 语义无影响（与 HTML 规范的建议一致）。
      const body = readFileSync(path, 'utf8').replace(/<\/script>/gi, '<\\/script>');
      return `<script${String(before)}${String(after)}>${body}</script>`;
    },
  );

  out = out.replace(/<link[^>]*rel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g, (_match, href) => {
    const path = join(distRoot, String(href).replace(/^\.?\//, ''));
    if (!existsSync(path)) return _match;
    inlined.push(String(href));
    return `<style>${readFileSync(path, 'utf8')}</style>`;
  });

  return { html: out, inlined };
}

/**
 * **形状判据**（P-49 §3 的判据 1，纯字符串/文件系统判定，**可进门禁**）。
 *
 * 三条断言都必须能**独立判红**：只有一条"恰好一个文件"是恒真式（没人建别的文件它就成立），
 * 因此另外两条盯的是"外链有没有真的被内联掉"。
 */
function checkShape() {
  const problems = [];
  const singlePath = join(distRoot, SINGLE_FILE);
  if (!existsSync(singlePath)) {
    return { problems: [`找不到单文件产物 ${singlePath}（先跑一次构建）`], bytes: 0 };
  }
  const html = readFileSync(singlePath, 'utf8');
  if (/<script[^>]*\bsrc="/.test(html)) problems.push('产物里仍有外链 `<script src=...>`');
  if (/<link[^>]*rel="stylesheet"/.test(html)) problems.push('产物里仍有外链样式表 `<link rel="stylesheet">');
  if (/\.\/assets\//.test(html) || /\bassets\//.test(html)) problems.push('产物里仍引用 `assets/`');
  if (!/<script[^>]*\btype="module"[^>]*>[\s\S]{2000,}<\/script>/.test(html)) {
    problems.push('没有内联的 `type="module"` 脚本（或它为空/过短）——见 `inlineIntoHtml` 的形态说明');
  }
  if (!/<style>[\s\S]+<\/style>/.test(html)) problems.push('没有内联样式（`cssCodeSplit: false` 没生效？）');

  // ② **恰好一个 HTML 文件**（P-49 判据 1 的字面口径）+ **除了它自己没有任何文件**。
  const files = readdirSync(distRoot).filter((name) => statSync(join(distRoot, name)).isFile());
  const htmlFiles = files.filter((name) => name.toLowerCase().endsWith('.html'));
  if (htmlFiles.length !== 1) {
    problems.push(`产物目录里的 HTML 文件不是恰好 1 个：${htmlFiles.join(' / ')}（${String(htmlFiles.length)} 个）`);
  }
  if (files.length !== 1) {
    problems.push(`产物目录里除单文件外还有东西：${files.filter((name) => name !== SINGLE_FILE).join(' / ')}`);
  }
  const subdirs = readdirSync(distRoot).filter((name) => statSync(join(distRoot, name)).isDirectory());
  if (subdirs.length > 0) {
    problems.push(`产物目录里还有子目录（应为空）：${subdirs.join(' / ')}`);
  }

  // ③ 体积如实登记（**不设门禁**：P-49 §3 的探针问题③明确"超标不阻塞发布，但要登记"）。
  const bytes = statSync(singlePath).size;
  return { problems, bytes };
}

if (!checkOnly) {
  runOfflineBuild();

  const indexPath = join(distRoot, 'index.html');
  if (!existsSync(indexPath)) {
    console.error(`[offline] 构建后仍找不到 ${indexPath}`);
    process.exit(1);
  }
  const { html, inlined } = inlineIntoHtml(readFileSync(indexPath, 'utf8'));
  if (inlined.length === 0) {
    console.error('[offline] 没有内联到任何东西（index.html 的外链形状变了？）');
    process.exit(1);
  }

  // **原地覆盖** `index.html`（内联后它就是那份单文件产物），并删掉 `assets/`：
  // 判据要求"目录里恰好一个文件"，而单文件的意义正是"只有一个文件"。
  writeFileSync(indexPath, html, 'utf8');
  const assetsDir = join(distRoot, 'assets');
  if (existsSync(assetsDir)) {
    rmSync(assetsDir, { recursive: true, force: true });
  }
  console.log(`[offline] 已内联 ${String(inlined.length)} 个条目 → ${SINGLE_FILE}`);
}

const { problems, bytes } = checkShape();
if (problems.length > 0) {
  console.error('[offline] 单文件产物的形状判据未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const kb = (bytes / 1024).toFixed(1);
console.log(`[offline] 形状判据通过：单文件 ${SINGLE_FILE} = ${kb} KB（体积只登记、不设门禁——P-49 §3 问题③）`);
