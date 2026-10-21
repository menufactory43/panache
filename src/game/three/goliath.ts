import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Faction } from "../../sim/types";
import { ModelBuilder, type Vec3 } from "./builder";
import { ik } from "./infantry";
import { AMBER, BARREL, BRASS, GM, GM_D, GM_L, HAZ, HAZ_D, TEAMS, TRACK, WHITE, modelMesh } from "./models";
import { BELLE_EPOQUE } from "./theme";

/**
 * The Goliath: a giant two-legged walking mech in the vehicles' painted
 * style, half again as tall as an HQ. Gunmetal armour on dark joints, big
 * team-colour shoulder pauldrons, mortar pods and a deck plate that read from
 * the tilted top-down camera, one amber cyclops eye (the laser), an arm
 * cannon for each forearm and a pair of machine guns under the chest. On its
 * back ride the scrap hopper and a folding crane arm; four stabiliser spikes
 * hang at its hips like skirt armour.
 *
 * Every part is built in its own joint's space and the joints are a plain
 * scene graph the rig poses each frame — a heavy walk on planted feet (the
 * infantry's two-bone leg IK, cadence from ground speed, body tilted to the
 * ground under each foot), the anchoring stance (body down on its
 * hydraulics, legs splayed, spikes driven, hopper and crane unfolded), arms
 * that droop and pods that sag as weapons go offline, a torso that twists
 * to its target, recoil per weapon. A few draw calls per Goliath, no
 * skinning: there are only ever a handful on the map.
 *
 * `bake()` freezes a pose into one plain geometry, and only the parts asked
 * for: the model gallery's statue, unitDef's hull, and the half-built mech
 * on the Gantry's cradle at each stage (GANTRY_STAGES) — the same parts the
 * finished Goliath walks off with.
 *
 * Model units are about tiles (unitScale scales the whole rig). Like every
 * unit it faces north (-Z) with its origin on the ground between its feet.
 *
 * (models.ts imports this module and this one imports models.ts: nothing
 * here may touch an import at module load, only inside functions.)
 *
 * Belle Époque (theme.ts): the same rig, joints and parts dressed as
 * *Gargantua*, a walking steam fortress after Verne's steam elephant —
 * see buildPartsBelle.
 */

type Team = (typeof TEAMS)[Faction];

/** Proportions, model units. */
export const GOLIATH_RIG = {
  /** Hip joints' height standing, half the hip width, thigh and shin lengths, the ankle above the sole. */
  hipY: 1.24,
  hipX: 0.36,
  thigh: 0.6,
  shin: 0.6,
  ankle: 0.14,
  /** The torso's pivot above the hips. */
  waist: 0.14,
  /** Ground covered per stride (two steps), the share of it a foot stays planted, and how high a foot lifts. */
  cycle: 1.3,
  stance: 0.62,
  lift: 0.17,
  /** Anchored, the body sinks this far on its hydraulics and the legs splay this far out (rad). */
  lower: 0.34,
  splay: 0.26,
  /** The mortar pods' rest pitch (rad, up). */
  podPitch: 0.55,
  /** For bars and labels. */
  height: 2.55
};

/** The rig's joints, parents first. */
const JOINTS = [
  "body", "pelvis", "thighL", "shinL", "footL", "thighR", "shinR", "footR",
  "spikeFL", "rodFL", "spikeFR", "rodFR", "spikeBL", "rodBL", "spikeBR", "rodBR",
  "torso", "head", "shoulderL", "cannonL", "shoulderR", "cannonR", "podL", "podR", "mgL", "mgR",
  "hopper", "lid", "boom", "jib", "hook"
] as const;
export type GoliathJoint = (typeof JOINTS)[number];

/** Each joint's parent and where it sits in the parent at rest. */
const AT: Record<GoliathJoint, [GoliathJoint | null, Vec3]> = {
  body: [null, [0, 0, 0]],
  pelvis: ["body", [0, 1.24, 0]],
  thighL: ["pelvis", [-0.36, 0, 0]],
  shinL: ["thighL", [0, -0.6, 0]],
  footL: ["shinL", [0, -0.6, 0]],
  thighR: ["pelvis", [0.36, 0, 0]],
  shinR: ["thighR", [0, -0.6, 0]],
  footR: ["shinR", [0, -0.6, 0]],
  spikeFL: ["pelvis", [-0.56, -0.04, -0.2]],
  rodFL: ["spikeFL", [0, 0, 0]],
  spikeFR: ["pelvis", [0.56, -0.04, -0.2]],
  rodFR: ["spikeFR", [0, 0, 0]],
  spikeBL: ["pelvis", [-0.56, -0.04, 0.2]],
  rodBL: ["spikeBL", [0, 0, 0]],
  spikeBR: ["pelvis", [0.56, -0.04, 0.2]],
  rodBR: ["spikeBR", [0, 0, 0]],
  torso: ["pelvis", [0, 0.14, 0]],
  head: ["torso", [0, 0.7, -0.24]],
  shoulderL: ["torso", [-0.74, 0.6, 0.04]],
  cannonL: ["shoulderL", [-0.06, -0.36, 0]],
  shoulderR: ["torso", [0.74, 0.6, 0.04]],
  cannonR: ["shoulderR", [0.06, -0.36, 0]],
  podL: ["torso", [-0.44, 0.78, 0.26]],
  podR: ["torso", [0.44, 0.78, 0.26]],
  mgL: ["torso", [-0.36, 0.24, -0.34]],
  mgR: ["torso", [0.36, 0.24, -0.34]],
  hopper: ["torso", [0, 0.2, 0.46]],
  lid: ["hopper", [0, 0.4, 0.32]],
  boom: ["torso", [0.36, 0.64, 0.48]],
  jib: ["boom", [0, 0.9, 0]],
  hook: ["jib", [0, 0.6, 0]]
};

/**
 * What a part is, for building the mech up in stages on the Gantry: its
 * legs, the pelvis, the torso's inner frame (girders and the reactor, hidden
 * inside the finished armour), the armour plates, the team panels, the arms
 * with their cannons, the mortar pods, the machine guns, the head with its
 * eye (lit or dark: two meshes, glow is baked), the spikes, hopper and crane.
 */
export type GoliathPart =
  | "legs" | "pelvis" | "frame" | "plates" | "panels" | "arms" | "pods" | "mg"
  | "head" | "eyeLit" | "eyeDark" | "eyeLove" | "spikes" | "hopper" | "crane";

/**
 * The half-built Goliath on a Gantry's cradle, stage by stage (render/goliath.ts):
 * Foundation (feet and legs), Frame (hips and the torso's skeleton), Armament
 * (plated, arm cannons and mortars mounted), Finishing (head on with its eye
 * still dark, team panels, guns, spikes, hopper and crane).
 */
export const GANTRY_STAGES: readonly (readonly GoliathPart[])[] = [
  ["legs"],
  ["legs", "pelvis", "frame"],
  ["legs", "pelvis", "frame", "plates", "arms", "pods"],
  ["legs", "pelvis", "frame", "plates", "panels", "arms", "pods", "mg", "head", "eyeDark", "spikes", "hopper", "crane"]
];

/** Muzzles and hook points in their joints' space. */
const MUZZLE: Record<"laser" | "cannon" | "pod" | "mg", Vec3> = {
  laser: [0, 0.11, -0.27],
  cannon: [0, 0, -0.98],
  pod: [0, 0.17, -0.38],
  mg: [0, 0, -0.38]
};

// --------------------------------------------------------------- parts ---

interface Part {
  joint: GoliathJoint;
  part: GoliathPart;
  geo: THREE.BufferGeometry;
}

/** Mech parts: per-part grade, so stacked armour separates at a glance. */
const pb = () => new ModelBuilder({ grade: 0.24 });

function lamp(b: ModelBuilder, at: Vec3, s = 0.035): void {
  b.box(s, s * 0.8, s, at, AMBER, { glow: 1 });
}

/** Scrap in the hopper (the harvester's and Depot's lumps). */
const LUMPS = [0x8a6a3a, 0xb08a4a, 0x6e5a40, 0x9a7a44, 0xc9a65a, 0x7a6448];

