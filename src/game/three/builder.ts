import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Low-poly model construction: primitives placed, rotated and coloured,
 * then merged into ONE vertex-coloured geometry per part (hull, turret,
 * rotor…) so a whole vehicle costs a couple of draw calls. Each vertex also
 * carries a `glow` weight the model shader turns into emission (lights,
 * engines, lenses).
 *
 * Optional baked shading (all in the vertex colours, free at runtime):
 * - `grade` darkens each primitive toward its own base, so stacked parts
 *   separate and every block reads lit-from-above even with shadows off;
 * - `ao` darkens everything near the ground plane (contact occlusion);
 * - `block` / `drum` chamfer their top edges and lighten the chamfer, the
 *   painted art's crisp edge highlight.
 */

export type Vec3 = [number, number, number];

export interface PartOpts {
  /** Euler rotation (radians, XYZ). */
  rot?: Vec3;
  /** Emission strength 0–1. */
  glow?: number;
  /** Non-uniform scale applied before rotation. */
  scale?: Vec3;
}

export interface BuilderOpts {
  /** Per-part vertical shading: each primitive's lowest vertices darken by this fraction. */
  grade?: number;
  /** Ground occlusion: vertices below height `ao[0]` darken by up to `ao[1]` (at y = 0). */
  ao?: [number, number];
}

/** Chamfered-top options for `block` and `drum`. */
export interface BevelOpts extends PartOpts {
  /** Chamfer width (world units); 0 for a plain top. */
  bevel?: number;
  /** Colour multiplier on the chamfer (the edge highlight). */
  edge?: number;
  /** Top narrower than the base by this fraction (sloped armour). */
  taper?: number;
}

const color = new THREE.Color();

/** A ring of a loft: height and half-extents along x and z. */
type Ring = [y: number, rx: number, rz: number];

/**
 * Join rings of the same outline (unit-scale [x, z] points in order round
 * it) with flat bands and cap both ends. `shades` holds one colour
 * multiplier per band, then the top cap's.
 */
