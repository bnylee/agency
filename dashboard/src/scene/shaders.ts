/**
 * Custom GLSL for the studio.
 *
 * ## The scene went to space, came back as a room, and has gone to space again
 *
 * That is not indecision; it is why some of this code has survived three
 * rewrites untouched. `DUST_VERT` / `DUST_FRAG` were written as a starfield,
 * spent one revision as airborne dust in a sunbeam, and are a starfield again.
 * The sizing rule in DUST_VERT — hold a point at one pixel and pay for it in
 * brightness instead — was measured for stars in the first place, so nothing
 * about it needed retuning to come home.
 *
 * `SHAFT_*` is gone: it was light entering through a window and there is no
 * window. `NEBULA_*` and `COMET_*` are new. `AURA_*` and `CONDUIT_*` never
 * cared what the background was.
 *
 * ## What happened to the nebula's luminance ceiling
 *
 * The orrery's nebula needed a measured luminance ceiling, because it was the
 * only thing that could lift a status colour's local background off `--page`;
 * getting it wrong on paper once shipped 2.63:1 against a predicted 3.23:1.
 *
 * `NEBULA_FRAG` has a hard ceiling again — `uCeiling`, applied as a clamp on the
 * final luminance, not as a hope about the colour ramp. But it is now belt AND
 * braces rather than the only line of defence: every status panel is seated in a
 * bezel painted #1a1a19, which *is* the validated `--surface` the figures in
 * design-dna.json were measured against, so the nebula is never a status
 * colour's local background no matter how bright it gets. The ceiling stays
 * because a background that can wash out the *bots* is still a bad background,
 * and because the cost of keeping it is one `min()`.
 *
 * snoise is Ashima Arts / Stefan Gustavson's 3D simplex noise (MIT).
 */

export const SIMPLEX_3D = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/**
 * Airborne dust — the parallax layer, repurposed.
 *
 * Kept verbatim from the orrery's starfield. PointsMaterial would do the job
 * except for the two things this needs: a soft round sprite instead of a square,
 * and per-particle brightness, without which a field reads as a regular grid of
 * identical dots.
 */
export const DUST_VERT = /* glsl */ `
attribute float aSize;    // per-particle size multiplier
attribute float aBright;  // per-particle brightness

uniform float uScale;     // framebuffer px per world unit at unit depth
uniform float uSize;      // base size, world units
uniform float uDim;       // ambient dim, shared with the rest of Register A

varying float vBright;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = uSize * aSize * uScale / max(-mv.z, 0.001);

  // Sub-pixel points strobe as they cross the sample grid. Hold the size at one
  // pixel and pay for it in brightness instead, so a distant particle fades out
  // smoothly rather than flickering on and off between frames.
  gl_PointSize = max(px, 1.0);
  vBright = aBright * uDim * min(px, 1.0);

  gl_Position = projectionMatrix * mv;
}
`;

export const DUST_FRAG = /* glsl */ `
// sRGB components, for the same reason they always were: this is a raw
// ShaderMaterial, so nothing converts its output and what is written here is
// what lands on screen. See srgb() in room.ts.
uniform vec3 uColor;
varying float vBright;

void main() {
  // Soft disc. gl_PointCoord runs 0..1 across the sprite.
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d);
  if (a <= 0.001) discard;
  // Additively blended (SrcAlpha, One), so the contribution is rgb * a.
  gl_FragColor = vec4(uColor * vBright, a);
}
`;

/**
 * The nebula — the whole sky, on the inside of one sphere.
 *
 * ## Why it is drawn rather than baked
 *
 * The orrery baked its nebula into a cube texture once at mount, because the
 * noise was expensive and static anyway. This one is evaluated per fragment, for
 * one reason: it drifts. A sky that turns over about a five-minute period is
 * what stops a static starfield reading as wallpaper, and you cannot drift a
 * baked cube map without re-baking it.
 *
 * The cost is real and bounded — one full-screen pass of five snoise calls, on a
 * mesh that draws before anything else and writes no depth. Measured against
 * three octaves it was the same frame time on this machine and visibly flatter,
 * which is the trade this settled on.
 *
 * ## Domain warping is the whole look
 *
 * Plain fbm gives clouds that read as fog. Warping the sample point by a second,
 * lower-frequency noise field first is what produces the filaments and voids a
 * nebula actually has. `uWarp` is how far the field is dragged; past about 0.9 it
 * stops looking like gas and starts looking like marble.
 *
 * ## The band
 *
 * A galactic plane, as a soft `exp` falloff on distance from the y=0 plane in the
 * sphere's own space. It is what gives the sky an orientation, and it is why the
 * bots read as being *somewhere* rather than in an undifferentiated void. The
 * band is deliberately not axis-aligned with the bot layout — see space.ts, where
 * the whole sphere is tilted.
 */
