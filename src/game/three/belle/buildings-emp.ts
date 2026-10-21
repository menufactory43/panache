import { BARREL, BRASS, EXHAUST, TRACK, WHITE, barrel, barrelTip, light, partB, siteB, type ModelDef, type Team } from "../models";
import { botStatic } from "../infantry";
import type { ModelBuilder } from "../builder";
import { BRICK, BRICK_D, COAL, GLAZE, IRON, SOOT, STONE, WOOD, WOOD_D, coal, factionOf, frustum, gable, lamp, rib, rod, tooth, vault } from "./buildings";

/**
 * The Empire de Carbonie's new buildings (PANACHE-CONCEPTION.md §1.6, §1.11):
 * Citadelle (hq), Aérodrome à vapeur (airpad), Haut-fourneau (tech-lab),
 * Batterie de 47 (flak-battery), Ballon captif (radar) and Caserne-atelier
 * (assembly-bay). Brick, soot-black iron and riveted steel, coal heaps, the
 * team colour (burgundy) on roofs, red-hot glows. Same contracts and
 * footprints as the Classique kind they replace (buildings.ts). `t` is the
 * nation's colour (NATION_TEAMS) for the seat.
 *
 * (models.ts imports this module through belle/index.ts: nothing is built at load.)
 */

/** Riveted steel plate, darker and lighter. */
const STEEL = 0x5b5e63;
const STEEL_D = 0x3b3d41;
const STEEL_L = 0x8a8e94;
/** Red-hot iron and furnace glow. */
const HOT = 0xff5a1f;
const EMBER = 0xff8a2a;
const GROUND = 0x5f584e;
const WICKER = 0xa8834e;

/** A smokestack: a banded drum, a team collar, a sooty crown, its glowing throat. */
function stack(b: ModelBuilder, t: Team, x: number, z: number, y0: number, h: number, r: number, hex = BRICK): void {
  b.cyl(r * 0.75, r, h, 7, [x, y0 + h / 2, z], hex);
  b.cyl(r * 0.95, r * 0.95, 0.06, 7, [x, y0 + h * 0.6, z], t.main);
  b.cyl(r * 0.85, r * 0.8, 0.08, 7, [x, y0 + h - 0.04, z], SOOT);
  b.cyl(r * 0.55, r * 0.55, 0.02, 7, [x, y0 + h, z], EXHAUST, { glow: 0.8 });
}

// --------------------------------------------------------- Citadelle ---

/**
 * Citadelle: a keep of riveted steel under a team hipped roof, a clock tower
 * on its south face with a team spire and banner, two smoking stacks behind;
 * a crenellated steel curtain wall with four round towers under team cones, a
 * furnace-lit gate, team banners, coal in the yard.
 */
