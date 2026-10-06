/**
 * **模板文件**的判据（**进 `pnpm gate`**；P-46／ADR 0006 附录 §1 的三条结构判据 + 负向对照）。
 *
 * 覆盖：
 * 1. 页签**集合与顺序**（恰好三个、顺序固定）；
 * 2. `任务` 页的 **9 列列序与表头**与 `COLUMN_SPECS` 逐值一致；
 * 3. **两次生成逐字节一致**（固定时间戳手法，与 `exportXlsx` 同一纪律）；
 * 4. **可读回**：把模板喂给 `importXlsx` ⇒ 文档 `error 0` 且任务数与演示计划一致
 *    （"模板与协议随时对齐"的门禁侧那一半；打包产物侧那一半在 `smoke:build`）。
 *
 * 负向对照（判据必须有判别力）：调换页签顺序 / 改一个表头字面 ⇒ 第 1、2 条必须被检出。
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { createDemoPlanDocument } from '@ganttpilot/render-core';
import { hasDocumentErrors, validateDocument } from '@ganttpilot/engine';

import { COLUMN_SPECS, HEADER_ROW } from './columns.js';
import { importXlsx } from './import.js';
import {
  buildTemplateXlsx,
  TEMPLATE_SHEET_GUIDE,
  TEMPLATE_SHEET_ORDER,
  TEMPLATE_SHEET_SAMPLE,
  TEMPLATE_SHEET_TASK,
} from './template.js';

/** 读回工作簿的页签名（顺序即写入顺序）。 */
async function sheetNamesOf(bytes: Uint8Array): Promise<readonly string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets.map((sheet) => sheet.name);
}

/** 读"任务"页的表头行（按列序）。 */
async function taskHeaderOf(bytes: Uint8Array): Promise<readonly string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet(TEMPLATE_SHEET_TASK);
  if (sheet === undefined) throw new Error(`找不到 ${TEMPLATE_SHEET_TASK} 页`);
  const row = sheet.getRow(HEADER_ROW);
  const out: string[] = [];
  for (let column = 1; column <= COLUMN_SPECS.length; column += 1) {
    out.push(String(row.getCell(column).value ?? ''));
  }
  return out;
}

describe('模板文件（P-46／ADR 0006 附录 §1）', () => {
  it('① 页签集合与顺序：恰好三个、顺序固定（任务 → 填写说明与约束 → 最小示例）', async () => {
    const result = await buildTemplateXlsx();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = await sheetNamesOf(result.bytes);
    expect([...names]).toStrictEqual([...TEMPLATE_SHEET_ORDER]);
    expect(names).toHaveLength(3);
    expect(names).toStrictEqual([TEMPLATE_SHEET_TASK, TEMPLATE_SHEET_GUIDE, TEMPLATE_SHEET_SAMPLE]);
  });

  it('② "任务"页的 9 列列序与表头与 `COLUMN_SPECS` 逐值一致', async () => {
    const result = await buildTemplateXlsx();
    if (!result.ok) throw new Error('模板生成失败');
    const header = await taskHeaderOf(result.bytes);
    expect([...header]).toStrictEqual(COLUMN_SPECS.map((spec) => spec.header));
  });

  it('③ 两次生成**逐字节一致**（固定时间戳 + 确定性行数据）', async () => {
    const first = await buildTemplateXlsx();
    const second = await buildTemplateXlsx();
    if (!first.ok || !second.ok) throw new Error('模板生成失败');
    expect(first.bytes.length).toBe(second.bytes.length);
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
  });

  it('④ 可读回：模板的"任务"页喂给 `importXlsx` ⇒ 文档 error 0，且任务数与演示计划一致', async () => {
    const result = await buildTemplateXlsx();
    if (!result.ok) throw new Error('模板生成失败');
    const imported = await importXlsx(result.bytes);
    expect(imported.ok, imported.ok ? '' : JSON.stringify(imported.diagnostics, null, 2)).toBe(true);
    if (!imported.ok) return;
    const demo = createDemoPlanDocument();
    expect(imported.document.tasks).toHaveLength(demo.tasks.length);
    // **error 0**：warning（"有工期无日期"是演示计划的合法表达）可以有，error 一条都不许有。
    const errors = imported.diagnostics.filter((item) => item.severity === 'error');
    expect(errors).toStrictEqual([]);
    expect(hasDocumentErrors(validateDocument(imported.document))).toBe(false);
  });

  it('说明页的正文覆盖四类依赖语法与诊断码表要点（"填法与约束"不是一句空话）', async () => {
    const result = await buildTemplateXlsx();
    if (!result.ok) throw new Error('模板生成失败');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.bytes as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(TEMPLATE_SHEET_GUIDE);
    if (sheet === undefined) throw new Error('找不到说明页');
    const text = sheet
      .getColumn(1)
      .values.slice(1)
      .map((value) => String(value ?? ''))
      .join('\n');
    for (const needle of ['FS', 'SS', 'FF', 'SF', 'XLSX_REQUIRED_COLUMN_MISSING', 'XLSX_DEPENDENCY_UNPARSABLE']) {
      expect(text).toContain(needle);
    }
  });

  it('负向对照：调换页签顺序 / 改一个表头字面 —— ①② 必须被检出（否则那两条是恒真式）', async () => {
    const result = await buildTemplateXlsx();
    if (!result.ok) throw new Error('模板生成失败');
    const names = await sheetNamesOf(result.bytes);
    expect([...names]).toStrictEqual([...TEMPLATE_SHEET_ORDER]); // 前提自证：正例干净

    const swapped = [TEMPLATE_SHEET_GUIDE, TEMPLATE_SHEET_TASK, TEMPLATE_SHEET_SAMPLE];
    expect([...names]).not.toStrictEqual(swapped);

    const header = await taskHeaderOf(result.bytes);
    const tampered = [...header];
    tampered[1] = '名称';
    expect([...tampered]).not.toStrictEqual(COLUMN_SPECS.map((spec) => spec.header));
  });
});
