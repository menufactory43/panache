import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ZenithWeapon } from "../../sim/balance";
import type { Faction } from "../../sim/types";
import { NATION_TEAMS } from "./belle/placeholders";
import { ModelBuilder, type Vec3 } from "./builder";
import { modelMesh, type ModelDef, type Team } from "./models";

/**
 * The Zénith (PANACHE-CONCEPTION.md §1.5, §1.11, WP5e): the République's
 * flying cruiser and airborne base. A rigid airship of ivory doped canvas on
 * a faceted frame, a full-length navy dorsal band and flank stripes, navy
 * tail fins (the team patch from the high camera), a glazed control car with
 * a keel catwalk aft of it, four engine nacelles on outriggers, a hangar bay
 * in its belly whose doors open while it is moored and producing.
 *
 * Four weapon systems are separate parts that render/zenith.ts switches off
 * as they are lost (ZENITH.weapons, lost in this order): the Branly gun pods
 * either side (coils lit blue; lost, the barrels sag), the bow arc on the
 * nose mast (a lit ball; lost, it goes dark), the bomb rack behind the hangar
 * (an amber lamp; lost, the rack hangs askew) and the catwalk machine guns.
 *
 * Moored, four cables pay out from hardpoints under the hull and grapnel
 * anchors bite the ground (ZenithPose.moor, .drop).
 *
 * Like the Goliath (three/goliath.ts): a rig of named groups posed every
 * frame, and the same rig baked at rest for the plain ModelDef (portraits,
 * the model page, anything that draws it as an ordinary unit).
 * Origin on the envelope's axis, at its middle; nose to -Z. Model units:
 * the envelope is 3.2 long. Budget (§3.4): ≤ 4 000 triangles, all parts.
 */

/** Ivory doped canvas, a shade darker for the frame, brass trim, gunmetal, copper coils. */
const IVORY = 0xefe5cb;
const IVORY_D = 0xcbbf9f;
const BRASS = 0xd8ae58;
const METAL = 0x4a4740;
const METAL_D = 0x2c2a27;
const COPPER = 0xc06a3a;
const WOOD = 0x6b4628;
/** Lit: a Branly coil or the arc ball (electric blue), lamps and glazing (gaslight amber). */
const ARC_BLUE = 0x8fd8ff;
const AMBER = 0xffc561;

/** The envelope's profile: radius at each z (nose to tail). */
const PROFILE: [r: number, z: number][] = [
  [0.0, -1.6], [0.13, -1.55], [0.25, -1.43], [0.34, -1.22], [0.4, -0.92], [0.42, -0.5],
  [0.42, 0.3], [0.39, 0.8], [0.31, 1.18], [0.2, 1.43], [0.08, 1.58], [0.0, 1.62]
];
/** Envelope radius at z (linear between profile points). */
function radiusAt(z: number): number {
  for (let i = 0; i + 1 < PROFILE.length; i++) {
    const [r0, z0] = PROFILE[i]!;
    const [r1, z1] = PROFILE[i + 1]!;
    if (z >= z0 && z <= z1) return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
  }
  return 0;
}

/** Height of the rig's top above its origin (model units): bars and labels sit above it. */
export const ZENITH_TOP = 0.62;
/** Where the mooring cables leave the hull (model units), front pair then back pair. */
export const MOOR_POINTS: readonly Vec3[] = [[-0.3, -0.36, -0.75], [0.3, -0.36, -0.75], [-0.3, -0.33, 0.85], [0.3, -0.33, 0.85]];

/** A part that kicks when it fires. */
export type ZenithGun = "branlyL" | "branlyR" | "arc" | "bombs" | "mgL" | "mgR";
export const ZENITH_GUNS: readonly ZenithGun[] = ["branlyL", "branlyR", "arc", "bombs", "mgL", "mgR"];
/** Which weapon system each gun belongs to. */
export const GUN_WEAPON: Record<ZenithGun, ZenithWeapon> = {
  branlyL: "branly", branlyR: "branly", arc: "arc", bombs: "bombs", mgL: "mg", mgR: "mg"
};

/**
 * The rig's named groups, parent first: [parent (null: the body), pivot in
 * the parent's space]. Guns pivot at their mounts; `…Lit` parts are the
 * lamps a lost weapon turns off; cables hang from MOOR_POINTS, anchors at
 * their feet (moved by update()).
 */
