# 贡献指南

本文件是**开工入口**：环境怎么备、命令怎么跑、铁律是什么、契约去哪读。它**不复述契约**——每份契约的权威住所在下表；冲突时**以权威住所为准**。

- **怎么用**：先读「环境 / 开发命令 / 铁律」；改某块代码前，在「契约读哪里」找到它的**权威住所**并读它。
- **刻意不写在这里**：契约数字（阈值、锚值、像素、色值、诊断码条数）与契约语义只在权威住所声明一份；本页写了就是第二份声明，`node scripts/check-constants.mjs` 会抓。
- **规划与台账**：[首版能力顺序](docs/01-roadmap/首版能力顺序.md)、[首版-待定清单](docs/01-roadmap/首版-待定清单.md)、[裁决记录](docs/00-baseline/裁决记录.md)（**唯一权威登记处**）；逐轮细则在 `docs/00-baseline/裁决R*.md`（**存档**）。
- **历史口径**：G1–G8 的落地过程与实测在记录层（例：[G5 落地记录 · 历史](docs/01-roadmap/首版-记录-G5.md)）——**不要**当成当前契约。

## 环境

| 项 | 要求 |
|---|---|
| Node | **24 LTS**（`engines: >=24.0.0`；`.nvmrc` 同为 24）。更新的版本实测可用，但 CI 与发布以 24 为准 |
| 包管理器 / 系统 | pnpm（`packageManager: pnpm@10.34.6`，corepack 或全局安装均可）；Windows / macOS / Linux 均可，门禁脚本避开平台特定的可执行包装 |
| Chrome | **必需**：`smoke:build` 用本机 Chrome 打开**打包产物**并断言界面真的渲染了；缺失即失败、不跳过（`GANTTPILOT_CHROME=<path>` 可指定） |
| Python | **3.x 必需**：只有**差分测试**用得到（`tools/cpm-reference/`、`tools/xlsx-reference/` 的参照实现，后者需 `openpyxl==3.1.5`）。缺失即失败、不静默跳过（[P-12 依据](docs/00-baseline/裁决记录.md)） |

首次准备：`pnpm install`（经 prepare 钩子设 `core.hooksPath=.husky`）→ `pnpm gate`。

**无头 Chrome 的收尾**：[`scripts/chrome-harness.mjs`](scripts/chrome-harness.mjs) 的三条不变量——profile 白名单 / 不杀进程（协议级 `Browser.close` 优先，超时才按 PID 树兜底并核对命令行）/ 禁止按名字匹配 `chrome.exe`；`--user-data-dir` 只在 `tmp/`（**不入库**，已 gitignore）下取。自检 `node scripts/chrome-harness.selftest.mjs`。

## 开发命令

| 命令 | 用途 |
|---|---|
| `pnpm gate` | **本地合并门禁**：`lint → build → typecheck → test → smoke:build → bundle:offline → smoke:build:file → license:check → docs:check`，任一步失败即阻断。顺序的权威定义是 `scripts/gate.mjs` 的 `STEPS`——**构建先于类型检查**，缘由见 [ADR 0001 附录细则 §1](docs/02-adr/附录/0001-增补.md) |
| `pnpm lint` / `typecheck` / `test` | ESLint（含三包零框架/零 DOM 铁律）/ `tsc --noEmit` + `vue-tsc --noEmit` / Vitest 纯函数测试（`pnpm vitest run <路径>` 可缩小范围） |
| `pnpm build` | 四包 `tsc -b` + 应用 `vite build`；`--filter @ganttpilot/engine` 可只构建/类型检查某包 |
| `pnpm dev` / `preview` | 开发服务器（**开发用，数字不进证据**）/ **预览打包产物**（人工复验口径） |
| `pnpm vitest run <路径>` | 只跑某块：`packages/render-core`（几何与裁剪）、`packages/xlsx-protocol`（协议；加 `/src/xlsx.differential.spec.ts` 则只跑双向差分）、`packages/engine/src/schedule.differential.spec.ts`（排程差分，1,000 DAG + 200 成环图，需 Python 3） |
| `pnpm smoke:build` | **打包产物冒烟**（进门禁）：HTTP 伺服 `dist/` + 无头 Chrome 断言无应用级错误、关键 DOM 都渲染，并真的点三次导出、校验落盘；G8 起另加四组应用层判据 |
| `pnpm bundle:offline` / `smoke:build:file` | **离线单文件**（进门禁）：外链 module 与样式**内联**成一个 HTML → 断言"恰好一个文件、零外链、零 `assets/` 引用"；再以 `file://` 打开它跑**导入/拖动/导出三条主链路**并登记 IndexedDB 可用性 |
| `pnpm license:check` / `license:check:all` / `pnpm notices:write` | 许可门禁（`--prod` 口径）/ 全域口径 / 刷新 `THIRD_PARTY_NOTICES.md`（生成物，需一并提交） |

