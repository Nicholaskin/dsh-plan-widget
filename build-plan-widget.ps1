<#
  计划悬浮窗 · 一键构建（只构建桌面客户端）
  —— 本仓库不含任务看板，因此这里只构建 client\PlanWidget。

  用法：在仓库根执行  .\build-plan-widget.ps1
  产物：client\PlanWidget\bin\Release\net8.0-windows\PlanWidget.exe
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '[1/1] 构建桌面客户端（WPF / .NET 8）...' -ForegroundColor Cyan
Push-Location (Join-Path $root 'client\PlanWidget')
try {
    dotnet build -c Release
} finally { Pop-Location }

$exe = Join-Path $root 'client\PlanWidget\bin\Release\net8.0-windows\PlanWidget.exe'
Write-Host '构建完成，产物：' -ForegroundColor Green
Write-Host ('  ' + $exe)
