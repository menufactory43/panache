import { BUILDINGS, GOLIATH, TERRAIN, TICK_RATE, UNITS } from "./balance";
import { blocksObjective } from "./objectives";
import { isStunned } from "./powers";
import { applySpawnRank, goliathBase, rulesOf } from "./rules";
import type { Command, Faction, GoliathMode, GoliathWeapon, Unit, UnitKind, World } from "./types";
import { buildingCenter, hqOf, inBounds, removeBuilding, sideFrame, spawnUnit, terrainAt } from "./world";
import { hypot } from "./fmath";

/** Placement refused because a ground unit stands there (it may move off: callers compare with this). */
export const UNIT_IN_THE_WAY = "Une unité gêne";

/**
 * The Goliath (GOLIATH.md): a giant walking mech that is also a mobile base.
 *
 * - WALKING it moves and fights. ANCHORED (GOLIATH.anchorTime to dig in,
 *   GOLIATH.packTime to pack up again) it can't move, but harvesters unload
 *   at it, it trains infantry squads, and buildings may go up in its build
 *   ring as OUTPOSTS (economy.ts canPlaceBuilding): outposts never count as
 *   base for build range, so nothing is built off them.
 * - Four weapon systems (GOLIATH.weapons; combat.ts fires them) go offline as
 *   its health falls — mortars, then the laser, then the arm cannons; the
 *   machine guns always work — and only Menders' repair brings them back,
 *   each after a reboot once health is a margin above the line where it went.
 * - It sees further than anything else and the enemy always sees it
 *   (UNITS.goliath.alwaysVisible). Two Condors can lift it (lift.ts).
 * - A side is beaten only once its HQ AND all its Goliaths are gone
 *   (combat.ts cleanupDeaths). Each Goliath costs GOLIATH.costStep more for
 *   every one the side already has.
 *
 * Its state lives on the unit (Unit.goliath, created by spawnUnit).
 */

/** Every weapon system, in firing order (the heaviest last: it turns the torso). */
export const GOLIATH_WEAPONS: readonly GoliathWeapon[] = ["mg", "mortars", "laser", "cannons"];

/** The systems damage can take offline, in the order it takes them. */
export const LOSABLE_WEAPONS: readonly GoliathWeapon[] = ["mortars", "laser", "cannons"];

// ------------------------------------------------------------ queries ---

/** Is this unit a Goliath (with its state)? */
export const isGoliath = (u: Unit): u is Unit & { goliath: NonNullable<Unit["goliath"]> } => !!u.goliath;

/** Settled in walking mode, on the ground and free to move (not digging in, packing up or on a lift). */
export const canWalk = (u: Unit): boolean => !u.goliath || (u.goliath.mode === "walking" && !u.goliath.lift);

/** Fully anchored: a drop-off, a build ring, a barracks. */
export const isAnchored = (u: Unit): boolean => u.goliath?.mode === "anchored" && !u.goliath.lift;

/** Off the ground under two Condors (lift.ts): an air target, only its machine guns fire. */
export const isLifted = (u: Unit): boolean => u.goliath?.lift?.phase === "carrying";

/** Goliaths `faction` has on the field (lifted ones included). */
export function goliathsOf(w: World, faction: Faction): Unit[] {
  const out: Unit[] = [];
  for (const u of w.units.values()) if (u.goliath && u.faction === faction) out.push(u);
  return out;
}

/** Anchored Goliaths of `faction` (drop-offs, build rings, barracks). */
export function anchoredGoliaths(w: World, faction: Faction): Unit[] {
  return goliathsOf(w, faction).filter(isAnchored);
}

/** Does `faction` have a Goliath left (on the field, or in the air)? */
export function hasGoliath(w: World, faction: Faction): boolean {
  for (const u of w.units.values()) if (u.goliath && u.faction === faction && u.hp > 0) return true;
  return false;
}

/**
 * What the next Goliath costs `faction`: the list price plus GOLIATH.costStep
 * of it for every Goliath the side already has — alive, or paid for and on a
 * Gantry. Losing one makes the next one cheaper again.
 */
export function goliathCost(w: World, faction: Faction): number {
  let have = 0;
  for (const u of w.units.values()) if (u.goliath && u.faction === faction && u.hp > 0) have++;
  for (const b of w.buildings.values())
    if (b.faction === faction) for (const q of b.queue) if (q.kind === "goliath") have++;
  return Math.round(UNITS.goliath.cost * (1 + GOLIATH.costStep * have));
}

