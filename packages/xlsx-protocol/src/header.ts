/**
 * 表头定位与列探测（ADR 0006 §2/§7 的 `detectColumns`）。
 *
 * 脏文件的两类真实形态在这里被"判而不猜"：
 * - **多行表头**：规范列名分散在相邻两行 → 没有任何一行能凑齐必需列 → `XLSX_HEADER_ROW_INVALID`；
 * - **合并单元格表头**：ExcelJS 只把值给合并区域的首格，因此"跨列的规范列名"同样凑不齐 → 同一条码。
 *
 * 表头行**按命中数打分**（不是"第一个像表头的行"），因此表头上方有标题行/说明行也能正确落点。
 */
import { COLUMN_SPECS, columnSpecOfHeader, type ColumnKey, type ColumnSpec } from './columns.js';
import { DiagnosticBag, columnLetter, type XlsxDiagnostic } from './diagnostics.js';
import type { SheetView } from './sheet.js';

/** 列定位（1 基列号）。 */
export interface ColumnBinding {
  readonly key: ColumnKey;
  readonly header: string;
  readonly column: number;
  /** A1 的列字母（便于诊断与跳转）。 */
  readonly letter: string;
}

/** 列探测结论（供向导第 1–2 步）。 */
export interface ColumnDetection {
  readonly sheetName: string;
  /** 1 基表头行；未识别时为 `null`。 */
  readonly headerRow: number | null;
  readonly bindings: readonly ColumnBinding[];
  /** 命中的规范列键。 */
  readonly recognized: readonly ColumnKey[];
  /** 未命中的规范列键。 */
  readonly missing: readonly ColumnKey[];
  /** 未匹配到任何规范列的表头（列号 + 原文），交向导第 2 步人工映射。 */
  readonly unrecognized: readonly { readonly column: number; readonly header: string }[];
  /** 表头行之后是否存在任何非空行。 */
  readonly hasDataRows: boolean;
}

/** 列探测结果（`ok` 与诊断一起返回；`ok:false` 表示向导无法继续）。 */
export interface ColumnDetectionResult {
  readonly ok: boolean;
  readonly detection: ColumnDetection;
  readonly diagnostics: readonly XlsxDiagnostic[];
}

/** 找出"看起来最像表头"的行：命中规范列名最多的那一行（并列取最靠前）。 */
export function locateHeaderRow(view: SheetView): { readonly row: number; readonly bindings: readonly ColumnBinding[] } | null {
  let best: { row: number; bindings: readonly ColumnBinding[] } | null = null;
  const scanLimit = Math.min(view.maxRow, 20);

  for (let row = 1; row <= scanLimit; row += 1) {
    const found = new Map<ColumnKey, ColumnBinding>();
    for (let column = 1; column <= view.maxColumn; column += 1) {
      const cell = view.cell(row, column);
      if (cell === undefined || cell.value.kind !== 'text') {
        continue;
      }
      const spec: ColumnSpec | undefined = columnSpecOfHeader(cell.value.text);
      if (spec === undefined || found.has(spec.key)) {
        continue;
      }
      found.set(spec.key, {
        key: spec.key,
        header: spec.header,
        column,
        letter: columnLetter(column),
      });
    }
    if (best === null || found.size > best.bindings.length) {
      best = { row, bindings: [...found.values()] };
    }
  }

  if (best === null || best.bindings.length === 0) {
    return null;
  }
  const bindings = [...best.bindings].sort((a, b) => a.column - b.column);
  return { row: best.row, bindings };
}

const REQUIRED_KEYS: readonly ColumnKey[] = COLUMN_SPECS.filter((spec) => spec.requirement === 'required').map(
  (spec) => spec.key,
);

/** 探测列（不抛错：所有问题以协议诊断返回）。 */
export function detectColumnsInView(view: SheetView): ColumnDetectionResult {
  const bag = new DiagnosticBag();
  const located = locateHeaderRow(view);

  if (located === null) {
    bag.add(
      'XLSX_HEADER_ROW_INVALID',
      `未找到可识别的表头行（需要至少一个规范列名：${COLUMN_SPECS.map((spec) => spec.header).join('、')}）`,
      { locator: { sheet: view.sheetName, row: 1 } },
    );
    return {
      ok: false,
      detection: {
        sheetName: view.sheetName,
        headerRow: null,
        bindings: [],
        recognized: [],
        missing: COLUMN_SPECS.map((spec) => spec.key),
        unrecognized: [],
        hasDataRows: view.maxRow > 1,
      },
      diagnostics: bag.items,
    };
  }

  const recognized = located.bindings.map((binding) => binding.key);
  const missing = COLUMN_SPECS.filter((spec) => !recognized.includes(spec.key)).map((spec) => spec.key);

  // 表头行上"没匹配到任何规范列"的表头 → 交向导人工映射（列出全部）
  const headerTexts = new Map<number, string>();
  for (let column = 1; column <= view.maxColumn; column += 1) {
    const cell = view.cell(located.row, column);
    if (cell === undefined || cell.value.kind !== 'text') {
      continue;
    }
    const text = cell.value.text.trim();
    if (text !== '') {
      headerTexts.set(column, text);
    }
  }
  const boundColumns = new Set(located.bindings.map((binding) => binding.column));
  const unrecognized = [...headerTexts.entries()]
    .filter(([column]) => !boundColumns.has(column))
    .map(([column, header]) => ({ column, header }))
    .sort((a, b) => a.column - b.column);

  if (unrecognized.length > 0) {
    bag.add(
      'XLSX_UNRECOGNIZED_COLUMN',
      `未识别的列（可由向导第 2 步人工映射）：${unrecognized
        .map((entry) => `${entry.header}(${columnLetter(entry.column)})`)
        .join('、')}`,
      { locator: { sheet: view.sheetName, row: located.row } },
    );
  }

  // **必需列**：`任务名称` 缺失即阻断；`WBS` 与缩进式是"二选一"，
  // 因此层级列的二选一由 `importXlsx` 在看完数据行后判定（这里只报 `任务名称`）。
  const missingName = REQUIRED_KEYS.some((key) => !recognized.includes(key));
  if (missingName) {
    bag.add(
      'XLSX_REQUIRED_COLUMN_MISSING',
      `缺少必需列：${REQUIRED_KEYS.filter((key) => !recognized.includes(key))
        .map((key) => COLUMN_SPECS.find((spec) => spec.key === key)?.header ?? key)
        .join('、')}`,
      { locator: { sheet: view.sheetName, row: located.row } },
    );
  }

  return {
    ok: !missingName,
    detection: {
      sheetName: view.sheetName,
      headerRow: located.row,
      bindings: located.bindings,
      recognized,
      missing,
      unrecognized,
      hasDataRows: view.maxRow > located.row,
    },
    diagnostics: bag.items,
  };
}
