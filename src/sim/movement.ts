import { BUILDINGS, TERRAIN, TICK_RATE, UNITS } from "./balance";
import { canWalk, goliathReachAt, isLifted } from "./goliath";
import { crushes, isInfantry, tickCrush } from "./infantry";
import { speedMult } from "./nations";
import { Terrain, type Faction, type Unit, type World } from "./types";
import { domainOf, inBounds, moveClassOf, passable, regionAt, regionLabels, terrainMult, terrainSpeed, type LandClass, type MoveClass } from "./world";
import { atan2, cos, hypot, sin } from "./fmath";

const ARRIVE_DIST = 0.25;
/** How long (ticks) a unit leaves alone a target it found it can't get in range of. */
export const IGNORE_TICKS = 30;
/** Consume en-route waypoints loosely — tight radii livelock grouped units. */
const WAYPOINT_DIST = 0.7;
/** Fastest terrain speed multiplier (roads) — keeps the A* heuristic admissible. */
const MAX_TERRAIN_SPEED = Math.max(...Object.values(TERRAIN).map((t) => Math.max(t.speed, t.hoverSpeed, t.footSpeed)));

/**
 * Arrival radius at a final destination, growing with the crowd already
 * parked there: N units can't all touch the same point (separation keeps
 * them ~0.7 apart), so each neighbour near the goal widens "arrived".
 */
function arrivalRadius(w: World, u: Unit, gx: number, gy: number): number {
  let crowd = 0;
  for (const o of w.units.values()) {
    if (o.id === u.id || UNITS[o.kind].domain !== UNITS[u.kind].domain) continue;
    if (hypot(o.x - gx, o.y - gy) < 0.9) crowd++;
  }
  return Math.min(2, ARRIVE_DIST + 0.4 * crowd);
}

/** Per-step cost multiplier of entering a tile (slow terrain costs more). */
function stepCost(w: World, idx: number, mc: MoveClass): number {
  return 1 / (terrainMult(TERRAIN[w.terrain[idx] as Terrain], mc) || 1);
}

/** A* working arrays, grown to the largest map seen and reused by every search. */
let scratch: { g: Float32Array; from: Int32Array; seen: Uint32Array; shut: Uint32Array; gen: number } | null = null;

/**
 * 8-directional A* over the tile grid, weighted by terrain speed (roads are
 * preferred, mud and woods avoided). Returns tile-centre waypoints.
 */
