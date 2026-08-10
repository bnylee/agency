/**
 * Register A — the studio.
 *
 * The camera rig, the stage insets, the right-drag gesture and the focus dolly
 * have now survived three backdrops — an orrery in deep space, a workshop room,
 * and deep space again — near enough unchanged. That is not luck. None of them
 * was ever about what the background was; they were about framing a group of
 * objects inside a stage that opaque chrome partly covers, and that problem does
 * not care.
 *
 * What changed is what is being framed. Every visual property is still bound to
 * real bot state:
 *
 *   depth zone           <- cadence (daily near, weekly mid, on-demand furthest)
 *   dial ring hand       <- time until next scheduled run
 *   indicator panel      <- last run status, as colour AND glyph
 *   chassis + panel trace<- has it ever run
 *   panel pulse          <- run in progress
 *   floating output      <- cumulative token spend
 *   conduits and auras   <- the relevance graph
 *
 * See bots3d.ts for why each channel landed where it did, and materials.ts for
 * why none of it needed the dataviz palette validator re-run.
 *
 * ## What the move to space actually changed here
 *
 * Four things, and each one was a constant that turned out to be about the room
 * rather than about the camera:
 *
 *  - **`ELEV_MIN` went negative.** It was +0.17 rad to keep the eye above an
 *    opaque floor. There is no floor, so you can now look up at the arrangement
 *    from underneath.
 *  - **The vertical fit reads `extentY` instead of a constant.** The room's
 *    height was fixed at 9 units; the bots now define the vertical extent
 *    themselves, and it changes when one is added or removed.
 *  - **`LOOK_HOME_Y` went to 0.** It was 1.15 to clear the dock plates.
 *  - **`ORBIT_HOME` came down to 0.24.** A room wants to be seen from standing
 *    height; a floating group wants to be seen from nearly level with it.
 *
 * This layer never blocks the app. If WebGL fails to initialise, `mount` throws
 * and main.ts falls back to the table view with everything still operable.
 */
import * as THREE from "three";
import gsap from "gsap";
import type { Bot } from "../api";
import { mountSpace } from "./space";
import { layoutExtent, layoutNear, layoutSlots, layoutVertical, makeBot, type BotRig } from "./bots3d";
import { mountConduits, type RelevanceGraph } from "./relevance";
import { disposeGlyphs } from "./materials";

/**
 * Focus (zoom-to-bot) constants.
 *
 * This is Register A. A camera dolly is continuous, expressive motion, which is
 * allowed in the ambient layer and nowhere else — so the *camera* may take 760ms
 * while the panel it accompanies stays on Register B's 500ms sheet budget. The
 * two are deliberately not synchronised: the controls arrive first and are
 * usable immediately, and the world settles behind them.
 *
 * The focus distance is **solved, not a constant**, and getting that wrong twice
 * is what taught me why.
 *
 * A station is about 3.4 units across counting its dial and 1.5 tall. A fixed
 * distance frames that correctly at exactly one stage width — and the stage width
 * changes by a factor of two and a half the moment a report panel opens, because
 * the panel is what the camera is being asked to make room for. Both 4.2 and 5.0
 * were tried as constants; with a panel open each put the machine's chassis
 * across the whole visible strip and pushed the dial off the bottom of it. The
 * dial is the thing you zoom in to read, so it cannot be the thing that falls out
 * of frame.
 *
 * So the same fit maths that solves the overview distance solves this one, against
 * a station's half-extent instead of the room's. The apparent size of a focused
 * bot inside the visible stage is then constant whatever the chrome is covering.
 */
/**
 * Half-extents to keep in frame when a bot is focused: the machine and the dial
 * ring around it. Both grew when the floor dial became a 1.5-radius hoop centred
 * on the bot — the room's 2.2 x 1.35 was measured against a dial lying flat, which
 * projects to almost nothing vertically, and a ring standing up does not.
 */
const FOCUS_HALF_W = 2.05;
const FOCUS_HALF_H = 1.95;
/** Never closer than this, however wide the stage gets. */
const FOCUS_DIST_MIN = 3.6;
/**
 * The pose the scene is composed at: about 14 degrees of elevation, dead ahead.
 *
 * Lower than the room's 19. A room wanted standing height because it had a floor
 * to stand on and a window to keep in frame. A floating arrangement reads best
 * from nearly level with it — looking down on floating objects flattens the
 * vertical spread that is doing the work of saying they float.
 */
