import { describe, expect, it } from 'vitest';

import { Calendar, isoToDayNumber } from './date.js';
import {
  hasDocumentErrors,
  validateDocument,
  type DocumentLink,
  type DocumentTask,
  type ProjectDocument,
} from './schema.js';
import { LEAF_SENTINEL, compute, createScheduleCalendar, wouldCreateCycle } from './schedule.js';
import { affectedClosure } from './schedule.js';
import {
  SCHEDULE_BASE_DAY,
  SCHEDULE_CALENDARS,
  generateProject,
  largeScheduleProject,
  makeCalendar,
  type GeneratedProject,
} from './scheduleFixtures.spec.js';
import { checkScheduleInvariants, tamperSchedule } from './scheduleInvariants.spec.js';

function task(overrides: Partial<DocumentTask> & Pick<DocumentTask, 'id'>): DocumentTask {
  return {
    parentId: null,
    outlineNumber: '',
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

function document(tasks: readonly DocumentTask[], links: readonly DocumentLink[] = []): ProjectDocument {
  return {
    version: 3,
    project: {
      name: '契约用例',
      description: null,
      baseCalendarId: 'project',
      startDate: null,
      finishDate: null,
    },
    calendars: [SCHEDULE_CALENDARS[0]!],
    tasks,
    links,
    baselines: [],
  };
}

function buildProject(overrides: Partial<Parameters<typeof generateProject>[0]> = {}): GeneratedProject {
  return generateProject({
    id: 'contract',
    seed: 424_242,
    taskCount: 24,
    linkCount: 30,
    ...overrides,
  });
}

describe('G2 契约：形状、哨兵与夹具自检', () => {
  it('夹具产出的是**可通过校验**的文档（否则差分喂进去的就不是合法输入）', () => {
    for (const seed of [11, 22, 33, 44]) {
      const project = buildProject({ seed, taskCount: 30, linkCount: 40 });
      const diagnostics = validateDocument(project.document);
      expect(hasDocumentErrors(diagnostics), `seed=${String(seed)}：${JSON.stringify(diagnostics)}`).toBe(false);
    }
  });

  it('Schedule 的数组长度、类型与哨兵纪律符合 SCHEDULE.md §三', () => {
    const project = buildProject();
    const result = compute(project.document, makeCalendar(project));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const schedule = result.schedule;
    const n = project.document.tasks.length;
    expect(schedule.taskCount).toBe(n);
    expect(schedule.es).toBeInstanceOf(Int32Array);
    expect(schedule.ef).toBeInstanceOf(Int32Array);
    expect(schedule.anchored).toBeInstanceOf(Uint8Array);
    expect(schedule.driven).toBeInstanceOf(Uint8Array);
    expect(schedule.summaryEs).toBeInstanceOf(Int32Array);
    expect(schedule.summaryEf).toBeInstanceOf(Int32Array);
    expect(schedule.summaryProgress).toBeInstanceOf(Float64Array);
    for (const array of [
      schedule.es,
      schedule.ef,
      schedule.summaryEs,
      schedule.summaryEf,
      schedule.summaryProgress,
      schedule.anchored,
      schedule.driven,
    ]) {
      expect(array.length).toBe(n);
    }
    expect(schedule.clampedStarts).toBeGreaterThanOrEqual(0);
    expect(schedule.projectFinish).toBeGreaterThanOrEqual(schedule.projectStart);

    // 汇总行 es === -1 且 summary* 有值；叶子行反之。
    let summaryRows = 0;
    for (let i = 0; i < n; i += 1) {
      if (schedule.es[i] === LEAF_SENTINEL) {
        summaryRows += 1;
        expect(schedule.ef[i]).toBe(LEAF_SENTINEL);
        expect(schedule.anchored[i]).toBe(0);
        expect(schedule.driven[i]).toBe(0);
      } else {
        expect(schedule.summaryEs[i]).toBe(LEAF_SENTINEL);
        expect(schedule.summaryEf[i]).toBe(LEAF_SENTINEL);
        expect(schedule.summaryProgress[i]).toBe(LEAF_SENTINEL);
      }
    }
    expect(summaryRows).toBeGreaterThan(0); // 夹具确实造出了汇总任务
  });

  it('数组按**文档序**索引（与依赖的拓扑序无关）', () => {
    const doc = document(
      [
        task({ id: 'b', name: '下游' }), // 文档序在前，却是被依赖方
        task({ id: 'a', name: '上游', startDate: '2026-10-05', durationDays: 3 }),
      ],
      [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }],
    );
    const calendar = new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 400 });
    const result = compute(doc, calendar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // a 的序号 0，b 从 a 的排他结束（3）起算；两者按文档序落在 es[0]（b）与 es[1]（a）。
    expect(result.schedule.es[1]).toBe(0);
    expect(result.schedule.ef[1]).toBe(3);
    expect(result.schedule.es[0]).toBe(3);
  });

  it('空文档与"只有一个无子节点任务"的文档都不抛错（退化情形）', () => {
    const empty = compute(document([]), new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 120 }));
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.schedule.taskCount).toBe(0);
      expect(empty.schedule.projectStart).toBe(0);
      expect(empty.schedule.projectFinish).toBe(0);
      expect(empty.schedule.milestoneCount).toBe(0);
      expect(empty.schedule.diagnostics).toStrictEqual([]);
    }

    // 一个没有子节点的任务**不是**汇总任务（汇总 = 有子任务），因此它照常参与排程：
    // 无日期无前置 ⇒ 情形②，回落项目起点 + `undated`。
    const single = document([task({ id: 't1', name: '孤立任务' })]);
    const result = compute(single, new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 120 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.es[0]).toBe(0);
      expect(result.schedule.ef[0]).toBe(0);
      expect(result.schedule.anchored[0]).toBe(1);
      expect(result.schedule.diagnostics.map((entry) => entry.code)).toStrictEqual(['undated']);
      expect(result.schedule.projectFinish).toBe(result.schedule.projectStart);
      expect(result.schedule.milestoneCount).toBe(0);
    }
  });
});

