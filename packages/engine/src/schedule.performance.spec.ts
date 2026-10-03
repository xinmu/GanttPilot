import { describe, expect, it } from 'vitest';

import { compute, createScheduleCalendar } from './schedule.js';
import { largeScheduleProject } from './scheduleFixtures.spec.js';
import { deepChainDocument, formatNs, measureOps, naiveMatchesCompute, naiveSchedule } from './perfHarness.spec.js';

/**
 * **性能门禁**（ADR 0004 §9 第四层证据、S3 §四的 DoD 定标）：
 *
 * | 条目 | 判据 | 实测依据（S3，Node 24） |
 * |---|---|---|
 * | 1,000 任务 / 1,500 依赖**全量传播** | **p99 ≤ 1 ms** | 最差 52.1 µs ⇒ 约 19× 余量 |
 * | EN-08 的产品侧天花板 | p99 ≤ 100 ms（**不回归**） | 约 1,900× 余量 |
 * | 深链 1,000 节点 | 不依赖调用栈（不抛 `RangeError`） | S3 §八 A.4 |
 * | 性能负向对照 | 已知更慢的实现必须被量出 ≥1.5× | S3 的 NC3（Map + 对象图慢 2.8–3.4×） |
 *
 * 计时口径：**批量 + median-of-suites**（`perfHarness.spec.ts`）。本用例测的是**完整**
 * `compute()`（含 CSR 重建、诊断收集与结果分配），不是 S3 只测遍历的内核片段——因此这里的数字
 * 是"产品口径"，只会比 S3 更保守。
 */

const TASKS = 1000;
const LINKS = 1500;

describe('G2 性能：全量传播的 DoD', () => {
  it(`1,000 任务 / 1,500 依赖全量传播 p99 ≤ 1 ms（100 ms 为产品侧不回归天花板）`, { timeout: 600_000 }, () => {
    const project = largeScheduleProject(TASKS, LINKS);
    expect(project.document.tasks).toHaveLength(TASKS);
    expect(project.document.links.length).toBeGreaterThanOrEqual(LINKS);
    const document_ = project.document;
    const calendar = createScheduleCalendar(document_);

    // 先跑一次热身（JIT 与缓存），并确认这份数据集真的能出排程。
    const warm = compute(document_, calendar);
    expect(warm.ok).toBe(true);
    if (!warm.ok) {
      return;
    }

    const measured = measureOps(() => {
      compute(document_, calendar);
    });

    // 把实测数值打进测试输出（落地记录要引用它，S3 的留痕口径）。
    console.log(
      `[G2 性能] 全量 compute @${String(TASKS)} 任务/${String(document_.links.length)} 依赖：` +
        `p50=${formatNs(measured.medianP50)} p95=${formatNs(measured.medianP95)} ` +
        `p99=${formatNs(measured.medianP99)}（最差 suite p99=${formatNs(measured.worstP99)}，` +
        `batchSize=${String(measured.batchSize)}，suites=${String(measured.suites)}×${String(measured.batchesPerSuite)} 批）`,
    );

    expect(measured.medianP99).toBeLessThanOrEqual(1_000_000); // 1 ms：收紧后的工程 DoD
    expect(measured.worstP99).toBeLessThanOrEqual(10_000_000); // 最差 suite 也不得离谱
    expect(measured.medianP99).toBeLessThanOrEqual(100_000_000); // EN-08 的产品侧不回归天花板
  });

  it('深链 1,000 节点：不依赖调用栈、不抛异常', { timeout: 120_000 }, () => {
    const chain = deepChainDocument(1000).document;
    const result = compute(chain, createScheduleCalendar(chain));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 每个任务 2 个工作日串成一条链：最后一个任务的排他结束序号必须是 2,000。
    expect(result.schedule.projectFinish).toBe(2000);
    expect(result.schedule.es[999]).toBe(1998);
    expect(result.schedule.ef[999]).toBe(2000);
  });
});

describe('G2 性能：负向对照（计时骨架有判别力）', () => {
  it('已知更慢的实现必须被量出差别，且它算出的 ES/EF 与本实现一致', { timeout: 600_000 }, () => {
    const project = largeScheduleProject(300, 450, 777_001);
    const document_ = project.document;
    const calendar = createScheduleCalendar(document_);

    // 前置条件：对照实现只支持"每个叶子都有显式 durationDays"的文档。
    for (const task of document_.tasks) {
      expect(task.durationDays).not.toBeNull();
    }
    expect(naiveMatchesCompute(document_, calendar)).toBe(true);

    const fast = measureOps(
      () => {
        compute(document_, calendar);
      },
      { suites: 3, batchesPerSuite: 100 },
    );
    const slow = measureOps(
      () => {
        naiveSchedule(document_, calendar);
      },
      { suites: 3, batchesPerSuite: 100 },
    );
    const ratio = slow.medianP50 / fast.medianP50;

    console.log(
      `[G2 性能对照] 快=${formatNs(fast.medianP50)} 慢=${formatNs(slow.medianP50)} 倍率=${ratio.toFixed(2)}×` +
        `（朴素实现走 Map + 对象邻接 + 定点松弛，passes=${String(naiveSchedule(document_, calendar).passes)}）`,
    );

    expect(ratio).toBeGreaterThanOrEqual(1.5);
  });
});
