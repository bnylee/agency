<#
  Tier A - read-only. Surveys the volume and proposes quarantine candidates.
  Writes state/scan-latest.json. Moves nothing, deletes nothing.

  Everything this emits is a *proposal*. quarantine.ps1 re-checks each candidate
  against Test-NeverTouch before acting, so a bug here cannot by itself cause a
  bad move.
#>
[CmdletBinding()]
param(
    [string]$Out,
    [switch]$SkipTopLevel,
    [int]$MaxScanMinutes = 30
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is EMPTY inside param() defaults when [CmdletBinding()] is
# present; resolve script-relative paths in the body.
if (-not $Out) { $Out = Join-Path $PSScriptRoot "..\state\scan-latest.json" }

. (Join-Path $PSScriptRoot "_policy.ps1")

$policy = Read-Policy
$started = Get-Date
$deadline = $started.AddMinutes($MaxScanMinutes)
$caveats = New-Object System.Collections.ArrayList
$candidates = New-Object System.Collections.ArrayList

function Test-Deadline {
    if ((Get-Date) -gt $deadline) {
        [void]$caveats.Add("Scan hit the $MaxScanMinutes-minute limit and stopped early; results are partial.")
        return $true
    }
    return $false
}

function Add-Candidate {
    param([string]$Path, [string]$Category, [string]$Reason, [int64]$Bytes, [int]$AgeDays)
    $blocked = Test-NeverTouch -Path $Path -Policy $policy
    if ($blocked) { return }   # never even propose it
    # PSCustomObject, not a bare hashtable: Measure-Object -Property and
    # Sort-Object -Property do not see hashtable keys as properties in PS 5.1.
    [void]$candidates.Add([pscustomobject][ordered]@{
        path      = $Path
        category  = $Category
        reason    = $Reason
        bytes     = $Bytes
        gb        = [math]::Round($Bytes / 1GB, 3)
        age_days  = $AgeDays
    })
}

# ---------------------------------------------------------------- volume
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$volume = [ordered]@{
    drive        = "C:"
    total_gb     = [math]::Round($disk.Size / 1GB, 2)
    free_gb      = [math]::Round($disk.FreeSpace / 1GB, 2)
    percent_free = [math]::Round(100 * $disk.FreeSpace / $disk.Size, 2)
}

# ---------------------------------------------------------------- top level
$topLevel = New-Object System.Collections.ArrayList
if (-not $SkipTopLevel) {
    foreach ($d in Get-ChildItem C:\ -Directory -Force -ErrorAction SilentlyContinue) {
        if (Test-Deadline) { break }
        $bytes = Get-DirectorySizeBytes $d.FullName
        [void]$topLevel.Add([ordered]@{ path = $d.FullName; gb = [math]::Round($bytes / 1GB, 2) })
    }
    $topLevel = @($topLevel | Sort-Object { $_.gb } -Descending)
} else {
    [void]$caveats.Add("Top-level sizing skipped (-SkipTopLevel); trend data unavailable this run.")
}

# ---------------------------------------------------------------- downloads
$dlAge = $policy.thresholds.downloads_age_days
$dlExt = @($policy.downloads.quarantine_extensions)
$dlReportOnlyBytes = [int64]0
$dlReportOnlyCount = 0

foreach ($root in @("$env:USERPROFILE\Downloads", "C:\Downloads")) {
    if (-not (Test-Path $root)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue) {
        if (Test-Deadline) { break }
        $age = [int]((Get-Date) - $f.LastWriteTime).TotalDays
        if ($age -lt $dlAge) { continue }
        if ($dlExt -contains $f.Extension.ToLowerInvariant()) {
            Add-Candidate -Path $f.FullName -Category "downloads" `
                -Reason "installer/archive, not modified in $age days" `
                -Bytes $f.Length -AgeDays $age
        } else {
            # Non-installer files are reported, never staged: a stale .docx may
            # still be the only copy of something.
            $dlReportOnlyBytes += $f.Length
            $dlReportOnlyCount++
        }
    }
}

# ---------------------------------------------------------------- dev artifacts
$devNames = @($policy.dev_artifacts.directory_names)
$devExt = @($policy.dev_artifacts.source_extensions)
$devAge = $policy.thresholds.dev_artifact_age_days
$seenDev = New-Object System.Collections.Generic.HashSet[string]

foreach ($root in @("$env:USERPROFILE")) {
    foreach ($d in Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -ErrorAction SilentlyContinue) {
        if (Test-Deadline) { break }
        if ($devNames -notcontains $d.Name) { continue }

        $full = Get-NormalizedPath $d.FullName
        # Skip nested matches (node_modules inside node_modules) - the outermost
        # already accounts for the bytes.
        $nested = $false
        foreach ($s in $seenDev) { if (($full + '\').ToLowerInvariant().StartsWith(($s + '\').ToLowerInvariant())) { $nested = $true; break } }
        if ($nested) { continue }

        if (Test-NeverTouch -Path $full -Policy $policy) { continue }

        # Eligible only if the owning project itself is cold.
        $project = Split-Path $full -Parent
        $newest = Get-ChildItem -LiteralPath $project -Recurse -File -Force -ErrorAction SilentlyContinue |
                  Where-Object { $devExt -contains $_.Extension.ToLowerInvariant() } |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $newest) { continue }
        $age = [int]((Get-Date) - $newest.LastWriteTime).TotalDays
        if ($age -lt $devAge) { continue }

        [void]$seenDev.Add($full)
        Add-Candidate -Path $full -Category "dev_artifact" `
            -Reason "regenerable build output; newest source in $project is $age days old" `
            -Bytes (Get-DirectorySizeBytes $full) -AgeDays $age
    }
}

# ---------------------------------------------------------------- system caches
foreach ($raw in $policy.system_caches.paths) {
    if (Test-Deadline) { break }
    $p = [System.Environment]::ExpandEnvironmentVariables($raw)
    if (-not (Test-Path $p)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue) {
        $age = [int]((Get-Date) - $f.LastWriteTime).TotalDays
        Add-Candidate -Path $f.FullName -Category "system_cache" `
            -Reason "regenerable cache under $raw" -Bytes $f.Length -AgeDays $age
    }
}

# ---------------------------------------------------------------- report only
$rb = (New-Object -ComObject Shell.Application).NameSpace(10)
$rbBytes = [int64]0; $rbCount = 0
if ($rb) {
    foreach ($i in $rb.Items()) { $rbCount++; try { $rbBytes += [int64]$i.ExtendedProperty("Size") } catch {} }
}

# hiberfil.sys cannot be opened by path - it is locked and system-protected, so
# Get-ChildItem on the literal path fails and SilentlyContinue turns a 12.58 GB
# reclaim opportunity into a silent 0. Enumerating the root and filtering works.
$hiber = Get-ChildItem C:\ -Force -File -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -eq "hiberfil.sys" } | Select-Object -First 1

$reportOnly = [ordered]@{
    recycle_bin = [ordered]@{
        items = $rbCount
        gb = [math]::Round($rbBytes / 1GB, 2)
        note = "Emptying is Benny's call; the Recycle Bin is the last line of undo for everything else on this machine."
        command = "Clear-RecycleBin -DriveLetter C -Force"
    }
    hibernation = [ordered]@{
        gb = if ($hiber) { [math]::Round($hiber.Length / 1GB, 2) } else { 0 }
        note = "Reclaimed instantly by disabling hibernation. A bot must not reconfigure power settings."
        command = "powercfg /h off   (run as Administrator)"
    }
    dism_component_cleanup = [ordered]@{
        note = "WinSxS reports a large apparent size but is hardlink-inflated; the real on-disk cost is a fraction of it and it is NEVER reclaimable as shown. Only DISM can safely reduce it, and it needs Administrator."
        command = "Dism.exe /Online /Cleanup-Image /StartComponentCleanup"
    }
    downloads_non_installer = [ordered]@{
        files = $dlReportOnlyCount
        gb = [math]::Round($dlReportOnlyBytes / 1GB, 2)
        note = "Stale Downloads that are not installers/archives. Reported only - never staged, since these may be the only copy."
    }
}

[void]$caveats.Add("Quarantine is a same-volume move, so staging frees ZERO bytes. Space is reclaimed only when purge.ps1 runs. Report pending vs reclaimed separately.")
[void]$caveats.Add("Installed programs are the dominant consumer on this machine and are report-only forever; see scan_installed.ps1.")

$totalBytes = ($candidates | Measure-Object -Property bytes -Sum).Sum
if ($null -eq $totalBytes) { $totalBytes = 0 }

$result = [ordered]@{
    generated_at      = Get-IsoTimestamp
    status            = "ok"
    scan_seconds      = [int]((Get-Date) - $started).TotalSeconds
    volume            = $volume
    top_level         = $topLevel
    candidate_count   = $candidates.Count
    candidate_total_gb = [math]::Round($totalBytes / 1GB, 2)
    candidates        = @($candidates)
    report_only       = $reportOnly
    caveats           = @($caveats)
}

Write-JsonNoBom -Object $result -Path $Out

# The full candidate list is machine input for quarantine.ps1 and nothing else -
# at 8,000+ candidates it is ~4 MB, and pointing the narration step at it would
# flood the context of every weekly run. The report reads this summary instead.
$byCategory = @($candidates | Group-Object category | ForEach-Object {
    [pscustomobject][ordered]@{
        category = $_.Name
        count    = $_.Count
        gb       = [math]::Round((($_.Group | Measure-Object -Property bytes -Sum).Sum) / 1GB, 2)
    }
} | Sort-Object gb -Descending)

$summary = [ordered]@{
    generated_at       = $result.generated_at
    status             = $result.status
    scan_seconds       = $result.scan_seconds
    volume             = $volume
    top_level          = @($topLevel | Select-Object -First 20)
    candidate_count    = $candidates.Count
    candidate_total_gb = $result.candidate_total_gb
    by_category        = $byCategory
    largest_candidates = @($candidates | Sort-Object bytes -Descending | Select-Object -First 25)
    report_only        = $reportOnly
    caveats            = @($caveats)
    full_plan_path     = $Out
    note               = "Summary for reporting. The full candidate list lives in full_plan_path and is consumed by quarantine.ps1, not by the report."
}
Write-JsonNoBom -Object $summary -Path (Join-Path (Split-Path $Out -Parent) "scan-summary.json")

Write-Output "scan_disk: $($candidates.Count) candidates, $([math]::Round($totalBytes/1GB,2)) GB proposed -> $Out (summary alongside)"
