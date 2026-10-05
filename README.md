# GanttPilot（工作名）

> 把 Excel 里长大的计划，变成专业排程的甘特图，一键输出可编辑的汇报 PPT——个人和小团队用得起、学得会的开源项目计划工具。

**当前状态：G0（仓库骨架与测试/门禁护栏）已完成，三项证伪实验（G0-S）全部收口；
G1.1（日历与日期算术：工作日序号化）、G1.2（文档 schema、版本迁移与 WBS 层级）、
G1.3（命令层与事务）、G2（最小正向传播内核）、G3（xlsx 导入/导出，仅可见列）、
G4（纯 SVG 甘特渲染，含裁剪）与 **G5（编辑体验：拖拽三语义 + 撤销重做）** 已完成 ——
**「Excel 导入 → 出图 → 拖动 → 撤销」这条主链路在浏览器里已跑通**
（左表右图分屏、虚拟滚动、折叠、行内编辑、xlsx 导入、拖动条体改开始/工期/整体移动、
拖动期下游实时跟随、`Alt+拖动` 建线并即时检环、手势级撤销/重做、冲突标红与诊断清单）。
`packages/engine` 已落地 O(1) 的「工作日序号 ↔ 日期」翻译与 `exceptions` 双集合
（[落地记录](docs/01-roadmap/首版能力顺序.md)）、**冻结的文档模型**
（规范化序列化与深比较往返、结构化诊断校验、`v1→v2→v3` 迁移与未知版本拒绝、WBS 调级，
规范见 [SCHEMA.md](packages/engine/SCHEMA.md)，决策见 [ADR 0002](docs/02-adr/0002-文档模型与序列化契约.md)）、
**命令层与事务**：命令是唯一变更通道、before 镜像使回滚无需手写逆逻辑、
一次手势 = 一条命令或一个事务（一次 Ctrl+Z 回退整次手势）
（规范见 [COMMAND.md](packages/engine/COMMAND.md)，决策见 [ADR 0003](docs/02-adr/0003-命令层与事务契约.md)）、
**排程内核**：全量正向传播（4 类关系 + lag）、锚点四情形与会话锚点、汇总任务引擎侧聚合、
负 lag 截断、结构性检环与受影响闭包
（规范见 [SCHEDULE.md](packages/engine/SCHEDULE.md)，决策见 [ADR 0004](docs/02-adr/0004-排程契约.md) 与
[ADR 0005](docs/02-adr/0005-排程内核落地补齐与结果形状.md)），
**xlsx 协议层**：9 列规范契约与双解析、单元格容差闭集、公式只读缓存值、
确定性成环边丢弃、三层拼接的结构化诊断、规范化导出与部件指纹确定性
（规范见 [PROTOCOL.md](packages/xlsx-protocol/PROTOCOL.md)，决策见
[ADR 0006](docs/02-adr/0006-xlsx-协议契约.md)），
**G4 的渲染几何与裁剪内核 `packages/render-core`**（视图模型、时间轴与 x 坐标、正交路由、
行/边/水平三窗口裁剪、元素预算、受影响子集）、
**G5 的列身份与拖拽手势内核**（列契约的所有权、单元格文本与编辑派生值、
指针 → 状态机 → 会话锚点/命令、成环高亮；[ADR 0008](docs/02-adr/0008-列身份所有权与拖拽交互契约.md)）
与 **`apps/web` 的 Vue 视图层**
（纯 SVG 甘特、左表右图分屏、虚拟滚动、折叠、行内编辑、xlsx 导入接线、拖拽与撤销 UI）
（规范见 [render-core/SPEC.md](packages/render-core/SPEC.md)，决策见
[ADR 0007](docs/02-adr/0007-渲染几何与裁剪契约.md)，落地裁决见
[P-18](docs/00-baseline/裁决记录.md) 与 [P-20](docs/00-baseline/裁决记录.md)，打包产物测量见
[渲染计时证据](apps/web/evidence/render-timing-chrome152.md) 与
[拖动计时证据](apps/web/evidence/drag-timing-chrome152.md)）。
**下一步是 G8**（v0.1 闭合与发布）。
**G6（持久化：自动保存 + 命令回退栈）已完成**（[P-33](docs/00-baseline/裁决记录.md)）；
**G7（导出：SVG → PNG → PPTX 模板 A）已落地**——
契约见 [ADR 0010](docs/02-adr/0010-导出契约.md)，包级规范见 [PPTX.md](packages/pptx-renderer/PPTX.md)，
开工前置与准入实验见 [P-35](docs/00-baseline/裁决R34.md)、落地与出口条件判定见 [P-36](docs/00-baseline/裁决R35.md)：
**几何与屏幕同源（非截屏）**、PPTX 为**原生形状**（`roundRect` 条 / `diamond` 里程碑 / `p:cxnSp` 吸附 connector /
一级 `p:grpSp`）、同一文档两次导出**逐字节一致**（字节级 golden）；
WPS 自动化证据（无修复弹窗、另存后锚点 14/14 存活、拖动后端点重新走线）已通过，
**人工真机拖动复验待做**。
**G5 的人工复核（[P-21](docs/00-baseline/裁决记录.md)）的批次 A 已落地、第 13 条（导入与成环清单）已闭**
（[P-22](docs/00-baseline/裁决记录.md)）；**批次 D 已收口**（[P-23](docs/00-baseline/裁决记录.md) →
[P-24](docs/00-baseline/裁决记录.md) → [P-25](docs/00-baseline/裁决记录.md)，人工复验通过）、
**批次 C 已落地并复验通过**（[P-28](docs/00-baseline/裁决记录.md) 落地、[P-30](docs/00-baseline/裁决R29.md)/
[P-31](docs/00-baseline/裁决R30.md) 按复验报文修正口径与落点；编辑态与撤销提示），
仅**批次 B**（可拖动区域暗示 + 建线入口 + `c₄`）**未执行** —— 界面可用性的星号仍在（见「已知限制」）。

