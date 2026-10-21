import * as THREE from "three";
import type { UnitKind } from "../../../sim/types";
import { ModelBuilder, type Vec3 } from "../builder";
import {
  BRASS, CANVAS, CONDOR_BAY, EXHAUST, GM, GM_D, TRACK, WHITE, light, partB, rotorGeo, sided, strut, type ModelDef, type Team
} from "../models";

/**
 * Belle Époque aircraft (theme.ts): Scout → Patrie dirigible, Wasp → Éole,
 * Raptor → Blériot, Hornet → Albatros, Mender → Pasteur, Condor → Montgolfière.
 * Same contract as models.ts UNIT_MODELS (origin, -Z nose, rotors, muzzle...).
 * (models.ts imports this module: its palette is only read inside the builders.)
 */

/** Varnished wood, dark and light. */
const WOOD = 0x6b4628;
const WOOD_L = 0x9a6b3c;
/** A leather flying cap (pilots' heads). */
const LEATHER = 0x4a3020;

/**
 * A propeller or lifting screw of `n` blades, `r` long, about its own
 * origin: in the XY plane for axis "z" (tractor and pusher props), XZ for
 * "y" (horizontal rotors). Each blade is pitched a little, its tip painted
 * `tip` (the spinning disc then shows a ring of that colour), on a brass hub.
 */
function propGeo(r: number, n: number, axis: "y" | "z", hex = WOOD_L, tip?: number, width = 0.16): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const blade = (len: number, w: number, off: number, col: number) => {
      const g = new THREE.BoxGeometry(len, 0.007, w);
      g.rotateX(0.35);
      g.translate(off, 0, 0);
      g.rotateY(a);
      if (axis === "z") g.rotateX(Math.PI / 2);
      b.add(g, [0, 0, 0], col);
    };
    blade(tip === undefined ? r * 0.92 : r * 0.7, r * width, tip === undefined ? r * 0.5 : r * 0.39, hex);
    if (tip !== undefined) blade(r * 0.24, r * width * 1.08, r * 0.86, tip);
  }
  b.cyl(r * 0.16, r * 0.16, 0.026, 8, [0, 0, 0], BRASS, { rot: axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0] });
  return b.build();
}

/** A point turned about the Z axis by `a` (a wing's dihedral, hinged at the centreline). */
function rz([x, y, z]: Vec3, a: number): Vec3 {
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
}

/**
 * The Belle Époque Scout: a small observation dirigible. A varnished canvas
 * envelope ringed with brass, a team stripe along its back and team fins
 * (the top-down team patch), a wooden gondola slung below with gaslit
 * windows and a pusher propeller.
 */
export function dirigible(t: Team): ModelDef {
  const b = partB();
  const L = 0.25;
  const R = 0.1;
  b.sphere(R, [0, 0, 0], CANVAS, { w: 12, h: 8, scale: [1, 0.92, L / R] });
  // the team stripe along the back, and a brass nose cap
  b.sphere(R * 0.62, [0, 0.068, 0.005], t.main, { w: 10, h: 6, scale: [0.92, 0.55, (L / R) * 0.9] });
  b.sphere(0.022, [0, 0, -L + 0.004], BRASS, { w: 8, h: 6 });
  // brass rings around the envelope
  for (const z of [-0.16, -0.06, 0.04, 0.14]) {
    const r = R * Math.sqrt(1 - (z / L) ** 2) + 0.003;
    b.torus(r, 0.006, [0, 0, z], BRASS, { seg: 16, scale: [1, 0.92, 1] });
  }
  // tail fins: team top and sides, dark underneath
  b.box(0.008, 0.075, 0.08, [0, 0.07, 0.215], t.main);
  b.box(0.2, 0.008, 0.07, [0, 0, 0.22], t.main);
  b.box(0.008, 0.05, 0.07, [0, -0.06, 0.22], t.dark);
  // the gondola on four struts, gaslit windows, a brass engine and pusher propeller behind
  for (const x of [-0.025, 0.025])
    for (const z of [-0.05, 0.05]) strut(b, [x, -0.07, z], [x * 0.8, -0.11, z * 0.9], 0.004, GM_D);
  b.block(0.055, 0.035, 0.15, [0, -0.125, 0], 0x6b4628, { bevel: 0.01 });
  b.box(0.06, 0.006, 0.155, [0, -0.106, 0], BRASS);
  for (const z of [-0.045, 0, 0.045]) {
    light(b, [0.029, -0.125, z], 0.014);
    light(b, [-0.029, -0.125, z], 0.014);
  }
  b.cyl(0.018, 0.022, 0.04, 8, [0, -0.125, 0.09], BRASS, { rot: [Math.PI / 2, 0, 0] });
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.125, -0.09],
    rotors: [{ geo: rotorGeo(0.05, "z"), at: [0, -0.125, 0.115], axis: "z", speed: 30 }], height: 0.2
  };
}

