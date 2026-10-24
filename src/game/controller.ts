import { BUILDINGS, ECONOMY, GOLIATH, TICK_RATE, UNITS } from "../sim/balance";
import { behaves, buildingCostFor, buildingMaxHp } from "../sim/nations";
import { paidFor, producerCap, producersOf, type Producer } from "../sim/economy";
import { anchorBlocker, canWalk, goliathReachAt, unitCost } from "../sim/goliath";
import { isInfantry, isTransport } from "../sim/infantry";
import { LIFT_NEEDS_TWO, LIFT_PACK_FIRST, canCarry, liftBlocker, liftedBy } from "../sim/lift";
import { marchLayout } from "../sim/march";
import { placementBlocker, snapPlacement } from "../sim/placement";
import { POWER_NAMES, powerBlocker, powerCost, powerStatus, type PowerStatus } from "../sim/powers";
import { carrierOf, freeSeats, isLoaded } from "../sim/transport";
import type { BuildingKind, Command, Faction, GoliathMode, PendingBuilding, PowerKind, Unit, UnitKind, UnitOrder, World } from "../sim/types";
import { buildingAtTile, distToBuilding, domainOf, isResource, moveClassOf, onHomeLand, regionAt, tileIndex } from "../sim/world";
import { engageable } from "../sim/combat";
import { Squads } from "./squads";
import { roleGroups, type Role } from "./roles";
import type { Pt } from "./route-draw";
import { tr } from "../lang";

/**
 * The side this device commands, and the other one. Live bindings: every
 * importer reads the current value, so a sound duel's guest (or `?side=red`)
 * plays red with no other change. Set once with setLocalSide, before
 * `new GameScene`: the scene's presenters, its fog and the Controller's
 * squads copy the side when they are built.
 */
export let PLAYER: Faction = "blue";
export let ENEMY: Faction = "red";

/** Command `f` from now on (SOUND-DUEL.md "Playing red"); a page reload starts over as blue. */
export function setLocalSide(f: Faction): void {
  PLAYER = f;
  ENEMY = f === "blue" ? "red" : "blue";
}

/**
 * Is this one of the player's fighting units (⚔ Select army, 💤 Idle)? Not a
 * harvester, and not an unarmed Condor: it would outrun the army and park
 * alone in the enemy base.
 */
export const isArmyUnit = (u: Unit): boolean => u.faction === PLAYER && !behaves(u.kind, "harvester") && !isTransport(u.kind);

/**
 * A Goliath dug in where it stands (digging in, or anchored): a move would
 * pack it up, so taps give it a rally point instead and the army marches
 * without it. One packing up isn't rooted: it takes a move and walks off
 * once it is free.
 */
export const isRooted = (u: Unit): boolean => u.goliath?.mode === "anchoring" || u.goliath?.mode === "anchored";

/**
 * Can Goliath `u` fire on target `id` from where it stands (a weapon that can
 * hit it reaches it)? An anchored one is only told to attack what it can: it
 * would otherwise keep the order and walk off after the target once packed up.
 */
export function inReachFromHere(w: World, u: Unit, id: number): boolean {
  const b = w.buildings.get(id);
  if (b) return distToBuilding(b, u.x, u.y) <= goliathReachAt(u, "ground");
  const t = w.units.get(id);
  return !!t && Math.hypot(t.x - u.x, t.y - u.y) <= goliathReachAt(u, domainOf(t));
}

/** The lift a unit belongs to: the Goliath itself (hooked on or carried), or the Goliath its Condor is lifting. */
export const liftOf = (w: World, u: Unit): Unit | null => (u.goliath?.lift ? u : liftedBy(w, u));

const PRODUCERS: ReadonlySet<BuildingKind> = new Set(Object.values(UNITS).map((u) => u.builtAt));
/** Does this building turn out units (so a tap with it selected sets its rally point)? HQ, Fab Plant, Airpad, Assembly Bay, Gantry. */
export const isProducer = (kind: BuildingKind): boolean => PRODUCERS.has(kind);

/**
 * Where a unit of `kind` from the build bar is queued: on a selected anchored
 * Goliath first (the player is looking at it), else the shortest queue, ties
 * going to the earlier producer (buildings in id order, then anchored
 * Goliaths, as sim/economy.ts producersOf lists them). Null when every queue
 * is full.
 */
export function pickProducer(w: World, kind: UnitKind, selected: ReadonlySet<number>, view?: BuildView): Producer | null {
  // (a sound duel: orders on their way count as queued already, and a producer sold or packing up is gone, BuildView)
  const len = (p: Producer) => p.queue.length + (view?.extra(p.id) ?? 0);
  const open = producersOf(w, PLAYER, kind).filter((p) => len(p) < producerCap(kind) && !view?.closed(p.id));
  const picked = open.filter((p) => p.goliath && selected.has(p.id));
  let best: Producer | null = null;
  for (const p of picked.length > 0 ? picked : open) if (!best || len(p) < len(best)) best = p;
  return best;
}

/**
 * A side's construction, scrap and queues as the build bar shows them: the
 * world's, with the placement and production orders still on their way
 * applied (Controller.inFlight). In a sound duel an order lands D ticks after
 * the tap, and the bar must not offer the same tap again meanwhile: a placed
 * building is no longer ready to place, one started is under construction,
 * a unit ordered is queued and paid for, a building sold is paid back and
 * gone, an anchored Goliath packing up trains no more. Without orders in
 * flight it is the world's own state.
 */
export interface BuildView {
  scrap: number;
  pending: PendingBuilding | null;
  /** Units queued at producer `id` beyond its queue in the world (of `kind` only, when given; negative: cancels on their way). */
  extra(id: number, kind?: UnitKind): number;
  /** Is producer `id` gone (sold), or a Goliath packing up (it trains only anchored)? */
  closed(id: number): boolean;
}

/** buildView's rules: each order as the sim would take it now (economy.ts), in the order they were given. */
export function buildView(w: World, side: Faction, orders: readonly Command[] | null): BuildView {
  const f = w.factions[side];
  if (!orders?.length) return { scrap: f.scrap, pending: f.pending, extra: () => 0, closed: () => false };
  let scrap = f.scrap;
  let pending: PendingBuilding | null = f.pending;
  const queued: { id: number; kind: UnitKind; n: number; paid: number }[] = [];
  const closed = new Set<number>();
  for (const c of orders)
    switch (c.type) {
      case "startBuilding":
        if (!pending && scrap >= BUILDINGS[c.building].cost) {
          scrap -= BUILDINGS[c.building].cost;
          pending = { kind: c.building, remaining: BUILDINGS[c.building].buildTime * TICK_RATE, ready: false };
        }
        break;
      case "cancelBuilding":
        if (pending) scrap += BUILDINGS[pending.kind].cost;
        pending = null;
        break;
      case "placeBuilding":
        if (pending?.ready) pending = null;
        break;
      case "produce": {
        const cost = unitCost(w, side, c.unit);
        if (scrap >= cost && !closed.has(c.buildingId)) {
          scrap -= cost;
          queued.push({ id: c.buildingId, kind: c.unit, n: 1, paid: cost });
        }
        break;
      }
      case "cancelProduce": {
        // (one of ours still on its way goes first; else one the world holds, refunded)
        let i = -1;
        for (let k = queued.length - 1; k >= 0; k--)
          if (queued[k]!.id === c.buildingId && queued[k]!.kind === c.unit && queued[k]!.n > 0) {
            i = k;
            break;
          }
        if (i >= 0) {
          scrap += queued[i]!.paid;
          queued.splice(i, 1);
        } else {
          scrap += UNITS[c.unit].cost;
          queued.push({ id: c.buildingId, kind: c.unit, n: -1, paid: 0 });
        }
        break;
      }
      case "sell": {
        // (economy.ts sellBuilding: its health's share of the price, and what its queue paid: ours on the way
        // in, the cancels on the way, refunded already, out)
        const b = w.buildings.get(c.buildingId);
        if (!b || b.faction !== side || b.kind === "hq" || closed.has(b.id)) break;
        let paid = b.queue.reduce((s, q) => s + paidFor(q), 0);
        for (let k = queued.length - 1; k >= 0; k--)
          if (queued[k]!.id === b.id) {
            paid += queued[k]!.n > 0 ? queued[k]!.paid : -UNITS[queued[k]!.kind].cost;
            queued.splice(k, 1);
          }
        scrap += Math.floor(buildingCostFor(w, side, b.kind) * ECONOMY.sellRefund * (b.hp / buildingMaxHp(w, b)) + paid);
        closed.add(b.id);
        break;
      }
      case "packUp":
        for (const id of c.unitIds) {
          const g = w.units.get(id)?.goliath;
          if (g && (g.mode === "anchored" || g.mode === "anchoring")) closed.add(id);
        }
        break;
    }
  return {
    scrap,
    pending,
    extra: (id, kind) => queued.reduce((n, q) => n + (q.id === id && (kind === undefined || q.kind === kind) ? q.n : 0), 0),
    closed: (id) => closed.has(id)
  };
}