export const NEBULA_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // Object-space direction, so the sphere's own rotation carries the sky with it
  // and the drift can be a rotation on the mesh rather than a uniform.
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const NEBULA_FRAG = /* glsl */ `
// sRGB components throughout. This is a raw ShaderMaterial, so nothing converts
// its output and what is written here is what lands on screen. See srgb() in
// space.ts, and materials.ts for why the split is per-material.
uniform vec3  uDeep;      // the void between the clouds
uniform vec3  uMid;       // the body of the gas
uniform vec3  uHot;       // the bright cores
uniform float uTime;
uniform float uWarp;      // domain-warp strength
uniform float uCeiling;   // hard luminance cap. See the note at the top.
uniform float uDim;       // ambient dim, shared with the rest of Register A

varying vec3 vDir;

${SIMPLEX_3D}

/** Two octaves is enough once the domain is warped; four just costs more. */
float fbm(vec3 p) {
  return snoise(p) * 0.6 + snoise(p * 2.13 + 4.7) * 0.3;
}

void main() {
  vec3 p = vDir * 1.7;

  // Domain warp. The warp field moves faster than the gas it displaces, which is
  // what makes the filaments appear to boil slowly rather than slide as a sheet.
  vec3 q = vec3(
    fbm(p + vec3(0.0, uTime * 0.013, 0.0)),
    fbm(p + vec3(3.1, uTime * 0.011, 1.7)),
    fbm(p + vec3(7.3, uTime * 0.009, 5.2))
  );
  float d = fbm(p + q * uWarp + vec3(0.0, uTime * 0.006, 0.0));

  // Remapped to 0..1 and pushed toward the dark end: a nebula is mostly nothing.
  //
  // Exponent 1.45, down from 1.7. At 1.7 a headless capture showed the sky reading
  // as flat near-black with a few stars — the filaments the domain warp exists to
  // produce were being crushed below visibility, so the whole warp was paying for
  // nothing. Lower still starts to fill the voids and it stops looking like gas.
  float gas = smoothstep(-0.15, 0.85, d);
  gas = pow(gas, 1.45);

  // The galactic band. exp falloff rather than smoothstep so it has no edge at
  // all — a visible boundary on a band this large reads as a seam in a texture.
  //
  // Falloff 2.5, loosened from 3.4, which confined the band so tightly that at the
  // composed camera elevation it sat off frame and the sky had no orientation at
  // all — which was its entire job.
  float band = exp(-abs(vDir.y) * 2.5);

  // Cores: only where the gas is already dense AND the band is strong, so the
  // bright spots sit in the plane instead of scattered over the whole sky.
  float core = pow(gas, 3.2) * band;

  vec3 col = uDeep;
  col = mix(col, uMid, gas * (0.35 + band * 0.65));
  col = mix(col, uHot, core * 0.85);

  // Hard luminance ceiling. Rec.709 coefficients, applied as a scale on the whole
  // colour so the hue survives the clamp — clamping per channel would desaturate
  // exactly the brightest, most saturated cores, which are the point.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= min(1.0, uCeiling / max(lum, 1e-4));

  gl_FragColor = vec4(col * uDim, 1.0);
}
`;

