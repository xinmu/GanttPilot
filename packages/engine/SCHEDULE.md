# 排程内核规范（G2）

> 本文件是 `@ganttpilot/engine` **排程内核**（`packages/engine/src/schedule.ts`）的**权威说明**，
> 供 G3（xlsx 导入/导出）、G4（渲染与裁剪）、G5（拖拽与撤销）、G7（导出投影）共同引用。
> 决策依据与取舍见 [ADR 0004 排程契约](../../docs/02-adr/0004-排程契约.md)（**冻结面**）
> 与 [ADR 0005 排程内核落地补齐与结果形状](../../docs/02-adr/0005-排程内核落地补齐与结果形状.md)（**口岸补齐**）；
> 能力块出口条件见 [首版能力顺序 G2](../../docs/01-roadmap/首版能力顺序.md)。
> 文档形状见 [SCHEMA.md](SCHEMA.md)；变更通道见 [COMMAND.md](COMMAND.md)。

## 一、四条铁律

1. **日期一律以「工作日序号」（整数）承载，日历不进传播热路径。**
   `Schedule` **只出序号**；ISO 由调用方用**同一个** `Calendar` 翻译（`isoOfOrdinal`）。
   序号相对 `Calendar.baseDay` 计数，**负数序号无定义**（G1.1 已冻结）——
   越到项目起点之前的开始时间一律**截断 + 计数 + 诊断**（§五）。
2. **`compute` 是纯函数、唯一排程真相源，且排程结果不写回文档。**
   文档只存输入；`Schedule` 永远是派生值，因此撤销只需回退"输入 + 会话锚点"（ADR 0003 §6）。
3. **忽略而不静默**：每一个"没按用户输入算"的地方都有一条诊断（§六）。
   只有两种情形**有意抛出** `RangeError`：`parentId` 违反文档序不变量（**可达**，见 §四.5）、
   文档日期超出可表示域（**防御性**，见 §四.5）。
4. **不做未启用的语义**：`constraints[]` 与 `manual` 不进签名，只产出 `constraintsUnused`；
   `calendars[]` 里只有生效的那一份参与计算（R-1：v0.1 仅项目日历）。

## 二、输入

```ts
function compute(
  document: ProjectDocument,
  calendar: Calendar,
  anchors?: readonly SessionAnchor[],   // v0.1 唯一的可选入参
): ScheduleResult;

/** 会话内锚点（G5 的"允许 + 标红"）：taskId → 工作日序号。不进文档、不落盘。 */
interface SessionAnchor {
  readonly taskId: string;
  readonly startOrdinal: number;
}
```

**前置条件**（内核不兜底，由调用方保证）：

| # | 前置条件 | 违反后果 |
|---|---|---|
| 1 | 文档通过 `validateDocument` 且**无 `error`**（G1.2；命令层保证其产出必然满足） | 悬空/不可解析的边被**忽略**且不报告；其余行为未定义 |
| 2 | `calendar.baseDay` 不晚于文档中的最早日期 | 早于 `baseDay` 的日期按序号 `0` 处理并计入 `clampedStart`（§五） |
| 3 | 文档满足 G1.2 的"**父节点先于子节点出现在文档序**"不变量 | 抛 `RangeError`（汇总聚合依赖它，不静默算错）——**可达**：一条 `parentId` 指向文档序更靠后的任务即触发 |
| 4 | 日期在 `HORIZON_GUARD_DAYS` 可表示域内 | 抛 `RangeError`——**防御性**：`isoToDayNumber` 只接受 0–9999 年（跨度上限约 3.65M 天 < 10M 天），实际不可达；保留它是为了"宁可显式抛出，也不静默截断" |

**容量不改变任何序号**：无论调用方的 `Calendar` 容量是否足够，`Schedule` 逐项相同（§七）。
但调用方要翻译 ISO 时，**自己的日历必须有足够容量**——用 §七 的 `createScheduleCalendar` 一次规划好。

## 三、输出

