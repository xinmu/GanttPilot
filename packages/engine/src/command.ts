/**
 * 命令层：文档的**唯一变更通道**（G1.3 的公共面）。
 *
 * ## 契约（IX-03 的载体，冻结于 ADR 0003）
 *
 * - **一次手势 = 一个 Command**（多条原始命令的复合手势用 `session.ts` 的事务，仍是一个撤销单元）；
 * - 命令是**可序列化的纯数据**（不是闭包）：可重放、可留痕、可解析校验；
 * - `applyCommand(document, command)` 是**纯函数**：不修改入参，返回新文档 + before 镜像日志；
 * - 命令层保证**其产出必然通过 G1.2 的 schema 校验**（`validateDocument` 零 `error`）——
 *   它不重写任何文档规则，而是直接复用权威校验（同 ADR 0002 §8 的手法：
 *   "文档里合法的"与"引擎产出的"不可能分叉）。
 *
 * ## 三种结果语义（沿用仓库既有惯例）
 *
 * | 情形 | 返回 | 类比 |
 * |---|---|---|
 * | 目标/载荷/结果不合法 | `{ok:false, code, message}`（**不抛错**） | `WbsResult` |
 * | 恒等变更（patch 无实际变化、`WBS_SAME_POSITION`） | `{ok:true, changed:false}`（**不压撤销栈**） | `SCHEMA.md` §3.2 |
 * | 真的变了 | `{ok:true, changed:true, document, journal}` | — |
 *
 * 异常只留给**程序员错误**（日志与文档自相矛盾等，见 `journal.ts`）。
 *
 * ## 确定性与 id 归属
 *
 * 命令层内**无时钟、无随机、无全局自增**：`task.insert`/`link.insert` 的 id 由载荷显式给出
 * （`suggestTaskId`/`suggestLinkId` 给出确定性建议值），因此"同一文档 + 同一命令序列 → 深比较相等"。
 *
 * 本文件零 DOM、零框架依赖。
 */

import { isIsoDateText } from './date.js';
import {
  applyDocumentJournal,
  createBulkJournal,
  diffDocument,
  findNonJsonValue,
  isJournalEmpty,
  jsonDeepEqual,
  type DocumentJournal,
} from './journal.js';
import {
  CURRENT_DOCUMENT_VERSION,
  LINK_TYPES,
  MAX_DURATION_DAYS,
  MAX_LAG_DAYS,
  validateDocument,
  type DocumentDiagnostic,
  type DocumentLink,
  type DocumentTask,
  type LinkType,
  type ProjectDocument,
  type TaskConstraint,
} from './schema.js';
import {
  indentTask,
  isRecord,
  moveTask,
  outdentTask,
  reindexTasks,
  type TaskHierarchyInput,
  type WbsFailureCode,
  type WbsMoveTarget,
  type WbsResult,
} from './wbs.js';

// ---------------------------------------------------------------- 命令类型

/** 任务的可改字段（`id`/`parentId`/`outlineNumber` 不在此列——那是层级语义，归 `task.*` 调级命令）。 */
export interface TaskFieldPatch {
  readonly name?: string;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly durationDays?: number | null;
  readonly progress?: number | null;
  readonly milestone?: boolean;
  readonly collapsed?: boolean;
  readonly notes?: string | null;
  readonly manual?: boolean;
  readonly constraints?: readonly TaskConstraint[];
}

/** 项目元数据的可改字段。 */
export interface ProjectMetaPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly baseCalendarId?: string;
  readonly startDate?: string | null;
  readonly finishDate?: string | null;
}

/** 依赖边的可改字段。 */
export interface LinkFieldPatch {
  readonly from?: string;
  readonly to?: string;
  readonly type?: LinkType;
  readonly lagDays?: number;
}

/** 整份文档替换（导入 / 新建 / 迁移后的落库统一走这条）。 */
export interface DocumentReplaceCommand {
  readonly kind: 'document.replace';
  readonly document: ProjectDocument;
}

/** 项目元数据更新。 */
export interface ProjectUpdateCommand {
  readonly kind: 'project.update';
  readonly patch: ProjectMetaPatch;
}

/**
 * 插入任务。
 *
 * `outlineNumber` 是**派生值**（ADR 0002 ④），命令落地前按层级重算、载荷取值被忽略；
 * `parentId` 是真相源，载荷里的 `parentId` 必须与命令一致，否则拒绝（不做静默改写）。
 * 未给落点（`index`/`afterTaskId` 都缺省）时按 `moveTask` 的缺省落点（目标父节点下第一个位置）。
 */
export interface TaskInsertCommand {
  readonly kind: 'task.insert';
  readonly task: DocumentTask;
  readonly parentId: string | null;
  readonly afterTaskId?: string;
  readonly index?: number;
}

/** 任务字段更新（一次手势可跨多个字段）。 */
export interface TaskUpdateCommand {
  readonly kind: 'task.update';
  readonly id: string;
  readonly patch: TaskFieldPatch;
}

/** 删除任务**及其整棵子树**，并级联删除涉及被删任务的全部依赖边。 */
export interface TaskRemoveCommand {
  readonly kind: 'task.remove';
  readonly id: string;
}

/** Tab 降级（成为前一个兄弟的最后一个子节点）。 */
export interface TaskIndentCommand {
  readonly kind: 'task.indent';
  readonly id: string;
}

/** Shift+Tab 升级。 */
export interface TaskOutdentCommand {
  readonly kind: 'task.outdent';
  readonly id: string;
}

