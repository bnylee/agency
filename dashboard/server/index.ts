import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AGENCY_ROOT, BOT_IDS, QUARANTINE_ROOT, REGISTRY, resolveBot } from "./registry.js";
import { buildGraph } from "./relevance.js";

const HOST = process.env.AGENCY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AGENCY_PORT ?? 7777);
const TOKEN = process.env.AGENCY_TOKEN ?? "";

/* ------------------------------------------------------------------ guards */

// This process can start PowerShell. Binding it anywhere but loopback would
// hand that to the network, so refusing is correct even though it is annoying.
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK.has(HOST)) {
  console.error(`refusing to bind ${HOST}: this API executes local scripts and is loopback-only`);
  process.exit(1);
}
if (!TOKEN || TOKEN === "replace-me") {
  console.error("AGENCY_TOKEN is unset. Copy .env.example to .env and set a real value.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.disable("x-powered-by");

/** Second lock behind the bind: even on loopback, verify the peer address. */
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (!LOOPBACK.has(ip)) {
    res.status(403).json({ error: "loopback only" });
    return;
  }
  next();
});

/**
 * Token arrives as a header, never a cookie. The browser attaches cookies to
 * cross-site requests automatically; it will not attach a custom header without
 * a CORS preflight this server never approves. That asymmetry is the CSRF
 * defence, and it is why no cookie path exists.
 */
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const supplied = req.header("x-agency-token") ?? "";
  if (supplied.length !== TOKEN.length || !timingSafeEqual(supplied, TOKEN)) {
    res.status(401).json({ error: "bad or missing x-agency-token" });
    return;
  }
  next();
});

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------- bot readers */

interface LedgerRow { date: string; status: string; tokens: string }

async function readLedger(botId: string): Promise<LedgerRow[]> {
  const file = path.join(AGENCY_ROOT, botId, "runs", "ledger.md");
  let text: string;
  try { text = await fs.readFile(file, "utf8"); } catch { return []; }
  const rows: LedgerRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]*)\|([^|]*)\|/);
    if (m) rows.push({ date: m[1]!, status: m[2]!.trim(), tokens: m[3]!.trim() });
  }
  return rows;
}

async function listRuns(botId: string): Promise<string[]> {
  const dir = path.join(AGENCY_ROOT, botId, "runs");
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".md") && ISO_DATE.test(f.slice(0, 10)))
      .map((f) => f.replace(/\.md$/, ""))
      .sort()
      .reverse();
  } catch { return []; }
}

/** Approximate token spend from a ledger cell like "~55k" or "~28k". */
function parseTokens(cell: string): number {
  const m = cell.match(/([\d.]+)\s*([km])?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2]?.toLowerCase();
  return unit === "m" ? n * 1_000_000 : unit === "k" ? n * 1_000 : n;
}

/** Normalise a ledger status cell to one of the reserved status roles. */
function normaliseStatus(raw: string | undefined): string {
  if (!raw) return "never_run";
  const s = raw.toLowerCase();
  if (s.startsWith("ok")) return "ok";
  if (s.startsWith("partial")) return "partial";
  if (s.startsWith("fail")) return "failed";
  return "never_run";
}

/* ------------------------------------------------------- scheduled tasks */

interface TaskInfo { name: string; nextRun: string | null; lastRun: string | null; state: string | null }

/**
 * Fixed command string with no interpolated input. Kept as -Command rather than
 * a script file because it is a pure read and there is nothing user-supplied in
 * it; if that ever changes it must move to a file with array args.
 */
// Dates are forced to ISO-8601 strings here. PowerShell's ConvertTo-Json emits
// DateTime in .NET's "/Date(1786280400000)/" form, which `new Date()` parses as
// Invalid Date -- that would have silently broken the time-until-next-run
// binding, which is the whole point of the scene, while every endpoint still
// returned 200. (That binding was the orbital angle when this was written; it is
// the floor dial's hand now. Same date, same failure.)
// Task names come from the registry rather than a second hardcoded list. The
// two drifted apart the moment a fifth bot was added: the registry knew about
// agency-repair-daily and this query did not, so its next-run time came back
// null and its body parked at the fallback angle -- a wrong reading, with every
// endpoint still returning 200. One source or none.
//
// Registry values are trusted code, not request input, but the names are being
// interpolated into a command string, so they are shape-checked anyway. A name
// that cannot pass this is a typo worth failing loudly on.
const SAFE_TASK_NAME = /^[A-Za-z0-9_-]+$/;
const TRACKED_TASKS = Object.values(REGISTRY)
  .map((b) => b.scheduledTask)
  .filter((t): t is string => t !== null);

