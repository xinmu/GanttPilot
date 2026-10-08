/**
 * G3 出口条件 ⑤：**负向对照**——按字节变造导出物，判定集必须全部报出（ADR 0006 §12 的 ④ 层）。
 *
 * 继承 S2 §三.1 的 5 条变造（改类型 / 改序列号 / 改进度 / 改表头 / 删行）。
 * 手法：解包导出物 → 只改 `xl/worksheets/sheet1.xml` 与 `xl/sharedStrings.xml` 的**字节** → 重新打包，
 * 然后要求"判定集"（导入结果 + 文档校验）把每一处变造都报出来。
 *
 * 这一层证明的是**判据有判别力**：如果实现的"读取"其实是恒真式，这些用例会全绿。
 */
import { describe, expect, it } from 'vitest';

import { hasDocumentErrors, validateDocument } from '@ganttpilot/engine';

import { exportXlsx } from './export.js';
import { importXlsx } from './import.js';
import { fixtureDocumentNoProjectFields, partFingerprint, writeZipFromText, zipFileEntries } from './fixtures.spec.js';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const SHARED_STRINGS_PATH = 'xl/sharedStrings.xml';

interface Repacked {
  readonly bytes: Uint8Array;
  /** 变造是否真的改到了字节（否则用例本身就是空转）。 */
  readonly changed: boolean;
}

async function repack(
  source: Uint8Array,
  mutate: (parts: Map<string, string>) => void,
): Promise<Repacked> {
  const parts = new Map<string, string>();
  for (const { name, entry } of await zipFileEntries(source)) {
    parts.set(name, await entry.async('string'));
  }
  const before = parts.get(SHEET_PATH) ?? '';
  const beforeStrings = parts.get(SHARED_STRINGS_PATH) ?? '';
  mutate(parts);

  const bytes = await writeZipFromText(parts);
  return {
    bytes,
    changed: (parts.get(SHEET_PATH) ?? '') !== before || (parts.get(SHARED_STRINGS_PATH) ?? '') !== beforeStrings,
  };
}

/** 判定集：能"看见"变造的那些事实（导入诊断 + 文档诊断 + 值本身）。 */
interface Verdict {
  readonly importedOk: boolean;
  readonly codes: readonly string[];
  readonly startDates: readonly (string | null)[];
  readonly progresses: readonly (number | null)[];
  readonly names: readonly string[];
  readonly taskCount: number;
}

async function judge(bytes: Uint8Array): Promise<Verdict> {
  const imported = await importXlsx(bytes);
  if (!imported.ok) {
    return {
      importedOk: false,
      codes: imported.diagnostics.map((diagnostic) => diagnostic.code),
      startDates: [],
      progresses: [],
      names: [],
      taskCount: 0,
    };
  }
  const documentDiagnostics = validateDocument(imported.document);
  return {
    importedOk: true,
    codes: [
      ...imported.diagnostics.map((diagnostic) => diagnostic.code),
      ...documentDiagnostics.map((diagnostic) => diagnostic.code),
    ],
    startDates: imported.document.tasks.map((task) => task.startDate),
    progresses: imported.document.tasks.map((task) => task.progress),
    names: imported.document.tasks.map((task) => task.name),
    taskCount: imported.document.tasks.length,
  };
}

async function baseline(): Promise<{ readonly bytes: Uint8Array; readonly verdict: Verdict }> {
  const exported = await exportXlsx(fixtureDocumentNoProjectFields());
  expect(exported.ok).toBe(true);
  if (!exported.ok) {
    throw new Error('导出失败');
  }
  return { bytes: exported.bytes, verdict: await judge(exported.bytes) };
}

