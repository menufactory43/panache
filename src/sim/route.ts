import { hypot } from "./fmath";
import { orderedToMove } from "./goliath";
import { behaves } from "./nations";
import type { Command, Unit, World } from "./types";

/**
 * Routes and patrols: waypoints queued behind a unit's move or attack-move
 * (Unit.route). A route drawn on the map with a finger arrives as a move or
 * attackMove to its first point, then one `waypoint` command per further
 * point; a `patrol` closes the loop, and the unit goes round it for ever,
 * attack-moving: it fights whatever it meets (combat.ts, as on any
 * attack-move) and walks on once that is dead.
 *
 * Any other order a unit is given drops its route (sim.ts applyCommand), so
 * a tap on the map after a route is a plain new order. Old records never
 * send these commands, so no unit of theirs ever has a route, and their
 * world hashes stay what they were (checksum.ts folds routes in only when
 * one exists).
 */

/**
 * Closer than this (tiles) to a point with more of the route to come, a unit
 * takes the next leg: a group sweeps through a corner instead of crowding
 * onto it (only the last point of a route is reached as a move's goal is).
 */
export const ROUTE_PASS = 2;
/** Points one route holds at most: a waypoint past that is ignored. */
export const ROUTE_MAX = 12;

type RouteCommand = Extract<Command, { type: "waypoint" | "patrol" }>;

const moving = (u: Unit): boolean => u.order.type === "move" || u.order.type === "attackMove";
const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => hypot(a.x - b.x, a.y - b.y) <= ROUTE_PASS;

/** Set off for (x, y) now, as a move or attackMove command would (sim.ts applyCommand). */
function setOff(w: World, u: Unit, x: number, y: number, move: boolean): void {
  u.order = { type: move ? "move" : "attackMove", x, y };
  u.path = null;
  u.autoTargetId = null;
  orderedToMove(w, u); // an anchored Goliath packs up first
}

/**
 * A `waypoint` or `patrol` command, for each of `c.unitIds` that is the
 * commanding side's and not on a lift (`lifting`, lift.ts routeLiftCommand).
 * A point within ROUTE_PASS of the one before it adds nothing: it is
 * skipped (a patrol still closes its loop).
 */
export function applyRouteCommand(w: World, c: RouteCommand, lifting: ReadonlySet<number>): void {
  const patrol = c.type === "patrol";
  const p = { x: c.x, y: c.y };
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (!u || u.faction !== c.faction || lifting.has(id)) continue;
    // (harvesters have no guns: they always just drive, and never patrol)
    const unarmed = behaves(u.kind, "harvester");
    if (!moving(u)) {
      // nothing under way: set off now; a patrol goes back and forth between here and there
      const here = { x: u.x, y: u.y };
      setOff(w, u, p.x, p.y, unarmed);
      if (u.route) delete u.route;
      if (patrol && !unarmed && !near(here, p)) u.route = { pts: [here], move: false, loop: true };
      continue;
    }
    const o = u.order as Extract<Unit["order"], { type: "move" | "attackMove" }>;
    const r = (u.route ??= { pts: [], move: o.type === "move", loop: false });
    const last = r.pts[r.pts.length - 1] ?? o;
    if (!near(last, p) && r.pts.length < ROUTE_MAX) r.pts.push(p);
    if (patrol && !unarmed) {
      r.loop = true;
      r.move = false; // a patrol fights what it meets
      if (o.type === "move") u.order = { type: "attackMove", x: o.x, y: o.y };
    }
    if (r.pts.length === 0) delete u.route;
  }
}

/**
 * Unit `u` reached (or swept past) the goal of its move or attack-move: on
 * to the next point of its route. A patrol puts the point just reached back
 * on the end. False when there is no route left (the caller sends it idle).
 */
export function nextLeg(u: Unit): boolean {
  const r = u.route;
  if (!r || !moving(u)) return false;
  const o = u.order as Extract<Unit["order"], { type: "move" | "attackMove" }>;
  const next = r.pts.shift();
  if (!next) {
    delete u.route;
    return false;
  }
  if (r.loop) r.pts.push({ x: o.x, y: o.y });
  u.order = { type: r.move ? "move" : "attackMove", x: next.x, y: next.y };
  u.path = null;
  if (r.pts.length === 0) delete u.route;
  return true;
}

/** Should unit `u` take its next leg already: close enough to a corner of its route? */
export function sweepsPast(u: Unit): boolean {
  const o = u.order;
  return !!u.route && (o.type === "move" || o.type === "attackMove") && near(u, o);
}

/** Every route of the units named by a command other than a waypoint or patrol goes: that order replaces it. */
export function dropRoutes(w: World, c: Command): void {
  if (!("unitIds" in c) || c.type === "waypoint" || c.type === "patrol") return;
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (u?.route && u.faction === c.faction) delete u.route;
  }
}
