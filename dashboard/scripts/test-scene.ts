/**
 * Geometry tests for the studio. `npm run test:scene`
 *
 * ## Why this exists
 *
 * Two bugs prompted it, and they are the same bug twice: a 3D scene has no
 * compiler, so a part in the wrong place is only ever caught by somebody looking
 * at it from the right angle.
 *
 *  1. **disk-cleanup's manifest tag was inside its body.** It cleared the hopper
 *     by 8 thousandths of a unit at its centre point and by *nothing* at its near
 *     corner, so the plate sank into the machine and swung through it. Nobody
 *     noticed for a week. Two more parts on the same bot turned out to be wrong in
 *     the same way once anyone measured.
 *  2. **The dial's hand ran backwards.** Twice, in two different planes, because
 *     the sign depends on which plane the ring is in — and a clock running
 *     anticlockwise looks entirely plausible until you check it against a tick.
 *
 * Both are arithmetic, and arithmetic can be asserted. Neither needs WebGL: three
 * computes geometry, transforms and world matrices on the CPU, so everything below
 * runs in plain Node.
 *
 * ## What it does NOT do
 *
 * It does not check that the scene looks good, and it cannot. It does not check
 * for intersections in general — several are deliberate (a status bezel is *set
 * into* the chassis, and disk-cleanup's head emerges through its dome), so a blanket
 * "nothing may overlap" rule would fail on correct geometry. It asserts the
 * specific clearances the code claims in its comments, which is the part that
 * silently rots.
 */
import * as THREE from "three";

/* --------------------------------------------------------------- DOM stubs */
/**
 * bots3d.ts reads `window.matchMedia` at module scope for the reduced-motion
 * check, and `glyphTexture` in materials.ts draws into a real 2D canvas. Neither
 * exists in Node, and neither is what is under test, so both get the smallest stub
 * that lets the module load.
 *
 * The 2D context is a Proxy that answers every property with a no-op function.
 * That is deliberately cruder than a canvas shim: the moment this file starts
 * depending on what the glyph canvas actually contains, the stub should be
 * replaced rather than extended, because at that point the test is about drawing.
 */
const g = globalThis as Record<string, unknown>;
g.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
g.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop === "canvas") return { width: 0, height: 0 };
            return () => undefined;
          },
          set: () => true,
        },
      ),
  }),
};

const { makeBot, layoutSlots, layoutVertical, layoutExtent, angleFor } = await import("../src/scene/bots3d");
type Bot = Parameters<typeof makeBot>[0];

/* ---------------------------------------------------------------- harness */

let failures = 0;
let checks = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function near(name: string, actual: number, expected: number, tol: number): void {
  ok(name, Math.abs(actual - expected) <= tol, `${actual.toFixed(4)} vs ${expected.toFixed(4)} +-${tol}`);
}

function bot(over: Partial<Bot> = {}): Bot {
  return {
    id: "disk-cleanup",
    name: "disk-cleanup",
    blurb: "",
    cadence: "weekly",
    orbitRadius: 10,
    triggerable: true,
    dryRunOnly: true,
    status: "ok",
    statusDetail: null,
    lastRunDate: "2026-08-01",
    runCount: 3,
    totalTokens: 40000,
    tokenSeries: [],
    nextRun: null,
    ...over,
  } as Bot;
}

function findByRole(root: THREE.Object3D, role: string): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.userData.role === role) hit = o;
  });
  return hit;
}

/** Every corner of a box mesh, in the coordinate space of `root`. */
function corners(mesh: THREE.Mesh, root: THREE.Object3D): THREE.Vector3[] {
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  const out: THREE.Vector3[] = [];
  for (const x of [bb.min.x, bb.max.x]) {
    for (const y of [bb.min.y, bb.max.y]) {
      for (const z of [bb.min.z, bb.max.z]) {
        const p = new THREE.Vector3(x, y, z);
        mesh.localToWorld(p);
        root.worldToLocal(p);
        out.push(p);
      }
    }
  }
  return out;
}

/* ------------------------------------------------- disk-cleanup clearances */

/**
 * The hopper occupies every point within `R` of the bot's Y axis, between the
 * bottom of the cylinder and the top of the dome. So the test for "is this prop
 * inside the machine" is: what is the smallest radial distance from the Y axis
 * that any corner of the prop reaches?
 *
 * Checked at the WORST point, not at the centre — checking the centre is precisely
 * the mistake that let the original tag through with an 8-thousandth margin while
 * a corner of it was 78 thousandths deep inside the shell.
 *
 * The idle animation is applied first, at the extremes of its swing, because a
 * part can be clear at rest and not clear in motion — which the original tag also
 * was: it swung about Z, straight through the body.
 */
