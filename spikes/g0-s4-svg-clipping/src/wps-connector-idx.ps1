# G0-S-S4 · P-8 遗留 1（G4 准入）：WPS 实测 OOXML 连接点 idx 语义
#
# 要回答的问题：`a:stCxn@idx` / `a:endCxn@idx` 是 preset geometry 的连接点**序列号**，
# 不是 COM 的站点枚举值。已知事实（S1）：roundRect 的 OOXML 序列 = 0=上 1=左 2=下 3=右，
# COM = 1=上 2=左 3=下 4=右 —— **相差 1**。S1 只提供了两个**竖向样本**（COM 3/1 → 落盘 2/0）。
# 本脚本补**横向样本**：COM 4/2 → 期望落盘 idx=3（右）/ idx=1（左）。
#
# 做法与 S1 的 src/wps-native-reference.ps1 逐条对齐（WPS COM 建演示文稿 → 圆角矩形 → 命名 →
# AddConnector(2,…) 肘形 → ConnectorFormat.BeginConnect/EndConnect → SaveAs(…,24)），
# 但**参数化站点**并循环四组组合，各存一份 pptx、各 dump 一份 slide1.xml。
# 自带 Write-LfText 等价实现（spike 之间不跨目录引用；S1 的那份在
# spikes/g0-s1-pptx-connector/src/wps-common.ps1）。
#
# 用法（默认跑全部 4 组组合）：
#   pwsh -File src/wps-connector-idx.ps1
# 只跑单组：
#   pwsh -File src/wps-connector-idx.ps1 -BeginSite 4 -EndSite 2
#
# 产出（工件不入库 / 证据入库）：
#   out/P8-idx-com{COM起}-com{COM止}.pptx、out/P8-idx-probe-records.json
#   evidence/wps/P8-idx-com*-slide1.xml（LF 写入）
#   evidence/wps-idx-probe.md 由同目录的 wps-idx-report.ps1 从 JSON 生成（保证重跑一致）

[CmdletBinding()]
param(
  # COM 站点值：1=上 2=左 3=下 4=右（roundRect）
  [ValidateRange(1, 4)] [int] $BeginSite = 0,
  [ValidateRange(1, 4)] [int] $EndSite = 0,
  # 采集结果路径（默认 out/，工件不入库）
  [string] $ResultJson = ''
)

$ErrorActionPreference = 'Stop'

$script:COM_SITE_NAME = @{ 1 = '上'; 2 = '左'; 3 = '下'; 4 = '右' }
# 已知事实：roundRect 的 OOXML 连接点序列（0 基）
$script:OOXML_IDX_NAME = @{ 0 = '上'; 1 = '左'; 2 = '下'; 3 = '右' }
# 按"相差 1"规则的外推期望值（逐站点对照用）
$script:EXPECTED_OOXML_IDX = @{ 1 = 0; 2 = 1; 3 = 2; 4 = 3 }

$spikeRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $spikeRoot 'out'
$evidenceDir = Join-Path $spikeRoot 'evidence\wps'
New-Item -ItemType Directory -Force -Path $outDir, $evidenceDir | Out-Null

$SLIDE_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
$DRAW_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
# WPS COM 的长度单位是 pt，OOXML 是 EMU：12700 EMU = 1 pt
$EMU_PER_PT = 12700

# ---------------- 自带工具（不跨 spike 引用） ----------------

# 统一以 LF 写入生成的文本证据。
# 为什么必须显式归一化：PowerShell 在 Windows 上按 CRLF 写文件，而本仓库由 .gitattributes
# 强制 LF（`* text=auto eol=lf`）；不归一化则每次重跑都会让工作区"变脏"。
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

# 解包 pptx 取一个 entry 的文本（不写盘；写出交给 Write-LfText）
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

