import * as THREE from "three";
import type { UnitKind } from "../../../sim/types";
import { ModelBuilder, type Vec3 } from "../builder";
import { AMBER, BRASS, CONDOR_BAY, EXHAUST, light, partB, sided, strut, type ModelDef, type Team } from "../models";

/**
 * The Empire de Carbonie's aircraft (PANACHE-CONCEPTION.md §1.11, WP5c):
 * Gyroptère, Épervier, Vulcain and Titan. Coal, steam and riveted iron:
 * soot-black plate studded with rivets, smokestacks with a red-hot throat,
 * firebox glows, brass only for trim, and the team colour (the nation's
 * burgundy, see models.ts unitDef) laid on the big surfaces seen from above —
 * the boiler's top shell and rotor, the upper wings, the armoured back, the
 * whole gasbag. Same contract as models.ts UNIT_MODELS (origin at the body
 * centre, nose to -Z, rotors, muzzle); the Titan keeps the Condor's
 * (CONDOR_BAY seats and a stern ramp), since it carries squads like it, and a
 * winch at its origin where render/goliath.ts hangs a lifted Gargantua's
 * cables (the carrier's point, 0.08 tile down).
 *
 * From straight above the two dirigibles must not be confused: the Vulcain is
 * a short fat cigar whose team armour is cut into plates by dark riveted
 * bands across it, an iron spine down the middle, two big engine pods and a
 * cruciform iron tail; the Titan is a long whole-team bag strapped lengthwise
 * in iron, four engines on two outrigger beams and a box tail with twin fins.
 *
 * Budget: about the Belle Époque aircraft's (belle/air.ts), at most 3 000
 * triangles a unit, rotors and ramp included (tests/air-emp-zenith.test.ts).
 */

/** Soot-black iron, its plates, and the worn edge where the rivets catch the light. */
const IRON = 0x29231f;
const IRON_M = 0x3d342d;
const IRON_L = 0x6e6153;
const SOOT = 0x120e0c;
const COAL = 0x1f1b18;
/** Copper piping, the leather of a flying cap, varnished wood (propellers), dull brass. */
const COPPER = 0xa65a32;
const LEATHER = 0x4a3020;
const WOOD = 0x6b4628;
const WOOD_L = 0x8f6236;
const BRASS_D = 0xa8843e;
const TYRE = 0x1a1716;
/** A red-hot firebox seen through its grate. */
const EMBER = 0xff5a1e;

/** A straight wire or bar from a to c: a thin box (12 triangles, half a six-sided strut's cost). */
function bar(b: ModelBuilder, a: Vec3, c: Vec3, w: number, hex: number): void {
  const d = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = d.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  b.box(w, len, w, [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], hex, { rot: [e.x, e.y, e.z] });
}

/**
 * An ovoid lying along Z (radius r, scaled sx across, sy up, sz along), its
 * rings square to Z so hoop() bands of the same `seg` sit flush on them.
 * With `top`, only the crest: `top` facets either side of the top facet (a
 * dorsal panel lying exactly over the full ovoid's facets, never through
 * them; the crest is a facet's middle when seg is 10, 14 or 18).
 */
function ovoid(b: ModelBuilder, r: number, s: Vec3, at: Vec3, hex: number, seg: number, rings: number, top?: number): void {
  const step = (Math.PI * 2) / seg;
  const half = top === undefined ? 0 : (top + 0.5) * step;
  const g = top === undefined ? new THREE.SphereGeometry(r, seg, rings) : new THREE.SphereGeometry(r, 2 * top + 1, rings, 1.5 * Math.PI - half, 2 * half);
  // (sphere Y → model Z: its poles become nose and tail)
  b.add(g, at, hex, { rot: [Math.PI / 2, 0, 0], scale: [s[0], s[2], s[1]] });
}

/**
 * A strap running the length of an ovoid (the same r, s, at), at angle `phi`
 * round it (1.5π: the crest; π, 2π: the flanks), `w` radians wide, standing
 * 2 % proud of it so it never sinks between the bag's facets.
 */
function strap(b: ModelBuilder, r: number, s: Vec3, at: Vec3, phi: number, w: number, hex: number, rings: number): void {
  const g = new THREE.SphereGeometry(r * 1.02, 1, rings, phi - w / 2, w, 0.12, Math.PI - 0.24);
  b.add(g, at, hex, { rot: [Math.PI / 2, 0, 0], scale: [s[0], s[2], s[1]] });
}

/** A band round a body lying along Z (an open hoop, no caps): radii rx × ry, `w` long. */
function hoop(b: ModelBuilder, rx: number, ry: number, w: number, at: Vec3, hex: number, seg = 10): void {
  // (started where ovoid()'s rings start, so a band of the same `seg` lies flush on one)
  b.add(new THREE.CylinderGeometry(1, 1, 1, seg, 1, true, 1.5 * Math.PI), at, hex, { rot: [Math.PI / 2, 0, 0], scale: [rx, w, ry] });
}

/** A rivet head `s` across: an octahedron (8 triangles; a box's 12 add up, aircraft carry dozens). */
const rivet = (s: number) => new THREE.OctahedronGeometry(0.62 * s);

