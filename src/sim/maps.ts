import { BUILDINGS } from "./balance";
import { setupObjectives, type UplinkDef } from "./objectives";
import { applyOpener, spawnStartUnits, type OpenerId } from "./openers";
import { Terrain, type Biome, type Faction, type Nation, type UnitKind, type World } from "./types";
import { createWorld, inBounds, setTerrain, spawnBuilding, spawnUnit, terrainAt } from "./world";
import { setupSurvival, type SurvivalOptions } from "./modes/survival";
import { applyMutators, applySpawnRank, bannedBy, makeRules, rulesOf, type MutatorId } from "./rules";
import { setupOp } from "./ops";
import { dropPoint, stowAboard } from "./transport";
import { setupLifeline } from "./lifeline";
import { nomadStart } from "./goliath";
import { armadaStart } from "./lift";
import { hypot } from "./fmath";
import { isRandomMapId, randomMapDef } from "./mapgen";

/**
 * Skirmish maps, in map-picker order (the classic Proving Grounds first, to
 * learn on). Every map is 2-player and point-symmetric (rotated 180°
 * about the centre), so both sides get identical terrain. Maps are painted
 * procedurally from a fixed seed with simple shape primitives — the same
 * definition feeds the simulation and (via tools/export-maps.ts) the
 * offline terrain renderer that paints the matching ground art.
 */

export interface MapDef {
  id: string;
  name: string;
  biome: Biome;
  size: number;
  /** One-line flavour for the map picker. */
  blurb: string;
  /** Blue HQ top-left tile; red is mirrored. */
  hq: [number, number];
  seed: number;
  paint(p: Painter): void;
  /**
   * Capturable Uplink relays (objectives.ts), in tiles: each point and its
   * mirror image get one (a point at the exact centre is its own mirror).
   * An entry can carry its own rules: an island relay only infantry can take.
   */
  uplinks: UplinkDef[];
  /** Supply-drop sites (blue-side, tiles); every drop lands a crate at one and at its mirror. */
  dropSites: Pt[];
  /**
   * Units both sides start with on top of the classic harvester and Trooper
   * Squad (skirmish only). They join the rules' startUnits, so the AI plans
   * around them and Airborne doesn't hand out a second Condor; a Condor the
   * map gives is free (Unit.free).
   */
  startUnits?: UnitKind[];
  /** The starting Trooper Squad begins aboard the starting Condor. */
  squadAboard?: boolean;
  /** Islands only a Condor reaches: no buildings or Drop Pods off a side's home land (Rules.islands). */
  islands?: boolean;
  /** A side with no Condor gets a free one, with a squad if it's short (lifeline.ts). */
  lifeline?: boolean;
  /** HQ trickle on this map, scrap/s (default ECONOMY.hqTrickle). */
  hqTrickle?: number;
  /** Mutators that would break this map: left out of its matches, greyed out on the menu. */
  bannedMutators?: MutatorId[];
  /** Offered for Last Stand? (default yes) */
  lastStand?: boolean;
  /** Career ★★ "win within" time on this map, in seconds (default STAR_SECS). */
  starSecs?: number;
  /** A generated map (mapgen.ts): its seed, layout and finished terrain grid. */
  random?: RandomMapInfo;
}

/** What mapgen.ts records about a generated map. */
export interface RandomMapInfo {
  /** The 32-bit seed it was grown from, and that seed as the short code players share. */
  seed: number;
  code: string;
  /** The layout archetype it rolled (mapgen.ts LAYOUTS), e.g. "crossing". */
  layout: string;
  /** The finished terrain (row-major size×size Terrain codes, HQ ground cleared), for runtime painting. */
  terrain: Uint8Array;
}

/** Why a mutator can't be played on this map (null: it can). */
export function mapBansMutator(def: MapDef, id: MutatorId): string | null {
  return def.bannedMutators?.includes(id) ? `Pas sur ${def.name} : les Relais des îles exigent Montgolfières et infanterie` : null;
}

// ---------------------------------------------------------------- noise ---

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1). */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// -------------------------------------------------------------- painter ---

type Pt = [number, number];

/** Paints terrain shapes, always mirrored through the map centre. */
export class Painter {
  constructor(public w: World, public seed: number) {}

