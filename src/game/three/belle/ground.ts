import type { UnitKind } from "../../../sim/types";
import { ModelBuilder, type Section, type Vec3 } from "../builder";
import {
  AMBER, BARREL, BRASS, CRAWLER_LEGS, GM, GM_D, GM_L, TRACK, WHITE,
  barrel, barrelTip, hullB, light, partB, skirt, strut, tracks, type ModelDef, type Team
} from "../models";

/**
 * Belle Époque ground vehicles (theme.ts): Harvester → Fardier, Stinger → Panhard,
 * Flak Crawler → Faucheux, Mortar → Canon de 75, Mastodon → Creusot, Lancer → Hydroglisseur.
 * Same contract as models.ts UNIT_MODELS: origin on the ground at the hull centre, nose
 * toward -Z, a team patch on top, turret/mount/muzzle, rotors, cargo and the crawler's legs.
 */

/** Varnished oak, its lighter planking, soot, boiler copper and the radium's glow. */
const WOOD = 0x6b4628;
const WOOD_L = 0x8f6236;
const SOOT = 0x16110d;
const COPPER = 0xb36a3a;
const RADIUM = 0xd4ffd8;
const COAL = 0x1f1b18;

/**
 * A spoked carriage wheel turning about X: an iron tyre, a wooden felloe,
 * `n` wooden spokes and a brass hub, `w` wide.
 */
function spokedWheel(b: ModelBuilder, at: Vec3, r: number, w: number, n = 8, spoke = WOOD_L): void {
  const tyre = r * 0.11;
  b.torus(r - tyre, tyre, at, TRACK, { rot: [0, Math.PI / 2, 0], scale: [1, 1, w / (2 * tyre)], seg: 14 });
  b.torus(r - tyre * 2.4, tyre * 0.7, at, WOOD, { rot: [0, Math.PI / 2, 0], scale: [1, 1, (w * 0.7) / (2 * tyre * 0.7)], seg: 14 });
  for (let i = 0; i < n / 2; i++) b.box(w * 0.35, r * 1.7, r * 0.09, at, spoke, { rot: [(i * Math.PI * 2) / n, 0, 0] });
  b.cyl(r * 0.2, r * 0.2, w * 1.15, 8, at, BRASS, { rot: [0, 0, Math.PI / 2] });
  b.cyl(r * 0.09, r * 0.09, w * 1.4, 6, at, GM_D, { rot: [0, 0, Math.PI / 2] });
}

/** A row of rivet heads from `a` to `c`. */
function rivets(b: ModelBuilder, a: Vec3, c: Vec3, n: number, s = 0.012, hex = GM_L): void {
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0.5 : i / (n - 1);
    b.box(s, s, s, [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k], hex);
  }
}

/** A smokestack standing on `base`: blackened iron, a brass band, a flared soot-dark crown. */
function stack(b: ModelBuilder, base: Vec3, r: number, h: number): void {
  const [x, y, z] = base;
  b.cyl(r, r * 1.1, h, 8, [x, y + h / 2, z], GM_D);
  b.cyl(r * 1.18, r * 1.18, h * 0.07, 8, [x, y + h * 0.3, z], BRASS);
  b.cyl(r * 1.55, r * 1.05, h * 0.16, 8, [x, y + h * 1.0, z], SOOT);
}

/** A round porthole facing ±X (side `s`): glowing gaslight glass in a brass rim. */
function porthole(b: ModelBuilder, at: Vec3, s: number, r = 0.022): void {
  b.cyl(r, r, 0.012, 8, at, AMBER, { rot: [0, 0, Math.PI / 2], glow: 0.85 });
  b.torus(r, r * 0.3, [at[0] + s * 0.004, at[1], at[2]], BRASS, { rot: [0, Math.PI / 2, 0], seg: 10 });
}

// ---------------------------------------------------------------- units ---

/**
 * The Fardier (Harvester): Cugnot's steam carriage grown into a road
 * locomotive. A copper vertical boiler with a tall stack over a single
 * steering wheel, a driver's platform under a team canopy, a coal tender
 * between two big spoked wheels (rimmed in team colour), an iron scoop.
 * `cargo`: a heap of coal with a few glowing radium lumps.
 */