# 用 DOM 解析 slide XML（**不要**用 `<p:sp>.*?</p:sp>` 非贪婪正则：块内有同名嵌套会截断）
#
# **踩坑记录（实测，值得留给后来人）**：`XmlNamespaceManager` 实现了 IEnumerable，
# 它的枚举值是 prefix 字符串（''、'xmlns'、'xml'、…）。把它当**函数返回值**时，
# `return $ns` 与 `return ,$ns` 都会被 PowerShell 的管道展开成字符串数组——
# 后者会得到「`SelectSingleNode` 的参数计数为 2 的重载不存在」这种看不懂的报错。
# 唯一可靠写法是 `Write-Output -NoEnumerate $ns`（或 `[object]` 装箱）。
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

# 按形状名在 spTree 顶层找元素（与补丁器同一条定位口径：name 而非索引/id）
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
    if (-not $nv) { $nv = $c.SelectSingleNode('./p:nvGrpSpPr/p:cNvPr', $ns) }
    if ($nv -and $nv.GetAttribute('name') -eq $Name) { $found = $c; break }
  }
  return $found
}

# 形状的 cNvPr id / name
function Get-NodeIdName {
  param([Parameter(Mandatory)] $Node)
  $ns = New-SlideNs -Doc $Node.OwnerDocument
  $nv = $Node.SelectSingleNode('.//p:cNvPr', $ns)
  if (-not $nv) { return $null }
  return [ordered]@{ id = [int]$nv.GetAttribute('id'); name = $nv.GetAttribute('name') }
}

# 形状的 xfrm（含 rot/flip 原始属性）
function Get-NodeXfrm {
  param([Parameter(Mandatory)] $Node)
  $ns = New-SlideNs -Doc $Node.OwnerDocument
  $xfrm = $Node.SelectSingleNode('./p:spPr/a:xfrm', $ns)
  if (-not $xfrm) { return $null }
  $off = $xfrm.SelectSingleNode('./a:off', $ns)
  $ext = $xfrm.SelectSingleNode('./a:ext', $ns)
  return [ordered]@{
    offX   = if ($off) { [int]$off.GetAttribute('x') } else { $null }
    offY   = if ($off) { [int]$off.GetAttribute('y') } else { $null }
    extCx  = if ($ext) { [int]$ext.GetAttribute('cx') } else { $null }
    extCy  = if ($ext) { [int]$ext.GetAttribute('cy') } else { $null }
    rot    = $xfrm.GetAttribute('rot')
    flipH  = $xfrm.GetAttribute('flipH')
    flipV  = $xfrm.GetAttribute('flipV')
  }
}

# 一条 connector 的**量化事实**：吸附（id+idx）、几何 xfrm、preset、adj1
function Get-ConnectorFacts {
  param(
    [Parameter(Mandatory)] [string] $SlideXml,
    [Parameter(Mandatory)] [string] $ConnectorName
  )
  $doc = Get-SlideDoc -SlideXml $SlideXml
  $ns = New-SlideNs -Doc $doc
  $node = Get-ShapeNodeByName -Doc $doc -Name $ConnectorName
  if (-not $node) { throw "slide XML 里找不到名为 $ConnectorName 的形状" }

  $idName = Get-NodeIdName -Node $node
  $st = $node.SelectSingleNode('.//a:stCxn', $ns)
  $en = $node.SelectSingleNode('.//a:endCxn', $ns)
  $prst = $node.SelectSingleNode('./p:spPr/a:prstGeom', $ns)
  $adj = $null
  if ($prst) {
    $gd = $prst.SelectSingleNode('./a:avLst/a:gd[@name="adj1"]', $ns)
    if ($gd) {
      $m = [regex]::Match([string]$gd.GetAttribute('fmla'), '(-?\d+)\s*$')
      if ($m.Success) { $adj = [int]$m.Groups[1].Value }
    }
  }
  return [ordered]@{
    connectorName = $ConnectorName
    cNvPrId       = $idName.id
    stCxn         = if ($st) { [ordered]@{ id = [int]$st.GetAttribute('id'); idx = [int]$st.GetAttribute('idx') } } else { $null }
    endCxn        = if ($en) { [ordered]@{ id = [int]$en.GetAttribute('id'); idx = [int]$en.GetAttribute('idx') } } else { $null }
    stIdxName     = if ($st) { $script:OOXML_IDX_NAME[[int]$st.GetAttribute('idx')] } else { $null }
    endIdxName    = if ($en) { $script:OOXML_IDX_NAME[[int]$en.GetAttribute('idx')] } else { $null }
    preset        = if ($prst) { $prst.GetAttribute('prst') } else { $null }
    adj1          = $adj
    xfrm          = Get-NodeXfrm -Node $node
  }
}

