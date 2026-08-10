<#
  Reverses a quarantine batch. Reads the batch's own manifest.json and moves
  every staged item back to where it came from.

  The manifest lives inside the batch directory, so a batch stays restorable
  even if the bot's state/ is lost.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BatchId,
    [string]$Path
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_policy.ps1")

$policy = Read-Policy
$batchDir = if ($Path) { $Path } else { Join-Path $policy.quarantine_root $BatchId }
$manifestPath = Join-Path $batchDir "manifest.json"

if (-not (Test-Path $manifestPath)) { throw "no manifest at $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

if ($manifest.dry_run) { throw "batch $BatchId was a dry run; nothing was ever moved" }

$restored = 0; $missing = 0; $collided = 0; $failed = 0

foreach ($item in $manifest.staged) {
    if (-not (Test-Path -LiteralPath $item.quarantine)) {
        Write-Warning "missing from quarantine (already purged or restored?): $($item.quarantine)"
        $missing++
        continue
    }
    if (Test-Path -LiteralPath $item.original) {
        # Something now occupies the original path. Never overwrite it - the
        # thing sitting there is newer than what we staged.
        Write-Warning "original path reoccupied, skipping: $($item.original)"
        $collided++
        continue
    }
    try {
        $parent = Split-Path $item.original -Parent
        if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Move-Item -LiteralPath $item.quarantine -Destination $item.original -ErrorAction Stop
        $restored++
    } catch {
        Write-Warning "restore failed for $($item.original): $($_.Exception.Message)"
        $failed++
    }
}

Write-Output "restore $BatchId : $restored restored, $missing missing, $collided skipped (path reoccupied), $failed failed"
if ($restored -gt 0 -and $failed -eq 0 -and $collided -eq 0) {
    Write-Output "Batch fully restored. The now-empty batch directory can be removed by hand: $batchDir"
}
