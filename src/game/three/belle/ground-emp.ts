import * as THREE from "three";
import type { UnitKind } from "../../../sim/types";
import type { ModelBuilder, Section, Vec3 } from "../builder";
import { AMBER, barrel, barrelTip, hullB, partB, strut, type ModelDef, type Team } from "../models";

/**
 * The Empire de Carbonie's new ground vehicles (PANACHE-CONCEPTION.md §1.11,
 * WP5b): Estafette, Mortier de 280, Atelier roulant. Same contract as
 * models.ts UNIT_MODELS, with the detail of the first Belle Époque vehicles
 * (belle/ground.ts): about 1 500 to 3 000 triangles a unit
 * (tests/nation-models.test.ts). The Empire's look: soot-black riveted iron,
 * banded boilers, coal, smokestacks with red-hot throats and firebox glows,
 * dull brass only for trim.
 */

/** Soot-black iron, its worn edges, rivet heads, soot, coal, the firebox glow, dull brass, oak. */
const IRON = 0x2b2725;
const IRON_M = 0x4a423b;
const RIVET = 0x8a7c6a;
const SOOT = 0x120e0c;
const COAL = 0x1f1b18;
const COAL_L = 0x2c2622;
const EMBER = 0xff5a1e;
const BRASS_D = 0xa8843e;
const OAK = 0x5e3d22;
const OAK_L = 0x7c5532;
const TYRE = 0x1a1716;
const SKIN = 0xd8ae90;
const STEEL = 0x8f959b;

const AX: Vec3 = [0, 0, Math.PI / 2];

/**
 * An iron-spoked road wheel turning about X: an iron tyre with a row of
 * cleats, `n` flat spokes, a dull brass hub and a riveted boss.
 */
function ironWheel(b: ModelBuilder, at: Vec3, r: number, w: number, n = 8): void {
  const tyre = r * 0.16;
  b.torus(r - tyre, tyre, at, TYRE, { rot: [0, Math.PI / 2, 0], scale: [1, 1, w / (2 * tyre)], seg: 11 });
  b.add(new THREE.CylinderGeometry(r - tyre * 1.7, r - tyre * 1.7, w * 0.7, 12, 1, true), at, IRON_M, { rot: AX });
  for (let i = 0; i < n / 2; i++) b.box(w * 0.3, (r - tyre * 2) * 2, r * 0.12, at, IRON, { rot: [(i * Math.PI * 2) / n, 0, 0] });
  b.cyl(r * 0.3, r * 0.3, w * 1.1, 8, at, BRASS_D, { rot: AX });
  b.cyl(r * 0.13, r * 0.16, w * 1.4, 6, at, IRON, { rot: AX });
}

/** A row of rivet heads from `a` to `c`. */
function rivets(b: ModelBuilder, a: Vec3, c: Vec3, n: number, s = 0.013): void {
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0.5 : i / (n - 1);
    b.box(s, s, s, [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k], RIVET);
  }
}

/** A ring of `n` rivet heads round a vertical axis at `at`, radius `r`. */
function rivetRing(b: ModelBuilder, at: Vec3, r: number, n: number, s = 0.012): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.box(s, s, s, [at[0] + Math.sin(a) * r, at[1], at[2] + Math.cos(a) * r], RIVET);
  }
}

/** A smokestack standing on `base`: iron, a dull brass band, a flared soot crown, its throat red-hot. */
function stack(b: ModelBuilder, base: Vec3, r: number, h: number): void {
  const [x, y, z] = base;
  b.cyl(r, r * 1.12, h, 8, [x, y + h / 2, z], IRON);
  b.cyl(r * 1.2, r * 1.2, h * 0.06, 8, [x, y + h * 0.3, z], BRASS_D);
  b.cyl(r * 1.7, r * 1.05, h * 0.18, 8, [x, y + h, z], SOOT);
  b.cyl(r * 1.1, r * 1.1, 0.006, 8, [x, y + h * 1.09 + 0.003, z], EMBER, { glow: 1 });
}

