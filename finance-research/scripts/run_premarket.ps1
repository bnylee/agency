# finance-research pre-market run.
#
#   .\run_premarket.ps1            live: settles, researches, queues, reports
#   .\run_premarket.ps1 -DryRun    same logic against a scratch copy of the
#                                  account; the live ledger is never opened for
#                                  writing and no ledger line is added
#
# The deterministic steps are owned by this script, not by the agent. The agent
# has no shell permission at all -- it reads JSON and writes JSON and prose, and
# every number that reaches the ledger is computed by paper_broker.py. That
# split is the reason the account is auditable: the model argues, the script
# keeps score.
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$botDir = "C:\Users\you\OneDrive\Desktop\Agency\finance-research"
$venvPy = Join-Path $botDir ".venv\Scripts\python.exe"
$claudeExe = "C:\Users\you\.local\bin\claude.exe"
$broker = Join-Path $botDir "scripts\paper_broker.py"
$logFile = Join-Path $botDir "runs\scheduler-log.txt"
$stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
$today = Get-Date -Format "yyyy-MM-dd"

# A dry run redirects every path under state\dryrun\ and works on a COPY of the
# account. It is not "the same run with the writes disabled" -- it genuinely
# settles, queues and writes, just never to the live ledger. That is the only
# version of a dry run that exercises the write path, which is where the bugs
# are.
if ($DryRun) {
    $work = Join-Path $botDir "state\dryrun"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $portfolio = Join-Path $work "portfolio.json"
    $trades = Join-Path $work "trades.jsonl"
    $report = Join-Path $work "report.md"
    $live = Join-Path $botDir "state\portfolio.json"
    if (Test-Path $live) { Copy-Item $live $portfolio -Force }
} else {
    $work = Join-Path $botDir "state"
    $portfolio = Join-Path $work "portfolio.json"
    $trades = Join-Path $work "trades.jsonl"
    $report = Join-Path $botDir "runs\$today.md"
}
$scanOut = Join-Path $work "premarket-latest.json"
$settleOut = Join-Path $work "settlement-latest.json"
$ordersFile = Join-Path $work "orders-proposed.json"
$queueOut = Join-Path $work "queue-latest.json"

$mode = if ($DryRun) { "DRY RUN" } else { "live" }
Set-Location $botDir
Add-Content -Path $logFile -Value "[$stamp] starting pre-market run ($mode)"

# A stale proposal from yesterday must never be queued as if it were today's.
if (Test-Path $ordersFile) { Remove-Item $ordersFile -Force }

try {
    # Step 1: open the account if it does not exist. Idempotent -- init refuses
    # to overwrite a funded ledger.
    & $venvPy $broker init --portfolio $portfolio | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "paper_broker init exited $LASTEXITCODE" }

    # Step 2: settle. Fills anything queued for a session whose open has now
    # printed, applies stops, targets, splits and dividends, and marks the book
    # to the last completed close. This happens BEFORE the research so the
    # agent reasons about a current account rather than a stale one.
    & $venvPy $broker settle --portfolio $portfolio --trades $trades --out $settleOut | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "paper_broker settle exited $LASTEXITCODE" }
    Add-Content -Path $logFile -Value "[$stamp] settled -> $settleOut"

    # Step 3: gather pre-market data. Fail loudly rather than handing Claude
    # stale JSON. The script writes the file itself; piping through Out-File
    # would add a BOM that breaks json.load.
    & $venvPy (Join-Path $botDir "scripts\premarket_scan.py") --out $scanOut
    if ($LASTEXITCODE -ne 0) { throw "premarket_scan.py exited $LASTEXITCODE" }
    $scanStatus = (Get-Content $scanOut -Raw | ConvertFrom-Json).status
    Add-Content -Path $logFile -Value "[$stamp] scan $scanStatus -> $scanOut"

    # A scan that started at or after 09:30 ET may not queue orders. The bars are
    # clean, but every live tool call in a post-open run can see this session's
    # prices -- and an order queued here fills at an open the run has already
    # seen, which is precisely the look-ahead the queue-then-settle model exists
    # to prevent. The 2026-08-04 13:12 dry run demonstrated the leak: NVDA's real
    # Aug 4 open came back inside an MCP error string.
    #
    # Enforced HERE rather than in the prompt, because the bot's own CLAUDE.md is
    # explicit that a limit living only in a prompt is a suggestion, and this bot's
    # job is to argue itself into trades. The research still runs and still writes
    # a report -- only the queue step is refused.
    $mayQueue = $scanStatus -ne "stale_premarket"
    if (-not $mayQueue) {
        Add-Content -Path $logFile -Value "[$stamp] POST-OPEN SCAN: research will run, queueing is refused"
    }

    # Step 4: the research and the report.
    $prompt = @'
