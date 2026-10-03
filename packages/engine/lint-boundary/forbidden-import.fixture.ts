/**
 * 护栏夹具（fixture）——**故意违规**，唯一用途是让 `boundary.spec.ts` 证明
 * `eslint.config.mjs` 的「零框架依赖」规则真的会拦截它。
 *
 * 该文件已被 ESLint 全局忽略（`eslint.config.mjs` 的 `ignores`），
 * 不参与 `pnpm lint`，也不参与类型检查（见 `tsconfig.check.json` 的 `exclude`）。
 * 请勿在此处「修复」import —— 修好之后护栏自检会失败。
 */
import 'vue';

export const forbiddenFixture = 'vue';
