/**
 * 单元格文本、日期算术的**应用口径**与行内编辑的值→命令映射（P-19 的迁落点）；
 * 行内编辑的**基线文本与陈旧判定**（`rawCellText` / `isEditStale`，P-21 批次 C 的 R5）。
 *
 * ## 为什么这些函数必须在本包（P-19 §4.1/§5 的落地）
 *
 * 它们是**纯函数**（不碰 DOM / Vue），原先留在 `apps/web/{shared,edit}.ts`——
 * 而根 `vitest.config.ts` 的收集范围只覆盖 `packages/<包>/src` 下的 `*.spec.ts`，于是它们**不在门禁覆盖内**。
 * 代价已经真实发生一次：`apps/web` 用**未锚定**的 `APP_CALENDAR`（`baseDay` = 2025-01-01）解释
 * `Schedule` 的序号（序号相对 `createScheduleCalendar(document)`，演示数据是 2026-10-05），
 * 左表整列被搬到 2025 年、并出现"完成早于开始"；`derivedEndIso` 更会把错算的 `endDate`
 * **经命令层写进文档**（P-19 §1–§3）。
 *
 * 修法沿用 ADR 0007 §2 的「**落点即门禁**」：把可测的纯函数迁进 `packages`，
 * 它们就自动进 `pnpm test`，**零新增依赖、零新测试框架**。
 *
 * ## 唯一的日期口径
 *
 * **凡"只有日历能算"的量，一律显式收 `Calendar`**（与 `ordinalAtX(view, x, calendar)` 同手法）：
 * 序号 → 日期需要 `baseDay` 与 `exceptions`，用另一份日历就会得到另一次偏移。
 * 调用方必须传 `createScheduleCalendar(document)`——**与 `buildView` 用的是同一个日历**
 * （ADR 0007 §3）。本包**不再持有**任何无锚定的应用级日历（`APP_CALENDAR` 已删除）。
 *
 * 契约出处：P-19（`docs/00-baseline/裁决记录.md` 第十九轮）、ADR 0007 §3/§8、
 * `packages/engine/SCHEDULE.md` §四.2（`endDate` 是派生显示值）、ADR 0002（`null` = 缺失）。
 */

import {
  dayNumberToIsoDate,
  isoDateToDayNumber,
  MAX_DURATION_DAYS,
  type Calendar,
  type ProjectDocument,
  type Schedule,
  type TaskUpdateCommand,
} from '@ganttpilot/engine';

import { EDITABLE_COLUMNS, type ColumnKey } from './columns.js';

export { EDITABLE_COLUMNS };

/** 日序号 → ISO；非法输入返回 `undefined`（界面显示占位，不抛错）。 */
export function isoOfDaySafe(day: number): string | undefined {
  if (!Number.isFinite(day)) return undefined;
  try {
    return dayNumberToIsoDate(day);
  } catch {
    return undefined;
  }
}

/** ISO → 日序号；非法输入返回 `undefined`。 */
export function dayOfIsoSafe(iso: string | null | undefined): number | undefined {
  if (iso === null || iso === undefined || iso.trim() === '') return undefined;
  try {
    return isoDateToDayNumber(iso.trim());
  } catch {
    return undefined;
  }
}

/** 工作日序号 → ISO；非法输入返回 `undefined`（**唯一的序号翻译入口**）。 */
export function isoOfOrdinalSafe(calendar: Calendar, ordinal: number): string | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 0) return undefined;
  try {
    return isoOfDaySafe(calendar.dayOfOrdinal(ordinal));
  } catch {
    return undefined;
  }
}

/**
 * 解析用户输入的 ISO 日期；只有 `YYYY-MM-DD` 且真实存在才返回字符串。
 *
 * 用引擎的 `isoDateToDayNumber` 往返一次做校验——**不自己写正则**，
 * 这样"导入能识别的日期"与"行内编辑能接受的日期"不会分叉。
 */
export function parseIsoInput(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const day = dayOfIsoSafe(trimmed);
  if (day === undefined) return undefined;
  const normalized = isoOfDaySafe(day);
  if (normalized === undefined || normalized !== trimmed) return undefined;
  return normalized;
}

/** 解析工期（正整数工作日，含 0；越界按入参 `max` 拒绝）。 */
export function parseIntInput(
  text: string,
  options: { readonly min?: number; readonly max?: number } = {},
): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return undefined;
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) return undefined;
  return value;
}

