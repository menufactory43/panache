import type { UnitKind } from "../../../sim/types";
import type { ModelBuilder, Section, Vec3 } from "../builder";
import { barrel, barrelTip, hullB, partB, strut, type ModelDef, type Team } from "../models";

/**
 * The Empire de Carbonie's new ground vehicles (PANACHE-CONCEPTION.md §1.11,
 * WP5b): Estafette, Mortier de 280, Atelier roulant. Same contract as
 * models.ts UNIT_MODELS, under the §3.4 budget of 600 triangles a unit. The
 * Empire's look: soot-black riveted iron, coal, smokestacks and a red-hot glow.
 */

/** Soot-black iron, its worn edges, rivet heads, soot, coal, the firebox glow, dull brass, oak. */
const IRON = 0x2b2725;
const IRON_M = 0x4a423b;
const RIVET = 0x8a7c6a;
const SOOT = 0x120e0c;
const COAL = 0x1f1b18;
const EMBER = 0xff5a1e;
const BRASS_D = 0xa8843e;
const OAK = 0x5e3d22;
const TYRE = 0x1a1716;
const SKIN = 0xd8ae90;

/** An iron road wheel turning about X: a tyre and a dull brass hub. */
function wheel(b: ModelBuilder, at: Vec3, r: number, w: number, seg = 8): void {
  b.cyl(r, r, w, seg, at, TYRE, { rot: [0, 0, Math.PI / 2] });
  b.cyl(r * 0.4, r * 0.4, w + 0.012, 4, at, BRASS_D, { rot: [0, 0, Math.PI / 2] });
}

/** A row of rivet heads from `a` to `c`. */
function rivets(b: ModelBuilder, a: Vec3, c: Vec3, n: number, s = 0.016): void {
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0.5 : i / (n - 1);
    b.box(s, s, s, [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k], RIVET);
  }
}

/** A smokestack standing on `base`: iron, a flared soot crown, an ember glow at the lip. */
function stack(b: ModelBuilder, base: Vec3, r: number, h: number): void {
  const [x, y, z] = base;
  b.cyl(r, r * 1.1, h, 6, [x, y + h / 2, z], IRON);
  b.cyl(r * 1.6, r * 1.05, h * 0.18, 6, [x, y + h, z], SOOT);
  b.cyl(r * 0.9, r * 0.9, 0.01, 6, [x, y + h * 1.09, z], EMBER, { glow: 0.7 });
}

// ---------------------------------------------------------------- units ---

/**
 * The Estafette: a steam motorcycle and its side-car. A boiler slung under
 * the saddle with a glowing firebox, a little stack behind the rider (in a
 * comic spiked helmet), a team tank on the frame and a team side-car.
 */
