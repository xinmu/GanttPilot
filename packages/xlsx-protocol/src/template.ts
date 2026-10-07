/**
 * **模板文件**（多页签 xlsx）——面向人的入门产物（P-46 新增，ADR 0006 附录 §1 登记）。
 *
 * ## 定位：它**不是**往返产物
 *
 * | 层 | 口径 |
 * |---|---|
 * | 给人看 | "该怎么填"——列语义、4 类依赖语法、容差闭集要点、常见错误 ↔ 诊断码 |
 * | 给机器看 | "填出来的东西能不能被读回来"——第一页**必须**能被 `importXlsx` 直接读入 |
 *
 * ## 三条被冻结的结构规则（改它就等于改契约）
 *
 * 1. **恰好三个页签、顺序固定**：`任务` / `填写说明与约束` / `最小示例`；
 * 2. `任务` 页**必须**是规范 9 列（列序、表头、必需性同 ADR 0006 §2），**必须**可被 `importXlsx` 读入；
 * 3. **不设隐藏表**（ADR 0006 §2/§10）；说明页与示例页的呈现属性仍受 §10 的白名单约束。
 *
 * ## 一条工程纪律：**不手抄列契约**
 *
 * `任务` 页的生成方式是"**先让 `exportXlsx` 写出规范表，再原样搬运它的单元格**"，
 * 而不是在本文件里再写一遍表头/列序/依赖文本。理由：那会造出第二份真相源，
 * 而"模板与协议随时对齐"正是本条的验收目标（判据：两次生成逐字节一致 + 打包产物上回导 `error 0`）。
 *
 * ## 为什么 `exceljs` 只在这个文件里被 `await import()`
 *
 * 与 §11 的动态导入约束同一条纪律：本模块只由**用户动作**（点「模板下载」）触发，
 * 因此 925 KB 的库不会进首屏主 chunk（ADR 0006 §11）。公共入口是 `async` 的，理由同 `exportXlsx`。
 */

import {
  hasDocumentErrors,
  validateDocument,
  type LinkType,
  type ProjectDocument,
} from '@ganttpilot/engine';
import { createDemoPlanDocument } from '@ganttpilot/render-core';

import { COLUMN_SPECS, HEADER_ROW, SHEET_NAME } from './columns.js';
import { DiagnosticBag, type XlsxDiagnostic } from './diagnostics.js';
import { exportXlsx, FIXED_DOCUMENT_AUTHOR, FIXED_DOCUMENT_TIMESTAMP, formatDependencyText } from './export.js';

/**
 * 模板的页签名（**唯一定义处**；[ADR 0006 附录 §1](../…/docs/02-adr/附录/0006-增补.md) 的登记值）。
 *
 * 顺序即契约：① 任务（可被读回）② 填写说明与约束 ③ 最小示例。
 * 判据（`template.spec.ts`）断言"集合与顺序"逐值等于本常量——改字面必须同步 ADR 附录并补名称断言。
 */
export const TEMPLATE_SHEET_TASK = SHEET_NAME;
export const TEMPLATE_SHEET_GUIDE = '填写说明与约束';
export const TEMPLATE_SHEET_SAMPLE = '最小示例';

/** 模板的页签顺序（冻结；判据逐值断言它）。 */
export const TEMPLATE_SHEET_ORDER: readonly string[] = [
  TEMPLATE_SHEET_TASK,
  TEMPLATE_SHEET_GUIDE,
  TEMPLATE_SHEET_SAMPLE,
];

/** 模板生成结果（出参一律 `Uint8Array`，与 `ExportResult` 同口径）。 */
export type TemplateResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly diagnostics: readonly XlsxDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly XlsxDiagnostic[] };

/**
 * 「填写说明与约束」页的正文（**每行一格**；内容与 ADR 0006 §2/§4/§7 与 `PROTOCOL.md` 对齐）。
 *
 * 为什么要写成常量表而不是在生成函数里拼字符串：它要被判据**逐行**读出来做"与码表对齐"的断言，
 * 也要给"两次生成逐字节一致"提供确定性输入（数组顺序即写入顺序）。
 */
