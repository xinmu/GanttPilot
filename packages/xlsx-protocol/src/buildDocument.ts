/**
 * 行 → 文档：把内部工作表模型（或 CSV 解析出的等价模型）变成合法 `ProjectDocument`。
 *
 * 与 `import.ts` 分工：本文件是**纯函数**（不碰字节、不碰 ExcelJS），因此 CSV 路径能完整复用同一套
 * 列契约、容差与诊断码（ADR 0006 §9），单元测试也不必构造真实 xlsx。
 *
 * 顺序是刻意的（每一步都被后面的步骤依赖）：
 * 读行 → 层级（双解析）→ 任务 id 与父子 → **重编号** → 依赖（按编号 ↔ id 映射）→ 校验。
 */
import {
  reindexDocument,
  validateDocument,
  type CalendarSpec,
  type DocumentLink,
  type DocumentTask,
  type ProjectDocument,
} from '@ganttpilot/engine';

import { COLUMN_SPECS, columnSpecOfHeader, type ColumnKey } from './columns.js';
import { parseDependencyToken, resolveEdges, splitDependencyCell, type CandidateEdge } from './dependencies.js';
import { columnLetter, DiagnosticBag } from './diagnostics.js';
import { outlineDepthOf, resolveHierarchy, validateOutlineNumber, type HierarchyRowInput } from './hierarchy.js';
import { isEmptyCell, type SheetView } from './sheet.js';
import {
  isBlank,
  parseDateCell,
  parseDurationCell,
  parseMilestoneCell,
  parseProgressCell,
  parseTextCell,
  type Reporter,
} from './values.js';

/** 项目日历的默认规格（v0.1 只有项目日历生效，R-1）。 */
export const DEFAULT_IMPORT_CALENDAR: CalendarSpec = {
  id: 'project',
  workDays: [1, 2, 3, 4, 5],
  exceptions: { nonWorking: [], working: [] },
};

/** 列映射覆盖的目标：表头原文或 1 基列号。 */
export type ColumnTarget = string | number;

/** 导入选项（ADR 0006 §1：列映射、sheet 选择、日历规格）。 */
export interface ImportOptions {
  /** 工作表名；缺省时优先规范表 `任务`。 */
  readonly sheet?: string;
  /** 列映射覆盖：`{ 前置任务: '紧前任务' }` 或 `{ 前置任务: 6 }`（1 基列号）。 */
  readonly columns?: Partial<Record<ColumnKey, ColumnTarget>>;
  /** 项目日历规格；缺省周一至周五、无例外。 */
  readonly calendar?: CalendarSpec;
  /** 项目名（xlsx 里没有项目级字段，由调用方给）。 */
  readonly projectName?: string;
}

/** 键 → 1 基列号。 */
export type ColumnMapping = Readonly<Partial<Record<ColumnKey, number>>>;

/** 行解析结论。 */
export interface RowParseResult {
  readonly document: ProjectDocument | null;
  readonly diagnostics: DiagnosticBag;
}

function headerTextOf(key: ColumnKey): string {
  return COLUMN_SPECS.find((spec) => spec.key === key)?.header ?? key;
}

/** 顺序生成确定性 id（**不用全局自增**：同一次导入必须逐次可复现，ADR 0003 ⑥）。 */
function sequentialId(prefix: string, seen: Set<string>): string {
  let index = seen.size + 1;
  let candidate = `${prefix}${String(index)}`;
  while (seen.has(candidate)) {
    index += 1;
    candidate = `${prefix}${String(index)}`;
  }
  seen.add(candidate);
  return candidate;
}

/** 逐行读取出的原始字段（尚未成文档）。 */
interface ParsedRow {
  readonly row: number;
  readonly wbsText: string;
  readonly indent: number;
  readonly name: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly progress: number | null;
  readonly milestone: boolean;
  readonly notes: string | null;
  readonly predecessors: string;
}

/**
 * 解析全部数据行。
 *
 * - **整行皆空**的行跳过；"有内容但任务名为空"→ `XLSX_ROW_MISSING_NAME`(error)（ADR 0006 §7）；
 * - `wbs`/`predecessors` 的取文本用**静默 reporter**（它们的空串/空白已有更精确的码，
 *   不该顺带再报一条 `XLSX_INFERRED_EMPTY_CELL`）。
 */