/**
 * The Wasp → Ader's Éole (1890): a varnished wooden nacelle carrying a brass
 * steam engine (boiler, smokestack, glowing firebox), bat wings of canvas
 * stretched over dark ribs that fan out to scalloped fingers, their outer
 * panels in team colour (the top-down patch), a four-bladed tractor
 * propeller on the nose. Racks of little rockets under the wing roots.
 */
export function eole(t: Team): ModelDef {
  const b = partB();
  // the nacelle: a slim varnished hull, pointed behind (the Éole had no tail)
  b.fuselage([[-0.23, 0.026, 0.02, -0.03], [-0.17, 0.05, 0.04, -0.05], [0.0, 0.056, 0.046, -0.055], [0.14, 0.04, 0.034, -0.04], [0.27, 0.01, 0.012, -0.012]], [0, 0, 0], WOOD, { chamfer: 0.02, edge: 1.4 });
  b.box(0.114, 0.006, 0.02, [0, 0.0, -0.17], BRASS);
  // the steam engine: a brass boiler, a smokestack, the firebox glowing through its door
  b.tube(0.03, 0.12, 8, [0, 0.06, -0.07], BRASS);
  b.cyl(0.03, 0.03, 0.006, 8, [0, 0.06, -0.13], GM_D, { rot: [Math.PI / 2, 0, 0] });
  b.cyl(0.011, 0.013, 0.07, 6, [0, 0.11, -0.03], GM_D);
  b.cyl(0.016, 0.012, 0.012, 6, [0, 0.148, -0.03], BRASS);
  b.box(0.012, 0.016, 0.02, [0.03, 0.045, -0.035], EXHAUST, { glow: 1 });
  b.box(0.012, 0.016, 0.02, [-0.03, 0.045, -0.035], EXHAUST, { glow: 1 });
  // the pilot behind it in his open cockpit
  b.block(0.06, 0.012, 0.08, [0, 0.046, 0.06], GM_D, { bevel: 0.004 });
  b.sphere(0.02, [0, 0.062, 0.065], LEATHER, { w: 8, h: 5 });
  // the nose: a brass cone to the propeller shaft
  b.cone(0.03, 0.05, 8, [0, 0, -0.25], BRASS, { rot: [-Math.PI / 2, 0, 0] });
  // the bat wings, a touch of dihedral
  const LE: [number, number][] = [[0.04, -0.07], [0.12, -0.12], [0.24, -0.13], [0.36, -0.09], [0.45, -0.01]];
  const fingers: [number, number][] = [[0.45, -0.01], [0.4, 0.12], [0.28, 0.18], [0.14, 0.18]];
  const scallops: [number, number][] = [[0.38, 0.04], [0.31, 0.12], [0.2, 0.14], [0.09, 0.13]];
  const wing: [number, number][] = [...LE];
  for (let i = 1; i < fingers.length; i++) wing.push(scallops[i - 1]!, fingers[i]!);
  wing.push(scallops[3]!, [0.04, 0.12]);
  const outer: [number, number][] = [[0.19, -0.128], [0.24, -0.13], [0.36, -0.09], [0.45, -0.01], [0.38, 0.04], [0.4, 0.12], [0.31, 0.12], [0.28, 0.18], [0.215, 0.143], [0.2, 0.0]];
  const d = 0.1;
  for (const s of [1, -1]) {
    b.prism(sided(wing, s), 0.008, [0, 0.0, 0], CANVAS, { rot: [0, 0, s * d] });
    b.prism(sided(outer, s), 0.005, [0, 0.008, 0], t.main, { rot: [0, 0, s * d] });
    // the ribs: from the shoulder out to every finger, the leading-edge spar
    const root: Vec3 = rz([s * 0.04, 0.012, -0.03], s * d);
    for (const [x, z] of fingers.slice(1)) strut(b, root, rz([s * x, 0.012, z], s * d), 0.0045, GM_D);
    for (let i = 0; i + 1 < LE.length; i++)
      strut(b, rz([s * LE[i]![0], 0.012, LE[i]![1]], s * d), rz([s * LE[i + 1]![0], 0.012, LE[i + 1]![1]], s * d), 0.006, WOOD);
    strut(b, rz([s * 0.12, 0.012, -0.12], s * d), rz([s * 0.38, 0.012, 0.04], s * d), 0.0045, GM_D);
    light(b, rz([s * 0.45, 0.016, -0.01], s * d), 0.02);
    // a rack of three rockets under the wing root: ivory bodies, team warheads
    b.box(0.07, 0.01, 0.1, [s * 0.15, -0.022, -0.03], GM_D);
    for (const dx of [-0.024, 0, 0.024]) {
      const x = s * 0.15 + dx;
      b.tube(0.011, 0.12, 6, [x, -0.04, -0.02], WHITE);
      b.cone(0.011, 0.03, 6, [x, -0.04, -0.095], t.main, { rot: [-Math.PI / 2, 0, 0] });
      b.box(0.026, 0.003, 0.016, [x, -0.04, 0.035], BRASS);
    }
  }
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.04, -0.12],
    rotors: [{ geo: propGeo(0.12, 4, "z", WOOD_L, undefined, 0.2), at: [0, 0, -0.285], axis: "z", speed: 46 }], height: 0.16
  };
}