function loft(outline: [number, number][], rings: Ring[], shades: number[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const sh: number[] = [];
  const n = outline.length;
  const pt = (r: Ring, i: number): Vec3 => [outline[i % n]![0] * r[1], r[0], outline[i % n]![1] * r[2]];
  const tri = (a: Vec3, b: Vec3, c: Vec3, s: number) => {
    pos.push(...a, ...b, ...c);
    sh.push(s, s, s);
  };
  for (let k = 0; k + 1 < rings.length; k++) {
    const lo = rings[k]!;
    const hi = rings[k + 1]!;
    const s = shades[k] ?? 1;
    for (let i = 0; i < n; i++) {
      tri(pt(lo, i), pt(lo, i + 1), pt(hi, i + 1), s);
      tri(pt(lo, i), pt(hi, i + 1), pt(hi, i), s);
    }
  }
  const cap = (r: Ring, s: number) => {
    for (let i = 1; i + 1 < n; i++) tri(pt(r, 0), pt(r, i), pt(r, i + 1), s);
  };
  cap(rings[0]!, 1);
  cap(rings[rings.length - 1]!, shades[rings.length - 1] ?? 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("shade", new THREE.Float32BufferAttribute(sh, 1));
  g.computeVertexNormals();
  return g;
}

/** A fuselage cross-section: at `z`, half-width `w`, and its top and bottom heights. */
export type Section = [z: number, w: number, top: number, bot: number];

/**
 * Loft chamfered box sections along Z (see ModelBuilder.fuselage): eight
 * corners each, so its bands are the sides, the four chamfers, the top and
 * the belly, shaded by `shades` in that order round from the right side.
 */
function zloft(sections: Section[], chamfer: number, belly: number, shades: number[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const sh: number[] = [];
  const ring = ([z, w, top, bot]: Section): Vec3[] => {
    const c = Math.max(0, Math.min(chamfer, w * 0.45, (top - bot) * 0.45));
    const d = Math.max(0, Math.min(belly, w * 0.45, (top - bot) * 0.45));
    return [
      [w, bot + d, z], [w, top - c, z], [w - c, top, z], [c - w, top, z],
      [-w, top - c, z], [-w, bot + d, z], [d - w, bot, z], [w - d, bot, z]
    ];
  };
  const tri = (a: Vec3, b: Vec3, c: Vec3, s: number) => {
    pos.push(...a, ...b, ...c);
    sh.push(s, s, s);
  };
  const rings = sections.map(ring);
  for (let k = 0; k + 1 < rings.length; k++) {
    const a = rings[k]!;
    const b = rings[k + 1]!;
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      tri(a[i]!, a[j]!, b[j]!, shades[i]!);
      tri(a[i]!, b[j]!, b[i]!, shades[i]!);
    }
  }
  for (const r of [rings[0]!, rings[rings.length - 1]!]) for (let i = 1; i < 7; i++) tri(r[0]!, r[i]!, r[i + 1]!, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("shade", new THREE.Float32BufferAttribute(sh, 1));
  g.computeVertexNormals();
  return g;
}

const SQUARE: [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const polys = new Map<number, [number, number][]>();
function polygon(seg: number): [number, number][] {
  let p = polys.get(seg);
  if (!p) {
    p = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      p.push([Math.sin(a), Math.cos(a)]);
    }
    polys.set(seg, p);
  }
  return p;
}

/** Rings of a solid `h` tall, base half-extents (rx, rz), tapered and chamfered at the top. */
function bevelRings(rx: number, rz: number, h: number, o: BevelOpts, roundish: boolean): { rings: Ring[]; shades: number[] } {
  const taper = o.taper ?? 0;
  const tx = rx * (1 - taper);
  const tz = rz * (1 - taper * (roundish ? 1 : 0.6));
  const e = Math.min(o.bevel ?? 0, tx * 0.45, tz * 0.45, h * 0.6);
  const lo = -h / 2;
  const hi = h / 2;
  if (e <= 0) return { rings: [[lo, rx, rz], [hi, tx, tz]], shades: [1, 1] };
  const f = (h - e) / h;
  return {
    rings: [
      [lo, rx, rz],
      [hi - e, rx + (tx - rx) * f, rz + (tz - rz) * f],
      [hi, tx - e, tz - e]
    ],
    shades: [1, o.edge ?? 1.3, 1]
  };
}

export class ModelBuilder {
  /**
   * Tools only (tools/export-models.ts, set before any model is built): every vertex also keeps its
   * primitive's own colour, unshaded, in a `base` attribute — what the Blender bake paints from.
   */
  static keepBase = false;
  private parts: THREE.BufferGeometry[] = [];

  constructor(private opts: BuilderOpts = {}) {}

  /** Add any geometry (consumed: it is transformed and recoloured in place). */
  add(geo: THREE.BufferGeometry, at: Vec3, hex: number, o: PartOpts = {}): this {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...at),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))),
      new THREE.Vector3(...(o.scale ?? [1, 1, 1]))
    );
    g.applyMatrix4(m);
    const shade = g.attributes.shade as THREE.BufferAttribute | undefined;
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    const p = g.attributes.position!;
    if (ModelBuilder.keepBase) {
      color.setHex(hex);
      const base = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) base.set([color.r, color.g, color.b], i * 3);
      g.setAttribute("base", new THREE.BufferAttribute(base, 3));
    }
    const n = p.count;
    const glowW = o.glow ?? 0;
    const grade = glowW > 0 ? 0 : this.opts.grade ?? 0;
    const ao = glowW > 0 ? undefined : this.opts.ao;
    let y0 = 0;
    let dy = 1;
    if (grade) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        lo = Math.min(lo, p.getY(i));
        hi = Math.max(hi, p.getY(i));
      }
      y0 = lo;
      dy = Math.max(1e-4, hi - lo);
    }
    color.setHex(hex);
    const cols = new Float32Array(n * 3);
    const glow = new Float32Array(n).fill(glowW);
    for (let i = 0; i < n; i++) {
      let k = shade ? shade.getX(i) : 1;
      if (grade) k *= 1 - grade * (1 - (p.getY(i) - y0) / dy);
      if (ao && p.getY(i) < ao[0]) k *= 1 - ao[1] * (1 - Math.max(0, p.getY(i)) / ao[0]);
      cols[i * 3] = Math.min(1, color.r * k);
      cols[i * 3 + 1] = Math.min(1, color.g * k);
      cols[i * 3 + 2] = Math.min(1, color.b * k);
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    g.setAttribute("glow", new THREE.BufferAttribute(glow, 1));
    if (!g.attributes.normal) g.computeVertexNormals();
    g = g as THREE.BufferGeometry;
    this.parts.push(g);
    return this;
  }

  /**
   * Add a finished model part (another builder's output) as it is: moved,
   * turned and scaled, its own colours and glow kept (no grade or occlusion
   * applied again). `geo` is copied, not consumed.
   */
  addBuilt(geo: THREE.BufferGeometry, at: Vec3, o: PartOpts = {}): this {
    const g = geo.clone();
    for (const name of Object.keys(g.attributes))
      if (name !== "position" && name !== "normal" && name !== "color" && name !== "glow" && name !== "base") g.deleteAttribute(name);
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...at),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))),
        new THREE.Vector3(...(o.scale ?? [1, 1, 1]))
      )
    );
    if (!g.attributes.normal) g.computeVertexNormals();
    this.parts.push(g);
    return this;
  }

  box(w: number, h: number, d: number, at: Vec3, hex: number, o?: PartOpts): this {
    return this.add(new THREE.BoxGeometry(w, h, d), at, hex, o);
  }

  /**
   * A box with chamfered top edges lightened into an edge highlight
   * (`bevel` defaults to a fifth of the smallest side), optionally tapered.
   */
  block(w: number, h: number, d: number, at: Vec3, hex: number, o: BevelOpts = {}): this {
    const { rings, shades } = bevelRings(w / 2, d / 2, h, { ...o, bevel: o.bevel ?? Math.min(w, h, d) * 0.2 }, false);
    return this.add(loft(SQUARE, rings, shades), at, hex, o);
  }

  /** A box whose top face is narrower (a sloped-armour slab). */
  slab(w: number, h: number, d: number, at: Vec3, hex: number, inset = 0.2, o?: PartOpts): this {
    const g = new THREE.BoxGeometry(w, h, d);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++)
      if (p.getY(i) > 0) {
        p.setX(i, p.getX(i) * (1 - inset));
        p.setZ(i, p.getZ(i) * (1 - inset * 0.6));
      }
    g.computeVertexNormals();
    return this.add(g, at, hex, o);
  }

  cyl(rTop: number, rBot: number, h: number, seg: number, at: Vec3, hex: number, o?: PartOpts): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), at, hex, o);
  }

  /** A `seg`-sided cylinder (base radius r, top rTop) with a chamfered, highlighted top rim. */
  drum(r: number, rTop: number, h: number, seg: number, at: Vec3, hex: number, o: BevelOpts = {}): this {
    const { rings, shades } = bevelRings(r, r, h, { ...o, taper: 1 - rTop / r, bevel: o.bevel ?? Math.min(rTop, h) * 0.25 }, true);
    return this.add(loft(polygon(seg), rings, shades), at, hex, o);
  }

  /**
   * A faceted body lofted along Z through cross-sections (noses, fuselages,
   * booms, canopies): each a box section with its corners cut by `chamfer`
   * (shrinking to fit thin sections; `belly` cuts the bottom corners, by
   * default as much), the top chamfers lightened into the edge highlight
   * (`edge`) and the belly a shade darker; both ends capped.
   */
  fuselage(sections: Section[], at: Vec3, hex: number, o: PartOpts & { chamfer?: number; belly?: number; edge?: number } = {}): this {
    const e = o.edge ?? 1.3;
    const c = o.chamfer ?? 0.02;
    return this.add(zloft(sections, c, o.belly ?? c, [1, e, 1, e, 1, 0.82, 0.7, 0.82]), at, hex, o);
  }

  /** A cylinder lying along -Z (barrels, pods, fuselages), centred at `at`. */
  tube(r: number, len: number, seg: number, at: Vec3, hex: number, o: PartOpts = {}): this {
    const rot: Vec3 = o.rot ?? [0, 0, 0];
    return this.add(new THREE.CylinderGeometry(r, r, len, seg), at, hex, { ...o, rot: [rot[0] - Math.PI / 2, rot[1], rot[2]] });
  }

  cone(r: number, h: number, seg: number, at: Vec3, hex: number, o?: PartOpts): this {
    return this.add(new THREE.ConeGeometry(r, h, seg), at, hex, o);
  }

  sphere(r: number, at: Vec3, hex: number, o: PartOpts & { w?: number; h?: number; phi?: number } = {}): this {
    const g = new THREE.SphereGeometry(r, o.w ?? 10, o.h ?? 6, 0, Math.PI * 2, 0, o.phi ?? Math.PI);
    return this.add(g, at, hex, o);
  }

  torus(r: number, tube: number, at: Vec3, hex: number, o: PartOpts & { seg?: number } = {}): this {
    return this.add(new THREE.TorusGeometry(r, tube, 5, o.seg ?? 16), at, hex, o);
  }

  /** Extrude a 2D outline (points in the XZ plane, -Z forward) upward by `h`. */
  prism(points: [number, number][], h: number, at: Vec3, hex: number, o?: PartOpts): this {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    // shape lies in XY extruded along +Z: stand it up so the extrusion is +Y
    g.rotateX(-Math.PI / 2);
    return this.add(g, at, hex, o);
  }

  /** Mirror-paired box (x and -x). */
  pair(w: number, h: number, d: number, at: Vec3, hex: number, o?: PartOpts): this {
    this.box(w, h, d, at, hex, o);
    const r = o?.rot;
    return this.box(w, h, d, [-at[0], at[1], at[2]], hex, r ? { ...o, rot: [r[0], -r[1], -r[2]] } : o);
  }

  /** Mirror-paired bevelled block (x and -x). */
  pairBlock(w: number, h: number, d: number, at: Vec3, hex: number, o: BevelOpts = {}): this {
    this.block(w, h, d, at, hex, o);
    const r = o.rot;
    return this.block(w, h, d, [-at[0], at[1], at[2]], hex, r ? { ...o, rot: [r[0], -r[1], -r[2]] } : o);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
