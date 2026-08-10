#!/usr/bin/env node
/**
 * live-artifact — render a bot run's facts file into one self-contained HTML page.
 *
 * The whole point of this file is that a model never has to open it. It holds the
 * template so a run only has to emit a small JSON facts file; see SKILL.md for
 * the shape and the token arithmetic.
 *
 * Usage:
 *   node render.mjs --in runs/<bot>/<date>.artifact.json --out runs/<bot>/<date>.html
 *   node render.mjs --in <facts.json> --dry-run
 *
 * Exit codes: 0 written (or validated, under --dry-run), 1 bad usage or invalid
 * facts, 2 could not read or write. A non-zero exit is meant to fail a run
 * loudly rather than leave a bot reporting success over a missing page.
 *
 * ## Two things here are load-bearing and look cosmetic
 *
 * 1. Status text is painted on #1a1a19 and nothing else. That is the Agency's
 *    validated `--surface`, the exact background every status contrast figure in
 *    interface-design/design/design-dna.json was measured against (ok 5.19,
 *    partial 9.49, failed 3.62, never_run 4.62, running 4.28). Put a status
 *    colour on the page background instead and every one of those figures is a
 *    guess again. failed #d03b3b clears its requirement at 3.62:1 with nothing
 *    to spare.
 *
 * 2. There is no <script> tag and no remote URL, by construction. The output is
 *    static markup plus one inline <style>. That is what makes the page safe to
 *    double-click a year from now, and what makes it render with the network
 *    cable out — the same constraint that put Geist in dashboard/public/ instead
 *    of on a CDN. Fonts are therefore system stacks, not Geist: an artifact
 *    travels away from dashboard/public/ and a font that 404s is worse than a
 *    font that was never asked for.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** .claude/skills/live-artifact -> .claude/skills -> .claude -> Agency */
const AGENCY_ROOT = resolve(HERE, "..", "..", "..");

const STATUS = {
  ok:        { color: "#0ca30c", glyph: "&#10003;", label: "ok" },
  partial:   { color: "#fab219", glyph: "&#9650;",  label: "partial" },
  failed:    { color: "#d03b3b", glyph: "&#10007;", label: "failed" },
  never_run: { color: "#898781", glyph: "&ndash;",  label: "never run" },
  running:   { color: "#3987e5", glyph: "&#9679;",  label: "running" },
};

/** Categorical slots, fixed order, never cycled past four. Bars only. */
const CAT = ["#3987e5", "#d95926", "#199e70", "#c98500"];

const KINDS = new Set(["text", "list", "table", "bars"]);

/* ----------------------------------------------------------------- helpers */

function die(code, message) {
  process.stderr.write(`live-artifact: ${message}\n`);
  process.exit(code);
}

/**
 * HTML escape, applied to every single string that reaches the output.
 *
 * Ampersand first — escaping it after the others would double-escape the
 * entities they just produced.
 */
function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Prose: escaped, then blank lines become paragraphs and single newlines become
 * spaces. Deliberately not a markdown renderer — the run report is the markdown
 * and this page is the summary of it. One syntax to be wrong about is enough.
 */
