# template-a-demo · WPS 真机验证

> 由 `pwsh -NoProfile -File scripts/wps-pptx-verify.ps1` 生成（记录制脚本，**不进** `pnpm gate`）。
> **本报告只覆盖 WPS 引擎**；按裁决 P-4，验证环境以 WPS 为准、Microsoft PowerPoint 备查不阻塞。

## 环境

| 项 | 值 |
|---|---|
| COM 自报 Name | `Microsoft PowerPoint` |
| COM 自报 Version | `12.0` |
| COM 自报 Build | `12.1.0.28505` |
| COM 自报 Path | `C:\Users\Pro.WANG\AppData\Local\Kingsoft\WPS Office\12.1.0.28505\office6` |
| 被验文件 | `tmp/exports/template-a-demo-week.pptx` |

**`Name`/`Version` 是伪装字符串**（本机 WPS 自称 "Microsoft PowerPoint" 12.0），
**不得**当作"用 Microsoft PowerPoint 验证过"的证据；识别它靠的是 `Path` 指向 WPS 安装目录
`Kingsoft\WPS Office\...`。

## 逐项判定

| # | 判据 | 结果 |
|---|---|---|
| 1 | 打开无修复弹窗（COM 打开未抛错） | 通过（无异常） |
| 2 | 幻灯片可读 | 通过（slides=1） |
| 3 | `Slide.Export` 出 PNG（拖动前） | 通过（139715 bytes） |
| 4 | `SaveAs` 另存 pptx（拖动前） | 通过（21074 bytes） |
| 5 | 另存后 `a:stCxn`/`a:endCxn` 条数存活 | 通过（补丁 14 条：st=14 end=14 ⇒ WPS 后 st=14 end=14） |
| 6 | 逐条 connector 端点（归一到形状名后）存活 | 通过（14 条全部一致） |
| 7 | `cxnSp` 条数（另存前/后） | 补丁 14 条 ⇒ WPS 14 条（一致） |
| 8 | 拖动任务条（COM 移动 `Left`/`Top`） | 通过（`bar-t1`：L=199.7 T=117.7 → L=319.7 T=177.7） |
| 9 | `Slide.Export` 出 PNG（拖动后） | 通过（139546 bytes） |
| 10 | `SaveAs` 另存 pptx（拖动后） | 通过（21310 bytes） |
| 11 | **端点跟随**（相关 connector 的 `xfrm` 重算） | 通过（xfrm 随移动重算） |
| 12 | `cxnSpLocks` | 补丁 0 处 ⇒ WPS 0 处 |

### 拖动增量与跟随幅度

- COM 位移 ΔLeft=120 ⇒ XML Δoff.x=144288（比值 1202.4；12700 ⇒ COM 用 pt，1 ⇒ COM 用 EMU）
- `dep-l1`：Δoff.x=144288 Δoff.y=216887
- `dep-l2`：Δoff.x=650247 Δoff.y=434057

## 拖动前后 connector ``xfrm`` 对比

| connector | 时点 | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy | 变化 |
|---|---|---|---|---|---|---|---|---|
| `dep-l1` | 拖动前 | 42/3 | 44/1 | 2897362 | 1559843 | 144472 | 216707 | — |
| `dep-l1` | 拖动后 | 42/3 | 44/1 | 3041650 | 1776730 | 1379855 | 545465 | **已重算** |
| `dep-l2` | 拖动前 | 42/1 | 46/1 | 2536183 | 1559843 | 650122 | 433415 | — |
| `dep-l2` | 拖动后 | 42/1 | 46/1 | 3186430 | 1993900 | 873760 | 328295 | **已重算** |

### 一条必须记下的结构事实：任务条在**组内**

补丁把每个一级汇总行做成真的 `p:grpSp`（`grp-s*`），任务条与进度条是它的**子形状**。
因此 WPS 的**顶层** `Slides.Item(1).Shapes` 里没有 `bar-*`——S1 的按名定位（`Get-WpsShapeByName`）
只扫顶层，在这里必然落空。本脚本用 `Get-WpsShapeByNameDeep` 递归进 `GroupItems` 才拿到 `bar-t1`，
而跨组吸附的另一面也正在这里：`a:stCxn id=31` 指的是**组内子形状**，WPS 另存后仍然认得它。

