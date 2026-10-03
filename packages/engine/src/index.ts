/**
 * `@ganttpilot/engine` 公共入口。
 *
 * G0 阶段先建立包骨架与出口契约；文档 schema、命令层、`compute()` 排程内核与
 * 日期算术在 G1/G2 落地，届时本文件的导出面会显著扩张——
 * **此处不承诺最终 API 形状**。
 *
 * 铁律（以可执行检查保证）：本包不得 import 任何框架（Vue/React/…），
 * 也不得访问 DOM 全局。见 `docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md`。
 */

/** 本包按 semver 独立发版（见 README「文档约定」）。 */
export const ENGINE_VERSION = '0.0.0';

/** 本包首个能力落地的能力块编号（日历语义与命令层见 G1，传播内核见 G2）。 */
export const PLANNED_GATE = 'G1' as const;

