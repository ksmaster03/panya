# ตัวช่วยติดตั้ง Panya (หน้าต่าง WinForms): Panya-Setup.exe แตกไฟล์นี้กับ payload ลงโฟลเดอร์ชั่วคราวแล้วเรียกด้วย powershell -STA
# ติดตั้งให้ผู้ใช้คนนี้คนเดียว ไม่ต้องใช้สิทธิ์ผู้ดูแลเครื่อง · -Silent = ติดตั้งด้วยค่าที่ส่งมาโดยไม่เปิดหน้าต่าง
param(
  [Parameter(Mandatory = $true)][string]$Payload,
  [string]$Version = '1.0.0',
  [string]$License = '',
  [string]$Icon = '',
  [string]$Logo = '',
  [string]$Dir = '',
  [string]$Data = '',
  [int]$Port = 0,
  [switch]$Silent,
  [switch]$NoDesktop,
  [switch]$NoAutostart,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Panya'
$Menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

# ── ค่าเริ่มต้น: ติดตั้งทับที่เดิมถ้าเคยติดตั้งแล้ว ───────────────────────
$prev = $null
try { $prev = (Get-ItemProperty $UninstallKey -ErrorAction Stop).InstallLocation } catch {}
if (-not $Dir) { $Dir = if ($prev) { $prev } else { Join-Path $env:LOCALAPPDATA 'Programs\Panya' } }
if (-not $Data) {
  $Data = Join-Path $env:LOCALAPPDATA 'Panya'
  if ($prev -and (Test-Path (Join-Path $prev 'data-dir.txt'))) { $Data = (Get-Content (Join-Path $prev 'data-dir.txt') -Raw -Encoding UTF8).Trim() }
}
if (-not $Port) {
  $Port = 6800
  $envFile = Join-Path $Data 'panya.env'
  if (Test-Path $envFile) { $m = Select-String -Path $envFile -Pattern '^\s*PANYA_PORT\s*=\s*(\d+)' | Select-Object -First 1; if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value } }
}

