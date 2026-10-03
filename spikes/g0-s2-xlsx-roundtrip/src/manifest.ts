/**
 * G0-S-S2 · 规范工作簿的**唯一声明处**。
 *
 * 本文件同时承担三个角色（这是刻意的：把「规范」收敛到一处，避免下游各写一份而互相漂移）：
 *   1. 规范列序与表头的声明；
 *   2. fixture 数据与**声明式期望值表**（验证时比对的是这里的期望，而不是重新序列化的模型——
 *      否则写入器与读取器会共享同一个错误而「全绿」）；
 *   3. 两处**由证据裁决的编码开关**（日期编码、里程碑编码），由 L1/L2 的实测结果回填。
 *
 * ⚠️ 这些列序/表头/编码是**提案**，S2 只验证其可往返性，最终由能力块 G3
 * （`@ganttpilot/xlsx-protocol`）定稿。见 `结论.md` 的「G3 交接清单」。
 */

/** 规范工作表名（导入侧按名称匹配 + 「首个非隐藏表」启发式定位；本 spike 只验证前者）。 */
export const SHEET_NAME = '任务';

/** 表头行所在行号（1 基）。 */
export const HEADER_ROW = 1;

export type ColumnKey =
  | 'wbs'
  | 'name'
  | 'start'
  | 'finish'
  | 'duration'
  | 'predecessors'
  | 'progress'
  | 'milestone'
  | 'note';

export interface ColumnSpec {
  readonly key: ColumnKey;
  /** 规范表头文本（导出即写这个；导入侧允许别名，属 G3 范围）。 */
  readonly header: string;
  readonly width: number;
}

/**
 * 规范列序：身份(WBS) / 名称 / 开始 / 完成 / 工期 / 前置任务 / 进度 / 里程碑 / 备注。
 *
 * 层级由 `wbs` 编号承载（`1.2.3` → 深度 2），另外在 `任务名称` 上施加 `alignment.indent`
 * 仅作**显示**——解析**不得**依赖缩进（`verify-l1.ts` 有专门断言）。
 */
export const COLUMNS: readonly ColumnSpec[] = [
  { key: 'wbs', header: 'WBS', width: 10 },
  { key: 'name', header: '任务名称', width: 34 },
  { key: 'start', header: '开始', width: 12 },
  { key: 'finish', header: '完成', width: 12 },
  { key: 'duration', header: '工期', width: 8 },
  { key: 'predecessors', header: '前置任务', width: 26 },
  { key: 'progress', header: '进度', width: 8 },
  { key: 'milestone', header: '里程碑', width: 8 },
  { key: 'note', header: '备注', width: 30 },
];

/** 列号（1 基）→ 列键。`columnIndex('开始') === 3`。 */
export function columnIndex(key: ColumnKey): number {
  const index = COLUMNS.findIndex((column) => column.key === key);
  if (index < 0) throw new Error(`未声明的列：${key}`);
  return index + 1;
}

/** 列号（1 基）→ 列键。 */
export function keyOfColumn(column: number): ColumnKey | null {
  return COLUMNS[column - 1]?.key ?? null;
}

// ---------------------------------------------------------------------------
// 编码开关（由实测裁决）
// ---------------------------------------------------------------------------

/**
 * 日期编码：`serial` = 真日期（JS `Date` + numFmt `yyyy-mm-dd`，落盘为 1900 序列号）；
 * `iso-text` = ISO 文本 `yyyy-mm-dd`。
 *
 * 判定规则（见 `verify-l1.ts` 的 `date-encoding` 断言与 `结论.md`）：
 * 序列号必须**无小数分量**、且 `Date.UTC` 构造与读取回推一致、WPS 仅保存后仍是日期类型。
 * 任一不成立即改用 `iso-text`。
 */
export const DATE_ENCODING: 'serial' | 'iso-text' = 'serial';

/** 里程碑编码：`boolean`（`t="b"`）或 `text`（`是`/`否`）。解析侧两者都必须接受。 */
export const MILESTONE_ENCODING: 'boolean' | 'text' = 'boolean';

export const NUM_FMT_DATE = 'yyyy-mm-dd';
export const NUM_FMT_PROGRESS = '0%';

/** 里程碑文本编码使用的取值集合。 */
export const MILESTONE_TRUE_TEXT = '是';
export const MILESTONE_FALSE_TEXT = '否';

