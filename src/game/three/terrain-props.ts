import * as THREE from "three";
import type { Biome } from "../../sim/types";
import { ModelBuilder, type Vec3 } from "./builder";
import { BELLE_EPOQUE } from "./theme";

/**
 * Prop geometry for the battlefield: trees per biome, rock crags and loose
 * boulders, scrap heaps and crystal clusters. Trees, scrap and crystals are
 * a few shared variants (instanced by the terrain); crags are one-off
 * shapes merged into a single mesh, each coloured from the painted rock it
 * stands on so outcrops read as part of the hand-painted landscape.
 */

/** Seeded PRNG (Park–Miller). */
export function prng(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed) % 2147483647);
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Deterministic hash → [0, 1). */
export const hash = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// ------------------------------------------------------------- crags --

export interface CragSpot {
  x: number;
  y: number;
  /** Ground height to sit on (the lowest point under its footprint). */
  h: number;
  /** Footprint radius (tiles). */
  s: number;
  rot: number;
  /** Linear colour of the painted rock (or ground) beneath. */
  tint: THREE.Color;
  /** 0 crag, 1 slab, 2 spire, 3 loose boulder. */
  kind: number;
  seed: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Vector3();
const _off = new THREE.Vector3();
const TRI = [_a, _b, _c];
const UP = new THREE.Vector3(0, 1, 0);

/** Hash of a lattice position → [-1, 1): shared corners jitter together, so facets never crack. */
function jitterAt(x: number, y: number, z: number, seed: number): number {
  const k = Math.sin(Math.round(x * 1000) * 12.9898 + Math.round(y * 1000) * 78.233 + Math.round(z * 1000) * 37.719 + seed * 4.1) * 43758.5453;
  return (k - Math.floor(k)) * 2 - 1;
}

/**
 * One rock: a jittered icosphere squashed and cut by a tilted plane, so it
 * reads as broken stone with a weathered flat top rather than a pebble.
 * Unit footprint, base at y = 0. Returns non-indexed positions.
 */
function rockShape(rnd: () => number, sx: number, sy: number, sz: number, cut: number, seed: number, detail = 0): Float32Array {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position!.array as Float32Array;
  const tx = (rnd() - 0.5) * 0.5;
  const tz = (rnd() - 0.5) * 0.5;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    const j = 1 + jitterAt(x, y, z, seed) * 0.3;
    let nx = x * j * sx;
    let ny = (y * j * 0.5 + 0.5) * sy;
    let nz = z * j * sz;
    // a tilted cleavage plane shears the top flat
    const top = cut * sy + tx * nx + tz * nz;
    if (ny > top) ny = top + (ny - top) * 0.12;
    if (ny < 0) ny *= 0.3;
    // and the sides lean in a little toward the top
    const lean = 1 - Math.max(0, ny / sy) * 0.18;
    nx *= lean;
    nz *= lean;
    p[i] = nx;
    p[i + 1] = ny;
    p[i + 2] = nz;
  }
  const out = new Float32Array(p);
  g.dispose();
  return out;
}

/**
 * Merge every crag into one vertex-coloured mesh geometry (one draw call). `textured`: for the
 * rock-textured crag material (the texture brings its own strata; no glow attribute), else for
 * the model material.
 */