function buildParts(t: Team): Part[] {
  const out: Part[] = [];
  const add = (joint: GoliathJoint, part: GoliathPart, b: ModelBuilder) => out.push({ joint, part, geo: b.build() });
  const D = GOLIATH_RIG;
  const HALF = Math.PI / 2;
  let b: ModelBuilder;

  // ---- legs: a hip ball and armoured thigh, a big knee cap, a shin over a calf piston, flat clawed feet
  for (const sx of [-1, 1]) {
    const L = sx < 0 ? "L" : "R";
    b = pb();
    b.sphere(0.13, [0, 0, 0], GM_D, { w: 8, h: 6 });
    b.block(0.26, 0.5, 0.3, [0, -0.3, 0], GM, { taper: -0.12, bevel: 0.04 });
    b.block(0.06, 0.42, 0.32, [sx * 0.15, -0.3, 0], GM_L, { bevel: 0.02, edge: 1.35 });
    b.block(0.065, 0.1, 0.33, [sx * 0.158, -0.13, 0], t.main, { bevel: 0.015, edge: 1.4 });
    b.cyl(0.034, 0.034, 0.42, 6, [0, -0.3, -0.17], BARREL);
    add(`thigh${L}` as GoliathJoint, "legs", b);
    b = pb();
    b.cyl(0.11, 0.11, 0.3, 8, [0, 0, 0], GM_D, { rot: [0, 0, HALF] });
    b.block(0.27, 0.2, 0.12, [0, 0.02, -0.15], GM_L, { rot: [-0.25, 0, 0], bevel: 0.035, edge: 1.4 });
    b.block(0.1, 0.035, 0.1, [0, 0.13, -0.15], t.main, { rot: [-0.25, 0, 0], bevel: 0.01 });
    b.block(0.3, 0.5, 0.32, [0, -0.32, 0.02], GM, { taper: 0.12, bevel: 0.04 });
    b.block(0.24, 0.4, 0.07, [0, -0.3, -0.16], GM_L, { rot: [-0.1, 0, 0], bevel: 0.02, edge: 1.3 });
    b.cyl(0.04, 0.04, 0.4, 6, [0, -0.3, 0.19], BARREL);
    b.sphere(0.1, [0, -D.shin, 0], GM_D, { w: 8, h: 5 });
    add(`shin${L}` as GoliathJoint, "legs", b);
    b = pb();
    const y0 = -D.ankle;
    b.block(0.42, 0.1, 0.64, [0, y0 + 0.05, -0.08], GM_D, { bevel: 0.02 });
    b.block(0.34, 0.11, 0.44, [0, y0 + 0.15, -0.04], GM, { taper: 0.3, bevel: 0.03 });
    for (const x of [-0.14, 0, 0.14]) b.block(0.11, 0.08, 0.17, [x, y0 + 0.045, -0.46], GM_L, { taper: 0.25, bevel: 0.02 });
    b.block(0.16, 0.09, 0.16, [0, y0 + 0.05, 0.3], GM_D, { bevel: 0.02 });
    lamp(b, [sx * 0.175, y0 + 0.12, -0.3], 0.035);
    add(`foot${L}` as GoliathJoint, "legs", b);
  }

  // ---- pelvis: hip actuators with team hub caps, a hazard-striped codpiece, the rear power pack, the waist ring
  b = pb();
  b.block(0.64, 0.3, 0.5, [0, 0, 0], GM_D, { bevel: 0.04 });
  for (const sx of [-1, 1]) {
    b.cyl(0.15, 0.15, 0.2, 10, [sx * 0.36, 0, 0], GM, { rot: [0, 0, HALF] });
    b.cyl(0.12, 0.12, 0.04, 10, [sx * 0.465, 0, 0], t.main, { rot: [0, 0, HALF] });
    b.box(0.12, 0.1, 0.5, [sx * 0.52, -0.02, 0], GM_D);
  }
  b.block(0.42, 0.28, 0.1, [0, -0.06, -0.28], GM, { rot: [0.2, 0, 0], taper: -0.15, bevel: 0.03 });
  for (let i = 0; i < 4; i++) b.box(0.07, 0.18, 0.012, [-0.135 + i * 0.09, -0.07, -0.336], i % 2 ? HAZ_D : HAZ, { rot: [0.2, 0, 0] });
  b.block(0.5, 0.24, 0.18, [0, 0.03, 0.3], GM, { bevel: 0.03 });
  lamp(b, [0.18, 0.1, 0.395], 0.03);
  lamp(b, [-0.18, 0.1, 0.395], 0.03);
  b.drum(0.26, 0.24, 0.1, 10, [0, 0.19, 0], GM_D, { bevel: 0.02 });
  add("pelvis", "pelvis", b);

  // ---- stabiliser spikes: a sleeve on a knuckle at each hip corner, hazard-banded, its rod and point telescoping out of it
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const k = `${sz < 0 ? "F" : "B"}${sx < 0 ? "L" : "R"}`;
      b = pb();
      b.box(0.16, 0.1, 0.16, [0, 0, 0], GM_D);
      b.block(0.13, 0.42, 0.13, [0, -0.24, 0], GM, { bevel: 0.02 });
      b.box(0.14, 0.06, 0.14, [0, -0.37, 0], HAZ);
      b.box(0.14, 0.04, 0.14, [0, -0.42, 0], HAZ_D);
      add(`spike${k}` as GoliathJoint, "spikes", b);
      b = pb();
      b.cyl(0.04, 0.04, 0.58, 6, [0, -0.34, 0], GM_L);
      b.cone(0.065, 0.16, 6, [0, -0.7, 0], GM_D, { rot: [Math.PI, 0, 0] });
      add(`rod${k}` as GoliathJoint, "spikes", b);
    }

  // ---- the torso's inner frame: spine, ribs, corner posts, the shoulder yoke and a glowing reactor in its cage
  b = pb();
  b.block(0.24, 0.7, 0.24, [0, 0.36, 0.06], GM_D, { bevel: 0.03 });
  for (const y of [0.22, 0.4, 0.58]) for (const z of [-0.22, 0.3]) b.box(0.86, 0.05, 0.05, [0, y, z], TRACK);
  for (const x of [-0.42, 0.42]) for (const z of [-0.22, 0.3]) b.box(0.05, 0.62, 0.05, [x, 0.36, z], GM_D);
  b.box(1.36, 0.1, 0.12, [0, 0.66, 0.04], GM_D);
  b.cyl(0.13, 0.13, 0.26, 10, [0, 0.42, -0.06], AMBER, { glow: 0.85 });
  for (const y of [0.32, 0.52]) b.torus(0.15, 0.025, [0, y, -0.06], GM_D, { rot: [HALF, 0, 0], seg: 12 });
  add("torso", "frame", b);

  // ---- armour: abdomen, a chest widening to the shoulders, a sloped glacis with lamps, the shoulder housing, back vents
  b = pb();
  b.block(0.62, 0.26, 0.54, [0, 0.13, 0.04], GM, { bevel: 0.04 });
  b.block(1.1, 0.48, 0.8, [0, 0.5, 0.04], GM, { taper: -0.1, bevel: 0.06 });
  b.block(0.86, 0.34, 0.1, [0, 0.46, -0.37], GM_L, { rot: [0.32, 0, 0], bevel: 0.03, edge: 1.4 });
  b.block(1.28, 0.16, 0.44, [0, 0.66, 0.06], GM, { bevel: 0.04, edge: 1.35 });
  for (let i = 0; i < 4; i++) b.box(0.6, 0.035, 0.03, [0, 0.36 + i * 0.07, 0.455], TRACK);
  lamp(b, [0.3, 0.36, -0.44], 0.04);
  lamp(b, [-0.3, 0.36, -0.44], 0.04);
  add("torso", "plates", b);

  // ---- team panels: the deck plate on top, stripes down the glacis, a cap over the back
  b = pb();
  b.block(0.64, 0.04, 0.46, [0, 0.76, 0.1], t.main, { bevel: 0.015, edge: 1.45 });
  for (const sx of [-1, 1]) b.block(0.2, 0.035, 0.26, [sx * 0.27, 0.5, -0.43], t.main, { rot: [0.32 - HALF, 0, 0], bevel: 0.01, edge: 1.3 });
  b.block(0.5, 0.04, 0.12, [0, 0.66, 0.47], t.main, { bevel: 0.012 });
  add("torso", "panels", b);

  // ---- head: a squat armoured helm between the shoulders, a dark brow, a team crest, the eye socket
  b = pb();
  b.block(0.36, 0.26, 0.34, [0, 0.12, 0], GM_L, { taper: 0.18, bevel: 0.04, edge: 1.35 });
  b.block(0.4, 0.06, 0.14, [0, 0.23, -0.12], GM_D, { rot: [-0.35, 0, 0], bevel: 0.015 });
  b.pairBlock(0.07, 0.18, 0.28, [0.2, 0.09, 0.0], GM, { bevel: 0.02 });
  b.box(0.07, 0.04, 0.3, [0, 0.27, 0.02], t.main);
  b.cyl(0.012, 0.012, 0.22, 4, [0.13, 0.33, 0.1], GM_D);
  lamp(b, [0.13, 0.45, 0.1], 0.03);
  b.drum(0.105, 0.095, 0.07, 10, [0, 0.11, -0.17], GM_D, { rot: [-HALF, 0, 0], bevel: 0.015 });
  add("head", "head", b);
  // the eye, lit (the laser) or dark (its glow is baked: two meshes)
  b = pb();
  b.sphere(0.072, [0, 0.11, -0.2], AMBER, { glow: 1, w: 10, h: 6, scale: [1, 1, 0.6] });
  b.sphere(0.032, [0, 0.11, -0.236], 0xfff0c8, { glow: 1, w: 6, h: 4 });
  add("head", "eyeLit", b);
  b = pb();
  b.sphere(0.072, [0, 0.11, -0.2], 0x25292e, { w: 10, h: 6, scale: [1, 1, 0.6] });
  b.sphere(0.03, [0, 0.11, -0.234], 0x3a2a1c, { w: 6, h: 4 });
  add("head", "eyeDark", b);
  // (Robot Love: in love, it glows pink)
  b = pb();
  b.sphere(0.072, [0, 0.11, -0.2], 0xff5fa2, { glow: 1, w: 10, h: 6, scale: [1, 1, 0.6] });
  b.sphere(0.032, [0, 0.11, -0.236], 0xffd0e6, { glow: 1, w: 6, h: 4 });
  add("head", "eyeLove", b);

  // ---- arms: a shoulder drum under a team pauldron, the upper arm, and a cannon for a forearm
  for (const sx of [-1, 1]) {
    const L = sx < 0 ? "L" : "R";
    b = pb();
    b.cyl(0.16, 0.16, 0.26, 10, [sx * 0.06, 0, 0], GM_D, { rot: [0, 0, HALF] });
    b.block(0.44, 0.06, 0.52, [sx * 0.12, 0.07, 0], GM_D, { rot: [0, 0, -sx * 0.32], bevel: 0.015 });
    b.block(0.42, 0.16, 0.5, [sx * 0.12, 0.15, 0], t.main, { rot: [0, 0, -sx * 0.32], bevel: 0.045, edge: 1.45 });
    b.block(0.24, 0.34, 0.28, [sx * 0.06, -0.2, 0], GM, { bevel: 0.03 });
    b.cyl(0.115, 0.115, 0.28, 10, [sx * 0.06, -0.36, 0], GM_D, { rot: [0, 0, HALF] });
    lamp(b, [sx * 0.2, 0.12, -0.26], 0.03);
    add(`shoulder${L}` as GoliathJoint, "arms", b);
    b = pb();
    b.block(0.27, 0.27, 0.64, [0, 0, -0.2], GM, { bevel: 0.04 });
    b.block(0.12, 0.03, 0.5, [0, 0.145, -0.2], t.main, { bevel: 0.01 });
    b.block(0.04, 0.16, 0.36, [sx * 0.15, 0, -0.18], GM_D, { bevel: 0.01 });
    for (let i = 0; i < 3; i++) b.box(0.012, 0.12, 0.04, [sx * 0.175, 0, -0.06 - i * 0.1], TRACK);
    b.tube(0.065, 0.44, 8, [0, 0, -0.72], BARREL);
    b.tube(0.088, 0.12, 8, [0, 0, -0.9], GM_D);
    b.tube(0.05, 0.02, 8, [0, 0, -0.965], 0x111214);
    lamp(b, [-sx * 0.1, 0.1, -0.5], 0.03);
    add(`cannon${L}` as GoliathJoint, "arms", b);
  }

  // ---- the shoulder mortar pods: four tubes each, a team top, hazard-banded
  for (const sx of [-1, 1]) {
    b = pb();
    b.block(0.2, 0.12, 0.22, [0, 0, 0.04], GM_D, { bevel: 0.02 });
    b.block(0.34, 0.3, 0.5, [0, 0.17, -0.1], GM, { bevel: 0.03 });
    b.block(0.32, 0.035, 0.46, [0, 0.33, -0.1], t.main, { bevel: 0.012, edge: 1.45 });
    for (let i = 0; i < 4; i++) b.box(0.088, 0.31, 0.04, [-0.13 + i * 0.087, 0.17, 0.13], i % 2 ? HAZ_D : HAZ);
    for (const x of [-0.075, 0.075])
      for (const y of [0.095, 0.245]) {
        b.cyl(0.06, 0.06, 0.03, 8, [x, y, -0.35], GM_D, { rot: [HALF, 0, 0] });
        b.cyl(0.045, 0.045, 0.034, 8, [x, y, -0.352], TRACK, { rot: [HALF, 0, 0] });
      }
    add(sx < 0 ? "podL" : "podR", "pods", b);
  }

  // ---- the machine guns: ball mounts under the chest's front corners, twin barrels
  for (const sx of [-1, 1]) {
    b = pb();
    b.sphere(0.08, [0, 0, 0], GM_D, { w: 8, h: 6 });
    b.block(0.12, 0.09, 0.14, [0, 0, -0.08], GM, { bevel: 0.02 });
    for (const x of [-0.028, 0.028]) b.tube(0.018, 0.24, 6, [x, 0, -0.26], BARREL);
    add(sx < 0 ? "mgL" : "mgR", "mg", b);
  }

  // ---- the scrap hopper on its back: an open bin with a load of scrap, hazard-rimmed, under a hinged lid
  b = pb();
  b.block(0.6, 0.06, 0.32, [0, 0.03, 0.16], GM_D, { bevel: 0.01 });
  b.block(0.6, 0.4, 0.05, [0, 0.2, 0.3], GM, { bevel: 0.015 });
  b.pairBlock(0.05, 0.4, 0.32, [0.28, 0.2, 0.16], GM, { bevel: 0.015 });
  b.box(0.52, 0.03, 0.26, [0, 0.3, 0.15], 0x141518);
  LUMPS.forEach((col, i) => b.box(0.1, 0.07, 0.09, [-0.2 + i * 0.08, 0.33, 0.1 + (i % 3) * 0.05], col, { rot: [i * 0.7, i * 1.3, i * 0.4] }));
  for (let i = 0; i < 6; i++) b.box(0.1, 0.035, 0.055, [-0.25 + i * 0.1, 0.4, 0.3], i % 2 ? HAZ_D : HAZ);
  add("hopper", "hopper", b);
  b = pb();
  b.block(0.64, 0.04, 0.34, [0, 0.02, -0.16], GM_L, { bevel: 0.012, edge: 1.35 });
  b.box(0.36, 0.012, 0.08, [0, 0.045, -0.2], t.main);
  add("lid", "hopper", b);

  // ---- the crane: a lattice boom on a slewing base, a hazard-striped jib, a hook block on its cable
  b = pb();
  b.drum(0.08, 0.07, 0.08, 8, [0, 0, 0], GM_D, { bevel: 0.015 });
  b.pair(0.035, 0.9, 0.035, [0.045, 0.45, 0], GM_D);
  for (let i = 0; i < 6; i++) b.box(0.12, 0.025, 0.025, [0, 0.1 + i * 0.15, 0], GM);
  b.box(0.12, 0.08, 0.08, [0, 0.9, 0], HAZ);
  add("boom", "crane", b);
  b = pb();
  b.box(0.05, 0.6, 0.05, [0, 0.3, 0], GM_L);
  for (let i = 0; i < 4; i++) b.box(0.056, 0.07, 0.056, [0, 0.1 + i * 0.14, 0], i % 2 ? HAZ_D : HAZ);
  b.box(0.08, 0.06, 0.08, [0, 0.6, 0], GM_D);
  lamp(b, [0, 0.64, 0], 0.03);
  add("jib", "crane", b);
  b = pb();
  b.box(0.012, 0.3, 0.012, [0, -0.15, 0], TRACK);
  b.block(0.1, 0.08, 0.08, [0, -0.34, 0], GM_D, { bevel: 0.01 });
  b.box(0.025, 0.06, 0.025, [0, -0.41, 0], HAZ);
  add("hook", "crane", b);
  return out;
}

