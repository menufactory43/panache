import type { Nation, UnitKind } from "../../../sim/types";
import type { ModelBuilder, Section, Vec3 } from "../builder";
import { BRASS, TEAMS, barrel, barrelTip, hullB, partB, strut, type ModelDef, type Team } from "../models";
import { NATION_TEAMS } from "./placeholders";

/**
 * The République's new ground vehicles (PANACHE-CONCEPTION.md §1.11, WP5a):
 * Fourgon Jeantaud, Jamais-Contente, Autocanon De Dion, Canon Branly.
 * Same contract as models.ts UNIT_MODELS (origin on the ground at the hull
 * centre, nose toward -Z, turret/mount/muzzle, cargo for the worker), kept
 * under the §3.4 budget of 600 triangles a unit. The République's look:
 * ivory lacquer, nickel, glass, copper windings and electric-blue sparks.
 */

/** Ivory coachwork, nickel plate, black lacquer, buttoned leather, copper windings, glass, the electric spark. */
const IVORY = 0xece2c6;
const NICKEL = 0xc9cdd2;
const LACQUER = 0x1c2129;
const LEATHER = 0x5a2a1e;
const COPPER = 0xc07440;
const GLASS = 0x9cc8e8;
const SPARK = 0x9fe0ff;
const TYRE = 0x1a1a1c;
const SKIN = 0xe0b89a;
const COAL = 0x1f1b18;
const RADIUM = 0xd4ffd8;

/** models.ts paints a unit with its side's colours (TEAMS): repaint it in its nation's (§1.1, placeholders.ts NATION_TEAMS). */
export function inNation(n: Nation, make: (t: Team) => ModelDef): (t: Team) => ModelDef {
  return (t) => make(t.main === TEAMS.red.main ? NATION_TEAMS[n].red : t.main === TEAMS.blue.main ? NATION_TEAMS[n].blue : t);
}

/** A light carriage wheel turning about X: a black rubber tyre and a nickel hub. */
function wheel(b: ModelBuilder, at: Vec3, r: number, w: number, hub = NICKEL, seg = 8): void {
  b.cyl(r, r, w, seg, at, TYRE, { rot: [0, 0, Math.PI / 2] });
  b.cyl(r * 0.55, r * 0.55, w + 0.012, 4, at, hub, { rot: [0, 0, Math.PI / 2] });
}

/** A seated figure from the waist up facing -Z: a coat, a head and a flat cap. */
function driver(b: ModelBuilder, at: Vec3, coat: number, cap: number): void {
  const [x, y, z] = at;
  b.box(0.09, 0.1, 0.07, [x, y + 0.05, z], coat);
  b.box(0.05, 0.05, 0.05, [x, y + 0.125, z - 0.005], SKIN);
  b.box(0.064, 0.02, 0.064, [x, y + 0.158, z - 0.005], cap);
}

// ---------------------------------------------------------------- units ---

/**
 * The Fourgon Jeantaud (worker): an electric delivery van after Jeantaud's
 * electric cab. A padded ivory box body with glass windows, the coachman's
 * seat out front under a team roof that runs the whole length (the patch
 * seen from above), copper battery boxes on a rear tray, and a trolley pole
 * whose tip sparks blue. `cargo`: coal and glowing radium on the rear tray.
 */
