import { OBJECTIVES, TICK_RATE, UNITS } from "../balance";
import { isVisible } from "../fog";
import { isInfantry } from "../infantry";
import { uplinkPay } from "../objectives";
import { bannedBy, rulesOf } from "../rules";
import { dropPoint, freeSeats, isLoaded } from "../transport";
import type { Command, Faction, Unit, Uplink, World } from "../types";
import { canGetWithin, dist, moveClassOf, onHomeLand, regionAt, sideFrame } from "../world";
import type { AiState, Difficulty, StrategyName } from "./commander";
import { airspace, route } from "./condor";
import { isAirStriker, isInterceptor, isSniper, isTransport, kindsOf } from "./roles";
import { AA_COVER, USELESS, aaSources, aaStrengthAt, aaWeight, effectiveness, type Sighting } from "./intel";
import { cos, sin } from "../fmath";

/**
 * The commander's airlift, for maps whose Uplinks sit on islands only robot
 * infantry can take (Uplink.infantryOnly: Archipelago). Every Condor the side
 * has (its starting one, the free replacement, any it builds) flies here,
 * not on harvester raids (ai/condor.ts steps aside):
 *
 * - TARGETS: island relays that are neutral, the enemy's, or ours but with
 *   nobody standing on them, scored by what they pay, how far the Condor has
 *   to fly, how exposed they are to the enemy, and what we've seen there.
 *   An enemy relay (or one their drones circle) is only landed on bringing
 *   more than what we saw there (or, unseen, a squad's worth). Easy only
 *   goes for neutral relays and its own empty ones.
 * - LIFTS: per Condor, board one or two healthy squads at home (Rocket
 *   Squads first once the enemy flies drones, Sniper Teams last), fly a
 *   route clear of the anti-air we see or remember (condor.ts
 *   airspace/route), set the squads down inside the relay's zone on its own
 *   island and fly home; turn back when taking fire.
 * - GARRISONS: our squads on an island hold its relay (they crew it: an
 *   island relay pays only while its holder's infantry stand in it). They
 *   stay out of every other tactic, and walk back into the zone after a
 *   chase; one whose relay is lost or contested stays and fights.
 * - INTERCEPTS: enemy Condors are unarmed, so the threat response never
 *   looks at them; one seen near our relays, our base or our own Condors
 *   gets our idle anti-air sent after it (Raptors from anywhere, ground
 *   units only when they can get in range). So do enemy Wasps and Hornets
 *   working over an island our squads hold (the garrison can't run).
 * - STRIKES: our own idle Wasps and Hornets clear an enemy garrison they
 *   outweigh, when nothing else covers its island with anti-air.
 *
 * Plain commands and the same fog as everyone: enemy garrisons are what we
 * see (or saw), never the relay's hidden crew state.
 */

export const AIRLIFT = {
  /** First lift boards no sooner than this (s). */
  from: { easy: 30, normal: 0, hard: 0 } as Record<Difficulty, number>,
  /** Seconds between one lift launching and the next (any Condor). */
  every: { easy: 30, normal: 4, hard: 2 } as Record<Difficulty, number>,
  /** Condors the commander runs at most (built, starting and free ones). */
  condors: { easy: 1, normal: 2, hard: 3 } as Record<Difficulty, number>,
  /** A second Condor is built no sooner than this (s). */
  secondFrom: 75,
  /** A boarding not full after this long (s) goes with whoever is aboard, or is called off. */
  boardTimeout: 25,
  /** Squads farther than this (tiles) from home aren't called to board. */
  reach: 22,
  /** Squads at least this healthy (share of max HP) are flown out. */
  minHp: 0.6,
  /** A Condor that loses this share of its max HP since launch turns back. */
  abortLoss: 0.3,
  /** A loaded Condor back home (turned back) waits this long (s) before trying again… */
  retry: 8,
  /** …and sets its squads down at home if nothing wants them for this long (s). */
  idleUnload: 30,
  /** We land on an enemy garrison only bringing this many times its value. */
  edge: 1.3,
  /** Squads are set down this far (tiles) short of the relay, on our side (inside its 2.5-tile zone). */
  landShort: 1,
  /** An enemy relay we haven't seen is guessed to hold this much (a squad). */
  guess: 110,
  /** What we saw on a relay is remembered this long (s). */
  recall: 150,
  /** Squads a relay paying at least `richPay` is crewed with (Normal, Hard); others get one. */
  richCrew: 2,
  richPay: 4,
  /** Anti-air a turned-back lift ran into is remembered this long (s), within this radius (tiles). */
  threatRecall: 90,
  threatRadius: 8,
  /**
   * How much each personality shies away from relays nearer the enemy than
   * itself (0: goes anywhere, 1: home isles first).
   */
  caution: { balanced: 0.5, rush: 0.5, airswarm: 0.6, boom: 1, skyforce: 0.6, ironclad: 0.6 } as Record<StrategyName, number>,
  /**
   * Robot infantry share of the force a commander keeps on these maps at
   * least, on top of the squads the airlift is waiting for (which the
   * Assembly Bays make first): together about 40% of what it builds.
   */
  infantry: 0.3,
  /**
   * Fab Plants stop once ground vehicles are this share of the force: tanks
   * only reach the war over the islands by the bridges, at the enemy's base,
   * so the rest goes to squads, Condors and the air that holds the islands
   * (at 25-35% the air-only Skyforce won 80-100% of its games here).
   */
  vehicles: 0.15,
  /** Raptors a commander keeps against enemy air on these maps, at most (elsewhere 4; an air force 7). */
  raptors: 6,
  /** No personality goes all-in below this army value here (scrap; Rush and Ironclad otherwise go at 1400). */
  assaultFloor: 1700,
  /** Enemy Condors within this many tiles of our relays, base or Condors are intercepted… */
  interceptRadius: 12,
  /** …by at most this many units each; ground units only from this close (tiles). */
  interceptors: 2,
  interceptGround: 9,
  /**
   * Enemy Wasps and Hornets within this many tiles of a relay count against
   * a landing there, and over one our squads hold, our Raptors go after them
   * (the threat response only watches relays we own).
   */
  airGuard: 6,
  /**
   * Air strikes on enemy garrisons (the way to clear an island before a
   * lift): idle Wasps and Hornets worth this many times the garrison we know
   * of (seen, remembered, or guessed)…
   */
  strikeEdge: 1.8,
  /** …and at least this much scrap… */
  strikeMin: 380,
  /** …go no more often than this (s) at one relay. */
  strikeEvery: 20
};

