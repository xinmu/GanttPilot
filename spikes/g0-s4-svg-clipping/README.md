# spike：G4-S · SVG 裁剪有效性、浏览器首屏与滚动定标

> **这是 spike 代码，不属于产品主干。** 结论见 [结论.md](结论.md)。
>
> 铁律（[证伪实验计划 §Spike-4](../../docs/00-baseline/证伪实验计划.md)）：**探针代码不进主干**。
> 本目录只交付"裁剪是否成立 + 数字是多少"，外加 **P-8 遗留 1/2**（同为 G4 准入）；
> 几何与裁剪的产品实现由能力块 **G4** 在 `packages/render-core` 重写，届时**本目录应整体删除**。

## 一句话结论

**裁剪成立**：在正确求交下，元素数与文档总规模解耦（200 → 2,000 任务只从 317 → 350 个元素，
而关掉裁剪是 1,348 → 14,439）；求交**必须**做（仅按端点可见性会误裁 314 条边、其中 268 条跨屏长边）；
首屏（就绪→含依赖线首帧）**22–25 ms**、10× 滚动 **165 ms**（对《评估报告》§5.4 的 2,200 边 / 约 2.0s 是同尺反例的 1/12）。
四条门禁 `S4-a`…`S4-d` **全部通过**，ADR 0007 §11 的七项数值**全部回填**。

## 它回答什么（对应《证伪实验计划》Spike-4 的四个问题）

1. **裁剪真的成立吗？** → `S4-a`：`#elements ≤ c₁·visibleRows + c₂·visibleEdges + c₃`，
   且 10× 规模跨度下元素总数只涨 **1.104×**（关掉裁剪是 **10.71×**）。
2. **浏览器侧的真实数字是多少？** → `S4-c`：首屏 22.4 / 24.4 / 21.6 ms（日/周/月），
   10× 滚动总墙钟 165.5 ms（1,500 边与 2,200 边两组都在这个量级）。
3. **"边所跨行区间 ∩ 可见行窗口"的求交是必需的吗？** → `S4-b`：换成端点可见性会丢 314 条边。
4. **定性措辞该落成什么判据/口径/数值？** → 见 [结论.md](结论.md) §二与 §四（含三条口径澄清）。

另外两项 **P-8 遗留**（同为本轮 G4 准入）：

- **遗留 1**：`idx_OOXML = COM − 1` 在**四个站点**上全部实测成立（含横向样本 COM 4/2 → `idx=3`/`idx=1`）；
- **遗留 2**："右出 → 左入"肘形在 WPS 上的量化复测 5/5 通过，并发现 **WPS 用 `rot`/`flip` 规范化竖直肘形**
  （G7 还原几何必须先读 `rot`/`flip`）。

## 为什么它不污染主干

- **不在 `pnpm-workspace.yaml` 内**（根 workspace 只含 `packages/*` 与 `apps/*`），
  因此 `pnpm -r build` / `typecheck` / `license:check` 都不覆盖它；
- **零运行时依赖**（只有 `@types/node` 开发依赖，靠祖先 `node_modules` 解析即可，**无需单独安装**；
  需要隔离安装时用 `pnpm install --ignore-workspace`）：浏览器计时用 Node 内置 `fetch` + `WebSocket`
  驱动**本机 Chrome**（CDP），静态资源用 `node:http` 提供；
- `out/` 与 `node_modules/` 已在根 `.gitignore` 忽略（工件可再生、证据不可再生）；
- `spikes/**` 仍在 `pnpm lint` 的覆盖内（有意识的例外），代价是 lint 会扫到这里。

## 目录

```
src/manifest.mjs            唯一声明处：数据集规格、视口与候选常量、判据阈值、**声明式期望值表**
src/graph-gen.mjs           确定性夹具生成（宽而浅 / 深链 / 密集交叉 + 规模梯度；零 import、零 Math.random）
src/fixture.mjs             夹具装配：reindex → validate → createScheduleCalendar + compute（**消费 engine/dist**）
src/clip.mjs                裁剪：折叠过滤、行窗口、边求交（路径 A）与端点可见性（路径 B）
src/view-model.mjs          几何真相源：轴/行/边/箭头 → ViewModel（纯函数、零 DOM）
src/count.mjs               元素计数（两路互证：分类累加 vs 逐项枚举）
src/arrows.mjs              4 类箭头形态 + 1 CSS px 光栅化 Jaccard 可区分性
src/fold-stability.mjs      stub/wrap 常数性扫描（含**比例式**负向对照）+ 走线穿条量化
src/invariants.mjs          声明式期望值表 + 反算往返 + 端点贴合 + 汇总覆盖 + 哨兵守卫
src/negative-control.mjs    NC1（端点裁剪丢边）、NC2（关窗口裁剪）、NC3（故意错的几何）
src/scale-params.mjs        `pxPerDay` / 行高 / 缓冲 / gutter 的**判据求值**（常量由此推出，不是手选）
src/report.mjs              证据渲染（Markdown）
src/run-all.mts             一键入口：L0 几何 → L1 裁剪 → L2 定标 → 写 evidence/ → 判定与退出码
src/browser/index.html      浏览器探针页（丢弃式，无打包器）
src/browser/probe.mjs       页内测量：首屏分层、10× 滚动、帧间隔、零空白行断言
src/browser/host.mjs        零依赖静态服务器（**仓库根当文档根**，于是浏览器与 Node 的相对 import 完全一致）
src/cdp.mjs                 零依赖 CDP 驱动（spawn + DevToolsActivePort + 内置 WebSocket）
src/browser-run.mts         S4-c 编排：起服务器 → 起 Chrome → 逐 (夹具 × 档位) 导航取数 → 写证据
src/wps-connector-idx.ps1   P-8 遗留 1：COM 四站点 → 落盘 `idx` 实测（WPS）
src/wps-elbow-retest.ps1    P-8 遗留 2：右出→左入 肘形的量化复测 + 负对照（WPS）
gen-wps-evidence.py         P-8 证据生成器：`out/P8-*-records.json` → `evidence/wps-*.md`（LF、确定）
evidence/                   证据（入库）：见下"证据分级"
out/                        gitignore：夹具 JSON、CDP 原始 JSON、P8 采集 JSON、pptx、Chrome 临时 profile
```

