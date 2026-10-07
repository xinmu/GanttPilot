/**
 * **仓库路径的单点声明**（`scripts/` 共用）。
 *
 * 抽出来的理由（P3/C1）：`const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')`
 * 原先在 12 个脚本里各写一遍，`rel()` 有 3 份逐字相同的副本。
 *
 * 为什么单独一个文件（而不是并进 `cdp.mjs` 或 `chrome-harness.mjs`）：
 * 使用 `rel()` / `repoRoot` 的还有文档检查器（`check-docs` / `check-constants` / `make-doc-index`），
 * 让它们 import Chrome 那一套（`node:http`、收尾闸）在概念上是错的耦合。
 */

import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库相对路径（统一 `/` 分隔符；供输出与 `doc-index.json` 的条目比对）。 */
export const rel = (absolute) => relative(repoRoot, absolute).split(sep).join('/');
