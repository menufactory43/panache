import * as THREE from "three";
import type { BuildingKind, Faction } from "../../../sim/types";
import type { ModelBuilder, Vec3 } from "../builder";
import { GANTRY_STAGES, gantryStage } from "../goliath";
import { botStatic } from "../infantry";
import {
  AMBER,
  BRASS,
  CANVAS,
  EXHAUST,
  TEAMS,
  TRACK,
  barrel,
  barrelTip,
  light,
  partB,
  siteB,
  unitScale,
  type ModelDef,
  type Team
} from "../models";

/**
 * Belle Époque buildings (theme.ts): HQ → Grand Quartier Général, Fab Plant → Forges,
 * Airpad → Chalais-Meudon, Tech Lab → Polytechnique, Depot → Halles, Turret → Hotchkiss,
 * SAM Site → Batterie Ruggieri, Radar → Tour TSF, Assembly Bay → Manufacture,
 * Gantry → Galerie des Machines. Same contract as models.ts BUILDING_MODELS: centred on
 * the footprint (3 tiles for the HQ and the Gantry, 1 for the Turret, SAM Site and Radar,
 * 2 for the rest), team colour on the roofs so every one reads from above.
 *
 * (models.ts imports this module, so the palette and helpers it exports are only
 * touched inside the builders, never at module load. The nations' buildings,
 * buildings-rep.ts / buildings-emp.ts, and landmarks.ts share them.)
 */

// ------------------------------------------------------------ palette ---

/** Haussmann limestone, its plinth and cornice. */
export const STONE = 0xd9cdb0;
export const STONE_D = 0xa49579;
export const STONE_L = 0xefe6cf;
/** Slate and zinc roofs. */
export const SLATE = 0x5b6670;
export const ZINC = 0x7f8a92;
export const BRICK = 0x9a4a33;
export const BRICK_D = 0x70321f;
/** Blackened wrought iron (lattices, columns, rails). */
export const IRON = 0x2e2b29;
export const SOOT = 0x1a1715;
export const COAL = 0x242120;
export const WOOD = 0x8f5e34;
export const WOOD_D = 0x5e3b20;
export const GRAVEL = 0xb7a784;
export const LAWN = 0x66733f;
export const SACK = 0xb9a173;
/** Gaslit window panes and the amber-lit glass of the iron halls. */
export const PANE = 0xf2bb5c;
export const GLAZE = 0xd9c79a;
export const COPPER = 0xb8733a;
export const RADIUM = 0x7dffa8;
export const SPARK = 0xbfe0ff;
/** The objectives' neutral gold (the old hazard yellow, now polished). */
const HAZ_GOLD = 0xc9a24a;

// ------------------------------------------------------------ helpers ---

/** A gable roof `w` wide at the eaves, `h` tall, its ridge `len` long along Z (turned by `ry`), base at `at`. */
export function gable(b: ModelBuilder, w: number, h: number, len: number, at: Vec3, hex: number, ry = 0): void {
  const s = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  b.add(g, at, hex, { rot: [0, ry, 0] });
}

/** One sawtooth: a slope rising from -Z to a vertical face at +Z... turned by `ry`. Base at `at`, `d` deep, `len` long along X. */
export function tooth(b: ModelBuilder, d: number, h: number, len: number, at: Vec3, hex: number): void {
  // (drawn in XY, extruded along Z, then turned so the slope runs along Z and the vertical face looks north)
  const s = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(d / 2, h)]);
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  b.add(g, at, hex, { rot: [0, Math.PI / 2, 0] });
}

/** A hipped frustum (mansard, hall roof): `w` × `d` at its foot, every side drawn in by `inset` at the top. */
export function frustum(b: ModelBuilder, w: number, h: number, d: number, inset: number, at: Vec3, hex: number): void {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++)
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) - Math.sign(p.getX(i)) * inset);
      p.setZ(i, p.getZ(i) - Math.sign(p.getZ(i)) * inset);
    }
  g.computeVertexNormals();
  b.add(g, at, hex);
}

/** A half cylinder lying along Z (vault, hangar, arched door), its flat side down at `at`. */
export function vault(b: ModelBuilder, r: number, len: number, at: Vec3, hex: number, o: { seg?: number; hy?: number; glow?: number } = {}): void {
  const g = new THREE.CylinderGeometry(r, r, len, o.seg ?? 12, 1, false, Math.PI / 2, Math.PI);
  b.add(g, at, hex, { rot: [Math.PI / 2, 0, 0], scale: [1, 1, o.hy ?? 1], glow: o.glow ?? 0 });
}

/** An upright half ring (an arch rib) in the XY plane, turned by `ry`. */
export function rib(b: ModelBuilder, r: number, tube: number, at: Vec3, hex: number, ry = 0, hy = 1): void {
  b.add(new THREE.TorusGeometry(r, tube, 3, 10, Math.PI), at, hex, { rot: [0, ry, 0], scale: [1, hy, 1] });
}

/** A row of `n` gaslit panes (flat quads) on a façade facing `face`, from `a` to `c` along it, the façade at `at`. */
export function panes(b: ModelBuilder, face: "+x" | "-x" | "+z" | "-z", a: number, c: number, n: number, y: number, at: number, w = 0.07, h = 0.12, glow = 0.65): void {
  const ry = { "+z": 0, "-z": Math.PI, "+x": Math.PI / 2, "-x": -Math.PI / 2 }[face];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? (a + c) / 2 : a + ((c - a) * i) / (n - 1);
    b.add(new THREE.PlaneGeometry(w, h), face[1] === "z" ? [u, y, at] : [at, y, u], PANE, { rot: [0, ry, 0], glow });
  }
}

/** A thin round rod from `a` to `c` (lattice members, wires): four sides, no caps. */
export function rod(b: ModelBuilder, a: Vec3, c: Vec3, r: number, hex: number): void {
  const d = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = d.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  b.add(new THREE.CylinderGeometry(r, r, len, 4, 1, true), [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], hex, { rot: [e.x, e.y, e.z] });
}

/** A gas street lamp: iron post, a glowing lantern, a little cap. */
export function lamp(b: ModelBuilder, x: number, z: number, y0: number, h = 0.32): void {
  b.cyl(0.012, 0.018, h, 5, [x, y0 + h / 2, z], IRON);
  b.box(0.045, 0.06, 0.045, [x, y0 + h + 0.025, z], AMBER, { glow: 1 });
  b.cone(0.04, 0.04, 4, [x, y0 + h + 0.075, z], IRON, { rot: [0, Math.PI / 4, 0] });
}

/** A pennant flying east from a pole at `at` (its hoist), `len` long. */
export function pennant(b: ModelBuilder, at: Vec3, len: number, h: number, hex: number): void {
  const s = new THREE.Shape([new THREE.Vector2(0, h / 2), new THREE.Vector2(0, -h / 2), new THREE.Vector2(len, 0)]);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false });
  g.translate(0, 0, -0.015);
  b.add(g, at, hex, { rot: [0, -0.25, 0] });
}

/**
 * A four-legged iron lattice (pylon, mast, tower), its legs from ±`r0` at `y0`
 * to ±`r1` at `y1`, cross-braced on every face in `n` storeys.
 */
export function pylon(b: ModelBuilder, x: number, z: number, r0: number, r1: number, y0: number, y1: number, n: number, leg: number, brace: number, hex = IRON): void {
  const at = (k: number, sx: number, sz: number): Vec3 => {
    const f = k / n;
    const r = r0 + (r1 - r0) * f;
    return [x + sx * r, y0 + (y1 - y0) * f, z + sz * r];
  };
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as [number, number][]) rod(b, at(0, sx, sz), at(n, sx, sz), leg, hex);
  for (let k = 0; k < n; k++)
    for (const [ax, az, cx, cz] of [[1, 1, 1, -1], [1, -1, -1, -1], [-1, -1, -1, 1], [-1, 1, 1, 1]] as [number, number, number, number][]) {
      rod(b, at(k, ax, az), at(k + 1, cx, cz), brace, hex);
      rod(b, at(k, cx, cz), at(k + 1, ax, az), brace, hex);
    }
}

/**
 * One of the Galerie des Machines' great three-hinged arches, across X at `z`:
 * an outer and inner chord pinned together at the feet (±`half`, `y0`), rising
 * `rise`, latticed between.
 */
export function greatArch(b: ModelBuilder, z: number, half: number, y0: number, rise: number, depth: number, hex: number, n = 12): void {
  const f = (u: number) => Math.sqrt(Math.max(0, 1 - u * u)) * 0.55 + (1 - Math.abs(u)) * 0.45;
  const outer = (i: number): Vec3 => {
    const u = -1 + (2 * i) / n;
    return [u * half, y0 + rise * f(u), z];
  };
  const inner = (i: number): Vec3 => {
    const u = -1 + (2 * i) / n;
    return [u * (half - depth), y0 + (rise - depth) * f(u), z];
  };
  for (let i = 0; i < n; i++) {
    rod(b, outer(i), outer(i + 1), 0.03, hex);
    rod(b, inner(i), inner(i + 1), 0.02, hex);
    rod(b, i % 2 ? outer(i) : inner(i), i % 2 ? inner(i + 1) : outer(i + 1), 0.012, hex);
  }
}

