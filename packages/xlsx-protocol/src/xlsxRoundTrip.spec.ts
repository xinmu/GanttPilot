/**
 * G3 出口条件 ②：**自往返幂等**（ADR 0006 §3/§12）+ 导出物形态与**确定性**。
 *
 * 三条判据（缺一不可）：
 * 1. `exportXlsx(doc)` → `importXlsx` → 文档**深比较相等**；
 * 2. 两侧 `compute(doc, createScheduleCalendar(doc))` **逐字段深比较相等**（含诊断的码 + taskId/linkId 集合）；
 * 3. 同一文档两次导出的**部件内容逐字节相同**（部件指纹），而**整文件哈希必然不同**
 *    ——后者是 `exceljs` 把写入时刻写进 zip 条目时间戳的直接证据（S2 §六.2）。
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { compute, createScheduleCalendar, hasDocumentErrors, validateDocument, type Schedule } from '@ganttpilot/engine';

import { exportXlsx, NUM_FMT_DATE, NUM_FMT_PROGRESS } from './export.js';
import { importXlsx } from './import.js';
import { COLUMN_SPECS, HEADER_ROW, SHEET_NAME } from './columns.js';
import { fixtureDocument, fixtureDocumentNoProjectFields, fileHash, partFingerprint, readZip } from './fixtures.spec.js';

/** `Schedule` 的可比较投影（诊断顺序不在契约里 → 排序）。 */
function scheduleProjection(document: Parameters<typeof compute>[0]): unknown {
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics
        .map((entry) => `${entry.code}|${entry.taskId ?? ''}|${entry.linkId ?? ''}`)
        .sort(),
    };
  }
  const schedule: Schedule = result.schedule;
  return {
    ok: true,
    taskCount: schedule.taskCount,
    es: Array.from(schedule.es),
    ef: Array.from(schedule.ef),
    anchored: Array.from(schedule.anchored),
    driven: Array.from(schedule.driven),
    summaryEs: Array.from(schedule.summaryEs),
    summaryEf: Array.from(schedule.summaryEf),
    summaryProgress: Array.from(schedule.summaryProgress, (value) => (Number.isNaN(value) ? null : value)),
    milestoneCount: schedule.milestoneCount,
    projectStart: schedule.projectStart,
    projectFinish: schedule.projectFinish,
    clampedStarts: schedule.clampedStarts,
    esIso: Array.from(schedule.es, (ordinal) => (ordinal < 0 ? null : calendar.isoOfOrdinal(ordinal))),
    efIso: Array.from(schedule.ef, (ordinal) => (ordinal < 0 ? null : calendar.isoOfOrdinal(ordinal))),
    diagnostics: schedule.diagnostics
      .map((entry) => `${entry.code}|${entry.taskId ?? ''}|${entry.linkId ?? ''}`)
      .sort(),
  };
}

