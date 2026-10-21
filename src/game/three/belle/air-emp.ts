import * as THREE from "three";
import type { UnitKind } from "../../../sim/types";
import { ModelBuilder, type Vec3 } from "../builder";
import { BRASS, CONDOR_BAY, EXHAUST, light, partB, sided, type ModelDef, type Team } from "../models";

/**
 * The Empire de Carbonie's aircraft (PANACHE-CONCEPTION.md §1.11, WP5c):
 * Gyroptère, Épervier, Vulcain and Titan. Coal, steam and riveted iron:
 * soot-black plate, smokestacks with a glowing throat, brass only for trim,
 * and the team colour (the nation's burgundy, see models.ts unitDef) laid on
 * the big surfaces seen from above — the boiler's top shell, the upper wings,
 * the armoured back, the whole gasbag. Same contract as models.ts
 * UNIT_MODELS (origin at the body centre, nose to -Z, rotors, muzzle); the
 * Titan keeps the Condor's (CONDOR_BAY seats and a stern ramp), since it
 * carries squads like it, and a winch at its origin where render/goliath.ts
 * hangs a lifted Gargantua's cables (the carrier's point, 0.08 tile down).
 *
 * Budget (§3.4): at most 600 triangles a unit, rotors and ramp included —
 * hence low segment counts, flat-sided prisms and box wires.
 */

/** Soot-black iron, its plates, and the worn edge where the rivets catch the light. */
const IRON = 0x29231f;
const IRON_M = 0x3d342d;
const IRON_L = 0x6e6153;
/** Copper piping and the leather of a flying cap. */
const COPPER = 0xa65a32;
const LEATHER = 0x4a3020;

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
 * dorsal panel lying exactly over the full ovoid's facets, never through them).
 */
function ovoid(b: ModelBuilder, r: number, s: Vec3, at: Vec3, hex: number, seg: number, rings: number, top?: number): void {
  const step = (Math.PI * 2) / seg;
  const half = top === undefined ? 0 : (top + 0.5) * step;
  const g = top === undefined ? new THREE.SphereGeometry(r, seg, rings) : new THREE.SphereGeometry(r, 2 * top + 1, rings, 1.5 * Math.PI - half, 2 * half);
  // (sphere Y → model Z: its poles become nose and tail; the crest, angle 1.5π, a facet's middle when seg is 10)
  b.add(g, at, hex, { rot: [Math.PI / 2, 0, 0], scale: [s[0], s[2], s[1]] });
}

/** A band round a body lying along Z (an open hoop, no caps): radii rx × ry, `w` long. */
function hoop(b: ModelBuilder, rx: number, ry: number, w: number, at: Vec3, hex: number, seg = 10): void {
  // (started where ovoid()'s rings start, so a band of the same `seg` lies flush on one)
  b.add(new THREE.CylinderGeometry(1, 1, 1, seg, 1, true, 1.5 * Math.PI), at, hex, { rot: [Math.PI / 2, 0, 0], scale: [rx, w, ry] });
}

/**
 * A propeller or rotor of `n` flat blades `r` long about its origin (XY
 * plane for axis "z", XZ for "y"), blades `hex` with `tip` ends, iron hub.
 */
function screw(r: number, n: number, axis: "y" | "z", hex: number, tip = hex, width = 0.14): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const blade = (len: number, off: number, col: number) => {
      const g = new THREE.BoxGeometry(len, 0.008, r * width);
      g.rotateX(0.3);
      g.translate(off, 0, 0);
      g.rotateY(a);
      if (axis === "z") g.rotateX(Math.PI / 2);
      b.add(g, [0, 0, 0], col);
    };
    if (tip === hex) blade(r * 0.92, r * 0.5, hex);
    else {
      blade(r * 0.66, r * 0.37, hex);
      blade(r * 0.28, r * 0.84, tip);
    }
  }
  b.cyl(r * 0.13, r * 0.13, 0.03, 6, [0, 0, 0], IRON_L, { rot: axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0] });
  return b.build();
}

