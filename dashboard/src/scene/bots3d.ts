/**
 * Register A — the bots, as characters floating in space.
 *
 * ## What the move out of the room changed here
 *
 * Structurally very little, and that is the point. The characters, their props,
 * their idle animations and every data binding are unchanged. What went away was
 * the furniture the room justified:
 *
 *  - **The dock plate is gone.** Nothing is standing on anything.
 *  - **The dial moved from the floor into a ring around each bot**, which flipped
 *    the sign of the hand's rotation. That is written out twice below because it is
 *    the one thing here that can be wrong while looking completely plausible.
 *  - **Each body is shifted down by `bodyY`** so the bot's own middle sits at the
 *    group origin — the centre of its dial, the centre of its aura, and the point
 *    the camera aims at when it is focused. Three things depend on it.
 *  - **A float height and a bob**, both hashed off the bot's id. Neither carries
 *    data; see FLOAT_Y for why they are built so they cannot look like they do.
 *
 * ## The cast
 *
 * Six porcelain toy robots, one per bot, plus a deliberately plain fallback.
 * They were industrial instruments before — a reading desk, a tape printer, a
 * dolly, a drafting table, a tool arm — and the shapes carried the jobs well but
 * nobody could tell you which was which without reading the rail. So the props
 * stayed and the machines around them became characters:
 *
 *   sam-research      tall, thin, square spectacles, mortarboard, open book
 *   finance-research  egg-shaped, bow tie, flat cap, tape spool on its back
 *   disk-cleanup      squat dome on a roller, lid for a hat, brush, manifest tag
 *   interface-design  slender, beret, brass loupe over ONE eye, brush + palette
 *   agency-repair     stocky, hard hat, head on a visible coil spring, wrench
 *   media-bot         headset with a boom mic, ring of antennae, letter tray
 *
 * Identity is carried by silhouette and prop first and colour second, in that
 * order and on purpose: the five accent hues are pastel and close in value, so
 * the outline is what has to do the work at the back of the room, in greyscale,
 * and for a viewer with colour-vision deficiency.
 *
 * Measured body heights are 1.22 / 1.61 / 1.71 / 1.75 / 1.83, so only
 * disk-cleanup is separable by height alone — it is barely two thirds of the
 * others and is the one with no legs. The rest are told apart by headgear and
 * prop, which is why every one of them has both: mortarboard and book, flat cap
 * and bow tie, lid and brush, beret and loupe, hard hat and wrench. The two
 * closest in outline are sam-research and interface-design, both slim and about
 * the same height; the wide flat mortarboard against the round tilted beret, and
 * the book held square in front against the palette held off to one side, are
 * what separate them.
 *
 * media-bot was the sixth, and it took the instruction below: its headgear is a
 * **headset** — a band with an ear pad each side and a boom mic swung to the mouth.
 * It is the only bot whose head reads as wider than it is tall, and the boom is the
 * only forward-projecting headgear element in the cast. Its body is a ring of
 * antennae, so its outline is spiky where all five others are smooth. If a SEVENTH
 * bot is ever modelled, give it a headgear
 * silhouette none of these five already owns.
 *
 * Every data channel below is unchanged. The characters are the chassis the
 * channels ride on; none of them encodes anything by itself, with one exception
 * that is called out where it happens (disk-cleanup's lid lifts with `work`).
 *
 * The orrery encoded a bot as a displaced icosahedron on an orbit. Six channels
 * rode on that arrangement, and two of them — orbital angle and orbital radius —
 * had nowhere to go once the orbits did. This module is where they went.
 *
 *   time until next run  <- the brass dial inlaid in the floor at each dock
 *   cadence              <- which zone of the room the dock stands in
 *   last run status      <- the bot's indicator panel (colour + glyph)
 *   has it ever run      <- chassis dulled, panel down to a trace
 *   run in progress      <- panel pulse, and the machine starts working
 *   cumulative tokens    <- physical output stacked at the station
 *   relevance degree     <- aura (see relevance.ts for the edges themselves)
 *
 * ## Why the dial survived and the orbit did not
 *
 * The orbit was a good encoding: "due now sits at the marker, overdue drifts past
 * it" is readable without parsing a date. Nothing about that needed a solar
 * system — it needed a dial face and a hand. So each dock has its own, cut into
 * the floorboards, with the same twelve ticks and the same bright marker at angle
 * zero that backdrop.ts drew across the whole ecliptic. `angleFor` below is the
 * orrery's function, unchanged, including its NaN guard.
 *
 * The gain is that five dials read independently. On the shared ecliptic, two
 * bots at the same phase overlapped and you could not tell which was late.
 *
 * ## Why status moved off the body
 *
 * In vacuum, tinting the whole core was free — nothing else was coloured. In a
 * warm room a red-tinted machine fights the oak and the brass, and worse, its
 * local background stops being a known quantity, which is what every contrast
 * figure in design-dna.json depends on. So status lives on a panel seated in a
 * bezel painted the validated `--surface`. See the contrast note at the top of
 * materials.ts.
 *
 * Giving the bodies colour did NOT reopen that. The contrast figures were never
 * bought from the chassis — they are bought from the bezel, which is still
 * `#1a1a19` behind every panel — so the validated numbers transfer untouched.
 * What the pale bodies do change is which thing on the bot is the most saturated,
 * and the answer is still the status panel, by a wide margin. That is the
 * property worth protecting, and the reason the accents are pastels drawn from
 * hues neither status nor the categorical slots own. See BOT_LOOK below.
 *
 * One binding did change meaning, deliberately. "Never run -> unlit" worked when
 * the alternative to lit was the void; in a lit room an unlit panel is
 * indistinguishable from a panel in shadow. So a never-run bot drains to grey —
 * skin, accent, and the eye catchlights out entirely — and its panel drops to a
 * trace: enough to read the dash glyph by, not enough to mistake for running.
 * Conspicuously dead, which was always the point of that channel, and louder now
 * that the four bots either side of it are coloured.
 */
import * as THREE from "three";
import type { Bot } from "../api";
import { AURA_FRAG, AURA_VERT } from "./shaders";
import { CHASSIS, ENERGY, ROOM, STATUS_COLOR, emissive, glyphTexture, metal, surface } from "./materials";

/** Zone depth by cadence. Daily nearest the camera, on-demand furthest away. */
const ZONE_Z: Record<Bot["cadence"], number> = {
  daily: 5.0,
  weekly: -1.0,
  "on-demand": -6.8,
};

/** Lateral spacing between bots sharing a zone. */
const SLOT_DX = 8.4;

/**
 * How far a bot may sit above or below the layout plane.
 *
 * Cadence still owns depth and only depth. This is the float height, and it
 * exists for one reason: five bots at y=0 read as five bots on an invisible
 * floor, which is precisely the reading the room was replaced to get away from.
 * Scattering them vertically is what makes them read as suspended.
 *
 * It carries no data, so it must not look like it does — which is why it is
 * derived from a hash of the bot's id (stable, arbitrary) rather than from
 * anything ordered like `orbitRadius`. A viewer who assumed height meant
 * something would be looking for a pattern in a hash, and there is not one.
 */
const FLOAT_Y = 1.9;

/** Dial ring radius, and the tube it is drawn as. */
const DIAL_R = 1.5;
const DIAL_TUBE = 0.022;

/**
 * Emissive levels for the dial brass, as named constants.
 *
 * They are constants because there are THREE places that must agree on them —
 * the material's initial value, `applyStatus` when a bot goes cold, and `update`
 * every frame — and when they were three literals two of them disagreed with the
 * third. `update` runs last and wins, so the wrong ones were invisible: the dial
 * was simply never as bright as the material claimed it was.
 *
 * Higher than the room's values (0.22 / 0.9) because brass against a dark sky has
 * no warm bounce light to be found by, and at the room's levels the ring
 * disappeared entirely on its unlit side.
 */
const DIAL_EM = 0.3;
const DIAL_EM_COLD = 0.1;
const HAND_EM = 1.0;
const HAND_EM_COLD = 0.28;
const MARK_EM = 0.6;

/**
 * Tokens per stacked item, and the cap.
 *
 * Carried over from the orrery's ring, which was ~1 particle per 400 tokens
 * clamped at 300 — a 120k ceiling. Fourteen physical items across the same 120k
 * keeps the reading comparable between the two designs. The cap is a real limit:
 * past it the stack saturates and the figure in the panel is what you read
 * instead, exactly as the ring's clamp intended.
 */
const ITEM_TOKENS = 8500;
const ITEM_CAP = 14;

/**
 * Ceiling on aura brightness, applied to the normalised graph degree.
 *
 * 0.85, up from the room's 0.34, and the reason is a consequence of fixing the
 * `side` bug on the aura material — see the long note there.
 *
 * 0.34 was measured against a shell that was rendering as a FILLED disc, because
 * `BackSide` made the fresnel evaluate to 1 everywhere. A filled disc is a lot of
 * additive light, so it needed holding right down. The corrected shell only paints
 * the rim, which is a small fraction of the same area, and at 0.34 the relevance
 * channel had gone from over-bright to invisible — a headless capture showed
 * essentially no aura on any bot.
 *
 * Still a ceiling rather than a free scale: this is the knob that trades legibility
 * of the relevance channel against the sky staying dark enough for pale bodies to
 * read against. Set by looking at a rendered frame, not derived.
 */
const AURA_GAIN = 0.85;