const ORBIT_HOME = 0.24;
const FOCUS_IN = { duration: 0.76, ease: "power3.inOut" } as const;
const FOCUS_OUT = { duration: 0.56, ease: "power3.out" } as const;
/** Bot-to-bot: retreat, swap anchor at the trough, fly in again. */
const FOCUS_SWAP_OUT = { duration: 0.34, ease: "power2.in" } as const;
const FOCUS_SWAP_IN = { duration: 0.62, ease: "power3.out" } as const;
/** Brightness a non-focused bot retains while another one is focused. */
const UNFOCUSED_DIM = 0.34;

/**
 * The sheet's duration and curve, copied from motion-spec.md via
 * motion/registers.ts. Imported as numbers rather than importing the module so
 * the scene keeps no dependency on the Register B surface; the spec is the
 * shared source, not the file.
 */
const D_SHEET = 0.5;
const E_SHEET = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Height the overview camera aims at.
 *
 * Zero, where the room used 1.15 to clear its dock plates. The bots are
 * distributed above and below the layout plane now, so the plane itself is the
 * centre of the group and aiming above it would push the lowest bot toward the
 * bottom edge for no gain.
 */
const LOOK_HOME_Y = 0;

export interface StudioHandle {
  update(bots: Bot[]): void;
  /** Conduits and auras. Null clears them, which is what an API failure means. */
  setRelevance(graph: RelevanceGraph | null): void;
  /**
   * Select a bot and fly the camera to it. Selection and focus are the same
   * event on this surface, so they are one call — keeping them separate only
   * created a way for the highlight and the camera to disagree.
   *
   * Passing null returns to the overview. Passing a different id while already
   * focused retreats first and then flies in, rather than panning across.
   */
  setSelected(id: string | null): void;
  onSelect(cb: (id: string | null) => void): void;
  setDimmed(dimmed: boolean): void;
  /**
   * Re-centre the scene into the stage rather than the viewport.
   *
   * The canvas is full-bleed and the chrome sits opaquely over it, so a
   * viewport-centred room has its middle hidden behind the controls. Passing the
   * covered widths shifts the projection so the room lands in the middle of what
   * is actually visible. `rightPx` is the open report panel, which is why this
   * gets called on panel open and close as well as on resize.
   */
  setStageInset(leftPx: number, topPx: number, rightPx?: number): void;
  /** Return the camera to the pose the room is composed at. */
  resetView(): void;
  dispose(): void;
}