function fourgon(t: Team): ModelDef {
  const b = hullB();
  // chassis, wheels (small in front, larger behind)
  b.box(0.3, 0.04, 0.84, [0, 0.15, 0.02], LACQUER);
  for (const s of [1, -1]) {
    wheel(b, [s * 0.2, 0.1, -0.28], 0.1, 0.05);
    wheel(b, [s * 0.21, 0.13, 0.25], 0.13, 0.055);
  }
  // the dashboard and the coachman on a buttoned bench
  b.block(0.32, 0.1, 0.14, [0, 0.22, -0.36], IVORY, { bevel: 0.03, taper: 0.15 });
  b.box(0.3, 0.06, 0.1, [0, 0.26, -0.22], LEATHER);
  driver(b, [0, 0.29, -0.23], LACQUER, t.dark);
  // the box body: ivory panels, glass windows on both flanks and over the seat
  b.block(0.36, 0.32, 0.4, [0, 0.33, 0.06], IVORY, { bevel: 0.025 });
  b.pair(0.006, 0.1, 0.24, [0.182, 0.39, 0.04], GLASS, { glow: 0.25 });
  b.box(0.22, 0.1, 0.006, [0, 0.39, -0.142], GLASS, { glow: 0.25 });
  // the roof over seat and body, nickel-edged; two nickel posts hold its front
  b.block(0.42, 0.04, 0.78, [0, 0.51, -0.06], t.main, { bevel: 0.016, edge: 1.35 });
  b.box(0.43, 0.012, 0.79, [0, 0.488, -0.06], NICKEL);
  b.pair(0.014, 0.2, 0.014, [0.19, 0.38, -0.43], NICKEL);
  // headlamps and the trolley pole, leaning back, its shoe sparking
  b.pair(0.035, 0.035, 0.035, [0.13, 0.25, -0.44], SPARK, { glow: 0.9 });
  strut(b, [0.1, 0.53, -0.1], [0.1, 0.74, 0.32], 0.01, NICKEL);
  b.box(0.04, 0.03, 0.04, [0.1, 0.75, 0.33], SPARK, { glow: 1 });
  // the rear tray with its copper battery boxes and glass cells
  b.box(0.36, 0.03, 0.2, [0, 0.2, 0.36], LACQUER);
  for (const s of [1, -1]) {
    b.block(0.1, 0.12, 0.18, [s * 0.13, 0.28, 0.36], COPPER, { bevel: 0.015 });
    b.box(0.07, 0.03, 0.06, [s * 0.13, 0.355, 0.36], GLASS, { glow: 0.4 });
  }
  const hull = b.build();
  // the load between the battery boxes: coal, and radium glowing green-white
  const c = partB();
  const lumps: [number, number, number][] = [[-0.03, 0.31, 0.045], [0.035, 0.42, 0.04], [-0.035, 0.41, 0.04], [0.01, 0.36, 0.05]];
  lumps.forEach(([x, z, s], i) => c.box(s * 2, s * 1.4, s * 1.8, [x, 0.24 + s * 0.7 + (i === 3 ? 0.04 : 0), z], COAL, { rot: [i * 0.7, i * 1.3, 0] }));
  for (const [x, z] of [[0.03, 0.34], [-0.03, 0.39]] as [number, number][]) c.box(0.03, 0.04, 0.03, [x, 0.33, z], RADIUM, { glow: 0.85 });
  return { hull, mount: [0, 0, 0], muzzle: [0, 0.25, -0.46], rotors: [], cargo: c.build(), height: 0.76 };
}

/**
 * The Jamais-Contente: Jenatzy's torpedo-shaped electric record car turned
 * light raider. A nickel torpedo on four slender wheels, its front half in
 * team colour, the driver sitting up out of it, and on the bonnet a little
 * arc turret: twin copper horns either side of a blue spark.
 */
