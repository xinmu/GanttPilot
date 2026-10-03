# P-8 遗留 2 · 「右出 → 左入」形态下的肘形复测（WPS 口径）

> 由 `pwsh -File src/wps-elbow-retest.ps1` 采集、`gen-wps-evidence.py` 生成。
> 
> **WPS 的 COM 自报名称是 `Microsoft PowerPoint`、版本 `12.0`**，这是**伪装字符串**，**不构成「用 Microsoft PowerPoint 验证过」的证据**（仓库已记录的陷阱）。按裁决 P-4，验证环境**以 WPS 为准、Microsoft PowerPoint 备查、不阻塞**。
> 
> **问题**：P-8 第 1 条把依赖线策略定为 **FS = 前置右出（`idx=3`）→ 后置左入（`idx=1`）**。
> S1 fixture 是「下出 → 上入」，**走向不能外推**；且 P-8 自己把「肘形走向跨引擎不保证」列为代价。
> 本实验在同一会话里造出右出→左入的肘形，并**量化**判读走线。

## 一、结论（WPS 口径）

**与预期一致**：`BeginConnect($barA, 4)` / `EndConnect($barB, 2)` 落盘为 `stCxn id=2 idx="3"`（右）/ `endCxn id=3 idx="1"`（左），
WPS 渲染出的是一条**未旋转、未翻转**的 `bentConnector3`：

```text
bar-a（右中点）── 水平引线向右 ──┐
                                │ 竖直段（x = 5080000 EMU = 两条参与边 x 的中值）
bar-b（左中点）── 水平引线向左 ──┘
```

- 水平引线方向：**向右**（Δx = 2540000 EMU > 0）
- 竖向段位置：x = **5080000** EMU = (3810000 + 6350000) / 2
- 全部 5 条判据通过：**✅ 通过**

**对 G4/G7 的意义**：把 FS 定为「右出 → 左入」后，WPS 给出的几何是
**唯一一组不需要旋转/翻转规范化**的形态（见遗留 1 报告第六节），水平引线与竖直段都能直接由 `off`/`ext` + `adj1` 读出。
这支持 P-8 第 1 条继续把该组合作为 FS 的默认策略；但**其余引擎本轮未验证**（见第八节）。

## 二、量化判读方法（不得目视，P-9 口径）

三路独立数据，互相比对：

| # | 数据源 | 读什么 |
|---|---|---|
| 1 | **COM**（落盘前） | `Shape.Left/Top/Width/Height`（单位 **pt**，`EMU = pt × 12700`） |
| 2 | **OOXML**（解包 `ppt/slides/slide1.xml`） | connector 的 `a:xfrm`（`off`/`ext`/`rot`/`flipH`/`flipV`）、`a:prstGeom@prst`、`a:gd[@name="adj1"]`、`a:stCxn@idx`、`a:endCxn@idx` |
| 3 | **几何定义**（不是经验猜测） | `bentConnector3` 的 preset 规则 |

**`bentConnector3` 的规则**（判据的来源）：起点沿**起点所在边**的外法线走一小段水平引线，
转到**中点竖线**，竖直到终点高度，再沿**终点所在边**的法线进入终点。因此：

- 两个连接点的 **y 不同**（type B）⇒ 走线 = 水平引线 + **1 段竖直** + 水平引线，
  竖直段 x = (起点边 x + 终点边 x) / 2；
- 两个连接点的 **y 相同**（type A）⇒ 竖直段长度 0，外观是**一条直线段**。

**关键前提（实测得出）**：WPS 会把「竖直走向」的肘形用 `rot` + `flip` **规范化**表示。
所以判读函数**先读 `rot`/`flip`**：`rot` 为空才按包围盒直接读走向；
非空则只做「端点反向变换回包围盒坐标系」的自洽性检查，不硬读走向。

## 三、逐组合原始证据（落盘 XML 片段）