/** Rivet heads round an ellipse rx × ry square to Z at `at` (from angle a0 to a1, 0 = the top). */
function rivetRing(b: ModelBuilder, rx: number, ry: number, at: Vec3, n: number, s = 0.012, a0 = 0, a1 = Math.PI * 2): void {
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * (full ? i : i + 0.5)) / n;
    b.add(rivet(s), [at[0] + Math.sin(a) * rx, at[1] + Math.cos(a) * ry, at[2]], IRON_L);
  }
}

/** A row of rivet heads from `a` to `c`. */
function rivets(b: ModelBuilder, a: Vec3, c: Vec3, n: number, s = 0.01): void {
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0.5 : i / (n - 1);
    b.add(rivet(s), [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k], IRON_L);
  }
}

/** A round porthole facing ±X (side `s`): firelit glass in a brass rim. */
function porthole(b: ModelBuilder, at: Vec3, s: number, r = 0.016, glass = AMBER): void {
  b.cyl(r * 1.35, r * 1.35, 0.006, 8, at, BRASS, { rot: [0, 0, Math.PI / 2] });
  b.cyl(r, r, 0.008, 8, [at[0] + s * 0.002, at[1], at[2]], glass, { rot: [0, 0, Math.PI / 2], glow: 0.9 });
}

/**
 * A propeller or rotor of `n` pitched blades `r` long about its origin (XY
 * plane for axis "z", XZ for "y"), blades `hex` with `tip` ends, `width` of r
 * wide, on a riveted iron hub with a brass cap.
 */
function screw(r: number, n: number, axis: "y" | "z", hex: number, tip = hex, width = 0.14): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const blade = (len: number, w: number, off: number, col: number) => {
      const g = new THREE.BoxGeometry(len, 0.008, w);
      g.rotateX(0.3);
      g.translate(off, 0, 0);
      g.rotateY(a);
      if (axis === "z") g.rotateX(Math.PI / 2);
      b.add(g, [0, 0, 0], col);
    };
    // a narrow iron root, the blade, a tip
    blade(r * 0.16, r * width * 0.55, r * 0.17, IRON);
    if (tip === hex) blade(r * 0.76, r * width, r * 0.6, hex);
    else {
      blade(r * 0.56, r * width, r * 0.5, hex);
      blade(r * 0.22, r * width * 1.05, r * 0.88, tip);
    }
  }
  const rot: Vec3 = axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  b.cyl(r * 0.14, r * 0.15, 0.03, 6, [0, 0, 0], IRON_L, { rot });
  b.cone(r * 0.1, 0.03, 6, axis === "z" ? [0, 0, -0.025] : [0, 0.025, 0], BRASS, { rot: axis === "z" ? [-Math.PI / 2, 0, 0] : [0, 0, 0] });
  return b.build();
}

/** A smokestack standing at `at` (its foot): a flared iron flue, a brass band, a soot crown and its glowing throat. */
function stack(b: ModelBuilder, at: Vec3, r: number, h: number): void {
  b.cyl(r, r * 1.15, h, 8, [at[0], at[1] + h / 2, at[2]], IRON);
  b.cyl(r * 1.2, r * 1.2, h * 0.08, 8, [at[0], at[1] + h * 0.35, at[2]], BRASS_D);
  b.cyl(r * 1.55, r * 1.05, h * 0.16, 8, [at[0], at[1] + h * 0.96, at[2]], SOOT);
  b.box(r * 1.9, 0.006, r * 1.9, [at[0], at[1] + h * 1.04 + 0.002, at[2]], EXHAUST, { glow: 1, rot: [0, Math.PI / 8, 0] });
}

/** A spoked wheel turning about X: an iron tyre, `n` spokes, a brass hub. */
function spokedWheel(b: ModelBuilder, at: Vec3, r: number, w: number, n = 6): void {
  b.torus(r * 0.86, r * 0.14, at, TYRE, { rot: [0, Math.PI / 2, 0], scale: [1, 1, w / (r * 0.28)], seg: 12 });
  for (let i = 0; i < n / 2; i++) b.box(w * 0.4, r * 1.6, r * 0.1, at, IRON_L, { rot: [(i * Math.PI * 2) / n, 0, 0] });
  b.cyl(r * 0.24, r * 0.24, w * 1.3, 8, at, BRASS, { rot: [0, 0, Math.PI / 2] });
}

/** An engine pod along Z at `at`: a riveted iron drum, brass rings, a glowing grate behind, a little stack. */
function enginePod(b: ModelBuilder, at: Vec3, r: number, len: number, t: Team, stackH = 0): void {
  const [x, y, z] = at;
  b.tube(r, len, 8, at, IRON_M);
  b.cone(r, r * 1.3, 8, [x, y, z - len / 2 - r * 0.65], IRON, { rot: [-Math.PI / 2, 0, 0] });
  b.tube(r * 1.06, 0.014, 8, [x, y, z + 0.35 * len], BRASS_D);
  b.tube(r * 1.04, len * 0.3, 8, [x, y, z - 0.08 * len], t.main);
  b.cyl(r * 0.8, r * 0.8, 0.006, 8, [x, y, z + len / 2 + 0.002], EMBER, { rot: [Math.PI / 2, 0, 0], glow: 0.9 });
  if (stackH > 0) stack(b, [x, y + r * 0.8, z + len * 0.2], r * 0.28, stackH);
}

