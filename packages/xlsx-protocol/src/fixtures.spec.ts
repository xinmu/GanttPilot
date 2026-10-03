/**
 * G3 · 测试侧共享夹具（**故意写成 `*.spec.ts`**，同 G1.2 的 `fixtures.spec.ts` 手法）：
 * 它被其他 spec import，让"夹具是规范形状"这件事也有自检，且不进发布产物（`tsconfig` 排除 spec）。
 *
 * 三件事：
 * 1. `FIXTURE_TASKS` / `FIXTURE_LINKS`：**声明式期望值表**的基准文档（内核无权改基准）；
 * 2. `writeWorkbook` / `writeRawWorkbook`：用 ExcelJS 造真实 xlsx（含脏文件形态）；
 * 3. `partFingerprint`：**部件指纹**（条目名 + 内容哈希的摘要）——ADR 0006 §10 的确定性判据。
 */
import { createHash } from 'node:crypto';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import type { DocumentLink, DocumentTask, ProjectDocument } from '@ganttpilot/engine';

/** 固定时间戳：两次导出必须逐字节相同的部件内容，因此不能用"现在"。 */
export const FIXED_TIMESTAMP = new Date(Date.UTC(2000, 0, 1));

/** 规范工作表名与列序（测试侧也显式写出来，避免"实现改了测试跟着改"）。 */
export const HEADERS = [
  'WBS',
  '任务名称',
  '开始',
  '完成',
  '工期',
  '前置任务',
  '进度',
  '里程碑',
  '备注',
] as const;

function task(partial: Partial<DocumentTask> & Pick<DocumentTask, 'id' | 'outlineNumber' | 'name'>): DocumentTask {
  return {
    parentId: null,
    startDate: null,
    endDate: null,
    durationDays: null,
    progress: null,
    milestone: false,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
    ...partial,
  };
}

/**
 * 声明式基准文档：28 行量级里的**最小自足集**，覆盖本项目所有可见列语义。
 * 任何一条断言都以此表为准（"内核无权改基准"，同 `schedule.manual.spec.ts`）。
 */
export const FIXTURE_TASKS: readonly DocumentTask[] = [
  task({ id: 't1', outlineNumber: '1', name: '阶段一：准备', startDate: '2026-10-05', durationDays: 4 }),
  task({ id: 't2', outlineNumber: '1.1', parentId: 't1', name: '需求澄清', startDate: '2026-10-05', endDate: '2026-10-08', durationDays: 3, progress: 0.5, notes: '含 = 与 + 前缀文本' }),
  task({ id: 't3', outlineNumber: '1.2', parentId: 't1', name: '环境搭建', startDate: '2026-10-09', durationDays: 2, milestone: false }),
  task({ id: 't4', outlineNumber: '2', name: '阶段二：实现', startDate: '2026-10-12', durationDays: 10 }),
  task({ id: 't5', outlineNumber: '2.1', parentId: 't4', name: '渲染内核 🚀', startDate: '2026-10-12', durationDays: 5, progress: 0.25 }),
  task({ id: 't6', outlineNumber: '2.2', parentId: 't4', name: '导出器', durationDays: 3, progress: null }),
  task({ id: 't7', outlineNumber: '3', name: '里程碑：内审', startDate: '2026-10-26', durationDays: 0, milestone: true }),
  task({ id: 't8', outlineNumber: '4', name: '无日期任务', notes: 'DM-05：无日期节点容错' }),
];

export const FIXTURE_LINKS: readonly DocumentLink[] = [
  { id: 'l1', from: 't2', to: 't3', type: 'FS', lagDays: 0 },
  { id: 'l2', from: 't3', to: 't5', type: 'FS', lagDays: 2 },
  { id: 'l3', from: 't3', to: 't6', type: 'SS', lagDays: -1 },
  { id: 'l4', from: 't5', to: 't7', type: 'FF', lagDays: 0 },
  { id: 'l5', from: 't6', to: 't7', type: 'SF', lagDays: 1 },
];

/** 声明式基准文档（新建，不走导入）。 */
export function fixtureDocument(): ProjectDocument {
  return {
    version: 3,
    project: {
      name: 'G3 夹具项目',
      description: null,
      baseCalendarId: 'project',
      startDate: '2026-10-05',
      finishDate: null,
    },
    calendars: [{ id: 'project', workDays: [1, 2, 3, 4, 5], exceptions: { nonWorking: ['2026-10-12'], working: ['2026-10-17'] } }],
    tasks: FIXTURE_TASKS.map((entry) => ({ ...entry })),
    links: FIXTURE_LINKS.map((entry) => ({ ...entry })),
    baselines: [],
  };
}

/**
 * **往返可比的**基准文档：去掉项目级字段与日历例外。
 *
 * 理由（ADR 0006 §2）：xlsx 只承载 9 个可见列，项目名/项目起点/日历例外**不在表里**
 * （`exceptions` 的工作表表达明确归 v0.5），所以"导出 → 再导入"的严格等价只能建在
 * "从规范化产物得到的文档"上。带例外的文档用于另一条用例，显式断言那些字段不往返。
 */
export function fixtureDocumentNoProjectFields(): ProjectDocument {
  const document = fixtureDocument();
  return {
    ...document,
    project: { ...document.project, name: '', startDate: null },
    calendars: [{ id: 'project', workDays: [1, 2, 3, 4, 5], exceptions: { nonWorking: [], working: [] } }],
  };
}

export type WriteRow = Record<string, ExcelJS.CellValue | Date | undefined>;