// ------------------------------------------------- Belle Époque: Gargantua ---

/**
 * Gargantua (BELLE_EPOQUE): the same joints and parts as buildParts, dressed
 * as a walking steam fortress in the spirit of Verne's steam elephant and the
 * 1900 fairground automata — riveted bronze on blackened iron, brass bands,
 * gaslit portholes. Elephant-column legs on round pads with ivory toenails;
 * the body a little riveted house with a gallery of portholes, twin
 * smokestacks and a team-colour mansard roof flying pennants; a diving-helmet
 * conning dome whose great porthole is the eye (the *rayon ardent*, an arc-lamp
 * heat-ray: the laser); round casemate turrets for pauldrons, each over a
 * naval gun (the arm cannons); a bronze coastal mortar on each shoulder (the
 * mortar pods); a Hotchkiss revolving cannon in each chest sponson (the
 * machine guns); a coal tender and a riveted derrick on its back. Muzzles,
 * hook points and every pivot are the original's.
 */
function buildPartsBelle(t: Team): Part[] {
  const out: Part[] = [];
  const add = (joint: GoliathJoint, part: GoliathPart, b: ModelBuilder) => out.push({ joint, part, geo: b.build() });
  const D = GOLIATH_RIG;
  const HALF = Math.PI / 2;
  const IRON = GM_D;
  const BRONZE = GM;
  const SOOT = 0x1a1512;
  const VERDI = 0x5f9a86;
  let b: ModelBuilder;
  /** A band of brass round an upright cylinder of radius r at height y. */
  const band = (bb: ModelBuilder, r: number, y: number, at: [number, number] = [0, 0], w = 0.022, col = BRASS) =>
    bb.cyl(r + 0.008, r + 0.008, w, 12, [at[0], y, at[1]], col);
  /** A ring of rivet heads round an upright cylinder. */
  const rivets = (bb: ModelBuilder, r: number, y: number, n: number, at: [number, number] = [0, 0], s = 0.018) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      bb.box(s, s, s, [at[0] + Math.sin(a) * r, y, at[1] + Math.cos(a) * r], BRASS);
    }
  };
  /** A gaslit porthole: brass ring, amber glass; `side` turns it to face ±x instead of -z/+z. */
  const port = (bb: ModelBuilder, at: Vec3, r: number, side = 0, back = false) => {
    const rot: Vec3 = side ? [0, HALF, 0] : [0, 0, 0];
    bb.torus(r, r * 0.28, at, BRASS, { rot, seg: 10 });
    const d = r * 0.35;
    const g: Vec3 = side ? [at[0] + side * -d * 0.2, at[1], at[2]] : [at[0], at[1], at[2] + (back ? 1 : -1) * -d * 0.2];
    bb.sphere(r * 0.92, g, AMBER, { glow: 0.9, w: 8, h: 4, scale: side ? [0.35, 1, 1] : [1, 1, 0.35] });
  };

  // ---- legs: riveted bronze columns like an elephant's, brass-banded, on round pads with ivory toenails
  for (const sx of [-1, 1]) {
    const L = sx < 0 ? "L" : "R";
    b = pb();
    b.sphere(0.14, [0, 0, 0], IRON, { w: 10, h: 6 });
    b.cyl(0.15, 0.13, 0.48, 12, [0, -0.3, 0], BRONZE);
    band(b, 0.15, -0.09, [0, 0], 0.05, t.main);
    band(b, 0.135, -0.5);
    rivets(b, 0.15, -0.16, 10);
    b.cyl(0.03, 0.03, 0.42, 6, [0, -0.3, 0.17], BARREL);
    b.box(0.07, 0.05, 0.06, [0, -0.1, 0.16], IRON);
    add(`thigh${L}` as GoliathJoint, "legs", b);
    b = pb();
    b.cyl(0.115, 0.115, 0.3, 10, [0, 0, 0], IRON, { rot: [0, 0, HALF] });
    b.cyl(0.09, 0.1, 0.05, 10, [0, 0.0, -0.13], BRASS, { rot: [HALF, 0, 0] });
    b.cyl(0.04, 0.04, 0.03, 8, [0, 0.0, -0.16], BRONZE, { rot: [HALF, 0, 0] });
    b.cyl(0.13, 0.16, 0.48, 12, [0, -0.33, 0.01], BRONZE);
    band(b, 0.14, -0.15);
    band(b, 0.16, -0.54);
    rivets(b, 0.155, -0.47, 10);
    // (the steam piston down the back of the calf)
    b.cyl(0.04, 0.04, 0.38, 6, [0, -0.3, 0.19], BARREL);
    b.cyl(0.05, 0.05, 0.08, 8, [0, -0.13, 0.19], GM_L);
    b.sphere(0.1, [0, -D.shin, 0], IRON, { w: 8, h: 5 });
    add(`shin${L}` as GoliathJoint, "legs", b);
    b = pb();
    const y0 = -D.ankle;
    // the round pad, a little longer than wide, its iron sole and bronze ankle drum
    b.drum(0.25, 0.24, 0.08, 14, [0, y0 + 0.04, -0.06], IRON, { scale: [1, 1, 1.25], bevel: 0.015 });
    b.drum(0.21, 0.17, 0.12, 14, [0, y0 + 0.12, -0.05], BRONZE, { scale: [1, 1, 1.2], bevel: 0.03, edge: 1.35 });
    band(b, 0.205, y0 + 0.1, [0, -0.05], 0.025);
    for (const a of [-0.75, -0.25, 0.25, 0.75]) b.sphere(0.055, [Math.sin(a) * 0.2, y0 + 0.03, -0.06 - Math.cos(a) * 0.27], WHITE, { w: 8, h: 4, phi: Math.PI / 2, scale: [1, 1, 0.8] });
    lamp(b, [sx * 0.2, y0 + 0.15, -0.2], 0.03);
    add(`foot${L}` as GoliathJoint, "legs", b);
  }

  // ---- pelvis: the riveted undercarriage, hip drums with team hub caps, a glowing firebox door, the water tank, the waist ring
  b = pb();
  b.block(0.64, 0.3, 0.5, [0, -0.02, 0], IRON, { bevel: 0.04 });
  for (const sx of [-1, 1]) {
    b.cyl(0.16, 0.16, 0.2, 12, [sx * 0.36, 0, 0], BRONZE, { rot: [0, 0, HALF] });
    b.cyl(0.125, 0.125, 0.04, 12, [sx * 0.465, 0, 0], t.main, { rot: [0, 0, HALF] });
    b.cyl(0.04, 0.04, 0.05, 8, [sx * 0.49, 0, 0], BRASS, { rot: [0, 0, HALF] });
    b.box(0.12, 0.1, 0.5, [sx * 0.52, -0.02, 0], IRON);
  }
  // the firebox: a brass-framed door with an amber grate
  b.block(0.36, 0.24, 0.08, [0, -0.06, -0.27], BRONZE, { bevel: 0.02 });
  b.box(0.3, 0.025, 0.02, [0, 0.055, -0.31], BRASS);
  b.box(0.3, 0.025, 0.02, [0, -0.175, -0.31], BRASS);
  for (let i = 0; i < 4; i++) b.box(0.045, 0.14, 0.012, [-0.105 + i * 0.07, -0.06, -0.312], AMBER, { glow: 0.85 });
  // behind: the water tank, banded
  b.cyl(0.13, 0.13, 0.5, 12, [0, 0.03, 0.3], BRONZE, { rot: [0, 0, HALF] });
  for (const x of [-0.18, 0.18]) b.cyl(0.138, 0.138, 0.025, 12, [x, 0.03, 0.3], BRASS, { rot: [0, 0, HALF] });
  lamp(b, [0.2, 0.12, 0.41], 0.03);
  lamp(b, [-0.2, 0.12, 0.41], 0.03);
  b.drum(0.27, 0.25, 0.1, 14, [0, 0.19, 0], IRON, { bevel: 0.02 });
  band(b, 0.26, 0.21);
  add("pelvis", "pelvis", b);

  // ---- stabilisers: a bronze sleeve on a knuckle at each hip corner, brass-banded; out of it an iron anchor shank and flukes
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const k = `${sz < 0 ? "F" : "B"}${sx < 0 ? "L" : "R"}`;
      b = pb();
      b.box(0.16, 0.1, 0.16, [0, 0, 0], IRON);
      b.cyl(0.075, 0.07, 0.42, 10, [0, -0.24, 0], BRONZE);
      band(b, 0.07, -0.12);
      band(b, 0.07, -0.37, [0, 0], 0.05);
      b.cyl(0.08, 0.08, 0.03, 10, [0, -0.43, 0], IRON);
      add(`spike${k}` as GoliathJoint, "spikes", b);
      b = pb();
      b.cyl(0.035, 0.035, 0.58, 6, [0, -0.34, 0], BARREL);
      b.torus(0.04, 0.012, [0, -0.08, 0], IRON, { seg: 8 });
      b.cone(0.06, 0.16, 6, [0, -0.7, 0], IRON, { rot: [Math.PI, 0, 0] });
      // (anchor flukes)
      b.box(0.2, 0.03, 0.03, [0, -0.6, 0], IRON);
      for (const fx of [-1, 1]) b.cone(0.022, 0.07, 5, [fx * 0.1, -0.57, 0], IRON);
      add(`rod${k}` as GoliathJoint, "spikes", b);
    }

  // ---- inner frame (the Gantry only): an iron spine and ribs round the boiler and its glowing firebox
  b = pb();
  b.block(0.22, 0.7, 0.22, [0, 0.36, 0.08], IRON, { bevel: 0.03 });
  for (const y of [0.22, 0.4, 0.58]) for (const z of [-0.22, 0.3]) b.box(0.86, 0.05, 0.05, [0, y, z], TRACK);
  for (const x of [-0.42, 0.42]) for (const z of [-0.22, 0.3]) b.box(0.05, 0.62, 0.05, [x, 0.36, z], IRON);
  b.box(1.36, 0.1, 0.12, [0, 0.66, 0.04], IRON);
  b.cyl(0.2, 0.2, 0.62, 12, [0, 0.44, 0.04], BRONZE, { rot: [HALF, 0, 0] });
  b.cyl(0.13, 0.13, 0.22, 10, [0, 0.26, -0.08], AMBER, { glow: 0.85 });
  for (const z of [-0.14, 0.04, 0.22]) b.torus(0.21, 0.02, [0, 0.44, z], BRASS, { seg: 12 });
  add("torso", "frame", b);

  // ---- the house: a riveted bronze body on an iron plinth, a gallery of gaslit portholes, a brass cornice, twin smokestacks
  b = pb();
  b.drum(0.33, 0.33, 0.26, 12, [0, 0, 0.04], IRON, { scale: [1, 1, 0.85], bevel: 0.03 });
  band(b, 0.33, 0.2, [0, 0.04]);
  b.block(1.1, 0.06, 0.84, [0, 0.26, 0.04], IRON, { bevel: 0.02 });
  b.block(1.02, 0.42, 0.78, [0, 0.29, 0.04], BRONZE, { taper: -0.04, bevel: 0.03 });
  // (the bow: a rounded front under the conning dome)
  b.cyl(0.36, 0.36, 0.42, 14, [0, 0.5, -0.28], BRONZE, { scale: [1, 1, 0.42] });
  b.block(1.14, 0.05, 0.88, [0, 0.715, 0.04], BRONZE, { bevel: 0.015, edge: 1.5 });
  b.cyl(0.38, 0.38, 0.05, 14, [0, 0.715, -0.28], BRONZE, { scale: [1, 1, 0.44] });
  // a brass gallery rail round the deck
  for (const sx of [-1, 1]) {
    b.box(0.015, 0.015, 0.84, [sx * 0.55, 0.81, 0.04], BRASS);
    for (let i = 0; i < 5; i++) b.box(0.014, 0.08, 0.014, [sx * 0.55, 0.77, -0.36 + i * 0.2], BRASS);
  }
  b.box(1.1, 0.015, 0.015, [0, 0.81, 0.46], BRASS);
  // the shoulder beam: a crosswise boiler drum, brass end rings
  b.cyl(0.13, 0.13, 1.3, 12, [0, 0.6, 0.06], IRON, { rot: [0, 0, HALF] });
  for (const sx of [-1, 1]) b.cyl(0.14, 0.14, 0.03, 12, [sx * 0.53, 0.6, 0.06], BRASS, { rot: [0, 0, HALF] });
  // rivet rows along the plinth and under the cornice
  for (let i = 0; i < 9; i++) {
    const x = -0.44 + i * 0.11;
    b.box(0.018, 0.018, 0.018, [x, 0.34, 0.435], BRASS);
    b.box(0.018, 0.018, 0.018, [x, 0.67, 0.435], BRASS);
  }
  for (let i = 0; i < 7; i++) {
    const z = -0.24 + i * 0.1;
    for (const sx of [-1, 1]) {
      b.box(0.018, 0.018, 0.018, [sx * 0.515, 0.34, z], BRASS);
      b.box(0.018, 0.018, 0.018, [sx * 0.515, 0.67, z], BRASS);
    }
  }
  // portholes: three across the bow, two down each flank
  for (const x of [-0.22, 0, 0.22]) port(b, [x, 0.48, -0.44 + Math.abs(x) * 0.3], 0.05);
  for (const sx of [-1, 1]) for (const z of [-0.02, 0.24]) port(b, [sx * 0.52, 0.47, z], 0.05, sx);
  // gas lanterns either side of the bow
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.08, 0.02, [sx * 0.36, 0.67, -0.42], IRON);
    b.box(0.05, 0.06, 0.05, [sx * 0.36, 0.73, -0.42], AMBER, { glow: 1 });
    b.cone(0.045, 0.04, 4, [sx * 0.36, 0.78, -0.42], IRON, { rot: [0, Math.PI / 4, 0] });
  }
  // twin smokestacks behind the roof: iron, banded, flared crowns sooted inside
  for (const sx of [-1, 1]) {
    const x = sx * 0.13;
    b.cyl(0.06, 0.07, 0.5, 10, [x, 0.92, 0.36], IRON);
    band(b, 0.065, 0.78, [x, 0.36], 0.025);
    band(b, 0.06, 1.02, [x, 0.36], 0.025);
    b.cyl(0.095, 0.06, 0.09, 10, [x, 1.2, 0.36], BRONZE);
    b.cyl(0.07, 0.07, 0.012, 10, [x, 1.245, 0.36], SOOT);
  }
  add("torso", "plates", b);

  // ---- team panels: the mansard roof between the mortars (the stacks rise through it), its brass ridge and flag,
  // pennants down the bow and a banner at the back
  b = pb();
  b.block(0.56, 0.04, 0.5, [0, 0.74, 0.18], t.dark, { bevel: 0.01 });
  b.block(0.52, 0.22, 0.48, [0, 0.76, 0.18], t.main, { taper: 0.5, bevel: 0.02, edge: 1.45 });
  b.box(0.22, 0.022, 0.03, [0, 0.985, 0.12], BRASS);
  b.cyl(0.01, 0.01, 0.24, 5, [0, 1.1, 0.06], BRASS);
  b.box(0.14, 0.09, 0.01, [0.075, 1.17, 0.06], t.main);
  b.box(0.05, 0.09, 0.011, [0.17, 1.17, 0.06], t.light);
  // a dormer on the front slope, gaslit
  b.block(0.1, 0.09, 0.08, [0, 0.82, -0.01], BRONZE, { bevel: 0.01 });
  b.cone(0.075, 0.06, 4, [0, 0.94, -0.01], VERDI, { rot: [0, Math.PI / 4, 0] });
  b.box(0.05, 0.05, 0.012, [0, 0.86, -0.052], AMBER, { glow: 0.85 });
  // pennants hung from the cornice down the bow's shoulders, swallow-tailed
  for (const sx of [-1, 1]) {
    b.box(0.13, 0.3, 0.014, [sx * 0.38, 0.55, -0.43], t.main);
    b.box(0.13, 0.03, 0.016, [sx * 0.38, 0.69, -0.43], BRASS);
    b.box(0.055, 0.08, 0.014, [sx * 0.38 - 0.035, 0.36, -0.43], t.main);
    b.box(0.055, 0.08, 0.014, [sx * 0.38 + 0.035, 0.36, -0.43], t.main);
    b.box(0.03, 0.22, 0.016, [sx * 0.38, 0.55, -0.437], t.light);
  }
  b.block(0.5, 0.05, 0.13, [0, 0.69, 0.46], t.main, { bevel: 0.012 });
  add("torso", "panels", b);

  // ---- head: a diving-helmet conning dome, brass-collared, a lantern hood over the great porthole, a team plume
  b = pb();
  b.drum(0.19, 0.17, 0.06, 12, [0, -0.01, 0], IRON, { bevel: 0.015 });
  b.sphere(0.17, [0, 0.12, 0.01], BRONZE, { w: 12, h: 8, scale: [1, 0.92, 1] });
  b.torus(0.165, 0.018, [0, 0.06, 0.01], BRASS, { rot: [HALF, 0, 0], seg: 14 });
  // the great porthole: a thick brass ring round the eye, cross-bolted
  b.torus(0.088, 0.024, [0, 0.11, -0.165], BRASS, { seg: 14 });
  for (const a of [0, HALF, Math.PI, -HALF]) b.box(0.024, 0.024, 0.02, [Math.cos(a) * 0.115, 0.11 + Math.sin(a) * 0.115, -0.165], GM_L);
  b.block(0.22, 0.03, 0.09, [0, 0.215, -0.15], IRON, { rot: [-0.45, 0, 0], bevel: 0.01 });
  // side ports, grilled
  for (const sx of [-1, 1]) {
    b.torus(0.045, 0.012, [sx * 0.16, 0.12, 0.02], BRASS, { rot: [0, HALF, 0], seg: 10 });
    b.box(0.012, 0.07, 0.012, [sx * 0.168, 0.12, 0.02], IRON);
  }
  // the crest: a team strip over the dome and a plume on a brass spike
  b.box(0.05, 0.03, 0.26, [0, 0.27, 0.04], t.main);
  b.cyl(0.012, 0.018, 0.08, 6, [0, 0.31, 0.1], BRASS);
  b.cone(0.04, 0.14, 7, [0, 0.4, 0.12], t.main, { rot: [0.35, 0, 0] });
  lamp(b, [0.12, 0.25, 0.08], 0.025);
  add("head", "head", b);
  // the eye, lit (the heat-ray's arc lamp) or dark (its glow is baked: two meshes)
  b = pb();
  b.sphere(0.075, [0, 0.11, -0.2], AMBER, { glow: 1, w: 12, h: 6, scale: [1, 1, 0.6] });
  b.sphere(0.034, [0, 0.11, -0.238], 0xfff4d6, { glow: 1, w: 6, h: 4 });
  add("head", "eyeLit", b);
  b = pb();
  b.sphere(0.075, [0, 0.11, -0.2], 0x2a2420, { w: 12, h: 6, scale: [1, 1, 0.6] });
  b.sphere(0.03, [0, 0.11, -0.236], 0x3a2a1c, { w: 6, h: 4 });
  add("head", "eyeDark", b);
  b = pb();
  b.sphere(0.075, [0, 0.11, -0.2], 0xff5fa2, { glow: 1, w: 12, h: 6, scale: [1, 1, 0.6] });
  b.sphere(0.034, [0, 0.11, -0.238], 0xffd0e6, { glow: 1, w: 6, h: 4 });
  add("head", "eyeLove", b);

  // ---- arms: a shoulder drum under a team casemate turret, a riveted upper arm, and a naval gun for a forearm
  for (const sx of [-1, 1]) {
    const L = sx < 0 ? "L" : "R";
    b = pb();
    b.cyl(0.16, 0.16, 0.26, 12, [sx * 0.06, 0, 0], IRON, { rot: [0, 0, HALF] });
    b.drum(0.25, 0.22, 0.08, 14, [sx * 0.1, 0.06, 0], IRON, { bevel: 0.015 });
    b.sphere(0.235, [sx * 0.1, 0.12, 0], t.main, { w: 14, h: 6, phi: Math.PI / 2, scale: [1, 0.62, 1.05] });
    b.torus(0.235, 0.016, [sx * 0.1, 0.125, 0], BRASS, { rot: [HALF, 0, 0], seg: 16 });
    b.cyl(0.05, 0.06, 0.04, 8, [sx * 0.1, 0.27, 0], BRASS);
    // (the turret's sighting hood, looking ahead)
    b.block(0.1, 0.05, 0.08, [sx * 0.1, 0.22, -0.16], t.dark, { bevel: 0.01 });
    b.cyl(0.12, 0.12, 0.34, 12, [sx * 0.06, -0.2, 0], BRONZE);
    band(b, 0.12, -0.08, [sx * 0.06, 0]);
    rivets(b, 0.122, -0.3, 8, [sx * 0.06, 0], 0.016);
    b.cyl(0.115, 0.115, 0.28, 10, [sx * 0.06, -0.36, 0], IRON, { rot: [0, 0, HALF] });
    lamp(b, [sx * 0.3, 0.1, -0.16], 0.03);
    add(`shoulder${L}` as GoliathJoint, "arms", b);
    b = pb();
    // the breech housing, team-striped, a brass recoil cylinder over it, a gun shield in front
    b.block(0.27, 0.26, 0.5, [0, -0.01, -0.12], BRONZE, { bevel: 0.04 });
    b.block(0.13, 0.03, 0.42, [0, 0.135, -0.12], t.main, { bevel: 0.01 });
    b.tube(0.035, 0.36, 8, [0, 0.17, -0.2], BRASS);
    for (let i = 0; i < 3; i++) b.box(0.016, 0.016, 0.016, [sx * 0.14, 0.05, -0.0 - i * 0.12], BRASS);
    b.block(0.34, 0.3, 0.04, [0, 0, -0.38], IRON, { bevel: 0.012 });
    b.box(0.35, 0.02, 0.05, [0, 0.15, -0.38], BRASS);
    // the barrel: stepped down in bronze hoops, a muzzle swell
    b.tube(0.078, 0.18, 10, [0, 0, -0.48], BRONZE);
    b.tube(0.084, 0.03, 10, [0, 0, -0.56], BRASS);
    b.tube(0.064, 0.3, 10, [0, 0, -0.72], BARREL);
    b.tube(0.078, 0.07, 10, [0, 0, -0.92], BRONZE);
    b.tube(0.045, 0.02, 8, [0, 0, -0.96], SOOT);
    lamp(b, [-sx * 0.1, 0.1, -0.36], 0.026);
    add(`cannon${L}` as GoliathJoint, "arms", b);
  }

  // ---- the shoulder mortars: one fat bronze coastal mortar each on a trunnioned cradle, team cheeks and band
  for (const sx of [-1, 1]) {
    b = pb();
    b.block(0.22, 0.12, 0.24, [0, 0, 0.04], IRON, { bevel: 0.02 });
    for (const cx of [-1, 1]) {
      b.block(0.05, 0.26, 0.34, [cx * 0.15, 0.12, -0.06], t.main, { bevel: 0.012, edge: 1.4 });
      b.cyl(0.04, 0.04, 0.04, 8, [cx * 0.18, 0.17, -0.06], BRASS, { rot: [0, 0, HALF] });
    }
    b.sphere(0.12, [0, 0.17, 0.08], BRONZE, { w: 10, h: 6 });
    b.tube(0.12, 0.4, 12, [0, 0.17, -0.14], BRONZE);
    b.tube(0.126, 0.04, 12, [0, 0.17, -0.04], BRASS);
    b.tube(0.126, 0.06, 12, [0, 0.17, -0.2], t.main);
    b.tube(0.136, 0.06, 12, [0, 0.17, -0.34], GM_L);
    b.tube(0.088, 0.012, 10, [0, 0.17, -0.371], SOOT);
    add(sx < 0 ? "podL" : "podR", "pods", b);
  }

  // ---- the Hotchkiss revolving cannons: ball sponsons under the chest, five barrels round a brass-collared axle, a crank
  for (const sx of [-1, 1]) {
    b = pb();
    b.sphere(0.085, [0, 0, 0], IRON, { w: 10, h: 6 });
    b.block(0.13, 0.1, 0.14, [0, 0, -0.08], BRONZE, { bevel: 0.02 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.tube(0.012, 0.24, 5, [Math.cos(a) * 0.028, Math.sin(a) * 0.028, -0.26], BARREL);
    }
    b.tube(0.046, 0.022, 10, [0, 0, -0.2], BRASS);
    b.tube(0.044, 0.022, 10, [0, 0, -0.36], BRASS);
    b.box(0.02, 0.06, 0.02, [sx * 0.08, -0.02, -0.06], GM_L);
    b.box(0.05, 0.016, 0.016, [sx * 0.1, -0.05, -0.06], GM_L);
    add(sx < 0 ? "mgL" : "mgR", "mg", b);
  }

  // ---- the coal tender on its back: a riveted bin of scrap, brass-rimmed, under a hinged lid
  b = pb();
  b.block(0.6, 0.06, 0.32, [0, 0.03, 0.16], IRON, { bevel: 0.01 });
  b.block(0.6, 0.4, 0.05, [0, 0.2, 0.3], BRONZE, { bevel: 0.015 });
  b.pairBlock(0.05, 0.4, 0.32, [0.28, 0.2, 0.16], BRONZE, { bevel: 0.015 });
  b.box(0.52, 0.03, 0.26, [0, 0.3, 0.15], 0x141518);
  LUMPS.forEach((col, i) => b.box(0.1, 0.07, 0.09, [-0.2 + i * 0.08, 0.33, 0.1 + (i % 3) * 0.05], col, { rot: [i * 0.7, i * 1.3, i * 0.4] }));
  b.box(0.62, 0.035, 0.06, [0, 0.4, 0.3], BRASS);
  for (let i = 0; i < 5; i++) b.box(0.018, 0.018, 0.018, [-0.24 + i * 0.12, 0.12, 0.33], BRASS);
  add("hopper", "hopper", b);
  b = pb();
  b.block(0.64, 0.04, 0.34, [0, 0.02, -0.16], GM_L, { bevel: 0.012, edge: 1.35 });
  b.box(0.36, 0.012, 0.08, [0, 0.045, -0.2], t.main);
  add("lid", "hopper", b);

  // ---- the derrick: an iron lattice boom on a slewing drum, a brass-banded jib, a hook block on its chain
  b = pb();
  b.drum(0.08, 0.07, 0.08, 10, [0, 0, 0], IRON, { bevel: 0.015 });
  b.pair(0.035, 0.9, 0.035, [0.045, 0.45, 0], IRON);
  for (let i = 0; i < 6; i++) b.box(0.12, 0.025, 0.025, [0, 0.1 + i * 0.15, 0], BRONZE, { rot: [0, 0, i % 2 ? 0.35 : -0.35] });
  b.box(0.12, 0.08, 0.08, [0, 0.9, 0], BRASS);
  add("boom", "crane", b);
  b = pb();
  b.box(0.05, 0.6, 0.05, [0, 0.3, 0], BRONZE);
  for (let i = 0; i < 4; i++) b.box(0.058, 0.03, 0.058, [0, 0.1 + i * 0.14, 0], BRASS);
  b.box(0.08, 0.06, 0.08, [0, 0.6, 0], IRON);
  lamp(b, [0, 0.64, 0], 0.03);
  add("jib", "crane", b);
  b = pb();
  b.box(0.012, 0.3, 0.012, [0, -0.15, 0], TRACK);
  b.block(0.1, 0.08, 0.08, [0, -0.34, 0], IRON, { bevel: 0.01 });
  b.torus(0.03, 0.01, [0, -0.41, 0], BRASS, { seg: 8 });
  add("hook", "crane", b);
  return out;
}

