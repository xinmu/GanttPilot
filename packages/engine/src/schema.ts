/**
 * 文档模型、版本迁移与结构校验（G1.2 的公共面）。
 *
 * 形状来自原文 §6，语义由以下裁决冻结：
 * - **DM-07**：单文档 JSON + 版本化 schema + 迁移骨架（含未知版本拒绝）；
 * - **DM-02/DM-05**：核心字段（名称/日期/工期/进度/里程碑/备注），**日期字段可空**；
 * - **DM-01**：WBS 层级（`parentId` + 派生编号 + 折叠状态字段）；
 * - **DM-03 + R-1**：4 类关系 `FS/SS/FF/SF` + lag（**工作日整数、可为负**，归属项目日历）；
 * - **DM-08/DM-09 + R-3**：`constraints[]` 与 `manual` **字段留位、语义未启用**（v0.5）；
 * - **P1-03**：`baselines` 留位（内容 v0.5）；
 * - **P-10 第 4 条**（本块的设计决定）：文档落盘用 **ISO 日期 + 工作日工期**，
 *   **工作日序号只出现在引擎入参边界**——避免文档被日历地平线容量绑定。
 *
 * ## 三个必须一起读的口径
 *
 * 1. **`null` 表示"缺失"**，且序列化**始终显式写出全部规范字段**（含 `null` 与空数组），
 *    因此往返可以用 `toStrictEqual` 深比较。缺键在反序列化时被归一为 `null`，
 *    但会产出 **`info` 级诊断**（`DOC_FIELD_OMITTED`）——容忍而不静默。
 * 2. **`outlineNumber` 是派生值**：由层级 + 文档序唯一确定（`1` / `1.2` / `1.2.3`）。
 *    它出现在文档里是因为 G3 的 xlsx 导出必须自足，但它**不是真相源**：
 *    校验对"存值 ≠ 计算值"报 `TREE_OUTLINE_STALE`，修复动作是 `reindexDocument`（见 `wbs.ts`）。
 * 3. **日历校验直接调用 G1.1 的 `Calendar` 构造器**，不重写规则——
 *    这样"文档里合法的日历"与"引擎构造得出的日历"不可能分叉。
 *
 * 本文件零 DOM、零框架依赖，只依赖 `./date.js` 与 `./wbs.js`。
 */

import { Calendar, type CalendarSpec, dayNumberToIso, isoToDayNumber, parseIsoDate } from './date.js';
import {
  type DiagnosticLike,
  type JsonValue,
  isRecord,
  OUTLINE_SEPARATOR,
  reindexTasks,
  validateHierarchy,
  validateTasksShape,
} from './wbs.js';

export type { JsonArray, JsonObject, JsonValue } from './wbs.js';

// ---------------------------------------------------------------- 常量

/** 当前文档 schema 版本（原文 §6 写死 `version: 3`）。 */
export const CURRENT_DOCUMENT_VERSION = 3;

/** 本骨架声明支持迁移的最早版本；更早的版本按"未知版本"明确拒绝。 */
export const MIN_SUPPORTED_DOCUMENT_VERSION = 1;

/** 本骨架可迁移到的版本区间（闭区间，供展示与断言）。 */
export const SUPPORTED_DOCUMENT_VERSIONS: readonly number[] = Object.freeze(
  Array.from(
    { length: CURRENT_DOCUMENT_VERSION - MIN_SUPPORTED_DOCUMENT_VERSION + 1 },
    (_, offset) => MIN_SUPPORTED_DOCUMENT_VERSION + offset,
  ),
);

/** 4 类依赖关系（DM-03）。 */
export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';

/** 全部合法关系类型（供校验与 UI 遍历；顺序与原文一致）。 */
export const LINK_TYPES: readonly LinkType[] = ['FS', 'SS', 'FF', 'SF'];

/** 工期上限（工作日）：只为挡住明显异常值；产品规模承诺是 PRD-04 的 2,000 任务。 */
export const MAX_DURATION_DAYS = 1_000_000;

/** lag 上限（工作日，可负）：同上。 */
export const MAX_LAG_DAYS = 100_000;

// ---------------------------------------------------------------- 诊断

/**
 * 稳定诊断码（公共契约）。
 *
 * 前缀分组：`DOC_*` 形状与版本、各域前缀（`PROJECT_`/`CALENDAR_`/`TASK_`/`LINK_`/`BASELINE_`）、
 * `TREE_*` 层级不变量。**码值不随实现变化**——G3 的导入诊断报告与测试都据此断言。
 */
export type DocumentDiagnosticCode =
  // 形状与版本
  | 'DOC_JSON_SYNTAX'
  | 'DOC_ROOT_NOT_OBJECT'
  | 'DOC_VERSION_MISSING'
  | 'DOC_VERSION_UNKNOWN'
  | 'DOC_FIELD_OMITTED'
  | 'DOC_FIELD_TYPE_INVALID'
  | 'MIGRATION_CYCLE'
  // project
  | 'PROJECT_MISSING'
  | 'PROJECT_NAME_INVALID'
  | 'PROJECT_BASE_CALENDAR_MISSING'
  // calendars
  | 'CALENDAR_MISSING'
  | 'CALENDAR_INVALID'
  | 'CALENDAR_NOT_REFERENCED'
  // tasks
  | 'TASK_MISSING'
  | 'TASK_ID_INVALID'
  | 'TASK_DUPLICATE_ID'
  | 'TASK_NAME_INVALID'
  | 'TASK_DATE_INVALID'
  | 'TASK_END_BEFORE_START'
  | 'TASK_DURATION_INVALID'
  | 'TASK_DURATION_WITHOUT_DATES'
  | 'TASK_PROGRESS_INVALID'
  | 'TASK_MILESTONE_INVALID'
  | 'TASK_MILESTONE_WITH_DURATION'
  | 'TASK_COLLAPSED_INVALID'
  | 'TASK_NOTES_INVALID'
  | 'TASK_CONSTRAINTS_INVALID'
  | 'TASK_MANUAL_INVALID'
  // links
  | 'LINK_MISSING'
  | 'LINK_ID_INVALID'
  | 'LINK_DUPLICATE_ID'
  | 'LINK_TYPE_INVALID'
  | 'LINK_LAG_INVALID'
  | 'LINK_DANGLING_FROM'
  | 'LINK_DANGLING_TO'
  | 'LINK_SELF_REFERENCE'
  | 'LINK_SUMMARY_ENDPOINT'
  // baselines
  | 'BASELINE_MISSING'
  | 'BASELINE_ID_INVALID'
  | 'BASELINE_DUPLICATE_ID'
  | 'BASELINE_NAME_INVALID'
  | 'BASELINE_CREATED_AT_INVALID'
  | 'BASELINE_SNAPSHOT_INVALID'
  // 层级不变量（实现在 wbs.ts）
  | 'TREE_PARENT_MISSING'
  | 'TREE_CYCLE'
  | 'TREE_OUTLINE_NOT_UNIQUE'
  | 'TREE_OUTLINE_STALE'
  | 'TREE_DEPTH_EXCEEDED';

