/**
 * Register A — deep space.
 *
 * Replaces room.ts. The bots do not stand on anything any more; they float, and
 * this file is everything around them: the nebula, three star shells, a distant
 * ringed planet, the comets, and the three lights that make porcelain read as
 * porcelain against a dark sky.
 *
 * ## What was kept from the room, and what it cost to leave
 *
 * The room's one real advantage was that it justified its own lighting: a window
 * and two lamps are a reason for light to come from somewhere. Space has to earn
 * that differently, so there is exactly one star as the key and the sky itself as
 * the fill — see `LIGHT` in materials.ts for why the key stayed warm.
 *
 * What space gives back is the thing the room could not: **the dollhouse cull is
 * unnecessary here.** The room needed a `BackSide` box so near walls would vanish
 * as the camera turned. There are no walls. Every azimuth and every elevation is
 * a valid view with no visibility code at all, and the elevation limit drops back
 * from the room's 0.17 rad — set to keep the eye above opaque floorboards — to
 * something near flat. See `ELEV_MIN` in studio.ts.
 *
 * ## Why the comets are allowed to exist
 *
 * The Agency's design rule is that nothing in the scene is decoration: every
 * visual property is bound to real state. The comets are the one deliberate
 * exception, and the reason is narrow enough to write down.
 *
 * They encode nothing. They are the **liveness signal** — the thing that tells
 * you at a glance that the page is rendering and the poll is running, on a
 * surface where every real channel can legitimately sit still for a week. A
 * weekly bot at rest with no run in progress is a completely static frame, and a
 * static frame is indistinguishable from a hung one. The stars are static, the
 * bots are nearly static, and a comet crossing the frame every few seconds is
 * cheaper and quieter than a spinner would be.
 *
 * That reasoning has a consequence which is honoured below: **under
 * `prefers-reduced-motion` the comets are not slowed, they are removed.** A
 * liveness cue is exactly the kind of unrequested motion that preference is
 * about, and a single frozen streak across the sky looks like a scratch on the
 * screen. The starfield and the nebula render as one static frame; the comets are
 * simply not built.
 *
 * ## Textures are drawn, not fetched
 *
 * The planet's bands are generated into a canvas at mount, for the same reason
 * the floorboards were: this tool binds 127.0.0.1 and must render with no
 * network. A procedural texture is also the only kind that cannot go stale
 * against the palette.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  COMET_FRAG,
  COMET_HEAD_FRAG,
  COMET_HEAD_VERT,
  COMET_VERT,
  DUST_FRAG,
  DUST_VERT,
  NEBULA_FRAG,
  NEBULA_VERT,
} from "./shaders";
import { LIGHT, SPACE, surface } from "./materials";

/**
 * Radius of the sky sphere. Inside the camera's far plane (200) with room to
 * spare, and far enough out that the bots never approach it — a nebula you can
 * fly into is a nebula that reads as a wall.
 */
const SKY_R = 150;

/** Star shells: radius and count. Three depths, so a turn of the camera parallaxes. */
const STAR_SHELLS: [radius: number, count: number][] = [
  [70, 1400],
  [100, 1100],
  [138, 900],
];

/** Comets. Twelve is enough that the sky is never empty and never busy. */
const COMET_COUNT = 12;
/** Segments per tail. Twelve gives a smooth taper; six visibly facets. */
const COMET_SEGMENTS = 12;
/** World units a comet covers in one cycle, and how long its tail is. */
const COMET_TRAVEL = 190;
const COMET_TAIL = 26;
const COMET_WIDTH = 0.5;

/**
 * Display-referred sRGB components of a hex, bypassing colour management.
 *
 * Only for the raw ShaderMaterials here (nebula, stars, comets).
 * `new THREE.Color(hex)` converts into the linear working space, which is right
 * for a built-in material and wrong for a shader that writes straight to the
 * framebuffer — passing a linear triple into one of those produces a layer about
 * 4x too bright. Same function, same reason, as every previous version of this
 * scene; see the colour-space note in materials.ts for the full split.
 */
