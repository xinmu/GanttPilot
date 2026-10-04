# 贡献指南

> 本项目当前处于 v0.1 的 **G1.1（日历与日期算术）、G1.2（文档 schema、版本迁移与 WBS 层级）、
> G1.3（命令层与事务）、G2（最小正向传播内核）、G3（xlsx 导入/导出，仅可见列）、
> G4（纯 SVG 甘特渲染，含裁剪）与 G5（编辑体验：拖拽三语义 + 撤销重做）均已完成**阶段：
> `packages/engine` 已落地工作日序号化日历与 O(1) 日期翻译、**冻结的文档模型**（规范化序列化/解析、
> 结构化诊断校验、`v1→v2→v3` 迁移、WBS 调级）、**命令层**（唯一变更通道、before 镜像、事务与撤销/重做栈）、
> **排程内核**（全量正向传播 + 锚点四情形 + 汇总聚合 + 结构性检环 + 受影响闭包）；
> `packages/xlsx-protocol` 交**协议层**（9 列契约双解析、容差闭集、公式只读缓存值、
> 确定性成环丢弃、三层拼接诊断、规范化导出与部件指纹确定性）；
> **`packages/render-core`** 交**渲染几何与裁剪内核**（视图模型、时间轴与 x 坐标、
> 正交路由、行/边/水平三窗口裁剪、元素预算、受影响子集）**与 G5 的列身份 + 拖拽手势内核**
> （列契约的所有权、单元格文本与编辑派生值、指针 → 状态机 → 会话锚点/命令、成环高亮），
> `apps/web` 交 Vue 视图层（左表右图分屏、虚拟滚动、折叠、行内编辑、xlsx 导入接线、
> **拖拽三语义 / 建线 / 撤销重做 / 冲突与成环标记 / 诊断清单**）。
> **至此「Excel 导入 → 出图 → 拖动 → 撤销」这条主链路在浏览器里已跑通**（拖拽帧率已定标：
> 帧间隔 p50/p95 = 16.6/16.8 ms、松手 → 重算 + 冲突标记 8.2 ms）。
> **下一步是 G6**（持久化：自动保存 + 命令回退栈）。
> **G5 的落地记录见 [《首版能力顺序》§三 G5](docs/01-roadmap/首版能力顺序.md) 与
> [裁决 P-20](docs/00-baseline/裁决记录.md)**：列身份所有权与拖拽交互契约在
> [ADR 0008](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) 冻结，
> 规范见 [`packages/render-core/SPEC.md`](packages/render-core/SPEC.md)，
> 记录制实测见 [`apps/web/evidence/drag-timing-chrome152.md`](apps/web/evidence/drag-timing-chrome152.md)。
> **G4 的落地记录见 [《首版能力顺序》§三 G4](docs/01-roadmap/首版能力顺序.md) 与
> [裁决 P-18](docs/00-baseline/裁决记录.md)**：几何真相源与包边界、时间轴与 x 坐标、
> 裁剪契约在 [ADR 0007](docs/02-adr/0007-渲染几何与裁剪契约.md) 冻结，
> 数值由 [G4-S](docs/00-baseline/证伪实验计划.md) 回填（`S4-a`…`S4-d`）。
> **G3 的开工前置已闭**：列契约、单元格容差、公式口径、成环丢弃顺序、导出物白名单与协议层诊断码表已在
> [ADR 0006](docs/02-adr/0006-xlsx-协议契约.md) 冻结（裁决 P-14），落地期的四条口径补齐见
> [裁决 P-15](docs/00-baseline/裁决记录.md)。
> 能力顺序与每块出口条件见 [首版能力顺序](docs/01-roadmap/首版能力顺序.md)；
> 关键决策见 [docs/02-adr](docs/02-adr/)（排程契约 = [ADR 0004](docs/02-adr/0004-排程契约.md) +
> [ADR 0005](docs/02-adr/0005-排程内核落地补齐与结果形状.md)；渲染契约 = [ADR 0007](docs/02-adr/0007-渲染几何与裁剪契约.md)）；
> 分解依据见 [裁决 P-10](docs/00-baseline/裁决记录.md)；文档模型规范见 [packages/engine/SCHEMA.md](packages/engine/SCHEMA.md)；
> 命令层规范见 [packages/engine/COMMAND.md](packages/engine/COMMAND.md)；
> **排程内核规范见 [packages/engine/SCHEDULE.md](packages/engine/SCHEDULE.md)**；
> **渲染几何与裁剪规范见 [packages/render-core/SPEC.md](packages/render-core/SPEC.md)**；
> **xlsx 协议规范见 [packages/xlsx-protocol/PROTOCOL.md](packages/xlsx-protocol/PROTOCOL.md)**（权威规范）。

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
| `pnpm vitest run packages/render-core` | **只跑渲染几何与裁剪**（几何期望值表、裁剪与元素预算、规模解耦、箭头可区分性、受影响子集） |
| `node scripts/measure-render.mjs` | **打包产物测量**（记录制、**不进 `pnpm gate`**）：先 `pnpm --filter @ganttpilot/web build`，再驱本机 Chrome 测首屏与 10× 滚动并写 `apps/web/evidence/render-timing-chrome<大版本>.md`。缺 Chrome 即失败，可用 `GANTTPILOT_CHROME` 指定；`--zoom=day|week|month` / `--rounds=` / `--steps=` / `--no-reference` 可选 |
| `node scripts/measure-render.mjs --drag` | **G5 拖动测量**（记录制）：同样先构建，再用**真实指针事件**拖 3 个工作日，测帧间隔、主线程同步工作量、松手 → 重算 + 冲突标记的墙钟与"下游跟随"的 DOM 证据，写 `apps/web/evidence/drag-timing-chrome<大版本>.md`；`--day-delta=` / `--drag-frames=` 可选 |
| `pnpm build` | 四包 `tsc -b`（产出 `dist/*.js` + `*.d.ts`）+ 应用 `vite build` |
| `pnpm --filter @ganttpilot/engine build` | 只构建/类型检查某个包（`build`/`typecheck` 支持 `--filter`） |
| `pnpm license:check` | 运行时依赖许可门禁（`--prod` 口径） |
| `pnpm license:check:all` | 全域口径（含开发依赖，检查是否出现未登记许可） |
| `pnpm notices:write` | 刷新 `THIRD_PARTY_NOTICES.md`（生成物，需一并提交） |
| `pnpm dev` | 启动 `apps/web` 开发服务器 |

