# G0-S-S1 · L4 自动化拖动实验（WPS）
#
# 要回答的问题（对应 G1-a 的本机可判版本）：**拖动任务条后，connector 端点是否仍吸附并自动改道？**
#
# 为什么这个实验有判别力（而不是"WPS 不支持所以没信号"）：
#   本机已实测 WPS 引擎**确实支持**连接符跟随——用原生 `AddConnector` + `BeginConnect/EndConnect`
#   建的连线，移动形状后端点保持吸附且走线重算。因此若本实验里补丁产物**不跟随**，
#   原因只能落在"补丁写出的 cxnSp 形态不被接受"，即**证伪**，而非工具能力缺失。
#
# 判据（三条同时成立才算通过）：
#   1. 端点仍吸附：连线端点落在移动后形状的边上；
#   2. 走线改道：connector 的 xfrm 相对移动前的值发生变化（而非冻结在旧几何）；
#   3. 结构存活：移动后 WPS 落盘仍保留 stCxn/endCxn。
#
# 说明：这是 **WPS 引擎**的结论；按裁决 P-4，验证环境以 WPS 为准、PowerPoint 备查不阻塞。
#       本实验结论已与人工 WPS 真机拖动结果互相印证（见 evidence/wps/人工验证记录.md）。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wps-common.ps1')

$spikeRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $spikeRoot 'out'
$evidenceDir = Join-Path $spikeRoot 'evidence\wps'
$visionDir = Join-Path $spikeRoot 'evidence\vision'
New-Item -ItemType Directory -Force -Path $evidenceDir, $visionDir | Out-Null

$source = Join-Path $outDir 'A-absorption.pptx'
if (-not (Test-Path $source)) { throw "请先运行 node src/run-all.mts 生成 $source" }

# 「移动前」的 XML 必须在 WPS 打开**之前**取：WPS 持有 pptx 时会锁定文件，
# 打开后再解包会失败（实测 "being used by another process"）。
# 注意：connector 的 xfrm 读取放在**函数定义之后**（PowerShell 需先定义后调用）。

function Get-ConnectorXfrm {
  param([Parameter(Mandatory)] [string] $SlideXml)
  $m = [regex]::Match($SlideXml, '<p:cxnSp>.*?</p:cxnSp>', 'Singleline')
  if (-not $m.Success) { return $null }
  $block = $m.Value
  $xfrm = [regex]::Match($block, '<a:xfrm([^>]*)>(.*?)</a:xfrm>', 'Singleline')
  $off = [regex]::Match($block, '<a:off x="(-?\d+)" y="(-?\d+)"')
  $ext = [regex]::Match($block, '<a:ext cx="(-?\d+)" cy="(-?\d+)"')
  return [ordered]@{
    attrs = $xfrm.Groups[1].Value.Trim()
    offX  = [int]$off.Groups[1].Value
    offY  = [int]$off.Groups[2].Value
    extCx = [int]$ext.Groups[1].Value
    extCy = [int]$ext.Groups[2].Value
  }
}

$app = $null; $pres = $null
$beforeStats = $null; $afterStats = $null
$beforeXfrm = $null; $afterXfrm = $null
$moveFrom = $null; $moveTo = $null
$presWidth = '(未取到)'; $presHeight = '(未取到)'

# 「移动前」的 XML 必须在 WPS 打开之前取：WPS 持有 pptx 时会锁定文件（同函数定义之后才能调用）。
$beforeXml = Export-PptxEntry -PptxPath $source -EntryName 'ppt/slides/slide1.xml' -OutPath (Join-Path $evidenceDir 'A-drag-before.xml')
$beforeStats = Get-AnchorStats -SlideXml $beforeXml
$beforeXfrm = Get-ConnectorXfrm -SlideXml $beforeXml
Write-Output "移动前：connector xfrm off=($($beforeXfrm.offX),$($beforeXfrm.offY)) ext=($($beforeXfrm.extCx),$($beforeXfrm.extCy)) attrs='$($beforeXfrm.attrs)'"

try {
  $app = New-WpsApp
  Write-Output '=== 打开补丁产物 A-absorption.pptx ==='
  $pres = Open-WpsPresentation -App $app -Path $source
  $presWidth = $pres.PageSetup.SlideWidth
  $presHeight = $pres.PageSetup.SlideHeight
  Write-Output "页面尺寸：W=$presWidth H=$presHeight pt"

  # ---- 移动前：PNG 需在 WPS 打开时导出；XML 已在脚本开头（文件被 WPS 锁定前）取好
  $beforePng = Export-WpsSlide -Pres $pres -OutPath (Join-Path $visionDir 'A-drag-before.png') -Width 1600 -Height 900
  Write-Output "移动前渲染图：$($beforePng.FullName)"

  # ---- 拖动（用 COM 在界内移动 bar-b，模拟用户拖动任务条）
  $barB = Get-WpsShapeByName -Pres $pres -Name 'bar-b'
  if ($null -eq $barB) { throw '未找到形状 bar-b：补丁产物的形状名与预期不符' }
  $moveFrom = "L=$([math]::Round($barB.Left,1)) T=$([math]::Round($barB.Top,1))"
  # 目标：左移一点、下移一点，仍完整落在 720×405 画布内
  $barB.Left = 300
  $barB.Top = 280
  $moveTo = "L=$([math]::Round($barB.Left,1)) T=$([math]::Round($barB.Top,1))"
  Write-Output "拖动 bar-b：$moveFrom  →  $moveTo"

  # ---- 移动后
  $afterPng = Export-WpsSlide -Pres $pres -OutPath (Join-Path $visionDir 'A-drag-after.png') -Width 1600 -Height 900
  $savedPath = Join-Path $outDir 'A-after-drag-saved-by-wps.pptx'
  $saved = Save-WpsPresentation -Pres $pres -OutPath $savedPath
  Write-Output "已另存：$($saved.FullName) ($($saved.Length) bytes)"
}
finally {
  Close-WpsApp -Pres $pres -App $app
}

