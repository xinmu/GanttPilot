/**
 * L1b 差分测试：Node 生成随机项目图 → 落盘 JSON → 调用**独立 Python 参照实现** → 逐字段比对。
 *
 * 走**文件进出**而不是 stdio 管道：可调试、可复算，也不受子进程管道实现差异影响。
 * 参照实现不可得时**显式判为未验证**（返回 `skippedReason`），绝不静默通过。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSchedule, materializeDates } from './cpm.ts';
import { generateDataset, type Dataset } from './graph-gen.ts';
import { DIFFERENTIAL_CONFIG, differentialCalendarFor } from './manifest.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface DifferentialMismatch {
  readonly field: string;
  readonly projectIndex: number;
  readonly detail: string;
}

export interface DifferentialSummary {
  readonly projects: number;
  readonly cyclicProjects: number;
  readonly compared: number;
  readonly mismatches: readonly DifferentialMismatch[];
  readonly cycledDetectedByBoth: number;
  readonly cycleMismatches: readonly number[];
  readonly skippedReason: string | null;
  readonly referenceBytes: number;
  readonly pythonCommand: string;
}

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
 * Windows 上 `python` 往往是 **`.bat` 垫片**（本机是 pyenv-win 的 shim），`spawnSync` 直接执行
 * 会得到 9009（"不是可执行程序"）而不是 ENOENT，因此这里显式退回 `cmd.exe /d /s /c`。
 * 不经 `shell: true`：Node 会对"shell + args"给出 DEP0190 警告，且参数转义规则更差。
 */
function runReferencePython(
  args: readonly string[],
  cwd: string,
  override: string | undefined,
): SpawnOutcome {
  const candidates: string[] = [];
  if (override !== undefined && override !== '') {
    candidates.push(override);
  }
  candidates.push('python', 'python3', 'py');
  const attempted: string[] = [];
  let lastError: string | null = null;
  const comspec = process.env.ComSpec ?? 'cmd.exe';

  for (const candidate of candidates) {
    const extra = candidate === 'py' ? ['-3'] : [];
    attempted.push([candidate, ...extra].join(' '));
    const direct = spawnSync(candidate, [...extra, ...args], { cwd, stdio: 'inherit' });
    if (direct.error === undefined && direct.status !== null && direct.status !== 9009) {
      return { attempted, status: direct.status, errorMessage: null };
    }
    const directError =
      direct.error?.message ??
      `直接执行退出码 ${String(direct.status ?? -1)}（可能是 .bat/.cmd 垫片）`;
    const line = [candidate, ...extra, ...args].map(quoteIfNeeded).join(' ');
    const viaShell = spawnSync(comspec, ['/d', '/s', '/c', line], { cwd, stdio: 'inherit' });
    if (viaShell.error === undefined && viaShell.status !== null && viaShell.status !== 9009) {
      return { attempted, status: viaShell.status, errorMessage: null };
    }
    const shellError = viaShell.error?.message ?? `退出码 ${String(viaShell.status ?? -1)}`;
    lastError = `${directError}；经 ${comspec} 执行：${shellError}`;
  }
  return { attempted, status: null, errorMessage: lastError };
}

interface ReferenceResult {
  readonly id: string;
  readonly hasCycle: boolean;
  readonly es?: readonly number[];
  readonly ef?: readonly number[];
  readonly ls?: readonly number[];
  readonly lf?: readonly number[];
  readonly totalFloat?: readonly number[];
  readonly freeFloat?: readonly number[];
  readonly critical?: readonly number[];
  readonly projectFinish?: number;
  readonly esIso?: readonly string[];
  readonly efIso?: readonly string[];
}

interface TsResult {
  readonly id: string;
  readonly hasCycle: boolean;
  readonly scheduleProjection: Record<string, readonly number[] | string[] | number> | null;
}