export function findPath(
  w: World,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  mc: MoveClass = "ground",
  faction?: Faction
): { x: number; y: number }[] | null {
  const pass = (x: number, y: number) => passable(w, x, y, mc);
  // scan orders run in the side's own frame (red's is blue's turned 180°), so
  // equal-cost ties resolve as mirror images for the two sides (see sideFrame)
  const s = faction === "red" ? -1 : 1;
  // the tile under a point, floored in that frame too: a point on a tile edge
  // (e.g. an Uplink at (28, 28)) belongs to the tile on the side's own far side
  const tileX = (x: number) => (s > 0 ? Math.floor(x) : w.width - 1 - Math.floor(w.width - x));
  const tileY = (y: number) => (s > 0 ? Math.floor(y) : w.height - 1 - Math.floor(w.height - y));
  const sx = tileX(fromX);
  const sy = tileY(fromY);
  let gx = tileX(toX);
  let gy = tileY(toY);
  if (!inBounds(w, gx, gy)) {
    gx = Math.max(0, Math.min(w.width - 1, gx));
    gy = Math.max(0, Math.min(w.height - 1, gy));
  }
  // Only tiles in our own connected region can be reached (an island, or the
  // far shore of a sea, can't): world.ts regionLabels, from terrain alone.
  const region = mc === "air" ? 0 : regionAt(w, sx, sy, mc);
  const labels = region ? regionLabels(w, mc as LandClass) : null;
  const ok = (x: number, y: number) => pass(x, y) && (!labels || labels[y * w.width + x] === region);
  // If the goal tile itself is blocked or cut off, walk to the nearest tile
  // we can reach around it (spiral search, small radius), preferring ones
  // nearer to us; nothing in reach gives up at once instead of flooding.
  if (!ok(gx, gy)) {
    let found: { x: number; y: number } | null = null;
    for (let r = 1; r <= 6 && !found; r++) {
      let bestD = Infinity;
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++) {
          const dy = i * s;
          const dx = j * s;
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!ok(gx + dx, gy + dy)) continue;
          const d = hypot(gx + dx - sx, gy + dy - sy);
          if (d < bestD) {
            bestD = d;
            found = { x: gx + dx, y: gy + dy };
          }
        }
    }
    if (!found) return null;
    gx = found.x;
    gy = found.y;
  }
  if (sx === gx && sy === gy) return [{ x: gx + 0.5, y: gy + 0.5 }];

  const W = w.width;
  const H = w.height;
  const n = W * H;
  // scratch arrays shared by every search (a generation stamp marks the
  // entries this search has written, so nothing needs clearing)
  if (!scratch || scratch.g.length < n) scratch = { g: new Float32Array(n), from: new Int32Array(n), seen: new Uint32Array(n), shut: new Uint32Array(n), gen: 0 };
  const sc = scratch;
  if (++sc.gen >= 0xffffffff) {
    sc.seen.fill(0);
    sc.shut.fill(0);
    sc.gen = 1;
  }
  const gen = sc.gen;
  const gOf = (i: number) => (sc.seen[i] === gen ? sc.g[i]! : Infinity);
  const startIdx = sy * W + sx;
  const goalIdx = gy * W + gx;
  sc.seen[startIdx] = gen;
  sc.g[startIdx] = 0;
  // simple binary heap of [f, idx]
  const heap: number[] = [];
  const push = (f: number, idx: number) => {
    heap.push(f, idx);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2]! <= heap[i * 2]!) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[p * 2 + k]!;
        heap[p * 2 + k] = heap[i * 2 + k]!;
        heap[i * 2 + k] = t;
      }
      i = p;
    }
  };
  const pop = (): number => {
    const idx = heap[1]!;
    const last = heap.length - 2;
    heap[0] = heap[last]!;
    heap[1] = heap[last + 1]!;
    heap.length = last;
    let i = 0;
    const size = heap.length / 2;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < size && heap[l * 2]! < heap[m * 2]!) m = l;
      if (r < size && heap[r * 2]! < heap[m * 2]!) m = r;
      if (m === i) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[m * 2 + k]!;
        heap[m * 2 + k] = heap[i * 2 + k]!;
        heap[i * 2 + k] = t;
      }
      i = m;
    }
    return idx;
  };
  const h = (idx: number) => {
    const dx = Math.abs((idx % W) - gx);
    const dy = Math.abs(Math.floor(idx / W) - gy);
    return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) / MAX_TERRAIN_SPEED;
  };
  push(h(startIdx), startIdx);

  while (heap.length > 0) {
    const cur = pop();
    if (cur === goalIdx) {
      const path: { x: number; y: number }[] = [];
      for (let idx = goalIdx; idx !== startIdx; idx = sc.from[idx]!)
        path.push({ x: (idx % W) + 0.5, y: Math.floor(idx / W) + 0.5 });
      path.reverse();
      return path;
    }
    if (sc.shut[cur] === gen) continue;
    sc.shut[cur] = gen;
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const dy = i * s;
        const dx = j * s;
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!pass(nx, ny)) continue;
        // no diagonal corner-cutting past blocked orthogonals
        if (dx !== 0 && dy !== 0 && (!pass(cx + dx, cy) || !pass(cx, cy + dy))) continue;
        const nIdx = ny * W + nx;
        if (sc.shut[nIdx] === gen) continue;
        const cost = (dx !== 0 && dy !== 0 ? 1.4142 : 1) * stepCost(w, nIdx, mc);
        const g = sc.g[cur]! + cost;
        if (g < gOf(nIdx)) {
          sc.seen[nIdx] = gen;
          sc.g[nIdx] = g;
          sc.from[nIdx] = cur;
          push(g + h(nIdx), nIdx);
        }
      }
  }
  return null; // unreachable
}

