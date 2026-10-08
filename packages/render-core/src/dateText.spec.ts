/**
 * P-19 判据 ① ②（左表日期文本与图表**同源**、**开始 ≤ 完成**）。
 *
 * ## 这一条为什么必须存在（P-19 §4）
 *
 * `pnpm gate` 在缺陷落地当日是**全绿**的：`apps/web` 的 spec 数为 0，因此应用层的格式化
 * 完全不在门禁覆盖内。缺陷的形态非常安静——左表整列被搬到 2025 年、并出现"完成早于开始"，
 * 因为 `Schedule` 的序号是相对 `createScheduleCalendar(document)` 的，而 `cellText` 用了
 * 一份**未锚定**的日历（默认 `baseDay` = 2025-01-01，相差 642 个自然日）。
 *
 * ## 判据的口径（写清楚"对哪些行成立"，否则会变成模糊断言）
 *
 * | # | 断言 | 适用范围 |
 * |---|---|---|
 * | ① | `start ≤ end` | **全部**任务（含汇总、无日期叶子、里程碑）；空串单独计数并声明可接受 |
 * | ② | `cellText('start') === isoOfOrdinal(es)`；派生 `end` 的 `≈` 值 `=== isoOfOrdinal(ef − 1)` | 叶子 + 汇总（取 `summaryEs`/`summaryEf`）；**`startDate` 非空且排程未覆盖它**的行要求逐字符相等 |
 * | ③ | 派生 `end` 的 `≈` 值 `=== isoOfOrdinal(ef − 1)`（**不是** `isoOfOrdinal(ef)`） | 全部叶子行（跨周末的条会把 `ef` 与 `ef − 1` 分开） |
 *
 * ④ 的负向对照（NC1/NC2）在同目录的 `dateTextNegative.spec.ts`——
 * **没有它们，上面三条可能只是恒真式**（P-13/P-15/P-18 的既有纪律）。
 */

import { describe, expect, it } from 'vitest';

import { isoToDayNumber } from '@ganttpilot/engine';

import { cellText, isoOfOrdinalSafe } from './viewText.js';
import { buildTextFixture } from './textFixtures.spec.js';

const fixture = buildTextFixture();

/** 桩：把 ISO 转成日序号（测试侧只读，不参与被测逻辑）。 */
function dayOfIso(iso: string): number {
  return isoToDayNumber(iso);
}

describe('`predecessors` 的显示文本（第五次人工复验第 2 条：关系类型必须显示）', () => {
  it('类型一律显示（含默认的 `FS`）、lag 带符号；口径与 ADR 0006 §2 的导出形态同形', () => {
    // 用夹具里**已经存在**的边（保证 `from`/`to` 都能解析出 `outlineNumber`），
    // 再补一条同对任务、类型不同的边 ⇒ 文本里必然同时出现 `FS` 与 `SS`。
    const document = fixture.document;
    const first = document.links[0];
    if (first === undefined) throw new Error('夹具没有依赖边');
    const targetIndex = document.tasks.findIndex((task) => task.id === first.to);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const text = cellText({
      key: 'predecessors',
      document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      docIndex: targetIndex,
    }).text;
    // 有前置任务时文本非空，且**每一条都带类型**（`FS`/`SS`/`FF`/`SF` 之一）。
    expect(text.length).toBeGreaterThan(0);
    const segments = text.split('; ');
    for (const segment of segments) {
      expect(segment).toMatch(/(FS|SS|FF|SF)/);
    }
    // NC：旧式把默认的 `FS` 省掉 ⇒ 把 `FS` 从文本里去掉之后**仍然相等**，
    // 即"信息丢了也看不出来"（这条断言在旧实现下必然失败）。
    expect(text.replace(/FS/g, '')).not.toBe(text);
  });
});
describe('P-19 判据 ①：显示的开始不晚于显示的完成（全部行）', () => {
  it('每一行的 开始 ≤ 完成，且空值行会被计数（不是"静默通过"）', () => {
    const { document, schedule, calendar } = fixture;
    let bothPresent = 0;
    let empty = 0;
    const offenders: string[] = [];

    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const task = document.tasks[docIndex];
      if (task === undefined) continue;
      const start = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
      const end = cellText({ key: 'end', document, schedule, calendar, docIndex }).text;
      if (start === '' || end === '') {
        empty += 1;
        continue;
      }
      bothPresent += 1;
      // 派生显示值带 `≈` 前缀（SCHEDULE.md §四.2），比较前去掉它。
      const endIso = end.startsWith('≈') ? end.slice(1) : end;
      if (start > endIso) offenders.push(`${task.id}: ${start} > ${endIso}`);
    }

    expect(offenders).toStrictEqual([]);
    // 反向保证：判据不是"因为两列都空所以通过"。
    expect(bothPresent).toBeGreaterThan(document.tasks.length * 0.9);
    expect(empty + bothPresent).toBe(document.tasks.length);
  });

  it('汇总行同样成立（`summaryEs`/`summaryEf` 的半开区间口径）', () => {
    const { document, schedule, calendar } = fixture;
    let summaries = 0;
    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      if ((schedule.es[docIndex] ?? -1) !== -1) continue;
      if ((schedule.summaryEs[docIndex] ?? -1) < 0) continue; // 空汇总不产出行
      summaries += 1;
      const start = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
      const end = cellText({ key: 'end', document, schedule, calendar, docIndex }).text;
      expect(start).not.toBe('');
      expect(end).not.toBe('');
      expect(start <= end).toBe(true);
    }
    expect(summaries).toBeGreaterThan(0);
  });
});