const partsCache = new Map<Faction, Part[]>();
function partsOf(f: Faction): Part[] {
  let p = partsCache.get(f);
  if (!p) partsCache.set(f, (p = (BELLE_EPOQUE ? buildPartsBelle : buildParts)(TEAMS[f])));
  return p;
}

// ----------------------------------------------------------------- rig ---

/** What the rig is told each frame (render/goliath.ts works it out from the sim). */
export interface GoliathPose {
  /** Frame time, ms (the walk and recoil clocks). */
  dt: number;
  /** Ground speed, tiles/s (turning on the spot counts too): the stride's cadence. */
  speed: number;
  /** Anchoring, each 0–1: body down on its hydraulics with the legs splayed, spikes driven, hopper and crane unfolded. */
  lower: number;
  spikes: number;
  unfold: number;
  /** Torso twist over the hips (rad, three.js: + turns it left). */
  yaw: number;
  /** Body lean (rad): pitch (+ nose up) from the ground ahead and behind. */
  pitch: number;
  /** Arm cannons hanging limp (0 raised … 1 drooped): cannons offline. */
  droop: number;
  /** Mortar pods tipped from their rest pitch (rad: − sags, + cycles up). */
  pods: number;
  /** The eye lit (≥ 0.5) or dark. */
  eye: number;
  /** Off the ground under its Condors: legs hanging (0–1). */
  hang: number;
  /** Crane slew while it works, anchored (rad). */
  crane: number;
  /** Idle head scan (rad). */
  look: number;
  /** Robot Love: the eye glows pink (≥ 0.5), the arms reach out to the other (0–1), the head bows shyly (rad). */
  love?: number;
  hug?: number;
  nod?: number;
  /** World ground height at (x, z), so each foot stands on the terrain under it. */
  ground?: (x: number, z: number) => number;
}

