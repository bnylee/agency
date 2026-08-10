---
name: live-artifact
description: Render a bot run into a single self-contained HTML page (a "live artifact") that opens by double-click with no server, no network and no token. Use at the end of any run that produces something a human will read. The model writes a small JSON facts file; a script does all the HTML.
user-invocable: true
---

# Live artifact

Turn a run into one HTML file a person can open, keep, and send, without the
control plane running.

## The rule that makes this cheap

**You write JSON. You never write HTML.**

`render.mjs` holds the entire template — layout, dark theme, tables, bars,
status colours. It is a plain Node script and you do not need to read it. Your
job is a facts file of maybe twenty lines. That is the whole reason this exists
instead of the obvious alternative.

Measured on the disk-cleanup example in `example/`, by running it:

| | lines | bytes |
| --- | --- | --- |
| `example/disk-cleanup.artifact.json` — what you emit | 59 | 2,621 |
| `example/disk-cleanup.html` — what gets written | 165 | 7,951 |

So roughly a third of the output tokens for the same page, and most of the JSON
is prose you were already writing into the run report. The real saving is that
**the figure does not move when the template gets better.** Making the page
prettier edits `render.mjs`, once, in an interactive session — it does not add a
token to any of the ~250 scheduled runs a year that use it.

## Use it when

The run produces something a human reads: a report, a scan, a set of
notifications, a health sweep. Not for a run whose only output is state a
program consumes.

## Steps

1. Write the facts file next to the run report, as
   `runs/<bot>/<ISO-date>.artifact.json`.
2. Run:

   ```bash
   node .claude/skills/live-artifact/render.mjs --in runs/<bot>/<date>.artifact.json --out runs/<bot>/<date>.html
   ```

3. Name the HTML file in the run report's **Did** line, with its path.

Under `-DryRun` / dry-run mode, add `--dry-run`. It validates the facts, prints
what it would write and the byte count, and writes nothing.

## The facts file

Only `bot`, `title` and `status` are required. Everything else is optional and
omitted cleanly — an absent section does not leave a heading behind.

```json
{
  "bot": "disk-cleanup",
  "title": "Weekly scan",
  "timestamp": "2026-08-08T08:00:00-04:00",
  "status": "ok",
  "summary": "Two plain sentences a stranger could follow. What happened, and what it means for the reader.",
  "metrics": [
    { "label": "Reclaimable", "value": "22.4", "unit": "GB", "note": "across 4,812 files" }
  ],
  "sections": [
    { "heading": "By category", "kind": "bars",
      "items": [{ "label": "Package caches", "value": 11.2, "unit": "GB" }] },
    { "heading": "Biggest programs", "kind": "table",
      "columns": ["Name", "GB", "Last used"],
      "rows": [["Unreal Engine", "48.1", "2024-11-02"]] },
    { "heading": "What I did not touch", "kind": "list",
      "items": ["Anything under Documents/"] },
    { "heading": "Note", "kind": "text",
      "body": "Plain prose. Blank lines split paragraphs." }
  ],
  "holding": ["Quarantine batch 2026-08-08 is staged — restore or purge it yourself."],
  "failed": [],
  "links": [{ "label": "Full report", "href": "2026-08-08.md" }]
}
```

- `status` is one of `ok`, `partial`, `failed`, `never_run`, `running`. Anything
  else is an error, not a guess.
- `metrics` — the first one is drawn large. Put the number that answers "did
  this work" first.
- `kind` is one of `text`, `list`, `table`, `bars`. A `bars` item needs a numeric
  `value`; the widths are proportional to the largest one.
- `holding` and `failed` map to the run report's own **Holding** and **Failed**
  sections. Keep them identical — two accounts of the same run that disagree is
  worse than one.

## Constraints this respects

- **No network.** No CDN, no webfont, no analytics. System font stacks only.
  The page renders on a machine with the cable out.
- **No script tags.** The output is static HTML and inline CSS. Nothing in it
  executes, so it is safe to open, safe to keep, and safe to send.
- **Everything is escaped.** Report text goes through an HTML escape, so a `<`
  in a file path cannot become markup.
- **Writes only where told.** The script refuses an `--out` path outside the
  Agency root, so a bot cannot scatter pages across the disk.

## Why not Anthropic's Live Artifacts

Anthropic's Live Artifacts (Claude Code, June 2026) publishes a session to a
private hosted URL that updates in place, for Team and Enterprise orgs. It is
invoked by asking for it in an interactive session.

Two reasons it is not what the Agency's bots use:

1. **It publishes outward.** A scheduled bot has nobody to approve that, and
   this repo's rule is that externally visible actions execute autonomously only
   where the bot's own CLAUDE.md pre-authorises them. None do.
2. **The closest installable skill is the wrong shape.** `web-artifacts-builder`
   in `anthropics/skills` is React + TypeScript + Vite + Parcel + shadcn/ui: it
   npm-installs a project, needs network, and has the model author every
   component. On a loopback box with no network and a token budget, that is the
   expensive path to the same rectangle.

So the local half is here and the hosted half is not. If you want the hosted
one, ask for it by name in an interactive session — that path stays open and
stays a human decision.
