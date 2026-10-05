# Builds the Windows endpoint and packages it into one sendable zip.
#
#   cd endpoint-win
#   scripts\build-exe.ps1 -Broker wss://<your-ngrok-domain>/ws/endpoint -Secret <ENDPOINT_SECRET>
#
# Output: dist\remote-access-endpoint-win.zip  (the .exe + any DLLs + endpoint.json)
# Needs: Rust (MSVC toolchain) from https://rustup.rs, plus the Visual Studio
# C++ build tools (Desktop development with C++).
param(
  [Parameter(Mandatory = $true)][string]$Broker,
  [Parameter(Mandatory = $true)][string]$Secret,
  [string]$Target = ""
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "Building release binary..." -ForegroundColor Cyan
cargo build --release

$bin = "target\release\remote-access-endpoint.exe"
if (!(Test-Path $bin)) { throw "build did not produce $bin" }

# Fresh dist folder with the exe, any sibling DLLs, and the baked-in config.
$dist = "dist\remote-access-endpoint"
if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null
Copy-Item $bin $dist
Get-ChildItem "target\release\*.dll" -ErrorAction SilentlyContinue | Copy-Item -Destination $dist

# endpoint.json: the broker address + shared secret the exe reads on launch.
$cfg = @{ broker = $Broker; secret = $Secret }
if ($Target -ne "") { $cfg.target = $Target }
$cfg | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $dist "endpoint.json") -Encoding UTF8

$zip = "dist\remote-access-endpoint-win.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$dist\*" -DestinationPath $zip

Write-Host ""
Write-Host "Built and packaged:" -ForegroundColor Green
Write-Host "  Run here:  $bin"
Write-Host "  Send this: $zip"
Write-Host "  (the target user unzips it and runs remote-access-endpoint.exe)"
