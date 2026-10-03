/**
 * WBS 层级：树构建、派生量与调级操作（G1.2 的层级面）。
 *
 * 设计口径（冻结于 ADR 0002）：
 * 1. **`outlineNumber` 是派生值**——由层级 + **文档序**唯一确定（`1` / `1.2` / `1.2.3`）。
 *    它出现在文档里只为让 xlsx 导出自足（G3），**不是真相源**；
 *    `validateHierarchy` 对"存值 ≠ 计算值"报 `TREE_OUTLINE_STALE`，修复用 `reindexDocument`。
 * 2. **兄弟顺序 = 文档序**（`tasks[]` 的出现顺序），不引入 `order` 字段。
 *    用户自定义排序属 P1-04（筛选/分组/排序），届时另立字段。
 * 3. **全量重建，不做增量索引**：`indent`/`outdent`/`move` 都重建树并重编号。
 *    依据 [S3 结论 §八 B.8](../../../spikes/g0-s3-cpm-perf/结论.md)：1,000 规模上
 *    CSR 全量重建 p99 ≤ 180 µs，**先要可测的正确性**；增量优化需先用实测证明有收益。
 * 4. **调级失败不是异常而是正常交互**（拖到最外层再 Shift+Tab），故返回
 *    `WbsResult` 判别联合而**不抛错**——抛错的只有"调用方给了非法入参"这一类。
 *
 * 本文件零 DOM、零框架依赖，**不依赖任何其他模块**（`schema.ts` 依赖它，反之则不然）。
 */

// ---------------------------------------------------------------- JSON 值

/** JSON 数组。 */
export type JsonArray = readonly JsonValue[];

/** JSON 对象。属性读取须用 `obj['key']`（索引签名不含 `undefined`）。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** JSON 可表达的值（文档落盘的取值域）。 */
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;

// ---------------------------------------------------------------- 文档最小形状

/**
 * 层级校验需要的最小任务形状。
 *
 * 只声明"层级相关的五个字段"——`schema.ts` 的 `DocumentTask` 结构上是它的超集，
 * 因此校验逻辑既不依赖也不复制文档模型的全字段。
 */
export interface TaskHierarchyInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly outlineNumber: string;
  readonly name?: string;
}

/** 与 `schema.ts` 共用的诊断条目形状（避免为了一个类型让两层互相 import）。 */
export interface DiagnosticLike {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly path?: string;
  readonly taskId?: string;
  readonly linkId?: string;
}

// ---------------------------------------------------------------- 通用谓词

/** 判定"普通 JSON 对象"（排除 `null` 与数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- 编号

/** `outlineNumber` 的分段分隔符（WBS 编号惯例 `1.2.3`）。 */
export const OUTLINE_SEPARATOR = '.';

/** 任务缩进层级上限（`outlineNumber` 的段数上限，防病态文档）。 */
export const MAX_OUTLINE_DEPTH = 20;

/** 单个分段：正整数字面量，且不含前导零（`0`/`01` 都非法）。 */
const OUTLINE_SEGMENT_PATTERN = /^[1-9][0-9]*$/u;

/**
 * 校验 `outlineNumber` 的**书写形式**（`1` / `1.2` / `1.2.3`）。
 *
 * **不含深度判定**——深度超限由 `TREE_DEPTH_EXCEEDED` 单独报告。
 * 两者必须分开：把它们混在一起会让"层级太深"被误报成"编号形式非法"，
 * 而这两种问题的修复动作完全不同（拆层 vs 改字符串）。
 */
export function isValidOutlineNumber(value: string): boolean {
  if (value === '' || value.length > 200) {
    return false;
  }
  return value.split(OUTLINE_SEPARATOR).every((segment) => OUTLINE_SEGMENT_PATTERN.test(segment));
}

/** 编号深度（段数）；**形式非法**时返回 0（深度只对合法形式有意义）。 */
export function outlineDepth(value: string): number {
  return value === '' ? 0 : value.split(OUTLINE_SEPARATOR).length;
}

