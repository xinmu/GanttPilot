# G0-S-S4 · P-8 遗留 2：「右出 → 左入」形态下的肘形复测（WPS 口径）
#
# 要回答的问题：P-8 第 1 条把依赖线策略定为 **FS = 前置右出（OOXML idx=3）→ 后置左入（idx=1）**。
# 「下出 → 上入」（S1 fixture）的肘形走向**不能外推**到右出/左入形态，因此必须复测：
# 在 WPS 下这条连线到底怎么走？水平引线朝哪边？竖向段落在哪个 x？
#
# **判据必须量化、不得目视**（P-9 口径）。本脚本用两路独立数据交叉验证：
#   1) COM 侧：落盘前读 `Shape.Left/Top/Width/Height`（单位 pt）+ 两个 bar 的几何；
#   2) OOXML 侧：解包 ppt/slides/slide1.xml，读 connector 的 `a:xfrm`（off/ext/rot/flipH/flipV）、
#      `a:prstGeom@prst`、`a:gd[@name="adj1"]`，以及 `a:stCxn/@idx`、`a:endCxn/@idx`。
# 再按 **bentConnector3 的 preset 几何定义**（不是经验猜测）从这些数值推出走线拓扑：
#   bentConnector3 的规则是「从起点沿**起点所在边**的法向外法线走一小段 → 转到中点竖线 →
#   竖直到终点高度 → 沿终点所在边的法向进入终点」。因此：
#     - 若两条 bar 的**竖向中心不同**（type B）：走线 = 水平引线 + **1 段竖直** + 水平引线，
#       竖直段的 x = (起点边 x + 终点边 x) / 2；此时若 flipV=0（未翻转），竖直段在**上方**；
#     - 若两条 bar 的**竖向中心相同**（type A）：起终点 y 一致，退化为**一条直线**，
#       `a:ln` 直接带 `<a:noFill/>`，且 preset 写成 `line`（WPS 实测行为）。
#
# 用法：
#   pwsh -File src/wps-elbow-retest.ps1              # 默认：4/2（右→左，主判据）+ 一组负对照
#   pwsh -File src/wps-elbow-retest.ps1 -BeginSite 4 -EndSite 2
#
# 产出（工件不入库 / 证据入库）：
#   out/P8-elbow-com{起}-com{止}.pptx、out/P8-elbow-records.json
#   evidence/wps/P8-elbow-com*-slide1.xml（LF 写入）
#   evidence/wps/elbow-retest.md 由 tools/wps-elbow-report.ps1 从 JSON 生成（保证重跑一致）

[CmdletBinding()]
param(
  # COM 站点值：1=上 2=左 3=下 4=右（roundRect）
  [ValidateRange(1, 4)] [int] $BeginSite = 0,
  [ValidateRange(1, 4)] [int] $EndSite = 0,
  [string] $ResultJson = '',
  # 只跑主判据（不加负对照）
  [switch] $MainOnly
)

$ErrorActionPreference = 'Stop'

$script:COM_SITE_NAME = @{ 1 = '上'; 2 = '左'; 3 = '下'; 4 = '右' }
$script:OOXML_IDX_NAME = @{ 0 = '上'; 1 = '左'; 2 = '下'; 3 = '右' }
$EMU_PER_PT = 12700

$spikeRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $spikeRoot 'out'
$evidenceDir = Join-Path $spikeRoot 'evidence\wps'
New-Item -ItemType Directory -Force -Path $outDir, $evidenceDir | Out-Null

$SLIDE_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
$DRAW_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

# ---------------- 自带工具（不跨 spike 引用） ----------------

# 统一以 LF 写入生成的文本证据（.gitattributes 强制 LF；不归一化会让重跑把工作区弄脏）
function Write-LfText {
  param(
    [Parameter(Mandatory)] [string] $Path,
    [Parameter(Mandatory)] [AllowEmptyString()] [string] $Text
  )
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $normalized = $Text -replace "`r`n", "`n"
  [System.IO.File]::WriteAllText($Path, $normalized, [System.Text.UTF8Encoding]::new($false))
}

function Get-PptxEntryText {
  param(
    [Parameter(Mandatory)] [string] $PptxPath,
    [Parameter(Mandatory)] [string] $EntryName
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($PptxPath)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq $EntryName }
    if (-not $entry) { throw "$EntryName 不存在于 $PptxPath" }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $text = $reader.ReadToEnd()
    $reader.Close()
    return $text
  }
  finally { $zip.Dispose() }
}