/**
 * Reduced motion renders exactly ONE frame and stops, which makes every
 * per-frame lerp in this file a bug there rather than a smoothing.
 *
 * The aura's intensity, the selection glow and the work level all ease toward
 * their targets at a few percent per frame. Across a stopped loop that leaves
 * them at a few percent of the value they should have, so a reduced-motion user
 * saw no aura at all — the entire relevance channel silently absent, on the one
 * path nobody looks at. Under `reduce` these snap instead. The states still read;
 * only the easing is given up, which is exactly what the preference asks for.
 */
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
const ease = (from: number, to: number, k: number) =>
  REDUCED.matches ? to : from + (to - from) * k;

/** Cadence -> orbital period in ms. Still the dial's period. */
const PERIOD_MS: Record<Bot["cadence"], number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  "on-demand": 0,
};

/**
 * Angle from time-to-next-run. Lifted from orrery.ts unchanged.
 *
 * A bot's hand sits where its next run sits on the dial: due now at the marker
 * (angle 0), a full period away all the way round. Overdue goes negative and
 * drifts past the marker, which is the reading we want.
 *
 * The NaN guard is load-bearing and was in the original for a reason: an
 * unparseable date propagating into a position drops the object out of the scene
 * with no visible error.
 */
export function angleFor(bot: Bot, now: number): number {
  const period = PERIOD_MS[bot.cadence];
  const next = bot.nextRun ? new Date(bot.nextRun).getTime() : NaN;
  if (!period || !Number.isFinite(next)) {
    // No schedule, or an unparseable date: park the hand somewhere stable and
    // arbitrary. Through the shared `hash` rather than an inline copy of it, which
    // is what this was — two implementations of the same hash in one file is one
    // more thing that can quietly diverge.
    return (hash(bot.id) % 360) * (Math.PI / 180);
  }
  const remaining = next - now;
  return (1 - remaining / period) * Math.PI * 2;
}

/** Stable 32-bit hash of a string. Used for anything that must be arbitrary but
 * not random — a float height, an animation phase. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 0..1 from a bot id, with a salt so two channels off the same id do not correlate. */
const unit = (id: string, salt: number): number => ((hash(id) ^ (salt * 2654435761)) >>> 0) / 4294967296;

/**
 * Bot positions.
 *
 * Cadence picks the depth zone; `orbitRadius` orders the bots inside it. Reusing
 * that field rather than inventing a `slot` one keeps the registry in charge of
 * the arrangement — dashboard/server/registry.ts calls itself a hardcoded
 * allowlist where adding a bot is a deliberate act, and layout should not quietly
 * escape that. It is also why a new bot cannot reshuffle the others: the sort is
 * stable and zone-local.
 *
 * The Y is new and is the only part that carries nothing. See FLOAT_Y.
 */
export function layoutSlots(bots: Bot[]): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  const byZone = new Map<Bot["cadence"], Bot[]>();
  for (const b of bots) {
    const list = byZone.get(b.cadence) ?? [];
    list.push(b);
    byZone.set(b.cadence, list);
  }
  for (const [cadence, list] of byZone) {
    list.sort((a, b) => a.orbitRadius - b.orbitRadius || a.id.localeCompare(b.id));
    const span = (list.length - 1) * SLOT_DX;
    list.forEach((b, i) => {
      // (unit - 0.5) * 2 spreads over the full range rather than only upward, so
      // the group straddles the camera's aim instead of climbing away from it.
      const y = (unit(b.id, 17) - 0.5) * 2 * FLOAT_Y;
      out.set(b.id, new THREE.Vector3(-span / 2 + i * SLOT_DX, y, ZONE_Z[cadence]));
    });
  }
  return out;
}

/**
 * Half-extent of the arrangement in the horizontal plane, so the camera can frame
 * it. The 2.6 margin is the dial ring (1.5) plus the output cluster beside it.
 */
export function layoutExtent(slots: Map<string, THREE.Vector3>): number {
  let m = 6;
  for (const p of slots.values()) m = Math.max(m, Math.abs(p.x) + 2.6, Math.abs(p.z) + 2.6);
  return m;
}

/**
 * Half-extent in Y, which the room did not need and space does.
 *
 * The room's vertical fit came from a constant — the shell was 9 units tall and
 * that never changed. Here the bots themselves define the vertical extent, so the
 * camera has to be told. Without this the fit solver frames the horizontal spread
 * perfectly and crops the highest and lowest bots.
 */
export function layoutVertical(slots: Map<string, THREE.Vector3>): number {
  let m = 2.4;
  for (const p of slots.values()) m = Math.max(m, Math.abs(p.y) + 2.4);
  return m;
}

/**
 * How far the NEAREST bot stands in front of the layout's centre.
 *
 * The fit solver frames a half-extent as though the whole arrangement sat on one
 * plane at the camera's focal distance. It does not: the daily zone is 5 units
 * closer than the origin and 11.8 closer than the on-demand zone, so it is
 * perspective-magnified and pushes past the frame edge while the solver believes
 * everything fits. A headless capture showed exactly that — the front-row bot on the
 * right was clipped in half.
 *
 * Adding this to the fitted distance frames the arrangement at its nearest plane
 * instead of at its middle. Only the NEAR side matters: something further away than
 * the centre projects smaller, and it was never the thing falling out of frame.
 */
export function layoutNear(slots: Map<string, THREE.Vector3>): number {
  let m = 0;
  for (const p of slots.values()) m = Math.max(m, p.z);
  return m;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Per-bot look: a porcelain body and one accent hue.
 *
 * ## Why the bodies are pale, in a scene whose note above says the chassis stays
 * blackened steel
 *
 * That note's reasoning was about *status*: a red-tinted machine fights the oak,
 * and worse, it stops the panel's local background being a known quantity, which
 * every contrast figure in design-dna.json depends on. Pale bodies do not
 * reopen that, because the figures were never bought from the chassis — they are
 * bought from the BEZEL, `#1a1a19`, the exact `--surface` they were measured
 * against, and every status panel is still set into one. materials.ts says so at
 * the top. So the validated numbers (ok 5.19, partial 9.49, failed 3.62,
 * never_run 4.62, running 4.28) transfer unchanged, and a cream body actually
 * helps the saturated panel read by making it the only saturated thing on the bot.
 *
 * ## Why these hues and not nicer ones
 *
 * Status owns green, amber, red, grey and blue; the categorical slots own
 * `#3987e5`, `#d95926`, `#199e70`, `#c98500`. A cheerful red robot would read as
 * failed and a green one as ok, which is the one thing this scene may not do. The
 * accents are therefore drawn from the unclaimed part of the wheel — lilac, rose,
 * apricot, orchid, periwinkle — and desaturated to sit in a warm room.
 *
 * The accent is also never the only thing telling two bots apart: each one has a
 * distinct silhouette and a distinct prop, which is what actually carries
 * identity here, and which survives both colour-vision deficiency and a
 * greyscale screenshot.
 */
const BOT_LOOK: Record<string, { skin: number; tint: number }> = {
  "sam-research": { skin: 0xe8e0d2, tint: 0xb09fd4 },
  "finance-research": { skin: 0xe9e2d6, tint: 0xd69fb0 },
  "disk-cleanup": { skin: 0xe6dccb, tint: 0xdcae8c },
  "interface-design": { skin: 0xe9dfd6, tint: 0xc98fc4 },
  "agency-repair": { skin: 0xe4ddd2, tint: 0x9fa3c4 },
  /**
   * media-bot's pale cyan is the closest call in the set, and worth being
   * explicit about rather than quietly adding.
   *
   * The unclaimed part of the wheel is almost used up: five pastels are taken and
   * status owns green, amber, red, grey and blue while the categorical slots own
   * #3987e5, #d95926, #199e70 and #c98500. Cyan is the largest gap left. #8fbfd0
   * is far paler and far less saturated than either neighbour it could be confused
   * with — `--status-running` #3987e5 and `--cat-3` #199e70 — so it does not read
   * as either, and neither of those ever appears as a body colour anyway.
   *
   * It is also the point at which the accent stops being able to carry identity
   * on its own, which is fine, because it never was the thing doing that here:
   * this bot is separated by a headset silhouette and a ring of antennae. A
   * seventh bot should not look for a seventh hue — it should take DEFAULT_LOOK
   * and earn a distinct outline instead.
   */
  "media-bot": { skin: 0xe7e1d8, tint: 0x8fbfd0 },
};

const DEFAULT_LOOK = { skin: 0xe3dbcf, tint: 0xa9a094 };

/** A never-run bot dulls to this instead of to its own colours. */
const COLD_SKIN = 0x6f6a61;
const COLD_TINT = 0x5d5850;

interface Kit {
  /** The porcelain body. Per-bot tinted; dulled by applyStatus when never run. */
  shell: THREE.MeshStandardMaterial;
  /** The accent trim: scarf, hat, ears. Per-bot. */
  tint: THREE.MeshStandardMaterial;
  bezel: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  pale: THREE.MeshStandardMaterial;
  readout: THREE.MeshStandardMaterial;
  /** Glossy near-black, for eyes. */
  eye: THREE.MeshStandardMaterial;
  /** The catchlight. Emissive so it survives being in the head's own shadow. */
  glint: THREE.MeshStandardMaterial;
  skinColor: number;
  tintColor: number;
  own: { dispose(): void }[];
}

function makeKit(botId: string): Kit {
  const own: { dispose(): void }[] = [];
  const t = <T extends { dispose(): void }>(x: T): T => (own.push(x), x);
  const look = BOT_LOOK[botId] ?? DEFAULT_LOOK;
  return {
    // Low metalness and mid roughness: this is glazed ceramic, not machined
    // steel. Metalness above ~0.1 on a pale body turns it grey under the warm
    // lamps, which loses the whole toy-robot read.
    shell: t(surface(look.skin, { rough: 0.42, metal: 0.04, env: 0.55 })),
    tint: t(surface(look.tint, { rough: 0.46, metal: 0.04, env: 0.5 })),
    bezel: t(surface(CHASSIS.bezel, { rough: 0.6, metal: 0.2, env: 0.4 })),
    brass: t(metal(ROOM.brass, 0.3)),
    steel: t(metal(CHASSIS.accent, 0.42)),
    pale: t(surface(0xd8cfba, { rough: 0.9, env: 0.3 })),
    // A dim warm readout. Deliberately not a categorical slot: those are reserved
    // for the disk-composition bar and nothing else.
    readout: t(
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0xc9a86a,
        emissiveIntensity: 0.85,
        toneMapped: false,
      }),
    ),
    eye: t(surface(0x14120f, { rough: 0.12, metal: 0.0, env: 1.0 })),
    glint: t(
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0xfff4e2,
        emissiveIntensity: 1.15,
        toneMapped: false,
      }),
    ),
    skinColor: look.skin,
    tintColor: look.tint,
    own,
  };
}

