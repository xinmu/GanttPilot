import { describe, expect, it } from 'vitest';

import {
  canonicalizeDocument,
  CURRENT_DOCUMENT_VERSION,
  type CalendarSpec,
  type DocumentTask,
  type ProjectDocument,
  serializeDocument,
} from './schema.js';

/**
 * 测试夹具：供 G1.2 的四个 spec 共享的"真实形状文档"。
 *
 * 为什么把它写成 `*.spec.ts`：它必须**可被其他 spec import**，而 `*.spec.ts` 已被
 * `tsconfig.json` 的 `exclude` 排除在发布产物之外（不必为夹具再改构建配置）。
 * 本文件自身有一条"夹具自检"用例，同时承担"形状说明"的职责。
 *
 * **关键契约（取消往返测试的循环论证）**：本文件的文档工厂产出的对象**本身就是规范形状**
 * ——全部字段显式写出（含 `null` 与空数组）、键序与 `canonicalizeDocument` 一致。
 * 因此"往返"可以直接断言 `parseDocument(serializeDocument(doc))` **深比较等于 `doc` 本身**，
 * 而不是与"再规范化一次的结果"比较（那会退化成恒真式）。
 * 另有 `夹具是规范形状` 用例守住这条前提（`canonicalizeDocument(doc)` 必须深等于 `doc`）。
 */

/**
 * 规范日历：**省略 `workDays`** 表示"用默认工作日"（周一至周五）。
 *
 * 注意不能写成 `workDays: []`——G1.1 会把空数组判为"没有任何工作日"并拒绝，
 * 那样往返回来的文档会变成非法文档。`exceptions` 则显式写出两个空集合。
 */
export function canonicalCalendar(id = 'project'): CalendarSpec {
  return { id, exceptions: { nonWorking: [], working: [] } };
}

/** 任务工厂：只写"想测的字段"，其余走规范默认值。 */
export function task(overrides: Partial<DocumentTask> & Pick<DocumentTask, 'id'>): DocumentTask {
  return {
    parentId: null,
    outlineNumber: '1',
    name: overrides.id,
    startDate: null,
    endDate: null,
    durationDays: null,
    progress: null,
    milestone: false,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
    ...overrides,
  };
}

/** 文档工厂：给出骨架，字段顺序与 `canonicalizeDocument` 一致。 */
export function document(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    version: CURRENT_DOCUMENT_VERSION,
    project: {
      name: '夹具项目',
      description: null,
      baseCalendarId: 'project',
      startDate: null,
      finishDate: null,
    },
    calendars: [canonicalCalendar()],
    tasks: [],
    links: [],
    baselines: [],
    ...overrides,
  };
}

/** 最小文档：空任务集（"新建后立刻保存"的形状）。 */
export function minimalDocument(): ProjectDocument {
  return document();
}

/** 扁平文档：全部顶层任务、含 `null` 日期与 `null` 工期（DM-05 的极端形状）。 */
export function flatDocument(): ProjectDocument {
  return document({
    tasks: [
      task({
        id: 't1',
        outlineNumber: '1',
        name: '需求冻结',
        startDate: '2025-01-06',
        endDate: '2025-01-10',
        durationDays: 4,
        progress: 0.5,
        notes: '含评审',
      }),
      task({ id: 't2', outlineNumber: '2', name: '待定事项（无日期）' }),
      task({
        id: 't3',
        outlineNumber: '3',
        name: '里程碑：开工',
        milestone: true,
        startDate: '2025-01-13',
        endDate: '2025-01-13',
        durationDays: 0,
        progress: 0,
      }),
    ],
    links: [
      { id: 'l1', from: 't1', to: 't3', type: 'FS', lagDays: 0 },
      { id: 'l2', from: 't1', to: 't2', type: 'SS', lagDays: -2 },
    ],
  });
}

/** 三级 WBS 文档：`w1` 汇总 → `w1a` 汇总 → `w1a1` 叶子；另有两个兄弟。 */
export function wbsDocument(): ProjectDocument {
  return document({
    project: {
      name: '三级 WBS 夹具',
      description: '覆盖编号 1 / 1.1 / 1.1.1 与兄弟顺序',
      baseCalendarId: 'project',
      startDate: '2025-01-01',
      finishDate: null,
    },
    tasks: [
      task({ id: 'w1', outlineNumber: '1', name: '阶段一', collapsed: true }),
      task({ id: 'w1a', parentId: 'w1', outlineNumber: '1.1', name: '子阶段' }),
      task({
        id: 'w1a1',
        parentId: 'w1a',
        outlineNumber: '1.1.1',
        name: '叶子任务',
        startDate: '2025-02-03',
        endDate: '2025-02-07',
        durationDays: 4,
      }),
      task({ id: 'w1b', parentId: 'w1', outlineNumber: '1.2', name: '另一子任务' }),
      task({ id: 'w2', outlineNumber: '2', name: '阶段二' }),
      task({ id: 'w2a', parentId: 'w2', outlineNumber: '2.1', name: '阶段二的子任务' }),
    ],
    links: [
      { id: 'l1', from: 'w1a1', to: 'w1b', type: 'FS', lagDays: 1 },
      { id: 'l2', from: 'w2a', to: 'w1a1', type: 'SF', lagDays: 0 },
    ],
  });
}

