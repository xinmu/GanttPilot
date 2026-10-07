# GanttPilot（工作名）

> 把 Excel 里长大的计划，变成专业排程的甘特图，一键输出可编辑的汇报 PPT——个人和小团队用得起、学得会的开源项目计划工具。

**当前状态：v0.1 的能力块全部完成，G8（v0.1 闭合与发布）的代码、判据与证据已落地并收口**——
**「Excel 导入 → 出图 → 拖动 → 撤销 → 导出 PPTX」这条主链路在浏览器里已跑通**，且**离线单文件**可双击使用。
**两条出口条件明确未做**（**依据**见 [P-52](docs/00-baseline/裁决R50.md) §2）：「在线 Demo 可用」与
"HTTP 口径的断网可用"——远端已接入，但在线 Demo 尚未托管，按 P-49 §4 的同一条口径**不把托管变成对外承诺**。
**每块的出口条件、实测数字与逐轮落地史**在
[首版能力顺序](docs/01-roadmap/首版能力顺序.md) 与 [落地记录](docs/01-roadmap/首版-记录-G6-G8.md)（**历史存档**）。

**先说怎么用**：[用户手册 ① 导入与 Excel 准备](docs/03-guide/导入与Excel准备.md) ·
[② 依赖列语法与排程规则](docs/03-guide/依赖列语法与排程规则.md) ·
[③ 导出与离线单文件](docs/03-guide/导出与离线单文件.md)（**建议先下载模板**：工具栏「模板下载」）。

**能力块状态一览**（G0 / G0-S / G1.1–G1.3 / G2–G8；出口条件与实测数字见上文两份文档，不在此复述）：

| 块 | 交付 |
|---|---|
| G1.1–G1.3 | 日历与工作日序号化；**冻结的文档模型**（`v1→v2→v3` 迁移与未知版本拒绝、WBS 调级）见 [SCHEMA](packages/engine/SCHEMA.md) / [ADR 0002](docs/02-adr/0002-文档模型与序列化契约.md)；**命令层与事务**（一次手势 = 一条命令或一个事务）见 [COMMAND](packages/engine/COMMAND.md) / [ADR 0003](docs/02-adr/0003-命令层与事务契约.md) |
| G2 | **排程内核**：全量正向传播（4 类关系 + lag）、锚点四情形与会话锚点、汇总任务引擎侧聚合、负 lag 截断、结构性检环与受影响闭包——见 [SCHEDULE](packages/engine/SCHEDULE.md) / [ADR 0004](docs/02-adr/0004-排程契约.md) / [ADR 0005](docs/02-adr/0005-排程内核落地补齐与结果形状.md) |
| G3 | **xlsx 协议层**：9 列规范契约与双解析、单元格容差闭集、公式只读缓存值、确定性成环边丢弃、结构化诊断、部件指纹确定性——见 [PROTOCOL](packages/xlsx-protocol/PROTOCOL.md) / [ADR 0006](docs/02-adr/0006-xlsx-协议契约.md) |
| G4 | **渲染几何与裁剪内核 `packages/render-core`**（视图模型、时间轴与 x 坐标、正交路由、三窗口裁剪、元素预算、受影响子集）+ **`apps/web` 的 Vue 视图层**（纯 SVG 甘特、左表右图分屏、虚拟滚动、折叠、行内编辑）——见 [render-core/SPEC](packages/render-core/SPEC.md) / [ADR 0007](docs/02-adr/0007-渲染几何与裁剪契约.md) |
| G5 | **列身份与拖拽手势内核**（列契约所有权、单元格文本与编辑派生值、指针 → 状态机 → 会话锚点/命令、成环高亮；建线经**连接点**）——见 [ADR 0008](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) |
| G6 | **持久化**（自动保存 + 命令回退栈）——见 [ADR 0009](docs/02-adr/0009-持久化契约.md) / [PERSISTENCE](packages/engine/PERSISTENCE.md) |
| G7 | **导出**（SVG → PNG → PPTX 模板 A；几何与屏幕同源、原生形状、字节级 golden）——见 [ADR 0010](docs/02-adr/0010-导出契约.md) / [PPTX](packages/pptx-renderer/PPTX.md) |
| G8 | **v0.1 闭合与发布**：两级刻度、悬停行高亮、模板下载、向右拖远不白屏、`file://` 双击即用的单文件产物（[P-49 依据](docs/00-baseline/裁决R47.md)）；三项范围裁定见 [P-46 依据](docs/00-baseline/裁决R45.md) |

