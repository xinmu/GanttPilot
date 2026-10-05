# template-a-demo · 返工存活核实（补丁 ⇒ WPS 另存 round-trip）

> 本文件是 [`template-a-demo-wps.md`](template-a-demo-wps.md) 的**附加小节**，回答一个单独的问题：
> **本轮 4 项返工（日期刻度 / 背景带与网格 / 箭头 / 图例图元）在 WPS 打开并另存之后，还在不在？**
>
> 原报告的 12 项判定仍是主判据；这里只做"同一份 `slide1.xml` 在补丁侧与 WPS 侧的逐类计数对比"。
> 记录制：由人工按 `scripts/export-pptx.mjs` + `scripts/wps-pptx-verify.ps1` 的产物**手工统计**得出（未新增脚本）。

## 被比较的三份 `slide1.xml`

| 时点 | 文件 | 字节 | 字符 | LF/CRLF |
|---|---|---|---|---|
| 补丁刚写出（WPS 打开**之前**） | `evidence/wps/template-a-demo-as-written.xml` | 59096 | 58766 | LF（CRLF=0） |
| WPS 另存后（**拖动前**） | `evidence/wps/template-a-demo-saved-by-wps.xml` | 57219 | 56889 | LF（CRLF=0） |
| WPS 另存后（**拖动后**） | `evidence/wps/template-a-demo-saved-by-wps-after-drag.xml` | 57715 | 57385 | LF（CRLF=0） |

sha256（`Get-FileHash -Algorithm SHA256`，小写）：

- as-written：`cfa731fb650b89c9fc29eac7afe51f00a0090490817a382e8dc6d7514fe59c15`
- saved-by-wps：`35e039bf53b30e9f54304983e31eedbd15042a9623e96386749e94a54523638c`
- saved-by-wps-after-drag：`838e6d47e4080e3e7f115f7048ad171d7d5634f4a849ba77a50e24311aaaa3ca`

被验 pptx：`tmp/exports/template-a-demo-week.pptx`，15833 bytes，
sha256 `5f86f7a9ba0c6758f863afa5fdc09b388ceb54d16d72752afbef13355aab9e7b`（`twoRunIdentical=true`）。

## 一、四类图元计数对比（**实测值，不粉饰**）

| 计数项 | 补丁刚写出 | WPS 另存后 | 拖动后再另存 | 判定 |
|---|---|---|---|---|
| `name="axis-` 形状数 | **9** | **9** | **9** | **存活**（未被改写） |
| `name="band-` 形状数 | **9** | **9** | **9** | **存活** |
| `name="grid-` 形状数 | **9** | **9** | **9** | **存活** |
| `name="legend-swatch-` 形状数 | **11** | **11** | **11** | **存活** |
| `<a:tailEnd type="triangle"` 次数 | **10** | **10** | **10** | **存活**（FS/FF 实心箭头） |
| `<a:tailEnd type="arrow"` 次数 | **4** | **4** | **4** | **存活**（SS/SF 空心箭头） |
| `<a:tailEnd>` 合计 | **14** | **14** | **14** | 存活（= connector 条数） |
| `<p:cxnSp>` 条数 | **14** | **14** | **14** | 存活 |
| `lbl-s1` 含 `b="1"` | **是**（1 个 run） | **是**（1 个 run） | **是** | 存活 |
| `F4F6F8` 出现次数（周末/节假日灰度带填充） | **9** | **9** | **9** | 存活 |
| `E4E7EC` 出现次数（网格线填充） | **9** | **9** | **9** | 存活 |
| `<p:sp>` / `<p:grpSp>` | 95 / 3 | 95 / 3 | 95 / 3 | 存活 |
| `cxnSpLocks` | 0 | 0 | 0 | 存活（本来就没有，见原报告第 12 项） |

**逐条结论（四类返工项）**

1. **日期刻度 `axis-N`（pptxgenjs 文本框）：存活。**
   9 个刻度框（`axis-10` … `axis-26`，即 09-28 / 10-05 / … / 11-23）在 WPS 另存前后**数量、形状名、id、
   `a:xfrm`（`off`/`ext`）、字号 `sz="900"`、颜色 `667085`、文本内容全部逐一相同**（文本逐条比对见第三节）。
   WPS 唯一动它的是把 `<a:ln></a:ln>`（空线型）整条删掉——这也发生在**其余 37 个文本框**上（见第二节）。
2. **背景 `band-N` / `grid-N`：存活，且仍在条形之下。**
   9 + 9 个无描边 `rect`（`<a:ln><a:noFill/></a:ln>`）计数、填充色、`off`/`ext` 全部不变；
   文档顺序（z 序）在两侧一致：`band-0` 早于 `bar-s1`、`grid-8` 早于 `bar-s1`
   （实测索引：as-written 25420/30658 对 35370；WPS 后 23543/28781 对 33493）。**没有被 WPS 提到条之上。**
3. **依赖线箭头：存活。**
   14 条 `<p:cxnSp>` 的 `<a:tailEnd>` 逐条对应关系未变：实心 `triangle` 10 条（FS/FF）、空心 `arrow` 4 条
   （SS/SF）；**没有任何一条 connector 被加上 `headEnd`**（`<a:headEnd` 两侧均为 0）。
   WPS 只把 connector 的 `a:ln` 原样保留（含 `tailEnd`），并把拖动后的走线重算（原报告已记）。
