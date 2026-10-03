/**
 * 行内编辑：界面输入 → `task.update` 命令（ADR 0007 §8 的"只走命令层唯一通道"）。
 *
 * ## 为什么单独一个模块
 *
 * - **值到命令的映射是一处**：`TaskTable` 只负责"收集文本"，命令构造全在这里；
 * - **日期算术只经引擎**（CONTRIBUTING 铁律）：`endDate` 是派生显示值
 *   （SCHEDULE.md §四.2），改 `start`/`duration` 时用 `APP_CALENDAR` 的工作日语义重算，
 *   **不自己写日期算术**；
 * - **纯函数**：给定文档 + 输入 ⇒ 命令或一个明确的拒绝原因（界面据此保留编辑态让用户改）。
 */

import { applyCommand, MAX_DURATION_DAYS, type DocumentCommand, type ProjectDocument } from '@ganttpilot/render-core';
import type { ColumnKey } from '@ganttpilot/xlsx-protocol';

import { APP_CALENDAR, dayOfIsoSafe, isoOfDaySafe, parseIsoInput, parseIntInput, parseProgressInput } from './shared.js';

/** 行内编辑的结果：要么一条命令，要么一个拒绝原因（不抛错，界面据此提示）。 */
export type EditOutcome =
  | { readonly ok: true; readonly command: DocumentCommand; readonly touchedTaskIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** 可在左表直接编辑的列（其余列只读：`wbs` 是派生值、`predecessors` 归 G5 的建线）。 */
export const EDITABLE_COLUMNS: readonly ColumnKey[] = [
  'name',
  'start',
  'end',
  'duration',
  'progress',
  'milestone',
  'notes',
];

/**
 * 由界面文本构造 `task.update`。
 *
 * 口径逐列：
 * - `name`：非空（空名不提交——导出口径同样不允许空名，ADR 0006 §4）；
 * - `start`：合法 ISO 或空（空 ⇒ `null`）；同时把**派生** `endDate` 重算提交，避免陈旧；
 * - `end`：合法 ISO 或空（清空 ⇒ `null`，回到"派生显示值"路径）；
 * - `duration`：非负整数、`≤ MAX_DURATION_DAYS`，或空（`null` = 未指定）；同时重算 `endDate`；
 * - `progress`：`0–1` 小数、`0–100` 百分数或 `NN%`，或空（`null` = 未知）；
 * - `milestone`：`是/否`、`true/false`、`1/0`；
 * - `notes`：原样（空 ⇒ `null`）。
 */
export function editToCommand(args: {
  readonly document: ProjectDocument;
  readonly taskId: string;
  readonly column: ColumnKey;
  readonly text: string;
}): EditOutcome {
  const task = args.document.tasks.find((item) => item.id === args.taskId);
  if (task === undefined) return { ok: false, reason: '任务不存在（文档已变化，请重试）' };
  const text = args.text;

  switch (args.column) {
    case 'name': {
      const name = text.trim();
      if (name === '') return { ok: false, reason: '任务名称不能为空' };
      return commandOf({ kind: 'task.update', id: task.id, patch: { name } }, task.id);
    }    case 'start': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return commandOf({ kind: 'task.update', id: task.id, patch: { startDate: null } }, task.id);
      }
      const iso = parseIsoInput(trimmed);
      if (iso === undefined) return { ok: false, reason: '日期格式应为 YYYY-MM-DD' };
      const end = derivedEndIso(iso, task.durationDays);
      return commandOf(
        { kind: 'task.update', id: task.id, patch: { startDate: iso, endDate: end ?? null } },
        task.id,
      );
    }
    case 'end': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return commandOf({ kind: 'task.update', id: task.id, patch: { endDate: null } }, task.id);
      }
      const iso = parseIsoInput(trimmed);
      if (iso === undefined) return { ok: false, reason: '日期格式应为 YYYY-MM-DD' };
      return commandOf({ kind: 'task.update', id: task.id, patch: { endDate: iso } }, task.id);
    }
    case 'duration': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return commandOf({ kind: 'task.update', id: task.id, patch: { durationDays: null, endDate: null } }, task.id);
      }
      const value = parseIntInput(trimmed, { min: 0, max: MAX_DURATION_DAYS });
      if (value === undefined) {
        return { ok: false, reason: `工期应是 0–${String(MAX_DURATION_DAYS)} 的整数（工作日）` };
      }
      const end = derivedEndIso(task.startDate, value);
      return commandOf(
        { kind: 'task.update', id: task.id, patch: { durationDays: value, endDate: end ?? null } },
        task.id,
      );
    }
    case 'progress': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return commandOf({ kind: 'task.update', id: task.id, patch: { progress: null } }, task.id);
      }
      const ratio = parseProgressInput(trimmed);
      if (ratio === undefined) return { ok: false, reason: '进度应是 0–100 的整数/百分数，或 0–1 的小数' };
      return commandOf({ kind: 'task.update', id: task.id, patch: { progress: ratio } }, task.id);
    }
    case 'milestone': {
      const normalized = text.trim().toLowerCase();
      const yes = ['是', 'y', 'yes', 'true', '1'].includes(normalized);
      const no = ['否', 'n', 'no', 'false', '0'].includes(normalized);
      if (!yes && !no) return { ok: false, reason: '里程碑填「是」或「否」' };
      return commandOf({ kind: 'task.update', id: task.id, patch: { milestone: yes } }, task.id);
    }
    case 'notes': {
      const notes = text.trim() === '' ? null : text;
      return commandOf({ kind: 'task.update', id: task.id, patch: { notes } }, task.id);
    }
    default:
      return { ok: false, reason: '该列不可编辑（G4 只提供 task.update 的入口）' };
  }
}

/** 折叠/展开也走同一条通道（因此天然可撤销）。 */
export function collapseToCommand(args: {
  readonly document: ProjectDocument;
  readonly taskId: string;
}): EditOutcome {
  const task = args.document.tasks.find((item) => item.id === args.taskId);
  if (task === undefined) return { ok: false, reason: '任务不存在' };
  return commandOf({ kind: 'task.update', id: task.id, patch: { collapsed: !task.collapsed } }, task.id);
}

function commandOf(command: DocumentCommand, touchedTaskId: string): EditOutcome {
  // 命令形状与 schema 由 `applyCommand` 复用校验（本层不复制规则，ADR 0003 ⑤）。
  void applyCommand;
  return { ok: true, command, touchedTaskIds: [touchedTaskId] };
}

/**
 * 派生 `endDate`：`start` + 工期（**工作日**）的完成日显示值。
 *
 * 用 `APP_CALENDAR` 的工作日推进（`addWorkdays` / `subtractWorkdays`），
 * 因此与排程内核的工期解析同口径（SCHEDULE.md §四.2）；超过地平线返回 `undefined`，
 * 调用方据此写 `null`（宁可留空，也不写一个错的日期）。
 */
export function derivedEndIso(startIso: string | null, durationDays: number | null): string | undefined {
  if (startIso === null || durationDays === null) return undefined;
  const startDay = dayOfIsoSafe(startIso);
  if (startDay === undefined) return undefined;
  if (durationDays <= 0) return startIso;
  try {
    const afterLastWorkday = APP_CALENDAR.addWorkdays(startDay, durationDays);
    return isoOfDaySafe(APP_CALENDAR.subtractWorkdays(afterLastWorkday, 1));
  } catch {
    return undefined;
  }
}