export function parseRows(
  view: SheetView,
  headerRow: number,
  mapping: ColumnMapping,
  bag: DiagnosticBag,
): readonly ParsedRow[] {
  const rowsOut: ParsedRow[] = [];
  const columnOf = (key: ColumnKey): number | undefined => mapping[key];

  for (let row = headerRow + 1; row <= view.maxRow; row += 1) {
    const sheetRow = view.row(row);
    if (sheetRow === undefined || sheetRow.every((cell) => isEmptyCell(cell))) {
      continue;
    }

    const reporter: Reporter = (code, message, detail) => {
      const column = detail?.column;
      const columnNumber = column === undefined ? undefined : columnOf(column);
      bag.add(code, message, {
        locator: {
          sheet: view.sheetName,
          row,
          ...(column === undefined ? {} : { column: headerTextOf(column) }),
          ...(columnNumber === undefined ? {} : { address: `${columnLetter(columnNumber)}${String(row)}` }),
        },
        ...(detail?.taskId === undefined ? {} : { taskId: detail.taskId }),
        ...(detail?.linkId === undefined ? {} : { linkId: detail.linkId }),
      });
    };

    const silent: Reporter = () => {};
    const cellOf = (key: ColumnKey) => {
      const column = columnOf(key);
      return column === undefined ? undefined : view.cell(row, column);
    };
    const textOf = (key: ColumnKey, activeReporter: Reporter): string => {
      const cell = cellOf(key);
      return cell === undefined ? '' : (parseTextCell(cell, activeReporter, key) ?? '');
    };

    const nameCell = cellOf('name');
    const name = nameCell === undefined ? '' : (parseTextCell(nameCell, reporter, 'name') ?? '');
    if (name.trim() === '') {
      bag.add('XLSX_ROW_MISSING_NAME', '该行有其它内容但任务名为空', {
        locator: {
          sheet: view.sheetName,
          row,
          ...(columnOf('name') === undefined
            ? {}
            : { column: headerTextOf('name'), address: `${columnLetter(columnOf('name') ?? 1)}${String(row)}` }),
        },
      });
    }

    rowsOut.push({
      row,
      wbsText: textOf('wbs', silent),
      indent: nameCell?.indent ?? 0,
      name,
      startDate: parseDateCell(cellOf('start'), reporter, 'start', true),
      endDate: parseDateCell(cellOf('end'), reporter, 'end', true),
      durationDays: parseDurationCell(cellOf('duration'), reporter, 'duration'),
      progress: parseProgressCell(cellOf('progress'), reporter, 'progress'),
      milestone: parseMilestoneCell(cellOf('milestone'), reporter, 'milestone'),
      notes: (() => {
        const cell = cellOf('notes');
        if (cell === undefined || isBlank(cell)) {
          return null;
        }
        return parseTextCell(cell, reporter, 'notes');
      })(),
      predecessors: (() => {
        const cell = cellOf('predecessors');
        if (cell === undefined || isBlank(cell)) {
          return '';
        }
        return textOf('predecessors', silent);
      })(),
    });
  }

  return rowsOut;
}

/** 层级来源判定 + 双解析。 */
function resolveRows(
  rows: readonly ParsedRow[],
  hasWbsColumn: boolean,
  bag: DiagnosticBag,
  view: SheetView,
): ReturnType<typeof resolveHierarchy> | null {
  const inputs: HierarchyRowInput[] = rows.map((row) => ({
    row: row.row,
    wbsText: row.wbsText.trim(),
    indent: row.indent,
  }));

  if (!hasWbsColumn) {
    const hasIndent = rows.some((row) => row.indent > 0);
    if (!hasIndent) {
      bag.add(
        'XLSX_REQUIRED_COLUMN_MISSING',
        '缺少层级来源：既没有 `WBS` 编号列，`任务名称` 也没有任何缩进（两者必须二选一）',
        { locator: { sheet: view.sheetName } },
      );
      return null;
    }
    return resolveHierarchy(inputs, false, () => {});
  }

  // 编号列存在：逐行校验编号（非法 → 行级错误，不猜）
  for (const input of inputs) {
    if (input.wbsText === '') {
      bag.add('XLSX_HEADER_ROW_INVALID', '该行缺少 `WBS` 编号', {
        locator: { sheet: view.sheetName, row: input.row, column: headerTextOf('wbs') },
      });
    } else if (!validateOutlineNumber(input.wbsText)) {
      bag.add('XLSX_HEADER_ROW_INVALID', `WBS 编号不合法：${JSON.stringify(input.wbsText)}`, {
        locator: { sheet: view.sheetName, row: input.row, column: headerTextOf('wbs') },
      });
    }
  }

  return resolveHierarchy(inputs, true, (code, message) => {
    bag.add(code, message, { locator: { sheet: view.sheetName } });
  });
}

