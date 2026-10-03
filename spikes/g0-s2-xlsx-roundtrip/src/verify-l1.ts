/**
 * G0-S-S2 · L1：**自往返 + 双路径 + 编码落地 + 负向对照**。
 *
 * 本文件只做判定，不写报告（报告由 `run-all.mts` 渲染），因为失败时也要留下报告。
 *
 * 判据的判别力由**负向对照**证明：把写出的文件按字节变造 4 处，要求判定集必须报错。
 * 若变造后仍「全绿」，说明判据无判别力——这时整个 L1 的结论都不可信（S1 的教训）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { writeCanonicalWorkbook, writeTzProbeWorkbook } from './canonical.ts';
import { loadWorkbook } from './exceljs-interop.ts';
import {
  COLUMNS,
  DATE_ENCODING,
  FIXTURE,
  FIXTURE_STATS,
  HEADER_ROW,
  MILESTONE_ENCODING,
  SHEET_NAME,
  columnIndex,
  expectedEdges,
  type ExpectTask,
  type RelationType,
} from './manifest.ts';
import { parseVisible, normaliseExpected, normaliseLinks, type ParsedTask } from './parse-visible.ts';
import { excelSerialToDisplayDate, readRawSheet, type PartInfo, type RawCell } from './raw-read.ts';
import { cellFingerprint, viewFromExcelJS, viewFromRaw, withoutIndent, type SheetView } from './view.ts';

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface FieldMismatch {
  readonly wbs: string;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export interface EdgeDiff {
  readonly missing: string[];
  readonly extra: string[];
}

export interface NegativeControl {
  readonly name: string;
  /** 变造内容。 */
  readonly mutation: string;
  /** 期望判定集报出的检查名（至少命中其一）。 */
  readonly expectFailing: string[];
  readonly observedFailing: string[];
  readonly detected: boolean;
}

export interface TzProbeRow {
  readonly label: string;
  readonly serialWritten: number;
  readonly integral: boolean;
  readonly excelDisplayDate: string;
  readonly excelJsReadBack: string;
  /** 备注（本机时区恰好为 UTC 时会追加说明）。 */
  note: string;
}

export interface L1Result {
  readonly checks: readonly Check[];
  readonly mismatches: readonly FieldMismatch[];
  readonly edges: EdgeDiff;
  readonly dualPathDifferences: readonly string[];
  readonly diagnostics: readonly string[];
  readonly dateRepresentations: Readonly<Record<string, number>>;
  readonly negativeControls: readonly NegativeControl[];
  readonly tzProbe: readonly TzProbeRow[];
  readonly duel: {
    readonly excelJsCells: number;
    readonly rawCells: number;
    readonly sharedStrings: number;
    readonly parts: number;
  };
  readonly committed: {
    readonly sizeBytes: number;
    /** 部件内容指纹（条目名 + 各条目 sha256 的稳定摘要）——**这才是可比对的工件身份**。 */
    readonly partsFingerprint: string;
    readonly parts: number;
    readonly deterministic: boolean;
    /** 整文件字节是否相同（exceljs 会把写入时刻写进 zip 条目时间戳，故通常为 false）。 */
    readonly fileBytesIdentical: boolean;
  };
}

// ---------------------------------------------------------------------------
// 比对
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null || value === undefined) return '(空)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function compareFields(parsed: readonly ParsedTask[], expected: readonly ExpectTask[]): FieldMismatch[] {
  const mismatches: FieldMismatch[] = [];
  const byWbs = new Map(parsed.map((task) => [task.wbs, task]));
  for (const want of expected) {
    const got = byWbs.get(want.wbs);
    if (got === undefined) {
      mismatches.push({ wbs: want.wbs, field: '(行)', expected: '存在', actual: '缺失' });
      continue;
    }
    const pairs: [string, unknown, unknown][] = [
      ['name', want.name, got.name],
      ['start', want.start, got.start],
      ['finish', want.finish, got.finish],
      ['duration', want.duration, got.duration],
      ['progress', want.progress, got.progress],
      ['milestone', want.milestone, got.milestone],
      ['note', want.note === '' ? '' : want.note, got.note],
    ];
    for (const [field, wantValue, gotValue] of pairs) {
      const equal =
        typeof wantValue === 'number' && typeof gotValue === 'number'
          ? Math.abs(wantValue - gotValue) < 1e-9
          : wantValue === gotValue;
      if (!equal) {
        mismatches.push({ wbs: want.wbs, field, expected: describe(wantValue), actual: describe(gotValue) });
      }
    }
  }
  for (const got of parsed) {
    if (!expected.some((want) => want.wbs === got.wbs)) {
      mismatches.push({ wbs: got.wbs, field: '(行)', expected: '不在 fixture 中', actual: '解析出了多余行' });
    }
  }
  return mismatches;
}

