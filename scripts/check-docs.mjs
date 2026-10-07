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

import { createHash } from 'node:crypto';
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

// 自检模式：只跑判定引擎的合成用例（不读仓库），见文件末尾的 selftest()
if (process.argv.includes('--selftest')) selftest();

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

/** 正文里以 `docs/…`/`spikes/…` 形式提及的仓库根相对路径也要解析（代码注释与散文里的历史引用）。
 *  P1-d：除了 `.md` 文件，还收**目录**形态（"某探针目录已整体删除"那类引用正是来源链断裂的形态）；
 *  已存在的路径会被跳过，所以这里放宽不会产生存量噪声。 */
const DOC_MENTION_PATTERN = /`((?:docs|packages|apps|spikes|tools|scripts)\/[A-Za-z0-9_./@\u4e00-\u9fff-]+\.md|(?:spikes|tools|apps|docs|packages|scripts)\/[A-Za-z0-9_./@\u4e00-\u9fff-]+\/)`/g;

// 白名单 = **路径正则 与 目标正则** 同时命中（P1-d 修正）。
// 旧实现只把 `targetRegex` 拿去做两次 `test`（一次对 target、一次对 path），`pathRegex` **从未参与**，
// 于是规则比登记的宽得多——这正是"白名单缺口被静默吞掉"的机制性原因。
const allowRules = (index.linkCheckAllowlist ?? []).map((rule) => ({
  pathRegex: rule.pathRegex === undefined ? /.*/ : new RegExp(rule.pathRegex),
  targetRegex: rule.targetRegex === undefined ? /.*/ : new RegExp(rule.targetRegex),
  reason: rule.reason ?? '',
}));
if (allowRules.some((rule) => rule.reason === '')) {
  error('[白名单] linkCheckAllowlist 的每条例外都必须写 reason（没有理由的例外等于没有门禁）');
}
const isAllowlisted = (path, target) => allowRules.some((rule) => rule.pathRegex.test(path) && rule.targetRegex.test(target));

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



/** 跨层引用（L1 → 归档层）的链接记录，供 §8c 的标记词判定使用。 */
const crossLayerLinks = [];

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
    for (const match of prose.matchAll(/\[([^\]]*)\]\(([^()\s]+)\)/g)) {
      const linkText = match[1];
      const raw = match[2];
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
        // 跨层引用（P1-c）：L1 正文指向归档层的链接要记下来，供"必须带标记词"的判定用。
        crossLayerLinks.push({ path, line: lineNo, target: rel(targetAbsolute), raw, linkText, lineText: line });
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
//
// P1-d：扫描面从"只有代码"扩到**代码 + 全部被索引的 markdown + 目录形态**。理由是"来源链断裂"正是
// 这样漏掉的——G7 的准入探针目录已被删除，而 3 份 pptx evidence 与若干归档文档仍把它写成生成者，
// 旧实现因为只扫代码、且只认 `.md` 后缀而完全看不见这一类引用。判据仍是**警告**（历史引用不该阻断门禁），
// 但"白名单缺口"因此变成可验证的：没登记的缺口会逐条出现。v0.2 临时计划目录跳过（合流后整体删除）。
for (const absolute of [
  ...walkFiles(join(repoRoot, 'packages'), ['.ts', '.mts']),
  ...walkFiles(join(repoRoot, 'scripts'), ['.mjs', '.mts']),
  ...walkFiles(join(repoRoot, 'apps'), ['.ts', '.mts', '.vue']),
  ...markdownForLinks.filter((file) => indexed.get(rel(file))?.budgetExempt !== true),
  join(repoRoot, 'pnpm-workspace.yaml'),
]) {
  if (!existsSync(absolute)) continue;
  const path = rel(absolute);
  const lines = read(absolute).split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    DOC_MENTION_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(DOC_MENTION_PATTERN)) {
      const target = match[1];
      if (isAllowlisted(path, target)) continue;
      if (existsSync(resolve(repoRoot, target))) continue;
      warn(`[提及] 路径可能失效：${path}:${i + 1} → \`${target}\``);
    }
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

// 轮次上界**由台账推导**（P1-c）：旧实现硬编码 `round <= 26`，于是 R27 以后的存档不受覆盖检查
// （P0 的实测缺口）。推导失败必须报错——否则上界会静默变成 0，覆盖检查就成了恒真式。
const ledgerRounds = [];
for (const entry of ledgerEntries) {
  for (const match of entry.round.matchAll(/(\d+)/g)) ledgerRounds.push(Number(match[1]));
}
const ledgerMaxRound = ledgerRounds.length > 0 ? Math.max(...ledgerRounds) : null;
if (ledgerMaxRound === null) {
  error('[存档] 台账「轮次」列解析不出任何轮次 ⇒ 覆盖上界无法推导（旧实现的硬编码 26 已删除）');
} else {
  for (let round = 2; round <= ledgerMaxRound; round += 1) {
    if (!roundOwners.has(round)) error(`[存档] 第${round}轮没有任何存档覆盖（迁移缺口）`);
  }
  if (ledgerMaxRound < 2) error(`[存档] 台账推导出的轮次上界是 R${String(ledgerMaxRound)}（至少应有 R02）`);
}

/** 文档里提到的"超出台账上界"的轮次（漏登记/漏存档的机械信号，见 §8c 的警告）。 */
const beyondBoundMentions = [];
if (ledgerMaxRound !== null) {
  for (const entry of index.docs) {
    if (entry.layer !== 'slim' || entry.budgetExempt === true) continue;
    const absolute = join(repoRoot, entry.path);
    if (!existsSync(absolute)) continue;
    const lines = read(absolute).split('\n');
    let inFence = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const prose = line.split('`').filter((_, index) => index % 2 === 0).join('');
      for (const match of prose.matchAll(/(?<![A-Za-z0-9])R(\d{1,2})(?![0-9])/g)) {
        const round = Number(match[1]);
        if (round > ledgerMaxRound && round < 100) beyondBoundMentions.push({ path: entry.path, line: i + 1, round });
      }
    });
  }
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