/** 跨层级移动（拖拽落地）。 */
export interface TaskMoveCommand {
  readonly kind: 'task.move';
  readonly id: string;
  readonly target: WbsMoveTarget;
}

/** 新增依赖边（插入到 `links[]` 末尾——依赖边的数组顺序无文档语义）。 */
export interface LinkInsertCommand {
  readonly kind: 'link.insert';
  readonly link: DocumentLink;
}

/** 更新依赖边。 */
export interface LinkUpdateCommand {
  readonly kind: 'link.update';
  readonly id: string;
  readonly patch: LinkFieldPatch;
}

/** 删除依赖边。 */
export interface LinkRemoveCommand {
  readonly kind: 'link.remove';
  readonly id: string;
}

/** 全部命令的判别联合（`kind` 为判别式）。 */
export type DocumentCommand =
  | DocumentReplaceCommand
  | ProjectUpdateCommand
  | TaskInsertCommand
  | TaskUpdateCommand
  | TaskRemoveCommand
  | TaskIndentCommand
  | TaskOutdentCommand
  | TaskMoveCommand
  | LinkInsertCommand
  | LinkUpdateCommand
  | LinkRemoveCommand;

/** 命令类型标识。 */
export type DocumentCommandKind = DocumentCommand['kind'];

/** 全部合法命令类型（顺序稳定，供 UI 遍历与完备性测试）。 */
export const COMMAND_KINDS: readonly DocumentCommandKind[] = [
  'document.replace',
  'project.update',
  'task.insert',
  'task.update',
  'task.remove',
  'task.indent',
  'task.outdent',
  'task.move',
  'link.insert',
  'link.update',
  'link.remove',
];

// ---------------------------------------------------------------- 失败码与结果

/**
 * 命令层失败码（稳定契约，G5/G6 据码出文案）。
 *
 * 末项是 `WbsFailureCode` 里**透传**的那部分。三个层级失败码被**归一**，故从联合里排除：
 * `WBS_TASK_NOT_FOUND → CMD_TASK_NOT_FOUND`、`WBS_TARGET_NOT_FOUND → CMD_PARENT_NOT_FOUND`、
 * `WBS_SAME_POSITION → {ok:true, changed:false}`（无操作是正常交互，不是失败）。
 */
export type CommandFailureCode =
  | 'CMD_VERSION_MISMATCH'
  | 'CMD_INVALID_PAYLOAD'
  | 'CMD_UNKNOWN_KIND'
  | 'CMD_RESULT_INVALID'
  | 'CMD_TASK_NOT_FOUND'
  | 'CMD_TASK_ID_DUPLICATE'
  | 'CMD_PARENT_NOT_FOUND'
  | 'CMD_ANCHOR_TASK_NOT_FOUND'
  | 'CMD_LINK_NOT_FOUND'
  | 'CMD_LINK_ID_DUPLICATE'
  | 'CMD_LINK_ENDPOINT_NOT_FOUND'
  | 'CMD_LINK_SELF_REFERENCE'
  | 'CMD_CALENDAR_NOT_FOUND'
  | Exclude<
      WbsFailureCode,
      'WBS_TASK_NOT_FOUND' | 'WBS_TARGET_NOT_FOUND' | 'WBS_SAME_POSITION'
    >;

/** 命令失败载荷。`diagnostics` 只在 `CMD_RESULT_INVALID` 时出现（把 schema 的判定原样递给调用方）。 */
export interface CommandFailure {
  readonly ok: false;
  readonly code: CommandFailureCode;
  readonly message: string;
  readonly diagnostics?: readonly DocumentDiagnostic[];
}

/** 命令执行结果（判别联合，便于调用方穷尽处理）。 */
export type CommandResult =
  | {
      readonly ok: true;
      readonly changed: true;
      readonly document: ProjectDocument;
      readonly journal: DocumentJournal;
    }
  | { readonly ok: true; readonly changed: false; readonly document: ProjectDocument }
  | CommandFailure;

/** 命令序列重放结果。失败时 `document` 是**已成功应用的前缀状态**（便于调用方判断进度）。 */
export type ReplayResult =
  | {
      readonly ok: true;
      readonly document: ProjectDocument;
      readonly applied: number;
      readonly changed: number;
    }
  | (CommandFailure & { readonly index: number; readonly document: ProjectDocument });

/** 命令文本解析结果。 */
export type CommandParseResult =
  | { readonly ok: true; readonly command: DocumentCommand }
  | { readonly ok: false; readonly code: CommandFailureCode; readonly message: string };

function failureOf(code: CommandFailureCode, message: string): CommandFailure {
  return { ok: false, code, message };
}

function failWith(
  code: CommandFailureCode,
  message: string,
  diagnostics: readonly DocumentDiagnostic[],
): CommandFailure {
  return { ok: false, code, message, diagnostics };
}

// ---------------------------------------------------------------- 载荷校验基元

function checkNonEmptyString(problems: string[], value: unknown, label: string): value is string {
  if (typeof value === 'string' && value !== '') {
    return true;
  }
  problems.push(`${label} 必须是非空字符串`);
  return false;
}

function checkString(problems: string[], value: unknown, label: string): value is string {
  if (typeof value === 'string') {
    return true;
  }
  problems.push(`${label} 必须是字符串`);
  return false;
}

function checkStringOrNull(problems: string[], value: unknown, label: string): value is string | null {
  if (value === null || typeof value === 'string') {
    return true;
  }
  problems.push(`${label} 必须是字符串或 \`null\``);
  return false;
}

