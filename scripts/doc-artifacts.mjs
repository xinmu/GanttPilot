/**
 * **文档生成物的渲染器**（P3/C7-i；登记项 `N10`）。
 *
 * ## 为什么要有这个文件
 *
 * 两份生成物（`docs/01-roadmap/首版-文档索引.md`、`docs/00-baseline/轮次导读.md`）此前只有
 * **生成器**、没有**检查**：它们是否与来源一致，全凭"记得跑一次 `pnpm docs:index`"。
 * D10 实测到了代价——D9 在**登记 `裁决R54.md` 之前**先跑了 `make-round-index.mjs`，于是提交里的
 * `轮次导读` 留着一行陈旧的 `R54｜（该轮无独立标题…）｜—`，而 `裁决R54.md` 就在盘上、标题也在；
 * `check-docs` 的存档覆盖检查**读的是索引**，所以它当时是绿的。
 *
 * 修法（登记里写明的两条，都在这里落地）：
 * 1. **生成器的输入来源改成盘上的文件**（轮次导读的"主题 + 细则"从 `docs/00-baseline/裁决R*.md`
 *    **扫盘**得到，而不是查 `doc-index.json` 的条目）——索引漏登记不该让生成物静默变旧；
 * 2. 渲染逻辑抽成**纯函数**，于是 `check-docs.mjs` 能"就地重算一遍再与盘上的文件逐字节比对"
 *    （见 `GENERATED_ARTIFACTS` 与 `check-docs.mjs` 的「生成物与来源一致」一节）。
 *
 * 顶层约定与两份生成器一致：零依赖、只读输入、**不含时间戳**（重跑逐字节一致）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './paths.mjs';

/** 生成物：文档索引快照（`doc-index.json` 的 `generated: true` 之一）。 */
export const DOC_INDEX_TARGET = 'docs/01-roadmap/首版-文档索引.md';

/** 生成物：轮次导读表。 */
export const ROUND_INDEX_TARGET = 'docs/00-baseline/轮次导读.md';

/**
 * 中文数字 → 整数（本仓库只用到「一」…「五十一」；`check-docs.mjs` 也用它，单点声明在这里）。
 *
 * @param {string} text
 * @returns {number | null}
 */
export function chineseNumberToInt(text) {
  /** @type {Record<string, number>} */
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  /** @param {number} index @returns {number} */
  const digit = (index) => digits[text[index] ?? ''] ?? 0;
  if (text === '十') return 10;
  // `?? 0` 的兜底在下面三条正则之下不可达（P3/C7-e 把本文件纳入 tsc 时按 `noUncheckedIndexedAccess` 补的）；
  // 保留它是为了不改写法与返回值，同时让"越界索引"这件事在类型上被处理掉。
  if (/^十[一二三四五六七八九]$/.test(text)) return 10 + digit(1);
  if (/^[一二三四五六七八九]十$/.test(text)) return digit(0) * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(text)) return digit(0) * 10 + digit(2);
  return digits[text] ?? null;
}

/** 读 `docs/doc-index.json`（每次都重读：检查器要看到**当下**的索引，而不是进程启动时的快照）。 */
function readIndex() {
  return JSON.parse(readFileSync(join(repoRoot, 'docs/doc-index.json'), 'utf8'));
}

/**
 * `首版-文档索引.md` 的内容（**纯函数**：只读 `doc-index.json` 与盘上各文档的体量）。
 *
 * 它的来源**就是** `doc-index.json`——"索引快照"这个身份决定了这一点；因此它的新鲜度守卫
 * 正是"重算一遍与盘上逐字节比对"。
 *
 * 返回值除 `text` 外还带三个读数（供 CLI 打一行日志；不参与比对）。
 */
