# Downloads the third-party Windows tools the desktop client bundles in bin/
# (they are not redistributed in this repository) and verifies pinned hashes.
# Usage: pwsh scripts/ci/fetch-windows-deps.ps1 [-BinDir bin]
param(
  [string]$BinDir = "bin"
)
$ErrorActionPreference = "Stop"

# Sha256 pins a versioned download; update it only after reviewing the new
# release. NirSoft replaces files in place at an unversioned URL, so
# SoundVolumeView is verified by its Authenticode signer instead.
$deps = @(
  @{
    Name   = "SoundVolumeView"
    Url    = "https://www.nirsoft.net/utils/soundvolumeview-x64.zip"
    Signer = "Nir Sofer"
    Exe    = "SoundVolumeView.exe"
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
  Write-Host "$($dep.Name) SHA-256: $actual"
  if ($dep.Sha256 -and $actual -ne $dep.Sha256) {
    throw "$($dep.Name) hash mismatch: expected $($dep.Sha256), got $actual. Upstream release changed; review it and update the pinned hash."
  }
  $dest = Join-Path $BinDir $dep.Dest
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  if ($dep.Signer) {
    $sig = Get-AuthenticodeSignature -FilePath (Join-Path $dest $dep.Exe)
    $subject = $sig.SignerCertificate.Subject
    if ($sig.Status -ne "Valid" -or $subject -notmatch [regex]::Escape($dep.Signer)) {
      throw "$($dep.Name) signature check failed: status $($sig.Status), signer '$subject'"
    }
    Write-Host "$($dep.Name) signature valid: $subject"
  }
  Write-Host "$($dep.Name) verified and extracted to $dest"
}

foreach ($required in @("SoundVolumeView.exe", "VB_Cable/VBCABLE_Setup_x64.exe")) {
  if (-not (Test-Path (Join-Path $BinDir $required))) {
    throw "Missing $required after extraction"
  }
}
