<#
  Scheduled entry point. Same shape as finance-research/scripts/run_premarket.ps1:
  gather the data with plain scripts first, then hand Claude the JSON to narrate.
  If a scan fails, fail loudly rather than letting Claude write a report over
  stale or missing data.

  -DryRun exercises the full path and stages nothing. Required by the root
  CLAUDE.md before the first scheduled run, and for validating any behaviour
  change afterwards.
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = "Stop"
$botDir = "C:\Users\you\OneDrive\Desktop\Agency\disk-cleanup"
$claudeExe = "C:\Users\you\.local\bin\claude.exe"
$scripts = Join-Path $botDir "scripts"
$logFile = Join-Path $botDir "runs\scheduler-log.txt"
$stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
$mode = if ($DryRun) { "DRY RUN" } else { "live" }

Set-Location $botDir
Add-Content -Path $logFile -Value "[$stamp] starting disk-cleanup weekly run ($mode)"

try {
    $free0 = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace
    Add-Content -Path $logFile -Value "[$stamp] free before: $([math]::Round($free0/1GB,2)) GB"

    # Step 1 - Tier A scans. Read-only.
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "scan_disk.ps1")
    if ($LASTEXITCODE -ne 0) { throw "scan_disk.ps1 exited $LASTEXITCODE" }

    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "scan_installed.ps1")
    if ($LASTEXITCODE -ne 0) { throw "scan_installed.ps1 exited $LASTEXITCODE" }

    # Duplicates are advisory; czkawka being absent must not fail the run.
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "scan_duplicates.ps1")
    if ($LASTEXITCODE -ne 0) { Add-Content -Path $logFile -Value "[$stamp] WARN: scan_duplicates.ps1 exited $LASTEXITCODE (advisory, continuing)" }

    Add-Content -Path $logFile -Value "[$stamp] scans ok"

    # Step 2 - Tier B staging. Reversible, capped, never deletes.
    $qArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $scripts "quarantine.ps1"))
    if ($DryRun) { $qArgs += "-DryRun" }
    & powershell @qArgs
    if ($LASTEXITCODE -ne 0) { throw "quarantine.ps1 exited $LASTEXITCODE" }
    Add-Content -Path $logFile -Value "[$stamp] quarantine step ok ($mode)"

    # Step 3 - narrate.
    $prompt = @'
Write this week's disk-cleanup report.

Read these, all already generated this run:
  state/scan-summary.json       volume, top-level sizes, per-category totals,
                                the 25 largest candidates, report-only items
  state/installed-latest.json   installed programs by size and last-used
  state/dupes-latest.json       duplicate groups (may be status "unavailable")
  state/quarantine-latest.json  what was actually staged this run
                                (or state/quarantine-dryrun.json on a dry run)

Do NOT read state/scan-latest.json. It is the full candidate list, runs to
several MB at 8,000+ candidates, and exists as machine input for quarantine.ps1.
scan-summary.json carries everything the report needs.

Write runs/<ISO-date>.md in the run-report format from the root CLAUDE.md
(Status / Did / Holding / Failed / Carry forward), covering:

- Current free space, and the change since the previous run's report if one exists.
- What was staged to quarantine this run, as PENDING space. Do NOT describe
  staged bytes as freed or reclaimed: quarantine is a same-volume move and frees
  nothing until purge.ps1 runs. State the purge and restore commands.
- Anything in "held" (hit the per-run cap) and "rejected" (hit the never-touch
  list), with reasons. These belong under Holding.
- The installed-programs picture, ranked by size, flagging cold entries. This is
  the largest category on this machine by a wide margin. It is REPORT ONLY: name
  each candidate, its size, its last-used date and its uninstall route, and leave
  the decision to Benny. Never present an uninstall as something you did or will do.
- Respect the metadata caveats in installed-latest.json: only Steam gives a real
  last-played date. Epic and Riot use directory mtime, and registry-listed apps
  use the INSTALL date, not a usage date. Do not call those "unused".
- The report_only items in scan-latest.json (Recycle Bin, hibernation, DISM).
  For WinSxS, state plainly that its apparent size is hardlink-inflated and is
  not reclaimable as shown.