/**
 * 行 → 文档（含依赖解析与成环丢弃）。
 *
 * 返回 `document === null` 表示"有 error 级诊断、文档不可用"——**不抛异常**
 * （异常控制流无法承载"逐条收集问题文案"，ADR 0003 §4 的同一取舍）。
 */
export function buildDocumentFromView(
  view: SheetView,
  headerRow: number,
  mapping: ColumnMapping,
  options: ImportOptions,
): RowParseResult {
  const bag = new DiagnosticBag();
  const rows = parseRows(view, headerRow, mapping, bag);
  const hasWbsColumn = mapping.wbs !== undefined;
  const hierarchy = resolveRows(rows, hasWbsColumn, bag, view);

  if (bag.hasErrors || hierarchy === null) {
    return { document: null, diagnostics: bag };
  }

  const parentRowOf = new Map(hierarchy.rows.map((row) => [row.row, row.parentRow]));
  const taskIdOfRow = new Map<number, string>();
  const seenTaskIds = new Set<string>();
  const draftTasks: DocumentTask[] = rows.map((row) => {
    const id = sequentialId('t', seenTaskIds);
    taskIdOfRow.set(row.row, id);
    const parentRow = parentRowOf.get(row.row) ?? null;
    return {
      id,
      parentId: parentRow === null ? null : (taskIdOfRow.get(parentRow) ?? null),
      outlineNumber: '1',
      name: row.name,
      startDate: row.startDate,
      endDate: row.endDate,
      durationDays: row.durationDays,
      progress: row.progress,
      milestone: row.milestone,
      collapsed: false,
      notes: row.notes,
      manual: false,
      constraints: [],
    };
  });

  // 编号是**派生值**：层级（parentId）+ 文档序为真相源，重编号是唯一的修复动作（ADR 0002 ③）
  const document0: ProjectDocument = {
    version: 3,
    project: {
      name: options.projectName ?? '',
      description: null,
      baseCalendarId: 'project',
      startDate: null,
      finishDate: null,
    },
    calendars: [options.calendar ?? DEFAULT_IMPORT_CALENDAR],
    tasks: draftTasks,
    links: [],
    baselines: [],
  };
  const document1 = reindexDocument(document0);

  // 工作表编号 → 任务 id（依赖列的编号指向**工作表里写的**编号，因此优先于派生编号）
  const taskIdOfNumber = new Map<string, string>();
  rows.forEach((row) => {
    const id = taskIdOfRow.get(row.row);
    if (id === undefined) {
      return;
    }
    const number = hasWbsColumn ? row.wbsText.trim() : String(row.row);
    if (number !== '' && !taskIdOfNumber.has(number)) {
      taskIdOfNumber.set(number, id);
    }
  });

  // 依赖：按「工作表行序 × 单元格内前置出现顺序」构造候选，再逐条裁决（确定性丢弃）
  const candidates: CandidateEdge[] = [];
  const predecessorColumn = mapping.predecessors;
  for (const row of rows) {
    if (row.predecessors === '') {
      continue;
    }
    const toNumber = hasWbsColumn ? row.wbsText.trim() : String(row.row);
    const toId = taskIdOfRow.get(row.row);
    for (const token of splitDependencyCell(row.predecessors)) {
      const parsed = parseDependencyToken(token);
      const locator = {
        sheet: view.sheetName,
        row: row.row,
        column: headerTextOf('predecessors'),
        ...(predecessorColumn === undefined
          ? {}
          : { address: `${columnLetter(predecessorColumn)}${String(row.row)}` }),
      };
      if (!parsed.ok) {
        bag.add('XLSX_DEPENDENCY_UNPARSABLE', `${parsed.reason}（片段 ${JSON.stringify(token.number)}）`, {
          locator,
          ...(toId === undefined ? {} : { taskId: toId }),
        });
        continue;
      }
      if (!taskIdOfNumber.has(parsed.number)) {
        bag.add('XLSX_DEPENDENCY_UNPARSABLE', `前置任务的编号在工作表中不存在：${parsed.number}`, {
          locator,
          ...(toId === undefined ? {} : { taskId: toId }),
        });
        continue;
      }
      candidates.push({
        fromNumber: parsed.number,
        toNumber,
        type: parsed.type,
        lagDays: parsed.lagDays,
      });
    }
  }

  const hasChildren = new Set<string>();
  for (const task of document1.tasks) {
    if (task.parentId !== null) {
      hasChildren.add(task.parentId);
    }
  }

  const seenLinkIds = new Set<string>();
  const edgeResult = resolveEdges({
    candidates,
    taskIdOfNumber,
    suggestLinkId: () => sequentialId('l', seenLinkIds),
    column: 'predecessors',
    reporter: (code, message, detail) => {
      bag.add(code, message, {
        locator: {
          sheet: view.sheetName,
          ...(detail?.column === undefined ? {} : { column: headerTextOf(detail.column) }),
        },
        ...(detail?.taskId === undefined ? {} : { taskId: detail.taskId }),
      });
    },
  });

  const document: ProjectDocument = { ...document1, links: edgeResult.links as readonly DocumentLink[] };

  // 汇总端点：与文档侧 `LINK_SUMMARY_ENDPOINT` **同判据**（有子节点者即汇总，ADR 0006 §4）
  for (const link of document.links) {
    if (hasChildren.has(link.from) || hasChildren.has(link.to)) {
      bag.add('XLSX_DEPENDENCY_SUMMARY_ENDPOINT', '依赖端点是汇总任务（该边在传播中会被忽略，排程侧另有 `summaryIgnored`）', {
        locator: { sheet: view.sheetName, column: headerTextOf('predecessors') },
        linkId: link.id,
      });
    }
  }

  // 文档层校验：error 级诊断以协议层码**转述**（ADR 0006 §7：协议层不重写另两层的码，
  // 但"导入失败"必须能在同一数组里被看到，因此这里保留原文并标注来源码）
  const documentDiagnostics = validateDocument(document);
  for (const diagnostic of documentDiagnostics) {
    if (diagnostic.severity !== 'error') {
      continue;
    }
    bag.add('XLSX_HEADER_ROW_INVALID', `文档校验失败（${diagnostic.code}）：${diagnostic.message}`, {
      locator: { sheet: view.sheetName },
      ...(diagnostic.taskId === undefined ? {} : { taskId: diagnostic.taskId }),
    });
  }

  return { document: bag.hasErrors ? null : document, diagnostics: bag };
}

