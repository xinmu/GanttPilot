import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * `prepare` 钩子：把 git hooks 路径指到 `.husky/`。
 *
 * 刻意不依赖 husky 的内部机制，只做一件事：`git config core.hooksPath .husky`。
 * 之所以不直接写 `husky`，是因为 `prepare` 也会在无 git 仓库（打包、CI 浅克隆）时执行，
 * 那种情况下必须静默跳过而不是报错中断安装。
 */

if (existsSync('.git')) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { stdio: 'inherit' });
    console.log('[ganttpilot] git hooks 已安装：core.hooksPath=.husky（pre-push 将运行 pnpm gate）');
  } catch (error) {
    console.warn('[ganttpilot] 未能设置 core.hooksPath，请手动执行：pnpm hooks:install');
    console.warn(String(error));
  }
} else {
  console.log('[ganttpilot] 未检测到 .git，跳过 git hooks 安装');
}
