/**
 * Per-bot panel identity.
 *
 * Each bot's panel gets its own typographic voice, accent and header treatment, so
 * that opening one feels like opening *that bot's* instrument rather than a generic
 * drawer with a different name in it. The 3D character and the panel now agree:
 * the accent below is the same hue as the bot's model tint in
 * `scene/bots3d.ts` → `BOT_LOOK`.
 *
 * ## The one thing this may not touch, and why
 *
 * **`--surface` (#1a1a19) stays exactly where it is on every theme.**
 *
 * Every status contrast figure in `interface-design/design/design-dna.json` — ok
 * 5.19, partial 9.49, failed 3.62, never_run 4.62, running 4.28 — is measured
 * against that one hex. `--status-failed` #d03b3b clears its requirement at
 * 3.62:1 with nothing to spare. So a theme that tinted the panel background would
 * silently invalidate all five, and the one that would break first is the one that
 * means "this bot is broken".
 *
 * What themes are therefore allowed to change: type, tracking, the accent used for
 * rules and titles, the header band, and the structural template. What they may
 * not change: the panel's base surface, and the five status hexes.
 *
 * The status chip additionally paints its OWN `--surface` background now (see
 * `.panel-head .chip` in styles.css), so it carries the background its figures
 * were measured against wherever a theme puts it. That is deliberately the same
 * trick `scene/materials.ts` uses in 3D — a status panel is set into a bezel
 * painted #1a1a19 so the warm room behind the bot is never its local background.
 * Same problem, same answer, in two very different renderers.
 *
 * ## Fonts are system stacks, not webfonts, and that is not a compromise
 *
 * This server binds 127.0.0.1 and must render with no network — the same
 * constraint that put Geist in `public/fonts/` instead of on a CDN. Six themed
 * webfonts would be six more files to vendor, license and keep in step.
 *
 * The stacks below are built from faces that ship with Windows 11 (Georgia,
 * Bahnschrift, Candara, Constantia, Consolas, Segoe UI Variable) and each ends at
 * Geist, so a machine without them degrades to the house face rather than to
 * Times New Roman. The variety is real on the target machine and the fallback is
 * graceful everywhere else.
 */

export interface BotTheme {
  /** What this bot IS, in three or four words. Sits above the title. */
  role: string;
  /** A single character used as the header sigil. Decorative, `aria-hidden`. */
  sigil: string;
  /** One line naming the voice, for the theme's own documentation in devtools. */
  voice: string;
}

/**
 * Roles are written to say what the bot does FOR YOU, not what it is made of.
 * "Disk reclamation, quarantine only" is the registry's blurb and reads as a spec;
 * "finds space you can get back" reads as an answer.
 */
export const BOT_THEMES: Record<string, BotTheme> = {
  "sam-research": {
    role: "Checks your sources are still there",
    sigil: "§",
    voice: "Georgia serif, generous measure — a reading room",
  },
  "finance-research": {
    role: "Reads the market before it opens",
    sigil: "$",
    voice: "Geist Mono throughout, tabular figures — a ticker tape",
  },
  "disk-cleanup": {
    role: "Finds space you can get back",
    sigil: "▣",
    voice: "Bahnschrift condensed, wide tracking — a shipping manifest",
  },
  "interface-design": {
    role: "Owns how this page looks",
    sigil: "◐",
    voice: "Geist Sans, tight tracking, air — a specimen sheet",
  },
  "agency-repair": {
    role: "Fixes the Agency when it breaks",
    sigil: "⌇",
    voice: "Consolas, boxed heads, hazard band — a service log",
  },
  "media-bot": {
    role: "Tells you what actually needs you",
    sigil: "◈",
    voice: "Candara humanist, soft rules — a switchboard slip",
  },
};

export const DEFAULT_THEME: BotTheme = {
  role: "Not yet described",
  sigil: "○",
  voice: "House face — this bot has no theme yet",
};

export function themeFor(botId: string): BotTheme {
  return BOT_THEMES[botId] ?? DEFAULT_THEME;
}

/* ------------------------------------------------------- run-report digest */

/** One `**Field** — value` block out of a run report. */
export interface ReportField {
  label: string;
  value: string;
}

export interface ReportDigest {
  /** The `## <bot> — <timestamp>` line, if there was one. */
  heading: string | null;
  status: string | null;
  fields: ReportField[];
  /**
   * The full report, unchanged.
   *
   * Deliberately not "the report minus the digest". An earlier version tracked how
   * many lines it had consumed and returned the remainder, which meant a parser bug
   * could silently *delete* report content from the only place a human reads it.
   * The digest is a summary; showing the field's opening line twice — once in the
   * summary, once inside the collapsed full report — costs nothing and cannot lose
   * anything.
   */
  rest: string;
  /**
   * How many `## ` blocks the report contains.
   *
   * More than one means something was APPENDED after the agent finished — every run
   * script here writes a failure block that way when a later step throws, and
   * `finance-research` appends a queue-refusal block. The reader has to know: the
   * digest shows the first block's fields, and a second block may contradict them.
   */
  blocks: number;
}