/** Tiles per tick this unit moves at its current position. */
export function unitStepSpeed(w: World, u: Unit): number {
  const speed = (UNITS[u.kind].speed / TICK_RATE) * terrainSpeed(w, u.x, u.y, moveClassOf(u.kind));
  // the nations' boosts (Réseau TSF, Pression des chaudières): never on a Classique unit
  return u.tsf || u.overdrive !== undefined ? speed * speedMult(u) : speed;
}

/**
 * Advance a unit one tick toward (x, y). Ground units follow an A* path
 * (computed/cached here); air units fly straight. Returns true on arrival.
 */
export function moveUnitToward(w: World, u: Unit, x: number, y: number): boolean {
  const mc = moveClassOf(u.kind);
  const speed = unitStepSpeed(w, u);
  if (mc === "air") {
    const d = hypot(x - u.x, y - u.y);
    if (d <= Math.max(arrivalRadius(w, u, x, y), speed)) {
      return true;
    }
    u.facing = atan2(x - u.x, -(y - u.y));
    u.x += ((x - u.x) / d) * speed;
    u.y += ((y - u.y) / d) * speed;
    return false;
  }

  // ground: (re)plan when the goal changed or the path is exhausted/blocked
  if (
    !u.path ||
    !u.pathGoal ||
    hypot(u.pathGoal.x - x, u.pathGoal.y - y) > 0.6
  ) {
    u.path = findPath(w, u.x, u.y, x, y, mc, u.faction);
    u.pathGoal = { x, y };
    if (!u.path) return true; // unreachable: give up (caller goes idle)
  }
  let wp = u.path[0];
  while (wp) {
    const consume = u.path.length > 1 ? WAYPOINT_DIST : arrivalRadius(w, u, wp.x, wp.y);
    if (hypot(wp.x - u.x, wp.y - u.y) > consume) break;
    u.path.shift();
    wp = u.path[0];
  }
  if (!wp) {
    u.path = null;
    u.pathGoal = null;
    return true;
  }
  if (!passable(w, Math.floor(wp.x), Math.floor(wp.y), mc)) {
    // world changed under the path (new building etc.) — replan next tick
    u.path = null;
    return false;
  }
  const d = hypot(wp.x - u.x, wp.y - u.y);
  const step = Math.min(speed, d);
  u.facing = atan2(wp.x - u.x, -(wp.y - u.y));
  u.x += ((wp.x - u.x) / d) * step;
  u.y += ((wp.y - u.y) / d) * step;
  return false;
}

/** How close a unit needs to get to attack target `id` (a Goliath: its weapons still up that can hit it). */
function reachFor(w: World, u: Unit, id: number): number {
  if (!u.goliath) return UNITS[u.kind].range;
  const t = w.units.get(id);
  return goliathReachAt(u, t ? domainOf(t) : "ground");
}

/** Where to drive to reach a building: the nearest point of its footprint. */
export function approachPoint(
  w: World,
  u: Unit,
  targetId: number
): { x: number; y: number } | null {
  const t = w.units.get(targetId);
  if (t) return { x: t.x, y: t.y };
  const b = w.buildings.get(targetId);
  if (!b) return null;
  const size = BUILDINGS[b.kind].size;
  return {
    x: Math.max(b.tx + 0.5, Math.min(b.tx + size - 0.5, u.x)),
    y: Math.max(b.ty + 0.5, Math.min(b.ty + size - 0.5, u.y))
  };
}

/**
 * Where each ground vehicle stands. sim.ts takes this at the start of a tick,
 * before harvesting, combat or movement move anything, so separation can tell
 * a vehicle that drove this tick from a parked one.
 */
export function vehicleSpots(w: World): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  for (const u of w.units.values())
    if (UNITS[u.kind].domain === "ground" && !isInfantry(u.kind)) out.set(u.id, { x: u.x, y: u.y });
  return out;
}