const AT = {
  branlyL: [null, [-0.47, -0.2, -0.12]],
  branlyR: [null, [0.47, -0.2, -0.12]],
  branlyLBarrel: ["branlyL", [0, -0.02, -0.02]],
  branlyRBarrel: ["branlyR", [0, -0.02, -0.02]],
  arc: [null, [0, 0, -1.6]],
  bombs: [null, [0, -0.36, 1.0]],
  mgL: [null, [0, 0.43, -0.82]],
  mgR: [null, [0, 0.415, 0.62]],
  bayL: [null, [-0.17, -0.47, 0.42]],
  bayR: [null, [0.17, -0.47, 0.42]],
  cable0: [null, MOOR_POINTS[0]!],
  cable1: [null, MOOR_POINTS[1]!],
  cable2: [null, MOOR_POINTS[2]!],
  cable3: [null, MOOR_POINTS[3]!],
  anchor0: [null, MOOR_POINTS[0]!],
  anchor1: [null, MOOR_POINTS[1]!],
  anchor2: [null, MOOR_POINTS[2]!],
  anchor3: [null, MOOR_POINTS[3]!]
} as const satisfies Record<string, readonly [string | null, Vec3]>;
export type ZenithJoint = keyof typeof AT | "body";
const JOINTS = Object.keys(AT) as (keyof typeof AT)[];

/** A mesh of the rig: the joint it rides on, and what it is (lit lamps toggle; cables and anchors show moored). */
type PartRole = "static" | "lit" | "cable" | "anchor" | "rotor";
interface Part {
  joint: ZenithJoint;
  geo: THREE.BufferGeometry;
  role: PartRole;
  /** The weapon a lit part belongs to. */
  weapon?: ZenithWeapon;
}

/** Shot leaves each gun here, in its joint's space. */
const MUZZLE: Record<ZenithGun, [ZenithJoint, Vec3]> = {
  branlyL: ["branlyLBarrel", [0, 0, -0.42]],
  branlyR: ["branlyRBarrel", [0, 0, -0.42]],
  arc: ["arc", [0, 0, -0.3]],
  bombs: ["bombs", [0, -0.1, 0]],
  mgL: ["mgL", [0, 0.05, -0.21]],
  mgR: ["mgR", [0, 0.05, -0.21]]
};

/** Engine nacelles: where each propeller spins (body space), and which way. */
const PROPS: { at: Vec3; spin: number }[] = [
  { at: [-0.66, -0.12, -0.6], spin: 1 },
  { at: [0.66, -0.12, -0.6], spin: -1 },
  { at: [-0.62, -0.1, 0.45], spin: -1 },
  { at: [0.62, -0.1, 0.45], spin: 1 }
];

/** A propeller's hub, just ahead of its nacelle's mouth. */
const propAt = (at: Vec3): Vec3 => [at[0], at[1], at[2] - 0.02];

const pb = () => new ModelBuilder({ grade: 0.2 });

/** A thin bar from a to c (12 triangles). */
function bar(b: ModelBuilder, a: Vec3, c: Vec3, w: number, hex: number): void {
  const d = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = d.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  b.box(w, len, w, [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], hex, { rot: [e.x, e.y, e.z] });
}

/** A lathe of the envelope's profile (scaled out by `grow`), over the arc of angle `phi0`…`phi0 + len` (0 = straight down, π = the top). */
function envelope(b: ModelBuilder, grow: number, seg: number, phi0: number, len: number, hex: number, z0 = -2, z1 = 2): void {
  const pts = PROFILE.filter(([, z]) => z >= z0 && z <= z1).map(([r, z]) => new THREE.Vector2(r * grow, z));
  if (z0 > -2) pts.unshift(new THREE.Vector2(radiusAt(z0) * grow, z0));
  if (z1 < 2) pts.push(new THREE.Vector2(radiusAt(z1) * grow, z1));
  // (lathe Y → model Z: rotate +90° about X; the lathe's angle 0 then points down)
  b.add(new THREE.LatheGeometry(pts, seg, phi0, len), [0, 0, 0], hex, { rot: [Math.PI / 2, 0, 0] });
}

