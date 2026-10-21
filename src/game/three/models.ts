import * as THREE from "three";
import type { BuildingKind, ClassicBuildingKind, ClassicUnitKind, Faction, UnitKind } from "../../sim/types";
import { BUILDINGS, UNITS } from "../../sim/balance";
import { ModelBuilder, type Section, type Vec3 } from "./builder";
import { GANTRY_STAGES, GOLIATH_RIG, gantryStage, goliathStatic } from "./goliath";
import { botStatic, botHeight, J, squadStatic, type BotKind } from "./infantry";
import { modelMat } from "./materials";
import { BELLE_EPOQUE } from "./theme";
import { BE_BUILDING_MODELS, BE_OBJECTIVES, BE_UNIT_MODELS, NATION_TEAMS, PLACEHOLDER_BUILDING, PLACEHOLDER_MODEL } from "./belle";

/**
 * Every vehicle, aircraft, building and map objective as a procedural
 * low-poly model in the game's painted style: weathered gunmetal, royal-blue
 * (or crimson) team panels, amber lights. Units point north (-Z) with their
 * origin on the ground at the hull centre; buildings sit centred on their
 * footprint. Turrets, heads, dishes and rotors are separate parts so they
 * can track targets and spin.
 *
 * Readability rules (phone first): every unit shows a solid patch of team
 * colour on top (fenders, turret roof, wing panels, rotor ducts), main armour
 * blocks get a chamfered, highlighted top edge, and parts are shaded darker
 * toward their base so they separate from each other and from the ground
 * even when shadows are off.
 *
 * World units are tiles (1 = one map tile).
 */

// Belle Époque (theme.ts): bronze bodies, blackened iron, polished brass, gaslight amber, ivory.
export const GM = BELLE_EPOQUE ? 0x8a6a3c : 0x50575f;
export const GM_D = BELLE_EPOQUE ? 0x3d3026 : 0x31353b;
export const GM_L = BELLE_EPOQUE ? 0xd2a856 : 0x747d87;
export const TRACK = BELLE_EPOQUE ? 0x2a2019 : 0x1c1e21;
export const BARREL = BELLE_EPOQUE ? 0x3a2f26 : 0x2a2d31;
export const AMBER = BELLE_EPOQUE ? 0xffc561 : 0xff9c1f;
export const WHITE = BELLE_EPOQUE ? 0xeadfc4 : 0xd6dbe1;
export const HAZ = BELLE_EPOQUE ? 0xc9a24a : 0xe0b23a;
export const HAZ_D = 0x2b2a28;
export const GREEN = 0x5dff8a;
/** Amber-tinted cockpit glass (lit a little from inside). */
export const GLASS = BELLE_EPOQUE ? 0xe2a64a : 0xcf7f2a;
export const EXHAUST = 0xffa040;
/** Belle Époque dirigible: varnished canvas and polished brass. */
export const CANVAS = 0xe4d6b4;
export const BRASS = 0xd8ae58;

export interface Team {
  main: number;
  dark: number;
  light: number;
}

export const TEAMS: Record<Faction, Team> = BELLE_EPOQUE
  ? {
      blue: { main: 0x2f5fb8, dark: 0x1c3566, light: 0x7d9fd8 },
      red: { main: 0xb02a24, dark: 0x5e1612, light: 0xe0705c }
    }
  : {
      blue: { main: 0x2a6cf2, dark: 0x1a3f94, light: 0x7aacff },
      red: { main: 0xe0322e, dark: 0x8c1c16, light: 0xff7a62 }
    };

/** A spinning part: geometry pivoting at its own origin, placed at `at`, spinning about `axis`. */
export interface Rotor {
  geo: THREE.BufferGeometry;
  at: Vec3;
  axis: "y" | "z";
  speed: number;
}

export interface ModelDef {
  hull: THREE.BufferGeometry;
  /** Rotating turret / head, pivoting at its origin, mounted at `mount` in hull space. */
  turret?: THREE.BufferGeometry;
  mount: Vec3;
  /** Muzzle point in turret space (or hull space without a turret). */
  muzzle: Vec3;
  rotors: Rotor[];
  /** Harvester's scrap load (shown when full). */
  cargo?: THREE.BufferGeometry;
  /**
   * Condor's rear ramp: hinged at `hinge`, closed pointing up; it opens by
   * turning +x (down and back) to `open` rad. `tip` is its lip in ramp space
   * (where squads step off and climb aboard).
   */
  ramp?: { geo: THREE.BufferGeometry; hinge: Vec3; open: number; tip: Vec3 };
  /**
   * Further moving parts, by name (the Gantry's scaffold arms, crane jib and
   * hook, its floor lights lit and dark): each a pivot at `at` in its
   * parent's space (another part, or the hull), its geometry built about
   * that pivot. Parents come first.
   */
  parts?: Record<string, { geo: THREE.BufferGeometry; at: Vec3; parent?: string }>;
  /** Model height, for labels and bars. */
  height: number;
}

// ------------------------------------------------------------ helpers ---

/** Ground hulls: per-part grade plus contact occlusion near the ground. */
export const hullB = () => new ModelBuilder({ grade: 0.3, ao: [0.12, 0.4] });
/** Turrets, heads and aircraft: per-part grade only (their origin isn't the ground). */
export const partB = () => new ModelBuilder({ grade: 0.26 });
/** Buildings and objectives: a gentler grade, occlusion over a taller band. */
export const siteB = () => new ModelBuilder({ grade: 0.22, ao: [0.3, 0.38] });

/**
 * Rear rotor rings: halfway from the team's dark shade to its main colour, so
 * the front pair still reads as the nose but the rear stays team-bright over
 * dark ground (team-dark alone sinks into ash and shadow).
 */
export function rearRing(t: Team): number {
  return ((t.main >> 1) & 0x7f7f7f) + ((t.dark >> 1) & 0x7f7f7f);
}

/** A barrel of length `len` from base point `at`, pitched up by `pitch`, along -Z. */
export function barrel(b: ModelBuilder, at: Vec3, r: number, len: number, pitch: number, hex: number, seg = 6): void {
  const dy = Math.sin(pitch);
  const dz = -Math.cos(pitch);
  b.tube(r, len, seg, [at[0], at[1] + (dy * len) / 2, at[2] + (dz * len) / 2], hex, { rot: [pitch, 0, 0] });
}

/** End of a pitched barrel. */
export function barrelTip(at: Vec3, len: number, pitch: number): Vec3 {
  return [at[0], at[1] + Math.sin(pitch) * len, at[2] - Math.cos(pitch) * len];
}

export function wheels(b: ModelBuilder, x: number, y: number, r: number, w: number, zs: number[]): void {
  for (const z of zs) {
    b.cyl(r, r, w, 10, [x, y, z], TRACK, { rot: [0, 0, Math.PI / 2] });
    b.cyl(r, r, w, 10, [-x, y, z], TRACK, { rot: [0, 0, Math.PI / 2] });
    b.cyl(r * 0.45, r * 0.45, w + 0.01, 6, [x, y, z], GM_L, { rot: [0, 0, Math.PI / 2] });
    b.cyl(r * 0.45, r * 0.45, w + 0.01, 6, [-x, y, z], GM_L, { rot: [0, 0, Math.PI / 2] });
  }
}

/** A tracked running gear: track block, road wheels and a team fender. */
export function tracks(b: ModelBuilder, x: number, w: number, h: number, len: number, z = 0, fender?: number): void {
  for (const s of [1, -1]) {
    b.block(w, h, len, [s * x, h / 2 + 0.01, z], TRACK, { bevel: h * 0.3, edge: 1.8 });
    const n = Math.max(3, Math.round(len / 0.16));
    for (let i = 0; i < n; i++) {
      const wz = z - len / 2 + (len * (i + 0.5)) / n;
      b.cyl(h * 0.32, h * 0.32, w + 0.012, 8, [s * x, h * 0.42, wz], GM_D, { rot: [0, 0, Math.PI / 2] });
    }
    if (fender !== undefined) b.block(w + 0.03, 0.03, len * 0.86, [s * x, h + 0.025, z + len * 0.03], fender, { bevel: 0.012, edge: 1.35 });
  }
}

export function light(b: ModelBuilder, at: Vec3, s = 0.03, hex = AMBER): void {
  b.box(s, s * 0.8, s, at, hex, { glow: 1 });
}

/** A rotor: two crossed blades and a hub. */
export function rotorGeo(r: number, axis: "y" | "z" = "y"): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const rot: Vec3 = axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  b.box(r * 2, 0.008, r * 0.18, [0, 0, 0], 0x1a1c1f, { rot });
  b.box(r * 0.18, 0.008, r * 2, [0, 0, 0], 0x1a1c1f, { rot });
  b.cyl(r * 0.22, r * 0.22, 0.03, 6, [0, 0, 0], GM_L, { rot });
  return b.build();
}

/** An outline drawn on the right (x ≥ 0), or mirrored to the left for `s` -1 (wound the same way). */
export function sided(pts: [number, number][], s: number): [number, number][] {
  return s > 0 ? pts : pts.map(([x, z]): [number, number] => [-x, z]).reverse();
}

/** A tapered octagonal skirt, flat faces to the front, back and sides, `w` × `d` at its foot. */
export function skirt(b: ModelBuilder, w: number, d: number, h: number, taper: number, at: Vec3, hex: number, glow = 0): void {
  const k = 1 / Math.cos(Math.PI / 8);
  b.add(new THREE.CylinderGeometry(1 - taper, 1, h, 8, 1, false, Math.PI / 8), at, hex, { scale: [(w / 2) * k, 1, (d / 2) * k], glow });
}

/** A glowing jet nozzle pointing back (+Z) at `at`. */
export function nozzle(b: ModelBuilder, at: Vec3, r: number): void {
  b.tube(r, 0.06, 8, at, GM_D);
  b.sphere(r * 0.85, [at[0], at[1], at[2] + 0.03], EXHAUST, { glow: 1, w: 6, h: 4, scale: [1, 1, 0.7] });
}

/** An air-to-air missile along -Z: white body, team nose, dark cruciform tail fins. */
export function missile(b: ModelBuilder, at: Vec3, len: number, t: Team, r = 0.018): void {
  const [x, y, z] = at;
  b.tube(r, len, 6, at, WHITE);
  b.cone(r, r * 2.6, 6, [x, y, z - len / 2 - r * 1.3], t.main, { rot: [-Math.PI / 2, 0, 0] });
  b.box(r * 3.4, 0.004, r * 1.8, [x, y, z + len / 2 - r], GM_D);
  b.box(0.004, r * 3.4, r * 1.8, [x, y, z + len / 2 - r], GM_D);
}

/** A round strut from `a` to `c` (legs, stabilisers). */
export function strut(m: ModelBuilder, a: Vec3, c: Vec3, r: number, hex: number): void {
  const d = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = d.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  m.cyl(r, r, len, 6, [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], hex, { rot: [e.x, e.y, e.z] });
}

/** A standing shell: grey case, amber tip. */
export function shell(b: ModelBuilder, at: Vec3, r = 0.016): void {
  b.cyl(r, r, r * 4, 6, at, GM_L);
  b.cone(r, r * 2, 6, [at[0], at[1] + r * 3, at[2]], AMBER, { glow: 0.4 });
}

/**
 * The Flak Crawler's six legs (its ModelDef.parts, each pivoting at its hip),
 * as the walk needs them (render/entities.ts): the side (+1 right), which
 * tripod it steps with (front and back on one side, the middle on the other)
 * and its angle out from the side (front legs negative, toward -Z).
 */
export interface CrawlerLeg {
  name: string;
  side: 1 | -1;
  tripod: 0 | 1;
  angle: number;
}
export const CRAWLER_LEGS: readonly CrawlerLeg[] = ([1, -1] as const).flatMap((side) =>
  [-0.8, 0, 0.8].map((angle, i): CrawlerLeg => ({ name: `leg${side > 0 ? "R" : "L"}${i}`, side, tripod: (side > 0) === (i !== 1) ? 0 : 1, angle }))
);

// -------------------------------------------------------------- units ---

type UnitBuilder = (t: Team) => ModelDef;

