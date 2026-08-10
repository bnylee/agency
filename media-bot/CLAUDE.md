# CLAUDE.md — media-bot

## Purpose

One place to find out what actually needs Agency operator today, assembled from the
accounts that shout at him, plus a reversible bin for the mail that does not.

Three jobs:

1. **A real-time-ish notification digest.** Every configured provider is read, and
   every message is classified `important` / `normal` / `junk` by a deterministic
   rule set with a recorded reason for each decision.
2. **A calendar.** The next fourteen days, from Outlook, Canvas and any published
   `.ics` feed, sorted by how soon it is rather than by which service it came from.
3. **A trash bin.** Junk mail is moved out of the Gmail inbox to a label and
   recorded in a manifest. It is never deleted. Emptying it is Benny's, in Gmail,
   looking at the list.

## What can actually be reached, and what cannot

This is the first thing to read, because four of the seven services originally
asked for have no API that returns a personal notification feed. Building against
an API that does not exist would produce a bot that cheerfully reported an empty
inbox forever.

| Service | Status | How, or why not |
| --- | --- | --- |
| **Gmail** | working | IMAP over TLS with a Google App Password. Read-only for collection; the label move is the one write. |
| **Canvas** | working | Canvas REST API, personal access token, `northeastern.instructure.com`. |
| **Outlook / M365** | working | Microsoft Graph, device-code OAuth, read-only scopes. Needs a one-time Azure app registration. |
| **Calendars** | working | Any published `.ics` URL. Needs no app registration, so it is the one to set up first. |
| **Instagram** | **no API** | The Graph API covers Business/Creator accounts you own — your own media and comments. There is no personal notification feed, no follower-activity endpoint and no DM access on a personal account. |
| **TikTok** | **no API** | The Display API returns your own videos and profile. No notifications, no comments firehose, no DMs. |
| **Snapchat** | **no API** | Snap's public APIs are advertising, Creative Kit and Login Kit. Nothing reads Snaps, chats, streaks or notifications, and no approval tier changes that. |

**The three unavailable ones are still covered, by a different route.** All three
email you about activity, so their notification mail is classified from Gmail and
surfaced under the service's own name, labelled `via: "email"`. A follow, a
mention, a message request and a login alert all arrive that way. Engagement bait
("5 people you may know", "see what you missed") is classified as junk; a real
event is not. See `SOCIAL_SENDERS` and `SOCIAL_REAL` in `scripts/classify.py`.

That is genuinely less than API access and is labelled as such everywhere it
appears, so a quiet day reads as "Instagram emailed nothing" rather than as a hole
in the coverage.

**Do not fix this by scraping.** A logged-in session scrape of any of the three
breaks their terms of service, breaks on every UI change, and would put a stored
credential one bug away from an account lock. If Meta or ByteDance ever ship a
personal-notification endpoint, that is a capability change for Benny to approve.

## May touch

- **Gmail** — IMAP `imap.gmail.com:993`, the account in `GMAIL_ADDRESS`. Read-only
  for collection; `triage.py` additionally copies to one label and removes the
  `INBOX` label.
- **Microsoft Graph** — `graph.microsoft.com`, scopes `Mail.Read`,
  `Calendars.Read`, `User.Read`, `offline_access`. All read-only.
- **Canvas** — the instance in `CANVAS_BASE_URL`, endpoints
  `/users/self/todo` and `/users/self/upcoming_events`. Read-only.
- **ICS feeds** — whatever URLs are in `ICS_URLS`. HTTP GET only.
- Read/Write: its own subfolder — writes restricted to `runs/` and
  `state/dryrun/`.

Nothing else. No sending, no replying, no posting, no deleting, no access to any
other bot's folder, and no ability to place, cancel or acknowledge anything.

### Enforcement

The agent has **no shell, no WebFetch and no WebSearch**, and that is the load-
bearing decision in this bot's design. Every network read and every mail operation
belongs to `scripts/collect.py` and `scripts/triage.py`, invoked by
`run_sweep.ps1` before and after the agent. The agent reads the resulting JSON and
writes prose.

