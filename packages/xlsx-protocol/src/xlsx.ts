/**
 * xlsx 字节流 → 内部工作表模型（`SheetView`）。
 *
 * 三条本文件必须守住的口径：
 * 1. **动态 `import()` ExcelJS**（ADR 0006 §11）：库内不得出现静态 import，
 *    否则 925.5 KB min / 251.6 KB gzip 会被打进浏览器首屏 chunk；
 * 2. **公式对象单独处理**（ADR 0006 §4/§5）：只读缓存值，`{formula, result: undefined}` 是
 *    "值缺失 + `XLSX_FORMULA_WITHOUT_CACHED_VALUE`"，与空单元格**同形但不同义**；
 * 3. **只判"是否日期格式"，不比对格式码文本**（WPS 会把 `yyyy-mm-dd` 转义成 `yyyy\-mm\-dd`）。
 */
import { DiagnosticBag, type XlsxDiagnostic } from './diagnostics.js';
import { SHEET_NAME } from './columns.js';
import {
  isDateFormatCode,
  sheetViewOf,
  toUint8Array,
  type SheetCell,
  type SheetCellValue,
  type SheetView,
  type XlsxInput,
} from './sheet.js';

/** 读表结果：判别联合，失败时只带诊断（绝不抛"用户级问题"）。 */
export type ReadSheetResult =
  | { readonly ok: true; readonly view: SheetView }
  | { readonly ok: false; readonly diagnostics: readonly XlsxDiagnostic[] };

/** 读表选项（工作表选择）。 */
export interface ReadSheetOptions {
  /** 期望的工作表名；缺省用首个工作表，或（表名恰好是规范名时）规范表。 */
  readonly sheet?: string;
  /**
   * 是否接受"首个工作表"兜底。`detectColumns` 为 `true`（向导第 1 步要看到用户的表），
   * `importXlsx` 为 `false`（未指定表名时优先规范表 `任务`，否则"静默读了别的表"会误导）。
   */
  readonly allowFirstSheetFallback: boolean;
}

interface NormalizedValue {
  readonly value: SheetCellValue;
  /** 该格是否按"日期"承载（`Date` 实例；"数值 + 日期格式"由 `dateFormatted` 单独承载）。 */
  readonly asDate: boolean;
  readonly hadTime: boolean;
}

function normalizeDate(date: Date): NormalizedValue {
  const hadTime =
    date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0;
  return { value: { kind: 'date', date, hadTime }, asDate: true, hadTime };
}

function normalizeScalar(value: unknown): NormalizedValue {
  if (value === null || value === undefined) {
    return { value: { kind: 'empty' }, asDate: false, hadTime: false };
  }
  if (value instanceof Date) {
    return normalizeDate(value);
  }
  if (typeof value === 'string') {
    return { value: { kind: 'text', text: value }, asDate: false, hadTime: false };
  }
  if (typeof value === 'number') {
    // 「数值 + 日期格式」**不在这里提升为 `Date`**：`SheetCell.dateFormatted` 已经承载了这条信息，
    // 而 `parseDateCell` 会用 `isoFromSerial` 把它按序列号解读（两条读取路径在类型层自然汇合）。
    // 若在这里先换算成 `Date`，再交给 `isoFromDate`（它对 `Date` 用本地 getter），
    // 就会把"序列号"当成"绝对时刻"再取一次本地日历日 —— 实测会得到 2166-10-09 这种错日期。
    return { value: { kind: 'number', number: value }, asDate: false, hadTime: false };
  }
  if (typeof value === 'boolean') {
    return { value: { kind: 'boolean', boolean: value }, asDate: false, hadTime: false };
  }
  return { value: { kind: 'error', label: 'unrecognized' }, asDate: false, hadTime: false };
}

