import { describe, expect, it } from 'vitest';

import {
  CURRENT_DOCUMENT_VERSION,
  DocumentVersionError,
  hasDocumentErrors,
  migrateDocument,
  MIN_SUPPORTED_DOCUMENT_VERSION,
  parseDocument,
  serializeDocument,
  SUPPORTED_DOCUMENT_VERSIONS,
  validateDocument,
  type ProjectDocument,
} from './schema.js';
import { wbsDocument } from './fixtures.spec.js';

/**
 * G1.2 出口条件 2：**旧版本 → 当前版本可迁移；未知版本明确报错**。
 *
 * v1/v2 是"原文优先期"的历史形状（**从未发布**，见 ADR 0002），在此**冻结**：
 * 迁移链可被真实走过（而不是一个空跑的外壳），且"未知版本"的负向用例有判别力。
 */

/** v1 的历史形状：`links[].lag`、任务没有 `manual`/`constraints`、没有 `project.baseCalendarId`。 */
function v1Document(): Record<string, unknown> {
  return {
    version: 1,
    project: { name: 'v1 项目', startDate: '2025-01-06' },
    calendars: [{ id: 'proj-cal', workDays: [1, 2, 3, 4, 5] }],
    tasks: [
      { id: 'a', parentId: null, name: '阶段', startDate: '2025-01-06', duration: 5, progress: 0.5 },
      { id: 'b', parentId: 'a', name: '子任务', duration: 3 },
    ],
    links: [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lag: 2 }],
  };
}

/** v2 的历史形状：已有 `manual`/`constraints`/`baseCalendarId`，但无 WBS 与折叠状态。 */
function v2Document(): Record<string, unknown> {
  return {
    version: 2,
    project: { name: 'v2 项目', calendarId: 'proj-cal', baseCalendarId: 'proj-cal', startDate: null },
    calendars: [{ id: 'proj-cal' }],
    tasks: [
      { id: 'a', parentId: null, name: '阶段', manual: false, constraints: [] },
      { id: 'b', parentId: 'a', name: '子任务', manual: true, constraints: [{ kind: 'mustStartOn' }] },
    ],
    links: [{ id: 'l1', from: 'a', to: 'b', type: 'SS', lagDays: -1 }],
  };
}

function codesOf(error: unknown): readonly string[] {
  return (error as { diagnostics: readonly { code: string }[] }).diagnostics.map((entry) => entry.code);
}

describe('G1.2 迁移：版本区间与骨架形状', () => {
  it('当前版本 = 3，支持区间为 1..3（与原文 §6 的 version: 3 一致）', () => {
    expect(CURRENT_DOCUMENT_VERSION).toBe(3);
    expect(MIN_SUPPORTED_DOCUMENT_VERSION).toBe(1);
    expect(SUPPORTED_DOCUMENT_VERSIONS).toStrictEqual([1, 2, 3]);
  });

  it('当前版本文档原样返回（不重复迁移）', () => {
    const doc = wbsDocument();
    const text = serializeDocument(doc);
    expect(JSON.parse(JSON.stringify(migrateDocument(JSON.parse(text))))).toStrictEqual(JSON.parse(text));
  });

  it('非对象输入原样返回（由随后的校验报 DOC_ROOT_NOT_OBJECT）', () => {
    expect(migrateDocument(null)).toBeNull();
    expect(migrateDocument('文本')).toBe('文本');
  });
});

