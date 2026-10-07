#!/usr/bin/env node
/**
 * **本机 Chrome 的收尾闸**（`scripts/` 共用；零新增依赖）。
 *
 * ## 为什么存在
 *
 * G6 之后的自动化（`smoke-build.mjs` / `measure-render.mjs`）会自己拉起无头 Chrome。
 * 收尾一旦写成"按名字杀 `chrome.exe`"，就会把**维护者正在用的那个浏览器**一起关掉——
 * 这类事故没有可逆性。所以这里把收尾**绑死在临时 profile 上**：
 *
 * 1. **正常路径根本不杀进程**：读 `<profileDir>/DevToolsActivePort` 的第二行
 *    （`/devtools/browser/<uuid>`），连**浏览器级** WebSocket 发 `Browser.close`——
 *    协议级关闭，物理上不可能波及其它实例；
 * 2. **兜底只按 PID**：只在协议级关闭失败时动手，且只杀**我们 spawn 的那个 PID 的整棵树**
 *    （`taskkill /PID <pid> /T /F`，Windows；其余平台 `SIGKILL` 到进程组）；
 * 3. **动手前先过闸**：profile 目录必须落在 `<repo>/tmp/<已知 profile 根>/<时间戳>` 之下，
 *    且该 PID 的命令行里带 `--headless` 与 `--user-data-dir=<同一个 profile>`——
 *    维护者日常那个实例**连 `--user-data-dir` 都没有**，结构上过不了这道闸。
 *
 * 判定逻辑全是纯函数（`scripts/` 不在 vitest 的**包内**收集面里），所以单独配一份自检。
 * P3/C7-f 起它**转成 vitest spec**（`scripts/chrome-harness.spec.mjs`）⇒ 随 `pnpm test` 步进 `pnpm gate`：
 *
 *   npx vitest run scripts/chrome-harness.spec.mjs    # 纯函数自检（不需要 Chrome）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { repoRoot } from './paths.mjs';

// 单点声明在 `paths.mjs`（P3/C1：原先这里与 11 个脚本各写一遍）；这里原样再导出，
// 保持本文件既有的公开面（`chrome-harness.spec.mjs` 从这里取 repoRoot）。
export { repoRoot };

/** `tmp/` 下允许被用于无头 Chrome 的 profile 根（**白名单**：不是任意目录）。 */
export const PROFILE_ROOT_NAMES = [
  'smoke-profile',
  /** `smoke:build --file`（离线单文件，P-49）用的 profile 根；与在线产物分开，便于并行取证。 */
  'offline-profile',
  'measure-chrome-profile',
  'ui-shot-profile',
  'batch-c-profile',
];

export const profileDirFor = (name) => join(repoRoot, 'tmp', name, String(Date.now()));

/**
 * 超期 profile 的保留窗口（P3/C7-g）。
 *
 * 为什么是 24 小时而不是"清光所有兄弟"：并行的两条链（两个终端、或测量与冒烟同时跑）
 * 各自的 profile 都是"新"的，年龄窗口保证只回收**没人再用**的那些。
 */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 回收 `tmp/<白名单根>/<时间戳>` 下**超期**的 profile 目录，返回被回收的条目（`<根名>/<时间戳>`）。
 *
 * ## 为什么需要它
 *
 * `chrome-harness` 每次运行都新建带时间戳的 profile 且从不回收：P3/C7-g 实测累计
 * **1,181 MB / 26,230 文件**（其中 802 MB 是 C7 立项时的读数，之后又长出 379 MB）。
 * 这些是可再生的中间物，不清理只会让 `tmp/` 变成"没人敢删的黑洞"。
 *
 * ## 清理点为什么在 `ensureProfileDir` 里
 *
 * 那是**所有**拉起路径的唯一入口（`scripts/cdp.mjs` 的 `spawnChrome` 是唯一调用方），
 * 把清理与 profile 闸放在同一处，就不会有"某条链忘了清"的破口。
 *
 * ## 判据怎么可测
 *
 * `now` / `olderThanMs` / `root` 都可注入 ⇒ 自检能在**造出来的目录树**上确定性地
 * 证明"超期的走、未超期的留"（不去碰真实的那 1,181 MB）。
 */
