#!/usr/bin/env node
/**
 * `pnpm docs:check` 的第二步：**契约常量单点声明**（P1-a；规范补充见 `docs/DOC-SPEC.md`）。
 *
 * 为什么需要它：同一个契约常量（`c₃` 逐档位锚值、`c₄` 的 `overlay`、`EXPORT_TICK_LENGTH_PX`、
 * `HEADER_HEIGHT_PX`、性能阈值、诊断码表条目数、轴色值…）会在 ADR 正文、包规范、CONTRIBUTING、
 * 测量脚本与证据 Markdown 之间各写一份。三处各自自洽时**没有任何单测能抓到**——既有的 809 例
 * 测试在结构上抓不到"分叉"，因为它们各自读自己那一份。本脚本把"分叉"变成会失败的断言。
 *
 * 顶层约定（与 `check-docs.mjs` 一致）：
 * - **零依赖**、只读、不加时间戳；`error` 阻断门禁；
 * - **唯一真相源是 `docs/doc-index.json` 的 `constantCheck`**：声明处与检测形态都在那里，
 *   本文件不留第二份清单；
 * - 判定是**机械的**（正则 + 捕获组比对），不做语义判断——"这句历史该不该留"由人裁决，
 *   裁决结果写进 `constantCheck.allow`（每条必须带 `reason`）。
 *
 * 用法：
 * - `node scripts/check-constants.mjs`            对全仓现状判定
 * - `node scripts/check-constants.mjs --selftest` 只跑引擎自检（不读仓库，不需要任何依赖）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (absolute) => relative(repoRoot, absolute).split(sep).join('/');

/** 目录级排除（与 `.gitignore` 的语义一致，但本脚本不读 .gitignore）。 */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'dist-offline', 'build', 'out', 'tmp', '.git', 'coverage', '.husky']);

function walkFiles(startDir, extensions) {
  const found = [];
  if (!existsSync(startDir)) return found;
  const stack = [startDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(join(current, entry.name));
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(rel(join(current, entry.name)));
      }
    }
  }
  return found;
}

// ── 引擎（与仓库解耦，便于 --selftest 用合成输入驱动） ──────────────────────