# WPS COM 自报属性。**陷阱**：WPS 自报 Name="Microsoft PowerPoint"、Version="12.0"，
# 这是伪装字符串，**不构成"用 Microsoft PowerPoint 验证过"的证据**。
function Get-WpsAppSelfReport {
  param([Parameter(Mandatory)] $App)
  $r = [ordered]@{ name = '(未取到)'; version = '(未取到)'; build = '(未取到)'; path = '(未取到)' }
  try { $r.name = [string]$App.Name } catch { $r.name = "(取 Name 失败：$($_.Exception.Message))" }
  try { $r.version = [string]$App.Version } catch { $r.version = "(取 Version 失败：$($_.Exception.Message))" }
  try { $r.build = [string]$App.Build } catch { $r.build = "(取 Build 失败：$($_.Exception.Message))" }
  try { $r.path = [string]$App.Path } catch { $r.path = "(取 Path 失败：$($_.Exception.Message))" }
  return $r
}

# 记录本次运行前的 WPS 进程（含启动时间），用于事后判"有没有残留"
function Get-WpsProcessSnapshot {
  $procs = @(Get-Process -Name wps, wpp, et, wpscloudsvr, wpscenter -ErrorAction SilentlyContinue |
    ForEach-Object { [ordered]@{ name = $_.ProcessName; id = $_.Id; start = $_.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } })
  return , $procs
}

# ---------------- 组合定义 ----------------
# 至少包含两组关键样本：竖向对照（3/1，与 S1 参照脚本同参）+ 横向样本（4/2，按相差 1 → 3/1）。
# 另补 1/1（上→上）与 3/3（下→下）作为同站点组合的冗余样本。
if ($BeginSite -gt 0 -and $EndSite -gt 0) {
  $combos = @([pscustomobject]@{ begin = $BeginSite; end = $EndSite })
} else {
  $combos = @(
    [pscustomobject]@{ begin = 1; end = 1 }   # 上 → 上
    [pscustomobject]@{ begin = 3; end = 1 }   # 下 → 上（= S1 原参照参数，竖向对照）
    [pscustomobject]@{ begin = 4; end = 2 }   # 右 → 左（**横向样本，本遗留的主目标**）
    [pscustomobject]@{ begin = 3; end = 3 }   # 下 → 下
  )
}

$procsBefore = Get-WpsProcessSnapshot
$records = @()
$envFacts = [ordered]@{
  psVersion   = $PSVersionTable.PSVersion.ToString()
  wpsInstall  = (Test-Path "$env:LOCALAPPDATA\Kingsoft\WPS Office")
  slideW      = 960
  slideH      = 540
  probeStart  = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  app         = $null
  procsBefore = $procsBefore
}

