# agency-repair daily run.
#
#   .\run_repair.ps1                  live
#   .\run_repair.ps1 -DryRun          full logic; every Tier A write refused
#   .\run_repair.ps1 -SkipAgent       probes only. NOT a dry run.
#   .\run_repair.ps1 -ForceResearch   run the GitHub/Reddit sweep off-schedule
#
# The health check runs FIRST and without an agent. If every probe passes and it
# is not the research day, this script writes a one-line report and exits having
# spent nothing. That ordering is what lets this bot run daily: the decision
# about whether to spend tokens cannot be made by the thing that spends them.
param(
    [switch]$DryRun,
    [switch]$SkipAgent,
    [switch]$ForceResearch
)

$ErrorActionPreference = "Stop"
$botDir = "C:\Users\you\OneDrive\Desktop\Agency\agency-repair"
$claudeExe = "C:\Users\you\.local\bin\claude.exe"
$logFile = Join-Path $botDir "runs\scheduler-log.txt"
$today = Get-Date -Format "yyyy-MM-dd"
$stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"

if ($DryRun) {
    $work = Join-Path $botDir "state\dryrun"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $report = Join-Path $work "report.md"
} else {
    $work = Join-Path $botDir "state"
    $report = Join-Path $botDir "runs\$today.md"
}
$before = Join-Path $work "health-latest.json"
$after = Join-Path $work "health-after.json"