// ── 8b. 分层预算与入口封闭性（P1-b） ────────────────────────────────────────
//
// 为什么需要它：没有它就只是"口头分层"。`docs/doc-index.json` 的 `layer` 与 `contextBudget`
// 是唯一真相源；这里只做机械判定——(a) 精简层与必读的体量预算；(b) **入口页（L0）只能引用精简层**
// （归档物可以出现在 L1 正文的"依据/细则/历史"上下文里，但入口页不指过去）。
//
// 两类目标的规则不同：
// - **文件链接**：目标必须是已登记且 `layer === 'slim'` 的文档（非 .md 目标不判，那是数据/资产）；
// - **目录链接**：目录下的**已登记**文档必须都是 slim（否则报错：要么改到具体文件，要么把归档物移出目录）；
//   目录下**未登记**的 .md 只警告（evidence 一类历史存量的分层登记属 P2）。

/**
 * 分层预算与入口封闭性的判定（与仓库解耦，便于 `--selftest` 用合成输入驱动）。
 *
 * @param {{ rows: Array<{path: string, layer: string, userFacing?: boolean, mustRead?: boolean, budgetExempt?: boolean, kb: number}>,
 *           budget: {slimKb: number, mustReadKb: number, entryCapKb: number},
 *           entry: {path: string, kb: number, links: Array<object>} }} input
 * @returns {{ errors: string[], warnings: string[], slimKb: number, mustReadKb: number, exemptKb: number }}
 */
export function evaluateLayers({ rows, budget, entry }) {
  const errors = [];
  const warnings = [];
  const sum = (list) => list.reduce((total, row) => total + row.kb, 0);
  const listOf = (list, limit) => {
    const sorted = list.slice().sort((a, b) => b.kb - a.kb);
    const shown = sorted.slice(0, limit);
    const lines = shown.map((row) => `[分层·清单] ${row.kb.toFixed(1).padStart(7)} KB  ${row.path}`);
    if (sorted.length > shown.length) {
      lines.push(`[分层·清单] …另有 ${String(sorted.length - shown.length)} 份（合计 ${(sum(sorted) - sum(shown)).toFixed(1)} KB），完整清单见 docs/01-roadmap/首版-文档索引.md`);
    }
    return lines;
  };

  for (const row of rows) {
    if (row.layer !== 'slim' && row.layer !== 'archive') {
      errors.push(`[分层] ${row.path} 的 layer 不在闭集内（slim|archive）：${String(row.layer)}`);
    }
  }

  const slimRows = rows.filter((row) => row.layer === 'slim' && row.userFacing !== true && row.budgetExempt !== true && row.generated !== true);
  const slimKb = sum(slimRows);
  const exemptKb = sum(rows.filter((row) => row.layer === 'slim' && row.budgetExempt === true));
  const generatedKb = sum(rows.filter((row) => row.layer === 'slim' && row.generated === true));
  const userFacingKb = sum(rows.filter((row) => row.layer === 'slim' && row.userFacing === true));
  if (slimKb > budget.slimKb) {
    errors.push(
      `[分层] 精简层超预算：${slimKb.toFixed(1)} KB > ${budget.slimKb} KB（不含用户手册 ${userFacingKb.toFixed(1)} KB、临时计划 ${exemptKb.toFixed(1)} KB 与生成物 ${generatedKb.toFixed(1)} KB）；动作是拆分或迁归档层，不是提高上限`,
    );
    errors.push(...listOf(slimRows, 12));
  }

  const mustReadRows = rows.filter((row) => row.mustRead === true);
  const mustReadKb = sum(mustReadRows);
  if (mustReadKb > budget.mustReadKb) {
    errors.push(`[分层] 必读层超预算：${mustReadKb.toFixed(1)} KB > ${budget.mustReadKb} KB（台账 + 当前规划 + 待定清单）`);
    errors.push(...listOf(mustReadRows, 6));
  }

  if (entry.kb > budget.entryCapKb) {
    errors.push(`[入口] L0 入口超上限：${entry.path} ${entry.kb.toFixed(1)} KB > ${budget.entryCapKb} KB（入口要能整份注入）`);
  }

  for (const link of entry.links) {
    if (link.kind === 'file') {
      if (link.layer === undefined) {
        errors.push(`[入口] ${entry.path}:${String(link.line)} 指向未登记分层的文档：${link.target}（登记 layer 之后才能引用）`);
      } else if (link.layer !== 'slim') {
        errors.push(`[入口] ${entry.path}:${String(link.line)} 指向归档层：${link.target}（归档物只允许出现在 L1 正文的"依据/细则/历史"上下文里，入口页不指过去）`);
      }
    } else if (link.kind === 'directory') {
      const nestedArchive = (link.nested ?? []).filter((item) => item.layer !== 'slim');
      if (nestedArchive.length > 0) {
        const names = nestedArchive.slice(0, 3).map((item) => item.path).join('、');
        errors.push(
          `[入口] ${entry.path}:${String(link.line)} 的目录里含 ${String(nestedArchive.length)} 份归档层文档（${names}${nestedArchive.length > 3 ? ' 等' : ''}）：目录链接要么改到具体文件，要么把归档物移出该目录`,
        );
      }
      if ((link.unindexed ?? 0) > 0) {
        warnings.push(
          `[入口] ${entry.path}:${String(link.line)} 的目录下有 ${String(link.unindexed)} 份未登记文档（分层登记属 P2/C8：` +
            '登记后 L1 → 证据的链接都要带标记词，故与 D6/D7 同批——见 03 §九 C8）',
        );
      }
    }
  }

  return { errors, warnings, slimKb, mustReadKb, exemptKb, generatedKb, userFacingKb };
}

// ── 8b. 分层预算与入口封闭性：输入装配 ─────────────────────────────────────

const budget = index.contextBudget ?? { entry: 'docs/README.md', slimKb: 100, mustReadKb: 25, entryCapKb: 6 };
const entryPath = budget.entry ?? 'docs/README.md';
const entryAbsolute = join(repoRoot, entryPath);
const layerRows = sizeRows.map((row) => {
  const meta = index.docs.find((entry) => entry.path === row.path) ?? {};
  return { path: row.path, kb: row.kb, layer: meta.layer, userFacing: meta.userFacing, mustRead: meta.mustRead, budgetExempt: meta.budgetExempt, generated: meta.generated };
});

