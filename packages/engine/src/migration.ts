/**
 * **版本迁移：v1 → v2 → v3**（P3/C4-b 从 `schema.ts` 拆出）。
 *
 * 为什么单独成模块：迁移是"**旧形状 → 新形状**"的**结构改写**，与 `schema.ts` 的"形状归一 + 字段校验"
 * 是两件事——把逐跳迁移与它专用的编号遍历放在一起，`schema.ts` 才能只留"校验入口与归一机制"。
 *
 * 本文件是**叶子**（只 import `wbs.ts` 的通用谓词与分隔符；`DocumentDiagnostic` 只是类型）：
 * 迁移的**驱动**（读版本、按 `MIGRATIONS` 逐跳推进、环检测）留在 `schema.ts` 的 `migrateDocument`，
 * 因为它要用 schema 的版本读数机制（`readVersion` + 诊断入栈）。
 *
 * ## 与 `wbs.ts` 的编号遍历的关系（**刻意的差异**，不是漏抽）
 *
 * {@link migrationOutlineNumbers} 与 `wbs.computeOutlineNumbersByScan` 的遍历骨架相同，但**脏数据的
 * 处理不同**：wbs 的那条把"父 id 不存在 / 父指向自己"规范成根（那是**活文档**的口径，配合 `buildTaskTree`），
 * 迁移这条**不做规范化**——它跑在校验之前，遇到不可达的 id 就退回"位置编号"（`index + 1`），
 * 让随后的 `validateDocument` 去报 `TREE_*` 的问题。合流两者会改变**脏旧文档**迁移后的 `outlineNumber`
 * （进而改变用户看到的诊断），属行为变更 ⇒ 本批保留差异并把理由写在这里。
 */

import { isRecord, OUTLINE_SEPARATOR } from './wbs.js';
import type { DocumentDiagnostic } from './schema.js';

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
  const computed = migrationOutlineNumbers(rawTasks);

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

/**
 * v2→v3 用的**最小编号计算**（不排序、不做环检测：脏数据由随后的校验负责报错）。
 *
 * 与 `wbs.computeOutlineNumbersByScan` 的差异见文件头——**不可达的 id 退回位置编号**，
 * 这正是下面 `fallback` 存在的原因。
 */
function migrationOutlineNumbers(tasks: readonly unknown[]): readonly string[] {
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

/** 版本 → 迁移函数（**逐跳**，故新增版本只需追加一条；驱动在 `schema.ts` 的 `migrateDocument`）。 */
export const MIGRATIONS: ReadonlyMap<number, (input: Record<string, unknown>) => Record<string, unknown>> =
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
