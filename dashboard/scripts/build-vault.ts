/**
 * Generates `Agency/vault/` — an Obsidian vault that is a map of the Agency.
 *
 *   npm run vault
 *
 * ## Why a generated vault rather than a real one
 *
 * There was no Obsidian vault on this machine when this was written (no
 * `.obsidian` directory anywhere under OneDrive, no `%APPDATA%\obsidian`), so
 * "integrate Obsidian" could not mean "read Benny's notes". What it can mean is
 * the other direction: the Agency is already an Obsidian-shaped corpus — five
 * CLAUDE.md files, run reports, a findings register — and the relationships
 * between those documents are exactly what the studio renders as conduits. This
 * writes those relationships out in Obsidian's own formats so the same graph
 * opens in the app.
 *
 * Two formats, from kepano/obsidian-skills (MIT, vendored into
 * interface-design/.claude/skills/):
 *
 * - **Obsidian Flavored Markdown** — one note per bot, with frontmatter
 *   properties and `[[wikilinks]]` to the bots it references.
 * - **JSON Canvas 1.0** — `Agency.canvas`, laid out to mirror the room's floor
 *   plan, so the canvas and the 3D studio are two views of one arrangement.
 *
 * ## This is a CLI script and deliberately has no endpoint
 *
 * It writes files outside `dashboard/`. The control plane's rule is that a
 * browser button may trigger a run, restore a quarantine batch or revert a repair
 * — all of which put things back or are dry-run-gated — and may not do anything
 * that writes new files into the Agency on a click. Regenerating a vault is
 * harmless and idempotent, but it is still a write outside this project's tree,
 * so it stays where `purge.ps1` stays: at a terminal, run on purpose.
 *
 * Rebuilds are stable: node ids are hashed from bot ids, so re-running does not
 * scatter a canvas you have since rearranged in Obsidian.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { AGENCY_ROOT, BOT_IDS, REGISTRY } from "../server/registry.js";
import { buildGraph, invalidate, type RelevanceGraph } from "../server/relevance.js";

const VAULT = path.join(AGENCY_ROOT, "vault");

/** Canvas layout, in JSON Canvas pixels. Mirrors the room's zones. */
const CANVAS = {
  nodeW: 320,
  nodeH: 140,
  colGap: 400,
  rowGap: 300,
  groupPad: 60,
};

/** Cadence -> canvas row, matching the room's near/mid/back zones. */
const ROW: Record<string, number> = { daily: 0, weekly: 1, "on-demand": 2 };

const ZONE_LABEL: Record<string, string> = {
  daily: "Daily — the near bench",
  weekly: "Weekly — mid room",
  "on-demand": "On demand — the back shelf",
};

/**
 * Deterministic 16-char hex id from a string.
 *
 * JSON Canvas wants 16 lowercase hex characters. FNV-1a twice with different
 * offsets gives 64 bits without pulling in a hash library, and being
 * deterministic is the point: a random id per run would make every rebuild a new
 * node, and Obsidian would forget where you put it.
 */
function canvasId(seed: string): string {
  const fnv = (s: string, h: number) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(seed, 0x811c9dc5);
  const b = fnv(`${seed}:2`, 0x9dc5811c);
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 16);
}