const UNIT_MODELS: Record<ClassicUnitKind, UnitBuilder> = {
  stinger: (t) => {
    const b = hullB();
    tracks(b, 0.235, 0.17, 0.15, 0.8, 0, t.main);
    b.block(0.34, 0.14, 0.72, [0, 0.2, 0.02], GM, { taper: 0.16, bevel: 0.035 });
    b.block(0.32, 0.05, 0.14, [0, 0.19, -0.37], GM_D, { rot: [0.55, 0, 0], bevel: 0.015 });
    // a team chevron on the front deck points the way
    b.pair(0.13, 0.014, 0.04, [0.055, 0.276, -0.215], t.main, { rot: [0, -0.5, 0] });
    b.block(0.26, 0.045, 0.16, [0, 0.29, 0.27], GM_D, { bevel: 0.015 });
    b.pair(0.03, 0.03, 0.06, [0.08, 0.32, 0.33], BARREL);
    light(b, [0.12, 0.22, -0.41]);
    light(b, [-0.12, 0.22, -0.41]);
    const hull = b.build();
    const tu = partB();
    tu.drum(0.17, 0.14, 0.11, 7, [0, 0.055, 0], GM, { bevel: 0.025 });
    tu.drum(0.115, 0.095, 0.03, 7, [0, 0.125, 0.01], t.main, { bevel: 0.012 });
    tu.pairBlock(0.05, 0.05, 0.16, [0.13, 0.065, 0.03], t.main, { bevel: 0.012 });
    tu.block(0.1, 0.07, 0.07, [0, 0.065, -0.15], GM_D, { bevel: 0.015 });
    barrel(tu, [0, 0.065, -0.12], 0.026, 0.34, 0.02, BARREL);
    tu.tube(0.036, 0.06, 6, [0, 0.07, -0.45], GM_D);
    tu.cyl(0.04, 0.045, 0.025, 6, [0.045, 0.152, 0.05], GM_D);
    light(tu, [-0.085, 0.13, -0.07], 0.025);
    return { hull, turret: tu.build(), mount: [0, 0.27, 0.04], muzzle: [0, 0.07, -0.48], rotors: [], height: 0.45 };
  },

  "flak-crawler": (t) => {
    // a Crawler that crawls: a hex body on six jointed legs (moving parts: they walk, render/entities.ts),
    // a team carapace, four guns pitched at the sky. No tracks, no fenders: nothing like the tanks.
    const b = hullB();
    b.drum(0.2, 0.17, 0.08, 6, [0, 0.13, 0], GM_D, { scale: [1, 1, 1.3], bevel: 0.015 });
    b.drum(0.24, 0.2, 0.12, 6, [0, 0.19, 0], GM, { scale: [1, 1, 1.3], bevel: 0.03 });
    b.drum(0.19, 0.15, 0.03, 6, [0, 0.31, 0], t.main, { scale: [1, 1, 1.3], bevel: 0.012 });
    // a head with amber eyes
    b.block(0.16, 0.08, 0.1, [0, 0.22, -0.32], GM_D, { bevel: 0.015 });
    light(b, [0.045, 0.24, -0.37], 0.025);
    light(b, [-0.045, 0.24, -0.37], 0.025);
    const hull = b.build();
    // each leg about its hip: a thigh up and out to a team-coloured knee, a shin down to the foot
    const parts: NonNullable<ModelDef["parts"]> = {};
    for (const leg of CRAWLER_LEGS) {
      const dx = leg.side * Math.cos(leg.angle);
      const dz = Math.sin(leg.angle);
      const hip: Vec3 = [dx * 0.17, 0.22, dz * 0.22];
      const knee: Vec3 = [dx * 0.34 - hip[0], 0.34 - hip[1], dz * 0.4 - hip[2]];
      const foot: Vec3 = [dx * 0.45 - hip[0], 0.01 - hip[1], dz * 0.5 - hip[2]];
      const lb = partB();
      strut(lb, [0, 0, 0], knee, 0.032, GM_D);
      strut(lb, knee, foot, 0.026, GM);
      lb.sphere(0.04, knee, t.main, { w: 6, h: 4 });
      lb.cone(0.03, 0.04, 5, [foot[0], foot[1] + 0.01, foot[2]], TRACK);
      parts[leg.name] = { geo: lb.build(), at: hip };
    }
    const tu = partB();
    tu.drum(0.12, 0.1, 0.08, 8, [0, 0.04, 0.02], GM, { bevel: 0.02 });
    const pitch = 0.85;
    tu.block(0.18, 0.06, 0.06, [0, 0.07, -0.07], GM_D, { rot: [pitch, 0, 0], bevel: 0.01 });
    for (const x of [-0.065, -0.025, 0.025, 0.065]) barrel(tu, [x, 0.07, -0.07], 0.014, 0.3, pitch, BARREL, 5);
    light(tu, [0, 0.09, 0.08], 0.02);
    return { hull, turret: tu.build(), mount: [0, 0.32, 0.04], muzzle: barrelTip([0, 0.07, -0.07], 0.32, pitch), rotors: [], parts, height: 0.55 };
  },

  mortar: (t) => {
    // a siege mortar: a squat carriage on four big wheels, team-coloured cradle cheeks and one huge,
    // fat, banded barrel (the tanks' blue fenders and its own old mudguards read alike from above)
    const b = hullB();
    b.block(0.4, 0.1, 0.72, [0, 0.16, 0.02], GM_D, { bevel: 0.02 });
    wheels(b, 0.25, 0.13, 0.13, 0.1, [-0.22, 0.24]);
    // a front armour box with an amber slit, a shell locker at the back
    b.block(0.36, 0.13, 0.18, [0, 0.27, -0.26], GM, { taper: 0.12, bevel: 0.03 });
    b.box(0.24, 0.03, 0.012, [0, 0.29, -0.352], AMBER, { glow: 0.55 });
    b.block(0.3, 0.08, 0.12, [0, 0.24, 0.32], GM, { bevel: 0.015 });
    for (const x of [-0.09, -0.03, 0.03, 0.09]) shell(b, [x, 0.28, 0.32], 0.014);
    light(b, [0.12, 0.25, -0.36], 0.025);
    light(b, [-0.12, 0.25, -0.36], 0.025);
    const hull = b.build();
    const tu = partB();
    tu.block(0.28, 0.05, 0.24, [0, 0.025, 0.02], GM_D, { bevel: 0.012 });
    tu.pairBlock(0.05, 0.17, 0.2, [0.16, 0.09, 0.02], t.main, { bevel: 0.015 });
    const pitch = 0.9;
    const at: Vec3 = [0, 0.13, 0.06];
    barrel(tu, at, 0.11, 0.34, pitch, BARREL, 10);
    for (const k of [0.1, 0.22]) barrel(tu, barrelTip(at, k, pitch), 0.12, 0.05, pitch, t.main, 10);
    barrel(tu, barrelTip(at, 0.3, pitch), 0.128, 0.05, pitch, GM_D, 10);
    const tip = barrelTip(at, 0.345, pitch);
    tu.cyl(0.085, 0.085, 0.006, 10, tip, TRACK, { rot: [pitch - Math.PI / 2, 0, 0] });
    return { hull, turret: tu.build(), mount: [0, 0.22, 0.02], muzzle: tip, rotors: [], height: 0.6 };
  },

  mastodon: (t) => {
    const b = hullB();
    tracks(b, 0.37, 0.21, 0.21, 0.5, -0.27, t.main);
    tracks(b, 0.37, 0.21, 0.21, 0.5, 0.27, t.main);
    b.block(0.6, 0.22, 1.02, [0, 0.27, 0], GM, { taper: 0.12, bevel: 0.045 });
    b.block(0.56, 0.09, 0.2, [0, 0.25, -0.53], GM_D, { rot: [0.5, 0, 0], bevel: 0.02 });
    b.pairBlock(0.04, 0.12, 0.92, [0.475, 0.22, 0], t.main, { bevel: 0.012 });
    // front deck plates in team colour (the turret covers the middle)
    b.pairBlock(0.15, 0.025, 0.2, [0.14, 0.39, -0.34], t.main, { bevel: 0.012 });
    b.block(0.4, 0.05, 0.2, [0, 0.4, 0.38], GM_D, { bevel: 0.015 });
    for (const x of [-0.12, 0, 0.12]) b.box(0.07, 0.02, 0.16, [x, 0.43, 0.38], BARREL);
    light(b, [0.2, 0.26, -0.57]);
    light(b, [-0.2, 0.26, -0.57]);
    const hull = b.build();
    const tu = partB();
    tu.block(0.44, 0.17, 0.46, [0, 0.085, 0.05], GM, { taper: 0.18, bevel: 0.04 });
    tu.block(0.3, 0.13, 0.09, [0, 0.09, -0.2], GM_D, { bevel: 0.02 });
    for (const x of [-0.075, 0.075]) {
      barrel(tu, [x, 0.095, -0.22], 0.035, 0.56, 0.01, BARREL);
      tu.tube(0.05, 0.08, 6, [x, 0.1, -0.78], GM_D);
    }
    tu.block(0.24, 0.022, 0.24, [0, 0.18, 0.09], t.main, { bevel: 0.012 });
    tu.pairBlock(0.04, 0.09, 0.26, [0.225, 0.08, 0.06], t.main, { bevel: 0.012 });
    tu.cyl(0.06, 0.07, 0.05, 6, [0.1, 0.205, 0.15], GM_L);
    light(tu, [-0.12, 0.18, -0.12], 0.03);
    return { hull, turret: tu.build(), mount: [0, 0.39, 0.06], muzzle: [0, 0.1, -0.82], rotors: [], height: 0.75 };
  },

  lancer: (t) => {
    // a hover tank: a real tank hull riding on a dark armoured skirt, the lift field's amber glow
    // leaking out round its foot (no tracks, no wheels), and a long laser lance with focusing coils
    const b = hullB();
    skirt(b, 0.66, 0.97, 0.022, 0, [0, 0.03, 0], AMBER, 1);
    skirt(b, 0.58, 0.88, 0.09, 0.04, [0, 0.08, 0], TRACK);
    b.block(0.56, 0.13, 0.82, [0, 0.19, 0.02], GM, { taper: 0.14, bevel: 0.035 });
    b.block(0.46, 0.05, 0.16, [0, 0.19, -0.38], GM_D, { rot: [0.5, 0, 0], bevel: 0.015 });
    // team deck plates either side of the turret and across the back (fenders would read as tracks)
    b.pairBlock(0.1, 0.02, 0.5, [0.15, 0.265, 0.02], t.main, { bevel: 0.008 });
    b.block(0.3, 0.02, 0.1, [0, 0.265, 0.34], t.main, { bevel: 0.008 });
    // engine grilles glowing at the back, lift vents down the flanks
    for (const s of [1, -1]) {
      b.box(0.11, 0.04, 0.012, [s * 0.12, 0.19, 0.434], EXHAUST, { glow: 1 });
      for (const z of [-0.2, 0, 0.2]) b.box(0.012, 0.025, 0.08, [s * 0.282, 0.19, z], 0x15171a);
    }
    light(b, [0.15, 0.2, -0.47]);
    light(b, [-0.15, 0.2, -0.47]);
    const hull = b.build();
    const tu = partB();
    tu.drum(0.17, 0.13, 0.09, 6, [0, 0.045, 0.02], GM, { bevel: 0.02 });
    tu.drum(0.11, 0.09, 0.025, 6, [0, 0.1, 0.04], t.main, { bevel: 0.01 });
    // the lance: emitter block, barrel, three focusing coils, a glowing lens
    tu.block(0.1, 0.07, 0.1, [0, 0.05, -0.13], GM_D, { bevel: 0.015 });
    tu.tube(0.026, 0.46, 6, [0, 0.05, -0.33], BARREL);
    for (const z of [-0.238, -0.33, -0.422]) tu.torus(0.042, 0.013, [0, 0.05, z], GM_L, { seg: 8 });
    tu.tube(0.038, 0.04, 8, [0, 0.05, -0.57], GM_D);
    tu.sphere(0.03, [0, 0.05, -0.595], AMBER, { glow: 1, w: 6, h: 4 });
    // heat sinks at the back
    tu.pairBlock(0.03, 0.06, 0.1, [0.09, 0.06, 0.13], GM_D, { bevel: 0.008 });
    light(tu, [-0.08, 0.1, -0.05], 0.022);
    return { hull, turret: tu.build(), mount: [0, 0.255, 0.04], muzzle: [0, 0.05, -0.6], rotors: [], height: 0.45 };
  },

  harvester: (t) => {
    const b = hullB();
    b.block(0.4, 0.1, 0.86, [0, 0.16, 0], GM_D, { bevel: 0.02 });
    wheels(b, 0.24, 0.11, 0.11, 0.1, [-0.3, 0, 0.3]);
    b.block(0.4, 0.2, 0.24, [0, 0.31, -0.29], GM, { bevel: 0.035 });
    b.block(0.36, 0.03, 0.2, [0, 0.425, -0.29], t.main, { bevel: 0.012 });
    b.box(0.32, 0.07, 0.02, [0, 0.34, -0.415], AMBER, { glow: 0.55 });
    b.cyl(0.022, 0.022, 0.04, 6, [0.12, 0.46, -0.24], AMBER, { glow: 1 });
    // the scoop, hazard-striped
    b.box(0.46, 0.08, 0.12, [0, 0.13, -0.5], HAZ_D, { rot: [-0.35, 0, 0] });
    for (const x of [-0.18, -0.06, 0.06, 0.18]) b.box(0.055, 0.084, 0.124, [x, 0.13, -0.5], HAZ, { rot: [-0.35, 0, 0] });
    for (const x of [-0.16, -0.08, 0, 0.08, 0.16]) b.cone(0.022, 0.06, 4, [x, 0.08, -0.57], GM_D, { rot: [-Math.PI / 2 - 0.3, 0, 0] });
    // the cargo bin, rimmed in team colour
    b.box(0.4, 0.03, 0.56, [0, 0.22, 0.14], GM_D);
    b.block(0.42, 0.18, 0.03, [0, 0.3, -0.14], GM, { bevel: 0.01 });
    b.block(0.42, 0.18, 0.03, [0, 0.3, 0.42], GM, { bevel: 0.01 });
    b.pairBlock(0.03, 0.18, 0.56, [0.2, 0.3, 0.14], GM, { bevel: 0.01 });
    b.pairBlock(0.045, 0.02, 0.6, [0.2, 0.398, 0.14], t.main, { bevel: 0.008 });
    b.block(0.44, 0.02, 0.045, [0, 0.398, 0.42], t.main, { bevel: 0.008 });
    b.pair(0.012, 0.05, 0.5, [0.218, 0.32, 0.14], t.main);
    const hull = b.build();
    const c = partB();
    const lumps: [number, number, number, number][] = [
      [-0.1, 0.0, 0.05, 0x8a6a3a], [0.08, 0.1, 0.06, 0xb08a4a], [-0.05, 0.25, 0.05, 0x6e5a40],
      [0.1, 0.3, 0.045, 0x9a7a44], [0, 0.15, 0.06, 0xc9a65a], [-0.12, 0.33, 0.04, 0x7a6448]
    ];
    lumps.forEach(([x, z, s, col], i) =>
      c.box(s * 2.2, s * 1.6, s * 2, [x, 0.36, z], col, { rot: [i * 0.7, i * 1.3, i * 0.4] })
    );
    c.cone(0.03, 0.09, 5, [0.05, 0.4, 0.22], GREEN, { glow: 0.6 });
    return { hull, mount: [0, 0, 0], muzzle: [0, 0.3, -0.5], rotors: [], cargo: c.build(), height: 0.5 };
  },

  scout: (t) => {
    const b = partB();
    b.sphere(0.1, [0, 0, 0], GM, { w: 8, h: 6, scale: [1, 0.6, 1.3] });
    b.sphere(0.038, [0, -0.01, -0.125], AMBER, { glow: 1, w: 6, h: 4 });
    b.box(0.03, 0.02, 0.4, [0, 0, 0], GM_D, { rot: [0, Math.PI / 4, 0] });
    b.box(0.03, 0.02, 0.4, [0, 0, 0], GM_D, { rot: [0, -Math.PI / 4, 0] });
    const at: Vec3[] = [];
    for (const [x, z] of [[0.14, -0.14], [-0.14, -0.14], [0.14, 0.14], [-0.14, 0.14]] as [number, number][]) {
      b.cyl(0.03, 0.03, 0.05, 8, [x, 0.005, z], GM);
      b.torus(0.085, 0.015, [x, 0.02, z], z < 0 ? t.main : rearRing(t), { rot: [Math.PI / 2, 0, 0], seg: 14 });
      at.push([x, 0.04, z]);
    }
    b.block(0.08, 0.03, 0.09, [0, 0.055, 0.02], t.main, { bevel: 0.012 });
    const rg = rotorGeo(0.075);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0, -0.15], rotors: at.map((p) => ({ geo: rg, at: p, axis: "y", speed: 40 })), height: 0.15 };
  },

  wasp: (t) => {
    const b = partB();
    b.tube(0.06, 0.46, 6, [0, 0, 0.02], GM, { scale: [1, 1, 0.8] });
    b.cone(0.06, 0.14, 6, [0, 0, -0.27], GM_L, { rot: [-Math.PI / 2, 0, 0] });
    b.sphere(0.035, [0, 0.04, -0.14], AMBER, { glow: 0.6, w: 6, h: 4, scale: [1, 0.6, 1.6] });
    b.block(0.045, 0.03, 0.22, [0, 0.048, 0.07], GM_L, { bevel: 0.01 });
    for (const s of [1, -1]) {
      b.prism([[s * 0.04, 0.06], [s * 0.36, -0.08], [s * 0.38, 0.01], [s * 0.06, 0.16]], 0.025, [0, -0.012, 0], GM_D);
      // outer wing panels in team colour
      b.prism([[s * 0.17, 0.0], [s * 0.36, -0.08], [s * 0.38, 0.01], [s * 0.19, 0.1]], 0.012, [0, 0.013, 0], t.main);
      b.tube(0.032, 0.2, 6, [s * 0.19, -0.04, -0.02], WHITE);
      b.cone(0.032, 0.05, 6, [s * 0.19, -0.04, -0.145], 0xc84a3a, { rot: [-Math.PI / 2, 0, 0] });
      light(b, [s * 0.37, 0.02, -0.03], 0.022);
    }
    b.torus(0.085, 0.02, [0, 0.03, 0.27], t.main, { seg: 12 });
    b.cyl(0.06, 0.06, 0.01, 8, [0, 0.03, 0.28], AMBER, { glow: 1, rot: [Math.PI / 2, 0, 0] });
    b.box(0.015, 0.1, 0.1, [0, 0.08, 0.2], t.main);
    return {
      hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.04, -0.22],
      rotors: [{ geo: rotorGeo(0.075, "z"), at: [0, 0.03, 0.265], axis: "z", speed: 50 }], height: 0.15
    };
  },

  raptor: (t) => {
    // a twin-boom interceptor: a short cockpit pod between two engine booms, a straight wing
    // across all three, a team tailplane bridging the booms' tails, a missile under each wing
    const b = partB();
    b.fuselage([[-0.5, 0.01, 0.0, -0.02], [-0.4, 0.05, 0.04, -0.04], [-0.24, 0.075, 0.06, -0.05], [0.05, 0.08, 0.055, -0.05], [0.2, 0.05, 0.03, -0.03]], [0, 0, 0], GM, { chamfer: 0.025, edge: 1.35 });
    b.sphere(0.042, [0, 0.06, -0.26], GLASS, { glow: 0.45, w: 8, h: 5, scale: [1, 0.65, 2.2] });
    b.fuselage([[-0.12, 0.03, 0.066, 0.05], [0.15, 0.02, 0.045, 0.03]], [0, 0, 0], t.main, { chamfer: 0.008 });
    nozzle(b, [0, 0, 0.21], 0.035);
    const wing: [number, number][] = [[0, -0.08], [0.5, -0.04], [0.52, 0.05], [0, 0.1]];
    b.prism([...wing, ...sided(wing, -1).slice(1, -1)], 0.024, [0, -0.03, 0], GM_D);
    for (const s of [1, -1]) {
      // team panels on the outer wings
      b.prism(sided([[0.27, -0.065], [0.49, -0.035], [0.505, 0.04], [0.27, 0.075]], s), 0.01, [0, -0.008, 0], t.main);
      // a boom: intake at the front, a team stripe along its top, a glowing nozzle, a fin over its tail
      const x = s * 0.22;
      b.fuselage([[-0.34, 0.035, 0.03, -0.035], [-0.26, 0.05, 0.045, -0.05], [0.2, 0.05, 0.045, -0.045], [0.42, 0.032, 0.03, -0.03]], [x, 0, 0], GM, { chamfer: 0.02, edge: 1.35 });
      b.tube(0.03, 0.02, 8, [x, 0, -0.345], 0x15171a);
      b.fuselage([[-0.22, 0.016, 0.054, 0.04], [0.3, 0.014, 0.046, 0.03]], [x, 0, 0], t.main, { chamfer: 0.006 });
      nozzle(b, [x, 0, 0.43], 0.03);
      b.prism([[0, 0.28], [0, 0.42], [0.13, 0.44], [0.13, 0.37]], 0.012, [x - 0.006, 0.03, 0], t.main, { rot: [0, 0, Math.PI / 2] });
      missile(b, [s * 0.38, -0.055, -0.02], 0.2, t);
      light(b, [s * 0.515, -0.02, 0], 0.022);
    }
    b.block(0.48, 0.02, 0.09, [0, 0.03, 0.37], t.main, { bevel: 0.008 });
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.5], rotors: [], height: 0.15 };
  },

  hornet: (t) => {
    // an armoured airship: a big slow envelope banded in team colour, cruciform tail fins, a bomb
    // gondola slung underneath and two pusher props on outriggers (no lift rotors: it isn't a drone)
    const b = partB();
    const L = 0.62;
    const RX = 0.25;
    const RY = 0.21;
    const Y = 0.05;
    const r = (z: number) => Math.sqrt(Math.max(0, 1 - (z / L) ** 2));
    b.sphere(1, [0, Y, 0], GM, { w: 16, h: 12, scale: [RX, L, RY], rot: [Math.PI / 2, 0, 0] });
    // armour bands round it (team fore and aft, dark ribs between), a team stripe along the spine
    for (const [z, hex, w] of [[-0.36, t.main, 1.8], [-0.12, GM_D, 0.8], [0.12, GM_D, 0.8], [0.36, t.main, 1.8]] as [number, number, number][])
      b.torus(RX * r(z) + 0.004, 0.012, [0, Y, z], hex, { seg: 18, scale: [1, RY / RX, w] });
    const spine = [-0.5, -0.36, -0.15, 0.05, 0.25, 0.42, 0.54].map((z): Section => {
      const top = Y + RY * r(z) + 0.004;
      return [z, 0.03, top, top - 0.03];
    });
    b.fuselage(spine, [0, 0, 0], t.main, { chamfer: 0.008, edge: 1.3 });
    b.sphere(0.05, [0, Y, -L + 0.02], GM_D, { w: 8, h: 5 });
    light(b, [0, Y, -L - 0.03], 0.024);
    // cruciform tail fins: up, down and out to both sides
    const fin: [number, number][] = [[0.1, 0.4], [0.3, 0.56], [0.3, 0.68], [0.02, 0.64]];
    b.prism(fin, 0.014, [0.007, Y, 0], t.main, { rot: [0, 0, Math.PI / 2] });
    b.prism(fin, 0.014, [-0.007, Y, 0], t.main, { rot: [0, 0, -Math.PI / 2] });
    for (const s of [1, -1]) {
      b.prism(sided(fin, s), 0.014, [0, Y - 0.007, 0], t.main);
      light(b, [s * 0.3, Y, 0.62], 0.02);
    }
    // the bomb gondola: amber windows down its sides, bombs racked underneath
    b.block(0.13, 0.07, 0.34, [0, Y - RY - 0.02, 0], GM_D, { bevel: 0.015 });
    b.pair(0.004, 0.018, 0.24, [0.066, Y - RY - 0.01, 0], AMBER, { glow: 0.7 });
    for (const z of [-0.1, 0, 0.1]) {
      b.tube(0.022, 0.1, 8, [0, Y - RY - 0.075, z], GM_D);
      b.sphere(0.022, [0, Y - RY - 0.075, z - 0.05], t.main, { w: 6, h: 4 });
    }
    // two engine pods on outriggers, pusher props behind them
    const props: Vec3[] = [];
    for (const s of [1, -1]) {
      const x = s * 0.35;
      const y = Y - 0.07;
      b.box(0.14, 0.016, 0.05, [s * 0.27, y, 0.14], GM_D);
      b.tube(0.042, 0.17, 8, [x, y, 0.14], GM);
      b.tube(0.045, 0.03, 8, [x, y, 0.08], t.main);
      b.cone(0.03, 0.04, 6, [x, y, 0.24], GM_D, { rot: [Math.PI / 2, 0, 0] });
      props.push([x, y, 0.262]);
    }
    const rg = rotorGeo(0.075, "z");
    return {
      hull: b.build(), mount: [0, 0, 0], muzzle: [0, Y - RY - 0.08, 0], height: 0.3,
      rotors: props.map((at, i) => ({ geo: rg, at, axis: "z" as const, speed: i ? -26 : 26 }))
    };
  },

  mender: (t) => {
    const b = partB();
    b.drum(0.19, 0.17, 0.08, 12, [0, 0, 0], GM_L, { bevel: 0.015 });
    b.sphere(0.11, [0, 0.03, 0], GM, { w: 10, h: 5, phi: Math.PI / 2 });
    b.box(0.15, 0.022, 0.048, [0, 0.146, 0], GREEN, { glow: 1 });
    b.box(0.048, 0.022, 0.15, [0, 0.146, 0], GREEN, { glow: 1 });
    b.torus(0.25, 0.024, [0, 0, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 20 });
    b.cyl(0.05, 0.03, 0.04, 8, [0, -0.06, 0], GREEN, { glow: 0.8 });
    const at: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(a) * 0.25;
      const z = Math.sin(a) * 0.25;
      b.cyl(0.03, 0.03, 0.04, 6, [x, 0.01, z], GM_D);
      at.push([x, 0.04, z]);
    }
    const rg = rotorGeo(0.07);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.06, 0], rotors: at.map((p) => ({ geo: rg, at: p, axis: "y", speed: 36 })), height: 0.15 };
  },

  // the map draws the Goliath as a posed rig (goliath.ts); this is it standing at rest, every part baked into one
  goliath: (t) => ({
    hull: goliathStatic(t === TEAMS.red ? "red" : "blue"),
    mount: [0, 0, 0], muzzle: [0, 2.1, -0.5], rotors: [], height: GOLIATH_RIG.height
  }),

  // robot infantry: the map draws each squad as an animated rig (infantry.ts); this is the squad at ease
  trooper: (t) => squadModel("trooper", t),
  "rocket-squad": (t) => squadModel("rocket-squad", t),
  sniper: (t) => squadModel("sniper", t),

  condor: (t) => {
    // a ducted-fan dropship: an armoured nose under an amber canopy, an open-roofed troop bay
    // amidships (you can see who's riding), lift fans on short wing pylons, and a tail boom out to
    // a V-tail over the rear ramp
    const b = partB();
    const B = CONDOR_BAY;
    // half-widths of the hull down its length: widest at the wing roots, tapering to nose and tail
    const W0 = 0.212;
    const W1 = 0.216;
    const W2 = 0.2;
    const W3 = 0.17;
    // the nose: armour tapering to a blunt point, a team chevron on top, a sensor ball under the chin
    b.fuselage([[-0.75, 0.024, -0.088, -0.116], [-0.712, 0.07, -0.052, -0.152], [-0.64, 0.124, -0.024, -0.182], [-0.54, 0.166, -0.006, -0.196], [-0.43, 0.196, 0.006, -0.2], [B.z0 + 0.01, W0, 0.012, -0.2]], [0, 0, 0], GM, { chamfer: 0.035, belly: 0.06 });
    for (const sx of [-1, 1])
      b.prism([[0, -0.072], [sx * 0.062, 0.0], [sx * 0.062, 0.03], [0, -0.04]], 0.008, [0, -0.03, -0.645], t.main, { rot: [-0.3, 0, 0] });
    b.sphere(0.03, [0, -0.19, -0.56], GM_D, { w: 6, h: 4 });
    light(b, [0, -0.1, -0.75], 0.022);
    // the canopy: amber-tinted glass on a dark sill, a reflection along its brow, faired in behind
    b.fuselage([[-0.6, 0.06, -0.012, -0.03], [-0.55, 0.112, 0.012, -0.02], [-0.45, 0.13, 0.026, -0.01], [-0.36, 0.13, 0.03, -0.005]], [0, 0, 0], GM_D, { chamfer: 0.03 });
    b.fuselage([[-0.585, 0.035, -0.006, -0.03], [-0.54, 0.092, 0.036, -0.015], [-0.46, 0.114, 0.064, 0.0], [-0.37, 0.116, 0.072, 0.005]], [0, 0, 0], GLASS, { chamfer: 0.05, glow: 0.3, edge: 1.15 });
    b.fuselage([[-0.52, 0.013, 0.048, 0.034], [-0.46, 0.013, 0.067, 0.052], [-0.385, 0.013, 0.075, 0.06]], [-0.034, 0, 0], 0xffd9a0, { chamfer: 0.005, glow: 0.5 });
    b.fuselage([[-0.375, 0.12, 0.074, 0.0], [B.z0 + 0.01, 0.11, 0.04, 0.0]], [0, 0, 0], GM, { chamfer: 0.04, edge: 1.35 });
    // the bay: a tub under an open roof — dark deck with aisle lamps, benches down both walls, team gunwales
    b.fuselage([[B.z0 - 0.01, W0, B.floor, -0.2], [-0.12, W1, B.floor, -0.2], [B.z1, W2, B.floor, -0.194], [B.ramp - 0.05, W3, B.floor, -0.175], [B.ramp, B.rampW / 2 + 0.012, B.floor, -0.15]], [0, 0, 0], GM, { chamfer: 0.035, belly: 0.05 });
    const zr = (B.z0 + B.ramp) / 2;
    const zc = (B.z0 + B.z1) / 2;
    b.box(B.w, 0.012, B.ramp - B.z0, [0, B.floor + 0.004, zr], 0x25282c);
    for (let z = B.z0 + 0.05; z < B.ramp - 0.03; z += 0.075) b.box(0.012, 0.004, 0.035, [0, B.floor + 0.012, z], AMBER, { glow: 0.8 });
    const iw = B.w / 2;
    for (const sx of [-1, 1]) {
      // walls straight inside (narrowing under the hump to the ramp), following the hull outside
      const wall: [number, number][] = [[iw, B.z0], [W0, B.z0], [W1, -0.12], [W2, B.z1], [W3, B.ramp - 0.05], [B.rampW / 2 + 0.012, B.ramp], [B.rampW / 2, B.ramp], [iw, B.z1 - 0.02]];
      b.prism(wall.map(([x, z]) => [sx * x, z]), B.wall - B.floor, [0, B.floor, 0], GM);
      const rim: [number, number][] = [[iw - 0.002, B.z0], [W0 + 0.003, B.z0], [W1 + 0.003, -0.12], [W2 + 0.002, B.z1 + 0.012], [iw - 0.002, B.z1 + 0.012]];
      b.prism(rim.map(([x, z]) => [sx * x, z]), 0.014, [0, B.wall - 0.002, 0], t.main);
      b.box(0.034, B.bench - B.floor, B.z1 - B.z0 - 0.02, [sx * (iw - 0.017), (B.bench + B.floor) / 2, zc], GM_L);
      for (const z of [B.z0 + 0.05, zc, B.z1 - 0.04]) light(b, [sx * (iw - 0.004), B.wall - 0.02, z], 0.014);
    }
    // the hump over the ramp sweeping up into the tail boom, a team spine stripe along both, a beacon
    b.fuselage([[B.z1, W2 + 0.002, 0.034, B.wall - 0.004], [B.z1 + 0.08, 0.172, 0.06, -0.002], [B.ramp + 0.012, B.rampW / 2 + 0.006, 0.07, 0.014]], [0, 0, 0], GM, { chamfer: 0.03, edge: 1.35 });
    b.fuselage([[B.ramp, 0.1, 0.07, 0.022], [0.5, 0.058, 0.074, 0.036], [0.64, 0.034, 0.077, 0.05]], [0, 0, 0], GM, { chamfer: 0.02 });
    b.fuselage([[B.z1 + 0.03, 0.038, 0.048, 0.03], [B.z1 + 0.08, 0.038, 0.064, 0.05], [B.ramp + 0.012, 0.03, 0.074, 0.06], [0.5, 0.021, 0.078, 0.064], [0.6, 0.014, 0.08, 0.066]], [0, 0, 0], t.main, { chamfer: 0.008, edge: 1.4 });
    light(b, [0, 0.08, B.ramp - 0.03], 0.018);
    // exhausts either side of the boom's root
    for (const sx of [-1, 1]) {
      b.tube(0.022, 0.05, 8, [sx * 0.085, 0.04, B.ramp + 0.01], GM_D);
      b.cyl(0.016, 0.016, 0.004, 8, [sx * 0.085, 0.04, B.ramp + 0.036], EXHAUST, { rot: [Math.PI / 2, 0, 0], glow: 0.9 });
    }
    // the V-tail: swept team fins, lamps at their tips
    for (const sx of [-1, 1]) {
      b.prism([[0, 0.51], [0.11, 0.6], [0.11, 0.65], [0, 0.645]], 0.012, [sx * 0.022, 0.07, 0], t.main, { rot: [0, 0, Math.PI / 2 - sx * 0.65] });
      light(b, [sx * (0.022 + 0.11 * Math.sin(0.65)), 0.07 + 0.11 * Math.cos(0.65), 0.628], 0.018);
    }
    // short wings out to the lift fans: team panels on top
    const fans: Vec3[] = [];
    const fz = -0.08;
    for (const sx of [-1, 1]) {
      b.prism([[sx * (W1 - 0.01), fz - 0.1], [sx * 0.32, fz - 0.065], [sx * 0.32, fz + 0.07], [sx * (W1 - 0.01), fz + 0.1]], 0.034, [0, -0.085, 0], GM);
      b.prism([[sx * (W1 + 0.005), fz - 0.08], [sx * 0.31, fz - 0.052], [sx * 0.31, fz + 0.055], [sx * (W1 + 0.005), fz + 0.08]], 0.008, [0, -0.052, 0], t.main);
      const x = sx * 0.45;
      b.drum(0.158, 0.148, 0.08, 16, [x, -0.07, fz], GM, { bevel: 0.016 });
      b.cyl(0.124, 0.124, 0.006, 16, [x, -0.028, fz], GM_L);
      b.torus(0.142, 0.024, [x, -0.026, fz], t.main, { rot: [Math.PI / 2, 0, 0], seg: 20 });
      b.torus(0.05, 0.009, [x, -0.024, fz], AMBER, { rot: [Math.PI / 2, 0, 0], seg: 10, glow: 0.9 });
      b.cyl(0.03, 0.034, 0.03, 8, [x, -0.016, fz], GM_D);
      b.box(0.26, 0.01, 0.016, [x, -0.022, fz], GM_D);
      light(b, [x + sx * 0.162, -0.06, fz], 0.024);
      fans.push([x, -0.008, fz]);
    }
    // landing struts
    for (const [x, z] of [[0, -0.52], [0.15, 0.1], [-0.15, 0.1]] as [number, number][]) {
      b.box(0.016, 0.07, 0.016, [x, -0.225, z], GM_D);
      b.box(0.04, 0.012, 0.06, [x, -0.262, z], GM_D);
    }
    const hull = b.build();
    // the ramp, hinged at the deck's rear edge: closed it stands up under the hump (hazard chevrons
    // outside); dropped, its tread faces up between hazard-striped rails, lamps at its lip
    const L = B.wall + 0.02 - B.floor;
    const rw = B.rampW;
    const r = partB();
    r.box(rw - 0.004, L, 0.02, [0, L / 2, 0], GM);
    for (let i = 0; i < 3; i++) r.box(0.035, L * 0.86, 0.006, [-0.066 + i * 0.066, L / 2, 0.012], i % 2 ? HAZ_D : HAZ);
    for (let i = 0; i < 4; i++) r.box(rw - 0.08, 0.006, 0.006, [0, 0.02 + i * 0.026, -0.012], GM_L);
    for (let i = 0; i < 4; i++) r.pair(0.026, L / 4, 0.006, [rw / 2 - 0.02, (i + 0.5) * (L / 4), -0.012], i % 2 ? HAZ_D : HAZ);
    light(r, [rw / 2 - 0.02, L - 0.008, -0.01], 0.02);
    light(r, [-rw / 2 + 0.02, L - 0.008, -0.01], 0.02);
    const rg = rotorGeo(0.128);
    return {
      hull, mount: [0, 0, 0], muzzle: [0, -0.1, 0], height: 0.2,
      rotors: fans.map((p, i) => ({ geo: rg, at: p, axis: "y" as const, speed: i ? -34 : 34 })),
      ramp: { geo: r.build(), hinge: [0, B.floor, B.ramp], open: 1.85, tip: [0, L, 0] }
    };
  }
};