**G4 的开工前置在上一轮已闭**：[ADR 0007](docs/02-adr/0007-渲染几何与裁剪契约.md) 冻结形状与语义，
**数值由 G4-S 准入定标实验回填**（`S4-a`…`S4-d` **全部通过**，
裁决 [P-17](docs/00-baseline/裁决记录.md)）；另一项硬前置 [P-8](docs/00-baseline/裁决记录.md) 遗留 1
（WPS 横向连接点 `idx=1/3` 实测）**已完成**。
**G4-S 的探针目录已在 G4 落地时整体删除**（其四条门禁结论已复现为 `render-core` 的 spec，
浏览器计时口径已移植为 [`scripts/measure-render.mjs`](scripts/measure-render.mjs)）。

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

- **验证环境**：开发与验收**以 WPS 为准**（[裁决 P-4](docs/00-baseline/裁决记录.md)）；
  **Microsoft PowerPoint 未经验证**（备查、不阻塞）——
  因此在未完成该验证前，**不承诺** PowerPoint 下的依赖线拖动跟随行为；
- **Keynote**：不保证依赖线保持吸附语义（Apple 官方兼容矩阵说明连接线会被导入为直线）；
- **WPS**：兼容性结论以真机测试为准，未经证据支持的承诺不下发；
- **xlsx**：导入导出以**自有 schema 规范化**为准，**不保留用户原有的列顺序、样式、公式与宏**；
  **公式只读缓存值**（Excel 里没算过的公式按"值缺失"处理并给出一提示），
  **不支持 `.xls`(BIFF) 旧格式**；**CSV 导入为尽力而为、CSV 导出不在 v0.1 范围内**；
- **xlsx 往返的验证环境**：以 **WPS 表格**为准（「仅保存」与「编辑后保存」两种往返均已实测通过，
  见 [G0-S-S2 结论](spikes/g0-s2-xlsx-roundtrip/结论.md)）；**Microsoft Excel 与 Google Sheets 未经验证**，
  因此**不承诺**其往返行为；
- **PPTX**：图形为原生形状（永不为位图）；若 connector 异常，降级为折线形状。
- **持久化只保证"恢复到不早于最近检查点"**（G6）：浏览器杀进程不触发 `beforeunload`，
  因此活下来的是**最后一次已完成的写入**（自动保存的去抖上限是 5 s，丢失窗口 ≈ 一个写入周期）——
  不是"崩溃前最后一步"；检查点是"那份最新状态被写坏时的可恢复点"，不是额外的实时保障；
- **会话锚点、滚动位置与档位不跨会话恢复**（G6，[ADR 0009 §6](docs/02-adr/0009-持久化契约.md)）：
  锚点是拖动期的临时意图，持久化它会让"所见"与"文档事实"分叉，滚动位置与档位属视图状态；
- **多标签页只做互斥停写 + 提示**（G6）：另一个标签页在编辑同一份文档时，本标签页会停止自动保存并提示，
  **不做合并**（多标签合并属非目标 NG-01）；
- **存储后端是 IndexedDB**（G6）：不可用时降级为"本次会话不自动保存"并提示，编辑与撤销重做不受影响。

## 文档