**记录制测量（不进 `pnpm gate`；缺 Chrome 即失败）**：主口径 `node scripts/measure-render.mjs`（首屏与 10× 滚动；`--align` / `--zoom=` / `--rounds=` / `--steps=` 可选）。先 `pnpm --filter @ganttpilot/web build`，读数写进 `apps/web/evidence/`；`node scripts/make-sample.mjs` 生成成环样本 `tmp/samples/cyclic-dependency.xlsx`（**不入库二进制**）。

- `--drag` / `--persist-drag`：**真实指针事件**拖 3 个工作日 ⇒ 帧间隔、主线程同步工作量、松手 → 重算 + 冲突标记的墙钟，与**位移判据**（松手后 `startDate` = 按下时的开始序号 + 天数）；两种语义各跑两个滚动状态（[P-45 依据](docs/00-baseline/裁决R44.md)）。
- `--import=<xlsx>` / `--storage-metrics`：前者经 CDP 走**真实导入入口**并读回计数与诊断清单；后者（2,000 任务）记文档体积、增量记录体积与 `put` 延迟分位。
- `pnpm probe:offline`（先 `pnpm bundle:offline`）：单文件产物的四个问题——IndexedDB / 下载 / 体积与首屏 / 断网三链路。

## 铁律（以可执行检查保证，不是口头约定）

1. **计算层各包零框架、零 DOM 依赖**：`packages/{engine,xlsx-protocol,pptx-renderer}` 是原文口径，**G4 起 `packages/render-core` 并入同一约束集**（[P-16 依据](docs/00-baseline/裁决记录.md)）；文档里的"三包"措辞不改写，按「**计算层各包（含 `render-core`）**」解读。三层守：`tsconfig` 不引 `DOM` lib、无 `@types/node` 全局；`eslint-rules.mjs` 拦下 `import 'vue'`、`window`、`document`；`boundary.spec.ts` 断言规则生效。**每个计算层包都要放一组故意违规的夹具**（`<pkg>/lint-boundary/*.fixture.ts`，被 ESLint 全局忽略、只由自检加载），否则"受铁律约束"只是口头约定。想加 Vue 生态的库（虚拟滚动、拖拽）请加在 `apps/web`。
2. **类型正确性由 tsc 负责，ESLint 只做结构检查**（没有类型感知规则，理由见 [ADR 0001 依据](docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md)）。
3. **测试先行**：引擎与协议包的每个新能力都要有纯函数测试；排程内核另要求不变量/性质测试 + 手工推导用例 + 独立参照实现差分测试（裁决 R-4）。差分资产落 `tools/cpm-reference/`（G2）与 `tools/xlsx-reference/`（G3）——**包内不放非 TS 资产**；差分步骤**在 `pnpm gate` 里真实运行**，随机种子固定并随失败信息打印；参照实现与 JS 侧**只共享字段契约**。

