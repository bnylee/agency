/**
 * Headless smoke check for the studio. Open `/scene-check.html`.
 *
 * ## Why this file exists
 *
 * `scripts/test-scene.ts` proves the geometry arithmetic in Node, and it cannot
 * prove the one thing that only fails at runtime: **GLSL compiles on a real
 * driver.** A shader error takes the whole scene down and there is no compiler and
 * no type system that will catch it first.
 *
 * The real app cannot be screenshotted for this, because `index.html` gates on a
 * token before `boot()` reaches `mount()` — a headless capture of it shows the
 * token prompt. So this page mounts the studio directly against synthetic bots.
 *
 * ## What it checks, in the order the failures actually happen
 *
 *  1. **Did `mount()` throw?** That is WebGL unavailable, and the app's own
 *     fallback path.
 *  2. **Did anything hit `console.error` or `window.onerror`?** three reports a
 *     shader compile failure through `console.error` with the full driver info log,
 *     which is exactly the text you need and exactly the text a screenshot of a
 *     canvas does not contain. So both are captured and printed ON the page.
 *  3. **Did pixels actually get drawn?** A scene can compile every shader, throw
 *     nothing, and still render pure black — a camera inside a mesh, a fit solver
 *     returning NaN, an inverted matrix. So the framebuffer is sampled directly
 *     and the result is reported as a number.
 *
 * ## The readback timing, which is the one subtle thing here
 *
 * `gl.readPixels` needs the drawing buffer to still be valid, and without
 * `preserveDrawingBuffer` it is cleared when the frame is composited. Compositing
 * happens after ALL of a frame's requestAnimationFrame callbacks have run — so a
 * callback registered *after* three's own render loop reads a buffer three has just
 * drawn into and the compositor has not yet taken. That is why the sampler is a
 * plain rAF and not a timer: a `setTimeout` lands between frames and reads black
 * every time, which looks exactly like a broken scene.
 */
import "./styles.css";
import type { Bot } from "./api";
import { mount, type StudioHandle } from "./scene/studio";

/* ------------------------------------------------------- capture first ---- */
// Installed BEFORE the scene imports run any code, so a compile error raised
// during mount() is caught rather than only appearing in a console nobody reads.
const problems: string[] = [];
const notes: string[] = [];

const realError = console.error.bind(console);
const realWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
  problems.push(args.map(String).join(" "));
  realError(...args);
};
console.warn = (...args: unknown[]) => {
  notes.push(args.map(String).join(" "));
  realWarn(...args);
};
window.addEventListener("error", (e) => { problems.push(`window.onerror: ${e.message}`); });
window.addEventListener("unhandledrejection", (e) => { problems.push(`unhandled rejection: ${String(e.reason)}`); });

/* ------------------------------------------------------------- fixtures --- */

const now = Date.now();
const HOUR = 3_600_000;

/**
 * One of every state the scene can encode, so a single screenshot exercises every
 * binding: each status role, a never-run bot, a running bot, a bot with no
 * schedule, and a token spread from zero to past the stack cap.
 */
const BOTS: Bot[] = [
  b("finance-research", "daily", 4.5, "ok", now + 6 * HOUR, 8, 96_000),
  b("agency-repair", "daily", 2.6, "partial", now + 2 * HOUR, 12, 41_000),
  b("media-bot", "daily", 6.0, "running", now + 19 * HOUR, 3, 12_000),
  b("sam-research", "weekly", 7.5, "failed", now + 30 * HOUR, 5, 62_000),
  b("disk-cleanup", "weekly", 10, "ok", now - 4 * HOUR, 9, 150_000),
  b("interface-design", "on-demand", 13, "never_run", null, 0, 0),
];

function b(
  id: string, cadence: Bot["cadence"], orbitRadius: number,
  status: Bot["status"], nextRun: number | null, runCount: number, totalTokens: number,
): Bot {
  return {
    id, name: id, blurb: "", cadence, orbitRadius,
    triggerable: true, dryRunOnly: false,
    status, statusDetail: null,
    lastRunDate: runCount ? "2026-08-03" : null,
    runCount, totalTokens, tokenSeries: [],
    nextRun: nextRun === null ? null : new Date(nextRun).toISOString(),
  };
}