### 全部 connector（补丁刚写出的 slide1.xml）

| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|---|---|
| `dep-l1` | 42/3 | 44/1 | 2897362 | 1559843 | 144472 | 216707 |
| `dep-l2` | 42/1 | 46/1 | 2536183 | 1559843 | 650122 | 433415 |
| `dep-l3` | 44/3 | 46/1 | 3186305 | 1776550 | 72236 | 216708 |
| `dep-l4` | 46/3 | 48/1 | 3601661 | 1993258 | 18059 | 216707 |
| `dep-l5` | 46/3 | 51/1 | 3619720 | 1993258 | 72236 | 650122 |
| `dep-l6` | 51/1 | 53/1 | 3691956 | 2643380 | 144472 | 216708 |
| `dep-l7` | 51/1 | 55/1 | 3691956 | 2643380 | 144472 | 433415 |
| `dep-l8` | 53/3 | 57/3 | 4703258 | 2860088 | 433415 | 433415 |
| `dep-l9` | 55/3 | 57/1 | 4703258 | 3076795 | 12700 | 216708 |
| `dep-l10` | 57/3 | 59/1 | 5118614 | 3293503 | 18059 | 216707 |
| `dep-l11` | 57/3 | 62/1 | 5136673 | 3293503 | 144472 | 650122 |
| `dep-l12` | 62/3 | 64/1 | 5714560 | 3943625 | 12700 | 216708 |
| `dep-l13` | 64/3 | 66/1 | 5859031 | 4160333 | 12700 | 216707 |
| `dep-l14` | 62/1 | 66/3 | 5281145 | 3943625 | 650122 | 433415 |

### 全部 connector（WPS 另存后 · 拖动前）

| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|---|---|
| `dep-l1` | 42/3 | 44/1 | 2897362 | 1559843 | 144472 | 216707 |
| `dep-l2` | 42/1 | 46/1 | 2536183 | 1559843 | 650122 | 433415 |
| `dep-l3` | 44/3 | 46/1 | 3186305 | 1776550 | 72236 | 216708 |
| `dep-l4` | 46/3 | 48/1 | 3601661 | 1993258 | 18059 | 216707 |
| `dep-l5` | 46/3 | 51/1 | 3619720 | 1993258 | 72236 | 650122 |
| `dep-l6` | 51/1 | 53/1 | 3691956 | 2643380 | 144472 | 216708 |
| `dep-l7` | 51/1 | 55/1 | 3691956 | 2643380 | 144472 | 433415 |
| `dep-l8` | 53/3 | 57/3 | 4703258 | 2860088 | 433415 | 433415 |
| `dep-l9` | 55/3 | 57/1 | 4703258 | 3076795 | 12700 | 216708 |
| `dep-l10` | 57/3 | 59/1 | 5118614 | 3293503 | 18059 | 216707 |
| `dep-l11` | 57/3 | 62/1 | 5136673 | 3293503 | 144472 | 650122 |
| `dep-l12` | 62/3 | 64/1 | 5714560 | 3943625 | 12700 | 216708 |
| `dep-l13` | 64/3 | 66/1 | 5859031 | 4160333 | 12700 | 216707 |
| `dep-l14` | 62/1 | 66/3 | 5281145 | 3943625 | 650122 | 433415 |

### 全部 connector（WPS 另存后 · 拖动后）

| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|---|---|
| `dep-l1` | 42/3 | 44/1 | 3041650 | 1776730 | 1379855 | 545465 |
| `dep-l2` | 42/1 | 46/1 | 3186430 | 1993900 | 873760 | 328295 |
| `dep-l3` | 44/3 | 46/1 | 3186430 | 1776730 | 71755 | 217170 |
| `dep-l4` | 46/3 | 48/1 | 3601720 | 1993900 | 18415 | 216535 |
| `dep-l5` | 46/3 | 51/1 | 3620135 | 1993900 | 71755 | 649605 |
| `dep-l6` | 51/1 | 53/1 | 3691956 | 2643380 | 144472 | 216708 |
| `dep-l7` | 51/1 | 55/1 | 3691956 | 2643380 | 144472 | 433415 |
| `dep-l8` | 53/3 | 57/3 | 4703258 | 2860088 | 433415 | 433415 |
| `dep-l9` | 55/3 | 57/1 | 4703258 | 3076795 | 12700 | 216708 |
| `dep-l10` | 57/3 | 59/1 | 5118614 | 3293503 | 18059 | 216707 |
| `dep-l11` | 57/3 | 62/1 | 5136673 | 3293503 | 144472 | 650122 |
| `dep-l12` | 62/3 | 64/1 | 5714560 | 3943625 | 12700 | 216708 |
| `dep-l13` | 64/3 | 66/1 | 5859031 | 4160333 | 12700 | 216707 |
| `dep-l14` | 62/1 | 66/3 | 5281145 | 3943625 | 650122 | 433415 |