/** A vertical boiler at `at` (its foot): banded iron, rivet rings, a domed top and a glowing firedoor facing `face` (+1 back, -1 front). */
function boiler(b: ModelBuilder, at: Vec3, r: number, h: number, face: number): void {
  const [x, y, z] = at;
  b.drum(r, r * 0.97, h, 12, [x, y + h / 2, z], IRON, { bevel: r * 0.15 });
  for (const k of [0.2, 0.75]) {
    b.cyl(r * 1.04, r * 1.04, 0.018, 12, [x, y + h * k, z], BRASS_D);
    rivetRing(b, [x, y + h * k + 0.016, z], r * 1.01, 7, 0.01);
  }
  b.sphere(r * 0.95, [x, y + h, z], IRON_M, { phi: Math.PI / 2, w: 12, h: 3, scale: [1, 0.4, 1] });
  b.box(r * 0.9, r * 0.7, 0.014, [x, y + h * 0.35, z + face * r], IRON_M);
  b.box(r * 0.7, r * 0.45, 0.016, [x, y + h * 0.35, z + face * (r + 0.002)], EMBER, { glow: 1 });
  for (const k of [-1, 0, 1]) b.box(0.006, r * 0.45, 0.018, [x + k * r * 0.2, y + h * 0.35, z + face * (r + 0.004)], SOOT);
}

/** An acetylene lamp: a dull brass can, a soot hood, an amber lens facing -Z. */
function lamp(b: ModelBuilder, at: Vec3, s = 0.03): void {
  const [x, y, z] = at;
  b.cyl(s * 0.5, s * 0.55, s, 8, [x, y, z], BRASS_D);
  b.cone(s * 0.5, s * 0.5, 6, [x, y + s * 0.75, z], SOOT);
  b.cyl(s * 0.4, s * 0.4, 0.006, 8, [x, y, z - s * 0.5], AMBER, { rot: [Math.PI / 2, 0, 0], glow: 1 });
}

/** A heap of coal lumps in a box (x0..x1, z0..z1) at height y, a few of them glowing. */
function coalHeap(b: ModelBuilder, x0: number, x1: number, z0: number, z1: number, y: number, n: number, s: number): void {
  for (let i = 0; i < n; i++) {
    const u = ((i * 0.618) % 1) * (x1 - x0) + x0;
    const v = ((i * 0.382 + 0.17) % 1) * (z1 - z0) + z0;
    b.box(s * 2, s * 1.4, s * 1.7, [u, y + (i % 3) * s * 0.4, v], i === 2 ? EMBER : i % 3 ? COAL : COAL_L, { rot: [i * 0.7, i * 1.3, i * 0.4], ...(i === 2 ? { glow: 0.6 } : {}) });
  }
}

// ---------------------------------------------------------------- units ---

/**
 * The Estafette: a steam motorcycle and its side-car. A riveted boiler slung
 * under the saddle with a glowing firebox, a little stack behind the rider
 * (in a comic spiked helmet and goggles), a team tank on the frame, an
 * acetylene lamp on the fork, and a team side-car tub with a brass rim, a
 * coal sack and its own wheel.
 */