/** A part that kicks when its weapon fires. */
export type GoliathGun = "cannonL" | "cannonR" | "podL" | "podR" | "mgL" | "mgR" | "eye";

const GUNS: readonly GoliathGun[] = ["cannonL", "cannonR", "podL", "podR", "mgL", "mgR", "eye"];

const REST: GoliathPose = {
  dt: 0, speed: 0, lower: 0, spikes: 0, unfold: 0, yaw: 0, pitch: 0, droop: 0, pods: 0, eye: 1, hang: 0, crane: 0, look: 0
};

const tmpQ = new THREE.Quaternion();
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
const frac = (x: number) => x - Math.floor(x);

/**
 * One Goliath: a group to place at its ground point, turned to its facing
 * (rotation.y = -facing) and scaled by unitScale, holding its joints. Call
 * update() every frame with a pose; feet that land call `onStep` (dust, a
 * stomp) with their world point.
 */
export class GoliathRig {
  readonly root = new THREE.Group();
  readonly j = {} as Record<GoliathJoint, THREE.Group>;
  /** Every part's mesh, and what it is. */
  readonly meshes: { mesh: THREE.Mesh; part: GoliathPart }[] = [];
  /** Gait position (strides walked) and how much it is walking (0–1). */
  phase = 0;
  private move = 0;
  /** Each foot's last place in its stride (catches it landing). */
  private lastU = [0, 0.5];
  private recoil: Record<GoliathGun, number> = { cannonL: 0, cannonR: 0, podL: 0, podR: 0, mgL: 0, mgR: 0, eye: 0 };
  /** A foot came down (0 left, 1 right) at this world point (reused: read it at once). */
  onStep: ((foot: number, at: THREE.Vector3) => void) | null = null;
  private stepAt = new THREE.Vector3();
  /** Per foot this frame: ahead of the hip, lifted, ground under it (reused, no per-frame garbage). */
  private fs = [0, 0];
  private lifts = [0, 0];
  private gs = [0, 0];
  /** Joints posed together, looked up once. */
  private legs: [THREE.Group, THREE.Group, THREE.Group][];
  private spikes: [THREE.Group, THREE.Group, number, number][];