function buildLineIndex(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** 数值比对前的归一：去掉下划线/空格/全角空格并转小写（`1_000_000` 与 `1000000` 同值）。 */
const normalize = (text) => String(text ?? '').trim().toLowerCase().replace(/[\s_\u00a0]/g, '');

const matchesRule = (rule, path) => {
  if (typeof rule.path === 'string') return rule.path === path;
  if (typeof rule.pathRegex === 'string') return new RegExp(rule.pathRegex).test(path);
  return false;
};

/**
 * 对给定文件集合运行常量检查。
 *
 * @param {{ config: object, files: string[], read: (path: string) => string | null }} input
 * @returns {{ errors: string[], findings: object[], perConstant: Map<string, object> }}
 */
export function runConstantCheck({ config, files, read }) {
  const errors = [];
  const findings = [];
  const perConstant = new Map();
  const globalAllow = config.allow ?? [];
  let skippedMultiline = 0;

  for (const rule of globalAllow) {
    if (typeof rule.reason !== 'string' || rule.reason === '') errors.push(`[常量] constantCheck.allow 的例外缺 reason：${JSON.stringify(rule)}`);
    if (typeof rule.path !== 'string' && typeof rule.pathRegex !== 'string') errors.push(`[常量] constantCheck.allow 的例外既无 path 也无 pathRegex：${JSON.stringify(rule)}`);
  }

  for (const entry of config.constants ?? []) {
    const id = entry.id;
    const where = (path, line) => `${path}:${String(line)}`;
    const stats = { id, title: entry.title ?? '', hits: 0, scans: 0 };
    perConstant.set(id, stats);
    const entryErrors = (message) => errors.push(`[常量:${String(id)}] ${message}`);

    for (const rule of entry.allow ?? []) {
      if (typeof rule.reason !== 'string' || rule.reason === '') entryErrors(`allow 的例外缺 reason：${JSON.stringify(rule)}`);
    }

    const declaration = entry.declaration ?? {};
    const isCount = entry.compare === 'count';
    const patterns = declaration.patterns ?? (declaration.pattern === undefined ? [] : [declaration.pattern]);
    if (typeof declaration.path !== 'string') {
      entryErrors('declaration.path 缺失（每个常量必须登记唯一声明处）');
      continue;
    }
    if (patterns.length === 0 && !isCount) {
      entryErrors(`declaration 缺 pattern/patterns：${declaration.path}`);
      continue;
    }
    if (isCount && (typeof declaration.container !== 'string' || typeof declaration.item !== 'string')) {
      entryErrors('compare=count 需要 declaration.container（表的容器正则）与 declaration.item（逐条正则，按行匹配）');
      continue;
    }
    const declarationText = read(declaration.path);
    if (declarationText === null) {
      entryErrors(`声明处文件不存在：${declaration.path}`);
    }

    /** 权威值（compare=site 时为 null）：声明处正则的捕获组，或表内条目数。 */
    let authority = null;
    /** compare=count 时：声明处里"表"本身的字符区间（表外的自述仍要判）。 */
    let containerSpan = null;
    if (declarationText !== null) {
      if (isCount) {
        const containerMatch = declarationText.match(new RegExp(declaration.container));
        if (containerMatch === null) {
          entryErrors(`声明处未找到码表容器：${declaration.path} 不匹配 /${declaration.container}/（检查表已腐烂）`);
        } else {
          authority = [String((containerMatch[0].match(new RegExp(declaration.item, 'gm')) ?? []).length)];
          const start = containerMatch.index ?? 0;
          containerSpan = [start, start + containerMatch[0].length];
        }
      } else if (entry.compare === 'declaration') {
        const match = declarationText.match(new RegExp(patterns[0]));
        if (match === null || match.length < 2) {
          entryErrors(`声明处未找到权威值：${declaration.path} 不匹配 /${patterns[0]}/（检查表已腐烂：先修表，或改声明处）`);
        } else {
          authority = match.slice(1).map(normalize);
        }
      } else {
        for (const pattern of patterns) {
          if (!new RegExp(pattern).test(declarationText)) {
            entryErrors(`声明处缺表项：${declaration.path} 不含 /${pattern}/（该常量目前没有单点声明，见 P3/C5 的常量单点化批次）`);
          }
        }
      }
    }

    const allowed = (path) =>
      [...globalAllow, ...(entry.allow ?? [])].some((rule) => matchesRule(rule, path));

    for (const path of files) {
      const isDeclarationFile = path === declaration.path;
      // 声明处本身就是权威陈述；但 compare=count 的"表"之外（例如文件头注释自述条数）仍要判。
      if (isDeclarationFile && containerSpan === null) continue;
      if (Array.isArray(entry.scanPaths) && !entry.scanPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
      const text = read(path);
      if (text === null) continue;
      stats.scans += 1;
      const starts = buildLineIndex(text);
      const seen = new Set(); // 同一行同一值被多个 detector 命中只报一次（detector 之间共享）

      for (const detector of entry.detectors ?? []) {
        let regex;
        try {
          regex = new RegExp(detector.pattern, 'g');
        } catch (cause) {
          entryErrors(`detector 正则非法（${detector.label ?? detector.pattern}）：${String(cause)}`);
          continue;
        }
        for (const match of text.matchAll(regex)) {
          // detector 一律**按行判定**：跨行命中（`\s` 吃掉了换行）会把两个不同的数字粘成一次命中，
          // 既打印不出准确位置，也会制造假错值。跨行形态请改声明处或拆成两个 detector。
          if ((match[0] ?? '').includes('\n')) {
            skippedMultiline += 1;
            continue;
          }
          const groups = match.slice(1).map(normalize);
          if (groups.length === 0) {
            entryErrors(`detector 必须至少有一个捕获组（否则只有"有/没有"，打印不出位置与值）：${detector.pattern}`);
            break;
          }
          const line = lineAt(starts, match.index ?? 0);
          if (allowed(path)) continue;
          if (
            isDeclarationFile &&
            containerSpan !== null &&
            (match.index ?? 0) >= containerSpan[0] &&
            (match.index ?? 0) < containerSpan[1]
          ) {
            continue; // 表内条目由 authority 直接读取，不是"第二声明"
          }

          let kind;
          let detail;
          if (entry.compare !== 'site') {
            const equals = detector.equals ?? groups.map((_, index) => index);
            if (equals.length !== groups.length) {
              entryErrors(`detector 的 equals 长度 ${String(equals.length)} 与捕获组数 ${String(groups.length)} 不符：${detector.pattern}`);
              break;
            }
            if (authority === null) {
              kind = '位置错误';
              detail = '声明处缺失，无法比对值';
            } else if (equals.some((groupIndex, index) => authority[groupIndex] !== groups[index])) {
              kind = '错值';
              detail = `声明处为 ${authority.join(' / ')}`;
            } else {
              kind = '重复陈述';
              detail = `与声明处同值（${groups.join(' / ')}）`;
            }
          } else {
            kind = '重复陈述';
            detail = `compare=site 只判位置（捕获值 ${groups.join(' / ')}）`;
          }

          const key = `${kind}\u0000${String(line)}\u0000${groups.join('/')}`;
          if (seen.has(key)) continue; // 同一行同一值被多个 detector 命中只报一次
          seen.add(key);
          stats.hits += 1;
          findings.push({
            constant: id,
            path,
            line,
            label: detector.label ?? detector.pattern,
            kind,
            detail,
            text: (text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length) || '').trim(),
            declaration: declaration.path,
            where: where(path, line),
          });
        }
      }
    }
  }

  return { errors, findings, perConstant, skippedMultiline };
}

// ── 仓库侧：扫描集合来自 doc-index.json ────────────────────────────────────

function collectScanFiles(index, config) {
  const files = new Set();
  const docScan = config.docScan ?? {};
  const extraPaths = docScan.extraPaths ?? [];
  const roles = new Set(docScan.roles ?? []);
  for (const entry of index.docs ?? []) {
    if (roles.has(entry.role) || extraPaths.includes(entry.path)) files.add(entry.path);
  }
  const codeScan = config.codeScan ?? {};
  for (const root of codeScan.roots ?? []) {
    for (const path of walkFiles(join(repoRoot, root), codeScan.extensions ?? ['.ts', '.mts', '.vue', '.mjs'])) files.add(path);
  }
  return [...files].sort();
}

function main() {
  const indexPath = join(repoRoot, 'docs/doc-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const config = index.constantCheck;
  if (config === undefined) {
    console.error('[常量] docs/doc-index.json 缺 constantCheck：契约常量单点声明检查无法运行（P1-a 的产出）');
    process.exit(1);
  }

  const files = collectScanFiles(index, config);
  const cache = new Map();
  const read = (path) => {
    const absolute = join(repoRoot, path);
    if (!existsSync(absolute)) return null;
    if (!cache.has(path)) cache.set(path, readFileSync(absolute, 'utf8'));
    return cache.get(path);
  };

  const { errors, findings, perConstant, skippedMultiline } = runConstantCheck({ config, files, read });

  const docs = files.filter((path) => path.endsWith('.md')).length;  const totalKb = files.reduce((sum, path) => {
    const absolute = join(repoRoot, path);
    return sum + (existsSync(absolute) ? statSync(absolute).size / 1024 : 0);
  }, 0);
  console.log(
    `[常量] 唯一声明处 ${String(perConstant.size)} 个；扫描 ${String(docs)} 份文档 + ${String(files.length - docs)} 个源码文件（${String(Math.round(totalKb))} KB）；命中 ${String(findings.length)} 处`,
  );

  for (const [id, stats] of perConstant) {
    console.log(`[常量]   ${stats.hits === 0 ? '✅' : '❌'} ${id}：${String(stats.hits)} 处` + (stats.hits === 0 ? '' : `（${stats.title}）`));
  }

  if (skippedMultiline > 0) {
    console.log(`[常量] 注：丢弃跨行命中 ${String(skippedMultiline)} 处（detector 按行判定；若某个常量只能跨行命中，请拆成两个 detector）`);
  }

  if (findings.length > 0) {
    const wrong = findings.filter((finding) => finding.kind === '错值').length;
    console.log(`\n[常量] 非声明处的重述 ${String(findings.length)} 处（其中错值 ${String(wrong)} 处）：`);
    for (const [id, stats] of perConstant) {
      const own = findings.filter((finding) => finding.constant === id);
      if (own.length === 0) continue;
      console.log(`\n  ── ${id}：${String(own.length)} 处 — ${stats.title}`);
      for (const finding of own.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) {
        const marker = finding.kind === '错值' ? '错值' : '重复';
        console.log(`     ${marker}  ${finding.where}  ${finding.kind}：${finding.text === '' ? finding.label : finding.text}`);
        console.log(`           ${finding.detail}；唯一声明处 ${finding.declaration}`);
      }
    }
    console.log('');
  }

  const messages = [...errors];
  for (const finding of findings) {
    messages.push(`[常量:${finding.constant}] ${finding.kind}：${finding.where} → ${finding.detail}`);
  }

  if (messages.length > 0) {
    console.error(`\n[常量] 错误 ${String(messages.length)} 条：`);
    for (const message of messages) console.error(`  error ${message}`);
    console.error('\n[常量] 检查未通过。修法只有两种：把重述改为指回声明处，或在 constantCheck 里登记带 reason 的例外。');
    process.exit(1);
  }
  console.log('[常量] 检查通过：每个契约常量只有一处字面量声明。');
}

// ── 自检（反向保护的钉子：修好后必须绿） ───────────────────────────────────

function selftest() {
  const baseConfig = (entry) => ({ constants: [entry], allow: [] });
  const declaration = { path: 'src/decl.ts', pattern: 'export const K = (\\d+);' };
  const detector = { pattern: 'K\\s*=\\s*(\\d+)', label: 'K = N' };
  const cases = [];

  const readOf = (files) => (path) => files[path] ?? null;

  // ① 声明处之外出现**同值** ⇒ 重复陈述
  cases.push({
    name: '同值重述被判为重复陈述',
    result: runConstantCheck({
      config: baseConfig({ id: 'k', compare: 'declaration', declaration, detectors: [detector] }),
      files: ['src/decl.ts', 'docs/a.md'],
      read: readOf({ 'src/decl.ts': 'export const K = 7;', 'docs/a.md': '见 `K = 7`（与声明处同值）' }),
    }),
    expect: (r) => r.findings.length === 1 && r.findings[0].kind === '重复陈述' && r.errors.length === 0,
  });

  // ② 声明处之外出现**错值** ⇒ 错值（负向对照要能打印出"错在哪"）
  cases.push({
    name: '异值重述被判为错值',
    result: runConstantCheck({
      config: baseConfig({ id: 'k', compare: 'declaration', declaration, detectors: [detector] }),
      files: ['src/decl.ts', 'docs/a.md'],
      read: readOf({ 'src/decl.ts': 'export const K = 7;', 'docs/a.md': '旧口径 `K = 3`' }),
    }),
    expect: (r) => r.findings.length === 1 && r.findings[0].kind === '错值' && r.findings[0].detail.includes('7'),
  });

  // ③ 只有声明处出现 ⇒ 绿
  cases.push({
    name: '只在声明处出现即通过',
    result: runConstantCheck({
      config: baseConfig({ id: 'k', compare: 'declaration', declaration, detectors: [detector] }),
      files: ['src/decl.ts', 'docs/a.md'],
      read: readOf({ 'src/decl.ts': 'export const K = 7;', 'docs/a.md': '常量见 `decl.ts`' }),
    }),
    expect: (r) => r.findings.length === 0 && r.errors.length === 0,
  });

  // ④ 例外登记（带 reason）能压住命中
  cases.push({
    name: '带 reason 的例外压住命中',
    result: runConstantCheck({
      config: baseConfig({
        id: 'k',
        compare: 'declaration',
        declaration,
        detectors: [detector],
        allow: [{ pathRegex: '^docs/', reason: '存档逐字不改写' }],
      }),
      files: ['src/decl.ts', 'docs/a.md'],
      read: readOf({ 'src/decl.ts': 'export const K = 7;', 'docs/a.md': '旧口径 `K = 3`' }),
    }),
    expect: (r) => r.findings.length === 0 && r.errors.length === 0,
  });

  // ⑤ 声明处腐烂（正则失配）必须报错，而不是静默变绿
  cases.push({
    name: '声明处失配被判为表已腐烂',
    result: runConstantCheck({
      config: baseConfig({ id: 'k', compare: 'declaration', declaration, detectors: [detector] }),
      files: ['src/decl.ts', 'docs/a.md'],
      read: readOf({ 'src/decl.ts': 'export const K = "seven";', 'docs/a.md': '`K = 7`' }),
    }),
    expect: (r) => r.errors.some((message) => message.includes('声明处未找到权威值')),
  });

  // ⑥ compare=site：值相同也必须报（用于色值、性能阈值一类"只判位置"的常量）
  cases.push({
    name: 'compare=site 只判位置',
    result: runConstantCheck({
      config: baseConfig({
        id: 'k',
        compare: 'site',
        declaration: { path: 'src/decl.ts', patterns: ["export const K = '(#[0-9a-f]{6})';"] },
        detectors: [{ pattern: "'(#[0-9a-f]{6})'", label: '色值' }],
      }),
      files: ['src/decl.ts', 'apps/x.vue'],
      read: readOf({ 'src/decl.ts': "export const K = '#cfe3fa';", 'apps/x.vue': "background: '#cfe3fa';" }),
    }),
    expect: (r) => r.findings.length === 1 && r.findings[0].kind === '重复陈述',
  });

  // ⑦ detector 按行判定：靠 `\s` 吃掉换行的跨行命中必须被丢弃（否则会把两行的数字粘成假错值）
  cases.push({
    name: '跨行命中被丢弃',
    result: runConstantCheck({
      config: baseConfig({ id: 'k', compare: 'declaration', declaration, detectors: [{ pattern: 'K\\s*=\\s*(\\d+)', label: 'K = N' }] }),
      files: ['src/decl.ts', 'docs/a.md'],
      read: readOf({ 'src/decl.ts': 'export const K = 7;', 'docs/a.md': 'K\n  = 3' }),
    }),
    expect: (r) => r.findings.length === 0 && r.skippedMultiline === 1,
  });

  // ⑧ 检测器的"写法面"要盖住改口径的常见说法（D4 补的盲点）：
  //    实测漏网的是"`c₄` **已重定为** `6·rows + 12`"——它既没有 `=` 也不是"扩成"，于是错值静默通过。
  cases.push({
    name: '改口径的说法（重定为/改为）也能命中',
    result: runConstantCheck({
      config: baseConfig({
        id: 'k',
        compare: 'declaration',
        declaration: { path: 'src/decl.ts', pattern: 'export const M = \\{ rows: (\\d+), overlay: (\\d+) \\};' },
        detectors: [{ pattern: '重定为\\s*`?(\\d+)\\s*·\\s*rows\\s*\\+\\s*(\\d+)', equals: [0, 1], label: '重定为 a·rows + b' }],
      }),
      files: ['src/decl.ts', 'docs/a.md'],
      // 夹具用插值拼出数字：否则这段字面量本身会被 codeScan 扫到（脚本自己也是扫描面）。
      read: readOf({ 'src/decl.ts': 'export const M = { rows: 6, overlay: 13 };', 'docs/a.md': `批次 B ⇒ 已重定为 \`6·rows + ${String(12)}\`` }),
    }),
    expect: (r) => r.findings.length === 1 && r.findings[0].kind === '错值' && r.findings[0].detail.includes('13'),
  });

  let failed = 0;
  for (const item of cases) {
    const ok = item.expect(item.result);
    if (!ok) failed += 1;
    console.log(`[常量] 自检 ${ok ? '✅' : '❌'} ${item.name}`);
  }
  if (failed > 0) {
    console.error(`[常量] 自检未通过：${String(failed)}/${String(cases.length)} 例失败`);
    process.exit(1);
  }
  console.log(`[常量] 自检通过 ${String(cases.length)}/${String(cases.length)} 例`);
}

if (process.argv.includes('--selftest')) selftest();
else main();