for (const name of TRACKED_TASKS) {
  if (!SAFE_TASK_NAME.test(name)) {
    console.error(`registry scheduledTask ${JSON.stringify(name)} is not a bare task name`);
    process.exit(1);
  }
}

const TASK_QUERY = `Get-ScheduledTask | Where-Object { $_.TaskName -in @(${TRACKED_TASKS.map((t) => `'${t}'`).join(",")}) } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; nextRun=$(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }); lastRun=$(if ($i.LastRunTime) { $i.LastRunTime.ToString('o') } else { $null }) } } | ConvertTo-Json -Compress`;

async function readScheduledTasks(): Promise<Record<string, TaskInfo>> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", TASK_QUERY], { shell: false });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({}));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim() || "[]");
        const arr: TaskInfo[] = Array.isArray(parsed) ? parsed : [parsed];
        const map: Record<string, TaskInfo> = {};
        for (const t of arr) if (t?.name) map[t.name] = t;
        resolve(map);
      } catch { resolve({}); }
    });
  });
}

/* ----------------------------------------------------------- run tracking */

const running = new Set<string>();
const lastTrigger = new Map<string, number>();
const TRIGGER_COOLDOWN_MS = 30_000;

/* -------------------------------------------------------------- endpoints */

app.get("/api/bots", async (_req, res) => {
  const tasks = await readScheduledTasks();
  const bots = await Promise.all(
    BOT_IDS.map(async (id) => {
      const def = REGISTRY[id]!;
      const ledger = await readLedger(id);
      const latest = ledger.at(-1);
      const task = def.scheduledTask ? tasks[def.scheduledTask] : undefined;
      return {
        id,
        name: def.name,
        blurb: def.blurb,
        cadence: def.cadence,
        orbitRadius: def.orbitRadius,
        triggerable: def.triggerScript !== null,
        dryRunOnly: def.triggerArgs.includes("-DryRun"),
        status: running.has(id) ? "running" : normaliseStatus(latest?.status),
        statusDetail: latest?.status ?? null,
        lastRunDate: latest?.date ?? null,
        runCount: ledger.length,
        totalTokens: ledger.reduce((a, r) => a + parseTokens(r.tokens), 0),
        tokenSeries: ledger.map((r) => ({ date: r.date, tokens: parseTokens(r.tokens) })),
        nextRun: task?.nextRun ?? null,
      };
    }),
  );
  res.json({ bots, generatedAt: new Date().toISOString() });
});

app.get("/api/bots/:id/runs", async (req, res) => {
  const bot = resolveBot(req.params.id);
  if (!bot) { res.status(400).json({ error: "unknown bot" }); return; }
  res.json({ runs: await listRuns(bot.id) });
});

app.get("/api/bots/:id/runs/:date", async (req, res) => {
  const bot = resolveBot(req.params.id);
  if (!bot) { res.status(400).json({ error: "unknown bot" }); return; }
  const date = req.params.date;
  // Shape-check before the path is built, so no traversal sequence is ever
  // joined onto a real directory in the first place.
  if (!ISO_DATE.test(date)) { res.status(400).json({ error: "bad date" }); return; }
  try {
    const body = await fs.readFile(path.join(AGENCY_ROOT, bot.id, "runs", `${date}.md`), "utf8");
    res.json({ id: bot.id, date, body });
  } catch { res.status(404).json({ error: "no such report" }); }
});