The reason is the same one `finance-research` splits its broker out for: **the
model explains the classification, it never performs one.** If the agent could
shell out it could reach `imaplib` itself, and at that point no rule in
`classify.py` would constrain anything and the trash bin would stop being
auditable.

- `.claude/settings.local.json` holds the **allow** rules. A project
  `settings.json`'s allow rules are ignored until the workspace is trusted, which
  silently breaks unattended `claude -p --permission-mode dontAsk` runs — every
  tool call denied, no report written, the same way every time.
- `.claude/settings.json` holds **deny** rules and the hooks, both of which apply
  regardless of trust, and deny beats allow.
- File rules use `Edit(...)`, never `Write(...)`. `Write(...)` rules are not
  evaluated by file permission checks at all.
- `.claude/hooks/guard_writes.py` is an allowlist: `runs/` and `state/dryrun/`,
  nothing else. A deny list protects the files you thought of; an allowlist
  protects the ones you did not.
- `.claude/hooks/guard_reads.py` is **the only read guard in the Agency**, and it
  exists because this is the only bot holding credentials for accounts that are
  not its own. The threat is not theft — the agent has no network — it is
  *transcription*: reading `.env` and then quoting it into a run report, which
  persists and is rendered in a browser. Denying at the read is the only version
  that works, because once a string is in the transcript no later rule removes it.

## Pre-authorized actions

**Moving junk-classified Gmail messages to the label `Agency/Trash-Candidates`,
and only that.**

Concretely, the scheduled run may without asking: create that label if missing,
copy a junk-classified message to it, remove the `INBOX` label from that message,
and record the move in `state/trash-bin.json` with the rules that classified it.

Capped at 200 messages per run. Reversible with:

```powershell
python scripts\triage.py restore --batch <YYYY-MM-DD>
```

Everything else is surfaced, not performed. Specifically **not** pre-authorized
and not implemented: deleting anything, sending or replying to anything, marking
anything read, archiving, moving anything in Outlook, changing a calendar,
submitting a Canvas assignment, or posting anywhere.

### Why a label and not Gmail's Trash

Gmail's own Trash auto-purges after 30 days, which would make this bot
destructive on a timer without anybody choosing that. A label does nothing on its
own, forever. This is `disk-cleanup`'s quarantine model applied to mail, for the
same reason: the bot does the reversible half and the irreversible half stays a
human decision made while looking at what is about to be lost.

**There is deliberately no purge verb anywhere in this bot**, and adding one would
be a mistake for the same reason `disk-cleanup`'s `purge.ps1` refuses a
non-interactive console.

### The classifier is asymmetric, on purpose

Being wrong in the two directions costs very different amounts. Junk left in the
digest is mild noise; an important message routed to the bin can mean a missed
deadline. So:

- **Any important signal beats every junk signal** — not outweighs, beats. No
  quantity of marketing headers can bury mail from a `northeastern.edu` sender, a
  thread reply, a named deadline, or anything matching a security/money pattern.
- **Junk needs at least two corroborating signals.** A mailing list you read on
  purpose carries `List-Id` and `List-Unsubscribe`; that alone is not junk.
- **Unrecognised social notifications stay in the feed.** The pattern lists cannot
  be complete, and a new notification type silently vanishing into the bin is the
  failure that actually matters.
- Every decision records which rule fired. A bin you cannot interrogate is a bin
  you will not trust, and one you do not trust you will not empty.

If a classification is wrong, the run says so under **Carry forward** with the
sender and the rule. It does not work around it — the rules live in
`scripts/classify.py` and changing them is a code change Benny makes.

## Schedule

**Daily, 7:00am local**, via a Windows scheduled task `media-bot-daily` running
`scripts/run_sweep.ps1`. Ahead of `agency-repair` at 7:15 and behind
`finance-research` at 6:00, so the three do not contend.

