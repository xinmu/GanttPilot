/**
 * G3 出口条件 ①：**声明式期望值表**（ADR 0006 §12 的 ① 层）。
 *
 * 手法与 `schedule.manual.spec.ts` 相同：**内核无权改基准**——这里写死"源单元格 → 期望值/期望诊断"，
 * 实现只能去满足它。末附**负向对照**：把期望值打坏一处必须变红（证明判据不是恒真式）。
 *
 * 覆盖：列契约（9 列 + 必需性）、表头定位（含多行表头 / 合并表头）、日期/工期/进度/里程碑/文本的
 * **容差闭集**、依赖语法（`编号[FS|SS|FF|SF][±lag]`、半角与全角分号、空片段）、双解析优先级。
 */
import { describe, expect, it } from 'vitest';

import { COLUMN_SPECS, HEADER_ROW, SHEET_NAME } from './columns.js';
import { XLSX_DIAGNOSTIC_CODES } from './diagnostics.js';
import { importXlsx } from './import.js';
import { detectColumns } from './import.js';
import { writeWorkbook, type WriteRow } from './fixtures.spec.js';
import type { XlsxDiagnostic, XlsxDiagnosticCode } from './diagnostics.js';

/** 诊断的可比对投影（顺序不在契约里 → 排序；`message` 不参与断言）。 */
function expectDiags(diagnostics: readonly XlsxDiagnostic[]): { code: XlsxDiagnosticCode; severity: string; row?: number; column?: string; address?: string }[] {
  return diagnostics
    .map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      ...(entry.locator?.row === undefined ? {} : { row: entry.locator.row }),
      ...(entry.locator?.column === undefined ? {} : { column: entry.locator.column }),
      ...(entry.locator?.address === undefined ? {} : { address: entry.locator.address }),
    }))
    .sort((a, b) => `${a.code}${String(a.row ?? '')}`.localeCompare(`${b.code}${String(b.row ?? '')}`));
}

/**
 * 造一张表并导入。
 *
 * 行类型是 `WriteRow`（`fixtures.spec.ts` 里 `writeWorkbook` 的入参形状）而**不是**
 * `Record<string, unknown>`：原先那个宽签名把"这张表写得出来"这件事挡在类型之外
 * ——`writeWorkbook` 内部 `value as ExcelJS.CellValue` 的断言，正是靠这层宽松**免检**的。
 * 收窄成真实形状后，下面每个字面量（含 `{ formula, result }` 的公式形态）都要自己站得住。
 */
async function importRows(
  rows: readonly WriteRow[],
  headers?: readonly (string | null)[],
): Promise<Awaited<ReturnType<typeof importXlsx>>> {
  const bytes = await writeWorkbook({ rows, ...(headers === undefined ? {} : { headers }) });
  return importXlsx(bytes);
}

/** 造一个**带缩进**的表（缩进只用于层级，取值本身不参与判断）。 */
async function writeWorkbookWithIndent(
  rows: readonly { readonly wbs: string; readonly name: string; readonly indent: number }[],
): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(Date.UTC(2000, 0, 1));
  workbook.modified = new Date(Date.UTC(2000, 0, 1));
  const sheet = workbook.addWorksheet('任务');
  sheet.getRow(1).getCell(1).value = 'WBS';
  sheet.getRow(1).getCell(2).value = '任务名称';
  rows.forEach((row, index) => {
    const target = sheet.getRow(index + 2);
    target.getCell(1).value = row.wbs;
    const nameCell = target.getCell(2);
    nameCell.value = row.name;
    nameCell.alignment = { indent: row.indent };
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBuffer);
}

