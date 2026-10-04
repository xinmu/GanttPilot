# xlsx 导入记录制（成环样本，不进 `pnpm gate`）

> 由 `node scripts/make-sample.mjs` + `node scripts/measure-render.mjs --import=<path>` 采集
> （[裁决 P-21](../../../docs/00-baseline/裁决记录.md) §5 遗留 3、[P-22](../../../docs/00-baseline/裁决记录.md)）。
> 成环边**丢弃**的语义本身由 `packages/xlsx-protocol/src/xlsxDependencies.spec.ts` 在门禁里覆盖；
> 这一份证据守的是**应用层那一遍**：导入 → 诊断清单 → 任务/依赖计数。

## 环境（与数字一起登记）

| 项 | 值 |
|---|---|
| 采集时刻 | 2026-10-04T13:50:59.599Z |
| 机器 | FAIRY |
| 系统 | win32 x64 |
| Node | v26.7.0 |
| Chrome | Chrome/152.0.7977.83 |
| Chrome 模式 | --headless=new |
| DPR | 1 |
| 视口 | 1280×800 |
| 样本 | cyclic-dependency.xlsx（三列 / 6 行 / t5→t6 成环） |

## 样本

| 项 | 值 |
|---|---|
| 路径 | `D:\workspace\GanttPilot\tmp\samples\cyclic-dependency.xlsx` |
| 体积 | 6669 字节 |
| sha256 | `9802d2f38fc27dfb160c581234e53d4a005b6546b981b2e1182a32c6fe801320` |
| 形状 | 表 `任务`，表头 `WBS / 任务名称 / 前置任务`（**仅三列**），6 行 |
| 环 | 第 6 行的 `前置任务=5` 闭合 `t5→t6`，被 `wouldCreateCycle` 判为成环 ⇒ 丢弃 |

## 结果

| 量 | 值 | 判据 | 判定 |
|---|---|---|---|
| 任务数 | 6 | = 6 | ✅ |
| 依赖数 | 5 | = 5（第 6 条被丢弃） | ✅ |
| `XLSX_CYCLE_EDGE_DROPPED` 条数 | 1 | = 1（带成环路径） | ✅ |
| 不可排程占位 | 无 | 无（丢弃后应为无环） | ✅ |
| 渲染行 / 边 | 6 / 5 | 记录 | — |

> 页脚原文：` 任务 6 · 依赖 5 · 可见行 6 · 渲染行 6 · 渲染边 5 · 元素 75/117（c₃ = 36、c₄ = 48、 覆盖层 0）  档位 day（px/day 24）· 行高 24 px · render-core 0.0.0 诊断 2 条（已展开）  锚点 0 · 冲突 0 首个汇总进度 -100%已导入 cyclic-dependency.xlsx：6 个任务、5 条依赖；问题 1 条`

## 诊断清单（应用层读回的全部条目）

| # | severity | code | message | 定位 |
|---|---|---|---|---|
| 1 | warning | `XLSX_CYCLE_EDGE_DROPPED` | 该前置会造成循环依赖，已丢弃：5 → 6（成环路径 t5 → t6 → t1 → t2 → t3 → t4 → t5） | t6 |
| 2 | warning | `undated` | 任务没有任何日期且没有前置：回落项目起点（DM-05） | t6 |