/** 校验并抛错（供调用方在构造自己的文档时尽早失败）。 */
export function assertOutlineNumber(value: string): string {
  if (!isValidOutlineNumber(value)) {
    throw new RangeError(
      `非法 WBS 编号：${JSON.stringify(value)}（要求 \`1\`/\`1.2\`/\`1.2.3\`，深度 ≤ ${String(MAX_OUTLINE_DEPTH)}）`,
    );
  }
  return value;
}

/** 编号的父编号（`1.2.3` → `1.2`；顶层返回 `null`）。 */
export function parentOutlineNumber(value: string): string | null {
  const index = value.lastIndexOf(OUTLINE_SEPARATOR);
  return index <= 0 ? null : value.slice(0, index);
}

// ---------------------------------------------------------------- 树

/** 树节点：只有子节点列表是可变的（构建期间的局部累加）。 */
export interface TaskTreeNode<T extends TaskHierarchyInput> {
  readonly task: T;
  readonly depth: number;
  readonly children: TaskTreeNode<T>[];
}

/** 扁平任务表 → 森林（顶层节点按文档序）。**调用方应先用 `validateHierarchy` 确认无环。** */
export function buildTaskTree<T extends TaskHierarchyInput>(tasks: readonly T[]): readonly TaskTreeNode<T>[] {
  const nodes = new Map<string, TaskTreeNode<T>>();
  for (const task of tasks) {
    if (!nodes.has(task.id)) {
      nodes.set(task.id, { task, depth: 0, children: [] });
    }
  }

  const roots: TaskTreeNode<T>[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id);
    if (node === undefined) {
      continue;
    }
    const parent = task.parentId === null ? undefined : nodes.get(task.parentId);
    if (parent === undefined || parent === node) {
      // 悬空 `parentId` 与自环都按根处理——这样即便文档脏，树仍可构建（诊断已由校验给出）。
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const assignDepth = (node: TaskTreeNode<T>, depth: number): void => {
    (node as { depth: number }).depth = depth;
    for (const child of node.children) {
      assignDepth(child, depth + 1);
    }
  };
  for (const root of roots) {
    assignDepth(root, 0);
  }

  return roots;
}

/** 森林 → 扁平表（深度优先、文档序的相对顺序不变）。 */
export function flattenTaskTree<T extends TaskHierarchyInput>(
  roots: readonly TaskTreeNode<T>[],
): readonly T[] {
  const out: T[] = [];
  const walk = (nodes: readonly TaskTreeNode<T>[]): void => {
    for (const node of nodes) {
      out.push(node.task);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** 汇总任务判定（有子节点即汇总）；依据 `parentId` 关系，不依赖编号。 */
export function summaryTaskIds(tasks: readonly TaskHierarchyInput[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.parentId !== null) {
      ids.add(task.parentId);
    }
  }
  return ids;
}

/** 逐个计算编号（深度优先、文档序）；返回 `id → outlineNumber`。 */
export function computeOutlineNumbers(
  tasks: readonly TaskHierarchyInput[],
): ReadonlyMap<string, string> {
  const numbers = new Map<string, string>();
  const walk = (nodes: readonly TaskTreeNode<TaskHierarchyInput>[], prefix: string): void => {
    nodes.forEach((node, index) => {
      const number = prefix === '' ? String(index + 1) : `${prefix}${OUTLINE_SEPARATOR}${String(index + 1)}`;
      numbers.set(node.task.id, number);
      walk(node.children, number);
    });
  };
  walk(buildTaskTree(tasks), '');
  return numbers;
}

/**
 * 逐层 `parentId` 扫描的**独立**编号实现（互证用）。
 *
 * 与 `computeOutlineNumbers` 只共享"兄弟顺序 = 文档序"这一条口径，不共享任何遍历算法——
 * 否则互证就是恒真式。它与遍历版必须逐项一致（见 `wbs.spec.ts`）。
 */
export function computeOutlineNumbersByScan(
  tasks: readonly TaskHierarchyInput[],
): ReadonlyMap<string, string> {
  const childrenOf = new Map<string | null, string[]>();
  const known = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    const key = task.parentId !== null && known.has(task.parentId) && task.parentId !== task.id
      ? task.parentId
      : null;
    const bucket = childrenOf.get(key);
    if (bucket === undefined) {
      childrenOf.set(key, [task.id]);
    } else {
      bucket.push(task.id);
    }
  }

  const numbers = new Map<string, string>();
  const walk = (parentId: string | null, prefix: string): void => {
    for (const [index, childId] of (childrenOf.get(parentId) ?? []).entries()) {
      const number = prefix === '' ? String(index + 1) : `${prefix}${OUTLINE_SEPARATOR}${String(index + 1)}`;
      numbers.set(childId, number);
      walk(childId, number);
    }
  };
  walk(null, '');
  return numbers;
}

// ---------------------------------------------------------------- 诊断（供 schema.ts 调用）

function push(
  diagnostics: DiagnosticLike[],
  code: string,
  severity: DiagnosticLike['severity'],
  message: string,
  path?: string,
  taskId?: string,
): void {
  diagnostics.push({
    code,
    severity,
    message,
    ...(path === undefined ? {} : { path }),
    ...(taskId === undefined ? {} : { taskId }),
  });
}

/** 任务集合的形状检查（重复 id 归这里，因为它需要看到全集合）。 */
export function validateTasksShape(diagnostics: DiagnosticLike[], tasks: readonly TaskHierarchyInput[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      push(diagnostics, 'TASK_DUPLICATE_ID', 'error', `任务 id 重复：${task.id}`, 'tasks', task.id);
    }
    seen.add(task.id);
  }
}

/**
 * 层级不变量：`parentId` 存在性、无环、编号合法/唯一/与层级自洽。
 *
 * 编号的"自洽"以 `computeOutlineNumbers`（遍历实现）为期望值，
 * 并用 `computeOutlineNumbersByScan` 交叉验证——两者不一致视为内部不变量被破坏（`DEV` 级断言）。
 */
export function validateHierarchy(diagnostics: DiagnosticLike[], tasks: readonly TaskHierarchyInput[]): void {
  const byId = new Map<string, TaskHierarchyInput>();
  for (const task of tasks) {
    if (!byId.has(task.id)) {
      byId.set(task.id, task);
    }
  }

  // 1. parentId 存在性 + 自环
  for (const task of tasks) {
    if (task.parentId === null) {
      continue;
    }
    if (task.parentId === task.id) {
      push(diagnostics, 'TREE_CYCLE', 'error', `任务 ${task.id} 的 \`parentId\` 指向自身`, 'tasks', task.id);
      continue;
    }
    if (!byId.has(task.parentId)) {
      push(
        diagnostics,
        'TREE_PARENT_MISSING',
        'error',
        `任务 ${task.id} 的 \`parentId\` = ${JSON.stringify(task.parentId)} 不存在`,
        'tasks',
        task.id,
      );
    }
  }

  const hasParentProblem = diagnostics.some(
    (entry) =>
      (entry.code === 'TREE_PARENT_MISSING' || entry.code === 'TREE_CYCLE') &&
      entry.severity === 'error',
  );
  if (hasParentProblem) {
    // 父子关系不可信时，编号必然不可信：不再产生级联噪声。
    return;
  }

  // 2. 无环：沿 parentId 上溯，步数超过任务数即说明成环
  const reportedCycle = new Set<string>();
  for (const task of tasks) {
    const seen = new Set<string>([task.id]);
    let cursor: string | null = task.parentId;
    let steps = 0;
    while (cursor !== null && steps <= tasks.length) {
      if (seen.has(cursor)) {
        if (!reportedCycle.has(cursor)) {
          reportedCycle.add(cursor);
          push(
            diagnostics,
            'TREE_CYCLE',
            'error',
            `层级成环：${[...seen].join(' → ')} → ${cursor}`,
            'tasks',
            task.id,
          );
        }
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
      steps += 1;
    }
  }
  if (reportedCycle.size > 0) {
    return;
  }

  // 3. 编号：与遍历实现互证，再检查自洽 / 唯一 / 深度
  const computed = computeOutlineNumbers(tasks);
  const scanned = computeOutlineNumbersByScan(tasks);
  for (const task of tasks) {
    if (computed.get(task.id) !== scanned.get(task.id)) {
      push(
        diagnostics,
        'TREE_OUTLINE_STALE',
        'error',
        `内部不变量被破坏：两套编号实现给出不同结果（${String(computed.get(task.id))} vs ${String(scanned.get(task.id))}）`,
        'tasks',
        task.id,
      );
    }
  }

  const seenNumbers = new Map<string, string>();
  for (const task of tasks) {
    const expected = computed.get(task.id);
    const owner = seenNumbers.get(task.outlineNumber);
    if (owner !== undefined) {
      push(
        diagnostics,
        'TREE_OUTLINE_NOT_UNIQUE',
        'error',
        `\`outlineNumber\` 重复：${task.outlineNumber}（${owner} 与 ${task.id}）`,
        'tasks',
        task.id,
      );
    } else {
      seenNumbers.set(task.outlineNumber, task.id);
    }

    // 三个判定**互相独立**：任一条不得因为前一条已报错而被跳过
    // （否则"深度超限且编号不符"这种形状只会报出其中一条）。
    if (task.outlineNumber === '') {
      push(
        diagnostics,
        'TREE_OUTLINE_STALE',
        'error',
        `任务 ${task.id} 缺少 \`outlineNumber\`（期望 ${String(expected)}）；用 reindexDocument() 修复`,
        'tasks',
        task.id,
      );
      continue;
    }

    if (!isValidOutlineNumber(task.outlineNumber)) {
      push(
        diagnostics,
        'TREE_OUTLINE_STALE',
        'error',
        `任务 ${task.id} 的 \`outlineNumber\` = ${JSON.stringify(task.outlineNumber)} 形式非法`,
        'tasks',
        task.id,
      );
      continue;
    }

    if (outlineDepth(task.outlineNumber) > MAX_OUTLINE_DEPTH) {
      push(
        diagnostics,
        'TREE_DEPTH_EXCEEDED',
        'error',
        `任务 ${task.id} 的层级深度 ${String(outlineDepth(task.outlineNumber))} 超过上限 ${String(MAX_OUTLINE_DEPTH)}`,
        'tasks',
        task.id,
      );
    }

    if (expected !== undefined && task.outlineNumber !== expected) {
      push(
        diagnostics,
        'TREE_OUTLINE_STALE',
        'error',
        `任务 ${task.id} 的 \`outlineNumber\` = ${task.outlineNumber} 与层级不符（期望 ${expected}）`,
        'tasks',
        task.id,
      );
    }
  }
}

// ---------------------------------------------------------------- 调级操作

/** 调级失败码（正常交互的结果，不是异常）。 */
export type WbsFailureCode =
  | 'WBS_TASK_NOT_FOUND'
  | 'WBS_NO_PREVIOUS_SIBLING'
  | 'WBS_ALREADY_AT_ROOT'
  | 'WBS_TARGET_NOT_FOUND'
  | 'WBS_TARGET_INDEX_OUT_OF_RANGE'
  | 'WBS_CYCLE'
  | 'WBS_DEPTH_EXCEEDED'
  | 'WBS_SAME_POSITION';

/** 调级结果（判别联合，便于调用方穷尽处理）。 */
export type WbsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WbsFailureCode; readonly message: string };

function fail<T>(code: WbsFailureCode, message: string): WbsResult<T> {
  return { ok: false, code, message };
}

/**
 * 移动目标：移动到 `parentId`（`null` = 顶层）之下。
 *
 * 落点有两种等价表述，二选一：
 * - `index`：同级第几位（0 基，坐标系是"移除被移动子树之后"的同级列表）；
 * - `afterTaskId`：插到该任务的**整棵子树之后**——调级（Tab/Shift+Tab）走这一条，
 *   因为它天然满足「父节点先于子节点」且"成为最后一个子节点"的直觉成立。
 */
export interface WbsMoveTarget {
  readonly parentId: string | null;
  readonly index?: number;
  readonly afterTaskId?: string;
}

/**
 * 调级操作的**纯函数实现基座**：按 `target` 重排文档序，然后重编号。
 *
 * 之所以用"重排文档序 + 重编号"而不是"改 `parentId` 后原地重编号"：
 * 兄弟顺序 = 文档序是本块的冻结口径，因此一次移动必须同时决定**父节点与次序**；
 * 只改 `parentId` 会让被移动节点落在原文档序的位置上，与"拖到目标位置"的直觉不符。
 */
function applyMove<T extends TaskHierarchyInput>(
  tasks: readonly T[],
  id: string,
  target: WbsMoveTarget,
): WbsResult<readonly T[]> {
  const moving = tasks.find((task) => task.id === id);
  if (moving === undefined) {
    return fail('WBS_TASK_NOT_FOUND', `任务不存在：${id}`);
  }
  if (target.parentId !== null && !tasks.some((task) => task.id === target.parentId)) {
    return fail('WBS_TARGET_NOT_FOUND', `目标父任务不存在：${target.parentId}`);
  }
  if (target.afterTaskId !== undefined && !tasks.some((task) => task.id === target.afterTaskId)) {
    return fail('WBS_TARGET_NOT_FOUND', `落点任务不存在：${target.afterTaskId}`);
  }
  const index = target.index ?? 0;
  if (target.afterTaskId === undefined && (!Number.isInteger(index) || index < 0)) {
    return fail('WBS_TARGET_INDEX_OUT_OF_RANGE', `目标位置必须是非负整数，收到 ${String(index)}`);
  }
  if (target.parentId === id) {
    return fail('WBS_CYCLE', '不能把任务移动到自身之下');
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));

  // 1. 收起被移动任务的**整棵子树**（文档序上是连续的一段）。
  //
  // 这一步是必须的：只移动任务本身会破坏「父节点先于其子节点出现在文档序中」这一不变量
  // （把父节点挪到后面，它的子节点就落到了前面），而该不变量正是"兄弟顺序 = 文档序"
  // 与编号算法共同的前提。移走整棵子树则**天然保持**父子关系（子树内部关系不变），
  // 唯一变化的只有子树根节点的 `parentId`。
  const subtree = new Set<string>([id]);
  for (let index = 0; index < tasks.length; index += 1) {
    const candidate = tasks[index];
    if (candidate !== undefined && candidate.parentId !== null && subtree.has(candidate.parentId)) {
      subtree.add(candidate.id);
    }
  }
  if (target.parentId !== null && subtree.has(target.parentId)) {
    return fail('WBS_CYCLE', `不能把任务移动到它的后代 ${target.parentId} 之下`);
  }

  const block = tasks.filter((task) => subtree.has(task.id)) as readonly T[];
  const rest = tasks.filter((task) => !subtree.has(task.id));

  // 2. 落点的两种表述。`index` 的坐标系是「移除被移动子树之后」的同级列表——与 UI 的插入点语义一致。
  const hasAfterTask = target.afterTaskId !== undefined;
  const siblingsAfterRemoval = rest.filter((task) => task.parentId === target.parentId);
  if (!hasAfterTask && index > siblingsAfterRemoval.length) {
    return fail(
      'WBS_TARGET_INDEX_OUT_OF_RANGE',
      `目标位置 ${String(index)} 超出同级范围 0..${String(siblingsAfterRemoval.length)}`,
    );
  }

  const anchor = hasAfterTask ? undefined : siblingsAfterRemoval[index] ?? null;
  const movedRoot = { ...moving, parentId: target.parentId } as T;
  const movedBlock = [movedRoot, ...block.slice(1)] as readonly T[];

  /**
   * 把移动块插到 `referenceId` 的**整棵子树之后**，并返回插入点在 `rest` 中的下标。
   *
   * 为什么是"整棵子树之后"而不是"紧接其后"：块必须落在目标子树**内部**，
   * 否则会破坏两件事——① 「父节点先于子节点出现在文档序」的不变量；
   * ② 「最后一个子节点」的直觉（目标父任务已有的子节点应当仍排在前面）。
   * 参考节点不存在时退化为插入到最前。
   */
  const insertAfterSubtree = (referenceId: string): number => {
    const targetSubtree = new Set<string>([referenceId]);
    for (let index = 0; index < rest.length; index += 1) {
      const candidate = rest[index];
      if (candidate !== undefined && candidate.parentId !== null && targetSubtree.has(candidate.parentId)) {
        targetSubtree.add(candidate.id);
      }
    }
    let lastIndex = -1;
    rest.forEach((task, index) => {
      if (targetSubtree.has(task.id)) {
        lastIndex = index;
      }
    });
    return lastIndex >= 0 ? lastIndex + 1 : 0;
  };

  // 3. 求插入点。
  //    - `afterTaskId`：插到该任务的**整棵子树之后**（调级走这条，语义最稳）；
  //    - `index` 且非末尾：插到该同级任务之前（UI 拖拽落点）；
  //    - `index` 且落在末尾：不能按同级列表定位——当目标父任务位于被移动子树的
  //      **文档序之后**时，移除子树会让目标父任务前移，从而把结果插到错误的一侧。
  //      因此以"目标子树之后"表述，它在「兄弟顺序 = 文档序」下等价于"成为最后一个子节点"。
  let insertAt: number;
  if (target.afterTaskId !== undefined) {
    insertAt = insertAfterSubtree(target.afterTaskId);
  } else if (anchor !== null && anchor !== undefined) {
    insertAt = rest.findIndex((task) => task.id === anchor.id);
  } else if (target.parentId === null) {
    const lastRoot = siblingsAfterRemoval[siblingsAfterRemoval.length - 1];
    insertAt = lastRoot === undefined ? 0 : rest.findIndex((task) => task.id === lastRoot.id) + 1;
  } else {
    insertAt = insertAfterSubtree(target.parentId);
  }
  if (insertAt < 0) {
    insertAt = rest.length;
  }

  // 4. 无操作判定（UI 据此跳过撤销栈压入）：**同一父节点且结果序列与现状逐项相同**。
  //    与其推算"原位"的坐标（`index` 的坐标系相差一格，极易写出恒真或恒假的判据），
  //    不如把结果序列建出来直接比——"移动前后完全一样"最朴素也最不会错的定义。
  const proposed = [...rest.slice(0, insertAt), ...movedBlock, ...rest.slice(insertAt)];
  if (moving.parentId === target.parentId) {
    const unchanged = proposed.every((entry, index) => tasks[index]?.id === entry.id);
    if (unchanged) {
      return fail('WBS_SAME_POSITION', '移动前后位置相同');
    }
  }

  // 5. 兜底断言：父节点必须早于其子节点（不变量被破坏说明算法有 bug，宁可显式失败）。
  const seen = new Set<string>();
  for (const entry of proposed) {
    if (entry.parentId !== null && byId.has(entry.parentId) && !seen.has(entry.parentId)) {
      return fail('WBS_CYCLE', `内部不变量被破坏：${entry.id} 出现在其父节点之前`);
    }
    seen.add(entry.id);
  }

  return { ok: true, value: proposed };
}

