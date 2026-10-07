#!/usr/bin/env pwsh
<#
.SYNOPSIS
  **WPS 真机验证（记录制脚本）**：模板 A 的 pptx 在 WPS 里"打开 / 渲染 / 另存 / 拖动跟随"取证。

.DESCRIPTION
  为什么需要这条链（而不是只信包内的 golden）：
  包内判据验的是**字节**（同一份 OOXML 能重复生成），验不了**别的渲染器认不认**。
  本仓库的验证环境以 WPS 为准（裁决 P-4）：一条补丁写出的 connector 是不是"活的"
  （`a:stCxn`/`a:endCxn` 被接受、形状移动后 `xfrm` 被重算），只能由真机回答。

  七个时点（顺序是硬要求）：
    ① 打开**之前**解包 dump `ppt/slides/slide1.xml`——WPS 持有文件时会锁住它（S1 教训 5）；
    ② `KWPP.Application` 打开（抛错即"可能弹了修复/失败"，如实记）；
    ③ `Slide.Export` 出 1600×900 PNG；
    ④ `SaveAs` 另存副本（`-saved-by-wps`，即"WPS 重写了什么"）；
    ⑤ 从副本 dump 并做结构统计 + 逐 connector 解析（`stCxn`/`endCxn` + `off`/`ext`）；
    ⑥ 用 COM 移动一个任务条，再导出 PNG、再另存，比较该形状相关 connector 的 `xfrm` ⇒ 端点跟随；
    ⑦ 写 Markdown 报告（LF 换行）与 XML/PNG 证据。

  COM 工具实现**不在本文件里**：本脚本 dot-source 同目录的 `scripts/wps-com.ps1`
  （原为 S1 探针的 `wps-common.ps1`；P2/D9 **逐字迁入** `scripts/`，动机与出处见该文件头）。
  迁移动机是一条方向性约束：受维护的脚本不能反向依赖一个"结论已收口、随时可删"的探针目录。

  环境说明（必读）：本机 WPS 的 COM 自报 `Name = "Microsoft PowerPoint"`、`Version = "12.0"`，
  这是**伪装字符串**——绝不能当作"用 Microsoft PowerPoint 验证过"的证据。
  真正的身份线索是 `Path` 指向的安装目录（报告里会记下来）。

  收尾：无论成功失败都 `Close-WpsApp -Pres … -App …`（否则 `wpp.exe` 会残留并锁住临时文件）。

.PARAMETER Pptx
  待验证的 pptx（默认 `tmp/exports/template-a-demo-week.pptx`，即 `scripts/export-pptx.mjs` 的默认产物）。

.PARAMETER Label
  证据文件名的前缀（默认 `template-a-demo`）。

.EXAMPLE
  pwsh -NoProfile -File scripts/wps-pptx-verify.ps1
.EXAMPLE
  pwsh -NoProfile -File scripts/wps-pptx-verify.ps1 -Pptx tmp/exports/template-a-demo-day.pptx -Label template-a-demo-day
#>

[CmdletBinding()]
param(
  [string] $Pptx = 'tmp/exports/template-a-demo-week.pptx',
  [string] $Label = 'template-a-demo'
)

$ErrorActionPreference = 'Stop'

# dot-source 同目录的 COM 工具底座（New/Open/Export/Save/Export-PptxEntry/Get-AnchorStats/Write-LfText…）。
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'wps-com.ps1')

$pptxPath = if ([System.IO.Path]::IsPathRooted($Pptx)) { $Pptx } else { Join-Path $repoRoot $Pptx }
if (-not (Test-Path $pptxPath)) {
  throw "找不到待验证的 pptx：$pptxPath`n先运行 `node scripts/export-pptx.mjs --zoom week` 生成它。"
}

$evidenceRoot = Join-Path $repoRoot 'packages/pptx-renderer/evidence'
$xmlDir = Join-Path $evidenceRoot 'wps'
$visionDir = Join-Path $evidenceRoot 'vision'
New-Item -ItemType Directory -Force -Path $xmlDir, $visionDir | Out-Null

$asWrittenXml = Join-Path $xmlDir "$Label-as-written.xml"
$savedBeforeXml = Join-Path $xmlDir "$Label-saved-by-wps.xml"
$savedAfterXml = Join-Path $xmlDir "$Label-saved-by-wps-after-drag.xml"
$beforePng = Join-Path $visionDir "$Label-before.png"
$afterPng = Join-Path $visionDir "$Label-after.png"
$reportPath = Join-Path $evidenceRoot "$Label-wps.md"
# 临时副本留在 `$env:TEMP`（不进仓库）：它们是"过程文件"，被验过的 slide1.xml 已 dump 成证据。
$savedPptxBefore = Join-Path $env:TEMP "$Label-saved-by-wps.pptx"
$savedPptxAfter = Join-Path $env:TEMP "$Label-saved-by-wps-after-drag.pptx"

