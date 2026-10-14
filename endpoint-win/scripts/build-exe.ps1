<#
.SYNOPSIS
  Build the Windows endpoint in release mode and package it into zips that a recipient can
  unzip and double-click.

    remote-access-endpoint-win-generic.zip  exe only, NO secret. This is what invite links serve
                                            (/join/<token>); the app enrolls itself with the link's token.
                                            Always built; needs no parameters.
    remote-access-endpoint-win.zip          exe + endpoint.json with the broker address and secret baked in
                                            (legacy "Download client" tab). Built only when -Broker and
                                            -Secret are given. Config priority in the client is
                                            CLI args -> env vars -> endpoint.json -> saved enrollment.

  Copy the zips into clients/ on the server.

.EXAMPLE
  scripts\build-exe.ps1

.EXAMPLE
  scripts\build-exe.ps1 -Broker wss://your-domain/ws/endpoint -Secret <ENDPOINT_SECRET>

.EXAMPLE
  scripts\build-exe.ps1 -Broker wss://your-domain/ws/endpoint -Secret <SECRET> -Target demo-pc
#>
[CmdletBinding()]
param(
    [string]$Broker = "",
    [string]$Secret = "",
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"

# Project root is the parent of this script's folder (endpoint-win\).
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    Write-Host "==> Building release binary (static CRT via .cargo/config.toml)..."
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit code $LASTEXITCODE)" }

    $exe = Join-Path $projectRoot "target\release\remote-access-endpoint.exe"
    if (-not (Test-Path $exe)) { throw "Built exe not found at $exe" }

    $dist  = Join-Path $projectRoot "dist"
    $stage = Join-Path $dist "remote-access-endpoint-win"
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    Write-Host "==> Staging exe + config..."
    Copy-Item $exe $stage

    # Bundle any DLLs sitting next to the exe. A static build produces none,
    # but copy them if present so the package is always self-contained.
    Get-ChildItem (Join-Path $projectRoot "target\release\*.dll") -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName $stage }

    # 1) Generic package: exe only, no secret (served by invite links).
    $genericZip = Join-Path $dist "remote-access-endpoint-win-generic.zip"
    if (Test-Path $genericZip) { Remove-Item -Force $genericZip }
    Write-Host "==> Compressing generic package..."
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $genericZip

    # 2) Baked package: only when broker + secret were given.
    $zip = $genericZip
    if ($Broker -and $Secret) {
        # endpoint.json with broker + secret (+ optional target) baked in.
        # IMPORTANT: write BOM-less UTF-8. Windows PowerShell 5.1's
        # `Set-Content -Encoding utf8` prepends a UTF-8 BOM (EF BB BF), which
        # serde_json cannot parse, so the client would silently fail to load config.
        $cfg = [ordered]@{ broker = $Broker; secret = $Secret }
        if ($Target) { $cfg["target"] = $Target }
        $json = $cfg | ConvertTo-Json
        [System.IO.File]::WriteAllText(
            (Join-Path $stage "endpoint.json"),
            $json,
            (New-Object System.Text.UTF8Encoding $false))

        $zip = Join-Path $dist "remote-access-endpoint-win.zip"
        if (Test-Path $zip) { Remove-Item -Force $zip }
        Write-Host "==> Compressing baked package..."
        Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
    }

    $sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    Write-Host ""
    Write-Host "Built: dist\remote-access-endpoint-win-generic.zip (for invite links)"
    if ($Broker -and $Secret) { Write-Host "Built: dist\remote-access-endpoint-win.zip (secret baked in, $sizeMB MB)" }
    Write-Host "Copy the zip(s) into clients/ on the server."
}
finally {
    Pop-Location
}
