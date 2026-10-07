/**
 * `importXlsx` / `detectColumns` / `importCsv`：字节流 → 文档 + 问题清单。
 *
 * **绝不抛异常报告用户级问题**（ADR 0006 §1/§7）：坏文件、缺列、脏单元格全部以结构化诊断返回。
 * 导入产物**必然通过 `validateDocument`**；有 error 级诊断 → `{ok:false}`。
 *
 * 导入写库时**必须**经命令层的 `document.replace`（唯一变更通道，ADR 0003）——
 * 那是调用方（G4/G5 的 `apps/web`）的动作，本层只交文档。
 */
import type { ProjectDocument } from '@ganttpilot/engine';

import {
  applyColumnOverrides,
  bindingColumnsOf,
  buildDocumentFromView,
  type ColumnMapping,
  type ImportOptions,
} from './buildDocument.js';
import { detectColumnsInView, type ColumnDetectionResult } from './header.js';
import { DiagnosticBag, type XlsxDiagnostic } from './diagnostics.js';
import { readCsv } from './csv.js';
import { toUint8Array, type SheetView, type XlsxInput } from './sheet.js';
import { readXlsx } from './xlsx.js';

/** 导入结果（ADR 0006 §1 冻结的形状）。 */
export type ImportResult =
  | { readonly ok: true; readonly document: ProjectDocument; readonly diagnostics: readonly XlsxDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly XlsxDiagnostic[] };

/** 列探测入口（向导第 1–2 步用）。 */
export type { ColumnDetectionResult };

function isCsvBytes(bytes: Uint8Array): boolean {
  // 宽松判定：前若干字节是否是可打印文本（xlsx 是 zip，前两字节必然是 `PK`）。
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return false;
  }
  const probe = bytes.subarray(0, 64);
  if (probe.length === 0) {
    return false;
  }
  let printable = 0;
  for (const byte of probe) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f)) {
      printable += 1;
    }
  }
  return printable === probe.length;
}

/** 读表结果（判别联合；两种分支都带诊断，便于统一拼接）。 */
type ReadOutcome =
  | { readonly ok: true; readonly view: SheetView; readonly diagnostics: readonly XlsxDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly XlsxDiagnostic[] };

async function readView(
  input: XlsxInput,
  options: ImportOptions | undefined,
  allowFirstSheetFallback: boolean,
): Promise<ReadOutcome> {
  const bytes = toUint8Array(input);
  if (isCsvBytes(bytes)) {
    // CSV 是单表：`options.sheet` 若给了名字，必须与"没有工作表"这件事一致地报错（不静默忽略）。
    if (options?.sheet !== undefined && options.sheet !== '') {
      // 走收集器：severity 由码表决定，**不在这里手写 `severity: 'error'`**（P3/C2）。
      const bag = new DiagnosticBag();
      bag.add('XLSX_SHEET_NOT_FOUND', `CSV 是单表文件，没有名为「${options.sheet}」的工作表`, {
        locator: { sheet: options.sheet },
      });
      return { ok: false, diagnostics: bag.items };
    }
    const csv = readCsv(bytes);
    if (!csv.ok) {
      return { ok: false, diagnostics: csv.diagnostics };
    }
    return { ok: true, view: csv.view, diagnostics: [] };
  }

  const sheetOptions = {
    allowFirstSheetFallback,
    ...(options?.sheet === undefined ? {} : { sheet: options.sheet }),
  };
  const xlsx = await readXlsx(bytes, sheetOptions);
  if (!xlsx.ok) {
    return { ok: false, diagnostics: xlsx.diagnostics };
  }
  return { ok: true, view: xlsx.view, diagnostics: [] };
}

/**
 * 列探测：识别了哪些列、还差什么、有哪些未识别列（向导第 1–2 步）。
 *
 * `sheet` 缺省时**允许退回首个工作表**——向导要看到用户自己的表。
 */
export async function detectColumns(input: XlsxInput, options?: ImportOptions): Promise<ColumnDetectionResult> {
  const read = await readView(input, options, true);
  if (!read.ok) {
    return {
      ok: false,
      detection: {
        sheetName: options?.sheet ?? '',
        headerRow: null,
        bindings: [],
        recognized: [],
        missing: [],
        unrecognized: [],
        hasDataRows: false,
      },
      diagnostics: read.diagnostics,
    };
  }
  const result = detectColumnsInView(read.view);
  return {
    ...result,
    diagnostics: [...read.diagnostics, ...result.diagnostics],
  };
}

/** 导入 xlsx（或 CSV，按字节形态识别；ADR 0006 §9）。 */
export async function importXlsx(input: XlsxInput, options?: ImportOptions): Promise<ImportResult> {
  const read = await readView(input, options, options?.sheet !== undefined);
  if (!read.ok) {
    return { ok: false, diagnostics: read.diagnostics };
  }
  const { view, diagnostics: readDiagnostics } = read;

  const detection = detectColumnsInView(view);
  const prefix = [...readDiagnostics, ...detection.diagnostics];
  if (!detection.ok) {
    // 表头无法识别 / 必需列缺失：`detectColumns` 的 `ok:false` 是入口契约（向导据此停在第 1 步），
    // 导入侧也在同一处停下（不靠"后面会报错"兜底）。
    return { ok: false, diagnostics: prefix };
  }
  if (detection.detection.headerRow === null) {
    return { ok: false, diagnostics: prefix };
  }

  const mapping: ColumnMapping = applyColumnOverrides(
    bindingColumnsOf(detection.detection.bindings),
    view,
    detection.detection.headerRow,
    options?.columns,
  );

  // 列映射覆盖可能会补上"原本未识别"的必需列，但不会凭空造出列：这里以覆盖后的映射为准
  const parsed = buildDocumentFromView(view, detection.detection.headerRow, mapping, options ?? {});
  const diagnostics = [...prefix, ...parsed.diagnostics.items];
  if (parsed.document === null) {
    return { ok: false, diagnostics };
  }
  return { ok: true, document: parsed.document, diagnostics };
}

/** CSV 专用入口（与 `importXlsx` 共用同一套规则，只是跳过字节形态判定）。 */
export async function importCsv(input: XlsxInput, options?: ImportOptions): Promise<ImportResult> {
  const bytes = toUint8Array(input);
  const read = readCsv(bytes);
  if (!read.ok) {
    return { ok: false, diagnostics: read.diagnostics };
  }
  const { view, diagnostics: csvDiagnostics } = read;
  const detection = detectColumnsInView(view);
  if (!detection.ok || detection.detection.headerRow === null) {
    return { ok: false, diagnostics: [...csvDiagnostics, ...detection.diagnostics] };
  }
  const mapping = applyColumnOverrides(
    bindingColumnsOf(detection.detection.bindings),
    view,
    detection.detection.headerRow,
    options?.columns,
  );
  const parsed = buildDocumentFromView(view, detection.detection.headerRow, mapping, options ?? {});
  const diagnostics = [...csvDiagnostics, ...detection.diagnostics, ...parsed.diagnostics.items];
  if (parsed.document === null) {
    return { ok: false, diagnostics };
  }
  return { ok: true, document: parsed.document, diagnostics };
}