逐轮返工史与实测数字一律在**记录层**：[G5 记录（历史存档）](docs/01-roadmap/首版-记录-G5.md)、
[G6–G8 记录（历史存档）](docs/01-roadmap/首版-记录-G6-G8.md)、[ADR 附录](docs/02-adr/附录/)、
[裁决存档 R*.md](docs/00-baseline/裁决记录.md)（台账「细则」列指过去）；
G4-S 的探针目录已随 G4 落地删除，其结论已复现为 `render-core` 的 spec，浏览器计时口径移植为
[`scripts/measure-render.mjs`](scripts/measure-render.mjs)。


---

## 这是什么

Excel 太平面、MS Project 太重、汇报出口只能截图——本项目要打通
**「Excel 导入 → 排程引擎 → 原生可编辑 PPTX 导出」** 这条完整链路，作为开源项目（MIT）填补该赛道的空白。

架构上的三条铁律：

1. **计算层是独立包**，零 DOM / 框架依赖，独立测试矩阵；
2. **双投影**：视图模型层同时产出渲染投影与导出投影，三种导出器（SVG / PNG / PPTX）共享几何计算，保证「所见 = 所导出」（不截屏）；
3. **本地优先**：核心功能零后端依赖，纯前端静态部署即可用。

## 明确不做（非目标）

用于关闭超范围请求，本文档为权威清单：

- 协作编辑（OT/CRDT、实时通道、冲突合并）；
- 资源求解与自动资源均衡（资源池、固定工时/单位/工期三态调度）；
- 企业级功能（项目组合、工时单、跨项目依赖、组织资源视图）；
- **`.mpp` 读写，且不承诺与 MS Project 的格式互操作**（依托 Excel 维护自有 schema）；
- 数据规模承诺（单项目 ≤ 2,000 任务 / 3,000 依赖，超出提示但尽力渲染）；
- Excel 公式、条件格式与宏的解释（导入时一律扁平化为值）。

## 已知限制（诚实声明，随版本更新）

> 本节**只此一份**：结论性的"边界与不承诺"写在这里，**机制、逐轮返工史与实测数字在记录层**
> （[G5 记录（历史存档）](docs/01-roadmap/首版-记录-G5.md)、[G6–G8 记录（历史存档）](docs/01-roadmap/首版-记录-G6-G8.md)、
> [ADR 附录](docs/02-adr/附录/)、[首版-文档索引](docs/01-roadmap/首版-文档索引.md) 列出的证据文件）。

- **验证环境**：开发与验收**以 WPS 为准**（[裁决 P-4](docs/00-baseline/裁决记录.md)）；
  **Microsoft PowerPoint 未经验证**（备查、不阻塞）——
  因此在未完成该验证前，**不承诺** PowerPoint 下的依赖线拖动跟随行为；
- **承诺环境 = 桌面浏览器（鼠标 + 键盘）**（[P-40 依据](docs/00-baseline/裁决R39.md)）：端点手柄与连接点的
  **按需显形**依赖**悬停**与 `col-resize` 光标暗示，在触屏/移动端**未验、不在 v0.1 范围**——
  不承诺响应式布局与触屏手势入口（**这不是已知缺陷，是范围外**，归 v0.5）；
- **Keynote**：不保证依赖线保持吸附语义（Apple 官方兼容矩阵说明连接线会被导入为直线）；
- **WPS**：兼容性结论以真机测试为准，未经证据支持的承诺不下发；
- **xlsx**：导入导出以**自有 schema 规范化**为准，**不保留用户原有的列顺序、样式、公式与宏**；
  **公式只读缓存值**（没算过的按"值缺失"处理并给提示）；**往返以 WPS 表格为准**（「仅保存」与「编辑后保存」
  两种均已实测通过，见 [G0-S-S2 结论](spikes/g0-s2-xlsx-roundtrip/结论.md)），**Excel 与 Google Sheets 未验证**；