/**
 * Gyroptère: a steam autogyro. An oval boiler of an airframe (soot iron, its
 * upper shell in team colour, brass girth bands, riveted seams, firelit
 * portholes), a pilot in an open well behind a brass screen and a coal
 * hopper, a tall stack behind the rotor pylon, a free-turning three-bladed
 * rotor (team blades: a disc of colour from above), an anti-tank cannon
 * slung under the chin with its ammunition drum, a tail boom out to a team
 * fin and tailplane and a pusher screw, a lamp in the nose, landing skids.
 */
export function gyroptere(t: Team): ModelDef {
  const b = partB();
  const S: Vec3 = [0.84, 0.78, 1.6];
  const R = 0.13;
  ovoid(b, R, S, [0, 0, 0], IRON_M, 14, 9);
  ovoid(b, R * 1.03, S, [0, 0, 0], t.main, 14, 9, 3);
  const rx = R * S[0];
  const ry = R * S[1];
  for (const z of [-0.12, 0.07]) {
    const k = Math.sqrt(1 - (z / (R * S[2])) ** 2);
    hoop(b, rx * k + 0.005, ry * k + 0.005, 0.02, [0, 0, z], BRASS, 14);
    rivetRing(b, rx * k + 0.008, ry * k + 0.008, [0, 0, z + 0.016], 14, 0.008);
  }
  // riveted seams down the flanks, firelit portholes, the nose lamp and its brass cap
  for (const s of [1, -1]) {
    rivets(b, [s * rx * 0.99, 0.01, -0.1], [s * rx * 0.99, 0.01, 0.06], 6, 0.008);
    porthole(b, [s * (rx - 0.002), -0.02, -0.03], s, 0.016);
  }
  b.sphere(0.03, [0, -0.005, -R * S[2] + 0.012], BRASS, { w: 8, h: 6 });
  light(b, [0, -0.005, -R * S[2] - 0.012], 0.022);
  // the firebox under the belly, glowing through its grate
  b.box(0.06, 0.012, 0.07, [0, -ry + 0.006, 0.05], EMBER, { glow: 0.9 });
  // the pilot's well and windscreen, his cap and goggles, the coal hopper behind him
  b.block(0.08, 0.02, 0.075, [0, ry - 0.005, -0.1], IRON, { bevel: 0.006 });
  b.torus(0.04, 0.006, [0, ry + 0.005, -0.1], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 12, scale: [1, 0.9, 1] });
  b.sphere(0.024, [0, ry + 0.03, -0.095], LEATHER, { w: 8, h: 5 });
  b.box(0.04, 0.008, 0.01, [0, ry + 0.032, -0.118], BRASS);
  b.box(0.085, 0.04, 0.005, [0, ry + 0.03, -0.145], 0x9cb0b8, { rot: [-0.4, 0, 0], glow: 0.2 });
  b.box(0.09, 0.006, 0.008, [0, ry + 0.05, -0.152], BRASS, { rot: [-0.4, 0, 0] });
  b.block(0.07, 0.035, 0.05, [0, ry + 0.01, 0.07], IRON, { bevel: 0.006 });
  for (const [x, z] of [[-0.015, 0.06], [0.015, 0.075], [0.0, 0.08]] as [number, number][]) b.box(0.022, 0.016, 0.02, [x, ry + 0.032, z], COAL, { rot: [x * 20, z * 10, 0] });
  // the rotor pylon: a mast on four struts, brass collars, the hub drum
  b.cyl(0.012, 0.018, 0.17, 8, [0, 0.17, 0.0], IRON);
  for (const y of [0.13, 0.22]) b.cyl(0.02, 0.02, 0.012, 8, [0, y, 0], BRASS);
  for (const [x, z] of [[0.05, -0.04], [-0.05, -0.04], [0.05, 0.04], [-0.05, 0.04]] as [number, number][]) bar(b, [x, ry - 0.01, z], [0, 0.21, 0], 0.008, IRON_L);
  b.cyl(0.026, 0.022, 0.025, 8, [0, 0.24, 0], IRON_M);
  // the stack behind the pylon, a copper steam pipe forward to the boiler
  stack(b, [0, 0.06, 0.11], 0.02, 0.15);
  strut(b, [0.03, 0.08, 0.1], [0.03, 0.1, 0.02], 0.006, COPPER);
  // the cannon under the chin: a breech, an ammunition drum, a long barrel banded in brass, a muzzle brake
  b.block(0.06, 0.045, 0.1, [0, -0.1, -0.11], IRON, { bevel: 0.01 });
  b.cyl(0.03, 0.03, 0.03, 10, [0.045, -0.1, -0.09], IRON_M, { rot: [0, 0, Math.PI / 2] });
  b.cyl(0.031, 0.031, 0.006, 10, [0.06, -0.1, -0.09], BRASS, { rot: [0, 0, Math.PI / 2] });
  b.tube(0.016, 0.22, 8, [0, -0.11, -0.25], IRON_M);
  for (const z of [-0.18, -0.2]) b.tube(0.021, 0.008, 8, [0, -0.11, z], BRASS);
  b.block(0.04, 0.03, 0.04, [0, -0.11, -0.365], IRON, { bevel: 0.006 });
  // the tail boom, banded; a team fin and tailplane with dark rudders; the pusher screw's bearing and a tail lamp
  b.cyl(0.016, 0.034, 0.32, 8, [0, 0.03, 0.34], IRON, { rot: [Math.PI / 2, 0, 0] });
  for (const z of [0.25, 0.36, 0.46]) b.cyl(0.03 - (z - 0.2) * 0.05, 0.03 - (z - 0.2) * 0.05, 0.01, 8, [0, 0.03, z], BRASS_D, { rot: [Math.PI / 2, 0, 0] });
  b.prism([[0, 0.38], [0.13, 0.43], [0.14, 0.5], [0, 0.5]], 0.01, [0.005, 0.03, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  b.prism([[0.0, 0.5], [0.14, 0.5], [0.14, 0.535], [0.0, 0.535]], 0.011, [0.0055, 0.03, 0], IRON, { rot: [0, 0, Math.PI / 2] });
  for (const s of [1, -1]) {
    b.prism(sided([[0, 0.4], [0.13, 0.44], [0.13, 0.49], [0, 0.5]], s), 0.008, [0, 0.03, 0], t.main);
    b.box(0.006, 0.012, 0.05, [s * 0.13, 0.03, 0.465], IRON_L);
  }
  b.cyl(0.012, 0.012, 0.03, 8, [0, 0.03, 0.51], IRON_M, { rot: [Math.PI / 2, 0, 0] });
  light(b, [0, 0.18, 0.47], 0.016, EXHAUST);
  // landing skids, curled up at the toes, on cross-tubes
  for (const s of [1, -1]) {
    b.box(0.014, 0.012, 0.34, [s * 0.09, -0.16, -0.02], IRON_L);
    bar(b, [s * 0.09, -0.16, -0.19], [s * 0.09, -0.13, -0.23], 0.012, IRON_L);
    bar(b, [s * 0.05, -0.08, -0.08], [s * 0.09, -0.155, -0.1], 0.012, IRON);
    bar(b, [s * 0.05, -0.08, 0.07], [s * 0.09, -0.155, 0.08], 0.012, IRON);
  }
  for (const z of [-0.1, 0.08]) b.box(0.18, 0.008, 0.008, [0, -0.15, z], IRON);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.11, -0.39], height: 0.3,
    rotors: [
      { geo: screw(0.4, 3, "y", t.main, t.light, 0.17), at: [0, 0.255, 0.0], axis: "y", speed: 20 },
      { geo: screw(0.085, 3, "z", WOOD_L, BRASS, 0.2), at: [0, 0.03, 0.535], axis: "z", speed: 50 }
    ]
  };
}