function citadelle(t: Team): ModelDef {
  const b = siteB();
  b.block(2.9, 0.14, 2.9, [0, 0.07, 0], GROUND, { taper: 0.02, bevel: 0.04 });
  const y0 = 0.14;
  // the curtain wall and its merlons
  const R = 1.18;
  for (const s of [-1, 1]) {
    b.block(2.2, 0.32, 0.14, [0, y0 + 0.16, s * R], STEEL, { bevel: 0.015 });
    b.block(0.14, 0.32, 2.2, [s * R, y0 + 0.16, 0], STEEL, { bevel: 0.015 });
    for (let i = 0; i < 5; i++) {
      const u = -0.8 + i * 0.4;
      if (s > 0 && Math.abs(u) < 0.1) continue;
      b.box(0.14, 0.08, 0.16, [u, y0 + 0.36, s * R], STEEL_D);
      b.box(0.16, 0.08, 0.14, [s * R, y0 + 0.36, u], STEEL_D);
    }
  }
  // the gate: a dark arch lit red from inside, iron bars
  b.box(0.36, 0.26, 0.05, [0, y0 + 0.13, R + 0.05], 0x1a1210);
  b.box(0.3, 0.18, 0.04, [0, y0 + 0.1, R + 0.03], HOT, { glow: 0.7 });
  for (const x of [-0.1, 0, 0.1]) b.box(0.02, 0.24, 0.02, [x, y0 + 0.12, R + 0.085], IRON);
  // four round towers, team cones
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      b.cyl(0.24, 0.26, 0.62, 8, [sx * R, y0 + 0.31, sz * R], STEEL);
      b.cyl(0.27, 0.27, 0.05, 8, [sx * R, y0 + 0.6, sz * R], STEEL_D);
      b.cone(0.32, 0.38, 8, [sx * R, y0 + 0.81, sz * R], t.main);
    }
  // the keep: riveted plates in bands, a team hipped roof with a dark crown
  const kz = -0.15;
  const kh = 0.78;
  b.block(1.36, kh, 1.2, [0, y0 + kh / 2, kz], STEEL, { bevel: 0.02 });
  for (const y of [0.22, 0.5]) b.box(1.39, 0.03, 1.23, [0, y0 + y, kz], STEEL_D);
  for (const x of [-0.45, -0.15, 0.15, 0.45]) b.box(0.06, 0.12, 0.02, [x, y0 + 0.62, kz + 0.61], EMBER, { glow: 0.6 });
  frustum(b, 1.5, 0.4, 1.34, 0.4, [0, y0 + kh + 0.2, kz], t.main);
  b.block(0.72, 0.04, 0.56, [0, y0 + kh + 0.42, kz], t.dark, { bevel: 0.015 });
  // the clock tower on the south face: a dial, its hands, a team spire and banner
  const cz = kz + 0.52;
  b.block(0.42, 1.36, 0.36, [0, y0 + 0.68, cz], STEEL_L, { bevel: 0.02 });
  b.cyl(0.15, 0.15, 0.02, 12, [0, y0 + 1.12, cz + 0.185], WHITE, { rot: [Math.PI / 2, 0, 0] });
  b.torus(0.15, 0.018, [0, y0 + 1.12, cz + 0.19], BRASS, { seg: 12 });
  b.box(0.012, 0.11, 0.01, [0, y0 + 1.16, cz + 0.2], SOOT);
  b.box(0.08, 0.012, 0.01, [0.035, y0 + 1.12, cz + 0.2], SOOT);
  frustum(b, 0.48, 0.12, 0.42, 0.05, [0, y0 + 1.42, cz], t.dark);
  b.cone(0.22, 0.5, 4, [0, y0 + 1.73, cz], t.main, { rot: [0, Math.PI / 4, 0] });
  b.cyl(0.01, 0.01, 0.4, 4, [0, y0 + 2.12, cz], IRON);
  b.box(0.3, 0.14, 0.012, [0.16, y0 + 2.22, cz], t.main);
  // team banners hanging either side of the tower
  for (const sx of [-1, 1]) {
    b.box(0.16, 0.4, 0.015, [sx * 0.42, y0 + 0.5, kz + 0.61], t.main);
    b.box(0.17, 0.03, 0.02, [sx * 0.42, y0 + 0.71, kz + 0.61], BRASS);
  }
  // two stacks behind, coal in the yard
  stack(b, t, -0.42, kz - 0.42, y0 + kh, 0.7, 0.11, STEEL_D);
  stack(b, t, 0.42, kz - 0.42, y0 + kh, 0.55, 0.1, STEEL_D);
  coal(b, -0.75, 0.75, y0, 0.9);
  b.block(0.24, 0.12, 0.2, [0.75, y0 + 0.06, 0.78], WOOD, { bevel: 0.012 });
  for (const x of [-1.38, 1.38]) for (const z of [-1.38, 1.38]) light(b, [x, 0.15, z], 0.05);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 1.1, 0], rotors: [], height: 2.2 };
}

// --------------------------------------------------- Aérodrome à vapeur ---

/**
 * Aérodrome à vapeur: a short team-painted runway with dark chevrons and red
 * edge lights, the steam catapult's rails and its piston at the south end; a
 * coal tower on iron legs with its hopper and chute, a brick boiler house
 * under a team gable with its stack.
 */
