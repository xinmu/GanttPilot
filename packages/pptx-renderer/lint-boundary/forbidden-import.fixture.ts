/**
 * 护栏夹具（fixture）——**故意违规**，唯一用途是让
 * `packages/engine/src/boundary.spec.ts` 证明限制规则对本包同样生效。
 *
 * 该文件已被 ESLint 全局忽略，不参与 `pnpm lint` 与类型检查。请勿「修复」。
 */
import 'vue';

export const forbiddenFixture = 'vue';