/** A propeller of `n` blades about its origin, spinning about Z: wood blades with team tips, a brass boss. */
function prop(r: number, n: number, tip: number): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (const [len, off, col] of [[r * 0.68, r * 0.38, WOOD], [r * 0.26, r * 0.85, tip]] as [number, number, number][]) {
      const g = new THREE.BoxGeometry(len, 0.012, r * 0.2);
      g.rotateX(0.35);
      g.translate(off, 0, 0);
      g.rotateY(a);
      g.rotateX(Math.PI / 2);
      b.add(g, [0, 0, 0], col);
    }
  }
  b.cyl(r * 0.14, r * 0.14, 0.05, 6, [0, 0, 0], BRASS, { rot: [Math.PI / 2, 0, 0] });
  return b.build();
}

function buildParts(t: Team): Part[] {
  const out: Part[] = [];
  const add = (joint: ZenithJoint, b: ModelBuilder, role: PartRole = "static", weapon?: ZenithWeapon) => {
    if (!b.empty) out.push({ joint, geo: b.build(), role, weapon });
  };

  // ---- the hull: envelope, team bands, frame, fins
  let b = pb();
  envelope(b, 1, 16, 0, Math.PI * 2, IVORY);
  // the dorsal band, nose to tail, and a thin light edge either side of it
  envelope(b, 1.012, 6, Math.PI - 0.62, 1.24, t.main);
  envelope(b, 1.008, 2, Math.PI - 0.7, 0.08, t.light, -1.45, 1.45);
  envelope(b, 1.008, 2, Math.PI + 0.62, 0.08, t.light, -1.45, 1.45);
  // flank stripes along the waist
  for (const s of [1, -1]) envelope(b, 1.01, 1, s > 0 ? Math.PI / 2 - 0.06 : (3 * Math.PI) / 2 - 0.06, 0.12, t.dark, -1.25, 1.2);
  // the frame's rings: faint darker hoops
  for (const z of [-1.05, -0.5, 0.05, 0.6, 1.05]) {
    const r = radiusAt(z) * 1.006;
    b.add(new THREE.CylinderGeometry(1, 1, 1, 16, 1, true), [0, 0, z], IVORY_D, { rot: [Math.PI / 2, 0, 0], scale: [r, 0.035, r] });
  }
  // the brass nose cap and tail cone
  b.sphere(0.07, [0, 0, -1.56], BRASS, { w: 8, h: 4 });
  b.cone(0.05, 0.12, 6, [0, 0, 1.64], BRASS, { rot: [Math.PI / 2, 0, 0] });
  // cruciform tail fins: team top and sides, dark under; elevator and rudder lines
  const fin: [number, number][] = [[0, 0.85], [0.44, 1.25], [0.46, 1.52], [0.0, 1.6]];
  const B0 = 0.08;
  b.prism(fin.map(([x, z]): [number, number] => [x + B0, z]), 0.03, [0.015, 0, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  b.prism(fin.map(([x, z]): [number, number] => [x + B0, z]), 0.03, [-0.015, 0, 0], t.dark, { rot: [0, 0, -Math.PI / 2] });
  for (const s of [1, -1]) {
    b.prism(fin.map(([x, z]): [number, number] => [s * (x + B0), z]), 0.03, [0, -0.015, 0], t.main);
    // (the elevators and rudder: ivory hinge lines across the fins' trailing edges)
    b.box(0.34, 0.036, 0.02, [s * (B0 + 0.24), 0, 1.44], IVORY);
  }
  b.box(0.036, 0.34, 0.02, [0, B0 + 0.24, 1.44], IVORY);
  add("body", b);

  // ---- the control car and the catwalk
  b = pb();
  b.fuselage([[-1.08, 0.04, -0.36, -0.42], [-1.0, 0.14, -0.34, -0.52], [-0.84, 0.16, -0.34, -0.56], [-0.5, 0.15, -0.36, -0.55], [-0.38, 0.1, -0.38, -0.5]], [0, 0, 0], IVORY, { chamfer: 0.03, edge: 1.2 });
  b.fuselage([[-1.02, 0.145, -0.43, -0.47], [-0.86, 0.165, -0.43, -0.47], [-0.5, 0.155, -0.43, -0.47]], [0, 0, 0], AMBER, { chamfer: 0.01, glow: 0.75 });
  b.box(0.3, 0.012, 0.66, [0, -0.565, -0.71], BRASS);
  b.box(0.3, 0.02, 0.2, [0, -0.345, -0.4], t.main);
  // the searchlights under the bow of the car
  for (const s of [1, -1]) {
    b.cyl(0.03, 0.04, 0.05, 6, [s * 0.09, -0.56, -0.98], METAL_D, { rot: [Math.PI / 2, 0, 0] });
    b.cyl(0.032, 0.032, 0.01, 6, [s * 0.09, -0.56, -1.01], 0xfff2c8, { rot: [Math.PI / 2, 0, 0], glow: 1 });
  }
  // the keel catwalk: a deck under the hull from the car back to the tail, a rail either side
  b.box(0.16, 0.02, 1.25, [0, -0.45, 0.3], WOOD);
  for (const s of [1, -1]) b.box(0.012, 0.012, 1.25, [s * 0.08, -0.41, 0.3], BRASS);
  // the hangar: a box in the belly, its deck lit and painted, the door frame
  b.block(0.42, 0.1, 0.52, [0, -0.47, 0.42], IVORY_D, { bevel: 0.02 });
  b.box(0.3, 0.012, 0.46, [0, -0.505, 0.42], AMBER, { glow: 0.85 });
  b.box(0.08, 0.014, 0.4, [0, -0.5, 0.42], t.main);
  // navigation lamps: brass bodies, amber lenses
  for (const [x, y, z] of [[0.42, 0, -0.7], [-0.42, 0, -0.7], [0, 0.39, 0.85]] as Vec3[]) b.box(0.04, 0.03, 0.04, [x, y, z], AMBER, { glow: 1 });
  add("body", b);

  // ---- engines: outriggers, nacelles with team cowls (the props are rotors)
  b = pb();
  for (const { at } of PROPS) {
    const [x, y, z] = at;
    const sx = Math.sign(x);
    bar(b, [sx * 0.3, -0.24, z + 0.12], [x, y, z + 0.14], 0.03, METAL);
    bar(b, [sx * 0.38, 0.0, z + 0.14], [x, y, z + 0.14], 0.02, METAL_D);
    b.tube(0.075, 0.28, 8, [x, y, z + 0.17], IVORY_D);
    b.tube(0.079, 0.08, 8, [x, y, z + 0.08], t.main);
    b.cone(0.05, 0.07, 6, [x, y, z + 0.34], METAL, { rot: [Math.PI / 2, 0, 0] });
  }
  add("body", b);
  // (one propeller geometry, about its hub, shared by the four: the rig places each at its PROPS point)
  const p = prop(0.2, 4, t.light);
  for (let i = 0; i < PROPS.length; i++) out.push({ joint: "body", geo: p, role: "rotor" });

  // ---- Branly gun pods: a drum turret, a long barrel with copper coils (lit blue while it works)
  for (const side of ["L", "R"] as const) {
    const s = side === "L" ? -1 : 1;
    const turret = `branly${side}` as const;
    b = pb();
    b.drum(0.08, 0.07, 0.08, 8, [0, -0.06, 0], IVORY, { bevel: 0.012 });
    b.cyl(0.085, 0.085, 0.025, 8, [0, -0.005, 0], t.main);
    // (the sponson arm back to the hull)
    bar(b, [0, -0.02, 0.02], [-s * 0.14, 0.05, 0.04], 0.035, METAL);
    add(turret, b);
    b = pb();
    b.tube(0.024, 0.42, 6, [0, 0, -0.2], METAL_D);
    b.box(0.07, 0.06, 0.1, [0, 0, 0.0], METAL);
    for (const z of [-0.12, -0.24]) b.cyl(0.04, 0.04, 0.05, 8, [0, 0, z], COPPER, { rot: [Math.PI / 2, 0, 0] });
    add(`branly${side}Barrel`, b);
    b = pb();
    for (const z of [-0.12, -0.24]) b.cyl(0.046, 0.046, 0.03, 8, [0, 0, z], ARC_BLUE, { rot: [Math.PI / 2, 0, 0], glow: 1 });
    b.sphere(0.018, [0, 0, -0.42], ARC_BLUE, { w: 6, h: 3, glow: 1 });
    add(`branly${side}Barrel`, b, "lit", "branly");
  }

  // ---- the bow arc: a mast out of the nose, two brass discs, the ball (lit blue, or dark)
  b = pb();
  b.tube(0.025, 0.3, 6, [0, 0, -0.12], BRASS);
  for (const z of [-0.08, -0.18]) b.cyl(0.06, 0.06, 0.012, 8, [0, 0, z], COPPER, { rot: [Math.PI / 2, 0, 0] });
  b.sphere(0.052, [0, 0, -0.3], METAL_D, { w: 8, h: 5 });
  add("arc", b);
  b = pb();
  b.sphere(0.058, [0, 0, -0.3], ARC_BLUE, { w: 8, h: 5, glow: 1 });
  add("arc", b, "lit", "arc");

  // ---- the bomb rack aft of the hangar: a cradle, three bombs, its lamp
  b = pb();
  b.box(0.2, 0.025, 0.36, [0, 0, 0], METAL);
  for (const x of [-0.06, 0, 0.06]) {
    b.tube(0.026, 0.18, 6, [x, -0.045, 0.01], METAL_D);
    b.cone(0.026, 0.05, 6, [x, -0.045, -0.105], t.main, { rot: [-Math.PI / 2, 0, 0] });
  }
  add("bombs", b);
  b = pb();
  b.box(0.04, 0.02, 0.04, [0, -0.02, 0.2], AMBER, { glow: 1 });
  add("bombs", b, "lit", "bombs");

  // ---- the machine guns on the back, fore and aft (the coursive's gun platforms): a ring, the gun, a shield
  for (const side of ["L", "R"] as const) {
    b = pb();
    b.cyl(0.07, 0.07, 0.02, 8, [0, 0.0, 0], BRASS);
    b.box(0.045, 0.045, 0.1, [0, 0.04, -0.02], METAL_D);
    b.tube(0.012, 0.16, 5, [0, 0.05, -0.13], METAL_D);
    b.box(0.1, 0.07, 0.01, [0, 0.07, -0.07], IVORY);
    add(side === "L" ? "mgL" : "mgR", b);
  }

  // ---- hangar doors: each hinged at its outer edge, closed flush under the bay
  for (const side of ["L", "R"] as const) {
    const s = side === "L" ? -1 : 1;
    b = pb();
    b.box(0.17, 0.016, 0.48, [-s * 0.085, -0.055, 0], IVORY);
    b.box(0.03, 0.018, 0.48, [-s * 0.02, -0.056, 0], t.main);
    add(side === "L" ? "bayL" : "bayR", b);
  }

  // ---- mooring: a unit-long cable down from each hardpoint (scaled to the ground), a grapnel at its foot
  for (let i = 0; i < 4; i++) {
    b = pb();
    b.box(0.022, 1, 0.022, [0, -0.5, 0], METAL_D);
    add(`cable${i}` as ZenithJoint, b, "cable");
    b = pb();
    b.cyl(0.02, 0.02, 0.2, 6, [0, 0.1, 0], METAL);
    b.box(0.07, 0.03, 0.07, [0, 0.21, 0], BRASS);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + i;
      b.box(0.03, 0.025, 0.14, [Math.sin(a) * 0.06, 0.03, Math.cos(a) * 0.06], METAL, { rot: [0.5, a, 0] });
    }
    add(`anchor${i}` as ZenithJoint, b, "anchor");
  }
  return out;
}

/** The Zénith's colours on side `f`: the République's (§1.1; the red seat takes the bleu horizon variant). */
export function zenithTeam(f: Faction): Team {
  return NATION_TEAMS.republique[f];
}

const partsCache = new Map<string, Part[]>();
function partsOf(t: Team): Part[] {
  const key = `${t.main}/${t.dark}/${t.light}`;
  let p = partsCache.get(key);
  if (!p) partsCache.set(key, (p = buildParts(t)));
  return p;
}

// ----------------------------------------------------------------- rig ---

/** One weapon system as shown: lit (working), and how far its gun hangs dead (0 working … 1 lost). */
export interface ZenithWeaponPose {
  lit: boolean;
  dead: number;
}

/** What the rig is told each frame (render/zenith.ts works it out from the sim). */
export interface ZenithPose {
  /** Frame time, ms (propellers, recoil). */
  dt: number;
  /** Propeller speed (0 stopped … 1 cruising). */
  props: number;
  /** Mooring cables: 0 reeled in … 1 paid out to the ground and anchored. */
  moor: number;
  /** Height of the hardpoints over the ground below them (model units): the cables' full length. */
  drop: number;
  /** Hangar doors: 0 shut … 1 open. */
  bay: number;
  /** The guns' bearing off the bow (rad, three.js: + turns them left). */
  aim: number;
  weapons: Record<ZenithWeapon, ZenithWeaponPose>;
}

export const ZENITH_REST: ZenithPose = {
  dt: 0, props: 0, moor: 0, drop: 1, bay: 0, aim: 0,
  weapons: { branly: { lit: true, dead: 0 }, arc: { lit: true, dead: 0 }, bombs: { lit: true, dead: 0 }, mg: { lit: true, dead: 0 } }
};

const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * One Zénith: `root` to place at its body point (origin on the envelope's
 * axis), turned to its facing (rotation.y = -facing) and scaled by
 * unitScale("zenith"); `j.body` takes the bob, pitch and roll.
 */
export class ZenithRig {
  readonly root = new THREE.Group();
  readonly j = {} as Record<ZenithJoint, THREE.Group>;
  readonly meshes: { mesh: THREE.Mesh; part: Part }[] = [];
  private recoil = Object.fromEntries(ZENITH_GUNS.map((g) => [g, 0])) as Record<ZenithGun, number>;
  private rotors: { hub: THREE.Group; spin: number }[] = [];
  private spin = 0;

  constructor(readonly team: Team, shadows = true) {
    const body = new THREE.Group();
    this.root.add(body);
    this.j.body = body;
    for (const name of JOINTS) {
      const g = new THREE.Group();
      const [parent, at] = AT[name];
      g.position.set(at[0], at[1], at[2]);
      this.j[name] = g;
      (parent ? this.j[parent as ZenithJoint] : body).add(g);
    }
    for (const p of partsOf(team)) {
      const mesh = modelMesh(p.geo, shadows && p.role !== "rotor" && p.role !== "cable");
      if (p.role === "rotor") {
        const { at, spin } = PROPS[this.rotors.length]!;
        const hub = new THREE.Group();
        hub.position.set(...propAt(at));
        hub.add(mesh);
        body.add(hub);
        this.rotors.push({ hub, spin });
      } else this.j[p.joint].add(mesh);
      this.meshes.push({ mesh, part: p });
    }
    this.update(ZENITH_REST);
  }

  /** Kick a gun back (it eases home over ~160 ms). */
  kick(gun: ZenithGun): void {
    this.recoil[gun] = 1;
  }

  /** World point of a joint-space point, into `out`. */
  point(joint: ZenithJoint, at: Vec3, out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.j[joint].localToWorld(out.set(at[0], at[1], at[2]));
  }

  /** Where a gun's shot leaves it (world), into `out`. */
  muzzle(gun: ZenithGun, out: THREE.Vector3): THREE.Vector3 {
    const [joint, at] = MUZZLE[gun];
    return this.point(joint, at, out);
  }

  /** Mooring cable `i`'s hardpoint on the hull, and its anchor's point on the ground (world), into `out`. */
  hardpoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    return this.point(`cable${i}` as ZenithJoint, [0, 0, 0], out);
  }
  anchorPoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    return this.point(`anchor${i}` as ZenithJoint, [0, 0, 0], out);
  }

  /** Pose every part for this frame. */
  update(p: ZenithPose): void {
    const J = this.j;
    const sec = p.dt / 1000;
    const R = this.recoil;
    for (const g of ZENITH_GUNS) R[g] = Math.max(0, R[g] - sec * 6);

    // ---- propellers
    this.spin += sec * (4 + 30 * p.props);
    for (const r of this.rotors) r.hub.rotation.z = this.spin * r.spin;

    // ---- weapons: guns train on the target; lost, they sag and their lamps go out
    const W = p.weapons;
    for (const side of ["L", "R"] as const) {
      const s = side === "L" ? -1 : 1;
      const turret = J[`branly${side}`];
      // (each pod covers its own beam: it won't swing through the hull)
      const yaw = s < 0 ? Math.max(-0.4, Math.min(2.2, p.aim)) : Math.min(0.4, Math.max(-2.2, p.aim));
      turret.rotation.y = yaw * (1 - W.branly.dead);
      const barrel = J[`branly${side}Barrel`];
      const k = R[`branly${side}`];
      barrel.rotation.x = -0.5 * W.branly.dead + 0.05;
      barrel.position.z = AT[`branly${side}Barrel`][1][2] + k * 0.06;
      // (the machine guns stand on the back, fore and aft: they turn all the way round)
      const mg = J[`mg${side}`];
      mg.rotation.y = p.aim * (1 - W.mg.dead);
      mg.rotation.x = -0.6 * W.mg.dead;
      mg.position.z = AT[`mg${side}`][1][2] + R[`mg${side}`] * 0.03;
    }
    J.arc.position.z = AT.arc[1][2] + R.arc * 0.04;
    J.arc.rotation.x = -0.35 * W.arc.dead;
    J.bombs.rotation.set(0.35 * W.bombs.dead, 0, 0.25 * W.bombs.dead);
    J.bombs.position.y = AT.bombs[1][1] - R.bombs * 0.03 - 0.04 * W.bombs.dead;

    // ---- hangar doors swing down and out
    const bay = smooth(0, 1, p.bay);
    J.bayL.rotation.z = bay * 1.45;
    J.bayR.rotation.z = -bay * 1.45;

    // ---- mooring: cables pay out to the ground, the grapnels drop with them and bite
    const pay = smooth(0, 0.8, p.moor);
    for (let i = 0; i < 4; i++) {
      const c = J[`cable${i}` as ZenithJoint];
      const a = J[`anchor${i}` as ZenithJoint];
      const len = Math.max(0.001, p.drop * pay);
      c.scale.set(1, len, 1);
      c.visible = a.visible = pay > 0.01;
      const at = MOOR_POINTS[i]!;
      // (the anchors swing a little until they bite, then sink in)
      const bite = smooth(0.8, 1, p.moor);
      a.position.set(at[0], at[1] - len + 0.04 * bite, at[2]);
      a.rotation.set(0.25 * (1 - bite) * Math.sin(this.spin * 0.1 + i), 0, 0);
    }

    // ---- lamps
    for (const { mesh, part } of this.meshes) if (part.role === "lit") mesh.visible = W[part.weapon!].lit;
  }

  /** Bake the current pose into one geometry in the rig's own space (no rotors, cables or anchors; lamps as shown). */
  bake(): THREE.BufferGeometry {
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    const list: THREE.BufferGeometry[] = [];
    for (const { mesh, part } of this.meshes) {
      if (part.role === "rotor" || part.role === "cable" || part.role === "anchor" || !mesh.visible) continue;
      list.push(mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld)));
    }
    const g = mergeGeometries(list, false)!;
    for (const l of list) l.dispose();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /** Triangles in the whole rig, every part counted (budget §3.4: ≤ 4 000). */
  get triangles(): number {
    let n = 0;
    for (const { part } of this.meshes) n += (part.geo.index ? part.geo.index.count : part.geo.attributes.position!.count) / 3;
    return n;
  }
}

/**
 * The Zénith as a plain model (models.ts BE_UNIT_MODELS): the rig at rest,
 * baked, every weapon lit, its propellers as rotors. Cached per team.
 */
const defs = new Map<string, ModelDef>();
export function zenithModel(t: Team): ModelDef {
  const key = `${t.main}/${t.dark}/${t.light}`;
  let d = defs.get(key);
  if (!d) {
    const rig = new ZenithRig(t, false);
    const geo = partsOf(t).find((x) => x.role === "rotor")!.geo;
    d = {
      hull: rig.bake(), mount: [0, 0, 0], muzzle: MUZZLE.arc[1].map((v, i) => v + AT.arc[1][i]!) as Vec3, height: ZENITH_TOP + 0.6,
      rotors: PROPS.map(({ at, spin }) => ({ geo, at: propAt(at), axis: "z" as const, speed: 30 * spin }))
    };
    defs.set(key, d);
  }
  return d;
}
