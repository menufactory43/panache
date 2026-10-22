import * as THREE from "three";
import type { UnitKind } from "../../../sim/types";
import type { ModelBuilder, Section, Vec3 } from "../builder";
import { BRASS, barrel, barrelTip, hullB, partB, strut, type ModelDef, type Team } from "../models";

/**
 * The République's new ground vehicles (PANACHE-CONCEPTION.md §1.11, WP5a):
 * Fourgon Jeantaud, Jamais-Contente, Autocanon De Dion, Canon Branly.
 * Same contract as models.ts UNIT_MODELS (origin on the ground at the hull
 * centre, nose toward -Z, turret/mount/muzzle, cargo for the worker), and the
 * detail of the first Belle Époque vehicles (belle/ground.ts): about 1 500 to
 * 3 000 triangles a unit (tests/nation-models.test.ts). The République's
 * look: ivory lacquer with black coachlines, nickel plate, bevelled glass,
 * copper windings, wire wheels and electric-blue sparks.
 */

/** Ivory coachwork, nickel plate, black lacquer, buttoned leather, copper windings, glass, the electric spark. */
const IVORY = 0xece2c6;
const IVORY_D = 0xcfc2a0;
const NICKEL = 0xc9cdd2;
const NICKEL_D = 0x8c939b;
const LACQUER = 0x1c2129;
const LEATHER = 0x5a2a1e;
const COPPER = 0xc07440;
const GLASS = 0x9cc8e8;
const SPARK = 0x9fe0ff;
const ARC = 0xe4f6ff;
const TYRE = 0x1a1a1c;
const SKIN = 0xe0b89a;
const COAL = 0x1f1b18;
const RADIUM = 0xd4ffd8;
/** Porcelain insulators. */
const PORCELAIN = 0xf4f1ea;

const AX: Vec3 = [0, 0, Math.PI / 2];

/**
 * A wire-spoked wheel turning about X (the République's cars): a black
 * rubber tyre, a nickel rim, `n` thin nickel spokes, a nickel hub and cap.
 */
function wireWheel(b: ModelBuilder, at: Vec3, r: number, w: number, n = 10, rim = NICKEL): void {
  const tyre = r * 0.17;
  b.torus(r - tyre, tyre, at, TYRE, { rot: [0, Math.PI / 2, 0], scale: [1, 1, w / (2 * tyre)], seg: 11 });
  b.add(new THREE.CylinderGeometry(r - tyre * 1.8, r - tyre * 1.8, w * 0.55, 12, 1, true), at, rim, { rot: AX });
  for (let i = 0; i < n / 2; i++) b.box(w * 0.2, (r - tyre * 2) * 2, 0.007, at, NICKEL, { rot: [(i * Math.PI * 2) / n + 0.2, 0, 0] });
  b.cyl(r * 0.2, r * 0.24, w * 1.2, 6, at, BRASS, { rot: AX });
}

/** A band round an axis (an open hoop: windings, bands, rims), `w` wide; turned about X by default. */
function band(b: ModelBuilder, r: number, w: number, at: Vec3, hex: number, rot: Vec3 = AX, seg = 12, glow = 0): void {
  b.add(new THREE.CylinderGeometry(r, r, w, seg, 1, true), at, hex, { rot, glow });
}

/** A seated figure from the waist up facing -Z: a coat with a collar, arms forward, a head, a flat cap with a peak. */
function driver(b: ModelBuilder, at: Vec3, coat: number, cap: number, goggles = false): void {
  const [x, y, z] = at;
  b.block(0.1, 0.11, 0.075, [x, y, z], coat, { bevel: 0.015 });
  b.box(0.07, 0.02, 0.06, [x, y + 0.11, z], IVORY);
  for (const s of [1, -1]) b.box(0.025, 0.025, 0.08, [x + s * 0.055, y + 0.07, z - 0.04], coat, { rot: [0.5, 0, 0] });
  b.sphere(0.03, [x, y + 0.145, z - 0.005], SKIN, { w: 7, h: 4 });
  b.cyl(0.032, 0.034, 0.022, 8, [x, y + 0.17, z - 0.002], cap);
  b.box(0.05, 0.006, 0.03, [x, y + 0.162, z - 0.035], cap);
  if (goggles) b.box(0.05, 0.014, 0.01, [x, y + 0.15, z - 0.033], NICKEL, { glow: 0.2 });
}

