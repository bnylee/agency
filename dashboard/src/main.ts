import "./styles.css";
import { ApiError, DEMO, api, getToken, setToken, type Bot, type Overview, type QuarantineBatch, type Relevance } from "./api";
import { mount, type StudioHandle } from "./scene/studio";
import { botRow, el, renderMetrics, renderQuarantine, renderTable, sectionHead, toast } from "./ui/components";
import { closePanel, openPanel, panelWidth, type PanelAction, type PanelSpec, type PanelView } from "./ui/panel";
import { mediaView, obsidianView, portfolioView, repairsView, requestsView } from "./ui/views";
import { mountPalette, type Command } from "./ui/palette";
import { attachPress } from "./motion/registers";

const POLL_MS = 10_000;

let bots: Bot[] = [];
let overview: Overview | null = null;
let batches: QuarantineBatch[] = [];
let relevance: Relevance | null = null;
let studio: StudioHandle | null = null;
let selected: string | null = null;
let tableView = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ------------------------------------------------------------ token gate */

function showGate(message?: string): void {
  const gate = $("token-gate");
  gate.hidden = false;
  const input = el("input", { type: "password", placeholder: "AGENCY_TOKEN", autocomplete: "off" });
  const save = el("button", { class: "btn", type: "button" }, "Connect");
  const box = el("div", { class: "gate-box" },
    el("h2", {}, "Agency control plane"),
    el("p", {}, message ?? "Paste the AGENCY_TOKEN from dashboard/.env. It is stored locally and sent as a request header."),
    input,
    el("div", { class: "row-actions" }, save));
  gate.replaceChildren(el("div", { class: "gate" }, box));

  const submit = () => {
    if (!input.value.trim()) return;
    setToken(input.value);
    gate.hidden = true;
    void boot();
  };
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  input.focus();
}

/* --------------------------------------------------------------- render */

/**
 * The options a given bot actually offers. Assembled here rather than in the
 * panel because only this module knows the registry state — whether a bot is
 * triggerable, whether it is dry-run-only, and which extra views exist.
 */
function specFor(bot: Bot): PanelSpec {
  const actions: PanelAction[] = [];
  const notes: string[] = [];

  if (bot.triggerable) {
    actions.push({
      label: bot.dryRunOnly ? "Run dry" : "Run now",
      run: () => triggerBot(bot.id),
      disabled: bot.status === "running",
    });
    if (bot.dryRunOnly) notes.push("stages nothing — live runs stay on the schedule");
  } else {
    notes.push("interactive only — this bot has no trigger");
  }

  const facts: [string, string][] = [];
  if (bot.statusDetail) facts.push(["Last status", bot.statusDetail]);

  // Bot-specific views. Keyed on id rather than on a capability flag because
  // there are two of them and inventing a registry field to describe "has a
  // portfolio" would be more machinery than the fact deserves.
  const views: PanelView[] = [];
  if (bot.id === "finance-research") views.push(portfolioView());
  if (bot.id === "agency-repair") {
    // Requests leads for this bot. Every other panel opens on the record of
    // what happened; this is the one bot you open to tell it something, so the
    // box you type into is the thing that should be in front of you.
    views.push(requestsView());
    views.push(repairsView(() => { void refresh(); }));
  }
  // media-bot's digest leads, ahead of Reports: for this bot the live state IS the
  // product, and the report is the record of how it was assembled. Expressed as
  // `lead: true` on the view itself rather than as an ordering rule here — see
  // PanelView.lead in ui/panel.ts.
  if (bot.id === "media-bot") views.push(mediaView());
  // Every bot gets this one: it is the readable half of the conduits and the
  // aura, and a bot with no links needs somewhere to say so.
  views.push(obsidianView(bot.id));

  return { actions, facts, notes, views };
}

function openBot(id: string): void {
  const bot = bots.find((b) => b.id === id);
  if (!bot) return;
  selected = id;
  studio?.setSelected(id);
  studio?.setDimmed(true);
  markSelection();
  void openPanel(bot, specFor(bot), () => {
    // Only tear down if this panel is still the selected one.
    //
    // openPanel closes any previous panel before opening the new one, so when
    // you click straight from one body to another, the OLD panel's onClose runs
    // *after* the new selection has already been made. Without this guard it
    // reset the selection to null, which cancelled the incoming zoom and
    // dropped the camera back to the overview with the new panel still open —
    // the swap animation looked like a plain zoom-out.
    if (selected !== id) return;
    selected = null;
    studio?.setSelected(null);
    studio?.setDimmed(false);
    markSelection();
    // The panel is on its way out, so the scene gets its full stage back. Both
    // travel on the sheet curve, so they arrive together.
    syncStageInset();
  });
  // openPanel appends the sheet synchronously and only then awaits its data, so
  // the element is measurable on this tick.
  syncStageInset();
}