describe('G2 契约：纯函数与确定性', () => {
  it('绝不修改入参（文档 / 日历 / 锚点）', () => {
    const project = buildProject();
    const before = JSON.stringify(project.document);
    const anchors = [...project.anchors];
    const calendar = makeCalendar(project);
    const calendarBefore = [calendar.baseDay, calendar.spanDays, calendar.workdayCount, calendar.isoOfOrdinal(5)];

    compute(project.document, calendar, anchors);

    expect(JSON.stringify(project.document)).toBe(before);
    expect(anchors).toStrictEqual([...project.anchors]);
    expect([calendar.baseDay, calendar.spanDays, calendar.workdayCount, calendar.isoOfOrdinal(5)]).toStrictEqual(
      calendarBefore,
    );
  });

  it('同一输入 ⇒ 深比较相同的 Schedule（含诊断）', () => {
    const project = buildProject();
    const calendar = makeCalendar(project);
    const first = compute(project.document, calendar, project.anchors);
    const second = compute(project.document, makeCalendar(project), [...project.anchors]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.schedule).toStrictEqual(second.schedule);
  });

  it('容量不可见：同一文档在任意容量下得到逐项相同的 Schedule（ADR 0005 §7）', () => {
    const project = buildProject({ seed: 777, taskCount: 40, linkCount: 60 });
    const tiny = new Calendar(project.document.calendars[0]!, {
      baseDay: project.earliestDay ?? SCHEDULE_BASE_DAY,
      spanDays: 40,
    });
    const huge = new Calendar(project.document.calendars[0]!, {
      baseDay: project.earliestDay ?? SCHEDULE_BASE_DAY,
      spanDays: 20_000,
    });
    const small = compute(project.document, tiny, project.anchors);
    const big = compute(project.document, huge, project.anchors);
    expect(small.ok).toBe(true);
    expect(big.ok).toBe(true);
    if (!small.ok || !big.ok) {
      return;
    }
    expect(small.schedule).toStrictEqual(big.schedule);
    // 序号确实超出了小日历的工作日总数（否则这条断言没有判别力）。
    expect(small.schedule.projectFinish).toBeGreaterThan(tiny.workdayCount);
  });

  it('createScheduleCalendar 的容量一定够用：能翻译全部日期，且不触发内部扩容', () => {
    for (const seed of [1, 5, 9]) {
      const project = buildProject({ seed, taskCount: 60, linkCount: 90 });
      const document_ = project.document;
      const calendar = createScheduleCalendar(document_);
      const result = compute(document_, calendar, project.anchors);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.schedule.projectFinish).toBeLessThanOrEqual(calendar.workdayCount);
      for (let i = 0; i < result.schedule.taskCount; i += 1) {
        if (result.schedule.es[i] === LEAF_SENTINEL) {
          continue;
        }
        expect(() => calendar.isoOfOrdinal(result.schedule.es[i]!)).not.toThrow();
        expect(() => calendar.isoOfOrdinal(result.schedule.ef[i]!)).not.toThrow();
      }
    }
  });
});

