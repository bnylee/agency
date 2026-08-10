# CLAUDE.md — finance-research bot

## Purpose

Personal equity-research assistant for Agency operator. Builds a faster, more thorough research process than doing it by hand, using public data only:

- **SEC filings and fundamentals** (`mcp__sec-edgar-mcp__*`) — 10-K/10-Q/8-K retrieval, XBRL financial statements, insider trading disclosures (Form 3/4/5).
- **Price, technical, and screening data** (`mcp__maverick-mcp__*`) — quotes, historical prices, technical indicators (RSI, MACD, support/resistance), and stock screening, backed by `yfinance`.

## Explicit boundaries

These aren't defaults left implicit — given the bot's job is finding "an edge," they're written down on purpose:

- **Public sources only.** Never seek or use material non-public information. SEC insider-trading disclosures (Form 3/4/5) are public precisely so investors can study them — analyzing them is standard, legal research, categorically different from trading on undisclosed internal information. If a source or method would only work with non-public information, don't use it and say so.
- **No real trade execution.** This bot has no brokerage or order-placement access configured, and `scripts/paper_broker.py` contains no order-routing code path — not even a disabled one — so there is nothing to accidentally enable. Real execution gets added only by an explicit update to "May touch" and "Pre-authorized actions" below, decided by Benny, not inferred from a request. **The paper account below is not an exception to this; it is a simulation that never leaves this folder.**
- **Research, not advice.** Present findings and analysis; never frame output as a directive to buy or sell. This is not licensed financial advice, and the decision is always Benny's — this mirrors maverick-mcp's own stated constraint ("personal-use educational financial analysis server, not financial advice"). A simulated fill is a record of what the model decided, not a recommendation that Benny do the same.

## May touch

- `mcp__sec-edgar-mcp__*`, `mcp__maverick-mcp__*` (configured in `.mcp.json`, running from a project-local `.venv`)
- WebSearch / WebFetch — left open rather than domain-allowlisted, since company research spans arbitrary tickers that can't be predicted in advance (unlike sam-research's fixed source list)
- Read/Write: its own subfolder (`Agency/finance-research/**`) — writes restricted to `runs/` and `state/`

Enforcement is split across two files for reasons that are easy to get wrong:

- `.claude/settings.local.json` holds the **allow** rules. A project `settings.json`'s allow rules are ignored until the workspace is trusted, which silently breaks unattended `claude -p --permission-mode dontAsk` runs (every tool call denied, no report written). Local settings need no trust.
- `.claude/settings.json` holds **deny** rules and the `PreToolUse` hook, both of which apply regardless of trust.
- File rules use `Edit(...)`, never `Write(...)`. `Write(...)` rules are not evaluated by file permission checks; `Edit(...)` covers every file-editing tool including Write.
- `.claude/hooks/guard_writes.py` is the backstop that holds even if the rules above are misconfigured.
- `.claude/unattended-settings.json` is passed with `--settings` by `run_premarket.ps1`, and its only job is to approve the two `.mcp.json` servers. **A project-scoped `.mcp.json` server does not load until something approves it, and under `-p --permission-mode dontAsk` it does not say so** — that is how both servers were silently absent from every run before 2026-08-03 while the reports still claimed success. Approval from `settings.local.json` applies only after a trust dialog is accepted for the folder or a parent, and Claude Code decides whether that file is tracked by shelling out to git, which cannot help here because the Agency is not a git repository. Of the three sources whose approvals survive an untrusted folder — user settings, managed settings, `--settings` — this is the one that does not load these servers into every other project on the machine.
- Related: `.mcp.json` uses **absolute paths, not `${CLAUDE_PROJECT_DIR}`**. That variable is set in the spawned server's environment, not Claude Code's, so a bare reference in a `command` field does not expand.
- **Verify MCP by invoking one tool from each server, never by reading `.mcp.json`.** Both files looked correct throughout the period they were doing nothing.

Nothing else. No brokerage, no email, no messaging, no git, no access to any other bot's folder.

## The paper account

A simulated $10,000 account, opened 2026-08-03, living in `state/portfolio.json`
with an append-only fill log in `state/trades.jsonl`. It exists so the research
is scored instead of merely written: a thesis that is never priced is never
wrong, and a bot that is never wrong never improves.

**The timing model is the load-bearing part.** The run happens at 06:00 ET,
three and a half hours before the open, so an order decided then has no price to
fill against. Filling it at the pre-market print would contradict this bot's own
documented finding two sections down. So orders are **queued** for the next
regular-session open and **settled on a later run**, once that session's real
open has printed:

```
Mon 06:00   research -> queue orders for Mon's open
Tue 06:00   settle them at Mon's ACTUAL 09:30 open, then mark to Mon's close
```