/**
 * The player's units as the Controller reads them (Controller.ahead()): the
 * world's, with this side's own orders still on their way applied, in the
 * order they were given. In a sound duel an order lands D ticks after the
 * tap (later while the link holds it up), and a tap that builds on the one
 * before must find that one done, as single player does a tick later: two
 * Condors sent to lift a Goliath and then the map tapped fly the lift there
 * once it is up; squads sent to board and then an island tapped drop there
 * once aboard; a Goliath told to anchor and then the map tapped stays dug in
 * and sets a rally point; a second ⚓ packs it up. So every read that decides
 * such a tap goes through here: each unit's order, a Goliath's mode and lift,
 * a building sold, a rally point moved, the calldowns fired. The rules are
 * the sim's (sim.ts applyCommand, lift.ts routeLiftCommand and
 * applyLiftCommand, transport.ts, goliath.ts), taken as succeeding where they
 * hang on the ground (an anchor the Controller checked when it sent it): an
 * order the sim then refuses just never shows once it lands. Only reads
 * change here: what is sent, and how the sim applies it, never do. With no
 * orders on their way it is the world as it is.
 */
export interface OrdersAhead {
  /** Unit `u` with its order, and a Goliath's mode and lift, as the orders on their way leave them: a copy, or `u` itself when none touches it. */
  unit(u: Unit): Unit;
  /** The lift `u` belongs to (liftOf): its Goliath as unit() has it, or null. */
  liftOf(u: Unit): Unit | null;
  /** Is building `id` sold by an order on its way? */
  sold(id: number): boolean;
  /** Producer `id`'s rally point as the newest order on its way sets it (null: none does). */
  rally(id: number): { x: number; y: number } | null;
  /** The calldowns on their way, oldest first. */
  readonly fired: readonly PowerKind[];
}

const IDLE: UnitOrder = { type: "idle" };
/** The orders a lift takes (lift.ts LiftOrder): they call off one still hooking on when they name its Condors. */
const isLiftOrder = (c: Command): boolean => c.type === "move" || c.type === "attackMove" || c.type === "unload" || c.type === "stop";

/** ordersAhead's rules, over the world's units and the commands in the order they were given. */
export function ordersAhead(w: World, orders: readonly Command[] | null): OrdersAhead {
  if (!orders?.length) return { unit: (u) => u, liftOf: (u) => liftOf(w, u), sold: () => false, rally: () => null, fired: [] };
  const copies = new Map<number, Unit>();
  const sold = new Set<number>();
  const rally = new Map<number, { x: number; y: number }>();
  const fired: PowerKind[] = [];
  /** Unit `id` as the orders so far leave it. */
  const get = (id: number): Unit | undefined => copies.get(id) ?? w.units.get(id);
  /** Unit `u`'s copy to change (its Goliath state copied too: nothing of the world's is ever touched). */
  const edit = (u: Unit): Unit => {
    let c = copies.get(u.id);
    if (!c) {
      c = u.goliath ? { ...u, goliath: { ...u.goliath } } : { ...u };
      copies.set(u.id, c);
    }
    return c;
  };
  /** goliath.ts setMode: the transition starts from the top, so the HUD's progress reads 0%. */
  const setMode = (u: Unit, mode: GoliathMode, seconds: number) => {
    const g = edit(u).goliath!;
    g.mode = mode;
    g.modeTicks = Math.round(seconds * TICK_RATE);
  };
  /** lift.ts liftedBy, on the units as the orders so far leave them. */
  const liftedByNow = (c: Unit): Unit | null => {
    if (c.order.type !== "lift") return null;
    const g = get(c.order.goliathId);
    return g?.goliath?.lift?.carriers.includes(c.id) ? g : null;
  };
  /** The units command `c` names that are its side's, as they stand now. */
  const named = (c: Extract<Command, { unitIds: number[] }>, lifting?: ReadonlySet<number>): Unit[] => {
    const out: Unit[] = [];
    for (const id of c.unitIds) {
      const u = get(id);
      if (u && u.faction === c.faction && !lifting?.has(id)) out.push(u);
    }
    return out;
  };
  for (const c of orders) {
    // a lift's own orders first (lift.ts routeLiftCommand): they leave its members out of the rest, and one
    // naming the Condors of a lift still hooking on calls it off (its Condors go idle and take the order)
    const lifting = new Set<number>();
    if ("unitIds" in c && c.type !== "lift")
      for (const id of c.unitIds) {
        // (each as it stands now: a Condor named earlier may have called this one's lift off)
        const u = get(id);
        if (!u || u.faction !== c.faction) continue;
        const g = u.goliath?.lift ? u : liftedByNow(u);
        const lift = g?.goliath?.lift;
        if (!g || !lift) continue;
        lifting.add(u.id);
        if (lift.phase !== "hooking" || u.goliath || !isLiftOrder(c)) continue;
        for (const id of lift.carriers) {
          const k = get(id);
          if (k?.order.type === "lift" && k.order.goliathId === g.id) edit(k).order = IDLE;
        }
        edit(g).goliath!.lift = null;
        lifting.delete(u.id);
        lifting.delete(g.id);
      }
    switch (c.type) {
      case "move":
      case "attackMove":
        for (const u of named(c, lifting)) {
          const e = edit(u);
          e.order = { type: c.type, x: c.x, y: c.y };
          // (goliath.ts orderedToMove: an anchored Goliath packs up first)
          if (e.goliath && !e.goliath.lift && (e.goliath.mode === "anchored" || e.goliath.mode === "anchoring")) setMode(e, "packing", GOLIATH.packTime);
        }
        break;
      case "attack":
        for (const u of named(c, lifting)) edit(u).order = { type: "attack", targetId: c.targetId };
        break;
      case "march": {
        // (march.ts: each to its place; pieces already sent join in the sim, here each piece is laid out alone)
        const units = named(c, lifting);
        const lay = marchLayout(units, { x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, w);
        for (const u of units) {
          const s = lay.slots.get(u.id)!;
          const e = edit(u);
          e.order = { type: c.attack && !behaves(u.kind, "harvester") ? "attackMove" : "move", x: s.x, y: s.y };
          if (e.goliath && !e.goliath.lift && (e.goliath.mode === "anchored" || e.goliath.mode === "anchoring")) setMode(e, "packing", GOLIATH.packTime);
        }
        break;
      }
      case "waypoint":
      case "patrol":
        // (route.ts: one on a move already under way queues behind it; one that isn't sets off now)
        for (const u of named(c, lifting))
          if (u.order.type !== "move" && u.order.type !== "attackMove")
            edit(u).order = { type: behaves(u.kind, "harvester") ? "move" : "attackMove", x: c.x, y: c.y };
        break;
      case "harvest": {
        const tx = Math.floor(c.x);
        const ty = Math.floor(c.y);
        if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height || !isResource(w, tileIndex(w, tx, ty))) break;
        for (const u of named(c, lifting)) if (behaves(u.kind, "harvester")) edit(u).order = { type: "harvest", fieldX: tx, fieldY: ty, phase: "toField" };
        break;
      }
      case "stop":
        for (const u of named(c, lifting)) edit(u).order = IDLE;
        break;
      case "board": {
        const carrier = get(c.carrierId);
        if (!carrier || carrier.faction !== c.faction || !isTransport(carrier.kind)) break;
        for (const u of named(c)) if (isInfantry(u.kind)) edit(u).order = { type: "board", carrierId: carrier.id, ticks: 0 };
        break;
      }
      case "unload":
        for (const u of named(c, lifting)) if (isLoaded(u)) edit(u).order = { type: "unload", x: c.x ?? u.x, y: c.y ?? u.y, hover: -1 };
        break;
      case "anchor":
        for (const u of named(c))
          if (u.goliath && !u.goliath.lift && u.goliath.mode === "walking") {
            edit(u).order = IDLE;
            setMode(u, "anchoring", GOLIATH.anchorTime);
          }
        break;
      case "packUp":
        for (const u of named(c)) if (u.goliath?.mode === "anchored" || u.goliath?.mode === "anchoring") setMode(u, "packing", GOLIATH.packTime);
        break;
      case "lift": {
        const g = get(c.goliathId);
        if (!g || g.faction !== c.faction || !g.goliath) break;
        const condors = named(c).filter((u, i, all) => canCarry(u) && all.indexOf(u) === i);
        if (liftBlocker(condors, g)) break;
        // (the two nearest, ties to the earlier-built)
        condors.sort((a, b) => dist(a, g) - dist(b, g) || a.id - b.id);
        const [a, b] = condors as [Unit, Unit];
        for (const k of [a, b]) edit(k).order = { type: "lift", goliathId: g.id };
        const e = edit(g);
        e.order = IDLE;
        e.goliath!.lift = { carriers: [a.id, b.id], phase: "hooking", dest: null, setDown: false };
        break;
      }
      case "sell":
        sold.add(c.buildingId);
        break;
      case "rally":
        rally.set(c.buildingId, { x: c.x, y: c.y });
        break;
      case "calldown":
        fired.push(c.power);
        break;
    }
  }
  return {
    unit: (u) => copies.get(u.id) ?? u,
    liftOf: (u) => {
      const a = copies.get(u.id) ?? u;
      return a.goliath?.lift ? a : liftedByNow(a);
    },
    sold: (id) => sold.has(id),
    rally: (id) => rally.get(id) ?? null,
    fired
  };
}