/** A heap of coal: a few dark cones. */
export function coal(b: ModelBuilder, x: number, z: number, y0: number, s: number): void {
  b.cone(0.22 * s, 0.2 * s, 7, [x, y0 + 0.1 * s, z], COAL, { scale: [1.2, 1, 1] });
  b.cone(0.14 * s, 0.13 * s, 6, [x + 0.16 * s, y0 + 0.065 * s, z + 0.1 * s], 0x2c2826);
  b.cone(0.12 * s, 0.11 * s, 6, [x - 0.17 * s, y0 + 0.055 * s, z - 0.06 * s], 0x1e1c1b);
}

export const factionOf = (t: Team): Faction => (t === TEAMS.red ? "red" : "blue");

// ---------------------------------------------------------- buildings ---

/**
 * Grand Quartier Général: a Second-Empire mansion round a cour d'honneur, the
 * main corps north and two wings reaching south, all under team mansards; a
 * team dome on the corps with a flagpole and pennant, gaslit windows, a
 * portico, an iron gate between the wings.
 */
function hq(t: Team): ModelDef {
  const b = siteB();
  b.block(2.9, 0.14, 2.9, [0, 0.07, 0], STONE_D, { taper: 0.02, bevel: 0.04 });
  b.box(1.22, 0.02, 1.26, [0, 0.15, 0.66], GRAVEL);
  const y0 = 0.14;
  const wh = 0.64;
  const top = y0 + wh;
  // the corps (north) and the wings (south), limestone with a pale cornice
  b.block(2.5, wh, 1.15, [0, y0 + wh / 2, -0.6], STONE, { bevel: 0.02 });
  for (const sx of [-1, 1]) b.block(0.62, wh, 1.32, [sx * 0.94, y0 + wh / 2, 0.63], STONE, { bevel: 0.02 });
  b.box(2.56, 0.08, 1.21, [0, y0 + 0.04, -0.6], STONE_D);
  for (const sx of [-1, 1]) b.box(0.68, 0.08, 1.38, [sx * 0.94, y0 + 0.04, 0.63], STONE_D);
  b.block(2.58, 0.05, 1.23, [0, top + 0.02, -0.6], STONE_L, { bevel: 0.015, edge: 1.2 });
  for (const sx of [-1, 1]) b.block(0.7, 0.05, 1.4, [sx * 0.94, top + 0.02, 0.63], STONE_L, { bevel: 0.015, edge: 1.2 });
  // the mansards: team slopes, a flat team crown with a highlighted edge, brass cresting
  const my = top + 0.045;
  frustum(b, 2.5, 0.3, 1.15, 0.17, [0, my + 0.15, -0.6], t.main);
  b.block(2.18, 0.04, 0.83, [0, my + 0.32, -0.6], t.main, { bevel: 0.03, edge: 1.45 });
  b.box(1.9, 0.03, 0.02, [0, my + 0.355, -0.6], BRASS);
  for (const sx of [-1, 1]) {
    frustum(b, 0.62, 0.3, 1.32, 0.15, [sx * 0.94, my + 0.15, 0.63], t.main);
    b.block(0.34, 0.04, 1.04, [sx * 0.94, my + 0.32, 0.63], t.main, { bevel: 0.03, edge: 1.45 });
    b.box(0.02, 0.03, 0.9, [sx * 0.94, my + 0.355, 0.63], BRASS);
    // corner pavilions at the wings' south ends: a taller team cap, a brass finial
    frustum(b, 0.66, 0.42, 0.5, 0.2, [sx * 0.94, my + 0.21, 1.05], t.main);
    b.block(0.28, 0.04, 0.12, [sx * 0.94, my + 0.43, 1.05], t.dark, { bevel: 0.015 });
    b.cyl(0.012, 0.02, 0.16, 5, [sx * 0.94, my + 0.53, 1.05], BRASS);
  }
  // dormers along the slopes (gaslit) and stone chimney stacks
  for (const x of [-0.95, -0.55, 0.55, 0.95]) {
    b.block(0.12, 0.13, 0.1, [x, my + 0.12, -0.06], STONE_L, { bevel: 0.015 });
    b.box(0.06, 0.07, 0.02, [x, my + 0.11, -0.005], PANE, { glow: 0.7 });
    b.block(0.12, 0.13, 0.1, [x, my + 0.12, -1.14], STONE_L, { bevel: 0.015 });
  }
  for (const sx of [-1, 1]) {
    for (const z of [0.25, 0.6]) {
      b.block(0.1, 0.13, 0.12, [sx * 1.2, my + 0.12, z], STONE_L, { bevel: 0.015 });
      b.box(0.02, 0.07, 0.06, [sx * 1.255, my + 0.11, z], PANE, { glow: 0.7 });
    }
    b.block(0.1, 0.24, 0.16, [sx * 0.9, my + 0.4, -0.85], STONE, { bevel: 0.02 });
    b.box(0.08, 0.02, 0.14, [sx * 0.9, my + 0.53, -0.85], SOOT);
  }
  // gaslit windows on two floors all round
  for (const y of [0.33, 0.6]) {
    panes(b, "-z", -1.12, 1.12, 9, y, -1.185);
    panes(b, "+z", -0.5, -0.24, 2, y, -0.015);
    panes(b, "+z", 0.24, 0.5, 2, y, -0.015);
    for (const sx of [-1, 1]) {
      panes(b, sx > 0 ? "+x" : "-x", -1.05, 1.15, 8, y, sx * 1.26);
      panes(b, sx > 0 ? "-x" : "+x", 0.15, 1.1, 4, y, sx * 0.62);
      panes(b, "+z", sx * 0.8, sx * 1.08, 2, y, 1.3);
    }
  }
  // the portico on the court: columns, an entablature, a team pediment, a lit door
  for (const x of [-0.2, -0.07, 0.07, 0.2]) b.cyl(0.026, 0.03, 0.46, 6, [x, y0 + 0.23, 0.1], STONE_L);
  b.block(0.52, 0.06, 0.2, [0, y0 + 0.49, 0.04], STONE_L, { bevel: 0.015 });
  gable(b, 0.54, 0.14, 0.22, [0, y0 + 0.52, 0.04], t.main);
  b.box(0.14, 0.24, 0.02, [0, y0 + 0.13, -0.01], PANE, { glow: 0.9 });
  b.box(0.36, 0.04, 0.16, [0, y0 + 0.02, 0.2], STONE_L);
  // the dome on the corps: a drum with lit oculi, team cupola, brass ribs and lantern, the flag
  const dy = my + 0.34;
  b.drum(0.36, 0.34, 0.2, 12, [0, dy + 0.1, -0.6], STONE, { bevel: 0.02 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(0.05, 0.08, 0.02, [Math.sin(a) * 0.345, dy + 0.1, -0.6 + Math.cos(a) * 0.345], PANE, { rot: [0, a, 0], glow: 0.8 });
  }
  b.torus(0.35, 0.025, [0, dy + 0.21, -0.6], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 16 });
  b.sphere(0.33, [0, dy + 0.2, -0.6], t.main, { w: 14, h: 6, phi: Math.PI / 2, scale: [1, 1.25, 1] });
  for (let i = 0; i < 4; i++) rib(b, 0.335, 0.012, [0, dy + 0.2, -0.6], BRASS, (i * Math.PI) / 4, 1.25);
  b.drum(0.08, 0.06, 0.12, 8, [0, dy + 0.66, -0.6], BRASS, { bevel: 0.015 });
  b.box(0.1, 0.04, 0.1, [0, dy + 0.64, -0.6], AMBER, { glow: 0.9 });
  b.cyl(0.012, 0.018, 0.55, 5, [0, dy + 0.98, -0.6], IRON);
  b.sphere(0.025, [0, dy + 1.26, -0.6], BRASS, { w: 6, h: 4 });
  pennant(b, [0.012, dy + 1.14, -0.6], 0.42, 0.18, t.main);
  // the iron gate across the court, gate piers with brass urns, gas lamps
  for (const x of [-0.6, -0.12, 0.12, 0.6]) {
    b.block(0.08, 0.26, 0.08, [x, y0 + 0.13, 1.33], STONE_L, { bevel: 0.015 });
    b.sphere(0.03, [x, y0 + 0.29, 1.33], BRASS, { w: 6, h: 4 });
  }
  for (const [a, c] of [[-0.6, -0.12], [0.12, 0.6]] as [number, number][]) {
    b.box(c - a, 0.015, 0.015, [(a + c) / 2, y0 + 0.2, 1.33], IRON);
    for (let i = 1; i < 6; i++) b.box(0.01, 0.2, 0.01, [a + ((c - a) * i) / 6, y0 + 0.1, 1.33], IRON);
  }
  for (const sx of [-1, 1]) lamp(b, sx * 0.4, 0.75, 0.15, 0.3);
  for (const x of [-1.38, 1.38]) for (const z of [-1.38, 1.38]) light(b, [x, 0.15, z], 0.05);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 1.1, 0], rotors: [], height: 2.2 };
}

