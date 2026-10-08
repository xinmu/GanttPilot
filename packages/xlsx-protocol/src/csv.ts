/**
 * CSV 尽力导入（ADR 0006 §9 / XL-07）。
 *
 * **复用同一套列契约、容差表与诊断码表**（不另立第二套规则）：本文件只负责"字节 → 内部工作表模型"，
 * 之后的解析完全走 `buildDocumentFromView`。
 *
 * 明确**不支持**（给出诊断而不是错误解析）：多行单元格、分隔符嗅探、`.xls`(BIFF)。
 * CSV 导出不在 v0.1 承诺内；若日后实现，**必须**做公式注入转义（`=`/`+`/`-`/`@` 前缀）——
 * 这与 xlsx 路径的豁免**不同源**：CSV 没有"共享字符串"这层保护。
 */
import { DiagnosticBag, type XlsxDiagnostic } from './diagnostics.js';
import { sheetViewOf, toUint8Array, type SheetCell, type SheetView, type XlsxInput } from './sheet.js';

/**
 * UTF-8 解码（含 BOM），**不用 `TextDecoder`**：三包的 `tsconfig` 收窄了 `lib`（无 DOM，也没有
 * `TextDecoder` 这类 Web API 声明）。手写解码只有几十行，且让"编码容差"这件事留在我们自己的代码里
 * ——WPS/Excel 导出的 CSV 实测就是 UTF-8（含或不含 BOM）。**不做编码嗅探**（ADR 0006 §9）。
 */
export function decodeUtf8(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    if (byte < 0x80) {
      codePoints.push(byte);
      index += 1;
      continue;
    }
    if (byte >= 0xc2 && byte <= 0xdf) {
      const second = bytes[index + 1];
      if (second === undefined || (second & 0xc0) !== 0x80) {
        codePoints.push(0xfffd);
        index += 1;
        continue;
      }
      codePoints.push(((byte & 0x1f) << 6) | (second & 0x3f));
      index += 2;
      continue;
    }
    if (byte >= 0xe0 && byte <= 0xef) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      if (second === undefined || third === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) {
        codePoints.push(0xfffd);
        index += 1;
        continue;
      }
      codePoints.push(((byte & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      index += 3;
      continue;
    }
    if (byte >= 0xf0 && byte <= 0xf4) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const fourth = bytes[index + 3];
      if (
        second === undefined ||
        third === undefined ||
        fourth === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (fourth & 0xc0) !== 0x80
      ) {
        codePoints.push(0xfffd);
        index += 1;
        continue;
      }
      codePoints.push(
        ((byte & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f),
      );
      index += 4;
      continue;
    }
    codePoints.push(0xfffd);
    index += 1;
  }

  // 分块拼接，避免 `String.fromCharCode(...arr)` 在长文件上爆栈
  let text = '';
  const chunk = 4096;
  for (let offset = 0; offset < codePoints.length; offset += chunk) {
    text += String.fromCharCode(...codePoints.slice(offset, offset + chunk));
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** CSV → 记录（可选双引号包裹、`""` 表示字面量引号；**不支持**多行单元格）。 */
export function parseCsvRecords(text: string): readonly (readonly string[])[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    records.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') {
        index += 1;
      }
      pushRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  return records;
}

/** 单元格文本 → 内部单元格模型（CSV 里只有文本，数值/日期的解读交给 `values.ts` 的容差）。 */
function cellOfText(text: string): SheetCell {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { value: { kind: 'empty' }, dateFormatted: false, indent: 0 };
  }
  return { value: { kind: 'text', text }, dateFormatted: false, indent: 0 };
}

/** CSV 读表结论。 */
export type ReadCsvResult =
  | { readonly ok: true; readonly view: SheetView; readonly diagnostics: readonly XlsxDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly XlsxDiagnostic[] };

/** CSV 字节流 → 内部工作表模型（单表 `任务`；行号 1 基、与文件一致）。 */
export function readCsv(input: XlsxInput, sheetName = '任务'): ReadCsvResult {
  const bag = new DiagnosticBag();
  const text = decodeUtf8(toUint8Array(input));
  const records = parseCsvRecords(text);

  // 空文件：交给上层的"表头无法识别"路径处理，这里只回一个空表
  const cells = new Map<number, Map<number, SheetCell>>();
  let maxColumn = 0;
  records.forEach((record, rowIndex) => {
    const bucket = new Map<number, SheetCell>();
    record.forEach((value, columnIndex) => {
      bucket.set(columnIndex + 1, cellOfText(value));
    });
    maxColumn = Math.max(maxColumn, record.length);
    cells.set(rowIndex + 1, bucket);
  });

  const view = sheetViewOf({ sheetName, sheetNames: [sheetName], maxRow: records.length, maxColumn, cells });

  if (view.maxRow === 0 || view.maxColumn === 0) {
    bag.add('XLSX_HEADER_ROW_INVALID', 'CSV 里没有任何内容', { locator: { sheet: view.sheetName } });
    return { ok: false, diagnostics: bag.items };
  }

  // 明确不支持分隔符嗅探：整份文件按逗号分隔（分号分隔的"CSV"会被当成单列）
  const firstRecord = records[0] ?? [];
  if (firstRecord.length === 1 && (firstRecord[0] ?? '').includes(';')) {
    bag.add('XLSX_HEADER_ROW_INVALID', '不支持分隔符嗅探：本文件看起来是分号分隔，请另存为逗号分隔的 CSV', {
      locator: { sheet: view.sheetName, row: 1 },
    });
    return { ok: false, diagnostics: bag.items };
  }

  // 全部单元格皆空 → 没有可用内容
  if (view.maxRow > 0 && !records.some((record) => record.some((value) => value.trim() !== ''))) {
    bag.add('XLSX_HEADER_ROW_INVALID', 'CSV 里没有任何非空内容', { locator: { sheet: view.sheetName, row: 1 } });
    return { ok: false, diagnostics: bag.items };
  }

  return { ok: true, view, diagnostics: bag.items };
}
