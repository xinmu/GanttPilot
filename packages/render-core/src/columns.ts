/**
 * 列契约（**列身份的唯一真相源**，ADR 0008 §1–§3）。
 *
 * ## 为什么列身份由本包拥有（所有权反转）
 *
 * G3 起列契约原在 `@ganttpilot/xlsx-protocol` 的 `columns.ts`，但**消费方比生产方更多**：
 * 左表列集合（ADR 0007 §8）、`cellText` 的列分支、编辑通道的可编辑列集合、G7 导出投影
 * 全都需要同一份列身份，而它们都不需要 `exceljs`。P-19 §5 ② 因此把所有权**反转**给本包：
 *
 * - 依赖方向变为 `engine ← render-core ← xlsx-protocol`（**单一方向**，不拉 `exceljs`）；
 * - `xlsx-protocol` 的 `columns.ts` 与公共入口**转型再导出**本模块 ⇒ 它的公共 API 面一个符号不减；
 * - `apps/web` 不再为了列名静态 import `xlsx-protocol`（原先会造出与「动态 `import('exceljs')`」
 *   自相矛盾的 import 边，ADR 0006 §11）。
 *
 * **维护纪律**：本文件是**列契约的单一定义处**；表头文本、必需性、列宽都从这里取，
 * 导入、导出、`detectColumns`、左表与测试**不各自抄一份**。
 * 改列集合必须同步 `xlsx-protocol/PROTOCOL.md`（ADR 0006 §2 的契约表）。
 *
 * 契约出处：`docs/02-adr/0006-xlsx-协议契约.md` §2（列契约）+
 * `docs/02-adr/0008-列身份所有权与拖拽交互契约.md` §1–§3（所有权与依赖方向）。
 */

/** 规范列名的键（内部标识；用户看到的是 `header`）。 */
export type ColumnKey =
  | 'wbs'
  | 'name'
  | 'start'
  | 'end'
  | 'duration'
  | 'predecessors'
  | 'progress'
  | 'milestone'
  | 'notes';

/** 必需性（ADR 0006 §2 的「必需性」列；**导入口径**，与"能否行内编辑"无关）。 */
export type ColumnRequirement =
  /** 必需：缺失即 `XLSX_REQUIRED_COLUMN_MISSING`（`任务名称`）。 */
  | 'required'
  /** 与缩进式二选一（`WBS`）：它与缩进**同时**缺失才报缺列。 */
  | 'hierarchy'
  /** 可选。 */
  | 'optional';

export interface ColumnSpec {
  readonly key: ColumnKey;
  /** 表头文本（导出原样写出，导入按它匹配）。 */
  readonly header: string;
  readonly requirement: ColumnRequirement;
  /** 导出列宽（白名单内的呈现属性，ADR 0006 §10）。 */
  readonly width: number;
  /** 该列承载日期（导入时"数值 + 日期格式"按日期解读，ADR 0006 §4）。 */
  readonly dateLike?: boolean;
}

/** 9 列规范列序（导出固定此序）。 */
export const COLUMN_SPECS: readonly ColumnSpec[] = [
  { key: 'wbs', header: 'WBS', requirement: 'hierarchy', width: 10 },
  { key: 'name', header: '任务名称', requirement: 'required', width: 32 },
  { key: 'start', header: '开始', requirement: 'optional', width: 12, dateLike: true },
  { key: 'end', header: '完成', requirement: 'optional', width: 12, dateLike: true },
  { key: 'duration', header: '工期', requirement: 'optional', width: 8 },
  { key: 'predecessors', header: '前置任务', requirement: 'optional', width: 20 },
  { key: 'progress', header: '进度', requirement: 'optional', width: 8 },
  { key: 'milestone', header: '里程碑', requirement: 'optional', width: 8 },
  { key: 'notes', header: '备注', requirement: 'optional', width: 28 },
];

/** 规范表名（可见；无影子表、无隐藏表——T-2 已删除 `__gantt_meta__`）。 */
export const SHEET_NAME = '任务';

/** 表头行（1 基）。 */
export const HEADER_ROW = 1;

/** 表头 → 列规格（大小写与前后空白归一）。 */
const BY_HEADER = new Map<string, ColumnSpec>();
for (const spec of COLUMN_SPECS) {
  BY_HEADER.set(spec.header, spec);
  BY_HEADER.set(spec.header.toLowerCase(), spec);
}

/** 用表头文本查列规格（容忍大小写与首尾空白；不做模糊匹配——容差表是闭集）。 */
export function columnSpecOfHeader(text: string): ColumnSpec | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  return BY_HEADER.get(trimmed) ?? BY_HEADER.get(trimmed.toLowerCase());
}

/** 日期列（用于"数值 + 日期格式"的解读，ADR 0006 §4）。 */
export const DATE_LIKE_COLUMNS: readonly ColumnKey[] = COLUMN_SPECS.filter(
  (spec) => spec.dateLike === true,
).map((spec) => spec.key);

/** 列序（1 基）→ 键（导出用）。 */
export function columnKeyOfIndex(index: number): ColumnKey | undefined {
  return COLUMN_SPECS[index - 1]?.key;
}

/** 键 → 列序（1 基，导出用）。 */
export function columnIndexOfKey(key: ColumnKey): number {
  return COLUMN_SPECS.findIndex((spec) => spec.key === key) + 1;
}

/** 可在左表**行内编辑**的列（`wbs` 是派生值、`predecessors` 归建线手势，ADR 0007 §8）。 */
export const EDITABLE_COLUMNS: readonly ColumnKey[] = [
  'name',
  'start',
  'end',
  'duration',
  'progress',
  'milestone',
  'notes',
];

/** 左表的一列：列身份 + 表头 + 可编辑性（列序与表头都从 `COLUMN_SPECS` 取）。 */
export interface TableColumn {
  readonly key: ColumnKey;
  readonly header: string;
  readonly editable: boolean;
}

/** 左表列集合（**锚 G3 的 9 列契约**，不新造第四套列语义；ADR 0007 §8）。 */
export const TABLE_COLUMNS: readonly TableColumn[] = COLUMN_SPECS.map((spec) => ({
  key: spec.key,
  header: spec.header,
  editable: EDITABLE_COLUMNS.includes(spec.key),
}));
