import { BUILDINGS, OBJECTIVES, UNITS } from "./balance";
import type { Building, BuildingKind, Faction, World } from "./types";
import { sightBonus } from "./nations";
import { rulesOf } from "./rules";
import { inBounds } from "./world";

export const enum Vis {
  Unexplored = 0,
  Explored = 1,
  Visible = 2
}

export interface KnownBuilding {
  id: number;
  kind: BuildingKind;
  faction: Faction;
  tx: number;
  ty: number;
}

export interface FactionFog {
  vis: Uint8Array;
  /** Enemy buildings we have seen, kept until re-seen destroyed. */
  known: Map<number, KnownBuilding>;
}

export function createFog(width: number, height: number): Record<Faction, FactionFog> {
  return {
    blue: { vis: new Uint8Array(width * height), known: new Map() },
    red: { vis: new Uint8Array(width * height), known: new Map() }
  };
}

const idx = (w: World, tx: number, ty: number) => ty * w.width + tx;

export function isVisible(w: World, f: Faction, tx: number, ty: number): boolean {
  return inBounds(w, tx, ty) && w.fog[f].vis[idx(w, tx, ty)] === Vis.Visible;
}

export function isExplored(w: World, f: Faction, tx: number, ty: number): boolean {
  return inBounds(w, tx, ty) && w.fog[f].vis[idx(w, tx, ty)]! >= Vis.Explored;
}

export function knownBuildings(w: World, f: Faction): KnownBuilding[] {
  return [...w.fog[f].known.values()];
}

function stamp(w: World, vis: Uint8Array, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(w.height - 1, Math.ceil(cy + radius));
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      // (products, not `** 2`: the exponent operator is as loosely specified as Math.pow, fmath.ts)
      const dx = tx + 0.5 - cx;
      const dy = ty + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) vis[ty * w.width + tx] = Vis.Visible;
    }
}

/** A gas cloud: the tiles under it drop out of sight (explored, not visible). */
function veil(w: World, vis: Uint8Array, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(w.height - 1, Math.ceil(cy + radius));
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const dx = tx + 0.5 - cx;
      const dy = ty + 0.5 - cy;
      if (dx * dx + dy * dy <= r2 && vis[ty * w.width + tx] === Vis.Visible) vis[ty * w.width + tx] = Vis.Explored;
    }
}

function footprintVisible(w: World, f: Faction, b: { kind: BuildingKind; tx: number; ty: number }): boolean {
  const size = BUILDINGS[b.kind].size;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++)
      if (isVisible(w, f, b.tx + dx, b.ty + dy)) return true;
  return false;
}

/** Recompute both factions' visibility and building memory. */
export function tickFog(w: World): void {
  for (const f of ["blue", "red"] as const) {
    const fog = w.fog[f];
    // decay: everything visible becomes merely explored
    for (let i = 0; i < fog.vis.length; i++)
      if (fog.vis[i] === Vis.Visible) fog.vis[i] = Vis.Explored;
    for (const u of w.units.values())
      if (u.faction === f) stamp(w, fog.vis, u.x, u.y, u.tsf ? UNITS[u.kind].sight + sightBonus(u) : UNITS[u.kind].sight);
    for (const b of w.buildings.values())
      if (b.faction === f) {
        const size = BUILDINGS[b.kind].size;
        stamp(w, fog.vis, b.tx + size / 2, b.ty + size / 2, BUILDINGS[b.kind].sight + size / 2);
      }
    for (const l of w.objectives.uplinks)
      if (l.owner === f) stamp(w, fog.vis, l.x, l.y, OBJECTIVES.uplink.sight); // a held Uplink sees around it
    const ns = w.nation;
    // Ballon-sonde: its area is in sight (nations.ts)
    if (ns) for (const z of ns.reveals) if (z.faction === f) stamp(w, fog.vis, z.x, z.y, z.radius);
    // Clear Skies mutator: everything is in sight for both sides
    if (rulesOf(w).fogOff) fog.vis.fill(Vis.Visible);
    // Gaz de houille: the other side's clouds are not, whatever else sees there
    if (ns) for (const z of ns.clouds) if (z.faction !== f) veil(w, fog.vis, z.x, z.y, z.radius);
    // memory: record enemy buildings whose footprint we can see now (a Gantry: always)
    for (const b of w.buildings.values())
      if (b.faction !== f && (BUILDINGS[b.kind].alwaysVisible || footprintVisible(w, f, b)))
        fog.known.set(b.id, { id: b.id, kind: b.kind, faction: b.faction, tx: b.tx, ty: b.ty });
    // forget remembered buildings we can re-see are gone (a Gantry's fall is seen at once)
    for (const [id, kb] of fog.known)
      if (!w.buildings.has(id) && (BUILDINGS[kb.kind].alwaysVisible || footprintVisible(w, f, kb))) fog.known.delete(id);
  }
}

export function buildingSightCenter(b: Building): { x: number; y: number } {
  const size = BUILDINGS[b.kind].size;
  return { x: b.tx + size / 2, y: b.ty + size / 2 };
}
