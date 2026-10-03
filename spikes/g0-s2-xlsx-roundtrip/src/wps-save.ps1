# G0-S-S2 · L2 取证：WPS 表格「打开 → **仅保存**」后，可见列语义是否仍可解析。
#
# 判据（S2-b）：打开无异常、保存后可见列语义 100% 可解析且逐字段相等。
# 本脚本只负责「让 WPS 真的打开并保存一次」；所有的判定与报告由 Node 侧
# `src/diff-variant.mts` 完成（单一 zip/解析实现，避免两套逻辑各写错一遍）。
#
# 用法：pwsh -File src/wps-save.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'xlsx-common.ps1')

$spikeRoot = Split-Path -Parent $PSScriptRoot
$label = 'wps-save'
$workDir = Join-Path $spikeRoot 'out/wps-work'
$workCopy = Join-Path $workDir "$label.xlsx"
$statusPath = Join-Path $workDir "$label-status.json"

$canonical = Assert-CanonicalFixture -SpikeRoot $spikeRoot
$canonicalSha = Get-FileSha256 -Path $canonical

# WPS 打开后会**锁定**文件，因此「打开前」的事实必须在此之前取完（S1 已踩过这个坑）。
New-WorkingCopy -Source $canonical -Destination $workCopy | Out-Null
$beforeSha = Get-FileSha256 -Path $workCopy
Write-Host "[1/3] 工作副本：$workCopy（sha256 $($beforeSha.Substring(0,16))…）"

$app = $null
$workbook = $null
$status = [ordered]@{
  label          = $label
  action         = 'open + save（仅保存，不改动任何单元格）'
  canonical      = $canonical.Replace($spikeRoot, '.')
  workingCopy    = $workCopy.Replace($spikeRoot, '.')
  canonicalSha   = $canonicalSha
  beforeSha      = $beforeSha
  openedAt       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  opened         = $false
  saved          = $false
  changedByWps   = $false
  afterSha       = ''
  error          = ''
}

try {
  $app = New-WpsApp
  $status.identity = Get-WpsIdentity -App $app

  Write-Host "[2/3] WPS 打开并**仅保存**（不改单元格）…"
  $workbook = Open-WpsWorkbook -App $app -Path $workCopy
  $status.opened = $true
  $status.sheetCount = [int]$workbook.Worksheets.Count
  $status.sheetNames = @($workbook.Worksheets | ForEach-Object { [string]$_.Name })

  Save-WpsWorkbook -Workbook $workbook
  $status.saved = $true
} catch {
  $status.error = $_.Exception.Message
  throw
} finally {
  Close-WpsApp -Workbook $workbook -App $app

  if (Test-Path $workCopy) {
    $afterSha = Get-FileSha256 -Path $workCopy
    $status.afterSha = $afterSha
    $status.changedByWps = ($afterSha -ne $beforeSha)
  }
  $status.finishedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Write-LfJson -Path $statusPath -Object $status
  Write-Host "      WPS 侧状态：$statusPath"
}

if (-not $status.saved) { throw 'WPS 保存未完成' }
if (-not $status.changedByWps) {
  Write-Host '[note] 仅保存**未触发重写**（字节未变）——这是有效事实，但也意味着主要证据要由'
  Write-Host '       「编辑后保存」路径承担（见 wps-edit-save.ps1）。'
}

Write-Host '[3/3] 判定与报告（Node 侧，与 L1 同一套判据）…'
Push-Location $spikeRoot
try {
  node src/diff-variant.mts 'out/canonical.xlsx' "out/wps-work/$label.xlsx" --label $label
  if ($LASTEXITCODE -ne 0) { throw "diff-variant 判定失败（退出码 $LASTEXITCODE）" }
} finally {
  Pop-Location
}

Write-Host "[OK] L2 通过：WPS 仅保存后可见列语义仍可解析（见 out/wps-work/$label-status.json 与 evidence/$label/）。"
