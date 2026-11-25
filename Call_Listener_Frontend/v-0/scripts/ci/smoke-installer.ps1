# Installs the NSIS build silently, launches the packaged app, records a
# screenshot and logs, then uninstalls and checks cleanup.
# Usage: pwsh scripts/ci/smoke-installer.ps1 -Installer <path> [-OutDir ci-smoke]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$OutDir = "ci-smoke",
  [int]$RunSeconds = 25
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = Resolve-Path $OutDir

function Save-Screenshot([string]$Path) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Write-Host "Installing $Installer"
$install = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }

$exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Call Listener.exe" -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $exe) { throw "Installed Call Listener.exe not found under $env:LOCALAPPDATA\Programs" }
$installDir = $exe.DirectoryName
Write-Host "Installed to $installDir"
foreach ($required in @("resources\bin\SoundVolumeView.exe", "resources\app.asar.unpacked\watchdog.js")) {
  if (-not (Test-Path (Join-Path $installDir $required))) { throw "Missing packaged file: $required" }
}

$stdout = Join-Path $OutDir "app-stdout.log"
$stderr = Join-Path $OutDir "app-stderr.log"
$app = Start-Process -FilePath $exe.FullName -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Start-Sleep -Seconds $RunSeconds
Save-Screenshot (Join-Path $OutDir "app-running.png")

$alive = Get-Process -Name "Call Listener" -ErrorAction SilentlyContinue
if (-not $alive) {
  Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | Write-Host
  throw "App exited within $RunSeconds s (exit code $($app.ExitCode))"
}
Write-Host "App running: $($alive.Count) process(es)"

$userData = Join-Path $env:APPDATA "Call Listener"
if (Test-Path $userData) {
  Get-ChildItem $userData -File -Filter *.log -ErrorAction SilentlyContinue |
    Copy-Item -Destination $OutDir
  if (Test-Path (Join-Path $userData "audio_state.json")) {
    Write-Warning "audio_state.json present while idle (routing marked active without an interview)"
  }
}

$alive | Stop-Process -Force
Start-Sleep -Seconds 3

$uninstaller = Get-ChildItem -Path $installDir -Filter "Uninstall*.exe" | Select-Object -First 1
if (-not $uninstaller) { throw "Uninstaller not found in $installDir" }
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
Start-Sleep -Seconds 5
if (Test-Path $exe.FullName) { throw "App executable still present after uninstall" }
Write-Host "Uninstall exit code $($uninstall.ExitCode); install directory cleaned"
