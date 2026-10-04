#!/usr/bin/env node
/**
 * `pnpm docs:check` 的实现：文档结构的机械判定（规范见 `docs/DOC-SPEC.md`）。
 *
 * 为什么需要它：markdown **不在任何既有护栏之内** —— ESLint 只收 js/ts/vue、
 * Vitest 只收 `src/**\/*.spec.ts`，因此链接、锚点、台账格式、体量上限、策略措辞
 * 这些「拆一次就静默破环」的东西在门禁上完全不可见。本脚本把它们变成可判定的检查，
 * 并作为 `scripts/gate.mjs` 的最后一步。
 *
 * 顶层约定：
 * - **零依赖**（依赖面本身就是本仓库要守的东西）、只读、不加时间戳；
 * - `error` 阻断门禁；`warn` 只打印（用于无法当门禁判定的历史存量）；
 * - 白名单与上限的唯一真相源是 `docs/doc-index.json`，不在本文件里另留一份。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(readFileSync(join(repoRoot, 'docs/doc-index.json'), 'utf8'));

const errors = [];
const warnings = [];
const error = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const rel = (absolute) => relative(repoRoot, absolute).split(sep).join('/');

// ── 遍历 ────────────────────────────────────────────────────────────────────

/** 目录级排除（与 `.gitignore` 的语义一致，但本脚本不读 .gitignore）。 */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'tmp', '.git', 'coverage', '.husky']);

function walkFiles(startDir, extensions) {
  const found = [];
  const stack = [startDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(join(current, entry.name));
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(join(current, entry.name));
      }
    }
  }
  return found;
}

function walkMarkdown(startDir) {
  return walkFiles(startDir, ['.md']);
}

const read = (absolute) => readFileSync(absolute, 'utf8');

// ── GFM slug（必须与 GitHub 一致，否则「锚点可解析」是假的） ────────────────
//
// 规则（实测自本仓库标题）：先取链接文本 → 整段删除内联 code span（含内容）→ 删 HTML 标签
// → 只保留 `\p{L}`/`\p{N}`/空格/连字符（**下划线也要删**）→ 小写 → 空格转连字符。
// 同文件重复标题由 GitHub 追加 `-1`/`-2`（按出现顺序，第一次不加后缀）。

function slugify(heading) {
  let text = heading;
  for (let i = 0; i < 3; i += 1) text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/<[^>]*>/g, '');
  const parts = text.split('`');
  text = parts.filter((_, i) => i % 2 === 0).join('');
  text = text.replace(/[^\p{L}\p{N}\s-]/gu, '');
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}

/** 返回 `Map<slug, headingText>`；重复标题按 GitHub 规则加 `-1`/`-2`。 */
function headingSlugs(markdown) {
  const slugs = new Map();
  const seen = new Map();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const base = slugify(match[2]);
    if (base === '') continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.set(count === 0 ? base : `${base}-${count}`, match[2]);
  }
  return slugs;
}

// ── 1. doc-index.json ↔ 实际文档集合双射 ────────────────────────────────────

const indexed = new Map(index.docs.map((entry) => [entry.path, entry]));

for (const entry of index.docs) {
  if (!existsSync(join(repoRoot, entry.path))) {
    error(`[索引] 登记了不存在的文档：${entry.path}`);
  }
  if (!(entry.cap in index.caps)) {
    error(`[索引] ${entry.path} 的 cap "${entry.cap}" 未在 caps 中定义`);
  }
}

for (const absolute of walkMarkdown(join(repoRoot, 'docs'))) {
  const path = rel(absolute);
  if (!indexed.has(path)) error(`[索引] docs/ 下的文档未登记：${path}（请加入 docs/doc-index.json）`);
}
for (const path of ['README.md', 'CONTRIBUTING.md']) {
  if (!indexed.has(path)) error(`[索引] 根文档未登记：${path}`);
}

/** 正文里以 `docs/…`/`spikes/…` 形式提及的仓库根相对路径也要解析（代码注释与散文里的历史引用）。 */
const DOC_MENTION_PATTERN = /`((?:docs|packages|apps|spikes|tools|scripts)\/[A-Za-z0-9_./@\u4e00-\u9fff-]+\.md)`/g;

const allowlist = new Map();
const allowlistRegex = [];
for (const rule of index.linkCheckAllowlist ?? []) {
  allowlist.set(`${rule.path}\u0000${rule.target}`, rule.reason);
  if (typeof rule.targetRegex === 'string') allowlistRegex.push(new RegExp(rule.targetRegex));
}
const isAllowlisted = (path, target) =>
  allowlist.has(`${path}\u0000${target}`) || allowlistRegex.some((re) => re.test(target)) || allowlistRegex.some((re) => re.test(path));