# 注意：XmlNamespaceManager 是 IEnumerable，作为函数返回值会被管道展开成 prefix 字符串数组，
# 必须用 Write-Output -NoEnumerate（`return $ns` / `return ,$ns` 都会被展开）。
function New-SlideNs {
  param([Parameter(Mandatory)] [System.Xml.XmlDocument] $Doc)
  $ns = New-Object System.Xml.XmlNamespaceManager($Doc.NameTable)
  $null = $ns.AddNamespace('p', $SLIDE_NS)
  $null = $ns.AddNamespace('a', $DRAW_NS)
  Write-Output -NoEnumerate $ns
}

function Get-SlideDoc {
  param([Parameter(Mandatory)] [string] $SlideXml)
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $doc.LoadXml($SlideXml)
  return $doc
}

function Get-ShapeNodeByName {
  param(
    [Parameter(Mandatory)] [System.Xml.XmlDocument] $Doc,
    [Parameter(Mandatory)] [string] $Name
  )
  $ns = New-SlideNs -Doc $Doc
  $spTree = $Doc.SelectSingleNode('//p:cSld/p:spTree', $ns)
  $found = $null
  foreach ($c in $spTree.ChildNodes) {
    $nv = $c.SelectSingleNode('./p:nvSpPr/p:cNvPr', $ns)
    if (-not $nv) { $nv = $c.SelectSingleNode('./p:nvCxnSpPr/p:cNvPr', $ns) }
    if ($nv -and $nv.GetAttribute('name') -eq $Name) { $found = $c; break }
  }
  return $found
}

function Get-NodeIdName {
  param([Parameter(Mandatory)] $Node)
  $ns = New-SlideNs -Doc $Node.OwnerDocument
  $nv = $Node.SelectSingleNode('.//p:cNvPr', $ns)
  if (-not $nv) { return $null }
  return [ordered]@{ id = [int]$nv.GetAttribute('id'); name = $nv.GetAttribute('name') }
}

# 形状的几何（含 rot/flip 原始属性；prstGeom 的 preset 与 adj1）
function Get-NodeGeometry {
  param([Parameter(Mandatory)] $Node)
  $ns = New-SlideNs -Doc $Node.OwnerDocument
  $xfrm = $Node.SelectSingleNode('./p:spPr/a:xfrm', $ns)
  $prst = $Node.SelectSingleNode('./p:spPr/a:prstGeom', $ns)
  $ln = $Node.SelectSingleNode('./p:spPr/a:ln', $ns)
  $adj1 = $null
  if ($prst) {
    $gd = $prst.SelectSingleNode('./a:avLst/a:gd[@name="adj1"]', $ns)
    if ($gd) {
      $m = [regex]::Match([string]$gd.GetAttribute('fmla'), '(-?\d+)\s*$')
      if ($m.Success) { $adj1 = [int]$m.Groups[1].Value }
    }
  }
  $off = $null; $ext = $null
  if ($xfrm) {
    $off = $xfrm.SelectSingleNode('./a:off', $ns)
    $ext = $xfrm.SelectSingleNode('./a:ext', $ns)
  }
  # 返回 [ordered]（OrderedDictionary）本身：PowerShell 把 IDictionary 当**标量**输出，
  # 不会被管道展开（实测）。若加 `,` 反而会多包一层，令调用方拿到 Object[]。
  $out = [ordered]@{
    offX     = if ($off) { [int]$off.GetAttribute('x') } else { 0 }
    offY     = if ($off) { [int]$off.GetAttribute('y') } else { 0 }
    extCx    = if ($ext) { [int]$ext.GetAttribute('cx') } else { 0 }
    extCy    = if ($ext) { [int]$ext.GetAttribute('cy') } else { 0 }
    rot      = if ($xfrm) { $xfrm.GetAttribute('rot') } else { '' }
    flipH    = if ($xfrm) { $xfrm.GetAttribute('flipH') } else { '' }
    flipV    = if ($xfrm) { $xfrm.GetAttribute('flipV') } else { '' }
    preset   = if ($prst) { $prst.GetAttribute('prst') } else { '' }
    adj1     = $adj1
    # WPS 在"起终点同高"的退化情形下会写 `<a:noFill/>`
    lnNoFill = if ($ln) { $null -ne $ln.SelectSingleNode('./a:noFill', $ns) } else { $false }
  }
  return $out
}