- **PPTX**：图形为原生形状（永不为位图）；connector 异常时降级为折线形状。
- **持久化只保证"恢复到不早于最近检查点"**（G6）：浏览器杀进程不触发 `beforeunload`，
  因此活下来的是**最后一次已完成的写入**（自动保存的去抖上限是 5 s，丢失窗口 ≈ 一个写入周期）——
  不是"崩溃前最后一步"；检查点是"那份最新状态被写坏时的可恢复点"，不是额外的实时保障；
- **会话锚点、滚动位置与档位不跨会话恢复**（G6，[ADR 0009 §6](docs/02-adr/0009-持久化契约.md)）：
  锚点是拖动期的临时意图，持久化它会让"所见"与"文档事实"分叉，滚动位置与档位属视图状态；
- **多标签页只做互斥停写 + 提示**（G6）：另一个标签页在编辑同一份文档时，本标签页会停止自动保存并提示，
  **不做合并**（多标签合并属非目标 NG-01）；
- **存储后端是 IndexedDB**（G6）：不可用时降级为"本次会话不自动保存"并提示，编辑与撤销重做不受影响；
- **离线单文件产物**（G8／[P-49 依据](docs/00-baseline/裁决R47.md)）：`apps/web/dist-offline/index.html`
  是**一个文件、双击即用**（`file://`），不需要 Node / Python / 任何托管。实测结论——
  **IndexedDB 可用**（自动保存照常）、**下载可用**（SVG/PNG/PPTX/模板都真落盘）、
  **三条主链路全可用**（**断网下同样全可用**——全部资源已在同一个文件里）、首屏约 **126–150 ms**；
  代价是体积约 **1.60 MB**（两个大库必须内联）；
  若你的浏览器策略禁止 `file://` 页面使用存储或下载，界面会**明示降级**（"本次会话不自动保存"/
  提示改用新标签页另存），**不会静默假成功**。证据见
  [单文件探针记录](apps/web/evidence/offline-single-file-chrome154.md)；
- **在线 Demo / HTTP 托管**（G8）：**本轮未做**。**远端已接入**（`origin` → GitHub），
  但**在线 Demo 尚未托管**，`.github/workflows/ci.yml` 自己也声明"尚未经过真实运行验证"；
  按 P-49 §4 的同一条口径（"CI 没跑过之前不变成对外承诺"），**不落地 Pages 部署 workflow**
  （[P-52 依据](docs/00-baseline/裁决R50.md)：tag 与推送是维护者的对外动作）。
  要自己跑：`pnpm build && pnpm preview`；
- **"`file://` 下打不开产物"这条历史说法的订正**（G8 实测）：外链 `<script type="module" src="…">`
  与它内部的相对 `import()` 在 `file://` 下**都能加载**；会炸的是**去掉 `type="module"` 的 classic 脚本**
  与 `data:` URL 的 module。⇒ **单文件分发的真需求是"只有一个文件"**（不需要 HTTP 服务、不需要联网），
  而不是"CORS 逼着内联"。四组对照见 [`bundle-offline.mjs`](scripts/bundle-offline.mjs) 文件头与[单文件探针记录](apps/web/evidence/offline-single-file-chrome154.md)；
- **左表列宽是「导出字符宽度的归一 + 语义下限」**（G8）：`COLUMN_SPECS.width` 是**导出用**的
  字符宽度（不是像素），左表按 `max(下限, 宽度 × 6.5)` 派生像素，并作为**表头与表体唯一的**
  `grid-template-columns`。九列合计 **992 px**，因此**不做响应式收缩**——窗口更窄时左表不压缩、
  剩余宽度全给图表（与 [P-40 依据](docs/00-baseline/裁决R39.md) 的「桌面浏览器 + 鼠标」范围一致）；
- **刻度线只画在表头带内**（G8）：绘制区里只有「周末/假日色带 + 月份分组淡底 + 月边界线」，
  日期刻度是表头带内的 **6 px 短刻度**。这不是缺陷，是**刻度归刻度区**的口径
  （首版把它们画成整高竖线，人工复验当场否掉）；