const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z);
  return mesh;
};

const cyl = (rt: number, rb: number, h: number, m: THREE.Material, seg = 16) =>
  new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);

/** A sphere. The workhorse of every shape in this file. */
const ball = (r: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 22) => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.7)), m);
  mesh.position.set(x, y, z);
  return mesh;
};

/**
 * A capsule: the rounded-off limb and torso primitive.
 *
 * three has no rounded box, and a plain BoxGeometry is exactly the hard-edged
 * look being replaced here, so torsos and limbs are capsules and spheres and the
 * few remaining boxes are things that genuinely are flat — a book, a card, a tag.
 */
const capsule = (r: number, len: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 16), m);
  mesh.position.set(x, y, z);
  return mesh;
};

/**
 * The face, shared by every bot so they read as one family of toy.
 *
 * Two large glossy eyes with an offset catchlight, which is most of what makes a
 * shape read as a character rather than an appliance. The eyes sit slightly proud
 * of the head sphere so they never z-fight with it at grazing angles.
 *
 * `blink` is driven from absolute time rather than accumulated, because reduced
 * motion renders exactly ONE frame: an eye scaled by an incremental lerp would
 * freeze at whatever it happened to hold. The duty cycle is deliberately lopsided
 * — a blink occupies about 6% of each cycle — so a single frame overwhelmingly
 * lands on an open eye.
 */
function makeFace(
  kit: Kit,
  opts: { r: number; spread: number; y: number; z: number; tilt?: number } ,
): { group: THREE.Group; update(t: number, phase: number): void } {
  const group = new THREE.Group();
  const eyes: THREE.Mesh[] = [];
  for (const sx of [-1, 1] as const) {
    const socket = new THREE.Group();
    socket.position.set(sx * opts.spread, opts.y, opts.z);
    const e = ball(opts.r, kit.eye, 0, 0, 0, 18);
    socket.add(e);
    const g = ball(opts.r * 0.3, kit.glint, -sx * opts.r * 0.3, opts.r * 0.34, opts.r * 0.82, 10);
    socket.add(g);
    group.add(socket);
    eyes.push(e);
  }
  if (opts.tilt) group.rotation.x = opts.tilt;
  return {
    group,
    update(t, phase) {
      // A blink IS motion, and reduced motion renders one frame: a bot caught in
      // the closed 6% would be frozen squinting for as long as the page is open,
      // and across five bots that is a better-than-one-in-four chance of a still
      // frame containing a robot that looks broken. So under `reduce` the eyes
      // are simply always open.
      if (REDUCED.matches) {
        for (const e of eyes) e.scale.y = 1;
        return;
      }
      // A slow cycle with a short closed window at the end of it.
      const c = (t * 0.45 + phase) % 1;
      const shut = c > 0.94 ? 1 - Math.abs(c - 0.97) / 0.03 : 0;
      for (const e of eyes) e.scale.y = Math.max(0.08, 1 - shut * 0.92);
    },
  };
}

/* ----------------------------------------------------------------- personas */

interface Persona {
  body: THREE.Group;
  /** Height the camera should look at when this bot is focused. */
  eye: number;
  /** Where the status bezel is mounted. */
  panel: THREE.Vector3;
  /** Called every frame. `work` is 0..1 — how actively the machine is running. */
  idle(t: number, work: number): void;
  /** Builds the n-th item of stacked output. Local to the station. */
  item(i: number, kit: Kit): THREE.Object3D;
}

/**
 * sam-research — the scholar.
 *
 * The tallest and thinnest of the five, with square spectacles and a little
 * mortarboard, reading an open book it holds in both hands. It verifies
 * literature and tracks licences, so it is the one that reads and re-reads — and
 * the book is the prop that says so from across the room.
 */
function samResearch(kit: Kit): Persona {
  const body = new THREE.Group();

  const torso = capsule(0.38, 0.44, kit.shell, 0, 0.66, 0);
  body.add(torso);
  body.add(cyl(0.1, 0.13, 0.12, kit.steel, 14).translateY(0.11));

  const head = new THREE.Group();
  head.position.set(0, 1.38, 0);
  head.add(ball(0.37, kit.shell));
  const face = makeFace(kit, { r: 0.082, spread: 0.145, y: 0.03, z: 0.335 });
  head.add(face.group);

  // Square spectacles. Rounded rims would vanish against round eyes; square ones
  // are the whole reason this bot is identifiable in silhouette.
  for (const sx of [-1, 1] as const) {
    const rim = box(0.19, 0.17, 0.012, kit.tint, sx * 0.145, 0.03, 0.4);
    head.add(rim);
  }
  head.add(box(0.11, 0.012, 0.012, kit.tint, 0, 0.03, 0.4));

  // Mortarboard: a small cap plus the flat plate, tilted back a little so it
  // reads as worn rather than balanced.
  const cap = new THREE.Group();
  cap.position.set(0, 0.33, -0.02);
  cap.rotation.x = -0.18;
  cap.add(cyl(0.17, 0.19, 0.11, kit.tint, 16));
  cap.add(box(0.52, 0.022, 0.52, kit.tint, 0, 0.07, 0));
  const tassel = capsule(0.016, 0.13, kit.brass, 0.2, 0.0, 0.16);
  cap.add(tassel);
  head.add(cap);
  body.add(head);

  // Arms, holding the book out in front.
  const arms: THREE.Mesh[] = [];
  for (const sx of [-1, 1] as const) {
    const a = capsule(0.075, 0.2, kit.shell, sx * 0.4, 0.72, 0.16);
    a.rotation.x = -0.9;
    a.rotation.z = sx * 0.3;
    body.add(a);
    arms.push(a);
  }

  const bookPivot = new THREE.Group();
  bookPivot.position.set(0, 0.62, 0.44);
  bookPivot.rotation.x = -0.62;
  const spine = box(0.06, 0.03, 0.34, kit.tint, 0, 0, 0);
  bookPivot.add(spine);
  const leaves: THREE.Mesh[] = [];
  for (const sx of [-1, 1] as const) {
    const leaf = box(0.28, 0.022, 0.34, kit.pale, sx * 0.16, 0.005, 0);
    leaf.rotation.z = sx * -0.1;
    bookPivot.add(leaf);
    leaves.push(leaf);
  }
  body.add(bookPivot);

  return {
    body,
    eye: 1.42,
    panel: new THREE.Vector3(0, 0.78, 0.42),
    idle(t, work) {
      // Reads: bobs on the spot, and the head nods down the page. Both scale with
      // work, so a live run visibly reads faster.
      const sp = 0.5 + work * 1.6;
      body.position.y = 0.07 + Math.sin(t * sp) * 0.018;
      head.rotation.x = 0.1 + Math.sin(t * sp * 0.8) * 0.09;
      head.rotation.y = Math.sin(t * sp * 0.31) * 0.14;
      // Pages settle rather than flap: a page turn is a slow asymmetric thing.
      leaves[0]!.rotation.z = -0.1 + Math.sin(t * sp * 0.5) * 0.05;
      leaves[1]!.rotation.z = 0.1 - Math.sin(t * sp * 0.5 + 1.1) * 0.05;
      face.update(t, 0.0);
    },
    item(i, k) {
      // A sheet of paper, stacked.
      return box(0.5, 0.014, 0.36, k.pale, 0, 0.02 + i * 0.018, 0);
    },
  };
}

/**
 * finance-research — the ticker clerk.
 *
 * Egg-shaped and the roundest of the five, in a bow tie, with a tape spool on its
 * back and a printed ribbon spilling over one shoulder. It prints a pre-market
 * report every weekday, so it is the one that physically emits a run of tape.
 */