foreach ($combo in $combos) {
  $b = [int]$combo.begin
  $e = [int]$combo.end
  $tag = "com$b-com$e"
  $pptxPath = Join-Path $outDir "P8-idx-$tag.pptx"
  $xmlPath = Join-Path $evidenceDir "P8-idx-$tag-slide1.xml"
  if (Test-Path $pptxPath) { Remove-Item $pptxPath -Force }

  Write-Output ''
  Write-Output "=== 组合 $tag：BeginConnect = $b（$($script:COM_SITE_NAME[$b])） / EndConnect = $e（$($script:COM_SITE_NAME[$e])） ==="

  $app = $null; $pres = $null
  $rec = [ordered]@{
    tag           = $tag
    comBegin      = $b
    comEnd        = $e
    comBeginName  = $script:COM_SITE_NAME[$b]
    comEndName    = $script:COM_SITE_NAME[$e]
    expectedBegin = $script:EXPECTED_OOXML_IDX[$b]
    expectedEnd   = $script:EXPECTED_OOXML_IDX[$e]
    pptx          = $pptxPath
    xml           = $xmlPath
    comGeometry   = $null
    error         = $null
    facts         = $null
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

    # 落盘前的 COM 侧几何（注意单位：WPS COM 的长度是 **pt**，OOXML 是 EMU）
    $geom = [ordered]@{
      barA_L = [double]$barA.Left; barA_T = [double]$barA.Top; barA_W = [double]$barA.Width; barA_H = [double]$barA.Height
      barB_L = [double]$barB.Left; barB_T = [double]$barB.Top; barB_W = [double]$barB.Width; barB_H = [double]$barB.Height
      conn_L = [double]$conn.Left; conn_T = [double]$conn.Top; conn_W = [double]$conn.Width; conn_H = [double]$conn.Height
    }
    try { $geom.connType = [int]$conn.ConnectorFormat.Type } catch { $geom.connType = $null }
    try { $geom.beginConnected = [bool]$conn.ConnectorFormat.BeginConnected } catch { $geom.beginConnected = $null }
    try { $geom.endConnected = [bool]$conn.ConnectorFormat.EndConnected } catch { $geom.endConnected = $null }
    # 备注：BeginConnectedShape 返回的是**形状**、不是站点号；`Shape.ConnectionSite` 在 WPS 上
    # 不可靠。因此 COM 侧的站点号**不能作为判据**，判据只用落盘 XML 的 idx。
    try { $geom.beginConnectedShapeName = [string]$conn.ConnectorFormat.BeginConnectedShape.Name } catch { $geom.beginConnectedShapeName = $null }
    try { $geom.endConnectedShapeName = [string]$conn.ConnectorFormat.EndConnectedShape.Name } catch { $geom.endConnectedShapeName = $null }
    $rec.comGeometry = $geom
    Write-Output ("  COM 侧：conn L={0} T={1} W={2} H={3}（pt）；BeginConnected={4}({6}) EndConnected={5}({7})" -f `
        $geom.conn_L, $geom.conn_T, $geom.conn_W, $geom.conn_H, $geom.beginConnected, $geom.endConnected,
      $geom.beginConnectedShapeName, $geom.endConnectedShapeName)

    $pres.SaveAs($pptxPath, 24)  # ppSaveAsOpenXMLPresentation
    if (-not (Test-Path $pptxPath)) { throw "另存失败：$pptxPath" }
    Write-Output "  已另存：$pptxPath ($((Get-Item $pptxPath).Length) bytes)"
  }
  catch {
    $rec.error = "$($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Write-Output "  !! 组合 $tag 失败：$($rec.error)"
  }
  finally {
    if ($pres) { try { $pres.Close() } catch {} }
    if ($app) { try { $app.Quit() } catch {}; try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {} }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }

  if (-not $rec.error -and (Test-Path $pptxPath)) {
    $xml = Get-PptxEntryText -PptxPath $pptxPath -EntryName 'ppt/slides/slide1.xml'
    Write-LfText -Path $xmlPath -Text $xml
    $facts = Get-ConnectorFacts -SlideXml $xml -ConnectorName 'dep-1'

    $doc = Get-SlideDoc -SlideXml $xml
    foreach ($barName in @('bar-a', 'bar-b')) {
      $barNode = Get-ShapeNodeByName -Doc $doc -Name $barName
      $idName = if ($barNode) { Get-NodeIdName -Node $barNode } else { $null }
      # 键名写死，别用字符串替换（`bar-a` → `baraId` 会被 WPS/JSON 吃成小写，看着像 bug）
      $key = if ($barName -eq 'bar-a') { 'barAId' } else { 'barBId' }
      $xkey = if ($barName -eq 'bar-a') { 'barAXfrm' } else { 'barBXfrm' }
      $facts[$key] = if ($idName) { $idName.id } else { $null }
      $facts[$xkey] = if ($barNode) { Get-NodeXfrm -Node $barNode } else { $null }
    }
    # 附上原始 slide1.xml 全文与 connector 片段（报告里做"原始证据"，重跑一致）
    $facts.slideXml = $xml
    $facts.cxnSpLocks = ([regex]::Matches($xml, 'cxnSpLocks')).Count
    $mBlock = [regex]::Match($xml, '<p:cxnSp>.*?</p:cxnSp>', 'Singleline')
    $facts.connectorXml = if ($mBlock.Success) { $mBlock.Value } else { $null }
    # COM(pt) 与 OOXML(EMU) 的同一几何互校（用于证明"dump 就是这份 pptx"）
    $facts.comCrossCheck = [ordered]@{
      connLeftEmuFromCom  = [int]([math]::Round($rec.comGeometry.conn_L * $EMU_PER_PT))
      connTopEmuFromCom   = [int]([math]::Round($rec.comGeometry.conn_T * $EMU_PER_PT))
      connWidthEmuFromCom = [int]([math]::Round($rec.comGeometry.conn_W * $EMU_PER_PT))
      connHeightEmuFromCom = [int]([math]::Round($rec.comGeometry.conn_H * $EMU_PER_PT))
    }
    $rec.facts = $facts

    Write-Output ("  落盘：stCxn id={0} idx={1}（{2}；期望 {3}）；endCxn id={4} idx={5}（{6}；期望 {7}）" -f `
        $facts.stCxn.id, $facts.stCxn.idx, $facts.stIdxName, $rec.expectedBegin,
      $facts.endCxn.id, $facts.endCxn.idx, $facts.endIdxName, $rec.expectedEnd)
    Write-Output ("  bar-a id={0} bar-b id={1}；connector xfrm off=({2},{3}) ext=({4},{5}) attrs='{6}' preset={7} adj1={8}" -f `
        $facts.barAId, $facts.barBId, $facts.xfrm.offX, $facts.xfrm.offY, $facts.xfrm.extCx, $facts.xfrm.extCy,
      (($facts.xfrm.rot, $facts.xfrm.flipH, $facts.xfrm.flipV) -join '/'), $facts.preset, $facts.adj1)
    Write-Output "  dump：$xmlPath（$($xml.Length) chars）"
  }

  $records += $rec
}

# ---------------- 落盘采集结果（原始证据） ----------------
$procsAfter = Get-WpsProcessSnapshot
$result = [ordered]@{
  env          = $envFacts
  combos       = $combos
  records      = $records
  procsAfter   = $procsAfter
  probeEnd     = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$jsonPath = if ($ResultJson) { $ResultJson } else { Join-Path $outDir 'P8-idx-probe-records.json' }
Write-LfText -Path $jsonPath -Text ($result | ConvertTo-Json -Depth 8)
Write-Output ''
Write-Output "采集结果：$jsonPath"

# ---------------- 控制台对照表 ----------------
Write-Output ''
Write-Output 'COM 站点 → OOXML idx（本次实测）'
Write-Output '| 组合 | BeginConnect(COM) | 落盘 stCxn idx | 期望 | EndConnect(COM) | 落盘 endCxn idx | 期望 |'
Write-Output '|---|---|---|---|---|---|---|'
foreach ($r in $records) {
  if ($r.error) {
    Write-Output "| $($r.tag) | $($r.comBegin) | (失败) | $($r.expectedBegin) | $($r.comEnd) | (失败) | $($r.expectedEnd) |"
  } else {
    Write-Output "| $($r.tag) | $($r.comBegin)（$($r.comBeginName)） | $($r.facts.stCxn.idx) | $($r.expectedBegin) | $($r.comEnd)（$($r.comEndName)） | $($r.facts.endCxn.idx) | $($r.expectedEnd) |"
  }
}

# ---------------- 残留进程检查 ----------------
# 只报"本次运行开始后才存在"的进程，避免把用户既有的常驻 wps 进程误报为残留。
$newProcs = @($procsAfter | Where-Object { $_.start -ge $envFacts.probeStart -and $_.id -notin $procsBefore.id })
Write-Output ''
Write-Output "运行前已有 WPS 系进程：$($procsBefore.Count) 个（用户既有，非本次产生）"
Write-Output "本次运行期间新出现且仍存活：$($newProcs.Count) 个"
foreach ($p in $newProcs) { Write-Output ("  {0} pid={1} start={2}" -f $p.name, $p.id, $p.start) }