/**
 * The standalone HTML page a run rendered, if it rendered one.
 *
 * Returned as JSON carrying the markup rather than served as `text/html`, and that
 * is deliberate. Two reasons:
 *
 *  - **The token lives in a header, never a cookie**, which is this server's whole
 *    CSRF defence. A browser opening `…/page` in a new tab sends no custom header,
 *    so a `text/html` endpoint would either have to accept a token in the query
 *    string — putting a credential in history and in the referer — or be
 *    unauthenticated. Neither is acceptable for an API that starts PowerShell.
 *  - Keeping every response JSON means one code path in the client and one
 *    content-type this server ever emits.
 *
 * The client turns it into a Blob and opens that. The page has no scripts and no
 * remote URLs by construction (see the renderer at
 * `.claude/skills/live-artifact/render.mjs`), so a blob tab can do nothing except
 * display it.
 */
app.get("/api/bots/:id/runs/:date/page", async (req, res) => {
  const bot = resolveBot(req.params.id);
  if (!bot) { res.status(400).json({ error: "unknown bot" }); return; }
  const date = req.params.date;
  // Shape-checked before the path is built, so no traversal sequence is ever
  // joined onto a real directory.
  if (!ISO_DATE.test(date)) { res.status(400).json({ error: "bad date" }); return; }
  try {
    const html = await fs.readFile(path.join(AGENCY_ROOT, bot.id, "runs", `${date}.html`), "utf8");
    res.json({ id: bot.id, date, html });
  } catch { res.status(404).json({ error: "this run rendered no page" }); }
});

/**
 * media-bot's digest and its trash bin.
 *
 * Read straight off disk and reshaped, with one rule: **no count is recomputed
 * here.** `summary` comes from the digest exactly as `classify.py` wrote it, for
 * the same reason the portfolio endpoint does not recompute the broker's dollars —
 * two implementations of the same arithmetic in two languages is how two sources of
 * truth start disagreeing, and here they would disagree about whether something
 * needs attention today.
 *
 * Message bodies are never in the digest to begin with (the collector does not
 * fetch them), so there is nothing to redact. Senders and subjects are.
 */
app.get("/api/media", async (_req, res) => {
  const stateDir = path.join(AGENCY_ROOT, "media-bot", "state");
  let digest: any;
  try {
    digest = JSON.parse(await fs.readFile(path.join(stateDir, "collect-latest.json"), "utf8"));
  } catch {
    res.status(404).json({ error: "media-bot has not collected anything yet" });
    return;
  }
  let bin: any = { batches: [] };
  try {
    bin = JSON.parse(await fs.readFile(path.join(stateDir, "trash-bin.json"), "utf8"));
  } catch { /* an empty bin is the normal state before the first live run */ }

  res.json({
    generatedAt: digest.generated_at ?? null,
    status: digest.status ?? "ok",
    summary: digest.summary ?? {},
    // Capped for transport. The panel shows the ones that matter and the run report
    // is the complete record; shipping 120 message objects to render 20 rows is
    // waste on a poll that runs every ten seconds.
    feed: (digest.feed ?? []).slice(0, 60),
    calendar: (digest.calendar ?? []).slice(0, 60),
    tasks: (digest.tasks ?? []).slice(0, 60),
    providers: (digest.providers ?? []).map((p: any) => ({
      provider: p.provider, status: p.status, note: p.note ?? null, error: p.error ?? null,
      counts: p.counts ?? {},
    })),
    trash: {
      // Newest first: the batch you might want to undo is the one just staged.
      batches: (bin.batches ?? [])
        .slice()
        .sort((a: any, b: any) => String(b.batch_id).localeCompare(String(a.batch_id)))
        .map((b: any) => ({
          batchId: b.batch_id, stagedAt: b.staged_at ?? null, count: b.count ?? 0,
          restoredAt: b.restored_at ?? null,
          problems: (b.problems ?? []).length,
          messages: (b.messages ?? []).slice(0, 40),
        })),
    },
    disclaimer: digest.disclaimer ?? "",
    // Stated by the server rather than inferred by the client, because "there is no
    // restore endpoint" is a boundary and boundaries belong next to the code that
    // enforces them.
    note: "Read-only. Staging and restoring the trash bin are terminal operations: "
      + "python scripts\\triage.py stage|restore in media-bot/. There is no HTTP endpoint for either, "
      + "because both touch a real mailbox.",
  });
});

