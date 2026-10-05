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

import { applyCommand, applyToSession, compute, createSession, DEFAULT_PROJECT_BASE_DAY_ISO, isoDateToDayNumber, MAX_DURATION_DAYS, undoSession, type DocumentCommand, type ProjectDocument } from '@ganttpilot/engine';

import { createScheduleCalendar } from './index.js';
import { buildTextFixture, unanchoredCalendar } from './textFixtures.spec.js';
import type { ColumnKey } from './columns.js';
import {
  collapseToCommand,
  derivedEndIso,
  editToCommand,
  isEditStale,
  isoOfOrdinalSafe,
  noticeAfterDispatch,
  parseIsoInput,
  rawCellText,
} from './viewText.js';

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

  it('**里程碑的工期恒为 0**（P-43）：改工期被拒绝并给出可执行的出口，而不是产出"图/表不一致"的命令', () => {
    const { document, calendar } = fixture;
    const milestone = document.tasks.find((task) => task.milestone);
    expect(milestone).toBeDefined();
    if (milestone === undefined) return;
    for (const text of ['3', '1', '0', '']) {
      const outcome = editToCommand({ document, taskId: milestone.id, column: 'duration', text, calendar });
      // 连"清空"也拒绝：里程碑的工期是语义的一部分，没有"未指定"这个状态可用。
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain('里程碑');
    }
    // **出口是可执行的**：先在「里程碑」列解除标记（`milestone: false`），再改工期就通过。
    const unflagged = {
      ...document,
      tasks: document.tasks.map((task) => (task.id === milestone.id ? { ...task, milestone: false } : task)),
    };
    const after = editToCommand({ document: unflagged, taskId: milestone.id, column: 'duration', text: '3', calendar });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.command.patch.durationDays).toBe(3);
    // **负向对照**：把守卫去掉（直接走原分支）会产出 `{durationDays: 3, endDate}` ——
    // 而那份文档在文档层带 `TASK_MILESTONE_WITH_DURATION` warning（"里程碑的 durationDays 应为 0"），
    // 图形层仍按 `milestone` 画菱形 ⇒ 三方不一致。判据必须拦住它。
    expect(milestone.milestone).toBe(true);
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

/**
 * P-21 批次 C（R5）：**编辑态"该任务该列的值真的变了才取消"**——进 `pnpm gate`。
 *
 * 缺陷本体（P-21 §2 的 R5）：`TaskTable` 原先 `watch(revision) → cancelEdit()`，
 * 于是**任何**版本变化都会把用户正在输入的草稿丢掉，"编辑态优先"（ADR 0008 §10）事实上不成立；
 * 而这条判定**此前没有任何判据**（`apps/web` 不在 `vitest.config.ts` 的收集范围内）。
 *
 * 因此可判定的部分落进本包：`rawCellText`（该任务该列的**原始字段**文本，替代左表私有的 `rawOf`）
 * 与 `isEditStale`（两个版本间"真的变了"才为真）。DOM 层（输入框是否真的还在）仍只能人工验。
 */
describe('P-21 批次 C（R5）：编辑态"该任务该列的值真的变了才取消"', () => {
  const { document, calendar, schedule } = fixture;
  const target = firstEditableLeaf(document);
  const targetTask = document.tasks[target.docIndex];
  if (targetTask === undefined) throw new Error('目标行缺失');
  const other = document.tasks.find((task) => task.id !== target.id);
  if (other === undefined) throw new Error('夹具里没有第二个任务');

  /** 应用一条命令并断言它真的改了文档（否则"没变"与"改了"无法区分，用例会变成恒真式）。 */
  function applyChecked(base: ProjectDocument, command: DocumentCommand): ProjectDocument {
    const result = applyCommand(base, command);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.changed).toBe(true);
    return result.document;
  }

  const staleOf = (before: ProjectDocument, after: ProjectDocument, column: ColumnKey): boolean =>
    isEditStale({ before, after, taskId: target.id, column });

  it('`rawCellText` 逐列取**原始字段**（与左表原先的 `rawOf` 同值，`null` ⇒ 空串）', () => {
    const pick = (column: ColumnKey): string | undefined =>
      rawCellText({ document, taskId: target.id, column });
    expect(pick('name')).toBe(targetTask.name);
    expect(pick('start')).toBe(targetTask.startDate ?? '');
    expect(pick('end')).toBe(targetTask.endDate ?? '');
    expect(pick('duration')).toBe(targetTask.durationDays === null ? '' : String(targetTask.durationDays));
    expect(pick('progress')).toBe(targetTask.progress === null ? '' : String(targetTask.progress));
    expect(pick('milestone')).toBe(targetTask.milestone ? '是' : '否');
    expect(pick('notes')).toBe(targetTask.notes ?? '');
    // 字段缺失是 `''`（不是 `undefined`）——两类"没有值"必须分得开，见下一条。
    expect(pick('notes')).toBe(targetTask.notes ?? '');
  });

  it('任务不存在 ⇒ `undefined`；派生列没有原始字段 ⇒ 空串（两者必须分得开）', () => {
    const missing = rawCellText({ document, taskId: '不存在', column: 'name' });
    expect(missing).toBeUndefined();
    expect(rawCellText({ document, taskId: target.id, column: 'wbs' })).toBe('');
    expect(rawCellText({ document, taskId: target.id, column: 'predecessors' })).toBe('');
  });

  it('**别的任务**变了 ⇒ 不陈旧（R5 的正面判据：这就是原先会丢草稿的场景）', () => {
    const after = applyChecked(document, { kind: 'task.update', id: other.id, patch: { notes: '外部改动' } });
    expect(staleOf(document, after, 'notes')).toBe(false);
  });

  it('同一任务**别的列**变了 ⇒ 不陈旧（判据只认"该任务该列"）', () => {
    const after = applyChecked(document, { kind: 'task.update', id: target.id, patch: { notes: '外部改动' } });
    expect(staleOf(document, after, 'duration')).toBe(false);
  });

  it('该任务**该列**真的变了 ⇒ 陈旧（文本列与日期列各一条）', () => {
    const renamed = applyChecked(document, { kind: 'task.update', id: target.id, patch: { name: '改名了' } });
    expect(staleOf(document, renamed, 'name')).toBe(true);

    const moved = isoOfOrdinalSafe(calendar, (schedule.es[target.docIndex] ?? 0) + 3);
    expect(moved).toBeDefined();
    if (moved === undefined) return;
    expect(moved).not.toBe(targetTask.startDate);
    const shifted = applyChecked(document, { kind: 'task.update', id: target.id, patch: { startDate: moved } });
    expect(staleOf(document, shifted, 'start')).toBe(true);
  });

  it('任务消失（`task.remove`）⇒ 陈旧（`undefined` ≠ 旧值）', () => {
    const removed = applyChecked(document, { kind: 'task.remove', id: target.id });
    expect(rawCellText({ document: removed, taskId: target.id, column: 'name' })).toBeUndefined();
    expect(staleOf(document, removed, 'name')).toBe(true);
  });

  it('改回原值 ⇒ 不陈旧（比的是两个版本的值，不是版本号）', () => {
    const bumped = applyChecked(document, {
      kind: 'task.update',
      id: target.id,
      patch: { durationDays: 9, endDate: null },
    });
    expect(staleOf(document, bumped, 'duration')).toBe(true);
    const restored = applyChecked(bumped, {
      kind: 'task.update',
      id: target.id,
      patch: { durationDays: targetTask.durationDays, endDate: targetTask.endDate },
    });
    expect(staleOf(document, restored, 'duration')).toBe(false);
  });

  it('前提自证：恒等 patch 的 `applyCommand` 必须 `changed === false`（否则"无关变化"没有载体）', () => {
    const identity = applyCommand(document, {
      kind: 'task.update',
      id: target.id,
      patch: { durationDays: targetTask.durationDays },
    });
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.changed).toBe(false);
  });

  /**
   * 负向对照：把**同一批场景**交给两个"变造实现"，断言它们与正确实现**必然分叉**
   * （手法同 `dateTextNegative.spec.ts`：判据必须自带牙齿，否则可能只是恒真式）。
   */
  it('NC1：忽略 `column`（只比"这个任务"）的变造实现必须被检出', () => {
    const staleByWholeTask = (before: ProjectDocument, after: ProjectDocument): boolean => {
      const pick = (document: ProjectDocument): string =>
        JSON.stringify(document.tasks.find((task) => task.id === target.id) ?? null);
      return pick(before) !== pick(after);
    };
    const after = applyChecked(document, { kind: 'task.update', id: target.id, patch: { notes: '外部改动' } });
    expect(staleOf(document, after, 'duration')).toBe(false); // 正确实现：编辑 duration，notes 变了不算
    expect(staleByWholeTask(document, after)).toBe(true); // 变造实现：整个任务变了 ⇒ 误判为陈旧
  });

  it('NC2：旧规则「任何版本不同即陈旧」必须被检出', () => {
    const staleByAnyRevision = (before: ProjectDocument, after: ProjectDocument): boolean => before !== after;
    const after = applyChecked(document, { kind: 'task.update', id: other.id, patch: { notes: '外部改动' } });
    expect(staleOf(document, after, 'notes')).toBe(false); // 正确实现：别的任务变了不算
    expect(staleByAnyRevision(document, after)).toBe(true); // 旧规则：任何版本变化都关闭编辑态
  });
});