function checkBoolean(problems: string[], value: unknown, label: string): value is boolean {
  if (typeof value === 'boolean') {
    return true;
  }
  problems.push(`${label} 必须是布尔值`);
  return false;
}

function checkIsoDateOrNull(problems: string[], value: unknown, label: string): value is string | null {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' && isIsoDateText(value)) {
    return true;
  }
  problems.push(`${label} 必须是 \`YYYY-MM-DD\` 的 ISO 日期或 \`null\``);
  return false;
}

function checkIntegerInRange(
  problems: string[],
  value: unknown,
  label: string,
  min: number,
  max: number,
): value is number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) {
    return true;
  }
  problems.push(`${label} 必须是 ${String(min)}..${String(max)} 的整数`);
  return false;
}

function checkProgressOrNull(problems: string[], value: unknown, label: string): value is number | null {
  if (value === null) {
    return true;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return true;
  }
  problems.push(`${label} 必须是 [0, 1] 的分数或 \`null\``);
  return false;
}

function checkLinkType(problems: string[], value: unknown, label: string): value is LinkType {
  if (typeof value === 'string' && LINK_TYPES.some((known) => known === value)) {
    return true;
  }
  problems.push(`${label} 必须是 ${LINK_TYPES.join('/')}`);
  return false;
}

function checkJsonObjects(
  problems: string[],
  value: unknown,
  label: string,
): value is readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    problems.push(`${label} 必须是 JSON 对象数组`);
    return false;
  }
  for (const [index, entry] of value.entries()) {
    const path = `${label}[${String(index)}]`;
    const problem = findNonJsonValue(entry, path);
    if (problem !== null) {
      problems.push(problem);
      return false;
    }
    if (!isRecord(entry)) {
      problems.push(`${path} 必须是对象`);
      return false;
    }
  }
  return true;
}

function checkAllowedKeys(
  problems: string[],
  patch: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      problems.push(`${label} 含不允许的字段 \`${key}\`（允许：${allowed.join(' / ')}）`);
    }
  }
}

function report(problems: readonly string[]): string {
  const head = problems.slice(0, 3).join('；');
  const tail = problems.length > 3 ? `（共 ${String(problems.length)} 处问题）` : '';
  return `命令载荷不合法：${head}${tail}`;
}

/** 字段是否显式给出（`undefined` 与"没写"同义——patch 的稀疏语义）。 */
function has(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;
}

function requireStringField(
  problems: string[],
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (!checkNonEmptyString(problems, value, `\`${key}\``)) {
    return '';
  }
  return value as string;
}

// ---------------------------------------------------------------- 载荷规范化

const TASK_PATCH_KEYS = [
  'name',
  'startDate',
  'endDate',
  'durationDays',
  'progress',
  'milestone',
  'collapsed',
  'notes',
  'manual',
  'constraints',
] as const;

const PROJECT_PATCH_KEYS = [
  'name',
  'description',
  'baseCalendarId',
  'startDate',
  'finishDate',
] as const;

const LINK_PATCH_KEYS = ['from', 'to', 'type', 'lagDays'] as const;

function normalizeTaskPatch(problems: string[], raw: unknown): TaskFieldPatch {
  if (!isRecord(raw)) {
    problems.push('`patch` 必须是对象');
    return {};
  }
  checkAllowedKeys(problems, raw, TASK_PATCH_KEYS, '`patch`');
  const patch: {
    name?: string;
    startDate?: string | null;
    endDate?: string | null;
    durationDays?: number | null;
    progress?: number | null;
    milestone?: boolean;
    collapsed?: boolean;
    notes?: string | null;
    manual?: boolean;
    constraints?: readonly TaskConstraint[];
  } = {};
  if (has(raw, 'name') && checkString(problems, raw['name'], '`patch.name`')) {
    patch.name = raw['name'] as string;
  }
  if (has(raw, 'startDate') && checkIsoDateOrNull(problems, raw['startDate'], '`patch.startDate`')) {
    patch.startDate = raw['startDate'] as string | null;
  }
  if (has(raw, 'endDate') && checkIsoDateOrNull(problems, raw['endDate'], '`patch.endDate`')) {
    patch.endDate = raw['endDate'] as string | null;
  }
  if (
    has(raw, 'durationDays') &&
    checkIntegerInRange(problems, raw['durationDays'], '`patch.durationDays`', 0, MAX_DURATION_DAYS)
  ) {
    patch.durationDays = raw['durationDays'] as number;
  }
  if (has(raw, 'progress') && checkProgressOrNull(problems, raw['progress'], '`patch.progress`')) {
    patch.progress = raw['progress'] as number | null;
  }
  if (has(raw, 'milestone') && checkBoolean(problems, raw['milestone'], '`patch.milestone`')) {
    patch.milestone = raw['milestone'] as boolean;
  }
  if (has(raw, 'collapsed') && checkBoolean(problems, raw['collapsed'], '`patch.collapsed`')) {
    patch.collapsed = raw['collapsed'] as boolean;
  }
  if (has(raw, 'notes') && checkStringOrNull(problems, raw['notes'], '`patch.notes`')) {
    patch.notes = raw['notes'] as string | null;
  }
  if (has(raw, 'manual') && checkBoolean(problems, raw['manual'], '`patch.manual`')) {
    patch.manual = raw['manual'] as boolean;
  }
  if (has(raw, 'constraints') && checkJsonObjects(problems, raw['constraints'], '`patch.constraints`')) {
    patch.constraints = raw['constraints'] as readonly TaskConstraint[];
  }
  return patch;
}

