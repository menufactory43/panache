import { BUILDINGS, SALVAGE, UNITS } from "../balance";
import { isVisible, knownBuildings } from "../fog";
import { unitSeenBy } from "../infantry";
import type { Building, Command, Faction, Unit, World, Wreck } from "../types";
import { canGetWithin, distToBuilding, moveClassOf } from "../world";
import { hypot } from "../fmath";
import { behaves } from "./roles";

/**
 * The commander's salvage sweeps (salvage.ts has the rules). It plays by the
 * same fog as everyone: only wrecks on tiles it can see count. Never feeds
 * units into the enemy for loot: a wreck is only swept when no visible armed
 * enemy is near it, no known enemy turret covers it, and nothing of ours
 * near it has been shot at for a few seconds (the fight there is over).
 */

/** Idle ground units sweep cool wrecks within this many tiles of themselves… */
export const SWEEP_RADIUS = 8;
/** …or this many while an assault gathers (the wave waiting at its staging point grabs what's close). */
const ASSAULT_SWEEP_RADIUS = 5;
/**
 * Harvesters going about their work divert to a wreck within this many tiles,
 * however full they are: a wreck's scrap goes straight to the bank, not into
 * the hold, so it's a few seconds' detour for a third of a unit's cost.
 */
const HARVESTER_DIVERT = 5;
/** Visible armed enemies this close to a wreck make it bait, not loot. */
const DANGER_RADIUS = 7;
/** Our units/buildings this close to a wreck that were hit this recently mean the fight isn't over. */
const CALM_RADIUS = 8;
const CALM_TICKS = 50;
/** Most army units sent sweeping per decision pass (the rest keep their posts). */
const MAX_SWEEPERS = 6;
/** Don't chase a wreck that will burn out before a unit can plausibly get there. */
const MIN_TTL = 40;

export interface SalvageContext {
  army: Unit[];
  harvesters: Unit[];
  buildings: Building[];
  /** Units already given orders this decision pass (updated in place). */
  used: Set<number>;
  /** A real attack on the base is under way: the army stays put (harvesters may still divert). */
  threatened: boolean;
  /** An assault is gathering: idle units only sweep wrecks close by (ASSAULT_SWEEP_RADIUS). */
  assault: boolean;
}

/** Orders that send idle ground units (and harvesters at work) to scoop up nearby wrecks. */
export function planSalvage(w: World, faction: Faction, ctx: SalvageContext): Command[] {
  const cmds: Command[] = [];
  const loot = w.wrecks.filter(
    (r) => r.hot <= 0 && r.ttl > MIN_TTL && isVisible(w, faction, Math.floor(r.x), Math.floor(r.y))
  );
  if (loot.length === 0) return cmds;

  const enemies: Unit[] = [];
  for (const u of w.units.values())
    if (
      u.faction !== faction &&
      UNITS[u.kind].dps > 0 &&
      UNITS[u.kind].targets !== "air" &&
      unitSeenBy(w, faction, u)
    )
      enemies.push(u);
  const defences = knownBuildings(w, faction).filter((kb) => {
    const st = BUILDINGS[kb.kind];
    return st.dps > 0 && st.targets !== "air";
  });
  const safe = (r: Wreck): boolean => {
    for (const e of enemies) if (hypot(e.x - r.x, e.y - r.y) <= DANGER_RADIUS) return false;
    for (const kb of defences) {
      const st = BUILDINGS[kb.kind];
      const d = hypot(kb.tx + st.size / 2 - r.x, kb.ty + st.size / 2 - r.y) - st.size / 2;
      if (d <= st.range + 2) return false;
    }
    for (const u of ctx.army)
      if (w.tick - u.damagedTick < CALM_TICKS && hypot(u.x - r.x, u.y - r.y) <= CALM_RADIUS) return false;
    for (const h of ctx.harvesters)
      if (w.tick - h.damagedTick < CALM_TICKS && hypot(h.x - r.x, h.y - r.y) <= CALM_RADIUS) return false;
    for (const b of ctx.buildings)
      if (w.tick - b.damagedTick < CALM_TICKS && distToBuilding(b, r.x, r.y) <= CALM_RADIUS) return false;
    return true;
  };
  const claimed = new Set<number>();
  const send = (u: Unit, r: Wreck) => {
    claimed.add(r.id);
    ctx.used.add(u.id);
    // attack-move: a sweeper still answers anything that shows up on the way
    cmds.push({ type: behaves(u.kind, "harvester") ? "move" : "attackMove", faction, unitIds: [u.id], x: r.x, y: r.y });
  };
  // richest wrecks first (ties: oldest), each to the nearest free sweeper
  const ranked = loot.filter(safe).sort((a, b) => b.value - a.value || a.ttl - b.ttl);
  if (ranked.length === 0) return cmds;

  // harvesters on their way out, digging or heading home grab a wreck that's close by
  for (const h of ctx.harvesters) {
    if (ctx.used.has(h.id) || w.tick - h.damagedTick < CALM_TICKS) continue;
    const o = h.order;
    if (!(o.type === "idle" || (o.type === "harvest" && o.phase !== "unloading"))) continue;
    let best: Wreck | null = null;
    let bestD = HARVESTER_DIVERT;
    for (const r of ranked) {
      if (claimed.has(r.id) || !canGetWithin(w, "ground", h.x, h.y, r.x, r.y, SALVAGE.pickupRadius)) continue;
      const d = hypot(r.x - h.x, r.y - h.y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best) send(h, best);
  }

  if (ctx.threatened) return cmds;
  const radius = ctx.assault ? ASSAULT_SWEEP_RADIUS : SWEEP_RADIUS;
  const sweepers = ctx.army.filter(
    (u) => !ctx.used.has(u.id) && u.order.type === "idle" && UNITS[u.kind].domain === "ground"
  );
  let sent = 0;
  for (const r of ranked) {
    if (sent >= MAX_SWEEPERS) break;
    if (claimed.has(r.id)) continue;
    let best: Unit | null = null;
    let bestD = radius;
    for (const u of sweepers) {
      if (ctx.used.has(u.id)) continue;
      // (a wreck across the water, or on an island: not for this unit)
      if (!canGetWithin(w, moveClassOf(u.kind), u.x, u.y, r.x, r.y, SALVAGE.pickupRadius)) continue;
      const d = hypot(u.x - r.x, u.y - r.y);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    if (!best) continue;
    send(best, r);
    sent++;
  }
  return cmds;
}