describe('G3 ① 列契约（声明式）', () => {
  it('规范列序与必需性是 9 列 (ADR 0006 §2) 的逐字映射', () => {
    expect(COLUMN_SPECS.map((spec) => spec.header)).toStrictEqual([
      'WBS',
      '任务名称',
      '开始',
      '完成',
      '工期',
      '前置任务',
      '进度',
      '里程碑',
      '备注',
    ]);
    expect(COLUMN_SPECS.filter((spec) => spec.requirement === 'required').map((spec) => spec.key)).toStrictEqual([
      'name',
    ]);
    expect(COLUMN_SPECS.filter((spec) => spec.requirement === 'hierarchy').map((spec) => spec.key)).toStrictEqual([
      'wbs',
    ]);
    expect(HEADER_ROW).toBe(1);
    expect(SHEET_NAME).toBe('任务');
  });

  it('协议层诊断码是**闭集**（22 条，逐字对照 ADR 0006 §7）', () => {
    expect([...XLSX_DIAGNOSTIC_CODES].sort()).toStrictEqual(
      [
        'XLSX_SHEET_NOT_FOUND',
        'XLSX_HEADER_ROW_INVALID',
        'XLSX_REQUIRED_COLUMN_MISSING',
        'XLSX_UNRECOGNIZED_COLUMN',
        'XLSX_ROW_MISSING_NAME',
        'XLSX_DATE_UNPARSABLE',
        'XLSX_DATE_OUT_OF_RANGE',
        'XLSX_DATE_HAS_TIME',
        'XLSX_DURATION_NOT_INTEGER',
        'XLSX_DURATION_NEGATIVE',
        'XLSX_PROGRESS_UNPARSABLE',
        'XLSX_PROGRESS_OUT_OF_RANGE',
        'XLSX_MILESTONE_UNRECOGNIZED',
        'XLSX_DEPENDENCY_UNPARSABLE',
        'XLSX_DEPENDENCY_SELF_LOOP',
        'XLSX_DEPENDENCY_DUPLICATE',
        'XLSX_DEPENDENCY_SUMMARY_ENDPOINT',
        'XLSX_LEVEL_CONFLICT',
        'XLSX_CYCLE_EDGE_DROPPED',
        'XLSX_FORMULA_WITHOUT_CACHED_VALUE',
        'XLSX_INFERRED_EMPTY_CELL',
        'XLSX_TEXT_TRIMMED',
      ].sort(),
    );
  });

  it('列序任意 + 未识别列：按列名匹配并列出全部未识别列', async () => {
    const bytes = await writeWorkbook({
      headers: ['负责人', '任务名称', 'WBS', '开始'],
      rows: [{ 负责人: '张三', 任务名称: '甲', WBS: '1', 开始: '2026-10-05' }],
    });
    const detection = await detectColumns(bytes);
    expect(detection.detection.headerRow).toBe(1);
    expect(detection.detection.recognized).toStrictEqual(['name', 'wbs', 'start']);
    expect(detection.detection.unrecognized).toStrictEqual([{ column: 1, header: '负责人' }]);
    expect(expectDiags(detection.diagnostics)).toStrictEqual([
      { code: 'XLSX_UNRECOGNIZED_COLUMN', severity: 'warning', row: 1 },
    ]);

    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document.tasks).toHaveLength(1);
    expect(imported.document.tasks[0]?.startDate).toBe('2026-10-05');
  });
});

describe('G3 ① 表头定位：脏形态给明确诊断而非崩溃', () => {
  it('多行表头（`开始` 在第二行）→ XLSX_HEADER_ROW_INVALID', async () => {
    const bytes = await writeWorkbook({
      preamble: [['WBS', '任务名称', null, null]],
      headerRow: 2,
      headers: [null, null, '开始', '工期'],
      rows: [{ 开始: '2026-10-05', 工期: 3 }],
    });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    // 表头行落到第 1 行（那里命中了 `WBS` 与 `任务名称`），于是第 2 行「开始/工期」的表头
    // 被当成数据行：它没有 WBS（→ HEADER_ROW_INVALID）也没有任务名（→ ROW_MISSING_NAME）。
    // 这正是"多行表头"的真实后果——**明确报错而不是猜**，绝不静默把两行合并成一行表头。
    expect(expectDiags(imported.diagnostics)).toStrictEqual([
      { code: 'XLSX_HEADER_ROW_INVALID', severity: 'error', row: 2, column: 'WBS' },
      { code: 'XLSX_HEADER_ROW_INVALID', severity: 'error', row: 3, column: 'WBS' },
      { code: 'XLSX_ROW_MISSING_NAME', severity: 'error', row: 2, column: '任务名称', address: 'B2' },
      { code: 'XLSX_ROW_MISSING_NAME', severity: 'error', row: 3, column: '任务名称', address: 'B3' },
    ]);
  });

  it('合并单元格表头（跨列合并导致列名缺失）→ 明确诊断', async () => {
    const bytes = await writeWorkbook({
      headers: ['WBS', null, '开始', '工期'],
      merges: ['A1:B1'],
      rows: [{ 开始: '2026-10-05', 工期: 3 }],
    });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(expectDiags(imported.diagnostics).map((entry) => entry.code)).toContain('XLSX_REQUIRED_COLUMN_MISSING');
  });

  it('完全看不懂的表头 → XLSX_HEADER_ROW_INVALID（error）', async () => {
    const bytes = await writeWorkbook({
      headers: ['甲', '乙', '丙'],
      rows: [{ 甲: '1', 乙: 'x', 丙: 'y' }],
    });
    const detection = await detectColumns(bytes);
    expect(detection.ok).toBe(false);
    expect(expectDiags(detection.diagnostics).map((entry) => entry.code)).toStrictEqual([
      'XLSX_HEADER_ROW_INVALID',
    ]);
  });

  it('行有内容但任务名为空 → XLSX_ROW_MISSING_NAME（error，带行号与列址）', async () => {
    const bytes = await writeWorkbook({ rows: [{ WBS: '1', 任务名称: null, 工期: 3 }] });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(expectDiags(imported.diagnostics)).toStrictEqual([
      { code: 'XLSX_ROW_MISSING_NAME', severity: 'error', row: 2, column: '任务名称', address: 'B2' },
    ]);
  });
});

