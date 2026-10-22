import { UNITS } from "../balance";
import type { Command, Faction, Unit, World } from "../types";
import { canGetWithin, dist, moveClassOf, onHomeLand } from "../world";
import { behaves } from "./roles";

/**
 * The AI values its veterans the way a player would: a ranked unit that is
 * badly hurt falls back to a Mender (one behind it) or to the HQ instead of
 * trading itself away, rests there until it's patched up, and an idle
 * Mender comes to it. Same rules as the player — it's just ordinary orders.
 */

export const VETERAN_RETREAT = {
  /** Ranks at or above this are worth saving. */
  minRank: 2,
  /** Retreat below this fraction of max HP; rejoin at or above it. */
  hpFrac: 0.35,
  /** Within this many tiles of the destination counts as arrived. */
  arrive: 3,
  /** Rest this far from the HQ centre (it's a 3×3 footprint). */
  homeOffset: 3
};

export function isWoundedVeteran(u: Unit): boolean {
  return (
    u.rank >= VETERAN_RETREAT.minRank &&
    !behaves(u.kind, "mender") &&
    !behaves(u.kind, "harvester") &&
    !behaves(u.kind, "goliath") && // (its own planner backs it off: ai/goliath.ts)
    u.hp < UNITS[u.kind].hp * VETERAN_RETREAT.hpFrac
  );
}

/**
 * Retreat orders for wounded veterans among `army` not already in `used`
 * (a unit dodging a reticle finishes that first). Every wounded veteran is
 * added to `used` (so no other tactic recruits it); idle Menders not in
 * `used` are sent to veterans resting at home. Given the world, a veteran
 * only falls back to a Mender it can walk to (not one hovering over the
 * sea), and one cut off from home (a squad on an island) holds where it is.
 */
export function veteranRetreats(
  faction: Faction,
  army: Unit[],
  home: { x: number; y: number },
  used: Set<number>,
  w?: World
): Command[] {
  const cmds: Command[] = [];
  const menders = army.filter((u) => behaves(u.kind, "mender"));
  const resting: Unit[] = [];
  for (const u of army) {
    // (already spoken for: e.g. dodging a reticle — it heads home once clear)
    if (!isWoundedVeteran(u) || used.has(u.id)) continue;
    used.add(u.id);
    const walks = !!w && UNITS[u.kind].domain !== "air";
    if (walks && !onHomeLand(w!, faction, Math.floor(u.x), Math.floor(u.y))) continue; // no way home: it holds
    const dHome = dist(u.x, u.y, home.x, home.y);
    // a Mender behind the unit (nearer home) beats the long walk back
    let dest: { x: number; y: number } | null = null;
    let best = Infinity;
    for (const m of menders) {
      if (dist(m.x, m.y, home.x, home.y) > dHome - 4) continue;
      if (walks && !canGetWithin(w!, moveClassOf(u.kind), u.x, u.y, m.x, m.y, VETERAN_RETREAT.arrive)) continue;
      const d = dist(m.x, m.y, u.x, u.y);
      if (d < best) {
        best = d;
        dest = { x: m.x, y: m.y };
      }
    }
    if (!dest) {
      const k = dHome > 0.01 ? VETERAN_RETREAT.homeOffset / dHome : 0;
      dest = { x: home.x + (u.x - home.x) * k, y: home.y + (u.y - home.y) * k };
    }
    if (dist(u.x, u.y, dest.x, dest.y) <= VETERAN_RETREAT.arrive) {
      if (!menders.some((m) => dist(m.x, m.y, u.x, u.y) <= 4)) resting.push(u);
      continue;
    }
    const o = u.order;
    if (o.type === "move" && dist(o.x, o.y, dest.x, dest.y) <= VETERAN_RETREAT.arrive) continue; // on its way
    cmds.push({ type: "move", faction, unitIds: [u.id], x: dest.x, y: dest.y });
  }
  // patch up whoever is resting: the nearest idle Mender comes over
  for (const v of resting) {
    let pick: Unit | null = null;
    let best = Infinity;
    for (const m of menders) {
      if (used.has(m.id) || m.order.type !== "idle") continue;
      const d = dist(m.x, m.y, v.x, v.y);
      if (d < best) {
        best = d;
        pick = m;
      }
    }
    if (!pick) break;
    used.add(pick.id);
    cmds.push({ type: "attackMove", faction, unitIds: [pick.id], x: v.x, y: v.y });
  }
  return cmds;
}