- Duplicates if available, as candidates for a human to review, never a deletion list.

This is a report, not an action log for things you did not do. If a scan failed
or a file was missing, say so under Failed with the error text rather than
working around it. Then append one line to runs/ledger.md.

Finally, write runs/<ISO-date>.artifact.json — the facts file for the
live-artifact skill, whose instructions are in
.claude/skills/live-artifact/SKILL.md. Read that file for the shape; do not guess
it, and do not write any HTML yourself. Lead with reclaimable space as the first
metric, put the scan categories in a "bars" section and the installed programs in
a "table" section, and copy Holding and Failed from the report verbatim. Keep the
summary to two plain sentences a non-technical reader could act on. The staged /
freed distinction above applies to this file exactly as it does to the report.
'@

    # PowerShell 5.1 wraps every stderr line from a native command in an
    # ErrorRecord when stderr is merged with 2>&1, and under
    # $ErrorActionPreference = "Stop" that ErrorRecord is terminating. claude.exe
    # writes ordinary progress and warnings to stderr, so the FIRST such line
    # aborted the run and the catch below logged it as a failure. On 2026-08-04
    # sam-research and finance-research both died exactly this way, on the
    # harmless "no stdin data received in 3s" warning -- after the agent had
    # already run. This bot shares the pattern and would have died the same way
    # on its next Saturday. stderr is still captured for the log; it just no
    # longer decides whether the run lived.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # $null on the pipeline closes claude.exe's stdin immediately. It sends
        # zero bytes -- verified, so it cannot append anything to the -p prompt.
        # Without it a scheduled run has no stdin at all and claude stalls three
        # seconds before emitting the warning above.
        $output = $null | & $claudeExe -p $prompt --permission-mode dontAsk 2>&1
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Add-Content -Path $logFile -Value $output

    $free1 = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace
    Add-Content -Path $logFile -Value "[$stamp] free after: $([math]::Round($free1/1GB,2)) GB (delta $([math]::Round(($free1-$free0)/1GB,2)) GB)"
    Add-Content -Path $logFile -Value "[$stamp] report finished, exit $exit"

    # Render the run into a standalone HTML page, if the agent left a facts file.
    # Called from the SCRIPT, not by the agent, and that is deliberate: this bot's
    # guard_commands.py allowlists only its own scripts AND refuses any path under
    # OneDrive outside its own tree. The shared renderer is both. Loosening either
    # of those locks to get a nicer HTML page would be a bad trade, and calling it
    # from here means neither has to move.
    $agencyRoot = Split-Path -Parent $botDir
    $today = Get-Date -Format "yyyy-MM-dd"
    & (Join-Path $agencyRoot ".claude\skills\live-artifact\Render-Artifact.ps1") `
        -Facts (Join-Path $botDir "runs\$today.artifact.json") `
        -Out   (Join-Path $botDir "runs\$today.html") `
        -Log   $logFile -DryRun:$DryRun

    # With stderr no longer terminating, the exit code is the only real failure
    # signal left. Without this check a genuinely failed agent run would log
    # "finished" and be indistinguishable from a good one.
    if ($exit -ne 0) { throw "claude exited $exit" }
} catch {
    $err = $_
    Add-Content -Path $logFile -Value "[$stamp] FAILED: $err"
    # A scheduled run has no chat, so a failure that only reaches the log is a
    # failure nobody sees -- and bots:freshness reads runs/, not this log, so
    # without a report a dead run is invisible to the health check too.
    if (-not $DryRun) {
        $failure = @"
## disk-cleanup — $stamp
**Status** — failed
**Did** — see the scans logged above; the run aborted before the report was written.
**Holding** — nothing.
**Failed** — $err
**Carry forward** — Quarantine staging may not have been narrated this week. The
scans in state/ are current as of this run; check state/quarantine-latest.json
against runs/scheduler-log.txt before assuming a batch was staged.
"@
        $reportPath = Join-Path $botDir "runs\$(Get-Date -Format 'yyyy-MM-dd').md"
        if (-not (Test-Path $reportPath)) {
            [System.IO.File]::WriteAllText($reportPath, $failure, (New-Object System.Text.UTF8Encoding($false)))
        }
    }
}