| 文档 | 说明 |
|---|---|
| [需求基线](docs/00-baseline/需求基线.md) | 由原始 PRD v1.1 提取并重编号的需求条目，逐条标注状态与冲突 |
| [评估报告](docs/00-baseline/评估报告.md) | 独立评估：内部一致性、语义缺口、外部技术假设核验（含两项被证伪的假设） |
| [裁决记录](docs/00-baseline/裁决记录.md) | **裁决的唯一权威登记处**，按时间追加 |
| [证伪实验计划](docs/00-baseline/证伪实验计划.md) | 三项前置 spike 的可执行协议与通过/失败门禁 |
| [首版能力顺序](docs/01-roadmap/首版能力顺序.md) | v0.1 的能力推进顺序与每块出口条件（取代按周数的路线图） |
| [文档 schema 规范](packages/engine/SCHEMA.md) | `@ganttpilot/engine` 的文档模型：字段语义、`null` 口径、未启用字段、迁移与调级约定 |
| [命令层规范](packages/engine/COMMAND.md) | `@ganttpilot/engine` 的命令层：变更唯一通道、before 镜像（日志）形状、失败码、事务与撤销/重做语义 |
| [排程内核规范](packages/engine/SCHEDULE.md) | `@ganttpilot/engine` 的排程内核：`compute()` 的输入/输出与哨兵、锚点四情形、汇总与里程碑、项目起点与截断、诊断码表、检环与闭包、容量配方、验证与门禁 |
| [渲染几何与裁剪规范](packages/render-core/SPEC.md) | `@ganttpilot/render-core` 的权威规范：包边界与公共 API、时间轴与 x 坐标、行模型、路由几何、裁剪四条与元素预算、退化状态、编辑边界、验证矩阵与实测数字 |
| [参照实现（排程）](tools/cpm-reference/README.md) | 排程差分的"另一套实现"：CLI 与 JSON 协议、语义清单、`GANTTPILOT_PYTHON` 与 Windows 9009 注意事项 |
| [xlsx 协议规范](packages/xlsx-protocol/PROTOCOL.md) | `@ganttpilot/xlsx-protocol` 的权威规范：9 列契约、容差闭集、公式口径、双解析、22 条诊断码、成环丢弃顺序、导出物白名单与确定性、六层证据与实测数字 |
| [参照实现（xlsx）](tools/xlsx-reference/README.md) | xlsx 差分的"另一套实现"（openpyxl）：CLI 与产出协议、双向差分口径、公式两通道互证、`openpyxl==3.1.5` |
| [架构决策记录](docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md) | ADR 0001：本地质量门禁、零框架/零 DOM 铁律的执行方式，及其代价 |
| [架构决策记录](docs/02-adr/0002-文档模型与序列化契约.md) | ADR 0002：`null` 口径、`outlineNumber` 为派生值、版本策略、调级语义的取舍与代价 |
| [架构决策记录](docs/02-adr/0003-命令层与事务契约.md) | ADR 0003：命令是纯数据、before 镜像 = 按 id 的差分、日志即唯一变更内核、事务 = 一个撤销单元 |
| [架构决策记录](docs/02-adr/0004-排程契约.md) | ADR 0004（G2 的开工前置，**冻结面**）：锚点规则与会话锚点、汇总/里程碑语义、项目起点与负 lag 截断、`Schedule` 形状与诊断码表、检环 API、范围（全量 + 闭包查询）与验证门禁 |
| [架构决策记录](docs/02-adr/0005-排程内核落地补齐与结果形状.md) | ADR 0005：落地期补齐的口岸（结果形状、文档序索引与 `-1` 哨兵、工期解析、项目起点第②级、有效图 vs 结构图、容量入口、两处有意抛出） |
| [架构决策记录](docs/02-adr/0006-xlsx-协议契约.md) | ADR 0006（G3 的开工前置，**冻结面**）：9 列契约、单元格容差闭集、公式只读缓存值、双解析优先级、协议层诊断码表、成环边丢弃顺序、导出物白名单与确定性判据、依赖与动态导入、验证门禁 |
| [架构决策记录](docs/02-adr/0007-渲染几何与裁剪契约.md) | ADR 0007（G4 的开工前置，**冻结面**）：几何真相源与包边界（`packages/render-core`）、时间轴与 x 坐标（自然日连续 + 右边界规则）、行模型与折叠渲染、路由折点参数、裁剪四条与元素预算、验证矩阵与门禁分层、明确不做；**§11 数值已由 G4-S 回填**（+ 三条口径澄清） |
| [架构决策记录](docs/02-adr/0008-列身份所有权与拖拽交互契约.md) | ADR 0008（G5）：**列身份所有权的反转**（`engine ← render-core ← xlsx-protocol`，依据 P-19 §5 ② 的候选 A）+ **拖拽与撤销的交互契约**（三语义判定区与命令映射、吸附会话锚点与生命周期、`吸附`/`允许` 两模式与冲突判据、建线与检环、成环高亮、诊断清单的受控收口、撤销单元、`c₄` 与门禁/记录制分层） |
| [架构决策记录](docs/02-adr/0009-持久化契约.md) | ADR 0009（G6 的开工前置，**冻结面**）：落盘的是"基线快照 + 其后的增量"（`rev` 与 `undoDepth` 双口径）、`SnapshotStore` 接口与失败码闭集、恢复优先级与三道守卫、多标签互斥停写、以及"杀进程能恢复到哪一刻"的诚实口径 |
| [持久化规范](packages/engine/PERSISTENCE.md) | `@ganttpilot/engine` 的持久化落地说明：数值常量（5 min / 200 步 / 保留 3 份 / 配额降级 1 份）、公共 API、**实现不变量**与验证矩阵 |
| [架构决策记录](docs/02-adr/0010-导出契约.md) | ADR 0010（G7 的开工前置，**冻结面**）：三层落点（几何/ OOXML / DOM）、**全量渲染**与适配公式、SVG 语义化形态、PPTX 形状映射与吸附站点、降级序列（不分组 / `custGeom` / 省连线）、golden 口径（字节级）、失败码闭集、明确不做 |
| [PPTX 渲染规范](packages/pptx-renderer/PPTX.md) | `@ganttpilot/pptx-renderer` 的权威规范：形状映射与形状名、吸附站点、补丁与**归一化管线**、模板 A 布局、降级序列、验证矩阵（门禁 / 记录制 / 人工） |
| [S-G7 准入实验（跨组吸附 / custGeom）](packages/pptx-renderer/evidence/g7-s7-a-b-wps.md) | G7 开工前置的第一批证据：跨组 connector 被 WPS 接受、拖动后端点跟随、`custGeom` 折线可用（S1 未覆盖的三个组合） |
| [S-G7 字节确定性](packages/pptx-renderer/evidence/g7-s7-c-determinism.md) | G7 开工前置的第二批证据：未归一化时 20 个不稳定条目（zip 时间戳 + `docProps` 内容），归一化后**逐字节相等** ⇒ golden 取字节级 |
| [S-G7 单页适配数值](packages/pptx-renderer/evidence/g7-s7-d-fit.md) | G7 开工前置的第三批证据：16:9 单页下的缩放比 / 行高 / 字号（回填 ADR §11 的常数与提示阈值） |
| [模板 A 的 WPS 真机验证](packages/pptx-renderer/evidence/template-a-demo-wps.md) | **产品产物**的记录制证据：两次冷开无修复、另存后锚点 14/14 存活、拖动 `bar-t1` 后 `dep-l1`/`dep-l2` 重新走线 |
| [持久化拖拽证据](apps/web/evidence/persist-drag-timing-chrome154.md) | **开/关自动保存两组同尺**的拖拽帧预算（记录制）：由 `node scripts/measure-render.mjs --persist-drag` 采集——帧间隔 p95、拖动期写入次数（期望 0）、松手 → 落盘 |
| [存储占用证据](apps/web/evidence/persist-storage-2000-chrome154.md) | **2,000 任务**的存储占用与写入耗时（记录制）：由 `node scripts/measure-render.mjs --storage-metrics` 采集——整份文档体积/序列化耗时、增量记录体积、单条 `put` p50/p95、`estimate()` 用量 |
| [`scroll` 敏感量盘点](apps/web/evidence/scroll-consumers-audit.md) | G6 开工前置的**只读**盘点（P-25/P-32）：13 处"消费者自己换算坐标"的位置逐条给出基准，结论"加法点恰好 1 个"，不变量落 [render-core 规范](packages/render-core/SPEC.md) §九 |
| [拖动计时证据](apps/web/evidence/drag-timing-chrome152.md) | **打包产物**的拖动实测（记录制，不进 `pnpm gate`）：由 `node scripts/measure-render.mjs --drag` 采集——帧间隔 p50/p95、主线程同步工作量、松手 → 重算 + 冲突标记、下游跟随的 DOM 证据，以及**位移判据**（松手后 `startDate` = 按下时的开始序号 + 天数） |
| [导入记录制证据](apps/web/evidence/import-cyclic-sample-chrome152.md) | **成环样本**的导入实测（记录制）：由 `node scripts/make-sample.mjs` + `node scripts/measure-render.mjs --import=<xlsx>` 采集——6 任务 / 5 依赖 / 恰 1 条 `XLSX_CYCLE_EDGE_DROPPED`（带成环路径）/ 无"不可排程" |
| G4-S 准入定标实验 | `S4-a`…`S4-d` 判定、ADR §11 回填值、浏览器首屏与滚动实测、P-8 遗留 1/2 的 WPS 实测。**探针目录已随 G4 落地删除**（[裁决 P-18](docs/00-baseline/裁决记录.md)），复现入口见 [render-core 规范](packages/render-core/SPEC.md) 与 [`scripts/measure-render.mjs`](scripts/measure-render.mjs) |
| [渲染计时证据](apps/web/evidence/render-timing-chrome152.md) | **打包产物**的首屏与 10× 滚动实测（记录制，不进 `pnpm gate`）：由 `node scripts/measure-render.mjs` 采集，环境与数字一起登记 |
| [贡献指南](CONTRIBUTING.md) | 环境、开发命令、铁律、依赖准入流程与提交约定 |