/** What a unit of `kind` costs `faction` right now (only the Goliath's price moves). */
export function unitCost(w: World, faction: Faction, kind: UnitKind): number {
  return kind === "goliath" ? goliathCost(w, faction) : UNITS[kind].cost;
}

/** Is weapon `k` of Goliath `u` able to fire right now (online, and not grounded to the machine guns by a lift)? */
export function weaponReady(u: Unit, k: GoliathWeapon): boolean {
  const g = u.goliath;
  if (!g || !g.weapons[k].online) return false;
  return k === "mg" || !isLifted(u);
}

/** The reach (tiles) of Goliath `u`'s longest-ranged weapon that is up (for threat rings and AI). */
export function goliathReach(u: Unit): number {
  let r = 0;
  for (const k of GOLIATH_WEAPONS) if (weaponReady(u, k)) r = Math.max(r, GOLIATH.weapons[k].range);
  return r;
}

/**
 * The reach (tiles) of Goliath `u`'s longest-ranged weapon that can fire now
 * and can hit a target in `domain` (0: none can) — how close an attack order
 * must bring it.
 */
export function goliathReachAt(u: Unit, domain: "ground" | "air"): number {
  let r = 0;
  for (const k of GOLIATH_WEAPONS) {
    const t = GOLIATH.weapons[k].targets;
    if (weaponReady(u, k) && (t === "both" || t === domain)) r = Math.max(r, GOLIATH.weapons[k].range);
  }
  return r;
}

/** Weapons down (offline or rebooting). */
export function weaponsDown(u: Unit): GoliathWeapon[] {
  const g = u.goliath;
  if (!g) return [];
  return LOSABLE_WEAPONS.filter((k) => !g.weapons[k].online);
}

/**
 * How badly a Goliath wants a Mender (for the Menders' own target pick and
 * the AI): a weapon offline, rebooting, or within a few percent of coming
 * back. 0 for anything else.
 */
export function repairUrgency(u: Unit): number {
  const g = u.goliath;
  if (!g || u.hp >= UNITS[u.kind].hp) return 0;
  const share = u.hp / UNITS[u.kind].hp;
  let urgency = 0;
  for (const k of LOSABLE_WEAPONS) {
    const ws = g.weapons[k];
    if (ws.online) continue;
    if (ws.reboot >= 0) urgency = Math.max(urgency, 2); // rebooting: keep the HP up
    else {
      const need = GOLIATH.weapons[k].lostBelow + GOLIATH.restoreMargin - share;
      urgency = Math.max(urgency, need <= 0.08 ? 3 : 1); // about to come back: worth the most
    }
  }
  return urgency;
}

// ---------------------------------------------------------- anchoring ---

/** The footprint (top-left tile and edge) of ground a Goliath standing at (x, y) needs to anchor, in its side's frame. */
export function anchorFootprint(w: World, faction: Faction, x: number, y: number): { tx: number; ty: number; size: number } {
  const size = GOLIATH.footprint;
  const fr = sideFrame(w, faction);
  const p = fr.pt({ x, y });
  // the size² block of tiles whose middle is nearest the Goliath (in the side's own frame: mirror-fair rounding)
  const [tx, ty] = fr.tile(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size);
  return { tx, ty, size };
}

/**
 * Why Goliath `u` can't anchor where it stands, as a short phrase for the HUD,
 * or null when it can. It digs in anywhere a building could be placed —
 * buildable ground, no building, Uplink platform, crate or other ground unit
 * in the way — with no build-range requirement.
 */
export function anchorBlocker(w: World, u: Unit): string | null {
  const g = u.goliath;
  if (!g) return "Pas un Gargantua";
  if (g.lift) return "En cours de levage";
  if (g.mode === "anchored" || g.mode === "anchoring") return "Déjà ancré";
  if (g.mode === "packing") return "Levée de l'ancre en cours";
  const { tx, ty, size } = anchorFootprint(w, u.faction, u.x, u.y);
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!inBounds(w, x, y)) return "Hors de la carte";
      if (w.occupancy[y * w.width + x] !== 0) return "Bloqué"; // (a building, or another dug-in Goliath)
      if (!TERRAIN[terrainAt(w, x, y)].buildable) return "Sol dégagé requis";
    }
  if (blocksObjective(w, tx, ty, size)) return "Bloqué";
  for (const o of w.units.values())
    if (
      o.id !== u.id &&
      UNITS[o.kind].domain === "ground" &&
      !isLifted(o) &&
      o.x >= tx && o.x < tx + size &&
      o.y >= ty && o.y < ty + size
    )
      return UNIT_IN_THE_WAY;
  return null;
}