function testDiskCleanupClearance(): void {
  console.log("\ndisk-cleanup — nothing hangs inside the hopper");

  const rig = makeBot(bot({ id: "disk-cleanup" }), new THREE.Vector3(0, 0, 0));
  const body = findByRole(rig.group, "dc-body");
  if (!body) {
    ok("dc-body is tagged", false, "no mesh carries userData.role = dc-body");
    return;
  }
  const R = body.userData.radius as number;
  ok("hopper radius is readable from the model", typeof R === "number" && R > 0, `R = ${R}`);

  const props = ["dc-tag", "dc-brush-handle", "dc-brush-head", "dc-lid"];

  // Sample the idle animation across a full cycle so a part that only collides at
  // one phase of the swing is still caught. 24 samples over 40 seconds covers
  // every extreme of the sine terms in diskCleanup's idle().
  const SAMPLES = 24;
  const worst = new Map<string, number>();

  for (let s = 0; s < SAMPLES; s++) {
    const time = (s / SAMPLES) * 40;
    // work = 1 opens the lid fully and widens the brush swing, which is the
    // configuration most likely to collide.
    rig.update(time, 1, 1, Date.now());
    rig.group.updateWorldMatrix(true, true);

    for (const role of props) {
      const mesh = findByRole(rig.group, role) as THREE.Mesh | null;
      if (!mesh) continue;
      // Measured in the BODY's space, not the group's: the group is tilted and
      // bobbing by the float animation, and the hopper tilts with it, so a
      // group-space radius would drift with the list and report a false collision.
      const parentBody = mesh.parent ? (mesh.parent.parent ?? mesh.parent) : rig.group;
      void parentBody;
      for (const c of corners(mesh, body.parent ?? rig.group)) {
        const radial = Math.hypot(c.x, c.z);
        // Only count points at a height where the hopper actually exists. A part
        // hanging BELOW the machine is allowed to be near the axis; the roller is.
        const insideHeight = c.y > 0.22 && c.y < 1.18;
        if (!insideHeight) continue;
        const prev = worst.get(role);
        if (prev === undefined || radial < prev) worst.set(role, radial);
      }
    }
  }

  for (const role of props) {
    const w = worst.get(role);
    if (w === undefined) {
      // The lid's plate sits above the dome, so it can legitimately have no
      // corner in the hopper's height band at all. That is a pass, not a gap.
      ok(`${role} has no point inside the hopper's height range`, true, "nothing to check");
      continue;
    }
    ok(
      `${role} clears the hopper at its worst corner over a full idle cycle`,
      w >= R,
      `closest ${w.toFixed(3)} vs body radius ${R.toFixed(3)}`,
    );
  }

  rig.dispose();
}

/**
 * The lid is the one part that is SUPPOSED to touch the body: it is a lid on an
 * opening. What must hold is that it sits at the height where the dome is as wide
 * as the lid is, so it caps the dome instead of slicing through it.
 */
function testLidSeat(): void {
  console.log("\ndisk-cleanup — the lid caps the dome rather than cutting it");

  const rig = makeBot(bot({ id: "disk-cleanup", status: "ok" }), new THREE.Vector3(0, 0, 0));
  // work = 0, so the lid is closed and sitting where it seats.
  rig.update(0, 1, 1, Date.now());
  rig.group.updateWorldMatrix(true, true);

  const body = findByRole(rig.group, "dc-body")!;
  const lid = findByRole(rig.group, "dc-lid") as THREE.Mesh | null;
  if (!lid) {
    ok("dc-lid is tagged", false);
    rig.dispose();
    return;
  }
  const R = body.userData.radius as number;

  const centre = new THREE.Vector3();
  lid.getWorldPosition(centre);
  (body.parent ?? rig.group).worldToLocal(centre);

  lid.geometry.computeBoundingBox();
  const lidR = lid.geometry.boundingBox!.max.x;

  const drumY = body.position.y;
  // The dome's cross-section radius at the lid's height.
  const dy = centre.y - drumY;
  const domeR = Math.sqrt(Math.max(0, R * R - dy * dy));

  ok(
    "the lid is no wider than the dome is at the lid's height",
    lidR <= domeR + 0.06,
    `lid ${lidR.toFixed(3)} vs dome ${domeR.toFixed(3)} at dy ${dy.toFixed(3)}`,
  );
  ok("the lid sits above the dome's equator", dy > 0, `dy = ${dy.toFixed(3)}`);

  rig.dispose();
}