function Get-Target([string]$path) {
  # โฟลเดอร์ที่มีไฟล์อื่นอยู่แล้ว ให้ติดตั้งในโฟลเดอร์ย่อย Panya (ถอนการติดตั้งจะได้ไม่ลบไฟล์ของคนอื่น)
  $p = [IO.Path]::GetFullPath($path.Trim().TrimEnd('\'))
  if ([IO.Path]::GetPathRoot($p).TrimEnd('\') -eq $p.TrimEnd('\')) { $p = Join-Path $p 'Panya' }
  if ((Test-Path $p) -and -not (Test-Path (Join-Path $p 'Panya.exe')) -and (Get-ChildItem $p -Force | Select-Object -First 1)) { $p = Join-Path $p 'Panya' }
  return $p
}

function Test-Writable([string]$p) {
  try {
    New-Item -ItemType Directory -Force $p | Out-Null
    $f = Join-Path $p ".panya-write-test-$PID"
    [IO.File]::WriteAllText($f, 'ok'); Remove-Item $f -Force
    return $true
  } catch { return $false }
}

function New-Shortcut([string]$path, [string]$target, [string]$arguments, [string]$desc, [string]$workdir, [string]$icon) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $s.TargetPath = $target; $s.Arguments = $arguments; $s.WorkingDirectory = $workdir; $s.IconLocation = "$icon,0"; $s.Description = $desc
  $s.Save()
}

function Stop-Panya([string]$exe) {
  if (Test-Path $exe) { Start-Process $exe -ArgumentList '--stop' -Wait -WindowStyle Hidden; Start-Sleep -Milliseconds 800 }
}

# ── ติดตั้ง: $report รับ (ข้อความ, เปอร์เซ็นต์) ────────────────────────
function Install-Panya($opt, [scriptblock]$report) {
  $target = Get-Target $opt.Dir
  $data = [IO.Path]::GetFullPath($opt.Data.Trim())
  if (-not (Test-Writable $target)) { throw "เขียนโฟลเดอร์นี้ไม่ได้ (อาจต้องใช้สิทธิ์ผู้ดูแล): $target`nCannot write to this folder. Choose one under your user profile or another drive." }
  if (-not (Test-Writable $data)) { throw "เขียนโฟลเดอร์ข้อมูลไม่ได้: $data`nCannot write to the data folder." }
  $exe = Join-Path $target 'Panya.exe'

  if (-not (Test-Path $Payload)) { throw "ไม่พบไฟล์ติดตั้ง / Setup payload is missing: $Payload" }
  $moving = $prev -and ($prev -ne $target) -and (Test-Path (Join-Path $prev 'Panya.exe'))

  # แตกไฟล์ลงโฟลเดอร์พักก่อน: ถ้าล้มเหลว รุ่นที่ติดตั้งอยู่ยังใช้ได้ตามเดิม
  & $report 'แตกไฟล์ / Unpacking files…' 10
  $stage = Join-Path $target '.staging'
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $stage | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  $p = Start-Process $tar -ArgumentList '-xzf', "`"$Payload`"", '-C', "`"$stage`"" -PassThru -WindowStyle Hidden
  $pct = 10
  while (-not $p.WaitForExit(250)) { if ($pct -lt 75) { $pct++ }; & $report 'แตกไฟล์ / Unpacking files…' $pct | Out-Null }
  if ($p.ExitCode -ne 0 -or -not (Test-Path (Join-Path $stage 'Panya\Panya.exe'))) {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    throw "แตกไฟล์ไม่สำเร็จ (tar exit $($p.ExitCode)) / Unpacking failed"
  }

  # แตกครบแล้วจึงปิดและแทนรุ่นเดิม
  & $report 'ปิด Panya รุ่นเดิม / Stopping the earlier version…' 78
  Stop-Panya $exe
  if ($moving) { Stop-Panya (Join-Path $prev 'Panya.exe') }
  Remove-Item -Recurse -Force (Join-Path $target 'app'), $exe -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $stage 'Panya') -Force | Move-Item -Destination $target -Force
  Remove-Item -Recurse -Force $stage
  if (-not (Test-Path $exe)) { throw "ไม่พบ Panya.exe หลังแตกไฟล์ / Panya.exe is missing after unpacking" }

  & $report 'ตั้งค่า / Writing settings…' 82
  [IO.File]::WriteAllText((Join-Path $target 'data-dir.txt'), $data, (New-Object Text.UTF8Encoding($false)))
  New-Item -ItemType Directory -Force (Join-Path $data 'logs') | Out-Null
  $envFile = Join-Path $data 'panya.env'
  if (-not (Test-Path $envFile)) {
    $txt = "# ตั้งค่าของ Panya บนเครื่องนี้ · แก้แล้วปิด/เปิด Panya ใหม่`r`n# Panya settings for this computer. Edit, then stop and start Panya again.`r`nPANYA_PORT=$($opt.Port)`r`n# 127.0.0.1 = ใช้ได้เฉพาะเครื่องนี้ · 0.0.0.0 = ให้เครื่องอื่นในวงแลนเข้าได้ด้วย`r`nPANYA_HOST=127.0.0.1`r`n"
    [IO.File]::WriteAllText($envFile, $txt, (New-Object Text.UTF8Encoding($false)))
  } else {
    $lines = [IO.File]::ReadAllLines($envFile) | ForEach-Object { if ($_ -match '^\s*PANYA_PORT\s*=') { "PANYA_PORT=$($opt.Port)" } else { $_ } }
    if (-not ($lines -match '^\s*PANYA_PORT\s*=')) { $lines += "PANYA_PORT=$($opt.Port)" }
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
  }

  & $report 'สร้างทางลัด / Creating shortcuts…' 90
  $folder = Join-Path $Menu 'Panya'
  New-Item -ItemType Directory -Force $folder | Out-Null
  New-Shortcut (Join-Path $folder 'Panya.lnk') $exe '' 'เปิด Panya / Open Panya' $target $exe
  New-Shortcut (Join-Path $folder 'Stop Panya.lnk') $exe '--stop' 'ปิด Panya / Stop Panya' $target $exe
  New-Shortcut (Join-Path $folder 'Panya settings.lnk') 'notepad.exe' "`"$envFile`"" 'ตั้งค่า Panya / Panya settings' $target $exe
  New-Shortcut (Join-Path $folder 'Uninstall Panya.lnk') $exe '--uninstall' 'ถอนการติดตั้ง Panya / Uninstall Panya' $target $exe
  $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Panya.lnk'
  if ($opt.Desktop) { New-Shortcut $desk $exe '' 'เปิด Panya / Open Panya' $target $exe } else { Remove-Item $desk -ErrorAction SilentlyContinue }
  $startup = Join-Path $Menu 'Startup\Panya.lnk'
  if ($opt.Autostart) { New-Shortcut $startup $exe '--background' 'Panya (เบื้องหลัง / background)' $target $exe } else { Remove-Item $startup -ErrorAction SilentlyContinue }

  & $report 'ลงทะเบียนใน Settings > Apps…' 96
  New-Item -Force $UninstallKey | Out-Null
  $size = [int]((Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
  $vals = @{ DisplayName = 'Panya'; DisplayVersion = $Version; Publisher = 'ksmaster03'; DisplayIcon = "$exe,0"; InstallLocation = $target; UninstallString = "`"$exe`" --uninstall"; URLInfoAbout = 'https://github.com/ksmaster03/panya' }
  foreach ($k in $vals.Keys) { Set-ItemProperty $UninstallKey -Name $k -Value $vals[$k] }
  foreach ($k in 'NoModify', 'NoRepair') { Set-ItemProperty $UninstallKey -Name $k -Value 1 -Type DWord }
  Set-ItemProperty $UninstallKey -Name EstimatedSize -Value $size -Type DWord
  if ($moving) {
    # ย้ายที่ติดตั้งสำเร็จแล้ว: ลบเฉพาะไฟล์ของ Panya ที่ที่เดิม (ความจำอยู่ในโฟลเดอร์ข้อมูล ไม่ถูกแตะ)
    Remove-Item -Recurse -Force (Join-Path $prev 'app'), (Join-Path $prev 'Panya.exe'), (Join-Path $prev 'data-dir.txt') -ErrorAction SilentlyContinue
    Remove-Item $prev -ErrorAction SilentlyContinue
  }
  & $report 'เสร็จแล้ว / Done' 100
  return $target
}

function Test-PortFree([int]$port) {
  # ลองต่อก่อน: เซิร์ฟเวอร์ที่เปิด SO_REUSEADDR (เช่น Bun) ยังให้ bind ซ้ำได้ การ bind อย่างเดียวจึงหลอกได้
  $c = New-Object Net.Sockets.TcpClient
  try { if ($c.ConnectAsync('127.0.0.1', $port).Wait(400) -and $c.Connected) { return $false } } catch {} finally { $c.Dispose() }
  try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port); $l.Start(); $l.Stop(); return $true } catch { return $false }
}