  private n(x: number, y: number, scale = 0.35): number {
    return valueNoise(x * scale, y * scale, this.seed) - 0.5;
  }

  /** Paint one tile and its mirror. `only` restricts which terrain may be overwritten. */
  set(tx: number, ty: number, t: Terrain, only?: Terrain[]): void {
    const { w } = this;
    for (const [x, y] of [
      [tx, ty],
      [w.width - 1 - tx, w.height - 1 - ty]
    ] as Pt[]) {
      if (!inBounds(w, x, y)) continue;
      if (only && !only.includes(terrainAt(w, x, y))) continue;
      setTerrain(w, x, y, t);
    }
  }

  /** Organic blob: a disc whose edge wobbles with noise. */
  blob(cx: number, cy: number, r: number, t: Terrain, wobble = 0.35, only?: Terrain[]): void {
    const R = Math.ceil(r * (1 + wobble) + 1);
    for (let ty = Math.floor(cy - R); ty <= cy + R; ty++)
      for (let tx = Math.floor(cx - R); tx <= cx + R; tx++) {
        const d = hypot(tx + 0.5 - cx, ty + 0.5 - cy);
        if (d <= r * (1 + wobble * 2 * this.n(tx, ty))) this.set(tx, ty, t, only);
      }
  }

  /** Thick, gently wobbling polyline (rivers, ridges, roads). */
  stroke(pts: Pt[], width: number, t: Terrain, wobble = 0.25, only?: Terrain[]): void {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      const len = hypot(x1 - x0, y1 - y0);
      const steps = Math.ceil(len * 3);
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps;
        const y = y0 + ((y1 - y0) * s) / steps;
        const r = (width / 2) * (1 + wobble * 2 * this.n(x * 1.7, y * 1.7));
        const R = Math.ceil(r + 1);
        for (let ty = Math.floor(y - R); ty <= y + R; ty++)
          for (let tx = Math.floor(x - R); tx <= x + R; tx++)
            if (hypot(tx + 0.5 - x, ty + 0.5 - y) <= r) this.set(tx, ty, t, only);
      }
    }
  }

  /** Axis-aligned rectangle (inclusive). */
  rect(x0: number, y0: number, x1: number, y1: number, t: Terrain, only?: Terrain[]): void {
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) this.set(tx, ty, t, only);
  }

  /** Scatter small blobs of `t` with the given density over a region. */
  scatter(x0: number, y0: number, x1: number, y1: number, count: number, r: number, t: Terrain, only?: Terrain[]): void {
    for (let i = 0; i < count; i++) {
      const x = x0 + hash(i, 17, this.seed) * (x1 - x0);
      const y = y0 + hash(i, 91, this.seed) * (y1 - y0);
      this.blob(x, y, r * (0.6 + hash(i, 5, this.seed) * 0.8), t, 0.4, only);
    }
  }
}

const G = Terrain.Ground;
const OPEN = [Terrain.Ground, Terrain.Rough, Terrain.Forest];
const LAND = [Terrain.Ground, Terrain.Rough, Terrain.Forest, Terrain.Rock];

// ------------------------------------------------------------------ maps ---

