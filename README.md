# GanttPilot（工作名）

> 把 Excel 里长大的计划，变成专业排程的甘特图，一键输出可编辑的汇报 PPT——个人和小团队用得起、学得会的开源项目计划工具。

**当前状态：G0（仓库骨架与测试/门禁护栏）已完成，三项证伪实验（G0-S）全部收口；
G1.1（日历与日期算术：工作日序号化）、G1.2（文档 schema、版本迁移与 WBS 层级）、
G1.3（命令层与事务）与 G2（最小正向传播内核）** 已完成——**引擎的排程内核已可用**。
`packages/engine` 已落地 O(1) 的「工作日序号 ↔ 日期」翻译与 `exceptions` 双集合
（[落地记录](docs/01-roadmap/首版能力顺序.md)）、**冻结的文档模型**
（规范化序列化与深比较往返、结构化诊断校验、`v1→v2→v3` 迁移与未知版本拒绝、WBS 调级，
规范见 [SCHEMA.md](packages/engine/SCHEMA.md)，决策见 [ADR 0002](docs/02-adr/0002-文档模型与序列化契约.md)）、
**命令层与事务**：命令是唯一变更通道、before 镜像使回滚无需手写逆逻辑、
一次手势 = 一条命令或一个事务（一次 Ctrl+Z 回退整次手势）
（规范见 [COMMAND.md](packages/engine/COMMAND.md)，决策见 [ADR 0003](docs/02-adr/0003-命令层与事务契约.md)），
以及**排程内核**：全量正向传播（4 类关系 + lag）、锚点四情形与会话锚点、汇总任务引擎侧聚合、
负 lag 截断、结构性检环与受影响闭包
（规范见 [SCHEDULE.md](packages/engine/SCHEDULE.md)，决策见 [ADR 0004](docs/02-adr/0004-排程契约.md) 与
[ADR 0005](docs/02-adr/0005-排程内核落地补齐与结果形状.md)，证据见
[S3 结论](spikes/g0-s3-cpm-perf/结论.md) 与差分参照实现
[`tools/cpm-reference`](tools/cpm-reference/README.md)）。
**下一步是 G3**（xlsx 导入/导出，仅可见列）：导入后直接接 `compute()` 得到可渲染的 `Schedule`。
**尚无产品能力（v0.1 未发布）**。

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
- **xlsx 往返的验证环境**：以 **WPS 表格**为准（「仅保存」与「编辑后保存」两种往返均已实测通过，
  见 [G0-S-S2 结论](spikes/g0-s2-xlsx-roundtrip/结论.md)）；**Microsoft Excel 与 Google Sheets 未经验证**，
  因此**不承诺**其往返行为；
- **PPTX**：图形为原生形状（永不为位图）；若 connector 异常，降级为折线形状；
- **性能口径**：排程内核的性能只在 **Node 侧**实测过（[G0-S-S3 结论](spikes/g0-s3-cpm-perf/结论.md)：
  Node 24.15.0 下 1,000 任务 / 1,500 依赖的全量重算 p99 = 52.1 µs，2,000/3,000 为 129.8 µs）
  ——**浏览器与绘制侧未测量**，因此**不承诺拖拽帧率**，该指标在 G5 用真实浏览器复测后再对外声明。

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
| [参照实现](tools/cpm-reference/README.md) | 差分的"另一套实现"：CLI 与 JSON 协议、语义清单、`GANTTPILOT_PYTHON` 与 Windows 9009 注意事项 |
| [架构决策记录](docs/02-adr/0001-本地质量门禁与零框架依赖护栏.md) | ADR 0001：本地质量门禁、零框架/零 DOM 铁律的执行方式，及其代价 |
| [架构决策记录](docs/02-adr/0002-文档模型与序列化契约.md) | ADR 0002：`null` 口径、`outlineNumber` 为派生值、版本策略、调级语义的取舍与代价 |
| [架构决策记录](docs/02-adr/0003-命令层与事务契约.md) | ADR 0003：命令是纯数据、before 镜像 = 按 id 的差分、日志即唯一变更内核、事务 = 一个撤销单元 |
| [架构决策记录](docs/02-adr/0004-排程契约.md) | ADR 0004（G2 的开工前置，**冻结面**）：锚点规则与会话锚点、汇总/里程碑语义、项目起点与负 lag 截断、`Schedule` 形状与诊断码表、检环 API、范围（全量 + 闭包查询）与验证门禁 |
| [架构决策记录](docs/02-adr/0005-排程内核落地补齐与结果形状.md) | ADR 0005：落地期补齐的口岸（结果形状、文档序索引与 `-1` 哨兵、工期解析、项目起点第②级、有效图 vs 结构图、容量入口、两处有意抛出） |
| [贡献指南](CONTRIBUTING.md) | 环境、开发命令、铁律、依赖准入流程与提交约定 |

## 仓库结构（G0 骨架）

```
packages/engine          @ganttpilot/engine          日期算术与排程内核（零 DOM / 零框架）
packages/xlsx-protocol   @ganttpilot/xlsx-protocol   xlsx 导入/导出协议（G3 落地）
packages/pptx-renderer   @ganttpilot/pptx-renderer   PPTX 原生形状与 OOXML 补丁（G7 落地）
apps/web                 @ganttpilot/web             前端应用：渲染与交互（G4/G5 落地）
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
pnpm gate           # lint → typecheck → test → build → license:check（实测约 12 秒，含差分）
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

三条铁律中"三包零框架/零 DOM 依赖"已可执行化：`pnpm lint` 会拦下三包内的框架 import 与 DOM 全局，
`pnpm test` 里的护栏自检会证明这些规则确实生效（见 `packages/engine/src/boundary.spec.ts`）。

## 文档约定

- **文档不做版本号另存**（不使用 `-v2`、`-第二轮` 之类的文件名）：内容修订由 **git 历史**承担，裁决类信息进 `裁决记录.md` 并按时间追加；
- 文件名只表达**主题与稳定性**，不表达版本；
- 架构决策写成 ADR 放 `docs/02-adr/`，按 `NNNN-主题.md` 编号；
- `packages/*`（engine / xlsx-protocol / pptx-renderer）各自独立 semver、MIT 协议；`apps/web` 为私有应用包。

## License

MIT
