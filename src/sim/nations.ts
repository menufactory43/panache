/**
 * The nations' mechanics (PANACHE-CONCEPTION.md §1.2, WP1): kind behaviour
 * through `base` (behaves), the nation multipliers (Préfabriqué, Vapeur,
 * radium, coal, holds), the République's Réseau électrique and Réseau TSF,
 * the Empire's Tranchées, and the state the nations' powers leave on the
 * field (Ballon-sonde reveals, Gaz de houille clouds, Pression boosts).
 *
 * Classique never reaches any of this: every helper returns today's number
 * for a side that plays no nation, and the per-tick pass (tickNations) only
 * runs when the match has nations. The new state lives in fields a Classique
 * world never gets (World.nation, Unit.still/entrenched/tsf/overdrive,
 * Building.unpowered), so worldHash only covers them when present.
 */
import { BUILDINGS, ECONOMY, NATIONS, POWERS, ROLES, TICK_RATE, UNITS, type NationStats } from "./balance";
import { inRoster, nationOf, rulesOf } from "./rules";
import type { Building, BuildingKind, Faction, Role, Unit, UnitKind, World } from "./types";
import { hypot } from "./fmath";

// The nations' state, declared onto the shared types from here (types.ts is WP0's registry): plain
// optional fields the renderer and the UI read directly. A Classique world never has any of them.
declare module "./types" {
  interface Unit {
    /** Empire squad: the tick since which it has stood still (Tranchées). Absent while it moves. */
    still?: number;
    /** Empire squad dug in (Tranchées): damage taken × NATIONS.empire.trench.mult. Renderer: sandbags. */
    entrenched?: boolean;
    /** République unit inside the Réseau TSF (a Tour TSF or a Zénith near): faster, sees further. Renderer: aura. */
    tsf?: boolean;
    /** Pression des chaudières: the tick the boost ends (then it overheats: stunned). Renderer: halo. */
    overdrive?: number;
  }
  interface Building {
    /** République building out of the Réseau électrique: no production, no fire. Renderer: crossed bolt. */
    unpowered?: boolean;
  }
  interface World {
    /** The nations' field state (powers' zones, boosts); absent in Classique. */
    nation?: NationState | null;
  }
}

/** A power's lasting zone on the map (public: both sides see it, like a telegraph). */
export interface PowerZone {
  /** The calldown's id. */
  id: number;
  /** Who fired it. */
  faction: Faction;
  x: number;
  y: number;
  radius: number;
  /** Tick it lifts. */
  until: number;
}

export interface NationState {
  /** Ballon-sonde: areas revealed to `faction` (Snipers in Woods included). The balloon is seen by both sides. */
  reveals: PowerZone[];
  /** Gaz de houille: clouds the other side can't see into, nor pick targets in beyond POWERS.gaz.acquire. */
  clouds: PowerZone[];
  /** Where each Empire squad stood last tick (Tranchées: did it move?). */
  pos: Map<number, { x: number; y: number }>;
}

/** The nations' state, made on first use (a nations match only). */
export function nationState(w: World): NationState {
  return (w.nation ??= { reveals: [], clouds: [], pos: new Map() });
}

// ------------------------------------------------------------- behaviour ---

/**
 * Does `kind` behave as `base`? True for the kind itself and for a nation
 * unit whose `base` it is (the Fourgon harvests, the Atelier repairs, the
 * Titan carries squads…). Replaces `kind === "harvester"` style tests.
 */
export const behaves = (kind: UnitKind, base: UnitKind): boolean => kind === base || UNITS[kind].base === base;

/** The same for buildings (the Bobine d'Arsonval is a turret, the Batterie de 47 a SAM site). */
export const buildingBehaves = (kind: BuildingKind, base: BuildingKind): boolean => kind === base || BUILDINGS[kind].base === base;

const CLASSIC_ROLE = new Map<UnitKind, Role>();
for (const [role, kind] of Object.entries(ROLES.classique) as [Role, UnitKind][]) if (!CLASSIC_ROLE.has(kind)) CLASSIC_ROLE.set(kind, role);

/**
 * The kind a side fields for a Classique kind: the kind itself in Classique
 * or when the nation fields it, else the nation's kind for the same role
 * (harvester → Fourgon for the République, trooper → Fusiliers and condor →
 * Titan for the Empire). Starting units, openers and free units go through it.
 */