/** A smokestack standing at `at` (its foot): a flared iron flue, the throat glowing. */
function stack(b: ModelBuilder, at: Vec3, r: number, h: number): void {
  b.cyl(r * 1.3, r, h, 6, [at[0], at[1] + h / 2, at[2]], IRON);
  b.box(r * 1.6, 0.004, r * 1.6, [at[0], at[1] + h + 0.002, at[2]], EXHAUST, { glow: 1 });
}

/**
 * Gyroptère: a steam autogyro. An oval boiler of an airframe (soot iron, its
 * upper shell in team colour, a brass girth band), a pilot in an open well
 * behind a brass screen, a smokestack behind the rotor mast, a free-turning
 * three-bladed rotor (team blades: a disc of colour from above), an anti-tank
 * cannon slung under the chin, a tail boom out to a team fin and a pusher
 * screw, and a pair of landing skids.
 */
export function gyroptere(t: Team): ModelDef {
  const b = partB();
  const S: Vec3 = [0.84, 0.78, 1.6];
  const R = 0.13;
  ovoid(b, R, S, [0, 0, 0], IRON_M, 10, 6);
  ovoid(b, R * 1.03, S, [0, 0, 0], t.main, 10, 6, 2);
  hoop(b, R * S[0] + 0.004, R * S[1] + 0.004, 0.022, [0, 0, -0.07], BRASS);
  // the pilot's well and windscreen, his cap showing
  b.box(0.07, 0.03, 0.06, [0, 0.095, -0.1], IRON);
  b.sphere(0.022, [0, 0.12, -0.095], LEATHER, { w: 5, h: 3 });
  b.box(0.08, 0.035, 0.006, [0, 0.122, -0.14], BRASS, { rot: [-0.4, 0, 0] });
  // the rotor mast and the stack behind it
  b.cyl(0.013, 0.02, 0.15, 6, [0, 0.165, 0.0], IRON);
  stack(b, [0, 0.07, 0.11], 0.02, 0.12);
  // the cannon under the chin: a mounting block, a long barrel, a muzzle brake
  b.box(0.05, 0.04, 0.08, [0, -0.1, -0.12], IRON);
  b.tube(0.017, 0.22, 6, [0, -0.115, -0.24], IRON);
  // the tail boom, a team fin and tailplane, the pusher screw's bearing
  b.cyl(0.016, 0.03, 0.32, 6, [0, 0.03, 0.34], IRON, { rot: [Math.PI / 2, 0, 0] });
  b.prism([[0, 0.38], [0.13, 0.43], [0.14, 0.53], [0, 0.53]], 0.01, [0.005, 0.03, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  b.prism(sided([[0, 0.4], [0.12, 0.44], [0.12, 0.49], [0, 0.5]], 1), 0.008, [0, 0.03, 0], t.main);
  b.prism(sided([[0, 0.4], [0.12, 0.44], [0.12, 0.49], [0, 0.5]], -1), 0.008, [0, 0.03, 0], t.main);
  // landing skids
  for (const s of [1, -1]) {
    b.box(0.014, 0.012, 0.36, [s * 0.09, -0.16, -0.02], IRON_L);
    bar(b, [s * 0.05, -0.08, -0.08], [s * 0.09, -0.155, -0.1], 0.012, IRON);
    bar(b, [s * 0.05, -0.08, 0.07], [s * 0.09, -0.155, 0.08], 0.012, IRON);
  }
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.115, -0.37], height: 0.3,
    rotors: [
      { geo: screw(0.4, 3, "y", t.dark, t.main, 0.16), at: [0, 0.245, 0.0], axis: "y", speed: 20 },
      { geo: screw(0.08, 2, "z", IRON_L), at: [0, 0.03, 0.53], axis: "z", speed: 50 }
    ]
  };
}

/**
 * Épervier: a squat steam biplane fighter. A short iron barrel of a fuselage
 * with a brass-ringed boiler cowl, the upper wing in team colour (the patch
 * seen from above, dark spars across it), a sooty lower wing, interplane
 * struts, the pilot in his cap with a smokestack right behind him, twin
 * machine guns over the cowl, a team tail, a two-bladed tractor screw.
 */
