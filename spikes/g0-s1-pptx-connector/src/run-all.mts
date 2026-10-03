/**
 * S1 一键入口：构建容器 → 注入补丁 → L1 结构自检 → 写出 fixture 与报告。
 *
 * 失败即非零退出（`node:assert`）。产物：
 * - `out/A-absorption.pptx`：双端吸附 + group（主证据）
 * - `out/C-flat.pptx`：group 已按 ECMA-376 公式拍平（换算的对照）
 * - `evidence/structure-report.md`：逐条 L1 检查明细
 *
 * 用法：`node src/run-all.mts`（在 spike 目录下）
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContainer, readSlideSize, readSlideXml, repackSlideXml } from './fixture.ts';
import { compareRectMaps, flattenGroup, roundTripChildren } from './flatten-group.ts';
import { GRP_1, PT, SLIDE } from './manifest.ts';
import { buildPatch } from './patch.ts';
import { verifyStructure, type Check } from './verify-structure.ts';
import { injectIntoSpTree } from './xml.ts';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(spikeRoot, 'out');
const evidenceDir = join(spikeRoot, 'evidence');

function renderChecks(title: string, checks: readonly Check[]): string {
  const failed = checks.filter((check) => !check.passed);
  const lines = [
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
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  console.log('[1/5] 构建 pptxgenjs 容器 …');
  const container = await buildContainer();
  console.log(`      容器形状：${container.refs.map((ref) => `${ref.name}#${String(ref.id)}`).join(', ')}`);

  console.log('[2/5] 组装补丁（connector + group）…');
  const patch = buildPatch(container.refs);
  console.log(
    `      连线 id=${String(patch.connectorIds.dep)} 端点 (${String(patch.connectorPoints.from.x)},${String(patch.connectorPoints.from.y)}) → (${String(patch.connectorPoints.to.x)},${String(patch.connectorPoints.to.y)})`,
  );
  console.log(`      group id=${String(patch.connectorIds.group)} 子形状 id=${patch.connectorIds.groupChildren.join(',')}`);

  const patchedSlideXml = injectIntoSpTree(container.slideXml, patch.connectorXml + patch.groupXml);

  console.log('[3/5] L1 结构自检 …');
  const groupAbsolute = new Map(patch.groupAbsoluteShapes.map((shape) => [shape.name, shape.rect]));
  const containerSlideSize = await readSlideSize(container.bytes);
  console.log(
    `      容器实测幻灯片尺寸：${String(containerSlideSize.cx)}×${String(containerSlideSize.cy)} EMU（${String(containerSlideSize.cx / PT)}×${String(containerSlideSize.cy / PT)} pt）`,
  );
  const checks = verifyStructure({
    slideXml: patchedSlideXml,
    groupAbsolute,
    groupFrame: { ...patch.groupMapping.off, ...patch.groupMapping.ext },
    containerSlideSize,
  });

  console.log('[4/5] group 坐标换算的独立复算 …');
  const flattened = flattenGroup(GRP_1.children, patch.groupMapping);
  const crossCheck = compareRectMaps(
    new Map(flattened.map((shape) => [shape.name, shape.rect])),
    groupAbsolute,
  );
  const roundTrip = roundTripChildren(GRP_1.children, patch.groupMapping);

  console.log('[5/5] 写出 fixture 与报告 …');
  const absorptionBytes = await repackSlideXml(container.bytes, patchedSlideXml);
  const absorptionPath = join(outDir, 'A-absorption.pptx');
  await writeFile(absorptionPath, absorptionBytes);
  console.log(`      ${absorptionPath} (${String(absorptionBytes.length)} bytes)`);

  // C-flat：把 group 换成等价的「绝对坐标子形状」，其余不变
  const flatShapesXml = flattened
    .map((shape, index) => {
      const id = patch.connectorIds.groupChildren[index];
      return (
        `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="${shape.name}"/>` +
        `<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>` +
        `<a:xfrm><a:off x="${String(shape.rect.x)}" y="${String(shape.rect.y)}"/>` +
        `<a:ext cx="${String(shape.rect.cx)}" cy="${String(shape.rect.cy)}"/></a:xfrm>` +
        `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>` +
        `<a:solidFill><a:srgbClr val="${shape.color}"/></a:solidFill></p:spPr>` +
        `<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:lnRef>` +
        `<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>` +
        `<a:effectRef idx="0"><a:srgbClr val="FFFFFF"/></a:effectRef>` +
        `<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style></p:sp>`
      );
    })
    .join('');
  const flatSlideXml = injectIntoSpTree(container.slideXml, patch.connectorXml + flatShapesXml);
  const flatBytes = await repackSlideXml(container.bytes, flatSlideXml);
  const flatPath = join(outDir, 'C-flat.pptx');
  await writeFile(flatPath, flatBytes);
  console.log(`      ${flatPath} (${String(flatBytes.length)} bytes)`);

  // 回读校验：确认写出的文件里确实带上了补丁（防止「写了但没生效」）
  const readBack = await readSlideXml(absorptionBytes);
  assert.ok(readBack.includes('<p:cxnSp>'), 'A-absorption.pptx 回读后缺少 <p:cxnSp>');
  assert.ok(readBack.includes('<p:grpSp>'), 'A-absorption.pptx 回读后缺少 <p:grpSp>');
  assert.ok(readBack.includes('<a:stCxn'), 'A-absorption.pptx 回读后缺少 <a:stCxn>');

  const report = [
    '# S1 · L1 结构自检报告',
    '',
    '> 由 `node src/run-all.mts` 生成。本报告只覆盖**结构合法性**，不代表渲染正确性。',
    '',
    `- 幻灯片尺寸：${String(SLIDE.cx)} × ${String(SLIDE.cy)} EMU（${String(SLIDE.cx / PT)} × ${String(SLIDE.cy / PT)} pt，与容器 \`p:sldSz\` 实测值一致）`,
    `- 容器形状：${container.refs.map((ref) => `\`${ref.name}\`#${String(ref.id)}`).join('、')}`,
    `- 补丁分配：connector id=${String(patch.connectorIds.dep)}、group id=${String(patch.connectorIds.group)}、子形状 id=${patch.connectorIds.groupChildren.join('、')}`,
    `- 连线端点（绝对 EMU）：(${String(patch.connectorPoints.from.x)},${String(patch.connectorPoints.from.y)}) → (${String(patch.connectorPoints.to.x)},${String(patch.connectorPoints.to.y)})`,
    '',
    renderChecks('结构检查', checks),
    '### group 坐标换算：两条独立路径的交叉验证',
    '',
    '| 子形状 | 结果 | 明细 |',
    '|---|---|---|',
    ...crossCheck.map((item) => `| ${item.name} | ${item.passed ? '✅ 一致' : '❌ 不一致'} | ${item.detail} |`),
    '',
    '### group 坐标往返一致性（组坐标 → 绝对 → 组坐标）',
    '',
    '| 子形状 | 原始 | 绝对 | 还原 | 结果 |',
    '|---|---|---|---|---|',
    ...roundTrip.map(
      (item) =>
        `| ${item.name} | (${String(item.original.x)},${String(item.original.y)}) | (${String(item.absolute.x)},${String(item.absolute.y)}) | (${String(item.restored.x)},${String(item.restored.y)}) | ${item.passed ? '✅' : '❌'} |`,
    ),
    '',
  ].join('\n');

  const reportPath = join(evidenceDir, 'structure-report.md');
  await writeFile(reportPath, report, 'utf8');
  console.log(`      ${reportPath}`);

  const failedChecks = checks.filter((check) => !check.passed);
  assert.equal(failedChecks.length, 0, `L1 结构自检失败 ${String(failedChecks.length)} 条：${failedChecks.map((c) => c.name).join(', ')}`);
  assert.ok(crossCheck.every((item) => item.passed), 'group 坐标交叉验证不一致');
  assert.ok(roundTrip.every((item) => item.passed), 'group 坐标往返不一致');

  console.log(`\n[OK] L1 结构自检全部通过（${String(checks.length)} 条）。`);
  console.log('[next] 运行 WPS 证据链：pwsh -File src/wps-capture.ps1 && pwsh -File src/wps-drag.ps1');
}

await main();
