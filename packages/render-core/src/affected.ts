/**
 * "受影响行 + 受影响边"的最小重建集（ADR 0007 §8 的可执行形式）。
 *
 * ## 为什么它必须存在
 *
 * G4 的出口条件之一是"**行内编辑不破坏虚拟化与裁剪**（只走 `task.update`；
 * 走'受影响行 + 受影响边'路径，**不触发整表重建**）"。这条不能靠肉眼，必须是一个
 * **纯函数判据**：编辑哪个任务，重绘哪些行与哪些边——由本模块回答。
 *
 * ## 边界（SCHEDULE.md §八 已声明，不是遗漏）
 *
 * 引擎的 `affectedClosure()` 沿**全部出边**取后继闭包，**不含祖先**；
 * 而汇总条的几何依赖整棵子树，所以祖先链必须由调用方**沿 `parentId` 自行补上**。
 * 本模块把这两步合并成一个入口，避免 `apps/web` 与 G5 各自写一份。
 *
 * ## 一步的粒度
 *
 * 只算"可画的行集"：折叠隐藏的行、空汇总、以及 `Schedule` 里没有序号的行都不入选
 * （它们本来就不渲染）。**边的判据是"任一端点受影响"**——边的几何只由两端点的条决定。
 */

import { affectedClosure, type ProjectDocument } from '@ganttpilot/engine';

/** 一次编辑之后需要重绘的行与边。 */
export interface AffectedRenderSet {
  /** 需要重绘的任务（**文档序索引**，升序、去重）。 */
  readonly rows: readonly number[];
  /** 需要重绘的边（**`document.links` 下标**，升序、去重）。 */
  readonly edges: readonly number[];
  /** 闭包本身（**任务 id**，按文档序）——便于调试与 G5 复用。 */
  readonly closure: readonly string[];
  /** 祖先链（**任务 id**，按文档序；不含种子自身已有的祖先重复项）。 */
  readonly ancestors: readonly string[];
}

/**
 * 计算"受影响行 + 受影响边"。
 *
 * @param document 当前文档
 * @param changedTaskIds 本次编辑触碰的任务 id（一次手势可能有多个）
 */
export function affectedRenderSet(
  document: ProjectDocument,
  changedTaskIds: readonly string[],
): AffectedRenderSet {
  const tasks = document.tasks;
  const indexOfId = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (task === undefined) continue;
    indexOfId.set(task.id, index);
    parentOf.set(task.id, task.parentId);
  }

  const closure = affectedClosure(document, changedTaskIds);
  const closureSet = new Set(closure);

  // 沿 parentId 补祖先链（闭包不含祖先，见文件头）。
  const ancestors = new Set<string>();
  for (const id of closure) {
    let parent = parentOf.get(id) ?? null;
    while (parent !== null && !ancestors.has(parent) && !closureSet.has(parent)) {
      ancestors.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
  }

  const rowSet = new Set<number>();
  for (const id of closure) {
    const index = indexOfId.get(id);
    if (index !== undefined) rowSet.add(index);
  }
  for (const id of ancestors) {
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
    // 边的几何只由两端点决定：任一端点受影响 ⇒ 这条边要重画。
    if (rowsAsSet.has(from) || rowsAsSet.has(to)) edges.push(index);
  }

  return {
    rows,
    edges,
    closure,
    ancestors: [...ancestors],
  };
}
