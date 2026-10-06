# 离线单文件产物：探针记录（Chrome 154）

> 由 `node scripts/offline-artifact-probe.mjs` 采集；**探针不是门禁**（P-9/P-17 的分层口径）。
> 门禁侧的两条判据是 `scripts/bundle-offline.mjs`（形状）与 `pnpm smoke:build --file`（三链路）。
> 口径与四个问题见 [P-49 §3](../../../docs/00-baseline/裁决R47.md)。

- 产物：`apps/web/dist-offline/index.html`，**1589.3 KB**（1627486 字节）
- 首屏（导航 → `__GANTTPILOT_READY__`）：**150 ms**（FCP n/a ms、DOMContentLoaded 114 ms）
- 打开方式：`file:///D:/workspace/GanttPilot/apps/web/dist-offline/index.html?measure=1`

## ① `file://` 下的 IndexedDB

| 开库 | 写 | 读回 | 判读 |
|---|---|---|---|
| ✅ | ✅ | ✅ | **可用**（自动保存与检查点照常） |

## ② `file://` 下的下载（有网）

落盘文件：`gantt-day.svg` / `GanttPilot-导入模板.xlsx`

| 链路 | 结果 |
|---|---|
| 导入（模板下载 → 回导） | ok: 任务 15 / 依赖 14 |
| 拖动 | ok: t2 开始 2026-10-05 → 2026-12-14 |
| 导出 SVG | ok: gantt-day.svg |

## ③ 体积与首屏

**1589.3 KB / 首屏 150 ms** —— 只登记、不设门禁（P-49 §3 问题③：超标不阻塞发布，但必须如实登记）。
代价如实接受：体积从在线产物的约 190 KB（gzip 67 KB）涨到约 1.4 MB，因为 `exceljs` 与 `pptxgenjs` 必须内联。

## ④ 断网（`Network.emulateNetworkConditions` offline）下的三链路

- 断网后**重新导航**：✅ 页面完整（读数 6351 ms）
- 导入 / 拖动 / 导出：`ok: 任务 15 / 依赖 14` / `ok: t2 开始 2026-10-05 → 2026-12-14` / `ok: gantt-day.svg`

**三条主链路在断网下全部可用** —— 这一条的强度在于"**全部资源已在同一个文件里**"：
页面不需要任何请求，因此"有没有网"不是它能否工作的条件。

> **读数的口径**：这里的 `ms` 包含探针自己的就绪轮询粒度（每 100 ms 一次 RPC 探测），
因此它是**上界**而不是精确首屏；精确值看上面问题③的第 ① 行（同一口径下 125–141 ms）。

> **原始读数**：[`offline-single-file-raw.json`](offline-single-file-raw.json)（机器可读，便于日后重比）。
