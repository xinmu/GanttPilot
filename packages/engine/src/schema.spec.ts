import { describe, expect, it } from 'vitest';

import {
  canonicalizeDocument,
  createEmptyDocument,
  CURRENT_DOCUMENT_VERSION,
  hasDocumentErrors,
  parseDocument,
  reindexDocument,
  serializeDocument,
  validateDocument,
  type DocumentDiagnosticCode,
  type ProjectDocument,
} from './schema.js';
import {
  allDocumentShapes,
  document,
  flatDocument,
  minimalDocument,
  placeholderFieldsDocument,
  task,
  wbsDocument,
} from './fixtures.spec.js';

/** 把诊断压成 `码:严重级` 的集合，便于断言"某条问题被检出"。 */
function codesOf(diagnostics: readonly { code: string; severity: string }[]): readonly string[] {
  return diagnostics.map((entry) => `${entry.code}:${entry.severity}`);
}

function errorCodes(input: unknown): readonly string[] {
  return validateDocument(input)
    .filter((entry) => entry.severity === 'error')
    .map((entry) => entry.code);
}

/** 解析一份"规范文本"（保证 `baselines` 等字段齐全，不产生 `DOC_FIELD_OMITTED`）。 */
function roundTrip(doc: ProjectDocument): ProjectDocument {
  return parseDocument(serializeDocument(doc));
}

