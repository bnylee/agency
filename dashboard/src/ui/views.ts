/**
 * Bot-specific panel views: finance-research's paper account, and
 * agency-repair's snapshot batches.
 *
 * One colour decision governs this whole file, and it is the interesting one.
 *
 * **P&L is not coloured.** Green-up/red-down is the most conventional thing in
 * finance, and it is unavailable here: `--status-ok` and `--status-failed` are
 * reserved for "the bot ran" and "the bot broke", and a green +2.3% would make
 * green mean two things on a surface where the whole point is that it means
 * one. The sign and tabular numerals carry the direction instead, which is also
 * what the design DNA's "never colour alone" rule would have demanded anyway.
 *
 * The equity curve separates its two series by weight and dash rather than hue,
 * for the same reason and one more: no new hex means no contrast figure in
 * design-dna.json needs recomputing.
 */
import { api, type Media, type Portfolio, type RepairBatch, type RepairRequest, type RepairRequests } from "../api";
import { VAULT_DIR, obsidianUri } from "../vault";
import { el, ledgerLine, sectionHead, toast } from "./components";
import type { PanelView } from "./panel";

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null) => (n === null || Number.isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

function emptyRow(text: string): HTMLElement {
  return el("div", { class: "empty" }, text);
}

/**
 * Account equity against the same money left in SPY.
 *
 * Two lines, no fill, no axis furniture. The question this answers is "am I
 * beating the benchmark or not", and that is legible from which line is on top.
 * Exact figures are in the ledger directly above it.
 */
function equityChart(curve: Portfolio["curve"]): SVGElement | null {
  if (curve.length < 2) return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "equity-chart");
  svg.setAttribute("viewBox", "0 0 100 34");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");

  const values = curve.flatMap((p) => [p.equity, p.benchmark_equity]).filter((v): v is number => typeof v === "number");
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat curve has no range to scale against, and dividing by it would put
  // every point at NaN. Give it a nominal band so the line renders level.
  const span = max - min || Math.max(1, max * 0.01);
  const last = curve.at(-1)!;
  svg.setAttribute(
    "aria-label",
    `Account ${money(last.equity)}${last.benchmark_equity ? ` against benchmark ${money(last.benchmark_equity)}` : ""}, ${curve.length} sessions`,
  );

  const yOf = (v: number) => 31 - ((v - min) / span) * 28;
  const xOf = (i: number) => (i / (curve.length - 1)) * 100;

  const line = (pts: string[], stroke: string, width: string, dash?: string) => {
    const p = document.createElementNS(ns, "polyline");
    p.setAttribute("points", pts.join(" "));
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", stroke);
    p.setAttribute("stroke-width", width);
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("vector-effect", "non-scaling-stroke");
    if (dash) p.setAttribute("stroke-dasharray", dash);
    svg.append(p);
  };

  const bench = curve.map((p, i) => (typeof p.benchmark_equity === "number" ? `${xOf(i).toFixed(2)},${yOf(p.benchmark_equity).toFixed(2)}` : null))
    .filter((s): s is string => s !== null);
  if (bench.length > 1) line(bench, "var(--ink-muted)", "1", "3 3");
  line(curve.map((p, i) => `${xOf(i).toFixed(2)},${yOf(p.equity).toFixed(2)}`), "var(--ink)", "1.5");
  return svg;
}

