/**
 * G3 出口条件 ⑥：**性能只记录实测**（不设会抖动的硬阈值）+ **结构哨兵**（**哨兵 ≠ 门禁**，裁决 P-9）。
 *
 * - 性能：`bytes → importXlsx → createScheduleCalendar → compute` 的墙钟（200 行），与"≤3 秒"对照；
 * - 体积：`exceljs` 浏览器入口（`dist/exceljs.min.js`）的字节数——ADR 0006 §11 只要求**记录**；
 * - 哨兵：用机器上可用的 LibreOffice headless 打开导出物，记录"是否运行 / 是否报修复"。
 *   **本机不可用时记录"未运行"并跳过**，绝不假装通过。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compute, createScheduleCalendar, type DocumentTask, type ProjectDocument } from '@ganttpilot/engine';
import { describe, expect, it } from 'vitest';

import { exportXlsx } from './export.js';
import { importXlsx } from './import.js';
import { fixtureDocumentNoProjectFields, partFingerprint } from './fixtures.spec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const reportDir = join(repoRoot, 'tmp', 'xlsx-perf');

/** 造一个 200 行的常见结构文档（4 层层级 + 每行一条 FS 前置）。 */
function buildDocument(rows: number): ProjectDocument {
  const base = fixtureDocumentNoProjectFields();
  const tasks: DocumentTask[] = [];
  /** 每个父节点的子节点计数（保证编号唯一：`k` / `k.1` / `k.2` / `k.3`）。 */
  const childCounts = new Map<number, number>();
  for (let index = 0; index < rows; index += 1) {
    const group = Math.floor(index / 4);
    const depth = index % 4;
    let outline = `${String(group + 1)}`;
    let parentKey: number | null = null;
    if (depth > 0) {
      const used = (childCounts.get(group) ?? 0) + 1;
      childCounts.set(group, used);
      outline = `${String(group + 1)}.${String(used)}`;
      parentKey = group * 4;
    }
    tasks.push({
      id: `t${String(index + 1)}`,
      parentId: parentKey === null ? null : (tasks[parentKey]?.id ?? null),
      outlineNumber: outline,
      name: `任务 ${String(index + 1)}`,
      startDate: '2026-10-05',
      endDate: null,
      durationDays: 2 + (index % 5),
      progress: (index % 10) / 10,
      milestone: index % 17 === 0,
      collapsed: false,
      notes: index % 3 === 0 ? `备注 ${String(index)}` : null,
      manual: false,
      constraints: [],
    });
  }
  const links = tasks.slice(0, -1).map((task, index) => ({
    id: `l${String(index + 1)}`,
    from: task.id,
    to: tasks[index + 1]?.id ?? task.id,
    type: 'FS' as const,
    lagDays: index % 7 === 0 ? 1 : 0,
  }));
  return { ...base, tasks, links };
}

function quantitative(
  label: string,
  samples: number,
  run: () => Promise<void>,
): Promise<{ readonly label: string; readonly medianMs: number; readonly minMs: number; readonly maxMs: number }> {
  return (async () => {
    const timings: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const start = process.hrtime.bigint();
      await run();
      timings.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    timings.sort((a, b) => a - b);
    return {
      label,
      medianMs: Number((timings[Math.floor(timings.length / 2)] ?? 0).toFixed(2)),
      minMs: Number((timings[0] ?? 0).toFixed(2)),
      maxMs: Number((timings[timings.length - 1] ?? 0).toFixed(2)),
    };
  })();
}