New-Item -ItemType Directory -Force -Path (Join-Path $botDir "runs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $botDir "repairs") | Out-Null

$isResearchDay = $ForceResearch -or ((Get-Date).DayOfWeek -eq "Sunday")
$mode = if ($DryRun) { "DRY RUN" } elseif ($SkipAgent) { "probes only" } else { "live" }
Set-Location $botDir
Add-Content -Path $logFile -Value "[$stamp] starting repair run ($mode, research=$isResearchDay)"

try {
    # Step 1: the probes.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $botDir "scripts\health_check.ps1") -Out $before -Quiet
    if (-not (Test-Path $before)) { throw "health_check.ps1 produced no output at $before" }
    $health = Get-Content $before -Raw | ConvertFrom-Json
    Add-Content -Path $logFile -Value "[$stamp] health: $($health.status) ($($health.counts.pass) pass / $($health.counts.fail) fail / $($health.counts.skip) skip)"

    if ($SkipAgent) {
        Write-Output (Get-Content $before -Raw)
        Add-Content -Path $logFile -Value "[$stamp] probes only; no agent invoked"
        exit $(if ($health.counts.fail -gt 0) { 1 } else { 0 })
    }

    # Step 2: the cheap path. Nothing broken and nothing to research means there
    # is nothing for an agent to do, and inventing work for it is how a daily
    # bot quietly becomes the most expensive thing in the ledger.
    if ($health.counts.fail -eq 0 -and -not $isResearchDay -and -not $DryRun) {
        $skipNote = if ($health.counts.skip -gt 0) { " $($health.counts.skip) probe(s) skipped -- see state/health-latest.json." } else { "" }
        $quiet = @"
## agency-repair — $stamp
**Status** — ok
**Did** — Ran $($health.counts.total) health probes; all $($health.counts.pass) that could run passed.$skipNote No agent was invoked and no tokens were spent.
**Holding** — nothing.
**Failed** — nothing.
**Carry forward** — Nothing outstanding. The research sweep runs Sundays.
"@
        [System.IO.File]::WriteAllText($report, $quiet, (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::AppendAllText((Join-Path $botDir "runs\ledger.md"), "| $today | ok | 0 (no agent) |`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Add-Content -Path $logFile -Value "[$stamp] healthy, no research day; exited without invoking the agent"
        exit 0
    }

    # Step 3: the agent.
    $prompt = @'
You are the Agency's repair shop. Read your CLAUDE.md before acting on any of
this; the tier rules in it are binding and the guard hooks enforce them whether
you agree or not.

The health check has already run. Read {{BEFORE}} for the results.

## If any probe failed

For each failure, in order of how much it breaks:

1. Diagnose it from the evidence and the source. State the root cause. If you
   cannot establish one, say so -- a guess dressed as a diagnosis is worse than
   an open failure, because it closes the ticket.
2. Decide the tier. Tier A is the control plane's own source
   (dashboard/src, dashboard/server, dashboard/index.html, vite.config.ts) and
   nothing else. EVERYTHING else -- every sibling bot, every .claude directory,
   every CLAUDE.md, package.json -- is Tier B.
3. **Tier A:** make the fix, then re-run just that probe with
   `powershell -File scripts/health_check.ps1 -Only <probe-name>` and confirm it
   went from fail to pass. If it did not, revert your change by hand and
   demote it to Tier B. The write guard snapshots each file before your first
   edit, so scripts/revert.ps1 can undo the batch.
4. **Tier B:** write the patch and its rationale to
   repairs/{{TODAY}}/proposed/<short-name>.md -- the diagnosis, the exact change
   you would make, and what it would fix. Do not apply it.

Caps: 12 files and 400 changed lines of Tier A across the whole run. Past that,
the batch becomes a Tier B proposal, because a repair that large is a redesign.

## {{RESEARCH}}

## Then write the report

Write {{REPORT}} in the root CLAUDE.md's format.
- **Did** lists Tier A repairs, each with the probe that went red to green and
  the batch id.
- **Holding** lists Tier B proposals and the approval each needs.
- **Failed** lists anything you could not diagnose, with the evidence.

Be honest about what you did not fix. A run that reports a failure has done its
job; a run that quietly produced a plausible-looking patch has not.

Then write {{FACTS}} — the facts file for the live-artifact skill, whose
instructions are in .claude/skills/live-artifact/SKILL.md. Read that file for the
shape; do not guess it, and do not write any HTML yourself. Lead with the
pass/fail probe count as the first metric, list every failed probe in a table
with its evidence, and copy Holding and Failed from the report verbatim. The
verification pass runs after you exit, so state what you attempted, not what
verified.

{{LEDGER}}
'@

    $researchBlock = if ($isResearchDay) {
        @'
## Research sweep (it is the research day)

Search GitHub and Reddit for things that would make this Agency better --
scheduling and orchestration for Claude Code agents, hook and permission
patterns, self-healing and autonomous-repair systems, and anything that would
close a gap you saw in the health check.

Append findings to state/findings.md. Each entry needs the source, the licence,
what specifically here it would improve, and a verdict that is allowed to be
"do not adopt" -- a register of enthusiastic maybes is worth nothing. Answer the
three questions in your CLAUDE.md for anything you do recommend.

You may READ anything on the allowlisted domains. You may not install, clone, or
run any of it, and no permission you have would let you. Adoption is a proposal
under Holding.
'@
    } else {
        "Research sweep: not today. It runs Sundays."
    }

    $prompt = $prompt.Replace('{{BEFORE}}', $before).
                      Replace('{{REPORT}}', $report).
                      Replace('{{TODAY}}', $today).
                      Replace('{{FACTS}}', [System.IO.Path]::ChangeExtension($report, ".artifact.json")).
                      Replace('{{RESEARCH}}', $researchBlock)
    if ($DryRun) {
        $prompt = $prompt.Replace('{{LEDGER}}', @'
THIS IS A DRY RUN. The write guard will refuse every Tier A path with a message
saying so. That is expected and is not a failure -- when it happens, record the
repair you would have made under Holding, with the intended diff, and continue.
Do not touch runs/ledger.md.
'@)
    } else {
        $prompt = $prompt.Replace('{{LEDGER}}', 'Then append one line to runs/ledger.md.')
    }

    if ($DryRun) { $env:AGENCY_REPAIR_DRY_RUN = "1" }
    # PowerShell 5.1 wraps every stderr line from a native command in an
    # ErrorRecord when stderr is merged with 2>&1, and under
    # $ErrorActionPreference = "Stop" that ErrorRecord is terminating. claude.exe
    # writes ordinary progress and warnings to stderr, so the FIRST such line
    # aborted the run. On 2026-08-04 sam-research and finance-research both died
    # exactly this way on the harmless "no stdin data received in 3s" warning.
    # For this bot the consequence was the worst of the four: the abort would
    # skip the independent verification block below, so a Tier A repair could be
    # applied and never re-checked. stderr is still captured for the log; it just
    # no longer decides whether the run lived.
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
        $env:AGENCY_REPAIR_DRY_RUN = $null
        $ErrorActionPreference = $prevEap
    }
    Add-Content -Path $logFile -Value $output
    Add-Content -Path $logFile -Value "[$stamp] agent finished, exit $exit"
    # Deliberately NOT thrown on here, unlike the sibling runners. If the agent
    # died partway it may still have applied a Tier A repair, and the
    # verification block below -- which re-runs every probe and would catch a
    # regression -- must run precisely because the agent failed. The exit code is
    # folded into the report after verification instead.

    # Step 4: verify independently. The agent claims a probe went green; this
    # re-runs every probe and appends what actually happened. The agent does not
    # write this block and cannot edit the script that does.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $botDir "scripts\health_check.ps1") -Out $after -Quiet
    $post = Get-Content $after -Raw | ConvertFrom-Json

    $fixed = @($health.failures | Where-Object { $post.failures -notcontains $_ })
    $broke = @($post.failures | Where-Object { $health.failures -notcontains $_ })
    $stillBad = @($post.failures | Where-Object { $health.failures -contains $_ })

    $lines = @("", "## Verification — re-run by run_repair.ps1, not by the agent", "")
    $lines += "Health went **$($health.status) -> $($post.status)** ($($post.counts.pass)/$($post.counts.total) probes passing)."
    $lines += ""
    # A non-zero agent exit is not thrown on above, so it would otherwise reach
    # nobody. Surfaced here, next to the probe state it has to be read against:
    # "agent died" plus "no probe changed state" means the run did nothing, while
    # "agent died" plus a green->red probe means something was left half-applied.
    if ($exit -ne 0) {
        $lines += "**The agent exited $exit** — it did not finish cleanly. Read the probe"
        $lines += "state below as the authority on what actually landed, not the prose above."
        $lines += ""
    }
    if ($fixed.Count) { $lines += "**Fixed** (red -> green): $($fixed -join ', ')" }
    if ($stillBad.Count) { $lines += "**Still failing**: $($stillBad -join ', ')" }
    if ($broke.Count) { $lines += "**REGRESSED — green -> red**: $($broke -join ', '). Undo with ``scripts\revert.ps1 -BatchId $today``." }
    if (-not $fixed.Count -and -not $stillBad.Count -and -not $broke.Count) { $lines += "No probe changed state." }
    $lines += ""
    # Not Add-Content -Encoding utf8: on PowerShell 5.1 that writes a BOM when
    # it creates the file, and the control plane serves these reports straight
    # to a markdown renderer, where a leading U+FEFF shows up as a stray glyph
    # above the first heading.
    [System.IO.File]::AppendAllText($report, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

    if ($broke.Count) {
        Add-Content -Path $logFile -Value "[$stamp] REGRESSION: $($broke -join ', ')"
    }
    if ($exit -ne 0) {
        Add-Content -Path $logFile -Value "[$stamp] agent exited $exit; verification ran anyway and is in the report"
    }
    # Render the run into a standalone HTML page, if the agent left a facts file.
    # From the script rather than the agent: guard_commands.py here allowlists
    # exactly two of this bot's own scripts, and the shared renderer is neither.
    # Calling it from this side means that guard does not have to be loosened.
    # Derived from $report, not rebuilt from $today, so a dry run's facts and page
    # follow the report under state\dryrun\ instead of landing in runs\ beside the
    # real ones. Getting this wrong is how a dry run pollutes the live record.
    $agencyRoot = Split-Path -Parent $botDir
    & (Join-Path $agencyRoot ".claude\skills\live-artifact\Render-Artifact.ps1") `
        -Facts ([System.IO.Path]::ChangeExtension($report, ".artifact.json")) `
        -Out   ([System.IO.Path]::ChangeExtension($report, ".html")) `
        -Log   $logFile -DryRun:$DryRun

    Add-Content -Path $logFile -Value "[$stamp] run complete ($mode)"
    # A dead agent counts as a failed run even when no probe regressed, so the
    # scheduled task's LastTaskResult is non-zero and bots:freshness can see it.
    exit $(if ($broke.Count -or $exit -ne 0) { 1 } else { 0 })
} catch {
    $err = $_
    Add-Content -Path $logFile -Value "[$stamp] FAILED: $err"
    if (-not $DryRun) {
        $failure = @"

## agency-repair — $stamp
**Status** — failed
**Did** — the run aborted; see above for anything completed before that.
**Holding** — nothing.
**Failed** — $err
**Carry forward** — If a repair batch exists at repairs\$today, inspect it and
revert with ``scripts\revert.ps1 -BatchId $today`` if the Agency is worse off.
Full trace in runs\scheduler-log.txt.
"@
        # BOM-less, for the same reason as the verification block above.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        if (Test-Path $report) { [System.IO.File]::AppendAllText($report, $failure, $utf8NoBom) }
        else { [System.IO.File]::WriteAllText($report, $failure, $utf8NoBom) }
    }
    exit 1
}
