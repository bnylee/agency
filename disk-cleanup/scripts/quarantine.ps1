<#
  Tier B - reversible. Moves scan candidates into a dated quarantine batch and
  writes a manifest. Deletes nothing, ever.

  Two things to keep in mind reading this:

  1. A same-volume move is a rename. It rewrites no bytes, so it is atomic and
     content-preserving - but it also frees ZERO disk space. Space is reclaimed
     only when purge.ps1 runs. This script reports "pending", never "freed".

  2. The scan is a proposal, not an authority. Every candidate is re-checked
     through Test-NeverTouch here, immediately before the move, so a bug in a
     scanner cannot by itself cause a bad move.
#>
[CmdletBinding()]
param(
    [string]$Plan,
    [string]$Out,
    [string[]]$Categories = @("downloads", "dev_artifact", "system_cache"),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is EMPTY inside param() defaults when [CmdletBinding()] is
# present; resolve script-relative paths in the body.
if (-not $Plan) { $Plan = Join-Path $PSScriptRoot "..\state\scan-latest.json" }
if (-not $Out) { $Out = Join-Path $PSScriptRoot "..\state\quarantine-latest.json" }

. (Join-Path $PSScriptRoot "_policy.ps1")

$policy = Read-Policy
if (-not (Test-Path $Plan)) { throw "plan not found: $Plan (run scan_disk.ps1 first)" }

# Deliberately NOT $plan. PowerShell variable names are case-insensitive, so
# $plan IS the [string]$Plan parameter, and assigning the parsed object to a
# string-typed variable silently coerces it to "@{generated_at=...}". That made
# .candidates $null and turned this entire script into a no-op that still
# reported success. Caught by the restore round-trip test, not by review.
$planData = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json

$candidateList = @($planData.candidates)
if ($candidateList.Count -eq 0 -and $planData.candidate_count -gt 0) {
    throw "plan reports $($planData.candidate_count) candidates but none parsed - refusing to report a successful no-op"
}

$batchId = (Get-Date).ToString("yyyy-MM-dd")
$quarantineRoot = $policy.quarantine_root
$batchDir = Join-Path $quarantineRoot $batchId

$maxBytes = [int64]$policy.caps.max_gb_per_run * 1GB
$maxFiles = [int]$policy.caps.max_files_per_run

$staged = New-Object System.Collections.ArrayList
$held = New-Object System.Collections.ArrayList
$rejected = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList

$runningBytes = [int64]0
$runningFiles = 0
$volumeRoot = [System.IO.Path]::GetPathRoot((Get-NormalizedPath $quarantineRoot))

function Get-QuarantinePath {
    # C:\Users\you\Downloads\x.exe -> <batch>\C_\Users\you\Downloads\x.exe
    param([string]$Original)
    $full = Get-NormalizedPath $Original
    $rel = ($full -replace '^([A-Za-z]):', '$1_')
    Join-Path $batchDir $rel
}

foreach ($c in $candidateList) {
    if ($Categories -notcontains $c.category) { continue }

    $src = Get-NormalizedPath $c.path

    # --- gate 1: the never-touch list, re-checked at the point of action -----
    $blocked = Test-NeverTouch -Path $src -Policy $policy
    if ($blocked) {
        [void]$rejected.Add([ordered]@{ path = $src; reason = $blocked })
        continue
    }

    # --- gate 2: it must still exist ----------------------------------------
    if (-not (Test-Path -LiteralPath $src)) {
        [void]$rejected.Add([ordered]@{ path = $src; reason = "no longer exists" })
        continue
    }

    # --- gate 3: same volume, or the move stops being a rename --------------
    if ([System.IO.Path]::GetPathRoot($src) -ne $volumeRoot) {
        [void]$rejected.Add([ordered]@{
            path = $src
            reason = "cross-volume move would be copy-then-delete, which has a window where a failure loses the file"
        })
        continue
    }

    # --- gate 4: per-run caps, the runaway guard ----------------------------
    $bytes = [int64]$c.bytes
    if (($runningBytes + $bytes) -gt $maxBytes -or ($runningFiles + 1) -gt $maxFiles) {
        [void]$held.Add([ordered]@{
            path = $src; gb = $c.gb; category = $c.category
            reason = "would exceed per-run cap ($($policy.caps.max_gb_per_run) GB / $maxFiles files)"
        })
        continue
    }

    $dest = Get-QuarantinePath $src
    $record = [ordered]@{
        original   = $src
        quarantine = $dest
        category   = $c.category
        reason     = $c.reason
        bytes      = $bytes
        gb         = $c.gb
        moved_at   = $null
    }

    if ($DryRun) {
        [void]$staged.Add($record)
        $runningBytes += $bytes
        $runningFiles++
        continue
    }

    try {
        $destParent = Split-Path $dest -Parent
        if (-not (Test-Path $destParent)) { New-Item -ItemType Directory -Force -Path $destParent | Out-Null }
        Move-Item -LiteralPath $src -Destination $dest -Force -ErrorAction Stop
        $record.moved_at = Get-IsoTimestamp
        [void]$staged.Add($record)
        $runningBytes += $bytes
        $runningFiles++
    } catch {
        # Most common cause is a file locked by a running process. Recorded, not
        # retried - a silent retry loop is exactly how an unattended run stays
        # wrong for days.
        [void]$failed.Add([ordered]@{ path = $src; error = $_.Exception.Message })
    }
}

$manifest = [ordered]@{
    batch_id        = $batchId
    generated_at    = Get-IsoTimestamp
    dry_run         = [bool]$DryRun
    quarantine_root = $quarantineRoot
    batch_dir       = $batchDir
    categories      = $Categories
    staged_count    = $staged.Count
    staged_gb       = [math]::Round($runningBytes / 1GB, 2)
    space_note      = "Staged bytes are PENDING, not reclaimed. A same-volume move frees nothing; run purge.ps1 to actually recover the space, or restore.ps1 to put it all back."
    staged          = @($staged)
    held            = @($held)
    rejected        = @($rejected)
    failed          = @($failed)
}

if ($DryRun) {
    $dryOut = Join-Path (Split-Path $Out -Parent) "quarantine-dryrun.json"
    Write-JsonNoBom -Object $manifest -Path $dryOut
    Write-Output "quarantine [DRY RUN]: would stage $($staged.Count) items, $([math]::Round($runningBytes/1GB,2)) GB. Nothing moved. -> $dryOut"
} else {
    # The manifest is written into the batch itself so a batch is self-describing
    # and restorable even if the bot's state/ is lost.
    if (-not (Test-Path $batchDir)) { New-Item -ItemType Directory -Force -Path $batchDir | Out-Null }
    Write-JsonNoBom -Object $manifest -Path (Join-Path $batchDir "manifest.json")
    Write-JsonNoBom -Object $manifest -Path $Out
    Write-Output "quarantine: staged $($staged.Count) items, $([math]::Round($runningBytes/1GB,2)) GB PENDING (not yet freed), $($held.Count) held, $($rejected.Count) rejected, $($failed.Count) failed -> $batchDir"
}