function jamaisContente(t: Team): ModelDef {
  const b = hullB();
  const body: Section[] = [
    [-0.46, 0.012, 0.2, 0.18], [-0.38, 0.07, 0.26, 0.12], [-0.22, 0.1, 0.3, 0.1],
    [0.12, 0.1, 0.3, 0.1], [0.32, 0.075, 0.27, 0.12], [0.46, 0.012, 0.21, 0.18]
  ];
  b.fuselage(body, [0, 0, 0], NICKEL, { chamfer: 0.04, edge: 1.25 });
  // the front spindle in team colour, a hair proud of the nickel
  const nose: Section[] = [[-0.47, 0.016, 0.206, 0.176], [-0.385, 0.077, 0.268, 0.114], [-0.22, 0.107, 0.307, 0.094], [0.02, 0.107, 0.307, 0.094]];
  b.fuselage(nose, [0, 0, 0], t.main, { chamfer: 0.042, edge: 1.35 });
  b.box(0.012, 0.012, 0.3, [0, 0.31, 0.2], t.main);
  // four slender wheels on nickel axles
  for (const z of [-0.26, 0.26]) {
    b.cyl(0.008, 0.008, 0.34, 4, [0, 0.11, z], NICKEL, { rot: [0, 0, Math.PI / 2] });
    for (const s of [1, -1]) wheel(b, [s * 0.17, 0.11, z], 0.11, 0.03);
  }
  // the driver sitting up out of the body, a windscreen, a spark trail grille at the tail
  driver(b, [0, 0.27, 0.12], LACQUER, LEATHER);
  b.box(0.12, 0.05, 0.006, [0, 0.33, 0.04], GLASS, { glow: 0.3, rot: [-0.4, 0, 0] });
  b.box(0.05, 0.02, 0.06, [0, 0.21, 0.45], SPARK, { glow: 0.8 });
  const hull = b.build();
  // the arc turret: a nickel drum, a Leyden jar, two copper horns round a spark
  const tu = partB();
  tu.cyl(0.07, 0.08, 0.04, 8, [0, 0.02, 0], NICKEL);
  tu.cyl(0.035, 0.035, 0.07, 6, [0, 0.07, 0.035], GLASS, { glow: 0.3 });
  tu.box(0.02, 0.02, 0.02, [0, 0.115, 0.035], BRASS);
  for (const s of [1, -1]) strut(tu, [s * 0.03, 0.04, -0.02], [s * 0.04, 0.07, -0.17], 0.009, COPPER);
  tu.box(0.035, 0.035, 0.035, [0, 0.065, -0.17], SPARK, { glow: 1, rot: [0.6, 0.6, 0] });
  return { hull, turret: tu.build(), mount: [0, 0.3, -0.22], muzzle: [0, 0.065, -0.18], rotors: [], height: 0.6 };
}

/**
 * The Autocanon De Dion: a De Dion-Bouton tricar, a driver astride the front
 * wheel, and on the rear deck (team colour) a pivoting revolver cannon of
 * four barrels pitched at the sky behind a team shield.
 */
function deDion(t: Team): ModelDef {
  const b = hullB();
  // the front wheel in its fork, the handlebar, the saddle and the driver
  wheel(b, [0, 0.12, -0.34], 0.12, 0.05);
  b.pair(0.014, 0.2, 0.014, [0.04, 0.2, -0.33], NICKEL, { rot: [0.25, 0, 0] });
  b.box(0.2, 0.014, 0.014, [0, 0.31, -0.31], NICKEL);
  b.box(0.06, 0.05, 0.36, [0, 0.2, -0.12], LACQUER);
  b.box(0.1, 0.03, 0.1, [0, 0.25, -0.16], LEATHER);
  driver(b, [0, 0.27, -0.17], IVORY, t.dark);
  // the De Dion engine, brass-finned, between the rear wheels
  b.cyl(0.045, 0.045, 0.1, 6, [0, 0.19, 0.0], BRASS);
  // the rear axle, its wheels and mudguards, the gun deck in team colour
  b.cyl(0.015, 0.015, 0.46, 4, [0, 0.14, 0.16], LACQUER, { rot: [0, 0, Math.PI / 2] });
  for (const s of [1, -1]) {
    wheel(b, [s * 0.23, 0.14, 0.16], 0.14, 0.05);
    b.box(0.07, 0.014, 0.24, [s * 0.23, 0.295, 0.16], IVORY);
  }
  b.block(0.4, 0.05, 0.36, [0, 0.235, 0.15], t.main, { bevel: 0.015, edge: 1.35 });
  b.box(0.41, 0.016, 0.37, [0, 0.212, 0.15], NICKEL);
  const hull = b.build();
  // the pivot, the curved shield, the revolver cannon at the sky
  const tu = partB();
  tu.cyl(0.08, 0.09, 0.05, 8, [0, 0.025, 0], NICKEL);
  for (const s of [1, -1]) tu.block(0.13, 0.17, 0.02, [s * 0.07, 0.12, -0.11], t.main, { rot: [-0.25, s * -0.35, 0], bevel: 0.008, edge: 1.35 });
  tu.pair(0.02, 0.1, 0.06, [0.05, 0.1, 0], LACQUER);
  const pitch = 1.05;
  const at: Vec3 = [0, 0.12, 0.02];
  tu.cyl(0.05, 0.05, 0.1, 8, barrelTip(at, 0.05, pitch), LACQUER, { rot: [pitch - Math.PI / 2, 0, 0] });
  for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][])
    barrel(tu, [at[0] + u * 0.022, at[1] + v * 0.022 * Math.cos(pitch), at[2] + v * 0.022 * Math.sin(pitch)], 0.012, 0.32, pitch, LACQUER, 4);
  tu.cyl(0.042, 0.042, 0.02, 8, barrelTip(at, 0.28, pitch), NICKEL, { rot: [pitch - Math.PI / 2, 0, 0] });
  tu.box(0.016, 0.016, 0.07, [0.07, 0.12, 0.06], BRASS);
  return { hull, turret: tu.build(), mount: [0, 0.26, 0.16], muzzle: barrelTip(at, 0.33, pitch), rotors: [], height: 0.62 };
}

