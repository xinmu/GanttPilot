# spike：G0-S-S3 · CPM 性能定标与拖拽 DoD 边界

> **这是 spike 代码，不属于产品主干。** 结论见 [结论.md](结论.md)。
>
> 铁律（[证伪实验计划](../../docs/00-baseline/证伪实验计划.md)）：**spike 代码不进主干**。
> 本目录只交付「性能定标 + 可行性约束」；排程内核的产品实现（含单测）在能力块 **G2** 由
> `@ganttpilot/engine` 重新实现，届时**本目录应整体删除**。

## 这个 spike 回答什么

[证伪实验计划 §Spike-3](../../docs/00-baseline/证伪实验计划.md) 的三个问题：

1. 1,000 任务 / 1,500 依赖下**全量重算**的真实耗时分布（p50/p99）是多少？（门禁 G3-a）
2. **拖拽期间"受影响子图传播"**的真实耗时分布如何？（门禁 G3-b）
3. **关键路径任务改工期 / 增删依赖边**的耗时能否用 10ms/帧 作通用保证？（门禁 G3-c）
   —— 以及随之而来的 DoD 定标：给 G2 与 v0.5 分析层的数字该写成什么。

答案与代价见 [结论.md](结论.md)。一句话：**三条门禁全部通过，余量在两到三个数量级**——
全量重算 p99 ≈ 50 µs（阈值 100 ms）、非关键编辑的闭包传播 p99 ≈ 0.6 µs（阈值 10 ms）；
**但 EN-04 的改写理由要从"引擎算不动"改成"避免整表重建"**，因为在 1,000 任务规模上引擎耗时
根本不是瓶颈（详见结论 §四）。

## 为什么它不污染主干

- **不在 `pnpm-workspace.yaml` 内**（根 workspace 只含 `packages/*` 与 `apps/*`），
  因此 `pnpm -r build` / `pnpm -r typecheck` / `license:check` 都不覆盖它；
- **零 npm 依赖**（只有 `@types/node` 开发依赖），自带 `pnpm-lock.yaml`，用
  `pnpm install --ignore-workspace` 隔离安装；
- `out/` 与 `node_modules/` 已在根 `.gitignore` 忽略（工件可再生、证据不可再生）；
- `spikes/**` 仍在 `pnpm lint` 的覆盖内——这是有意识的例外，代价是 lint 会扫到这里。

## 目录

```
src/manifest.ts         唯一声明处：门禁阈值、数据集规格、测量参数、**手工期望值表**、差分字段契约
src/calendar.ts         工作日历：索引前缀和（O(1)）与逐日循环（对齐主干口径）两套实现
src/model.ts            Task / Link / Schedule / Diagnostic 与「工作日序号」约定
src/cpm.ts              最小 CPM：Kahn 检环 + 正向 + 逆向 + 总/自由浮动 + 关键路径 + 闭包传播 + CSR
src/graph-gen.ts        确定性数据生成：宽而浅 / 深链 / 密集交叉 + 随机 DAG / 成环图
src/edit-sim.ts         四类编辑场景的规划与施加（改工期 ×2、增边、删边）
src/harness.ts          计时骨架：hrtime、批量计时、median-of-suites、计时器分辨率守卫
src/negative-control.ts NC1/NC2/NC3 三组「已知更慢」的实现（证明判据有判别力）
src/verify.ts           L1：手工用例 + 不变量 + 双日历互证 + 主干对照 + 正确性负向对照
src/differential.mts    L1b：生成随机图 → 文件式 IPC → 调 Python 参照实现 → 逐字段比对
src/perf.ts             L2/L3：把场景接到计时骨架，含负向对照的比值计算
src/report.ts           证据渲染（Markdown）
src/run-all.mts         一键入口：L1 → L1b → L2 → L3 → 写 evidence/ → 判定与退出码
src/bench.mts           只跑 L2（换运行时取数用）
reference/cpm_reference.py  独立写法的 Python 参照实现（递归 + datetime + DFS 染色）
evidence/               证据链（入库；快照/稳定两类见下）
out/                    gitignore：原始迭代 JSONL、差分输入输出（可复算）
```