/** 进度：接受 `0`–`1` 的小数或 `0`–`100` 的百分数文本；归一为 0–1。 */
export function parseProgressInput(text: string): number | undefined {
  const trimmed = text.trim().replace(/%$/, '');
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const ratio = value > 1 ? value / 100 : value;
  if (ratio > 1) return undefined;
  return Math.round(ratio * 100) / 100;
}

/** 百分比显示（`null` 显示空）。 */
export function formatProgress(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '';
  return `${String(Math.round(ratio * 100))}%`;
}

/**
 * 派生 `endDate`：`start` + 工期（**工作日**）的完成日显示值（`SCHEDULE.md` §四.2）。
 *
 * 与排程内核的工期解析**同口径**：`ef` 是**排他**结束序号，故"最后一个工作日"= `ef − 1`；
 * 这里的实现用 `addWorkdays` 推进 `durationDays` 个工作日再回退一个，与
 * `dayOfOrdinal(es + 工期 − 1)` 等价（`date.spec.ts` 的互证覆盖该等式）。
 *
 * 超过日历地平线返回 `undefined`——**调用方据此写 `null`**（宁可留空，也不写一个错的日期）。
 * 这也顺带消掉了 P-19 §6 的固定地平线脆弱点：日历由文档锚定，不再有"文档落在窗口外就静默留空"。
 */
export function derivedEndIso(args: {
  readonly startIso: string | null;
  readonly durationDays: number | null;
  readonly calendar: Calendar;
}): string | undefined {
  const { startIso, durationDays, calendar } = args;
  if (startIso === null || durationDays === null) return undefined;
  const startDay = dayOfIsoSafe(startIso);
  if (startDay === undefined) return undefined;
  if (durationDays <= 0) return startIso;
  try {
    const afterLastWorkday = calendar.addWorkdays(startDay, durationDays);
    return isoOfDaySafe(calendar.subtractWorkdays(afterLastWorkday, 1));
  } catch {
    return undefined;
  }
}

/** {@link cellText} 的入参。 */
export interface CellTextArgs {
  readonly key: ColumnKey;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  /** 文档序索引（`Schedule` 的索引约定）。 */
  readonly docIndex: number;
  /** **必须**是 `createScheduleCalendar(document)`（ADR 0007 §3）。 */
  readonly calendar: Calendar;
}

/**
 * 单元格显示值（只读呈现；不聚合任何派生量）。
 *
 * `start` / `end` 取**文档字段**：`end` 为空时显示派生显示值"开始 + 工期"，
 * 并加 `≈` 前缀提示它不是文档里的字段（`endDate` 是派生显示值，SCHEDULE.md §四.2）。
 *
 * ## 派生 `end` 必须与**显示的 `start`** 同源（`endDate` 派生口径）
 *
 * 一条真实的错位（P-19 的同类问题，由 `dateText.spec.ts` 判据 ① 在本轮抓出）：
 * 若"开始"列显示**文档** `startDate`，而"完成"列用**排程** `ef − 1`，两者可能出自两个起点
 * ——被入边推翻的文档日期（`dateOverridden`）或早于 `calendar.baseDay` 被截断的日期
 * （`clampedStart`）都会让左表出现"完成早于开始"，而**两列各自都是对的**。
 *
 * 因此派生分支改为：
 * `startOrdinal = (文档 startDate 的序号) ?? es` ⇒ `endOrdinal = startOrdinal + durationDays`
 * ⇒ `end = dayOfOrdinal(endOrdinal − 1)`。
 *
 * 这与引擎的语义**同构且不新造口径**：`ef = es + 解析工期`（SCHEDULE.md §九 不变量 1），
 * 而"文档日期被推导覆盖"时显示哪个序号，正是 `cellText('start')` 已经做出的选择
 * （它显示了文档日期）——完成列必须跟随它，而不是跟随另一个起点。
 * 汇总行不受影响：汇总没有工期，取 `summaryEf − 1`（引擎聚合的结果，没有"文档起始"可选）。
 */