export function cragGeometry(spots: CragSpot[], biome: Biome, textured = false): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const col: number[] = [];
  const snow = biome === "arctic";
  const strata = textured ? 0 : biome === "desert" ? 0.13 : biome === "volcanic" ? 0.2 : 0;
  const base = new THREE.Color();
  const grey = new THREE.Color();
  const snowCol = new THREE.Color(0.7, 0.77, 0.88);
  const c = new THREE.Color();
  // (on the arctic ridges the painted rock is near black under snow streaks: the crags are a grey stone,
  // lighter than the paint so their shape reads, but dark enough under the bright arctic light that
  // their frosted caps read too, rather than the whole crag going white)
  const minL = biome === "volcanic" ? 0.05 : snow ? 0.07 : 0.12;
  // (pale limestone karst on the reef would grey out under the usual cap)
  const maxL = snow ? 0.1 : biome === "tropical" ? 0.42 : 0.3;
  // karst towers wear a cap of jungle where arctic crags wear snow
  const jungle = biome === "tropical";
  const jungleCol = new THREE.Color(0x3a7a3a);
  const hsl = { h: 0, s: 0, l: 0 };
  for (const sp of spots) {
    const rnd = prng(sp.seed * 7919 + 17);
    // parts: [scale x, y, z, cleavage height (of y), offset x, z]
    const parts: [number, number, number, number, number, number][] = [];
    if (sp.kind === 0) {
      parts.push([0.62, 0.95 + rnd() * 0.35, 0.52, 0.72, 0, 0]);
      parts.push([0.36, 0.6 + rnd() * 0.25, 0.32, 0.8, 0.42, 0.2 - rnd() * 0.4]);
      if (rnd() < 0.6) parts.push([0.26, 0.42, 0.24, 0.85, -0.38, 0.28]);
    } else if (sp.kind === 1) {
      parts.push([0.75, 0.42 + rnd() * 0.15, 0.6, 0.62, 0, 0]);
      parts.push([0.32, 0.3, 0.28, 0.8, -0.5, 0.35]);
    } else if (sp.kind === 2) {
      parts.push([0.34, 1.35 + rnd() * 0.4, 0.3, 0.86, 0, 0]);
      parts.push([0.42, 0.55, 0.36, 0.7, 0.26, 0.24]);
    } else parts.push([0.55, 0.5 + rnd() * 0.25, 0.48, 0.7, 0, 0]);
    // colour: the painted tint's hue, lifted toward the painted rock's lit faces (the paint's
    // average sits between its sunlit stone and black crevices; the crag shades itself)
    base.copy(sp.tint);
    base.getHSL(hsl);
    base.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(maxL, Math.max(minL, hsl.l * 1.7)));
    const l = base.r * 0.3 + base.g * 0.6 + base.b * 0.1;
    grey.setRGB(l * 1.3, l * 1.3, l * 1.3);
    for (const [sx, sy, sz, cut, ox, oz] of parts) {
      const p = rockShape(rnd, sx, sy, sz, cut, sp.seed + ox * 31 + oz * 17);
      const top = sy * cut;
      _q.setFromAxisAngle(UP, sp.rot);
      _m.compose(_v.set(sp.x, sp.h, sp.y), _q, _a.set(sp.s, sp.s, sp.s));
      _off.set(ox, 0, oz);
      for (let i = 0; i < p.length; i += 9) {
        // face normal (local) for snow and shading
        _a.set(p[i]!, p[i + 1]!, p[i + 2]!);
        _b.set(p[i + 3]!, p[i + 4]!, p[i + 5]!);
        _c.set(p[i + 6]!, p[i + 7]!, p[i + 8]!);
        _n.subVectors(_c, _b).cross(_e.subVectors(_a, _b)).normalize();
        const fy = (_a.y + _b.y + _c.y) / 3;
        const k = Math.min(1, Math.max(0, fy / Math.max(0.01, top)));
        // dark at the foot (contact shadow), lighter toward the weathered top, and each facet a little different
        const facet = 0.9 + rnd() * 0.2;
        let shade = (0.45 + 0.85 * Math.pow(k, 0.9)) * facet;
        if (strata > 0) shade *= 0.93 + 0.07 * Math.sign(Math.sin((sp.h + fy * sp.s) / strata * Math.PI));
        c.copy(base).multiplyScalar(shade);
        // snow lies only on the flat of the cap, a dusting that thickens toward the top
        if (snow && _n.y > 0.72 && k > 0.6) c.lerp(snowCol, Math.min(0.42, 0.18 + (k - 0.6) * 0.7) * facet);
        else if (jungle && _n.y > 0.72 && k > 0.6) c.lerp(jungleCol, Math.min(0.55, 0.25 + (k - 0.6) * 0.9) * facet);
        else if (_n.y > 0.75 && k > 0.6) c.lerp(grey, 0.12);
        for (const v of TRI) {
          v.add(_off).applyMatrix4(_m);
          pos.push(v.x, v.y, v.z);
          col.push(c.r, c.g, c.b);
        }
      }
    }
  }
  if (pos.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  if (!textured) g.setAttribute("glow", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------- trees --

export function treeGeos(biome: Biome): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const ico = (r: number, at: Vec3, col: number, b: ModelBuilder, sc: Vec3 = [1, 1, 1]) =>
    b.add(new THREE.IcosahedronGeometry(r, 0), at, col, { scale: sc, rot: [at[0] * 3, at[2] * 5, 0] });
  for (let v = 0; v < 6; v++) {
    const b = new ModelBuilder();
    const k = v / 5;
    if (biome === "temperate") {
      if (v % 3 === 2) {
        b.cyl(0.04, 0.06, 0.3, 5, [0, 0.15, 0], 0x4a3626);
        for (let i = 0; i < 3; i++) b.cone(0.32 - i * 0.07, 0.4, 7, [0, 0.38 + i * 0.22, 0], [0x2c5430, 0x335e34, 0x3b6a3a][i]!);
      } else {
        b.cyl(0.04, 0.06, 0.42, 5, [0, 0.21, 0], 0x5a4030);
        ico(0.32, [0, 0.6, 0], [0x3f6a2a, 0x4a7a30, 0x5a8434][v % 3]!, b, [1, 0.85, 1]);
        ico(0.22, [0.15, 0.72, 0.08], 0x5a8a34, b);
        ico(0.2, [-0.14, 0.52, -0.1], 0x36602a, b);
      }
    } else if (biome === "arctic") {
      b.cyl(0.04, 0.06, 0.3, 5, [0, 0.15, 0], 0x3e3228);
      for (let i = 0; i < 3; i++) {
        const y = 0.36 + i * 0.22;
        const r = 0.32 - i * 0.075;
        b.cone(r, 0.38, 7, [0, y, 0], [0x24402f, 0x2a4836, 0x30503c][i]!);
        b.cone(r * 0.82, 0.2, 7, [0, y + 0.1, 0], 0xeef4ff);
      }
    } else if (biome === "desert") {
      if (v % 2 === 0) {
        let x = 0;
        let y = 0;
        for (let i = 0; i < 4; i++) {
          b.cyl(0.04, 0.05, 0.24, 5, [x, y + 0.12, 0], 0x8a6a48, { rot: [0, 0, -0.12 - i * 0.04] });
          x += 0.025 + i * 0.012;
          y += 0.23;
        }
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          b.box(0.42, 0.012, 0.09, [x + Math.cos(a) * 0.18, y + 0.02, Math.sin(a) * 0.18], [0x5f8a32, 0x6f9a3a][i % 2]!, {
            rot: [0, -a, -0.45]
          });
        }
        b.sphere(0.05, [x, y + 0.03, 0], 0x6a4a2a, { w: 5, h: 4 });
      } else {
        ico(0.24, [0, 0.18, 0], 0x6b8a3a, b, [1.2, 0.7, 1.1]);
        ico(0.16, [0.18, 0.14, 0.1], 0x7c9a44, b, [1, 0.7, 1]);
      }
    } else if (biome === "tropical") {
      if (v === 0 || v === 3) {
        // coconut palm: a trunk curving up in an arc, a crown of arching fronds, coconuts under it
        const lean = v === 0 ? 1 : -1;
        const tall = v === 3 ? 1.15 : 1;
        let x = 0;
        let y = 0;
        for (let i = 0; i < 5; i++) {
          b.cyl(0.035, 0.045, 0.2 * tall, 5, [x, y + 0.1 * tall, 0], 0x8a7458, { rot: [0, 0, lean * (-0.15 - i * 0.08)] });
          x += lean * (0.02 + i * 0.016);
          y += 0.19 * tall;
        }
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + v;
          const col = [0x3f8f3a, 0x58a83e][i % 2]!;
          b.box(0.22, 0.012, 0.08, [x + Math.cos(a) * 0.1, y + 0.04, Math.sin(a) * 0.1], col, { rot: [0, -a, 0.25] });
          b.box(0.24, 0.012, 0.07, [x + Math.cos(a) * 0.3, y - 0.03, Math.sin(a) * 0.3], col, { rot: [0, -a, -0.9] });
        }
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          b.sphere(0.04, [x + Math.cos(a) * 0.05, y - 0.03, Math.sin(a) * 0.05], 0x6a5a2a, { w: 5, h: 4 });
        }
      } else if (v === 1 || v === 4) {
        // rainforest emergent: a slim pale trunk with a flared foot under a flat umbrella crown
        b.cyl(0.035, 0.06, 0.62, 5, [0, 0.31, 0], 0x9a8a72);
        b.cone(0.11, 0.12, 5, [0, 0.06, 0], 0x8a7a62);
        ico(0.3, [0, 0.66, 0], 0x1f6b35, b, [1.3, 0.55, 1.2]);
        ico(0.24, [0.14, 0.76, 0.06], 0x2a7f3c, b, [1.3, 0.5, 1.2]);
        ico(0.2, [-0.12, 0.6, -0.1], 0x3a8f42, b, [1.2, 0.55, 1.1]);
        if (v === 4)
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + 0.4;
            b.sphere(0.03, [Math.cos(a) * 0.25, 0.8, Math.sin(a) * 0.22], 0xf3efe0, { w: 4, h: 3 });
          }
      } else if (v === 2) {
        // mangrove: splayed stilt roots under a short trunk and a dense dark crown
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          b.cyl(0.012, 0.016, 0.26, 4, [Math.cos(a) * 0.11, 0.09, Math.sin(a) * 0.11], 0x5a4a3a, {
            rot: [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6]
          });
        }
        b.cyl(0.04, 0.05, 0.22, 5, [0, 0.28, 0], 0x5a4a3a);
        ico(0.3, [0, 0.48, 0], 0x2d5a2e, b, [1.2, 0.7, 1.2]);
        ico(0.2, [0.16, 0.42, 0.1], 0x355f30, b, [1.1, 0.7, 1.1]);
      } else {
        // banana and fern clump: broad leaves radiating up and out
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          b.box(0.36, 0.012, 0.12, [Math.cos(a) * 0.15, 0.2, Math.sin(a) * 0.15], [0x7cbf3e, 0x6aa83a][i % 2]!, {
            rot: [0, -a, 0.55]
          });
        }
        b.cyl(0.03, 0.04, 0.2, 5, [0, 0.1, 0], 0x6a7a3a);
      }
    } else if (v % 3 !== 2) {
      // volcanic: charred dead trees and ash shrubs with smouldering embers
      b.cyl(0.035, 0.07, 0.6, 5, [0, 0.3, 0], 0x2a2522, { rot: [0.05 * k, 0, 0.08] });
      b.cyl(0.02, 0.03, 0.32, 4, [0.1, 0.58, 0], 0x2a2522, { rot: [0, 0, -0.7] });
      b.cyl(0.02, 0.03, 0.28, 4, [-0.09, 0.5, 0.04], 0x2a2522, { rot: [0.3, 0, 0.8] });
      b.cyl(0.015, 0.02, 0.22, 4, [0.02, 0.66, -0.08], 0x2a2522, { rot: [-0.7, 0, 0] });
      ico(0.05, [0.18, 0.66, 0], 0xff6a20, b);
    } else {
      ico(0.2, [0, 0.12, 0], 0x3a3330, b, [1.2, 0.6, 1.1]);
      ico(0.13, [0.16, 0.1, 0.08], 0x2e2826, b, [1, 0.6, 1]);
      ico(0.04, [0.08, 0.2, 0.06], 0xff7a2a, b);
    }
    out.push(b.build());
  }
  // the volcanic embers glow
  if (biome === "volcanic")
    for (const g of out) {
      const col = g.attributes.color!;
      const glow = g.attributes.glow!;
      for (let i = 0; i < col.count; i++) if (col.getX(i) > 0.6) glow.setX(i, 0.8);
    }
  return out;
}

