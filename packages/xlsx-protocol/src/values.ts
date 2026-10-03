/**
 * 单元格容差（ADR 0006 §4 的**闭集**）。
 *
 * "导出形态"是单一确定形态；"导入必须接受"是一个闭集——**不在集合内的形态一律给诊断，不做猜测**。
 * 每个解析函数只回答"这个单元格是什么值"，定位（行/列/地址）由调用方通过 `Reporter` 注入。
 */
import type { ColumnKey } from './columns.js';
import type { XlsxDiagnosticCode } from './diagnostics.js';
import { isoFromDate, isoFromSerial, MAX_DATE_SERIAL, MIN_DATE_SERIAL, parseDateText, serialHasTime } from './dates.js';
import type { SheetCell } from './sheet.js';

/** 上报一条协议诊断（定位信息由调用方闭包注入）。 */
export type Reporter = (
  code: XlsxDiagnosticCode,
  message: string,
  detail?: { readonly column?: ColumnKey; readonly taskId?: string; readonly linkId?: string },
) => void;

/** 单元格文本内容（用于判定；不做 trim —— trim 只在语义相关时按 `XLSX_TEXT_TRIMMED` 报告）。 */
export function cellText(cell: SheetCell | undefined): string {
  if (cell === undefined) {
    return '';
  }
  switch (cell.value.kind) {
    case 'text':
      return cell.value.text;
    case 'number': {
      // 数值文本化：整数不带小数点，浮点交由各自的解析器判定
      return String(cell.value.number);
    }
    case 'boolean':
      return String(cell.value.boolean);
    case 'date':
      return isoFromDate(cell.value.date);
    default:
      return '';
  }
}

/** 单元格是否"缺失"（空 / 空串 / 纯空白）。 */
export function isBlank(cell: SheetCell | undefined): boolean {
  if (cell === undefined || cell.value.kind === 'empty') {
    return true;
  }
  if (cell.value.kind === 'text') {
    return cell.value.text.trim() === '';
  }
  return false;
}

/**
 * 空串 / 纯空白 → 按缺失处理 + `XLSX_INFERRED_EMPTY_CELL`(info)（ADR 0006 §2：**容忍而不静默**）。
 */
export function reportInferredEmpty(cell: SheetCell | undefined, reporter: Reporter, column: ColumnKey): void {
  if (cell !== undefined && cell.value.kind === 'text' && cell.value.text.trim() === '') {
    reporter('XLSX_INFERRED_EMPTY_CELL', `单元格是空串/纯空白（${JSON.stringify(cell.value.text)}），按缺失处理`, {
      column,
    });
  }
}

/** "严格数值文本"：只接受 `[-+]?digits[.digits][e±digits]`，拒绝 `0x10` / `Infinity` 这类 `Number()` 会放行的写法。 */
function numericText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** 单元格 → 数值（`number` 直取；`text` 走严格数值文本；其余不可用）。 */
export function numberValue(cell: SheetCell | undefined): number | undefined {
  if (cell === undefined) {
    return undefined;
  }
  if (cell.value.kind === 'number') {
    return cell.value.number;
  }
  if (cell.value.kind === 'text') {
    return numericText(cell.value.text);
  }
  return undefined;
}

// ---------------------------------------------------------------- 日期

/**
 * 日期解析（ADR 0006 §4）：接受 ① 真日期（序列号）② 整数数值序列号 ③ ISO 文本 `yyyy-mm-dd`
 * ④ `yyyy/m/d`。
 *
 * `columnIsDate` 由调用方按**列契约**给出：本项目的日期列（`开始`/`完成`）里，
 * 裸数值一律按序列号解读——这是容差表"非日期的数字落在合法区间内即按序列号解读"的落地。
 */
