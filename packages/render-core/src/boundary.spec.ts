/**
 * `render-core` 的**边界自检**（P-19 §5 ② 与「落点即门禁」的可执行形式）。
 *
 * ## 为什么这条断言是必需的，而不是"文档纪律"
 *
 * P-19 §5 ② 把"列身份的所有权"列为待裁决的依赖方向障碍，理由是：
 * `cellText` 需要 `ColumnKey`，而 `ColumnKey` 原在 `xlsx-protocol`；
 * 若 `render-core` 直接 import 它，就会经它把 **925 KB 的 `exceljs`**（ADR 0006 §11）
 * 拉进计算层的依赖图——这与「计算层零框架 / 零 DOM / 可独立测试」的铁律直接冲突。
 *
 * 裁决选了**候选 A**：所有权反转给 `render-core`，`xlsx-protocol` 反向依赖本包。
 * 于是"依赖方向对不对"不该靠人记，而该是一条**会失败的断言**：
 *
 * | # | 断言 | 防的是什么 |
 * |---|---|---|
 * | ① | 发布源零 `xlsx-protocol` / `exceljs` 引用 | 有人把叶子依赖加回去（P-19 §5 ② 的原始障碍） |
 * | ② | **构建产物**（`dist/*.js`）零 `exceljs` 引用 | 类型擦除没生效 / 传递依赖经 `dist` 泄漏 |
 * | ③ | 本包 `lint-boundary` 夹具被铁律拦下 | 本包受约束这件事不是口头约定（ADR 0007 §2） |
 * | ④ | 真实配置下本包源码零报错 | 限制规则没有误伤正常代码 |
 * | ⑤ | **lint 规则**也拦下 `import '@ganttpilot/xlsx-protocol'`，而 `engine` 不被误伤 | P3/C7-a：①②是**文本扫描**（只看得见本包、只看得见字面量），方向图此前没有进 `eslint.config.mjs`——在 `engine` 里 import `render-core` 曾全绿 |
 *
 * 手法与 `packages/engine/src/boundary.spec.ts` 同源：断言用的规则集 import 自
 * `eslint-rules.mjs`，也就是 `pnpm lint` 真正加载的那一份定义（不是测试里抄的副本）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_DEPENDENCY_RULE_MESSAGE } from '../../../eslint-rules.mjs';
import config from '../../../eslint.config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const srcDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(repoRoot, 'packages', 'render-core', 'lint-boundary');

/** 去掉块注释与行注释：文档里提到 `exceljs`（讲历史缺陷）不算违规。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 发布源 = `src` 下的实现文件（`*.spec.ts` 是测试侧，不进产物）。 */
function publishSources(): readonly { readonly name: string; readonly code: string }[] {
  return readdirSync(srcDir)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
    .map((entry) => ({ name: entry, code: stripComments(readFileSync(join(srcDir, entry), 'utf8')) }));
}

function fixtureSource(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

function lintAsCalculationLayer(source: string): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  const virtualPath = join(repoRoot, 'packages', 'render-core', 'src', 'guardrail-subject.ts');
  return linter.verify(source, config, virtualPath);
}

describe('P-19 §5 ②：依赖方向（engine ← render-core ← xlsx-protocol）', () => {
  it('发布源不 import `xlsx-protocol`，也不引用 `exceljs`', () => {
    const offenders: string[] = [];
    for (const source of publishSources()) {
      if (/@ganttpilot\/xlsx-protocol/.test(source.code)) offenders.push(`${source.name}:xlsx-protocol`);
      if (/exceljs/.test(source.code)) offenders.push(`${source.name}:exceljs`);
    }
    expect(offenders).toStrictEqual([]);
    expect(publishSources().length).toBeGreaterThan(8);
  });

  it('构建产物（`dist/*.js`）里没有指向 `exceljs` 的 import/require（类型擦除真的生效）', () => {
    const distDir = join(repoRoot, 'packages', 'render-core', 'dist');
    let entries: readonly string[];
    try {
      entries = readdirSync(distDir);
    } catch {
      // 未构建时跳过（`pnpm gate` 的 build 步骤会产出它；此处不把"没构建"当成失败，
      // 因为 typecheck/test 步骤都在 build 之前）。
      return;
    }
    /** 只认**真实的模块边**：`import ... from 'exceljs'` / `require('exceljs')` / `import('exceljs')`。
     *  产物里保留注释（`tsc` 不剥注释），而注释里提到 `exceljs`（"为什么不依赖它"）
     *  正是我们要保留的文档——因此两边都先剥注释，再找模块边。 */
    const moduleEdge = /(?:from\s*['"]exceljs|require\(\s*['"]exceljs|import\(\s*['"]exceljs)/;
    const offenders: string[] = [];
    for (const entry of entries.filter((name) => name.endsWith('.js'))) {
      const code = stripComments(readFileSync(join(distDir, entry), 'utf8'));
      if (moduleEdge.test(code)) offenders.push(entry);
    }
    expect(offenders).toStrictEqual([]);
  });

  it('**lint 规则**同样守住这条方向：拦下 `xlsx-protocol`，不误伤 `engine`（P3/C7-a）', () => {
    const restricted = lintAsCalculationLayer("import { parseXlsx } from '@ganttpilot/xlsx-protocol';\n");
    const allowed = lintAsCalculationLayer("import { compute } from '@ganttpilot/engine';\n");

    const hit = restricted.find((message) => message.message.includes(WORKSPACE_DEPENDENCY_RULE_MESSAGE));
    expect(hit?.severity).toBe(2);
    expect(hit?.message).toContain('@ganttpilot/xlsx-protocol');
    expect(allowed.filter((message) => message.ruleId === 'no-restricted-imports')).toStrictEqual([]);
  });
});

describe('ADR 0007 §2：本包自带铁律夹具，且限制规则真的拦得住', () => {
  it('`import "vue"` 被 no-restricted-imports 拦下', () => {
    const messages = lintAsCalculationLayer(fixtureSource('forbidden-import.fixture.ts'));
    const hit = messages.find((message) => message.ruleId === 'no-restricted-imports');
    expect(hit?.message).toContain('零框架依赖铁律');
    expect(hit?.severity).toBe(2);
  });

  it('访问 DOM 全局被 no-restricted-globals 拦下', () => {
    const messages = lintAsCalculationLayer(fixtureSource('dom-globals.fixture.ts'));
    const hit = messages.find((message) => message.ruleId === 'no-restricted-globals');
    expect(hit?.message).toContain('零 DOM 依赖铁律');
    expect(hit?.severity).toBe(2);
  });

  it('语义无害的等价代码不被拦截（限制规则有判别力）', () => {
    expect(lintAsCalculationLayer('export const count = 1 + 1;\n')).toStrictEqual([]);
  });

  it('真实配置下本包源码零报错', async () => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: join(repoRoot, 'eslint.config.mjs'),
    });
    const [result] = await eslint.lintFiles(['packages/render-core/src/index.ts', 'packages/render-core/src/viewText.ts']);
    expect(result?.errorCount).toBe(0);
    expect(result?.warningCount).toBe(0);
  });
});