/**
 * What the player's last tap did, for on-map feedback markers: "board" —
 * squads were sent to climb into a Condor (or two Condors to hook onto a
 * Goliath); "drop" — loaded Condors were sent to put their squads down (a
 * long-press on the map, or the Unload chip), or a lift to set its Goliath
 * down; "anchor" — Goliaths were told to dig in or pack up.
 */
export type TapFeedback = {
  kind: "move" | "attack" | "harvest" | "rally" | "place" | "board" | "drop" | "anchor";
  x: number;
  y: number;
  /** A route drawn ("route") or a patrol ("patrol"), not a tap: its own buzz. */
  route?: "route" | "patrol";
} | null;

/** The same point, as the codec gives it back (snapped to the centre of its 1/16-tile cell); both missing counts too. */
const samePoint = (a: { x?: number; y?: number }, b: { x?: number; y?: number }): boolean =>
  a.x === undefined || b.x === undefined ? a.x === b.x : Math.abs(a.x - b.x) <= 1 / 16 && Math.abs(a.y! - b.y!) <= 1 / 16;

/** The same order, its unit list aside (its faction too: the codec stamps the sender's side). */
function sameOrder(a: Command, b: Command): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "startBuilding":
      return b.type === a.type && a.building === b.building;
    case "placeBuilding":
      return b.type === a.type && a.tx === b.tx && a.ty === b.ty;
    case "produce":
    case "cancelProduce":
      return (b.type === "produce" || b.type === "cancelProduce") && a.buildingId === b.buildingId && a.unit === b.unit;
    case "move":
    case "attackMove":
    case "harvest":
    case "unload":
    case "waypoint":
    case "patrol":
      return samePoint(a, b as typeof a);
    case "attack":
      return b.type === a.type && a.targetId === b.targetId;
    case "march":
      return (
        b.type === a.type && a.attack === b.attack && samePoint({ x: a.x1, y: a.y1 }, { x: b.x1, y: b.y1 }) && samePoint({ x: a.x2, y: a.y2 }, { x: b.x2, y: b.y2 })
      );
    case "board":
      return b.type === a.type && a.carrierId === b.carrierId;
    case "lift":
      return b.type === a.type && a.goliathId === b.goliathId;
    case "sell":
      return b.type === a.type && a.buildingId === b.buildingId;
    case "rally":
      return b.type === a.type && a.buildingId === b.buildingId && samePoint(a, b);
    case "calldown":
      return b.type === a.type && a.power === b.power && samePoint(a, b);
    default:
      return true;
  }
}

/**
 * Bridges input/HUD and the sim: owns the player's selection, the command
 * queue drained each sim tick, and building-placement mode.
 */
export class Controller {
  selectedUnits = new Set<number>();
  selectedBuilding: number | null = null;
  /** When set, taps place this building instead of commanding. */
  placing: BuildingKind | null = null;
  /** Next ground tap issues a plain move (retreat) instead of attack-move. */
  forceMove = false;
  /** ▢ Cadre: the next one-finger drag on the map is a box select, no hold needed. */
  boxNext = false;
  /** Debug: render fog of war (display-only — the sim always keeps fog). */
  showFog = true;
  /** Spectator (AI vs AI): taps may inspect but never command. */
  spectator = false;
  paused = false;
  lastFeedback: TapFeedback = null;
  /** Where the placement ghost sits (top-left tile) while placing. */
  placeAt: { tx: number; ty: number } | null = null;
  /** A placement attempt that failed, for the ghost shake (the scene consumes it). */
  denied: { reason: string; tx: number; ty: number } | null = null;
  /** A short note about the last order ("Condor full"), for the HUD ticker (the scene consumes it). */
  tip: string | null = null;
  /** Three saved control groups (squad chips, keys 1–3). */
  readonly squads = new Squads(PLAYER);
  /**
   * Orders drained but not applied yet, oldest first, each with the tick it
   * was drained on, while an interactive feed (a sound duel) carries them:
   * they land D ticks after the tap, or later while the link holds them up.
   * Null where orders apply at the next tick (single player, replays). The
   * build bar counts them as applied (view()), and so do the Controller's own
   * reads (ahead()); the feed takes each off as the tick it lands in is
   * stepped (landed()), and those it knows can no longer land (settled()).
   */
  private flights: { c: Command; at: number }[] | null = null;
  /** No new orders (a sound duel's resign is on its way). */
  locked = false;
  private queue: Command[] = [];
  /** Bumped whenever the orders not applied yet change: ahead() is rebuilt on the next read. */
  private version = 0;
  private aheadAt = "";
  private aheadCache: OrdersAhead | null = null;

  constructor(public world: World) {}

  drainCommands(): Command[] {
    const cmds = this.queue;
    this.queue = [];
    if (this.flights) for (const c of cmds) this.flights.push({ c, at: this.world.tick });
    this.version++;
    return cmds;
  }

  enqueue(cmd: Command): void {
    if (this.spectator || this.locked) return;
    this.queue.push(cmd);
    this.version++;
  }

  /** Track orders in flight from now on (an interactive feed). */
  trackInFlight(): void {
    this.flights ??= [];
  }

