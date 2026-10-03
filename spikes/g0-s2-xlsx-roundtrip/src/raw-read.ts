/**
 * G0-S-S2 · **zip 层原始读取**（独立于 ExcelJS 的第二读取路径）。
 *
 * 为什么必须自己再读一遍（S1 的教训）：
 *   ExcelJS 的对象 API 会「替我们解释」单元格——它按数字格式把序列号变成 `Date`，
 *   把共享字符串还原成文本。于是「日期被写成文本」「日期被写成带小数的序列号」这类
 *   真实漂移在对象层**看不出来**。本文件直接读 `sheetN.xml` 的 `t`/`s`/<v> 与
 *   `styles.xml` 的 numFmt，用于：
 *     - 与对象层做**双路径一致**比对；
 *     - 定位「第三方编辑器到底重写了什么」（配合 `diff-variant.mts`）。
 *
 * 刻意不复用 ExcelJS 的解析器：复用会让两条路径共享同一个错误。
 */

import { createHash } from 'node:crypto';

import JSZip from 'jszip';

export type RawCellKind =
  | 'shared'
  | 'inline'
  | 'string'
  | 'number'
  | 'boolean'
  | 'date-iso'
  | 'formula'
  | 'error'
  | 'empty';

export interface RawCell {
  readonly ref: string;
  readonly row: number;
  readonly column: number;
  readonly kind: RawCellKind;
  /** 文本类单元格的解码值（共享字符串 / 内联字符串 / str 公式结果 / 错误码）。 */
  readonly text: string | null;
  /** 数值类单元格的值（含日期序列号）。 */
  readonly number: number | null;
  /** 公式文本（公式单元格）。 */
  readonly formula: string | null;
  readonly styleIndex: number | null;
  /** 由 `styles.xml` 解析出的数字格式代码（内建表 + 自定义）。 */
  readonly numFmt: string | null;
  /** 该单元格的数字格式是否为日期/时间格式。 */
  readonly isDateFormat: boolean;
  /** 样式里的 `alignment indent`（仅显示层级用；解析不得依赖）。 */
  readonly indent: number | null;
}

export interface PartInfo {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SheetMeta {
  readonly name: string;
  /** `visible` / `hidden` / `veryHidden`（`workbook.xml` 的 `state` 属性）。 */
  readonly state: string;
  readonly sheetId: string;
  readonly relId: string;
  /** zip 内的绝对路径，如 `xl/worksheets/sheet1.xml`。 */
  readonly path: string;
}

export interface RawWorkbook {
  readonly parts: readonly PartInfo[];
  readonly text: ReadonlyMap<string, string>;
  readonly sheets: readonly SheetMeta[];
  readonly date1904: boolean;
  readonly sharedStrings: readonly string[];
  /** cellXfs 的 numFmtId 列表（按 styleIndex 索引）。 */
  readonly cellXfsNumFmtIds: readonly number[];
  /** cellXfs 的 alignment indent 列表（按 styleIndex 索引）。 */
  readonly cellXfsIndents: readonly number[];
  readonly customNumFmts: ReadonlyMap<number, string>;
}

export interface RawSheet {
  readonly workbook: RawWorkbook;
  readonly sheet: SheetMeta;
  readonly xml: string;
  readonly cells: readonly RawCell[];
  readonly dimension: string | null;
}

// ---------------------------------------------------------------------------
// XML 小工具（tolerant：生成的 XML 是单行，第三方保存后可能换行缩进）
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });
}

function attr(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return match?.[1] ?? null;
}

/** 取出 `<tag>` 与 `</tag>` 之间的内容（第一个匹配）。 */
function block(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

/** 单元格引用 → 行列号（1 基）。 */
export function decodeCellRef(ref: string): { row: number; column: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) throw new Error(`非法单元格引用：${ref}`);
  const letters = match[1] ?? '';
  let column = 0;
  for (const char of letters) column = column * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]), column };
}

// ---------------------------------------------------------------------------
// 数字格式：内建表（ECMA-376 §18.8.30）+ 是否日期格式
// ---------------------------------------------------------------------------

const BUILTIN_NUM_FMTS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

/**
 * 是否为日期/时间格式。
 *
 * 独立实现（**不复用** exceljs 的 `isDateFmt`）：先剥掉引号内的字面量、
 * 方括号段（颜色/条件/locale）与转义字符，再看是否出现日期/时间占位符。
 */