/**
 * A graph, so the conduits and the auras are exercised too.
 *
 * `?aura=0` zeroes every degree, which turns the auras off and leaves everything
 * else identical. That exists because "is this soft halo the aura or is it my eye"
 * is not a question to answer by staring: two captures that differ only in this
 * flag answer it, and the same trick works for any future channel that is easy to
 * confuse with a rendering artifact.
 */
const AURA_ON = new URLSearchParams(location.search).get("aura") !== "0";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const GRAPH = {
  nodes: BOTS.map((x, i) => ({ id: x.id, degree: AURA_ON ? [9, 7, 4, 5, 3, 0][i]! : 0 })),
  edges: [
    { a: "agency-repair", b: "interface-design", weight: 6, forward: true },
    { a: "agency-repair", b: "finance-research", weight: 4, forward: true },
    { a: "media-bot", b: "finance-research", weight: 3, forward: false },
    { a: "sam-research", b: "disk-cleanup", weight: 2, forward: true },
    { a: "finance-research", b: "sam-research", weight: 3, forward: true },
  ],
  maxWeight: 6,
  maxDegree: 9,
  sources: 24,
  generatedAt: new Date().toISOString(),
};

/* ---------------------------------------------------------------- mount --- */

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const log = document.getElementById("log")!;

let studio: StudioHandle | null = null;
let mountError: string | null = null;

try {
  studio = mount(canvas, BOTS);
  studio.setRelevance(GRAPH);
  // A left inset, so the fit solver runs the same code path the real app uses
  // rather than the degenerate zero-inset one.
  studio.setStageInset(384, 56, 0);
} catch (e) {
  mountError = `${(e as Error).name}: ${(e as Error).message}`;
}

/* -------------------------------------------------------------- sampling -- */

/**
 * Sample the framebuffer on a grid and report what is actually on screen.
 *
 * Reported as three separate numbers because they fail differently:
 *  - `lit` — how many sampled pixels are not black. Zero means nothing drew.
 *  - `mean` — average luminance. A nebula-only frame is dim but non-zero; a frame
 *    that is mostly bot is much brighter. This is what distinguishes "the sky
 *    rendered but the bots did not" from "everything rendered".
 *  - `max` — the brightest sampled pixel. Stars, the status panels and the comet
 *    heads are the only things near 1.0, so a low max means the additive layers
 *    are missing even if the sky is there.
 */
const GRID = 48;
function sample(gl: WebGL2RenderingContext | WebGLRenderingContext) {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(4);
  let lit = 0;
  let sum = 0;
  let max = 0;
  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) {
      const x = Math.floor(((ix + 0.5) / GRID) * w);
      const y = Math.floor(((iy + 0.5) / GRID) * h);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const lum = (0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!) / 255;
      if (lum > 0.004) lit++;
      sum += lum;
      if (lum > max) max = lum;
    }
  }
  return { lit, total: GRID * GRID, mean: sum / (GRID * GRID), max, w, h };
}

let frames = 0;
let best: ReturnType<typeof sample> | null = null;