export function portfolioView(): PanelView {
  return {
    id: "portfolio",
    label: "Portfolio",
    render: async (host) => {
      host.replaceChildren(emptyRow("Loading the paper account…"));
      let pf: Portfolio;
      try {
        pf = await api.portfolio();
      } catch (e) {
        host.replaceChildren(emptyRow(`No paper account yet: ${(e as Error).message}`));
        return;
      }

      const frag = document.createDocumentFragment();

      // Equity leads, because it is the one number that says whether any of
      // this worked. Everything else is reference.
      const lead = el("div", { class: "metric-lead" },
        el("div", { class: "eyebrow" }, "Account equity"),
        el("div", { class: "figure" }, money(pf.equity)),
        el("div", { class: "metric-note" },
          `${pct(pf.totalReturnPct)} since ${pf.openedAt ?? "opening"}` +
          (pf.benchmarkReturnPct === null ? "" : `  ·  SPY ${pct(pf.benchmarkReturnPct)}`)));
      const chart = equityChart(pf.curve);
      if (chart) {
        lead.append(chart);
        lead.append(el("div", { class: "chart-key" },
          el("span", { class: "key-account" }, "account"),
          el("span", { class: "key-bench" }, "SPY buy-and-hold")));
      }
      frag.append(lead);

      const ledger = el("div", { class: "ledger" });
      ledger.append(ledgerLine("Cash", money(pf.cash)));
      ledger.append(ledgerLine("Realized P&L", money(pf.realizedPnl)));
      if (pf.dividends) ledger.append(ledgerLine("Dividends", money(pf.dividends)));
      ledger.append(ledgerLine("Settled through", pf.lastSettled ?? "not yet"));
      frag.append(ledger);

      frag.append(sectionHead("Positions", `${pf.positions.length} open`));
      if (pf.positions.length === 0) {
        frag.append(emptyRow("No open positions."));
      } else {
        const t = el("table", { class: "plain" });
        t.append(el("thead", {}, el("tr", {},
          el("th", {}, "Symbol"), el("th", { class: "num" }, "Shares"),
          el("th", { class: "num" }, "Cost"), el("th", { class: "num" }, "Stop"),
          el("th", { class: "num" }, "Target"), el("th", { class: "num" }, "Conv"))));
        const tb = el("tbody");
        for (const p of pf.positions) {
          const row = el("tr", {},
            el("td", {}, p.symbol),
            el("td", { class: "num" }, String(p.shares)),
            el("td", { class: "num" }, money(p.avgCost)),
            el("td", { class: "num" }, p.stop === null ? "—" : money(p.stop)),
            el("td", { class: "num" }, p.target === null ? "—" : money(p.target)),
            el("td", { class: "num" }, p.conviction === null ? "—" : String(p.conviction)));
          // The thesis is the reason the position exists, so it travels with it
          // rather than living in a report you have to go and find.
          if (p.thesis) row.title = p.thesis;
          tb.append(row);
        }
        t.append(tb);
        frag.append(t);
      }

      if (pf.pending.length) {
        frag.append(sectionHead("Queued", `for ${pf.pending[0]!.forSession} open`));
        const t = el("table", { class: "plain" });
        t.append(el("thead", {}, el("tr", {},
          el("th", {}, "Symbol"), el("th", {}, "Side"),
          el("th", { class: "num" }, "Shares"), el("th", { class: "num" }, "Limit"))));
        const tb = el("tbody");
        for (const o of pf.pending) {
          tb.append(el("tr", {},
            el("td", {}, o.symbol), el("td", {}, o.side),
            el("td", { class: "num" }, String(o.shares)),
            el("td", { class: "num" }, o.limit === null ? "market" : money(o.limit))));
        }
        t.append(tb);
        frag.append(t);
      }

      if (pf.closed.length) {
        frag.append(sectionHead("Closed", `last ${pf.closed.length}`));
        const t = el("table", { class: "plain" });
        t.append(el("thead", {}, el("tr", {},
          el("th", {}, "Symbol"), el("th", {}, "Closed"),
          el("th", { class: "num" }, "Return"), el("th", { class: "num" }, "P&L"),
          el("th", {}, "Why"))));
        const tb = el("tbody");
        for (const c of pf.closed) {
          tb.append(el("tr", {},
            el("td", {}, c.symbol), el("td", {}, c.closed_at),
            el("td", { class: "num" }, pct(c.return_pct)),
            el("td", { class: "num" }, money(c.realized_pnl)),
            el("td", {}, c.exit_reason)));
        }
        t.append(tb);
        frag.append(t);
      }

      frag.append(el("p", { class: "disclaimer" }, pf.disclaimer));
      host.replaceChildren(frag);
    },
  };
}

/**
 * The Obsidian view: what this bot is connected to, and why.
 *
 * This is the readable half of the studio's conduits and aura. The 3D layer
 * shows you *that* two bots are linked and roughly how strongly; this shows the
 * numbers and names them, which is the same division of labour as the token ring
 * and the token figure — the scene gives you the shape, the panel gives you the
 * value.
 *
 * Every bot gets this view, including one with no edges at all. An empty graph is
 * a real reading and it needs somewhere to be stated; a view that only appeared
 * for well-connected bots would make isolation look like a missing feature.
 */
