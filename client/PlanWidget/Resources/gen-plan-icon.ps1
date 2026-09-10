# ============================================================
# plan-widget 专属图标 v2 —— 摈弃原有设计, 全新撞色背景 + dsh 鲸鱼
# 设计: 圆角方形 + 强烈撞色背景(亮橙→深蓝对角渐变) + 白色鲸鱼 + 青绿喷水/尾鳍
# 输出: Resources/plan-widget-256.png + plan-widget.ico(16~256)
# ============================================================
Add-Type -AssemblyName System.Drawing

function Add-RoundedRect($path, $x, $y, $w, $h, $rad) {
    $d = $rad * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
}

$dir = "D:\lfn\DeepseekCLI Files\工作区\dsh-3085-隔离测试环境\client\PlanWidget\Resources"

# ---- 1024 高分辨率绘制(抗锯齿), 最后缩放 ----
$bmp = New-Object System.Drawing.Bitmap(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

# 1) 圆角方形背景 + 强烈撞色渐变(左上亮橙 #FF8C1A? -> 左上亮橙, 右下深蓝紫 #1B2B7A)
$bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
Add-RoundedRect $bgPath 0 0 1024 1024 210
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, 1024, 1024)),
    [System.Drawing.Color]::FromArgb(255, 255, 122, 26),    # 亮橙 #FF7A1A
    [System.Drawing.Color]::FromArgb(255, 27, 43, 122),     # 深蓝 #1B2B7A
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
$g.FillPath($bgBrush, $bgPath)

# 2) 白色鲸鱼(品牌形象保留, 撞色底上极醒目)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$g.FillEllipse($white, 300, 430, 400, 200)                  # 身体(椭圆, 略上移居中)
# 尾鳍(弯月形)
$finPts = [System.Drawing.Point[]]@(
    (New-Object System.Drawing.Point(700, 480)),
    (New-Object System.Drawing.Point(845, 440)),
    (New-Object System.Drawing.Point(805, 530)),
    (New-Object System.Drawing.Point(855, 590)),
    (New-Object System.Drawing.Point(708, 565)))
$g.FillPolygon($white, $finPts)

# 3) 鱼鳍(胸前)
$chestFinPts = [System.Drawing.Point[]]@(
    (New-Object System.Drawing.Point(420, 590)),
    (New-Object System.Drawing.Point(345, 680)),
    (New-Object System.Drawing.Point(505, 650)))
$g.FillPolygon($white, $chestFinPts)

# 4) 尾巴撞色带(青色, 与橙蓝形成三色撞)
$teal = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 62, 226, 208))  # 亮青 #3EE2D0
$g.FillEllipse($teal, 815, 495, 60, 60)

# 5) 喷水(青绿三朵水花, 从头顶依次向上)
$spray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 62, 226, 208))  # 亮青绿
$g.FillEllipse($spray, 385, 355, 46, 46)    # 中水花
$g.FillEllipse($spray, 412, 300, 64, 64)    # 大水花
$g.FillEllipse($spray, 458, 272, 40, 40)    # 小水花

# 6) 鲸鱼眼睛(深蓝, 白色身体上)
$eye = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 27, 43, 122))
$g.FillEllipse($eye, 455, 500, 26, 26)

# ---- 保存 256 源图 ----
$bmp256 = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g256 = [System.Drawing.Graphics]::FromImage($bmp256)
$g256.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g256.DrawImage($bmp, 0, 0, 256, 256)
$g256.Dispose()
$bmp256.Save("$dir\plan-widget-256.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp256.Dispose()

# ---- 多尺寸 ICO ----
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($sz in $sizes) {
    $mb = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $mg = [System.Drawing.Graphics]::FromImage($mb)
    $mg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $mg.DrawImage($bmp, 0, 0, $sz, $sz)
    $mg.Dispose()
    $frames += ,$mb
}
# ICO 打包(用临时文件方案: 写 PNG 帧字节 + 手动 ICO 头)
function IcoWrap($bitmaps, $outPath) {
    # 生成 ICO: 每帧 PNG 数据
    $pngBytesList = @()
    foreach ($b in $bitmaps) {
        $ms = New-Object System.IO.MemoryStream
        $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngBytesList += ,$ms.ToArray()
        $ms.Dispose()
    }
    $count = $bitmaps.Count
    $fs = New-Object System.IO.FileStream($outPath, [System.IO.FileMode]::Create)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([UInt16]0)   # reserved
    $bw.Write([UInt16]1)   # type: icon
    $bw.Write([UInt16]$count)
    $offset = 6 + 16 * $count
    for ($i = 0; $i -lt $count; $i++) {
        $b = $bitmaps[$i]
        $pw = $b.Width; if ($pw -ge 256) { $pw = 0 }
        $ph = $b.Height; if ($ph -ge 256) { $ph = 0 }
        $bw.Write([Byte]$pw)
        $bw.Write([Byte]$ph)
        $bw.Write([Byte]0)   # colors
        $bw.Write([Byte]0)   # reserved
        $bw.Write([UInt16]1) # planes
        $bw.Write([UInt16]32)# bpp
        $bw.Write([UInt32]$pngBytesList[$i].Length)
        $bw.Write([UInt32]$offset)
        $offset += $pngBytesList[$i].Length
    }
    for ($i = 0; $i -lt $count; $i++) {
        $bw.Write($pngBytesList[$i])
    }
    $bw.Flush(); $fs.Close()
}
IcoWrap $frames "$dir\plan-widget.ico"

$g.Dispose(); $bmp.Dispose()
foreach ($f in $frames) { $f.Dispose() }
Write-Output "OK: plan-widget-256.png + plan-widget.ico"