export function parseDateCell(
  cell: SheetCell | undefined,
  reporter: Reporter,
  column: ColumnKey,
  columnIsDate: boolean,
): string | null {
  if (isBlank(cell)) {
    reportInferredEmpty(cell, reporter, column);
    return null;
  }
  if (cell === undefined) {
    return null;
  }

  if (cell.value.kind === 'missingFormula') {
    // 公式存在但无缓存值：与"文件里本来就空着"**同形但不同义**（ADR 0006 §5），
    // 必须按"值缺失"处理并报这条 info，而不是落进"无法解析"。
    reporter('XLSX_FORMULA_WITHOUT_CACHED_VALUE', '公式单元格没有缓存值，按值缺失处理', { column });
    return null;
  }

  if (cell.value.kind === 'date') {
    // **真日期路径不判"带时刻"**：`Date` 是序列号换算出的绝对时刻，它的时/分/秒反映的是时区偏移
    // （UTC+8 下 `getHours()` 恒为 8），用它判定会把**每个整日日期**都误报成"带时刻"。
    // 「带时刻」的判据只认**序列号的小数部分**（ADR 0006 §4），因此只在数值路径上判定。
    return isoFromDate(cell.value.date);
  }

  if (cell.value.kind === 'number') {
    if (!(cell.dateFormatted || columnIsDate)) {
      reporter('XLSX_DATE_UNPARSABLE', `该数值没有日期格式，也不是日期列：${String(cell.value.number)}`, { column });
      return null;
    }
    return serialToIso(cell.value.number, reporter, column);
  }

  if (cell.value.kind === 'text') {
    const parts = parseDateText(cell.value.text);
    if (parts !== undefined) {
      return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    }
    // 文本但内容是数值 → 仍按序列号解读（与"数值序列号"同容差）
    const asNumber = numericText(cell.value.text);
    if (asNumber !== undefined) {
      return serialToIso(asNumber, reporter, column);
    }
    reporter('XLSX_DATE_UNPARSABLE', `无法解析为日期：${JSON.stringify(cell.value.text)}`, { column });
    return null;
  }

  reporter('XLSX_DATE_UNPARSABLE', `该单元格类型不能作为日期：${cell.value.kind}`, { column });
  return null;
}

function serialToIso(serial: number, reporter: Reporter, column: ColumnKey): string | null {
  if (serial < MIN_DATE_SERIAL) {
    reporter('XLSX_DATE_OUT_OF_RANGE', `序列号 ${String(serial)} 早于 1900-01-01（< 1）`, { column });
    return null;
  }
  if (serial > MAX_DATE_SERIAL) {
    reporter('XLSX_DATE_OUT_OF_RANGE', `序列号 ${String(serial)} 超出可表示域`, { column });
    return null;
  }
  if (serialHasTime(serial)) {
    reporter('XLSX_DATE_HAS_TIME', `序列号 ${String(serial)} 带时刻，按 UTC 取日期部分`, { column });
  }
  const iso = isoFromSerial(serial);
  if (iso === null) {
    reporter('XLSX_DATE_OUT_OF_RANGE', `序列号 ${String(serial)} 不对应任何合法日期`, { column });
    return null;
  }
  return iso;
}

// ---------------------------------------------------------------- 工期

/** 工期解析：数值 / 数值文本；小数与负数分别报错，`0` 合法（里程碑）。空 = 缺失。 */
export function parseDurationCell(cell: SheetCell | undefined, reporter: Reporter, column: ColumnKey): number | null {
  if (isBlank(cell)) {
    reportInferredEmpty(cell, reporter, column);
    return null;
  }
  const value = numberValue(cell);
  if (value === undefined) {
    reporter('XLSX_DURATION_NOT_INTEGER', '工期不是数值', { column });
    return null;
  }
  if (!Number.isInteger(value)) {
    // **不四舍五入**：静默改数会让用户以为"3.5 天被接受了"
    reporter('XLSX_DURATION_NOT_INTEGER', `工期必须是整数工作日，收到 ${String(value)}`, { column });
    return null;
  }
  if (value < 0) {
    reporter('XLSX_DURATION_NEGATIVE', `工期不能为负：${String(value)}`, { column });
    return null;
  }
  return value;
}

// ---------------------------------------------------------------- 进度