/** 诊断严重级别：`error` 阻断（`parseDocument` 会抛），`warning`/`info` 不阻断。 */
export type DocumentDiagnosticSeverity = 'error' | 'warning' | 'info';

/** 一条结构化诊断。`path` 用 JSON 路径风格（如 `tasks[3].startDate`）。 */
export interface DocumentDiagnostic extends DiagnosticLike {
  readonly code: DocumentDiagnosticCode;
  readonly severity: DocumentDiagnosticSeverity;
}

// ---------------------------------------------------------------- 文档类型

/** 任务约束（DM-08）：**字段留位、语义按 R-3 在 v0.5 细化**，本块只校验"JSON 对象数组"。 */
export interface TaskConstraint {
  readonly [key: string]: JsonValue;
}

/** 项目级元数据。 */
export interface ProjectMeta {
  readonly name: string;
  readonly description: string | null;
  /**
   * 生效的项目日历 id（R-1：v0.1 只有这一份生效）。
   * 空字符串表示"未指定"——按 `calendars[0]` 解释。
   */
  readonly baseCalendarId: string;
  /** 项目开始日：排程的**项目起点基准**（[ADR 0004](../../../docs/02-adr/0004-排程契约.md) §4）。 */
  readonly startDate: string | null;
  /** 项目完成日（同上）。 */
  readonly finishDate: string | null;
}

/** 任务节点（DM-01/DM-02/DM-03/DM-05）。 */
export interface DocumentTask {
  readonly id: string;
  readonly parentId: string | null;
  /**
   * WBS 编号（如 `1` / `1.2` / `1.2.3`）。**派生值**——由层级 + 文档序唯一确定；
   * 存值不一致会被校验报 `TREE_OUTLINE_STALE`，修复用 `reindexDocument`。
   */
  readonly outlineNumber: string;
  readonly name: string;
  /** 日期字段可空（DM-05）。 */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** 工期（**工作日整数**，可为 0，不可为负）。 */
  readonly durationDays: number | null;
  /** 进度 `[0, 1]`，`null` 表示未知。 */
  readonly progress: number | null;
  readonly milestone: boolean;
  /** 折叠状态（DM-01）：**只承载状态字段**，渲染行为归 G4。 */
  readonly collapsed: boolean;
  readonly notes: string | null;
  /** DM-09：**字段留位、语义未启用**（R-3 → v0.5）。 */
  readonly manual: boolean;
  /** DM-08：**字段留位、语义未启用**（R-3 → v0.5）。 */
  readonly constraints: readonly TaskConstraint[];
}

/** 依赖边（DM-03）。 */
export interface DocumentLink {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: LinkType;
  /**
   * lag（**工作日整数，可为负**）。负 lag 越到项目起点之前的语义**已定**（截断到项目起点 +
   * 计数与诊断，[ADR 0004](../../../docs/02-adr/0004-排程契约.md) §4；[S3 结论 §五.4](../../../spikes/g0-s3-cpm-perf/结论.md)），
   * 本块只保证**可表达 + 范围校验**。
   */
  readonly lagDays: number;
}

/** 基线条目（P1-03）：**内容 v0.5 定义**，本块留位。 */
export interface DocumentBaseline {
  readonly id: string;
  readonly name: string;
  /** ISO 时间戳（如 `2026-01-01T00:00:00.000Z`）。 */
  readonly createdAt: string;
  /** 不透明快照：校验"是 JSON 值"，不解释内容。 */
  readonly snapshot: JsonValue;
}

/** 单文档 JSON 模型（原文 §6）。 */
export interface ProjectDocument {
  readonly version: number;
  readonly project: ProjectMeta;
  /** 日历集合（DM-06）；**v0.1 仅 `project.baseCalendarId` 指向的那份生效**（R-1）。 */
  readonly calendars: readonly CalendarSpec[];
  readonly tasks: readonly DocumentTask[];
  readonly links: readonly DocumentLink[];
  readonly baselines: readonly DocumentBaseline[];
}

// ---------------------------------------------------------------- 形状归一

/**
 * 规范化的日历写法。
 *
 * 一处**刻意的不对称**：`workDays` 为空数组时**省略**该字段，而不是写出 `[]`。
 * 原因是 `CalendarSpec.workDays` 的语义由 G1.1 钉死——`undefined` = 用默认工作日，
 * 而空数组是"没有任何工作日"（G1.1 会抛错拒绝）。若规范形状写出 `[]`，
 * 往返回来的文档就会变成非法文档。因此"省略"在这里是**语义的一部分**，不是省字节。
 *
 * `exceptions` 的两个集合则始终显式写出：空数组对 G1.1 是合法输入（= 无例外），
 * 显式写出让"未启用例外"与"误删字段"在 diff 中可区分。
 */
function canonicalizeCalendarSpec(spec: CalendarSpec): JsonValue {
  const workDays = spec.workDays ?? [];
  return {
    id: spec.id ?? 'project',
    ...(workDays.length === 0 ? {} : { workDays: [...workDays] }),
    exceptions: {
      nonWorking: spec.exceptions?.nonWorking === undefined ? [] : [...spec.exceptions.nonWorking],
      working: spec.exceptions?.working === undefined ? [] : [...spec.exceptions.working],
    },
  };
}

