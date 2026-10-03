import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { CALCULATION_LAYER_RESTRICTIONS, LINT_FIXTURE_PATTERN, LINT_IGNORES } from '../../../eslint-rules.mjs';
import config from '../../../eslint.config.mjs';

/**
 * 护栏自检：证明 `eslint.config.mjs` 里的「零框架依赖 / 零 DOM 依赖」铁律**真的会拦截违规**。
 *
 * 这是 G0 出口条件第 2 条「验证护栏本身有效」的可执行版本：
 * 若有人放开限制规则、或把 ESLint 配置改坏，本文件的断言立即失败。
 *
 * 实现要点：
 * - 断言用的规则集 import 自 `eslint-rules.mjs`，也就是 `pnpm lint` 真正加载的那一份定义
 *   （不是测试里抄的副本），因此「改配置但测试仍绿」不可能发生；
 * - 违规夹具被真实配置的 `ignores` 全局排除（否则 `pnpm lint` 会把故意违规当成真错误）。
 *   为了既绕开忽略、又保持确定性，这里用 `Linter`（平铺配置解析器）直接对夹具文本求值，
 *   文件路径取一个**与 ignores 无关**的虚拟路径；
 * - 另有一个用例用真实 `ESLint` 实例证明正常源码零报错，说明配置整体可用。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 夹具文本所在的位置（仅用于读文件，不作为受检路径）。 */
const FIXTURE_DIR = join(repoRoot, 'packages', 'engine', 'lint-boundary');

/** 受检虚拟路径：与 ignores 无关，但命中计算层的规则块。 */
const VIRTUAL_PATH = join(repoRoot, 'packages', 'engine', 'src', 'guardrail-subject.ts');

function fixtureSource(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function lintAsCalculationLayer(source: string): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(source, config, VIRTUAL_PATH);
}

function ruleIdsOf(messages: readonly Linter.LintMessage[]): string[] {
  return messages.map((message) => message.ruleId ?? '<fatal>');
}

describe('护栏自检：计算层的零框架 / 零 DOM 依赖', () => {
  it('忽略清单覆盖构建产物与故意违规的夹具', () => {
    expect(LINT_IGNORES).toContain('**/node_modules/**');
    expect(LINT_IGNORES).toContain('**/dist/**');
    expect(LINT_IGNORES).toContain(LINT_FIXTURE_PATTERN);
  });

  it('import 框架会被 no-restricted-imports 拦下（铁律 1）', () => {
    const messages = lintAsCalculationLayer(fixtureSource('forbidden-import.fixture.ts'));

    expect(ruleIdsOf(messages)).toContain('no-restricted-imports');
    const message = messages.find((entry) => entry.ruleId === 'no-restricted-imports');
    expect(message?.message).toContain('零框架依赖铁律');
    expect(message?.severity).toBe(2);
  });

  it('访问 DOM 全局会被 no-restricted-globals 拦下（铁律 1）', () => {
    const messages = lintAsCalculationLayer(fixtureSource('dom-globals.fixture.ts'));

    expect(ruleIdsOf(messages)).toContain('no-restricted-globals');
    const message = messages.find((entry) => entry.ruleId === 'no-restricted-globals');
    expect(message?.message).toContain('零 DOM 依赖铁律');
    expect(message?.severity).toBe(2);
  });

  it('绕过写法 globalThis.document 会被 no-restricted-properties 拦下', () => {
    const messages = lintAsCalculationLayer('export const title = globalThis.document.title;');

    expect(ruleIdsOf(messages)).toContain('no-restricted-properties');
  });

  it('语义无害的等价代码不被拦截（限制规则有判别力，不是无差别报错）', () => {
    const messages = lintAsCalculationLayer('export const count = 1 + 1;\n');

    expect(messages).toStrictEqual([]);
  });

  it('计算层规则集本身包含三条限制规则', () => {
    expect(Object.keys(CALCULATION_LAYER_RESTRICTIONS)).toStrictEqual([
      'no-restricted-imports',
      'no-restricted-globals',
      'no-restricted-properties',
    ]);
  });

  it('真实配置下引擎源码零报错（配置整体可用，未误伤正常代码）', async () => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: join(repoRoot, 'eslint.config.mjs'),
    });
    const [result] = await eslint.lintFiles(['packages/engine/src/index.ts']);

    expect(result?.errorCount).toBe(0);
    expect(result?.warningCount).toBe(0);
  });
});
