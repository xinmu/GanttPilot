/**
 * P-19 判据的**共享测试侧手段**（故意写成 `*.spec.ts`：可被其他 spec import，
 * 又不进 `dist`——手法同 `checkers.spec.ts` 与 engine 的 `scheduleInvariants.spec.ts`）。
 *
 * ## 这份文档为什么是"判据的基准"
 *
 * P-19 的缺陷只在**序号与日期必须由同一个日历翻译**时暴露，因此判据必须跑在一份
 * **有真实锚点偏移**的文档上：`fixtures.ts` 的基准项目起点是 `2026-10-05`，
 * 而引擎的默认 `baseDay` 是 `2025-01-01`——两者相差 **642** 个自然日，
 * 正是"用 `APP_CALENDAR` 会把整列搬到 2025 年"的那个偏移（P-19 §2 的实测表：
 * `APP_CALENDAR.baseDay = 20089`（2025-01-01）、`createScheduleCalendar(doc).baseDay = 20731`（2026-10-05）；
 * 本文件的断言把这两个数**原样复现**，因此 P-19 的证据链在门禁里是活的）。
 *
 * 真正要证明的是"**同一个序号在两份日历下落到不同日期**"——这一条与推算方式无关，
 * 由 `unanchoredCalendar` + `isoOfOrdinalSafe` 直接给出。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT_BASE_DAY_ISO, type Calendar, type ProjectDocument } from '@ganttpilot/engine';

import { buildFixture, DATASETS, FIXTURE_PROJECT_START_ISO, PRIMARY_DATASET_KEY, type RenderFixture } from './fixtures.js';
import { createScheduleCalendar } from './index.js';
import { isoOfOrdinalSafe } from './viewText.js';

/** 数据集规格（缺省 = 主口径 `dense`）。 */
export function fixtureSpecOf(key: string = PRIMARY_DATASET_KEY): (typeof DATASETS)[number] {
  const spec = DATASETS.find((item) => item.key === key) ?? DATASETS[0];
  if (spec === undefined) throw new Error('缺少数据集规格');
  return spec;
}

/** 判据用的夹具（`buildFixture` 已含 `reindexDocument` + 校验无 error + `compute`）。 */
export function buildTextFixture(key: string = PRIMARY_DATASET_KEY): RenderFixture {
  return buildFixture(fixtureSpecOf(key));
}

/** 夹具声明的基准项目起点（`fixtures.ts` 的常量，**在这里转出**，避免 spec 抄一份字面量）。 */
export { FIXTURE_PROJECT_START_ISO as FIXTURE_START_ISO };

/**
 * 一份**未锚定**的日历：`baseDay` 取 `iso`（缺省 = 引擎默认的 2025-01-01）。
 *
 * 它是负向对照 NC1 的载体：把正确日历换成它，P-19 的断言**必须**失败。
 * 走 `createScheduleCalendar` 的构造路径而不是手写 `new Calendar(...)`，
 * 是为了证明"错的不是某个参数值，而是**用了另一份日历**"。
 */
export function unanchoredCalendar(document: ProjectDocument, iso: string): Calendar {
  return createScheduleCalendar({
    version: document.version,
    project: { ...document.project, startDate: iso },
    calendars: document.calendars,
    tasks: document.tasks.map((task) => ({ ...task, startDate: null, endDate: null })),
    links: document.links,
    baselines: document.baselines,
  });
}

// ---------------------------------------------------------------- 夹具前提自证
// 这三个断言不是"判据"，而是**判据的前提**：若锚点没有偏移，NC1/NC2 与判据 ①②③ 都会失去意义。
// 同时它们把"本文件自己也要在门禁里跑"这件事变成事实（否则它只是个无人执行的手段文件）。

const premiseFixture = buildTextFixture();

describe('P-19 夹具前提：序号锚点与引擎默认 `baseDay` 不同', () => {
  it('复现 P-19 §2 的两个数字：20089（默认）vs 20731（文档锚定），相差 642 天', () => {
    const unanchored = unanchoredCalendar(premiseFixture.document, DEFAULT_PROJECT_BASE_DAY_ISO);
    expect(premiseFixture.spec.key).toBe('dense');
    expect(unanchored.baseDay).toBe(20089);
    expect(premiseFixture.calendar.baseDay).toBe(20731);
    expect(premiseFixture.calendar.baseDay - unanchored.baseDay).toBe(642);
    expect(premiseFixture.calendar.dayOfOrdinal(0)).toBe(premiseFixture.calendar.baseDay);
  });

  it('同一序号在两份日历下翻译成不同日期（错位可测）', () => {
    const unanchored = unanchoredCalendar(premiseFixture.document, DEFAULT_PROJECT_BASE_DAY_ISO);
    expect(isoOfOrdinalSafe(premiseFixture.calendar, 0)).toBe(FIXTURE_PROJECT_START_ISO);
    expect(isoOfOrdinalSafe(unanchored, 0)).toBe(DEFAULT_PROJECT_BASE_DAY_ISO);
  });

  it('夹具文档可排程、且叶子/汇总/里程碑三种行都存在（判据的分支都有样本）', () => {
    const { document, schedule } = premiseFixture;
    let summaries = 0;
    let milestones = 0;
    let leaves = 0;
    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      if ((schedule.es[docIndex] ?? -1) === -1) summaries += 1;
      else leaves += 1;
      if (document.tasks[docIndex]?.durationDays === 0) milestones += 1;
    }
    expect(summaries).toBeGreaterThan(0);
    expect(milestones).toBeGreaterThan(0);
    expect(leaves).toBeGreaterThan(0);
  });
});