function fardier(t: Team): ModelDef {
  const b = hullB();
  // the timber frame and the rear axle
  b.pairBlock(0.05, 0.06, 0.9, [0.11, 0.2, 0.02], WOOD, { bevel: 0.012 });
  b.cyl(0.02, 0.02, 0.5, 6, [0, 0.17, 0.24], GM_D, { rot: [0, 0, Math.PI / 2] });
  for (const s of [1, -1]) spokedWheel(b, [s * 0.255, 0.17, 0.24], 0.17, 0.07, 10);
  // the steering wheel under the boiler, in an iron fork
  spokedWheel(b, [0, 0.1, -0.36], 0.1, 0.06, 8);
  b.pair(0.015, 0.14, 0.03, [0.045, 0.17, -0.36], GM_D);
  // the boiler: copper, banded in team colour and brass, a dome, a firedoor glowing at the back
  b.drum(0.13, 0.125, 0.26, 12, [0, 0.36, -0.3], COPPER, { bevel: 0.02 });
  for (const y of [0.29, 0.43]) b.torus(0.132, 0.012, [0, y, -0.3], t.main, { rot: [Math.PI / 2, 0, 0], seg: 14 });
  b.torus(0.131, 0.008, [0, 0.36, -0.3], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 14 });
  b.sphere(0.11, [0, 0.49, -0.3], GM_D, { phi: Math.PI / 2, w: 12, h: 4, scale: [1, 0.45, 1] });
  b.box(0.08, 0.06, 0.02, [0, 0.3, -0.168], AMBER, { glow: 0.8 });
  stack(b, [0, 0.52, -0.3], 0.035, 0.3);
  // the driver's platform: planking, a brass steering column and regulator
  b.block(0.36, 0.03, 0.24, [0, 0.245, -0.04], WOOD_L, { bevel: 0.008 });
  b.cyl(0.008, 0.008, 0.14, 5, [0, 0.33, -0.13], BRASS, { rot: [0.3, 0, 0] });
  b.torus(0.035, 0.007, [0, 0.4, -0.11], BRASS, { rot: [Math.PI / 2 - 0.3, 0, 0], seg: 10 });
  // the canopy: four iron posts, a team roof with a brass edge (the patch seen from above)
  for (const x of [-0.16, 0.16]) for (const z of [-0.14, 0.06]) b.cyl(0.008, 0.008, 0.33, 5, [x, 0.41, z], GM_D);
  b.block(0.4, 0.03, 0.27, [0, 0.585, -0.04], t.main, { bevel: 0.012, edge: 1.35 });
  b.box(0.41, 0.012, 0.28, [0, 0.567, -0.04], BRASS);
  // the coal tender: iron walls on a wooden bed, a team rim round the top
  b.box(0.36, 0.03, 0.34, [0, 0.235, 0.29], WOOD);
  b.block(0.36, 0.16, 0.025, [0, 0.32, 0.12], GM, { bevel: 0.008 });
  b.block(0.36, 0.16, 0.025, [0, 0.32, 0.46], GM, { bevel: 0.008 });
  b.pairBlock(0.025, 0.16, 0.36, [0.18, 0.32, 0.29], GM, { bevel: 0.008 });
  b.pairBlock(0.04, 0.02, 0.38, [0.18, 0.41, 0.29], t.main, { bevel: 0.006 });
  b.block(0.4, 0.02, 0.04, [0, 0.41, 0.46], t.main, { bevel: 0.006 });
  b.block(0.4, 0.02, 0.04, [0, 0.41, 0.12], t.main, { bevel: 0.006 });
  for (const s of [1, -1]) rivets(b, [s * 0.194, 0.37, 0.14], [s * 0.194, 0.37, 0.44], 5, 0.01);
  // gas lamps either side of the boiler
  for (const s of [1, -1]) {
    b.cyl(0.018, 0.018, 0.03, 6, [s * 0.15, 0.32, -0.38], BRASS);
    light(b, [s * 0.15, 0.345, -0.38], 0.024);
  }
  // the scoop: an iron share with brass teeth
  b.box(0.42, 0.07, 0.03, [0, 0.08, -0.5], GM_D, { rot: [-0.45, 0, 0] });
  b.box(0.43, 0.014, 0.034, [0, 0.118, -0.488], BRASS, { rot: [-0.45, 0, 0] });
  for (const x of [-0.17, -0.085, 0, 0.085, 0.17]) b.cone(0.018, 0.05, 4, [x, 0.04, -0.54], GM_L, { rot: [-Math.PI / 2 - 0.3, 0, 0] });
  b.pair(0.02, 0.02, 0.14, [0.12, 0.13, -0.43], GM_D, { rot: [0.4, 0, 0] });
  const hull = b.build();

  // the load: coal heaped in the tender, a few embers, radium glowing green-white
  const c = partB();
  const coal: [number, number, number, number][] = [
    [-0.1, 0.18, 0.05, 0.3], [0.08, 0.2, 0.055, 0.31], [-0.04, 0.3, 0.06, 0.33], [0.1, 0.36, 0.05, 0.3],
    [0, 0.42, 0.045, 0.3], [-0.11, 0.4, 0.045, 0.3], [0.02, 0.22, 0.05, 0.35], [-0.08, 0.27, 0.04, 0.37],
    [0.06, 0.29, 0.045, 0.37], [0.12, 0.15, 0.04, 0.3]
  ];
  coal.forEach(([x, z, s, y], i) =>
    c.box(s * 2, s * 1.5, s * 1.8, [x, y, z], i % 3 ? COAL : 0x2c2622, { rot: [i * 0.7, i * 1.3, i * 0.4] })
  );
  for (const [x, z] of [[-0.03, 0.18], [0.07, 0.4]] as [number, number][]) c.box(0.02, 0.015, 0.02, [x, 0.4, z], AMBER, { glow: 0.5 });
  for (const [x, z, s] of [[0.03, 0.3, 0.03], [-0.07, 0.36, 0.024], [0.11, 0.22, 0.022]] as [number, number, number][])
    c.sphere(s, [x, 0.4 + s * 0.4, z], RADIUM, { glow: 0.85, w: 4, h: 2, scale: [1, 1.4, 1] });
  return { hull, mount: [0, 0, 0], muzzle: [0, 0.3, -0.5], rotors: [], cargo: c.build(), height: 0.72 };
}

