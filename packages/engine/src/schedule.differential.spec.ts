import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type Calendar } from './date.js';
import { LEAF_SENTINEL, compute, type Schedule, type ScheduleDiagnostic } from './schedule.js';
import { SCHEDULE_CALENDARS, generateProject, makeCalendar, type GeneratedProject } from './scheduleFixtures.spec.js';

/**
 * **跨语言差分**（R-4 / ADR 0004 §9 的第三层证据）：
 * Node 生成随机项目 → 落盘 JSON → 调用**独立 Python 参照实现**
 * （[`tools/cpm-reference/cpm_reference.py`](../../../tools/cpm-reference/cpm_reference.py)）→ 逐字段比对。
 *
 * 三条不可退让的口径：
 * 1. **缺 Python 3 就失败，不静默跳过**（Windows 上 `python` 可能是 `.bat` 垫片、
 *    `spawnSync` 返回 **9009** 而不是 `ENOENT`，是 S3 §五.7 实测过的真实风险）；
 * 2. **走文件进出**（不是 stdio 管道）：可复算、可调试，中间产物落 `tmp/diff/`（已 gitignore）；
 * 3. **随机种子固定并随失败信息打印**（否则复现要靠猜）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const referenceScript = join(repoRoot, 'tools', 'cpm-reference', 'cpm_reference.py');
const outDir = join(repoRoot, 'tmp', 'diff');

/** 差分配置（与 S3 的 `DIFFERENTIAL_CONFIG` 同量级、同量纲）。 */
const DIFFERENTIAL_CONFIG = {
  /** 随机 DAG 项目数（门禁：≥1,000）。 */
  projects: 1000,
  /** 成环图数量（门禁：200）。 */
  cyclicProjects: 200,
  minTasks: 5,
  maxTasks: 200,
  maxDuration: 8,
  maxLag: 3,
  milestoneRatio: 0.05,
  seedBase: 770_000,
} as const;

/** 日历 `baseDay` 相对"文档最早日期"的三种偏移：0 / 更早 30 天 / 更晚 3 天（触发早日期截断）。 */
const BASE_DAY_OFFSETS = [0, -30, 3] as const;

interface Snapshot {
  readonly hasCycle: boolean;
  readonly taskCount: number;
  readonly es: readonly number[];
  readonly ef: readonly number[];
  readonly anchored: readonly number[];
  readonly driven: readonly number[];
  readonly summaryEs: readonly number[];
  readonly summaryEf: readonly number[];
  readonly summaryProgress: readonly (number | null)[];
  readonly milestoneCount: number;
  readonly projectStart: number;
  readonly projectFinish: number;
  readonly clampedStarts: number;
  readonly esIso: readonly (string | null)[];
  readonly efIso: readonly (string | null)[];
  /** 归一化后的诊断键（`code|taskId|linkId`，**排序后**——诊断顺序不在契约里）。 */
  readonly diagnostics: readonly string[];
}

export interface DifferentialMismatch {
  readonly project: string;
  readonly field: string;
  readonly detail: string;
}

function projectSpec(index: number, cyclic: boolean): GeneratedProject {
  const { minTasks, maxTasks, maxDuration, maxLag, milestoneRatio, seedBase } = DIFFERENTIAL_CONFIG;
  const span = maxTasks - minTasks + 1;
  const taskCount = minTasks + ((index * 7) % span);
  return generateProject({
    id: `diff-${cyclic ? 'cyc' : 'dag'}-${String(index)}`,
    seed: seedBase + index,
    taskCount,
    linkCount: Math.max(taskCount - 1, Math.floor(taskCount * 1.6)),
    maxDuration,
    maxLag,
    milestoneRatio,
    cyclic,
    calendarIndex: index % SCHEDULE_CALENDARS.length,
    baseDayOffset: BASE_DAY_OFFSETS[index % BASE_DAY_OFFSETS.length]!,
    // 每个项目都带层级与留位字段（覆盖汇总聚合与 `constraintsUnused`）。
    hierarchyRatio: index % 2 === 0 ? 0.18 : 0.05,
  });
}

function normalizeProgress(value: number): number | null {
  return Number.isNaN(value) ? null : value;
}

