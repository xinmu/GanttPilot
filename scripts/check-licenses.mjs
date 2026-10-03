#!/usr/bin/env node
/**
 * 依赖许可审计（PRD-06）。
 *
 * 两种口径，各有明确用途：
 * - **严格口径（默认，`--prod`）**：只审计**运行时依赖**。它们会随产物分发，必须落在
 *   白名单内（PRD-06 只约束运行时依赖）。作为 `pnpm gate` 的一环，阻塞不合规提交。
 * - **全域口径（`--all`）**：连开发依赖一起看。当前开发依赖树里存在 MPL-2.0
 *   （lightningcss，Vite 的 CSS 转换器）与 BlueOak-1.0.0（minimatch）——它们不进产物，
 *   因此**不**在白名单内、也**不**用于阻塞提交；发现**既不在白名单、又不在已知开发例外
 *   清单**里的许可时才失败（防止新引入的依赖悄悄带入奇怪许可）。
 *
 * `--write` 会刷新 `THIRD_PARTY_NOTICES.md`（生成物入库，便于 PR diff 审阅），
 * 同时写入运行时与开发两张清单。
 *
 * 用法：
 *   node scripts/check-licenses.mjs --prod            # 门禁口径（默认）
 *   node scripts/check-licenses.mjs --all             # 全域口径（含开发依赖）
 *   node scripts/check-licenses.mjs --all --write     # 刷新 THIRD_PARTY_NOTICES.md
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES_PATH = join(repoRoot, 'THIRD_PARTY_NOTICES.md');

/** 允许的运行时依赖许可（PRD-06：MIT / Apache-2.0 等宽松 OSI 许可）。 */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'Apache 2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
]);

/**
 * 已知且**可接受**的开发依赖许可例外：不进产物，只用于构建/测试。
 * 新增条目必须在这里写清"哪个包、为什么可接受"，否则 `--all` 会失败。
 */
const KNOWN_DEV_ONLY_LICENSES = new Map([
  // Vite 的 CSS 处理链；MPL-2.0 是文件级 copyleft，不改变本项目 MIT 属性，且不随产物分发。
  ['lightningcss', 'MPL-2.0'],
  ['lightningcss-win32-x64-msvc', 'MPL-2.0'],
  ['lightningcss-darwin-arm64', 'MPL-2.0'],
  ['lightningcss-darwin-x64', 'MPL-2.0'],
  ['lightningcss-linux-arm64-gnu', 'MPL-2.0'],
  ['lightningcss-linux-x64-gnu', 'MPL-2.0'],
  ['lightningcss-linux-x64-musl', 'MPL-2.0'],
  // 各类 lint/test 工具的 glob 实现；BlueOak-1.0.0 为宽松许可。
  ['minimatch', 'BlueOak-1.0.0'],
]);

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has('--write');
const allScope = args.has('--all');
const prodScope = args.has('--prod') || !allScope;

/**
 * 许可声明是否可接受。支持 SPDX 的 `OR` 表达式（任一分支在白名单内即可）。
 */
function isAcceptable(license) {
  const normalized = String(license ?? '').trim();
  if (normalized === '') {
    return false;
  }
  if (ALLOWED_LICENSES.has(normalized)) {
    return true;
  }
  return normalized
    .split(/\s+OR\s+/i)
    .map((part) => part.replace(/[()]/g, '').trim())
    .some((part) => ALLOWED_LICENSES.has(part));
}

/** 已知的开发依赖例外（按包名 + 许可核对，避免"换个包沿用旧例外"）。 */
function isKnownDevOnly(entry) {
  return KNOWN_DEV_ONLY_LICENSES.get(entry.name) === String(entry.license).trim();
}