export function nationKind(w: World, f: Faction, kind: UnitKind): UnitKind {
  const n = nationOf(w, f);
  if (n === "classique" || inRoster(n, kind)) return kind;
  const role = CLASSIC_ROLE.get(kind);
  return role ? ROLES[n][role] : kind;
}

/** The nation's numbers for a side, or null in Classique. */
export function nationStatsOf(w: World, f: Faction): NationStats | null {
  const n = nationOf(w, f);
  return n === "classique" ? null : NATIONS[n];
}

// ----------------------------------------------------------- multipliers ---

/** A harvester's hold (the Fourgon: 80). */
export const holdOf = (kind: UnitKind): number => UNITS[kind].cargo ?? ECONOMY.harvesterCapacity;

/** Scrap per unit of crystal (radium) a side's harvesters mine (République ×1.5). */
export function radiumValue(w: World, f: Faction): number {
  return nationStatsOf(w, f)?.radiumValue ?? ECONOMY.crystalValue;
}

/** Units a side's harvester mines per second on a tile (coal: × the nation's coalRate). */
export function harvestRate(w: World, f: Faction, crystal: boolean): number {
  const n = nationStatsOf(w, f);
  return n && !crystal ? ECONOMY.harvestRate * n.coalRate : ECONOMY.harvestRate;
}

/** What a building costs a side (Préfabriqué ×0.85, the Tour TSF 150 before it; Vapeur ×1.1). */
export function buildingCostFor(w: World, f: Faction, kind: BuildingKind): number {
  const n = nationStatsOf(w, f);
  if (!n) return BUILDINGS[kind].cost;
  const list = kind === "radar" && n.towerCost !== undefined ? n.towerCost : BUILDINGS[kind].cost;
  return Math.round(list * n.buildingCost);
}

/** Ticks a building takes a side to construct. */
export function buildingTicks(w: World, f: Faction, kind: BuildingKind): number {
  const n = nationStatsOf(w, f);
  const t = BUILDINGS[kind].buildTime * TICK_RATE;
  return n ? t * n.buildingTime : t;
}

/** A building's max HP for its side (Préfabriqué ×0.8, Vapeur ×1.25). */
export function buildingMaxHpOf(w: World, f: Faction, kind: BuildingKind): number {
  const n = nationStatsOf(w, f);
  return n ? Math.round(BUILDINGS[kind].hp * n.buildingHp) : BUILDINGS[kind].hp;
}

/** A standing building's max HP. Read this, not BUILDINGS[kind].hp, for health bars and repair. */
export const buildingMaxHp = (w: World, b: Building): number => buildingMaxHpOf(w, b.faction, b.kind);

/** Ticks a unit takes a side to build (Préfabriqué ×0.85, Vapeur ×1.3). */
export function unitTicks(w: World, f: Faction, kind: UnitKind): number {
  const n = nationStatsOf(w, f);
  const t = UNITS[kind].buildTime * TICK_RATE;
  return n ? t * n.unitTime : t;
}

/** Queue items a side's factories build at once (Vapeur: 2). */
export const parallelOf = (w: World, f: Faction): number => nationStatsOf(w, f)?.parallel ?? 1;

// ---------------------------------------------------- Réseau électrique ---

/** A source of the Réseau électrique / TSF: where it stands and how far it reaches. */
export interface PowerSource {
  id: number;
  x: number;
  y: number;
  radius: number;
}

/** Does a République building of this kind need the Réseau électrique? (Not the GQG nor a Tour TSF.) */
export const needsPower = (kind: BuildingKind): boolean => kind !== "hq" && kind !== "radar";

/** Is the network a rule for this side (the République)? */
export const onGrid = (w: World, f: Faction): boolean => !!nationStatsOf(w, f)?.power;

/** A moored Zénith (WP2: anchored like a Goliath) counts as a source of both networks. */
const mooredZenith = (u: Unit): boolean => u.kind === "zenith" && u.goliath?.mode === "anchored";

/**
 * A side's Réseau électrique sources: each GQG (NATIONS.republique.power.hqRadius
 * from its centre), each Tour TSF (towerRadius) and each moored Zénith (towerRadius).
 * Empty for a side not on the grid.
 */