export function obsidianView(botId: string): PanelView {
  return {
    id: "obsidian",
    label: "Obsidian",
    render: async (host) => {
      host.replaceChildren(emptyRow("Deriving the relevance graph…"));
      let graph;
      try {
        graph = await api.relevance();
      } catch (e) {
        host.replaceChildren(emptyRow(`Could not derive the graph: ${(e as Error).message}`));
        return;
      }

      const frag = document.createDocumentFragment();
      const node = graph.nodes.find((n) => n.id === botId);
      const links = graph.edges
        .filter((e) => e.a === botId || e.b === botId)
        .map((e) => ({
          other: e.a === botId ? e.b : e.a,
          weight: e.weight,
          // `forward` is a -> b on the edge; from this bot's point of view what
          // matters is whether the attention flows out or in.
          outward: (e.a === botId) === e.forward,
        }))
        .sort((x, y) => y.weight - x.weight);

      frag.append(el("div", { class: "metric-lead" },
        el("div", { class: "eyebrow" }, "Relevance degree"),
        el("div", { class: "figure" }, String(node?.degree ?? 0)),
        el("div", { class: "metric-note" },
          `${links.length} link${links.length === 1 ? "" : "s"} across ${graph.sources} markdown files  ·  ` +
          "sum of the weights of every edge touching this bot")));

      frag.append(sectionHead("Linked bots", "weight, and which way the attention runs"));
      if (links.length === 0) {
        frag.append(emptyRow("Nothing in the Agency's markdown references this bot, and it references nothing back. It has no aura and no conduits in the studio — that is the reading, not a gap."));
      } else {
        const ledger = el("div", { class: "ledger" });
        for (const l of links) {
          // Arrow direction is the encoding; the weight is the magnitude. No
          // colour, because every hue on this surface is already spoken for.
          ledger.append(ledgerLine(`${l.outward ? "→" : "←"}  ${l.other}`, String(l.weight)));
        }
        frag.append(ledger);
      }

      frag.append(sectionHead("Vault note", `${VAULT_DIR}/Bots/${botId}.md`));
      const open = el("a", { class: "btn", href: obsidianUri(`Bots/${botId}.md`) }, "Open in Obsidian");
      frag.append(el("div", { class: "row-actions" }, open));
      frag.append(el("p", { class: "disclaimer" },
        `Generated by \`npm run vault\` in dashboard/. The link works only once the ${VAULT_DIR}/ folder has been opened in Obsidian at least ` +
        "once (Open folder as vault) — the protocol handler cannot register a vault, and the browser cannot tell you whether it fired."));

      host.replaceChildren(frag);
    },
  };
}

/**
 * media-bot's digest: what needs you, then the calendar, then the bin.
 *
 * ## Ordering is the design
 *
 * `needs_you` leads, and everything under it is sorted by how soon it is rather
 * than by which service it came from. A per-service layout is the obvious one and
 * it is wrong here: you do not wake up wanting to know what Instagram said, you
 * wake up wanting to know what is due. Service is a column, not a section.
 *
 * ## Priority is not coloured
 *
 * Same rule the portfolio view spends its whole header on. `--status-ok` and
 * `--status-failed` mean "the bot ran" and "the bot broke"; a red `important`
 * badge would make red mean two things on a surface whose premise is that it means
 * one. Priority is carried by the label, by position, and by an accent rule on the
 * leading edge — which is `--bot-accent`, media-bot's own hue, and therefore not a
 * reserved one.
 *
 * ## Every unavailable provider is stated every time
 *
 * Instagram, TikTok and Snapchat have no personal notification API, and the panel
 * says so rather than showing three empty sections. An absent service that looks
 * like a service with nothing in it is the worst of the three possible readings.
 */
