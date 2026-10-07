/**
 * 交互态的高亮/标红集合（ADR 0008 §8/§9）。
 *
 * ## 为什么它**不**进 `ViewModel`
 *
 * `ViewModel` 是**几何真相源**（ADR 0007 §2 冻结形状）：它只由「文档 + `Schedule` + `Calendar` + 视口」
 * 决定，与"此刻用户正按着鼠标"无关。高亮是**交互态**——把它塞进 `ViewModel` 会让
 * "同一份文档 + 同一个视口 ⇒ 同一个 `ViewModel`"这条性质失效，进而让几何的期望值表与裁剪判据
 * 都要跟着"当前手势"漂移。
 *
 * 因此这里产出**独立的覆盖层描述**：调用方（`apps/web`）把它画在几何之上。
 * 元素预算另有常数 `c₄`（ADR 0008 §11），**不动 `c₁`/`c₂`/`c₃`**。
 */

import {
  affectedClosure,
  type ProjectDocument,
} from '@ganttpilot/engine';

/** 高亮集合：行取**文档序索引**、边取 `links` 下标。 */
export interface HighlightSet {
  readonly rows: readonly number[];
  readonly edges: readonly number[];
  /**
   * 样式键（渲染层只做映射，不自己判断该标什么）。
   *
   * **只有实际会产出的三个键**（P3/C6-g 收窄）：`cycle`（`highlightForCyclePath`）、
   * `link-preview`（`highlightForLinkEndpoints`）、`selection`（`highlightForTask` 与空集）。
   * 曾经还有第四个 `drag-conflict`——它由 `highlightForConflict` 产出，而那个投影在全仓
   * **零消费者**（冲突标红走的是应用层的 `conflictTaskIds`，不是高亮集合），已删除。
   */
  readonly styleKey: 'cycle' | 'link-preview' | 'selection';
  /** 高亮对象（任务 id / 边 id），便于调试与提示文案。 */
  readonly taskIds: readonly string[];
  readonly linkIds: readonly string[];
}

const EMPTY: HighlightSet = {
  rows: [],
  edges: [],
  styleKey: 'selection',
  taskIds: [],
  linkIds: [],
};

/** 空高亮（避免调用方到处判 `null`）。 */
export function emptyHighlight(): HighlightSet {
  return EMPTY;
}

/**
 * **成环路径** → 高亮集合（G-7 的"高亮成环路径"）。
 *
 * `path` 是 `wouldCreateCycle` / `compute` 的 `cyclePath`：`[from, …, from]`（**首尾同一 id**）。
 * 行取路径上的全部任务；边取"路径上相邻两任务之间存在的那条边"——
 * **顺序不敏感**（同一对任务若有多条边，全部高亮：用户看到的是"这条回路"，不是"某一条边"）。
 */
export function highlightForCyclePath(document: ProjectDocument, path: readonly string[]): HighlightSet {
  if (path.length < 2) return EMPTY;
  const wanted = new Set(path);
  const rows: number[] = [];
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined && wanted.has(task.id)) rows.push(index);
  }
  const edges: number[] = [];
  const linkIds: string[] = [];
  for (let index = 0; index < document.links.length; index += 1) {
    const link = document.links[index];
    if (link === undefined) continue;
    // 回路上的边：两端都在路径上（路径自身可能重复首尾，因此只要求两端都在集合里）。
    if (wanted.has(link.from) && wanted.has(link.to)) {
      edges.push(index);
      linkIds.push(link.id);
    }
  }
  return {
    rows,
    edges,
    styleKey: 'cycle',
    taskIds: [...wanted],
    linkIds,
  };
}

/**
 * 拖动期的"受影响行 + 受影响边"（ADR 0008 §11 的**渲染侧最小重建**）。
 *
 * 与 `affectedRenderSet` 的区别：它的种子是**锚点**（拖动中不写文档），
 * 而拖动行自己的几何只由锚点决定 ⇒ 拖动行必进重绘集；其余行由 `compute` 的结果决定，
 * **由调用方在拿到新 `Schedule` 之后**用 `affectedRenderSetWithAnchors` 补全。
 */