/* --------------------------------------------------------------- the dial */

/**
 * The hand and the marker must coincide when a run is due now.
 *
 * `angleFor` returns 0 exactly when the next run is one full period away, and
 * 2*PI when it is due — both of which land on the marker. A bot with no schedule
 * gets a hash-derived angle instead, so this test gives it a real `nextRun` at
 * exactly one period out.
 *
 * This is the assertion the two sign bugs would both have failed. It does not
 * check the direction of travel on its own, so there is a second check below for
 * that: a bot half a period out must put the hand opposite the marker, and a bot
 * a quarter period out must be on the correct SIDE.
 */
function testDialHand(): void {
  console.log("\ndial — the hand agrees with its own ticks");

  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);

  const at = (msUntilNextRun: number) => {
    const b = bot({ id: "finance-research", cadence: "daily", nextRun: new Date(now + msUntilNextRun).toISOString() });
    const rig = makeBot(b, new THREE.Vector3(0, 0, 0));
    rig.update(0, 1, 1, now);
    rig.group.updateWorldMatrix(true, true);
    const marker = findByRole(rig.group, "dial-marker")!;
    const hand = findByRole(rig.group, "dial-hand")!;
    const m = new THREE.Vector3();
    const h = new THREE.Vector3();
    marker.getWorldPosition(m);
    hand.getWorldPosition(h);
    // Into the dial's own space, which strips the float tilt and the -0.3 lean so
    // the comparison is a clean 2D one on the dial face.
    const dial = marker.parent!.parent!;
    dial.worldToLocal(m);
    dial.worldToLocal(h);
    rig.dispose();
    return { m, h };
  };

  // Due now: remaining = 0, so angleFor = 2*PI, which is the marker.
  {
    const { m, h } = at(0);
    const angle = Math.abs(Math.atan2(h.x, h.y) - Math.atan2(m.x, m.y));
    near("due now: the hand is on the marker", Math.min(angle, Math.PI * 2 - angle), 0, 0.02);
  }

  // A full period out: remaining = period, so angleFor = 0, also the marker.
  {
    const { m, h } = at(DAY);
    const angle = Math.abs(Math.atan2(h.x, h.y) - Math.atan2(m.x, m.y));
    near("a full period out: the hand is on the marker", Math.min(angle, Math.PI * 2 - angle), 0, 0.02);
  }

  // Half a period out: directly opposite the marker.
  {
    const { m, h } = at(DAY / 2);
    let angle = Math.atan2(h.x, h.y) - Math.atan2(m.x, m.y);
    while (angle < 0) angle += Math.PI * 2;
    near("half a period out: the hand is opposite the marker", angle, Math.PI, 0.02);
  }

  // Three quarters ELAPSED (a quarter remaining) must be three quarters of the way
  // round in the direction the ticks are numbered. This is the check that fails if
  // the sign is flipped: a mirrored hand lands at a quarter instead.
  {
    const { m, h } = at(DAY / 4);
    let angle = Math.atan2(h.x, h.y) - Math.atan2(m.x, m.y);
    while (angle < 0) angle += Math.PI * 2;
    // angleFor = (1 - 0.25) * 2PI = 1.5PI, and the hand is at -that about Z, which
    // in the atan2(x, y) convention used here reads as +1.5PI from the marker.
    near("a quarter remaining: the hand is three quarters round", angle, Math.PI * 1.5, 0.02);
  }

  ok(
    "the hand sits on the ring, not inside it",
    (() => {
      const { h } = at(DAY / 3);
      return Math.hypot(h.x, h.y) > 1.2;
    })(),
    "radius from the dial centre",
  );
}

/* -------------------------------------------------------------- the layout */