export function epervier(t: Team): ModelDef {
  const b = partB();
  b.fuselage([[-0.27, 0.06, 0.06, -0.06], [-0.1, 0.065, 0.065, -0.065], [0.12, 0.05, 0.05, -0.05], [0.42, 0.012, 0.03, 0.0]], [0, 0, 0], IRON_M, { chamfer: 0.025, edge: 1.5 });
  b.tube(0.066, 0.06, 8, [0, 0, -0.29], IRON);
  hoop(b, 0.069, 0.069, 0.014, [0, 0, -0.31], BRASS, 8);
  // the wings: a team upper plane over a sooty lower one, rounded tips, a little sweep
  const wing: [number, number][] = [[0, -0.2], [0.4, -0.19], [0.45, -0.16], [0.45, -0.06], [0.41, -0.035], [0, -0.04]];
  b.prism(sided(wing, 1), 0.012, [0, 0.14, 0], t.main);
  b.prism(sided(wing, -1), 0.012, [0, 0.14, 0], t.main);
  for (const z of [-0.17, -0.07]) b.box(0.86, 0.006, 0.012, [0, 0.153, z], t.dark);
  const low: [number, number][] = [[0, -0.17], [0.37, -0.165], [0.4, -0.13], [0.4, -0.05], [0.37, -0.03], [0, -0.03]];
  b.prism(sided(low, 1), 0.01, [0, -0.06, 0], IRON);
  b.prism(sided(low, -1), 0.01, [0, -0.06, 0], IRON);
  for (const s of [1, -1]) {
    bar(b, [s * 0.3, -0.05, -0.14], [s * 0.31, 0.14, -0.15], 0.012, IRON_L);
    bar(b, [s * 0.3, -0.05, -0.05], [s * 0.31, 0.14, -0.06], 0.012, IRON_L);
    light(b, [s * 0.44, 0.15, -0.11], 0.02);
  }
  // the pilot behind the wing, and the stack at his back
  b.sphere(0.024, [0, 0.08, 0.04], LEATHER, { w: 6, h: 3 });
  b.box(0.07, 0.008, 0.02, [0, 0.075, 0.0], BRASS, { rot: [-0.5, 0, 0] });
  stack(b, [0, 0.05, 0.1], 0.02, 0.12);
  // twin machine guns over the cowl
  for (const s of [1, -1]) {
    b.box(0.022, 0.024, 0.06, [s * 0.025, 0.075, -0.2], IRON);
    b.tube(0.007, 0.12, 5, [s * 0.025, 0.077, -0.28], IRON_L);
  }
  // a team tail: tailplane and fin
  b.prism(sided([[0, 0.32], [0.15, 0.35], [0.15, 0.41], [0, 0.43]], 1), 0.008, [0, 0.022, 0], t.main);
  b.prism(sided([[0, 0.32], [0.15, 0.35], [0.15, 0.41], [0, 0.43]], -1), 0.008, [0, 0.022, 0], t.main);
  b.prism([[0, 0.3], [0.11, 0.37], [0.12, 0.44], [0, 0.44]], 0.01, [0.005, 0.02, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  // the undercarriage: two spoked iron wheels on a vee, a tail skid
  for (const s of [1, -1]) {
    bar(b, [s * 0.03, -0.06, -0.2], [s * 0.08, -0.14, -0.17], 0.012, IRON);
    b.cyl(0.04, 0.04, 0.016, 6, [s * 0.085, -0.15, -0.17], IRON, { rot: [0, 0, Math.PI / 2] });
  }
  bar(b, [0, -0.01, 0.36], [0, -0.06, 0.42], 0.01, IRON);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.077, -0.35], height: 0.2,
    rotors: [{ geo: screw(0.15, 2, "z", 0x6b4628, 0x6b4628, 0.18), at: [0, 0, -0.335], axis: "z", speed: 60 }]
  };
}

/**
 * Vulcain: a short, armoured bombing dirigible. A fat iron gasbag whose whole
 * back is armour plate in team colour, split by riveted iron hoops; a heavy
 * armoured gondola with glowing gun slits and a stack belching coal smoke,
 * the bomb bay open under it with two bombs in the rack (team noses);
 * outrigger engines with pusher screws; iron cruciform fins, the top one team.
 */
