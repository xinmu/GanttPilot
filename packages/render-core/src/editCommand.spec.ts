/**
 * P-19 判据 ③（**行内编辑写回的 `endDate` 与图表一致**）+ 值→命令映射的既有口径回归。
 *
 * ## 为什么这一条必须在门禁里
 *
 * P-19 §3 把影响面分成两条路径，其中**写入路径更严重**：`derivedEndIso` 用未锚定的日历
 * 重算 `endDate`，于是"改一下开始日期"会把**错算出的完成日经命令层写进文档**——
 * 文档被污染，而界面看起来只是"日期怪怪的"。
 *
 * 判据因此不是"命令形状对不对"，而是**闭环**：
 * `editToCommand` → `applyCommand`（唯一变更通道）→ `compute` → `ef − 1` 的 ISO
 * **必须等于**命令写进去的 `endDate`。这条只有在命令与实际排程共用同一个日历时才可能成立。
 */

import { describe, expect, it } from 'vitest';

import { applyCommand, compute, DEFAULT_PROJECT_BASE_DAY_ISO, isoDateToDayNumber, MAX_DURATION_DAYS, type ProjectDocument } from '@ganttpilot/engine';

import { createScheduleCalendar } from './index.js';
import { buildTextFixture, unanchoredCalendar } from './textFixtures.spec.js';
import { collapseToCommand, derivedEndIso, editToCommand, isoOfOrdinalSafe, parseIsoInput } from './viewText.js';

const fixture = buildTextFixture();

/** 桩：ISO → 日序号（测试侧只读）。 */
function dayOfIso(iso: string): number {
  return isoDateToDayNumber(iso);
}

/** 找一行"有文档开始日期、且是叶子"的任务（编辑 `start`/`duration` 的目标）。 */
function firstEditableLeaf(document: ProjectDocument): { readonly id: string; readonly docIndex: number } {
  for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
    const task = document.tasks[docIndex];
    if (task === undefined) continue;
    if (task.startDate !== null && task.durationDays !== null && task.durationDays > 1) {
      return { id: task.id, docIndex };
    }
  }
  throw new Error('夹具里没有可编辑的叶子行');
}

describe('P-19 判据 ③：编辑 `start` 后写回的 `endDate` 与图表一致', () => {
  it('命令写进的 `endDate` === 应用后 `compute` 的 `isoOfOrdinal(ef − 1)`', () => {
    const { document, calendar, schedule } = fixture;
    const target = firstEditableLeaf(document);
    const task = document.tasks[target.docIndex];
    if (task === undefined) throw new Error('目标行缺失');

    // 取一个与原值不同的合法日期（同时跨过一个周末，让 `ef − 1` 与 `ef` 分开）。
    const newStart = isoOfOrdinalSafe(calendar, (schedule.es[target.docIndex] ?? 0) + 5);
    expect(newStart).toBeDefined();
    if (newStart === undefined) return;

    const outcome = editToCommand({
      document,
      taskId: target.id,
      column: 'start',
      text: newStart,
      calendar,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.command.patch.startDate).toBe(newStart);
    const writtenEnd = outcome.command.patch.endDate ?? null;
    expect(writtenEnd).not.toBeNull();

    const applied = applyCommand(document, outcome.command);
    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.changed) return;

    // 应用后的文档仍由**同一个**日历解释（`createScheduleCalendar` 由文档派生）。
    const nextCalendar = createScheduleCalendar(applied.document);
    const nextSchedule = compute(applied.document, nextCalendar);
    expect(nextSchedule.ok).toBe(true);
    if (!nextSchedule.ok) return;

    const docIndex = applied.document.tasks.findIndex((item) => item.id === target.id);
    const ef = nextSchedule.schedule.ef[docIndex] ?? -1;
    expect(ef).toBeGreaterThan(0);
    expect(writtenEnd).toBe(isoOfOrdinalSafe(nextCalendar, ef - 1));
  });

  it('改 `duration` 同样写回与图表一致的 `endDate`', () => {
    const { document, calendar } = fixture;
    const target = firstEditableLeaf(document);
    const outcome = editToCommand({ document, taskId: target.id, column: 'duration', text: '7', calendar });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.command.patch.durationDays).toBe(7);
    const applied = applyCommand(document, outcome.command);
    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.changed) return;
    const nextCalendar = createScheduleCalendar(applied.document);
    const nextSchedule = compute(applied.document, nextCalendar);
    expect(nextSchedule.ok).toBe(true);
    if (!nextSchedule.ok) return;
    const docIndex = applied.document.tasks.findIndex((item) => item.id === target.id);
    const es = nextSchedule.schedule.es[docIndex] ?? -1;
    const ef = nextSchedule.schedule.ef[docIndex] ?? -1;
    expect(ef - es).toBe(7);
    expect(outcome.command.patch.endDate).toBe(isoOfOrdinalSafe(nextCalendar, ef - 1));
  });
});