## 铁律（以可执行检查保证，不是口头约定）

1. **计算层各包零框架、零 DOM 依赖。**
   `packages/{engine,xlsx-protocol,pptx-renderer}` 三包是原文口径；
   **G4 起 `packages/render-core` 并入同一约束集**（[裁决 P-16](docs/00-baseline/裁决记录.md)），
   文档中的"三包"措辞不改写，自 P-16 起按「**计算层各包（含 `render-core`）**」解读；
   - 类型层：这些包的 `tsconfig` 不引入 `DOM` lib，也没有 `@types/node` 全局；
   - Lint 层：`eslint-rules.mjs` 的三条规则会拦下 `import 'vue'`、`window`、`document` 等；
   - 自检层：`packages/engine/src/boundary.spec.ts` 断言上述规则确实生效；
   - 每个计算层包都放一组**故意违规的夹具**（`<pkg>/lint-boundary/*.fixture.ts`）——
     它们被 ESLint 全局忽略，只由上面那条自检以文本方式加载；新增计算层包**必须补这一组夹具**，
     否则"本包受铁律约束"就只是口头约定。
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

## 渲染几何与裁剪契约（G4 之后必须遵守）

契约**冻结面**见 [ADR 0007](docs/02-adr/0007-渲染几何与裁剪契约.md)（G4 的开工前置），
数值回填见 [G4-S 准入定标实验](docs/00-baseline/证伪实验计划.md)，
**权威规范见 [`packages/render-core/SPEC.md`](packages/render-core/SPEC.md)**，
落地期裁决见 [P-18](docs/00-baseline/裁决记录.md)。改代码前请先读这几份，其中最容易踩的十条：

1. **几何只有一份，且必须在门禁内**：几何与裁剪是 `packages/render-core` 的**纯函数**
   （零 DOM、零框架，**可在 `environment: 'node'` 下断言**）。
   根 `vitest.config.ts` 的收集范围是 `packages/*/src/**/*.spec.ts`——
   **不要把几何写进 `apps/web`**：那样它既进不了门禁，又会被 G7 复制出第二份（两个真相源）。
   `apps/web` 与 G7 的导出投影**都只消费 `ViewModel`**（铁律 #2 的载体）。