```text
[com4-com2] 主判据：右出 → 左入（P-8 FS 形态） —— COM BeginConnect=4（右） / EndConnect=2（左）
  <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="3"/><a:endCxn id="3" idx="1"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="3810000" y="1524000"/><a:ext cx="2540000" cy="2794000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 50000"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

[com3-com3] 负对照 1：下出 → 下入（同页面，仅站点不同） —— COM BeginConnect=3（下） / EndConnect=3（下）
  <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="2"/><a:endCxn id="3" idx="2"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm rot="5400000" flipV="1"><a:off x="3683000" y="635000"/><a:ext cx="2794000" cy="5080000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 108523"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

[com2-com2] 负对照 2：左出 → 左入（同页面，仅站点不同） —— COM BeginConnect=2（左） / EndConnect=2（左）
  <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="dep-1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="1"/><a:endCxn id="3" idx="1"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm rot="10800000" flipH="1" flipV="1"><a:off x="1270000" y="1524000"/><a:ext cx="5080000" cy="2794000"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val -4687"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="50B000"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>

```

完整快照：`evidence/wps/P8-elbow-com*-slide1.xml`。

## 四、主判据：`com4-com2`（右出 → 左入）

### 4.1 输入几何（两端连接点由 `bar` 的 xfrm 推出）

| 项 | 值（EMU） |
|---|---|
| `bar-a` xfrm | off=(1270000, 1270000) ext=(2540000, 508000) |
| `bar-b` xfrm | off=(6350000, 4064000) ext=(2540000, 508000) |
| 起点连接点（`bar-a` idx=3 右） | (3810000, 1524000) |
| 终点连接点（`bar-b` idx=1 左） | (6350000, 4318000) |
| 期望包围盒 | off=(3810000, 1524000) ext=(2540000, 2794000) |
| 竖直段 x（两条参与边的中值） | 5080000 |

### 4.2 落盘的 connector

| 项 | 值 |
|---|---|
| `a:stCxn` | `id=2 idx=3`（右） |
| `a:endCxn` | `id=3 idx=1`（左） |
| `a:prstGeom@prst` | `bentConnector3` |
| `a:gd[adj1]` | `50000` |
| `a:xfrm@off` | (3810000, 1524000) |
| `a:xfrm@ext` | (2540000, 2794000) |
| `a:xfrm@rot` / `flipH` / `flipV` | `—` / `—` / `—` |
| `a:ln` 是否 `noFill` | False |

### 4.3 COM 与 OOXML 的交叉核对（证明 dump 就是这份 pptx）

| 量 | COM 读回（pt） | 换算 EMU（×12700） | OOXML（EMU） | 差 |
|---|---|---|---|---|
| `Left` / `off.x` | 300.0000 | 3810000 | 3810000 | 0 |
| `Top` / `off.y` | 120.0000 | 1524000 | 1524000 | 0 |
| `Width` / `ext.cx` | 200.0000 | 2540000 | 2540000 | 0 |
| `Height` / `ext.cy` | 220.0000 | 2794000 | 2794000 | 0 |

COM 侧 `BeginConnected` = `True`（形状指纹 `bar-a`）、`EndConnected` = `True`（`bar-b`）。

### 4.4 判据与数值（全部为 EMU 整数比较，无目视成分）

| # | 判据 | 结果 | 实测数值 |
|---|---|---|---|
| 1 | 起点为右边（idx=3）且终点在其右侧 ⇒ 水平引线向右 | ✅ 通过 | 起点边 idx=3（右）@x=3810000；终点 x=6350000；Δx=2540000 EMU |
| 2 | 终点为左边（idx=1）且位于起点右侧 ⇒ 自左方进入 | ✅ 通过 | 终点边 idx=1（左）@x=6350000；起点 x=3810000 |
| 3 | 包围盒 == 两端连接点推出的期望框（未旋转） | ✅ 通过 | 实测 off=(3810000,1524000) ext=(2540000,2794000)；期望 off=(3810000,1524000) ext=(2540000,2794000) |
| 4 | 走线类型与几何自洽 | ✅ 通过 | type=B（起终点 y：1524000 / 4318000）；preset=bentConnector3 ext=(2540000,2794000) adj1=50000（未旋转） |
| 5 | 竖直段 x = 两条参与边的中值（未旋转） | ✅ 通过 | 参与边 x：起点边 3810000，终点边 6350000 → 中值 5080000；包围盒 x ∈ [3810000, 6350000] |

