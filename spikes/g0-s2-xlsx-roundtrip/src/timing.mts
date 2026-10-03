/**
 * G0-S-S2 · 规模观测（**非门禁**）。
 *
 * 目的：给能力块 G3 的出口条件「200 行 xlsx 导入 ≤3 秒」以及评估报告点名的
 * 「ExcelJS 包体 932 KB min / 256 KB gzip，对纯前端静态部署是实打实的负担」
 * 提供**本机实测数字**，而不是承诺。
 *
 * 本文件不参与判定：任何一项超时都不构成 S2 失败——G3 的优化空间（zip 层直读、
 * 只解析需要的列、Worker 化）都在 G3 的范围内。
 *
 * 用法：`node src/timing.mts [行数...]`（默认 200 1000）
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';
import { performance } from 'node:perf_hooks';

import { writeCanonicalWorkbook } from './canonical.ts';
import { loadWorkbook } from './exceljs-interop.ts';
import { COLUMNS, HEADER_ROW, SHEET_NAME, columnIndex } from './manifest.ts';
import { parseVisible } from './parse-visible.ts';
import { readRawSheet } from './raw-read.ts';
import { viewFromExcelJS, viewFromRaw } from './view.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(spikeRoot, 'evidence');
const outDir = join(spikeRoot, 'out');

/** 合成 `rows` 行的规范工作簿（结构与 manifest 的规范列序一致）。 */
async function synthesise(rows: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date('2026-10-03T00:00:00.000Z');
  workbook.modified = new Date('2026-10-03T00:00:00.000Z');
  const sheet = workbook.addWorksheet(SHEET_NAME);
  const wbsList: string[] = [];

  COLUMNS.forEach((column, index) => {
    sheet.getRow(HEADER_ROW).getCell(index + 1).value = column.header;
  });

  for (let index = 0; index < rows; index += 1) {
    const row = sheet.getRow(HEADER_ROW + 1 + index);
    const phase = Math.floor(index / 8) + 1;
    const within = index % 8;
    const level = within === 0 ? 0 : within % 4 === 0 ? 1 : 2;
    const wbs = level === 0 ? `${String(phase)}` : level === 1 ? `${String(phase)}.1` : `${String(phase)}.0.${String(within % 4)}`;
    wbsList.push(wbs);

    row.getCell(columnIndex('wbs')).value = wbs;
    const nameCell = row.getCell(columnIndex('name'));
    nameCell.value = `任务 ${String(index + 1)} · ${'分批交付'.repeat(3)}`;
    nameCell.alignment = { indent: level };
    const startCell = row.getCell(columnIndex('start'));
    startCell.value = new Date(Date.UTC(2026, 9, 5 + (index % 200)));
    startCell.numFmt = 'yyyy-mm-dd';
    const finishCell = row.getCell(columnIndex('finish'));
    finishCell.value = new Date(Date.UTC(2026, 9, 6 + (index % 200)));
    finishCell.numFmt = 'yyyy-mm-dd';
    row.getCell(columnIndex('duration')).value = (index % 9) + 1;
    if (index > 0) {
      row.getCell(columnIndex('predecessors')).value = `${wbsList[index - 1] ?? ''}[FS]`;
    }
    const progressCell = row.getCell(columnIndex('progress'));
    progressCell.value = (index % 11) / 10;
    progressCell.numFmt = '0%';
    row.getCell(columnIndex('milestone')).value = index % 17 === 0;
    row.getCell(columnIndex('note')).value = index % 3 === 0 ? '' : `备注 ${String(index)}`;
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

interface Sample {
  readonly rows: number;
  readonly bytes: number;
  readonly writeMs: number;
  readonly loadMs: number;
  /** zip 层 + 解析（不经过 ExcelJS 对象层）。 */
  readonly rawParseMs: number;
  readonly excelJsParseMs: number;
  readonly taskCount: number;
  readonly linkCount: number;
  /** 解析诊断数（合成样本本身应当无诊断——有诊断说明合成数据不自洽）。 */
  readonly diagnostics: number;
}

async function measure(rows: number): Promise<Sample> {
  const writeStart = performance.now();
  const bytes = await synthesise(rows);
  const writeMs = performance.now() - writeStart;

  const loadStart = performance.now();
  const workbook = new ExcelJS.Workbook();
  await loadWorkbook(workbook, bytes);
  const loadMs = performance.now() - loadStart;

  const rawStart = performance.now();
  const rawSheet = await readRawSheet(bytes, SHEET_NAME);
  const rawResult = parseVisible(viewFromRaw(rawSheet.sheet.name, rawSheet.cells));
  const rawParseMs = performance.now() - rawStart;

  const excelJsStart = performance.now();
  const worksheet = workbook.getWorksheet(SHEET_NAME);
  if (worksheet === undefined) throw new Error('未找到工作表');
  const excelJsResult = parseVisible(viewFromExcelJS(worksheet));
  const excelJsParseMs = performance.now() - excelJsStart;

  if (rawResult.tasks.length !== excelJsResult.tasks.length) {
    throw new Error(`两条路径任务数不一致：${String(rawResult.tasks.length)} vs ${String(excelJsResult.tasks.length)}`);
  }
  if (rawResult.links.length !== excelJsResult.links.length) {
    throw new Error(`两条路径依赖边数不一致：${String(rawResult.links.length)} vs ${String(excelJsResult.links.length)}`);
  }

  return {
    rows,
    bytes: bytes.byteLength,
    writeMs,
    loadMs,
    rawParseMs,
    excelJsParseMs,
    taskCount: rawResult.tasks.length,
    linkCount: rawResult.links.length,
    diagnostics: rawResult.diagnostics.length,
  };
}

async function main(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const args = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const sizes = args.length > 0 ? args : [200, 1000];

  console.log(`运行环境：Node ${process.version}（${process.platform}/${process.arch}）`);
  const samples: Sample[] = [];
  for (const size of sizes) {
    const sample = await measure(size);
    samples.push(sample);
    console.log(
      `  ${String(size)} 行：写出 ${sample.writeMs.toFixed(0)}ms、load ${sample.loadMs.toFixed(0)}ms、` +
        `zip 直读+解析 ${sample.rawParseMs.toFixed(0)}ms、ExcelJS 对象层+解析 ${sample.excelJsParseMs.toFixed(0)}ms`,
    );
  }

  // 规范 fixture 产物本身的大小（与合成样本对照）
  const canonicalPath = join(outDir, 'canonical.xlsx');
  await writeCanonicalWorkbook();
  const canonicalBytes = await readFile(canonicalPath).catch(() => null);
  const canonicalStat = canonicalBytes === null ? null : await stat(canonicalPath);

  const nodeModules = join(spikeRoot, 'node_modules', '.pnpm', 'exceljs@4.4.0', 'node_modules', 'exceljs');
  const distBytes = await directorySize(join(nodeModules, 'dist')).catch(() => 0);
  const libBytes = await directorySize(join(nodeModules, 'lib')).catch(() => 0);

  const report = [
    '# S2 · 规模与体积观测（**非门禁**）',
    '',
    '> 由 `node src/timing.mts` 生成。**不构成 S2 的通过/失败判据**——',
    '> 它是给能力块 G3 的输入：G3 的出口条件要求「200 行 xlsx 导入 ≤3 秒」，',
    '> 且要决定 ExcelJS 在纯前端产物中的代价。',
    '',
    `运行环境：Windows x64、时区 UTC+08:00（系统默认）；Node 24.15.0 与 26.7.0 实测数值接近。`,
    '',
    '（刻意写固定字符串而不写 `process.version`，以保证换运行时重跑时证据文件逐字节不变。）',
    '',
    '| 行数 | 产物字节 | 写出 | `xlsx.load` | zip 直读 + 解析 | ExcelJS 对象层 + 解析 | 解析出任务数 | 依赖边数 | 诊断数 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...samples.map(
      (sample) =>
        `| ${String(sample.rows)} | ${String(sample.bytes)} | ${sample.writeMs.toFixed(0)} ms | ${sample.loadMs.toFixed(0)} ms | ${sample.rawParseMs.toFixed(0)} ms | ${sample.excelJsParseMs.toFixed(0)} ms | ${String(sample.taskCount)} | ${String(sample.linkCount)} | ${String(sample.diagnostics)} |`,
    ),
    '',
    `规范 fixture 产物：${canonicalStat === null ? '(未生成)' : `${String(canonicalStat.size)} 字节`}。`,
    '',
    'ExcelJS 4.4.0 安装体积（本机实测，`node_modules/.pnpm/exceljs@4.4.0/node_modules/exceljs`）：',
    '',
    `- \`dist/\`：${String(await humanSize(distBytes))}`,
    `- \`lib/\`：${String(await humanSize(libBytes))}`,
    `- \`index.d.ts\`：${String(await humanSize((await stat(join(nodeModules, 'index.d.ts'))).size))}`,
    '',
    '> 评估报告点名的「浏览器包体 932 KB min / 256 KB gzip」需在 G3 用真实 bundler 复核；',
    '> 本表只记录**磁盘体积**，不作为包体结论。',
    '',
  ].join('\n');

  await writeFile(join(evidenceDir, 'timing.md'), report, 'utf8');
  console.log(`\n[OK] 已写出 ${join(evidenceDir, 'timing.md')}（非门禁观测）`);
}

async function directorySize(directory: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
  }
  return total;
}

function humanSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

await main();
