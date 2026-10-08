#!/usr/bin/env node
/**
 * **门禁步骤契约的两处陈述必须一致**：`scripts/gate.mjs` 的 `STEPS` ⇔ `.github/workflows/ci.yml`
 * 实际跑的那些步（P5-c 的第 23 项）。
 *
 * ## 为什么必须有
 *
 * 这两份文件是**同一个事实的两处陈述**（CI 跑哪几步、按什么顺序），而它们的一致性此前**只写在
 * `ci.yml` 的文件头注释里**——注释腐烂过一次：它曾把 `bundle:offline` / `docs:check` 写成
 * "不在此文件内"，**改动之前那句话是对的，但没有任何检查会在两边分叉时翻红**。
 * 而 `STEPS` 是**门禁契约**（`gate.mjs` 文件头：改动它等于改动门禁契约，须同步 ADR 0001 与附录增补）
 * ⇒ "CI 悄悄少跑一步"与"把 `build` 排到 `typecheck` 之后"都必须在门禁里翻红，而不是靠人记得比对。
 *
 * ## 判据（全部是 error，不设警告档——这类分叉没有"可接受"的中间态）
 *
 * 1. 从 `ci.yml` 取出的 `pnpm` 步 **⊆ `STEPS`**：多一步、或把某步拼错，都报；
 * 2. 它们的**相对顺序是 `STEPS` 的子序列**（不重排——尤其 `build` 必须先于 `typecheck`）；
 * 3. **缺的步恰好等于** `gateStepsCheck.absent` 登记的集合：**集合相等**，于是"少跑一步却没登记"
 *    与"登记为不跑、其实在跑"**都会翻红**（只判子序列的话，删掉一步仍然是子序列 ⇒ 判据没牙）；
 * 4. `prerequisites`（`pnpm install` 这类**前置动作**，不是门禁步）与 `absent` 的每一条**必须带 `reason`**；
 *    出现**未登记的前置动作**也报（否则"新增一个前置动作"会静默绕过第 1 条）；
 * 5. `STEPS` 解析为空、或 `ci.yml` 一个门禁步都取不到 ⇒ 报（否则判定会静默变成恒真式）。
 *
 * ## 零依赖与"防静默漏看"
 *
 * **不引 YAML 解析器**（依赖面本身就是本项目要守的东西），只认单行 `run: pnpm <step>` 这一种形态；
 * 因此一旦 `ci.yml` 出现多行 `run: |` / `run: >` 块，本检查**响亮地失败**，而不是"看不见就当没有"。
 *
 * 用法：`node scripts/check-gate-steps.mjs`（进 `pnpm docs:check`）；
 * `node scripts/check-gate-steps.mjs --selftest` 只跑引擎自检（不读仓库）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './paths.mjs';

/** `gate.mjs` 里 `STEPS` 块的起止标记（改动写法等于改检查口径，必须同批改这里）。 */
const STEPS_OPEN = 'const STEPS = [';
const STEPS_CLOSE = '];';

/** `ci.yml` 里只认这一种形态的单行命令。 */
const RUN_LINE = /^\s*(?:-\s*)?run:\s*pnpm\s+(.+?)\s*$/;

/** 多行块：本检查**没有**YAML 解析能力，出现即失败（宁可响亮地停，也不要静默漏看）。 */
const MULTILINE_RUN = /^\s*(?:-\s*)?run:\s*[|>]/m;

/** 前置动作的比对面：`command` 取首个词（`install --frozen-lockfile` ⇒ `install`）。 */
const firstWord = (text) => (text.trim().split(/\s+/)[0] ?? '').trim();

/**
 * 判定引擎（与仓库解耦，便于 `--selftest` 用合成输入驱动）。
 *
 * @param {{ gateSource: string, pipelineSource: string, config: object }} input
 * @returns {{ errors: string[], readings: { gateSteps: string[], pipelineSteps: string[], prerequisites: string[], missing: string[] } }}
 */