function markSelection(): void {
  for (const node of document.querySelectorAll<HTMLElement>(".row[data-bot]")) {
    node.setAttribute("aria-selected", String(node.dataset.bot === selected));
  }
}

/**
 * Tell the scene how much of the canvas the chrome is covering, so the studio
 * centres itself in the stage instead of behind the rail or under the open
 * panel. Read from the live layout rather than from the token, because the rail
 * collapses to full width under 920px and in table view — at which point the
 * inset is zero.
 */
function syncStageInset(): void {
  if (!studio) return;
  const rail = document.querySelector<HTMLElement>(".rail");
  const stage = document.querySelector<HTMLElement>(".stage");
  const visibleStage = stage && stage.offsetParent !== null;
  if (!visibleStage) {
    // No stage: the rail is the page and the panel covers the whole viewport,
    // so there is no visible region to centre into. Insetting here would divide
    // by a stage width of zero and throw the camera to the far distance.
    studio.setStageInset(0, 0, 0);
    return;
  }
  studio.setStageInset(
    rail ? rail.getBoundingClientRect().width : 0,
    $("app").querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 0,
    panelWidth(),
  );
}

async function triggerBot(id: string): Promise<void> {
  try {
    const res = await api.trigger(id);
    toast(res.dryRun ? `${id} started (dry run — stages nothing)` : `${id} started`);
    await refresh();
  } catch (e) {
    toast(e instanceof ApiError ? `${id}: ${e.message}` : String(e), "error");
  }
}

async function restoreBatch(batch: string): Promise<void> {
  try {
    const res = await api.restore(batch);
    toast(res.exitCode === 0 ? `Restored ${batch}` : `Restore ${batch} exited ${res.exitCode}`, res.exitCode === 0 ? "info" : "error");
    await refresh();
  } catch (e) {
    toast(String(e), "error");
  }
}

function renderBots(): void {
  const root = $("bots");
  if (tableView) { renderTable(root, bots); return; }
  root.replaceChildren(sectionHead("Bots", `${bots.length} registered`));
  const list = el("div", { class: "rows" });
  for (const bot of bots) {
    const row = botRow(bot, openBot, (id) => void triggerBot(id));
    // Press-scale the button, not the row. scale(0.97) on a hairline-ruled
    // full-width row detaches it from its own rules and reads as a glitch; the
    // row's feedback is its hover wash and its accent going to full opacity.
    // Register B is allowed to be zero, and here it should be.
    for (const btn of row.querySelectorAll<HTMLElement>(".btn")) attachPress(btn);
    list.append(row);
  }
  root.append(list);
  markSelection();
}

function renderAll(): void {
  const metrics = $("metrics");
  // The overview section is disk-cleanup's data. With no overview there is
  // nothing to lead with, so the section collapses rather than showing an
  // empty frame — negative space is the point of this layout.
  metrics.hidden = !overview;
  if (overview) renderMetrics(metrics, overview, bots);
  renderBots();
  renderQuarantine($("quarantine"), batches, (b) => void restoreBatch(b));
}

/* ---------------------------------------------------------------- data */

