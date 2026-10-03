# P-8 遗留 1 · WPS 实测 OOXML 连接点 `idx` 语义（G4 准入）

> 由 `pwsh -File src/wps-connector-idx.ps1` 采集、`gen-wps-evidence.py` 生成。
> 
> **WPS 的 COM 自报名称是 `Microsoft PowerPoint`、版本 `12.0`**，这是**伪装字符串**，**不构成「用 Microsoft PowerPoint 验证过」的证据**（仓库已记录的陷阱）。按裁决 P-4，验证环境**以 WPS 为准、Microsoft PowerPoint 备查、不阻塞**。
> 
> **问题**：`a:stCxn@idx` / `a:endCxn@idx` 是 **preset geometry 的连接点序列号**，
> **不是** COM 的站点枚举值。`roundRect` 的 OOXML 序列为 `0=上 1=左 2=下 3=右`，
> COM 为 `1=上 2=左 3=下 4=右` —— 两者**相差 1**。
> S1 只给过**两个竖向样本**（COM 3/1 → 落盘 `idx="2"`/`idx="0"`）；本实验补**横向样本**。

## 一、结论（一句话）

**「相差 1」规则在四个站点上全部实测成立**：`idx_OOXML = COM − 1`。
横向样本 **COM `BeginConnect($barA, 4)` / `EndConnect($barB, 2)` → 落盘 `stCxn idx="3"`（右）/ `endCxn idx="1"`（左）**，与 P-8 第 4 条的**外推值一致**。
P-8 第 1 条 FS = 前置右出 → 后置左入 所依赖的 `idx=3` / `idx=1` **不再是外推值**，
G4 准入的该项**已补齐**（本轮只出 WPS 口径，见文末「未验证项」）。

## 二、环境

| 项 | 值 |
|---|---|
| 采集时刻 | 2026-10-04 01:17:11（**每次运行都会变，非判据**） |
| PowerShell | 7.6.6 |
| WPS 安装目录存在 | True |
| COM ProgID | `KWPP.Application`（**不是** PowerPoint 的 ProgID） |
| COM 自报 Name | `Microsoft PowerPoint`（**伪装字符串，见上**） |
| COM 自报 Version | `12.0` |
| COM 自报 Build | `12.1.0.28505` |
| COM 自报 Path | `C:\Users\Pro.WANG\AppData\Local\Kingsoft\WPS Office\12.1.0.28505\office6` |
| 页面尺寸 | 960 × 540 pt |
| 形状 | `bar-a` roundRect @(100,100,200,40) pt；`bar-b` roundRect @(500,320,200,40) pt |
| connector | `AddConnector(2, …)` = msoConnectorElbow，命名 `dep-1` |

## 三、COM ↔ OOXML 四站点对照表（本次实测）

站点定义：`roundRect` 的连接点是**四条边的中点**。

| 站点语义 | **OOXML `idx`** | **COM 站点号** | 关系 |
|---|---|---|---|
| **上** | **`0`** | **`1`** | `COM − 1 = OOXML` |
| **左** | **`1`** | **`2`** | `COM − 1 = OOXML` |
| **下** | **`2`** | **`3`** | `COM − 1 = OOXML` |
| **右** | **`3`** | **`4`** | `COM − 1 = OOXML` |

### 3.1 四个站点的逐站点实测（原始落盘值）

| 站点语义 | COM 站点号 | 本次实测落盘（取自第五节原始 XML） | 结论 |
|---|---|---|---|
| 上 | `1` | `BeginConnect($barA, 1)` → `stCxn id="2" idx="0"` | ✅ 通过 |
| 左 | `2` | `EndConnect($barB, 2)` → `endCxn id="3" idx="1"` | ✅ 通过 |
| 下 | `3` | `BeginConnect($barA, 3)` → `stCxn id="2" idx="2"` | ✅ 通过 |
| 右 | `4` | `BeginConnect($barA, 4)` → `stCxn id="2" idx="3"` | ✅ 通过 |

> 逐格取自第五节原始 XML；四个站点**都**有 `BeginConnect` / `EndConnect` 的直接样本
> （`com1-com1` 提供上、`com3-com1` 提供下+上、`com4-com2` 提供右+左、`com3-com3` 提供下）。
> 上表「结论」列检查的是：该 COM 站点号是否确实落盘为对应的 OOXML `idx`。

## 四、四组合逐条实测（原始落盘值）