export function pruneStaleProfiles({ root = repoRoot, now = Date.now(), olderThanMs = PROFILE_MAX_AGE_MS } = {}) {
  const removed = [];
  for (const name of PROFILE_ROOT_NAMES) {
    const family = join(root, 'tmp', name);
    let entries;
    try {
      entries = readdirSync(family, { withFileTypes: true });
    } catch {
      continue; // 该白名单根还不存在：正常
    }
    for (const entry of entries) {
      // 只认"时间戳目录"这一种形状：别的东西（手放的草稿、半成品）一律不碰。
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      if (now - Number(entry.name) <= olderThanMs) continue;
      try {
        rmSync(join(family, entry.name), { recursive: true, force: true });
        removed.push(`${name}/${entry.name}`);
      } catch {
        // 并发删除 / 文件被占用：留给下一次（清理不是判据，失败不该让任何一步红）
      }
    }
  }
  return removed;
}

/** 是否是被允许的临时 profile 目录（形状：`<repo>/tmp/<白名单名>/<时间戳>`）。 */
export function isAllowedProfileDir(dir, root = repoRoot) {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false;
  const rel = relative(join(root, 'tmp'), resolve(dir));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const [name, stamp, ...rest] = rel.split(/[\\/]/);
  if (rest.length > 0) return false;
  return PROFILE_ROOT_NAMES.includes(name) && /^\d+$/.test(stamp ?? '');
}

/**
 * 这条命令行是否属于"用 `profileDir` 起的无头 Chrome"。
 *
 * 判定的是 **PID 的身份**，不是 PID 的数字：数字查错了也过不了这道闸。
 */
export function isOwnChromeCommandLine(cmd, profileDir) {
  if (typeof cmd !== 'string' || cmd === '') return false;
  if (!cmd.includes('--headless')) return false;
  const flag = `--user-data-dir=${profileDir}`;
  return cmd.includes(flag) || cmd.includes(`"${flag}"`);
}

/** 闸：不满足就抛（收尾路径上由调用方决定是"记录并放弃"还是"直接失败"）。 */
export function assertOwnProfile(dir, root = repoRoot) {
  if (!isAllowedProfileDir(dir, root)) {
    throw new Error(
      `拒绝在非临时 profile 上动手：${String(dir)}（只允许 ${join(root, 'tmp')} 下白名单 profile 的子目录）`,
    );
  }
  return dir;
}

/**
 * 该 PID 是否确实是"用这个 profile 起的无头 Chrome"。
 *
 * 判定全部由注入的 `lookup` 提供（真实调用点传 `ps()`），所以这条闸在测试里也能跑。
 * 判定不出来（进程已退出 / 拿不到命令行）⇒ 返回 false，即**拒绝动手**。
 */
export function isOwnChromePid(pid, profileDir, lookup) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmd = lookup(pid);
  return isOwnChromeCommandLine(cmd, profileDir);
}

/** 读 `DevToolsActivePort`（首行端口 / 次行浏览器级 WebSocket 路径）。 */
export function readDevToolsEndpoint(profileDir) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(portFile)) return null;
  const lines = readFileSync(portFile, 'utf8').split('\n');
  const port = Number(lines[0]);
  const path = (lines[1] ?? '').trim();
  if (!Number.isInteger(port) || port <= 0 || !path.startsWith('/')) return null;
  return { port, path };
}

/**
 * 用**浏览器级** WebSocket 发 `Browser.close`（协议级关闭；失败返回原因，不抛）。
 *
 * 不连页目标：页目标在 runner 里可能已经被我们自己关掉，而浏览器级端点读
 * `DevToolsActivePort` 第二行即可，稳且少一次 HTTP 往返。
 */
