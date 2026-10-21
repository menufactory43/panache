import { BUILDINGS, TERRAIN } from "./balance";
import { atan2, cos, hypot, sin } from "./fmath";
import { Painter, clearBase, valueNoise, type MapDef } from "./maps";
import type { UplinkDef } from "./objectives";
import { hash32, saltOf } from "./rand";
import { Terrain, type Biome, type World } from "./types";
import { createWorld, terrainAt } from "./world";

/**
 * Random maps: a seeded generator for 108×108 (the largest map's size),
 * point-symmetric skirmish maps on any biome.
 *
 * Ids look like "random-<biome>-<code>": <code> is the 32-bit seed in lowercase
 * base 36 (seedCode), e.g. "random-volcanic-k3x9a". The same id always grows
 * the same map, tile for tile: every choice is a pure hash of the seed (no
 * Math.random, fmath trig), so lockstep peers and replays agree.
 *
 * A map is grown in passes on a scratch world, every stroke mirrored through
 * the centre by the Painter: a layout archetype lays down the water (and the
 * canyon's rock spine), bridges are thrown across where the rivers run, then
 * rock, woods and rough ground; resources, roads, Uplinks and drop sites are
 * placed by ground distance from both HQs (BFS), so "home", "expansion" and
 * "contested" mean what they say whatever the river did. A grown map is
 * validated (HQ-to-HQ ground path, every feature present, exact symmetry) and
 * regrown with the next attempt's salt if it fails; the last resort carves a
 * bridged corridor down the HQ diagonal, so every well-formed id yields a map.
 */

export const RANDOM_MAP_SIZE = 108;
export const RANDOM_PREFIX = "random-";
export const BIOMES: readonly Biome[] = ["temperate", "desert", "arctic", "volcanic", "tropical"];

/** The seed as players share it: lowercase base 36. */
export const seedCode = (seed: number): string => (seed >>> 0).toString(36);

/**
 * A seed from whatever a player typed: a base-36 code (1–6 chars, or a 7-char
 * one that is some seed's exact code, as about half of rolled seeds are) as
 * is, any other text hashed.
 */
export function seedFromText(text: string): number {
  const t = text.trim().toLowerCase();
  if (/^[0-9a-z]{1,6}$/.test(t)) return parseInt(t, 36) >>> 0;
  const v = /^[0-9a-z]{7}$/.test(t) ? parseInt(t, 36) : NaN;
  return v <= 0xffffffff && seedCode(v) === t ? v >>> 0 : saltOf(t) >>> 0;
}

export const randomMapId = (biome: Biome, seed: number): string => `${RANDOM_PREFIX}${biome}-${seedCode(seed)}`;

const ID_RE = /^random-(temperate|desert|arctic|volcanic|tropical)-([0-9a-z]{1,7})$/;

export function parseRandomMapId(id: string): { biome: Biome; seed: number } | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const v = parseInt(m[2]!, 36);
  // canonical codes only, so one map has exactly one id
  if (!(v <= 0xffffffff) || seedCode(v) !== m[2]) return null;
  return { biome: m[1] as Biome, seed: v >>> 0 };
}

export const isRandomMapId = (id: string): boolean => id.startsWith(RANDOM_PREFIX);

const cache = new Map<string, MapDef>();

/** The generated map for an id (cached), or null if the id is malformed. */
export function randomMapDef(id: string): MapDef | null {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = parseRandomMapId(id);
  if (!p) return null;
  const def = generate(p.biome, p.seed);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  cache.set(id, def);
  return def;
}

/** Forget generated maps (tests regrow them to check determinism). */
export const clearRandomMapCache = (): void => cache.clear();

/** A fresh random map id (menu side: Math.random is fine there); biome omitted → any biome. */
export function rollRandomMapId(biome?: Biome, rnd: () => number = Math.random): string {
  const b = biome ?? BIOMES[Math.floor(rnd() * BIOMES.length) % BIOMES.length]!;
  return randomMapId(b, Math.floor(rnd() * 4294967296) >>> 0);
}

// ------------------------------------------------------------ generator ---

/** The layout archetypes (RandomMapInfo.layout). */
export const LAYOUTS = ["crossing", "twin-rivers", "lake", "canyon", "fork", "badlands"] as const;
export type Layout = (typeof LAYOUTS)[number];

type Pt = [number, number];
const S = RANDOM_MAP_SIZE;
const C = S / 2;
const G = Terrain.Ground;
const OPEN = [Terrain.Ground, Terrain.Rough, Terrain.Forest];
const WET = [Terrain.Water, Terrain.Deep];

