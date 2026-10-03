/**
 * `@ganttpilot/xlsx-protocol` 公共入口。
 *
 * G0 阶段本包只建壳（能力块 G3 落地）：导入双解析、依赖列语法 `编号[FS|SS|FF|SF][±lag]`、
 * 规范化导出与结构化诊断均尚未实现。此处**不承诺最终 API 形状**。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const XLSX_PROTOCOL_VERSION = '0.0.0';

/** 本包能力落地的能力块编号（便于在 G0 阶段确认包骨架已就位）。 */
export const PLANNED_GATE = 'G3' as const;