## 仓库结构

```
packages/engine          @ganttpilot/engine          日期算术与排程内核（零 DOM / 零框架）
packages/xlsx-protocol   @ganttpilot/xlsx-protocol   xlsx 导入/导出协议（G3 已落地）
packages/render-core     @ganttpilot/render-core     渲染几何与裁剪内核（零 DOM / 零框架，G4 已落地）
packages/pptx-renderer   @ganttpilot/pptx-renderer   PPTX 原生形状与 OOXML 补丁（G7 落地）
apps/web                 @ganttpilot/web             前端应用：渲染与交互（G4 已落地；G5 继续）
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

单人项目、当前无远端仓库，因此"合并门槛"落在**推送前的本地门禁**上（决策见 ADR 0001）：

```bash
pnpm install        # 顺带通过 prepare 钩子设置 core.hooksPath=.husky
pnpm gate           # lint → typecheck → test → build → smoke:build → license:check → docs:check
```

- `pnpm install` 后 `.husky/pre-push` 生效：**门禁任一步失败即阻断推送**；
- 门禁检查的是磁盘上的当前内容，请保持工作区干净；
- 确需绕过时用 `git push --no-verify`，并在提交信息里说明原因；
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 是等价的远端流水线，接入 GitHub 后即可启用
  （启用前它不会运行，因此不作为现有护栏）；
- **门禁含排程内核的差分测试**（G2 落地）：`pnpm test` 内的
  `packages/engine/src/schedule.differential.spec.ts` 会与 [`tools/cpm-reference/`](tools/cpm-reference/README.md)
  的**独立 Python 参照实现**逐字段比对（**1,000 随机 DAG + 200 成环图**，实测约 4.5 秒、0 不一致）。
  该步**需要 Python 3，缺失时失败而不是跳过**——"全绿为合并硬门槛"不被静默跳过破坏
  （[裁决 P-12](docs/00-baseline/裁决记录.md) / [ADR 0004](docs/02-adr/0004-排程契约.md) §9）；
  可用 `GANTTPILOT_PYTHON` 指定解释器，随机种子固定并随失败信息打印。
- **门禁含 xlsx 协议的双向差分**（G3 落地）：`packages/xlsx-protocol/src/xlsx.differential.spec.ts`
  与 [`tools/xlsx-reference/`](tools/xlsx-reference/README.md) 的独立 **openpyxl** 参照实现互读
  （openpyxl 写 → JS 读、JS 写 → openpyxl 读）。该步**需要 Python 3 与 `openpyxl==3.1.5`，
  缺失时失败而不是跳过**（[ADR 0006](docs/02-adr/0006-xlsx-协议契约.md) §12）。
- **门禁含打包产物冒烟**（G6 落地）：`pnpm smoke:build` 用 HTTP 伺服 `apps/web/dist/`、
  以无头 Chrome 打开，并断言**没有应用级错误、界面真的渲染了**（标题 / 工具栏 / 图表窗格 / SVG /
  状态栏的持久化那一栏）。它补的是一个真实缺口：**此前没有任何门禁碰过 `dist/`**，于是
  "产物能不能起来"全靠人记得看一眼（维护者的报文「打开 `dist/index.html` 空白」暴露了它）。
  该步**需要本机 Chrome，缺失时失败而不是跳过**；用 `GANTTPILOT_CHROME=<path>` 指定。

## 预览与人工复验（**打包产物口径**）

人工复验一律取**打包产物**口径（`pnpm dev` 只用于开发，它的数字不进证据）：

```bash
pnpm build      # 产出 apps/web/dist/
pnpm preview    # 起一个本地静态服务器（Vite preview），按它打印的 URL 打开
```

> **不要直接打开 `apps/web/dist/index.html`**：那会走 `file://` 协议，而浏览器
> **拒绝在 `file://` 下加载 ES module**（CORS）⇒ 页面会**空白**。产物没坏，是打开方式不对。
> 这条口径有门禁兜底：`pnpm smoke:build` 就是"用 HTTP 打开产物并断言它真的起来了"。

