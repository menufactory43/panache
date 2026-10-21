import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { nearestScrapTile } from "../economy";
import { knownBuildings } from "../fog";
import { isInfantry } from "../infantry";
import { bannedBy, infantryArmy, rulesOf } from "../rules";
import { dropPoint, isLoaded } from "../transport";
import type { Command, Faction, Unit, World } from "../types";
import { buildingCenter, dist } from "../world";
import type { AiState } from "./commander";
import { isHealer, isSniper, isTransport, isWorker, kindsOf } from "./roles";
import { AA_COVER, aaSources, aaStrengthAt, aaWeight, seenEnemies, type Sighting } from "./intel";
import { cos, sin } from "../fmath";

/**
 * The commander's Condor drops (INFANTRY.md "AI"): Rush and Balanced keep one
 * dropship, load two infantry squads into it at home (whoever is free boards
 * at once, the next is called aboard as it comes free), fly it at the enemy's
 * harvester line on a route clear of the anti-air they can see or remember,
 * set the squads down a little short of the harvesters and let them fight.
 * With every harvester line covered, an assault under way gets the squads
 * flown up behind the wave instead (frontDrop).
 * The empty Condor flies home and goes again once two more squads are free;
 * a lost one is rebuilt (a few times a match). A drop that runs into guards,
 * anti-air or fire on the way in picks another way in or turns back, and
 * the next one steers clear of what it ran into. Ordinary board / unload /
 * move commands, same fog as everyone. Easy never drops.
 */

export const CONDOR_AI = {
  /** No drop boards before this (s): the opening settles first… */
  from: 150,
  /** …except under Airborne, whose Condor and squads wait at home from the start: the first drop may board this early (s). */
  airborneFrom: 60,
  /** Seconds from one drop landing (or being called off) to the next boarding. */
  every: 45,
  /**
   * Squads are called aboard as they come free (fresh from the Bay, back from
   * the field), a seat at a time: a boarding not full after this long (s)
   * goes with whoever is aboard, or is called off.
   */
  boardTimeout: 40,
  /** A loaded Condor that finds no clear route in this long (s) sets its squads down at home. */
  waitTimeout: 40,
  /** Seconds dropped squads raid on their own before they rejoin the army. */
  raid: 50,
  /** Condors built per match, at most (a lost one is rebuilt until then)… */
  maxBuilt: 3,
  /** …but no sooner than this (s) after the last one went down. */
  rebuild: 90,
  /** Drop this far (tiles) short of the harvesters, on the side facing home. */
  standoff: 2.5,
  /** Squads at least this healthy (share of max HP) are sent. */
  minHp: 0.7,
  /** Squads farther than this (tiles) from the Condor, or from home, aren't called to board. */
  reach: 16,
  /** A Condor that loses this share of its max HP on the way in turns back. */
  abortLoss: 0.3,
  /** Guards and anti-air a called-off drop ran into are remembered this long (s), where they were seen: the next drop steers clear. */
  recall: 90,
  /** …those within this many tiles of the Condor or its landing zone, when the drop is called off. */
  recallRadius: 8,
  /** Dropped squads go for a harvester (or Depot) they know of within this many tiles; else they hold the field. */
  chase: 8,
  /** Visible armed enemy ground value within this radius (tiles) of a drop point… */
  guardRadius: 6,
  /** …above this share of the squads' own value makes it a trap, not a raid. */
  guardShare: 0.8,
  /**
   * No way in to a harvester line, but an assault under way? Then the squads
   * are flown up behind the wave instead: the biggest group of ours pushing
   * out past this many tiles from home…
   */
  frontFrom: 18,
  /** …worth at least this much (scrap, within 5 tiles of its lead)… */
  frontValue: 500,
  /** …gets them set down this far (tiles) behind it, on the home side. */
  frontBack: 3
};

type Phase = "ready" | "boarding" | "loaded" | "transit" | "drop" | "return";