Nothing is ever filled at a price that had not printed when the decision was
made. The equity curve therefore carries no look-ahead bias, which is the single
thing that separates this from a backtest that flatters itself.

**A run that starts after the open may not queue.** That invariant holds only
while the deciding run cannot see the session it will fill into, and a run
started at or after 09:30 ET can: the pre-market bars stay clean, because the
window filter cuts them at 09:29, but every *live* tool call in that run returns
today's prices. The 2026-08-04 13:12 run proved it — NVDA's actual Aug 4 open of
211.49 came back inside an MCP error string, and an NVDA order queued that run
would have filled at exactly that open. Nothing reached the ledger only because
no order was proposed, which is luck, not a guarantee. So `premarket_scan.py`
labels a post-open scan `stale_premarket` instead of `ok`, and
`run_premarket.ps1` refuses the queue step and appends the refusal to the report.
The research still runs; only the trade is blocked. Enforced in the script rather
than the prompt, for the reason the risk limits are: a limit that exists only in
a prompt is a suggestion, and this bot's job is to argue itself into trades.

Everything else follows from being honest about costs:

- Fills take **5 bps of slippage against the account, both directions**.
- A **gap through a stop fills at the open, not at the stop.** Assuming
  otherwise is the most common way a paper account invents money it never had.
- If a stop and a target are both touched in one session, **the stop is assumed
  to have come first.** There is no intraday sequence here to say otherwise, and
  the alternative assumption flatters every result the account will ever produce.
- **Splits and dividends are applied explicitly**, which is why prices are
  fetched with `auto_adjust=False` — adjusted prices are back-corrected and are
  not what anything traded at.
- The benchmark is **SPY buy-and-hold of the same $10,000**, recorded on every
  mark. Beating zero is not the bar.

### Risk limits — enforced in code, not in prose

`paper_broker.py` rejects an order that breaks any of these and states the
reason in the report. They live in code because a limit that exists only in a
prompt is a suggestion, and this bot's job is to argue itself into trades:

| Limit | Value |
| --- | --- |
| Max position, per symbol, at entry | 20% of equity |
| Max open positions | 8 |
| Minimum cash | 5% of equity |
| New orders per session | 5 |
| Minimum thesis length | 60 characters |
| Shorting, leverage, options | none — all rejected |
| Stop above / target below the market | rejected (it would fill on entry) |

### Research protocol

Conviction below 3 is not a trade. To reach 3 or above, a name needs a written
answer to all five, in the report, with citations:

1. **Catalyst** — what specifically changes, and when. "It is cheap" is not a
   catalyst; it is a condition that can persist for years.
2. **Fundamentals** — from SEC XBRL via `mcp__sec-edgar-mcp__*`, not from a
   summary. Revenue and margin direction over the last four quarters, and the
   balance-sheet constraint that would break the thesis.
3. **Positioning** — what the price already reflects. A good story that
   everybody holds is not an edge, and saying so is most of the work.
4. **Technical level** — from `mcp__maverick-mcp__*`. Where the stop goes and
   why that level, not a round number.
5. **Falsifier** — the specific observation that would prove the thesis wrong.
   An order with no falsifier gets rejected at review, not at the stop.

Then size by conviction, not by enthusiasm: 3 → up to 8% of equity, 4 → up to
14%, 5 → up to the 20% cap. Exits get the same scrutiny as entries; a position
whose thesis has broken is proposed for exit at once, because the stop is a
backstop and not the decision.

`state/playbook.md` is where a *closed* trade's lesson goes, and the only place
a run may change how the next run thinks. Its own rules are at the top of it.
Read it before proposing anything.

## Pre-authorized actions

**Simulated paper trades against `state/portfolio.json` only**, and only through
`scripts/paper_broker.py`, which enforces the limits above. Concretely, the
scheduled run may without asking: settle previously queued orders at printed
historical prices, apply stops, targets, splits and dividends, mark the book to
the last completed close, and queue new orders for the next open.

Nothing else. No real money, no brokerage, no order routing, no messages sent,
no writes outside `runs/` and `state/`. The agent itself has **no shell
permission at all** — it reads JSON and writes JSON and prose, and every number
that reaches the ledger is computed by the broker script, invoked by
`run_premarket.ps1`. That split is what makes the account auditable: the model
argues, the script keeps score.

## Schedule

**Pre-market report — Mon–Fri 6:00am local Eastern**, via the Windows scheduled task `finance-research-premarket` running `scripts/run_premarket.ps1`. Weekends are excluded because the market is closed; the scan also self-checks the NYSE calendar and exits with `status: market_closed` on holidays, so a holiday produces a one-line report rather than a fabricated one.

Everything else is on-demand.

