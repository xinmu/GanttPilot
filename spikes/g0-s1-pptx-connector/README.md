# spike：G0-S-S1 · PPTX connector 吸附 + group 坐标

> **这是 spike 代码，不属于产品主干。** 见 [结论.md](结论.md)。
>
> 铁律（[证伪实验计划](../../docs/00-baseline/证伪实验计划.md)）：**spike 代码不进主干**。
> 本目录只交付「可行性与正确形态」；补丁算法在能力块 **G7** 由
> `@ganttpilot/pptx-renderer` 重新实现，届时**本目录应整体删除**。

## 这个 spike 回答什么

任务条被拖动时，依赖线是否仍吸附在形状上并自动改道？父子分组的坐标换算是否正确？
——即"自研 OOXML 补丁引擎"这条路是否走得通。

## 为什么它不污染主干

- **不在 `pnpm-workspace.yaml` 内**（根 workspace 只含 `packages/*` 与 `apps/*`），
  因此 `pnpm -r build` / `pnpm -r typecheck` 不会编译它；
- 自带 `pnpm-lock.yaml`，用 `pnpm install --ignore-workspace` 隔离安装；
- 因此 `scripts/check-licenses.mjs`（`--prod` 口径，只审计根 workspace 的运行时依赖）
  既不覆盖也不拦截这两个依赖，`THIRD_PARTY_NOTICES.md` 无需变更；
- `out/` 与 `node_modules/` 已在 `.gitignore` 中忽略（工件可再生，证据不可再生）。

## 目录

```
src/manifest.ts             形状名/坐标/连接点/幻灯片尺寸的**唯一声明处**
src/xml.ts                  slide XML 解析、name→id 映射、id 规则断言
src/fixture.ts              用 pptxgenjs 造容器，JSZip 解包/重打包
src/patch.ts                最小补丁器：注入 <p:cxnSp> 与 <p:grpSp>
src/flatten-group.ts        group 坐标换算的独立复算路径
src/verify-structure.ts     L1 结构自检（27 条断言）
src/verify-pixels.py        L3 侧证：连通域 + 端点贴合距离量化
src/run-all.mts             一键：生成 fixture → 补丁 → L1 → 写报告
src/wps-common.ps1          WPS COM 共用工具（生命周期/导出/解包）
src/wps-native-reference.ps1 用 WPS 原生 AddConnector 造"权威形态"基准
src/wps-capture.ps1         L2 往返 + L3 渲染取证
src/wps-drag.ps1             L4 自动化拖动实验
out/                        生成的 pptx（gitignore）
evidence/                   证据链（入库；所有生成的文本证据统一以 LF 写入）
```

> 没有 `fixtures/` 目录：本 spike 的 fixture 是**由代码生成**的（几何定义在 `src/manifest.ts`，
> 容器由 `src/fixture.ts` 产出到 `out/`），因此不落盘为二进制工件。

## 运行

```bash
cd spikes/g0-s1-pptx-connector
pnpm install --ignore-workspace

node src/run-all.mts                     # L1：生成 fixture + 27 条结构断言
pwsh -File src/wps-native-reference.ps1  # 权威形态基准（让 WPS 自己写出正确的 cxnSp）
pwsh -File src/wps-capture.ps1           # L2 往返 + L3 渲染（A-absorption）
pwsh -File src/wps-capture.ps1 -Fixture C-flat   # 拍平对照
pwsh -File src/wps-drag.ps1              # L4 自动化拖动
pwsh -File src/gen-pixel-evidence.ps1    # L3 侧证（需 Python + Pillow；可用 SPIKE_PYTHON 指定解释器）
```

> 全部脚本会**全量重跑**生成证据；重新生成后工作区应保持干净（证据统一以 LF 写入，
> 见 `src/wps-common.ps1` 的 `Write-LfText`）。若出现差异，说明生成不稳定，应先排查再提交。

## 证据分级（读结论前务必先看这张表）

| 级别 | 含义 | 本机可得 |
|---|---|---|
| L1 结构 | XML 合法、id 唯一、`idx` 在范围内、group 坐标可逆且双路径一致 | ✅ |
| L2 往返 | 经第三方编辑器打开并保存后吸附结构存活 | ✅ WPS |
| L3 视觉 | 端点确实落在形状边上、走线正确、无裁剪 | ✅ WPS 渲染 + 模型视觉判读 |
| L4 拖动 | 拖动后端点跟随、走线自动改道 | ✅ WPS 引擎（COM 自动化） |
| L5 人工真机 | 人工在 **WPS** 中拖动观察端点跟随 | ✅ 人工确认（见 [`evidence/wps/人工验证记录.md`](evidence/wps/人工验证记录.md)） |

## 验证环境口径（裁决 P-4）

**开发过程全部使用 WPS；门禁以 WPS 验证为准（含人工与 COM 自动化）；Microsoft PowerPoint 作为备查、不阻塞。**
因此 L5 的"真机"是 **WPS**，G1-a 已闭合。代价：产品不对外承诺 PowerPoint 下的跟随行为。

见 [裁决记录 P-4](../../docs/00-baseline/裁决记录.md)。若将来要把 PowerPoint 提升为门禁，
照 [`evidence/powerpoint/README.md`](evidence/powerpoint/README.md) 执行一次即可，
产物可用 `node src/run-all.mts` 复现；详见 [结论.md §七](结论.md)。

## 两个最容易踩的坑（都已实证）

1. **`a:stCxn@idx` 不是 PowerPoint COM 的枚举值。** 它是 preset geometry 的连接点序列；
   对 `roundRect` 为 `0=上 1=左 2=下 3=右`，而 COM 是 `1=上 … 4=右`——**相差 1**。
   写错通常不报错，只是端点吸附到错误的边。
2. **锚点在 `p:nvCxnSpPr > p:cNvCxnSpPr` 下的 `a:stCxn`/`a:endCxn`**，
   正确前缀是 `a:`（原实验计划文档写作 `p:cNvCxnSpPr`，是笔误）。
   原生产物**不写** `<a:cxnSpLocks/>`。

## 环境依赖提醒

- 本 spike 依赖本机安装的 **WPS Presentation**（COM 名 `KWPP.Application`）。
  **不要用 `PowerPoint.Application`**——本机该 ProgID 被 WPS 劫持，且 WPS 会自报
  "Microsoft PowerPoint / 12.0"，容易误判为已用 PowerPoint 验证。
- `verify-pixels.py` 需要 Python 与 Pillow。