type Phase = "home" | "boarding" | "outbound" | "return";
type P = { x: number; y: number };

interface Lift {
  phase: Phase;
  /** The relay it's flying for (Uplink id). */
  target: number | null;
  /** Squads boarding or aboard. */
  squads: number[];
  /** Tick the phase began. */
  since: number;
  launchHp: number;
  drop: P | null;
  waypoint: P | null;
  /** Tick it last came home turned back (a loaded Condor waits AIRLIFT.retry before trying again). */
  turnedBack: number;
  /** A boarding not done by this tick goes with whoever is aboard (or is called off). */
  boardBy: number;
}

interface Memo {
  lifts: Map<number, Lift>;
  /** Relay id → the enemy infantry value we last saw on its island, and when. */
  intel: Map<number, { value: number; tick: number }>;
  /** Anti-air a turned-back lift ran into (where it was seen), until `until`. */
  threats: (Sighting & { until: number })[];
  lastLaunch: number;
  /** Squads the plan could fly out right now (the Assembly Bay reads it). */
  wantSquads: number;
  /** Relays the plan wants more squads on than its Condors are carrying (for a second Condor). */
  openTargets: number;
  /** Relay id → tick of the last air strike sent at it. */
  strikes: Map<number, number>;
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { lifts: new Map(), intel: new Map(), threats: [], lastLaunch: -1e9, wantSquads: 0, openTargets: 0, strikes: new Map() };
    memos.set(s, m);
  }
  return m;
}

/** Relays only robot infantry can take (island Uplinks). */
export const islandRelays = (w: World): Uplink[] => w.objectives.uplinks.filter((l) => l.infantryOnly);

/** Does this commander fly the airlift? On island-relay maps, every personality and difficulty does. */
export function airliftActive(w: World, faction: Faction, _s?: AiState): boolean {
  if (w.survival || !w.objectives.uplinks.some((l) => l.infantryOnly)) return false;
  const K = kindsOf(w, faction);
  return bannedBy(w, K.transport, faction) === null && bannedBy(w, K.line, faction) === null;
}

/**
 * Is this unit cut off from its side's home land (a squad on an island,
 * whether it holds a relay or was stranded there)? Aircraft never are.
 * Only island maps (Rules.islands) have any.
 */
export function offHomeLand(w: World, faction: Faction, u: Unit): boolean {
  if (!w.rules?.islands || UNITS[u.kind].domain === "air") return false;
  return !onHomeLand(w, faction, Math.floor(u.x), Math.floor(u.y));
}

const footRegion = (w: World, p: P): number => regionAt(w, Math.floor(p.x), Math.floor(p.y), "foot");
const valueOf = (us: readonly { kind: Unit["kind"] }[]) => us.reduce((v, u) => v + UNITS[u.kind].cost, 0);

/** Squads the airlift has a claim on this pass (walking up a Condor's ramp): other tactics leave them be. */
export function airliftHolds(w: World, s: AiState): number[] {
  const m = memos.get(s);
  if (!m) return [];
  const out: number[] = [];
  for (const lift of m.lifts.values())
    if (lift.phase === "boarding") for (const id of lift.squads) if (w.units.has(id)) out.push(id);
  return out;
}