export function renderDocIndex() {
  const index = readIndex();

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
  const entries = [
    ...ledger.matchAll(/^\|\s*([DRTP]-\d+)\s*\|\s*R(\d+)\s*\|\s*([^|]*)\|\s*(有效|已闭|取代|未决)\s*\|/gm),
  ].map((match) => ({
    id: match[1],
    round: match[2],
    conclusion: (match[3] ?? '').trim(),
    status: match[4],
  }));
  const pending = readFileSync(join(repoRoot, index.pendingList), 'utf8');
  const pendingCount = (pending.match(/^\|\s*`?(?:[DRTP]-\d+|—)`?\s*\|/gm) ?? []).filter(
    (line) => !line.includes('已闭'),
  ).length;

  const byRole = new Map();
  for (const row of ROWS) byRole.set(row.role, (byRole.get(row.role) ?? 0) + row.kb);

  const lines = [
    '# 首版文档索引（生成物）',
    '',
    '> 由 `node scripts/make-doc-index.mjs` 生成；**请勿手写**（`docs/doc-index.json` 是唯一真相源）。',
    '> 会话交接与上下文注入建议只读三份：[docs/README.md](../README.md)（导航）、',
    `> [裁决记录](../00-baseline/${index.register.slice(index.register.lastIndexOf('/') + 1)})（台账，${entries.length} 条）、本文件。`,
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
      if (!row.path.startsWith('docs/')) {
        return `| [${name}](../../${row.path}) | ${row.role} | ${row.kb.toFixed(1)} KB | ${index.caps[row.cap]} KB |`;
      }
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

  return {
    text: lines.join('\n'),
    docCount: ROWS.length,
    totalKb,
    pendingCount: entries.filter((entry) => entry.status === '未决').length,
  };
}

/**
 * `轮次导读.md` 的内容（**纯函数**：只读台账 + **扫盘**得到的按轮次存档文件）。
 *
 * ① **主题 + 细则文件**：从 `docs/00-baseline/` 下所有 `<archivePrefix>*.md` 的 `## 第N轮…` 标题推导
 *    ——**扫盘而不是查索引**，这是 `N10`/D10 的修法本体；
 * ② **条目**：从台账条目表的「轮次」列推导（每轮列出它定下的条目 ID）。
 *
 * 同一轮被多份存档覆盖时取**文件名排序最小**的那份（确定性；与"新一轮一文件"的迁移口径一致）。
 */
export function renderRoundIndex() {
  const index = readIndex();

  const archiveDir = join(repoRoot, 'docs', '00-baseline');
  /** @type {string[]} */
  let archiveNames = [];
  try {
    archiveNames = readdirSync(archiveDir)
      .filter((name) => name.startsWith(index.archivePrefix) && name.endsWith('.md'))
      .sort();
  } catch {
    // 目录不存在 ⇒ 没有存档（渲染出的表会是空的，由 check-docs 的存档覆盖检查去报错）
  }

  /** @type {Map<number, { topic: string, file: string }>} */
  const rounds = new Map();
  for (const name of archiveNames) {
    const text = readFileSync(join(archiveDir, name), 'utf8');
    for (const match of text.matchAll(/^## 第([一二三四五六七八九十百]+)轮[：:]?\s*(.*)$/gm)) {
      const round = chineseNumberToInt(match[1] ?? '');
      if (round === null) continue;
      const topic = (match[2] ?? '').replace(/\s*（.*$/, '').trim();
      if (!rounds.has(round)) rounds.set(round, { topic, file: name });
    }
  }

  const ledger = readFileSync(join(repoRoot, index.register), 'utf8');
  /** @type {Map<number, string[]>} */
  const idsByRound = new Map();
  for (const match of ledger.matchAll(/^\|\s*([DRTP]-\d+)\s*\|\s*R(\d+)\s*\|[^|]*\|[^|]*\|/gm)) {
    const round = Number(match[2]);
    const id = match[1] ?? '';
    const bucket = idsByRound.get(round);
    if (bucket === undefined) idsByRound.set(round, [id]);
    else bucket.push(id);
  }

  const allRounds = [...new Set([...rounds.keys(), ...idsByRound.keys()])].sort((a, b) => a - b);
  const rows = allRounds.map((round) => {
    const info = rounds.get(round);
    const ids = (idsByRound.get(round) ?? []).map((id) => `\`${String(id)}\``).join('、') || '—';
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

  return { text: lines.join('\n'), roundCount: rows.length, first: allRounds[0], last: allRounds[allRounds.length - 1] };
}

/**
 * **生成物登记表**：路径 → 渲染器（`check-docs.mjs` 据此重算并逐字节比对）。
 *
 * 刻意做成数据：`check-docs.mjs` 会断言"`doc-index.json` 里每个 `generated: true` 的文档都在本表里"，
 * 于是**新加一份生成物却忘了配渲染器**会在门禁里翻红，而不是等到某天发现它是陈旧的。
 */
export const GENERATED_ARTIFACTS = [
  { path: DOC_INDEX_TARGET, render: () => renderDocIndex().text },
  { path: ROUND_INDEX_TARGET, render: () => renderRoundIndex().text },
];
