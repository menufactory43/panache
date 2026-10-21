import * as THREE from "three";
import type { ModelBuilder } from "../builder";
import { AMBER, BRASS, CANVAS, TRACK, light, partB, siteB, type ModelDef, type Team } from "../models";
import { COPPER, IRON, RADIUM, WOOD, WOOD_D, pylon, rib, rod, vault } from "./buildings";

/**
 * The République's new buildings (PANACHE-CONCEPTION.md §1.6, §1.11):
 * Garage électrique Jeantaud (fab-plant), Station de charge (depot), Bobine
 * d'Arsonval (arsonval) and Hangar du Zénith (gantry). Ivory, glass and blued
 * iron lattice, the team colour (navy) on roofs, domes and tinted glass,
 * electric-blue lights. Same contracts and footprints as the Classique kind
 * they replace (buildings.ts): centred, 2 tiles across (3 for the Hangar, 1 for
 * the Bobine). `t` is the nation's colour (NATION_TEAMS) for the seat.
 *
 * (models.ts imports this module through belle/index.ts: nothing is built at load.)
 */

const IVORY = 0xeee5cf;
const IVORY_D = 0xc8bc9c;
const IVORY_L = 0xfaf5e8;
/** Blued wrought iron. */
const LATTICE = 0x36424e;
const GLASS_R = 0xa9cfe0;
/** Electric blue (lit). */
const ELEC = 0x8fdcff;
const PAVE = 0x9a9384;
const COIL = 0xd08a4a;

/** `a` toward `b` by `k` (team-tinted glass). */
function mix(a: number, c: number, k: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(c), k).getHex();
}

/** An electric arc lamp: a slim iron post and a glowing globe. */
function arcLamp(b: ModelBuilder, x: number, z: number, y0: number, h = 0.32): void {
  b.cyl(0.01, 0.016, h, 5, [x, y0 + h / 2, z], LATTICE);
  b.sphere(0.03, [x, y0 + h + 0.02, z], ELEC, { glow: 1, w: 6, h: 4 });
}

/** A charging post (borne): an ivory column, a brass cap, a lit dial. */
function borne(b: ModelBuilder, x: number, z: number, y0: number, h = 0.26): void {
  b.cyl(0.045, 0.055, h, 6, [x, y0 + h / 2, z], IVORY);
  b.cyl(0.055, 0.045, 0.03, 6, [x, y0 + h + 0.015, z], BRASS);
  b.box(0.05, 0.05, 0.05, [x, y0 + h - 0.05, z], ELEC, { glow: 0.9 });
}

// ------------------------------------------------------------ Garage ---

/**
 * Garage électrique Jeantaud: an ivory hall under an arched team-tinted glass
 * roof on blued iron ribs, a great arched portal on the south front, a lattice
 * pylon on the ridge feeding two charging posts on the apron.
 */