export async function closeBrowserViaCdp(port, browserPath, timeoutMs = 10_000) {
  const url = `ws://127.0.0.1:${String(port)}${browserPath}`;
  const socket = new WebSocket(url);
  return await new Promise((settle) => {
    let opened = false;
    const done = (value) => {
      try {
        socket.close();
      } catch {
        // 已关闭：忽略
      }
      settle(value);
    };
    const timer = setTimeout(() => done('Browser.close 超时'), timeoutMs);
    socket.addEventListener('open', () => {
      opened = true;
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch (error) {
        clearTimeout(timer);
        done(`Browser.close 发送失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    socket.addEventListener('message', () => {
      clearTimeout(timer);
      done(null);
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      done(opened ? null : 'CDP WebSocket 未建立');
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      done('CDP WebSocket 连接失败');
    });
  });
}

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

/** 该 PID 是否还在（`ps` 返回空即不在）。 */
function isAlive(pid, lookup) {
  return lookup(pid) !== '';
}

/** 兜底：只杀"这一个 PID 的整棵树"（**绝不按名字**）。 */
export function killProcessTree(pid, platform = process.platform) {
  if (platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return result.status === 0;
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * 收尾一个由我们拉起的无头 Chrome：**先协议级关闭，失败才按 PID 树兜底**。
 *
 * 全程过闸（见文件头三条）；任何一步判定不过，就**放弃动手并如实报告**，
 * 由调用方决定是否让脚本失败。返回值只用于日志与自检。
 */
export async function closeOwnChrome({ profileDir, pid, lookup, kill = killProcessTree, timeoutMs = 10_000 }) {
  const outcome = { closedBy: 'none', note: '', killed: false };
  try {
    assertOwnProfile(profileDir);
  } catch (error) {
    outcome.note = error instanceof Error ? error.message : String(error);
    return outcome;
  }
  const alive = Number.isInteger(pid) && pid > 0 && isAlive(pid, lookup);
  if (alive && !isOwnChromePid(pid, profileDir, lookup)) {
    outcome.note = `PID ${String(pid)} 的命令行与 profile 不符：拒绝关闭`;
    return outcome;
  }
  const endpoint = alive ? readDevToolsEndpoint(profileDir) : null;
  if (endpoint !== null) {
    const failure = await closeBrowserViaCdp(endpoint.port, endpoint.path, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid, lookup)) {
        outcome.closedBy = 'cdp';
        return outcome;
      }
      await sleep(120);
    }
    outcome.note = `协议级关闭未在 ${String(timeoutMs)}ms 内生效${failure === null ? '' : `（${failure}）`}`;
  } else if (alive) {
    outcome.note = '没有可用的 DevToolsActivePort（无法协议级关闭）';
  }
  if (alive && isOwnChromePid(pid, profileDir, lookup)) {
    outcome.killed = kill(pid);
    outcome.closedBy = outcome.killed ? 'pid-tree' : 'none';
  }
  return outcome;
}

/** 真实调用点用的"读命令行"实现：**同步**（闸必须在动手前立刻判定完），失败/查不到即空串。 */
export function psCommandLine(pid) {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true },
    );
    return typeof result.stdout === 'string' ? result.stdout.trim() : '';
  }
  const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/** 幂等建目录（Chrome 自己也会建，这里只是让"开跑前断言"有东西可指向）。 */
export function ensureProfileDir(dir) {
  assertOwnProfile(dir);
  // 建**本轮**的 profile 之前，顺手回收超期的同族 profile（P3/C7-g：实测累计 1,181 MB）。
  const pruned = pruneStaleProfiles();
  if (pruned.length > 0) {
    console.log(
      `[chrome-harness] 回收超期 profile ${String(pruned.length)} 个（>${String(PROFILE_MAX_AGE_MS / 3_600_000)}h）：${pruned.slice(0, 5).join('、')}${pruned.length > 5 ? ' …' : ''}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