```ts
type ScheduleResult =
  | { readonly ok: true; readonly schedule: Schedule }
  | {
      readonly ok: false;
      readonly code: 'cycle';
      readonly message: string;
      readonly cyclePath: readonly string[];               // 成环路径（首尾同一 id）
      readonly diagnostics: readonly ScheduleDiagnostic[]; // 本情形下只含 cycle 一条
    };

interface Schedule {
  readonly taskCount: number;          // === document.tasks.length

  // —— 序号空间（工作日序号；负序号无定义；-1 见下）——
  es: Int32Array;                      // 叶子：第一个工作日序号
  ef: Int32Array;                      // 叶子：排他结束序号 = es + 解析工期
  anchored: Uint8Array;                // 1 = 位置由锚点决定（情形①②④）
  driven: Uint8Array;                  // 1 = 文档日期被推导覆盖（情形③且两者不同）

  // —— 汇总任务派生值（叶子任务为 -1）——
  summaryEs: Int32Array;               // 子树 ES 最小
  summaryEf: Int32Array;               // 子树 EF 最大
  summaryProgress: Float64Array;       // 子树工期加权进度；权重和为 0 时为 NaN

  readonly milestoneCount: number;
  readonly projectStart: number;
  readonly projectFinish: number;      // max(ef)；无叶子时为 projectStart
  readonly clampedStarts: number;
  readonly diagnostics: readonly ScheduleDiagnostic[];
}
```

**索引约定**：每个数组都**按 `document.tasks` 的文档序索引**（`Schedule.es[i]` 对应 `document.tasks[i]`）。

**哨兵 `-1`**（`LEAF_SENTINEL`）：

| 字段 | 叶子任务 | 汇总任务 |
|---|---|---|
| `es` / `ef` | 排程序号（≥ 0） | **-1** |
| `anchored` / `driven` | 0 / 1 | 0 |
| `summaryEs` / `summaryEf` / `summaryProgress` | **-1** | 聚合值 |

> **`es[i] === -1` ⟺ 第 i 行是汇总任务**——这是形状里唯一的汇总判别式，**G4 必须用它**选择"汇总条"分支。
> `-1` 不是合法序号，不可能与真实值混淆。

## 四、语义

### 1. 叶子与汇总：只有叶子参与排程

- **汇总任务 = 有子任务的任务**（判定直接复用 `wbs.ts` 的 `summaryTaskIds`）；
- 汇总任务**不参与传播**：`es/ef` 留 `-1`，其日期/进度由**引擎**聚合（§四.4），G4/G7 只排版、不自己聚合；
- **里程碑（`durationDays === 0` 或 `milestone === true` 的叶子）照常参与传播**（US-2 的"威胁可见"对象）。

### 2. 工期解析（不改写文档）

| 顺序 | 条件 | 解析工期 |
|---|---|---|
| 1 | `durationDays !== null` | `durationDays` |
| 2 | 否则 `startDate` 与 `endDate` 均非空 | `calendar.workdaysBetween(startOrdinal, endOrdinal)`（半开区间） |
| 3 | 否则 | `0` |

`endDate` 是**派生显示值**：三者齐备而 `workdaysBetween(start, end) !== durationDays` 时给 `info` 级
`endDateStale`——**不报错、不改写文档**。它是**文档级一致性**诊断（只看任务自己的三个字段），
因此对**所有任务**判定，**包括汇总任务**（汇总任务不参与排程，但它的日期与工期不一致同样不该被静默吞掉）；
"工期解析"本身只对**叶子任务**有意义。

### 3. 锚点四情形（判定一律看**有效入边**，见 §四.6）

| 情形 | 判定 | 排程语义 | 诊断 | 位 |
|---|---|---|---|---|
| ① | `startDate !== null` ∧ 无有效入边 | `ES = 文档 startDate 的序号` | — | `anchored=1` |
| ② | `startDate === null` ∧ 无有效入边 | `ES = 项目起点`（DM-05 容错） | `undated` | `anchored=1` |
| ③ | 有有效入边 ∧ 无会话锚点 | `ES = max(全部入边约束)`，**文档日期被忽略** | 日期与推导 ES 不同 → `dateOverridden` | `driven=1`（仅当两者不同） |
| ④ | 有有效入边 ∧ 有会话锚点 | `ES = max(锚定序号, 全部入边约束)` | 锚定早于入边约束 → `anchorConflict` | `anchored=1` |

会话锚点的健壮性口径：

