#!/usr/bin/env node
/**
 * **模板 A 导出（记录制脚本）**：演示计划 → `renderTemplateA` → `tmp/exports/*.pptx` + 指纹。
 *
 * ## 为什么是"记录制"而不是进 `pnpm gate`
 *
 * 产物本身已在 `packages/pptx-renderer` 的 golden 里逐字节钉住（ADR 0010 §9），
 * 进 `pnpm gate` 的那份判据在包内。本脚本服务的是**取证与真机验证**：
 * WPS/PPT 那条链（`scripts/wps-pptx-verify.ps1`）需要一个**可复现、带指纹**的输入文件，
 * 而且必须在报告里写下"我验的到底是哪一份字节"。因此这里打印 sha256 与两次导出的比对结果，
 * 让证据链的下游不必相信"大概是同一份产物"。
 *
 * ## 为什么用 node:crypto 算 sha256（包内却刻意不用）
 *
 * 包是计算层（零 DOM、零平台依赖），所以它的指纹用纯 TS CRC-32；
 * 证据层在 Node 侧跑，可以用强哈希。分工写在 `packages/pptx-renderer/src/fingerprint.ts` 文件头。
 * 但"两次是否逐字节相等"仍用包导出的 `bytesEqual` **直接比字节**——哈希只用来写进报告。
 *
 * ## 为什么动态 import `dist/` 而不是源码
 *
 * 本脚本在仓库外（`scripts/`）运行，不参与包的 TS 编译；走 `dist/` 才是"用户拿到的那份产物"。
 * 但 `dist/` 是构建产物：**缺了就报错退出，不静默回落**（P-12 口径：判据要么真跑，要么别写）。
 *
 * 用法：
 *   node scripts/export-pptx.mjs                       # 默认 --zoom week
 *   node scripts/export-pptx.mjs --zoom day|week|month
 *   node scripts/export-pptx.mjs --out tmp/exports/foo.pptx
 *   node scripts/export-pptx.mjs --degrade             # 降级②：connector 走 custGeom 折线
 *
 * 退出码：0 = 两次导出逐字节相等；1 = 用法错误 / 依赖缺失 / 两次不一致（都打印到 stderr）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 支持的缩放档（与 `ZoomKey` 同口径；写死成白名单是为了让 `--zoom` 打错时立刻失败）。 */
const ZOOMS = ['day', 'week', 'month'];

/** 命令行解析（只认 `--k v` / `--flag`；未知参数直接失败，避免"以为传了其实没传"）。 */
function parseArgs(argv) {
  const out = { zoom: 'week', out: null, degrade: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--zoom') {
      out.zoom = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      out.out = argv[index + 1];
      index += 1;
    } else if (arg === '--degrade') {
      out.degrade = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!ZOOMS.includes(out.zoom)) {
    throw new Error(`--zoom 只能是 ${ZOOMS.join('|')}，收到：${String(out.zoom)}`);
  }
  return out;
}

/**
 * 动态 import 一个 workspace 包的 `dist/` 入口。
 *
 * 这里**先断言文件存在**再 import：`ERR_MODULE_NOT_FOUND` 的默认报错会把人引向"路径写错了"，
 * 而真实原因通常是"还没构建"。缺依赖即失败（不跳过），但要说清下一步做什么。
 */
async function importDist(relativePath) {
  const absolute = resolve(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(
      `找不到构建产物：${relativePath}\n` +
        '构建产物是记录制脚本的唯一依赖来源——请先运行 `pnpm build`（本脚本不静默跳过）。',
    );
  }
  return import(pathToFileURL(absolute).href);
}