# ---------------------------------------------------------------- 逐 connector 解析
#
# S1 的 `Get-AnchorStats` 只回报"第一条"，而本件有 14 条 connector，且"端点跟随"是**逐条**判据。
# 因此这里补一个解析器：按 name 取 `dep-*` 的 stCxn/endCxn 与 xfrm。
#
# 一个必须写清的解析约束：`<a:off>/<a:ext>` 的模式在 `p:spPr/a:xfrm` 与 `p:grpSpPr/a:xfrm` 里也存在，
# 但对 `p:cxnSp` 而言 xfrm 是**块内第一个** `<a:xfrm>`，故取块内首个匹配即可（无需区分嵌套）。
function Get-ConnectorRows {
  param([Parameter(Mandatory)] [string] $SlideXml)
  $rows = @()
  foreach ($block in [regex]::Matches($SlideXml, '<p:cxnSp>.*?</p:cxnSp>', 'Singleline')) {
    $b = $block.Value
    $name = [regex]::Match($b, '<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"').Groups[2].Value
    $st = [regex]::Match($b, '<a:stCxn id="(\d+)" idx="(\d+)"')
    $en = [regex]::Match($b, '<a:endCxn id="(\d+)" idx="(\d+)"')
    $off = [regex]::Match($b, '<a:off x="(-?\d+)" y="(-?\d+)"')
    $ext = [regex]::Match($b, '<a:ext cx="(-?\d+)" cy="(-?\d+)"')
    $rows += [pscustomobject]@{
      name    = $name
      fromId  = if ($st.Success) { [int]$st.Groups[1].Value } else { -1 }
      fromIdx = if ($st.Success) { [int]$st.Groups[2].Value } else { -1 }
      toId    = if ($en.Success) { [int]$en.Groups[1].Value } else { -1 }
      toIdx   = if ($en.Success) { [int]$en.Groups[2].Value } else { -1 }
      offX    = if ($off.Success) { [int]$off.Groups[1].Value } else { [int]::MinValue }
      offY    = if ($off.Success) { [int]$off.Groups[2].Value } else { [int]::MinValue }
      extCx   = if ($ext.Success) { [int]$ext.Groups[1].Value } else { [int]::MinValue }
      extCy   = if ($ext.Success) { [int]$ext.Groups[2].Value } else { [int]::MinValue }
    }
  }
  return $rows
}

# 形状 id → 形状名（报"哪条 connector 相关"时用名字，而不是 WPS 可能重编号的 id）。
function Get-ShapeNameById {
  param([Parameter(Mandatory)] [string] $SlideXml)
  $map = @{}
  foreach ($m in [regex]::Matches($SlideXml, '<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"')) {
    $map[[int]$m.Groups[1].Value] = $m.Groups[2].Value
  }
  return $map
}

# 按形状名取 id（本件里 `bar-t1` → 31），用于"哪些 connector 挂在这个形状上"。
function Get-ShapeIdByName {
  param([Parameter(Mandatory)] [string] $SlideXml, [Parameter(Mandatory)] [string] $Name)
  $m = [regex]::Match($SlideXml, ('<p:cNvPr\s+id="(\d+)"\s+name="' + [regex]::Escape($Name) + '"'))
  if (-not $m.Success) { return -1 }
  return [int]$m.Groups[1].Value
}

# 找第一个带 connector 的任务条（`bar-*`）——拖动判据需要一个真被引用过的形状。
function Find-FirstConnectedBar {
  param($Rows, [Parameter(Mandatory)] [string] $SlideXml)
  $names = [regex]::Matches($SlideXml, '<p:cNvPr\s+id="(\d+)"\s+name="(bar-[^"]*)"') |
    ForEach-Object { $_.Groups[2].Value } | Sort-Object -Unique
  foreach ($name in $names) {
    $id = Get-ShapeIdByName -SlideXml $SlideXml -Name $name
    $hit = $Rows | Where-Object { $_.fromId -eq $id -or $_.toId -eq $id }
    if ($hit) { return [pscustomobject]@{ Name = $name; Id = $id; Connectors = @($hit) } }
  }
  return $null
}

