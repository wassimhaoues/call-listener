# Downloads the third-party Windows tools the desktop client bundles in bin/
# (they are not redistributed in this repository) and verifies pinned hashes.
# Usage: pwsh scripts/ci/fetch-windows-deps.ps1 [-BinDir bin] [-Strict]
#   -Strict: fail when a download's hash is not in its reviewed list (use for
#   release builds). Without it, an unreviewed hash is a CI warning only.
param(
  [string]$BinDir = "bin",
  [switch]$Strict
)
$ErrorActionPreference = "Stop"

# Reviewed SHA-256 values. Add a hash only after reviewing that release.
# NirSoft replaces SoundVolumeView in place at an unversioned URL and does not
# sign it, so new upstream releases appear as unreviewed hashes.
$deps = @(
  @{
    Name   = "SoundVolumeView"
    Url    = "https://www.nirsoft.net/utils/soundvolumeview-x64.zip"
    Sha256 = @(
      "11d4695f42ad24f228e9682c7307df39d93bc0fe5b8f8ac4ed560a54e7eb0509",
      # Reviewed and approved 2026-11-26 (upstream re-release at the same URL).
      "ee2c45553fb9fb31b71db88b537c18e25c1a387a4a9009d081bdb38265c68e1f"
    )
    Dest   = "."
  },
  @{
    Name   = "VB-Cable"
    Url    = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"
    Sha256 = @("b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb")
    Dest   = "VB_Cable"
  }
)

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "call-listener-deps"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

foreach ($dep in $deps) {
  $zip = Join-Path $tmp "$($dep.Name).zip"
  Write-Host "Downloading $($dep.Name) from $($dep.Url)"
  Invoke-WebRequest -Uri $dep.Url -OutFile $zip -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  Write-Host "$($dep.Name) SHA-256: $actual"
  if ($dep.Sha256 -notcontains $actual) {
    $msg = "$($dep.Name) hash $actual is not in the reviewed list; upstream release changed."
    if ($Strict) { throw "$msg Review it and add the hash." }
    Write-Host "::warning title=Unreviewed $($dep.Name) download::$msg"
  }
  $dest = Join-Path $BinDir $dep.Dest
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  Write-Host "$($dep.Name) extracted to $dest"
}

foreach ($required in @("SoundVolumeView.exe", "VB_Cable/VBCABLE_Setup_x64.exe")) {
  if (-not (Test-Path (Join-Path $BinDir $required))) {
    throw "Missing $required after extraction"
  }
}