// ------------------------------------------------------ scrap, crystals --

/**
 * Salvage heaps: a low bed of crushed debris with wrecked hull plates and a
 * girder leaning into it, a toppled drum, loose junk, and an amber salvage
 * core glinting on top — gunmetal and rust, so a field reads as metal.
 */
export function scrapGeos(): THREE.BufferGeometry[] {
  if (BELLE_EPOQUE) return coalGeos();
  const out: THREE.BufferGeometry[] = [];
  const plates = [0x737a83, 0x5d636b, 0x8a4a2a, 0x9a7a44, 0x868c94];
  const junk = [0x6e5238, 0x8a6a3a, 0x5a5f66, 0x7a4a2a, 0x9a7a44, 0x46494e];
  for (let v = 0; v < 3; v++) {
    const b = new ModelBuilder();
    const rnd = prng(v * 7919 + 13);
    b.sphere(0.36, [0, -0.05, 0], 0x3d3630, { w: 9, h: 4, phi: Math.PI / 2, scale: [1, 0.36, 1] });
    // hull plates leaning in from round the edge
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + rnd() * 1.2;
      const x = Math.cos(a) * 0.15;
      const z = Math.sin(a) * 0.15;
      b.box(0.22 + rnd() * 0.08, 0.025, 0.15 + rnd() * 0.05, [x, 0.1, z], plates[Math.floor(rnd() * plates.length)]!, {
        rot: [Math.sin(a) * 0.7, -a, -Math.cos(a) * 0.7]
      });
    }
    // a girder across the heap and a toppled drum
    const ga = rnd() * Math.PI;
    b.box(0.42, 0.045, 0.06, [0, 0.13, 0], 0x5a5f66, { rot: [0, ga, 0.25] });
    b.cyl(0.055, 0.055, 0.14, 8, [Math.cos(ga + 1.6) * 0.2, 0.06, Math.sin(ga + 1.6) * 0.2], [0x9a6a2a, 0x7a4a2a, 0x5a6a3a][v]!, {
      rot: [Math.PI / 2, ga, 0]
    });
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 0.22;
      b.box(0.06 + rnd() * 0.09, 0.04 + rnd() * 0.05, 0.05 + rnd() * 0.08, [Math.cos(a) * d, 0.08 + (0.22 - d) * 0.35, Math.sin(a) * d], junk[Math.floor(rnd() * junk.length)]!, {
        rot: [rnd() * 1.2, rnd() * 3, rnd() * 1.2]
      });
    }
    b.box(0.06, 0.06, 0.06, [0.04, 0.21, -0.02], 0xffc94a, { glow: 0.7, rot: [0.6, 0.4, 0] });
    out.push(b.build());
  }
  return out;
}

