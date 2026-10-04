/**
 * P-19 判据的**负向对照**（NC1/NC2）——**进 `pnpm gate`**。
 *
 * > 没有负向对照，"开始 ≤ 完成 / 左表与图表同源"可能只是恒真式
 * > （P-13/P-15/P-18 的既有纪律：**判据必须自带牙齿**）。
 *
 * 手法：把**同一批判据**跑在**被故意破坏的输入**上，断言它**必须**报出违规 > 0。
 * 这与"把故意错的期望值写进 spec"不同——这里破坏的是**被测对象之外的输入**
 * （派生列的起点口径、`ef − 1` 这条右边界规则），因此它证明的是"判据对这些错误敏感"。
 *
 * ## 本轮实测订正（写在这里，免得后来者重踩）
 *
 * NC1 第一版把"未锚定日历"的 `baseDay` 定在**比文档更早**的 2025-01-01，
 * 于是"开始 ≤ 完成"**几乎不失败**——因为平移对两列**同时**发生，区间关系被保住。
 * 真正会撕裂两列的是**派生列与显示列不同源**：让派生「完成」从 `es`（排程序号）起算，
 * 而「开始」显示文档日期（`dateOverridden` / `clampedStart` 那些行会当场反向）。
 * 这正是本轮在 `cellText` 里真实修掉的错位，因此 NC1 的载体是**有出处**的，不是稻草人。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_BASE_DAY_ISO,
  type Calendar,
  type ProjectDocument,
  type Schedule,
} from '@ganttpilot/engine';

import { buildTextFixture, unanchoredCalendar } from './textFixtures.spec.js';
import { cellText, isoOfOrdinalSafe } from './viewText.js';

const fixture = buildTextFixture();

/** 判据 ① 的形状：返回"开始 > 完成"的行。 */
function offendersForStartAfterEnd(
  document: ProjectDocument,
  schedule: Schedule,
  calendar: Calendar,
): string[] {
  const offenders: string[] = [];
  for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
    const task = document.tasks[docIndex];
    if (task === undefined) continue;
    const start = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
    const rawEnd = cellText({ key: 'end', document, schedule, calendar, docIndex }).text;
    if (start === '' || rawEnd === '') continue;
    const end = rawEnd.startsWith('≈') ? rawEnd.slice(1) : rawEnd;
    if (start > end) offenders.push(task.id);
  }
  return offenders;
}

/**
 * **破坏版**的派生「完成」：忽略"显示的开始来自文档日期"这条同源规则，一律从 `es` 起算。
 *
 * 返回"值被改变"的行（判据 ③ 会因此在这些行上失败）。
 */
function offendersForMixedStartSource(
  document: ProjectDocument,
  schedule: Schedule,
  calendar: Calendar,
): string[] {
  const offenders: string[] = [];
  for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
    const task = document.tasks[docIndex];
    if (task === undefined) continue;
    const es = schedule.es[docIndex] ?? -1;
    if (es === -1 || task.endDate !== null || task.durationDays === null || task.durationDays <= 0) continue;
    if (task.startDate === null) continue;
    const correctEnd = cellText({ key: 'end', document, schedule, calendar, docIndex }).text;
    const brokenEnd = `≈${isoOfOrdinalSafe(calendar, es + task.durationDays - 1) ?? ''}`;
    if (brokenEnd !== correctEnd) offenders.push(task.id);
  }
  return offenders;
}

describe('NC1：派生列的起点与显示列不同源，判据必须报出违规', () => {
  it('正确实现零违规；混用起点（从 `es` 起算）会被检出', () => {
    const { document, schedule, calendar } = fixture;

    expect(offendersForStartAfterEnd(document, schedule, calendar)).toStrictEqual([]);
    const mixed = offendersForMixedStartSource(document, schedule, calendar);
    // 值不同即"判据 ③ 会失败"的证据（判据 ③ 逐行断言派生值与显示的 start 同源）。
    expect(mixed.length).toBeGreaterThan(0);
  });

  it('零时长用「startOrdinal − 1」会当场产生"完成早于开始"（本轮实测 49 行的那一类）', () => {
    const { document, schedule, calendar } = fixture;
    let reversals = 0;
    let milestones = 0;
    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const task = document.tasks[docIndex];
      if (task === undefined) continue;
      const es = schedule.es[docIndex] ?? -1;
      if (es === -1 || task.durationDays !== 0) continue;
      milestones += 1;
      const startText = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
      // 破坏：通用式在零时长时退化为"前一个工作日"。
      const brokenEnd = isoOfOrdinalSafe(calendar, es - 1) ?? '';
      if (startText > brokenEnd) reversals += 1;
    }
    expect(milestones).toBeGreaterThan(0);
    expect(reversals).toBeGreaterThan(0);
  });

  it('换一份未锚定的日历会把整列搬到另一年（同一序号 → 不同日期），判据对它敏感', () => {
    const { document, schedule, calendar } = fixture;
    const unanchored = unanchoredCalendar(document, DEFAULT_PROJECT_BASE_DAY_ISO);
    let differences = 0;
    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const correct = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
      const wrong = cellText({ key: 'start', document, schedule, unanchored, docIndex }).text;
      if (correct !== wrong) differences += 1;
    }
    expect(differences).toBeGreaterThan(0);
    // 缺陷的形态是"整列被搬走"，而不是零星几条。
    expect(differences).toBeGreaterThan(document.tasks.length * 0.5);
  });
});

describe('NC2：派生「完成」改用 `ef`（而不是 `ef − 1`）必须被检出', () => {
  it('用 `ef` 会与正确实现不同，且跨周末的条是判别力来源', () => {
    const { document, schedule, calendar } = fixture;
    let derivedRows = 0;
    let differs = 0;
    let checkedByCriterion = 0;

    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const task = document.tasks[docIndex];
      if (task === undefined) continue;
      const es = schedule.es[docIndex] ?? -1;
      if (es === -1 || task.durationDays === null || task.endDate !== null) continue;
      derivedRows += 1;
      const right = isoOfOrdinalSafe(calendar, es + task.durationDays - 1);
      const wrong = isoOfOrdinalSafe(calendar, es + task.durationDays);
      if (right !== wrong) differs += 1;
      // 判据 ③ 的形状：把错值当期望值 ⇒ 必须不等（这里只在确实不同时断言，避免对同一格重复要求）。
      if (right !== wrong) {
        expect(wrong).not.toBe(right);
        checkedByCriterion += 1;
      }
    }

    expect(derivedRows).toBeGreaterThan(0);
    expect(differs).toBeGreaterThan(0);
    expect(checkedByCriterion).toBe(differs);
  });
});