| 输入 | 处理 |
|---|---|
| `taskId` 未知 | 忽略 + `anchorUnknown` |
| 指向汇总任务 | 忽略 + `summaryIgnored` |
| `startOrdinal` 不是有限整数 | 忽略 + `anchorUnknown` |
| 同一任务重复给出 | **后者胜**（会话里最后一次拖动才是用户意图） |
| 负整数 | 不特殊处理：参与 §五 的截断 |

**`nextFreeAnchorId` 之类的 id 生成不在内核**（与命令层同口径：确定性优先）。

### 4. 汇总聚合、里程碑、空项目

| 字段 | 定义 |
|---|---|
| `summaryEs` | `min(子树内全部叶子的 es)` |
| `summaryEf` | `max(子树内全部叶子的 ef)` |
| `summaryProgress` | `Σ(dᵢ · p̃ᵢ) / Σ dᵢ`，`dᵢ` = 叶子解析工期，`p̃ᵢ = progress ?? 0`；`Σ dᵢ === 0` → `NaN` |
| `milestoneCount` | 叶子中 `milestone === true` **或** `durationDays === 0` 的个数 |
| `projectFinish` | `max(ef)`；无叶子时 = `projectStart` |

- `progress === null`（未知）按 **0** 计入分子**且照常计入分母**；
- `milestoneCount` 用**字段值**（不是解析工期），否则"无日期无工期"的占位节点会被误计为里程碑；
- **空项目 / 全是汇总任务**：`projectFinish = projectStart`、`milestoneCount = 0`、叶子槽全为 -1。

### 5. 项目起点（三级回落）

1. `project.startDate` 非空 → 它的工作日序号；
2. 否则 → **文档中全部非空 `task.startDate` 的序号最小值**；
3. 否则 → `0`（`Calendar.baseDay` 的序号）。

- 第②级含"下游任务的日期"是**有意**的：只有这样，"文档有日期信息"时才不会回落到 `baseDay`，
  才能兑现"起点不得由容量参数决定"这条不变量（ADR 0005 §5）；
- **会话锚点不参与项目起点**（项目起点是文档级概念，避免"拖 A 改变 B 的截断下限"）；
- 早于 `baseDay` 的日期按序号 `0` 处理，并计入 `clampedStart`。

### 6. 有效图 vs 结构图（两种口径，各有其用）

| 用途 | 用到的边 |
|---|---|
| **传播**（`ES`/`EF`、汇总聚合、"有无前置"判定） | **排除**任一端点为汇总任务的边（该边"等同不存在"），并报 `summaryIgnored` |
| **拓扑序与检环**（`compute` 成环判定、`cyclePath`） | **全部边**（结构性） |
| `wouldCreateCycle(links, candidate)` | **全部入参边**（结构性，签名里看不到层级） |
| `affectedClosure(document, taskIds)` | 沿**全部出边**取后继闭包（宽进） |

- 为什么检环不看汇总端点：`wouldCreateCycle` 的签名只有 `links`，看不到层级；若 `compute` 用"排除汇总端点"
  的图检环，两者就会给出不同判定——**同一事实两个真相源**（ADR 0005 §8）；
- 因此一个只经由汇总端点的环也会让 `compute` 拒绝排程（`ok:false`）——**保守方向**，不会产出错误排程；
- 实现上只有**一份 CSR**，附逐边 `ignored` 标志；Kahn 与拓扑序按全部边算，正向传播只读 `ignored === 0` 的入边。

## 五、截断与计数

`ES` 两步求解：

1. `raw = max(全部有效入边约束, 锚定序号?)`；无入边无锚点时 `raw = 文档日期序号 ?? 项目起点`；
2. `raw < 项目起点` → `ES = 项目起点`、`clampedStarts += 1`、报一条带 `taskId` 的 `clampedStart`。

**不阻断排程、不改写文档、不产出负序号**（S3 §五.4 的语义落地）。

## 六、诊断码表

```ts
type ScheduleDiagnosticCode =
  | 'undated' | 'dateOverridden' | 'clampedStart' | 'anchorConflict'
  | 'anchorUnknown' | 'summaryIgnored' | 'endDateStale' | 'constraintsUnused'
  | 'cycle';

interface ScheduleDiagnostic extends DiagnosticLike {   // 复用 wbs.ts 的形状
  readonly code: ScheduleDiagnosticCode;
}
```