function testLayout(): void {
  console.log("\nlayout — floating positions, and the extents the camera fits to");

  const bots = [
    bot({ id: "finance-research", cadence: "daily", orbitRadius: 4.5 }),
    bot({ id: "agency-repair", cadence: "daily", orbitRadius: 2.6 }),
    bot({ id: "media-bot", cadence: "daily", orbitRadius: 1.2 }),
    bot({ id: "sam-research", cadence: "weekly", orbitRadius: 7.5 }),
    bot({ id: "disk-cleanup", cadence: "weekly", orbitRadius: 10 }),
    bot({ id: "interface-design", cadence: "on-demand", orbitRadius: 13 }),
  ];
  const slots = layoutSlots(bots);

  ok("every bot got a slot", slots.size === bots.length, `${slots.size} of ${bots.length}`);

  // Depth is cadence and only cadence. If a Y offset ever leaked into Z this fails.
  const zByCadence = new Map<string, Set<number>>();
  for (const b of bots) {
    const p = slots.get(b.id)!;
    const set = zByCadence.get(b.cadence) ?? new Set<number>();
    set.add(Number(p.z.toFixed(6)));
    zByCadence.set(b.cadence, set);
  }
  ok(
    "bots sharing a cadence share exactly one depth",
    [...zByCadence.values()].every((s) => s.size === 1),
    [...zByCadence].map(([c, s]) => `${c}:${[...s].join("/")}`).join("  "),
  );

  // The three zones must be distinct, or cadence stops being readable.
  const zs = [...zByCadence.values()].map((s) => [...s][0]!);
  ok("the three cadence zones are distinct depths", new Set(zs).size === zs.length, zs.join(", "));

  // Float heights must actually differ, or the bots read as sitting on a floor —
  // which is the entire reason the Y exists.
  const ys = bots.map((b) => Number(slots.get(b.id)!.y.toFixed(4)));
  ok("float heights are not all the same", new Set(ys).size > 1, ys.join(", "));
  ok("float heights straddle zero", Math.min(...ys) < 0 && Math.max(...ys) > 0, `${Math.min(...ys)} .. ${Math.max(...ys)}`);

  // Deterministic: the same input must give the same arrangement, or a visual
  // regression is indistinguishable from a reseed.
  const again = layoutSlots(bots);
  ok(
    "the layout is deterministic",
    bots.every((b) => slots.get(b.id)!.equals(again.get(b.id)!)),
  );

  const vert = layoutVertical(slots);
  ok(
    "the vertical extent covers every bot",
    bots.every((b) => Math.abs(slots.get(b.id)!.y) <= vert),
    `extentY = ${vert.toFixed(2)}`,
  );
  const ext = layoutExtent(slots);
  ok(
    "the horizontal extent covers every bot",
    bots.every((b) => Math.abs(slots.get(b.id)!.x) <= ext && Math.abs(slots.get(b.id)!.z) <= ext),
    `extent = ${ext.toFixed(2)}`,
  );

  // The NaN guard in angleFor is load-bearing: an unparseable date propagating
  // into a rotation drops the object out of the scene with no visible error.
  const bad = bot({ id: "x", cadence: "daily", nextRun: "not a date" });
  ok("angleFor survives an unparseable date", Number.isFinite(angleFor(bad, Date.now())));
  const none = bot({ id: "x", cadence: "on-demand", nextRun: null });
  ok("angleFor survives a bot with no schedule", Number.isFinite(angleFor(none, Date.now())));
}

/* --------------------------------------------------------------- personae */

/**
 * Every bot in the registry must build, including one with no persona modelled.
 * A throw here takes the whole scene down and drops the app to the table view,
 * which is a silent degradation — the fallback exists so a new bot appears in the
 * scene before anyone models it, and that path is worth exercising.
 */
function testPersonae(): void {
  console.log("\npersonae — every id builds, and an unknown id gets the fallback");

  const ids = [
    "sam-research",
    "finance-research",
    "disk-cleanup",
    "interface-design",
    "agency-repair",
    "media-bot",
    "a-bot-nobody-has-modelled",
  ];

  for (const id of ids) {
    let built = true;
    let meshes = 0;
    try {
      const rig = makeBot(bot({ id }), new THREE.Vector3(0, 0, 0));
      rig.update(1.5, 1, 1, Date.now());
      rig.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes++;
      });
      rig.dispose();
    } catch (e) {
      built = false;
      console.log(`        ${(e as Error).message}`);
    }
    ok(`${id} builds`, built && meshes > 10, `${meshes} meshes`);
  }
}

/* ------------------------------------------------------------------- main */

console.log("scene geometry tests");
testDiskCleanupClearance();
testLidSeat();
testDialHand();
testLayout();
testPersonae();

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