function normalizeProjectPatch(problems: string[], raw: unknown): ProjectMetaPatch {
  if (!isRecord(raw)) {
    problems.push('`patch` 必须是对象');
    return {};
  }
  checkAllowedKeys(problems, raw, PROJECT_PATCH_KEYS, '`patch`');
  const patch: {
    name?: string;
    description?: string | null;
    baseCalendarId?: string;
    startDate?: string | null;
    finishDate?: string | null;
  } = {};
  if (has(raw, 'name') && checkString(problems, raw['name'], '`patch.name`')) {
    patch.name = raw['name'] as string;
  }
  if (
    has(raw, 'description') &&
    checkStringOrNull(problems, raw['description'], '`patch.description`')
  ) {
    patch.description = raw['description'] as string | null;
  }
  if (has(raw, 'baseCalendarId') && checkString(problems, raw['baseCalendarId'], '`patch.baseCalendarId`')) {
    patch.baseCalendarId = raw['baseCalendarId'] as string;
  }
  if (has(raw, 'startDate') && checkIsoDateOrNull(problems, raw['startDate'], '`patch.startDate`')) {
    patch.startDate = raw['startDate'] as string | null;
  }
  if (has(raw, 'finishDate') && checkIsoDateOrNull(problems, raw['finishDate'], '`patch.finishDate`')) {
    patch.finishDate = raw['finishDate'] as string | null;
  }
  return patch;
}

function normalizeLinkPatch(problems: string[], raw: unknown): LinkFieldPatch {
  if (!isRecord(raw)) {
    problems.push('`patch` 必须是对象');
    return {};
  }
  checkAllowedKeys(problems, raw, LINK_PATCH_KEYS, '`patch`');
  const patch: { from?: string; to?: string; type?: LinkType; lagDays?: number } = {};
  if (has(raw, 'from') && checkNonEmptyString(problems, raw['from'], '`patch.from`')) {
    patch.from = raw['from'] as string;
  }
  if (has(raw, 'to') && checkNonEmptyString(problems, raw['to'], '`patch.to`')) {
    patch.to = raw['to'] as string;
  }
  if (has(raw, 'type') && checkLinkType(problems, raw['type'], '`patch.type`')) {
    patch.type = raw['type'] as LinkType;
  }
  if (
    has(raw, 'lagDays') &&
    checkIntegerInRange(problems, raw['lagDays'], '`patch.lagDays`', -MAX_LAG_DAYS, MAX_LAG_DAYS)
  ) {
    patch.lagDays = raw['lagDays'] as number;
  }
  return patch;
}

/** 完整任务载荷（`task.insert` 用）。**不做文件级容错**：字段齐全才收。 */
function normalizeTaskPayload(problems: string[], raw: unknown): DocumentTask | null {
  if (!isRecord(raw)) {
    problems.push('`task` 必须是对象');
    return null;
  }
  const at = problems.length;
  const id = raw['id'];
  checkNonEmptyString(problems, id, '`task.id`');
  const parentId = raw['parentId'];
  if (parentId !== null) {
    checkNonEmptyString(problems, parentId, '`task.parentId`（`null` = 顶层）');
  }
  const outlineNumber = raw['outlineNumber'];
  checkString(problems, outlineNumber, '`task.outlineNumber`（派生值，插入时按层级重算）');
  const name = raw['name'];
  checkString(problems, name, '`task.name`');
  const startDate = raw['startDate'];
  checkIsoDateOrNull(problems, startDate, '`task.startDate`');
  const endDate = raw['endDate'];
  checkIsoDateOrNull(problems, endDate, '`task.endDate`');
  const durationDays = raw['durationDays'];
  if (durationDays !== null) {
    checkIntegerInRange(problems, durationDays, '`task.durationDays`', 0, MAX_DURATION_DAYS);
  }
  const progress = raw['progress'];
  checkProgressOrNull(problems, progress, '`task.progress`');
  const milestone = raw['milestone'];
  checkBoolean(problems, milestone, '`task.milestone`');
  const collapsed = raw['collapsed'];
  checkBoolean(problems, collapsed, '`task.collapsed`');
  const notes = raw['notes'];
  checkStringOrNull(problems, notes, '`task.notes`');
  const manual = raw['manual'];
  checkBoolean(problems, manual, '`task.manual`');
  const constraints = raw['constraints'];
  checkJsonObjects(problems, constraints, '`task.constraints`');

  if (problems.length > at) {
    return null;
  }
  return {
    id: id as string,
    parentId: parentId as string | null,
    outlineNumber: outlineNumber as string,
    name: name as string,
    startDate: startDate as string | null,
    endDate: endDate as string | null,
    durationDays: durationDays as number | null,
    progress: progress as number | null,
    milestone: milestone as boolean,
    collapsed: collapsed as boolean,
    notes: notes as string | null,
    manual: manual as boolean,
    constraints: constraints as readonly TaskConstraint[],
  };
}

