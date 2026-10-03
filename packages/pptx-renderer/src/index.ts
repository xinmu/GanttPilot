/**
 * `@ganttpilot/pptx-renderer` 公共入口。
 *
 * G0 阶段本包**只建壳**（路线图明示可延后）：PPTX 模板 A、原生形状投影、
 * 自研 OOXML 补丁（`cxnSp` 的 `stCxn/endCxn` 吸附与 `grpSp` 坐标换算）
 * 均在能力块 G7 落地——且其可行性以证伪实验 S1 的结论为准。
 *
 * 本包与 `@ganttpilot/engine` 一样受「零 DOM / 零框架依赖」铁律约束。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const PPTX_RENDERER_VERSION = '0.0.0';

/** 本包能力落地的能力块编号。 */
export const PLANNED_GATE = 'G7' as const;
