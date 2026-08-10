import type { Bot, Overview, QuarantineBatch, StatusRole } from "../api";

/** Status is glyph + label + colour. Never colour alone — see the design DNA. */
const GLYPH: Record<StatusRole, string> = {
  ok: "✔",
  partial: "▲",
  failed: "✕",
  never_run: "–",
  running: "◌",
};

const LABEL: Record<StatusRole, string> = {
  ok: "ok",
  partial: "partial",
  failed: "failed",
  never_run: "never run",
  running: "running",
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

/**
 * One label-and-value row in a ledger.
 *
 * Lives here because `panel.ts` and `views.ts` each had a byte-identical private
 * copy, and the fix below had to be made in both to work.
 *
 * ## Long values get their own line
 *
 * The ledger's voice is mono, uppercase, 0.65rem, 0.14em tracking — right for
 * `95.0 K` and `2026-08-09 09:00`, and actively hostile to a sentence. A real
 * `statusDetail` from `interface-design` is `ok (orrery -> studio room, 5 bot
 * models, relevance graph, obsidian vault)`: 71 characters, which squeezed onto one
 * right-aligned line crushed the label beside it and read as a wall of spaced
 * capitals.
 *
 * Past 28 characters the value drops to sentence case with normal tracking and is
 * allowed to wrap under its label. The threshold is where a value stops being a
 * figure and starts being prose — nothing in the run-report format produces a
 * 28-character *number*.
 */
export function ledgerLine(label: string, value: string): HTMLElement {
  const long = value.length > 28;
  const row = el("div", { class: "ledger-line", ...(long ? { "data-long": "true" } : {}) });
  row.append(el("span", {}, label), el("b", {}, value));
  return row;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Machine-voice timestamp: ISO date plus a 24-hour clock, built from local
 * parts rather than toLocaleString so it always matches `lastRunDate`, which
 * the API already emits as `YYYY-MM-DD`.
 *
 * Guarded against an unparseable date: the API forces ISO-8601, but a bad value
 * used to reach `new Date()` and render "Invalid Date" while every endpoint
 * still returned 200.
 */
function fmtStamp(iso: string | null): string {
  if (!iso) return "on demand";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Compact form for the rail, where there is no room for the full date. */
function fmtStampShort(iso: string | null): string {
  if (!iso) return "on demand";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Section head: a mono eyebrow over a hairline. Replaces the boxed card header. */
function sectionHead(title: string, hint?: string): HTMLElement {
  return el(
    "div",
    { class: "sec-head" },
    el("h2", {}, title),
    ...(hint ? [el("span", { class: "hint" }, hint)] : []),
  );
}

export function statusChip(status: StatusRole): HTMLElement {
  return el(
    "span",
    { class: "chip", "data-status": status },
    el("span", { class: "glyph", "aria-hidden": "true" }, GLYPH[status]),
    LABEL[status],
  );
}

/**
 * Token-spend trace. Deliberately drawn in muted ink, not in the bot's status
 * colour: status colour is reserved, and a coloured line here would make a
 * chart series impersonate a state.
 *
 * Sits full-width at the foot of a row, so it reads as that row's baseline
 * rather than as a separate widget.
 */
/**
 * Fewer than two samples, no chart.
 *
 * The previous build drew an empty box for a bot that has never run and a lone
 * centred dot for one that has run once. Neither decodes: a single point has no
 * scale and states no trend, so on screen it reads as a speck of dust. The run
 * count is already in the row's meta line, which is where that fact belongs.
 */
export function sparkline(series: { date: string; tokens: number }[]): SVGElement | null {
  if (series.length < 2) return null;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 100 14");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");

  const total = series.reduce((a, s) => a + s.tokens, 0);
  svg.setAttribute("aria-label", `${series.length} runs, ${Math.round(total / 1000)}k tokens total`);

  // A baseline under the trace, so a single sample reads as a plotted point
  // rather than as a speck of dust on the screen.
  const rule = document.createElementNS(ns, "line");
  rule.setAttribute("x1", "0"); rule.setAttribute("x2", "100");
  rule.setAttribute("y1", "13.5"); rule.setAttribute("y2", "13.5");
  rule.setAttribute("stroke", "var(--gridline)");
  rule.setAttribute("stroke-width", "1");
  rule.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(rule);

  const max = Math.max(...series.map((s) => s.tokens), 1);
  const n = series.length;
  const yOf = (tokens: number) => 13.5 - (tokens / max) * 11;

  const pts = series.map((s, i) => `${((i / (n - 1)) * 100).toFixed(2)},${yOf(s.tokens).toFixed(2)}`);
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--ink-secondary)");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  return svg;
}

/**
 * A bot as a hairline-ruled row rather than a card.
 *
 * The leading 2px edge carries the status colour, which is redundant with the
 * chip's glyph and label and never a substitute for them. `data-status` on the
 * row is what drives it — see `.row[data-status=...]` in styles.css.
 */
export function botRow(bot: Bot, onOpen: (id: string) => void, onTrigger: (id: string) => void): HTMLElement {
  const row = el("div", {
    class: "row",
    role: "button",
    tabindex: "0",
    "aria-selected": "false",
    "data-bot": bot.id,
    "data-status": bot.status,
  });

  row.append(
    el("div", { class: "row-top" }, el("span", { class: "row-name" }, bot.id), statusChip(bot.status)),
    el("div", { class: "row-blurb" }, bot.blurb),
  );

  // Two short mono lines rather than one long one. At 384px the single-line
  // form wrapped and orphaned its last word, which is worse than a second line.
  // 24-hour time: shorter, and an instrument panel has no use for AM/PM.
  const meta = el(
    "div",
    { class: "row-meta" },
    el("div", {}, "last ", el("b", {}, bot.lastRunDate ?? "never"),
      "  ·  ", el("b", {}, String(bot.runCount)), bot.runCount === 1 ? " run" : " runs"),
    el("div", {}, "next ", el("b", {}, fmtStampShort(bot.nextRun))),
  );

  const foot = el("div", { class: "row-foot" }, meta);
  if (bot.triggerable) {
    const btn = el("button", { class: "btn", type: "button" }, bot.dryRunOnly ? "Run dry" : "Run");
    btn.addEventListener("click", (e) => { e.stopPropagation(); onTrigger(bot.id); });
    foot.append(btn);
  } else {
    foot.append(el("span", { class: "row-meta muted" }, "interactive"));
  }
  row.append(foot);

  const spark = sparkline(bot.tokenSeries);
  if (spark) row.append(spark);

  row.addEventListener("click", () => onOpen(bot.id));
  // Keyboard activation goes straight through with no animation, per the spec.
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(bot.id); }
  });
  return row;
}