/**
 * The Panhard (Stinger): a 1905 armoured car. A long louvred bonnet behind
 * a brass radiator, acetylene headlamps, a riveted fighting compartment on
 * four artillery wheels, and a round turret with a team roof and a
 * Hotchkiss machine-gun (brass cooling rings).
 */
function panhard(t: Team): ModelDef {
  const b = hullB();
  b.block(0.3, 0.06, 0.86, [0, 0.15, 0], GM_D, { bevel: 0.01 });
  for (const s of [1, -1]) for (const z of [-0.27, 0.27]) spokedWheel(b, [s * 0.2, 0.11, z], 0.11, 0.06, 10);
  // mudguards in team colour, a running board between them
  for (const s of [1, -1]) {
    for (const z of [-0.27, 0.27]) {
      b.block(0.085, 0.016, 0.2, [s * 0.2, 0.235, z], t.main, { bevel: 0.006, edge: 1.35 });
      b.box(0.08, 0.05, 0.016, [s * 0.2, 0.205, z - 0.105], t.dark, { rot: [0.6, 0, 0] });
    }
    b.box(0.07, 0.012, 0.34, [s * 0.2, 0.16, 0], GM_D);
  }
  // the bonnet: tapered, louvred, a brass radiator and two headlamps in front
  b.block(0.26, 0.13, 0.34, [0, 0.245, -0.28], GM, { taper: 0.18, bevel: 0.03 });
  for (const s of [1, -1]) for (const z of [-0.36, -0.32, -0.28, -0.24, -0.2]) b.box(0.006, 0.06, 0.012, [s * 0.128, 0.245, z], GM_D, { rot: [0, 0, s * 0.12] });
  b.block(0.24, 0.15, 0.03, [0, 0.245, -0.46], BRASS, { bevel: 0.01 });
  for (const x of [-0.06, 0, 0.06]) b.box(0.012, 0.12, 0.034, [x, 0.245, -0.46], GM_D);
  for (const s of [1, -1]) {
    b.tube(0.026, 0.04, 8, [s * 0.15, 0.3, -0.44], BRASS);
    b.cyl(0.02, 0.02, 0.008, 8, [s * 0.15, 0.3, -0.462], AMBER, { rot: [Math.PI / 2, 0, 0], glow: 1 });
  }
  // the fighting compartment: sloped riveted plates, a glacis down to the bonnet, vision slits
  b.block(0.36, 0.2, 0.48, [0, 0.29, 0.14], GM, { taper: 0.1, bevel: 0.03 });
  b.block(0.3, 0.05, 0.12, [0, 0.33, -0.12], GM_D, { rot: [0.6, 0, 0], bevel: 0.012 });
  for (const s of [1, -1]) {
    rivets(b, [s * 0.155, 0.37, -0.06], [s * 0.155, 0.37, 0.34], 6);
    rivets(b, [s * 0.172, 0.23, -0.06], [s * 0.172, 0.23, 0.34], 6);
    b.box(0.01, 0.014, 0.08, [s * 0.172, 0.31, 0.02], SOOT);
  }
  rivets(b, [-0.13, 0.37, 0.37], [0.13, 0.37, 0.37], 5);
  b.box(0.2, 0.06, 0.03, [0, 0.27, 0.39], GM_D);
  const hull = b.build();
  const tu = partB();
  tu.drum(0.135, 0.12, 0.11, 10, [0, 0.055, 0], GM, { bevel: 0.02 });
  tu.drum(0.118, 0.1, 0.03, 10, [0, 0.125, 0], t.main, { bevel: 0.012, edge: 1.35 });
  tu.cyl(0.03, 0.035, 0.02, 8, [0.035, 0.15, 0.04], BRASS);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    tu.box(0.01, 0.01, 0.01, [Math.sin(a) * 0.126, 0.1, Math.cos(a) * 0.126], GM_L);
  }
  // the Hotchkiss: a mantlet, a slim barrel ringed with brass cooling flanges
  tu.block(0.08, 0.065, 0.06, [0, 0.06, -0.135], GM_D, { bevel: 0.012 });
  barrel(tu, [0, 0.062, -0.15], 0.014, 0.32, 0.02, BARREL);
  for (let i = 0; i < 5; i++) tu.tube(0.026, 0.012, 8, [0, 0.063, -0.18 - i * 0.03], BRASS);
  tu.tube(0.02, 0.03, 6, [0, 0.068, -0.46], GM_D);
  light(tu, [-0.07, 0.13, -0.06], 0.022);
  return { hull, turret: tu.build(), mount: [0, 0.39, 0.1], muzzle: [0, 0.068, -0.48], rotors: [], height: 0.6 };
}