- **跨栏高亮是双向联动的**（G8；**第二次复验补上了反向那一半**）：指针在**图表**上时左表对应行点亮
  （`.row.hovered`），指针在**左表**上时右图对应行也会出现那条行带（左表的 `pointerenter` 把同一个
  `hoverTaskId` 推给父级）；两侧同色（声明处：[`HOVER_ROW_FILL`](packages/render-core/src/manifest.ts)）
  但**各自独立触发**，不做「选中」语义（选中/多选归 v0.5）。
  行带按**内容宽**铺满整行 ⇒ **横向滚动时不会在首屏边界处断开**。
- **xlsx 的原生限制**：**导出即规范化**——项目级字段与日历例外**不在 9 个可见列里**，因此不随导出物往返
  （`exceptions` 的工作表表达归 v0.5）；**跨时区**读同一文件时，真日期（序列号）对应的本地日历日可能偏移一天
  （Excel 的序列号语义就是"本地墙钟"）；**`.xls`(BIFF) 不支持**；**CSV 导入尽力而为、导出不在 v0.1 范围**；
  **`exceljs@4.4.0` 不可 tree-shaking** ⇒ 浏览器侧**必须动态 `import()`**，不进首屏主 chunk；
- **永不做 `.mpp`，且不承诺 MS Project 互操作**（[裁决 R-4](docs/00-baseline/裁决记录.md)）；
- **性能与规模口径**：排程内核只在 **Node 侧**实测过（[G0-S-S3 口径](spikes/g0-s3-cpm-perf/结论.md)）；
  **渲染侧 / 拖拽帧率**由 G4 / G5 在打包产物上定标（[渲染计时证据](apps/web/evidence/render-timing-chrome152.md)、
  [拖动计时证据](apps/web/evidence/drag-timing-chrome152.md)，**均为记录制、不进 CI**）：
  **换机器 / 换 Chrome 大版本 / headed / DPR>1 都会改变绝对值，引用时必须连口径、环境与数据集一起读**。
  1,000 任务首屏 ≤1s **已定标**，"裁剪未达标 ⇒ 规模下调到 500 任务"**未触发**；**2,000 任务压测归 v0.5**；
- **P-43／P-44 的三条界面口径**（人工复核后的裁定，**机制与逐轮数字见** [P-43 依据](docs/00-baseline/裁决R42.md)
  与 [P-44 依据](docs/00-baseline/裁决R43.md)）：**汇总条**没有判定区、手柄与连接点（光标 `default`）——
  汇总端点上的依赖在传播中"等同不存在"（SCHEDULE.md §四.6），因此**不能从阶段拉线**（**导入的**历史边仍按文档层容忍：
  保留 + `LINK_SUMMARY_ENDPOINT` warning + 灰线）；**里程碑工期恒为 0**——菱形只可整体移动，左表「工期」列在标记为真时
  **拒绝**（唯一出口是先在「里程碑」列解除标记），且**解除标记后工期仍为 0 的行图形上仍是菱形**（"0 工期即里程碑"是引擎口径）；
  **状态栏永远单行**（超长省略，高度与文案长度无关）、**图表窗格常驻两轴滚动条**（小文档也会看到灰条）
  ——这两个布局自激环都已在构造上断开；
- **G5 的界面边界与语义**：拖拽三语义是**改开始 / 改工期 / 整体移动**（条左端 / 右端 / 中部），`Esc` 取消；
  建线入口是条两端外侧的**连接点**（`Alt` 入口已取消），端点手柄与连接点**按需显形**、光标 `col-resize`/`move`/`crosshair`；
  **拖动必须命中条体**（同一行的空白处按下不产生手势），候选序号是**抓取点相对**的（按一下不动 ⇒ 文档一字不改、也不压撤销栈）；
  **改工期拖动以结果几何表示**（[P-24 依据](docs/00-baseline/裁决R24-26.md)：条体本体即所见即所提交；
  [P-45 依据](docs/00-baseline/裁决R44.md)：**下游也与拖动同步**——工期那一半经应用层的**未提交文档副本**进 `compute`，
  左表的「工期 / 完成日」仍是**文档值**、松手后更新）；**拖动期文档不写**：位置经**会话内锚点**、工期经**未提交副本**，
  两者都不落盘 ⇒ **重开后都不保留**（[ADR 0004](docs/02-adr/0004-排程契约.md) §2 的既有口径）；
  `吸附`（默认）与`允许`（原样放行、早于入边约束时标红）两种策略可切换；**拖动指针移出图表窗格时不做边缘自动滚动**；
  **拖动期只有图表跟随**（左表显示文档事实）；**诊断清单是"受控收口"**（三层拼接 + 计数 + 可展开列表——协议层为导入时的快照），
  列映射向导的完整形态仍待后续；**同侧多线避让不做**（实测 70.7% 的边其竖向段穿过条形，是"日后另立 ADR"的量化触发依据）；
  **季刻度、折叠展开动画、无障碍基础、主题跟随**归 v0.5。**逐轮返工史与实测数字**在**历史存档**：
  [G5 记录](docs/01-roadmap/首版-记录-G5.md)（批次 A–D、六轮复验）、[P-32 细则](docs/00-baseline/裁决R31.md)、
  [ADR 0008 附录细则 §4](docs/02-adr/附录/0008-增补.md) 与 [ADR 0008 §16](docs/02-adr/0008-列身份所有权与拖拽交互契约.md)。