/** sha256（十六进制，小写）——只写进报告，判"是否逐字节相等"仍直接比字节。 */
function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 格式化差异清单（不一致时用它回答"是哪一项变了"）。 */
function formatDiffs(diffs) {
  const head = diffs.slice(0, 10).map((diff) => `    - [${diff.kind}] ${diff.name}：${diff.left} → ${diff.right}`);
  if (diffs.length > head.length) head.push(`    …（共 ${String(diffs.length)} 项）`);
  return head.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const renderCore = await importDist('packages/render-core/dist/index.js');
  const pptxRenderer = await importDist('packages/pptx-renderer/dist/index.js');
  const engine = await importDist('packages/engine/dist/index.js');

  for (const name of ['createDemoPlanDocument', 'createScheduleCalendar', 'buildExportView']) {
    if (typeof renderCore[name] !== 'function') {
      throw new Error(`render-core/dist 未导出 ${name}（构建产物过期？先运行 \`pnpm build\`）`);
    }
  }
  for (const name of ['renderTemplateA', 'bytesEqual', 'entryDigests', 'diffDigests']) {
    if (typeof pptxRenderer[name] !== 'function') {
      throw new Error(`pptx-renderer/dist 未导出 ${name}（构建产物过期？先运行 \`pnpm build\`）`);
    }
  }
  if (typeof engine.compute !== 'function') {
    throw new Error('engine/dist 未导出 compute（构建产物过期？先运行 `pnpm build`）');
  }

  // ---------------------------------------------------------------- 演示口径（P-34）
  const document = renderCore.createDemoPlanDocument();
  const calendar = renderCore.createScheduleCalendar(document);
  const result = engine.compute(document, calendar);
  if (!result.ok) {
    throw new Error(`演示计划排程失败（演示口径本应 ok）：${JSON.stringify(result.diagnostics)}`);
  }
  const schedule = result.schedule;

  const input = { document, schedule, calendar, zoom: args.zoom, degradeConnectors: args.degrade };

  // 导出两次：字节级 golden 的最强判据是"直接比字节"，不是比哈希。
  const first = await pptxRenderer.renderTemplateA(input);
  const second = await pptxRenderer.renderTemplateA(input);
  if (!(first instanceof Uint8Array) || !(second instanceof Uint8Array)) {
    throw new Error('renderTemplateA 未返回 Uint8Array（零 DOM 契约被破坏）');
  }

  const twoRunIdentical = pptxRenderer.bytesEqual(first, second);
  let diffs = [];
  if (!twoRunIdentical) {
    diffs = pptxRenderer.diffDigests(
      await pptxRenderer.entryDigests(first),
      await pptxRenderer.entryDigests(second),
    );
  }

  // ---------------------------------------------------------------- 落盘（默认路径可由 --out 覆盖）
  const outPath = resolve(repoRoot, args.out ?? join('tmp', 'exports', `template-a-demo-${args.zoom}.pptx`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, first);

  // ---------------------------------------------------------------- 行/边口径（与页面、与产物同源）
  const projection = renderCore.buildExportView({ document, schedule, calendar, zoom: args.zoom });

  const rows = Array.isArray(projection.view.rows) ? projection.view.rows.length : 0;
  const edges = Array.isArray(projection.view.edges) ? projection.view.edges.length : 0;

  console.log('[export-pptx] 模板 A（演示计划 · P-34 口径）');
  console.log(`  zoom             : ${args.zoom}${args.degrade ? '（降级②：connector 走 custGeom 折线）' : ''}`);
  console.log(`  输出             : ${outPath}`);
  console.log(`  字节数           : ${String(first.length)}`);
  console.log(`  sha256           : ${sha256Of(first)}`);
  console.log(`  sha256（第二次） : ${sha256Of(second)}`);
  console.log(`  行数 / 边数      : ${String(rows)} / ${String(edges)}（buildExportView：rowCount=${String(projection.rowCount)}）`);
  console.log(`  twoRunIdentical  : ${String(twoRunIdentical)}`);
  if (!twoRunIdentical) {
    console.error('[export-pptx] 两次导出不一致（逐条目差异）：');
    console.error(formatDiffs(diffs));
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`[export-pptx] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