/** A brass carriage lamp on its bracket, the lens glowing the electric blue-white. */
function lamp(b: ModelBuilder, at: Vec3, s = 0.03): void {
  const [x, y, z] = at;
  b.cyl(s * 0.5, s * 0.6, s * 1.1, 8, [x, y, z], BRASS);
  b.cone(s * 0.45, s * 0.6, 8, [x, y + s * 0.85, z], LACQUER);
  b.cyl(s * 0.42, s * 0.42, 0.006, 8, [x, y, z - s * 0.5], ARC, { rot: [Math.PI / 2, 0, 0], glow: 1 });
}

/** A porcelain insulator stack: three ribbed discs on a nickel pin. */
function insulator(b: ModelBuilder, at: Vec3, s = 0.02): void {
  const [x, y, z] = at;
  for (let i = 0; i < 3; i++) b.cyl(s, s * 0.7, s * 0.5, 6, [x, y + i * s * 0.6, z], PORCELAIN);
  b.cyl(s * 0.25, s * 0.25, s * 2.2, 5, [x, y + s * 0.6, z], NICKEL);
}

/** A row of nickel rivet heads from `a` to `c`. */
function studs(b: ModelBuilder, a: Vec3, c: Vec3, n: number, s = 0.01, hex = NICKEL): void {
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0.5 : i / (n - 1);
    b.box(s, s, s, [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k], hex);
  }
}

// ---------------------------------------------------------------- units ---

/**
 * The Fourgon Jeantaud (worker): an electric delivery van after Jeantaud's
 * electric cab. A padded ivory box body with black coachlines and bevelled
 * windows, the coachman on a buttoned bench out front, a team roof with a
 * nickel gallery rail over the whole length (the patch seen from above),
 * copper battery boxes and glass cells on the rear tray, carriage lamps, and
 * a trolley pole on porcelain insulators whose shoe sparks blue.
 * `cargo`: coal and glowing radium on the rear tray.
 */