/** Squads the plan wants to fly out now that aren't waiting at home: the Assembly Bay makes them first. */
export function airliftSquadsWanted(s: AiState): number {
  return memos.get(s)?.wantSquads ?? 0;
}

/**
 * Should the Airpad build a Condor? Up to AIRLIFT.condors (alive and queued,
 * `have`): the first whenever we have none and can spare the scrap (else the
 * free replacement is on its way), more once the plan has relays waiting
 * that its Condors can't serve.
 */
export function airliftWantsCondor(w: World, faction: Faction, s: AiState, have: number): boolean {
  if (!airliftActive(w, faction, s)) return false;
  if (have >= AIRLIFT.condors[s.difficulty]) return false;
  if (have === 0) return !rulesOf(w).lifeline || w.factions[faction].scrap >= 450;
  const m = memos.get(s);
  return !!m && w.tick >= AIRLIFT.secondFrom * TICK_RATE && m.openTargets > have;
}

export interface AirliftContext {
  /** All our units on the field. */
  mine: Unit[];
  /** The army on home land (combat units). */
  army: Unit[];
  /** Units already given orders this pass (updated in place). */
  used: Set<number>;
  hqC: P;
  /** Enemy units we can see. */
  seen: Unit[];
  /** A real attack on the base is under way: no new lifts board. */
  threatened: boolean;
  /** Condors on (or held for) a Goliath's lift (ai/goliath.ts liftCondors): never the airlift's to fly. */
  skip?: ReadonlySet<number>;
}

/** Is Condor `id` out on an airlift trip (boarding, outbound, coming back) or loaded? Not one to lend a Goliath's lift. */
export function airliftBusy(s: AiState, id: number): boolean {
  const lift = memos.get(s)?.lifts.get(id);
  return !!lift && (lift.phase !== "home" || lift.squads.length > 0);
}

interface Island {
  l: Uplink;
  region: number;
  /** Our squads on the island. */
  ours: Unit[];
  /** Enemy squads we see on it. */
  theirs: Unit[];
  /** Enemy infantry value we reckon is there (seen now, remembered, or guessed). */
  enemy: number;
  /** Enemy Wasps and Hornets we see over it… */
  air: Unit[];
  /** …and all a landing there has to beat: their squads and those drones. */
  guard: number;
}