# ── ติดตั้งเงียบ ────────────────────────────────────────────────────
if ($Silent) {
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    # Write-Host ไม่ปนกับค่าที่ Install-Panya คืน (Write-Output จะกลายเป็นส่วนหนึ่งของผลลัพธ์)
    $t = Install-Panya ([pscustomobject]@{ Dir = $Dir; Data = $Data; Port = $Port; Desktop = -not $NoDesktop; Autostart = -not $NoAutostart }) { param($m, $p) if ($p -le 10 -or $p -ge 78) { Write-Host "[$p%] $m" } }
    Write-Output "installed: $t"
    if (-not $NoLaunch) { Start-Process (Join-Path $t 'Panya.exe') }
    exit 0
  } catch { Write-Output "error: $($_.Exception.Message)"; exit 1 }
}

# ── หน้าต่างตัวช่วยติดตั้ง ──────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
try {
[Windows.Forms.Application]::EnableVisualStyles()
$font = New-Object Drawing.Font('Leelawadee UI', 10)
$bold = New-Object Drawing.Font('Leelawadee UI', 14, [Drawing.FontStyle]::Bold)
$small = New-Object Drawing.Font('Leelawadee UI', 9)
$ink2 = [Drawing.Color]::FromArgb(90, 90, 100)

$form = New-Object Windows.Forms.Form
$form.Text = "ติดตั้ง Panya $Version"
$form.ClientSize = New-Object Drawing.Size(680, 460)
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.StartPosition = 'CenterScreen'
$form.Font = $font; $form.BackColor = [Drawing.Color]::White
if ($Icon -and (Test-Path $Icon)) { $form.Icon = New-Object Drawing.Icon($Icon) }

# แถบซ้าย
$side = New-Object Windows.Forms.Panel
$side.SetBounds(0, 0, 190, 400); $side.BackColor = [Drawing.Color]::FromArgb(24, 24, 27)
$form.Controls.Add($side)
if ($Logo -and (Test-Path $Logo)) {
  # ภาพ PNG: เฟรม 256 px ในไฟล์ .ico บีบอัดแบบ PNG ซึ่ง Icon.ToBitmap() ของ .NET Framework อ่านไม่ได้
  $pic = New-Object Windows.Forms.PictureBox
  $pic.SetBounds(55, 40, 80, 80); $pic.SizeMode = 'Zoom'
  $pic.Image = [Drawing.Image]::FromFile($Logo)
  $side.Controls.Add($pic)
}
$brand = New-Object Windows.Forms.Label
$brand.Text = "Panya`nสมองที่สอง"; $brand.ForeColor = [Drawing.Color]::White; $brand.Font = $bold
$brand.SetBounds(10, 135, 170, 70); $brand.TextAlign = 'MiddleCenter'
$side.Controls.Add($brand)
$steps = New-Object Windows.Forms.Label
$steps.ForeColor = [Drawing.Color]::FromArgb(160, 160, 170); $steps.Font = $font
$steps.SetBounds(24, 215, 160, 180)
$side.Controls.Add($steps)
$stepNames = @('ยินดีต้อนรับ', 'สัญญาอนุญาต', 'ที่ติดตั้ง', 'ตัวเลือก', 'ติดตั้ง', 'เสร็จสิ้น')

# แถบล่าง
$line = New-Object Windows.Forms.Label
$line.SetBounds(0, 400, 680, 1); $line.BackColor = [Drawing.Color]::FromArgb(225, 225, 230)
$form.Controls.Add($line)
$btnBack = New-Object Windows.Forms.Button; $btnBack.Text = '< ย้อนกลับ'; $btnBack.SetBounds(360, 415, 95, 32)
$btnNext = New-Object Windows.Forms.Button; $btnNext.Text = 'ถัดไป >'; $btnNext.SetBounds(462, 415, 95, 32)
$btnCancel = New-Object Windows.Forms.Button; $btnCancel.Text = 'ยกเลิก'; $btnCancel.SetBounds(570, 415, 95, 32)
$form.Controls.AddRange(@($btnBack, $btnNext, $btnCancel))

function New-Page {
  $p = New-Object Windows.Forms.Panel
  $p.SetBounds(190, 0, 490, 400); $p.Visible = $false
  $form.Controls.Add($p); return $p
}
function Add-Label($page, [string]$text, [int]$y, [int]$h = 24, $f = $font, $color = $null) {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text; $l.SetBounds(28, $y, 440, $h); $l.Font = $f
  if ($color) { $l.ForeColor = $color }
  $page.Controls.Add($l); return $l
}

# หน้า 0: ยินดีต้อนรับ
$p0 = New-Page
Add-Label $p0 'ยินดีต้อนรับสู่ Panya' 30 34 $bold | Out-Null
Add-Label $p0 "สมองที่สองที่เก็บความรู้ตามจริง ค้นเจอทั้งไทยและอังกฤษ และบอกตรง ๆ เมื่อไม่รู้`n`nตัวช่วยนี้จะติดตั้ง Panya $Version ให้ผู้ใช้คนนี้ ไม่ต้องใช้สิทธิ์ผู้ดูแลเครื่อง และไม่ต้องมี Docker`n`nความจำทั้งหมดเก็บอยู่ในเครื่องนี้เท่านั้น" 80 170 | Out-Null
Add-Label $p0 "Your second brain: keeps knowledge word for word, finds it in Thai or English, and says when it does not know. Installs for this user only, no admin rights or Docker needed." 260 70 $small $ink2 | Out-Null

# หน้า 1: สัญญาอนุญาต
$p1 = New-Page
Add-Label $p1 'สัญญาอนุญาต / License' 24 30 $bold | Out-Null
Add-Label $p1 'Panya ใช้สัญญา PolyForm Noncommercial 1.0.0: ใช้ฟรีเพื่อการที่ไม่ใช่เชิงพาณิชย์' 60 24 $small $ink2 | Out-Null
$lic = New-Object Windows.Forms.TextBox
$lic.Multiline = $true; $lic.ReadOnly = $true; $lic.ScrollBars = 'Vertical'; $lic.Font = $small; $lic.BackColor = [Drawing.Color]::FromArgb(248, 248, 250)
$lic.SetBounds(28, 88, 440, 250)
$lic.Text = if ($License -and (Test-Path $License)) { (Get-Content $License -Raw -Encoding UTF8) -replace "`r?`n", "`r`n" } else { 'PolyForm Noncommercial License 1.0.0 — https://polyformproject.org/licenses/noncommercial/1.0.0' }
$p1.Controls.Add($lic)
$agree = New-Object Windows.Forms.CheckBox
$agree.Text = 'ฉันยอมรับสัญญาอนุญาตนี้ / I accept the license'; $agree.SetBounds(28, 350, 440, 28)
$p1.Controls.Add($agree)

# หน้า 2: ที่ติดตั้ง
$p2 = New-Page
Add-Label $p2 'เลือกที่ติดตั้ง / Install location' 24 30 $bold | Out-Null
Add-Label $p2 'โฟลเดอร์โปรแกรม (ราว 350 MB)' 70 | Out-Null
$tDir = New-Object Windows.Forms.TextBox; $tDir.SetBounds(28, 96, 345, 28); $tDir.Text = $Dir; $p2.Controls.Add($tDir)
$bDir = New-Object Windows.Forms.Button; $bDir.Text = 'เลือก…'; $bDir.SetBounds(380, 94, 88, 30); $p2.Controls.Add($bDir)
Add-Label $p2 'โฟลเดอร์ความจำและค่าตั้ง (เก็บไว้แม้ถอนการติดตั้ง)' 140 | Out-Null
$tData = New-Object Windows.Forms.TextBox; $tData.SetBounds(28, 166, 345, 28); $tData.Text = $Data; $p2.Controls.Add($tData)
$bData = New-Object Windows.Forms.Button; $bData.Text = 'เลือก…'; $bData.SetBounds(380, 164, 88, 30); $p2.Controls.Add($bData)
$space = Add-Label $p2 '' 215 48 $small $ink2
Add-Label $p2 'ถ้าเลือกโฟลเดอร์ที่มีไฟล์อื่นอยู่แล้ว จะติดตั้งในโฟลเดอร์ย่อย Panya · โฟลเดอร์ที่ต้องใช้สิทธิ์ผู้ดูแล (เช่น Program Files) ใช้ไม่ได้' 270 48 $small $ink2 | Out-Null
function Update-Space {
  try {
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($tDir.Text))
    $free = [IO.DriveInfo]::new($root).AvailableFreeSpace / 1GB
    $space.Text = "ติดตั้งที่: $(Get-Target $tDir.Text)`nพื้นที่ว่างในไดรฟ์ $root : $([math]::Round($free, 1)) GB (ต้องการราว 0.4 GB)"
  } catch { $space.Text = 'ตรวจพื้นที่ว่างไม่ได้ / Cannot read free space' }
}
$tDir.Add_TextChanged({ Update-Space })
$pick = {
  param($box, [string]$desc)
  $d = New-Object Windows.Forms.FolderBrowserDialog
  $d.Description = $desc; $d.ShowNewFolderButton = $true
  $start = $box.Text; while ($start -and -not (Test-Path $start)) { $start = Split-Path $start -Parent }
  if ($start) { $d.SelectedPath = $start }
  if ($d.ShowDialog($form) -eq 'OK') { $box.Text = $d.SelectedPath }
}
$bDir.Add_Click({ & $pick $tDir 'เลือกโฟลเดอร์สำหรับติดตั้ง Panya' })
$bData.Add_Click({ & $pick $tData 'เลือกโฟลเดอร์สำหรับเก็บความจำของ Panya' })