interface Memo {
  phase: Phase;
  condorId: number | null;
  /** Squads boarding or aboard. */
  squads: number[];
  /** Tick the current phase began. */
  since: number;
  waypoint: { x: number; y: number } | null;
  drop: { x: number; y: number } | null;
  /** A lift to the front (frontDrop): where the wave is headed, for the squads to follow once down. Null on a raid. */
  goal: { x: number; y: number } | null;
  /** Squads set down on a raid, the tick they rejoin the army, and the harvester line they work. */
  raiders: number[];
  raidUntil: number;
  field: { x: number; y: number } | null;
  /** Tick of the last landing (or called-off drop). */
  lastDrop: number;
  /** HP when the current trip began, and whether it was called off (the squads are then set down at home, and walk). */
  launchHp: number;
  turnedBack: boolean;
  built: number;
  /** Id of the newest Condor the plan has flown (Condors come in id order). */
  lastAdopted: number;
  lostTick: number;
  /** Enemies a called-off drop ran into: where they were seen, remembered until `until` (fog hides them again on the way home). */
  threats: (Sighting & { until: number })[];
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = {
      phase: "ready", condorId: null, squads: [], since: 0, waypoint: null, drop: null, goal: null,
      raiders: [], raidUntil: 0, field: null, lastDrop: -1e9, launchHp: 0, turnedBack: false, built: 0, lastAdopted: -1, lostTick: -1e9,
      threats: []
    };
    memos.set(s, m);
  }
  return m;
}

/**
 * Does this commander fly Condor drops at all? Rush and Balanced do, and
 * under Infantry War or Airborne every personality does (the Condor is the
 * only raider, or there is one parked at home from the start); never on
 * Easy, in Last Stand, under rules that ban infantry or the Condor, or for a
 * commander told never to raid (an op's dug-in defender).
 */
export function dropsCondors(w: World, faction: Faction, s: AiState): boolean {
  if (s.difficulty === "easy" || w.survival || !Number.isFinite(s.strategy.harassGroup)) return false;
  // island relays: every Condor flies the airlift (ai/airlift.ts), not raids
  if (w.objectives.uplinks.some((l) => l.infantryOnly)) return false;
  const everyone = infantryArmy(w, faction) || rulesOf(w).startUnits.includes("condor");
  if (s.strategy.name !== "rush" && s.strategy.name !== "balanced" && !everyone) return false;
  const K = kindsOf(w, faction);
  return bannedBy(w, K.transport, faction) === null && bannedBy(w, K.line, faction) === null;
}

/**
 * A commander handed a Condor by the match rules (Airborne) that flies drops:
 * every personality then keeps an Assembly Bay and a share of its army in
 * squads, so the dropship has someone to carry (commander.ts).
 */
export function flysGivenCondor(w: World, faction: Faction, s: AiState): boolean {
  return rulesOf(w).startUnits.includes("condor") && dropsCondors(w, faction, s);
}

/** Share of army value an Airborne commander keeps in squads at least (see flysGivenCondor). */
export const AIRBORNE_INFANTRY = 0.25;

/**
 * Should the airpad build a Condor now? One at a time, once infantry is in
 * play, from shortly before the first drop is due; a lost one is rebuilt
 * after a pause, up to CONDOR_AI.maxBuilt a match. `have` counts Condors
 * alive and queued.
 */
export function wantCondor(w: World, faction: Faction, s: AiState, have: number, squads: number): boolean {
  if (have > 0 || !dropsCondors(w, faction, s)) return false;
  const m = memo(s);
  noteLoss(w, m); // (production runs before the tactics: a Condor lost since the last pass counts already)
  if (m.built >= CONDOR_AI.maxBuilt || w.tick - m.lostTick < CONDOR_AI.rebuild * TICK_RATE) return false;
  return w.tick >= (CONDOR_AI.from - 20) * TICK_RATE && squads >= 2;
}