/**
 * P-30（收口 P-29）：**提示条的迁移**——进 `pnpm gate`。
 *
 * 维护者的人工复验报文（2026-10-04）：「提示出现 → 修改 → 提示不消失」；期望「提示出现 → 修改 → 提示消失」，
 * 即**回退栈不为空时提示不应出现**，**退回到栈底时也不应出现**，**只有在栈底尝试回退时**才给提示。
 * 这就是"提示不得比它描述的事实活得更久"——原先的窄口径（只认成功的 `undo()`/`redo()` 清提示）不满足它。
 */
describe('P-30：提示条的迁移（成功清失败、失败才产生、无操作照旧）', () => {
  const { document } = fixture;
  const target = firstEditableLeaf(document);
  const info = { level: 'info' as const, text: '正在导入 x.zip…' };

  it('失败 ⇒ 产生失败提示（提示唯一的产生时机），文案带 code 与 message', () => {
    const notice = noticeAfterDispatch(null, { ok: false, changed: false, code: 'SESSION_NOTHING_TO_UNDO', message: '没有可撤销的步骤' });
    expect(notice?.level).toBe('error');
    expect(notice?.text).toBe('命令被拒绝：SESSION_NOTHING_TO_UNDO —— 没有可撤销的步骤');
    expect(noticeAfterDispatch(null, { ok: false, changed: false })?.text).toContain('未知');
  });

  it('成功且**真的改了** ⇒ 清掉失败提示（维护者报文的那一条）', () => {
    const failure = { level: 'error' as const, text: '命令被拒绝：SESSION_NOTHING_TO_UNDO —— 没有可撤销的步骤' };
    expect(noticeAfterDispatch(failure, { ok: true, changed: true })).toBeNull();
  });

  it('成功且真的改了，但当前是 `info` ⇒ 不动（呈报不该被无关操作抹掉）', () => {
    expect(noticeAfterDispatch(info, { ok: true, changed: true })).toBe(info);
  });

  it('成功但**没改**（恒等 patch）⇒ 原样保留：状态没有前进，提示的事实可能仍成立', () => {
    const failure = { level: 'error' as const, text: '命令被拒绝：SESSION_NOTHING_TO_UNDO —— 没有可撤销的步骤' };
    expect(noticeAfterDispatch(failure, { ok: true, changed: false })).toBe(failure);
    expect(noticeAfterDispatch(null, { ok: true, changed: false })).toBeNull();
  });

  it('用**真实会话栈**跑维护者的三步序列：栈底回退失败 → 修改 → 提示消失；再回退到栈底也不出现', () => {
    let session = createSession(document);
    const asResult = (outcome: { ok: boolean; changed?: boolean; code?: string; message?: string }) => ({
      ok: outcome.ok,
      changed: outcome.changed ?? false,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    });

    // ① 空栈时回退 ⇒ 失败提示
    let notice = noticeAfterDispatch(null, asResult(undoSession(session)));
    expect(notice?.text).toContain('SESSION_NOTHING_TO_UNDO');

    // ② 修改（成功）⇒ **提示消失**（报文里"未解决"的那一步）
    const applied = applyToSession(session, { kind: 'task.update', id: target.id, patch: { notes: '改一下' } });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    session = applied.session;
    notice = noticeAfterDispatch(notice, asResult(applied));
    expect(notice).toBeNull();

    // ③ 回退到栈底 ⇒ 成功、不出提示
    const undone = undoSession(session);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    session = undone.session;
    notice = noticeAfterDispatch(notice, asResult(undone));
    expect(notice).toBeNull();

    // ④ 再在栈底尝试回退 ⇒ 才重新给提示
    notice = noticeAfterDispatch(notice, asResult(undoSession(session)));
    expect(notice?.text).toContain('SESSION_NOTHING_TO_UNDO');
  });
});
