<#
  Tier A - read-only. Runs czkawka in report-only mode and normalises its output.

  -D NONE is passed explicitly even though it is czkawka's default. Relying on a
  third-party tool's default for the property that keeps this bot non-destructive
  would mean a future default change silently turns the bot into a deleter.
  guard_commands.py independently rejects any -D value other than NONE.

  v1 is report-only by design. Quarantining duplicates needs a deterministic
  keep-rule (czkawka reference paths) so the copy you actually use is provably
  the one kept; shipping before that is settled risks staging the wrong copy.
#>
[CmdletBinding()]
param(
    [string[]]$ScanPaths = @("$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Pictures", "$env:USERPROFILE\Videos"),
    [string]$Out,
    [string]$CzkawkaPath,
    [int]$MinSizeBytes = 1048576
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is EMPTY inside param() defaults when [CmdletBinding()] is
# present; resolve script-relative paths in the body.
if (-not $Out) { $Out = Join-Path $PSScriptRoot "..\state\dupes-latest.json" }
if (-not $CzkawkaPath) { $CzkawkaPath = Join-Path $PSScriptRoot "..\tools\czkawka_cli.exe" }

. (Join-Path $PSScriptRoot "_policy.ps1")

$policy = Read-Policy

if (-not (Test-Path $CzkawkaPath)) {
    $result = [ordered]@{
        generated_at = Get-IsoTimestamp
        status       = "unavailable"
        disposition  = "REPORT ONLY"
        error        = "czkawka_cli not found at $CzkawkaPath. Run scripts/install_tools.ps1 once."
        groups       = @()
    }
    Write-JsonNoBom -Object $result -Path $Out
    Write-Output "scan_duplicates: czkawka_cli missing, wrote unavailable status -> $Out"
    exit 0
}

# Never scan inside protected trees, and never scan OneDrive: a duplicate found
# there could invite action whose local delete propagates to the cloud.
$targets = @()
foreach ($p in $ScanPaths) {
    if (-not (Test-Path $p)) { continue }
    if (Test-NeverTouch -Path $p -Policy $policy) { continue }
    $targets += (Get-NormalizedPath $p)
}

if ($targets.Count -eq 0) {
    $result = [ordered]@{
        generated_at = Get-IsoTimestamp
        status       = "skipped"
        disposition  = "REPORT ONLY"
        note         = "No eligible scan paths after applying the never-touch list."
        groups       = @()
    }
    Write-JsonNoBom -Object $result -Path $Out
    Write-Output "scan_duplicates: no eligible paths -> $Out"
    exit 0
}

$raw = Join-Path (Split-Path $Out -Parent) "dupes-czkawka-raw.json"
$excluded = @($policy.never_touch.prefixes)

# Deliberately not named $args: that is a PowerShell automatic variable, and
# shadowing it inside a script is a subtle way to break argument handling.
# czkawka takes ONE value per -d / -e occurrence; a space-separated list makes it
# reject the second path as an unexpected argument.
$czArgs = @("dup")
foreach ($t in $targets) { $czArgs += @("-d", $t) }
$czArgs += @(
    "-m", $MinSizeBytes,
    "-D", "NONE",              # report only - see header
    "-s", "HASH",              # explicit for the same reason as -D: SIZE and
                               # SIZE_NAME report same-size files as duplicates,
                               # which would be false positives presented as fact
    "-W",                      # czkawka exits non-zero when it FINDS duplicates;
                               # without this a successful scan reads as a failure
    "-N", "-M",                # results go to the JSON file, not the console
    "-p", $raw
)
foreach ($x in $excluded) { $czArgs += @("-e", $x) }

Write-Output "czkawka: scanning $($targets.Count) path(s), report-only ..."
& $CzkawkaPath @czArgs 2>&1 | Out-Null
$exit = $LASTEXITCODE

$groups = @()
$totalWasted = [int64]0
$parseError = $null
$rawBytes = 0

if (Test-Path $raw) {
    $rawBytes = (Get-Item -LiteralPath $raw).Length
    try {
        # czkawka 12.x emits an OBJECT keyed by file size, whose value is an
        # ARRAY OF GROUPS, each group an array of file records:
        #   { "<size>": [ [ {path,size,hash}, {...} ], [ ... ] ] }
        # Iterating the top level directly yields one opaque object, silently
        # producing zero groups on a scan that actually found plenty.
        $parsed = Get-Content -LiteralPath $raw -Raw | ConvertFrom-Json
        foreach ($sizeBucket in $parsed.PSObject.Properties) {
            foreach ($group in $sizeBucket.Value) {
                $files = @($group)
                if ($files.Count -lt 2) { continue }
                $size = [int64]$files[0].size
                $wasted = $size * ($files.Count - 1)
                $totalWasted += $wasted
                $groups += [pscustomobject][ordered]@{
                    copies     = $files.Count
                    size_bytes = $size
                    wasted_gb  = [math]::Round($wasted / 1GB, 3)
                    paths      = @($files | ForEach-Object { $_.path })
                }
            }
        }
    } catch {
        # Report the failure rather than guessing at a schema - a wrong parse
        # would understate reclaimable space with no signal that it did.
        $groups = @()
        $parseError = $_.Exception.Message
    }
}

# A non-trivial raw file that yields no groups means the schema moved under us.
# Surface it instead of reporting a confident zero.
if ($rawBytes -gt 512 -and $groups.Count -eq 0 -and -not $parseError) {
    $parseError = "czkawka wrote $rawBytes bytes of results but no groups parsed - its JSON schema has probably changed. Treat the zero below as UNKNOWN, not as 'no duplicates'."
}

$result = [ordered]@{
    generated_at   = Get-IsoTimestamp
    status         = if ($exit -eq 0) { "ok" } else { "partial" }
    disposition    = "REPORT ONLY - duplicates are never staged in v1; a deterministic keep-rule must be settled first."
    czkawka_exit   = $exit
    scanned_paths  = $targets
    min_size_bytes = $MinSizeBytes
    group_count    = $groups.Count
    wasted_gb      = [math]::Round($totalWasted / 1GB, 2)
    groups         = @($groups | Sort-Object { $_.wasted_gb } -Descending | Select-Object -First 100)
    raw_output     = $raw
    parse_error    = $parseError
    note           = "'Duplicate' is not the same as 'unwanted'. These are candidates for a human to look at, not a deletion list."
}

Write-JsonNoBom -Object $result -Path $Out
Write-Output "scan_duplicates: $($groups.Count) groups, $([math]::Round($totalWasted/1GB,2)) GB duplicated -> $Out"