/**
 * Disk composition as a stacked bar using the validated categorical slots in
 * fixed order. Segments carry a 2px page-coloured gap so adjacent fills
 * separate without relying on hue alone.
 */
function usageBar(ov: Overview): HTMLElement | undefined {
  if (!ov.volume) return undefined;
  const total = ov.volume.total_gb;
  const free = ov.volume.free_gb;
  const installed = ov.installedGb ?? 0;
  const reclaimable = ov.reclaimableGb ?? 0;
  const other = Math.max(0, total - free - installed - reclaimable);

  const segs: [string, number, string][] = [
    ["--cat-1", installed, "installed programs"],
    ["--cat-2", reclaimable, "reclaimable"],
    ["--cat-3", other, "other used"],
    ["--cat-4", free, "free"],
  ];

  const bar = el("div", { class: "usage-bar", role: "img", "aria-label": segs.map(([, v, l]) => `${l} ${v.toFixed(0)} GB`).join(", ") });
  for (const [token, gb, label] of segs) {
    if (gb <= 0) continue;
    const s = el("div", { class: "usage-seg", title: `${label}: ${gb.toFixed(1)} GB` });
    s.style.width = `${(gb / total) * 100}%`;
    s.style.background = `var(${token})`;
    bar.append(s);
  }
  return bar;
}