/**
 * The Raptor → a Blériot XI fighter: a slim fuselage, canvas-covered up front
 * and an open wooden truss behind (piano-wire bracing) out to a team rudder
 * and tailplane; a single wing with team outer panels braced from a cabane;
 * a brass Anzani fan engine and a two-bladed tractor propeller; a Hotchkiss
 * machine gun over the cowl.
 */
export function bleriot(t: Team): ModelDef {
  const b = partB();
  // the cowl and the covered front of the fuselage
  b.fuselage([[-0.39, 0.032, 0.03, -0.035], [-0.33, 0.044, 0.042, -0.05], [-0.28, 0.044, 0.042, -0.05]], [0, 0, 0], GM, { chamfer: 0.016, edge: 1.4 });
  b.fuselage([[-0.28, 0.044, 0.042, -0.05], [0.0, 0.04, 0.04, -0.045], [0.05, 0.036, 0.038, -0.042]], [0, 0, 0], CANVAS, { chamfer: 0.012, edge: 1.25 });
  // the Anzani: a brass crankcase, three cylinders fanned over the top
  b.cyl(0.032, 0.032, 0.03, 8, [0, 0, -0.395], BRASS, { rot: [Math.PI / 2, 0, 0] });
  for (const a of [-1.0, 0, 1.0]) b.cyl(0.011, 0.013, 0.05, 6, [Math.sin(a) * 0.045, Math.cos(a) * 0.045, -0.385], GM_D, { rot: [0, 0, -a] });
  // the open truss: four longerons to the tail post, struts and wire bracing between
  const tail = 0.46;
  const corner = (z: number, sx: number, top: boolean): Vec3 => {
    const k = (z - 0.05) / (tail - 0.05);
    const w = 0.036 * (1 - k) + 0.006 * k;
    return [sx * w, top ? 0.038 * (1 - k) + 0.026 * k : -0.042 * (1 - k) + 0.0 * k, z];
  };
  for (const sx of [1, -1])
    for (const top of [true, false]) strut(b, corner(0.05, sx, top), corner(tail, sx, top), 0.004, WOOD_L);
  for (const z of [0.15, 0.25, 0.35]) {
    for (const sx of [1, -1]) {
      strut(b, corner(z, sx, true), corner(z, sx, false), 0.003, WOOD_L);
      strut(b, corner(z - 0.1, sx, true), corner(z, sx, false), 0.0018, GM_D);
    }
    strut(b, corner(z, 1, true), corner(z, -1, true), 0.003, WOOD_L);
  }
  // tailplane and rudder in team colour
  for (const s of [1, -1]) b.prism(sided([[0.0, 0.37], [0.12, 0.38], [0.15, 0.42], [0.12, 0.465], [0.0, 0.47]], s), 0.008, [0, 0.016, 0], t.main);
  b.prism([[0, 0.39], [0.07, 0.4], [0.11, 0.44], [0.08, 0.5], [0, 0.5]], 0.008, [0.004, -0.03, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  // the wing: canvas inner bays, team outer panels, ribs over the top, a slight dihedral
  const d = 0.05;
  for (const s of [1, -1]) {
    b.prism(sided([[0.0, -0.25], [0.46, -0.25], [0.51, -0.22], [0.52, -0.12], [0.48, -0.07], [0.0, -0.07]], s), 0.012, [0, 0.03, 0], CANVAS, { rot: [0, 0, s * d] });
    b.prism(sided([[0.2, -0.247], [0.46, -0.247], [0.507, -0.218], [0.517, -0.122], [0.478, -0.073], [0.2, -0.073]], s), 0.005, [0, 0.042, 0], t.main, { rot: [0, 0, s * d] });
    for (const x of [0.08, 0.15, 0.27, 0.35, 0.43])
      b.box(0.005, 0.004, 0.17, rz([s * x, 0.0475, -0.16], s * d), x > 0.2 ? t.dark : WOOD_L, { rot: [0, 0, s * d] });
    // piano wires from the cabane and the undercarriage out to the wing
    const apex: Vec3 = [0, 0.13, -0.17];
    const keel: Vec3 = [0, -0.1, -0.2];
    for (const z of [-0.23, -0.1]) {
      strut(b, apex, rz([s * 0.3, 0.045, z], s * d), 0.0018, GM_D);
      strut(b, keel, rz([s * 0.3, 0.03, z], s * d), 0.0018, GM_D);
    }
    light(b, rz([s * 0.52, 0.04, -0.16], s * d), 0.018);
    // the cabane legs, the undercarriage legs and wheels
    strut(b, [s * 0.03, 0.04, -0.23], apex, 0.004, WOOD);
    strut(b, [s * 0.03, 0.04, -0.11], apex, 0.004, WOOD);
    strut(b, [s * 0.04, -0.045, -0.3], [s * 0.075, -0.12, -0.27], 0.005, GM_D);
    strut(b, [s * 0.04, -0.045, -0.2], [s * 0.075, -0.12, -0.27], 0.004, GM_D);
    b.cyl(0.035, 0.035, 0.012, 10, [s * 0.085, -0.12, -0.27], TRACK, { rot: [0, 0, Math.PI / 2] });
    b.cyl(0.012, 0.012, 0.016, 6, [s * 0.085, -0.12, -0.27], BRASS, { rot: [0, 0, Math.PI / 2] });
  }
  // the pilot, and the machine gun over the cowl: a receiver, a finned jacket, a long barrel
  b.sphere(0.022, [0, 0.06, 0.0], LEATHER, { w: 8, h: 5 });
  b.block(0.07, 0.008, 0.08, [0, 0.042, 0.0], GM_D, { bevel: 0.003 });
  b.block(0.03, 0.03, 0.07, [0, 0.07, -0.24], GM_D, { bevel: 0.006 });
  b.tube(0.012, 0.1, 8, [0, 0.072, -0.32], 0x4b3d30);
  for (const z of [-0.29, -0.31, -0.33, -0.35]) b.tube(0.015, 0.004, 8, [0, 0.072, z], BRASS);
  b.tube(0.005, 0.07, 6, [0, 0.072, -0.4], GM_D);
  strut(b, [0, 0.04, -0.27], [0, 0.06, -0.27], 0.004, GM_D);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.072, -0.44],
    rotors: [{ geo: propGeo(0.14, 2, "z", WOOD_L, undefined, 0.18), at: [0, 0, -0.42], axis: "z", speed: 60 }], height: 0.16
  };
}