export function vulcain(t: Team): ModelDef {
  const b = partB();
  const S: Vec3 = [1, 0.86, 1.9];
  const R = 0.2;
  ovoid(b, R, S, [0, 0, 0], IRON_M, 10, 6);
  ovoid(b, R * 1.02, S, [0, 0, 0], t.main, 10, 6, 1);
  for (const z of [-0.17, 0.08]) {
    const k = Math.sqrt(1 - (z / (R * S[2])) ** 2);
    hoop(b, R * k * 1.04, R * S[1] * k * 1.04, 0.026, [0, 0, z], IRON, 10);
  }
  // the armoured gondola: plate, gun slits, an iron prow, the stack
  b.block(0.15, 0.08, 0.34, [0, -0.25, -0.02], IRON, { bevel: 0.015, edge: 1.6 });
  for (const s of [1, -1]) {
    b.box(0.004, 0.014, 0.2, [s * 0.077, -0.22, -0.04], EXHAUST, { glow: 0.9 });
    bar(b, [s * 0.06, -0.21, -0.02], [s * 0.1, -0.13, -0.02], 0.014, IRON_L);
  }
  stack(b, [0, -0.21, 0.08], 0.024, 0.09);
  // the bomb bay open under it: two bombs, team noses
  for (const x of [-0.035, 0.035]) {
    b.tube(0.022, 0.12, 6, [x, -0.33, 0.0], IRON);
    b.cone(0.022, 0.04, 6, [x, -0.33, -0.08], t.main, { rot: [-Math.PI / 2, 0, 0] });
  }
  // outrigger engines, pusher screws
  const props: Vec3[] = [];
  for (const s of [1, -1]) {
    const x = s * 0.3;
    bar(b, [s * 0.16, -0.08, 0.06], [x, -0.1, 0.1], 0.016, IRON);
    b.tube(0.035, 0.14, 6, [x, -0.1, 0.1], IRON);
    b.box(0.072, 0.012, 0.03, [x, -0.1, 0.05], t.main);
    props.push([x, -0.1, 0.18]);
  }
  // cruciform fins: iron, the top one team
  b.prism([[0, 0.24], [0.15, 0.31], [0.16, 0.42], [0, 0.42]], 0.012, [0.006, 0.08, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  b.prism([[0, 0.24], [0.12, 0.31], [0.13, 0.42], [0, 0.42]], 0.012, [-0.006, -0.08, 0], IRON, { rot: [0, 0, -Math.PI / 2] });
  b.prism(sided([[0.1, 0.25], [0.26, 0.32], [0.26, 0.42], [0.1, 0.42]], 1), 0.012, [0, -0.006, 0], IRON);
  b.prism(sided([[0.1, 0.25], [0.26, 0.32], [0.26, 0.42], [0.1, 0.42]], -1), 0.012, [0, -0.006, 0], IRON);
  const prop = screw(0.1, 2, "z", IRON_L);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.36, 0], height: 0.4,
    rotors: props.map((at, i) => ({ geo: prop, at, axis: "z" as const, speed: i ? -36 : 36 }))
  };
}

/**
 * Titan: a pot-bellied armoured cargo dirigible. The whole gasbag in team
 * colour under iron hoops and a sooty nose cap, iron fins; slung below on
 * wires, the cargo gondola is the Condor's troop bay (CONDOR_BAY: deck,
 * benches, plated walls, the stern ramp as gangway). A steam winch stands
 * amidships at its origin and its lifting hook hangs under the keel: two
 * Titans hoist a Gargantua (render/goliath.ts runs its cables up to the
 * carrier's point, just below the origin: into the winch). Outrigger
 * engines with tractor screws, a stack venting coal smoke.
 */