function garage(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], IVORY_D, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  b.box(1.7, 0.02, 0.5, [0, y0 + 0.01, 0.66], PAVE);
  const [w, z0, z1] = [1.52, -0.88, 0.38];
  const len = z1 - z0;
  const zc = (z0 + z1) / 2;
  const wh = 0.34;
  // the hall's walls, socle and cornice; tall lit windows along the sides
  b.block(w, wh, len, [0, y0 + wh / 2, zc], IVORY, { bevel: 0.015 });
  b.box(w + 0.04, 0.05, len + 0.04, [0, y0 + 0.025, zc], IVORY_D);
  b.box(w + 0.05, 0.035, len + 0.05, [0, y0 + wh, zc], IVORY_L);
  for (let i = 0; i < 4; i++) {
    const z = z0 + 0.2 + i * 0.28;
    b.pair(0.02, 0.18, 0.12, [w / 2 + 0.005, y0 + 0.18, z], GLASS_R, { glow: 0.45 });
  }
  // the vault: team-tinted glass on iron ribs, a lattice ridge
  const r = w / 2 + 0.01;
  const hy = 0.62;
  vault(b, r, len, [0, y0 + wh, zc], mix(t.main, GLASS_R, 0.12), { seg: 12, hy, glow: 0.08 });
  for (let i = 0; i < 5; i++) rib(b, r + 0.012, 0.014, [0, y0 + wh, z0 + 0.04 + (i * (len - 0.08)) / 4], LATTICE, 0, hy);
  b.box(0.1, 0.04, len, [0, y0 + wh + r * hy + 0.01, zc], t.dark);
  // the north end closed in ivory, the south front: a glazed fan over the dark portal, the sign
  vault(b, r - 0.01, 0.03, [0, y0 + wh, z0 - 0.005], IVORY, { seg: 12, hy });
  vault(b, r - 0.01, 0.03, [0, y0 + wh, z1 + 0.005], GLASS_R, { seg: 12, hy, glow: 0.35 });
  rib(b, r, 0.03, [0, y0 + wh, z1 + 0.02], IVORY_L, 0, hy);
  b.box(0.62, 0.3, 0.03, [0, y0 + 0.15, z1 + 0.01], 0x161c22);
  vault(b, 0.31, 0.035, [0, y0 + 0.3, z1 + 0.012], 0x161c22, { seg: 8 });
  rib(b, 0.32, 0.022, [0, y0 + 0.3, z1 + 0.03], IVORY_L);
  b.box(0.6, 0.05, 0.02, [0, y0 + wh + 0.04, z1 + 0.035], t.light);
  b.box(0.5, 0.02, 0.022, [0, y0 + wh + 0.04, z1 + 0.04], BRASS);
  // the pylon on the ridge: a lattice, a cross-arm with insulators, a crackling spark
  const py = y0 + wh + r * hy + 0.03;
  const pz = z0 + 0.32;
  pylon(b, 0, pz, 0.09, 0.03, py, py + 0.6, 2, 0.012, 0.005, LATTICE);
  b.box(0.42, 0.02, 0.02, [0, py + 0.5, pz], LATTICE);
  for (const sx of [-1, 1]) b.cyl(0.014, 0.014, 0.04, 5, [sx * 0.2, py + 0.53, pz], IVORY_L);
  b.sphere(0.03, [0, py + 0.63, pz], ELEC, { glow: 1, w: 6, h: 4 });
  // wires down to the charging posts on the apron
  for (const sx of [-1, 1]) {
    borne(b, sx * 0.6, 0.72, y0);
    rod(b, [sx * 0.2, py + 0.53, pz], [sx * 0.6, y0 + 0.3, 0.72], 0.004, TRACK);
  }
  arcLamp(b, 0.86, 0.3, y0);
  arcLamp(b, -0.86, 0.3, y0);
  light(b, [-0.86, y0 + 0.02, 0.86], 0.05);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.5 };
}

// --------------------------------------------------- Station de charge ---

/**
 * Station de charge: an ivory octagonal kiosk under a wide team dome on iron
 * columns, a glass lantern on top; charging posts at the corners, cables to the
 * eaves, a rack of glass accumulators and a crate of radium.
 */