/** 把文档转成**键序固定、字段齐全**的 JSON 值——`serializeDocument` 的唯一输入形状。 */
export function canonicalizeDocument(document: ProjectDocument): JsonValue {
  return {
    version: document.version,
    project: {
      name: document.project.name,
      description: document.project.description,
      baseCalendarId: document.project.baseCalendarId,
      startDate: document.project.startDate,
      finishDate: document.project.finishDate,
    },
    calendars: document.calendars.map((spec) => canonicalizeCalendarSpec(spec)),
    tasks: document.tasks.map((task) => ({
      id: task.id,
      parentId: task.parentId,
      outlineNumber: task.outlineNumber,
      name: task.name,
      startDate: task.startDate,
      endDate: task.endDate,
      durationDays: task.durationDays,
      progress: task.progress,
      milestone: task.milestone,
      collapsed: task.collapsed,
      notes: task.notes,
      manual: task.manual,
      constraints: task.constraints.map((constraint) => constraint),
    })),
    links: document.links.map((link) => ({
      id: link.id,
      from: link.from,
      to: link.to,
      type: link.type,
      lagDays: link.lagDays,
    })),
    baselines: document.baselines.map((baseline) => ({
      id: baseline.id,
      name: baseline.name,
      createdAt: baseline.createdAt,
      snapshot: baseline.snapshot,
    })),
  };
}

/** 序列化为规范 JSON 文本（稳定键序、2 空格缩进、结尾换行）。 */
export function serializeDocument(document: ProjectDocument): string {
  return `${JSON.stringify(canonicalizeDocument(document), null, 2)}\n`;
}

// ---------------------------------------------------------------- 归一上下文

/** 诊断收集器：把「形状归一」与「诊断」一次走完，避免两遍解析。 */
interface CoercionContext {
  readonly diagnostics: DocumentDiagnostic[];
  /** 顶层字段被省略时是否报 `info`（`validateDocument` 为真；内部迁移路径为假）。 */
  readonly noticeOmitted: boolean;
}

function report(
  context: CoercionContext,
  code: DocumentDiagnosticCode,
  severity: DocumentDiagnosticSeverity,
  message: string,
  path?: string,
  identity?: { readonly taskId?: string; readonly linkId?: string },
): void {
  context.diagnostics.push({
    code,
    severity,
    message,
    ...(path === undefined ? {} : { path }),
    ...(identity === undefined ? {} : identity),
  });
}

/** 顶层字段缺失的 `info`：容忍（按 `null`/`[]` 归一）但绝不静默。 */
function noticeIfOmitted(
  context: CoercionContext,
  source: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (context.noticeOmitted && !Object.prototype.hasOwnProperty.call(source, key)) {
    report(
      context,
      'DOC_FIELD_OMITTED',
      'info',
      `缺少顶层字段 \`${key}\`：按空值归一（规范写法应显式写出）`,
      path,
    );
  }
}

/** 读取字段（无诊断；缺失与 `null` 都归为 `undefined` 语义）。 */
function readField(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/** 读字符串；缺失 → `null`，类型错 → 报码。 */
function readString(
  context: CoercionContext,
  source: Record<string, unknown>,
  key: string,
  path: string,
  code: DocumentDiagnosticCode,
  label: string,
): string | null {
  const value = readField(source, key);
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  report(context, code, 'error', `${label}必须是字符串，收到 ${JSON.stringify(value)}`, path);
  return null;
}

/** 读布尔；缺失 → `fallback`，类型错 → 报码。 */
function readBoolean(
  context: CoercionContext,
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string,
  code: DocumentDiagnosticCode,
  label: string,
): boolean {
  const value = readField(source, key);
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  report(context, code, 'error', `${label}必须是布尔值，收到 ${JSON.stringify(value)}`, path);
  return fallback;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 校验 ISO 日期文本。
 *
 * 用 G1.1 的 `parseIsoDate`（而非本地重写正则判定）是为了让
 * "文档里的合法日期"与"日历能接受的日期"**是同一个集合**——两侧不会分叉。
 */
function isIsoDateText(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

/** 读可空 ISO 日期；缺失 → `null`，非法 → 报码并归一为 `null`。 */
function readIsoDate(
  context: CoercionContext,
  source: Record<string, unknown>,
  key: string,
  path: string,
  code: DocumentDiagnosticCode,
  label: string,
): string | null {
  const value = readField(source, key);
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && isIsoDateText(value)) {
    return value;
  }
  report(
    context,
    code,
    'error',
    `${label}必须是 \`YYYY-MM-DD\` 的 ISO 日期或 \`null\`，收到 ${JSON.stringify(value)}`,
    path,
  );
  return null;
}

function isSafeIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** 递归把值收成 `JsonValue`；非 JSON 值（函数、`undefined`、非有限数、循环引用）报错并跳过。 */
function coerceJsonValue(
  context: CoercionContext,
  value: unknown,
  code: DocumentDiagnosticCode,
  label: string,
  path: string,
  seen: readonly unknown[] = [],
): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      report(context, code, 'error', `${label}含非有限数字（JSON 不可表达）`, path);
      return undefined;
    }
    return value;
  }
  if (typeof value !== 'object') {
    report(context, code, 'error', `${label}含非 JSON 值（${typeof value}）`, path);
    return undefined;
  }
  if (seen.includes(value)) {
    report(context, code, 'error', `${label}含循环引用（JSON 不可表达）`, path);
    return undefined;
  }
  const nextSeen = [...seen, value];
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    value.forEach((item, index) => {
      const coerced = coerceJsonValue(context, item, code, label, `${path}[${String(index)}]`, nextSeen);
      if (coerced !== undefined) {
        items.push(coerced);
      }
    });
    return items;
  }
  if (!isRecord(value)) {
    report(context, code, 'error', `${label}含非 JSON 对象`, path);
    return undefined;
  }
  const entries: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const coerced = coerceJsonValue(context, item, code, label, `${path}.${key}`, nextSeen);
    if (coerced !== undefined) {
      entries[key] = coerced;
    }
  }
  return entries;
}

// ---------------------------------------------------------------- 各域归一