// ── 2 / 3 / 7. 链接、锚点、URL 卫生 ─────────────────────────────────────────

const headingCache = new Map();
function slugsOf(absolute) {
  if (!headingCache.has(absolute)) headingCache.set(absolute, headingSlugs(read(absolute)));
  return headingCache.get(absolute);
}

const markdownForLinks = [
  ...walkMarkdown(join(repoRoot, 'docs')),
  ...walkMarkdown(join(repoRoot, 'packages')),
  ...walkMarkdown(join(repoRoot, 'apps')),
  ...walkMarkdown(join(repoRoot, 'spikes')),
  ...walkMarkdown(join(repoRoot, 'tools')),
  ...[join(repoRoot, 'README.md'), join(repoRoot, 'CONTRIBUTING.md')].filter(existsSync),
];



for (const absolute of markdownForLinks) {
  const path = rel(absolute);
  const lines = read(absolute).split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return; // 代码块里的示例不是链接
    // 行内 code span 里的 `[x](y)` 是**示例文本**，不是链接（规范本身就在举例）。
    const prose = line.split('`').filter((_, index) => index % 2 === 0).join('');
    for (const match of prose.matchAll(/\]\(([^()\s]+)\)/g)) {
      const raw = match[1];
      if (/^(https?:|mailto:)/.test(raw)) continue;
      const [target, anchor] = raw.split('#');
      if (/[（）？：；。！]/.test(target) || /[（）？：；。！]/.test(anchor ?? '')) {
        error(`[链接] URL 含全角字符：${path}:${lineNo} → ${raw}`);
      }
      const decodedTarget = decodeURIComponent(target);
      if (decodedTarget !== '') {
        const targetAbsolute = resolve(dirname(absolute), decodedTarget);
        if (!existsSync(targetAbsolute)) {
          if (!isAllowlisted(path, decodedTarget)) {
            error(`[链接] 目标不存在：${path}:${lineNo} → ${raw}`);
          }
        } else if (anchor !== undefined && anchor !== '') {
          const slugs = slugsOf(targetAbsolute);
          if (!slugs.has(anchor)) {
            error(`[链接] 锚点不存在：${path}:${lineNo} → ${raw}`);
          }
        }
      } else if (anchor !== undefined && anchor !== '') {
        // 同文件锚点
        const slugs = slugsOf(absolute);
        if (!slugs.has(anchor)) error(`[链接] 同文件锚点不存在：${path}:${lineNo} → #${anchor}`);
      }
    }
  });
}

// 裸路径提及（代码注释与散文）：只警告，不当门禁。
// 只检查**仓库根相对**的提及（`docs/…`、`spikes/…` 一类）；包内的裸文件名（`SCHEDULE.md`、`SPEC.md`）
// 是相对该包目录的，按包目录解析没有意义、误报率极高，故不检查。
for (const absolute of [
  ...walkFiles(join(repoRoot, 'packages'), ['.ts', '.mts']),
  ...walkFiles(join(repoRoot, 'scripts'), ['.mjs', '.mts']),
  ...walkFiles(join(repoRoot, 'apps'), ['.ts', '.mts', '.vue']),
  join(repoRoot, 'pnpm-workspace.yaml'),
]) {
  if (!existsSync(absolute)) continue;
  const path = rel(absolute);
  const lines = read(absolute).split('\n');
  lines.forEach((line, i) => {
    DOC_MENTION_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(DOC_MENTION_PATTERN)) {
      const target = match[1];
      if (isAllowlisted(path, target)) continue;
      if (existsSync(resolve(repoRoot, target))) continue;
      warn(`[提及] 路径可能失效：${path}:${i + 1} → \`${target}\``);
    }
    void line;
  });
}

// ── 4. 台账格式 + 5. 待定清单双向一致 ──────────────────────────────────────

const REGISTER_HEADER = '| ID | 轮次 | 结论 | 状态 | 细则 |';
const STATUS_DOMAIN = new Set(['有效', '已闭', '取代', '未决']);
const registerAbsolute = join(repoRoot, index.register);
const registerText = read(registerAbsolute);
const registerLines = registerText.split('\n');

if (!registerText.includes(REGISTER_HEADER)) {
  error(`[台账] 缺少条目表表头（应为 \`${REGISTER_HEADER}\`）`);
}

