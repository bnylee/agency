#!/usr/bin/env node
/**
 * Screenshot the real control plane, including behind the token gate.
 *
 *   node scripts/ui-shot.mjs --out <dir> [--width 1500] [--dsf 1] [--bot <id>]
 *
 * Drives headless Chrome over the DevTools Protocol with **no dependencies** —
 * Node 22+ ships a global `WebSocket`, which is the only thing a CDP client
 * actually needs. Puppeteer and Playwright each want a few hundred MB and their
 * own browser download to do what the ~200 lines below do.
 *
 * ## Why this exists when scene-check.html already screenshots the scene
 *
 * `scene-check.html` deliberately bypasses the app: no API, no token, synthetic
 * bots. That is right for checking the GLSL and wrong for checking the interface,
 * because the interface is the part that talks to the server and gates on a token.
 *
 * `index.html` calls `showGate()` and returns unless `localStorage['agency.token']`
 * is already set, so a plain `--screenshot` of the app captures a password prompt.
 * That is not a bug to work around in the app — the gate is the security model.
 * What this script does instead is what a person does: it opens the page, puts the
 * token in, reloads, and clicks.
 *
 * **The token comes from `dashboard/.env` and is never put in a URL**, for the same
 * reason the API takes it as a header: a URL lands in history, in the referer and in
 * any log along the way. It goes in via `Runtime.evaluate` after the origin is
 * loaded, which is the only place localStorage for that origin can be written.
 *
 * ## What it captures
 *
 * One PNG per bot, clipped to the open panel, so the six themes can be compared
 * without a full-viewport screenshot of mostly-empty stage between them. Plus one
 * full-viewport shot with nothing selected, which is the composition the studio was
 * laid out for.
 *
 * Requires the dev server and the API to be running (`npm run dev`).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = resolve(HERE, "..");

const CHROMES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/* --------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = resolve(arg("out", join(DASHBOARD, "..", "ui-shots")));
const WIDTH = Number(arg("width", 1500));
const HEIGHT = Number(arg("height", 950));
const DSF = Number(arg("dsf", 1));
const ONLY = arg("bot", "");
const BASE = arg("url", "http://127.0.0.1:5173/");
const PORT = Number(arg("port", 9333));

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readToken() {
  const envPath = join(DASHBOARD, ".env");
  if (!existsSync(envPath)) die(`no ${envPath} — cannot get past the token gate`);
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*AGENCY_TOKEN\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  die("AGENCY_TOKEN not found in dashboard/.env");
}

function die(msg) {
  process.stderr.write(`ui-shot: ${msg}\n`);
  process.exit(1);
}

/** Poll an HTTP endpoint until it answers. Chrome's debug port is not instant. */
async function waitForJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  die(`${url} never answered`);
}

/* ---------------------------------------------------------------- CDP client */

/**
 * The smallest thing that can be called a CDP client.
 *
 * One websocket, one incrementing id, one map of pending resolvers. CDP is
 * request/response with an `id` echoed back, so that is the whole protocol as far
 * as this script is concerned; events arrive without an `id` and are ignored.
 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.method ?? "CDP"}: ${msg.error.message}`));
        else ok(msg.result);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", () => bad(new Error(`could not open ${wsUrl}`)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { resolve: ok, reject: bad });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in the page and return the value. Throws on a page-side throw. */
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  /**
   * Poll an expression until it is truthy.
   *
   * Polling rather than waiting on a load event, because everything interesting
   * here happens AFTER load: the app fetches `/api/bots`, renders rows, and only
   * then is there anything to click. A fixed sleep either flakes or wastes seconds,
   * and this is the same reason the panel content is waited for separately from the
   * panel element.
   *
   * ## The expression MUST evaluate to a primitive
   *
   * `Runtime.evaluate` with `returnByValue: true` cannot serialize a DOM node, so
   * an expression ending in `document.querySelector(...)` comes back as
   * `undefined` — which is falsy, so the poll spins until it times out **even
   * though the element is right there**. It looks exactly like the app failing to
   * render, and it cost a round of debugging: the panel existed, with the correct
   * `data-bot`, the entire time.
   *
   * Wrap element lookups in `!!`. The assertion below turns a repeat of that
   * mistake into an immediate, named error instead of a 12-second timeout pointing
   * at the wrong component.
   */
  async until(expression, what, tries = 80) {
    if (/querySelector(?!All)[^!]*$/.test(expression) && !expression.includes("!!")) {
      throw new Error(
        `until(${what}): expression returns a DOM node, which CDP cannot serialize by value. `
        + `Wrap it in !! so it returns a boolean.`,
      );
    }
    return this.#until(expression, what, tries);
  }

  async #until(expression, what, tries) {
    for (let i = 0; i < tries; i++) {
      try {
        if (await this.eval(expression)) return true;
      } catch { /* mid-navigation, try again */ }
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async shot(clip) {
    const res = await this.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      captureBeyondViewport: Boolean(clip),
    });
    return Buffer.from(res.data, "base64");
  }
}