export function titan(t: Team): ModelDef {
  const b = partB();
  const B = CONDOR_BAY;
  const Y = 0.44;
  const S: Vec3 = [1, 0.84, 1.95];
  const R = 0.26;
  ovoid(b, R, S, [0, Y, -0.04], t.main, 10, 6);
  for (const z of [-0.3, 0.2]) {
    const k = Math.sqrt(1 - ((z + 0.04) / (R * S[2])) ** 2);
    hoop(b, R * k * 1.03, R * S[1] * k * 1.03, 0.03, [0, Y, z], IRON, 10);
  }
  b.prism([[0, 0.33], [0.012, 0.33], [0.012, 0.52], [0, 0.52]], 0.15, [-0.006, Y + 0.12, 0], IRON);
  b.prism(sided([[0.12, 0.33], [0.32, 0.4], [0.32, 0.52], [0.12, 0.52]], 1), 0.012, [0, Y - 0.006, 0], IRON);
  b.prism(sided([[0.12, 0.33], [0.32, 0.4], [0.32, 0.52], [0.12, 0.52]], -1), 0.012, [0, Y - 0.006, 0], IRON);
  // the cargo gondola round the bay: a riveted prow, plated walls, deck and benches
  const W = B.w / 2 + 0.03;
  b.fuselage([[-0.5, 0.03, 0.02, -0.08], [-0.42, 0.13, 0.02, -0.17], [B.z0, W, 0.02, -0.19]], [0, 0, 0], IRON_M, { chamfer: 0.03, edge: 1.5 });
  // (its top is the deck, at CONDOR_BAY.floor)
  b.box(2 * W, 0.09, B.ramp - B.z0, [0, -0.145, (B.z0 + B.ramp) / 2], IRON_M);
  for (const s of [1, -1]) {
    b.box(0.03, B.wall - B.floor + 0.02, B.ramp - B.z0, [s * (B.w / 2 + 0.015), (B.wall + B.floor) / 2 + 0.01, (B.z0 + B.ramp) / 2], IRON_M);
    b.box(0.034, B.bench - B.floor, B.z1 - B.z0 - 0.02, [s * (B.w / 2 - 0.017), (B.bench + B.floor) / 2, (B.z0 + B.z1) / 2], COPPER);
    // the wires up to the gasbag
    bar(b, [s * W, B.wall, -0.36], [s * 0.15, Y - 0.17, -0.3], 0.008, IRON_L);
    bar(b, [s * W, B.wall, 0.3], [s * 0.15, Y - 0.17, 0.22], 0.008, IRON_L);
  }
  // the winch amidships (the lift cables run into its drum) and the hook under the keel
  b.cyl(0.04, 0.04, 0.1, 6, [0, -0.055, 0.0], COPPER, { rot: [0, 0, Math.PI / 2] });
  b.box(0.03, 0.07, 0.012, [0, -0.225, 0.0], IRON_L, { rot: [0, 0, 0.5] });
  // the stack venting off the prow, outrigger engines with tractor screws
  stack(b, [0, 0.02, -0.38], 0.022, 0.12);
  const props: Vec3[] = [];
  for (const s of [1, -1]) {
    const x = s * 0.36;
    bar(b, [s * W, -0.1, -0.12], [x, -0.06, -0.12], 0.016, IRON);
    b.tube(0.032, 0.13, 6, [x, -0.06, -0.12], IRON);
    props.push([x, -0.06, -0.2]);
  }
  const hull = b.build();
  // the ramp: an iron gangway hinged at the deck's stern edge (closed: it stands up, a team plate outside)
  const L = B.wall + 0.02 - B.floor;
  const r = partB();
  r.box(B.rampW - 0.004, L, 0.02, [0, L / 2, 0], IRON_M);
  r.box(B.rampW - 0.06, L * 0.62, 0.004, [0, L * 0.5, 0.011], t.main);
  const prop = screw(0.1, 2, "z", IRON_L);
  return {
    hull, mount: [0, 0, 0], muzzle: [0, -0.1, 0], height: 0.72,
    rotors: props.map((at, i) => ({ geo: prop, at, axis: "z" as const, speed: i ? -38 : 38 })),
    ramp: { geo: r.build(), hinge: [0, B.floor, B.ramp], open: 1.85, tip: [0, L, 0] }
  };
}

export const AIR_EMP: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  gyroptere,
  epervier,
  vulcain,
  titan
};