## 契约读哪里（本页只写"最容易踩的坑"，契约语义以权威住所为准）

| 契约 | 权威住所（读这里） | 最容易踩的 2–3 条 |
|---|---|---|
| 文档模型（G1.2） | [SCHEMA.md](packages/engine/SCHEMA.md)、[ADR 0002 依据](docs/02-adr/0002-文档模型与序列化契约.md) | ① 落盘用 **ISO 日期 + 工作日工期**，序号只在喂 `Calendar` 时出现；② `outlineNumber` 只是派生值：校验报 `TREE_OUTLINE_STALE`，修复必须由调用方显式 `reindexDocument()`；③ `workDays` 省略、`exceptions` 显式。 |
| 命令层（G1.3） | [COMMAND.md](packages/engine/COMMAND.md)、[ADR 0003 依据](docs/02-adr/0003-命令层与事务契约.md) | ① **变更只有一个通道**：新增写入路径必须新增 `Command`（同步 `COMMAND_KINDS` 与用例）；② `applyCommand` 是**纯函数**，**命令层不生成 id**；③ 日志 before 镜像 **clone-then-freeze**，**绝不冻结调用方的文档**。 |
| 排程内核（G2） | [SCHEDULE.md](packages/engine/SCHEDULE.md)、[ADR 0004 依据](docs/02-adr/0004-排程契约.md)、[ADR 0005 依据](docs/02-adr/0005-排程内核落地补齐与结果形状.md) | ① `Schedule` 按**文档序**索引，**汇总行 `es === -1` 是唯一汇总判别式**；② **有效图 ≠ 结构图**（传播排除汇总端点边、检环用全部边）；③ 性能阈值只在 `schedule.performance.spec.ts` 的 `P50_BUDGET_NS` / `P99_BUDGET_NS` 声明；红了先分**实现退化 vs 并行争用**，动作是**隔离 / 限并行**。 |
| xlsx 协议（G3） | [PROTOCOL.md](packages/xlsx-protocol/PROTOCOL.md)、[ADR 0006 依据](docs/02-adr/0006-xlsx-协议契约.md) | ① 日期一律 `Date.UTC` 构造、本地 getter 读回（`src/dates.ts` 唯一构造点）；② **导出写文档数据、不写排程结果**；③ **成环边丢弃须确定性、不得用 `compute` 兜底**；库内**不得静态 `import 'exceljs'`**。诊断码条数声明处 `src/diagnostics.ts`。 |
| 渲染几何与裁剪（G4） | [SPEC.md](packages/render-core/SPEC.md)、[ADR 0007 依据](docs/02-adr/0007-渲染几何与裁剪契约.md)、[ADR 0007 附录 §3 细则](docs/02-adr/附录/0007-增补.md) | ① **`-1` 绝不可喂给 `dayOfOrdinal`**（抛 `RangeError`），`ef` / `summaryEf` 是**排他**结束序号；② **几何只有一份且在门禁内**——不要写进 `apps/web`（会出第二份真相源）；③ 改 `apps/web` 的 SVG 模板必须同步 `ELEMENT_MODEL` 的两路计数。 |
| 列身份所有权（G5） | [columns.ts](packages/render-core/src/columns.ts)、[ADR 0008 依据](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) §1–§3 | ① 九列契约（`COLUMN_SPECS` / `ColumnKey` / `SHEET_NAME` / `HEADER_ROW`）的唯一真相源在 `render-core`，`xlsx-protocol` 那份只是**转型再导出**；② 依赖方向 `engine ← render-core ← xlsx-protocol`——**不要把列定义搬回 `xlsx-protocol`**（会让 `render-core` 牵出 `exceljs`）。 |
| 列文本与日期（G5） | [viewText.ts](packages/render-core/src/viewText.ts)、[ADR 0008 依据](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) | ① **可测的纯函数不许留在 `apps/web`**；② 只有日历能算的量一律**显式收 `Calendar`**（来自 `createScheduleCalendar(document)`）——**不存在"应用级日历"**；③ **`工期 = 0`（里程碑）时完成 = 开始**。 |
| 拖拽与手势（G5） | [gesture/（纯内核）](packages/render-core/src/gesture/index.ts)、[ADR 0008 依据](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) §4–§11、`packages/render-core/src/gesture.spec.ts` | ① **`RowBox.y` 是行顶、`TaskBounds.y` 是条心，不可互用**；② 候选基准**必须取按下时捕获的 `state.originOrdinal`**（不是"指针所在行的 `es`"，否则累积成加速拖动），**零位移不产出命令**；③ **重复边预检拒绝且不产出 `cyclePath`**；**drag 的目标行必须无有效入边约束，否则记录制假红**。坐标换算只有 `pointerFromClient`，禁用 `MouseEvent.offsetX/offsetY`。 |
| G8 发布面（刻度 / 悬停带 / 模板 / 离线单文件） | [ADR 0007 附录 §3 细则](docs/02-adr/附录/0007-增补.md)、[ADR 0006 附录 §1 细则](docs/02-adr/附录/0006-增补.md)、[P-49 依据](docs/00-baseline/裁决R47.md) | ① 两级刻度基线（`MINOR_LABEL_BASELINE_PX` / `MAJOR_LABEL_BASELINE_PX` / `HEADER_HEIGHT_PX`）**只在 `manifest.ts` 一处声明**，屏幕 SVG / 导出 SVG / PPTX 都取自那里（写死一处即"所见 ≠ 所导出"，无单测可抓）；② **`c₃` 逐档位锚值只声明在 `clipping.spec.ts` 的 `expectedC3`**；悬停行带是**覆盖层项**、不是 `c₃` 项；③ **`file://` 单文件必须保留 `type="module"`**。 |

