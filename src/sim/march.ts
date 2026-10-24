import { TICK_RATE, UNITS } from "./balance";
import { atan2, hypot } from "./fmath";
import { orderedToMove } from "./goliath";
import { behaves } from "./nations";
import type { Command, MarchGroup, Unit, UnitKind, World } from "./types";

/**
 * The march in order (« marche en ordre »): a group sent to a front drawn on
 * the map (a `march` command: the line from (x1, y1) to (x2, y2)) deploys
 * along it, facing away from where it came from, each unit in its place by
 * what it does:
 *
 *   - armour and squads on the front line (and rows behind it if the line is
 *     too short for them all);
 *   - anti-aircraft behind them;
 *   - artillery, marksmen, repairers and the unarmed at the back;
 *   - aircraft over the anti-aircraft (healers over the back).
 *
 * A front drawn short, or along the way the group is going, is a column
 * instead: two abreast, head at the far end, in the same order front to back
 * (a bridge, a road, a pass).
 *
 * They set off together and arrive together: each unit is due at its place
 * on the same tick (Unit.march.due), the one the slowest needs, and the rest
 * keep their pace to that (movement.ts marchPace); on arrival each turns to
 * face the front. A unit held up past that tick (a fight on the way, a
 * detour) goes on at its own speed.
 *
 * A long unit list reaches the sim as several commands (the duel's
 * codec splits it, versus/codec.ts), possibly over a few turns: a march to
 * the same front within MARCH.mergeTicks of one under way joins it, and the
 * whole group is laid out again, so the pieces deploy as one.
 *
 * Old records never send a march, so no unit of theirs ever has one and
 * their world hashes stay what they were (checksum.ts folds marches in only
 * when one exists).
 */
export const MARCH = {
  /** Tiles between two neighbours on a line, at least (more for big units). */
  gap: 1.5,
  /** Tiles between two rows, at least. */
  rowGap: 1.7,
  /** A band with fewer units than a long front holds spreads out to it, at most this far apart. */
  spreadMax: 3.5,
  /** A front shorter than this (tiles) is a column. */
  columnBelow: 3,
  /** A front within ~30° of the way the group goes is a column (|cos| above this). */
  axisCos: 0.87,
  /** A ground path is this much longer than the straight line, roughly: the due tick allows for it. */
  pathSlack: 1.2,
  /** A march to the same front this soon after one (ticks) joins it. */
  mergeTicks: 50,
  /** Keeping pace, a unit never slows below this share of its speed. */
  paceFloor: 0.2
} as const;

type MarchCommand = Extract<Command, { type: "march" }>;

/** 0: the front line, 1: anti-aircraft, 2: the back. */
type Band = 0 | 1 | 2;

/** Where a ground unit marches. */
export function bandOf(kind: UnitKind): Band {
  const s = UNITS[kind];
  if (kind === "goliath") return 0; // (a walking fortress leads, whatever its reach)
  if (s.targets === "air") return 1;
  if (s.targets === "none" || s.heal || (s.minRange ?? 0) > 0 || s.range >= 6) return 2;
  return 0;
}

const isAir = (kind: UnitKind): boolean => UNITS[kind].domain === "air";

interface Pt {
  x: number;
  y: number;
}

/** Where each unit goes, and the way they all face once there (radians, 0 = North, clockwise). */
export interface MarchLayout {
  slots: Map<number, Pt>;
  face: number;
  /** A column (the front was short, or along the way the group goes). */
  column: boolean;
}

/** The spacing a set of units needs side by side. */
function gapFor(units: readonly Unit[], min: number): number {
  let r = 0;
  for (const u of units) r = Math.max(r, UNITS[u.kind].radius);
  return Math.max(min, 2 * r + 0.6);
}

const byId = (a: Unit, b: Unit): number => a.id - b.id;

/**
 * Lay a group out on the front from p1 to p2 (pure: tests and the gesture's
 * preview call it too). The order of `units` doesn't matter.
 */
