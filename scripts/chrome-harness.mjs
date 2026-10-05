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
 * 判定逻辑全是纯函数（`scripts/` 不在 vitest 的收集范围内），所以单独配一份自检：
 *
 *   node scripts/chrome-harness.selftest.mjs    # 纯函数自检（不需要 Chrome）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `tmp/` 下允许被用于无头 Chrome 的 profile 根（**白名单**：不是任意目录）。 */
export const PROFILE_ROOT_NAMES = [
  'smoke-profile',
  'measure-chrome-profile',
  'ui-shot-profile',
  'batch-c-profile',
];

export const profileDirFor = (name) => join(repoRoot, 'tmp', name, String(Date.now()));

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
  mkdirSync(dir, { recursive: true });
  return dir;
}
