/**
 * `eslint-rules.mjs` 的类型声明（平行声明文件）。
 *
 * 存在的唯一原因：护栏自检（`packages/engine/src/boundary.spec.ts`）需要 import
 * 真实的铁律定义，而 `.mjs` 在严格模式下没有声明文件会退化为 `any`
 * （TS7016）。有了这个 `.d.mts`，测试拿到的是类型化的常量，
 * 而且仍然只依赖 `eslint` 自身已安装的类型——不需要任何第三方 `@types`。
 */

import type { Linter } from 'eslint';

/** 禁止被计算层 import 的框架。 */
export declare const FORBIDDEN_FRAMEWORKS: readonly string[];

/** 禁止被计算层直接使用的 DOM / 浏览器全局。 */
export declare const FORBIDDEN_DOM_GLOBALS: readonly string[];

/** 铁律报错文案片段：框架依赖。 */
export declare const FRAMEWORK_RULE_MESSAGE: string;

/** 铁律报错文案片段：DOM 依赖。 */
export declare const DOM_RULE_MESSAGE: string;

/** 违规夹具的路径模式（被 `pnpm lint` 忽略）。 */
export declare const LINT_FIXTURE_PATTERN: string;

/** 被 ESLint 全局忽略的构建产物与生成物。 */
export declare const LINT_IGNORES: readonly string[];

/** 计算层（三包）的完整限制规则集。 */
export declare const CALCULATION_LAYER_RESTRICTIONS: Linter.RulesRecord;