## 导出（G7）

工具栏「导出」可选三种产物，**几何与屏幕同源**（同一份 `ViewModel`，不是截屏）：

| 产物 | 内容 | 选项 |
|---|---|---|
| **SVG** | 语义化 SVG（`<title>`/`<desc>` + 分组 + `data-task-id`），**不含任何交互图元**（手柄/连接点/热区/覆盖层） | 「含图例与摘要」开关 |
| **PNG** | 同一张 SVG 光栅化（白底），EX-02 的多倍率 | 倍率 1× / 2× / 3×（像素上限 32 MP） |
| **PPTX 模板 A** | 单页总览 = 标题 + 甘特（含左列任务名）+ 图例 + 自动摘要（任务/依赖/里程碑/完成率/里程碑清单） | 固定含图例与摘要（EX-06） |

- **原生形状，永不为位图**：任务条 = `roundRect`、阶段汇总 = `rect`（更矮）、里程碑 = **菱形 preset**、
  依赖 = `p:cxnSp` + `a:stCxn/a:endCxn` **双端吸附**、父子 = **一级 `p:grpSp`**（显式 `chOff/chExt`、等比）；
- **导出是全量渲染**（不分窗口，ADR 0007 §10）：内容按**等比**缩到单页并居中，折叠隐藏的行不导出；
  大文档（如 1,000 行）会缩到不可读——界面在导出前给出**可读性提示**（"建议切档/先折叠"），**不阻断**；
