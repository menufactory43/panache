/**
 * Building placement helpers for the player's touch flow (and anything else
 * that wants to explain or suggest a spot). The rule itself stays
 * `canPlaceBuilding` in economy.ts: these functions only explain why a spot
 * fails and find a good valid one, so they can never disagree with it.
 */
import { BUILDINGS, ECONOMY, GOLIATH, TERRAIN } from "./balance";
import { canPlaceBuilding, inBaseRange } from "./economy";
import { UNIT_IN_THE_WAY, anchoredGoliaths, inGoliathRing, overlapsGoliath } from "./goliath";
import { Terrain, type BuildingKind, type Faction, type World } from "./types";
import { inPowerRange, needsPower, onGrid, powerSources } from "./nations";
import { buildingAtTile, buildingCenter, domainOf, inBounds, terrainAt } from "./world";
import { hypot } from "./fmath";

/** Short names for unbuildable ground, per biome where it differs. */
function groundName(w: World, t: Terrain): string {
  switch (t) {
    case Terrain.Water:
      return w.biome === "volcanic" ? "la lave" : "l'eau";
    case Terrain.Deep:
      return "la haute mer";
    case Terrain.Rock:
      return "la roche";
    case Terrain.Rough:
      return { temperate: "la boue", desert: "les éboulis", arctic: "la neige fondue", volcanic: "les cendres", tropical: "la vase" }[w.biome];
    case Terrain.Forest:
      return "les bois";
    case Terrain.Scrap:
      return "le charbon";
    case Terrain.Crystal:
      return "le radium";
    case Terrain.Bridge:
      return "un pont";
    case Terrain.Shallows:
      return "un gué";
    default:
      return TERRAIN[t].name.toLowerCase();
  }
}

/**
 * Why `kind` can't go at top-left tile (tx, ty), as a short phrase for the
 * HUD ("Too far from base", "Blocked", "Not on water"), or null when it can.
 * Agrees with canPlaceBuilding by construction.
 */
export function placementBlocker(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  tx: number,
  ty: number
): string | null {
  if (canPlaceBuilding(w, faction, kind, tx, ty)) return null;
  const size = BUILDINGS[kind].size;
  let offMap = false;
  let ground: Terrain | null = null;
  let building = false;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!inBounds(w, x, y)) {
        offMap = true;
        continue;
      }
      if (buildingAtTile(w, x, y)) building = true;
      else if (!TERRAIN[terrainAt(w, x, y)].buildable && ground === null) ground = terrainAt(w, x, y);
    }
  if (offMap) return "Hors de la carte";
  // the most fundamental problem first: nothing nearby can be fixed by nudging
  const grid = onGrid(w, faction) && needsPower(kind);
  if (grid && !inPowerRange(w, faction, kind, tx, ty) && !inGoliathRing(w, faction, tx, ty, size)) return "Hors du réseau électrique";
  if (!grid && !inBuildRange(w, faction, tx + size / 2, ty + size / 2) && (kind === "hq" || !inGoliathRing(w, faction, tx, ty, size)))
    return "Trop loin de la base";
  if (ground !== null) return `Impossible sur ${groundName(w, ground)}`;
  if (building) return "Bloqué";
  for (const u of w.units.values())
    if (domainOf(u) === "ground" && u.x >= tx && u.x < tx + size && u.y >= ty && u.y < ty + size)
      return UNIT_IN_THE_WAY;
  if (overlapsGoliath(w, tx, ty, size)) return UNIT_IN_THE_WAY;
  return "Bloqué"; // a rule this explainer doesn't know about yet
}

/**
 * Is a footprint centred at (cx, cy) within build range of `faction`'s base?
 * Outposts (built in a Goliath's ring) never count as base; the rings
 * themselves are inGoliathRing.
 */
export function inBuildRange(w: World, faction: Faction, cx: number, cy: number): boolean {
  return inBaseRange(w, faction, cx, cy);
}

/**
 * Would a footprint here leave no free tile along some side, walling in
 * what's next to it? (Mirrors the AI's own lane-keeping rule.)
 */
function cramped(w: World, tx: number, ty: number, size: number): boolean {
  let free = 0;
  for (let i = -1; i <= size; i++)
    for (const [x, y] of [
      [tx + i, ty - 1],
      [tx + i, ty + size],
      [tx - 1, ty + i],
      [tx + size, ty + i]
    ] as [number, number][]) {
      if (!inBounds(w, x, y)) continue;
      if (w.occupancy[y * w.width + x] === 0 && TERRAIN[terrainAt(w, x, y)].ground) free++;
    }
  return free < (size + 2) * 2;
}

/**
 * The best valid top-left tile for `kind` near `anchor` (tile coords, e.g.
 * the middle of the player's view): the closest spot in build range, with a
 * small penalty for spots that would wall a lane shut. Null if nowhere fits.
 */
export function suggestPlacement(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  anchor: { x: number; y: number }
): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  const seen = new Set<number>();
  let best: { tx: number; ty: number } | null = null;
  let bestScore = Infinity;
  // search around the base's buildings (not outposts: they don't count) and anchored Goliaths' rings
  const centres: { c: { x: number; y: number }; r: number }[] = [];
  for (const b of w.buildings.values())
    if (b.faction === faction && !b.outpost) centres.push({ c: buildingCenter(b), r: Math.ceil(ECONOMY.buildRadius + size) });
  if (kind !== "hq") for (const g of anchoredGoliaths(w, faction)) centres.push({ c: g, r: Math.ceil(GOLIATH.buildRing + size) });
  // (a République building that needs power: round the Réseau électrique's sources, whose reach passes the 6 tiles)
  if (onGrid(w, faction) && needsPower(kind)) for (const s of powerSources(w, faction)) centres.push({ c: s, r: Math.ceil(s.radius + size) });
  for (const { c, r } of centres) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.round(c.x + dx - size / 2);
        const ty = Math.round(c.y + dy - size / 2);
        const key = ty * 4096 + tx;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
        if (d >= bestScore) continue;
        if (!canPlaceBuilding(w, faction, kind, tx, ty)) continue;
        const score = d + (size > 1 && cramped(w, tx, ty, size) ? 4 : 0);
        if (score < bestScore || (score === bestScore && best && (ty < best.ty || (ty === best.ty && tx < best.tx)))) {
          best = { tx, ty };
          bestScore = score;
        }
      }
  }
  return best;
}

/**
 * A finger tap is imprecise: if (tx, ty) is invalid but a valid spot is one
 * tile away, use that (closest first, in a fixed order). Otherwise the tap
 * stands, so the ghost can show why it can't go there.
 */
export function snapPlacement(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  tx: number,
  ty: number
): { tx: number; ty: number } {
  if (canPlaceBuilding(w, faction, kind, tx, ty)) return { tx, ty };
  const ring: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  for (const [dx, dy] of ring)
    if (canPlaceBuilding(w, faction, kind, tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
  return { tx, ty };
}
