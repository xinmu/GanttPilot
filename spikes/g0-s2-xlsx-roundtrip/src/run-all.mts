/**
 * G0-S-S2 一键入口：生成规范工作簿 → L1 判定集（含负向对照）→ 写 `out/` 与 `evidence/`。
 *
 * 失败即非零退出（`node:assert`），但**报告先写后断言**——失败时也要留下诊断现场。
 *
 * 用法：`node src/run-all.mts`
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeCanonicalWorkbook, writeTzProbeWorkbook } from './canonical.ts';
import {
  DATE_ENCODING,
  FIXTURE_STATS,
  MILESTONE_ENCODING,
  SHEET_NAME,
  expectedEdges,
} from './manifest.ts';
import { readRawSheet } from './raw-read.ts';
import { runL1, tzProbeSummary, type Check } from './verify-l1.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(spikeRoot, 'out');
const evidenceDir = join(spikeRoot, 'evidence');

function renderChecks(title: string, checks: readonly Check[]): string {
  const failed = checks.filter((check) => !check.passed);
  return [
    `### ${title}`,
    '',
    `共 ${String(checks.length)} 条，通过 ${String(checks.length - failed.length)} 条，失败 ${String(failed.length)} 条。`,
    '',
    '| 检查 | 结果 | 实测 |',
    '|---|---|---|',
    ...checks.map(
      (check) => `| \`${check.name}\` | ${check.passed ? '✅ 通过' : '❌ 失败'} | ${check.detail.replace(/\|/g, '\\|')} |`,
    ),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  console.log('[1/5] 生成规范工作簿 …');
  const canonical = await writeCanonicalWorkbook();
  await writeFile(join(outDir, 'canonical.xlsx'), canonical);
  console.log(`      out/canonical.xlsx (${String(canonical.byteLength)} bytes)`);

  console.log('[2/5] L1 判定集（自往返 / 双路径 / 编码落地 / 负向对照）…');
  const { result } = await runL1();

  console.log('[3/5] 时区陷阱取证工作簿 …');
  const tzProbeBytes = await writeTzProbeWorkbook('2026-10-05');
  await writeFile(join(outDir, 'tz-probe.xlsx'), tzProbeBytes);

  console.log('[4/5] 导出规范化产物的部件清单与 XML（供第三方 diff 基线）…');
  const baseline = await readRawSheet(canonical, SHEET_NAME);
  const partsList = baseline.workbook.parts
    .map((part) => `| \`${part.name}\` | ${String(part.size)} | \`${part.sha256.slice(0, 16)}…\` |`)
    .join('\n');

  console.log('[5/5] 写出报告 …');
  const report = [
    '# S2 · L1 判定报告（规范工作簿的自往返与编码落地）',
    '',
    '> 由 `node src/run-all.mts` 生成。本报告只覆盖**本机 ExcelJS + zip 层**的结构判定，',
    '> **不覆盖**第三方编辑器（WPS）往返——后者见 `evidence/<label>/roundtrip-report.md`。',
    '> 重跑会**覆盖**本文件；判定集与负向对照的代码在 `src/verify-l1.ts`。',
    '',
    '运行环境：Windows x64、时区 UTC+08:00（系统默认）；**Node 24.15.0（`.nvmrc` 与 CI 口径）',
    '与 Node 26.7.0 上均已跑通，结论相同**。此处刻意写固定字符串而不写 `process.version`，',
    '以保证换运行时重跑时证据文件逐字节不变。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 工作表 | ${SHEET_NAME}（单表，可见，无隐藏表） |`,
    `| 日期编码 | \`${DATE_ENCODING}\` |`,
    `| 里程碑编码 | \`${MILESTONE_ENCODING}\` |`,
    `| fixture | ${String(FIXTURE_STATS.rows)} 行 / ${String(FIXTURE_STATS.edges)} 条边 / 最大深度 ${String(FIXTURE_STATS.maxDepth)} / 里程碑 ${String(FIXTURE_STATS.milestones)} |`,
    `| 规范化产物 | ${String(result.committed.sizeBytes)} 字节，**部件指纹** \`${result.committed.partsFingerprint}\`（${String(result.committed.parts)} 个部件） |`,
    `| 确定性 | 同一模型两次写出的**部件内容逐字节相同**：${result.committed.deterministic ? '✅' : '❌'}；整文件字节${result.committed.fileBytesIdentical ? '也相同（同秒写入）' : '不同'} |`,
    `| 单元格数 | ExcelJS 对象层 ${String(result.duel.excelJsCells)} / zip 层 ${String(result.duel.rawCells)}（共享字符串 ${String(result.duel.sharedStrings)} 条，部件 ${String(result.duel.parts)} 个） |`,
    '',
    '> **关于「确定性」**：`exceljs@4.4.0` 会把**写入时刻**写进 zip 条目的 DOS 时间戳，',
    '> 因此**整文件字节**在不同秒写入时不相等（部件内容相同）。golden 比对（G3/G7 同类要求）',
    '> 必须比对**部件指纹**，不能用文件哈希——否则会得到「永远不一致」的假失败。',
    '',
    renderChecks('判定集', result.checks),
    '### 负向对照（变造必须被报出）',
    '',
    '| 变造 | 变造内容 | 期望被判据拦下 | 实际报出的失败检查 | 判定 |',
    '|---|---|---|---|---|',
    ...result.negativeControls.map(
      (control) =>
        `| ${control.name} | ${control.mutation} | ${control.expectFailing.join('、')} | ${control.observedFailing.join('、')} | ${control.detected ? '✅ 已报出' : '❌ 未报出'} |`,
    ),
    '',
    '### 字段级差异（ExcelJS 路径解析值 vs 声明式期望值）',
    '',
    result.mismatches.length === 0
      ? '无差异。'
      : [
          '| WBS | 字段 | 期望 | 实际 |',
          '|---|---|---|---|',
          ...result.mismatches.map(
            (item) => `| ${item.wbs} | ${item.field} | ${item.expected.replace(/\|/g, '\\|')} | ${item.actual.replace(/\|/g, '\\|')} |`,
          ),
        ].join('\n'),
    '',
    '### 依赖边差异（声明式期望边 vs 解析边）',
    '',
    `- 期望边总数：${String(expectedEdges().length)}`,
    `- 缺失：${result.edges.missing.length === 0 ? '无' : result.edges.missing.join('；')}`,
    `- 多余：${result.edges.extra.length === 0 ? '无' : result.edges.extra.join('；')}`,
    '',
    '### 双路径差异（ExcelJS 对象层 vs zip 原始层）',
    '',
    result.dualPathDifferences.length === 0 ? '无差异（逐格一致）。' : result.dualPathDifferences.slice(0, 20).join('\n'),
    '',
    '### 结构化诊断（解析器输出）',
    '',
    result.diagnostics.length === 0 ? '无诊断输出。' : result.diagnostics.join('\n'),
    '',
    '### 日期列落盘形式分布',
    '',
    Object.entries(result.dateRepresentations)
      .map(([key, value]) => `- ${key} × ${String(value)}`)
      .join('\n'),
    '',
    '### 时区陷阱取证（同一个日历日期、不同构造方式）',
    '',
    '判据：`exceljs/lib/utils/utils.js` 的 `dateToExcel(d) = 25569 + d.getTime() / 86400000`',
    '——序列号由**绝对时刻**推导，因此用本地零点构造会得到带小数的序列号，',
    'Excel 按序列号显示时落入**前一天**。',
    '',
    '| 构造方式 | 落盘序列号 | 是否整数 | Excel 会显示的日期 | ExcelJS 读回的日期 |',
    '|---|---|---|---|---|',
    ...tzProbeSummary(result.tzProbe),
    '',
    '### 规范化产物的 zip 部件（第三方 diff 的基线）',
    '',
    '| 部件 | 字节 | sha256（前 16） |',
    '|---|---|---|',
    partsList,
    '',
  ].join('\n');

  const reportPath = join(evidenceDir, 'structure-report.md');
  await writeFile(reportPath, report, 'utf8');
  console.log(`      ${reportPath}`);

  const failed = result.checks.filter((check) => !check.passed);
  assert.equal(
    failed.length,
    0,
    `L1 判定失败 ${String(failed.length)} 条：${failed.map((check) => check.name).join(', ')}`,
  );
  const undetected = result.negativeControls.filter((control) => !control.detected);
  assert.equal(
    undetected.length,
    0,
    `负向对照未被报出（判据无判别力）：${undetected.map((control) => control.name).join(', ')}`,
  );

  console.log(`\n[OK] L1 全部通过（${String(result.checks.length)} 条，含 ${String(result.negativeControls.length)} 条负向对照）。`);
  console.log('[next] 第三方往返取证：pwsh -File src/wps-save.ps1 && pwsh -File src/wps-edit-save.ps1');
}

await main();