function financeResearch(kit: Kit): Persona {
  const body = new THREE.Group();

  // Egg body: a sphere scaled tall, which gives a fatter, lower centre of mass
  // than a capsule and reads as the plump one of the set.
  const torso = ball(0.46, kit.shell, 0, 0.58, 0);
  torso.scale.set(1, 1.18, 0.95);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, 1.24, 0);
  head.add(ball(0.34, kit.shell));
  const face = makeFace(kit, { r: 0.088, spread: 0.135, y: 0.02, z: 0.305 });
  head.add(face.group);
  // A flat cap brim, so it reads as a clerk rather than a scholar.
  const brim = cyl(0.36, 0.36, 0.018, kit.tint, 20);
  brim.position.y = 0.26;
  head.add(brim);
  head.add(cyl(0.2, 0.24, 0.13, kit.tint, 18).translateY(0.32));
  body.add(head);

  // Bow tie, at the neck. Two cones nose to nose plus a knot.
  const tie = new THREE.Group();
  tie.position.set(0, 0.99, 0.3);
  for (const sx of [-1, 1] as const) {
    const w = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.14, 12), kit.tint);
    w.position.x = sx * 0.1;
    w.rotation.z = sx * Math.PI * 0.5;
    tie.add(w);
  }
  tie.add(ball(0.045, kit.tint, 0, 0, 0.02, 12));
  body.add(tie);

  // Spool on the back, and the tape coming off it over the shoulder.
  const spool = cyl(0.2, 0.2, 0.11, kit.brass, 20);
  spool.rotation.z = Math.PI / 2;
  spool.position.set(0, 0.92, -0.42);
  body.add(spool);
  const hub = cyl(0.055, 0.055, 0.15, kit.steel, 12);
  hub.rotation.z = Math.PI / 2;
  hub.position.set(0, 0.92, -0.42);
  body.add(hub);
  const tape = box(0.1, 0.46, 0.01, kit.pale, 0.26, 0.78, -0.16);
  tape.rotation.set(0.3, 0, -0.3);
  body.add(tape);

  // Stubby arms.
  for (const sx of [-1, 1] as const) {
    const a = capsule(0.08, 0.16, kit.shell, sx * 0.45, 0.62, 0.05);
    a.rotation.z = sx * 0.42;
    body.add(a);
  }

  return {
    body,
    eye: 1.3,
    panel: new THREE.Vector3(0, 0.7, 0.44),
    idle(t, work) {
      // The spool is the work channel: idles slowly, spins hard on a live run.
      spool.rotation.x = t * (0.35 + work * 3.2);
      // A rounder bot gets a rounder motion — it rocks side to side rather than
      // bobbing straight up, which is what sells the weight of the egg shape.
      const s = Math.sin(t * (0.6 + work * 1.4));
      body.rotation.z = s * 0.035;
      body.position.y = 0.07 + Math.abs(s) * 0.02;
      head.rotation.z = -s * 0.06;
      face.update(t, 0.37);
    },
    item(i, k) {
      // A coil of printed tape on the floor.
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.2 + (i % 3) * 0.035, 0.026, 6, 22), k.pale);
      r.rotation.x = Math.PI / 2;
      r.position.y = 0.03 + i * 0.045;
      r.rotation.z = i * 0.7;
      return r;
    },
  };
}

/**
 * disk-cleanup — the sorter unit.
 *
 * A domed hopper on a roller, lid for a hat, brush arm, and a manifest tag
 * hanging off it. Nothing about it can delete: it carries things somewhere
 * reversible, which is the bot's entire premise, so the shape it is built around
 * is a container with a lid.
 *
 * ## Three parts used to be buried inside the body. Here is the arithmetic
 *
 * The hopper is a dome of radius `R` centred at `(0, DRUM_Y, 0)` sitting on a
 * cylinder of the same radius, so anywhere near the waist the body occupies every
 * point within `R` of the Y axis. `R` is 0.56. Any part mounted at a radial
 * distance under 0.56 from the axis is therefore *inside* the machine, and three
 * of them were:
 *
 * - **The manifest tag** — the flat panel that reads as a tablet, and the one
 *   that was reported. It sat at `(-0.44, 0.5, 0.36)`: radial distance
 *   `hypot(0.44, 0.36) = 0.568`, which clears 0.56 by 8 thousandths *at its
 *   centre point only*. The tag is 0.24 wide and 0.30 tall, so its near corner
 *   sat at `hypot(0.32, 0.36) = 0.482` — comfortably inside the shell — and the
 *   plate visibly sank into the body and swung through it every idle cycle.
 * - **The brush** — mounted at `hypot(0.52, 0.18) = 0.550`, so the handle was
 *   half-submerged, and its head at y=0.28 reached in to 0.45 against a body
 *   radius of ~0.505 down there.
 * - **The lid** — a flat disc of radius 0.54 at y=0.94, where the dome's own
 *   radius is only `sqrt(0.56² - 0.34²) = 0.445`. So the disc cut a slice
 *   *through* the dome instead of resting on it.
 *
 * The fix is not a nudge. Everything that hangs off this bot is now positioned
 * from `RIM`, a single constant that is the body radius plus real clearance, and
 * flat parts are oriented tangentially so their corners swing along the surface
 * rather than into it. The tag hangs from a bracket; the lid sits at the height
 * where the dome is actually as wide as the lid is.
 *
 * If you add another prop to this bot, mount it off `RIM` too. The reason all
 * three of these were wrong is that each was placed by eye from a different
 * reference.
 */
function diskCleanup(kit: Kit): Persona {
  const body = new THREE.Group();

  const R = 0.56;          // hopper radius
  const DRUM_Y = 0.6;      // centre of the dome
  const RIM = R + 0.14;    // where anything mounted on the outside belongs

  // A domed hopper on a roller instead of legs — squat, wide and bottom-heavy,
  // which is the silhouette that separates it from the four upright bots at any
  // distance.
  const drum = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.62), kit.shell);
  drum.position.y = DRUM_Y;
  // Tagged, with the radius, so scripts/test-scene.ts can assert every prop's
  // clearance against the real body rather than against a number copied into a
  // test and left to drift.
  drum.userData.role = "dc-body";
  drum.userData.radius = R;
  body.add(drum);
  body.add(cyl(R, 0.5, 0.34, kit.shell, 24).translateY(0.42));

  // The roller it trundles on.
  const roller = cyl(0.22, 0.22, 0.86, kit.steel, 18);
  roller.rotation.z = Math.PI / 2;
  roller.position.y = 0.22;
  body.add(roller);

  /**
   * Lid, which is also its hat, and it lifts while the bot is working — the one
   * place this scene lets a body part carry a data channel.
   *
   * `LID_R` and `LID_Y` are solved against each other rather than picked: the lid
   * sits at the height where the dome's cross-section is exactly the lid's radius,
   * minus a hair so it overlaps rather than floats. That is what makes it read as
   * a lid on an opening instead of a disc through a ball.
   *
   * The hinge is at the BACK of the rim, so the lid tips forward-up and away from
   * the head. Hinging it at the centre swung the front edge down through the face.
   */
  const LID_R = 0.42;
  const LID_Y = DRUM_Y + Math.sqrt(Math.max(0, R * R - LID_R * LID_R)) - 0.03;
  const lid = new THREE.Group();
  lid.position.set(0, LID_Y, -LID_R);
  const lidPlate = cyl(LID_R, LID_R + 0.04, 0.07, kit.tint, 24);
  lidPlate.position.z = LID_R;
  lidPlate.userData.role = "dc-lid";
  lid.add(lidPlate);
  lid.add(ball(0.07, kit.brass, 0, 0.06, LID_R, 12));
  body.add(lid);

  const head = new THREE.Group();
  head.position.set(0, 0.86, 0.24);
  head.add(ball(0.3, kit.shell));
  const face = makeFace(kit, { r: 0.085, spread: 0.125, y: 0.0, z: 0.27 });
  head.add(face.group);
  body.add(head);

  /**
   * The brush arm, mounted on the rim and angled outward.
   *
   * The pivot sits at `RIM` on +X with a small +Z bias, and the whole arm leans
   * away from the body, so neither the handle nor the head can reach back inside
   * however far the idle swing takes it. The swing is about Z at the shoulder,
   * which moves the head up and down along the outside of the hopper — not across
   * it.
   */
  const brush = new THREE.Group();
  brush.position.set(RIM, 0.62, 0.14);
  brush.rotation.z = -0.34;
  const brushHandle = capsule(0.028, 0.3, kit.brass, 0.1, -0.14, 0);
  brushHandle.userData.role = "dc-brush-handle";
  brush.add(brushHandle);
  const brushHead = box(0.19, 0.085, 0.13, kit.tint, 0.2, -0.34, 0);
  brushHead.userData.role = "dc-brush-head";
  brush.add(brushHead);
  body.add(brush);

  /**
   * The manifest tag — the part that was inside the body.
   *
   * A bracket off the rim, and the tag hangs from it on a pivot. The plate is
   * built thin on X (`box(0.01, 0.3, 0.26, ...)`) rather than built flat and then
   * rotated, so its face points radially outward with no rotation to get wrong.
   * That makes it edge-on to the hopper: its corners travel tangentially as it
   * swings and cannot re-enter the shell. It swings about X now rather than about
   * Z, which is the axis a card hanging on a hook actually swings on.
   *
   * Clearance check, since getting this wrong is what caused the bug: the pivot
   * is at x = -(RIM + 0.06) = -0.76. The plate is 0.01 thick and 0.26 wide in Z,
   * hanging 0.30 down. Its nearest point to the axis is 0.755, against a body
   * radius of 0.56. Margin 0.195, and the swing does not reduce it because the
   * rotation axis is radial.
   */
  const tagPivot = new THREE.Group();
  tagPivot.position.set(-(RIM + 0.06), 0.66, 0.0);
  const hook = capsule(0.015, 0.1, kit.steel, 0, -0.06, 0);
  tagPivot.add(hook);
  const tag = box(0.01, 0.3, 0.26, kit.pale, 0, -0.28, 0);
  tag.userData.role = "dc-tag";
  tagPivot.add(tag);
  // A stripe on the card, so it reads as a written manifest and not a blank chip.
  tagPivot.add(box(0.012, 0.02, 0.17, kit.tint, 0, -0.2, 0));
  body.add(tagPivot);

  // The bracket the tag hangs from, so the hook is attached to something.
  const bracket = box(0.18, 0.03, 0.05, kit.steel, -(RIM - 0.02), 0.7, 0);
  body.add(bracket);

  return {
    body,
    eye: 1.0,
    // Mounted on the front of the hopper, clear of the head above it.
    panel: new THREE.Vector3(0, 0.5, 0.5),
    idle(t, work) {
      // Trundles: rocks on the roller, and the roller turns with it. The lid
      // cracks open only while it is actually working.
      const s = Math.sin(t * (0.5 + work * 1.6));
      body.rotation.z = s * 0.016;
      roller.rotation.x = s * 0.4;
      // Swings about X — the axis a card on a hook swings on, and a radial axis
      // here, so the swing cannot carry a corner into the body.
      tagPivot.rotation.x = s * 0.3;
      lid.rotation.x = -work * 0.5 - Math.abs(s) * 0.03;
      // Rides its outward lean rather than replacing it, so the arm never rotates
      // back through the hopper at the extremes of the swing.
      brush.rotation.z = -0.34 + Math.sin(t * (0.9 + work * 2.4)) * (0.14 + work * 0.26);
      face.update(t, 0.71);
    },
    item(i, k) {
      // Quarantined crates.
      return box(0.42, 0.3, 0.34, k.shell, ((i % 2) - 0.5) * 0.1, 0.15 + i * 0.31, 0);
    },
  };
}

