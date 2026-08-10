/**
 * Synthetic data for the public demo build (`npm run build:demo`).
 *
 * Nothing here is real. Every figure, path, sender and dollar amount is invented
 * to exercise the interface — six bots covering all five status roles, a disk
 * report, a simulated portfolio, a mail digest, a quarantine batch and a repair
 * batch. There is no server behind it: `api.ts` routes through `demoRequest`
 * instead of `fetch` when built with `VITE_DEMO=1`, and the production build
 * tree-shakes this module out entirely.
 *
 * The shapes are the wire contract in `../api.ts`, deliberately not imported
 * from `../../server/*` — this module has to build without the server, and the
 * point of a demo is to prove the client renders a contract, not to prove the
 * server can produce one.
 *
 * Dates are computed relative to load time rather than hardcoded. A demo whose
 * "next run" passed eighteen months ago reads as an abandoned system, and the
 * brass rings that carry time-until-next-run would all sit pinned past their
 * markers, which is a status this fixture does not mean to assert.
 */

import type {
  Bot, Media, Overview, Portfolio, QuarantineBatch, RepairBatch, Relevance,
} from "../api";

const MS_HOUR = 3_600_000;
const MS_DAY = 24 * MS_HOUR;

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
/** `YYYY-MM-DD` in local time, which is the form every run report is keyed by. */
const day = (offsetDays: number) => {
  const d = new Date(now + offsetDays * MS_DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------- bots */

/**
 * Six bots covering every status role the palette defines, because a demo that
 * only ever shows `ok` never shows what the interface is for. `sam-research`
 * carries `failed` and `interface-design` carries `never_run`.
 */
const BOTS: Bot[] = [
  {
    id: "agency-repair",
    name: "agency-repair",
    blurb: "Health checks, repairs, and what to steal from GitHub",
    cadence: "daily",
    orbitRadius: 2.6,
    triggerable: true,
    dryRunOnly: true,
    status: "ok",
    statusDetail: "ok",
    lastRunDate: day(0),
    runCount: 34,
    totalTokens: 412_000,
    tokenSeries: [
      { date: day(-6), tokens: 11_800 }, { date: day(-5), tokens: 12_400 },
      { date: day(-4), tokens: 9_900 }, { date: day(-3), tokens: 14_100 },
      { date: day(-2), tokens: 12_050 }, { date: day(-1), tokens: 10_700 },
      { date: day(0), tokens: 11_150 },
    ],
    nextRun: iso(now + 6 * MS_HOUR),
  },
  {
    id: "finance-research",
    name: "finance-research",
    blurb: "Personal equity research",
    cadence: "daily",
    orbitRadius: 4.5,
    triggerable: true,
    dryRunOnly: false,
    status: "ok",
    statusDetail: "ok",
    lastRunDate: day(0),
    runCount: 41,
    totalTokens: 986_400,
    tokenSeries: [
      { date: day(-6), tokens: 22_300 }, { date: day(-5), tokens: 24_800 },
      { date: day(-4), tokens: 21_100 }, { date: day(-3), tokens: 27_600 },
      { date: day(-2), tokens: 25_900 }, { date: day(-1), tokens: 23_400 },
      { date: day(0), tokens: 26_050 },
    ],
    nextRun: iso(now + 14 * MS_HOUR),
  },
  {
    id: "media-bot",
    name: "media-bot",
    blurb: "Notifications, calendar, and a reversible mail bin",
    cadence: "daily",
    orbitRadius: 6.0,
    triggerable: true,
    dryRunOnly: true,
    status: "partial",
    statusDetail: "partial",
    lastRunDate: day(0),
    runCount: 28,
    totalTokens: 318_700,
    tokenSeries: [
      { date: day(-6), tokens: 9_400 }, { date: day(-5), tokens: 10_100 },
      { date: day(-4), tokens: 8_800 }, { date: day(-3), tokens: 11_600 },
      { date: day(-2), tokens: 10_950 }, { date: day(-1), tokens: 9_700 },
      { date: day(0), tokens: 10_400 },
    ],
    nextRun: iso(now + 9 * MS_HOUR),
  },
  {
    id: "sam-research",
    name: "sam-research",
    blurb: "SAM Prototype research support",
    cadence: "weekly",
    orbitRadius: 7.5,
    triggerable: true,
    dryRunOnly: false,
    status: "failed",
    statusDetail: "failed",
    lastRunDate: day(-2),
    runCount: 9,
    totalTokens: 274_500,
    tokenSeries: [
      { date: day(-30), tokens: 31_200 }, { date: day(-23), tokens: 28_900 },
      { date: day(-16), tokens: 34_100 }, { date: day(-9), tokens: 29_800 },
      { date: day(-2), tokens: 4_300 },
    ],
    nextRun: iso(now + 4 * MS_DAY),
  },
  {
    id: "disk-cleanup",
    name: "disk-cleanup",
    blurb: "Disk reclamation, quarantine only",
    cadence: "weekly",
    orbitRadius: 10,
    triggerable: true,
    dryRunOnly: true,
    status: "ok",
    statusDetail: "ok",
    lastRunDate: day(-1),
    runCount: 11,
    totalTokens: 143_900,
    tokenSeries: [
      { date: day(-29), tokens: 13_100 }, { date: day(-22), tokens: 12_400 },
      { date: day(-15), tokens: 14_800 }, { date: day(-8), tokens: 13_600 },
      { date: day(-1), tokens: 12_900 },
    ],
    nextRun: iso(now + 6 * MS_DAY),
  },
  {
    id: "interface-design",
    name: "interface-design",
    blurb: "Design system for this control plane",
    cadence: "on-demand",
    orbitRadius: 13,
    triggerable: false,
    dryRunOnly: false,
    status: "never_run",
    statusDetail: null,
    lastRunDate: null,
    runCount: 0,
    totalTokens: 0,
    tokenSeries: [],
    nextRun: null,
  },
];

/* --------------------------------------------------------------- overview */

const OVERVIEW: Overview = {
  volume: { drive: "C:", total_gb: 931.5, free_gb: 88.4, percent_free: 9.49 },
  reclaimableGb: 26.8,
  byCategory: [
    { category: "build-artifacts", count: 4_812, gb: 9.6 },
    { category: "package-caches", count: 3_140, gb: 7.4 },
    { category: "installer-leftovers", count: 486, gb: 4.9 },
    { category: "browser-cache", count: 2_907, gb: 3.1 },
    { category: "crash-dumps", count: 133, gb: 1.8 },
  ],
  installedGb: 512.3,
  coldSteamGb: 71.2,
  coldSteamCount: 6,
  duplicateGb: 4.4,
  topInstalled: [
    { name: "Siemens NX", gb: 41.8, last_used: day(-3), cold: false, source: "registry" },
    { name: "Game Studio Launcher", gb: 38.2, last_used: day(-214), cold: true, source: "steam" },
    { name: "Visual Studio 2022", gb: 27.5, last_used: day(-41), cold: false, source: "registry" },
    { name: "SolidWorks", gb: 24.1, last_used: day(-12), cold: false, source: "registry" },
    { name: "MATLAB R2025b", gb: 22.6, last_used: day(-6), cold: false, source: "registry" },
    { name: "Open-World RPG", gb: 19.4, last_used: day(-388), cold: true, source: "steam" },
  ],
  reportOnly: {
    "hibernation-file": { gb: 12.8, note: "powercfg territory — never touched automatically", command: "powercfg /hibernate off" },
    "windows-update-cache": { gb: 5.2, note: "serviced by Windows itself; a manual clear can force a re-download" },
    "recycle-bin": { gb: 2.1, items: 1_204, note: "already a quarantine — emptying it is the user's call" },
  },
};

/* ------------------------------------------------------------- quarantine */

const QUARANTINE: QuarantineBatch[] = [
  {
    batchId: day(-1), stagedCount: 4_218, stagedGb: 18.42, dryRun: false,
    heldCount: 61, rejectedCount: 12, generatedAt: iso(now - MS_DAY + 3 * MS_HOUR),
  },
  {
    batchId: day(-8), stagedCount: 3_006, stagedGb: 11.07, dryRun: false,
    heldCount: 44, rejectedCount: 5, generatedAt: iso(now - 8 * MS_DAY + 3 * MS_HOUR),
  },
  {
    batchId: day(-15), stagedCount: 5_000, stagedGb: 25.00, dryRun: true,
    heldCount: 120, rejectedCount: 31, generatedAt: iso(now - 15 * MS_DAY + 3 * MS_HOUR),
  },
];

/* -------------------------------------------------------------- portfolio */

/**
 * A simulated account with a plausible-looking curve. It has to be plausible
 * rather than flat, because the whole reason the equity view separates account
 * from benchmark by weight and dash rather than by hue is only visible when the
 * two lines actually diverge.
 */
function curve(): Portfolio["curve"] {
  const out: Portfolio["curve"] = [];
  let equity = 10_000;
  let bench = 10_000;
  // A fixed seed rather than Math.random: two screenshots of the demo taken a
  // minute apart should differ in nothing, or a pixel diff of a design change is
  // dominated by a new random walk.
  let seed = 20260810;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let i = 45; i >= 0; i--) {
    equity *= 1 + rnd() * 0.021 + 0.0016;
    bench *= 1 + rnd() * 0.013 + 0.0009;
    out.push({ date: day(-i), equity: Math.round(equity * 100) / 100, benchmark_equity: Math.round(bench * 100) / 100 });
  }
  return out;
}

const CURVE = curve();
const LAST = CURVE[CURVE.length - 1]!;

const PORTFOLIO: Portfolio = {
  disclaimer: "Simulated account. No brokerage is connected and no real money is involved. Fills are modelled against printed historical prices.",
  openedAt: day(-45),
  startingCash: 10_000,
  cash: 3_182.44,
  equity: LAST.equity,
  totalReturnPct: Math.round((LAST.equity / 10_000 - 1) * 10_000) / 100,
  benchmarkEquity: LAST.benchmark_equity,
  benchmarkReturnPct: Math.round(((LAST.benchmark_equity ?? 10_000) / 10_000 - 1) * 10_000) / 100,
  realizedPnl: 214.80,
  dividends: 18.42,
  lastSettled: day(0),
  positions: [
    {
      symbol: "AAPL", shares: 8, avgCost: 241.18, stop: 218.00, target: 292.00,
      conviction: 3, openedAt: day(-19),
      thesis: "Services margin held through the last two prints; the stop sits under the March consolidation rather than at a round number.",
    },
    {
      symbol: "CAT", shares: 5, avgCost: 402.55, stop: 366.00, target: 470.00,
      conviction: 2, openedAt: day(-11),
      thesis: "Infrastructure backlog is the whole position. Sized at two so a backlog revision does not take the account with it.",
    },
    {
      symbol: "TSM", shares: 12, avgCost: 188.90, stop: 171.00, target: 232.00,
      conviction: 4, openedAt: day(-27),
      thesis: "Capex guide raised twice; the risk is concentration, which is why nothing else in the book is a foundry.",
    },
  ],
  pending: [
    {
      symbol: "UNP", side: "buy", shares: 4, forSession: day(1),
      limit: 236.50, stop: 214.00, target: 278.00, conviction: 2,
    },
  ],
  closed: [
    {
      symbol: "MSFT", opened_at: day(-38), closed_at: day(-21), avg_cost: 498.10,
      exit: 531.75, realized_pnl: 168.25, return_pct: 6.76, exit_reason: "target",
    },
    {
      symbol: "NKE", opened_at: day(-33), closed_at: day(-29), avg_cost: 74.20,
      exit: 70.55, realized_pnl: -43.80, return_pct: -4.92, exit_reason: "stop",
    },
    {
      symbol: "JNJ", opened_at: day(-40), closed_at: day(-25), avg_cost: 162.30,
      exit: 168.95, realized_pnl: 90.35, return_pct: 4.10, exit_reason: "target",
    },
  ],
  curve: CURVE,
  limits: {
    max_position_pct: 25,
    max_new_positions_per_session: 2,
    max_open_positions: 6,
    min_cash_pct: 10,
    stop_required: true,
    commission: 0,
    slippage_bps: 5,
  },
};

/* ------------------------------------------------------------------ media */

const MEDIA: Media = {
  generatedAt: iso(now - 2 * MS_HOUR),
  status: "partial",
  summary: {
    messages: 47, important: 6, normal: 19, junk: 22,
    unread_important: 3, events_total: 9, events_today: 2,
    tasks_total: 5, tasks_due_soon: 2, needs_you: 4,
  },
  feed: [
    {
      id: "m1", source: "gmail", via: "imap", service: "university",
      from: "Academic Advising", from_address: "advising@example.edu",
      subject: "Spring registration opens Monday — hold on your account",
      date: iso(now - 3 * MS_HOUR), unread: true,
      priority: "important", reasons: ["sender domain in IMPORTANT_DOMAINS", "unread", "deadline language in subject"],
    },
    {
      id: "m2", source: "canvas", via: "rest", service: "canvas",
      from: "Thermodynamics I", from_address: "notifications@example-lms.com",
      subject: "Problem Set 6 graded — 47/50",
      date: iso(now - 7 * MS_HOUR), unread: true,
      priority: "important", reasons: ["course notification", "unread"],
    },
    {
      id: "m3", source: "outlook", via: "graph", service: "work",
      from: "Lab Coordinator", from_address: "lab@example.org",
      subject: "Reschedule: Friday build review moved to 2pm",
      date: iso(now - 11 * MS_HOUR), unread: false,
      priority: "important", reasons: ["direct addressee", "calendar change"],
    },
    {
      id: "m4", source: "gmail", via: "imap", service: "instagram",
      from: "Instagram", from_address: "no-reply@example-social.com",
      subject: "3 people mentioned you in a comment",
      date: iso(now - 14 * MS_HOUR), unread: true,
      priority: "normal", reasons: ["social activity email — no notification API exists for this service"],
    },
    {
      id: "m5", source: "gmail", via: "imap", service: null as unknown as string,
      from: "Gear Outlet", from_address: "deals@example-store.com",
      subject: "48 HOURS ONLY — up to 70% off everything",
      date: iso(now - 16 * MS_HOUR), unread: true,
      priority: "junk", reasons: ["List-Unsubscribe header present", "all-caps urgency in subject", "no prior reply to sender"],
    },
    {
      id: "m6", source: "gmail", via: "imap", service: null as unknown as string,
      from: "Webinar Digest", from_address: "hello@example-marketing.com",
      subject: "You're invited: scaling your career in 2026",
      date: iso(now - 21 * MS_HOUR), unread: true,
      priority: "junk", reasons: ["List-Unsubscribe header present", "bulk precedence header", "no prior reply to sender"],
    },
  ],
  calendar: [
    {
      id: "c1", source: "ics", title: "Thermodynamics I — recitation",
      start: iso(now + 4 * MS_HOUR), start_tz: "America/New_York", all_day: false,
      location: "Snell 108", organizer: "Registrar", recurring: true,
      urgency: "today", hours_away: 4,
    },
    {
      id: "c2", source: "outlook", title: "Build review (moved)",
      start: iso(now + 9 * MS_HOUR), start_tz: "America/New_York", all_day: false,
      location: "Shop bay 2", organizer: "Lab Coordinator", recurring: false,
      urgency: "today", hours_away: 9,
    },
    {
      id: "c3", source: "ics", title: "Statics midterm",
      start: iso(now + 3 * MS_DAY), start_tz: "America/New_York", all_day: false,
      location: "Ell Hall", organizer: "Registrar", recurring: false,
      urgency: "this-week", hours_away: 72,
    },
  ],
  tasks: [
    {
      id: "t1", source: "canvas", title: "Problem Set 7", course: "Thermodynamics I",
      due: iso(now + 20 * MS_HOUR), points: 50, url: null,
      urgency: "due-soon", hours_away: 20, priority: "important",
    },
    {
      id: "t2", source: "canvas", title: "Lab report — beam deflection", course: "Statics",
      due: iso(now + 2 * MS_DAY), points: 100, url: null,
      urgency: "due-soon", hours_away: 48, priority: "important",
    },
    {
      id: "t3", source: "canvas", title: "Reading quiz 9", course: "Materials Science",
      due: iso(now + 6 * MS_DAY), points: 10, url: null,
      urgency: "later", hours_away: 144, priority: "normal",
    },
  ],
  providers: [
    { provider: "gmail", status: "ok", note: null, error: null, counts: { messages: 41, events: 0, tasks: 0 } },
    { provider: "outlook", status: "ok", note: null, error: null, counts: { messages: 6, events: 2, tasks: 0 } },
    { provider: "canvas", status: "ok", note: null, error: null, counts: { messages: 0, events: 0, tasks: 5 } },
    {
      provider: "ics", status: "partial", note: null,
      error: "1 of 2 feeds returned 404 — the published link was rotated",
      counts: { messages: 0, events: 7, tasks: 0 },
    },
    { provider: "instagram", status: "unavailable", note: "No personal notification API exists. Activity email is classified from mail instead.", error: null, counts: {} },
    { provider: "tiktok", status: "unavailable", note: "No personal notification API exists. Activity email is classified from mail instead.", error: null, counts: {} },
    { provider: "snapchat", status: "unavailable", note: "No personal notification API exists. Activity email is classified from mail instead.", error: null, counts: {} },
  ],
  trash: {
    batches: [
      {
        batchId: day(0), stagedAt: iso(now - 2 * MS_HOUR), count: 22,
        restoredAt: null, problems: 0,
        messages: [
          { from: "Gear Outlet", subject: "48 HOURS ONLY — up to 70% off everything", date: iso(now - 16 * MS_HOUR), reasons: ["List-Unsubscribe header present", "all-caps urgency in subject"] },
          { from: "Webinar Digest", subject: "You're invited: scaling your career in 2026", date: iso(now - 21 * MS_HOUR), reasons: ["List-Unsubscribe header present", "bulk precedence header"] },
          { from: "Rewards Program", subject: "Your points expire soon", date: iso(now - 26 * MS_HOUR), reasons: ["List-Unsubscribe header present", "no prior reply to sender"] },
        ],
      },
      {
        batchId: day(-1), stagedAt: iso(now - MS_DAY - 2 * MS_HOUR), count: 17,
        restoredAt: iso(now - MS_DAY + 4 * MS_HOUR), problems: 0,
        messages: [
          { from: "Course Notices", subject: "Section change for next week", date: iso(now - 30 * MS_HOUR), reasons: ["bulk precedence header"] },
        ],
      },
    ],
  },
  disclaimer: "Nothing is deleted. Junk-classified mail is moved to a label and every move is recorded with the rule that condemned it.",
  note: "Demo data. No mailbox is connected.",
};

/* -------------------------------------------------------------- relevance */

const RELEVANCE: Relevance = {
  nodes: [
    { id: "agency-repair", degree: 9 },
    { id: "interface-design", degree: 7 },
    { id: "disk-cleanup", degree: 5 },
    { id: "finance-research", degree: 4 },
    { id: "media-bot", degree: 4 },
    { id: "sam-research", degree: 2 },
  ],
  edges: [
    { a: "agency-repair", b: "interface-design", weight: 6, forward: true },
    { a: "agency-repair", b: "disk-cleanup", weight: 4, forward: true },
    { a: "agency-repair", b: "finance-research", weight: 3, forward: true },
    { a: "agency-repair", b: "media-bot", weight: 3, forward: true },
    { a: "interface-design", b: "disk-cleanup", weight: 3, forward: false },
    { a: "interface-design", b: "media-bot", weight: 2, forward: true },
    { a: "disk-cleanup", b: "finance-research", weight: 1, forward: false },
    { a: "sam-research", b: "finance-research", weight: 2, forward: true },
  ],
  maxWeight: 6,
  maxDegree: 9,
  sources: 38,
  generatedAt: iso(now - 40 * 60_000),
};

/* ---------------------------------------------------------------- repairs */

const REPAIRS: RepairBatch[] = [
  {
    batchId: day(-1), fileCount: 3, modified: 3, created: 0,
    files: [
      { path: "dashboard/src/ui/views.ts", action: "modified" },
      { path: "dashboard/server/index.ts", action: "modified" },
      { path: "dashboard/src/ui/theme.ts", action: "modified" },
    ],
    revertedAt: null, updatedAt: iso(now - MS_DAY + 2 * MS_HOUR),
  },
  {
    batchId: day(-5), fileCount: 1, modified: 1, created: 0,
    files: [{ path: "dashboard/server/relevance.ts", action: "modified" }],
    revertedAt: iso(now - 4 * MS_DAY), updatedAt: iso(now - 5 * MS_DAY + 2 * MS_HOUR),
  },
];

/* ------------------------------------------------------------ run reports */

/**
 * Reports are keyed by bot and date. The bodies use all three `**Field** — text`
 * shapes the digest parser supports, since the panel's headline block is the
 * first thing a visitor sees and a fixture that only exercises one form would
 * hide a regression in the other two.
 */
const REPORTS: Record<string, Record<string, string>> = {
  "agency-repair": {
    [day(0)]: `## agency-repair — ${iso(now - 5 * MS_HOUR)}

**Status** — ok
**Did** — Ran 12 probes, 12 passed. Rebuilt \`dashboard/\` clean (\`tsc --noEmit\`, \`vite build\`). Verified the API returns 401 to an unauthenticated request and 200 with the token. Snapshotted nothing: no probe failed, so no repair was proposed.
**Holding** — Nothing.
**Failed** — Nothing.
**Carry forward** — \`bots:freshness\` will start warning on sam-research in 2 days if its weekly run does not recover.

### Probes

| Probe | Result | Detail |
| --- | --- | --- |
| dashboard:typecheck | pass | \`tsc --noEmit\` clean |
| dashboard:build | pass | \`vite build\` succeeded in 4.2s |
| dashboard:api-boot | pass | \`GET /api/bots\` → 200, 6 bots; unauthenticated request correctly 401 |
| dashboard:loopback | pass | server refuses a non-loopback bind |
| bots:settings | pass | every bot has deny rules in \`settings.json\` |
| bots:hooks | pass | 4 PreToolUse guards present and executable |
| bots:freshness | pass | 5 of 6 bots ran inside their cadence window |
| bots:ledger | pass | every run has a ledger line |
| quarantine:reversible | pass | \`restore.ps1\` present, manifest parses, 3 batches indexed |
| quarantine:no-purge-endpoint | pass | no route matches \`/purge\` |
| repairs:snapshots | pass | every repair batch has a \`before/\` tree |
| skills:lock | pass | 4 vendored skills, all hashes match |
`,
    [day(-1)]: `## agency-repair — ${iso(now - MS_DAY - 5 * MS_HOUR)}

**Status** — partial
**Did** — Ran 12 probes, 11 passed. Applied 3 fixes under Tier A, each snapshotted to \`repairs/${day(-1)}/before/\`.
**Holding** — One proposed repair to \`server/relevance.ts\` needs review: the fix changes scoring, and a probe cannot tell a better graph from a different one.
**Failed** — \`bots:freshness\` — sam-research last ran 1 day outside its weekly window.
**Carry forward** — Revert batch \`${day(-1)}\` is available if the panel headline regresses.
`,
  },
  "finance-research": {
    [day(0)]: `## finance-research — ${iso(now - 8 * MS_HOUR)}

**Status** — ok
**Did** — Settled 1 queued order at the printed open. Applied stops and targets to 3 open positions, no stop hit. Marked the account to market and appended today's point to the equity curve. Queued 1 new order for the next session.
**Holding** — Nothing. Every action above is inside the simulated account.
**Failed** — Nothing.
**Carry forward** — Cash is at 31.8% of equity, above the 10% floor, so the next session can take a second position if the screen produces one.

### Pre-market movers

| Symbol | Pre-market | Catalyst |
| --- | --- | --- |
| UNP | +3.1% | Volume guide raised at an investor day |
| CAT | +1.4% | Peer read-through from an infrastructure print |
| TSM | −0.8% | Sector drift, no company news |

**Simulated account. No brokerage is connected and no real money is involved.**
`,
  },
  "media-bot": {
    [day(0)]: `## media-bot — ${iso(now - 2 * MS_HOUR)}

**Status** — partial
**Did** — Collected 47 messages, 9 calendar events and 5 assignments across 4 providers. Classified 6 important, 19 normal, 22 junk. Moved 22 junk-classified messages to \`Agency/Trash-Candidates\`, each recorded with the rule that condemned it.
**Holding** — Nothing. Label moves are pre-authorised and reversible with \`triage.py restore\`.
**Failed** — One of two published \`.ics\` feeds returned 404. The link was rotated at the source; the other feed collected normally, so the run is partial rather than failed.
**Carry forward** — Replace the dead \`.ics\` URL in \`ICS_URLS\`, or the calendar stays short by one feed every day.

Instagram, TikTok and Snapchat have no personal notification API. Their activity
email is classified from mail instead — three of today's normal-priority items
came in that way.
`,
  },
  "disk-cleanup": {
    [day(-1)]: `## disk-cleanup — ${iso(now - MS_DAY - 4 * MS_HOUR)}

**Status** — ok
**Did** — Scanned a 931.5 GB volume in 16 minutes. Identified 11,478 regenerable candidates totalling 26.8 GB. Quarantined 4,218 files (18.42 GB) to \`C:\\DiskCleanupQuarantine\\${day(-1)}\`, under both caps. Held 61 files that changed during the scan and rejected 12 outside the policy roots.
**Holding** — 6 cold installed programs totalling 71.2 GB are reported, not touched. Uninstalling is never autonomous.
**Failed** — Nothing.
**Carry forward** — Staged bytes are PENDING, not reclaimed. A same-volume move frees nothing — run \`purge.ps1\` at a terminal to actually recover the space, or \`restore.ps1\` to put it all back.
`,
  },
  "sam-research": {
    [day(-2)]: `## sam-research — ${iso(now - 2 * MS_DAY - 6 * MS_HOUR)}

**Status** — failed
**Did** — Checked 3 of 7 watched sources before halting.
**Holding** — Nothing.
**Failed** — The OECD bulk-download endpoint returned 503 on all four retries, at the source-watch step. Halted rather than recording an unchanged hash, because "unreachable" and "unchanged" are different facts and the second one would have been wrong.
**Carry forward** — 4 sources went unchecked. The next run must treat their stored hashes as stale rather than current.
`,
  },
};

/* ------------------------------------------------------------- dispatcher */

class DemoNotFound extends Error {
  status = 404;
}

/** Everything the demo can answer, keyed the way `api.ts` asks for it. */
function resolve(pathname: string, method: string): unknown {
  const parts = pathname.replace(/^\/api\//, "").split("/").map(decodeURIComponent);

  if (method === "POST") {
    // The demo has no server to act on. Mutating routes report the shape of a
    // success and change nothing, which is the honest answer: the button works,
    // there is simply nothing behind it here.
    if (parts[0] === "bots" && parts[2] === "trigger") {
      const bot = BOTS.find((b) => b.id === parts[1]);
      if (!bot) throw new DemoNotFound("unknown bot");
      return { id: bot.id, started: true, dryRun: bot.dryRunOnly };
    }
    if (parts[0] === "quarantine" && parts[2] === "restore") {
      return { batch: parts[1], exitCode: 0, output: `Demo: ${parts[1]} would be restored from the copies taken before the move. Nothing was changed.` };
    }
    if (parts[0] === "repairs" && parts[2] === "revert") {
      return { batch: parts[1], exitCode: 0, output: `Demo: ${parts[1]} would be reverted from its before/ snapshot. Nothing was changed.` };
    }
    throw new DemoNotFound(`no demo route for POST ${pathname}`);
  }

  switch (parts[0]) {
    case "bots": {
      if (parts.length === 1) return { bots: BOTS, generatedAt: iso(Date.now()) };
      const id = parts[1]!;
      const byDate = REPORTS[id] ?? {};
      // Newest first, which is the order the run picker expects.
      if (parts[2] === "runs" && parts.length === 3) return { runs: Object.keys(byDate).sort().reverse() };
      if (parts[2] === "runs" && parts[4] === "page") {
        // No run in the demo rendered a standalone page. 404 is the real
        // server's answer too, and the panel says so rather than hiding
        // the button — "this run produced no page" and "this feature does
        // not exist" are different facts.
        throw new DemoNotFound("no page for this run");
      }
      if (parts[2] === "runs" && parts.length === 4) {
        const body = byDate[parts[3]!];
        if (body === undefined) throw new DemoNotFound("no such report");
        return { id, date: parts[3], body };
      }
      throw new DemoNotFound(`no demo route for ${pathname}`);
    }
    case "overview": return OVERVIEW;
    case "quarantine": return { batches: QUARANTINE, note: "Staged bytes are pending, not reclaimed. Restore puts every file back from the copy taken before the move." };
    case "portfolio": return PORTFOLIO;
    case "media": return MEDIA;
    case "relevance": return RELEVANCE;
    case "repairs": return { batches: REPAIRS, note: "Every batch has a before/ snapshot. Revert moves bot-created files aside rather than deleting them." };
    default: throw new DemoNotFound(`no demo route for ${pathname}`);
  }
}

/**
 * Stand-in for `fetch` + JSON decode. The small delay is deliberate: the panel
 * and the rail both have loading states that a synchronous resolve would skip
 * straight past, and a demo that never shows them misrepresents the interface.
 */
export async function demoRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  await new Promise((r) => setTimeout(r, 90));
  return resolve(pathname, init?.method ?? "GET") as T;
}

export { DemoNotFound };
