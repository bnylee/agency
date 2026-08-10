/**
 * Register A — the studio's material palette.
 *
 * MIRRORS the `scene` block of interface-design/design/design-dna.json. That file
 * is the authority; this is the copy the app consumes, for the same reason
 * tokens.css exists rather than importing the JSON: Vite restricts imports to the
 * project root.
 *
 * ## Why none of this needed the dataviz validator re-run
 *
 * The rule in interface-design/CLAUDE.md is that changing `--surface` invalidates
 * every status contrast figure. Nothing here is a CSS token — the chrome keeps
 * the validated dark palette byte-for-byte, and these hexes only ever reach
 * three.js materials.
 *
 * The status colours still have to hold >= 3:1 against whatever sits behind
 * them, and this palette buys that outright instead of measuring for it: every
 * status panel is set into a bezel painted `BEZEL`, which is #1a1a19 — the exact
 * `--surface` the figures in design-dna.json were measured against. So the
 * validated numbers transfer unchanged (ok 5.19, partial 9.49, failed 3.62,
 * never_run 4.62, running 4.28) and the warm room behind the bot is irrelevant
 * to them, because it is never the panel's local background.
 *
 * That is the same trick backdrop.ts used for the nebula, arrived at from the
 * other end: it clamped the background to protect the figure, and this puts a
 * known background behind the signal so there is no figure to protect.
 *
 * ## Colour space
 *
 * Every hex here is passed to a built-in material (MeshStandardMaterial and
 * friends), which takes its `color`/`emissive` through three's colour management
 * into the linear working space and encodes on the way out. So these are plain
 * display-referred hexes and `new THREE.Color(hex)` is correct — the opposite of
 * the raw ShaderMaterials in shaders.ts, which write display values straight to
 * the framebuffer and therefore need srgb() to bypass the conversion. Mixing the
 * two conventions up is a 4x brightness error, so the split is per-material and
 * deliberate.
 */
import * as THREE from "three";
import type { StatusRole } from "../api";

/**
 * The reserved status palette, byte-identical to design-dna.json. Never themed,
 * never reused as a series colour, and in this scene never the only carrier of
 * the state — `glyphTexture` below is the other half of that rule.
 */
export const STATUS_COLOR: Record<StatusRole, number> = {
  ok: 0x0ca30c,
  partial: 0xfab219,
  failed: 0xd03b3b,
  never_run: 0x898781,
  running: 0x3987e5,
};

/**
 * Deep space, as three colours plus the two metals.
 *
 * ## Why the sky is cool and the bots are warm
 *
 * The bodies are pale porcelain with pastel accents, chosen when the scene was a
 * warm room. Dropping them into a blue-violet sky would normally mean retinting
 * every one of them — except that a cool background is exactly what makes a warm
 * cream body read as *lit* rather than as beige. So nothing in `BOT_LOOK` moved,
 * and the separation between figure and ground got better rather than worse. The
 * lights did the work instead: see `LIGHT` below.
 *
 * ## Why none of this reopened the contrast question
 *
 * Same answer as every previous revision, and it is the reason the answer keeps
 * being cheap: no hex here is a CSS token, and every status panel is set into a
 * bezel painted `CHASSIS.bezel` — #1a1a19, the exact `--surface` the figures in
 * design-dna.json were measured against. The sky is never a status colour's local
 * background. `NEBULA_FRAG` additionally holds a hard luminance ceiling, which is
 * belt and braces rather than the load-bearing part.
 */
export const SPACE = {
  /** The void between the clouds. Nearly `--page`, deliberately: the stage and
   * the chrome should feel like one surface at the edges of the frame. */
  deep: 0x0b0d18,
  /** The body of the gas. */
  mid: 0x2b3a6b,
  /** The bright cores, in the galactic band only. */
  hot: 0xb08bd8,
  /** Stars, and the comets. Slightly cool white — a warm star reads as a lamp. */
  star: 0xdfe6ff,
  comet: 0xeaf0ff,
  /** The distant gas giant: two band tones and its ring. */
  planet: 0x2e3550,
  planetBand: 0x3d4666,
  planetRing: 0x6b6f8a,
} as const;