/**
 * The Condor's troop bay, in model space: deck and bench-top heights, the
 * gunwales' top, the benches' x, the bay's inner width, the front and rear of
 * its open roof (z), and the ramp's hinge under the tail and its width.
 */
export const CONDOR_BAY = { floor: -0.1, bench: -0.064, wall: 0.0, benchX: 0.136, w: 0.34, z0: -0.31, z1: 0.17, ramp: 0.34, rampW: 0.27 };

function squadModel(kind: BotKind, t: Team): ModelDef {
  const f: Faction = t === TEAMS.red ? "red" : "blue";
  const h = botHeight(kind);
  return { hull: squadStatic(kind, f), mount: [0, 0, 0], muzzle: [0, h * 0.75, -0.3], rotors: [], height: h };
}

// ---------------------------------------------------------- buildings ---

const BUILDING_MODELS: Record<ClassicBuildingKind, (t: Team) => ModelDef> = {
  hq: (t) => {
    const b = siteB();
    b.block(2.9, 0.16, 2.9, [0, 0.06, 0], GM_D, { taper: 0.03, bevel: 0.04 });
    b.block(2.3, 0.44, 2.3, [0, 0.36, 0], GM, { taper: 0.08, bevel: 0.07 });
    // team bands from the dome out to each side
    for (const [x, z, ry] of [[0, -0.86, 0], [0, 0.86, 0], [0.86, 0, Math.PI / 2], [-0.86, 0, Math.PI / 2]] as Vec3[])
      b.block(0.36, 0.03, 0.3, [x, 0.592, z], t.main, { rot: [0, ry, 0], bevel: 0.015 });
    for (const x of [-1.05, 1.05])
      for (const z of [-1.05, 1.05]) {
        b.drum(0.31, 0.26, 0.74, 8, [x, 0.37, z], GM, { bevel: 0.03 });
        b.drum(0.28, 0.24, 0.1, 8, [x, 0.79, z], t.main, { bevel: 0.03 });
        b.drum(0.17, 0.13, 0.06, 8, [x, 0.87, z], GM_L, { bevel: 0.015 });
        light(b, [x, 0.92, z], 0.06);
      }
    b.sphere(0.74, [0, 0.56, 0], GM_L, { w: 16, h: 7, phi: Math.PI / 2 });
    b.torus(0.75, 0.06, [0, 0.6, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 24 });
    b.torus(0.55, 0.03, [0, 1.06, 0], GM_D, { rot: [Math.PI / 2, 0, 0], seg: 20 });
    // command cab on the crown: amber windows, a team roof, the mast and beacon
    b.drum(0.24, 0.22, 0.14, 8, [0, 1.3, 0], GM_D, { bevel: 0.02 });
    b.drum(0.245, 0.245, 0.04, 8, [0, 1.3, 0], AMBER, { glow: 0.8, bevel: 0 });
    b.drum(0.22, 0.16, 0.06, 8, [0, 1.4, 0], t.main, { bevel: 0.02 });
    b.cyl(0.022, 0.04, 0.5, 6, [0, 1.68, 0], GM_D);
    b.sphere(0.06, [0, 1.95, 0], AMBER, { glow: 1, w: 6, h: 4 });
    // comms dish on the north-east roof
    b.cyl(0.03, 0.05, 0.16, 6, [0.66, 0.66, -0.66], GM_D);
    b.sphere(0.24, [0.66, 0.92, -0.7], GM_L, { w: 10, h: 3, phi: 0.9, rot: [Math.PI - 0.6, 0.7, 0] });
    b.sphere(0.025, [0.66, 0.86, -0.66], AMBER, { glow: 1, w: 5, h: 3 });
    for (const [x, z, ry] of [[0, 1.16, 0], [0, -1.16, 0], [1.16, 0, Math.PI / 2], [-1.16, 0, Math.PI / 2]] as Vec3[])
      b.box(1.0, 0.17, 0.025, [x, 0.4, z], t.main, { rot: [0, ry, 0] });
    for (const [x, z, ry] of [[0, -1.17, 0], [1.17, 0, Math.PI / 2], [-1.17, 0, Math.PI / 2]] as Vec3[])
      b.box(0.8, 0.035, 0.02, [x, 0.25, z], AMBER, { rot: [0, ry, 0], glow: 0.7 });
    // the main gate: dark door, lit lintel, hazard-edged ramp
    b.block(0.74, 0.28, 0.06, [0, 0.28, 1.17], GM_D, { bevel: 0.015 });
    b.box(0.62, 0.035, 0.02, [0, 0.44, 1.2], AMBER, { glow: 1 });
    b.box(0.82, 0.04, 0.38, [0, 0.12, 1.36], GM_L, { rot: [0.22, 0, 0] });
    for (const x of [-0.43, 0.43]) b.box(0.06, 0.05, 0.38, [x, 0.125, 1.36], HAZ, { rot: [0.22, 0, 0] });
    b.block(0.3, 0.12, 0.2, [-0.75, 0.64, 0.55], GM_D, { bevel: 0.02 });
    b.block(0.24, 0.1, 0.3, [0.7, 0.63, 0.7], GM_D, { bevel: 0.02 });
    for (const x of [-1.38, 1.38]) for (const z of [-1.38, 1.38]) light(b, [x, 0.15, z], 0.05);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 1.1, 0], rotors: [], height: 2.0 };
  },

  "fab-plant": (t) => {
    const b = siteB();
    b.block(1.92, 0.12, 1.92, [0, 0.05, 0], GM_D, { taper: 0.03, bevel: 0.03 });
    b.block(1.7, 0.62, 1.3, [0, 0.41, -0.16], GM, { bevel: 0.04 });
    // sawtooth roof: glazed amber north lights, a team ridge cap on each tooth
    for (let i = 0; i < 3; i++) {
      const z = -0.66 + i * 0.44;
      b.box(1.66, 0.04, 0.46, [0, 0.82, z], GM_L, { rot: [-0.38, 0, 0] });
      b.box(1.5, 0.16, 0.02, [0, 0.82, z + 0.2], AMBER, { glow: 0.35 });
      b.box(1.68, 0.035, 0.07, [0, 0.905, z + 0.2], t.main);
    }
    b.block(1.04, 0.46, 0.05, [0, 0.34, 0.51], GM_D, { bevel: 0.012 });
    for (let i = 0; i < 3; i++) b.box(1.0, 0.05, 0.02, [0, 0.2 + i * 0.13, 0.54], t.main);
    b.box(1.22, 0.03, 0.42, [0, 0.12, 0.73], GM_L);
    for (let i = 0; i < 6; i++) b.box(0.1, 0.034, 0.08, [-0.5 + i * 0.2, 0.128, 0.9], i % 2 ? HAZ_D : HAZ);
    light(b, [0.57, 0.6, 0.54], 0.05);
    light(b, [-0.57, 0.6, 0.54], 0.05);
    b.pairBlock(0.03, 0.24, 0.94, [0.86, 0.46, -0.16], t.main, { bevel: 0.01 });
    // chimney stack, glowing at the throat
    b.drum(0.13, 0.1, 0.86, 8, [0.62, 1.0, -0.62], GM_D, { bevel: 0.02 });
    b.drum(0.125, 0.12, 0.08, 8, [0.62, 1.32, -0.62], t.main, { bevel: 0.015 });
    b.cyl(0.07, 0.07, 0.02, 8, [0.62, 1.43, -0.62], EXHAUST, { glow: 0.9 });
    // gantry crane
    b.block(0.08, 0.5, 0.08, [-0.72, 1.0, 0.36], GM_D, { bevel: 0.015 });
    b.block(0.08, 0.08, 0.9, [-0.72, 1.24, 0.0], GM_D, { bevel: 0.015 });
    b.box(0.06, 0.12, 0.06, [-0.72, 1.15, -0.3], HAZ);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.4 };
  },

  airpad: (t) => {
    const b = siteB();
    b.block(1.95, 0.14, 1.95, [0, 0.07, 0], GM_D, { taper: 0.02, bevel: 0.03 });
    b.cyl(0.8, 0.8, 0.03, 28, [0, 0.155, 0], GM);
    b.torus(0.64, 0.05, [0, 0.172, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 28 });
    for (const x of [-0.16, 0.16]) b.box(0.08, 0.012, 0.5, [x, 0.175, 0], 0xc9ced4);
    b.box(0.32, 0.012, 0.08, [0, 0.175, 0], 0xc9ced4);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      light(b, [Math.cos(a) * 0.79, 0.175, Math.sin(a) * 0.79], 0.04);
    }
    for (const x of [-0.86, 0.86]) for (const z of [-0.86, 0.86]) light(b, [x, 0.17, z], 0.06);
    // control tower
    b.block(0.36, 0.72, 0.36, [0.76, 0.5, -0.76], GM, { bevel: 0.03 });
    b.block(0.46, 0.2, 0.46, [0.76, 0.92, -0.76], GM_L, { bevel: 0.03 });
    b.box(0.48, 0.07, 0.48, [0.76, 0.94, -0.76], AMBER, { glow: 0.45 });
    b.block(0.5, 0.04, 0.5, [0.76, 1.04, -0.76], t.main, { bevel: 0.02 });
    b.cyl(0.012, 0.012, 0.3, 4, [0.86, 1.2, -0.86], GM_D);
    light(b, [0.86, 1.36, -0.86], 0.03);
    // fuel tanks, team-banded
    for (const z of [-0.5, -0.82]) {
      b.cyl(0.13, 0.13, 0.32, 10, [-0.8, 0.3, z], GM_L, { rot: [Math.PI / 2, 0, 0] });
      b.cyl(0.135, 0.135, 0.06, 10, [-0.8, 0.3, z], t.main, { rot: [Math.PI / 2, 0, 0] });
    }
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 1.1 };
  },

  "tech-lab": (t) => {
    const b = siteB();
    b.block(1.92, 0.12, 1.92, [0, 0.06, 0], GM_D, { taper: 0.03, bevel: 0.03 });
    b.drum(0.92, 0.84, 0.5, 8, [0, 0.37, 0], GM, { rot: [0, Math.PI / 8, 0], bevel: 0.03 });
    b.cyl(0.87, 0.87, 0.1, 8, [0, 0.5, 0], t.dark, { rot: [0, Math.PI / 8, 0] });
    b.drum(0.84, 0.7, 0.08, 8, [0, 0.66, 0], t.main, { rot: [0, Math.PI / 8, 0], bevel: 0.02 });
    b.sphere(0.48, [0, 0.66, 0], 0xff8a24, { glow: 1, w: 14, h: 6, phi: Math.PI / 2 });
    b.torus(0.5, 0.03, [0, 0.72, 0], GM_D, { rot: [Math.PI / 2, 0, 0], seg: 20 });
    b.torus(0.38, 0.025, [0, 0.95, 0], GM_D, { rot: [Math.PI / 2, 0, 0], seg: 18 });
    b.torus(0.48, 0.025, [0, 0.66, 0], GM_D, { seg: 20 });
    b.torus(0.48, 0.025, [0, 0.66, 0], GM_D, { rot: [0, Math.PI / 2, 0], seg: 20 });
    for (const [x, z] of [[0.68, 0.68], [-0.68, 0.68], [0.68, -0.68], [-0.68, -0.68]] as [number, number][]) {
      b.cyl(0.035, 0.06, 0.95, 6, [x, 0.55, z], GM_L);
      b.cyl(0.05, 0.05, 0.08, 6, [x, 0.8, z], t.main);
      b.sphere(0.045, [x, 1.05, z], AMBER, { glow: 1, w: 6, h: 4 });
    }
    b.block(0.42, 0.3, 0.32, [0, 0.27, 0.86], GM_D, { bevel: 0.02 });
    b.block(0.36, 0.025, 0.22, [0, 0.43, 0.86], t.main, { bevel: 0.01 });
    b.box(0.32, 0.06, 0.02, [0, 0.33, 1.02], AMBER, { glow: 0.8 });
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0], rotors: [], height: 1.2 };
  },

  depot: (t) => {
    const b = siteB();
    b.block(1.92, 0.12, 1.92, [0, 0.06, 0], GM_D, { taper: 0.03, bevel: 0.03 });
    for (const x of [-0.46, 0.46]) {
      b.cyl(0.32, 0.32, 0.9, 14, [x, 0.57, -0.42], GM);
      b.cone(0.33, 0.24, 14, [x, 1.14, -0.42], GM_L);
      b.cyl(0.335, 0.335, 0.12, 14, [x, 0.78, -0.42], t.main);
      b.cyl(0.335, 0.335, 0.05, 14, [x, 0.3, -0.42], GM_D);
      light(b, [x, 1.27, -0.42], 0.04);
    }
    b.block(1.32, 0.32, 0.62, [0, 0.28, 0.46], GM, { bevel: 0.03 });
    b.box(1.12, 0.02, 0.42, [0, 0.445, 0.46], 0x121315);
    // scrap heaped in the bay
    const lumps: [number, number, number, number][] = [
      [-0.36, 0.4, 0.07, 0x8a6a3a], [-0.14, 0.52, 0.08, 0xb08a4a], [0.12, 0.42, 0.07, 0x6e5a40],
      [0.34, 0.54, 0.06, 0x9a7a44], [0.0, 0.46, 0.09, 0xc9a65a], [-0.3, 0.58, 0.05, 0x7a6448]
    ];
    lumps.forEach(([x, z, s, col], i) => b.box(s * 2, s * 1.2, s * 1.8, [x, 0.44, z], col, { rot: [i * 0.5, i * 1.3, i * 0.3] }));
    b.box(1.22, 0.05, 0.02, [0, 0.3, 0.775], t.main);
    for (let i = 0; i < 7; i++) b.box(0.16, 0.03, 0.03, [-0.54 + i * 0.18, 0.445, 0.77], i % 2 ? HAZ_D : HAZ);
    b.block(0.18, 0.06, 0.74, [0, 0.66, 0.02], GM_D, { rot: [-0.5, 0, 0], bevel: 0.015 });
    light(b, [0.62, 0.47, 0.76], 0.05);
    light(b, [-0.62, 0.47, 0.76], 0.05);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.25 };
  },

  turret: (t) => {
    const b = siteB();
    b.drum(0.46, 0.4, 0.22, 8, [0, 0.11, 0], GM_D, { rot: [0, Math.PI / 8, 0], bevel: 0.03 });
    b.cyl(0.415, 0.415, 0.06, 8, [0, 0.19, 0], t.main, { rot: [0, Math.PI / 8, 0] });
    b.drum(0.38, 0.3, 0.04, 8, [0, 0.235, 0], GM, { rot: [0, Math.PI / 8, 0], bevel: 0.015 });
    const hull = b.build();
    const h = partB();
    h.block(0.36, 0.17, 0.36, [0, 0.085, 0.03], GM, { taper: 0.2, bevel: 0.03 });
    h.block(0.18, 0.02, 0.18, [0, 0.175, 0.05], t.main, { bevel: 0.01 });
    for (const x of [-0.065, 0.065]) {
      h.tube(0.026, 0.4, 6, [x, 0.095, -0.3], BARREL);
      h.tube(0.037, 0.06, 6, [x, 0.095, -0.5], GM_D);
    }
    h.pairBlock(0.035, 0.09, 0.22, [0.19, 0.085, 0.04], t.main, { bevel: 0.01 });
    light(h, [0, 0.17, -0.1], 0.035);
    return { hull, turret: h.build(), mount: [0, 0.255, 0], muzzle: [0, 0.095, -0.54], rotors: [], height: 0.6 };
  },

  "sam-site": (t) => {
    const b = siteB();
    b.block(0.86, 0.18, 0.86, [0, 0.09, 0], GM_D, { taper: 0.06, bevel: 0.025 });
    for (const x of [-0.34, 0.34]) for (const z of [-0.34, 0.34]) b.block(0.14, 0.03, 0.14, [x, 0.19, z], t.main, { bevel: 0.01 });
    b.pair(0.03, 0.06, 0.4, [0.43, 0.1, 0], t.main);
    const hull = b.build();
    const h = partB();
    h.drum(0.25, 0.22, 0.08, 8, [0, 0.04, 0], GM, { bevel: 0.015 });
    h.pair(0.04, 0.22, 0.12, [0.21, 0.17, 0.02], GM_D);
    const pitch = 0.34;
    h.block(0.36, 0.2, 0.42, [0, 0.26, -0.02], GM, { rot: [pitch, 0, 0], bevel: 0.02 });
    h.pair(0.02, 0.1, 0.36, [0.185, 0.27, -0.02], t.main, { rot: [pitch, 0, 0] });
    h.box(0.3, 0.02, 0.26, [0, 0.364, 0.02], t.main, { rot: [pitch, 0, 0] });
    for (const x of [-0.11, 0, 0.11])
      for (const y of [0.21, 0.3]) {
        const base: Vec3 = [x, y, 0.12];
        barrel(h, base, 0.032, 0.42, pitch, WHITE);
        const tip = barrelTip(base, 0.42, pitch);
        h.cone(0.032, 0.07, 6, [tip[0], tip[1] + Math.sin(pitch) * 0.035, tip[2] - Math.cos(pitch) * 0.035], 0xc8402e, {
          rot: [pitch - Math.PI / 2, 0, 0]
        });
      }
    return { hull, turret: h.build(), mount: [0, 0.18, 0], muzzle: barrelTip([0, 0.26, 0.12], 0.5, pitch), rotors: [], height: 0.65 };
  },

  radar: (t) => {
    const b = siteB();
    b.block(0.82, 0.2, 0.82, [0, 0.1, 0], GM_D, { taper: 0.08, bevel: 0.025 });
    for (const x of [-0.32, 0.32]) for (const z of [-0.32, 0.32]) b.block(0.14, 0.03, 0.14, [x, 0.21, z], t.main, { bevel: 0.01 });
    b.pair(0.05, 0.05, 0.6, [0.4, 0.17, 0], t.main);
    b.box(0.6, 0.05, 0.05, [0, 0.17, 0.4], t.main);
    const hull = b.build();
    const h = partB();
    h.drum(0.08, 0.05, 0.42, 6, [0, 0.21, 0], GM, { bevel: 0.01 });
    h.sphere(0.42, [0, 0.655, -0.29], GM_L, { w: 14, h: 4, phi: 0.95, rot: [Math.PI / 2 + 0.38, 0, 0] });
    h.torus(0.34, 0.03, [0, 0.565, -0.064], t.main, { rot: [0.38, 0, 0], seg: 18 });
    h.tube(0.012, 0.3, 4, [0, 0.62, -0.2], GM_D, { rot: [0.38, 0, 0] });
    h.sphere(0.03, [0, 0.676, -0.343], AMBER, { glow: 1, w: 6, h: 4 });
    return { hull, turret: h.build(), mount: [0, 0.2, 0], muzzle: [0, 0.5, 0], rotors: [], height: 0.95 };
  },

  "assembly-bay": (t) => {
    // a robot works: an open assembly floor under a team gantry, a half-built robot on its cradle
    // (welding arms at it), finished robots charging in lit alcoves along the parts hall behind
    const f: Faction = t === TEAMS.red ? "red" : "blue";
    const b = siteB();
    b.block(1.92, 0.12, 1.92, [0, 0.06, 0], GM_D, { taper: 0.03, bevel: 0.03 });
    b.box(1.7, 0.02, 1.0, [0, 0.125, 0.3], 0x3a3e44);
    // the parts hall along the north side
    b.block(1.78, 0.6, 0.5, [0, 0.42, -0.66], GM, { bevel: 0.04 });
    b.block(1.82, 0.05, 0.56, [0, 0.745, -0.66], GM_L, { bevel: 0.02 });
    b.block(1.66, 0.03, 0.16, [0, 0.78, -0.72], t.main, { bevel: 0.012, edge: 1.4 });
    for (const x of [-0.55, 0, 0.55]) b.block(0.22, 0.05, 0.14, [x, 0.79, -0.52], GM_D, { bevel: 0.015 });
    b.pairBlock(0.03, 0.3, 0.5, [0.895, 0.42, -0.66], t.main, { bevel: 0.01 });
    // charging alcoves: amber-lit recesses, a finished trooper on each pad, facing out
    const bot = botStatic("trooper", f);
    for (const i of [-1, 0, 1]) {
      const x = i * 0.5;
      b.box(0.34, 0.5, 0.03, [x, 0.4, -0.4], 0x17191c);
      b.box(0.26, 0.03, 0.02, [x, 0.62, -0.385], AMBER, { glow: 1 });
      b.pair(0.03, 0.52, 0.05, [0.185, 0.4, -0.39], t.main);
      b.block(0.32, 0.03, 0.16, [x, 0.14, -0.31], GM_L, { bevel: 0.01 });
      b.torus(0.09, 0.012, [x, 0.158, -0.31], AMBER, { rot: [Math.PI / 2, 0, 0], seg: 12, glow: 0.8 });
      b.addBuilt(bot, [x, 0.155, -0.31], { rot: [0, Math.PI + i * 0.12, 0], scale: [1.1, 1.1, 1.1] });
    }
    // the line: a belt running east-west, hazard-edged, with spare legs and an arm riding it
    b.box(1.66, 0.05, 0.3, [0, 0.15, 0.2], 0x1c1e21);
    for (let i = 0; i < 12; i++) {
      const x = -0.77 + i * 0.14;
      b.box(0.07, 0.054, 0.025, [x, 0.152, 0.04], i % 2 ? HAZ_D : HAZ);
      b.box(0.07, 0.054, 0.025, [x, 0.152, 0.36], i % 2 ? HAZ : HAZ_D);
    }
    for (const x of [-0.6, -0.36, 0.38, 0.62]) b.box(0.012, 0.004, 0.26, [x, 0.177, 0.2], GM);
    const legsGeo = botStatic("trooper", f, [J.thighL, J.shinL]);
    b.addBuilt(legsGeo, [0.5, 0.31, 0.2], { rot: [Math.PI / 2, 0.3, 0], scale: [1.3, 1.3, 1.3] });
    b.addBuilt(legsGeo, [0.68, 0.31, 0.16], { rot: [Math.PI / 2, -0.2, 0], scale: [1.3, 1.3, 1.3] });
    const armGeo = botStatic("trooper", f, [J.armR]);
    b.addBuilt(armGeo, [-0.42, 0.62, 0.22], { rot: [0, 0, Math.PI / 2], scale: [1.3, 1.3, 1.3] });
    // the cradle and its half-built robot: torso, head and one arm, legs not on yet
    b.drum(0.17, 0.13, 0.12, 8, [0, 0.235, 0.2], GM_L, { bevel: 0.02 });
    b.pair(0.03, 0.2, 0.05, [0.14, 0.38, 0.2], GM_D);
    const half = botStatic("trooper", f, [J.hips, J.torso, J.head, J.armL]);
    b.addBuilt(half, [0, 0.3 - 0.145 * 1.42 * 1.8, 0.2], { rot: [0, Math.PI - 0.35, 0], scale: [1.8, 1.8, 1.8] });
    // the gantry over it: team beam with hazard underside, two welding arms reaching down
    b.pairBlock(0.08, 0.86, 0.08, [0.7, 0.55, 0.2], GM_D, { bevel: 0.015 });
    b.block(1.5, 0.08, 0.11, [0, 1.0, 0.2], t.main, { bevel: 0.015, edge: 1.4 });
    for (let i = 0; i < 8; i++) b.box(0.1, 0.012, 0.115, [-0.63 + i * 0.18, 0.955, 0.2], i % 2 ? HAZ_D : HAZ);
    for (const sx of [-1, 1]) {
      b.drum(0.05, 0.045, 0.06, 8, [sx * 0.3, 0.93, 0.2], GM_L, { bevel: 0.01 });
      b.box(0.04, 0.3, 0.04, [sx * 0.26, 0.79, 0.2], GM, { rot: [0, 0, sx * 0.35] });
      b.box(0.034, 0.22, 0.034, [sx * 0.17, 0.6, 0.2], GM_D, { rot: [0, 0, -sx * 0.7] });
      b.cone(0.022, 0.05, 6, [sx * 0.1, 0.53, 0.2], GM_D, { rot: [0, 0, -sx * 2.2] });
      b.sphere(0.02, [sx * 0.08, 0.515, 0.2], AMBER, { glow: 1, w: 6, h: 4 });
    }
    // the roll-out pad on the apron, where finished squads step off: a team ring, amber lamps, a painted arrow
    b.cyl(0.3, 0.32, 0.03, 16, [-0.3, 0.14, 0.66], GM_L);
    b.torus(0.26, 0.026, [-0.3, 0.158, 0.66], t.main, { rot: [Math.PI / 2, 0, 0], seg: 18 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      light(b, [-0.3 + Math.cos(a) * 0.3, 0.16, 0.66 + Math.sin(a) * 0.3], 0.03);
    }
    b.prism([[-0.3, 0.8], [-0.4, 0.64], [-0.34, 0.64], [-0.34, 0.52], [-0.26, 0.52], [-0.26, 0.64], [-0.2, 0.64]], 0.01, [0, 0.155, 0], HAZ);
    // a parts bin in the south-east corner, a mast and beacon in the south-west
    b.block(0.32, 0.16, 0.24, [0.66, 0.2, 0.74], GM, { bevel: 0.02 });
    b.box(0.28, 0.02, 0.2, [0.66, 0.285, 0.74], 0x121315);
    for (const [x, z] of [[0.6, 0.7], [0.72, 0.78], [0.66, 0.74]] as [number, number][]) b.box(0.06, 0.04, 0.05, [x, 0.3, z], GM_L, { rot: [0.3, x * 4, 0.2] });
    b.cyl(0.02, 0.035, 0.7, 6, [-0.82, 0.47, 0.82], GM_D);
    b.cyl(0.04, 0.04, 0.05, 6, [-0.82, 0.8, 0.82], t.main);
    b.sphere(0.045, [-0.82, 0.86, 0.82], AMBER, { glow: 1, w: 6, h: 4 });
    for (let i = 0; i < 7; i++) b.box(0.16, 0.03, 0.03, [-0.54 + i * 0.18, 0.135, 0.93], i % 2 ? HAZ_D : HAZ);
    light(b, [0.88, 0.15, 0.88], 0.05);
    light(b, [-0.88, 0.15, -0.88], 0.05);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0.2], rotors: [], height: 1.1 };
  },

  gantry: (t) => {
    // where a Goliath is built: a 3×3 assembly pad, open front and back (it walks out toward the back of
    // its base), a cradle in the middle between two lattice scaffold towers whose welding arms reach in
    // over it, a luffing crane on the east tower, floor lights down the cradle, armour plates racked on the apron
    const f: Faction = t === TEAMS.red ? "red" : "blue";
    const b = siteB();
    b.block(2.9, 0.14, 2.9, [0, 0.07, 0], GM_D, { taper: 0.02, bevel: 0.04 });
    b.box(2.3, 0.02, 2.82, [0, 0.145, 0], 0x3a3e44);
    for (const z of [-1.36, 1.36]) for (let i = 0; i < 11; i++) b.box(0.2, 0.03, 0.08, [-1.0 + i * 0.2, 0.16, z], i % 2 ? HAZ_D : HAZ);
    // the cradle: a plinth, its deck, the foot clamps, team bands down its sides
    b.block(1.56, 0.12, 1.36, [0, 0.2, 0], GM_L, { bevel: 0.03, edge: 1.35 });
    b.block(1.36, 0.03, 1.16, [0, 0.27, 0], GM, { bevel: 0.01 });
    for (const x of [-0.4, 0.4]) {
      b.block(0.52, 0.07, 0.8, [x, 0.3, -0.06], GM_D, { bevel: 0.02 });
      for (const z of [-0.36, 0.24]) b.box(0.08, 0.06, 0.08, [x + 0.24, 0.33, z], HAZ);
    }
    b.pairBlock(0.05, 0.07, 1.36, [0.8, 0.22, 0], t.main, { bevel: 0.012, edge: 1.4 });
    // the scaffold towers: posts, rails, braces, two walkways with hazard edges, team caps, footings
    for (const sx of [-1, 1]) {
      const xi = sx * 1.2;
      const xo = sx * 1.4;
      b.block(0.38, 0.22, 1.92, [sx * 1.3, 0.25, 0], GM, { bevel: 0.03 });
      for (const x of [xi, xo]) for (const z of [-0.85, 0.85]) b.box(0.07, 2.9, 0.07, [x, 1.6, z], GM_D);
      for (let k = 0; k < 5; k++) {
        const y = 0.75 + k * 0.55;
        for (const x of [xi, xo]) b.box(0.05, 0.05, 1.7, [x, y, 0], GM);
        for (const z of [-0.85, 0.85]) b.box(0.25, 0.05, 0.05, [sx * 1.3, y, z], GM);
        // (cross-braced, zig-zagging up the outer face)
        if (k < 4) b.box(0.035, 0.035, 1.78, [xo, y + 0.27, 0], GM_D, { rot: [k % 2 ? 0.32 : -0.32, 0, 0] });
      }
      for (const y of [1.3, 2.4]) {
        b.block(0.36, 0.04, 1.8, [sx * 1.3, y, 0], GM_L, { bevel: 0.01 });
        for (let i = 0; i < 9; i++) b.box(0.2, 0.03, 0.03, [xi + sx * 0.02, y + 0.03, -0.8 + i * 0.2], i % 2 ? HAZ_D : HAZ, { rot: [0, Math.PI / 2, 0] });
      }
      b.block(0.36, 0.12, 1.86, [sx * 1.3, 3.1, 0], t.main, { bevel: 0.03, edge: 1.45 });
      b.pairBlock(0.38, 0.05, 0.05, [sx * 1.3, 3.0, 0.93], GM_D);
      for (const z of [-0.88, 0.88]) b.box(0.07, 0.06, 0.07, [xo, 3.2, z], 0x2a2410);
      b.box(0.04, 0.5, 0.04, [xi, 0.55, -0.4], AMBER, { glow: 0.6 });
    }
    // the crane's mast and cab on the east tower's north end
    b.block(0.16, 0.6, 0.16, [1.3, 3.45, -0.72], GM_D, { bevel: 0.02 });
    b.block(0.26, 0.18, 0.26, [1.3, 3.7, -0.72], HAZ, { bevel: 0.03 });
    b.box(0.2, 0.08, 0.02, [1.3, 3.72, -0.86], AMBER, { glow: 0.6 });
    // armour plates waiting on a rack in the north-east corner, and spare parts crated in the south-west
    b.block(0.5, 0.06, 0.34, [0.95, 0.2, -1.12], GM_D, { bevel: 0.01 });
    for (let i = 0; i < 3; i++) b.block(0.42, 0.05, 0.3, [0.95, 0.26 + i * 0.06, -1.12], i === 2 ? t.main : GM, { rot: [0, 0.08 * i, 0], bevel: 0.012, edge: 1.35 });
    b.block(0.36, 0.24, 0.3, [-0.95, 0.27, 1.1], GM, { bevel: 0.02 });
    b.box(0.37, 0.05, 0.31, [-0.95, 0.3, 1.1], HAZ);
    light(b, [1.38, 0.17, 1.38], 0.05);
    light(b, [-1.38, 0.17, -1.38], 0.05);
    const hull = b.build();

    // the welding arms, pivoting on the tower tops: in over the cradle, swung clear along the towers for a rollout
    const arm = (sx: number) => {
      const a = partB();
      a.drum(0.09, 0.08, 0.1, 8, [0, 0, 0], GM_L, { bevel: 0.015 });
      a.block(0.72, 0.09, 0.12, [-sx * 0.38, 0, 0], GM, { bevel: 0.02 });
      a.block(0.6, 0.02, 0.1, [-sx * 0.38, 0.055, 0], t.main, { bevel: 0.008 });
      for (let i = 0; i < 4; i++) a.box(0.12, 0.014, 0.125, [-sx * (0.16 + i * 0.15), -0.05, 0], i % 2 ? HAZ_D : HAZ);
      a.box(0.07, 0.34, 0.07, [-sx * 0.7, -0.2, 0], GM_D);
      a.cone(0.035, 0.08, 6, [-sx * 0.7, -0.41, 0], GM_D, { rot: [Math.PI, 0, 0] });
      a.sphere(0.022, [-sx * 0.7, -0.45, 0], AMBER, { glow: 1, w: 6, h: 4 });
      return a.build();
    };
    // the crane: a jib luffing on the mast, a trolley's cable (a unit length, stretched), the hook block and the plate it carries
    const jib = partB();
    jib.box(0.1, 0.1, 1.7, [0, 0, -0.85], GM_D);
    for (let i = 0; i < 8; i++) jib.box(0.11, 0.11, 0.1, [0, 0, -0.15 - i * 0.2], i % 2 ? HAZ_D : HAZ);
    jib.block(0.2, 0.16, 0.26, [0, 0, 0.24], GM, { bevel: 0.02 });
    light(jib, [0, 0.07, -1.68], 0.03);
    const cable = partB();
    cable.box(0.015, 1, 0.015, [0, -0.5, 0], TRACK);
    const hook = partB();
    hook.block(0.12, 0.08, 0.1, [0, -0.04, 0], GM_D, { bevel: 0.01 });
    hook.box(0.03, 0.08, 0.03, [0, -0.12, 0], HAZ);
    const plate = partB();
    plate.block(0.46, 0.05, 0.32, [0, -0.2, 0], GM, { bevel: 0.012, edge: 1.35 });
    plate.box(0.3, 0.012, 0.08, [0, -0.17, 0], t.main);
    for (const x of [-0.18, 0.18]) plate.box(0.008, 0.16, 0.008, [x * 0.5, -0.1, 0], TRACK, { rot: [0, 0, x] });
    // floor lights down the cradle, lit and dark (glow is baked), and the towers' blinking beacons
    const lamps = (lit: boolean) => {
      const l = partB();
      for (const sx of [-1, 1]) for (let i = 0; i < 7; i++) l.box(0.06, 0.02, 0.1, [sx * 0.92, 0.16, -1.2 + i * 0.4], lit ? AMBER : 0x3a3020, lit ? { glow: 1 } : {});
      return l.build();
    };
    const blink = partB();
    for (const sx of [-1, 1]) for (const z of [-0.88, 0.88]) blink.box(0.075, 0.065, 0.075, [sx * 1.4, 3.2, z], 0xffb347, { glow: 1 });
    blink.sphere(0.04, [1.3, 3.83, -0.72], 0xff5a3a, { glow: 1, w: 6, h: 4 });
    // the Goliath taking shape on the cradle, stage by stage: at its size on the map, facing the way it walks out
    const s = unitScale("goliath");
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f === "red" ? 0 : Math.PI, 0)),
      new THREE.Vector3(s, s, s)
    );
    const parts: NonNullable<ModelDef["parts"]> = {
      armL: { geo: arm(-1), at: [-1.2, 3.02, 0] },
      armR: { geo: arm(1), at: [1.2, 3.02, 0] },
      jib: { geo: jib.build(), at: [1.3, 3.84, -0.72] },
      cable: { geo: cable.build(), at: [0, 0, -1], parent: "jib" },
      hook: { geo: hook.build(), at: [0, -1, -1], parent: "jib" },
      plate: { geo: plate.build(), at: [0, 0, 0], parent: "hook" },
      lightsOn: { geo: lamps(true), at: [0, 0, 0] },
      lightsOff: { geo: lamps(false), at: [0, 0, 0] },
      blink: { geo: blink.build(), at: [0, 0, 0] }
    };
    for (let i = 0; i < GANTRY_STAGES.length; i++) parts[`stage${i}`] = { geo: gantryStage(f, i).clone().applyMatrix4(m), at: [0, 0.285, 0] };
    return { hull, mount: [0, 0, 0], muzzle: [0, 1.4, 0], rotors: [], parts, height: 3.3 };
  }
};

