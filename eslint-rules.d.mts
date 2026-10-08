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
export declare const FORBIDDEN_FRAMEWORKS: string[];

/** 禁止被计算层直接使用的 DOM / 浏览器全局。 */
export declare const FORBIDDEN_DOM_GLOBALS: readonly string[];

/** 铁律报错文案片段：框架依赖。 */
export declare const FRAMEWORK_RULE_MESSAGE: string;

/** 铁律报错文案片段：DOM 依赖。 */
export declare const DOM_RULE_MESSAGE: string;

/** 违规夹具的路径模式（被 `pnpm lint` 忽略）。 */
export declare const LINT_FIXTURE_PATTERN: string;

/** 被 ESLint 全局忽略的构建产物与生成物。 */
export declare const LINT_IGNORES: string[];

/** 计算层方向契约的一条（`allowed` 之外的工作区包一律不许 import）。 */
export interface CalculationLayerPackage {
  /** 包名（与 `package.json` 的 `name` 一致）。 */
  readonly name: string;
  /** 仓库相对目录（`packages/<name>`），用于生成 ESLint 的 `files` 模式。 */
  readonly dir: string;
  /** 允许 import 的工作区包；其余一律报错（含子路径导入）。 */
  readonly allowed: readonly string[];
  /** 这条方向在文档里的依据（进报错文案，便于就地判断"该不该改"）。 */
  readonly note: string;
}

/** 计算层各包的依赖方向契约（声明顺序即层级顺序：越靠前越底层）。 */
export declare const CALCULATION_LAYER_PACKAGES: readonly CalculationLayerPackage[];

/** 依赖方向的报错文案片段。 */
export declare const WORKSPACE_DEPENDENCY_RULE_MESSAGE: string;

/** 按包名取契约条目（未登记即抛）。 */
export declare function calculationLayerPackage(name: string): CalculationLayerPackage;

/** 某包不许 import 的工作区包。 */
export declare function forbiddenWorkspacePackagesFor(name: string): readonly CalculationLayerPackage[];

/**
 * 某包的 `no-restricted-imports` **完整取值**（框架 + 该包的方向契约）。
 *
 * 返回类型刻意用 ESLint 自己的 `Linter.RuleEntry`，而不是手写的元组：手写版本一旦比
 * `RulesConfig` 的期望更松（`string` 而非严重级字面量）或更严（`readonly` 数组），
 * `Linter.verify(source, config, path)` 就会报 TS2769——而那正是**配置本身**的可用性
 * （P3/C7-b 把 spec 纳入 tsc 后当场抓到，见 `boundary.spec.ts`）。
 */
export declare function restrictedImportsFor(name: string): Linter.RuleEntry;

/** 计算层（三包）的完整限制规则集。 */
export declare const CALCULATION_LAYER_RESTRICTIONS: Linter.RulesRecord;