/** 完整依赖边载荷（`link.insert` 用）。 */
function normalizeLinkPayload(problems: string[], raw: unknown): DocumentLink | null {
  if (!isRecord(raw)) {
    problems.push('`link` 必须是对象');
    return null;
  }
  const at = problems.length;
  const id = raw['id'];
  checkNonEmptyString(problems, id, '`link.id`');
  const from = raw['from'];
  checkNonEmptyString(problems, from, '`link.from`');
  const to = raw['to'];
  checkNonEmptyString(problems, to, '`link.to`');
  const type = raw['type'];
  checkLinkType(problems, type, '`link.type`');
  const lagDays = raw['lagDays'];
  checkIntegerInRange(problems, lagDays, '`link.lagDays`', -MAX_LAG_DAYS, MAX_LAG_DAYS);

  if (problems.length > at) {
    return null;
  }
  return {
    id: id as string,
    from: from as string,
    to: to as string,
    type: type as LinkType,
    lagDays: lagDays as number,
  };
}

function normalizeTarget(problems: string[], raw: unknown): WbsMoveTarget {
  if (!isRecord(raw)) {
    problems.push('`target` 必须是对象');
    return { parentId: null };
  }
  checkAllowedKeys(problems, raw, ['parentId', 'index', 'afterTaskId'], '`target`');
  const rawParent = raw['parentId'];
  const target: { parentId: string | null; index?: number; afterTaskId?: string } = {
    parentId: rawParent === null ? null : requireStringField(problems, raw, 'parentId'),
  };
  if (has(raw, 'index')) {
    if (checkIntegerInRange(problems, raw['index'], '`target.index`', 0, Number.MAX_SAFE_INTEGER)) {
      target.index = raw['index'] as number;
    }
  }
  if (has(raw, 'afterTaskId')) {
    target.afterTaskId = requireStringField(problems, raw, 'afterTaskId');
  }
  return target;
}

// ---------------------------------------------------------------- 形状校验（parseCommand 与 applyCommand 共用）

/** 命令形状校验的结果（`checkCommandShape` / `parseCommand` 共用）。 */
export type CommandShapeCheck =
  | { readonly ok: true; readonly command: DocumentCommand }
  | { readonly ok: false; readonly code: CommandFailureCode; readonly message: string };

/** 收口：有问题 → `CMD_INVALID_PAYLOAD`；无问题 → 用已收集到的规范化载荷装配命令。 */
function settleShape<T>(problems: readonly string[], build: () => T):
  | { readonly ok: true; readonly command: T }
  | CommandFailure {
  if (problems.length > 0) {
    return failureOf('CMD_INVALID_PAYLOAD', report(problems));
  }
  return { ok: true, command: build() };
}

/**
 * 校验并**规范化**一条命令（`unknown` 输入，故同时服务 `applyCommand` 与 `parseCommand`）。
 *
 * 口径：
 * - 未知 `kind` → `CMD_UNKNOWN_KIND`；缺字段/类型错 → `CMD_INVALID_PAYLOAD`；
 * - **命令顶层的多余键被忽略**（向前兼容：新版本写入的附加键不该让旧版本崩溃），
 *   但 patch 里的多余键**会被拒绝**——那是错字，静默忽略会让用户以为改动已生效。
 */
export function checkCommandShape(input: unknown): CommandShapeCheck {
  if (!isRecord(input)) {
    return { ok: false, code: 'CMD_INVALID_PAYLOAD', message: '命令必须是 JSON 对象' };
  }
  const kind = input['kind'];
  if (typeof kind !== 'string') {
    return { ok: false, code: 'CMD_INVALID_PAYLOAD', message: '命令缺少字符串字段 `kind`' };
  }
  if (!COMMAND_KINDS.some((known) => known === kind)) {
    return { ok: false, code: 'CMD_UNKNOWN_KIND', message: `未知命令类型：${JSON.stringify(kind)}` };
  }

  const problems: string[] = [];
  switch (kind as DocumentCommandKind) {
    case 'document.replace': {
      const document = input['document'];
      if (!isRecord(document)) {
        return { ok: false, code: 'CMD_INVALID_PAYLOAD', message: '`document` 必须是对象' };
      }
      const version = document['version'];
      if (version !== CURRENT_DOCUMENT_VERSION) {
        return {
          ok: false,
          code: 'CMD_VERSION_MISMATCH',
          message: `\`document.version\` 必须是当前版本 ${String(CURRENT_DOCUMENT_VERSION)}，收到 ${JSON.stringify(version)}`,
        };
      }
      for (const key of ['project', 'calendars', 'tasks', 'links', 'baselines']) {
        if (!Object.prototype.hasOwnProperty.call(document, key)) {
          problems.push(`\`document.${key}\` 缺失（整份替换要求规范形状的五段齐全）`);
        }
      }
      const problem = findNonJsonValue(document, 'document');
      if (problem !== null) {
        problems.push(problem);
      }
      return settleShape(problems, () => ({
        kind: 'document.replace',
        document: document as unknown as ProjectDocument,
      }));
    }

    case 'project.update': {
      const patch = normalizeProjectPatch(problems, input['patch']);
      return settleShape(problems, () => ({ kind: 'project.update', patch }));
    }

    case 'task.insert': {
      const task = normalizeTaskPayload(problems, input['task']);
      const rawParent = input['parentId'];
      const parentId = rawParent === null ? null : requireStringField(problems, input, 'parentId');
      const afterTaskId = has(input, 'afterTaskId')
        ? requireStringField(problems, input, 'afterTaskId')
        : undefined;
      let index: number | undefined;
      if (
        has(input, 'index') &&
        checkIntegerInRange(problems, input['index'], '`index`', 0, Number.MAX_SAFE_INTEGER)
      ) {
        index = input['index'] as number;
      }
      if (task !== null && task.parentId !== parentId) {
        problems.push(
          `\`task.parentId\` (${JSON.stringify(task.parentId)}) 与命令的 \`parentId\` (${JSON.stringify(parentId)}) 不一致：\`parentId\` 是层级的真相源，不做静默改写`,
        );
      }
      return settleShape(problems, () => ({
        kind: 'task.insert',
        task: task ?? ({} as DocumentTask),
        parentId,
        ...(afterTaskId === undefined ? {} : { afterTaskId }),
        ...(index === undefined ? {} : { index }),
      }));
    }

    case 'task.update': {
      const id = requireStringField(problems, input, 'id');
      const patch = normalizeTaskPatch(problems, input['patch']);
      return settleShape(problems, () => ({ kind: 'task.update', id, patch }));
    }

    case 'task.remove': {
      const id = requireStringField(problems, input, 'id');
      return settleShape(problems, () => ({ kind: 'task.remove', id }));
    }

    case 'task.indent': {
      const id = requireStringField(problems, input, 'id');
      return settleShape(problems, () => ({ kind: 'task.indent', id }));
    }

    case 'task.outdent': {
      const id = requireStringField(problems, input, 'id');
      return settleShape(problems, () => ({ kind: 'task.outdent', id }));
    }

    case 'task.move': {
      const id = requireStringField(problems, input, 'id');
      const target = normalizeTarget(problems, input['target']);
      return settleShape(problems, () => ({ kind: 'task.move', id, target }));
    }

    case 'link.insert': {
      const link = normalizeLinkPayload(problems, input['link']);
      return settleShape(problems, () => ({ kind: 'link.insert', link: link ?? ({} as DocumentLink) }));
    }

    case 'link.update': {
      const id = requireStringField(problems, input, 'id');
      const patch = normalizeLinkPatch(problems, input['patch']);
      return settleShape(problems, () => ({ kind: 'link.update', id, patch }));
    }

    case 'link.remove': {
      const id = requireStringField(problems, input, 'id');
      return settleShape(problems, () => ({ kind: 'link.remove', id }));
    }
  }
}