/**
 * Per-tick movement for move / attack-move orders (combat may pause it),
 * then separation, then crushing: a Mastodon that drove this tick rolls over
 * the enemy squads under it (infantry.ts). `spots` is vehicleSpots from the
 * start of the tick (squads only step aside for a vehicle that drove).
 */
export function tickMovement(w: World, pausedIds: Set<number>, spots: Map<number, { x: number; y: number }> = new Map()): void {
  /** Where each crusher stood before it moved (to tell who actually drove). */
  const crushers: { u: Unit; x: number; y: number }[] = [];
  for (const u of w.units.values()) if (crushes(u.kind)) crushers.push({ u, x: u.x, y: u.y });
  for (const u of w.units.values()) {
    const o = u.order;
    if (pausedIds.has(u.id)) continue;
    if (!canWalk(u)) continue; // a Goliath digging in, anchored, packing up or on a lift (its order waits)
    if (o.type === "move" || o.type === "attackMove") {
      if (moveUnitToward(w, u, o.x, o.y)) u.order = { type: "idle" };
    } else if (o.type === "attack") {
      const p = approachPoint(w, u, o.targetId);
      if (!p) {
        u.order = { type: "idle" };
        continue;
      }
      const minRange = UNITS[u.kind].minRange ?? 0;
      const d = hypot(p.x - u.x, p.y - u.y);
      if (minRange > 0 && d < minRange) {
        // artillery: back off out of minimum range instead of closing in
        const k = (minRange + 0.8) / Math.max(d, 0.01);
        moveUnitToward(w, u, p.x + (u.x - p.x) * k, p.y + (u.y - p.y) * k);
      } else if (moveUnitToward(w, u, p.x, p.y) && d > reachFor(w, u, o.targetId)) {
        // (combat pauses it once in range.) Got as close as the ground allows and still out of
        // range of a target across the water: give it up, so the unit fights what it can reach
        const mc = moveClassOf(u.kind);
        const here = regionAt(w, Math.floor(u.x), Math.floor(u.y), mc);
        if (here && regionAt(w, Math.floor(p.x), Math.floor(p.y), mc) !== here) {
          u.ignore = { id: o.targetId, until: w.tick + IGNORE_TICKS };
          u.order = { type: "idle" };
        }
      }
    }
  }
  const moved = crushers.filter((c) => c.u.x !== c.x || c.u.y !== c.y).map((c) => c.u);
  const driving = new Set<number>();
  for (const [id, p] of spots) {
    const u = w.units.get(id);
    if (u && (u.x !== p.x || u.y !== p.y)) driving.add(id);
  }
  separate(w, driving);
  if (moved.length > 0) tickCrush(w, moved);
}

const KIND_INDEX: Record<string, number> = Object.fromEntries(Object.keys(UNITS).map((k, i) => [k, i]));

/**
 * Gentle separation so same-domain units don't stack. Robot infantry give
 * way: a squad and a FRIENDLY vehicle that drove this tick (`driving`) part
 * by moving only the squad (it steps aside), and a squad and an ENEMY
 * vehicle don't part at all (tanks roll through squads — and Mastodons crush
 * them). Squads among themselves, vehicles among themselves, and a squad
 * and a PARKED friendly vehicle share the push as usual (a squad walking up
 * to one shoulders it aside, as a second vehicle would — else it would be
 * pinned there, short of its goal, for good).
 *
 * A dug-in Goliath (anchoring, anchored or packing up) is never pushed:
 * whatever it meets takes the whole push (its footprint is in the occupancy
 * grid, so paths already go round it). A walking one parts like any unit. A
 * Goliath on a lift and its Condors are placed by the lift (lift.ts), so
 * they sit separation out.
 */