  constructor(readonly faction: Faction, shadows = true) {
    for (const name of JOINTS) {
      const g = new THREE.Group();
      const [parent, at] = AT[name];
      g.position.set(...at);
      this.j[name] = g;
      (parent ? this.j[parent] : this.root).add(g);
    }
    const J = this.j;
    J.thighL.rotation.order = J.thighR.rotation.order = "ZXY";
    J.footL.rotation.order = J.footR.rotation.order = "XZY";
    J.torso.rotation.order = "YXZ";
    J.boom.rotation.order = "YZX";
    this.legs = [[J.thighL, J.shinL, J.footL], [J.thighR, J.shinR, J.footR]];
    this.spikes = [[J.spikeFL, J.rodFL, -1, -1], [J.spikeFR, J.rodFR, 1, -1], [J.spikeBL, J.rodBL, -1, 1], [J.spikeBR, J.rodBR, 1, 1]];
    for (const p of partsOf(faction)) {
      const mesh = modelMesh(p.geo, shadows);
      J[p.joint].add(mesh);
      this.meshes.push({ mesh, part: p.part });
      // (the inner frame only shows on the Gantry: the finished armour hides it)
      if (p.part === "frame") mesh.visible = false;
    }
    this.update(REST);
  }

  /** Kick a gun back (it eases home over ~160 ms). */
  kick(gun: GoliathGun): void {
    this.recoil[gun] = 1;
  }