export function mediaView(): PanelView {
  return {
    id: "media",
    label: "Inbox",
    lead: true,
    render: async (host) => {
      host.replaceChildren(emptyRow("Loading the digest…"));
      let m: Media;
      try {
        m = await api.media();
      } catch (e) {
        host.replaceChildren(emptyRow(
          `No digest yet: ${(e as Error).message}. Run the sweep once — `
          + "media-bot\\scripts\\run_sweep.ps1 -DryRun writes one to state\\dryrun\\ without touching any mail."));
        return;
      }

      const frag = document.createDocumentFragment();
      const s = m.summary;

      // The one number that answers "do I need to do anything". Everything else on
      // this view is the breakdown of it.
      const lead = el("div", { class: "metric-lead" },
        el("div", { class: "eyebrow" }, "Needs you"),
        el("div", { class: "figure" }, String(s.needs_you ?? 0)),
        el("div", { class: "metric-note" },
          `${s.unread_important ?? 0} unread important  ·  ${s.events_today ?? 0} on today  ·  `
          + `${s.tasks_due_soon ?? 0} due soon`));
      frag.append(lead);

      const ledger = el("div", { class: "ledger" });
      ledger.append(ledgerLine("Messages read", String(s.messages ?? 0)));
      ledger.append(ledgerLine("Important", String(s.important ?? 0)));
      ledger.append(ledgerLine("Junk (binnable)", String(s.junk ?? 0)));
      ledger.append(ledgerLine("Collected", m.generatedAt ?? "never"));
      frag.append(ledger);

      /* ---------------------------------------------------------- what is due */
      const due = m.tasks.filter((t) => t.urgency !== "later" && t.urgency !== "past");
      frag.append(sectionHead("Due", due.length ? "soonest first" : "nothing inside a week"));
      if (due.length === 0) {
        frag.append(emptyRow("Nothing due soon."));
      } else {
        const t = el("table", { class: "plain" });
        t.append(el("thead", {}, el("tr", {},
          el("th", {}, "What"), el("th", {}, "Course"),
          el("th", {}, "When"), el("th", { class: "num" }, "Hours"))));
        const tb = el("tbody");
        for (const task of due.slice(0, 20)) {
          tb.append(el("tr", {},
            el("td", {}, task.title),
            el("td", {}, task.course ?? ""),
            // The urgency BAND, not a re-derived date. classify.py computed it and
            // recomputing it here is how two views start disagreeing about whether
            // something is due today.
            el("td", {}, task.urgency),
            el("td", { class: "num" }, task.hours_away === null ? "—" : String(Math.round(task.hours_away)))));
        }
        t.append(tb);
        frag.append(t);
      }

      /* ------------------------------------------------------------- calendar */
      const soon = m.calendar.filter((e) => e.urgency !== "past");
      frag.append(sectionHead("Calendar", soon.length ? "next 14 days" : "nothing scheduled"));
      if (soon.length === 0) {
        frag.append(emptyRow("Nothing on the calendar. If that is a surprise, ICS_URLS may not be set."));
      } else {
        const t = el("table", { class: "plain" });
        t.append(el("thead", {}, el("tr", {},
          el("th", {}, "Event"), el("th", {}, "Starts"),
          el("th", {}, "Where"), el("th", {}, "From"))));
        const tb = el("tbody");
        for (const e of soon.slice(0, 20)) {
          const row = el("tr", {},
            // Shown EXACTLY as the source stated it, never converted. The collector
            // has no timezone database and says so; a time silently shifted by a
            // guess is worse than one shown with a caveat.
            el("td", {}, e.title + (e.recurring ? "  (repeats)" : "")),
            el("td", {}, (e.start ?? "—").replace("T", " ").replace("Z", "")),
            el("td", {}, e.location || "—"),
            el("td", {}, e.source));
          if (e.urgency === "now" || e.urgency === "today") row.classList.add("row-urgent");
          tb.append(row);
        }
        t.append(tb);
        frag.append(t);
      }

      /* ----------------------------------------------------------------- feed */
      const important = m.feed.filter((x) => x.priority === "important");
      frag.append(sectionHead("Important mail", `${important.length} of ${m.feed.length} in the feed`));
      if (important.length === 0) {
        frag.append(emptyRow("Nothing important. The rest of the feed is in the run report."));
      } else {
        const rows = el("div", { class: "rows" });
        for (const msg of important.slice(0, 15)) {
          const row = el("div", { class: "row row-accent" });
          row.style.cursor = "default";
          row.append(el("div", { class: "row-top" },
            el("span", { class: "row-name" }, msg.from || msg.from_address),
            el("span", { class: "row-meta" }, msg.unread ? "unread" : "read")));
          row.append(el("div", { class: "row-blurb" }, msg.subject || "(no subject)"));
          // The rule that classified it, shown inline. A classifier you cannot
          // interrogate is one you will not trust, and one you do not trust you
          // will not act on.
          row.append(el("div", { class: "row-foot" },
            el("span", { class: "row-meta muted" },
              `${msg.service ?? msg.source}${msg.via === "email" ? " (via email)" : ""}  ·  `
              + (msg.reasons[0] ?? "no rule recorded"))));
          rows.append(row);
        }
        frag.append(rows);
      }

      /* -------------------------------------------------------------- the bin */
      const batches = m.trash.batches;
      frag.append(sectionHead("Trash bin", batches.length ? `${batches.length} batch(es)` : "nothing staged"));
      if (batches.length === 0) {
        frag.append(emptyRow("Nothing has been staged. Junk is only moved by a live run, and it moves to a "
          + "Gmail label — never to Trash and never to a delete."));
      } else {
        const rows = el("div", { class: "rows" });
        for (const b of batches.slice(0, 8)) {
          // No data-status: a trash batch has no run status, and borrowing a
          // reserved status colour to decorate one would make green mean two
          // things. Same reasoning as the quarantine and repair rows.
          const row = el("div", { class: "row row-neutral" });
          row.style.cursor = "default";
          row.append(el("div", { class: "row-top" },
            el("span", { class: "row-name" }, b.batchId),
            el("span", { class: "row-meta muted" }, b.restoredAt ? "restored" : "staged")));
          row.append(el("div", { class: "row-foot" },
            el("span", { class: "row-meta" },
              el("b", {}, String(b.count)), b.count === 1 ? " message" : " messages",
              b.problems ? `  ·  ${b.problems} problem(s)` : "")));
          if (b.messages.length) {
            const details = el("details", { class: "file-list" });
            details.append(el("summary", {}, `what is in it (${b.messages.length} shown)`));
            const ul = el("ul", {});
            for (const msg of b.messages) {
              ul.append(el("li", {}, `${msg.from ?? ""} — ${msg.subject ?? ""}`));
            }
            details.append(ul);
            row.append(details);
          }
          rows.append(row);
        }
        frag.append(rows);
      }

      /* -------------------------------------------------------------- sources */
      const unavailable = m.providers.filter((p) => p.status === "unavailable");
      const unconfigured = m.providers.filter((p) => p.status === "not_configured");
      const broken = m.providers.filter((p) => p.status === "failed");
      const working = m.providers.filter((p) => p.status === "ok");

      frag.append(sectionHead("Sources", `${working.length} connected`));
      const src = el("div", { class: "ledger" });
      for (const p of working) {
        const c = p.counts;
        src.append(ledgerLine(p.provider,
          `${c.messages ?? 0} msg · ${c.events ?? 0} events · ${c.tasks ?? 0} tasks`));
      }
      for (const p of broken) src.append(ledgerLine(p.provider, "failed"));
      for (const p of unconfigured) src.append(ledgerLine(p.provider, "not set up"));
      frag.append(src);

      for (const p of broken) {
        frag.append(el("p", { class: "disclaimer" }, `${p.provider} failed: ${p.error ?? "no error text"}`));
      }
      for (const p of unconfigured) {
        // The setup step, not just the fact. "not_configured" without the next
        // action is a status light with nothing behind it.
        frag.append(el("p", { class: "disclaimer" }, `${p.provider} — ${p.note ?? "no setup note"}`));
      }
      if (unavailable.length) {
        frag.append(el("p", { class: "disclaimer" },
          `${unavailable.map((p) => p.provider).join(", ")} have no personal notification API at all. `
          + "Their activity emails are classified from mail instead, and appear above marked "
          + "\"via email\". This will not change by retrying, and it is not a setup step you have missed."));
      }

      frag.append(el("p", { class: "disclaimer" }, m.disclaimer));
      frag.append(el("p", { class: "disclaimer" }, m.note));
      host.replaceChildren(frag);
    },
  };
}