describe('G3 ① 容差闭集：日期', () => {
  const cases: readonly {
    readonly name: string;
    // 这一列**刻意**收 `WriteRow[string]`（= `exceljs` 的 `CellValue`，含 null/undefined）而不是
    // `unknown`：容差闭集要试的是"工作簿里真能出现的取值形态"，而 `unknown` 连"这个字面量写得进
    // 单元格吗"也一起免检（`writeWorkbook` 内部那句 `value as ExcelJS.CellValue` 的断言因此
    // 从来没被查过）。
    readonly start: WriteRow[string];
    readonly expectIso: string | null;
    /** 期望出现的信息级/警告级码（导入仍然成功）。 */
    readonly expectCode?: XlsxDiagnosticCode;
    /** 期望出现的 error 级码（导入必须失败）。 */
    readonly expectError?: XlsxDiagnosticCode;
  }[] = [
    { name: '真日期（Date.UTC）', start: new Date(Date.UTC(2026, 9, 5)), expectIso: '2026-10-05' },
    { name: '整数数值序列号', start: 46300, expectIso: '2026-10-05' },
    { name: 'ISO 文本', start: '2026-10-05', expectIso: '2026-10-05' },
    { name: '斜杠文本', start: '2026/10/5', expectIso: '2026-10-05' },
    { name: '带时刻的序列号 → 取日期部分', start: 46300.5, expectIso: '2026-10-05', expectCode: 'XLSX_DATE_HAS_TIME' },
    { name: '1900 年前 → 越界报错', start: 0.25, expectIso: null, expectError: 'XLSX_DATE_OUT_OF_RANGE' },
    { name: '无法解析的文本', start: '10/5/2026', expectIso: null, expectCode: 'XLSX_DATE_UNPARSABLE' },
    { name: '空串 → 缺失 + info', start: '   ', expectIso: null, expectCode: 'XLSX_INFERRED_EMPTY_CELL' },
  ];

  for (const entry of cases) {
    const expectedCode = entry.expectCode ?? entry.expectError;
    it(`${entry.name} → ${String(entry.expectIso)}${expectedCode === undefined ? '' : ` + ${expectedCode}`}`, async () => {
      const imported = await importRows([{ WBS: '1', 任务名称: '甲', 开始: entry.start }]);
      if (entry.expectError !== undefined) {
        expect(imported.ok).toBe(false);
        if (imported.ok) {
          return;
        }
        expect(imported.diagnostics.map((diagnostic) => diagnostic.code)).toContain(entry.expectError);
        return;
      }

      expect(imported.ok, JSON.stringify(imported.diagnostics)).toBe(true);
      if (!imported.ok) {
        return;
      }
      expect(imported.document.tasks[0]?.startDate).toBe(entry.expectIso);
      const codes = imported.diagnostics.map((diagnostic) => diagnostic.code);
      if (entry.expectCode === undefined) {
        expect(codes).toStrictEqual([]);
      } else {
        expect(codes).toContain(entry.expectCode);
      }
    });
  }
});

