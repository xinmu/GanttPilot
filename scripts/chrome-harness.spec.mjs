/**
 * `scripts/chrome-harness.mjs` 的**纯函数自检**（P3/C7-f：**转成 vitest spec**，因此随 `pnpm test` 步进 `pnpm gate`）。
 *
 * ## 它守的是什么
 *
 * 收尾无头 Chrome 是**不可逆**的动作（"按名字杀 `chrome.exe`"会把维护者正在用的浏览器一起关掉）。
 * 这条判据的代码只有 `scripts/chrome-harness.mjs` 一份，回归测试也只有这一份——转成 spec 之前，
 * 它**不在门禁里**（只有记得手动跑 `node scripts/chrome-harness.selftest.mjs` 时才被执行）。
 *
 * ## 为什么是 "转 spec" 而不是 "加一个门禁步"
 *
 * 加一步要改 `STEPS`（`scripts/gate.mjs`），而那是**门禁契约**：按 [ADR 0001 §门禁](docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md)
 * 必须同步 ADR 与 `.github/workflows/ci.yml`（"九步"在活文档与 CI 里都有名字）。转成 spec 则**零契约变更**：
 * `test` 步的覆盖面变大，本地与 CI 一起受益，且断言有名字、失败能定位到具体一条。
 *
 * ## 覆盖要求（**不需要 Chrome**，但需要能 spawn 进程 / 读命令行）
 *
 * 用假的 `lookup` 直接喂命令行，因此"PID 查错 / 命令行不符 / profile 越界"三条都必须证明为**拒绝动手**；
 * 另有几条走**真实实现**（`psCommandLine` 必须同步、`killProcessTree` 只杀指定的那棵树）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROFILE_ROOT_NAMES,
  assertOwnProfile,
  closeOwnChrome,
  isAllowedProfileDir,
  isOwnChromeCommandLine,
  isOwnChromePid,
  killProcessTree,
  pruneStaleProfiles,
  psCommandLine,
  readDevToolsEndpoint,
  repoRoot,
} from './chrome-harness.mjs';

const own = join(repoRoot, 'tmp', 'smoke-profile', '1791143783483');
const ownCmd = `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --headless=new --user-data-dir=${own} about:blank`;

describe('profile 白名单闸（只允许 tmp/<白名单根>/<时间戳>）', () => {
  it('接受 tmp/<白名单>/<时间戳>', () => {
    expect(isAllowedProfileDir(own)).toBe(true);
  });

  it('拒绝再深一层 / 缺时间戳 / 前缀相似名 / 非白名单根', () => {
    expect(isAllowedProfileDir(`${own}\\Default`)).toBe(false);
    expect(isAllowedProfileDir(join(repoRoot, 'tmp', 'some-other-profile', '1'))).toBe(false);
    expect(isAllowedProfileDir(join(repoRoot, 'tmp', 'smoke-profile'))).toBe(false);
    expect(isAllowedProfileDir(join(repoRoot, 'tmp', 'smoke-profile-evil', '1'))).toBe(false);
  });

  it('中间有 `..` 但最终仍落在 tmp 下 ⇒ 接受；绕出 tmp 之外 ⇒ 拒绝', () => {
    expect(isAllowedProfileDir(join(repoRoot, 'tmp', '..', 'tmp', 'smoke-profile', '1'))).toBe(true);
    expect(isAllowedProfileDir(join(repoRoot, 'tmp', '..', 'packages', 'smoke-profile', '1'))).toBe(false);
  });

  it('拒绝日常 Chrome 的默认 profile 与相对路径', () => {
    expect(isAllowedProfileDir('C:\\Users\\Pro.WANG\\AppData\\Local\\Google\\Chrome\\User Data')).toBe(false);
    expect(isAllowedProfileDir('relative/smoke-profile/1')).toBe(false);
  });

  it('每个白名单根名都可用（名单是唯一的真相处）', () => {
    for (const name of PROFILE_ROOT_NAMES) {
      expect(isAllowedProfileDir(join(repoRoot, 'tmp', name, '123')), name).toBe(true);
    }
  });
});

describe('PID 身份闸（判定的是命令行，不是 PID 的数字）', () => {
  it('带 `--headless` 且 `user-data-dir` 相符才认', () => {
    expect(isOwnChromeCommandLine(ownCmd, own)).toBe(true);
    expect(isOwnChromeCommandLine(ownCmd.replace('--headless=new', '--headless'), own)).toBe(true);
  });

  it('缺 `--headless` / `user-data-dir` 不符 / 空命令行 ⇒ 一律拒', () => {
    expect(isOwnChromeCommandLine(`"chrome.exe" --user-data-dir=${own}`, own)).toBe(false);
    expect(isOwnChromeCommandLine('--headless=new --user-data-dir=C:\\other', own)).toBe(false);
    expect(isOwnChromeCommandLine('', own)).toBe(false);
  });

  it('isOwnChromePid：命令行相符才认；日常实例 / 查不到 / 非法 PID ⇒ 拒', () => {
    expect(isOwnChromePid(1234, own, () => ownCmd)).toBe(true);
    expect(isOwnChromePid(17056, own, () => '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ')).toBe(false);
    expect(isOwnChromePid(17056, own, () => '')).toBe(false);
    expect(isOwnChromePid(0, own, () => ownCmd)).toBe(false);
  });

  it('assertOwnProfile：合法时原样返回，越界时抛错', () => {
    expect(assertOwnProfile(own)).toBe(own);
    expect(() => {
      assertOwnProfile('C:\\Users\\Pro.WANG\\AppData\\Local\\Google\\Chrome\\User Data');
    }).toThrow();
  });
});

describe('closeOwnChrome 的三条闸（注入 lookup / kill）', () => {
  it('① profile 越界 ⇒ 即便 PID 与命令行都"对"，也不动手', async () => {
    let kills = 0;
    const outcome = await closeOwnChrome({
      profileDir: 'C:\\Users\\Pro.WANG\\AppData\\Local\\Google\\Chrome\\User Data',
      pid: 17056,
      lookup: () => ownCmd,
      kill: () => {
        kills += 1;
        return true;
      },
    });

    expect(outcome.killed).toBe(false);
    expect(outcome.closedBy).toBe('none');
    expect(outcome.note).toContain('拒绝');
    expect(kills).toBe(0);
  });

  it('② PID 与 profile 不符 ⇒ 不 kill，并给出不符原因', async () => {
    let kills = 0;
    const outcome = await closeOwnChrome({
      profileDir: own,
      pid: 17056,
      lookup: () => `chrome.exe --headless=new --user-data-dir=${join(repoRoot, 'tmp', 'smoke-profile', '999')}`,
      kill: () => {
        kills += 1;
        return true;
      },
    });

    expect(outcome.closedBy).toBe('none');
    expect(outcome.note).toContain('不符');
    expect(kills).toBe(0);
  });

  it('③ 进程已退出 ⇒ 什么都不做（也不算失败）', async () => {
    let kills = 0;
    const outcome = await closeOwnChrome({
      profileDir: own,
      pid: 4242,
      lookup: () => '',
      kill: () => {
        kills += 1;
        return true;
      },
    });

    expect(outcome.closedBy).toBe('none');
    expect(kills).toBe(0);
  });

  it('④ 命令行相符但没有 DevToolsActivePort ⇒ 按 PID 树兜底一次（仍然过闸）', async () => {
    const scratch = join(repoRoot, 'tmp', 'smoke-profile', '9999999999');
    let kills = 0;
    try {
      mkdirSync(scratch, { recursive: true });
      const outcome = await closeOwnChrome({
        profileDir: scratch,
        pid: 9001,
        lookup: () => `chrome.exe --headless=new --user-data-dir=${scratch}`,
        kill: () => {
          kills += 1;
          return true;
        },
        timeoutMs: 0,
      });

      expect(outcome.closedBy).toBe('pid-tree');
      expect(kills).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('readDevToolsEndpoint：没有该文件 / 坏文件 ⇒ null，正常文件可解析', () => {
    const scratch = join(repoRoot, 'tmp', 'smoke-profile', '9999999998');
    try {
      mkdirSync(scratch, { recursive: true });
      expect(readDevToolsEndpoint(scratch)).toBeNull();
      writeFileSync(join(scratch, 'DevToolsActivePort'), '7151\n/devtools/browser/abc\n', 'utf8');
      expect(readDevToolsEndpoint(scratch)).toStrictEqual({ port: 7151, path: '/devtools/browser/abc' });
      writeFileSync(join(scratch, 'DevToolsActivePort'), 'not-a-port\n', 'utf8');
      expect(readDevToolsEndpoint(scratch)).toBeNull();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('真实实现（不是注入的假函数）', () => {
  it(
    'psCommandLine **同步**返回自己的命令行（一旦返回 Promise，闸会每次都拒绝关闭 ⇒ 无人收尾）',
    async () => {
      // **刻意不 `await`**：闸（`isOwnChromePid`）就是同步取 `lookup(pid)` 的返回值的，
      // 一旦那里变成 Promise，`isOwnChromeCommandLine` 会判定"不是字符串"⇒ 每次都拒绝动手。
      // P3/C7-f 的负向对照抓到：转换时若写成 `await psCommandLine(...)`，这条断言**就没牙了**
      // （`await` 会把 Promise 拆开，`typeof` 仍然是 `string`）。
      const selfCmd = psCommandLine(process.pid);

      expect(typeof selfCmd).toBe('string');
      expect(selfCmd).not.toBe('');
      // 读不到的命令行必须是空串（= 拒绝动手），而不是抛错或 `undefined`。
      expect(await psCommandLine(999_999_999)).toBe('');
    },
    20_000,
  );

  it(
    'killProcessTree 只杀指定的那个 PID（拉一个替身进程，杀它，且自己不受影响）',
    async () => {
      const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      try {
        await new Promise((settle) => setTimeout(settle, 800));
        expect(killProcessTree(victim.pid)).toBe(true);
        await new Promise((settle) => setTimeout(settle, 800));
        expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);
        expect(await psCommandLine(process.pid)).not.toBe('');
      } finally {
        if (victim.exitCode === null && victim.signalCode === null) victim.kill();
      }
    },
    30_000,
  );
});

describe('超期 profile 的回收（P3/C7-g）', () => {
  it('超期的走、未超期的留、非时间戳形状的一律不碰', () => {
    // 造一棵**自己的**目录树（真实那 1,181 MB 不参与判据：确定性 + 别在测试里删 26,000 个文件）。
    const scratchRoot = join(repoRoot, 'tmp', 'prune-probe-root');
    const family = join(scratchRoot, 'tmp', 'smoke-profile');
    const stale = join(family, '1000'); // 1970 年的时间戳 ⇒ 必然超期
    const fresh = join(family, String(Date.now()));
    const other = join(family, 'not-a-stamp'); // 手放的草稿：不是时间戳目录
    try {
      for (const dir of [stale, fresh, other]) mkdirSync(dir, { recursive: true });

      const removed = pruneStaleProfiles({ root: scratchRoot, now: Date.now(), olderThanMs: 60_000 });

      expect(removed).toStrictEqual(['smoke-profile/1000']);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('窗口足够宽时什么都不删（负向对照：清理不是"清光"）', () => {
    const scratchRoot = join(repoRoot, 'tmp', 'prune-probe-root-nc');
    const stale = join(scratchRoot, 'tmp', 'smoke-profile', '1000');
    try {
      mkdirSync(stale, { recursive: true });

      expect(pruneStaleProfiles({ root: scratchRoot, olderThanMs: Number.MAX_SAFE_INTEGER })).toStrictEqual([]);
      expect(existsSync(stale)).toBe(true);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