const ledgerEntries = [];
{
  const start = registerLines.findIndex((line) => line.trim() === REGISTER_HEADER);
  if (start >= 0) {
    for (let i = start + 2; i < registerLines.length; i += 1) {
      const line = registerLines[i].trim();
      if (!line.startsWith('|')) break;
      const cells = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
      if (cells.length !== 5) {
        error(`[台账] ${index.register}:${i + 1} 列数应为 5（ID/轮次/结论/状态/细则），实际 ${cells.length}`);
        continue;
      }
      ledgerEntries.push({ id: cells[0], round: cells[1], conclusion: cells[2], status: cells[3], detail: cells[4], line: i + 1 });
    }
  }
}

if (ledgerEntries.length === 0) error('[台账] 条目表为空');

const seenIds = new Map();
for (const entry of ledgerEntries) {
  const where = `${index.register}:${entry.line}`;
  if (!/^[DRTP]-\d+$/.test(entry.id)) error(`[台账] ID 形态不合法：${where} → ${entry.id}`);
  if (seenIds.has(entry.id) && seenIds.get(entry.id) !== entry.round) {
    error(`[台账] ID 在不同轮次重复：${where} → ${entry.id}（同一条目同一轮的多行是允许的）`);
  }
  seenIds.set(entry.id, entry.round);
  if (!STATUS_DOMAIN.has(entry.status)) error(`[台账] 状态不在闭集内：${where} → ${entry.status}`);
  if (entry.conclusion.length > 80) warn(`[台账] 结论超 80 字：${where}（${entry.conclusion.length} 字）`);

  const link = /^\[[^\]]*\]\(([^)\s]+)\)$/.exec(entry.detail);
  if (link === null) {
    error(`[台账] 细则列必须是带锚点的 markdown 链接：${where} → ${entry.detail}`);
  } else {
    const [target, anchor] = link[1].split('#');
    const targetAbsolute = resolve(dirname(registerAbsolute), target);
    if (!existsSync(targetAbsolute)) {
      error(`[台账] 细则指向不存在的文件：${where} → ${target}`);
    } else if (anchor === undefined || anchor === '') {
      error(`[台账] 细则必须带锚点（否则会静默落到文件顶部）：${where} → ${target}`);
    } else if (!slugsOf(targetAbsolute).has(anchor)) {
      error(`[台账] 细则锚点不存在：${where} → ${target}#${anchor}`);
    }
  }
  if (entry.status === '取代' && !/取代|被 .*取代/.test(entry.conclusion)) {
    error(`[台账] 状态为「取代」但结论未写明被谁取代：${where}`);
  }
}

const pendingAbsolute = join(repoRoot, index.pendingList ?? '');
if (!existsSync(pendingAbsolute)) {
  error(`[台账] 待定清单不存在：${index.pendingList}`);
} else {
  const pendingText = read(pendingAbsolute);
  // 待定清单的表格：`| ID | 内容 | 归属 | 状态 |`，首列可出现多个来源 ID（如 `P-24`），
  // 状态为「已闭…」的行只是结转登记，不算未决。
  const pendingIds = new Set();
  for (const line of pendingText.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    if (/^已闭/.test(cells[cells.length - 1])) continue;
    for (const match of cells[0].matchAll(/`([DRTP]-\d+)`/g)) pendingIds.add(match[1]);
  }
  for (const entry of ledgerEntries) {
    if (entry.status === '未决' && !pendingIds.has(entry.id)) {
      error(`[台账] 状态为「未决」但待定清单里没有它：${entry.id}`);
    }
    if (entry.status !== '未决' && pendingIds.has(entry.id)) {
      error(`[待定清单] ${entry.id} 在台账里不是「未决」，两处已分叉`);
    }
  }
  const placeholders = [...pendingIds].filter((id) => !seenIds.has(id));
  for (const id of placeholders) error(`[待定清单] 出现了台账里没有的 ID：${id}`);
}

// ── 6. 轮次 ↔ 存档 覆盖 ────────────────────────────────────────────────────