/**
 * Forges: a brick foundry under a team gable roof with a glazed ridge
 * lantern, two tall stacks with sooty crowns, the furnace mouth glowing in
 * the south wall and a channel of molten metal running to the moulds; coal
 * heaped in the yard.
 */
function fabPlant(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], 0x6b5a48, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  // the hall: brick walls, darker pilasters, a stone string course
  b.block(1.5, 0.56, 1.0, [-0.12, y0 + 0.28, -0.38], BRICK, { bevel: 0.02 });
  for (let i = 0; i < 6; i++) {
    const x = -0.84 + i * 0.288;
    b.box(0.06, 0.56, 1.04, [x, y0 + 0.28, -0.38], BRICK_D);
  }
  b.box(1.54, 0.04, 1.04, [-0.12, y0 + 0.5, -0.38], STONE);
  // tall arched windows, gaslit from the furnace inside
  for (const x of [-0.7, -0.41, 0.17, 0.46]) {
    b.box(0.1, 0.22, 0.02, [x, y0 + 0.28, 0.125], 0xffa040, { glow: 0.55 });
    b.box(0.1, 0.22, 0.02, [x, y0 + 0.28, -0.885], 0xffa040, { glow: 0.4 });
  }
  // the team gable roof, ridge east-west, with a glazed smoke lantern along it
  gable(b, 1.12, 0.36, 1.58, [-0.12, y0 + 0.56, -0.38], t.main, Math.PI / 2);
  b.block(1.0, 0.1, 0.2, [-0.12, y0 + 0.95, -0.38], IRON, { bevel: 0.015 });
  b.box(0.96, 0.05, 0.22, [-0.12, y0 + 0.93, -0.38], 0xffa040, { glow: 0.6 });
  gable(b, 0.28, 0.08, 1.04, [-0.12, y0 + 1.0, -0.38], t.dark, Math.PI / 2);
  b.box(1.6, 0.025, 0.04, [-0.12, y0 + 0.92, -0.38], t.light);
  // the furnace mouth: a stone arch, the white-hot throat, a channel of molten metal to the moulds
  b.block(0.46, 0.4, 0.08, [-0.12, y0 + 0.2, 0.15], STONE, { bevel: 0.015 });
  b.box(0.3, 0.2, 0.04, [-0.12, y0 + 0.13, 0.18], EXHAUST, { glow: 1 });
  b.cyl(0.15, 0.15, 0.04, 10, [-0.12, y0 + 0.23, 0.18], EXHAUST, { rot: [Math.PI / 2, 0, 0], glow: 1 });
  b.box(0.08, 0.02, 0.44, [-0.12, y0 + 0.01, 0.42], 0xff8a24, { glow: 1 });
  for (const x of [-0.3, -0.12, 0.06]) {
    b.block(0.13, 0.05, 0.11, [x, y0 + 0.025, 0.7], IRON, { bevel: 0.012 });
    b.box(0.09, 0.012, 0.07, [x, y0 + 0.052, 0.7], 0xff9a30, { glow: 0.9 });
  }
  // two stacks, banded brick, team collars, sooty crowns
  for (const [x, z, h] of [[0.75, -0.66, 1.42], [0.75, -0.18, 1.18]] as Vec3[]) {
    b.block(0.24, 0.16, 0.24, [x, y0 + 0.08, z], STONE, { bevel: 0.02 });
    b.drum(0.11, 0.075, h, 8, [x, y0 + 0.16 + h / 2, z], BRICK, { bevel: 0.01 });
    b.drum(0.105, 0.1, 0.06, 8, [x, y0 + 0.16 + h * 0.55, z], t.main, { bevel: 0.01 });
    b.drum(0.088, 0.085, 0.1, 8, [x, y0 + 0.16 + h - 0.05, z], SOOT, { bevel: 0.012, edge: 1.6 });
    b.cyl(0.055, 0.055, 0.02, 8, [x, y0 + 0.16 + h, z], EXHAUST, { glow: 0.7 });
  }
  // the yard: coal, a tip wagon on its rails, a gas lamp
  coal(b, -0.6, 0.6, y0, 1.1);
  for (const x of [0.52, 0.66]) b.box(0.02, 0.015, 0.7, [x, y0 + 0.008, 0.52], IRON);
  b.block(0.24, 0.12, 0.3, [0.59, y0 + 0.1, 0.55], WOOD, { bevel: 0.015 });
  b.box(0.2, 0.03, 0.26, [0.59, y0 + 0.165, 0.55], COAL);
  lamp(b, 0.3, 0.82, y0, 0.3);
  light(b, [-0.86, y0 + 0.02, 0.86], 0.05);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.6 };
}

/**
 * Chalais-Meudon: the airship hangar along the west half, a team vault on
 * iron ribs with its south doors open on a dirigible's nose; a landing
 * ground east of it with a team ring, gas lamps and an iron mooring mast.
 */
function airpad(t: Team): ModelDef {
  const b = siteB();
  b.block(1.95, 0.1, 1.95, [0, 0.05, 0], LAWN, { taper: 0.02, bevel: 0.03 });
  const y0 = 0.1;
  // the landing ground
  b.cyl(0.46, 0.46, 0.02, 20, [0.42, y0 + 0.01, 0.3], GRAVEL);
  b.torus(0.4, 0.035, [0.42, y0 + 0.025, 0.3], t.main, { rot: [Math.PI / 2, 0, 0], seg: 22 });
  // (the mooring ring in the middle, the ground crew's guy pegs round it)
  b.torus(0.08, 0.02, [0.42, y0 + 0.03, 0.3], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 12 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.box(0.2, 0.01, 0.025, [0.42 + Math.cos(a) * 0.2, y0 + 0.025, 0.3 + Math.sin(a) * 0.2], STONE_L, { rot: [0, -a, 0] });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    light(b, [0.42 + Math.cos(a) * 0.47, y0 + 0.03, 0.3 + Math.sin(a) * 0.47], 0.035);
  }
  // the hangar: brick footings, a team vault, iron ribs, a glazed ridge
  const hx = -0.47;
  const r = 0.44;
  for (const sx of [-1, 1]) b.block(0.08, 0.12, 1.78, [hx + sx * r, y0 + 0.06, 0], BRICK, { bevel: 0.015 });
  vault(b, r, 1.74, [hx, y0 + 0.1, 0], t.main, { seg: 14, hy: 1.3 });
  for (let i = 0; i < 7; i++) rib(b, r + 0.01, 0.018, [hx, y0 + 0.1, -0.84 + i * 0.28], IRON, 0, 1.3);
  b.box(0.08, 0.025, 1.7, [hx, y0 + 0.1 + r * 1.3 + 0.005, 0], GLAZE, { glow: 0.25 });
  // the north gable, closed in stone; the south doors open, the dirigible's nose in the dark
  vault(b, r - 0.005, 0.03, [hx, y0 + 0.1, -0.875], STONE, { seg: 14, hy: 1.3 });
  vault(b, r - 0.06, 0.03, [hx, y0 + 0.1, 0.86], 0x15120f, { seg: 14, hy: 1.3 });
  b.sphere(0.24, [hx, y0 + 0.38, 0.72], CANVAS, { w: 12, h: 8, scale: [1, 0.95, 1.1] });
  b.torus(0.21, 0.01, [hx, y0 + 0.38, 0.84], BRASS, { seg: 14 });
  for (const sx of [-1, 1]) b.box(0.04, 0.6, 0.1, [hx + sx * (r - 0.01), y0 + 0.3, 0.9], WOOD_D, { rot: [0, sx * 0.9, 0] });
  // the mooring mast: an iron lattice, a brass mooring cone, a team pennant, a lamp
  pylon(b, 0.5, -0.5, 0.13, 0.04, y0, y0 + 1.05, 4, 0.016, 0.007);
  b.block(0.3, 0.06, 0.3, [0.5, y0 + 0.03, -0.5], STONE, { bevel: 0.015 });
  b.block(0.16, 0.035, 0.16, [0.5, y0 + 0.5, -0.5], t.main, { bevel: 0.01 });
  b.cone(0.06, 0.12, 8, [0.5, y0 + 1.1, -0.5], BRASS);
  b.cyl(0.008, 0.008, 0.28, 4, [0.5, y0 + 1.28, -0.5], IRON);
  pennant(b, [0.5, y0 + 1.36, -0.5], 0.24, 0.1, t.main);
  light(b, [0.5, y0 + 1.17, -0.5], 0.03);
  // gas bottles for the hydrogen, team-banded, and a lamp
  for (const z of [-0.85, -0.68]) {
    b.cyl(0.07, 0.07, 0.34, 8, [0.15, y0 + 0.08, z], 0x6e7a5a, { rot: [0, 0, Math.PI / 2] });
    b.cyl(0.074, 0.074, 0.06, 8, [0.15, y0 + 0.08, z], t.main, { rot: [0, 0, Math.PI / 2] });
  }
  lamp(b, 0.86, 0.86, y0, 0.28);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 1.4 };
}

