import { BUILDINGS, LIFELINE, TICK_RATE } from "./balance";
import { behaves, nationKind } from "./nations";
import { isInfantry } from "./infantry";
import { applySpawnRank, bannedBy, rulesOf } from "./rules";
import { stowAboard } from "./transport";
import type { Faction, Unit, World } from "./types";
import { goliathsOf, hasGoliath, isAnchored } from "./goliath";
import { hqOf, sideFrame, spawnUnit } from "./world";
import { atan2 } from "./fmath";

/**
 * The free replacement Condor (the island map: MapDef.lifeline). Its island
 * Uplinks can only be taken by infantry flown in, so a side must never be
 * left with no way to fly: when a side has no Condor — none in the air, none
 * on an Airpad's queue — a free one is due LIFELINE.delay s later. It flies
 * in from the map edge nearest the HQ and sets down beside it, carrying a
 * free Trooper Squad if the side is short of infantry (LIFELINE.squadUnder).
 * A side with no HQ but a Goliath (Nomads, or fighting on after the HQ fell)
 * is still in the match: its Condor comes to the Goliath (an anchored one
 * first) instead.
 *
 * Free units (Unit.free) leave no wreck and charge no ⚡ meter when lost, so
 * throwing a Condor away gains nothing: a bought one comes back as a free one
 * only after the delay, and the squad only when the side really needs it.
 */

const FACTIONS: Faction[] = ["blue", "red"];

export function setupLifeline(w: World): void {
  w.lifeline = { blue: { due: null, given: 0 }, red: { due: null, given: 0 } };
}

/** Does this side have a Condor flying, or one being built? */
export function hasCondor(w: World, f: Faction): boolean {
  for (const u of w.units.values()) if (u.faction === f && behaves(u.kind, "condor")) return true;
  for (const b of w.buildings.values()) if (b.faction === f && b.queue.some((q) => behaves(q.kind, "condor"))) return true;
  return false;
}

/** Robot infantry squads this side has, on the field or aboard a Condor. */
export function squadCount(w: World, f: Faction): number {
  let n = 0;
  for (const u of w.units.values()) {
    if (u.faction !== f) continue;
    if (isInfantry(u.kind)) n++;
    n += u.passengers?.length ?? 0;
  }
  return n;
}

/** Where a side's replacement Condor appears and where it sets down (world coords). */
export function lifelineRoute(w: World, f: Faction): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  const hq = hqOf(w, f);
  const s = BUILDINGS.hq.size;
  // (no HQ: its base is its Goliath, the dug-in one first, the oldest of a kind)
  const gs = hq ? [] : goliathsOf(w, f);
  const g = gs.find(isAnchored) ?? gs[0];
  const home = hq ? { x: hq.tx + s / 2, y: hq.ty + s / 2 } : g ? { x: g.x, y: g.y } : null;
  if (!home) return null;
  // in the side's own frame its HQ sits bottom left, so the two sides' routes mirror
  const fr = sideFrame(w, f);
  const c = fr.pt(home);
  const inset = LIFELINE.edgeInset;
  const edges = [
    { d: c.x, p: { x: inset, y: c.y } },
    { d: w.height - c.y, p: { x: c.x, y: w.height - inset } },
    { d: c.y, p: { x: c.x, y: inset } },
    { d: w.width - c.x, p: { x: w.width - inset, y: c.y } }
  ];
  let near = edges[0]!;
  for (const e of edges) if (e.d < near.d - 1e-9) near = e;
  // beside the HQ, on its flank away from the edge it came in over (two tiles out)
  const to = { x: c.x + 3, y: c.y - 3 };
  return { from: fr.pt(near.p), to: fr.pt(to) };
}

/** Per tick, after deaths are settled: start, run and pay out each side's free-Condor clock. */
export function tickLifeline(w: World): void {
  const lines = w.lifeline;
  if (!lines || w.winner || !rulesOf(w).lifeline) return;
  for (const f of FACTIONS) {
    const slot = lines[f];
    if ((!hqOf(w, f) && !hasGoliath(w, f)) || bannedBy(w, nationKind(w, f, "condor"), f) || hasCondor(w, f)) {
      slot.due = null;
      continue;
    }
    if (slot.due === null) {
      slot.due = w.tick + Math.round(LIFELINE.delay * TICK_RATE);
      continue;
    }
    if (w.tick < slot.due) continue;
    const route = lifelineRoute(w, f);
    slot.due = null;
    if (!route) continue;
    const condor = flyIn(w, f, route);
    slot.given++;
    w.fx.push({ type: "lifeline", faction: f, id: condor.id, x: condor.x, y: condor.y, squad: (condor.passengers?.length ?? 0) > 0 });
  }
}

function flyIn(w: World, f: Faction, route: NonNullable<ReturnType<typeof lifelineRoute>>): Unit {
  const c = spawnUnit(w, nationKind(w, f, "condor"), f, route.from.x, route.from.y);
  c.free = true;
  c.facing = c.aim = atan2(route.to.x - c.x, -(route.to.y - c.y));
  c.order = { type: "move", x: route.to.x, y: route.to.y };
  if (squadCount(w, f) < LIFELINE.squadUnder && !bannedBy(w, nationKind(w, f, "trooper"), f)) {
    const squad = spawnUnit(w, nationKind(w, f, "trooper"), f, c.x, c.y);
    squad.free = true;
    applySpawnRank(w, squad);
    stowAboard(w, c, squad);
  }
  return c;
}