/** One decision pass: garrisons, lifts, intercepts. */
export function planAirlift(w: World, faction: Faction, s: AiState, ctx: AirliftContext): Command[] {
  const cmds: Command[] = [];
  if (!airliftActive(w, faction, s)) return cmds;
  const relays = islandRelays(w);
  const m = memo(s);
  const enemy: Faction = faction === "blue" ? "red" : "blue";
  const fr = sideFrame(w, faction);
  const tps = TICK_RATE;

  // --- the islands: who's on each (ours, and what we see or saw of theirs) --
  const islands: Island[] = relays.map((l) => {
    const region = footRegion(w, l);
    const ours = ctx.mine.filter((u) => isInfantry(u.kind) && footRegion(w, u) === region);
    const theirs = ctx.seen.filter((u) => isInfantry(u.kind) && footRegion(w, u) === region);
    const seenValue = valueOf(theirs);
    // the relay in plain sight (ours, or someone of ours close by): what we see is all there is
    if (theirs.length > 0 || isVisible(w, faction, Math.floor(l.x), Math.floor(l.y)))
      m.intel.set(l.id, { value: seenValue, tick: w.tick });
    const intel = m.intel.get(l.id);
    const recent = intel && w.tick - intel.tick < AIRLIFT.recall * tps;
    const enemyValue = theirs.length > 0 ? seenValue : recent ? intel!.value : l.owner === enemy ? AIRLIFT.guess : 0;
    // their drones circling it (in sight now) shoot up a landing as surely as a garrison
    const air = ctx.seen.filter((u) => isAirStriker(u.kind) && dist(u.x, u.y, l.x, l.y) <= AIRLIFT.airGuard);
    return { l, region, ours, theirs, enemy: enemyValue, air, guard: enemyValue + valueOf(air) };
  });

  // --- garrisons: our squads on an island hold its relay -------------------
  for (const it of islands) {
    for (const u of it.ours) ctx.used.add(u.id);
    const fight = it.theirs.length > 0;
    it.ours.forEach((u, i) => {
      if (u.order.type !== "idle" || u.autoTargetId !== null) return; // busy (moving, or shooting at something)
      const inZone = dist(u.x, u.y, it.l.x, it.l.y) <= OBJECTIVES.uplink.radius - 0.6;
      if (inZone && !fight) return;
      const post = postSpot(w, faction, it, i);
      if (dist(u.x, u.y, post.x, post.y) <= 0.6) return;
      cmds.push({ type: "attackMove", faction, unitIds: [u.id], x: post.x, y: post.y });
    });
  }

  // --- what each relay still needs -----------------------------------------
  const crewOf = (l: Uplink) => (s.difficulty !== "easy" && uplinkPay(l) >= AIRLIFT.richPay ? AIRLIFT.richCrew : 1);
  /** Squad value headed for relay `id` aboard (or boarding) Condors other than `skip`. */
  const inbound = (id: number, skip: number | null): number => {
    let v = 0;
    for (const [cid, lift] of m.lifts) {
      if (cid === skip || lift.target !== id || (lift.phase !== "boarding" && lift.phase !== "outbound")) continue;
      const c = w.units.get(cid);
      if (!c) continue;
      v += valueOf(c.passengers ?? []);
      if (lift.phase === "boarding")
        for (const sid of lift.squads) {
          const u = w.units.get(sid);
          if (u) v += UNITS[u.kind].cost;
        }
    }
    return v;
  };
  /** Value still wanted on a relay's island (0: enough there or on the way), for a lift other than `skip`. */
  const deficit = (it: Island, skip: number | null): number => {
    const l = it.l;
    if (s.difficulty === "easy" && (l.owner === enemy || it.guard > 0)) return 0; // Easy: neutral and our own only
    const ours = valueOf(it.ours) + inbound(l.id, skip);
    const want = it.guard > 0 ? Math.max(it.guard * AIRLIFT.edge, crewOf(l) * 100) : crewOf(l) * 100;
    // ours, crewed and quiet: nothing to do
    if (l.owner === faction && it.ours.length >= crewOf(l) && it.guard === 0) return 0;
    return Math.max(0, want - ours);
  };

  // remembered anti-air (a turned-back lift's), plus what we see
  m.threats = m.threats.filter((t) => t.until > w.tick);
  const seenIds = new Set(ctx.seen.map((u) => u.id));
  const enemies: Sighting[] = [...ctx.seen, ...m.threats.filter((t) => !seenIds.has(t.id))];

  /**
   * The best relay for Condor `c` with squads worth `cargo` (aboard, or about
   * to board): where it lands, and how it gets there clear of anti-air (the
   * target island's own squads aside: those are what the cargo is weighed
   * against). Null when nothing is worth the trip.
   */
  const pick = (c: Unit, cargo: number, skip: number | null): { it: Island; drop: P; waypoint: P | null } | null => {
    let best: { it: Island; drop: P; waypoint: P | null; score: number; key: P } | null = null;
    const hq = ctx.hqC;
    const enemyHq = { x: w.width - hq.x, y: w.height - hq.y };
    for (const it of islands) {
      const l = it.l;
      const need = deficit(it, skip);
      if (need <= 0) continue;
      const have = valueOf(it.ours) + inbound(l.id, skip);
      // land on a garrison (or under their drones) only able to beat it (with whoever is there already)
      if (it.guard > 0 && have + cargo < it.guard * AIRLIFT.edge) continue;
      const at = landingSpot(w, faction, it, hq);
      if (!at) continue;
      const others = enemies.filter((e) => !(isInfantry(e.kind) && footRegion(w, e) === it.region));
      const { clear } = airspace(w, faction, others);
      const waypoint = route(w, c, at, clear);
      if (waypoint === undefined) continue;
      const flight = dist(c.x, c.y, at.x, at.y) + (waypoint ? 4 : 0);
      const theirs = l.owner === enemy ? 1.6 : 1; // their income lost as well as ours gained
      // nearer them than us: they'll fight for it (a personality's caution)
      const dUs = dist(l.x, l.y, hq.x, hq.y);
      const dThem = dist(l.x, l.y, enemyHq.x, enemyHq.y);
      const exposure = Math.max(-1, Math.min(1, (dUs - dThem) / 20));
      const caution = AIRLIFT.caution[s.strategy.name] ?? 0.5;
      let score = (uplinkPay(l) * theirs * 60) / (flight / UNITS.condor.speed + 20);
      score *= 1 - 0.35 * caution * exposure;
      // a lone squad racing them to a relay as near them as us (the centre at the start) is a
      // coin toss: one that is ours for the taking first, the race with a full load
      if (l.owner === null && it.ours.length === 0 && cargo < 200 && exposure > -0.3) score *= 0.4;
      score -= it.guard / 100; // a fight first
      if (l.owner === faction && !l.crewed) score *= 1.3; // ours, standing empty: cheap to put right
      const key = fr.pt(l);
      const better =
        !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && (key.y < best.key.y || (key.y === best.key.y && key.x < best.key.x)));
      if (better) best = { it, drop: at, waypoint, score, key };
    }
    return best ? { it: best.it, drop: best.drop, waypoint: best.waypoint } : null;
  };

  // --- lifts: every Condor of ours -----------------------------------------
  const home = homeSpot(w, faction, ctx.hqC);
  // (not a Condor on a Goliath's lift: an order to it would redirect or set down the Goliath)
  const condors = ctx.mine
    .filter((u) => isTransport(u.kind) && u.order.type !== "lift" && !ctx.skip?.has(u.id))
    .sort((a, b) => a.id - b.id);
  for (const id of [...m.lifts.keys()]) if (!w.units.has(id)) m.lifts.delete(id);
  // squads free to fly, nearest home first (Sniper Teams only when nobody else is free;
  // Rocket Squads first once the enemy flies drones: a garrison is its own anti-air)
  const K = kindsOf(w, faction);
  const antiAir = (k: Unit["kind"]) => K.infAA !== K.line && k === K.infAA;
  const rank = (u: Unit) => (isSniper(u.kind) ? 2 : antiAir(u.kind) && s.seenAir >= 2 ? 0 : 1);
  const pool = ctx.army
    .filter(
      (u) =>
        isInfantry(u.kind) && !ctx.used.has(u.id) && (u.order.type === "idle" || u.order.type === "attackMove") &&
        u.autoTargetId === null && u.hp >= UNITS[u.kind].hp * AIRLIFT.minHp &&
        dist(u.x, u.y, home.x, home.y) <= AIRLIFT.reach
    )
    .sort((a, b) => rank(a) - rank(b) || dist(a.x, a.y, home.x, home.y) - dist(b.x, b.y, home.x, home.y));
  const takeRecruits = (n: number): Unit[] => {
    const out: Unit[] = [];
    for (const u of pool) {
      if (out.length >= n) break;
      if (ctx.used.has(u.id)) continue;
      out.push(u);
      ctx.used.add(u.id);
    }
    return out;
  };
  /**
   * Spare squads on a relay we hold, crewed and quiet (no enemy squad or drone
   * in sight there): those beyond its crew, Rocket Squads kept back (they are
   * its anti-air), at most a Condor's load. The first such island, in our frame.
   */
  const surplus = (): { it: Island; squads: Unit[] } | null => {
    for (const it of [...islands].sort((a, b) => fr.pt(a.l).y - fr.pt(b.l).y || fr.pt(a.l).x - fr.pt(b.l).x)) {
      const extra = it.ours.length - crewOf(it.l);
      if (it.l.owner !== faction || !it.l.crewed || extra <= 0 || it.guard > 0) continue;
      const squads = it.ours
        .filter((u) => u.order.type === "idle" && u.autoTargetId === null && u.hp >= UNITS[u.kind].hp * AIRLIFT.minHp)
        .sort((a, b) => (antiAir(a.kind) ? 1 : 0) - (antiAir(b.kind) ? 1 : 0) || a.id - b.id)
        .slice(0, Math.min(extra, cap));
      if (squads.length > 0) return { it, squads };
    }
    return null;
  };
  const started = w.tick >= AIRLIFT.from[s.difficulty] * tps;
  const spaced = () => w.tick - m.lastLaunch >= AIRLIFT.every[s.difficulty] * tps;
  const cap = UNITS.condor.capacity ?? 2;
  const avgSquad = 110;

  for (const c of condors) {
    let lift = m.lifts.get(c.id);
    if (!lift) {
      lift = { phase: "home", target: null, squads: [], since: w.tick, launchHp: c.hp, drop: null, waypoint: null, turnedBack: -1e9, boardBy: 0 };
      m.lifts.set(c.id, lift);
    }
    const L = lift;
    const setPhase = (p: Phase) => {
      if (L.phase !== p) L.since = w.tick;
      L.phase = p;
    };
    const cargo = () => valueOf(c.passengers ?? []);
    const goHome = () => {
      if (dist(c.x, c.y, home.x, home.y) > 2 && (c.order.type === "idle" || c.order.type === "move"))
        cmds.push({ type: "move", faction, unitIds: [c.id], x: home.x, y: home.y });
    };
    const launch = (plan: { it: Island; drop: P; waypoint: P | null }) => {
      L.target = plan.it.l.id;
      L.drop = plan.drop;
      L.waypoint = plan.waypoint;
      L.launchHp = c.hp;
      L.squads = (c.passengers ?? []).map((p) => p.id);
      m.lastLaunch = w.tick;
      if (plan.waypoint) cmds.push({ type: "move", faction, unitIds: [c.id], x: plan.waypoint.x, y: plan.waypoint.y });
      else cmds.push({ type: "unload", faction, unitIds: [c.id], x: plan.drop.x, y: plan.drop.y });
      setPhase("outbound");
    };
    const turnBack = (threat: boolean) => {
      if (threat) noteThreats(w, m, c, L.drop, ctx.seen);
      L.turnedBack = w.tick;
      L.target = null;
      cmds.push({ type: "move", faction, unitIds: [c.id], x: home.x, y: home.y });
      setPhase("return");
    };
    const hurt = () => c.hp < L.launchHp - UNITS.condor.hp * AIRLIFT.abortLoss;

    switch (L.phase) {
      case "home": {
        if (isLoaded(c)) {
          // a lift that turned back (or a Condor that came with a squad aboard): go again
          if (w.tick - L.turnedBack < AIRLIFT.retry * tps || !started) {
            goHome();
            break;
          }
          const plan = c.order.type === "unload" ? null : pick(c, cargo(), c.id);
          if (plan) launch(plan);
          else if (w.tick - L.since > AIRLIFT.idleUnload * tps && dist(c.x, c.y, home.x, home.y) <= 3 && c.order.type === "idle")
            cmds.push({ type: "unload", faction, unitIds: [c.id] }); // nothing wants them: they walk
          else goHome();
          break;
        }
        // flying in (the free replacement) or back from a drop: home first
        if (c.order.type !== "idle" || dist(c.x, c.y, home.x, home.y) > 6) {
          goHome();
          break;
        }
        if (!started || ctx.threatened || !spaced()) break;
        const free = pool.filter((u) => !ctx.used.has(u.id));
        if (free.length === 0) {
          // nobody free at home: a secured island's spare squads, flown on to where they're short
          const spare = surplus();
          if (!spare) break;
          const plan = pick(c, valueOf(spare.squads), c.id);
          if (!plan || plan.it === spare.it) break;
          L.target = plan.it.l.id;
          L.squads = spare.squads.map((u) => u.id);
          L.boardBy = w.tick + Math.round((dist(c.x, c.y, spare.it.l.x, spare.it.l.y) / UNITS.condor.speed + AIRLIFT.boardTimeout) * tps);
          cmds.push({ type: "move", faction, unitIds: [c.id], x: spare.it.l.x, y: spare.it.l.y });
          cmds.push({ type: "board", faction, unitIds: L.squads, carrierId: c.id });
          setPhase("boarding");
          break;
        }
        const potential = valueOf(free.slice(0, cap));
        const plan = pick(c, potential, c.id);
        if (!plan) break;
        const want = Math.min(cap, Math.max(1, Math.ceil(deficit(plan.it, c.id) / avgSquad)));
        const picks = takeRecruits(want);
        if (picks.length === 0) break;
        L.target = plan.it.l.id;
        L.squads = picks.map((u) => u.id);
        L.boardBy = w.tick + AIRLIFT.boardTimeout * tps;
        cmds.push({ type: "board", faction, unitIds: L.squads, carrierId: c.id });
        setPhase("boarding");
        break;
      }
      case "boarding": {
        const inHold = (c.passengers ?? []).map((p) => p.id);
        const walking = L.squads.filter((id) => {
          const u = w.units.get(id);
          return !!u && u.order.type === "board" && u.order.carrierId === c.id;
        });
        for (const id of walking) ctx.used.add(id);
        const late = w.tick > L.boardBy;
        L.squads = [...inHold, ...walking];
        if (ctx.threatened) {
          if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
          if (inHold.length > 0) cmds.push({ type: "unload", faction, unitIds: [c.id] });
          L.target = null;
          setPhase("home");
        } else if (walking.length === 0 || late || freeSeats(c) === 0) {
          if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
          if (inHold.length === 0) {
            L.target = null;
            setPhase("home");
            break;
          }
          const plan = pick(c, cargo(), c.id);
          if (plan) launch(plan);
          else {
            L.target = null;
            setPhase("home"); // nothing wants them now: they wait aboard (and walk if it stays that way)
          }
        }
        break;
      }
      case "outbound": {
        if (!isLoaded(c)) {
          // down: the squads hold the island (garrisons, above); home for the next load
          L.target = null;
          L.squads = [];
          cmds.push({ type: "move", faction, unitIds: [c.id], x: home.x, y: home.y });
          setPhase("return");
          break;
        }
        if (hurt()) {
          turnBack(true);
          break;
        }
        const it = islands.find((x) => x.l.id === L.target);
        // still worth it, and still within our means? Else another relay from here, or home
        const stale = !it || deficit(it, c.id) <= 0 || (it.guard > 0 && valueOf(it.ours) + inbound(it.l.id, c.id) + cargo() < it.guard * AIRLIFT.edge);
        if (stale) {
          if (it && it.theirs.length > 0) noteThreats(w, m, c, L.drop, ctx.seen);
          const plan = pick(c, cargo(), c.id);
          if (plan) launch(plan);
          else turnBack(false);
          break;
        }
        const wp = L.waypoint;
        if (wp && c.order.type === "move" && dist(c.x, c.y, wp.x, wp.y) > 1.5) break; // on the flank leg
        if (c.order.type !== "unload") {
          // over the waypoint (or knocked off course): straight in from here
          L.waypoint = null;
          const drop = L.drop ?? { x: it!.l.x, y: it!.l.y };
          cmds.push({ type: "unload", faction, unitIds: [c.id], x: drop.x, y: drop.y });
        }
        break;
      }
      case "return": {
        if (c.order.type === "unload") break; // setting squads down at home
        if (dist(c.x, c.y, home.x, home.y) <= 3 && c.order.type === "idle") setPhase("home");
        else goHome();
        break;
      }
    }
  }

  // --- what the Assembly Bay and the Airpad should know ---------------------
  let want = 0;
  let open = 0;
  for (const it of islands) {
    const d = deficit(it, null);
    if (d <= 0) continue;
    open++;
    want += Math.min(cap, Math.ceil(d / avgSquad));
  }
  const waiting = pool.filter((u) => !ctx.used.has(u.id));
  m.wantSquads = Math.max(0, want + 1 - waiting.length);
  m.openTargets = open;
  // the squads the next lifts will want wait at home (not swept off with a wave or to a guard post)
  // (no more than the airlift's own Condors could carry: Condors bought for a Goliath's lift
  // and back from it don't keep a second wave of squads sitting at home)
  const empty = Math.min(AIRLIFT.condors[s.difficulty], condors.filter((c) => !isLoaded(c)).length);
  waiting.slice(0, Math.min(want, cap * empty)).forEach((u) => ctx.used.add(u.id));

  // --- intercepts: enemy Condors near our relays, base or Condors -----------
  cmds.push(...intercepts(w, faction, ctx, islands));
  // --- air strikes: Wasps and Hornets clear enemy garrisons -----------------
  cmds.push(...strikes(w, faction, s, m, ctx, islands, enemies));
  return cmds;
}