/**
 * The Faucheux (Flak Crawler): a harvestman of brass and iron. A riveted
 * brass belly under a team carapace, a gaslit head, six long stilted legs
 * (iron thighs up to team knees, brass shins down), and a Gatling of four
 * barrels pitched at the sky on a brass turret.
 */
function faucheux(t: Team): ModelDef {
  const b = hullB();
  b.drum(0.1, 0.08, 0.1, 8, [0, 0.15, 0], GM_D, { scale: [1, 1, 1.25] });
  b.sphere(0.21, [0, 0.25, 0], GM, { phi: Math.PI / 2, rot: [Math.PI, 0, 0], w: 12, h: 4, scale: [1, 0.5, 1.3] });
  b.torus(0.21, 0.014, [0, 0.25, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 16, scale: [1, 1.3, 1] });
  b.sphere(0.2, [0, 0.255, 0], t.main, { phi: Math.PI / 2, w: 12, h: 4, scale: [1, 0.55, 1.28] });
  // a brass ridge down the carapace, rivets round its rim
  b.box(0.022, 0.02, 0.4, [0, 0.355, 0.02], BRASS, { scale: [1, 1, 1] });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    b.box(0.012, 0.012, 0.012, [Math.sin(a) * 0.215, 0.262, Math.cos(a) * 0.215 * 1.3], GM_L);
  }
  // the head: a brass dome with two gaslight eyes and iron palps
  b.sphere(0.075, [0, 0.24, -0.3], BRASS, { w: 10, h: 6, scale: [1, 0.75, 1] });
  light(b, [0.035, 0.26, -0.365], 0.026);
  light(b, [-0.035, 0.26, -0.365], 0.026);
  for (const s of [1, -1]) strut(b, [s * 0.03, 0.21, -0.35], [s * 0.05, 0.12, -0.42], 0.01, GM_D);
  const hull = b.build();
  // each leg about its hip: an iron thigh high up to a team knee, a long brass shin down to the foot
  const parts: NonNullable<ModelDef["parts"]> = {};
  for (const leg of CRAWLER_LEGS) {
    const dx = leg.side * Math.cos(leg.angle);
    const dz = Math.sin(leg.angle);
    const hip: Vec3 = [dx * 0.18, 0.23, dz * 0.24];
    const knee: Vec3 = [dx * 0.36 - hip[0], 0.48 - hip[1], dz * 0.42 - hip[2]];
    const foot: Vec3 = [dx * 0.52 - hip[0], 0.01 - hip[1], dz * 0.58 - hip[2]];
    const lb = partB();
    lb.sphere(0.03, [0, 0, 0], GM_D, { w: 6, h: 4 });
    strut(lb, [0, 0, 0], knee, 0.024, GM_D);
    strut(lb, knee, foot, 0.016, BRASS);
    lb.sphere(0.042, knee, t.main, { w: 8, h: 5 });
    lb.cone(0.02, 0.045, 5, [foot[0], foot[1] + 0.022, foot[2]], TRACK, { rot: [Math.PI, 0, 0] });
    parts[leg.name] = { geo: lb.build(), at: hip };
  }
  // the turret: a brass drum, a cradle and the four-barrelled Gatling with its drum magazine
  const tu = partB();
  tu.drum(0.11, 0.095, 0.07, 10, [0, 0.035, 0.02], BRASS, { bevel: 0.016 });
  tu.drum(0.07, 0.06, 0.02, 10, [0, 0.08, 0.06], t.main, { bevel: 0.008 });
  const pitch = 0.85;
  const at: Vec3 = [0, 0.08, -0.04];
  tu.block(0.12, 0.08, 0.08, [0, 0.08, -0.02], GM_D, { rot: [pitch, 0, 0], bevel: 0.012 });
  const ey: Vec3 = [0, Math.cos(pitch), Math.sin(pitch)];
  for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    const o: Vec3 = [at[0] + u * 0.026, at[1] + v * 0.026 * ey[1], at[2] + v * 0.026 * ey[2]];
    barrel(tu, o, 0.013, 0.3, pitch, BARREL, 5);
  }
  for (const k of [0.1, 0.26]) barrel(tu, barrelTip(at, k, pitch), 0.048, 0.022, pitch, BRASS, 8);
  tu.cyl(0.04, 0.04, 0.03, 10, [0.075, 0.1, 0.01], BRASS, { rot: [0, 0, Math.PI / 2] });
  light(tu, [0, 0.1, 0.09], 0.02);
  return { hull, turret: tu.build(), mount: [0, 0.35, 0.05], muzzle: barrelTip(at, 0.31, pitch), rotors: [], parts, height: 0.62 };
}

