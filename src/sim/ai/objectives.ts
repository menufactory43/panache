import { OBJECTIVES, TICK_RATE, UNITS } from "../balance";
import { unitSeenBy } from "../infantry";
import { captureWeight } from "../objectives";
import type { Command, Crate, Faction, Nation, Unit, Uplink, World } from "../types";
import { nationOf } from "../rules";
import { canGetWithin, dist, moveClassOf } from "../world";
import type { AiMode, AiState } from "./commander";
import { AA_COVER, aaSources, aaStrengthAt } from "./intel";
import { hypot } from "../fmath";
import { behaves, isGun, isHealer, noObjectiveDuty } from "./roles";

/**
 * The commander's play for the map objectives (objectives.ts): it races for
 * Uplinks with a squad that can actually hold one (robot infantry first: a
 * squad captures twice as fast), parks a cheap unit on each Uplink it owns
 * (a Trooper Squad does nicely), and diverts its nearest idle units —
 * infantry included — to announced supply crates. Everything it reads is
 * public (Uplink bars, crate announcements) or seen through its own fog
 * (Sniper concealment included); it never peeks at what a crate holds.
 */

/** Squad value that goes to take an Uplink (more if the enemy is there). */
export const UPLINK_SQUAD = 400;
/**
 * The nations' own Uplink play (WP4; Classique keeps the constants above).
 * `reach`: Uplinks it goes for lie at most this share of the way from its HQ
 * to the enemy's (1: anywhere); `squad`: scrap a capture squad is worth at
 * least; `resend`: seconds before another squad goes to the same Uplink once
 * the last one was lost (Classique: at once).
 */
export const OBJECTIVE_AI: Record<Nation, { reach: number; squad: number; resend: number }> = {
  republique: { reach: 1, squad: UPLINK_SQUAD, resend: 0 },
  // (at 1/400/0 its slow squads bled into the République's raiders: 58% of Rép-Emp games went to the République; 55% so)
  empire: { reach: 0.5, squad: 600, resend: 45 }
};

/** No Uplink runs before this: the opener's units settle in first. */
const UPLINK_GRACE = 20 * TICK_RATE;
/** Don't send another squad to the same Uplink within this long while the last is alive. */
const RESEND_TICKS = 25 * TICK_RATE;
/** Mid-assault, a capture squad only splits off an army worth this many times the squad. */
const ASSAULT_SPARE = 2.5;
/** Crates farther than this from a free unit aren't worth the trip (Easy stays closer to home). */
const CRATE_REACH = 30;
const CRATE_REACH_EASY = 18;
/** At most this many units chase one crate. */
const CRATE_RUNNERS = 3;
/** Garrison: a unit this close to its Uplink is "on post". */
const POST_SLACK = 1;
/** Visible enemy value near an objective is weighed within this radius. */
const SCAN_RADIUS = 7;

interface Memo {
  /** Uplink id → the unit parked on it. */
  garrison: Map<number, number>;
  /** Uplink id → tick a capture squad was last sent, and who. */
  sent: Map<number, { tick: number; ids: number[] }>;
  /** Crate id → units sent for it. */
  runners: Map<number, number[]>;
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { garrison: new Map(), sent: new Map(), runners: new Map() };
    memos.set(s, m);
  }
  return m;
}

const inZone = (u: { x: number; y: number }, l: Uplink, slack = 0) =>
  hypot(u.x - l.x, u.y - l.y) <= OBJECTIVES.uplink.radius + slack;

/** Is the bar not yet fully ours? (Then units inside it are busy capturing.) */
const unfinished = (l: Uplink, f: Faction) => l.progress * (f === "blue" ? 1 : -1) < 100;

/**
 * Units the objectives have a claim on this pass: garrisons on post,
 * squads standing in an Uplink they're still capturing (or contesting), and
 * runners waiting at a crate that hasn't landed. Other tactics leave them be.
 * (Island relays only infantry can take are the airlift's, ai/airlift.ts:
 * its garrisons are held there.)
 */
