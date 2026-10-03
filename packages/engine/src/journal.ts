/**
 * before 镜像（命令日志）与"唯一变更内核"（G1.3 的逆操作面）。
 *
 * ## 为什么日志长成"按 id 的差分"，而不是"按下标的 undo log"
 *
 * R-2 要求命令**自带逆操作**，且"记录受影响对象的 before 镜像即可确定性回滚"。
 * 本文件把这个要求落成两种日志形态：
 *
 * 1. `delta`：`project` / `tasks` / `links` 三类实体按 **id** 记录 `before`/`after`
 *    （`null` = 该实体在这一侧不存在），外加 `taskOrder` 与 `linkOrder`（id 序列）——
 *    「兄弟顺序 = 文档序」是文档语义的一部分（ADR 0002 §6），而依赖边的数组顺序虽然无语义，
 *    却出现在规范序列化文本里：两类顺序都必须被记录，否则回滚不可能是逐项相等。
 * 2. `document`：整份文档的前后两态，供 `document.replace` 这类**批量**替换使用
 *    （导入/新建是用户级事件，O(N) 明示；细粒度命令不允许退化成这一形态）。
 *
 * 之所以**不**用"数组下标 + 逆序回放"的经典 undo log：
 * - 逆操作会退化成"逐字段 before/after 对调"（`invertDocumentJournal` 是对合），
 *   **不需要反转条目顺序、也没有差一格的坐标问题**——ADR 0002 §6 记录过，
 *   位置型语义在本仓库实际写出过三个错误判据；
 * - 同一份 delta 内的条目应用顺序无关紧要（顺序最后应用），因此"日志应用"是可交换的，
 *   失败面比"必须严格逆序"小得多。
 *
 * ## 两条不可动摇的引用纪律
 *
 * 1. **构造日志时 clone-then-freeze**：日志里的值是自己克隆出来的冻结副本，
 *    **绝不与任何文档共享引用**（防"共享可变对象导致回滚失败"，这是 G1.3 的出口条件之一）。
 *    注意是"克隆后冻结克隆体"——**绝不能冻结调用方的文档**（那会污染 `apps/web` 的响应式）。
 * 2. **应用日志时写出新鲜克隆**：引擎产出的文档永不携带冻结对象。
 *
 * ## 语义归属
 *
 * - 命令层（`command.ts`）负责"该不该变、怎么变"；本文件只负责"变了什么、怎么还原"。
 * - `applyDocumentJournal` / `invertDocumentJournal` 收到**自相矛盾**的日志
 *   （`before` 与当前文档不符、`taskOrder` 的 id 集与实体集不符）时抛 `RangeError`：
 *   那是**程序员错误**，不是用户数据错误（用户数据的形状错误由命令层给结构化失败码）。
 *
 * 本文件零 DOM、零框架依赖，只依赖 `./schema.js` 的类型。
 */

import type {
  DocumentLink,
  DocumentTask,
  ProjectDocument,
  ProjectMeta,
} from './schema.js';

/** 读一个"普通 JSON 对象"的判定（`Date`/`Map`/类实例一律不算——它们无法被 JSON 无损表达）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return `object(${name ?? '未知'})`;
  }
  return typeof value;
}

/**
 * 找出第一个"不是 JSON 值"的位置（返回人类可读描述；全是 JSON 值则返回 `null`）。
 *
 * 用途：命令载荷的形状守卫（`CMD_INVALID_PAYLOAD`）与 `cloneJsonValue` 的前置检查。
 * **必须显式拒绝**而非静默收窄的情形：非有限数字、函数、`undefined`、Symbol、BigInt、
 * 循环引用、非普通对象（`Date`/`Map`/类实例）——`JSON.stringify` 会静默丢掉其中一部分，
 * 而"容忍而不静默"是本仓库的一贯口径（ADR 0002 §2）。
 */
export function findNonJsonValue(value: unknown, path = ''): string | null {
  return scanNonJson(value, path, []);
}