/**
 * Air strikes on island garrisons: a relay the enemy holds (or whose island
 * their squads stand on, where we have none) gets our idle Wasps and Hornets
 * sent at it, when they outweigh the garrison we know of by
 * AIRLIFT.strikeEdge and no other anti-air we see or remember covers it. The
 * best-paying relay first; one strike per pass. A cleared island is then an
 * easy lift (planAirlift sees it empty).
 */
function strikes(
  w: World,
  faction: Faction,
  s: AiState,
  m: Memo,
  ctx: AirliftContext,
  islands: readonly Island[],
  enemies: readonly Sighting[]
): Command[] {
  if (s.difficulty === "easy") return [];
  const enemy: Faction = faction === "blue" ? "red" : "blue";
  const bombers = ctx.army.filter(
    (u) => isAirStriker(u.kind) && u.order.type === "idle" && !ctx.used.has(u.id) && u.hp >= UNITS[u.kind].hp * 0.5
  );
  if (bombers.length === 0) return [];
  const targets = islands
    .filter((it) => (it.l.owner === enemy || it.theirs.length > 0) && it.ours.length === 0 && it.enemy > 0)
    .filter((it) => w.tick - (m.strikes.get(it.l.id) ?? -1e9) >= AIRLIFT.strikeEvery * TICK_RATE)
    .sort((a, b) => uplinkPay(b.l) - uplinkPay(a.l) || dist(a.l.x, a.l.y, ctx.hqC.x, ctx.hqC.y) - dist(b.l.x, b.l.y, ctx.hqC.x, ctx.hqC.y));
  for (const it of targets) {
    const l = it.l;
    // anti-air there besides the garrison itself (that, the strike outweighs)
    const others = enemies.filter((e) => !(isInfantry(e.kind) && footRegion(w, e) === it.region));
    if (aaStrengthAt(aaSources(w, faction, others), l.x, l.y) >= AA_COVER) continue;
    const need = Math.max(AIRLIFT.strikeMin, it.enemy * AIRLIFT.strikeEdge);
    const wing: Unit[] = [];
    let v = 0;
    for (const u of [...bombers].sort((a, b) => dist(a.x, a.y, l.x, l.y) - dist(b.x, b.y, l.x, l.y))) {
      if (v >= need) break;
      wing.push(u);
      v += UNITS[u.kind].cost;
    }
    if (v < need) continue;
    for (const u of wing) ctx.used.add(u.id);
    m.strikes.set(l.id, w.tick);
    return [{ type: "attackMove", faction, unitIds: wing.map((u) => u.id), x: l.x, y: l.y }];
  }
  return [];
}

