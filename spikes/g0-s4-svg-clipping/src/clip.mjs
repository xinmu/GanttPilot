/**
 * 裁剪（ADR 0007 §6 的四条裁减契约）。**纯函数、零 DOM**，Node 与浏览器共用同一份。
 *
 * 本模块刻意只做"选哪些行 / 选哪些边"，不做任何几何计算——这正是 §6.5
 * 「**裁剪先于几何计算**」的可执行形式：调用方先把窗口筛出来，再算 path 与坐标。
 *
 * ## 两处必须一起读的口径
 *
 * 1. **"可见行窗口"= §6.1 的渲染窗口（可见行 + 上下 `ROW_BUFFER` 行）**。
 *    §6.2 写的是"边所跨行区间 ∩ **可见行窗口**"，而 §6.1 已经定义渲染行 = 可见行 + 缓冲；
 *    若把 §6.2 的窗口读成"不含缓冲的可见行"，则缓冲行内出现的边会被漏画——与 §6.1 自相矛盾。
 *    本实验按"渲染窗口"实现，并把这一读法写进结论（属于口径澄清，不是契约变更）。
 * 2. **折叠隐藏的行不画其边**（§6.3）**由同一遍求交自然完成**：隐藏行没有可见行序号，
 *    端点映射为 `-1` ⇒ 该边被排除，不需要第二条规则。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').DocumentLink} DocumentLink
 * @typedef {import('./manifest.mjs').ClipMode} ClipMode
 */

/**
 * 可见行序列 = 树序（文档序，父先于子）经折叠过滤后的子序列（ADR 0007 §4）。
 *
 * 返回的是**文档序索引**的数组（`document.tasks` 的下标），不是任务 id——
 * `Schedule` 的数组按文档序索引，渲染层负责这次映射（§4 明确要求"不改变 `Schedule` 的索引约定"）。
 *
 * @param {ProjectDocument} document
 * @returns {readonly number[]}
 */
export function visibleRowOrder(document) {
  const tasks = document.tasks;
  /** @type {Map<string | null, number[]>} */
  const childrenOf = new Map();
  for (let index = 0; index < tasks.length; index += 1) {
    const parentId = tasks[index]?.parentId ?? null;
    const bucket = childrenOf.get(parentId);
    if (bucket === undefined) childrenOf.set(parentId, [index]);
    else bucket.push(index);
  }
  /** @type {number[]} */
  const order = [];
  /** @param {string | null} parentId */
  const walk = (parentId) => {
    for (const index of childrenOf.get(parentId) ?? []) {
      order.push(index);
      const task = tasks[index];
      if (task !== undefined && task.collapsed) continue; // 折叠 ⇒ 整棵子树不进可见行
      walk(task?.id ?? null);
    }
  };
  walk(null);
  return order;
}

/**
 * 文档序索引 → 可见行序号（`-1` = 不可见/被折叠隐藏）。
 * @param {readonly number[]} order
 * @param {number} taskCount
 */
export function rowIndexOfOrder(order, taskCount) {
  const map = new Int32Array(taskCount).fill(-1);
  for (let row = 0; row < order.length; row += 1) {
    const docIndex = order[row];
    if (docIndex !== undefined) map[docIndex] = row;
  }
  return map;
}

/**
 * 可见窗口与渲染窗口（行序号）。
 * @param {{ first: number, visibleLast: number, renderFirst: number, renderLast: number }} args
 */
export function computeWindows({ first, visibleLast, renderFirst, renderLast }) {
  return { first, visibleLast, renderFirst, renderLast };
}

/**
 * 行窗口：可见行 + 上下各 `rowBuffer`（ADR 0007 §6.1）。
 * @param {{ rowCount: number, scrollTop: number, height: number, rowHeight: number, rowBuffer: number }} args
 */