  /** World point of a joint-space point, into `out` (call after update()). */
  point(joint: GoliathJoint, at: Vec3, out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.j[joint].localToWorld(out.set(at[0], at[1], at[2]));
  }

  /** Where a weapon's shot leaves it (world), into `out`. */
  muzzle(gun: GoliathGun, out: THREE.Vector3): THREE.Vector3 {
    if (gun === "eye") return this.point("head", MUZZLE.laser, out);
    const kind = gun.startsWith("cannon") ? "cannon" : gun.startsWith("pod") ? "pod" : "mg";
    return this.point(gun, MUZZLE[kind], out);
  }

  /** Where a lift cable hooks on: the top of a pauldron (0 left, 1 right), world, into `out`. */
  hookPoint(side: number, out: THREE.Vector3): THREE.Vector3 {
    return this.point(side ? "shoulderR" : "shoulderL", [side ? 0.1 : -0.1, 0.26, 0], out);
  }

  /** Pose every joint for this frame. */
  update(p: GoliathPose): void {
    const D = GOLIATH_RIG;
    const J = this.j;
    const sec = p.dt / 1000;
    const s = this.root.scale.x || 1;
    const R = this.recoil;
    for (const k of GUNS) R[k] = Math.max(0, R[k] - sec * 6);

    // ---- gait: a heavy stride whose planted feet slide back at just the ground speed
    const walking = p.speed > 0.05 && p.hang < 0.5 && p.lower < 0.05 ? 1 : 0;
    this.move += (walking - this.move) * (1 - Math.exp(-sec * (walking > this.move ? 5 : 3)));
    const m = this.move;
    this.phase += (p.speed * sec * (1 - p.lower)) / (D.cycle * s);
    const u0 = frac(this.phase);
    const stride = D.cycle * D.stance;
    const reach = (D.thigh + D.shin) * 0.97;
    const runHip = D.ankle + Math.sqrt(Math.max(0, reach * reach - stride * stride * 0.25));
    // (the body dips just after each footfall, taking the weight)
    const bob = -0.035 * (0.5 + 0.5 * Math.cos(4 * Math.PI * (u0 - 0.06))) * m;
    let hips = lerp(D.hipY, runHip, m) + bob;
    hips = lerp(hips, D.hipY - D.lower, p.lower);

    // the ground under each foot, in the rig's own units relative to its root
    const root = this.root;
    const ry = root.rotation.y;
    const c = Math.cos(ry);
    const sn = Math.sin(ry);
    const splay = D.splay * p.lower;
    const fs = this.fs;
    const lifts = this.lifts;
    const gs = this.gs;
    for (let i = 0; i < 2; i++) {
      const u = frac(this.phase + i * 0.5);
      let f: number;
      let lift = 0;
      if (u < D.stance) f = stride * (0.5 - u / D.stance);
      else {
        const k = (u - D.stance) / (1 - D.stance);
        f = stride * (k * k * (3 - 2 * k) - 0.5);
        lift = D.lift * Math.sin(Math.PI * k);
      }
      fs[i] = f * m;
      lifts[i] = lift * m;
      const fx = (i ? 1 : -1) * (D.hipX + Math.tan(splay) * D.hipY * 0.7);
      if (p.ground && p.hang < 0.5) {
        const wx = root.position.x + (fx * c + fs[i]! * sn) * s;
        const wz = root.position.z + (-fx * sn + fs[i]! * c) * s;
        gs[i] = Math.max(-0.3, Math.min(0.3, (p.ground(wx, wz) - root.position.y) / s));
        // landed: dust and a stomp where it came down
        if (this.onStep && m > 0.4 && u < this.lastU[i]!) this.onStep(i, this.stepAt.set(wx, p.ground(wx, wz), wz));
      }
      this.lastU[i] = u;
    }
    const pelvisY = hips + Math.min(gs[0]!, gs[1]!) * (1 - p.hang);
    // (the weight rides over the planted foot)
    const sway = Math.cos(2 * Math.PI * (u0 - D.stance / 2)) * m;
    J.pelvis.position.set(-sway * 0.035, pelvisY, 0);
    J.pelvis.rotation.set(p.pitch * (1 - p.hang) - 0.03 * m, 0, Math.atan2(gs[1]! - gs[0]!, D.hipX * 2) * 0.5 + sway * 0.025);

    // ---- legs: two-bone IK onto each foot (in the splayed leg's plane), soles kept flat on the ground
    for (let i = 0; i < 2; i++) {
      const sx = i ? 1 : -1;
      const dv = pelvisY - (gs[i]! + D.ankle + lifts[i]!);
      let [th, sh] = ik(fs[i]!, dv / Math.cos(splay), D.thigh, D.shin);
      let toe = (lifts[i]! / D.lift) * 0.22;
      if (p.hang > 0) {
        // hanging under the lift: legs dangle, swaying a little, toes down
        const swing = Math.sin(this.phase * 0.7 + i * 1.7) * 0.06;
        th = lerp(th, 0.18 + swing, p.hang);
        sh = lerp(sh, -0.34, p.hang);
        toe = lerp(toe, -0.5, p.hang);
      }
      // (the sole follows the ground's slope: the pelvis's lean into the stride is taken back out)
      const [thigh, shin, foot] = this.legs[i]!;
      thigh.rotation.set(th, 0, sx * splay);
      shin.rotation.set(sh, 0, 0);
      foot.rotation.set(-(th + sh) + 0.03 * m + toe, 0, -sx * splay);
    }

    // ---- stabiliser spikes: they swing out, then the rods drive down into the ground
    const out = smooth(0, 0.5, p.spikes);
    const drive = smooth(0.35, 1, p.spikes);
    for (const [sp, rod, sx, sz] of this.spikes) {
      sp.rotation.set(-sz * lerp(0.08, 0.35, out), 0, sx * lerp(0.32, 0.5, out));
      rod.position.y = -0.32 * drive;
    }

    // ---- torso: twists to its target, leans into the stride
    J.torso.rotation.set(-0.05 * m, p.yaw, Math.sin(2 * Math.PI * u0) * 0.025 * m);
    const hug = p.hug ?? 0;
    J.torso.rotation.x -= 0.12 * hug;
    J.head.rotation.set(0.04 - R.eye * 0.08 + (p.nod ?? 0), p.look, 0);

    // ---- arms: they swing a little with the stride; drooped, the cannons hang at the ground
    const swing = Math.sin(2 * Math.PI * u0) * 0.07 * m;
    for (let i = 0; i < 2; i++) {
      const sx = i ? 1 : -1;
      const kick = i ? R.cannonR : R.cannonL;
      // (reaching out, the arms swing in and up toward the one in front)
      (i ? J.shoulderR : J.shoulderL).rotation.set(-sx * swing * (1 - p.droop) - 0.06 * kick + 0.12 * p.droop + 0.55 * hug, sx * 0.5 * hug, -sx * 0.1 * p.droop);
      const a = 0.04 - 1.15 * p.droop + 0.25 * hug;
      const gun = i ? J.cannonR : J.cannonL;
      gun.rotation.set(a, 0, 0);
      const at = AT[i ? "cannonR" : "cannonL"][1];
      // (the kick drives the cannon straight back along its own barrel)
      gun.position.set(at[0], at[1] - Math.sin(a) * kick * 0.14, at[2] + Math.cos(a) * kick * 0.14);
      (i ? J.podR : J.podL).rotation.set(D.podPitch + p.pods - (i ? R.podR : R.podL) * 0.08, 0, 0);
      const mg = AT[i ? "mgR" : "mgL"][1];
      (i ? J.mgR : J.mgL).position.set(mg[0], mg[1], mg[2] + (i ? R.mgR : R.mgL) * 0.04);
    }

    // ---- hopper and crane fold away walking, unfold anchored (the crane slewing as it works)
    J.hopper.rotation.x = 0.6 * smooth(0, 0.6, p.unfold);
    J.lid.rotation.x = 2.0 * smooth(0.3, 1, p.unfold);
    const ub = smooth(0.15, 0.75, p.unfold);
    const uj = smooth(0.45, 1, p.unfold);
    J.boom.rotation.set(lerp(Math.PI - 0.12, 0.42, ub), p.crane * uj, lerp(0, -0.55, ub));
    J.jib.rotation.x = lerp(-(Math.PI - 0.22), 1.1, uj);
    J.hook.visible = uj > 0.4;
    // (the hook hangs plumb under the jib)
    tmpQ.copy(J.pelvis.quaternion).multiply(J.torso.quaternion).multiply(J.boom.quaternion).multiply(J.jib.quaternion).invert();
    J.hook.quaternion.copy(tmpQ);

    // ---- the eye, lit or dark
    const love = (p.love ?? 0) >= 0.5;
    const lit = p.eye >= 0.5 && !love;
    for (const { mesh, part } of this.meshes) {
      if (part === "eyeLit") mesh.visible = lit;
      else if (part === "eyeDark") mesh.visible = !lit && !love;
      else if (part === "eyeLove") mesh.visible = love;
    }
  }

