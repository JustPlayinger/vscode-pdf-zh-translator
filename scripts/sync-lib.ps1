# 同步 PDF.js 静态资源到 lib/
#
# lib/ 随仓库提交，保证「clone 之后无需联网即可编译打包」。
# 本脚本用于 pdf.js 升级或首次搭建时重新拉取资源。
#
# 用法：
#   # 从本机已安装的扩展复制（离线，推荐）
#   powershell -ExecutionPolicy Bypass -File scripts/sync-lib.ps1
#
#   # 指定来源目录（例如自己解压的 pdf.js Prebuilt）
#   powershell -ExecutionPolicy Bypass -File scripts/sync-lib.ps1 -Source "D:\pdfjs-2.10.377-dist"
#
#   # 从网络下载官方 Prebuilt（需要联网）
#   powershell -ExecutionPolicy Bypass -File scripts/sync-lib.ps1 -Version 2.10.377 -Download

[CmdletBinding()]
param(
  [string]$Source,
  [string]$Version = '2.10.377',
  [switch]$Download,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'lib'

function Write-Step($text) {
  Write-Host ""
  Write-Host "==> $text" -ForegroundColor Cyan
}

# ── 1. 确定来源目录 ─────────────────────────────────────────────
if (-not $Source) {
  if ($Download) {
    $tmp = Join-Path $env:TEMP "pdfjs-$Version"
    $zip = "$tmp.zip"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    $url = "https://github.com/mozilla/pdf.js/releases/download/v$Version/pdfjs-$Version-legacy.zip"
    Write-Step "下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Remove-Item $zip -Force
    $Source = $tmp
  } else {
    $candidate = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'tomoki1207.pdf-*' } |
      Sort-Object Name -Descending |
      Select-Object -First 1
    if (-not $candidate) {
      throw "找不到本机已安装的 vscode-pdf 扩展。请改用 -Source <目录> 或 -Download。"
    }
    $Source = Join-Path $candidate.FullName 'lib'
    Write-Host "来源：$Source" -ForegroundColor DarkGray
  }
}

if (-not (Test-Path $Source)) {
  throw "来源目录不存在：$Source"
}

# 兼容两种布局：直接是 lib/，或解压后的 pdfjs-*/ （含 build/ 与 web/）
$srcLib = $Source
if (-not (Test-Path (Join-Path $srcLib 'build'))) {
  $nested = Get-ChildItem $Source -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'build') } |
    Select-Object -First 1
  if ($nested) { $srcLib = $nested.FullName }
}
if (-not (Test-Path (Join-Path $srcLib 'build'))) {
  throw "在 $Source 下找不到 build/ 目录，无法识别为 pdf.js 发行包。"
}

if ((Test-Path $dest) -and -not $Force) {
  Write-Step "lib/ 已存在；使用 -Force 覆盖"
}

# ── 2. 复制资源 ────────────────────────────────────────────────
Write-Step "复制静态资源到 lib/"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $srcLib '*') $dest

# ── 3. 精简无需分发的文件 ──────────────────────────────────────
Write-Step "移除本扩展不使用的文件"
foreach ($junk in @(
    'build\pdf.sandbox.js',   # 沙箱渲染路径，本扩展不用
    'web\debugger.js',        # 调试面板，本扩展不启用
    'web\compressed.tracemonkey-pldi-09.pdf'  # 官方示例 PDF
  )) {
  $p = Join-Path $dest $junk
  if (Test-Path $p) {
    Remove-Item $p -Force
    Write-Host "  已移除 $junk" -ForegroundColor DarkGray
  }
}

# 上游 viewer.js 里默认打开的示例 PDF 引用需要清空，否则离线环境会报错
$viewerJs = Join-Path $dest 'web\viewer.js'
if (Test-Path $viewerJs) {
  $content = Get-Content $viewerJs -Raw
  $patched = $content -replace 'value:\s*"compressed\.tracemonkey-pldi-09\.pdf"', 'value: ""'
  if ($patched -ne $content) {
    Set-Content -Path $viewerJs -Value $patched -NoNewline -Encoding utf8
    Write-Host "  已清空 viewer.js 中的示例 PDF 默认地址" -ForegroundColor DarkGray
  }
}

# ── 4. 汇总与自检 ──────────────────────────────────────────────
Write-Step "完成"
$files = Get-ChildItem $dest -Recurse -File
$sizeMb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 2)
Write-Host ("  文件数 {0}，合计 {1} MB" -f $files.Count, $sizeMb) -ForegroundColor Green
Write-Host ""
Write-Host "接下来请运行： npm run compile && node scripts/check-viewer-html.mjs" -ForegroundColor Yellow
