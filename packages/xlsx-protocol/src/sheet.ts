/**
 * 内部工作表模型：把 `exceljs` 的单元格值**归一化**成判别联合，后续所有解析都只看这个模型。
 *
 * 为什么要有这一层（S2 实测驱动）：
 * - `exceljs` 对同一格可能给 `Date`、数字、字符串、布尔、`{formula, result}`、富文本对象；
 * - **公式对象必须单独处理**，绝不落进"标量"分支（ADR 0006 §4 的三方容器口径）；
 * - 归一化一次，`values.ts` / `hierarchy.ts` / `dependencies.ts` 与 CSV 路径才能共用同一套容差。
 */

/** 归一化后的单元格值。 */
export type SheetCellValue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'boolean'; readonly boolean: boolean }
  /** `exceljs` 把序列号解释成的真日期；`hadTime` 记录它是否带时刻（→ `XLSX_DATE_HAS_TIME`）。 */
  | { readonly kind: 'date'; readonly date: Date; readonly hadTime: boolean }
  /** 公式单元格的缓存值被**扁平化**后的结果（永不保留公式文本）。 */
  | { readonly kind: 'formula'; readonly result: SheetCellValue }
  /** 错误值（`#DIV/0!` 等）/ 不可识别的容器形态。 */
  | { readonly kind: 'error'; readonly label: string }
  /** 公式存在但无缓存值——与"空单元格"**在库里同形**，但语义要并列展示（ADR 0006 §5）。 */
  | { readonly kind: 'missingFormula' };

/** 工作表中的一格。 */
export interface SheetCell {
  readonly value: SheetCellValue;
  /** 是否命中"日期格式"（只判**是否**日期格式，**不比对格式码文本**——WPS 会转义，S2 §三.2）。 */
  readonly dateFormatted: boolean;
  /** 缩进层级（仅用于缩进式层级解析；**解析不得依赖它的取值**，只用相对深度）。 */
  readonly indent: number;
}

/** 一只工作表。 */
export interface SheetView {
  readonly sheetName: string;
  /** 该表全部工作表名（顺序即工作簿顺序），供"指定表不存在"的提示用。 */
  readonly sheetNames: readonly string[];
  /** 最大行号（1 基）；无内容为 0。 */
  readonly maxRow: number;
  /** 最大列号（1 基）；无内容为 0。 */
  readonly maxColumn: number;
  cell(row: number, column: number): SheetCell | undefined;
  row(row: number): readonly SheetCell[] | undefined;
}

/** "行号 → 列号 → 单元格"的稀疏桶（`xlsx.ts` 与 `csv.ts` 填完它再交给 `sheetViewOf`）。 */
export type SheetCellBuckets = ReadonlyMap<number, ReadonlyMap<number, SheetCell>>;

/**
 * 由桶构造 `SheetView`（**唯一构造点**；P3/C2 前 `xlsx.ts` 与 `csv.ts` 各写了一份）。
 *
 * `row()` 按列号升序返回该行**已存在**的单元格（缺列不补空位）——两条读取路径共用同一口径。
 */
export function sheetViewOf(options: {
  readonly sheetName: string;
  readonly sheetNames: readonly string[];
  readonly maxRow: number;
  readonly maxColumn: number;
  readonly cells: SheetCellBuckets;
}): SheetView {
  const { cells } = options;
  return {
    sheetName: options.sheetName,
    sheetNames: options.sheetNames,
    maxRow: options.maxRow,
    maxColumn: options.maxColumn,
    cell: (row, column) => cells.get(row)?.get(column),
    row: (row) => {
      const bucket = cells.get(row);
      if (bucket === undefined) {
        return undefined;
      }
      return [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([, cell]) => cell);
    },
  };
}

/** 该格在文档语义上是否是"缺失"（空 / 公式无缓存值 / 空串 / 纯空白）。 */
export function isEmptyCell(cell: SheetCell | undefined): boolean {
  if (cell === undefined) {
    return true;
  }
  switch (cell.value.kind) {
    case 'empty':
    case 'missingFormula':
      return true;
    case 'text':
      return cell.value.text.trim() === '';
    default:
      return false;
  }
}

// ---------------------------------------------------------------- 日期格式判定

/**
 * 只判"**是否**日期格式"，**不比对格式码文本**（WPS 会把 `yyyy-mm-dd` 转义成 `yyyy\-mm\-dd`，S2 §三.2）。
 * 做法：剥掉引号内的字面量与转义，再把日期/时间占位符当成一个整体看是否出现。
 */
export function isDateFormatCode(numFmt: string | undefined): boolean {
  if (numFmt === undefined || numFmt.trim() === '') {
    return false;
  }
  const code = numFmt.split(';')[0] ?? '';
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /(y{2,4}|m{1,5}|d{1,4}|h{1,2}|s{1,2}|AM\/PM|A\/P)/i.test(stripped);
}

// ---------------------------------------------------------------- 字节流

/** 入参口径：`Uint8Array | ArrayBuffer`（**公共签名不出现 `Buffer`**，ADR 0006 §1）。 */
export type XlsxInput = Uint8Array | ArrayBuffer;

export function toUint8Array(input: XlsxInput): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}