## 运行

```bash
cd spikes/g0-s3-cpm-perf
pnpm install --ignore-workspace
pnpm typecheck
node src/run-all.mts        # 全跑：L1 + L1b + L2 + L3，写 evidence/
node src/bench.mts          # 只跑 L2（换运行时取数用）
```

CI 口径的运行时（Node 24.15.0，**主口径**）这样复核：

```powershell
& "$env:LOCALAPPDATA\nvm\v24.15.0\node.exe" src/run-all.mts
```

差分测试需要本机有 Python（实测 3.14.5）。默认按 `python` → `python3` → `py -3` 依次尝试，
Windows 上若是 `.bat/.cmd` 垫片（如 pyenv-win），会自动退回 `cmd.exe /d /s /c` 执行；
可用 `GANTTPILOT_PYTHON` 指定解释器。**没有 Python 时差分层显式判为「未验证」并让
`run-all.mts` 非零退出**——不允许静默通过。

## 退出码口径

`run-all.mts` 的非零退出表示**测量基础设施不可信**：

- L1 判定失败、不变量违规、正确性负向对照未检出；
- 差分层未运行或存在不一致；
- NC1/NC2/NC3 未达判别力阈值（阈值见 `src/manifest.ts`）。

**门禁 G3-a/G3-b/G3-c 的判定是数据，不是退出码**：按协议，某一门禁"不通过"意味着改写 DoD
（`EN-04` 等），而不是脚本失败。

## 证据分级

| 级别 | 内容 | 稳定性 |
|---|---|---|
| **L1 正确性** | 10 个手工推导用例（76 条判定）+ 两套日历互证 + 1,000 张随机图的不变量 + 主干 `date.ts` 等价性 + 3 条正确性负向对照 | **逐字节稳定**（`correctness-report.md`） |
| **L1b 差分** | 1,000 个随机 DAG + 200 个成环图，与独立 Python 参照实现逐字段比对；三种日历轮换 | **逐字节稳定**（`differential-report.md`） |
| **L2 性能** | 3 个门禁数据集 × 12 类操作 + 2 个观测点，p50/p95/p99（median-of-suites） | **测量快照**（`perf-node<版本>.md`） |
| **L3 常数因子** | 日期算术、每跳全量重算、对象图三组负向对照 + 主干 `countWorkdays` 对照 | **测量快照**（`breakdown-node<版本>.md`） |
| 环境 | 机器与运行时口径的固定字符串 | **逐字节稳定**（`env.md`） |

> 稳定性纪律：除标注为「测量快照」的四份文件外，其余证据重跑应逐字节一致。
> 性能报告按运行时大版本分文件（`perf-node24.md` / `perf-node26.md`），因为同一个内核在不同
> V8 上数值必然不同——把两者混在一份文件里会让"重跑不一致"变成常态噪声。

## 三个必须记住的环境/工程事实（都已踩过）

1. **Windows 上 `python` 常常不是可执行文件而是 `.bat` 垫片。** `spawnSync('python', args)` 得到的是
   退出码 **9009**（"不是可执行程序"）而不是 `ENOENT`，很容易被误判成"Python 跑的脚本失败了"。
   本 spike 显式退回 `cmd.exe /d /s /c`，并且**避免 `shell: true`**（Node 会为"shell + args"给出
   DEP0190 警告，参数转义规则也更差）。
2. **`process.hrtime.bigint()` 在本机分辨率约 100 ns，而闭包传播只要 30–60 ns。**
   直接计时会把 p50 测成"等于分辨率"。计时骨架因此先校准、再**按 `batchSize` 批量计时**，
   折算到单次（见 `src/harness.ts`）；这也意味着"亚微秒"的数字必须连同 `batchSize` 一起读。
3. **日历不参与 CPM 传播。** 一旦用「工作日序号」承载日期，传播就是纯整数运算，`Date` 只在
   渲染/导出边界出现。这条不是优化技巧，而是本 spike 在架构层最重要的一条结论（见结论 §五.1）。