/**
 * 调级操作的**内部**重排基座：不做深度守卫（由 `indent`/`outdent`/`moveTask` 统一收口）。
 *
 * "插到 `afterId` 的整棵子树之后"是本文件表达调级落点的**首选**措辞：
 * 位置型（`index`）语义在"移动块 + 子树"下极易算错一格，子树型则天然满足
 * 「父节点先于子节点」的不变量与"最后一个子节点"的直觉。
 */
function applyMoveAfter<T extends TaskHierarchyInput>(
  tasks: readonly T[],
  id: string,
  parentId: string | null,
  afterId: string,
): WbsResult<readonly T[]> {
  return applyMove(tasks, id, { parentId, afterTaskId: afterId });
}

/** 重编号（就地返回新数组；不改变顺序与 `parentId`）。 */
export function reindexTasks<T extends TaskHierarchyInput>(tasks: readonly T[]): readonly T[] {
  const numbers = computeOutlineNumbers(tasks);
  return tasks.map((task) => {
    const expected = numbers.get(task.id);
    if (expected === undefined || task.outlineNumber === expected) {
      return task;
    }
    return { ...task, outlineNumber: expected };
  });
}

/**
 * Tab：成为**前一个兄弟**的最后一个子节点。
 *
 * 已经是前一个兄弟的子节点时返回 `WBS_SAME_POSITION`（无操作，UI 据此跳过撤销栈压入）。
 */
