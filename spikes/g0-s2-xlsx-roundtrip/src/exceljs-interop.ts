/**
 * G0-S-S2 · ExcelJS 互操作的一处**类型**适配。
 *
 * 背景（实测）：`exceljs@4.4.0` 的 `index.d.ts` 第 1 行是
 *   `declare interface Buffer extends ArrayBuffer { }`
 * ——这是一个**全局**的 `Buffer` 声明，与 `@types/node` 的 `Buffer`（extends `Uint8Array`）
 * 在 TypeScript 里发生接口合并，导致 `workbook.xlsx.load(nodeBuffer)` 报
 * 「`Buffer<ArrayBufferLike>` 不可赋给 `Buffer`」。
 *
 * 这是上游类型定义的缺陷，不是运行时问题（Node 下 `xlsx.load` 完全可用）。
 * 这里只做**一次**显式转换，避免在每个调用点各写一遍 `as unknown as`。
 */

import type ExcelJS from 'exceljs';

type LoadArgument = Parameters<ExcelJS.Xlsx['load']>[0];

export async function loadWorkbook(workbook: ExcelJS.Workbook, bytes: Buffer | Uint8Array): Promise<void> {
  await workbook.xlsx.load(bytes as unknown as LoadArgument);
}