/**
 * Where a lift sets its squads down on a relay's island: inside the zone a
 * little short of the relay on our side (two sides racing for one relay land
 * apart and fight for it, rather than on each other's heads), snapped to
 * ground squads can stand on (dropPoint) — and it must be the relay's
 * island, not a shore or another island nearby. Null when there's no such spot.
 */
function landingSpot(w: World, faction: Faction, it: Island, hqC: P): P | null {
  const l = it.l;
  const d = Math.max(0.01, dist(l.x, l.y, hqC.x, hqC.y));
  const short = AIRLIFT.landShort;
  for (const aim of [{ x: l.x + ((hqC.x - l.x) / d) * short, y: l.y + ((hqC.y - l.y) / d) * short }, { x: l.x, y: l.y }]) {
    const at = dropPoint(w, faction, aim.x, aim.y);
    if (at && footRegion(w, at) === it.region && dist(at.x, at.y, l.x, l.y) <= OBJECTIVES.uplink.radius - 0.5) return at;
  }
  return null;
}

/** Where our Condors wait at home: just behind the HQ, away from the enemy, over ground squads can walk up to. */
function homeSpot(w: World, faction: Faction, hqC: P): P {
  const enemyGuess = { x: w.width - hqC.x, y: w.height - hqC.y };
  const back = Math.max(1, dist(hqC.x, hqC.y, enemyGuess.x, enemyGuess.y));
  const behind = { x: hqC.x - ((enemyGuess.x - hqC.x) / back) * 2.5, y: hqC.y - ((enemyGuess.y - hqC.y) / back) * 2.5 };
  return dropPoint(w, faction, behind.x, behind.y) ?? behind;
}

