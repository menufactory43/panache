import { BUILDINGS, UNITS } from "./balance";
import { behaves, nationKind } from "./nations";
import { canPlaceBuilding, inBaseRange } from "./economy";
import { anchoredGoliaths } from "./goliath";
import { hash32, saltOf } from "./rand";
import { MUTATORS, applySpawnRank, bannedBy, rulesOf } from "./rules";
import { Terrain, type BuildingKind, type Faction, type UnitKind, type World } from "./types";
import {
  buildingCenter,
  hqOf,
  inBounds,
  isResource,
  moveClassOf,
  passable,
  sideFrame,
  spawnBuilding,
  spawnUnit,
  terrainAt,
  type SideFrame
} from "./world";
// type-only: the AI module imports the sim, never the other way round at runtime
import type { StrategyName } from "./ai/commander";
import { atan2, hypot } from "./fmath";
import { tr } from "../lang";

/**
 * Quick-start openers. Instead of the classic "HQ + one harvester, now wait"
 * start, each side picks one of three opening packages before the clock
 * starts. Every opener adds a second harvester; the rest is what makes the
 * pick a decision: an army now, a bigger economy, or an air force.
 */
export type OpenerId = "blitz" | "industry" | "airwing";

export interface OpenerDef {
  id: OpenerId;
  name: string;
  /** Punchy one-liner for the card. */
  tagline: string;
  /** Banner line once it rolls out. */
  rollout: string;
  /** Pre-built production building. */
  building: BuildingKind;
  /** Units waiting beside it. */
  units: UnitKind[];
  /** Harvesters the side starts with in total (the classic start has 1). */
  harvesters: number;
  /** Scrap added to (or, if negative, taken from) the starting stockpile. */
  scrap: number;
}

export const OPENERS: Record<OpenerId, OpenerDef> = {
  blitz: {
    id: "blitz",
    name: "Blitz",
    tagline: tr("Frappe en premier. Raide leurs Fardiers avant qu'ils soient prêts.", "Strike first. Raid their Steam Wagons before they're ready."),
    rollout: tr("3 Panhard prêts. Frappe leurs Fardiers !", "3 Panhards ready. Hit their Steam Wagons!"),
    building: "fab-plant",
    units: ["stinger", "stinger", "stinger"],
    harvesters: 2,
    // an army at 0:00 is worth more than it costs: pay for it out of the bank
    scrap: -100
  },
  industry: {
    id: "industry",
    name: tr("Industrie", "Industry"),
    tagline: tr("Extrais plus qu'eux maintenant, produis plus qu'eux ensuite.", "Out-mine them now, out-produce them later."),
    rollout: tr("3 Fardiers au travail. Surproduis-les.", "3 Steam Wagons at work. Outproduce them."),
    building: "fab-plant",
    units: [],
    harvesters: 3,
    scrap: 200
  },
  airwing: {
    id: "airwing",
    name: tr("Escadrille", "Air Wing"),
    tagline: tr("Domine le ciel. Les Éole chassent chars et Fardiers.", "Rule the sky. Éoles hunt tanks and Steam Wagons."),
    rollout: tr("3 Éole prêts. Gare à leur DCA.", "3 Éoles ready. Mind their flak."),
    building: "airpad",
    // the Airpad is a side-grade (you still want a Fab for anti-air and
    // tanks), so the wing carries a third Wasp
    units: ["wasp", "wasp", "wasp"],
    harvesters: 2,
    scrap: 0
  }
};

export const OPENER_IDS: OpenerId[] = ["blitz", "industry", "airwing"];

export const isOpenerId = (s: unknown): s is OpenerId =>
  typeof s === "string" && (OPENER_IDS as string[]).includes(s);

/** Scrap value of what sets an opener apart (the second harvester they all share is left out). */
export function openerValue(id: OpenerId): number {
  const o = OPENERS[id];
  return (
    BUILDINGS[o.building].cost +
    o.units.reduce((s, k) => s + UNITS[k].cost, 0) +
    (o.harvesters - 2) * UNITS.harvester.cost +
    o.scrap
  );
}

