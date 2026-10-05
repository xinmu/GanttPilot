#!/usr/bin/env node
/**
 * `scripts/chrome-harness.mjs` 的**纯函数自检**（不进 `pnpm gate`，不需要 Chrome）。
 *
 * 它守的是那条**不可逆**的判据：收尾只允许命中"临时 profile 绑定的无头 Chrome"。
 * 这里用假的 `lookup` 直接喂命令行，因此"PID 查错 / 命令行不符 / profile 越界"三条
 * 都必须证明为**拒绝动手**。
 *
 * 用法：node scripts/chrome-harness.selftest.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILE_ROOT_NAMES,
  assertOwnProfile,
  closeOwnChrome,
  isAllowedProfileDir,
  isOwnChromeCommandLine,
  isOwnChromePid,
  killProcessTree,
  psCommandLine,
  readDevToolsEndpoint,
  repoRoot,
} from './chrome-harness.mjs';

let failed = 0;
let passed = 0;

/** @param {boolean} ok @param {string} label */
function check(ok, label) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}`);
  }
}

const own = join(repoRoot, 'tmp', 'smoke-profile', '1791143783483');
const ownCmd = `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --headless=new --user-data-dir=${own} about:blank`;

console.log('[harness] isAllowedProfileDir');
check(isAllowedProfileDir(own) === true, '接受 tmp/<白名单>/<时间戳>');
check(isAllowedProfileDir(own + '\\Default') === false, '拒绝再深一层');
check(isAllowedProfileDir(join(repoRoot, 'tmp', 'some-other-profile', '1')) === false, '拒绝非白名单 profile 根');
check(isAllowedProfileDir(join(repoRoot, 'tmp', 'smoke-profile')) === false, '拒绝缺时间戳');
check(isAllowedProfileDir(join(repoRoot, 'tmp', 'smoke-profile-evil', '1')) === false, '拒绝前缀相似名');
check(isAllowedProfileDir(join(repoRoot, 'tmp', '..', 'tmp', 'smoke-profile', '1')) === true, '中间有 .. 但最终仍落在 tmp 下 ⇒ 接受');
check(isAllowedProfileDir(join(repoRoot, 'tmp', '..', 'packages', 'smoke-profile', '1')) === false, '绕出 tmp 之外 ⇒ 拒绝');
check(
  isAllowedProfileDir('C:\\Users\\Pro.WANG\\AppData\\Local\\Google\\Chrome\\User Data') === false,
  '拒绝日常 Chrome 的默认 profile',
);
check(isAllowedProfileDir('relative/smoke-profile/1') === false, '拒绝相对路径');
for (const name of PROFILE_ROOT_NAMES) {
  check(isAllowedProfileDir(join(repoRoot, 'tmp', name, '123')) === true, `白名单根可用：${name}`);
}

console.log('[harness] isOwnChromeCommandLine / isOwnChromePid');
check(isOwnChromeCommandLine(ownCmd, own) === true, '带 --headless 且 user-data-dir 相符');
check(isOwnChromeCommandLine(ownCmd.replace('--headless=new', '--headless'), own) === true, '--headless 无值也认');
check(isOwnChromeCommandLine(`"chrome.exe" --user-data-dir=${own}`, own) === false, '缺 --headless 即拒');
check(isOwnChromeCommandLine('--headless=new --user-data-dir=C:\\other', own) === false, 'user-data-dir 不符即拒');
check(isOwnChromeCommandLine('', own) === false, '空命令行即拒');
check(isOwnChromePid(1234, own, () => ownCmd) === true, '命令行相符 ⇒ 认这个 PID');
check(isOwnChromePid(17056, own, () => '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ') === false, '日常实例（无 user-data-dir）⇒ 拒');
check(isOwnChromePid(17056, own, () => '') === false, '查不到命令行 ⇒ 拒');
check(isOwnChromePid(0, own, () => ownCmd) === false, '非法 PID ⇒ 拒');

console.log('[harness] assertOwnProfile');
check(assertOwnProfile(own) === own, '合法时原样返回');
let threw = false;
try {
  assertOwnProfile('C:\\Users\\Pro.WANG\\AppData\\Local\\Google\\Chrome\\User Data');
} catch {
  threw = true;
}
check(threw, '越界时抛错');

console.log('[harness] closeOwnChrome 的三条闸（注入 lookup / kill）');
const calls = { kill: 0 };
const killSpy = () => {
  calls.kill += 1;
  return true;
};

// ① profile 越界：即便 PID 与命令行都"对"，也必须拒绝
let outcome = await closeOwnChrome({
  profileDir: 'C:\\Users\\Pro.WANG\\AppData\\Local\\Google\\Chrome\\User Data',
  pid: 17056,
  lookup: () => ownCmd,
  kill: killSpy,
});
check(outcome.killed === false && outcome.closedBy === 'none', '① profile 越界 ⇒ 不动手');
check(outcome.note.includes('拒绝'), '① 给出了拒绝原因');

// ② PID 查错（命令行指的是别的 profile）：必须拒绝，且不 kill
calls.kill = 0;
outcome = await closeOwnChrome({
  profileDir: own,
  pid: 17056,
  lookup: () => `chrome.exe --headless=new --user-data-dir=${join(repoRoot, 'tmp', 'smoke-profile', '999')}`,
  kill: killSpy,
});
check(outcome.closedBy === 'none' && calls.kill === 0, '② PID 与 profile 不符 ⇒ 不 kill');
check(outcome.note.includes('不符'), '② 给出了不符原因');

// ③ 进程已退出：什么都不做，不算失败
calls.kill = 0;
outcome = await closeOwnChrome({ profileDir: own, pid: 4242, lookup: () => '', kill: killSpy });
check(outcome.closedBy === 'none' && calls.kill === 0, '③ 进程已退出 ⇒ 不 kill');

// ④ 命令行相符但没有 DevToolsActivePort：只能按 PID 树兜底（仍然过闸）
const scratch = join(repoRoot, 'tmp', 'smoke-profile', '9999999999');
mkdirSync(scratch, { recursive: true });
calls.kill = 0;
outcome = await closeOwnChrome({
  profileDir: scratch,
  pid: 9001,
  lookup: () => `chrome.exe --headless=new --user-data-dir=${scratch}`,
  kill: killSpy,
  timeoutMs: 0,
});
check(outcome.closedBy === 'pid-tree' && calls.kill === 1, '④ 无端口 + 命令行相符 ⇒ 按 PID 树兜底一次');

console.log('[harness] readDevToolsEndpoint');
check(readDevToolsEndpoint(scratch) === null, '没有该文件 ⇒ null');
writeFileSync(join(scratch, 'DevToolsActivePort'), '7151\n/devtools/browser/abc\n', 'utf8');
const endpoint = readDevToolsEndpoint(scratch);
check(endpoint !== null && endpoint.port === 7151 && endpoint.path === '/devtools/browser/abc', '正常文件可解析');
writeFileSync(join(scratch, 'DevToolsActivePort'), 'not-a-port\n', 'utf8');
check(readDevToolsEndpoint(scratch) === null, '坏文件 ⇒ null');
rmSync(scratch, { recursive: true, force: true });

console.log('[harness] 真实实现（不是注入的假函数）');
// 守一条真实发生过的回归：lookup 必须是**同步**的。一旦它返回 Promise，
// `isOwnChromeCommandLine` 会判定"不是字符串"⇒ 每次都拒绝关闭 ⇒ 无人收尾。
const selfCmd = await psCommandLine(process.pid);
check(
  typeof selfCmd === 'string' && selfCmd.includes('chrome-harness.selftest.mjs'),
  'psCommandLine 同步返回自己的命令行（typeof string）',
);
check((await psCommandLine(999_999_999)) === '', '不存在的 PID ⇒ 空串（即拒绝动手）');

// 兜底只杀"这一个 PID"：拉一个替身进程，杀掉它，且证明其它进程不受影响。
const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
await new Promise((settle) => setTimeout(settle, 800));
check(killProcessTree(victim.pid) === true, 'killProcessTree 命中替身进程');
await new Promise((settle) => setTimeout(settle, 800));
check(victim.exitCode !== null || victim.signalCode !== null, '替身进程已退出');
check((await psCommandLine(process.pid)) !== '', '自己（本脚本进程）不受影响');

console.log('');
if (failed > 0) {
  console.error(`[harness] 自检失败：${String(failed)} 项（通过 ${String(passed)} 项）`);
  process.exit(1);
}
console.log(`[harness] 自检通过：${String(passed)} 项`);
