import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  CALCULATION_LAYER_PACKAGES,
  CALCULATION_LAYER_RESTRICTIONS,
  DOM_RULE_MESSAGE,
  FRAMEWORK_RULE_MESSAGE,
  LINT_FIXTURE_PATTERN,
  LINT_IGNORES,
  WORKSPACE_DEPENDENCY_RULE_MESSAGE,
  forbiddenWorkspacePackagesFor,
} from '../../../eslint-rules.mjs';
import config from '../../../eslint.config.mjs';

/**
 * 护栏自检：证明 `eslint.config.mjs` 里的「零框架依赖 / 零 DOM 依赖」铁律与
 * **依赖方向契约**（P3/C7-a）**真的会拦截违规**。
 *
 * 这是 G0 出口条件第 2 条「验证护栏本身有效」的可执行版本：
 * 若有人放开限制规则、或把 ESLint 配置改坏，本文件的断言立即失败。
 *
 * 实现要点：
 * - 断言用的规则集与包清单 import 自 `eslint-rules.mjs`，也就是 `pnpm lint` 真正加载的那一份定义
 *   （不是测试里抄的副本），因此「改配置但测试仍绿」不可能发生；
 * - 违规夹具被真实配置的 `ignores` 全局排除（否则 `pnpm lint` 会把故意违规当成真错误）。
 *   为了既绕开忽略、又保持确定性，这里用 `Linter`（平铺配置解析器）直接对夹具文本求值，
 *   文件路径取一个**与 ignores 无关**的虚拟路径；
 * - 另有一个用例用真实 `ESLint` 实例证明正常源码零报错，说明配置整体可用。
 *
 * ## P3/C7-a：这一份自检从"引擎自己"扩到**整个计算层**
 *
 * C7-a 实测发现两处假绿，都已在此闭合成会失败的断言：
 * 1. `xlsx-protocol` / `pptx-renderer` 的 `lint-boundary/*.fixture.ts` **没有任何自检加载它们**
 *    （夹具被全局忽略、两个包又没有 spec）⇒ "本包受铁律约束"对这两包仍是口头约定；
 * 2. 依赖方向（ADR 0008 §1）此前只有 `render-core` 自己的**文本扫描**在守，
 *    而 `no-restricted-imports` 不禁止工作区依赖：`engine` 里 import `render-core`
 *    `pnpm lint` 全绿。现在由配置里的逐包许可清单守着，本文件断言它**拦得住、且不误伤**。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 受检虚拟路径：与 ignores 无关，但命中该包在配置里的规则块（含逐包的方向块）。 */
function virtualPathFor(packageDir: string): string {
  return join(repoRoot, packageDir, 'src', 'guardrail-subject.ts');
}

function fixtureSource(packageDir: string, name: string): string {
  return readFileSync(join(repoRoot, packageDir, 'lint-boundary', name), 'utf8');
}

function lintAsCalculationLayer(packageDir: string, source: string): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(source, config, virtualPathFor(packageDir));
}

function ruleIdsOf(messages: readonly Linter.LintMessage[]): string[] {
  return messages.map((message) => message.ruleId ?? '<fatal>');
}

/** 某包在 `package.json` 里**声明**的工作区依赖（dependencies + devDependencies）。 */
function declaredWorkspaceDependencies(packageDir: string): string[] {
  const text = readFileSync(join(repoRoot, packageDir, 'package.json'), 'utf8');
  const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const declared = [
    ...Object.keys(manifest['dependencies'] ?? {}),
    ...Object.keys(manifest['devDependencies'] ?? {}),
  ];
  return declared.filter((name) => name.startsWith('@ganttpilot/'));
}