function edgeKey(edge: { from: string; to: string; type: string; lag: number }): string {
  return `${edge.from}→${edge.to} ${edge.type} lag=${String(edge.lag)}`;
}

/** 期望边（声明式）与解析出的边集合求差。 */
function compareEdges(
  parsedLinks: readonly { from: string; to: string; type: RelationType; lag: number }[],
): EdgeDiff {
  const expected = normaliseExpected(expectedEdges()).map(edgeKey);
  const actual = normaliseLinks(parsedLinks).map(edgeKey);
  const want = new Set(expected);
  const got = new Set(actual);
  return {
    missing: expected.filter((key) => !got.has(key)),
    extra: actual.filter((key) => !want.has(key)),
  };
}

// ---------------------------------------------------------------------------
// 单元格级检查
// ---------------------------------------------------------------------------

function cellAt(cells: readonly RawCell[], row: number, column: number): RawCell | undefined {
  return cells.find((cell) => cell.row === row && cell.column === column);
}

function rowOfWbs(wbs: string): number {
  const index = FIXTURE.findIndex((task) => task.wbs === wbs);
  assert.ok(index >= 0, `fixture 中不存在 WBS ${wbs}`);
  return HEADER_ROW + 1 + index;
}

/** 断言「编码确实以声明的形式落盘」——这是编码判据能否成立的前提。 */
function checkRawCellTypes(cells: readonly RawCell[]): Check {
  const problems: string[] = [];
  const dateColumns = [columnIndex('start'), columnIndex('finish')] as const;
  const textColumns = [columnIndex('wbs'), columnIndex('name'), columnIndex('predecessors'), columnIndex('note')] as const;

  for (const task of FIXTURE) {
    const row = rowOfWbs(task.wbs);
    for (const column of dateColumns) {
      const iso = column === dateColumns[0] ? task.start : task.finish;
      const cell = cellAt(cells, row, column);
      if (iso === null) {
        if (cell !== undefined && cell.kind !== 'empty') problems.push(`${task.wbs} 日期列应为空，实际 ${cell.kind}`);
        continue;
      }
      if (cell === undefined) {
        problems.push(`${task.wbs} 日期列缺失`);
        continue;
      }
      if (DATE_ENCODING === 'serial') {
        if (cell.kind !== 'number') problems.push(`${task.wbs} 日期列应为数值序列号，实际 ${cell.kind}`);
        else if (!cell.isDateFormat) problems.push(`${task.wbs} 日期列缺少日期数字格式（numFmt=${String(cell.numFmt)}）`);
        else if (Math.abs((cell.number ?? 0) - Math.round(cell.number ?? 0)) > 1e-9) {
          problems.push(`${task.wbs} 日期序列号含小数分量：${String(cell.number)}`);
        }
      } else if (cell.kind !== 'shared' && cell.kind !== 'inline' && cell.kind !== 'string') {
        problems.push(`${task.wbs} 日期列应为文本（iso-text 编码），实际 ${cell.kind}`);
      }
    }

    for (const column of textColumns) {
      const cell = cellAt(cells, row, column);
      if (cell === undefined) continue;
      if (cell.kind !== 'shared' && cell.kind !== 'inline') {
        problems.push(`${task.wbs} 第 ${String(column)} 列文本应为共享/内联字符串，实际 ${cell.kind}`);
      }
    }

    const progress = cellAt(cells, row, columnIndex('progress'));
    if (progress !== undefined && progress.kind !== 'number') {
      problems.push(`${task.wbs} 进度应为数值，实际 ${progress.kind}`);
    }

    const milestone = cellAt(cells, row, columnIndex('milestone'));
    if (milestone !== undefined) {
      const expectedKind = MILESTONE_ENCODING === 'boolean' ? 'boolean' : 'shared';
      if (milestone.kind !== expectedKind) {
        problems.push(`${task.wbs} 里程碑应为 ${expectedKind}，实际 ${milestone.kind}`);
      }
    } else {
      problems.push(`${task.wbs} 里程碑单元格缺失`);
    }
  }

  return {
    name: 'raw-cell-types（编码确实按声明落盘）',
    passed: problems.length === 0,
    detail: problems.length === 0 ? `${String(FIXTURE.length)} 行的列类型与数字格式全部符合声明` : problems.slice(0, 8).join('；'),
  };
}