// ---------------------------------------------------------------- 候选文档构造

type BuildResult =
  | { readonly ok: true; readonly candidate: ProjectDocument }
  | CommandFailure;

function hasTask(document: ProjectDocument, id: string): boolean {
  return document.tasks.some((task) => task.id === id);
}

function hasLink(document: ProjectDocument, id: string): boolean {
  return document.links.some((link) => link.id === id);
}

function taskNotFound(id: string): CommandFailure {
  return failureOf('CMD_TASK_NOT_FOUND', `任务不存在：${id}`);
}

function linkNotFound(id: string): CommandFailure {
  return failureOf('CMD_LINK_NOT_FOUND', `依赖边不存在：${id}`);
}

/** `WbsFailureCode` → 命令失败码（三个值被归一，其余逐值透传）。 */
function mapWbsCode(code: Exclude<WbsFailureCode, 'WBS_SAME_POSITION'>): CommandFailureCode {
  if (code === 'WBS_TASK_NOT_FOUND') {
    return 'CMD_TASK_NOT_FOUND';
  }
  if (code === 'WBS_TARGET_NOT_FOUND') {
    return 'CMD_PARENT_NOT_FOUND';
  }
  return code;
}

/** 层级操作结果的统一收口：`WBS_SAME_POSITION` = 无操作（正常交互），其余失败码透传。 */
function fromWbs(
  document: ProjectDocument,
  result: WbsResult<readonly DocumentTask[]>,
): BuildResult {
  if (!result.ok) {
    if (result.code === 'WBS_SAME_POSITION') {
      return { ok: true, candidate: document };
    }
    return failureOf(mapWbsCode(result.code), result.message);
  }
  return { ok: true, candidate: { ...document, tasks: result.value } };
}

/** 就地打补丁：不改变则返回**同一引用**（这样"恒等变更"能一路被识别成 `changed:false`）。 */
function applyPatch<T extends object>(target: T, patch: object): T {
  const source = target as Record<string, unknown>;
  const next: Record<string, unknown> = { ...source };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(source, key) || !jsonDeepEqual(source[key], value)) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? (next as T) : target;
}

/** 收集任务及其整棵子树（依赖「父节点先于子节点出现在文档序」这一不变量，逐个前进即可）。 */
function collectSubtreeIds(tasks: readonly TaskHierarchyInput[], id: string): ReadonlySet<string> {
  const subtree = new Set<string>([id]);
  for (const task of tasks) {
    if (task.parentId !== null && subtree.has(task.parentId)) {
      subtree.add(task.id);
    }
  }
  return subtree;
}

