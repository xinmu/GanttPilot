#!/usr/bin/env node
/**
 * `pnpm gate` 的实现：**安装 → Lint → 类型检查 → 测试 → 构建 → 许可审计**。
 *
 * 这是 G0 定义的本地合并门禁（见 `docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md`）：
 * `pre-push` 钩子调用它，任何一步失败即阻断推送。
 *
 * 自 G6 起，`build` 之后多一步 **`smoke:build`**：用无头 Chrome 打开**打包产物**并断言它真的能起来
 * （此前没有任何门禁碰过 `dist/` —— 维护者的报文「打开 dist/index.html 空白」暴露了这个缺口；
 * 那个空白的直接原因是 ES module 在 `file://` 下被浏览器拒绝，见 README「预览打包产物」）。
 *
 * 之所以用 Node 脚本而不是 npm-run-all 之类的工具：
 * - 不引入额外依赖（依赖面本身就是本项目要守的东西）；
 * - 能给出"哪一步失败、如何单独复现"的明确输出；
 * - 跨平台一致（Windows 的 .cmd/.ps1 包装脚本不必特殊处理）。
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 门禁步骤。顺序刻意如此：
 * - lint 最便宜，先失败先退出；
 * - 类型检查先于测试，因为它能更早暴露机械性错误；
 * - 构建放在测试之后：测试不需要产物，构建最贵；
 * - 许可审计放最后（依赖没变时它没有信息量，但必须进同一道门）。
 */
const STEPS = [
  { name: 'lint', args: ['lint'] },
  { name: 'typecheck', args: ['typecheck'] },
  { name: 'test', args: ['test'] },
  { name: 'build', args: ['build'] },
  // 打包产物冒烟：用 HTTP 伺服 dist/ 并用无头 Chrome 断言"没有应用级错误、界面真的渲染了"。
  // 放在 build 之后（它测的就是产物）；缺 Chrome 时**失败而不是跳过**（P-12 口径）。
  { name: 'smoke:build', args: ['smoke:build'] },
  { name: 'license:check', args: ['license:check'] },
  // 文档结构检查放最后：它最便宜，但只有在工作区内容确定之后判定才有意义
  // （检查的是磁盘上的链接、锚点、台账与体量，规范见 docs/DOC-SPEC.md）。
  { name: 'docs:check', args: ['docs:check'] },
];

for (const [index, step] of STEPS.entries()) {
  const label = `[gate ${index + 1}/${STEPS.length}] pnpm ${step.name}`;
  console.log(`\n=== ${label} ===`);

  // 参数是编译期固定的字面量，不含外部输入。
  const result = spawnSync(`pnpm ${step.args.join(' ')}`, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });

  if (result.error !== undefined) {
    console.error(`\n[gate] 无法执行 ${step.name}：${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\n[gate] 失败于「${step.name}」（退出码 ${String(result.status)}）。`);
    console.error(`[gate] 单独复现：pnpm ${step.name}`);
    console.error('[gate] 推送已被阻断。确需绕过时用 `git push --no-verify`，并在提交信息里说明原因。');
    process.exit(result.status ?? 1);
  }
}

console.log(
    '\n[gate] 全部通过：lint / typecheck / test / build / smoke:build / license:check / docs:check。',
  );
