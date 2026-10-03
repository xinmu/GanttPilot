/**
 * G0-S-S2 · **两条读取路径的公共视图**。
 *
 * 路径 A：`viewFromExcelJS`  —— ExcelJS 对象 API（会按数字格式把序列号解释成 `Date`）。
 * 路径 B：`viewFromRaw`      —— zip 层原始单元格（`raw-read.ts`）。
 *
 * 两条路径产出的 `SheetView` 必须**逐格等价**（`verify-l1.ts` 的 `dual-path` 断言）。
 * 之所以引入这层视图，是为了让差异可定位到「单元格」，而不是淹没在两种 API 的形状差异里。
 */

import type { Worksheet } from 'exceljs';

import type { RawCell } from './raw-read.ts';

export type ViewKind = 'empty' | 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'error';

export interface ViewCell {
  readonly ref: string;
  readonly row: number;
  readonly column: number;
  readonly kind: ViewKind;
  readonly text: string | null;
  readonly number: number | null;
  readonly boolean: boolean | null;
  /** 日期类单元格的 `yyyy-mm-dd`（UTC 解释，与 D-4 的「日期」基准一致）。 */
  readonly dateIso: string | null;
  readonly formula: string | null;
  readonly numFmt: string | null;
  /** 样式里的 `alignment indent`（**归一化**：缺失记 0）。解析不得依赖它。 */
  readonly indent: number;
}

export interface SheetView {
  readonly sheetName: string;
  readonly cells: readonly ViewCell[];
  readonly maxRow: number;
  readonly maxColumn: number;
}

/** 单元格的**语义指纹**（双路径比对与变异检测都用它；含样式层的缩进）。 */
export function cellFingerprint(cell: ViewCell): string {
  const value =
    cell.text ?? cell.dateIso ?? (cell.number === null ? null : String(cell.number)) ??
    (cell.boolean === null ? null : String(cell.boolean)) ?? (cell.formula === null ? null : `=${cell.formula}`);
  return `${cell.kind}:${value ?? ''}|indent=${String(cell.indent)}`;
}

function utcDateToIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function bounds(cells: readonly ViewCell[]): { maxRow: number; maxColumn: number } {
  let maxRow = 0;
  let maxColumn = 0;
  for (const cell of cells) {
    if (cell.row > maxRow) maxRow = cell.row;
    if (cell.column > maxColumn) maxColumn = cell.column;
  }
  return { maxRow, maxColumn };
}

interface ExcelJSValueShapes {
  richText?: readonly { text: string }[];
  formula?: string;
  sharedFormula?: string;
  error?: string;
  text?: string;
  hyperlink?: string;
}

/** 路径 A：ExcelJS 对象 API。 */
export function viewFromExcelJS(sheet: Worksheet): SheetView {
  const cells: ViewCell[] = [];
  const columnCount = Math.max(sheet.columnCount, 1);
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = sheet.getCell(row, column);
      const numFmt = cell.numFmt ?? null;
      const indent = cell.alignment?.indent ?? 0;
      const ref = cell.address;
      const value: unknown = cell.value;

      const base = {
        ref,
        row,
        column,
        text: null as string | null,
        number: null as number | null,
        boolean: null as boolean | null,
        dateIso: null as string | null,
        formula: null as string | null,
        numFmt,
        indent,
      };

      if (value === null || value === undefined) {
        continue; // 稀疏视图：没有值的格子不出现（与 zip 层一致）
      } else if (value instanceof Date) {
        cells.push({ ...base, kind: 'date', dateIso: utcDateToIso(value) });
      } else if (typeof value === 'number') {
        cells.push({ ...base, kind: 'number', number: value });
      } else if (typeof value === 'boolean') {
        cells.push({ ...base, kind: 'boolean', boolean: value });
      } else if (typeof value === 'string') {
        cells.push({ ...base, kind: 'string', text: value });
      } else {
        const shaped = value as ExcelJSValueShapes;
        if (shaped.richText !== undefined) {
          cells.push({ ...base, kind: 'string', text: shaped.richText.map((run) => run.text).join('') });
        } else if (shaped.formula !== undefined || shaped.sharedFormula !== undefined) {
          cells.push({ ...base, kind: 'formula', formula: shaped.formula ?? shaped.sharedFormula ?? '' });
        } else if (shaped.error !== undefined) {
          cells.push({ ...base, kind: 'error', text: shaped.error });
        } else if (shaped.hyperlink !== undefined) {
          cells.push({ ...base, kind: 'string', text: shaped.text ?? '' });
        } else {
          cells.push({ ...base, kind: 'error', text: JSON.stringify(value) });
        }
      }
    }
  }

  return { sheetName: sheet.name, cells, ...bounds(cells) };
}

/** 路径 B：zip 层原始单元格。 */
export function viewFromRaw(sheetName: string, rawCells: readonly RawCell[]): SheetView {
  const cells: ViewCell[] = rawCells.map((cell) => {
    const base = {
      ref: cell.ref,
      row: cell.row,
      column: cell.column,
      text: null as string | null,
      number: null as number | null,
      boolean: null as boolean | null,
      dateIso: null as string | null,
      formula: null as string | null,
      numFmt: cell.numFmt,
      indent: cell.indent ?? 0,
    };

    switch (cell.kind) {
      case 'shared':
      case 'inline':
      case 'string':
        return { ...base, kind: 'string' as const, text: cell.text ?? '' };
      case 'boolean':
        return { ...base, kind: 'boolean' as const, boolean: cell.number === 1 };
      case 'number':
        if (cell.isDateFormat && cell.number !== null) {
          // 1900 系统：序列号 → UTC 零点（与 ExcelJS 的 excelToDate 同一口径）。
          const utcMs = Math.round((cell.number - 25569) * 86_400_000);
          return { ...base, kind: 'date' as const, dateIso: new Date(utcMs).toISOString().slice(0, 10) };
        }
        return { ...base, kind: 'number' as const, number: cell.number };
      case 'date-iso':
        return { ...base, kind: 'date' as const, dateIso: (cell.text ?? '').slice(0, 10) };
      case 'formula':
        return { ...base, kind: 'formula' as const, formula: cell.formula ?? '' };
      case 'error':
        return { ...base, kind: 'error' as const, text: cell.text ?? '' };
      case 'empty':
        return { ...base, kind: 'empty' as const };
      default:
        return { ...base, kind: 'error' as const, text: `未知类型：${String(cell.kind)}` };
    }
  });

  return { sheetName, cells, ...bounds(cells) };
}

/** 清掉 indent 的副本：用于证明「解析不依赖缩进」。 */
export function withoutIndent(view: SheetView): SheetView {
  return { ...view, cells: view.cells.map((cell) => ({ ...cell, indent: 0 })) };
}