function paragraphs(text) {
  return String(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, " ")}</p>`)
    .join("\n");
}

/**
 * A URL safe to put in href. Same-directory relative paths are the normal case
 * (the run report next to the page). Anything with a scheme is allowed only if
 * that scheme is http, https, mailto or file — which is what keeps a
 * `javascript:` link out of a page that otherwise cannot execute anything.
 */
function safeHref(href) {
  const s = String(href).trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    return /^(https?|mailto|file):/i.test(s) ? s : null;
  }
  return s;
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/* -------------------------------------------------------------- validation */

/**
 * Validate the facts and collect EVERY problem before failing.
 *
 * One error per run means a bot fixing three typos needs three runs to find
 * them, and an unattended bot gets one shot a week.
 */
function validate(facts) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  if (!isPlainObject(facts)) return ["the facts file must be a JSON object"];

  need(typeof facts.bot === "string" && facts.bot.trim(), "`bot` is required and must be a non-empty string");
  need(typeof facts.title === "string" && facts.title.trim(), "`title` is required and must be a non-empty string");
  need(
    typeof facts.status === "string" && Object.prototype.hasOwnProperty.call(STATUS, facts.status),
    `\`status\` is required and must be one of ${Object.keys(STATUS).join(", ")}`,
  );

  for (const key of ["summary"]) {
    if (facts[key] !== undefined && typeof facts[key] !== "string") errors.push(`\`${key}\` must be a string`);
  }
  if (facts.timestamp !== undefined && typeof facts.timestamp !== "string") {
    errors.push("`timestamp` must be a string");
  }

  if (facts.metrics !== undefined) {
    if (!Array.isArray(facts.metrics)) errors.push("`metrics` must be an array");
    else facts.metrics.forEach((m, i) => {
      if (!isPlainObject(m)) { errors.push(`metrics[${i}] must be an object`); return; }
      if (typeof m.label !== "string" || !m.label.trim()) errors.push(`metrics[${i}].label is required`);
      if (m.value === undefined || m.value === null) errors.push(`metrics[${i}].value is required`);
    });
  }

  for (const key of ["holding", "failed"]) {
    if (facts[key] === undefined) continue;
    if (!Array.isArray(facts[key])) { errors.push(`\`${key}\` must be an array of strings`); continue; }
    facts[key].forEach((s, i) => {
      if (typeof s !== "string") errors.push(`${key}[${i}] must be a string`);
    });
  }

  if (facts.links !== undefined) {
    if (!Array.isArray(facts.links)) errors.push("`links` must be an array");
    else facts.links.forEach((l, i) => {
      if (!isPlainObject(l)) { errors.push(`links[${i}] must be an object`); return; }
      if (typeof l.label !== "string" || !l.label.trim()) errors.push(`links[${i}].label is required`);
      if (typeof l.href !== "string" || !l.href.trim()) errors.push(`links[${i}].href is required`);
      else if (safeHref(l.href) === null) errors.push(`links[${i}].href uses a scheme that is not allowed (http, https, mailto, file only)`);
    });
  }

  if (facts.sections !== undefined) {
    if (!Array.isArray(facts.sections)) errors.push("`sections` must be an array");
    else facts.sections.forEach((s, i) => {
      const at = `sections[${i}]`;
      if (!isPlainObject(s)) { errors.push(`${at} must be an object`); return; }
      if (typeof s.heading !== "string" || !s.heading.trim()) errors.push(`${at}.heading is required`);
      if (!KINDS.has(s.kind)) { errors.push(`${at}.kind must be one of ${[...KINDS].join(", ")}`); return; }

      if (s.kind === "text") {
        if (typeof s.body !== "string" || !s.body.trim()) errors.push(`${at}.body is required for kind "text"`);
      }
      if (s.kind === "list") {
        if (!Array.isArray(s.items) || s.items.length === 0) errors.push(`${at}.items must be a non-empty array for kind "list"`);
        else s.items.forEach((it, j) => { if (typeof it !== "string") errors.push(`${at}.items[${j}] must be a string`); });
      }
      if (s.kind === "table") {
        if (!Array.isArray(s.columns) || s.columns.length === 0) errors.push(`${at}.columns must be a non-empty array for kind "table"`);
        if (!Array.isArray(s.rows) || s.rows.length === 0) errors.push(`${at}.rows must be a non-empty array for kind "table"`);
        else s.rows.forEach((r, j) => {
          if (!Array.isArray(r)) { errors.push(`${at}.rows[${j}] must be an array`); return; }
          if (Array.isArray(s.columns) && r.length !== s.columns.length) {
            errors.push(`${at}.rows[${j}] has ${r.length} cells but there are ${s.columns.length} columns`);
          }
        });
      }
      if (s.kind === "bars") {
        if (!Array.isArray(s.items) || s.items.length === 0) errors.push(`${at}.items must be a non-empty array for kind "bars"`);
        else s.items.forEach((it, j) => {
          if (!isPlainObject(it)) { errors.push(`${at}.items[${j}] must be an object`); return; }
          if (typeof it.label !== "string" || !it.label.trim()) errors.push(`${at}.items[${j}].label is required`);
          if (typeof it.value !== "number" || !Number.isFinite(it.value)) {
            errors.push(`${at}.items[${j}].value must be a finite number — bar widths are proportional and a string cannot be`);
          }
        });
      }
    });
  }

  return errors;
}