export function objectiveHolds(w: World, faction: Faction, s: AiState): number[] {
  const o = w.objectives;
  if (o.uplinks.length === 0 && o.crates.length === 0) return [];
  const m = memo(s);
  const out: number[] = [];
  for (const [lid, uid] of m.garrison) {
    const l = o.uplinks.find((x) => x.id === lid);
    const u = w.units.get(uid);
    if (!l || !u || l.owner !== faction) {
      m.garrison.delete(lid);
      continue;
    }
    if (inZone(u, l, POST_SLACK)) out.push(uid);
  }
  for (const l of o.uplinks) {
    if (!unfinished(l, faction) && !l.contested) continue;
    for (const u of w.units.values())
      if (u.faction === faction && !behaves(u.kind, "harvester") && u.order.type === "idle" && inZone(u, l)) out.push(u.id);
  }
  for (const [cid, ids] of m.runners) {
    const c = o.crates.find((x) => x.id === cid);
    if (!c) {
      m.runners.delete(cid);
      continue;
    }
    for (const id of ids) {
      const u = w.units.get(id);
      if (u && hypot(u.x - c.x, u.y - c.y) <= 2) out.push(id);
    }
  }
  return out;
}

export interface ObjectiveContext {
  mode: AiMode;
  hqC: { x: number; y: number };
  enemyHqPos: { x: number; y: number };
  guardPoint: { x: number; y: number };
  /** Army value the economy guard wants near guardPoint. */
  guardNeed: number;
  army: Unit[];
  /** Units already given orders this pass (updated in place). */
  used: Set<number>;
  /** A real attack on the base is under way: no Uplink runs. */
  threatened: boolean;
}

const value = (us: Unit[]) => us.reduce((v, u) => v + UNITS[u.kind].cost, 0);

/** Visible armed enemy value within `r` of a point (what a squad would have to beat there). */
function enemyValueNear(w: World, faction: Faction, x: number, y: number, r: number): number {
  let v = 0;
  for (const u of w.units.values()) {
    if (u.faction === faction || UNITS[u.kind].dps <= 0) continue;
    if (!unitSeenBy(w, faction, u)) continue;
    if (hypot(u.x - x, u.y - y) <= r) v += UNITS[u.kind].cost;
  }
  return v;
}

/** Can we see (or remember) enemy anti-air covering this spot (half a Flak Crawler's worth or more)? */
const aaCover = (w: World, faction: Faction, x: number, y: number): boolean =>
  aaStrengthAt(aaSources(w, faction), x, y) >= AA_COVER;

/** Can unit `u` get into Uplink `l`'s zone (on foot, tracks or hover: an island relay's moat stops it)? */
const canReach = (w: World, u: Unit, l: { x: number; y: number }, r = OBJECTIVES.uplink.radius): boolean =>
  canGetWithin(w, moveClassOf(u.kind), u.x, u.y, l.x, l.y, r);