export function cellText(args: CellTextArgs): { readonly text: string; readonly derived: boolean } {
  const task = args.document.tasks[args.docIndex];
  if (task === undefined) return { text: '', derived: false };
  const es = args.schedule.es[args.docIndex] ?? -1;
  const summaryEs = args.schedule.summaryEs[args.docIndex] ?? -1;
  const summaryEf = args.schedule.summaryEf[args.docIndex] ?? -1;
  const isSummary = es === -1;

  switch (args.key) {
    case 'wbs':
      return { text: task.outlineNumber, derived: true };
    case 'name':
      return { text: task.name, derived: false };
    case 'start': {
      if (isSummary) {
        return { text: isoOfOrdinalSafe(args.calendar, summaryEs) ?? '', derived: true };
      }
      if (task.startDate !== null) return { text: task.startDate, derived: false };
      return { text: isoOfOrdinalSafe(args.calendar, es) ?? '', derived: true };
    }
    case 'end': {
      if (isSummary) {
        // `summaryEf` 是排他结束序号 ⇒ 最后一个工作日是 `summaryEf − 1`。
        return { text: isoOfOrdinalSafe(args.calendar, summaryEf - 1) ?? '', derived: true };
      }
      if (task.endDate !== null) return { text: task.endDate, derived: false };
      if (task.durationDays === null) return { text: '', derived: true };
      // 与"开始"列同源：显示文档日期时从它推进，否则从排程序号推进（见文件头的口径说明）。
      const docDay = task.startDate === null ? undefined : dayOfIsoSafe(task.startDate);
      const startOrdinal = docDay === undefined ? es : args.calendar.ordinalOfDay(docDay);
      /**
       * **零时长（典型是里程碑）的完成 = 开始**，不是"前一个工作日"。
       *
       * 通用式 `startOrdinal + 工期 − 1` 在 `工期 = 0` 时退化为 `startOrdinal − 1`
       * ——于是里程碑会显示成"完成早于开始"（本轮实测 49 行，全部是 `durationDays: 0` 的里程碑）。
       * 这不引入新语义：`derivedEndIso` 在 `durationDays <= 0` 时同样返回 `startIso`
       * （`ef` 是排他序号，零时长任务的 `ef === es`），两侧口径由此一致。
       */
      if (task.durationDays <= 0) {
        const sameIso = docDay === undefined ? isoOfOrdinalSafe(args.calendar, es) : (task.startDate ?? '');
        return { text: sameIso === '' ? '' : `≈${sameIso}`, derived: true };
      }
      const iso = isoOfOrdinalSafe(args.calendar, startOrdinal + task.durationDays - 1);
      return { text: iso === undefined ? '' : `≈${iso}`, derived: true };
    }
    case 'duration':
      return { text: task.durationDays === null ? '' : String(task.durationDays), derived: false };
    case 'predecessors': {
      const text = args.document.links
        .filter((link) => link.to === task.id)
        .map((link) => {
          const from = args.document.tasks.find((item) => item.id === link.from);
          const lag =
            link.lagDays === 0 ? '' : link.lagDays > 0 ? `+${String(link.lagDays)}` : String(link.lagDays);
          return `${from?.outlineNumber ?? link.from}${link.type === 'FS' ? '' : link.type}${lag}`;
        })
        .join('; ');
      return { text, derived: true };
    }
    case 'progress':
      return { text: formatProgress(task.progress), derived: false };
    case 'milestone':
      return { text: task.milestone ? '是' : '否', derived: false };
    case 'notes':
      return { text: task.notes ?? '', derived: false };
    default:
      return { text: '', derived: false };
  }
}

/**
 * 该任务该列的**原始字段文本**（编辑态基线；与左表原先私有的 `rawOf` 逐值一致）。
 *
 * 与 {@link cellText} 的分工：`cellText` 是**显示值**（`end` 为空时给 `≈…` 的派生值、`wbs` 给
 * `outlineNumber`），本函数只读**文档字段本身**——行内编辑的草稿种子与它要改的字段都是"原始值"，
 * 因此"值是否真的变了"必须按原始值判（见 {@link isEditStale}）。
 *
 * - **任务不存在** ⇒ `undefined`（必须与"字段缺失"的 `''` 分开：前者要求结束编辑态）；
 * - **字段缺失**（`null`，ADR 0002）⇒ `''`；
 * - `wbs` / `predecessors` 没有原始字段（前者是派生值、后者归建线手势，ADR 0007 §8）⇒ `''`，
 *   它们本就不是编辑态的候选（入口由 `TABLE_COLUMNS.editable` 挡住）。
 */
export function rawCellText(args: {
  readonly document: ProjectDocument;
  readonly taskId: string;
  readonly column: ColumnKey;
}): string | undefined {
  const task = args.document.tasks.find((item) => item.id === args.taskId);
  if (task === undefined) return undefined;
  switch (args.column) {
    case 'name':
      return task.name;
    case 'start':
      return task.startDate ?? '';
    case 'end':
      return task.endDate ?? '';
    case 'duration':
      return task.durationDays === null ? '' : String(task.durationDays);
    case 'progress':
      return task.progress === null ? '' : String(task.progress);
    case 'milestone':
      return task.milestone ? '是' : '否';
    case 'notes':
      return task.notes ?? '';
    default:
      return '';
  }
}

