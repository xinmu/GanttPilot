/**
 * G0-S-S2 · **最小「可见列解析器」**（G3 导入侧的原型）。
 *
 * 存在的理由：问题②「第三方编辑器仅保存后，可见列语义是否仍可解析」不可能不写解析器就回答。
 * 本文件只实现**规范工作簿**的读取（脏文件、列映射向导、缩进式解析属 G3 的出口条件，不在本 spike）。
 *
 * 忠实度要求（本 spike 实测驱动，见 `结论.md` 的 G3 交接清单）：
 *   - 日期列必须同时接受：真日期（`Date`）、数值序列号、ISO 文本；
 *   - 进度必须同时接受：0..1 分数、百分数点位（> 1 视为百分数）、`50%` 文本；
 *   - 里程碑必须同时接受：布尔、`是/否`、`TRUE/FALSE`、`1/0`；
 *   - **不得依赖 `alignment.indent`**（层级只由 WBS 编号承载）。
 */

import { COLUMNS, HEADER_ROW, type ColumnKey, type RelationType } from './manifest.ts';
import type { SheetView, ViewCell } from './view.ts';

export interface Diagnostic {
  readonly code: string;
  readonly row: number;
  readonly column: number | null;
  readonly message: string;
}

export interface ParsedTask {
  readonly row: number;
  readonly wbs: string;
  readonly name: string;
  readonly start: string | null;
  readonly finish: string | null;
  readonly duration: number | null;
  readonly progress: number | null;
  readonly milestone: boolean | null;
  readonly note: string;
  readonly indent: number;
}

export interface ParsedLink {
  readonly from: string;
  readonly to: string;
  readonly type: RelationType;
  readonly lag: number;
  readonly raw: string;
}

export interface ParseResult {
  readonly sheetName: string;
  readonly headerRow: number;
  readonly columns: readonly { key: ColumnKey; column: number; header: string }[];
  readonly tasks: readonly ParsedTask[];
  readonly links: readonly ParsedLink[];
  readonly diagnostics: readonly Diagnostic[];
}

const RELATION_TYPES: readonly RelationType[] = ['FS', 'SS', 'FF', 'SF'];
const PREDECESSOR_PATTERN = /^(\d+(?:\.\d+)*)(?:\[\s*(FS|SS|FF|SF)\s*([+-]\s*\d+)?\s*\])?$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_DATE_PATTERN = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;

const MILESTONE_TRUE = new Set(['是', 'TRUE', 'true', 'True', '1', 'Y', 'y', 'YES', 'yes']);
const MILESTONE_FALSE = new Set(['否', 'FALSE', 'false', 'False', '0', 'N', 'n', 'NO', 'no']);