function fourgon(t: Team): ModelDef {
  const b = hullB();
  // chassis rails, leaf springs, axles, wire wheels (small in front, larger behind)
  b.pairBlock(0.04, 0.05, 0.86, [0.12, 0.16, 0.02], LACQUER, { bevel: 0.01 });
  for (const z of [-0.28, 0.25]) {
    b.cyl(0.012, 0.012, 0.44, 6, [0, z < 0 ? 0.1 : 0.13, z], NICKEL_D, { rot: AX });
    for (const s of [1, -1]) b.box(0.03, 0.02, 0.18, [s * 0.12, z < 0 ? 0.13 : 0.15, z], NICKEL_D);
  }
  for (const s of [1, -1]) {
    wireWheel(b, [s * 0.21, 0.1, -0.28], 0.1, 0.045, 10);
    wireWheel(b, [s * 0.22, 0.13, 0.25], 0.13, 0.05, 12);
    // lacquer mudguards arching over each wheel, a running board between them
    b.block(0.07, 0.014, 0.2, [s * 0.21, 0.215, -0.28], LACQUER, { bevel: 0.005 });
    b.box(0.07, 0.05, 0.014, [s * 0.21, 0.19, -0.385], LACQUER, { rot: [0.7, 0, 0] });
    b.block(0.08, 0.014, 0.24, [s * 0.22, 0.272, 0.25], LACQUER, { bevel: 0.005 });
    b.box(0.08, 0.06, 0.014, [s * 0.22, 0.24, 0.375], LACQUER, { rot: [-0.7, 0, 0] });
    b.box(0.07, 0.012, 0.3, [s * 0.2, 0.17, -0.03], NICKEL_D);
  }
  // the dashboard: a curved ivory apron with a nickel rail, the steering column and wheel
  b.block(0.32, 0.12, 0.12, [0, 0.22, -0.37], IVORY, { bevel: 0.03, taper: 0.15 });
  b.box(0.33, 0.012, 0.012, [0, 0.285, -0.42], NICKEL);
  b.box(0.3, 0.008, 0.11, [0, 0.282, -0.37], LACQUER);
  strut(b, [0.05, 0.25, -0.33], [0.05, 0.33, -0.29], 0.006, NICKEL);
  b.torus(0.03, 0.006, [0.05, 0.335, -0.285], LACQUER, { rot: [Math.PI / 2 - 0.5, 0, 0], seg: 8 });
  // the coachman on a buttoned leather bench
  b.block(0.32, 0.05, 0.11, [0, 0.26, -0.22], LEATHER, { bevel: 0.015 });
  b.block(0.32, 0.1, 0.03, [0, 0.31, -0.165], LEATHER, { bevel: 0.01 });
  for (const x of [-0.1, -0.03, 0.04, 0.11]) b.box(0.012, 0.012, 0.006, [x, 0.32, -0.181], BRASS);
  driver(b, [0.05, 0.29, -0.23], LACQUER, t.dark);
  // carriage lamps either side of the dash
  for (const s of [1, -1]) {
    b.box(0.03, 0.01, 0.01, [s * 0.165, 0.26, -0.4], NICKEL);
    lamp(b, [s * 0.185, 0.27, -0.42], 0.034);
  }
  // the box body: ivory panels framed in black coachlines, bevelled glass in nickel frames
  b.block(0.36, 0.3, 0.4, [0, 0.34, 0.06], IVORY, { bevel: 0.025 });
  b.box(0.364, 0.03, 0.404, [0, 0.215, 0.06], IVORY_D);
  for (const s of [1, -1]) {
    b.box(0.006, 0.11, 0.25, [s * 0.181, 0.4, 0.04], GLASS, { glow: 0.3 });
    b.box(0.008, 0.012, 0.27, [s * 0.181, 0.46, 0.04], NICKEL);
    b.box(0.008, 0.012, 0.27, [s * 0.181, 0.34, 0.04], NICKEL);
    for (const z of [-0.09, 0.04, 0.17]) b.box(0.008, 0.11, 0.012, [s * 0.181, 0.4, z], NICKEL);
    // the lower panel's coachline and a monogram plate
    b.box(0.006, 0.006, 0.36, [s * 0.181, 0.32, 0.06], LACQUER);
    b.box(0.006, 0.07, 0.006, [s * 0.181, 0.28, -0.12], LACQUER);
    b.box(0.006, 0.07, 0.006, [s * 0.181, 0.28, 0.24], LACQUER);
    b.cyl(0.026, 0.026, 0.01, 10, [s * 0.183, 0.27, 0.06], BRASS, { rot: AX });
    b.cyl(0.02, 0.02, 0.012, 10, [s * 0.184, 0.27, 0.06], t.main, { rot: AX });
  }
  b.box(0.24, 0.11, 0.006, [0, 0.4, -0.142], GLASS, { glow: 0.3 });
  b.box(0.26, 0.012, 0.008, [0, 0.46, -0.142], NICKEL);
  // rear doors: two panels and brass handles
  b.box(0.004, 0.24, 0.006, [0, 0.34, 0.262], LACQUER);
  for (const s of [1, -1]) b.box(0.008, 0.04, 0.01, [s * 0.025, 0.34, 0.266], BRASS);
  // the roof over seat and body, gently cambered, a nickel gallery rail round it; two nickel posts hold its front
  b.block(0.42, 0.035, 0.8, [0, 0.505, -0.07], t.main, { bevel: 0.016, edge: 1.35 });
  b.block(0.3, 0.02, 0.66, [0, 0.53, -0.06], t.main, { bevel: 0.01, edge: 1.4 });
  b.box(0.43, 0.012, 0.81, [0, 0.484, -0.07], NICKEL);
  for (const s of [1, -1]) {
    b.box(0.008, 0.008, 0.76, [s * 0.2, 0.56, -0.07], NICKEL);
    for (const z of [-0.42, -0.2, 0.06, 0.28]) b.box(0.006, 0.04, 0.006, [s * 0.2, 0.54, z], NICKEL);
    b.cyl(0.008, 0.008, 0.22, 6, [s * 0.19, 0.38, -0.44], NICKEL);
  }
  // the trolley pole on its porcelain base, leaning back, its shoe sparking
  b.drum(0.04, 0.03, 0.03, 8, [0.08, 0.55, 0.12], LACQUER);
  insulator(b, [0.08, 0.575, 0.12], 0.024);
  strut(b, [0.08, 0.62, 0.12], [0.08, 0.86, 0.42], 0.009, NICKEL);
  band(b, 0.016, 0.05, [0.08, 0.645, 0.15], COPPER, [-0.9, 0, 0], 8);
  b.box(0.05, 0.02, 0.03, [0.08, 0.865, 0.425], NICKEL_D);
  b.sphere(0.022, [0.08, 0.885, 0.43], SPARK, { glow: 1, w: 8, h: 5 });
  b.sphere(0.012, [0.105, 0.905, 0.41], ARC, { glow: 1, w: 6, h: 4 });
  // the rear tray: copper battery boxes with brass terminals and glowing glass cells, cables up to the body
  b.block(0.38, 0.03, 0.2, [0, 0.21, 0.36], LACQUER, { bevel: 0.008 });
  for (const s of [1, -1]) {
    b.block(0.1, 0.12, 0.18, [s * 0.13, 0.285, 0.36], COPPER, { bevel: 0.015 });
    for (const z of [0.31, 0.36, 0.41]) b.box(0.102, 0.006, 0.006, [s * 0.13, 0.3, z], LACQUER);
    for (const z of [0.31, 0.41]) b.cyl(0.01, 0.01, 0.02, 6, [s * 0.13, 0.355, z], BRASS);
    b.box(0.07, 0.03, 0.05, [s * 0.13, 0.36, 0.36], GLASS, { glow: 0.5 });
    strut(b, [s * 0.13, 0.36, 0.31], [s * 0.15, 0.44, 0.26], 0.005, LACQUER);
  }
  // a tail lamp
  lamp(b, [0.17, 0.25, 0.47], 0.024);
  const hull = b.build();
  // the load between the battery boxes: coal, and radium glowing green-white
  const c = partB();
  const lumps: [number, number, number, number][] = [
    [-0.03, 0.3, 0.04, 0.27], [0.035, 0.42, 0.035, 0.27], [-0.035, 0.41, 0.035, 0.28], [0.01, 0.36, 0.045, 0.3],
    [0.03, 0.31, 0.03, 0.28], [-0.02, 0.36, 0.03, 0.33], [0.0, 0.44, 0.03, 0.27]
  ];
  lumps.forEach(([x, z, s, y], i) => c.box(s * 2, s * 1.4, s * 1.8, [x, y, z], i % 3 ? COAL : 0x2c2622, { rot: [i * 0.7, i * 1.3, i * 0.4] }));
  for (const [x, z, s] of [[0.03, 0.34, 0.02], [-0.03, 0.39, 0.018], [0.0, 0.31, 0.015]] as [number, number, number][])
    c.sphere(s, [x, 0.34, z], RADIUM, { glow: 0.85, w: 5, h: 3, scale: [1, 1.4, 1] });
  return { hull, mount: [0, 0, 0], muzzle: [0, 0.25, -0.46], rotors: [], cargo: c.build(), height: 0.86 };
}