# หน้า 3: ตัวเลือก
$p3 = New-Page
Add-Label $p3 'ตัวเลือก / Options' 24 30 $bold | Out-Null
$cDesk = New-Object Windows.Forms.CheckBox; $cDesk.Text = 'สร้างทางลัดบนเดสก์ท็อป'; $cDesk.Checked = -not $NoDesktop; $cDesk.SetBounds(28, 75, 440, 28)
$cAuto = New-Object Windows.Forms.CheckBox; $cAuto.Text = 'เปิด Panya ทุกครั้งที่ล็อกอิน Windows (ทำงานเบื้องหลัง)'; $cAuto.Checked = -not $NoAutostart; $cAuto.SetBounds(28, 108, 440, 28)
$p3.Controls.AddRange(@($cDesk, $cAuto))
Add-Label $p3 'พอร์ต (เปิดในเบราว์เซอร์ที่ http://127.0.0.1:พอร์ต)' 160 | Out-Null
$nPort = New-Object Windows.Forms.NumericUpDown; $nPort.Minimum = 1024; $nPort.Maximum = 65535; $nPort.Value = $Port; $nPort.SetBounds(28, 188, 110, 28)
$p3.Controls.Add($nPort)
$portNote = Add-Label $p3 '' 222 44 $small $ink2
function Update-Port {
  $exeHere = Join-Path (Get-Target $tDir.Text) 'Panya.exe'
  if (Test-PortFree ([int]$nPort.Value)) { $portNote.Text = 'พอร์ตนี้ว่าง / This port is free'; $portNote.ForeColor = [Drawing.Color]::FromArgb(22, 128, 61) }
  elseif (Test-Path $exeHere) { $portNote.Text = 'Panya รุ่นเดิมใช้พอร์ตนี้อยู่ จะถูกปิดแล้วเปิดใหม่'; $portNote.ForeColor = $ink2 }
  else { $portNote.Text = 'มีโปรแกรมอื่นใช้พอร์ตนี้อยู่ เลือกพอร์ตอื่น เช่น ' + ([int]$nPort.Value + 1); $portNote.ForeColor = [Drawing.Color]::FromArgb(185, 28, 28) }
}
$nPort.Add_ValueChanged({ Update-Port })

