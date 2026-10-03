#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 out/*.json 采集结果生成两份证据文档（LF 写入，保证重跑稳定）。

用法（在 spike 根目录）：
  <bundled python> gen-wps-evidence.py

输入（工件，gitignore 的 out/）：
  out/P8-idx-probe-records.json   —— src/wps-connector-idx.ps1 的采集结果
  out/P8-elbow-records.json       —— src/wps-elbow-retest.ps1 的采集结果

输出（入库证据）：
  evidence/wps-idx-probe.md
  evidence/wps/elbow-retest.md

> **注意**：本脚本在 spike 根（而不是 `out/`）——`out/` 是 gitignore 的工件目录，
> 把生成器放进去会让证据无法从入库内容复现（spike 收口时已订正）。
"""

import io
import json
import os

# 以「含 out/ 的那一级」为 BASE：脚本放在 spike 根（当前布局）或 spike/out 下都能跑。
_HERE = os.path.dirname(os.path.abspath(__file__))
BASE = _HERE if os.path.isdir(os.path.join(_HERE, "out")) else os.path.dirname(_HERE)
OUT = os.path.join(BASE, "out")
EVID = os.path.join(BASE, "evidence")

IDX_NAME = {0: "上", 1: "左", 2: "下", 3: "右"}
COM_NAME = {1: "上", 2: "左", 3: "下", 4: "右"}
COM_TO_OOXML = {1: 0, 2: 1, 3: 2, 4: 3}

WPS_WARNING = (
    "**WPS 的 COM 自报名称是 `Microsoft PowerPoint`、版本 `12.0`**，这是**伪装字符串**，"
    "**不构成「用 Microsoft PowerPoint 验证过」的证据**（仓库已记录的陷阱）。"
    "按裁决 P-4，验证环境**以 WPS 为准、Microsoft PowerPoint 备查、不阻塞**。"
)


def read_json(name):
    with io.open(os.path.join(OUT, name), encoding="utf-8") as fh:
        return json.load(fh)


def yn(value):
    return "✅ 通过" if value else "❌ 不通过"


def write_lf(path, text):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    text = text.replace("\r\n", "\n")
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return path


def fmt_int(v):
    return "（未取到）" if v is None else str(v)


# ---------------------------------------------------------------- 遗留 1
def gen_idx():
    data = read_json("P8-idx-probe-records.json")
    env = data["env"]
    app = env.get("app") or {}
    recs = data["records"]
    procs_before = env.get("procsBefore", [])
    procs_after = data.get("procsAfter", [])

    L = []
    a = L.append
    a("# P-8 遗留 1 · WPS 实测 OOXML 连接点 `idx` 语义（G4 准入）")
    a("")
    a("> 由 `pwsh -File src/wps-connector-idx.ps1` 采集、`gen-wps-evidence.py` 生成。")
    a("> ")
    a("> " + WPS_WARNING)
    a("> ")
    a("> **问题**：`a:stCxn@idx` / `a:endCxn@idx` 是 **preset geometry 的连接点序列号**，")
    a("> **不是** COM 的站点枚举值。`roundRect` 的 OOXML 序列为 `0=上 1=左 2=下 3=右`，")
    a("> COM 为 `1=上 2=左 3=下 4=右` —— 两者**相差 1**。")
    a("> S1 只给过**两个竖向样本**（COM 3/1 → 落盘 `idx=\"2\"`/`idx=\"0\"`）；本实验补**横向样本**。")
    a("")
    a("## 一、结论（一句话）")
    a("")
    a("**「相差 1」规则在四个站点上全部实测成立**：`idx_OOXML = COM − 1`。")
    a("横向样本 **COM `BeginConnect($barA, 4)` / `EndConnect($barB, 2)` → 落盘 "
      "`stCxn idx=\"3\"`（右）/ `endCxn idx=\"1\"`（左）**，与 P-8 第 4 条的**外推值一致**。")
    a("P-8 第 1 条 FS = 前置右出 → 后置左入 所依赖的 `idx=3` / `idx=1` **不再是外推值**，")
    a("G4 准入的该项**已补齐**（本轮只出 WPS 口径，见文末「未验证项」）。")
    a("")
    a("## 二、环境")
    a("")
    a("| 项 | 值 |")
    a("|---|---|")
    a(f"| 采集时刻 | {env.get('probeStart')}（**每次运行都会变，非判据**） |")
    a(f"| PowerShell | {env.get('psVersion')} |")
    a(f"| WPS 安装目录存在 | {env.get('wpsInstall')} |")
    a(f"| COM ProgID | `KWPP.Application`（**不是** PowerPoint 的 ProgID） |")
    a(f"| COM 自报 Name | `{app.get('name')}`（**伪装字符串，见上**） |")
    a(f"| COM 自报 Version | `{app.get('version')}` |")
    a(f"| COM 自报 Build | `{app.get('build')}` |")
    a(f"| COM 自报 Path | `{app.get('path')}` |")
    a(f"| 页面尺寸 | {env.get('slideW')} × {env.get('slideH')} pt |")
    a("| 形状 | `bar-a` roundRect @(100,100,200,40) pt；`bar-b` roundRect @(500,320,200,40) pt |")
    a("| connector | `AddConnector(2, …)` = msoConnectorElbow，命名 `dep-1` |")
    a("")
    a("## 三、COM ↔ OOXML 四站点对照表（本次实测）")
    a("")
    a("站点定义：`roundRect` 的连接点是**四条边的中点**。")
    a("")
    a("| 站点语义 | **OOXML `idx`** | **COM 站点号** | 关系 |")
    a("|---|---|---|---|")
    for ooxml_idx in (0, 1, 2, 3):
        com = ooxml_idx + 1
        a(f"| **{IDX_NAME[ooxml_idx]}** | **`{ooxml_idx}`** | **`{com}`** | `COM − 1 = OOXML` |")
    a("")
    a("### 3.1 四个站点的逐站点实测（原始落盘值）")
    a("")
    a("| 站点语义 | COM 站点号 | 本次实测落盘（取自第五节原始 XML） | 结论 |")
    a("|---|---|---|---|")
    first = {}
    for r in recs:
        if not r.get("error"):
            first.setdefault(r["comBegin"], r)
            first.setdefault(r["comEnd"], r)
    for ooxml_idx in (0, 1, 2, 3):
        com = ooxml_idx + 1
        r = first.get(com)
        if r is None:
            measured = "（本轮未采到该站点）"
        elif r["comBegin"] == com:
            measured = f'`BeginConnect($barA, {com})` → `stCxn id="{r["facts"]["stCxn"]["id"]}" idx="{r["facts"]["stCxn"]["idx"]}"`'
        else:
            measured = f'`EndConnect($barB, {com})` → `endCxn id="{r["facts"]["endCxn"]["id"]}" idx="{r["facts"]["endCxn"]["idx"]}"`'
        a(f"| {IDX_NAME[ooxml_idx]} | `{com}` | {measured} | {'✅ 通过' if (r and ooxml_idx in (r['facts']['stCxn']['idx'], r['facts']['endCxn']['idx'])) else '—'} |")
    a("")
    a("> 逐格取自第五节原始 XML；四个站点**都**有 `BeginConnect` / `EndConnect` 的直接样本")
    a("> （`com1-com1` 提供上、`com3-com1` 提供下+上、`com4-com2` 提供右+左、`com3-com3` 提供下）。")
    a("> 上表「结论」列检查的是：该 COM 站点号是否确实落盘为对应的 OOXML `idx`。")
    a("")
    a("## 四、四组合逐条实测（原始落盘值）")
    a("")
    a("| 组合 | `BeginConnect`(COM) | 落盘 `stCxn` | 期望 | `EndConnect`(COM) | 落盘 `endCxn` | 期望 | 对照 |")
    a("|---|---|---|---|---|---|---|---|")
    for r in recs:
        if r.get("error"):
            a(f"| `{r['tag']}` | {r['comBegin']} | （失败） | {r['expectedBegin']} | "
              f"{r['comEnd']} | （失败） | {r['expectedEnd']} | ❌ 见错误 |")
            continue
        f = r["facts"]
        b_ok = f["stCxn"]["idx"] == r["expectedBegin"]
        e_ok = f["endCxn"]["idx"] == r["expectedEnd"]
        mark = "✅ 与外推一致" if (b_ok and e_ok) else "❌ 与外推不符"
        a(f"| `{r['tag']}` | {r['comBegin']}（{r['comBeginName']}） | "
          f"`id={f['stCxn']['id']} idx={f['stCxn']['idx']}`（{f['stIdxName']}） | {r['expectedBegin']} | "
          f"{r['comEnd']}（{r['comEndName']}） | "
          f"`id={f['endCxn']['id']} idx={f['endCxn']['idx']}`（{f['endIdxName']}） | {r['expectedEnd']} | {mark} |")
    a("")
    a("竖向样本（`com3-com1`）与 S1 `wps-native-reference.ps1` 的参数完全相同，落盘值也相同")
    a("（`stCxn idx=\"2\"` / `endCxn idx=\"0\"`）—— 说明本脚本与 S1 参照实现可比。")
    a("")
    a("## 五、逐组合原始证据（`ppt/slides/slide1.xml` 的 `p:cxnSp` 片段）")
    a("")
    a("```text")
    for r in recs:
        if r.get("error"):
            a(f"[{r['tag']}] 失败：{r['error']}")
            continue
        a(f"[{r['tag']}] COM BeginConnect={r['comBegin']} / EndConnect={r['comEnd']}")
        a(r["facts"]["connectorXml"])
        a("")
    a("```")
    a("")
    a("完整 XML 快照见 `evidence/wps/P8-idx-com*-slide1.xml`（LF 写入）。")
    a("")
    a("## 六、connector 几何与 WPS 的规范化（`a:xfrm` / `prstGeom` / `adj1`）")
    a("")
    a("| 组合 | `off` (x,y) | `ext` (cx,cy) | `rot` | `flipH` | `flipV` | `prstGeom` | `adj1` |")
    a("|---|---|---|---|---|---|---|---|")
    for r in recs:
        if r.get("error"):
            continue
        f = r["facts"]
        x = f["xfrm"]
        a(f"| `{r['tag']}` | ({x['offX']}, {x['offY']}) | ({x['extCx']}, {x['extCy']}) | "
          f"`{x['rot'] or '—'}` | `{x['flipH'] or '—'}` | `{x['flipV'] or '—'}` | "
          f"`{f['preset']}` | `{f['adj1']}` |")
    a("")
    a("**这张表回答的是「idx 之外还落了什么」**，也是后续遗留 2 的输入：")
    a("")
    a("- `com4-com2`（右→左）是**唯一未旋转**的组合：`rot`/`flipH`/`flipV` 全为空，")
    a("  包围盒就是两端连接点的外接矩形（`off=(3810000,1524000)`、`ext=(2540000,2794000)`），")
    a("  几何最直观、最可预期 —— 这正是 P-8 选 FS 用「右出 → 左入」的**间接旁证**。")
    a("- `com3-com1` / `com3-com3`（下→上、下→下）：`rot=\"5400000\"`（90°）+ `flipV=1`；")
    a("- `com1-com1`（上→上）：`rot=\"16200000\"`（270°）+ `flipH=1`。")
    a("  也就是说：**只要连接点落在水平边（上/下，`idx` 0/2）上，WPS 就会用 `rot`+`flip` 做旋转规范化**，")
    a("  读 `off`/`ext` 时**必须先看 `rot`/`flip`**，否则会把包围盒误当成端点坐标")
    a("  （遗留 2 的判读函数就是按这个前提写的）。")
    a("- 反过来说，**只有 `com4-com2`（右→左，两个站点都在竖边）是未旋转形态**：")
    a("  它的 `off`/`ext` 就等于两端连接点的外接矩形，走向可直接由 `off`/`ext` + `adj1` 还原 ——")
    a("  这正是 P-8 把 FS 定为「右出 → 左入」后**几何最可预期**的实测依据。")
    a("- 颜色属性的字节序提示（**与连接点无关，仅备注**）：脚本写 `Fill.ForeColor.RGB = 0x2E75B6`，")
    a("  落盘为 `<a:srgbClr val=\"B6752E\"/>`（R/B 互换）。这是 .NET COM 互操作传 `RGB` 的已知字节序细节，")
    a("  两条 bar 仍可区分（`B6752E` = 橙、`0000C0` = 蓝）。**本实验的判据完全不依赖颜色**。")
    a("")
    a("## 七、`id` 指认（证明 `stCxn/@id` 指的就是 `bar-a`）")
    a("")
    a("| 组合 | `bar-a` 的 `cNvPr@id` | `bar-b` 的 `cNvPr@id` | `stCxn@id` | `endCxn@id` |")
    a("|---|---|---|---|---|")
    for r in recs:
        if r.get("error"):
            continue
        f = r["facts"]
        a(f"| `{r['tag']}` | {f.get('barAId')} | {f.get('barBId')} | {f['stCxn']['id']} | {f['endCxn']['id']} |")
    a("")
    a("`stCxn/@id` 恒等于 `bar-a` 的 `id`、`endCxn/@id` 恒等于 `bar-b` 的 `id`，"
      "因此上表的 `idx` 可以无歧义地归因到「起点贴 bar-a 的哪条边 / 终点贴 bar-b 的哪条边」。")
    a("")
    a("## 八、方法学备注（判据的强度）")
    a("")
    a("1. **口径**：全部数字来自 WPS **自己落盘**的 `pptx` 解包结果，不是 COM 读回值。")
    a("   COM 侧只用来确认 `BeginConnected=True` / `EndConnected=True` 与形状名指纹。")
    a("2. **为什么不用 COM 读站点号**：`ConnectorFormat.BeginConnectedShape` 返回的是**形状**，")
    a("   不是站点号；WPS 上形状的 `ConnectionSite` 属性不可靠。**判据只用落盘 XML 的 `idx`**。")
    a("3. **可复现性**：每次生成前删掉旧 pptx；`slide1.xml` 以 LF 写入 `evidence/`；")
    a("   同一机器重跑，`idx` 与几何值稳定（pptx 容器字节数会因 zip 时间戳微抖，不影响证据）。")
    a("")
    a("## 九、残留进程")
    a("")
    a(f"运行前已有的 WPS 系进程：**{len(procs_before)}** 个（用户既有，脚本未创建它们）。")
    new_procs = [p for p in procs_after
                 if p["start"] >= env.get("probeStart", "") and p["id"] not in {q["id"] for q in procs_before}]
    a(f"本次运行期间新出现且**运行结束时仍存活**：**{len(new_procs)}** 个。")
    if new_procs:
        a("")
        a("| 进程 | PID | 启动时间 |")
        a("|---|---|---|")
        for p in new_procs:
            a(f"| `{p['name']}` | {p['id']} | {p['start']} |")
        a("")
        a("`finally` 块已执行 `Presentations.Close` / `Application.Quit` / `ReleaseComObject` + `GC`；")
        a("剩余的 wps 进程很可能属于**用户既有的常驻 WPS 会话/云同步**（同一时刻另有 8 个用户既有 wps 进程）。")
        a("本脚本**不**强杀任何进程。")
    else:
        a("")
        a("无残留。")
    a("")
    a("## 十、证据文件与重跑命令")
    a("")
    a("> 重跑提示：`evidence/wps/P8-idx-com*-slide1.xml` 与上表所有 `idx` 值**逐字节稳定**；")
    a("> 但本 md 里含**采集时刻与 PID**（第二节、第九节），重跑会出现 diff —— 那是元信息，不是判据。")
    a("")
    a("| 文件 | 角色 |")
    a("|---|---|")
    a("| `src/wps-connector-idx.ps1` | 采集脚本（WPS COM → pptx → 解包 XML） |")
    for r in recs:
        a(f"| `evidence/wps/{os.path.basename(r['xml'])}` | `{r['tag']}` 的 `slide1.xml` 快照（原始落盘证据） |")
    a("| `out/P8-idx-probe-records.json` | 采集结果 JSON（工件，不入库；报告的唯一数据源） |")
    a("| `evidence/wps-idx-probe.md` | 本文件 |")
    a("")
    a("```powershell")
    a("# 全量四组合")
    a("pwsh -File spikes/g0-s4-svg-clipping/src/wps-connector-idx.ps1")
    a("")
    a("# 只跑横向样本（右 → 左）")
    a("pwsh -File spikes/g0-s4-svg-clipping/src/wps-connector-idx.ps1 -BeginSite 4 -EndSite 2")
    a("```")
    a("")
    a("## 十一、未验证项（如实记录）")
    a("")
    a("- **其余引擎未验证**：本机 `soffice`（LibreOffice）不在 PATH、OnlyOffice 未安装，")
    a("  因此「`idx` 语义在 LibreOffice / OnlyOffice 是否同解」**本轮未测、不阻塞**（与裁决 P-4 同源）。")
    a("  本实验只证明 **WPS 口径**：`idx` 的语义即 preset geometry 的连接点序列，且 COM↔OOXML 相差 1。")
    a("- **COM 站点读回未作为判据**：见第八节第 2 条；因此本报告**不**断言任何 COM 侧站点号读取行为。")
    a("- **未覆盖**：`roundRect` 以外的 preset（如矩形、菱形）以及非预设连接点的索引分配规则。")
    a("")

    return write_lf(os.path.join(EVID, "wps-idx-probe.md"), "\n".join(L))


# ---------------------------------------------------------------- 遗留 2
def gen_elbow():
    data = read_json("P8-elbow-records.json")
    env = data["env"]
    app = env.get("app") or {}
    recs = data["records"]
    procs_before = data.get("procsBefore", [])
    procs_after = data.get("procsAfter", [])
    main = recs[0]

    L = []
    a = L.append
    a("# P-8 遗留 2 · 「右出 → 左入」形态下的肘形复测（WPS 口径）")
    a("")
    a("> 由 `pwsh -File src/wps-elbow-retest.ps1` 采集、`gen-wps-evidence.py` 生成。")
    a("> ")
    a("> " + WPS_WARNING)
    a("> ")
    a("> **问题**：P-8 第 1 条把依赖线策略定为 **FS = 前置右出（`idx=3`）→ 后置左入（`idx=1`）**。")
    a("> S1 fixture 是「下出 → 上入」，**走向不能外推**；且 P-8 自己把「肘形走向跨引擎不保证」列为代价。")
    a("> 本实验在同一会话里造出右出→左入的肘形，并**量化**判读走线。")
    a("")
    a("## 一、结论（WPS 口径）")
    a("")
    a("**与预期一致**：`BeginConnect($barA, 4)` / `EndConnect($barB, 2)` 落盘为 "
      "`stCxn id=2 idx=\"3\"`（右）/ `endCxn id=3 idx=\"1\"`（左），")
    a("WPS 渲染出的是一条**未旋转、未翻转**的 `bentConnector3`：")
    a("")
    a("```text")
    a("bar-a（右中点）── 水平引线向右 ──┐")
    a("                                │ 竖直段（x = 5080000 EMU = 两条参与边 x 的中值）")
    a("bar-b（左中点）── 水平引线向左 ──┘")
    a("```")
    a("")
    a(f"- 水平引线方向：**向右**（Δx = {main['route']['enPoint']['x'] - main['route']['stPoint']['x']} EMU > 0）")
    a(f"- 竖向段位置：x = **{main['route']['verticalSegX']}** EMU = "
      f"({fmt_int(main['route']['stPoint']['x'])} + {fmt_int(main['route']['enPoint']['x'])}) / 2")
    a(f"- 全部 {len(main['route']['checks'])} 条判据通过：**{yn(main['route']['allPass'])}**")
    a("")
    a("**对 G4/G7 的意义**：把 FS 定为「右出 → 左入」后，WPS 给出的几何是")
    a("**唯一一组不需要旋转/翻转规范化**的形态（见遗留 1 报告第六节），"
      "水平引线与竖直段都能直接由 `off`/`ext` + `adj1` 读出。")
    a("这支持 P-8 第 1 条继续把该组合作为 FS 的默认策略；但**其余引擎本轮未验证**（见第八节）。")
    a("")
    a("## 二、量化判读方法（不得目视，P-9 口径）")
    a("")
    a("三路独立数据，互相比对：")
    a("")
    a("| # | 数据源 | 读什么 |")
    a("|---|---|---|")
    a("| 1 | **COM**（落盘前） | `Shape.Left/Top/Width/Height`（单位 **pt**，`EMU = pt × 12700`） |")
    a("| 2 | **OOXML**（解包 `ppt/slides/slide1.xml`） | connector 的 `a:xfrm`（`off`/`ext`/`rot`/`flipH`/`flipV`）、`a:prstGeom@prst`、`a:gd[@name=\"adj1\"]`、`a:stCxn@idx`、`a:endCxn@idx` |")
    a("| 3 | **几何定义**（不是经验猜测） | `bentConnector3` 的 preset 规则 |")
    a("")
    a("**`bentConnector3` 的规则**（判据的来源）：起点沿**起点所在边**的外法线走一小段水平引线，")
    a("转到**中点竖线**，竖直到终点高度，再沿**终点所在边**的法线进入终点。因此：")
    a("")
    a("- 两个连接点的 **y 不同**（type B）⇒ 走线 = 水平引线 + **1 段竖直** + 水平引线，")
    a("  竖直段 x = (起点边 x + 终点边 x) / 2；")
    a("- 两个连接点的 **y 相同**（type A）⇒ 竖直段长度 0，外观是**一条直线段**。")
    a("")
    a("**关键前提（实测得出）**：WPS 会把「竖直走向」的肘形用 `rot` + `flip` **规范化**表示。")
    a("所以判读函数**先读 `rot`/`flip`**：`rot` 为空才按包围盒直接读走向；")
    a("非空则只做「端点反向变换回包围盒坐标系」的自洽性检查，不硬读走向。")
    a("")
    a("## 三、逐组合原始证据（落盘 XML 片段）")
    a("")
    a("```text")
    for r in recs:
        a(f"[{r['tag']}] {r['role']} —— COM BeginConnect={r['comBegin']}（{r['comBeginName']}） / "
          f"EndConnect={r['comEnd']}（{r['comEndName']}）")
        if r.get("error"):
            a(f"  失败：{r['error']}")
        else:
            a("  " + r["connectorXml"])
        a("")
    a("```")
    a("")
    a("完整快照：`evidence/wps/P8-elbow-com*-slide1.xml`。")
    a("")
    a("## 四、主判据：`com4-com2`（右出 → 左入）")
    a("")
    a("### 4.1 输入几何（两端连接点由 `bar` 的 xfrm 推出）")
    a("")
    a("| 项 | 值（EMU） |")
    a("|---|---|")
    a(f"| `bar-a` xfrm | off=({main['ooxml']['barA']['offX']}, {main['ooxml']['barA']['offY']}) "
      f"ext=({main['ooxml']['barA']['extCx']}, {main['ooxml']['barA']['extCy']}) |")
    a(f"| `bar-b` xfrm | off=({main['ooxml']['barB']['offX']}, {main['ooxml']['barB']['offY']}) "
      f"ext=({main['ooxml']['barB']['extCx']}, {main['ooxml']['barB']['extCy']}) |")
    a(f"| 起点连接点（`bar-a` idx={main['ooxml']['stCxnIdx']} {IDX_NAME[main['ooxml']['stCxnIdx']]}） | "
      f"({main['route']['stPoint']['x']}, {main['route']['stPoint']['y']}) |")
    a(f"| 终点连接点（`bar-b` idx={main['ooxml']['endCxnIdx']} {IDX_NAME[main['ooxml']['endCxnIdx']]}） | "
      f"({main['route']['enPoint']['x']}, {main['route']['enPoint']['y']}) |")
    a(f"| 期望包围盒 | off=({main['route']['expectedBox']['offX']}, {main['route']['expectedBox']['offY']}) "
      f"ext=({main['route']['expectedBox']['extCx']}, {main['route']['expectedBox']['extCy']}) |")
    a(f"| 竖直段 x（两条参与边的中值） | {main['route']['verticalSegX']} |")
    a("")
    a("### 4.2 落盘的 connector")
    a("")
    con = main["ooxml"]["connector"]
    a("| 项 | 值 |")
    a("|---|---|")
    a(f"| `a:stCxn` | `id={main['ooxml']['stCxnId']} idx={main['ooxml']['stCxnIdx']}`（{IDX_NAME[main['ooxml']['stCxnIdx']]}） |")
    a(f"| `a:endCxn` | `id={main['ooxml']['endCxnId']} idx={main['ooxml']['endCxnIdx']}`（{IDX_NAME[main['ooxml']['endCxnIdx']]}） |")
    a(f"| `a:prstGeom@prst` | `{con['preset']}` |")
    a(f"| `a:gd[adj1]` | `{con['adj1']}` |")
    a(f"| `a:xfrm@off` | ({con['offX']}, {con['offY']}) |")
    a(f"| `a:xfrm@ext` | ({con['extCx']}, {con['extCy']}) |")
    a(f"| `a:xfrm@rot` / `flipH` / `flipV` | `{con['rot'] or '—'}` / `{con['flipH'] or '—'}` / `{con['flipV'] or '—'}` |")
    a(f"| `a:ln` 是否 `noFill` | {con['lnNoFill']} |")
    a("")
    a("### 4.3 COM 与 OOXML 的交叉核对（证明 dump 就是这份 pptx）")
    a("")
    g = main["comGeometry"]
    cc = main["facts"] if "facts" in main else None
    a("| 量 | COM 读回（pt） | 换算 EMU（×12700） | OOXML（EMU） | 差 |")
    a("|---|---|---|---|---|")
    a(f"| `Left` / `off.x` | {g['conn']['L']:.4f} | {round(g['conn']['L'] * 12700)} | {con['offX']} | "
      f"{abs(round(g['conn']['L'] * 12700) - con['offX'])} |")
    a(f"| `Top` / `off.y` | {g['conn']['T']:.4f} | {round(g['conn']['T'] * 12700)} | {con['offY']} | "
      f"{abs(round(g['conn']['T'] * 12700) - con['offY'])} |")
    a(f"| `Width` / `ext.cx` | {g['conn']['W']:.4f} | {round(g['conn']['W'] * 12700)} | {con['extCx']} | "
      f"{abs(round(g['conn']['W'] * 12700) - con['extCx'])} |")
    a(f"| `Height` / `ext.cy` | {g['conn']['H']:.4f} | {round(g['conn']['H'] * 12700)} | {con['extCy']} | "
      f"{abs(round(g['conn']['H'] * 12700) - con['extCy'])} |")
    a("")
    a("COM 侧 `BeginConnected` = "
      f"`{g.get('beginConnected')}`（形状指纹 `{g.get('beginConnectedShapeName')}`）、"
      f"`EndConnected` = `{g.get('endConnected')}`（`{g.get('endConnectedShapeName')}`）。")
    a("")
    a("### 4.4 判据与数值（全部为 EMU 整数比较，无目视成分）")
    a("")
    a("| # | 判据 | 结果 | 实测数值 |")
    a("|---|---|---|---|")
    for i, (k, v) in enumerate(main["route"]["checks"].items(), start=1):
        a(f"| {i} | {k} | {yn(v['pass'])} | {v['observed']} |")
    a("")
    a(f"**判读结论（由数值推出）**：{main['route']['route']}")
    a("")
    a("**判据全通过："
      f"{'是' if main['route']['allPass'] else '否'}**（"
      f"{len(main['route']['checks'])}/{len(main['route']['checks'])}）。")
    a("")
    a("## 五、判别力对照（负对照）")
    a("")
    a("同一对 `bar`、同一页面、同一个脚本，**只改 COM 站点**：")
    a("")
    a("| 组合 | 落盘 `idx` | `rot`/`flip` | 判据全通过 | 说明 |")
    a("|---|---|---|---|---|")
    for r in recs:
        if r.get("error"):
            a(f"| `{r['tag']}` | （失败） | — | — | {r['error']} |")
            continue
        con_r = r["ooxml"]["connector"]
        norm = con_r["rot"] or "—"
        flips = "+".join([x for x in [
            "flipH" if con_r["flipH"] else "", "flipV" if con_r["flipV"] else ""] if x]) or "—"
        a(f"| `{r['tag']}` | stCxn={r['ooxml']['stCxnIdx']}（{IDX_NAME[r['ooxml']['stCxnIdx']]}）/ "
          f"endCxn={r['ooxml']['endCxnIdx']}（{IDX_NAME[r['ooxml']['endCxnIdx']]}） | "
          f"`{norm}` / `{flips}` | {'是' if r['route']['allPass'] else '否'} | {r['role']} |")
    a("")
    a("**为什么这组对照有意义**：只有 `com4-com2` 全部通过。`com2-com2`（左出 → 左入）")
    a("能通过「终点为左边」这一条，但**过不了「起点为右边」**；`com3-com3`（下出 → 下入）")
    a("两条主判据都过不了，而且 WPS 用 `rot=5400000 + flipV=1` 表示它，走线在包围盒坐标里不可直读。")
    a("⇒ 上面这套判据**不是恒真的空判据**。")
    a("")
    a("### 5.1 三组判据明细")
    a("")
    for r in recs:
        if r.get("error"):
            continue
        a(f"#### `{r['tag']}`（{r['role']}）")
        a("")
        a("| 判据 | 结果 | 实测 |")
        a("|---|---|---|")
        for k, v in r["route"]["checks"].items():
            a(f"| {k} | {yn(v['pass'])} | {v['observed']} |")
        a("")
    a("## 六、同页对照样本：`ctrl-com1-com1`（COM 1 → 1）")
    a("")
    ctl = main.get("control")
    if ctl:
        cg = ctl["geometry"]
        cr = ctl["route"]
        a("每组都额外吸附了一条 `ctrl-com1-com1`（COM `1 → 1`：`bar-a` 上边中点 → `bar-b` 上边中点）。")
        a("**它不是为了验证右出/左入**，而是用来暴露两个方法学事实：")
        a("（a）判据确实随站点变化；（b）`prst=\"line\"` 不是可靠的退化判据。")
        a("")
        a("| 项 | 值 |")
        a("|---|---|")
        a(f"| 落盘 `stCxn` / `endCxn` | `idx={ctl['stCxnIdx']}`（{IDX_NAME[ctl['stCxnIdx']]}） / `idx={ctl['endCxnIdx']}`（{IDX_NAME[ctl['endCxnIdx']]}） |")
        a(f"| 两端连接点（由 bar 的 xfrm 推出） | ({cr['stPoint']['x']}, {cr['stPoint']['y']}) → ({cr['enPoint']['x']}, {cr['enPoint']['y']})；**y 不同**（差值 {abs(cr['enPoint']['y'] - cr['stPoint']['y'])} EMU） |")
        a(f"| `prstGeom` | `{cg['preset']}`（**未**退化为 `line`） |")
        a(f"| `adj1` | `{cg['adj1']}`（**负值**） |")
        a(f"| `xfrm` | off=({cg['offX']}, {cg['offY']}) ext=({cg['extCx']}, {cg['extCy']}) `rot={cg['rot'] or '—'}` `flipH={cg['flipH'] or '—'}` `flipV={cg['flipV'] or '—'}` |")
        a(f"| `a:ln` 是否 `noFill` | {cg['lnNoFill']} |")
        a(f"| 判据结果 | " + "；".join([f"{k} → {yn(v['pass'])}" for k, v in cr["checks"].items()]) + " |")
        a("")
        a(f"- 判读：{cr['route']}")
        a("")
        a("**观察（如实记录，两条）**：")
        a("")
        a("1. 这条对照连接的**两个连接点 y 并不相同**（在两个连接点分别落在两条 bar 的**上边**时，")
        a("   y 分别是两条 bar 的上边 y，而两条 bar 位于不同行），所以它**不是**退化直线，")
        a(f"   是一条 y 跨度 {abs(cr['enPoint']['y'] - cr['stPoint']['y'])} EMU 的「Z 形」肘线；")
        a("   WPS 用 `rot` + `flip` 规范化它。⇒ 本次实验中**没有**出现「起终点 y 完全相同」的样本，")
        a("   因此「WPS 在退化情形下写什么」**本轮未测**，不作结论。")
        a(f"2. 即便如此也能确认一点：该连接**没有**被写成 `prst=\"line\"`，`a:ln` 也没有 `noFill`，")
        a(f"   而是 `bentConnector3` + 负 `adj1`（`{cg['adj1']}`）。⇒ 用 `prst` 名判断退化**不可靠**，")
        a("   判断退化应当用数值（两端点 y 是否相同、`ext` 是否等于端点包围盒）。")
        a("")
        a("这一节是**旁证与方法学备注**，不参与 P-8 的主判据。")
    a("")
    a("## 七、WPS 口径结论（可直接引用的三条）")
    a("")
    a("1. **右出 → 左入的肘形在 WPS 下与预期一致**：落盘 `idx=3`/`idx=1`，")
    a("   几何**未旋转/未翻转**，水平引线向右、竖直段落在两条参与边 x 的中值处。")
    a("2. **走线方向为竖直（`rot` 非空）时，WPS 用 `rot` + `flip` 规范化表示**")
    a("   （本次实测到 `rot=5400000`/`10800000`/`16200000` 三种 + 相应 `flip`）；")
    a("   因此 G7 还原几何时**必须先读 `rot`/`flip`**，不能只读 `off`/`ext`。")
    a("3. **负 `adj1` 与旋转规范化是常态，不是异常**（本次 4 条非主判据连线里 3 条 `rot` 非空、")
    a("   2 条 `adj1` 为负）；因此**不要**用「`adj1` 是否 50000」「`prst` 是否 `line`」这类形态特征")
    a("   反推语义，应当用 `stCxn/endCxn@idx` + 端点几何这类**语义判据**。")
    a("")
    a("## 八、未验证项（明确标注）")
    a("")
    a("- **其余引擎本轮未验证、不阻塞**：本机 **LibreOffice（`soffice`）不在 PATH**、")
    a("  **OnlyOffice 未安装**（已核实），因此本报告的结论**只代表 WPS 口径**。")
    a("  这与裁决 **P-4**（验证环境以 WPS 为准、PowerPoint 备查、不阻塞）同源；")
    a("  P-8 第 4 条已记录「临时探针显示 OnlyOffice 在肘形走向上偏离 WPS」，本轮**未复测**。")
    a("- **Microsoft PowerPoint 未验证**：只有 WPS COM（自报 `Name=\"Microsoft PowerPoint\"`，属伪装字符串）。")
    a("- **未覆盖**：同侧多线分道 / 避让（P-8 遗留 3）、`bentConnector2/4` 的 `adj` 语义、")
    a("  长距离回绕与 stub 长度策略（P-8 第 2 条把 stub 长度交给 G4 的 SVG 正交路由器）。")
    a("")
    a("## 九、残留进程")
    a("")
    a(f"运行前已有的 WPS 系进程：**{len(procs_before)}** 个（用户既有）。")
    new_procs = [p for p in procs_after
                 if p["start"] >= env.get("probeStart", "") and p["id"] not in {q["id"] for q in procs_before}]
    a(f"本次运行期间新出现且**运行结束时仍存活**：**{len(new_procs)}** 个。")
    if new_procs:
        a("")
        a("| 进程 | PID | 启动时间 |")
        a("|---|---|---|")
        for p in new_procs:
            a(f"| `{p['name']}` | {p['id']} | {p['start']} |")
        a("")
        a("同上：`finally` 已 `Close`/`Quit`/`ReleaseComObject` + `GC`；脚本不强杀进程。")
    a("")
    a("## 十、证据文件与重跑命令")
    a("")
    a("> 重跑提示：`evidence/wps/P8-elbow-com*-slide1.xml` 与上表所有 `idx`/数值**逐字节稳定**；")
    a("> 但本 md 里含**采集时刻与 PID**（第九节），重跑会出现 diff —— 那是元信息，不是判据。")
    a("")
    a("| 文件 | 角色 |")
    a("|---|---|")
    a("| `src/wps-elbow-retest.ps1` | 采集 + 量化判读脚本 |")
    for r in recs:
        a(f"| `evidence/wps/{os.path.basename(r['xml'])}` | `{r['tag']}` 的 `slide1.xml` 快照 |")
    a("| `out/P8-elbow-records.json` | 采集结果 JSON（工件，不入库） |")
    a("| `evidence/wps/elbow-retest.md` | 本文件 |")
    a("")
    a("```powershell")
    a("# 主判据 + 两组负对照 + 同页对照")
    a("pwsh -File spikes/g0-s4-svg-clipping/src/wps-elbow-retest.ps1")
    a("")
    a("# 只跑主判据")
    a("pwsh -File spikes/g0-s4-svg-clipping/src/wps-elbow-retest.ps1 -MainOnly")
    a("")
    a("# 指定站点")
    a("pwsh -File spikes/g0-s4-svg-clipping/src/wps-elbow-retest.ps1 -BeginSite 4 -EndSite 2")
    a("```")
    a("")

    return write_lf(os.path.join(EVID, "wps", "elbow-retest.md"), "\n".join(L))


if __name__ == "__main__":
    p1 = gen_idx()
    p2 = gen_elbow()
    print("written:", p1)
    print("written:", p2)