- **G7 导出的已知限制**：
  ① **全量渲染 + 等比缩到单页**：行数很多时会被压到不可读，界面只给**提示**（建议切档/折叠）而不阻断，
  **v0.1 不做分页/分节模板（模板 B/C 归 v0.5）**；
  ② **PPTX 只有模板 A**，不含主题跟随与 A4 页面；
  ③ **PPTX 的 connector 走线由渲染引擎按"两端吸附点"重算**，因此它与 SVG 的折点**不保证逐点相同**——
  承诺的是"端点落在同一条边上"（几何同源），不是"折线一模一样"；
  ④ **导出物的拖动跟随结论仅在 WPS 下成立**（PowerPoint / Keynote 未验证，见上文「验证环境口径」）；
  ⑤ **人工真机复验已通过**（三轮，**细则**见 [P-37](docs/00-baseline/裁决R36.md) /
  [P-38 依据](docs/00-baseline/裁决R37.md) / [P-39 依据](docs/00-baseline/裁决R38.md)）。

## 文档

**不要在这里逐份找文档**——清单与体量快照是生成物。

- **入口**：[docs/README.md](docs/README.md)（L0：想回答什么问题、读哪一份）；
- **规范**：[docs/DOC-SPEC.md](docs/DOC-SPEC.md)（分层、体量上限、证据纪律）；
- **完整清单与体量**：[首版-文档索引](docs/01-roadmap/首版-文档索引.md)（`pnpm docs:index` 生成物，83 份）；
- **台账**：[裁决记录](docs/00-baseline/裁决记录.md)（**裁决的唯一权威登记处**，按时间追加）。

**阅读顺序**：[首版能力顺序](docs/01-roadmap/首版能力顺序.md)（在办与未办、DoD）
→ [首版-待定清单](docs/01-roadmap/首版-待定清单.md)（全仓唯一未决项）
→ [裁决记录](docs/00-baseline/裁决记录.md) → 按主题读下面的规范／手册。

| 想知道什么 | 读哪里（角色） |
|---|---|
| 上游原文怎么写的、当时怎么评估的 | [需求基线](docs/00-baseline/需求基线.md)、[评估报告](docs/00-baseline/评估报告.md)、[证伪实验计划](docs/00-baseline/证伪实验计划.md)（**原文口径**／`baseline`）；逐字入库件见 [上游原文](docs/00-baseline/上游原文-产品需求文档与路线图.md) |
| 必须怎么做、边界在哪 | 各包规范：[SCHEMA](packages/engine/SCHEMA.md)、[COMMAND](packages/engine/COMMAND.md)、[SCHEDULE](packages/engine/SCHEDULE.md)、[PERSISTENCE](packages/engine/PERSISTENCE.md)、[SPEC](packages/render-core/SPEC.md)、[PROTOCOL](packages/xlsx-protocol/PROTOCOL.md)、[PPTX](packages/pptx-renderer/PPTX.md)；契约的决策与代价见 [ADR 0001–0010](docs/02-adr/) |
| 怎么用 | [用户手册 ① 导入与 Excel 准备](docs/03-guide/导入与Excel准备.md)、[② 依赖列语法与排程规则](docs/03-guide/依赖列语法与排程规则.md)、[③ 导出与离线单文件](docs/03-guide/导出与离线单文件.md) |
| 差分的"另一套实现" | [cpm-reference](tools/cpm-reference/README.md)、[xlsx-reference](tools/xlsx-reference/README.md) |
| 某块当时怎么判的、逐轮返工史与实测数字 | **历史存档**：[首版-记录-归档 G0–G3](docs/01-roadmap/首版-记录-归档-G0-G3.md)／[G4–G5](docs/01-roadmap/首版-记录-归档-G4-G5.md)、[首版-记录-G5](docs/01-roadmap/首版-记录-G5.md)、[首版-记录-G6-G8](docs/01-roadmap/首版-记录-G6-G8.md)；**细则**：[ADR 附录](docs/02-adr/附录/)（0001／0004／0005／0006／0007／0008／0010-增补） |
| 浏览器与 WPS 的测量快照 | [apps/web/evidence/](apps/web/evidence/)、[packages/pptx-renderer/evidence/](packages/pptx-renderer/evidence/)（记录制：证据不可再生，随版本分文件；**原文口径**） |