/**
 * Polytechnique: a neoclassical academy (team hipped roof, a portico with a
 * team pediment), a brass-domed observatory with its telescope out of the
 * slit, a Tesla coil crackling on its toroid, glowing radium jars.
 */
function techLab(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], STONE_D, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  // the academy along the south side
  b.block(1.62, 0.48, 0.72, [0, y0 + 0.24, 0.42], STONE, { bevel: 0.02 });
  b.box(1.66, 0.07, 0.76, [0, y0 + 0.035, 0.42], STONE_D);
  b.block(1.68, 0.05, 0.78, [0, y0 + 0.5, 0.42], STONE_L, { bevel: 0.015, edge: 1.2 });
  frustum(b, 1.62, 0.22, 0.72, 0.16, [0, y0 + 0.635, 0.42], t.main);
  b.block(1.3, 0.035, 0.4, [0, y0 + 0.76, 0.42], t.main, { bevel: 0.025, edge: 1.45 });
  b.box(1.2, 0.025, 0.02, [0, y0 + 0.79, 0.42], BRASS);
  for (const y of [y0 + 0.17, y0 + 0.37]) {
    panes(b, "+z", -0.72, -0.3, 3, y, 0.785, 0.07, 0.11);
    panes(b, "+z", 0.3, 0.72, 3, y, 0.785, 0.07, 0.11);
    panes(b, "-z", -0.7, 0.7, 7, y, 0.055, 0.07, 0.11, 0.45);
  }
  // the portico: six columns, a team pediment, the lit door, steps
  for (let i = 0; i < 6; i++) b.cyl(0.025, 0.03, 0.42, 6, [-0.2 + i * 0.08, y0 + 0.21, 0.86], STONE_L);
  b.block(0.52, 0.06, 0.18, [0, y0 + 0.45, 0.82], STONE_L, { bevel: 0.012 });
  gable(b, 0.54, 0.15, 0.2, [0, y0 + 0.48, 0.82], t.main);
  b.box(0.12, 0.22, 0.02, [0, y0 + 0.12, 0.79], PANE, { glow: 0.9 });
  b.box(0.5, 0.03, 0.12, [0, y0 + 0.015, 0.95], STONE_L);
  // the observatory, north-west: a stone drum, a team ring, a brass dome with its slit and telescope
  const [ox, oz] = [-0.45, -0.42];
  b.drum(0.4, 0.38, 0.44, 12, [ox, y0 + 0.22, oz], STONE, { bevel: 0.015 });
  panes(b, "+z", ox - 0.15, ox + 0.15, 2, y0 + 0.24, oz + 0.405, 0.06, 0.1);
  b.torus(0.385, 0.035, [ox, y0 + 0.45, oz], t.main, { rot: [Math.PI / 2, 0, 0], seg: 18 });
  b.sphere(0.37, [ox, y0 + 0.45, oz], BRASS, { w: 16, h: 7, phi: Math.PI / 2 });
  b.box(0.1, 0.03, 0.4, [ox + 0.1, y0 + 0.66, oz + 0.1], IRON, { rot: [0.9, -0.785, 0] });
  b.box(0.1, 0.03, 0.3, [ox + 0.08, y0 + 0.8, oz + 0.08], IRON, { rot: [0.25, -0.785, 0] });
  b.tube(0.045, 0.46, 8, [ox + 0.18, y0 + 0.78, oz + 0.18], 0xe6d2a2, { rot: [0.75, -0.785 + Math.PI, 0] });
  b.tube(0.05, 0.05, 8, [ox + 0.32, y0 + 0.92, oz + 0.32], BRASS, { rot: [0.75, -0.785 + Math.PI, 0] });
  // the Tesla coil, north-east: an iron base, ivory insulators, a copper coil, the toroid, its spark
  const [cx, cz] = [0.5, -0.5];
  b.drum(0.18, 0.15, 0.12, 8, [cx, y0 + 0.06, cz], IRON, { bevel: 0.015 });
  b.drum(0.14, 0.12, 0.04, 8, [cx, y0 + 0.14, cz], t.main, { bevel: 0.01 });
  for (let i = 0; i < 3; i++) b.cyl(0.05, 0.065, 0.06, 8, [cx, y0 + 0.2 + i * 0.06, cz], STONE_L);
  b.cyl(0.06, 0.07, 0.42, 10, [cx, y0 + 0.55, cz], COPPER);
  for (let i = 0; i < 6; i++) b.torus(0.07, 0.008, [cx, y0 + 0.38 + i * 0.07, cz], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 10 });
  b.torus(0.12, 0.05, [cx, y0 + 0.82, cz], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 14 });
  b.sphere(0.05, [cx, y0 + 0.88, cz], SPARK, { glow: 1, w: 8, h: 5 });
  for (const [dx, dz, ry] of [[0.17, 0.02, 0.2], [-0.12, 0.13, 2.2], [-0.06, -0.17, 4.3]] as Vec3[])
    b.box(0.16, 0.012, 0.012, [cx + dx, y0 + 0.86, cz + dz], SPARK, { rot: [0, ry, 0.35], glow: 1 });
  // radium jars in a brass rack between them
  b.block(0.4, 0.04, 0.16, [0.05, y0 + 0.02, -0.75], BRASS, { bevel: 0.01 });
  for (const x of [-0.08, 0.05, 0.18]) {
    b.cyl(0.045, 0.045, 0.16, 8, [x, y0 + 0.12, -0.75], RADIUM, { glow: 0.9 });
    b.cyl(0.05, 0.05, 0.025, 8, [x, y0 + 0.21, -0.75], BRASS);
  }
  lamp(b, 0.82, 0.05, y0, 0.28);
  lamp(b, -0.82, 0.05, y0, 0.28);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0], rotors: [], height: 1.2 };
}

/**
 * Halles: a Baltard pavilion of iron and glass on a brick socle, its zinc
 * roof edged in a team band and crowned by a glazed lantern with a team
 * roof; coal heaped beside it and a coal wagon at the door.
 */
function depot(t: Team): ModelDef {
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], STONE_D, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  const [w, d, cz] = [1.56, 1.16, -0.3];
  // the brick socle, the glass walls amber-lit, the iron columns and entablature
  b.block(w, 0.12, d, [0, y0 + 0.06, cz], BRICK, { bevel: 0.012 });
  b.box(w - 0.04, 0.34, d - 0.04, [0, y0 + 0.29, cz], GLAZE, { glow: 0.3 });
  for (let i = 0; i < 9; i++) {
    const x = -w / 2 + (w * i) / 8;
    b.box(0.035, 0.36, 0.035, [x, y0 + 0.3, cz + d / 2], IRON);
    b.box(0.035, 0.36, 0.035, [x, y0 + 0.3, cz - d / 2], IRON);
  }
  for (let i = 1; i < 6; i++) {
    const z = cz - d / 2 + (d * i) / 6;
    b.pair(0.035, 0.36, 0.035, [w / 2, y0 + 0.3, z], IRON);
  }
  for (const y of [y0 + 0.2, y0 + 0.36]) {
    b.box(w + 0.01, 0.012, 0.012, [0, y, cz + d / 2], IRON);
    b.box(w + 0.01, 0.012, 0.012, [0, y, cz - d / 2], IRON);
    b.pair(0.012, 0.012, d, [w / 2, y, cz], IRON);
  }
  b.block(w + 0.06, 0.05, d + 0.06, [0, y0 + 0.5, cz], IRON, { bevel: 0.012 });
  // the roof: a team eave band, the zinc slope, the glazed lantern, its team roof
  frustum(b, w + 0.08, 0.08, d + 0.08, 0.07, [0, y0 + 0.565, cz], t.main);
  frustum(b, w - 0.06, 0.14, d - 0.06, 0.2, [0, y0 + 0.675, cz], ZINC);
  for (let i = 0; i < 5; i++) b.box(0.012, 0.012, d - 0.5, [-0.5 + i * 0.25, y0 + 0.752, cz], 0x5e686e);
  b.box(0.98, 0.14, 0.58, [0, y0 + 0.82, cz], GLAZE, { glow: 0.45 });
  for (let i = 0; i < 6; i++) b.pair(0.02, 0.15, 0.02, [0.49, y0 + 0.82, cz - 0.29 + i * 0.116], IRON);
  frustum(b, 1.06, 0.12, 0.66, 0.14, [0, y0 + 0.95, cz], t.main);
  b.block(0.74, 0.03, 0.34, [0, y0 + 1.02, cz], t.main, { bevel: 0.02, edge: 1.45 });
  b.box(0.7, 0.025, 0.02, [0, y0 + 1.045, cz], BRASS);
  // the great arched bay on the south front: a glazed fan over a dark door
  vault(b, 0.22, 0.03, [0, y0 + 0.24, cz + d / 2 + 0.02], PANE, { seg: 10, glow: 0.6 });
  b.box(0.44, 0.24, 0.03, [0, y0 + 0.12, cz + d / 2 + 0.02], 0x1a1612);
  rib(b, 0.22, 0.02, [0, y0 + 0.24, cz + d / 2 + 0.04], IRON);
  // coal for the harvest: heaps along the yard, a wagon, gas lamps
  coal(b, -0.5, 0.62, y0, 1.15);
  coal(b, 0.15, 0.72, y0, 0.85);
  b.block(0.24, 0.13, 0.32, [0.62, y0 + 0.1, 0.6], WOOD, { bevel: 0.015 });
  b.box(0.2, 0.04, 0.28, [0.62, y0 + 0.17, 0.6], COAL);
  b.pair(0.02, 0.07, 0.07, [0.13, y0 + 0.035, 0.5], IRON);
  b.pair(0.02, 0.07, 0.07, [0.13, y0 + 0.035, 0.7], IRON);
  b.box(0.02, 0.07, 0.07, [0.49, y0 + 0.035, 0.5], IRON);
  b.box(0.02, 0.07, 0.07, [0.75, y0 + 0.035, 0.7], IRON);
  lamp(b, -0.86, 0.86, y0, 0.3);
  lamp(b, 0.86, 0.28, y0, 0.3);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.25 };
}