| code | severity | 触发 | 附带 id |
|---|---|---|---|
| `undated` | warning | 情形②（源任务无日期） | `taskId` |
| `dateOverridden` | warning | 情形③且文档日期与推导 ES 不同（**与 `driven` 同源**） | `taskId` |
| `clampedStart` | warning | `raw < 项目起点`；或文档日期早于 `baseDay` 被按序号 0 处理 | `taskId` |
| `anchorConflict` | warning | 锚定序号 < 入边约束的最大值 | `taskId` |
| `anchorUnknown` | warning | 未知 `taskId`，或 `startOrdinal` 非有限整数 | `taskId` |
| `summaryIgnored` | warning | 汇总端点边被传播忽略（对齐 G1.2 的 `LINK_SUMMARY_ENDPOINT`）；或锚点指向汇总任务 | `linkId` / `taskId` |
| `endDateStale` | info | `endDate` 与」`startDate` + `durationDays`」不一致 | `taskId` |
| `constraintsUnused` | info | `constraints` 非空 **或** `manual === true`（R-3：语义 v0.5） | `taskId` |
| `cycle` | error | 只在失败结果里出现，**不产出排程** | 无（路径在 `cyclePath`） |

- **码值是排程侧的独立码空间**（小写驼峰），与文档侧的 `SCREAMING_SNAKE`（`DocumentDiagnosticCode`）不同；
- **码表是闭集**：悬空/不可解析边**忽略且不报告**（前置条件已覆盖），不为校验层的职责新开码；
- `constraintsUnused` 一个码承担 `constraints` 与 `manual` 两个留位字段，消息文案区分。

## 七、容量与调用方配方

```ts
/** 按 ADR 0004 §7 的容量口径构造排程日历（G3/G4/G7 都该用它，而不是各自拼）。 */
function createScheduleCalendar(document: ProjectDocument): Calendar;
```

- `baseDay` = 文档中最早的非空日期（`project.startDate` 与全部 `task.startDate`/`endDate` 取最小）；
  全无日期 → `DEFAULT_PROJECT_BASE_DAY_ISO`；
- 生效规格 = `project.baseCalendarId` 指向的那份（空串 → `calendars[0]`；R-1：v0.1 仅项目日历）；
- `spanDays` = `horizonDaysFor(文档日期跨度 + Σ叶子解析工期 + Σ正 lag)`。

**推荐用法**（序号空间因此从"项目最早日期"起算，读起来最直观）：

```ts
const calendar = createScheduleCalendar(document);
const result = compute(document, calendar);
if (result.ok) {
  const startIso = calendar.isoOfOrdinal(result.schedule.es[i]);   // es[i] === -1 是汇总行，别翻译
}
```

**容量不足时的行为**：`compute` 内部按 `withHorizon(spanDays × 2)` 循环扩容后**再做日期翻译**
（传播本身是纯整数算术，不需要地平线），**序号逐项不变**；早于 `baseDay` 的日期按 0 计（§五）。
**调用方自己的日历容量不足时**，`isoOfOrdinal` 会抛错——用 `calendar.withHorizon(...)` 扩容后翻译，
**序号不变**。用 `createScheduleCalendar` 构造的日历永不触发内部扩容（有单测守住）。

## 八、检环与闭包

```ts
function wouldCreateCycle(
  links: readonly DocumentLink[],
  candidate: DocumentLink,
): { readonly cyclic: boolean; readonly path: readonly string[] };

function affectedClosure(
  document: ProjectDocument,
  taskIds: readonly string[],
): readonly string[];
```

- `wouldCreateCycle`：当且仅当已存在路径 `candidate.to → … → candidate.from` 时 `cyclic = true`，
  `path = [candidate.from, …, candidate.from]`（首尾同一 id）；自环 → `[from, from]`；
  端点悬空 → `{cyclic: false, path: []}`（预检只管成环，有效性归 `validateDocument`）；
  邻居遍历顺序 = `links` 数组序（确定性）；**不判汇总端点**（§四.6，默认保守）。
- `compute` 失败时返回的 `cyclePath` 与 `wouldCreateCycle` 同序同构；
  G3 的"导入丢弃成环边 + 进问题清单"、G5 的"预检拒绝 + 高亮路径"都建在这两个 API 上。