## 仓库结构

```
packages/engine          @ganttpilot/engine          日期算术与排程内核（零 DOM / 零框架）
packages/xlsx-protocol   @ganttpilot/xlsx-protocol   xlsx 导入/导出协议（G3；G8 加模板生成）
packages/render-core     @ganttpilot/render-core     渲染几何与裁剪内核（零 DOM / 零框架，G4）
packages/pptx-renderer   @ganttpilot/pptx-renderer   PPTX 原生形状与 OOXML 补丁（G7）
apps/web                 @ganttpilot/web             前端应用：渲染与交互（G4/G5/G6/G7/G8）
apps/web/dist            在线产物（多文件，配 HTTP 伺服；`pnpm build`）
apps/web/dist-offline    离线单文件产物（一个文件、双击即用；`node scripts/bundle-offline.mjs`）
apps/web/evidence        记录制证据（浏览器实测快照；**不可再生**，随版本分文件）
docs/03-guide            用户手册（导入 / 依赖语法 / 导出与离线）
tools/cpm-reference      排程内核的独立 Python 参照实现（差分的"另一套实现"）
tools/xlsx-reference     xlsx 协议的独立 Python 参照实现（openpyxl，双向差分）
```

## 验证环境口径（裁决 P-4）

- **开发与验收一律使用 WPS**：人工操作验证与 COM 自动化验证都算数；
- **门禁以 WPS 为准**——G1-a（拖动后 connector 端点跟随）等判据的"真机"即指 WPS；
- **Microsoft PowerPoint 备查、不阻塞**。输出为标准 OOXML 原生形状、未用 WPS 私有扩展，
  但**未在 PowerPoint 下验证**，故不对外承诺其行为；需要时按
  [备查清单](spikes/g0-s1-pptx-connector/evidence/powerpoint/README.md) 跑一次即可提升为门禁。

## 本地质量门禁

单人项目、**远端已接入但 CI 尚未验证**，因此"合并门槛"落在**推送前的本地门禁**上（决策见 ADR 0001）：

```bash
pnpm install        # 顺带通过 prepare 钩子设置 core.hooksPath=.husky
pnpm gate           # lint → build → typecheck → test → smoke:build → bundle:offline → smoke:build:file → license:check → docs:check
```

> **顺序不是风格问题**：`build` **必须先于 `typecheck`**——类型检查经各包的
> `exports.types → dist/*.d.ts` 解析工作区依赖，而 `dist/` **不入库**；若 typecheck 先跑，
> **干净克隆上的门禁必然失败**（机制、实测与代价见 [0001 附录细则 §1](docs/02-adr/附录/0001-增补.md)，
> 裁决 [P-53 依据](docs/00-baseline/裁决R51.md)）。**以 [`scripts/gate.mjs`](scripts/gate.mjs) 的 `STEPS` 为准。**

- `pnpm install` 后 `.husky/pre-push` 生效：**门禁任一步失败即阻断推送**；门禁检查的是磁盘上的当前内容，
  请保持工作区干净；确需绕过时用 `git push --no-verify`，并在提交信息里说明原因；
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 是**等价的远端流水线**，但它自己声明"尚未经过真实运行验证"
  ⇒ **启用前不作为现有护栏**（[P-52 依据](docs/00-baseline/裁决R50.md)）；
