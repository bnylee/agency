# Undo a repair batch.
#
#   .\revert.ps1 -List                    show every batch
#   .\revert.ps1 -BatchId 2026-08-04      put that batch back
#   .\revert.ps1 -BatchId 2026-08-04 -WhatIfOnly   say what it would do
#
# This is the other half of Tier A. A repair is only allowed to be autonomous
# because this exists, so it has to be boring and total: every file the write
# guard snapshotted goes back exactly as it was.
#
# It never deletes. A file the bot CREATED is moved into the batch's reverted/
# folder rather than removed, so a revert is itself reversible. The Agency has
# one destructive operation and it lives in disk-cleanup behind an interactive
# confirmation; this is not going to be the second.
param(
    [string]$BatchId,
    [switch]$List,
    [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"
$botRoot = Split-Path -Parent $PSScriptRoot
$agency = Split-Path -Parent $botRoot
$repairs = Join-Path $botRoot "repairs"

if ($List -or -not $BatchId) {
    if (-not (Test-Path $repairs)) { Write-Output "No repair batches."; exit 0 }
    $rows = Get-ChildItem $repairs -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
        $m = Join-Path $_.FullName "manifest.json"
        if (-not (Test-Path $m)) { return }
        $man = Get-Content $m -Raw | ConvertFrom-Json
        $entries = @($man.entries.PSObject.Properties)
        [pscustomobject]@{
            BatchId  = $_.Name
            Files    = $entries.Count
            Modified = @($entries | Where-Object { $_.Value.action -eq "modified" }).Count
            Created  = @($entries | Where-Object { $_.Value.action -eq "created" }).Count
            Reverted = [bool]$man.reverted_at
        }
    }
    if (-not $rows) { Write-Output "No repair batches." } else { $rows | Format-Table -AutoSize }
    exit 0
}

if ($BatchId -notmatch '^\d{4}-\d{2}-\d{2}$') {
    Write-Error "BatchId must be an ISO date (YYYY-MM-DD). Shape-checked before any path is built, so a traversal sequence is never joined to a real directory."
    exit 2
}

$batch = Join-Path $repairs $BatchId
$manifestPath = Join-Path $batch "manifest.json"
if (-not (Test-Path $manifestPath)) {
    Write-Error "No manifest at $manifestPath. Without one there is no record of what to put back, and guessing is not a revert."
    exit 2
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$restored = 0; $movedAside = 0; $problems = @()

foreach ($entry in $manifest.entries.PSObject.Properties) {
    $rel = $entry.Name
    $info = $entry.Value
    $target = Join-Path $agency ($rel -replace '/', '\')

    # The manifest is written by this bot's own hook, but it is still a file on
    # disk. Re-check that every path lands inside the Agency before writing to
    # it, so a corrupted or hand-edited manifest cannot aim the restore outside.
    $resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $target))
    if (-not $resolvedParent.StartsWith([System.IO.Path]::GetFullPath($agency), [StringComparison]::OrdinalIgnoreCase)) {
        $problems += "$rel resolves outside the Agency; skipped"
        continue
    }

    if ($info.action -eq "modified") {
        $snapshot = Join-Path $batch ($info.snapshot -replace '/', '\')
        if (-not (Test-Path $snapshot)) { $problems += "$rel : snapshot missing at $snapshot"; continue }
        if ($WhatIfOnly) { Write-Output "would restore  $rel"; $restored++; continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item $snapshot $target -Force
        $restored++
    } elseif ($info.action -eq "created") {
        if (-not (Test-Path $target)) { continue }   # already gone; nothing to do
        $aside = Join-Path (Join-Path $batch "reverted") ($rel -replace '/', '\')
        if ($WhatIfOnly) { Write-Output "would move aside  $rel -> repairs\$BatchId\reverted\"; $movedAside++; continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $aside) | Out-Null
        Move-Item $target $aside -Force
        $movedAside++
    } else {
        $problems += "$rel : unknown action '$($info.action)'"
    }
}

if (-not $WhatIfOnly) {
    $manifest | Add-Member -NotePropertyName reverted_at -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
    $json = $manifest | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Output ""
Write-Output "Batch $BatchId$(if ($WhatIfOnly) { ' (what-if)' })"
Write-Output "  restored from snapshot : $restored"
Write-Output "  created files moved to repairs\$BatchId\reverted\ : $movedAside"
if ($problems.Count) {
    Write-Output "  problems:"
    $problems | ForEach-Object { Write-Output "    - $_" }
}
Write-Output ""
Write-Output "Re-run scripts\health_check.ps1 to confirm the Agency is back where you wanted it."
exit $(if ($problems.Count) { 1 } else { 0 })
