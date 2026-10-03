# G0-S-S1 · WPS COM 共用工具
#
# 集中处理三件事，避免每个脚本各写一遍（也就避免了各写错一遍）：
#   1. COM 生命周期与**必定执行的清理**（否则 wpp.exe 会残留进程）；
#   2. 幻灯片光栅导出（`Slide.Export`，实测可用）；
#   3. pptx 解包 dump `slide1.xml`（用于 L2 结构存活与「PowerPoint/WPS 重写了什么」）。

$ErrorActionPreference = 'Stop'

# ppSaveAsOpenXMLPresentation
$script:PP_SAVE_AS_PPTX = 24

function New-WpsApp {
  $app = New-Object -ComObject KWPP.Application
  return $app
}

function Open-WpsPresentation {
  param(
    [Parameter(Mandatory)] $App,
    [Parameter(Mandatory)] [string] $Path
  )
  if (-not (Test-Path $Path)) { throw "找不到待打开的文件：$Path" }
  return $App.Presentations.Open($Path, $false, $false, $false)
}

function Export-WpsSlide {
  param(
    [Parameter(Mandatory)] $Pres,
    [Parameter(Mandatory)] [string] $OutPath,
    [int] $Width = 1600,
    [int] $Height = 900
  )
  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
  $slide = $Pres.Slides.Item(1)
  $slide.Export($OutPath, 'PNG', $Width, $Height)
  if (-not (Test-Path $OutPath)) { throw "导出未产生文件：$OutPath" }
  return (Get-Item $OutPath)
}

# 通过形状名定位形状。**按 name 而非索引/id**：与补丁器同一条定位口径。
function Get-WpsShapeByName {
  param(
    [Parameter(Mandatory)] $Pres,
    [Parameter(Mandatory)] [string] $Name
  )
  $shapes = $Pres.Slides.Item(1).Shapes
  for ($i = 1; $i -le $shapes.Count; $i++) {
    $s = $shapes.Item($i)
    if ($s.Name -eq $Name) { return $s }
  }
  return $null
}

function Save-WpsPresentation {
  param(
    [Parameter(Mandatory)] $Pres,
    [Parameter(Mandatory)] [string] $OutPath
  )
  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
  $Pres.SaveAs($OutPath, $script:PP_SAVE_AS_PPTX)
  if (-not (Test-Path $OutPath)) { throw "另存失败：$OutPath" }
  return (Get-Item $OutPath)
}

# 解包 pptx，把某个 entry 写成文本文件。
function Export-PptxEntry {
  param(
    [Parameter(Mandatory)] [string] $PptxPath,
    [Parameter(Mandatory)] [string] $EntryName,
    [Parameter(Mandatory)] [string] $OutPath
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($PptxPath)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq $EntryName }
    if (-not $entry) { throw "$EntryName 不存在于 $PptxPath" }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $content = $reader.ReadToEnd()
    $reader.Close()
    $dir = Split-Path -Parent $OutPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Write-LfText -Path $OutPath -Text $content
    return $content
  }
  finally { $zip.Dispose() }
}

function Close-WpsApp {
  param($Pres, $App)
  if ($Pres) { try { $Pres.Close() } catch { } }
  if ($App) {
    try { $App.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($App) } catch { }
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

# 统一以 LF 写入生成的文本证据。
#
# 为什么必须显式处理：PowerShell 在 Windows 上按 CRLF 写文件，而本仓库由
# .gitattributes 强制 LF（`* text=auto eol=lf`）。若不归一化，每次重新生成证据
# 都会让工作区"变脏"（git 认为内容被改动），掩盖真正的改动。
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

# 在 slide XML 上做「吸附结构是否存活」的计数统计。
function Get-AnchorStats {
  param([Parameter(Mandatory)] [string] $SlideXml)
  $st = [regex]::Matches($SlideXml, '<a:stCxn id="(\d+)" idx="(\d+)"')
  $en = [regex]::Matches($SlideXml, '<a:endCxn id="(\d+)" idx="(\d+)"')
  $ids = [regex]::Matches($SlideXml, '<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"')
  return [ordered]@{
    cxnSp      = ([regex]::Matches($SlideXml, '<p:cxnSp>')).Count
    grpSp      = ([regex]::Matches($SlideXml, '<p:grpSp>')).Count
    stCxn      = $st.Count
    endCxn     = $en.Count
    stCxnValue = if ($st.Count -gt 0) { "id=$($st[0].Groups[1].Value) idx=$($st[0].Groups[2].Value)" } else { '(缺失)' }
    endCxnValue = if ($en.Count -gt 0) { "id=$($en[0].Groups[1].Value) idx=$($en[0].Groups[2].Value)" } else { '(缺失)' }
    shapeIds   = ($ids | ForEach-Object { "$($_.Groups[2].Value)#$($_.Groups[1].Value)" }) -join ', '
    cxnSpLocks = ([regex]::Matches($SlideXml, 'cxnSpLocks')).Count
  }
}

function Format-AnchorStats {
  param([Parameter(Mandatory)] $Stats, [string] $Label = '')
  $lines = @()
  if ($Label) { $lines += "--- $Label ---" }
  $lines += "cxnSp=$($Stats.cxnSp) grpSp=$($Stats.grpSp) stCxn=$($Stats.stCxn) endCxn=$($Stats.endCxn) cxnSpLocks=$($Stats.cxnSpLocks)"
  $lines += "stCxn: $($Stats.stCxnValue)"
  $lines += "endCxn: $($Stats.endCxnValue)"
  $lines += "形状: $($Stats.shapeIds)"
  return ($lines -join "`n")
}