export function runGateStepsCheck({ gateSource, pipelineSource, config }) {
  const errors = [];
  const gateSteps = [];
  const pipelineSteps = [];
  const prerequisites = [];
  const missing = [];

  // ── 取 STEPS（唯一权威定义） ─────────────────────────────────────────────
  const open = gateSource.indexOf(STEPS_OPEN);
  if (open < 0) {
    errors.push(`[门禁步] ${String(config.gateSource)} 里找不到 \`${STEPS_OPEN}\`（写法变了？检查口径要同批改）`);
  } else {
    const rest = gateSource.slice(open + STEPS_OPEN.length);
    const close = rest.indexOf(STEPS_CLOSE);
    const block = close < 0 ? rest : rest.slice(0, close);
    for (const match of block.matchAll(/\bname:\s*'([^']+)'/g)) gateSteps.push(match[1]);
  }
  if (gateSteps.length === 0) errors.push('[门禁步] `STEPS` 解析不出任何步骤 ⇒ 判定会静默变成恒真式');

  // ── 取 ci.yml 的 `run: pnpm <step>` ─────────────────────────────────────
  if (MULTILINE_RUN.test(pipelineSource)) {
    errors.push(
      `[门禁步] ${String(config.pipelineSource)} 里出现多行 \`run: |\`/\`run: >\` 块——本检查只认单行形态，` +
        '会静默漏看，故直接判红（要么改写成单行，要么扩展本检查）',
    );
  }
  for (const line of pipelineSource.split('\n')) {
    const match = RUN_LINE.exec(line);
    if (match === null) continue;
    const command = match[1].trim();
    const step = firstWord(command);
    if (gateSteps.includes(step)) {
      pipelineSteps.push(step);
      continue;
    }
    const registered = (config.prerequisites ?? []).some((entry) => firstWord(String(entry.command ?? '')) === step);
    if (registered) prerequisites.push(step);
    else errors.push(`[门禁步] ${String(config.pipelineSource)} 里的 \`pnpm ${command}\` 既不是 \`STEPS\` 的步、也不在 \`prerequisites\` 登记里`);
  }
  if (pipelineSteps.length === 0 && errors.length === 0) {
    errors.push(`[门禁步] ${String(config.pipelineSource)} 里取不到任何 \`run: pnpm <step>\` ⇒ 判定会静默变成恒真式`);
  }

  // ── 判据 2：相对顺序是 STEPS 的子序列 ───────────────────────────────────
  let cursor = -1;
  for (const step of pipelineSteps) {
    const index = gateSteps.indexOf(step);
    if (index < cursor) {
      const previous = pipelineSteps[pipelineSteps.indexOf(step) - 1];
      errors.push(
        `[门禁步] 顺序被重排：\`${step}\` 排在 \`${previous}\` 之后，而 \`STEPS\` 里它在前面` +
          `（完整顺序：${gateSteps.join(' → ')}）`,
      );
    }
    cursor = Math.max(cursor, index);
  }

  // ── 判据 3：缺的步集合 == 登记的 absent 集合（集合相等，不是包含） ───────
  const absent = config.absent ?? [];
  for (const entry of absent) {
    if (typeof entry.reason !== 'string' || entry.reason === '') {
      errors.push(`[门禁步] gateStepsCheck.absent 的「${String(entry.step)}」缺 reason`);
    }
  }
  for (const entry of config.prerequisites ?? []) {
    if (typeof entry.reason !== 'string' || entry.reason === '') {
      errors.push(`[门禁步] gateStepsCheck.prerequisites 的「${String(entry.command)}」缺 reason`);
    }
  }
  for (const step of gateSteps) {
    if (!pipelineSteps.includes(step)) missing.push(step);
  }
  const registeredAbsent = absent.map((entry) => String(entry.step));
  for (const step of missing) {
    if (!registeredAbsent.includes(step)) {
      errors.push(`[门禁步] \`STEPS\` 的「${step}」在 ${String(config.pipelineSource)} 里没跑、也没在 \`absent\` 里登记`);
    }
  }
  for (const step of registeredAbsent) {
    if (gateSteps.includes(step) && pipelineSteps.includes(step)) {
      errors.push(`[门禁步] 「${step}」登记为 \`absent\`，但它其实在 ${String(config.pipelineSource)} 里跑了 ⇒ 登记已腐烂`);
    }
  }

  return { errors, readings: { gateSteps, pipelineSteps, prerequisites, missing } };
}