/**
 * Comets — the live shooting stars.
 *
 * ## Every comet's position is computed on the GPU, from three attributes
 *
 * There is no per-frame buffer upload and no CPU-side particle loop. A comet is
 * described once, at build time, by where it starts (`position`), which way it
 * goes (`aDir`), how fast (`aSpeed`) and where in its cycle it begins
 * (`aPhase`). The vertex shader turns `uTime` into a position. So the whole
 * system costs one uniform write per frame regardless of how many comets there
 * are, and it cannot drift out of sync with the render loop the way an
 * accumulated CPU position can under a dropped frame.
 *
 * The consequence to remember: **the mesh must have `frustumCulled = false`.**
 * three computes bounds from the `position` attribute, which here is only the
 * spawn point, so a comet halfway across the sky would be culled against a
 * bounding sphere it left long ago. This is the same class of bug as animating a
 * vertex shader and wondering why objects vanish at the screen edge.
 *
 * ## The ribbon
 *
 * Each comet is a triangle strip of `S` segments. `aAlong` runs 0 at the head to
 * 1 at the tail tip; `aSide` is -1 or +1 across the ribbon. The strip is
 * billboarded in VIEW space by offsetting along the screen-space perpendicular of
 * the travel direction, which is what keeps a tail edge-on to the camera from
 * collapsing to an invisible line.
 *
 * ## Intermittency is free
 *
 * `u` is `fract(uTime * aSpeed + aPhase)`, so every comet is always somewhere in
 * a cycle — but the brightness envelope only opens for the first ~55% of it. The
 * rest of the cycle it is travelling invisibly. That gives dead air between
 * streaks with no spawn scheduler, no pool management and no random number
 * generator at runtime, and because each comet has its own `aSpeed` and `aPhase`
 * the pattern never repeats visibly.
 */
export const COMET_VERT = /* glsl */ `
attribute vec3  aDir;     // unit direction of travel
attribute float aSpeed;   // cycles per second
attribute float aPhase;   // 0..1 offset into the cycle
attribute float aAlong;   // 0 at the head, 1 at the tail tip
attribute float aSide;    // -1 or +1 across the ribbon
attribute float aScale;   // per-comet size multiplier

uniform float uTime;
uniform float uTravel;    // world units covered in one cycle
uniform float uTail;      // tail length, world units
uniform float uWidth;     // half-width at the head, world units

varying float vAlong;
varying float vEnv;

void main() {
  float u = fract(uTime * aSpeed + aPhase);

  // The envelope: a fast fade in, a long fade out, then darkness for the rest of
  // the cycle. Squared on the way out so the tail's disappearance is not linear.
  float env = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.42, 0.62, u));
  vEnv = env * env;

  vec3 head = position + aDir * (u * uTravel);
  vec3 world = head - aDir * (aAlong * uTail * aScale);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);

  // Billboard across the direction of travel, in view space. The perpendicular is
  // taken in the XY plane of view space, which IS the screen plane, so the ribbon
  // always presents its face to the camera however the comet is oriented.
  vec3 dirView = normalize((modelViewMatrix * vec4(aDir, 0.0)).xyz);
  vec2 perp = normalize(vec2(-dirView.y, dirView.x) + vec2(1e-5));

  // Tapered: full width at the head, nothing at the tip. The 0.35 exponent keeps
  // the tail from pinching to a needle immediately after the head.
  float w = uWidth * aScale * pow(1.0 - aAlong, 0.35);
  mv.xy += perp * (aSide * w);

  vAlong = aAlong;
  gl_Position = projectionMatrix * mv;
}
`;

export const COMET_FRAG = /* glsl */ `
uniform vec3  uColor;   // sRGB components; raw material, no conversion
uniform float uDim;
varying float vAlong;
varying float vEnv;

void main() {
  // Brightness falls off along the tail much faster than the width does, so the
  // head reads as a point of light with a wash behind it rather than as a wedge.
  float along = pow(1.0 - vAlong, 2.6);
  float level = along * vEnv * uDim;
  if (level <= 0.0008) discard;
  gl_FragColor = vec4(uColor * level, 1.0);
}
`;

/**
 * The comet head: the same GPU position maths, rendered as one soft bright point.
 *
 * A ribbon alone has no head — its brightest row is still a flat quad, and it
 * reads as a scratch rather than as an object with a tail. This adds the point of
 * light, sized in pixels by the same rule as the stars.
 */