function estafette(t: Team): ModelDef {
  const b = hullB();
  const x = -0.09;
  // two wheels, the fork, the frame and the handlebar
  wheel(b, [x, 0.12, -0.3], 0.12, 0.045);
  wheel(b, [x, 0.12, 0.24], 0.12, 0.05);
  strut(b, [x, 0.12, -0.3], [x, 0.33, -0.24], 0.012, IRON_M);
  b.box(0.035, 0.035, 0.46, [x, 0.25, -0.03], IRON, { rot: [0.08, 0, 0] });
  b.box(0.2, 0.016, 0.016, [x, 0.34, -0.23], IRON_M);
  // the boiler under the saddle, its firebox, the stack behind the rider
  b.tube(0.07, 0.2, 8, [x, 0.2, 0.06], IRON);
  b.box(0.06, 0.04, 0.012, [x, 0.17, -0.045], EMBER, { glow: 0.9 });
  rivets(b, [x - 0.07, 0.22, -0.02], [x - 0.07, 0.22, 0.14], 3, 0.014);
  stack(b, [x, 0.27, 0.2], 0.022, 0.28);
  // the team tank on the frame, the saddle and the rider
  b.block(0.11, 0.08, 0.18, [x, 0.32, -0.12], t.main, { bevel: 0.02, edge: 1.35 });
  b.box(0.08, 0.03, 0.09, [x, 0.3, 0.04], OAK);
  b.box(0.11, 0.13, 0.08, [x, 0.38, 0.0], IRON_M, { rot: [-0.3, 0, 0] });
  b.box(0.055, 0.055, 0.055, [x, 0.48, -0.03], SKIN);
  b.cyl(0.036, 0.036, 0.03, 6, [x, 0.52, -0.03], SOOT);
  b.cone(0.012, 0.05, 4, [x, 0.56, -0.03], BRASS_D);
  b.box(0.06, 0.016, 0.01, [x, 0.49, -0.06], EMBER, { glow: 0.6 });
  // the side-car on its struts: a team tub, a coal sack, its own wheel
  const tub: Section[] = [[-0.24, 0.02, 0.22, 0.14], [-0.17, 0.085, 0.27, 0.1], [0.06, 0.09, 0.28, 0.1], [0.15, 0.07, 0.27, 0.12]];
  b.fuselage(tub, [0.16, 0, 0], t.main, { chamfer: 0.03, edge: 1.35 });
  b.box(0.1, 0.012, 0.14, [0.16, 0.282, 0.02], SOOT);
  b.box(0.08, 0.06, 0.06, [0.16, 0.3, 0.08], COAL);
  wheel(b, [0.27, 0.1, 0.0], 0.1, 0.04);
  for (const z of [-0.12, 0.12]) b.box(0.24, 0.02, 0.02, [0.06, 0.16, z], IRON_M);
  b.box(0.035, 0.035, 0.03, [x, 0.3, -0.27], EMBER, { glow: 0.6 });
  b.box(0.03, 0.03, 0.03, [0.16, 0.25, -0.25], EMBER, { glow: 0.6 });
  const hull = b.build();
  return { hull, mount: [0, 0, 0], muzzle: [x, 0.3, -0.35], rotors: [], height: 0.62 };
}

/**
 * The Mortier de 280: a siege mortar on a tracked locomobile. Iron tracks,
 * a riveted carriage under a broad team plate, a boiler and its stack aft
 * with a coal bunker, and on the turntable a short, fat barrel cocked at
 * the sky between massive cheeks.
 */
function mortier280(t: Team): ModelDef {
  const b = hullB();
  // the tracks, three road wheels a side
  for (const s of [1, -1]) {
    b.block(0.13, 0.14, 0.92, [s * 0.3, 0.08, 0], TYRE, { bevel: 0.035, edge: 1.6 });
    for (const z of [-0.28, 0.28]) b.cyl(0.055, 0.055, 0.14, 6, [s * 0.3, 0.07, z], IRON_M, { rot: [0, 0, Math.PI / 2] });
  }
  // the carriage and its team plate, riveted round
  b.block(0.5, 0.14, 0.86, [0, 0.19, 0], IRON, { bevel: 0.025 });
  b.block(0.66, 0.035, 0.62, [0, 0.28, -0.08], t.main, { bevel: 0.015, edge: 1.35 });
  for (const s of [1, -1]) rivets(b, [s * 0.31, 0.3, -0.3], [s * 0.31, 0.3, 0.14], 2);
  // aft: the boiler with its glowing firebox and stack, the coal bunker
  b.cyl(0.1, 0.1, 0.26, 6, [0.14, 0.4, 0.33], IRON);
  b.cyl(0.105, 0.105, 0.025, 6, [0.14, 0.47, 0.33], BRASS_D);
  b.box(0.07, 0.06, 0.012, [0.14, 0.33, 0.435], EMBER, { glow: 0.9 });
  stack(b, [0.14, 0.53, 0.33], 0.035, 0.24);
  b.box(0.18, 0.12, 0.2, [-0.15, 0.32, 0.33], IRON_M);
  b.box(0.15, 0.03, 0.17, [-0.15, 0.385, 0.33], COAL);
  const hull = b.build();
  // the turntable, the cheeks, the trunnion and the fat barrel
  const tu = partB();
  tu.drum(0.22, 0.2, 0.06, 8, [0, 0.03, 0], IRON_M, { bevel: 0.015 });
  tu.pairBlock(0.05, 0.2, 0.26, [0.13, 0.15, 0.02], IRON, { bevel: 0.015 });
  tu.cyl(0.035, 0.035, 0.33, 6, [0, 0.17, 0.02], BRASS_D, { rot: [0, 0, Math.PI / 2] });
  const pitch = 1.0;
  const at: Vec3 = barrelTip([0, 0.17, 0.02], -0.12, pitch);
  barrel(tu, at, 0.1, 0.42, pitch, IRON, 8);
  barrel(tu, barrelTip(at, 0.37, pitch), 0.115, 0.06, pitch, BRASS_D, 8);
  const tip = barrelTip(at, 0.42, pitch);
  tu.cyl(0.075, 0.075, 0.006, 8, tip, SOOT, { rot: [pitch - Math.PI / 2, 0, 0] });
  return { hull, turret: tu.build(), mount: [0, 0.3, -0.06], muzzle: tip, rotors: [], height: 0.85 };
}