Write today's pre-market report and propose the day's paper orders.

Read these first, all already generated this run:
  {{SCAN}}       pre-market movement
  {{SETTLE}}     what settled overnight and where the account now stands
  {{PORTFOLIO}}  the full paper account
  {{PLAYBOOK}}   lessons this account has already paid for

If the scan's status is "market_closed", write a one-line report saying so,
propose no orders, and stop.

Otherwise:

1. Write the report to {{REPORT}}, following the run-report format in the root
   CLAUDE.md. Cover where the index ETFs are pointing into the open, which
   names are moving most, and for any move over 1% the likely reason with a
   citation. If you cannot find a reason, say so rather than speculating.

2. Review every open position against its thesis. Say plainly which theses are
   still intact and which are not. A position whose thesis has broken should be
   proposed for exit even at a loss; the stop is a backstop, not the decision.

3. Follow the research protocol in this bot's CLAUDE.md for anything you intend
   to propose. Conviction below 3 is not a trade.

4. Write proposed orders to {{ORDERS}} as JSON:
     {"orders": [{"symbol","side","shares" or "notional","limit"?,"stop",
                  "target","conviction",1-5,"thesis","catalyst","sources":[]}]}
   Proposing nothing is a valid and frequently correct outcome. Write no file
   at all on a day with no conviction rather than an empty gesture.

5. If a trade closed in this settlement, add what it taught to {{PLAYBOOK}},
   following the rules at the top of that file. Only closed trades earn a line.

6. Write {{FACTS}} — the facts file for the live-artifact skill, whose
   instructions are in .claude/skills/live-artifact/SKILL.md. Read that file for
   the shape; do not guess it, and do not write any HTML yourself. Lead with
   account equity as the first metric, then the day's movers as a table and the
   open positions against their theses as another. Copy Holding and Failed from
   the report verbatim. The script renders the page after you exit, so the
   queue outcome will not be in your facts — say what you proposed, not what
   filled.

Constraints that are not negotiable:
- This is a SIMULATED account. No brokerage exists. Never describe an order as
  executed; the broker decides what fills, at the next session's open, and it
  runs after you.
- Public sources only. Never seek or use material non-public information.
- Research, not advice. Present the reasoning; the decision is Benny's.
- Pre-market volume is unavailable and pre-market moves on thin liquidity often
  do not hold through the open. Carry the scan's data_caveats into the report.