/**
 * **`compute` 交出真正用到的日历**（ADR 0005 附录 §1／裁决 `P-48`）。
 *
 * 背景：渲染层原先用"按**已提交文档**规划的那份日历"翻译序号，而拖动预览喂给 `compute` 的是
 * **另一份文档**（应用层的未提交副本）⇒ 向右拖远时完成序号越过那份日历容量 ⇒ `buildView` 抛
 * `RangeError` ⇒ Vue 卸载整棵树、**整页空白**。修法不是"给规划加一个猜的余量"，而是让
 * `compute` 把**它内部已经构造出来的那份扩容日历**交出来（零额外计算、结构性而非余量）。
 */
describe('P-48：`renderCalendar`（compute 交出的可翻译日历）', () => {
  it('ok:true 时覆盖本次调用的全部文档日期与全部 es/ef（**入参日历明显偏小**也要成立）', () => {
    for (const seed of [3, 11, 27]) {
      const project = buildProject({ seed, taskCount: 50, linkCount: 80 });
      const document_ = project.document;
      // 故意给一份"远不够用"的入参日历（容量 40 天）：它按 ADR 0005 §7 不影响任何序号，
      // 只是无法翻译 —— 正是产品里那次白屏的形态。
      const tiny = new Calendar(document_.calendars[0]!, {
        baseDay: project.earliestDay ?? SCHEDULE_BASE_DAY,
        spanDays: 40,
      });
      const result = compute(document_, tiny, project.anchors);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      // ① 前提自证：这条判据**只有当入参真的不够用时**才有判别力。
      expect(result.schedule.projectFinish).toBeGreaterThan(tiny.workdayCount);
      // ② 交出的日历严格更大（不是把入参原样返回）。
      expect(result.renderCalendar.spanDays).toBeGreaterThan(tiny.spanDays);
      expect(result.renderCalendar.workdayCount).toBeGreaterThan(tiny.workdayCount);

      // ③ **逐任务**：每个 es/ef 都能在这份日历里翻译成日期（这正是渲染层要做的事）。
      const finishOrdinal = result.schedule.projectFinish - 1;
      expect(() => result.renderCalendar.dayOfOrdinal(finishOrdinal)).not.toThrow();
      for (let i = 0; i < result.schedule.taskCount; i += 1) {
        if (result.schedule.es[i] === LEAF_SENTINEL) {
          continue;
        }
        expect(() => result.renderCalendar.dayOfOrdinal(result.schedule.es[i]!)).not.toThrow();
        expect(() => result.renderCalendar.dayOfOrdinal(result.schedule.ef[i]!)).not.toThrow();
      }

      // ④ 覆盖**文档日期**：每个非空日期都能被翻译回序号（含 startDate 与 endDate）。
      const latestDocumentDay = document_.tasks.reduce((max, item) => {
        let value = max;
        for (const iso of [item.startDate, item.endDate]) {
          if (iso === null) continue;
          const day = isoToDayNumber(iso);
          if (day > value) value = day;
        }
        return value;
      }, isoToDayNumber(document_.project.startDate ?? document_.tasks[0]!.startDate ?? '2000-01-03'));
      const coveredDays = result.renderCalendar.workdayCount;
      expect(latestDocumentDay - result.renderCalendar.baseDay + 1).toBeLessThanOrEqual(coveredDays);
    }
  });

  it('`ok:false`（成环）时**不产出** `renderCalendar`（照 ADR 0005 §1：失败结果不产出半成品）', () => {
    const project = buildProject({ seed: 31, taskCount: 12, linkCount: 14, cyclic: true });
    const result = compute(project.document, makeCalendar(project));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect('renderCalendar' in result).toBe(false);
  });

  it('容量无关性不受影响：`renderCalendar` 只是派生量，`Schedule` 仍逐项相同', () => {
    const project = buildProject({ seed: 777, taskCount: 40, linkCount: 60 });
    const base = project.earliestDay ?? SCHEDULE_BASE_DAY;
    const tiny = new Calendar(project.document.calendars[0]!, { baseDay: base, spanDays: 40 });
    const huge = new Calendar(project.document.calendars[0]!, { baseDay: base, spanDays: 20_000 });
    const small = compute(project.document, tiny, project.anchors);
    const big = compute(project.document, huge, project.anchors);
    expect(small.ok).toBe(true);
    expect(big.ok).toBe(true);
    if (!small.ok || !big.ok) {
      return;
    }
    // ① `Schedule` 逐项相同（既有不变量，一字未改）。
    expect(small.schedule).toStrictEqual(big.schedule);
    // ② 派生量：同一文档 + 同一入参日历 ⇒ 逐值相同（两次调用可复核）。
    const again = compute(project.document, tiny, project.anchors);
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(again.renderCalendar.spanDays).toBe(small.renderCalendar.spanDays);
    expect(again.renderCalendar.baseDay).toBe(small.renderCalendar.baseDay);
    // ③ 大日历不必扩容（`expandToCoverDates` 的"够用就原样返回"分支）。
    expect(big.renderCalendar.spanDays).toBe(huge.spanDays);
  });
});

