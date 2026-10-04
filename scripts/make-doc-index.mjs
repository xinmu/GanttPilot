#!/usr/bin/env node
/**
 * 生成 `docs/01-roadmap/首版-文档索引.md`：文档集合、角色、体量与台账统计的快照。
 *
 * 为什么要有它：会话之间交接、以及把上下文注入新会话时，只需要这份索引 +
 * `docs/README.md` + `docs/00-baseline/裁决记录.md` 三份，不必整读 200 KB 的存档。
 * **本文件是生成物**（`docs/doc-index.json` 的 `generated` 字段登记了它），
 * 不手写、不含时间戳（重跑应逐字节一致）。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(readFileSync(join(repoRoot, 'docs/doc-index.json'), 'utf8'));
const rel = (absolute) => relative(repoRoot, absolute).split(sep).join('/');

const ROWS = [];
let totalKb = 0;
for (const entry of index.docs) {
  const absolute = join(repoRoot, entry.path);
  // 尚未创建的文档（首次生成前的生成物、迁移中途的文件）按缺失登记，不阻塞索引渲染。
  const missing = !existsSync(absolute);
  const kb = missing ? 0 : statSync(absolute).size / 1024;
  totalKb += kb;
  ROWS.push({ ...entry, kb, missing });
}

const ledger = readFileSync(join(repoRoot, index.register), 'utf8');
const entries = [...ledger.matchAll(/^\|\s*([DRTP]-\d+)\s*\|\s*R(\d+)\s*\|\s*([^|]*)\|\s*(有效|已闭|取代|未决)\s*\|/gm)].map(
  (match) => ({ id: match[1], round: match[2], conclusion: match[3].trim(), status: match[4] }),
);
const pending = readFileSync(join(repoRoot, index.pendingList), 'utf8');
const pendingCount = (pending.match(/^\|\s*`?(?:[DRTP]-\d+|—)`?\s*\|/gm) ?? []).filter((line) => !line.includes('已闭')).length;

const byRole = new Map();
for (const row of ROWS) byRole.set(row.role, (byRole.get(row.role) ?? 0) + row.kb);

const lines = [
  '# 首版文档索引（生成物）',
  '',
  '> 由 `node scripts/make-doc-index.mjs` 生成；**请勿手写**（`docs/doc-index.json` 是唯一真相源）。',
  '> 会话交接与上下文注入建议只读三份：[docs/README.md](../README.md)（导航）、',
  `> [裁决记录](../00-baseline/${index.register.split('/').pop()})（台账，${entries.length} 条）、本文件。`,
  '',
  '## 一、台账现状',
  '',
  `- 条目 **${entries.length}** 条：${['有效', '已闭', '取代', '未决'].map((status) => `${status} ${entries.filter((e) => e.status === status).length}`).join(' / ')}；`,
  `- 待定清单条目 **${pendingCount}** 条（未决项的唯一住所：\`${index.pendingList}\`）。`,
  '',
  '### 未决条目',
  '',
  '| ID | 轮次 | 结论 | 细则 |',
  '|---|---|---|---|',
  ...entries
    .filter((entry) => entry.status === '未决')
    .map((entry) => `| ${entry.id} | R${entry.round} | ${entry.conclusion} | [细则](../00-baseline/裁决记录.md) |`),
  '',
  '## 二、文档集合',
  '',
  '| 文档 | 角色 | 体量 | 上限 |',
  '|---|---|---|---|',
  ...ROWS.map((row) => {
    const name = row.path.split('/').pop();
    if (row.missing) return `| ${name} | ${row.role} | （缺失） | ${index.caps[row.cap]} KB |`;
    // 本文件在 `docs/01-roadmap/` 下（相对仓库根两层）：到仓库根是 `../../`，
    // 到 `docs/` 下的其他文件是 `../../docs/<相对 docs 的路径>`（或从本目录一行 `../<...>`）。
    if (!row.path.startsWith('docs/')) return `| [${name}](../../${row.path}) | ${row.role} | ${row.kb.toFixed(1)} KB | ${index.caps[row.cap]} KB |`;
    const rest = row.path.slice('docs/'.length);
    return `| [${name}](../${rest}) | ${row.role} | ${row.kb.toFixed(1)} KB | ${index.caps[row.cap]} KB |`;
  }),
  '',
  `**合计 ${totalKb.toFixed(1)} KB**（${ROWS.length} 份）；按角色：${[...byRole.entries()]
    .map(([role, kb]) => `${role} ${kb.toFixed(0)} KB`)
    .join(' / ')}。`,
  '',
  '## 三、口径提醒',
  '',
  '- 本索引与 `doc-index.json` 由 `pnpm docs:check` 保证一致（索引 ↔ 文件集合双射、体量上限、链接与锚点）；',
  '- 记录层（`record`）是历史，**不得被当作「当前值」引用**；当前值看台账与路线图；',
  '- 浏览器侧数字是记录制（不进 `pnpm gate`），引用时必须连环境口径一起读。',
  '',
];

writeFileSync(join(repoRoot, 'docs/01-roadmap/首版-文档索引.md'), lines.join('\n'), 'utf8');
console.log(`[docs] 已刷新 docs/01-roadmap/首版-文档索引.md（${ROWS.length} 份文档 / ${totalKb.toFixed(1)} KB / 未决 ${entries.filter((e) => e.status === '未决').length} 条）`);
void rel;
