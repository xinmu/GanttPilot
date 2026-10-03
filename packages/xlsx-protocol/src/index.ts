/**
 * `@ganttpilot/xlsx-protocol` 公共入口。
 *
 * G0 阶段本包只建壳；**G3 落地**导入双解析、依赖列语法 `编号[FS|SS|FF|SF][±lag]`、
 * 规范化导出与结构化诊断。
 *
 * **契约已在开工前冻结**（裁决 P-14）：列契约、单元格容差、公式口径、成环边丢弃顺序、
 * 导出物白名单与协议层诊断码表见 `docs/02-adr/0006-xlsx-协议契约.md`；
 * 落地后本包另出 `PROTOCOL.md` 作为权威规范（与 `engine/SCHEDULE.md` 同构）。
 * 公共 API 的形状（`importXlsx` / `exportXlsx` / `detectColumns`）已在 ADR 0006 §1 冻结。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const XLSX_PROTOCOL_VERSION = '0.0.0';

/** 本包能力落地的能力块编号（便于在 G0 阶段确认包骨架已就位）。 */
export const PLANNED_GATE = 'G3' as const;