function scanNonJson(value: unknown, path: string, seen: readonly object[]): string | null {
  const label = path === '' ? '值' : `\`${path}\``;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${label} 含非有限数字（JSON 不可表达）`;
  }
  if (typeof value !== 'object') {
    return `${label} 含非 JSON 值（${typeof value}）`;
  }
  if (seen.includes(value)) {
    return `${label} 含循环引用（JSON 不可表达）`;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return `${label} 含非普通对象（${describeType(value)}）`;
  }

  const nextSeen = [...seen, value];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = scanNonJson(item, `${path}[${String(index)}]`, nextSeen);
      if (problem !== null) {
        return problem;
      }
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const problem = scanNonJson(item, path === '' ? key : `${path}.${key}`, nextSeen);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/**
 * 深拷贝一个 JSON 值（数组与普通对象都重建）。
 *
 * @throws RangeError 含非 JSON 值或循环引用（见 `findNonJsonValue`）
 */
export function cloneJsonValue<T>(value: T): T {
  const problem = findNonJsonValue(value);
  if (problem !== null) {
    throw new RangeError(`无法克隆为 JSON 值：${problem}`);
  }
  return cloneJson(value) as T;
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = cloneJson(item);
  }
  return out;
}

/**
 * 就地深冻结一个 JSON 值（返回同一引用）。
 *
 * 循环引用下也能终止：先冻结再递归，遇到已冻结的对象立即返回。
 * **只用于日志与测试夹具**；引擎产出的文档一律不冻结（见文件头"引用纪律"）。
 */
export function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  const children: readonly unknown[] = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    deepFreezeJson(child);
  }
  return value;
}

/** 结构化深比较（键序无关）；用于"日志的 before 是否与当前文档一致"的守卫与差分。 */
export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonDeepEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      jsonDeepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// ---------------------------------------------------------------- 日志类型

/** 一个实体在一次变更中的前后镜像；`null` = 该实体在这一侧不存在（新增/删除）。 */
export interface EntityChange<T> {
  readonly before: T | null;
  readonly after: T | null;
}

/** 任务的前后镜像（按 id 定位，与文档序无关）。 */
export interface TaskChange extends EntityChange<DocumentTask> {
  readonly id: string;
}

/** 依赖边的前后镜像（按 id 定位）。 */
export interface LinkChange extends EntityChange<DocumentLink> {
  readonly id: string;
}

/** 项目元数据的前后镜像（项目恒存在，故两侧都非 `null`）。 */
export interface ProjectChange {
  readonly before: ProjectMeta;
  readonly after: ProjectMeta;
}

/**
 * **数组顺序**（id 序列）的前后镜像。
 *
 * 任务顺序是文档语义的一部分（「兄弟顺序 = 文档序」，ADR 0002 §6）；
 * 依赖边顺序没有语义，但它出现在规范序列化文本里，因此"新增/删除一条边"同样必须被记录
 * ——否则回滚会把边追加到末尾，往返就不是逐项相等（这是实测踩到的真实缺陷）。
 */
export interface OrderChange {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** 细粒度命令的差分日志（按 id 键，故条目之间可交换；顺序字段最后应用）。 */
export interface DeltaJournal {
  readonly kind: 'delta';
  readonly project: ProjectChange | null;
  readonly tasks: readonly TaskChange[];
  readonly links: readonly LinkChange[];
  readonly taskOrder: OrderChange | null;
  readonly linkOrder: OrderChange | null;
}

/** 批量替换的整份文档镜像（`document.replace` 专用）。 */
export interface BulkJournal {
  readonly kind: 'document';
  readonly before: ProjectDocument;
  readonly after: ProjectDocument;
}

/**
 * 命令日志 = before 镜像。
 *
 * 就"回滚"而言它已经足够（`invertDocumentJournal` 即可）；同时保留 `after` 是为了
 * 让 **redo 免费**（对调即可，不必重跑命令）并获得一条可断言的互证律：
 * `apply(apply(d, j), swap(j)) ≡ d` 且 `apply(apply(d, swap(j)), j) ≡ apply(d, j)`。
 */
export type DocumentJournal = DeltaJournal | BulkJournal;

// ---------------------------------------------------------------- 构造

function freezeNullable<T>(value: T | null): T | null {
  return value === null ? null : deepFreezeJson(cloneJsonValue(value));
}

function freezeChange<T>(change: EntityChange<T>): EntityChange<T> {
  return {
    before: freezeNullable(change.before),
    after: freezeNullable(change.after),
  };
}

/**
 * 项目元数据的镜像。
 *
 * **必须两侧都克隆**：项目恒存在（两侧都非 `null`），若直接引用原对象，
 * 最外层的 `deepFreezeJson` 就会把**调用方的 `project` 冻住**——
 * 这正是"绝不冻结调用方文档"这条纪律的反例（`journal.spec.ts` 有专门用例覆盖 `project.update`）。
 */
function freezeProject(before: ProjectMeta, after: ProjectMeta): ProjectChange {
  return {
    before: deepFreezeJson(cloneJsonValue(before)),
    after: deepFreezeJson(cloneJsonValue(after)),
  };
}

/**
 * 构造整份文档的批量镜像（`document.replace` 专用）。
 *
 * 两侧都做 clone-then-freeze，因此日志与"调用方手上的文档"不可能共享引用。
 */
export function createBulkJournal(before: ProjectDocument, after: ProjectDocument): BulkJournal {
  return deepFreezeJson({
    kind: 'document',
    before: deepFreezeJson(cloneJsonValue(before)),
    after: deepFreezeJson(cloneJsonValue(after)),
  });
}

/**
 * 计算两份文档的**细粒度**差分日志。
 *
 * 口径：
 * - 条目只含"值真的变了"的实体——因此日志规模与**变更量**同阶，而非文档规模
 *   （唯一的例外是顺序字段：排列变化只能用 id 序列表达，≈10 B/任务，仍是排列的最省编码）；
 * - 条目顺序固定：任务与依赖边先"原有顺序的删除/修改"，再"新增顺序的新增"——确定性可断言；
 * - 相等判定用 `jsonDeepEqual`（结构化、键序无关），与"落盘规范形状"同源；
 * - 返回值**整体深冻结**（条目对象、数组与值都冻结——防调用方就地改写日志）；
 * - 本函数**假设两份文档都是合法文档**（无重复 id）——命令层已保证其产出零 `error`。
 */
export function diffDocument(before: ProjectDocument, after: ProjectDocument): DeltaJournal {
  const beforeTasks = new Map(before.tasks.map((task) => [task.id, task]));
  const afterTasks = new Map(after.tasks.map((task) => [task.id, task]));
  const tasks: TaskChange[] = [];
  for (const [id, task] of beforeTasks) {
    const next = afterTasks.get(id);
    if (next === undefined) {
      tasks.push({ id, before: task, after: null });
    } else if (!jsonDeepEqual(task, next)) {
      tasks.push({ id, before: task, after: next });
    }
  }
  for (const [id, task] of afterTasks) {
    if (!beforeTasks.has(id)) {
      tasks.push({ id, before: null, after: task });
    }
  }

  const beforeLinks = new Map(before.links.map((link) => [link.id, link]));
  const afterLinks = new Map(after.links.map((link) => [link.id, link]));
  const links: LinkChange[] = [];
  for (const [id, link] of beforeLinks) {
    const next = afterLinks.get(id);
    if (next === undefined) {
      links.push({ id, before: link, after: null });
    } else if (!jsonDeepEqual(link, next)) {
      links.push({ id, before: link, after: next });
    }
  }
  for (const [id, link] of afterLinks) {
    if (!beforeLinks.has(id)) {
      links.push({ id, before: null, after: link });
    }
  }

  const taskOrder = changedOrder(
    before.tasks.map((task) => task.id),
    after.tasks.map((task) => task.id),
  );
  const linkOrder = changedOrder(
    before.links.map((link) => link.id),
    after.links.map((link) => link.id),
  );

  return deepFreezeJson({
    kind: 'delta',
    project: jsonDeepEqual(before.project, after.project)
      ? null
      : freezeProject(before.project, after.project),
    tasks: tasks.map((change) => ({
      id: change.id,
      ...freezeChange(change),
    })),
    links: links.map((change) => ({
      id: change.id,
      ...freezeChange(change),
    })),
    taskOrder,
    linkOrder,
  });
}

/** 数组顺序是否变化；变化则给出前后 id 序列，否则 `null`。 */
function changedOrder(
  before: readonly string[],
  after: readonly string[],
): OrderChange | null {
  return sameStringArray(before, after) ? null : { before: [...before], after: [...after] };
}

/** 日志是否等价于"什么都没变"。 */
export function isJournalEmpty(journal: DocumentJournal): boolean {
  if (journal.kind === 'document') {
    return jsonDeepEqual(journal.before, journal.after);
  }
  return (
    journal.project === null &&
    journal.tasks.length === 0 &&
    journal.links.length === 0 &&
    journal.taskOrder === null &&
    journal.linkOrder === null
  );
}

// ---------------------------------------------------------------- 逆操作

/**
 * 取逆日志：`before`/`after` 逐字段对调（`delta` 的条目**不需要**反转顺序）。
 *
 * 对合律：`invertDocumentJournal(invertDocumentJournal(journal))` 与 `journal` 深比较相等。
 * 日志值自身是冻结的，故这里直接复用引用（无需再克隆）。
 */
export function invertDocumentJournal(journal: DocumentJournal): DocumentJournal {
  if (journal.kind === 'document') {
    return deepFreezeJson({ kind: 'document', before: journal.after, after: journal.before });
  }
  return deepFreezeJson({
    kind: 'delta',
    project:
      journal.project === null
        ? null
        : { before: journal.project.after, after: journal.project.before },
    tasks: journal.tasks.map((change) => ({
      id: change.id,
      before: change.after,
      after: change.before,
    })),
    links: journal.links.map((change) => ({
      id: change.id,
      before: change.after,
      after: change.before,
    })),
    taskOrder:
      journal.taskOrder === null
        ? null
        : { before: journal.taskOrder.after, after: journal.taskOrder.before },
    linkOrder:
      journal.linkOrder === null
        ? null
        : { before: journal.linkOrder.after, after: journal.linkOrder.before },
  });
}

// ---------------------------------------------------------------- 应用

/**
 * 把日志应用到文档上（正向 = 用 `after` 覆写，逆向 = 先 `invertDocumentJournal`）。
 *
 * **写出的实体是新鲜克隆**（未冻结），因此引擎产出的文档不会被日志的冻结态污染。
 * 未受影响的实体按引用复用（与 `wbs.ts`/`schema.ts` 的不可变风格一致）。
 *
 * @throws RangeError 日志与文档自相矛盾（`before` 不符、`taskOrder` 的 id 集不匹配）——
 *   这是程序员错误；由 `applyCommand` 产出的日志永不触发。
 */
export function applyDocumentJournal(
  document: ProjectDocument,
  journal: DocumentJournal,
): ProjectDocument {
  if (journal.kind === 'document') {
    assertMatches(document, journal.before, '整份文档镜像的 before');
    return cloneJsonValue(journal.after);
  }

  if (journal.project !== null) {
    assertMatches(document.project, journal.project.before, 'project');
  }

  const taskById = new Map(document.tasks.map((task) => [task.id, task]));
  for (const change of journal.tasks) {
    assertChangeMatches(taskById.get(change.id) ?? null, change, '任务');
    if (change.after === null) {
      taskById.delete(change.id);
    } else {
      taskById.set(change.id, cloneJsonValue(change.after));
    }
  }

  const currentTaskOrder = document.tasks.map((task) => task.id);
  assertOrderMatches(currentTaskOrder, journal.taskOrder, '任务');
  const tasks = rebuildOrdered(
    currentTaskOrder,
    taskById,
    journal.tasks
      .filter((change) => change.before === null && change.after !== null)
      .map((change) => change.id),
    journal.taskOrder,
    '任务',
  );

  const linkById = new Map(document.links.map((link) => [link.id, link]));
  for (const change of journal.links) {
    assertChangeMatches(linkById.get(change.id) ?? null, change, '依赖边');
    if (change.after === null) {
      linkById.delete(change.id);
    } else {
      linkById.set(change.id, cloneJsonValue(change.after));
    }
  }
  const currentLinkOrder = document.links.map((link) => link.id);
  assertOrderMatches(currentLinkOrder, journal.linkOrder, '依赖边');
  const links = rebuildOrdered(
    currentLinkOrder,
    linkById,
    journal.links
      .filter((change) => change.before === null && change.after !== null)
      .map((change) => change.id),
    journal.linkOrder,
    '依赖边',
  );

  return {
    version: document.version,
    project: journal.project === null ? document.project : cloneJsonValue(journal.project.after),
    calendars: document.calendars,
    tasks,
    links,
    baselines: document.baselines,
  };
}

/**
 * 按 id 重排数组。
 *
 * - `order` 非空时以它为准（必须是现有 id 的**排列**，见 `assertOrderMatches`）；
 * - `order` 为空时保持原有相对顺序，并把新增实体按日志顺序追加到末尾
 *   （只有"新增但顺序未变"才会走到这里，例如依赖边插入）。
 */
function rebuildOrdered<T extends { readonly id: string }>(
  existingIds: readonly string[],
  byId: ReadonlyMap<string, T>,
  insertedIds: readonly string[],
  order: OrderChange | null,
  label: string,
): T[] {
  if (order !== null) {
    if (order.after.length !== byId.size) {
      throw new RangeError(
        `日志与文档不一致：${label}顺序包含 ${String(order.after.length)} 项，但实体集合有 ${String(byId.size)} 项`,
      );
    }
    const seen = new Set<string>();
    return order.after.map((id) => {
      const entity = byId.get(id);
      if (entity === undefined || seen.has(id)) {
        throw new RangeError(`日志与文档不一致：${label}顺序里的 id ${id} 不在实体集合中（或重复）`);
      }
      seen.add(id);
      return entity;
    });
  }

  const out: T[] = [];
  for (const id of existingIds) {
    const entity = byId.get(id);
    if (entity !== undefined) {
      out.push(entity);
    }
  }
  for (const id of insertedIds) {
    const entity = byId.get(id);
    if (entity !== undefined && !existingIds.includes(id)) {
      out.push(entity);
    }
  }
  return out;
}

function assertMatches(current: unknown, expected: unknown, label: string): void {
  if (!jsonDeepEqual(current, expected)) {
    throw new RangeError(`日志与文档不一致：${label} 的 before 与当前值不同`);
  }
}

/** 顺序字段的守卫：`before` 必须是当前顺序（否则这份日志属于另一份文档状态）。 */
function assertOrderMatches(
  current: readonly string[],
  order: OrderChange | null,
  label: string,
): void {
  if (order !== null) {
    assertMatches(current, order.before, `${label}顺序`);
  }
}

function assertChangeMatches<T extends { readonly id: string }>(
  current: T | null,
  change: EntityChange<T> & { readonly id: string },
  label: string,
): void {
  if (change.before === null) {
    if (current !== null) {
      throw new RangeError(
        `日志与文档不一致：${label} ${change.id} 在日志里是"新增"，但文档中已存在`,
      );
    }
    return;
  }
  if (current === null) {
    throw new RangeError(
      `日志与文档不一致：${label} ${change.id} 在文档中不存在，但日志记录了它的 before`,
    );
  }
  if (!jsonDeepEqual(current, change.before)) {
    throw new RangeError(`日志与文档不一致：${label} ${change.id} 的 before 与当前值不同`);
  }
}

// ---------------------------------------------------------------- 作用域

/**
 * 日志的影响范围。
 *
 * 供 G4/G5 做"只失效受影响子图"的缓存失效（VW-05 的响应式口径）与 G6 的落盘摘要。
 * `wholeDocument` 为真即"整份文档已替换"，此时 id 列表是替换后的全集（如实报告）。
 */
export interface JournalScope {
  readonly wholeDocument: boolean;
  readonly projectChanged: boolean;
  readonly taskOrderChanged: boolean;
  readonly linkOrderChanged: boolean;
  readonly taskIds: readonly string[];
  readonly linkIds: readonly string[];
}

/** 计算日志的影响范围（纯函数，不修改日志）。 */
export function journalScope(journal: DocumentJournal): JournalScope {
  if (journal.kind === 'document') {
    return {
      wholeDocument: true,
      projectChanged: !jsonDeepEqual(journal.before.project, journal.after.project),
      taskOrderChanged: !sameStringArray(
        journal.before.tasks.map((task) => task.id),
        journal.after.tasks.map((task) => task.id),
      ),
      linkOrderChanged: !sameStringArray(
        journal.before.links.map((link) => link.id),
        journal.after.links.map((link) => link.id),
      ),
      taskIds: journal.after.tasks.map((task) => task.id),
      linkIds: journal.after.links.map((link) => link.id),
    };
  }
  return {
    wholeDocument: false,
    projectChanged: journal.project !== null,
    taskOrderChanged: journal.taskOrder !== null,
    linkOrderChanged: journal.linkOrder !== null,
    taskIds: journal.tasks.map((change) => change.id),
    linkIds: journal.links.map((change) => change.id),
  };
}