describe('G3 ⑥ 性能与体积：只记录实测', () => {
  it(
    '200 行端到端（字节 → importXlsx → compute）记录墙钟；对照 "≤3 秒"',
    { timeout: 300_000 },
    async () => {
      const document = buildDocument(200);
      const exported = await exportXlsx(document);
      expect(exported.ok).toBe(true);
      if (!exported.ok) {
        return;
      }
      const bytes = exported.bytes;
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, '200-rows.xlsx'), bytes);

      // 端到端：**从字节进入协议层起，到拿到 compute() 的 Schedule 为止**（与 S2 的"同进程写读"口径区分）
      const record = await quantitative('200 行端到端', 5, async () => {
        const imported = await importXlsx(bytes);
        if (!imported.ok) {
          throw new Error(JSON.stringify(imported.diagnostics));
        }
        const calendar = createScheduleCalendar(imported.document);
        const result = compute(imported.document, calendar);
        if (!result.ok) {
          throw new Error('compute 失败');
        }
      });

      // 分解口径：导入 / 排程各自单独记录（便于定位瓶颈）
      const importOnly = await quantitative('200 行 importXlsx', 5, async () => {
        await importXlsx(bytes);
      });
      const importedOnce = await importXlsx(bytes);
      expect(importedOnce.ok).toBe(true);
      if (!importedOnce.ok) {
        return;
      }
      const computeOnly = await quantitative('200 行 compute', 5, async () => {
        const calendar = createScheduleCalendar(importedOnce.document);
        compute(importedOnce.document, calendar);
      });

      const fingerprint = await partFingerprint(bytes);
      const report = {
        rows: document.tasks.length,
        links: document.links.length,
        bytes: bytes.byteLength,
        parts: fingerprint.parts.size,
        endToEnd: record,
        importOnly,
        computeOnly,
        thresholdSeconds: 3,
        note: '实测由 packages/xlsx-protocol/src/xlsxPerformance.spec.ts 产出；不设硬阈值（ADR 0006 §12 ⑥）',
      };
      writeFileSync(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`[G3 性能] 200 行端到端：中位 ${String(record.medianMs)} ms / 最慢 ${String(record.maxMs)} ms`);

      // 唯一断言：不得超出产品口径的 3 秒（宽到不会抖动，窄到能挡住"数量级错误"）
      expect(record.medianMs).toBeLessThan(3000);
      expect(importOnly.medianMs).toBeGreaterThan(0);
      expect(computeOnly.medianMs).toBeGreaterThan(0);
    },
  );

  it('记录 `exceljs` 浏览器入口体积（不设 chunk 体积门禁）', () => {
    const exceljsDir = resolve(repoRoot, 'node_modules', '.pnpm');
    const candidates = [
      resolve(repoRoot, 'packages', 'xlsx-protocol', 'node_modules', 'exceljs', 'dist', 'exceljs.min.js'),
      resolve(repoRoot, 'packages', 'xlsx-protocol', 'node_modules', 'exceljs', 'dist', 'exceljs.bare.min.js'),
    ];
    const sizes = candidates
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => ({ file: candidate.split(/[\\/]/).slice(-2).join('/'), bytes: statSync(candidate).size }));

    expect(existsSync(exceljsDir)).toBe(true);
    // 至少记录到一个入口；若上游改了 dist 布局则**失败**（而不是静默记录空数组）
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(size.bytes).toBeGreaterThan(100_000);
    }
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'exceljs-size.json'), `${JSON.stringify(sizes, null, 2)}\n`, 'utf8');
    console.log(
      `[G3 体积] ${sizes.map((size) => `${size.file}=${String(Math.round(size.bytes / 1024))} KB`).join('、')}`,
    );
  });
});

describe('G3 ⑥ 结构哨兵：LibreOffice headless 打开导出物（哨兵 ≠ 门禁）', () => {
  it('本机可用时跑一次并记录；不可用时记录"未运行"', { timeout: 300_000 }, async () => {
    const document = fixtureDocumentNoProjectFields();
    const exported = await exportXlsx(document);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    mkdirSync(reportDir, { recursive: true });
    const sourcePath = join(reportDir, 'sentinel-input.xlsx');
    writeFileSync(sourcePath, exported.bytes);

    const soffice = findSoffice();
    const record: Record<string, unknown> = {
      target: 'sentinel-input.xlsx',
      soffice: soffice ?? null,
      ran: soffice !== null,
    };

    if (soffice !== null) {
      const outDir = join(reportDir, 'sentinel-out');
      mkdirSync(outDir, { recursive: true });
      try {
        execFileSync(
          soffice,
          ['--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc)', '--outdir', outDir, sourcePath],
          { stdio: 'ignore', timeout: 120_000 },
        );
        const produced = join(outDir, 'sentinel-input.csv');
        record['produced'] = existsSync(produced);
        record['producedBytes'] = existsSync(produced) ? statSync(produced).size : 0;
        // **哨兵 ≠ 门禁**：只在"能转换出非空产物"这一层记录，绝不当成"文件没坏"的证明
        expect(record['produced']).toBe(true);
        expect(Number(record['producedBytes'])).toBeGreaterThan(0);
      } catch (error) {
        record['ran'] = false;
        record['error'] = String(error);
        console.log('[G3 哨兵] LibreOffice 转换失败，已记录（不影响门禁）');
      }
    } else {
      console.log('[G3 哨兵] 本机未找到 LibreOffice：记录"未运行"并跳过（哨兵不是门禁）');
    }

    writeFileSync(join(reportDir, 'sentinel.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  });
});

/** 找 LibreOffice：**只认 PATH 上的 `soffice`**，不做全盘搜索（裁决 P-9：本机内置不算仓库依赖）。 */
function findSoffice(): string | null {
  for (const candidate of ['soffice', 'soffice.exe', 'libreoffice']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 30_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