describe('G1.2 序列化：规范 JSON', () => {
  it('全部夹具形状都能「序列化 → 解析 → 深比较」往返一致', () => {
    // 夹具本身是规范形状（由 fixtures.spec.ts 的 `夹具是规范形状` 用例保证），
    // 因此这里断言的是**与 `doc` 自身**深比较相等，而不是与"再规范化一次的结果"比较。
    for (const { name, doc } of allDocumentShapes()) {
      expect(roundTrip(doc), `${name} 往返后应与自身深比较相等`).toStrictEqual(doc);
      expect(roundTrip(doc).version).toBe(CURRENT_DOCUMENT_VERSION);
    }
  });

  it('往返是幂等的：连续两次序列化得到**逐字节相同**的文本', () => {
    for (const { name, doc } of allDocumentShapes()) {
      const once = serializeDocument(doc);
      const twice = serializeDocument(roundTrip(doc));
      expect(twice, `${name} 的第二次序列化应逐字节相同`).toBe(once);
    }
  });

  it('键序固定：规范形状的序列化结果逐字节可预期', () => {
    const text = serializeDocument(minimalDocument());
    expect(text).toContain('"version": 3');
    // 顶层键序：version → project → calendars → tasks → links → baselines
    const order = ['"version"', '"project"', '"calendars"', '"tasks"', '"links"', '"baselines"'].map(
      (key) => text.indexOf(key),
    );
    const sorted = [...order].sort((left, right) => left - right);
    expect(order).toStrictEqual(sorted);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('`null` 与空数组被**显式写出**（不用省略）', () => {
    const text = serializeDocument(minimalDocument());
    expect(text).toContain('"description": null');
    expect(text).toContain('"startDate": null');
    expect(text).toContain('"tasks": []');
    expect(text).toContain('"nonWorking": []');

    const flat = serializeDocument(flatDocument());
    expect(flat).toContain('"startDate": null'); // t2 无日期
    expect(flat).toContain('"durationDays": null');
    expect(flat).toContain('"progress": null');
  });

  it('日期为 null 的节点与未启用字段都能往返（DM-05 / DM-08 / DM-09 / P1-03）', () => {
    const parsed = roundTrip(placeholderFieldsDocument());
    const first = parsed.tasks[0];
    expect(first?.manual).toBe(true);
    expect(first?.constraints).toStrictEqual([{ kind: 'startNoEarlierThan', date: '2025-03-03' }]);
    expect(parsed.tasks[1]?.progress).toBeNull();
    expect(parsed.tasks[1]?.startDate).toBeNull();
    expect(parsed.baselines).toHaveLength(1);
    expect(parsed.baselines[0]?.snapshot).toStrictEqual({ tasks: [], note: '内容 v0.5 定义' });
    expect(parsed.calendars[0]?.exceptions?.working).toStrictEqual(['2026-10-17']);
  });

  it('canonicalizeDocument 是幂等的，且不修改输入', () => {
    const doc = placeholderFieldsDocument();
    const snapshot = serializeDocument(doc);
    const once = canonicalizeDocument(doc);
    const twice = canonicalizeDocument(roundTrip(doc));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(serializeDocument(doc), '序列化不得修改入参').toBe(snapshot);
  });

  it('createEmptyDocument 可直接往返，且已含项目日历', () => {
    const doc = createEmptyDocument('试点');
    expect(doc.project.name).toBe('试点');
    expect(doc.calendars).toStrictEqual([{ id: 'project' }]);
    // `createEmptyDocument` 的日历省略了 `workDays`/`exceptions`（消费侧最省的写法），
    // 因此它的**规范化像**才是可往返的目标：这里断言规范化后往返稳定。
    const canonical = canonicalizeDocument(doc);
    expect(canonicalizeDocument(roundTrip(doc))).toStrictEqual(canonical);
  });
});

describe('G1.2 解析：语法与顶层形状', () => {
  it('JSON 语法错误 → DOC_JSON_SYNTAX（不泄漏原始异常）', () => {
    try {
      parseDocument('{ not json');
      expect.unreachable('应当抛错');
    } catch (error) {
      const diagnostics = (error as { diagnostics: readonly { code: string }[] }).diagnostics;
      expect(diagnostics.map((entry) => entry.code)).toContain('DOC_JSON_SYNTAX');
    }
  });

  it('非对象根 → DOC_ROOT_NOT_OBJECT', () => {
    expect(errorCodes(null)).toStrictEqual(['DOC_ROOT_NOT_OBJECT']);
    expect(errorCodes([])).toStrictEqual(['DOC_ROOT_NOT_OBJECT']);
    expect(errorCodes('文本')).toStrictEqual(['DOC_ROOT_NOT_OBJECT']);
  });

  it('缺 version → DOC_VERSION_MISSING（且不做后续校验，避免级联噪声）', () => {
    expect(errorCodes({ project: {}, tasks: [] })).toStrictEqual(['DOC_VERSION_MISSING']);
  });

  it('顶层字段缺键产生 info 级 DOC_FIELD_OMITTED，但不阻断解析', () => {
    const diagnostics = validateDocument({
      version: 3,
      project: { name: 'x', baseCalendarId: 'project' },
      calendars: [{ id: 'project' }],
      tasks: [],
      links: [],
    });
    const omitted = diagnostics.filter((entry) => entry.code === 'DOC_FIELD_OMITTED');
    expect(omitted.map((entry) => entry.path)).toContain('baselines');
    expect(omitted.every((entry) => entry.severity === 'info')).toBe(true);
    expect(hasDocumentErrors(diagnostics)).toBe(false);
  });

  it('诊断带 path / taskId / linkId，便于 G3 报告逐条定位', () => {
    const doc = flatDocument();
    const diagnostics = validateDocument({
      ...JSON.parse(serializeDocument(doc)),
      links: [{ id: 'lx', from: 'nope', to: 't1', type: 'FS', lagDays: 0 }],
    });
    const dangling = diagnostics.find((entry) => entry.code === 'LINK_DANGLING_FROM');
    expect(dangling?.path).toBe('links[0].from');
    expect(dangling?.linkId).toBe('lx');
  });
});

describe('G1.2 校验：project / calendars', () => {
  it('project 非对象 → PROJECT_MISSING', () => {
    expect(errorCodes({ version: 3, project: 3, calendars: [{ id: 'project' }], tasks: [], links: [] })).toContain(
      'PROJECT_MISSING',
    );
  });

  it('project.name 非字符串 → PROJECT_NAME_INVALID', () => {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    doc.project.name = 42;
    expect(errorCodes(doc)).toContain('PROJECT_NAME_INVALID');
  });

  it('baseCalendarId 指向不存在的日历 → PROJECT_BASE_CALENDAR_MISSING', () => {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    doc.project.baseCalendarId = 'missing';
    expect(errorCodes(doc)).toContain('PROJECT_BASE_CALENDAR_MISSING');
  });

  it('calendar 非法（workDays 越界）→ CALENDAR_INVALID（借 G1.1 的构造器判定）', () => {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    doc.calendars = [{ id: 'project', workDays: [9] }];
    expect(errorCodes(doc)).toContain('CALENDAR_INVALID');
  });

  it('calendar 例外日不是 ISO 日期 → CALENDAR_INVALID', () => {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    doc.calendars = [{ id: 'project', exceptions: { nonWorking: ['2026/10/12'] } }];
    expect(errorCodes(doc)).toContain('CALENDAR_INVALID');
  });

  it('合法日历与引擎构造器一致：六天工作周 + 双集合例外可解析', () => {
    const parsed = roundTrip(placeholderFieldsDocument());
    expect(errorCodes(JSON.parse(serializeDocument(parsed)))).toStrictEqual([]);
  });
});

describe('G1.2 校验：任务字段', () => {
  function withTasks(tasks: readonly unknown[]): unknown {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    return { ...doc, tasks };
  }

  it('缺 id / id 为空 → TASK_ID_INVALID；重复 id → TASK_DUPLICATE_ID', () => {
    expect(
      errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1', name: 'A' }), id: '' }])),
    ).toContain('TASK_ID_INVALID');
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1' }), task({ id: 'a', outlineNumber: '2' })]))).toContain(
      'TASK_DUPLICATE_ID',
    );
  });

  it('日期非法（含不存在的日期）→ TASK_DATE_INVALID', () => {
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', startDate: '2025/01/06' })]))).toContain(
      'TASK_DATE_INVALID',
    );
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', endDate: '2025-02-30' })]))).toContain(
      'TASK_DATE_INVALID',
    );
  });

  it('endDate 早于 startDate → TASK_END_BEFORE_START', () => {
    expect(
      errorCodes(
        withTasks([
          task({ id: 'a', outlineNumber: '1', startDate: '2025-01-10', endDate: '2025-01-06' }),
        ]),
      ),
    ).toContain('TASK_END_BEFORE_START');
  });

  it('工期为负 / 非整数 / 超界 → TASK_DURATION_INVALID；工期 0 合法', () => {
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', durationDays: -1 })]))).toContain(
      'TASK_DURATION_INVALID',
    );
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', durationDays: 1.5 })]))).toContain(
      'TASK_DURATION_INVALID',
    );
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', durationDays: 2_000_000 })]))).toContain(
      'TASK_DURATION_INVALID',
    );
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', durationDays: 0 })]))).toStrictEqual([]);
  });

  it('有工期但无任何日期 → TASK_DURATION_WITHOUT_DATES（warning，不阻断）', () => {
    const diagnostics = validateDocument(withTasks([task({ id: 'a', outlineNumber: '1', durationDays: 3 })]));
    expect(codesOf(diagnostics)).toContain('TASK_DURATION_WITHOUT_DATES:warning');
    expect(hasDocumentErrors(diagnostics)).toBe(false);
  });

  it('progress 超出 [0,1] → TASK_PROGRESS_INVALID；0 与 1 合法', () => {
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', progress: 1.2 })]))).toContain(
      'TASK_PROGRESS_INVALID',
    );
    expect(errorCodes(withTasks([task({ id: 'a', outlineNumber: '1', progress: -0.1 })]))).toContain(
      'TASK_PROGRESS_INVALID',
    );
    expect(
      errorCodes(
        withTasks([task({ id: 'a', outlineNumber: '1', progress: 0 }), task({ id: 'b', outlineNumber: '2', progress: 1 })]),
      ),
    ).toStrictEqual([]);
  });

  it('里程碑带非零工期 → TASK_MILESTONE_WITH_DURATION（warning）', () => {
    const diagnostics = validateDocument(
      withTasks([task({ id: 'a', outlineNumber: '1', milestone: true, durationDays: 2 })]),
    );
    expect(codesOf(diagnostics)).toContain('TASK_MILESTONE_WITH_DURATION:warning');
  });

  it('milestone / collapsed / manual 非布尔 → 各自报码', () => {
    expect(errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1' }), milestone: 'yes' }]))).toContain(
      'TASK_MILESTONE_INVALID',
    );
    expect(errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1' }), collapsed: 1 }]))).toContain(
      'TASK_COLLAPSED_INVALID',
    );
    expect(errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1' }), manual: 'auto' }]))).toContain(
      'TASK_MANUAL_INVALID',
    );
  });

  it('constraints 非数组或含非对象条目 → TASK_CONSTRAINTS_INVALID', () => {
    expect(errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1' }), constraints: 'x' }]))).toContain(
      'TASK_CONSTRAINTS_INVALID',
    );
    expect(errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1' }), constraints: [1] }]))).toContain(
      'TASK_CONSTRAINTS_INVALID',
    );
  });

  it('notes 非字符串 → TASK_NOTES_INVALID', () => {
    expect(errorCodes(withTasks([{ ...task({ id: 'a', outlineNumber: '1' }), notes: 7 }]))).toContain(
      'TASK_NOTES_INVALID',
    );
  });

  it('tasks 不是数组 → TASK_MISSING', () => {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    expect(errorCodes({ ...doc, tasks: {} })).toContain('TASK_MISSING');
  });
});