/** Orders for Uplinks (garrisons, capture squads) and supply crates. */
export function planObjectives(w: World, faction: Faction, s: AiState, ctx: ObjectiveContext): Command[] {
  const o = w.objectives;
  const cmds: Command[] = [];
  if (o.uplinks.length === 0 && o.crates.length === 0) return cmds;
  const m = memo(s);
  const free = () => ctx.army.filter((u) => u.order.type === "idle" && !ctx.used.has(u.id));
  const take = (u: Unit) => ctx.used.add(u.id);

  // --- garrisons: one cheap unit parked on every Uplink we hold -----------
  // (island relays: the airlift's squads hold those, ai/airlift.ts)
  for (const l of o.uplinks) {
    if (l.owner !== faction || l.infantryOnly) continue;
    const posted = m.garrison.get(l.id);
    const pu = posted !== undefined ? w.units.get(posted) : undefined;
    if (pu && inZone(pu, l, POST_SLACK)) continue;
    if (pu && pu.order.type === "idle" && !ctx.used.has(pu.id) && dist(pu.x, pu.y, l.x, l.y) < 14) {
      // wandered off (chased something): back to its post
      take(pu);
      cmds.push({ type: "attackMove", faction, unitIds: [pu.id], x: l.x, y: l.y });
      continue;
    }
    const cands = free()
      .filter(
        (u) =>
          UNITS[u.kind].domain === "ground" && !isGun(u.kind) && dist(u.x, u.y, l.x, l.y) < 14 &&
          captureWeight(l, u.kind) > 0 && canReach(w, u, l)
      )
      .sort((a, b) => {
        const za = inZone(a, l) ? 0 : 1;
        const zb = inZone(b, l) ? 0 : 1;
        return za - zb || UNITS[a.kind].cost - UNITS[b.kind].cost || dist(a.x, a.y, l.x, l.y) - dist(b.x, b.y, l.x, l.y);
      });
    const g = cands[0];
    if (!g) continue;
    m.garrison.set(l.id, g.id);
    take(g);
    if (!inZone(g, l)) cmds.push({ type: "attackMove", faction, unitIds: [g.id], x: l.x, y: l.y });
  }

  // --- crates: the nearest free units race for every announced crate --------
  const reach = s.difficulty === "easy" ? CRATE_REACH_EASY : CRATE_REACH;
  // (a drop's two crates land together: the one on our own side first, for both sides alike)
  const home = (c: Crate) => dist(c.x, c.y, ctx.hqC.x, ctx.hqC.y);
  for (const c of [...o.crates].sort((a, b) => a.landTick - b.landTick || home(a) - home(b)))
    planCrate(w, faction, c, m, ctx, free, cmds, reach);

  // --- capture squads: take the best Uplink we don't hold -------------------
  // (mid-assault only when the army is big enough to spare a squad and still push)
  if (ctx.threatened || w.tick < UPLINK_GRACE) return cmds;
  const armyValue = value(ctx.army);
  const enemy: Faction = faction === "blue" ? "red" : "blue";
  const near = (l: Uplink) => dist(l.x, l.y, ctx.hqC.x, ctx.hqC.y);
  const far = (l: Uplink) => dist(l.x, l.y, ctx.enemyHqPos.x, ctx.enemyHqPos.y);
  const ownFlank = [...o.uplinks].sort((a, b) => near(a) - far(a) - (near(b) - far(b)))[0];
  const nation = nationOf(w, faction);
  const nat = nation === "classique" ? null : OBJECTIVE_AI[nation];
  const targets = o.uplinks
    // (island relays only a Condor's squads reach: the airlift's business, ai/airlift.ts)
    .filter((l) => !l.infantryOnly && (l.owner !== faction || l.pushing === enemy))
    // Boom only holds its own flank (the relay nearest its base); everyone else contests everything
    .filter((l) => s.strategy.name !== "boom" || l === ownFlank)
    // (a nation's reach: the Empire's slow columns hold their own half)
    .filter((l) => !nat || nat.reach >= 1 || l === ownFlank || near(l) <= nat.reach * (near(l) + far(l)))
    // Easy takes neutral relays but never comes to take yours
    .filter((l) => s.difficulty !== "easy" || l.owner === null)
    .map((l) => {
      const centre = s.strategy.name === "ironclad" ? dist(l.x, l.y, w.width / 2, w.height / 2) * 0.5 : 0;
      return { l, score: near(l) - 0.5 * far(l) + centre + enemyValueNear(w, faction, l.x, l.y, SCAN_RADIUS) / 100 };
    })
    .sort((a, b) => a.score - b.score);
  for (const { l } of targets) {
    const sent = m.sent.get(l.id);
    const mine = ctx.army.filter(
      (u) =>
        captureWeight(l, u.kind) > 0 &&
        (inZone(u, l, 1) ||
          ((u.order.type === "attackMove" || u.order.type === "move") && hypot(u.order.x - l.x, u.order.y - l.y) <= 3))
    );
    const need = Math.max(nat ? nat.squad : UPLINK_SQUAD, 1.3 * enemyValueNear(w, faction, l.x, l.y, SCAN_RADIUS));
    if (value(mine) >= need) continue; // already on its way / holding it
    if (ctx.mode === "assault" && armyValue < ASSAULT_SPARE * need) continue;
    if (sent && w.tick - sent.tick < RESEND_TICKS && sent.ids.some((id) => w.units.has(id))) continue;
    if (nat && sent && w.tick - sent.tick < nat.resend * TICK_RATE) continue; // (that squad was lost: not straight into it again)
    // recruits: nearest first; the economy guard keeps what it needs
    let guardSpare =
      value(ctx.army.filter((u) => dist(u.x, u.y, ctx.guardPoint.x, ctx.guardPoint.y) <= 5)) - ctx.guardNeed;
    // nearest first, robot infantry (twice the capture weight) as if half as far
    const turn = (u: Unit) => dist(u.x, u.y, l.x, l.y) / Math.max(1, captureWeight(l, u.kind));
    const pool = free()
      .filter(
        (u) =>
          !noObjectiveDuty(u.kind) &&
          captureWeight(l, u.kind) > 0 && canReach(w, u, l)
      )
      .sort((a, b) => turn(a) - turn(b));
    const squad: Unit[] = [];
    let v = value(mine);
    for (const u of pool) {
      if (v >= need) break;
      const isGuard = dist(u.x, u.y, ctx.guardPoint.x, ctx.guardPoint.y) <= 5;
      if (isGuard) {
        if (guardSpare < UNITS[u.kind].cost) continue;
        guardSpare -= UNITS[u.kind].cost;
      }
      squad.push(u);
      v += UNITS[u.kind].cost;
    }
    if (v < need || squad.length === 0) continue; // can't field enough: try the next one
    squad.forEach(take);
    m.sent.set(l.id, { tick: w.tick, ids: squad.map((u) => u.id) });
    cmds.push({ type: "attackMove", faction, unitIds: squad.map((u) => u.id), x: l.x, y: l.y });
    break; // one squad per decision pass
  }
  return cmds;
}