- **两条差分测试需要 Python 3**（缺失时**失败而不是跳过**——"全绿为合并硬门槛"不被静默跳过破坏，
  [裁决 P-12](docs/00-baseline/裁决记录.md)）：排程内核逐字段比对差分参照实现
  `tools/cpm-reference/`（1,000 随机 DAG + 200 成环图；[ADR 0004](docs/02-adr/0004-排程契约.md) §9）；
  xlsx 协议与 `tools/xlsx-reference/` 的 `openpyxl==3.1.5` 双向互读
  （[ADR 0006](docs/02-adr/0006-xlsx-协议契约.md) §12）。用 `GANTTPILOT_PYTHON` 指定解释器，
  随机种子固定并随失败信息打印；
- **三条浏览器侧判据需要本机 Chrome**（缺失即失败，用 `GANTTPILOT_CHROME=<path>` 指定）：
  `pnpm smoke:build` 用 HTTP 伺服 `apps/web/dist/`，断言"无应用级错误 + 界面真的渲染了"，并**同时承载四组 G8 应用层判据**——
  **两级刻度**（上级随档位、两栏表头同高、左表第二行留白）、**悬停行高亮**（`.hover-row` 跟随指针 + 左表 `:hover` 底色）、
  **模板下载 → 回导**（落盘文件真的解出三个页签，再由应用自己的导入入口读回、`error 0`）、
  **向右拖远不白屏**（拖 120 个工作日格，全程无应用级错误、结构完整）；
  `pnpm bundle:offline` 断言产物形状（**恰好一个文件**、零外链 `script`/样式表、零 `assets/` 引用）；
  `pnpm smoke:build:file` 以 `file://` 打开单文件产物，跑
  **导入/拖动/导出三条主链路各走一次**（含真实落盘），并**如实登记** `file://` 下的 IndexedDB 可用性
  （不可用时要求 UI 明示，**不得静默假成功**）。

## 预览与人工复验（**打包产物口径**）

人工复验一律取**打包产物**口径（`pnpm dev` 只用于开发，它的数字不进证据；
**在 `dev` 下发现的缺陷必须在打包产物上复现才计入报文**——[P-40 依据](docs/00-baseline/裁决R39.md)）：

```bash
pnpm build      # 产出 apps/web/dist/（在线产物：需要 HTTP 伺服）
pnpm preview    # 起一个本地静态服务器（Vite preview），按它打印的 URL 打开
```

> **不要直接打开 `apps/web/dist/index.html`**：那份产物按**多文件**打包（外链 module + 独立 chunk 与样式），
> 走 `file://` 打开会缺东西 ⇒ 页面不完整。**要"双击即用"，请用离线单文件产物**（见下一节）。
> 这条口径有门禁兜底：`pnpm smoke:build` 就是"用 HTTP 打开 `dist/` 并断言它真的起来了"。

## 离线单文件（G8／[P-49 依据](docs/00-baseline/裁决R47.md)）

```bash
node scripts/bundle-offline.mjs         # 产出 apps/web/dist-offline/index.html（**目录里只有它一个文件**）
node scripts/smoke-build.mjs --file     # 以 file:// 打开它，跑三条主链路（也进 pnpm gate）
node scripts/offline-artifact-probe.mjs # 探针：IndexedDB / 下载 / 体积与首屏 / 断网（记录制，不进 gate）
```

**双击就能用**：不需要 Node、Python、也不需要任何托管；**不需要网络**。
代价是体积（两个大库必须内联进同一个文件），而**在线产物的首屏预算口径不变**（主 chunk 仍不含这两个库）。
形状判据（**恰好一个文件、零外链、零 `assets/` 引用**）与 `file://` 三链路冒烟都在 `pnpm gate` 内；
**体积、首屏与断网结论的实测数字见上文「已知限制 · 离线单文件产物」**与
[单文件探针记录](apps/web/evidence/offline-single-file-chrome154.md)。

## 导出（G7）

工具栏「导出」可选三种产物，**几何与屏幕同源**（同一份 `ViewModel`，不是截屏）：