function aerodrome(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], GROUND, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  const rx = 0.36;
  b.block(0.7, 0.04, 1.86, [rx, y0 + 0.02, 0], t.main, { bevel: 0.01, edge: 1.3 });
  for (let i = 0; i < 5; i++) b.box(0.5, 0.006, 0.07, [rx, y0 + 0.043, -0.72 + i * 0.3], t.dark);
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.02, 1.4, [rx + sx * 0.08, y0 + 0.05, 0.1], IRON);
    for (let i = 0; i < 4; i++) b.box(0.04, 0.02, 0.04, [rx + sx * 0.37, y0 + 0.03, -0.8 + i * 0.5], HOT, { glow: 1 });
  }
  // the catapult: a riveted cylinder, its piston rod, the shuttle
  b.cyl(0.07, 0.07, 0.36, 8, [rx, y0 + 0.1, 0.72], STEEL, { rot: [Math.PI / 2, 0, 0] });
  b.cyl(0.075, 0.075, 0.03, 8, [rx, y0 + 0.1, 0.56], BRASS, { rot: [Math.PI / 2, 0, 0] });
  b.block(0.16, 0.05, 0.12, [rx, y0 + 0.07, 0.36], STEEL_D, { bevel: 0.01 });
  // the coal tower: iron legs, the bunker, its team roof, a chute to the runway
  const [cx, cz] = [-0.55, -0.5];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.04, 0.62, 0.04, [cx + sx * 0.15, y0 + 0.31, cz + sz * 0.15], IRON);
  b.cone(0.2, 0.16, 4, [cx, y0 + 0.56, cz], STEEL_D, { rot: [Math.PI, Math.PI / 4, 0] });
  b.block(0.38, 0.28, 0.38, [cx, y0 + 0.78, cz], STEEL, { bevel: 0.015 });
  frustum(b, 0.44, 0.12, 0.44, 0.12, [cx, y0 + 0.98, cz], t.main);
  rod(b, [cx + 0.1, y0 + 0.5, cz], [rx - 0.3, y0 + 0.12, cz], 0.025, STEEL_D);
  coal(b, cx + 0.05, 0.05, y0, 0.6);
  // the boiler house: brick, a team gable, a lit door, the stack
  const [hx, hz] = [-0.56, 0.52];
  b.block(0.56, 0.32, 0.66, [hx, y0 + 0.16, hz], BRICK, { bevel: 0.012 });
  gable(b, 0.64, 0.22, 0.72, [hx, y0 + 0.32, hz], t.main);
  b.box(0.16, 0.18, 0.02, [hx + 0.28, y0 + 0.1, hz], HOT, { rot: [0, Math.PI / 2, 0], glow: 0.7 });
  stack(b, t, hx - 0.14, hz - 0.2, y0 + 0.32, 0.5, 0.07);
  lamp(b, -0.86, -0.05, y0, 0.26);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 1.3 };
}

// -------------------------------------------------------- Haut-fourneau ---

/**
 * Haut-fourneau: the blast furnace — a red-hot hearth ringed with glowing
 * tuyères, a riveted stack banded in team colour with a glowing throat and a
 * team charging-floor roof; three cowper stoves under team domes, the skip
 * bridge up to the throat, the casting house under a team roof with molten
 * iron running out, slag wagons on their rails.
 */