export function indentTask<T extends TaskHierarchyInput>(
  tasks: readonly T[],
  id: string,
): WbsResult<readonly T[]> {
  const moving = tasks.find((task) => task.id === id);
  if (moving === undefined) {
    return fail('WBS_TASK_NOT_FOUND', `任务不存在：${id}`);
  }
  const siblings = tasks.filter((task) => task.parentId === moving.parentId);
  const position = siblings.findIndex((task) => task.id === id);
  if (position <= 0) {
    // 没有前一个同级任务。若它已经是某个任务的全部子节点，那它在"没有兄弟"这件事上
    // 已经到位了——这种情况报 `WBS_SAME_POSITION`（无操作）比报"没有前一个同级任务"更准确，
    // 否则 UI 会把一次正常的无操作降级显示成失败。
    if (moving.parentId !== null && siblings.length === 1) {
      return fail('WBS_SAME_POSITION', '任务已是其父节点的唯一子节点（Tab 降级无操作）');
    }
    return fail('WBS_NO_PREVIOUS_SIBLING', '没有前一个同级任务可作父节点（Tab 降级失败）');
  }
  const previous = siblings[position - 1];
  if (previous === undefined) {
    return fail('WBS_NO_PREVIOUS_SIBLING', '没有前一个同级任务可作父节点（Tab 降级失败）');
  }
  if (moving.parentId === previous.id) {
    return fail('WBS_SAME_POSITION', '任务已是前一个同级任务的子节点（无操作）');
  }

  // 落点 = 前一个兄弟的**整棵子树之后** → 成为它的最后一个子节点。
  const result = applyMoveAfter(tasks, id, previous.id, previous.id);
  if (!result.ok) {
    return result;
  }
  return guardDepth(result.value, id);
}

