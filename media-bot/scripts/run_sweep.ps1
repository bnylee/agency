# media-bot notification sweep.
#
#   .\run_sweep.ps1            live: collects, stages junk, writes the report
#   .\run_sweep.ps1 -DryRun    collects for real, stages NOTHING, writes nothing
#
# The deterministic steps are owned by this script, not by the agent. The agent has
# no shell permission at all — it reads the collector's JSON and writes prose, and
# every classification that reaches the trash bin is made by classify.py. Same split
# as finance-research's broker: the model explains, the script decides.
#
# ## Why staging runs BEFORE the agent
#
# So the report can state what actually happened rather than what was proposed. The
# alternative — agent first, stage after — means the prose says "12 messages moved"
# and the script then moves 9 because 3 had already been filed by hand. finance
# -research has the same ordering problem and solves it by having the broker APPEND
# to the report; there is nothing to append to here, so the order is simply fixed.
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$botDir = "C:\Users\you\OneDrive\Desktop\Agency\media-bot"
$agencyRoot = Split-Path -Parent $botDir
$claudeExe = "C:\Users\you\.local\bin\claude.exe"
$logFile = Join-Path $botDir "runs\scheduler-log.txt"
$stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
$today = Get-Date -Format "yyyy-MM-dd"

# python, from PATH. This bot has no venv and needs none — every provider adapter
# is standard library only, which is a deliberate property and not an oversight.
# See the note at the top of scripts/providers.py.
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { throw "python is not on PATH; media-bot's collectors need it" }

if ($DryRun) {
    $work = Join-Path $botDir "state\dryrun"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $report = Join-Path $work "report.md"
} else {
    $work = Join-Path $botDir "state"
    $report = Join-Path $botDir "runs\$today.md"
}
$digest = Join-Path $work "collect-latest.json"