/**
 * Épervier: a squat steam biplane fighter. A short riveted iron barrel of a
 * fuselage with a brass-ringed boiler cowl glowing through its louvres, the
 * upper wing in team colour (the patch seen from above, dark ribs across
 * it), a sooty lower wing, I-struts with crossed bracing wires, the pilot in
 * his cap with a stack right behind him and a coal box, twin machine guns
 * with finned jackets over the cowl, a team tail, two spoked wheels, a
 * two-bladed tractor screw with brass tips.
 */
export function epervier(t: Team): ModelDef {
  const b = partB();
  b.fuselage([[-0.27, 0.06, 0.06, -0.06], [-0.1, 0.065, 0.065, -0.065], [0.12, 0.05, 0.05, -0.05], [0.42, 0.012, 0.03, 0.0]], [0, 0, 0], IRON_M, { chamfer: 0.025, edge: 1.5 });
  // riveted plate seams along the flanks and over the back
  for (const s of [1, -1]) {
    rivets(b, [s * 0.066, 0.035, -0.2], [s * 0.054, 0.03, 0.1], 7, 0.008);
    rivets(b, [s * 0.066, -0.035, -0.2], [s * 0.054, -0.03, 0.1], 7, 0.008);
    b.box(0.004, 0.08, 0.004, [s * 0.066, 0, -0.12], IRON_L);
  }
  // the boiler cowl: an iron drum ringed in brass, its louvres glowing, a grate face with a brass spinner
  b.tube(0.07, 0.07, 12, [0, 0, -0.295], IRON);
  for (const z of [-0.265, -0.325]) b.tube(0.074, 0.012, 12, [0, 0, z], BRASS);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    b.box(0.006, 0.012, 0.035, [Math.sin(a) * 0.071, Math.cos(a) * 0.071, -0.295], EMBER, { rot: [0, 0, -a], glow: 0.9 });
  }
  b.cyl(0.062, 0.062, 0.006, 12, [0, 0, -0.333], SOOT, { rot: [Math.PI / 2, 0, 0] });
  for (const y of [-0.03, 0, 0.03]) b.box(0.1, 0.006, 0.004, [0, y, -0.337], EMBER, { glow: 0.6 });
  // exhaust stubs down both sides of the cowl
  for (const s of [1, -1]) for (const z of [-0.25, -0.22]) b.cyl(0.008, 0.01, 0.04, 6, [s * 0.072, -0.02, z], SOOT, { rot: [0, 0, s * 1.2] });
  // the wings: a team upper plane over a sooty lower one, rounded tips, a little sweep
  const wing: [number, number][] = [[0, -0.2], [0.4, -0.19], [0.45, -0.16], [0.45, -0.06], [0.41, -0.035], [0, -0.04]];
  const low: [number, number][] = [[0, -0.17], [0.37, -0.165], [0.4, -0.13], [0.4, -0.05], [0.37, -0.03], [0, -0.03]];
  for (const s of [1, -1]) {
    b.prism(sided(wing, s), 0.012, [0, 0.14, 0], t.main);
    b.prism(sided(low, s), 0.01, [0, -0.06, 0], IRON);
    // ribs over the top of both planes, the leading-edge spar, aileron hinges
    for (const x of [0.08, 0.16, 0.24, 0.32, 0.4]) {
      b.box(0.006, 0.004, 0.15, [s * x, 0.153, -0.115], t.dark);
      if (x < 0.36) b.box(0.005, 0.004, 0.13, [s * x, -0.048, -0.1], IRON_L);
    }
    b.box(0.44, 0.008, 0.01, [s * 0.22, 0.152, -0.195], IRON_M);
    b.box(0.16, 0.004, 0.006, [s * 0.34, 0.153, -0.055], t.dark);
    // I-struts, crossed wires between them, the cabane down to the fuselage
    for (const z of [-0.15, -0.06]) bar(b, [s * 0.3, -0.05, z], [s * 0.31, 0.14, z - 0.01], 0.012, IRON_L);
    bar(b, [s * 0.3, -0.05, -0.15], [s * 0.31, 0.14, -0.07], 0.004, IRON);
    bar(b, [s * 0.3, -0.05, -0.06], [s * 0.31, 0.14, -0.16], 0.004, IRON);
    bar(b, [s * 0.05, -0.05, -0.1], [s * 0.3, 0.14, -0.11], 0.003, IRON);
    bar(b, [s * 0.03, 0.05, -0.17], [s * 0.05, 0.14, -0.17], 0.01, IRON_L);
    bar(b, [s * 0.03, 0.05, -0.07], [s * 0.05, 0.14, -0.07], 0.01, IRON_L);
    light(b, [s * 0.455, 0.15, -0.11], 0.02);
  }
  // the pilot behind the wing: a brass coaming, his cap and goggles; the stack and the coal box at his back
  b.torus(0.04, 0.006, [0, 0.055, 0.04], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 12, scale: [1, 1.2, 1] });
  b.sphere(0.024, [0, 0.08, 0.04], LEATHER, { w: 8, h: 5 });
  b.box(0.04, 0.008, 0.01, [0, 0.082, 0.017], BRASS);
  b.box(0.012, 0.012, 0.05, [0.02, 0.064, 0.07], t.light);
  b.box(0.07, 0.03, 0.006, [0, 0.075, -0.005], 0x9cb0b8, { rot: [-0.5, 0, 0], glow: 0.2 });
  stack(b, [0, 0.05, 0.1], 0.02, 0.13);
  b.block(0.07, 0.03, 0.05, [0, 0.055, 0.16], IRON, { bevel: 0.005 });
  for (const [x, z] of [[-0.015, 0.155], [0.015, 0.165]] as [number, number][]) b.box(0.022, 0.014, 0.02, [x, 0.074, z], COAL, { rot: [x * 30, 0.4, 0] });
  // twin machine guns over the cowl: receivers, finned jackets, flash hiders
  for (const s of [1, -1]) {
    b.block(0.024, 0.026, 0.07, [s * 0.025, 0.075, -0.2], IRON, { bevel: 0.004 });
    b.tube(0.007, 0.13, 6, [s * 0.025, 0.077, -0.29], IRON_L);
    for (const z of [-0.25, -0.27, -0.29, -0.31]) b.tube(0.011, 0.005, 8, [s * 0.025, 0.077, z], BRASS);
    b.tube(0.01, 0.015, 6, [s * 0.025, 0.077, -0.355], SOOT);
  }
  // a team tail: tailplane and fin, dark elevators and rudder, a tail lamp
  for (const s of [1, -1]) {
    b.prism(sided([[0, 0.32], [0.15, 0.35], [0.15, 0.41], [0, 0.43]], s), 0.008, [0, 0.022, 0], t.main);
    b.prism(sided([[0, 0.43], [0.15, 0.41], [0.13, 0.45], [0, 0.46]], s), 0.007, [0, 0.022, 0], IRON);
  }
  b.prism([[0, 0.3], [0.11, 0.37], [0.12, 0.44], [0, 0.44]], 0.01, [0.005, 0.02, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  b.prism([[0, 0.44], [0.12, 0.44], [0.1, 0.48], [0, 0.47]], 0.011, [0.0055, 0.02, 0], IRON, { rot: [0, 0, Math.PI / 2] });
  light(b, [0, 0.145, 0.44], 0.014, EXHAUST);
  // the undercarriage: two spoked iron wheels on a vee and an axle, a tail skid
  for (const s of [1, -1]) {
    bar(b, [s * 0.03, -0.06, -0.22], [s * 0.08, -0.15, -0.17], 0.01, IRON);
    bar(b, [s * 0.03, -0.06, -0.12], [s * 0.08, -0.15, -0.17], 0.01, IRON);
    spokedWheel(b, [s * 0.09, -0.15, -0.17], 0.045, 0.018, 6);
  }
  b.cyl(0.006, 0.006, 0.18, 6, [0, -0.15, -0.17], IRON, { rot: [0, 0, Math.PI / 2] });
  bar(b, [0, -0.01, 0.36], [0, -0.06, 0.42], 0.01, IRON);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.077, -0.37], height: 0.2,
    rotors: [{ geo: screw(0.15, 2, "z", WOOD, BRASS, 0.18), at: [0, 0, -0.345], axis: "z", speed: 60 }]
  };
}