function buildCandidate(document: ProjectDocument, command: DocumentCommand): BuildResult {
  switch (command.kind) {
    case 'document.replace':
      return { ok: true, candidate: command.document };

    case 'project.update': {
      const patch = command.patch;
      if (
        patch.baseCalendarId !== undefined &&
        patch.baseCalendarId !== '' &&
        !document.calendars.some((spec) => (spec.id ?? 'project') === patch.baseCalendarId)
      ) {
        return failureOf(
          'CMD_CALENDAR_NOT_FOUND',
          `\`baseCalendarId\` = ${JSON.stringify(patch.baseCalendarId)} 在 \`calendars[]\` 中不存在`,
        );
      }
      return { ok: true, candidate: { ...document, project: applyPatch(document.project, patch) } };
    }

    case 'task.insert': {
      const task = command.task;
      if (hasTask(document, task.id)) {
        return failureOf('CMD_TASK_ID_DUPLICATE', `任务 id 已存在：${task.id}`);
      }
      if (command.parentId !== null && !hasTask(document, command.parentId)) {
        return failureOf('CMD_PARENT_NOT_FOUND', `目标父任务不存在：${command.parentId}`);
      }
      if (command.afterTaskId !== undefined && !hasTask(document, command.afterTaskId)) {
        return failureOf('CMD_ANCHOR_TASK_NOT_FOUND', `落点任务不存在：${command.afterTaskId}`);
      }
      const appended = [...document.tasks, task];
      const target: WbsMoveTarget = {
        parentId: command.parentId,
        ...(command.index === undefined ? {} : { index: command.index }),
        ...(command.afterTaskId === undefined ? {} : { afterTaskId: command.afterTaskId }),
      };
      const moved = moveTask(appended, task.id, target);
      if (moved.ok) {
        return { ok: true, candidate: { ...document, tasks: moved.value } };
      }
      if (moved.code === 'WBS_SAME_POSITION') {
        // 追加位置恰好就是目标位置：`moveTask` 把"已经在位"判为无操作，但对 insert 而言这正是成功。
        return { ok: true, candidate: { ...document, tasks: reindexTasks(appended) } };
      }
      return failureOf(mapWbsCode(moved.code), moved.message);
    }

    case 'task.update': {
      const index = document.tasks.findIndex((task) => task.id === command.id);
      const current = index < 0 ? undefined : document.tasks[index];
      if (current === undefined) {
        return taskNotFound(command.id);
      }
      const next = applyPatch(current, command.patch);
      if (next === current) {
        return { ok: true, candidate: document };
      }
      const tasks = [...document.tasks];
      tasks[index] = next;
      return { ok: true, candidate: { ...document, tasks } };
    }

    case 'task.remove': {
      if (!hasTask(document, command.id)) {
        return taskNotFound(command.id);
      }
      const subtree = collectSubtreeIds(document.tasks, command.id);
      return {
        ok: true,
        candidate: {
          ...document,
          tasks: reindexTasks(document.tasks.filter((task) => !subtree.has(task.id))),
          links: document.links.filter((link) => !subtree.has(link.from) && !subtree.has(link.to)),
        },
      };
    }

    case 'task.indent':
      if (!hasTask(document, command.id)) {
        return taskNotFound(command.id);
      }
      return fromWbs(document, indentTask(document.tasks, command.id));

    case 'task.outdent':
      if (!hasTask(document, command.id)) {
        return taskNotFound(command.id);
      }
      return fromWbs(document, outdentTask(document.tasks, command.id));

    case 'task.move': {
      if (!hasTask(document, command.id)) {
        return taskNotFound(command.id);
      }
      if (command.target.parentId !== null && !hasTask(document, command.target.parentId)) {
        return failureOf('CMD_PARENT_NOT_FOUND', `目标父任务不存在：${command.target.parentId}`);
      }
      if (command.target.afterTaskId !== undefined && !hasTask(document, command.target.afterTaskId)) {
        return failureOf('CMD_ANCHOR_TASK_NOT_FOUND', `落点任务不存在：${command.target.afterTaskId}`);
      }
      return fromWbs(document, moveTask(document.tasks, command.id, command.target));
    }

    case 'link.insert': {
      const link = command.link;
      if (hasLink(document, link.id)) {
        return failureOf('CMD_LINK_ID_DUPLICATE', `依赖边 id 已存在：${link.id}`);
      }
      if (!hasTask(document, link.from) || !hasTask(document, link.to)) {
        return failureOf(
          'CMD_LINK_ENDPOINT_NOT_FOUND',
          `依赖边端点不存在：${JSON.stringify(link.from)} → ${JSON.stringify(link.to)}`,
        );
      }
      if (link.from === link.to) {
        return failureOf('CMD_LINK_SELF_REFERENCE', '依赖边不能自环');
      }
      return { ok: true, candidate: { ...document, links: [...document.links, link] } };
    }

    case 'link.update': {
      const index = document.links.findIndex((link) => link.id === command.id);
      const current = index < 0 ? undefined : document.links[index];
      if (current === undefined) {
        return linkNotFound(command.id);
      }
      const next = applyPatch(current, command.patch);
      if (next === current) {
        return { ok: true, candidate: document };
      }
      if (!hasTask(document, next.from) || !hasTask(document, next.to)) {
        return failureOf(
          'CMD_LINK_ENDPOINT_NOT_FOUND',
          `依赖边端点不存在：${JSON.stringify(next.from)} → ${JSON.stringify(next.to)}`,
        );
      }
      if (next.from === next.to) {
        return failureOf('CMD_LINK_SELF_REFERENCE', '依赖边不能自环');
      }
      const links = [...document.links];
      links[index] = next;
      return { ok: true, candidate: { ...document, links } };
    }

    case 'link.remove': {
      if (!hasLink(document, command.id)) {
        return linkNotFound(command.id);
      }
      return {
        ok: true,
        candidate: { ...document, links: document.links.filter((link) => link.id !== command.id) },
      };
    }
  }
}

// ---------------------------------------------------------------- 命令执行

/**
 * 应用一条命令（**纯函数**，不修改入参文档）。
 *
 * 流水线：版本守卫 → 形状校验 → 目标/前置检查 → 构造候选 → 差分日志 → 结果合法性校验
 * （复用 `validateDocument`）→ **用日志应用产出最终文档**（日志即唯一变更内核）。
 *
 * 复杂度：O(N)（索引 + 差分 + 校验），按"一次手势一次命令"计费；
 * 逐帧工作属 G2 的传播闭包，不在本层。
 */