2. **x 轴按自然日连续，非工作日占位**；映射只用 G1.1 的 `Calendar`：
   `xLeft = (dayOfOrdinal(es) − axisOriginDay) · pxPerDay`；
   **`xRight = (dayOfOrdinal(ef − 1) + 1 − axisOriginDay) · pxPerDay`**——
   用 `dayOfOrdinal(ef)` 会让跨周末的条多出一段空隙（`ef` 是**排他**序号）。
   汇总条同规则取 `summaryEs`/`summaryEf`；**`es[i] === -1` 是唯一的汇总判别式**，
   **`-1` 绝不可喂给 `dayOfOrdinal`**（`barXRange` 会抛 `RangeError`）；
   翻译必须用同一个 `createScheduleCalendar(document)`。
3. **里程碑的几何中心**取所在工作日**格的中点**（视觉约定，不改变"零时长"语义）；
   **轴线左端必须留 `AXIS_LEFT_GUTTER_DAYS`**——那是 SS/SF"左出回绕"走线的空间，不是装饰。
   **`ef === 0` 的零时长任务必须走菱形分支**（`dayOfOrdinal(-1)` 会抛错）。
4. **裁剪四条**：行窗口 = 可见行 + 缓冲行；**边窗口 = 边所跨行区间 ∩ 渲染窗口**（用端点可见性裁剪
   会错误隐藏跨屏长箭头，这是**必须被负向对照检出**的那一类 bug）；**折叠隐藏的行不画其边**
   （与上一条**同一遍**求交完成）；**裁剪先于几何计算**、拖拽期不做逐帧 DOM 重建。
   **第三维是水平窗口**：轴与刻度只发射视口 x 范围内的元素（`c₃` 因此与文档总规模无关）。
5. **文档里的全部 `links` 都画**（含被传播忽略的汇总端点边，样式键 `edge-ignored`，**不新开诊断码**）：
   渲染呈现的是**文档数据**，不是"排程用了哪些边"（`SCHEDULE.md §四.6` 的有效图 ≠ 结构图）。
6. **出/入边策略的唯一登记处是 [P-8](docs/00-baseline/裁决记录.md) 第 1 条**，不要在 ADR 0007 或代码里
   重述那张表（避免两处真相源）；折点参数（stub / 回绕 / 箭头形态）以 ADR 0007 §5 为准。
   **同侧多线避让 v0.1 不做**——出现真实取舍要**另立 ADR**，不要顺手实现。
7. **元素模型与计数的维护纪律**：`countElements` 的元素模型必须与 `apps/web` 的 SVG 模板**一一对应**——
   每渲染行 = `<g>` + 条/菱形 + 进度（≤3）、每条渲染边 = 折线 + 箭头 + **透明热区**（3）、
   轴 = 色带 + 网格线 + 标签。**改模板必须同步 `ELEMENT_MODEL` 的 `c₁`/`c₂`**，
   G5 若给行加交互热区**必须另加常数**；`countElements` 与 `countElementsByEnumeration` 必须逐项相等。
8. **G4 不做诊断 UI、不做拖拽**：`undated`/`dateOverridden`/`clampedStart` 的呈现归 G5（G-8/IX-04）；
   行内编辑**只走 `task.update`**（含 `collapsed`，因此折叠天然可撤销），编辑后按
   "**受影响行 + 受影响边**"重绘（`affectedRenderSet` = `affectedClosure()` + 沿 `parentId` 补祖先链），
   **不得整表重建**——但**折叠/展开会改变可见行集合**，此时窗口重算属必要行为。
9. **降级/规模声明不许"顺手"改**：并发数不达标时的动作是[《首版能力顺序》§四](docs/01-roadmap/首版能力顺序.md)
   的"规模上限下调至 500 任务并明确声明"，且**判据来源是 G4-S 的 `S4-a`**。