/**
 * Hotchkiss: a stone emplacement ringed with sandbags; the turret a Hotchkiss
 * revolving cannon (five barrels round a brass breech) on its carriage behind
 * a team shield, a team ammunition chest at its back.
 */
function turret(t: Team): ModelDef {
  const b = siteB();
  b.drum(0.46, 0.42, 0.16, 8, [0, 0.08, 0], STONE_D, { rot: [0, Math.PI / 8, 0], bevel: 0.025 });
  b.cyl(0.32, 0.32, 0.02, 8, [0, 0.165, 0], IRON, { rot: [0, Math.PI / 8, 0] });
  for (let k = 0; k < 2; k++) {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = ((i + k * 0.5) / n) * Math.PI * 2;
      const r = 0.38 - k * 0.02;
      if (k) b.block(0.17, 0.065, 0.1, [Math.sin(a) * r, 0.255, Math.cos(a) * r], 0xc6ae80, { rot: [0, a, 0], bevel: 0.02, edge: 1.2 });
      else b.box(0.17, 0.065, 0.1, [Math.sin(a) * r, 0.195, Math.cos(a) * r], SACK, { rot: [0, a, 0] });
    }
  }
  // team pennants pinned to the parapet, so the side reads from above even with the gun turned
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.block(0.13, 0.03, 0.09, [Math.sin(a) * 0.37, 0.27, Math.cos(a) * 0.37], t.main, { rot: [0, a, 0], bevel: 0.01, edge: 1.4 });
  }
  const hull = b.build();
  const h = partB();
  h.drum(0.15, 0.13, 0.05, 8, [0, 0.025, 0], BRASS, { bevel: 0.012 });
  h.pair(0.03, 0.14, 0.16, [0.1, 0.11, 0.0], IRON);
  // the breech housing, team-topped, a crank wheel on its side
  h.block(0.15, 0.11, 0.2, [0, 0.13, 0.02], BRASS, { bevel: 0.02 });
  h.block(0.11, 0.02, 0.15, [0, 0.19, 0.03], t.main, { bevel: 0.008 });
  h.torus(0.045, 0.01, [0.095, 0.13, 0.06], IRON, { rot: [0, Math.PI / 2, 0], seg: 10 });
  h.box(0.04, 0.012, 0.012, [0.115, 0.13, 0.06], IRON);
  // five barrels round the axis, banded at the muzzle
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    h.tube(0.013, 0.4, 5, [Math.sin(a) * 0.03, 0.13 + Math.cos(a) * 0.03, -0.28], 0x2a2420);
  }
  h.tube(0.048, 0.025, 8, [0, 0.13, -0.42], BRASS);
  h.tube(0.048, 0.025, 8, [0, 0.13, -0.17], BRASS);
  // the team shield, raked back, with a sight notch; the ammunition chest behind
  h.block(0.38, 0.2, 0.045, [0, 0.16, -0.12], t.main, { rot: [-0.3, 0, 0], bevel: 0.018, edge: 1.4 });
  h.pairBlock(0.08, 0.16, 0.04, [0.2, 0.14, -0.09], t.main, { rot: [-0.3, 0.5, 0], bevel: 0.012, edge: 1.3 });
  h.box(0.06, 0.04, 0.05, [0, 0.26, -0.15], IRON, { rot: [-0.3, 0, 0] });
  h.block(0.18, 0.09, 0.1, [0, 0.07, 0.17], t.dark, { bevel: 0.015 });
  h.block(0.16, 0.02, 0.08, [0, 0.12, 0.17], t.main, { bevel: 0.008 });
  light(h, [0.07, 0.2, 0.12], 0.03);
  return { hull, turret: h.build(), mount: [0, 0.18, 0], muzzle: [0, 0.13, -0.48], rotors: [], height: 0.55 };
}

/**
 * Batterie Ruggieri: a stone launch platform; the turret a brass turntable
 * and iron cheeks carrying a raked rack of six great Congreve rockets,
 * paper-cased with team bands and team warheads, their guide sticks trailing.
 */
function samSite(t: Team): ModelDef {
  const b = siteB();
  b.block(0.86, 0.16, 0.86, [0, 0.08, 0], STONE_D, { taper: 0.05, bevel: 0.025 });
  b.torus(0.3, 0.02, [0, 0.165, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 16 });
  for (const x of [-0.34, 0.34]) for (const z of [-0.34, 0.34]) b.block(0.14, 0.04, 0.14, [x, 0.18, z], t.main, { bevel: 0.012, edge: 1.4 });
  // spare rockets in their crate on the south edge
  b.block(0.3, 0.06, 0.1, [0, 0.19, 0.37], WOOD, { bevel: 0.012 });
  for (const x of [-0.08, 0, 0.08]) b.cone(0.018, 0.04, 5, [x, 0.23, 0.37], t.main);
  const hull = b.build();
  const h = partB();
  h.drum(0.24, 0.22, 0.07, 10, [0, 0.035, 0], BRASS, { bevel: 0.015 });
  h.pair(0.035, 0.24, 0.14, [0.2, 0.17, 0.02], IRON);
  const pitch = 0.55;
  // the rack: two iron frames, a team top plate
  h.block(0.4, 0.04, 0.46, [0, 0.2, -0.02], IRON, { rot: [pitch, 0, 0], bevel: 0.01 });
  h.box(0.36, 0.02, 0.18, [0, 0.38, 0.06], t.main, { rot: [pitch, 0, 0] });
  h.pair(0.02, 0.2, 0.44, [0.19, 0.3, -0.02], IRON, { rot: [pitch, 0, 0] });
  for (const x of [-0.12, 0, 0.12])
    for (const y of [0.24, 0.33]) {
      const base: Vec3 = [x, y, 0.1];
      barrel(h, base, 0.033, 0.34, pitch, 0xe9dcc0, 7);
      const mid = barrelTip(base, 0.22, pitch);
      h.tube(0.035, 0.05, 7, mid, t.main, { rot: [pitch, 0, 0] });
      const tip = barrelTip(base, 0.34, pitch);
      h.cone(0.034, 0.1, 7, [tip[0], tip[1] + Math.sin(pitch) * 0.05, tip[2] - Math.cos(pitch) * 0.05], t.main, { rot: [pitch - Math.PI / 2, 0, 0] });
      // (the guide stick, trailing back and down)
      rod(h, [x, y - 0.02, 0.1], [x, y - Math.sin(pitch) * 0.26, 0.1 + Math.cos(pitch) * 0.26], 0.006, WOOD_D);
    }
  const muzzle = barrelTip([0, 0.28, 0.1], 0.44, pitch);
  return { hull, turret: h.build(), mount: [0, 0.16, 0], muzzle, rotors: [], height: 0.75 };
}

/**
 * Tour TSF: a little Eiffel tower of wrought iron on stone piers, arched
 * between its feet, team platforms; the turret is its wireless head on top,
 * a team spreader with a loop antenna that sweeps round.
 */