/** Send runners at one crate, unless someone's already on it or it's a trap. */
function planCrate(
  w: World,
  faction: Faction,
  c: Crate,
  m: Memo,
  ctx: ObjectiveContext,
  free: () => Unit[],
  cmds: Command[],
  reach: number
): void {
  // someone's still on it: alive, and at the crate or still heading there
  const onIt = (m.runners.get(c.id) ?? []).some((id) => {
    const u = w.units.get(id);
    if (!u) return false;
    if (hypot(u.x - c.x, u.y - c.y) <= 2) return true;
    const o = u.order;
    return (o.type === "move" || o.type === "attackMove") && hypot(o.x - c.x, o.y - c.y) <= 1;
  });
  if (onIt) return;
  const secsLeft = (c.expireTick - w.tick) / TICK_RATE;
  const enemyNear = enemyValueNear(w, faction, c.x, c.y, 6);
  const etaOf = (u: Unit) => {
    const d = dist(u.x, u.y, c.x, c.y);
    return (d * (UNITS[u.kind].domain === "air" ? 1 : 1.3)) / UNITS[u.kind].speed;
  };
  const pool = free()
    .filter((u) => !isHealer(u.kind) && dist(u.x, u.y, c.x, c.y) <= reach && etaOf(u) < secsLeft - 2 && canReach(w, u, c, 0.8))
    .sort((a, b) => etaOf(a) - etaOf(b));
  if (pool.length === 0) return;
  const need = Math.max(1, 1.2 * enemyNear);
  const squad: Unit[] = [];
  let v = 0;
  for (const u of pool) {
    if (squad.length >= CRATE_RUNNERS || (squad.length > 0 && v >= need)) break;
    squad.push(u);
    v += UNITS[u.kind].cost;
  }
  if (v < need * 0.6) return; // they'd only feed the enemy holding it
  const airValue = value(squad.filter((u) => UNITS[u.kind].domain === "air"));
  if (airValue > v / 2 && aaCover(w, faction, c.x, c.y)) return; // drones into flak: no
  for (const u of squad) ctx.used.add(u.id);
  m.runners.set(c.id, squad.map((u) => u.id));
  // a straight race while it's quiet there; fight through if it isn't
  const type = enemyNear > 0 ? "attackMove" : "move";
  cmds.push({ type, faction, unitIds: squad.map((u) => u.id), x: c.x, y: c.y });
}