/** 读取 `pnpm licenses list` 的 JSON 输出。 */
function readLicenses({ prodOnly }) {
  const cliArgs = ['licenses', 'list', '--json'];
  if (prodOnly) {
    cliArgs.push('--prod');
  }

  let raw;
  try {
    // 参数是编译期固定的字面量（cliArgs 由本文件的固定值构造，不含外部输入）。
    // 用单一命令串而非 args 数组，避免 Node 对 `shell: true + args` 的弃用告警（DEP0190）。
    raw = execFileSync(`pnpm ${cliArgs.join(' ')}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Windows 上 pnpm 是 .cmd/.ps1 包装脚本，不经 shell 无法被直接执行。
      shell: true,
    });
  } catch (error) {
    console.error('[licenses] 读取依赖许可失败：`pnpm licenses list` 执行异常。');
    console.error(String(error?.message ?? error));
    console.error('[licenses] 若该子命令在你的 pnpm 版本上不可用，请改用手工维护 THIRD_PARTY_NOTICES.md，');
    console.error('[licenses] 并在 CONTRIBUTING.md 记录该例外（不要静默跳过）。');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[licenses] 无法解析 `pnpm licenses list --json` 的输出，原始输出前 500 字符：');
    console.error(String(raw).slice(0, 500));
    console.error('[licenses] 输出格式可能随 pnpm 版本变化，请更新 scripts/check-licenses.mjs。');
    process.exit(2);
  }

  const entries = [];
  for (const [groupLicense, group] of Object.entries(parsed)) {
    for (const item of group) {
      entries.push({
        name: item.name,
        versions: item.versions ?? [],
        license: item.license ?? groupLicense,
        homepage: item.homepage ?? '',
      });
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function renderSection(title, note, entries) {
  const lines = [`## ${title}`, '', `> ${note}`, '', `共 ${entries.length} 个包。`, ''];
  for (const entry of entries) {
    const version = entry.versions.join(', ');
    const homepage = entry.homepage === '' ? '' : ` — ${entry.homepage}`;
    lines.push(`- **${entry.name}** \`${version}\` — ${entry.license}${homepage}`);
  }
  lines.push('');
  return lines;
}

function renderNotices(runtimeEntries, devOnlyEntries) {
  return [
    '# THIRD_PARTY NOTICES',
    '',
    '> 本文件由 `pnpm notices:write`（`node scripts/check-licenses.mjs --all --write`）生成，**请勿手工编辑**。',
    '> 本仓库自身以 MIT 发布；下列组件的许可与版权归其各自作者所有。',
    '> 运行时依赖必须落在 `scripts/check-licenses.mjs` 的许可白名单内，这是 `pnpm gate` 的一环。',
    '',
    ...renderSection(
      '运行时依赖（随产物分发，白名单约束）',
      '这些依赖会被打包/分发，因此许可必须落在白名单内。',
      runtimeEntries,
    ),
    ...renderSection(
      '开发依赖（不随产物分发，仅构建与测试）',
      '列出它们是为了在 PR 阶段就暴露许可异常；其中 MPL-2.0 / BlueOak-1.0.0 属于已知例外，见脚本内注释。',
      devOnlyEntries,
    ),
  ].join('\n');
}

const runtimeEntries = readLicenses({ prodOnly: true });

if (prodScope) {
  const rejected = runtimeEntries.filter((entry) => !isAcceptable(entry.license));
  if (rejected.length > 0) {
    console.error(`[licenses] 运行时依赖中有 ${rejected.length} 个不在许可白名单内：`);
    for (const entry of rejected) {
      console.error(`  - ${entry.name}@${entry.versions.join(', ')} → ${entry.license || '(未声明)'}`);
    }
    console.error('[licenses] 处置：改用白名单内的替代库，或按 PRD-06 评估后更新白名单（需在裁决记录留痕）。');
    process.exit(1);
  }
  console.log(`[licenses] 门禁口径（--prod）通过：${runtimeEntries.length} 个运行时依赖，许可全部在白名单内。`);
  if (!shouldWrite) {
    console.log('[licenses] 依赖有变动时请运行 `pnpm notices:write` 并提交生成物。');
  }
}

if (allScope) {
  const allEntries = readLicenses({ prodOnly: false });
  const runtimeNames = new Set(runtimeEntries.map((entry) => entry.name));
  const devOnlyEntries = allEntries.filter((entry) => !runtimeNames.has(entry.name));

  const unknown = devOnlyEntries.filter(
    (entry) => !isAcceptable(entry.license) && !isKnownDevOnly(entry),
  );

  if (unknown.length > 0) {
    console.error(`[licenses] 开发依赖中出现 ${unknown.length} 个未登记的许可：`);
    for (const entry of unknown) {
      console.error(`  - ${entry.name}@${entry.versions.join(', ')} → ${entry.license || '(未声明)'}`);
    }
    console.error('[licenses] 处置：确认该依赖是否必需；若可接受，请在 KNOWN_DEV_ONLY_LICENSES 中登记并写明理由。');
    process.exit(1);
  }

  const devLicenses = [...new Set(devOnlyEntries.map((entry) => entry.license))].sort();
  console.log(
    `[licenses] 全域口径（--all）：运行时 ${runtimeEntries.length} 个、开发 ${devOnlyEntries.length} 个；` +
      `开发依赖许可分布：${devLicenses.join(' / ')}。`,
  );

  if (shouldWrite) {
    writeFileSync(NOTICES_PATH, renderNotices(runtimeEntries, devOnlyEntries), 'utf8');
    console.log('[licenses] 已刷新 THIRD_PARTY_NOTICES.md。');
  }
}