| 产物 | 内容 | 选项 |
|---|---|---|
| **SVG** | 语义化 SVG（`<title>`/`<desc>` + 分组 + `data-task-id`），**不含任何交互图元**（手柄/连接点/热区/覆盖层） | 「含图例与摘要」开关 |
| **PNG** | 同一张 SVG 光栅化（白底），EX-02 的多倍率 | 倍率 1× / 2× / 3×（像素上限 32 MP） |
| **PPTX 模板 A** | 单页总览 = 标题 + 甘特（含左列任务名）+ 图例 + 自动摘要（任务/依赖/里程碑/完成率/里程碑清单） | 固定含图例与摘要（EX-06） |

- **原生形状，永不为位图**：任务条 = `roundRect`、阶段汇总 = `rect`（更矮）、里程碑 = **菱形 preset**、
  依赖 = `p:cxnSp` + `a:stCxn/a:endCxn` **双端吸附** + **`a:tailEnd` 箭头**（FS/FF 实心、SS/SF 空心）、
  父子 = **一级 `p:grpSp`**（显式 `chOff/chExt`、等比）；**模板 A 是一张完整的甘特图**（日期刻度、
  周末/节假日灰度带、背景网格线、左列任务名（汇总加粗、子行按 WBS 缩进）、图例（含色块与箭头图元）、自动摘要），
  **图例与摘要的文案与 SVG/PNG 同源**（`exportLegendItems()` / `exportSummaryLines()`）——逐项对照见 [PPTX.md](packages/pptx-renderer/PPTX.md) 与 [用户手册 ③](docs/03-guide/导出与离线单文件.md)；
- **导出是全量渲染**（不分窗口，ADR 0007 §10）；折叠隐藏的行不导出，大文档会被压到不可读（**见下方「已知限制」的 G7 ①**）；
- **可重复生成**：`docProps` 时间字段与 zip 条目日期归一化 ⇒ 两次导出**逐字节一致**；
- **PPTX 走动态 `import()`**：`pptxgenjs` 单独成 chunk，**不进首屏**；`smoke:build` 会**真的点三次导出**并校验落盘文件；
- **WPS 复现**（记录制、不进 `pnpm gate`；需本机 WPS；证据见 [template-a-demo-wps](packages/pptx-renderer/evidence/template-a-demo-wps.md)）：
  `node scripts/export-pptx.mjs --zoom week` 生成产物，`pwsh -File scripts/wps-pptx-verify.ps1` 做冷开 / 另存 / 拖动取证。
  **人工复验提示**：模板 A 的任务条在真 `p:grpSp` 里，在 WPS 里要先点进 `grp-s1` 之类组才能选中。

三条铁律中"三包零框架/零 DOM 依赖"已可执行化：`pnpm lint` 拦下三包内的框架 import 与 DOM 全局，
`pnpm test` 里的护栏自检证明规则生效（见 `packages/engine/src/boundary.spec.ts`）。

## 文档约定

- **文档不做版本号另存**（不使用 `-v2`、`-第二轮` 之类的文件名）：内容修订由 **git 历史**承担；
- **文档分五层、同类信息只有一处权威陈述**：导航入口 [docs/README.md](docs/README.md)、
  分层规范 [docs/DOC-SPEC.md](docs/DOC-SPEC.md)（权威裁决 `P-27`）。**会话交接/上下文注入建议只读三份**：
  [docs/README.md](docs/README.md)、[裁决记录台账](docs/00-baseline/裁决记录.md)、
  [首版-文档索引](docs/01-roadmap/首版-文档索引.md)（`pnpm docs:index` 生成）；
- **裁决登记**只在 [裁决记录](docs/00-baseline/裁决记录.md)（唯一权威登记处，只追加条目行），
  逐轮细则在按轮次存档 `docs/00-baseline/裁决R*.md`（**一轮一份、只追加、不重写**；该例外由 P-27 授权）；
- 文件名只表达**主题与稳定性**，不表达版本；
- 架构决策写成 ADR 放 `docs/02-adr/`，按 `NNNN-主题.md` 编号；实现记录与逐轮增补进 `docs/02-adr/附录/`；
- **文档结构进 `pnpm gate`**（`pnpm docs:check`：链接 / 锚点 / 台账格式 / 存档覆盖 / 体量上限 / 策略不变量）；
- `packages/*`（engine / xlsx-protocol / render-core / pptx-renderer）各自独立 semver、MIT 协议；`apps/web` 为私有应用包。

## License

MIT
