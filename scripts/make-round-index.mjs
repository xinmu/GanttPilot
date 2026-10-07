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
 * 顶层约定与 `make-doc-index.mjs` 一致：零依赖、只读输入、**不含时间戳**（重跑逐字节一致）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(readFileSync(join(repoRoot, 'docs/doc-index.json'), 'utf8'));
const TARGET = 'docs/00-baseline/轮次导读.md';

/** 中文数字 → 整数（与 `check-docs.mjs` 同口径；本仓库只用到「一」…「五十一」）。 */
function chineseNumberToInt(text) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(text)) return 10 + digits[text[1]];
  if (/^[一二三四五六七八九]十$/.test(text)) return digits[text[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(text)) return digits[text[0]] * 10 + digits[text[2]];
  return digits[text] ?? null;
}

// ① 主题 + 细则文件：从按轮次存档的 `## 第N轮…` 标题推导
const rounds = new Map();
for (const entry of index.docs.filter((doc) => doc.role === 'register-archive')) {
  const absolute = join(repoRoot, entry.path);
  if (!existsSync(absolute)) continue;
  const file = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  for (const match of readFileSync(absolute, 'utf8').matchAll(/^## 第([一二三四五六七八九十百]+)轮[：:]?\s*(.*)$/gm)) {
    const round = chineseNumberToInt(match[1]);
    if (round === null) continue;
    const topic = match[2].replace(/\s*（.*$/, '').trim();
    if (!rounds.has(round)) rounds.set(round, { topic, file });
  }
}

// ② 条目：从台账条目表的「轮次」列推导（每轮列出它定下的条目 ID）
const ledger = readFileSync(join(repoRoot, index.register), 'utf8');
const idsByRound = new Map();
for (const match of ledger.matchAll(/^\|\s*([DRTP]-\d+)\s*\|\s*R(\d+)\s*\|[^|]*\|[^|]*\|/gm)) {
  const round = Number(match[2]);
  if (!idsByRound.has(round)) idsByRound.set(round, []);
  idsByRound.get(round).push(match[1]);
}

const allRounds = [...new Set([...rounds.keys(), ...idsByRound.keys()])].sort((a, b) => a - b);
const rows = allRounds.map((round) => {
  const info = rounds.get(round);
  const ids = (idsByRound.get(round) ?? []).map((id) => `\`${id}\``).join('、') || '—';
  const topic = info?.topic ?? '（该轮无独立标题，见相邻轮的存档）';
  const detail = info ? `[细则](${info.file})` : '—';
  return `| R${String(round).padStart(2, '0')} | ${topic} | ${ids} | ${detail} |`;
});

const lines = [
  '# 轮次导读（生成物）',
  '',
  '> **生成物**：由 `node scripts/make-round-index.mjs` 从**按轮次存档的 `## 第N轮` 标题**（主题）与**台账条目表的「轮次」列**（条目）推导，',
  '> **请勿手写**——它不再是第二处真相源，因此不会再与存档/台账分叉。刷新：`pnpm docs:index`。规范见 [DOC-SPEC](../DOC-SPEC.md) §二。',
  '> 台账（[裁决记录](裁决记录.md)）仍是**唯一权威登记处**；本文件只做导读，**不承担登记职责**。',
  '',
  `| 轮次 | 主题 | 条目 | 细则 |`,
  '|---|---|---|---|',
  ...rows,
  '',
  '> 第一轮裁决（`D-1`–`D-4`）没有独立的轮次标题，其覆盖表与第二轮评估同在 [R01-02 细则](裁决R01-02.md) §一。',
  '',
];

writeFileSync(join(repoRoot, TARGET), lines.join('\n'), 'utf8');
console.log(`[docs] 已刷新 ${TARGET}（${String(rows.length)} 轮：R${String(allRounds[0]).padStart(2, '0')}–R${String(allRounds[allRounds.length - 1]).padStart(2, '0')}）`);