/**
 * Vulcain: a short, armoured bombing dirigible. A fat cigar of a gasbag whose
 * back is armour in team colour, cut into plates by dark riveted iron bands
 * across it and an iron spine down the middle, a sooty ram nose; a dorsal
 * gun cupola; a heavy armoured gondola with glowing gun slits, firelit
 * portholes and a stack belching coal smoke, its bomb bay open with a rack
 * of bombs (team noses); two big engine pods on stub pylons with pusher
 * screws; a cruciform iron tail, the top fin team.
 */
export function vulcain(t: Team): ModelDef {
  const b = partB();
  const S: Vec3 = [1.05, 0.88, 1.75];
  const R = 0.2;
  const L = R * S[2];
  ovoid(b, R, S, [0, 0, 0], IRON_M, 14, 10);
  ovoid(b, R * 1.02, S, [0, 0, 0], t.main, 14, 10, 1);
  // the armour bands across the back: iron hoops, rivet rows on them
  for (const z of [-0.2, -0.07, 0.06, 0.19]) {
    const k = Math.sqrt(1 - (z / L) ** 2);
    hoop(b, R * S[0] * k * 1.045, R * S[1] * k * 1.045, 0.026, [0, 0, z], IRON, 14);
    rivetRing(b, R * S[0] * k * 1.06, R * S[1] * k * 1.06, [0, 0, z], 6, 0.011, -1.3, 1.3);
  }
  // the spine: an iron ridge down the crest, riveted
  b.box(0.04, 0.022, 0.52, [0, R * S[1] * 1.02, 0.0], IRON);
  rivets(b, [0, R * S[1] * 1.02 + 0.012, -0.22], [0, R * S[1] * 1.02 + 0.012, 0.22], 5, 0.01);
  // the ram nose: a soot cap, a brass collar, an iron spike
  b.sphere(0.07, [0, 0, -L + 0.04], SOOT, { w: 10, h: 6, scale: [1, 0.9, 1] });
  b.tube(0.073, 0.016, 10, [0, 0, -L + 0.07], BRASS);
  b.cone(0.02, 0.07, 6, [0, 0, -L - 0.04], IRON_L, { rot: [-Math.PI / 2, 0, 0] });
  light(b, [0.05, -0.04, -L + 0.03], 0.02);
  light(b, [-0.05, -0.04, -L + 0.03], 0.02);
  // a dorsal cupola forward: a brass drum, a team cap, a short gun
  b.drum(0.045, 0.04, 0.035, 10, [0, R * S[1] + 0.02, -0.17], BRASS, { bevel: 0.006 });
  b.cyl(0.036, 0.04, 0.012, 10, [0, R * S[1] + 0.045, -0.17], t.main);
  b.tube(0.008, 0.08, 6, [0, R * S[1] + 0.03, -0.23], IRON);
  // the armoured gondola: plate, rivets, gun slits, portholes, a prow, the stack
  b.block(0.16, 0.085, 0.36, [0, -0.25, -0.02], IRON, { bevel: 0.015, edge: 1.6 });
  b.prism([[-0.08, -0.2], [0.08, -0.2], [0, -0.28]], 0.07, [0, -0.285, 0], IRON_M);
  for (const s of [1, -1]) {
    b.box(0.004, 0.014, 0.2, [s * 0.082, -0.22, -0.04], EXHAUST, { glow: 0.9 });
    for (const z of [-0.08, 0.06]) porthole(b, [s * 0.081, -0.265, z], s, 0.013);
    rivets(b, [s * 0.082, -0.288, -0.17], [s * 0.082, -0.288, 0.14], 5, 0.008);
    rivets(b, [s * 0.082, -0.2, -0.17], [s * 0.082, -0.2, 0.14], 5, 0.008);
    for (const z of [-0.12, 0.08]) bar(b, [s * 0.06, -0.21, z], [s * 0.12, -0.13, z], 0.014, IRON_L);
  }
  stack(b, [0, -0.21, 0.1], 0.024, 0.1);
  // the bomb bay under it: a rack of four bombs, team noses, brass fins
  b.box(0.12, 0.012, 0.22, [0, -0.3, 0.0], IRON_M);
  for (const x of [-0.035, 0.035])
    for (const z of [-0.05, 0.07]) {
      b.tube(0.02, 0.09, 6, [x, -0.33, z], IRON);
      b.cone(0.02, 0.035, 6, [x, -0.33, z - 0.062], t.main, { rot: [-Math.PI / 2, 0, 0] });
      b.box(0.045, 0.004, 0.014, [x, -0.33, z + 0.05], BRASS);
      b.box(0.004, 0.045, 0.014, [x, -0.33, z + 0.05], BRASS);
    }
  // the engine pods on stub pylons, pusher screws behind
  const props: Vec3[] = [];
  for (const s of [1, -1]) {
    const x = s * 0.31;
    b.block(0.2, 0.025, 0.08, [s * 0.2, -0.08, 0.06], IRON, { bevel: 0.006 });
    bar(b, [s * 0.15, -0.16, 0.04], [x, -0.1, 0.06], 0.014, IRON_L);
    enginePod(b, [x, -0.08, 0.06], 0.045, 0.18, t, 0.07);
    light(b, [x, -0.08, -0.07], 0.018);
    props.push([x, -0.08, 0.165]);
  }
  // cruciform fins: iron, the top one team, brass-edged
  b.prism([[0, 0.22], [0.15, 0.29], [0.17, 0.4], [0, 0.4]], 0.012, [0.006, 0.09, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  b.prism([[0, 0.22], [0.12, 0.29], [0.13, 0.4], [0, 0.4]], 0.012, [-0.006, -0.09, 0], IRON, { rot: [0, 0, -Math.PI / 2] });
  b.box(0.016, 0.012, 0.11, [0, 0.25, 0.345], BRASS);
  for (const s of [1, -1]) {
    b.prism(sided([[0.1, 0.23], [0.28, 0.3], [0.28, 0.4], [0.1, 0.4]], s), 0.012, [0, -0.006, 0], IRON);
    b.box(0.012, 0.016, 0.1, [s * 0.28, 0, 0.35], BRASS);
    light(b, [s * 0.285, 0, 0.4], 0.014, EXHAUST);
  }
  const prop = screw(0.1, 3, "z", IRON_L, t.main, 0.2);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.36, 0], height: 0.4,
    rotors: props.map((at, i) => ({ geo: prop, at, axis: "z" as const, speed: i ? -36 : 36 }))
  };
}

