/**
 * G3 出口条件 ④：**跨语言差分**——与 `tools/xlsx-reference/xlsx_reference.py`（openpyxl）逐格一致。
 *
 * **双向**，因为只有两个方向都跑，差分才真的在比"实现"而不是在比"同一份断言"：
 *
 * | 方向 | 谁写 | 谁读 | 比什么 |
 * |---|---|---|---|
 * | A | openpyxl（**编码形态刻意与 JS 不同**：ISO 文本 / 斜杠文本 / 裸序列号、百分数点位、`是/否`、全角分号、公式有/无缓存值） | JS 的 `importXlsx` | JS 导入出的**文档** vs openpyxl 按容差表独立推导出的语义 |
 * | B | JS 的 `exportXlsx` | openpyxl | openpyxl 读到的**逐格事实** vs 声明式期望值 |
 *
 * 三条不可退让的口径（与 `schedule.differential.spec.ts` 同构）：
 * 1. **缺 Python 3 或缺 openpyxl 就失败，不静默跳过**（Windows 上 `python` 可能是 `.bat` 垫片，
 *    `spawnSync` 返回 **9009** 而不是 `ENOENT`）；
 * 2. **参照实现走 UTF-8 文件进出**（本机控制台码页会把中文打成乱码，靠 stdout 比对会得到假失败）；
 * 3. 中间产物落 `tmp/xlsx-diff/`（已 gitignore），便于复算与调试。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { exportXlsx } from './export.js';
import { importXlsx } from './import.js';
import { fixtureDocumentNoProjectFields } from './fixtures.spec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const referenceScript = join(repoRoot, 'tools', 'xlsx-reference', 'xlsx_reference.py');
const workDir = join(repoRoot, 'tmp', 'xlsx-diff');

/** Python 侧的事实形状（`xlsx_reference.py` 的输出协议）。 */
interface PyCellFact {
  readonly type: 'empty' | 'text' | 'number' | 'boolean' | 'datetime' | 'formula' | 'other';
  readonly value?: string | number | boolean;
  readonly integer?: boolean;
}

interface PyDerivedRow {
  readonly row: number;
  readonly wbs: string;
  readonly name: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly duration: number | string | null;
  readonly progress: number | string | null;
  readonly milestone: boolean | string;
  readonly predecessors: string;
  readonly unrecognizedColumns: readonly string[];
}

interface PyReport {
  readonly sheetName: string;
  readonly sheetNames: readonly string[];
  readonly headers: readonly (string | null)[];
  readonly rows: readonly { readonly row: number; readonly cells: Readonly<Record<string, PyCellFact>> }[];
  readonly cachedStartValues: Readonly<Record<string, PyCellFact>>;
  readonly derived: readonly PyDerivedRow[];
  readonly maxRow: number;
  readonly maxColumn: number;
}

interface SpawnOutcome {
  readonly attempted: readonly string[];
  readonly status: number | null;
  readonly errorMessage: string | null;
}

function quoteIfNeeded(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** 解释器探测 + 执行（与 `schedule.differential.spec.ts` 同一套实测过的回退逻辑）。 */
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
  return { attempted, status: null, errorMessage: `以下解释器都不可用：${unavailable.join('、')}` };
}