- `affectedClosure`：种子去重、沿**全部出边**取后继闭包（**边序 = 文档里的链序**，与 `compute` 内部 CSR 同源同序）、
  结果**按文档序**输出（与种子顺序无关）、
  **未知 `taskId` 的种子被忽略**（本查询不产出诊断）、**不含祖先**——它只回答"哪些行/边的排程值可能变化"，
  **G4 渲染汇总条时需自行沿 `parentId` 补祖先链**（这是已知边界，不是遗漏：祖先关系不是依赖边的后继关系）。
- `compute` 遇环时**失败结果的诊断面最小**：只带一条 `cycle`（severity `error`），
  不带"传播期本来就不存在"的诊断——给一个"看起来完整"的部分列表会误导 G3 的问题清单。

## 九、确定性、纯函数与不变量

- **绝不修改入参**：`document` / `calendar` / `anchors` 只读（单测用前后深比较证明）；
- **同一输入 → 深比较相同的 `Schedule`**：不引入时钟、随机数、全局自增；
- **可断言的不变量**（测试与差分都建在这几条上）：

  | # | 不变量 |
  |---|---|
  | 1 | `ef[i] = es[i] + 解析工期`（叶子） |
  | 2 | 四类关系的前向边界方程成立（FS `es ≥ ef_pred + lag`、SS `es ≥ es_pred + lag`、FF `ef ≥ ef_pred + lag`、SF `ef ≥ es_pred + lag`） |
  | 3 | `es[i] ≥ projectStart`；`projectFinish = max(ef)` |
  | 4 | `anchored`/`driven` 与文档日期一致性（§四.3 的表） |
  | 5 | 汇总值 = 子树聚合的**独立重算**结果 |
  | 6 | `clampedStarts` === `clampedStart` 诊断条数 |
  | 7 | 容量无关性：任意容量的日历 → 逐项相同的 `Schedule` |

## 十、验证与门禁

| 层 | 手段 | 门禁判据 |
|---|---|---|
| ① 不变量/性质 | `schedule.invariants.spec.ts` | ≥ 1,000 随机图全过 |
| ② 手工推导用例 | `schedule.manual.spec.ts`（声明式期望值表，内核无权改基准） | 逐条声明式期望值 |
| ③ 跨语言差分 | `schedule.differential.spec.ts` + [`tools/cpm-reference/cpm_reference.py`](../../tools/cpm-reference/cpm_reference.py) | ≥ 1,000 DAG + 200 成环图，**0 不一致** |
| ④ 性能 | `schedule.performance.spec.ts`（批量计时 + median-of-suites） | 1,000 任务/1,500 依赖全量 `compute` **p99 ≤ 1 ms**（Node 24 参照机；EN-08 的 100 ms 保留为产品侧不回归天花板）。**实测**：p50 = 326 µs / p99 = 530 µs（最差 suite p99 = 644 µs）——注意 S3 的 52.1 µs 是**只测传播内核**的窄口径，本数字是产品口径（含日期解析、工期解析、诊断收集与结果分配） |
| ⑤ 负向对照 | 正确性侧（打坏期望值/改关系类型/篡改结果必须被检出）与性能侧（朴素对照必须被量出 ≥3×） | **必须有**，否则判据可能是恒真式 |

**差分层怎么跑**（协议与 CLI 见 [`tools/cpm-reference/README.md`](../../tools/cpm-reference/README.md)）：

- 差分**就在 `pnpm test` 里**（`schedule.differential.spec.ts`），因此 `pnpm gate` 真实运行它；
- **缺 Python 3 即失败，不静默跳过**（Windows 上表现为退出码 9009，必须显式处理）；
  可用 `GANTTPILOT_PYTHON` 指定解释器；
- 随机**种子固定**并随失败信息打印；中间输入输出落 `tmp/diff/`（已 gitignore，可复算调试）；
- 参照实现是**独立写法**（另一套图算法、`datetime` 逐日日历、`list`/`dict` 数据结构），
  两侧**只共享字段契约**，不共享代码。

## 十一、明确不做（v0.5+）

逆向遍历 LS/LF、总浮动/自由浮动、关键路径高亮（EN-01/02/03）；**增量传播**（闭包内逆后序重算）；
`constraints[]` 与 `manual` 的语义（DM-08/09）；多日历与小时粒度（R-1 / D-4）；Worker 化；
2,000 任务正式压测。范围依据见[裁决 P-12](../../docs/00-baseline/裁决记录.md) 与 ADR 0004 §8。