## 形状集合

补丁刚写出：

```
#1, title#2, axis-10#3, axis-12#4, axis-14#5, axis-16#6, axis-18#7, axis-20#8, axis-22#9, axis-24#10, axis-26#11, lbl-s1#12, lbl-t1#13, lbl-t2#14, lbl-t3#15, lbl-m1#16, lbl-s2#17, lbl-t4#18, lbl-t5#19, lbl-t6#20, lbl-t7#21, lbl-m2#22, lbl-s3#23, lbl-t8#24, lbl-t9#25, lbl-t10#26, legend-0#27, legend-1#28, legend-2#29, legend-3#30, legend-4#31, legend-5#32, legend-6#33, legend-7#34, summary-0#35, summary-1#36, summary-2#37, summary-3#38, summary-4#39, band-0#85, band-1#86, band-2#87, band-3#88, band-4#89, band-5#90, band-6#91, band-7#92, band-8#93, grid-0#94, grid-1#95, grid-2#96, grid-3#97, grid-4#98, grid-5#99, grid-6#100, grid-7#101, grid-8#102, legend-swatch-bar#103, legend-swatch-bar-summary#104, legend-swatch-milestone#105, legend-swatch-edge-FS#106, legend-swatch-edge-FS-head#107, legend-swatch-edge-SS#108, legend-swatch-edge-SS-head#109, legend-swatch-edge-FF#110, legend-swatch-edge-FF-head#111, legend-swatch-edge-SF#112, legend-swatch-edge-SF-head#113, grp-s1#68, bar-s1#40, prog-s1#41, bar-t1#42, prog-t1#43, bar-t2#44, prog-t2#45, bar-t3#46, prog-t3#47, ms-m1#48, grp-s2#69, bar-s2#49, prog-s2#50, bar-t4#51, prog-t4#52, bar-t5#53, prog-t5#54, bar-t6#55, prog-t6#56, bar-t7#57, prog-t7#58, ms-m2#59, grp-s3#70, bar-s3#60, prog-s3#61, bar-t8#62, prog-t8#63, bar-t9#64, prog-t9#65, bar-t10#66, prog-t10#67, dep-l1#71, dep-l2#72, dep-l3#73, dep-l4#74, dep-l5#75, dep-l6#76, dep-l7#77, dep-l8#78, dep-l9#79, dep-l10#80, dep-l11#81, dep-l12#82, dep-l13#83, dep-l14#84
```

WPS 另存后：

```
#1, title#2, axis-10#3, axis-12#4, axis-14#5, axis-16#6, axis-18#7, axis-20#8, axis-22#9, axis-24#10, axis-26#11, lbl-s1#12, lbl-t1#13, lbl-t2#14, lbl-t3#15, lbl-m1#16, lbl-s2#17, lbl-t4#18, lbl-t5#19, lbl-t6#20, lbl-t7#21, lbl-m2#22, lbl-s3#23, lbl-t8#24, lbl-t9#25, lbl-t10#26, legend-0#27, legend-1#28, legend-2#29, legend-3#30, legend-4#31, legend-5#32, legend-6#33, legend-7#34, summary-0#35, summary-1#36, summary-2#37, summary-3#38, summary-4#39, band-0#85, band-1#86, band-2#87, band-3#88, band-4#89, band-5#90, band-6#91, band-7#92, band-8#93, grid-0#94, grid-1#95, grid-2#96, grid-3#97, grid-4#98, grid-5#99, grid-6#100, grid-7#101, grid-8#102, legend-swatch-bar#103, legend-swatch-bar-summary#104, legend-swatch-milestone#105, legend-swatch-edge-FS#106, legend-swatch-edge-FS-head#107, legend-swatch-edge-SS#108, legend-swatch-edge-SS-head#109, legend-swatch-edge-FF#110, legend-swatch-edge-FF-head#111, legend-swatch-edge-SF#112, legend-swatch-edge-SF-head#113, grp-s1#68, bar-s1#40, prog-s1#41, bar-t1#42, prog-t1#43, bar-t2#44, prog-t2#45, bar-t3#46, prog-t3#47, ms-m1#48, grp-s2#69, bar-s2#49, prog-s2#50, bar-t4#51, prog-t4#52, bar-t5#53, prog-t5#54, bar-t6#55, prog-t6#56, bar-t7#57, prog-t7#58, ms-m2#59, grp-s3#70, bar-s3#60, prog-s3#61, bar-t8#62, prog-t8#63, bar-t9#64, prog-t9#65, bar-t10#66, prog-t10#67, dep-l1#71, dep-l2#72, dep-l3#73, dep-l4#74, dep-l5#75, dep-l6#76, dep-l7#77, dep-l8#78, dep-l9#79, dep-l10#80, dep-l11#81, dep-l12#82, dep-l13#83, dep-l14#84
```

