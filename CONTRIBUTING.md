# 贡献指南

> 本项目当前处于 v0.1 的 **G1.1（日历与日期算术）、G1.2（文档 schema、版本迁移与 WBS 层级）、
> G1.3（命令层与事务）、G2（最小正向传播内核）与 G3（xlsx 导入/导出，仅可见列）均已完成**阶段：
> `packages/engine` 已落地工作日序号化日历与 O(1) 日期翻译、**冻结的文档模型**（规范化序列化/解析、
> 结构化诊断校验、`v1→v2→v3` 迁移、WBS 调级）、**命令层**（唯一变更通道、before 镜像、事务与撤销/重做栈）、
> **排程内核**（全量正向传播 + 锚点四情形 + 汇总聚合 + 结构性检环 + 受影响闭包），
> 以及 `packages/xlsx-protocol` 的**协议层**（9 列契约双解析、容差闭集、公式只读缓存值、
> 确定性成环丢弃、三层拼接诊断、规范化导出与部件指纹确定性）——**「Excel 导入 → 排程」在协议层已跑通**。
> **下一步是 G4**（纯 SVG 甘特渲染，含裁剪）：把 `Schedule` 画出来，并把导入向导接到 `apps/web`。
> **G3 的开工前置已闭**：列契约、单元格容差、公式口径、成环丢弃顺序、导出物白名单与协议层诊断码表已在
> [ADR 0006](docs/02-adr/0006-xlsx-协议契约.md) 冻结（裁决 P-14），落地期的四条口径补齐见
> [裁决 P-15](docs/00-baseline/裁决记录.md)——**契约若需变更，追加 ADR 并同步路线图 G3**。
> 能力顺序与每块出口条件见 [首版能力顺序](docs/01-roadmap/首版能力顺序.md)；
> 关键决策见 [docs/02-adr](docs/02-adr/)（排程契约 = [ADR 0004](docs/02-adr/0004-排程契约.md) +
> [ADR 0005](docs/02-adr/0005-排程内核落地补齐与结果形状.md)）；分解依据见
> [裁决 P-10](docs/00-baseline/裁决记录.md)；文档模型规范见 [packages/engine/SCHEMA.md](packages/engine/SCHEMA.md)；
> 命令层规范见 [packages/engine/COMMAND.md](packages/engine/COMMAND.md)；
> **排程内核规范见 [packages/engine/SCHEDULE.md](packages/engine/SCHEDULE.md)**；
> **xlsx 协议规范见 [packages/xlsx-protocol/PROTOCOL.md](packages/xlsx-protocol/PROTOCOL.md)**（权威规范；
> 契约冻结见 [ADR 0006](docs/02-adr/0006-xlsx-协议契约.md)）。

## 环境

| 项 | 要求 |
|---|---|
| Node | **24 LTS**（`engines: >=24.0.0`；仓库根的 `.nvmrc` 写的也是 24）。更新的版本（如 26）实测可用，但 CI 与发布以 24 为准 |
| 包管理器 | pnpm（`packageManager: pnpm@10.34.6`，经 corepack 或全局安装均可） |
| 系统 | Windows / macOS / Linux 均可；门禁脚本刻意避开平台特定的可执行包装 |
| Python | **3.x（G2 起必需）**：只有**差分测试**用得到——G2 与 `tools/cpm-reference/` 的独立参照实现比对；**G3 起**另与 `tools/xlsx-reference/` 比对，需 **`openpyxl==3.1.5`**（`pip install openpyxl==3.1.5`）。门禁中**缺失即失败，不静默跳过**（[裁决 P-12](docs/00-baseline/裁决记录.md) / [ADR 0004](docs/02-adr/0004-排程契约.md) §9 / [ADR 0006](docs/02-adr/0006-xlsx-协议契约.md) §12） |

首次准备：

