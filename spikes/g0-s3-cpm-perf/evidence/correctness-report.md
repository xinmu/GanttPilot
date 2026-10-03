# S3 · L1 正确性证据（可重跑、逐字节稳定）

> 由 `node src/run-all.mts` 生成。判定基准是 `src/manifest.ts` 的**声明式期望值表**与不变量定义，
> 不是"内核的再次序列化"。本文件不含时间戳与运行时版本，重跑应逐字节一致。

### L1-a 手工推导用例（4 关系 × lag 正/负/0 × 跨层级 × 日历例外）

共 76 条，通过 76 条，失败 0 条。

| 检查 | 结果 | 实测 |
|---|---|---|
| `C1-fs-chain-cross-weekend/es` | ✅ 通过 | [0, 3, 7] |
| `C1-fs-chain-cross-weekend/ef` | ✅ 通过 | [3, 5, 12] |
| `C1-fs-chain-cross-weekend/ls` | ✅ 通过 | [0, 3, 7] |
| `C1-fs-chain-cross-weekend/lf` | ✅ 通过 | [3, 5, 12] |
| `C1-fs-chain-cross-weekend/tf` | ✅ 通过 | [0, 0, 0] |
| `C1-fs-chain-cross-weekend/ff` | ✅ 通过 | [0, 0, 0] |
| `C1-fs-chain-cross-weekend/projectFinish` | ✅ 通过 | 期望 12 实得 12 |
| `C1-fs-chain-cross-weekend/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C2-parallel-float/es` | ✅ 通过 | [0, 2, 2, 7] |
| `C2-parallel-float/ef` | ✅ 通过 | [2, 7, 4, 10] |
| `C2-parallel-float/ls` | ✅ 通过 | [0, 2, 5, 7] |
| `C2-parallel-float/lf` | ✅ 通过 | [2, 7, 7, 10] |
| `C2-parallel-float/tf` | ✅ 通过 | [0, 0, 3, 0] |
| `C2-parallel-float/ff` | ✅ 通过 | [0, 0, 3, 0] |
| `C2-parallel-float/projectFinish` | ✅ 通过 | 期望 10 实得 10 |
| `C2-parallel-float/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C3-ss-relation/es` | ✅ 通过 | [0, 0, 3] |
| `C3-ss-relation/ef` | ✅ 通过 | [3, 2, 5] |
| `C3-ss-relation/ls` | ✅ 通过 | [0, 1, 3] |
| `C3-ss-relation/lf` | ✅ 通过 | [3, 3, 5] |
| `C3-ss-relation/tf` | ✅ 通过 | [0, 1, 0] |
| `C3-ss-relation/ff` | ✅ 通过 | [0, 1, 0] |
| `C3-ss-relation/projectFinish` | ✅ 通过 | 期望 5 实得 5 |
| `C3-ss-relation/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C4-ff-relation/es` | ✅ 通过 | [0, 2, 6] |
| `C4-ff-relation/ef` | ✅ 通过 | [6, 6, 8] |
| `C4-ff-relation/ls` | ✅ 通过 | [0, 2, 6] |
| `C4-ff-relation/lf` | ✅ 通过 | [6, 6, 8] |
| `C4-ff-relation/tf` | ✅ 通过 | [0, 0, 0] |
| `C4-ff-relation/ff` | ✅ 通过 | [0, 0, 0] |
| `C4-ff-relation/projectFinish` | ✅ 通过 | 期望 8 实得 8 |
| `C4-ff-relation/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C5-sf-relation/es` | ✅ 通过 | [0, 5, 10, 3] |
| `C5-sf-relation/ef` | ✅ 通过 | [3, 10, 12, 4] |
| `C5-sf-relation/ls` | ✅ 通过 | [0, 5, 10, 11] |
| `C5-sf-relation/lf` | ✅ 通过 | [3, 10, 12, 12] |
| `C5-sf-relation/tf` | ✅ 通过 | [0, 0, 0, 8] |
| `C5-sf-relation/ff` | ✅ 通过 | [0, 0, 0, 8] |
| `C5-sf-relation/projectFinish` | ✅ 通过 | 期望 12 实得 12 |
| `C5-sf-relation/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C6-negative-lag/es` | ✅ 通过 | [0, 3, 2, 5] |
| `C6-negative-lag/ef` | ✅ 通过 | [5, 5, 5, 7] |
| `C6-negative-lag/ls` | ✅ 通过 | [0, 3, 2, 5] |
| `C6-negative-lag/lf` | ✅ 通过 | [5, 5, 5, 7] |
| `C6-negative-lag/tf` | ✅ 通过 | [0, 0, 0, 0] |
| `C6-negative-lag/ff` | ✅ 通过 | [0, 0, 0, 0] |
| `C6-negative-lag/projectFinish` | ✅ 通过 | 期望 7 实得 7 |
| `C6-negative-lag/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C7-calendar-exception/es` | ✅ 通过 | [0, 3, 5] |
| `C7-calendar-exception/ef` | ✅ 通过 | [3, 5, 7] |
| `C7-calendar-exception/ls` | ✅ 通过 | [0, 3, 5] |
| `C7-calendar-exception/lf` | ✅ 通过 | [3, 5, 7] |
| `C7-calendar-exception/tf` | ✅ 通过 | [0, 0, 0] |
| `C7-calendar-exception/ff` | ✅ 通过 | [0, 0, 0] |
| `C7-calendar-exception/projectFinish` | ✅ 通过 | 期望 7 实得 7 |
| `C7-calendar-exception/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C7-calendar-exception/startIso` | ✅ 通过 | [2026-10-05, 2026-10-08, 2026-10-19] |
| `C8-cross-level-milestone-isolated/es` | ✅ 通过 | [0, 1, 1, 3, 0] |
| `C8-cross-level-milestone-isolated/ef` | ✅ 通过 | [1, 3, 1, 7, 2] |
| `C8-cross-level-milestone-isolated/ls` | ✅ 通过 | [0, 1, 3, 3, 5] |
| `C8-cross-level-milestone-isolated/lf` | ✅ 通过 | [1, 3, 3, 7, 7] |
| `C8-cross-level-milestone-isolated/tf` | ✅ 通过 | [0, 0, 2, 0, 5] |
| `C8-cross-level-milestone-isolated/ff` | ✅ 通过 | [0, 0, 2, 0, 5] |
| `C8-cross-level-milestone-isolated/projectFinish` | ✅ 通过 | 期望 7 实得 7 |
| `C8-cross-level-milestone-isolated/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C9-six-day-calendar/es` | ✅ 通过 | [0, 6] |
| `C9-six-day-calendar/ef` | ✅ 通过 | [6, 7] |
| `C9-six-day-calendar/ls` | ✅ 通过 | [0, 6] |
| `C9-six-day-calendar/lf` | ✅ 通过 | [6, 7] |
| `C9-six-day-calendar/tf` | ✅ 通过 | [0, 0] |
| `C9-six-day-calendar/ff` | ✅ 通过 | [0, 0] |
| `C9-six-day-calendar/projectFinish` | ✅ 通过 | 期望 7 实得 7 |
| `C9-six-day-calendar/no-clamped-start` | ✅ 通过 | clampedStarts = 0 |
| `C9-six-day-calendar/startIso` | ✅ 通过 | [2026-10-05, 2026-10-12] |
| `C10-cycle/cycle-detected` | ✅ 通过 | 检出 3 个成环节点：0,1,2 |
| `C10-cycle/no-schedule-on-cycle` | ✅ 通过 | 成环时不产出排程结果 |