// --------------------------------------------------------- objectives ---

function uplinkModel(): ModelDef {
  const b = siteB();
  b.drum(1.06, 1.0, 0.14, 28, [0, 0.07, 0], GM_D, { bevel: 0.03 });
  b.cyl(0.9, 0.9, 0.03, 28, [0, 0.155, 0], GM);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.box(0.32, 0.05, 0.11, [Math.cos(a) * 0.95, 0.15, Math.sin(a) * 0.95], i % 2 ? HAZ : HAZ_D, { rot: [0, -a - Math.PI / 2, 0] });
  }
  b.drum(0.4, 0.3, 0.32, 8, [0, 0.32, 0], GM, { bevel: 0.03 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    light(b, [Math.cos(a) * 0.7, 0.18, Math.sin(a) * 0.7], 0.06);
  }
  const hull = b.build();
  const h = partB();
  h.cyl(0.08, 0.12, 0.3, 6, [0, 0.15, 0], GM_D);
  h.sphere(0.6, [0, 0.64, -0.395], GM_L, { w: 16, h: 4, phi: 0.85, rot: [Math.PI / 2 + 0.6, 0, 0] });
  h.torus(0.45, 0.03, [0, 0.416, -0.068], HAZ, { rot: [0.6, 0, 0], seg: 20 });
  h.tube(0.014, 0.42, 4, [0, 0.535, -0.24], GM_D, { rot: [0.6, 0, 0] });
  h.sphere(0.04, [0, 0.65, -0.41], AMBER, { glow: 1, w: 6, h: 4 });
  return { hull, turret: h.build(), mount: [0, 0.46, 0], muzzle: [0, 0.8, 0], rotors: [], height: 1.4 };
}