# WPS COM 自报属性。**陷阱**：WPS 自报 Name="Microsoft PowerPoint"、Version="12.0"，
# 属于伪装字符串，**不构成"用 Microsoft PowerPoint 验证过"的证据**。
function Get-WpsAppSelfReport {
  param([Parameter(Mandatory)] $App)
  $r = [ordered]@{ name = '(未取到)'; version = '(未取到)'; build = '(未取到)'; path = '(未取到)' }
  try { $r.name = [string]$App.Name } catch { $r.name = "(取 Name 失败：$($_.Exception.Message))" }
  try { $r.version = [string]$App.Version } catch { $r.version = "(取 Version 失败：$($_.Exception.Message))" }
  try { $r.build = [string]$App.Build } catch { $r.build = "(取 Build 失败：$($_.Exception.Message))" }
  try { $r.path = [string]$App.Path } catch { $r.path = "(取 Path 失败：$($_.Exception.Message))" }
  return $r
}

# ---------------- 走线拓扑的量化判读 ----------------
#
# 输入：bar-a / bar-b 的 xfrm，connector 的 xfrm + preset + adj1。
# 输出：参与边、期望框、各条判据的实测值与偏差。全部基于 EMU 整数运算，无目视成分。
function Measure-ElbowRoute {
  param(
    [Parameter(Mandatory)] $BarA,
    [Parameter(Mandatory)] $BarB,
    [Parameter(Mandatory)] $Conn,
    [Parameter(Mandatory)] [int] $StIdx,
    [Parameter(Mandatory)] [int] $EndIdx,
    [int] $Tol = 2   # EMU 级容差（WPS 会做 100 EMU 级取整）
  )

  # **踩坑记录（实测）**：不要在 `switch` 的 case 里写 `return @($a + $b, $c)`。
  # PowerShell 会把 `@(x, y)` 解析成"传给 @() 的参数列表"，即 `@(($a+$b), $c)`，
  # 于是 `$a + $b` 被当成数组拼接上下文，报
  # 「方法调用失败，因为 [System.Object[]] 不包含名为 'op_Addition' 的方法」。
  # 这里一律用 if/elseif + 标量赋值，数组只在最后一次性组装。
  function Get-BoxParts {
    param($Box)
    $ox = [int]$Box.offX; $oy = [int]$Box.offY
    $ex = [int]$Box.extCx; $ey = [int]$Box.extCy
    $cx = $ox + [int]([math]::Floor($ex / 2))
    $cy = $oy + [int]([math]::Floor($ey / 2))
    return [pscustomobject]@{ ox = $ox; oy = $oy; ex = $ex; ey = $ey; cx = $cx; cy = $cy }
  }
  # 连接点坐标（idx 按 OOXML 语义：0=上 1=左 2=下 3=右）
  function Get-EdgePoint {
    param($P, [int] $Idx)
    $x = 0; $y = 0
    if ($Idx -eq 0) { $x = $P.cx; $y = $P.oy }
    elseif ($Idx -eq 1) { $x = $P.ox; $y = $P.cy }
    elseif ($Idx -eq 2) { $x = $P.cx; $y = $P.oy + $P.ey }
    elseif ($Idx -eq 3) { $x = $P.ox + $P.ex; $y = $P.cy }
    else { $x = $null; $y = $null }
    return [pscustomobject]@{ x = $x; y = $y }
  }
  # 参与边的"边线"坐标：上/下给 y，左/右给 x
  function Get-EdgeLine {
    param($P, [int] $Idx)
    if ($Idx -eq 0) { return $P.oy }
    if ($Idx -eq 1) { return $P.ox }
    if ($Idx -eq 2) { return $P.oy + $P.ey }
    if ($Idx -eq 3) { return $P.ox + $P.ex }
    return $null
  }

  $pA = Get-BoxParts -Box $BarA
  $pB = Get-BoxParts -Box $BarB
  $stPt = Get-EdgePoint -P $pA -Idx $StIdx
  $enPt = Get-EdgePoint -P $pB -Idx $EndIdx
  $stLine = Get-EdgeLine -P $pA -Idx $StIdx
  $enLine = Get-EdgeLine -P $pB -Idx $EndIdx
  $st = @($stPt.x, $stPt.y)
  $en = @($enPt.x, $enPt.y)

  # 起点 y 中心 / 终点 y 中心
  $cyA = $pA.cy
  $cyB = $pB.cy

  # 走线类型：**两个连接点的 y 是否相同**。相同 → type A（退化为直线）。
  $type = if ($st[1] -eq $en[1]) { 'A' } else { 'B' }

  # WPS 的规范化：原始 bentConnector3 是"水平引线 + 竖直段"，但当两端站点都在**同一竖边**上
  # （idx 0/2）时 WPS 会用 rot=±90° + flip 把它表示成竖版，于是 xfrm 的 off/ext 不再是端点包围盒。
  # 因此每次判读都必须先看 rot/flip，再决定几何在"原始方向"下的参数。
  $norm = if ($Conn.rot -eq '') { '未旋转' } else { "rot=$($Conn.rot)" }
  if ($Conn.flipH) { $norm += ' flipH=1' }
  if ($Conn.flipV) { $norm += ' flipV=1' }

  $expOffX = [math]::Min($st[0], $en[0])
  $expOffY = [math]::Min($st[1], $en[1])
  $expExtCx = [math]::Abs($st[0] - $en[0])
  $expExtCy = [math]::Abs($st[1] - $en[1])

  # 竖直段位置：未旋转时，原始 bentConnector3 的竖直段落在 (起点边 x + 终点边 x) / 2
  $vSegX = [int](($stLine + $enLine) / 2)

  $checks = [ordered]@{}

  # ---- 主判据（只对"右出 → 左入"这一目标形态成立）----
  # 判据 1：起点贴的是**右**边（OOXML idx=3），且终点在起点右侧 ⇒ 水平引线向右
  $chk1 = ($StIdx -eq 3) -and ($en[0] -gt $st[0])
  $checks['起点为右边（idx=3）且终点在其右侧 ⇒ 水平引线向右'] = [ordered]@{
    pass     = $chk1
    observed = "起点边 idx=$StIdx（$($script:OOXML_IDX_NAME[$StIdx])）@x=$($st[0])；终点 x=$($en[0])；Δx=$($en[0] - $st[0]) EMU"
  }
  # 判据 2：终点贴的是**左**边（idx=1），且终点在起点右侧 ⇒ 连线自左方抵达
  $chk2 = ($EndIdx -eq 1) -and ($en[0] -gt $st[0])
  $checks['终点为左边（idx=1）且位于起点右侧 ⇒ 自左方进入'] = [ordered]@{
    pass     = $chk2
    observed = "终点边 idx=$EndIdx（$($script:OOXML_IDX_NAME[$EndIdx])）@x=$($en[0])；起点 x=$($st[0])"
  }
  # 判据 3（仅未旋转时可比）：connector 包围盒 == 两端连接点推出的期望框
  if ($Conn.rot -eq '') {
    $boxOk = ([math]::Abs($Conn.offX - $expOffX) -le $Tol) -and
             ([math]::Abs($Conn.offY - $expOffY) -le $Tol) -and
             ([math]::Abs($Conn.extCx - $expExtCx) -le $Tol) -and
             ([math]::Abs($Conn.extCy - $expExtCy) -le $Tol)
    $checks['包围盒 == 两端连接点推出的期望框（未旋转）'] = [ordered]@{
      pass     = $boxOk
      observed = "实测 off=($($Conn.offX),$($Conn.offY)) ext=($($Conn.extCx),$($Conn.extCy))；期望 off=($expOffX,$expOffY) ext=($expExtCx,$expExtCy)"
    }
  } else {
    # 旋转情形：把端点**反向变换**回包围盒坐标系后，端点必须落在框内（自洽性检查）。
    # rot=5400000（90°）且无 flip：点 (x,y) 的原始坐标为 (y, -x)，故 x'=y 落在 [offX, offX+cx]。
    # rot=10800000（180°）且 flipH=flipV=1：等价于中心对称，x'=2·midX−x、y'=2·midY−y。
    $midX = $Conn.offX + [int]([math]::Floor($Conn.extCx / 2))
    $midY = $Conn.offY + [int]([math]::Floor($Conn.extCy / 2))
    $ok = $true
    $detail = @()
    foreach ($pt in @($st, $en)) {
      $px = $pt[0]; $py = $pt[1]
      $qx = $px; $qy = $py
      if ($Conn.rot -eq '5400000') { $qx = $py }
      elseif ($Conn.rot -eq '10800000') { $qx = 2 * $midX - $px; $qy = 2 * $midY - $py }
      if ($Conn.flipH) { $qx = 2 * $midX - $qx }
      if ($Conn.flipV) { $qy = 2 * $midY - $qy }
      $inX = ($qx -ge $Conn.offX - $Tol -and $qx -le ($Conn.offX + $Conn.extCx) + $Tol)
      $inY = ($qy -ge $Conn.offY - $Tol -and $qy -le ($Conn.offY + $Conn.extCy) + $Tol)
      if (-not ($inX -and $inY)) { $ok = $false }
      $detail += "($px,$py)→($qx,$qy)[$(if ($inX -and $inY) { '在框内' } else { '出框' })]"
    }
    $checks['端点反向旋转后落在包围盒内（旋转情形，自洽性检查）'] = [ordered]@{
      pass     = $ok
      observed = "rot=$($Conn.rot) flipH='$($Conn.flipH)' flipV='$($Conn.flipV)'；包围盒 off=($($Conn.offX),$($Conn.offY)) ext=($($Conn.extCx),$($Conn.extCy))；$($detail -join '，')"
    }
  }
  # 判据 4：走线类型与几何自洽（type B 必有竖直段；type A 退化为直线）
  $typeOk = if ($type -eq 'B') { $Conn.extCy -gt 0 -or $Conn.rot -ne '' } else { $Conn.extCy -eq 0 }
  $checks['走线类型与几何自洽'] = [ordered]@{
    pass     = $typeOk
    observed = "type=$type（起终点 y：$($st[1]) / $($en[1])）；preset=$($Conn.preset) ext=($($Conn.extCx),$($Conn.extCy)) adj1=$($Conn.adj1)（$norm）"
  }
  if ($type -eq 'B' -and $Conn.rot -eq '') {
    $xOk = ($vSegX -ge $Conn.offX -and $vSegX -le ($Conn.offX + $Conn.extCx))
    $checks['竖直段 x = 两条参与边的中值（未旋转）'] = [ordered]@{
      pass     = $xOk
      observed = "参与边 x：起点边 $stLine，终点边 $enLine → 中值 $vSegX；包围盒 x ∈ [$($Conn.offX), $($Conn.offX + $Conn.extCx)]"
    }
  }
  if ($type -eq 'A') {
    $bareOk = ($Conn.extCy -eq 0) -or ($Conn.preset -eq 'line')
    $checks['退化形态（preset=line 或 extCy=0）'] = [ordered]@{
      pass     = $bareOk
      observed = "preset=$($Conn.preset) ext=($($Conn.extCx),$($Conn.extCy)) adj1=$($Conn.adj1) lnNoFill=$($Conn.lnNoFill) ⇒ $(if ($bareOk) { '符合退化预期' } else { 'WPS 仍写 bentConnector3（未退化为 line）' })"
    }
  }

  # 走线描述（由数值推出，不是目视）
  $route = if ($type -eq 'A') {
    $sy = $st[1]
    $dxA = $en[0] - $st[0]
    $dyA = 0
    "$(if ($dxA -eq 0 -and $dyA -eq 0) { '起终点重合' } else { '起终点 y 相同（' + $sy + '）⇒ 走线**不含竖直段**，外观是一条直线段' })：" +
    "自 ($($st[0]),$($st[1])) 直达 ($($en[0]),$($en[1]))；preset=$($Conn.preset) adj1=$($Conn.adj1)（WPS 未按预期退化为 `line`，仍写 bentConnector3）"
  } elseif ($Conn.rot -eq '') {
    $vn = if ($Conn.flipV) { '竖直段在上方（flipV=1）' } else { '竖直段在下方（flipV 缺省）' }
    "水平引线（x $($st[0])→$vSegX，y=$($Conn.offY)）→ 竖直段（x=$vSegX，y $($Conn.offY)→$($Conn.offY + $Conn.extCy)）→ 水平引线（x $vSegX→$($en[0]))；$vn"
  } else {
    "WPS 用规范化表示（$norm）：原始 bentConnector3 的水平引线/竖直段被整体旋转，不能直接按包围盒读；" +
    "端点仍在 ($($st[0]),$($st[1])) → ($($en[0]),$($en[1]))"
  }

  return , [ordered]@{
    type         = $type
    normalization = $norm
    stPoint      = [ordered]@{ x = $st[0]; y = $st[1] }
    enPoint      = [ordered]@{ x = $en[0]; y = $en[1] }
    expectedBox  = [ordered]@{ offX = $expOffX; offY = $expOffY; extCx = $expExtCx; extCy = $expExtCy }
    verticalSegX = if ($type -eq 'B') { $vSegX } else { $null }
    barACenterY  = $cyA
    barBCenterY  = $cyB
    route        = $route
    checks       = $checks
    allPass      = (-not (@($checks.Values | ForEach-Object { $_.pass }) -contains $false))
  }
}