- **可重复生成**：`docProps` 时间字段与 zip 条目日期归一化后，同一文档两次导出**逐字节一致**；
- **PPTX 走动态 `import()`**：`pptxgenjs` 单独成 chunk（272.6 kB / gzip 94.7 kB），**不进首屏**；
  `smoke:build` 会在打包产物上**真的点三次导出**并校验落盘文件（SVG 内容 / PNG magic / PPTX zip magic）；
- **WPS 复现**：`node scripts/export-pptx.mjs --zoom week` 生成产物，`pwsh -File scripts/wps-pptx-verify.ps1`
  做冷开 / 另存 / 拖动取证（记录制、不进 `pnpm gate`；需本机 WPS）。
  **人工复验提示**：模板 A 的任务条在真 `p:grpSp` 里，在 WPS 里要先点进 `grp-s1` 之类的组才能选中任务条。

三条铁律中"三包零框架/零 DOM 依赖"已可执行化：`pnpm lint` 会拦下三包内的框架 import 与 DOM 全局，
`pnpm test` 里的护栏自检会证明这些规则确实生效（见 `packages/engine/src/boundary.spec.ts`）。

## 已知限制（随能力块增长）

- **验证环境以 WPS 为准**：Microsoft PowerPoint / Microsoft Excel / Google Sheets **未经验证、不承诺**
  （[裁决 P-4](docs/00-baseline/裁决记录.md) / [P-5](docs/00-baseline/裁决记录.md)）；
- **xlsx 导出即规范化**：**不保留**用户的列顺序、样式与公式（T-2）；
  项目级字段与日历例外**不在 9 个可见列里**，因此不随导出物往返（`exceptions` 的工作表表达归 v0.5）；
- **跨时区读同一 xlsx** 时，真日期（序列号）对应的本地日历日可能偏移一天——
  这是"真日期 + 序列号"编码的固有属性（Excel 的序列号语义就是"本地墙钟"）；
- **`exceljs@4.4.0` 不可 tree-shaking**：`dist/exceljs.min.js` 实测 **925 KB min**
  （`.bare.min.js` 842 KB），因此浏览器侧**必须动态 `import()`**，不得进首屏主 chunk；
- **`.xls`(BIFF) 不支持**（ExcelJS 不支持）；**CSV 导出不在 v0.1 承诺内**；
- **永不做 `.mpp`，且不承诺 MS Project 互操作**（[裁决 R-4](docs/00-baseline/裁决记录.md)）；
- **性能口径**：排程内核只在 **Node 侧**实测过（[G0-S-S3 结论](spikes/g0-s3-cpm-perf/结论.md)）；
  **渲染侧已由 G4 在打包产物上定标**（[渲染计时证据](apps/web/evidence/render-timing-chrome152.md)，
  **记录制、不进 CI**）：1,000 任务 / 1,500 依赖下首屏（`就绪 → 含依赖线首帧`）**3–15 ms**、
  10× 滚动总墙钟 **约 500 ms**、主线程 p95（**只算同步工作量，不含帧等待**）**0.5–1.0 ms**、
  空白行与 longtask 均为 **0**；
  **拖拽帧率已由 G5 定标**（[拖动计时证据](apps/web/evidence/drag-timing-chrome152.md)，
  同样记录制）：拖动 3 个工作日下连续帧间隔 p50 **16.6 ms** / p95 **16.9 ms**（≥30 fps）、
  主线程同步工作量 p95 **3.80 ms**、**松手 → 重算 + 冲突标记 8.2 ms**（判据 200 ms），
  且**松手后的 `startDate` 必须等于"按下时的开始序号 + 拖动天数"**（P-22 补上的位移判据，
  旧快照只断言"非空"、已被作废）；
  换机器 / 换 Chrome 大版本 / headed / DPR>1 都会改变绝对值，引用时必须连口径一起读；
