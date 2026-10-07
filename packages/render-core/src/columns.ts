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

// ---------------------------------------------------------------- 左表列宽（屏幕几何；P3/C6-e）

/**
 * **左表的列宽归一（屏幕像素）**。
 *
 * ## 为什么列宽要在这里、而不是在 `TaskTable.vue`
 *
 * `COLUMN_SPECS.width` 是**导出用的字符宽度**（`wbs: 10`、`name: 32`），不是像素；
 * 左表此前自己把它换算成像素并配一张下限表（P-48 的 ①②：表头排成两行、`WBS` 列被省略号吃掉，
 * 两次都是"手写的 `grid-template-columns` 与 `COLUMN_SPECS` 已经不一致"）。
 * 换算规则与下限表因此和**列身份**是同一件事的两面：列一变，宽与下限都要跟着变，
 * 分居两个包就一定会漂——所以收进列契约的同一个文件。
 *
 * `px = max(下限, round(字符宽 × 6.5))`：6.5 px/字符 ≈ 12 px 字号的汉字宽（略宽于英文）。
 */
export const TABLE_COLUMN_CHAR_PX = 6.5;

/**
 * 每列的**语义下限**（px）：保的是"这一列至少能放下它自己的表头与典型内容"。
 *
 * | 列 | 导出宽度 | 归一 | 下限的来历 |
 * |---|---|---|---|
 * | `WBS` | 10 | 65 | `1.2.3` + **折叠按钮 18 px** |
 * | `任务名称` | 32 | 208 | 名称 + 每级 12 px 的缩进（`INDENT_PX_PER_LEVEL`，`manifest.ts`） |
 * | `开始`/`完成` | 12 | 78 | 十字符日期 |
 * | `工期` | 8 | 56 | 三字符数字 + 右对齐内边距 |
 * | `前置任务` | 20 | 130 | `1.3FS` / `1.3SS-2` 可直接照抄 |
 * | `进度`/`里程碑` | 8 | 56 | 百分比 / 是·否 |
 * | `备注` | 28 | 182 | 略窄于名称列 |
 */
export const TABLE_COLUMN_MIN_PX: Readonly<Record<ColumnKey, number>> = {
  wbs: 65,
  name: 208,
  start: 78,
  end: 78,
  duration: 56,
  predecessors: 130,
  progress: 56,
  milestone: 56,
  notes: 182,
};

/** 左表逐列像素宽（与 `COLUMN_SPECS` 同序：宽与列身份永远同源）。 */
export function tableColumnWidths(): readonly number[] {
  return COLUMN_SPECS.map((spec) =>
    Math.max(TABLE_COLUMN_MIN_PX[spec.key], Math.round(spec.width * TABLE_COLUMN_CHAR_PX)),
  );
}

/**
 * 左表的 `grid-template-columns`（表头与表体**共用**它——两栏内部对齐的前提）。
 *
 * 合计 **909 px**（= 下限之和：九列的下限**全都**不小于字符宽归一，故两数恒等；
 * 见 `columns.spec.ts` 的两条断言）。`.table-pane` 是 `flex: 0 0 auto`（不拉伸），
 * 剩余宽度全给图表 ⇒ 窗口更窄时左表不压缩（不做响应式收缩）。
 *
 * **P3/C6-e 订正**：此处（以及 `README`）长期写着"合计 992 px（下限之和 906 px）"，
 * 两个数**都与实现不符**——按上面这条公式算出来是 909，且从头到尾都是 909
 * （`af408ce` 引入该公式时的宽度表与今天逐值相同）。数字写错而无人发现，是因为
 * 它此前只出现在散文里、没有任何断言；现在它由 `columns.spec.ts` 钉住。
 */
export function tableColumnTemplate(): string {
  return tableColumnWidths()
    .map((width) => `${String(width)}px`)
    .join(' ');
}