/**
 * Belle Époque (theme.ts): the scrap fields are coal. A low black heap of
 * glossy lumps, a shovel stuck in it, a few pit props, and a smouldering
 * ember on top where the salvage core was, so a field still glints.
 */
function coalGeos(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const lumps = [0x1d1c1b, 0x272624, 0x312f2c, 0x3b3834, 0x46423d];
  for (let v = 0; v < 3; v++) {
    const b = new ModelBuilder();
    const rnd = prng(v * 7919 + 13);
    b.sphere(0.36, [0, -0.05, 0], 0x1a1918, { w: 9, h: 4, phi: Math.PI / 2, scale: [1, 0.4, 1] });
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 0.28;
      const r = 0.035 + rnd() * 0.045;
      b.add(new THREE.DodecahedronGeometry(r, 0), [Math.cos(a) * d, 0.04 + (0.28 - d) * 0.42, Math.sin(a) * d], lumps[Math.floor(rnd() * lumps.length)]!, {
        rot: [rnd() * 3, rnd() * 3, rnd() * 3]
      });
    }
    // a coal shovel stuck in the heap (ash handle, iron blade), and two pit props lying by it
    const sa = rnd() * Math.PI * 2;
    b.box(0.02, 0.3, 0.02, [Math.cos(sa) * 0.08, 0.24, Math.sin(sa) * 0.08], 0x9a7448, { rot: [Math.sin(sa) * 0.45, 0, -Math.cos(sa) * 0.45] });
    b.box(0.08, 0.012, 0.09, [Math.cos(sa) * 0.02, 0.1, Math.sin(sa) * 0.02], 0x4a4d52, { rot: [Math.sin(sa) * 0.45, sa, -Math.cos(sa) * 0.45] });
    const pa = sa + 2 + rnd();
    for (const k of [0, 1]) {
      b.cyl(0.022, 0.022, 0.3, 6, [Math.cos(pa) * (0.3 + k * 0.05), 0.025 + k * 0.03, Math.sin(pa) * (0.3 + k * 0.05)], 0x7a5a36, { rot: [Math.PI / 2, pa + 1.57, 0] });
    }
    b.box(0.05, 0.035, 0.05, [0.03, 0.2, -0.02], 0xff8a2a, { glow: 0.75, rot: [0.6, 0.4, 0] });
    out.push(b.build());
  }
  return out;
}

