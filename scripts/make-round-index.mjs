#!/usr/bin/env node
/**
 * 生成 `docs/00-baseline/轮次导读.md`：**轮次 → 主题 → 条目 → 细则**的导读表。
 *
 * 为什么把它做成生成物（v0.2/D7.5，采 A）：
 * 这张表原本手写在台账里（52 行 ≈ 7.5 KB），而它**完全可以从两处已有的真相源推导**——
 * ① 每轮的**主题**在按轮次存档的 `## 第<N>轮<主题>` 标题里（`docs:check` 的"轮次覆盖"检查保证每轮都有）；
 * ② 每轮的**条目**在台账条目表的「轮次」列里。
 * 手写一份等于第二处真相源，且它躺在**必读层**里（台账是 mustRead）。⇒ 移出为生成物：
 * 台账瘦下来，导读表不但没丢，反而再也不会与存档/台账分叉。
 *
 * P3/C7-i（登记项 `N10`，D10 实测出的代价）把渲染逻辑搬进 `doc-artifacts.mjs` 的**纯函数**，
 * 并顺手改了**输入来源**：主题 + 细则从 `docs/00-baseline/裁决R*.md` **扫盘**得到，
 * 而不是查 `doc-index.json` 的条目——索引漏登记不该让生成物静默变旧。
 * 于是 `check-docs.mjs` 能"就地重算一遍再与盘上的文件逐字节比对"；本文件只剩"写盘 + 一行日志"。
 *
 * 顶层约定与 `make-doc-index.mjs` 一致：零依赖、只读输入、**不含时间戳**（重跑逐字节一致）。
 *
 * **顺序约束（P5-c2 实测）**：`pnpm docs:index` 里本脚本**必须排在 `make-doc-index.mjs` 之前**。
 * 本脚本**自身**没有自指（输入是扫盘结果 + 台账，不含任何体量），但**它的产物体量是文档索引的输入之一**
 * （索引的「合计」与「轮次导读」那一行都按盘上体量算）⇒ 先写索引、后写轮次导读的话，**索引会在同一轮里
 * 立刻陈旧**（实测：新增一轮后 `docs:check` 报「与它的来源不一致（陈旧）」，要连跑两次才一致）。
 * 顺序倒过来则一次即到不动点（索引那侧的自指已由 C8-d 迭代到不动点）。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROUND_INDEX_TARGET, renderRoundIndex } from './doc-artifacts.mjs';
import { repoRoot } from './paths.mjs';

const rendered = renderRoundIndex();
writeFileSync(join(repoRoot, ROUND_INDEX_TARGET), rendered.text, 'utf8');
const first = String(rendered.first).padStart(2, '0');
const last = String(rendered.last).padStart(2, '0');
console.log(`[docs] 已刷新 ${ROUND_INDEX_TARGET}（${String(rendered.roundCount)} 轮：R${first}–R${last}）`);