export const MAPS: MapDef[] = [
  {
    id: "proving-grounds",
    name: "Terrain d'essai",
    biome: "temperate",
    size: 48,
    blurb: "Le classique : crêtes rocheuses, un champ disputé. Idéal pour apprendre.",
    hq: [4, 40],
    seed: 5,
    uplinks: [[35.5, 35.5]], // the open corners either side of the ridge
    dropSites: [[20.5, 28.5], [30.5, 30.5], [8.5, 22.5]], // below the ridge gap, the south shoulder, the west flank
    paint() {
      /* painted by createClassicTerrain (kept tile-exact for the test suite) */
    }
  },
  {
    id: "riverlands",
    name: "Terres fluviales",
    biome: "temperate",
    size: 56,
    blurb: "Un large fleuve coupe la vallée. Un pont, deux gués boueux.",
    hq: [4, 48],
    seed: 11,
    uplinks: [[28, 28], [45.5, 45.5]], // the bridge at the centre and the two fords
    dropSites: [[24.5, 33.5], [16.5, 21.5], [34.5, 44.5]], // the bridgehead, the west bank by the ford, the south expansion
    paint(p) {
      // meandering river from the NW corner to the centre (mirrored to SE)
      const river: Pt[] = [[-2, 1], [5, 6], [11, 13], [17, 16], [23, 23], [28, 28]];
      p.stroke(river, 4.2, Terrain.Water, 0.2);
      // banks: reeds and mud along the water, woods behind
      p.stroke(river, 7, Terrain.Rough, 0.35, [G]);
      p.blob(12, 27, 3.4, Terrain.Forest, 0.45, OPEN);
      p.blob(27, 42, 3.8, Terrain.Forest, 0.45, OPEN);
      p.blob(3, 21, 3, Terrain.Forest, 0.45, OPEN);
      p.blob(39, 51, 3.2, Terrain.Forest, 0.45, OPEN);
      p.blob(18, 52, 2.2, Terrain.Forest, 0.45, OPEN);
      // rocky outcrops shaping the approaches
      p.blob(21, 45, 2.2, Terrain.Rock, 0.4, OPEN);
      p.blob(8, 33, 1.6, Terrain.Rock, 0.4, OPEN);
      p.blob(33, 35, 1.8, Terrain.Rock, 0.3, OPEN);
      // crossings: a stone bridge at the centre, shallow fords near the ends
      p.stroke([[23, 32], [32, 23]], 2.2, Terrain.Bridge, 0, [Terrain.Water]);
      p.stroke([[23, 32], [32, 23]], 2.2, Terrain.Road, 0, [G, Terrain.Rough, Terrain.Forest]);
      p.stroke([[8, 14], [13, 9]], 3, Terrain.Shallows, 0.1, [Terrain.Water]);
      // roads from each HQ to the bridge
      p.stroke([[6, 49], [11, 46], [16, 40], [21, 35], [23.5, 32]], 2, Terrain.Road, 0, OPEN);
      // resources: home field, natural expansion, contested crystals
      p.blob(13, 44, 2.1, Terrain.Scrap, 0.25);
      p.blob(5, 36, 1.7, Terrain.Scrap, 0.25);
      p.blob(19, 30, 1.5, Terrain.Crystal, 0.2);
      p.blob(34, 46, 1.6, Terrain.Scrap, 0.25);
    }
  },
  {
    id: "dune-sea",
    name: "Mer de dunes",
    biome: "desert",
    size: 56,
    blurb: "Sables ouverts entre de hautes mesas. Trois voies, riches épaves.",
    hq: [4, 48],
    seed: 23,
    uplinks: [[41.5, 41.5]], // out on the two open flanks (the oasis holds the centre)
    dropSites: [[24.5, 31.5], [31.5, 36.5], [22.5, 35.5]], // the oasis approaches and the near crystals
    paint(p) {
      // two great mesas flank the central corridor
      p.blob(17, 23, 6.2, Terrain.Rough, 0.3, [G]);
      p.blob(17, 23, 4.8, Terrain.Rock, 0.3);
      p.blob(9, 13, 3, Terrain.Rough, 0.3, [G]);
      p.blob(9, 13, 2, Terrain.Rock, 0.35);
      p.blob(25, 45, 2.6, Terrain.Rough, 0.3, [G]);
      p.blob(25, 45, 1.7, Terrain.Rock, 0.35);
      // oases: a central pool with palms, and corner springs
      p.blob(27.5, 27.5, 3.6, Terrain.Forest, 0.3, [G, Terrain.Rough]);
      p.blob(27.5, 27.5, 2.1, Terrain.Water, 0.2);
      p.blob(4, 4, 3.2, Terrain.Forest, 0.35, [G]);
      p.blob(3, 3, 2, Terrain.Water, 0.3);
      // dusty tracks along the central corridor, swinging round the oasis
      p.stroke([[6, 49], [12, 44], [18, 38], [22, 34], [25, 32.5], [31, 31]], 2, Terrain.Road, 0, OPEN);
      // resources
      p.blob(13, 44, 2.1, Terrain.Scrap, 0.25);
      p.blob(4, 35, 1.8, Terrain.Scrap, 0.25);
      p.blob(8, 24, 1.5, Terrain.Scrap, 0.25);
      p.blob(22, 35, 1.5, Terrain.Crystal, 0.2);
      p.blob(34, 44, 1.5, Terrain.Crystal, 0.2);
      // scree fields slow the flanks
      p.scatter(30, 36, 50, 54, 5, 1.6, Terrain.Rough, [G]);
    }
  },
  {
    id: "frostbite",
    name: "Engelure",
    biome: "arctic",
    size: 48,
    blurb: "Une mer gelée au centre. Courte, brutale, idéale pour aéroglisseurs.",
    hq: [4, 40],
    seed: 37,
    uplinks: [[35.5, 35.5]], // the two lanes around the frozen sea, by the lane crystals
    dropSites: [[9.5, 13.5], [29.5, 35.5], [12.5, 22.5]], // a lane crystal, the south lane, the western shallows
    paint(p) {
      // central icy sea — ground armies must skirt it
      p.blob(23.5, 23.5, 9.5, Terrain.Water, 0.18);
      p.blob(23.5, 23.5, 11.5, Terrain.Shallows, 0.2, [G]);
      // snowy pine woods
      p.blob(15, 38, 2.4, Terrain.Forest, 0.4, OPEN);
      p.blob(5, 26, 3, Terrain.Forest, 0.45, OPEN);
      p.blob(26, 44, 2.6, Terrain.Forest, 0.45, OPEN);
      p.blob(2, 12, 2.4, Terrain.Forest, 0.45, OPEN);
      // ridges near the bases
      p.stroke([[12, 30], [9, 31], [7, 33]], 1.8, Terrain.Rock, 0.3, OPEN);
      p.blob(34, 41, 1.8, Terrain.Rock, 0.4, OPEN);
      // slush in the lanes
      p.blob(8, 8, 3, Terrain.Rough, 0.4, [G]);
      p.blob(20, 42, 2, Terrain.Rough, 0.4, [G]);
      // plowed road
      p.stroke([[6, 41], [11, 42], [18, 43], [24, 44]], 1.8, Terrain.Road, 0, OPEN);
      // resources: home field, contested crystal in each lane
      p.blob(11, 36, 2, Terrain.Scrap, 0.25);
      p.blob(9, 9, 1.6, Terrain.Crystal, 0.2);
      p.blob(3, 31, 1.4, Terrain.Scrap, 0.25);
    }
  },
  {
    id: "ashlands",
    name: "Terres de cendres",
    biome: "volcanic",
    size: 64,
    blurb: "Des rivières de lave taillent trois plateaux. Ponts stratégiques, l'air domine.",
    hq: [5, 55],
    seed: 53,
    uplinks: [[44.5, 44.5]], // the outer plateaus, past the bridges
    dropSites: [[27.5, 33.5], [12.5, 30.5], [32.5, 40.5]], // the central plateau, the west plateau, below the south bridge
    paint(p) {
      // a lava river between the blue plateau and the central one (mirrored)
      const lava: Pt[] = [[-2, 12], [8, 21], [16, 27], [26, 38], [36, 46], [44, 55], [52, 66]];
      p.stroke(lava, 3.6, Terrain.Water, 0.25);
      p.stroke(lava, 6.5, Terrain.Rough, 0.4, [G]);
      // metal bridges across
      p.stroke([[9, 26], [14, 21]], 2.2, Terrain.Bridge, 0, [Terrain.Water]);
      p.stroke([[9, 26], [14, 21]], 2.2, Terrain.Road, 0, OPEN);
      p.stroke([[30, 47], [35, 42]], 2.2, Terrain.Bridge, 0, [Terrain.Water]);
      p.stroke([[30, 47], [35, 42]], 2.2, Terrain.Road, 0, OPEN);
      // plated roads from the HQ to both bridges
      p.stroke([[7, 56], [10, 48], [11, 36], [11.5, 24]], 2, Terrain.Road, 0, OPEN);
      p.stroke([[8, 57], [18, 53], [28, 50], [32, 45]], 2, Terrain.Road, 0, OPEN);
      // obsidian spires and dead woods
      p.blob(20, 58, 2.2, Terrain.Rock, 0.4, OPEN);
      p.blob(3, 42, 2.4, Terrain.Rock, 0.4, OPEN);
      p.blob(31.5, 31.5, 2.2, Terrain.Rock, 0.3, OPEN);
      p.blob(22, 31, 2.4, Terrain.Forest, 0.45, OPEN);
      p.blob(16, 44, 2.8, Terrain.Forest, 0.45, OPEN);
      p.blob(4, 5, 3, Terrain.Forest, 0.45, OPEN);
      // resources: home, safe expansion, contested crystal on the centre plateau
      p.blob(14, 51, 2.2, Terrain.Scrap, 0.25);
      p.blob(4, 32, 1.8, Terrain.Scrap, 0.25);
      p.blob(24, 24, 1.6, Terrain.Crystal, 0.2, LAND);
      p.blob(17, 12, 1.8, Terrain.Scrap, 0.25, LAND);
    }
  },
  {
    id: "archipelago",
    name: "Archipel",
    biome: "tropical",
    size: 108,
    blurb: "Relais insulaires que seule l'infanterie peut prendre : amène-la en Montgolfière. Deux ponts.",
    hq: [14, 88],
    seed: 71,
    // island relays: infantry only, paid while crewed; the richer ones sit
    // farther from every shore (home islands lie off each side's own coast)
    uplinks: [
      { at: [54, 54], infantryOnly: true, income: 5, charge: 0.04 }, // the centre island
      { at: [6.5, 35], infantryOnly: true, income: 2.5, charge: 0.025 }, // blue's home isle in the NW gulf (red's in the SE)
      { at: [35, 8.5], infantryOnly: true, income: 2.5, charge: 0.025 }, // red's home isle in the NW gulf (blue's in the SE)
      { at: [18, 18.5], infantryOnly: true, income: 3.5, charge: 0.03 } // the outer isle, out in the gulf
    ],
    dropSites: [[36, 56], [28, 70], [58, 82]], // bridge 1's landing, the inland flank, bridge 2's landing
    startUnits: ["condor"],
    squadAboard: true,
    lifeline: true,
    islands: true,
    hqTrickle: 3,
    bannedMutators: ["airwar"],
    lastStand: false,
    starSecs: 720,
    paint(p) {
      const S = p.w.width;
      const V = S * Math.SQRT2; // the long diagonal, NW corner (0) to SE corner (V)
      const deep = Terrain.Deep;
      // the sea: a channel along the NW–SE diagonal between the two coasts —
      // necked at the two bridges, a lagoon round the centre island — opening
      // into a wide gulf in each empty corner
      const halfWidth = (v: number): number => {
        const dv = Math.abs(v - V / 2);
        if (dv <= 4) return 14;
        if (dv <= 12) return 14 - ((dv - 4) / 8) * 5;
        return 9;
      };
      for (let ty = 0; ty < S; ty++)
        for (let tx = 0; tx < S; tx++) {
          const x = tx + 0.5;
          const y = ty + 0.5;
          const u = (x - y) / Math.SQRT2;
          const v = (x + y) / Math.SQRT2;
          const dv = Math.abs(v - V / 2);
          // ragged coasts, kept straight where the bridges cross
          const calm = dv > 13 && dv < 21 ? 0.15 : 1;
          const rag = (valueNoise(x * 0.18, y * 0.18, p.seed) - 0.5) * 4 * calm;
          const h = halfWidth(v) + rag;
          // the NW gulf (the Painter mirrors it into the SE): a bay 40 tiles
          // round the corner, its shore swung in and out by broad headlands
          // and coves, fading out short of the necks so they keep their shape
          const gulf =
            40 -
            hypot(x - 8, y - 8) +
            (valueNoise(x * 0.06, y * 0.06, p.seed + 12) - 0.5) * 10 +
            rag -
            Math.max(0, 28 - dv) * 1.5;
          if (Math.abs(u) < h || gulf > 0) p.set(tx, ty, deep);
          else if (Math.abs(u) < h + 1.3 || gulf > -1.3) p.set(tx, ty, Terrain.Water, [G]); // a shelf of shallow water off every coast
        }
      // the islands, each a few overlapping lobes (the first holds the relay):
      // a shelf of water, a walkable top at least 4 tiles round each relay
      const island = (lobes: [number, number, number][], wobble = 0.16) => {
        for (const [cx, cy, r] of lobes) p.blob(cx, cy, r + 1.4, Terrain.Water, wobble, [deep]);
        for (const [cx, cy, r] of lobes) p.blob(cx, cy, r, G, wobble, [deep, Terrain.Water]);
      };
      island([[54, 54, 5.2]], 0.12); // the centre island
      island([[18, 18.5, 5.2], [13.8, 14, 2.9], [22.2, 22.4, 2.2]]); // the outer isle: the biggest, long and ragged
      island([[6.5, 35, 4.9], [3.8, 30.6, 2], [10.4, 37.6, 2.2]]); // blue's home isle
      island([[35, 8.5, 5], [33.4, 13.4, 2.3]]); // red's home isle: rounder
      // island cover: woods for squads to hold in, scree to dodge round
      p.blob(52.5, 56.5, 1.6, Terrain.Forest, 0.4, [G]);
      p.blob(13.6, 13.8, 2, Terrain.Forest, 0.4, [G]);
      p.blob(22.4, 22.6, 1.2, Terrain.Rough, 0.4, [G]);
      p.blob(10.6, 37.8, 1.5, Terrain.Forest, 0.4, [G]);
      p.blob(37.6, 5.6, 1.4, Terrain.Forest, 0.4, [G]);
      p.blob(33.2, 13.6, 1.2, Terrain.Rough, 0.3, [G]);
      // and the scenery between them: reef shoals, and sea stacks no unit can stand on
      const stack = (cx: number, cy: number, r: number) => {
        p.blob(cx, cy, r + 1.2, Terrain.Water, 0.3, [deep]);
        p.blob(cx, cy, r, Terrain.Rock, 0.3, [deep, Terrain.Water]);
      };
      p.blob(28.5, 29.5, 2.4, Terrain.Water, 0.4, [deep]);
      p.blob(4.5, 4.5, 2, Terrain.Water, 0.4, [deep]);
      stack(9.5, 2.8, 0.9);
      stack(4, 11.5, 0.7);
      stack(2.6, 20, 0.8);
      stack(31, 35, 0.9);
      // the two bridges (one stroke: the Painter mirrors it), straight across the necks
      p.stroke([[33.4, 50.6], [50.6, 33.4]], 2.4, Terrain.Bridge, 0, [deep, Terrain.Water]);
      // roads from the HQ to both bridgeheads
      p.stroke([[16, 88], [22, 78], [27, 66], [31, 56], [33.6, 50.4]], 2, Terrain.Road, 0, OPEN);
      p.stroke([[18, 90], [30, 88], [42, 84], [52, 79], [57.6, 74.4]], 2, Terrain.Road, 0, OPEN);
      // the mainland: woods, rock outcrops and mud shaping the lanes
      p.blob(36, 74, 3.2, Terrain.Forest, 0.45, OPEN);
      p.blob(20, 56, 3, Terrain.Forest, 0.45, OPEN);
      p.blob(46, 94, 2.8, Terrain.Forest, 0.45, OPEN);
      p.blob(8, 56, 2.4, Terrain.Forest, 0.45, OPEN);
      p.blob(6, 100, 2.6, Terrain.Forest, 0.45, OPEN);
      p.blob(28, 80, 1.8, Terrain.Rock, 0.4, OPEN);
      p.blob(42, 64, 2, Terrain.Rock, 0.35, OPEN);
      p.blob(12, 66, 1.6, Terrain.Rock, 0.4, OPEN);
      p.blob(56, 90, 1.7, Terrain.Rock, 0.4, OPEN);
      p.blob(30, 102, 1.5, Terrain.Rock, 0.4, OPEN);
      p.scatter(22, 60, 40, 72, 4, 1.4, Terrain.Rough, [G]);
      // resources are scarce: one home field and a crystal patch by bridge 1
      p.rect(21, 91, 23, 93, Terrain.Scrap); // 9 tiles, 13,500 scrap
      p.rect(29, 58, 30, 58, Terrain.Crystal); // 2 rich tiles out by the bridge
    }
  }
];