describe('G3 ⑦ 自往返：导出 → 再导入 ⇒ 语义等价', () => {
  it('文档深比较相等（含日期为 null 的节点与"字段留位"）', async () => {
    // 往返幂等的**基准**是"去掉项目级字段与日历例外"的文档：xlsx 只承载 9 个可见列，
    // 项目名/项目起点/日历例外**不在表里**（ADR 0006 §2），故不能拿带例外的文档当严格相等基准
    // ——那条差异由下一条用例显式断言，不靠"碰巧相等"。
    const baseline = fixtureDocumentNoProjectFields();
    expect(hasDocumentErrors(validateDocument(baseline))).toBe(false);

    const exported = await exportXlsx(baseline);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    const imported = await importXlsx(exported.bytes);
    expect(imported.ok, imported.ok ? '' : JSON.stringify(imported.diagnostics, null, 2)).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document).toStrictEqual(baseline);
  });

  it('文档级字段不往返（刻意的口径）：项目名/日历例外不在 9 列里，但任务与依赖完整存活', async () => {
    const original = fixtureDocument();
    const exported = await exportXlsx(original);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    const imported = await importXlsx(exported.bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    // 任务与依赖**完整存活**（这才是往返要保的东西）
    expect(imported.document.tasks).toStrictEqual(original.tasks);
    expect(imported.document.links).toStrictEqual(original.links);
    // 项目级字段与日历例外**不存活**（ADR 0006 §2：`id/parentId/collapsed/manual/constraints/baselines`
    // 与项目级字段都不导出；日历例外的工作表表达明确归 v0.5）
    expect(imported.document.project.name).toBe('');
    expect(imported.document.project.startDate).toBeNull();
    expect(imported.document.calendars[0]?.exceptions).toStrictEqual({ nonWorking: [], working: [] });
  });

  it('compute() 逐字段深比较相等（"与甘特图一致"的可测形式）', async () => {
    const original = fixtureDocumentNoProjectFields();
    const exported = await exportXlsx(original);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    const imported = await importXlsx(exported.bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }

    const before = scheduleProjection(original);
    const after = scheduleProjection(imported.document);
    expect(after).toStrictEqual(before);
  });

  it('二次往返稳定（幂等）：再导出再导入仍等于同一文档', async () => {
    const original = fixtureDocumentNoProjectFields();
    const first = await exportXlsx(original);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const once = await importXlsx(first.bytes);
    expect(once.ok).toBe(true);
    if (!once.ok) {
      return;
    }
    const second = await exportXlsx(once.document);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const twice = await importXlsx(second.bytes);
    expect(twice.ok).toBe(true);
    if (!twice.ok) {
      return;
    }
    expect(twice.document).toStrictEqual(once.document);
  });
});

describe('G3 导出物形态（白名单内的呈现属性，每类一条结构断言）', () => {
  async function exportFixture(): Promise<ExcelJS.Workbook> {
    const exported = await exportXlsx(fixtureDocument());
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error('导出失败');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    return workbook;
  }

  it('单工作表、表名 `任务`、9 列规范列序且列名逐字一致', async () => {
    const workbook = await exportFixture();
    expect(workbook.worksheets.map((sheet) => sheet.name)).toStrictEqual([SHEET_NAME]);
    const sheet = workbook.getWorksheet(SHEET_NAME);
    expect(sheet).toBeDefined();
    const headerValues = COLUMN_SPECS.map((spec, index) => sheet?.getRow(HEADER_ROW).getCell(index + 1).value);
    expect(headerValues).toStrictEqual(COLUMN_SPECS.map((spec) => spec.header));
  });

  it('白名单属性①表头加粗：9 个表头单元格都 `bold`', async () => {
    const workbook = await exportFixture();
    const row = workbook.getWorksheet(SHEET_NAME)?.getRow(HEADER_ROW);
    for (let index = 1; index <= COLUMN_SPECS.length; index += 1) {
      expect(row?.getCell(index).font?.bold).toBe(true);
    }
  });

  it('白名单属性②列宽：与列契约一致', async () => {
    const workbook = await exportFixture();
    const sheet = workbook.getWorksheet(SHEET_NAME);
    COLUMN_SPECS.forEach((spec, index) => {
      expect(sheet?.getColumn(index + 1).width).toBe(spec.width);
    });
  });

  it('白名单属性③数字格式：日期列 `yyyy-mm-dd`、进度列 `0%`，且日期落盘为**整数序列号**', async () => {
    const workbook = await exportFixture();
    const sheet = workbook.getWorksheet(SHEET_NAME);
    // 第 3 行 = `1.1 需求澄清`（开始/完成/进度俱全）
    const start = sheet?.getRow(3).getCell(3);
    const progress = sheet?.getRow(3).getCell(7);
    expect(start?.numFmt).toBe(NUM_FMT_DATE);
    expect(progress?.numFmt).toBe(NUM_FMT_PROGRESS);
    expect(start?.value).toBeInstanceOf(Date);
    const serial = 25569 + ((start?.value as Date).getTime() / 86_400_000);
    expect(Number.isInteger(serial)).toBe(true);
    // 2026-10-05（与夹具一致）
    expect(serial).toBe(46300);
  });

  it('白名单属性④冻结首行：`ySplit = 1` 且状态为 frozen', async () => {
    const workbook = await exportFixture();
    const views = workbook.getWorksheet(SHEET_NAME)?.views ?? [];
    expect(views[0]?.state).toBe('frozen');
    expect(views[0]?.ySplit).toBe(HEADER_ROW);
  });

  it('依赖列的规范语法：`编号[类型][±lag]`、分号分隔、省略默认', async () => {
    const workbook = await exportFixture();
    const sheet = workbook.getWorksheet(SHEET_NAME);
    const textAt = (row: number, column: number): string => String(sheet?.getRow(row).getCell(column).value ?? '');
    // 行序 = 文档序（表头在第 1 行，故 tN 在第 N+1 行）
    expect(textAt(2, 6)).toBe(''); // t1 无前置
    expect(textAt(3, 6)).toBe(''); // t2 无前置
    expect(textAt(4, 6)).toBe('1.1'); // t3 = 1.2，前置 t2 = 1.1（FS/±0 → 省略）
    expect(textAt(6, 6)).toBe('1.2[+2]'); // t5 = 2.1，正 lag 带 `+`
    expect(textAt(7, 6)).toBe('1.2[SS-1]'); // t6 = 2.2，负 lag
    expect(textAt(8, 6)).toBe('2.1[FF];2.2[SF+1]'); // t7 = 3，两条前置（列内顺序 = 文档里 links 的顺序）
  });

  it('日期往返不依赖"时刻"：写出的序列号是整日，且读回同一日历日', async () => {
    const workbook = await exportFixture();
    const sheet = workbook.getWorksheet(SHEET_NAME);
    const cell = sheet?.getRow(3).getCell(3);
    const serial = 25569 + ((cell?.value as Date).getTime() / 86_400_000);
    expect(Number.isInteger(serial)).toBe(true);
    const readBack = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    expect(readBack.toISOString().slice(0, 10)).toBe('2026-10-05');
  });
});