/** Our Condor gone since we last looked (shot down: its squads bailed out, or went down with it)? Start the rebuild clock. */
function noteLoss(w: World, m: Memo): void {
  if (m.condorId !== null && !w.units.has(m.condorId)) {
    m.lostTick = w.tick;
    m.condorId = null;
  }
}

/** Squads the drop plan has a claim on this pass (boarding, or out raiding): other tactics leave them be. */
export function condorHolds(w: World, s: AiState): number[] {
  const m = memos.get(s);
  if (!m) return [];
  const out: number[] = [];
  if (m.phase === "boarding") for (const id of m.squads) if (w.units.has(id)) out.push(id);
  if (w.tick < m.raidUntil) for (const id of m.raiders) if (w.units.has(id)) out.push(id);
  return out;
}

export interface CondorContext {
  army: Unit[];
  /** Units already given orders this pass (updated in place). */
  used: Set<number>;
  hqC: { x: number; y: number };
  /** A real attack on the base is under way: no drops, and a loaded Condor sets its squads down at home. */
  threatened: boolean;
  /** Condors on (or held for) a Goliath's lift (ai/goliath.ts liftCondors): never ours to fly. */
  skip?: ReadonlySet<number>;
}

/** The Condor the drop plan flies (it is never taken for a Goliath's lift), or null. */
export function dropCondorId(s: AiState): number | null {
  return memos.get(s)?.condorId ?? null;
}