/* ----------------------------------------------------------------- render */

function renderMetrics(metrics) {
  if (!metrics || metrics.length === 0) return "";
  const [lead, ...rest] = metrics;
  const unit = lead.unit ? `<span class="u">${esc(lead.unit)}</span>` : "";
  const note = lead.note ? `<div class="note">${esc(lead.note)}</div>` : "";
  let out = `<div class="lead">
  <div class="eyebrow">${esc(lead.label)}</div>
  <div class="figure">${esc(lead.value)}${unit}</div>
  ${note}
</div>`;

  if (rest.length) {
    out += '\n<div class="ledger">\n';
    for (const m of rest) {
      const u = m.unit ? ` ${esc(m.unit)}` : "";
      const n = m.note ? `<span class="sub">${esc(m.note)}</span>` : "";
      out += `  <div class="line"><span>${esc(m.label)}${n}</span><b>${esc(m.value)}${u}</b></div>\n`;
    }
    out += "</div>";
  }
  return out;
}

function renderSection(sec) {
  const head = `<h2>${esc(sec.heading)}</h2>`;
  let body = "";

  if (sec.kind === "text") {
    body = `<div class="prose">${paragraphs(sec.body)}</div>`;
  } else if (sec.kind === "list") {
    body = `<ul>\n${sec.items.map((i) => `  <li>${esc(i)}</li>`).join("\n")}\n</ul>`;
  } else if (sec.kind === "table") {
    // Columns after the first are right-aligned and tabular: the first column is
    // the name of the thing and the rest are figures that have to stack.
    const ths = sec.columns
      .map((c, i) => `<th${i > 0 ? ' class="num"' : ""}>${esc(c)}</th>`)
      .join("");
    const trs = sec.rows
      .map((r) => `  <tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ""}>${esc(c ?? "")}</td>`).join("")}</tr>`)
      .join("\n");
    body = `<table>\n<thead><tr>${ths}</tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>`;
  } else if (sec.kind === "bars") {
    // Proportional to the largest value, not to the total: a stacked-to-100%
    // bar implies the parts are the whole, and a scan's categories are not.
    const max = Math.max(...sec.items.map((i) => Math.abs(i.value)), 0);
    const rows = sec.items.map((it, i) => {
      const pct = max > 0 ? (Math.abs(it.value) / max) * 100 : 0;
      const unit = it.unit ? ` ${esc(it.unit)}` : "";
      const note = it.note ? `<span class="sub">${esc(it.note)}</span>` : "";
      return `  <div class="bar-row">
    <div class="bar-head"><span>${esc(it.label)}${note}</span><b>${esc(it.value)}${unit}</b></div>
    <div class="bar-track"><span style="width:${pct.toFixed(2)}%;background:${CAT[i % CAT.length]}"></span></div>
  </div>`;
    }).join("\n");
    body = `<div class="bars">\n${rows}\n</div>`;
  }

  return `<section>\n${head}\n${body}\n</section>`;
}

function renderNotes(heading, items, kind) {
  if (!items || items.length === 0) return "";
  const li = items.map((i) => `  <li>${esc(i)}</li>`).join("\n");
  return `<section class="notes ${kind}">\n<h2>${esc(heading)}</h2>\n<ul>\n${li}\n</ul>\n</section>`;
}

function renderLinks(links) {
  if (!links || links.length === 0) return "";
  const a = links.map((l) => {
    const href = safeHref(l.href);
    // Already validated, so a null here cannot happen; degrade to plain text
    // rather than emit href="null" if it ever does.
    return href === null
      ? `  <span class="chipl">${esc(l.label)}</span>`
      : `  <a class="chipl" href="${esc(href)}">${esc(l.label)}</a>`;
  }).join("\n");
  return `<section class="links">\n<h2>Files</h2>\n<div class="chips">\n${a}\n</div>\n</section>`;
}

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:dark}
body{
  margin:0;padding:48px 24px 96px;background:#0d0d0d;color:#fff;line-height:1.55;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:880px;margin:0 auto}
.mono{font-family:ui-monospace,"Cascadia Code",Consolas,"SF Mono",monospace}
.eyebrow,.stamp,h2,th,.line,.bar-head,.chipl,.status{
  font-family:ui-monospace,"Cascadia Code",Consolas,"SF Mono",monospace;
  text-transform:uppercase;letter-spacing:.14em;font-size:11px;
}
header{border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:20px;margin-bottom:32px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:20px;font-weight:500;letter-spacing:-.015em}
.bot{color:#898781;font-weight:400}
.stamp{color:#898781;letter-spacing:.06em}
/* The one surface painted #1a1a19: the Agency's validated --surface, and the
   only background any status colour is measured against. */
.status{
  display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border-radius:2px;
  background:#1a1a19;font-weight:500;
}
.summary{font-size:15px;color:#c3c2b7;margin:20px 0 0;max-width:68ch}
.lead{margin:0 0 24px}
.eyebrow{color:#898781;font-weight:500}
.figure{font-size:44px;font-weight:300;letter-spacing:-.035em;line-height:1;margin:12px 0}
.figure .u{font-size:.34em;font-weight:400;letter-spacing:.02em;color:#898781;margin-left:.35em}
.note{font-family:ui-monospace,Consolas,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#898781}
.ledger{display:flex;flex-direction:column;margin-bottom:8px}
.line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:8px 0;
  border-top:1px solid rgba(255,255,255,.06);color:#898781}
.line b{color:#c3c2b7;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.sub{display:block;text-transform:none;letter-spacing:0;font-size:11px;color:#6f6d68;margin-top:2px}
section{margin:36px 0 0}
h2{margin:0 0 14px;padding-bottom:8px;color:#c3c2b7;font-weight:500;
  border-bottom:1px solid rgba(255,255,255,.06)}
.prose{color:#c3c2b7;max-width:68ch}
.prose p{margin:0 0 12px}
ul{margin:0;padding-left:18px;color:#c3c2b7}
li{margin-bottom:6px}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 16px 9px 0;border-bottom:1px solid rgba(255,255,255,.06)}
th{color:#898781;font-weight:500}
td:first-child{font-family:ui-monospace,Consolas,monospace;color:#fff}
th.num,td.num{text-align:right;padding-right:0;font-family:ui-monospace,Consolas,monospace}
td.num{color:#c3c2b7}
.bars{display:flex;flex-direction:column;gap:14px}
.bar-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:#898781;margin-bottom:6px}
.bar-head b{color:#c3c2b7;font-weight:500;font-variant-numeric:tabular-nums}
.bar-track{height:6px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden}
.bar-track span{display:block;height:100%}
.notes ul{color:#c3c2b7}
.notes.holding h2{color:#fab219}
.notes.failed h2{color:#d03b3b}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chipl{display:inline-block;padding:5px 9px;border:1px solid rgba(255,255,255,.1);border-radius:2px;
  color:#c3c2b7;text-decoration:none}
a.chipl:hover{border-color:rgba(255,255,255,.28);color:#fff}
footer{margin-top:56px;padding-top:16px;border-top:1px solid rgba(255,255,255,.06);
  font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#6f6d68;max-width:68ch;line-height:1.7}
@media print{body{background:#fff;color:#000}.status{background:#eee}}
`.trim();

function renderPage(facts) {
  const st = STATUS[facts.status];
  const stamp = facts.timestamp ? esc(facts.timestamp) : "";
  const summary = facts.summary ? `<p class="summary">${esc(facts.summary)}</p>` : "";

  const parts = [
    renderMetrics(facts.metrics),
    ...(facts.sections ?? []).map(renderSection),
    renderNotes("Holding", facts.holding, "holding"),
    renderNotes("Failed", facts.failed, "failed"),
    renderLinks(facts.links),
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(facts.bot)} — ${esc(facts.title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="top">
    <h1><span class="bot">${esc(facts.bot)}</span> &nbsp;${esc(facts.title)}</h1>
    <span class="status" style="color:${st.color}"><span aria-hidden="true">${st.glyph}</span>${st.label}</span>
  </div>
  ${stamp ? `<div class="stamp">${stamp}</div>` : ""}
  ${summary}
</header>
${parts.join("\n")}
<footer>
Rendered by the Agency's <code>live-artifact</code> skill. This page is static:
no scripts, no network requests, nothing to install. It is a snapshot of one run,
not a live view &mdash; the control plane at <code>dashboard/</code> is the live view.
</footer>
</div>
</body>
</html>
`;
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  const out = { in: null, out: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") out.in = argv[++i] ?? null;
    else if (a === "--out") out.out = argv[++i] ?? null;
    else if (a === "--dry-run" || a === "-DryRun") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else die(1, `unknown argument ${a}`);
  }
  return out;
}

const USAGE = `usage: node render.mjs --in <facts.json> [--out <page.html>] [--dry-run]

  --in       the facts file. See SKILL.md for the shape.
  --out      where to write the page. Required unless --dry-run.
  --dry-run  validate and report, write nothing.
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }
  if (!args.in) die(1, `--in is required\n\n${USAGE}`);
  if (!args.out && !args.dryRun) die(1, `--out is required unless --dry-run\n\n${USAGE}`);

  const inPath = isAbsolute(args.in) ? args.in : resolve(process.cwd(), args.in);
  let raw;
  try {
    raw = readFileSync(inPath, "utf8");
  } catch (e) {
    die(2, `could not read ${inPath}: ${e.message}`);
  }

  let facts;
  try {
    // Strip a UTF-8 BOM. PowerShell's Out-File and Set-Content both write one by
    // default on this machine, and JSON.parse rejects it with an error that
    // points at character 0 and explains nothing.
    facts = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    die(1, `${inPath} is not valid JSON: ${e.message}`);
  }

  const errors = validate(facts);
  if (errors.length) {
    process.stderr.write(`live-artifact: ${errors.length} problem${errors.length === 1 ? "" : "s"} in ${inPath}\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  const html = renderPage(facts);
  const bytes = Buffer.byteLength(html, "utf8");

  if (args.dryRun) {
    const target = args.out ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)) : "(no --out given)";
    process.stdout.write(
      `live-artifact: DRY RUN — nothing written.\n` +
      `  facts    ${inPath}\n` +
      `  would write ${target}\n` +
      `  ${bytes} bytes, status ${facts.status}, ` +
      `${(facts.metrics ?? []).length} metric(s), ${(facts.sections ?? []).length} section(s), ` +
      `${(facts.holding ?? []).length} holding, ${(facts.failed ?? []).length} failed\n`,
    );
    return;
  }

  const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
  // A bot may not write outside the Agency. relative() starting with ".." means
  // the target escaped the root, which catches both an absolute path elsewhere
  // and a traversal sequence, in one check.
  const rel = relative(AGENCY_ROOT, outPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    die(1, `--out must be inside ${AGENCY_ROOT} (got ${outPath})`);
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
  } catch (e) {
    die(2, `could not write ${outPath}: ${e.message}`);
  }

  process.stdout.write(`live-artifact: wrote ${outPath} (${bytes} bytes)\n`);
}

main();