/** 本侧（TS 内核）的投影。 */
function snapshotOfSchedule(schedule: Schedule, calendar: Calendar): Snapshot {
  const iso = (ordinals: Int32Array): (string | null)[] =>
    Array.from(ordinals, (ordinal) => (ordinal < 0 ? null : calendar.isoOfOrdinal(ordinal)));
  return {
    hasCycle: false,
    taskCount: schedule.taskCount,
    es: Array.from(schedule.es),
    ef: Array.from(schedule.ef),
    anchored: Array.from(schedule.anchored),
    driven: Array.from(schedule.driven),
    summaryEs: Array.from(schedule.summaryEs),
    summaryEf: Array.from(schedule.summaryEf),
    summaryProgress: Array.from(schedule.summaryProgress, normalizeProgress),
    milestoneCount: schedule.milestoneCount,
    projectStart: schedule.projectStart,
    projectFinish: schedule.projectFinish,
    clampedStarts: schedule.clampedStarts,
    esIso: iso(schedule.es),
    efIso: iso(schedule.ef),
    diagnostics: schedule.diagnostics
      .map((entry: ScheduleDiagnostic) => `${entry.code}|${entry.taskId ?? ''}|${entry.linkId ?? ''}`)
      .sort(),
  };
}

interface ReferenceResult {
  readonly id?: string;
  readonly hasCycle: boolean;
  readonly taskCount?: number;
  readonly es?: readonly number[];
  readonly ef?: readonly number[];
  readonly anchored?: readonly number[];
  readonly driven?: readonly number[];
  readonly summaryEs?: readonly number[];
  readonly summaryEf?: readonly number[];
  readonly summaryProgress?: readonly (number | null)[];
  readonly milestoneCount?: number;
  readonly projectStart?: number;
  readonly projectFinish?: number;
  readonly clampedStarts?: number;
  readonly esIso?: readonly (string | null)[];
  readonly efIso?: readonly (string | null)[];
  readonly diagnostics?: readonly { readonly code: string; readonly taskId: string | null; readonly linkId: string | null }[];
}

/** 参照实现侧的投影（成环时只有 id/hasCycle）。 */
function snapshotOfReference(result: ReferenceResult): Snapshot {
  const numbers = (value: readonly number[] | undefined): number[] => (value === undefined ? [] : [...value]);
  return {
    hasCycle: result.hasCycle,
    taskCount: result.taskCount ?? 0,
    es: numbers(result.es),
    ef: numbers(result.ef),
    anchored: numbers(result.anchored),
    driven: numbers(result.driven),
    summaryEs: numbers(result.summaryEs),
    summaryEf: numbers(result.summaryEf),
    summaryProgress: (result.summaryProgress ?? []).map((value) =>
      value === null ? null : normalizeProgress(value),
    ),
    milestoneCount: result.milestoneCount ?? 0,
    projectStart: result.projectStart ?? 0,
    projectFinish: result.projectFinish ?? 0,
    clampedStarts: result.clampedStarts ?? 0,
    esIso: result.esIso === undefined ? [] : [...result.esIso],
    efIso: result.efIso === undefined ? [] : [...result.efIso],
    diagnostics: (result.diagnostics ?? [])
      .map((entry) => `${entry.code}|${entry.taskId ?? ''}|${entry.linkId ?? ''}`)
      .sort(),
  };
}

/**
 * 逐项比对一列**标量**（数字，或 `esIso` / `efIso` 这类 ISO 文本）。
 *
 * `tolerance === null` ⇒ **严格相等**（ISO 文本走这条）；给了容差则要求两侧都是数字——
 * 任一侧不是数字时**如实记为不一致**，而不是让 `Math.abs(NaN) > t`（恒为 `false`）把
 * "看起来在比、其实没比"变成静默判等。
 *
 * P3/C7-b：原签名只接受数字数组，而它同时被用来比 ISO 文本（类型不诚实；`null` 容差下
 * 恰好仍然正确，因此这条不对称一直没人发现）。
 */