// ── 读取配置与仓库文件，跑一次判定并打印 ──────────────────────────────────

function main() {
  const indexPath = join(repoRoot, 'docs', 'doc-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const config = index.gateStepsCheck;
  if (config === undefined || config === null) {
    console.error('[门禁步] docs/doc-index.json 里没有 `gateStepsCheck` 登记（本检查的唯一真相源）');
    process.exit(1);
  }

  const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');
  const result = runGateStepsCheck({
    gateSource: read(config.gateSource),
    pipelineSource: read(config.pipelineSource),
    config,
  });

  const { gateSteps, pipelineSteps, prerequisites, missing } = result.readings;
  console.log(`[门禁步] ${config.gateSource} 的 STEPS（${String(gateSteps.length)}）：${gateSteps.join(' → ')}`);
  console.log(
    `[门禁步] ${config.pipelineSource} 的 pnpm 步（${String(pipelineSteps.length)}）：${pipelineSteps.join(' → ')}` +
      (prerequisites.length > 0 ? `（另：前置动作 ${prerequisites.join('、')}）` : ''),
  );
  console.log(`[门禁步] 未跑（已登记原因）：${missing.length > 0 ? missing.join('、') : '（无）'}`);

  if (result.errors.length > 0) {
    console.error(`[门禁步] 错误 ${String(result.errors.length)} 条：`);
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log('[门禁步] 检查通过：CI 跑的步 ⊆ 门禁契约，顺序是它的子序列，缺的步与登记一一对应。');
}

// ── 自检（反向保护的钉子：修好后必须绿） ───────────────────────────────────

function selftest() {
  const GATE = (names) => `const STEPS = [\n${names.map((name) => `  { name: '${name}', args: ['${name}'] },`).join('\n')}\n];\n`;
  const CI = (lines) => `jobs:\n  gate:\n    steps:\n${lines.map((line) => `      - run: pnpm ${line}`).join('\n')}\n`;
  const baseConfig = {
    gateSource: 'scripts/gate.mjs',
    pipelineSource: '.github/workflows/ci.yml',
    prerequisites: [{ command: 'install', reason: '装依赖是前置动作，不是门禁步' }],
    absent: [{ step: 'smoke:build', reason: '需要本机无头 Chrome' }],
  };
  const ALL = ['lint', 'build', 'typecheck', 'test', 'smoke:build', 'license:check'];
  const RUNS = ['lint', 'build', 'typecheck', 'test', 'license:check'];

  const evaluate = (gate, ci, config = baseConfig) =>
    runGateStepsCheck({ gateSource: gate, pipelineSource: ci, config });

  const cases = [];

  // ① 子序列 + 缺的步恰好等于 absent ⇒ 绿
  cases.push({
    name: '顺序合法、缺的步与登记一致 ⇒ 绿',
    result: evaluate(GATE(ALL), CI(['install --frozen-lockfile', ...RUNS])),
    expect: (r) => r.errors.length === 0 && r.readings.missing.join() === 'smoke:build' && r.readings.prerequisites.join() === 'install',
  });

  // ② 把 build 排到 typecheck 之后 ⇒ 顺序翻红（ADR 0001 的正确性那条）
  cases.push({
    name: 'build 排到 typecheck 之后 ⇒ 报顺序被重排',
    result: evaluate(GATE(ALL), CI(['lint', 'typecheck', 'build', 'test', 'license:check'])),
    expect: (r) => r.errors.length === 1 && r.errors[0].includes('顺序被重排') && r.errors[0].includes('build'),
  });

  // ③ 少跑一步而 absent 没登记 ⇒ 翻红（只判子序列时这里是绿的 ⇒ 判据有牙的证据）
  cases.push({
    name: '少跑一步却未登记 ⇒ 报（子序列判定本身看不出来）',
    result: evaluate(GATE(ALL), CI(['lint', 'typecheck', 'test', 'license:check'])),
    expect: (r) => r.errors.some((e) => e.includes('没跑、也没在') && e.includes('build')),
  });

  // ④ 登记为 absent、其实在跑 ⇒ 报"登记已腐烂"
  cases.push({
    name: 'absent 登记了但其实在跑 ⇒ 报登记腐烂',
    result: evaluate(GATE(ALL), CI(['lint', 'build', 'typecheck', 'test', 'smoke:build', 'license:check'])),
    expect: (r) => r.errors.some((e) => e.includes('登记已腐烂')),
  });

  // ⑤ 多一个 STEPS 里没有的步 ⇒ 报
  cases.push({
    name: '跑了一个 STEPS 里没有的步 ⇒ 报',
    result: evaluate(GATE(ALL), CI(['lint', 'build', 'typecheck', 'test', 'frobnicate', 'license:check'])),
    expect: (r) => r.errors.some((e) => e.includes('frobnicate')),
  });

  // ⑥ 未登记的前置动作 ⇒ 报（否则"新增一个前置动作"会静默绕过判据 1）
  cases.push({
    name: '未登记的前置动作 ⇒ 报',
    result: evaluate(GATE(ALL), CI(['setup-env', 'lint', 'build', 'typecheck', 'test', 'license:check'])),
    expect: (r) => r.errors.some((e) => e.includes('prerequisites')),
  });

  // ⑦ absent / prerequisites 缺 reason ⇒ 报
  cases.push({
    name: 'absent 缺 reason ⇒ 报',
    result: evaluate(GATE(ALL), CI(['lint', 'build', 'typecheck', 'test', 'license:check']), {
      ...baseConfig,
      absent: [{ step: 'smoke:build' }],
    }),
    expect: (r) => r.errors.some((e) => e.includes('缺 reason')),
  });

  // ⑧ STEPS 解析为空 ⇒ 报（防"上界静默变成全通过"）
  cases.push({
    name: 'STEPS 解析为空 ⇒ 报',
    result: evaluate('const NOT_STEPS = [];\n', CI(RUNS)),
    expect: (r) => r.errors.some((e) => e.includes('找不到')) && r.errors.some((e) => e.includes('解析不出')),
  });

  // ⑨ ci.yml 一个门禁步都取不到 ⇒ 报（防恒真式）
  cases.push({
    name: 'ci.yml 取不到任何门禁步 ⇒ 报',
    result: evaluate(GATE(ALL), 'jobs:\n  gate:\n    steps:\n      - uses: actions/checkout@v4\n'),
    expect: (r) => r.errors.some((e) => e.includes('取不到任何')),
  });

  // ⑩ 多行 run 块 ⇒ 响亮失败（本检查没有 YAML 解析能力，宁可停也不要静默漏看）
  cases.push({
    name: '出现多行 run 块 ⇒ 响亮失败',
    result: evaluate(GATE(ALL), 'jobs:\n  gate:\n    steps:\n      - run: |\n          pnpm lint\n'),
    expect: (r) => r.errors.some((e) => e.includes('多行')),
  });

  // ⑪ 非 pnpm 的 run（如 python 装依赖）不参与判定，也不误报
  cases.push({
    name: '非 pnpm 的 run 命令不误报',
    result: evaluate(
      GATE(ALL),
      'jobs:\n  gate:\n    steps:\n      - run: python -m pip install openpyxl==3.1.5\n' +
        CI(['install --frozen-lockfile', ...RUNS]).split('\n').slice(4).map((line) => line).join('\n'),
    ),
    expect: (r) => r.errors.length === 0,
  });

  let failed = 0;
  for (const item of cases) {
    const ok = item.expect(item.result);
    if (!ok) failed += 1;
    console.log(`[门禁步] 自检 ${ok ? '✅' : '❌'} ${item.name}`);
  }
  if (failed > 0) {
    console.error(`[门禁步] 自检未通过：${String(failed)}/${String(cases.length)} 例失败`);
    process.exit(1);
  }
  console.log(`[门禁步] 自检通过 ${String(cases.length)}/${String(cases.length)} 例`);
}

if (process.argv.includes('--selftest')) selftest();
else main();