/**
 * The Jamais-Contente: Jenatzy's torpedo-shaped electric record car turned
 * light raider. A riveted nickel torpedo on four wire wheels, its front half
 * in team colour, the goggled driver sitting up out of it, the electric
 * motor's copper windings at the rear axle, and on the bonnet a little arc
 * turret: Leyden jars and twin copper horns round a blue spark.
 */
function jamaisContente(t: Team): ModelDef {
  const b = hullB();
  const body: Section[] = [
    [-0.47, 0.012, 0.2, 0.18], [-0.42, 0.045, 0.235, 0.145], [-0.36, 0.075, 0.265, 0.115], [-0.26, 0.095, 0.29, 0.1],
    [-0.1, 0.103, 0.3, 0.098], [0.12, 0.1, 0.3, 0.1], [0.28, 0.085, 0.285, 0.11], [0.38, 0.06, 0.26, 0.13], [0.47, 0.012, 0.21, 0.18]
  ];
  b.fuselage(body, [0, 0, 0], NICKEL, { chamfer: 0.04, edge: 1.25 });
  // the front spindle in team colour, a hair proud of the nickel, and a team stripe down the tail
  const nose: Section[] = [
    [-0.48, 0.016, 0.206, 0.176], [-0.425, 0.05, 0.241, 0.141], [-0.365, 0.081, 0.271, 0.111], [-0.26, 0.101, 0.296, 0.096], [0.02, 0.109, 0.306, 0.094]
  ];
  b.fuselage(nose, [0, 0, 0], t.main, { chamfer: 0.042, edge: 1.35 });
  b.box(0.05, 0.01, 0.3, [0, 0.29, 0.22], t.main, { rot: [-0.08, 0, 0] });
  // rivet rows where the nickel meets the team paint, and along the flanks
  for (let i = 0; i < 10; i++) {
    const a = (i / 9) * Math.PI;
    b.box(0.01, 0.01, 0.01, [Math.cos(a) * 0.1, 0.2 + Math.sin(a) * 0.1, 0.03], BRASS);
  }
  for (const s of [1, -1]) studs(b, [s * 0.1, 0.2, -0.2], [s * 0.1, 0.2, 0.3], 8, 0.009);
  // four wire wheels on nickel axles, slim fairings over the front pair
  for (const z of [-0.26, 0.26]) {
    b.cyl(0.008, 0.008, 0.34, 4, [0, 0.11, z], NICKEL, { rot: AX });
    for (const s of [1, -1]) wireWheel(b, [s * 0.17, 0.11, z], 0.11, 0.03, 12);
  }
  for (const s of [1, -1]) b.block(0.04, 0.012, 0.18, [s * 0.17, 0.235, -0.26], t.dark, { bevel: 0.004 });
  // the electric motor at the rear axle: a drum wound in copper
  b.cyl(0.045, 0.045, 0.14, 10, [0, 0.11, 0.26], LACQUER, { rot: AX });
  for (const x of [-0.045, 0, 0.045]) band(b, 0.048, 0.02, [x, 0.11, 0.26], COPPER, AX, 10);
  // the cockpit: a leather rim, the goggled driver, a curved windscreen, a nickel steering wheel
  b.torus(0.07, 0.012, [0, 0.296, 0.12], LEATHER, { rot: [Math.PI / 2, 0, 0], seg: 10, scale: [1, 1.3, 1] });
  driver(b, [0, 0.22, 0.13], LACQUER, LEATHER, true);
  b.box(0.13, 0.055, 0.006, [0, 0.33, 0.035], GLASS, { glow: 0.35, rot: [-0.45, 0, 0] });
  b.box(0.135, 0.008, 0.01, [0, 0.355, 0.045], NICKEL, { rot: [-0.45, 0, 0] });
  b.torus(0.028, 0.005, [0, 0.31, 0.06], NICKEL, { rot: [Math.PI / 2 - 0.6, 0, 0], seg: 8 });
  // a headlamp in the nose, a spark trail grille at the tail
  lamp(b, [0, 0.16, -0.47], 0.03);
  b.box(0.06, 0.025, 0.07, [0, 0.2, 0.45], LACQUER);
  for (const x of [-0.02, 0, 0.02]) b.box(0.008, 0.02, 0.06, [x, 0.215, 0.46], SPARK, { glow: 0.85 });
  const hull = b.build();
  // the arc turret: a nickel drum on a brass ring, Leyden jars, two coiled copper horns round a spark
  const tu = partB();
  tu.drum(0.08, 0.07, 0.04, 12, [0, 0.0, 0], NICKEL, { bevel: 0.01 });
  band(tu, 0.082, 0.014, [0, 0.0, 0], BRASS, [0, 0, 0], 12);
  for (const s of [1, -1]) {
    tu.cyl(0.022, 0.022, 0.07, 8, [s * 0.04, 0.075, 0.035], GLASS, { glow: 0.4 });
    tu.sphere(0.012, [s * 0.04, 0.115, 0.035], BRASS, { w: 6, h: 4 });
  }
  for (const s of [1, -1]) {
    strut(tu, [s * 0.03, 0.04, -0.02], [s * 0.04, 0.07, -0.17], 0.009, COPPER);
    for (const k of [0.35, 0.7]) tu.torus(0.016, 0.005, [s * (0.03 + 0.01 * k), 0.04 + 0.03 * k, -0.02 - 0.15 * k], COPPER, { seg: 6 });
    tu.sphere(0.014, [s * 0.04, 0.07, -0.17], BRASS, { w: 6, h: 4 });
  }
  tu.sphere(0.024, [0, 0.07, -0.17], SPARK, { glow: 1, w: 8, h: 6 });
  tu.box(0.07, 0.008, 0.008, [0, 0.07, -0.17], ARC, { glow: 1, rot: [0, 0, 0.3] });
  return { hull, turret: tu.build(), mount: [0, 0.3, -0.22], muzzle: [0, 0.07, -0.18], rotors: [], height: 0.6 };
}

