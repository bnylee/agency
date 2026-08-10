/**
 * Register A — the relevance conduits.
 *
 * Light running between two docks whose bots actually reference each other. The
 * graph is derived on the server from the Agency's own markdown; see
 * server/relevance.ts for what counts as a reference and what it is worth.
 *
 * ## Why this is allowed to exist at all
 *
 * interface-design/design/interaction-thesis.md is blunt about it: if a channel
 * cannot be decoded back into a fact about a bot, it does not belong. An "energy
 * aura" is exactly the kind of thing that rule exists to keep out, and it earns
 * its place here only because both of its channels are countable:
 *
 *   conduit brightness  <- edge weight: how much these two docs reference each other
 *   conduit flow        <- direction of the heavier half of that reference
 *   aura intensity      <- the bot's degree, normalised against the busiest bot
 *
 * A bot nothing links to gets no aura, and two bots that never mention each other
 * get no conduit. Absence is a reading too, which is the test the old starfield
 * failed and was honest enough to say so in its own header.
 *
 * The arc height is the one number here with no data behind it, and it is
 * geometry rather than encoding: conduits run over the docks instead of across
 * the floor because a cable on the floor disappears behind the first machine
 * standing in front of it.
 */
import * as THREE from "three";
import { CONDUIT_FRAG, CONDUIT_VERT } from "./shaders";
import { ENERGY } from "./materials";

export interface RelevanceEdge {
  a: string;
  b: string;
  /** Raw score. Normalised against `maxWeight` before it reaches the shader. */
  weight: number;
  /** Which end contributes more; the flow runs a -> b when true. */
  forward: boolean;
}

export interface RelevanceGraph {
  nodes: { id: string; degree: number }[];
  edges: RelevanceEdge[];
  maxWeight: number;
  maxDegree: number;
}

/** Peak height of the arc, in world units above the dock plate. */
const ARC_H = 1.85;
const TUBE_R = 0.032;
const TUBE_SEGS = 44;

export interface ConduitsHandle {
  rebuild(graph: RelevanceGraph | null, slots: Map<string, THREE.Vector3>): void;
  update(t: number, ambient: number): void;
  dispose(): void;
}

export function mountConduits(scene: THREE.Scene): ConduitsHandle {
  const group = new THREE.Group();
  scene.add(group);

  let mats: THREE.ShaderMaterial[] = [];
  let geos: THREE.BufferGeometry[] = [];
  /** Per-conduit flow sign, so a reversed edge runs the other way. */
  let dirs: number[] = [];

  function clear(): void {
    group.clear();
    for (const m of mats) m.dispose();
    for (const g of geos) g.dispose();
    mats = [];
    geos = [];
    dirs = [];
  }

  return {
    rebuild(graph, slots) {
      clear();
      if (!graph || graph.edges.length === 0) return;

      for (const e of graph.edges) {
        const pa = slots.get(e.a);
        const pb = slots.get(e.b);
        // An edge naming a bot with no dock is not an error worth throwing over:
        // the graph is derived from files on disk and the registry is a
        // hardcoded allowlist, so markdown can legitimately mention a bot the
        // control plane does not render. Skip it and draw the rest.
        if (!pa || !pb) continue;

        const a = new THREE.Vector3(pa.x, 0.34, pa.z);
        const b = new THREE.Vector3(pb.x, 0.34, pb.z);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        // Longer spans arc higher, so a conduit crossing the whole room clears
        // the machines between its ends instead of grazing them.
        mid.y = ARC_H + a.distanceTo(b) * 0.055;

        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        const geo = new THREE.TubeGeometry(curve, TUBE_SEGS, TUBE_R, 6, false);

        const w = graph.maxWeight > 0 ? e.weight / graph.maxWeight : 0;
        const mat = new THREE.ShaderMaterial({
          vertexShader: CONDUIT_VERT,
          fragmentShader: CONDUIT_FRAG,
          uniforms: {
            uColor: { value: new THREE.Color(ENERGY.conduit) },
            // Floored, so the weakest real edge is still visible. An edge that
            // exists but renders at zero is worse than no edge: it looks like a
            // rendering fault rather than a weak relationship.
            uWeight: { value: 0.3 + w * 0.7 },
            uFlow: { value: 0 },
            uDim: { value: 1 },
          },
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 8;
        group.add(mesh);
        mats.push(mat);
        geos.push(geo);
        dirs.push(e.forward ? 1 : -1);
      }
    },
    update(t, ambient) {
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i]!;
        // fract() in the shader wraps this, so an ever-growing t is fine and
        // there is no seam to manage at the wrap.
        m.uniforms.uFlow!.value = t * 0.16 * dirs[i]!;
        m.uniforms.uDim!.value = ambient;
      }
    },
    dispose() {
      clear();
      scene.remove(group);
    },
  };
}