# ---------------- 组合定义 ----------------
# 主判据：4/2（**右出 → 左入**，P-8 第 1 条的 FS 形态）。
# 负对照：3/3（下出 → 下入）与 2/2（左出 → 左入）——同一对 bar、同一页面，只有站点不同。
# 它们用来证明上面的判据**有判别力**：若判据在任何站点组合下都"通过"，那它就是空的。
# 另外每组都额外造一条 2/2（左右同高）的**裸线条对照**，用来观察 WPS 在"起终点同高"时
# 是否退化为 `line`、`adj1` 是否被写成负值（这也是"哪一组几何更可预期"的证据）。
if ($BeginSite -gt 0 -and $EndSite -gt 0) {
  $combos = @([pscustomobject]@{ begin = $BeginSite; end = $EndSite; role = '指定组合' })
} elseif ($MainOnly) {
  $combos = @([pscustomobject]@{ begin = 4; end = 2; role = '主判据：右出 → 左入' })
} else {
  $combos = @(
    [pscustomobject]@{ begin = 4; end = 2; role = '主判据：右出 → 左入（P-8 FS 形态）' }
    [pscustomobject]@{ begin = 3; end = 3; role = '负对照 1：下出 → 下入（同页面，仅站点不同）' }
    [pscustomobject]@{ begin = 2; end = 2; role = '负对照 2：左出 → 左入（同页面，仅站点不同）' }
  )
}