/** One decision pass of the drop plan: board, fly, drop, raid, come home. */
export function planCondor(w: World, faction: Faction, s: AiState, ctx: CondorContext): Command[] {
  const cmds: Command[] = [];
  if (!dropsCondors(w, faction, s)) return cmds;
  const m = memo(s);
  const tps = TICK_RATE;
  // where the Condor waits: just behind the HQ, away from the enemy, over ground squads can walk up to
  const enemyGuess = { x: w.width - ctx.hqC.x, y: w.height - ctx.hqC.y };
  const back = Math.max(1, dist(ctx.hqC.x, ctx.hqC.y, enemyGuess.x, enemyGuess.y));
  const behind = {
    x: ctx.hqC.x - ((enemyGuess.x - ctx.hqC.x) / back) * 2.5,
    y: ctx.hqC.y - ((enemyGuess.y - ctx.hqC.y) / back) * 2.5
  };
  const home = dropPoint(w, faction, behind.x, behind.y) ?? behind;

  planRaiders(w, faction, m, ctx, cmds);

  // --- our Condor (built at the airpad): track it, notice when it's lost --
  noteLoss(w, m);
  // (a Condor on a Goliath's lift is the lift's: an order to it would redirect or set down the Goliath)
  const lifting = (u: Unit) => u.order.type === "lift" || !!ctx.skip?.has(u.id);
  let c = m.condorId !== null ? w.units.get(m.condorId) : undefined;
  if (c && lifting(c)) {
    c = undefined;
    m.condorId = null; // (not lost: lent out)
  }
  if (!c) {
    for (const u of w.units.values())
      if (u.faction === faction && isTransport(u.kind) && !lifting(u)) {
        c = u;
        break;
      }
    if (!c) {
      setPhase(m, "ready", w.tick);
      m.squads = [];
      return cmds;
    }
    m.condorId = c.id;
    if (c.id > m.lastAdopted) m.built++; // (one back from a Goliath's lift isn't a new one)
    m.lastAdopted = Math.max(m.lastAdopted, c.id);
    setPhase(m, "ready", w.tick);
    m.squads = [];
    m.turnedBack = false;
  }
  const condor = c;
  const cap = UNITS.condor.capacity ?? 2;
  const aboard = () => (condor.passengers ?? []).map((p) => p.id);
  const unloadHome = () => {
    cmds.push({ type: "unload", faction, unitIds: [condor.id] });
    m.lastDrop = w.tick;
    setPhase(m, "return", w.tick);
  };
  const goHome = () => {
    if (dist(condor.x, condor.y, home.x, home.y) > 2 && condor.order.type === "idle")
      cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
  };
  /** Squads' worth aboard (what a landing zone's guards are weighed against). */
  const cargo = () => (condor.passengers ?? []).reduce((v, u) => v + UNITS[u.kind].cost, 0);
  /** Off on a planned trip: by its flank waypoint, or straight in to drop. */
  const fly = (plan: DropPlan) => {
    m.drop = plan.drop;
    m.field = plan.line;
    m.waypoint = plan.waypoint;
    m.goal = plan.goal;
    if (plan.waypoint) {
      cmds.push({ type: "move", faction, unitIds: [condor.id], x: plan.waypoint.x, y: plan.waypoint.y });
      setPhase(m, "transit", w.tick);
    } else {
      cmds.push({ type: "unload", faction, unitIds: [condor.id], x: plan.drop.x, y: plan.drop.y });
      setPhase(m, "drop", w.tick);
    }
  };
  /** A way in for squads worth `value`: a harvester raid, else (in an assault) a lift up to the wave. */
  const wayIn = (value: number): DropPlan | null => {
    const enemies = known(w, faction, m);
    return (
      planDrop(w, faction, condor, ctx.hqC, enemies, value) ??
      (s.mode === "assault" ? frontDrop(w, faction, condor, ctx, enemies) : null)
    );
  };
  /** Taking fire on the way in (CONDOR_AI.abortLoss of its HP since launch)? */
  const hurt = () => condor.hp < m.launchHp - UNITS.condor.hp * CONDOR_AI.abortLoss;
  /**
   * Call the trip off: home with the squads, who are set down there and walk
   * (and the next boarding waits CONDOR_AI.every), remembering what it ran into.
   */
  const turnBack = () => {
    noteThreats(w, faction, m, condor);
    cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
    m.lastDrop = w.tick;
    m.turnedBack = true;
    setPhase(m, "return", w.tick);
  };

  switch (m.phase) {
    case "ready": {
      if (isLoaded(condor)) {
        setPhase(m, "loaded", w.tick);
        break;
      }
      goHome();
      const from = rulesOf(w).startUnits.includes("condor") ? CONDOR_AI.airborneFrom : CONDOR_AI.from;
      if (ctx.threatened || w.tick < from * tps || w.tick - m.lastDrop < CONDOR_AI.every * tps) break;
      if (condor.order.type !== "idle") break;
      const picks = recruits(condor, ctx, cap);
      if (picks.length === 0) break;
      // no way in from here (every approach covered or held): the squads stay on the ground
      // (reckoned as a full load: more squads are called aboard as they come free)
      const value = (picks.reduce((v, u) => v + UNITS[u.kind].cost, 0) * cap) / picks.length;
      if (!wayIn(value)) break;
      m.squads = picks.map((u) => u.id);
      for (const id of m.squads) ctx.used.add(id);
      cmds.push({ type: "board", faction, unitIds: m.squads, carrierId: condor.id });
      setPhase(m, "boarding", w.tick);
      break;
    }
    case "boarding": {
      const inHold = aboard();
      const walking = m.squads.filter((id) => {
        const u = w.units.get(id);
        return !!u && u.order.type === "board" && u.order.carrierId === condor.id;
      });
      const late = w.tick - m.since > CONDOR_AI.boardTimeout * tps;
      // seats still free: call up whoever has come free since
      const free = cap - inHold.length - walking.length;
      if (free > 0 && !late && !ctx.threatened) {
        const more = recruits(condor, ctx, free).map((u) => u.id);
        if (more.length > 0) {
          for (const id of more) ctx.used.add(id);
          cmds.push({ type: "board", faction, unitIds: more, carrierId: condor.id });
          walking.push(...more);
        }
      }
      m.squads = [...inHold, ...walking];
      if (ctx.threatened) {
        // the base needs everyone: off the ramp
        if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
        if (inHold.length > 0) unloadHome();
        else setPhase(m, "ready", w.tick);
        m.lastDrop = w.tick;
      } else if (inHold.length >= cap || (inHold.length > 0 && late)) {
        if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
        setPhase(m, "loaded", w.tick);
      } else if (inHold.length === 0 && (walking.length === 0 || late)) {
        if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
        m.lastDrop = w.tick; // try again later
        setPhase(m, "ready", w.tick);
      }
      break;
    }
    case "loaded": {
      if (!isLoaded(condor)) {
        setPhase(m, "ready", w.tick);
        break;
      }
      if (condor.order.type !== "idle") break;
      if (ctx.threatened || m.turnedBack || w.tick - m.since > CONDOR_AI.waitTimeout * tps) {
        unloadHome(); // (squads a Condor turned back with walk from here)
        m.turnedBack = false;
        break;
      }
      const plan = wayIn(cargo());
      if (!plan) break; // no clear way in yet: wait
      m.squads = aboard();
      m.launchHp = condor.hp;
      fly(plan);
      break;
    }
    case "transit": {
      if (!isLoaded(condor)) {
        setPhase(m, "return", w.tick);
        break;
      }
      if (hurt()) {
        turnBack(); // taking fire on the way out
        break;
      }
      const wp = m.waypoint;
      if (wp && dist(condor.x, condor.y, wp.x, wp.y) > 1.5 && condor.order.type === "move") break;
      // over the waypoint: re-check the way in from here, then drop
      const plan = wayIn(cargo());
      if (plan) fly(plan);
      else turnBack();
      break;
    }
    case "drop": {
      if (!isLoaded(condor)) {
        // down: the squads go for the harvesters (or after the wave they were flown up to), the Condor heads home
        const landed = m.squads.filter((id) => w.units.has(id));
        m.squads = [];
        m.lastDrop = w.tick;
        if (m.goal) {
          for (const id of landed) ctx.used.add(id);
          if (landed.length > 0) cmds.push({ type: "attackMove", faction, unitIds: landed, x: m.goal.x, y: m.goal.y });
        } else {
          m.raiders = landed;
          m.raidUntil = w.tick + CONDOR_AI.raid * tps;
          planRaiders(w, faction, m, ctx, cmds);
        }
        cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
        setPhase(m, "return", w.tick);
      } else if (condor.order.type !== "unload") {
        setPhase(m, "loaded", w.tick); // knocked off course (a dodge): plan again
      } else if (condor.order.hover < 0 && hurt()) {
        turnBack(); // taking fire on the way in
      } else if (condor.order.hover < 0 && m.drop) {
        // still on the way in: is the landing zone held, or under anti-air, by what we
        // see now? Then pick another way in, or go home. (Not the way there: what
        // covers that is mostly fighters passing by — taking fire is hurt()'s call.
        // Enemies round a lift to the front are the wave's business, not a trap.)
        const enemies = known(w, faction, m);
        const lz = m.drop;
        if ((!m.goal && guarded(enemies, cargo(), lz)) || airspace(w, faction, enemies).covered(lz.x, lz.y)) {
          noteThreats(w, faction, m, condor);
          const plan = wayIn(cargo());
          if (plan) fly(plan);
          else turnBack();
        }
      }
      break;
    }
    case "return": {
      if (condor.order.type === "unload") break; // setting squads down at home
      if (condor.order.type === "idle" && dist(condor.x, condor.y, home.x, home.y) <= 2.5)
        setPhase(m, isLoaded(condor) ? "loaded" : "ready", w.tick);
      else goHome();
      break;
    }
  }
  return cmds;
}