const archiveEntries = index.docs.filter((entry) => entry.role === 'register-archive');
const roundOwners = new Map();
for (const entry of archiveEntries) {
  const absolute = join(repoRoot, entry.path);
  if (!existsSync(absolute)) continue;
  const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  // 只做字符串解析，不用正则转义（避免多层引用把反斜杠吃掉）。
  // 允许两种形态：`裁决R<起轮>-<止轮>.md`（区间）与 `裁决R<轮次>.md`（单轮，新一轮一文件用）。
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name;
  const tail = stem.startsWith(index.archivePrefix) ? stem.slice(index.archivePrefix.length) : null;
  const parts = tail === null ? [] : tail.split('-');
  const isDigits = (text) => typeof text === 'string' && text.length === 2 && [...text].every((c) => c >= '0' && c <= '9');
  const single = parts.length === 1 && isDigits(parts[0]);
  const ranged = parts.length === 2 && parts.every(isDigits);
  if (!single && !ranged) {
    error(`[存档] 文件名不合法（应为 ${index.archivePrefix}<起轮>-<止轮>.md 或 ${index.archivePrefix}<轮次>.md）：${entry.path}`);
    continue;
  }
  const startText = ranged ? parts[0] : parts[0];
  const endText = ranged ? parts[1] : parts[0];
  const from = Number(startText);
  const to = Number(endText);
  if (from > to) error(`[存档] 轮次区间反了：${entry.path}`);

  const text = read(absolute);
  for (const match of text.matchAll(/^## 第([一二三四五六七八九十百]+)轮/gm)) {
    const round = chineseNumberToInt(match[1]);
    if (round === null) continue;
    if (round < from || round > to) {
      error(`[存档] ${entry.path} 含区间外的轮次：第${match[1]}轮（本文件覆盖 R${from}–R${to}）`);
    }
    if (roundOwners.has(round)) {
      error(`[存档] 第${round}轮被多份存档覆盖：${roundOwners.get(round)} 与 ${entry.path}`);
    }
    roundOwners.set(round, entry.path);
  }
  if (text.split('\n')[0].trim() === '---') error(`[存档] 首行不得是 ---：${entry.path}`);
}

for (let round = 2; round <= 26; round += 1) {
  if (!roundOwners.has(round)) error(`[存档] 第${round}轮没有任何存档覆盖（迁移缺口）`);
}

/** 中文数字（本仓库只用到「二」…「二十六」）。 */
function chineseNumberToInt(text) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(text)) return 10 + digits[text[1]];
  if (/^[一二三四五六七八九]十$/.test(text)) return digits[text[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(text)) return digits[text[0]] * 10 + digits[text[2]];
  return digits[text] ?? null;
}

// ── 8. 体量上限 ────────────────────────────────────────────────────────────

const sizeRows = [];
for (const entry of index.docs) {
  const absolute = join(repoRoot, entry.path);
  if (!existsSync(absolute)) continue;
  const kb = statSync(absolute).size / 1024;
  const cap = index.caps[entry.cap];
  sizeRows.push({ path: entry.path, kb: Math.round(kb * 10) / 10, cap });
  if (kb > cap) {
    error(`[体量] 超上限：${entry.path} ${Math.round(kb * 10) / 10} KB > ${cap} KB（动作是拆分或迁移，不是提高上限）`);
  }
}

// ── 9. 策略不变量 ──────────────────────────────────────────────────────────

const POLICY = [
  { path: 'docs/00-baseline/裁决记录.md', needle: '唯一权威登记处' },
  { path: 'README.md', needle: '不做版本号另存' },
  { path: 'CONTRIBUTING.md', needle: '不做版本号另存' },
];
for (const rule of POLICY) {
  const absolute = join(repoRoot, rule.path);
  if (!existsSync(absolute)) {
    error(`[策略] ${rule.path} 不存在`);
    continue;
  }
  if (!read(absolute).includes(rule.needle)) {
    error(`[策略] ${rule.path} 缺少既定措辞「${rule.needle}」（口径被改写或丢失，请与 docs/DOC-SPEC.md 对齐）`);
  }
}
if (!seenIds.has('P-27')) {
  error('[策略] 台账缺少 P-27（按轮次存档这一例外的授权条目），docs/DOC-SPEC.md 的例外声明无依据');
}
// ── 报告 ───────────────────────────────────────────────────────────────────

const totalKb = sizeRows.reduce((sum, row) => sum + row.kb, 0);
console.log(`[docs] 已索引文档 ${index.docs.length} 份，合计 ${Math.round(totalKb)} KB；台账条目 ${ledgerEntries.length} 条；存档覆盖轮次 ${roundOwners.size} 个`);

if (warnings.length > 0) {
  console.log(`\n[docs] 警告 ${warnings.length} 条（不阻断）：`);
  for (const message of warnings) console.log(`  warn ${message}`);
}

if (errors.length > 0) {
  console.error(`\n[docs] 错误 ${errors.length} 条：`);
  for (const message of errors) console.error(`  error ${message}`);
  console.error('\n[docs] 检查未通过。规范见 docs/DOC-SPEC.md；链接/锚点修复后重跑 `pnpm docs:check`。');
  process.exit(1);
}

console.log('[docs] 检查通过：链接 / 锚点 / 台账 / 存档覆盖 / 体量 / 策略不变量。');