$procsBefore = @(Get-Process -Name wps, wpp, et, wpscloudsvr, wpscenter -ErrorAction SilentlyContinue |
  ForEach-Object { [ordered]@{ name = $_.ProcessName; id = $_.Id; start = $_.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } })

$records = @()
$envFacts = [ordered]@{
  psVersion  = $PSVersionTable.PSVersion.ToString()
  wpsInstall = (Test-Path "$env:LOCALAPPDATA\Kingsoft\WPS Office")
  slideW     = 960
  slideH     = 540
  probeStart = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  app        = $null
}

foreach ($combo in $combos) {
  $b = [int]$combo.begin
  $e = [int]$combo.end
  $tag = "com$b-com$e"
  $pptxPath = Join-Path $outDir "P8-elbow-$tag.pptx"
  $xmlPath = Join-Path $evidenceDir "P8-elbow-$tag-slide1.xml"
  if (Test-Path $pptxPath) { Remove-Item $pptxPath -Force }

  Write-Output ''
  Write-Output "=== $tag（$($combo.role)）：BeginConnect = $b（$($script:COM_SITE_NAME[$b])） / EndConnect = $e（$($script:COM_SITE_NAME[$e])） ==="

  $app = $null; $pres = $null
  $rec = [ordered]@{
    tag         = $tag
    role        = $combo.role
    comBegin    = $b
    comEnd      = $e
    comBeginName = $script:COM_SITE_NAME[$b]
    comEndName  = $script:COM_SITE_NAME[$e]
    pptx        = $pptxPath
    xml         = $xmlPath
    comGeometry = $null
    error       = $null
    ooxml       = $null
    route       = $null
    xmlText     = $null
  }

  try {
    $app = New-Object -ComObject KWPP.Application
    if ($null -eq $envFacts.app) { $envFacts.app = Get-WpsAppSelfReport -App $app }
    $pres = $app.Presentations.Add()
    $pres.PageSetup.SlideWidth = 960
    $pres.PageSetup.SlideHeight = 540
    $slide = $pres.Slides.Add(1, 12)  # ppLayoutBlank

    # 与 S1 参照一致：两个圆角矩形 + 一条肘形 connector
    $barA = $slide.Shapes.AddShape(5, 100, 100, 200, 40)   # msoShapeRoundedRectangle
    $barA.Name = 'bar-a'
    $barA.Fill.Solid()
    $barA.Fill.ForeColor.RGB = 0x2E75B6
    $barB = $slide.Shapes.AddShape(5, 500, 320, 200, 40)
    $barB.Name = 'bar-b'
    $barB.Fill.Solid()
    $barB.Fill.ForeColor.RGB = 0xC00000

    $conn = $slide.Shapes.AddConnector(2, 0, 0, 10, 10)    # msoConnectorElbow
    $conn.Name = 'dep-1'
    $conn.Line.ForeColor.RGB = 0x00B050
    $conn.ConnectorFormat.BeginConnect($barA, $b)
    $conn.ConnectorFormat.EndConnect($barB, $e)

    # 数据源 1：COM 侧几何（WPS COM 长度单位是 pt；EMU = pt × 12700）
    $geom = [ordered]@{
      units        = 'pt'
      barA = [ordered]@{ L = [double]$barA.Left; T = [double]$barA.Top; W = [double]$barA.Width; H = [double]$barA.Height }
      barB = [ordered]@{ L = [double]$barB.Left; T = [double]$barB.Top; W = [double]$barB.Width; H = [double]$barB.Height }
      conn = [ordered]@{ L = [double]$conn.Left; T = [double]$conn.Top; W = [double]$conn.Width; H = [double]$conn.Height }
    }
    try { $geom.connType = [int]$conn.ConnectorFormat.Type } catch { $geom.connType = $null }
    try { $geom.beginConnected = [bool]$conn.ConnectorFormat.BeginConnected } catch { $geom.beginConnected = $null }
    try { $geom.endConnected = [bool]$conn.ConnectorFormat.EndConnected } catch { $geom.endConnected = $null }
    try { $geom.beginConnectedShapeName = [string]$conn.ConnectorFormat.BeginConnectedShape.Name } catch { $geom.beginConnectedShapeName = $null }
    try { $geom.endConnectedShapeName = [string]$conn.ConnectorFormat.EndConnectedShape.Name } catch { $geom.endConnectedShapeName = $null }

    # 同页对照：再吸附一条 1/1（bar-a 上边中点 → bar-b 上边中点）。两个连接点的 y 相同，
    # 走线退化为"一点到一点的直线"——用来验证脚本对 type A（无竖直段）的识别，
    # 并观察 WPS 是否把 preset 写成 `line`、把 adj1 写成负值。
    $ctrl = $slide.Shapes.AddConnector(2, 0, 0, 10, 10)
    $ctrl.Name = 'ctrl-com1-com1'
    $ctrl.Line.ForeColor.RGB = 0x00B050
    $ctrl.ConnectorFormat.BeginConnect($barA, 1)
    $ctrl.ConnectorFormat.EndConnect($barB, 1)
    try { $geom.ctrl11 = [ordered]@{ L = [double]$ctrl.Left; T = [double]$ctrl.Top; W = [double]$ctrl.Width; H = [double]$ctrl.Height } } catch { $geom.ctrl11 = $null }

    $rec.comGeometry = $geom
    $connEmu = [ordered]@{
      offX = [int]([math]::Round($geom.conn.L * $EMU_PER_PT))
      offY = [int]([math]::Round($geom.conn.T * $EMU_PER_PT))
      extCx = [int]([math]::Round($geom.conn.W * $EMU_PER_PT))
      extCy = [int]([math]::Round($geom.conn.H * $EMU_PER_PT))
    }
    Write-Output ("  COM 侧（pt）：conn L={0} T={1} W={2} H={3}；BeginConnected={4}({6}) EndConnected={5}({7})；换算 EMU off=({8},{9}) ext=({10},{11})" -f `
        $geom.conn.L, $geom.conn.T, $geom.conn.W, $geom.conn.H, $geom.beginConnected, $geom.endConnected,
      $geom.beginConnectedShapeName, $geom.endConnectedShapeName, $connEmu.offX, $connEmu.offY, $connEmu.extCx, $connEmu.extCy)

    $pres.SaveAs($pptxPath, 24)  # ppSaveAsOpenXMLPresentation
    if (-not (Test-Path $pptxPath)) { throw "另存失败：$pptxPath" }
    Write-Output "  已另存：$pptxPath ($((Get-Item $pptxPath).Length) bytes)"
  }
  catch {
    $rec.error = "$($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Write-Output "  !! $tag 失败：$($rec.error)"
  }
  finally {
    if ($pres) { try { $pres.Close() } catch {} }
    if ($app) { try { $app.Quit() } catch {}; try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {} }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }

  if (-not $rec.error -and (Test-Path $pptxPath)) {
    $xml = Get-PptxEntryText -PptxPath $pptxPath -EntryName 'ppt/slides/slide1.xml'
    Write-LfText -Path $xmlPath -Text $xml
    $rec.xmlText = $xml

    $doc = Get-SlideDoc -SlideXml $xml
    $ns = New-SlideNs -Doc $doc
    $connNode = Get-ShapeNodeByName -Doc $doc -Name 'dep-1'
    $barANode = Get-ShapeNodeByName -Doc $doc -Name 'bar-a'
    $barBNode = Get-ShapeNodeByName -Doc $doc -Name 'bar-b'
    if (-not ($connNode -and $barANode -and $barBNode)) { throw "slide XML 里缺少 dep-1 / bar-a / bar-b 之一" }

    $st = $connNode.SelectSingleNode('.//a:stCxn', $ns)
    $en = $connNode.SelectSingleNode('.//a:endCxn', $ns)
    $rec.ooxml = [ordered]@{
      connector  = Get-NodeGeometry -Node $connNode
      barA       = Get-NodeGeometry -Node $barANode
      barB       = Get-NodeGeometry -Node $barBNode
      stCxnIdx   = if ($st) { [int]$st.GetAttribute('idx') } else { $null }
      endCxnIdx  = if ($en) { [int]$en.GetAttribute('idx') } else { $null }
      stCxnId    = if ($st) { [int]$st.GetAttribute('id') } else { $null }
      endCxnId   = if ($en) { [int]$en.GetAttribute('id') } else { $null }
      connId     = (Get-NodeIdName -Node $connNode).id
    }

    # 数据源 3：从 slide XML 直接抽取 connector 的原始片段（报告里做"原始证据"）
    $mBlock = [regex]::Match($xml, '<p:cxnSp>.*?</p:cxnSp>', 'Singleline')
    $rec.connectorXml = if ($mBlock.Success) { $mBlock.Value } else { $null }

    $rec.route = Measure-ElbowRoute -BarA $rec.ooxml.barA -BarB $rec.ooxml.barB -Conn $rec.ooxml.connector `
      -StIdx $rec.ooxml.stCxnIdx -EndIdx $rec.ooxml.endCxnIdx

    # 同页对照（ctrl-com1-com1：1/1，起终点同 y）——只观察，不参与主判据
    $ctrlNode = Get-ShapeNodeByName -Doc $doc -Name 'ctrl-com1-com1'
    if ($ctrlNode) {
      $ctrlGeo = Get-NodeGeometry -Node $ctrlNode
      $cst = $ctrlNode.SelectSingleNode('.//a:stCxn', $ns)
      $cen = $ctrlNode.SelectSingleNode('.//a:endCxn', $ns)
      $cStIdx = if ($cst) { [int]$cst.GetAttribute('idx') } else { $null }
      $cEndIdx = if ($cen) { [int]$cen.GetAttribute('idx') } else { $null }
      $rec.control = [ordered]@{
        name    = 'ctrl-com1-com1'
        comSites = '1 → 1'
        geometry = $ctrlGeo
        stCxnIdx = $cStIdx
        endCxnIdx = $cEndIdx
        route   = Measure-ElbowRoute -BarA $rec.ooxml.barA -BarB $rec.ooxml.barB -Conn $ctrlGeo -StIdx $cStIdx -EndIdx $cEndIdx
      }
      Write-Output ("  同页对照 ctrl-com1-com1（COM 1→1，两端分属两条 bar 的上边）：stCxn idx={0} endCxn idx={1} preset={2} adj1={3} ext=({4},{5})" -f `
          $cStIdx, $cEndIdx, $ctrlGeo.preset, $ctrlGeo.adj1, $ctrlGeo.extCx, $ctrlGeo.extCy)
    }

    Write-Output ("  落盘：stCxn idx={0}（{1}） endCxn idx={2}（{3}） preset={4} adj1={5} lnNoFill={6}" -f `
        $rec.ooxml.stCxnIdx, $script:OOXML_IDX_NAME[$rec.ooxml.stCxnIdx],
      $rec.ooxml.endCxnIdx, $script:OOXML_IDX_NAME[$rec.ooxml.endCxnIdx],
      $rec.ooxml.connector.preset, $rec.ooxml.connector.adj1, $rec.ooxml.connector.lnNoFill)
    Write-Output ("  xfrm：off=({0},{1}) ext=({2},{3}) rot='{4}' flipH='{5}' flipV='{6}'" -f `
        $rec.ooxml.connector.offX, $rec.ooxml.connector.offY, $rec.ooxml.connector.extCx, $rec.ooxml.connector.extCy,
      $rec.ooxml.connector.rot, $rec.ooxml.connector.flipH, $rec.ooxml.connector.flipV)
    Write-Output "  走线判读：$($rec.route.route)"
    Write-Output "  判据全通过：$($rec.route.allPass)"
    foreach ($k in $rec.route.checks.Keys) {
      Write-Output ("    [{0}] {1} —— {2}" -f $(if ($rec.route.checks[$k].pass) { '通过' } else { '不通过' }), $k, $rec.route.checks[$k].observed)
    }
  }

  $records += $rec
}

# ---------------- 落盘采集结果 ----------------
$procsAfter = @(Get-Process -Name wps, wpp, et, wpscloudsvr, wpscenter -ErrorAction SilentlyContinue |
  ForEach-Object { [ordered]@{ name = $_.ProcessName; id = $_.Id; start = $_.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } })

$result = [ordered]@{
  env        = $envFacts
  combos     = $combos
  records    = $records
  procsBefore = $procsBefore
  procsAfter = $procsAfter
  probeEnd   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$jsonPath = if ($ResultJson) { $ResultJson } else { Join-Path $outDir 'P8-elbow-records.json' }
Write-LfText -Path $jsonPath -Text ($result | ConvertTo-Json -Depth 12)
Write-Output ''
Write-Output "采集结果：$jsonPath"

$newProcs = @($procsAfter | Where-Object { $_.start -ge $envFacts.probeStart -and $_.id -notin $procsBefore.id })
Write-Output "运行前已有 WPS 系进程：$($procsBefore.Count) 个（用户既有，非本次产生）"
Write-Output "本次运行期间新出现且仍存活：$($newProcs.Count) 个"
foreach ($p in $newProcs) { Write-Output ("  {0} pid={1} start={2}" -f $p.name, $p.id, $p.start) }
