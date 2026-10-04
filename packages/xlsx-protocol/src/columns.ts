/**
 * 列契约的**转型再导出**（ADR 0008 §1–§3：列身份的所有权已反转给 `@ganttpilot/render-core`）。
 *
 * ## 为什么这里只剩再导出
 *
 * 列身份的消费方比生产方更多（左表列集合、`cellText` 的列分支、编辑通道、G7 导出投影），
 * 而它们都不需要 `exceljs`。P-19 §5 ② 据此把 `ColumnKey` / `COLUMN_SPECS` 的**所有权**交给
 * `render-core`，依赖方向变为 `engine ← render-core ← xlsx-protocol`（单一方向）。
 *
 * 本文件**刻意保留**（而不是删除后让调用方改路径）：
 * - 包内所有模块（`header.ts` / `buildDocument.ts` / `export.ts` / `values.ts` / `dependencies.ts`）
 *   继续 `from './columns.js'` 取列契约，**改动面最小**；
 * - `@ganttpilot/xlsx-protocol` 的公共 API 面**一个符号不减**（`index.ts` 的再导出因此不需要改名字）；
 * - 「列契约的单一定义处」这句话仍然成立——只是那句话现在指向 `render-core`。
 *
 * **维护纪律**：新增/改名/改列序都必须改 `packages/render-core/src/columns.ts`，
 * 并同步 `PROTOCOL.md`（ADR 0006 §2 的契约表）。本文件**不得**出现第二份定义。
 */

export {
  COLUMN_SPECS,
  DATE_LIKE_COLUMNS,
  columnIndexOfKey,
  columnKeyOfIndex,
  columnSpecOfHeader,
  HEADER_ROW,
  SHEET_NAME,
  type ColumnKey,
  type ColumnRequirement,
  type ColumnSpec,
} from '@ganttpilot/render-core';