New-Item -ItemType Directory -Force -Path (Join-Path $botDir "runs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $botDir "state") | Out-Null

$mode = if ($DryRun) { "DRY RUN" } else { "live" }
Set-Location $botDir
Add-Content -Path $logFile -Value "[$stamp] starting media-bot sweep ($mode)"

try {
    # Step 1: collect. Read-only against every provider; nothing is marked read.
    #
    # A non-zero exit here means a CONFIGURED provider failed. That is worth
    # reporting but not worth aborting on: three working providers and one broken
    # one should still produce a digest, and the digest names the failure. An
    # unconfigured provider exits 0, because having no credentials yet is a state
    # and not a fault.
    # NOTE: collect.py is called WITHOUT --dry-run even on a dry run, and that is
    # deliberate. `$digest` is already redirected under state\dryrun\, so the write
    # genuinely happens and genuinely exercises the write path — which is the only
    # kind of dry run worth having, and the same reasoning finance-research's script
    # spells out for its ledger. Passing --dry-run here instead produced a dry run
    # that wrote nothing and then handed triage a path with no file at it: triage
    # reported "cannot read digest", and the sweep exited 0 anyway. Found by running
    # it, which is the only way that class of bug is ever found.
    #
    # collect.py's own --dry-run flag still exists for a standalone check that
    # touches nothing at all; see this bot's CLAUDE.md.
    & $py.Source (Join-Path $botDir "scripts\collect.py") --out $digest
    $collectExit = $LASTEXITCODE
    Add-Content -Path $logFile -Value "[$stamp] collect exit $collectExit -> $digest"

    if (-not (Test-Path $digest)) { throw "collect.py wrote no digest at $digest" }

    if ($DryRun) {
        # The dry run stops here having proved the whole read-and-write path works,
        # then shows exactly what staging WOULD move and the rule that condemned
        # each message. It deliberately does not invoke the agent: the expensive
        # half of this run is the agent and the risky half is the staging, and this
        # exercises the risky half for free.
        Add-Content -Path $logFile -Value "[$stamp] dry run: showing what triage would stage"
        & $py.Source (Join-Path $botDir "scripts\triage.py") stage --digest $digest --dry-run
        $triageExit = $LASTEXITCODE
        Add-Content -Path $logFile -Value "[$stamp] dry run complete; nothing was moved and no report was written"
        # Propagated, not swallowed. A dry run that reports success while one of its
        # two steps failed is worse than no dry run at all — it is the thing that
        # tells you a change is safe to schedule.
        if ($collectExit -ne 0 -or $triageExit -ne 0) {
            Add-Content -Path $logFile -Value "[$stamp] dry run had failures (collect $collectExit, triage $triageExit)"
            exit 1
        }
        exit 0
    }

    # Step 2: stage the junk. Reversible: a Gmail LABEL move, recorded in
    # state/trash-bin.json, undone by `triage.py restore --batch <id>`. There is no
    # purge verb anywhere in this bot.
    & $py.Source (Join-Path $botDir "scripts\triage.py") stage --digest $digest --batch $today
    $triageExit = $LASTEXITCODE
    Add-Content -Path $logFile -Value "[$stamp] triage stage exit $triageExit"

    # Step 3: the digest in prose.
    $prompt = @'
Write today's notification digest.

Read these, both already generated this run:
  {{DIGEST}}   every provider's result, classified, plus the calendar and tasks
  {{BIN}}      the trash bin manifest, including what was staged this run

Write {{REPORT}} in the run-report format from the root CLAUDE.md
(Status / Did / Holding / Failed / Carry forward). Lead with what needs Benny
today. Specifically:

1. Open with the `needs_you` count and what makes it up. If it is zero, say so in
   one line and do not pad it.
2. List every important message: who, what, and what it wants. One line each.
3. List everything on the calendar in the next 48 hours, with the time exactly as
   the digest states it — do NOT convert or adjust a timezone, the digest's own
   note explains why some values are approximate.
4. List every Canvas item due inside a week, soonest first.
5. State how many messages were staged to the trash bin, and name the restore
   command. Never describe a staged message as deleted: it is a Gmail label move
   and it is reversible. Nothing in this bot deletes anything.
6. Under Failed, list every provider whose status is `failed`, with its error text.
   Providers whose status is `not_configured` go under Holding with the one-line
   setup step from their note — they are not failures. Providers whose status is
   `unavailable` get ONE line total at the end saying which they are and that
   there is no API for them; do not re-explain it every run.

Then append one line to runs/ledger.md.

Finally write {{FACTS}} — the facts file for the live-artifact skill, whose
instructions are in .claude/skills/live-artifact/SKILL.md. Read that file for the
shape; do not guess it, and do not write any HTML yourself. Lead with `needs_you`
as the first metric. Use a table for important messages, a table for the calendar,
a table for Canvas work, and a `bars` section for the message mix
(important / normal / junk). Copy Holding and Failed from the report verbatim.

Constraints:
- Every number comes from the digest. Do not recount, re-derive or estimate one.
  `summary` in the digest is computed by classify.py precisely so the report and
  the page cannot disagree.
- Do not quote the body of anybody's message. The collector deliberately never
  fetched one; you have subjects and senders, which is enough for a digest.
- If a classification looks wrong, say so under Carry forward with the sender and
  the rule that fired. Do not work around it — the rules live in classify.py and
  changing them is a code change Benny makes, not something a run decides.
'@
    $prompt = $prompt.Replace('{{DIGEST}}', $digest).
                      Replace('{{BIN}}', (Join-Path $botDir "state\trash-bin.json")).
                      Replace('{{REPORT}}', $report).
                      Replace('{{FACTS}}', [System.IO.Path]::ChangeExtension($report, ".artifact.json"))

    # PowerShell 5.1 wraps every stderr line from a native command in an ErrorRecord
    # when stderr is merged with 2>&1, and under $ErrorActionPreference = "Stop"
    # that ErrorRecord is terminating. claude.exe writes ordinary progress and
    # warnings to stderr, so the FIRST such line would abort the run and the catch
    # below would log it as a failure. sam-research and finance-research both died
    # exactly this way on 2026-08-04, on the harmless "no stdin data received in 3s"
    # warning, AFTER their agents had already succeeded. stderr is still captured
    # for the log; it just no longer decides whether the run lived.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # $null on the pipeline closes claude.exe's stdin immediately. It sends zero
        # bytes, so it cannot append anything to the -p prompt. Without it a
        # scheduled run has no stdin at all and claude stalls three seconds before
        # emitting that warning.
        $output = $null | & $claudeExe -p $prompt --permission-mode dontAsk 2>&1
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Add-Content -Path $logFile -Value $output
    Add-Content -Path $logFile -Value "[$stamp] agent finished, exit $exit"

    # Step 4: render the standalone page, if the agent left a facts file. From the
    # script rather than the agent because this bot's agent has no shell permission,
    # and because it costs no model tokens this way.
    & (Join-Path $agencyRoot ".claude\skills\live-artifact\Render-Artifact.ps1") `
        -Facts ([System.IO.Path]::ChangeExtension($report, ".artifact.json")) `
        -Out   ([System.IO.Path]::ChangeExtension($report, ".html")) `
        -Log   $logFile

    if ($exit -ne 0) { throw "claude exited $exit" }
    Add-Content -Path $logFile -Value "[$stamp] run complete ($mode)"
} catch {
    $err = $_
    Add-Content -Path $logFile -Value "[$stamp] FAILED: $err"
    # A scheduled run has no chat, so a failure that only reaches the log is a
    # failure nobody sees. Write the report anyway: the control plane reads runs/,
    # and a red status there is the notification path.
    if (-not $DryRun) {
        $failure = @"

## media-bot — $stamp
**Status** — failed
**Did** — see above; the run aborted at a later step.
**Holding** — nothing.
**Failed** — $err
**Carry forward** — Nothing was deleted; this bot cannot delete. If the sweep died
after staging, ``python scripts\triage.py list`` shows what is in the bin and
``python scripts\triage.py restore --batch <id>`` puts it back. Check
runs/scheduler-log.txt for the full trace.
"@
        # Appended, never Set-Content: the agent may already have written a good
        # report before a later step threw, and overwriting would destroy the only
        # record of what the run found. Written BOM-less — PowerShell 5.1's
        # `-Encoding utf8` prepends a BOM when it creates a file, and the control
        # plane serves these straight to a markdown renderer where a leading U+FEFF
        # shows up as a stray glyph above the first heading.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        if (Test-Path $report) {
            [System.IO.File]::AppendAllText($report, $failure, $utf8NoBom)
        } else {
            [System.IO.File]::WriteAllText($report, $failure, $utf8NoBom)
        }
    }
    exit 1
}
