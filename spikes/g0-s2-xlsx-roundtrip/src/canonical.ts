/**
 * G0-S-S2 · 规范工作簿的**写出器**（ExcelJS）。
 *
 * 只做一件事：把 `manifest.ts` 声明的 fixture 写成规范工作簿的字节。
 * 一切「规范」都来自 manifest，本文件不含任何列序/表头/编码的判断。
 */

import ExcelJS from 'exceljs';

import {
  COLUMNS,
  DATE_ENCODING,
  DOC_CREATOR,
  FIXED_TIMESTAMP,
  FIXTURE,
  HEADER_ROW,
  MILESTONE_ENCODING,
  MILESTONE_FALSE_TEXT,
  MILESTONE_TRUE_TEXT,
  NUM_FMT_DATE,
  NUM_FMT_PROGRESS,
  SHEET_NAME,
  columnIndex,
  type ColumnKey,
} from './manifest.ts';

/** ISO `yyyy-mm-dd` → 各段。 */
export function isoParts(iso: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`不是合法 ISO 日期：${iso}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * **正确**的日期构造：UTC 零点。
 *
 * 依据（已由源码核验，`exceljs/lib/utils/utils.js`）：
 *   `dateToExcel(d) = 25569 + d.getTime() / 86400000`
 * 即序列号由 **绝对时刻** 推导，而不是由「年月日」推导。用本地零点构造
 * （`new Date(y, m-1, d)`）在 UTC+8 下会得到 `整数 - 1/3` 的小数序列号，
 * Excel 按序列号显示时落入**前一天** —— 这是本 spike 专门取证的一个真实陷阱。
 */
export function utcMidnight(iso: string): Date {
  const [year, month, day] = isoParts(iso);
  return new Date(Date.UTC(year, month - 1, day));
}

/** **错误示范**：本地零点构造（仅用于时区陷阱取证，不用于规范工作簿）。 */
export function localMidnight(iso: string): Date {
  const [year, month, day] = isoParts(iso);
  return new Date(year, month - 1, day);
}

function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  // 固定时间戳：否则 docProps/core.xml 每次都不同，「确定性」判据无法成立。
  workbook.created = FIXED_TIMESTAMP;
  workbook.modified = FIXED_TIMESTAMP;
  workbook.creator = DOC_CREATOR;
  workbook.lastModifiedBy = DOC_CREATOR;
  return workbook;
}

/** 写出规范工作簿（fixture → 字节）。 */
export async function writeCanonicalWorkbook(): Promise<Buffer> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet(SHEET_NAME, {
    properties: { defaultRowHeight: 15 },
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  COLUMNS.forEach((column, index) => {
    const headerCell = sheet.getRow(HEADER_ROW).getCell(index + 1);
    headerCell.value = column.header;
    headerCell.font = { bold: true };
    sheet.getColumn(index + 1).width = column.width;
  });

  FIXTURE.forEach((task, rowIndex) => {
    const row = sheet.getRow(HEADER_ROW + 1 + rowIndex);
    const cellOf = (key: ColumnKey): ExcelJS.Cell => row.getCell(columnIndex(key));

    cellOf('wbs').value = task.wbs;

    const nameCell = cellOf('name');
    nameCell.value = task.name;
    // 仅显示用；解析不得依赖它（见 verify-l1 的 indent-not-semantic 断言）。
    nameCell.alignment = { indent: task.indent };

    for (const [key, iso] of [
      ['start', task.start],
      ['finish', task.finish],
    ] as const) {
      if (iso === null) continue; // 空单元格：不写入（缺失 == 空）
      const cell = cellOf(key);
      if (DATE_ENCODING === 'serial') {
        cell.value = utcMidnight(iso);
        cell.numFmt = NUM_FMT_DATE;
      } else {
        cell.value = iso;
        cell.numFmt = '@';
      }
    }

    if (task.duration !== null) cellOf('duration').value = task.duration;
    if (task.predecessors !== '') cellOf('predecessors').value = task.predecessors;

    const progressCell = cellOf('progress');
    progressCell.value = task.progress;
    progressCell.numFmt = NUM_FMT_PROGRESS;

    const milestoneCell = cellOf('milestone');
    if (MILESTONE_ENCODING === 'boolean') milestoneCell.value = task.milestone;
    else milestoneCell.value = task.milestone ? MILESTONE_TRUE_TEXT : MILESTONE_FALSE_TEXT;

    if (task.note !== '') cellOf('note').value = task.note;
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * 时区陷阱取证用工作簿：同一个日历日期的三种构造方式各写一格。
 * 写出后由 `verify-l1.ts` 从 zip 层读回**真实落盘的序列号**并出报告。
 */
export async function writeTzProbeWorkbook(iso: string): Promise<Buffer> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet('tz-probe');
  const [year, month, day] = isoParts(iso);

  sheet.getRow(1).values = ['构造方式', '写入值', '说明'];
  const probes: [string, Date, string][] = [
    ['Date.UTC(y,m-1,d)', utcMidnight(iso), 'UTC 零点：序列号应为整数'],
    ['new Date(y,m-1,d)', localMidnight(iso), '本地零点：UTC+8 下序列号带小数'],
    ["new Date('yyyy-mm-dd')", new Date(iso), 'ISO 仅日期字符串：按 UTC 解析'],
    ['Date.UTC + 12h', new Date(Date.UTC(year, month - 1, day, 12)), '带时刻：序列号必有小数'],
  ];
  probes.forEach(([label, date, note], index) => {
    const row = sheet.getRow(index + 2);
    row.getCell(1).value = label;
    const cell = row.getCell(2);
    cell.value = date;
    cell.numFmt = NUM_FMT_DATE;
    row.getCell(3).value = note;
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