describe('护栏自检：计算层的零框架 / 零 DOM 依赖', () => {
  it('忽略清单覆盖构建产物与故意违规的夹具', () => {
    expect(LINT_IGNORES).toContain('**/node_modules/**');
    expect(LINT_IGNORES).toContain('**/dist/**');
    expect(LINT_IGNORES).toContain(LINT_FIXTURE_PATTERN);
  });

  it('import 框架会被 no-restricted-imports 拦下（铁律 1）', () => {
    const messages = lintAsCalculationLayer('packages/engine', fixtureSource('packages/engine', 'forbidden-import.fixture.ts'));

    expect(ruleIdsOf(messages)).toContain('no-restricted-imports');
    const message = messages.find((entry) => entry.ruleId === 'no-restricted-imports');
    expect(message?.message).toContain(FRAMEWORK_RULE_MESSAGE);
    expect(message?.severity).toBe(2);
  });

  it('访问 DOM 全局会被 no-restricted-globals 拦下（铁律 1）', () => {
    const messages = lintAsCalculationLayer('packages/engine', fixtureSource('packages/engine', 'dom-globals.fixture.ts'));

    expect(ruleIdsOf(messages)).toContain('no-restricted-globals');
    const message = messages.find((entry) => entry.ruleId === 'no-restricted-globals');
    expect(message?.message).toContain(DOM_RULE_MESSAGE);
    expect(message?.severity).toBe(2);
  });

  it('每个计算层包都自带夹具，且两组夹具都真的被拦下（一个包也不能是口头约定）', () => {
    const outcomes: string[] = [];
    for (const entry of CALCULATION_LAYER_PACKAGES) {
      const framework = lintAsCalculationLayer(entry.dir, fixtureSource(entry.dir, 'forbidden-import.fixture.ts'));
      const dom = lintAsCalculationLayer(entry.dir, fixtureSource(entry.dir, 'dom-globals.fixture.ts'));
      outcomes.push(
        `${entry.name}:框架=${String(framework.some((m) => m.message.includes(FRAMEWORK_RULE_MESSAGE)))}` +
          `,DOM=${String(dom.some((m) => m.message.includes(DOM_RULE_MESSAGE)))}`,
      );
    }

    expect(outcomes).toStrictEqual(
      CALCULATION_LAYER_PACKAGES.map((entry) => `${entry.name}:框架=true,DOM=true`),
    );
  });

  it('框架的**子路径**导入同样被拦下（`patterns` 而不是 `paths`：此前 `vue/*` 是空转的）', () => {
    const messages = lintAsCalculationLayer('packages/engine', "import 'vue/dist/vue.esm-bundler.js';\n");

    expect(ruleIdsOf(messages)).toContain('no-restricted-imports');
    expect(messages.some((message) => message.message.includes(FRAMEWORK_RULE_MESSAGE))).toBe(true);
  });

  it('绕过写法 globalThis.document 会被 no-restricted-properties 拦下', () => {
    const messages = lintAsCalculationLayer('packages/engine', 'export const title = globalThis.document.title;');

    expect(ruleIdsOf(messages)).toContain('no-restricted-properties');
  });

  it('语义无害的等价代码不被拦截（限制规则有判别力，不是无差别报错）', () => {
    const messages = lintAsCalculationLayer('packages/engine', 'export const count = 1 + 1;\n');

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

describe('护栏自检：计算层的依赖方向（ADR 0008 §1 的方向图，P3/C7-a 落成规则）', () => {
  it('头号目标：`packages/engine` import `@ganttpilot/render-core` 被拦下（含子路径）', () => {
    for (const source of [
      "import { routeEdge } from '@ganttpilot/render-core';\n",
      "import { diagnoseRowAlignment } from '@ganttpilot/render-core/align';\n",
    ]) {
      const messages = lintAsCalculationLayer('packages/engine', source);
      const hit = messages.find((message) => message.message.includes(WORKSPACE_DEPENDENCY_RULE_MESSAGE));

      expect(hit?.severity).toBe(2);
      expect(hit?.message).toContain('@ganttpilot/render-core');
    }
  });

  it('每个包都不许 import「许可清单之外」的工作区包', () => {
    const outcomes: string[] = [];
    for (const entry of CALCULATION_LAYER_PACKAGES) {
      for (const forbidden of forbiddenWorkspacePackagesFor(entry.name)) {
        const messages = lintAsCalculationLayer(entry.dir, `import '${forbidden.name}';\n`);
        const hit = messages.find((message) => message.message.includes(WORKSPACE_DEPENDENCY_RULE_MESSAGE));
        outcomes.push(`${entry.name}→${forbidden.name}:${hit === undefined ? '放过了' : '拦下'}`);
      }
    }

    // 逐条列出（不是 `every(...)`）：一旦有人放宽某一条，失败信息直接指出是哪一条。
    expect(outcomes).toStrictEqual(
      CALCULATION_LAYER_PACKAGES.flatMap((entry) =>
        forbiddenWorkspacePackagesFor(entry.name).map((forbidden) => `${entry.name}→${forbidden.name}:拦下`),
      ),
    );
    expect(outcomes.length).toBeGreaterThanOrEqual(5);
  });

  it('许可清单里的依赖不被拦下（方向契约是许可清单，不是「一律禁止跨包」）', () => {
    const outcomes: string[] = [];
    for (const entry of CALCULATION_LAYER_PACKAGES) {
      for (const allowed of entry.allowed) {
        const messages = lintAsCalculationLayer(entry.dir, `import '${allowed}';\n`);
        const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');
        outcomes.push(`${entry.name}→${allowed}:${restricted.length === 0 ? '放行' : '误伤'}`);
      }
    }

    expect(outcomes).toStrictEqual(
      CALCULATION_LAYER_PACKAGES.flatMap((entry) => entry.allowed.map((allowed) => `${entry.name}→${allowed}:放行`)),
    );
  });

  it('`packages/` 下的每个目录都已登记（新包不能因为"忘了登记"而整块漏掉方向规则）', () => {
    const onDisk = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}`)
      .sort();

    expect(onDisk).toStrictEqual(CALCULATION_LAYER_PACKAGES.map((entry) => entry.dir).sort());
  });

  it('每个包 `package.json` 里声明的工作区依赖都在许可清单内（契约不许比事实更窄）', () => {
    const offenders: string[] = [];
    for (const entry of CALCULATION_LAYER_PACKAGES) {
      for (const declared of declaredWorkspaceDependencies(entry.dir)) {
        if (!entry.allowed.includes(declared)) {
          offenders.push(`${entry.name} 声明了 ${declared}，但它不在许可清单里：要放宽方向须改 eslint-rules.mjs 的 CALCULATION_LAYER_PACKAGES 并登记裁决`);
        }
      }
    }

    expect(offenders).toStrictEqual([]);
  });
});