/**
 * Tell agency-repair what to fix.
 *
 * Every other view in this file is read-only — a report, an account, a batch
 * list. This is the only one that sends something, and it leads the panel
 * because it is what you open this bot to do. The Reports tab is still there
 * and still carries the record; but the record is what happened, and this is
 * the thing you came to say.
 *
 * Two deliberate refusals:
 *
 * **A request is never shown as a promise.** The submitted note says the bot
 * will read it on its next run and reports what it could not do — not that it
 * will be fixed. The bot's Tier A caps and its hooks decide what actually
 * happens, and a UI that implied otherwise would be lying about a system whose
 * whole premise is that limits hold mechanically.
 *
 * **Status here is not coloured with a run status.** An open request is not a
 * failing bot. `--status-*` means what a run did; borrowing red for "nobody has
 * got to this yet" would make red mean two things. Position, label and a
 * neutral rule carry it, exactly as the quarantine and repair rows do.
 */
export function requestsView(): PanelView {
  return {
    id: "requests",
    label: "Requests",
    lead: true,
    render: async (host) => {
      host.replaceChildren(emptyRow("Loading requests…"));

      let data: RepairRequests;
      try {
        data = await api.repairRequests();
      } catch (e) {
        host.replaceChildren(emptyRow(`Could not load requests: ${(e as Error).message}`));
        return;
      }

      const frag = document.createDocumentFragment();
      // Short hint, long caveat below the box. Every other section head in the
      // app is three or four words ("purge is terminal-only"); a sentence here
      // squeezed the title into a three-line column.
      frag.append(sectionHead("Ask for a fix", "read at the next run"));

      /* ------------------------------------------------------------ compose */

      const box = el("textarea", {
        class: "request-input",
        rows: "4",
        placeholder: "What needs fixing? e.g. sam-research cannot reach GLORIA — ielab.info is client-rendered and WebFetch sees an empty shell.",
        maxlength: String(data.limits.maxChars),
      }) as HTMLTextAreaElement;

      const count = el("span", { class: "row-meta muted" }, `0 / ${data.limits.maxChars}`);
      const send = el("button", { class: "btn", type: "button" }, "Send to agency-repair") as HTMLButtonElement;
      send.disabled = true;

      const sync = () => {
        const n = box.value.trim().length;
        count.textContent = `${n} / ${data.limits.maxChars}`;
        send.disabled = n === 0;
      };
      box.addEventListener("input", sync);

      const submit = () => {
        const text = box.value.trim();
        if (!text) return;
        send.disabled = true;
        send.textContent = "Sending…";
        void api.addRepairRequest(text)
          .then(() => {
            box.value = "";
            toast("Queued. agency-repair reads it at the start of its next run.");
            void requestsView().render(host);
          })
          .catch((e: Error) => {
            toast(`Could not queue that: ${e.message}`, "error");
            send.disabled = false;
            send.textContent = "Send to agency-repair";
          });
      };
      send.addEventListener("click", submit);
      // Ctrl/Cmd+Enter submits. Plain Enter must stay a newline: these are
      // multi-sentence descriptions of a bug, and a textarea that sends on Enter
      // truncates half of them at the first line break.
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      });

      frag.append(el("div", { class: "request-compose" },
        box,
        el("div", { class: "row-foot" }, count, send),
        // The caveat rides with the box that creates the expectation, and it is
        // the server's own words rather than a second copy of them drifting out
        // of step in the client.
        el("p", { class: "request-caveat" }, data.note)));

      /* --------------------------------------------------------- the queue */

      const open = data.requests.filter((r) => r.status === "open");
      const closed = data.requests.filter((r) => r.status === "closed").slice(0, 10);

      frag.append(sectionHead("Open", open.length === 0 ? "nothing queued" : `${open.length} waiting`));
      if (open.length === 0) {
        frag.append(emptyRow("Nothing queued. Anything you send sits here until a run picks it up, and stays until you close it."));
      } else {
        const rows = el("div", { class: "rows" });
        for (const r of open) rows.append(requestRow(r, host));
        frag.append(rows);
      }

      if (closed.length > 0) {
        frag.append(sectionHead("Closed", `${closed.length} most recent`));
        const rows = el("div", { class: "rows" });
        for (const r of closed) rows.append(requestRow(r, host));
        frag.append(rows);
      }

      host.replaceChildren(frag);
      sync();
    },
  };
}

