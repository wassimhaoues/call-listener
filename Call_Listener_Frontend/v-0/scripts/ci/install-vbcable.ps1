# Prepares a GitHub-hosted Windows runner for audio-routing tests:
# starts the Windows Audio service, trusts the VB-Audio driver publisher,
# silently installs VB-Cable, and waits for its endpoints to appear.
# Usage (elevated): pwsh scripts/ci/install-vbcable.ps1 [-BinDir bin]
param(
  [string]$BinDir = "bin"
)
$ErrorActionPreference = "Stop"

foreach ($svc in @("AudioEndpointBuilder", "Audiosrv")) {
  Set-Service -Name $svc -StartupType Automatic
  Start-Service -Name $svc
  Write-Host "${svc}: $((Get-Service $svc).Status)"
}

$cableDir = Resolve-Path (Join-Path $BinDir "VB_Cable")
$cat = Join-Path $cableDir "vbaudio_cable64_win10.cat"
$signature = Get-AuthenticodeSignature -FilePath $cat
if (-not $signature.SignerCertificate) {
  throw "Could not read the VB-Audio driver signer certificate from $cat"
}
$certPath = Join-Path ([System.IO.Path]::GetTempPath()) "vbaudio.cer"
Export-Certificate -Cert $signature.SignerCertificate -FilePath $certPath | Out-Null
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
Write-Host "Trusted driver publisher: $($signature.SignerCertificate.Subject)"

$setup = Join-Path $cableDir "VBCABLE_Setup_x64.exe"
$proc = Start-Process -FilePath $setup -ArgumentList "-i", "-h" -Wait -PassThru
Write-Host "VB-Cable installer exit code: $($proc.ExitCode)"

$svv = Resolve-Path (Join-Path $BinDir "SoundVolumeView.exe")
$csv = Join-Path ([System.IO.Path]::GetTempPath()) "svv-devices.csv"
for ($i = 0; $i -lt 30; $i++) {
  Start-Process -FilePath $svv -ArgumentList "/scomma", "`"$csv`"" -Wait
  if ((Test-Path $csv) -and (Select-String -Path $csv -Pattern "VB-Audio Virtual Cable" -Quiet)) {
    Write-Host "VB-Cable endpoints detected:"
    Import-Csv $csv | Where-Object { $_.Type -eq "Device" } |
      Format-Table Name, Direction, "Device Name", Default, "Device State" -AutoSize | Out-String | Write-Host
    exit 0
  }
  Start-Sleep -Seconds 2
}
throw "VB-Cable endpoints did not appear after installation"