/** A map by id: a built-in one, or a generated one ("random-<biome>-<code>", mapgen.ts); else the first map. */
export const mapById = (id: string): MapDef =>
  MAPS.find((m) => m.id === id) ?? (isRandomMapId(id) ? randomMapDef(id) : null) ?? MAPS[0]!;

/** Is this a map id the game can build: a built-in map, or a well-formed generated one? */
export const isKnownMapId = (id: string): boolean => MAPS.some((m) => m.id === id) || (isRandomMapId(id) && randomMapDef(id) !== null);

/** The original MVP map layout, tile for tile. */
function createClassicTerrain(w: World): void {
  const S = w.width;
  const mirror = (tx: number, ty: number): Pt => [S - 1 - tx, S - 1 - ty];
  const both = (tx: number, ty: number, t: Terrain) => {
    if (inBounds(w, tx, ty)) setTerrain(w, tx, ty, t);
    const [mx, my] = mirror(tx, ty);
    if (inBounds(w, mx, my)) setTerrain(w, mx, my, t);
  };
  // Central ridge with two gaps (chokepoints), running NW–SE across the middle.
  for (let i = -14; i <= 14; i++) {
    const tx = 24 + i;
    const ty = 24 - Math.round(i * 0.35);
    if (Math.abs(i) === 5 || Math.abs(i) === 6) continue; // the gaps
    both(tx, ty, Terrain.Rock);
    both(tx, ty + 1, Terrain.Rock);
  }
  // Rock clusters shielding each base's flank.
  for (const [cx, cy] of [
    [14, 30],
    [30, 42]
  ] as const)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (Math.abs(dx) + Math.abs(dy) < 2) both(cx + dx, cy + dy, Terrain.Rock);
  // Home scrap field near the blue base (mirrored for red).
  for (let ty = 36; ty <= 38; ty++) for (let tx = 12; tx <= 14; tx++) both(tx, ty, Terrain.Scrap);
  // Contested central field (self-mirroring around the centre).
  for (let ty = 22; ty <= 25; ty++)
    for (let tx = 22; tx <= 25; tx++)
      if (w.terrain[ty * S + tx] === Terrain.Ground) setTerrain(w, tx, ty, Terrain.Scrap);
  // Side fields on the open western flank (mirrored: red's on the east):
  // the second field each side expands to once the home field runs dry,
  // out on the lane that skirts the ridge, so holding it takes an army.
  for (let ty = 27; ty <= 29; ty++) for (let tx = 3; tx <= 5; tx++) both(tx, ty, Terrain.Scrap);
}

