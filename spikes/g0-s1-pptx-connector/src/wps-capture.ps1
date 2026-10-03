# G0-S-S1 · L2 往返证据 + L3 渲染取证（WPS）
#
# 做什么：
#   1. 用 WPS 打开 A-absorption.pptx（补丁产物）——若弹「需要修复」或抛错即记录失败；
#   2. 导出 slide1 的 PNG（L3 视觉判读的输入）；
#   3. SaveAs 出一份副本，并把副本的 slide1.xml dump 出来（L2 结构存活的证据）；
#   4. 统计吸附结构是否存活，并写入 evidence/wps/<Fixture>-roundtrip-report.md。
#
# 为什么必须另存副本而不覆盖原件：原件是 run-all.mts 的确定性产物，
# 一旦被 WPS 重写，就再也无法区分「补丁写了什么」与「WPS 改了什麼」。

param(
  # 默认处理主证据 A-absorption；传 -Fixture C-flat 可给对照组出渲染图与往返证据。
  [string] $Fixture = 'A-absorption'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wps-common.ps1')

$spikeRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $spikeRoot 'out'
$evidenceDir = Join-Path $spikeRoot 'evidence\wps'
$visionDir = Join-Path $spikeRoot 'evidence\vision'
New-Item -ItemType Directory -Force -Path $evidenceDir, $visionDir | Out-Null

$source = Join-Path $outDir "$Fixture.pptx"
if (-not (Test-Path $source)) { throw "请先运行 node src/run-all.mts 生成 $source" }

# 原件（补丁刚写出、未经任何编辑器）的统计，作为对照基线
$beforeXml = Export-PptxEntry -PptxPath $source -EntryName 'ppt/slides/slide1.xml' -OutPath (Join-Path $evidenceDir "$Fixture-as-written.xml")
$beforeStats = Get-AnchorStats -SlideXml $beforeXml
Write-Output "=== $Fixture 补丁刚写出（未经过任何编辑器）==="
Write-Output (Format-AnchorStats -Stats $beforeStats)

$pngPath = Join-Path $visionDir "$Fixture-wps-render.png"
$savedPath = Join-Path $outDir "$Fixture-saved-by-wps.pptx"
$savedXmlPath = Join-Path $evidenceDir "$Fixture-saved-by-wps.xml"

$app = $null; $pres = $null; $openError = $null; $savedOk = $false
try {
  Write-Output ''
  Write-Output '=== 用 WPS 打开补丁产物 ==='
  $app = New-WpsApp
  try {
    $pres = Open-WpsPresentation -App $app -Path $source
    Write-Output "打开成功：slides=$($pres.Slides.Count)"
  } catch {
    $openError = $_.Exception.Message
    Write-Output "打开失败：$openError"
    throw
  }

  $png = Export-WpsSlide -Pres $pres -OutPath $pngPath -Width 1600 -Height 900
  Write-Output "已导出渲染图：$($png.FullName) ($($png.Length) bytes)"

  try {
    $saved = Save-WpsPresentation -Pres $pres -OutPath $savedPath
    Write-Output "已另存副本：$($saved.FullName) ($($saved.Length) bytes)"
    $savedOk = $true
  } catch {
    Write-Output "另存失败：$($_.Exception.Message)"
  }
}
finally {
  Close-WpsApp -Pres $pres -App $app
}

# 分析另存副本
$afterStats = $null
$afterXml = $null
if ($savedOk) {
  $afterXml = Export-PptxEntry -PptxPath $savedPath -EntryName 'ppt/slides/slide1.xml' -OutPath $savedXmlPath
  $afterStats = Get-AnchorStats -SlideXml $afterXml
  Write-Output ''
  Write-Output '=== WPS 保存后 ==='
  Write-Output (Format-AnchorStats -Stats $afterStats)
}

# 逐项判定（L2）
function Test-Survived {
  param($Before, $After, [string] $Field)
  if ($null -eq $After) { return '未验证' }
  if ($Before.$Field -eq $After.$Field) { return '存活（值相同）' }
  return "改变：$($Before.$Field) → $($After.$Field)"
}

$verdicts = [ordered]@{
  '打开无异常'       = if ($openError) { "失败：$openError" } else { '通过' }
  '另存副本'         = if ($savedOk) { '通过' } else { '失败' }
  'cxnSp 存活'       = Test-Survived -Before $beforeStats -After $afterStats -Field 'cxnSp'
  'grpSp 存活'       = Test-Survived -Before $beforeStats -After $afterStats -Field 'grpSp'
  'stCxn 存活'       = Test-Survived -Before $beforeStats -After $afterStats -Field 'stCxnValue'
  'endCxn 存活'      = Test-Survived -Before $beforeStats -After $afterStats -Field 'endCxnValue'
  '形状集合存活'     = Test-Survived -Before $beforeStats -After $afterStats -Field 'shapeIds'
  '未引入 cxnSpLocks' = if ($null -eq $afterStats) { '未验证' } else { "WPS 写入 $($afterStats.cxnSpLocks) 处（补丁写 0 处）" }
}

$verdictRows = $verdicts.GetEnumerator() | ForEach-Object { "| $($_.Key) | $($_.Value) |" }
$beforeBlock = Format-AnchorStats -Stats $beforeStats
$afterBlock = if ($afterStats) { Format-AnchorStats -Stats $afterStats } else { '（未取得）' }

$report = @(
  '# S1 · L2 往返存活报告（WPS）',
  '',
  '> 由 `pwsh -File src/wps-capture.ps1` 生成。',
  '> **限制**：本机 WPS 12.1.0.28505；WPS 的 COM 自报名称是 "Microsoft PowerPoint"、版本 "12.0"，',
  '> **这是伪装字符串，不得作为「用 Microsoft PowerPoint 验证过」的证据**。',
  '> 按裁决 P-4（2026-10-03），**验证环境以 WPS 为准、Microsoft PowerPoint 备查不阻塞**。',
  '> 本报告只证明「结构经第三方编辑器打开并保存后是否存活」，**不证明「路由渲染正确」**；',
  '> 后者由人工 WPS 真机拖动确认（见 evidence/wps/人工验证记录.md）。',
  '',
  '## 逐项判定',
  '',
  '| 项 | 结果 |',
  '|---|---|'
) + $verdictRows + @(
  '',
  '## 结构统计',
  '',
  '### 补丁刚写出（未经任何编辑器）',
  '',
  '```',
  $beforeBlock,
  '```',
  '',
  '### WPS 保存后',
  '',
  '```',
  $afterBlock,
  '```',
  '',
  '## 证据文件',
  '',
  "- ``evidence/wps/$Fixture-as-written.xml``：补丁刚写出的 slide1.xml",
  "- ``evidence/wps/$Fixture-saved-by-wps.xml``：WPS 另存后的 slide1.xml（可直接 diff 看 WPS 重写了什么）",
  "- ``evidence/vision/$Fixture-wps-render.png``：WPS 渲染的 slide1（L3 视觉判读输入）",
  ''
)

$reportText = $report -join "`n"
$reportPath = Join-Path $evidenceDir "$Fixture-roundtrip-report.md"
Write-LfText -Path $reportPath -Text $reportText
Write-Output ''
Write-Output "报告：$reportPath"
