#!/usr/bin/env node
/**
 * `pnpm docs:check` 的第三步：**包规范的 API 段 ⇔ 实际导出面**（P4-a；判据见
 * `docs/04-refactor/04-验收与门禁.md` §二 的 P4 ①）。
 *
 * 为什么需要它：`templateSheetNames()` 那类失真（`PROTOCOL.md` 文档化了一个从来不存在的函数）
 * 是靠人读出来的——它既不违反任何链接/锚点/常量检查，也不会让 809 例测试变红。本脚本把
 * 「规范点名的符号必须真的从包入口导出」变成会失败的断言。
 *
 * ## 判定的是哪一半
 * **只判一个方向**：规范里**点名**的符号 ⊆ 包入口（`packages/<pkg>/src/index.ts` 及其再导出）的导出面。
 * 反向（"哪些导出是发布承诺、哪些是内部"）**不在本脚本**——那是 P4-b 的公开面分类。
 * 之所以判"点名 ⊆ 导出"这一半：它正好抓住"文档化了不存在的东西"，而反向那一半在
 * `render-core` 有 296 个导出、逐条要求文档化只会制造噪声。
 *
 * ## 提取面（刻意的窄）
 * 只取**被登记段落的直属声明块**——从该段标题到**下一个任意级标题**为止（子节不算）。
 * 理由是 P4-a 实测出来的：子节里是"用法示例"，会引用**别的包**的函数
 * （`PROTOCOL.md` §2.1 的 `applyCommand` 属 `engine`），把它算作本包的导出承诺是假阳。
 * 段内只认两类形态：**围栏代码块**（`fences`）与**首格为符号的表格**（`apiTable`）。
 *
 * ## 防静默失效
 * 每个 target 必须登记 `minCandidates`：候选数掉到下限以下 ⇒ **报错**（"提取面塌了"），
 * 因为"改了写法 ⇒ 正则一条也不匹配 ⇒ 检查恒真"正是这类机械检查最危险的失效方式
 * （同 `check-docs.mjs` 的"台账轮次列解析为空即报错"）。
 *
 * 顶层约定（与 `check-docs.mjs` / `check-constants.mjs` 一致）：
 * **零依赖**、只读、不加时间戳；`error` 阻断门禁；唯一真相源是 `docs/doc-index.json` 的
 * `apiSurfaceCheck`（本文件不留第二份清单）；例外必须登记在 `allow` 且带 `reason`。
 *
 * 用法：
 * - `node scripts/check-api-surface.mjs`            对全仓现状判定
 * - `node scripts/check-api-surface.mjs --selftest` 只跑引擎自检（不读仓库）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './paths.mjs';

/** 语法关键字：裸调用形态的误报主要来自它们（`if (…)` / `for (…)` / `typeof (…)`）。 */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'typeof', 'await', 'new', 'function', 'const', 'let', 'var',
  'class', 'interface', 'type', 'enum', 'import', 'export', 'catch', 'do', 'else', 'case', 'break',
  'continue', 'throw', 'delete', 'in', 'instanceof', 'void', 'yield', 'super', 'this', 'null', 'true',
  'false', 'undefined', 'as', 'satisfies', 'declare', 'readonly', 'extends', 'implements', 'default',
  'static', 'get', 'set', 'public', 'private', 'protected', 'abstract', 'keyof', 'infer', 'is',
]);

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s/;
const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * 去掉行注释。
 * 证据：`SCHEDULE.md` §三 的 `readonly projectFinish: number;      // max(ef)；…`——
 * 不剥注释的话，裸调用形态会把注释里的 `max(` 当成一个被点名的符号（实测的假阳）。
 * `://` 不当注释（保住 URL 文本）。
 */
function stripLineComment(line) {
  const at = line.indexOf('//');
  if (at === -1) return line;
  if (at > 0 && line[at - 1] === ':') return line;
  return line.slice(0, at);
}

