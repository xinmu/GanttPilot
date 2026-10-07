# spike：G0-S-S2 · xlsx 可见列往返存活率

> **这是 spike 留档，不属于产品主干、也不进任何注入包。** 见 [结论.md](结论.md)。
>
> 铁律（[证伪实验计划](../../docs/00-baseline/证伪实验计划.md)）：**spike 代码不进主干**。
> 本目录只交付「可行性与协议约束」；解析/导出的产品实现（含单测）在能力块 **G3** 由
> `@ganttpilot/xlsx-protocol` 重新实现。
>
> **处置（P2/D9）**：G3 已收口，原声明"**本目录可整体删除**"按 DOC-SPEC §4.5 执行了**一半**——
> **探针代码已删除**（`src/` 与 `package.json` / `tsconfig.json` / `pnpm-lock.yaml`）；
> **本文、`结论.md` 与 `evidence/` 留档**（后者是**不可再生的外部工具观测**：WPS 表格两次保存前后的
> OOXML 部件与往返报告，登记为归档层）。因此下文所有"如何运行本 spike"的步骤**已不可执行**，
> 保留原文只为留痕；协议口径的现行住所是 [ADR 0006](../../docs/02-adr/0006-xlsx-协议契约.md)
> 与 `packages/xlsx-protocol`。

## 这个 spike 回答什么

范围已由 [裁决 T-2](../../docs/00-baseline/裁决记录.md) 大幅缩小（影子表 `__gantt_meta__` 随 XL-04 删除），
因此只剩两个问题：

1. **ExcelJS 能否稳定读写本项目产出的规范工作簿？**
2. **第三方编辑器（Excel/WPS）打开并「仅保存」或「编辑后保存」后，可见列语义是否仍可解析？**

答案与代价见 [结论.md](结论.md)。一句话：**两者都能**，代价与硬性约束记录在结论的
「G3 交接清单」中（其中最要紧的一条：**日期必须用 `Date.UTC` 构造**）。

## 为什么它不污染主干

- **不在 `pnpm-workspace.yaml` 内**（根 workspace 只含 `packages/*` 与 `apps/*`），
  因此 `pnpm -r build` / `pnpm -r typecheck` 不会编译它；
- 自带 `pnpm-lock.yaml`，用 `pnpm install --ignore-workspace` 隔离安装；
- 因此 `scripts/check-licenses.mjs`（`--prod` 口径，只审计根 workspace 的运行时依赖）
  既不覆盖也不拦截这里的依赖，`THIRD_PARTY_NOTICES.md` 无需变更；
- `out/` 与 `node_modules/` 已在 `.gitignore` 中忽略（工件可再生，证据不可再生）。

## 目录

```
src/manifest.ts        规范列序/表头、fixture 数据、**声明式期望值表**、两处编码开关 —— 唯一声明处
src/canonical.ts       规范工作簿写出器（ExcelJS）；含时区陷阱的两条构造路径
src/raw-read.ts        zip 层原始读取（独立于 ExcelJS 的第二读取路径 + 部件清单 + sha256）
src/view.ts            两条读取路径的公共视图与语义指纹
src/parse-visible.ts   最小「可见列解析器」（G3 导入侧原型；日期/进度/里程碑的多表示容差）
src/verify-l1.ts       L1 判定集 + 负向对照（字节级变造）+ 时区陷阱取证
src/run-all.mts        一键：生成 fixture → L1 → 写 evidence/structure-report.md
src/timing.mts         规模与体积观测（**非门禁**）→ evidence/timing.md
src/diff-variant.mts   第三方产物取证 CLI：部件级 + 语义级双报告
src/exceljs-interop.ts exceljs 类型定义缺陷的一处适配（见结论「工程坑」）
src/xlsx-common.ps1    WPS 表格 COM 共用工具（生命周期 / 仅保存 / 统一 LF 写入）
src/wps-save.ps1       L2：打开 → **仅保存** → 判定
src/wps-edit-save.ps1  L2b：打开 → 编辑 3 处 → 保存 → 判定（声明式差异）
out/                   gitignore：生成的 xlsx 与 WPS 工作副本
evidence/              证据链（入库；生成的文本统一以 LF 写入）
```

> 没有 `fixtures/` 目录：fixture 由代码生成（数据在 `src/manifest.ts`，产物落 `out/`），
> 因此不落盘为二进制工件——与 S1 同一口径。

## 运行

```bash
cd spikes/g0-s2-xlsx-roundtrip
pnpm install --ignore-workspace

node src/run-all.mts            # L1：自往返 + 双路径 + 编码落地 + 5 条负向对照
node src/timing.mts             # 规模/体积观测（非门禁）
pwsh -File src/wps-save.ps1     # L2：WPS 打开 → 仅保存 → 判定（需本机安装 WPS 表格）
pwsh -File src/wps-edit-save.ps1# L2b：WPS 打开 → 编辑 3 处 → 保存 → 判定
pnpm typecheck                  # tsc --noEmit（tsc 来自仓库根的 node_modules，见结论 §九）
```

> 全部脚本会**全量重跑**生成证据。除 `evidence/timing.md`（**测量快照**，数值随运行时与机器负载波动，
> 重跑必然不同）外，其余证据文件重跑后应保持逐字节一致；若出现差异，说明生成不稳定，应先排查再提交。

## 证据分级

| 级别 | 含义 | 本机可得 |
|---|---|---|
| L1 结构/自往返 | ExcelJS 写→读零漂移；zip 层与对象层双路径逐格一致；编码按声明落盘；负向对照证明判据有判别力 | ✅ Node 24.15.0 与 26.7.0 |
| L2 第三方**仅保存** | WPS 打开 → 仅保存后，可见列语义逐字段相等 | ✅ WPS 12.1.0.28505 |
| L2b 第三方**编辑后保存** | WPS 编辑 3 处后，改动按新值被正确读取，其余零漂移 | ✅ WPS 12.1.0.28505 |
| 备查 | Microsoft Excel（**本机未安装**）、Google Sheets（**本轮明确不做**，见结论 §遗留） | — |

## 两个必须记住的环境事实（都已实测）

1. **WPS 会伪装成 Microsoft Excel。** `New-Object -ComObject Excel.Application` 也解析到
   WPS 表格 12.1.0.28505，且自报 `Name="Microsoft Excel"`、`Version="12.0"`。
   **该字符串不构成「已用 Microsoft Excel 验证」的证据**——本 spike 一律用 `KET.Application`
   （与 S1 的 `KWPP.Application` 是同一类陷阱）。
2. **PowerShell ↔ WPS COM 的 `Cells.Value2` 不能混用 String 与 Double。**
   同一次会话里混用会抛 `Unable to cast object of type 'System.Double' to type 'System.String'`。
   统一走**字符串 put** 即稳定，且 WPS 会自行解析（`'0.75'` → 0.75；`'2026-10-12'` → 序列号 46307）。
   见 `src/wps-edit-save.ps1` 的注释与 [结论.md](结论.md) §六。