function report(): void {
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const lines: string[] = [];

  lines.push(`AGENCY SCENE CHECK   frames=${frames}   auras=${AURA_ON ? "on" : "OFF"}`);
  lines.push("");

  if (mountError) {
    lines.push(`MOUNT FAILED — ${mountError}`);
    lines.push("The real app would fall back to the table view here.");
  } else {
    lines.push("mount()            ok");
  }

  if (gl) {
    const dbg = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String((gl as WebGLRenderingContext).getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "unknown";
    lines.push(`context            ${gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl1"}`);
    lines.push(`driver             ${renderer}`);
  } else {
    lines.push("context            NONE — no WebGL context on the canvas");
  }

  /**
   * Reduced motion defeats the framebuffer sampler, and that is expected.
   *
   * Under `reduce` the studio renders exactly ONE frame and calls
   * `setAnimationLoop(null)`. That frame is composited and the drawing buffer is
   * cleared, so a sampler running on any later frame reads black — a false negative
   * that looks identical to a broken scene. Said out loud rather than papered over
   * with `preserveDrawingBuffer`, which would change how the real app allocates its
   * buffer just to make a harness happier.
   *
   * The screenshot is still valid under `reduce`: Chrome captures the composited
   * page, not the live buffer. So this is the mode to use for A/B comparisons —
   * two captures of a stopped scene differ only in what you changed, where two
   * captures of a moving one differ mostly in animation phase.
   */
  if (reducedMotion) {
    lines.push("");
    lines.push("prefers-reduced-motion is ON:");
    lines.push("  the studio renders one frame and stops, so the framebuffer");
    lines.push("  sampler below reads a cleared buffer and cannot be trusted.");
    lines.push("  Judge from the screenshot. Comets are not built in this mode,");
    lines.push("  by design — see the note at the top of space.ts.");
  }

  if (best) {
    const pct = ((best.lit / best.total) * 100).toFixed(1);
    lines.push(`framebuffer        ${best.w}x${best.h}`);
    lines.push(`pixels lit         ${best.lit}/${best.total}  (${pct}%)`);
    lines.push(`mean luminance     ${best.mean.toFixed(4)}`);
    lines.push(`max luminance      ${best.max.toFixed(4)}`);
    lines.push("");
    // The verdict is stated in words, because a number needs a threshold and the
    // threshold is the judgement worth writing down. A frame with under 2% of
    // sampled pixels lit is a black screen with a couple of stars in it.
    if (reducedMotion) {
      // Not "BLACK". Under `reduce` a zero reading is the EXPECTED result of a
      // cleared buffer, not evidence of a broken scene, and a diagnostic that
      // cries wolf on its own known blind spot is worse than one that says so.
      lines.push("VERDICT            NOT MEASURABLE HERE — see the note above");
    } else if (best.lit === 0) lines.push("VERDICT            BLACK — nothing drew");
    else if (best.lit / best.total < 0.02) lines.push("VERDICT            NEARLY BLACK — check the camera and the fit solver");
    else if (best.max < 0.25) lines.push("VERDICT            DIM — sky may be drawing but the lit geometry is not");
    else lines.push("VERDICT            RENDERING");
  } else {
    lines.push("framebuffer        not sampled yet");
  }

  lines.push("");
  lines.push(`errors             ${problems.length}`);
  for (const p of problems.slice(0, 6)) {
    // Wrapped hard: a driver's shader info log is one enormous line and the whole
    // point of printing it here is that it is legible in a screenshot.
    for (const chunk of p.match(/.{1,96}/g) ?? []) lines.push(`  ${chunk}`);
  }
  if (problems.length > 6) lines.push(`  … and ${problems.length - 6} more`);

  lines.push(`warnings           ${notes.length}`);
  for (const n of notes.slice(0, 3)) {
    for (const chunk of n.match(/.{1,96}/g) ?? []) lines.push(`  ${chunk}`);
  }

  log.textContent = lines.join("\n");
  // Read by the capture script, so it does not have to guess when to shoot.
  document.body.dataset.verdict = mountError ? "mount-failed"
    : problems.length ? "errors"
    : reducedMotion ? "not-measurable"
    : best && best.lit / best.total >= 0.02 && best.max >= 0.25 ? "rendering"
    : "black";
  document.body.dataset.frames = String(frames);
}

/**
 * A plain rAF, deliberately — see the timing note at the top of this file. It also
 * keeps the sampler running for a while rather than shooting once: the comets are
 * intermittent by design, so an early frame can legitimately have none, and taking
 * the BRIGHTEST of many frames is what makes the max-luminance figure mean
 * "the additive layers work" instead of "I got lucky".
 */
function tick(): void {
  frames++;
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (gl && frames > 2) {
    const s = sample(gl as WebGL2RenderingContext);
    if (!best || s.lit > best.lit || s.max > best.max) best = s;
  }
  if (frames <= 240) requestAnimationFrame(tick);
  if (frames % 20 === 0 || frames === 3) report();
}
requestAnimationFrame(tick);
report();

/* ------------------------------------------------------------------ style - */
// Inline rather than in styles.css: this is a harness, and its layout has no
// business in the shipped stylesheet.
const css = document.createElement("style");
css.textContent = `
  #verdict {
    position: fixed; left: 16px; top: 16px; z-index: 5;
    max-width: 62ch; padding: 14px 16px;
    background: rgba(13,13,13,0.92);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 4px;
  }
  #verdict pre {
    margin: 0;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11.5px; line-height: 1.55; color: #e8e6df;
    white-space: pre-wrap;
  }
`;
document.head.append(css);