function crateModel(): ModelDef {
  const b = siteB();
  b.block(0.5, 0.36, 0.5, [0, 0.19, 0], GM, { bevel: 0.03 });
  for (const y of [0.08, 0.3]) b.box(0.52, 0.06, 0.52, [0, y, 0], HAZ);
  for (const x of [-0.24, 0.24]) for (const z of [-0.24, 0.24]) b.box(0.05, 0.38, 0.05, [x, 0.19, z], HAZ_D);
  b.block(0.52, 0.04, 0.52, [0, 0.39, 0], HAZ_D, { bevel: 0.012 });
  // hazard straps across the lid, so it reads from above
  b.box(0.5, 0.012, 0.08, [0, 0.414, 0], HAZ);
  b.box(0.08, 0.012, 0.5, [0, 0.414, 0], HAZ);
  b.cyl(0.05, 0.06, 0.05, 6, [0, 0.43, 0], AMBER, { glow: 1 });
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 0.5 };
}

/** Parachute canopy over its attachment point (the origin): eight gores, gold and cream. */
function chuteGeo(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const r = 0.75;
  const theta = 1.05;
  const top = 1.25;
  for (let i = 0; i < 8; i++) {
    const g = new THREE.SphereGeometry(r, 3, 5, (i / 8) * Math.PI * 2, Math.PI / 4, 0, theta);
    b.add(g, [0, top - r * Math.cos(theta), 0], i % 2 ? 0xf2b632 : 0xece4cf, { scale: [1, 0.75, 1] });
  }
  const rimY = top - r * Math.cos(theta);
  const rimR = r * Math.sin(theta);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * rimR;
    const z = Math.sin(a) * rimR;
    const len = Math.hypot(x, rimY, z);
    const mid: Vec3 = [x / 2, rimY / 2, z / 2];
    const g = new THREE.CylinderGeometry(0.006, 0.006, len, 3);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, rimY, z).normalize());
    const e = new THREE.Euler().setFromQuaternion(q);
    b.add(g, mid, 0xe8e2cc, { rot: [e.x, e.y, e.z] });
  }
  return b.build();
}