export function isDateFormatCode(code: string | null): boolean {
  if (code === null) return false;
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  if (/^@+$/.test(stripped.trim())) return false;
  return /[ymdhs]/i.test(stripped);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface PartsBundle {
  readonly parts: readonly PartInfo[];
  readonly text: ReadonlyMap<string, string>;
}

export async function readParts(buffer: Buffer | Uint8Array): Promise<PartsBundle> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: PartInfo[] = [];
  const text = new Map<string, string>();

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const bytes = await entry.async('uint8array');
    parts.push({
      name,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    // xlsx 的部件全部是 XML/文本（本 spike 的规范工作簿无媒体文件）。
    if (/\.(xml|rels)$/i.test(name)) text.set(name, Buffer.from(bytes).toString('utf8'));
  }

  parts.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { parts, text };
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const itemPattern = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) !== null) {
    const inner = match[1];
    if (inner === undefined) {
      strings.push('');
      continue;
    }
    // 富文本：把所有 <t> 段按顺序拼起来。
    const parts: string[] = [];
    const textPattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textPattern.exec(inner)) !== null) {
      parts.push(decodeXmlText(textMatch[1] ?? ''));
    }
    strings.push(parts.join(''));
  }
  return strings;
}

function parseStyles(xml: string): {
  cellXfsNumFmtIds: number[];
  cellXfsIndents: number[];
  customNumFmts: Map<number, string>;
} {
  const customNumFmts = new Map<number, string>();
  const numFmtsBlock = block(xml, 'numFmts');
  if (numFmtsBlock !== null) {
    const pattern = /<numFmt\b([^>]*?)\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(numFmtsBlock)) !== null) {
      const attributes = match[1] ?? '';
      const id = attr(attributes, 'numFmtId');
      const code = attr(attributes, 'formatCode');
      if (id !== null && code !== null) customNumFmts.set(Number(id), decodeXmlText(code));
    }
  }

  const cellXfsNumFmtIds: number[] = [];
  const cellXfsIndents: number[] = [];
  const cellXfs = block(xml, 'cellXfs');
  if (cellXfs !== null) {
    const pattern = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cellXfs)) !== null) {
      cellXfsNumFmtIds.push(Number(attr(match[1] ?? '', 'numFmtId') ?? '0'));
      const alignment = /<alignment\b([^>]*?)\/?>/.exec(match[2] ?? '');
      const indent = alignment === null ? null : attr(alignment[1] ?? '', 'indent');
      cellXfsIndents.push(indent === null ? 0 : Number(indent));
    }
  }
  return { cellXfsNumFmtIds, cellXfsIndents, customNumFmts };
}

function parseSheets(
  workbookXml: string,
  workbookRelsXml: string | null,
): (Omit<SheetMeta, 'path'> & { target: string })[] {
  const sheetsBlock = block(workbookXml, 'sheets') ?? '';
  const relTargets = new Map<string, string>();
  if (workbookRelsXml !== null) {
    const pattern = /<Relationship\b([^>]*?)\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(workbookRelsXml)) !== null) {
      const attributes = match[1] ?? '';
      const id = attr(attributes, 'Id');
      const target = attr(attributes, 'Target');
      if (id !== null && target !== null) relTargets.set(id, target);
    }
  }

  const sheets: (Omit<SheetMeta, 'path'> & { target: string })[] = [];
  const sheetPattern = /<sheet\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = sheetPattern.exec(sheetsBlock)) !== null) {
    const attributes = match[1] ?? '';
    const relId = attr(attributes, 'r:id') ?? '';
    sheets.push({
      name: attr(attributes, 'name') ?? '',
      state: attr(attributes, 'state') ?? 'visible',
      sheetId: attr(attributes, 'sheetId') ?? '',
      relId,
      target: relTargets.get(relId) ?? '',
    });
  }
  return sheets;
}

function parseCell(
  attributes: string,
  inner: string,
  sharedStrings: readonly string[],
  numFmt: string | null,
  indent: number | null,
): Omit<RawCell, 'row' | 'column'> {
  const ref = attr(attributes, 'r') ?? '';
  const styleIndex = attr(attributes, 's');
  const type = attr(attributes, 't');
  const formula = block(inner, 'f');
  const valueBlock = block(inner, 'v');
  const value = valueBlock === null ? null : decodeXmlText(valueBlock);
  const base = {
    ref,
    styleIndex: styleIndex === null ? null : Number(styleIndex),
    numFmt,
    isDateFormat: isDateFormatCode(numFmt),
    indent,
    formula: formula === null ? null : decodeXmlText(formula),
  };

  if (formula !== null) {
    return { ...base, kind: 'formula', text: value, number: value === null ? null : Number(value) };
  }
  if (type === 'inlineStr') {
    const inline = block(inner, 'is');
    if (inline === null) return { ...base, kind: 'empty', text: null, number: null };
    const parts: string[] = [];
    const textPattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textPattern.exec(inline)) !== null) parts.push(decodeXmlText(textMatch[1] ?? ''));
    return { ...base, kind: 'inline', text: parts.join(''), number: null };
  }
  if (type === 's') {
    const index = value === null ? -1 : Number(value);
    return { ...base, kind: 'shared', text: sharedStrings[index] ?? null, number: null };
  }
  if (type === 'b') return { ...base, kind: 'boolean', text: null, number: value === '1' ? 1 : 0 };
  if (type === 'str') return { ...base, kind: 'string', text: value, number: null };
  if (type === 'e') return { ...base, kind: 'error', text: value, number: null };
  if (type === 'd') return { ...base, kind: 'date-iso', text: value, number: null };
  if (value === null) return { ...base, kind: 'empty', text: null, number: null };
  return { ...base, kind: 'number', text: null, number: Number(value) };
}

