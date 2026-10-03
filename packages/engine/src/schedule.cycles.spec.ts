import { describe, expect, it } from 'vitest';

import { Calendar } from './date.js';
import { type DocumentLink, type ProjectDocument } from './schema.js';
import { compute, wouldCreateCycle } from './schedule.js';
import {
  SCHEDULE_BASE_DAY,
  fixtureDocument,
  fixtureTask,
  generateProject,
  makeCalendar,
} from './scheduleFixtures.spec.js';

/**
 * **检环**（DM-04 / EN-05 / ADR 0004 §6）：
 * - `compute` 遇环 ⇒ `ok:false` 且给出**成环路径**（G5 高亮用），不产出半成品排程；
 * - `wouldCreateCycle` 是建边预检（G5 即时反馈、G3 导入丢弃），**与 `compute` 同口径（结构性）**；
 * - 导入"丢弃成环边 + 进问题清单"的动作发生在 G3，本文件只验证判定与路径。
 */

function calendar(): Calendar {
  return new Calendar({}, { baseDay: SCHEDULE_BASE_DAY, spanDays: 400 });
}

function cyclePathOf(document: ProjectDocument): readonly string[] {
  const result = compute(document, calendar());
  expect(result.ok).toBe(false);
  if (result.ok) {
    return [];
  }
  // 失败形状：`code=cycle`、只带一条 error 诊断、不产出 `schedule`。
  expect(result.code).toBe('cycle');
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe('cycle');
  expect(result.diagnostics[0]?.severity).toBe('error');
  expect('schedule' in result).toBe(false);
  return result.cyclePath;
}

function assertRealCycle(document: ProjectDocument, cyclePath: readonly string[]): void {
  expect(cyclePath.length).toBeGreaterThanOrEqual(2);
  expect(cyclePath[0]).toBe(cyclePath[cyclePath.length - 1]);
  const seen = new Set<string>();
  for (const id of cyclePath) {
    expect(document.tasks.some((task) => task.id === id), `路径上的 ${id} 必须存在`).toBe(true);
    seen.add(id);
  }
  for (let i = 0; i + 1 < cyclePath.length; i += 1) {
    const from = cyclePath[i]!;
    const to = cyclePath[i + 1]!;
    expect(
      document.links.some((link) => link.from === from && link.to === to),
      `路径上的每一跳都必须是真实依赖：${from} → ${to}`,
    ).toBe(true);
  }
}

describe('G2 检环：失败形状与成环路径', () => {
  it('自环', () => {
    const doc = fixtureDocument(
      [fixtureTask({ id: 'a', durationDays: 1 })],
      [{ id: 'l1', from: 'a', to: 'a', type: 'FS', lagDays: 0 }],
    );
    assertRealCycle(doc, cyclePathOf(doc));
  });

  it('两节点环（跨关系类型）', () => {
    const doc = fixtureDocument(
      [fixtureTask({ id: 'a', durationDays: 1 }), fixtureTask({ id: 'b', durationDays: 1 })],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'b', to: 'a', type: 'SS', lagDays: 2 },
      ],
    );
    assertRealCycle(doc, cyclePathOf(doc));
  });

  it('长环 + 挂在环上的尾巴：路径不能把尾巴算进去', () => {
    const doc = fixtureDocument(
      [
        fixtureTask({ id: 'a', durationDays: 1 }),
        fixtureTask({ id: 'b', durationDays: 1 }),
        fixtureTask({ id: 'c', durationDays: 1 }),
        fixtureTask({ id: 'tail', durationDays: 1 }),
      ],
      [
        { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'b', to: 'c', type: 'FS', lagDays: 0 },
        { id: 'l3', from: 'c', to: 'a', type: 'FS', lagDays: 0 },
        { id: 'l4', from: 'c', to: 'tail', type: 'FS', lagDays: 0 },
      ],
    );
    const path = cyclePathOf(doc);
    assertRealCycle(doc, path);
    expect(path).not.toContain('tail');
    expect(path.length).toBe(4); // c → a → b → c
  });

  it('只经由汇总端点的环也结构性检出（与 wouldCreateCycle 同口径）', () => {
    const doc = fixtureDocument(
      [
        fixtureTask({ id: 'w1', name: '阶段' }),
        fixtureTask({ id: 'leaf', parentId: 'w1', durationDays: 2 }),
      ],
      [
        { id: 'l1', from: 'leaf', to: 'w1', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'w1', to: 'leaf', type: 'FS', lagDays: 0 },
      ],
    );
    assertRealCycle(doc, cyclePathOf(doc));
    expect(wouldCreateCycle([doc.links[0]!], doc.links[1]!).cyclic).toBe(true);
  });

  it('200 张随机成环图：全部拒绝，路径真的闭环', () => {
    for (let index = 0; index < 200; index += 1) {
      const project = generateProject({
        id: `cyc-${String(index)}`,
        seed: 660_000 + index,
        taskCount: 6 + ((index * 5) % 60),
        linkCount: 10 + ((index * 3) % 40),
        cyclic: true,
      });
      const path = cyclePathOf(project.document);
      assertRealCycle(project.document, path);
    }
  });
});