export function powerSources(w: World, f: Faction): PowerSource[] {
  const p = nationStatsOf(w, f)?.power;
  if (!p) return [];
  const out: PowerSource[] = [];
  for (const b of w.buildings.values()) {
    if (b.faction !== f || (b.kind !== "hq" && b.kind !== "radar")) continue;
    const s = BUILDINGS[b.kind].size;
    out.push({ id: b.id, x: b.tx + s / 2, y: b.ty + s / 2, radius: b.kind === "hq" ? p.hqRadius : p.towerRadius });
  }
  for (const u of w.units.values()) if (u.faction === f && mooredZenith(u)) out.push({ id: u.id, x: u.x, y: u.y, radius: p.towerRadius });
  return out;
}

/** Distance from a point to a size² footprint at top-left (tx, ty) (0 inside). */
function toFootprint(tx: number, ty: number, size: number, x: number, y: number): number {
  const dx = Math.max(tx - x, 0, x - (tx + size));
  const dy = Math.max(ty - y, 0, y - (ty + size));
  return hypot(dx, dy);
}

/** Would a footprint of `kind` at (tx, ty) be fed by one of the side's sources? */
export function inPowerRange(w: World, f: Faction, kind: BuildingKind, tx: number, ty: number, sources = powerSources(w, f)): boolean {
  const size = BUILDINGS[kind].size;
  return sources.some((s) => toFootprint(tx, ty, size, s.x, s.y) <= s.radius);
}

/** Is this building cut off the Réseau électrique (no production, no fire)? */
export const isUnpowered = (b: Building): boolean => b.unpowered === true;

/** Once a second: every République building that needs power is fed, or goes dark (Building.unpowered). */
function tickPower(w: World): void {
  for (const f of ["blue", "red"] as const) {
    if (!onGrid(w, f)) continue;
    const sources = powerSources(w, f);
    for (const b of w.buildings.values()) {
      if (b.faction !== f || !needsPower(b.kind)) continue;
      if (inPowerRange(w, f, b.kind, b.tx, b.ty, sources)) delete b.unpowered;
      else b.unpowered = true;
    }
  }
}

// ---------------------------------------------------------- Réseau TSF ---

/** A side's Réseau TSF sources: its Tours TSF and its Zéniths (moored or not), NATIONS.republique.tsf.radius. */
export function tsfSources(w: World, f: Faction): PowerSource[] {
  const t = nationStatsOf(w, f)?.tsf;
  if (!t) return [];
  const out: PowerSource[] = [];
  for (const b of w.buildings.values())
    if (b.faction === f && b.kind === "radar") {
      const s = BUILDINGS.radar.size;
      out.push({ id: b.id, x: b.tx + s / 2, y: b.ty + s / 2, radius: t.radius });
    }
  for (const u of w.units.values()) if (u.faction === f && u.kind === "zenith") out.push({ id: u.id, x: u.x, y: u.y, radius: t.radius });
  return out;
}

/** Once a second: République units near a source are in the Réseau TSF (Unit.tsf). */
function tickTsf(w: World): void {
  for (const f of ["blue", "red"] as const) {
    if (!nationStatsOf(w, f)?.tsf) continue;
    const sources = tsfSources(w, f);
    for (const u of w.units.values()) {
      if (u.faction !== f) continue;
      if (sources.some((s) => s.id !== u.id && hypot(u.x - s.x, u.y - s.y) <= s.radius)) u.tsf = true;
      else delete u.tsf;
    }
  }
}

/** Speed multiplier from the nations' effects (Réseau TSF, Pression): 1 for every Classique unit. */
export function speedMult(u: Unit): number {
  let m = 1;
  if (u.tsf) m *= NATIONS.republique.tsf?.speed ?? 1;
  if (u.overdrive !== undefined) m *= POWERS.pression.speed;
  return m;
}

/** Extra sight (tiles) from the Réseau TSF. */
export const sightBonus = (u: Unit): number => (u.tsf ? NATIONS.republique.tsf?.sight ?? 0 : 0);

/** Fire-rate multiplier (Pression des chaudières). */
export const fireRateMult = (u: Unit): number => (u.overdrive !== undefined ? POWERS.pression.fireRate : 1);

// ------------------------------------------------------------ Tranchées ---