describe('负向对照：同一批断言在未锚定日历下必须失败', () => {
  it('锚点不同 ⇒ 同一序号的翻译必然不同（这就是"换日历"能撕裂判据的机理）', () => {
    const { document, calendar } = fixture;
    const unanchored = unanchoredCalendar(document, DEFAULT_PROJECT_BASE_DAY_ISO);
    expect(calendar.baseDay).not.toBe(unanchored.baseDay);
    expect(isoOfOrdinalSafe(calendar, 0)).not.toBe(isoOfOrdinalSafe(unanchored, 0));
  });

  it('`derivedEndIso` 与"序数推进"这条独立写法逐行一致（日历口径不许有第二套）', () => {
    const { document, calendar } = fixture;
    /**
     * **本轮的一处发现**：`derivedEndIso` 的输入输出都是 ISO，而 `ordinalOfDay` / `dayOfOrdinal`
     * 在同一个日历内互为逆运算（比值互相抵消），因此**换一份日历不会改变它的结果**。
     * 换句话说，P-19 的缺陷本体在 `cellText`（它拿 `Schedule` 的**序号**去翻译），
     * 而不在 `derivedEndIso`；`derivedEndIso` 的风险是**地平线**（容量不足时返回 `undefined`）。
     * 这条判据因此改为与"序数推进"这条独立写法互证——它同样是"日历必须唯一"的可测形式。
     */
    let checked = 0;
    for (let docIndex = 0; docIndex < document.tasks.length; docIndex += 1) {
      const task = document.tasks[docIndex];
      if (task === undefined) continue;
      if (task.startDate === null || task.durationDays === null || task.durationDays <= 0) continue;
      const impl = derivedEndIso({ startIso: task.startDate, durationDays: task.durationDays, calendar });
      const crossCheck = isoOfOrdinalSafe(
        calendar,
        calendar.ordinalOfDay(dayOfIso(task.startDate)) + task.durationDays - 1,
      );
      expect(impl).toBe(crossCheck);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('零时长（里程碑）的派生完成 = 开始当天（不是"前一个工作日"）', () => {
    const { document, calendar } = fixture;
    const target = firstEditableLeaf(document);
    const task = document.tasks[target.docIndex];
    if (task === undefined || task.startDate === null) throw new Error('目标行缺失');
    expect(derivedEndIso({ startIso: task.startDate, durationDays: 0, calendar })).toBe(task.startDate);
  });
});

describe('值 → 命令映射的口径回归（G4 已有语义，迁入本包后必须不变）', () => {
  it('空文本清空字段（`null` 是"缺失"的唯一写法，ADR 0002）', () => {
    const { document, calendar } = fixture;
    const target = firstEditableLeaf(document);
    const asStart = editToCommand({ document, taskId: target.id, column: 'start', text: '  ', calendar });
    expect(asStart.ok && asStart.command.patch.startDate === null).toBe(true);
    const asEnd = editToCommand({ document, taskId: target.id, column: 'end', text: '', calendar });
    expect(asEnd.ok && asEnd.command.patch.endDate === null).toBe(true);
    const asNotes = editToCommand({ document, taskId: target.id, column: 'notes', text: '   ', calendar });
    expect(asNotes.ok && asNotes.command.patch.notes === null).toBe(true);
  });

  it('非法输入被拒绝且给出可读原因（不抛错）', () => {
    const { document, calendar } = fixture;
    const target = firstEditableLeaf(document);
    const cases: readonly { readonly column: 'start' | 'end' | 'duration' | 'progress' | 'milestone' | 'name'; readonly text: string }[] = [
      { column: 'start', text: '2026-13-01' },
      { column: 'end', text: '2026/10/05' },
      { column: 'duration', text: String(MAX_DURATION_DAYS + 1) },
      { column: 'duration', text: '-3' },
      { column: 'progress', text: '120%' },
      { column: 'milestone', text: '也许' },
      { column: 'name', text: '   ' },
    ];
    for (const item of cases) {
      const outcome = editToCommand({ document, taskId: target.id, column: item.column, text: item.text, calendar });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });

  it('未知任务被拒绝；`wbs` / `predecessors` 不可编辑', () => {
    const { document, calendar } = fixture;
    const missing = editToCommand({ document, taskId: '不存在', column: 'name', text: 'x', calendar });
    expect(missing.ok).toBe(false);
    const target = firstEditableLeaf(document);
    for (const column of ['wbs', 'predecessors'] as const) {
      const outcome = editToCommand({ document, taskId: target.id, column, text: '1', calendar });
      expect(outcome.ok).toBe(false);
    }
  });

  it('进度接受小数/百分数/带 `%`，里程碑接受中英文与 1/0', () => {
    const { document, calendar } = fixture;
    const target = firstEditableLeaf(document);
    const progress = editToCommand({ document, taskId: target.id, column: 'progress', text: '50%', calendar });
    expect(progress.ok && progress.command.patch.progress === 0.5).toBe(true);
    const milestone = editToCommand({ document, taskId: target.id, column: 'milestone', text: '是', calendar });
    expect(milestone.ok && milestone.command.patch.milestone === true).toBe(true);
  });

  it('折叠开关走同一条通道（`collapsed` 因此天然可撤销）', () => {
    const { document } = fixture;
    const summary = document.tasks.find((task) => task.durationDays === null && task.parentId === null);
    if (summary === undefined) throw new Error('夹具缺少汇总任务');
    const outcome = collapseToCommand({ document, taskId: summary.id });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.command.patch.collapsed).toBe(!summary.collapsed);
  });

  it('`parseIsoInput` 只接受真实存在的 `YYYY-MM-DD`（与导入同口径）', () => {
    expect(parseIsoInput('2026-10-05')).toBe('2026-10-05');
    expect(parseIsoInput(' 2026-10-05 ')).toBe('2026-10-05');
    expect(parseIsoInput('2026-02-30')).toBeUndefined();
    expect(parseIsoInput('2026-2-3')).toBeUndefined();
    expect(parseIsoInput('')).toBeUndefined();
  });
});

describe('本包不再持有任何无锚定的应用级日历（P-19 的根治）', () => {
  it('发布源里没有 `APP_CALENDAR` 这类固定锚点：日历一律是显式入参', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));

    /** 去掉块注释与行注释：文档里提到 `APP_CALENDAR`（讲历史缺陷）不算违规。 */
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const offenders: string[] = [];
    for (const entry of readdirSync(here)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      const code = stripComments(readFileSync(join(here, entry), 'utf8'));
      // 代码里出现"构造日历"或"默认锚点常量"即违规：日历必须由调用方传入。
      if (/APP_CALENDAR/.test(code)) offenders.push(`${entry}:APP_CALENDAR`);
      if (/new\s+Calendar\s*\(/.test(code)) offenders.push(`${entry}:new Calendar(`);
      if (/DEFAULT_PROJECT_BASE_DAY_ISO/.test(code)) offenders.push(`${entry}:DEFAULT_PROJECT_BASE_DAY_ISO`);
    }
    expect(offenders).toStrictEqual([]);
  });
});