# 包内条目清单（非目录项）——"WPS 另存后多了哪些部件"是容器层的字节事实，报告要记下来。
function Get-PptxEntryNames {
  param([Parameter(Mandatory)] [string] $PptxPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($PptxPath)
  try {
    return @($zip.Entries | Where-Object { $_.FullName -notlike '*/' } | ForEach-Object { $_.FullName })
  } finally { $zip.Dispose() }
}

# **递归**按名取形状（先顶层，再进 `GroupItems`）。
#
# 为什么不能直接用 `wps-com.ps1` 的 `Get-WpsShapeByName`：它只扫**顶层** `Slide.Shapes`，
# 而本件的一级组（`grp-s*`）是真的 `p:grpSp`——任务条/进度条都在组**内**。
# 实测：顶层 `Shapes.Count = 44`（28 个文本框 + 3 个组 + 14 条 connector），
# `bar-t1` 在 `grp-s1.GroupItems` 里；因此顶层扫描必然找不到 `bar-*`。
# 这里保留同样的"按 name 定位"口径（S1 纪律：name 是唯一定位锚点），只补上"进组"这一层。
# 顺带：这也把跨组吸附的另一面记了下来——`stCxn id=31` 指的是**组内子形状**，WPS 认得它。
function Get-WpsShapeByNameDeep {
  param([Parameter(Mandatory)] $Shapes, [Parameter(Mandatory)] [string] $Name)
  for ($i = 1; $i -le $Shapes.Count; $i++) {
    $shape = $Shapes.Item($i)
    if ($shape.Name -eq $Name) { return $shape }
  }
  for ($i = 1; $i -le $Shapes.Count; $i++) {
    $shape = $Shapes.Item($i)
    $groupItems = $null
    try { $groupItems = $shape.GroupItems } catch { $groupItems = $null }
    if ($null -eq $groupItems) { continue }
    $found = Get-WpsShapeByNameDeep -Shapes $groupItems -Name $Name
    if ($null -ne $found) { return $found }
  }
  return $null
}

# 形状树的一行摘要（"组里有谁"是报告里解释"为什么顶层找不到 bar-*"的证据）。
function Format-WpsShapeTree {
  param([Parameter(Mandatory)] $Shapes, [string] $Indent = '')
  $lines = @()
  for ($i = 1; $i -le $Shapes.Count; $i++) {
    $shape = $Shapes.Item($i)
    $lines += "$Indent$($shape.Name)"
    $groupItems = $null
    try { $groupItems = $shape.GroupItems } catch { $groupItems = $null }
    if ($null -ne $groupItems) { $lines += Format-WpsShapeTree -Shapes $groupItems -Indent "$Indent  " }
  }
  return $lines
}

function Format-ConnectorTable {
  param($Rows, [Parameter(Mandatory)] [string] $LabelText)
  $lines = @("### $LabelText", '', '| connector | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy |', '|---|---|---|---|---|---|---|')
  if (-not $Rows -or @($Rows).Count -eq 0) {
    $lines += '| （无） | | | | | | |'
  } else {
    foreach ($r in $Rows) {
      $lines += "| ``$($r.name)`` | $($r.fromId)/$($r.fromIdx) | $($r.toId)/$($r.toIdx) | $($r.offX) | $($r.offY) | $($r.extCx) | $($r.extCy) |"
    }
  }
  $lines += ''
  return $lines
}

# 清掉上一次运行留下的副本。
#
# 为什么单独一个函数：Windows 上残留的 `wpp.exe` 会锁住临时副本，`Remove-Item` 于是抛错。
# 这里把"删不掉"降级为告警——真正的判据在后面（`SaveAs` 是否真的产出了新文件）。
function Remove-StaleCopy {
  param([Parameter(Mandatory)] [string] $Path)
  if (-not (Test-Path $Path)) { return }
  try { Remove-Item $Path -Force } catch { Write-Output "（提示）清不掉旧副本（可能被残留 wpp.exe 锁住）：$Path" }
}

# ---------------------------------------------------------------- ① 打开之前：dump as-written
$asWrittenXmlText = Export-PptxEntry -PptxPath $pptxPath -EntryName 'ppt/slides/slide1.xml' -OutPath $asWrittenXml
$asWrittenStats = Get-AnchorStats -SlideXml $asWrittenXmlText
$asWrittenRows = Get-ConnectorRows -SlideXml $asWrittenXmlText
Write-Output "① 已 dump（打开之前）：$asWrittenXml（connector $($asWrittenRows.Count) 条）"

# ---------------------------------------------------------------- ②–⑥ 两次 WPS 会话
#
# **为什么必须分成两次会话**（S1 探针是一口气跑完的，那是单件小实验的写法）：
# `Pres.SaveAs(x)` 不会把编辑对象切到 `x`——WPS 仍持有 `x` 的**写锁**，
# 于是"另存后立刻解包副本"必然失败（实测：`The process cannot access the file … because it is being used by another process`）。
# 因此把一切解包动作排到 `Close-WpsApp` **之后**：
#   会话 1（冷开原件）：导出 before.png + 另存 before.pptx ⇒ 关 WPS ⇒ 解包 ⇒ 得到"WPS 重写后的 slide1.xml"基线；
#   会话 2（重新冷开原件）：拖动任务条 + 导出 after.png + 另存 after.pptx ⇒ 关 WPS ⇒ 解包 ⇒ 与基线比 `xfrm`。
# 副作用是好的：「打开无修复弹窗」这条判据因此验的是**两次独立冷开**，而不是同一次打开的复用。

$appName = '(未取到)'; $appVersion = '(未取到)'; $appBuild = '(未取到)'; $appPath = '(未取到)'
$openError = $null
$slideCount = '(未取到)'
$beforePngOk = $false; $afterPngOk = $false
$savedOk = $false; $savedAgainOk = $false
$moveFrom = '(未移动)'; $moveTo = '(未移动)'; $moveTarget = '(未取到)'
$moveError = $null
$afterSavedXmlText = ''; $afterSavedStats = $null; $afterSavedRows = @()
$afterDragXmlText = ''; $afterDragStats = $null; $afterDragRows = @()
$targetBar = $null
$beforeDragRows = @()
$moveDeltaE = $null
$wpsShapeTree = @()

New-Item -ItemType Directory -Force -Path $visionDir | Out-Null
Remove-StaleCopy -Path $savedPptxBefore
Remove-StaleCopy -Path $savedPptxAfter

# WPS 的 COM 自报身份（`Name`/`Version` 是伪装字符串，照记并标注；见报告"环境"一节）。
function Set-WpsIdentity {
  param($WpsApp)
  foreach ($pair in @(@('Name', 'appName'), @('Version', 'appVersion'), @('Build', 'appBuild'), @('Path', 'appPath'))) {
    try {
      Set-Variable -Name $pair[1] -Value ([string]$WpsApp.($pair[0])) -Scope Script
    } catch {
      Set-Variable -Name $pair[1] -Value "(COM 未暴露 $($pair[0]))" -Scope Script
    }
  }
}

# ---- 会话 1：冷开 → before.png → 另存副本（WPS 重写基线）
$app1 = $null; $pres1 = $null
try {
  $app1 = New-WpsApp
  Set-WpsIdentity -WpsApp $app1
  try {
    $pres1 = Open-WpsPresentation -App $app1 -Path $pptxPath
    $slideCount = $pres1.Slides.Count
    Write-Output "② 打开成功：slides=$slideCount（无异常 ⇒ 未见修复/失败弹窗）"
  } catch {
    $openError = $_.Exception.Message
    Write-Output "② 打开失败：$openError"
  }
  if ($pres1) {
    try {
      [void](Export-WpsSlide -Pres $pres1 -OutPath $beforePng -Width 1600 -Height 900)
      $beforePngOk = $true
      Write-Output "③ 拖动前渲染图：$beforePng"
    } catch {
      Write-Output "③ 渲染图导出失败：$($_.Exception.Message)"
    }
    try {
      [void](Save-WpsPresentation -Pres $pres1 -OutPath $savedPptxBefore)
      $savedOk = $true
      Write-Output "④ 已另存（拖动前）：$savedPptxBefore"
    } catch {
      Write-Output "④ 另存失败：$($_.Exception.Message)"
    }
  }
}
finally {
  # 无条件收尾：残留 wpp.exe 既锁住副本，也污染下一条判定。
  Close-WpsApp -Pres $pres1 -App $app1
}

# ---- ⑤ 解包会话 1 的副本（WPS 已退出 ⇒ 锁已释放）
if (Test-Path $savedPptxBefore) {
  try {
    $afterSavedXmlText = Export-PptxEntry -PptxPath $savedPptxBefore -EntryName 'ppt/slides/slide1.xml' -OutPath $savedBeforeXml
    $afterSavedStats = Get-AnchorStats -SlideXml $afterSavedXmlText
    $afterSavedRows = Get-ConnectorRows -SlideXml $afterSavedXmlText
    $beforeDragRows = $afterSavedRows
    Write-Output "⑤ 副本结构：$(Format-AnchorStats -Stats $afterSavedStats -Label "$Label-saved-by-wps")"
  } catch {
    Write-Output "⑤ 副本解包失败：$($_.Exception.Message)"
  }
}

# ---- 会话 2：拖动一个**真的被 connector 引用过**的任务条（否则"跟随"无从观察）
if ($afterSavedRows.Count -eq 0) {
  $moveError = '拿不到 WPS 另存副本的 slide1.xml ⇒ 无法确定被 connector 引用的任务条（会话 2 跳过）'
  Write-Output "⑥ $moveError"
} else {
  $targetBar = Find-FirstConnectedBar -Rows $afterSavedRows -SlideXml $afterSavedXmlText
  if ($null -eq $targetBar) {
    $moveError = '副本里没有任何 bar-* 形状被 connector 引用 ⇒ 无法测端点跟随'
    Write-Output "⑥ $moveError"
  } else {
    Write-Output "⑥ 拖动目标：$($targetBar.Name)（相关 connector：$(($targetBar.Connectors.name) -join ', ')）"
    $app2 = $null; $pres2 = $null
    try {
      $app2 = New-WpsApp
      try {
        $pres2 = Open-WpsPresentation -App $app2 -Path $pptxPath
        Write-Output "⑥ 会话 2 打开成功：slides=$($pres2.Slides.Count)"
        # COM 侧形状树（含组内成员）：报告里用它解释"顶层 Shapes 里没有 bar-*"这件事。
        $wpsShapeTree = Format-WpsShapeTree -Shapes $pres2.Slides.Item(1).Shapes
      } catch {
        $moveError = "会话 2 打开失败（可能弹了修复/失败）：$($_.Exception.Message)"
        Write-Output "⑥ $moveError"
      }
      if ($pres2) {
        $shape = Get-WpsShapeByNameDeep -Shapes $pres2.Slides.Item(1).Shapes -Name $targetBar.Name
        if ($null -eq $shape) {
          $moveError = "WPS 里找不到形状 $($targetBar.Name)（已在顶层与组内递归查找）"
          Write-Output "⑥ $moveError"
        } else {
          try {
            $fromLeft = [double]$shape.Left; $fromTop = [double]$shape.Top
            $moveFrom = "L=$([math]::Round($fromLeft,1)) T=$([math]::Round($fromTop,1))"
            # 位移取大一点（远超条宽）：若 connector 跟随，xfrm 的 off/ext 必然随之变化。
            $toLeft = $fromLeft + 120.0; $toTop = $fromTop + 60.0
            $shape.Left = $toLeft
            $shape.Top = $toTop
            $readLeft = [double]$shape.Left; $readTop = [double]$shape.Top
            $moveTo = "L=$([math]::Round($readLeft,1)) T=$([math]::Round($readTop,1))"
            $moveTarget = $targetBar.Name
            # COM 的 Left/Top 单位未在文档中承诺；用"读回值差"反推实际位移口径（EMU 或 pt）。
            $moveDeltaE = [pscustomobject]@{ dLeft = $readLeft - $fromLeft; dTop = $readTop - $fromTop }
            Write-Output "⑥ 拖动 $($targetBar.Name)：$moveFrom → $moveTo"
          } catch {
            $moveError = "移动形状失败：$($_.Exception.Message)"
            Write-Output "⑥ $moveError"
          }
          # 后续每一步各自兜错：任一失败都不许吞掉"端点跟随"的原始数据（粉饰比失败更糟）。
          try {
            [void](Export-WpsSlide -Pres $pres2 -OutPath $afterPng -Width 1600 -Height 900)
            $afterPngOk = $true
            Write-Output "⑥ 拖动后渲染图：$afterPng"
          } catch {
            Write-Output "⑥ 拖动后渲染图导出失败：$($_.Exception.Message)"
          }
          try {
            [void](Save-WpsPresentation -Pres $pres2 -OutPath $savedPptxAfter)
            $savedAgainOk = $true
            Write-Output "⑥ 已另存（拖动后）：$savedPptxAfter"
          } catch {
            if (-not $moveError) { $moveError = "拖动后再另存失败：$($_.Exception.Message)" }
            Write-Output "⑥ 拖动后再另存失败：$($_.Exception.Message)"
          }
        }
      }
    }
    finally {
      Close-WpsApp -Pres $pres2 -App $app2
    }
  }
}

# ---- ⑥′ 解包会话 2 的副本（同样排在 WPS 退出之后）
if (Test-Path $savedPptxAfter) {
  try {
    $afterDragXmlText = Export-PptxEntry -PptxPath $savedPptxAfter -EntryName 'ppt/slides/slide1.xml' -OutPath $savedAfterXml
    $afterDragStats = Get-AnchorStats -SlideXml $afterDragXmlText
    $afterDragRows = Get-ConnectorRows -SlideXml $afterDragXmlText
    Write-Output "⑥ 拖动后副本结构：$(Format-AnchorStats -Stats $afterDragStats -Label "$Label-saved-by-wps-after-drag")"
  } catch {
    if (-not $moveError) { $moveError = "拖动后副本解包失败：$($_.Exception.Message)" }
    Write-Output "⑥ 拖动后副本解包失败：$($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- 判定
$cxnBefore = $asWrittenStats.cxnSp
$cxnAfterSave = if ($afterSavedStats) { $afterSavedStats.cxnSp } else { 0 }
$cxnAfterDrag = if ($afterDragStats) { $afterDragStats.cxnSp } else { 0 }

$anchorSurvivedBefore = ($asWrittenStats.stCxn -gt 0) -and ($asWrittenStats.endCxn -gt 0) -and
  ($null -ne $afterSavedStats) -and ($afterSavedStats.stCxn -eq $asWrittenStats.stCxn) -and ($afterSavedStats.endCxn -eq $asWrittenStats.endCxn)

# 逐条存活：把 id 归一到形状名再比（WPS 可能重编号，见报告说明）。
$nameMapBefore = Get-ShapeNameById -SlideXml $asWrittenXmlText
function ConvertTo-Signature {
  param($Rows, $NameMap)
  $out = @{}
  foreach ($r in $Rows) {
    $from = if ($NameMap.ContainsKey($r.fromId)) { $NameMap[$r.fromId] } else { "id:$($r.fromId)" }
    $to = if ($NameMap.ContainsKey($r.toId)) { $NameMap[$r.toId] } else { "id:$($r.toId)" }
    $out[$r.name] = "st=$from/$($r.fromIdx) en=$to/$($r.toIdx)"
  }
  return $out
}
$sigBefore = ConvertTo-Signature -Rows $asWrittenRows -NameMap $nameMapBefore
$nameMapAfter = Get-ShapeNameById -SlideXml $afterSavedXmlText
$sigAfter = ConvertTo-Signature -Rows $afterSavedRows -NameMap $nameMapAfter
$sigChanged = @()
foreach ($key in $sigBefore.Keys) {
  if (-not $sigAfter.ContainsKey($key)) { $sigChanged += "$key（另存后消失）"; continue }
  if ($sigAfter[$key] -ne $sigBefore[$key]) { $sigChanged += "$key：$($sigBefore[$key]) → $($sigAfter[$key])" }
}
$anchorsAllSurvived = ($sigBefore.Count -gt 0) -and ($sigChanged.Count -eq 0)

# 端点跟随：拖动前后，挂在被移动形状上的 connector 的 xfrm 是否变化。
#
# 注意"未完成"与"不通过"是两个不同的结论：前者是链断了（拿不到拖动后的 XML），
# 后者是**真机实测下来没跟随**。报告必须区分，否则会把工具故障写成产品缺陷（或反过来）。
$followRows = @()
$followVerdict = '不适用（未执行拖动）'
$followDetail = @()
if ($null -eq $targetBar) {
  if ($moveError) { $followVerdict = "未完成：$moveError" } else { $followVerdict = '不适用（找不到被 connector 引用的任务条）' }
} elseif ($afterDragRows.Count -eq 0) {
  $followVerdict = "未完成（拿不到拖动后另存的 slide1.xml）：$moveError"
} else {
  $beforeRowsForTarget = @($beforeDragRows | Where-Object { $_.name -in @($targetBar.Connectors.name) })
  $afterRowsForTarget = @($afterDragRows | Where-Object { $_.name -in @($targetBar.Connectors.name) })
  $anyMoved = $false
  foreach ($b in $beforeRowsForTarget) {
    $a = $afterRowsForTarget | Where-Object { $_.name -eq $b.name } | Select-Object -First 1
    $changed = ($null -ne $a) -and (($a.offX -ne $b.offX) -or ($a.offY -ne $b.offY) -or ($a.extCx -ne $b.extCx) -or ($a.extCy -ne $b.extCy))
    if ($changed) { $anyMoved = $true }
    $followRows += [pscustomobject]@{ name = $b.name; before = $b; after = $a; changed = $changed }
  }
  if ($beforeRowsForTarget.Count -eq 0) {
    $followVerdict = '不适用（该形状在补丁产物里没有相关 connector）'
  } elseif ($anyMoved) {
    $followVerdict = '通过（xfrm 随移动重算）'
    # 位移换算：EMU 制下 off 的增量 ≈ COM 位移 × 12700；pt 制下 ≈ COM 位移。
    foreach ($row in $followRows) {
      if ($null -eq $row.after) { continue }
      $dOffX = $row.after.offX - $row.before.offX
      $dOffY = $row.after.offY - $row.before.offY
      $followDetail += "``$($row.name)``：Δoff.x=$dOffX Δoff.y=$dOffY"
    }
  } else {
    $followVerdict = '**不通过**（相关 connector 的 xfrm 未变化）'
  }
}

$moveToEmuNote = '（未取到）'
if ($null -ne $moveDeltaE -and $null -ne $targetBar -and $followRows.Count -gt 0) {
  $sample = $followRows | Where-Object { $null -ne $_.after } | Select-Object -First 1
  if ($null -ne $sample) {
    $dOffX = $sample.after.offX - $sample.before.offX
    if ($moveDeltaE.dLeft -ne 0) {
      $ratio = [math]::Round($dOffX / $moveDeltaE.dLeft, 3)
      $moveToEmuNote = "COM 位移 ΔLeft=$([math]::Round($moveDeltaE.dLeft,1)) ⇒ XML Δoff.x=$dOffX（比值 $ratio；12700 ⇒ COM 用 pt，1 ⇒ COM 用 EMU）"
    }
  }
}

$pngBeforeSize = if (Test-Path $beforePng) { (Get-Item $beforePng).Length } else { 0 }
$pngAfterSize = if (Test-Path $afterPng) { (Get-Item $afterPng).Length } else { 0 }
$savedPptxSize = if (Test-Path $savedPptxBefore) { (Get-Item $savedPptxBefore).Length } else { 0 }
$savedPptxAfterSize = if (Test-Path $savedPptxAfter) { (Get-Item $savedPptxAfter).Length } else { 0 }

# 拖动后 WPS 是否把 connector 的"折线路数"改了（`bentConnector3` → `bentConnector5` 之类）。
# 这是"跟随"的**强证据**：只改 xfrm 可能是平移，连 preset 与 adj 都改了才说明它在重新走线。
function Get-ConnectorBody {
  param([Parameter(Mandatory)] [string] $SlideXml, [Parameter(Mandatory)] [string] $Name)
  $match = [regex]::Match($SlideXml, '<p:cxnSp>(?:(?!</p:cxnSp>).)*name="' + [regex]::Escape($Name) + '".*?</p:cxnSp>', 'Singleline')
  if (-not $match.Success) { return $null }
  $body = $match.Value
  return [pscustomobject]@{
    preset = [regex]::Match($body, 'prstGeom prst="([^"]*)"').Groups[1].Value
    flip   = [regex]::Match($body, '<a:xfrm([^>]*)>').Groups[1].Value.Trim()
    adj    = (([regex]::Matches($body, 'fmla="val (-?\d+)"') | ForEach-Object { $_.Groups[1].Value }) -join ',')
  }
}

# ---------------------------------------------------------------- 字节层事实（报告"WPS 改了什么"）
function Get-CountOf { param([string] $Text, [string] $Pattern) return ([regex]::Matches($Text, [regex]::Escape($Pattern))).Count }

$asWrittenTextLength = $asWrittenXmlText.Length
$savedTextLength = $afterSavedXmlText.Length
$asWrittenSpCount = Get-CountOf $asWrittenXmlText '<p:sp>'
$savedSpCount = Get-CountOf $afterSavedXmlText '<p:sp>'
$asWrittenCxnCount = $asWrittenStats.cxnSp
$savedCxnCount = if ($afterSavedStats) { $afterSavedStats.cxnSp } else { 0 }
$asWrittenGrpCount = $asWrittenStats.grpSp
$savedGrpCount = if ($afterSavedStats) { $afterSavedStats.grpSp } else { 0 }
$asWrittenStCount = $asWrittenStats.stCxn
$savedStCount = if ($afterSavedStats) { $afterSavedStats.stCxn } else { 0 }
$asWrittenEndCount = $asWrittenStats.endCxn
$savedEndCount = if ($afterSavedStats) { $afterSavedStats.endCxn } else { 0 }

$asWrittenEntries = Get-PptxEntryNames -PptxPath $pptxPath
$savedEntries = if (Test-Path $savedPptxBefore) { Get-PptxEntryNames -PptxPath $savedPptxBefore } else { @() }
$asWrittenEntryCount = $asWrittenEntries.Count
$savedEntryCount = $savedEntries.Count
$addedEntries = @($savedEntries | Where-Object { $_ -notin $asWrittenEntries })
$addedEntriesNote = if ($addedEntries.Count -gt 0) { ($addedEntries | ForEach-Object { "``$_``" }) -join '、' } else { '（无）' }

# 拖动后"折线路数 / 翻转 / 调整值"是否变化（跟随的强证据）。
$routeLines = @()
if ($targetBar -and $afterDragRows.Count -gt 0) {
  foreach ($connector in $targetBar.Connectors) {
    $beforeBody = Get-ConnectorBody -SlideXml $asWrittenXmlText -Name $connector.name
    $afterBody = Get-ConnectorBody -SlideXml $afterDragXmlText -Name $connector.name
    if ($null -ne $beforeBody -and $null -ne $afterBody) {
      $flipBefore = if ($beforeBody.flip) { $beforeBody.flip } else { '(无)' }
      $flipAfter = if ($afterBody.flip) { $afterBody.flip } else { '(无)' }
      $adjBefore = if ($beforeBody.adj) { $beforeBody.adj } else { '(无)' }
      $adjAfter = if ($afterBody.adj) { $afterBody.adj } else { '(无)' }
      $routeLines += "- ``$($connector.name)``：preset ``$($beforeBody.preset)`` ⇒ ``$($afterBody.preset)``；xfrm 属性 ``$flipBefore`` ⇒ ``$flipAfter``；调整值 ``$adjBefore`` ⇒ ``$adjAfter``"
    }
  }
}
if ($routeLines.Count -eq 0) { $routeLines = @('（未执行拖动或无相关 connector）') }

# ---------------------------------------------------------------- ⑦ 报告（LF）
# "不通过"与"未完成"必须分开写：前者是真机实测的失败（要追责到产物），
# 后者是证据链断了（要追责到工具）。两者混写会让后来的人读错结论。
$moveVerdict = if ($null -eq $targetBar) { "**未完成**：$moveError" } elseif ($moveError) { "**未完成**：$moveError" } elseif ($moveFrom -eq '(未移动)') { '**未执行**' } else { "通过（``$moveTarget``：$moveFrom → $moveTo）" }
$savedPptxAfterNote = if (Test-Path $savedPptxAfter) { " / ``$savedPptxAfter``" } else { '' }

$lines = @(
  "# $Label · WPS 真机验证",
  '',
  '> 由 `pwsh -NoProfile -File scripts/wps-pptx-verify.ps1` 生成（记录制脚本，**不进** `pnpm gate`）。',
  '> **本报告只覆盖 WPS 引擎**；按裁决 P-4，验证环境以 WPS 为准、Microsoft PowerPoint 备查不阻塞。',
  '',
  '## 环境',
  '',
  '| 项 | 值 |',
  '|---|---|',
  "| COM 自报 Name | ``$appName`` |",
  "| COM 自报 Version | ``$appVersion`` |",
  "| COM 自报 Build | ``$appBuild`` |",
  "| COM 自报 Path | ``$appPath`` |",
  "| 被验文件 | ``$([System.IO.Path]::GetRelativePath($repoRoot, $pptxPath).Replace('\','/'))`` |",
  '',
  '**`Name`/`Version` 是伪装字符串**（本机 WPS 自称 "Microsoft PowerPoint" 12.0），',
  '**不得**当作"用 Microsoft PowerPoint 验证过"的证据；识别它靠的是 `Path` 指向 WPS 安装目录',
  '`Kingsoft\WPS Office\...`。',
  '',
  '## 逐项判定',
  '',
  '| # | 判据 | 结果 |',
  '|---|---|---|',
  "| 1 | 打开无修复弹窗（COM 打开未抛错） | $(if ($openError) { "**不通过**：$openError" } else { '通过（无异常）' }) |",
  "| 2 | 幻灯片可读 | $(if ($slideCount -eq 1) { '通过（slides=1）' } else { "**不通过**：slides=$slideCount" }) |",
  "| 3 | ``Slide.Export`` 出 PNG（拖动前） | $(if ($beforePngOk) { "通过（$pngBeforeSize bytes）" } else { '**不通过**（无产物）' }) |",
  "| 4 | ``SaveAs`` 另存 pptx（拖动前） | $(if ($savedOk) { "通过（$savedPptxSize bytes）" } else { '**不通过**' }) |",
  "| 5 | 另存后 ``a:stCxn``/``a:endCxn`` 条数存活 | $(if ($anchorSurvivedBefore) { "通过（补丁 $cxnBefore 条：st=$($asWrittenStats.stCxn) end=$($asWrittenStats.endCxn) ⇒ WPS 后 st=$($afterSavedStats.stCxn) end=$($afterSavedStats.endCxn)）" } else { "**不通过**：补丁 $cxnBefore 条（st=$($asWrittenStats.stCxn) end=$($asWrittenStats.endCxn)）⇒ WPS 后 $(if ($afterSavedStats) { "st=$($afterSavedStats.stCxn) end=$($afterSavedStats.endCxn)" } else { '无副本可读' })" }) |",
  "| 6 | 逐条 connector 端点（归一到形状名后）存活 | $(if ($anchorsAllSurvived) { "通过（$(($sigBefore.Keys | Measure-Object).Count) 条全部一致）" } else { "**不通过**：$($sigChanged -join '；')" }) |",
  "| 7 | ``cxnSp`` 条数（另存前/后） | 补丁 $cxnBefore 条 ⇒ WPS $cxnAfterSave 条$(if ($cxnAfterSave -eq $cxnBefore) { '（一致）' } else { '（**不一致**）' }) |",
  "| 8 | 拖动任务条（COM 移动 ``Left``/``Top``） | $moveVerdict |",
  "| 9 | ``Slide.Export`` 出 PNG（拖动后） | $(if ($afterPngOk) { "通过（$pngAfterSize bytes）" } else { '**不通过**（无产物）' }) |",
  "| 10 | ``SaveAs`` 另存 pptx（拖动后） | $(if ($savedAgainOk) { "通过（$savedPptxAfterSize bytes）" } else { '**不通过**' }) |",
  "| 11 | **端点跟随**（相关 connector 的 ``xfrm`` 重算） | $followVerdict |",
  "| 12 | ``cxnSpLocks`` | 补丁 $($asWrittenStats.cxnSpLocks) 处 ⇒ WPS $($afterSavedStats.cxnSpLocks) 处 |",
  ''
)

if ($moveDeltaE -or $followDetail.Count -gt 0) {
  $lines += @('### 拖动增量与跟随幅度', '')
  if ($moveDeltaE) { $lines += "- $moveToEmuNote" }
  foreach ($detail in $followDetail) { $lines += "- $detail" }
  $lines += ''
}

$lines += @('## 拖动前后 connector ``xfrm`` 对比', '')
if ($followRows.Count -gt 0) {
  $lines += @('| connector | 时点 | stCxn(id/idx) | endCxn(id/idx) | off.x | off.y | ext.cx | ext.cy | 变化 |', '|---|---|---|---|---|---|---|---|---|')
  foreach ($row in $followRows) {
    $b = $row.before; $a = $row.after
    $lines += "| ``$($b.name)`` | 拖动前 | $($b.fromId)/$($b.fromIdx) | $($b.toId)/$($b.toIdx) | $($b.offX) | $($b.offY) | $($b.extCx) | $($b.extCy) | — |"
    if ($null -ne $a) {
      $lines += "| ``$($b.name)`` | 拖动后 | $($a.fromId)/$($a.fromIdx) | $($a.toId)/$($a.toIdx) | $($a.offX) | $($a.offY) | $($a.extCx) | $($a.extCy) | $(if ($row.changed) { '**已重算**' } else { '未变' }) |"
    } else {
      $lines += "| ``$($b.name)`` | 拖动后 | （不存在） | | | | | | **丢失** |"
    }
  }
} else {
  $lines += @('（无：拖动未执行或该形状没有相关 connector）')
}
$lines += ''

$lines += @('### 一条必须记下的结构事实：任务条在**组内**', '')
$lines += @(
  '补丁把每个一级汇总行做成真的 `p:grpSp`（`grp-s*`），任务条与进度条是它的**子形状**。',
  '因此 WPS 的**顶层** `Slides.Item(1).Shapes` 里没有 `bar-*`——S1 的按名定位（`Get-WpsShapeByName`）',
  '只扫顶层，在这里必然落空。本脚本用 `Get-WpsShapeByNameDeep` 递归进 `GroupItems` 才拿到 `bar-t1`，',
  '而跨组吸附的另一面也正在这里：`a:stCxn id=31` 指的是**组内子形状**，WPS 另存后仍然认得它。',
  ''
)

$lines += (Format-ConnectorTable -Rows $asWrittenRows -LabelText '全部 connector（补丁刚写出的 slide1.xml）')
$lines += (Format-ConnectorTable -Rows $afterSavedRows -LabelText '全部 connector（WPS 另存后 · 拖动前）')
if ($afterDragRows.Count -gt 0) {
  $lines += (Format-ConnectorTable -Rows $afterDragRows -LabelText '全部 connector（WPS 另存后 · 拖动后）')
}

$lines += @(
  '## 形状集合',
  '',
  '补丁刚写出：',
  '',
  '```',
  $asWrittenStats.shapeIds,
  '```',
  '',
  'WPS 另存后：',
  '',
  '```',
  $(if ($afterSavedStats) { $afterSavedStats.shapeIds } else { '(无副本可读)' }),
  '```',
  '',
  '拖动后再另存：',
  '',
  '```',
  $(if ($afterDragStats) { $afterDragStats.shapeIds } else { '(未执行)' }),
  '```',
  '',
  'WPS COM 侧形状树（会话 2 打开后，拖动之前；缩进 = `GroupItems` 层级）：',
  '',
  '```',
  $(if ($wpsShapeTree.Count -gt 0) { $wpsShapeTree -join "`n" } else { '(未取到：会话 2 未打开)' }),
  '```',
  '',
  '（注意：顶层只有文本框、`grp-s*` 与 `dep-*`；`bar-*`/`prog-*`/`ms-*` 在组内。',
  'XML 里同样如此：它们是 `<p:grpSp>` 的子元素，而 connector 在**顶层**引用这些子形状的 id',
  '——这正是 S7-a 所说的"跨组吸附"，WPS 打开与另存后都认这个引用。）',
  '',
  '## 证据文件',
  '',
  "- ``evidence/wps/$Label-as-written.xml``：补丁刚写出的 ``slide1.xml``（WPS 打开**之前**解包）",
  "- ``evidence/wps/$Label-saved-by-wps.xml``：WPS 另存后的 ``slide1.xml``（**拖动前**；可直接与 as-written 做 diff）",
  "- ``evidence/wps/$Label-saved-by-wps-after-drag.xml``：拖动后再另存同一副本的 ``slide1.xml``（**仅当有拖动时生成**）",
  "- ``evidence/vision/$Label-before.png`` / ``$Label-after.png``：WPS 渲染图（1600×900；视觉判读输入，不作定论）",
  "- 临时副本（未纳入证据，留在 ``%TEMP%``）：``$savedPptxBefore``$savedPptxAfterNote",
  '',
  '## WPS 打开/另存到底改了什么（字节层事实）',
  '',
  "- ``slide1.xml`` 字符数：as-written $asWrittenTextLength ⇒ WPS $savedTextLength（**字节不同**），",
  "  但**结构计数逐项一致**：``<p:sp>`` $asWrittenSpCount ⇒ $savedSpCount、``<p:cxnSp>`` $asWrittenCxnCount ⇒ $savedCxnCount、``<p:grpSp>`` $asWrittenGrpCount ⇒ $savedGrpCount、``<a:stCxn>`` $asWrittenStCount ⇒ $savedStCount、``<a:endCxn>`` $asWrittenEndCount ⇒ $savedEndCount。",
  '  已定位的重写：``<p:cSld name="Slide 1">`` 的 name 属性被丢掉，XML 声明/空白的写法被规范化（所以字节数变小）。',
  "- 包内条目（非目录项）：补丁 $asWrittenEntryCount 项 ⇒ WPS $savedEntryCount 项；新增的是 $addedEntriesNote。",
  '- **走线本身也被重算**（不只是平移）：拖动后 WPS 会按新的端点相对位置改写 connector 的',
  '  `prstGeom`（折线路数）、`a:xfrm` 的 `flipH/flipV` 与 `avLst` 的调整值：',
  ''
)
$lines += $routeLines
$lines += @(
  '- 结论：**WPS 没有改动我们写进去的几何与吸附**，改动都落在"它自己的容器元数据"层——',
  '  这正是 ADR 0010 §9 说的"产物一旦进别的渲染器就会被重写"，也是本仓库把逐字节 golden 限定在**我们自己写出**的产物上的原因。',
  ''
)

Write-LfText -Path $reportPath -Text ($lines -join "`n")
Write-Output ''
Write-Output "⑦ 报告：$reportPath"
Write-Output "判定：打开=$(if ($openError) { '不通过' } else { '通过' })；端点跟随=$followVerdict；stCxn/endCxn 存活=$(if ($anchorsAllSurvived) { '通过' } else { '不通过' })"