用例明细：

| 用例 | 说明 | ES（工作日序号） | EF | 各任务开始日（ISO） |
|---|---|---|---|---|
| `C1-fs-chain-cross-weekend` | FS 链 + 跨周末 + 正 lag | [0, 3, 7] | [3, 5, 12] | [2026-10-05, 2026-10-08, 2026-10-14] |
| `C2-parallel-float` | 并行分支 + 总浮动/自由浮动 | [0, 2, 2, 7] | [2, 7, 4, 10] | [2026-10-05, 2026-10-07, 2026-10-07, 2026-10-14] |
| `C3-ss-relation` | SS 关系（开始—开始） | [0, 0, 3] | [3, 2, 5] | [2026-10-05, 2026-10-05, 2026-10-08] |
| `C4-ff-relation` | FF 关系（完成—完成） | [0, 2, 6] | [6, 6, 8] | [2026-10-05, 2026-10-07, 2026-10-13] |
| `C5-sf-relation` | SF 关系（开始—完成）+ 一条浮动分支 | [0, 5, 10, 3] | [3, 10, 12, 4] | [2026-10-05, 2026-10-12, 2026-10-19, 2026-10-08] |
| `C6-negative-lag` | 负 lag（lead）与 SS 负 lag | [0, 3, 2, 5] | [5, 5, 5, 7] | [2026-10-05, 2026-10-08, 2026-10-07, 2026-10-12] |
| `C7-calendar-exception` | 日历例外：整周放假 | [0, 3, 5] | [3, 5, 7] | [2026-10-05, 2026-10-08, 2026-10-19] |
| `C8-cross-level-milestone-isolated` | 跨层级（跳层依赖）+ 里程碑 + 游离节点 | [0, 1, 1, 3, 0] | [1, 3, 1, 7, 2] | [2026-10-05, 2026-10-06, 2026-10-06, 2026-10-08, 2026-10-05] |
| `C9-six-day-calendar` | 6 天工作周（Mon–Sat） | [0, 6] | [6, 7] | [2026-10-05, 2026-10-12] |
| `C10-cycle` | 成环必须被报出，而不是死循环 | —（成环） | — | — |