function hautFourneau(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], GROUND, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  const [fx, fz] = [0.25, -0.3];
  b.cyl(0.32, 0.36, 0.22, 10, [fx, y0 + 0.11, fz], STEEL_D);
  b.torus(0.33, 0.03, [fx, y0 + 0.18, fz], HOT, { rot: [Math.PI / 2, 0, 0], seg: 12, glow: 1 });
  b.cyl(0.24, 0.32, 0.3, 10, [fx, y0 + 0.37, fz], BRICK);
  // the charging floor: a team roof on the stack's waist
  b.block(0.8, 0.05, 0.8, [fx, y0 + 0.55, fz], t.main, { bevel: 0.015, edge: 1.4 });
  b.cyl(0.18, 0.24, 0.9, 10, [fx, y0 + 1.0, fz], STEEL);
  for (const y of [0.75, 1.15]) b.cyl(0.215 - (y - 0.75) * 0.1, 0.225 - (y - 0.75) * 0.1, 0.06, 10, [fx, y0 + y, fz], t.main);
  b.cyl(0.2, 0.18, 0.08, 10, [fx, y0 + 1.48, fz], SOOT);
  b.cyl(0.14, 0.14, 0.02, 10, [fx, y0 + 1.52, fz], EXHAUST, { glow: 1 });
  // the cowper stoves, west, and the hot-blast main to the hearth
  for (let i = 0; i < 3; i++) {
    const z = -0.72 + i * 0.32;
    b.cyl(0.13, 0.14, 0.82, 8, [-0.6, y0 + 0.41, z], STEEL);
    b.sphere(0.13, [-0.6, y0 + 0.82, z], t.main, { w: 8, h: 3, phi: Math.PI / 2 });
  }
  rod(b, [-0.6, y0 + 0.3, -0.4], [fx - 0.3, y0 + 0.2, fz], 0.03, STEEL_D);
  // the skip bridge from the yard up to the throat, its skip
  rod(b, [0.82, y0, 0.55], [fx + 0.12, y0 + 1.45, fz], 0.022, IRON);
  rod(b, [0.7, y0, 0.6], [fx + 0.02, y0 + 1.45, fz + 0.05], 0.022, IRON);
  b.block(0.12, 0.08, 0.1, [0.6, y0 + 0.62, 0.15], STEEL_D, { rot: [0, 0, -0.9], bevel: 0.01 });
  // the casting house: brick, a team gable along x, molten iron running out of it
  const [hx, hz] = [-0.15, 0.48];
  b.block(1.0, 0.3, 0.56, [hx, y0 + 0.15, hz], BRICK, { bevel: 0.012 });
  for (const x of [-0.55, -0.15, 0.25]) b.box(0.05, 0.3, 0.58, [hx + x + 0.2, y0 + 0.15, hz], BRICK_D);
  gable(b, 0.66, 0.24, 1.08, [hx, y0 + 0.3, hz], t.main, Math.PI / 2);
  b.box(0.18, 0.14, 0.02, [hx, y0 + 0.08, hz + 0.29], HOT, { glow: 1 });
  b.box(0.07, 0.015, 0.3, [hx, y0 + 0.008, hz + 0.44], EMBER, { glow: 1 });
  // slag wagons on their rails, east
  for (const x of [0.62, 0.74]) b.box(0.015, 0.012, 0.8, [x, y0 + 0.006, 0.45], IRON);
  for (const z of [0.3, 0.65]) {
    b.cyl(0.09, 0.06, 0.1, 7, [0.68, y0 + 0.08, z], STEEL_D);
    b.cyl(0.07, 0.07, 0.01, 7, [0.68, y0 + 0.13, z], z < 0.5 ? HOT : COAL, z < 0.5 ? { glow: 1 } : {});
  }
  coal(b, -0.7, 0.05, y0, 0.55);
  lamp(b, 0.86, -0.86, y0, 0.26);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0], rotors: [], height: 1.6 };
}

// -------------------------------------------------------- Batterie de 47 ---

/**
 * Batterie de 47: a round armoured platform with a team deck, riveted rim and
 * ready shells; the turret two long 47 mm guns raked skyward on a steel
 * turntable behind a riveted shield, their little vertical boiler smoking at
 * the back. Muzzle between the two barrels' tips.
 */
