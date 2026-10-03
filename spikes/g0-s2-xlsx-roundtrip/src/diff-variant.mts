/**
 * G0-S-S2 · **第三方往返取证**：对任意两份工作簿（我方规范化产物 → 第三方另存/编辑后产物）
 * 出**部件级**与**语义级**双报告，并给出通过/失败结论。
 *
 * 用法：
 *   node src/diff-variant.mts <before.xlsx> <after.xlsx> --label wps-save
 *   node src/diff-variant.mts <before.xlsx> <after.xlsx> --label wps-edit-save \
 *     --expect-change 2.1:name=交互层（已改名） --expect-change 2.1:progress=0.75
 *
 * `--expect-change <wbs>:<field>=<value>` 表示「该字段**被有意改动**，且改动后的值必须正好是这个」。
 * 未声明的任何字段差异都判为失败——这样「编辑后保存」的用例既能容纳有意改动，
 * 又不会把「读错了」当成「改过了」放行。
 *
 * 判定内容（复用 `verify-l1.ts` 的同一套判据，避免两套标准）：
 *   1. 语义 delta 恰好等于声明的 `--expect-change` 集合；
 *   2. 除 `field-equality`（有意改动必然命中）外的全部结构判据必须通过；
 *   3. 解析器不得产生任何诊断（第三方若把日期/进度写成我们读不出来的形式，这里会报出）。
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeWorkbook, type Check } from './verify-l1.ts';
import { readRawSheet, type RawCell } from './raw-read.ts';
import type { ParsedTask } from './parse-visible.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(spikeRoot, 'evidence');

const TASK_FIELDS = ['name', 'start', 'finish', 'duration', 'progress', 'milestone', 'note'] as const;
type TaskField = (typeof TASK_FIELDS)[number];

interface ExpectChange {
  readonly wbs: string;
  readonly field: TaskField;
  readonly value: string;
}

interface Delta {
  readonly wbs: string;
  readonly field: TaskField;
  readonly before: string;
  readonly after: string;
}

function parseArgs(argv: readonly string[]): {
  before: string;
  after: string;
  label: string;
  expectChanges: ExpectChange[];
} {
  const positional: string[] = [];
  const expectChanges: ExpectChange[] = [];
  let label = 'variant';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--label') {
      label = argv[index + 1] ?? label;
      index += 1;
    } else if (arg === '--expect-change') {
      const raw = argv[index + 1] ?? '';
      index += 1;
      const match = /^([^:]+):([a-zA-Z]+)=(.*)$/.exec(raw);
      assert.ok(match !== null, `--expect-change 语法应为 <wbs>:<field>=<value>：${raw}`);
      const field = (match[2] ?? '') as TaskField;
      assert.ok(TASK_FIELDS.includes(field), `未知字段：${field}`);
      expectChanges.push({ wbs: match[1] ?? '', field, value: match[3] ?? '' });
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      positional.push(arg);
    }
  }

  assert.equal(positional.length, 2, '用法：node src/diff-variant.mts <before.xlsx> <after.xlsx> [--label X] [--expect-change wbs:field=value]');
  return { before: positional[0] ?? '', after: positional[1] ?? '', label, expectChanges };
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return '(空)';
  return typeof value === 'number' ? String(value) : String(value);
}

function delta(before: readonly ParsedTask[], after: readonly ParsedTask[]): Delta[] {
  const deltas: Delta[] = [];
  const afterByWbs = new Map(after.map((task) => [task.wbs, task]));
  for (const previous of before) {
    const next = afterByWbs.get(previous.wbs);
    if (next === undefined) {
      deltas.push({ wbs: previous.wbs, field: 'name', before: describe(previous.name), after: '(整行缺失)' });
      continue;
    }
    for (const field of TASK_FIELDS) {
      const beforeValue = previous[field];
      const afterValue = next[field];
      const equal =
        typeof beforeValue === 'number' && typeof afterValue === 'number'
          ? Math.abs(beforeValue - afterValue) < 1e-9
          : beforeValue === afterValue;
      if (!equal) {
        deltas.push({ wbs: previous.wbs, field, before: describe(beforeValue), after: describe(afterValue) });
      }
    }
  }
  for (const next of after) {
    if (!before.some((previous) => previous.wbs === next.wbs)) {
      deltas.push({ wbs: next.wbs, field: 'name', before: '(新增行)', after: describe(next.name) });
    }
  }
  return deltas;
}

function cellPrint(cell: RawCell | undefined): string {
  if (cell === undefined) return '(无)';
  const value = cell.number ?? cell.text ?? cell.formula ?? '';
  return `${cell.kind}=${String(value)}｜numFmt=${cell.numFmt ?? '-'}｜style=${cell.styleIndex === null ? '-' : String(cell.styleIndex)}`;
}

function changedCells(before: readonly RawCell[], after: readonly RawCell[]): { ref: string; before: string; after: string }[] {
  const beforeByRef = new Map(before.map((cell) => [cell.ref, cell]));
  const afterByRef = new Map(after.map((cell) => [cell.ref, cell]));
  const refs = new Set([...beforeByRef.keys(), ...afterByRef.keys()]);
  const changes: { ref: string; before: string; after: string }[] = [];
  for (const ref of [...refs].sort()) {
    const a = beforeByRef.get(ref);
    const b = afterByRef.get(ref);
    const printA = cellPrint(a);
    const printB = cellPrint(b);
    if (printA !== printB) changes.push({ ref, before: printA, after: printB });
  }
  return changes;
}

function dateFormCounts(cells: readonly RawCell[], columns: readonly number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cell of cells) {
    if (!columns.includes(cell.column)) continue;
    if (cell.row === 1) continue; // 第 1 行是表头（列名），不是日期数据
    const key =
      cell.kind === 'number' && cell.isDateFormat
        ? `数值序列号（${cell.numFmt ?? '无格式'}）`
        : cell.kind === 'number'
          ? `数值（非日期格式 ${cell.numFmt ?? '无'}）`
          : cell.kind === 'empty'
            ? '空单元格'
            : `${cell.kind}「${(cell.text ?? '').slice(0, 12)}」`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function renderChecks(checks: readonly Check[]): string {
  return [
    '| 检查 | 结果 | 实测 |',
    '|---|---|---|',
    ...checks.map((check) => `| \`${check.name}\` | ${check.passed ? '✅ 通过' : '❌ 失败'} | ${check.detail.replace(/\|/g, '\\|')} |`),
  ].join('\n');
}

async function dumpTextParts(buffer: Buffer, prefix: string, directory: string, parts: readonly string[]): Promise<string[]> {
  const raw = await readRawSheet(buffer, '任务');
  const written: string[] = [];
  for (const part of parts) {
    const xml = raw.workbook.text.get(part);
    if (xml === undefined) continue;
    const file = join(directory, `${prefix}-${part.replace(/\//g, '__')}`);
    // 统一以 LF 写入（与 S1 同口径）：否则每次重跑都会让工作区「变脏」——
    // WPS 写的 XML 在 XML 声明后带一个 CRLF，而仓库由 .gitattributes 强制 LF。
    await writeFile(file, xml.replace(/\r\n/g, '\n'), 'utf8');
    written.push(part);
  }
  return written;
}

/**
 * 每次运行**字节必然不同**的部件（实测：只有这两个）。
 *
 * 它们带 WPS 自己的写入时间戳，因此不能把「哈希不同」当作内容差异的证据，
 * 也不把哈希写进证据文件——否则每次重跑都会让工作区变脏。
 * 判定仍然做（同址哈希比对），只是不在报告里打印可变的哈希。
 */