/* -------------------------------------------------------------------- main */

const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) die(`no Chrome or Edge found. Looked in:\n  ${CHROMES.join("\n  ")}`);

const token = readToken();
mkdirSync(OUT, { recursive: true });

const proc = spawn(chrome, [
  "--headless=new",
  "--no-sandbox",
  // Software WebGL, so this works with no GPU and gives the same result every run.
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(OUT, ".chrome-profile")}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  `--window-size=${WIDTH},${HEIGHT}`,
  "about:blank",
], { stdio: "ignore" });

let cdp;
try {
  await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === "page");
  if (!page) die("no page target");
  cdp = await CDP.connect(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  /**
   * Surface what the page says, because a screenshot cannot.
   *
   * This was missing on the first run and cost a round of blind guessing: a click
   * reported success, no panel appeared, and the only symptom available was "timed
   * out". A page-side exception in a click handler is invisible to the driver
   * unless it is explicitly forwarded, and it is the single most likely reason a
   * UI automation step silently does nothing.
   */
  const pageProblems = [];
  cdp.ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      pageProblems.push(`EXCEPTION ${d?.exception?.description ?? d?.text ?? "?"}`);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      pageProblems.push(`console.error ${msg.params.args.map((a) => a.description ?? a.value).join(" ")}`);
    }
  });
  const dumpProblems = () => {
    for (const p of pageProblems.splice(0)) process.stderr.write(`ui-shot: page said: ${p}\n`);
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: DSF, mobile: false,
  });

  // Load the origin first, because localStorage is per-origin and cannot be written
  // before one is loaded. Then seed the token and reload into the real app.
  await cdp.send("Page.navigate", { url: BASE });
  await cdp.until("!!document.getElementById('app')", "the app shell");
  await cdp.eval(`localStorage.setItem('agency.token', ${JSON.stringify(token)}), true`);
  await cdp.send("Page.reload", { ignoreCache: false });

  await cdp.until("document.querySelectorAll('.row[data-bot]').length > 0", "bot rows from /api/bots");
  // The gate must be gone. If it is not, the token was rejected and every shot
  // below would be a screenshot of a password prompt — worth failing loudly on.
  const gated = await cdp.eval("!document.getElementById('token-gate').hidden");
  if (gated) die("the token from dashboard/.env was rejected — check it matches the running API");

  const ids = await cdp.eval(
    "Array.from(document.querySelectorAll('.row[data-bot]')).map(r => r.dataset.bot)",
  );
  const wanted = ONLY ? ids.filter((i) => i === ONLY) : ids;
  if (wanted.length === 0) die(`no bot row for ${ONLY}. Have: ${ids.join(", ")}`);

  // Let the studio settle before the overview shot: the fit solver tweens the stage
  // inset and the camera has an entrance to finish.
  await sleep(2500);
  writeFileSync(join(OUT, "00-overview.png"), await cdp.shot());
  process.stdout.write(`ui-shot: 00-overview.png\n`);

  let n = 0;
  for (const id of wanted) {
    n++;
    // Close whatever is open, so each panel is captured from the same state rather
    // than on top of the previous one's camera swap.
    await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true");
    await sleep(700);

    await cdp.eval(`document.querySelector('.row[data-bot="${id}"]').click(), true`);
    try {
      await cdp.until(`!!document.querySelector('.panel[data-bot="${id}"]')`, `${id}'s panel`);
    } catch (e) {
      dumpProblems();
      // What DID land in panel-root, so the next person is not guessing either.
      const state = await cdp.eval(
        `JSON.stringify({ root: document.getElementById('panel-root').innerHTML.slice(0, 300),
                          panels: document.querySelectorAll('.panel').length,
                          attrs: Array.from(document.querySelectorAll('.panel')).map(p => p.outerHTML.slice(0, 120)) })`,
      );
      process.stderr.write(`ui-shot: panel-root state: ${state}\n`);
      throw e;
    }
    // Wait for the view to have real content, not the "Loading…" placeholder. The
    // panel element exists before its data arrives, and a screenshot taken on the
    // element alone catches a spinner.
    await cdp.until(
      `(() => { const h = document.querySelector('.panel[data-bot="${id}"] .view-host');
                return h && h.textContent.trim().length > 40 && !/^Loading/.test(h.textContent.trim()); })()`,
      `${id}'s view content`,
    );
    // The sheet travels 500ms on the Register B curve; capture after it lands.
    await sleep(900);

    const box = await cdp.eval(
      `(() => { const r = document.querySelector('.panel[data-bot="${id}"]').getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const file = `${String(n).padStart(2, "0")}-${id}.png`;
    writeFileSync(join(OUT, file), await cdp.shot(box));
    process.stdout.write(`ui-shot: ${file}  (${Math.round(box.width)}x${Math.round(box.height)} css)\n`);
  }

  process.stdout.write(`ui-shot: wrote ${wanted.length + 1} file(s) to ${OUT}\n`);
} catch (e) {
  process.stderr.write(`ui-shot: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch { /* already gone */ }
  proc.kill();
}
