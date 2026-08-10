/** Typed client. The token is held in localStorage and sent as a header. */

const TOKEN_KEY = "agency.token";

export type StatusRole = "ok" | "partial" | "failed" | "never_run" | "running";

export interface Bot {
  id: string;
  name: string;
  blurb: string;
  cadence: "daily" | "weekly" | "on-demand";
  orbitRadius: number;
  triggerable: boolean;
  dryRunOnly: boolean;
  status: StatusRole;
  statusDetail: string | null;
  lastRunDate: string | null;
  runCount: number;
  totalTokens: number;
  tokenSeries: { date: string; tokens: number }[];
  nextRun: string | null;
}

export interface Overview {
  volume: { drive: string; total_gb: number; free_gb: number; percent_free: number } | null;
  reclaimableGb: number | null;
  byCategory: { category: string; count: number; gb: number }[];
  installedGb: number | null;
  coldSteamGb: number | null;
  coldSteamCount: number | null;
  duplicateGb: number | null;
  topInstalled: { name: string; gb: number; last_used: string | null; cold: boolean | null; source: string }[];
  reportOnly: Record<string, { gb?: number; items?: number; files?: number; note?: string; command?: string }> | null;
}

export interface QuarantineBatch {
  batchId: string;
  stagedCount: number;
  stagedGb: number;
  dryRun: boolean;
  heldCount: number;
  rejectedCount: number;
  generatedAt: string | null;
}

/** finance-research's simulated account. Every dollar figure is the broker's. */
export interface Portfolio {
  disclaimer: string;
  openedAt: string | null;
  startingCash: number | null;
  cash: number;
  equity: number;
  totalReturnPct: number;
  benchmarkEquity: number | null;
  benchmarkReturnPct: number | null;
  realizedPnl: number;
  dividends: number;
  lastSettled: string | null;
  positions: {
    symbol: string; shares: number; avgCost: number;
    stop: number | null; target: number | null; conviction: number | null;
    openedAt: string | null; thesis: string;
  }[];
  pending: {
    symbol: string; side: string; shares: number; forSession: string;
    limit: number | null; stop: number | null; target: number | null; conviction: number | null;
  }[];
  closed: {
    symbol: string; opened_at: string; closed_at: string; avg_cost: number;
    exit: number; realized_pnl: number; return_pct: number | null; exit_reason: string;
  }[];
  curve: { date: string; equity: number; benchmark_equity: number | null }[];
  limits: Record<string, unknown>;
}

/**
 * Which bots reference each other, derived from the Agency's own markdown.
 *
 * The shape is duplicated in scene/relevance.ts rather than imported from it,
 * for the same reason every other type in this file is declared here: this is
 * the wire contract, and the scene should not become the definition of one.
 */
export interface Relevance {
  nodes: { id: string; degree: number }[];
  edges: { a: string; b: string; weight: number; forward: boolean }[];
  maxWeight: number;
  maxDegree: number;
  sources: number;
  generatedAt: string;
}

/**
 * media-bot's digest. Every count in `summary` is `classify.py`'s, untouched — see
 * the note on `/api/media` in server/index.ts for why nothing recomputes them.
 */
export interface Media {
  generatedAt: string | null;
  status: string;
  summary: {
    messages?: number; important?: number; normal?: number; junk?: number;
    unread_important?: number; events_total?: number; events_today?: number;
    tasks_total?: number; tasks_due_soon?: number; needs_you?: number;
  };
  feed: {
    id: string; source: string; via: string; service?: string;
    from: string; from_address: string; subject: string;
    date: string | null; unread: boolean;
    priority: "important" | "normal" | "junk"; reasons: string[];
  }[];
  calendar: {
    id: string; source: string; title: string; start: string | null; start_tz?: string;
    all_day: boolean; location: string; organizer: string; recurring?: boolean;
    urgency: string; hours_away: number | null;
  }[];
  tasks: {
    id: string; source: string; title: string; course?: string; due: string | null;
    points?: number | null; url?: string | null; urgency: string; hours_away: number | null;
    priority: string;
  }[];
  providers: {
    provider: string; status: string; note: string | null; error: string | null;
    counts: { messages?: number; events?: number; tasks?: number };
  }[];
  trash: {
    batches: {
      batchId: string; stagedAt: string | null; count: number;
      restoredAt: string | null; problems: number;
      messages: { from: string; subject: string; date: string | null; reasons: string[] }[];
    }[];
  };
  disclaimer: string;
  note: string;
}

export interface RepairBatch {
  batchId: string;
  fileCount: number;
  modified: number;
  created: number;
  files: { path: string; action: string }[];
  revertedAt: string | null;
  updatedAt: string | null;
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t.trim());
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * The public demo build. `VITE_DEMO` is replaced by Vite with a literal at build
 * time, so in a normal build this is `false`, the branch below is dropped, and
 * the fixtures never enter the bundle.
 */
export const DEMO = import.meta.env.VITE_DEMO === "1";

/**
 * Loaded once, lazily, and only in a demo build. A static import would tie the
 * real client to a module full of invented figures; a dynamic one inside a
 * constant-false branch is removed outright.
 */
const demoReady: Promise<typeof import("./demo/fixtures") | null> =
  DEMO ? import("./demo/fixtures") : Promise.resolve(null);

async function req<T>(pathname: string, init?: RequestInit): Promise<T> {
  if (DEMO) {
    const demo = await demoReady;
    try {
      return await demo!.demoRequest<T>(pathname, init);
    } catch (e) {
      // The fixtures raise their own not-found so they need no dependency on
      // this module. Translate at the boundary, so every caller keeps seeing
      // exactly one error type whichever build it is running in.
      const status = (e as { status?: number }).status ?? 500;
      throw new ApiError(status, e instanceof Error ? e.message : String(e));
    }
  }

  const res = await fetch(pathname, {
    ...init,
    headers: { "x-agency-token": getToken(), "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep statusText */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  bots: () => req<{ bots: Bot[]; generatedAt: string }>("/api/bots"),
  overview: () => req<Overview>("/api/overview"),
  quarantine: () => req<{ batches: QuarantineBatch[]; note: string }>("/api/quarantine"),
  runs: (id: string) => req<{ runs: string[] }>(`/api/bots/${encodeURIComponent(id)}/runs`),
  report: (id: string, date: string) =>
    req<{ id: string; date: string; body: string }>(`/api/bots/${encodeURIComponent(id)}/runs/${encodeURIComponent(date)}`),
  trigger: (id: string) =>
    req<{ id: string; started: boolean; dryRun: boolean }>(`/api/bots/${encodeURIComponent(id)}/trigger`, { method: "POST" }),
  restore: (batch: string) =>
    req<{ batch: string; exitCode: number; output: string }>(`/api/quarantine/${encodeURIComponent(batch)}/restore`, { method: "POST" }),
  portfolio: () => req<Portfolio>("/api/portfolio"),
  media: () => req<Media>("/api/media"),
  /** The standalone page a run rendered, as markup. 404 means it rendered none. */
  page: (id: string, date: string) =>
    req<{ id: string; date: string; html: string }>(
      `/api/bots/${encodeURIComponent(id)}/runs/${encodeURIComponent(date)}/page`),
  relevance: () => req<Relevance>("/api/relevance"),
  repairs: () => req<{ batches: RepairBatch[]; note: string }>("/api/repairs"),
  revertRepair: (batch: string) =>
    req<{ batch: string; exitCode: number; output: string }>(`/api/repairs/${encodeURIComponent(batch)}/revert`, { method: "POST" }),
};