/**
 * How far along an anchoring or packing transition is (0…1), or 1 when the
 * Goliath is settled. For the HUD's progress arc.
 */
export function modeProgress(u: Unit): number {
  const g = u.goliath;
  if (!g || (g.mode !== "anchoring" && g.mode !== "packing")) return 1;
  const total = Math.round((g.mode === "anchoring" ? GOLIATH.anchorTime : GOLIATH.packTime) * TICK_RATE);
  return Math.max(0, Math.min(1, 1 - g.modeTicks / total));
}

/** Why Goliath `u` can't pack up now (null: it can). */
export function packUpBlocker(u: Unit): string | null {
  const g = u.goliath;
  if (!g) return "Pas un Gargantua";
  if (g.mode === "walking") return "Pas ancré";
  if (g.mode === "packing") return "Levée de l'ancre en cours";
  return null;
}

function setMode(w: World, u: Unit, mode: GoliathMode, ticks: number): void {
  const g = u.goliath!;
  g.mode = mode;
  g.modeTicks = ticks;
  w.fx.push({ type: "goliathMode", faction: u.faction, id: u.id, mode, x: u.x, y: u.y });
}

/** Dig in where it stands (anchorBlocker permitting): it settles onto the middle of its footprint and stops. */
export function anchor(w: World, u: Unit): boolean {
  if (anchorBlocker(w, u)) return false;
  plant(w, u);
  u.order = { type: "idle" };
  u.path = null;
  u.pathGoal = null;
  setMode(w, u, "anchoring", Math.round(GOLIATH.anchorTime * TICK_RATE));
  return true;
}

/**
 * Settle Goliath `u` onto the middle of its anchor footprint and stamp the
 * footprint into World.occupancy with its id, so paths go round it like a
 * building (and nothing else digs in or is built on it). Paths that ran
 * across it re-plan.
 */
function plant(w: World, u: Unit): void {
  const { tx, ty, size } = anchorFootprint(w, u.faction, u.x, u.y);
  u.x = tx + size / 2;
  u.y = ty + size / 2;
  u.goliath!.foot = { tx, ty };
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++)
      if (inBounds(w, tx + dx, ty + dy) && w.occupancy[(ty + dy) * w.width + tx + dx] === 0) w.occupancy[(ty + dy) * w.width + tx + dx] = u.id;
  const near = (p: { x: number; y: number }) => p.x >= tx - 1 && p.x < tx + size + 1 && p.y >= ty - 1 && p.y < ty + size + 1;
  for (const o of w.units.values()) if (o.path && o.path.some(near)) o.path = null;
}

/** Clear a dug-in Goliath's footprint from World.occupancy (it walks again, or it fell). */
export function unplant(w: World, u: Unit): void {
  const foot = u.goliath?.foot;
  if (!foot) return;
  const size = GOLIATH.footprint;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const i = (foot.ty + dy) * w.width + foot.tx + dx;
      if (inBounds(w, foot.tx + dx, foot.ty + dy) && w.occupancy[i] === u.id) w.occupancy[i] = 0;
    }
  u.goliath!.foot = null;
}

/** Start packing up (anchored or still digging in): it walks again GOLIATH.packTime later. */
export function packUp(w: World, u: Unit): boolean {
  if (packUpBlocker(u)) return false;
  setMode(w, u, "packing", Math.round(GOLIATH.packTime * TICK_RATE));
  return true;
}

/** Apply an `anchor` or `packUp` command (own Goliaths only). */
export function applyGoliathCommand(w: World, c: Extract<Command, { type: "anchor" | "packUp" }>): void {
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (!u || u.faction !== c.faction || !u.goliath) continue;
    if (c.type === "anchor") anchor(w, u);
    else packUp(w, u);
  }
}