  /** The orders on their way, oldest first (null without an interactive feed). */
  get inFlight(): Command[] | null {
    return this.flights?.map((f) => f.c) ?? null;
  }

  /**
   * This side's commands that a step just applied: their in-flight copies
   * come off, the oldest of each that matches, as the lockstep keeps their
   * order. The codec splits a long unit list into pieces the lockstep may
   * seal into turns of their own: each piece takes just its units off.
   */
  landed(applied: readonly Command[]): void {
    const fl = this.flights;
    if (!fl?.length) return;
    for (const c of applied) {
      if (!("unitIds" in c)) {
        const i = fl.findIndex((f) => sameOrder(f.c, c));
        if (i >= 0) fl.splice(i, 1);
        continue;
      }
      let left: readonly number[] = c.unitIds;
      for (let i = 0; i < fl.length && left.length > 0; i++) {
        const f = fl[i]!.c;
        if (!("unitIds" in f) || !sameOrder(f, c) || !f.unitIds.some((id) => left.includes(id))) continue;
        const rest = f.unitIds.filter((id) => !left.includes(id));
        left = left.filter((id) => !f.unitIds.includes(id));
        if (rest.length > 0) fl[i] = { c: { ...f, unitIds: rest }, at: fl[i]!.at };
        else fl.splice(i--, 1);
      }
    }
    this.version++;
  }

  /**
   * Everything drained on tick `through` or before has landed or never will
   * (the feed knows: the lockstep had none of it waiting, and its turn is
   * stepped): what is still in flight from then was replaced in the
   * lockstep's queue before it went out, and comes off.
   */
  settled(through: number): void {
    const fl = this.flights;
    if (!fl?.length || fl[0]!.at > through) return;
    this.flights = fl.filter((f) => f.at > through);
    this.version++;
  }

  /** No order on its way will land (the match ended without a result). */
  dropInFlight(): void {
    this.flights?.splice(0);
    this.version++;
  }

  /** The orders not applied yet: those in flight, then those not drained yet (a stall drains nothing). */
  private unapplied(): Command[] | null {
    return this.flights && [...this.flights.map((f) => f.c), ...this.queue];
  }

  /** The player's construction, scrap and queues as the build bar shows them (BuildView). */
  view(): BuildView {
    return buildView(this.world, PLAYER, this.unapplied());
  }

  /**
   * The player's units as this Controller reads them (OrdersAhead): with an
   * interactive feed, as the orders not applied yet leave them; else the
   * world's. Built once per tick and change of orders.
   */
  ahead(): OrdersAhead {
    if (!this.flights) return ordersAhead(this.world, null);
    const at = `${this.world.tick}/${this.version}`;
    if (at !== this.aheadAt || !this.aheadCache) {
      this.aheadCache = ordersAhead(this.world, this.unapplied());
      this.aheadAt = at;
    }
    return this.aheadCache;
  }

  /**
   * Drop selection entries for units that no longer exist. A squad that just
   * climbed into a Condor hands its place to the craft, so the selection
   * that loaded it can fly it and drop it next.
   */
  prune(): void {
    let gone: number[] | null = null;
    for (const id of this.selectedUnits) if (!this.world.units.has(id)) (gone ??= []).push(id);
    for (const id of gone ?? []) {
      this.selectedUnits.delete(id);
      const c = carrierOf(this.world, id);
      if (c) this.selectedUnits.add(c.id);
    }
    if (this.selectedBuilding !== null && !this.world.buildings.has(this.selectedBuilding))
      this.selectedBuilding = null;
    this.firePendingDrop();
    this.firePendingLifts();
    if (this.placing && this.world.factions[PLAYER].pending?.kind !== this.placing)
      this.placing = null;
    if (!this.placing) this.placeAt = null;
    this.squads.prune(this.world);
  }

  selectUnits(ids: number[]): void {
    this.selectedUnits = new Set(ids);
    this.selectedBuilding = null;
    this.forceMove = false;
  }

  clearSelection(): void {
    this.selectedUnits.clear();
    this.selectedBuilding = null;
    this.forceMove = false;
  }

  /** Shift+click: add a unit to the selection, or take it out if it's already in. */
  toggleUnit(id: number): void {
    this.selectedBuilding = null;
    if (this.selectedUnits.delete(id)) return; // taken out quietly
    // adding makes a fresh selection set, so the voices answer
    this.selectedUnits = new Set([...this.selectedUnits, id]);
  }

  /** The combat units ⚔ Select army grabs: every one the player owns but anchored Goliaths (they stay put). */
  armyIds(): number[] {
    const a = this.ahead();
    return [...this.world.units.values()].filter((u) => isArmyUnit(u) && !isRooted(a.unit(u))).map((u) => u.id);
  }

  /** Select every combat unit the player owns (anchored Goliaths aside). */
  selectArmy(): void {
    this.selectUnits(this.armyIds());
  }

  /** ⚔ Armée split by role (roles.ts): Infanterie, Blindés, Aviation. */
  roleIds(): Record<Role, number[]> {
    const w = this.world;
    return roleGroups(this.armyIds().map((id) => w.units.get(id)!));
  }

  /** Select the whole army of one role. Returns how many. */
  selectRole(role: Role): number {
    const ids = this.roleIds()[role];
    if (ids.length > 0) this.selectUnits(ids);
    return ids.length;
  }

  /**
   * Combat units with no orders (sitting at home, or done with their last
   * order). A Goliath dug in, digging in, packing up or on a lift is busy,
   * not idle.
   */
  idleArmy(): number[] {
    const a = this.ahead();
    return [...this.world.units.values()]
      .filter((u) => {
        const now = a.unit(u);
        return isArmyUnit(u) && now.order.type === "idle" && canWalk(now);
      })
      .map((u) => u.id);
  }

  /** Save the current unit selection as squad i. Returns how many were saved. */
  assignSquad(i: number): number {
    return this.squads.assign(i, this.selectedUnits, this.world);
  }

  /** Select squad i's living members. Returns how many. */
  selectSquad(i: number): number {
    const ids = this.squads.ids(i, this.world);
    if (ids.length > 0) this.selectUnits(ids);
    return ids.length;
  }

  // ----------------------------------------------------------- placement --
  // (explainPlacement: the sim's reason, said so the player knows what to do)

  /** Why the ghost can't be built where it sits, or null when it can. */
  placementProblem(): string | null {
    if (!this.placing || !this.placeAt) return null;
    return explainPlacement(placementBlocker(this.world, PLAYER, this.placing, this.placeAt.tx, this.placeAt.ty));
  }

  /** Move the ghost to (tx, ty), nudged onto a valid spot a tile away if that's all it takes. */
  movePlacement(tx: number, ty: number, snap = true): void {
    if (!this.placing) return;
    this.placeAt = snap ? snapPlacement(this.world, PLAYER, this.placing, tx, ty) : { tx, ty };
  }

  /** Build the ghost where it sits. On failure, records why in `denied`. */
  commitPlacement(): boolean {
    const kind = this.placing;
    const at = this.placeAt;
    if (!kind || !at || this.spectator) return false;
    const why = explainPlacement(placementBlocker(this.world, PLAYER, kind, at.tx, at.ty));
    if (why) {
      this.denied = { reason: why, tx: at.tx, ty: at.ty };
      return false;
    }
    const size = BUILDINGS[kind].size;
    this.enqueue({ type: "placeBuilding", faction: PLAYER, tx: at.tx, ty: at.ty });
    this.placing = null;
    this.placeAt = null;
    this.lastFeedback = { kind: "place", x: at.tx + size / 2, y: at.ty + size / 2 };
    return true;
  }