function station(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], IVORY_D, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  const cz = -0.08;
  b.cyl(0.78, 0.8, 0.03, 16, [0, y0 + 0.015, cz], PAVE);
  // the kiosk: an ivory drum with lit glass, iron columns round it
  b.drum(0.36, 0.34, 0.34, 8, [0, y0 + 0.17, cz], IVORY, { rot: [0, Math.PI / 8, 0], bevel: 0.015 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(0.13, 0.16, 0.02, [Math.sin(a) * 0.35, y0 + 0.2, cz + Math.cos(a) * 0.35], GLASS_R, { rot: [0, a, 0], glow: 0.55 });
    const c = a + Math.PI / 8;
    b.cyl(0.018, 0.022, 0.4, 5, [Math.sin(c) * 0.6, y0 + 0.2, cz + Math.cos(c) * 0.6], LATTICE);
  }
  // the canopy: a dark team eave, the team dome, brass ribs, the lantern
  const ey = y0 + 0.4;
  b.drum(0.72, 0.7, 0.05, 12, [0, ey + 0.025, cz], t.dark, { bevel: 0.01 });
  b.sphere(0.66, [0, ey + 0.04, cz], t.main, { w: 14, h: 5, phi: Math.PI / 2, scale: [1, 0.55, 1] });
  for (let i = 0; i < 4; i++) rib(b, 0.665, 0.011, [0, ey + 0.04, cz], BRASS, (i * Math.PI) / 4, 0.55);
  const ly = ey + 0.04 + 0.66 * 0.55;
  b.cyl(0.09, 0.1, 0.1, 8, [0, ly + 0.03, cz], GLASS_R, { glow: 0.8 });
  b.cone(0.11, 0.08, 8, [0, ly + 0.12, cz], t.dark);
  b.cyl(0.006, 0.006, 0.16, 4, [0, ly + 0.24, cz], LATTICE);
  b.sphere(0.022, [0, ly + 0.33, cz], ELEC, { glow: 1, w: 6, h: 4 });
  // charging posts at the corners, their cables up to the eave
  for (const [x, z] of [[-0.74, -0.74], [0.74, -0.74], [-0.74, 0.62], [0.74, 0.62]] as [number, number][]) {
    borne(b, x, z, y0);
    const k = 0.7 / Math.hypot(x, z - cz);
    rod(b, [x, y0 + 0.26, z], [x * k, ey, cz + (z - cz) * k], 0.005, TRACK);
  }
  // the accumulator rack (glass jars, copper plates) and a crate of radium
  b.block(0.5, 0.05, 0.14, [0, y0 + 0.025, 0.82], WOOD, { bevel: 0.01 });
  for (const x of [-0.17, 0, 0.17]) {
    b.box(0.1, 0.12, 0.09, [x, y0 + 0.11, 0.82], GLASS_R, { glow: 0.5 });
    b.box(0.08, 0.02, 0.012, [x, y0 + 0.18, 0.82], COPPER);
  }
  b.block(0.16, 0.1, 0.16, [-0.42, y0 + 0.05, 0.84], WOOD_D, { bevel: 0.012 });
  b.box(0.1, 0.02, 0.1, [-0.42, y0 + 0.105, 0.84], RADIUM, { glow: 0.9 });
  arcLamp(b, 0.86, 0.0, y0);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.25 };
}

// ---------------------------------------------------- Bobine d'Arsonval ---

/**
 * Bobine d'Arsonval: an ivory octagonal plinth with a team socle, a stack of
 * insulators and a column of copper turns braced by iron struts. The head
 * (turret) is a brass toroid round the team sphere with a forked emitter that
 * swings to its target (muzzle at the spark). `parts.arc`: the crackling arcs
 * round the toroid — the renderer may show it only while the coil is powered
 * (WP1's network: `m.parts.arc.visible = powered`); visible by default.
 */
