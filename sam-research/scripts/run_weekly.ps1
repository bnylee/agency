$ErrorActionPreference = "Stop"
$botDir = "C:\Users\you\OneDrive\Desktop\Agency\sam-research"
$claudeExe = "C:\Users\you\.local\bin\claude.exe"
$logFile = Join-Path $botDir "runs\scheduler-log.txt"
$timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"

Set-Location $botDir
Add-Content -Path $logFile -Value "[$timestamp] starting scheduled sam-research run"

$prompt = "Run this week's sam-research check. Follow Agency/CLAUDE.md and sam-research/CLAUDE.md exactly: re-read the SAM Prototype docs fresh, do the three tasks (data-source monitoring, literature verification, licensing/compliance tracking), write the run report to runs/<ISO-date>.md, and append a line to runs/ledger.md. Then write runs/<ISO-date>.artifact.json, the facts file for the live-artifact skill — read .claude/skills/live-artifact/SKILL.md for the shape rather than guessing it, and write no HTML yourself. Put source freshness in a table, licence changes in a list, and copy Holding and Failed from the report verbatim."

try {
    # PowerShell 5.1 wraps every stderr line from a native command in an
    # ErrorRecord when stderr is merged with 2>&1, and under
    # $ErrorActionPreference = "Stop" that ErrorRecord is terminating. claude.exe
    # writes ordinary progress and warnings to stderr, so the FIRST such line
    # aborted the run and the catch below logged it as a failure. On 2026-08-04
    # this bot and finance-research both died exactly this way, on the harmless
    # "no stdin data received in 3s" warning -- after the agent had already run.
    # stderr is still captured for the log; it just no longer decides whether the
    # run lived.
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
    Add-Content -Path $logFile -Value "[$timestamp] run finished, exit code $exit"

    # Render the run into a standalone HTML page, if the agent left a facts file.
    # Called from here rather than by the agent because this bot's agent has no
    # shell permission at all, and because it costs no model tokens this way.
    # Never throws: a missing facts file is the normal state of a run that ended
    # early, and a cosmetic page is not worth failing a good run over.
    $agencyRoot = Split-Path -Parent $botDir
    $today = Get-Date -Format "yyyy-MM-dd"
    & (Join-Path $agencyRoot ".claude\skills\live-artifact\Render-Artifact.ps1") `
        -Facts (Join-Path $botDir "runs\$today.artifact.json") `
        -Out   (Join-Path $botDir "runs\$today.html") `
        -Log   $logFile

    # With stderr no longer terminating, the exit code is the only real failure
    # signal left. Without this check a genuinely failed agent run would log
    # "finished" and be indistinguishable from a good one.
    if ($exit -ne 0) { throw "claude exited $exit" }
} catch {
    $err = $_
    Add-Content -Path $logFile -Value "[$timestamp] run FAILED: $err"
    # A scheduled run has no chat, so a failure that only reaches the log is a
    # failure nobody sees -- and bots:freshness reads runs/, not this log, so
    # without a report a dead run is invisible to the health check too. Same
    # pattern finance-research already uses.
    $failure = @"
## sam-research — $timestamp
**Status** — failed
**Did** — nothing completed; the run aborted before writing a report.
**Holding** — nothing.
**Failed** — $err
**Carry forward** — This week's data-source, literature and licensing checks did
not run. See runs/scheduler-log.txt for the full trace.
"@
    $reportPath = Join-Path $botDir "runs\$(Get-Date -Format 'yyyy-MM-dd').md"
    if (-not (Test-Path $reportPath)) {
        [System.IO.File]::WriteAllText($reportPath, $failure, (New-Object System.Text.UTF8Encoding($false)))
    }
}