function radar(t: Team): ModelDef {
  const b = siteB();
  b.block(0.84, 0.1, 0.84, [0, 0.05, 0], STONE_D, { taper: 0.05, bevel: 0.02 });
  const y0 = 0.1;
  for (const x of [-0.29, 0.29]) for (const z of [-0.29, 0.29]) b.block(0.14, 0.08, 0.14, [x, y0 + 0.04, z], STONE, { bevel: 0.015 });
  // the lower stage: four splayed legs, arches between the feet, the first platform
  pylon(b, 0, 0, 0.29, 0.15, y0 + 0.08, y0 + 0.42, 2, 0.022, 0.008);
  for (const ry of [0, Math.PI / 2])
    for (const s of [-1, 1]) {
      const at: Vec3 = ry ? [s * 0.27, y0 + 0.08, 0] : [0, y0 + 0.08, s * 0.27];
      rib(b, 0.2, 0.012, at, IRON, ry, 1.2);
    }
  b.block(0.42, 0.04, 0.42, [0, y0 + 0.44, 0], t.main, { bevel: 0.015, edge: 1.45 });
  for (const [x, z] of [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]] as [number, number][]) b.box(z ? 0.4 : 0.01, 0.04, z ? 0.01 : 0.4, [x, y0 + 0.49, z], IRON);
  panes(b, "+z", -0.1, 0.1, 3, y0 + 0.49, 0.215, 0.04, 0.025, 0.6);
  // the upper stage up to the second platform and the shaft
  pylon(b, 0, 0, 0.15, 0.07, y0 + 0.46, y0 + 0.82, 2, 0.016, 0.006);
  b.block(0.2, 0.03, 0.2, [0, y0 + 0.83, 0], t.main, { bevel: 0.01, edge: 1.4 });
  pylon(b, 0, 0, 0.07, 0.035, y0 + 0.84, y0 + 1.06, 1, 0.012, 0.005);
  light(b, [0.11, y0 + 0.86, 0.11], 0.025);
  const hull = b.build();
  // the wireless head: a brass pivot, a short mast, a team spreader with the loop antenna, insulators, the spark ball
  const h = partB();
  h.drum(0.06, 0.05, 0.05, 8, [0, 0.025, 0], BRASS, { bevel: 0.01 });
  h.cyl(0.012, 0.016, 0.5, 5, [0, 0.27, 0], IRON);
  h.block(0.62, 0.035, 0.07, [0, 0.12, 0], t.main, { bevel: 0.012, edge: 1.45 });
  for (const sx of [-1, 1]) {
    h.box(0.012, 0.36, 0.012, [sx * 0.28, 0.3, 0], IRON);
    h.cyl(0.018, 0.018, 0.04, 6, [sx * 0.28, 0.16, 0], STONE_L);
    rod(h, [sx * 0.28, 0.48, 0], [0, 0.52, 0], 0.006, IRON);
    rod(h, [sx * 0.28, 0.14, 0], [0, 0.48, 0], 0.004, 0x5a4a38);
  }
  h.box(0.56, 0.012, 0.012, [0, 0.48, 0], IRON);
  h.block(0.2, 0.025, 0.05, [0, 0.54, 0], t.main, { bevel: 0.008 });
  h.sphere(0.035, [0, 0.58, 0], BRASS, { w: 8, h: 5 });
  h.sphere(0.022, [0, 0.62, 0], SPARK, { glow: 1, w: 6, h: 4 });
  return { hull, turret: h.build(), mount: [0, y0 + 1.06, 0], muzzle: [0, 0.3, 0], rotors: [], height: 1.8 };
}

/**
 * Manufacture: a brick workshop for automatons under a team sawtooth roof
 * (glazed north lights), a clock pediment over two great arched doors, one
 * open on a lit hall and a finished automaton; a team roll-out pad on the
 * cobbled apron where squads step off.
 */
function assemblyBay(t: Team): ModelDef {
  const f = factionOf(t);
  const b = siteB();
  b.block(1.92, 0.1, 1.92, [0, 0.05, 0], STONE_D, { taper: 0.03, bevel: 0.03 });
  const y0 = 0.1;
  b.box(1.76, 0.02, 0.68, [0, y0 + 0.01, 0.58], 0x8a8070);
  // the workshop: brick, pilasters, a stone string course
  const [z0, z1] = [-0.88, 0.22];
  const zc = (z0 + z1) / 2;
  b.block(1.76, 0.5, z1 - z0, [0, y0 + 0.25, zc], BRICK, { bevel: 0.015 });
  for (let i = 0; i < 7; i++) b.box(0.06, 0.5, z1 - z0 + 0.03, [-0.84 + i * 0.28, y0 + 0.25, zc], BRICK_D);
  b.box(1.8, 0.035, z1 - z0 + 0.04, [0, y0 + 0.46, zc], STONE);
  // the sawtooth: four team slopes, their north lights glazed and lit
  const n = 4;
  const td = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const z = z0 + td * (i + 0.5);
    tooth(b, td, 0.24, 1.76, [0, y0 + 0.5, z], t.main);
    b.box(1.6, 0.18, 0.02, [0, y0 + 0.6, z - td / 2 - 0.004], GLAZE, { glow: 0.5 });
    b.box(1.78, 0.025, 0.035, [0, y0 + 0.745, z - td / 2 + 0.01], t.light);
  }
  // the south front: two arched doors, the left open on the lit hall, the right shut; a clock over them
  for (const sx of [-1, 1]) {
    const x = sx * 0.42;
    b.box(0.42, 0.3, 0.03, [x, y0 + 0.15, z1 + 0.01], sx < 0 ? 0x2a1d12 : WOOD);
    vault(b, 0.21, 0.03, [x, y0 + 0.3, z1 + 0.01], sx < 0 ? 0x2a1d12 : WOOD, { seg: 10 });
    rib(b, 0.22, 0.02, [x, y0 + 0.3, z1 + 0.025], STONE);
    if (sx > 0) {
      for (const y of [0.1, 0.24]) b.box(0.4, 0.02, 0.02, [x, y0 + y, z1 + 0.03], IRON);
      b.box(0.01, 0.42, 0.02, [x, y0 + 0.2, z1 + 0.03], IRON);
    }
  }
  b.box(0.36, 0.3, 0.02, [-0.42, y0 + 0.16, z1 - 0.2], AMBER, { glow: 0.55 });
  b.addBuilt(botStatic("trooper", f), [-0.42, y0, z1 - 0.06], { rot: [0, Math.PI, 0], scale: [1.15, 1.15, 1.15] });
  b.block(0.24, 0.14, 0.04, [0, y0 + 0.42, z1 + 0.02], STONE_L, { bevel: 0.01 });
  b.cyl(0.055, 0.055, 0.02, 12, [0, y0 + 0.42, z1 + 0.045], STONE_L, { rot: [Math.PI / 2, 0, 0] });
  b.torus(0.055, 0.008, [0, y0 + 0.42, z1 + 0.055], BRASS, { seg: 12 });
  b.box(0.006, 0.04, 0.006, [0, y0 + 0.435, z1 + 0.058], IRON);
  b.box(0.03, 0.006, 0.006, [0.012, y0 + 0.42, z1 + 0.058], IRON);
  gable(b, 0.28, 0.08, 0.06, [0, y0 + 0.49, z1 + 0.02], t.main);
  // the roll-out pad on the apron: stone, a team ring, gas lamps
  const [px, pz] = [-0.32, 0.64];
  b.cyl(0.27, 0.29, 0.03, 16, [px, y0 + 0.03, pz], STONE);
  b.torus(0.23, 0.026, [px, y0 + 0.048, pz], t.main, { rot: [Math.PI / 2, 0, 0], seg: 18 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    light(b, [px + Math.cos(a) * 0.28, y0 + 0.05, pz + Math.sin(a) * 0.28], 0.03);
  }
  // parts crates and a spare automaton torso on the east of the apron, a lamp
  b.block(0.24, 0.16, 0.2, [0.55, y0 + 0.08, 0.55], WOOD, { bevel: 0.015 });
  b.box(0.25, 0.02, 0.21, [0.55, y0 + 0.15, 0.55], BRASS);
  b.block(0.16, 0.12, 0.16, [0.6, y0 + 0.06, 0.8], WOOD_D, { rot: [0, 0.4, 0], bevel: 0.012 });
  b.addBuilt(botStatic("trooper", f), [0.24, y0, 0.66], { rot: [0, Math.PI - 0.5, 0], scale: [1.1, 1.1, 1.1] });
  lamp(b, 0.86, 0.32, y0, 0.3);
  lamp(b, -0.86, 0.32, y0, 0.3);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0.2], rotors: [], height: 1.1 };
}

/**
 * Galerie des Machines, where a Goliath is built: a 3×3 hall open front and
 * back (it walks out toward the back of its base) under two great latticed
 * three-hinged arches; iron lattice piers either side with timber galleries
 * and team glass roofs, their welding arms swinging in over the stone cradle,
 * a steam crane on the east pier working armour plates from the rack, gas
 * floor lamps down the cradle. Every moving part keeps the original's name,
 * pivot and reach (render/goliath.ts GantryView drives them).
 */