**跨块三条**：坐标换算 / 命中 / 反算类判据**必须至少取一个非 0 滚动位置**（[P-41 依据](docs/00-baseline/裁决R40.md)）；记录制数字只在同口径同负载下可比（[P-26 依据](docs/00-baseline/裁决记录.md)）；高亮不进 `ViewModel`，走独立覆盖层且 `pointer-events: none`。**契约常量一律只写符号名**：`HEADER_HEIGHT_PX` / `EDGE_STUB_PX` / `EXPORT_TICK_LENGTH_PX` / `c₄` 系数 / 轴与条色值的声明处是 `render-core` 的 `manifest.ts` 与 `svgExport.ts`。

## 代码格式（**不引入格式化器**，P3/C6-g 裁决）

**现状**：仓库**没有**格式化器，也**不加** `format:check`。这条是**裁决**，不是遗漏——[登记与本轮不做 §四.7](docs/04-refactor/05-登记与本轮不做.md) 记了完整理由，要点两条：

1. 引入即**新增依赖**（要走下面的准入流程），且**必然**产出一次全仓重排的大 diff——它与"一批一个提交、每批可独立 review"的纪律直接冲突；
2. 本项目在格式上的实际痛点**只有一类**：**两条语句 / 两条 import / 散文与列表项挤在同一行**。P3 期间实测清掉 **7 处**（`App.vue` 两条 import 同一行、`measure/drag.ts` 两处 `};}`、`measure/index.ts` 一处参数与 `{` 同行、C6-e 又清 3 处），**全部靠人眼发现**——这既是"没有工具就得靠人眼"的实证，也说明这类形态**是缺陷**，只是不靠工具守。

**因此的口径（对本仓库有效）**：

- 一次提交里**动过的文件**，顺手检查这几类粘连：`};}`、`import …; import …`、"语句 + `if`"同行、散文被 ` * ` 串成一行；
- **新增文件不得**出现同类形态；
- **评审时把这类形态当缺陷提**（它与"同值常量写两遍"同类：都不报错，只让人读错）。