/**
 * A move or attack-move just reached Goliath `u` (sim.ts): an anchored one
 * packs up first and walks off once it is free (movement waits for it).
 */
export function orderedToMove(w: World, u: Unit): void {
  const g = u.goliath;
  if (!g || g.lift) return;
  if (g.mode === "anchored" || g.mode === "anchoring") packUp(w, u);
}

// -------------------------------------------------------- build ring ---

/** Distance from (x, y) to the nearest point of a footprint (0 inside). */
export function distToFootprint(tx: number, ty: number, size: number, x: number, y: number): number {
  const dx = Math.max(tx - x, 0, x - (tx + size));
  const dy = Math.max(ty - y, 0, y - (ty + size));
  return hypot(dx, dy);
}

/**
 * Is a `size`² footprint at top-left (tx, ty) in the build ring of one of
 * `faction`'s anchored Goliaths (its footprint within GOLIATH.buildRing of
 * the Goliath's centre)?
 */
export function inGoliathRing(w: World, faction: Faction, tx: number, ty: number, size: number): boolean {
  for (const u of w.units.values())
    if (u.faction === faction && isAnchored(u) && distToFootprint(tx, ty, size, u.x, u.y) <= GOLIATH.buildRing) return true;
  return false;
}

/** Does a `size`² footprint at (tx, ty) overlap the body of a Goliath on the ground (any side)? */
export function overlapsGoliath(w: World, tx: number, ty: number, size: number): boolean {
  for (const u of w.units.values())
    if (u.goliath && !isLifted(u) && distToFootprint(tx, ty, size, u.x, u.y) < UNITS.goliath.radius) return true;
  return false;
}

// ----------------------------------------------------------- training ---

/** An anchored Goliath of `faction` with this id that can train (null: none). */
export function goliathTrainer(w: World, id: number, faction: Faction): Unit | null {
  const u = w.units.get(id);
  return u && u.faction === faction && u.goliath ? u : null;
}

/** Can an anchored Goliath train this kind? (Robot infantry: what an Assembly Bay builds.) */
export const trainable = (kind: UnitKind): boolean => UNITS[kind].builtAt === "assembly-bay";

/** Can an anchored Goliath build this kind in this match? Robot infantry, and under Nomads or Goliath Armada Harvesters too (no HQ to build them). */
export const trainableAt = (w: World, kind: UnitKind): boolean => trainable(kind) || (kind === "harvester" && goliathBase(w));

// ------------------------------------------------------------ mutators ---

/**
 * Nomads (createMapWorld, skirmish): each side's HQ is replaced by a Goliath
 * standing anchored where it stood — the base walks. The starting Harvester
 * and squad stay; the Goliath builds Harvesters (trainableAt), takes their
 * scrap and lets buildings go up round it. With no HQ, a side is beaten when
 * its last Goliath falls.
 */
export function nomadStart(w: World): void {
  for (const f of ["blue", "red"] as const) {
    const hq = hqOf(w, f);
    if (!hq) continue;
    const c = buildingCenter(hq);
    removeBuilding(w, hq);
    const g = spawnUnit(w, "goliath", f, c.x, c.y);
    applySpawnRank(w, g); // (Veterans: rank 1, like the starting squads)
    g.goliath!.mode = "anchored";
    plant(w, g);
  }
}

/**
 * Robot Love (per tick, after deaths): the closest pair of enemy Goliaths
 * within GOLIATH.love.range of each other fall in love, and the match ends in
 * a draw there and then (World.love records who and where, for the
 * presentation's canned meeting). A side beaten this same tick stays beaten.
 */
export function tickLove(w: World): void {
  if (!rulesOf(w).robotLove || w.winner) return;
  let best: { a: Unit; b: Unit; d: number } | null = null;
  for (const a of w.units.values()) {
    if (!a.goliath || a.faction !== "blue" || a.hp <= 0) continue;
    for (const b of w.units.values()) {
      if (!b.goliath || b.faction !== "red" || b.hp <= 0) continue;
      const d = hypot(a.x - b.x, a.y - b.y);
      if (d <= GOLIATH.love.range && (!best || d < best.d)) best = { a, b, d };
    }
  }
  if (!best) return;
  const ids: [number, number] = [best.a.id, best.b.id];
  const x = (best.a.x + best.b.x) / 2;
  const y = (best.a.y + best.b.y) / 2;
  w.winner = "draw";
  w.love = { ids, x, y, tick: w.tick };
  w.fx.push({ type: "love", ids, x, y });
}