/**
 * The Hornet → Robur's Albatros (Jules Verne): a long ship's hull of
 * varnished wood with a team-coloured deck under two rows of masts, each
 * topped by a lifting screw on a team hub (rotors, axis y, at staggered
 * heights so neighbours never cross), a screw propeller at bow and stern
 * (axis z), deckhouses with gaslit windows and racks of bombs underneath.
 */
export function albatros(t: Team): ModelDef {
  const b = partB();
  const top = 0.03;
  // the hull: a sharp bow, a rounded counter stern, an ivory waterline stripe, a brass keel
  b.fuselage([[-0.7, 0.008, top + 0.02, 0.0], [-0.6, 0.075, top + 0.008, -0.07], [-0.44, 0.13, top, -0.11], [0.34, 0.13, top, -0.11], [0.54, 0.095, top, -0.085], [0.64, 0.035, top, -0.045]], [0, 0, 0], WOOD, { chamfer: 0.02, belly: 0.05 });
  b.fuselage([[-0.66, 0.042, 0.0, -0.016], [-0.6, 0.079, 0.0, -0.016], [-0.44, 0.134, 0.0, -0.016], [0.34, 0.134, 0.0, -0.016], [0.54, 0.099, 0.0, -0.016], [0.63, 0.044, 0.0, -0.016]], [0, 0, 0], WHITE, { chamfer: 0.002 });
  b.box(0.012, 0.012, 1.1, [0, -0.115, -0.04], BRASS);
  // the team deck, planked
  b.fuselage([[-0.6, 0.05, top + 0.014, top], [-0.44, 0.115, top + 0.012, top], [0.34, 0.115, top + 0.012, top], [0.53, 0.08, top + 0.012, top], [0.6, 0.03, top + 0.012, top]], [0, 0, 0], t.main, { chamfer: 0.004, edge: 1.3 });
  for (const x of [-0.06, 0, 0.06]) b.box(0.003, 0.003, 0.84, [x, top + 0.014, -0.05], t.dark);
  // brass rails round the deck
  const rail: [number, number][] = [[0.0, -0.68], [0.07, -0.58], [0.122, -0.44], [0.122, 0.34], [0.088, 0.53], [0.03, 0.62]];
  for (const s of [1, -1])
    for (let i = 0; i + 1 < rail.length; i++) strut(b, [s * rail[i]![0], top + 0.04, rail[i]![1]], [s * rail[i + 1]![0], top + 0.04, rail[i + 1]![1]], 0.004, BRASS);
  for (const s of [1, -1]) for (const z of [-0.44, -0.2, 0.05, 0.3]) strut(b, [s * 0.122, top, z], [s * 0.122, top + 0.04, z], 0.003, BRASS);
  // deckhouses fore and aft: ivory walls, gaslit windows, dark roofs
  for (const [z, len] of [[-0.29, 0.1], [0.29, 0.12]] as [number, number][]) {
    b.block(0.1, 0.05, len, [0, top + 0.04, z], WHITE, { bevel: 0.006 });
    b.block(0.112, 0.012, len + 0.014, [0, top + 0.071, z], GM_D, { bevel: 0.004 });
    for (const dz of [-len / 4, len / 4]) {
      light(b, [0.051, top + 0.045, z + dz], 0.016);
      light(b, [-0.051, top + 0.045, z + dz], 0.016);
    }
  }
  // the masts: two rows, a brass collar at the deck and a team hub under each screw
  const lifts: Vec3[] = [];
  const zs = [-0.43, -0.145, 0.0 + 0.14, 0.43];
  for (const [si, s] of [[0, 1], [1, -1]] as [number, number][])
    zs.forEach((z, i) => {
      const x = s * 0.075;
      const h = (i + si) % 2 ? 0.22 : 0.3;
      b.cyl(0.008, 0.01, h - top, 6, [x, (h + top) / 2, z], WOOD);
      b.cyl(0.016, 0.016, 0.012, 8, [x, top + 0.02, z], BRASS);
      b.cyl(0.024, 0.02, 0.022, 8, [x, h - 0.014, z], t.main);
      lifts.push([x, h + 0.004, z]);
    });
  // bow and stern screws on their shafts, a lantern over each
  b.tube(0.008, 0.08, 6, [0, 0.01, -0.73], BRASS);
  b.tube(0.008, 0.08, 6, [0, 0.0, 0.67], BRASS);
  light(b, [0, top + 0.05, -0.62], 0.02);
  light(b, [0, top + 0.03, 0.6], 0.02);
  // bomb racks under the keel: iron bombs, team noses, brass fins
  for (const x of [-0.05, 0.05]) {
    b.box(0.012, 0.016, 0.5, [x, -0.112, -0.02], GM_D);
    for (const z of [-0.18, -0.02, 0.14]) {
      b.tube(0.022, 0.08, 8, [x, -0.14, z], GM_D);
      b.sphere(0.022, [x, -0.14, z - 0.04], t.main, { w: 6, h: 4 });
      b.box(0.05, 0.004, 0.016, [x, -0.14, z + 0.045], BRASS);
      b.box(0.004, 0.05, 0.016, [x, -0.14, z + 0.045], BRASS);
    }
  }
  const lift = propGeo(0.13, 3, "y", CANVAS, t.main, 0.22);
  const screw = propGeo(0.1, 4, "z", WOOD_L, undefined, 0.22);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.16, 0], height: 0.34,
    rotors: [
      ...lifts.map((at, i) => ({ geo: lift, at, axis: "y" as const, speed: (i % 2 ? -1 : 1) * (30 + (i % 3) * 4) })),
      { geo: screw, at: [0, 0.01, -0.775], axis: "z", speed: 36 },
      { geo: screw, at: [0, 0.0, 0.715], axis: "z", speed: -36 }
    ]
  };
}