describe('G2 契约：成环的失败形状与建边预检', () => {
  it('成环 ⇒ ok:false、code=cycle、cyclePath 首尾同一 id、只带一条 error 诊断', () => {
    const project = buildProject({ seed: 31, taskCount: 12, linkCount: 14, cyclic: true });
    const result = compute(project.document, makeCalendar(project));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('cycle');
    expect(result.cyclePath.length).toBeGreaterThanOrEqual(2);
    expect(result.cyclePath[0]).toBe(result.cyclePath[result.cyclePath.length - 1]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('cycle');
    expect(result.diagnostics[0]?.severity).toBe('error');
    // 路径上的每个 id 都真实存在，且相邻两跳都有一条边。
    for (const id of result.cyclePath) {
      expect(project.document.tasks.some((entry) => entry.id === id)).toBe(true);
    }
    for (let i = 0; i + 1 < result.cyclePath.length; i += 1) {
      const from = result.cyclePath[i]!;
      const to = result.cyclePath[i + 1]!;
      expect(project.document.links.some((link) => link.from === from && link.to === to)).toBe(true);
    }
    expect('schedule' in result).toBe(false);
  });

  it('wouldCreateCycle：只有真的形成回路才判 cyclic，并给出闭环路径', () => {
    const chain: DocumentLink[] = [
      { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
      { id: 'l2', from: 'b', to: 'c', type: 'FS', lagDays: 0 },
    ];
    const close = wouldCreateCycle(chain, { id: 'c1', from: 'c', to: 'a', type: 'FS', lagDays: 0 });
    expect(close.cyclic).toBe(true);
    expect(close.path).toStrictEqual(['c', 'a', 'b', 'c']);

    const twoNode = wouldCreateCycle(
      [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }],
      { id: 'c1', from: 'b', to: 'a', type: 'FS', lagDays: 0 },
    );
    expect(twoNode).toStrictEqual({ cyclic: true, path: ['b', 'a', 'b'] });

    const selfLoop = wouldCreateCycle([], { id: 'c1', from: 'x', to: 'x', type: 'FS', lagDays: 0 });
    expect(selfLoop).toStrictEqual({ cyclic: true, path: ['x', 'x'] });

    const benign = wouldCreateCycle(chain, { id: 'c1', from: 'a', to: 'd', type: 'SS', lagDays: 2 });
    expect(benign).toStrictEqual({ cyclic: false, path: [] });

    const dangling = wouldCreateCycle([], { id: 'c1', from: 'y', to: 'z', type: 'FS', lagDays: 0 });
    expect(dangling).toStrictEqual({ cyclic: false, path: [] });
  });

  it('wouldCreateCycle 与 compute 的成环判定同口径（结构性，含汇总端点边）', () => {
    const doc = document(
      [
        task({ id: 'w1', name: '阶段', durationDays: null }),
        task({ id: 'leaf', parentId: 'w1', name: '叶子', durationDays: 2 }),
      ],
      [{ id: 'l1', from: 'leaf', to: 'w1', type: 'FS', lagDays: 0 }],
    );
    const candidate: DocumentLink = { id: 'c1', from: 'w1', to: 'leaf', type: 'FS', lagDays: 0 };
    expect(wouldCreateCycle(doc.links, candidate).cyclic).toBe(true);
    const cyclic = compute({ ...doc, links: [...doc.links, candidate] }, new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 200 }));
    expect(cyclic.ok).toBe(false);
  });
});