export const TEMPLATE_GUIDE_LINES: readonly string[] = [
  'GanttPilot 导入模板 —— 填写说明与约束',
  '',
  '【怎么用】把"任务"页删掉示例内容后照格式填写，保存为 .xlsx，在 GanttPilot 里点「导入 xlsx」。',
  '  · 保留表头行（第 1 行）不动；列的顺序可以任意，导入按列名匹配。',
  '  · 只有「任务名称」是必需的；层级用 WBS 编号或缩进任一种表达即可。',
  '',
  '【列语义】',
  '  · WBS：层级来源，形如 1 / 1.2 / 1.2.3（每段十进制整数、无前导零、段数 ≤ 20）。与缩进二选一。',
  '  · 任务名称：必填，原样保留（首尾空白会被记录为提示，但值仍原样）。',
  '  · 开始 / 完成：真日期，或 yyyy-mm-dd / yyyy/m/d / yyyy.m.d 文本；空 = 缺失。',
  '  · 工期：整数工作日；0 合法（= 里程碑）；空 = 缺失（不是 0）。',
  '  · 前置任务：编号[类型][±lag]，多条用半角分号分隔，例如 1.2;1.3SS+2;1.4FF-1。',
  '      - 类型可省略（默认 FS）：FS 完成-开始 / SS 开始-开始 / FF 完成-完成 / SF 开始-完成。',
  '      - lag 单位是工作日，可正可负；负 lag 可能被项目起点截断。',
  '  · 进度：0..1 的小数，或 50% / 50 这样的百分数；空 = 未知（不是 0）。',
  '  · 里程碑：是/否、TRUE/FALSE、1/0 均可；空 = 否。工期恒为 0。',
  '  · 备注：原样文本，不参与排程。',
  '',
  '【三类空要分清】空单元格 / 公式没有缓存值 / 公式被扁平化——后两类会给提示，不要靠公式计算工期。',
  '',
  '【常见错误 → 诊断码】导入结果在 GanttPilot 的「诊断」面板里逐条列出，码表与下列一致：',
  '  · 找不到必需列            → XLSX_REQUIRED_COLUMN_MISSING（error，导入中止）',
  '  · 有列名不认识            → XLSX_UNRECOGNIZED_COLUMN（warning，忽略该列）',
  '  · 日期无法解析            → XLSX_DATE_UNPARSABLE（warning，按缺失处理）',
  '  · 日期序列号带时刻        → XLSX_DATE_HAS_TIME（warning，取 UTC 日期部分）',
  '  · 日期超出可表示范围      → XLSX_DATE_OUT_OF_RANGE（error）',
  '  · 工期是小数              → XLSX_DURATION_NOT_INTEGER（error，不四舍五入）',
  '  · 工期是负数              → XLSX_DURATION_NEGATIVE（error）',
  '  · 进度越界                → XLSX_PROGRESS_OUT_OF_RANGE（error）',
  '  · 进度无法解析            → XLSX_PROGRESS_UNPARSABLE（warning）',
  '  · 里程碑值不认识          → XLSX_MILESTONE_UNRECOGNIZED（warning，取否）',
  '  · 依赖语法错 / 编号不存在 → XLSX_DEPENDENCY_UNPARSABLE（warning，丢弃该条）',
  '  · 依赖指向自己            → XLSX_DEPENDENCY_SELF_LOOP（warning）',
  '  · 重复依赖                → XLSX_DEPENDENCY_DUPLICATE（warning，只保留首条）',
  '  · 依赖端点是阶段汇总行    → XLSX_DEPENDENCY_SUMMARY_ENDPOINT（warning，保留但排程忽略）',
  '  · 依赖构成环              → XLSX_CYCLE_EDGE_DROPPED（warning，按确定性顺序丢弃）',
  '  · 公式没有缓存值          → XLSX_FORMULA_WITHOUT_CACHED_VALUE（info）',
  '',
  '【不保留的东西】导入导出不保留你原有的列顺序、样式、公式与宏；请把模板当"数据入口"，不要当模板样式。',
  '【规模】单项目承诺 ≤ 2,000 任务 / 3,000 依赖；超出会提示，但仍尽力渲染。',
];

/**
 * 生成「最小示例」页的行文本（**取 `demoPlan.ts` 的演示口径**，ADR 0006 附录 §1）。
 *
 * 示例与"任务"页同源（都是 `createDemoPlanDocument()` 的 15 行），因此不需要第二份示例数据；
 * 本函数只做"把文档行铺成可读文本"这一步。
 */
function sampleRowsOf(document: ProjectDocument): readonly (readonly string[])[] {
  const outlineOf = new Map(document.tasks.map((task) => [task.id, task.outlineNumber]));
  /** 与导出路径**同一份**依赖文本格式化（`formatDependencyText`）；不在这里另拼一份（P3/C2）。 */
  const predecessorsOf = new Map<string, { outlineNumber: string; type: LinkType; lagDays: number }[]>();
  for (const link of document.links) {
    const from = outlineOf.get(link.from);
    if (from === undefined) continue;
    const list = predecessorsOf.get(link.to) ?? [];
    list.push({ outlineNumber: from, type: link.type, lagDays: link.lagDays });
    predecessorsOf.set(link.to, list);
  }
  const header = COLUMN_SPECS.map((spec) => spec.header);
  const rows: string[][] = [[...header]];
  for (const task of document.tasks) {
    rows.push([
      task.outlineNumber,
      task.name,
      task.startDate ?? '',
      task.endDate ?? '',
      task.durationDays === null ? '' : String(task.durationDays),
      formatDependencyText(predecessorsOf.get(task.id) ?? []),
      task.progress === null ? '' : String(task.progress),
      task.milestone ? '是' : '',
      task.notes ?? '',
    ]);
  }
  return rows;
}

/** 列宽（说明页与示例页；白名单内的呈现属性，ADR 0006 §10）。 */
const GUIDE_COLUMN_WIDTH = 100;
const SAMPLE_COLUMN_WIDTHS = COLUMN_SPECS.map((spec) => spec.width);