describe('G1.2 迁移：v1 → v2 → v3', () => {
  it('v1 的两跳迁移逐字段正确', () => {
    const migrated = migrateDocument(v1Document()) as Record<string, unknown>;
    expect(migrated['version']).toBe(3);

    const project = migrated['project'] as Record<string, unknown>;
    expect(project['name']).toBe('v1 项目');
    expect(project['baseCalendarId'], 'v1 没有 baseCalendarId：应回落到 calendars[0].id').toBe('proj-cal');

    const tasks = migrated['tasks'] as Record<string, unknown>[];
    expect(tasks[0]?.['manual']).toBe(false);
    expect(tasks[0]?.['constraints']).toStrictEqual([]);
    expect(tasks[0]?.['collapsed']).toBe(false);
    expect(tasks[0]?.['outlineNumber']).toBe('1');
    expect(tasks[1]?.['outlineNumber']).toBe('1.1');

    const links = migrated['links'] as Record<string, unknown>[];
    expect(links[0]?.['lagDays'], 'v1 的 lag 应改名为 lagDays').toBe(2);
    expect(links[0]?.['lag'], 'lag 旧键应被移除').toBeUndefined();

    expect(migrated['baselines']).toStrictEqual([]);
  });

  it('v1 迁移产物通过严格校验（零 error）', () => {
    const migrated = migrateDocument(v1Document());
    const diagnostics = validateDocument(migrated);
    expect(diagnostics.filter((entry) => entry.severity === 'error')).toStrictEqual([]);
  });

  it('v2 → v3：只补 WBS 与折叠状态，保留已有 manual/constraints/lagDays', () => {
    const migrated = migrateDocument(v2Document()) as Record<string, unknown>;
    expect(migrated['version']).toBe(3);

    const tasks = migrated['tasks'] as Record<string, unknown>[];
    expect(tasks[1]?.['manual']).toBe(true);
    expect(tasks[1]?.['constraints']).toStrictEqual([{ kind: 'mustStartOn' }]);
    expect(tasks[1]?.['collapsed']).toBe(false);
    expect(tasks[0]?.['outlineNumber']).toBe('1');
    expect(tasks[1]?.['outlineNumber']).toBe('1.1');

    const links = migrated['links'] as Record<string, unknown>[];
    expect(links[0]?.['lagDays']).toBe(-1);
  });

  it('v2 迁移产物通过严格校验（零 error）', () => {
    const diagnostics = validateDocument(migrateDocument(v2Document()));
    expect(hasDocumentErrors(diagnostics)).toBe(false);
  });

  it('v2 里已有的 outlineNumber 被保留，其与层级不符由**校验**报出（不在此静默改写）', () => {
    const input = v2Document() as { tasks: Record<string, unknown>[] };
    input.tasks[1] = { ...input.tasks[1], outlineNumber: '9.9' };
    const migrated = migrateDocument(input) as { tasks: Record<string, unknown>[] };
    expect(migrated.tasks[1]?.['outlineNumber'], '迁移不应当改写已有编号').toBe('9.9');
    expect(
      validateDocument(migrated)
        .filter((entry) => entry.severity === 'error')
        .map((entry) => entry.code),
    ).toContain('TREE_OUTLINE_STALE');
  });

  /**
   * **脏数据的编号口径是刻意的**（P3/C4-b 的收敛边界）。
   *
   * `migration.ts` 的编号遍历与 `wbs.computeOutlineNumbersByScan` 骨架相同，但**不做父子规范化**：
   * 父 id 不存在的任务在迁移里"不可达"，于是退回**位置编号**（`index + 1`），
   * 随后由 `validateDocument` 报 `TREE_*`。活文档那条路（wbs）则把未知父规范化成根。
   * 两条口径的差异**只对脏旧文档可见**；本用例把它钉住，免得后来者"顺手合并"两者。
   */
  it('脏数据（父 id 不存在）在迁移里退回位置编号，交给校验报错——不与 wbs 的活文档口径合并', () => {
    const input = v2Document() as { tasks: Record<string, unknown>[] };
    input.tasks[1] = { ...input.tasks[1], parentId: 'ghost' };
    const migrated = migrateDocument(input) as { tasks: Record<string, unknown>[] };
    // 位置编号：第二行 = '2'（不是按父 'ghost' 推出来的 '1.1'）
    expect(migrated.tasks[1]?.['outlineNumber']).toBe('2');
    expect(
      validateDocument(migrated)
        .filter((entry) => entry.severity === 'error')
        .map((entry) => entry.code),
    ).toContain('TREE_PARENT_MISSING');
  });

  it('parseDocument 能直接吃 v1 的 JSON 文本（G3 导入的最小可用面）', () => {
    const parsed: ProjectDocument = parseDocument(JSON.stringify(v1Document()));
    expect(parsed.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(parsed.tasks.map((entry) => entry.outlineNumber)).toStrictEqual(['1', '1.1']);
    expect(parsed.links[0]?.lagDays).toBe(2);
    expect(parsed.project.baseCalendarId).toBe('proj-cal');
  });
});

describe('G1.2 迁移：未知版本的负向用例（出口条件 2）', () => {
  it.each([
    ['更高的版本', 4],
    ['版本 0', 0],
    ['负数版本', -1],
    ['字符串版本', '3'],
    ['小数版本', 2.5],
    ['null 版本', null],
  ])('%s 被明确拒绝（DOC_VERSION_UNKNOWN）', (_label, version) => {
    try {
      migrateDocument({ version, project: {}, calendars: [], tasks: [], links: [] });
      expect.unreachable('应当抛 DocumentVersionError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentVersionError);
      expect(codesOf(error)).toContain('DOC_VERSION_UNKNOWN');
    }
  });

  it('缺 version 也被拒绝（DOC_VERSION_MISSING）', () => {
    try {
      migrateDocument({ project: {} });
      expect.unreachable('应当抛 DocumentVersionError');
    } catch (error) {
      expect(codesOf(error)).toContain('DOC_VERSION_MISSING');
    }
  });

  it('parseDocument 对未知版本同样拒绝，且带上结构化诊断', () => {
    try {
      parseDocument(JSON.stringify({ version: 99, project: {}, calendars: [], tasks: [], links: [] }));
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentVersionError);
      const diagnostics = (error as DocumentVersionError).diagnostics;
      expect(diagnostics[0]?.code).toBe('DOC_VERSION_UNKNOWN');
      expect(diagnostics[0]?.message).toContain('99');
    }
  });

  it('负向对照：把版本改成 3 之后同一份文档就能通过（判据不是恒真式）', () => {
    const v1 = v1Document();
    expect(() => migrateDocument({ ...v1, version: 4 })).toThrow(DocumentVersionError);
    expect(() => migrateDocument({ ...v1, version: 1 })).not.toThrow();
  });
});