## 运行

```powershell
# 探针消费引擎的**构建产物**（源码的相对 import 写的是 `.js`，Node 类型剥离解析不到）
pnpm --filter @ganttpilot/engine build

cd spikes/g0-s4-svg-clipping
pnpm typecheck                    # 两个 tsconfig：计算层（无 DOM）/ 浏览器层（含 DOM）
node src/run-all.mts              # L0 + L1 + L2（写 evidence/；纯 Node、确定）
node src/browser-run.mts          # L3 浏览器计时（需要本机 Chrome；记录制）

# P-8 遗留（需要本机 WPS）：采集 → 生成证据
pwsh -File src/wps-connector-idx.ps1
pwsh -File src/wps-elbow-retest.ps1
<bundled python> gen-wps-evidence.py   # 从 out/P8-*-records.json 生成 evidence/wps*.md
```

> `gen-wps-evidence.py` 放在 **spike 根**（不是 `out/`）：`out/` 是 gitignore 的工件目录，
> 生成器放进去会让证据无法从入库内容复现（收口时已订正；脚本对同一份采集 JSON 的输出是确定的）。

`GANTTPILOT_CHROME` 可指定 Chrome 可执行文件；**找不到 Chrome 时 `browser-run.mts` 失败而不是跳过**
（与裁决 P-12 的"缺依赖即失败"同口径）。

## 退出码口径

`run-all.mts` / `browser-run.mts` 的非零退出表示**测量基础设施不可信**：

- 夹具不可排程 / schema 报错、引擎 `dist` 缺失或与源码漂移（文档版本或已落地能力块不一致）；
- 期望值表、不变量、哨兵守卫失败；NC1/NC2/NC3 未检出（说明判据没有判别力）；
- 常量与定标判据不自洽（改了常量没改判据）；浏览器缺 Chrome 或页面报错；
- **`S4-b` 丢边为 0**（协议明文：那是"数据无效、必须重造"，不得记为"求交不必要"）。

**门禁判定本身是数据，不是退出码**：某条"不通过"意味着按协议改写 DoD 或触发降级，而不是脚本失败。

## 证据分级

| 级别 | 内容 | 稳定性 |
|---|---|---|
| **Node 稳定层** | `env.md`、`geometry-expectations.md`、`invariants-report.md`、`clipping-report.md`、`routing-report.md`、`scale-params-report.md` | **逐字节稳定**（`run-all.mts` 每次重写；重复运行一致已复核 6/6） |
| **WPS 采集层** | `wps-idx-probe.md`、`wps/elbow-retest.md` + 7 个 `P8-*-slide1.xml` 快照 | **采集快照**：`gen-wps-evidence.py` 对同一份采集 JSON 的输出确定（已复核），但报告内含采集时刻、XML 依赖 WPS 版本 ⇒ 重跑承诺"判定与数值一致"，不承诺逐字节 |
| **测量快照** | `browser-timing-chrome<大版本>.md` | 按浏览器大版本分文件；换机器/版本必然不同 |
| 原始层 | `out/fixture-*.json`、`out/browser-raw-*.json`、`out/P8-*-records.json`、`out/*.pptx` | 不入库（可复算：前者跑 `run-all.mts`，后者跑两个 `wps-*.ps1`） |

## 五个必须记住的工程事实（都已踩过）

1. **引擎要消费 `dist`，不要消费 `src`**：引擎源码相对 import 写的是 `./x.js`（`tsc` 产物约定），
   Node 的类型剥离**不会**把 `.js` 解析成 `.ts`。因此探针只 import `packages/engine/dist`，
   并用"产物 vs 源码的文档版本/能力块一致性"做漂移检查（**不要比 mtime**：`tsc -b` 是增量的，
   源码没变时它不重写产物，mtime 必然更旧，会把正常误报成过期）。
2. **"帧时长"不能用双 `requestAnimationFrame` 测**：双 rAF ≈ 33 ms 的等待会被算进"帧时长"，
   把 1.2 ms 的工作量报成 33 ms（本探针第一版就是这么错的）。要分开记"主线程耗时"与"连续 rAF 的真实帧间隔"。
3. **一次导航只测一个档位**：首屏口径是"就绪 → 首帧"，多档同页会让后续档位的 `fromReady` 累计前面轮次的时间。
4. **零依赖驱动 Chrome**：`--remote-debugging-port=0` + 读 `DevToolsActivePort`（硬编码端口会和用户已开的 Chrome 冲突）；
   子进程必须 `stdio: 'ignore'`（受限沙箱下用管道捕获子进程输出会 `EPERM`）；临时 profile 用完即删。
5. **静态服务器把"仓库根"当文档根**：这样 `src/browser/probe.mjs` 仍是 `import '../view-model.mjs'`、
   共享模块仍是 `import '../../../packages/engine/dist/index.js'`——**浏览器与 Node 跑的是同一批文件**，
   零改写、零打包器。服务器仍只绑定 `127.0.0.1`、临时端口、白名单前缀；顺带给探针页加 `rel="icon" href="data:,"`，
   否则 `/favicon.ico` 会撞白名单返回 403 并在 CDP 日志里报错。