| 组合 | `BeginConnect`(COM) | 落盘 `stCxn` | 期望 | `EndConnect`(COM) | 落盘 `endCxn` | 期望 | 对照 |
|---|---|---|---|---|---|---|---|
| `com1-com1` | 1（上） | `id=2 idx=0`（上） | 0 | 1（上） | `id=3 idx=0`（上） | 0 | ✅ 与外推一致 |
| `com3-com1` | 3（下） | `id=2 idx=2`（下） | 2 | 1（上） | `id=3 idx=0`（上） | 0 | ✅ 与外推一致 |
| `com4-com2` | 4（右） | `id=2 idx=3`（右） | 3 | 2（左） | `id=3 idx=1`（左） | 1 | ✅ 与外推一致 |
| `com3-com3` | 3（下） | `id=2 idx=2`（下） | 2 | 3（下） | `id=3 idx=2`（下） | 2 | ✅ 与外推一致 |

竖向样本（`com3-com1`）与 S1 `wps-native-reference.ps1` 的参数完全相同，落盘值也相同
（`stCxn idx="2"` / `endCxn idx="0"`）—— 说明本脚本与 S1 参照实现可比。

## 五、逐组合原始证据（`ppt/slides/slide1.xml` 的 `p:cxnSp` 片段）

```text
[com1-com1] COM BeginConnect=1 / EndConnect=1
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="0"/><a:endCxn id="3" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm rot="16200000" flipH="1"><a:off x="3683000" y="127000"/><a:ext cx="2794000" cy="5080000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val -8523"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

[com3-com1] COM BeginConnect=3 / EndConnect=1
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="2"/><a:endCxn id="3" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm rot="5400000" flipV="1"><a:off x="3937000" y="381000"/><a:ext cx="2286000" cy="5080000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 50000"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

[com4-com2] COM BeginConnect=4 / EndConnect=2
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="3"/><a:endCxn id="3" idx="1"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="3810000" y="1524000"/><a:ext cx="2540000" cy="2794000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 50000"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

[com3-com3] COM BeginConnect=3 / EndConnect=3
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="2"/><a:endCxn id="3" idx="2"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm rot="5400000" flipV="1"><a:off x="3683000" y="635000"/><a:ext cx="2794000" cy="5080000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 108523"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

```

完整 XML 快照见 `evidence/wps/P8-idx-com*-slide1.xml`（LF 写入）。

## 六、connector 几何与 WPS 的规范化（`a:xfrm` / `prstGeom` / `adj1`）

| 组合 | `off` (x,y) | `ext` (cx,cy) | `rot` | `flipH` | `flipV` | `prstGeom` | `adj1` |
|---|---|---|---|---|---|---|---|
| `com1-com1` | (3683000, 127000) | (2794000, 5080000) | `16200000` | `1` | `—` | `bentConnector3` | `-8523` |
| `com3-com1` | (3937000, 381000) | (2286000, 5080000) | `5400000` | `—` | `1` | `bentConnector3` | `50000` |
| `com4-com2` | (3810000, 1524000) | (2540000, 2794000) | `—` | `—` | `—` | `bentConnector3` | `50000` |
| `com3-com3` | (3683000, 635000) | (2794000, 5080000) | `5400000` | `—` | `1` | `bentConnector3` | `108523` |

**这张表回答的是「idx 之外还落了什么」**，也是后续遗留 2 的输入：

- `com4-com2`（右→左）是**唯一未旋转**的组合：`rot`/`flipH`/`flipV` 全为空，
  包围盒就是两端连接点的外接矩形（`off=(3810000,1524000)`、`ext=(2540000,2794000)`），
  几何最直观、最可预期 —— 这正是 P-8 选 FS 用「右出 → 左入」的**间接旁证**。
- `com3-com1` / `com3-com3`（下→上、下→下）：`rot="5400000"`（90°）+ `flipV=1`；
- `com1-com1`（上→上）：`rot="16200000"`（270°）+ `flipH=1`。
  也就是说：**只要连接点落在水平边（上/下，`idx` 0/2）上，WPS 就会用 `rot`+`flip` 做旋转规范化**，
  读 `off`/`ext` 时**必须先看 `rot`/`flip`**，否则会把包围盒误当成端点坐标
  （遗留 2 的判读函数就是按这个前提写的）。
- 反过来说，**只有 `com4-com2`（右→左，两个站点都在竖边）是未旋转形态**：
  它的 `off`/`ext` 就等于两端连接点的外接矩形，走向可直接由 `off`/`ext` + `adj1` 还原 ——
  这正是 P-8 把 FS 定为「右出 → 左入」后**几何最可预期**的实测依据。
- 颜色属性的字节序提示（**与连接点无关，仅备注**）：脚本写 `Fill.ForeColor.RGB = 0x2E75B6`，
  落盘为 `<a:srgbClr val="B6752E"/>`（R/B 互换）。这是 .NET COM 互操作传 `RGB` 的已知字节序细节，
  两条 bar 仍可区分（`B6752E` = 橙、`0000C0` = 蓝）。**本实验的判据完全不依赖颜色**。