function gantry(t: Team): ModelDef {
  const f = factionOf(t);
  const b = siteB();
  b.block(2.9, 0.14, 2.9, [0, 0.07, 0], STONE_D, { taper: 0.02, bevel: 0.04 });
  b.box(2.3, 0.02, 2.82, [0, 0.145, 0], 0x6a5c4a);
  for (let i = 0; i < 12; i++) b.box(0.012, 0.004, 2.8, [-1.1 + i * 0.2, 0.157, 0], 0x5a4e3e);
  // the thresholds front and back: stone kerbs with team markers, rails out
  for (const z of [-1.36, 1.36]) for (let i = 0; i < 11; i++) b.box(0.2, 0.03, 0.08, [-1.0 + i * 0.2, 0.16, z], i % 2 ? STONE_L : t.main);
  for (const x of [-0.4, 0.4]) b.box(0.03, 0.02, 2.82, [x, 0.16, 0], IRON);
  // the cradle: a stone plinth, a timber deck, iron foot clamps with brass bolts, team bands
  b.block(1.56, 0.12, 1.36, [0, 0.2, 0], STONE, { bevel: 0.03, edge: 1.3 });
  b.block(1.36, 0.03, 1.16, [0, 0.27, 0], WOOD_D, { bevel: 0.01 });
  for (const x of [-0.4, 0.4]) {
    b.block(0.52, 0.07, 0.8, [x, 0.3, -0.06], IRON, { bevel: 0.02 });
    for (const z of [-0.36, 0.24]) b.box(0.08, 0.06, 0.08, [x + 0.24, 0.33, z], BRASS);
  }
  b.pairBlock(0.05, 0.07, 1.36, [0.8, 0.22, 0], t.main, { bevel: 0.012, edge: 1.4 });
  // the piers: iron columns, rails and lattice, two timber galleries with brass rails, team glass roofs
  for (const sx of [-1, 1]) {
    const xi = sx * 1.2;
    const xo = sx * 1.4;
    b.block(0.4, 0.22, 1.94, [sx * 1.3, 0.25, 0], STONE, { bevel: 0.03 });
    for (const x of [xi, xo]) for (const z of [-0.85, 0.85]) b.box(0.065, 2.86, 0.065, [x, 1.62, z], IRON);
    for (let k = 0; k < 5; k++) {
      const y = 0.75 + k * 0.55;
      for (const x of [xi, xo]) b.box(0.045, 0.045, 1.7, [x, y, 0], IRON);
      for (const z of [-0.85, 0.85]) b.box(0.25, 0.045, 0.045, [sx * 1.3, y, z], IRON);
      // (a riveted lattice on the outer face: an X in each bay)
      if (k < 4)
        for (const zs of [-1, 1]) {
          rod(b, [xo, y, zs * 0.85], [xo, y + 0.55, 0], 0.012, IRON);
          rod(b, [xo, y + 0.55, zs * 0.85], [xo, y, 0], 0.012, IRON);
        }
    }
    for (const y of [1.3, 2.4]) {
      b.block(0.36, 0.04, 1.8, [sx * 1.3, y, 0], WOOD, { bevel: 0.01 });
      b.box(0.015, 0.1, 1.76, [xi + sx * 0.01, y + 0.07, 0], BRASS);
      b.box(0.015, 0.015, 1.76, [xi + sx * 0.01, y + 0.12, 0], BRASS);
    }
    // the team glass roof over the pier, a brass ridge
    b.block(0.4, 0.06, 1.92, [sx * 1.3, 3.05, 0], IRON, { bevel: 0.015 });
    gable(b, 0.4, 0.13, 1.92, [sx * 1.3, 3.08, 0], t.main);
    b.box(0.03, 0.025, 1.94, [sx * 1.3, 3.21, 0], BRASS);
    for (const z of [-0.88, 0.88]) b.box(0.07, 0.06, 0.07, [xo, 3.2, z], IRON);
    b.box(0.04, 0.5, 0.04, [xi, 0.55, -0.4], AMBER, { glow: 0.6 });
  }
  // the two great arches, front and back, springing from the ground over the whole hall
  for (const z of [-1.39, 1.39]) {
    greatArch(b, z, 1.42, 0.14, 3.32, 0.14, IRON);
    for (const sx of [-1, 1]) b.block(0.16, 0.12, 0.14, [sx * 1.38, 0.2, z], STONE_L, { bevel: 0.02 });
    b.sphere(0.04, [0, 3.47, z], BRASS, { w: 6, h: 4 });
  }
  // the steam crane's lattice mast and winch house on the east pier's north end
  pylon(b, 1.3, -0.72, 0.07, 0.05, 3.08, 3.62, 2, 0.014, 0.006);
  b.block(0.26, 0.17, 0.26, [1.3, 3.7, -0.72], WOOD, { bevel: 0.02 });
  b.block(0.28, 0.02, 0.28, [1.3, 3.79, -0.72], t.main, { bevel: 0.008 });
  b.box(0.18, 0.07, 0.02, [1.3, 3.71, -0.86], PANE, { glow: 0.7 });
  b.cyl(0.02, 0.02, 0.14, 5, [1.4, 3.72, -0.62], SOOT);
  // armour plates waiting on a rack in the north-east corner, spare parts crated in the south-west
  b.block(0.5, 0.06, 0.34, [0.95, 0.2, -1.12], IRON, { bevel: 0.01 });
  for (let i = 0; i < 3; i++)
    b.block(0.42, 0.05, 0.3, [0.95, 0.26 + i * 0.06, -1.12], i === 2 ? t.main : 0x6a5a48, { rot: [0, 0.08 * i, 0], bevel: 0.012, edge: 1.35 });
  b.block(0.36, 0.24, 0.3, [-0.95, 0.27, 1.1], WOOD, { bevel: 0.02 });
  for (const x of [-1.12, -0.78]) for (const z of [0.96, 1.24]) b.box(0.04, 0.25, 0.04, [x, 0.27, z], BRASS);
  b.box(0.37, 0.03, 0.31, [-0.95, 0.35, 1.1], WOOD_D);
  light(b, [1.38, 0.17, 1.38], 0.05);
  light(b, [-1.38, 0.17, -1.38], 0.05);
  const hull = b.build();

  // the welding arms, pivoting on the pier tops: in over the cradle, swung clear along the piers for a rollout
  const arm = (sx: number) => {
    const a = partB();
    a.drum(0.09, 0.08, 0.1, 8, [0, 0, 0], BRASS, { bevel: 0.015 });
    a.block(0.72, 0.035, 0.12, [-sx * 0.38, 0.04, 0], IRON, { bevel: 0.01 });
    a.block(0.72, 0.035, 0.12, [-sx * 0.38, -0.04, 0], IRON, { bevel: 0.01 });
    for (let i = 0; i < 5; i++) rod(a, [-sx * (0.06 + i * 0.13), -0.04, 0], [-sx * (0.12 + i * 0.13), 0.04, 0], 0.01, IRON);
    a.block(0.6, 0.02, 0.1, [-sx * 0.38, 0.065, 0], t.main, { bevel: 0.008, edge: 1.4 });
    a.box(0.06, 0.34, 0.06, [-sx * 0.7, -0.2, 0], IRON);
    a.cyl(0.035, 0.035, 0.08, 6, [-sx * 0.7, -0.33, 0], BRASS);
    a.cone(0.035, 0.08, 6, [-sx * 0.7, -0.41, 0], BRASS, { rot: [Math.PI, 0, 0] });
    a.sphere(0.022, [-sx * 0.7, -0.45, 0], AMBER, { glow: 1, w: 6, h: 4 });
    return a.build();
  };
  // the crane: a latticed jib luffing on the mast, the cable (a unit length, stretched), the hook and the plate it carries
  const jib = partB();
  for (const sy of [-1, 1]) jib.box(0.1, 0.025, 1.7, [0, sy * 0.04, -0.85], IRON);
  for (let i = 0; i < 8; i++) rod(jib, [0, -0.04, -0.05 - i * 0.2], [0, 0.04, -0.15 - i * 0.2], 0.01, IRON);
  for (let i = 0; i < 4; i++) jib.box(0.105, 0.105, 0.03, [0, 0, -0.25 - i * 0.4], BRASS);
  jib.block(0.2, 0.16, 0.26, [0, 0, 0.24], IRON, { bevel: 0.02 });
  jib.block(0.18, 0.02, 0.22, [0, 0.085, 0.24], t.main, { bevel: 0.008 });
  light(jib, [0, 0.07, -1.68], 0.03);
  const cable = partB();
  cable.box(0.015, 1, 0.015, [0, -0.5, 0], TRACK);
  const hook = partB();
  hook.block(0.12, 0.08, 0.1, [0, -0.04, 0], IRON, { bevel: 0.01 });
  hook.box(0.03, 0.08, 0.03, [0, -0.12, 0], BRASS);
  const plate = partB();
  plate.block(0.46, 0.05, 0.32, [0, -0.2, 0], 0x6a5a48, { bevel: 0.012, edge: 1.35 });
  plate.box(0.3, 0.012, 0.08, [0, -0.17, 0], t.main);
  for (const x of [-0.2, 0.2]) for (const z of [-0.13, 0.13]) plate.box(0.02, 0.012, 0.02, [x, -0.17, z], BRASS);
  for (const x of [-0.18, 0.18]) plate.box(0.008, 0.16, 0.008, [x * 0.5, -0.1, 0], TRACK, { rot: [0, 0, x] });
  // gas floor lamps down the cradle, lit and dark (glow is baked), and the piers' blinking signal lamps
  const lamps = (lit: boolean) => {
    const l = partB();
    for (const sx of [-1, 1])
      for (let i = 0; i < 7; i++) {
        l.box(0.07, 0.015, 0.11, [sx * 0.92, 0.16, -1.2 + i * 0.4], BRASS);
        l.box(0.05, 0.025, 0.08, [sx * 0.92, 0.175, -1.2 + i * 0.4], lit ? AMBER : 0x3a3020, lit ? { glow: 1 } : {});
      }
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

export const BUILDINGS: Partial<Record<BuildingKind, (t: Team) => ModelDef>> = {
  hq,
  "fab-plant": fabPlant,
  airpad,
  "tech-lab": techLab,
  depot,
  turret,
  "sam-site": samSite,
  radar,
  "assembly-bay": assemblyBay,
  gantry
};

// --------------------------------------------------------- objectives ---

/**
 * The uplink: a wireless telegraph relay. A round stone pad ringed in brass
 * and iron, a telegraph hut with a slate cone roof; the turret is its mast
 * and the spinning antenna frame (a loop on a cross-arm, its spark ball on top).
 */
function uplink(): ModelDef {
  const b = siteB();
  b.drum(1.06, 1.0, 0.14, 28, [0, 0.07, 0], STONE_D, { bevel: 0.03 });
  b.cyl(0.9, 0.9, 0.03, 28, [0, 0.155, 0], STONE);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.box(0.32, 0.05, 0.11, [Math.cos(a) * 0.95, 0.15, Math.sin(a) * 0.95], i % 2 ? BRASS : IRON, { rot: [0, -a - Math.PI / 2, 0] });
  }
  b.drum(0.4, 0.34, 0.26, 8, [0, 0.3, 0], STONE_L, { rot: [0, Math.PI / 8, 0], bevel: 0.02 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    b.box(0.08, 0.1, 0.02, [Math.sin(a) * 0.36, 0.3, Math.cos(a) * 0.36], PANE, { rot: [0, a, 0], glow: 0.7 });
  }
  b.cone(0.42, 0.06, 8, [0, 0.46, 0], SLATE, { rot: [0, Math.PI / 8, 0] });
  b.torus(0.37, 0.015, [0, 0.43, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 16 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    light(b, [Math.cos(a) * 0.7, 0.18, Math.sin(a) * 0.7], 0.06);
  }
  const hull = b.build();
  const h = partB();
  h.drum(0.1, 0.08, 0.06, 8, [0, 0.03, 0], BRASS, { bevel: 0.012 });
  h.cyl(0.025, 0.04, 0.82, 6, [0, 0.41, 0], IRON);
  // the antenna frame: a cross-arm and a tall wire loop, insulators at its corners
  h.block(0.96, 0.04, 0.07, [0, 0.38, 0], HAZ_GOLD, { bevel: 0.012, edge: 1.35 });
  for (const sx of [-1, 1]) {
    h.box(0.016, 0.52, 0.016, [sx * 0.46, 0.6, 0], IRON);
    h.cyl(0.024, 0.024, 0.05, 6, [sx * 0.46, 0.42, 0], STONE_L);
    h.cyl(0.024, 0.024, 0.05, 6, [sx * 0.46, 0.84, 0], STONE_L);
    rod(h, [sx * 0.46, 0.86, 0], [0, 0.82, 0], 0.008, IRON);
    rod(h, [sx * 0.46, 0.4, 0], [0, 0.82, 0], 0.005, 0x5a4a38);
  }
  h.box(0.9, 0.014, 0.014, [0, 0.86, 0], IRON);
  h.sphere(0.05, [0, 0.88, 0], BRASS, { w: 8, h: 5 });
  h.sphere(0.035, [0, 0.95, 0], SPARK, { glow: 1, w: 6, h: 4 });
  return { hull, turret: h.build(), mount: [0, 0.46, 0], muzzle: [0, 0.8, 0], rotors: [], height: 1.4 };
}

/** A wooden supply crate: planked sides, brass corner guards and lid battens crossed so it reads from above, a brass lamp. */
function crate(): ModelDef {
  const b = siteB();
  b.block(0.5, 0.36, 0.5, [0, 0.19, 0], WOOD, { bevel: 0.02 });
  for (const y of [0.1, 0.19, 0.28]) {
    b.box(0.505, 0.008, 0.505, [0, y, 0], WOOD_D);
  }
  for (const x of [-0.24, 0.24]) for (const z of [-0.24, 0.24]) b.box(0.06, 0.38, 0.06, [x, 0.19, z], BRASS);
  for (const y of [0.02, 0.36]) {
    b.pair(0.03, 0.04, 0.52, [0.245, y, 0], BRASS);
    b.box(0.52, 0.04, 0.03, [0, y, 0.245], BRASS);
    b.box(0.52, 0.04, 0.03, [0, y, -0.245], BRASS);
  }
  b.block(0.5, 0.04, 0.5, [0, 0.39, 0], WOOD_D, { bevel: 0.012 });
  b.box(0.62, 0.014, 0.08, [0, 0.414, 0], 0xb98a50, { rot: [0, Math.PI / 4, 0] });
  b.box(0.62, 0.014, 0.08, [0, 0.414, 0], 0xb98a50, { rot: [0, -Math.PI / 4, 0] });
  for (const x of [-0.22, 0.22]) for (const z of [-0.22, 0.22]) b.box(0.08, 0.02, 0.08, [x, 0.418, z], BRASS);
  b.cyl(0.045, 0.055, 0.04, 6, [0, 0.43, 0], BRASS);
  b.cyl(0.03, 0.03, 0.03, 6, [0, 0.46, 0], AMBER, { glow: 1 });
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 0.5 };
}

/** The Obus-capsule (a Méliès moon shell) planted nose-down: riveted brass, a team band, lit portholes, a team base plate on top. */
function pod(t: Team): ModelDef {
  const b = partB();
  b.sphere(0.2, [0, 0.28, 0], BRASS, { w: 10, h: 5, phi: Math.PI / 2, rot: [Math.PI, 0, 0], scale: [1, 1.4, 1] });
  b.cyl(0.2, 0.2, 0.44, 10, [0, 0.5, 0], BRASS);
  for (const y of [0.3, 0.46, 0.7]) b.add(new THREE.CylinderGeometry(0.205, 0.205, 0.02, 10, 1, true), [0, y, 0], 0x9c7434);
  b.cyl(0.206, 0.206, 0.08, 10, [0, 0.58, 0], t.main);
  for (const a of [0, Math.PI]) {
    b.cyl(0.05, 0.05, 0.03, 8, [Math.sin(a) * 0.2, 0.44, Math.cos(a) * 0.2], 0x9c7434, { rot: [Math.PI / 2, a, 0] });
    b.cyl(0.035, 0.035, 0.035, 8, [Math.sin(a) * 0.2, 0.44, Math.cos(a) * 0.2], AMBER, { rot: [Math.PI / 2, a, 0], glow: 0.9 });
  }
  b.drum(0.21, 0.19, 0.06, 10, [0, 0.75, 0], IRON, { bevel: 0.015 });
  b.drum(0.13, 0.11, 0.03, 10, [0, 0.795, 0], t.main, { bevel: 0.01 });
  b.cyl(0.03, 0.03, 0.03, 6, [0, 0.82, 0], BRASS);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 0.8 };
}

/** The Obus-capsule burst open: the nose still planted, four riveted petals laid out round it, team bands on each, the base plate tossed aside. */
function podOpen(t: Team): ModelDef {
  const b = siteB();
  b.sphere(0.15, [0, 0.0, 0], BRASS, { w: 10, h: 4, phi: Math.PI / 2, scale: [1, 0.7, 1] });
  b.cyl(0.09, 0.09, 0.02, 8, [0, 0.1, 0], 0x1e1a16);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.26;
    const z = Math.sin(a) * 0.26;
    b.box(0.18, 0.03, 0.28, [x, 0.04, z], BRASS, { rot: [0, -a + Math.PI / 2, 0.12] });
    b.box(0.185, 0.035, 0.05, [x * 1.08, 0.05, z * 1.08], t.main, { rot: [0, -a + Math.PI / 2, 0.12] });
    b.box(0.185, 0.034, 0.015, [x * 0.8, 0.05, z * 0.8], 0x9c7434, { rot: [0, -a + Math.PI / 2, 0.12] });
  }
  b.drum(0.16, 0.14, 0.04, 10, [0.3, 0.05, -0.1], IRON, { rot: [0.3, 0, 0.2], bevel: 0.01 });
  b.drum(0.1, 0.08, 0.02, 10, [0.3, 0.08, -0.1], t.main, { rot: [0.3, 0, 0.2], bevel: 0.008 });
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.1, 0], rotors: [], height: 0.2 };
}

/** Map objectives and drop pods (uplink relay, supply crate, power pods). */
export const OBJECTIVES: { uplink?: () => ModelDef; crate?: () => ModelDef; pod?: (t: Team) => ModelDef; podOpen?: (t: Team) => ModelDef } = {
  uplink,
  crate,
  pod,
  podOpen
};