export const COMET_HEAD_VERT = /* glsl */ `
attribute vec3  aDir;
attribute float aSpeed;
attribute float aPhase;
attribute float aScale;

uniform float uTime;
uniform float uTravel;
uniform float uScale;   // framebuffer px per world unit at unit depth
uniform float uSize;    // base size, world units

varying float vEnv;

void main() {
  float u = fract(uTime * aSpeed + aPhase);
  float env = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.42, 0.62, u));

  vec4 mv = modelViewMatrix * vec4(position + aDir * (u * uTravel), 1.0);
  float px = uSize * aScale * uScale / max(-mv.z, 0.001);

  // Same rule as the stars: never let a sprite go sub-pixel, pay in brightness.
  gl_PointSize = max(px, 1.0);
  vEnv = env * env * min(px, 1.0);

  gl_Position = projectionMatrix * mv;
}
`;

export const COMET_HEAD_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uDim;
varying float vEnv;

void main() {
  float d = length(gl_PointCoord - 0.5);
  // Two-stop falloff: a tight white core inside a wide soft halo. One smoothstep
  // gives a flat disc that reads as a ball, not as a light.
  float core = smoothstep(0.26, 0.0, d);
  float halo = smoothstep(0.5, 0.1, d);
  float a = halo * 0.55 + core;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(uColor * a * vEnv * uDim, a);
}
`;

/**
 * The aura — a bot's connectedness in the relevance graph.
 *
 * A fresnel shell around the chassis: bright at grazing angles, transparent
 * head-on, so it rims the silhouette instead of fogging the bot. The noise term
 * makes it breathe slowly, which is what distinguishes it from a hard outline.
 *
 * `uIntensity` is graph degree, normalised. A bot nothing links to gets zero and
 * renders nothing at all — that is a real reading, not an absence of styling.
 */
export const AURA_VERT = /* glsl */ `
uniform float uTime;
uniform float uSwell;

varying vec3 vNormalW;
varying vec3 vViewDir;

${SIMPLEX_3D}

void main() {
  float n = snoise(normal * 1.4 + vec3(0.0, uTime * 0.16, 0.0));
  vec3 displaced = position * (1.0 + n * 0.035 * uSwell);

  vec4 world = modelMatrix * vec4(displaced, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const AURA_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uIntensity;  // normalised graph degree
uniform float uDim;

varying vec3 vNormalW;
varying vec3 vViewDir;

void main() {
  // Exponent 4.2, up from 3.0. At 3.0 the falloff was wide enough that the shell
  // read as a filled bubble around each machine rather than as a rim on it —
  // additive blending over a soft gradient fills the disc, and the bots ended up
  // inside glowing eggs. A tighter power puts the light back on the silhouette.
  float fres = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0), 4.2);
  gl_FragColor = vec4(uColor * fres * uIntensity * uDim, 1.0);
}
`;

/**
 * Relevance conduits — light running between two bots that reference each other.
 *
 * `aAlong` is the 0..1 parameter along the tube. Two terms ride it: a constant
 * base so the link is visible at rest, and a travelling band so the direction of
 * the reference is legible. `uFlow` advances the band; `uWeight` is the edge's
 * strength from the graph, and it scales brightness rather than radius, because a
 * fat tube on a strong edge would collide with its neighbours on the floor.
 */
export const CONDUIT_VERT = /* glsl */ `
varying float vAlong;
void main() {
  // TubeGeometry lays u along the length of the tube and v around its
  // circumference, so the parameter this needs is already there as a built-in
  // attribute. Generating a parallel aAlong buffer would be the same numbers
  // computed twice and one more thing to keep in step with the segment count.
  vAlong = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const CONDUIT_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uWeight;  // 0..1 edge strength
uniform float uFlow;    // advances with time
uniform float uDim;
varying float vAlong;

void main() {
  // Travelling band. fract() of (position - time) is a sawtooth moving along the
  // tube; the smoothstep pair turns it into a soft pulse rather than a hard line.
  float s = fract(vAlong - uFlow);
  float band = smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.12, 0.34, s));

  // Ends taper so a conduit emerges from under its dock instead of stopping dead
  // against it.
  float ends = smoothstep(0.0, 0.08, vAlong) * (1.0 - smoothstep(0.92, 1.0, vAlong));

  float level = (0.22 + band * 0.9) * uWeight * ends;
  gl_FragColor = vec4(uColor * level * uDim, 1.0);
}
`;