/**
 * The Canon Branly: an electromagnetic gun. Two solid disc wheels, a trail
 * carrying an ivory dynamo, and on the pivot a long nickel tube threaded
 * with team-coloured coils between copper windings, a capacitor box over
 * the breech, and a blue glow at the muzzle.
 */
function branly(t: Team): ModelDef {
  const b = hullB();
  b.cyl(0.022, 0.022, 0.52, 6, [0, 0.17, -0.04], LACQUER, { rot: [0, 0, Math.PI / 2] });
  for (const s of [1, -1]) {
    b.cyl(0.17, 0.17, 0.05, 8, [s * 0.25, 0.17, -0.04], TYRE, { rot: [0, 0, Math.PI / 2] });
    b.cyl(0.13, 0.13, 0.056, 8, [s * 0.25, 0.17, -0.04], IVORY, { rot: [0, 0, Math.PI / 2] });
  }
  // the trail back to its spade, the dynamo on it, copper-wound
  b.box(0.1, 0.06, 0.5, [0, 0.13, 0.24], LACQUER, { rot: [0.22, 0, 0] });
  b.box(0.18, 0.08, 0.025, [0, 0.04, 0.48], LACQUER, { rot: [0.3, 0, 0] });
  b.cyl(0.06, 0.06, 0.16, 8, [0, 0.2, 0.26], IVORY, { rot: [0, 0, Math.PI / 2] });
  b.cyl(0.064, 0.064, 0.06, 6, [0, 0.2, 0.26], COPPER, { rot: [0, 0, Math.PI / 2] });
  b.box(0.16, 0.06, 0.1, [0, 0.21, 0.4], t.main);
  b.cyl(0.09, 0.08, 0.06, 8, [0, 0.21, -0.04], NICKEL);
  const hull = b.build();
  // the gun: cradle cheeks, the capacitor box, the tube and its coils
  const tu = partB();
  const pitch = 0.32;
  const at: Vec3 = [0, 0.09, 0.2];
  tu.pair(0.025, 0.1, 0.2, [0.06, 0.06, 0.04], LACQUER);
  tu.block(0.2, 0.11, 0.2, [0, 0.1, 0.17], t.main, { bevel: 0.02, edge: 1.35 });
  barrel(tu, at, 0.028, 0.86, pitch, NICKEL, 8);
  for (const k of [0.28, 0.42, 0.56, 0.7]) {
    barrel(tu, barrelTip(at, k - 0.045, pitch), 0.072, 0.09, pitch, t.main, 8);
    barrel(tu, barrelTip(at, k + 0.045, pitch), 0.05, 0.02, pitch, COPPER, 6);
  }
  const tip = barrelTip(at, 0.86, pitch);
  tu.box(0.05, 0.05, 0.05, tip, SPARK, { glow: 1, rot: [0.6, 0.6, 0] });
  return { hull, turret: tu.build(), mount: [0, 0.24, -0.04], muzzle: tip, rotors: [], height: 0.62 };
}

export const GROUND_REP: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  fourgon: inNation("republique", fourgon),
  "jamais-contente": inNation("republique", jamaisContente),
  "de-dion": inNation("republique", deDion),
  branly: inNation("republique", branly)
};