- **渲染规模声明**：v0.1 的 1,000 任务首屏 ≤1s **已定标**（G4-S 探针页 18.0–31.2 ms、
  G4 打包产物 3–15 ms），§四 的"裁剪未达标 ⇒ 规模下调到 500 任务"降级**未触发**；
  **2,000 任务压测归 v0.5**；
- **G5 的界面边界与语义**：拖拽三语义是**改开始 / 改工期 / 整体移动**（条左端 / 右端 / 中部），
  `Esc` 取消；**拖动必须命中条体**（包围盒 ± 2 px，同一行的空白处按下不产生手势）；
  候选序号是**抓取点相对**的（按一下不动 ⇒ 文档一字不改、也不压撤销栈）；
  **改工期拖动以预览轮廓表示结果**（会话锚点只有"开始序号"，因此拖动期条体本体不动、松手才生效）；
  **拖动期文档不写**——位置经**会话内锚点**进 `compute`，
  因此**锚点不落盘、重开后不保留**（[ADR 0004](docs/02-adr/0004-排程契约.md) §2 的既有口径）；
  `吸附`（默认，夹到入边约束）与`允许`（原样放行、早于约束时标红）两种策略可切换；
  **拖动指针移出图表窗格时不做边缘自动滚动**（v0.1 不做）；
  **诊断清单是"受控收口"**（三层拼接 + 计数 + 可展开列表——协议层为导入时的快照），列映射向导的完整形态仍待后续；
  **导出现已可用**（G7，见上文「导出」一节：SVG / PNG / PPTX 模板 A）；
  **同侧多线避让不做**（实测 70.7% 的边其竖向段穿过条形，是"日后另立 ADR"的量化触发依据）；
  **季刻度、折叠展开动画、无障碍基础、主题跟随**归 v0.5。