```bash
pnpm install          # 同时通过 prepare 钩子设置 core.hooksPath=.husky
pnpm gate             # 跑一次完整门禁，确认环境可用
```

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm gate` | **本地合并门禁**：lint → typecheck → test → build → license:check，任一步失败即阻断 |
| `pnpm lint` | ESLint（含三包零框架/零 DOM 铁律） |
| `pnpm typecheck` | `tsc --noEmit`（包）与 `vue-tsc --noEmit`（应用） |
| `pnpm test` | Vitest（纯函数测试）；缩小范围用 `pnpm vitest run packages/engine`（从仓库根执行） |
| `pnpm vitest run packages/engine/src/schedule.differential.spec.ts` | **只跑排程差分**（1,000 DAG + 200 成环图，需 Python 3；缺解释器即失败，可用 `GANTTPILOT_PYTHON` 指定） |
| `pnpm vitest run packages/xlsx-protocol` | **只跑 xlsx 协议**（含与 `tools/xlsx-reference/` 的 openpyxl 双向差分） |
| `pnpm vitest run packages/xlsx-protocol/src/xlsx.differential.spec.ts` | **只跑 xlsx 差分**（openpyxl 写 → JS 读、JS 写 → openpyxl 读；缺 Python 3 或 `openpyxl` 即失败） |
| `pnpm build` | 三包 `tsc -b`（产出 `dist/*.js` + `*.d.ts`）+ 应用 `vite build` |
| `pnpm --filter @ganttpilot/engine build` | 只构建/类型检查某个包（`build`/`typecheck` 支持 `--filter`） |
| `pnpm license:check` | 运行时依赖许可门禁（`--prod` 口径） |
| `pnpm license:check:all` | 全域口径（含开发依赖，检查是否出现未登记许可） |
| `pnpm notices:write` | 刷新 `THIRD_PARTY_NOTICES.md`（生成物，需一并提交） |
| `pnpm dev` | 启动 `apps/web` 开发服务器 |

## 铁律（以可执行检查保证，不是口头约定）

1. **`packages/{engine,xlsx-protocol,pptx-renderer}` 零框架、零 DOM 依赖。**
   - 类型层：这三包的 `tsconfig` 不引入 `DOM` lib，也没有 `@types/node` 全局；
   - Lint 层：`eslint-rules.mjs` 的三条规则会拦下 `import 'vue'`、`window`、`document` 等；
   - 自检层：`packages/engine/src/boundary.spec.ts` 断言上述规则确实生效。
   - 想加 Vue 生态的库（虚拟滚动、拖拽）请加在 `apps/web`。
2. **类型正确性由 tsc 负责，ESLint 只做结构检查**（没有启用类型感知规则，理由见 ADR 0001）。
3. **测试先行**：引擎与协议包的每个新能力都要有纯函数测试；排程内核还要求
   不变量/性质测试 + 手工推导用例 + 独立参照实现差分测试（见裁决 R-4）。
   **G2 起**差分资产落 `tools/cpm-reference/`（`engine` 包内**不放非 TS 资产**），
   差分步骤**在 `pnpm gate` 里真实运行**；随机种子固定并随失败信息打印，方便复现
   （见 [ADR 0004](docs/02-adr/0004-排程契约.md) §9）。
   **G3 起**同一纪律适用于 xlsx 协议：参照实现落 `tools/xlsx-reference/`，并与 JS 侧**只共享字段契约、不共享代码**。

## 文档模型（G1.2 之后必须遵守）

文档形状已冻结，规范说明见 [`packages/engine/SCHEMA.md`](packages/engine/SCHEMA.md)，
取舍与代价见 [ADR 0002](docs/02-adr/0002-文档模型与序列化契约.md)。改代码前请先读这两份，
其中最容易踩的四条：

1. **落盘用 ISO 日期 + 工作日工期**，工作日序号只在喂给 `Calendar` 时出现——
   文档不得被日历地平线容量绑定。
2. **`null` 表示缺失，且序列化始终显式写出全部规范字段**；因此往返一致可以直接用
   `toStrictEqual` 断言 `parseDocument(serializeDocument(doc))` 与 `doc`。
   反序列化容忍缺键但会产出 `info` 级诊断——**不要**改成静默吸收。
3. **`outlineNumber` 是派生值**，真相源是层级 + 文档序。校验只报告
   （`TREE_OUTLINE_STALE`），修复必须由调用方显式调用 `reindexDocument()`——
   **不允许在校验里顺手改写文档**。
4. **兄弟顺序 = 文档序**；调级带走整棵子树。新增任何"移动"类操作前，请先确认
   「父节点先于子节点出现在文档序」这条不变量仍然成立（`wbs.ts` 里有一条兜底断言）。

新增 schema 字段时的额外要求：同步 `SCHEMA.md` 的字段表、`canonicalizeDocument` 的规范键序、
`fixtures.spec.ts` 的夹具（否则「夹具是规范形状」用例会失败），以及本节的落地记录。

## 命令层契约（G1.3 之后必须遵守）

命令层规范见 [`packages/engine/COMMAND.md`](packages/engine/COMMAND.md)，
取舍与代价见 [ADR 0003](docs/02-adr/0003-命令层与事务契约.md)。改代码前请先读这两份，
其中最容易踩的五条：

1. **文档的变更只有一个通道**：新增任何文档写入路径都要**新增一个 `Command`**，
   不允许在应用层直接拼装文档（否则"命令产出必然合法"这条保证就有缺口）。
   新增 kind 时同步 `COMMAND_KINDS`、`COMMAND.md` 的命令表、以及"每个 kind 都被覆盖"的完备性用例。
2. **命令是纯数据、`applyCommand` 是纯函数**：不得引入时钟、随机数或全局自增
   （会破坏"同一命令序列 → 同一结果"）。id 由载荷显式给出，`suggestTaskId` 只是确定性建议。
3. **日志（before 镜像）clone-then-freeze**：冻结的是**日志自己的克隆体**，
   **绝不冻结调用方的文档**（`apps/web` 的 Vue 响应式依赖可写性）；
   应用日志时写出新鲜克隆。
4. **无操作不是失败**：恒等 patch 与 `WBS_SAME_POSITION` 返回 `{ok:true, changed:false}`，
   调用方据此**跳过撤销栈压入**；失败一律返回结构化码（不抛错），
   只有"日志与文档自相矛盾"这类程序员错误才抛 `RangeError`。
5. **结果合法性复用 `validateDocument`**：不要在命令层复制 schema 规则；
   需要 `warning` 级提示时在提交后自行调 `validateDocument`（命令层不复制诊断面）。

改动命令层时的测试要求：**双路互证**（命令产出 vs 既有领域函数 + 手工数组操作）、
**负向对照**（逆操作承重、日志条目承重、守卫有牙）、以及规模结构断言
（日志条目数与文档规模解耦）——它们都在 `journal.spec.ts` / `command.spec.ts` / `session.spec.ts` /
`documentPerformance.spec.ts` 里，改语义前先看它们为什么那样写。

## 排程内核契约（G2 之后必须遵守）

排程内核规范见 [`packages/engine/SCHEDULE.md`](packages/engine/SCHEDULE.md)，
冻结面见 [ADR 0004](docs/02-adr/0004-排程契约.md)、落地补齐见 [ADR 0005](docs/02-adr/0005-排程内核落地补齐与结果形状.md)。
改代码前请先读这三份，其中最容易踩的七条：

1. **`Schedule` 按 `document.tasks` 的文档序索引**，**汇总行 `es === -1`**（形状里唯一的汇总判别式，
   G4 靠它选汇总条分支）、叶子行的 `summary*` 为 `-1`。索引换成"叶子压缩序"会逼渲染层再维护一张映射表。
2. **`compute` 是纯函数且不写回文档**：不得修改入参（文档/日历/锚点），不得引入时钟或随机数，
   同一输入必须得到深比较相同的 `Schedule`。排程结果永远是派生值，撤销只回退"输入 + 会话锚点"。
3. **日期与工期不进热路径**：序号是唯一承载，日历只做"序号 ↔ 日期"翻译；
   **同一次调用里每个 ISO 日期只解析一次**（`isoToDayNumber` 走正则 + `Date.UTC`，
   不缓存会让 1,000 任务的全量传播 p99 从 0.53 ms 涨到约 2.5 ms）。
4. **有效图 vs 结构图不要搞混**：传播**排除**汇总端点边（并报 `summaryIgnored`），
   **检环用全部边**——`wouldCreateCycle(links, candidate)` 的签名看不到层级，两侧必须同口径。
5. **`clampedStarts` 与 `clampedStart` 诊断同源同数**：新增任何截断路径都要同时计数与报诊断
   （含"文档日期早于 `baseDay`"与"项目开始日早于 `baseDay`"两类）。
6. **诊断码表是闭集**（ADR 0004 §5）：不要为"校验层的职责"新开码；`endDateStale` 是**文档级**一致性诊断
   （对含汇总在内的所有任务判定），工期解析则只对叶子有意义。
7. **容量规划走 `createScheduleCalendar(document)`**：它一次决定"哪份日历生效 + `baseDay` + `spanDays`"；
   `compute` 内部虽会按需扩容保证序号不变，但**ISO 翻译是调用方的责任**，容量不足时 `isoOfOrdinal` 会抛错。

改动排程内核时的测试要求（三层证据 + 负向对照，R-4 落地）：
**手工推导用例表**（`schedule.manual.spec.ts`，内核无权改基准）、
**不变量/性质**（`schedule.invariants.spec.ts` + 独立检查器 `scheduleInvariants.spec.ts`）、
**跨语言差分**（`schedule.differential.spec.ts` + `tools/cpm-reference/cpm_reference.py`，
缺 Python 3 即失败）、**性能**（`schedule.performance.spec.ts`，1,000/1,500 全量 p99 ≤ 1 ms）。
改语义前先看这些用例为什么那样写；`perfHarness.spec.ts` 里的朴素实现是**性能负向对照**，
若它与快实现的差距量不出来（<1.5×），说明计时骨架失效。

## xlsx 协议契约（G3 之后必须遵守）

协议**权威规范**见 [`packages/xlsx-protocol/PROTOCOL.md`](packages/xlsx-protocol/PROTOCOL.md)，
契约冻结见 [ADR 0006](docs/02-adr/0006-xlsx-协议契约.md)，落地期口径补齐见
[裁决 P-15](docs/00-baseline/裁决记录.md)。改代码前请先读这三份，其中最容易踩的九条：

1. **日期一律 `Date.UTC(y, m-1, d)` 构造**：本地零点构造会写出带小数的序列号，Excel 显示**前一天**
   （已在三个独立场合实测复现）。`src/dates.ts` 是唯一构造点，代码里必须就地注释原因。
2. **日期读回用本地 getter**（`isoFromDate`）：ExcelJS 把序列号读成**绝对时刻**，
   用 UTC getter 会在 UTC+8 的常见场景下**差一天**。**「带时刻」的判据只认序列号的小数部分**
   ——用 `Date` 的时/分/秒判定会把每个整日日期都误报成带时刻（时区偏移）。
3. **导出写文档数据，不写排程结果**：`Schedule` 永远是派生值（ADR 0004 §2）。
   "与甘特图一致"的判据是"导出 → 再导入后 `compute()` 逐字段深比较相等"，**不是**把 `es/ef` 写进文件。
4. **公式只读缓存值**：无缓存值的公式单元格与"空单元格"在库里同形（`{formula, result: undefined}` / `None`）；
   必须按"值缺失"处理 + `XLSX_FORMULA_WITHOUT_CACHED_VALUE`，**永不自研求值器**（NG-06 / XL-08）。
5. **成环边丢弃必须确定性，且不得用 `compute` 兜底**：`compute` 遇环**整个失败**、诊断面只有一条 `cycle`；
   丢弃顺序固定为"工作表行序 × 单元格内前置出现顺序"，逐条 `wouldCreateCycle`、丢弃不回插。
6. **诊断码表是闭集**（PROTOCOL.md §七，22 条），且与文档侧/排程侧**同形**：
   最终问题清单是三层拼接的单一数组，协议层码**不替代**另两层；定位维度用 `{sheet, row, column, address}`。
7. **确定性判据取「部件指纹」，不得用整文件哈希**：`exceljs` 把写入时刻写进 zip 条目时间戳；
   文档时间戳（`created`/`modified`/`creator`）必须取常量。
8. **呈现属性有白名单**：表头加粗/列宽/数字格式/冻结首行可以加，**每加一类补一条结构断言**；
   批注、数据验证、条件格式、宏、图表、隐藏表一律不准（WPS 的"需要修复"多来自这一类别）。
9. **三个入口都是 `async`**，且库内**不得**静态 `import 'exceljs'`：必须 `await import('exceljs')`，
   否则 925 KB（min）会进浏览器首屏主 chunk（ADR 0006 §11）。

改动本块时的测试要求（与 G2 同构）：**声明式期望值表**（内核无权改基准）、**自往返幂等**
（文档深比较 + `compute` 深比较）、**跨语言差分**（`tools/xlsx-reference/`，openpyxl，**双向**，
缺 Python 3 或 openpyxl 即失败）、**负向对照**（S2 §三.1 的 5 条字节变造必须被报出）；
**性能只记录实测，不设会抖动的硬阈值**。

**协议文件不写在 `packages/xlsx-protocol` 之外**：三包**不放非 TS 资产**，参照实现落 `tools/xlsx-reference/`
（与 `tools/cpm-reference/` 并列）。

## 提交约定

- 使用语义化提交信息（`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:`）；
- 推送前请确保**工作区干净**：门禁检查的是磁盘上的当前内容，而不是将被推送的那个提交；
- 门禁不通过时请修复，不要习惯性 `git push --no-verify`。确需绕过时，在提交信息中说明原因。

## 新增依赖的准入流程

1. **许可**：运行时依赖必须落在 `scripts/check-licenses.mjs` 的白名单内（MIT / MIT/X11 / ISC / Zlib /
   Apache-2.0 / BSD 系 / 0BSD / CC0 / Unlicense / Python-2.0）。不在白名单时要先评估是否可接受，
   并在 PR 描述与（必要时）`docs/00-baseline/裁决记录.md` 中留痕。
   **注意**：G3 起 `xlsx-protocol` 有运行时依赖（`exceljs@4.4.0` 及其传递依赖，数量级约 90 个包），
   新增/升级必须重跑 `pnpm license:check` 与 `pnpm notices:write`。
   **传递依赖出现"许可不可判定"时（如 `license` 字段为空、上游不可达）：优先用 `pnpm-workspace.yaml`
   的 `overrides` 抬到已明确的版本，而不是开白名单豁免**——本仓库已这么处理过一次
   （`unzipper` 0.10 → 0.12.5，见裁决 P-15 第 4 条）。
2. **必要性与替代方案**：说明为什么不能自己写或用已有依赖（本项目偏好零依赖的纯函数实现）。
3. **健康度与体积**：记录最近发布、开放 issue 规模、包体（对纯前端静态部署尤其重要）。
   **浏览器侧的依赖必须动态导入**（`import()`），不要让大库进入首屏主 chunk——
   `exceljs` 的 `dist/exceljs.min.js` 实测 **925.5 KB min / 251.6 KB gzip** 且**不可 tree-shaking**
   （包内没有 ESM 入口），这是引入它时唯一必须同时做的工程动作。
4. **更新清单**：跑 `pnpm notices:write` 并把 `THIRD_PARTY_NOTICES.md` 一起提交。

## 文档约定

- 文档**不做版本号另存**（不使用 `-v2`、`-第二轮` 后缀），修订由 git 历史承担；
- 裁决类信息统一进 `docs/00-baseline/裁决记录.md`，按时间追加，已裁决条目不改写（推翻则追加新条目）；
- 架构决策写成 ADR 放在 `docs/02-adr/`，文件名形如 `NNNN-主题.md`。