export interface WorkbookSpec {
  readonly sheetName?: string;
  readonly headerRow?: number;
  /** 表头文本（缺省用规范 9 列）。 */
  readonly headers?: readonly (string | null)[];
  /** 数据行：键为表头文本或规范键；值为已编码的单元格值。 */
  readonly rows: readonly WriteRow[];
  /** 额外写入的行（在表头之前），用于"表头上方有标题行"这类脏形态。 */
  readonly preamble?: readonly (readonly (string | null)[])[] | undefined;
  /** 合并单元格（A1 形式的区间）。 */
  readonly merges?: readonly string[];
  /** 首行冻结（导出物白名单之一）。 */
  readonly freezeHeader?: boolean;
  /** 列宽（导出物白名单之一）。 */
  readonly columnWidths?: readonly number[];
}

/** 用 ExcelJS 写出一个真实工作簿（可选：脏文件形态）。 */
export async function writeWorkbook(spec: WorkbookSpec): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = FIXED_TIMESTAMP;
  workbook.modified = FIXED_TIMESTAMP;
  workbook.creator = 'GanttPilot-Test';
  workbook.lastModifiedBy = 'GanttPilot-Test';

  const sheetName = spec.sheetName ?? '任务';
  const sheet = workbook.addWorksheet(
    sheetName,
    spec.freezeHeader === true ? { views: [{ state: 'frozen', ySplit: 1 }] } : {},
  );

  (spec.columnWidths ?? []).forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  let rowNumber = 1;
  for (const preamble of spec.preamble ?? []) {
    preamble.forEach((value, index) => {
      if (value !== null && value !== undefined) {
        sheet.getRow(rowNumber).getCell(index + 1).value = value;
      }
    });
    rowNumber += 1;
  }

  const headerRow = spec.headerRow ?? rowNumber;
  const headers = spec.headers ?? HEADERS;
  headers.forEach((header, index) => {
    if (header !== null) {
      const cell = sheet.getRow(headerRow).getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true };
    }
  });

  const headerIndexOf = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header !== null) {
      headerIndexOf.set(header, index + 1);
    }
  });

  spec.rows.forEach((row, offset) => {
    const target = sheet.getRow(headerRow + 1 + offset);
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined || value === null) {
        continue;
      }
      const column = headerIndexOf.get(key);
      if (column === undefined) {
        throw new Error(`夹具键不在表头里：${key}`);
      }
      target.getCell(column).value = value as ExcelJS.CellValue;
    }
  });

  for (const merge of spec.merges ?? []) {
    sheet.mergeCells(merge);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBuffer);
}

/** 直接操纵 zip 条目（负向对照用：按字节变造导出物）。 */
export async function readZip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

export interface PartFingerprint {
  /** 条目名 → 内容 sha256（**只看内容，不看 zip 元数据**）。 */
  readonly parts: ReadonlyMap<string, string>;
  /** 摘要（条目名 + 内容哈希的稳定拼接再哈希）。 */
  readonly digest: string;
}

/**
 * 部件指纹（ADR 0006 §10）。
 *
 * **不得**用整文件哈希：`exceljs` 会把写入时刻写进 zip 条目的 DOS 时间戳，
 * 跨秒重跑整文件哈希必然不同（S2 §六.2 实测）。
 */
export async function partFingerprint(bytes: Uint8Array): Promise<PartFingerprint> {
  const zip = await readZip(bytes);
  const parts = new Map<string, string>();
  const names = Object.keys(zip.files).sort();
  for (const name of names) {
    const entry = zip.files[name];
    if (entry === undefined || entry.dir) {
      continue;
    }
    const content = await entry.async('uint8array');
    parts.set(name, createHash('sha256').update(content).digest('hex'));
  }
  const material = [...parts.entries()].map(([name, hash]) => `${name}:${hash}`).join('\n');
  return { parts, digest: createHash('sha256').update(material).digest('hex') };
}

/** 整文件 sha256（**只用于负向对照**：证明它与部件指纹不同、不能当判据）。 */
export function fileHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('G3 夹具自身是规范形状', () => {
  it('基准文档的任务编号与层级自洽（父先于子、编号唯一）', () => {
    const outlineNumbers = new Set<string>();
    for (const entry of FIXTURE_TASKS) {
      expect(outlineNumbers.has(entry.outlineNumber)).toBe(false);
      outlineNumbers.add(entry.outlineNumber);
      if (entry.parentId !== null) {
        const parentIndex = FIXTURE_TASKS.findIndex((candidate) => candidate.id === entry.parentId);
        const childIndex = FIXTURE_TASKS.findIndex((candidate) => candidate.id === entry.id);
        expect(parentIndex).toBeGreaterThanOrEqual(0);
        expect(parentIndex).toBeLessThan(childIndex);
      }
    }
  });

  it('基准文档的依赖边引用存在的任务', () => {
    const ids = new Set(FIXTURE_TASKS.map((entry) => entry.id));
    for (const link of FIXTURE_LINKS) {
      expect(ids.has(link.from)).toBe(true);
      expect(ids.has(link.to)).toBe(true);
    }
  });

  it('写出的工作簿能被 zip 层读回（部件指纹可用）', async () => {
    const bytes = await writeWorkbook({ rows: [{ 任务名称: '甲' }] });
    const fingerprint = await partFingerprint(bytes);
    expect(fingerprint.parts.size).toBeGreaterThan(5);
    expect(fingerprint.parts.has('xl/workbook.xml')).toBe(true);
    expect(fingerprint.digest).toHaveLength(64);
  });
});