export function highlightForTask(document: ProjectDocument, taskId: string): HighlightSet {
  const rows: number[] = [];
  const edges: number[] = [];
  const linkIds: string[] = [];
  for (let index = 0; index < document.tasks.length; index += 1) {
    if (document.tasks[index]?.id === taskId) rows.push(index);
  }
  for (let index = 0; index < document.links.length; index += 1) {
    const link = document.links[index];
    if (link === undefined) continue;
    if (link.from === taskId || link.to === taskId) {
      edges.push(index);
      linkIds.push(link.id);
    }
  }
  return { rows, edges, styleKey: 'selection', taskIds: [taskId], linkIds };
}

/** 建线预览的两个端点 → 高亮集合（两端行 + 与两端相关的边）。 */
export function highlightForLinkEndpoints(
  document: ProjectDocument,
  fromTaskId: string,
  toTaskId: string | null,
): HighlightSet {
  const ids = toTaskId === null ? [fromTaskId] : [fromTaskId, toTaskId];
  const wanted = new Set(ids);
  const rows: number[] = [];
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task !== undefined && wanted.has(task.id)) rows.push(index);
  }
  const edges: number[] = [];
  const linkIds: string[] = [];
  for (let index = 0; index < document.links.length; index += 1) {
    const link = document.links[index];
    if (link === undefined) continue;
    if (wanted.has(link.from) || wanted.has(link.to)) {
      edges.push(index);
      linkIds.push(link.id);
    }
  }
  return { rows, edges, styleKey: 'link-preview', taskIds: ids, linkIds };
}

/**
 * **锚点版**的受影响渲染集（拖动期与松手后共用）。
 *
 * `affectedClosure` 沿出边取后继闭包（不含祖先），因此这里同样沿 `parentId` 补祖先链
 * （与 `affectedRenderSet` 同一边界，[SCHEDULE.md](../../engine/SCHEDULE.md) §八 已声明它是已知边界）。
 * 差别只在**种子来源**：拖动期的位置来自锚点，而不是文档字段里已经写好的值。
 */
export function affectedRenderSetWithAnchors(
  document: ProjectDocument,
  anchors: readonly { readonly taskId: string }[],
): { readonly rows: readonly number[]; readonly edges: readonly number[]; readonly seeds: readonly string[] } {
  const seeds = [...new Set(anchors.map((anchor) => anchor.taskId))];
  if (seeds.length === 0) return { rows: [], edges: [], seeds: [] };
  const indexOfId = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task === undefined) continue;
    indexOfId.set(task.id, index);
    parentOf.set(task.id, task.parentId);
  }
  const closure = affectedClosure(document, seeds);
  const closureSet = new Set(closure);
  const ancestors = new Set<string>();
  for (const id of closure) {
    let parent = parentOf.get(id) ?? null;
    while (parent !== null && !ancestors.has(parent) && !closureSet.has(parent)) {
      ancestors.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
  }
  const rowSet = new Set<number>();
  for (const id of [...closure, ...ancestors]) {
    const index = indexOfId.get(id);
    if (index !== undefined) rowSet.add(index);
  }
  const rows = [...rowSet].sort((left, right) => left - right);
  const rowsAsSet = new Set(rows);
  const edges: number[] = [];
  for (let index = 0; index < document.links.length; index += 1) {
    const link = document.links[index];
    if (link === undefined) continue;
    const from = indexOfId.get(link.from);
    const to = indexOfId.get(link.to);
    if (from === undefined || to === undefined) continue;
    if (rowsAsSet.has(from) || rowsAsSet.has(to)) edges.push(index);
  }
  return { rows, edges, seeds };
}