/**
 * 取某段落的**直属声明块**。
 *
 * @param {string} text 文档全文
 * @param {string} sectionHeading 段标题（逐字，含 `#`）
 * @returns {{ startLine: number, lines: string[] } | null} 找不到段标题时返回 null
 */
function sectionBody(text, sectionHeading) {
  const lines = text.split('\n');
  const wanted = sectionHeading.trim();
  const start = lines.findIndex((line) => line.trim() === wanted);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { startLine: start + 1, lines: lines.slice(start + 1, end) };
}

/** 围栏代码块里的候选符号（四种形态，见文件头）。 */
function extractFromFences(body, baseLine) {
  const found = [];
  const push = (name, line, rule) => found.push({ name, line, rule });
  let inFence = false;
  let marker = '';
  body.lines.forEach((raw, index) => {
    const lineNo = baseLine + index + 1;
    if (FENCE.test(raw)) {
      const current = raw.trim().slice(0, 3);
      if (!inFence) {
        inFence = true;
        marker = current;
      } else if (current === marker) {
        inFence = false;
      }
      return;
    }
    if (!inFence) return;
    const line = stripLineComment(raw);
    if (line.trim() === '') return;
    let match;
    if ((match = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s+(${IDENT})`).exec(line))) {
      push(match[1], lineNo, 'function');
    } else if ((match = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:interface|type|class|enum)\\s+(${IDENT})`).exec(line))) {
      push(match[1], lineNo, 'type');
    }
    // 裸调用：行首或 `/` 之后的 `name(`（`a(x) / b(y)` 这种一行多符号的写法靠它）
    for (const call of line.matchAll(new RegExp(`(?:^|[\\s/])(${IDENT})\\s*\\(`, 'g'))) {
      if (!KEYWORDS.has(call[1])) push(call[1], lineNo, 'call');
    }
    // 裸名字：整行只有一个标识符（`DocumentError            // 有 error 级诊断`）
    if ((match = new RegExp(`^\\s*(${IDENT})\\s*;?\\s*$`).exec(line)) && !KEYWORDS.has(match[1])) {
      push(match[1], lineNo, 'bare');
    }
  });
  return found;
}

