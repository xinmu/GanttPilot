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
| 3 | `Slide.Export` 出 PNG（拖动前） | 通过（127413 bytes） |
| 4 | `SaveAs` 另存 pptx（拖动前） | 通过（19868 bytes） |
| 5 | 另存后 `a:stCxn`/`a:endCxn` 条数存活 | 通过（补丁 14 条：st=14 end=14 ⇒ WPS 后 st=14 end=14） |
| 6 | 逐条 connector 端点（归一到形状名后）存活 | 通过（14 条全部一致） |
| 7 | `cxnSp` 条数（另存前/后） | 补丁 14 条 ⇒ WPS 14 条（一致） |
| 8 | 拖动任务条（COM 移动 `Left`/`Top`） | 通过（`bar-t1`：L=199.7 T=117.7 → L=319.7 T=177.7） |
| 9 | `Slide.Export` 出 PNG（拖动后） | 通过（127692 bytes） |
| 10 | `SaveAs` 另存 pptx（拖动后） | 通过（20080 bytes） |
| 11 | **端点跟随**（相关 connector 的 `xfrm` 重算） | 通过（xfrm 随移动重算） |
| 12 | `cxnSpLocks` | 补丁 0 处 ⇒ WPS 0 处 |

### 拖动增量与跟随幅度

- COM 位移 ΔLeft=120 ⇒ XML Δoff.x=144288（比值 1202.4；12700 ⇒ COM 用 pt，1 ⇒ COM 用 EMU）
- `dep-l1`：Δoff.x=144288 Δoff.y=216887
- `dep-l2`：Δoff.x=650247 Δoff.y=434057

## 拖动前后 connector ``xfrm`` 对比

| connector | 时点 | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy | 变化 |
|---|---|---|---|---|---|---|---|---|
| `dep-l1` | 拖动前 | 31/3 | 33/1 | 2897362 | 1559843 | 144472 | 216707 | — |
| `dep-l1` | 拖动后 | 31/3 | 33/1 | 3041650 | 1776730 | 1379855 | 545465 | **已重算** |
| `dep-l2` | 拖动前 | 31/1 | 35/1 | 2536183 | 1559843 | 650122 | 433415 | — |
| `dep-l2` | 拖动后 | 31/1 | 35/1 | 3186430 | 1993900 | 873760 | 328295 | **已重算** |

### 一条必须记下的结构事实：任务条在**组内**

补丁把每个一级汇总行做成真的 `p:grpSp`（`grp-s*`），任务条与进度条是它的**子形状**。
因此 WPS 的**顶层** `Slides.Item(1).Shapes` 里没有 `bar-*`——S1 的按名定位（`Get-WpsShapeByName`）
只扫顶层，在这里必然落空。本脚本用 `Get-WpsShapeByNameDeep` 递归进 `GroupItems` 才拿到 `bar-t1`，
而跨组吸附的另一面也正在这里：`a:stCxn id=31` 指的是**组内子形状**，WPS 另存后仍然认得它。

### 全部 connector（补丁刚写出的 slide1.xml）

| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|---|---|
| `dep-l1` | 31/3 | 33/1 | 2897362 | 1559843 | 144472 | 216707 |
| `dep-l2` | 31/1 | 35/1 | 2536183 | 1559843 | 650122 | 433415 |
| `dep-l3` | 33/3 | 35/1 | 3186305 | 1776550 | 72236 | 216708 |
| `dep-l4` | 35/3 | 37/1 | 3601661 | 1993258 | 18059 | 216707 |
| `dep-l5` | 35/3 | 40/1 | 3619720 | 1993258 | 72236 | 650122 |
| `dep-l6` | 40/1 | 42/1 | 3691956 | 2643380 | 144472 | 216708 |
| `dep-l7` | 40/1 | 44/1 | 3691956 | 2643380 | 144472 | 433415 |
| `dep-l8` | 42/3 | 46/3 | 4703258 | 2860088 | 433415 | 433415 |
| `dep-l9` | 44/3 | 46/1 | 4703258 | 3076795 | 12700 | 216708 |
| `dep-l10` | 46/3 | 48/1 | 5118614 | 3293503 | 18059 | 216707 |
| `dep-l11` | 46/3 | 51/1 | 5136673 | 3293503 | 144472 | 650122 |
| `dep-l12` | 51/3 | 53/1 | 5714560 | 3943625 | 12700 | 216708 |
| `dep-l13` | 53/3 | 55/1 | 5859031 | 4160333 | 12700 | 216707 |
| `dep-l14` | 51/1 | 55/3 | 5281145 | 3943625 | 650122 | 433415 |

### 全部 connector（WPS 另存后 · 拖动前）

| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|---|---|
| `dep-l1` | 31/3 | 33/1 | 2897362 | 1559843 | 144472 | 216707 |
| `dep-l2` | 31/1 | 35/1 | 2536183 | 1559843 | 650122 | 433415 |
| `dep-l3` | 33/3 | 35/1 | 3186305 | 1776550 | 72236 | 216708 |
| `dep-l4` | 35/3 | 37/1 | 3601661 | 1993258 | 18059 | 216707 |
| `dep-l5` | 35/3 | 40/1 | 3619720 | 1993258 | 72236 | 650122 |
| `dep-l6` | 40/1 | 42/1 | 3691956 | 2643380 | 144472 | 216708 |
| `dep-l7` | 40/1 | 44/1 | 3691956 | 2643380 | 144472 | 433415 |
| `dep-l8` | 42/3 | 46/3 | 4703258 | 2860088 | 433415 | 433415 |
| `dep-l9` | 44/3 | 46/1 | 4703258 | 3076795 | 12700 | 216708 |
| `dep-l10` | 46/3 | 48/1 | 5118614 | 3293503 | 18059 | 216707 |
| `dep-l11` | 46/3 | 51/1 | 5136673 | 3293503 | 144472 | 650122 |
| `dep-l12` | 51/3 | 53/1 | 5714560 | 3943625 | 12700 | 216708 |
| `dep-l13` | 53/3 | 55/1 | 5859031 | 4160333 | 12700 | 216707 |
| `dep-l14` | 51/1 | 55/3 | 5281145 | 3943625 | 650122 | 433415 |

### 全部 connector（WPS 另存后 · 拖动后）

| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|---|---|
| `dep-l1` | 31/3 | 33/1 | 3041650 | 1776730 | 1379855 | 545465 |
| `dep-l2` | 31/1 | 35/1 | 3186430 | 1993900 | 873760 | 328295 |
| `dep-l3` | 33/3 | 35/1 | 3186430 | 1776730 | 71755 | 217170 |
| `dep-l4` | 35/3 | 37/1 | 3601720 | 1993900 | 18415 | 216535 |
| `dep-l5` | 35/3 | 40/1 | 3620135 | 1993900 | 71755 | 649605 |
| `dep-l6` | 40/1 | 42/1 | 3691956 | 2643380 | 144472 | 216708 |
| `dep-l7` | 40/1 | 44/1 | 3691956 | 2643380 | 144472 | 433415 |
| `dep-l8` | 42/3 | 46/3 | 4703258 | 2860088 | 433415 | 433415 |
| `dep-l9` | 44/3 | 46/1 | 4703258 | 3076795 | 12700 | 216708 |
| `dep-l10` | 46/3 | 48/1 | 5118614 | 3293503 | 18059 | 216707 |
| `dep-l11` | 46/3 | 51/1 | 5136673 | 3293503 | 144472 | 650122 |
| `dep-l12` | 51/3 | 53/1 | 5714560 | 3943625 | 12700 | 216708 |
| `dep-l13` | 53/3 | 55/1 | 5859031 | 4160333 | 12700 | 216707 |
| `dep-l14` | 51/1 | 55/3 | 5281145 | 3943625 | 650122 | 433415 |

## 形状集合

补丁刚写出：

```
#1, title#2, lbl-s1#3, lbl-t1#4, lbl-t2#5, lbl-t3#6, lbl-m1#7, lbl-s2#8, lbl-t4#9, lbl-t5#10, lbl-t6#11, lbl-t7#12, lbl-m2#13, lbl-s3#14, lbl-t8#15, lbl-t9#16, lbl-t10#17, legend-0#18, legend-1#19, legend-2#20, legend-3#21, legend-4#22, legend-5#23, summary-0#24, summary-1#25, summary-2#26, summary-3#27, summary-4#28, grp-s1#57, bar-s1#29, prog-s1#30, bar-t1#31, prog-t1#32, bar-t2#33, prog-t2#34, bar-t3#35, prog-t3#36, ms-m1#37, grp-s2#58, bar-s2#38, prog-s2#39, bar-t4#40, prog-t4#41, bar-t5#42, prog-t5#43, bar-t6#44, prog-t6#45, bar-t7#46, prog-t7#47, ms-m2#48, grp-s3#59, bar-s3#49, prog-s3#50, bar-t8#51, prog-t8#52, bar-t9#53, prog-t9#54, bar-t10#55, prog-t10#56, dep-l1#60, dep-l2#61, dep-l3#62, dep-l4#63, dep-l5#64, dep-l6#65, dep-l7#66, dep-l8#67, dep-l9#68, dep-l10#69, dep-l11#70, dep-l12#71, dep-l13#72, dep-l14#73
```

WPS 另存后：