/**
 * The AI's pick, by personality: Rush blitzes, Boom booms, the air
 * commanders take the Air Wing; Balanced picks any of the three and
 * Ironclad either ground opener, seeded so a match replays identically.
 */
export function pickAiOpener(strategy: StrategyName, seed: number, faction: Faction): OpenerId {
  const roll = hash32(seed, saltOf("opener"), faction === "blue" ? 0 : 1);
  switch (strategy) {
    case "rush":
      return "blitz";
    case "boom":
      return "industry";
    case "airswarm":
    case "skyforce":
      return "airwing";
    case "ironclad":
      return roll % 2 === 0 ? "blitz" : "industry";
    default:
      return OPENER_IDS[roll % OPENER_IDS.length]!;
  }
}

/** Why this side can't take this opener under the match rules (a banned factory or crew), or null. */
export function openerBlocked(w: World, faction: Faction, id: OpenerId): string | null {
  if (rulesOf(w).armada) return tr(`Désactivé : ${MUTATORS.armada.name}`, `Disabled: ${MUTATORS.armada.name}`); // (a side starts with its Goliaths and nothing else)
  const o = OPENERS[id];
  // (with nations, each Classique unit stands for its nation's kind of the same role: a République blitz brings Jamais-Contente)
  for (const kind of [o.building, ...o.units.map((k) => nationKind(w, faction, k))]) {
    const why = bannedBy(w, kind, faction);
    if (why) return why;
  }
  return null;
}

/** `preferred` if the rules allow it, else the first opener they do (null if none). */
export function allowedOpener(w: World, faction: Faction, preferred: OpenerId): OpenerId | null {
  if (!openerBlocked(w, faction, preferred)) return preferred;
  return OPENER_IDS.find((id) => !openerBlocked(w, faction, id)) ?? null;
}

export interface AppliedOpener {
  buildingId: number | null;
  /** Every unit the opener spawned (harvesters included). */
  unitIds: number[];
}

/**
 * Hand `faction` its opener: the pre-built factory on open ground near the
 * HQ toward the map centre, units parked in front of it, the extra
 * harvesters beside the HQ, all harvesters set mining.
 *
 * Fairness: every search runs in the faction's own frame (red's view is the
 * map rotated 180°, exactly how maps are mirrored), with the same scan
 * order and tie-breaks, so both sides get mirror-image setups.
 */
export function applyOpener(w: World, faction: Faction, id: OpenerId): AppliedOpener {
  const o = OPENERS[id];
  const out: AppliedOpener = { buildingId: null, unitIds: [] };
  const base = basePoint(w, faction);
  if (!base) return out;
  const fr = frame(w, faction);
  const hqC = fr.pt(base);
  const field = nearestResourceInFrame(w, fr, hqC);
  const centre = { x: w.width / 2, y: w.height / 2 };

  const site = findSite(w, faction, fr, o.building, hqC, field, centre);
  let front = hqC;
  if (site) {
    const size = BUILDINGS[o.building].size;
    const [tx, ty] = fr.tile(site.fx, site.fy, size);
    const outpost = !inBaseRange(w, faction, tx + size / 2, ty + size / 2); // (Nomads: built round the Goliath)
    const b = spawnBuilding(w, o.building, faction, tx, ty);
    if (outpost) b.outpost = true;
    out.buildingId = b.id;
    front = fr.pt(buildingCenter(b));
  }

  // units wait on the enemy-facing side of their factory
  const unitsAt = toward(front, centre, 2.5);
  for (const kind of o.units.map((k) => nationKind(w, faction, k))) {
    const p = freeSpot(w, fr, kind, unitsAt, front);
    if (p) out.unitIds.push(spawnFacing(w, faction, kind, fr, p, centre).id);
  }

  // extra harvesters line up between the HQ and its field
  const have = [...w.units.values()].filter((u) => u.faction === faction && behaves(u.kind, "harvester")).length;
  const worker = nationKind(w, faction, "harvester");
  const harvestAt = field ? toward(hqC, { x: field.x + 0.5, y: field.y + 0.5 }, 2.6) : hqC;
  for (let i = have; i < o.harvesters; i++) {
    const p = freeSpot(w, fr, worker, harvestAt, hqC);
    if (p) out.unitIds.push(spawnFacing(w, faction, worker, fr, p, field ? { x: field.x + 0.5, y: field.y + 0.5 } : centre).id);
  }

  w.factions[faction].scrap += o.scrap;

  // every idle harvester heads for the home field right away
  if (field) {
    const [wx, wy] = fr.tile(field.x, field.y, 1);
    for (const u of w.units.values())
      if (u.faction === faction && behaves(u.kind, "harvester") && u.order.type === "idle")
        u.order = { type: "harvest", fieldX: wx, fieldY: wy, phase: "toField" };
  }
  return out;
}