function estafette(t: Team): ModelDef {
  const b = hullB();
  const x = -0.09;
  // two wheels, mudguards, the fork, the frame and the handlebar
  ironWheel(b, [x, 0.12, -0.3], 0.12, 0.045, 8);
  ironWheel(b, [x, 0.12, 0.24], 0.12, 0.05, 8);
  b.block(0.06, 0.012, 0.16, [x, 0.255, -0.3], t.dark, { bevel: 0.004 });
  b.block(0.06, 0.012, 0.18, [x, 0.255, 0.26], IRON_M, { bevel: 0.004 });
  for (const s of [1, -1]) strut(b, [x + s * 0.03, 0.12, -0.3], [x + s * 0.025, 0.34, -0.24], 0.009, IRON_M);
  b.block(0.035, 0.035, 0.46, [x, 0.25, -0.03], IRON, { rot: [0.08, 0, 0], bevel: 0.006 });
  b.box(0.22, 0.016, 0.016, [x, 0.34, -0.23], IRON_M);
  for (const s of [1, -1]) b.cyl(0.011, 0.011, 0.04, 6, [x + s * 0.11, 0.34, -0.23], OAK, { rot: AX });
  lamp(b, [x, 0.3, -0.32], 0.04);
  // the boiler under the saddle: banded, riveted, its firebox, the steam pipe up to the stack behind the rider
  b.tube(0.07, 0.2, 10, [x, 0.2, 0.06], IRON);
  for (const z of [-0.02, 0.06, 0.14]) b.add(new THREE.CylinderGeometry(0.074, 0.074, 0.014, 10, 1, true), [x, 0.2, z], BRASS_D, { rot: [Math.PI / 2, 0, 0] });
  b.cyl(0.07, 0.07, 0.01, 10, [x, 0.2, -0.042], IRON_M, { rot: [Math.PI / 2, 0, 0] });
  b.box(0.06, 0.04, 0.012, [x, 0.17, -0.047], EMBER, { glow: 1 });
  for (const s of [1, -1]) rivets(b, [x + s * 0.072, 0.22, -0.02], [x + s * 0.072, 0.22, 0.14], 4, 0.011);
  strut(b, [x + 0.05, 0.22, 0.1], [x + 0.06, 0.12, 0.34], 0.008, BRASS_D);
  stack(b, [x, 0.27, 0.2], 0.022, 0.28);
  // the team tank on the frame with a brass filler cap, the saddle and the rider
  b.block(0.11, 0.08, 0.18, [x, 0.32, -0.12], t.main, { bevel: 0.025, edge: 1.35 });
  b.box(0.112, 0.01, 0.182, [x, 0.3, -0.12], BRASS_D);
  b.cyl(0.015, 0.015, 0.016, 6, [x, 0.37, -0.14], BRASS_D);
  b.block(0.09, 0.03, 0.1, [x, 0.3, 0.04], OAK, { bevel: 0.01 });
  b.block(0.12, 0.14, 0.085, [x, 0.38, 0.0], IRON_M, { rot: [-0.3, 0, 0], bevel: 0.015 });
  for (const s of [1, -1]) b.box(0.025, 0.025, 0.12, [x + s * 0.06, 0.39, -0.07], IRON_M, { rot: [0.5, 0, 0] });
  b.box(0.08, 0.02, 0.06, [x, 0.45, -0.03], t.dark);
  b.sphere(0.032, [x, 0.485, -0.03], SKIN, { w: 7, h: 4 });
  b.sphere(0.04, [x, 0.51, -0.03], SOOT, { phi: Math.PI / 2, w: 8, h: 3 });
  b.cyl(0.042, 0.042, 0.008, 8, [x, 0.51, -0.03], BRASS_D);
  b.cone(0.012, 0.05, 6, [x, 0.565, -0.03], BRASS_D);
  b.box(0.06, 0.016, 0.01, [x, 0.49, -0.064], EMBER, { glow: 0.7 });
  // the side-car on its struts: a team tub with a brass rim and a soot apron, a coal sack, its own wheel
  const tub: Section[] = [[-0.25, 0.02, 0.22, 0.14], [-0.2, 0.07, 0.26, 0.11], [-0.12, 0.09, 0.275, 0.1], [0.06, 0.095, 0.28, 0.1], [0.15, 0.075, 0.27, 0.12]];
  b.fuselage(tub, [0.16, 0, 0], t.main, { chamfer: 0.03, edge: 1.35 });
  b.box(0.13, 0.012, 0.16, [0.16, 0.282, 0.03], SOOT);
  for (const s of [1, -1]) b.box(0.012, 0.012, 0.26, [0.16 + s * 0.09, 0.28, -0.02], BRASS_D);
  rivets(b, [0.16 + 0.097, 0.23, -0.15], [0.16 + 0.097, 0.23, 0.12], 5, 0.011);
  b.block(0.09, 0.07, 0.07, [0.16, 0.31, 0.08], 0x3a3228, { bevel: 0.02 });
  coalHeap(b, 0.13, 0.19, 0.06, 0.1, 0.35, 4, 0.016);
  ironWheel(b, [0.27, 0.1, 0.0], 0.1, 0.04, 8);
  for (const z of [-0.12, 0.12]) b.box(0.24, 0.02, 0.02, [0.06, 0.16, z], IRON_M);
  b.box(0.03, 0.03, 0.03, [0.16, 0.25, -0.25], EMBER, { glow: 0.6 });
  const hull = b.build();
  return { hull, mount: [0, 0, 0], muzzle: [x, 0.3, -0.35], rotors: [], height: 0.62 };
}

/**
 * The Mortier de 280: a siege mortar on a tracked locomobile. Linked iron
 * tracks over five road wheels and a sprocket a side, a riveted carriage
 * under a broad team plate, a banded boiler and its stack aft with a coal
 * bunker, a rack of shells, and on the riveted turntable a short, fat
 * hooped barrel cocked at the sky between massive cheeks, its elevating
 * handwheel and a brass breech.
 */