```
#1, title#2, lbl-s1#3, lbl-t1#4, lbl-t2#5, lbl-t3#6, lbl-m1#7, lbl-s2#8, lbl-t4#9, lbl-t5#10, lbl-t6#11, lbl-t7#12, lbl-m2#13, lbl-s3#14, lbl-t8#15, lbl-t9#16, lbl-t10#17, legend-0#18, legend-1#19, legend-2#20, legend-3#21, legend-4#22, legend-5#23, summary-0#24, summary-1#25, summary-2#26, summary-3#27, summary-4#28, grp-s1#57, bar-s1#29, prog-s1#30, bar-t1#31, prog-t1#32, bar-t2#33, prog-t2#34, bar-t3#35, prog-t3#36, ms-m1#37, grp-s2#58, bar-s2#38, prog-s2#39, bar-t4#40, prog-t4#41, bar-t5#42, prog-t5#43, bar-t6#44, prog-t6#45, bar-t7#46, prog-t7#47, ms-m2#48, grp-s3#59, bar-s3#49, prog-s3#50, bar-t8#51, prog-t8#52, bar-t9#53, prog-t9#54, bar-t10#55, prog-t10#56, dep-l1#60, dep-l2#61, dep-l3#62, dep-l4#63, dep-l5#64, dep-l6#65, dep-l7#66, dep-l8#67, dep-l9#68, dep-l10#69, dep-l11#70, dep-l12#71, dep-l13#72, dep-l14#73
```

拖动后再另存：

```
#1, title#2, lbl-s1#3, lbl-t1#4, lbl-t2#5, lbl-t3#6, lbl-m1#7, lbl-s2#8, lbl-t4#9, lbl-t5#10, lbl-t6#11, lbl-t7#12, lbl-m2#13, lbl-s3#14, lbl-t8#15, lbl-t9#16, lbl-t10#17, legend-0#18, legend-1#19, legend-2#20, legend-3#21, legend-4#22, legend-5#23, summary-0#24, summary-1#25, summary-2#26, summary-3#27, summary-4#28, grp-s1#57, bar-s1#29, prog-s1#30, bar-t1#31, prog-t1#32, bar-t2#33, prog-t2#34, bar-t3#35, prog-t3#36, ms-m1#37, grp-s2#58, bar-s2#38, prog-s2#39, bar-t4#40, prog-t4#41, bar-t5#42, prog-t5#43, bar-t6#44, prog-t6#45, bar-t7#46, prog-t7#47, ms-m2#48, grp-s3#59, bar-s3#49, prog-s3#50, bar-t8#51, prog-t8#52, bar-t9#53, prog-t9#54, bar-t10#55, prog-t10#56, dep-l1#60, dep-l2#61, dep-l3#62, dep-l4#63, dep-l5#64, dep-l6#65, dep-l7#66, dep-l8#67, dep-l9#68, dep-l10#69, dep-l11#70, dep-l12#71, dep-l13#72, dep-l14#73
```

WPS COM 侧形状树（会话 2 打开后，拖动之前；缩进 = `GroupItems` 层级）：

```
title
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
summary-0
summary-1
summary-2
summary-3
summary-4
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

- `slide1.xml` 字符数：as-written 41151 ⇒ WPS 39813（**字节不同**），
  但**结构计数逐项一致**：`<p:sp>` 55 ⇒ 55、`<p:cxnSp>` 14 ⇒ 14、`<p:grpSp>` 3 ⇒ 3、`<a:stCxn>` 14 ⇒ 14、`<a:endCxn>` 14 ⇒ 14。
  已定位的重写：``<p:cSld name="Slide 1">`` 的 name 属性被丢掉，XML 声明/空白的写法被规范化（所以字节数变小）。
- 包内条目（非目录项）：补丁 20 项 ⇒ WPS 22 项；新增的是 `docProps/custom.xml`、`ppt/theme/theme2.xml`。
- **走线本身也被重算**（不只是平移）：拖动后 WPS 会按新的端点相对位置改写 connector 的
  `prstGeom`（折线路数）、`a:xfrm` 的 `flipH/flipV` 与 `avLst` 的调整值：

- `dep-l1`：preset `bentConnector3` ⇒ `bentConnector5`；xfrm 属性 `(无)` ⇒ `flipH="1" flipV="1"`；调整值 `(无)` ⇒ `-17257,50058,117257`
- `dep-l2`：preset `bentConnector3` ⇒ `bentConnector3`；xfrm 属性 `(无)` ⇒ `rot="10800000"`；调整值 `(无)` ⇒ `127253`
- 结论：**WPS 没有改动我们写进去的几何与吸附**，改动都落在"它自己的容器元数据"层——
  这正是 ADR 0010 §9 说的"产物一旦进别的渲染器就会被重写"，也是本仓库把逐字节 golden 限定在**我们自己写出**的产物上的原因。