async function refresh(): Promise<void> {
  const [botRes, ovRes, qRes, relRes] = await Promise.allSettled([
    api.bots(),
    api.overview(),
    api.quarantine(),
    // Cheap to ask for: the server caches the derived graph for a minute, so
    // polling it alongside everything else costs one 304-shaped round trip
    // rather than five directory walks.
    api.relevance(),
  ]);

  if (botRes.status === "rejected") {
    if (botRes.reason instanceof ApiError && botRes.reason.status === 401) {
      showGate("That token was rejected. Check AGENCY_TOKEN in dashboard/.env.");
      return;
    }
    $("poll-state").textContent = "api unreachable";
    return;
  }

  bots = botRes.value.bots;
  if (ovRes.status === "fulfilled") overview = ovRes.value;
  if (qRes.status === "fulfilled") batches = qRes.value.batches;

  // 24-hour, no seconds-suffix noise: the topbar stamp sits next to mono
  // uppercase controls and "9:04:02 PM" broke that voice.
  $("poll-state").textContent = `updated ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  renderAll();
  studio?.update(bots);
  // A failed graph clears the conduits rather than leaving the last good set on
  // screen. Stale edges are worse than none: they would still be flowing, which
  // reads as current.
  relevance = relRes.status === "fulfilled" ? relRes.value : null;
  studio?.setRelevance(relevance);
}

/* ---------------------------------------------------------------- boot */

/**
 * Say so, on the page, permanently.
 *
 * A demo that renders invented figures in a convincing interface is a claim
 * about a system, and the claim has to carry its own caveat rather than leaving
 * it in a README the visitor arrived from. It sits in the topbar in the same
 * mono voice as every other machine-emitted string, and it is not dismissible.
 */
function markDemo(): void {
  const badge = el("span", { class: "demo-badge", title: "Synthetic data. No server, no bots, nothing to connect to." }, "demo");
  document.querySelector(".topbar-actions")?.prepend(badge);
  document.title = "Agency — control plane (demo)";
}

async function boot(): Promise<void> {
  // The gate exists to hold the AGENCY_TOKEN that authorises a server to start
  // PowerShell. The demo build has no server and no token to check, so a
  // password prompt in front of it would ask for a secret that does not exist.
  if (!DEMO && !getToken()) { showGate(); return; }

  try {
    await refresh();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { showGate("Token rejected."); return; }
    throw e;
  }
  if (bots.length === 0) return;

  // The scene is strictly optional. If WebGL is unavailable the table view is
  // shown and everything still works -- the visualisation is the pleasant path,
  // never the only one.
  try {
    studio = mount($<HTMLCanvasElement>("scene"), bots);
    studio.onSelect((id) => { if (id) openBot(id); else closePanel(); });
    // The first refresh ran before the scene existed, so its graph never reached
    // anything. Hand it over now rather than waiting a full poll for the
    // conduits to appear.
    studio.setRelevance(relevance);
    syncStageInset();
    window.addEventListener("resize", syncStageInset);
  } catch {
    document.body.classList.add("table-view");
    tableView = true;
    renderBots();
    toast("WebGL unavailable — showing the table view", "error");
  }

  setInterval(() => { void refresh(); }, POLL_MS);
}

/* --------------------------------------------------------------- chrome */

$("view-toggle").addEventListener("click", () => {
  tableView = !tableView;
  document.body.classList.toggle("table-view", tableView);
  const btn = $("view-toggle");
  btn.setAttribute("aria-pressed", String(tableView));
  btn.textContent = tableView ? "Studio" : "Table";
  renderBots();
  // In table view the stage is gone and the rail is the page, so the scene's
  // inset drops to zero. It is hidden either way, but leaving a stale offset
  // means the studio is off-centre for a frame when you switch back.
  syncStageInset();
});

const palette = mountPalette((): Command[] => {
  const cmds: Command[] = [];
  for (const bot of bots) {
    cmds.push({ label: `Open ${bot.name}`, kind: "report", run: () => openBot(bot.id) });
    if (bot.triggerable) {
      cmds.push({
        label: `Run ${bot.name}${bot.dryRunOnly ? " (dry)" : ""}`,
        kind: "trigger",
        run: () => void triggerBot(bot.id),
      });
    }
  }
  for (const b of batches) {
    if (!b.dryRun && b.stagedCount > 0) {
      cmds.push({ label: `Restore quarantine ${b.batchId}`, kind: "restore", run: () => void restoreBatch(b.batchId) });
    }
  }
  cmds.push({ label: tableView ? "Switch to studio view" : "Switch to table view", kind: "view", run: () => $("view-toggle").click() });
  // The rotate gesture is mouse-only and the canvas never takes focus, so this
  // is the only way back to the composed pose that a keyboard can reach.
  if (studio && !tableView) cmds.push({ label: "Reset camera view", kind: "view", run: () => studio?.resetView() });
  return cmds;
});

$("cmd-open").addEventListener("click", () => palette.open());

if (DEMO) markDemo();

void boot();