/** One request. Rendered the same open or closed, because the difference is in
 *  the labels and the actions, not in a second layout to keep in step. */
function requestRow(r: RepairRequest, host: HTMLElement): HTMLElement {
  const row = el("div", { class: "row row-neutral" });
  row.style.cursor = "default";

  const when = new Date(r.createdAt);
  const stamp = Number.isNaN(when.getTime())
    ? r.createdAt
    : when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  // "queued" and "seen" are different facts and the panel says which. A run that
  // has read a request but left it open has made a decision about it; one that
  // has never seen it has not.
  const state = r.status === "closed"
    ? "closed"
    : r.pickedUpBy
      ? `seen by ${r.pickedUpBy}`
      : "queued";

  row.append(el("div", { class: "row-top" },
    el("span", { class: "row-name request-text" }, r.text),
  ));

  const foot = el("div", { class: "row-foot" },
    el("span", { class: "row-meta" }, stamp, "  ·  ", state));

  if (r.status === "open") {
    const btn = el("button", { class: "btn btn-ghost", type: "button" }, "Close") as HTMLButtonElement;
    btn.title = "Take it off the queue. This does not undo anything the bot already did.";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      void api.closeRepairRequest(r.id)
        .then(() => { void requestsView().render(host); })
        .catch((e: Error) => { toast(`Could not close that: ${e.message}`, "error"); btn.disabled = false; });
    });
    foot.append(btn);
  }

  row.append(foot);
  return row;
}