/**
 * The Canon de 75 (Mortar): a heavy field gun on its carriage. Two tall
 * artillery wheels on an iron axle with team axle-seat chests, a box trail
 * to a spade, a pivot drum; the gun (turret) swings on it: a team-painted
 * shield, the cradle with its recoil cylinder and a long barrel pitched high.
 */
function canon75(t: Team): ModelDef {
  const b = hullB();
  b.cyl(0.025, 0.025, 0.56, 6, [0, 0.18, -0.06], GM_D, { rot: [0, 0, Math.PI / 2] });
  for (const s of [1, -1]) spokedWheel(b, [s * 0.27, 0.18, -0.06], 0.18, 0.06, 12);
  // the trail sloping back to its spade, a team ammunition chest on it
  b.block(0.12, 0.07, 0.5, [0, 0.14, 0.2], GM_D, { rot: [0.25, 0, 0], bevel: 0.012 });
  b.pair(0.012, 0.012, 0.44, [0.05, 0.18, 0.2], GM_L, { rot: [0.25, 0, 0] });
  b.box(0.2, 0.1, 0.025, [0, 0.04, 0.45], GM_D, { rot: [0.3, 0, 0] });
  b.torus(0.03, 0.008, [0, 0.1, 0.46], BRASS, { seg: 8 });
  b.block(0.2, 0.08, 0.11, [0, 0.2, 0.22], t.main, { bevel: 0.015, edge: 1.35 });
  b.box(0.21, 0.012, 0.02, [0, 0.21, 0.22], BRASS);
  // axle-seat chests either side of the pivot, in team colour
  for (const s of [1, -1]) {
    b.block(0.1, 0.07, 0.12, [s * 0.15, 0.23, -0.06], t.main, { bevel: 0.012, edge: 1.35 });
    b.box(0.1, 0.01, 0.125, [s * 0.15, 0.2, -0.06], BRASS);
  }
  // the pivot drum the gun turns on
  b.drum(0.1, 0.09, 0.08, 10, [0, 0.21, -0.06], GM, { bevel: 0.015 });
  rivets(b, [-0.11, 0.2, -0.06], [0.11, 0.2, -0.06], 2);
  const hull = b.build();
  const tu = partB();
  // the shield: two team leaves either side of the barrel and an apron below, raked back, riveted
  for (const s of [1, -1]) {
    tu.block(0.2, 0.34, 0.02, [s * 0.135, 0.15, -0.12], t.main, { rot: [0.3, 0, 0], bevel: 0.008, edge: 1.35 });
    rivets(tu, [s * 0.05, 0.03, -0.145], [s * 0.05, 0.28, -0.07], 5, 0.01);
    rivets(tu, [s * 0.22, 0.03, -0.145], [s * 0.22, 0.28, -0.07], 5, 0.01);
  }
  tu.block(0.08, 0.1, 0.02, [0, 0.04, -0.13], t.dark, { rot: [0.3, 0, 0] });
  for (const s of [1, -1]) tu.box(0.2, 0.014, 0.03, [s * 0.135, 0.31, -0.064], BRASS, { rot: [0.3, 0, 0] });
  // the cradle cheeks, the recoil cylinder under a long slim barrel, a brass breech
  tu.pairBlock(0.03, 0.12, 0.18, [0.06, 0.08, 0.02], GM, { bevel: 0.01 });
  const pitch = 0.9;
  const at: Vec3 = [0, 0.12, 0.1];
  barrel(tu, at, 0.04, 0.56, pitch, BARREL, 10);
  barrel(tu, [0, 0.12 - 0.04, 0.1 - 0.03], 0.034, 0.3, pitch, GM_D, 8);
  barrel(tu, barrelTip(at, -0.06, pitch), 0.05, 0.08, pitch, BRASS, 10);
  barrel(tu, barrelTip(at, 0.5, pitch), 0.047, 0.05, pitch, GM_D, 10);
  const tip = barrelTip(at, 0.56, pitch);
  tu.cyl(0.03, 0.03, 0.006, 10, tip, SOOT, { rot: [pitch - Math.PI / 2, 0, 0] });
  return { hull, turret: tu.build(), mount: [0, 0.25, -0.06], muzzle: tip, rotors: [], height: 0.75 };
}