/**
 * The five fields every run report is required to carry, in the order the root
 * CLAUDE.md fixes them in. Matching against a known list rather than "any bold
 * label" is what keeps a bolded word inside a paragraph from being promoted into
 * the digest.
 */
const FIELD_ORDER = ["Status", "Did", "Holding", "Failed", "Carry forward"];
const FIELD_RE = /^\*\*([^*]+)\*\*\s*(?:—|--|-|:)\s*(.*)$/;

/**
 * The other form the bots actually use: `### Did` as a heading, with the content
 * in the paragraph below it.
 *
 * Both forms are in this repository right now — `interface-design` writes
 * `**Did** — …` inline and `sam-research` writes `### Did` with prose underneath —
 * and supporting only the inline one meant sam-research's reports fell through to
 * the raw-markdown fallback with a perfectly good Status sitting at the top. The
 * field NAMES are the same in both; only the markup differs, so the parser handles
 * both rather than the format being tightened after the fact.
 *
 * Matched at `##` through `####`, and the name is stripped of trailing punctuation
 * so `### Did:` counts.
 */
const HEADING_FIELD_RE = /^#{2,4}\s+(.+?)\s*:?\s*$/;

/** Markup that starts something new rather than continuing a value. */
const STRUCTURAL = /^(#{1,4}\s|\*\*|\s*[-*+]\s|\s*\d+\.\s|\s*\||\s*>|\s*```|---+\s*$)/;

const BULLET = /^\s*[-*+]\s+(.*)$/;

/**
 * `STRUCTURAL` minus the bold case, for use inside a field's own block.
 *
 * The distinction is real and cost a bug. When absorbing the hard-wrap continuation
 * of an INLINE field (`**Did** — text`), a following `**` line is a new field and
 * must stop the scan. When gathering the block under a LABEL-ONLY field (`### Did`),
 * a `**` line is almost always bold-led prose — sam-research's Did section opens
 * with `**Read fresh, as required:** ...` — and stopping there returned an empty
 * value, so the field was dropped from the digest entirely and the panel showed a
 * report with no Did in it.
 *
 * So inside a block, only a line whose bold label is a KNOWN FIELD NAME ends it.
 * That is `endsBlock` below.
 */
const STRUCTURAL_IN_BLOCK = /^(#{1,4}\s|\s*[-*+]\s|\s*\d+\.\s|\s*\||\s*>|\s*```|---+\s*$)/;

/** A line that starts a new field, and therefore ends the current one's block. */
function endsBlock(line: string): boolean {
  if (STRUCTURAL_IN_BLOCK.test(line)) return true;
  const bold = line.match(/^\*\*([^*]+)\*\*/);
  return Boolean(bold && FIELD_ORDER.includes(bold[1]!.trim()));
}

/**
 * The first block of content after a label-only field, as one line of text.
 *
 * Skips blank lines to find the block, then takes either a paragraph (rejoining its
 * hard wraps) or a bullet list (joined with semicolons). Bullets matter: a `Holding`
 * or `Failed` section is very often nothing BUT a list, and returning empty for
 * those would render "nothing" next to a label whose list says otherwise — the most
 * damaging possible summary of a run.
 *
 * Capped at four items, because this is a summary and the full text is one
 * disclosure away.
 */
function gatherBlock(lines: string[], from: number): string {
  let j = from;
  while (j < lines.length && !lines[j]!.trim()) j++;
  const parts: string[] = [];
  for (; j < lines.length && parts.length < 4; j++) {
    const next = lines[j]!;
    if (!next.trim()) break;
    const b = next.match(BULLET);
    if (b) { parts.push(b[1]!.trim()); continue; }
    if (!endsBlock(next)) {
      // A continuation of whatever is already collected, or the start of a paragraph.
      if (parts.length === 0) parts.push(next.trim());
      else parts[parts.length - 1] += ` ${next.trim()}`;
      continue;
    }
    break;
  }
  return parts.join("; ");
}

/**
 * Pull the run-report header block out of a report.
 *
 * ## Why the panel does this at all
 *
 * The report format is fixed by the root CLAUDE.md and its first six lines answer
 * the only questions you open a panel to ask: did it work, what did it do, what is
 * it waiting on, what broke. Rendering them as ordinary markdown buries them in
 * the same body text as the detail, and the detail is usually twenty times longer.
 *
 * So the digest is lifted out and shown first, and the full report goes behind a
 * disclosure. Nothing is hidden that was not already several screens down.
 *
 * ## What it does when the report does not match
 *
 * Returns `fields: []` and puts the whole thing in `rest`, and the panel then
 * renders it exactly as before. A bot that writes a freeform report — or a failure
 * block appended by a shell script after the agent died — must still be readable.
 * A parser that only works on well-formed input is not usable on the one report
 * you most need to read.
 */
export function digestReport(md: string): ReportDigest {
  const lines = md.split(/\r?\n/);
  const fields: ReportField[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;
  let blocks = 0;

  /** Add a field unless that label has already been seen. First occurrence wins. */
  const add = (label: string, value: string) => {
    if (seen.has(label) || !value) return;
    seen.add(label);
    fields.push({ label, value });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    /**
     * The two LABEL-ONLY forms, which share everything except how the label is
     * spelled: `### Did` and `**Did**` alone on a line, each with the content in
     * the block underneath.
     *
     * All three forms are in this repository today, written by three different
     * bots, and each one that went unsupported meant that bot's reports silently
     * fell through to the raw-markdown fallback:
     *
     *   **Did** — text        interface-design, finance-research
     *   ### Did               sam-research
     *   **Did**               agency-repair
     *
     * They were found one at a time, by running the parser over every report on
     * disk. That check is now `npm run test:digest`, and it is the reason a fourth
     * form will be found in seconds rather than by someone noticing a panel looks
     * plain.
     */
    const hf = line.match(HEADING_FIELD_RE);
    const bf = line.match(/^\*\*([^*]+)\*\*\s*$/);
    const labelOnly = (hf && FIELD_ORDER.includes(hf[1]!.trim()) && hf[1]!.trim())
      || (bf && FIELD_ORDER.includes(bf[1]!.trim()) && bf[1]!.trim());
    if (labelOnly) {
      add(labelOnly, gatherBlock(lines, i + 1));
      continue;
    }

    // A `##` heading that is NOT a field name is a block heading. Checked after the
    // field test so `### Did` is a field and `## sam-research — <stamp>` is a block.
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      blocks++;
      if (heading === null) heading = h[1]!.trim();
      continue;
    }

    const m = line.match(FIELD_RE);
    if (!m || !FIELD_ORDER.includes(m[1]!.trim())) continue;

    const label = m[1]!.trim();
    let value = m[2]!.trim();

    /**
     * Absorb the hard-wrap continuation, and STOP at the first blank line.
     *
     * Two things this gets right that the previous version did not:
     *
     * 1. **Blank lines do not end the scan for fields.** Real reports separate every
     *    field with one, and there is a blank line between the `##` heading and
     *    `**Status**`. Treating a blank as the end of the digest meant every actual
     *    report in this repo produced ZERO fields and silently fell back to raw
     *    markdown — the feature did not work on a single real input, and it took a
     *    screenshot to notice.
     * 2. **A blank line DOES end a value.** `**Did**` in a real report is a
     *    paragraph followed by several more paragraphs and bullet lists that all
     *    belong to it. Swallowing those would put the whole report in the digest,
     *    which is the opposite of the point. The first paragraph is the summary; the
     *    rest is one click away under "Full report".
     */
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) break;
      // Structural markup starts something new, not a continuation.
      if (STRUCTURAL.test(next)) break;
      value += ` ${next.trim()}`;
      i = j;
    }

    // First occurrence wins. A report with an appended failure block carries a
    // second `**Status**`; `blocks` is how the panel warns about that, rather than
    // this quietly picking one of the two.
    add(label, value);
  }

  const status = fields.find((f) => f.label === "Status")?.value ?? null;
  // Sorted into the canonical order rather than the order they appeared. A bot
  // that emits Failed before Holding still reads the same way as every other bot,
  // which is the point of having a fixed format.
  fields.sort((a, b) => FIELD_ORDER.indexOf(a.label) - FIELD_ORDER.indexOf(b.label));

  return {
    heading,
    status,
    fields: fields.filter((f) => f.label !== "Status"),
    rest: md.trim(),
    blocks,
  };
}