/**
 * Shift+Tab：移到**父节点的下一个兄弟位置**（顶层任务不可再升级）。
 *
 * 已经紧跟父节点时返回 `WBS_SAME_POSITION`（无操作）。
 */
export function outdentTask<T extends TaskHierarchyInput>(
  tasks: readonly T[],
  id: string,
): WbsResult<readonly T[]> {
  const moving = tasks.find((task) => task.id === id);
  if (moving === undefined) {
    return fail('WBS_TASK_NOT_FOUND', `任务不存在：${id}`);
  }
  if (moving.parentId === null) {
    return fail('WBS_ALREADY_AT_ROOT', '任务已在顶层，无法再升级（Shift+Tab 升级失败）');
  }
  const parent = tasks.find((task) => task.id === moving.parentId);
  if (parent === undefined) {
    return fail('WBS_TARGET_NOT_FOUND', `父任务不存在：${moving.parentId}`);
  }

  // 落点 = **原父任务的整棵子树之后**：这样任务在文档序里落在原父节点的最后一个后代之后，
  // 即"紧邻原父任务之下"的位置——既保持了「父节点先于子节点」的不变量，
  // 也让"升级后紧跟在原父节点后面"的直觉成立（原父节点的其他子节点仍排在前面）。
  //
  // 注意：这里**不能**用"已是父节点的第一个子节点"来提前判无操作——
  // 它是父节点的唯一子节点时也满足该条件，而那正是最典型的一次升级。
  // 无操作判定由 applyMove 统一负责（比较结果序列与现状）。
  const result = applyMoveAfter(tasks, id, parent.parentId, parent.id);
  if (!result.ok) {
    return result;
  }
  return guardDepth(result.value, id);
}

