/**
 * G3 出口条件 ③：**依赖列语法**、**成环边丢弃**、**CSV 尽力导入**（ADR 0006 §4/§7/§9）。
 *
 * 三条必须凭这张表守住的：
 * 1. 语法容差是**闭集**（半角/全角分号、空片段、类型可省、`±lag`、未知编号）；
 * 2. **成环丢弃是确定性的**：按「工作表行序 × 单元格内前置出现顺序」逐条 `wouldCreateCycle`，
 *    丢弃**不回插、不回溯**——换一下行序就必须换一条被丢的边；
 * 3. 丢弃**不得用 `compute` 兜底**（`compute` 遇环整个失败，诊断面只有一条 `cycle`）。
 */
import { describe, expect, it } from 'vitest';

import { wouldCreateCycle } from '@ganttpilot/engine';

import { importCsv, importXlsx } from './import.js';
import { parseCsvRecords } from './csv.js';
import { splitDependencyCell, parseDependencyToken } from './dependencies.js';
import { writeWorkbook } from './fixtures.spec.js';
import type { XlsxDiagnostic } from './diagnostics.js';

function codesOf(diagnostics: readonly XlsxDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe('G3 ③ 依赖列语法（声明式）', () => {
  it('片段切分：半角与全角分号、空片段容忍', () => {
    const pieces = splitDependencyCell('1.1;1.2；1.3;;1.4;');
    expect(pieces.map((piece) => piece.number)).toStrictEqual(['1.1', '1.2', '1.3', '1.4']);
  });

  it('`编号[类型][±lag]` 的四种类型与 lag 正负零', () => {
    const cases: readonly [string, { type: string; lag: number }][] = [
      ['1.1', { type: 'FS', lag: 0 }],
      ['1.1[FS]', { type: 'FS', lag: 0 }],
      ['1.1[SS]', { type: 'SS', lag: 0 }],
      ['1.1[FF+3]', { type: 'FF', lag: 3 }],
      ['1.1[SF-2]', { type: 'SF', lag: -2 }],
      ['1.1[+5]', { type: 'FS', lag: 5 }],
      ['1.1[-5]', { type: 'FS', lag: -5 }],
      ['1.1[ fs +1 ]', { type: 'FS', lag: 1 }],
    ];
    for (const [text, expected] of cases) {
      const [token] = splitDependencyCell(text);
      expect(token, text).toBeDefined();
      const parsed = parseDependencyToken(token!);
      expect(parsed.ok, text).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      expect({ type: parsed.type, lag: parsed.lagDays }, text).toStrictEqual(expected);
    }
  });

  it('非法片段：未知类型、非整数 lag、空编号', () => {
    expect(parseDependencyToken({ number: '1.1', typeText: 'XX', lagText: null }).ok).toBe(false);
    expect(parseDependencyToken({ number: '1.1', typeText: 'FS', lagText: '+1.5' }).ok).toBe(false);
    expect(parseDependencyToken({ number: '', typeText: null, lagText: null }).ok).toBe(false);
  });

  it('导入侧：未知编号 / 自环 / 重复边各自的码与保留策略', async () => {
    const bytes = await writeWorkbook({
      rows: [
        { WBS: '1', 任务名称: '甲', 前置任务: '9.9' }, // 未知编号 → 丢弃该条
        { WBS: '2', 任务名称: '乙', 前置任务: '1' },
        { WBS: '3', 任务名称: '丙', 前置任务: '1;1[FS];1[SS]' }, // 中间那条重复
      ],
    });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    const codes = codesOf(imported.diagnostics);
    expect(codes).toContain('XLSX_DEPENDENCY_UNPARSABLE');
    expect(codes).toContain('XLSX_DEPENDENCY_DUPLICATE');
    // `1` 与 `2` 不是双向依赖；这里没有环
    expect(codes).not.toContain('XLSX_CYCLE_EDGE_DROPPED');
    expect(imported.document.links.map((link) => `${link.from}->${link.to}[${link.type}]`)).toStrictEqual([
      't1->t2[FS]',
      't1->t3[FS]',
      't1->t3[SS]',
    ]);
  });

  it('自环：任务的前置写自己 → XLSX_DEPENDENCY_SELF_LOOP（丢弃且不产边）', async () => {
    const bytes = await writeWorkbook({ rows: [{ WBS: '1', 任务名称: '甲', 前置任务: '1' }] });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(codesOf(imported.diagnostics)).toStrictEqual(['XLSX_DEPENDENCY_SELF_LOOP']);
    expect(imported.document.links).toStrictEqual([]);
  });
});

describe('G3 ③ 成环边丢弃是确定性的（ADR 0006 §7 / 裁决 P-14 第 4 条）', () => {
  it('按"行序 × 单元格内顺序"丢弃：换行序就换一条被丢的边', async () => {
    // 顺序 A：`3→1` 在最后一行 ⇒ 它成环，被丢
    const orderA = await writeWorkbook({
      rows: [
        { WBS: '1', 任务名称: '甲', 前置任务: '3' },
        { WBS: '2', 任务名称: '乙', 前置任务: '1' },
        { WBS: '3', 任务名称: '丙', 前置任务: '2' },
      ],
    });
    const a = await importXlsx(orderA);
    expect(a.ok).toBe(true);
    if (!a.ok) {
      return;
    }
    const droppedA = a.diagnostics.filter((diagnostic) => diagnostic.code === 'XLSX_CYCLE_EDGE_DROPPED');
    expect(droppedA).toHaveLength(1);
    expect(droppedA[0]?.message).toContain('成环路径');
    // 被丢的是**后处理**的那条候选：第 2 行 `乙` 说的 `2 → 3`（第 3 行的 `3 → 1` 先被接受）
    expect(droppedA[0]?.message).toContain('2 → 3');
    expect(droppedA[0]?.message).toContain('成环路径 t2 → t3 → t1 → t2');
    expect(a.document.links.map((link) => `${link.from}->${link.to}`)).toStrictEqual(['t3->t1', 't1->t2']);

    // 顺序 B：把 `甲` 挪到最后一行 ⇒ 现在 `1→2` 是最后处理的候选（`3→1`、`2→3` 先成立）⇒ 丢的是它
    const orderB = await writeWorkbook({
      rows: [
        { WBS: '3', 任务名称: '丙', 前置任务: '2' },
        { WBS: '2', 任务名称: '乙', 前置任务: '1' },
        { WBS: '1', 任务名称: '甲', 前置任务: '3' },
      ],
    });
    const b = await importXlsx(orderB);
    expect(b.ok).toBe(true);
    if (!b.ok) {
      return;
    }
    const droppedB = b.diagnostics.filter((diagnostic) => diagnostic.code === 'XLSX_CYCLE_EDGE_DROPPED');
    expect(droppedB).toHaveLength(1);
    // 行序一换，被丢的就是另一条：现在是第 4 行 `甲` 说的 `3 → 1`
    expect(droppedB[0]?.message).toContain('3 → 1');
    expect(b.document.links.map((link) => `${link.from}->${link.to}`)).toStrictEqual(['t2->t1', 't3->t2']);
  });

  it('丢弃不回溯：只丢成环的那一条，先接受的边**保留**', async () => {
    const bytes = await writeWorkbook({
      rows: [
        { WBS: '1', 任务名称: '甲', 前置任务: '2' }, // 候选 t2->t1：先接受
        { WBS: '2', 任务名称: '乙', 前置任务: '1' }, // 候选 t1->t2：此时成环 ⇒ 丢弃
      ],
    });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    // **不回插**：被丢弃的是后处理的那条（`1→2`），先接受的 `2→1` 留着
    expect(imported.document.links.map((link) => `${link.from}->${link.to}`)).toStrictEqual(['t2->t1']);
    expect(
      imported.diagnostics.filter((diagnostic) => diagnostic.code === 'XLSX_CYCLE_EDGE_DROPPED'),
    ).toHaveLength(1);
  });

  it('`wouldCreateCycle` 自身：端点为汇总任务也照常判定（结构性）', () => {
    const links = [{ id: 'l1', from: 'a', to: 'b', type: 'FS' as const, lagDays: 0 }];
    const cyclic = wouldCreateCycle(links, { id: 'l2', from: 'b', to: 'a', type: 'FS', lagDays: 0 });
    expect(cyclic.cyclic).toBe(true);
    expect(cyclic.path[0]).toBe('b');
    expect(cyclic.path[cyclic.path.length - 1]).toBe('b');
  });
});

describe('G3 ③ 汇总端点：保留该边 + XLSX_DEPENDENCY_SUMMARY_ENDPOINT', () => {
  it('端点是有子节点的任务 → 保留边并告警（与文档侧 LINK_SUMMARY_ENDPOINT 同判据）', async () => {
    const bytes = await writeWorkbook({
      rows: [
        { WBS: '1', 任务名称: '汇总' },
        { WBS: '1.1', 任务名称: '子', 前置任务: '1' },
        { WBS: '2', 任务名称: '后面的任务', 前置任务: '1' },
      ],
    });
    const imported = await importXlsx(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    const summaryDiags = imported.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'XLSX_DEPENDENCY_SUMMARY_ENDPOINT',
    );
    expect(summaryDiags).toHaveLength(2);
    // 边**保留**（不是丢弃）——排程侧会忽略它并另报 `summaryIgnored`
    expect(imported.document.links).toHaveLength(2);
  });
});

describe('G3 ③ CSV 尽力导入（复用同一套列契约与诊断码）', () => {
  /** 测试侧的 UTF-8 编码（不依赖 `TextEncoder`：三包的 `lib` 不含 DOM）。 */
  function utf8(text: string): Uint8Array {
    const bytes: number[] = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return Uint8Array.from(bytes);
  }

  it('记录切分：引号、转义引号、逗号与换行都在引号内', () => {
    expect(parseCsvRecords('a,b\n"c,d",e\n"f""g",h')).toStrictEqual([
      ['a', 'b'],
      ['c,d', 'e'],
      ['f"g', 'h'],
    ]);
  });

  it('规范 CSV（含 BOM 与中文）可导入，且与 xlsx 走同一套列契约', async () => {
    const text =
      '\uFEFF' +
      'WBS,任务名称,开始,工期,前置任务,进度,里程碑,备注\n' +
      '1,阶段一,2026-10-05,4,,0.5,否,备注一\n' +
      '1.1,子任务,2026-10-06,2,1[FS+1],50%,是,\n';
    const imported = await importCsv(utf8(text));
    expect(imported.ok, JSON.stringify(imported.diagnostics)).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document.tasks.map((task) => task.outlineNumber)).toStrictEqual(['1', '1.1']);
    expect(imported.document.tasks[1]?.parentId).toBe(imported.document.tasks[0]?.id);
    expect(imported.document.tasks[1]?.progress).toBe(0.5);
    expect(imported.document.tasks[1]?.milestone).toBe(true);
    expect(imported.document.links).toHaveLength(1);
  });

  it('`importCsv` 与 `importXlsx` 同码表：CSV 里的坏值报的码与 xlsx 一致', async () => {
    const text = 'WBS,任务名称,工期,进度\n1,甲,3.5,abc\n';
    const imported = await importCsv(utf8(text));
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(codesOf(imported.diagnostics)).toEqual(
      expect.arrayContaining(['XLSX_DURATION_NOT_INTEGER', 'XLSX_PROGRESS_UNPARSABLE']),
    );
  });

  it('分号分隔的"CSV"→ 明确报错（不支持分隔符嗅探）', async () => {
    const imported = await importCsv(utf8('WBS;任务名称\n1;甲\n'));
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(codesOf(imported.diagnostics)).toStrictEqual(['XLSX_HEADER_ROW_INVALID']);
  });

  it('空 CSV → 明确报错（不崩溃）', async () => {
    const imported = await importCsv(utf8(''));
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(codesOf(imported.diagnostics)).toStrictEqual(['XLSX_HEADER_ROW_INVALID']);
  });

  it('`importXlsx` 按字节形态自动识别 CSV（zip 头 `PK` 走 xlsx 路径）', async () => {
    const imported = await importXlsx(utf8('WBS,任务名称,工期\n1,甲,3\n'));
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.document.tasks[0]?.durationDays).toBe(3);
  });
});