function coerceCalendars(context: CoercionContext, raw: unknown, path: string): readonly CalendarSpec[] {
  if (!Array.isArray(raw)) {
    report(context, 'CALENDAR_MISSING', 'error', '`calendars` 必须是数组', path);
    return [];
  }
  return raw.map((entry, index) => {
    const entryPath = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      report(context, 'CALENDAR_INVALID', 'error', '日历必须是对象', entryPath);
      return {};
    }

    const rawWorkDays = readField(entry, 'workDays');
    let workDays: readonly number[] | undefined;
    if (rawWorkDays === undefined) {
      workDays = undefined;
    } else if (Array.isArray(rawWorkDays) && rawWorkDays.every((day) => Number.isInteger(day))) {
      workDays = rawWorkDays as readonly number[];
    } else {
      report(context, 'CALENDAR_INVALID', 'error', '`workDays` 必须是整数数组', `${entryPath}.workDays`);
      workDays = undefined;
    }

    const rawExceptions = readField(entry, 'exceptions');
    let exceptions: CalendarSpec['exceptions'];
    if (rawExceptions === undefined) {
      exceptions = undefined;
    } else if (!isRecord(rawExceptions)) {
      report(context, 'CALENDAR_INVALID', 'error', '`exceptions` 必须是对象', `${entryPath}.exceptions`);
      exceptions = undefined;
    } else {
      const nonWorking = coerceIsoStringArray(
        context,
        readField(rawExceptions, 'nonWorking'),
        `${entryPath}.exceptions.nonWorking`,
      );
      const working = coerceIsoStringArray(
        context,
        readField(rawExceptions, 'working'),
        `${entryPath}.exceptions.working`,
      );
      exceptions = {
        ...(nonWorking === undefined ? {} : { nonWorking }),
        ...(working === undefined ? {} : { working }),
      };
    }

    const rawId = readField(entry, 'id');
    let id: string | undefined;
    if (rawId === undefined) {
      id = undefined;
    } else if (typeof rawId === 'string') {
      id = rawId;
    } else {
      report(context, 'CALENDAR_INVALID', 'error', '`id` 必须是字符串', `${entryPath}.id`);
      id = undefined;
    }

    return {
      ...(id === undefined ? {} : { id }),
      ...(workDays === undefined ? {} : { workDays }),
      ...(exceptions === undefined ? {} : { exceptions }),
    };
  });
}

function coerceIsoStringArray(
  context: CoercionContext,
  value: unknown,
  path: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && isIsoDateText(entry))) {
    report(context, 'CALENDAR_INVALID', 'error', '例外日必须是 `YYYY-MM-DD` 的 ISO 日期数组', path);
    return undefined;
  }
  return value as readonly string[];
}

function coerceProject(
  context: CoercionContext,
  raw: unknown,
  path: string,
  calendars: readonly CalendarSpec[],
): ProjectMeta {
  if (!isRecord(raw)) {
    report(context, 'PROJECT_MISSING', 'error', '`project` 必须是对象', path);
    return emptyProjectMeta(calendars);
  }

  const name = readString(context, raw, 'name', `${path}.name`, 'PROJECT_NAME_INVALID', '`project.name`');
  const description = readString(
    context,
    raw,
    'description',
    `${path}.description`,
    'DOC_FIELD_TYPE_INVALID',
    '`project.description`',
  );

  const fallbackBase = calendars[0]?.id ?? 'project';
  const rawBase = readField(raw, 'baseCalendarId');
  let baseCalendarId: string;
  if (rawBase === undefined) {
    baseCalendarId = fallbackBase;
  } else if (typeof rawBase === 'string') {
    baseCalendarId = rawBase;
  } else {
    report(
      context,
      'PROJECT_BASE_CALENDAR_MISSING',
      'error',
      '`project.baseCalendarId` 必须是字符串',
      `${path}.baseCalendarId`,
    );
    baseCalendarId = fallbackBase;
  }
  if (baseCalendarId !== '' && !calendars.some((spec) => (spec.id ?? 'project') === baseCalendarId)) {
    report(
      context,
      'PROJECT_BASE_CALENDAR_MISSING',
      'error',
      `\`project.baseCalendarId\` = ${JSON.stringify(baseCalendarId)} 在 \`calendars[]\` 中不存在`,
      `${path}.baseCalendarId`,
    );
  }

  return {
    name: name ?? '',
    description,
    baseCalendarId,
    startDate: readIsoDate(context, raw, 'startDate', `${path}.startDate`, 'TASK_DATE_INVALID', '`project.startDate`'),
    finishDate: readIsoDate(context, raw, 'finishDate', `${path}.finishDate`, 'TASK_DATE_INVALID', '`project.finishDate`'),
  };
}

function emptyProjectMeta(calendars: readonly CalendarSpec[]): ProjectMeta {
  return {
    name: '',
    description: null,
    baseCalendarId: calendars[0]?.id ?? 'project',
    startDate: null,
    finishDate: null,
  };
}

/** 空任务（形状错到无法读时的占位，保证 id 仍可用作后续诊断的锚点）。 */
function emptyTask(id: string): DocumentTask {
  return {
    id,
    parentId: null,
    outlineNumber: '',
    name: '',
    startDate: null,
    endDate: null,
    durationDays: null,
    progress: null,
    milestone: false,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
  };
}

function coerceTasks(context: CoercionContext, raw: unknown, path: string): readonly DocumentTask[] {
  if (!Array.isArray(raw)) {
    report(context, 'TASK_MISSING', 'error', '`tasks` 必须是数组', path);
    return [];
  }
  return raw.map((entry, index) => coerceTask(context, entry, index, path));
}