  /** Player tapped world position (wx, wy in tile units); `toggle` (Shift) adds or removes a tapped unit. */
  tapWorld(wx: number, wy: number, hit: TapHit, toggle = false): void {
    const w = this.world;
    this.lastFeedback = null;
    this.pendingDrop = null; // (a new order replaces a drop still waiting on boarders)
    if (this.spectator) {
      // inspection only: selecting shows rings/health, orders are forbidden
      if (hit.kind === "ownUnit" || hit.kind === "enemy") this.selectUnits(w.units.has(hit.id) ? [hit.id] : []);
      else this.clearSelection();
      return;
    }
    if (this.placing) {
      // one-click placement (mouse): the ghost goes where you click and builds if it can
      const size = BUILDINGS[this.placing].size;
      this.placeAt = { tx: Math.round(wx - size / 2), ty: Math.round(wy - size / 2) };
      this.commitPlacement();
      return;
    }

    if (hit.kind === "ownUnit") {
      if (toggle) this.toggleUnit(hit.id);
      else if (!this.boardTap(hit.id)) this.selectUnits([hit.id]);
      return;
    }
    // (a building being sold is gone: a tap there is a tap on the ground)
    if (hit.kind === "ownBuilding" && this.ahead().sold(hit.id)) hit = { kind: "ground" };
    if (hit.kind === "ownBuilding") {
      // with units selected, tapping our own building just moves them there
      if (this.selectedUnits.size === 0) {
        this.selectedUnits.clear();
        this.selectedBuilding = hit.id;
        return;
      }
    }
    if (hit.kind === "enemy" && this.selectedUnits.size > 0) {
      const lifting = this.liftMembers();
      const a = this.ahead();
      // only those that can get in range of it (not a tank at an enemy on an island; not a Goliath on a lift)
      const attackers = this.selectedAttackers(hit.targetsAir).filter((id) => {
        const u = w.units.get(id);
        return !!u && !lifting.has(id) && (isRooted(a.unit(u)) ? inReachFromHere(w, u, hit.id) : engageable(w, u, hit.id));
      });
      if (attackers.length > 0) {
        this.enqueue({ type: "attack", faction: PLAYER, unitIds: attackers, targetId: hit.id });
        // loaded Condors in the group drop their troops onto an island enemy's island
        const drop = this.onIsland(Math.floor(wx), Math.floor(wy)) ? this.loadedSelected().map((u) => u.id) : [];
        if (drop.length > 0) this.enqueue({ type: "unload", faction: PLAYER, unitIds: drop, x: wx, y: wy });
        // a lift in the group flies along; an anchored Goliath that can't reach it stays dug in
        this.orderLifts(wx, wy, false);
        const others = [...this.selectedUnits].filter(
          (id) => !attackers.includes(id) && !drop.includes(id) && !lifting.has(id) && !this.rooted(id)
        );
        if (others.length > 0)
          this.enqueue({ type: "move", faction: PLAYER, unitIds: others, x: wx, y: wy });
        this.lastFeedback = { kind: drop.length > 0 ? "drop" : "attack", x: wx, y: wy };
        return;
      }
      // only anchored Goliaths, and it's beyond their guns: they stay dug in (no rally point at the enemy)
      if ([...this.selectedUnits].every((id) => this.rooted(id))) {
        this.rootTip(tr("Hors de portée : lève l'ancre d'abord (G) pour le poursuivre", "Out of reach: weigh anchor first (G) to pursue"));
        return;
      }
      // none can: treat it as a tap on the ground there (an island drop, or a tip)
    }
    if (hit.kind === "enemy" && this.selectedUnits.size === 0) return;

    // ground tap
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    // an island only a Condor reaches: a tap on it with loaded Condors selected drops their troops
    // there (no hidden long-press for the island map's main move); anything else gets told why not
    if (this.selectedUnits.size > 0 && this.onIsland(tx, ty)) {
      if (this.dropAt(wx, wy)) return;
      // squads still walking to a Condor: keep them boarding, and drop them there once aboard
      const boarding = this.selectedOwn().filter((u) => u.order.type === "board");
      if (boarding.length > 0) {
        const carriers = new Set<number>();
        for (const u of boarding) if (u.order.type === "board") carriers.add(u.order.carrierId);
        this.pendingDrop = { carriers: [...carriers], x: wx, y: wy };
        this.tip = tr("Embarquement : largage là-bas une fois à bord", "Boarding: drop there once aboard");
        this.lastFeedback = { kind: "drop", x: wx, y: wy };
        return;
      }
      if (!this.someoneReaches(tx, ty)) this.islandTip();
    }
    if (this.selectedUnits.size > 0) {
      // a lift flies there and hovers (one still hooking on goes once it is up)
      const lifting = this.orderLifts(wx, wy, false);
      const all = [...this.selectedUnits].filter((id) => w.units.has(id) && !lifting.has(id));
      // anchored Goliaths stay dug in (a move would pack them up): on their own they
      // take a rally point for the squads they train, in a group the rest go without them
      const rooted = all.filter((id) => this.rooted(id));
      const ids = all.filter((id) => !rooted.includes(id));
      if (rooted.length > 0 && ids.length === 0 && lifting.size === 0) {
        for (const id of rooted) this.enqueue({ type: "rally", faction: PLAYER, buildingId: id, x: wx, y: wy });
        this.lastFeedback = { kind: "rally", x: wx, y: wy };
        this.forceMove = false;
        this.rootTip(tr("Point de ralliement fixé : lève l'ancre d'abord (G) pour déplacer le Gargantua", "Rally point set: weigh anchor first (G) to move the Gargantua"));
        return;
      }
      if (rooted.length > 0) this.rootTip(tr(`${rooted.length > 1 ? "Les Gargantuas ancrés restent" : "Le Gargantua ancré reste"} en place : lève l'ancre d'abord (G)`, `${rooted.length > 1 ? "Anchored Gargantuas stay" : "The anchored Gargantua stays"} put: weigh anchor first (G)`));
      const harvesters = ids.filter((id) => behaves(w.units.get(id)!.kind, "harvester"));
      const rest = ids.filter((id) => !behaves(w.units.get(id)!.kind, "harvester"));
      const onResource =
        tx >= 0 && ty >= 0 && tx < w.width && ty < w.height && isResource(w, tileIndex(w, tx, ty));
      const type = this.forceMove ? "move" : "attackMove";
      if (onResource && harvesters.length > 0) {
        this.enqueue({ type: "harvest", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0) this.enqueue({ type, faction: PLAYER, unitIds: rest, x: wx, y: wy });
        this.lastFeedback = { kind: "harvest", x: wx, y: wy };
      } else {
        // harvesters always just drive (they have no guns to stop for)
        if (harvesters.length > 0) this.enqueue({ type: "move", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0) this.enqueue({ type, faction: PLAYER, unitIds: rest, x: wx, y: wy });
        this.lastFeedback = { kind: "move", x: wx, y: wy };
      }
      this.forceMove = false;
      return;
    }
    if (this.selectedBuilding !== null) {
      const b = w.buildings.get(this.selectedBuilding);
      if (b && isProducer(b.kind)) {
        this.enqueue({ type: "rally", faction: PLAYER, buildingId: this.selectedBuilding, x: wx, y: wy });
        this.lastFeedback = { kind: "rally", x: wx, y: wy };
      } else this.clearSelection();
    }
  }

  /**
   * A route drawn from the selection (GameScene, route-draw.ts planRoute):
   * the units take its points in turn, attack-moving (plain moves with
   * ⚑ Repli; harvesters always just drive), and with `loop` go round it for
   * ever, fighting what they meet (a patrol). A lift flies straight to the
   * last point; anchored Goliaths stay dug in. False when nothing could go.
   */
  routeSelected(points: readonly Pt[], loop: boolean): boolean {
    const w = this.world;
    if (this.spectator || this.placing || points.length === 0 || this.selectedUnits.size === 0) return false;
    this.pendingDrop = null;
    const end = points[points.length - 1]!;
    const lifting = this.orderLifts(end.x, end.y, false);
    const ids = [...this.selectedUnits].filter((id) => w.units.has(id) && !lifting.has(id) && !this.rooted(id));
    if (ids.length === 0 && lifting.size === 0) {
      this.rootTip(tr("Le Gargantua ancré reste en place : lève l'ancre d'abord (G)", "The anchored Gargantua stays put: weigh anchor first (G)"));
      return false;
    }
    const harvesters = ids.filter((id) => behaves(w.units.get(id)!.kind, "harvester"));
    const rest = ids.filter((id) => !harvesters.includes(id));
    const send = (unitIds: number[], first: "move" | "attackMove", patrol: boolean) => {
      if (unitIds.length === 0) return;
      const [p0, ...more] = points as [Pt, ...Pt[]];
      this.enqueue({ type: first, faction: PLAYER, unitIds, x: p0.x, y: p0.y });
      more.forEach((p, i) =>
        this.enqueue({ type: patrol && i === more.length - 1 ? "patrol" : "waypoint", faction: PLAYER, unitIds, x: p.x, y: p.y })
      );
    };
    send(rest, this.forceMove && !loop ? "move" : "attackMove", loop);
    send(harvesters, "move", false); // (no guns: they never patrol)
    this.forceMove = false;
    this.lastFeedback = { kind: "move", x: end.x, y: end.y, route: loop ? "patrol" : "route" };
    return true;
  }

  /**
   * A front drawn on the map (GameScene's long press and drag): the
   * selection marches there in order (sim/march.ts), attack-moving (plain
   * moves with ⚑ Repli). A lift flies to the front's middle; anchored
   * Goliaths stay dug in. False when nothing could go.
   */
  marchSelected(a: Pt, b: Pt): boolean {
    const w = this.world;
    if (this.spectator || this.placing || this.selectedUnits.size === 0) return false;
    this.pendingDrop = null;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const lifting = this.orderLifts(mid.x, mid.y, false);
    const ids = [...this.selectedUnits].filter((id) => w.units.has(id) && !lifting.has(id) && !this.rooted(id));
    if (ids.length === 0 && lifting.size === 0) {
      this.rootTip(tr("Le Gargantua ancré reste en place : lève l'ancre d'abord (G)", "The anchored Gargantua stays put: weigh anchor first (G)"));
      return false;
    }
    if (ids.length > 0) this.enqueue({ type: "march", faction: PLAYER, unitIds: ids, x1: a.x, y1: a.y, x2: b.x, y2: b.y, attack: !this.forceMove });
    this.forceMove = false;
    this.lastFeedback = { kind: "move", x: mid.x, y: mid.y, route: "route" };
    return true;
  }

  /** ■ Stop: the selection halts (a lift hovers; one still hooking on is called off). */
  stopSelected(): void {
    if (this.selectedUnits.size === 0) return;
    for (const g of this.liftsSelected()) this.pendingLifts.delete(g.id);
    this.enqueue({ type: "stop", faction: PLAYER, unitIds: [...this.selectedUnits] });
  }

  /** Is unit `id` an anchored Goliath (or one digging in)? */
  private rooted(id: number): boolean {
    const u = this.world.units.get(id);
    return !!u && isRooted(this.ahead().unit(u));
  }

  private rootTipped = -1e9;

  /** Tell the player an anchored Goliath didn't move (now and then: it's the same lesson every time). */
  private rootTip(msg: string): void {
    const now = this.world.tick;
    if (now - this.rootTipped < 20 * TICK_RATE) return;
    this.rootTipped = now;
    this.tip = msg;
  }

  // ------------------------------------------------------------- Goliaths --

  /** The player's selected Goliaths standing on the ground (not hooked onto Condors or carried), as ahead() has them. */
  goliathsSelected(): Unit[] {
    return this.selectedOwn().filter((u) => !!u.goliath && !u.goliath.lift);
  }

  /**
   * The ⚓ chip and the G key: the selected walking Goliaths dig in where they
   * stand (those the ground takes); with none walking, the anchored ones (and
   * any still digging in) pack up. When no walking one can anchor there,
   * `tip` says why (sim/goliath.ts anchorBlocker). Returns what it ordered.
   */
  toggleAnchor(): "anchor" | "packUp" | null {
    if (this.spectator) return null;
    const gs = this.goliathsSelected();
    const walking = gs.filter((g) => g.goliath!.mode === "walking");
    let ids: number[];
    let what: "anchor" | "packUp";
    if (walking.length > 0) {
      const ok = walking.filter((g) => !anchorBlocker(this.world, g));
      if (ok.length === 0) {
        this.tip = tr(`Impossible d'ancrer ici : ${anchorBlocker(this.world, walking[0]!)!.toLowerCase()}`, `Can't anchor here: ${anchorBlocker(this.world, walking[0]!)!.toLowerCase()}`);
        return null;
      }
      ids = ok.map((g) => g.id);
      what = "anchor";
    } else {
      ids = gs.filter(isRooted).map((g) => g.id);
      if (ids.length === 0) return null;
      what = "packUp";
    }
    this.enqueue({ type: what, faction: PLAYER, unitIds: ids });
    const at = this.world.units.get(ids[0]!)!;
    this.lastFeedback = { kind: "anchor", x: at.x, y: at.y };
    return what;
  }

  // -------------------------------------------------------------- islands --

  private tipped = -1e9;

  /** Is tile (tx, ty) island ground, cut off from our base by the sea (an island map only)? */
  onIsland(tx: number, ty: number): boolean {
    const w = this.world;
    return !!w.rules?.islands && regionAt(w, tx, ty, "foot") > 0 && !onHomeLand(w, PLAYER, tx, ty);
  }

  /** A tap on an island while squads were boarding: those Condors drop there once loaded (see prune). */
  private pendingDrop: { carriers: number[]; x: number; y: number } | null = null;

  /** Can any selected unit get to tile (tx, ty) itself (aircraft, or ground in its own region)? */
  private someoneReaches(tx: number, ty: number): boolean {
    const w = this.world;
    return this.selectedOwn().some((u) => {
      const mc = moveClassOf(u.kind);
      if (mc === "air") return !isTransport(u.kind); // (an empty Condor gets there, but takes nothing)
      const r = regionAt(w, Math.floor(u.x), Math.floor(u.y), mc);
      return r > 0 && r === regionAt(w, tx, ty, mc);
    });
  }

  /** Squads promised to a drop are aboard now: fly those Condors to it. */
  private firePendingDrop(): void {
    const p = this.pendingDrop;
    if (!p) return;
    const w = this.world;
    const a = this.ahead();
    const ready: number[] = [];
    p.carriers = p.carriers.filter((id) => {
      const c = w.units.get(id);
      if (!c) return false;
      // (squads still walking to it, or told to and the order still on its way)
      const walking = [...w.units.values()].some((u) => {
        const o = a.unit(u).order;
        return o.type === "board" && o.carrierId === id;
      });
      if (walking) return true;
      if (isLoaded(c)) ready.push(id);
      return false;
    });
    if (ready.length > 0) {
      this.enqueue({ type: "unload", faction: PLAYER, unitIds: ready, x: p.x, y: p.y });
      this.lastFeedback = { kind: "drop", x: p.x, y: p.y };
    }
    if (p.carriers.length === 0) this.pendingDrop = null;
  }

  /** Sent at an island without a loaded Condor: say how islands are reached (now and then). */
  private islandTip(): void {
    const now = this.world.tick;
    if (now - this.tipped < 80) return;
    this.tipped = now;
    const hasCondor = this.selectedOwn().some((u) => isTransport(u.kind));
    const hasSquads = this.selectedOwn().some((u) => isInfantry(u.kind));
    const hasGoliath = this.selectedOwn().some((u) => !!u.goliath);
    this.tip = hasCondor
      ? tr("Cette Montgolfière est vide : fais-y d'abord monter tes escouades", "This Montgolfier Balloon is empty: board your squads first")
      : hasSquads
        ? tr("Les escouades ne nagent pas : touche une Montgolfière pour embarquer, puis l'île", "Squads can't swim: tap a Montgolfier Balloon to board, then the island")
        : hasGoliath
          ? tr("Pas de passage : deux Montgolfières vides peuvent y porter un Gargantua", "No way across: two empty Montgolfier Balloons can carry a Gargantua there")
          : tr("Pas de passage : seules les troupes aéroportées en Montgolfière prennent les îles", "No way across: only airborne troops in a Montgolfier Balloon take the islands");
  }

  // ------------------------------------------------------------ transport --

  /** Selected Condors with squads aboard. */
  loadedSelected(): Unit[] {
    return this.selectedOwn().filter((u) => isLoaded(u));
  }

  /** Squads aboard the selected Condors (the Unload chip's count). */
  aboardSelected(): number {
    let n = 0;
    for (const c of this.loadedSelected()) n += c.passengers!.length;
    return n;
  }

  /**
   * Unload chip / U key: the selected Condors put their squads down where
   * they are, and selected lifts set their Goliaths down where they hover.
   */
  unloadSelected(): boolean {
    if (this.spectator) return false;
    const cs = this.loadedSelected();
    const up = this.liftsSelected().filter((g) => g.goliath!.lift!.phase === "carrying");
    if (cs.length === 0 && up.length === 0) return false;
    for (const g of up) this.pendingLifts.delete(g.id);
    this.enqueue({ type: "unload", faction: PLAYER, unitIds: [...cs, ...up].map((u) => u.id) });
    const at = cs[0] ?? up[0]!;
    this.lastFeedback = { kind: "drop", x: at.x, y: at.y };
    return true;
  }

  /**
   * Long-press on the map: the selected loaded Condors fly to (wx, wy) and
   * drop their squads (the sim snaps the drop to the nearest ground a squad
   * can stand on), and selected lifts fly there and set their Goliaths down
   * (on the nearest ground one can stand on); the rest of the selection heads
   * there too, anchored Goliaths aside. False (nothing done) when no loaded
   * Condor or lift is selected.
   */
  dropAt(wx: number, wy: number): boolean {
    if (this.spectator || this.placing) return false;
    const cs = this.loadedSelected();
    if (cs.length === 0 && this.liftsSelected().length === 0) return false;
    const ids = cs.map((c) => c.id);
    if (ids.length > 0) this.enqueue({ type: "unload", faction: PLAYER, unitIds: ids, x: wx, y: wy });
    const lifting = this.orderLifts(wx, wy, true);
    const rest = this.selectedOwn().filter((u) => !ids.includes(u.id) && !lifting.has(u.id) && !isRooted(u)).map((u) => u.id);
    if (rest.length > 0) this.enqueue({ type: this.forceMove ? "move" : "attackMove", faction: PLAYER, unitIds: rest, x: wx, y: wy });
    this.forceMove = false;
    this.lastFeedback = { kind: "drop", x: wx, y: wy };
    return true;
  }

  // ----------------------------------------------------------------- lift --

  /** Orders for lifts still hooking on, by Goliath id: sent once they are up (see prune). */
  private pendingLifts = new Map<number, { x: number; y: number; setDown: boolean }>();

  /**
   * The lifts (by their Goliaths, as ahead() has them) the selection takes
   * part in: a Goliath on one, or a Condor of its pair. A lift still on its
   * way is one hooking on.
   */
  liftsSelected(): Unit[] {
    const a = this.ahead();
    const out: Unit[] = [];
    for (const u of this.selectedOwn()) {
      const g = a.liftOf(u);
      if (g && g.faction === PLAYER && !out.some((o) => o.id === g.id)) out.push(g);
    }
    return out;
  }

  /** Every unit of the selected lifts (the Goliaths and both Condors of each pair). */
  liftMembers(): Set<number> {
    const ids = new Set<number>();
    for (const g of this.liftsSelected()) {
      ids.add(g.id);
      for (const c of g.goliath!.lift!.carriers) ids.add(c);
    }
    return ids;
  }

  /**
   * Fly the selected lifts to (x, y), setting their Goliaths down there when
   * `setDown`. An order goes to the carried Goliath (sim/lift.ts routes it to
   * the pair): one still hooking on keeps it until it is up, since an order
   * to its Condors would call the lift off. Returns every lift member, for
   * the caller to leave out of its own orders.
   */
  private orderLifts(x: number, y: number, setDown: boolean): Set<number> {
    const members = this.liftMembers();
    const up: number[] = [];
    for (const g of this.liftsSelected()) {
      if (g.goliath!.lift!.phase === "carrying") {
        up.push(g.id);
        this.pendingLifts.delete(g.id);
      } else this.pendingLifts.set(g.id, { x, y, setDown });
    }
    if (up.length > 0) this.enqueue({ type: setDown ? "unload" : "move", faction: PLAYER, unitIds: up, x, y });
    return members;
  }

  /** Lifts that were given an order while hooking on (or while the lift was on its way) and are up now: send it. */
  private firePendingLifts(): void {
    if (this.pendingLifts.size === 0) return;
    const a = this.ahead();
    for (const [id, p] of this.pendingLifts) {
      const g = this.world.units.get(id);
      const lift = g && a.unit(g).goliath?.lift;
      if (lift?.phase === "hooking") continue;
      this.pendingLifts.delete(id);
      if (!lift) continue; // (called off, or it fell)
      this.enqueue({ type: p.setDown ? "unload" : "move", faction: PLAYER, unitIds: [id], x: p.x, y: p.y });
    }
  }

  /**
   * Condors selected and a tap on our own Goliath: two empty Condors hook
   * onto a walking one (the two nearest; the sim lifts it once both are on),
   * and the selection becomes the lift, so a long-press next flies it there
   * and sets it down. Otherwise `tip` says why not (sim/lift.ts liftBlocker)
   * and the tap selects the Goliath (false).
   */
  private liftTap(g: Unit, condors: Unit[]): boolean {
    const why = liftBlocker(condors, g);
    if (why) {
      const free = condors.filter(canCarry).length;
      const loaded = condors.filter((c) => isLoaded(c)).length;
      if (why === LIFT_NEEDS_TWO) {
        if (free + loaded >= 2) this.tip = tr("Décharge d'abord les Montgolfières", "Unload the Montgolfier Balloons first");
        else if (!g.goliath?.lift) this.tip = tr("Deux Montgolfières vides portent un Gargantua", "Two empty Montgolfier Balloons carry a Gargantua");
      } else this.tip = why === LIFT_PACK_FIRST ? tr("Lève l'ancre d'abord (G)", "Weigh anchor first (G)") : why;
      return false;
    }
    const pair = condors
      .filter(canCarry)
      .sort((a, b) => dist(a, g) - dist(b, g) || a.id - b.id)
      .slice(0, 2);
    this.enqueue({ type: "lift", faction: PLAYER, unitIds: pair.map((c) => c.id), goliathId: g.id });
    this.selectUnits([...pair.map((c) => c.id), g.id]);
    this.lastFeedback = { kind: "board", x: g.x, y: g.y };
    return true;
  }

  /**
   * A tap on one of our own units that loads a Condor instead of selecting:
   * with squads selected, tapping a Condor sends them aboard it (as many as
   * it has seats, nearest first); with Condors (and no squads) selected,
   * tapping a squad sends it aboard the nearest selected Condor with a seat,
   * and tapping a Goliath has two empty ones lift it (liftTap). A Condor
   * that is flying somewhere stops to come and meet them. Returns false when
   * the tap is an ordinary selection. (A right-click on our own unit loads
   * the same way.)
   */
  boardTap(id: number): boolean {
    if (this.spectator || this.placing) return false;
    const w = this.world;
    const unit = w.units.get(id);
    if (!unit || unit.faction !== PLAYER) return false;
    const tapped = this.ahead().unit(unit);
    const sel = this.selectedOwn();
    const squads = sel.filter((u) => isInfantry(u.kind));
    // a loaded Condor over our own island garrison: the tap reinforces it, it doesn't pick the garrison up
    if (isInfantry(tapped.kind) && squads.length === 0 && this.onIsland(Math.floor(tapped.x), Math.floor(tapped.y)) && this.dropAt(tapped.x, tapped.y))
      return true;
    let carrier: Unit | null = null;
    let riders: Unit[] = [];
    if (isTransport(tapped.kind) && squads.length > 0) {
      const seats = this.openSeats(tapped, squads);
      if (seats <= 0) {
        this.tip = tr(`${UNITS[tapped.kind].name} plein : décharge-le d'abord`, `${UNITS[tapped.kind].name} full: unload it first`);
        return false; // (selects it, Unload chip and all)
      }
      riders = [...squads].sort((a, b) => dist(a, tapped) - dist(b, tapped) || a.id - b.id).slice(0, seats);
      if (riders.length < squads.length) this.tip = tr(`Place pour ${seats} escouade${seats === 1 ? "" : "s"} seulement`, `Room for ${seats} squad${seats === 1 ? "" : "s"} only`);
      carrier = tapped;
    } else if (isInfantry(tapped.kind) && squads.length === 0) {
      const condors = sel.filter((u) => isTransport(u.kind));
      if (condors.length === 0) return false;
      const open = condors.filter((c) => this.openSeats(c, [tapped]) > 0);
      if (open.length === 0) {
        this.tip = condors.length > 1 ? tr("Ces Montgolfières sont pleines", "These Montgolfier Balloons are full") : tr(`${UNITS[condors[0]!.kind].name} pleine : décharge-la d'abord`, `${UNITS[condors[0]!.kind].name} full: unload it first`);
        return false;
      }
      carrier = open.sort((a, b) => dist(a, tapped) - dist(b, tapped) || a.id - b.id)[0]!;
      riders = [tapped];
    } else if (tapped.goliath) {
      const condors = sel.filter((u) => isTransport(u.kind));
      return condors.length > 0 && this.liftTap(tapped, condors);
    } else return false;
    this.enqueue({ type: "board", faction: PLAYER, unitIds: riders.map((u) => u.id), carrierId: carrier.id });
    // a Condor on its way somewhere waits for them instead (idle, it flies over to meet them)
    if (carrier.order.type === "move" || carrier.order.type === "attackMove")
      this.enqueue({ type: "stop", faction: PLAYER, unitIds: [carrier.id] });
    this.forceMove = false;
    this.lastFeedback = { kind: "board", x: carrier.x, y: carrier.y };
    return true;
  }

  /** Seats on Condor `c` (as ahead() has it) not already promised to squads walking to it, or told to (other than `riders`). */
  private openSeats(c: Unit, riders: readonly Unit[]): number {
    const a = this.ahead();
    let promised = 0;
    for (const u of this.world.units.values()) {
      const o = a.unit(u).order;
      if (o.type === "board" && o.carrierId === c.id && !riders.some((r) => r.id === u.id)) promised++;
    }
    return freeSeats(c) - promised;
  }

  /** The player's own selected units on the field, as ahead() has them (the orders on their way applied). */
  private selectedOwn(): Unit[] {
    const a = this.ahead();
    const out: Unit[] = [];
    for (const id of this.selectedUnits) {
      const u = this.world.units.get(id);
      if (u && u.faction === PLAYER) out.push(a.unit(u));
    }
    return out;
  }

  sellSelected(): void {
    if (this.selectedBuilding !== null)
      this.enqueue({ type: "sell", faction: PLAYER, buildingId: this.selectedBuilding });
    this.selectedBuilding = null;
  }

  // -------------------------------------------------------------- powers --

  /** The player's Command meter, less the calldowns on their way (ahead()). */
  powerMeter(): number {
    let m = this.world.powers.meter[PLAYER];
    for (const p of this.ahead().fired) m -= powerCost(p);
    return m;
  }

  /**
   * Power `p` as the power panel shows it (sim/powers.ts powerStatus), the
   * calldowns on their way counted as fired: the meter paid, and a power
   * fired cooling down from the start (its cooldown starts as it lands).
   */
  powerStatus(p: PowerKind): PowerStatus {
    const st = powerStatus(this.world, PLAYER, p);
    const fired = this.ahead().fired;
    if (fired.length === 0) return st;
    const cooldown = st.locked > 0 ? 0 : fired.includes(p) ? st.cooldownTotal : st.cooldown;
    const charge = st.cost === 0 ? 1 : Math.min(1, Math.max(0, this.powerMeter()) / st.cost);
    return { ...st, cooldown, charge, ready: st.ready && cooldown === 0 && charge >= 1 };
  }

  /** Why power `p` can't be fired now (sim/powers.ts powerBlocker, with powerStatus's calldowns on their way), or null. */
  powerBlocker(p: PowerKind): string | null {
    const why = powerBlocker(this.world, PLAYER, p);
    if (why || this.ahead().fired.length === 0) return why;
    const st = this.powerStatus(p);
    if (st.cooldown > 0) return tr(`${POWER_NAMES[p]} en recharge : ${Math.ceil(st.cooldown / TICK_RATE)} s`, `${POWER_NAMES[p]} recharging: ${Math.ceil(st.cooldown / TICK_RATE)} s`);
    if (st.charge < 1) return tr(`${POWER_NAMES[p]} : ${st.cost} de charge requis (${Math.floor(this.powerMeter())})`, `${POWER_NAMES[p]}: ${st.cost} charge needed (${Math.floor(this.powerMeter())})`);
    return null;
  }

  /** Selected units able to shoot at the given domain (air or ground). */
  private selectedAttackers(air: boolean): number[] {
    const out: number[] = [];
    for (const id of this.selectedUnits) {
      const u = this.world.units.get(id);
      if (!u) continue;
      const t = UNITS[u.kind].targets;
      if (t === "both" || t === (air ? "air" : "ground")) out.push(id);
    }
    return out;
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export type TapHit =
  | { kind: "ownUnit"; id: number }
  | { kind: "ownBuilding"; id: number }
  | { kind: "enemy"; id: number; targetsAir: boolean }
  | { kind: "ground" };

/**
 * Hit-test a world point against entities with a forgiving radius.
 * `canSee` filters out enemies hidden in the fog.
 */
export function hitTest(
  w: World,
  wx: number,
  wy: number,
  radiusTiles: number,
  canSee: (id: number) => boolean = () => true
): TapHit {
  let best: TapHit = { kind: "ground" };
  let bestD = radiusTiles;
  for (const u of w.units.values()) {
    // aircraft are drawn lifted: test against where they appear
    const lift = UNITS[u.kind].domain === "air" ? 0.35 : 0;
    const d = Math.hypot(u.x - wx, u.y - lift - wy);
    if (d < bestD) {
      if (u.faction !== PLAYER && !canSee(u.id)) continue;
      bestD = d;
      best =
        u.faction === PLAYER
          ? { kind: "ownUnit", id: u.id }
          : { kind: "enemy", id: u.id, targetsAir: domainOf(u) === "air" };
    }
  }
  if (best.kind !== "ground") return best;
  const b = buildingAtTile(w, Math.floor(wx), Math.floor(wy));
  if (b) {
    if (b.faction === PLAYER) return { kind: "ownBuilding", id: b.id };
    if (canSee(b.id)) return { kind: "enemy", id: b.id, targetsAir: false };
  }
  return best;
}

/** The sim's placement refusal in the player's words: off the République's network, where the power comes from. */
export function explainPlacement(why: string | null): string | null {
  if (why === tr("Hors du réseau électrique", "Outside the power grid")) return tr("Hors du réseau : près du GQG ou d'une Tour TSF", "Outside the grid: near the GHQ or a Wireless Tower");
  return why;
}