app.get("/api/quarantine", async (_req, res) => {
  const batches: unknown[] = [];
  try {
    for (const entry of await fs.readdir(QUARANTINE_ROOT)) {
      if (!ISO_DATE.test(entry)) continue;
      try {
        const raw = await fs.readFile(path.join(QUARANTINE_ROOT, entry, "manifest.json"), "utf8");
        const m = JSON.parse(raw);
        batches.push({
          batchId: entry,
          stagedCount: m.staged_count ?? 0,
          stagedGb: m.staged_gb ?? 0,
          dryRun: Boolean(m.dry_run),
          heldCount: Array.isArray(m.held) ? m.held.length : 0,
          rejectedCount: Array.isArray(m.rejected) ? m.rejected.length : 0,
          generatedAt: m.generated_at ?? null,
        });
      } catch { /* a batch without a readable manifest is not a batch */ }
    }
  } catch { /* quarantine root may not exist yet; empty list is correct */ }
  res.json({ batches, note: "Staged bytes are PENDING, not reclaimed. Purge is terminal-only and has no endpoint." });
});

app.get("/api/overview", async (_req, res) => {
  const readJson = async (p: string) => {
    try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
  };
  const scan = await readJson(path.join(AGENCY_ROOT, "disk-cleanup", "state", "scan-summary.json"));
  const installed = await readJson(path.join(AGENCY_ROOT, "disk-cleanup", "state", "installed-latest.json"));
  const dupes = await readJson(path.join(AGENCY_ROOT, "disk-cleanup", "state", "dupes-latest.json"));
  res.json({
    volume: scan?.volume ?? null,
    reclaimableGb: scan?.candidate_total_gb ?? null,
    byCategory: scan?.by_category ?? [],
    installedGb: installed?.total_gb ?? null,
    coldSteamGb: installed?.cold_steam_gb ?? null,
    coldSteamCount: installed?.cold_steam_count ?? null,
    duplicateGb: dupes?.wasted_gb ?? null,
    topInstalled: (installed?.entries ?? []).slice(0, 8),
    reportOnly: scan?.report_only ?? null,
  });
});

/**
 * finance-research's paper account. Read straight off disk and reshaped for the
 * panel; nothing here computes a number the broker did not already compute.
 * Duplicating that arithmetic in a second language is how two sources of truth
 * start disagreeing about what the account is worth.
 */
app.get("/api/portfolio", async (_req, res) => {
  const file = path.join(AGENCY_ROOT, "finance-research", "state", "portfolio.json");
  let pf: any;
  try {
    pf = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    res.status(404).json({ error: "no paper account yet" });
    return;
  }

  const curve: any[] = Array.isArray(pf.equity_curve) ? pf.equity_curve : [];
  const latest = curve.at(-1) ?? null;
  const equity = latest?.equity ?? pf.cash ?? 0;
  const bench = latest?.benchmark_equity ?? null;
  const start = pf.starting_cash || 1;

  res.json({
    disclaimer: pf.disclaimer ?? "Simulated account. No brokerage is connected.",
    openedAt: pf.opened_at ?? null,
    startingCash: pf.starting_cash ?? null,
    cash: pf.cash ?? 0,
    equity,
    // Percentages are derived here because they are pure presentation. Every
    // dollar figure above comes from the ledger untouched.
    totalReturnPct: (equity / start - 1) * 100,
    benchmarkEquity: bench,
    benchmarkReturnPct: bench === null ? null : (bench / start - 1) * 100,
    realizedPnl: pf.realized_pnl ?? 0,
    dividends: pf.dividends_received ?? 0,
    lastSettled: pf.last_settled_session ?? null,
    positions: Object.entries(pf.positions ?? {}).map(([symbol, p]: [string, any]) => ({
      symbol,
      shares: p.shares,
      avgCost: p.avg_cost,
      stop: p.stop ?? null,
      target: p.target ?? null,
      conviction: p.conviction ?? null,
      openedAt: p.opened_at ?? null,
      thesis: p.thesis ?? "",
    })),
    pending: (pf.pending_orders ?? []).map((o: any) => ({
      symbol: o.symbol, side: o.side, shares: o.shares,
      forSession: o.for_session, limit: o.limit ?? null,
      stop: o.stop ?? null, target: o.target ?? null, conviction: o.conviction ?? null,
    })),
    closed: (pf.closed_trades ?? []).slice(-15).reverse(),
    curve: curve.slice(-120),
    limits: pf.limits ?? {},
  });
});