/**
 * Trim a digest value to something scannable, on a word boundary.
 *
 * The digest exists to be read at a glance and a real `**Did**` paragraph runs to
 * 400 characters. Truncation is safe here in a way it would not be in the report
 * itself, because the untruncated text is one disclosure away — which is exactly
 * why `rest` carries the whole report rather than the remainder.
 */
export function clampValue(value: string, max = 300): { text: string; clamped: boolean } {
  if (value.length <= max) return { text: value, clamped: false };
  const cut = value.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return { text: `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:.]$/, "")}…`, clamped: true };
}

/**
 * The status word out of a `**Status**` value, normalised to a role.
 *
 * Reports write it as prose — `ok`, `partial — three probes failed`, `failed`. The
 * first word is the state and the rest is commentary, so this takes the first word
 * and returns null for anything not one of the four the format allows. Null means
 * "do not colour this", which is the correct behaviour for an unrecognised value:
 * guessing would put a green tick on a report that said something else.
 */
export function statusRole(value: string | null): "ok" | "partial" | "failed" | "never_run" | null {
  if (!value) return null;
  const word = value.trim().toLowerCase().split(/[\s—:-]+/)[0];
  if (word === "ok") return "ok";
  if (word === "partial") return "partial";
  if (word === "failed") return "failed";
  if (word === "never" || word === "never_run") return "never_run";
  return null;
}