/**
 * Up to `n` squads free to fly: idle or just walking somewhere (to a guard
 * post, a staging point: not in a fight), healthy, not spoken for, within
 * CONDOR_AI.reach of the Condor and of home, nearest the Condor first.
 * (Not Sniper Teams: they're no use against a harvester.)
 */
function recruits(condor: Unit, ctx: CondorContext, n: number): Unit[] {
  return ctx.army
    .filter(
      (u) =>
        isInfantry(u.kind) && !isSniper(u.kind) && (u.order.type === "idle" || u.order.type === "attackMove") &&
        !ctx.used.has(u.id) &&
        u.hp >= UNITS[u.kind].hp * CONDOR_AI.minHp &&
        dist(u.x, u.y, condor.x, condor.y) <= CONDOR_AI.reach && dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) <= CONDOR_AI.reach
    )
    .sort((a, b) => dist(a.x, a.y, condor.x, condor.y) - dist(b.x, b.y, condor.x, condor.y))
    .slice(0, n);
}

function setPhase(m: Memo, p: Phase, tick: number): void {
  if (m.phase !== p) m.since = tick;
  m.phase = p;
}

/**
 * Dropped squads work the harvester line: a harvester they can see close by
 * gets shot (a short chase, not into the base), else a known Depot close by,
 * else they hold the field the harvesters come back to (attack-moving onto
 * it, so they fight whatever turns up). They rejoin the army when the raid
 * time is up.
 */