/**
 * Per-match setup beyond the map itself. Every field is optional and the
 * defaults reproduce the classic skirmish start exactly (tests rely on it).
 */
export interface MatchOptions {
  /** Match seed for deterministic randomness (see rand.ts). Default: the map's seed. */
  seed?: number;
  /** Last Stand: no red base; a wave director attacks blue instead (modes/survival.ts). */
  survival?: SurvivalOptions;
  /** Match mutators for both sides (rules.ts). */
  mutators?: MutatorId[];
  /** Ops: play this scenario (ops.ts) — its own rules, enemy, setup and goals. */
  op?: string;
  /** Quick-start opener per side (see openers.ts). Default: the classic start. */
  openers?: Partial<Record<Faction, OpenerId>>;
  /** Uplink relays and supply drops (objectives.ts). Default: off (the classic skirmish). */
  objectives?: boolean;
  /** The nation each side plays (PANACHE-CONCEPTION.md §1.10): both, or absent = Classique. */
  nations?: Partial<Record<Faction, Nation>>;
}

/**
 * Build a ready-to-play world for a map: terrain, HQs, a starting harvester
 * and a starting Trooper Squad per side.
 */
export function createMapWorld(id: string, opts: MatchOptions = {}): World {
  const def = mapById(id);
  const w = createWorld(def.size, def.size);
  w.mapId = def.id;
  w.biome = def.biome;
  w.seed = (opts.seed ?? def.seed) >>> 0;
  if (def.id === "proving-grounds") createClassicTerrain(w);
  else if (def.random) {
    const g = def.random.terrain;
    for (let i = 0; i < g.length; i++) setTerrain(w, i % def.size, Math.floor(i / def.size), g[i] as Terrain);
  }
  else {
    def.paint(new Painter(w, def.seed));
    clearBase(w, def);
  }
  const [hx, hy] = def.hq;
  const hs = BUILDINGS.hq.size;
  const rx = def.size - hx - hs;
  const ry = def.size - hy - hs;
  spawnBuilding(w, "hq", "blue", hx, hy);
  spawnBuilding(w, "hq", "red", rx, ry);
  // starting harvester just east of each HQ (mirrored: west of red's)
  spawnUnit(w, "harvester", "blue", hx + hs + 1.5, hy + 1.5);
  spawnUnit(w, "harvester", "red", rx - 1.5, ry + 1.5);
  // every side also starts with a Trooper Squad, on the HQ's other flank
  // (west of blue's, east of red's: the mirror image, snapped onto ground a
  // squad can stand on in the side's own frame)
  const squads = (["blue", "red"] as const).map((f) => {
    const at = f === "blue" ? { x: hx - 1.5, y: hy + 1.5 } : { x: def.size - hx + 1.5, y: def.size - hy - 1.5 };
    const p = dropPoint(w, f, at.x, at.y) ?? at;
    return spawnUnit(w, "trooper", f, p.x, p.y);
  });
  const mutators = (opts.mutators ?? []).filter((m) => !mapBansMutator(def, m));
  if (mutators.length || opts.nations) applyMutators(w, mutators, opts.nations);
  const skirmish = !opts.survival && !opts.op;
  if (skirmish) applyMapRules(w, def);
  if (rulesOf(w).islands) {
    // home land outlives the HQ (it falls, or Nomads never builds one): world.ts onHomeLand
    const tile = (x: number, y: number): [number, number] => [x + (hs >> 1), y + (hs >> 1)];
    w.rules!.homeTiles = { blue: tile(hx, hy), red: tile(rx, ry) };
  }
  if (skirmish && rulesOf(w).nomads) nomadStart(w); // (the HQs become anchored Goliaths)
  // Goliath Armada: nothing but four Goliaths in the air, each under two Condors (no squad, no opener)
  const armada = skirmish && !!rulesOf(w).armada;
  if (armada) armadaStart(w);
  const starters = armada ? [] : squads;
  for (const u of starters) applySpawnRank(w, u); // (Veterans: it rolls out ranked like every combat unit)
  // Airborne: a Condor and the other two squads, parked round the starting one
  // (the island map's Condor too)
  const extra = rulesOf(w).startUnits;
  if (extra.length)
    for (const u of starters) {
      const ids = spawnStartUnits(w, u.faction, extra, u);
      const condor = ids.map((id) => w.units.get(id)!).find((c) => c.kind === "condor");
      if (condor && skirmish && def.startUnits?.includes("condor")) {
        condor.free = true; // the map's, not bought
        if (def.squadAboard) stowAboard(w, condor, u);
      }
    }
  if (skirmish && def.lifeline) setupLifeline(w);
  // openers and map objectives belong to the skirmish; Last Stand and Ops set up their own
  if (skirmish) {
    for (const f of ["blue", "red"] as const) {
      const o = opts.openers?.[f];
      if (o && !armada) applyOpener(w, f, o);
    }
    if (opts.objectives) setupObjectives(w, def.uplinks, def.dropSites);
  }
  if (opts.survival) setupSurvival(w, opts.survival);
  if (opts.op) setupOp(w, opts.op);
  return w;
}