**判读结论（由数值推出）**：水平引线（x 3810000→5080000，y=1524000）→ 竖直段（x=5080000，y 1524000→4318000）→ 水平引线（x 5080000→6350000)；竖直段在下方（flipV 缺省）

**判据全通过：是**（5/5）。

## 五、判别力对照（负对照）

同一对 `bar`、同一页面、同一个脚本，**只改 COM 站点**：

| 组合 | 落盘 `idx` | `rot`/`flip` | 判据全通过 | 说明 |
|---|---|---|---|---|
| `com4-com2` | stCxn=3（右）/ endCxn=1（左） | `—` / `—` | 是 | 主判据：右出 → 左入（P-8 FS 形态） |
| `com3-com3` | stCxn=2（下）/ endCxn=2（下） | `5400000` / `flipV` | 否 | 负对照 1：下出 → 下入（同页面，仅站点不同） |
| `com2-com2` | stCxn=1（左）/ endCxn=1（左） | `10800000` / `flipH+flipV` | 否 | 负对照 2：左出 → 左入（同页面，仅站点不同） |

**为什么这组对照有意义**：只有 `com4-com2` 全部通过。`com2-com2`（左出 → 左入）
能通过「终点为左边」这一条，但**过不了「起点为右边」**；`com3-com3`（下出 → 下入）
两条主判据都过不了，而且 WPS 用 `rot=5400000 + flipV=1` 表示它，走线在包围盒坐标里不可直读。
⇒ 上面这套判据**不是恒真的空判据**。

### 5.1 三组判据明细

#### `com4-com2`（主判据：右出 → 左入（P-8 FS 形态））

| 判据 | 结果 | 实测 |
|---|---|---|
| 起点为右边（idx=3）且终点在其右侧 ⇒ 水平引线向右 | ✅ 通过 | 起点边 idx=3（右）@x=3810000；终点 x=6350000；Δx=2540000 EMU |
| 终点为左边（idx=1）且位于起点右侧 ⇒ 自左方进入 | ✅ 通过 | 终点边 idx=1（左）@x=6350000；起点 x=3810000 |
| 包围盒 == 两端连接点推出的期望框（未旋转） | ✅ 通过 | 实测 off=(3810000,1524000) ext=(2540000,2794000)；期望 off=(3810000,1524000) ext=(2540000,2794000) |
| 走线类型与几何自洽 | ✅ 通过 | type=B（起终点 y：1524000 / 4318000）；preset=bentConnector3 ext=(2540000,2794000) adj1=50000（未旋转） |
| 竖直段 x = 两条参与边的中值（未旋转） | ✅ 通过 | 参与边 x：起点边 3810000，终点边 6350000 → 中值 5080000；包围盒 x ∈ [3810000, 6350000] |

#### `com3-com3`（负对照 1：下出 → 下入（同页面，仅站点不同））

| 判据 | 结果 | 实测 |
|---|---|---|
| 起点为右边（idx=3）且终点在其右侧 ⇒ 水平引线向右 | ❌ 不通过 | 起点边 idx=2（下）@x=2540000；终点 x=7620000；Δx=5080000 EMU |
| 终点为左边（idx=1）且位于起点右侧 ⇒ 自左方进入 | ❌ 不通过 | 终点边 idx=2（下）@x=7620000；起点 x=2540000 |
| 端点反向旋转后落在包围盒内（旋转情形，自洽性检查） | ❌ 不通过 | rot=5400000 flipH='' flipV='1'；包围盒 off=(3683000,635000) ext=(2794000,5080000)；(2540000,1778000)→(1778000,4572000)[出框]，(7620000,4572000)→(4572000,1778000)[在框内] |
| 走线类型与几何自洽 | ✅ 通过 | type=B（起终点 y：1778000 / 4572000）；preset=bentConnector3 ext=(2794000,5080000) adj1=108523（rot=5400000 flipV=1） |

