/**
 * Tests for the run-report digest parser. `npm run test:digest`
 *
 * ## Why this exists, written down as a reminder
 *
 * The first version of `digestReport` **did not work on a single real report in
 * this repository**, and it shipped. It broke on a blank line, and every bot puts a
 * blank line between the `##` heading and `**Status**`, so every report fell through
 * to the raw-markdown fallback. The fallback is good enough to look plausible, so
 * nothing appeared broken — no exception, no empty panel, just a feature quietly not
 * happening. It took a screenshot of the real UI to notice.
 *
 * The lesson is not "write more tests", it is **test against real input**. The
 * fixtures below are the actual shapes the bots emit, blank lines and all, including
 * the two-block form a run script produces when it appends a failure after the agent
 * has already written a good report.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clampValue, digestReport, statusRole } from "../src/ui/theme";

const AGENCY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}

/* ------------------------------------------------- the real-world shape ---- */

// Exactly as the bots write it: blank line after the heading, blank line between
// fields, hard wrapping mid-sentence, and a Did section that continues into further
// paragraphs and bullet lists which are NOT part of the Did summary.
const REAL = `## interface-design — 2026-08-04T01:45:00-04:00

**Status** — ok

**Did** — The orrery became a room. Requested change: recolour the bodies and the
3D background, make the bodies physical machines that are still clickable and
still zoom.

Skills, vendored following this bot's existing convention (project-scoped, licence
recorded, hash in \`skills-lock.json\`):

- \`interface-design/.claude/skills/json-canvas/\` and \`.../obsidian-markdown/\`
- \`skills-lock.json\` updated with both.

**Holding** — nothing.

**Failed** — nothing.

**Carry forward** — The scene palette lives in the new \`scene\` block.
`;

console.log("the real report shape — blank lines and all");

const d = digestReport(REAL);

ok("a heading is found past the leading blank lines", d.heading === "interface-design — 2026-08-04T01:45:00-04:00",
   String(d.heading));
ok("Status is extracted despite the blank line after the heading", d.status === "ok", String(d.status));
ok("all four non-status fields are found", d.fields.length === 4,
   d.fields.map((f) => f.label).join(", "));
ok("fields come back in the canonical order",
   d.fields.map((f) => f.label).join("|") === "Did|Holding|Failed|Carry forward",
   d.fields.map((f) => f.label).join("|"));
ok("blocks counted", d.blocks === 1, String(d.blocks));

const did = d.fields.find((f) => f.label === "Did")!;
ok("a hard-wrapped value is rejoined into one line",
   did.value.includes("recolour the bodies and the 3D background"),
   "wrap point is mid-phrase");
ok("the value STOPS at the blank line, not at the end of the section",
   !did.value.includes("Skills, vendored") && !did.value.includes("skills-lock.json updated"),
   `${did.value.length} chars`);
ok("a bullet list after the value is not absorbed", !did.value.includes("json-canvas"));

ok("the full report is returned intact, not the remainder",
   d.rest.includes("## interface-design") && d.rest.includes("json-canvas") && d.rest.includes("Carry forward"),
   "a parser bug must not be able to delete report content");

/* ---------------------------------------------------- the heading form ---- */

console.log("\nthe heading form — `### Did` instead of `**Did** —`");

// sam-research writes it this way. Supporting only the inline form meant its
// reports fell through to the fallback with a perfectly good Status at the top.
const HEADINGS = `## sam-research — 2026-08-04T13:20:00-04:00

**Status** — partial

Three of the register's thirteen sources could not be reached at all.

---

### Did

Re-read the SAM Prototype docs and checked all thirteen registered sources.
Verified the prior-art claim against the actual papers.

### Holding

- GLORIA markup layers 002-005 still unreachable
- Two licence questions need a contracts office, not this bot

### Carry forward

The IMF endpoint moved again.
`;

const hd = digestReport(HEADINGS);
ok("heading-form fields are found", hd.fields.length === 3,
   hd.fields.map((x) => x.label).join(", "));
ok("Status still comes from the inline form above them", hd.status === "partial", String(hd.status));
ok("a heading field's prose is joined", hd.fields.find((x) => x.label === "Did")!.value.includes("thirteen registered sources"));
ok("a heading field's BULLETS become the value, not 'nothing'",
   hd.fields.find((x) => x.label === "Holding")!.value.includes("GLORIA")
   && hd.fields.find((x) => x.label === "Holding")!.value.includes(";"),
   hd.fields.find((x) => x.label === "Holding")!.value.slice(0, 60));
ok("the bot's own `## name — stamp` line is a block, not a field",
   hd.blocks === 1 && hd.heading!.startsWith("sam-research"), `blocks=${hd.blocks}`);
ok("a `---` rule does not become a value", !JSON.stringify(hd.fields).includes("---"));

/* ------------------------------------------------------ the appended block - */

console.log("\nthe two-block form a run script produces on failure");