describe('G2 检环：wouldCreateCycle 与 compute 判定一致', () => {
  it('随机候选边：预检说成环 ⇔ 加进去后 compute 拒绝', () => {
    let cyclicCandidates = 0;
    let benignCandidates = 0;
    for (let index = 0; index < 25; index += 1) {
      const project = generateProject({
        id: `pre-${String(index)}`,
        seed: 880_000 + index,
        taskCount: 20 + ((index * 3) % 40),
        linkCount: 30 + ((index * 5) % 40),
      });
      const ids = project.document.tasks.map((task) => task.id);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const from = ids[(index * 7 + attempt * 3) % ids.length]!;
        const to = ids[(index * 11 + attempt * 5 + 1) % ids.length]!;
        const candidate: DocumentLink = {
          id: `cand-${String(index)}-${String(attempt)}`,
          from,
          to,
          type: 'FS',
          lagDays: 0,
        };
        const precheck = wouldCreateCycle(project.document.links, candidate);
        const withCandidate: ProjectDocument = {
          ...project.document,
          links: [...project.document.links, candidate],
        };
        const result = compute(withCandidate, makeCalendar(project));
        expect(result.ok, `预检=${String(precheck.cyclic)} 但 compute.ok=${String(result.ok)}（${from} → ${to}）`).toBe(
          !precheck.cyclic,
        );
        if (precheck.cyclic) {
          cyclicCandidates += 1;
          expect(precheck.path[0]).toBe(from);
          expect(precheck.path[precheck.path.length - 1]).toBe(from);
          if (result.ok === false) {
            assertRealCycle(withCandidate, result.cyclePath);
          }
        } else {
          benignCandidates += 1;
          expect(precheck.path).toStrictEqual([]);
        }
      }
    }
    // 两类候选都出现过，说明这条对照不是恒真式。
    expect(cyclicCandidates).toBeGreaterThan(0);
    expect(benignCandidates).toBeGreaterThan(0);
  });

  it('悬空端点与自环候选的判定', () => {
    const links: DocumentLink[] = [{ id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 }];
    expect(wouldCreateCycle([], { id: 'x', from: 'y', to: 'z', type: 'FS', lagDays: 0 })).toStrictEqual({
      cyclic: false,
      path: [],
    });
    expect(wouldCreateCycle(links, { id: 'x', from: 'q', to: 'q', type: 'FS', lagDays: 0 })).toStrictEqual({
      cyclic: true,
      path: ['q', 'q'],
    });
    // 邻居顺序 = links 数组序（确定性）：DFS 命中 `a` 的第一条出边 `a → b` 是死路（回边到已在路径上的 a），
    // 回溯后命中第二条出边 `a → c` = 候选的 from，于是给出最短的那个环 c → a → c。
    const branching: DocumentLink[] = [
      { id: 'l1', from: 'a', to: 'b', type: 'FS', lagDays: 0 },
      { id: 'l2', from: 'a', to: 'c', type: 'FS', lagDays: 0 },
      { id: 'l3', from: 'b', to: 'a', type: 'FS', lagDays: 0 },
    ];
    const found = wouldCreateCycle(branching, { id: 'x', from: 'c', to: 'a', type: 'FS', lagDays: 0 });
    expect(found.cyclic).toBe(true);
    expect(found.path).toStrictEqual(['c', 'a', 'c']);
    // 同一条边上如果先给的出边不构成死路，路径就会更长——证明它返回的是真实路径而不是固定形状。
    const longer = wouldCreateCycle(
      [branching[0]!, branching[2]!],
      { id: 'x', from: 'c', to: 'a', type: 'FS', lagDays: 0 },
    );
    expect(longer.cyclic).toBe(false); // c 在只有 a→b、b→a 的图里不可达 a
    const viaB = wouldCreateCycle(
      [
        { id: 'l1', from: 'a', to: 'c', type: 'FS', lagDays: 0 },
        { id: 'l2', from: 'b', to: 'a', type: 'FS', lagDays: 0 },
        { id: 'l3', from: 'c', to: 'b', type: 'FS', lagDays: 0 },
      ],
      { id: 'x', from: 'c', to: 'a', type: 'FS', lagDays: 0 },
    );
    expect(viaB.path).toStrictEqual(['c', 'a', 'c']);
  });
});