/** 进度解析：数字或数值文本，`≤ 1` 视为分数、`> 1` 视为百分数；`50%` 文本。 */
export function parseProgressCell(cell: SheetCell | undefined, reporter: Reporter, column: ColumnKey): number | null {
  if (isBlank(cell)) {
    reportInferredEmpty(cell, reporter, column);
    return null;
  }
  if (cell === undefined) {
    return null;
  }

  if (cell.value.kind === 'text') {
    const trimmed = cell.value.text.trim();
    if (trimmed.endsWith('%')) {
      const parsed = numericText(trimmed.slice(0, -1));
      if (parsed === undefined) {
        reporter('XLSX_PROGRESS_UNPARSABLE', `进度无法解析为百分数：${JSON.stringify(cell.value.text)}`, { column });
        return null;
      }
      return percentToFraction(parsed, reporter, column);
    }
  }

  const value = numberValue(cell);
  if (value === undefined) {
    reporter('XLSX_PROGRESS_UNPARSABLE', `进度不是数值：${cellText(cell)}`, { column });
    return null;
  }
  // ≤ 1 视为分数（含 0 与 1 本身），> 1 视为百分数点位
  return value <= 1 ? value : percentToFraction(value, reporter, column);
}

function percentToFraction(percent: number, reporter: Reporter, column: ColumnKey): number | null {
  if (percent < 0 || percent > 100) {
    reporter('XLSX_PROGRESS_OUT_OF_RANGE', `进度必须在 0..100 之间（百分数口径），收到 ${String(percent)}`, {
      column,
    });
    return null;
  }
  return percent / 100;
}

// ---------------------------------------------------------------- 里程碑

const MILESTONE_TRUE = new Set(['是', 'true', '1', 'y', 'yes']);
const MILESTONE_FALSE = new Set(['否', 'false', '0', 'n', 'no']);

/** 里程碑解析：布尔 / `是`·`否` / `TRUE`·`FALSE`（大小写不敏感）/ `1`·`0`（数值与文本）。 */
export function parseMilestoneCell(cell: SheetCell | undefined, reporter: Reporter, column: ColumnKey): boolean {
  if (isBlank(cell)) {
    reportInferredEmpty(cell, reporter, column);
    return false;
  }
  if (cell === undefined) {
    return false;
  }
  if (cell.value.kind === 'boolean') {
    return cell.value.boolean;
  }
  if (cell.value.kind === 'number') {
    return cell.value.number !== 0;
  }
  if (cell.value.kind === 'text') {
    const normalized = cell.value.text.trim().toLowerCase();
    if (MILESTONE_TRUE.has(normalized)) {
      return true;
    }
    if (MILESTONE_FALSE.has(normalized)) {
      return false;
    }
  }
  reporter('XLSX_MILESTONE_UNRECOGNIZED', `里程碑取值不在容差集合内（按 false 处理）：${cellText(cell)}`, {
    column,
  });
  return false;
}

// ---------------------------------------------------------------- 文本

/**
 * 文本单元格：**原样字符串**（含 `=`/`+`/`-`/`@` 前缀、emoji、超长文本；不设长度上限、不转义、不改换行）。
 *
 * 与文档语义相关的**前后空白**会报 `XLSX_TEXT_TRIMMED`(info)，但返回的仍是**原样字符串**
 * （ADR 0006 §8 "文本原样"，§4 的 trim 只用于判定用途）。
 */
export function parseTextCell(cell: SheetCell | undefined, reporter: Reporter, column: ColumnKey): string | null {
  if (cell === undefined || cell.value.kind === 'empty') {
    return null;
  }
  if (cell.value.kind === 'text') {
    if (cell.value.text.trim() === '') {
      reporter('XLSX_INFERRED_EMPTY_CELL', '单元格是空串/纯空白，按缺失处理', { column });
      return null;
    }
    if (cell.value.text.trim() !== cell.value.text) {
      reporter('XLSX_TEXT_TRIMMED', `首尾空白与文档语义相关（原样保留）：${JSON.stringify(cell.value.text)}`, { column });
    }
    return cell.value.text;
  }
  return cellText(cell);
}