/**
 * The Autocanon De Dion: a De Dion-Bouton tricar, a driver astride the front
 * wire wheel, a finned single-cylinder engine, and on the rear deck (team
 * colour, nickel-railed) a pivoting revolver cannon of four barrels pitched
 * at the sky behind a curved team shield, a drum magazine at its side.
 */
function deDion(t: Team): ModelDef {
  const b = hullB();
  // the front wheel in its nickel fork, the handlebar with a lamp, the frame, the saddle and the driver
  wireWheel(b, [0, 0.12, -0.34], 0.12, 0.045, 12);
  b.block(0.04, 0.012, 0.16, [0, 0.255, -0.34], IVORY, { bevel: 0.004 });
  for (const s of [1, -1]) strut(b, [s * 0.03, 0.12, -0.34], [s * 0.025, 0.31, -0.3], 0.008, NICKEL);
  b.box(0.22, 0.012, 0.012, [0, 0.31, -0.3], NICKEL);
  for (const s of [1, -1]) b.cyl(0.01, 0.01, 0.04, 6, [s * 0.11, 0.31, -0.3], LEATHER, { rot: AX });
  lamp(b, [0, 0.28, -0.37], 0.034);
  b.block(0.06, 0.05, 0.36, [0, 0.2, -0.12], LACQUER, { bevel: 0.01 });
  strut(b, [0, 0.2, -0.28], [0, 0.29, -0.3], 0.012, LACQUER);
  b.block(0.1, 0.03, 0.11, [0, 0.245, -0.16], LEATHER, { bevel: 0.012 });
  for (const s of [1, -1]) b.cyl(0.01, 0.012, 0.03, 5, [s * 0.03, 0.225, -0.13], NICKEL);
  driver(b, [0, 0.27, -0.17], IVORY, t.dark, true);
  // the De Dion engine, finned, its brass carburettor and the exhaust
  b.cyl(0.04, 0.04, 0.12, 10, [0, 0.18, 0.0], NICKEL_D);
  for (const y of [0.14, 0.165, 0.19, 0.215]) b.cyl(0.055, 0.055, 0.008, 10, [0, y, 0.0], NICKEL);
  b.sphere(0.03, [0, 0.25, 0], BRASS, { w: 8, h: 4, phi: Math.PI / 2 });
  b.cyl(0.015, 0.015, 0.04, 6, [0.06, 0.17, -0.02], BRASS, { rot: AX });
  strut(b, [-0.04, 0.15, 0.02], [-0.12, 0.12, 0.34], 0.01, NICKEL_D);
  // the rear axle, its wire wheels and ivory mudguards, the gun deck in team colour
  b.cyl(0.015, 0.015, 0.46, 6, [0, 0.14, 0.16], LACQUER, { rot: AX });
  for (const s of [1, -1]) {
    wireWheel(b, [s * 0.23, 0.14, 0.16], 0.14, 0.05, 12);
    b.block(0.075, 0.014, 0.24, [s * 0.23, 0.3, 0.16], IVORY, { bevel: 0.005 });
    b.box(0.075, 0.07, 0.014, [s * 0.23, 0.265, 0.3], IVORY, { rot: [-0.7, 0, 0] });
    b.box(0.075, 0.07, 0.014, [s * 0.23, 0.265, 0.02], IVORY, { rot: [0.7, 0, 0] });
    b.box(0.076, 0.004, 0.24, [s * 0.23, 0.308, 0.16], LACQUER);
  }
  b.block(0.4, 0.05, 0.38, [0, 0.235, 0.15], t.main, { bevel: 0.015, edge: 1.35 });
  b.box(0.41, 0.016, 0.39, [0, 0.212, 0.15], NICKEL);
  for (const s of [1, -1]) {
    studs(b, [s * 0.19, 0.262, 0.0], [s * 0.19, 0.262, 0.3], 6, 0.01);
    b.box(0.008, 0.008, 0.34, [s * 0.2, 0.31, 0.15], NICKEL);
    for (const z of [0.0, 0.15, 0.3]) b.box(0.006, 0.05, 0.006, [s * 0.2, 0.285, z], NICKEL);
  }
  // ready-use ammunition: two ivory chests at the deck's tail
  for (const s of [1, -1]) {
    b.block(0.1, 0.06, 0.06, [s * 0.1, 0.29, 0.3], IVORY, { bevel: 0.01 });
    b.box(0.1, 0.008, 0.062, [s * 0.1, 0.3, 0.3], LACQUER);
  }
  const hull = b.build();
  // the pivot, the gunner's seat, the curved team shield, the revolver cannon at the sky
  const tu = partB();
  tu.drum(0.09, 0.08, 0.05, 12, [0, 0.0, 0], NICKEL, { bevel: 0.012 });
  band(tu, 0.092, 0.014, [0, 0.01, 0], BRASS, [0, 0, 0], 12);
  tu.block(0.08, 0.02, 0.07, [0, 0.07, 0.11], LEATHER, { bevel: 0.008 });
  tu.cyl(0.01, 0.01, 0.06, 6, [0, 0.04, 0.11], NICKEL);
  for (const s of [1, -1]) {
    tu.block(0.14, 0.18, 0.02, [s * 0.075, 0.12, -0.11], t.main, { rot: [-0.25, s * -0.35, 0], bevel: 0.008, edge: 1.35 });
    tu.box(0.14, 0.012, 0.024, [s * 0.075, 0.21, -0.088], NICKEL, { rot: [-0.25, s * -0.35, 0] });
    studs(tu, [s * 0.03, 0.05, -0.135], [s * 0.03, 0.19, -0.1], 4, 0.009);
  }
  tu.pair(0.02, 0.1, 0.06, [0.05, 0.1, 0], LACQUER);
  const pitch = 1.05;
  const at: Vec3 = [0, 0.12, 0.02];
  tu.cyl(0.05, 0.05, 0.1, 10, barrelTip(at, 0.05, pitch), LACQUER, { rot: [pitch - Math.PI / 2, 0, 0] });
  for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][])
    barrel(tu, [at[0] + u * 0.022, at[1] + v * 0.022 * Math.cos(pitch), at[2] + v * 0.022 * Math.sin(pitch)], 0.012, 0.32, pitch, LACQUER, 6);
  for (const k of [0.14, 0.28]) tu.cyl(0.044, 0.044, 0.02, 10, barrelTip(at, k, pitch), NICKEL, { rot: [pitch - Math.PI / 2, 0, 0] });
  // the drum magazine at the breech's side, a ring sight
  tu.cyl(0.05, 0.05, 0.03, 12, [0.075, 0.13, 0.04], IVORY, { rot: AX });
  tu.cyl(0.02, 0.02, 0.034, 8, [0.075, 0.13, 0.04], BRASS, { rot: AX });
  tu.torus(0.025, 0.004, [-0.06, 0.22, -0.06], NICKEL, { rot: [pitch, 0, 0], seg: 8 });
  return { hull, turret: tu.build(), mount: [0, 0.26, 0.16], muzzle: barrelTip(at, 0.33, pitch), rotors: [], height: 0.62 };
}