function planRaiders(w: World, faction: Faction, m: Memo, ctx: CondorContext, cmds: Command[]): void {
  if (m.raiders.length === 0) return;
  m.raiders = m.raiders.filter((id) => w.units.has(id));
  if (w.tick >= m.raidUntil) {
    m.raiders = []; // back to the army
    return;
  }
  const idle = m.raiders.map((id) => w.units.get(id)!).filter((u) => u.order.type === "idle" && u.autoTargetId === null);
  if (idle.length === 0) return;
  const cx = idle.reduce((a, u) => a + u.x, 0) / idle.length;
  const cy = idle.reduce((a, u) => a + u.y, 0) / idle.length;
  const ids = idle.map((u) => u.id);
  let best: { id: number; d: number } | null = null;
  for (const e of seenEnemies(w, faction)) {
    if (!isWorker(e.kind)) continue;
    const d = dist(e.x, e.y, cx, cy);
    if (d <= CONDOR_AI.chase && (!best || d < best.d)) best = { id: e.id, d };
  }
  if (best) {
    for (const id of ids) ctx.used.add(id);
    cmds.push({ type: "attack", faction, unitIds: ids, targetId: best.id });
    return;
  }
  let depot: { x: number; y: number; d: number } | null = null;
  for (const kb of knownBuildings(w, faction)) {
    if (kb.kind !== "depot") continue;
    const size = BUILDINGS[kb.kind].size;
    const d = dist(kb.tx + size / 2, kb.ty + size / 2, cx, cy);
    if (d <= CONDOR_AI.chase && (!depot || d < depot.d)) depot = { x: kb.tx + size / 2, y: kb.ty + size / 2, d };
  }
  const goal = depot ?? m.field;
  if (!goal || dist(goal.x, goal.y, cx, cy) <= 2) return; // holding the field: wait for the harvesters
  for (const id of ids) ctx.used.add(id);
  cmds.push({ type: "attackMove", faction, unitIds: ids, x: goal.x, y: goal.y });
}

/**
 * The enemies the drop plan reckons with: those in sight, and those a
 * called-off drop ran into lately (where they were seen; Memo.threats).
 */
function known(w: World, faction: Faction, m: Memo): Sighting[] {
  const seen: Sighting[] = seenEnemies(w, faction);
  m.threats = m.threats.filter((t) => t.until > w.tick);
  const ids = new Set(seen.map((u) => u.id));
  return [...seen, ...m.threats.filter((t) => !ids.has(t.id))];
}

/**
 * A drop called off: remember the guards and anti-air in sight within
 * CONDOR_AI.recallRadius of the Condor or its landing zone, where they are
 * now, for CONDOR_AI.recall s, so the next drop doesn't fly back into them.
 */