function flakBattery(t: Team): ModelDef {
  const b = siteB();
  b.drum(0.44, 0.41, 0.14, 10, [0, 0.07, 0], STEEL_D, { bevel: 0.02 });
  b.drum(0.4, 0.38, 0.04, 10, [0, 0.16, 0], t.main, { bevel: 0.01, edge: 1.4 });
  b.torus(0.415, 0.016, [0, 0.145, 0], STEEL_L, { rot: [Math.PI / 2, 0, 0], seg: 14 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.25;
    b.box(0.2, 0.08, 0.035, [Math.sin(a) * 0.43, 0.2, Math.cos(a) * 0.43], STEEL, { rot: [-0.25, a, 0] });
  }
  // ready shells in a crate on the south rim
  b.block(0.18, 0.05, 0.08, [0.18, 0.205, 0.26], WOOD, { bevel: 0.01 });
  for (const x of [0.13, 0.18, 0.23]) b.cone(0.012, 0.04, 5, [x, 0.25, 0.26], BRASS);
  const hull = b.build();
  const h = partB();
  h.drum(0.22, 0.2, 0.06, 10, [0, 0.03, 0], STEEL, { bevel: 0.012 });
  h.pair(0.035, 0.16, 0.16, [0.13, 0.12, 0.02], STEEL_D);
  const pitch = 0.8;
  for (const x of [-0.07, 0.07]) {
    const base: [number, number, number] = [x, 0.17, 0.04];
    barrel(h, base, 0.024, 0.6, pitch, BARREL, 6);
    h.tube(0.034, 0.12, 6, barrelTip(base, 0.12, pitch), STEEL_L, { rot: [pitch, 0, 0] });
    h.tube(0.03, 0.04, 6, barrelTip(base, 0.58, pitch), STEEL_D, { rot: [pitch, 0, 0] });
  }
  // the riveted shield with a team stripe, the boiler and its stack behind
  h.block(0.34, 0.16, 0.035, [0, 0.16, -0.1], STEEL, { rot: [-0.35, 0, 0], bevel: 0.012 });
  h.box(0.3, 0.03, 0.04, [0, 0.21, -0.12], t.main, { rot: [-0.35, 0, 0] });
  h.cyl(0.06, 0.065, 0.2, 8, [0, 0.13, 0.15], STEEL_D);
  h.box(0.05, 0.04, 0.02, [0, 0.08, 0.215], HOT, { glow: 0.9 });
  h.cyl(0.02, 0.02, 0.14, 5, [0, 0.3, 0.15], SOOT);
  light(h, [0.1, 0.12, 0.12], 0.025);
  const muzzle = barrelTip([0, 0.17, 0.04], 0.62, pitch);
  return { hull, turret: h.build(), mount: [0, 0.18, 0], muzzle, rotors: [], height: 0.8 };
}

// --------------------------------------------------------- Ballon captif ---

/**
 * Ballon captif: an observation balloon in team colour, netted, tethered to a
 * steam winch wagon on a cinder pad. The turret is the observer's wicker
 * nacelle under the load ring, his telescope sweeping the horizon (the radar's
 * continuous sweep); the balloon stays put in the hull.
 */
function ballon(t: Team): ModelDef {
  const b = siteB();
  b.block(0.86, 0.08, 0.86, [0, 0.04, 0], GROUND, { taper: 0.05, bevel: 0.02 });
  const y0 = 0.08;
  // the winch wagon: a riveted bed on wheels, the cable drum, a little boiler
  b.block(0.5, 0.12, 0.3, [0, y0 + 0.12, 0.2], STEEL, { bevel: 0.012 });
  for (const x of [-0.18, 0.18]) for (const z of [0.07, 0.33]) b.cyl(0.06, 0.06, 0.03, 8, [x, y0 + 0.06, z], IRON, { rot: [0, 0, Math.PI / 2] });
  b.cyl(0.07, 0.07, 0.24, 8, [0, y0 + 0.24, 0.17], BRASS, { rot: [0, 0, Math.PI / 2] });
  b.cyl(0.075, 0.075, 0.16, 8, [0, y0 + 0.24, 0.17], TRACK, { rot: [0, 0, Math.PI / 2] });
  b.cyl(0.05, 0.055, 0.2, 7, [0.17, y0 + 0.28, 0.28], STEEL_D);
  b.box(0.04, 0.04, 0.02, [0.17, y0 + 0.24, 0.335], HOT, { glow: 0.9 });
  b.cyl(0.016, 0.016, 0.14, 5, [0.17, y0 + 0.44, 0.28], SOOT);
  // the tether up to the load ring
  const ring = 1.0;
  rod(b, [0, y0 + 0.3, 0.12], [0, ring, 0], 0.006, TRACK);
  b.torus(0.08, 0.008, [0, ring, 0], IRON, { rot: [Math.PI / 2, 0, 0], seg: 10 });
  // the balloon: team envelope, cordage net, valve
  const by = 1.42;
  const r = 0.38;
  b.sphere(r, [0, by, 0], t.main, { w: 12, h: 8 });
  b.torus(r + 0.004, 0.007, [0, by, 0], 0x3a3026, { rot: [Math.PI / 2, 0, 0], seg: 12 });
  b.torus(r * 0.87, 0.007, [0, by + r * 0.5, 0], 0x3a3026, { rot: [Math.PI / 2, 0, 0], seg: 10 });
  for (let i = 0; i < 2; i++) b.torus(r + 0.004, 0.006, [0, by, 0], 0x3a3026, { rot: [0, (i * Math.PI) / 2, 0], seg: 12 });
  b.cyl(0.05, 0.05, 0.04, 8, [0, by + r, 0], BRASS);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    rod(b, [Math.sin(a) * 0.07, ring, Math.cos(a) * 0.07], [Math.sin(a) * r * 0.8, by - r * 0.55, Math.cos(a) * r * 0.8], 0.004, 0x3a3026);
  }
  lamp(b, -0.32, 0.3, y0, 0.24);
  const hull = b.build();
  // the nacelle: wicker basket, brass rim, the observer's helmet, his telescope
  const h = partB();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    rod(h, [Math.sin(a) * 0.06, -0.02, Math.cos(a) * 0.06], [0, 0.08, 0], 0.003, 0x3a3026);
  }
  h.cyl(0.075, 0.065, 0.09, 8, [0, -0.07, 0], WICKER);
  h.torus(0.075, 0.008, [0, -0.025, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 10 });
  h.sphere(0.03, [0, -0.0, 0.01], STEEL_L, { w: 6, h: 4 });
  h.sphere(0.022, [0, 0.02, 0.01], t.dark, { w: 6, h: 3, phi: Math.PI / 2 });
  h.tube(0.012, 0.12, 6, [0, 0.0, -0.07], BRASS);
  h.box(0.02, 0.02, 0.005, [0, 0.0, -0.132], EMBER, { glow: 1 });
  return { hull, turret: h.build(), mount: [0, ring - 0.02, 0], muzzle: [0, 0, -0.13], rotors: [], height: 1.85 };
}