10. **门禁分层**（ADR 0007 §9）：几何期望值表 / 裁剪结构断言 / 不变量 / 负向对照**进 `pnpm gate`**；
    **浏览器计时维持"记录制"**（[裁决 P-17](docs/00-baseline/裁决记录.md)：需要本机 Chrome，
    而真正需要门禁的判据已在 Node 侧；P-9"哨兵 ≠ 门禁"口径）。
    零新增依赖路径：元素计数落 `render-core` 的两路互证（**不用** `@vue/server-renderer`——
    它会把 `vue` 拉成计算层依赖，见 [P-18](docs/00-baseline/裁决记录.md)）；
    **浏览器计时用 Node 内置 `fetch` + `WebSocket` 通过 CDP 驱动本机 Chrome**，
    复现命令 `node scripts/measure-render.mjs`（先 `pnpm --filter @ganttpilot/web build`；
    **缺 Chrome 即失败**，`GANTTPILOT_CHROME` 可指定；证据按 Chrome 大版本分文件写在 `apps/web/evidence/`）。
    它是**打包产物**的测量：用 `Emulation.setDeviceMetricsOverride` 固定视口 1280×800，
    并以 `?table=0` 让图表全宽（后者是工具栏上的真实功能"隐藏左表"）——**换视口就要跟着换数字**。
    要引入 Playwright 等浏览器自动化或 jsdom/happy-dom 时，仍走下面的"新增依赖的准入流程"，
    并在裁决中写明"**是否进门禁、缺失时是失败还是跳过**"（P-12 口径：**缺失即失败，不静默跳过**）。

改动本块时的测试要求（与 G2/G3 同构）：**声明式几何期望值表**（内核无权改基准）、
**裁剪结构断言 + 元素预算**（元素数与文档总规模解耦）、**反算不变量**、
以及**负向对照**（端点可见性裁剪必须丢边；关掉窗口裁剪元素数必须增长；故意错的几何必须被检出）——
没有负向对照，"元素数与总规模无关"可能是恒真式。

**列身份的所有权（G5 起，[ADR 0008](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) §1–§3）**：
九列契约 `COLUMN_SPECS` / `ColumnKey` / `SHEET_NAME` / `HEADER_ROW` 的**唯一真相源在
[`packages/render-core/src/columns.ts`](packages/render-core/src/columns.ts)**；
`packages/xlsx-protocol/src/columns.ts` 只是**转型再导出**（公共 API 面一个符号不减）。
依赖方向因此是 `engine ← render-core ← xlsx-protocol`——
**不要再把列定义搬回 `xlsx-protocol`**（那会让 `render-core` 经它牵出 925 KB 的 `exceljs`，
与"计算层零框架/零 DOM、可独立测试"冲突；这条由 `render-core` 的 `boundary.spec.ts` 断言守住）。
历史背景：G4 落地期 **`apps/web` 的 `shared.ts` 静态 import 了 `xlsx-protocol` 的列契约**，
Vite 因此报一条 `INEFFECTIVE_DYNAMIC_IMPORT`；该静态边已随所有权反转**一并消除**
（`exceljs` 仍在独立 chunk（929.61 kB）里、由用户动作触发才加载，首屏主 chunk 不含它）。

## 列文本与日期口径（P-19 之后必须遵守）

**可测的纯函数不许留在 `apps/web`**（[裁决 P-19](docs/00-baseline/裁决记录.md) 第十九轮 +
[ADR 0008](docs/02-adr/0008-列身份所有权与拖拽交互契约.md)）：左表单元格文本 `cellText`、
派生完成日 `derivedEndIso`、值→命令映射 `editToCommand`/`collapseToCommand` 与日期文本工具
全部落 [`packages/render-core/src/viewText.ts`](packages/render-core/src/viewText.ts)，并随 `pnpm test` 进门禁。最容易踩的四条：

1. **凡"只有日历能算"的量，一律显式收 `Calendar`**（`cellText({..., calendar})` /
   `derivedEndIso({..., calendar})` / `editToCommand({..., calendar})`，与 `ordinalAtX(view, x, calendar)` 同手法）；
   日历必须来自 **`createScheduleCalendar(document)`** —— 与 `buildView` 用的是**同一个**。
   **不存在"应用级日历"这种东西**：`APP_CALENDAR` 已删除，`viewText.ts` 里出现
   `APP_CALENDAR` / `new Calendar(` / `DEFAULT_PROJECT_BASE_DAY_ISO` 会被 spec 判失败；
