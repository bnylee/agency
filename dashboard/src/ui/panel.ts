import { api, type Bot } from "../api";
import { enterPanel, exitPanel, b as dur, D, E, reduced } from "../motion/registers";
import { el, ledgerLine, sectionHead, statusChip, toast } from "./components";
import { renderMarkdown } from "./markdown";
import { clampValue, digestReport, statusRole, themeFor } from "./theme";
import gsap from "gsap";

/* ------------------------------------------------------------- options ---- */

/**
 * One thing a bot can be told to do, rendered as a button in the Options block.
 *
 * `confirm` exists because some options are not symmetrical with closing the
 * panel again — restoring a quarantine batch or reverting a repair moves files
 * on disk. Those get a second press; a run trigger does not.
 */
export interface PanelAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
  confirm?: string;
}

/**
 * A tab in the panel body. Reports is supplied by this module for every bot;
 * anything else (a portfolio, a repair log) is passed in by the caller, because
 * only the caller knows which bot has one.
 */
export interface PanelView {
  id: string;
  label: string;
  render: (host: HTMLElement) => void | Promise<void>;
  /**
   * Open on this view instead of on Reports.
   *
   * Reports is the right default for almost every bot: the run report IS the
   * deliverable, and the live state is a detail of it. media-bot is the exception —
   * its digest is the product and the report is the record of how the digest was
   * assembled — so the ordering is a per-view opt-in rather than a fixed rule or a
   * hardcoded check on a bot id in here.
   */
  lead?: boolean;
}

export interface PanelSpec {
  actions?: PanelAction[];
  views?: PanelView[];
  /** Extra mono facts appended to the Options ledger. */
  facts?: [string, string][];
  /**
   * Why an option you might expect is not here. A bot with no trigger needs to
   * say so — an empty action bar reads as a loading state, not as a boundary.
   */
  notes?: string[];
}

/* ------------------------------------------------------------ panel ---- */

let current: { panel: HTMLElement; onClose: () => void; esc: (e: KeyboardEvent) => void } | null = null;

/** Width the open panel covers, so the scene can re-centre into what is left. */
export function panelWidth(): number {
  return current ? current.panel.getBoundingClientRect().width : 0;
}

export function closePanel(): void {
  if (!current) return;
  const { panel, onClose, esc } = current;
  current = null;
  // Removed here rather than inside the handler. Removing it only when Escape
  // actually fired leaked one listener per panel opened by any other route,
  // and every stale one still closed the panel — so after a few opens, one
  // Escape fired closePanel several times.
  document.removeEventListener("keydown", esc);
  onClose();
  if (reduced.matches) { panel.remove(); return; }
  gsap.to(panel, {
    xPercent: 100,
    duration: dur(D.sheet),
    ease: E.sheet,
    onComplete: () => panel.remove(),
  });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function fmtNext(iso: string | null): string {
  if (!iso) return "on demand";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * The Options block: what this bot can be told to do, and the facts you need to
 * decide whether to. It carries no motion of its own — it arrives on the
 * sheet's 500ms travel and then holds still. A stagger here would be a second
 * animation on a surface opened many times a day, which is exactly what the
 * frequency rule spends its budget avoiding.
 */
function optionsBlock(bot: Bot, spec: PanelSpec): HTMLElement {
  const root = el("section", { class: "options", "aria-label": "Options" });
  root.append(sectionHead("Options", bot.cadence));

  const bar = el("div", { class: "option-actions" });

  for (const action of spec.actions ?? []) {
    const btn = el("button", { class: "btn", type: "button" }, action.label);
    if (action.disabled) btn.setAttribute("disabled", "");

    if (action.confirm) {
      // Two-press confirm rather than a modal. A dialog over a sheet is a stack
      // of two overlays to escape from, and the thing being guarded is
      // reversible anyway; what it needs is a deliberate second press, not a
      // ceremony. Resets after 4s so a stray click cannot arm it indefinitely.
      let armed = false;
      let timer: number | undefined;
      btn.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          btn.textContent = action.confirm!;
          btn.setAttribute("data-armed", "true");
          timer = window.setTimeout(() => {
            armed = false;
            btn.textContent = action.label;
            btn.removeAttribute("data-armed");
          }, 4000);
          return;
        }
        window.clearTimeout(timer);
        armed = false;
        btn.textContent = action.label;
        btn.removeAttribute("data-armed");
        void action.run();
      });
    } else {
      btn.addEventListener("click", () => void action.run());
    }
    bar.append(btn);
  }

  for (const note of spec.notes ?? []) bar.append(el("span", { class: "row-meta muted" }, note));
  root.append(bar);

  const facts = el("div", { class: "ledger" });
  facts.append(ledgerLine("Next run", fmtNext(bot.nextRun)));
  facts.append(ledgerLine("Last run", bot.lastRunDate ?? "never"));
  facts.append(ledgerLine("Recorded runs", bot.runCount === 0 ? "—" : String(bot.runCount)));
  facts.append(ledgerLine("Token spend", bot.runCount === 0 ? "—" : `${(bot.totalTokens / 1000).toFixed(1)} k`));
  for (const [k, v] of spec.facts ?? []) facts.append(ledgerLine(k, v));
  root.append(facts);

  return root;
}

