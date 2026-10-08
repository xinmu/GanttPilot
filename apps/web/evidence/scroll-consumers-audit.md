# 「`scroll` 敏感量」盘点（G6 开工前置，只读）

> 归属：裁决 `P-25` 遗留 7（台账「未决」）与 `P-32`（批次 B 新增消费者）；
> 路线图 G6 的「开工前置与执行顺序」④明写本项**要在 G6 之前**做完。
> 口径：**只读盘点**（读代码 + 读既有判据），不改任何实现；结论落
> [`packages/render-core/SPEC.md`](../../../packages/render-core/SPEC.md) §九 的一条常驻不变量行。
>
> **一句话口径**（ADR 0008 §15 的收紧版）：**只有 `pointerFromClient` 叠加 `scroll*`；
> 它的下游消费者至多做"平移/窗口换算/负号"，不得再叠加 `scrollTop`/`scrollLeft`。**
>
> **P4-b（2026-10-08）路径同步**：本表的「位置」列按**代码现状**更新了引用（`gesture.ts` 已由 P3/C5-b
> 拆成 `gesture/` 目录、`useChart.ts`/`pointerFromClientPoint` 已由 P3/C6-f 迁进 `composables/`、
> `buildAxis` 住 `clip.ts`），并标出两个**已删除**的旧名；**「换算 / 基准 / 判定」三列一字未改**
> （同步的授权与逐条清单见 v0.2 重构计划的 P4-b 批次记录；本文件**不做**其它改写）。

## 一、为什么必须盘点

`R10`/`R12`/`R13`/`R14` 是**同一族**的四次缺陷（P-25 §7 明确提示），共同签名是：

1. 缺陷**只在 `scroll ≠ 0` 时现形**（`scrollTop = 0` 或 `scrollLeft = 0` 处恒为 0）；
2. 由此**此前所有判据**（纯函数 spec 与记录制）一律取 `scroll = 0` ⇒ **结构上不可能抓到**；
3. 成因都是"**坐标基准已变，消费者却按旧基准又换算了一次**"。

因此盘点的目的不是"再看一遍代码"，而是**给出清单 + 每条的基准**，让后来者新增消费者时能对照。

## 二、清单（逐条给出基准与判定）

| # | 位置 | 它做的换算 | 基准 | 判定 |
|---|---|---|---|---|
| ① | `render-core/src/gesture/pointer.ts` 的 `pointerFromClient` | `x = clientX − paneLeft + scrollLeft`；`y = clientY − paneTop + scrollTop` | **屏幕 → 内容**的**唯一加法点**（ADR 0008 §13.1） | ✅ 合法（唯一） |
| ② | `gesture/pointer.ts` 的 `resolvePointerTarget` | `floor(y / rowHeight)` | `y` 已是**内容坐标** | ✅ 合法（R13 已修；**不得**加 `view.scrollTop`） |
| ③ | `viewModel.ts` 的 `dayAtX` | `axisOriginDay + x / pxPerDay` | `x` 已是**内容坐标** | ✅ 合法（R14 已修；**不得**加 `view.scrollLeft`） |
| ④ | `gesture/pointer.ts` 的**序号反算**（旧名 `ordinalAtXSafe` 已删除，序号反算只有 `dayAtX` 一处） | **无自己的公式**，委托 `dayAtX` | — | ✅ 合法（重复公式已删） |
| ⑤ | `clip.ts` 的 `rowWindow` | `firstVisible = floor(scrollTop / rowHeight)` | `scrollTop` 是**窗口输入**（`Viewport` 的真值） | ✅ 合法（消费者**应当**用它算窗口） |
| ⑥ | `clip.ts` 的轴窗口 | `dayFrom/dayTo` 由 `scrollLeft` 求交；`toX(day) = (day − axisOriginDay)·pxPerDay − scrollLeft` | 轴的 `x` 是**窗口坐标**（ADR 0007 §11.1 ③） | ✅ 合法（**唯一的减号点**） |
| ⑦ | `clip.ts` 的 `buildAxis` | 只发射视口内元素 | 与 ⑥ 同源（已扣 `scrollLeft`） | ✅ 合法 |
| ⑧ | `align.ts` 的**滚动同步判定**（旧名 `keepsScroll` 已并入对齐诊断：`viewScrollTop/Left` 与 `scrollTop/Left` 直接比对） | 直接比两个数 | 两处都必须**等于 DOM 真值** | ✅ 合法（R11/`scroll-out-of-sync` 的判据） |
| ⑨ | `apps/web/src/composables/useChart.ts` 的 `measure()`/`handleScroll()` | 从 DOM 读 `pane.scrollTop/scrollLeft` | **唯一真相源**（`ViewModel.scroll*` 就是它） | ✅ 合法（来源侧） |
| ⑩ | `apps/web/src/composables/useChartPointer.ts` 的 `pointerFromClientPoint`（旧位置 `App.vue`） | 把 `rect.left/top` 与 `view.scroll*` 喂给 ① | ①的**唯一调用点** | ✅ 合法（入口层算出来的输入进纯函数，P-19/P-21 的教训） |
| ⑪ | `GanttChart.vue` 的 `scrollTransform` / `axisBandsTransform` | `translate(−scrollLeft, HEADER_HEIGHT_PX − scrollTop)`；轴带 `translate(0, HEADER_HEIGHT_PX)` | **负号 = 抵消**（与 ①同源、方向相反） | ✅ 合法（ADR 0007 §15.3） |
| ⑫ | `TaskTable.vue` 的行块 | `translateY(−scrollTop)` | 同 ⑪（左表窗口） | ✅ 合法 |
| ⑬ | `render-core/src/interaction.ts` 的 `handleOffsetsFor` / `connectRevealFor` / `linkEntryFor`（批次 B，P-32） | 手柄/连接点的 `x` 由 `zones.ts` 的判定区边界**一次算好** | **内容坐标**（ADR 0008 §16） | ✅ 合法（**不得**再叠加 `scroll*`） |
| ⑭ | `zones.ts` 的 `translateZone`/`translateZones` | 拖动期只对**已算好的**判定区做平移 `+dx` | 内容坐标上的**纯平移** | ✅ 合法（P-32 点名的"一次算好、拖动期只平移"） |