/**
 * 编辑态是否**已陈旧**（`true` ⇒ 必须结束编辑态）：该任务该列的原始值在两个文档版本间真的变了。
 *
 * 本函数取代原先"**任何** `revision` 变化都关闭编辑态"（[P-21](../../../docs/00-baseline/裁决记录.md)
 * 的 R5）：后者让"编辑态优先"（ADR 0008 §10）事实上不成立——别的任务被拖动、别的列被改，
 * 都会把用户正在输入的草稿丢掉。判据只认"**该任务该列**"（不是"该任务"，也不是"整份文档"）。
 *
 * 任务消失（`task.remove` / 整份替换）同样算陈旧：`rawCellText` 返回 `undefined`。
 * 行被折叠隐藏或**滚出渲染窗口不算陈旧**（值没变）——草稿因此保留，行回来后输入框复活。
 */
export function isEditStale(args: {
  readonly before: ProjectDocument;
  readonly after: ProjectDocument;
  readonly taskId: string;
  readonly column: ColumnKey;
}): boolean {
  const pick = (document: ProjectDocument): string | undefined =>
    rawCellText({ document, taskId: args.taskId, column: args.column });
  return pick(args.before) !== pick(args.after);
}

/** 状态栏提示条（`apps/web` 的 `notice`）：`info` 是呈报、`error` 是失败。 */
export interface StatusNotice {
  readonly level: 'info' | 'error';
  readonly text: string;
}

/** 命令被拒绝时的提示文案（**唯一实现处**）。 */
export function rejectionNotice(result: {
  readonly code?: string;
  readonly message?: string;
}): StatusNotice {
  return { level: 'error', text: `命令被拒绝：${result.code ?? '未知'} —— ${result.message ?? ''}` };
}

/**
 * 命令派发后的提示条状态（P-21 批次 C 的 R5 + 裁决 P-30 的**唯一实现处**，进 `pnpm gate`）。
 *
 * 之所以要有这条纯规则：提示条是"**过去时**"的陈述，它**不得比它描述的事实活得更久**。
 * 三档逐条可判：
 *
 * - **失败** ⇒ 换成失败提示。这是提示**唯一**的产生时机——只有"尝试了但没成功"才报
 *   （因此"没有可撤销的步骤"只可能出现在"在栈底再回退"的那一次尝试之后）；
 * - **成功且真的改了**（`changed: true`，即状态前进了一步）⇒ **清掉失败提示**：那一步已经把它推翻
 *   （回退栈非空、文档已变）。`info` 是呈报，与成功无关，**不动**（由下一条 `show()` 替换）；
 * - **成功但没改**（`changed: false`，恒等 patch / 同位置调级）⇒ **原样保留**：状态没有前进，
 *   提示描述的事实可能仍然成立（空栈时改了个一样的值，栈里依然没有东西）。
 *
 * 由此得到维护者要求的不变量：**回退栈非空时不会挂着「没有可撤销的步骤」**；
 * **退回到栈底时也不会出现它**（那一步是成功的）；**只有"在栈底再回退"这一次尝试**才会产生它。
 */
export function noticeAfterDispatch(
  current: StatusNotice | null,
  result: {
    readonly ok: boolean;
    readonly changed: boolean;
    readonly code?: string;
    readonly message?: string;
  },
): StatusNotice | null {
  if (!result.ok) return rejectionNotice(result);
  if (!result.changed) return current;
  return current !== null && current.level === 'error' ? null : current;
}