/**
 * agency-repair's snapshot batches, and the endpoint that puts one back.
 *
 * Revert exists here and purge deliberately does not, and the difference is the
 * whole rule: this restores files the bot changed, from copies it took first,
 * and nothing is destroyed either way. A created file is moved aside, not
 * deleted. That is safe to expose to a browser button; permanent deletion is
 * not, which is why it stays at a terminal.
 */
app.get("/api/repairs", async (_req, res) => {
  const root = path.join(AGENCY_ROOT, "agency-repair", "repairs");
  const batches: unknown[] = [];
  try {
    for (const entry of await fs.readdir(root)) {
      if (!ISO_DATE.test(entry)) continue;
      try {
        const m = JSON.parse(await fs.readFile(path.join(root, entry, "manifest.json"), "utf8"));
        const entries = Object.entries(m.entries ?? {});
        batches.push({
          batchId: entry,
          fileCount: entries.length,
          modified: entries.filter(([, v]: [string, any]) => v.action === "modified").length,
          created: entries.filter(([, v]: [string, any]) => v.action === "created").length,
          files: entries.map(([k, v]: [string, any]) => ({ path: k, action: v.action })),
          revertedAt: m.reverted_at ?? null,
          updatedAt: m.updated_at ?? null,
        });
      } catch { /* a batch without a readable manifest is not a batch */ }
    }
  } catch { /* no repairs yet; empty list is correct */ }
  batches.sort((a: any, b: any) => (a.batchId < b.batchId ? 1 : -1));
  res.json({ batches, note: "Reverting restores snapshots taken before each edit. Nothing is deleted." });
});

/* --------------------------------------------------------- repair requests */

/**
 * The human's channel back to agency-repair.
 *
 * The panel already shows what each bot is **Holding** — the things it drafted
 * and needs a person to decide. This is the inverse: the things a person has
 * noticed and wants the repair bot to look at. Without it the only way to hand
 * the bot a job is to open a terminal and start an interactive session, which
 * is exactly the gap the control plane exists to close.
 *
 * **This is the one endpoint that writes a new file into the Agency on a click,
 * and the carve-out is deliberate and narrow.** The rule it bends — stated on
 * the vault endpoint, which is still refused — is that a browser button may
 * trigger a run, restore a quarantine batch or revert a repair, and may not
 * write into the Agency. What makes this different is what it can write:
 *
 * - **One hardcoded path.** `agency-repair/state/requests.json`, never derived
 *   from anything in the request. There is no filename parameter to traverse.
 * - **Inert data.** The text is stored as a JSON string and read back as one.
 *   It never becomes a path, an argument, or a command line — `spawn` is not
 *   involved anywhere in this route.
 * - **Bounded.** 2,000 characters per request, 200 open requests, and the file
 *   is rewritten whole rather than appended to, so it cannot grow without limit.
 *
 * What it cannot do is more important than what it can. A request is a note
 * asking for something; it is not authority to do it. Every mechanical limit on
 * agency-repair still binds when it acts on one — the Tier A cap of 12 files and
 * 400 lines, the deny rules that keep it out of sibling bots, `.claude/`
 * directories, CLAUDE.md files and lockfiles, and its PreToolUse hooks. A
 * request that asks for something outside those is refused by the hook, not by
 * the model's good judgement, and the run reports the refusal.
 */
const REQUESTS_FILE = path.join(AGENCY_ROOT, "agency-repair", "state", "requests.json");
const MAX_REQUEST_CHARS = 2000;
const MAX_OPEN_REQUESTS = 200;

interface RepairRequest {
  id: string;
  text: string;
  createdAt: string;
  status: "open" | "closed";
  closedAt: string | null;
  /** Which run, if any, has picked this up. Written by the bot, not by here. */
  pickedUpBy: string | null;
}

async function readRequests(): Promise<RepairRequest[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(REQUESTS_FILE, "utf8"));
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch {
    // No file yet, or a file the bot has mangled. An empty queue is the right
    // reading of both: this endpoint's job is to add to a queue, not to be the
    // authority on one it cannot parse.
    return [];
  }
}