拖动后再另存：

```
#1, title#2, axis-10#3, axis-12#4, axis-14#5, axis-16#6, axis-18#7, axis-20#8, axis-22#9, axis-24#10, axis-26#11, lbl-s1#12, lbl-t1#13, lbl-t2#14, lbl-t3#15, lbl-m1#16, lbl-s2#17, lbl-t4#18, lbl-t5#19, lbl-t6#20, lbl-t7#21, lbl-m2#22, lbl-s3#23, lbl-t8#24, lbl-t9#25, lbl-t10#26, legend-0#27, legend-1#28, legend-2#29, legend-3#30, legend-4#31, legend-5#32, legend-6#33, legend-7#34, summary-0#35, summary-1#36, summary-2#37, summary-3#38, summary-4#39, band-0#85, band-1#86, band-2#87, band-3#88, band-4#89, band-5#90, band-6#91, band-7#92, band-8#93, grid-0#94, grid-1#95, grid-2#96, grid-3#97, grid-4#98, grid-5#99, grid-6#100, grid-7#101, grid-8#102, legend-swatch-bar#103, legend-swatch-bar-summary#104, legend-swatch-milestone#105, legend-swatch-edge-FS#106, legend-swatch-edge-FS-head#107, legend-swatch-edge-SS#108, legend-swatch-edge-SS-head#109, legend-swatch-edge-FF#110, legend-swatch-edge-FF-head#111, legend-swatch-edge-SF#112, legend-swatch-edge-SF-head#113, grp-s1#68, bar-s1#40, prog-s1#41, bar-t1#42, prog-t1#43, bar-t2#44, prog-t2#45, bar-t3#46, prog-t3#47, ms-m1#48, grp-s2#69, bar-s2#49, prog-s2#50, bar-t4#51, prog-t4#52, bar-t5#53, prog-t5#54, bar-t6#55, prog-t6#56, bar-t7#57, prog-t7#58, ms-m2#59, grp-s3#70, bar-s3#60, prog-s3#61, bar-t8#62, prog-t8#63, bar-t9#64, prog-t9#65, bar-t10#66, prog-t10#67, dep-l1#71, dep-l2#72, dep-l3#73, dep-l4#74, dep-l5#75, dep-l6#76, dep-l7#77, dep-l8#78, dep-l9#79, dep-l10#80, dep-l11#81, dep-l12#82, dep-l13#83, dep-l14#84
```

WPS COM 侧形状树（会话 2 打开后，拖动之前；缩进 = `GroupItems` 层级）：