/**
 * interface-design — the drafting unit.
 *
 * A drafting table with a T-square, a swatch fan and an articulated lamp. The
 * swatches are tints of this room's own palette, not the categorical slots: those
 * are reserved for the disk-composition bar and may not be spent on decoration.
 */
function interfaceDesign(kit: Kit): Persona {
  const body = new THREE.Group();

  // The slender one. A narrow tapered torso and a beret worn at an angle, so its
  // outline leans where the other four stand square.
  const torso = capsule(0.3, 0.5, kit.shell, 0, 0.66, 0);
  body.add(torso);
  body.add(cyl(0.13, 0.17, 0.1, kit.steel, 14).translateY(0.1));

  const head = new THREE.Group();
  head.position.set(0, 1.32, 0);
  head.add(ball(0.33, kit.shell));

  // Deliberately asymmetric: one plain eye and one big brass loupe over the
  // other. Asymmetry is the strongest single silhouette cue available, and this
  // is the bot whose whole job is looking closely at things.
  const face = makeFace(kit, { r: 0.08, spread: 0.13, y: 0.02, z: 0.3 });
  head.add(face.group);
  const loupe = new THREE.Group();
  loupe.position.set(0.13, 0.02, 0.31);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.026, 8, 20), kit.brass);
  loupe.add(ring);
  const glassMat = surface(0x9fb4bd, { rough: 0.08, env: 0.9 });
  glassMat.transparent = true;
  glassMat.opacity = 0.34;
  // Pushed into the kit's own list so the rig's disposer reaches it. A material
  // created inside a persona builder and not handed back is a leak that only
  // shows up when a bot leaves the registry.
  kit.own.push(glassMat);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.11, 20), glassMat);
  glass.position.z = 0.01;
  loupe.add(glass);
  head.add(loupe);

  // Beret, tilted.
  const beret = new THREE.Group();
  beret.position.set(-0.05, 0.28, -0.02);
  beret.rotation.set(-0.12, 0, 0.34);
  const crown = ball(0.31, kit.tint, 0, 0, 0, 20);
  crown.scale.set(1, 0.46, 1);
  beret.add(crown);
  beret.add(ball(0.04, kit.tint, 0, 0.13, 0, 10));
  head.add(beret);
  body.add(head);

  // Brush arm — the one that moves — and a palette held in the other hand.
  const brushArm = new THREE.Group();
  brushArm.position.set(0.34, 0.86, 0.1);
  brushArm.add(capsule(0.062, 0.24, kit.shell, 0, -0.12, 0));
  const brush = new THREE.Group();
  brush.position.y = -0.28;
  brush.add(capsule(0.022, 0.26, kit.brass, 0, -0.1, 0));
  brush.add(new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 10), kit.tint).translateY(-0.29));
  brushArm.add(brush);
  body.add(brushArm);

  const palette = new THREE.Group();
  palette.position.set(-0.42, 0.72, 0.26);
  palette.rotation.set(-1.2, 0, 0.3);
  const board = new THREE.Mesh(new THREE.CircleGeometry(0.24, 20), kit.pale);
  board.rotation.x = -Math.PI / 2;
  palette.add(board);
  // Swatches in the room's own colours, NOT the categorical slots: those are
  // reserved for the disk-composition bar and may not be spent on decoration.
  const swatchCols = [ROOM.floor, ROOM.brass, ROOM.bench, CHASSIS.shell];
  swatchCols.forEach((c, i) => {
    const m = surface(c, { rough: 0.8, env: 0.3 });
    kit.own.push(m);
    const a = (i / swatchCols.length) * Math.PI * 2;
    palette.add(ball(0.038, m, Math.cos(a) * 0.13, 0.012, Math.sin(a) * 0.13, 10));
  });
  body.add(palette);

  for (const sx of [-1] as const) {
    const a = capsule(0.062, 0.2, kit.shell, sx * 0.34, 0.8, 0.1);
    a.rotation.z = sx * 0.5;
    body.add(a);
  }

  return {
    body,
    eye: 1.34,
    panel: new THREE.Vector3(0, 0.76, 0.36),
    idle(t, work) {
      // Paints: the brush arm strokes, and the head follows what it is doing.
      const sp = 0.55 + work * 1.7;
      brushArm.rotation.z = -0.25 + Math.sin(t * sp) * 0.26;
      brushArm.rotation.x = Math.sin(t * sp * 1.3) * 0.16;
      head.rotation.z = Math.sin(t * sp) * 0.05;
      head.rotation.y = 0.12 + Math.sin(t * sp * 0.9) * 0.1;
      body.position.y = 0.07 + Math.sin(t * sp * 0.7) * 0.012;
      face.update(t, 0.19);
    },
    item(i, k) {
      return box(0.34, 0.016, 0.24, k.pale, 0, 0.02 + i * 0.02, 0);
    },
  };
}

/**
 * agency-repair — the service unit.
 *
 * An articulated tool arm and a snapshot camera. The camera is not a flourish:
 * every Tier A repair snapshots the original file first, and that snapshot is the
 * only reason the bot is allowed to write code at all.
 */
function agencyRepair(kit: Kit): Persona {
  const body = new THREE.Group();

  // The stocky one: broad shoulders, short body, hard hat, and a head on a
  // visible coil spring — the only bot whose neck is a moving part, which is
  // what makes its bob read as bouncier than anyone else's.
  const torso = capsule(0.42, 0.3, kit.shell, 0, 0.6, 0);
  torso.scale.set(1.1, 1, 0.95);
  body.add(torso);
  body.add(cyl(0.2, 0.26, 0.14, kit.steel, 16).translateY(0.11));

  const coil = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.024, 6, 14), kit.steel);
  coil.rotation.x = Math.PI / 2;
  const coils: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const c = coil.clone();
    c.position.y = 0.94 + i * 0.055;
    body.add(c);
    coils.push(c);
  }

  const head = new THREE.Group();
  head.position.set(0, 1.32, 0);
  head.add(ball(0.32, kit.shell));
  const face = makeFace(kit, { r: 0.083, spread: 0.13, y: 0.0, z: 0.29 });
  head.add(face.group);

  // Hard hat: a dome with a brim and a centre ridge.
  const hat = new THREE.Group();
  hat.position.y = 0.16;
  const dome = ball(0.3, kit.tint, 0, 0, 0, 20);
  dome.scale.set(1, 0.72, 1);
  hat.add(dome);
  const hatBrim = cyl(0.4, 0.4, 0.02, kit.tint, 22);
  hatBrim.position.y = -0.04;
  hat.add(hatBrim);
  hat.add(box(0.05, 0.1, 0.56, kit.tint, 0, 0.16, 0));
  head.add(hat);
  body.add(head);

  // Tool arm with a spinning driver bit, and a wrench held in the other hand.
  const arm = new THREE.Group();
  arm.position.set(0.46, 0.78, 0.12);
  arm.add(capsule(0.07, 0.2, kit.shell, 0, -0.1, 0));
  const fore = new THREE.Group();
  fore.position.y = -0.24;
  fore.add(capsule(0.055, 0.16, kit.shell, 0, -0.1, 0));
  const driver = cyl(0.06, 0.016, 0.2, kit.brass, 12);
  driver.position.y = -0.3;
  fore.add(driver);
  arm.add(fore);
  body.add(arm);

  const wrench = new THREE.Group();
  wrench.position.set(-0.48, 0.66, 0.16);
  wrench.rotation.z = 0.5;
  wrench.add(capsule(0.03, 0.28, kit.brass, 0, 0, 0));
  wrench.add(new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.028, 6, 14), kit.brass).translateY(0.2));
  body.add(wrench);

  // Snapshot lens on the chest. Not a flourish: every Tier A repair snapshots the
  // original file first, and that snapshot is the only reason this bot is allowed
  // to write code at all.
  const lens = cyl(0.08, 0.08, 0.06, kit.brass, 16);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(-0.24, 0.86, 0.36);
  body.add(lens);

  return {
    body,
    eye: 1.34,
    panel: new THREE.Vector3(0.12, 0.68, 0.42),
    idle(t, work) {
      const s = 0.4 + work * 1.7;
      const bounce = Math.sin(t * s);
      // The spring compresses and the head rides it, so the whole bot reads as
      // sprung rather than floating.
      head.position.y = 1.32 + bounce * 0.045;
      head.rotation.z = bounce * 0.07;
      coils.forEach((c, i) => { c.position.y = 0.94 + i * 0.055 + bounce * 0.015 * (i + 1); });
      arm.rotation.x = -0.3 + Math.sin(t * s * 1.2) * 0.34;
      arm.rotation.z = -0.2 + Math.sin(t * s * 0.8) * 0.14;
      driver.rotation.y = t * (1 + work * 12);
      wrench.rotation.z = 0.5 + Math.sin(t * s * 0.6) * 0.12;
      face.update(t, 0.53);
    },
    item(i, k) {
      // Snapshot prints, face up, slightly askew.
      const p = box(0.3, 0.012, 0.24, k.pale, 0, 0.02 + i * 0.016, 0);
      p.rotation.y = (i % 3) * 0.14 - 0.14;
      return p;
    },
  };
}