/**
 * Titan: a long, pot-bellied armoured cargo dirigible. The whole gasbag in
 * team colour strapped lengthwise in iron, a sooty nose cap and a riveted
 * tail cone, a box tail with twin iron fins; slung below on wires, the cargo
 * gondola is the Condor's troop bay (CONDOR_BAY: deck, benches, plated
 * walls, the stern ramp as gangway) with a riveted prow, portholes and lamps.
 * A steam winch stands amidships at its origin and its lifting hook hangs
 * under the keel: two Titans hoist a Gargantua (render/goliath.ts runs its
 * cables up to the carrier's point, just below the origin: into the winch).
 * Two outrigger beams carry four engines with tractor screws; a stack vents
 * coal smoke off the prow.
 */
export function titan(t: Team): ModelDef {
  const b = partB();
  const B = CONDOR_BAY;
  const Y = 0.44;
  const S: Vec3 = [1, 0.88, 2.3];
  const R = 0.26;
  const Z = -0.04;
  const L = R * S[2];
  const C: Vec3 = [0, Y, Z];
  ovoid(b, R, S, C, t.main, 14, 10);
  // the iron straps the length of the bag: one down the crest, two over the shoulders, one a flank
  for (const phi of [1.5 * Math.PI, 1.5 * Math.PI - 0.95, 1.5 * Math.PI + 0.95, Math.PI, 2 * Math.PI]) strap(b, R, S, C, phi, 0.1, IRON, 10);
  // rivets down the crest strap
  for (let i = 0; i < 5; i++) {
    const z = -0.36 + i * 0.17;
    const k = Math.sqrt(Math.max(0, 1 - ((z - Z) / L) ** 2));
    b.box(0.012, 0.012, 0.012, [0, Y + R * S[1] * k * 1.035, z], IRON_L);
  }
  // the nose cap and tail cone
  b.sphere(0.075, [0, Y, Z - L + 0.05], SOOT, { w: 10, h: 6 });
  b.tube(0.081, 0.016, 10, [0, Y, Z - L + 0.07], BRASS);
  b.cone(0.07, 0.1, 10, [0, Y, Z + L + 0.02], IRON, { rot: [Math.PI / 2, 0, 0] });
  // the box tail: a team tailplane between twin iron fins with brass edges, a ventral fin
  b.prism([[-0.26, 0.42], [0.26, 0.42], [0.26, 0.6], [-0.26, 0.6]], 0.014, [0, Y - 0.007, 0], t.main);
  for (const s of [1, -1]) {
    b.prism([[-0.07, 0.4], [0.14, 0.45], [0.16, 0.62], [-0.08, 0.62]], 0.014, [s * 0.26 + 0.007, Y, 0], IRON, { rot: [0, 0, Math.PI / 2] });
    b.box(0.018, 0.24, 0.012, [s * 0.26, Y + 0.04, 0.625], BRASS);
    bar(b, [s * 0.12, Y - 0.06, 0.4], [s * 0.26, Y, 0.45], 0.01, IRON_L);
    light(b, [s * 0.26, Y + 0.17, 0.62], 0.016, EXHAUST);
  }
  b.prism([[0, 0.38], [0.11, 0.46], [0.12, 0.6], [0, 0.6]], 0.014, [-0.007, Y - 0.1, 0], IRON, { rot: [0, 0, -Math.PI / 2] });
  // the cargo gondola round the bay: a riveted prow, plated walls, deck and benches
  const W = B.w / 2 + 0.03;
  b.fuselage([[-0.5, 0.03, 0.02, -0.08], [-0.42, 0.13, 0.02, -0.17], [B.z0, W, 0.02, -0.19]], [0, 0, 0], IRON_M, { chamfer: 0.03, edge: 1.5 });
  // (its top is the deck, at CONDOR_BAY.floor)
  b.box(2 * W, 0.09, B.ramp - B.z0, [0, -0.145, (B.z0 + B.ramp) / 2], IRON_M);
  for (const s of [1, -1]) {
    b.box(0.03, B.wall - B.floor + 0.02, B.ramp - B.z0, [s * (B.w / 2 + 0.015), (B.wall + B.floor) / 2 + 0.01, (B.z0 + B.ramp) / 2], IRON_M);
    b.box(0.034, B.bench - B.floor, B.z1 - B.z0 - 0.02, [s * (B.w / 2 - 0.017), (B.bench + B.floor) / 2, (B.z0 + B.z1) / 2], COPPER);
    // a team gunwale, rivets along the walls, portholes in the prow
    b.box(0.04, 0.014, B.ramp - B.z0 + 0.01, [s * (B.w / 2 + 0.015), B.wall + 0.027, (B.z0 + B.ramp) / 2], t.main);
    rivets(b, [s * (W + 0.001), -0.06, B.z0 + 0.02], [s * (W + 0.001), -0.06, B.ramp - 0.02], 6, 0.01);
    rivets(b, [s * (W + 0.001), -0.15, B.z0 + 0.02], [s * (W + 0.001), -0.15, B.ramp - 0.02], 6, 0.01);
    porthole(b, [s * 0.15, -0.08, -0.37], s, 0.016);
    for (const z of [B.z0 + 0.06, B.z1 - 0.04]) light(b, [s * (W + 0.006), B.wall - 0.02, z], 0.014);
    // the wires up to the gasbag
    bar(b, [s * W, B.wall, -0.36], [s * 0.15, Y - 0.17, -0.34], 0.008, IRON_L);
    bar(b, [s * W, B.wall, 0.3], [s * 0.15, Y - 0.17, 0.26], 0.008, IRON_L);
    bar(b, [s * W, B.wall, -0.04], [s * 0.2, Y - 0.14, -0.04], 0.008, IRON_L);
  }
  light(b, [0, -0.05, -0.5], 0.022);
  // the coal bunker on the foredeck, heaped
  b.block(0.16, 0.05, 0.08, [0, 0.045, -0.4], IRON, { bevel: 0.008 });
  for (const [x, z] of [[-0.03, -0.4], [0.03, -0.405]] as [number, number][]) b.box(0.035, 0.02, 0.03, [x, 0.075, z], COAL, { rot: [x * 20, z * 8, 0] });
  // the winch amidships (the lift cables run into its drum), brass flanges, a firebox; the hook under the keel
  b.cyl(0.04, 0.04, 0.1, 10, [0, -0.055, 0.0], COPPER, { rot: [0, 0, Math.PI / 2] });
  for (const s of [1, -1]) b.cyl(0.052, 0.052, 0.01, 8, [s * 0.055, -0.055, 0.0], BRASS, { rot: [0, 0, Math.PI / 2] });
  b.box(0.012, 0.13, 0.012, [0, -0.13, 0.0], IRON);
  b.box(0.03, 0.07, 0.012, [0, -0.225, 0.0], IRON_L, { rot: [0, 0, 0.5] });
  b.torus(0.022, 0.006, [0, -0.27, 0.0], IRON_L, { seg: 8, rot: [0, Math.PI / 2, 0] });
  // the stack venting off the prow; two outrigger beams, four engines with tractor screws
  stack(b, [0, 0.02, -0.38], 0.022, 0.14);
  const props: Vec3[] = [];
  for (const z of [-0.2, 0.18]) {
    b.box(0.84, 0.03, 0.036, [0, -0.06, z], IRON);
    for (const s of [1, -1]) {
      const x = s * 0.42;
      bar(b, [s * W, B.wall, z], [s * 0.36, -0.06, z], 0.008, IRON_L);
      enginePod(b, [x, -0.06, z], 0.048, 0.16, t);
      props.push([x, -0.06, z - 0.15]);
    }
  }
  const hull = b.build();
  // the ramp: an iron gangway hinged at the deck's stern edge (closed: it stands up, a team plate outside, riveted)
  const RL = B.wall + 0.02 - B.floor;
  const r = partB();
  r.box(B.rampW - 0.004, RL, 0.02, [0, RL / 2, 0], IRON_M);
  r.box(B.rampW - 0.06, RL * 0.62, 0.004, [0, RL * 0.5, 0.011], t.main);
  for (let i = 0; i < 3; i++) r.box(B.rampW - 0.06, 0.006, 0.008, [0, 0.02 + i * 0.03, -0.013], IRON_L);
  for (const sx of [-1, 1]) r.box(0.01, RL, 0.012, [sx * (B.rampW / 2 - 0.01), RL / 2, 0.012], BRASS_D);
  const prop = screw(0.12, 2, "z", WOOD, BRASS, 0.2);
  return {
    hull, mount: [0, 0, 0], muzzle: [0, -0.1, 0], height: 0.72,
    rotors: props.map((at, i) => ({ geo: prop, at, axis: "z" as const, speed: i % 2 ? -38 : 38 })),
    ramp: { geo: r.build(), hinge: [0, B.floor, B.ramp], open: 1.85, tip: [0, RL, 0] }
  };
}

export const AIR_EMP: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  gyroptere,
  epervier,
  vulcain,
  titan
};
