# G0-S-S2 · WPS 表格 COM 共用工具
#
# 集中处理三件事（与 S1 的 `wps-common.ps1` 同一手法）：
#   1. COM 生命周期与**必定执行的清理**（否则 et.exe 会残留进程）；
#   2. 「打开 → 仅保存」与「打开 → 编辑 → 保存」两条取证路径；
#   3. 环境事实的落地（含**必须写进证据的伪装字符串**，见下）。
#
# ⚠️ 必须使用 `KET.Application`，**不要用 `Excel.Application`**。
# 本机实测（2026-10-03）两者都解析到 WPS 表格 12.1.0.28505，且 WPS 自报
#   Name = "Microsoft Excel"、Version = "12.0"
# ——这是**伪装字符串**，绝不可作为「用 Microsoft Excel 验证过」的证据。
# 与 S1 的 `KWPP.Application` 伪装成 "Microsoft PowerPoint" 是同一回事。

$ErrorActionPreference = 'Stop'

function New-WpsApp {
  $app = New-Object -ComObject KET.Application
  # 全部「安静开关」都容错设置：不同版本属性名可能缺失，缺失不应阻塞取证。
  foreach ($pair in @(
      @{ Name = 'DisplayAlerts'; Value = $false },
      @{ Name = 'Visible'; Value = $false },
      @{ Name = 'ScreenUpdating'; Value = $false },
      @{ Name = 'AskToUpdateLinks'; Value = $false },
      @{ Name = 'EnableEvents'; Value = $false }
    )) {
    try { $app.$($pair.Name) = $pair.Value } catch { }
  }
  return $app
}

# WPS 的身份事实（连同伪装字符串一起入证据）。
function Get-WpsIdentity {
  param([Parameter(Mandatory)] $App)
  return [ordered]@{
    comProgId       = 'KET.Application'
    reportedName    = [string]$App.Name
    reportedVersion = [string]$App.Version
    installPath     = [string]$App.Path
    build           = [string]$App.Build
    disguiseWarning = 'WPS 自报 Name="Microsoft Excel"/Version="12.0"；该字符串不构成「已用 Microsoft Excel 验证」的证据'
  }
}

function Open-WpsWorkbook {
  param(
    [Parameter(Mandatory)] $App,
    [Parameter(Mandatory)] [string] $Path
  )
  if (-not (Test-Path $Path)) { throw "找不到待打开的文件：$Path" }
  # 第三参数 $false = 非只读（我们需要保存）；第四参数 $false = 不弹「是否更新链接」。
  return $App.Workbooks.Open($Path, 0, $false)
}

function Save-WpsWorkbook {
  param([Parameter(Mandatory)] $Workbook)
  $Workbook.Save()
}

# 按 WBS 编号（A 列）定位数据行号。**按值定位，不按行号硬编码**：
# 行号一旦与 fixture 漂移，硬编码就会去改错误的单元格而「实验通过」。
function Find-RowByWbs {
  param(
    [Parameter(Mandatory)] $Worksheet,
    [Parameter(Mandatory)] [string] $Wbs
  )
  $used = $Worksheet.UsedRange
  $lastRow = $used.Row + $used.Rows.Count - 1
  for ($row = 2; $row -le $lastRow; $row++) {
    $value = $Worksheet.Cells.Item($row, 1).Value2
    if ($null -ne $value -and ([string]$value).Trim() -eq $Wbs) { return $row }
  }
  throw "在工作表中找不到 WBS=$Wbs 的行"
}

function Close-WpsApp {
  param($Workbook, $App)
  if ($Workbook) {
    try { $Workbook.Close($false) } catch { }
  }
  if ($App) {
    try { $App.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($App) } catch { }
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

# 统一以 LF 写入生成的文本证据（理由见 S1 的 wps-common.ps1：.gitattributes 强制 LF）。
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

function Write-LfJson {
  param(
    [Parameter(Mandatory)] [string] $Path,
    [Parameter(Mandatory)] $Object
  )
  Write-LfText -Path $Path -Text ($Object | ConvertTo-Json -Depth 8)
}

function Get-FileSha256 {
  param([Parameter(Mandatory)] [string] $Path)
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# 把 `canonical.xlsx` 复制成独立的工作副本（**绝不让 WPS 触碰基线文件**）。
function New-WorkingCopy {
  param(
    [Parameter(Mandatory)] [string] $Source,
    [Parameter(Mandatory)] [string] $Destination
  )
  $dir = Split-Path -Parent $Destination
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $Destination) { Remove-Item $Destination -Force }
  Copy-Item -Path $Source -Destination $Destination
  return (Get-Item $Destination)
}

# 确认基线存在；缺失时用 Node 生成（fixture 的唯一来源是 `src/manifest.ts`）。
function Assert-CanonicalFixture {
  param([Parameter(Mandatory)] [string] $SpikeRoot)
  $canonical = Join-Path $SpikeRoot 'out/canonical.xlsx'
  if (-not (Test-Path $canonical)) {
    Write-Host '[setup] out/canonical.xlsx 不存在，先运行 node src/run-all.mts 生成 …'
    Push-Location $SpikeRoot
    try { node src/run-all.mts } finally { Pop-Location }
  }
  if (-not (Test-Path $canonical)) { throw '未能生成 out/canonical.xlsx' }
  return $canonical
}