/** mulberry32: a small, fast, well-mixed stream of floats in [0, 1). */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How each biome dresses the same bones. */
interface Flavour {
  /** River width range (tiles). */
  river: [number, number];
  /** What lines the banks (null: bare), and how much wider than the water. */
  bank: Terrain | null;
  bankW: number;
  /** A rim of Shallows straight off the water (ice shelves, reefs). */
  rim: number;
  fords: boolean;
  /** Woods, rough ground and rock outcrops, relative amounts. */
  forest: number;
  rough: number;
  rock: number;
  /** Words for the name and blurb. */
  names: string[];
  water: string;
  /** Two of `water` (Twin Rivers). */
  waters: string;
  lake: string;
  bridge: string;
}

const FLAVOURS: Record<Biome, Flavour> = {
  temperate: {
    river: [3.6, 4.8], bank: Terrain.Rough, bankW: 2.6, rim: 0, fords: true, forest: 1, rough: 0.6, rock: 0.8,
    names: ["des Saules", "des Fougères", "des Ronces", "de l'Eau-Verte", "des Prés", "de l'Aubépine", "du Sureau", "des Digitales"],
    water: "une rivière", waters: "deux rivières", lake: "un lac", bridge: "en pierre"
  },
  desert: {
    river: [2.6, 3.4], bank: Terrain.Forest, bankW: 1.8, rim: 0, fords: true, forest: 0.25, rough: 1.3, rock: 1.5,
    names: ["des Dunes", "du Soleil", "du Mirage", "du Grès", "des Vents", "des Salines", "du Sirocco", "d'Ambre"],
    water: "un oued", waters: "deux oueds", lake: "une oasis", bridge: "en bois"
  },
  arctic: {
    river: [4, 5], bank: Terrain.Rough, bankW: 1.4, rim: 2.2, fords: true, forest: 0.85, rough: 0.6, rock: 0.8,
    names: ["du Glacier", "du Givre", "du Frimas", "du Blizzard", "des Crocs de glace", "des Congères", "de la Gelée", "du Grand Nord"],
    water: "une rivière glacée", waters: "deux rivières glacées", lake: "un lac gelé", bridge: "en fer"
  },
  volcanic: {
    river: [3.4, 4.4], bank: Terrain.Rough, bankW: 3.2, rim: 0, fords: false, forest: 0.3, rough: 0.9, rock: 1.6,
    names: ["des Escarbilles", "des Cendres", "du Magma", "d'Obsidienne", "du Soufre", "du Brasier", "des Braises", "du Basalte"],
    water: "une rivière de lave", waters: "deux rivières de lave", lake: "un lac de lave", bridge: "en acier"
  },
  tropical: {
    river: [4.6, 5.8], bank: Terrain.Forest, bankW: 2.4, rim: 1.3, fords: true, forest: 1.7, rough: 0.4, rock: 0.6,
    names: ["des Mangroves", "de Jade", "de la Mousson", "du Lagon", "du Corail", "des Orchidées", "des Perroquets", "des Banians"],
    water: "une rivière de jungle", waters: "deux rivières de jungle", lake: "un lagon", bridge: "en bois"
  }
};

const NOUNS: Record<Layout, string[]> = {
  crossing: ["Passage", "Partage", "Couloir", "Bief"],
  "twin-rivers": ["Jumelles", "Douves", "Sœurs", "Anneaux"],
  lake: ["Bassin", "Étang", "Creux", "Cuvette"],
  canyon: ["Canyon", "Gorge", "Faille", "Échine"],
  fork: ["Fourche", "Delta", "Bras", "Embranchement"],
  badlands: ["Badlands", "Friches", "Mesas", "Ravines"]
};

const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

const numWord = (n: number): string => ["aucun", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit"][n] ?? String(n);

interface River {
  pts: Pt[];
  w: number;
  /** Bridges to throw across it (blue-side half; the Painter mirrors each). */
  bridges: number;
  /** It runs into the centre: a bridge there is its own mirror. */
  centre: boolean;
}

/** Catmull-Rom through the control points, then meandered sideways by noise (pinned at both ends). */
function curve(ctrl: Pt[], amp: number, seed: number): Pt[] {
  const P = (i: number): Pt => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))]!;
  const pts: Pt[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    const n = Math.max(2, Math.ceil(hypot(p2[0] - p1[0], p2[1] - p1[1]) / 1.5));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  pts.push(P(ctrl.length - 1));
  let total = 0;
  const along = pts.map((p, i) => (total += i ? hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) : 0));
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const l = hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const env = Math.min(1, along[i]! / 10, (total - along[i]!) / 10);
    const off = ((valueNoise(along[i]! / 13, 0.5, seed) - 0.5) * 2 + (valueNoise(along[i]! / 5, 9.5, seed) - 0.5) * 0.5) * amp * env;
    return [p[0] - ((b[1] - a[1]) / l) * off, p[1] + ((b[0] - a[0]) / l) * off];
  });
}