async function writeRequests(requests: RepairRequest[]): Promise<void> {
  const body = {
    schema: 1,
    _comment:
      "Repair requests typed into the control plane. agency-repair reads this at the " +
      "start of each run, addresses what it can inside its Tier A limits, and reports " +
      "on every entry. A request is a note asking for something, not authority to do " +
      "it -- the deny rules and PreToolUse hooks still decide what is possible.",
    updatedAt: new Date().toISOString(),
    requests,
  };
  await fs.mkdir(path.dirname(REQUESTS_FILE), { recursive: true });
  // Write-then-rename, so a reader never sees a half-written file. The bot polls
  // this at the start of a run and the panel polls it every 10 seconds; a torn
  // read would be rare, silent, and impossible to reproduce.
  const tmp = `${REQUESTS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
  await fs.rename(tmp, REQUESTS_FILE);
}

/**
 * Serialise read-modify-write. Two submissions a few milliseconds apart would
 * otherwise both read the same array and the second would silently discard the
 * first — the kind of lost update that only shows up as "I typed that and it
 * vanished" and never reproduces on demand.
 */
let requestQueue: Promise<unknown> = Promise.resolve();
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = requestQueue.then(work, work);
  requestQueue = next.catch(() => undefined);
  return next;
}

app.get("/api/repairs/requests", async (_req, res) => {
  const requests = await readRequests();
  res.json({
    requests,
    limits: { maxChars: MAX_REQUEST_CHARS, maxOpen: MAX_OPEN_REQUESTS },
    note:
      "agency-repair reads these at the start of its next run. A request is not " +
      "authority — its Tier A caps, deny rules and hooks still apply, and it reports " +
      "anything it had to refuse.",
  });
});

app.post("/api/repairs/requests", async (req, res) => {
  const raw = (req.body as { text?: unknown } | undefined)?.text;
  if (typeof raw !== "string") { res.status(400).json({ error: "text must be a string" }); return; }
  const text = raw.trim();
  if (!text) { res.status(400).json({ error: "text is empty" }); return; }
  if (text.length > MAX_REQUEST_CHARS) {
    res.status(400).json({ error: `text is ${text.length} characters, over the ${MAX_REQUEST_CHARS} limit` });
    return;
  }

  try {
    const created = await serialised(async () => {
      const requests = await readRequests();
      if (requests.filter((r) => r.status === "open").length >= MAX_OPEN_REQUESTS) {
        throw new Error(`${MAX_OPEN_REQUESTS} open requests already — close some first`);
      }
      const entry: RepairRequest = {
        id: randomUUID(),
        text,
        createdAt: new Date().toISOString(),
        status: "open",
        closedAt: null,
        pickedUpBy: null,
      };
      // Newest first: the panel renders in array order and the thing you just
      // typed should be the thing you can see.
      await writeRequests([entry, ...requests]);
      return entry;
    });
    res.json({ request: created });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/repairs/requests/:id/close", async (req, res) => {
  const id = req.params.id;
  // Shape-checked for the same reason every other id on this server is, even
  // though nothing here builds a path from it. Consistency is cheaper than
  // remembering which routes are exempt.
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) { res.status(400).json({ error: "bad request id" }); return; }
  const closed = await serialised(async () => {
    const requests = await readRequests();
    const target = requests.find((r) => r.id === id);
    if (!target) return null;
    target.status = "closed";
    target.closedAt = new Date().toISOString();
    await writeRequests(requests);
    return target;
  });
  if (!closed) { res.status(404).json({ error: "no such request" }); return; }
  res.json({ request: closed });
});

app.post("/api/repairs/:batch/revert", async (req, res) => {
  const batch = req.params.batch;
  // Shape-checked before the path is built, exactly as the report and
  // quarantine routes do, so no traversal sequence is ever joined to a real
  // directory. revert.ps1 re-checks it too; neither check trusts the other.
  if (!ISO_DATE.test(batch)) { res.status(400).json({ error: "bad batch id" }); return; }
  const script = path.join(AGENCY_ROOT, "agency-repair", "scripts", "revert.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-BatchId", batch],
    { shell: false, cwd: path.join(AGENCY_ROOT, "agency-repair") },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => res.json({ batch, exitCode: code, output: out.trim() }));
  child.on("error", (e) => res.status(500).json({ error: String(e) }));
});

app.post("/api/bots/:id/trigger", async (req, res) => {
  const bot = resolveBot(req.params.id);
  if (!bot) { res.status(400).json({ error: "unknown bot" }); return; }
  if (!bot.triggerScript) { res.status(400).json({ error: `${bot.id} is interactive-only and cannot be triggered` }); return; }
  if (running.has(bot.id)) { res.status(409).json({ error: "already running" }); return; }

  const since = Date.now() - (lastTrigger.get(bot.id) ?? 0);
  if (since < TRIGGER_COOLDOWN_MS) {
    res.status(429).json({ error: `cooldown, ${Math.ceil((TRIGGER_COOLDOWN_MS - since) / 1000)}s remaining` });
    return;
  }

  running.add(bot.id);
  lastTrigger.set(bot.id, Date.now());

  // Array args, shell: false. Nothing from the request reaches this call - the
  // script path and its args come from the registry only.
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bot.triggerScript, ...bot.triggerArgs],
    { shell: false, cwd: path.join(AGENCY_ROOT, bot.id), detached: false },
  );
  child.on("close", () => running.delete(bot.id));
  child.on("error", () => running.delete(bot.id));

  res.status(202).json({ id: bot.id, started: true, dryRun: bot.triggerArgs.includes("-DryRun") });
});

app.post("/api/quarantine/:batch/restore", async (req, res) => {
  const batch = req.params.batch;
  if (!ISO_DATE.test(batch)) { res.status(400).json({ error: "bad batch id" }); return; }
  const script = path.join(AGENCY_ROOT, "disk-cleanup", "scripts", "restore.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-BatchId", batch],
    { shell: false, cwd: path.join(AGENCY_ROOT, "disk-cleanup") },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => res.json({ batch, exitCode: code, output: out.trim() }));
  child.on("error", (e) => res.status(500).json({ error: String(e) }));
});

/**
 * The relevance graph the studio renders as conduits and auras.
 *
 * Read-only and derived entirely from markdown already on disk, so there is
 * nothing to gate beyond the token every /api route already carries. See
 * relevance.ts for what counts as a reference and, more importantly, for the
 * directories that are deliberately not scanned.
 */
app.get("/api/relevance", async (_req, res) => {
  try {
    res.json(await buildGraph(BOT_IDS));
  } catch (e) {
    // A failed graph must not take the scene down with it: main.ts treats this
    // as "no conduits" and the room renders without them. The bots' own state
    // does not come from here.
    res.status(500).json({ error: String(e) });
  }
});

// There is deliberately no purge endpoint. purge.ps1 requires an interactive
// console and a typed confirmation; exposing it over HTTP would defeat both
// locks on the only destructive operation in the Agency. Requests fall through
// to this 404 rather than being special-cased, so the absence is total.
app.use("/api", (_req, res) => res.status(404).json({ error: "no such endpoint" }));

const server = app.listen(PORT, HOST, () => {
  console.log(`agency control plane API  http://${HOST}:${PORT}  (loopback only)`);
});

/**
 * A second `npm run dev` while one is already running is the most common way
 * this process fails, and it used to fail at its worst: nothing handled the
 * server's 'error' event, so Node printed its crash banner and a stack through
 * node:net, and the only fact the user needed -- it is already running -- was
 * nowhere in the output. vite's half of that message ("Port 5173 is already in
 * use") is already legible because strictPort makes it stop; this is the API's
 * half. Kept ASCII: this goes to a Windows console whose codepage is not
 * reliably UTF-8.
 *
 * Probe: dashboard:api-port-conflict.
 */
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already in use. The control plane API is probably already running.`);
    console.error("Open http://127.0.0.1:5173, or stop the other instance and try again.");
    process.exit(1);
  }
  if (err.code === "EACCES") {
    console.error(`not permitted to bind ${HOST}:${PORT}. Pick another port with AGENCY_PORT.`);
    process.exit(1);
  }
  // Anything else is unexpected and should still be loud.
  throw err;
});