/** YAML-safe scalar. Ids and blurbs are plain text, but do not assume it. */
const yaml = (v: string) => (/^[\w .,'()/—-]+$/.test(v) ? v : JSON.stringify(v));

async function writeFile(rel: string, body: string): Promise<void> {
  const full = path.join(VAULT, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
  console.log(`  ${path.relative(AGENCY_ROOT, full)}`);
}

/* --------------------------------------------------------------- bot notes */

function botNote(id: string, graph: RelevanceGraph): string {
  const def = REGISTRY[id]!;
  const node = graph.nodes.find((n) => n.id === id);

  // Incident edges, heaviest first. This is the same data the conduits render.
  const links = graph.edges
    .filter((e) => e.a === id || e.b === id)
    .map((e) => ({ other: e.a === id ? e.b : e.a, weight: e.weight }))
    .sort((x, y) => y.weight - x.weight);

  const props = [
    "---",
    `bot: ${yaml(id)}`,
    `cadence: ${yaml(def.cadence)}`,
    `scheduled_task: ${def.scheduledTask ? yaml(def.scheduledTask) : "null"}`,
    `triggerable: ${def.triggerScript !== null}`,
    `dry_run_only: ${def.triggerArgs.includes("-DryRun")}`,
    `relevance_degree: ${node?.degree ?? 0}`,
    "tags:",
    "  - agency/bot",
    `  - agency/cadence/${def.cadence}`,
    "---",
  ].join("\n");

  const linkList = links.length
    ? links.map((l) => `- [[${l.other}]] — weight ${l.weight}`).join("\n")
    : "_Nothing in the Agency's markdown references this bot, and it references nothing back. In the studio it has no aura and no conduits._";

  return `${props}

# ${id}

> [!info] ${def.blurb}
> Cadence **${def.cadence}**${def.scheduledTask ? `, scheduled task \`${def.scheduledTask}\`` : ", no scheduled task — interactive only"}.

## Relevance

Derived from the Agency's own markdown by \`dashboard/server/relevance.ts\`: a
wikilink scores 3, a markdown link into another bot's tree scores 2, a bare
mention of its id scores 1, each capped per file. Rendered in the control plane
as the conduits running between docks.

${linkList}

## Where this bot lives

These paths are outside the vault, so they are written as paths rather than as
links — Obsidian resolves neither, and a link that looks live and is not is worse
than plain text.

- Instructions — \`${id}/CLAUDE.md\`
- Run reports — \`${id}/runs/<ISO-date>.md\`
- Ledger — \`${id}/runs/ledger.md\`

## Notes

Anything written below this line is yours; the generator only ever rewrites the
sections above it. It rewrites the whole file, so move notes you want to keep
into a separate note and link them.
`;
}

/* ------------------------------------------------------------------ canvas */

function buildCanvas(graph: RelevanceGraph): string {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];

  // Group bots by row so each zone can be centred like the room's docks are.
  const byRow = new Map<number, string[]>();
  for (const id of BOT_IDS) {
    const row = ROW[REGISTRY[id]!.cadence] ?? 0;
    const list = byRow.get(row) ?? [];
    list.push(id);
    byRow.set(row, list);
  }

  const pos = new Map<string, { x: number; y: number }>();

  for (const [row, ids] of [...byRow].sort((a, b) => a[0] - b[0])) {
    ids.sort((a, b) => REGISTRY[a]!.orbitRadius - REGISTRY[b]!.orbitRadius);
    const span = (ids.length - 1) * CANVAS.colGap;
    ids.forEach((id, i) => {
      pos.set(id, { x: -span / 2 + i * CANVAS.colGap, y: row * CANVAS.rowGap });
    });

    // A group per zone, sized to its members. Drawn before the file nodes so it
    // sits underneath them: JSON Canvas z-order is array order.
    const xs = ids.map((id) => pos.get(id)!.x);
    const minX = Math.min(...xs) - CANVAS.groupPad;
    const maxX = Math.max(...xs) + CANVAS.nodeW + CANVAS.groupPad;
    const cadence = REGISTRY[ids[0]!]!.cadence;
    nodes.push({
      id: canvasId(`zone:${cadence}`),
      type: "group",
      x: Math.round(minX),
      y: Math.round(row * CANVAS.rowGap - CANVAS.groupPad),
      width: Math.round(maxX - minX),
      height: CANVAS.nodeH + CANVAS.groupPad * 2,
      label: ZONE_LABEL[cadence] ?? cadence,
    });
  }

  for (const id of BOT_IDS) {
    const p = pos.get(id)!;
    nodes.push({
      id: canvasId(`bot:${id}`),
      type: "file",
      file: `Bots/${id}.md`,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: CANVAS.nodeW,
      height: CANVAS.nodeH,
    });
  }

  for (const e of graph.edges) {
    edges.push({
      id: canvasId(`edge:${e.a}:${e.b}`),
      fromNode: canvasId(`bot:${e.forward ? e.a : e.b}`),
      toNode: canvasId(`bot:${e.forward ? e.b : e.a}`),
      toEnd: "arrow",
      label: String(e.weight),
    });
  }

  return `${JSON.stringify({ nodes, edges }, null, 2)}\n`;
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  // The graph is cached for a minute behind the API. A build must never write a
  // vault that disagrees with the files it was just asked to describe.
  invalidate();
  const graph = await buildGraph([...BOT_IDS]);

  console.log(`relevance: ${graph.edges.length} edges from ${graph.sources} markdown files`);
  await fs.mkdir(VAULT, { recursive: true });

  // Minimal vault config. Enough for Obsidian to open the folder without its
  // first-run wizard, and no theme or plugin choices — those are Benny's.
  await writeFile(".obsidian/app.json", `${JSON.stringify({ attachmentFolderPath: "Attachments", newLinkFormat: "shortest", useMarkdownLinks: false }, null, 2)}\n`);
  await writeFile(".obsidian/appearance.json", `${JSON.stringify({ baseFontSize: 16 }, null, 2)}\n`);
  await writeFile(
    ".obsidian/graph.json",
    `${JSON.stringify({ showTags: true, showAttachments: false, showOrphans: true, nodeSizeMultiplier: 1.4, lineSizeMultiplier: 1.2 }, null, 2)}\n`,
  );

  for (const id of BOT_IDS) await writeFile(`Bots/${id}.md`, botNote(id, graph));
  await writeFile("Agency.canvas", buildCanvas(graph));

  const rows = BOT_IDS.map((id) => {
    const def = REGISTRY[id]!;
    const deg = graph.nodes.find((n) => n.id === id)?.degree ?? 0;
    return `| [[${id}]] | ${def.cadence} | ${deg} |`;
  }).join("\n");

  await writeFile(
    "Agency.md",
    `---
generated_by: dashboard/scripts/build-vault.ts
generated_at: ${graph.generatedAt}
markdown_sources: ${graph.sources}
tags:
  - agency
---

# The Agency

An Obsidian view of the bots in \`${path.basename(AGENCY_ROOT)}\`. **Generated —
\`npm run vault\` in \`dashboard/\` rewrites every file here.**

Open \`[[Agency.canvas]]\` for the floor plan, or the graph view for the same
edges the control plane draws as light between docks.

| Bot | Cadence | Relevance degree |
| --- | --- | --- |
${rows}

## What the numbers mean

**Relevance degree** is the sum of the weights of every edge touching that bot.
It is not a quality score and not a measure of how much work the bot does — a bot
can run daily and be referenced by nothing. It measures how entangled its
documentation is with its siblings', which is why \`agency-repair\` scores highly:
its job is to read the others.

## What is not in here

Run status, token spend and next-run times are deliberately absent. They change
every few minutes and live in the control plane, which reads them from
\`runs/ledger.md\` and the Windows scheduler at the moment you look. A vault note
claiming a status would be wrong within the hour.
`,
  );

  console.log(`\nvault written to ${VAULT}`);
  console.log("open it in Obsidian with:  Open folder as vault");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