export function rowWindow({ rowCount, scrollTop, height, rowHeight, rowBuffer }) {
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visibleCount = Math.max(1, Math.ceil(height / rowHeight));
  const visibleLast = Math.min(rowCount - 1, firstVisible + visibleCount - 1);
  const renderFirst = Math.max(0, firstVisible - rowBuffer);
  const renderLast = Math.min(rowCount - 1, visibleLast + rowBuffer);
  return { firstVisible, visibleLast, renderFirst, renderLast, rowCount };
}

/**
 * 文档序索引 → 该行是否被渲染（行窗口内）。
 * @param {Int32Array} rowOfDocIndex
 * @param {number} renderFirst
 * @param {number} renderLast
 * @param {number} docIndex
 */
export function isRenderedRow(rowOfDocIndex, renderFirst, renderLast, docIndex) {
  const row = rowOfDocIndex[docIndex];
  return row !== undefined && row >= renderFirst && row <= renderLast;
}

/**
 * 边窗口裁剪：**「边所跨行区间 ∩ 渲染窗口」求交**（ADR 0007 §6.2）。
 *
 * 与"端点可见性裁剪"的差别就是 S4-b 要量化的那个差别：跨屏长边的两端都不在窗口里，
 * 但它的**区间**穿过窗口 ⇒ 必须画。
 *
 * @param {object} args
 * @param {readonly DocumentLink[]} args.links
 * @param {ReadonlyMap<string, number>} args.docIndexOfTask
 * @param {Int32Array} args.rowOfDocIndex
 * @param {number} args.renderFirst
 * @param {number} args.renderLast
 * @param {number} args.visibleFirst
 * @param {number} args.visibleLast
 * @param {ClipMode} args.mode
 * @returns {{ ids: readonly number[], spanning: readonly number[], hidden: readonly number[], byEndpoints: readonly number[] }}
 */
export function selectEdges({
  links,
  docIndexOfTask,
  rowOfDocIndex,
  renderFirst,
  renderLast,
  visibleFirst,
  visibleLast,
  mode,
}) {
  /** @type {number[]} */
  const ids = [];
  /** @type {number[]} */
  const spanning = [];
  /** @type {number[]} */
  const hidden = [];
  /** @type {number[]} */
  const byEndpoints = [];
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) continue;
    const fromDoc = docIndexOfTask.get(link.from);
    const toDoc = docIndexOfTask.get(link.to);
    if (fromDoc === undefined || toDoc === undefined) {
      hidden.push(index);
      continue;
    }
    const fromRow = rowOfDocIndex[fromDoc] ?? -1;
    const toRow = rowOfDocIndex[toDoc] ?? -1;
    if (fromRow < 0 || toRow < 0) {
      hidden.push(index);
      continue;
    }
    const low = Math.min(fromRow, toRow);
    const high = Math.max(fromRow, toRow);
    if (mode === 'none') {
      // NC2 的"关掉窗口裁剪"：可见行内的边全画（端点行必然存在，因为折叠过滤已经去掉隐藏行）。
      ids.push(index);
      continue;
    }
    if (mode === 'intersect') {
      if (low <= renderLast && high >= renderFirst) {
        ids.push(index);
        // 「跨屏长边」= 至少一个端点不在**可见**窗口内，但区间与可见窗口相交。
        const touchesVisible = low <= visibleLast && high >= visibleFirst;
        const endpointsVisible = isVisible(fromRow) && isVisible(toRow);
        if (touchesVisible && !endpointsVisible) spanning.push(index);
      }
      continue;
    }
    // 反例路径 B：仅当两端点都在可见窗口内才画（这是 T-4 点名要避免的实现）。
    if (isVisible(fromRow) && isVisible(toRow)) {
      ids.push(index);
      byEndpoints.push(index);
    }
  }
  return { ids, spanning, hidden, byEndpoints };

  /** @param {number} row */
  function isVisible(row) {
    return row >= visibleFirst && row <= visibleLast;
  }
}