`state/graph-token.json` is refreshed on every run and Microsoft rotates the
refresh token each time, so a gap of several months could require re-running
`scripts/graph_login.py`. The bot reports that as `not_configured` with the exact
command, rather than as a failure.

## Setup, in the order that gets you something working fastest

1. `cp .env.example .env`
2. **ICS_URLS** first — a published calendar URL needs no registration and gets
   the calendar half working immediately.
3. **CANVAS_TOKEN** next — one page in Canvas settings.
4. **GMAIL_ADDRESS / GMAIL_APP_PASSWORD** — needs 2-Step Verification on.
5. **GRAPH_CLIENT_ID**, then `python scripts/graph_login.py` once, by hand. This
   is the only step with real setup cost; see the docstring at the top of that
   script, especially "Allow public client flows: Yes".

The bot is useful after step 2 and does not complain about the rest beyond one
Holding line each.

## Dry run

```powershell
.\scripts\run_sweep.ps1 -DryRun
```

**It is not "the live run with the writes disabled."** It performs every network
read for real, classifies everything for real, **writes a real digest** — to
`state/dryrun/collect-latest.json` rather than to `state/` — and then prints
exactly which messages `triage.py` would move and the rule that condemned each
one, and moves none of them. No live digest, no report, no ledger line, and
nothing touched in anybody's mail.

The digest write is not an oversight. A dry run that skips it is not exercising
the write path, which is where the bugs are — and that is not hypothetical here:
the first version passed `--dry-run` to `collect.py` too, so nothing was written,
`triage.py` was then handed a path with no file at it, reported "cannot read
digest", and **the sweep exited 0 anyway**. Both halves of that were only found by
running it.

`collect.py --dry-run` still exists for a standalone check that writes nothing at
all. It is not what the sweep uses.

It deliberately does **not** invoke the agent. The expensive half of this run is
the agent and the risky half is the staging, and the dry run exercises the risky
half for free. Validate every behaviour change through it before the next
scheduled run.

Component checks, when one provider is misbehaving:

```powershell
python scripts\collect.py --out state\dryrun\collect.json --dry-run --only gmail
python scripts\triage.py list
python scripts\triage.py stage --digest state\collect-latest.json --dry-run
python scripts\triage.py restore --batch 2026-08-04 --dry-run
```

## Approved exception: local scripts

The root CLAUDE.md forbids custom code until an MCP gap is demonstrated. The gap
here is not "no MCP server does mail" — several do. It is narrower and worth
stating precisely:

**The classification must not be done by the thing writing the prose.** That is
the same gap `finance-research`'s `paper_broker.py` fills. A trash bin whose
membership is decided by a language model is unauditable: you could never tell
whether a message was binned by a rule or by a mood, and `restore` could not
promise to put back exactly what was taken. `scripts/classify.py` is a pure
function of each message's own headers, and it records which rule fired.

The second reason is scope. A general mail MCP server exposes send, reply, delete
and modify. This bot must be structurally incapable of three of those, and the
cheapest way to be structurally incapable is not to have the code — `triage.py`
contains no delete path and no send path, not even a disabled one.

Every script is **standard library only**: `imaplib`, `urllib.request`, `ssl`,
`email`, `json`. No virtualenv, no install step, no supply-chain surface on the
one bot that holds live mail credentials. If a future provider genuinely needs a
package, that is the moment to add a venv.

## Run report

Follow the root CLAUDE.md's run-report format, written to `runs/<ISO-date>.md`,
plus a `runs/<ISO-date>.html` page via the shared `live-artifact` skill. Keep
`runs/ledger.md` updated per run.

Three rules specific to this bot's reports:

- **Never describe a staged message as deleted.** It is a label move and it is
  reversible. Name the restore command every time.
- **Never quote the body of anybody's message.** The collector never fetches one;
  subjects and senders are what a digest needs.
- **Never convert a calendar time.** The digest states times as the source stated
  them and explains where that is approximate. A time silently shifted by a
  timezone guess is worse than one shown with a caveat.