function normalizeCellValue(value: unknown, numFmt: string | undefined): NormalizedValue {
  if (value === null || value === undefined) {
    return { value: { kind: 'empty' }, asDate: false, hadTime: false };
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    // 公式：单独处理，**绝不自研求值器**，也不保留公式文本（ADR 0006 §5）
    if ('formula' in record || 'sharedFormula' in record) {
      const result = record['result'];
      if (result === undefined || result === null) {
        // 无缓存值：按"值缺失"处理，标记与空单元格区分开
        return { value: { kind: 'missingFormula' }, asDate: false, hadTime: false };
      }
      const inner = normalizeCellValue(result, numFmt);
      return { value: inner.value, asDate: inner.asDate, hadTime: inner.hadTime };
    }

    // 富文本：拍平成纯文本（不保留富文本格式，导出也只写纯文本）
    if ('richText' in record) {
      const runs = record['richText'];
      const text = Array.isArray(runs)
        ? runs
            .map((run) => (typeof (run as { text?: unknown }).text === 'string' ? (run as { text: string }).text : ''))
            .join('')
        : '';
      return { value: { kind: 'text', text }, asDate: false, hadTime: false };
    }

    // 超链接单元格：`{text, hyperlink}` → 文本
    if ('text' in record && 'hyperlink' in record && typeof record['text'] === 'string') {
      return { value: { kind: 'text', text: record['text'] }, asDate: false, hadTime: false };
    }

    // 错误值 `{error: '#DIV/0!'}`：与"空"不同形，报错由调用方按"不可解析"处理
    if ('error' in record) {
      return { value: { kind: 'error', label: String(record['error']) }, asDate: false, hadTime: false };
    }
  }
  return normalizeScalar(value);
}

/** 定位读取目标工作表；失败时给出 `XLSX_SHEET_NOT_FOUND`（带可用表名）。 */
function pickSheet(
  names: readonly string[],
  requested: string | undefined,
  allowFirstSheetFallback: boolean,
): string | null {
  if (names.length === 0) {
    return null;
  }
  if (requested !== undefined && requested !== '') {
    return names.includes(requested) ? requested : null;
  }
  if (names.includes(SHEET_NAME)) {
    return SHEET_NAME;
  }
  return allowFirstSheetFallback ? (names[0] ?? null) : null;
}

/** 读取 xlsx 字节流为内部工作表模型。 */
export async function readXlsx(input: XlsxInput, options: ReadSheetOptions): Promise<ReadSheetResult> {
  const bag = new DiagnosticBag();
  const { default: ExcelJS } = await import('exceljs');

  const workbook = new ExcelJS.Workbook();
  const bytes = toUint8Array(input);
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const names = workbook.worksheets.map((sheet) => sheet.name);
  const targetName = pickSheet(names, options.sheet, options.allowFirstSheetFallback);
  if (targetName === null) {
    const requested = options.sheet ?? SHEET_NAME;
    bag.add('XLSX_SHEET_NOT_FOUND', `找不到工作表「${requested}」；文件里的工作表：${names.join('、') || '（无）'}`, {
      locator: { sheet: requested },
    });
    return { ok: false, diagnostics: bag.items };
  }

  const worksheet = workbook.getWorksheet(targetName);
  if (worksheet === undefined) {
    bag.add('XLSX_SHEET_NOT_FOUND', `工作表「${targetName}」不可读`, { locator: { sheet: targetName } });
    return { ok: false, diagnostics: bag.items };
  }

  const rows = new Map<number, Map<number, SheetCell>>();
  let maxRow = 0;
  let maxColumn = 0;

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const rowNumber = row.number;
    // `colNumber` 用回调给的第二参，而不是 `cell.col`：后者在 exceljs 的 d.ts 里被一个
    // 全局 `Address` 声明（`col: string`）覆盖，取它会让 tsc 报错——运行时两者都是数。
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const numFmt = typeof cell.numFmt === 'string' ? cell.numFmt : undefined;
      const normalized = normalizeCellValue(cell.value, numFmt);
      const indent = typeof cell.alignment?.indent === 'number' ? cell.alignment.indent : 0;
      const columnNumber = Number(colNumber);
      const model: SheetCell = {
        value: normalized.value,
        dateFormatted: normalized.asDate || isDateFormatCode(numFmt),
        indent,
      };
      let bucket = rows.get(rowNumber);
      if (bucket === undefined) {
        bucket = new Map();
        rows.set(rowNumber, bucket);
      }
      bucket.set(columnNumber, model);
      maxRow = Math.max(maxRow, rowNumber);
      maxColumn = Math.max(maxColumn, columnNumber);
    });
  });
  const view = sheetViewOf({ sheetName: targetName, sheetNames: names, maxRow, maxColumn, cells: rows });

  return { ok: true, view };
}
