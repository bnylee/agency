import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENCY_ROOT = path.resolve(here, "..", "..");

export type Cadence = "daily" | "weekly" | "on-demand";

export interface BotDef {
  id: string;
  name: string;
  blurb: string;
  cadence: Cadence;
  /** Windows scheduled task name, or null when the bot has no schedule. */
  scheduledTask: string | null;
  /**
   * Absolute path to the ONLY script this bot may be triggered with, or null
   * when the bot is not triggerable. This is the security boundary: a request's
   * :id selects an entry here, and nothing from the request ever reaches a
   * command line. There is deliberately no field for extra user-supplied args.
   */
  triggerScript: string | null;
  /** Fixed args appended to triggerScript. Never merged with request input. */
  triggerArgs: string[];
  /** Orbit radius in scene units. Cadence becomes distance from centre. */
  orbitRadius: number;
}

const bot = (id: string, rest: Omit<BotDef, "id">): BotDef => ({ id, ...rest });

/**
 * The hardcoded allowlist. Adding a bot here is a deliberate act with a code
 * review attached; there is no dynamic discovery, because a directory scan would
 * mean a new folder on disk becomes a new executable endpoint.
 */
export const REGISTRY: Record<string, BotDef> = {
  "sam-research": bot("sam-research", {
    name: "sam-research",
    blurb: "SAM Prototype research support",
    cadence: "weekly",
    scheduledTask: "sam-research-weekly",
    triggerScript: path.join(AGENCY_ROOT, "sam-research", "scripts", "run_weekly.ps1"),
    triggerArgs: [],
    orbitRadius: 7.5,
  }),
  "finance-research": bot("finance-research", {
    name: "finance-research",
    blurb: "Personal equity research",
    cadence: "daily",
    scheduledTask: "finance-research-premarket",
    triggerScript: path.join(AGENCY_ROOT, "finance-research", "scripts", "run_premarket.ps1"),
    triggerArgs: [],
    orbitRadius: 4.5,
  }),
  "disk-cleanup": bot("disk-cleanup", {
    name: "disk-cleanup",
    blurb: "Disk reclamation, quarantine only",
    cadence: "weekly",
    scheduledTask: "disk-cleanup-weekly",
    // Triggered from the UI it ALWAYS runs -DryRun. A browser button that stages
    // 22 GB of file moves is not something to offer casually; the live run stays
    // on the schedule or on an explicit terminal invocation.
    triggerScript: path.join(AGENCY_ROOT, "disk-cleanup", "scripts", "run_weekly.ps1"),
    triggerArgs: ["-DryRun"],
    orbitRadius: 10,
  }),
  "interface-design": bot("interface-design", {
    name: "interface-design",
    blurb: "Design system for this control plane",
    cadence: "on-demand",
    scheduledTask: null,
    triggerScript: null, // interactive-only by design
    triggerArgs: [],
    orbitRadius: 13,
  }),
  "media-bot": bot("media-bot", {
    name: "media-bot",
    blurb: "Notifications, calendar, and a reversible mail bin",
    cadence: "daily",
    scheduledTask: "media-bot-daily",
    // Triggered from the UI it ALWAYS runs -DryRun, same as disk-cleanup and
    // agency-repair and for the same shape of reason: the live run moves messages
    // out of a real inbox. It is reversible — a Gmail label move recorded in a
    // manifest — but "reversible" is the bar for exposing RESTORE, not for exposing
    // a browser button that touches somebody's mail on a click. A dry run performs
    // every network read for real and stages nothing, which is the useful half.
    triggerScript: path.join(AGENCY_ROOT, "media-bot", "scripts", "run_sweep.ps1"),
    triggerArgs: ["-DryRun"],
    // Outside finance-research's 4.5, inside the weekly zone's spacing. Daily bots
    // ride the inner slots; this only orders it within its own zone.
    orbitRadius: 6.0,
  }),
  "agency-repair": bot("agency-repair", {
    name: "agency-repair",
    blurb: "Health checks, repairs, and what to steal from GitHub",
    cadence: "daily",
    scheduledTask: "agency-repair-daily",
    // -DryRun from the UI, for the same reason disk-cleanup is: this is the one
    // bot that rewrites code, and a browser button that edits the control plane
    // it is being clicked in is not something to offer casually. The live run
    // stays on the schedule or on an explicit terminal invocation.
    triggerScript: path.join(AGENCY_ROOT, "agency-repair", "scripts", "run_repair.ps1"),
    triggerArgs: ["-DryRun"],
    // Inside finance-research's 4.5. Daily bots ride the inner orbits, and two
    // bodies on the same ring would overlap whenever their schedules aligned.
    orbitRadius: 2.6,
  }),
};

export const BOT_IDS = Object.keys(REGISTRY);

/**
 * Resolve an untrusted id. Returns null for anything not an exact key, which
 * covers traversal (`../`), casing tricks, and unknown names in one check.
 */
export function resolveBot(id: unknown): BotDef | null {
  if (typeof id !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, id)) return null;
  return REGISTRY[id] ?? null;
}

export const QUARANTINE_ROOT = "C:\\DiskCleanupQuarantine";