#### `com2-com2`（负对照 2：左出 → 左入（同页面，仅站点不同））

| 判据 | 结果 | 实测 |
|---|---|---|
| 起点为右边（idx=3）且终点在其右侧 ⇒ 水平引线向右 | ❌ 不通过 | 起点边 idx=1（左）@x=1270000；终点 x=6350000；Δx=5080000 EMU |
| 终点为左边（idx=1）且位于起点右侧 ⇒ 自左方进入 | ✅ 通过 | 终点边 idx=1（左）@x=6350000；起点 x=1270000 |
| 端点反向旋转后落在包围盒内（旋转情形，自洽性检查） | ✅ 通过 | rot=10800000 flipH='1' flipV='1'；包围盒 off=(1270000,1524000) ext=(5080000,2794000)；(1270000,1524000)→(1270000,1524000)[在框内]，(6350000,4318000)→(6350000,4318000)[在框内] |
| 走线类型与几何自洽 | ✅ 通过 | type=B（起终点 y：1524000 / 4318000）；preset=bentConnector3 ext=(5080000,2794000) adj1=-4687（rot=10800000 flipH=1 flipV=1） |

## 六、同页对照样本：`ctrl-com1-com1`（COM 1 → 1）

每组都额外吸附了一条 `ctrl-com1-com1`（COM `1 → 1`：`bar-a` 上边中点 → `bar-b` 上边中点）。
**它不是为了验证右出/左入**，而是用来暴露两个方法学事实：
（a）判据确实随站点变化；（b）`prst="line"` 不是可靠的退化判据。

| 项 | 值 |
|---|---|
| 落盘 `stCxn` / `endCxn` | `idx=0`（上） / `idx=0`（上） |
| 两端连接点（由 bar 的 xfrm 推出） | (2540000, 1270000) → (7620000, 4064000)；**y 不同**（差值 2794000 EMU） |
| `prstGeom` | `bentConnector3`（**未**退化为 `line`） |
| `adj1` | `-8523`（**负值**） |
| `xfrm` | off=(3683000, 127000) ext=(2794000, 5080000) `rot=16200000` `flipH=1` `flipV=—` |
| `a:ln` 是否 `noFill` | False |
| 判据结果 | 起点为右边（idx=3）且终点在其右侧 ⇒ 水平引线向右 → ❌ 不通过；终点为左边（idx=1）且位于起点右侧 ⇒ 自左方进入 → ❌ 不通过；端点反向旋转后落在包围盒内（旋转情形，自洽性检查） → ❌ 不通过；走线类型与几何自洽 → ✅ 通过 |

- 判读：WPS 用规范化表示（rot=16200000 flipH=1）：原始 bentConnector3 的水平引线/竖直段被整体旋转，不能直接按包围盒读；端点仍在 (2540000,1270000) → (7620000,4064000)

**观察（如实记录，两条）**：

1. 这条对照连接的**两个连接点 y 并不相同**（在两个连接点分别落在两条 bar 的**上边**时，
   y 分别是两条 bar 的上边 y，而两条 bar 位于不同行），所以它**不是**退化直线，
   是一条 y 跨度 2794000 EMU 的「Z 形」肘线；
   WPS 用 `rot` + `flip` 规范化它。⇒ 本次实验中**没有**出现「起终点 y 完全相同」的样本，
   因此「WPS 在退化情形下写什么」**本轮未测**，不作结论。
2. 即便如此也能确认一点：该连接**没有**被写成 `prst="line"`，`a:ln` 也没有 `noFill`，
   而是 `bentConnector3` + 负 `adj1`（`-8523`）。⇒ 用 `prst` 名判断退化**不可靠**，
   判断退化应当用数值（两端点 y 是否相同、`ext` 是否等于端点包围盒）。

