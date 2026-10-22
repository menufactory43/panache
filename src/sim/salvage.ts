import { BUILDINGS, GOLIATH, SALVAGE, TICK_RATE, UNITS } from "./balance";
import { behaves, unitTicks } from "./nations";
import { isInfantry } from "./infantry";
import type { Building, Faction, Unit, World, Wreck } from "./types";
import { incomeOf } from "./rules";
import { worldRandom } from "./rand";
import { buildingAtTile, buildingCenter, domainOf, groundPassable, sideFrame } from "./world";
import { cos, hypot, sin } from "./fmath";

/**
 * Battlefield salvage. A destroyed combat unit leaves a burning wreck worth
 * ~30% of its cost for a minute; after it cools (a couple of seconds) the
 * first ground unit of EITHER side to drive within reach scoops it up. Fights
 * leave loot worth holding the field for, and a defender who repels a wave
 * gets paid for it — the one mechanic the design panel measured loosening
 * the snowball.
 */

/**
 * Wreck value of a unit kind (0 for harvesters: they spill their cargo, not a
 * hull; and 0 for robot infantry: a fallen squad leaves nothing worth hauling).
 */
export function wreckValue(kind: Unit["kind"], share: number = SALVAGE.share): number {
  if (behaves(kind, "harvester") || isInfantry(kind)) return 0;
  return Math.round(UNITS[kind].cost * share);
}

/**
 * Share of its cost a dead unit of `faction` leaves as a wreck in this world:
 * SALVAGE.share, except Last Stand's wave units (the survival state's own,
 * much smaller share — the waves are not an economy to farm).
 */
export function wreckShareOf(w: World, faction: Faction): number {
  const s = w.survival;
  return s && faction !== s.defender ? s.wreckShare : SALVAGE.share;
}

/**
 * Where a wreck dying at (x, y) comes to rest: the spot itself if a tank
 * could stand there, else the closest point of a passable tile within
 * `SALVAGE.shiftRadius` (aircraft over rock, a Lancer sinking near the bank,
 * a drone crashing onto a building), else null (lost in the lava).
 */
export function wreckRestingSpot(w: World, x: number, y: number, faction?: Faction): { x: number; y: number } | null {
  // (with a faction, scanned in its side's frame, so mirror-image falls rest as mirror images: a
  // Goliath dropped onto a building, lift.ts; without one, the world's frame as wrecks always were)
  const fr = sideFrame(w, faction);
  const p = fr.pt({ x, y });
  const pass = (fx: number, fy: number) => groundPassable(w, ...fr.tile(fx, fy, 1));
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  if (pass(tx, ty)) return { x, y };
  const R = SALVAGE.shiftRadius;
  const span = Math.ceil(R);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  // fixed scan order + strict comparison: deterministic tie-breaks
  for (let dy = -span; dy <= span; dy++)
    for (let dx = -span; dx <= span; dx++) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!pass(nx, ny)) continue;
      // nearest point of that tile, kept off its very edge
      const cx = Math.max(nx + 0.2, Math.min(nx + 0.8, p.x));
      const cy = Math.max(ny + 0.2, Math.min(ny + 0.8, p.y));
      const d = hypot(cx - p.x, cy - p.y);
      if (d > R || d >= bestD) continue;
      bestD = d;
      best = { x: cx, y: cy };
    }
  return best ? fr.pt(best) : null;
}

/** Make room for one more wreck: the field holds so much, and the oldest burns out first. */
function makeRoom(w: World): void {
  while (w.wrecks.length >= SALVAGE.maxWrecks) w.wrecks.shift();
}

/**
 * Scatter `value` scrap over `count` piles around (x, y), each up to `spread`
 * tiles out, as wrecks flagged `pile` (Wreck.pile). The pattern is turned by
 * `facing` and its random draws are keyed by the tick and the pile, not by
 * ids, so mirror-image deaths on the same tick scatter as mirror images.
 * Piles that would land somewhere no tank can reach are lost.
 */
export function scatterPiles(
  w: World,
  faction: Faction,
  x: number,
  y: number,
  value: number,
  count: number,
  spread: number,
  facing: number,
  salt: string
): Wreck[] {
  const out: Wreck[] = [];
  if (value <= 0 || count <= 0) return out;
  const each = Math.round(value / count);
  if (each <= 0) return out;
  for (let i = 0; i < count; i++) {
    const a = facing + ((i + 0.5 * worldRandom(w, salt, w.tick, i, 0)) / count) * Math.PI * 2;
    const r = spread * (0.3 + 0.7 * worldRandom(w, salt, w.tick, i, 1));
    const spot = wreckRestingSpot(w, x + sin(a) * r, y - cos(a) * r);
    if (!spot) continue;
    makeRoom(w);
    const pile: Wreck = {
      id: w.nextId++,
      kind: "goliath",
      faction,
      x: spot.x,
      y: spot.y,
      facing: a,
      value: each,
      ttl: Math.round(GOLIATH.pileTtl * TICK_RATE),
      hot: Math.round(SALVAGE.hot * TICK_RATE),
      pile: true
    };
    w.wrecks.push(pile);
    out.push(pile);
  }
  return out;
}