/**
 * Garrison squad `i`'s post on its relay: the relay itself for the first,
 * a small ring round it for the rest (in the side's own frame, so mirror-image
 * garrisons stand as mirror images), on ground of the island.
 */
function postSpot(w: World, faction: Faction, it: Island, i: number): P {
  const l = it.l;
  if (i === 0) return { x: l.x, y: l.y };
  const fr = sideFrame(w, faction);
  const c = fr.pt(l);
  const a = (i - 1) * ((2 * Math.PI) / 5) + 0.6;
  const p = fr.pt({ x: c.x + sin(a) * 1.1, y: c.y - cos(a) * 1.1 });
  return footRegion(w, p) === it.region ? p : { x: l.x, y: l.y };
}

/** A lift turned back: remember the anti-air (and guards) in sight near it or its landing zone. */
function noteThreats(w: World, m: Memo, c: Unit, drop: P | null, seen: readonly Unit[]): void {
  const until = w.tick + AIRLIFT.threatRecall * TICK_RATE;
  const r = AIRLIFT.threatRadius;
  for (const e of seen) {
    if (aaWeight(UNITS[e.kind]) <= 0) continue;
    if (dist(e.x, e.y, c.x, c.y) > r && (!drop || dist(e.x, e.y, drop.x, drop.y) > r)) continue;
    m.threats = m.threats.filter((t) => t.id !== e.id);
    m.threats.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, until });
  }
}

