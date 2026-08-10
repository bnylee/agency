/**
 * The relevance graph: which bots actually reference each other.
 *
 * This is what the studio's conduits and auras render, and it is the reason
 * either of them is allowed to exist — interaction-thesis.md's rule is that a
 * visual channel has to decode back into a fact, and "these two bots' documents
 * talk about each other this much" is a fact you can count.
 *
 * ## What counts as a reference, and what it is worth
 *
 * Scanning bot A's markdown for mentions of bot B, three forms score differently
 * because they mean different things:
 *
 *   [[B]]        3   an Obsidian wikilink — an explicit, deliberate link
 *   ](B/...)     2   a markdown link to B's tree — deliberate, but structural
 *   B            1   a bare mention of the id — B came up, in prose
 *
 * Each form is capped per file. Without that, one document that says
 * `disk-cleanup` fourteen times outweighs every genuine link in the Agency, and
 * the graph stops describing relationships and starts describing verbosity.
 *
 * ## What is deliberately NOT scanned
 *
 * - **The root CLAUDE.md.** Its bot registry names every bot by definition, so
 *   including it yields a complete graph with equal weights — five edges of
 *   identical strength, carrying no information at all. The first version of this
 *   did include it and the room lit up like a fully-connected mesh, which looked
 *   impressive and said nothing.
 * - **Any dot-directory.** `interface-design/.claude/skills/` holds ten vendored
 *   skill packs of third-party markdown. It is not the Agency talking about
 *   itself and it dwarfs everything that is.
 * - **`node_modules`, `.venv`, `dist`.** For the obvious reason.
 * - **`Agency/vault/`.** Not reachable from here (only bot directories are
 *   walked), and that is load-bearing: the vault is *generated from this graph*
 *   and is dense with wikilinks between bots. Scanning it would feed the output
 *   back into the input, and every rebuild would strengthen every edge.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { AGENCY_ROOT } from "./registry.js";

export interface RelevanceEdge {
  a: string;
  b: string;
  weight: number;
  /** True when a -> b is the heavier direction. Drives the conduit's flow. */
  forward: boolean;
}

export interface RelevanceGraph {
  nodes: { id: string; degree: number }[];
  edges: RelevanceEdge[];
  maxWeight: number;
  maxDegree: number;
  /** How many markdown files the graph was derived from. */
  sources: number;
  generatedAt: string;
}

const W_WIKILINK = 3;
const W_MDLINK = 2;
const W_MENTION = 1;

/** Per-file caps, so one wordy document cannot dominate the graph. */
const CAP_WIKILINK = 4;
const CAP_MDLINK = 4;
const CAP_MENTION = 6;

/** Walk limits. A bot tree is small; these exist so a mistake stays cheap. */
const MAX_DEPTH = 4;
const MAX_FILES_PER_BOT = 120;
const MAX_BYTES_PER_FILE = 512 * 1024;

const SKIP_DIRS = new Set(["node_modules", ".venv", "dist", "__pycache__", "tools"]);

/**
 * Collect a bot's own markdown.
 *
 * Depth-first with a cap. Dot-directories are skipped by prefix rather than by
 * name so a future `.anything` is excluded without this list needing an edit.
 */
async function collectMarkdown(botId: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES_PER_BOT) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES_PER_BOT) return;
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }

  await walk(path.join(AGENCY_ROOT, botId), 0);
  return files;
}

/** Escape a bot id for use in a RegExp. Ids are `[a-z-]` today; do not assume. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Score how much `text` refers to `target`.
 *
 * The mention pattern is bounded by non-word characters rather than `\b`,
 * because `\b` treats the hyphen in `disk-cleanup` as a boundary: `\bdisk\b`
 * would match inside it, and every hyphenated id would score against every other
 * id sharing a word. Hyphens are also excluded from the surrounding character
 * class so `security-watch-daily` does not count as a mention of a bot named
 * `security-watch`.
 */
export function score(text: string, target: string): number {
  const id = escape(target);

  const wiki = text.match(new RegExp(`\\[\\[${id}(?:\\|[^\\]]*)?\\]\\]`, "g"))?.length ?? 0;
  const mdlink = text.match(new RegExp(`\\]\\((?:\\.\\.\\/)?${id}\\/`, "g"))?.length ?? 0;
  const mention = text.match(new RegExp(`(?<![\\w-])${id}(?![\\w-])`, "g"))?.length ?? 0;

  // Wikilinks and markdown links also match the bare-mention pattern, so their
  // counts are subtracted out. Without this a single wikilink scores 3 + 1.
  const bare = Math.max(0, mention - wiki - mdlink);

  return (
    Math.min(wiki, CAP_WIKILINK) * W_WIKILINK +
    Math.min(mdlink, CAP_MDLINK) * W_MDLINK +
    Math.min(bare, CAP_MENTION) * W_MENTION
  );
}

/**
 * Cached for a minute.
 *
 * The scene polls every ten seconds and this walks five directory trees to build
 * an answer that changes when a bot writes a run report — which is to say,
 * daily. Re-deriving it on every poll would be six times the file I/O for the
 * same bytes.
 */
const TTL_MS = 60_000;
let cache: { at: number; graph: RelevanceGraph } | null = null;

export async function buildGraph(botIds: string[]): Promise<RelevanceGraph> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.graph;

  /** directed[a][b] = how much A's documents refer to B. */
  const directed = new Map<string, Map<string, number>>();
  for (const id of botIds) directed.set(id, new Map());

  let sources = 0;

  for (const a of botIds) {
    const files = await collectMarkdown(a);
    for (const file of files) {
      let text: string;
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES_PER_FILE) continue;
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      sources++;
      for (const b of botIds) {
        if (a === b) continue;
        const s = score(text, b);
        if (s > 0) {
          const row = directed.get(a)!;
          row.set(b, (row.get(b) ?? 0) + s);
        }
      }
    }
  }

  // Symmetrise. An edge is one relationship seen from two ends, and the heavier
  // end sets the flow direction — which is a real reading: agency-repair writes
  // about disk-cleanup far more than the reverse, and the conduit should run the
  // way the attention runs.
  const edges: RelevanceEdge[] = [];
  const degree = new Map<string, number>();
  for (const id of botIds) degree.set(id, 0);

  for (let i = 0; i < botIds.length; i++) {
    for (let j = i + 1; j < botIds.length; j++) {
      const a = botIds[i]!;
      const b = botIds[j]!;
      const ab = directed.get(a)?.get(b) ?? 0;
      const ba = directed.get(b)?.get(a) ?? 0;
      const weight = ab + ba;
      if (weight <= 0) continue;
      edges.push({ a, b, weight, forward: ab >= ba });
      degree.set(a, (degree.get(a) ?? 0) + weight);
      degree.set(b, (degree.get(b) ?? 0) + weight);
    }
  }

  const nodes = botIds.map((id) => ({ id, degree: degree.get(id) ?? 0 }));
  const graph: RelevanceGraph = {
    nodes,
    edges: edges.sort((x, y) => y.weight - x.weight),
    maxWeight: edges.reduce((m, e) => Math.max(m, e.weight), 0),
    maxDegree: nodes.reduce((m, n) => Math.max(m, n.degree), 0),
    sources,
    generatedAt: new Date().toISOString(),
  };

  cache = { at: Date.now(), graph };
  return graph;
}

/** Drop the cache. Used by the vault builder so it never writes stale edges. */
export function invalidate(): void {
  cache = null;
}
