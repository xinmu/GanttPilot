# template-a-demo · 返工存活核实（补丁 ⇒ WPS 另存 round-trip）

> 本文件是 [`template-a-demo-wps.md`](template-a-demo-wps.md) 的**附加小节**：回答"**两轮返工的图元与样式
> 在 WPS 打开并另存之后还在不在**"，并记录一个**被否掉的实现方案**（P-38）。
>
> 记录制：由 `scripts/export-pptx.mjs` + `scripts/wps-pptx-verify.ps1` 的产物统计得出（未新增脚本）。

## 被比较的三份 `slide1.xml`

| 时点 | 文件 |
|---|---|
| 补丁刚写出（WPS 打开**之前**） | `evidence/wps/template-a-demo-as-written.xml` |
| WPS 另存后（**拖动前**） | `evidence/wps/template-a-demo-saved-by-wps.xml` |
| WPS 另存后（**拖动后**） | `evidence/wps/template-a-demo-saved-by-wps-after-drag.xml` |

被验产物：`tmp/exports/template-a-demo-week.pptx`，**15,886 字节**，
sha256 `b5f644d4a8602a9d27b49221a725cc22eb9903c096e260b29641c5e67fb2ccc8`（`twoRunIdentical = true`，行 15 / 边 14）。

环境：WPS 演示 COM 自报 `Name=Microsoft PowerPoint` / `Version=12.0`（**伪装字符串**，
识别靠 `Path` 指向 `Kingsoft\WPS Office\12.1.0.28505\office6`）。

## 一、三态逐类计数（实测，不粉饰）

| 计数项 | 补丁刚写出 | WPS 另存后 | 拖动后再另存 | 判定 |
|---|---|---|---|---|
| `name="axis-N"`（日期刻度文本框） | 9 | 9 | 9 | **存活** |
| `name="band-N"`（周末/节假日灰度带） | 9 | 9 | 9 | **存活** |
| `name="grid-N"`（背景网格线） | 9 | 9 | 9 | **存活** |
| `name="legend-swatch-*"`（图例图元，含箭头） | 13 | 13 | 13 | **存活** |
| `<a:tailEnd type="triangle"`（FS/FF 实心三角） | 10 | 10 | 10 | **存活** |
| `<a:tailEnd type="arrow"`（SS/SF 开放箭头） | 4 | 4 | 4 | **存活** |
| `<a:tailEnd>` 合计 / `<p:cxnSp>` | 14 / 14 | 14 / 14 | 14 / 14 | 存活（**每条依赖线都带箭头**） |
| `<a:headEnd` | 0 | 0 | 0 | 无头端箭头（符合口径） |
| `name="dep-lN-head"`（**自绘箭头形状**） | **0** | **0** | **0** | 符合 P-38 的否决结论（见第二节） |
| `<p:sp>` / `<p:grpSp>` | 97 / 3 | 97 / 3 | 97 / 3 | 存活 |
| `lbl-s1` 含 `b="1"`（汇总行加粗） | 是 | 是 | 是 | **存活** |
| `band-0` 的文档位置**在** `bar-s1` **之前** | 是 | 是 | 是 | **z 序未变**（灰度带/网格线仍在条形之下） |

**结论：两轮返工的全部图元与样式项在 WPS round-trip 中存活，无"被改写 / 消失"项。**

## 二、被否掉的方案：**自绘空心三角箭头**（P-38 的实测依据）

背景：二次人工复验指出 `SS`/`SF` 的箭头是 `→` 形、与 SVG/图例的**空心三角**不同形
（维护者同时注明"**问题不大、不影响理解**"）。第一版修法是**抑制 `a:tailEnd`、自绘一个白底三角**
（形状名 `dep-<linkId>-head`），成功做到了与 SVG 同形。**该方案随后被否掉，理由是实测出来的：**

- 自绘形状**没有 `stCxn`/`endCxn` 吸附锚点** ⇒ WPS **从不重算它的 `a:xfrm`**
  （同一份产物在"补丁 / WPS 另存 / 拖动后再另存"三态**逐字节相同**）；
- 依赖线**本身**会重算（这是 G7 出口条件③ 的招牌行为）⇒ **拖动"入端"那条任务条时，线走而箭头留在原地**；
- 本次取证的拖动目标是 `bar-t1`（它是 4 个 head 中某些的**出端**），所以那一轮"看起来没问题"——
  这只是因为"入端条没被拖动"，**不是** head 会跟随的证据。

⇒ **优先级判定：G7 的招牌行为（拖动后端点跟随）高于箭头形状的一致性。**
改用 OOXML 原生 `type="arrow"`（"→"）——它写在 `<a:ln>` 里，随连接线一起被 WPS 重算，**任何方向拖动都跟随**；
代价是它与 SVG/PNG 的**空心三角**不同形（维护者已认可"不影响理解"，且 SVG/屏幕一侧保持自己的既有语言不变）。

**图例必须与画布同形**：PPT 的图例里 `SS`/`SF` 因此画成**开放箭头**
（`legend-swatch-edge-SS-head-arm1/arm2`：两条细矩形旋转 ±45° 拼尖角），
`FS`/`FF` 画实心三角——**图例教的就是画布上真实的样子**。

## 三、看图结论（`evidence/vision/template-a-demo-before.png` / `-after.png`，1600×900）

- **顶部日期刻度**：9 个（`09-28 … 11-23`）✓
- **条体区背景**：周末浅灰竖带 + 竖向网格线可见 ✓
- **箭头**：14 条依赖线**全部带箭头**（`FS`/`FF` 实心三角、`SS`/`SF` 开放箭头）✓
- **左列任务名**：3 个阶段**加粗**、子行**缩进** ✓
- **图例**：色块/箭头与文本**水平中线对齐**、间距舒适 ✓
- **侧栏**：图例 + 摘要块与甘特块的视觉中心基本一致（不再浮在右上方）✓

## 四、WPS 对字节的唯一改写（无语义影响）

删掉文本框里的空 `<a:ln></a:ln>`、`<a:bodyPr></a:bodyPr>` → `<a:bodyPr/>`、`a:pPr` 属性重排、
丢 `<p:cSld name>`、包内多出 `docProps/custom.xml` 与 `ppt/theme/theme2.xml`——
**上表每一类计数在改写前后完全一致**。
