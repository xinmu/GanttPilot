/**
 * 协议层诊断：与文档侧（`DocumentDiagnostic`）/ 排程侧（`ScheduleDiagnostic`）**同形**，
 * 多一个"定位"维度（ADR 0006 §7）。
 *
 * `XLSX_DIAGNOSTIC_CODES` 是**闭集**：不为新原因随手开码，需要时追加 ADR 并同步
 * `docs/02-adr/0006-xlsx-协议契约.md` 与本文件。`diagnostics.spec.ts` 会逐条对照 —— 多一个少一个都失败。
 */
import type { DocumentDiagnostic } from '@ganttpilot/engine';
import type { ScheduleDiagnostic } from '@ganttpilot/engine';

/** 协议层诊断码（**闭集**；**条数以本表为准**，ADR 0006 §7 与文档侧不复述数字）。 */
export type XlsxDiagnosticCode =
  // 结构 / 表头
  | 'XLSX_SHEET_NOT_FOUND'
  | 'XLSX_HEADER_ROW_INVALID'
  | 'XLSX_REQUIRED_COLUMN_MISSING'
  | 'XLSX_UNRECOGNIZED_COLUMN'
  // 行 / 单元格
  | 'XLSX_ROW_MISSING_NAME'
  | 'XLSX_DATE_UNPARSABLE'
  | 'XLSX_DATE_OUT_OF_RANGE'
  | 'XLSX_DATE_HAS_TIME'
  | 'XLSX_DURATION_NOT_INTEGER'
  | 'XLSX_DURATION_NEGATIVE'
  | 'XLSX_PROGRESS_UNPARSABLE'
  | 'XLSX_PROGRESS_OUT_OF_RANGE'
  | 'XLSX_MILESTONE_UNRECOGNIZED'
  // 依赖
  | 'XLSX_DEPENDENCY_UNPARSABLE'
  | 'XLSX_DEPENDENCY_SELF_LOOP'
  | 'XLSX_DEPENDENCY_DUPLICATE'
  | 'XLSX_DEPENDENCY_SUMMARY_ENDPOINT'
  | 'XLSX_LEVEL_CONFLICT'
  | 'XLSX_CYCLE_EDGE_DROPPED'
  // 容忍而不静默
  | 'XLSX_FORMULA_WITHOUT_CACHED_VALUE'
  | 'XLSX_INFERRED_EMPTY_CELL'
  | 'XLSX_TEXT_TRIMMED';

/** 诊断严重度（三层共用同一取值域）。 */
export type XlsxDiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * 值域 → 严重度（ADR 0006 §7 的码表逐条映射）。
 * 单一定义处：测试据此断言码表与 ADR 一致，实现不再各写一份。
 */
export const XLSX_DIAGNOSTIC_SEVERITY: Readonly<Record<XlsxDiagnosticCode, XlsxDiagnosticSeverity>> = {
  XLSX_SHEET_NOT_FOUND: 'error',
  XLSX_HEADER_ROW_INVALID: 'error',
  XLSX_REQUIRED_COLUMN_MISSING: 'error',
  XLSX_UNRECOGNIZED_COLUMN: 'warning',
  XLSX_ROW_MISSING_NAME: 'error',
  XLSX_DATE_UNPARSABLE: 'warning',
  XLSX_DATE_OUT_OF_RANGE: 'error',
  XLSX_DATE_HAS_TIME: 'warning',
  XLSX_DURATION_NOT_INTEGER: 'error',
  XLSX_DURATION_NEGATIVE: 'error',
  XLSX_PROGRESS_UNPARSABLE: 'warning',
  XLSX_PROGRESS_OUT_OF_RANGE: 'error',
  XLSX_MILESTONE_UNRECOGNIZED: 'warning',
  XLSX_DEPENDENCY_UNPARSABLE: 'warning',
  XLSX_DEPENDENCY_SELF_LOOP: 'warning',
  XLSX_DEPENDENCY_DUPLICATE: 'warning',
  XLSX_DEPENDENCY_SUMMARY_ENDPOINT: 'warning',
  XLSX_LEVEL_CONFLICT: 'warning',
  XLSX_CYCLE_EDGE_DROPPED: 'warning',
  XLSX_FORMULA_WITHOUT_CACHED_VALUE: 'info',
  XLSX_INFERRED_EMPTY_CELL: 'info',
  XLSX_TEXT_TRIMMED: 'info',
};

/** 码表顺序即 ADR 0006 §7 的书写顺序（供测试逐条对照）。 */
export const XLSX_DIAGNOSTIC_CODES: readonly XlsxDiagnosticCode[] = Object.keys(
  XLSX_DIAGNOSTIC_SEVERITY,
) as readonly XlsxDiagnosticCode[];

/** 单元格/行的定位（`row` 为 1 基，与 Excel 行号一致；`column` 为规范列名）。 */
export interface XlsxLocator {
  /** 工作表名。 */
  readonly sheet: string;
  /** 1 基行号。 */
  readonly row?: number;
  /** 规范列名（如 `前置任务`）。 */
  readonly column?: string;
  /** A1 形式（如 `F12`），便于直接跳转。 */
  readonly address?: string;
}

/** 协议层诊断（ADR 0006 §1 冻结的形状）。 */
export interface XlsxDiagnostic {
  readonly code: XlsxDiagnosticCode;
  readonly severity: XlsxDiagnosticSeverity;
  readonly message: string;
  readonly locator?: XlsxLocator;
  /** 已落到文档里时带上。 */
  readonly taskId?: string;
  /** 依赖类诊断会带上边 id（可选用途：G4/G5 高亮）。 */
  readonly linkId?: string;
}

/**
 * 最终给用户看的**单一数组**（ADR 0006 §7）：协议层 + 文档层 + 排程层**拼接**，
 * 不合并、不重写另两层的码。
 */
export type ReportDiagnostic = XlsxDiagnostic | DocumentDiagnostic | ScheduleDiagnostic;

/** 拼接三层诊断。协议层在前（它是"文件的形状"），随后是文档层与排程层。 */
export function assembleReport(
  protocol: readonly XlsxDiagnostic[],
  document?: readonly DocumentDiagnostic[],
  schedule?: readonly ScheduleDiagnostic[],
): readonly ReportDiagnostic[] {
  return [...protocol, ...(document ?? []), ...(schedule ?? [])];
}

/** 收集器：把「码 + 定位 + 文案」聚成协议诊断数组（severity 由码表决定，调用方不重复声明）。 */
export class DiagnosticBag {
  readonly #items: XlsxDiagnostic[] = [];

  add(
    code: XlsxDiagnosticCode,
    message: string,
    detail: { readonly locator?: XlsxLocator; readonly taskId?: string; readonly linkId?: string } = {},
  ): XlsxDiagnostic {
    const diagnostic: XlsxDiagnostic = {
      code,
      severity: XLSX_DIAGNOSTIC_SEVERITY[code],
      message,
      ...(detail.locator === undefined ? {} : { locator: detail.locator }),
      ...(detail.taskId === undefined ? {} : { taskId: detail.taskId }),
      ...(detail.linkId === undefined ? {} : { linkId: detail.linkId }),
    };
    this.#items.push(diagnostic);
    return diagnostic;
  }

  get items(): readonly XlsxDiagnostic[] {
    return this.#items;
  }

  get hasErrors(): boolean {
    return this.#items.some((item) => item.severity === 'error');
  }
}

/** 列号（1 基）→ A1 的列字母。 */
export function columnLetter(column: number): string {
  let value = Math.trunc(column);
  if (!Number.isFinite(value) || value < 1) {
    return '';
  }
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}