这一节是**旁证与方法学备注**，不参与 P-8 的主判据。

## 七、WPS 口径结论（可直接引用的三条）

1. **右出 → 左入的肘形在 WPS 下与预期一致**：落盘 `idx=3`/`idx=1`，
   几何**未旋转/未翻转**，水平引线向右、竖直段落在两条参与边 x 的中值处。
2. **走线方向为竖直（`rot` 非空）时，WPS 用 `rot` + `flip` 规范化表示**
   （本次实测到 `rot=5400000`/`10800000`/`16200000` 三种 + 相应 `flip`）；
   因此 G7 还原几何时**必须先读 `rot`/`flip`**，不能只读 `off`/`ext`。
3. **负 `adj1` 与旋转规范化是常态，不是异常**（本次 4 条非主判据连线里 3 条 `rot` 非空、
   2 条 `adj1` 为负）；因此**不要**用「`adj1` 是否 50000」「`prst` 是否 `line`」这类形态特征
   反推语义，应当用 `stCxn/endCxn@idx` + 端点几何这类**语义判据**。

## 八、未验证项（明确标注）

- **其余引擎本轮未验证、不阻塞**：本机 **LibreOffice（`soffice`）不在 PATH**、
  **OnlyOffice 未安装**（已核实），因此本报告的结论**只代表 WPS 口径**。
  这与裁决 **P-4**（验证环境以 WPS 为准、PowerPoint 备查、不阻塞）同源；
  P-8 第 4 条已记录「临时探针显示 OnlyOffice 在肘形走向上偏离 WPS」，本轮**未复测**。
- **Microsoft PowerPoint 未验证**：只有 WPS COM（自报 `Name="Microsoft PowerPoint"`，属伪装字符串）。
- **未覆盖**：同侧多线分道 / 避让（P-8 遗留 3）、`bentConnector2/4` 的 `adj` 语义、
  长距离回绕与 stub 长度策略（P-8 第 2 条把 stub 长度交给 G4 的 SVG 正交路由器）。

## 九、残留进程

运行前已有的 WPS 系进程：**8** 个（用户既有）。
本次运行期间新出现且**运行结束时仍存活**：**1** 个。

| 进程 | PID | 启动时间 |
|---|---|---|
| `wps` | 84568 | 2026-10-04 01:17:42 |

同上：`finally` 已 `Close`/`Quit`/`ReleaseComObject` + `GC`；脚本不强杀进程。

## 十、证据文件与重跑命令

> 重跑提示：`evidence/wps/P8-elbow-com*-slide1.xml` 与上表所有 `idx`/数值**逐字节稳定**；
> 但本 md 里含**采集时刻与 PID**（第九节），重跑会出现 diff —— 那是元信息，不是判据。

| 文件 | 角色 |
|---|---|
| `src/wps-elbow-retest.ps1` | 采集 + 量化判读脚本 |
| `evidence/wps/P8-elbow-com4-com2-slide1.xml` | `com4-com2` 的 `slide1.xml` 快照 |
| `evidence/wps/P8-elbow-com3-com3-slide1.xml` | `com3-com3` 的 `slide1.xml` 快照 |
| `evidence/wps/P8-elbow-com2-com2-slide1.xml` | `com2-com2` 的 `slide1.xml` 快照 |
| `out/P8-elbow-records.json` | 采集结果 JSON（工件，不入库） |
| `evidence/wps/elbow-retest.md` | 本文件 |

```powershell
# 主判据 + 两组负对照 + 同页对照
pwsh -File spikes/g0-s4-svg-clipping/src/wps-elbow-retest.ps1

# 只跑主判据
pwsh -File spikes/g0-s4-svg-clipping/src/wps-elbow-retest.ps1 -MainOnly

# 指定站点
pwsh -File spikes/g0-s4-svg-clipping/src/wps-elbow-retest.ps1 -BeginSite 4 -EndSite 2
```