/**
 * The Creusot (Mastodon): a land ironclad. A riveted steel hull riding over
 * its tracks with a ram prow, gaslit portholes down both flanks, twin
 * soot-topped stacks aft and team stripes along the deck, and a great
 * turret with a team roof and two cannon.
 */
function creusot(t: Team): ModelDef {
  const b = hullB();
  tracks(b, 0.36, 0.2, 0.2, 1.0, 0.02);
  // the lower hull over the tracks, its portholes, a ram prow
  b.block(0.86, 0.17, 0.98, [0, 0.27, 0.02], GM_D, { bevel: 0.02 });
  b.prism([[-0.43, -0.47], [0.43, -0.47], [0, -0.68]], 0.17, [0, 0.185, 0], GM_D);
  b.prism([[-0.36, -0.47], [0.36, -0.47], [0, -0.62]], 0.08, [0, 0.355, 0], GM);
  for (const s of [1, -1]) {
    for (const z of [-0.33, -0.16, 0.01, 0.18, 0.35]) porthole(b, [s * 0.432, 0.28, z], s);
    rivets(b, [s * 0.434, 0.34, -0.44], [s * 0.434, 0.34, 0.48], 12, 0.012);
    rivets(b, [s * 0.434, 0.205, -0.44], [s * 0.434, 0.205, 0.48], 12, 0.012);
  }
  // the casemate deck, team stripes down its edges, rivets, a rear grating
  b.block(0.74, 0.12, 0.9, [0, 0.415, 0.02], GM, { taper: 0.1, bevel: 0.035 });
  b.pairBlock(0.08, 0.025, 0.82, [0.27, 0.485, 0.02], t.main, { bevel: 0.01, edge: 1.35 });
  for (const s of [1, -1]) rivets(b, [s * 0.215, 0.482, -0.36], [s * 0.215, 0.482, 0.4], 10, 0.011);
  b.block(0.3, 0.02, 0.12, [0, 0.485, 0.39], GM_D, { bevel: 0.006 });
  for (const s of [1, -1]) stack(b, [s * 0.12, 0.49, 0.39], 0.04, 0.2);
  // gas lamps on the prow
  light(b, [0.16, 0.3, -0.55], 0.03);
  light(b, [-0.16, 0.3, -0.55], 0.03);
  const hull = b.build();
  const tu = partB();
  tu.drum(0.25, 0.21, 0.16, 10, [0, 0.08, 0.04], GM, { bevel: 0.035 });
  tu.drum(0.2, 0.17, 0.03, 10, [0, 0.175, 0.04], t.main, { bevel: 0.014, edge: 1.35 });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    tu.box(0.013, 0.013, 0.013, [Math.sin(a) * 0.226, 0.15, 0.04 + Math.cos(a) * 0.226], GM_L);
  }
  // a brass commander's cupola with a gaslit slit, a mantlet, twin cannon banded in brass
  tu.drum(0.055, 0.045, 0.05, 8, [0.09, 0.21, 0.1], BRASS, { bevel: 0.01 });
  tu.box(0.05, 0.012, 0.012, [0.09, 0.215, 0.05], AMBER, { glow: 0.8 });
  tu.block(0.28, 0.12, 0.08, [0, 0.085, -0.2], GM_D, { bevel: 0.02 });
  for (const x of [-0.075, 0.075]) {
    barrel(tu, [x, 0.09, -0.22], 0.033, 0.52, 0.01, BARREL, 8);
    tu.tube(0.045, 0.04, 8, [x, 0.09, -0.27], BRASS);
    tu.tube(0.044, 0.07, 8, [x, 0.095, -0.74], GM_D);
  }
  return { hull, turret: tu.build(), mount: [0, 0.475, 0.02], muzzle: [0, 0.095, -0.78], rotors: [], height: 0.8 };
}