```
title
axis-10
axis-12
axis-14
axis-16
axis-18
axis-20
axis-22
axis-24
axis-26
lbl-s1
lbl-t1
lbl-t2
lbl-t3
lbl-m1
lbl-s2
lbl-t4
lbl-t5
lbl-t6
lbl-t7
lbl-m2
lbl-s3
lbl-t8
lbl-t9
lbl-t10
legend-0
legend-1
legend-2
legend-3
legend-4
legend-5
legend-6
legend-7
summary-0
summary-1
summary-2
summary-3
summary-4
band-0
band-1
band-2
band-3
band-4
band-5
band-6
band-7
band-8
grid-0
grid-1
grid-2
grid-3
grid-4
grid-5
grid-6
grid-7
grid-8
legend-swatch-bar
legend-swatch-bar-summary
legend-swatch-milestone
legend-swatch-edge-FS
legend-swatch-edge-FS-head
legend-swatch-edge-SS
legend-swatch-edge-SS-head
legend-swatch-edge-FF
legend-swatch-edge-FF-head
legend-swatch-edge-SF
legend-swatch-edge-SF-head
grp-s1
  bar-s1
  prog-s1
  bar-t1
  prog-t1
  bar-t2
  prog-t2
  bar-t3
  prog-t3
  ms-m1
grp-s2
  bar-s2
  prog-s2
  bar-t4
  prog-t4
  bar-t5
  prog-t5
  bar-t6
  prog-t6
  bar-t7
  prog-t7
  ms-m2
grp-s3
  bar-s3
  prog-s3
  bar-t8
  prog-t8
  bar-t9
  prog-t9
  bar-t10
  prog-t10
dep-l1
dep-l2
dep-l3
dep-l4
dep-l5
dep-l6
dep-l7
dep-l8
dep-l9
dep-l10
dep-l11
dep-l12
dep-l13
dep-l14
```

（注意：顶层只有文本框、`grp-s*` 与 `dep-*`；`bar-*`/`prog-*`/`ms-*` 在组内。
XML 里同样如此：它们是 `<p:grpSp>` 的子元素，而 connector 在**顶层**引用这些子形状的 id
——这正是 S7-a 所说的"跨组吸附"，WPS 打开与另存后都认这个引用。）

## 证据文件

- `evidence/wps/template-a-demo-as-written.xml`：补丁刚写出的 `slide1.xml`（WPS 打开**之前**解包）
- `evidence/wps/template-a-demo-saved-by-wps.xml`：WPS 另存后的 `slide1.xml`（**拖动前**；可直接与 as-written 做 diff）
- `evidence/wps/template-a-demo-saved-by-wps-after-drag.xml`：拖动后再另存同一副本的 `slide1.xml`（**仅当有拖动时生成**）
- `evidence/vision/template-a-demo-before.png` / `template-a-demo-after.png`：WPS 渲染图（1600×900；视觉判读输入，不作定论）
- 临时副本（未纳入证据，留在 `%TEMP%`）：`C:\Users\PRO~1.WAN\AppData\Local\Temp\template-a-demo-saved-by-wps.pptx` / `C:\Users\PRO~1.WAN\AppData\Local\Temp\template-a-demo-saved-by-wps-after-drag.pptx`

## WPS 打开/另存到底改了什么（字节层事实）

- `slide1.xml` 字符数：as-written 58767 ⇒ WPS 56890（**字节不同**），
  但**结构计数逐项一致**：`<p:sp>` 95 ⇒ 95、`<p:cxnSp>` 14 ⇒ 14、`<p:grpSp>` 3 ⇒ 3、`<a:stCxn>` 14 ⇒ 14、`<a:endCxn>` 14 ⇒ 14。
  已定位的重写：``<p:cSld name="Slide 1">`` 的 name 属性被丢掉，XML 声明/空白的写法被规范化（所以字节数变小）。
- 包内条目（非目录项）：补丁 20 项 ⇒ WPS 22 项；新增的是 `docProps/custom.xml`、`ppt/theme/theme2.xml`。
- **走线本身也被重算**（不只是平移）：拖动后 WPS 会按新的端点相对位置改写 connector 的
  `prstGeom`（折线路数）、`a:xfrm` 的 `flipH/flipV` 与 `avLst` 的调整值：

- `dep-l1`：preset `bentConnector3` ⇒ `bentConnector5`；xfrm 属性 `(无)` ⇒ `flipH="1" flipV="1"`；调整值 `(无)` ⇒ `-17257,50058,117257`
- `dep-l2`：preset `bentConnector3` ⇒ `bentConnector3`；xfrm 属性 `(无)` ⇒ `rot="10800000"`；调整值 `(无)` ⇒ `127253`
- 结论：**WPS 没有改动我们写进去的几何与吸附**，改动都落在"它自己的容器元数据"层——
  这正是 ADR 0010 §9 说的"产物一旦进别的渲染器就会被重写"，也是本仓库把逐字节 golden 限定在**我们自己写出**的产物上的原因。