**盘点的收获**：13 处消费里**加法点恰好 1 个**（①），**减法点恰好 1 个**（⑥，轴窗口），
其余全是"读取真值 / 纯平移 / 与真值比对"。批次 B 新增的 ⑬⑭ 落在**内容坐标**一侧，
与 ①的入口口径一致，不构成新的重置点。

## 三、判据覆盖与盲区

| 基准 | 既有判据（进 `pnpm gate`） | 是否覆盖 `scroll ≠ 0` |
|---|---|---|
| 内容坐标（②③④⑬⑭） | `geometryExpectations.spec.ts`（+3 例：`scrollTop=480/scrollLeft=600` 的反算往返与端点贴合逐值一致）、`gesture.spec.ts`（+1 例：滚动视图下命得中同一行、起得了手势）、`interaction.spec.ts`（光标四分类**取非 0 滚动位置**） | ✅ 是 |
| 窗口/轴（⑤⑥⑦⑩⑪⑫） | `align.spec.ts`（20 例，含 R11 滚动范围、`scroll-out-of-sync`、R12 横向不覆盖） | ✅ 是（`align.spec.ts` 基线取 `scrollLeft = 240`） |
| 记录制 | `scripts/measure-render.mjs --align`（6 个 (top,left) 位置，含 0 与 `maxScroll` 两方向）、`--drag`（`(0,0)` 与 `(480,600)` 两个状态） | ✅ 是 |

**仍然存在的盲区**（如实登记 → [首版-待定清单](../../../docs/01-roadmap/首版-待定清单.md) §四，**不在 G6 内收口**）：

- `--align` 只跑**日档 + 固定视口**（周/月档与 resize 后的对齐仍是记录制盲区，P-25）；
- rAF 节流下的"设 `scrollTop` 后等两帧"是**记录制纪律**，换浏览器/节流策略需重新确认（P-23）。

## 四、判定

盘点的**动作面为零**（不新增公式、不改实现）：13 处消费的基准全部自洽，**未发现第 5 个同族缺陷**。
因此本项以"**清单 + 每条的基准 + 一条常驻不变量**"收口——
不变量见 [`packages/render-core/SPEC.md`](../../../packages/render-core/SPEC.md) §九 的
「**坐标基准不变量**」行（新增消费者必须对照它自证）。
