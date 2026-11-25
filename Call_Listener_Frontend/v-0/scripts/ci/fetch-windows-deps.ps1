# Downloads the third-party Windows tools the desktop client bundles in bin/
# (they are not redistributed in this repository) and verifies pinned hashes.
# Usage: pwsh scripts/ci/fetch-windows-deps.ps1 [-BinDir bin]
param(
  [string]$BinDir = "bin"
)
$ErrorActionPreference = "Stop"

# Update a hash only after checking the new upstream release.
$deps = @(
  @{
    Name   = "SoundVolumeView"
    Url    = "https://www.nirsoft.net/utils/soundvolumeview-x64.zip"
    Sha256 = "11d4695f42ad24f228e9682c7307df39d93bc0fe5b8f8ac4ed560a54e7eb0509"
    Dest   = "."
  },
  @{
    Name   = "VB-Cable"
    Url    = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"
    Sha256 = "b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb"
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
  if ($actual -ne $dep.Sha256) {
    throw "$($dep.Name) hash mismatch: expected $($dep.Sha256), got $actual. Upstream release changed; review it and update the pinned hash."
  }
  $dest = Join-Path $BinDir $dep.Dest
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  Write-Host "$($dep.Name) verified and extracted to $dest"
}

foreach ($required in @("SoundVolumeView.exe", "VB_Cable/VBCABLE_Setup_x64.exe")) {
  if (-not (Test-Path (Join-Path $BinDir $required))) {
    throw "Missing $required after extraction"
  }
}