/* ------------------------------------------------------------ reports ---- */

/** The Reports view. Every bot has one, so this module owns it. */
function reportsView(bot: Bot): PanelView {
  return {
    id: "reports",
    label: "Reports",
    render: async (host) => {
      host.replaceChildren(el("div", { class: "empty" }, "Loading reports…"));
      let runs: string[];
      try {
        ({ runs } = await api.runs(bot.id));
      } catch (e) {
        host.replaceChildren(el("div", { class: "empty" }, `Could not list runs: ${(e as Error).message}`));
        toast((e as Error).message, "error");
        return;
      }

      if (runs.length === 0) {
        host.replaceChildren(el("div", { class: "empty" },
          `${bot.name} has no run reports yet. ${bot.triggerable ? "Trigger a run to produce one." : "This bot is interactive-only."}`));
        return;
      }

      const picker = el("div", { class: "run-picker" });
      const digestHost = el("div", { class: "digest" });
      const article = el("article", { class: "report" });
      host.replaceChildren(picker, digestHost, article);

      const show = async (date: string) => {
        for (const child of picker.children) {
          child.setAttribute("aria-pressed", String(child.getAttribute("data-date") === date));
        }
        digestHost.replaceChildren();
        article.replaceChildren(el("div", { class: "empty" }, "Loading…"));
        try {
          const { body: md } = await api.report(bot.id, date);
          const d = digestReport(md);

          if (d.fields.length) {
            // The digest answers the four questions you opened the panel to ask.
            // The full report goes behind a disclosure below it — nothing is
            // hidden that was not already several screens down.
            const strip = el("div", { class: "digest-fields" });
            const role = statusRole(d.status);
            if (d.status) {
              const line = el("div", { class: "digest-status" },
                el("span", { class: "digest-label" }, "Status"),
                // Carries its own --surface background via .chip, so its contrast
                // figures hold whatever the bot's theme paints around it.
                el("span", { class: "chip", ...(role ? { "data-status": role } : {}) },
                  el("span", { class: "glyph", "aria-hidden": "true" },
                    role === "ok" ? "✓" : role === "partial" ? "▲" : role === "failed" ? "✕" : "–"),
                  d.status));
              strip.append(line);
            }
            for (const f of d.fields) {
              // Empty fields are dropped rather than rendered blank. "Holding —
              // nothing." is worth showing; a field with no text at all is noise.
              if (!f.value || /^(nothing|none|n\/a|—|-)\.?$/i.test(f.value)) {
                strip.append(el("div", { class: "digest-field digest-empty" },
                  el("span", { class: "digest-label" }, f.label),
                  el("span", { class: "digest-value muted" }, "nothing")));
                continue;
              }
              const value = el("span", { class: "digest-value" });
              // Clamped, because a real `Did` paragraph runs to 400 characters and
              // the digest is meant to be scannable. Safe only because the full text
              // is one disclosure away — see `rest` in theme.ts.
              const { text, clamped } = clampValue(f.value);
              // Through the same inline renderer as the report, so `code` spans and
              // file paths in a Did line are formatted rather than shown raw.
              value.innerHTML = renderMarkdown(text);
              if (clamped) value.append(el("span", { class: "digest-more" }, "full text below"));
              strip.append(el("div", {
                class: "digest-field",
                "data-field": f.label.toLowerCase().replace(/\s+/g, "-"),
              }, el("span", { class: "digest-label" }, f.label), value));
            }
            // More than one `## ` block means something was APPENDED after the
            // agent finished — every run script here writes a failure block that
            // way, and finance-research appends a queue refusal. The digest shows
            // the FIRST block, so a second one may contradict it and the reader has
            // to be told rather than left to scroll and discover it.
            if (d.blocks > 1) {
              strip.append(el("div", { class: "digest-field digest-appended" },
                el("span", { class: "digest-label" }, "Note"),
                el("span", { class: "digest-value" },
                  `This report has ${d.blocks} blocks — something was appended after the run wrote its `
                  + `report, usually a failure or a refusal. The summary above is the first block only. `
                  + `Open the full report.`)));
            }
            digestHost.append(strip);

            if (d.rest) {
              const details = el("details", { class: "report-full" });
              details.append(el("summary", {}, "Full report"));
              const body = el("article", { class: "report" });
              body.innerHTML = renderMarkdown(d.rest);
              details.append(body);
              article.replaceChildren(details);
            } else {
              article.replaceChildren();
            }
            return;
          }

          // No recognisable digest — a freeform report, or a failure block a shell
          // script appended after the agent died. Rendered exactly as before,
          // because that is the report you most need to be able to read.
          article.innerHTML = renderMarkdown(md);
        } catch (e) {
          article.replaceChildren(el("div", { class: "empty" }, `Could not load ${date}: ${(e as Error).message}`));
        }
      };

      for (const date of runs.slice(0, 12)) {
        const btn = el("button", { class: "btn btn-ghost", type: "button", "data-date": date, "aria-pressed": "false" }, date);
        btn.addEventListener("click", () => void show(date));
        picker.append(btn);
      }

      /**
       * Open the standalone page this run rendered, if it rendered one.
       *
       * Fetched with the token in a header and then opened as a Blob, rather than
       * linked to directly. A plain link sends no custom header, so a direct
       * `text/html` endpoint would need the token in the query string — in history
       * and in the referer — and this server's whole CSRF defence is that the token
       * is a header and never a cookie.
       *
       * Rendered on demand rather than probed on load: probing would add one
       * request per date change to answer a question nobody asked yet.
       */
      const pageBtn = el("button", { class: "btn", type: "button" }, "Open page");
      pageBtn.addEventListener("click", () => {
        const date = [...picker.children].find((c) => c.getAttribute("aria-pressed") === "true")
          ?.getAttribute("data-date") ?? runs[0]!;
        void api.page(bot.id, date)
          .then(({ html }) => {
            const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
            const win = window.open(url, "_blank", "noopener");
            if (!win) { toast("The browser blocked the new tab", "error"); URL.revokeObjectURL(url); return; }
            // Revoked on a timer, not immediately: revoking before the new tab has
            // finished loading the blob gives a blank page. 60s is far longer than
            // any load of an 8 KB document needs and the object is freed either way
            // when the tab closes.
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          })
          .catch((e) => toast(
            `${date} rendered no page. ${(e as Error).message}`
            + " — pages come from the live-artifact skill and only exist for runs since it was added.",
            "error"));
      });
      picker.append(pageBtn);

      await show(runs[0]!);
    },
  };
}

