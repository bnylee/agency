<#
  One-time setup. Fetches czkawka_cli into tools/.

  czkawka is used rather than a hand-rolled duplicate finder because it already
  does the thing correctly and safely: deletion is opt-in (-D defaults to NONE),
  it has a real --dry-run, and it exports JSON. The root CLAUDE.md's rule is to
  reach for an existing tool before writing code, and this is that case.

  Note on verification: the czkawka project does not publish per-asset checksums,
  so there is nothing to verify the download against on first run. What this does
  instead is record the SHA256 of what it fetched into state/tools.json, so a
  later re-run that produces a different hash for the same release tag is
  detectable. That is drift detection, not authenticity - say so rather than
  implying the binary was verified.
#>
[CmdletBinding()]
param(
    [string]$ToolsDir,
    [string]$StatePath
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is EMPTY inside param() defaults when [CmdletBinding()] is
# present; resolve script-relative paths in the body.
if (-not $ToolsDir) { $ToolsDir = Join-Path $PSScriptRoot "..\tools" }
if (-not $StatePath) { $StatePath = Join-Path $PSScriptRoot "..\state\tools.json" }

. (Join-Path $PSScriptRoot "_policy.ps1")

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not (Test-Path $ToolsDir)) { New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null }

$headers = @{ "User-Agent" = "disk-cleanup-bot" }
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/qarmin/czkawka/releases/latest" -Headers $headers

$asset = $release.assets | Where-Object { $_.name -eq "windows_czkawka_cli.exe" } | Select-Object -First 1
if (-not $asset) {
    throw "windows_czkawka_cli.exe not found in czkawka release $($release.tag_name). Asset names may have changed - check https://github.com/qarmin/czkawka/releases before editing this script."
}

$dest = Join-Path $ToolsDir "czkawka_cli.exe"
Write-Output "downloading czkawka_cli $($release.tag_name) ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers $headers

$hash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash

$state = [ordered]@{
    generated_at = Get-IsoTimestamp
    czkawka = [ordered]@{
        tag            = $release.tag_name
        asset          = $asset.name
        path           = $dest
        sha256         = $hash
        size_bytes     = (Get-Item -LiteralPath $dest).Length
        source         = $asset.browser_download_url
        verification   = "SHA256 recorded on first download for drift detection only. The project publishes no checksums, so this does NOT establish authenticity of the original download."
    }
}

Write-JsonNoBom -Object $state -Path $StatePath
Write-Output "czkawka_cli $($release.tag_name) -> $dest"
Write-Output "sha256 $hash (recorded in $StatePath)"
