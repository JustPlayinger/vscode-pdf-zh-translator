# 生成扩展图标 media/icon.png
#
# 之所以用脚本而不是直接放一张二进制图：图标属于项目资产，
# 开源后贡献者应当能就地复现/微调，而不必依赖外部设计工具。
#
# 用法： powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'media'
$outFile = Join-Path $outDir 'icon.png'

if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# ── 背景：圆角矩形 + 蓝紫渐变 ──
$bgPath = New-RoundedPath 4 4 120 120 26
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(4, 4)),
  (New-Object System.Drawing.Point(124, 124)),
  [System.Drawing.Color]::FromArgb(255, 46, 128, 250),
  [System.Drawing.Color]::FromArgb(255, 22, 62, 160))
$g.FillPath($bgBrush, $bgPath)

# ── 文档主体：白色页面，右上角折角 ──
$pageLeft = 24.0
$pageTop = 26.0
$pageW = 44.0
$pageH = 76.0
$fold = 14.0

$pagePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$pagePath.AddLine($pageLeft, $pageTop, ($pageLeft + $pageW - $fold), $pageTop)
$pagePath.AddLine(($pageLeft + $pageW - $fold), $pageTop, ($pageLeft + $pageW), ($pageTop + $fold))
$pagePath.AddLine(($pageLeft + $pageW), ($pageTop + $fold), ($pageLeft + $pageW), ($pageTop + $pageH - 4))
$pagePath.AddArc(($pageLeft + $pageW - 8), ($pageTop + $pageH - 8), 8, 8, 0, 90)
$pagePath.AddLine(($pageLeft + $pageW - 4), ($pageTop + $pageH), ($pageLeft + 4), ($pageTop + $pageH))
$pagePath.AddArc($pageLeft, ($pageTop + $pageH - 8), 8, 8, 90, 90)
$pagePath.AddLine($pageLeft, ($pageTop + $pageH - 4), $pageLeft, ($pageTop + 4))
$pagePath.AddArc($pageLeft, $pageTop, 8, 8, 180, 90)
$pagePath.CloseFigure()

$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 250, 251, 253))
$g.FillPath($white, $pagePath)

# 折角阴影
$foldPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$foldPath.AddLine(($pageLeft + $pageW - $fold), $pageTop, ($pageLeft + $pageW), ($pageTop + $fold))
$foldPath.AddLine(($pageLeft + $pageW), ($pageTop + $fold), ($pageLeft + $pageW - $fold), ($pageTop + $fold))
$foldPath.CloseFigure()
$foldBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 196, 208, 228))
$g.FillPath($foldBrush, $foldPath)

# 页面上的文字行
$lineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 158, 172, 196))
$lineY = $pageTop + 26
$lineWidths = @(30, 30, 22, 30, 18)
foreach ($w in $lineWidths) {
  $g.FillRectangle($lineBrush, $pageLeft + 8, $lineY, $w, 3.5)
  $lineY += 9
}

# ── 翻译箭头（向右） ──
$arrowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$shaftY = 60.0
$g.FillRectangle($arrowBrush, 72, $shaftY, 22, 8)

$head = New-Object System.Drawing.Drawing2D.GraphicsPath
$head.AddPolygon(@(
    (New-Object System.Drawing.Point(92, 50)),
    (New-Object System.Drawing.Point(112, 64)),
    (New-Object System.Drawing.Point(92, 78))
  ))
$g.FillPath($arrowBrush, $head)

# ── 输出 ──
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$bgPath.Dispose()
$bgBrush.Dispose()
$pagePath.Dispose()
$white.Dispose()
$foldPath.Dispose()
$foldBrush.Dispose()
$lineBrush.Dispose()
$head.Dispose()
$arrowBrush.Dispose()

$info = Get-Item $outFile
Write-Host ("已生成 " + $info.FullName + " (" + $info.Length + " bytes)")