/**
 * The room. Retained because the dock plate, the dial brass and the bot chassis
 * still use `dock`, `brass` and `brassBright`, and because `floor`/`bench` are
 * the swatches on interface-design's palette prop.
 *
 * The interior colours themselves (`wall`, `ceiling`, `floorSeam`, `baseboard`,
 * `benchSteel`) are no longer painted on anything — room.ts is gone. They are
 * left here rather than deleted because interface-design's palette prop reads
 * four of these by name, and because a bot whose job is the design system
 * holding a palette of colours the scene no longer contains would be a small lie.
 */
export const ROOM = {
  /** Oiled oak, and the seams cut into it. */
  floor: 0x6d4f35,
  floorSeam: 0x3f2c1b,
  /** Clay plaster. Dark enough that the brass and the status panels carry. */
  wall: 0x4a403a,
  wallFar: 0x413833,
  ceiling: 0x3b3532,
  baseboard: 0x2f2926,
  /** Blackened steel, for frames and fixtures. */
  steel: 0x262220,
  /** Aged brass: the dial inlay, the fittings, the lamp shades. */
  brass: 0x9a7b3f,
  brassBright: 0xd8ab52,
  bench: 0x57422e,
  benchSteel: 0x35302c,
  dock: 0x35302c,
} as const;

/**
 * The bot chassis. `BEZEL` is load-bearing — see the contrast note at the top of
 * this file. It is not a decorative choice and must not be warmed up to match
 * the room.
 */
export const CHASSIS = {
  /** #1a1a19 — the validated `--surface`. The status panel's local background. */
  bezel: 0x1a1a19,
  shell: 0x2c2b28,
  shellLit: 0x3a3835,
  /**
   * A bot that has never run: dulled, unpowered, dust settled on it.
   *
   * No longer used by bots3d.ts. The bodies became pale porcelain with a per-bot
   * accent, so draining them needs two greys rather than one, and both live next
   * to `BOT_LOOK` in that file — as does the accent palette itself, since neither
   * is mirrored from design-dna.json. Kept here because it is still the right
   * value for anything in the room that needs one dead chassis colour, but do not
   * read it as "the never-run colour" any more.
   */
  cold: 0x211f1d,
  accent: 0x8a7444,
} as const;

/**
 * Relevance conduits and auras deliberately spend **no reserved hue**. Status
 * owns green/amber/red/grey/blue and the categorical slots own the other four,
 * so a graph edge borrowing any of them would be a second meaning on a colour
 * that already has one. Lamp-white and pale gold are unclaimed, and they also
 * happen to be what light in a warm room actually looks like.
 */
export const ENERGY = {
  conduit: 0xe8dcc4,
  aura: 0xd8c290,
} as const;

/**
 * Lighting for space, and this is where the porcelain bodies survived the move.
 *
 * Three lights, and each does one job:
 *
 * - `key` — a distant star, off to one side and slightly above. Warm, and the
 *   only shadow caster. It is what makes a sphere read as a sphere.
 * - `bounce` — cool fill from the nebula itself, coming from the opposite side.
 *   In a room this was a hemisphere light picking up the floor; here it stands in
 *   for the sky, which is genuinely the second brightest thing in the scene.
 * - `rim` — dim, cold, from behind. A body with no rim light in front of a dark
 *   sky loses its silhouette exactly where the silhouette is doing the work of
 *   telling five bots apart.
 *
 * The key stayed warm on purpose. A cool key over a cool sky is a monochrome
 * frame, and the cream bodies would go grey — which is the one thing that must
 * not happen, because `never_run` is encoded as a body draining to grey.
 */
export const LIGHT = {
  /** The star. Warm white, not orange: this is a sun, not a tungsten bulb. */
  key: 0xfff1de,
  /** Nebula bounce. */
  bounce: 0x5f74b8,
  /** Cold rim from behind. */
  rim: 0x9fb4ff,
} as const;

/**
 * Shared material factory. Every surface in the studio is a MeshStandardMaterial
 * lit by real lights plus the environment — which is the whole reason this is a
 * rewrite and not a retint. The previous scene had no lights at all: it was
 * MeshBasicMaterial and raw ShaderMaterial throughout, because a body glowing in
 * vacuum needs no illumination. A room does.
 */
export function surface(
  color: number,
  opts: { rough?: number; metal?: number; env?: number } = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.rough ?? 0.72,
    metalness: opts.metal ?? 0.05,
    envMapIntensity: opts.env ?? 0.55,
  });
}