function arsonval(t: Team): ModelDef {
  const b = siteB();
  b.drum(0.44, 0.4, 0.12, 8, [0, 0.06, 0], IVORY_D, { rot: [0, Math.PI / 8, 0], bevel: 0.02 });
  b.drum(0.36, 0.33, 0.06, 8, [0, 0.15, 0], t.main, { rot: [0, Math.PI / 8, 0], bevel: 0.012, edge: 1.4 });
  // team pennants at the plinth's corners, so the side reads with the head turned
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.block(0.12, 0.03, 0.08, [Math.sin(a) * 0.38, 0.135, Math.cos(a) * 0.38], t.main, { rot: [0, a, 0], bevel: 0.01, edge: 1.4 });
  }
  for (let i = 0; i < 3; i++) b.cyl(0.07, 0.09, 0.05, 8, [0, 0.21 + i * 0.05, 0], IVORY_L);
  b.cyl(0.11, 0.12, 0.42, 10, [0, 0.52, 0], COPPER);
  for (let i = 0; i < 5; i++) b.cyl(0.128, 0.128, 0.022, 10, [0, 0.36 + i * 0.08, 0], COIL);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    rod(b, [Math.sin(a) * 0.3, 0.18, Math.cos(a) * 0.3], [Math.sin(a) * 0.13, 0.72, Math.cos(a) * 0.13], 0.012, LATTICE);
  }
  b.drum(0.13, 0.11, 0.04, 8, [0, 0.75, 0], BRASS, { bevel: 0.01 });
  const hull = b.build();
  // the head: toroid, team sphere, the forked emitter pointing north
  const h = partB();
  h.drum(0.09, 0.08, 0.04, 8, [0, 0.02, 0], BRASS, { bevel: 0.01 });
  h.torus(0.17, 0.045, [0, 0.07, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 12 });
  h.sphere(0.13, [0, 0.16, 0], t.main, { w: 12, h: 8 });
  h.cyl(0.133, 0.133, 0.016, 12, [0, 0.16, 0], BRASS);
  h.cyl(0.035, 0.035, 0.05, 6, [0, 0.16, -0.15], IVORY_L, { rot: [Math.PI / 2, 0, 0] });
  h.tube(0.014, 0.16, 6, [0, 0.16, -0.24], BRASS);
  h.pair(0.012, 0.012, 0.08, [0.03, 0.16, -0.33], BRASS, { rot: [0, 0.35, 0] });
  h.sphere(0.03, [0, 0.16, -0.37], ELEC, { glow: 1, w: 6, h: 4 });
  // the arcs: jagged sparks from the toroid out and down, all round
  const arc = partB();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const [cx, cz] = [Math.sin(a), Math.cos(a)];
    arc.box(0.11, 0.012, 0.012, [cx * 0.25, 0.04, cz * 0.25], ELEC, { rot: [0, -a + Math.PI / 2, 0.5], glow: 1 });
    arc.box(0.09, 0.012, 0.012, [cx * 0.33, -0.04, cz * 0.33], ELEC, { rot: [0, -a + Math.PI / 2, -0.6], glow: 1 });
  }
  return {
    hull, turret: h.build(), mount: [0, 0.77, 0], muzzle: [0, 0.16, -0.37], rotors: [], height: 1.15,
    parts: { arc: { geo: arc.build(), at: [0, 0.84, 0] } }
  };
}

// ------------------------------------------------------ Hangar du Zénith ---

/**
 * Hangar du Zénith (gantry, 3×3): a long airship hall, a team vault on blued
 * iron ribs with a glazed ridge, the north end closed in ivory with a rose
 * window, the south end open, its doors slid aside along the front and the
 * Zénith's nose in the dark. East of it the tall lattice mooring mast carries
 * the crane. Keeps the Gantry's moving parts by name (render/goliath.ts
 * GantryView drives them): `armL`/`armR` are two handling booms either side of
 * the doorway (they swing clear for a rollout), `jib`/`cable`/`hook`/`plate` the
 * mast's crane (same pivot as the Galerie's), `lightsOn`/`lightsOff` the apron
 * lamps, `blink` the beacons. No `stage*` parts: the airship is built inside
 * (WP2/WP5e may add stages; GantryView skips missing ones).
 */