  /**
   * Bake the current pose into one plain geometry in the rig's own space:
   * only the parts asked for (default: the finished mech, eye lit).
   */
  bake(parts?: readonly GoliathPart[]): THREE.BufferGeometry {
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    const list: THREE.BufferGeometry[] = [];
    for (const { mesh, part } of this.meshes) {
      if (parts ? !parts.includes(part) : part === "eyeDark" || part === "eyeLove" || part === "frame") continue;
      list.push(mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld)));
    }
    const g = mergeGeometries(list, false)!;
    for (const l of list) l.dispose();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** The Goliath standing at rest, baked (or only some of its parts: a Gantry stage), cached per side. */
const statics = new Map<string, THREE.BufferGeometry>();
export function goliathStatic(f: Faction, parts?: readonly GoliathPart[]): THREE.BufferGeometry {
  const key = `${f}/${parts ? parts.join(",") : "all"}`;
  let g = statics.get(key);
  if (!g) statics.set(key, (g = new GoliathRig(f, false).bake(parts)));
  return g;
}

/** The half-built Goliath on the Gantry's cradle at stage `i` (0 Foundation … 3 Finishing). */
export function gantryStage(f: Faction, i: number): THREE.BufferGeometry {
  return goliathStatic(f, GANTRY_STAGES[i]!);
}