/**
 * The Hydroglisseur (Lancer): the comte de Lambert's skimmer. A varnished
 * wooden hull with a team deck over a dark canvas skirt (spray at its foot),
 * a brass engine driving a big air propeller in a cage at the stern, and an
 * electric lance turret: brass coils, a blue-white spark at the tip.
 */
function hydroglisseur(t: Team): ModelDef {
  const b = hullB();
  skirt(b, 0.64, 0.95, 0.02, 0, [0, 0.025, 0], WHITE, 0.25);
  skirt(b, 0.6, 0.9, 0.1, 0.06, [0, 0.08, 0], 0x2b231c);
  const hullS: Section[] = [
    [-0.52, 0.03, 0.235, 0.17], [-0.42, 0.17, 0.25, 0.12], [-0.22, 0.27, 0.26, 0.11],
    [0.3, 0.28, 0.26, 0.11], [0.44, 0.25, 0.26, 0.12]
  ];
  b.fuselage(hullS, [0, 0, 0], WOOD, { chamfer: 0.02 });
  // the team deck inside a brass gunwale, planked
  const deckS: Section[] = hullS.map(([z, w, top]) => [z * 0.94 + 0.01, Math.max(0.01, w - 0.035), top + 0.014, top - 0.01]);
  b.fuselage(deckS, [0, 0, 0], t.main, { chamfer: 0.008, edge: 1.3 });
  for (const x of [-0.12, 0, 0.12]) b.box(0.008, 0.004, 0.62, [x, 0.276, 0.02], t.dark);
  for (const s of [1, -1]) b.box(0.012, 0.012, 0.72, [s * 0.265, 0.262, 0.05], BRASS, { rot: [0, s * -0.03, 0] });
  // the engine: an iron crankcase, four brass cylinders, exhaust stubs
  b.block(0.18, 0.08, 0.16, [0, 0.31, 0.27], GM_D, { bevel: 0.015 });
  for (const s of [1, -1]) for (const z of [0.22, 0.31]) {
    b.cyl(0.026, 0.026, 0.07, 8, [s * 0.06, 0.37, z], BRASS);
    b.cyl(0.006, 0.006, 0.05, 5, [s * 0.1, 0.36, z], SOOT, { rot: [0, 0, s * 0.8] });
  }
  // the propeller cage: a brass hoop on struts, wire spokes behind
  const pc: Vec3 = [0, 0.47, 0.45];
  b.torus(0.2, 0.012, pc, BRASS, { seg: 18 });
  for (const s of [1, -1]) strut(b, [s * 0.16, 0.26, 0.4], [s * 0.14, 0.33, 0.45], 0.012, GM_D);
  strut(b, [0, 0.35, 0.3], [0, 0.47, 0.43], 0.016, GM_D);
  for (let i = 0; i < 4; i++) b.box(0.4, 0.006, 0.006, [pc[0], pc[1], pc[2] + 0.03], GM_D, { rot: [0, 0, (i * Math.PI) / 4] });
  // gas lamps at the bow
  light(b, [0.1, 0.28, -0.4], 0.026);
  light(b, [-0.1, 0.28, -0.4], 0.026);
  const hull = b.build();
  // the propeller: two varnished blades and a brass boss, spinning about Z
  const pr = new ModelBuilder();
  for (const s of [1, -1]) pr.box(0.05, 0.17, 0.012, [0, s * 0.095, 0], WOOD_L, { rot: [0, s * 0.35, 0] });
  pr.cone(0.03, 0.05, 8, [0, 0, -0.02], BRASS, { rot: [-Math.PI / 2, 0, 0] });
  // the lance turret
  const tu = partB();
  tu.drum(0.13, 0.11, 0.08, 10, [0, 0.04, 0.02], GM, { bevel: 0.016 });
  tu.drum(0.1, 0.085, 0.025, 10, [0, 0.092, 0.03], BRASS, { bevel: 0.008 });
  tu.drum(0.06, 0.05, 0.02, 10, [0, 0.114, 0.03], t.main, { bevel: 0.006 });
  tu.block(0.09, 0.07, 0.1, [0, 0.05, -0.12], GM_D, { bevel: 0.015 });
  tu.tube(0.018, 0.48, 6, [0, 0.05, -0.36], BARREL);
  for (let i = 0; i < 4; i++) tu.torus(0.036, 0.011, [0, 0.05, -0.22 - i * 0.07], i % 2 ? COPPER : BRASS, { seg: 10 });
  tu.tube(0.012, 0.04, 6, [0, 0.05, -0.62], BRASS);
  tu.sphere(0.03, [0, 0.05, -0.65], 0xe4f2ff, { glow: 1, w: 8, h: 6 });
  // Leyden jars on the turret's back
  for (const s of [1, -1]) {
    tu.cyl(0.022, 0.022, 0.06, 8, [s * 0.07, 0.11, 0.08], GLASS_JAR);
    tu.sphere(0.01, [s * 0.07, 0.15, 0.08], BRASS, { w: 6, h: 4 });
  }
  return {
    hull, turret: tu.build(), mount: [0, 0.27, -0.1], muzzle: [0, 0.05, -0.66],
    rotors: [{ geo: pr.build(), at: [pc[0], pc[1], pc[2] - 0.02], axis: "z", speed: 30 }], height: 0.68
  };
}

/** Leyden jar glass, faintly green. */
const GLASS_JAR = 0x6f8f78;

export const GROUND: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  harvester: fardier,
  stinger: panhard,
  "flak-crawler": faucheux,
  mortar: canon75,
  mastodon: creusot,
  lancer: hydroglisseur
};