function checkHeader(cells: readonly RawCell[], view: SheetView): Check {
  const expected = COLUMNS.map((column, index) => ({ header: column.header, column: index + 1 }));
  const actual = expected.map(({ column }) => cellAt(cells, HEADER_ROW, column)?.text ?? '(缺)');
  const passed = expected.every(({ header }, index) => actual[index] === header);
  const headerCells = view.cells.filter((cell) => cell.row === HEADER_ROW);
  return {
    name: 'header-row（表头文本与列序）',
    passed,
    detail: passed
      ? `第 ${String(HEADER_ROW)} 行：${actual.join(' | ')}（共 ${String(headerCells.length)} 格）`
      : `期望 ${expected.map((entry) => entry.header).join(' | ')}，实际 ${actual.join(' | ')}`,
  };
}

function checkIndentNotSemantic(view: SheetView): Check {
  const withIndent = parseVisible(view);
  const cleared = parseVisible(withoutIndent(view));
  // 缩进本身是**记录在案的信息**（层级显示提示），比较时必须剔除它；
  // 本检查问的是「层级是否由缩进推导」——若剔除后仍相同，即证明解析不依赖缩进。
  const strip = (result: ReturnType<typeof parseVisible>): string =>
    JSON.stringify({
      ...result,
      tasks: result.tasks.map((task) => ({
        row: task.row,
        wbs: task.wbs,
        name: task.name,
        start: task.start,
        finish: task.finish,
        duration: task.duration,
        progress: task.progress,
        milestone: task.milestone,
        note: task.note,
      })),
    });
  const same = strip(withIndent) === strip(cleared);
  return {
    name: 'indent-not-semantic（清空缩进后解析结果不变）',
    passed: same,
    detail: same ? '剔除缩进字段后，解析结果逐字节相同' : '清除 alignment.indent 后解析结果发生变化',
  };
}

function checkIndentMatchesDepth(parsed: readonly ParsedTask[]): Check {
  const problems: string[] = [];
  for (const task of parsed) {
    const depth = task.wbs.split('.').length - 1;
    if (task.indent !== depth) {
      problems.push(`${task.wbs} 缩进 ${String(task.indent)} ≠ WBS 深度 ${String(depth)}`);
    }
  }
  return {
    name: 'indent-matches-depth（WBS 编号可独立推导层级）',
    passed: problems.length === 0,
    detail: problems.length === 0 ? `${String(parsed.length)} 行的缩进与 WBS 深度一致` : problems.slice(0, 5).join('；'),
  };
}