export function mount(canvas: HTMLCanvasElement, initial: Bot[]): StudioHandle {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // The nebula sphere covers every pixel, so this is only ever seen for the one
  // frame before it draws. Matched to SPACE.deep rather than to --page so that
  // frame is not a visibly different colour from the one after it.
  renderer.setClearColor(0x0b0d18, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // One shadow-casting light, softened. PCFSoft costs more than PCF and is the
  // difference between a window and a spotlight at this map size.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  /**
   * NoToneMapping, and this is a colour-correctness decision rather than a
   * stylistic one.
   *
   * A filmic curve is the obvious reach for an interior, and it would desaturate
   * exactly the thing that must not be desaturated: `--status-failed` #d03b3b
   * clears its contrast requirement at 3.62:1 with no margin to spend, and
   * design-dna.json's figures describe the hex, not the hex after a tone curve.
   * The room is lit to look right without one — modest light intensities and the
   * environment carrying the fill. materials.ts additionally marks every status
   * panel `toneMapped: false`, so the guarantee survives someone turning this on
   * later for the room's benefit.
   */
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

  // The camera is a turntable: it always looks into the room and only its
  // azimuth, elevation and distance vary. The distance is solved in
  // applyProjection() so the whole arrangement fits inside the visible stage.
  const orbit = { azimuth: 0, elevation: ORBIT_HOME };
  const FIT_MARGIN = 1.12;
  let extent = 12;
  /** Half-extent in Y. A constant in the room (the shell's height); data now. */
  let extentY = 3;
  /** How far the nearest bot stands in front of centre. See layoutNear(). */
  let extentNear = 0;

  /* ----------------------------------------------------------------- space */
  const space = mountSpace(renderer, scene);
  const conduits = mountConduits(scene);

  /* ------------------------------------------------------------------ bots */
  const rigs = new Map<string, BotRig>();
  let slots = layoutSlots(initial);

  function buildRigs(bots: Bot[]): void {
    for (const bot of bots) {
      const pos = slots.get(bot.id);
      if (!pos) continue;
      const rig = makeBot(bot, pos);
      scene.add(rig.group);
      rigs.set(bot.id, rig);
    }
    extent = layoutExtent(slots);
    extentY = layoutVertical(slots);
    extentNear = layoutNear(slots);
  }
  buildRigs(initial);

  /** The graph is held so a re-layout can rebuild the conduits against it. */
  let graph: RelevanceGraph | null = null;

  function applyGraph(): void {
    conduits.rebuild(graph, slots);
    const maxDeg = graph?.maxDegree ?? 0;
    for (const rig of rigs.values()) {
      const node = graph?.nodes.find((n) => n.id === rig.bot.id);
      rig.setAura(node && maxDeg > 0 ? node.degree / maxDeg : 0);
    }
  }

  /* ------------------------------------------------------------ interaction */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selectCb: (id: string | null) => void = () => {};

  function pick(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // Recursive now, and the hit has to be walked back up to its station.
    // A bot is thirty-odd meshes rather than one sphere, so intersecting the
    // groups non-recursively — which is what the orrery did against its cores —
    // would hit nothing at all and silently make the whole scene unclickable.
    const hits = raycaster.intersectObjects([...rigs.values()].map((r) => r.group), true);
    let id: string | null = null;
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const found = o.userData.botId as string | undefined;
        if (found) { id = found; break; }
        o = o.parent;
      }
      if (id) break;
    }
    selectCb(id);
  }

  /* -------------------------------------------------- right-drag rotation */
  /**
   * Hold the right button and drag to turn the room, Google-Maps style.
   *
   * Direct manipulation, so the sign convention is "grab the thing": drag right
   * and the room follows your hand to the right, which means the camera has to
   * travel the other way, hence the negated azimuth. Drag down and the near edge
   * of the floor comes toward you, which is the camera climbing toward top-down.
   *
   * Left button still selects. Guarding on `button === 0` is not a nicety — an
   * earlier handler fired a pick on *any* pointerdown, so the right button also
   * selected whatever was under it.
   *
   * Mouse and pen only. A touch pointer reports button 0 and there is no second
   * button to hold, so touch keeps tap-to-select.
   */
  const ORBIT_SENS = 0.0055;          // radians per pixel
  /**
   * Elevation limits, opened up now that there is no floor.
   *
   * The room clamped this at +0.17 rad for a concrete reason: the floor was
   * opaque, the camera sat outside the shell, and anything lower put the eye under
   * the floorboards with the whole scene hidden behind them. Nothing in space is
   * opaque and nothing is below the bots, so the floor of the range can go
   * NEGATIVE — you can look up at the arrangement from underneath, which is a real
   * view of a floating thing and was simply unavailable before.
   *
   * Still bounded at both ends rather than free. Past about +-78 degrees the view
   * axis approaches the world up-vector that `lookAt` uses to orient the camera,
   * and the frame rolls hard as it passes through — the classic gimbal flip. These
   * limits stop short of it in both directions.
   */
  const ELEV_MIN = -1.25;             // ~-72deg: looking up from below
  const ELEV_MAX = 1.35;              // ~77deg: near top-down, short of gimbal-flip
  const ORBIT_FRICTION = 0.9;         // per frame decay of the release glide
  const ORBIT_STOP = 2e-5;            // radians/frame below which the glide is over
  const ORBIT_MAX_VEL = 0.08;         // cap, so a violent flick does not spin for a second

  const orbitVel = { azimuth: 0, elevation: 0 };
  let dragging = false;
  let dragPointer = -1;
  let lastX = 0;
  let lastY = 0;
  /**
   * Ambient drift yields to the user. The idle camera breathes on a slow sine,
   * which is right until someone takes hold of it — after that the drift is
   * fighting a deliberate aim, so it fades out and only comes back on reset.
   */
  let userOrbited = false;
  let driftWeight = 1;
  let orbitAnim: gsap.core.Tween | null = null;

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  function applyOrbitDelta(dAz: number, dEl: number): void {
    orbit.azimuth += dAz;
    orbit.elevation = clamp(orbit.elevation + dEl, ELEV_MIN, ELEV_MAX);
    userOrbited = true;
    // Elevation changes how tall the room projects, so the fitted distance has
    // to be re-solved: without this, tilting toward top-down pushes the far wall
    // straight off the top of the stage.
    applyProjection();
  }

  function onPointerDown(ev: PointerEvent) {
    if (ev.button === 2) {
      orbitAnim?.kill();
      orbitAnim = null;
      dragging = true;
      dragPointer = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      orbitVel.azimuth = 0;
      orbitVel.elevation = 0;
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add("dragging");
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    pick(ev);
  }

  function onPointerMove(ev: PointerEvent) {
    if (!dragging || ev.pointerId !== dragPointer) return;
    const dAz = -(ev.clientX - lastX) * ORBIT_SENS;
    const dEl = (ev.clientY - lastY) * ORBIT_SENS;
    lastX = ev.clientX;
    lastY = ev.clientY;
    applyOrbitDelta(dAz, dEl);
    // Smoothed, because a single frame's delta is jittery enough that the glide
    // it produces can leave in a direction the hand was not moving.
    orbitVel.azimuth = clamp(orbitVel.azimuth * 0.4 + dAz * 0.6, -ORBIT_MAX_VEL, ORBIT_MAX_VEL);
    orbitVel.elevation = clamp(orbitVel.elevation * 0.4 + dEl * 0.6, -ORBIT_MAX_VEL, ORBIT_MAX_VEL);
    if (reduced.matches) frame();
  }

  function endDrag(ev: PointerEvent) {
    if (!dragging || ev.pointerId !== dragPointer) return;
    dragging = false;
    dragPointer = -1;
    canvas.classList.remove("dragging");
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    // Momentum is animation, so reduced motion does not get it. The drag itself
    // still works there — direct manipulation is not motion the user did not ask
    // for, it is the user's own hand.
    if (reduced.matches) {
      orbitVel.azimuth = 0;
      orbitVel.elevation = 0;
      frame();
    }
  }

  /**
   * Suppress the browser menu so the gesture is usable at all. On the canvas
   * always; on the window only mid-drag, because pointer capture means a drag
   * that crosses over the rail still ends with the pointer somewhere else, and
   * on the platforms that fire contextmenu on release that would pop a menu over
   * the interface the moment you let go.
   */
  const onContextMenu = (ev: MouseEvent) => { ev.preventDefault(); };
  const onWindowContextMenu = (ev: MouseEvent) => { if (dragging) ev.preventDefault(); };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("contextmenu", onWindowContextMenu);

  /* ------------------------------------------------------------------- loop */
  let dimTarget = 0;
  let dim = 0;
  const clock = new THREE.Clock();

  /**
   * Pixels of chrome covering the canvas: `left` is the rail, `top` the topbar,
   * `right` the report panel when it is open. The scene shifts so its centre
   * lands in the middle of what is actually visible.
   *
   * These are tweened rather than assigned, because the right inset changes the
   * instant a panel starts sliding in. Snapping the projection at that moment
   * threw the whole scene sideways while the sheet was still travelling.
   */
  const inset = { left: 0, top: 0, right: 0 };
  /**
   * Where `inset` is heading. Compared against, rather than against `inset`
   * itself, because a tween in flight leaves the live values at the old numbers
   * for a frame — so two calls in one tick (close one panel, open the next)
   * made the second look like a no-op and left the first tween running to zero.
   */
  const insetTarget = { left: 0, top: 0, right: 0 };
  let insetAnim: gsap.core.Tween | null = null;

  /** Distance at which the arrangement fits inside the stage, both axes. */
  let camDist = 30;
  /** The same, solved for one bot rather than the whole arrangement. */
  let focusDist = 5;

  /**
   * Everything that depends on the insets or on `extent`, but not on the canvas
   * size. Split out from resize() because the inset tween calls it every frame,
   * and re-running renderer.setSize() sixty times a second reassigns
   * canvas.width — which is a full context reset, not a no-op.
   */
  function applyProjection() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;

    // setViewOffset renders a window into a larger virtual frame. Offsetting
    // that window left by half the rail pushes the scene right by the same
    // amount, so the room lands mid-stage; a right-hand inset pulls it back the
    // other way, which is why the two are differenced rather than summed. It
    // goes through the projection matrix, so raycasting in pick() stays correct
    // with no second correction.
    const offsetX = (inset.right - inset.left) / 2;
    if (offsetX || inset.top) camera.setViewOffset(w, h, offsetX, -inset.top / 2, w, h);
    else camera.clearViewOffset();

    const stageW = Math.max(1, w - inset.left - inset.right);
    const stageH = Math.max(1, h - inset.top);
    const need = extent * FIT_MARGIN;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const distForWidth = (need * h) / (stageW * tanHalf);
    /**
     * The vertical half-extent to fit is not the same shape as the orrery's.
     *
     * There, the subject was a flat plane, so its screen height was the orbit
     * radius compressed by sin(elevation) and nothing else. A room is a box: the
     * floor's depth still projects through sin, but the WALLS contribute their
     * own height through cos, and that term dominates at low elevation — which
     * is exactly the pose the scene is composed at. Leaving it out framed the
     * floor perfectly and cut the top off the window.
     */
    const halfV = need * Math.abs(Math.sin(orbit.elevation)) + extentY * Math.cos(orbit.elevation);
    const distForHeight = (halfV * h) / (stageH * tanHalf);
    // `extentNear` frames the arrangement at its NEAREST plane rather than at its
    // middle. Without it the front zone is perspective-magnified past the frame
    // edge while the solver believes everything fits — which is precisely what a
    // headless capture caught, with the front-right bot clipped in half. See
    // layoutNear() in bots3d.ts.
    camDist = Math.max(distForWidth, distForHeight, 14) + extentNear * Math.cos(orbit.elevation);

    // The focus pose, solved the same way against one station. This is why it
    // tracks the panel: `stageW` shrinks as the sheet arrives, so the camera
    // holds the machine at a constant apparent size inside whatever strip of
    // canvas is actually visible instead of cropping into it.
    focusDist = Math.max(
      (FOCUS_HALF_W * h) / (stageW * tanHalf),
      (FOCUS_HALF_H * h) / (stageH * tanHalf),
      FOCUS_DIST_MIN,
    );

    // The camera's position and look-at are owned by frame(), which composes
    // this fitted distance with the parallax and the focus dolly. Setting them
    // here too would be dead code overwritten on the next tick, and worse, it
    // would look like the authority when it is not.
    camera.updateProjectionMatrix();
  }

  const drawSize = new THREE.Vector2();

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // The motes size themselves, so they need the same figure three keeps
    // privately for sizeAttenuation: framebuffer pixels per world unit at unit
    // depth. Drawing-buffer height, not CSS height, because gl_PointSize is in
    // device pixels — reading clientHeight here would render half-size points on
    // a retina display.
    space.setPixelScale(renderer.getDrawingBufferSize(drawSize).y / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    applyProjection();
  }
  resize();
  // Under reduced motion there is no animation loop to pick the new size up, so
  // a resize would leave a stretched canvas until something else forced a
  // render. Re-render explicitly rather than relying on a loop that is stopped.
  const onResize = () => { resize(); if (reduced.matches) frame(); };
  window.addEventListener("resize", onResize);

  /* ------------------------------------------------------------------ focus */
  /**
   * Zoom-to-bot. `focusState.t` runs 0 (overview) to 1 (dollied onto the
   * anchor), and every camera property in frame() is a lerp across it, so there
   * is one number to reason about instead of a second camera rig.
   */
  const focusState = { t: 0 };
  let focusId: string | null = null;
  /**
   * The bot the camera is currently pointed at. Distinct from focusId during a
   * bot-to-bot swap: the anchor stays on the outgoing bot while the camera
   * retreats, and only changes at the trough. Without that split the camera
   * teleports across the room the instant the selection changes.
   */
  let anchorId: string | null = null;
  let focusAnim: gsap.core.Animation | null = null;

  function setFocus(id: string | null): void {
    if (id === focusId) return;
    const hadFocus = focusId !== null;
    focusId = id;
    focusAnim?.kill();
    focusAnim = null;

    if (reduced.matches) {
      anchorId = id;
      focusState.t = id ? 1 : 0;
      frame();
      return;
    }

    if (id && hadFocus && focusState.t > 0.01) {
      // Panning between two close-up poses drags the camera across the whole
      // room at high magnification, which reads as a blur rather than as a move.
      // Retreating first reads as a decision.
      focusAnim = gsap.timeline()
        .to(focusState, { t: 0, ...FOCUS_SWAP_OUT })
        .add(() => { anchorId = id; })
        .to(focusState, { t: 1, ...FOCUS_SWAP_IN });
      return;
    }

    if (id) anchorId = id;
    focusAnim = gsap.to(focusState, {
      t: id ? 1 : 0,
      ...(id ? FOCUS_IN : FOCUS_OUT),
      // Held until the retreat finishes so the camera pulls back from where it
      // was; clearing it on the way out would snap to the overview pose.
      onComplete: () => { if (!id) anchorId = null; },
    });
  }

  // Scratch vectors, allocated once. Building Vector3s per frame is the kind of
  // thing that shows up as GC sawtooth at 60fps.
  const posOverview = new THREE.Vector3();
  const posFocus = new THREE.Vector3();
  const lookHome = new THREE.Vector3(0, LOOK_HOME_Y, 0);
  const lookTarget = new THREE.Vector3();
  const anchorPoint = new THREE.Vector3();
  const viewDir = new THREE.Vector3();

  function frame() {
    const t = clock.getElapsedTime();
    const now = Date.now();

    dim += (dimTarget - dim) * 0.08;
    const ambient = 1 - dim * 0.8;

    // Release glide. Runs on the frame loop rather than as a tween because its
    // end condition is a velocity threshold, not a duration — a flick should
    // travel as far as it was thrown.
    if (!dragging && (Math.abs(orbitVel.azimuth) > ORBIT_STOP || Math.abs(orbitVel.elevation) > ORBIT_STOP)) {
      applyOrbitDelta(orbitVel.azimuth, orbitVel.elevation);
      orbitVel.azimuth *= ORBIT_FRICTION;
      orbitVel.elevation *= ORBIT_FRICTION;
    }
    driftWeight += ((userOrbited ? 0 : 1) - driftWeight) * 0.05;

    // The anchor may have been removed from the registry between polls, in which
    // case there is nothing to point at and the overview is correct.
    const anchor = anchorId ? rigs.get(anchorId) ?? null : null;
    const e = anchor ? focusState.t : 0;

    for (const rig of rigs.values()) {
      // The focused bot is exempt from both the panel dim and the focus dim.
      // Dimming the thing you just asked to look at is the wrong direction.
      const isAnchor = anchor !== null && rig === anchor;
      const local = isAnchor ? 1 : ambient * (1 - e * (1 - UNFOCUSED_DIM));
      rig.update(t, ambient, local, now);
    }

    space.update(t, ambient);
    conduits.update(t, ambient);

    // Slow camera parallax, as a wobble on the azimuth rather than a sideways
    // nudge, so it stays tangential at any heading the user has dragged to.
    // Small on purpose: a control surface that drifts under the cursor is harder
    // to aim at. It fades out as the camera closes in — drift that is
    // imperceptible across the whole room is a lurch at four units from a bot —
    // and also once the user starts steering, via driftWeight.
    const az = orbit.azimuth + Math.sin(t * 0.05) * 0.048 * driftWeight * (1 - e);
    const ce = Math.cos(orbit.elevation);

    // The unit direction from the look-at target toward the camera. One vector
    // serves both poses, which is what keeps the focus dolly honest under
    // rotation — dollying along a hardcoded axis would swing the view back to
    // the default heading every time a bot was focused.
    viewDir.set(ce * Math.sin(az), Math.sin(orbit.elevation), ce * Math.cos(az));
    posOverview.copy(viewDir).multiplyScalar(camDist);
    posOverview.y += LOOK_HOME_Y;

    if (anchor && e > 0.0005) {
      // A pure dolly along the existing view axis: the offset from bot to camera
      // is the same unit direction the overview uses, just shorter. The world
      // does not rotate under you, it comes closer.
      anchor.focusPoint(anchorPoint);
      posFocus.copy(anchorPoint).addScaledVector(viewDir, focusDist);
      camera.position.lerpVectors(posOverview, posFocus, e);
      lookTarget.lerpVectors(lookHome, anchorPoint, e);
      camera.lookAt(lookTarget);
    } else {
      camera.position.copy(posOverview);
      camera.lookAt(lookHome);
    }

    renderer.render(scene, camera);
  }

  if (reduced.matches) {
    // Reduced motion renders one frame and stops. Not slower — stopped.
    frame();
  } else {
    renderer.setAnimationLoop(frame);
  }

  // A background tab spinning the GPU is a bug, not a flourish.
  const onVisibility = () => {
    if (reduced.matches) return;
    renderer.setAnimationLoop(document.hidden ? null : frame);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    update(bots) {
      const ids = new Set(bots.map((b) => b.id));
      let structural = false;

      // A bot leaving the registry has to take its station with it, which the
      // orrery never handled: it only ever added. A dock left standing for a bot
      // the API no longer lists would keep a dial ticking against a schedule
      // nothing owns.
      for (const [id, rig] of [...rigs]) {
        if (!ids.has(id)) {
          rig.dispose();
          rigs.delete(id);
          structural = true;
        }
      }
      for (const bot of bots) {
        if (!rigs.has(bot.id)) { structural = true; break; }
      }

      if (structural) {
        // Re-layout, because a zone's docks are spaced symmetrically about the
        // centre and adding or removing one moves its neighbours.
        for (const rig of rigs.values()) rig.dispose();
        rigs.clear();
        slots = layoutSlots(bots);
        buildRigs(bots);
        applyProjection();
        applyGraph();
      } else {
        for (const bot of bots) rigs.get(bot.id)?.setBot(bot);
      }

      if (reduced.matches) frame();
    },
    setRelevance(next) {
      graph = next;
      applyGraph();
      if (reduced.matches) frame();
    },
    setSelected(id) {
      for (const rig of rigs.values()) rig.setSelected(rig.bot.id === id);
      // setFocus already re-renders under reduced motion, and it is the only
      // path that can change what the frame looks like here.
      setFocus(id);
      if (reduced.matches) frame();
    },
    onSelect(cb) { selectCb = cb; },
    setDimmed(d) { dimTarget = d ? 1 : 0; if (reduced.matches) frame(); },
    resetView() {
      orbitAnim?.kill();
      orbitVel.azimuth = 0;
      orbitVel.elevation = 0;
      // Fold the accumulated azimuth into (-PI, PI] first. Without it a camera
      // that has been spun round three times unwinds all three turns, which is
      // a five-second animation in answer to a one-shot command.
      orbit.azimuth = ((orbit.azimuth + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      // Restores the ambient drift as well: the camera is the scene's again.
      userOrbited = false;
      if (reduced.matches) {
        orbit.azimuth = 0;
        orbit.elevation = ORBIT_HOME;
        driftWeight = 1;
        applyProjection();
        frame();
        return;
      }
      orbitAnim = gsap.to(orbit, {
        azimuth: 0,
        elevation: ORBIT_HOME,
        // Register A, so a camera move may run long. Matched to FOCUS_IN's
        // family rather than to the sheet — this is the world moving, not a
        // control.
        duration: 0.7,
        ease: "power3.inOut",
        onUpdate: applyProjection,
      });
    },
    setStageInset(leftPx, topPx, rightPx = 0) {
      if (leftPx === insetTarget.left && topPx === insetTarget.top && rightPx === insetTarget.right) return;
      insetTarget.left = leftPx; insetTarget.top = topPx; insetTarget.right = rightPx;
      insetAnim?.kill();
      if (reduced.matches) {
        inset.left = leftPx; inset.top = topPx; inset.right = rightPx;
        applyProjection();
        frame();
        return;
      }
      // Matched to the sheet, curve and all: the right inset changes because a
      // panel is travelling, so the scene re-centres in step with it rather than
      // arriving on its own schedule.
      insetAnim = gsap.to(inset, {
        left: leftPx, top: topPx, right: rightPx,
        duration: D_SHEET,
        ease: E_SHEET,
        onUpdate: applyProjection,
      });
    },
    dispose() {
      renderer.setAnimationLoop(null);
      focusAnim?.kill();
      insetAnim?.kill();
      orbitAnim?.kill();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("contextmenu", onWindowContextMenu);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const rig of rigs.values()) rig.dispose();
      rigs.clear();
      conduits.dispose();
      space.dispose();
      disposeGlyphs();
      renderer.dispose();
    },
  };
}