describe('G2 契约：affectedClosure（纯结构查询）', () => {
  it('只收后继闭包、含种子、按文档序输出，且与种子顺序无关', () => {
    const doc = document(
      [
        task({ id: 'a' }),
        task({ id: 'b' }),
        task({ id: 'c' }),
        task({ id: 'd' }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'b', to: 'c', type: 'FS', lagDays: 0 },
      ],
    );
    expect(affectedClosure(doc, ['a'])).toStrictEqual(['a', 'b', 'c']);
    expect(affectedClosure(doc, ['c'])).toStrictEqual(['c']);
    expect(affectedClosure(doc, ['b', 'd'])).toStrictEqual(['b', 'c', 'd']);
    expect(affectedClosure(doc, ['c', 'a'])).toStrictEqual(affectedClosure(doc, ['a', 'c']));
    expect(affectedClosure(doc, ['不存在的 id'])).toStrictEqual([]);
    expect(affectedClosure(doc, ['a', 'a'])).toStrictEqual(['a', 'b', 'c']);
  });

  it('沿全部出边遍历（含"传播上被忽略"的汇总端点边），且不含祖先', () => {
    const doc = document(
      [
        task({ id: 'w1', name: '阶段' }),
        task({ id: 'leaf', parentId: 'w1', durationDays: 2 }),
        task({ id: 'other', parentId: 'w1', durationDays: 1 }),
      ],
      [{ id: 'l1', from: 'leaf', to: 'w1', type: 'FS', lagDays: 0 }],
    );
    // leaf → w1 是"汇总端点边"（传播忽略），但闭包照样收进来（宽进）；输出按文档序（w1 在前）。
    expect(affectedClosure(doc, ['leaf'])).toStrictEqual(['w1', 'leaf']);
    // 反向不是后继关系：从 w1 出发只到它自己。
    expect(affectedClosure(doc, ['w1'])).toStrictEqual(['w1']);
  });
});

describe('G2 契约：有意抛出（超出契约而不是用户数据可恢复）', () => {
  it('`parentId` 指向文档序更靠后的任务 ⇒ 抛 RangeError（汇总聚合依赖"父先于子"）', () => {
    const broken = document([
      task({ id: 'child', parentId: 'late-parent', name: '先出现的子任务', durationDays: 1 }),
      task({ id: 'late-parent', name: '后出现的父任务' }),
    ]);
    expect(() => compute(broken, new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 400 }))).toThrow(
      /父节点 .* 出现在文档序之后/,
    );
    // 反过来（父在前）是合法形状，且汇总行仍是 -1。
    const ok = document([
      task({ id: 'parent', name: '父任务' }),
      task({ id: 'child', parentId: 'parent', name: '子任务', durationDays: 1 }),
    ]);
    const result = compute(ok, new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 400 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.es[0]).toBe(LEAF_SENTINEL);
      expect(result.schedule.es[1]).toBe(0);
    }
  });

  it('远日期不抛错：入口按需扩容到覆盖全部文档日期（超可表示域那条是防御性分支）', () => {
    const far = document([task({ id: 'far', startDate: '2500-01-01', durationDays: 1 })]);
    const calendar = new Calendar({}, { baseDay: isoToDayNumber('1970-01-01'), spanDays: 1_460 });
    expect(() => compute(far, calendar)).not.toThrow();
    const result = compute(far, calendar);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 初始地平线只有 1,460 天，序号却落在它之外 ⇒ 内部确实扩容了（且调用方日历未被改动）。
      expect(result.schedule.es[0]).toBeGreaterThan(calendar.workdayCount);
      expect(calendar.spanDays).toBe(1_460);
    }
  });
});

describe('G2 契约：不变量检查器本身有判别力（负向对照）', () => {
  it('手工篡改排程结果后必须被检出（否则"不变量全过"是恒真式）', () => {
    const project = buildProject({ seed: 5150, taskCount: 30, linkCount: 40 });
    const calendar = makeCalendar(project);
    const result = compute(project.document, calendar, project.anchors);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(checkScheduleInvariants(project.document, calendar, result, project.anchors)).toStrictEqual([]);

    // 结果类型的成功支**必须**带 `renderCalendar`（互证要用同一个渲染日历）⇒ 这里从真实结果
    // 展开、只替换 `schedule`：改的仍然只有那一个字段，类型却是诚实的（P3/C7-b）。
    const tampered = { ...result, schedule: tamperSchedule(result.schedule) };
    const violations = checkScheduleInvariants(project.document, calendar, tampered, project.anchors);
    expect(violations.length).toBeGreaterThan(0);
    const rules = new Set(violations.map((violation) => violation.rule));
    expect(rules.has('ef') || rules.has('projectFinish')).toBe(true);
    expect(rules.has('clampedStarts')).toBe(true);
    expect(rules.has('summaryEf') || rules.has('summaryProgress')).toBe(true);
  });

  it('性能规模的数据集也满足全部不变量', () => {
    const project = largeScheduleProject(200, 300, 1234);
    const calendar = makeCalendar(project);
    const result = compute(project.document, calendar, project.anchors);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(checkScheduleInvariants(project.document, calendar, result, project.anchors)).toStrictEqual([]);
    expect(isoToDayNumber('2026-10-05')).toBe(SCHEDULE_BASE_DAY);
  });
});