describe('G1.2 校验：依赖边', () => {
  function withLinks(links: readonly unknown[]): unknown {
    const doc = JSON.parse(serializeDocument(flatDocument()));
    return { ...doc, links };
  }

  it('4 类关系都合法，非法关系 → LINK_TYPE_INVALID', () => {
    for (const type of ['FS', 'SS', 'FF', 'SF']) {
      expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 't3', type, lagDays: 0 }]))).toStrictEqual([]);
    }
    expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 't3', type: 'XX', lagDays: 0 }]))).toContain(
      'LINK_TYPE_INVALID',
    );
  });

  it('lag 为负合法（lead），非整数 → LINK_LAG_INVALID', () => {
    expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 't3', type: 'FS', lagDays: -3 }]))).toStrictEqual([]);
    expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 't3', type: 'FS', lagDays: 1.5 }]))).toContain(
      'LINK_LAG_INVALID',
    );
    expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 't3', type: 'FS', lagDays: 10 ** 9 }]))).toContain(
      'LINK_LAG_INVALID',
    );
  });

  it('悬空端点 / 自环 / 重复 id 各报其码', () => {
    expect(errorCodes(withLinks([{ id: 'l', from: 'nope', to: 't1', type: 'FS', lagDays: 0 }]))).toContain(
      'LINK_DANGLING_FROM',
    );
    expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 'nope', type: 'FS', lagDays: 0 }]))).toContain(
      'LINK_DANGLING_TO',
    );
    expect(errorCodes(withLinks([{ id: 'l', from: 't1', to: 't1', type: 'FS', lagDays: 0 }]))).toContain(
      'LINK_SELF_REFERENCE',
    );
    expect(
      errorCodes(
        withLinks([
          { id: 'l', from: 't1', to: 't3', type: 'FS', lagDays: 0 },
          { id: 'l', from: 't1', to: 't2', type: 'FS', lagDays: 0 },
        ]),
      ),
    ).toContain('LINK_DUPLICATE_ID');
  });

  it('端点落在汇总任务上 → LINK_SUMMARY_ENDPOINT（warning，不阻断）', () => {
    const base = JSON.parse(serializeDocument(wbsDocument()));
    const diagnostics = validateDocument({
      ...base,
      links: [{ id: 'lr', from: 'w1', to: 'w2a', type: 'FS', lagDays: 0 }],
    });
    expect(codesOf(diagnostics)).toContain('LINK_SUMMARY_ENDPOINT:warning');
    expect(hasDocumentErrors(diagnostics)).toBe(false);
  });

  it('links 不是数组 → LINK_MISSING', () => {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    expect(errorCodes({ ...doc, links: null })).toContain('LINK_MISSING');
  });
});