/** Brass and steel want low roughness and real metalness or they read as plastic. */
export const metal = (color: number, rough = 0.34) =>
  surface(color, { rough, metal: 0.9, env: 0.9 });

/**
 * An emissive panel whose output is exactly the hex it was given.
 *
 * `toneMapped: false` is the point. The renderer runs NoToneMapping today
 * precisely so status colour lands unaltered (see studio.ts), but a filmic curve
 * desaturates saturated highlights, and #d03b3b at 3.62:1 has no margin to give
 * away. This flag means the guarantee survives someone enabling tone mapping
 * later for the room's benefit without realising what else it touches.
 */
export function emissive(color: number, intensity = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.5,
    metalness: 0,
    toneMapped: false,
  });
  return m;
}

/**
 * The glyph half of "status never carries meaning by colour alone".
 *
 * interface-design/CLAUDE.md extends that rule to the 3D bodies explicitly, and
 * the old scene did not honour it — a core's status was pure hue, and a
 * red/green confusion had nothing else to fall back on. Each status now stamps
 * its design-dna glyph into the panel as a mask: check, warn, cross, dash,
 * pulse. The text label is the rail's job and it already does it.
 *
 * Drawn white on transparent and used as an emissive map, so the panel's colour
 * still comes from the status hex and the glyph is where that colour is allowed
 * to show.
 */
const glyphCache = new Map<StatusRole, THREE.CanvasTexture>();

export function glyphTexture(status: StatusRole): THREE.CanvasTexture {
  const hit = glyphCache.get(status);
  if (hit) return hit;

  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const g = cv.getContext("2d")!;

  // A dim wash over the whole panel so the plate still reads as lit, with the
  // glyph itself at full strength on top. A pure mask would leave an unlit panel
  // with a floating symbol, which looks like a fault rather than a state.
  //
  // OPAQUE grey, not white-at-22%-alpha. An emissiveMap is sampled for its RGB
  // and the alpha is ignored, so a translucent white wash uploads as RGB 1.0 —
  // the panel would glow at full strength everywhere and the glyph would be
  // invisible, which is the one thing this texture exists to prevent.
  g.fillStyle = "#3a3a3a";
  g.fillRect(0, 0, S, S);

  g.strokeStyle = "#ffffff";
  g.fillStyle = "#ffffff";
  g.lineWidth = 12;
  g.lineCap = "round";
  g.lineJoin = "round";
  const c = S / 2;

  switch (status) {
    case "ok": // check
      g.beginPath();
      g.moveTo(S * 0.26, S * 0.52);
      g.lineTo(S * 0.44, S * 0.7);
      g.lineTo(S * 0.76, S * 0.32);
      g.stroke();
      break;
    case "partial": // warn — triangle with a bar
      g.beginPath();
      g.moveTo(c, S * 0.22);
      g.lineTo(S * 0.82, S * 0.76);
      g.lineTo(S * 0.18, S * 0.76);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(c, S * 0.42);
      g.lineTo(c, S * 0.58);
      g.stroke();
      g.beginPath();
      g.arc(c, S * 0.67, 6, 0, Math.PI * 2);
      g.fill();
      break;
    case "failed": // cross
      g.beginPath();
      g.moveTo(S * 0.3, S * 0.3);
      g.lineTo(S * 0.7, S * 0.7);
      g.moveTo(S * 0.7, S * 0.3);
      g.lineTo(S * 0.3, S * 0.7);
      g.stroke();
      break;
    case "never_run": // dash
      g.beginPath();
      g.moveTo(S * 0.28, c);
      g.lineTo(S * 0.72, c);
      g.stroke();
      break;
    case "running": // pulse — a sawtooth trace
      g.beginPath();
      g.moveTo(S * 0.16, c);
      g.lineTo(S * 0.36, c);
      g.lineTo(S * 0.46, S * 0.3);
      g.lineTo(S * 0.58, S * 0.72);
      g.lineTo(S * 0.68, c);
      g.lineTo(S * 0.84, c);
      g.stroke();
      break;
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  glyphCache.set(status, tex);
  return tex;
}

export function disposeGlyphs(): void {
  for (const t of glyphCache.values()) t.dispose();
  glyphCache.clear();
}