/**
 * 生成模板文件（**运行时生成，仓库内不放 `.xlsx` 二进制**——P-46 §5）。
 *
 * 管线：
 * 1. `exportXlsx(演示计划)` 产出**规范表**的字节（列序/表头/依赖文本只有一份真相源）；
 * 2. 用 `exceljs` 读回它，把 `任务` 页的**单元格值 / numFmt / 列宽 / 表头加粗**原样搬进新工作簿；
 * 3. 追加「填写说明与约束」与「最小示例」两页（各一列文本 / 9 列文本）；
 * 4. 固定 `created`/`modified`/作者 ⇒ **两次生成逐字节一致**（与 `exportXlsx` 同一手法）。
 *
 * `项目文档` 缺省 = 演示计划（`demoPlan.ts`），因此调用方（`apps/web`）只需"点一下"。
 */
export async function buildTemplateXlsx(document?: ProjectDocument): Promise<TemplateResult> {
  const bag = new DiagnosticBag();
  const source = document ?? createDemoPlanDocument();

  /**
   * ⓪ **前提自检**：模板的演示计划本身必须是干净文档。
   *
   * 不成立时不产出字节（照 `exportXlsx` 的失败口径）：一份自己都读不回来的模板，
   * 只会把用户引到错误格式上。**不新增诊断码**——这里复用既有码表里表示
   * "规范表的表头/结构不可用"的那一条（ADR 0006 §7 的码表是闭集）。
   */
  const sourceCheck = validateDocument(source);
  if (hasDocumentErrors(sourceCheck)) {
    for (const diagnostic of sourceCheck) {
      if (diagnostic.severity !== 'error') continue;
      bag.add(
        'XLSX_HEADER_ROW_INVALID',
        `模板的演示计划本身有 error 级问题（${diagnostic.code}）：${diagnostic.message}`,
      );
    }
    return { ok: false, diagnostics: bag.items };
  }

  // ① 规范表（复用导出路径 ⇒ 列契约不可能分叉）。
  const spec = await exportXlsx(source, { sheetName: TEMPLATE_SHEET_TASK });
  if (!spec.ok) {
    return { ok: false, diagnostics: spec.diagnostics };
  }

  // ② 读回规范表。
  const { default: ExcelJS } = await import('exceljs');
  const specWorkbook = new ExcelJS.Workbook();
  await specWorkbook.xlsx.load(spec.bytes as unknown as ArrayBuffer);
  const specSheet = specWorkbook.getWorksheet(TEMPLATE_SHEET_TASK);
  if (specSheet === undefined) {
    bag.add('XLSX_HEADER_ROW_INVALID', `模板生成失败：规范表 ${TEMPLATE_SHEET_TASK} 页在导出的字节里不存在`);
    return { ok: false, diagnostics: bag.items };
  }

  // ③ 新工作簿：时间字段取**常量**（否则两次生成的部件内容不同）。
  const workbook = new ExcelJS.Workbook();
  workbook.created = FIXED_DOCUMENT_TIMESTAMP;
  workbook.modified = FIXED_DOCUMENT_TIMESTAMP;
  workbook.creator = FIXED_DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = FIXED_DOCUMENT_AUTHOR;

  const taskSheet = workbook.addWorksheet(TEMPLATE_SHEET_TASK, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
  });
  for (const columnSpec of COLUMN_SPECS) {
    const index = COLUMN_SPECS.indexOf(columnSpec) + 1;
    taskSheet.getColumn(index).width = columnSpec.width;
  }
  specSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const target = taskSheet.getRow(rowNumber).getCell(columnNumber);
      target.value = cell.value === null || cell.value === undefined ? null : (cell.value as never);
      if (typeof cell.numFmt === 'string' && cell.numFmt !== '') target.numFmt = cell.numFmt;
    });
  });
  for (const columnSpec of COLUMN_SPECS) {
    const index = COLUMN_SPECS.indexOf(columnSpec) + 1;
    const header = taskSheet.getRow(HEADER_ROW).getCell(index);
    header.value = columnSpec.header;
    header.font = { bold: true };
  }

  // ④ 说明页（单列文本；列宽是白名单内的呈现属性）。
  const guideSheet = workbook.addWorksheet(TEMPLATE_SHEET_GUIDE);
  guideSheet.getColumn(1).width = GUIDE_COLUMN_WIDTH;
  TEMPLATE_GUIDE_LINES.forEach((line, index) => {
    guideSheet.getCell(index + 1, 1).value = line;
  });

  // ⑤ 示例页（9 列文本，列序与规范列序一致——它是给人看的，不参与导入）。
  const sampleSheet = workbook.addWorksheet(TEMPLATE_SHEET_SAMPLE);
  SAMPLE_COLUMN_WIDTHS.forEach((width, index) => {
    sampleSheet.getColumn(index + 1).width = width;
  });
  sampleRowsOf(source).forEach((cells, rowIndex) => {
    cells.forEach((text, columnIndex) => {
      sampleSheet.getCell(rowIndex + 1, columnIndex + 1).value = text;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBuffer);
  return { ok: true, bytes, diagnostics: bag.items };
}
