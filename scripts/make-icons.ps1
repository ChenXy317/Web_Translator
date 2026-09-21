Add-Type -AssemblyName System.Drawing

function Save-AtpIcon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $bg = [System.Drawing.Color]::FromArgb(255, 12, 18, 34)
  $teal = [System.Drawing.Color]::FromArgb(255, 62, 224, 176)
  $blue = [System.Drawing.Color]::FromArgb(255, 124, 156, 255)
  $brushBg = New-Object System.Drawing.SolidBrush $bg
  $brushTeal = New-Object System.Drawing.SolidBrush $teal
  $brushBlue = New-Object System.Drawing.SolidBrush $blue

  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $radius = [Math]::Max(3, [int]($size * 0.22))
  $d = $radius * 2
  $gp.AddArc(0, 0, $d, $d, 180, 90)
  $gp.AddArc($size - $d, 0, $d, $d, 270, 90)
  $gp.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $gp.AddArc(0, $size - $d, $d, $d, 90, 90)
  $gp.CloseFigure()
  $g.FillPath($brushBg, $gp)

  $s = [single]$size
  $g.FillEllipse($brushBlue, $s * 0.14, $s * 0.18, $s * 0.46, $s * 0.38)
  $g.FillEllipse($brushTeal, $s * 0.40, $s * 0.38, $s * 0.46, $s * 0.38)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $brushBg.Dispose()
  $brushTeal.Dispose()
  $brushBlue.Dispose()
  $gp.Dispose()
  $g.Dispose()
  $bmp.Dispose()
}

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
foreach ($sz in 16, 32, 48, 128) {
  Save-AtpIcon $sz (Join-Path $iconDir "icon$sz.png")
}
Write-Output "icons written to $iconDir"