## 七、`id` 指认（证明 `stCxn/@id` 指的就是 `bar-a`）

| 组合 | `bar-a` 的 `cNvPr@id` | `bar-b` 的 `cNvPr@id` | `stCxn@id` | `endCxn@id` |
|---|---|---|---|---|
| `com1-com1` | 2 | 3 | 2 | 3 |
| `com3-com1` | 2 | 3 | 2 | 3 |
| `com4-com2` | 2 | 3 | 2 | 3 |
| `com3-com3` | 2 | 3 | 2 | 3 |

`stCxn/@id` 恒等于 `bar-a` 的 `id`、`endCxn/@id` 恒等于 `bar-b` 的 `id`，因此上表的 `idx` 可以无歧义地归因到「起点贴 bar-a 的哪条边 / 终点贴 bar-b 的哪条边」。

## 八、方法学备注（判据的强度）

1. **口径**：全部数字来自 WPS **自己落盘**的 `pptx` 解包结果，不是 COM 读回值。
   COM 侧只用来确认 `BeginConnected=True` / `EndConnected=True` 与形状名指纹。
2. **为什么不用 COM 读站点号**：`ConnectorFormat.BeginConnectedShape` 返回的是**形状**，
   不是站点号；WPS 上形状的 `ConnectionSite` 属性不可靠。**判据只用落盘 XML 的 `idx`**。
3. **可复现性**：每次生成前删掉旧 pptx；`slide1.xml` 以 LF 写入 `evidence/`；
   同一机器重跑，`idx` 与几何值稳定（pptx 容器字节数会因 zip 时间戳微抖，不影响证据）。

## 九、残留进程

运行前已有的 WPS 系进程：**8** 个（用户既有，脚本未创建它们）。
本次运行期间新出现且**运行结束时仍存活**：**1** 个。

| 进程 | PID | 启动时间 |
|---|---|---|
| `wps` | 105160 | 2026-10-04 01:17:15 |

`finally` 块已执行 `Presentations.Close` / `Application.Quit` / `ReleaseComObject` + `GC`；
剩余的 wps 进程很可能属于**用户既有的常驻 WPS 会话/云同步**（同一时刻另有 8 个用户既有 wps 进程）。
本脚本**不**强杀任何进程。

## 十、证据文件与重跑命令

> 重跑提示：`evidence/wps/P8-idx-com*-slide1.xml` 与上表所有 `idx` 值**逐字节稳定**；
> 但本 md 里含**采集时刻与 PID**（第二节、第九节），重跑会出现 diff —— 那是元信息，不是判据。

| 文件 | 角色 |
|---|---|
| `src/wps-connector-idx.ps1` | 采集脚本（WPS COM → pptx → 解包 XML） |
| `evidence/wps/P8-idx-com1-com1-slide1.xml` | `com1-com1` 的 `slide1.xml` 快照（原始落盘证据） |
| `evidence/wps/P8-idx-com3-com1-slide1.xml` | `com3-com1` 的 `slide1.xml` 快照（原始落盘证据） |
| `evidence/wps/P8-idx-com4-com2-slide1.xml` | `com4-com2` 的 `slide1.xml` 快照（原始落盘证据） |
| `evidence/wps/P8-idx-com3-com3-slide1.xml` | `com3-com3` 的 `slide1.xml` 快照（原始落盘证据） |
| `out/P8-idx-probe-records.json` | 采集结果 JSON（工件，不入库；报告的唯一数据源） |
| `evidence/wps-idx-probe.md` | 本文件 |

```powershell
# 全量四组合
pwsh -File spikes/g0-s4-svg-clipping/src/wps-connector-idx.ps1

# 只跑横向样本（右 → 左）
pwsh -File spikes/g0-s4-svg-clipping/src/wps-connector-idx.ps1 -BeginSite 4 -EndSite 2
```

## 十一、未验证项（如实记录）

- **其余引擎未验证**：本机 `soffice`（LibreOffice）不在 PATH、OnlyOffice 未安装，
  因此「`idx` 语义在 LibreOffice / OnlyOffice 是否同解」**本轮未测、不阻塞**（与裁决 P-4 同源）。
  本实验只证明 **WPS 口径**：`idx` 的语义即 preset geometry 的连接点序列，且 COM↔OOXML 相差 1。
- **COM 站点读回未作为判据**：见第八节第 2 条；因此本报告**不**断言任何 COM 侧站点号读取行为。
- **未覆盖**：`roundRect` 以外的 preset（如矩形、菱形）以及非预设连接点的索引分配规则。