describe('G1.2 校验：基线留位（P1-03）', () => {
  function withBaselines(baselines: unknown): unknown {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    return { ...doc, baselines };
  }

  it('合法基线可解析，快照不解释内容', () => {
    expect(
      errorCodes(
        withBaselines([{ id: 'b1', name: '初始', createdAt: '2025-01-01T00:00:00.000Z', snapshot: { any: [1, 2] } }]),
      ),
    ).toStrictEqual([]);
  });

  it('id 非空字符串 / 重复 / createdAt 不可解析各报其码', () => {
    expect(errorCodes(withBaselines([{ id: '', name: 'x', createdAt: '2025-01-01', snapshot: null }]))).toContain(
      'BASELINE_ID_INVALID',
    );
    expect(
      errorCodes(
        withBaselines([
          { id: 'b', name: 'x', createdAt: '2025-01-01', snapshot: null },
          { id: 'b', name: 'y', createdAt: '2025-01-01', snapshot: null },
        ]),
      ),
    ).toContain('BASELINE_DUPLICATE_ID');
    expect(errorCodes(withBaselines([{ id: 'b', name: 'x', createdAt: '不是时间', snapshot: null }]))).toContain(
      'BASELINE_CREATED_AT_INVALID',
    );
  });

  it('baselines 非数组 → BASELINE_MISSING', () => {
    expect(errorCodes(withBaselines({}))).toContain('BASELINE_MISSING');
  });
});