/**
 * The Mender → the Pasteur: a little workshop balloon. A canvas sphere with a
 * team crown and girdle, an ivory gear-and-spanner emblem on its crown (read
 * from above), a brass load ring and rigging down to a wooden workshop
 * gondola, two jointed brass arms holding a spanner and a drill, a lamp
 * underneath and a small pusher propeller.
 */
export function pasteur(t: Team): ModelDef {
  const b = partB();
  const Y = 0.1;
  const R = 0.135;
  b.sphere(R, [0, Y, 0], CANVAS, { w: 14, h: 10 });
  b.sphere(R + 0.003, [0, Y, 0], t.main, { w: 14, h: 4, phi: 0.78 });
  b.torus(R + 0.002, 0.014, [0, Y, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 20 });
  for (const yy of [-0.08, 0.08]) {
    const r = Math.sqrt(R * R - yy * yy) + 0.002;
    b.torus(r, 0.005, [0, Y + yy, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 18 });
  }
  // the emblem on the crown: an ivory gear with a spanner across it, laid on the curve
  const on = (rr: number) => Y + Math.sqrt(R * R - rr * rr);
  b.torus(0.04, 0.009, [0, on(0.04) - 0.002, 0], WHITE, { rot: [Math.PI / 2, 0, 0], seg: 12 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(0.018, 0.012, 0.015, [Math.sin(a) * 0.053, on(0.053) - 0.002, Math.cos(a) * 0.053], WHITE, { rot: [-Math.cos(a) * 0.4, a, 0] });
  }
  b.box(0.015, 0.01, 0.1, [0, on(0) - 0.001, 0], WHITE, { rot: [0, Math.PI / 4, 0] });
  for (const k of [1, -1]) {
    const c = k * 0.058 * Math.SQRT1_2;
    b.torus(0.015, 0.006, [c, on(0.058), c], WHITE, { rot: [Math.PI / 2, 0, 0], seg: 8 });
  }
  // the load ring and the rigging down to the gondola
  const ring = Y - R - 0.01;
  b.torus(0.07, 0.006, [0, ring, 0], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 12 });
  const G = -0.17;
  for (const [x, z] of [[0.055, -0.065], [-0.055, -0.065], [0.055, 0.065], [-0.055, 0.065]] as [number, number][]) {
    strut(b, [x * 1.2, ring, z * 1.0], [x, G + 0.035, z], 0.0035, GM_D);
    strut(b, [x * 1.5, Y - 0.08, z * 1.5], [x * 1.2, ring, z], 0.003, GM_D);
  }
  // the gondola: a wooden workshop with a brass rim, team gear emblems on its sides
  b.block(0.15, 0.075, 0.17, [0, G, 0], WOOD, { bevel: 0.012 });
  b.box(0.158, 0.008, 0.178, [0, G + 0.034, 0], BRASS);
  for (const s of [1, -1]) {
    b.torus(0.02, 0.007, [s * 0.077, G, -0.02], t.main, { rot: [0, Math.PI / 2, 0], seg: 10 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.box(0.006, 0.01, 0.01, [s * 0.077, G + Math.sin(a) * 0.029, -0.02 + Math.cos(a) * 0.029], t.main, { rot: [a, 0, 0] });
    }
    light(b, [s * 0.076, G + 0.005, 0.045], 0.016);
  }
  // the work lamp underneath
  b.cyl(0.02, 0.03, 0.02, 8, [0, G - 0.045, 0], BRASS);
  b.cyl(0.025, 0.025, 0.006, 8, [0, G - 0.057, 0], 0xffd27a, { glow: 1 });
  // two jointed brass arms reaching out past the balloon and down: a spanner, a drill
  for (const s of [1, -1]) {
    const sh: Vec3 = [s * 0.075, G + 0.01, -0.04];
    const el: Vec3 = [s * 0.17, G + 0.03, -0.09];
    const wr: Vec3 = [s * 0.19, G - 0.03, -0.15];
    b.sphere(0.014, sh, BRASS, { w: 6, h: 4 });
    strut(b, sh, el, 0.008, BRASS);
    strut(b, el, wr, 0.007, BRASS);
    b.sphere(0.013, el, GM_D, { w: 6, h: 4 });
    b.sphere(0.011, wr, GM_D, { w: 6, h: 4 });
    if (s > 0) {
      // an open-jawed spanner
      b.box(0.014, 0.012, 0.045, [wr[0], wr[1], wr[2] - 0.03], WHITE);
      for (const dx of [-0.013, 0.013]) b.box(0.008, 0.012, 0.026, [wr[0] + dx, wr[1], wr[2] - 0.062], WHITE);
      b.box(0.034, 0.012, 0.008, [wr[0], wr[1], wr[2] - 0.05], WHITE);
    } else {
      b.cyl(0.016, 0.016, 0.02, 8, [wr[0], wr[1], wr[2] - 0.016], GM_D, { rot: [Math.PI / 2, 0, 0] });
      b.cone(0.012, 0.05, 6, [wr[0], wr[1], wr[2] - 0.05], WHITE, { rot: [-Math.PI / 2, 0, 0] });
    }
  }
  // the little engine and pusher propeller behind
  b.tube(0.022, 0.05, 8, [0, G, 0.105], BRASS);
  b.cyl(0.01, 0.012, 0.04, 6, [0, G + 0.05, 0.05], GM_D);
  return {
    hull: b.build(), mount: [0, 0, 0], muzzle: [0, G - 0.03, -0.2], height: 0.28,
    rotors: [{ geo: propGeo(0.065, 4, "z", WOOD_L, t.main, 0.24), at: [0, G, 0.138], axis: "z", speed: 40 }]
  };
}

/**
 * The Condor → the Montgolfière: a troop barge under a great decorated hot-air
 * balloon. The long wooden boat is the open troop bay (CONDOR_BAY: deck,
 * benches, team gunwales, the stern ramp as gangway); the balloon rides over
 * the foredeck, clear of the bay so its riders show, its gores alternating
 * team colour and ivory under gilt garlands, a brazier glowing under its
 * mouth. Outriggers carry two tractor propellers; a team rudder over the stern.
 */
export function montgolfiere(t: Team): ModelDef {
  const b = partB();
  const B = CONDOR_BAY;
  const W0 = 0.205;
  const W1 = 0.21;
  const W2 = 0.2;
  const W3 = 0.17;
  // the boat: a raised foredeck to a sharp bow, the bay's tub behind it, an ivory stripe round both
  b.fuselage([[-0.82, 0.012, 0.075, 0.03], [-0.77, 0.07, 0.05, -0.08], [-0.67, 0.14, 0.025, -0.14], [-0.52, 0.19, 0.01, -0.175], [B.z0 + 0.01, W0, 0.0, -0.185]], [0, 0, 0], WOOD, { chamfer: 0.025, belly: 0.05 });
  b.fuselage([[B.z0 - 0.01, W0, B.floor, -0.185], [-0.1, W1, B.floor, -0.185], [B.z1, W2, B.floor, -0.18], [B.ramp - 0.05, W3, B.floor, -0.165], [B.ramp, B.rampW / 2 + 0.012, B.floor, -0.15]], [0, 0, 0], WOOD, { chamfer: 0.025, belly: 0.05 });
  // (the stripe is solid round the foredeck, a band round the bay's walls: the bay stays open)
  b.fuselage([[-0.77, 0.074, -0.03, -0.048], [-0.67, 0.144, -0.03, -0.048], [-0.52, 0.194, -0.03, -0.048], [B.z0, W0 + 0.004, -0.03, -0.048]], [0, 0, 0], WHITE, { chamfer: 0.003 });
  for (const sx of [-1, 1]) {
    const band: [number, number][] = [[W0 - 0.01, B.z0], [W0 + 0.004, B.z0], [W1 + 0.004, -0.1], [W2 + 0.004, B.z1], [W3 + 0.004, B.ramp - 0.05], [B.rampW / 2 + 0.016, B.ramp], [B.rampW / 2 + 0.004, B.ramp], [W3 - 0.008, B.ramp - 0.05], [W2 - 0.01, B.z1], [W1 - 0.01, -0.1]];
    b.prism(sided(band, sx), 0.018, [0, -0.048, 0], WHITE);
  }
  b.box(0.014, 0.014, 0.85, [0, -0.185, -0.125], BRASS);
  // the foredeck: planks, a team chevron at the bow, a gilt figurehead and lantern
  b.fuselage([[-0.76, 0.05, 0.062, 0.05], [-0.67, 0.125, 0.04, 0.025], [-0.52, 0.178, 0.022, 0.005], [B.z0 + 0.01, 0.193, 0.012, 0.0]], [0, 0, 0], WOOD_L, { chamfer: 0.004, edge: 1.2 });
  for (const sx of [-1, 1]) b.prism([[0, -0.78], [sx * 0.07, -0.69], [sx * 0.07, -0.66], [0, -0.74]], 0.008, [0, 0.058, 0], t.main, { rot: [-0.18, 0, 0] });
  b.cone(0.016, 0.09, 6, [0, 0.07, -0.85], BRASS, { rot: [-Math.PI / 2 - 0.3, 0, 0] });
  light(b, [0, 0.09, -0.79], 0.022);
  // the bay: a planked deck with aisle lamps, benches down both walls, team gunwales
  const zr = (B.z0 + B.ramp) / 2;
  const zc = (B.z0 + B.z1) / 2;
  const iw = B.w / 2;
  b.box(B.w, 0.012, B.ramp - B.z0, [0, B.floor + 0.004, zr], WOOD_L);
  for (const x of [-0.11, -0.055, 0.055, 0.11]) b.box(0.003, 0.003, B.ramp - B.z0, [x, B.floor + 0.011, zr], WOOD);
  for (let z = B.z0 + 0.05; z < B.ramp - 0.03; z += 0.075) b.box(0.012, 0.004, 0.035, [0, B.floor + 0.012, z], 0xffc561, { glow: 0.8 });
  for (const sx of [-1, 1]) {
    const wall: [number, number][] = [[iw, B.z0], [W0, B.z0], [W1, -0.1], [W2, B.z1], [W3, B.ramp - 0.05], [B.rampW / 2 + 0.012, B.ramp], [B.rampW / 2, B.ramp], [iw, B.z1 - 0.02]];
    b.prism(wall.map(([x, z]) => [sx * x, z]), B.wall - B.floor, [0, B.floor, 0], WOOD);
    const rim: [number, number][] = [[iw - 0.003, B.z0 - 0.01], [W0 + 0.006, B.z0 - 0.01], [W1 + 0.006, -0.1], [W2 + 0.005, B.z1], [W3 + 0.005, B.ramp - 0.05], [B.rampW / 2 + 0.016, B.ramp + 0.006], [B.rampW / 2 - 0.004, B.ramp + 0.006], [iw - 0.003, B.z1 - 0.02]];
    b.prism(rim.map(([x, z]) => [sx * x, z]), 0.016, [0, B.wall - 0.002, 0], t.main);
    b.box(0.034, B.bench - B.floor, B.z1 - B.z0 - 0.02, [sx * (iw - 0.017), (B.bench + B.floor) / 2, zc], WOOD_L);
    for (const z of [B.z0 + 0.05, zc, B.z1 - 0.04]) light(b, [sx * (iw - 0.004), B.wall - 0.02, z], 0.014);
  }
  // the stern: two posts either side of the ramp, a crossbeam, a boom out to the team rudder
  const px = B.rampW / 2 + 0.012;
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.2, 0.02, [sx * px, 0.0, B.ramp + 0.005], WOOD);
    light(b, [sx * px, 0.11, B.ramp + 0.005], 0.018);
  }
  b.box(2 * px + 0.02, 0.018, 0.02, [0, 0.09, B.ramp + 0.005], WOOD);
  b.box(0.014, 0.014, 0.2, [0, 0.09, B.ramp + 0.1], WOOD);
  b.prism([[-0.03, 0.4], [0.11, 0.42], [0.16, 0.48], [0.12, 0.55], [-0.03, 0.55]], 0.012, [0.006, 0.07, 0], t.main, { rot: [0, 0, Math.PI / 2] });
  // the brazier under the balloon's mouth
  const BZ = -0.55;
  b.drum(0.055, 0.05, 0.05, 8, [0, 0.035, BZ], BRASS, { bevel: 0.008 });
  b.sphere(0.04, [0, 0.06, BZ], EXHAUST, { glow: 1, w: 8, h: 4, scale: [1, 0.6, 1] });
  // the helm on the foredeck, facing aft over the bay
  b.torus(0.03, 0.005, [0, 0.07, B.z0 + 0.04], WOOD_L, { seg: 10 });
  b.box(0.008, 0.06, 0.008, [0, 0.035, B.z0 + 0.045], WOOD);
  // the balloon: sixteen gores, team and ivory by turns, gilt garlands and crown
  const prof: [number, number][] = [[0.075, 0.16], [0.13, 0.21], [0.2, 0.28], [0.255, 0.37], [0.275, 0.45], [0.265, 0.53], [0.22, 0.6], [0.14, 0.655], [0.0, 0.68]];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, y));
  const N = 16;
  for (let i = 0; i < N; i++)
    b.add(new THREE.LatheGeometry(pts, 2, (i / N) * Math.PI * 2, (Math.PI * 2) / N), [0, 0, BZ], i % 2 ? WHITE : t.main);
  for (const [r, y, w] of [[0.277, 0.45, 0.012], [0.205, 0.285, 0.008], [0.14, 0.655, 0.009]] as [number, number, number][])
    b.torus(r + 0.002, w, [0, y, BZ], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 24 });
  b.sphere(0.035, [0, 0.68, BZ], BRASS, { w: 8, h: 5 });
  b.cone(0.012, 0.05, 6, [0, 0.72, BZ], BRASS);
  // the skirt at its mouth and the rigging down to the gunwales
  b.cyl(0.078, 0.072, 0.05, 12, [0, 0.14, BZ], CANVAS);
  b.torus(0.075, 0.007, [0, 0.115, BZ], BRASS, { rot: [Math.PI / 2, 0, 0], seg: 12 });
  for (const sx of [-1, 1]) {
    for (const [x, z] of [[0.1, -0.73], [0.19, -0.47], [0.2, B.z0 + 0.01]] as [number, number][]) {
      strut(b, [sx * 0.07, 0.115, BZ + (z - BZ) * 0.25], [sx * x, 0.02, z], 0.003, GM_D);
      strut(b, [sx * 0.245, 0.34, BZ + (z - BZ) * 0.6], [sx * x, 0.02, z], 0.0025, GM_D);
    }
  }
  // outriggers out to the engines: brass pods, four-bladed tractor screws
  const props: Vec3[] = [];
  const ez = -0.12;
  for (const sx of [-1, 1]) {
    const x = sx * 0.37;
    strut(b, [sx * 0.2, -0.06, ez - 0.06], [x, -0.06, ez], 0.009, WOOD);
    strut(b, [sx * 0.2, -0.06, ez + 0.08], [x, -0.06, ez + 0.02], 0.009, WOOD);
    strut(b, [sx * 0.2, 0.0, ez], [x, -0.04, ez], 0.003, GM_D);
    b.tube(0.035, 0.14, 8, [x, -0.06, ez + 0.02], BRASS);
    b.tube(0.037, 0.03, 8, [x, -0.06, ez + 0.06], t.main);
    b.cone(0.03, 0.04, 8, [x, -0.06, ez - 0.07], GM_D, { rot: [-Math.PI / 2, 0, 0] });
    b.cyl(0.008, 0.008, 0.05, 6, [x, -0.02, ez + 0.05], GM_D);
    light(b, [x + sx * 0.038, -0.06, ez], 0.018);
    props.push([x, -0.06, ez - 0.095]);
  }
  const hull = b.build();
  // the ramp: a gangway hinged at the deck's stern edge; closed it stands up between the stern
  // posts (team panel and brass trim outside), dropped its cleated planks face up, lamps at its lip
  const L = B.wall + 0.02 - B.floor;
  const rw = B.rampW;
  const r = partB();
  r.box(rw - 0.004, L, 0.02, [0, L / 2, 0], WOOD_L);
  r.box(rw - 0.05, L * 0.7, 0.004, [0, L * 0.5, 0.011], t.main);
  r.box(rw - 0.004, 0.01, 0.006, [0, L - 0.005, 0.011], BRASS);
  for (let i = 0; i < 4; i++) r.box(rw - 0.06, 0.006, 0.008, [0, 0.02 + i * 0.026, -0.013], WOOD);
  for (const sx of [-1, 1]) r.box(0.01, L, 0.012, [sx * (rw / 2 - 0.01), L / 2, -0.012], BRASS);
  light(r, [rw / 2 - 0.02, L - 0.008, -0.012], 0.02);
  light(r, [-rw / 2 + 0.02, L - 0.008, -0.012], 0.02);
  const prop = propGeo(0.1, 4, "z", WOOD_L, undefined, 0.22);
  return {
    hull, mount: [0, 0, 0], muzzle: [0, -0.1, 0], height: 0.72,
    rotors: props.map((at, i) => ({ geo: prop, at, axis: "z" as const, speed: i ? -40 : 40 })),
    ramp: { geo: r.build(), hinge: [0, B.floor, B.ramp], open: 1.85, tip: [0, L, 0] }
  };
}

export const AIR: Partial<Record<UnitKind, (t: Team) => ModelDef>> = {
  scout: dirigible,
  wasp: eole,
  raptor: bleriot,
  hornet: albatros,
  mender: pasteur,
  condor: montgolfiere
};