/**
 * A fallen Goliath leaves no hull, but its salvage scattered over a wide
 * area (GOLIATH.salvage): several scrap piles, so collecting all of it means
 * holding the ground. Over water most of it is lost.
 */
function scatterGoliath(w: World, u: Unit): Wreck[] {
  const S = GOLIATH.salvage;
  const value = Math.round(UNITS[u.kind].cost * S.share * (wreckShareOf(w, u.faction) / SALVAGE.share));
  const count = S.piles[0] + Math.floor(worldRandom(w, "goliath-piles", w.tick) * (S.piles[1] - S.piles[0] + 1));
  return scatterPiles(w, u.faction, u.x, u.y, value, Math.min(count, S.piles[1]), S.spread, u.facing, "goliath-salvage");
}

/**
 * A Gantry destroyed with a Goliath on its cradle: the build is lost, and
 * scrap scatters around it in proportion to how far it had got
 * (GOLIATH.gantrySalvage: a share of what was paid × progress).
 */
export function scatterGantry(w: World, b: Building): Wreck[] {
  const head = b.queue[0];
  if (!head || !behaves(head.kind, "goliath")) return []; // (the Gargantua, or the Zénith in its Hangar)
  const total = unitTicks(w, b.faction, head.kind);
  const progress = Math.max(0, Math.min(1, 1 - head.remaining / total));
  const S = GOLIATH.gantrySalvage;
  const value = Math.round((head.paid ?? UNITS[head.kind].cost) * progress * S.share);
  const count = Math.max(1, Math.round(S.piles * progress));
  const c = buildingCenter(b);
  // (the Gantry's own facing turns red's scatter as the mirror of blue's)
  return scatterPiles(w, b.faction, c.x, c.y, value, count, S.spread + BUILDINGS.gantry.size / 2, b.faction === "red" ? Math.PI : 0, "gantry-salvage");
}

/** Leave a wreck where unit `u` died (called from cleanupDeaths); a Goliath scatters scrap piles instead (and returns the first). */
export function leaveWreck(w: World, u: Unit): Wreck | null {
  if (u.free) return null; // a map-given unit cost nothing, so it leaves nothing to cash in
  if (u.goliath) return scatterGoliath(w, u)[0] ?? null;
  const value = wreckValue(u.kind, wreckShareOf(w, u.faction));
  if (value <= 0) return null;
  const spot = wreckRestingSpot(w, u.x, u.y);
  if (!spot) return null;
  makeRoom(w);
  const r: Wreck = {
    id: u.id,
    kind: u.kind,
    faction: u.faction,
    x: spot.x,
    y: spot.y,
    facing: u.facing,
    value,
    ttl: Math.round(SALVAGE.ttl * TICK_RATE),
    hot: Math.round(SALVAGE.hot * TICK_RATE)
  };
  w.wrecks.push(r);
  return r;
}

/** Credit a wreck to `faction` (scaled by its income multipliers and match rules) and emit the event. */
function collect(w: World, r: Wreck, faction: Faction, collectorId: number): void {
  const f = w.factions[faction];
  const amount = r.value * incomeOf(w, faction);
  f.scrap += amount;
  f.stats.scrapSalvaged += amount;
  w.fx.push({ type: "salvage", faction, x: r.x, y: r.y, value: amount, wreckId: r.id, collectorId });
}

/**
 * Per tick, after deaths are cleaned up: age wrecks, burn out old ones and
 * let ground units (either side, harvesters included) scoop up cool ones.
 * The nearest unit in reach wins; ties go to the earliest-built.
 */
export function tickSalvage(w: World): void {
  if (w.wrecks.length === 0) return;
  const reach = SALVAGE.pickupRadius;
  // a side on a frozen economy (an op's zero income) can't cash wrecks in: its units drive over them
  const earns = { blue: incomeOf(w, "blue") > 0, red: incomeOf(w, "red") > 0 };
  // ...nor can Last Stand's waves (no economy to feed): the wrecks stay for the defender
  if (w.survival) earns[w.survival.defender === "blue" ? "red" : "blue"] = false;
  const ground: Unit[] = [];
  for (const u of w.units.values()) if (domainOf(u) === "ground" && earns[u.faction]) ground.push(u);
  const keep: Wreck[] = [];
  for (const r of w.wrecks) {
    if (--r.ttl <= 0) continue; // burnt out
    if (r.hot > 0) {
      r.hot--;
      keep.push(r);
      continue;
    }
    // a building placed over a wreck clears it: its owner keeps the scrap
    const b = buildingAtTile(w, Math.floor(r.x), Math.floor(r.y));
    if (b) {
      if (earns[b.faction]) collect(w, r, b.faction, b.id);
      continue;
    }
    let best: Unit | null = null;
    let bestD = reach;
    for (const u of ground) {
      const dx = u.x - r.x;
      if (dx > reach || dx < -reach) continue;
      const dy = u.y - r.y;
      if (dy > reach || dy < -reach) continue;
      const d = hypot(dx, dy);
      if (d <= bestD && (best === null || d < bestD)) {
        best = u;
        bestD = d;
      }
    }
    if (best) collect(w, r, best.faction, best.id);
    else keep.push(r);
  }
  w.wrecks = keep;
}
