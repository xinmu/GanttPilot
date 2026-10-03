/**
 * `exportXlsx`：文档 → 规范化 xlsx 字节。
 *
 * **导出写「文档数据」，不写「排程结果」**（ADR 0006 §3）：`Schedule` 永远是派生值；
 * "与甘特图一致"的判据是"导出 → 再导入后 `compute()` 逐字段深比较相等"，不是把 `es/ef` 写进文件。
 *
 * 三条硬性工程约束：
 * 1. **日期一律 `Date.UTC(y, m-1, d)` 构造**（本地零点会写出小数序列号 → Excel 显示前一天）；
 * 2. **固定 `created`/`modified`**（否则每次导出的部件内容都不同）；
 * 3. 呈现属性只用白名单四类（表头加粗 / 列宽 / 数字格式 / 冻结首行），**每加一类补一条结构断言**。
 */
import {
  hasDocumentErrors,
  validateDocument,
  type LinkType,
  type ProjectDocument,
} from '@ganttpilot/engine';

import { COLUMN_SPECS, HEADER_ROW, SHEET_NAME, columnIndexOfKey } from './columns.js';
import { DiagnosticBag, type XlsxDiagnostic } from './diagnostics.js';
import { utcMidnightFromIso } from './dates.js';

/** 导出结果（ADR 0006 §1 冻结的形状；出参一律 `Uint8Array`）。 */
export type ExportResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly diagnostics: readonly XlsxDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly XlsxDiagnostic[] };

/** 规范日期格式（导入只判"是否日期格式"，不比对格式码文本——WPS 会转义，S2 §三.2）。 */
export const NUM_FMT_DATE = 'yyyy-mm-dd';
/** 规范进度格式。 */
export const NUM_FMT_PROGRESS = '0%';

/**
 * 固定时间戳（UTC）：文档属性必须取常量，否则两次导出的部件内容不同（ADR 0006 §10）。
 */
export const FIXED_DOCUMENT_TIMESTAMP = new Date(Date.UTC(2000, 0, 1));
/** 固定作者/最后修改者。 */
export const FIXED_DOCUMENT_AUTHOR = 'GanttPilot';

/** 依赖列文本：`编号[类型][±lag]`，多条以 `;` 分隔；省略默认（FS + 0 lag）以保持可读。 */
export function formatDependencyText(
  predecessors: readonly { readonly outlineNumber: string; readonly type: LinkType; readonly lagDays: number }[],
): string {
  return predecessors
    .map((entry) => {
      const type = entry.type === 'FS' ? '' : entry.type;
      const lag =
        entry.lagDays === 0 ? '' : entry.lagDays > 0 ? `+${String(entry.lagDays)}` : String(entry.lagDays);
      const suffix = type === '' && lag === '' ? '' : `[${type}${lag}]`;
      return `${entry.outlineNumber}${suffix}`;
    })
    .join(';');
}

/** 导出选项（当前只有"不写规范表名"这类内部测试需要；默认保持规范）。 */
export interface ExportOptions {
  /** 仅供 gold/部件指纹用例：覆盖工作表名（默认 `任务`）。 */
  readonly sheetName?: string;
}

/**
 * 文档 → xlsx 字节。
 *
 * 失败条件（ADR 0006 §7）：文档本身不可导出（任务名为空）或**文档校验有 error 级诊断**。
 * 这两种情况下**不产出字节**，避免"写出一份自己都读不回来的文件"。
 */
export async function exportXlsx(document: ProjectDocument, options?: ExportOptions): Promise<ExportResult> {
  const bag = new DiagnosticBag();
  const sheetName = options?.sheetName ?? SHEET_NAME;

  for (const task of document.tasks) {
    if (task.name.trim() === '') {
      bag.add('XLSX_ROW_MISSING_NAME', `任务名为空，无法导出（schema 要求非空名称）：${task.id}`, {
        locator: { sheet: sheetName, column: '任务名称' },
        taskId: task.id,
      });
    }
  }

  const roundTrip = validateDocument(document);
  if (hasDocumentErrors(roundTrip)) {
    for (const diagnostic of roundTrip) {
      if (diagnostic.severity !== 'error') {
        continue;
      }
      bag.add('XLSX_HEADER_ROW_INVALID', `文档校验失败（${diagnostic.code}）：${diagnostic.message}`, {
        locator: { sheet: sheetName, ...(diagnostic.taskId === undefined ? {} : { column: '任务名称' }) },
        ...(diagnostic.taskId === undefined ? {} : { taskId: diagnostic.taskId }),
      });
    }
  }

  if (bag.hasErrors) {
    return { ok: false, diagnostics: bag.items };
  }

  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.created = FIXED_DOCUMENT_TIMESTAMP;
  workbook.modified = FIXED_DOCUMENT_TIMESTAMP;
  workbook.creator = FIXED_DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = FIXED_DOCUMENT_AUTHOR;

  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
  });

  // 表头（加粗）+ 列宽 —— 白名单内的两类呈现属性
  for (const spec of COLUMN_SPECS) {
    const columnNumber = columnIndexOfKey(spec.key);
    const headerCell = sheet.getRow(HEADER_ROW).getCell(columnNumber);
    headerCell.value = spec.header;
    headerCell.font = { bold: true };
    sheet.getColumn(columnNumber).width = spec.width;
  }

  const outlineOf = new Map(document.tasks.map((task) => [task.id, task.outlineNumber]));
  const predecessorsOf = new Map<string, { outlineNumber: string; type: LinkType; lagDays: number }[]>();
  for (const link of document.links) {
    const fromOutline = outlineOf.get(link.from);
    if (fromOutline === undefined) {
      // 悬空边由文档校验负责报；这里不写出（写出去也读不回来）
      continue;
    }
    const list = predecessorsOf.get(link.to) ?? [];
    list.push({ outlineNumber: fromOutline, type: link.type, lagDays: link.lagDays });
    predecessorsOf.set(link.to, list);
  }

  document.tasks.forEach((task, index) => {
    const row = sheet.getRow(HEADER_ROW + 1 + index);
    row.getCell(columnIndexOfKey('wbs')).value = task.outlineNumber;
    row.getCell(columnIndexOfKey('name')).value = task.name;

    if (task.startDate !== null) {
      const cell = row.getCell(columnIndexOfKey('start'));
      cell.value = utcMidnightFromIso(task.startDate);
      cell.numFmt = NUM_FMT_DATE;
    }
    if (task.endDate !== null) {
      const cell = row.getCell(columnIndexOfKey('end'));
      cell.value = utcMidnightFromIso(task.endDate);
      cell.numFmt = NUM_FMT_DATE;
    }
    if (task.durationDays !== null) {
      row.getCell(columnIndexOfKey('duration')).value = task.durationDays;
    }

    const predecessors = predecessorsOf.get(task.id);
    if (predecessors !== undefined && predecessors.length > 0) {
      row.getCell(columnIndexOfKey('predecessors')).value = formatDependencyText(predecessors);
    }

    if (task.progress !== null) {
      const cell = row.getCell(columnIndexOfKey('progress'));
      cell.value = task.progress;
      cell.numFmt = NUM_FMT_PROGRESS;
    }

    // 里程碑：布尔（`t="b"`）。空 = false，故 false 也显式写出（导入把空当 false，两者等价）
    row.getCell(columnIndexOfKey('milestone')).value = task.milestone;

    if (task.notes !== null) {
      row.getCell(columnIndexOfKey('notes')).value = task.notes;
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    ok: true,
    bytes: buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBuffer),
    diagnostics: bag.items,
  };
}