export function applyCommand(document: ProjectDocument, command: DocumentCommand): CommandResult {
  if (document.version !== CURRENT_DOCUMENT_VERSION) {
    return failureOf(
      'CMD_VERSION_MISMATCH',
      `文档版本 ${String(document.version)} 不是当前版本 ${String(CURRENT_DOCUMENT_VERSION)}（迁移请在 parseDocument 完成）`,
    );
  }

  const shape = checkCommandShape(command);
  if (!shape.ok) {
    return failureOf(shape.code, shape.message);
  }
  const checked = shape.command;

  const built = buildCandidate(document, checked);
  if (!built.ok) {
    return built;
  }
  if (built.candidate === document) {
    return { ok: true, changed: false, document };
  }

  const journal =
    checked.kind === 'document.replace'
      ? createBulkJournal(document, built.candidate)
      : diffDocument(document, built.candidate);
  if (isJournalEmpty(journal)) {
    return { ok: true, changed: false, document };
  }

  const diagnostics = validateDocument(built.candidate).filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    return failWith(
      'CMD_RESULT_INVALID',
      `命令的结果未通过 schema 校验：${first?.code ?? '未知'} ${first?.message ?? ''}`.trim(),
      diagnostics,
    );
  }

  return { ok: true, changed: true, document: applyDocumentJournal(document, journal), journal };
}

/**
 * 重放一串命令（同一文档 + 同一命令序列 → 同一结果；命令本身是可序列化的纯数据）。
 *
 * **不静默跳过失败**：遇到第一条失败命令即停，返回已成功应用的前缀状态与失败下标。
 */
export function replayCommands(
  document: ProjectDocument,
  commands: readonly DocumentCommand[],
): ReplayResult {
  let current = document;
  let changed = 0;
  for (const [index, command] of commands.entries()) {
    const result = applyCommand(current, command);
    if (!result.ok) {
      return {
        ok: false,
        index,
        code: result.code,
        message: result.message,
        document: current,
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      };
    }
    if (result.changed) {
      changed += 1;
    }
    current = result.document;
  }
  return { ok: true, document: current, applied: commands.length, changed };
}

// ---------------------------------------------------------------- 序列化

/** 命令的规范 JSON 值（键序固定、`undefined` 可选字段省略）。 */
function toJsonCommand(command: DocumentCommand): Record<string, unknown> {
  switch (command.kind) {
    case 'document.replace':
      return { kind: command.kind, document: command.document };
    case 'project.update':
      return { kind: command.kind, patch: command.patch };
    case 'task.insert':
      return {
        kind: command.kind,
        task: command.task,
        parentId: command.parentId,
        ...(command.afterTaskId === undefined ? {} : { afterTaskId: command.afterTaskId }),
        ...(command.index === undefined ? {} : { index: command.index }),
      };
    case 'task.update':
      return { kind: command.kind, id: command.id, patch: command.patch };
    case 'task.remove':
    case 'task.indent':
    case 'task.outdent':
      return { kind: command.kind, id: command.id };
    case 'task.move':
      return {
        kind: command.kind,
        id: command.id,
        target: {
          parentId: command.target.parentId,
          ...(command.target.index === undefined ? {} : { index: command.target.index }),
          ...(command.target.afterTaskId === undefined
            ? {}
            : { afterTaskId: command.target.afterTaskId }),
        },
      };
    case 'link.insert':
      return { kind: command.kind, link: command.link };
    case 'link.update':
      return { kind: command.kind, id: command.id, patch: command.patch };
    case 'link.remove':
      return { kind: command.kind, id: command.id };
  }
}

/**
 * 序列化命令（规范键序、紧凑单行 JSON）。
 *
 * @throws RangeError 命令形状非法（程序员错误：外部输入请先 `parseCommand` 校验）
 */
export function serializeCommand(command: DocumentCommand): string {
  const shape = checkCommandShape(command);
  if (!shape.ok) {
    throw new RangeError(`无法序列化非法命令：${shape.message}`);
  }
  return JSON.stringify(toJsonCommand(shape.command));
}

/**
 * 解析命令文本（外部/持久化输入的唯一入口）。
 *
 * 未知 `kind` 明确拒绝（`CMD_UNKNOWN_KIND`），不猜测；命令顶层的多余键被忽略（向前兼容）。
 */
export function parseCommand(text: string): CommandParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'CMD_INVALID_PAYLOAD', message: `JSON 语法错误：${detail}` };
  }
  return checkCommandShape(raw);
}

// ---------------------------------------------------------------- id 建议

function suggestId(ids: readonly string[], prefix: string): string {
  const used = new Set(ids);
  let candidate = 1;
  while (used.has(`${prefix}${String(candidate)}`)) {
    candidate += 1;
  }
  return `${prefix}${String(candidate)}`;
}

/**
 * 确定性的任务 id 建议（最小未占用的 `${prefix}${n}`）。
 *
 * 命令层**不自己生成 id**（那会引入隐式状态、破坏"同一命令序列 → 同一结果"）；
 * 本函数只是给调用方一个可复现的建议值。
 */
export function suggestTaskId(document: ProjectDocument, prefix = 't'): string {
  return suggestId(document.tasks.map((task) => task.id), prefix);
}

/** 确定性的依赖边 id 建议（口径同 `suggestTaskId`）。 */
export function suggestLinkId(document: ProjectDocument, prefix = 'l'): string {
  return suggestId(document.links.map((link) => link.id), prefix);
}