function srgb(hex: number): THREE.Vector3 {
  return new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}

/**
 * A deterministic pseudo-random source.
 *
 * `Math.random()` would put the stars and the comets in a different arrangement
 * on every mount, which makes a visual regression impossible to see: you could
 * never tell a layout change from a reseed. Mulberry32, one line, seeded once.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------- stars */

/**
 * One shell of stars, distributed evenly over a sphere.
 *
 * The `1 - 2u` for the cosine of the polar angle is not a detail to skip: taking
 * the angle itself uniformly clusters points at the poles, and a starfield with
 * two visible bald patches is the single most obvious way to make a sky look
 * generated. Sampling cos(phi) uniformly is what makes the distribution even.
 *
 * Brightness is skewed hard toward the dim end (`r * r * r`). Real skies are
 * mostly faint stars with a few bright ones, and a uniform distribution reads as
 * a grid of identical dots — which is the same observation DUST_FRAG was written
 * against when this code was a starfield the first time.
 */
function starGeometry(radius: number, count: number, seed: number): THREE.BufferGeometry {
  const rand = rng(seed);
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const bright = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const cosPhi = 1 - 2 * rand();
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
    const theta = rand() * Math.PI * 2;
    // Jittered radius, so three shells do not read as three concentric surfaces.
    const r = radius * (0.86 + rand() * 0.28);

    pos[i * 3] = r * sinPhi * Math.cos(theta);
    pos[i * 3 + 1] = r * cosPhi;
    pos[i * 3 + 2] = r * sinPhi * Math.sin(theta);

    size[i] = 0.6 + rand() * 2.6;
    const b = rand();
    bright[i] = 0.16 + 0.84 * b * b * b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aBright", new THREE.BufferAttribute(bright, 1));
  return geo;
}

/* ------------------------------------------------------------------ comets */

/**
 * Comet ribbons: one triangle strip per comet, all in one geometry.
 *
 * Every vertex of a given comet carries the SAME `position` — its spawn point —
 * and the same `aDir`, `aSpeed`, `aPhase`, `aScale`. What varies within a comet is
 * `aAlong` (0 at the head to 1 at the tail tip) and `aSide` (-1 / +1 across the
 * ribbon). The vertex shader turns `uTime` plus those attributes into a world
 * position, which is why nothing here has to be touched again after build.
 *
 * Spawn points sit on a large sphere and directions are aimed to pass near the
 * origin rather than radially outward, so comets cross the frame the camera is
 * actually looking at instead of receding from it.
 */