function hangar(t: Team): ModelDef {
  const b = siteB();
  b.block(2.9, 0.14, 2.9, [0, 0.07, 0], IVORY_D, { taper: 0.02, bevel: 0.04 });
  const y0 = 0.14;
  b.box(1.9, 0.02, 0.5, [-0.25, y0 + 0.01, 1.15], PAVE);
  const hx = -0.25;
  const r = 0.98;
  const hy = 1.05;
  const len = 2.5;
  // ivory side walls, the team vault, ribs and the glazed ridge
  for (const sx of [-1, 1]) b.block(0.1, 0.16, len, [hx + sx * r, y0 + 0.08, 0], IVORY, { bevel: 0.015 });
  vault(b, r, len, [hx, y0 + 0.12, 0], t.main, { seg: 14, hy });
  for (let i = 0; i < 5; i++) rib(b, r + 0.012, 0.018, [hx, y0 + 0.12, -len / 2 + 0.05 + (i * (len - 0.1)) / 4], LATTICE, 0, hy);
  b.box(0.18, 0.025, len - 0.1, [hx, y0 + 0.12 + r * hy + 0.005, 0], GLASS_R, { glow: 0.4 });
  // the north end: ivory, a rose window
  vault(b, r - 0.01, 0.04, [hx, y0 + 0.12, -len / 2], IVORY, { seg: 14, hy });
  b.cyl(0.2, 0.2, 0.02, 10, [hx, y0 + 0.62, -len / 2 - 0.02], GLASS_R, { rot: [Math.PI / 2, 0, 0], glow: 0.6 });
  b.torus(0.2, 0.02, [hx, y0 + 0.62, -len / 2 - 0.03], BRASS, { seg: 12 });
  // the south end open on the dark hall, an ivory frame, the Zénith's nose
  vault(b, r - 0.06, 0.03, [hx, y0 + 0.12, len / 2 - 0.02], 0x14181d, { seg: 14, hy });
  rib(b, r, 0.035, [hx, y0 + 0.12, len / 2], IVORY_L, 0, hy);
  b.sphere(0.5, [hx, y0 + 0.6, len / 2 - 0.42], CANVAS, { w: 10, h: 6, scale: [1, 0.95, 1.2] });
  b.torus(0.47, 0.014, [hx, y0 + 0.6, len / 2 - 0.2], t.main, { seg: 14 });
  // the sliding doors, run back along the front either side
  for (const sx of [-1, 1]) {
    b.block(0.5, 0.95, 0.05, [hx + sx * (r + 0.12), y0 + 0.48, len / 2 + 0.06], IVORY, { bevel: 0.012 });
    b.box(0.5, 0.04, 0.055, [hx + sx * (r + 0.12), y0 + 0.9, len / 2 + 0.06], t.dark);
    b.box(0.6, 0.02, 0.03, [hx + sx * (r + 0.12), y0 + 0.02, len / 2 + 0.06], IRON);
  }
  // the mooring mast east of the hall: stone foot, a tall lattice, a team platform, the mooring cone
  const [mx, mz] = [1.3, -0.72];
  b.block(0.36, 0.08, 0.36, [mx, y0 + 0.04, mz], IVORY, { bevel: 0.015 });
  pylon(b, mx, mz, 0.15, 0.05, y0 + 0.08, 3.62, 5, 0.018, 0.007, LATTICE);
  b.block(0.26, 0.03, 0.26, [mx, 1.6, mz], t.main, { bevel: 0.01, edge: 1.4 });
  b.block(0.2, 0.06, 0.2, [mx, 3.65, mz], t.main, { bevel: 0.012, edge: 1.4 });
  b.cone(0.07, 0.12, 8, [mx, 3.74, mz], BRASS, { rot: [Math.PI, 0, 0] });
  arcLamp(b, 0.9, 1.3, y0);
  arcLamp(b, -1.35, 1.3, y0);
  light(b, [1.38, y0 + 0.02, 1.38], 0.05);
  light(b, [-1.38, y0 + 0.02, -1.38], 0.05);
  const hull = b.build();

  // the handling booms either side of the doorway, across it at rest
  const arm = (sx: number) => {
    const a = partB();
    a.drum(0.07, 0.06, 0.1, 8, [0, -0.05, 0], BRASS, { bevel: 0.01 });
    a.block(0.8, 0.04, 0.06, [-sx * 0.42, 0.02, 0], LATTICE, { bevel: 0.01 });
    a.block(0.6, 0.02, 0.05, [-sx * 0.42, 0.05, 0], t.main, { bevel: 0.006 });
    a.box(0.04, 0.12, 0.04, [-sx * 0.8, -0.04, 0], LATTICE);
    a.sphere(0.02, [-sx * 0.8, 0.04, 0], ELEC, { glow: 1, w: 6, h: 4 });
    return a.build();
  };
  // the crane on the mast: a latticed jib, the cable (a unit length, stretched), the hook and a girder it carries
  const jib = partB();
  for (const sy of [-1, 1]) jib.box(0.08, 0.02, 1.7, [0, sy * 0.035, -0.85], LATTICE);
  for (let i = 0; i < 6; i++) rod(jib, [0, -0.035, -0.08 - i * 0.27], [0, 0.035, -0.2 - i * 0.27], 0.009, LATTICE);
  jib.block(0.18, 0.14, 0.22, [0, 0, 0.2], IVORY, { bevel: 0.02 });
  jib.block(0.17, 0.02, 0.2, [0, 0.075, 0.2], t.main, { bevel: 0.008 });
  light(jib, [0, 0.06, -1.68], 0.03);
  const cable = partB();
  cable.box(0.012, 1, 0.012, [0, -0.5, 0], TRACK);
  const hook = partB();
  hook.block(0.1, 0.07, 0.08, [0, -0.035, 0], LATTICE, { bevel: 0.01 });
  hook.box(0.025, 0.07, 0.025, [0, -0.1, 0], BRASS);
  const plate = partB();
  plate.block(0.5, 0.05, 0.08, [0, -0.17, 0], LATTICE, { bevel: 0.01 });
  plate.box(0.4, 0.012, 0.05, [0, -0.14, 0], t.main);
  for (const x of [-0.12, 0.12]) plate.box(0.006, 0.12, 0.006, [x, -0.08, 0], TRACK, { rot: [0, 0, x * 2] });
  // apron lamps (lit and dark) and the beacons
  const lamps = (lit: boolean) => {
    const l = partB();
    for (const sx of [-1, 1])
      for (let i = 0; i < 3; i++) l.box(0.06, 0.025, 0.06, [hx + sx * 0.75, y0 + 0.02, 0.98 + i * 0.17], lit ? ELEC : 0x30404c, lit ? { glow: 1 } : {});
    return l.build();
  };
  const blink = partB();
  blink.sphere(0.04, [mx, 3.84, mz], 0xff5a3a, { glow: 1, w: 6, h: 4 });
  for (const sx of [-1, 1]) blink.box(0.06, 0.05, 0.06, [hx + sx * (r + 0.02), y0 + 0.2, len / 2 + 0.04], AMBER, { glow: 1 });
  const parts: NonNullable<ModelDef["parts"]> = {
    armL: { geo: arm(-1), at: [hx - r + 0.04, y0 + 0.12, 1.38] },
    armR: { geo: arm(1), at: [hx + r - 0.04, y0 + 0.12, 1.38] },
    jib: { geo: jib.build(), at: [mx, 3.84, mz] },
    cable: { geo: cable.build(), at: [0, 0, -1], parent: "jib" },
    hook: { geo: hook.build(), at: [0, -1, -1], parent: "jib" },
    plate: { geo: plate.build(), at: [0, 0, 0], parent: "hook" },
    lightsOn: { geo: lamps(true), at: [0, 0, 0] },
    lightsOff: { geo: lamps(false), at: [0, 0, 0] },
    blink: { geo: blink.build(), at: [0, 0, 0] }
  };
  return { hull, mount: [0, 0, 0], muzzle: [0, 1.2, 0], rotors: [], parts, height: 2.2 };
}

/** République buildings by kind (registered in belle/index.ts BE_NATION_BUILDING_MODELS). */
export const BUILDINGS_REP = {
  "fab-plant": garage,
  depot: station,
  arsonval,
  gantry: hangar
} satisfies Record<string, (t: Team) => ModelDef>;