/** Empire squads that stood still `trench.still` s, or at once by an own Hotchkiss, dig in (Unit.entrenched). */
function tickTrenches(w: World, st: NationState): void {
  const pos = new Map<number, { x: number; y: number }>();
  for (const f of ["blue", "red"] as const) {
    const t = nationStatsOf(w, f)?.trench;
    if (!t) continue;
    const redoubts: { x: number; y: number }[] = [];
    for (const b of w.buildings.values())
      if (b.faction === f && buildingBehaves(b.kind, "turret")) redoubts.push({ x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 });
    for (const u of w.units.values()) {
      if (u.faction !== f || !UNITS[u.kind].squad) continue;
      const last = st.pos.get(u.id);
      pos.set(u.id, { x: u.x, y: u.y });
      const ordered = u.order.type === "move" || u.order.type === "attackMove" || u.order.type === "board";
      const moved = !last || Math.abs(last.x - u.x) > 0.02 || Math.abs(last.y - u.y) > 0.02;
      if (ordered || moved) {
        delete u.still;
        delete u.entrenched;
        continue;
      }
      u.still ??= w.tick;
      const dug = w.tick - u.still >= Math.round(t.still * TICK_RATE) || redoubts.some((r) => hypot(r.x - u.x, r.y - u.y) <= t.redoubtRadius);
      if (dug) u.entrenched = true;
      else delete u.entrenched;
    }
  }
  st.pos = pos;
}

/** Damage-taken multiplier from cover for a unit (Woods `cover`, or its trench: the better of the two, never both). */
export function trenchCover(w: World, u: Unit, cover: number): number {
  if (!u.entrenched) return cover;
  const t = nationStatsOf(w, u.faction)?.trench;
  return t ? Math.min(cover, t.mult) : cover;
}

// ---------------------------------------------------------- power zones ---

/** Is (x, y) in a Ballon-sonde reveal of `faction`'s? */
export function revealedTo(w: World, f: Faction, x: number, y: number): boolean {
  const z = w.nation?.reveals;
  return !!z && z.some((r) => r.faction === f && hypot(x - r.x, y - r.y) <= r.radius);
}

/**
 * Gaz de houille: is (x, y) — `d` tiles from a shooter of `faction` — hidden
 * in a cloud of the other side's, too far (> POWERS.gaz.acquire) to pick out?
 */
export function veiled(w: World, f: Faction, x: number, y: number, d: number): boolean {
  const z = w.nation?.clouds;
  if (!z || z.length === 0 || d <= POWERS.gaz.acquire) return false;
  return z.some((c) => c.faction !== f && hypot(x - c.x, y - c.y) <= c.radius);
}

/** A unit of `faction`: is it boosted by Pression? (Kind test: own ground vehicles, not squads.) */
export const pressurised = (u: Unit): boolean => UNITS[u.kind].domain === "ground" && !UNITS[u.kind].squad;

// ----------------------------------------------------------------- tick ---

/**
 * The nations' per-tick pass (sim.ts, before production and combat; a
 * nations match only): zones and boosts expire (a boost ends in overheat:
 * stunned POWERS.pression.overheat s), the networks are re-checked once a
 * second, and Empire squads dig in.
 */
export function tickNations(w: World): void {
  if (!rulesOf(w).nations) return;
  const st = nationState(w);
  if (st.reveals.length) st.reveals = st.reveals.filter((z) => z.until > w.tick);
  if (st.clouds.length) st.clouds = st.clouds.filter((z) => z.until > w.tick);
  for (const u of w.units.values()) {
    if (u.overdrive === undefined || u.overdrive > w.tick) continue;
    delete u.overdrive;
    const until = w.tick + Math.round(POWERS.pression.overheat * TICK_RATE);
    w.powers.stunned.set(u.id, Math.max(until, w.powers.stunned.get(u.id) ?? 0));
    w.fx.push({ type: "stun", faction: u.faction, ids: [u.id], x: u.x, y: u.y, until });
  }
  if (w.tick % TICK_RATE === 0) {
    tickPower(w);
    tickTsf(w);
  }
  tickTrenches(w, st);
}

/**
 * A nations match's starting forces (maps.ts createMapWorld, once the rules
 * are in): each side's harvester and Trooper Squad become its nation's worker
 * and line squad (République: Fourgon and pioupious; Empire: Fardier and
 * Fusiliers), and every building takes its nation's max HP.
 */
export function nationStart(w: World): void {
  if (!rulesOf(w).nations) return;
  nationState(w);
  for (const u of w.units.values()) {
    const kind = nationKind(w, u.faction, u.kind);
    if (kind === u.kind) continue;
    u.kind = kind;
    u.hp = UNITS[kind].hp;
    if (UNITS[kind].capacity) u.passengers ??= [];
  }
  for (const b of w.buildings.values()) b.hp = buildingMaxHp(w, b);
}