const entryLinks = [];
if (existsSync(entryAbsolute)) {
  const entryLines = read(entryAbsolute).split('\n');
  let entryInFence = false;
  entryLines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      entryInFence = !entryInFence;
      return;
    }
    if (entryInFence) return;
    const prose = line.split('`').filter((_, index) => index % 2 === 0).join('');
    for (const match of prose.matchAll(/\]\(([^()\s]+)\)/g)) {
      const raw = match[1];
      if (/^(https?:|mailto:)/.test(raw)) continue;
      const target = decodeURIComponent(raw.split('#')[0]);
      if (target === '') continue;
      const absolute = resolve(dirname(entryAbsolute), target);
      if (!existsSync(absolute)) continue; // 不存在的目标由 §2 报错，这里不重复
      const repoRel = rel(absolute);
      if (statSync(absolute).isDirectory()) {
        const prefix = repoRel.endsWith('/') ? repoRel.slice(0, -1) : repoRel;
        const nested = index.docs
          .filter((entry) => entry.path.startsWith(`${prefix}/`))
          .map((entry) => ({ path: entry.path, layer: entry.layer }));
        const indexedPaths = new Set(nested.map((item) => item.path));
        const unindexed = walkMarkdown(absolute)
          .map((path) => rel(path))
          .filter((path) => !indexedPaths.has(path)).length;
        entryLinks.push({ line: i + 1, target: raw, kind: 'directory', nested, unindexed });
      } else if (repoRel.endsWith('.md')) {
        const indexedEntry = indexed.get(repoRel);
        entryLinks.push({ line: i + 1, target: raw, kind: 'file', layer: indexedEntry?.layer });
      }
    }
  });
}

const layered = evaluateLayers({
  rows: layerRows,
  budget,
  entry: { path: entryPath, kb: existsSync(entryAbsolute) ? statSync(entryAbsolute).size / 1024 : 0, links: entryLinks },
});
for (const message of layered.errors) error(message);
for (const message of layered.warnings) warn(message);

// ── 8c. 跨层引用必须带标记词：输入装配 ─────────────────────────────────────

const crossLayerConfig = index.crossLayerCheck ?? {};
const crossLayer = evaluateCrossLayer({
  links: crossLayerLinks.filter((link) => {
    const source = indexed.get(link.path);
    const target = indexed.get(link.target);
    if (source?.layer !== 'slim' || source.path === entryPath) return false; // L0 入口由 §8b 判
    if (source.budgetExempt === true) return false; // v0.2 临时计划：合流后整体删除
    return target?.layer === 'archive';
  }),
  markers: crossLayerConfig.markers ?? ['历史', '原文口径', '细则', '依据', '存档'],
  allow: crossLayerConfig.allow ?? [],
  maxRound: ledgerMaxRound,
  roundMentions: beyondBoundMentions,
});
for (const message of crossLayer.errors) error(message);
for (const message of crossLayer.warnings) warn(message);

// ── 8c. 跨层引用必须带标记词（P1-c 的可判定那一半） ─────────────────────────
//
// 为什么需要它：归档层（按轮次存档、附录、记录层、三份基线）是**历史**，而"历史里写的当前值"
// 是这一轮分叉的主要来源。判定不做语义判断，只要求 L1 正文指向归档层的链接**在链接文本或同一行**
// 出现标记词（`历史` / `原文口径` / `细则` / `依据` / `存档`）——即"读者一眼知道这是历史口径"，
// 而不是被当成当前契约。入口页（L0）由 §8b 的封闭性判定负责，不在这里重复报。

/**
 * 跨层引用的标记词判定（与仓库解耦，便于 `--selftest` 用合成输入驱动）。
 *
 * @param {{ links: Array<{path: string, line: number, target: string, linkText: string, lineText: string}>,
 *           markers: string[], allow?: Array<{path?: string, pathRegex?: string, reason: string}>,
 *           maxRound?: number, roundMentions?: Array<{path: string, line: number, round: number}> }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function evaluateCrossLayer({ links, markers, allow = [], maxRound, roundMentions = [] }) {
  const errors = [];
  const warnings = [];
  const isAllowed = (path) => allow.some((rule) => (typeof rule.path === 'string' ? rule.path === path : new RegExp(rule.pathRegex).test(path)));

  const violations = new Map();
  for (const link of links) {
    if (isAllowed(link.path)) continue;
    const marked = markers.some((word) => link.linkText.includes(word) || link.lineText.includes(word));
    if (marked) continue;
    if (!violations.has(link.path)) violations.set(link.path, []);
    violations.get(link.path).push(link);
  }
  for (const [path, own] of violations) {
    const samples = own.slice(0, 3).map((link) => `${path}:${String(link.line)} → ${link.raw}`).join('；');
    errors.push(
      `[跨层] ${path}：${String(own.length)} 处指向归档层的链接没有标记词（${markers.join(' / ')}）——` +
        `归档物只能作为"历史/原文口径/细则/依据/存档"被引用：${samples}${own.length > 3 ? ` …（共 ${String(own.length)} 处）` : ''}`,
    );
  }

  if (typeof maxRound === 'number') {
    const beyond = roundMentions.filter((mention) => mention.round > maxRound);
    const byPath = new Map();
    for (const mention of beyond) {
      if (!byPath.has(mention.path)) byPath.set(mention.path, []);
      byPath.get(mention.path).push(mention);
    }
    for (const [path, own] of byPath) {
      const rounds = [...new Set(own.map((mention) => `R${String(mention.round)}`))].sort().join('、');
      warnings.push(
        `[存档] ${path} 提到超出台账上界（R${String(maxRound)}）的轮次 ${rounds}（${String(own.length)} 处，最早 ${path}:${String(own[0].line)}）——` +
          '可能是漏登记或漏存档（补登记见 P2/D3）',
      );
    }
  }

  return { errors, warnings };
}

// ── 8d. 仓库外路径与 gitignore 引用（D1 / 决策 8） ──────────────────────────
//
// 为什么需要它：基线层与计划层把上游原文写成**个人机器上的绝对路径**（基线层自称"结构化重建"，
// 原文是它唯一的校验基准），换机器 / 清下载目录 / clone 仓库即全部悬空；记录制证据则把复现输入
// 写成 `tmp/`（被 `.gitignore` 覆盖）下的绝对路径——读者照着做必然复现不出来。两类都是
// "引用看着在、实际不可复现"。规范见 `docs/DOC-SPEC.md` §4.6。
//
// 口径：
// - **可复现层**（`layer: slim` 或 `role: baseline`）里的盘符 / 家目录绝对路径 ⇒ **错误**；
// - 可复现层里指向**被 `.gitignore` 覆盖的临时/草稿路径**（`tmp/` 一类，模式由 `temporaryPathPatterns`
//   指定）、且**同一行没有声明词**（`不入库` / `可再生` 一类，即"这份东西本就不在仓库里、要自己生成"）
//   ⇒ **警告**。可再生的构建产物（`dist/` / `node_modules/` / `out/`）**不在判定内**：文档里引用它们
//   是正常口径（有再生命令），而 `tmp/` 是维护者本机的草稿，读者照做必然复现不出来。
// - 判定面之外的文档（记录层 / 证据 / spike）**不判错**：那里的本机路径是"当时的机器事实"，
//   记录制证据按先例不改写（`P-41 §9(a)` / `P-44 §9(a)`）⇒ 只聚合成**一条存量警告**（执行落 C8 / D9）；
// - 例外表 `externalPathCheck.allow`：每条必须带 `kind`（环境观测 | 来源元信息 | 产物说明 | 规范示例）与 `reason`。

/** `.gitignore` 的最小匹配器（本仓库只有根 `.gitignore`；嵌套 `.gitignore` 不在判定内）。
 *  覆盖本仓库实际用到的形态：目录 `dir/`、后缀 `*.ext`、裸名 `name`、带通配的路径（如 `spikes` + 通配 + `out/`）、
 *  `!` 反选（后匹配者胜）。 */
