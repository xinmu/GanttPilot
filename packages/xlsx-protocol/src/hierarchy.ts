/**
 * 层级解析（ADR 0006 §6）：`WBS` 编号列（主）与**缩进式**双解析。
 *
 * 三条容易踩的：
 * 1. **缩进只依赖相对深度**，绝不依赖 `alignment.indent` 的**取值**——WPS 会改写它（S2 §三.2）；
 * 2. 两者同时存在且结论不一致 → `XLSX_LEVEL_CONFLICT`(warning)，**以编号为准**并记录冲突行（不静默择一）；
 * 3. 编号列与缩进**同时**缺失才报 `XLSX_REQUIRED_COLUMN_MISSING`（ADR 0006 §2 的"二选一"）。
 */
import type { Reporter } from './values.js';

/** 规范编号：每段为十进制整数、无前导零（`0` 本身合法）、段数 ≤ 20（`MAX_OUTLINE_DEPTH`）。 */
export function validateOutlineNumber(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') {
    return false;
  }
  const segments = trimmed.split('.');
  if (segments.length > 20) {
    return false;
  }
  return segments.every((segment) => /^(?:0|[1-9]\d*)$/.test(segment));
}

/** 编号 → 深度（段数 - 1）。 */
export function outlineDepthOf(text: string): number {
  return text.trim().split('.').length - 1;
}

/** 保留前 `depth + 1` 段（"父编号"）。 */
export function outlinePrefix(text: string, depth: number): string {
  return text.trim().split('.').slice(0, depth + 1).join('.');
}

/** 单行解析出的层级素材。 */
export interface HierarchyRowInput {
  /** 1 基表格行号（诊断定位与父指针用）。 */
  readonly row: number;
  /** 工作表里写的 WBS 编号（原样，可能为空/非法）。 */
  readonly wbsText: string;
  /** `任务名称` 单元格的缩进（仅在**同一列内**比较相对大小）。 */
  readonly indent: number;
}

/** 一行的层级结论。 */
export interface HierarchyRow {
  readonly row: number;
  /** 父行的**行号**（`null` = 顶层）。 */
  readonly parentRow: number | null;
  /** 该行在工作表里的编号（编号列原样值；缩进式下用行号，仅作唯一键）。 */
  readonly sheetNumber: string;
}

/** 层级解析结论。 */
export interface HierarchyResolution {
  readonly rows: readonly HierarchyRow[];
  /** 是否使用了编号列（`false` = 缩进式）。 */
  readonly byNumber: boolean;
}

/**
 * 由**相对缩进**推导层级。
 *
 * 算法：维护"深度 → 行号"的栈；缩进严格大于栈顶时下钻，等于栈顶时同级，
 * 小于栈顶时上浮到第一个不大于它的深度。**任何缩进取值本身都不参与判断**。
 */
function resolveByIndent(rows: readonly HierarchyRowInput[]): readonly HierarchyRow[] {
  const stack: { readonly indent: number; readonly row: number }[] = [];
  const result: HierarchyRow[] = [];

  for (const row of rows) {
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) > row.indent) {
      stack.pop();
    }
    const parentRow = stack.length > 0 ? (stack[stack.length - 1]?.row ?? null) : null;
    result.push({ row: row.row, parentRow, sheetNumber: String(row.row) });
    stack.push({ indent: row.indent, row: row.row });
  }
  return result;
}

/**
 * 由编号列推导层级（父 = "去掉最后一段"的编号所在行）。
 *
 * 编号缺失/非法的行按顶层处理（错误由调用方报 `XLSX_HEADER_ROW_INVALID` 之外的行级诊断）；
 * **重复编号**同样按顶层处理，避免"两个 1.2"互相成为对方的父。
 */
function resolveByNumber(rows: readonly HierarchyRowInput[]): readonly HierarchyRow[] {
  const rowOfNumber = new Map<string, number>();
  const seen = new Set<string>();
  const result: HierarchyRow[] = [];

  for (const row of rows) {
    const number = row.wbsText.trim();
    if (number !== '' && validateOutlineNumber(number) && !seen.has(number)) {
      rowOfNumber.set(number, row.row);
      seen.add(number);
    }
  }

  for (const row of rows) {
    const number = row.wbsText.trim();
    const depth = outlineDepthOf(number);
    let parentRow: number | null = null;
    if (number !== '' && validateOutlineNumber(number) && depth > 0) {
      parentRow = rowOfNumber.get(outlinePrefix(number, depth - 1)) ?? null;
    }
    result.push({ row: row.row, parentRow, sheetNumber: number });
  }
  return result;
}

/**
 * 双解析。
 *
 * `hasWbsColumn === false` 时只走缩进式；两者都在时比较"父行是否一致"。
 *
 * **只比较"缩进确实承载了信息"的行**：`alignment.indent` 缺省为 0，若把 0 也当成
 * "它声明这是顶层"，那么**每个带 WBS 但没写缩进的文件都会被判成冲突**——那不是冲突，
 * 那只是缩进这一路没信息。冲突的定义限定为"同一列内缩进相对深度所表达的父子关系，
 * 与编号给出的父子关系不一致"（ADR 0006 §6：比的是**结论**，且缩进只在相对意义上成立）。
 */
export function resolveHierarchy(
  rows: readonly HierarchyRowInput[],
  hasWbsColumn: boolean,
  reporter: Reporter,
): HierarchyResolution {
  if (!hasWbsColumn) {
    return { rows: resolveByIndent(rows), byNumber: false };
  }

  const byNumber = resolveByNumber(rows);
  const byIndent = resolveByIndent(rows);

  // 缩进是否真的承载信息：整列全是 0 ⇒ 没有信息，不做冲突判定
  const indentInUse = rows.some((row) => row.indent > 0);

  const conflictRows: number[] = [];
  const validNumberRows = new Set(
    rows.filter((row) => validateOutlineNumber(row.wbsText)).map((row) => row.row),
  );
  byNumber.forEach((row, index) => {
    if (!indentInUse || !validNumberRows.has(row.row)) {
      return;
    }
    const indentRow = byIndent[index];
    if (indentRow !== undefined && row.parentRow !== indentRow.parentRow) {
      conflictRows.push(row.row);
    }
  });

  if (conflictRows.length > 0) {
    reporter(
      'XLSX_LEVEL_CONFLICT',
      `编号列与缩进式的层级结论不一致（以编号为准，冲突行：${conflictRows.join('、')}）`,
    );
  }

  return { rows: byNumber, byNumber: true };
}