# หน้า 4: กำลังติดตั้ง
$p4 = New-Page
Add-Label $p4 'กำลังติดตั้ง / Installing' 24 30 $bold | Out-Null
$status = Add-Label $p4 'เตรียมพร้อม…' 90
$bar = New-Object Windows.Forms.ProgressBar; $bar.SetBounds(28, 125, 440, 22); $bar.Minimum = 0; $bar.Maximum = 100
$p4.Controls.Add($bar)

# หน้า 5: เสร็จ
$p5 = New-Page
Add-Label $p5 'ติดตั้งเสร็จแล้ว' 30 34 $bold | Out-Null
$doneText = Add-Label $p5 '' 80 150
$cLaunch = New-Object Windows.Forms.CheckBox; $cLaunch.Text = 'เปิด Panya ตอนนี้'; $cLaunch.Checked = -not $NoLaunch; $cLaunch.SetBounds(28, 250, 440, 28)
$p5.Controls.Add($cLaunch)

$pages = @($p0, $p1, $p2, $p3, $p4, $p5)
$script:page = 0
$script:target = ''
function Show-Page([int]$i) {
  $script:page = $i
  for ($k = 0; $k -lt $pages.Count; $k++) { $pages[$k].Visible = ($k -eq $i) }
  $steps.Text = ($stepNames | ForEach-Object -Begin { $n = 0 } -Process { $mark = if ($n -eq $i) { '●' } elseif ($n -lt $i) { '✓' } else { '○' }; $n++; "$mark  $_" }) -join "`n"
  $btnBack.Enabled = ($i -in 1, 2, 3)
  $btnNext.Text = switch ($i) { 3 { 'ติดตั้ง' } 5 { 'เสร็จสิ้น' } default { 'ถัดไป >' } }
  $btnNext.Enabled = ($i -ne 4) -and -not ($i -eq 1 -and -not $agree.Checked)
  $btnCancel.Enabled = ($i -lt 4)
  if ($i -eq 2) { Update-Space }
  if ($i -eq 3) { Update-Port }
}
$agree.Add_CheckedChanged({ Show-Page $script:page })
$btnBack.Add_Click({ Show-Page ($script:page - 1) })
$btnCancel.Add_Click({ $form.Close() })
$btnNext.Add_Click({
  switch ($script:page) {
    2 {
      if (-not $tDir.Text.Trim() -or -not $tData.Text.Trim()) { [Windows.Forms.MessageBox]::Show($form, 'เลือกโฟลเดอร์ให้ครบ', 'Panya') | Out-Null; return }
      Show-Page 3
    }
    3 {
      Show-Page 4
      try {
        $opt = [pscustomobject]@{ Dir = $tDir.Text; Data = $tData.Text; Port = [int]$nPort.Value; Desktop = $cDesk.Checked; Autostart = $cAuto.Checked }
        $script:target = Install-Panya $opt { param($m, $p) $status.Text = $m; $bar.Value = [math]::Min(100, $p); [Windows.Forms.Application]::DoEvents() }
        $doneText.Text = "ติดตั้ง Panya ไว้ที่`n$($script:target)`n`nความจำเก็บที่`n$([IO.Path]::GetFullPath($tData.Text.Trim()))`n`nเปิดครั้งแรก ให้ตั้งชื่อผู้ใช้และรหัสผ่านของผู้ดูแลในเบราว์เซอร์"
        Show-Page 5
      } catch {
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Panya', 'OK', 'Error') | Out-Null
        Show-Page 2
      }
    }
    5 {
      if ($cLaunch.Checked -and $script:target) { Start-Process (Join-Path $script:target 'Panya.exe') }
      $form.Close()
    }
    default { Show-Page ($script:page + 1) }
  }
})
$form.Add_FormClosing({
  param($s, $e)
  if ($script:page -eq 4) { $e.Cancel = $true }
})
Show-Page 0
# ใช้ตรวจหน้าตา: PANYA_WIZARD_SHOTS=<โฟลเดอร์> บันทึกภาพหน้า 1-4 แล้วปิด (ไม่ติดตั้ง)
if ($env:PANYA_WIZARD_SHOTS) {
  $form.Add_Shown({
    foreach ($i in 0..3) {
      if ($i -eq 1) { $agree.Checked = $false; Show-Page 1; $script:shotNote = "next-before-accept=$($btnNext.Enabled)"; $agree.Checked = $true }
      Show-Page $i; [Windows.Forms.Application]::DoEvents()
      $bmp = New-Object Drawing.Bitmap($form.Width, $form.Height)
      $form.DrawToBitmap($bmp, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
      $bmp.Save((Join-Path $env:PANYA_WIZARD_SHOTS "wizard-page$i.png"))
    }
    [IO.File]::WriteAllText((Join-Path $env:PANYA_WIZARD_SHOTS 'wizard-shots.txt'), "$script:shotNote target=$(Get-Target $tDir.Text) port-note=$($portNote.Text)")
    $form.Close()
  })
}
[void]$form.ShowDialog()
} catch {
  # หน้าต่างพังก่อนแสดง: บอกผู้ใช้แทนการปิดเงียบ
  [Windows.Forms.MessageBox]::Show("ตัวติดตั้งทำงานไม่สำเร็จ / Setup failed:`n$($_.Exception.Message)`n`nบันทึก / log: $env:TEMP\panya-setup.log", 'Panya', 'OK', 'Error') | Out-Null
  throw
}