/** 行内编辑的结果：要么一条命令，要么一个拒绝原因（不抛错，界面据此提示）。 */
export type EditOutcome =
  | { readonly ok: true; readonly command: EditCommand; readonly touchedTaskIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * `task.update` 命令的**形状**。
 *
 * 直接复用引擎的 `TaskUpdateCommand`：本模块只产出这一种命令，而用**引擎的类型**而不是
 * 在本包里再声明一份窄类型，是为了让"命令层只有一个真相源"在类型上也成立——
 * 顺带保证 `apps/web` 可以把它直接交给 `dispatch`（ADR 0003 的唯一通道不变）。
 */
export type EditCommand = TaskUpdateCommand;

/** {@link editToCommand} 的入参。 */
export interface EditToCommandArgs {
  readonly document: ProjectDocument;
  readonly taskId: string;
  readonly column: ColumnKey;
  readonly text: string;
  /** **必须**是 `createScheduleCalendar(document)`（`endDate` 的派生值由它翻译）。 */
  readonly calendar: Calendar;
}

/**
 * 由界面文本构造 `task.update`（行内编辑的**唯一**值→命令映射；ADR 0007 §8）。
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
export function editToCommand(args: EditToCommandArgs): EditOutcome {
  const task = args.document.tasks.find((item) => item.id === args.taskId);
  if (task === undefined) return { ok: false, reason: '任务不存在（文档已变化，请重试）' };
  const text = args.text;

  switch (args.column) {
    case 'name': {
      const name = text.trim();
      if (name === '') return { ok: false, reason: '任务名称不能为空' };
      return { ok: true, command: { kind: 'task.update', id: task.id, patch: { name } }, touchedTaskIds: [task.id] };
    }
    case 'start': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return {
          ok: true,
          command: { kind: 'task.update', id: task.id, patch: { startDate: null } },
          touchedTaskIds: [task.id],
        };
      }
      const iso = parseIsoInput(trimmed);
      if (iso === undefined) return { ok: false, reason: '日期格式应为 YYYY-MM-DD' };
      const end = derivedEndIso({ startIso: iso, durationDays: task.durationDays, calendar: args.calendar });
      return {
        ok: true,
        command: { kind: 'task.update', id: task.id, patch: { startDate: iso, endDate: end ?? null } },
        touchedTaskIds: [task.id],
      };
    }
    case 'end': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return {
          ok: true,
          command: { kind: 'task.update', id: task.id, patch: { endDate: null } },
          touchedTaskIds: [task.id],
        };
      }
      const iso = parseIsoInput(trimmed);
      if (iso === undefined) return { ok: false, reason: '日期格式应为 YYYY-MM-DD' };
      return {
        ok: true,
        command: { kind: 'task.update', id: task.id, patch: { endDate: iso } },
        touchedTaskIds: [task.id],
      };
    }
    case 'duration': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return {
          ok: true,
          command: { kind: 'task.update', id: task.id, patch: { durationDays: null, endDate: null } },
          touchedTaskIds: [task.id],
        };
      }
      const value = parseIntInput(trimmed, { min: 0, max: MAX_DURATION_DAYS });
      if (value === undefined) {
        return { ok: false, reason: `工期应是 0–${String(MAX_DURATION_DAYS)} 的整数（工作日）` };
      }
      const end = derivedEndIso({ startIso: task.startDate, durationDays: value, calendar: args.calendar });
      return {
        ok: true,
        command: { kind: 'task.update', id: task.id, patch: { durationDays: value, endDate: end ?? null } },
        touchedTaskIds: [task.id],
      };
    }
    case 'progress': {
      const trimmed = text.trim();
      if (trimmed === '') {
        return {
          ok: true,
          command: { kind: 'task.update', id: task.id, patch: { progress: null } },
          touchedTaskIds: [task.id],
        };
      }
      const ratio = parseProgressInput(trimmed);
      if (ratio === undefined) return { ok: false, reason: '进度应是 0–100 的整数/百分数，或 0–1 的小数' };
      return {
        ok: true,
        command: { kind: 'task.update', id: task.id, patch: { progress: ratio } },
        touchedTaskIds: [task.id],
      };
    }
    case 'milestone': {
      const normalized = text.trim().toLowerCase();
      const yes = ['是', 'y', 'yes', 'true', '1'].includes(normalized);
      const no = ['否', 'n', 'no', 'false', '0'].includes(normalized);
      if (!yes && !no) return { ok: false, reason: '里程碑填「是」或「否」' };
      return {
        ok: true,
        command: { kind: 'task.update', id: task.id, patch: { milestone: yes } },
        touchedTaskIds: [task.id],
      };
    }
    case 'notes': {
      const notes = text.trim() === '' ? null : text;
      return {
        ok: true,
        command: { kind: 'task.update', id: task.id, patch: { notes } },
        touchedTaskIds: [task.id],
      };
    }
    default:
      return { ok: false, reason: '该列不可编辑（只有 task.update 的入口）' };
  }
}

/** 折叠/展开也走同一条通道（因此天然可撤销）。 */
export function collapseToCommand(args: {
  readonly document: ProjectDocument;
  readonly taskId: string;
}): EditOutcome {
  const task = args.document.tasks.find((item) => item.id === args.taskId);
  if (task === undefined) return { ok: false, reason: '任务不存在' };
  return {
    ok: true,
    command: { kind: 'task.update', id: task.id, patch: { collapsed: !task.collapsed } },
    touchedTaskIds: [task.id],
  };
}