export function marchLayout(units: readonly Unit[], p1: Pt, p2: Pt, map: { width: number; height: number }): MarchLayout {
  const slots = new Map<number, Pt>();
  const ground = units.filter((u) => !isAir(u.kind)).sort(byId);
  const air = units.filter((u) => isAir(u.kind)).sort(byId);
  // (aircraft alone march as a ground group would, all on the front)
  const body = ground.length ? ground : air;
  const above = ground.length ? air : [];

  // where the group stands now, and the way it goes
  let cx = 0;
  let cy = 0;
  for (const u of body) {
    cx += u.x;
    cy += u.y;
  }
  cx /= body.length || 1;
  cy /= body.length || 1;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const L = hypot(p2.x - p1.x, p2.y - p1.y);
  const gl = hypot(mx - cx, my - cy);
  // (the way the group goes: from where it stands to the front; standing on it already, straight ahead of the line)
  let gx = gl > 1e-6 ? (mx - cx) / gl : 0;
  let gy = gl > 1e-6 ? (my - cy) / gl : -1;
  const dx = L > 1e-6 ? (p2.x - p1.x) / L : 1;
  const dy = L > 1e-6 ? (p2.y - p1.y) / L : 0;
  if (gl <= 1e-6 && L > 1e-6) {
    gx = -dy;
    gy = dx;
  }
  const column = L < MARCH.columnBelow || Math.abs(dx * gx + dy * gy) > MARCH.axisCos;

  // forward (fx, fy): where the front faces; lateral (lx, ly): along it; (hx, hy): the head of it all
  let fx: number;
  let fy: number;
  let hx: number;
  let hy: number;
  if (column) {
    if (L < MARCH.columnBelow) {
      fx = gx;
      fy = gy;
      hx = mx;
      hy = my;
    } else {
      // drawn along the way: the column runs along the line, head at its far end
      const s = dx * gx + dy * gy >= 0 ? 1 : -1;
      fx = dx * s;
      fy = dy * s;
      hx = s > 0 ? p2.x : p1.x;
      hy = s > 0 ? p2.y : p1.y;
    }
  } else {
    // the front's normal, turned away from the group
    const s = -dy * gx + dx * gy >= 0 ? 1 : -1;
    fx = -dy * s;
    fy = dx * s;
    hx = mx;
    hy = my;
  }
  const lx = -fy;
  const ly = fx;
  const put = (u: Unit, across: number, depth: number) =>
    slots.set(u.id, {
      x: Math.max(0.5, Math.min(map.width - 0.5, hx + lx * across - fx * depth)),
      y: Math.max(0.5, Math.min(map.height - 0.5, hy + ly * across - fy * depth))
    });
  // across the front, left to right, and how far forward (ties: id)
  const lateral = (u: Unit) => (u.x - hx) * lx + (u.y - hy) * ly;

  /** Lay `band` out in rows from `depth` back; the depth after its last row. */
  const rows = (band: readonly Unit[], depth: number, width: number, spread: boolean): number => {
    if (!band.length) return depth;
    const gap = gapFor(band, MARCH.gap);
    const rowGap = gapFor(band, MARCH.rowGap);
    const sorted = band.slice().sort((a, b) => lateral(a) - lateral(b) || a.id - b.id);
    const perRow = Math.max(1, Math.floor(width / gap) + 1);
    const n = Math.ceil(sorted.length / perRow);
    for (let r = 0; r < n; r++) {
      // row r takes every n-th unit, so each row spans the width and nobody crosses over
      const row = sorted.filter((_, i) => i % n === r);
      const k = row.length;
      const step = k > 1 ? (spread ? Math.min(width / (k - 1), Math.max(gap, MARCH.spreadMax)) : gap) : 0;
      row.forEach((u, i) => put(u, (i - (k - 1) / 2) * step, depth));
      depth += rowGap;
    }
    return depth;
  };

  const bands: Unit[][] = [[], [], []];
  for (const u of body) bands[ground.length ? bandOf(u.kind) : 0]!.push(u);
  const heal = above.filter((u) => UNITS[u.kind].heal || UNITS[u.kind].targets === "none");
  const fliers = above.filter((u) => !heal.includes(u));

  if (column) {
    // two abreast (one alone walks the middle), front band first
    const file = [...bands[0]!, ...bands[1]!, ...bands[2]!];
    const gap = gapFor(file, MARCH.gap);
    const rowGap = gapFor(file, 1.4);
    const pairs = (list: readonly Unit[], from: number) => {
      for (let i = 0; i < list.length; i += 2) {
        const pair = list.slice(i, i + 2).sort((a, b) => lateral(a) - lateral(b) || a.id - b.id);
        pair.forEach((u, j) => put(u, pair.length === 2 ? (j - 0.5) * gap : 0, from + (i / 2) * rowGap));
      }
    };
    pairs(file, 0);
    const len = Math.max(0, Math.ceil(file.length / 2) - 1) * rowGap;
    pairs(fliers, len / 3);
    pairs(heal, (len * 2) / 3);
  } else {
    let depth = rows(bands[0]!, 0, L, true);
    const midFrom = depth;
    depth = rows(bands[1]!, depth, L, false);
    const backFrom = depth;
    rows(bands[2]!, depth, L, false);
    // aircraft over the anti-aircraft (just behind the front when there is none), healers over the back
    rows(fliers, bands[1]!.length ? midFrom : Math.max(0, midFrom - MARCH.rowGap / 2), L, false);
    rows(heal, bands[2]!.length ? backFrom : midFrom, L, false);
  }
  return { slots, face: atan2(fx, -fy), column };
}