/** Unit direction along a polyline at point i. */
function tangent(pts: Pt[], i: number): Pt {
  const a = pts[Math.max(0, i - 3)]!;
  const b = pts[Math.min(pts.length - 1, i + 3)]!;
  const l = hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

const passable = (t: number): boolean => TERRAIN[t as Terrain].ground;

/** Ground BFS distances (4-neighbour, so any 4-path is a real path) from a tile; -1 unreachable. */
function flood(g: Uint8Array, from: number): Int32Array {
  const d = new Int32Array(g.length).fill(-1);
  if (!passable(g[from]!)) return d;
  const q = new Int32Array(g.length);
  let h = 0;
  let n = 0;
  q[n++] = from;
  d[from] = 0;
  while (h < n) {
    const i = q[h++]!;
    const x = i % S;
    const y = (i / S) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < S - 1 ? i + 1 : -1, y > 0 ? i - S : -1, y < S - 1 ? i + S : -1])
      if (j >= 0 && d[j]! < 0 && passable(g[j]!)) {
        d[j] = d[i]! + 1;
        q[n++] = j;
      }
  }
  return d;
}

/** Everything a generation pass grew, ready for a MapDef. */
interface Grown {
  w: World;
  hq: Pt;
  uplinks: UplinkDef[];
  dropSites: Pt[];
  facts: { bridges: number; fords: number; crystals: string; extra: string };
  ok: boolean;
}

function generate(biome: Biome, seed: number): MapDef {
  const top = stream(hash32(seed, saltOf("map")));
  const layout = LAYOUTS[Math.floor(top() * LAYOUTS.length)]!;
  const fl = FLAVOURS[biome];
  const of = fl.names[Math.floor(top() * fl.names.length)];
  const name = `${NOUNS[layout][Math.floor(top() * 4)]} ${of}`;
  const hq: Pt = [12 + Math.floor(top() * 7), 84 + Math.floor(top() * 7)];
  const def: MapDef = {
    id: randomMapId(biome, seed),
    name,
    biome,
    size: S,
    blurb: "",
    hq,
    seed,
    uplinks: [],
    dropSites: [],
    starSecs: 720,
    paint() {
      /* random maps carry their finished grid (def.random.terrain) */
    }
  };
  let g: Grown | null = null;
  for (let attempt = 0; attempt < 12 && !g?.ok; attempt++) g = grow(def, layout, hash32(seed, attempt, saltOf("try")), false);
  if (!g?.ok) g = grow(def, layout, hash32(seed, saltOf("last resort")), true);
  def.uplinks = g.uplinks;
  def.dropSites = g.dropSites;
  def.blurb = blurbOf(layout, fl, g.facts);
  def.random = { seed, code: seedCode(seed), layout, terrain: g.w.terrain.slice() };
  return def;
}

const LEADS: Record<Layout, (f: Flavour) => string> = {
  crossing: (f) => `${cap(f.water)} coupe la carte en deux`,
  "twin-rivers": (f) => `${cap(f.waters)} isolent chaque base du cœur de la carte`,
  lake: (f) => `${cap(f.lake)} occupe le centre et s'écoule vers les coins`,
  canyon: () => `Une échine rocheuse fend le terrain, un ruisseau à son pied`,
  fork: (f) => `${cap(f.water)} se divise autour de deux poches isolées`,
  badlands: (f) => `Des mesas brisent la plaine, ${f.water} serpente entre elles`
};

function blurbOf(layout: Layout, fl: Flavour, f: Grown["facts"]): string {
  const fords = f.fords ? `, ${numWord(f.fords)} gué${f.fords > 1 ? "s" : ""}` : "";
  return `${LEADS[layout](fl)}\u00a0: ${numWord(f.bridges)} pont${f.bridges > 1 ? "s" : ""} ${fl.bridge}${fords}${f.extra}\u00a0; cristaux ${f.crystals}.`;
}