export function makeGitignoreMatcher(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).trim();
    if (pattern === '') continue;
    const directory = pattern.endsWith('/');
    const body = directory ? pattern.slice(0, -1) : pattern;
    const anchored = body.startsWith('/');
    const bare = anchored ? body.slice(1) : body;
    const core = bare
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .split('**')
      .map((part) => part.replace(/\*/g, '[^/]*'))
      .join('.*');
    // 「含斜杠」要按**原始**模式判（变换后的 core 里 `[^/]` 也含斜杠，会把 `*.tmp` 误判成锚定）。
    const prefix = anchored || bare.includes('/') ? '^' : '^(?:.*/)?';
    rules.push({ negated, regex: new RegExp(`${prefix}${core}${directory ? '(?:/.*)?$' : '$'}`) });
  }
  return (path) => {
    let ignored = false;
    for (const rule of rules) if (rule.regex.test(path)) ignored = !rule.negated;
    return ignored;
  };
}

/** 例外表的 `kind` 是闭集：它回答"这条本机路径为什么可以留"。 */
const EXTERNAL_PATH_KINDS = new Set(['环境观测', '来源元信息', '产物说明', '规范示例']);

/**
 * 仓库外路径与 gitignore 引用的判定（与仓库解耦，便于 `--selftest` 用合成输入驱动）。
 *
 * @param {{ hits: Array<{path: string, line: number, kind: 'absolute'|'temporary', scope: 'reproducible'|'archive',
 *            text?: string, target?: string, lineText?: string, declared?: boolean}>,
 *           markers?: string[],
 *           allow?: Array<{path?: string, pathRegex?: string, lineRegex?: string, kind: string, reason: string}> }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function evaluateExternalPaths({ hits, markers = [], allow = [] }) {
  const errors = [];
  const warnings = [];
  const isAllowed = (hit) =>
    allow.some((rule) => {
      const byPath =
        rule.path !== undefined
          ? rule.path === hit.path
          : rule.pathRegex === undefined
            ? true
            : new RegExp(rule.pathRegex).test(hit.path);
      if (!byPath) return false;
      return rule.lineRegex === undefined || new RegExp(rule.lineRegex).test(hit.lineText ?? '');
    });
  const group = (list) => {
    const grouped = new Map();
    for (const hit of list) {
      if (!grouped.has(hit.path)) grouped.set(hit.path, []);
      grouped.get(hit.path).push(hit);
    }
    return grouped;
  };
  const tail = (own) => (own.length > 3 ? ` …（共 ${String(own.length)} 处）` : '');

  const absolute = hits.filter((hit) => hit.kind === 'absolute' && !isAllowed(hit));
  for (const [path, own] of group(absolute.filter((hit) => hit.scope === 'reproducible'))) {
    const samples = own.slice(0, 3).map((hit) => `${path}:${String(hit.line)} → ${hit.text ?? ''}`).join('；');
    errors.push(
      `[外部路径] ${path}：${String(own.length)} 处本机绝对路径（盘符 / 家目录）——可复现层不得把引用绑死在一台机器上：` +
        `${samples}${tail(own)}（决策 8：基线层必须可被本仓库内的原文校验，执行落 D2）`,
    );
  }
  const archived = group(absolute.filter((hit) => hit.scope !== 'reproducible'));
  if (archived.size > 0) {
    const total = [...archived.values()].reduce((sum, own) => sum + own.length, 0);
    const names = [...archived.entries()]
      .slice(0, 4)
      .map(([path, own]) => `${path}(${String(own.length)})`)
      .join('、');
    warnings.push(
      `[外部路径] 归档 / 证据层有 ${String(archived.size)} 份文档含本机绝对路径（共 ${String(total)} 处）：${names}` +
        `${archived.size > 4 ? ' 等' : ''}——记录制证据按先例不改写（P-41 §9(a)），执行落 C8（证据卫生）与 D9（spike 批次）`,
    );
  }
  const ignored = hits.filter((hit) => hit.kind === 'temporary' && hit.scope === 'reproducible' && hit.declared !== true && !isAllowed(hit));
  for (const [path, own] of group(ignored)) {
    const samples = own.slice(0, 3).map((hit) => `${path}:${String(hit.line)} → ${hit.target ?? ''}`).join('；');
    warnings.push(
      `[外部路径] ${path}：${String(own.length)} 处引用被 .gitignore 覆盖的临时路径、同一行（或紧邻下一行）没有声明词（${markers.join(' / ')}）：` +
        `${samples}${tail(own)}——这些路径不入库、也不由脚本再生，读者照做复现不出来；改法是补声明词或改写成「由脚本再生」`,
    );
  }

  return { errors, warnings };
}

// ── 8d. 仓库外路径与 gitignore 引用：输入装配 ───────────────────────────────

const externalConfig = index.externalPathCheck ?? {};
const externalScope = externalConfig.errorScope ?? { layers: ['slim'], roles: ['baseline'] };
const externalMarkers = externalConfig.markers ?? [];
const externalAllow = externalConfig.allow ?? [];
const gitignoreText = existsSync(join(repoRoot, '.gitignore')) ? read(join(repoRoot, '.gitignore')) : '';
const gitignoreLines = new Set(gitignoreText.split('\n').map((line) => line.trim()));
const temporaryPatterns = externalConfig.temporaryPathPatterns ?? [];
for (const pattern of temporaryPatterns) {
  // 口径必须与 `.gitignore` 挂钩：配置里写了一个仓库根本没忽略的模式，等于这条守卫在自说自话。
  if (!gitignoreLines.has(pattern)) {
    error(`[外部路径] temporaryPathPatterns 的 "${pattern}" 不在根 .gitignore 里（临时路径口径必须与 .gitignore 一致）`);
  }
}
for (const rule of externalAllow) {
  if (!EXTERNAL_PATH_KINDS.has(rule.kind)) {
    error(`[外部路径] 例外表 externalPathCheck.allow 的 kind 不在闭集内（${[...EXTERNAL_PATH_KINDS].join(' | ')}）：${String(rule.kind)}`);
  }
  if (typeof rule.reason !== 'string' || rule.reason === '') {
    error('[外部路径] 例外表 externalPathCheck.allow 的每条例外都必须写 reason（没有理由的例外等于没有门禁）');
  }
  if (rule.path === undefined && rule.pathRegex === undefined) {
    error('[外部路径] 例外表的每条规则至少要写 path 或 pathRegex（否则它会把整份守卫关掉）');
  }
}

/** 盘符（`C:\` / `D:/`，含 `file:///D:/…`）与家目录（`~/` / `/Users/` / `/home/`）的完整路径 token。 */
const ABSOLUTE_PATH_PATTERN = /(?<![A-Za-z0-9])([A-Za-z]:[\\/][^\s`'"，。、）)】]*|~[\\/][^\s`'"，。、）)】]*|\/(?:Users|home)\/[^\s`'"，。、）)】]*)/g;

const isIgnoredPath = makeGitignoreMatcher(gitignoreText);
const isTemporaryPath = makeGitignoreMatcher(temporaryPatterns.join('\n'));
const externalHits = [];
for (const absolute of markdownForLinks) {
  const path = rel(absolute);
  const entry = indexed.get(path);
  if (entry?.budgetExempt === true) continue; // v0.2 临时计划：合流后整体删除
  const scope =
    entry !== undefined && ((externalScope.layers ?? []).includes(entry.layer) || (externalScope.roles ?? []).includes(entry.role))
      ? 'reproducible'
      : 'archive';
  const lines = read(absolute).split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const match of line.matchAll(ABSOLUTE_PATH_PATTERN)) {
      externalHits.push({ path, line: i + 1, kind: 'absolute', text: match[1], scope, lineText: line });
    }
    const candidates = new Set();
    for (const match of line.matchAll(/\]\(([^()\s]+)\)/g)) candidates.add(decodeURIComponent(match[1].split('#')[0]));
    for (const match of line.matchAll(/`([^`\n]+)`/g)) candidates.add(match[1]);
    for (const candidate of candidates) {
      const target = candidate.trim().replace(/^\.\//, '');
      if (target === '' || /^(https?:|mailto:|#)/.test(target)) continue;
      if (!isIgnoredPath(target) || !isTemporaryPath(target)) continue;
      // 声明词允许落在**紧邻的下一行**：本仓库的写法常把"（不入库二进制）"折到下一行（如 CONTRIBUTING §记录制实测）。
      const window = `${line}\n${lines[i + 1] ?? ''}`;
      externalHits.push({
        path,
        line: i + 1,
        kind: 'temporary',
        target,
        scope,
        declared: externalMarkers.some((word) => window.includes(word)),
        lineText: line,
      });
    }
  });
}

const external = evaluateExternalPaths({ hits: externalHits, markers: externalMarkers, allow: externalAllow });
for (const message of external.errors) error(message);
for (const message of external.warnings) warn(message);

// ── 8e. 来源行与保真（D2 / 决策 8） ─────────────────────────────────────────
//
// 为什么需要它：基线层的「可校验」= **溯源 + 保真**，而**保真比对不可机械化**（原始文件在仓库外）。
// 可机械化的只有两件，正好覆盖"假权威"与"改写历史"两个风险：
// ① 入仓原文必须带来源块，且「入库件正文 sha256」与 marker 之后的内容（LF 归一化）复算值一致
//    ⇒ 任何人改动入库正文都会被抓住（冻结口径：不得回改；升版按新裁决处理）；
// ② 提取件必须保留指向入仓原文的链接**并带标记词** ⇒ 「提取件 ↔ 原文」的对应关系不会被静默摘掉，
//    读者也不会把原文当当前口径。规范见 `docs/DOC-SPEC.md` §4.6。

/**
 * 来源行与保真的判定（与仓库解耦，便于 `--selftest` 用合成输入驱动）。
 *
 * @param {{ archived?: Array<{path: string, exists: boolean, marker: string, hasMarker?: boolean,
 *            requiredLabels?: string[], labels?: Record<string, string>, hashLabel?: string,
 *            recordedHash?: string, computedHash?: string}>,
 *           extractors?: Array<{path: string, mustLinkTo: string, links?: Array<{target: string, linkText?: string, lineText?: string}>}>,
 *           markers?: string[] }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function evaluateSourceLines({ archived = [], extractors = [], markers = [] }) {
  const errors = [];
  for (const file of archived) {
    if (file.exists !== true) {
      errors.push(`[溯源] 入仓原文不存在：${file.path}（决策 8 要求上游原文入仓，否则提取件无从校验）`);
      continue;
    }
    if (file.hasMarker !== true) {
      errors.push(`[溯源] ${file.path} 缺少内容起始标记「${file.marker}」：正文哈希的范围无从确定`);
    }
    const missing = (file.requiredLabels ?? []).filter((label) => (file.labels ?? {})[label] === undefined);
    if (missing.length > 0) {
      errors.push(`[溯源] ${file.path} 的来源块缺必填项：${missing.join('、')}（来源元信息按决策 8 §三.1 登记）`);
    }
    const recorded = file.recordedHash ?? '';
    if (!/^[0-9a-f]{64}$/.test(recorded)) {
      errors.push(`[溯源] ${file.path} 的「${file.hashLabel ?? 'sha256'}」不是 64 位十六进制：${recorded === '' ? '（缺失）' : recorded}`);
    } else if (recorded !== file.computedHash) {
      errors.push(
        `[溯源] ${file.path} 的「${String(file.hashLabel)}」与复算值不一致（入库正文被改过？）：` +
          `登记 ${recorded.slice(0, 12)}… ≠ 复算 ${String(file.computedHash).slice(0, 12)}…——` +
          '冻结口径要求「不得回改」；原文升版按新裁决处理，不并列存多版（P-3）',
      );
    }
  }
  for (const file of extractors) {
    const hits = (file.links ?? []).filter((link) => link.target === file.mustLinkTo);
    if (hits.length === 0) {
      errors.push(`[溯源] ${file.path} 没有指向入仓原文的链接（${file.mustLinkTo}）：提取件与原文的对应关系不得被静默摘掉`);
      continue;
    }
    const marked = hits.some((link) => markers.some((word) => (link.linkText ?? '').includes(word) || (link.lineText ?? '').includes(word)));
    if (!marked) {
      errors.push(
        `[溯源] ${file.path} 指向入仓原文的链接没有标记词（${markers.join(' / ')}）：` +
          '读者要一眼看出这是「原文口径」，而不是当前生效的口径',
      );
    }
  }
  return { errors, warnings: [] };
}

// ── 8e. 来源行与保真：输入装配 ──────────────────────────────────────────────

const sourceConfig = index.sourceLineCheck ?? {};
const sourceMarkers = sourceConfig.markers ?? [];
const sourceMarkerDefault = sourceConfig.contentStartMarker ?? '';

/** 文件开头的 `| 标签 | 值 |` 表（来源块）解析成 Map；分隔行与表头行跳过。 */
function tableLabels(lines) {
  const labels = {};
  for (const line of lines) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (match === null) continue;
    if (match[1] === '项' || /^-+$/.test(match[1])) continue;
    labels[match[1]] = match[2];
  }
  return labels;
}

/** 正文哈希的范围：内容起始标记**那一行之后**的全部字节，按 LF 归一化（跨平台稳定）。
 *  标记必须是**行的开头**（`startsWith`）——否则来源块里引用标记字样的一行会被误当成范围起点。 */
function contentHashOf(text, marker) {
  const lines = text.split('\n');
  const index = marker === '' ? -1 : lines.findIndex((line) => line.startsWith(marker));
  const content = lines.slice(index + 1).join('\n');
  return { index, hash: createHash('sha256').update(content, 'utf8').digest('hex') };
}

const sourceArchived = (sourceConfig.archived ?? []).map((entry) => {
  const absolute = join(repoRoot, entry.path);
  if (!existsSync(absolute)) {
    return { ...entry, path: entry.path, exists: false, marker: entry.contentStartMarker ?? sourceMarkerDefault };
  }
  const text = read(absolute).replace(/\r\n/g, '\n');
  const marker = entry.contentStartMarker ?? sourceMarkerDefault;
  const { index, hash } = contentHashOf(text, marker);
  const lines = text.split('\n');
  const labels = tableLabels(index === -1 ? lines : lines.slice(0, index));
  return {
    path: entry.path,
    exists: true,
    marker,
    hasMarker: index !== -1,
    requiredLabels: entry.requiredLabels ?? [],
    hashLabel: entry.hashLabel ?? 'sha256',
    labels,
    recordedHash: (/([0-9a-f]{64})/.exec(labels[entry.hashLabel] ?? '') ?? [])[1] ?? '',
    computedHash: hash,
  };
});

const sourceExtractors = (sourceConfig.extractors ?? []).map((entry) => {
  const absolute = join(repoRoot, entry.path);
  const links = [];
  if (existsSync(absolute)) {
    for (const line of read(absolute).replace(/\r\n/g, '\n').split('\n')) {
      const prose = line.split('`').filter((_, i) => i % 2 === 0).join('');
      for (const match of prose.matchAll(/\[([^\]]*)\]\(([^()\s]+)\)/g)) {
        const target = decodeURIComponent(match[2].split('#')[0]);
        if (target === '' || /^(https?:|mailto:)/.test(target)) continue;
        links.push({ target: rel(resolve(dirname(absolute), target)), linkText: match[1], lineText: line });
      }
    }
  }
  return { path: entry.path, mustLinkTo: entry.mustLinkTo, links };
});

