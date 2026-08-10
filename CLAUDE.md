# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Purpose

`Agency` hosts multiple independent, autonomous Claude Code bots. Each bot lives in its own subfolder with its own CLAUDE.md covering its data sources, permissions, and commands. Inside a bot's subfolder, that CLAUDE.md is authoritative for anything specific to the bot; this file covers only what is common to all of them.

Keep each bot's instructions in its own subfolder. Their permissions differ enough that isolation is the point.

## Bot registry

| Bot | Handles | May touch | Schedule | Autonomous actions |
| --- | ------- | --------- | -------- | ------------------ |
| [sam-research](sam-research/CLAUDE.md) | SAM Prototype research support: data-source monitoring, literature verification, licensing/compliance tracking | Listed OECD/IMF/GLORIA/academic domains (fetch only), read-only `Documents/SAM Prototype/`, write only its own `runs/`/`state/` | Weekly | none |
| [finance-research](finance-research/CLAUDE.md) | Personal equity research: pre-market movement report, SEC filings/fundamentals/insider disclosures, price/technical/screening data, and a simulated $10,000 paper account | `mcp__sec-edgar-mcp__*`, `mcp__maverick-mcp__*`, open WebSearch/WebFetch, write only its own `runs/`/`state/` | Pre-market report Mon–Fri 6:00am ET; otherwise on-demand | **Paper trades only** — settle previously queued orders at printed historical opens, apply stops/targets/splits/dividends, mark to market, and queue new orders, all inside `state/portfolio.json` via `scripts/paper_broker.py`, which enforces the risk limits. No brokerage, no real money, no order routing. |
| [disk-cleanup](disk-cleanup/CLAUDE.md) | Disk space reclamation: quarantines regenerable files, ranks installed-program footprint by last-used, reports duplicates | Local filesystem (read), quarantine root `C:\DiskCleanupQuarantine\`, `github.com` for one-time tool install, write only its own `runs/`/`state/` | Weekly Sat 8:00am | **Tier B only** — move scan candidates to a dated quarantine batch, capped 25 GB / 5,000 files per run, reversible via `restore.ps1`. Never deletes, never uninstalls. |
| [media-bot](media-bot/CLAUDE.md) | Notification digest, calendar, and a reversible mail bin: Gmail, Outlook/M365, Canvas, published `.ics` feeds | Gmail IMAP, `graph.microsoft.com` (read-only scopes), the Canvas instance in `CANVAS_BASE_URL`, the URLs in `ICS_URLS`, write only its own `runs/`/`state/` | Daily 7:00am | **Label moves only** — move junk-classified Gmail messages to `Agency/Trash-Candidates` and record each with the rule that condemned it, capped 200/run, reversible via `triage.py restore`. Never deletes, never sends, never replies, never marks read. **Instagram, TikTok and Snapchat have no personal notification API** — their activity email is classified from mail instead. |
| [interface-design](interface-design/CLAUDE.md) | The Agency's designer: owns the design system for the control plane at `dashboard/` | Its own `design/`/`runs/`/`state/`, `Agency/dashboard/**`, the siblings' CLAUDE.md files (read-only), open WebSearch/WebFetch, `npm`/`node` | On-demand (no schedule, interactive only) | none |
| [agency-repair](agency-repair/CLAUDE.md) | The Agency's repair shop: a request queue a human types into from the control plane, deterministic health checks over every bot and the control plane, code repair, and a weekly GitHub/Reddit sweep for things worth adopting | Read the whole Agency except `.env`/`node_modules`/`.venv`; write its own `runs/`/`state/`/`repairs/` plus `dashboard/` source (Tier A only); WebFetch locked to github/reddit/HN/`docs.claude.com`; shell limited by hook to two of its own scripts | Daily 7:15am; research sweep Sundays | **Tier A only** — apply a fix to control-plane source (`dashboard/src`, `dashboard/server`, `index.html`, `vite.config.ts`) where a named probe failed before and passes after, every original file snapshotted first and reversible via `revert.ps1`. Capped at 12 files / 400 lines per run. Never installs anything, never edits a sibling bot, a `.claude/` directory, a `CLAUDE.md`, or a lockfile. |

Every scheduled bot additionally renders its run into a standalone HTML page via
the shared [`live-artifact`](.claude/skills/live-artifact/SKILL.md) skill. The bot
emits a small JSON facts file and a script does all the markup, so the page costs
roughly a third of the tokens the same page written by hand would, and improving
the template costs nothing per run. The page opens by double-click with no server,
no token and no network — which is the gap it fills, since reading anything in
`dashboard/` otherwise requires `npm run dev` and a pasted token.

The **control plane** at [`dashboard/`](dashboard/README.md) is an artifact, not a bot. It is a localhost-only web interface over the bots' existing `runs/` and `state/` output. It can trigger runs, restore quarantine batches, and revert repair batches; it deliberately has **no purge endpoint**, so `purge.ps1`'s interactive-console lock remains the only path to permanent deletion. Restore and revert are exposed because both put files *back* from copies taken beforehand and neither destroys anything — that is the line, not "how scary does it sound".

The **public mirror** at [`publish/`](publish/make_public.py) is the other artifact.
`make_public.py` builds a shareable copy of the Agency from an **allowlist** — a
denylist fails open, and every new bot or state file would be published by default
until somebody remembered to exclude it. It scrubs the Windows username and email
addresses out of what it copies, then greps the finished mirror for them again and
exits non-zero on a hit; the copying is the easy part, the verify is the point.
`runs/`, `state/`, `repairs/` and `vault/` are never copied, because the bots'
output is the personal half. Vendored third-party skills are never copied either —
`skills-lock.json` records their provenance instead.

The mirror's front door is `dashboard`'s **demo build** (`npm run build:demo`),
which sets `VITE_DEMO=1`, routes `src/api.ts` through `src/demo/fixtures.ts`
instead of `fetch`, and skips the token gate — there is no server behind it and no
token to check. The production build tree-shakes the fixtures out entirely.
Screenshots come from `publish/shoot.ps1`, which shoots the *demo*, never the real
control plane, so a capture cannot leak a real sender, path or balance. Note that
`vite preview` cannot serve that build: it answers `Sec-Fetch-Dest: script` with a
404 under a non-root base, and the page then renders with no JavaScript at all.
Both `shoot.ps1` and the Pages workflow use a plain static server, which is what
GitHub Pages is.

**Every change to the Agency ships to the mirror in the same session.** The public
repo is `github.com/bnylee/agency` and the demo is `bnylee.github.io/agency`; both
are on Benny's resume, so a mirror that lags is a link that misrepresents the work.
Finish the change here, then:

```
python publish/make_public.py --out ../Agency-public --user bnylee --repo agency --keep-git
cd ../Agency-public && git add -A && git commit && git push
```

`--keep-git` preserves the mirror's history across rebuilds; without it every push
is a force-push of an unrelated tree. The push triggers the Pages workflow, so the
demo redeploys on its own. If the change touched `dashboard/`, run `publish/shoot.ps1`
first — the README screenshots are of the demo build and go stale silently otherwise.
The mirror script refuses to finish if a credential, username or email survives into
the output, so a clean run is also the check that nothing personal leaked.

Add a row when you create a bot. "May touch" lists accounts, APIs, and MCP servers. "Autonomous actions" lists what it executes without approval, or `none`.

## Two modes

Identify which mode you are in before acting.

**Interactive** — a human is in the session, building or changing a bot. Working Discipline and Verification below apply; approval gates are live.

**Unattended** — a bot runs on its schedule with nobody watching. The bot's own permission list is the sole authority. Approval gates cannot function, so anything not pre-authorized gets surfaced instead of performed.

Apply each mode's rules only to that mode. A scheduled run has no one to ask; an interactive session has no excuse for skipping it.

---

## Architecture

Run each bot as Claude Code itself, invoked on a schedule (cron/routine), reaching external data through MCP servers or direct tool calls.

Build a custom service or daemon only after identifying a specific task that Claude Code's tools and available MCP servers demonstrably cannot do, stating that explicitly, and getting approval. A bespoke codebase must earn its maintenance cost.

## Permissions and enforcement

A CLAUDE.md is context, not configuration — Claude reads it and generally follows it, but it does not constrain execution. Every rule that matters must also exist as a mechanical constraint.

For each bot:

- Its CLAUDE.md lists the accounts, APIs, and MCP servers it may touch. Treat the list as exhaustive.
- Mirror that allowlist into the bot's settings, with explicit `deny` entries for anything sensitive. Confirm the current settings schema in the Claude Code docs rather than writing it from memory. Three specifics, each verified by a failed unattended run on 2026-08-03 rather than read off a doc page:
  - **Allow rules go in `.claude/settings.local.json`, not `.claude/settings.json`.** A project `settings.json`'s allow rules are ignored until the workspace is trusted. Under `--permission-mode dontAsk` that denies every call, so a scheduled run fails having written nothing — and it fails the same way every time, quietly.
  - **Deny rules and hooks belong in `.claude/settings.json`.** Both apply regardless of trust, and deny always beats allow.
  - **File rules use `Edit(path)`, never `Write(path)`.** `Write(...)` rules are not evaluated by file permission checks at all, so a `Write(...)` deny protecting something sensitive does nothing. `Edit(...)` covers every file-editing tool.
- Irreversible or externally visible actions — sending a message, replying, moving money, deleting data — execute autonomously only where the bot's CLAUDE.md names them as pre-authorized. Everything else is surfaced for approval as a notification or a drafted-but-unsent output.
- Gate any action whose accidental execution would be costly behind a `PreToolUse` hook, so the block holds regardless of what the model decides in the moment.

Markdown is intent. `settings.json` and hooks are enforcement. Ship both.

## Run report

Every scheduled run writes a report to `runs/<bot>/<ISO-date>.md`. This is the only artifact a human sees, so the shape is fixed:

```
## <bot> — <ISO timestamp>
**Status** — ok | partial | failed
**Did** — actions actually taken, with file paths.
**Holding** — actions drafted but not executed, and the approval each needs.
**Failed** — what broke, at which step, with the error text.
**Carry forward** — anything the next run needs to know.
```

Write every deliverable to a file. A scheduled run has no chat, so output not on disk is lost.

Keep a running `runs/ledger.md` with one line per run: bot, date, status, approximate token spend. Cron accumulates cost quietly, and the ledger is how you notice.

## Failure handling

On API error, ambiguous data, or missing auth: halt and surface through the bot's notification path. Unattended runs mean a silent retry or a plausible guess can stay wrong for days. A run that reports failure succeeded; a run that quietly produced garbage did not.

## Dry run

Every bot must run in a dry-run mode that exercises full logic and renders every external action it would take, performing none of them. Build it before the first scheduled run, and validate every behavior change through it. A change that has only been reasoned about is untested.

---

## Working discipline (interactive)

For any new bot or non-trivial change:

1. **Analyze.** Confirm a file exists with `ls` or `grep` before reading it. For unfamiliar libraries, MCP servers, or APIs, read the actual documentation — signatures come from a source you just read, not recall.
2. **Surface concerns.** State technical, security, or design problems noticed while analyzing, including ones outside the request.
3. **Propose a plan.** Concise, prose not code, brief rationale. Ask about anything unclear first.
4. **Wait for explicit approval.** Implement once the human says to proceed. Typos, one-line tweaks, and requests prefixed with "just" or "quick" may skip the plan.

Approval is required before implementing changes.

A UserPromptSubmit hook (`~/.claude/hooks/working-discipline-reminder.sh`) re-injects this rule on prompts containing build/implement/fix keywords.

## Verification

Validate findings before presenting them; an unsubstantiated claim is a failed response.

Label what each claim rests on: a file read this session, a command whose output you saw, documentation you fetched, or recall. Recall is labeled as recall. Say "I'm not sure" when that is the case, and mark speculation.

Re-read changed files at the end of a unit of work and confirm the change does what you said. This pass is expected work, not duplicated work — do it even when confident.

## Standards

Implement logic fully or ask for clarification. A stub or `TODO` standing in for behavior is an incomplete change and must be called out if left.

Prefer one correct slower pass over several fast iterations.

Read lockfiles and generated files only when the task is about dependencies or generated output.

Lead with the answer; skip "great question" and "you're right." State disagreement first, with the reason, before anything else. Hold position under pushback — restate the reasoning, and move on a new fact rather than on tone.

## Model and subagent use

Plan in plan mode with a reasoning-heavy model, then hand the plan to Sonnet for mechanical implementation. Use `/advisor` to bring in a stronger model mid-task instead of switching and losing context.

Use subagents to explore large or unfamiliar areas so the main context stays clean, and relay their conclusions rather than their file contents. Otherwise leave dispatch to judgment: parallelize genuinely independent work, and let sequencing stand where a later step depends on an earlier one's findings. Subagents cost real money — spawn them to save context or time, not by default.

Fix shared schemas, signatures, and file ownership before dispatching split work.

Review a completed feature with a fresh Claude Code instance. A clean context catches what an invested one rationalizes.

---

## Adding a bot

1. Create its subfolder.
2. Write its CLAUDE.md: purpose, exact accounts/APIs/MCP servers, pre-authorized actions (or `none`), schedule, dry-run command.
3. Add matching `permissions`: allow rules in `.claude/settings.local.json`, deny rules and hooks in `.claude/settings.json`, file rules written as `Edit(...)`. See Permissions and enforcement above for why each of those three placements matters.
4. Confirm the dry run works end to end. For a scheduled bot, actually execute the scheduled command once by hand — the trust and `Edit(...)`-vs-`Write(...)` failures above are both invisible until a real unattended run happens.
5. Add its row to the Bot registry above.