4. **图例图元：存活。**
   11 个 `legend-swatch-*` 形状（`bar`、`bar-summary`、`milestone`、4 条 `edge-FS|SS|FF|SF` 各带一个 `-head`）
   两侧数量一致、命名一致；色块几何与填色逐一相同（抽查：`legend-swatch-bar` 保持 `2E75B6` 的 171450×95250
   `rect`；`legend-swatch-milestone` 保持 `prst="diamond"` + `ED7D31`；`legend-swatch-edge-FS-head` 保持
   `prst="triangle"` + `475467`）。文案来自 `render-core` 的 `exportLegendItems()`，8 条文案（图例标题 +
   7 条）在 WPS 侧**逐字不变**。
5. **样式 `lbl-s1` 加粗 / 子行标签右移缩进：存活。**
   `lbl-s1` 的 run 仍带 `b="1"`（1 个 run）；`lbl-s1` 的 `off.x=206577` 与子行 `lbl-t1` 的 `off.x=314931`
   相差 **108354 EMU**（= 缩进量，WPS 侧两个值同样未变）——即"阶段汇总标签靠左、子行标签右移"的层级在
   WPS 里没有被抹平。

## 二、WPS 到底重写了什么（**只有一条与返工项有交集，且无语义影响**）

| 项 | 补丁刚写出 | WPS 另存后 | 影响 |
|---|---|---|---|
| 文本框里的空线型 `<a:ln></a:ln>` | 38 处 | **0 处（整条删除）** | 无。该元素本身不表达任何线型；与它并列的 `<a:ln><a:noFill/></a:ln>`（图形形状，含 `band-*`/`grid-*`/`legend-swatch-*`）**37 处 ⇒ 37 处，一处未动** |
| `<a:bodyPr …></a:bodyPr>` 空对 | 38 处 | **0 处**，改为 `<a:bodyPr …/>` | 无（同义写法规范化） |
| `<a:pPr algn="l" indent="0" marL="0">` | 该属性序 | `marL="0" indent="0" algn="l"` | 无（属性重排，值不变） |
| `<p:cSld name="Slide 1">` | 有 `name` | `<p:cSld>`（name 被丢） | 无（容器元数据） |
| 形状 id | 1..113 | **1..113，逐一未变**（113 个里 0 个改号） | 无 |
| 包内条目 | 20 项 | 22 项，新增 `docProps/custom.xml`、`ppt/theme/theme2.xml` | 无 |
| 线型片段（含箭头） | `noFill` 37 / `2E75B6` 10 / `475467+triangle` 10 / `475467+arrow` 4 / `475467 w=9525` 4 / `B1551A` 3 / `7A8699` 3 | **逐类完全一致** | 无 |

结论：**本轮返工的四类图元在 WPS round-trip 中没有出现"被改写"或"消失"的现象**；
WPS 的重写仍集中在"它自己的容器/写法规范化"层，唯一被删的是**空 `<a:ln>`**，而它只出现在文本框上，
且删掉后文本框仍然是"无描边"（原本的语义就是没有边框）。`band-*`/`grid-*` 的 `noFill` 描边**没有被删**。

## 三、WPS 渲染图（视觉判读输入，不作定论）

`evidence/vision/template-a-demo-before.png`（拖动前，139715 bytes）与 `template-a-demo-after.png`
（拖动后，139546 bytes）均为 1600×900。人工判读要点（截图见原报告证据清单）：

- 顶部 **9 个日期刻度**可见（09-28 … 11-23）；
- 背景**周末/节假日灰度带**与**网格线**可见，且**位于条形之下**（条与里程碑菱形的边界未被灰带切断）；
- **14 条依赖线**箭头可见：实心三角（FS/FF）与空心箭头（SS/SF）都能分辨；
- 右侧**图例 7 条色块**与文案对齐（色块 x=6553200，文案 x=6743700，不重叠），
  **摘要三行**文案与 `exportSummaryLines()` 逐字一致：
  `任务 15 · 依赖 14`、`里程碑 2 个 · 完成率 36%`、
  `1.4 里程碑：方案评审通过 · 2026-10-20`、`2.5 里程碑：联调完成 · 2026-11-10`。

## 四、不通过项

**本附加核实：无。** 四类图元（刻度 / 背景 / 箭头 / 图例图元）+ 样式项在 WPS 另存前后计数全部一致，
未发现"不生效"或"丢失"。

原始实测值（供复核）：

```
                                as-written  saved-by-wps  after-drag
name="axis-                            9             9           9
name="band-                            9             9           9
name="grid-                            9             9           9
name="legend-swatch-                  11            11          11
<a:tailEnd type="triangle"            10            10          10
<a:tailEnd type="arrow"                4             4           4
<p:cxnSp>                             14            14          14
lbl-s1 b="1"                           1             1           1
F4F6F8                                 9             9           9
E4E7EC                                 9             9           9
<p:sp>                                95            95          95
<p:grpSp>                              3             3           3
cxnSpLocks                             0             0           0
slide1.xml chars                   58766         56889       57385
```
