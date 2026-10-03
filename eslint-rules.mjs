/**
 * 「零框架依赖 / 零 DOM 依赖」铁律的**单一定义处**。
 *
 * 这里既被 `eslint.config.mjs` 引用（真正拦住违规），也被
 * `packages/engine/src/boundary.spec.ts` 引用（护栏自检）。
 * 之所以单独成文件：让断言用的是配置**本身**，而不是在测试里抄一份副本——
 * 否则改了 `eslint.config.mjs` 而测试仍对着副本断言，护栏就会假绿。
 */

/** 禁止被计算层 import 的框架（铁律 1）。 */
export const FORBIDDEN_FRAMEWORKS = ['vue', 'vue/*', 'react', 'react-dom', 'svelte', '@vue/*'];

/** 禁止被计算层直接使用的 DOM / 浏览器全局（铁律 1 的另一半）。 */
export const FORBIDDEN_DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'alert',
  'requestAnimationFrame',
  'HTMLElement',
  'Event',
  'Node',
];

/** 三包铁律的报错文案片段（测试据此断言「命中的确实是铁律」而不是别的规则）。 */
export const FRAMEWORK_RULE_MESSAGE = '零框架依赖铁律';
export const DOM_RULE_MESSAGE = '零 DOM 依赖铁律';

/** 违规夹具的路径模式：被 `pnpm lint` 忽略，只由护栏自检以文本方式加载。 */
export const LINT_FIXTURE_PATTERN = '**/lint-boundary/*.fixture.ts';

/** 被 ESLint 全局忽略的构建产物与生成物。 */
export const LINT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.vitest-reports/**',
  // 类型声明文件由 tsc 校验，不由 ESLint 解析
  '**/*.d.ts',
  '**/*.d.mts',
  LINT_FIXTURE_PATTERN,
];

/** 计算层（三包）的完整限制规则集。 */
export const CALCULATION_LAYER_RESTRICTIONS = {
  'no-restricted-imports': [
    'error',
    {
      paths: FORBIDDEN_FRAMEWORKS.map((name) => ({
        name,
        message:
          `计算层禁止 import 框架（${FRAMEWORK_RULE_MESSAGE}）。框架与 DOM 只允许出现在 apps/web，` +
          '引擎/协议/导出三包必须是可独立测试的纯 TS。',
      })),
    },
  ],
  'no-restricted-globals': [
    'error',
    ...FORBIDDEN_DOM_GLOBALS.map((name) => ({
      name,
      message: `计算层禁止访问 DOM/浏览器全局（${DOM_RULE_MESSAGE}）；DOM 只允许出现在 apps/web。`,
    })),
  ],
  // 堵住 `globalThis.document` / `globalThis.window` 这类绕过 no-restricted-globals 的写法
  'no-restricted-properties': [
    'error',
    {
      object: 'globalThis',
      property: 'document',
      message: `计算层禁止访问 DOM（${DOM_RULE_MESSAGE}）；DOM 只允许出现在 apps/web。`,
    },
    {
      object: 'globalThis',
      property: 'window',
      message: `计算层禁止访问 window（${DOM_RULE_MESSAGE}）；DOM 只允许出现在 apps/web。`,
    },
  ],
};