/** Ticks a unit needs to cover `d` tiles at its own speed (ground: allowing for the path). */
function ticksFor(u: Unit, d: number): number {
  return (d * (isAir(u.kind) ? 1 : MARCH.pathSlack)) / (UNITS[u.kind].speed / TICK_RATE);
}

const same = (g: MarchGroup, c: MarchCommand) =>
  g.faction === c.faction && g.x1 === c.x1 && g.y1 === c.y1 && g.x2 === c.x2 && g.y2 === c.y2 && g.attack === c.attack;

/**
 * A `march` command, for each of `c.unitIds` that is the commanding side's
 * and not on a lift (`lifting`, lift.ts routeLiftCommand).
 */
export function applyMarchCommand(w: World, c: MarchCommand, lifting: ReadonlySet<number>): void {
  if (w.marches) {
    w.marches = w.marches.filter((g) => w.tick - g.tick <= MARCH.mergeTicks);
    if (!w.marches.length) delete w.marches;
  }
  const mine = (id: number) => {
    const u = w.units.get(id);
    return u && u.faction === c.faction && !lifting.has(id) ? u : null;
  };
  let group = w.marches?.find((g) => same(g, c)) ?? null;
  const ids = new Set<number>();
  // (the pieces before this one, still on their way to this front)
  if (group) for (const id of group.units) if (mine(id)?.march?.g === group.id) ids.add(id);
  for (const id of c.unitIds) if (mine(id)) ids.add(id);
  const units = [...ids].sort((a, b) => a - b).map((id) => w.units.get(id)!);
  if (!units.length) return;
  if (!group) {
    const marches = (w.marches ??= []);
    // (unique: one tick sees a few marches at most)
    group = { id: w.tick * 64 + marches.filter((g) => g.tick === w.tick).length, faction: c.faction, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, attack: c.attack, tick: w.tick, units: [] };
    marches.push(group);
  }
  group.units = units.map((u) => u.id);
  const lay = marchLayout(units, { x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, w);
  let due = 0;
  for (const u of units) {
    const s = lay.slots.get(u.id)!;
    due = Math.max(due, ticksFor(u, hypot(s.x - u.x, s.y - u.y)));
  }
  due = w.tick + Math.ceil(due);
  for (const u of units) {
    const s = lay.slots.get(u.id)!;
    // (the unarmed always just drive, as on a route)
    u.order = { type: c.attack && !behaves(u.kind, "harvester") ? "attackMove" : "move", x: s.x, y: s.y };
    u.path = null;
    u.autoTargetId = null;
    u.march = { g: group.id, due, face: lay.face };
    orderedToMove(w, u); // an anchored Goliath packs up first
  }
}

/** Every march of the units named by any other command goes: that order replaces it. */
export function dropMarches(w: World, c: Command): void {
  if (!("unitIds" in c) || c.type === "march") return;
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (u?.march && u.faction === c.faction) delete u.march;
  }
}

/**
 * The speed (tiles/tick) a marching unit keeps, `remaining` tiles from its
 * place: what gets it there on its due tick, never more than its own `speed`
 * nor below MARCH.paceFloor of it. Past the due tick, its own speed.
 */
export function marchPace(w: World, u: Unit, speed: number, remaining: number): number {
  const m = u.march;
  if (!m || m.due <= w.tick) return speed;
  return Math.min(speed, Math.max(remaining / (m.due - w.tick), speed * MARCH.paceFloor));
}

/** A marching unit reached its place: it turns to face the front, and the march is over for it. */
export function marchArrived(u: Unit): void {
  if (!u.march) return;
  u.facing = u.march.face;
  delete u.march;
}
