import { describe, expect, it } from 'vitest';

import * as engine from './index.js';

describe('@ganttpilot/engine 公共入口', () => {
  it('导出 G1.1 的日历与日期算术 API 与包标识', () => {
    expect(engine.ENGINE_VERSION).toBe('0.0.0');
    expect(engine.PLANNED_GATE).toBe('G6');
    expect(engine.COMPLETED_GATES).toStrictEqual(['G1.1', 'G1.2', 'G1.3', 'G2', 'G6']);

    // G0 的兼容面必须保持可用。
    expect(typeof engine.countWorkdays).toBe('function');
    expect(typeof engine.isWorkday).toBe('function');
    expect(typeof engine.parseIsoDate).toBe('function');
    expect(engine.DEFAULT_WORK_DAYS).toStrictEqual([1, 2, 3, 4, 5]);

    // G1.1 新增的序号化日历面。
    expect(typeof engine.Calendar).toBe('function');
    expect(typeof engine.isoToDayNumber).toBe('function');
    expect(typeof engine.dayNumberToIso).toBe('function');
    expect(typeof engine.weekdayOf).toBe('function');
    expect(typeof engine.addDays).toBe('function');
    expect(typeof engine.diffDays).toBe('function');
    expect(typeof engine.horizonDaysFor).toBe('function');
    expect(engine.DEFAULT_PROJECT_BASE_DAY_ISO).toBe('2025-01-01');
    expect(engine.DEFAULT_HORIZON_DAYS).toBeGreaterThan(0);
    expect(engine.HORIZON_GUARD_DAYS).toBeGreaterThan(engine.DEFAULT_HORIZON_DAYS);
  });

  it('导出 G1.2 的文档模型、迁移与 WBS 层级 API', () => {
    // 文档模型与序列化
    expect(engine.CURRENT_DOCUMENT_VERSION).toBe(3);
    expect(engine.MIN_SUPPORTED_DOCUMENT_VERSION).toBe(1);
    expect(engine.SUPPORTED_DOCUMENT_VERSIONS).toStrictEqual([1, 2, 3]);
    expect(typeof engine.serializeDocument).toBe('function');
    expect(typeof engine.parseDocument).toBe('function');
    expect(typeof engine.canonicalizeDocument).toBe('function');
    expect(typeof engine.createEmptyDocument).toBe('function');
    expect(typeof engine.reindexDocument).toBe('function');

    // 校验与迁移
    expect(typeof engine.validateDocument).toBe('function');
    expect(typeof engine.hasDocumentErrors).toBe('function');
    expect(typeof engine.migrateDocument).toBe('function');
    expect(typeof engine.DocumentError).toBe('function');
    expect(typeof engine.DocumentVersionError).toBe('function');

    // 依赖关系枚举与范围常量
    expect(engine.LINK_TYPES).toStrictEqual(['FS', 'SS', 'FF', 'SF']);
    expect(engine.MAX_LAG_DAYS).toBeGreaterThan(0);
    expect(engine.MAX_DURATION_DAYS).toBeGreaterThan(0);

    // WBS 层级
    expect(typeof engine.buildTaskTree).toBe('function');
    expect(typeof engine.flattenTaskTree).toBe('function');
    expect(typeof engine.computeOutlineNumbers).toBe('function');
    expect(typeof engine.computeOutlineNumbersByScan).toBe('function');
    expect(typeof engine.indentTask).toBe('function');
    expect(typeof engine.outdentTask).toBe('function');
    expect(typeof engine.moveTask).toBe('function');
    expect(typeof engine.reindexTasks).toBe('function');
    expect(typeof engine.isValidOutlineNumber).toBe('function');
    expect(engine.OUTLINE_SEPARATOR).toBe('.');
    expect(engine.MAX_OUTLINE_DEPTH).toBeGreaterThan(0);
  });

  it('导出 G1.3 的命令层、before 镜像与会话 API', () => {
    // 命令层（唯一变更通道）
    expect(typeof engine.applyCommand).toBe('function');
    expect(typeof engine.checkCommandShape).toBe('function');
    expect(typeof engine.replayCommands).toBe('function');
    expect(typeof engine.serializeCommand).toBe('function');
    expect(typeof engine.parseCommand).toBe('function');
    expect(typeof engine.suggestTaskId).toBe('function');
    expect(typeof engine.suggestLinkId).toBe('function');
    expect(engine.COMMAND_KINDS).toHaveLength(11);

    // before 镜像（日志）
    expect(typeof engine.diffDocument).toBe('function');
    expect(typeof engine.applyDocumentJournal).toBe('function');
    expect(typeof engine.invertDocumentJournal).toBe('function');
    expect(typeof engine.createBulkJournal).toBe('function');
    expect(typeof engine.isJournalEmpty).toBe('function');
    expect(typeof engine.journalScope).toBe('function');
    expect(typeof engine.cloneJsonValue).toBe('function');
    expect(typeof engine.deepFreezeJson).toBe('function');
    expect(typeof engine.findNonJsonValue).toBe('function');
    expect(typeof engine.jsonDeepEqual).toBe('function');

    // 会话与事务
    expect(typeof engine.createSession).toBe('function');
    expect(typeof engine.applyToSession).toBe('function');
    expect(typeof engine.createTransaction).toBe('function');
    expect(typeof engine.addToTransaction).toBe('function');
    expect(typeof engine.commitTransaction).toBe('function');
    expect(typeof engine.undoSession).toBe('function');
    expect(typeof engine.redoSession).toBe('function');
  });

  it('导出 G2 的排程内核 API 与哨兵常量', () => {
    expect(typeof engine.compute).toBe('function');
    expect(typeof engine.wouldCreateCycle).toBe('function');
    expect(typeof engine.affectedClosure).toBe('function');
    expect(typeof engine.createScheduleCalendar).toBe('function');
    expect(engine.LEAF_SENTINEL).toBe(-1);
  });

  it('导出 G6 的持久化 API 与常量（记录形状 / 恢复 / 策略 / 存储）', () => {
    expect(engine.PERSIST_RECORD_VERSION).toBe(1);
    expect(engine.PERSIST_FAILURE_CODES).toContain('PERSIST_QUOTA_EXCEEDED');
    expect(engine.AUTOSAVE_MAX_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    expect(typeof engine.sessionRecordOf).toBe('function');
    expect(typeof engine.restoreSessionOf).toBe('function');
    expect(typeof engine.restoreFromSnapshot).toBe('function');
    expect(typeof engine.planRestoreOf).toBe('function');
    expect(typeof engine.decodeCandidates).toBe('function');
    expect(typeof engine.planCheckpoint).toBe('function');
    expect(typeof engine.createRetentionPolicy).toBe('function');
    expect(typeof engine.createPolicyState).toBe('function');
    expect(typeof engine.policyReduce).toBe('function');
    expect(typeof engine.effectiveKeep).toBe('function');
    expect(typeof engine.checkJournalShape).toBe('function');
    expect(typeof engine.sameRecord).toBe('function');
    expect(typeof engine.createMemorySnapshotStore).toBe('function');
    // 会话构造的导出入口（恢复路径不手搓 `DocumentSession` 字面量）。
    expect(typeof engine.restoreSession).toBe('function');
  });

  it('通过公共入口走完「文档 + 日历 → 排程」（含汇总行哨兵与 iso 翻译）', () => {
    const base = engine.createEmptyDocument('排程冒烟');
    const doc: engine.ProjectDocument = {
      ...base,
      project: { ...base.project, startDate: '2025-01-06' },
      tasks: [
        {
          id: 'w1',
          parentId: null,
          outlineNumber: '1',
          name: '阶段',
          startDate: null,
          endDate: null,
          durationDays: null,
          progress: null,
          milestone: false,
          collapsed: false,
          notes: null,
          manual: false,
          constraints: [],
        },
        {
          id: 't1',
          parentId: 'w1',
          outlineNumber: '1.1',
          name: '需求',
          startDate: '2025-01-06',
          endDate: '2025-01-10',
          durationDays: 4,
          progress: 0.5,
          milestone: false,
          collapsed: false,
          notes: null,
          manual: false,
          constraints: [],
        },
        {
          id: 't2',
          parentId: 'w1',
          outlineNumber: '1.2',
          name: '开发',
          startDate: null,
          endDate: null,
          durationDays: 3,
          progress: null,
          milestone: false,
          collapsed: false,
          notes: null,
          manual: false,
          constraints: [],
        },
      ],
      links: [{ id: 'l1', from: 't1', to: 't2', type: 'FS', lagDays: 0 }],
    };

    const calendar = engine.createScheduleCalendar(doc);
    const result = engine.compute(doc, calendar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const schedule = result.schedule;
    expect(schedule.taskCount).toBe(3);
    expect(schedule.es[0]).toBe(engine.LEAF_SENTINEL); // 汇总行
    expect(schedule.es[1]).toBe(0);
    expect(schedule.ef[1]).toBe(4);
    expect(schedule.es[2]).toBe(4); // FS 从 t1 的排他结束起算
    expect(schedule.summaryEs[0]).toBe(0);
    expect(schedule.summaryEf[0]).toBe(7);
    expect(schedule.summaryProgress[0]).toBeCloseTo(2 / 7, 10); // (4×0.5 + 3×0) / (4+3)
    expect(schedule.summaryProgress[1]).toBe(engine.LEAF_SENTINEL);
    expect(calendar.isoOfOrdinal(schedule.es[1]!)).toBe('2025-01-06');
    expect(calendar.isoOfOrdinal(schedule.ef[2]!)).toBe('2025-01-15'); // 序号 7 = 第 8 个工作日
  });

  it('通过公共入口走完「应用命令 → 撤销 → 重做」（含 WBS 调级与跨字段变更）', () => {
    const base = engine.reindexDocument(
      engine.parseDocument(
        engine.serializeDocument({
          ...engine.createEmptyDocument('命令层冒烟'),
          tasks: [
            {
              id: 'a',
              parentId: null,
              outlineNumber: '1',
              name: '阶段',
              startDate: null,
              endDate: null,
              durationDays: null,
              progress: null,
              milestone: false,
              collapsed: false,
              notes: null,
              manual: false,
              constraints: [],
            },
            {
              id: 'b',
              parentId: null,
              outlineNumber: '2',
              name: '任务',
              startDate: '2025-01-06',
              endDate: '2025-01-10',
              durationDays: 4,
              progress: 0.5,
              milestone: false,
              collapsed: false,
              notes: null,
              manual: false,
              constraints: [],
            },
          ],
        }),
      ),
    );

    let session = engine.createSession(base);
    const apply = engine.applyToSession(session, { kind: 'task.indent', id: 'b' });
    expect(apply.ok).toBe(true);
    if (!apply.ok || !apply.changed) {
      return;
    }
    session = apply.session;
    expect(session.document.tasks.find((task) => task.id === 'b')?.parentId).toBe('a');

    const crossField = engine.applyToSession(session, {
      kind: 'task.update',
      id: 'b',
      patch: { name: '任务（改）', progress: 1, notes: '跨字段' },
    });
    expect(crossField.ok).toBe(true);
    if (!crossField.ok || !crossField.changed) {
      return;
    }
    session = crossField.session;
    const peak = session.document;

    const undoneOnce = engine.undoSession(session);
    expect(undoneOnce.ok).toBe(true);
    if (!undoneOnce.ok) {
      return;
    }
    const undoneTwice = engine.undoSession(undoneOnce.session);
    expect(undoneTwice.ok).toBe(true);
    if (!undoneTwice.ok) {
      return;
    }
    expect(undoneTwice.session.document).toStrictEqual(base);

    const firstRedo = engine.redoSession(undoneTwice.session);
    expect(firstRedo.ok).toBe(true);
    if (!firstRedo.ok) {
      return;
    }
    const secondRedo = engine.redoSession(firstRedo.session);
    expect(secondRedo.ok).toBe(true);
    if (!secondRedo.ok) {
      return;
    }
    expect(secondRedo.session.document).toStrictEqual(peak);
  });

  it('通过公共入口就能走完「新建 → 建层级 → 序列化 → 解析」', () => {
    const base = engine.createEmptyDocument('试点项目');
    const withTasks: engine.ProjectDocument = {
      ...base,
      tasks: [
        {
          id: 'a',
          parentId: null,
          outlineNumber: '1',
          name: '阶段',
          startDate: null,
          endDate: null,
          durationDays: null,
          progress: null,
          milestone: false,
          collapsed: false,
          notes: null,
          manual: false,
          constraints: [],
        },
        {
          id: 'b',
          parentId: 'a',
          outlineNumber: '1.1',
          name: '子任务',
          startDate: '2025-01-06',
          endDate: '2025-01-10',
          durationDays: 4,
          progress: 0.5,
          milestone: false,
          collapsed: false,
          notes: null,
          manual: false,
          constraints: [],
        },
      ],
    };

    const reparsed = engine.parseDocument(engine.serializeDocument(engine.reindexDocument(withTasks)));
    expect(reparsed.tasks.map((entry) => [entry.id, entry.parentId, entry.outlineNumber])).toStrictEqual([
      ['a', null, '1'],
      ['b', 'a', '1.1'],
    ]);
  });

  it('通过公共入口走一次调级：indent 后 outdent 回到原形状', () => {
    const tasks = [
      { id: 'a', parentId: null, outlineNumber: '1', name: 'a' },
      { id: 'b', parentId: null, outlineNumber: '2', name: 'b' },
    ];
    const indented = engine.indentTask(tasks, 'b');
    expect(indented.ok).toBe(true);
    if (!indented.ok) {
      return;
    }
    expect(indented.value.find((entry) => entry.id === 'b')?.parentId).toBe('a');

    const back = engine.outdentTask(indented.value, 'b');
    expect(back.ok).toBe(true);
    if (!back.ok) {
      return;
    }
    expect(back.value.map((entry) => [entry.id, entry.parentId, entry.outlineNumber])).toStrictEqual(
      tasks.map((entry) => [entry.id, entry.parentId, entry.outlineNumber]),
    );
  });

  it('通过公共入口就能走完「ISO → 序号 → ISO」与工作日推演', () => {
    const baseDay = engine.isoToDayNumber('2025-01-06'); // 周一
    const calendar = new engine.Calendar({}, { baseDay, spanDays: 120 });
    const ef = calendar.addWorkdays(baseDay, 5); // 半开区间：起算日计入、结束日不计入
    expect(calendar.isoOfDay(ef)).toBe('2025-01-13');
    expect(calendar.ordinalOfDay(ef)).toBe(5);
  });

  it('是纯函数：相同输入得到相同输出，且不产生外部状态', () => {
    const first = engine.countWorkdays('2025-01-06', '2025-01-13');
    const second = engine.countWorkdays('2025-01-06', '2025-01-13');
    expect(first).toBe(second);
    expect(first).toBe(5);

    const a = new engine.Calendar({}, { baseDay: 0, spanDays: 60 });
    const b = new engine.Calendar({}, { baseDay: 0, spanDays: 60 });
    expect(a.workdayCount).toBe(b.workdayCount);
    expect(a.isoOfOrdinal(3)).toBe(b.isoOfOrdinal(3));
  });
});