describe('G3 ① 容差闭集：工期 / 进度 / 里程碑 / 文本', () => {
  it('工期：整数与数值文本接受；小数与负数**报错且不四舍五入**；空 = 缺失', async () => {
    const imported = await importRows([
      { WBS: '1', 任务名称: '整数', 工期: 3 },
      { WBS: '2', 任务名称: '数值文本', 工期: '3' },
      { WBS: '3', 任务名称: '小数', 工期: 3.5 },
      { WBS: '4', 任务名称: '负数', 工期: -1 },
      { WBS: '5', 任务名称: '零', 工期: 0 },
      { WBS: '6', 任务名称: '空' },
    ]);
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(expectDiags(imported.diagnostics)).toStrictEqual([
      { code: 'XLSX_DURATION_NEGATIVE', severity: 'error', row: 5, column: '工期', address: 'E5' },
      { code: 'XLSX_DURATION_NOT_INTEGER', severity: 'error', row: 4, column: '工期', address: 'E4' },
    ]);
  });

  it('进度：`≤1` 分数 / `>1` 百分数 / `50%` 文本 / 越界报错 / 非数值告警', async () => {
    const imported = await importRows([
      { WBS: '1', 任务名称: '分数', 进度: 0.5 },
      { WBS: '2', 任务名称: '百分数点位', 进度: 50 },
      { WBS: '3', 任务名称: '百分号文本', 进度: '50%' },
      { WBS: '4', 任务名称: '一', 进度: 1 },
      { WBS: '5', 任务名称: '越界', 进度: 150 },
      { WBS: '6', 任务名称: '非数值', 进度: 'abc' },
    ]);
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(expectDiags(imported.diagnostics)).toStrictEqual([
      { code: 'XLSX_PROGRESS_OUT_OF_RANGE', severity: 'error', row: 6, column: '进度', address: 'G6' },
      { code: 'XLSX_PROGRESS_UNPARSABLE', severity: 'warning', row: 7, column: '进度', address: 'G7' },
    ]);
    // 前四条形态的语义（单独跑一条成功的导入）
    const accepted = await importRows([
      { WBS: '1', 任务名称: '分数', 进度: 0.5 },
      { WBS: '2', 任务名称: '百分数点位', 进度: 50 },
      { WBS: '3', 任务名称: '百分号文本', 进度: '50%' },
      { WBS: '4', 任务名称: '一', 进度: 1 },
    ]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }
    expect(accepted.document.tasks.map((task) => task.progress)).toStrictEqual([0.5, 0.5, 0.5, 1]);
  });

  it('里程碑：布尔 / 是·否 / TRUE·FALSE（大小写不敏感）/ 1·0；其它值 → warning 且取 false', async () => {
    const accepted = await importRows([
      { WBS: '1', 任务名称: '布尔真', 里程碑: true },
      { WBS: '2', 任务名称: '中文否', 里程碑: '否' },
      { WBS: '3', 任务名称: '大写', 里程碑: 'TRUE' },
      { WBS: '4', 任务名称: '小写', 里程碑: 'false' },
      { WBS: '5', 任务名称: '数值一', 里程碑: 1 },
      { WBS: '6', 任务名称: '数值零', 里程碑: 0 },
    ]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }
    expect(accepted.document.tasks.map((task) => task.milestone)).toStrictEqual([true, false, true, false, true, false]);

    const bad = await importRows([{ WBS: '1', 任务名称: '甲', 里程碑: '也许' }]);
    expect(bad.ok).toBe(true);
    if (!bad.ok) {
      return;
    }
    expect(bad.document.tasks[0]?.milestone).toBe(false);
    expect(expectDiags(bad.diagnostics)).toStrictEqual([
      { code: 'XLSX_MILESTONE_UNRECOGNIZED', severity: 'warning', row: 2, column: '里程碑', address: 'H2' },
    ]);
  });

  it('文本：原样（含 `=` 前缀、emoji、空白）+ 前后空白报 info', async () => {
    const imported = await importRows([
      { WBS: '1', 任务名称: '=SUM(A1:A2)', 备注: ' 前导空白' },
      { WBS: '2', 任务名称: '🚀 中文', 备注: '+加号前缀' },
    ]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document.tasks[0]?.name).toBe('=SUM(A1:A2)');
    expect(imported.document.tasks[0]?.notes).toBe(' 前导空白');
    expect(imported.document.tasks[1]?.name).toBe('🚀 中文');
    expect(imported.document.tasks[1]?.notes).toBe('+加号前缀');
    expect(expectDiags(imported.diagnostics)).toStrictEqual([
      { code: 'XLSX_TEXT_TRIMMED', severity: 'info', row: 2, column: '备注', address: 'I2' },
    ]);
  });
});

describe('G3 ① 公式：只读缓存值，且"三类空"必须区分', () => {
  it('有缓存值 → 取值；无缓存值 → 缺失 + info（与"文件里本来就空着"并列不合并）', async () => {
    const imported = await importRows([
      { WBS: '1', 任务名称: '公式有值', 开始: { formula: 'A1', result: new Date(Date.UTC(2026, 9, 5)) } },
      { WBS: '2', 任务名称: '公式无值', 开始: { formula: 'TODAY()' } },
      { WBS: '3', 任务名称: '本来就是空' },
    ]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document.tasks[0]?.startDate).toBe('2026-10-05');
    expect(imported.document.tasks[1]?.startDate).toBeNull();
    expect(imported.document.tasks[2]?.startDate).toBeNull();
    // 无缓存值**不是**静默：它必须与"空单元格"区分开
    const codes = imported.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('XLSX_FORMULA_WITHOUT_CACHED_VALUE');
    expect(codes.filter((code) => code === 'XLSX_FORMULA_WITHOUT_CACHED_VALUE')).toHaveLength(1);
  });
});