2. **`-1` 是哨兵，绝不可喂给 `dayOfOrdinal`**：汇总行取 `summaryEs`/`summaryEf`，
   派生完成用 `summaryEf − 1`（`ef`/`summaryEf` 是**排他**结束序号）；
3. **派生「完成」必须与"显示的「开始」"同源**：开始列显示文档 `startDate` 时从它推进，
   否则从排程序号推进；**`工期 = 0`（里程碑）时完成 = 开始**，不是"前一个工作日"
   （通用式 `start + 工期 − 1` 在零时长会退化成前一天——实测 49 行反向）；
4. **编辑派生值必须与图表同源**：`editToCommand` 改 `start`/`duration` 时写回的 `endDate`
   必须等于应用后 `compute` 的"最后一个工作日"ISO；改口径前先看
   `dateText.spec.ts` / `dateTextNegative.spec.ts` / `editCommand.spec.ts` 为什么那样写
   （判据 ① ② ③ + NC1/NC2；没有负向对照，这些断言可能只是恒真式）。

## 拖拽与手势契约（G5 之后必须遵守）

契约草案见 [ADR 0008](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) §4–§11，
判据见 `packages/render-core/src/gesture.spec.ts`（**进 `pnpm gate`**），
记录制实测见 [`apps/web/evidence/drag-timing-chrome152.md`](apps/web/evidence/drag-timing-chrome152.md)。
改手势前请先读这几份，其中最容易踩的六条：

1. **手势逻辑是纯函数，住 `render-core/src/gesture.ts`**：入参是**归一化指针**
   （`{x, y, buttons, altKey, escPressed}`，**内容坐标**，绝不出现 `MouseEvent`），
   出参是 `{anchors, commands, link, rows, edges, cyclePath, preview}`。
   `apps/web/src/composables/useGesture.ts` 是**唯一**碰 DOM 的手势代码——
   把判定逻辑写进组件就等于把它移出门禁（P-19 的教训）；
2. **拖动期文档一字不改**：位置经**会话锚点**（`compute(document, calendar, anchors)`）；
   松手才提交**一条** `task.update` / `link.insert` 并清锚点（一次手势 = 一层撤销，IX-03）；
   `Esc` 取消 ⇒ 清锚点、不提交；
3. **冲突判据只有 `compute` 的 `anchorConflict` 一处**：**"晚于入边约束"不是冲突**
   （`ES = max(约束, 锚点)`，任务往后排正是用户要的）；**"早于"约束才是**
   （[SCHEDULE.md](packages/engine/SCHEDULE.md) §四.3 情形④）。UI 不自己判"算不算冲突"，
   只做样式映射——不新开诊断码；
4. **`snapCandidate` 夹的是上界**：`min(max(candidate, 0), 约束)`。
   "约束之前的位置必须**留在**约束之前"这条**上界**断言是唯一能抓出方向错误的判据
   （落地期实测：把约束当下界会用 `max` 写出一个**违反**约束的锚点，而"不得违反约束"的断言反而抓不到）；
5. **高亮不进 `ViewModel`**：`ViewModel` 只由「文档 + `Schedule` + `Calendar` + 视口」决定，
   交互态进去会让几何期望值表与裁剪判据跟着手势漂移。高亮走 `highlight.ts` 的独立覆盖层；
6. **元素预算另立 `c₄`**：改 `GanttChart.vue` 的覆盖层模板必须同步 `ELEMENT_MODEL_G5.overlay`
   与 `countOverlays` / `countElementsByEnumeration` 的覆盖层分支（两路必须逐项相等）；
   覆盖层**一律 `pointer-events: none`**，不得抢走条体/边的交互热区（ADR 0007 §5）。

**记录制实测**：`node scripts/measure-render.mjs --drag`
（先 `pnpm --filter @ganttpilot/web build`；缺 Chrome 即失败，`GANTTPILOT_CHROME` 可指定）。
它驱动**真实指针事件**（`mousedown → mousemove×N → mouseup`），测帧间隔、主线程同步工作量、
松手 → 重算 + 冲突标记的墙钟，以及"拖动期 DOM 确实变化"这条下游跟随证据。

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