const APPENDED = `## finance-research — 2026-08-04T06:00:00-04:00

**Status** — ok
**Did** — Wrote the pre-market report and queued two orders.
**Holding** — nothing.
**Failed** — nothing.
**Carry forward** — nothing.

## finance-research — 2026-08-04T06:04:11-04:00
**Status** — failed
**Did** — see above; the run aborted at a later step.
**Holding** — nothing.
**Failed** — paper_broker queue exited 1
**Carry forward** — The paper account may not have advanced today.
`;

const a = digestReport(APPENDED);
ok("both blocks are counted", a.blocks === 2, String(a.blocks));
ok("the FIRST block's status is used, not the last", a.status === "ok", String(a.status));
ok("the first block's Did is used", a.fields.find((f) => f.label === "Did")!.value.startsWith("Wrote the pre-market"));
ok("fields are not duplicated across blocks", a.fields.length === 4, String(a.fields.length));
ok("the appended block survives in rest", a.rest.includes("paper_broker queue exited 1"),
   "this is the half that says the run actually broke");

/* ------------------------------------------------------------- the fallback */

console.log("\nreports that do not match — the path that must never lose content");

const FREEFORM = "Just some notes.\n\nNothing structured about this at all.\n";
const f = digestReport(FREEFORM);
ok("no fields found", f.fields.length === 0);
ok("no status", f.status === null);
ok("no heading", f.heading === null);
ok("the whole thing is still in rest", f.rest.includes("Just some notes"));

const EMPTY = digestReport("");
ok("an empty report does not throw", EMPTY.fields.length === 0 && EMPTY.rest === "");

// A bolded word inside a paragraph must not be promoted into the digest.
const DECOY = `## bot — now

**Status** — ok

**Did** — Something. **Note** — this is prose, not a field.

**Definitely** — not a real field name.
`;
const dec = digestReport(DECOY);
ok("only known field names are promoted", dec.fields.map((f2) => f2.label).join(",") === "Did",
   dec.fields.map((f2) => f2.label).join(","));

/* ------------------------------------------------ separators and statuses -- */

console.log("\nseparators, since the bots are not consistent about them");

for (const sep of ["—", "--", "-", ":"]) {
  const one = digestReport(`**Status** ${sep} partial\n`);
  ok(`\`${sep}\` is accepted as a separator`, one.status === "partial", String(one.status));
}

console.log("\nstatus roles");
ok("plain ok", statusRole("ok") === "ok");
ok("a status with commentary keeps its role", statusRole("partial — three probes failed") === "partial");
ok("failed", statusRole("failed") === "failed");
ok("never run, spelled either way",
   statusRole("never_run") === "never_run" && statusRole("never run") === "never_run");
ok("an unrecognised value returns null rather than guessing", statusRole("mostly fine") === null,
   "null means do not colour it — a wrong glyph is worse than none");
ok("null in, null out", statusRole(null) === null);

/* -------------------------------------------------------------- clampValue - */

console.log("\nclampValue");
const short = clampValue("short enough");
ok("a short value is untouched", short.text === "short enough" && !short.clamped);
const long = clampValue("word ".repeat(200));
ok("a long value is clamped", long.clamped && long.text.length < 320, `${long.text.length} chars`);
ok("it breaks on a word boundary and marks the cut", long.text.endsWith("…") && !long.text.includes("wor…"),
   long.text.slice(-24));

/* --------------------------------------------- every report actually on disk */

console.log("\nevery report on disk parses to a usable digest");

const BOTS = ["sam-research", "finance-research", "disk-cleanup", "interface-design", "agency-repair", "media-bot"];
let found = 0;
let digested = 0;
for (const bot of BOTS) {
  const dir = join(AGENCY, bot, "runs");
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const body = readFileSync(join(dir, name), "utf8");
    const g = digestReport(body);
    // The right assertion is NOT "every report digests". agency-repair's
    // 2026-08-03 report is an interactive, human-requested write-up with no
    // `**Status**` line at all, and falling back to raw markdown is CORRECT for it —
    // the digest describes the fixed run-report format and that file is not in it.
    // What must hold is: if a report DECLARES a status, the digest must find its
    // fields. That is the property the first version violated on every input.
    const declares = /^\*\*Status\*\*|^#{2,4}\s+Status/m.test(body);
    if (!declares) {
      ok(`${bot}/${name}`, true, "freeform — no Status declared, fallback is correct");
      continue;
    }
    found++;
    const good = g.fields.length > 0 && g.status !== null;
    if (good) digested++;
    ok(`${bot}/${name}`, good,
       good ? `status=${g.status} fields=${g.fields.length} blocks=${g.blocks}`
            : "DECLARES a Status but fell through to the fallback");
  }
}

ok("there were real reports declaring a status", found > 0, `${found} found`);
ok("every report that declares a status produced a digest", digested === found, `${digested}/${found}`);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
