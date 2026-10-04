# 文档导航（从这里开始）

> 分层与检查规则见 [DOC-SPEC](DOC-SPEC.md)；体量上限与索引规则见 [doc-index.json](doc-index.json)；
> 门禁检查见 `pnpm docs:check`（`scripts/check-docs.mjs`）。权威裁决：`P-27`。
> **本文件是文档集合的入口**（含 `docs/` 之外的规范与证据）；完整清单与体量快照见
> [首版-文档索引](01-roadmap/首版-文档索引.md)（生成物）。
> **「不做版本号另存」与会话交接的口径在本文与 [CONTRIBUTING](../CONTRIBUTING.md)「文档约定」**。

## 想回答什么问题，就读哪一份

| 你想知道 | 读这份 | 角色 |
|---|---|---|
| **定过什么、现在还算不算** | [裁决记录](00-baseline/裁决记录.md)（台账，一张条目表） | `register` |
| 当时为什么这么定、实测数字与教训 | `裁决R*.md`（按轮次存档，台账的「细则」列指到这里） | `register` |
| **必须怎么做、边界在哪** | [ADR](02-adr/) 与各包规范（[SCHEMA](../packages/engine/SCHEMA.md) / [COMMAND](../packages/engine/COMMAND.md) / [SCHEDULE](../packages/engine/SCHEDULE.md) / [SPEC](../packages/render-core/SPEC.md) / [PROTOCOL](../packages/xlsx-protocol/PROTOCOL.md)） | `contract` |
| **先做什么、怎样才算做完** | [首版能力顺序](01-roadmap/首版能力顺序.md)（在办与未办的块 + 延后规则 + 明确不做 + DoD） | `plan` |
| **还没定的事** | [首版待定清单](01-roadmap/首版-待定清单.md)（全仓唯一） | `plan` |
| 某个已收口能力块当时怎么判的、实测多少 | [首版-记录-归档 G0–G3](01-roadmap/首版-记录-归档-G0-G3.md) / [G4–G5](01-roadmap/首版-记录-归档-G4-G5.md) | `record` |
| 某块的落地动作与逐轮返工史 | [首版-记录-G5](01-roadmap/首版-记录-G5.md)、[首版-记录-G6-G8](01-roadmap/首版-记录-G6-G8.md) | `record` |
| ADR 的逐轮增补与落地段 | [ADR 增补](02-adr/附录/) | `record` |
| 上游原文怎么写的、当时怎么评估的 | [需求基线](00-baseline/需求基线.md) / [评估报告](00-baseline/评估报告.md) / [证伪实验计划](00-baseline/证伪实验计划.md) | `baseline` |
| 浏览器侧的测量快照 | [apps/web/evidence](../apps/web/evidence/)（记录制，不进 `pnpm gate`） | `record` |

## 三层铁律（写新内容前先读这三条）

1. **同类信息只有一处权威陈述**，其他地方只写指针；
2. **未决项只进待定清单**，台账里用 `未决` 状态指过去；
3. **发现文件触及体量上限时，动作是拆分或迁移，不是提高上限**（提高上限要在台账追加一条裁决）。

## 目录一览

```
docs/
  DOC-SPEC.md                     分层规范（不收录契约内容）
  doc-index.json                  索引 + 体量上限 + 链接白名单（唯一真相源）
  00-baseline/                    台账 + 按轮次存档 + 三份基线文档
  01-roadmap/                     路线图（判定） + 待定清单 + 记录层 + 文档索引
  02-adr/                         ADR 正文（契约） + 附录/（增补与落地记录）
```
