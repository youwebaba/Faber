$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::FromArgb(25, 26, 28))
$pen = [Drawing.Pen]::new([Drawing.Color]::FromArgb(126, 130, 136), 3)
$graphics.DrawRectangle($pen, 17, 17, 222, 222)
$font = [Drawing.Font]::new('Segoe UI', 165, [Drawing.FontStyle]::Italic, [Drawing.GraphicsUnit]::Pixel)
$brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(240, 240, 242))
$format = [Drawing.StringFormat]::new()
$format.Alignment = [Drawing.StringAlignment]::Center
$format.LineAlignment = [Drawing.StringAlignment]::Center
$graphics.DrawString('f', $font, $brush, [Drawing.RectangleF]::new(8, -3, 240, 248), $format)
$png = [IO.MemoryStream]::new()
$bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
$bytes = $png.ToArray()
$stream = [IO.File]::Create((Join-Path $PSScriptRoot 'faber.ico'))
$writer = [IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
  $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22)
  $writer.Write($bytes)
} finally { $writer.Dispose(); $png.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $pen.Dispose(); $font.Dispose(); $brush.Dispose(); $format.Dispose() }
