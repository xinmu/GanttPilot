# G0-S-S1 · 参照实现：用 WPS 原生 AddConnector 生成「正确形态」的 cxnSp
#
# 目的：让 WPS 自己写出一份双端吸附的 connector（stCxn/endCxn），
#       其 slide XML 就是补丁器要生成的**权威形态**（比任何文档都权威）。
#
# 用法：pwsh -File src/wps-native-reference.ps1
# 产出：out/D-wps-native.pptx、evidence/wps/D-native-slide1.xml

$ErrorActionPreference = 'Stop'

# 复用 Write-LfText（生成的证据统一以 LF 写入，避免每次重新生成都让工作区变脏）
. (Join-Path $PSScriptRoot 'wps-common.ps1')

$spikeRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $spikeRoot 'out'
$evidenceDir = Join-Path $spikeRoot 'evidence\wps'
New-Item -ItemType Directory -Force -Path $outDir, $evidenceDir | Out-Null

$pptxPath = Join-Path $outDir 'D-wps-native.pptx'
if (Test-Path $pptxPath) { Remove-Item $pptxPath -Force }

$app = $null
$pres = $null
try {
  $app = New-Object -ComObject KWPP.Application
  $pres = $app.Presentations.Add()

  # 与 manifest 保持一致：slide 960x540 pt
  $pres.PageSetup.SlideWidth = 960
  $pres.PageSetup.SlideHeight = 540

  $slide = $pres.Slides.Add(1, 12)  # ppLayoutBlank

  # bar-a / bar-b —— 显式纯色填充，便于视觉判读
  $barA = $slide.Shapes.AddShape(5, 100, 100, 200, 40)   # msoShapeRoundedRectangle
  $barA.Name = 'bar-a'
  $barA.Fill.Solid()
  $barA.Fill.ForeColor.RGB = 0x2E75B6

  $barB = $slide.Shapes.AddShape(5, 500, 320, 200, 40)
  $barB.Name = 'bar-b'
  $barB.Fill.Solid()
  $barB.Fill.ForeColor.RGB = 0xC00000

  # 里程碑菱形
  $ms = $slide.Shapes.AddShape(4, 760, 120, 30, 30)      # msoShapeDiamond
  $ms.Name = 'ms-1'
  $ms.Fill.Solid()
  $ms.Fill.ForeColor.RGB = 0xED7D31

  # 双端吸附 connector：bar-a 右侧(idx=3) -> bar-b 左侧(idx=1)
  $conn = $slide.Shapes.AddConnector(2, 0, 0, 10, 10)    # msoConnectorElbow
  $conn.Name = 'dep-1'
  $conn.Line.ForeColor.RGB = 0x00B050
  $conn.ConnectorFormat.BeginConnect($barA, 3)
  $conn.ConnectorFormat.EndConnect($barB, 1)

  # 组合：两个子形状
  $g1 = $slide.Shapes.AddShape(5, 100, 400, 120, 30)
  $g1.Name = 'grp-child-1'
  $g1.Fill.Solid(); $g1.Fill.ForeColor.RGB = 0x7030A0
  $g2 = $slide.Shapes.AddShape(5, 260, 400, 120, 30)
  $g2.Name = 'grp-child-2'
  $g2.Fill.Solid(); $g2.Fill.ForeColor.RGB = 0x00B0F0

  $range = $slide.Shapes.Range(@($g1.Name, $g2.Name))
  $group = $range.Group()
  $group.Name = 'grp-1'

  Write-Output "shapes on slide: $($slide.Shapes.Count)"
  for ($i = 1; $i -le $slide.Shapes.Count; $i++) {
    $s = $slide.Shapes.Item($i)
    Write-Output ("  [{0}] id={1} name={2} type={3} L={4} T={5} W={6} H={7}" -f $i, $s.Id, $s.Name, $s.Type, $s.Left, $s.Top, $s.Width, $s.Height)
  }

  $pres.SaveAs($pptxPath, 24)  # ppSaveAsOpenXMLPresentation = 24
  Write-Output "saved: $pptxPath exists=$(Test-Path $pptxPath)"
}
finally {
  if ($pres) { try { $pres.Close() } catch {} }
  if ($app) { try { $app.Quit() } catch {}; try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {} }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

# 解包并 dump slide1.xml
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($pptxPath)
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'ppt/slides/slide1.xml' }
  if (-not $entry) { throw "ppt/slides/slide1.xml not found" }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  $xml = $reader.ReadToEnd()
  $reader.Close()
  $dest = Join-Path $evidenceDir 'D-native-slide1.xml'
  Write-LfText -Path $dest -Text $xml
  Write-Output "dumped: $dest ($($xml.Length) chars)"
}
finally { $zip.Dispose() }