{{LEDGER}}
'@
    $prompt = $prompt.Replace('{{SCAN}}', $scanOut).
                      Replace('{{SETTLE}}', $settleOut).
                      Replace('{{PORTFOLIO}}', $portfolio).
                      Replace('{{PLAYBOOK}}', (Join-Path $botDir "state\playbook.md")).
                      Replace('{{REPORT}}', $report).
                      Replace('{{ORDERS}}', $ordersFile).
                      Replace('{{FACTS}}', [System.IO.Path]::ChangeExtension($report, ".artifact.json"))
    if ($DryRun) {
        $prompt = $prompt.Replace('{{LEDGER}}', 'This is a DRY RUN. Do not touch runs/ledger.md.')
    } else {
        $prompt = $prompt.Replace('{{LEDGER}}', 'Then append one line to runs/ledger.md.')
    }

    # --settings approves this bot's two project-scoped .mcp.json servers. An
    # unapproved .mcp.json server does not load, and under `-p dontAsk` it does
    # not say so -- which is exactly how both servers were missing from the
    # 2026-08-03 dry run while every other step reported success. Of the three
    # sources whose approvals survive an untrusted folder (user settings,
    # managed settings, --settings), this is the one that does not leak these
    # servers into every other project on the machine.
    $mcpSettings = Join-Path $botDir ".claude\unattended-settings.json"

    # PowerShell 5.1 wraps every stderr line from a native command in an
    # ErrorRecord when stderr is merged with 2>&1, and under
    # $ErrorActionPreference = "Stop" that ErrorRecord is terminating. claude.exe
    # writes ordinary progress and warnings to stderr, so the FIRST such line
    # aborted the run and the catch below logged it as a failure. That is what
    # killed the 2026-08-04 10:57 run: the settle and scan steps had both already
    # succeeded and been logged, then the harmless "no stdin data received in 3s"
    # warning threw, so the queue step never ran. stderr is still captured for
    # the log; it just no longer decides whether the run lived.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # $null on the pipeline closes claude.exe's stdin immediately. It sends
        # zero bytes -- verified, so it cannot append anything to the -p prompt.
        # Without it a scheduled run has no stdin at all and claude stalls three
        # seconds before emitting the warning above.
        $output = $null | & $claudeExe -p $prompt --permission-mode dontAsk --settings $mcpSettings 2>&1
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Add-Content -Path $logFile -Value $output
    Add-Content -Path $logFile -Value "[$stamp] agent finished, exit $exit"
    # With stderr no longer terminating, the exit code is the only real failure
    # signal left. Checked here rather than after the queue step so a dead agent
    # does not silently reach the broker with no orders file.
    if ($exit -ne 0) { throw "claude exited $exit" }

    # Step 5: rule on the proposals. The agent wrote its report before knowing
    # which orders survive the risk limits, so the broker appends what actually
    # happened. If the prose and this block ever disagree, this block is the one
    # that matches the ledger.
    if ($mayQueue) {
        & $venvPy $broker queue --orders $ordersFile --portfolio $portfolio --settlement $settleOut --append-report $report --out $queueOut | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "paper_broker queue exited $LASTEXITCODE" }
        Add-Content -Path $logFile -Value "[$stamp] queue ok -> $queueOut"
    } else {
        # Appended to the report so the refusal is visible where a human reads,
        # not only in the scheduler log. Same no-BOM write the rest of the file
        # uses -- the control plane renders these straight to markdown.
        $blocked = @"

## Queueing refused — post-open scan

The scan started at or after 09:30 ET, so its status is ``stale_premarket``.
Whatever this report proposes, **no order was queued and the account did not
move**. A run that can see this session's prices cannot also decide what to buy
at this session's open; that is look-ahead bias, and the queue-then-settle timing
model exists specifically to prevent it. Refused by ``run_premarket.ps1``, not by
the agent.

Treat everything above as research. The scheduled run is 06:00 ET.
"@
        [System.IO.File]::AppendAllText($report, $blocked, (New-Object System.Text.UTF8Encoding($false)))
        Add-Content -Path $logFile -Value "[$stamp] queue REFUSED (post-open scan); account unchanged"
    }
    # Step 6: render the run into a standalone HTML page, if the agent left a
    # facts file. AFTER the queue step, so the page can carry what the broker
    # actually accepted rather than what the agent proposed — the report has the
    # same ordering problem and solves it by appending, which a single-pass
    # renderer cannot do. From the script because this bot's agent has no shell
    # permission at all, and because it costs no model tokens this way.
    # The facts file sits next to whichever report this run wrote, so a dry run's
    # facts land under state\dryrun\ with everything else it produced and cannot
    # be mistaken for a live day's.
    $agencyRoot = Split-Path -Parent $botDir
    & (Join-Path $agencyRoot ".claude\skills\live-artifact\Render-Artifact.ps1") `
        -Facts ([System.IO.Path]::ChangeExtension($report, ".artifact.json")) `
        -Out   ([System.IO.Path]::ChangeExtension($report, ".html")) `
        -Log   $logFile -DryRun:$DryRun

    Add-Content -Path $logFile -Value "[$stamp] run complete ($mode)"
} catch {
    $err = $_
    Add-Content -Path $logFile -Value "[$stamp] FAILED: $err"
    # A scheduled run has no chat, so a failure that only reaches the log is a
    # failure nobody sees. Write the report anyway: the control plane reads
    # runs/, and a red status there is the notification path.
    if (-not $DryRun) {
        $failure = @"

## finance-research — $stamp
**Status** — failed
**Did** — see above; the run aborted at a later step.
**Holding** — nothing.
**Failed** — $err
**Carry forward** — The paper account may not have advanced today. The next run
settles from ``last_settled_session`` in state/portfolio.json, so a missed day
is replayed rather than skipped. Check runs/scheduler-log.txt for the full trace.
"@
        # Appended, never Set-Content: the agent may already have written a good
        # report before a later step threw, and overwriting it would destroy the
        # only record of what the run actually found.
        # Written BOM-less. PowerShell 5.1's `-Encoding utf8` prepends a BOM
        # when it creates a file, and the control plane serves these reports
        # straight to a markdown renderer, where a leading U+FEFF appears as a
        # stray glyph above the first heading.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        if (Test-Path $report) {
            [System.IO.File]::AppendAllText($report, $failure, $utf8NoBom)
        } else {
            [System.IO.File]::WriteAllText($report, $failure, $utf8NoBom)
        }
    }
    exit 1
}