describe('G1.2 校验：层级不变量（出口条件 3）', () => {
  function withHierarchy(tasks: readonly unknown[], links: readonly unknown[] = []): unknown {
    const doc = JSON.parse(serializeDocument(minimalDocument()));
    return { ...doc, tasks, links };
  }

  it('parentId 指向不存在任务 → TREE_PARENT_MISSING', () => {
    expect(
      errorCodes(withHierarchy([task({ id: 'a', parentId: 'ghost', outlineNumber: '1' })])),
    ).toContain('TREE_PARENT_MISSING');
  });

  it('自环 → TREE_CYCLE', () => {
    expect(errorCodes(withHierarchy([task({ id: 'a', parentId: 'a', outlineNumber: '1' })]))).toContain('TREE_CYCLE');
  });

  it('两节点成环 → TREE_CYCLE', () => {
    expect(
      errorCodes(
        withHierarchy([
          task({ id: 'a', parentId: 'b', outlineNumber: '1' }),
          task({ id: 'b', parentId: 'a', outlineNumber: '1.1' }),
        ]),
      ),
    ).toContain('TREE_CYCLE');
  });

  it('三节点成环也检出，且不产生编号级联噪声', () => {
    const diagnostics = validateDocument(
      withHierarchy([
        task({ id: 'a', parentId: 'c', outlineNumber: '1' }),
        task({ id: 'b', parentId: 'a', outlineNumber: '1.1' }),
        task({ id: 'c', parentId: 'b', outlineNumber: '1.1.1' }),
      ]),
    );
    expect(diagnostics.map((entry) => entry.code)).toContain('TREE_CYCLE');
    expect(diagnostics.map((entry) => entry.code)).not.toContain('TREE_OUTLINE_STALE');
  });

  it('编号与层级不符 → TREE_OUTLINE_STALE，且 reindexDocument 修复后零 error', () => {
    const broken: ProjectDocument = document({
      tasks: [
        task({ id: 'a', outlineNumber: '9', name: 'A' }),
        task({ id: 'b', parentId: 'a', outlineNumber: '9.9', name: 'B' }),
      ],
    });
    expect(errorCodes(JSON.parse(serializeDocument(broken)))).toContain('TREE_OUTLINE_STALE');

    const repaired = reindexDocument(broken);
    expect(repaired.tasks.map((entry) => entry.outlineNumber)).toStrictEqual(['1', '1.1']);
    expect(errorCodes(JSON.parse(serializeDocument(repaired)))).toStrictEqual([]);
  });

  it('编号重复 → TREE_OUTLINE_NOT_UNIQUE', () => {
    expect(
      errorCodes(
        withHierarchy([task({ id: 'a', outlineNumber: '1' }), task({ id: 'b', outlineNumber: '1' })]),
      ),
    ).toContain('TREE_OUTLINE_NOT_UNIQUE');
  });

  it('编号形式非法（前导零 / 空段 / 非正数）→ TREE_OUTLINE_STALE', () => {
    for (const bad of ['01', '1.', '.1', '1..2', '0', 'a']) {
      expect(
        errorCodes(withHierarchy([task({ id: 'a', outlineNumber: bad }), task({ id: 'b', outlineNumber: '2' })])),
        `编号 ${bad} 应被拒绝`,
      ).toContain('TREE_OUTLINE_STALE');
    }
  });

  it('缺 outlineNumber → TREE_OUTLINE_STALE（并提示用 reindexDocument 修复）', () => {
    const diagnostics = validateDocument(
      withHierarchy([{ ...task({ id: 'a' }), outlineNumber: undefined }]),
    );
    const stale = diagnostics.find((entry) => entry.code === 'TREE_OUTLINE_STALE');
    expect(stale?.message).toContain('reindexDocument');
  });

  it('层级超过上限 → TREE_DEPTH_EXCEEDED（且只报深度，不误报编号形式非法）', () => {
    const depth = 25;
    const tasks = Array.from({ length: depth }, (_, index) =>
      task({
        id: `d${String(index)}`,
        parentId: index === 0 ? null : `d${String(index - 1)}`,
        outlineNumber: Array.from({ length: index + 1 }, () => '1').join('.'),
        name: `深 ${String(index)}`,
      }),
    );
    const codes = errorCodes(withHierarchy(tasks));
    expect(codes).toContain('TREE_DEPTH_EXCEEDED');
    expect(codes, '深度超限不应被误报为"编号与层级不符"或"形式非法"').not.toContain(
      'TREE_OUTLINE_STALE',
    );
  });

  it('负向对照：故意打坏期望值必须被检出（判据不是恒真式）', () => {
    const good = wbsDocument();
    expect(errorCodes(JSON.parse(serializeDocument(good)))).toStrictEqual([]);
    const broken = JSON.parse(serializeDocument(good));
    broken.tasks[2].outlineNumber = '1.1.2';
    expect(errorCodes(broken)).toContain('TREE_OUTLINE_STALE');
  });
});

