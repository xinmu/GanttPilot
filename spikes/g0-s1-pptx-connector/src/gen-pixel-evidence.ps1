# G0-S-S1 · 生成 L3 像素量化证据（侧证）
#
# 用途：把 `verify-pixels.py` 的输出汇总成 `evidence/vision/pixel-quantification.md`。
# 之所以用脚本而不是手工重定向：证据需可复现，且生成物必须与仓库的 LF 约定一致
# （PowerShell 默认按 CRLF 写文件，会让工作区每次都"变脏"）。
#
# 用法：pwsh -File src/gen-pixel-evidence.ps1
# 依赖：Python + Pillow（本机已装）

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wps-common.ps1')

$spikeRoot = Split-Path -Parent $PSScriptRoot
$visionDir = Join-Path $spikeRoot 'evidence\vision'

# 允许用环境变量覆盖解释器；默认取 DSH 运行时自带的 Python
$python = if ($env:SPIKE_PYTHON) { $env:SPIKE_PYTHON } else { 'python' }
$script = Join-Path $PSScriptRoot 'verify-pixels.py'

# 顺序固定：主渲染图、拖动前后、拍平对照（便于人工比对）
$targets = @(
  'A-absorption-wps-render.png',
  'A-drag-before.png',
  'A-drag-after.png',
  'C-flat-wps-render.png'
)

$sections = @()
foreach ($name in $targets) {
  $png = Join-Path $visionDir $name
  if (-not (Test-Path -LiteralPath $png)) {
    Write-Output "跳过（不存在）：$name"
    continue
  }
  Write-Output "量化：$name"
  $out = & $python $script $png 2>&1 | Out-String
  $sections += "## $name"
  $sections += ''
  $sections += '```'
  $sections += $out.Trim()
  $sections += '```'
  $sections += ''
}

$report = @(
  '# S1 · L3 像素量化（侧证）',
  '',
  '> 由 `pwsh -File src/gen-pixel-evidence.ps1` 生成（内部调用 `src/verify-pixels.py`）。',
  '> **仅供侧证，不作为门禁判据**；主证据是人工 WPS 真机拖动（见 `../wps/人工验证记录.md`）',
  '> 与模型视觉判读（见 `判读记录.md`）。',
  '',
  '> 方法：按**连通域**取包围盒（避免同色但不相连的像素污染包围盒），',
  '> 再求连线像素到形状包围盒的最近距离。连线本身有 2–3 px 线宽，故 1–3 px 视为贴合。',
  '',
  '> 表中 `ms-1`、`grp-child-*` 标为"未贴合"是**预期结果**：本 fixture 只有一条依赖连线，',
  '> 其两端只应贴住 `bar-a` 与 `bar-b`。',
  ''
) + $sections

$outPath = Join-Path $visionDir 'pixel-quantification.md'
Write-LfText -Path $outPath -Text ($report -join "`n")
Write-Output "报告：$outPath"