/** One generation pass on a scratch world. */
function grow(def: MapDef, layout: Layout, sub: number, force: boolean): Grown {
  const fl = FLAVOURS[def.biome];
  const w = createWorld(S, S);
  const p = new Painter(w, sub);
  const rnd = stream(sub);
  const r = (a: number, b: number) => a + rnd() * (b - a);
  const hs = BUILDINGS.hq.size;
  const [hx, hy] = def.hq;
  const bc: Pt = [hx + hs / 2, hy + hs / 2];
  const rc: Pt = [S - bc[0], S - bc[1]];
  const fromBase = (x: number, y: number) => Math.min(hypot(x - bc[0], y - bc[1]), hypot(x - rc[0], y - rc[1]));
  const rivers: River[] = [];
  const ponds: [number, number, number][] = [];
  const rw = () => r(fl.river[0], fl.river[1]);
  const facts = { bridges: 0, fords: 0, crystals: "", extra: "" };
  let lakeR = 0;
  let spine: Pt[] | null = null;
  const passes: Pt[] = [];

  // ---- 1. bones: the layout's water (and the canyon's rock)
  switch (layout) {
    case "crossing": {
      const e: Pt = rnd() < 0.5 ? [r(10, 42), -3] : [-3, r(10, 42)];
      rivers.push({ pts: curve([e, [(e[0] + C) / 2 + r(-6, 6), (e[1] + C) / 2 + r(-6, 6)], [C, C]], r(4, 8), sub), w: rw() + 0.6, bridges: 2, centre: rnd() < 0.6 });
      break;
    }
    case "twin-rivers": {
      // an arc round blue's base, edge to edge, ~35 tiles out (red's is its mirror)
      const R = r(33, 38);
      const ctrl: Pt[] = [[-3, bc[1] - R + r(-3, 2)]];
      for (let a = -95; a <= 5; a += 25) {
        const rr = R + r(-3, 3);
        ctrl.push([bc[0] + rr * cos((a * Math.PI) / 180), bc[1] + rr * sin((a * Math.PI) / 180)]);
      }
      ctrl.push([bc[0] + R + r(-2, 3), S + 3]);
      rivers.push({ pts: curve(ctrl, r(2, 4), sub), w: rw() - 0.4, bridges: 3, centre: false });
      ponds.push([C, C, r(2.5, 4)]);
      break;
    }
    case "lake": {
      lakeR = r(9, 12.5);
      p.blob(C, C, lakeR, Terrain.Water, 0.22);
      const e: Pt = rnd() < 0.5 ? [r(6, 30), -3] : [-3, r(6, 30)];
      rivers.push({ pts: curve([e, [C - lakeR * 0.7, C - lakeR * 0.7]], r(3, 6), sub), w: rw() - 0.3, bridges: 2, centre: false });
      break;
    }
    case "canyon": {
      spine = curve([[-3, -3], [r(20, 30), r(20, 30)], [C, C]], r(4, 7), sub);
      const sw = r(3, 4.2);
      p.stroke(spine, sw + 4, Terrain.Rough, 0.4, [G]);
      p.stroke(spine, sw, Terrain.Rock, 0.35);
      // the passes: one at the centre (its own mirror) or two per side
      const at = rnd() < 0.5 ? [0.45] : [0.3, 0.68];
      if (rnd() < 0.6 || at.length === 1) passes.push([C, C]);
      for (const f of at) passes.push(spine[Math.floor(f * (spine.length - 1))]!);
      // a stream from the west edge into the spine's foot
      const foot = spine[Math.floor(r(0.35, 0.6) * (spine.length - 1))]!;
      rivers.push({ pts: curve([[-3, r(36, 52)], [foot[0] - 2, foot[1] + 3]], r(3, 5), sub), w: rw() * 0.7, bridges: 2, centre: false });
      break;
    }
    case "fork": {
      const F: Pt = [r(24, 34), r(24, 34)];
      rivers.push({ pts: curve([[-3, r(22, 40)], F], r(2, 4), sub), w: rw(), bridges: 1, centre: false });
      rivers.push({ pts: curve([F, [C, C]], r(3, 6), sub + 1), w: rw(), bridges: 1, centre: rnd() < 0.5 });
      rivers.push({ pts: curve([F, [r(36, 56), -3]], r(2, 4), sub + 2), w: rw() * 0.85, bridges: 1, centre: false });
      break;
    }
    case "badlands": {
      const e: Pt = rnd() < 0.5 ? [r(14, 40), -3] : [-3, r(14, 40)];
      rivers.push({ pts: curve([e, [C, C]], r(6, 10), sub), w: rw() * 0.75, bridges: 2, centre: rnd() < 0.5 });
      // mesas: rock tables ringed by scree
      for (let i = 0, n = 6 + Math.floor(rnd() * 4); i < n; i++) {
        const x = r(6, S - 6);
        const y = r(6, C + 10);
        const rr = r(2.4, 4.6);
        if (fromBase(x, y) < 16 + rr) continue;
        p.blob(x, y, rr + 2, Terrain.Rough, 0.35, [G]);
        p.blob(x, y, rr, Terrain.Rock, 0.35);
      }
      break;
    }
  }
  // rivers and their banks
  for (const rv of rivers) {
    if (fl.bank !== null) p.stroke(rv.pts, rv.w + (fl.rim + fl.bankW) * 2, fl.bank, 0.4, [G, Terrain.Rough, Terrain.Forest]);
    if (fl.rim) p.stroke(rv.pts, rv.w + fl.rim * 2, Terrain.Shallows, 0.3, [G, Terrain.Rough, Terrain.Forest]);
    p.stroke(rv.pts, rv.w, Terrain.Water, 0.22, [G, Terrain.Rough, Terrain.Forest, Terrain.Shallows, Terrain.Rock]);
  }
  if (layout === "canyon") for (const q of passes) p.blob(q[0], q[1], r(2.8, 3.6), G, 0.2, [Terrain.Rock]);
  if (lakeR) {
    if (fl.rim) p.blob(C, C, lakeR + fl.rim + 0.6, Terrain.Shallows, 0.22, [G, Terrain.Rough, Terrain.Forest]);
    if (fl.bank !== null) p.blob(C, C, lakeR + fl.rim + 2.2, fl.bank, 0.3, [G]);
    p.blob(C, C, lakeR, Terrain.Water, 0.22);
    if (def.biome === "tropical" && lakeR > 10) p.blob(C, C, lakeR - 4, Terrain.Deep, 0.15, [Terrain.Water]); // a blue hole, ringed by hover-safe water
  }
  // ponds and oases
  const nPonds = (def.biome === "desert" ? 2 : 1) + Math.floor(rnd() * 2);
  for (let i = 0; i < nPonds; i++) ponds.push([r(8, S - 8), r(8, C + 6), r(1.6, 2.8)]);
  for (const [x, y, rr] of ponds) {
    if (fromBase(x, y) < 16 + rr || (lakeR && hypot(x - C, y - C) < lakeR + 8 && x !== C)) continue;
    p.blob(x, y, rr + (def.biome === "desert" ? 2.2 : 1.6), def.biome === "desert" || def.biome === "tropical" ? Terrain.Forest : (fl.rim ? Terrain.Shallows : (fl.bank ?? Terrain.Rough)), 0.35, [G, Terrain.Rough]);
    p.blob(x, y, rr, Terrain.Water, 0.3, [G, Terrain.Rough, Terrain.Forest, Terrain.Shallows]);
  }

  // ---- 2. crossings: bridges straight across the water, fords where the biome allows
  const ends: Pt[] = [];
  const spans: [Pt, Pt][] = [];
  const bridgeAt = (c: Pt, dir: Pt, maxLen = 16) => {
    // squared to the grid or its diagonal: tiles lay those as clean straight bands (any other slant
    // is a ragged staircase that no deck fits)
    const q = Math.round(atan2(dir[0], -dir[1]) / (Math.PI / 4)) * (Math.PI / 4);
    const n: Pt = [Math.round(cos(q) * 1e6) / 1e6, Math.round(sin(q) * 1e6) / 1e6];
    const reach = (sg: number) => {
      for (let d = 0; d < maxLen; d += 0.5) if (!WET.includes(terrainAt(w, Math.floor(c[0] + n[0] * d * sg), Math.floor(c[1] + n[1] * d * sg)))) return d;
      return -1;
    };
    const a = reach(1);
    const b = reach(-1);
    if (a < 0 || b < 0 || a + b < 1) return false;
    const A: Pt = [c[0] + n[0] * (a + 0.9), c[1] + n[1] * (a + 0.9)];
    const B: Pt = [c[0] - n[0] * (b + 0.9), c[1] - n[1] * (b + 0.9)];
    p.stroke([A, B], 2.4, Terrain.Bridge, 0, WET);
    p.stroke([[c[0] + n[0] * (a + 3.5), c[1] + n[1] * (a + 3.5)], [c[0] - n[0] * (b + 3.5), c[1] - n[1] * (b + 3.5)]], 2.4, Terrain.Road, 0, [...OPEN, Terrain.Shallows]);
    ends.push(A, B);
    spans.push([A, B], [[S - A[0], S - A[1]], [S - B[0], S - B[1]]]);
    return true;
  };
  let bridges = 0;
  for (const rv of rivers) {
    const L = rv.pts.length;
    const lo = 0.18;
    const hi = rv.centre ? 0.72 : 0.85;
    const used: number[] = [];
    for (let k = 0; k < rv.bridges; k++) {
      // spread along the river: each in its own stretch, jittered
      const f = lo + ((k + 0.25 + rnd() * 0.5) / rv.bridges) * (hi - lo);
      const i = Math.floor(f * (L - 1));
      const c = rv.pts[i]!;
      if (fromBase(c[0], c[1]) < 12 || c[0] < 3 || c[1] < 3 || c[0] > S - 3 || c[1] > S - 3) continue;
      if (used.some((j) => hypot(rv.pts[j]![0] - c[0], rv.pts[j]![1] - c[1]) < 12)) continue;
      if (bridgeAt(c, tangent(rv.pts, i))) {
        used.push(i);
        bridges += 2;
      }
    }
    if (rv.centre && bridgeAt([C, C], tangent(rv.pts, L - 1))) bridges += 1;
    if (fl.fords && rnd() < 0.75) {
      // a ford in the longest gap between bridges
      const f = used.length ? (used.reduce((a, b) => a + b, 0) / used.length / (L - 1) < 0.5 ? r(0.7, 0.8) : r(0.2, 0.3)) : 0.5;
      const i = Math.floor(f * (L - 1));
      const c = rv.pts[i]!;
      const t = tangent(rv.pts, i);
      if (fromBase(c[0], c[1]) >= 12 && !used.some((j) => Math.abs(j - i) < 6)) {
        p.stroke([[c[0] - t[1] * (rv.w + 2), c[1] + t[0] * (rv.w + 2)], [c[0] + t[1] * (rv.w + 2), c[1] - t[0] * (rv.w + 2)]], 3.2, Terrain.Shallows, 0.15, [Terrain.Water]);
        facts.fords += 2;
      }
    }
  }
  // the lake's causeway: a long bridge out to an island at the very centre
  if (lakeR && rnd() < 0.55) {
    p.blob(C, C, r(2.6, 3.4), G, 0.15, [Terrain.Water, Terrain.Deep]);
    const a = r(0.15, 0.35) * Math.PI;
    if (bridgeAt([C + cos(a) * 3.2, C - sin(a) * 3.2], [sin(a), cos(a)], lakeR + 6)) bridges += 2;
    facts.extra = ", une chaussée vers l'île";
  }
  if (spine) {
    const n = passes.reduce((n, q) => n + (q[0] === C ? 1 : 2), 0);
    facts.extra = `, ${numWord(n)} passage${n > 1 ? "s" : ""} dans la roche`;
  }
  facts.bridges = bridges;

  // ---- 3. cover: rock outcrops and ridges, woods and rough ground by noise
  const nearEnd = (x: number, y: number, d: number) => ends.some((e) => hypot(e[0] - x, e[1] - y) < d || hypot(S - e[0] - x, S - e[1] - y) < d);
  const nRocks = Math.round((7 + rnd() * 5) * fl.rock);
  for (let i = 0; i < nRocks; i++) {
    const x = r(3, S - 3);
    const y = r(3, S - 3);
    if (fromBase(x, y) < 13 || nearEnd(x, y, 7) || hypot(x - C, y - C) < 4) continue;
    if (rnd() < 0.35) {
      // a short ridge, with room to walk round its ends
      const a = rnd() * Math.PI * 2;
      const l = r(4, 8);
      p.stroke([[x - cos(a) * l, y - sin(a) * l], [x, y], [x + cos(a) * l, y + sin(a) * l + r(-2, 2)]], r(1.5, 2.1), Terrain.Rock, 0.3, OPEN);
    } else {
      const rr = r(1.1, def.biome === "volcanic" ? 1.8 : 2.4);
      if (def.biome === "desert" || def.biome === "volcanic") p.blob(x, y, rr + 1.6, Terrain.Rough, 0.4, [G]);
      p.blob(x, y, rr, Terrain.Rock, 0.4, OPEN);
    }
  }
  const nf = hash32(sub, saltOf("woods"));
  const nr = hash32(sub, saltOf("rough"));
  const forestCut = 0.8 - 0.1 * fl.forest;
  const roughCut = 0.83 - 0.08 * fl.rough;
  for (let i = 0; i < (S * S) / 2; i++) {
    const x = i % S;
    const y = (i / S) | 0;
    if (w.terrain[i] !== G || fromBase(x + 0.5, y + 0.5) < 11 || nearEnd(x + 0.5, y + 0.5, 3)) continue;
    const f = valueNoise(x * 0.09, y * 0.09, nf) * 0.7 + valueNoise(x * 0.27, y * 0.27, nf + 1) * 0.3;
    if (f > forestCut) p.set(x, y, Terrain.Forest, [G]);
    else if (valueNoise(x * 0.12, y * 0.12, nr) * 0.75 + valueNoise(x * 0.4, y * 0.4, nr + 1) * 0.25 > roughCut) p.set(x, y, Terrain.Rough, [G]);
  }

  // ---- 4. fallback: carve a bridged corridor down the HQ diagonal
  const bTile = Math.floor(bc[1]) * S + Math.floor(bc[0]);
  const rTile = S * S - 1 - bTile;
  const clear = () => clearBase(w, def);
  clear();
  let dB = flood(w.terrain, bTile);
  if (dB[rTile]! < 0) {
    if (!force) return { w, hq: def.hq, uplinks: [], dropSites: [], facts, ok: false };
    p.stroke([bc, [C, C]], 3, Terrain.Bridge, 0, WET);
    p.stroke([bc, [C, C]], 3, G, 0, [Terrain.Rock]);
    clear();
    dB = flood(w.terrain, bTile);
  }
  const dR = new Int32Array(dB.length);
  for (let i = 0; i < dB.length; i++) dR[i] = dB[dB.length - 1 - i]!;
  const D = dB[rTile]!;

  // ---- 5. resources, by ground distance from each HQ
  const fields: Pt[] = [];
  /** Share of the disc that is open land a field can lie on. */
  const openness = (x: number, y: number, rr: number) => {
    let n = 0;
    let ok = 0;
    for (let ty = Math.floor(y - rr); ty <= y + rr; ty++)
      for (let tx = Math.floor(x - rr); tx <= x + rr; tx++) {
        if (hypot(tx + 0.5 - x, ty + 0.5 - y) > rr) continue;
        n++;
        if (OPEN.includes(terrainAt(w, tx, ty))) ok++;
      }
    return n ? ok / n : 0;
  };
  const pick = (score: (x: number, y: number, i: number) => number): Pt | null => {
    let best: Pt | null = null;
    let bs = -Infinity;
    for (let i = 0; i < S * S; i += 1 + Math.floor(rnd() * 3)) {
      if (dB[i]! < 0 || !OPEN.includes(w.terrain[i] as Terrain)) continue;
      const x = (i % S) + 0.5;
      const y = ((i / S) | 0) + 0.5;
      if (fields.some((f) => hypot(f[0] - x, f[1] - y) < 9 || hypot(S - f[0] - x, S - f[1] - y) < 9)) continue;
      const s = score(x, y, i) + rnd() * 0.4;
      if (s > bs) {
        bs = s;
        best = [x, y];
      }
    }
    return best;
  };
  const field = (at: Pt | null, rr: number, t: Terrain) => {
    if (!at) return;
    p.blob(at[0], at[1], rr, t, 0.25, OPEN);
    fields.push(at);
  };
  const band = (v: number, lo: number, hi: number) => (v < lo ? (v - lo) / 4 : v > hi ? (hi - v) / 4 : 0);
  // home: 6–9 tiles from the HQ
  field(pick((x, y) => band(hypot(x - bc[0], y - bc[1]), 6.5, 8.5) * 3 + openness(x, y, 2.8) * 4), 2.1, Terrain.Scrap);
  // the natural expansion: well inside blue's half
  field(pick((x, y, i) => band(dB[i]!, 17, 30) + band(dR[i]! - dB[i]!, 22, 999) * 2 + openness(x, y, 2.4) * 4 + (fromBase(x, y) < 13 ? -4 : 0)), 1.8, Terrain.Scrap);
  // contested scrap: about as far from both HQs
  const nContest = 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < nContest; k++)
    field(
      pick((x, y, i) => band(dB[i]!, 0.3 * D, 0.55 * D) + band(dR[i]! - dB[i]!, 0, 0.18 * D) * 2 + openness(x, y, 2) * 3 + (hypot(x - C, y - C) < 7 ? -3 : 0)),
      r(1.5, 1.9),
      Terrain.Scrap
    );
  // crystals: risky ground — by the bridges, the pockets, the centre
  const nearBridge = (x: number, y: number) => ends.reduce((m, e) => Math.min(m, hypot(e[0] - x, e[1] - y), hypot(S - e[0] - x, S - e[1] - y)), 99);
  const cOpen = openness(C, C, 2);
  if (cOpen > 0.9 && dB[Math.floor(C) * S + Math.floor(C)]! >= 0 && rnd() < 0.5) {
    p.blob(C, C, 1.5, Terrain.Crystal, 0.2, OPEN);
    fields.push([C, C]);
    facts.crystals = "au centre";
  }
  const nCrystal = facts.crystals ? 1 : 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < nCrystal; k++)
    field(
      pick((x, y, i) => band(dB[i]!, 0.38 * D, 0.62 * D) + band(Math.abs(dR[i]! - dB[i]!), 0, 0.2 * D) + band(nearBridge(x, y), 3, 9) * 0.8 + openness(x, y, 1.6) * 3),
      r(1.2, 1.5),
      Terrain.Crystal
    );
  facts.crystals ||= ends.length ? "près des passages" : "à découvert";
  if (facts.crystals !== "au centre" && ends.length && fields.slice(-nCrystal).every((f) => nearBridge(f[0], f[1]) > 10)) facts.crystals = "en plein no man's land";

  // ---- 6. roads: from the HQ down the ground path to the two nearest bridgeheads
  const at = (e: Pt) => dB[Math.floor(e[1]) * S + Math.floor(e[0])] ?? -1;
  // each bridge's near end (by ground distance), nearest bridges first
  const heads = spans
    .map(([a, b]) => (at(a) >= 0 && (at(b) < 0 || at(a) <= at(b)) ? { e: a, d: at(a) } : { e: b, d: at(b) }))
    .filter((h) => h.d > 0)
    .sort((a, b) => a.d - b.d || a.e[0] - b.e[0]);
  const roads: Pt[] = [];
  for (const h of heads) {
    if (roads.length >= 2) break;
    if (roads.some((q) => hypot(q[0] - h.e[0], q[1] - h.e[1]) < 10)) continue;
    roads.push(h.e);
    // walk downhill on the distance field, leaning toward the HQ
    let i = Math.floor(h.e[1]) * S + Math.floor(h.e[0]);
    const path: Pt[] = [];
    for (let guard = 0; guard < 400 && dB[i]! > 2; guard++) {
      const x = i % S;
      const y = (i / S) | 0;
      if (guard % 4 === 0) path.push([x + 0.5, y + 0.5]);
      let nx = -1;
      let best = Infinity;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const j = (y + oy) * S + x + ox;
          if ((!ox && !oy) || x + ox < 0 || x + ox >= S || y + oy < 0 || y + oy >= S || dB[j]! < 0 || dB[j]! >= dB[i]!) continue;
          // diagonal steps only between passable tiles, so the road never cuts a corner
          if (ox && oy && (dB[y * S + x + ox]! < 0 || dB[(y + oy) * S + x]! < 0)) continue;
          const s = dB[j]! * 10 + hypot(x + ox + 0.5 - bc[0], y + oy + 0.5 - bc[1]);
          if (s < best) {
            best = s;
            nx = j;
          }
        }
      if (nx < 0) break;
      i = nx;
    }
    path.push(bc);
    // pull the staircase taut: straight runs wherever the ground between is clear
    const clearRun = (a: Pt, b: Pt) => {
      const l = hypot(b[0] - a[0], b[1] - a[1]);
      for (let k = 0; k <= l * 3; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / (l * 3 || 1);
        const y = a[1] + ((b[1] - a[1]) * k) / (l * 3 || 1);
        for (const [ox, oy] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) if (!passable(terrainAt(w, Math.floor(x + ox!), Math.floor(y + oy!)))) return false;
      }
      return true;
    };
    const taut: Pt[] = [path[0]!];
    for (let a = 0; a < path.length - 1; ) {
      let b = path.length - 1;
      while (b > a + 1 && !clearRun(path[a]!, path[b]!)) b--;
      taut.push(path[b]!);
      a = b;
    }
    p.stroke(taut, 2, Terrain.Road, 0, OPEN);
  }
  clear();

  // ---- 7. Uplinks and drop sites: open, reachable ground away from both bases
  const g = w.terrain;
  const roomy = (x: number, y: number) => {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (!passable(terrainAt(w, Math.floor(x) + ox, Math.floor(y) + oy))) return false;
    return true;
  };
  const spots: Pt[] = [];
  const spot = (score: (x: number, y: number, i: number) => number, gap: number): Pt | null => {
    let best: Pt | null = null;
    let bs = -Infinity;
    for (let i = 0; i < S * S; i++) {
      if (dB[i]! < 0 || dR[i]! < 0 || !passable(g[i]!) || g[i] === Terrain.Bridge) continue;
      const x = (i % S) + 0.5;
      const y = ((i / S) | 0) + 0.5;
      if (fromBase(x, y) < 13 || !roomy(x, y)) continue;
      if (spots.some((q) => hypot(q[0] - x, q[1] - y) < gap || hypot(S - q[0] - x, S - q[1] - y) < gap)) continue;
      const s = score(x, y, i) + hash32(sub, i) / 4294967296 * 0.3;
      if (s > bs) {
        bs = s;
        best = [x, y];
      }
    }
    if (best) spots.push(best);
    return best;
  };
  const uplinks: UplinkDef[] = [];
  const ci = Math.floor(C) * S + Math.floor(C);
  if (dB[ci]! >= 0 && roomy(C, C) && g[ci] !== Terrain.Bridge && rnd() < 0.7) {
    uplinks.push([C, C]);
    spots.push([C, C]);
  }
  const nUp = uplinks.length ? Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < nUp; k++) {
    const u = spot((x, y, i) => band(Math.abs(dR[i]! - dB[i]!), 0, 0.12 * D) * 2 + band(hypot(x - S + x, y - S + y), 24, 999) + band(dB[i]!, 0.3 * D, 0.7 * D) - hypot(x - C, y - C) / 30, 18);
    if (u) uplinks.push(u);
  }
  const dropSites: Pt[] = [];
  for (const [lo, hi] of [[0.22, 0.34], [0.32, 0.44], [0.42, 0.52]] as const) {
    const d = spot((_x, _y, i) => band(dB[i]!, lo * D, hi * D) * 2 + band(dR[i]! - dB[i]!, 0, 999), 9);
    if (d) dropSites.push(d);
  }

  // ---- 8. validate
  let ok = dB[rTile]! >= 0 && uplinks.length > 0 && dropSites.length === 3 && fields.length >= 4;
  const seen = new Set<number>();
  for (let i = 0; i < g.length; i++) {
    seen.add(g[i]!);
    if (g[i] !== g[g.length - 1 - i]) ok = false;
  }
  for (const t of [Terrain.Water, Terrain.Bridge, Terrain.Rock, Terrain.Forest, Terrain.Scrap, Terrain.Crystal, Terrain.Road]) if (!seen.has(t)) ok = false;
  for (const f of fields.slice(0, 2)) if (dB[Math.floor(f[1]) * S + Math.floor(f[0])]! < 0) ok = false;
  return { w, hq: def.hq, uplinks, dropSites, facts, ok: ok || force };
}
