/**
 * 护栏夹具（fixture）——**故意违规**，唯一用途是让
 * `packages/engine/src/boundary.spec.ts` 证明限制规则对 `@ganttpilot/render-core` 同样生效
 * （ADR 0007 §2：本包并入「零框架依赖 / 零 DOM 依赖」约束集）。
 *
 * 该文件已被 ESLint 全局忽略，不参与 `pnpm lint` 与类型检查。请勿「修复」。
 */
import 'vue';

export const forbiddenFixture = 'vue';