export function crystalGeos(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 3; v++) {
    const b = new ModelBuilder();
    let s = v * 104729 + 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    b.add(new THREE.DodecahedronGeometry(0.22, 0), [0, 0.02, 0], 0x3a3f3a, { scale: [1.3, 0.4, 1.2] });
    const n = 5 + v;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd();
      const d = i === 0 ? 0 : 0.1 + rnd() * 0.14;
      const h = (i === 0 ? 0.5 : 0.22 + rnd() * 0.22) * 1.1;
      const r = i === 0 ? 0.07 : 0.04 + rnd() * 0.03;
      const lean = i === 0 ? 0 : 0.35 + rnd() * 0.3;
      // (Belle Époque: radium — Curie's pale blue-green glow)
      const col = (BELLE_EPOQUE ? [0x9cffe4, 0x6fe8d2, 0xd2fff4] : [0x3dffa0, 0x2fd88a, 0x6dffc0])[i % 3]!;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      b.cyl(0, r, h, 5, [x + Math.cos(a) * Math.sin(lean) * h * 0.5, h * 0.5 * Math.cos(lean), z + Math.sin(a) * Math.sin(lean) * h * 0.5], col, {
        glow: 0.55,
        rot: [Math.sin(a) * lean, 0, -Math.cos(a) * lean]
      });
    }
    out.push(b.build());
  }
  return out;
}