function coerceTask(
  context: CoercionContext,
  raw: unknown,
  index: number,
  path: string,
): DocumentTask {
  const taskPath = `${path}[${String(index)}]`;
  if (!isRecord(raw)) {
    report(context, 'TASK_MISSING', 'error', '任务必须是对象', taskPath);
    return emptyTask(`task-${String(index)}`);
  }

  const rawId = readField(raw, 'id');
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : `task-${String(index)}`;
  if (typeof rawId !== 'string' || rawId === '') {
    report(context, 'TASK_ID_INVALID', 'error', '`id` 必须是非空字符串', `${taskPath}.id`);
  }

  const rawParent = readField(raw, 'parentId');
  let parentId: string | null;
  if (rawParent === undefined || rawParent === null) {
    parentId = null;
  } else if (typeof rawParent === 'string' && rawParent !== '') {
    parentId = rawParent;
  } else {
    parentId = null;
    report(
      context,
      'TASK_ID_INVALID',
      'error',
      '`parentId` 必须是非空字符串或 `null`',
      `${taskPath}.parentId`,
      { taskId: id },
    );
  }

  const name = readString(context, raw, 'name', `${taskPath}.name`, 'TASK_NAME_INVALID', '`name`');
  if (name === null) {
    report(context, 'TASK_NAME_INVALID', 'error', '`name` 必须是字符串', `${taskPath}.name`, { taskId: id });
  }

  const startDate = readIsoDate(
    context,
    raw,
    'startDate',
    `${taskPath}.startDate`,
    'TASK_DATE_INVALID',
    '`startDate`',
  );
  const endDate = readIsoDate(context, raw, 'endDate', `${taskPath}.endDate`, 'TASK_DATE_INVALID', '`endDate`');
  if (startDate !== null && endDate !== null && isoToDayNumber(endDate) < isoToDayNumber(startDate)) {
    report(
      context,
      'TASK_END_BEFORE_START',
      'error',
      `\`endDate\` (${endDate}) 早于 \`startDate\` (${startDate})`,
      `${taskPath}.endDate`,
      { taskId: id },
    );
  }

  const durationDays = coerceDuration(context, raw, taskPath, id);
  if (durationDays !== null && startDate === null && endDate === null) {
    report(
      context,
      'TASK_DURATION_WITHOUT_DATES',
      'warning',
      '有工期但没有任何日期：可表达（DM-05），但缺少定位点，排程时需由 G2 解释',
      `${taskPath}.durationDays`,
      { taskId: id },
    );
  }

  const progress = coerceProgress(context, raw, taskPath, id);
  const milestone = readBoolean(
    context,
    raw,
    'milestone',
    false,
    `${taskPath}.milestone`,
    'TASK_MILESTONE_INVALID',
    '`milestone`',
  );
  if (milestone && durationDays !== null && durationDays !== 0) {
    report(
      context,
      'TASK_MILESTONE_WITH_DURATION',
      'warning',
      `里程碑的 \`durationDays\` 应为 0，收到 ${String(durationDays)}`,
      `${taskPath}.durationDays`,
      { taskId: id },
    );
  }

  return {
    id,
    parentId,
    // `outlineNumber` 的缺失/非法由 `validateHierarchy` 统一报 `TREE_OUTLINE_STALE`
    // （它掌握层级上下文），这里只做类型读取，避免同一条问题报两次。
    outlineNumber:
      typeof readField(raw, 'outlineNumber') === 'string' ? (readField(raw, 'outlineNumber') as string) : '',
    name: name ?? '',
    startDate,
    endDate,
    durationDays,
    progress,
    milestone,
    collapsed: readBoolean(
      context,
      raw,
      'collapsed',
      false,
      `${taskPath}.collapsed`,
      'TASK_COLLAPSED_INVALID',
      '`collapsed`',
    ),
    notes: readString(context, raw, 'notes', `${taskPath}.notes`, 'TASK_NOTES_INVALID', '`notes`'),
    manual: readBoolean(
      context,
      raw,
      'manual',
      false,
      `${taskPath}.manual`,
      'TASK_MANUAL_INVALID',
      '`manual`',
    ),
    constraints: coerceConstraints(context, raw, taskPath, id),
  };
}

function coerceDuration(
  context: CoercionContext,
  raw: Record<string, unknown>,
  taskPath: string,
  taskId: string,
): number | null {
  const value = readField(raw, 'durationDays');
  if (value === undefined || value === null) {
    return null;
  }
  if (!isSafeIntegerWithin(value, 0, MAX_DURATION_DAYS)) {
    report(
      context,
      'TASK_DURATION_INVALID',
      'error',
      `\`durationDays\` 必须是 0..${String(MAX_DURATION_DAYS)} 的工作日整数（可为 \`null\`），收到 ${JSON.stringify(value)}`,
      `${taskPath}.durationDays`,
      { taskId },
    );
    return null;
  }
  return value;
}

function coerceProgress(
  context: CoercionContext,
  raw: Record<string, unknown>,
  taskPath: string,
  taskId: string,
): number | null {
  const value = readField(raw, 'progress');
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  report(
    context,
    'TASK_PROGRESS_INVALID',
    'error',
    `\`progress\` 必须是 [0, 1] 的分数或 \`null\`（百分数点位由 G3 在导入边界换算），收到 ${JSON.stringify(value)}`,
    `${taskPath}.progress`,
    { taskId },
  );
  return null;
}

function coerceConstraints(
  context: CoercionContext,
  raw: Record<string, unknown>,
  taskPath: string,
  taskId: string,
): readonly TaskConstraint[] {
  const value = readField(raw, 'constraints');
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    report(context, 'TASK_CONSTRAINTS_INVALID', 'error', '`constraints` 必须是数组', `${taskPath}.constraints`, {
      taskId,
    });
    return [];
  }
  const items: TaskConstraint[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${taskPath}.constraints[${String(index)}]`;
    if (!isRecord(entry)) {
      report(
        context,
        'TASK_CONSTRAINTS_INVALID',
        'error',
        '约束条目必须是对象（DM-08 的语义在 v0.5 定义，本块只校验形状）',
        entryPath,
        { taskId },
      );
      return;
    }
    const coerced = coerceJsonValue(context, entry, 'TASK_CONSTRAINTS_INVALID', '约束条目', entryPath);
    if (coerced !== undefined && isRecord(coerced)) {
      items.push(coerced as TaskConstraint);
    }
  });
  return items;
}

function coerceLinks(context: CoercionContext, raw: unknown, path: string): readonly DocumentLink[] {
  if (!Array.isArray(raw)) {
    report(context, 'LINK_MISSING', 'error', '`links` 必须是数组', path);
    return [];
  }
  return raw.map((entry, index) => coerceLink(context, entry, index, path));
}

function coerceLink(
  context: CoercionContext,
  raw: unknown,
  index: number,
  path: string,
): DocumentLink {
  const linkPath = `${path}[${String(index)}]`;
  const fallbackId = `link-${String(index)}`;
  if (!isRecord(raw)) {
    report(context, 'LINK_MISSING', 'error', '依赖边必须是对象', linkPath);
    return { id: fallbackId, from: '', to: '', type: 'FS', lagDays: 0 };
  }

  const rawId = readField(raw, 'id');
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : fallbackId;
  if (typeof rawId !== 'string' || rawId === '') {
    report(context, 'LINK_ID_INVALID', 'error', '`id` 必须是非空字符串', `${linkPath}.id`, { linkId: id });
  }

  const rawType = readField(raw, 'type');
  let type: LinkType = 'FS';
  if (rawType === undefined) {
    type = 'FS';
  } else if (typeof rawType === 'string' && LINK_TYPES.some((known) => known === rawType)) {
    type = rawType as LinkType;
  } else {
    report(
      context,
      'LINK_TYPE_INVALID',
      'error',
      `\`type\` 必须是 ${LINK_TYPES.join('/')}，收到 ${JSON.stringify(rawType)}`,
      `${linkPath}.type`,
      { linkId: id },
    );
  }

  const rawLag = readField(raw, 'lagDays');
  let lagDays = 0;
  if (rawLag === undefined) {
    lagDays = 0;
  } else if (isSafeIntegerWithin(rawLag, -MAX_LAG_DAYS, MAX_LAG_DAYS)) {
    lagDays = rawLag;
  } else {
    report(
      context,
      'LINK_LAG_INVALID',
      'error',
      `\`lagDays\` 必须是 ±${String(MAX_LAG_DAYS)} 以内的工作日整数，收到 ${JSON.stringify(rawLag)}`,
      `${linkPath}.lagDays`,
      { linkId: id },
    );
  }

  return {
    id,
    from: readString(context, raw, 'from', `${linkPath}.from`, 'LINK_DANGLING_FROM', '`from`') ?? '',
    to: readString(context, raw, 'to', `${linkPath}.to`, 'LINK_DANGLING_TO', '`to`') ?? '',
    type,
    lagDays,
  };
}

