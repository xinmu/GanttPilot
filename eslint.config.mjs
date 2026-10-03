import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';

import { CALCULATION_LAYER_RESTRICTIONS, LINT_IGNORES } from './eslint-rules.mjs';

/**
 * GanttPilot 的 ESLint flat config。
 *
 * 这一份配置承担两件事：
 * 1. 常规静态检查（推荐规则集）；
 * 2. **把「零框架依赖、零 DOM 依赖」这条铁律变成可执行的检查**：
 *    `packages/{engine,xlsx-protocol,pptx-renderer}` 三包
 *    （a）不得 import Vue/React/Svelte 等框架；
 *    （b）不得使用 DOM/浏览器全局与 API。
 *    `apps/web` 是应用层，是这些能力的**唯一**合法落点，故在该块内显式放开。
 *
 * 规则本身定义在同目录的 `eslint-rules.mjs`，以便护栏自检
 * （`packages/engine/src/boundary.spec.ts`）对**同一份定义**断言——
 * 若有人放开这里的规则，该测试立即失败。
 */

export default [
  {
    ignores: LINT_IGNORES,
  },

  // ---------------------------------------------------------------- 基础规则
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,vue}'],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    // TS 解析器：刻意**不**启用类型感知（不设 projectService）。
    // 原因见 docs/02-adr/0001：本地门禁要覆盖测试与夹具，而类型感知检查要求每个文件
    // 都属于某个 tsconfig 项目；那会迫使 specs/夹具进入构建项目、把测试产物带进 dist。
    // 取舍是：**tsc 负责类型，ESLint 负责结构**（本仓库用到的规则都不需要类型信息）。
    files: ['**/*.{ts,mts,vue}'],
    languageOptions: {
      parser: tseslint.parser,
    },
  },

  // ------------------------------------------- 铁律：三包零框架依赖 / 零 DOM
  {
    files: ['packages/*/**/*.{ts,mts,js,mjs}'],
    rules: CALCULATION_LAYER_RESTRICTIONS,
  },

  // --------------------------------------------------- 应用层：Vue 与 DOM 的家
  ...vue.configs['flat/recommended'].map((config) => ({
    ...config,
    files: ['apps/web/**/*.{ts,mts,vue}'],
  })),
  {
    files: ['apps/web/**/*.{ts,mts,vue}'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // 应用层显式放开计算层的三条限制（这是唯一的合法落点）
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'vue/multi-word-component-names': 'off',
    },
  },

  // ------------------------------------------- 护栏夹具：故意违规，不接项目服务
  // 这些文件被上面的 `ignores` 排除在 `pnpm lint` 之外，只由护栏自检以文本方式加载。
  // 它们被故意写成 `window` / `import 'vue'`，接入 tsconfig 必然产生解析错误，
  // 而这里要验证的两条限制规则都不需要类型信息，因此显式关闭类型感知解析。
  {
    files: ['**/lint-boundary/*.fixture.*'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {},
    },
  },

  // ------------------------------------------- 脚本与配置：Node 环境，不受铁律约束
  {
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,mjs,ts}', '*.ts'],
    ignores: ['packages/**', 'apps/**'],
    languageOptions: {
      globals: {
        // Node 全局（不引入 `globals` 包，保持依赖面最小）
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
];
