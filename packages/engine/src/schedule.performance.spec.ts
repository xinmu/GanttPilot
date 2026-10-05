import { describe, expect, it } from 'vitest';

import { compute, createScheduleCalendar } from './schedule.js';
import { largeScheduleProject } from './scheduleFixtures.spec.js';
import { deepChainDocument, formatNs, measureOps, naiveMatchesCompute, naiveSchedule } from './perfHarness.spec.js';

/**
 * **性能门禁**（ADR 0004 §9 第四层证据、S3 §四的 DoD 定标；口径于 P-38 拆为两条）：
 *
 * | 条目 | 判据 | 实测依据 |
 * |---|---|---|
 * | 1,000 任务 / 1,500 依赖**全量传播**·中位数 | **p50 ≤ 1 ms** | S3 参照机 326 µs；并行满负荷 449 µs ⇒ 余量 ≥2.2× |
 * | 同上的**尾部** | **p99 ≤ 2 ms** | 空闲机 530 µs；并行满负荷 1.04–1.25 ms ⇒ 余量 ≥1.6× |
 * | 最差 suite | p99 ≤ 10 ms | 留痕口径（单机抖动） |
 * | EN-08 的产品侧天花板 | p99 ≤ 100 ms（**不回归**） | 约 1,900× 余量 |
 * | 深链 1,000 节点 | 不依赖调用栈（不抛 `RangeError`） | S3 §八 A.4 |
 * | 性能负向对照 | 已知更慢的实现必须被量出 ≥1.5× | S3 的 NC3（Map + 对象图慢 2.8–3.4×） |
 *
 * ## 为什么拆成两条（P-26 → P-38 的收口）
 *
 * 旧口径是单条 `p99 ≤ 1 ms`。它在**独占/空闲机器**上成立（S3 定标时 p99 = 52.1 µs），
 * 但本 spec 与其余 50+ 个用例**共享同一个并行池**，而 G7 之后并行池里多了几个 CPU 较重的用例
 * （模板 A 含 pptxgenjs 容器构建）⇒ 实测 p99 会在 **0.53–1.25 ms** 之间摆动，
 * 于是门禁约**一半的运行**会红（[P-26](../../../docs/01-roadmap/首版-待定清单.md) 记录的"偶发超阈"，
 * G7 两轮实测到 `medianP99 = 1.041 / 1.250 ms`）。
 *
 * 那条红**不是性能回归**：同一工作区单跑本文件、或换个空闲时段就绿。把绝对性能交给 **p50**、
 * 把"机器多忙"交给 **p99**，两条判据各管一件事：
 *
 * - **p50 ≤ 1 ms** 是对"实现退化"的把关——朴素实现比本实现慢 **2.97×**（负向对照的实测），
 *   即它在满负荷下 p50 ≈ 1.3 ms ⇒ **一定会被这条判据拦下**；
 * - **p99 ≤ 2 ms** 是对"最坏调度"的把关，只吸收并行争用带来的抖动（实测上界 1.25 ms）。
 *
 * 更彻底的做法（给本 spec 一个**独占并行槽**，见 P-26 的候选①）仍保留为备选：
 * 若将来这条仍偶发红，再上配置层的隔离，而不是继续放宽数值。
 *
 * 计时口径：**批量 + median-of-suites**（`perfHarness.spec.ts`）。本用例测的是**完整**
 * `compute()`（含 CSR 重建、诊断收集与结果分配），不是 S3 只测遍历的内核片段——因此这里的数字
 * 是"产品口径"，只会比 S3 更保守。
 */

const TASKS = 1000;
const LINKS = 1500;

/** 两条阈值（P-38）：绝对性能 / 尾部抖动。 */
const P50_BUDGET_NS = 1_000_000;
const P99_BUDGET_NS = 2_000_000;

describe('G2 性能：全量传播的 DoD', () => {
  it(`1,000 任务 / 1,500 依赖全量传播 p50 ≤ 1 ms 且 p99 ≤ 2 ms（100 ms 为产品侧不回归天花板）`, { timeout: 600_000 }, () => {
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
        `batchSize=${String(measured.batchSize)}，suites=${String(measured.suites)}×${String(measured.batchesPerSuite)} 批）；` +
        `阈值 p50 ≤ ${formatNs(P50_BUDGET_NS)} / p99 ≤ ${formatNs(P99_BUDGET_NS)}（P-38）`,
    );

    // ① 绝对性能：**实现退化**会被这条拦下（朴素实现慢 2.97× ⇒ 满负荷 p50 ≈ 1.3 ms）
    expect(measured.medianP50).toBeLessThanOrEqual(P50_BUDGET_NS);
    // ② 尾部：只吸收并行争用的抖动（实测上界 1.25 ms）
    expect(measured.medianP99).toBeLessThanOrEqual(P99_BUDGET_NS);
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