Watchlist lives in `state/watchlist.json` (index ETFs + megacap tech). Edit that file to change coverage — it is not hardcoded in the script.

## Approved exceptions: local scripts

The root CLAUDE.md forbids custom code until an MCP gap is demonstrated. Two
gaps were demonstrated and two exceptions approved on 2026-08-03.

### `scripts/paper_broker.py` — the account ledger

**No MCP server here keeps a position ledger, and the agent must not keep one
itself.** An account has to be reproducible and auditable, and a language model
recomputing a cost basis every morning from yesterday's prose is neither. The
gap is not "a tool cannot fetch this data" but "this arithmetic must not be done
by the thing whose judgement is being scored."

It is read-only against the network (yfinance prices), writes only under
`state/`, and has no order-routing code path.

### `scripts/premarket_scan.py` — pre-market data

**maverick-mcp cannot return pre-market data.** Three independent confirmations: no `prepost` string anywhere in the installed package; its `history()` call omits `prepost=True`; and its `Quote` output model carries only `symbol/price/change/change_percent/volume/timestamp`, so extended-hours fields are filtered out at the type level even though Yahoo returns them.

`scripts/premarket_scan.py` fills exactly that gap and nothing more — read-only, no new dependencies, prints/writes JSON only. Four data limitations, all surfaced in the JSON's `data_caveats` and required in the report. The first two were found while building it; the last two were found by the 2026-08-04 run and fixed the same day:

- **Pre-market volume is unavailable.** Yahoo reports 0 on every extended-hours 1m bar (verified: 313 pre-market bars, 0 non-zero, against 390/390 for regular hours). The script emits `null`, never `0`, because a `0` would read as "nobody traded." `premarket_minutes_covered` (bars printed out of 330 possible minutes) is the activity proxy instead.
- **Pre-market moves run on thin liquidity** and frequently do not hold through the open. Report them as sentiment, not prediction.
- **`previous_close` may never come from `info["regularMarketPreviousClose"]`.** Yahoo does not roll that field over until at or after the regular open, so at 06:00 ET it returns the session *before* last. On 2026-08-04 it gave the Jul 31 close for all 11 symbols, which made every `change_percent_vs_prev_close` wrong by a full session — and wrong in the direction that manufactures fake gaps, which is precisely the input most likely to argue this bot into a trade. It was caught only because a second field happened to disagree in sign. The scan now derives the value from daily bars, checks the bar's session date against the NYSE calendar's last completed session, and **refuses to emit rather than emit stale**: a symbol that fails the check gets `error` and no change fields, the run exits non-zero, and `run_premarket.ps1` writes a failed report. Yahoo's value is still reported as `yahoo_info_previous_close` for comparison.
- **`premarket_high`/`premarket_low` need the previous-close anchor stripped.** Scattered extended-hours bars carry an extreme pinned exactly on the previous close while the rest of the bar trades away from it — SPY on 2026-08-04 at 08:47 read `O=760.35 H=760.36 C=760.25 L=757.67` against an Aug 3 close of 757.67. It is not confined to the 04:00 bar (SPY had three, TSLA one at 07:00), and it inflates the low of a stock gapping up and depresses the high of one gapping down. The scan drops those extremes and reports how many per symbol in `anchored_bars_ignored`. `premarket_last` is unaffected.

## Dry run

```powershell
.\scripts\run_premarket.ps1 -DryRun
```

The paper account made this necessary: before it existed the bot took no
state-mutating action and a dry run was indistinguishable from a live one, which
that section of this file said would have to change the moment it gained one.

It is **not "the live run with the writes disabled."** It copies
`state/portfolio.json` to `state/dryrun/portfolio.json` and then genuinely
settles, researches, queues and writes — every path redirected under
`state/dryrun/`, the live ledger never opened for writing, no ledger line added.
That is the only version that exercises the write path, which is where the bugs
were: the two found while building this were both settlement-write bugs and both
would have survived a no-write dry run.

It costs a full agent invocation, which is correct — a change validated without
running the agent has not been validated. Validate every behaviour change
through it before the next scheduled run.

## Run report

Follow the root CLAUDE.md's run-report format, written to `runs/<ISO-date>.md`. Keep `runs/ledger.md` updated per run.

## Local setup

MCP servers run from a project-local virtualenv (`.venv/`), not a global install:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install sec-edgar-mcp
.venv/Scripts/python -m pip install "./path-to-cloned-maverick-mcp"   # install from a locally cloned, inspected copy — the PyPI package named "maverick-mcp" is an unrelated project, not this one
```

`sec-edgar-mcp` requires `SEC_EDGAR_USER_AGENT` (set in `.mcp.json`) — SEC's fair-use policy requires an identifying contact on every request.