/**
 * Enemy Condors (unarmed: the threat response skips them) seen within
 * AIRLIFT.interceptRadius of a relay we hold or crew, of our base, or of a
 * Condor of ours: our idle units that can shoot them down go after them,
 * Raptors first. Ground units only when close and able to get in range
 * (never across the sea).
 */
function intercepts(w: World, faction: Faction, ctx: AirliftContext, islands: readonly Island[]): Command[] {
  const cmds: Command[] = [];
  const R = AIRLIFT.interceptRadius;
  const ourCondors = ctx.mine.filter((u) => isTransport(u.kind));
  // their drones over an island our squads hold: the garrison can't run, so the fighters come
  const bombers = new Set(islands.filter((it) => it.ours.length > 0).flatMap((it) => it.air.map((u) => u.id)));
  for (const e of ctx.seen) {
    const near = (p: P, r = R) => dist(e.x, e.y, p.x, p.y) <= r;
    if (isTransport(e.kind)) {
      const relevant =
        islands.some((it) => (it.l.owner === faction || it.ours.length > 0) && near(it.l)) ||
        near(ctx.hqC, R + 4) ||
        ourCondors.some((c) => near(c, 8));
      if (!relevant) continue;
    } else if (!bombers.has(e.id)) continue;
    const chasing = ctx.army.filter((u) => u.order.type === "attack" && u.order.targetId === e.id).length;
    const want = AIRLIFT.interceptors;
    if (chasing >= want) continue;
    const able = ctx.army
      .filter((u) => {
        if (ctx.used.has(u.id) || u.order.type !== "idle" || isTransport(u.kind)) return false;
        if (effectiveness(u.kind, e.kind) < USELESS) return false;
        if (UNITS[u.kind].domain === "air") return true;
        return dist(u.x, u.y, e.x, e.y) <= AIRLIFT.interceptGround && canGetWithin(w, moveClassOf(u.kind), u.x, u.y, e.x, e.y, UNITS[u.kind].range);
      })
      .sort((a, b) => (isInterceptor(a.kind) ? 0 : 1) - (isInterceptor(b.kind) ? 0 : 1) || dist(a.x, a.y, e.x, e.y) - dist(b.x, b.y, e.x, e.y))
      .slice(0, want - chasing);
    if (able.length === 0) continue;
    for (const u of able) ctx.used.add(u.id);
    cmds.push({ type: "attack", faction, unitIds: able.map((u) => u.id), targetId: e.id });
  }
  return cmds;
}