function coerceBaselines(context: CoercionContext, raw: unknown, path: string): readonly DocumentBaseline[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    report(context, 'BASELINE_MISSING', 'error', '`baselines` 必须是数组', path);
    return [];
  }
  return raw.map((entry, index) => {
    const entryPath = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      report(context, 'BASELINE_MISSING', 'error', '基线必须是对象', entryPath);
      return { id: `baseline-${String(index)}`, name: '', createdAt: '', snapshot: null };
    }

    const rawId = readField(entry, 'id');
    const id = typeof rawId === 'string' && rawId !== '' ? rawId : `baseline-${String(index)}`;
    if (typeof rawId !== 'string' || rawId === '') {
      report(context, 'BASELINE_ID_INVALID', 'error', '`id` 必须是非空字符串', `${entryPath}.id`);
    }

    const rawName = readField(entry, 'name');
    if (typeof rawName !== 'string') {
      report(context, 'BASELINE_NAME_INVALID', 'error', '`name` 必须是字符串', `${entryPath}.name`);
    }

    const rawCreatedAt = readField(entry, 'createdAt');
    const createdAt =
      typeof rawCreatedAt === 'string' && !Number.isNaN(Date.parse(rawCreatedAt)) ? rawCreatedAt : '';
    if (createdAt === '') {
      report(
        context,
        'BASELINE_CREATED_AT_INVALID',
        'error',
        '`createdAt` 必须可被 `Date.parse` 解析（ISO 时间戳）',
        `${entryPath}.createdAt`,
      );
    }

    const snapshot = coerceJsonValue(
      context,
      readField(entry, 'snapshot') ?? null,
      'BASELINE_SNAPSHOT_INVALID',
      '基线快照',
      `${entryPath}.snapshot`,
    );

    return {
      id,
      name: typeof rawName === 'string' ? rawName : '',
      createdAt,
      snapshot: snapshot ?? null,
    };
  });
}

/** 依赖边与任务集合的关系检查（悬空端点、自环、汇总端点、重复 id）。 */
function validateLinksAgainstTasks(
  context: CoercionContext,
  links: readonly DocumentLink[],
  tasks: readonly DocumentTask[],
  path: string,
): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const hasChildren = new Set<string>();
  for (const task of tasks) {
    if (task.parentId !== null) {
      hasChildren.add(task.parentId);
    }
  }

  const seenIds = new Set<string>();
  links.forEach((link, index) => {
    const linkPath = `${path}[${String(index)}]`;
    if (seenIds.has(link.id)) {
      report(context, 'LINK_DUPLICATE_ID', 'error', `依赖边 id 重复：${link.id}`, `${linkPath}.id`, {
        linkId: link.id,
      });
    }
    seenIds.add(link.id);

    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (from === undefined) {
      report(
        context,
        'LINK_DANGLING_FROM',
        'error',
        `\`from\` 指向不存在的任务：${JSON.stringify(link.from)}`,
        `${linkPath}.from`,
        { linkId: link.id },
      );
    }
    if (to === undefined) {
      report(
        context,
        'LINK_DANGLING_TO',
        'error',
        `\`to\` 指向不存在的任务：${JSON.stringify(link.to)}`,
        `${linkPath}.to`,
        { linkId: link.id },
      );
    }
    if (link.from !== '' && link.from === link.to) {
      report(context, 'LINK_SELF_REFERENCE', 'error', '依赖边不能自环', linkPath, { linkId: link.id });
    }
    if ((from !== undefined && hasChildren.has(link.from)) || (to !== undefined && hasChildren.has(link.to))) {
      report(
        context,
        'LINK_SUMMARY_ENDPOINT',
        'warning',
        '依赖边的端点是汇总任务（有子节点）：只有叶子任务参与排程，该边可能不产生效果（G2 语义）',
        linkPath,
        { linkId: link.id },
      );
    }
  });
}

function validateBaselineIds(
  context: CoercionContext,
  baselines: readonly DocumentBaseline[],
  path: string,
): void {
  const seen = new Set<string>();
  baselines.forEach((baseline, index) => {
    if (seen.has(baseline.id)) {
      report(
        context,
        'BASELINE_DUPLICATE_ID',
        'error',
        `基线 id 重复：${baseline.id}`,
        `${path}[${String(index)}].id`,
      );
    }
    seen.add(baseline.id);
  });
}

/**
 * 用**引擎自己的日历构造器**验证日历规格（G1.1 的 `Calendar`）。
 *
 * 关键点：校验不重写 G1.1 的规则，而是直接调用它——因此
 * "文档里合法的日历"与"引擎构造得出的日历"不可能分叉。
 * 这里只借它的**规格校验**（`workDays` 范围、例外日格式），不做容量规划。
 */
function validateCalendarSpecs(
  context: CoercionContext,
  calendars: readonly CalendarSpec[],
  path: string,
): void {
  calendars.forEach((spec, index) => {
    try {
      new Calendar(spec, { spanDays: 7 });
    } catch (error) {
      const message = error instanceof RangeError ? error.message : String(error);
      report(context, 'CALENDAR_INVALID', 'error', `日历规格非法：${message}`, `${path}[${String(index)}]`);
    }
  });
}

// ---------------------------------------------------------------- 版本

/** 版本读数结果：`ok` 为假时诊断已写入 `context`。 */
interface VersionRead {
  readonly ok: boolean;
  readonly version: number;
}