/**
 * 固定文档时间戳。**必须固定**，否则 `docProps/core.xml` 每次写出都不同，
 * 「同一模型两次导出结构一致」（G7 golden 文件要求的同构项）无法成立。
 */
export const FIXED_TIMESTAMP = new Date('2026-10-03T00:00:00.000Z');
export const DOC_CREATOR = 'ganttpilot-spike-s2';

// ---------------------------------------------------------------------------
// fixture 与声明式期望值表
// ---------------------------------------------------------------------------

export type RelationType = 'FS' | 'SS' | 'FF' | 'SF';

/** 声明式期望（**不是**从 `predecessors` 文本解析出来的）：`from → 本行`。 */
export interface ExpectLink {
  readonly from: string;
  readonly type: RelationType;
  readonly lag: number;
}

export interface ExpectTask {
  readonly wbs: string;
  readonly name: string;
  /** ISO `yyyy-mm-dd`；`null` = 空单元格（DM-05 无日期节点）。 */
  readonly start: string | null;
  readonly finish: string | null;
  readonly duration: number | null;
  /** 前置任务列**原文**（transport 层）。 */
  readonly predecessors: string;
  /** 0..1。 */
  readonly progress: number;
  readonly milestone: boolean;
  readonly note: string;
  /** 显示缩进级别（0 基）。 */
  readonly indent: number;
  /** 期望的依赖边（与 `predecessors` 文本相互独立地声明）。 */
  readonly links: readonly ExpectLink[];
  /** 该行存在的理由（只进报告，不导出）。 */
  readonly caseNote: string;
}

function link(from: string, type: RelationType, lag = 0): ExpectLink {
  return { from, type, lag };
}

/** 超长文本用例（验证长文本在第三方仅保存后逐字符保真）。 */
export const LONG_NAME =
  '超长任务名称测试：验证规范化导出与第三方编辑器仅保存后的逐字符保真度，包含中文、数字 0123456789、' +
  '标点（，。；：！？）、括号【】《》以及混合内容 abcDEFghi 与不间断空格\u00a0结尾。';

/** 备注里故意写成依赖语法形状，验证它**不会**被解析成依赖。 */
export const TRAP_NOTE = '依赖写法示例：3.1[FS]; 4.2[SS+1] —— 这是文本，不是依赖。';