function specFor(index: number, cyclic: boolean): Dataset {
  const { minTasks, maxTasks, milestoneRatio, maxLag, seedBase } = DIFFERENTIAL_CONFIG;
  const span = maxTasks - minTasks + 1;
  const taskCount = minTasks + ((index * 7) % span);
  return generateDataset({
    id: `diff-${cyclic ? 'cyc' : 'dag'}-${String(index)}`,
    kind: cyclic ? 'random-cyclic' : 'random-dag',
    taskCount,
    linkCount: Math.max(taskCount - 1, Math.floor(taskCount * 1.6)),
    seed: seedBase + index,
    maxDuration: DIFFERENTIAL_CONFIG.maxDuration,
    maxLag,
    milestoneRatio,
  });
}

function toInputProject(dataset: Dataset, calendarIndex: number): Record<string, unknown> {
  const calendar = differentialCalendarFor(calendarIndex);
  return {
    id: dataset.id,
    taskCount: dataset.taskCount,
    durations: Array.from(dataset.durations),
    links: dataset.links.map((link) => ({
      pred: link.pred,
      succ: link.succ,
      type: link.type,
      lag: link.lag,
    })),
    baseDay: dataset.baseDay,
    calendar: {
      workDays: calendar.workDays,
      nonWorking: calendar.exceptions.nonWorking,
      working: calendar.exceptions.working,
    },
  };
}

function tsCompute(dataset: Dataset, calendarIndex: number): TsResult {
  const result = computeSchedule({
    taskCount: dataset.taskCount,
    durations: Array.from(dataset.durations),
    links: dataset.links,
    calendar: differentialCalendarFor(calendarIndex),
    baseDay: dataset.baseDay,
  });
  if (result.cycleNodes !== null || result.schedule === null) {
    return { id: dataset.id, hasCycle: true, scheduleProjection: null };
  }
  const schedule = result.schedule;
  const dates = materializeDates(schedule, result.calendar);
  return {
    id: dataset.id,
    hasCycle: false,
    scheduleProjection: {
      es: Array.from(schedule.es),
      ef: Array.from(schedule.ef),
      ls: Array.from(schedule.ls),
      lf: Array.from(schedule.lf),
      totalFloat: Array.from(schedule.totalFloat),
      freeFloat: Array.from(schedule.freeFloat),
      critical: Array.from(schedule.critical),
      projectFinish: schedule.projectFinish,
      esIso: dates.startIso,
      efIso: dates.finishExclusiveIso,
    },
  };
}