**什么时候该翻这条裁决**：出现"人眼守不住"的规模时（例如多人频繁改动同一批文件），或 CI 里要做机械格式检查时。届时**按准入流程**引入格式化器，并一并接受三件事：固定版本、`format:check` 只判不写、`.prettierignore` **排除"逐字不改写"的层**（`docs/00-baseline/`、`docs/02-adr/`、归档记录与记录制证据），全仓重排单独成一个 `chore:` 提交并在提交信息里说明"该提交只看非格式差异"。

## 提交约定

- 语义化提交信息（`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:`）；
- 推送前确保**工作区干净**：门禁检查的是磁盘上的当前内容，而不是将被推送的提交；远端 `origin` = `https://github.com/xinmu/GanttPilot.git`；
- 门禁不通过时请修复，不要习惯性 `git push --no-verify`（确需绕过时在提交信息中说明原因）。

## 新增依赖的准入流程

细则见 [README.md](README.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [PRD-06 依据](docs/00-baseline/需求基线.md)。

1. **许可**：运行时依赖必须落在 `scripts/check-licenses.mjs` 的白名单内（宽松 OSI 许可），否则先评估并留痕；跑 `pnpm notices:write` 把 `THIRD_PARTY_NOTICES.md` 一起提交。**传递依赖"许可不可判定"时优先用 `pnpm-workspace.yaml` 的 `overrides` 抬到已明确的版本，而不是开白名单豁免**。
2. **必要性与替代方案**：说明为什么不能自己写或用已有依赖（本项目偏好零依赖的纯函数实现）。
3. **健康度与体积**：记录最近发布、issue 规模、包体。**浏览器侧依赖必须动态导入**，不要让大库进首屏主 chunk（如 `exceljs` 的 min 产物不可 tree-shaking）。

**应用层判据入口**（[P-40 依据](docs/00-baseline/裁决R39.md)）：**v0.1 范围内不引入** `jsdom` / `happy-dom` / Playwright，**`apps/web` 不新建判据入口**——应用层由两条既有通道判定：`pnpm smoke:build`（端到端断言）与 `node scripts/measure-render.mjs`（记录制）。代价如实接受：**组件级**仍只能靠端到端断言 + 人工复验。

## 文档约定

> 完整规范见 [docs/DOC-SPEC.md](docs/DOC-SPEC.md)（导航 [docs/README.md](docs/README.md)）；下面是摘要，冲突时以 DOC-SPEC 为准。权威裁决：`P-27`。

- 文档**不做版本号另存**（不用 `-v2`、`-第二轮` 后缀），修订由 git 历史承担；
- **裁决类信息统一进 [裁决记录](docs/00-baseline/裁决记录.md)**（**唯一权威登记处**）：台账只**追加条目行**，逐轮细则进 `docs/00-baseline/裁决R*.md`（一轮一份、只追加、不重写）；已裁决条目内容不改写（推翻则追加并注明「取代 Rn/Tn」）；
- 架构决策写 ADR 放 `docs/02-adr/`（`NNNN-主题.md`）：**契约变更改写正文**，实现记录与逐轮增补进 `docs/02-adr/附录/` 的 `NNNN-增补.md`——**不要再往 ADR 末尾追加 §N**；
- **同类信息只有一处权威陈述**，别处只写指针：未决项只进 [首版-待定清单](docs/01-roadmap/首版-待定清单.md)；能力边界与出口条件只进 [首版能力顺序](docs/01-roadmap/首版能力顺序.md)；落地动作与实测只进记录层；证据进 `apps/web/evidence/`；
- 文档结构由 `pnpm docs:check` 判定（链接、锚点、台账格式、存档覆盖、体量上限、策略不变量），它是 `pnpm gate` 的一步；`pnpm docs:index` 刷新 [首版-文档索引](docs/01-roadmap/首版-文档索引.md)（生成物）。
