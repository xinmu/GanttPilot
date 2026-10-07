#!/usr/bin/env node
/**
 * `pnpm gate` 的实现：**安装 → Lint → 构建 → 类型检查 → 测试 → 构建冒烟 → 离线单文件 → 许可审计 → 文档检查**。
 * （**顺序的权威定义是下面的 `STEPS`**；改动它等于改动门禁契约，须同步 ADR 0001 与附录增补。）
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
import { repoRoot } from './paths.mjs';

/**
 * 门禁步骤。顺序刻意如此：
 * - lint 最便宜，先失败先退出；
 * - **构建必须先于类型检查**：消费者的 `typecheck` 是经由各包的 `exports.types` → `dist/*.d.ts`
 *   解析工作区依赖的（`render-core` / `web` 依赖 `@ganttpilot/engine` 等），而 `dist/` **不入库**
 *   （见 `.gitignore`）。若 typecheck 先跑，**干净克隆上的门禁必然失败**——本地之所以长期为绿，
 *   只是因为工作区里残留着上一轮的 `dist/`。这不是步骤风格问题，是正确性问题：
 *   机制、实测与代价见 `docs/02-adr/附录/0001-增补.md`；
 * - test 不依赖产物，紧随类型检查（机械性错误仍先于测试暴露）；
 * - 许可证审计与文档检查收尾（依赖没变时许可审计没有信息量，但必须进同一道门）。
 */
const STEPS = [
  { name: 'lint', args: ['lint'] },
  // 构建必须在 typecheck 之前（原因见上）。代价：最贵的一步提前，且不再"先报类型错再构建"。
  { name: 'build', args: ['build'] },
  { name: 'typecheck', args: ['typecheck'] },
  { name: 'test', args: ['test'] },
  // 打包产物冒烟：用 HTTP 伺服 dist/ 并用无头 Chrome 断言"没有应用级错误、界面真的渲染了"。
  // 放在 build 之后（它测的就是产物）；缺 Chrome 时**失败而不是跳过**（P-12 口径）。
  // G8 起它同时承载 P-46/P-48 的四组应用层判据：两级刻度 + 悬停行高亮 + 模板下载→回导 +
  // 向右拖远不白屏（这几件事都是 DOM 事实，按 P-40 的两条通道口径落在这里）。
  { name: 'smoke:build', args: ['smoke:build'] },
  // **离线单文件分发**（P-49）：先出单文件产物（含形状判据），再以 `file://` 打开它跑三条主链路。
  // 两步都在 `build` 之后；缺 Chrome 同样失败而不是跳过。
  { name: 'bundle:offline', args: ['bundle:offline'] },
  { name: 'smoke:build:file', args: ['smoke:build:file'] },
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
    '\n[gate] 全部通过：lint / build / typecheck / test / smoke:build / bundle:offline / smoke:build:file / license:check / docs:check。',
  );