function podModel(t: Team): ModelDef {
  const b = partB();
  b.cone(0.2, 0.22, 10, [0, 0.11, 0], GM_D, { rot: [Math.PI, 0, 0] });
  b.cyl(0.21, 0.2, 0.5, 10, [0, 0.47, 0], WHITE);
  b.cyl(0.215, 0.215, 0.09, 10, [0, 0.55, 0], t.main);
  b.drum(0.21, 0.18, 0.08, 10, [0, 0.76, 0], GM_D, { bevel: 0.015 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    b.box(0.02, 0.16, 0.12, [Math.cos(a) * 0.22, 0.7, Math.sin(a) * 0.22], GM_L, { rot: [0, -a, 0] });
  }
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 0.8 };
}

function podOpenModel(t: Team): ModelDef {
  const b = siteB();
  b.cyl(0.13, 0.15, 0.12, 10, [0, 0.06, 0], WHITE);
  b.cyl(0.07, 0.07, 0.02, 8, [0, 0.125, 0], 0x202328);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.24;
    const z = Math.sin(a) * 0.24;
    b.box(0.16, 0.03, 0.26, [x, 0.05, z], GM_L, { rot: [0, -a + Math.PI / 2, 0.0] });
    b.box(0.14, 0.035, 0.05, [x * 1.1, 0.06, z * 1.1], t.main, { rot: [0, -a + Math.PI / 2, 0] });
  }
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.1, 0], rotors: [], height: 0.2 };
}

