Add-Type -AssemblyName System.Drawing

$src   = "C:\Users\alexk\OneDrive\Desktop\AH icon.png"
$dst   = "C:\Users\alexk\OneDrive\Desktop\ah-tracker.ico"
$sizes = @(16, 32, 48, 256)

# Render each size into a PNG byte array
$blobs = @()
foreach ($sz in $sizes) {
    $orig = [System.Drawing.Bitmap]::new($src)
    $bmp  = [System.Drawing.Bitmap]::new($sz, $sz)
    $g    = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($orig, 0, 0, $sz, $sz)
    $g.Dispose(); $orig.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $blobs += , $ms.ToArray()
    $ms.Dispose()
}

$out = New-Object System.IO.BinaryWriter([System.IO.File]::Create($dst))

# ICO header (6 bytes)
$out.Write([uint16]0)               # reserved
$out.Write([uint16]1)               # type = ICO
$out.Write([uint16]$blobs.Count)    # number of images

# Directory entries (16 bytes each)
$offset = [uint32](6 + 16 * $blobs.Count)
for ($i = 0; $i -lt $blobs.Count; $i++) {
    $sz  = $sizes[$i]
    $dim = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }  # 0 means 256 in ICO spec
    $out.Write($dim)                        # width
    $out.Write($dim)                        # height
    $out.Write([byte]0)                     # palette colors
    $out.Write([byte]0)                     # reserved
    $out.Write([uint16]1)                   # color planes
    $out.Write([uint16]32)                  # bits per pixel
    $out.Write([uint32]$blobs[$i].Length)   # data size
    $out.Write($offset)                     # data offset
    $offset += [uint32]$blobs[$i].Length
}

# Image data
foreach ($b in $blobs) { $out.Write($b) }
$out.Close()

Write-Host "Done: $dst"
