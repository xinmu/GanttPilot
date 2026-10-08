#!/usr/bin/env node
/**
 * **成环样本**生成器（裁决 P-21 §5 遗留 3 / P-22 的收口动作）。
 *
 * 产出 `tmp/samples/cyclic-dependency.xlsx`：一张**只有三列**（`WBS / 任务名称 / 前置任务`）的
 * 六行工作簿，`前置任务` 列里写了一个环：
 *
 * | WBS | 任务名称 | 前置任务 |
 * |---|---|---|
 * | 1 | 甲 | 6 |
 * | 2 | 乙 | 1 |
 * | 3 | 丙 | 2 |
 * | 4 | 丁 | 3 |
 * | 5 | 戊 | 4 |
 * | 6 | 己 | 5 |
 *
 * 为什么是这个形状：
 * - **三列**：其余六个可选列缺失 ⇒ 顺带覆盖"可选列缺失"的容差路径（ADR 0006 §2/§4）；
 * - **第 6 行的 `5`（即 `t5→t6`）会闭合成环**：导入器按「工作表行序 × 单元格内出现顺序」
 *   逐条 `wouldCreateCycle(已接受的边, 候选)`（ADR 0006 §7 / P-14 第 4 条），
 *   前 5 条先被接受，第 6 条被**确定性丢弃** + `XLSX_CYCLE_EDGE_DROPPED`（带成环路径）；
 *   结果是**无环**、6 任务 / 5 依赖、可排程 —— 这正是 P-21 要的"留一条因成环被丢弃的边"。
 *
 * ## 产物不入库
 *
 * `tmp/` 已在 `.gitignore` 里。样本的**语义**由 `xlsx-protocol` 的既有 spec 覆盖（进 `pnpm gate`），
 * 这一个**具体文件**由记录制验证：`node scripts/measure-render.mjs --import=tmp/samples/cyclic-dependency.xlsx`
 * 会把"导入 → 诊断清单 → 任务/依赖计数"的真实结果写成证据。因此不复制第二份行数据。
 *
 * ## 为什么用 `createRequire` 而不是直接 `import 'exceljs'`
 *
 * 本仓库用 pnpm 的隔离式 `node_modules`：根目录**没有** `exceljs`（它是
 * `packages/xlsx-protocol` 的运行时依赖）。`createRequire` 指到那个包的 `package.json`，
 * 就按 Node 的**普通解析规则**从该包的位置去找 —— 不需要新增依赖，也不需要给脚本换目录。
 * 解析失败**报错退出而不是跳过**（P-12 的口径）。
 *
 * 用法：
 *   node scripts/make-sample.mjs            # 写到 tmp/samples/cyclic-dependency.xlsx
 *   node scripts/make-sample.mjs <out.xlsx> # 指定输出路径
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { repoRoot } from './paths.mjs';

const defaultOutput = resolve(repoRoot, 'tmp', 'samples', 'cyclic-dependency.xlsx');

/** 样本的行（**唯一的行数据定义处**；表的形状与上面文档里的表逐行一致）。 */
const ROWS = [
  { wbs: '1', name: '甲', predecessors: '6' },
  { wbs: '2', name: '乙', predecessors: '1' },
  { wbs: '3', name: '丙', predecessors: '2' },
  { wbs: '4', name: '丁', predecessors: '3' },
  { wbs: '5', name: '戊', predecessors: '4' },
  { wbs: '6', name: '己', predecessors: '5' },
];

const HEADERS = ['WBS', '任务名称', '前置任务'];
const SHEET_NAME = '任务';

/** 取 `exceljs`（从 `packages/xlsx-protocol` 的依赖图里解析；缺了就抛错）。 */
function loadExcelJs() {
  const require = createRequire(new URL('../packages/xlsx-protocol/package.json', import.meta.url));
  try {
    return require('exceljs');
  } catch (error) {
    throw new Error(
      `无法从 packages/xlsx-protocol 解析 exceljs（先 pnpm install）：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function main() {
  const output = process.argv[2] === undefined ? defaultOutput : resolve(process.cwd(), process.argv[2]);
  const ExcelJS = loadExcelJs();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.addRow(HEADERS);
  for (const row of ROWS) sheet.addRow([row.wbs, row.name, row.predecessors]);
  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 16;

  const buffer = await workbook.xlsx.writeBuffer();
  mkdirSync(dirname(output), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(output, Buffer.from(buffer));

  const size = existsSync(output) ? Buffer.from(buffer).length : 0;
  console.log(`[sample] 已写出 ${output}（${String(ROWS.length)} 行 / ${String(HEADERS.length)} 列 / ${String(size)} 字节）`);
  console.log('[sample] 期望的导入结果：6 任务 / 5 依赖、1 条 XLSX_CYCLE_EDGE_DROPPED（成环路径 t5 → t6 → t1 → t2 → t3 → t4 → t5）、可排程');
  console.log(`[sample] 记录制验证：node scripts/measure-render.mjs --import=${output}`);
}

await main();