/**
 * media-bot — the switchboard operator.
 *
 * ## The silhouette, and the rule it had to obey
 *
 * The note at the top of this file says: if a sixth bot is ever modelled, give it
 * a headgear silhouette none of the five already owns. Taken: mortarboard, flat
 * cap, lid, beret, hard hat.
 *
 * This one wears a **headset** — a band over the crown with a pad over each ear
 * and a boom mic swung round to the mouth. It is the only bot whose head reads as
 * *wider than it is tall* in outline, and the boom is the only forward-projecting
 * headgear element in the set, so it separates cleanly from all five in
 * silhouette, in greyscale, and at the back of the arrangement.
 *
 * The body is the second departure: a **ring of antennae** around a slim column,
 * which makes its outline spiky where every other bot is smooth. Five sources of
 * notifications, five antennae — and that is a count, not decoration, though it is
 * a count of the source *kinds* rather than of anything that changes, so it is not
 * claimed as a data channel.
 *
 * ## What it carries that the others do not
 *
 * A **letter tray** held in front, which is where its output stacks: envelopes.
 * The `item` builder returns an envelope rather than a sheet, because this bot's
 * unit of work is a message and the tray filling up is the reading.
 */
function mediaBot(kit: Kit): Persona {
  const body = new THREE.Group();

  // A slim column, slightly wider at the shoulders than the scholar, so it reads
  // as an operator at a desk rather than a reader.
  const torso = capsule(0.34, 0.46, kit.shell, 0, 0.64, 0);
  torso.scale.set(1.08, 1, 0.9);
  body.add(torso);
  body.add(cyl(0.15, 0.2, 0.11, kit.steel, 14).translateY(0.1));

  // The antenna ring. Radial, tilted outward, tipped with a bead — the spiky
  // outline that separates this bot from five smooth ones.
  const antennae: THREE.Group[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const arm = new THREE.Group();
    arm.position.set(Math.sin(a) * 0.3, 1.0, Math.cos(a) * 0.3);
    arm.rotation.z = Math.cos(a) * 0.34;
    arm.rotation.x = -Math.sin(a) * 0.34;
    arm.add(capsule(0.014, 0.26, kit.steel, 0, 0.15, 0));
    arm.add(ball(0.042, kit.tint, 0, 0.31, 0, 10));
    body.add(arm);
    antennae.push(arm);
  }

  const head = new THREE.Group();
  head.position.set(0, 1.34, 0);
  head.add(ball(0.33, kit.shell));
  const face = makeFace(kit, { r: 0.084, spread: 0.135, y: 0.02, z: 0.3 });
  head.add(face.group);

  // The headset. Band over the crown as a half torus, a pad over each ear, and the
  // boom swung round to the mouth. Wider than tall in outline, and the only
  // forward-projecting headgear in the cast.
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.028, 8, 24, Math.PI), kit.tint);
  band.rotation.y = Math.PI / 2;
  head.add(band);
  for (const sx of [-1, 1] as const) {
    const pad = cyl(0.11, 0.11, 0.07, kit.tint, 16);
    pad.rotation.z = Math.PI / 2;
    pad.position.set(sx * 0.33, 0.02, 0);
    head.add(pad);
  }
  const boom = new THREE.Group();
  boom.position.set(-0.3, -0.02, 0.06);
  boom.rotation.z = -0.5;
  boom.add(capsule(0.012, 0.24, kit.steel, 0.09, -0.09, 0.1));
  boom.add(ball(0.05, kit.tint, 0.19, -0.2, 0.2, 10));
  head.add(boom);
  body.add(head);

  // The letter tray, held in both hands. Its own output stacks in here.
  const arms: THREE.Mesh[] = [];
  for (const sx of [-1, 1] as const) {
    const a = capsule(0.066, 0.2, kit.shell, sx * 0.37, 0.7, 0.16);
    a.rotation.x = -0.75;
    a.rotation.z = sx * 0.28;
    body.add(a);
    arms.push(a);
  }
  const tray = new THREE.Group();
  tray.position.set(0, 0.58, 0.42);
  const trayFloor = box(0.5, 0.022, 0.3, kit.steel);
  tray.add(trayFloor);
  // Three sides, open at the front, so the stack inside is visible.
  tray.add(box(0.5, 0.07, 0.02, kit.steel, 0, 0.04, -0.15));
  for (const sx of [-1, 1] as const) tray.add(box(0.02, 0.07, 0.3, kit.steel, sx * 0.25, 0.04, 0));
  body.add(tray);

  return {
    body,
    eye: 1.36,
    panel: new THREE.Vector3(0, 0.84, 0.34),
    idle(t, work) {
      // Sorting: the head turns from one source to the next, and the antennae
      // twitch as things arrive. Both scale with work, so a live sweep visibly
      // reads faster.
      const sp = 0.5 + work * 1.8;
      body.position.y = Math.sin(t * sp * 0.8) * 0.016;
      head.rotation.y = Math.sin(t * sp * 0.45) * 0.38;
      head.rotation.x = 0.06 + Math.sin(t * sp * 0.7) * 0.05;
      // Each antenna on its own phase, so the ring shivers rather than pulsing as
      // one piece — five things arriving independently is the whole idea.
      antennae.forEach((arm, i) => {
        const base = (i / 5) * Math.PI * 2;
        arm.rotation.y = Math.sin(t * (1.1 + i * 0.37) + base) * (0.05 + work * 0.16);
      });
      tray.rotation.z = Math.sin(t * sp * 0.6) * 0.02;
      face.update(t, 0.44);
    },
    item(i, k) {
      // An envelope: a flat card with the flap drawn as a raised wedge across it.
      const env = new THREE.Group();
      const card = box(0.34, 0.014, 0.22, k.pale);
      env.add(card);
      const flap = box(0.16, 0.016, 0.16, k.tint, 0, 0.008, 0);
      flap.rotation.y = Math.PI / 4;
      env.add(flap);
      env.position.y = 0.03 + i * 0.019;
      env.rotation.y = ((i % 3) - 1) * 0.1;
      return env;
    },
  };
}

/**
 * The registry of shapes.
 *
 * Keyed on bot id, and a bot with no entry gets `fallback` rather than nothing —
 * a seventh bot appearing in the registry must still show up in the scene, even
 * before someone models it. Silently omitting it would make the scene disagree
 * with the rail about how many bots exist.
 */
const PERSONAE: Record<string, (kit: Kit) => Persona> = {
  "sam-research": samResearch,
  "finance-research": financeResearch,
  "disk-cleanup": diskCleanup,
  "interface-design": interfaceDesign,
  "agency-repair": agencyRepair,
  "media-bot": mediaBot,
};

function fallback(kit: Kit): Persona {
  // Deliberately the plainest of the six: a body, a head, a face, no prop. An
  // unmodelled bot should look unmistakably like the default rather than like a
  // sixth character somebody designed, so that "this one needs a persona" is
  // legible from the room itself.
  const body = new THREE.Group();
  body.add(capsule(0.34, 0.42, kit.shell, 0, 0.62, 0));
  body.add(cyl(0.14, 0.18, 0.1, kit.steel, 14).translateY(0.1));

  const head = new THREE.Group();
  head.position.set(0, 1.28, 0);
  head.add(ball(0.32, kit.shell));
  const face = makeFace(kit, { r: 0.082, spread: 0.13, y: 0.0, z: 0.29 });
  head.add(face.group);
  // A single antenna, so it still reads as a robot and not an egg.
  head.add(capsule(0.018, 0.16, kit.steel, 0, 0.38, 0));
  head.add(ball(0.05, kit.tint, 0, 0.52, 0, 12));
  body.add(head);

  for (const sx of [-1, 1] as const) {
    const a = capsule(0.068, 0.18, kit.shell, sx * 0.38, 0.66, 0.04);
    a.rotation.z = sx * 0.4;
    body.add(a);
  }

  return {
    body,
    eye: 1.3,
    panel: new THREE.Vector3(0, 0.72, 0.38),
    idle(t, work) {
      const sp = 0.5 + work * 1.5;
      body.position.y = 0.07 + Math.sin(t * sp) * 0.015;
      head.rotation.y = Math.sin(t * sp * 0.4) * 0.22;
      face.update(t, 0.85);
    },
    item(i, k) { return box(0.3, 0.02, 0.24, k.pale, 0, 0.02 + i * 0.022, 0); },
  };
}

/* -------------------------------------------------------------------- rig */