function mortier280(t: Team): ModelDef {
  const b = hullB();
  // the tracks: a linked belt over road wheels, a toothed sprocket in front, a mudguard over each
  for (const s of [1, -1]) {
    b.block(0.13, 0.13, 0.9, [s * 0.3, 0.075, 0], TYRE, { bevel: 0.04, edge: 1.6 });
    for (let i = 0; i < 9; i++) b.box(0.135, 0.012, 0.035, [s * 0.3, 0.145, -0.38 + i * 0.095], IRON_M);
    for (const z of [-0.3, -0.15, 0, 0.15, 0.3]) b.cyl(0.045, 0.045, 0.14, 6, [s * 0.3, 0.065, z], IRON_M, { rot: AX });
    b.cyl(0.06, 0.06, 0.142, 8, [s * 0.3, 0.08, -0.42], IRON, { rot: AX });
    b.cyl(0.02, 0.02, 0.15, 6, [s * 0.3, 0.08, -0.42], BRASS_D, { rot: AX });
    b.block(0.15, 0.014, 0.82, [s * 0.3, 0.165, 0.02], IRON, { bevel: 0.005 });
  }
  // the carriage and its team plate, riveted round, a team stripe down each flank
  b.block(0.5, 0.14, 0.86, [0, 0.2, 0], IRON, { bevel: 0.025 });
  b.block(0.66, 0.035, 0.62, [0, 0.285, -0.08], t.main, { bevel: 0.015, edge: 1.35 });
  for (const s of [1, -1]) {
    rivets(b, [s * 0.315, 0.305, -0.36], [s * 0.315, 0.305, 0.2], 6);
    rivets(b, [s * 0.252, 0.18, -0.38], [s * 0.252, 0.18, 0.38], 7, 0.011);
    b.box(0.006, 0.03, 0.8, [s * 0.251, 0.235, 0], t.dark);
  }
  rivets(b, [-0.28, 0.305, -0.385], [0.28, 0.305, -0.385], 5);
  rivets(b, [-0.28, 0.305, 0.225], [0.28, 0.305, 0.225], 5);
  // a rack of shells either side of the turntable: iron bodies, brass driving bands
  for (const s of [1, -1])
    for (const z of [-0.3, -0.22]) {
      b.cyl(0.03, 0.03, 0.09, 6, [s * 0.25, 0.35, z], IRON_M);
      b.cyl(0.032, 0.032, 0.012, 6, [s * 0.25, 0.32, z], BRASS_D);
      b.cone(0.03, 0.05, 6, [s * 0.25, 0.42, z], RIVET);
    }
  // aft: the banded boiler with its glowing firebox and stack, the coal bunker heaped high
  boiler(b, [0.14, 0.27, 0.33], 0.1, 0.26, 1);
  stack(b, [0.14, 0.56, 0.33], 0.035, 0.24);
  strut(b, [0.07, 0.46, 0.3], [0.05, 0.33, 0.2], 0.012, BRASS_D);
  b.block(0.18, 0.12, 0.2, [-0.15, 0.32, 0.33], IRON_M, { bevel: 0.01 });
  rivets(b, [-0.241, 0.36, 0.25], [-0.241, 0.36, 0.41], 4, 0.011);
  coalHeap(b, -0.21, -0.09, 0.27, 0.39, 0.39, 7, 0.022);
  lamp(b, [0.22, 0.33, -0.42], 0.04);
  lamp(b, [-0.22, 0.33, -0.42], 0.04);
  const hull = b.build();
  // the turntable, the cheeks, the trunnion and the fat hooped barrel
  const tu = partB();
  tu.drum(0.22, 0.2, 0.06, 12, [0, 0.03, 0], IRON_M, { bevel: 0.015 });
  rivetRing(tu, [0, 0.062, 0], 0.2, 10);
  for (const s of [1, -1]) {
    tu.block(0.05, 0.2, 0.26, [s * 0.13, 0.15, 0.02], IRON, { bevel: 0.015 });
    rivets(tu, [s * 0.157, 0.1, -0.08], [s * 0.157, 0.1, 0.12], 4, 0.012);
      }
  tu.cyl(0.035, 0.035, 0.33, 8, [0, 0.17, 0.02], BRASS_D, { rot: AX });
  for (const s of [1, -1]) tu.cyl(0.05, 0.05, 0.02, 8, [s * 0.165, 0.17, 0.02], IRON_M, { rot: AX });
  // the elevating handwheel on the right cheek
  tu.torus(0.045, 0.007, [0.17, 0.11, 0.1], BRASS_D, { rot: [0, Math.PI / 2, 0], seg: 10 });
  tu.box(0.012, 0.08, 0.012, [0.17, 0.11, 0.1], BRASS_D);
  const pitch = 1.0;
  const at: Vec3 = barrelTip([0, 0.17, 0.02], -0.12, pitch);
  barrel(tu, at, 0.1, 0.42, pitch, IRON, 10);
  barrel(tu, barrelTip(at, -0.04, pitch), 0.085, 0.06, pitch, BRASS_D, 12);
  for (const k of [0.1, 0.22]) barrel(tu, barrelTip(at, k, pitch), 0.108, 0.035, pitch, IRON_M, 12);
  barrel(tu, barrelTip(at, 0.35, pitch), 0.118, 0.07, pitch, IRON_M, 12);
  for (const k of [0.38]) {
    const c = barrelTip(at, k, pitch);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      tu.box(0.012, 0.012, 0.012, [c[0] + Math.sin(a) * 0.11, c[1] + Math.cos(a) * 0.11 * Math.cos(pitch), c[2] + Math.cos(a) * 0.11 * Math.sin(pitch)], RIVET);
    }
  }
  const tip = barrelTip(at, 0.42, pitch);
  tu.cyl(0.075, 0.075, 0.006, 10, tip, SOOT, { rot: [pitch - Math.PI / 2, 0, 0] });
  return { hull, turret: tu.build(), mount: [0, 0.3, -0.06], muzzle: tip, rotors: [], height: 0.85 };
}