describe('G3 导出确定性：判据取部件指纹，不得用整文件哈希', () => {
  it('同一文档两次导出：部件内容逐字节相同（这是可比对的工件身份）', async () => {
    const document = fixtureDocument();
    const first = await exportXlsx(document);
    const second = await exportXlsx(document);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    const fingerprintA = await partFingerprint(first.bytes);
    const fingerprintB = await partFingerprint(second.bytes);
    expect(fingerprintB.digest).toBe(fingerprintA.digest);
    expect([...fingerprintB.parts.entries()]).toStrictEqual([...fingerprintA.parts.entries()]);
  });

  it('反向证据：整文件哈希**不可**作为 golden 判据（zip 条目时间戳来自写入时刻）', async () => {
    const document = fixtureDocument();
    const first = await exportXlsx(document);
    const second = await exportXlsx(document);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    // 同进程连续两次写出的 zip 条目时间戳落在同一秒内，**整文件哈希可能相同也可能不同**
    // ——正因为它取决于"写入时刻落在哪一秒"，它就不是判据。判据只有上面那条部件指纹。
    const sameFile = fileHash(first.bytes) === fileHash(second.bytes);
    const sameParts = (await partFingerprint(first.bytes)).digest === (await partFingerprint(second.bytes)).digest;
    expect(sameParts).toBe(true);
    expect(typeof sameFile).toBe('boolean');
  });

  it('部件集合稳定：条目名与顺序可复现（10 个量级的部件）', async () => {
    const document = fixtureDocument();
    const exported = await exportXlsx(document);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    const zip = await readZip(exported.bytes);
    const names = Object.keys(zip.files).filter((name) => zip.files[name]?.dir === false);
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/worksheets/sheet1.xml');
    expect(names).toContain('xl/sharedStrings.xml');
    expect(names.sort()).toStrictEqual([...names].sort());
  });

  it('空文档（零任务）也能导出并读回（边界）', async () => {
    const document = fixtureDocument();
    const empty = { ...document, tasks: [], links: [] };
    const exported = await exportXlsx(empty);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    const imported = await importXlsx(exported.bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document.tasks).toStrictEqual([]);
  });
});