export interface BotRig {
  bot: Bot;
  /** The whole station. Carries `userData.botId` for the raycaster. */
  group: THREE.Group;
  /** World-space point the camera looks at when this bot is focused. */
  focusPoint(out: THREE.Vector3): THREE.Vector3;
  setBot(bot: Bot): void;
  /**
   * Selection highlight. The orrery carried this as a `uSelected` uniform that
   * pushed the fresnel rim; the equivalent here is the dock's own brass coming
   * up, because the bot's colour is spoken for by status and must not be
   * borrowed to mean "you clicked this".
   */
  setSelected(on: boolean): void;
  /** Normalised graph degree, 0..1. Zero renders no aura at all. */
  setAura(intensity: number): void;
  update(t: number, ambient: number, dim: number, now: number): void;
  dispose(): void;
}

export function makeBot(bot: Bot, pos: THREE.Vector3): BotRig {
  const kit = makeKit(bot.id);
  const own = kit.own;
  const t = <T extends { dispose(): void }>(x: T): T => (own.push(x), x);

  const group = new THREE.Group();
  group.position.copy(pos);
  group.userData.botId = bot.id;

  /* ------------------------------------------------------------------- bot */
  const persona = (PERSONAE[bot.id] ?? fallback)(kit);

  /**
   * Everything on this rig hangs off `bodyY`, and that is the whole difference
   * between the room's stations and these floating ones.
   *
   * The personas are all modelled feet-at-zero, because they used to stand on a
   * dock plate. Nothing is standing on anything now, so the rig shifts each body
   * DOWN by a little over half its eye height, which puts the bot's own middle at
   * the group origin. That matters for three separate things, and getting it wrong
   * breaks all three at once:
   *
   *  - the dial ring is centred on the origin, so it would hang around a bot's
   *    knees instead of around the bot;
   *  - the aura is a shell about the origin, so it would rim the wrong half;
   *  - `focusPoint` aims the camera at the origin, so a focused bot would sit at
   *    the top of the frame.
   *
   * 0.55 rather than 0.5 because a persona's mass is in its torso and head, so its
   * visual centre is above its geometric one.
   */
  const bodyY = -persona.eye * 0.55;
  persona.body.position.y = bodyY;
  persona.body.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  group.add(persona.body);

  /* ------------------------------------------------------------------ dial */
  /**
   * The schedule dial, which was inlaid in the dock's floor and is now a ring
   * around the bot.
   *
   * ## The plane changed, so the hand's sign changed with it
   *
   * The floor version drew ticks at `(sin a, ·, cos a)` and rotated the hand about
   * Y, where a child at local +Z lands at `(sin θ, ·, cos θ)` — so hand and ticks
   * agreed at `θ = +a`, and the old code carried a comment insisting the angle is
   * NOT negated.
   *
   * That comment was right about that plane and is wrong about this one. The ring
   * lives in XY now (which is `TorusGeometry`'s own plane, so there is no rotation
   * to forget) with ticks at `(sin a, cos a, ·)`, and a child at local +Y rotated
   * by `rotation.z = θ` lands at `(-sin θ, cos θ, ·)`. Hand and ticks therefore
   * agree only at `θ = -a`. **The hand IS negated here.** Both conventions are one
   * sign flip from a dial that runs backwards and still looks plausible until you
   * check it against a tick, which is exactly how long that class of bug survives.
   *
   * Angle 0 is at the top, so it reads as twelve o'clock: due now at the marker,
   * overdue drifting past it.
   *
   * ## Why a torus and not a ring
   *
   * `RingGeometry` is a flat annulus. In a room it was seen from above and read
   * fine; in space the camera can come level with it, and a flat ring seen edge-on
   * is one pixel of nothing. A torus is a hoop from every angle. It also needs no
   * `DoubleSide`, which a flat ring in an orbitable scene would.
   */
  const dial = new THREE.Group();
  // Leaned back, so the ring reads as a hoop in space rather than as a circle
  // drawn on the screen, and so it does not sit exactly across the bot's face.
  dial.rotation.x = -0.3;
  group.add(dial);

  const dialMat = t(
    new THREE.MeshStandardMaterial({
      color: ROOM.brass,
      emissive: ROOM.brass,
      // A trace of emissive so the ring is legible on the side facing away from
      // the key light. Brass in shadow against a dark sky is invisible otherwise.
      emissiveIntensity: DIAL_EM,
      roughness: 0.32,
      metalness: 0.9,
      envMapIntensity: 0.9,
    }),
  );
  const ring = new THREE.Mesh(t(new THREE.TorusGeometry(DIAL_R, DIAL_TUBE, 8, 96)), dialMat);
  dial.add(ring);

  const markMat = t(
    new THREE.MeshStandardMaterial({
      color: ROOM.brassBright,
      emissive: ROOM.brassBright,
      emissiveIntensity: MARK_EM,
      roughness: 0.3,
      metalness: 0.9,
    }),
  );
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const isMarker = i === 0;
    const len = isMarker ? 0.3 : 0.14;
    // A group per tick, rotated by -a, holding a box that is long in +Y. The box's
    // own axis therefore becomes the radial direction with no second rotation to
    // reason about — the same construction the hand uses, which is what keeps the
    // two in agreement.
    const holder = new THREE.Group();
    holder.rotation.z = -a;
    const tick = new THREE.Mesh(
      t(new THREE.BoxGeometry(isMarker ? 0.075 : 0.038, len, 0.038)),
      isMarker ? markMat : dialMat,
    );
    tick.position.y = DIAL_R + len * 0.5 - 0.02;
    // Tagged so scripts/test-scene.ts can find the marker and the hand and assert
    // that they coincide at angle zero. That test exists because the sign of the
    // hand's rotation is the one thing here that can be wrong while looking
    // completely plausible — see the note above.
    if (isMarker) tick.userData.role = "dial-marker";
    holder.add(tick);
    dial.add(holder);
  }

  // The hand. Sits on the ring at the bot's phase; this is the channel that used
  // to be the body's own position on its orbit.
  const hand = new THREE.Group();
  const handMat = t(
    new THREE.MeshStandardMaterial({
      color: ROOM.brassBright,
      emissive: ROOM.brassBright,
      emissiveIntensity: HAND_EM,
      roughness: 0.28,
      metalness: 0.9,
      toneMapped: false,
    }),
  );
  const handMesh = new THREE.Mesh(t(new THREE.BoxGeometry(0.1, 0.4, 0.1)), handMat);
  handMesh.position.y = DIAL_R;
  handMesh.userData.role = "dial-hand";
  hand.add(handMesh);
  dial.add(hand);

  // Geometries created inside the persona builders are not in `own`, so collect
  // them by traversal instead of asking every builder to remember. Materials are
  // the kit's and already tracked; a Set keeps a shared geometry from being
  // disposed twice.
  const personaGeos = new Set<THREE.BufferGeometry>();
  persona.body.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) personaGeos.add(m.geometry);
  });

  /* ----------------------------------------------------------- status panel */
  // `persona.panel` is in body coordinates — every persona measured it against a
  // body whose feet were at zero — so it takes the same bodyY shift the body did.
  // Without that the bezel floats where the bot's chest used to be.
  const panelY = persona.panel.y + bodyY;
  const bezel = box(0.6, 0.6, 0.07, kit.bezel, persona.panel.x, panelY, persona.panel.z);
  bezel.castShadow = true;
  group.add(bezel);
  personaGeos.add(bezel.geometry);

  const panelMat = t(emissive(STATUS_COLOR[bot.status], 1.6));
  panelMat.emissiveMap = glyphTexture(bot.status);
  const panelGeo = t(new THREE.PlaneGeometry(0.44, 0.44));
  const panel = new THREE.Mesh(panelGeo, panelMat);
  panel.position.set(persona.panel.x, panelY, persona.panel.z + 0.04);
  group.add(panel);

  /* ------------------------------------------------------------ accumulator */
  /**
   * Cumulative token spend, as physical output.
   *
   * On the floor this was a stack at the foot of the dock — paper, tape coils,
   * crates, prints. It is the same stack, floating beside the bot as cargo, and
   * it keeps the reading unchanged because the reading was always "how much has
   * come out of this thing", not "what is it resting on".
   *
   * Placed OUTSIDE the dial ring on the near side (x beyond DIAL_R) rather than
   * inside it. Inside, the ring's hand swept straight through the stack twice a
   * cycle, which looked like a fault in the geometry rather than a clock.
   */
  const stack = new THREE.Group();
  stack.position.set(-(DIAL_R + 0.55), bodyY + 0.1, 0.5);
  group.add(stack);

  /**
   * Items are laid out in SHORT COLUMNS, not one tall one.
   *
   * On a floor a single column was right — it was a stack of paper on the ground and
   * gravity explained it. In space a headless capture showed what it had become:
   * disk-cleanup at 150k tokens hits the 14-item cap with crates 0.31 apart, which
   * is a **4.3-unit tower next to a 1.7-unit robot**. It read as a rendering
   * artifact rather than as cargo, and it was by far the tallest thing in frame.
   *
   * Five per column caps the height at about 1.5 units — roughly the bot's own
   * height, which is the proportion that reads as "belonging to" it. The count is
   * unchanged, so the channel is unchanged.
   *
   * Each item goes in a holder the rig positions, and `persona.item` is handed the
   * WITHIN-COLUMN index. That is what keeps the per-persona vertical spacing
   * correct without every builder needing to know about columns; the cost is that
   * the small index-derived jitter some of them apply repeats per column, which is
   * invisible at this scale.
   */
  const PER_COLUMN = 5;

  function rebuildStack(tokens: number): void {
    for (const c of [...stack.children]) {
      stack.remove(c);
      // Traversed, not cast: children are holder Groups now, so checking the child
      // itself for `.isMesh` would leak every geometry under it.
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    const n = Math.max(0, Math.min(ITEM_CAP, Math.round(tokens / ITEM_TOKENS)));
    for (let i = 0; i < n; i++) {
      const col = Math.floor(i / PER_COLUMN);
      const o = persona.item(i % PER_COLUMN, kit);
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) c.castShadow = true;
      });
      const holder = new THREE.Group();
      // Stepped away from the bot and slightly back, so columns read as a group of
      // stacks rather than as one wide wall.
      holder.position.set(-col * 0.52, 0, -col * 0.16);
      holder.add(o);
      stack.add(holder);
    }
  }
  rebuildStack(bot.totalTokens);

  /* ------------------------------------------------------------------ aura */
  const auraMat = t(
    new THREE.ShaderMaterial({
      vertexShader: AURA_VERT,
      fragmentShader: AURA_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSwell: { value: 1 },
        uColor: { value: new THREE.Color(ENERGY.aura) },
        uIntensity: { value: 0 },
        uDim: { value: 1 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      /**
       * FrontSide, and this was `BackSide` until a headless capture showed what
       * that actually renders.
       *
       * `AURA_FRAG` is a fresnel: `pow(1 - clamp(dot(normal, viewDir), 0, 1), 4.2)`,
       * meant to be bright at grazing angles and transparent head-on so it rims the
       * silhouette. That only works on the near hemisphere.
       *
       * With `BackSide` you draw the FAR hemisphere, whose outward normals point
       * away from the camera. `dot(normal, viewDir)` is then negative everywhere,
       * the clamp takes it to 0, and `pow(1 - 0, 4.2)` is **1 across the entire
       * disc** — so the "rim" was a uniformly filled ellipse. Additive over a warm
       * lit room it was dim enough to pass unnoticed; additive over a near-black sky
       * it rendered as a flat olive disc behind every bot, larger than the bot and
       * clearly reading as a bug.
       *
       * On `FrontSide` the near hemisphere's normals face the camera at the centre
       * (dot ~ 1, fresnel ~ 0) and are perpendicular at the edge (dot ~ 0, fresnel
       * ~ 1), which is the rim the shader was written for. Nothing occludes the bot
       * because `depthWrite` is off and the centre contributes nothing.
       */
      side: THREE.FrontSide,
    }),
  );
  const aura = new THREE.Mesh(t(new THREE.SphereGeometry(1, 24, 16)), auraMat);
  // Sized to the MACHINE, not to the rig. An earlier version was roughly the
  // bot's full height and centred high, which enclosed the dial and the output
  // stack as well — so the aura appeared to be a property of the whole station
  // rather than of the bot, and it swallowed the two channels next to it. Kept
  // inside DIAL_R for the same reason: an aura that reaches the ring makes the
  // ring look like part of the glow.
  aura.scale.set(0.92, persona.eye * 0.72, 0.92);
  aura.position.y = bodyY + persona.eye * 0.62;
  aura.renderOrder = 6;
  group.add(aura);

  /* ---------------------------------------------------------------- state */
  let current = bot;
  let targetWork = bot.status === "running" ? 1 : 0;
  let work = targetWork;
  let auraTarget = 0;
  let selectGlow = 0;
  let selectTarget = 0;

  function applyStatus(b: Bot): void {
    const hex = STATUS_COLOR[b.status];
    // Status snaps rather than tweens: motion-spec.md forbids animating a status
    // change, because a failure has to land immediately.
    panelMat.emissive.setHex(hex);
    panelMat.emissiveMap = glyphTexture(b.status);
    panelMat.needsUpdate = true;

    const cold = b.status === "never_run";
    panelMat.emissiveIntensity = cold ? 0.3 : 1.6;
    // A never-run bot goes grey and dusty rather than to its own colours. The
    // original note for this channel still applies and matters more now: in a lit
    // room an unlit panel is indistinguishable from a panel in shadow, so the
    // BODY has to carry "nobody has started this". Draining the skin and the
    // accent to two dead greys is conspicuous next to four coloured siblings —
    // which was always the point of the channel — while leaving the silhouette
    // and the face fully readable, so it reads as switched off rather than
    // missing.
    kit.shell.color.setHex(cold ? COLD_SKIN : kit.skinColor);
    kit.tint.color.setHex(cold ? COLD_TINT : kit.tintColor);
    // Dust settles on a machine nobody has started: rougher, less environment.
    kit.shell.roughness = cold ? 0.86 : 0.42;
    kit.shell.envMapIntensity = cold ? 0.25 : 0.55;
    kit.tint.roughness = cold ? 0.88 : 0.46;
    kit.tint.envMapIntensity = cold ? 0.2 : 0.5;
    // The catchlight is the one part that must go out completely. A pair of lit
    // highlights on a dead bot reads as awake, and no amount of grey chassis
    // argues a viewer out of two shining eyes.
    kit.glint.emissiveIntensity = cold ? 0.0 : 1.15;
    dialMat.emissiveIntensity = cold ? DIAL_EM_COLD : DIAL_EM;
    handMat.emissiveIntensity = cold ? HAND_EM_COLD : HAND_EM;
  }
  applyStatus(bot);

  return {
    bot: current,
    group,
    focusPoint(out) {
      // The group origin, which the bodyY shift above made the bot's own middle
      // and the centre of its dial ring. The room's version aimed at `persona.eye`
      // because the body's feet were at zero there; aiming at eye height now would
      // put the ring's lower half out of frame.
      //
      // `pos`, not `group.position` — the group's Y is being animated by the float
      // below, and following it would make the camera bob along with the bot.
      return out.set(pos.x, pos.y, pos.z);
    },
    setBot(next) {
      const tokensChanged = next.totalTokens !== current.totalTokens;
      current = next;
      this.bot = next;
      applyStatus(next);
      targetWork = next.status === "running" ? 1 : 0;
      if (tokensChanged) rebuildStack(next.totalTokens);
    },
    setSelected(on) {
      selectTarget = on ? 1 : 0;
    },
    setAura(intensity) {
      // Scaled down hard. The graph's normalised degree is the right *ratio*
      // between bots, but taking the busiest bot to full additive brightness put
      // more light on the room than the window did. AURA_GAIN keeps the ratio and
      // spends far less of the frame on it.
      auraTarget = Math.max(0, Math.min(1, intensity)) * AURA_GAIN;
    },
    update(time, ambient, dim, now) {
      work = ease(work, targetWork, 0.06);
      selectGlow = ease(selectGlow, selectTarget, 0.12);
      persona.idle(time, work);

      // The hand tracks the dial.
      //
      // NEGATED, and that is the opposite of what this line said when the dial was
      // inlaid in a floor. See the long note where the dial is built: the ring
      // moved from the XZ plane to XY, ticks are now placed at (sin a, cos a, ·),
      // and a group whose child sits at local +Y lands at (-sin θ, cos θ, ·) after
      // `rotation.z = θ`. Hand and ticks therefore agree only at θ = -a. The wrong
      // sign here gives a clock that runs backwards and looks entirely plausible
      // until you check it against a tick, which is why it is written down twice.
      hand.rotation.z = -angleFor(current, now);

      // The float. Every bot bobs on its own phase and its own period, both hashed
      // off the id, so the group never pulses in unison — five things drifting
      // together reads as the camera moving, not as the bots floating.
      //
      // This is the group's Y, so it composes with the persona's own idle bob
      // (which is the body's Y) rather than replacing it. Amplitude is kept under
      // the layout's own vertical jitter so the float never reorders which bot
      // looks highest.
      const fp = unit(current.id, 91) * Math.PI * 2;
      const fs = 0.16 + unit(current.id, 137) * 0.14;
      group.position.y = pos.y + Math.sin(time * fs + fp) * 0.34;
      // A slow list, so a bot reads as suspended rather than as riding a lift.
      group.rotation.z = Math.sin(time * fs * 0.7 + fp) * 0.022;
      group.rotation.x = Math.cos(time * fs * 0.5 + fp) * 0.016;

      // Running pulses the panel's brightness rather than moving anything, so the
      // state is legible in a still frame and under reduced motion.
      const cold = current.status === "never_run";
      const base = cold ? 0.3 : 1.6;
      const pulse = work * (0.5 + 0.5 * Math.sin(time * 3.1)) * 0.9;
      panelMat.emissiveIntensity = (base + pulse) * dim;

      // Selection lifts the dial's brass rather than the bot's colour. The bot's
      // colour is spoken for by status and must not be borrowed to mean "you
      // clicked this"; the dial is the thing you came to read, so it brightens.
      handMat.emissiveIntensity = ((cold ? HAND_EM_COLD : HAND_EM) + selectGlow * 1.1) * dim;
      dialMat.emissiveIntensity = ((cold ? DIAL_EM_COLD : DIAL_EM) + selectGlow * 0.5) * dim;
      markMat.emissiveIntensity = (MARK_EM + selectGlow * 0.8) * dim;

      auraMat.uniforms.uTime!.value = time;
      auraMat.uniforms.uIntensity!.value = ease(auraMat.uniforms.uIntensity!.value as number, auraTarget, 0.05);
      auraMat.uniforms.uDim!.value = ambient * dim;
    },
    dispose() {
      group.parent?.remove(group);
      for (const g of personaGeos) g.dispose();
      // Traversed rather than cast, because a stack child is a holder Group now and
      // the meshes are one level down. Casting the child and checking `.isMesh`
      // silently freed nothing.
      stack.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const d of own) d.dispose();
    },
  };
}