function cometRibbons(seed: number): THREE.BufferGeometry {
  const rand = rng(seed);
  const verts = (COMET_SEGMENTS + 1) * 2;

  const position = new Float32Array(COMET_COUNT * verts * 3);
  const aDir = new Float32Array(COMET_COUNT * verts * 3);
  const aSpeed = new Float32Array(COMET_COUNT * verts);
  const aPhase = new Float32Array(COMET_COUNT * verts);
  const aScale = new Float32Array(COMET_COUNT * verts);
  const aAlong = new Float32Array(COMET_COUNT * verts);
  const aSide = new Float32Array(COMET_COUNT * verts);
  const index: number[] = [];

  const start = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let c = 0; c < COMET_COUNT; c++) {
    // Start somewhere on a shell just outside the star field.
    const cosPhi = 1 - 2 * rand();
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
    const theta = rand() * Math.PI * 2;
    const r = 96 + rand() * 26;
    start.set(r * sinPhi * Math.cos(theta), r * cosPhi, r * sinPhi * Math.sin(theta));

    /**
     * Aim at a point that PASSES the origin at a guaranteed distance.
     *
     * The first version sampled the aim point uniformly in a box about the origin,
     * which was supposed to mean "near but not at the centre" and in fact meant
     * "sometimes exactly at the centre" — nothing stopped a sample landing at
     * (0,0,0). A headless capture caught the consequence: a comet flying straight
     * through the bot cluster, and because a tail is 26 units long and half a unit
     * wide, close to the camera it fills a quarter of the frame as a hard white
     * wedge. It reads as a laser, not a comet.
     *
     * So the miss distance is now sampled as a DIRECTION plus a radius with a
     * floor, rather than as a box that contains the origin. The bots span about
     * ±11 units, and MISS_MIN is comfortably outside that.
     */
    const MISS_MIN = 26;
    const MISS_MAX = 58;
    const mCos = 1 - 2 * rand();
    const mSin = Math.sqrt(Math.max(0, 1 - mCos * mCos));
    const mTheta = rand() * Math.PI * 2;
    const miss = MISS_MIN + rand() * (MISS_MAX - MISS_MIN);
    aim.set(
      miss * mSin * Math.cos(mTheta),
      // Flattened on Y so comets cross the frame rather than diving out of the top
      // and bottom of it, which at this camera elevation is most of the sky.
      miss * mCos * 0.6,
      miss * mSin * Math.sin(mTheta),
    );
    dir.copy(aim).sub(start).normalize();

    const speed = 0.018 + rand() * 0.05;
    const phase = rand();
    const scale = 0.55 + rand() * 0.95;

    const base = c * verts;
    for (let s = 0; s <= COMET_SEGMENTS; s++) {
      const along = s / COMET_SEGMENTS;
      for (const side of [-1, 1] as const) {
        const v = base + s * 2 + (side === -1 ? 0 : 1);
        position[v * 3] = start.x;
        position[v * 3 + 1] = start.y;
        position[v * 3 + 2] = start.z;
        aDir[v * 3] = dir.x;
        aDir[v * 3 + 1] = dir.y;
        aDir[v * 3 + 2] = dir.z;
        aSpeed[v] = speed;
        aPhase[v] = phase;
        aScale[v] = scale;
        aAlong[v] = along;
        aSide[v] = side;
      }
    }
    for (let s = 0; s < COMET_SEGMENTS; s++) {
      const i0 = base + s * 2;
      index.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("aDir", new THREE.BufferAttribute(aDir, 3));
  geo.setAttribute("aSpeed", new THREE.BufferAttribute(aSpeed, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute("aScale", new THREE.BufferAttribute(aScale, 1));
  geo.setAttribute("aAlong", new THREE.BufferAttribute(aAlong, 1));
  geo.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
  geo.setIndex(index);
  return geo;
}

/**
 * The heads, as a Points cloud sharing the ribbons' per-comet attributes.
 *
 * Built from the ribbon geometry's own buffers rather than reseeded, so a head
 * cannot end up on a different trajectory from its tail — which is precisely what
 * happened when this took a second `rng()` call with the same seed but a
 * different consumption order.
 */
function cometHeads(ribbons: THREE.BufferGeometry): THREE.BufferGeometry {
  const verts = (COMET_SEGMENTS + 1) * 2;
  const src = {
    position: ribbons.getAttribute("position") as THREE.BufferAttribute,
    aDir: ribbons.getAttribute("aDir") as THREE.BufferAttribute,
    aSpeed: ribbons.getAttribute("aSpeed") as THREE.BufferAttribute,
    aPhase: ribbons.getAttribute("aPhase") as THREE.BufferAttribute,
    aScale: ribbons.getAttribute("aScale") as THREE.BufferAttribute,
  };

  const position = new Float32Array(COMET_COUNT * 3);
  const aDir = new Float32Array(COMET_COUNT * 3);
  const aSpeed = new Float32Array(COMET_COUNT);
  const aPhase = new Float32Array(COMET_COUNT);
  const aScale = new Float32Array(COMET_COUNT);

  for (let c = 0; c < COMET_COUNT; c++) {
    const v = c * verts;
    for (let k = 0; k < 3; k++) {
      position[c * 3 + k] = src.position.array[v * 3 + k] as number;
      aDir[c * 3 + k] = src.aDir.array[v * 3 + k] as number;
    }
    aSpeed[c] = src.aSpeed.array[v] as number;
    aPhase[c] = src.aPhase.array[v] as number;
    aScale[c] = src.aScale.array[v] as number;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("aDir", new THREE.BufferAttribute(aDir, 3));
  geo.setAttribute("aSpeed", new THREE.BufferAttribute(aSpeed, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute("aScale", new THREE.BufferAttribute(aScale, 1));
  return geo;
}

/* ------------------------------------------------------------------ planet */

/**
 * The gas giant's bands, drawn into a canvas.
 *
 * Deliberately very low contrast. A vivid Jupiter would be the most eye-catching
 * thing in the frame, and the frame's subject is five robots. This reads as depth
 * and scale from the corner of the eye and resolves into a planet only if you
 * look at it, which is the correct amount of attention for something that encodes
 * nothing.
 */
function planetTexture(): THREE.CanvasTexture {
  const W = 32;
  const H = 256;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;

  const base = new THREE.Color(SPACE.planet);
  const band = new THREE.Color(SPACE.planetBand);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, W, H);

  const rand = rng(0x51a5);
  let y = 0;
  while (y < H) {
    const h = 4 + rand() * 22;
    const k = 0.82 + rand() * 0.4;
    const c = (rand() > 0.5 ? band : base).clone().multiplyScalar(k);
    g.fillStyle = `#${c.getHexString()}`;
    g.fillRect(0, y, W, h);
    y += h;
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/* -------------------------------------------------------------------- mount */

export interface SpaceHandle {
  /** One call per frame from the studio's loop. `ambient` is the shared dim. */
  update(t: number, ambient: number): void;
  /** Framebuffer px per world unit at unit depth. Changes with canvas size. */
  setPixelScale(scale: number): void;
  dispose(): void;
}

export function mountSpace(renderer: THREE.WebGLRenderer, scene: THREE.Scene): SpaceHandle {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  /* ------------------------------------------------------------ environment */
  // RoomEnvironment ships with three, so the ambient IBL costs no new dependency
  // and no fetched asset. It is a neutral white studio box, which is not what a
  // nebula looks like — but its job here is only to keep the porcelain from going
  // flat where no light reaches, and a neutral source is the safest thing to do
  // that with. The blue comes from the bounce light, which is a real direction.
  // Intensity is well under the room's 0.42: in space the IBL is a floor, not the
  // main source, and at the room's level it washed the shading out completely.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const env = pmrem.fromScene(envScene, 0.04);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.16;
  // RoomEnvironment's dispose is not on the Scene type it extends, so this is
  // reached through a cast rather than left uncalled — it owns real geometry.
  (envScene as unknown as { dispose?: () => void }).dispose?.();
  pmrem.dispose();

  /* ----------------------------------------------------------------- nebula */
  const nebulaMat = track(
    new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      uniforms: {
        uDeep: { value: srgb(SPACE.deep) },
        uMid: { value: srgb(SPACE.mid) },
        uHot: { value: srgb(SPACE.hot) },
        uTime: { value: 0 },
        uWarp: { value: 0.72 },
        // 0.44, raised from 0.30 after looking at a rendered frame: at 0.30 the sky
        // was flat near-black and the nebula was not visible as a nebula at all.
        // Above about 0.55 the gas starts competing with the bots for attention,
        // which is the boundary that matters — the bots are the subject. Below 0.2
        // the sky collapses to flat --page and the parallax has nothing to show.
        // The hard clamp in NEBULA_FRAG is what makes this a real ceiling rather
        // than a hope about the colour ramp.
        uCeiling: { value: 0.44 },
        uDim: { value: 1 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      // Not additive and not transparent: this IS the background, so it should
      // write opaque colour and let everything else draw over it.
      transparent: false,
    }),
  );
  const nebula = new THREE.Mesh(track(new THREE.SphereGeometry(SKY_R, 48, 32)), nebulaMat);
  // Tilted so the galactic band cuts the frame diagonally rather than running
  // level with the bots. A band parallel to the layout reads as a horizon, which
  // is the one thing a floating scene must not imply.
  nebula.rotation.set(0.42, 0.9, 0.26);
  nebula.renderOrder = -10;
  scene.add(nebula);

  /* ------------------------------------------------------------------ stars */
  const starMats: THREE.ShaderMaterial[] = [];
  const starPoints: THREE.Points[] = [];
  STAR_SHELLS.forEach(([radius, count], i) => {
    const mat = track(
      new THREE.ShaderMaterial({
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        uniforms: {
          uScale: { value: 1000 },
          // Nearer shells get slightly larger stars, which is the parallax cue
          // doing double duty as a depth cue.
          uSize: { value: 0.05 - i * 0.012 },
          uDim: { value: 1 },
          uColor: { value: srgb(SPACE.star) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const pts = new THREE.Points(track(starGeometry(radius, count, 0x9e3d + i * 977)), mat);
    pts.renderOrder = -5 + i;
    scene.add(pts);
    starMats.push(mat);
    starPoints.push(pts);
  });

  /* ----------------------------------------------------------------- planet */
  const planetGroup = new THREE.Group();
  const planetTex = track(planetTexture());
  const planetMat = track(surface(0xffffff, { rough: 0.92, metal: 0.0, env: 0.4 }));
  planetMat.map = planetTex;
  const planet = new THREE.Mesh(track(new THREE.SphereGeometry(12, 48, 32)), planetMat);
  planetGroup.add(planet);

  // A thin ring, seen nearly edge-on. DoubleSide because at this angle you see
  // the underside of the far half, and a single-sided ring vanishes there.
  const ringMat = track(
    new THREE.MeshStandardMaterial({
      color: SPACE.planetRing,
      roughness: 0.85,
      metalness: 0.1,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const ring = new THREE.Mesh(track(new THREE.RingGeometry(15, 22, 96)), ringMat);
  ring.rotation.x = -Math.PI / 2 + 0.19;
  planetGroup.add(ring);

  // Far off to one side and below, so it never sits behind a bot. Placed on the
  // opposite side from the key light so it is a crescent rather than a full disc —
  // a fully lit ball at this size reads as a moon sticker.
  planetGroup.position.set(-58, -26, -74);
  planetGroup.rotation.z = 0.22;
  scene.add(planetGroup);

  /* ----------------------------------------------------------------- comets */
  // Under reduced motion the comets are NOT built. They encode nothing and exist
  // only as a liveness cue, which is exactly the unrequested motion that
  // preference is about — and one frozen streak reads as a scratch on the glass.
  // See the note at the top of this file.
  let cometMat: THREE.ShaderMaterial | null = null;
  let headMat: THREE.ShaderMaterial | null = null;
  let cometMesh: THREE.Mesh | null = null;
  let headPoints: THREE.Points | null = null;

  if (!reduced.matches) {
    const ribbonGeo = track(cometRibbons(0x4f21));
    cometMat = track(
      new THREE.ShaderMaterial({
        vertexShader: COMET_VERT,
        fragmentShader: COMET_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uTravel: { value: COMET_TRAVEL },
          uTail: { value: COMET_TAIL },
          uWidth: { value: COMET_WIDTH },
          uColor: { value: srgb(SPACE.comet) },
          uDim: { value: 1 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    cometMesh = new THREE.Mesh(ribbonGeo, cometMat);
    // Bounds come from the `position` attribute, which is only the spawn point, so
    // a comet halfway across the sky would be culled against a sphere it left long
    // ago. This is not an optimisation to skip — without it comets blink out.
    cometMesh.frustumCulled = false;
    cometMesh.renderOrder = 8;
    scene.add(cometMesh);

    headMat = track(
      new THREE.ShaderMaterial({
        vertexShader: COMET_HEAD_VERT,
        fragmentShader: COMET_HEAD_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uTravel: { value: COMET_TRAVEL },
          uScale: { value: 1000 },
          uSize: { value: 0.5 },
          uColor: { value: srgb(SPACE.comet) },
          uDim: { value: 1 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    headPoints = new THREE.Points(track(cometHeads(ribbonGeo)), headMat);
    headPoints.frustumCulled = false;
    headPoints.renderOrder = 9;
    scene.add(headPoints);
  }

  /* ----------------------------------------------------------------- lights */
  // One shadow caster, as in the room, and for the same reason: one crisp shadow
  // direction reads as a scene lit by a star, and three casters read as a
  // showroom and cost three shadow maps to do it.
  //
  // The shadow camera is sized to the bot volume, NOT to the sky. A directional
  // light's shadow frustum has to bound what casts and receives, and stretching
  // it to 150 units to "cover the nebula" spreads a 2048 map over an area where
  // the bots occupy a handful of texels — which reads as no shadows at all.
  const key = new THREE.DirectionalLight(LIGHT.key, 2.9);
  key.position.set(16, 14, 12);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 70;
  key.shadow.camera.left = -22;
  key.shadow.camera.right = 22;
  key.shadow.camera.top = 18;
  key.shadow.camera.bottom = -18;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.028;
  scene.add(key, key.target);

  const bounce = new THREE.DirectionalLight(LIGHT.bounce, 1.15);
  bounce.position.set(-18, -6, -10);
  scene.add(bounce);

  const rim = new THREE.DirectionalLight(LIGHT.rim, 0.85);
  rim.position.set(-4, 8, -20);
  scene.add(rim);

  // A trace of ambient so a face turned fully away from all three is still a
  // shape rather than a hole. Very low: at anything much above this the bodies
  // lose the modelling the key light is there to give them.
  const ambientLight = new THREE.AmbientLight(LIGHT.bounce, 0.18);
  scene.add(ambientLight);

  const baseIntensity = {
    key: key.intensity,
    bounce: bounce.intensity,
    rim: rim.intensity,
    ambient: ambientLight.intensity,
    env: scene.environmentIntensity,
    ring: ringMat.opacity,
  };

  return {
    update(t, ambient) {
      // Everything that emits light dims together, so opening a panel pushes the
      // whole of Register A back rather than just the parts that were easy to
      // reach. Dimmed to 55% at most, not to zero: a black frame behind a sheet
      // loses the sense of place the sheet is sitting in front of.
      const k = 0.55 + ambient * 0.45;
      key.intensity = baseIntensity.key * k;
      bounce.intensity = baseIntensity.bounce * k;
      rim.intensity = baseIntensity.rim * k;
      ambientLight.intensity = baseIntensity.ambient * k;
      scene.environmentIntensity = baseIntensity.env * k;
      ringMat.opacity = baseIntensity.ring * k;

      // The additive layers take the FULL dim rather than the softened one. They
      // are light in the void, and that is the first thing that should go when
      // attention moves to a panel.
      nebulaMat.uniforms.uTime!.value = t;
      nebulaMat.uniforms.uDim!.value = 0.35 + ambient * 0.65;
      for (const m of starMats) m.uniforms.uDim!.value = ambient;
      if (cometMat) {
        cometMat.uniforms.uTime!.value = t;
        cometMat.uniforms.uDim!.value = ambient;
      }
      if (headMat) {
        headMat.uniforms.uTime!.value = t;
        headMat.uniforms.uDim!.value = ambient;
      }

      // The sky turns, very slowly, on an axis that is not the camera's. Over a
      // few minutes it is unmistakable; over a few seconds it is invisible, which
      // is the correct speed for something with no information in it.
      nebula.rotation.y = 0.9 + t * 0.0042;
      nebula.rotation.x = 0.42 + Math.sin(t * 0.011) * 0.03;

      // Star shells counter-rotate at different rates, so a static camera still
      // has parallax between them.
      starPoints.forEach((p, i) => {
        p.rotation.y = t * (0.0026 - i * 0.0008);
      });

      planet.rotation.y = t * 0.008;
    },
    setPixelScale(scale) {
      for (const m of starMats) m.uniforms.uScale!.value = scale;
      if (headMat) headMat.uniforms.uScale!.value = scale;
    },
    dispose() {
      scene.remove(nebula, planetGroup, key, key.target, bounce, rim, ambientLight);
      for (const p of starPoints) scene.remove(p);
      if (cometMesh) scene.remove(cometMesh);
      if (headPoints) scene.remove(headPoints);
      scene.environment = null;
      env.texture.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
