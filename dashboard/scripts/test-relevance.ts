/**
 * Tests the relevance scorer against the cases that actually bite.
 *
 *   npm run test:relevance
 *
 * The scoring rules are cheap to state and easy to get subtly wrong, and every
 * case below is a way the graph silently stops describing what it claims to:
 *
 * - **`sam-research-weekly` must not count as a mention of `sam-research`.**
 *   Every bot's scheduled task is named `<bot>-<cadence>`, and those strings are
 *   all over the run reports. Counting them would score a bot against itself
 *   through its own task name and inflate every edge that mentions a schedule.
 *   `\b` cannot do this job: it treats the hyphen in a bot id as a boundary, so
 *   `\bsam-research\b` matches happily inside `sam-research-weekly`. Hence the
 *   explicit `(?<![\w-])` / `(?![\w-])` pair.
 * - **A wikilink must score 3, not 4.** `[[x]]` also matches the bare-mention
 *   pattern, so the mention count has the link counts subtracted out. Forgetting
 *   that made every explicit link worth a third more than intended.
 * - **The per-file caps must hold.** They are the only thing stopping one wordy
 *   document from outweighing every real link in the Agency.
 *
 * Exit code is 1 on any failure, so this can gate a build.
 */
import { score } from "../server/relevance.js";

interface Case {
  name: string;
  text: string;
  target: string;
  want: number;
}

const W_WIKILINK = 3;
const W_MDLINK = 2;
const W_MENTION = 1;

const cases: Case[] = [
  // --- the boundary guard ---
  {
    name: "scheduled task name is not a mention",
    text: "the task sam-research-weekly runs on Sunday",
    target: "sam-research",
    want: 0,
  },
  {
    name: "suffixed id is not a mention",
    text: "see security-watch-daily for details",
    target: "security-watch",
    want: 0,
  },
  {
    name: "prefixed id is not a mention",
    text: "the xsam-research thing",
    target: "sam-research",
    want: 0,
  },
  {
    name: "hyphen before the id still counts (list bullet, dash separator)",
    text: "- sam-research is weekly",
    target: "sam-research",
    want: W_MENTION,
  },
  {
    name: "bare prose mention",
    text: "disk-cleanup never deletes anything.",
    target: "disk-cleanup",
    want: W_MENTION,
  },

  // --- forms and their weights ---
  {
    name: "wikilink scores 3, not 3 plus a mention",
    text: "see [[disk-cleanup]]",
    target: "disk-cleanup",
    want: W_WIKILINK,
  },
  {
    name: "aliased wikilink still scores 3",
    text: "see [[disk-cleanup|the sorter]]",
    target: "disk-cleanup",
    want: W_WIKILINK,
  },
  {
    name: "markdown link into the tree scores 2, not 2 plus a mention",
    text: "[the bot](disk-cleanup/CLAUDE.md)",
    target: "disk-cleanup",
    want: W_MDLINK,
  },
  {
    name: "relative markdown link scores 2",
    text: "[up one](../disk-cleanup/CLAUDE.md)",
    target: "disk-cleanup",
    want: W_MDLINK,
  },
  {
    name: "mixed forms add up",
    // one wikilink (3) + one md link (2) + one bare mention (1)
    text: "[[agency-repair]] and [it](agency-repair/CLAUDE.md) and plain agency-repair",
    target: "agency-repair",
    want: W_WIKILINK + W_MDLINK + W_MENTION,
  },

  // --- caps ---
  {
    name: "bare mentions cap at 6",
    text: Array(20).fill("interface-design").join(" and "),
    target: "interface-design",
    want: 6 * W_MENTION,
  },
  {
    name: "wikilinks cap at 4",
    text: Array(9).fill("[[interface-design]]").join(" "),
    target: "interface-design",
    want: 4 * W_WIKILINK,
  },

  // --- absence ---
  {
    name: "unrelated text scores nothing",
    text: "this document is about the weather",
    target: "finance-research",
    want: 0,
  },
  {
    name: "a different bot's id scores nothing",
    text: "finance-research does paper trades",
    target: "sam-research",
    want: 0,
  },
];

let failed = 0;
for (const c of cases) {
  const got = score(c.text, c.target);
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? "pass" : "FAIL"}  want=${String(c.want).padStart(2)} got=${String(got).padStart(2)}  ${c.name}`);
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
