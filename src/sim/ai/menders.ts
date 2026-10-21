import { BUILDINGS, UNITS } from "../balance";
import { isLifted, repairUrgency } from "../goliath";
import { isStunned } from "../powers";
import type { Building, Command, Faction, Unit, World } from "../types";
import { buildingCenter, dist } from "../world";
import { isHealer } from "./roles";

/**
 * The commander's Menders. A Mender has no gun, so it is never a wave, a raid
 * or a guard post of its own: every decision pass it picks the friendly unit
 * that needs it most — a wounded one close by, else the nearest group that is
 * on the move — and follows it. A unit alone deep in enemy ground (a raider,
 * the last of a wave) is not worth following there, and a Mender with nobody
 * worth following flies home to patch up the base instead of hovering where
 * the fight used to be.
 *
 * Goliaths come first: only Menders can repair one (GOLIATH.md), and it
 * takes two or three to make real progress, so a hurt Goliath draws up to
 * MENDER_AI.goliath of them — the one with a weapon offline, rebooting, or
 * about to come back (goliath.ts repairUrgency) before the others — and one
 * stays with a Goliath out in the field even when it is whole. Not one
 * under an EMP (it blocks repair), nor one in the air on a lift.
 */
export const MENDER_AI = {
  /** Units under this share of max HP count as wounded. */
  wounded: 0.85,
  /** Wounded units farther than this (tiles) from the Mender are left to others. */
  reach: 20,
  /** Friendly army within this many tiles of a unit is its company. */
  company: 5,
  /** Within this many tiles of the enemy HQ counts as deep in enemy ground… */
  deep: 16,
  /** …where a unit with less company than this (scrap value, itself included) is not followed. */
  deepCompany: 400,
  /** A Mender already headed within this many tiles of its pick keeps its order. */
  slack: 2.5,
  /** Home: a Mender this close to its rest point stays put. */
  rest: 3,
  /** Menders committed to a Goliath that needs repair (two or three make real progress)… */
  goliath: 3,
  /** …from this far away (tiles): it's worth the trip. */
  goliathReach: 30,
  /** A Goliath this far (tiles) from home keeps one Mender by it even when whole. */
  goliathAway: 10,
  /** A Mender this close (tiles) to a Goliath's centre is there (its reach is 3; the Goliath's radius 1). */
  goliathStand: 1.6
};

/**
 * Orders for the Menders in `army` that aren't already spoken for (`used`:
 * dodging a reticle, or sent to a resting veteran). Every Mender it handles
 * is added to `used`, so no wave, guard or salvage tactic recruits it.
 * `goliaths`: our Goliaths (never in `army`), served first; given the world,
 * one under an EMP is passed over.
 */
export function planMenders(
  faction: Faction,
  army: Unit[],
  buildings: Building[],
  used: Set<number>,
  home: { x: number; y: number },
  enemyHq: { x: number; y: number },
  goliaths: readonly Unit[] = [],
  w?: World
): Command[] {
  const cmds: Command[] = [];
  const menders = army.filter((u) => isHealer(u.kind) && !used.has(u.id));
  if (menders.length === 0) return cmds;
  // (a Goliath handed in with the army is served as one too)
  const allGoliaths = [...goliaths, ...army.filter((u) => !!u.goliath && !goliaths.includes(u))];
  const others = army.filter((u) => !isHealer(u.kind) && !u.goliath);
  /** Can mender `m` repair `u`? (An Atelier roulant only what stands on the ground.) */
  const mends = (m: Unit, u: Unit) => UNITS[m.kind].healTargets !== "ground" || UNITS[u.kind].domain === "ground";
  const company = (u: Unit) =>
    others.reduce((v, o) => (dist(o.x, o.y, u.x, u.y) <= MENDER_AI.company ? v + UNITS[o.kind].cost : v), 0);
  // a lone unit deep in enemy ground (a raider, the last of a wave): not worth following in there
  const safe = (u: Unit) =>
    dist(u.x, u.y, enemyHq.x, enemyHq.y) > MENDER_AI.deep || company(u) >= MENDER_AI.deepCompany;
  const hp = (u: Unit) => u.hp / UNITS[u.kind].hp;
  const wounded = others.filter((u) => hp(u) < MENDER_AI.wounded && safe(u));
  const moving = others.filter((u) => u.order.type !== "idle" && safe(u));
  // nothing to follow: the base's most battered building, else just behind the HQ
  let rest = { x: home.x, y: home.y };
  let worst = 1;
  for (const b of buildings) {
    const share = b.hp / BUILDINGS[b.kind].hp;
    if (share < worst) {
      worst = share;
      rest = buildingCenter(b);
    }
  }
  /** Mender `m` toward `goal` (attack-moving after a unit, moving home), unless it's there or on its way. */
  const go = (m: Unit, goal: { x: number; y: number }, near: number, follow: boolean) => {
    if (dist(m.x, m.y, goal.x, goal.y) <= near) return; // there: heal whatever's in reach
    const o = m.order;
    if ((o.type === "move" || o.type === "attackMove") && dist(o.x, o.y, goal.x, goal.y) <= near) return; // on its way
    cmds.push({ type: follow ? "attackMove" : "move", faction, unitIds: [m.id], x: goal.x, y: goal.y });
  };

  // --- Goliaths first: repair brings their weapons back ----------------------
  const free = [...menders];
  const take = (g: Unit, n: number) => {
    const picks = free
      .filter((m) => dist(m.x, m.y, g.x, g.y) <= MENDER_AI.goliathReach && mends(m, g))
      .sort((a, b) => dist(a.x, a.y, g.x, g.y) - dist(b.x, b.y, g.x, g.y) || a.id - b.id)
      .slice(0, n);
    for (const m of picks) {
      free.splice(free.indexOf(m), 1);
      used.add(m.id);
      go(m, g, MENDER_AI.goliathStand, true); // (over it: every side of it is in reach)
    }
  };
  const repairable = allGoliaths.filter((g) => !isLifted(g) && !(w && isStunned(w, g.id)));
  const hurt = repairable
    .filter((g) => repairUrgency(g) > 0 || hp(g) < MENDER_AI.wounded)
    .sort((a, b) => repairUrgency(b) - repairUrgency(a) || hp(a) - hp(b) || a.id - b.id);
  for (const g of hurt) take(g, MENDER_AI.goliath);
  // …and one by each Goliath out in the field, whole or not
  for (const g of [...repairable].sort((a, b) => a.id - b.id))
    if (!hurt.includes(g) && dist(g.x, g.y, home.x, home.y) > MENDER_AI.goliathAway) take(g, 1);

  for (const m of free) {
    used.add(m.id);
    let pick: { x: number; y: number } | null = null;
    // the wounded first: the worse hurt and the closer, the better
    let best = Infinity;
    for (const u of wounded) {
      if (!mends(m, u)) continue;
      const d = dist(u.x, u.y, m.x, m.y);
      if (d > MENDER_AI.reach) continue;
      const score = d + hp(u) * 10;
      if (score < best) {
        best = score;
        pick = u;
      }
    }
    // else tag along with the nearest unit that's going somewhere
    if (!pick) {
      best = Infinity;
      for (const u of moving) {
        if (!mends(m, u)) continue;
        const d = dist(u.x, u.y, m.x, m.y);
        if (d < best) {
          best = d;
          pick = u;
        }
      }
    }
    go(m, pick ?? rest, pick ? MENDER_AI.slack : MENDER_AI.rest, !!pick);
  }
  return cmds;
}