describe('P-19 判据 ②：左表日期与 `Schedule` 序号同源', () => {
  it('叶子：「开始」要么是文档 `startDate`、要么是 `isoOfOrdinal(es)`，且**被排程覆盖时以显示值为准**', () => {
    const { document, schedule, calendar } = fixture;
    const overridden = new Set(
      schedule.diagnostics
        .filter((item) => item.code === 'dateOverridden' && item.taskId !== undefined)
        .map((item) => item.taskId),
    );
    let derived = 0;
    let anchored = 0;
    let overriddenRows = 0;

    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const task = document.tasks[docIndex];
      if (task === undefined) continue;
      const es = schedule.es[docIndex] ?? -1;
      if (es === -1) continue; // 汇总另测
      const text = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
      const fromOrdinal = isoOfOrdinalSafe(calendar, es) ?? '';
      if (task.startDate !== null) {
        anchored += 1;
        if (overridden.has(task.id)) {
          // 情形③：文档日期被入边推导覆盖 —— 左表显示文档字段（文档是真相源），
          // 但**判据不因此放宽**：显示值仍必须与排程序号同源或与文档同源，二者必居其一。
          overriddenRows += 1;
          expect([task.startDate, fromOrdinal]).toContain(text);
        } else {
          expect(text).toBe(task.startDate);
          expect(text).toBe(fromOrdinal);
        }
      } else {
        derived += 1;
        expect(text).toBe(fromOrdinal);
      }
    }

    expect(anchored + derived).toBeGreaterThan(0);
    expect(derived).toBeGreaterThan(0);
    // 夹具里必须真的存在"被覆盖"的行，否则上面那条分支是死代码。
    expect(overriddenRows).toBeGreaterThan(0);
  });

  it('汇总行取 `summaryEs`/`summaryEf`（`-1` 哨兵绝不喂给 `dayOfOrdinal`）', () => {
    const { document, schedule, calendar } = fixture;
    let checked = 0;
    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      if ((schedule.es[docIndex] ?? -1) !== -1) continue;
      const summaryEs = schedule.summaryEs[docIndex] ?? -1;
      const summaryEf = schedule.summaryEf[docIndex] ?? -1;
      if (summaryEs < 0 || summaryEf < 0) continue;
      checked += 1;
      expect(cellText({ key: 'start', document, schedule, calendar, docIndex }).text).toBe(
        isoOfOrdinalSafe(calendar, summaryEs) ?? '',
      );
      expect(cellText({ key: 'end', document, schedule, calendar, docIndex }).text).toBe(
        isoOfOrdinalSafe(calendar, summaryEf - 1) ?? '',
      );
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('P-19 判据 ③：派生「完成」与**显示的「开始」**同源', () => {
  it('无 `endDate` 的叶子行：`≈` 值 = `dayOfOrdinal(startOrdinal + 工期 − 1)`（同一日历）', () => {
    const { document, schedule, calendar } = fixture;
    let derivedRows = 0;
    let startSourceFromDocument = 0;
    let startSourceFromSchedule = 0;

    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const task = document.tasks[docIndex];
      if (task === undefined) continue;
      const es = schedule.es[docIndex] ?? -1;
      if (es === -1 || task.endDate !== null || task.durationDays === null) continue;
      derivedRows += 1;
      const startText = cellText({ key: 'start', document, schedule, calendar, docIndex }).text;
      const endText = cellText({ key: 'end', document, schedule, calendar, docIndex }).text;

      // 「开始」列的来源：文档日期（情形①）或排程序号（情形②/③）。
      const fromDoc = task.startDate !== null && startText === task.startDate;
      const startOrdinal =
        fromDoc && task.startDate !== null
          ? calendar.ordinalOfDay(dayOfIso(task.startDate))
          : es;
      if (fromDoc) startSourceFromDocument += 1;
      else startSourceFromSchedule += 1;

      // 零时长（里程碑）的完成 = 开始；正时长 = `startOrdinal + 工期 − 1`。
      const expectedEnd =
        task.durationDays <= 0
          ? startText
          : (isoOfOrdinalSafe(calendar, startOrdinal + task.durationDays - 1) ?? '');
      expect(endText).toBe(`≈${expectedEnd}`);
      // 两列必须构成合法区间（**这是本轮抓出的第二处错位**：混用两个起点会得到"完成早于开始"）。
      expect(startText <= endText.slice(1)).toBe(true);
    }

    expect(derivedRows).toBeGreaterThan(0);
    // 两个来源都必须在夹具里出现，否则这条判据只覆盖了一支。
    expect(startSourceFromDocument).toBeGreaterThan(0);
    expect(startSourceFromSchedule).toBeGreaterThan(0);
  });
});