/**
 * The Atelier roulant: a road locomobile carrying a workshop. A vertical
 * boiler and tall stack in front, the workshop under a team roof, a
 * workbench and glowing forge behind, and a little crane (its `rotors`)
 * slowly swinging its jib and welding hook.
 */
function atelier(t: Team): ModelDef {
  const b = hullB();
  b.box(0.36, 0.05, 0.86, [0, 0.16, 0], IRON);
  for (const s of [1, -1]) {
    wheel(b, [s * 0.2, 0.1, -0.3], 0.1, 0.06);
    wheel(b, [s * 0.24, 0.15, 0.27], 0.15, 0.07);
  }
  // the vertical boiler, its brass band, firedoor and stack
  b.cyl(0.11, 0.11, 0.3, 8, [0, 0.33, -0.3], IRON);
  b.box(0.08, 0.07, 0.012, [0, 0.28, -0.413], EMBER, { glow: 0.9 });
  stack(b, [0, 0.48, -0.3], 0.035, 0.3);
  // the workshop under its team roof (overhanging, riveted iron walls below)
  b.block(0.4, 0.24, 0.42, [0, 0.31, 0.07], IRON_M, { bevel: 0.02 });
  b.pair(0.006, 0.08, 0.2, [0.202, 0.34, 0.07], EMBER, { glow: 0.45 });
  for (const s of [1, -1]) rivets(b, [s * 0.204, 0.23, -0.06], [s * 0.204, 0.23, 0.2], 2);
  b.block(0.48, 0.05, 0.5, [0, 0.455, 0.06], t.main, { bevel: 0.02, edge: 1.35, taper: 0.12 });
  // the workbench and forge at the back
  b.box(0.34, 0.03, 0.12, [0, 0.27, 0.38], OAK);
  b.box(0.1, 0.06, 0.08, [-0.1, 0.31, 0.38], IRON_M);
  b.box(0.06, 0.03, 0.06, [-0.1, 0.35, 0.38], EMBER, { glow: 1 });
  b.cyl(0.03, 0.04, 0.12, 6, [0.12, 0.54, 0.24], IRON);
  const hull = b.build();
  // the crane: a post, a jib, the hook line and a welding torch glowing at the hook
  const cr = partB();
  cr.cyl(0.022, 0.022, 0.14, 6, [0, 0.07, 0], IRON_M);
  strut(cr, [0, 0.1, 0], [0.26, 0.2, 0], 0.016, IRON);
  cr.box(0.006, 0.12, 0.006, [0.26, 0.14, 0], RIVET);
  cr.box(0.03, 0.03, 0.03, [0.26, 0.07, 0], EMBER, { glow: 1 });
  return {
    hull, mount: [0, 0, 0], muzzle: [0.12, 0.62, 0.24], height: 0.8,
    rotors: [{ geo: cr.build(), at: [0.12, 0.6, 0.24], axis: "y", speed: 0.6 }]
  };
}

export const GROUND_EMP: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  estafette: estafette,
  "mortier-280": mortier280,
  atelier: atelier
};