export const FIXTURE: readonly ExpectTask[] = [
  // ── 阶段汇总行：无日期（DM-05 的自然形态） ──────────────────────────────
  {
    wbs: '1',
    name: '需求与设计',
    start: null,
    finish: null,
    duration: null,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '阶段汇总',
    indent: 0,
    links: [],
    caseNote: '汇总行：无日期无工期，验证空单元格在往返后仍为空',
  },
  {
    wbs: '1.1',
    name: '需求调研',
    start: '2026-10-05',
    finish: '2026-10-07',
    duration: 3,
    predecessors: '',
    progress: 1,
    milestone: false,
    note: '',
    indent: 1,
    links: [],
    caseNote: '进度 100%；空备注（可选格缺失）',
  },
  {
    wbs: '1.2',
    name: '需求评审',
    start: '2026-10-08',
    finish: '2026-10-08',
    duration: 0,
    predecessors: '1.1[FS]',
    progress: 1,
    milestone: true,
    note: '评审通过',
    indent: 1,
    links: [link('1.1', 'FS')],
    caseNote: '里程碑 + 工期 0 + FS 关系',
  },
  {
    wbs: '2',
    name: '前端开发',
    start: null,
    finish: null,
    duration: null,
    predecessors: '',
    progress: 0.5,
    milestone: false,
    note: '',
    indent: 0,
    links: [],
    caseNote: '汇总行进度 50%（汇总行进度是新值，不可由内核推导）',
  },
  {
    wbs: '2.1',
    name: '渲染内核',
    start: '2026-10-09',
    finish: '2026-10-22',
    duration: 10,
    predecessors: '1.2[FS]',
    progress: 0.5,
    milestone: false,
    note: '纯 SVG',
    indent: 1,
    links: [link('1.2', 'FS')],
    caseNote: '三级层级的中层节点',
  },
  {
    wbs: '2.1.1',
    name: 'SVG 刻度与条形',
    start: '2026-10-09',
    finish: '2026-10-14',
    duration: 4,
    predecessors: '',
    progress: 1,
    milestone: false,
    note: '',
    indent: 2,
    links: [],
    caseNote: '深度 2（三级层级最深层）',
  },
  {
    wbs: '2.1.2',
    name: '虚拟滚动与裁剪',
    start: '2026-10-15',
    finish: '2026-10-22',
    duration: 6,
    predecessors: '2.1.1[FS]',
    progress: 0,
    milestone: false,
    note: '边窗口求交',
    indent: 2,
    links: [link('2.1.1', 'FS')],
    caseNote: '进度 0%',
  },
  {
    wbs: '2.2',
    name: '交互层',
    start: null,
    finish: null,
    duration: null,
    predecessors: '2.1[FS]',
    progress: 0,
    milestone: false,
    note: '尚未排期（DM-05 无日期节点）',
    indent: 1,
    links: [link('2.1', 'FS')],
    caseNote: '有依赖但无日期的叶子节点',
  },
  {
    wbs: '3',
    name: '排程引擎',
    start: null,
    finish: null,
    duration: null,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '',
    indent: 0,
    links: [],
    caseNote: '汇总行',
  },
  {
    wbs: '3.1',
    name: '日期算术',
    start: '2026-10-05',
    finish: '2026-10-09',
    duration: 5,
    predecessors: '',
    progress: 1,
    milestone: false,
    note: '',
    indent: 1,
    links: [],
    caseNote: '与 1.1 并行，用于检验行序不被列值影响',
  },
  {
    wbs: '3.2',
    name: '正向传播',
    start: '2026-10-12',
    finish: '2026-10-20',
    duration: 7,
    predecessors: '3.1[FS]',
    progress: 0.25,
    milestone: false,
    note: '',
    indent: 1,
    links: [link('3.1', 'FS')],
    caseNote: '进度 25%',
  },
  {
    wbs: '3.3',
    name: '检环与容错',
    start: '2026-10-13',
    finish: '2026-10-14',
    duration: 2,
    predecessors: '3.2[SS-1];2.1[FF+2]',
    progress: 0,
    milestone: false,
    note: '多前置：SS 负 lag + FF 正 lag',
    indent: 1,
    links: [link('3.2', 'SS', -1), link('2.1', 'FF', 2)],
    caseNote: '分号分隔多前置 + SS/FF 关系 + 正负 lag',
  },
  {
    wbs: '3.4',
    name: '里程碑：内测版',
    start: '2026-10-23',
    finish: '2026-10-23',
    duration: 0,
    predecessors: '2.2[FS];3.3[FS]',
    progress: 0,
    milestone: true,
    note: '',
    indent: 1,
    links: [link('2.2', 'FS'), link('3.3', 'FS')],
    caseNote: '里程碑 + 多前置（其一为无日期节点）',
  },
  {
    wbs: '4',
    name: '导出链路',
    start: null,
    finish: null,
    duration: null,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '',
    indent: 0,
    links: [],
    caseNote: '汇总行',
  },
  {
    wbs: '4.1',
    name: 'SVG 导出',
    start: '2026-10-23',
    finish: '2026-10-28',
    duration: 4,
    predecessors: '2.1.2[SS+1]',
    progress: 0,
    milestone: false,
    note: '',
    indent: 1,
    links: [link('2.1.2', 'SS', 1)],
    caseNote: 'SS 正 lag',
  },
  {
    wbs: '4.2',
    name: 'PPTX 导出',
    start: '2026-10-27',
    finish: '2026-11-03',
    duration: 6,
    predecessors: '4.1[FS-1]',
    progress: 0,
    milestone: false,
    note: '负 lag',
    indent: 1,
    links: [link('4.1', 'FS', -1)],
    caseNote: 'FS 负 lag（`-` 前缀在依赖列里是合法语法，不能被当作公式前缀）',
  },
  {
    wbs: '4.3',
    name: '里程碑：v0.1 发布',
    start: '2026-11-04',
    finish: '2026-11-04',
    duration: 0,
    predecessors: '4.2[FF]',
    progress: 0,
    milestone: true,
    note: '',
    indent: 1,
    links: [link('4.2', 'FF')],
    caseNote: 'FF 关系 + 里程碑',
  },
  {
    wbs: '4.4',
    name: '端到端验收',
    start: '2026-11-05',
    finish: '2026-11-06',
    duration: 2,
    predecessors: '3.4[SF+1]',
    progress: 0,
    milestone: false,
    note: 'SF 关系',
    indent: 1,
    links: [link('3.4', 'SF', 1)],
    caseNote: 'SF 关系（四类关系全覆盖）',
  },
  {
    wbs: '5',
    name: '边界与脏数据',
    start: null,
    finish: null,
    duration: null,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '非真实计划，仅用于协议回归',
    indent: 0,
    links: [],
    caseNote: '汇总行',
  },
  {
    wbs: '5.1',
    name: '未排期占位',
    start: null,
    finish: null,
    duration: null,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '空日期',
    indent: 1,
    links: [],
    caseNote: '整行只有身份与名称（最小行）',
  },
  {
    wbs: '5.2',
    name: '=SUM(A1:A2) 预算检查',
    start: '2026-11-09',
    finish: '2026-11-09',
    duration: 1,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '以 = 开头（G-9 观测项）',
    indent: 1,
    links: [],
    caseNote: '公式注入面：`=` 前缀文本必须原样往返、不得被当作公式',
  },
  {
    wbs: '5.3',
    name: '+45 天缓冲',
    start: '2026-11-10',
    finish: '2026-11-10',
    duration: 1,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '以 + 开头（G-9 观测项）',
    indent: 1,
    links: [],
    caseNote: '公式注入面：`+` 前缀文本',
  },
  {
    wbs: '5.4',
    name: '-待确认-',
    start: '2026-11-11',
    finish: '2026-11-11',
    duration: 1,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '以 - 开头（G-9 观测项）',
    indent: 1,
    links: [],
    caseNote: '公式注入面：`-` 前缀文本',
  },
  {
    wbs: '5.5',
    name: '@张三 跟进',
    start: '2026-11-12',
    finish: '2026-11-12',
    duration: 1,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '以 @ 开头（G-9 观测项）',
    indent: 1,
    links: [],
    caseNote: '公式注入面：`@` 前缀文本',
  },
  {
    wbs: '5.6',
    name: LONG_NAME,
    start: '2026-11-13',
    finish: '2026-11-13',
    duration: 1,
    predecessors: '',
    progress: 0,
    milestone: false,
    note: '',
    indent: 1,
    links: [],
    caseNote: '超长文本 + 中文标点 + 不间断空格',
  },
  {
    wbs: '5.7',
    name: '里程碑 🎯 中文与 emoji',
    start: '2026-11-16',
    finish: '2026-11-16',
    duration: 0,
    predecessors: '5.6[FS]',
    progress: 1,
    milestone: true,
    note: '',
    indent: 1,
    links: [link('5.6', 'FS')],
    caseNote: 'emoji（代理对）在共享字符串中的保真',
  },
  {
    wbs: '5.8',
    name: '语义混淆文本',
    start: '2026-11-17',
    finish: '2026-11-17',
    duration: 1,
    predecessors: '5.7[FS]',
    progress: 0.5,
    milestone: false,
    note: TRAP_NOTE,
    indent: 1,
    links: [link('5.7', 'FS')],
    caseNote: '备注含依赖语法形状的文本，验证「备注不参与依赖解析」',
  },
  {
    wbs: '5.9',
    name: '无前置的收尾',
    start: '2026-11-18',
    finish: '2026-11-18',
    duration: 1,
    predecessors: '4.4',
    progress: 0,
    milestone: false,
    note: '省略类型 → 默认 FS',
    indent: 1,
    links: [link('4.4', 'FS')],
    caseNote: '依赖语法省略类型（默认 FS）',
  },
];

/** 期望的完整边集合（`to` 由所在行决定）。 */
export function expectedEdges(): { from: string; to: string; type: RelationType; lag: number }[] {
  const edges: { from: string; to: string; type: RelationType; lag: number }[] = [];
  for (const task of FIXTURE) {
    for (const edge of task.links) {
      edges.push({ from: edge.from, to: task.wbs, type: edge.type, lag: edge.lag });
    }
  }
  return edges;
}

/** fixture 的规模自述（报告里直接引用，避免手写数字与数据漂移）。 */
export const FIXTURE_STATS = {
  rows: FIXTURE.length,
  edges: expectedEdges().length,
  maxDepth: Math.max(...FIXTURE.map((task) => task.wbs.split('.').length - 1)),
  milestones: FIXTURE.filter((task) => task.milestone).length,
  nullDates: FIXTURE.filter((task) => task.start === null).length,
  relationTypes: [...new Set(expectedEdges().map((edge) => edge.type))].sort(),
} as const;