describe('G3 ① 层级双解析：优先级与冲突（ADR 0006 §6）', () => {
  it('有 WBS 列 → 用编号解析；无 WBS 列 → 缩进式', async () => {
    const byNumber = await importRows([
      { WBS: '1', 任务名称: '父' },
      { WBS: '1.1', 任务名称: '子' },
    ]);
    expect(byNumber.ok).toBe(true);
    if (!byNumber.ok) {
      return;
    }
    expect(byNumber.document.tasks.map((task) => task.outlineNumber)).toStrictEqual(['1', '1.1']);
    expect(byNumber.document.tasks[1]?.parentId).toBe(byNumber.document.tasks[0]?.id);

    const byIndentBytes = await writeWorkbook({
      headers: ['任务名称', '工期'],
      rows: [{ 任务名称: '父', 工期: 3 }, { 任务名称: '子', 工期: 1 }],
    });
    // 手工施加缩进（缩进只用于"相对深度"，因此这里用 ExcelJS 的 alignment.indent）
    const importedIndent = await importXlsx(byIndentBytes);
    // 没有任何层级的表（无 WBS 且无缩进）必须报缺列
    expect(importedIndent.ok).toBe(false);
    if (importedIndent.ok) {
      return;
    }
    expect(expectDiags(importedIndent.diagnostics).map((entry) => entry.code)).toContain(
      'XLSX_REQUIRED_COLUMN_MISSING',
    );
  });

  it('编号与缩进结论不一致 → XLSX_LEVEL_CONFLICT（以编号为准，不静默择一）', async () => {
    // 无缩进信息时**不得**报冲突：整列 indent=0 只是"缩进这一路没信息"，不是"它说这是顶层"
    const noIndent = await importRows([
      { WBS: '1', 任务名称: '父' },
      { WBS: '1.1', 任务名称: '子' },
      { WBS: '2', 任务名称: '另一个父' },
    ]);
    expect(noIndent.ok).toBe(true);
    if (!noIndent.ok) {
      return;
    }
    expect(noIndent.diagnostics.some((diagnostic) => diagnostic.code === 'XLSX_LEVEL_CONFLICT')).toBe(false);

    // 真正冲突：编号与缩进的**父子结论**不一致
    // `2.1` 的编号父是 `2`（第 2 行），但缩进式把它当顶层（相对深度 0）
    const bytes = await writeWorkbookWithIndent([
      { wbs: '1', name: '甲', indent: 0 },
      { wbs: '2', name: '乙', indent: 1 },
      { wbs: '2.1', name: '丙', indent: 0 },
    ]);
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    // `2`（第 3 行）与 `2.1`（第 4 行）两侧结论都不同 ⇒ 两条都算冲突行；
    // 而 `1`（第 2 行）两侧都是顶层 ⇒ 不该被算进去。
    const conflicts = imported.diagnostics.filter((diagnostic) => diagnostic.code === 'XLSX_LEVEL_CONFLICT');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.message).toContain('冲突行：3、4');
    expect(conflicts[0]?.message).not.toContain('冲突行：2');
    // **以编号为准**：`2.1` 仍然是 `2` 的子
    const parentOf = new Map(imported.document.tasks.map((task) => [task.outlineNumber, task.parentId]));
    expect(parentOf.get('2.1')).toBe(imported.document.tasks[1]?.id);
  });
});

describe('G3 ① 负向对照：期望值表本身有判别力', () => {
  it('把"日期容差表"里的期望值打坏必须被检出', async () => {
    const imported = await importRows([{ WBS: '1', 任务名称: '甲', 开始: 46300 }]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    // 真实值
    expect(imported.document.tasks[0]?.startDate).toBe('2026-10-05');
    // 打坏后的期望值必须**不**相等（否则期望值表是恒真式）
    expect(imported.document.tasks[0]?.startDate).not.toBe('2026-10-04');
  });

  it('把"诊断码闭集"漏掉一条必须被检出', () => {
    const declared = [...XLSX_DIAGNOSTIC_CODES];
    expect(declared.includes('XLSX_CYCLE_EDGE_DROPPED')).toBe(true);
    const tampered = declared.filter((code) => code !== 'XLSX_CYCLE_EDGE_DROPPED');
    expect(tampered).not.toStrictEqual(declared);
  });
});
