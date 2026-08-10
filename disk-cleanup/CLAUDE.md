# CLAUDE.md — disk-cleanup bot

## Purpose

Reclaims disk space on Benny's machine. C: was at 109.9 GB free of 927.9 GB (11.8%) when this bot was built on 2026-08-03.

**This bot never deletes anything.** It scans, it ranks, and it *stages* regenerable files into a dated quarantine batch that Benny purges or restores. That is not caution for its own sake — it is the root CLAUDE.md's rule that irreversible actions run autonomously only where pre-authorized, applied to the one bot in the registry whose subject matter is destructive.

### What the first survey found, and why the design is shaped this way

The obvious design — a junk-file cleaner — is aimed at the wrong target on this machine:

| Location | Size | Kind |
| --- | --- | --- |
| `Program Files (x86)\Steam` | 306.07 GB | installed games |
| `Program Files\Epic Games` (+2.19 x86) | 96.16 GB | installed games |
| `C:\Riot Games` | 68.91 GB | installed games |
| `Downloads` | 41.27 GB | genuine junk candidate |
| `pagefile.sys` + `hiberfil.sys` | 32.58 GB | never touch |
| Temp / pip / Chrome / Recycle Bin | ~2.2 GB | genuine junk, negligible |

**Games are ~58% of used space. Everything a file-deletion bot may legitimately touch is roughly 45–60 GB.** Three Steam titles untouched for 4–12 months held 181 GB on their own — three times the entire junk-file surface.

So the bot's most valuable output is the **installed-footprint report**, not the deletions. Uninstalling is a human judgement ("do I still play this?") that no heuristic should make, and it stays report-only permanently.

## Three action tiers

| Tier | Actions | Autonomous? | Reversible? |
| --- | --- | --- | --- |
| A | scan, size, rank installed programs by last-used | yes | n/a — read-only |
| B | move to quarantine | yes | yes — manifest + `restore.ps1` |
| C | permanent deletion, **any uninstall** | **never** | no — Benny only |

## May touch

- Read: the local filesystem, for sizing and metadata.
- Write: its own `runs/` and `state/`; the quarantine root `C:\DiskCleanupQuarantine\`.
- Move (Tier B): files matching a scan candidate that survives `Test-NeverTouch`, into quarantine.
- No network except `install_tools.ps1`'s one-time fetch from `github.com` / `api.github.com`.

Nothing else. No email, no messaging, no git, no uninstalls, no access to another bot's folder.

### OneDrive

Benny's whole profile is OneDrive-backed, so **a local delete under OneDrive propagates to the cloud and to every synced device.** The bot may never write or move anything under `C:\Users\you\OneDrive\` — enforced in `guard_commands.py`, which resolves every path token in every command and rejects OneDrive paths outside this bot's own tree.

There is deliberately **no blanket `Edit(~/OneDrive/**)` deny rule**: this bot lives at `OneDrive\Desktop\Agency\disk-cleanup`, so a blanket deny would block it writing its own `runs/` and it would fail silently every week. The protection is positive instead — `guard_writes.py` permits *only* `runs/` and `state/`.

Dehydration (`attrib +U -P`, marking synced files cloud-only) was considered and dropped: OneDrive totals only 5.52 GB here, so it was not worth the code.

## Enforcement

Enforcement is split across two files for reasons that are easy to get wrong:

- `.claude/settings.local.json` holds the **allow** rules. A project `settings.json`'s allow rules are ignored until the workspace is trusted, which silently breaks unattended `claude -p --permission-mode dontAsk` runs. Local settings need no trust.
- `.claude/settings.json` holds **deny** rules and the `PreToolUse` hooks, which apply regardless of trust.
- File rules use `Edit(...)`, never `Write(...)`. `Write(...)` rules are not evaluated by file permission checks.

This bot needs one thing the other two do not:

- `.claude/hooks/guard_writes.py` — the shared backstop, copied verbatim. Matches `Write|Edit`.
- `.claude/hooks/guard_commands.py` — **new, and the important one.** The sibling bots only read external sources, so guarding `Write|Edit` suffices for them. This bot's risk is in shell commands, and `guard_writes.py` alone would let `Remove-Item -Recurse` straight through.

`guard_commands.py` is an **allowlist of this bot's own scripts**, not a denylist of dangerous verbs. A denylist over shell strings is evaded by quoting, aliasing or chaining, and a guard that can be evaded is decoration. It also blocks shell chaining and redirection so an allowed script cannot prefix an arbitrary command. New capability goes in a script, not an ad-hoc command.

`policy.json` deliberately sits at the **bot root, not in `state/`** — `state/` is bot-writable, so a never-touch list living there could be edited by the bot it constrains.

`purge.ps1` has two independent locks: `guard_commands.py` denies any command naming it, and the script itself refuses to run without an interactive console and a typed batch id.

## Pre-authorized actions

**Tier B only:** moving scan candidates into `C:\DiskCleanupQuarantine\<date>\`, capped at 25 GB / 5,000 files per run, every candidate re-checked against the never-touch list at the moment of the move. Fully reversible via `restore.ps1`.

**Not pre-authorized, ever:** permanent deletion, emptying the Recycle Bin, uninstalling anything, `powercfg`, `DISM`, or any change to system configuration.

## Schedule

Weekly, **Saturday 08:00**, via the Windows scheduled task `disk-cleanup-weekly` running `scripts/run_weekly.ps1`. Deliberately not Sunday 09:00 — that is `sam-research-weekly`'s slot, and two concurrent `claude -p` runs would contend.

## Dry run

```powershell
.\scripts\run_weekly.ps1 -DryRun
```

Exercises every scan and the full quarantine decision path, renders the complete manifest to `state/quarantine-dryrun.json`, and moves nothing. Free space and file counts must be identical before and after. Validate every behaviour change through this.

## Reading the reports

Two numbers that are easy to misread, and which the report must always separate:

- **Pending ≠ reclaimed.** C: is the only fixed volume, so quarantining is a same-volume rename. It frees **zero bytes**. Space appears only when `purge.ps1` runs.
- **WinSxS is not reclaimable as shown.** It reports ~18 GB apparent, but it is hardlink-inflated and the real on-disk cost is a fraction of that. Only DISM reduces it, and never autonomously.

Metadata quality differs by source: only **Steam** records a true last-played date. Epic and Riot fall back to directory mtime, and registry-listed apps expose the **install** date, not a usage date. A cold flag on those is not evidence of disuse.

## Commands

```powershell
.\scripts\install_tools.ps1                 # one-time: fetch czkawka_cli
.\scripts\run_weekly.ps1 -DryRun            # full logic, stages nothing
.\scripts\run_weekly.ps1                    # live run
.\scripts\restore.ps1 -BatchId 2026-08-08   # put a batch back
.\scripts\purge.ps1   -BatchId 2026-08-08   # PERMANENT — Benny, interactively
```

## Run report

Follow the root CLAUDE.md's run-report format, written to `runs/<ISO-date>.md`. Keep `runs/ledger.md` updated per run.