function compareScalarArrays(
  mismatches: DifferentialMismatch[],
  project: string,
  field: string,
  ours: readonly (number | string | null)[],
  theirs: readonly (number | string | null)[],
  tolerance: number | null,
): void {
  if (ours.length !== theirs.length) {
    mismatches.push({
      project,
      field,
      detail: `长度不一致：内核 ${String(ours.length)} vs 参照 ${String(theirs.length)}`,
    });
    return;
  }
  for (let i = 0; i < ours.length; i += 1) {
    const a = ours[i] ?? null;
    const b = theirs[i] ?? null;
    if (a === null || b === null) {
      if (a !== b) {
        mismatches.push({ project, field: `${field}[${String(i)}]`, detail: `内核 ${String(a)} vs 参照 ${String(b)}` });
        return;
      }
      continue;
    }
    const equal =
      tolerance === null
        ? a === b
        : typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance;
    if (!equal) {
      mismatches.push({ project, field: `${field}[${String(i)}]`, detail: `内核 ${String(a)} vs 参照 ${String(b)}` });
      return;
    }
  }
}

/** 逐字段比对两个投影；返回全部不一致（**这是判据本体，有负向对照**）。 */
export function compareSnapshots(ours: Snapshot, theirs: Snapshot, project: string): readonly DifferentialMismatch[] {
  const mismatches: DifferentialMismatch[] = [];
  if (ours.hasCycle !== theirs.hasCycle) {
    mismatches.push({
      project,
      field: 'hasCycle',
      detail: `内核 ${String(ours.hasCycle)} vs 参照 ${String(theirs.hasCycle)}`,
    });
    return mismatches;
  }
  if (ours.hasCycle) {
    return mismatches;
  }

  compareScalarArrays(mismatches, project, 'es', ours.es, theirs.es, null);
  compareScalarArrays(mismatches, project, 'ef', ours.ef, theirs.ef, null);
  compareScalarArrays(mismatches, project, 'anchored', ours.anchored, theirs.anchored, null);
  compareScalarArrays(mismatches, project, 'driven', ours.driven, theirs.driven, null);
  compareScalarArrays(mismatches, project, 'summaryEs', ours.summaryEs, theirs.summaryEs, null);
  compareScalarArrays(mismatches, project, 'summaryEf', ours.summaryEf, theirs.summaryEf, null);
  compareScalarArrays(mismatches, project, 'summaryProgress', ours.summaryProgress, theirs.summaryProgress, 1e-9);
  compareScalarArrays(mismatches, project, 'esIso', ours.esIso, theirs.esIso, null);
  compareScalarArrays(mismatches, project, 'efIso', ours.efIso, theirs.efIso, null);

  for (const field of ['taskCount', 'milestoneCount', 'projectStart', 'projectFinish', 'clampedStarts'] as const) {
    if (ours[field] !== theirs[field]) {
      mismatches.push({
        project,
        field,
        detail: `内核 ${String(ours[field])} vs 参照 ${String(theirs[field])}`,
      });
    }
  }

  if (ours.diagnostics.length !== theirs.diagnostics.length) {
    mismatches.push({
      project,
      field: 'diagnostics',
      detail:
        `条数不一致：内核 ${String(ours.diagnostics.length)} 条 ${JSON.stringify(ours.diagnostics)} vs ` +
        `参照 ${String(theirs.diagnostics.length)} 条 ${JSON.stringify(theirs.diagnostics)}`,
    });
  } else {
    for (let i = 0; i < ours.diagnostics.length; i += 1) {
      if (ours.diagnostics[i] !== theirs.diagnostics[i]) {
        mismatches.push({
          project,
          field: 'diagnostics',
          detail: `第 ${String(i)} 条：内核 ${String(ours.diagnostics[i])} vs 参照 ${String(theirs.diagnostics[i])}`,
        });
      }
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------- 调用参照实现

interface SpawnOutcome {
  readonly attempted: readonly string[];
  readonly status: number | null;
  readonly errorMessage: string | null;
}

function quoteIfNeeded(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * 调用参照实现。
 *
 * 分两步，避免把"解释器不存在"误诊成"参照实现跑失败"：
 * 1. **先探测**解释器（`<candidate> --version`，`stdio: 'ignore'`——不用管道，沙箱下管道会 EPERM）；
 *    探测失败就换下一个候选。Windows 上 `python` 往往是 **`.bat` 垫片**，直接执行会得到
 *    9009（"不是可执行程序"），因此还要退回 `cmd.exe /d /s /c` 再探一次；
 * 2. 探测通过后再真正执行脚本（`stdio: 'inherit'`），同样带回退。
 *
 * 不经 `shell: true`：Node 会对"shell + args"给出 DEP0190 警告，且参数转义规则更差。
 */
function runReferencePython(args: readonly string[], cwd: string): SpawnOutcome {
  const candidates: string[] = [];
  const override = process.env.GANTTPILOT_PYTHON;
  if (override !== undefined && override !== '') {
    candidates.push(override);
  }
  candidates.push('python', 'python3', 'py');
  const attempted: string[] = [];
  const unavailable: string[] = [];
  const comspec = process.env.ComSpec ?? 'cmd.exe';

  for (const candidate of candidates) {
    const extra = candidate === 'py' ? ['-3'] : [];
    const label = [candidate, ...extra].join(' ');
    const probeLine = [candidate, ...extra, '--version'].map(quoteIfNeeded).join(' ');

    const probe = spawnSync(candidate, [...extra, '--version'], { cwd, stdio: 'ignore' });
    let available = probe.error === undefined && probe.status === 0;
    if (!available) {
      const viaShell = spawnSync(comspec, ['/d', '/s', '/c', probeLine], { cwd, stdio: 'ignore' });
      available = viaShell.error === undefined && viaShell.status === 0;
    }
    attempted.push(label);
    if (!available) {
      unavailable.push(label);
      continue;
    }

    const direct = spawnSync(candidate, [...extra, ...args], { cwd, stdio: 'inherit' });
    if (direct.error === undefined && direct.status !== null && direct.status !== 9009) {
      return { attempted, status: direct.status, errorMessage: null };
    }
    const directError =
      direct.error?.message ?? `直接执行退出码 ${String(direct.status ?? -1)}（可能是 .bat/.cmd 垫片）`;
    const line = [candidate, ...extra, ...args].map(quoteIfNeeded).join(' ');
    const viaShell = spawnSync(comspec, ['/d', '/s', '/c', line], { cwd, stdio: 'inherit' });
    if (viaShell.error === undefined && viaShell.status !== null && viaShell.status !== 9009) {
      return { attempted, status: viaShell.status, errorMessage: null };
    }
    const shellError = viaShell.error?.message ?? `退出码 ${String(viaShell.status ?? -1)}`;
    return {
      attempted,
      status: null,
      errorMessage: `${directError}；经 ${comspec} 执行：${shellError}`,
    };
  }
  return {
    attempted,
    status: null,
    errorMessage: `以下解释器都不可用：${unavailable.join('、')}`,
  };
}

function toInputProject(project: GeneratedProject): Record<string, unknown> {
  const document = project.document;
  const calendar = makeCalendar(project);
  return {
    id: document.project.name,
    baseDay: calendar.baseDay,
    spanDays: calendar.spanDays,
    calendar: document.calendars[0],
    projectStartDate: document.project.startDate,
    anchors: project.anchors.map((anchor) => ({ taskId: anchor.taskId, startOrdinal: anchor.startOrdinal })),
    tasks: document.tasks.map((task) => ({
      id: task.id,
      parentId: task.parentId,
      startDate: task.startDate,
      endDate: task.endDate,
      durationDays: task.durationDays,
      progress: task.progress,
      milestone: task.milestone,
      manual: task.manual,
      constraints: task.constraints,
    })),
    links: document.links.map((link) => ({
      id: link.id,
      from: link.from,
      to: link.to,
      type: link.type,
      lagDays: link.lagDays,
    })),
  };
}

describe('G2 差分：与独立 Python 参照实现逐字段一致', () => {
  it('≥1,000 随机 DAG + 200 成环图，0 不一致（缺 Python 3 即失败）', { timeout: 900_000 }, () => {
    expect(statSync(referenceScript).size).toBeGreaterThan(0);
    mkdirSync(outDir, { recursive: true });

    const dagProjects: GeneratedProject[] = [];
    for (let i = 0; i < DIFFERENTIAL_CONFIG.projects; i += 1) {
      dagProjects.push(projectSpec(i, false));
    }
    const cyclicProjects: GeneratedProject[] = [];
    for (let i = 0; i < DIFFERENTIAL_CONFIG.cyclicProjects; i += 1) {
      cyclicProjects.push(projectSpec(i, true));
    }
    const all = [...dagProjects, ...cyclicProjects];

    const ourSnapshots: Snapshot[] = all.map((project) => {
      const calendar = makeCalendar(project);
      const result = compute(project.document, calendar, project.anchors);
      if (!result.ok) {
        return snapshotOfReference({ hasCycle: true });
      }
      return snapshotOfSchedule(result.schedule, calendar);
    });

    const inputPath = join(outDir, 'inputs.json');
    const outputPath = join(outDir, 'outputs.json');
    writeFileSync(inputPath, `${JSON.stringify({ projects: all.map(toInputProject) })}\n`, 'utf8');

    const spawnOutcome = runReferencePython([referenceScript, inputPath, outputPath], repoRoot);
    const commandLine = spawnOutcome.attempted.join(' → ');
    if (spawnOutcome.status === null) {
      throw new Error(
        `无法启动独立参照实现（尝试：${commandLine}）：${String(spawnOutcome.errorMessage)}。\n` +
          '参考实现是 G2 门禁的第三层证据，**缺 Python 3 时失败而不是跳过**（ADR 0004 §9）；' +
          '可用环境变量 GANTTPILOT_PYTHON 指定解释器。',
      );
    }
    if (spawnOutcome.status !== 0) {
      throw new Error(`独立参照实现退出码 ${String(spawnOutcome.status)}（命令：${commandLine}）`);
    }

    const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as { results: ReferenceResult[] };
    expect(parsed.results).toHaveLength(all.length);

    const mismatches: DifferentialMismatch[] = [];
    let compared = 0;
    let cyclicBoth = 0;
    for (let index = 0; index < all.length; index += 1) {
      const snapshot = snapshotOfReference(parsed.results[index]!);
      const ours = ourSnapshots[index]!;
      const found = compareSnapshots(ours, snapshot, all[index]!.document.project.name);
      if (found.length > 0) {
        mismatches.push(...found);
        if (mismatches.length >= 40) {
          break;
        }
      }
      if (ours.hasCycle && snapshot.hasCycle) {
        cyclicBoth += 1;
      } else if (!ours.hasCycle && !snapshot.hasCycle) {
        compared += 1;
      }
    }

    const summary =
      `差分失败（seedBase=${String(DIFFERENTIAL_CONFIG.seedBase)}，前 ${String(mismatches.length)} 处不一致）：\n` +
      mismatches.map((entry) => `  - ${entry.project} ${entry.field}：${entry.detail}`).join('\n');
    expect(mismatches, summary).toStrictEqual([]);

    // 门禁判据（协议原文）：≥1,000 个 DAG 项目 + 200 个成环图，两侧都判定为环。
    expect(compared).toBeGreaterThanOrEqual(DIFFERENTIAL_CONFIG.projects);
    expect(cyclicBoth).toBe(DIFFERENTIAL_CONFIG.cyclicProjects);
  });

  it('比对器本身有判别力：篡改任一侧都必须被检出（负向对照）', () => {
    const project = projectSpec(0, false);
    const calendar = makeCalendar(project);
    const result = compute(project.document, calendar, project.anchors);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ours = snapshotOfSchedule(result.schedule, calendar);
    expect(compareSnapshots(ours, ours, 'self')).toStrictEqual([]);

    const firstLeaf = ours.es.findIndex((value) => value !== LEAF_SENTINEL);
    expect(firstLeaf).toBeGreaterThanOrEqual(0);
    const tamperedEs = [...ours.es];
    tamperedEs[firstLeaf] = (tamperedEs[firstLeaf] ?? 0) + 1;
    const tampered: Snapshot = { ...ours, es: tamperedEs, diagnostics: [...ours.diagnostics, 'undated|t0|'] };
    const found = compareSnapshots(ours, tampered, 'tamper');
    expect(found.some((entry) => entry.field.startsWith('es'))).toBe(true);
    expect(found.map((entry) => entry.field)).toContain('diagnostics');
  });
});
