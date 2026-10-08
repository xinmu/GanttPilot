/**
 * **模板文件**的判据（**进 `pnpm gate`**；P-46／ADR 0006 附录 §1 的三条结构判据 + 负向对照）。
 *
 * 覆盖：
 * 1. 页签**集合与顺序**（恰好三个、顺序固定）；
 * 2. `任务` 页的 **9 列列序与表头**与 `COLUMN_SPECS` 逐值一致；
 * 3. **两次生成一致**（固定时间戳手法 + **zip 条目时间归一化**，见下）；
 * 4. **可读回**：把模板喂给 `importXlsx` ⇒ 文档 `error 0` 且任务数与演示计划一致
 *    （"模板与协议随时对齐"的门禁侧那一半；打包产物侧那一半在 `smoke:build`）。
 *
 * 负向对照（判据必须有判别力）：调换页签顺序 / 改一个表头字面 ⇒ 第 1、2 条必须被检出；
 * 归一化**不会**吃掉真差异 ⇒ 第 3 条自带一条对照（改一个字节仍被检出）。
 *
 * ## 第 3 条为什么不是"整文件逐字节"（`N21`，P5-c3 的裁决：采候选 2）
 *
 * `buildTemplateXlsx` 固定了 `workbook.created / modified / creator / lastModifiedBy`，但 **zip 条目的
 * 时间字段由 ExcelJS 取墙上时钟**（DOS 时间、**2 s 粒度**）⇒ 两次生成只有落在**同一 2 秒窗口**内才逐字节
 * 相同。实测（P4-b 的探针）：40 组连拍 **0 不一致**；跨 2.5 s **必不一致**——长度相同，**首个差异在
 * 偏移 10**（zip 本地头的 mod time）。后果是**全量 `pnpm test` 多 worker 下偶发假红**（一条判据自己带竞态）。
 *
 * 处置（三条候选里选 2）：**判据侧归一化**——比对前把每个 zip 条目的时间字段置零，其余**仍逐字节比对**。
 * ① 生成器里固定条目时间会**改产物字节**（模板现登记 11,673），要按 golden 重锚的纪律连带动文档；
 * ③ 降级为结构判据**不推荐**：它是这三条里唯一能抓 zip 层不确定性的那一条。
 *
 * **这条判据不看什么**（写清楚，免得被当成"全字节都测了"）：每个 zip 条目的 **4 个字节**——
 * 本地头（`PK\x03\x04`）偏移 **10–13** 与中央目录（`PK\x01\x02`）偏移 **12–15** 的 mod time/date。
 * 其余一切（条目名、条目顺序、压缩结果、内容、CRC、长度）**仍逐字节比对**。
 *
 * **失效方向是安全的**：归一化只"抹平已知的非确定字节"，任何别的差异都会让比对失败 ⇒ 归一化器漏掉某个
 * 时间字段的后果是**假红**（多报），不是假绿。另有自证：断言"确实改到了东西"（`patched > 0`），
 * 否则"没测到"就会被记成 ✅（沿用 `P-41` 的口径）。
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

/** zip 的两种头签名（小端读作 uint32）：本地头与中央目录项。 */
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;

/** 时间字段在本头内的偏移：本地头从 10 起、中央目录从 12 起，各 2 字节 time + 2 字节 date。 */
const TIME_FIELD_OFFSET = { local: 10, central: 12 } as const;

/** 时间字段的宽度：mod time（2）+ mod date（2）。 */
const TIME_FIELD_WIDTH = 4;

/**
 * 把 zip 条目的时间字段置零（**只动那 4 字节 × 条目数**，其余原样），并报告改了几处。
 *
 * 扫描方式是按签名逐字节找（`PK\x03\x04` / `PK\x01\x02`）——压缩数据里理论上可能出现同样的四字节，
 * 那只会**多置零**几个字节 ⇒ 后果是"漏检"而非"误判"（见文件头"失效方向是安全的"），
 * 且下面的自证会要求 `patched > 0`。
 */
function zeroZipEntryTimestamps(bytes: Uint8Array): { normalized: Uint8Array; patched: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normalized = Uint8Array.from(bytes);
  let patched = 0;
  for (let offset = 0; offset + TIME_FIELD_WIDTH <= view.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature !== ZIP_LOCAL_SIGNATURE && signature !== ZIP_CENTRAL_SIGNATURE) continue;
    const start = offset + (signature === ZIP_LOCAL_SIGNATURE ? TIME_FIELD_OFFSET.local : TIME_FIELD_OFFSET.central);
    if (start + TIME_FIELD_WIDTH > normalized.length) continue;
    for (let index = start; index < start + TIME_FIELD_WIDTH; index += 1) normalized[index] = 0;
    patched += 1;
  }
  return { normalized, patched };
}

/** 首个差异的偏移（相同返回 `-1`；长度不同返回较短的那个长度）。报文要能指出"差在哪"。 */
function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : shared;
}

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

  it('③ 两次生成一致（固定时间戳 + 确定性行数据；zip 条目时间已归一化——见文件头）', async () => {
    const first = await buildTemplateXlsx();
    const second = await buildTemplateXlsx();
    if (!first.ok || !second.ok) throw new Error('模板生成失败');
    expect(first.bytes.length).toBe(second.bytes.length);

    const left = zeroZipEntryTimestamps(first.bytes);
    const right = zeroZipEntryTimestamps(second.bytes);

    // 归一化器自证：它必须真的改到了东西——否则"没测到"会被记成 ✅（`P-41` 的口径）。
    expect(left.patched).toBeGreaterThan(0);
    expect(left.patched).toBe(right.patched);

    const difference = firstDifference(left.normalized, right.normalized);
    expect(difference, difference < 0 ? '' : `归一化后仍有差异：偏移 ${String(difference)}`).toBe(-1);
  });

  it('③-n 负向对照：归一化**不会**吃掉真差异（改一个字节 ⇒ 仍被检出）', async () => {
    const result = await buildTemplateXlsx();
    if (!result.ok) throw new Error('模板生成失败');

    const clean = zeroZipEntryTimestamps(result.bytes);
    const tampered = Uint8Array.from(result.bytes);
    // 偏移 30 是第一个条目的**文件名首字节**（本地头定长 30 字节），远离被归一化的 10–13。
    tampered[30] = (tampered[30] ?? 0) ^ 0x01;
    const dirty = zeroZipEntryTimestamps(tampered);

    expect(dirty.patched).toBe(clean.patched); // 前提自证：这次改动没有碰到时间字段
    expect(firstDifference(clean.normalized, dirty.normalized)).toBe(30);
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