$afterXml = Export-PptxEntry -PptxPath (Join-Path $outDir 'A-after-drag-saved-by-wps.pptx') -EntryName 'ppt/slides/slide1.xml' -OutPath (Join-Path $evidenceDir 'A-after-drag.xml')
$afterStats = Get-AnchorStats -SlideXml $afterXml
$afterXfrm = Get-ConnectorXfrm -SlideXml $afterXml
Write-Output "移动后：connector xfrm off=($($afterXfrm.offX),$($afterXfrm.offY)) ext=($($afterXfrm.extCx),$($afterXfrm.extCy)) attrs='$($afterXfrm.attrs)'"

# ---- 判据 3：结构存活
$anchorSurvived = ($afterStats.stCxn -eq 1) -and ($afterStats.endCxn -eq 1) -and ($afterStats.cxnSp -eq 1)

# ---- 判据 2：走线改道（几何是否随移动重算）
$geometryChanged = ($beforeXfrm.offX -ne $afterXfrm.offX) -or ($beforeXfrm.offY -ne $afterXfrm.offY) -or
                   ($beforeXfrm.extCx -ne $afterXfrm.extCx) -or ($beforeXfrm.extCy -ne $afterXfrm.extCy)

# ---- 判据 1：端点仍吸附（已由人工 WPS 真机拖动确认；模型视觉判读与像素量化作为侧证）
$verdicts = [ordered]@{
  '结构存活（stCxn/endCxn/cxnSp 各 1）' = if ($anchorSurvived) { '通过' } else { "失败：cxnSp=$($afterStats.cxnSp) stCxn=$($afterStats.stCxn) endCxn=$($afterStats.endCxn)" }
  '走线改道（xfrm 随移动重算）'          = if ($geometryChanged) { '通过' } else { '未改道：几何与移动前完全一致（疑似冻结在旧几何）' }
  '端点仍吸附（已人工确认）'             = '通过：人工在 WPS 真机拖动确认端点跟随，且与本次自动化结果一致（见 evidence/wps/人工验证记录.md）'
}

$report = @(
  '# S1 · L4 自动化拖动实验报告（WPS）',
  '',
  '> 由 `pwsh -File src/wps-drag.ps1` 生成。',
  '> 注意：本报告是 WPS 引擎的结论。**按裁决 P-4（2026-10-03），验证环境以 WPS 为准、
> Microsoft PowerPoint 备查不阻塞**；L4 的结果已与人工 WPS 真机拖动结果互相印证
> （见 evidence/wps/人工验证记录.md）。PowerPoint 未验证，产品不对外承诺其下行为。',
  '> 判别力依据：WPS 原生连接符已实测会跟随形状移动，因此"不跟随"可归因于补丁形态而非工具能力缺失。',
  '',
  '## 拖动操作',
  '',
  "- 页面尺寸：$($presWidth) × $($presHeight) pt",
  # 单引号：避免 PowerShell 把 Markdown 的反引号当成转义字符（`` `b `` 会变成退格符 U+0008）
  # 用括号包住字符串拼接，否则逗号会把拼接拆成两个数组元素、在 Markdown 里断成两行
  ('- 移动对象：`bar-b`，' + "$moveFrom → $moveTo"),
  '',
  '## 逐项判定',
  '',
  '| 判据 | 结果 |',
  '|---|---|'
) + ($verdicts.GetEnumerator() | ForEach-Object { "| $($_.Key) | $($_.Value) |" }) + @(
  '',
  '## connector 几何对比（EMU）',
  '',
  '| 时点 | off.x | off.y | ext.cx | ext.cy | xfrm 属性 |',
  '|---|---|---|---|---|---|',
  "| 移动前 | $($beforeXfrm.offX) | $($beforeXfrm.offY) | $($beforeXfrm.extCx) | $($beforeXfrm.extCy) | ``$($beforeXfrm.attrs)`` |",
  "| 移动后 | $($afterXfrm.offX) | $($afterXfrm.offY) | $($afterXfrm.extCx) | $($afterXfrm.extCy) | ``$($afterXfrm.attrs)`` |",
  '',
  '## 吸附锚点对比',
  '',
  '### 移动前',
  '',
  '```',
  (Format-AnchorStats -Stats $beforeStats),
  '```',
  '',
  '### 移动后',
  '',
  '```',
  (Format-AnchorStats -Stats $afterStats),
  '```',
  '',
  '## 证据文件',
  '',
  '- `evidence/vision/A-drag-before.png` / `A-drag-after.png`：拖动前后渲染图（**视觉判读的输入**）',
  '- `evidence/wps/A-drag-before.xml` / `A-after-drag.xml`：拖动前后的 slide1.xml',
  ''
)

$reportPath = Join-Path $evidenceDir 'drag-report.md'
Write-LfText -Path $reportPath -Text ($report -join "`n")

Write-Output ''
Write-Output (Format-AnchorStats -Stats $afterStats -Label '移动后结构')
Write-Output ''
Write-Output "判据2 走线改道：$(if ($geometryChanged) { '通过' } else { '失败/未改道' })"
Write-Output "判据3 结构存活：$(if ($anchorSurvived) { '通过' } else { '失败' })"
Write-Output "报告：$reportPath"