function noteThreats(w: World, faction: Faction, m: Memo, c: Unit): void {
  const until = w.tick + CONDOR_AI.recall * TICK_RATE;
  const r = CONDOR_AI.recallRadius;
  for (const e of seenEnemies(w, faction)) {
    const st = UNITS[e.kind];
    if (!((st.dps > 0 && st.domain === "ground") || aaWeight(st) > 0)) continue;
    if (dist(e.x, e.y, c.x, c.y) > r && (!m.drop || dist(e.x, e.y, m.drop.x, m.drop.y) > r)) continue;
    m.threats = m.threats.filter((t) => t.id !== e.id);
    m.threats.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, until });
  }
}

/** Is a drop point held by more armed ground enemies than squads worth `value` could take on? */
function guarded(enemies: readonly Sighting[], value: number, p: { x: number; y: number }): boolean {
  let v = 0;
  for (const e of enemies)
    if (UNITS[e.kind].dps > 0 && UNITS[e.kind].domain === "ground" && dist(e.x, e.y, p.x, p.y) <= CONDOR_AI.guardRadius)
      v += UNITS[e.kind].cost;
  return v > value * CONDOR_AI.guardShare;
}

/** The anti-air picture (aaSources over `enemies`): is a spot covered, is a straight flight clear of cover? */
export function airspace(w: World, faction: Faction, enemies: readonly Sighting[]) {
  const sources = aaSources(w, faction, enemies);
  const covered = (x: number, y: number) => aaStrengthAt(sources, x, y) >= AA_COVER;
  const clear = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(1, Math.ceil(dist(ax, ay, bx, by)));
    for (let i = 1; i <= n; i++) if (covered(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) return false;
    return true;
  };
  return { covered, clear };
}

interface DropPlan {
  drop: { x: number; y: number };
  waypoint: { x: number; y: number } | null;
  line: { x: number; y: number };
  /** Set on a lift to the front (frontDrop): where the squads head once down. */
  goal: { x: number; y: number } | null;
}

/** A point kept a tile inside the map. */
export const inMap = (w: World, p: { x: number; y: number }) => ({
  x: Math.min(w.width - 1, Math.max(1, p.x)),
  y: Math.min(w.height - 1, Math.max(1, p.y))
});

/**
 * How Condor `c` gets to `drop` clear of anti-air (`clear`, from airspace):
 * null for straight in, a flank waypoint off to one side of the straight
 * line, or undefined when there's no clear way.
 */
export function route(
  w: World,
  c: Unit,
  drop: { x: number; y: number },
  clear: (ax: number, ay: number, bx: number, by: number) => boolean
): { x: number; y: number } | null | undefined {
  if (clear(c.x, c.y, drop.x, drop.y)) return null;
  const len = Math.max(0.01, dist(c.x, c.y, drop.x, drop.y));
  const px = -(drop.y - c.y) / len;
  const py = (drop.x - c.x) / len;
  const mx = (c.x + drop.x) / 2;
  const my = (c.y + drop.y) / 2;
  for (const k of [6, -6, 10, -10, 14, -14]) {
    const wp = inMap(w, { x: mx + px * k, y: my + py * k });
    if (clear(c.x, c.y, wp.x, wp.y) && clear(wp.x, wp.y, drop.x, drop.y)) return wp;
  }
  return undefined;
}

/**
 * Where squads worth `value` aboard Condor `c` should drop and how to get
 * there: a point CONDOR_AI.standoff short of an enemy harvester line (a
 * visible harvester, a known Depot, else the mirror image of our own field)
 * that no guard we know of (`enemies`: seen or remembered) holds, no more
 * anti-air on it than AA_COVER, reached on a straight line or around one
 * flank waypoint that stays clear. Candidates are generated relative to the
 * line of flight, so red's choice is the mirror image of blue's. Null when
 * every way in is covered.
 */
