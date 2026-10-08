/**
 * 护栏夹具（fixture）——**故意访问 DOM 全局**，唯一用途是让
 * `packages/engine/src/boundary.spec.ts` 证明「零 DOM 依赖」规则对
 * `@ganttpilot/pptx-renderer` 同样生效（ADR 0007 §2：每个计算层包自带一组夹具）。
 *
 * 该文件已被 ESLint 全局忽略，不参与 `pnpm lint` 与类型检查。请勿「修复」。
 */
export const readWindowTitle = (): string => window.document.title;