function readVersion(context: CoercionContext, source: Record<string, unknown>, path: string): VersionRead {
  const raw = readField(source, 'version');
  if (raw === undefined) {
    report(context, 'DOC_VERSION_MISSING', 'error', '文档缺少 `version` 字段', path);
    return { ok: false, version: CURRENT_DOCUMENT_VERSION };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    report(
      context,
      'DOC_VERSION_UNKNOWN',
      'error',
      `\`version\` 必须是整数，收到 ${JSON.stringify(raw)}`,
      path,
    );
    return { ok: false, version: CURRENT_DOCUMENT_VERSION };
  }
  if (raw < MIN_SUPPORTED_DOCUMENT_VERSION || raw > CURRENT_DOCUMENT_VERSION) {
    report(
      context,
      'DOC_VERSION_UNKNOWN',
      'error',
      `未知文档版本 ${String(raw)}：支持区间为 ${String(MIN_SUPPORTED_DOCUMENT_VERSION)}..${String(CURRENT_DOCUMENT_VERSION)}` +
        '（更高版本请升级本工具；更低版本无法迁移）',
      path,
    );
    return { ok: false, version: raw };
  }
  return { ok: true, version: raw };
}

// ---------------------------------------------------------------- 校验入口

function emptyDocument(): ProjectDocument {
  return {
    version: CURRENT_DOCUMENT_VERSION,
    project: emptyProjectMeta([]),
    calendars: [],
    tasks: [],
    links: [],
    baselines: [],
  };
}

interface StructureResult {
  readonly document: ProjectDocument;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

function coerceDocumentStructure(input: unknown, noticeOmitted: boolean): StructureResult {
  const context: CoercionContext = { diagnostics: [], noticeOmitted };
  if (!isRecord(input)) {
    report(context, 'DOC_ROOT_NOT_OBJECT', 'error', '文档根必须是 JSON 对象', '');
    return { document: emptyDocument(), diagnostics: context.diagnostics };
  }

  const versionRead = readVersion(context, input, 'version');
  if (!versionRead.ok) {
    // 版本不可信时后续字段的语义都不可知：只报版本问题，不产生级联噪声。
    return { document: emptyDocument(), diagnostics: context.diagnostics };
  }

  for (const key of ['project', 'calendars', 'tasks', 'links', 'baselines'] as const) {
    noticeIfOmitted(context, input, key, key);
  }

  const calendars = coerceCalendars(context, readField(input, 'calendars'), 'calendars');
  validateCalendarSpecs(context, calendars, 'calendars');
  const project = coerceProject(context, readField(input, 'project'), 'project', calendars);
  const tasks = coerceTasks(context, readField(input, 'tasks'), 'tasks');
  const links = coerceLinks(context, readField(input, 'links'), 'links');
  const baselines = coerceBaselines(context, readField(input, 'baselines'), 'baselines');

  validateBaselineIds(context, baselines, 'baselines');
  validateLinksAgainstTasks(context, links, tasks, 'links');
  validateTasksShape(context.diagnostics, tasks);
  validateHierarchy(context.diagnostics, tasks);

  return {
    document: { version: versionRead.version, project, calendars, tasks, links, baselines },
    diagnostics: context.diagnostics,
  };
}

/**
 * 校验任意输入并返回**全部诊断**（不抛错）。
 *
 * 语义：把 `input` 当作"磁盘上的文档"来读——顶层字段缺键按空值归一，
 * 并给出 `DOC_FIELD_OMITTED`（`info`）诊断。因此它同时是
 * "反序列化的形状检查"与"用户手写 JSON 的验收门"，也是 G3 导入向导的复用点。
 */
export function validateDocument(input: unknown): readonly DocumentDiagnostic[] {
  return coerceDocumentStructure(input, true).diagnostics;
}

/** 诊断集合中是否有 `error`（`parseDocument` 的判定条件）。 */
export function hasDocumentErrors(diagnostics: readonly DocumentDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

// ---------------------------------------------------------------- 迁移

/** 读取数组字段（迁移用；非数组一律当空数组，由后续校验报错）。 */
function migrationArray(source: Record<string, unknown>, key: string): readonly unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function firstCalendarId(calendars: readonly unknown[]): string {
  const first = calendars[0];
  if (isRecord(first) && typeof first['id'] === 'string' && first['id'] !== '') {
    return first['id'];
  }
  return 'project';
}

/**
 * v1 → v2。
 *
 * v1 是"原文优先期"的历史形状（**从未发布**，见 ADR 0002）：
 * - `links[].lag`（而非 `lagDays`）；
 * - 任务没有 `manual` / `constraints`；
 * - 没有 `project.baseCalendarId`。
 */
function migrateV1ToV2(input: Record<string, unknown>): Record<string, unknown> {
  const calendars = migrationArray(input, 'calendars');
  const rawProject = isRecord(input['project']) ? input['project'] : {};
  const project = {
    ...rawProject,
    baseCalendarId: rawProject['baseCalendarId'] ?? firstCalendarId(calendars),
  };

  const links = migrationArray(input, 'links').map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const { lag, ...rest } = entry;
    return { ...rest, lagDays: rest['lagDays'] ?? lag ?? 0 };
  });

  const tasks = migrationArray(input, 'tasks').map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    return { manual: false, ...entry, constraints: entry['constraints'] ?? [] };
  });

  return { ...input, version: 2, project, tasks, links };
}

/**
 * v2 → v3。
 *
 * 差别只在 WBS 与折叠状态：
 * - 任务补 `collapsed`；
 * - 任务补 `outlineNumber`（**缺失时按层级 + 文档序计算填入**；已有值保留，
 *   由随后的校验报 `TREE_OUTLINE_STALE` 而不是在这里静默改写——"谁是真相源"必须唯一）；
 * - `baselines` 缺失补 `[]`。
 */
function migrateV2ToV3(input: Record<string, unknown>): Record<string, unknown> {
  const rawTasks = migrationArray(input, 'tasks');
  const computed = computeOutlineNumbersForMigration(rawTasks);

  const tasks = rawTasks.map((entry, index) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const fallback = computed[index] ?? String(index + 1);
    return { collapsed: false, ...entry, outlineNumber: entry['outlineNumber'] ?? fallback };
  });

  return {
    ...input,
    version: 3,
    tasks,
    baselines: migrationArray(input, 'baselines'),
  };
}