/**
 * Extra starting units (the Airborne mutator's Condor and squads), parked
 * round the side's starting Trooper Squad at `near` (world coords) on the
 * HQ's flank, facing the map centre: squads on the open tiles beside it, the
 * Condor two tiles up the flank (toward the enemy's edge of the map) so it
 * doesn't hide them. Searched in the side's own frame, where every HQ sits
 * bottom left, so both sides get mirror-image setups.
 */
export function spawnStartUnits(w: World, faction: Faction, kinds: readonly UnitKind[], near: Pt): number[] {
  const fr = frame(w, faction);
  const at = fr.pt(near);
  const centre = { x: w.width / 2, y: w.height / 2 };
  const ids: number[] = [];
  for (const kind of kinds) {
    const target = UNITS[kind].domain === "air" ? { x: at.x, y: at.y - 2 } : at;
    const p = freeSpot(w, fr, kind, target, at);
    if (p) ids.push(spawnFacing(w, faction, kind, fr, p, centre).id);
  }
  return ids;
}

/** Where applyOpener would put a `kind` for this side right now (world tile), or null. */
export function predictOpenerSite(w: World, faction: Faction, kind: BuildingKind): { tx: number; ty: number } | null {
  const base = basePoint(w, faction);
  if (!base) return null;
  const fr = frame(w, faction);
  const hqC = fr.pt(base);
  const site = findSite(w, faction, fr, kind, hqC, nearestResourceInFrame(w, fr, hqC), { x: w.width / 2, y: w.height / 2 });
  if (!site) return null;
  const [tx, ty] = fr.tile(site.fx, site.fy, BUILDINGS[kind].size);
  return { tx, ty };
}

// ------------------------------------------------------------ internals ---

/** Where a side's base is (world coords): its HQ's centre, or under Nomads its anchored Goliath. */
function basePoint(w: World, faction: Faction): { x: number; y: number } | null {
  const hq = hqOf(w, faction);
  if (hq) return buildingCenter(hq);
  const g = anchoredGoliaths(w, faction)[0];
  return g ? { x: g.x, y: g.y } : null;
}

type Pt = { x: number; y: number };

/** Coordinates as seen from one side: identity for blue, a 180° turn for red (world.ts). */
type Frame = SideFrame;
const frame = sideFrame;

const dist = (a: Pt, b: Pt) => hypot(a.x - b.x, a.y - b.y);

function toward(from: Pt, to: Pt, d: number): Pt {
  const len = Math.max(1e-6, dist(from, to));
  const k = Math.min(1, d / len);
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

/** Nearest resource tile to `p` (straight line), scanned in frame order. Frame tile coords. */
function nearestResourceInFrame(w: World, fr: Frame, p: Pt): Pt | null {
  let best: Pt | null = null;
  let bestD = Infinity;
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, ty * w.width + tx)) continue;
      const d = hypot(fx + 0.5 - p.x, fy + 0.5 - p.y);
      if (d < bestD) {
        bestD = d;
        best = { x: fx, y: fy };
      }
    }
  return best;
}

/** Distance from point p to segment ab. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * Best frame top-left for the opener's building: legal, roughly 4.5 tiles
 * from the HQ toward the map centre, not hugging the HQ (harvesters dock
 * there), not across the harvest route, and never walling anything in.
 */