/** 表格里的候选符号：**首格必须由反引号符号起头**（`| `a(x)` / `b` | … |`）。 */
function extractFromApiTable(body, baseLine) {
  const found = [];
  body.lines.forEach((raw, index) => {
    const lineNo = baseLine + index + 1;
    if (!/^\s*\|/.test(raw)) return;
    const cells = raw.split('|');
    if (cells.length < 3) return;
    const first = cells[1].trim();
    if (!/^`/.test(first)) return;
    for (const token of first.matchAll(/`([^`]+)`/g)) {
      const text = token[1].trim();
      const call = new RegExp(`^(${IDENT})\\s*\\(`).exec(text);
      if (call !== null) {
        found.push({ name: call[1], line: lineNo, rule: 'table-call' });
        continue;
      }
      if (new RegExp(`^${IDENT}$`).test(text)) found.push({ name: text, line: lineNo, rule: 'table' });
      // 其余（`session.ts`、`（依据）`一类）刻意跳过：它们不是符号
    }
  });
  return found;
}

/** 包入口的实际导出面（`export { … }` 块 + `export <decl>`；本仓四个包都没有 `export *`）。 */
export function exportedNamesOf(text) {
  const names = new Set();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(stripLineComment).join('\n');
  for (const block of code.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g)) {
    for (const entry of block[1].split(',')) {
      const token = entry.replace(/^\s*type\s+/, '').trim();
      if (token === '') continue;
      const parts = token.split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (new RegExp(`^${IDENT}$`).test(name)) names.add(name);
    }
  }
  for (const match of code.matchAll(new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+(${IDENT})`, 'gm'))) {
    names.add(match[1]);
  }
  return names;
}

/**
 * 对给定配置运行 API 面检查。
 *
 * @param {{ config: object, read: (path: string) => string | null }} input
 * @returns {{ errors: string[], targets: object[], findings: object[], suppressed: object[] }}
 */
export function runApiSurfaceCheck({ config, read }) {
  const errors = [];
  const findings = [];
  const suppressed = [];
  const targets = [];
  const allow = config.allow ?? [];

  for (const entry of allow) {
    if (typeof entry.reason !== 'string' || entry.reason === '') {
      errors.push(`[API] apiSurfaceCheck.allow 的例外缺 reason：${JSON.stringify(entry)}`);
    }
    if (typeof entry.package !== 'string' || typeof entry.symbol !== 'string') {
      errors.push(`[API] apiSurfaceCheck.allow 的例外需要 package + symbol：${JSON.stringify(entry)}`);
    }
  }
  const allowed = (pkg, symbol) => allow.find((entry) => entry.package === pkg && entry.symbol === symbol);

  const exportsCache = new Map();
  const exportsOf = (pkg) => {
    if (exportsCache.has(pkg)) return exportsCache.get(pkg);
    const path = `packages/${pkg}/src/index.ts`;
    const text = read(path);
    let names = null;
    if (text === null) {
      errors.push(`[API] 包入口不存在：${path}（target 登记的 package 写错了？）`);
    } else {
      names = exportedNamesOf(text);
      if (names.size === 0) errors.push(`[API] 包入口解析不出任何导出：${path}（解析器与写法已分叉）`);
    }
    exportsCache.set(pkg, names);
    return names;
  };

  for (const target of config.targets ?? []) {
    const label = `${target.package} ← ${target.spec} ${target.section}`;
    const text = read(target.spec);
    if (text === null) {
      errors.push(`[API] 规范文件不存在：${target.spec}（${label}）`);
      continue;
    }
    const body = sectionBody(text, target.section);
    if (body === null) {
      errors.push(`[API] 段标题找不到：${target.spec} 不含「${target.section}」（登记表已腐烂）`);
      continue;
    }
    const mode = target.mode ?? 'fences';
    const candidates = mode === 'apiTable'
      ? extractFromApiTable(body, body.startLine)
      : extractFromFences(body, body.startLine);

    const unique = new Map();
    for (const item of candidates) if (!unique.has(item.name)) unique.set(item.name, item);

    const stats = {
      package: target.package,
      spec: target.spec,
      section: target.section,
      mode,
      candidates: unique.size,
      minCandidates: target.minCandidates ?? 1,
      documented: [...unique.keys()].sort(),
    };
    targets.push(stats);

    if (unique.size < stats.minCandidates) {
      errors.push(
        `[API] 提取面塌了：${target.spec} 的「${target.section}」只提取到 ${String(unique.size)} 个符号` +
          `（下限 ${String(stats.minCandidates)}）——写法变了而解析器没跟上时，这条检查会静默恒真`,
      );
    }

    const names = exportsOf(target.package);
    if (names === null) continue;
    for (const [name, item] of unique) {
      if (names.has(name)) continue;
      const where = `${target.spec}:${String(item.line)}`;
      const detail = `${label} 点名了 \`${name}\`（${item.rule}），但 packages/${target.package}/src/index.ts 不导出它`;
      const exemption = allowed(target.package, name);
      if (exemption !== undefined) {
        // **不静默吞掉**：登记为例外的点名叫法仍要每次打印出来（"清单可见"是本批的产出之一）。
        suppressed.push({ package: target.package, symbol: name, where, detail, reason: exemption.reason });
        continue;
      }
      findings.push({ package: target.package, symbol: name, where, detail });
    }
  }

  for (const finding of findings) errors.push(`[API] ${finding.detail}（${finding.where}）`);
  return { errors, targets, findings, suppressed };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function readIfExists(path) {
  const absolute = join(repoRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

function main() {
  const indexPath = 'docs/doc-index.json';
  const indexText = readIfExists(indexPath);
  if (indexText === null) {
    console.error(`[API] 找不到 ${indexPath}`);
    process.exit(1);
  }
  const config = JSON.parse(indexText).apiSurfaceCheck ?? {};
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    console.error('[API] docs/doc-index.json 的 apiSurfaceCheck.targets 为空（检查会恒真）');
    process.exit(1);
  }

  const { errors, targets, suppressed } = runApiSurfaceCheck({ config, read: readIfExists });

  console.log(`[API] 核对 ${String(targets.length)} 个 API 段：`);
  const byPackage = new Map();
  for (const stats of targets) {
    console.log(
      `  ${stats.package.padEnd(15)} ${stats.spec} 「${stats.section}」 ${stats.mode}：候选 ${String(stats.candidates)} 个（下限 ${String(stats.minCandidates)}）`,
    );
    byPackage.set(stats.package, (byPackage.get(stats.package) ?? 0) + stats.candidates);
  }
  // 反向只报数、不判红：哪些导出进"发布承诺"由 P4-b 的公开面分类负责。
  for (const [pkg, documented] of byPackage) {
    const text = readIfExists(`packages/${pkg}/src/index.ts`);
    const total = text === null ? 0 : exportedNamesOf(text).size;
    console.log(`  ${pkg.padEnd(15)} 被规范点名 ${String(documented)} 个 / 入口导出 ${String(total)} 个（含类型；反向差额由 P4-b 的公开面分类负责）`);
  }

  if (suppressed.length > 0) {
    console.log(`\n[API] 已登记为例外、但仍是"规范与导出面不一致"的点名 ${String(suppressed.length)} 条（每次运行都打印，避免被静默吞掉）：`);
    for (const item of suppressed) {
      console.log(`  warn [API] ${item.where} 点名 \`${item.symbol}\`（${item.package} 未导出）— 例外理由：${item.reason}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n[API] 错误 ${String(errors.length)} 条：`);
    for (const message of errors) console.error(`  error ${message}`);
    console.error('\n[API] 检查未通过。修法只有两种：改规范让它与导出面一致，或在 apiSurfaceCheck.allow 里登记带 reason 的例外。');
    process.exit(1);
  }
  console.log('[API] 检查通过：规范点名的符号都能在包入口找到。');
}

// ── 自检（反向保护的钉子：修好后必须绿） ───────────────────────────────────

function selftest() {
  const spec = [
    '## 二、公共 API',
    '',
    '```ts',
    'function alpha(input: string): number;   // 注释里的 beta( 不算符号',
    'type Gamma = { ok: true };',
    'delta(1) / epsilon(2)',
    'Zeta',
    '```',
    '',
    '### 2.1 用法示例',
    '',
    '```ts',
    'applyCommand(doc, cmd)   // 别的包的函数：子节不计入',
    '```',
  ].join('\n');
  const table = [
    '## 三、公共 API',
    '| 导出 | 作用 |',
    '|---|---|',
    '| `eta(x)` / `theta` | 说明 |',
    '| `zeta.ts` | 文件不是符号 |',
  ].join('\n');

  const readOf = (files) => (path) => files[path] ?? null;
  const base = (targets, allow = [], files = {}) => ({
    config: { targets, allow },
    read: readOf({ 'fixtures/spec.md': spec, 'fixtures/table.md': table, 'packages/pkg/src/index.ts': 'export { alpha, Gamma, delta, epsilon, Zeta, eta, theta };\n', ...files }),
  });
  const target = (extra = {}) => ({ package: 'pkg', spec: 'fixtures/spec.md', section: '## 二、公共 API', minCandidates: 5, ...extra });

  const cases = [];

  // 夹具说明：`fixtures/spec.md` 的围栏里有 5 个候选（alpha / Gamma / delta / epsilon / Zeta），
  // 注释里的 `beta(` 与 `### 2.1` 子节里的 `applyCommand(` 都不算。
  cases.push({
    name: '点名且导出 ⇒ 通过（注释里的 beta( 与子节的 applyCommand 都不算）',
    result: runApiSurfaceCheck(base([target()])),
    expect: (r) => r.errors.length === 0 && r.targets[0].candidates === 5,
  });

  cases.push({
    name: '点名但不导出 ⇒ 错误（含文件:行）',
    result: runApiSurfaceCheck(base([target()], [], { 'packages/pkg/src/index.ts': 'export { alpha, Gamma };\n' })),
    expect: (r) => r.findings.length === 3 && r.errors.some((message) => message.includes('fixtures/spec.md:6')),
  });

  cases.push({
    name: '段标题找不到 ⇒ 错误（登记表已腐烂）',
    result: runApiSurfaceCheck(base([target({ section: '## 九、不存在' })])),
    expect: (r) => r.errors.some((message) => message.includes('段标题找不到')),
  });

  cases.push({
    name: '候选数低于下限 ⇒ 错误（提取面塌了）',
    result: runApiSurfaceCheck(base([target({ minCandidates: 99 })])),
    expect: (r) => r.errors.some((message) => message.includes('提取面塌了')),
  });

  cases.push({
    name: 'apiTable 模式：首格符号列表被取到、文件名被跳过',
    result: runApiSurfaceCheck(base([{ package: 'pkg', spec: 'fixtures/table.md', section: '## 三、公共 API', mode: 'apiTable', minCandidates: 2 }])),
    expect: (r) => r.errors.length === 0 && r.targets[0].candidates === 2 && r.targets[0].documented.join(',') === 'eta,theta',
  });

  cases.push({
    name: '包入口不存在 ⇒ 错误',
    result: runApiSurfaceCheck(base([target()], [], { 'packages/pkg/src/index.ts': null })),
    expect: (r) => r.errors.some((message) => message.includes('包入口不存在')),
  });

  cases.push({
    name: '入口解析不出导出 ⇒ 错误（解析器与写法分叉）',
    result: runApiSurfaceCheck(base([target()], [], { 'packages/pkg/src/index.ts': '// 没有导出\n' })),
    expect: (r) => r.errors.some((message) => message.includes('解析不出任何导出')),
  });

  cases.push({
    name: '带 reason 的例外压住命中，但进 suppressed（不静默吞掉）',
    result: runApiSurfaceCheck(base([target()], [{ package: 'pkg', symbol: 'Zeta', reason: 'P4-b 待分类' }], { 'packages/pkg/src/index.ts': 'export { alpha, Gamma, delta, epsilon, eta, theta };\n' })),
    expect: (r) => r.findings.length === 0 && r.errors.length === 0 && r.suppressed.length === 1 && r.suppressed[0].reason === 'P4-b 待分类',
  });

  cases.push({
    name: 'allow 缺 reason ⇒ 报错',
    result: runApiSurfaceCheck(base([target()], [{ package: 'pkg', symbol: 'Zeta' }])),
    expect: (r) => r.errors.some((message) => message.includes('缺 reason')),
  });

  cases.push({
    name: 'export { a as b } 取别名（本地名不算导出）、export const 也算导出',
    result: runApiSurfaceCheck(base([target()], [], { 'packages/pkg/src/index.ts': 'export { alpha as Alpha2, Gamma, delta, epsilon };\nexport const Zeta = 1;\n' })),
    expect: (r) => r.findings.length === 1 && r.findings[0].symbol === 'alpha',
  });

  let failed = 0;
  for (const item of cases) {
    const ok = item.expect(item.result);
    if (!ok) failed += 1;
    console.log(`[API] 自检 ${ok ? '✅' : '❌'} ${item.name}`);
  }
  if (failed > 0) {
    console.error(`[API] 自检未通过：${String(failed)}/${String(cases.length)} 例失败`);
    process.exit(1);
  }
  console.log(`[API] 自检通过 ${String(cases.length)}/${String(cases.length)} 例`);
}

// 只在**被直接执行**时跑主流程：被 `import` 时（自检夹具、将来的其它消费者）不产生副作用。
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  if (process.argv.includes('--selftest')) selftest();
  else main();
}