const sourceLines = evaluateSourceLines({ archived: sourceArchived, extractors: sourceExtractors, markers: sourceMarkers });
for (const message of sourceLines.errors) error(message);
for (const message of sourceLines.warnings) warn(message);

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
console.log(
  `[docs] 已索引文档 ${index.docs.length} 份，合计 ${Math.round(totalKb)} KB；` +
    `精简层 ${layered.slimKb.toFixed(1)}/${budget.slimKb} KB（另：用户手册 ${layered.userFacingKb.toFixed(1)} KB、临时计划 ${layered.exemptKb.toFixed(1)} KB）、` +
    `必读 ${layered.mustReadKb.toFixed(1)}/${budget.mustReadKb} KB；台账条目 ${ledgerEntries.length} 条；` +
    `存档覆盖轮次 ${roundOwners.size} 个（上界 R${ledgerMaxRound === null ? '?' : String(ledgerMaxRound)} 由台账推导，旧实现硬编码 26）`,
);

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

console.log('[docs] 检查通过：链接 / 锚点 / 台账 / 存档覆盖 / 体量 / 分层预算与入口封闭性 / 跨层引用标记词 / 仓库外路径 / 来源行与保真 / 策略不变量。');

// ── 自检（反向保护的钉子：每类判定都要有"该绿就绿、该红就红"的合成用例） ──
//
// 它不读仓库：合成输入直接喂给 evaluateLayers()，因此"预算内即绿"这条钉子不会随时间失效。