function planDrop(
  w: World,
  faction: Faction,
  c: Unit,
  hqC: { x: number; y: number },
  enemies: readonly Sighting[],
  value: number
): DropPlan | null {
  const { covered, clear } = airspace(w, faction, enemies);
  // harvester lines, nearest to us first
  const lines: { x: number; y: number }[] = [];
  for (const e of enemies) if (isWorker(e.kind)) lines.push({ x: e.x, y: e.y }); // (in sight: none is remembered)
  for (const kb of knownBuildings(w, faction)) if (kb.kind === "depot") lines.push({ x: kb.tx + 1, y: kb.ty + 1 });
  if (lines.length === 0) {
    // their home field: the mirror image of ours
    const own = nearestScrapTile(w, hqC.x, hqC.y, faction);
    lines.push(own ? { x: w.width - own.x - 0.5, y: w.height - own.y - 0.5 } : { x: w.width - hqC.x, y: w.height - hqC.y });
  }
  lines.sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y));
  const ANGLES = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1];
  for (const t of lines.slice(0, 4)) {
    // approach from our side of it
    const d0 = Math.max(0.01, dist(c.x, c.y, t.x, t.y));
    const ux = (c.x - t.x) / d0;
    const uy = (c.y - t.y) / d0;
    for (const a of ANGLES) {
      const dx = ux * cos(a) - uy * sin(a);
      const dy = ux * sin(a) + uy * cos(a);
      const drop = inMap(w, { x: t.x + dx * CONDOR_AI.standoff, y: t.y + dy * CONDOR_AI.standoff });
      if (covered(drop.x, drop.y) || guarded(enemies, value, drop)) continue;
      const waypoint = route(w, c, drop, clear);
      if (waypoint !== undefined) return { drop, waypoint, line: t, goal: null };
    }
  }
  return null;
}

/**
 * A lift to the front, for when no harvester line can be reached: the
 * biggest group of ours pushing out past CONDOR_AI.frontFrom (attacking or
 * attack-moving, worth CONDOR_AI.frontValue within 5 tiles of its lead) gets
 * the squads set down CONDOR_AI.frontBack behind it, if that spot and a way
 * there are clear of anti-air; they then follow it to where it's headed.
 * Squads walk at half a tank's speed: this is how they keep up with a wave.
 */
function frontDrop(w: World, faction: Faction, c: Unit, ctx: CondorContext, enemies: readonly Sighting[]): DropPlan | null {
  const { hqC } = ctx;
  const pushing = ctx.army.filter(
    (u) =>
      !isHealer(u.kind) && (u.order.type === "attack" || u.order.type === "attackMove") &&
      dist(u.x, u.y, hqC.x, hqC.y) > CONDOR_AI.frontFrom
  );
  let lead: Unit | null = null;
  let leadValue = 0;
  for (const u of pushing) {
    let v = 0;
    for (const o of pushing) if (dist(o.x, o.y, u.x, u.y) <= 5) v += UNITS[o.kind].cost;
    if (v > leadValue) {
      leadValue = v;
      lead = u;
    }
  }
  if (!lead || leadValue < CONDOR_AI.frontValue) return null;
  const o = lead.order;
  let goal: { x: number; y: number } | null = null;
  if (o.type === "attackMove") goal = { x: o.x, y: o.y };
  else if (o.type === "attack") {
    const t = w.units.get(o.targetId);
    const b = w.buildings.get(o.targetId);
    goal = t ? { x: t.x, y: t.y } : b ? buildingCenter(b) : null;
  }
  if (!goal) return null;
  const back = Math.max(0.01, dist(lead.x, lead.y, hqC.x, hqC.y));
  const drop = inMap(w, {
    x: lead.x + ((hqC.x - lead.x) / back) * CONDOR_AI.frontBack,
    y: lead.y + ((hqC.y - lead.y) / back) * CONDOR_AI.frontBack
  });
  const { covered, clear } = airspace(w, faction, enemies);
  if (covered(drop.x, drop.y)) return null;
  const waypoint = route(w, c, drop, clear);
  return waypoint === undefined ? null : { drop, waypoint, line: drop, goal };
}
