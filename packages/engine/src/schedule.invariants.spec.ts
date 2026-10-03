import { describe, expect, it } from 'vitest';

import { Calendar } from './date.js';
import { type ProjectDocument } from './schema.js';
import { LEAF_SENTINEL, compute, createScheduleCalendar } from './schedule.js';
import { SCHEDULE_CALENDARS, generateProject, makeCalendar, type GeneratedProject } from './scheduleFixtures.spec.js';
import { checkScheduleInvariants } from './scheduleInvariants.spec.js';

/**
 * **不变量 / 性质测试**（ADR 0004 §9 第一层证据）：≥ 1,000 张随机图上逐条断言
 * `EF = ES + 工期`、四类关系的前向边界方程、`anchored`/`driven` 与文档日期一致性、
 * 汇总值 = 子树聚合的独立重算、`clampedStarts` 与诊断同数、`projectFinish = max(ef)`。
 *
 * 判据本体是 `scheduleInvariants.spec.ts` 的**独立检查器**（逐日循环重算工期、沿父链重算汇总）；
 * 它本身有判别力由负向对照证明（`schedule.contract.spec.ts` 的篡改用例 + 本文件的边界方程对照）。
 * 随机种子固定并随失败信息打印。
 */

const SEED_BASE = 330_000;
const PROJECT_COUNT = 1000;

function specFor(index: number): GeneratedProject {
  const taskCount = 5 + ((index * 11) % 96);
  return generateProject({
    id: `inv-${String(index)}`,
    seed: SEED_BASE + index,
    taskCount,
    linkCount: Math.max(taskCount - 1, Math.floor(taskCount * 1.7)),
    maxDuration: 12,
    maxLag: 4,
    milestoneRatio: 0.08,
    calendarIndex: index % SCHEDULE_CALENDARS.length,
    baseDayOffset: [0, -20, 4][index % 3]!,
    hierarchyRatio: index % 3 === 0 ? 0.2 : 0.08,
    dateRatio: 0.75,
    explicitDurationRatio: 0.85,
  });
}

describe('G2 不变量：≥1,000 张随机图', () => {
  it('全部不变量零违规（含汇总聚合、截断计数与边界方程）', { timeout: 300_000 }, () => {
    const violations: string[] = [];
    let rows = 0;
    let summaries = 0;
    let clamped = 0;
    for (let index = 0; index < PROJECT_COUNT; index += 1) {
      const project = specFor(index);
      const calendar = makeCalendar(project);
      const result = compute(project.document, calendar, project.anchors);
      if (!result.ok) {
        violations.push(`inv-${String(index)}：DAG 数据集不应成环`);
        continue;
      }
      const found = checkScheduleInvariants(project.document, calendar, result, project.anchors);
      for (const violation of found) {
        if (violations.length < 20) {
          violations.push(`inv-${String(index)}（seed=${String(SEED_BASE + index)}）${violation.rule}：${violation.detail}`);
        }
      }
      rows += result.schedule.taskCount;
      summaries += Array.from(result.schedule.es).filter((value) => value === LEAF_SENTINEL).length;
      clamped += result.schedule.clampedStarts;
    }
    expect(violations, `不变量违规（seedBase=${String(SEED_BASE)}）：\n${violations.join('\n')}`).toStrictEqual([]);
    // 断言"检查面真的被覆盖到了"（否则上面可能是空跑）。
    expect(rows).toBeGreaterThan(40_000);
    expect(summaries).toBeGreaterThan(0);
    expect(clamped).toBeGreaterThan(0);
  });

  it('容量不改变结果（同一输入、三种容量）', () => {
    for (const index of [3, 17, 42]) {
      const project = specFor(index);
      const baseDay = makeCalendar(project).baseDay;
      const results = [60, 400, 20_000].map((spanDays) =>
        compute(
          project.document,
          new Calendar(project.document.calendars[0]!, { baseDay, spanDays }),
          project.anchors,
        ),
      );
      for (const result of results) {
        expect(result.ok).toBe(true);
      }
      const first = results[0]!;
      for (const other of results.slice(1)) {
        expect(other.ok && first.ok ? other.schedule : null).toStrictEqual(first.ok ? first.schedule : null);
      }
    }
  });

  it('`createScheduleCalendar` 在随机图上始终够用（序号不超出工作日总数）', () => {
    for (let index = 0; index < 120; index += 1) {
      const project = specFor(index * 7);
      const calendar = createScheduleCalendar(project.document);
      const result = compute(project.document, calendar, project.anchors);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.schedule.projectFinish).toBeLessThanOrEqual(calendar.workdayCount);
      const lastLeaf = result.schedule.ef.findIndex((value) => value !== LEAF_SENTINEL);
      if (lastLeaf >= 0) {
        expect(() => calendar.isoOfOrdinal(result.schedule.ef[lastLeaf]!)).not.toThrow();
      }
    }
  });
});

describe('G2 不变量检查器的负向对照（边界方程必须承重）', () => {
  it('偷换依赖类型（文档被改、结果未改）必须被边界方程检出', () => {
    const project = specFor(5);
    const calendar = makeCalendar(project);
    const result = compute(project.document, calendar, project.anchors);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(checkScheduleInvariants(project.document, calendar, result, project.anchors)).toStrictEqual([]);

    // 找一条两端点都是叶子的边，把 FS 改成 SS（并把 lag 改大）——排程结果不再满足新方程。
    const summaryIds = new Set(
      project.document.tasks
        .map((task) => task.id)
        .filter((id) => project.document.tasks.some((entry) => entry.parentId === id)),
    );
    const index = project.document.links.findIndex(
      (link) => !summaryIds.has(link.from) && !summaryIds.has(link.to) && link.type === 'FS',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const mutated: ProjectDocument = {
      ...project.document,
      links: project.document.links.map((link, at) =>
        at === index ? { ...link, type: 'SS' as const, lagDays: link.lagDays + 7 } : link,
      ),
    };
    const violations = checkScheduleInvariants(mutated, calendar, result, project.anchors);
    expect(violations.some((violation) => violation.rule === 'boundary')).toBe(true);
  });
});