function parseSheetXml(
  xml: string,
  sharedStrings: readonly string[],
  cellXfsNumFmtIds: readonly number[],
  cellXfsIndents: readonly number[],
  customNumFmts: ReadonlyMap<number, string>,
): { cells: RawCell[]; dimension: string | null } {
  const dimensionMatch = /<dimension\b([^>]*?)\/?>/.exec(xml);
  const dimension = dimensionMatch === null ? null : attr(dimensionMatch[1] ?? '', 'ref');

  const cells: RawCell[] = [];
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(xml)) !== null) {
    const attributes = match[1] ?? '';
    const ref = attr(attributes, 'r');
    if (ref === null) continue;
    const styleIndex = attr(attributes, 's');
    const numFmtId = styleIndex === null ? undefined : cellXfsNumFmtIds[Number(styleIndex)];
    const numFmt =
      numFmtId === undefined
        ? null
        : (customNumFmts.get(numFmtId) ?? BUILTIN_NUM_FMTS[numFmtId] ?? `builtin:${String(numFmtId)}`);
    const indent = styleIndex === null ? null : (cellXfsIndents[Number(styleIndex)] ?? 0);
    const parsed = parseCell(attributes, match[2] ?? '', sharedStrings, numFmt, indent);
    const { row, column } = decodeCellRef(ref);
    cells.push({ ...parsed, row, column });
  }
  return { cells, dimension };
}

/** 读取工作簿的「结构侧」信息（部件表 + sheet 元数据 + 共享字符串 + 样式）。 */
export async function readRawWorkbook(buffer: Buffer | Uint8Array): Promise<RawWorkbook> {
  const { parts, text } = await readParts(buffer);

  const workbookXml = text.get('xl/workbook.xml');
  if (workbookXml === undefined) throw new Error('缺少 xl/workbook.xml');
  const relsXml = text.get('xl/_rels/workbook.xml.rels') ?? null;
  const sheets = parseSheets(workbookXml, relsXml);

  const sharedStringsXml = text.get('xl/sharedStrings.xml') ?? null;
  const sharedStrings = sharedStringsXml === null ? [] : parseSharedStrings(sharedStringsXml);

  const stylesXml = text.get('xl/styles.xml') ?? null;
  const { cellXfsNumFmtIds, cellXfsIndents, customNumFmts } =
    stylesXml === null
      ? { cellXfsNumFmtIds: [], cellXfsIndents: [], customNumFmts: new Map<number, string>() }
      : parseStyles(stylesXml);

  const workbookPr = /<workbookPr\b([^>]*?)\/?>/.exec(workbookXml);
  const date1904 = workbookPr !== null && attr(workbookPr[1] ?? '', 'date1904') === '1';

  return {
    parts,
    text,
    sheets: sheets.map(({ target, ...rest }) => ({ ...rest, path: resolveTarget(target) })),
    date1904,
    sharedStrings,
    cellXfsNumFmtIds,
    cellXfsIndents,
    customNumFmts,
  };
}

/** `Target="worksheets/sheet1.xml"` → `xl/worksheets/sheet1.xml`（也容忍绝对 `/xl/...`）。 */
function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  if (target.startsWith('xl/')) return target;
  return `xl/${target}`;
}

/** 按表名读取某张工作表的**原始单元格**。 */
export async function readRawSheet(buffer: Buffer | Uint8Array, sheetName: string): Promise<RawSheet> {
  const workbook = await readRawWorkbook(buffer);
  const sheet = workbook.sheets.find((candidate) => candidate.name === sheetName);
  if (sheet === undefined) {
    throw new Error(`工作簿中没有名为「${sheetName}」的工作表：${workbook.sheets.map((s) => s.name).join(', ')}`);
  }
  const xml = workbook.text.get(sheet.path);
  if (xml === undefined) throw new Error(`缺少工作表部件：${sheet.path}`);
  const { cells, dimension } = parseSheetXml(
    xml,
    workbook.sharedStrings,
    workbook.cellXfsNumFmtIds,
    workbook.cellXfsIndents,
    workbook.customNumFmts,
  );
  return { workbook, sheet, xml, cells, dimension };
}

/** 供报告使用：把序列号（1900 日期系统）换算成 Excel 会**显示**的日期。 */
export function excelSerialToDisplayDate(serial: number): string {
  // 1900 系统的实际原点（含 1900 闰年 bug 的补偿）为 1899-12-30。
  const utcMs = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  return new Date(utcMs).toISOString().slice(0, 10);
}