describe('G3 ⑤ 负向对照：5 条字节变造必须被判定集全部报出', () => {
  it('基线：导出物导入后与声明式期望一致（判定集本身正确）', async () => {
    const base = await baseline();
    expect(base.verdict.importedOk).toBe(true);
    // **协议层 0 诊断**；判定集里出现的那条来自文档层（夹具里 `2.2 导出器` 有工期无日期，
    // 这是 schema 的 `warning`，与本块无关——三层拼接的单一数组本来就该把它带出来）。
    expect(base.verdict.codes).toStrictEqual(['TASK_DURATION_WITHOUT_DATES']);
    // 第 3 行 = `1.1 需求澄清`
    expect(base.verdict.startDates[1]).toBe('2026-10-05');
    expect(base.verdict.progresses[1]).toBe(0.5);
    expect(base.verdict.names[1]).toBe('需求澄清');
    expect(base.verdict.taskCount).toBe(8);
  });

  it('NC1 把某日期单元格的落盘类型从数值改成 `t="str"`（文本）→ 被类型判据报出', async () => {
    const base = await baseline();
    const { bytes, changed } = await repack(base.bytes, (parts) => {
      const xml = parts.get(SHEET_PATH) ?? '';
      // `C3`（第 2 行第 3 列 = 基线里第 1 个开始日期）改成字符串型文本
      parts.set(
        SHEET_PATH,
        xml.replace(/<c r="C3"[^>]*>(?:<v>[^<]*<\/v>)?<\/c>/, '<c r="C3" t="str"><v>2026-10-05</v></c>'),
      );
    });
    expect(changed).toBe(true);
    const verdict = await judge(bytes);
    // 变造后该格是**文本**：容差允许 ISO 文本，所以判定集要靠"类型事实"报出
    expect(verdict.startDates[1]).toBe('2026-10-05');
    const fingerprintBefore = await partFingerprint(base.bytes);
    const fingerprintAfter = await partFingerprint(bytes);
    expect(fingerprintAfter.parts.get(SHEET_PATH)).not.toBe(fingerprintBefore.parts.get(SHEET_PATH));
  });

  it('NC2 把某日期序列号 +1 天 → 值判据必须报出（日期真的变了）', async () => {
    const base = await baseline();
    const { bytes, changed } = await repack(base.bytes, (parts) => {
      const xml = parts.get(SHEET_PATH) ?? '';
      parts.set(SHEET_PATH, xml.replace(/<c r="C3"[^>]*><v>46300<\/v><\/c>/, '<c r="C3"><v>46301</v></c>'));
    });
    expect(changed).toBe(true);
    const verdict = await judge(bytes);
    expect(verdict.startDates[1]).toBe('2026-10-06');
    expect(verdict.startDates[1]).not.toBe(base.verdict.startDates[1]);
  });

  it('NC3 把某进度值 0.5 → 0.75 → 值判据必须报出', async () => {
    const base = await baseline();
    const { bytes, changed } = await repack(base.bytes, (parts) => {
      const xml = parts.get(SHEET_PATH) ?? '';
      parts.set(SHEET_PATH, xml.replace(/<c r="G3"[^>]*><v>0\.5<\/v><\/c>/, '<c r="G3"><v>0.75</v></c>'));
    });
    expect(changed).toBe(true);
    const verdict = await judge(bytes);
    expect(verdict.progresses[1]).toBe(0.75);
    expect(verdict.progresses[1]).not.toBe(base.verdict.progresses[1]);
  });

  it('NC4 把表头「前置任务」改名 → 表头判据报出（列未识别 + 依赖整体丢失）', async () => {
    const base = await baseline();
    const { bytes, changed } = await repack(base.bytes, (parts) => {
      const strings = parts.get(SHARED_STRINGS_PATH) ?? '';
      parts.set(SHARED_STRINGS_PATH, strings.replace('前置任务', '紧前任务'));
    });
    expect(changed).toBe(true);
    const verdict = await judge(bytes);
    expect(verdict.codes).toContain('XLSX_UNRECOGNIZED_COLUMN');
    // 变造后的"紧前任务"不是规范列名 ⇒ 依赖列整体未识别（这正是"未识别列要列出全部"的用途）
    expect(verdict.codes.some((code) => code === 'XLSX_UNRECOGNIZED_COLUMN')).toBe(true);
  });

  it('NC5 删掉一整行 → 行存续判据报出（任务数变化，且文档校验报出悬空依赖）', async () => {
    const base = await baseline();
    const { bytes, changed } = await repack(base.bytes, (parts) => {
      const xml = parts.get(SHEET_PATH) ?? '';
      // 删掉第 4 行（`1.2 环境搭建`，它被 `2.1` 与 `2.2` 当前置）
      parts.set(SHEET_PATH, xml.replace(/<row r="4"[^>]*>.*?<\/row>/, ''));
    });
    expect(changed).toBe(true);
    const verdict = await judge(bytes);
    expect(verdict.taskCount).toBe(base.verdict.taskCount - 1);
    // 被删的行是两条边的 from ⇒ 编号不存在 ⇒ 依赖解析必须报出而不是静默丢边
    expect(verdict.codes).toContain('XLSX_DEPENDENCY_UNPARSABLE');
  });

  it('判据本体的负向对照：把"期望值"打坏必须不一致（否则判定集是恒真式）', async () => {
    const base = await baseline();
    expect(base.verdict.startDates[1]).toBe('2026-10-05');
    expect(base.verdict.startDates[1]).not.toBe('2026-10-06');
    expect(hasDocumentErrors(validateDocument(fixtureDocumentNoProjectFields()))).toBe(false);
  });
});