/* --------------------------------------------------------------- open ---- */

export async function openPanel(bot: Bot, spec: PanelSpec, onClose: () => void): Promise<void> {
  closePanel();
  const root = document.getElementById("panel-root")!;

  // No scrim, and the panel is NOT aria-modal.
  //
  // It was both, and that made the rail and the studio unclickable for as long
  // as a panel was open — you had to close one bot before you could look at the
  // next. The motion spec says of Register A that it "never blocks interaction;
  // the user can click through it at any moment", and a full-viewport overlay
  // is the most complete way to break that.
  //
  // The scrim's two jobs are both already done better elsewhere: the scene dims
  // itself through setDimmed and pushes every unfocused body back, which is a
  // dim bound to real state rather than a grey rectangle; and click-away still
  // closes, because a click on empty space in the stage reaches the canvas,
  // misses every body, and sends a null selection. Escape and Close remain.
  // `data-bot` is what selects the theme in styles.css. A bot with no theme block
  // there simply inherits the house face, which is why a new bot never arrives
  // looking broken — it arrives looking plain, and plain is a correct default.
  const theme = themeFor(bot.id);
  const panel = el("aside", {
    class: "panel",
    "data-bot": bot.id,
    "aria-label": `${bot.name} options and reports`,
  });
  const closeBtn = el("button", { class: "btn btn-ghost", type: "button", "aria-label": "Close" }, "Close");
  closeBtn.addEventListener("click", closePanel);

  panel.append(
    el("div", { class: "panel-head" },
      el("div", { class: "panel-title" },
        // The sigil is decoration and says so. It is aria-hidden and it is never
        // the only thing distinguishing one panel from another — the role line and
        // the bot's name both sit next to it, and the theme's type does the rest.
        el("span", { class: "panel-sigil", "aria-hidden": "true" }, theme.sigil),
        el("div", { class: "panel-ident" },
          // The role, not the registry blurb. A blurb reads as a spec ("Disk
          // reclamation, quarantine only"); this answers "what is this for".
          el("div", { class: "panel-role" }, theme.role),
          el("h2", {}, bot.name)),
        statusChip(bot.status)),
      closeBtn),
  );

  const body = el("div", { class: "panel-body" });
  panel.append(body);
  root.append(panel);

  if (!reduced.matches) {
    gsap.fromTo(panel, { xPercent: 100 }, { xPercent: 0, duration: dur(D.sheet), ease: E.sheet });
  }

  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closePanel(); };
  document.addEventListener("keydown", esc);
  current = { panel, onClose, esc };

  body.append(optionsBlock(bot, spec));

  // Any view marked `lead` goes in front of Reports. Order is otherwise as given.
  const extras = spec.views ?? [];
  const views = [...extras.filter((v) => v.lead), reportsView(bot), ...extras.filter((v) => !v.lead)];
  const host = el("div", { class: "view-host" });

  if (views.length > 1) {
    const tabs = el("div", { class: "view-tabs", role: "tablist" });
    const select = (id: string) => {
      for (const t of tabs.children) t.setAttribute("aria-pressed", String(t.getAttribute("data-view") === id));
      const view = views.find((v) => v.id === id)!;
      void view.render(host);
    };
    for (const v of views) {
      const btn = el("button", { class: "btn", type: "button", role: "tab", "data-view": v.id, "aria-pressed": "false" }, v.label);
      btn.addEventListener("click", () => select(v.id));
      tabs.append(btn);
    }
    body.append(tabs, host);
    select(views[0]!.id);
  } else {
    body.append(host);
    await views[0]!.render(host);
  }
}

export { enterPanel, exitPanel };