export function repairsView(onChanged: () => void): PanelView {
  return {
    id: "repairs",
    label: "Repairs",
    render: async (host) => {
      host.replaceChildren(emptyRow("Loading repair batches…"));
      let batches: RepairBatch[];
      let note: string;
      try {
        ({ batches, note } = await api.repairs());
      } catch (e) {
        host.replaceChildren(emptyRow(`Could not list repairs: ${(e as Error).message}`));
        return;
      }

      const frag = document.createDocumentFragment();
      frag.append(sectionHead("Repair batches", note));

      if (batches.length === 0) {
        frag.append(emptyRow("No repairs applied. Every Tier A edit is snapshotted here before it happens, so this list is also the undo history."));
        host.replaceChildren(frag);
        return;
      }

      const rows = el("div", { class: "rows" });
      for (const b of batches) {
        // No data-status: a repair batch has no run status, and borrowing a
        // reserved status colour to decorate one would make green mean two
        // things. Same reasoning as the quarantine rows.
        const row = el("div", { class: "row row-neutral" });
        row.style.cursor = "default";

        const head = el("div", { class: "row-top" },
          el("span", { class: "row-name" }, b.batchId),
          ...(b.revertedAt ? [el("span", { class: "row-meta muted" }, "reverted")] : []));

        const foot = el("div", { class: "row-foot" },
          el("span", { class: "row-meta" },
            el("b", {}, String(b.fileCount)), b.fileCount === 1 ? " file  ·  " : " files  ·  ",
            el("b", {}, String(b.modified)), " modified  ·  ",
            el("b", {}, String(b.created)), " created"));

        if (!b.revertedAt && b.fileCount > 0) {
          const btn = el("button", { class: "btn", type: "button" }, "Revert");
          let armed = false;
          let timer: number | undefined;
          btn.addEventListener("click", () => {
            if (!armed) {
              armed = true;
              btn.textContent = "Confirm revert";
              btn.setAttribute("data-armed", "true");
              timer = window.setTimeout(() => {
                armed = false; btn.textContent = "Revert"; btn.removeAttribute("data-armed");
              }, 4000);
              return;
            }
            window.clearTimeout(timer);
            btn.setAttribute("disabled", "");
            void api.revertRepair(b.batchId)
              .then((r) => {
                toast(r.exitCode === 0 ? `Reverted ${b.batchId}` : `Revert exited ${r.exitCode}`,
                  r.exitCode === 0 ? "info" : "error");
                onChanged();
              })
              .catch((e) => toast(String(e), "error"));
          });
          foot.append(btn);
        }

        row.append(head, foot);
        // The file list is the audit trail. Collapsed because it can be long,
        // present because "12 files" is not something to take on trust.
        if (b.files.length) {
          const details = el("details", { class: "file-list" });
          details.append(el("summary", {}, `${b.files.length} file${b.files.length === 1 ? "" : "s"}`));
          const ul = el("ul", {});
          for (const f of b.files) ul.append(el("li", {}, `${f.action === "created" ? "+ " : "~ "}${f.path}`));
          details.append(ul);
          row.append(details);
        }
        rows.append(row);
      }
      frag.append(rows);
      host.replaceChildren(frag);
    },
  };
}
