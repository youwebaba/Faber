$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# Mechanically fit Bill's opaque artwork; preserve its aspect ratio and black padding.
$original = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot '../renderer/assets/faber-symbol.png'))
$images = @()
try {
  foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::Black)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $ratio = [Math]::Min($size / $original.Width, $size / $original.Height)
    $width = $original.Width * $ratio; $height = $original.Height * $ratio
    $graphics.DrawImage($original, [Drawing.RectangleF]::new(($size-$width)/2, ($size-$height)/2, $width, $height))
    $png = [IO.MemoryStream]::new()
    $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
    $images += @{ Size=$size; Bytes=$png.ToArray() }
    $png.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  }
  $writer = [IO.BinaryWriter]::new([IO.File]::Create((Join-Path $PSScriptRoot 'faber.ico')))
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($entry in $images) {
      $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
      $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
      $offset += $entry.Bytes.Length
    }
    foreach ($entry in $images) { $writer.Write([byte[]]$entry.Bytes) }
  } finally { $writer.Dispose() }
} finally { $original.Dispose() }
