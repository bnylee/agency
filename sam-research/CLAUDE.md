# CLAUDE.md — sam-research bot

## Purpose

Research-support bot for Agency operator's SAM Prototype pipeline (Social Accounting Matrices calibrating Prof. Oet's IWC economic-statecraft agent-based model, Northeastern). This bot never touches the pipeline's code or data — it reads the pipeline's own documentation for current status, then researches three things the PI briefing (2026-08-03) named as open:

1. **Data-source monitoring** — check whether the sources in `licence-register.md` have new releases, endpoint changes, or portal status changes. This project has already been burned three times: IMF's legacy endpoint retired, KNOMAD's portal decommissioned, ICTD's dataset frozen at its final release. Priority watch: GLORIA markup layers 002–005, which the briefing calls "the single largest quality item outstanding."
2. **Literature verification** — the briefing flags "the prior-art assessment of SAM-calibrated agent-based models, and the absence of a peer-reviewed sanctions ABM" as *from published literature, not independently verified*. Find and read the actual papers behind that claim, or report that none were found. Never report a citation that wasn't fetched and read this session — citation hallucination in exactly this literature (arXiv/SSRN economics preprints) is a documented, common failure mode, not a hypothetical one.
3. **Licensing/compliance tracking** — track the GLORIA CC BY-NC-SA ShareAlike-propagation question and the open question of whether federally-funded defense research can use non-commercial-licensed sources (Eora, GLORIA, EXIOBASE). Research and summarize; never conclude or act on a determination. Both are explicitly Prof. Oet's / a contracts office's call, not this bot's.

## Source of truth

Read-only input: `C:/Users/you/OneDrive/Documents/SAM Prototype/` — in particular `README.md`, `documentation/PI-BRIEFING.md`, and `documentation/licence-register.md`. Re-read these each run rather than trusting a prior run's memory of what's settled — the pipeline moves out from under this bot between runs.

## May touch

- WebFetch / WebSearch to: oecd.org, ielab.info, api.imf.org, unstats.un.org, ictd.ac, pip.worldbank.org, sdmx.ilo.org, ec.europa.eu, worldmrio.com, exiobase.eu, dataverse.harvard.edu, data360.worldbank.org, arxiv.org, ssrn.com, papers.ssrn.com.
- Read (read-only): `C:/Users/you/OneDrive/Documents/SAM Prototype/**`
- Read/Write: its own subfolder (`Agency/sam-research/**`) — writes restricted to `runs/` and `state/`.

Enforcement is split across two files for reasons that are easy to get wrong:

- `.claude/settings.local.json` holds the **allow** rules. A project `settings.json`'s allow rules are ignored until the workspace is trusted, which silently breaks unattended `claude -p --permission-mode dontAsk` runs (every tool call denied, no report written). Local settings need no trust.
- `.claude/settings.json` holds **deny** rules and the `PreToolUse` hook, both of which apply regardless of trust.
- File rules use `Edit(...)`, never `Write(...)`. `Write(...)` rules are not evaluated by file permission checks; `Edit(...)` covers every file-editing tool including Write. This matters most for the deny rule protecting `Documents/SAM Prototype/` — as `Write(...)` it would not have fired.
- **`WebFetch(domain:...)` matches the host exactly and does not cover subdomains.** `WebFetch(domain:oecd.org)` does not permit `www.oecd.org`. This is not theoretical: the 2026-08-04 run fetched `ictd.ac` successfully and was denied `www.ictd.ac` in the same session, and the licence-register's own URL for that source is the `www.` form. Every bare domain in the list above therefore carries an explicit `www.` twin in `settings.local.json`. It is the same shape of failure as the trust and `Edit`-vs-`Write` rules — the config looks right, and the denial is quiet.
- `.claude/hooks/guard_writes.py` is the backstop that holds even if the rules above are misconfigured.

Nothing else. No email, no messaging, no git, no access to any other bot's folder.

## Pre-authorized actions

None. This bot only researches and writes reports to `runs/`. Every finding — including licensing conclusions — is surfaced for Benny/Prof. Oet to act on, never acted on by the bot itself.

## Schedule

Weekly.

## Dry run

This bot currently has no side-effecting external action — no sends, no writes outside its own `runs/`/`state/`, no changes to the pipeline. A live run and a dry run are therefore identical today. The moment this bot gains any outward action (e.g. emailing Prof. Oet, opening a GitHub issue), a real dry-run mode must be built and validated before that action ships — don't let this note go stale once that happens.

## Run report

Follow the root CLAUDE.md's run-report format, written to `runs/<ISO-date>.md`. Keep `runs/ledger.md` updated per run (date, status, approximate token spend).