/** 未启用字段文档：`constraints`/`manual`/`baselines` 都带上值（schema 留位必须能往返）。 */
export function placeholderFieldsDocument(): ProjectDocument {
  return document({
    project: {
      name: '留位字段夹具',
      description: null,
      baseCalendarId: 'project-6d',
      startDate: null,
      finishDate: '2025-12-31',
    },
    calendars: [
      {
        id: 'project-6d',
        workDays: [0, 1, 2, 3, 4, 5],
        exceptions: {
          nonWorking: ['2026-10-12', '2026-10-13'],
          working: ['2026-10-17'],
        },
      },
    ],
    tasks: [
      task({
        id: 'm1',
        outlineNumber: '1',
        name: '带约束与手动标记的任务',
        durationDays: 3,
        startDate: '2025-03-03',
        endDate: '2025-03-05',
        manual: true,
        constraints: [{ kind: 'startNoEarlierThan', date: '2025-03-03' }],
      }),
      task({
        id: 'm2',
        outlineNumber: '2',
        name: '进度未知',
        progress: null,
      }),
    ],
    baselines: [
      {
        id: 'b1',
        name: '初始基线',
        createdAt: '2025-01-01T00:00:00.000Z',
        snapshot: { tasks: [], note: '内容 v0.5 定义' },
      },
    ],
  });
}

/** 全部夹具形状（供表驱动测试遍历）。 */
export function allDocumentShapes(): readonly { readonly name: string; readonly doc: ProjectDocument }[] {
  return [
    { name: '最小空文档', doc: minimalDocument() },
    { name: '扁平文档（含 null 日期）', doc: flatDocument() },
    { name: '三级 WBS', doc: wbsDocument() },
    { name: '留位字段与六天工作日历', doc: placeholderFieldsDocument() },
  ];
}

/** 造一个 `n` 个任务的三级嵌套文档（性能与规模行为测试用）。 */
export function largeDocument(n: number): ProjectDocument {
  const tasks: DocumentTask[] = [];
  let phase = 0;
  let sub = 0;
  let leaf = 0;
  while (tasks.length < n) {
    phase += 1;
    const phaseId = `p${String(phase)}`;
    tasks.push(task({ id: phaseId, outlineNumber: String(phase), name: `阶段 ${String(phase)}` }));
    for (let s = 0; s < 4 && tasks.length < n; s += 1) {
      sub += 1;
      const subId = `${phaseId}-s${String(s + 1)}`;
      tasks.push(
        task({
          id: subId,
          parentId: phaseId,
          outlineNumber: `${String(phase)}.${String(s + 1)}`,
          name: `子阶段 ${String(sub)}`,
        }),
      );
      for (let l = 0; l < 4 && tasks.length < n; l += 1) {
        leaf += 1;
        tasks.push(
          task({
            id: `${subId}-l${String(l + 1)}`,
            parentId: subId,
            outlineNumber: `${String(phase)}.${String(s + 1)}.${String(l + 1)}`,
            name: `叶子 ${String(leaf)}`,
            durationDays: 3,
          }),
        );
      }
    }
  }
  return document({ tasks: tasks.slice(0, n) });
}

describe('G1.2 测试夹具自检', () => {  it('夹具本身是**规范形状**：`canonicalizeDocument(doc)` 必须深等于 `doc`', () => {
    // 这条前提让各 spec 可以断言 `parse(serialize(doc)) 深等于 doc`——
    // 若夹具漏写字段（例如日历省略 `workDays`），规范化会补齐它，
    // 往返断言就会失败。**这是有意的**：它把"夹具必须显式"变成可执行的约束。
    for (const { name, doc } of allDocumentShapes()) {
      expect(canonicalizeDocument(doc), `${name} 不是规范形状（漏写了字段？）`).toStrictEqual(doc);
    }
  });

  it('每个夹具都能序列化，且以换行结尾、可被 JSON.parse', () => {
    for (const { name, doc } of allDocumentShapes()) {
      const text = serializeDocument(doc);
      expect(text.endsWith('\n'), `${name} 应以换行结尾`).toBe(true);
      expect(JSON.parse(text), `${name} 应可被 JSON.parse`).toBeTruthy();
    }
  });

  it('largeDocument 生成的任务数与层级都符合预期', () => {
    const doc = largeDocument(200);
    expect(doc.tasks).toHaveLength(200);
    expect(doc.tasks.some((entry) => entry.outlineNumber.split('.').length === 3)).toBe(true);
    expect(canonicalizeDocument(doc)).toStrictEqual(doc);
  });
});