/** v2→v3 用的最小编号计算（不排序、不做环检测：脏数据由随后的校验负责报错）。 */
function computeOutlineNumbersForMigration(tasks: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  const parentOf = new Map<string, string | null>();
  tasks.forEach((entry, index) => {
    const id =
      isRecord(entry) && typeof entry['id'] === 'string' && entry['id'] !== ''
        ? entry['id']
        : `task-${String(index)}`;
    ids.push(id);
    const parent =
      isRecord(entry) && typeof entry['parentId'] === 'string' && entry['parentId'] !== ''
        ? entry['parentId']
        : null;
    parentOf.set(id, parent);
  });

  const childrenOf = new Map<string | null, string[]>();
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    const bucket = childrenOf.get(parent);
    if (bucket === undefined) {
      childrenOf.set(parent, [id]);
    } else {
      bucket.push(id);
    }
  }

  const numbers = new Map<string, string>();
  const walk = (parent: string | null, prefix: string): void => {
    for (const [index, childId] of (childrenOf.get(parent) ?? []).entries()) {
      const number = prefix === '' ? String(index + 1) : `${prefix}${OUTLINE_SEPARATOR}${String(index + 1)}`;
      numbers.set(childId, number);
      walk(childId, number);
    }
  };
  walk(null, '');

  return ids.map((id, index) => numbers.get(id) ?? String(index + 1));
}

/** 版本 → 迁移函数（**逐跳**，故新增版本只需追加一条）。 */
const MIGRATIONS: ReadonlyMap<number, (input: Record<string, unknown>) => Record<string, unknown>> =
  new Map([
    [1, migrateV1ToV2],
    [2, migrateV2ToV3],
  ]);

/**
 * 版本相关失败的载体（`migrateDocument` / `parseDocument` 抛出）。
 *
 * 之所以是类而不是裸 `Error`：调用方需要拿到**结构化诊断**（G3 的诊断报告要逐条展示），
 * 而不是去解析错误消息文本。
 */
export class DocumentVersionError extends Error {
  readonly diagnostics: readonly DocumentDiagnostic[];

  constructor(diagnostics: readonly DocumentDiagnostic[]) {
    super(diagnostics[0]?.message ?? '文档版本不受支持');
    this.name = 'DocumentVersionError';
    this.diagnostics = diagnostics;
  }
}

/**
 * 把任意版本的文档修到**当前版本**（只做结构改写，不做字段合法性校验）。
 *
 * - 未知版本（`0`、`4`、非整数、非数字）→ 抛 `DocumentVersionError`；
 * - 跳数上界 = `CURRENT - MIN + 1`：注册表若被写成环，会以 `MIGRATION_CYCLE` 抛错而不是死循环；
 * - 每一步都要求版本**严格递增**，否则同样按 `MIGRATION_CYCLE` 拒绝。
 */
export function migrateDocument(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const context: CoercionContext = { diagnostics: [], noticeOmitted: false };
  const versionRead = readVersion(context, input, 'version');
  if (!versionRead.ok) {
    throw new DocumentVersionError(context.diagnostics);
  }

  let current: Record<string, unknown> = input;
  let version = versionRead.version;
  const maxHops = CURRENT_DOCUMENT_VERSION - MIN_SUPPORTED_DOCUMENT_VERSION + 1;
  let hops = 0;

  while (version !== CURRENT_DOCUMENT_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (migration === undefined) {
      throw new DocumentVersionError([
        {
          code: 'DOC_VERSION_UNKNOWN',
          severity: 'error',
          message: `没有从版本 ${String(version)} 出发的迁移路径`,
          path: 'version',
        },
      ]);
    }
    if (hops >= maxHops) {
      throw new DocumentVersionError([
        {
          code: 'MIGRATION_CYCLE',
          severity: 'error',
          message: `迁移未在 ${String(maxHops)} 跳内到达版本 ${String(CURRENT_DOCUMENT_VERSION)}：迁移注册表疑似成环`,
          path: 'version',
        },
      ]);
    }

    current = migration(current);
    hops += 1;

    const next = current['version'];
    if (typeof next !== 'number' || !Number.isInteger(next) || next <= version) {
      throw new DocumentVersionError([
        {
          code: 'MIGRATION_CYCLE',
          severity: 'error',
          message: `迁移未推进版本（${String(version)} → ${JSON.stringify(next)}）`,
          path: 'version',
        },
      ]);
    }
    version = next;
  }

  return current;
}

// ---------------------------------------------------------------- 解析

/** 文档校验失败的载荷：携带**全部**诊断（含 `warning`/`info`），便于调用方完整报告。 */
export class DocumentError extends Error {
  readonly diagnostics: readonly DocumentDiagnostic[];

  constructor(diagnostics: readonly DocumentDiagnostic[]) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    super(errors[0]?.message ?? '文档校验失败');
    this.name = 'DocumentError';
    this.diagnostics = diagnostics;
  }
}

/**
 * 解析磁盘/网络上的文档文本。
 *
 * 顺序：`JSON.parse` → `migrateDocument` → 严格校验。任一 `error` 级诊断即抛
 * `DocumentError`（携带全部诊断），因此调用方永远拿不到"半合法"的文档。
 *
 * @throws DocumentVersionError 版本未知、迁移路径缺失或迁移表成环
 * @throws DocumentError JSON 语法错误或有 `error` 级诊断
 */
export function parseDocument(text: string): ProjectDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentError([
      { code: 'DOC_JSON_SYNTAX', severity: 'error', message: `JSON 语法错误：${detail}` },
    ]);
  }

  const migrated = migrateDocument(raw);
  const { document, diagnostics } = coerceDocumentStructure(migrated, true);
  if (hasDocumentErrors(diagnostics)) {
    throw new DocumentError(diagnostics);
  }
  return document;
}

/** 新建空文档（新建文档的起点）。 */
export function createEmptyDocument(name = '未命名项目'): ProjectDocument {
  return {
    version: CURRENT_DOCUMENT_VERSION,
    project: {
      name,
      description: null,
      baseCalendarId: 'project',
      startDate: null,
      finishDate: null,
    },
    calendars: [{ id: 'project' }],
    tasks: [],
    links: [],
    baselines: [],
  };
}

/**
 * 修复动作：重算全部 `outlineNumber`，使 `TREE_OUTLINE_STALE` 消失。
 *
 * 与 `validateHierarchy` 的分工是**只读 / 修复**：
 * 校验只报告"存值与层级不符"，从不改写文档；保存前由调用方显式调用本函数。
 * 这样"谁是真相源"始终唯一——层级与文档序是真相源，编号是它的像。
 */
export function reindexDocument(document: ProjectDocument): ProjectDocument {
  return { ...document, tasks: reindexTasks(document.tasks) };
}

/** ISO 日期文本 → 日序号（供调用方做轻量比较，不引入 `Calendar` 的容量概念）。 */
export function isoDateToDayNumber(iso: string): number {
  return isoToDayNumber(iso);
}

/** 日序号 → ISO 日期文本（与 `isoDateToDayNumber` 互逆）。 */
export function dayNumberToIsoDate(day: number): string {
  return dayNumberToIso(day);
}