/**
 * The Atelier roulant: a road locomobile carrying a workshop. A banded
 * vertical boiler and tall stack in front, the workshop under a riveted team
 * roof with a ridge vent, glowing windows, a workbench with an anvil, a vice
 * and a glowing forge behind, toolboxes and a coal box, and a lattice crane
 * (its `rotors`) slowly swinging its jib, a welding torch spitting at the hook.
 */
function atelier(t: Team): ModelDef {
  const b = hullB();
  b.block(0.36, 0.05, 0.86, [0, 0.16, 0], IRON, { bevel: 0.01 });
  rivets(b, [-0.181, 0.16, -0.4], [-0.181, 0.16, 0.4], 6, 0.011);
  rivets(b, [0.181, 0.16, -0.4], [0.181, 0.16, 0.4], 6, 0.011);
  for (const s of [1, -1]) {
    ironWheel(b, [s * 0.2, 0.1, -0.3], 0.1, 0.06, 8);
    ironWheel(b, [s * 0.24, 0.15, 0.27], 0.15, 0.07, 10);
    b.block(0.08, 0.014, 0.24, [s * 0.24, 0.31, 0.27], IRON_M, { bevel: 0.005 });
  }
  // the banded vertical boiler, its firedoor and stack, a brass whistle and a lamp
  boiler(b, [0, 0.18, -0.3], 0.11, 0.3, -1);
  stack(b, [0, 0.5, -0.3], 0.035, 0.3);
  b.cyl(0.008, 0.012, 0.05, 6, [0.07, 0.5, -0.28], BRASS_D);
  lamp(b, [0.15, 0.24, -0.42], 0.036);
  lamp(b, [-0.15, 0.24, -0.42], 0.036);
  // the workshop: riveted iron walls, glowing windows, under an overhanging team roof with a ridge vent
  b.block(0.4, 0.24, 0.42, [0, 0.31, 0.07], IRON_M, { bevel: 0.02 });
  for (const s of [1, -1]) {
    for (const z of [0.0, 0.14]) {
      b.box(0.006, 0.07, 0.09, [s * 0.202, 0.34, z], EMBER, { glow: 0.55 });
      b.box(0.008, 0.07, 0.008, [s * 0.203, 0.34, z], SOOT);
    }
    rivets(b, [s * 0.204, 0.21, -0.12], [s * 0.204, 0.21, 0.26], 6, 0.011);
      }
  for (const s of [1, -1]) b.block(0.26, 0.04, 0.52, [s * 0.11, 0.465, 0.06], t.main, { rot: [0, 0, s * -0.22], bevel: 0.012, edge: 1.35 });
  b.block(0.08, 0.05, 0.4, [0, 0.505, 0.06], t.dark, { bevel: 0.01 });
  for (const z of [-0.06, 0.06, 0.18]) b.box(0.09, 0.01, 0.02, [0, 0.53, z], IRON);
  for (const s of [1, -1]) rivets(b, [s * 0.235, 0.435, -0.16], [s * 0.235, 0.435, 0.28], 5, 0.011);
  // the workbench and forge at the back: an oak bench, an anvil, a vice, the forge glowing under its hood
  b.block(0.34, 0.03, 0.12, [0, 0.27, 0.38], OAK_L, { bevel: 0.006 });
  for (const s of [1, -1]) b.box(0.02, 0.08, 0.02, [s * 0.15, 0.22, 0.42], OAK);
  b.block(0.1, 0.06, 0.08, [-0.1, 0.31, 0.38], IRON_M, { bevel: 0.01 });
  b.box(0.07, 0.025, 0.06, [-0.1, 0.35, 0.38], EMBER, { glow: 1 });
  b.cone(0.05, 0.08, 6, [-0.1, 0.42, 0.38], IRON);
  b.cyl(0.012, 0.012, 0.1, 6, [-0.1, 0.5, 0.38], IRON);
  b.box(0.08, 0.03, 0.035, [0.06, 0.3, 0.38], STEEL);
  b.cone(0.016, 0.04, 4, [0.115, 0.3, 0.38], STEEL, { rot: [0, 0, -Math.PI / 2] });
  b.box(0.024, 0.03, 0.03, [0.13, 0.3, 0.42], IRON);
  // toolboxes and a coal box on the running boards
  for (const s of [1, -1]) {
    b.block(0.05, 0.05, 0.18, [s * 0.215, 0.215, -0.06], OAK, { bevel: 0.008 });
    b.box(0.052, 0.006, 0.182, [s * 0.215, 0.22, -0.06], BRASS_D);
  }
  // the crane's mast and its brass slewing ring
  b.cyl(0.03, 0.04, 0.08, 8, [0.12, 0.52, 0.24], IRON);
  b.cyl(0.045, 0.045, 0.012, 10, [0.12, 0.565, 0.24], BRASS_D);
  const hull = b.build();
  // the crane: a post, a lattice jib with a tie, the hook line and a welding torch glowing at the hook
  const cr = partB();
  cr.cyl(0.022, 0.022, 0.16, 6, [0, 0.08, 0], IRON_M);
  strut(cr, [0, 0.06, 0], [0.28, 0.16, 0], 0.012, IRON);
  strut(cr, [0, 0.16, 0], [0.28, 0.17, 0], 0.01, IRON);
  for (let i = 0; i < 4; i++) {
    const x0 = 0.03 + i * 0.065;
    strut(cr, [x0, 0.07 + x0 * 0.36, 0], [x0 + 0.065, 0.16 + (x0 + 0.065) * 0.035, 0], 0.005, IRON_M);
  }
  cr.cyl(0.02, 0.02, 0.02, 8, [0.28, 0.165, 0], BRASS_D, { rot: [Math.PI / 2, 0, 0] });
  cr.box(0.004, 0.11, 0.004, [0.28, 0.1, 0], RIVET);
  cr.torus(0.014, 0.004, [0.28, 0.04, 0], STEEL, { seg: 8 });
  cr.sphere(0.018, [0.28, 0.03, 0.02], EMBER, { glow: 1, w: 6, h: 4 });
  cr.box(0.04, 0.004, 0.004, [0.28, 0.03, 0.02], 0xfff0c0, { glow: 1, rot: [0, 0.6, 0.4] });
  cr.box(0.06, 0.04, 0.04, [-0.05, 0.12, 0], IRON_M);
  return {
    hull, mount: [0, 0, 0], muzzle: [0.12, 0.64, 0.24], height: 0.8,
    rotors: [{ geo: cr.build(), at: [0.12, 0.57, 0.24], axis: "y", speed: 0.6 }]
  };
}

export const GROUND_EMP: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  estafette: estafette,
  "mortier-280": mortier280,
  atelier: atelier
};