/**
 * The Canon Branly: an electromagnetic gun. Two solid disc wheels (ivory
 * faces, nickel-studded), a trail carrying an ivory dynamo wound in copper
 * with its brass handwheel and a team accumulator chest, and on the pivot a
 * long nickel tube threaded with team coils between copper windings and
 * porcelain insulators, a capacitor bank of glowing jars over the breech,
 * and a blue glow at the muzzle.
 */
function branly(t: Team): ModelDef {
  const b = hullB();
  b.cyl(0.022, 0.022, 0.52, 8, [0, 0.17, -0.04], LACQUER, { rot: AX });
  for (const s of [1, -1]) {
    const at: Vec3 = [s * 0.25, 0.17, -0.04];
    b.torus(0.15, 0.025, at, TYRE, { rot: [0, Math.PI / 2, 0], scale: [1, 1, 1.1], seg: 14 });
    b.cyl(0.14, 0.14, 0.04, 16, at, IVORY, { rot: AX });
    b.cyl(0.1, 0.1, 0.046, 16, at, IVORY_D, { rot: AX });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.box(0.05, 0.012, 0.012, [at[0], at[1] + Math.cos(a) * 0.12, at[2] + Math.sin(a) * 0.12], NICKEL);
    }
    b.cyl(0.04, 0.045, 0.07, 10, at, NICKEL, { rot: AX });
    b.cyl(0.018, 0.018, 0.08, 6, at, BRASS, { rot: AX });
  }
  // the trail back to its spade, the dynamo on it, copper-wound, its handwheel
  b.block(0.1, 0.06, 0.5, [0, 0.13, 0.24], LACQUER, { rot: [0.22, 0, 0], bevel: 0.012 });
  b.pair(0.01, 0.01, 0.46, [0.045, 0.165, 0.24], NICKEL, { rot: [0.22, 0, 0] });
  b.block(0.18, 0.08, 0.025, [0, 0.04, 0.48], LACQUER, { rot: [0.3, 0, 0], bevel: 0.006 });
  b.torus(0.03, 0.008, [0, 0.1, 0.49], BRASS, { seg: 8 });
  b.cyl(0.065, 0.065, 0.16, 12, [0, 0.21, 0.26], IVORY, { rot: AX });
  for (const x of [-0.05, -0.017, 0.017, 0.05]) band(b, 0.069, 0.022, [x, 0.21, 0.26], COPPER, AX, 12);
  for (const s of [1, -1]) b.cyl(0.03, 0.03, 0.02, 8, [s * 0.09, 0.21, 0.26], NICKEL, { rot: AX });
  b.torus(0.04, 0.006, [0.11, 0.21, 0.26], BRASS, { rot: [0, Math.PI / 2, 0], seg: 8 });
  // the accumulator chest in team colour, its brass terminals and a glowing gauge
  b.block(0.18, 0.08, 0.11, [0, 0.215, 0.4], t.main, { bevel: 0.012, edge: 1.35 });
  b.box(0.185, 0.01, 0.115, [0, 0.19, 0.4], NICKEL);
  for (const s of [1, -1]) b.cyl(0.01, 0.01, 0.025, 6, [s * 0.05, 0.265, 0.4], BRASS);
  b.cyl(0.018, 0.018, 0.006, 10, [0, 0.235, 0.457], SPARK, { rot: [Math.PI / 2, 0, 0], glow: 0.8 });
  strut(b, [0.05, 0.27, 0.4], [0.02, 0.24, 0.27], 0.005, COPPER);
  b.drum(0.09, 0.08, 0.06, 12, [0, 0.21, -0.04], NICKEL, { bevel: 0.012 });
  const hull = b.build();
  // the gun: cradle cheeks, the capacitor bank, the tube and its coils
  const tu = partB();
  const pitch = 0.32;
  const at: Vec3 = [0, 0.09, 0.2];
  tu.pairBlock(0.025, 0.1, 0.2, [0.06, 0.06, 0.04], LACQUER, { bevel: 0.006 });
  for (const s of [1, -1]) studs(tu, [s * 0.074, 0.08, -0.03], [s * 0.074, 0.08, 0.11], 4, 0.009);
  tu.block(0.21, 0.11, 0.2, [0, 0.1, 0.17], t.main, { bevel: 0.02, edge: 1.35 });
  tu.box(0.215, 0.012, 0.205, [0, 0.07, 0.17], NICKEL);
  // six glass jars on the bank, their brass caps linked by a copper bus
  for (const x of [-0.06, 0, 0.06])
    for (const z of [0.12, 0.21]) {
      tu.cyl(0.02, 0.02, 0.05, 8, [x, 0.18, z], GLASS, { glow: 0.45 });
      tu.cyl(0.01, 0.01, 0.014, 6, [x, 0.21, z], BRASS);
    }
  for (const z of [0.12, 0.21]) tu.box(0.13, 0.006, 0.006, [0, 0.214, z], COPPER);
  barrel(tu, at, 0.028, 0.86, pitch, NICKEL, 10);
  for (const k of [0.28, 0.42, 0.56, 0.7]) {
    barrel(tu, barrelTip(at, k - 0.045, pitch), 0.072, 0.09, pitch, t.main, 12);
    barrel(tu, barrelTip(at, k + 0.045, pitch), 0.05, 0.02, pitch, COPPER, 10);
    const top = barrelTip(at, k - 0.045, pitch);
    insulator(tu, [top[0], top[1] + 0.065, top[2]], 0.012);
  }
  barrel(tu, barrelTip(at, 0.2, pitch), 0.05, 0.03, pitch, BRASS, 10);
  // the muzzle: a nickel flare, a glowing glass bulb, a crackle of arc
  const tip = barrelTip(at, 0.86, pitch);
  barrel(tu, barrelTip(at, 0.82, pitch), 0.04, 0.04, pitch, NICKEL_D, 10);
  tu.sphere(0.035, tip, SPARK, { glow: 1, w: 10, h: 6 });
  tu.box(0.11, 0.008, 0.008, tip, ARC, { glow: 1, rot: [0.4, 0.3, 0.6] });
  return { hull, turret: tu.build(), mount: [0, 0.24, -0.04], muzzle: tip, rotors: [], height: 0.62 };
}

export const GROUND_REP: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  fourgon: fourgon,
  "jamais-contente": jamaisContente,
  "de-dion": deDion,
  branly: branly
};