// --------------------------------------------------------------- tick ---

/**
 * Per tick, after deaths are cleaned up: anchoring and packing count down
 * (an EMP pauses them), and weapon systems go offline below their line and
 * reboot back once repaired GOLIATH.restoreMargin above it (an EMP holds the
 * reboot too).
 */
export function tickGoliaths(w: World): void {
  const rebootTicks = Math.round(GOLIATH.reboot * TICK_RATE);
  for (const u of w.units.values()) {
    const g = u.goliath;
    if (!g || u.hp <= 0) continue;
    if ((g.mode === "anchoring" || g.mode === "packing") && !isStunned(w, u.id) && --g.modeTicks <= 0) {
      if (g.mode === "packing") unplant(w, u); // free to walk: its ground is open again
      setMode(w, u, g.mode === "anchoring" ? "anchored" : "walking", 0);
    }
    const share = u.hp / UNITS[u.kind].hp;
    for (const k of LOSABLE_WEAPONS) {
      const ws = g.weapons[k];
      const line = GOLIATH.weapons[k].lostBelow;
      const ev = (state: "offline" | "rebooting" | "online") =>
        w.fx.push({ type: "goliathWeapon", faction: u.faction, id: u.id, weapon: k, state, x: u.x, y: u.y });
      if (ws.online) {
        if (share >= line) continue;
        ws.online = false;
        ws.reboot = -1;
        ws.targetId = null;
        ev("offline");
      } else if (ws.reboot >= 0) {
        if (share < line) {
          ws.reboot = -1; // knocked back down mid-reboot
          ev("offline");
        } else if (isStunned(w, u.id)) {
          // an EMP holds the reboot (it blocks repair while it lasts)
        } else if (--ws.reboot <= 0) {
          ws.online = true;
          ws.reboot = -1;
          ws.cooldown = 0;
          ev("online");
        }
      } else if (share >= line + GOLIATH.restoreMargin) {
        ws.reboot = rebootTicks;
        ev("rebooting");
      }
    }
  }
}

/** Display name of a weapon system ("Mortars", "Eye laser"…). */
export const weaponName = (k: GoliathWeapon): string => GOLIATH.weapons[k].name;

/** Building kinds that can go up as outposts in a Goliath's build ring (anything but an HQ). */
export const outpostable = (kind: keyof typeof BUILDINGS): boolean => kind !== "hq";

// ------------------------------------------------- queries for planners ---

/**
 * Why a Goliath of `faction` couldn't anchor standing at (x, y), or null when
 * it could: anchorBlocker's ground checks for a spot it hasn't walked to yet
 * (the AI vets a site before the trip). `selfId` is never in its own way.
 */
export function anchorBlockedAt(w: World, faction: Faction, x: number, y: number, selfId = -1): string | null {
  const { tx, ty, size } = anchorFootprint(w, faction, x, y);
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const fx = tx + dx;
      const fy = ty + dy;
      if (!inBounds(w, fx, fy)) return "Hors de la carte";
      if (w.occupancy[fy * w.width + fx] !== 0) return "Bloqué"; // (a building, or another dug-in Goliath)
      if (!TERRAIN[terrainAt(w, fx, fy)].buildable) return "Sol dégagé requis";
    }
  if (blocksObjective(w, tx, ty, size)) return "Bloqué";
  for (const o of w.units.values())
    if (o.id !== selfId && UNITS[o.kind].domain === "ground" && !isLifted(o) && o.x >= tx && o.x < tx + size && o.y >= ty && o.y < ty + size)
      return UNIT_IN_THE_WAY;
  return null;
}

/**
 * Share (0…1) of Goliath `u`'s firepower that can fire right now (weaponReady:
 * online, and not grounded to its machine guns by a lift), by DPS. 0 for
 * anything else. What its threat is worth to the AI.
 */
export function readyFirepower(u: Unit): number {
  if (!u.goliath) return 0;
  let all = 0;
  let up = 0;
  for (const k of GOLIATH_WEAPONS) {
    all += GOLIATH.weapons[k].dps;
    if (weaponReady(u, k)) up += GOLIATH.weapons[k].dps;
  }
  return all > 0 ? up / all : 0;
}