export function runDifferential(): DifferentialSummary {
  const outDir = join(spikeRoot, 'out', 'diff');
  mkdirSync(outDir, { recursive: true });

  const dagDatasets: Dataset[] = [];
  for (let i = 0; i < DIFFERENTIAL_CONFIG.projects; i += 1) {
    dagDatasets.push(specFor(i, false));
  }
  const cyclicDatasets: Dataset[] = [];
  for (let i = 0; i < DIFFERENTIAL_CONFIG.cyclicProjects; i += 1) {
    cyclicDatasets.push(specFor(i, true));
  }

  const allDatasets = [...dagDatasets, ...cyclicDatasets];
  const tsResults = allDatasets.map((dataset, index) => tsCompute(dataset, index));

  const inputPath = join(outDir, 'inputs.json');
  const outputPath = join(outDir, 'outputs.json');
  writeFileSync(
    inputPath,
    `${JSON.stringify({ projects: allDatasets.map((dataset, index) => toInputProject(dataset, index)) })}\n`,
    'utf8',
  );

  const scriptPath = join(spikeRoot, DIFFERENTIAL_CONFIG.referenceScript);
  const referenceBytes = statSync(scriptPath).size;
  const override = process.env.GANTTPILOT_PYTHON;
  const spawnOutcome = runReferencePython([scriptPath, inputPath, outputPath], spikeRoot, override);
  const pythonCommand = spawnOutcome.attempted.join(' → ');

  const base: Omit<DifferentialSummary, 'skippedReason'> = {
    projects: dagDatasets.length,
    cyclicProjects: cyclicDatasets.length,
    compared: 0,
    mismatches: [],
    cycledDetectedByBoth: 0,
    cycleMismatches: [],
    referenceBytes,
    pythonCommand,
  };

  if (spawnOutcome.status === null) {
    return {
      ...base,
      skippedReason: `无法启动参照实现（尝试：${pythonCommand}）：${String(spawnOutcome.errorMessage)}。可用 GANTTPILOT_PYTHON 指定解释器`,
    };
  }
  if (spawnOutcome.status !== 0) {
    return {
      ...base,
      skippedReason: `参照实现退出码 ${String(spawnOutcome.status)}`,
    };
  }

  const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as { results: ReferenceResult[] };
  const mismatches: DifferentialMismatch[] = [];
  const cycleMismatches: number[] = [];
  let compared = 0;
  let cycledDetectedByBoth = 0;

  const numericFields = ['es', 'ef', 'ls', 'lf', 'totalFloat', 'freeFloat', 'critical'] as const;
  const isoFields = ['esIso', 'efIso'] as const;

  for (let index = 0; index < allDatasets.length; index += 1) {
    const reference = parsed.results[index];
    const ts = tsResults[index]!;
    if (reference === undefined) {
      mismatches.push({ field: 'missing-result', projectIndex: index, detail: '参照实现缺少该项目的输出' });
      continue;
    }
    const isCyclicDataset = index >= dagDatasets.length;
    if (reference.hasCycle !== ts.hasCycle) {
      if (isCyclicDataset) {
        cycleMismatches.push(index);
      } else {
        mismatches.push({
          field: 'hasCycle',
          projectIndex: index,
          detail: `参照 ${String(reference.hasCycle)} vs 内核 ${String(ts.hasCycle)}`,
        });
      }
      continue;
    }
    if (reference.hasCycle && isCyclicDataset) {
      cycledDetectedByBoth += 1;
      continue;
    }
    if (reference.hasCycle) {
      continue;
    }
    compared += 1;
    const projection = ts.scheduleProjection!;
    for (const field of numericFields) {
      const expected = reference[field] as readonly number[] | undefined;
      const actual = projection[field] as readonly number[] | undefined;
      if (expected === undefined || actual === undefined) {
        mismatches.push({ field, projectIndex: index, detail: '一侧缺少该字段' });
        continue;
      }
      if (expected.length !== actual.length) {
        mismatches.push({
          field,
          projectIndex: index,
          detail: `长度不一致：参照 ${String(expected.length)} vs 内核 ${String(actual.length)}`,
        });
        continue;
      }
      for (let i = 0; i < expected.length; i += 1) {
        if (expected[i] !== actual[i]) {
          mismatches.push({
            field,
            projectIndex: index,
            detail: `#${String(i)}：参照 ${String(expected[i])} vs 内核 ${String(actual[i])}`,
          });
          break;
        }
      }
    }
    for (const field of isoFields) {
      const expected = reference[field] as readonly string[] | undefined;
      const actual = projection[field] as readonly string[] | undefined;
      if (expected === undefined || actual === undefined) {
        mismatches.push({ field, projectIndex: index, detail: '一侧缺少该字段' });
        continue;
      }
      for (let i = 0; i < expected.length; i += 1) {
        if (expected[i] !== actual[i]) {
          mismatches.push({
            field,
            projectIndex: index,
            detail: `#${String(i)}：参照 ${String(expected[i])} vs 内核 ${String(actual[i])}`,
          });
          break;
        }
      }
    }
    if (reference.projectFinish !== projection.projectFinish) {
      mismatches.push({
        field: 'projectFinish',
        projectIndex: index,
        detail: `参照 ${String(reference.projectFinish)} vs 内核 ${String(projection.projectFinish)}`,
      });
    }
    if (mismatches.length > 60) {
      break;
    }
  }

  return { ...base, compared, mismatches, cycledDetectedByBoth, cycleMismatches, skippedReason: null };
}