/** The map's own match rules (skirmish): its start units, HQ trickle and free Condors. */
function applyMapRules(w: World, def: MapDef): void {
  if (!def.startUnits?.length && def.hqTrickle === undefined && !def.lifeline && !def.islands) return;
  const r = w.rules ? { ...w.rules } : makeRules([]);
  w.rules = r;
  // (Goliath Armada: the Goliaths' Condors are all a side starts with)
  const extra = r.armada ? [] : (def.startUnits ?? []).filter((k) => !bannedBy(w, k));
  r.startUnits = [...r.startUnits, ...extra.filter((k) => !r.startUnits.includes(k))];
  if (def.hqTrickle !== undefined) r.hqTrickle = def.hqTrickle;
  if (def.lifeline && !bannedBy(w, "condor")) r.lifeline = true;
  if (def.islands) r.islands = true;
}

/** Guarantee open, buildable ground around each HQ. */
export function clearBase(w: World, def: MapDef): void {
  const [hx, hy] = def.hq;
  const cx = hx + 1.5;
  const cy = hy + 1.5;
  const keep = new Set<Terrain>([Terrain.Road, Terrain.Scrap, Terrain.Crystal]);
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const d = hypot(tx + 0.5 - cx, ty + 0.5 - cy);
      if (d > 5.2) continue;
      for (const [x, y] of [
        [tx, ty],
        [w.width - 1 - tx, w.height - 1 - ty]
      ] as Pt[])
        if (!keep.has(terrainAt(w, x, y))) setTerrain(w, x, y, Terrain.Ground);
    }
}
