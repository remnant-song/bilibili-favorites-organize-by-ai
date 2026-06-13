# generate-icons.ps1
# 运行此脚本生成扩展图标（需要 .NET Framework）
# 使用方式: powershell -ExecutionPolicy Bypass -File generate-icons.ps1

Add-Type -AssemblyName System.Drawing

function New-Icon {
    param (
        [int]$Size,
        [string]$OutputPath
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # 背景色 - B站粉色
    $bgColor = [System.Drawing.Color]::FromArgb(251, 114, 153)
    $brush = New-Object System.Drawing.SolidBrush($bgColor)

    # 绘制圆形背景
    $graphics.FillEllipse($brush, 1, 1, $Size - 2, $Size - 2)

    # 绘制文字
    $textColor = [System.Drawing.Color]::White
    $textBrush = New-Object System.Drawing.SolidBrush($textColor)
    $fontSize = [Math]::Floor($Size * 0.35)
    $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold)

    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center

    $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $graphics.DrawString("AI", $font, $textBrush, $rect, $format)

    # 保存
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    # 清理
    $graphics.Dispose()
    $bitmap.Dispose()
    $brush.Dispose()
    $textBrush.Dispose()
    $font.Dispose()

    Write-Host "Generated: $OutputPath"
}

# Get current script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$iconsDir = Join-Path $scriptDir "icons"

# Ensure icons directory exists
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Path $iconsDir | Out-Null
}

# Generate icons in three sizes
New-Icon -Size 16 -OutputPath (Join-Path $iconsDir "icon-16.png")
New-Icon -Size 48 -OutputPath (Join-Path $iconsDir "icon-48.png")
New-Icon -Size 128 -OutputPath (Join-Path $iconsDir "icon-128.png")

Write-Host ""
Write-Host "Icon generation completed!"