/**
 * Deterministic rubble for a destroyed building of `size` tiles: a cracked,
 * tilted foundation, broken wall stubs at the corners, a charred debris heap
 * in the middle, scattered chunks and bent girders.
 */
function rubbleGeo(size: number, seed: number): THREE.BufferGeometry {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const b = new ModelBuilder({ grade: 0.35, ao: [0.12, 0.35] });
  const half = size * 0.42;
  const concrete = [0x5a5650, 0x4c4843, 0x625d55];
  const charred = [0x262422, 0x1c1b1a, 0x2e2b28];
  const metal = [GM_D, GM, 0x3c3a37];
  const pick = (a: number[]) => a[Math.floor(rnd() * a.length)]!;
  // the scorched foundation, cracked into tilted, shifted plates (some missing)
  const plates = size + 1;
  const cell = (half * 2) / plates;
  for (let i = 0; i < plates; i++)
    for (let j = 0; j < plates; j++) {
      if (rnd() < 0.15) continue;
      const w = cell * (0.72 + rnd() * 0.2);
      const x = -half + cell * (i + 0.5) + (rnd() - 0.5) * cell * 0.2;
      const z = -half + cell * (j + 0.5) + (rnd() - 0.5) * cell * 0.2;
      b.block(w, 0.05, w * (0.8 + rnd() * 0.25), [x, 0.012, z], rnd() < 0.5 ? 0x34312d : 0x2b2926, {
        rot: [(rnd() - 0.5) * 0.14, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.14], bevel: 0.012, edge: 1.2
      });
    }
  // broken wall stubs at the corners, ragged tops
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
    if (rnd() < 0.3) continue;
    const cx = sx * half * 0.85;
    const cz = sz * half * 0.85;
    const col = pick(concrete);
    for (let k = 0; k < 3; k++) {
      const h = 0.1 + rnd() * 0.18 * Math.min(2, size);
      const along = (k - 1) * 0.12 * Math.min(2, size);
      const xz: [number, number] = rnd() < 0.5 ? [cx - sx * along - sx * 0.12, cz] : [cx, cz - sz * along - sz * 0.12];
      b.block(0.11, h, 0.11, [xz[0], h / 2, xz[1]], k === 1 ? pick(charred) : col, { rot: [0, rnd() * 0.3, (rnd() - 0.5) * 0.15], bevel: 0.02, edge: 1.2 });
    }
  }
  // the heap: a low charred mound with concrete, panels and slag piled on it
  b.cone(half * 0.75, 0.16 + size * 0.05, 7, [0, 0.07 + size * 0.02, 0], pick(charred), { rot: [0, rnd() * 3, 0], scale: [1, 1, 0.85] });
  const n = Math.round(8 + size * size * 4);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * half * 0.95;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const w = 0.07 + rnd() * 0.2 * Math.min(2, size);
    const h = 0.04 + rnd() * 0.12;
    const y = (1 - d / half) * (0.12 + size * 0.04);
    const r = rnd();
    b.block(w, h, w * (0.5 + rnd()), [x, y + h / 2, z], r < 0.3 ? pick(charred) : r < 0.55 ? pick(metal) : pick(concrete), {
      rot: [rnd() * 0.6, rnd() * 3, rnd() * 0.6], bevel: Math.min(w, h) * 0.2, edge: 1.2
    });
  }
  // torn armour panels standing up out of the heap
  for (let i = 0; i < 1 + size; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * half * 0.5;
    const w = 0.14 + rnd() * 0.12 * size;
    b.block(w, w * 0.8, 0.025, [Math.cos(a) * d, 0.12 + size * 0.03, Math.sin(a) * d], pick(metal), {
      rot: [(rnd() - 0.5) * 1.2, rnd() * 3, (rnd() - 0.5) * 0.8], bevel: 0.01, edge: 1.35
    });
  }
  // bent girders and pipes sticking out
  for (let i = 0; i < 2 + size * 2; i++) {
    const x = (rnd() - 0.5) * size * 0.7;
    const z = (rnd() - 0.5) * size * 0.7;
    const col = rnd() < 0.5 ? 0x5a3c2a : 0x45403a;
    b.box(0.035, 0.035, 0.3 + rnd() * 0.4 * size, [x, 0.12, z], col, { rot: [rnd() * 0.9 - 0.45, rnd() * 3, rnd() * 0.5] });
  }
  return b.build();
}