describe('G1.2 校验的判别力（负向对照）', () => {
  it('把合法诊断集当作空集断言会失败：合法文档产出空 error 集', () => {
    for (const { name, doc } of allDocumentShapes()) {
      expect(errorCodes(JSON.parse(serializeDocument(doc))), name).toStrictEqual([]);
    }
  });

  it('每个诊断码都出现在码集的类型里（防止码值被写错却仍能编译）', () => {
    const seen = new Set<DocumentDiagnosticCode>();
    const broken = {
      ...JSON.parse(serializeDocument(minimalDocument())),
      project: { name: 1, baseCalendarId: 'nope' },
      calendars: [{ id: 'project', workDays: [9] }],
      tasks: [
        { id: '', parentId: 'ghost', outlineNumber: '0', name: 1, startDate: 'x', endDate: 'y', durationDays: -1, progress: 3, milestone: 'x', collapsed: 5, notes: 1, manual: 'x', constraints: 'x' },
      ],
      links: [{ id: '', from: 'nope', to: 'nope', type: 'ZZ', lagDays: 1.5 }],
      baselines: [{ id: '', name: 1, createdAt: 'x', snapshot: undefined }],
    };
    for (const diagnostic of validateDocument(broken)) {
      seen.add(diagnostic.code);
    }
    // 至少覆盖形状类、各域类与层级类
    expect(seen.size).toBeGreaterThan(10);
    expect([...seen].some((code) => code.startsWith('TASK_'))).toBe(true);
    expect([...seen].some((code) => code.startsWith('LINK_'))).toBe(true);
    expect([...seen].some((code) => code.startsWith('TREE_') || code.startsWith('PROJECT_'))).toBe(true);
  });
});