export function renderMetrics(root: HTMLElement, ov: Overview, bots: Bot[]): void {
  const tokens = bots.reduce((a, b) => a + b.totalTokens, 0);
  const runs = bots.reduce((a, b) => a + b.runCount, 0);
  root.replaceChildren();

  // Free space leads because it is the number that decides whether the Agency
  // has a problem today. Everything else is reference.
  if (ov.volume) {
    const lead = el(
      "div",
      { class: "metric-lead" },
      el("div", { class: "eyebrow" }, "Free space"),
      el("div", { class: "figure" }, ov.volume.free_gb.toFixed(1), el("span", { class: "unit" }, "GB")),
    );
    const bar = usageBar(ov);
    if (bar) lead.append(bar);
    // Rounded: two decimal places of "percent free" is precision the number
    // does not have and nobody reads.
    lead.append(el("div", { class: "metric-note" }, `${Math.round(ov.volume.percent_free)}% of ${ov.volume.total_gb.toFixed(0)} GB`));
    root.append(lead);
  }

  const ledger = el("div", { class: "ledger" });
  if (ov.reclaimableGb !== null) ledger.append(ledgerLine("Reclaimable", `${ov.reclaimableGb.toFixed(1)} GB`));
  if (ov.coldSteamGb) ledger.append(ledgerLine("Cold games", `${ov.coldSteamGb.toFixed(0)} GB`));
  ledger.append(ledgerLine("Token spend", `${(tokens / 1000).toFixed(1)} k`));
  ledger.append(ledgerLine("Recorded runs", String(runs)));
  root.append(ledger);
}

export function renderQuarantine(root: HTMLElement, batches: QuarantineBatch[], onRestore: (b: string) => void): void {
  root.replaceChildren(sectionHead("Quarantine", "purge is terminal-only"));

  if (batches.length === 0) {
    root.append(el("div", { class: "empty" }, "No batches. disk-cleanup stages files here; nothing is ever deleted by a bot."));
    return;
  }

  const rows = el("div", { class: "rows" });
  for (const b of batches) {
    // No data-status here. A quarantine batch has no run status, and borrowing
    // a reserved status colour to decorate it would make green mean two things.
    const row = el("div", { class: "row row-neutral" });
    row.style.cursor = "default";
    row.append(
      el("div", { class: "row-top" },
        el("span", { class: "row-name" }, b.batchId),
        ...(b.dryRun ? [el("span", { class: "row-meta muted" }, "dry run")] : [])),
      el("div", { class: "row-foot" },
        el("span", { class: "row-meta" },
          el("b", {}, String(b.stagedCount)), " staged  ·  ",
          el("b", {}, `${b.stagedGb} GB`), "  ·  ",
          el("b", {}, String(b.heldCount)), " held  ·  ",
          el("b", {}, String(b.rejectedCount)), " rejected"),
        ...(!b.dryRun && b.stagedCount > 0 ? [(() => {
          const btn = el("button", { class: "btn", type: "button" }, "Restore");
          btn.addEventListener("click", () => onRestore(b.batchId));
          return btn;
        })()] : [])),
    );
    rows.append(row);
  }
  root.append(rows);
}

/** The table view. The visualisation is the pleasant path, never the only one. */
export function renderTable(root: HTMLElement, bots: Bot[]): void {
  const table = el("table", { class: "plain" });
  table.append(
    el("thead", {}, el("tr", {},
      el("th", {}, "Bot"), el("th", {}, "Status"), el("th", {}, "Last run"),
      el("th", {}, "Next run"),
      el("th", { class: "num" }, "Runs"), el("th", { class: "num" }, "Tokens"))),
  );
  const tbody = el("tbody");
  for (const b of bots) {
    tbody.append(el("tr", {},
      el("td", {}, b.id),
      el("td", {}, statusChip(b.status)),
      el("td", {}, b.lastRunDate ?? "—"),
      el("td", {}, fmtStamp(b.nextRun)),
      // An em dash, not "0" and not "0.0k". A bot that has never run has no
      // measurement here; a zero would claim one was taken.
      el("td", { class: "num" }, b.runCount === 0 ? "—" : String(b.runCount)),
      el("td", { class: "num" }, b.runCount === 0 ? "—" : `${(b.totalTokens / 1000).toFixed(1)}k`)));
  }
  table.append(tbody);
  root.replaceChildren(sectionHead("All bots", `${bots.length} registered`), table);
}

export { sectionHead };

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const t = el("div", { class: "toast", "data-kind": kind }, message);
  root.append(t);
  setTimeout(() => t.remove(), 4200);
}