describe('G3 ④ 跨语言差分：JS 协议 ↔ openpyxl 参照实现', () => {
  it(
    '双向逐字段一致（缺 Python 3 或缺 openpyxl 即失败）',
    { timeout: 300_000 },
    async () => {
      expect(statSync(referenceScript).size).toBeGreaterThan(0);
      mkdirSync(workDir, { recursive: true });

      // 方向 B 的输入：G3 的导出物（先落盘，Python 侧会读它）
      const document = fixtureDocumentNoProjectFields();
      const exported = await exportXlsx(document);
      expect(exported.ok).toBe(true);
      if (!exported.ok) {
        return;
      }
      writeFileSync(join(workDir, 'js-export.xlsx'), exported.bytes);

      // 方向 A 的输入：Python 亲手写出的 fixture → JS 侧导入
      const outcome = runReferencePython([referenceScript, workDir], repoRoot);
      if (outcome.status === null) {
        throw new Error(
          `无法启动独立参照实现（尝试：${outcome.attempted.join(' → ')}）：${String(outcome.errorMessage)}。\n` +
            '参照实现是 G3 门禁的第四层证据，**缺 Python 3 或缺 openpyxl 时失败而不是跳过**（ADR 0006 §12）；' +
            '可用环境变量 GANTTPILOT_PYTHON 指定解释器，依赖口径：pip install openpyxl==3.1.5。',
        );
      }
      expect(outcome.status).toBe(0);

      const pyReport = JSON.parse(readFileSync(join(workDir, 'py-read-report.json'), 'utf8')) as PyReport;
      const jsReport = JSON.parse(readFileSync(join(workDir, 'js-read-report.json'), 'utf8')) as PyReport;

      // ---------------------------------------------------------- 方向 A：Python 写 → JS 读
      const pyFixture = readFileSync(join(workDir, 'py-fixture.xlsx'));
      const imported = await importXlsx(new Uint8Array(pyFixture));
      expect(imported.ok, JSON.stringify(imported.diagnostics, null, 2)).toBe(true);
      if (!imported.ok) {
        return;
      }

      // 参照侧的"独立推导"（openpyxl 事实 → 容差表 → 文档语义）
      const derivedByReference = pyReport.derived;
      const importedTasks = imported.document.tasks;

      // 编号忽略（JS 侧是确定性序号，参照侧不谈 id），只比**语义字段**
      const project = (task: (typeof importedTasks)[number]) => ({
        name: task.name,
        startDate: task.startDate,
        endDate: task.endDate,
        durationDays: task.durationDays,
        progress: task.progress,
        milestone: task.milestone,
        notes: task.notes,
      });

      const expectedRows = derivedByReference.map((row) => ({
        // `wbs` 不参与下面的深比较（编号由层级那一段单独断言），但**失败信息要用**：
        // 原先这里漏了它，于是断言模板里的 `expected.wbs` 取到 `undefined`
        // ——错误行号成了"第 3 行（WBS ）"，一条只在测试失败时才看得见的缺陷。
        wbs: row.wbs,
        // 公式无缓存值 → 文档里必须是 `null`（按值缺失），且诊断另有 info
        startDate: row.start === 'FORMULA_WITHOUT_CACHE' ? null : row.start,
        endDate: row.end === 'FORMULA_WITHOUT_CACHE' ? null : row.end,
        durationDays: typeof row.duration === 'number' ? row.duration : null,
        progress: typeof row.progress === 'number' ? row.progress : null,
        milestone: row.milestone === true,
        name: row.name,
      }));

      expect(importedTasks).toHaveLength(expectedRows.length);
      expectedRows.forEach((expected, index) => {
        const task = importedTasks[index];
        expect(task, `第 ${String(index + 2)} 行`).toBeDefined();
        if (task === undefined) {
          return;
        }
        expect(
          {
            name: task.name,
            startDate: task.startDate,
            endDate: task.endDate,
            durationDays: task.durationDays,
            progress: task.progress,
            milestone: task.milestone,
          },
          `第 ${String(index + 2)} 行（WBS ${expected.wbs ?? ''}）`,
        ).toStrictEqual({
          name: expected.name,
          startDate: expected.startDate,
          endDate: expected.endDate,
          durationDays: expected.durationDays,
          progress: expected.progress,
          milestone: expected.milestone,
        });
        void project;
      });

      // 层级：双解析以编号为准（`1.1`/`1.2` 是 `1` 的子、`2.1` 是 `2` 的子）
      const idOfOutline = new Map(imported.document.tasks.map((task) => [task.outlineNumber, task.id]));
      const parentOf = new Map(imported.document.tasks.map((task) => [task.outlineNumber, task.parentId]));
      expect(parentOf.get('1.1')).toBe(idOfOutline.get('1'));
      expect(parentOf.get('1.2')).toBe(idOfOutline.get('1'));
      expect(parentOf.get('2.1')).toBe(idOfOutline.get('2'));

      // 依赖：全角分号、省略类型、正/负 lag 都必须解析出来（4 条边）
      expect(
        imported.document.links.map((link) => {
          const from = imported.document.tasks.find((task) => task.id === link.from)?.outlineNumber ?? '?';
          const to = imported.document.tasks.find((task) => task.id === link.to)?.outlineNumber ?? '?';
          return `${from}->${to}[${link.type}${link.lagDays >= 0 ? '+' : ''}${String(link.lagDays)}]`;
        }),
      ).toStrictEqual(['1.2->2.1[FS+0]', '1.2->2.2[SS-1]', '2.1->3[FF+0]', '2.2->3[SF+1]']);

      // 未识别列必须被列出（交向导第 2 步人工映射）
      const unrecognized = imported.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'XLSX_UNRECOGNIZED_COLUMN',
      );
      expect(unrecognized).toHaveLength(1);
      expect(unrecognized[0]?.message).toContain('负责人');

      // 公式的三类空必须区分：
      // - python 侧 `cachedStartValues` 里第 10 行有值（公式有缓存值）→ JS 侧必须读到日期
      // - 第 11 行无缓存值 → 值缺失 + `XLSX_FORMULA_WITHOUT_CACHED_VALUE`(info)
      const rowsByNumber = new Map(derivedByReference.map((row) => [row.row, row]));
      expect(rowsByNumber.get(10)?.start).toBe('2026-10-20');
      expect(rowsByNumber.get(11)?.start).toBe('FORMULA_WITHOUT_CACHE');
      expect(imported.document.tasks[8]?.startDate).toBe('2026-10-20');
      expect(imported.document.tasks[9]?.startDate).toBeNull();
      expect(imported.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'XLSX_FORMULA_WITHOUT_CACHED_VALUE',
      );

      // ---------------------------------------------------------- 方向 B：JS 写 → Python 读
      // Python 侧不共享一行 JS 代码，因此它对导出物的读取是对"我们写出的字节"的独立复核。
      expect(jsReport.sheetName).toBe('任务');
      expect(jsReport.sheetNames).toStrictEqual(['任务']);
      expect(jsReport.headers.filter((header) => header !== null)).toStrictEqual([
        'WBS',
        '任务名称',
        '开始',
        '完成',
        '工期',
        '前置任务',
        '进度',
        '里程碑',
        '备注',
      ]);

      // 声明式期望值表（方向 B 的判据）：JS 导出物第 3 行 = `1.1 需求澄清`
      const jsRows = jsReport.derived;
      expect(jsRows).toHaveLength(document.tasks.length);
      const jsByWbs = new Map(jsRows.map((row) => [row.wbs, row]));
      expect(jsByWbs.get('1.1')?.start).toBe('2026-10-05');
      expect(jsByWbs.get('1.1')?.end).toBe('2026-10-08');
      expect(jsByWbs.get('1.1')?.duration).toBe(3);
      expect(jsByWbs.get('1.1')?.progress).toBe(0.5);
      expect(jsByWbs.get('1')?.milestone).toBe(false);
      expect(jsByWbs.get('3')?.milestone).toBe(true);
      expect(jsByWbs.get('2.2')?.predecessors).toBe('1.2[SS-1]');
      expect(jsByWbs.get('3')?.predecessors).toBe('2.1[FF];2.2[SF+1]');
      expect(jsByWbs.get('4')?.start).toBeNull();

      // 日期的**落盘形态**是"裸整数序列号"（Python 侧读出 `datetime` 即证明它带日期格式）
      const startFact = jsRows.length > 0 ? jsReport.rows[1]?.cells['开始'] : undefined;
      expect(startFact?.type).toBe('datetime');
    },
  );

  it('参照实现缺失时给出的错误信息是可操作的（不静默跳过）', () => {
    // 这条断言守住"缺 Python 即失败"的措辞：探测失败必须带出**尝试过的解释器候选**，
    // 让"本机没有 Python"不会被误诊成"参照实现跑失败了"。
    const outcome = runReferencePython([referenceScript], repoRoot);
    expect(outcome.attempted.length).toBeGreaterThan(0);
    if (outcome.status === null) {
      expect(String(outcome.errorMessage)).toContain('都不可用');
    } else {
      // 参数个数不对（缺工作目录）→ 参照实现自己返回 2（不是崩溃、也不是静默成功）
      expect(outcome.status).toBe(2);
    }
  });
});