/** 跨层级移动（拖拽落地）。 */
export function moveTask<T extends TaskHierarchyInput>(
  tasks: readonly T[],
  id: string,
  target: WbsMoveTarget,
): WbsResult<readonly T[]> {
  const result = applyMove(tasks, id, target);
  if (!result.ok) {
    return result;
  }
  return guardDepth(result.value, id);
}

/** 深度守卫：调级不得让被移动节点及其子树超过深度上限。 */
function guardDepth<T extends TaskHierarchyInput>(
  tasks: readonly T[],
  id: string,
): WbsResult<readonly T[]> {
  const moving = tasks.find((task) => task.id === id);
  if (moving === undefined) {
    return fail('WBS_TASK_NOT_FOUND', `任务不存在：${id}`);
  }
  const ownDepth = depthOf(tasks, id);
  if (ownDepth > MAX_OUTLINE_DEPTH) {
    return fail(
      'WBS_DEPTH_EXCEEDED',
      `任务 ${id} 的层级深度 ${String(ownDepth)} 超过上限 ${String(MAX_OUTLINE_DEPTH)}`,
    );
  }

  const childrenOf = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId !== null && task.parentId !== task.id) {
      const bucket = childrenOf.get(task.parentId);
      if (bucket === undefined) {
        childrenOf.set(task.parentId, [task.id]);
      } else {
        bucket.push(task.id);
      }
    }
  }

  const stack: { readonly id: string; readonly depth: number }[] = [
    { id, depth: ownDepth + 1 },
  ];
  const visited = new Set<string>([id]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > MAX_OUTLINE_DEPTH) {
      return fail(
        'WBS_DEPTH_EXCEEDED',
        `调级后层级深度 ${String(current.depth)} 超过上限 ${String(MAX_OUTLINE_DEPTH)}（任务 ${current.id}）`,
      );
    }
    for (const childId of childrenOf.get(current.id) ?? []) {
      if (!visited.has(childId)) {
        visited.add(childId);
        stack.push({ id: childId, depth: current.depth + 1 });
      }
    }
  }

  return { ok: true, value: reindexTasks(tasks) };
}

/**
 * 每个节点的深度（0 基）：沿 `parentId` 上溯逐跳计数，**非递归**。
 *
 * 悬空 `parentId`、自环与成环都按 0 处理（诊断由 `validateHierarchy` 给出）——
 * 这里只保证不因脏数据陷入死循环或是爆栈。
 */
export function computeDepths(tasks: readonly TaskHierarchyInput[]): ReadonlyMap<string, number> {
  const depths = new Map<string, number>();
  for (const task of tasks) {
    depths.set(task.id, depthOf(tasks, task.id));
  }
  return depths;
}

function depthOf(tasks: readonly TaskHierarchyInput[], id: string): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const walked = new Set<string>([id]);
  const start = byId.get(id);
  if (start === undefined) {
    return 0;
  }
  let cursor = start.parentId;
  let depth = 0;
  while (cursor !== null) {
    if (walked.has(cursor)) {
      return 0; // 自环或成环：按根处理
    }
    walked.add(cursor);
    const parent = byId.get(cursor);
    if (parent === undefined) {
      return 0; // 悬空 parentId：按根处理
    }
    depth += 1;
    cursor = parent.parentId;
  }
  return depth;
}