function separate(w: World, driving: Set<number>): void {
  const units = [...w.units.values()].filter((u) => u.order.type !== "lift" && !isLifted(u));
  for (let i = 0; i < units.length; i++) {
    const a = units[i]!;
    const da = UNITS[a.kind].domain;
    const ia = isInfantry(a.kind);
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j]!;
      if (UNITS[b.kind].domain !== da) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const reach = Math.max(1.2, UNITS[a.kind].radius + UNITS[b.kind].radius);
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const ib = isInfantry(b.kind);
      if (ia !== ib && a.faction !== b.faction) continue; // enemy vehicle and squad: drive through
      const d = hypot(dx, dy);
      const minD = Math.max(0.7, UNITS[a.kind].radius + UNITS[b.kind].radius);
      if (d >= minD) continue;
      const push = (minD - d) / 2;
      let ux: number;
      let uy: number;
      if (d < 1e-3) {
        // perfectly coincident (e.g. spawned at the same tile centre): no
        // direction to push along, so derive one deterministically — for a
        // side's own pair from kinds and the clock, turned 180° for red, so
        // both sides' mirror-image pairs split as mirror images
        const angle =
          a.faction === b.faction
            ? ((KIND_INDEX[a.kind]! * 7 + KIND_INDEX[b.kind]! * 13 + w.tick) % 16) * (Math.PI / 8) +
              (a.faction === "red" ? Math.PI : 0)
            : ((a.id * 7 + b.id * 13) % 16) * (Math.PI / 8);
        ux = sin(angle);
        uy = -cos(angle);
      } else {
        ux = dx / d;
        uy = dy / d;
      }
      const planted = (u: Unit) => !!u.goliath && !canWalk(u);
      if (planted(a) && planted(b)) continue; // (two dug in never budge: their footprints can't overlap anyway)
      if (planted(a) !== planted(b)) {
        // a dug-in Goliath doesn't budge: the other takes the whole push
        if (planted(a)) nudge(w, b, ux * push * 2, uy * push * 2);
        else nudge(w, a, -ux * push * 2, -uy * push * 2);
        continue;
      }
      if (ia !== ib && driving.has(ia ? b.id : a.id)) {
        // a squad steps aside for a friendly vehicle on the move: it takes the whole push
        const [veh, squad, sx, sy] = ia ? [b, a, -ux, -uy] : [a, b, ux, uy];
        const s = stepAside(veh, sx, sy);
        nudge(w, squad, s.x * push * 2, s.y * push * 2);
        continue;
      }
      nudge(w, a, -ux * push, -uy * push);
      nudge(w, b, ux * push, uy * push);
    }
  }
}

/**
 * Which way a squad in a vehicle's way gives ground: straight away from it,
 * or — when it stands in front — sideways off the vehicle's line of travel,
 * to whichever side it is already on (dead ahead: the vehicle's right, which
 * turns with the vehicle, so mirror-image pairs part as mirror images).
 * (dx, dy) is the unit vector from the vehicle to the squad.
 */
function stepAside(v: Unit, dx: number, dy: number): { x: number; y: number } {
  const fx = sin(v.facing);
  const fy = -cos(v.facing);
  if (dx * fx + dy * fy <= 0) return { x: dx, y: dy }; // beside or behind it: just back off
  const rx = -fy; // the vehicle's right hand
  const ry = fx;
  const side = dx * rx + dy * ry;
  const s = side < -1e-6 ? -1 : 1;
  return { x: rx * s, y: ry * s };
}

/** Ground units keep this far (tiles) inside the map's edge (their models stand around the centre). */
const EDGE = 0.4;

function nudge(w: World, u: Unit, dx: number, dy: number): void {
  const m = UNITS[u.kind].domain === "air" ? 0.05 : EDGE;
  const nx = Math.min(w.width - m, Math.max(m, u.x + dx));
  const ny = Math.min(w.height - m, Math.max(m, u.y + dy));
  const mc = moveClassOf(u.kind);
  if (!passable(w, Math.floor(nx), Math.floor(ny), mc)) return;
  // never across a corner into another region (a one-tile pocket of water, an island): A* can't
  // take that step back, so the unit would be stranded
  if (mc !== "air") {
    const from = regionAt(w, Math.floor(u.x), Math.floor(u.y), mc);
    if (from && regionAt(w, Math.floor(nx), Math.floor(ny), mc) !== from) return;
  }
  u.x = nx;
  u.y = ny;
}