/**
 * 列探测结果 → 键/列号映射。
 *
 * 形状刻意是**普通对象**（键集固定为 9 个规范列），不是 `Map`：
 * `parseRows` 直接按属性读，少一层查找；`ReadonlyMap` 在结构上是弱类型（没有必需属性），
 * 曾经因此把 `Map` 误当成对象传进来 —— 类型系统不会拦，测试会。返回类型不再接受 `Map`。
 */
export function bindingColumnsOf(
  bindings: readonly { readonly key: ColumnKey; readonly column: number }[],
): ColumnMapping {
  const mapping: Partial<Record<ColumnKey, number>> = {};
  for (const binding of bindings) {
    mapping[binding.key] = binding.column;
  }
  return mapping;
}

/**
 * 应用列映射覆盖（向导第 2 步）。
 *
 * `string` 目标按**表头原文**在表头行里找（包括"未识别列"——那正是人工映射的用途），
 * 找不到则保留原绑定（不静默改列）。
 */
export function applyColumnOverrides(
  base: ColumnMapping,
  view: SheetView,
  headerRow: number,
  overrides: Partial<Record<ColumnKey, ColumnTarget>> | undefined,
): ColumnMapping {
  const mapping: Partial<Record<ColumnKey, number>> = {};
  for (const key of Object.keys(base) as ColumnKey[]) {
    const column = base[key];
    if (column !== undefined) {
      mapping[key] = column;
    }
  }
  if (overrides === undefined) {
    return mapping;
  }
  for (const spec of COLUMN_SPECS) {
    const target = overrides[spec.key];
    if (target === undefined) {
      continue;
    }
    if (typeof target === 'number') {
      if (Number.isInteger(target) && target >= 1) {
        mapping[spec.key] = target;
      }
      continue;
    }
    for (let column = 1; column <= view.maxColumn; column += 1) {
      const cell = view.cell(headerRow, column);
      if (cell?.value.kind === 'text' && cell.value.text.trim() === target.trim()) {
        mapping[spec.key] = column;
        break;
      }
    }
  }
  return mapping;
}

/** 供 CSV 路径复用：表头文本数组 → 键/列号映射。 */
export function mappingFromHeaderTexts(headers: readonly string[]): ColumnMapping {
  const mapping: Partial<Record<ColumnKey, number>> = {};
  headers.forEach((header, index) => {
    const spec = columnSpecOfHeader(header);
    if (spec !== undefined && mapping[spec.key] === undefined) {
      mapping[spec.key] = index + 1;
    }
  });
  return mapping;
}

/** 供测试断言：编号文本的深度（段数 - 1）。 */
export function outlineDepthOfRow(wbsText: string): number {
  return outlineDepthOf(wbsText);
}