- **G7 导出的已知限制**：
  ① **导出是全量渲染 + 等比缩到单页**：行数很多（如 1,000 行）时会被压到不可读，
  界面只给**提示**（建议切档/折叠）而不阻断，**v0.1 不做分页/分节模板（模板 B/C 归 v0.5）**；
  ② **PPTX 只有模板 A**，不含主题跟随与 A4 页面；
  ③ **PPTX 的 connector 走线由渲染引擎按"两端吸附点"重算**，因此它与 SVG 的折点**不保证逐点相同**——
  承诺的是"端点落在同一条边上"（几何同源），不是"折线一模一样"；
  ④ **Microsoft PowerPoint / Keynote 未验证**（[验证环境口径](#验证环境口径裁决-p-4)）：只输出标准 OOXML、
  未用私有扩展，但**不承诺**其下行为；**导出物的拖动跟随结论仅在 WPS 下成立**；
  ⑤ **人工真机拖动复验待做**（见 [P-36](docs/00-baseline/裁决R35.md)）：门禁与 WPS 自动化证据已通过，
  但在维护者亲手复验前，不对外声称"人工复验通过"。
- **G5 的人工复核已知问题（[P-21](docs/00-baseline/裁决记录.md)；批次 A = [P-22](docs/00-baseline/裁决记录.md)、
  批次 D = [P-23](docs/00-baseline/裁决记录.md)/[P-24](docs/00-baseline/裁决记录.md)/[P-25](docs/00-baseline/裁决记录.md)、
  批次 C = [P-28](docs/00-baseline/裁决记录.md)）**：
  14 项人工复核确认了 6 个根因缺陷，执行**批次 A** 时又发现并修掉了**第 7 个（R7：候选序号是"指针绝对"
  而非"抓取点相对"，`resize-duration` 的工期公式也错位）**；**批次 D** 的只读诊断又把"渲染窗口与真实窗格
  不一致"拆成 5 个机制（P-21 的两个候选都被证实），并另抓出 R8–R10，收口于三轮复核。
  **已修（批次 A/C/D）**：指针坐标参照物取错、按下不判命中条体、候选语义与按模式的结果解析、拖动累积加速、
  导入的协议层诊断未进清单（第 13 条）、两栏逐行对齐与滚动后的交互（R11–R14）、
  **编辑态被任何版本变化打断**与**撤销提示不消失**（批次 C；提示口径已按维护者的人工复验报文由
  [P-30](docs/00-baseline/裁决R29.md) 加宽为"失败才产生、成功且真的改了即清**失败**提示、无操作照旧"，
  并由 [P-31](docs/00-baseline/裁决R30.md) 把它的**落点**移进命令通道——拖动提交也绕不过）。
  其中批次 A、C、D **均已由维护者人工复验通过**（2026-10-04；批次 C 的报文回了两轮——"提示不再常驻"为改进、
  "提示出现 → 修改 → 提示不消失"与"拖动后提示也不消失"为未解决，口径与落点已分别按报文修正
  [P-30](docs/00-baseline/裁决R29.md) / [P-31](docs/00-baseline/裁决R30.md)，并按 M7 复验通过）。
  **批次 B 已落地（[P-32](docs/00-baseline/裁决记录.md)；2026-10-04）**：`Alt+拖动` **不再**是建线入口——
  入口改为条两端外侧的**连接点**（`Alt` 降为兼容别名）；条体两端新增**端点手柄**与三种光标暗示
  （端点 `col-resize`、中部 `move`、连接点 `crosshair`）；判定区改为**随条宽收缩**，
  月档 1 个工作日的条（3 px）也能整体移动；元素预算按"每渲染行 6 + 每帧固定 12"重定 `c₄`
  （见 [ADR 0008 §16](docs/02-adr/0008-列身份所有权与拖拽交互契约.md)）。
  判据层面全绿：**49 spec / 674 例**；记录制四件套（拖动 / 对齐 / 主口径 / 导入）已重跑并刷新证据。
  **人工复验（2026-10-04）后已按报文返工**：手柄不再越过条体上沿（高 8 → 4 px）、连接点改为**指针靠近条端时才显示**、
  位置**贴住条端并竖向居中**、且"看得见的方块一定点得中"（`Alt` 入口已按报文**取消**）。
  第二次复验又暴露根因：渲染层把 **`RowBox.y`（行顶）** 当成了**条心**（两者相差 12 px）⇒ 手柄悬空、连接点整体上移、
  "看得到却点不到"（命中判定只按 x、本身是对的）。已改为显式传 **`barCenterY`**（`row.barY + row.barHeight / 2`）
  并加"竖向中心同源"判据（旧实现下必然变红）。第三次复验又发现**可见方块 ≠ 可用命中区**（8 px 方块 + 窄容差
  ⇒ 按住拖不出线）：连接点已改为**跨在条端上**、尺寸 12 px、命中区 = 方块 + 外侧 4 px 容差
  （可用宽度 14 → 20 px），拖动期间不再显示。**提示：`pnpm dev` 前请先 `pnpm build`**
  （`render-core` 的 `dist` 曾停在上一轮构建，导致复验看到的是旧几何）。详见
  第四次复验定位到**事件投递层**：`mousedown` 会启动浏览器文本选择（实测顺序 `mousedown → selectstart → mousemove`），
  随后 `mousemove` 不再按窗格路径派发 ⇒ 只收到一次移动、拖不出线。已加 `preventDefault()`、
  手势期 `mousemove` 挂 `window`、以及 `pointerdown` 的 `setPointerCapture`。详见
  第五次复验的报文（"没有虚线出现"）定位到**真正的根因**：指针只要还在**源任务那一行**，
  候选边就不可解析，而旧实现此时 `return idleGesture()` —— **整条手势被终止**（后续移动全被忽略、松手不提交）。
  已改为"这一帧没有目标"（保留手势），并加判据（旧实现下必然变红）。
  详见 [ADR 0008 §16.7](docs/02-adr/0008-列身份所有权与拖拽交互契约.md)。
  第六次复验后**核心流程通过**，三条遗留已处理：建线期**指针所在行**的连接点一律显示（"可落点"可见）、
  左表"前置任务"**类型一律显示**（`1.3FS` / `1.3SS-2`，可直接照抄回该列）、
  同一条关系**不可重复建立**（预检拒绝并提示，见 [§16.8](docs/02-adr/0008-列身份所有权与拖拽交互契约.md)）。
  **维护者复验通过（2026-10-04）** ⇒ 批次 B 收口，G5 的返工清零。
  **已知限制不变**：拖动指针移出图表窗格时不做边缘自动滚动；拖动期的会话锚点不落盘。

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