const TIMESTAMP_PARTS = new Set(['docProps/core.xml', 'docProps/custom.xml']);

async function main(): Promise<void> {
  const { before, after, label, expectChanges } = parseArgs(process.argv.slice(2));
  const beforeBytes = await readFile(before);
  const afterBytes = await readFile(after);

  const evidenceDir = join(evidenceRoot, label);
  await mkdir(evidenceDir, { recursive: true });

  const beforeRaw = await readRawSheet(beforeBytes, '任务');
  const afterRaw = await readRawSheet(afterBytes, '任务');
  const beforeJudge = await judgeWorkbook(beforeBytes);
  const afterJudge = await judgeWorkbook(afterBytes);

  const deltas = delta(beforeJudge.tasks, afterJudge.tasks);
  const cells = changedCells(beforeRaw.cells, afterRaw.cells);
  const beforeForms = dateFormCounts(beforeRaw.cells, [3, 4]);
  const afterForms = dateFormCounts(afterRaw.cells, [3, 4]);

  // 1) 语义 delta 必须恰好等于声明集合
  const declared = new Set(expectChanges.map((change) => `${change.wbs}:${change.field}`));
  const observed = new Set(deltas.map((item) => `${item.wbs}:${item.field}`));
  const undeclared = [...observed].filter((key) => !declared.has(key));
  const missing = [...declared].filter((key) => !observed.has(key));

  // 2) 除 field-equality 外的结构判据必须通过
  const structural = afterJudge.checks.filter((check) => !check.name.startsWith('field-equality'));
  const structuralFailures = structural.filter((check) => !check.passed);

  // 3) 声明改动后的取值必须正好等于声明的值
  const valueProblems: string[] = [];
  for (const change of expectChanges) {
    const item = deltas.find((entry) => entry.wbs === change.wbs && entry.field === change.field);
    if (item === undefined) {
      valueProblems.push(`${change.wbs}.${change.field}：未观察到差异（声明为 ${change.value}）`);
      continue;
    }
    const afterValue = item.after;
    const equal =
      change.field === 'progress' || change.field === 'duration'
        ? Math.abs(Number(afterValue) - Number(change.value)) < 1e-9
        : afterValue === change.value;
    if (!equal) valueProblems.push(`${change.wbs}.${change.field}：期望 ${change.value}，实际 ${afterValue}`);
  }

  // 4) 部件级差异
  const beforeParts = new Map(beforeRaw.workbook.parts.map((part) => [part.name, part]));
  const afterParts = new Map(afterRaw.workbook.parts.map((part) => [part.name, part]));
  const partRows: string[] = [];
  for (const name of [...new Set([...beforeParts.keys(), ...afterParts.keys()])].sort()) {
    const a = beforeParts.get(name);
    const b = afterParts.get(name);
    const volatile = TIMESTAMP_PARTS.has(name) ? '（含时间戳，哈希每次不同，不比较）' : `\`${(b?.sha256 ?? '').slice(0, 16)}…\``;
    if (a === undefined) partRows.push(`| \`${name}\` | 新增 | — | ${String(b?.size ?? 0)} | ${volatile} |`);
    else if (b === undefined) partRows.push(`| \`${name}\` | 移除 | ${String(a.size)} | — | — |`);
    else if (a.sha256 === b.sha256) partRows.push(`| \`${name}\` | 未变 | ${String(a.size)} | ${String(b.size)} | — |`);
    else
      partRows.push(
        `| \`${name}\` | **重写** | ${String(a.size)} | ${String(b.size)} | \`${a.sha256.slice(0, 8)}…\` → ${volatile} |`,
      );
  }

  const dumpedParts = await dumpTextParts(afterBytes, 'after', evidenceDir, [
    'xl/worksheets/sheet1.xml',
    'xl/workbook.xml',
    'xl/styles.xml',
    'xl/sharedStrings.xml',
  ]);
  await dumpTextParts(beforeBytes, 'before', evidenceDir, [
    'xl/worksheets/sheet1.xml',
    'xl/workbook.xml',
    'xl/styles.xml',
    'xl/sharedStrings.xml',
  ]);

  const passed = undeclared.length === 0 && missing.length === 0 && structuralFailures.length === 0 && valueProblems.length === 0;

  const roundtrip = [
    `# S2 · 第三方往返语义报告（${label}）`,
    '',
    '> 由 `node src/diff-variant.mts` 生成。**判据与 L1 相同**（复用 `verify-l1.ts` 的判定集），',
    '> 因此「本报告通过」意味着同一套标准在第三方产物上仍然成立。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 基线（我方规范化产物） | \`${before}\` |`,
    `| 变体（第三方产物） | \`${after}\` |`,
    `| 语义字段差异 | ${String(deltas.length)} 处 |`,
    `| 落盘单元格差异 | ${String(cells.length)} 处 |`,
    `| zip 部件差异 | ${String(partRows.filter((row) => row.includes('重写') || row.includes('新增') || row.includes('移除')).length)} 处 |`,
    `| 解析诊断 | ${String(afterJudge.diagnostics.length)} 条 |`,
    `| **判定** | ${passed ? '✅ **通过**（语义等价，差异全部已声明）' : '❌ **失败**'} |`,
    '',
    '## 一、语义字段差异（基线解析值 → 变体解析值）',
    '',
    deltas.length === 0
      ? '无差异：第三方仅保存后，可见列语义**逐字段相等**。'
      : ['| WBS | 字段 | 基线 | 变体 | 是否已声明 |', '|---|---|---|---|---|', ...deltas.map((item) => `| ${item.wbs} | ${item.field} | ${item.before} | ${item.after} | ${declared.has(`${item.wbs}:${item.field}`) ? '是' : '**否**'} |`)].join('\n'),
    '',
    undeclared.length === 0 ? '' : `未声明的差异（判为失败）：${undeclared.join('、')}`,
    missing.length === 0 ? '' : `声明了但未观察到的差异（判为失败）：${missing.join('、')}`,
    valueProblems.length === 0 ? '' : `取值不符（判为失败）：${valueProblems.join('；')}`,
    '',
    '## 二、结构判据（与 L1 同一套；`field-equality` 因有意改动而单独看待）',
    '',
    renderChecks(structural),
    '',
    '## 三、日期列落盘形式',
    '',
    `基线：${Object.entries(beforeForms).map(([key, value]) => `${key} × ${String(value)}`).join('；')}`,
    '',
    `变体：${Object.entries(afterForms).map(([key, value]) => `${key} × ${String(value)}`).join('；')}`,
    '',
    '## 四、解析诊断',
    '',
    afterJudge.diagnostics.length === 0 ? '无诊断输出。' : afterJudge.diagnostics.join('\n'),
    '',
    `证据文件：${dumpedParts.map((part) => `\`after-${part.replace(/\//g, '__')}\``).join('、')}（\`${evidenceDir.replace(spikeRoot + '\\', '')}\` 下）。`,
    '',
  ].join('\n');

  const entryDiff = [
    `# S2 · 部件级差异（${label}）`,
    '',
    '> 「第三方到底重写了什么」——`sha256` 未变即未触碰；被重写的部件可用同目录下的',
    '`before-*.xml` 与 `after-*.xml` 直接 diff。',
    '',
    '| 部件 | 结果 | 基线字节 | 变体字节 | 摘要 |',
    '|---|---|---|---|---|',
    ...partRows,
    '',
    '## 落盘单元格差异（前 60 条）',
    '',
    cells.length === 0
      ? '无：所有单元格的落盘形态（类型/值/数字格式/样式索引）逐格一致。'
      : ['| 单元格 | 基线 | 变体 |', '|---|---|---|', ...cells.slice(0, 60).map((cell) => `| ${cell.ref} | ${cell.before} | ${cell.after} |`)].join('\n'),
    '',
    cells.length > 60 ? `（共 ${String(cells.length)} 处，此处仅列前 60 条）` : '',
    '',
  ].join('\n');

  await writeFile(join(evidenceDir, 'roundtrip-report.md'), roundtrip, 'utf8');
  await writeFile(join(evidenceDir, 'entry-diff.md'), entryDiff, 'utf8');

  console.log(`[semantic] 字段差异 ${String(deltas.length)} 处（已声明 ${String(declared.size)} 处），落盘单元格差异 ${String(cells.length)} 处`);
  console.log(`[structural] 结构判据失败 ${String(structuralFailures.length)} 条，诊断 ${String(afterJudge.diagnostics.length)} 条`);
  console.log(`[report] ${join(evidenceDir, 'roundtrip-report.md')}`);
  console.log(`[report] ${join(evidenceDir, 'entry-diff.md')}`);
  console.log(passed ? '[OK] 判定：通过' : '[FAIL] 判定：失败');

  assert.ok(passed, `第三方往返判定失败（见 ${join(evidenceDir, 'roundtrip-report.md')}）`);
}

await main();