function findSite(
  w: World,
  faction: Faction,
  fr: Frame,
  kind: BuildingKind,
  hqC: Pt,
  field: Pt | null,
  centre: Pt
): { fx: number; fy: number } | null {
  const size = BUILDINGS[kind].size;
  const anchor = toward(hqC, centre, 4.5);
  const fieldC = field ? { x: field.x + 0.5, y: field.y + 0.5 } : null;
  let best: { fx: number; fy: number } | null = null;
  let bestScore = Infinity;
  const R = 9;
  for (let fy = Math.floor(hqC.y) - R; fy <= Math.floor(hqC.y) + R; fy++)
    for (let fx = Math.floor(hqC.x) - R; fx <= Math.floor(hqC.x) + R; fx++) {
      const [tx, ty] = fr.tile(fx, fy, size);
      if (!canPlaceBuilding(w, faction, kind, tx, ty)) continue;
      if (walledIn(w, tx, ty, size)) continue;
      const c = { x: fx + size / 2, y: fy + size / 2 };
      let score = dist(c, anchor);
      // leave a free ring round the HQ for docking harvesters
      const gap = Math.max(Math.abs(c.x - hqC.x) - (1.5 + size / 2), Math.abs(c.y - hqC.y) - (1.5 + size / 2));
      if (gap < 1) score += 6;
      // and keep off the HQ→field haul route, and off the roads
      if (fieldC && segDist(c, hqC, fieldC) < size / 2 + 1) score += 4;
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) if (terrainAt(w, tx + dx, ty + dy) === Terrain.Road) score += 0.75;
      if (score < bestScore) {
        bestScore = score;
        best = { fx, fy };
      }
    }
  return best;
}

/** Would this footprint leave fewer than half of its surrounding tiles open? */
function walledIn(w: World, tx: number, ty: number, size: number): boolean {
  let free = 0;
  let total = 0;
  for (let i = -1; i <= size; i++)
    for (const [x, y] of [
      [tx + i, ty - 1],
      [tx + i, ty + size],
      [tx - 1, ty + i],
      [tx + size, ty + i]
    ] as [number, number][]) {
      if (!inBounds(w, x, y)) continue;
      total++;
      if (passable(w, x, y, "ground")) free++;
    }
  return free < total / 2;
}

/**
 * The open tile centre nearest `target` (frame coords) where a `kind` can
 * stand without overlapping anyone, searched in rings around `around`.
 */
function freeSpot(w: World, fr: Frame, kind: UnitKind, target: Pt, around: Pt): Pt | null {
  const mc = moveClassOf(kind);
  const cands: { p: Pt; d: number }[] = [];
  const cx = Math.floor(around.x);
  const cy = Math.floor(around.y);
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const p = { x: cx + dx + 0.5, y: cy + dy + 0.5 };
      // only harvesters belong on the scrap fields
      const [tx, ty] = fr.tile(Math.floor(p.x), Math.floor(p.y), 1);
      const onField = inBounds(w, tx, ty) && isResource(w, ty * w.width + tx);
      cands.push({ p, d: dist(p, target) + (onField && kind !== "harvester" ? 3 : 0) });
    }
  // stable sort: ties keep frame scan order, so both sides choose alike
  cands.sort((a, b) => a.d - b.d);
  for (const { p } of cands) {
    const [tx, ty] = fr.tile(Math.floor(p.x), Math.floor(p.y), 1);
    if (!inBounds(w, tx, ty)) continue;
    // aircraft can hover anywhere but still don't park on rooftops
    if (mc === "air" ? w.occupancy[ty * w.width + tx] !== 0 : !passable(w, tx, ty, mc)) continue;
    const wp = fr.pt(p);
    let clear = true;
    for (const u of w.units.values())
      if ((UNITS[u.kind].domain === "air") === (mc === "air") && hypot(u.x - wp.x, u.y - wp.y) < 0.9) {
        clear = false;
        break;
      }
    if (clear) return p;
  }
  return null;
}

function spawnFacing(w: World, faction: Faction, kind: UnitKind, fr: Frame, p: Pt, look: Pt) {
  const wp = fr.pt(p);
  const wl = fr.pt(look);
  const u = spawnUnit(w, kind, faction, wp.x, wp.y);
  applySpawnRank(w, u); // the Veterans mutator ranks opener armies too
  u.facing = u.aim = atan2(wl.x - wp.x, -(wl.y - wp.y));
  return u;
}