// ------------------------------------------------------- Caserne-atelier ---

/**
 * Caserne-atelier: a long brick workshop under team sheds (their glazing lit
 * by the forges inside), a tall stack at the east end; three arched iron
 * automaton doors on the south front, the middle one open on the red-lit hall
 * with a Fusilier stepping out; a cobbled apron, crates and coal.
 */
function caserne(t: Team): ModelDef {
  const f = factionOf(t);
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], GROUND, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  b.box(1.76, 0.02, 0.64, [0, y0 + 0.01, 0.6], 0x7a7064);
  const [z0, z1] = [-0.88, 0.24];
  const zc = (z0 + z1) / 2;
  b.block(1.76, 0.46, z1 - z0, [0, y0 + 0.23, zc], BRICK, { bevel: 0.015 });
  for (let i = 0; i < 5; i++) b.box(0.06, 0.46, z1 - z0 + 0.03, [-0.84 + i * 0.42, y0 + 0.23, zc], BRICK_D);
  b.box(1.8, 0.04, z1 - z0 + 0.04, [0, y0 + 0.44, zc], STEEL_D);
  // the sheds: four team slopes, their north lights glowing with the forges
  const n = 4;
  const td = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const z = z0 + td * (i + 0.5);
    tooth(b, td, 0.26, 1.76, [0, y0 + 0.46, z], t.main);
    b.box(1.6, 0.2, 0.02, [0, y0 + 0.57, z - td / 2 - 0.004], GLAZE, { glow: 0.55 });
    b.box(1.78, 0.025, 0.035, [0, y0 + 0.715, z - td / 2 + 0.01], SOOT);
  }
  stack(b, t, 0.7, -0.7, y0 + 0.46, 0.8, 0.11);
  // the automaton doors: iron, arched, framed in stone; the middle one open
  for (const x of [-0.56, 0, 0.56]) {
    const open = x === 0;
    b.box(0.3, 0.26, 0.03, [x, y0 + 0.13, z1 + 0.01], open ? 0x2a120c : STEEL);
    vault(b, 0.15, 0.03, [x, y0 + 0.26, z1 + 0.01], open ? 0x2a120c : STEEL, { seg: 8 });
    rib(b, 0.16, 0.018, [x, y0 + 0.26, z1 + 0.025], STONE);
    if (!open) for (const y of [0.08, 0.2]) b.box(0.28, 0.015, 0.02, [x, y0 + y, z1 + 0.03], IRON);
  }
  b.box(0.26, 0.22, 0.02, [0, y0 + 0.12, z1 - 0.16], HOT, { glow: 0.6 });
  b.addBuilt(botStatic("fusiliers", f), [0, y0, z1 + 0.12], { rot: [0, Math.PI, 0], scale: [1.15, 1.15, 1.15] });
  b.box(0.5, 0.06, 0.02, [0, y0 + 0.47, z1 + 0.025], t.dark);
  // crates, coal, a lamp
  b.block(0.22, 0.15, 0.2, [0.6, y0 + 0.075, 0.62], WOOD, { bevel: 0.015 });
  b.block(0.16, 0.12, 0.16, [0.66, y0 + 0.06, 0.84], WOOD_D, { rot: [0, 0.4, 0], bevel: 0.012 });
  coal(b, -0.6, 0.68, y0, 0.7);
  lamp(b, -0.86, 0.32, y0, 0.3);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0.2], rotors: [], height: 1.1 };
}

/** Empire buildings by kind (registered in belle/index.ts BE_NATION_BUILDING_MODELS). */
export const BUILDINGS_EMP = {
  hq: citadelle,
  airpad: aerodrome,
  "tech-lab": hautFourneau,
  "flak-battery": flakBattery,
  radar: ballon,
  "assembly-bay": caserne
} satisfies Record<string, (t: Team) => ModelDef>;
