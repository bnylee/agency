<#
  Tier C - PERMANENT DELETION. This is the only script in the bot that destroys
  anything, and the bot never runs it.

  Two independent locks:
    1. guard_commands.py denies any command containing "purge.ps1".
    2. This script refuses to run without a genuine interactive console and a
       typed confirmation matching the batch id.

  Either lock alone is sufficient; both exist because the cost of being wrong
  here is unrecoverable. Benny runs this by hand, after reading the manifest.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BatchId
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_policy.ps1")

# ---- lock: must be a real interactive console ---------------------------
# Checked FIRST, before anything about the batch is even looked at, so the
# refusal to run unattended is unconditional. Ordered after the manifest check
# this would have passed silently whenever the batch happened not to exist,
# which is the wrong thing to make conditional.
if (-not [Environment]::UserInteractive) {
    throw "purge.ps1 requires an interactive session. Refusing to run unattended."
}
if ([Console]::IsInputRedirected) {
    throw "purge.ps1 requires a console with real stdin. Refusing to run with redirected input."
}

$policy = Read-Policy
$batchDir = Join-Path $policy.quarantine_root $BatchId
$manifestPath = Join-Path $batchDir "manifest.json"

if (-not (Test-Path $manifestPath)) { throw "no manifest at $manifestPath - refusing to purge a directory this bot did not stage" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.dry_run) { throw "batch $BatchId was a dry run; there is nothing staged to purge" }

$totalGb = [math]::Round((($manifest.staged | Measure-Object -Property bytes -Sum).Sum) / 1GB, 2)

Write-Host ""
Write-Host "PERMANENT DELETION" -ForegroundColor Red
Write-Host "  batch      : $BatchId"
Write-Host "  directory  : $batchDir"
Write-Host "  items      : $($manifest.staged_count)"
Write-Host "  reclaims   : $totalGb GB"
Write-Host ""
Write-Host "  This cannot be undone. To keep these files instead, run:" -ForegroundColor Yellow
Write-Host "      .\scripts\restore.ps1 -BatchId $BatchId" -ForegroundColor Yellow
Write-Host ""

$typed = Read-Host "Type the batch id ($BatchId) to confirm permanent deletion"
if ($typed -ne $BatchId) {
    Write-Output "Confirmation did not match. Nothing deleted."
    exit 1
}

$before = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace
Remove-Item -LiteralPath $batchDir -Recurse -Force
$after = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace

Write-Output "purge $BatchId : deleted. Free space $([math]::Round($before/1GB,2)) GB -> $([math]::Round($after/1GB,2)) GB (reclaimed $([math]::Round(($after-$before)/1GB,2)) GB)"