### L1-b 两套日历实现互证（索引前缀和 vs 逐日循环）

共 3 条，通过 3 条，失败 0 条。

| 检查 | 结果 | 实测 |
|---|---|---|
| `default-mon-fri/loop-vs-indexed` | ✅ 通过 | 600 天逐日判定 + 201 个序号映射 + 全部区间计数逐项一致 |
| `mon-fri-one-week-holiday/loop-vs-indexed` | ✅ 通过 | 600 天逐日判定 + 201 个序号映射 + 全部区间计数逐项一致 |
| `mon-sat/loop-vs-indexed` | ✅ 通过 | 600 天逐日判定 + 201 个序号映射 + 全部区间计数逐项一致 |

### L1-c 不变量（随机图）

在 **1000** 张随机项目图（5–120 任务、四类关系、lag ∈ [−3, 3]、含 5% 里程碑）上运行。

违规总数：**0**；每条不变量的违规计数：

| 不变量 | 违规数 |
|---|---|
| EF = ES + duration | 0 |
| LF = LS + duration | 0 |
| TF = LS − ES | 0 |
| TF ≥ 0 | 0 |
| FF ≥ 0 | 0 |
| TF ≥ FF | 0 |
| 关系边界方程 | 0 |
| FF 独立重算 | 0 |
| 关键任务非空（纯 FS 图） | 0 |
| 随机图不应成环 | 0 |

> **发现（不是违规）**：44/1000 张随机图的「关键集合」为空——它们都含 SS/FF/SF 混合关系。此时"完成最晚的任务"不一定是任何终端的祖先，因此所有任务的总浮动都 > 0。**纯 FS 图不存在该现象**（上表最后一条只对纯 FS 图生效）。
> 这条对 v0.5 分析层有直接含义：关键路径高亮不能只判 `totalFloat === 0`，还要处理"关键集合为空"的退化情形。

### L1-d 与主干 `packages/engine/src/date.ts` 的语义一致性

共 2 条，通过 2 条，失败 0 条。

| 检查 | 结果 | 实测 |
|---|---|---|
| `engine/iso-parse-equivalence` | ✅ 通过 | 400 个日期样本，不一致 0 个 |
| `engine/workdays-between-equivalence` | ✅ 通过 | 400 个区间样本（Mon–Fri 口径），不一致 0 个 |

> 本文件只放**语义等价性**；两套实现的**常数因子对照**（实测耗时）属于测量快照，
> 见 `breakdown-node<版本>.md` §一。

### L1-e 正确性侧负向对照（证明判定集有判别力）

| 编号 | 变造 | 是否被检出 | 报出的判据 |
|---|---|---|---|
| NC-C1 | 把 C1 的 ef[1] 期望值从 5 改成 6 | ✅ 检出 | C1-fs-chain-cross-weekend/ef |
| NC-C2 | 把 C3 的第 1 条 SS 依赖改成 FS（期望值不变） | ✅ 检出 | C3-ss-relation/es, C3-ss-relation/ef, C3-ss-relation/ls, C3-ss-relation/lf, C3-ss-relation/tf, C3-ss-relation/ff, C3-ss-relation/projectFinish |
| NC-C3 | 把某任务的 ES 手工加 1 个工作日 | ✅ 检出 | EF = ES + duration @ #20: 16 ≠ 14+3；TF = LS − ES @ #20 |