/** Excel 1900 日期系统的有效序列号范围（1900-01-01 起，避开 1900 闰年 bug 区间）。 */
const MIN_SERIAL = 2;
const MAX_SERIAL = 2_958_465;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function normaliseIso(year: string, month: string, day: string): string | null {
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${pad(m)}-${pad(d)}`;
}

/** 数值序列号（1900 系统）→ `yyyy-mm-dd`。 */
export function serialToIso(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
}

interface DateResolution {
  readonly iso: string | null;
  readonly representation: 'date' | 'serial' | 'iso-text' | 'other-text' | 'empty' | 'unusable';
}

/**
 * 日期解析：三种表示都能吃下去。
 * `representation` 会被报告统计——它就是「第三方把日期表示改成了什么」的答案。
 */
export function resolveDate(cell: ViewCell | undefined): DateResolution {
  if (cell === undefined || cell.kind === 'empty') return { iso: null, representation: 'empty' };
  if (cell.kind === 'date' && cell.dateIso !== null) {
    return { iso: cell.dateIso, representation: 'date' };
  }
  if (cell.kind === 'number' && cell.number !== null) {
    if (cell.number < MIN_SERIAL || cell.number > MAX_SERIAL) {
      return { iso: null, representation: 'unusable' };
    }
    return { iso: serialToIso(Math.floor(cell.number)), representation: 'serial' };
  }
  if (cell.kind === 'string' && cell.text !== null) {
    const text = cell.text.trim();
    const iso = ISO_DATE_PATTERN.exec(text);
    if (iso !== null) {
      const normalised = normaliseIso(iso[1] ?? '', iso[2] ?? '', iso[3] ?? '');
      return { iso: normalised, representation: 'iso-text' };
    }
    const slash = SLASH_DATE_PATTERN.exec(text);
    if (slash !== null) {
      const normalised = normaliseIso(slash[1] ?? '', slash[2] ?? '', slash[3] ?? '');
      return { iso: normalised, representation: 'other-text' };
    }
    return { iso: null, representation: 'unusable' };
  }
  return { iso: null, representation: 'unusable' };
}

/** 进度解析：`≤1` 视为分数，`>1` 视为百分数（对两种编码同时正确）。 */
export function resolveProgress(cell: ViewCell | undefined): number | null {
  if (cell === undefined) return null;
  if (cell.kind === 'number' && cell.number !== null) {
    return cell.number <= 1 ? cell.number : cell.number / 100;
  }
  if (cell.kind === 'string' && cell.text !== null) {
    const text = cell.text.trim();
    if (text === '') return null;
    if (text.endsWith('%')) {
      const parsed = Number(text.slice(0, -1));
      return Number.isFinite(parsed) ? parsed / 100 : null;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return null;
    return parsed <= 1 ? parsed : parsed / 100;
  }
  return null;
}

/** 里程碑解析：布尔 / `是/否` 文本 / `1/0` 数值。 */
export function resolveMilestone(cell: ViewCell | undefined): boolean | null {
  if (cell === undefined) return null;
  if (cell.kind === 'boolean' && cell.boolean !== null) return cell.boolean;
  if (cell.kind === 'number' && cell.number !== null) return cell.number !== 0;
  if (cell.kind === 'string' && cell.text !== null) {
    const text = cell.text.trim();
    if (MILESTONE_TRUE.has(text)) return true;
    if (MILESTONE_FALSE.has(text)) return false;
  }
  return null;
}

export function resolveNumber(cell: ViewCell | undefined): number | null {
  if (cell === undefined) return null;
  if (cell.kind === 'number' && cell.number !== null) return cell.number;
  if (cell.kind === 'string' && cell.text !== null && cell.text.trim() !== '') {
    const parsed = Number(cell.text.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function resolveText(cell: ViewCell | undefined): string {
  if (cell === undefined) return '';
  if (cell.text !== null) return cell.text;
  if (cell.kind === 'number' && cell.number !== null) return String(cell.number);
  if (cell.kind === 'boolean' && cell.boolean !== null) return String(cell.boolean);
  if (cell.kind === 'date' && cell.dateIso !== null) return cell.dateIso;
  if (cell.formula !== null) return `=${cell.formula}`;
  return '';
}

/** 定位表头行：取命中最多的行；必须同时含 `WBS` 与 `任务名称`。 */
function locateHeader(view: SheetView): {
  headerRow: number;
  columns: { key: ColumnKey; column: number; header: string }[];
} | null {
  const rows = new Map<number, { key: ColumnKey; column: number; header: string }[]>();
  for (const cell of view.cells) {
    const header = cell.text?.trim();
    if (header === null || header === undefined) continue;
    const spec = COLUMN_SPECS_BY_HEADER.get(header);
    if (spec === undefined) continue;
    const list = rows.get(cell.row) ?? [];
    list.push({ key: spec.key, column: cell.column, header });
    rows.set(cell.row, list);
  }

  let best: { headerRow: number; columns: { key: ColumnKey; column: number; header: string }[] } | null = null;
  for (const [headerRow, columns] of rows) {
    const keys = new Set(columns.map((entry) => entry.key));
    if (!keys.has('wbs') || !keys.has('name')) continue;
    if (columns.length < 3) continue;
    if (best === null || columns.length > best.columns.length) best = { headerRow, columns };
  }
  return best;
}

const COLUMN_SPECS_BY_HEADER: ReadonlyMap<string, { key: ColumnKey }> = new Map(
  COLUMNS.map((column) => [column.header, { key: column.key }]),
);

/** 解析规范工作簿的一张表。 */
export function parseVisible(view: SheetView): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const header = locateHeader(view);
  if (header === null) {
    return {
      sheetName: view.sheetName,
      headerRow: HEADER_ROW,
      columns: [],
      tasks: [],
      links: [],
      diagnostics: [
        {
          code: 'missing-header',
          row: HEADER_ROW,
          column: null,
          message: '未找到含 `WBS` 与 `任务名称` 的表头行',
        },
      ],
    };
  }

  const byRow = new Map<number, Map<number, ViewCell>>();
  for (const cell of view.cells) {
    let row = byRow.get(cell.row);
    if (row === undefined) {
      row = new Map();
      byRow.set(cell.row, row);
    }
    row.set(cell.column, cell);
  }

  const columnOf = new Map<ColumnKey, number>(header.columns.map((entry) => [entry.key, entry.column]));
  const cellOf = (row: number, key: ColumnKey): ViewCell | undefined => {
    const column = columnOf.get(key);
    if (column === undefined) return undefined;
    return byRow.get(row)?.get(column);
  };

  const tasks: ParsedTask[] = [];
  const links: ParsedLink[] = [];
  const rawPredecessors = new Map<string, string>();

  for (let row = header.headerRow + 1; row <= view.maxRow; row += 1) {
    const wbsCell = cellOf(row, 'wbs');
    const wbs = resolveText(wbsCell).trim();
    if (wbs === '') {
      const hasAnything = byRow.get(row) !== undefined;
      if (hasAnything) {
        diagnostics.push({ code: 'missing-wbs', row, column: columnOf.get('wbs') ?? null, message: '行缺少 WBS 编号，已跳过' });
      }
      continue;
    }

    const name = resolveText(cellOf(row, 'name')).trim();
    if (name === '') {
      diagnostics.push({ code: 'missing-name', row, column: columnOf.get('name') ?? null, message: '缺少任务名称' });
    }

    const start = resolveDate(cellOf(row, 'start'));
    const finish = resolveDate(cellOf(row, 'finish'));
    if (start.representation === 'unusable') {
      diagnostics.push({ code: 'unparsable-date', row, column: columnOf.get('start') ?? null, message: '开始列无法解析为日期' });
    }
    if (finish.representation === 'unusable') {
      diagnostics.push({ code: 'unparsable-date', row, column: columnOf.get('finish') ?? null, message: '完成列无法解析为日期' });
    }

    const durationCell = cellOf(row, 'duration');
    const duration = resolveNumber(durationCell);
    if (durationCell !== undefined && durationCell.kind !== 'empty' && duration === null) {
      diagnostics.push({ code: 'unparsable-duration', row, column: columnOf.get('duration') ?? null, message: '工期列不是数值' });
    }

    const progressCell = cellOf(row, 'progress');
    const progress = resolveProgress(progressCell);
    if (progressCell !== undefined && progressCell.kind !== 'empty' && progress === null) {
      diagnostics.push({ code: 'unparsable-progress', row, column: columnOf.get('progress') ?? null, message: '进度列无法解析' });
    }

    const milestoneCell = cellOf(row, 'milestone');
    const milestone = resolveMilestone(milestoneCell);
    if (milestoneCell !== undefined && milestoneCell.kind !== 'empty' && milestone === null) {
      diagnostics.push({ code: 'unparsable-milestone', row, column: columnOf.get('milestone') ?? null, message: '里程碑列无法解析' });
    }

    const indentCell = cellOf(row, 'name') ?? cellOf(row, 'wbs');

    tasks.push({
      row,
      wbs,
      name,
      start: start.iso,
      finish: finish.iso,
      duration,
      progress,
      milestone,
      note: resolveText(cellOf(row, 'note')),
      indent: indentCell?.indent ?? 0,
    });

    const predecessorsText = resolveText(cellOf(row, 'predecessors')).trim();
    if (predecessorsText !== '') rawPredecessors.set(wbs, predecessorsText);
  }

  // 依赖：第二趟解析（需要先知道全部 WBS）
  const knownWbs = new Set(tasks.map((task) => task.wbs));
  const rowOfWbs = new Map(tasks.map((task) => [task.wbs, task.row]));
  for (const [to, text] of rawPredecessors) {
    const row = rowOfWbs.get(to) ?? 0;
    for (const token of text.split(/[;；]/)) {
      const trimmed = token.trim();
      if (trimmed === '') continue;
      const match = PREDECESSOR_PATTERN.exec(trimmed);
      if (match === null) {
        diagnostics.push({
          code: 'unparsable-predecessor',
          row,
          column: columnOf.get('predecessors') ?? null,
          message: `无法解析前置任务片段：${trimmed}`,
        });
        continue;
      }
      const from = match[1] ?? '';
      const type = (match[2] ?? 'FS') as RelationType;
      if (!RELATION_TYPES.includes(type)) {
        diagnostics.push({ code: 'unparsable-predecessor', row, column: null, message: `未知关系类型：${type}` });
        continue;
      }
      const lag = match[3] === undefined ? 0 : Number(match[3].replace(/\s+/g, ''));
      if (!knownWbs.has(from)) {
        diagnostics.push({
          code: 'unknown-predecessor',
          row,
          column: columnOf.get('predecessors') ?? null,
          message: `前置任务的 WBS 编号在工作表中不存在：${from}`,
        });
        continue;
      }
      links.push({ from, to, type, lag, raw: trimmed });
    }
  }

  return {
    sheetName: view.sheetName,
    headerRow: header.headerRow,
    columns: header.columns.sort((a, b) => a.column - b.column),
    tasks,
    links: links.sort((a, b) => (a.to === b.to ? a.from.localeCompare(b.from) : a.to.localeCompare(b.to))),
    diagnostics,
  };
}

/** 供断言用：把解析结果归一化成可比对的键值列表。 */
export function normaliseLinks(
  links: readonly { from: string; to: string; type: RelationType; lag: number }[],
): { from: string; to: string; type: RelationType; lag: number }[] {
  return links
    .map(({ from, to, type, lag }) => ({ from, to, type, lag }))
    .sort((a, b) =>
      a.to === b.to ? (a.from === b.from ? a.type.localeCompare(b.type) : a.from.localeCompare(b.from)) : a.to.localeCompare(b.to),
    );
}

/** 供断言用：期望值表 → 同一形状。 */
export function normaliseExpected(
  edges: readonly { from: string; to: string; type: RelationType; lag: number }[],
): { from: string; to: string; type: RelationType; lag: number }[] {
  return [...edges].sort((a, b) =>
    a.to === b.to ? (a.from === b.from ? a.type.localeCompare(b.type) : a.from.localeCompare(b.from)) : a.to.localeCompare(b.to),
  );
}