function checkFormulaPrefixText(parsed: readonly ParsedTask[], cells: readonly RawCell[]): Check {
  const guarded = FIXTURE.filter((task) => /^[=+\-@]/.test(task.name));
  const problems: string[] = [];
  for (const task of guarded) {
    const got = parsed.find((entry) => entry.wbs === task.wbs);
    if (got === undefined || got.name !== task.name) {
      problems.push(`${task.wbs} 名称往返不一致：${describe(got?.name)}`);
      continue;
    }
    const cell = cellAt(cells, rowOfWbs(task.wbs), columnIndex('name'));
    if (cell === undefined || (cell.kind !== 'shared' && cell.kind !== 'inline')) {
      problems.push(`${task.wbs} 名称落盘类型为 ${String(cell?.kind)}（应为字符串）`);
    }
  }
  return {
    name: 'formula-prefix-text（= + - @ 前缀文本按字符串往返）',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${String(guarded.length)} 行（${guarded.map((task) => task.wbs).join('、')}）逐字符一致且落盘为字符串`
        : problems.join('；'),
  };
}

/**
 * 日期列在**落盘层**的表示分布。
 *
 * 这是回答「第三方编辑器把日期改成了什么」的那一格：判据是「能否解析」，
 * 而这一行给出「它是以什么形式被解析到的」。
 */
function checkDateRepresentations(cells: readonly RawCell[]): { check: Check; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const task of FIXTURE) {
    const row = rowOfWbs(task.wbs);
    for (const [column, iso] of [
      [columnIndex('start'), task.start],
      [columnIndex('finish'), task.finish],
    ] as const) {
      const cell = cellAt(cells, row, column);
      const key =
        iso === null
          ? '期望为空'
          : cell === undefined
            ? '**缺失**'
            : cell.kind === 'empty'
              ? '空单元格'
              : cell.kind === 'number'
                ? cell.isDateFormat
                  ? `数值序列号（${cell.numFmt ?? '无格式'}）`
                  : `数值（非日期格式 ${cell.numFmt ?? '无'}）`
                : cell.kind === 'shared' || cell.kind === 'inline'
                  ? `文本「${(cell.text ?? '').slice(0, 10)}」`
                  : `其他：${cell.kind}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return {
    check: {
      name: 'date-representations（日期列落盘形式分布）',
      passed: Object.keys(counts).every((key) => !key.includes('**缺失**')),
      detail: Object.entries(counts)
        .map(([key, value]) => `${key} × ${String(value)}`)
        .join('；'),
    },
    counts,
  };
}

function columnLetter(column: number): string {
  let remainder = column;
  let letters = '';
  while (remainder > 0) {
    const digit = (remainder - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remainder = Math.floor((remainder - 1) / 26);
  }
  return letters;
}

// ---------------------------------------------------------------------------
// 双路径一致性
// ---------------------------------------------------------------------------

function duelViews(a: SheetView, b: SheetView): string[] {
  const differences: string[] = [];
  const indexA = new Map(a.cells.map((cell) => [cell.ref, cell]));
  const indexB = new Map(b.cells.map((cell) => [cell.ref, cell]));

  for (const [ref, cellA] of indexA) {
    const cellB = indexB.get(ref);
    if (cellB === undefined) {
      differences.push(`${ref}：ExcelJS 路径有值而 zip 路径没有`);
      continue;
    }
    const printA = cellFingerprint(cellA);
    const printB = cellFingerprint(cellB);
    if (printA !== printB) differences.push(`${ref}：ExcelJS=${printA} / zip=${printB}`);
  }
  for (const ref of indexB.keys()) {
    if (!indexA.has(ref)) differences.push(`${ref}：zip 路径有值而 ExcelJS 路径没有`);
  }
  return differences;
}

// ---------------------------------------------------------------------------
// 负向对照：字节级变造
// ---------------------------------------------------------------------------

async function mutateWorkbook(buffer: Buffer, sheetXmlMutator: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const sheetPath = Object.keys(zip.files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  assert.ok(sheetPath !== undefined, ' mutate: 未找到工作表部件');
  const entry = zip.file(sheetPath);
  assert.ok(entry !== null, ' mutate: 无法读取工作表部件');
  const xml = await entry.async('string');
  const mutated = sheetXmlMutator(xml);
  assert.notEqual(mutated, xml, `变造未生效：${sheetPath}`);
  zip.file(sheetPath, mutated);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/** 把某单元格的 `<v>` 值替换掉（保留其余属性）。 */
function replaceCellValue(xml: string, ref: string, newValue: string): string {
  const pattern = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*>)([\\s\\S]*?)(</c>)`);
  const match = pattern.exec(xml);
  assert.ok(match !== null, `变造目标单元格不存在：${ref}`);
  const inner = (match[2] ?? '').replace(/<v>[\s\S]*?<\/v>/, `<v>${newValue}</v>`);
  return xml.replace(pattern, `${match[1] ?? ''}${inner}${match[3] ?? ''}`);
}

/** 给某单元格加上/替换 `t` 属性。 */
function setCellType(xml: string, ref: string, type: string): string {
  const pattern = new RegExp(`<c\\b[^>]*\\br="${ref}"([^>]*)>`);
  const match = pattern.exec(xml);
  assert.ok(match !== null, `变造目标单元格不存在：${ref}`);
  const attributes = (match[1] ?? '').replace(/\st="[^"]*"/, '');
  return xml.replace(pattern, `<c${attributes} t="${type}">`);
}

/** 把表头文本从共享字符串表里改掉（模拟列名漂移/缺列）。 */
async function mutateSharedStrings(buffer: Buffer, from: string, to: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('xl/sharedStrings.xml');
  assert.ok(entry !== null, '变造：缺少 sharedStrings.xml');
  const xml = await entry.async('string');
  const mutated = xml.replace(from, to);
  assert.notEqual(mutated, xml, `变造未生效：共享字符串中没有 ${from}`);
  zip.file('xl/sharedStrings.xml', mutated);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export interface Judge {
  checks: readonly Check[];
  mismatches: readonly FieldMismatch[];
  edges: EdgeDiff;
  dualPathDifferences: readonly string[];
  diagnostics: readonly string[];
  excelJsCells: number;
  rawCells: number;
  tasks: readonly ParsedTask[];
  rawCellsDetail: readonly RawCell[];
}

/** 对任意一份工作簿跑完整判定集（与 `runL1` 用的是同一套判据；`diff-variant.mts` 也复用它，） */
export async function judgeWorkbook(buffer: Buffer): Promise<Judge> {
  const rawSheet = await readRawSheet(buffer, SHEET_NAME);
  const rawView = viewFromRaw(rawSheet.sheet.name, rawSheet.cells);

  const workbook = new ExcelJS.Workbook();
  await loadWorkbook(workbook, buffer);
  const worksheet = workbook.getWorksheet(SHEET_NAME);
  assert.ok(worksheet !== undefined, `ExcelJS 未找到工作表 ${SHEET_NAME}`);
  const excelJsView = viewFromExcelJS(worksheet);

  const checks: Check[] = [];
  checks.push(checkHeader(rawSheet.cells, rawView));
  checks.push(checkRawCellTypes(rawSheet.cells));

  const dualPathDifferences = duelViews(excelJsView, rawView);
  checks.push({
    name: 'dual-path（ExcelJS 对象层 vs zip 原始层逐格一致）',
    passed: dualPathDifferences.length === 0,
    detail:
      dualPathDifferences.length === 0
        ? `${String(excelJsView.cells.length)} 格完全一致`
        : `${String(dualPathDifferences.length)} 处不一致：${dualPathDifferences.slice(0, 5).join('；')}`,
  });

  const parsedFromExcelJs = parseVisible(excelJsView);
  const parsedFromRaw = parseVisible(rawView);
  const mismatches = compareFields(parsedFromExcelJs.tasks, FIXTURE);
  const edges = compareEdges(parsedFromExcelJs.links);

  checks.push({
    name: 'field-equality（ExcelJS 路径解析值 vs 声明式期望值）',
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${String(FIXTURE.length)} 行 × 7 字段全部相等`
        : `${String(mismatches.length)} 处不一致：${mismatches.slice(0, 5).map((item) => `${item.wbs}.${item.field}`).join('、')}`,
  });
  checks.push({
    name: 'edge-equality（依赖边集合 vs 声明式期望边）',
    passed: edges.missing.length === 0 && edges.extra.length === 0,
    detail:
      edges.missing.length === 0 && edges.extra.length === 0
        ? `${String(expectedEdges().length)} 条边完全一致`
        : `缺失 ${String(edges.missing.length)} 条、多余 ${String(edges.extra.length)} 条`,
  });
  checks.push({
    name: 'raw-path-agreement（zip 路径解析值 vs ExcelJS 路径解析值）',
    passed: JSON.stringify(parsedFromRaw) === JSON.stringify(parsedFromExcelJs),
    detail:
      JSON.stringify(parsedFromRaw) === JSON.stringify(parsedFromExcelJs)
        ? '两条读取路径的解析结果逐字节相同'
        : '两条路径解析结果不同',
  });
  checks.push(checkIndentNotSemantic(excelJsView));
  checks.push(checkIndentMatchesDepth(parsedFromExcelJs.tasks));
  checks.push(checkFormulaPrefixText(parsedFromExcelJs.tasks, rawSheet.cells));

  const diagnostics = [
    ...parsedFromExcelJs.diagnostics.map((item) => `${item.code}@行${String(item.row)}: ${item.message}`),
    ...parsedFromRaw.diagnostics.map((item) => `${item.code}@行${String(item.row)}(zip): ${item.message}`),
  ];
  checks.push({
    name: 'diagnostics-empty（结构化诊断为空）',
    passed: diagnostics.length === 0,
    detail: diagnostics.length === 0 ? '无诊断输出' : diagnostics.slice(0, 5).join('；'),
  });

  return {
    checks,
    mismatches,
    edges,
    dualPathDifferences,
    diagnostics,
    excelJsCells: excelJsView.cells.length,
    rawCells: rawView.cells.length,
    tasks: parsedFromExcelJs.tasks,
    rawCellsDetail: rawSheet.cells,
  };
}

async function runNegativeControls(buffer: Buffer): Promise<NegativeControl[]> {
  const controls: NegativeControl[] = [];

  const add = async (
    control: Omit<NegativeControl, 'observedFailing' | 'detected'>,
    mutated: Buffer,
  ): Promise<void> => {
    let failing: string[];
    try {
      const judge = await judgeWorkbook(mutated);
      failing = judge.checks.filter((check) => !check.passed).map((check) => check.name);
    } catch (error) {
      // 变造后的文件连解析都过不去，本身就是「被报出」——记下来而不是让负向对照炸掉。
      failing = [`(解析异常：${error instanceof Error ? error.message : String(error)})`];
    }
    const observedFailing = failing.length > 0 ? failing : ['(无)'];
    controls.push({
      ...control,
      observedFailing,
      detected: control.expectFailing.some((name) => failing.includes(name)) || failing.some((n) => n.startsWith('(解析异常')),
    });
  };

  // NC1：把 1.1 的开始日期从数值序列号改成文本单元格（落盘类型漂移）——编码判据必须报错
  {
    const row = rowOfWbs('1.1');
    const ref = `${columnLetter(columnIndex('start'))}${String(row)}`;
    const mutated = await mutateWorkbook(buffer, (xml) => setCellType(xml, ref, 'str'));
    await add(
      {
        name: `NC1 日期单元格改成文本型（${ref}）`,
        mutation: `把 ${ref} 的落盘类型从数值改为 t="str"（日期写成文本）`,
        expectFailing: ['raw-cell-types（编码确实按声明落盘）'],
      },
      mutated,
    );
  }

  // NC2：日期序列号 +1 天——字段相等判据必须报错
  {
    const row = rowOfWbs('1.1');
    const ref = `${columnLetter(columnIndex('start'))}${String(row)}`;
    const rawSheet = await readRawSheet(buffer, SHEET_NAME);
    const serial = cellAt(rawSheet.cells, row, columnIndex('start'))?.number;
    assert.ok(typeof serial === 'number', 'NC2：未取到目标序列号');
    const mutated = await mutateWorkbook(buffer, (xml) => replaceCellValue(xml, ref, String(serial + 1)));
    await add(
      {
        name: `NC2 日期序列号 +1 天（${ref}）`,
        mutation: `${String(serial)} → ${String(serial + 1)}`,
        expectFailing: ['field-equality（ExcelJS 路径解析值 vs 声明式期望值）'],
      },
      mutated,
    );
  }

  // NC3：进度 0.5 → 0.75——字段相等判据必须报错
  {
    const row = rowOfWbs('2.1');
    const ref = `${columnLetter(columnIndex('progress'))}${String(row)}`;
    const mutated = await mutateWorkbook(buffer, (xml) => replaceCellValue(xml, ref, '0.75'));
    await add(
      { name: `NC3 进度值被改（${ref}）`, mutation: '0.5 → 0.75', expectFailing: ['field-equality（ExcelJS 路径解析值 vs 声明式期望值）'] },
      mutated,
    );
  }

  // NC4：表头「前置任务」改名——表头判据必须报错，且依赖边全部丢失
  {
    const mutated = await mutateSharedStrings(buffer, '前置任务', '前置任务表');
    await add(
      {
        name: 'NC4 表头「前置任务」被改名',
        mutation: 'sharedStrings：前置任务 → 前置任务表',
        expectFailing: ['header-row（表头文本与列序）'],
      },
      mutated,
    );
  }

  // NC5：删掉最后一行的全部单元格——字段相等判据必须报错
  {
    const lastRow = rowOfWbs(FIXTURE[FIXTURE.length - 1]?.wbs ?? '5.9');
    const mutated = await mutateWorkbook(buffer, (xml) =>
      xml.replace(new RegExp(`<row\\b[^>]*\\br="${String(lastRow)}"[\\s\\S]*?</row>`), ''),
    );
    await add(
      { name: `NC5 删掉第 ${String(lastRow)} 行`, mutation: '移除该 <row>', expectFailing: ['field-equality（ExcelJS 路径解析值 vs 声明式期望值）'] },
      mutated,
    );
  }

  return controls;
}

// ---------------------------------------------------------------------------
// 时区陷阱取证
// ---------------------------------------------------------------------------

async function runTimezoneProbe(): Promise<TzProbeRow[]> {
  const probeIso = '2026-10-05';
  const buffer = await writeTzProbeWorkbook(probeIso);
  const rawSheet = await readRawSheet(buffer, 'tz-probe');

  const workbook = new ExcelJS.Workbook();
  await loadWorkbook(workbook, buffer);
  const worksheet = workbook.getWorksheet('tz-probe');
  assert.ok(worksheet !== undefined, '时区探针：ExcelJS 未找到工作表');

  const rows: TzProbeRow[] = [];
  for (let row = 2; row <= 5; row += 1) {
    const label = String(worksheet.getCell(row, 1).value ?? '');
    const raw = cellAt(rawSheet.cells, row, 2);
    const serial = raw?.number ?? Number.NaN;
    const readBack = worksheet.getCell(row, 2).value;
    rows.push({
      label,
      serialWritten: serial,
      integral: Math.abs(serial - Math.round(serial)) < 1e-9,
      excelDisplayDate: excelSerialToDisplayDate(serial),
      excelJsReadBack: readBack instanceof Date ? readBack.toISOString().slice(0, 10) : String(readBack),
      note: String(worksheet.getCell(row, 3).value ?? ''),
    });
  }

  // 探针自身的断言：UTC 零点必须整数化，本地零点必须**不是**整数（否则本机时区不构成样本）。
  const utcRow = rows.find((row) => row.label === 'Date.UTC(y,m-1,d)');
  const localRow = rows.find((row) => row.label === 'new Date(y,m-1,d)');
  assert.ok(utcRow !== undefined && utcRow.integral, '时区探针：UTC 构造未得到整数序列号');
  // 时区为 UTC 时本地构造也整数化，此时「陷阱」不成立——如实记录而不是断言失败。
  if (localRow !== undefined && localRow.integral) {
    localRow.note = `${localRow.note}（本机时区恰好为 UTC，陷阱不成立）`;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 部件内容指纹：只取「条目名 + 条目内容哈希」，**不取整文件哈希**（见下）。 */
export function partsFingerprint(parts: readonly PartInfo[]): string {
  const lines = parts.map((part) => `${part.name}=${part.sha256}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function runL1(): Promise<{ result: L1Result; workbook: Buffer }> {
  const workbook = await writeCanonicalWorkbook();
  const second = await writeCanonicalWorkbook();
  const first = await readRawSheet(workbook, SHEET_NAME);
  const secondRaw = await readRawSheet(second, SHEET_NAME);
  const judge = await judgeWorkbook(workbook);
  const checks: Check[] = [...judge.checks];

  /*
   * 确定性判据取**部件内容**而不是整文件字节。
   *
   * 实测（本 spike 取证）：`exceljs@4.4.0` 会把**写入时刻**写进 zip 条目的 DOS 时间戳，
   * 因此同一个模型在**不同秒**写两次，整文件字节不同（内容部件相同）——只有同秒内两次写出
   * 才逐字节相同。golden 比对若用文件哈希，会得到「永远不一致」的假失败。
   */
  const fingerprintFirst = partsFingerprint(first.workbook.parts);
  const fingerprintSecond = partsFingerprint(secondRaw.workbook.parts);
  const fileBytesIdentical = workbook.equals(second);
  const deterministic = fingerprintFirst === fingerprintSecond;
  checks.push({
    name: 'determinism（同一模型两次写出的**部件内容**逐字节一致）',
    passed: deterministic,
    detail: deterministic
      ? `部件指纹 \`${fingerprintFirst.slice(0, 16)}…\`（${String(first.workbook.parts.length)} 个部件）；` +
        `整文件字节${fileBytesIdentical ? '**也**相同（同秒写入）' : '不同——zip 条目时间戳 = 写入时刻，属预期'}`
      : `部件指纹不同：${fingerprintFirst.slice(0, 12)}… vs ${fingerprintSecond.slice(0, 12)}…`,
  });

  const visibleSheets = first.workbook.sheets.filter((sheet) => sheet.state === 'visible');
  checks.push({
    name: 'sheet-meta（单表、可见、无隐藏表、1900 日期系统）',
    passed:
      first.workbook.sheets.length === 1 &&
      visibleSheets.length === 1 &&
      first.workbook.sheets[0]?.name === SHEET_NAME &&
      !first.workbook.date1904,
    detail: `表=[${first.workbook.sheets.map((sheet) => `${sheet.name}/${sheet.state}`).join(', ')}]，日期系统=${first.workbook.date1904 ? '1904' : '1900'}`,
  });

  checks.push({
    name: 'fixture-coverage（样本覆盖四类关系、负/零/正 lag、多层与空日期）',
    passed:
      FIXTURE_STATS.relationTypes.length === 4 &&
      FIXTURE_STATS.maxDepth >= 2 &&
      FIXTURE_STATS.nullDates > 0 &&
      FIXTURE_STATS.edges >= 12,
    detail: `行=${String(FIXTURE_STATS.rows)}、边=${String(FIXTURE_STATS.edges)}、最大深度=${String(FIXTURE_STATS.maxDepth)}、里程碑=${String(FIXTURE_STATS.milestones)}、无日期行=${String(FIXTURE_STATS.nullDates)}、关系=${FIXTURE_STATS.relationTypes.join('/')}`,
  });

  const dateRepresentations = checkDateRepresentations(first.cells);
  checks.push(dateRepresentations.check);

  const negativeControls = await runNegativeControls(workbook);
  checks.push({
    name: 'negative-control（变造必被报出）',
    passed: negativeControls.every((control) => control.detected),
    detail: negativeControls
      .map((control) => `${control.name}：${control.detected ? '已报出' : '**未报出**'}`)
      .join('；'),
  });

  const tzProbe = await runTimezoneProbe();

  return {
    result: {
      checks,
      mismatches: judge.mismatches,
      edges: judge.edges,
      dualPathDifferences: judge.dualPathDifferences,
      diagnostics: judge.diagnostics,
      dateRepresentations: dateRepresentations.counts,
      negativeControls,
      tzProbe,
      duel: {
        excelJsCells: judge.excelJsCells,
        rawCells: judge.rawCells,
        sharedStrings: first.workbook.sharedStrings.length,
        parts: first.workbook.parts.length,
      },
      committed: {
        sizeBytes: workbook.byteLength,
        partsFingerprint: fingerprintFirst,
        parts: first.workbook.parts.length,
        deterministic,
        fileBytesIdentical,
      },
    },
    workbook,
  };
}

/** 供报告使用：把时区探针的对照写成 Markdown 表格行。 */
export function tzProbeSummary(rows: readonly TzProbeRow[]): string[] {
  return rows.map(
    (row) =>
      `| ${row.label} | ${String(row.serialWritten)} | ${row.integral ? '是（整数）' : '**否（含小数）**'} | ${row.excelDisplayDate} | ${row.excelJsReadBack} |`,
  );
}