/**
 * Deterministic scrap pile, what a fallen Goliath scatters (and a Gantry
 * destroyed mid-build): a low mound of torn metal heaped with the gold and
 * rust scrap lumps the harvesters haul, a few bent armour plates standing up
 * out of it (one in the dead side's colour), a girder, a length of pipe, a
 * cog. About a tile across.
 */
function scrapPileGeo(seed: number, t: Team): THREE.BufferGeometry {
  let s = seed * 7919 + 104729;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const b = new ModelBuilder({ grade: 0.3, ao: [0.1, 0.3] });
  const lumps = [0x8a6a3a, 0xb08a4a, 0x6e5a40, 0x9a7a44, 0xc9a65a, 0x7a6448];
  const metal = [GM_D, GM, 0x3c3a37, GM_L];
  const pick = (a: number[]) => a[Math.floor(rnd() * a.length)]!;
  const R = 0.46;
  b.cone(R, 0.2, 7, [0, 0.08, 0], 0x2e2b28, { rot: [0, rnd() * 3, 0], scale: [1, 1, 0.8 + rnd() * 0.3] });
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * R * 0.92;
    const w = 0.07 + rnd() * 0.09;
    const y = (1 - d / R) * 0.17 + 0.02;
    const col = rnd() < 0.62 ? pick(lumps) : pick(metal);
    b.box(w * 1.3, w * 0.8, w, [Math.cos(a) * d, y + w * 0.3, Math.sin(a) * d], col, { rot: [rnd() * 1.2, rnd() * 3, rnd() * 1.2] });
  }
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 0.08 + rnd() * R * 0.5;
    const w = 0.16 + rnd() * 0.14;
    b.block(w, w * 0.75, 0.025, [Math.cos(a) * d, 0.15, Math.sin(a) * d], i === 0 ? t.main : pick(metal), {
      rot: [(rnd() - 0.5) * 1.1, rnd() * 3, (rnd() - 0.5) * 0.9], bevel: 0.01, edge: 1.35
    });
  }
  b.box(0.04, 0.04, 0.5 + rnd() * 0.25, [(rnd() - 0.5) * 0.4, 0.12, (rnd() - 0.5) * 0.4], 0x45403a, { rot: [rnd() * 0.6 - 0.3, rnd() * 3, rnd() * 0.5] });
  b.tube(0.035, 0.34, 6, [(rnd() - 0.5) * 0.5, 0.08, (rnd() - 0.5) * 0.5], BARREL, { rot: [rnd() * 0.4, rnd() * 3, 0] });
  b.drum(0.1, 0.09, 0.04, 8, [(rnd() - 0.5) * 0.45, 0.06, (rnd() - 0.5) * 0.45], GM, { rot: [0.3 + rnd() * 0.4, 0, rnd() * 0.5] });
  return b.build();
}

// -------------------------------------------------------------- library ---

export interface ModelInstance {
  root: THREE.Group;
  /** The body (rotates with the hull facing). */
  body: THREE.Group;
  turret: THREE.Object3D | null;
  rotors: { obj: THREE.Object3D; axis: "y" | "z"; speed: number }[];
  cargo: THREE.Mesh | null;
  /** The Condor's ramp (pivoting at its hinge), else null. */
  ramp: THREE.Object3D | null;
  /** The model's further moving parts by name (ModelDef.parts), each a pivot holding its mesh. */
  parts: Record<string, THREE.Object3D>;
  def: ModelDef;
}

const cache = new Map<string, ModelDef>();

function def(key: string, make: () => ModelDef): ModelDef {
  let d = cache.get(key);
  if (!d) {
    d = make();
    cache.set(key, d);
  }
  return d;
}

/**
 * A nation's new kind with no model of its own yet (belle/placeholders.ts):
 * its stand-in's builder, painted in nation colours. Squads and the Goliath
 * rig pick their colours by side, so those keep the side's.
 */
function placeholderUnit(kind: UnitKind, f: Faction): { make: UnitBuilder; team: Team } | null {
  const base = (PLACEHOLDER_MODEL as Partial<Record<UnitKind, ClassicUnitKind>>)[kind];
  if (!base) return null;
  const make = (BELLE_EPOQUE && BE_UNIT_MODELS[base]) || UNIT_MODELS[base];
  const nation = UNITS[kind].nation;
  const bySide = MAP_SCALE.has(base) || base === "goliath" || !nation;
  return { make, team: bySide ? TEAMS[f] : NATION_TEAMS[nation][f] };
}

export function unitDef(kind: UnitKind, f: Faction): ModelDef {
  const own = BELLE_EPOQUE ? BE_UNIT_MODELS[kind] : undefined;
  const stand = own ? null : placeholderUnit(kind, f);
  if (stand) return def(`u/${f}/${kind}`, () => stand.make(stand.team));
  const make = own || UNIT_MODELS[kind as ClassicUnitKind];
  return def(`u/${f}/${kind}`, () => make(TEAMS[f]));
}

export function buildingDef(kind: BuildingKind, f: Faction): ModelDef {
  const own = BELLE_EPOQUE ? BE_BUILDING_MODELS[kind] : undefined;
  const base = own ? undefined : (PLACEHOLDER_BUILDING as Partial<Record<BuildingKind, ClassicBuildingKind>>)[kind];
  if (base) {
    const make = (BELLE_EPOQUE && BE_BUILDING_MODELS[base]) || BUILDING_MODELS[base];
    const nation = BUILDINGS[kind].nation;
    return def(`b/${f}/${kind}`, () => make(nation ? NATION_TEAMS[nation][f] : TEAMS[f]));
  }
  const make = own || BUILDING_MODELS[kind as ClassicBuildingKind];
  return def(`b/${f}/${kind}`, () => make(TEAMS[f]));
}

export function uplinkDef(): ModelDef {
  return def("obj/uplink", (BELLE_EPOQUE && BE_OBJECTIVES.uplink) || uplinkModel);
}

export function crateDef(): ModelDef {
  return def("obj/crate", (BELLE_EPOQUE && BE_OBJECTIVES.crate) || crateModel);
}

export function podDef(f: Faction, open = false): ModelDef {
  const make = BELLE_EPOQUE ? (open ? BE_OBJECTIVES.podOpen : BE_OBJECTIVES.pod) : undefined;
  return def(`pod/${f}/${open}`, () => (make ?? (open ? podOpenModel : podModel))(TEAMS[f]));
}

/** Longest side of each unit in tiles (as the painted sprites were sized), before the 3D readability bump. */
// (the Belle Époque dirigible is long and slim: sized by its length, it needs more to read as big as the quadcopter)
const UNIT_SIZE: Record<UnitKind, number> = {
  harvester: 1.15, scout: BELLE_EPOQUE ? 1.25 : 0.85, stinger: 0.95, "flak-crawler": 1.0, mortar: 1.15, mastodon: 1.45,
  lancer: 1.05, wasp: 1.0, raptor: 1.15, hornet: 1.5, mender: 0.85,
  // (a squad's formation spans about its radius × 2: the robots are modelled at map scale, see unitScale)
  trooper: 0.8, "rocket-squad": 0.8, sniper: 0.7,
  condor: 1.5,
  // (shoulders and pauldrons: it stands over twice as tall, see goliath.ts)
  goliath: 2.05,
  // the nations' new units (PANACHE-CONCEPTION.md §1.11 sizes; drawn with placeholders until WP5)
  fourgon: 1.15, "jamais-contente": 0.85, "de-dion": 0.95, branly: 1.1, sapeurs: 0.8, zenith: 2.6,
  estafette: 0.7, "mortier-280": 1.4, gyroptere: 1.0, epervier: 0.95, vulcain: 1.5, atelier: 1.1,
  fusiliers: 0.8, carabiniers: 0.7, titan: 1.6
};
/** Robot infantry is built at map scale (tiles): formations sized to the squad's radius. */
const MAP_SCALE = new Set<UnitKind>(["trooper", "rocket-squad", "sniper", "sapeurs", "fusiliers", "carabiniers"]);
/** Units read a touch bigger than their footprint in 3D, as in any RTS. */
const UNIT_BUMP = 1.12;
const scales = new Map<UnitKind, number>();

/** Uniform scale that brings a unit model to its intended size on the map. */
export function unitScale(kind: UnitKind): number {
  let s = scales.get(kind);
  if (s === undefined && MAP_SCALE.has(kind)) scales.set(kind, (s = 1));
  if (s === undefined) {
    const d = unitDef(kind, "blue");
    const box = d.hull.boundingBox!.clone();
    if (d.turret) box.union(d.turret.boundingBox!.clone().translate(new THREE.Vector3(...d.mount)));
    // (moving parts count too: the Flak Crawler's legs are most of its footprint)
    for (const p of Object.values(d.parts ?? {})) if (!p.parent) box.union(p.geo.boundingBox!.clone().translate(new THREE.Vector3(...p.at)));
    const size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    s = (UNIT_SIZE[kind] / size) * UNIT_BUMP;
    scales.set(kind, s);
  }
  return s;
}

let chute: THREE.BufferGeometry | null = null;
export function chuteGeometry(): THREE.BufferGeometry {
  return (chute ??= chuteGeo());
}

const rubbles = new Map<string, THREE.BufferGeometry>();
export function rubbleGeometry(size: number, variant: number): THREE.BufferGeometry {
  const key = `${size}/${variant}`;
  let g = rubbles.get(key);
  if (!g) {
    g = rubbleGeo(size, variant + 1);
    rubbles.set(key, g);
  }
  return g;
}

/** Scrap pile looks per side (a handful, picked by wreck id). */
export const PILE_VARIANTS = 4;

/** A scrap pile (see scrapPileGeo) as a model: what render/wrecks.ts draws for a Goliath's scattered salvage. */
export function pileDef(f: Faction, variant: number): ModelDef {
  const v = ((variant % PILE_VARIANTS) + PILE_VARIANTS) % PILE_VARIANTS;
  return def(`pile/${f}/${v}`, () => ({ hull: scrapPileGeo(v + 1, TEAMS[f]), mount: [0, 0, 0], muzzle: [0, 0.2, 0], rotors: [], height: 0.3 }));
}

/** A mesh using the shared model material (swappable variants). */
export function modelMesh(geo: THREE.BufferGeometry, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, modelMat("normal"));
  m.userData.model = true;
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

/** Build a scene-graph instance of a model (geometry shared). */
export function instance(d: ModelDef, shadows = true): ModelInstance {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(modelMesh(d.hull, shadows));
  let turret: THREE.Object3D | null = null;
  if (d.turret) {
    turret = new THREE.Group();
    turret.position.set(...d.mount);
    turret.add(modelMesh(d.turret, shadows));
    body.add(turret);
  }
  const rotors = d.rotors.map((r) => {
    const obj = modelMesh(r.geo, false);
    obj.position.set(...r.at);
    body.add(obj);
    return { obj, axis: r.axis, speed: r.speed };
  });
  let cargo: THREE.Mesh | null = null;
  if (d.cargo) {
    cargo = modelMesh(d.cargo, shadows);
    cargo.visible = false;
    body.add(cargo);
  }
  let ramp: THREE.Object3D | null = null;
  if (d.ramp) {
    ramp = new THREE.Group();
    ramp.position.set(...d.ramp.hinge);
    ramp.add(modelMesh(d.ramp.geo, shadows));
    body.add(ramp);
  }
  const parts: Record<string, THREE.Object3D> = {};
  for (const [name, p] of Object.entries(d.parts ?? {})) {
    const g = new THREE.Group();
    g.position.set(...p.at);
    g.add(modelMesh(p.geo, shadows));
    (p.parent ? parts[p.parent]! : body).add(g);
    parts[name] = g;
  }
  return { root, body, turret, rotors, cargo, ramp, parts, def: d };
}
