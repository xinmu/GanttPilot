# G0-S-S2 · L2b 取证：WPS 表格「打开 → **编辑 3 个单元格** → 保存」后，
# 可见列语义是否仍可解析、且**被编辑的值按新值正确读取**（其余字段零漂移）。
#
# 为什么这条路径不可省：仅保存可能根本不触发重写（字节不变），于是「语义存活」弱到无信息量；
# 真实用户工作流是「在 Excel/WPS 里改几行再存回来」，这条路径才是 S2 的核心证据。
#
# 判据（S2-c）：恰好 3 处已声明的语义差异，且改动后的值正好等于声明的值；
# 其余字段零漂移；无解析诊断。
#
# 用法：pwsh -File src/wps-edit-save.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'xlsx-common.ps1')

$spikeRoot = Split-Path -Parent $PSScriptRoot
$label = 'wps-edit-save'
$workDir = Join-Path $spikeRoot 'out/wps-work'
$workCopy = Join-Path $workDir "$label.xlsx"
$statusPath = Join-Path $workDir "$label-status.json"

# 三处有意编辑（行由 WBS 编号定位，**不硬编码行号**）。
$editWbsName = '2.1'        # 任务名称
$editWbsProgress = '2.1'    # 进度
$editWbsStart = '3.1'       # 开始日期
$nameSuffix = '（已改名）'
$progressValue = 0.75
# WBS 3.1「日期算术」的原开始日为 2026-10-05，这里 +7 天。
# 写成 ISO 文本由 WPS 自行解析（见下方 COM 陷阱说明）——若 WPS 存回的序列号带小数或偏移一天，
# 判定会失败而不是被「反正改过了」放过（这正是时区陷阱的现场检验）。
$expectedNewStart = '2026-10-12'

$canonical = Assert-CanonicalFixture -SpikeRoot $spikeRoot
$canonicalSha = Get-FileSha256 -Path $canonical

New-WorkingCopy -Source $canonical -Destination $workCopy | Out-Null
$beforeSha = Get-FileSha256 -Path $workCopy
Write-Host "[1/4] 工作副本：$workCopy（sha256 $($beforeSha.Substring(0,16))…）"

$app = $null
$workbook = $null
$expectedNewName = ''
$status = [ordered]@{
  label        = $label
  action       = 'open + 编辑 3 个单元格 + save'
  edits        = @()
  canonical    = $canonical.Replace($spikeRoot, '.')
  workingCopy  = $workCopy.Replace($spikeRoot, '.')
  canonicalSha = $canonicalSha
  beforeSha    = $beforeSha
  openedAt     = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  opened       = $false
  saved        = $false
  changedByWps = $false
  afterSha     = ''
  error        = ''
}

try {
  $app = New-WpsApp
  $status.identity = Get-WpsIdentity -App $app

  Write-Host '[2/4] WPS 打开 …'
  $workbook = Open-WpsWorkbook -App $app -Path $workCopy
  $status.opened = $true
  $worksheet = $workbook.Worksheets.Item(1)

  Write-Host '[3/4] 编辑 3 处（名称 / 进行中的进度 / 开始日期）…'
  # ⚠️ 实测的 COM 陷阱：WPS 的 `Cells.Value2` 经 PowerShell COM 适配器写入时**类型敏感**：
  # 同一次会话里混用 String 与 Double 的 put 会抛
  #   `Unable to cast object of type 'System.Double' to type 'System.String'`
  # （本 spike 复现了两次，探针脚本见提交说明）。**统一走字符串 put** 即稳定，且 WPS 会自行解析：
  #   '0.75'       → Double 0.75
  #   '2026-10-12' → 日期序列号 46307（这正是「ISO 文本日期写入日期格式单元格」的现场证据）
  $rowName = Find-RowByWbs -Worksheet $worksheet -Wbs $editWbsName
  $oldName = [string]$worksheet.Cells.Item($rowName, 2).Value2
  $expectedNewName = $oldName + $nameSuffix
  $worksheet.Cells.Item($rowName, 2).Value2 = $expectedNewName

  $rowProgress = Find-RowByWbs -Worksheet $worksheet -Wbs $editWbsProgress
  $worksheet.Cells.Item($rowProgress, 7).Value2 = [string]$progressValue

  $rowStart = Find-RowByWbs -Worksheet $worksheet -Wbs $editWbsStart
  $worksheet.Cells.Item($rowStart, 3).Value2 = $expectedNewStart

  $status.edits = @(
    [ordered]@{ wbs = $editWbsName; column = '任务名称'; before = $oldName; after = $expectedNewName },
    [ordered]@{ wbs = $editWbsProgress; column = '进度'; before = '(见基线解析值)'; after = [string]$progressValue },
    [ordered]@{ wbs = $editWbsStart; column = '开始'; before = '(见基线解析值)'; after = $expectedNewStart }
  )

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

Write-Host '[4/4] 判定与报告（Node 侧；此处**声明** 3 处差异，未声明的任何差异即判失败）…'
Push-Location $spikeRoot
try {
  node src/diff-variant.mts 'out/canonical.xlsx' "out/wps-work/$label.xlsx" `
    --label $label `
    --expect-change "$editWbsName`:name=$expectedNewName" `
    --expect-change "$editWbsProgress`:progress=$progressValue" `
    --expect-change "$editWbsStart`:start=$expectedNewStart"
  if ($LASTEXITCODE -ne 0) { throw "diff-variant 判定失败（退出码 $LASTEXITCODE）" }
} finally {
  Pop-Location
}

Write-Host "[OK] L2b 通过：WPS 编辑后保存的 3 处改动被正确读取，其余语义零漂移（证据见 evidence/$label/）。"