function selftest() {
  const budget = { slimKb: 100, mustReadKb: 25, entryCapKb: 6 };
  const entry = (links = []) => ({ path: 'docs/README.md', kb: 3, links });
  const cases = [];

  cases.push({
    name: '精简层超预算被点名并列出清单',
    result: evaluateLayers({ rows: [{ path: 'a.md', layer: 'slim', kb: 150 }], budget, entry: entry() }),
    expect: (r) => r.errors.some((m) => m.includes('精简层超预算')) && r.errors.some((m) => m.includes('a.md')) && r.slimKb === 150,
  });
  cases.push({
    name: '必读层超预算被点名',
    result: evaluateLayers({ rows: [{ path: 'r.md', layer: 'slim', mustRead: true, kb: 30 }], budget, entry: entry() }),
    expect: (r) => r.errors.some((m) => m.includes('必读层超预算')),
  });
  cases.push({
    name: '入口指向归档层判错、指向精简层通过',
    result: evaluateLayers({
      rows: [{ path: 'a.md', layer: 'slim', kb: 1 }],
      budget,
      entry: entry([
        { line: 3, target: 'x.md', kind: 'file', layer: 'archive' },
        { line: 4, target: 'a.md', kind: 'file', layer: 'slim' },
      ]),
    }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('指向归档层'),
  });
  cases.push({
    name: '入口指向未登记分层的文档判错',
    result: evaluateLayers({ rows: [], budget, entry: entry([{ line: 1, target: 'x.md', kind: 'file', layer: undefined }]) }),
    expect: (r) => r.errors.some((m) => m.includes('未登记分层')),
  });
  cases.push({
    name: '目录链接含归档物判错、含未登记文档只警告',
    result: evaluateLayers({
      rows: [],
      budget,
      entry: entry([{ line: 2, target: 'dir/', kind: 'directory', nested: [{ path: 'dir/a.md', layer: 'archive' }], unindexed: 2 }]),
    }),
    expect: (r) => r.errors.some((m) => m.includes('归档层文档')) && r.warnings.some((m) => m.includes('未登记文档')),
  });
  cases.push({
    name: 'userFacing 与 budgetExempt 不计入精简层预算',
    result: evaluateLayers({
      rows: [
        { path: 'g.md', layer: 'slim', userFacing: true, kb: 50 },
        { path: 'p.md', layer: 'slim', budgetExempt: true, kb: 50 },
      ],
      budget,
      entry: entry(),
    }),
    expect: (r) => r.errors.length === 0 && r.slimKb === 0,
  });
  cases.push({
    name: 'generated（可推导的生成物）与 userFacing/budgetExempt 一样不计入精简层预算',
    result: evaluateLayers({
      rows: [
        { path: 'g.md', layer: 'slim', userFacing: true, kb: 50 },
        { path: 'p.md', layer: 'slim', budgetExempt: true, kb: 50 },
        { path: 'i.md', layer: 'slim', generated: true, kb: 50 },
      ],
      budget,
      entry: entry(),
    }),
    expect: (r) => r.errors.length === 0 && r.slimKb === 0 && r.generatedKb === 50,
  });
  cases.push({
    name: 'layer 不在闭集内判错',
    result: evaluateLayers({ rows: [{ path: 'a.md', layer: 'temp', kb: 1 }], budget, entry: entry() }),
    expect: (r) => r.errors.some((m) => m.includes('不在闭集内')),
  });

  // §8c：跨层引用的标记词
  const markers = ['历史', '原文口径', '细则', '依据', '存档'];
  const link = (over) => ({ path: 'docs/a.md', line: 7, target: 'docs/00-baseline/裁决R31.md', raw: '裁决R31.md', linkText: 'P-32', lineText: '见 [P-32](裁决R31.md)', ...over });
  cases.push({
    name: '跨层引用缺标记词判错（按文档聚合）',
    result: evaluateCrossLayer({ links: [link({}), link({ line: 9 }), link({ line: 11 })], markers }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('docs/a.md') && r.errors[0].includes('3 处'),
  });
  cases.push({
    name: '链接文本或同行带标记词即通过',
    result: evaluateCrossLayer({ links: [link({ linkText: 'P-32 细则' }), link({ lineText: '依据：[P-32](裁决R31.md)' })], markers }),
    expect: (r) => r.errors.length === 0,
  });
  cases.push({
    name: '带 reason 的例外压住跨层命中',
    result: evaluateCrossLayer({ links: [link({})], markers, allow: [{ path: 'docs/a.md', reason: '生成物：逐份列出全部文档' }] }),
    expect: (r) => r.errors.length === 0,
  });
  cases.push({
    name: '超出台账上界的轮次引用只警告',
    result: evaluateCrossLayer({ links: [], markers, maxRound: 47, roundMentions: [{ path: 'docs/a.md', line: 304, round: 50 }] }),
    expect: (r) => r.errors.length === 0 && r.warnings.some((m) => m.includes('R50') && m.includes('R47')),
  });

  // §8d：仓库外路径与 gitignore 引用（决策 8）
  const extMarkers = ['gitignore', '不入库', '可再生'];
  const externalAllow = [{ pathRegex: '^docs/00-baseline/', lineRegex: '来源', kind: '来源元信息', reason: '来源行必须记原始路径 + sha256' }];
  cases.push({
    name: '可复现层的本机绝对路径判错（按文档聚合）',
    result: evaluateExternalPaths({
      hits: [
        { path: 'docs/a.md', line: 3, kind: 'absolute', scope: 'reproducible', text: 'D:\\Downloads\\x.md', lineText: '由 `D:\\Downloads\\x.md` 提取' },
        { path: 'docs/a.md', line: 9, kind: 'absolute', scope: 'reproducible', text: '~/x.md', lineText: '见 ~/x.md' },
      ],
      markers: extMarkers,
    }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('docs/a.md') && r.errors[0].includes('2 处') && r.warnings.length === 0,
  });
  cases.push({
    name: '归档 / 证据层的绝对路径只聚合成一条存量警告',
    result: evaluateExternalPaths({
      hits: [
        { path: 'spikes/s/结论.md', line: 1, kind: 'absolute', scope: 'archive', text: 'C:\\Program Files', lineText: 'x' },
        { path: 'apps/web/evidence/e.md', line: 26, kind: 'absolute', scope: 'archive', text: 'D:\\w\\tmp\\a.xlsx', lineText: 'x' },
      ],
      markers: extMarkers,
    }),
    expect: (r) => r.errors.length === 0 && r.warnings.length === 1 && r.warnings[0].includes('2 份文档') && r.warnings[0].includes('C8'),
  });
  cases.push({
    name: 'gitignore 的临时路径引用缺声明词判警告、带声明词通过',
    result: evaluateExternalPaths({
      hits: [
        { path: 'CONTRIBUTING.md', line: 70, kind: 'temporary', scope: 'reproducible', target: 'tmp/<profile>/<ts>', declared: false, lineText: '起浏览器时一律用 `tmp/…` 做 --user-data-dir' },
        { path: 'CONTRIBUTING.md', line: 92, kind: 'temporary', scope: 'reproducible', target: 'tmp/samples/x.xlsx', declared: true, lineText: '（已 gitignore，不入库二进制）' },
      ],
      markers: extMarkers,
    }),
    expect: (r) => r.errors.length === 0 && r.warnings.length === 1 && r.warnings[0].includes('CONTRIBUTING.md') && r.warnings[0].includes('声明词'),
  });
  cases.push({
    name: '归档层的临时路径引用不判（记录制不改写）',
    result: evaluateExternalPaths({
      hits: [{ path: 'docs/01-roadmap/首版-记录-G5.md', line: 97, kind: 'temporary', scope: 'archive', target: 'tmp/nc-evidence/', declared: false, lineText: '工件在 `tmp/nc-evidence/`' }],
      markers: extMarkers,
    }),
    expect: (r) => r.errors.length === 0 && r.warnings.length === 0,
  });
  cases.push({
    name: '例外表（来源元信息）压住命中，且可按 lineRegex 收窄',
    result: evaluateExternalPaths({
      hits: [
        { path: 'docs/00-baseline/原文.md', line: 2, kind: 'absolute', scope: 'reproducible', text: 'D:\\Downloads\\x.md', lineText: '> 来源：`D:\\Downloads\\x.md`（sha256 …）' },
        { path: 'docs/00-baseline/需求基线.md', line: 3, kind: 'absolute', scope: 'reproducible', text: 'D:\\Downloads\\x.md', lineText: '由 `D:\\Downloads\\x.md` 提取并重编号' },
      ],
      markers: extMarkers,
      allow: externalAllow,
    }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('需求基线.md'),
  });
  cases.push({
    name: '.gitignore 匹配器：目录 / 通配 / 锚定 / 反选',
    result: (() => {
      const ignored = makeGitignoreMatcher(['node_modules/', 'dist/', 'dist-offline/', '!dist/keep.txt', 'spikes/*/out/', 'tmp/', '*.tmp'].join('\n'));
      return {
        ignored: ['tmp/samples/a.xlsx', 'apps/web/dist-offline/index.html', 'spikes/g0-s1/out/a.pptx', 'a/b/x.tmp', 'node_modules/x'].map(ignored),
        kept: ['README.md', 'docs/a.md', 'dist/keep.txt'].map((p) => !ignored(p)),
      };
    })(),
    expect: (r) => r.ignored.every(Boolean) && r.kept.every(Boolean),
  });
  cases.push({
    name: '临时路径判定面只收 tmp/ 一类：可再生构建产物（dist/）不在内',
    result: (() => {
      const temporary = makeGitignoreMatcher(['tmp/', '*.tmp'].join('\n'));
      return { temporary: ['tmp/x.md', 'a/b/scratch.tmp'].map(temporary), build: ['apps/web/dist/index.html', 'packages/engine/dist/index.js'].map((p) => !temporary(p)) };
    })(),
    expect: (r) => r.temporary.every(Boolean) && r.build.every(Boolean),
  });

  // §8e：来源行与保真（决策 8）
  const srcMarkers = ['原文口径', '依据', '来源'];
  const archivedOk = {
    path: 'docs/00-baseline/原文.md',
    exists: true,
    marker: '<!-- 原文内容开始',
    hasMarker: true,
    requiredLabels: ['来源', '入库件正文 sha256'],
    labels: { 来源: 'x', '入库件正文 sha256': 'a'.repeat(64) },
    hashLabel: '入库件正文 sha256',
    recordedHash: 'a'.repeat(64),
    computedHash: 'a'.repeat(64),
  };
  const extractorOk = {
    path: 'docs/00-baseline/需求基线.md',
    mustLinkTo: 'docs/00-baseline/原文.md',
    links: [{ target: 'docs/00-baseline/原文.md', linkText: '上游原文（原文口径）', lineText: '由 [上游原文（原文口径）](原文.md) 提取' }],
  };
  cases.push({
    name: '溯源：入仓原文 + 提取件都合规即绿',
    result: evaluateSourceLines({ archived: [archivedOk], extractors: [extractorOk], markers: srcMarkers }),
    expect: (r) => r.errors.length === 0,
  });
  cases.push({
    name: '溯源：入库正文被改（哈希不符）判错',
    result: evaluateSourceLines({ archived: [{ ...archivedOk, computedHash: 'b'.repeat(64) }], extractors: [], markers: srcMarkers }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('被改过') && r.errors[0].includes('不得回改'),
  });
  cases.push({
    name: '溯源：来源块缺必填项 / 缺内容起始标记判错',
    result: evaluateSourceLines({
      archived: [{ ...archivedOk, labels: { 来源: 'x' }, hasMarker: false }],
      extractors: [],
      markers: srcMarkers,
    }),
    expect: (r) => r.errors.some((m) => m.includes('缺必填项') && m.includes('入库件正文 sha256')) && r.errors.some((m) => m.includes('缺少内容起始标记')),
  });
  cases.push({
    name: '溯源：提取件摘掉指向原文的链接判错',
    result: evaluateSourceLines({ archived: [archivedOk], extractors: [{ ...extractorOk, links: [] }], markers: srcMarkers }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('没有指向入仓原文的链接'),
  });
  cases.push({
    name: '溯源：提取件指向原文但缺标记词判错',
    result: evaluateSourceLines({
      archived: [archivedOk],
      extractors: [{ ...extractorOk, links: [{ target: 'docs/00-baseline/原文.md', linkText: '上游原文', lineText: '由 [上游原文](原文.md) 提取' }] }],
      markers: srcMarkers,
    }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('没有标记词'),
  });
  cases.push({
    name: '溯源：入仓原文不存在判错',
    result: evaluateSourceLines({ archived: [{ ...archivedOk, exists: false }], extractors: [], markers: srcMarkers }),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('入仓原文不存在'),
  });

  let failed = 0;
  for (const item of cases) {
    const ok = item.expect(item.result);
    if (!ok) failed += 1;
    console.log(`[docs] 自检 ${ok ? '✅' : '❌'} ${item.name}`);
  }
  if (failed > 0) {
    console.error(`[docs] 自检未通过：${failed}/${cases.length} 例`);
    process.exit(1);
  }
  console.log(`[docs] 自检通过 ${cases.length}/${cases.length} 例`);
  process.exit(0);
}
