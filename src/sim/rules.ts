import { BUILDINGS, COMBAT, ECONOMY, NATIONS, NATION_IDS, ROSTERS, UNITS } from "./balance";
import type { Strategy } from "./ai/commander";
import type { BuildingKind, Faction, Nation, NationOrClassic, PowerKind, Unit, UnitKind, World } from "./types";
import { tr } from "../lang";

/**
 * Match rules and the mutators that change them. `World.rules` is absent
 * (or identity) in a classic match; every hook below reads through
 * `rulesOf(w)`, so a world without rules plays exactly as before.
 *
 * Mutators are picked on the menu (or by the Daily Op) and apply to BOTH
 * sides: the AI obeys them through the same blockers and multipliers.
 */

export type MutatorId =
  | "blitz"
  | "goldrush"
  | "glass"
  | "rapidfab"
  | "airwar"
  | "infantrywar"
  | "airborne"
  | "veterans"
  | "clearskies"
  | "nomads"
  | "robotlove"
  | "armada";

export interface Rules {
  /** Scrap each side starts with. */
  startScrap: number;
  /**
   * Multiplier on harvested scrap and HQ trickle, on top of
   * `FactionState.incomeMult` (which the AI rewrites every tick).
   */
  incomeMult: number;
  /** Build progress per tick: 2 = units and buildings take half the time. */
  buildSpeed: number;
  /** Multiplier on every weapon's damage. */
  dmgMult: number;
  bannedUnits: UnitKind[];
  bannedBuildings: BuildingKind[];
  /** No fog of war for either side. */
  fogOff: boolean;
  /** Veterancy rank that produced combat units start at. */
  startRank: number;
  /** Units each side starts with beside its HQ, on top of the classic harvester and Trooper Squad. */
  startUnits: UnitKind[];
  /** The mutators these rules came from, in canonical order (display, career). */
  mutators: MutatorId[];
  /** Ops: bans for one side only (e.g. "air only" for the player), on top of the shared ones. */
  sideBans?: Partial<Record<Faction, { units?: UnitKind[]; buildings?: BuildingKind[]; powers?: PowerKind[] }>>;
  /** Ops: per-side income multiplier on top of `incomeMult` (0 = a frozen economy). */
  sideIncome?: Partial<Record<Faction, number>>;
  /** What a ban no mutator explains says ("Disabled in this op"); default "Disabled: match rules". */
  banLabel?: string;
  /**
   * Ops: no commander calldowns for either side — for an op whose puzzle is
   * a fixed strike group or a fixed budget (a free Drop Pod would break it).
   */
  noCalldowns?: boolean;
  /** The map's HQ trickle, scrap/s (default ECONOMY.hqTrickle). */
  hqTrickle?: number;
  /** The map hands a side with no Condor a free one (lifeline.ts). */
  lifeline?: boolean;
  /**
   * The map has islands only a Condor can reach: buildings, production and
   * Drop Pods stay on land joined to the side's HQ (world.ts onHomeLand).
   */
  islands?: boolean;
  /**
   * Nomads: each side starts with an anchored Goliath where its HQ would
   * stand, and no HQ. Anchored Goliaths also build Harvesters (goliath.ts
   * trainableAt); every building is an outpost of one.
   */
  nomads?: boolean;
  /** Robot Love: two enemy Goliaths within GOLIATH.love.range fall in love and the match is a draw (goliath.ts tickLove). */
  robotLove?: boolean;
  /**
   * Goliath Armada: each side starts with GOLIATH.armada.count Goliaths in
   * the air, each carried by two Condors, and nothing else: no HQ, no
   * Harvester, no squad, no opener (goliath.ts armadaStart). As under Nomads,
   * anchored Goliaths also build Harvesters and every building is an outpost.
   */
  armada?: boolean;
  /**
   * Island maps: the tile at the centre of each side's starting HQ, so home
   * land is still known once the HQ has fallen (or, under Nomads, was never
   * built) and the side plays on round a Goliath (world.ts onHomeLand).
   */
  homeTiles?: Record<Faction, [number, number]>;
  /**
   * The nation each side plays (PANACHE-CONCEPTION.md §1.10): both sides, or
   * absent (Classique). Read through nationOf(w, f).
   */
  nations?: Record<Faction, Nation>;
}

export const DEFAULT_RULES: Readonly<Rules> = Object.freeze({
  startScrap: ECONOMY.startingScrap,
  incomeMult: 1,
  buildSpeed: 1,
  dmgMult: 1,
  bannedUnits: [],
  bannedBuildings: [],
  fogOff: false,
  startRank: 0,
  startUnits: [],
  mutators: []
});

export interface MutatorDef {
  id: MutatorId;
  name: string;
  icon: string;
  /** One line for the menu sheet. */
  desc: string;
  apply(r: Rules): void;
  bansUnits?: UnitKind[];
  bansBuildings?: BuildingKind[];
  /** Mutators that make no sense together with this one. */
  conflicts?: MutatorId[];
}

/**
 * Ground combat units: the tanks, the robot infantry squads and the Goliath
 * (Classique's first, then the nations' own: a Classique world never meets
 * those, they are banned there anyway).
 */
export const GROUND_COMBAT: UnitKind[] = [
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "trooper", "rocket-squad", "sniper", "goliath",
  "jamais-contente", "de-dion", "branly", "sapeurs", "mortier-280", "fusiliers", "carabiniers"
];

/**
 * What "no ground combat" bans (Air War, Sky Pirates): GROUND_COMBAT, and the
 * Condor — the starting Trooper Squad is kept to guard home, and a dropship
 * would fly it into the fight.
 */
export const NO_GROUND_COMBAT: UnitKind[] = [...GROUND_COMBAT, "condor", "titan"];

/** Robot infantry: the squads an Assembly Bay builds. */
export const INFANTRY_SQUADS: UnitKind[] = ["trooper", "rocket-squad", "sniper", "sapeurs", "fusiliers", "carabiniers"];

/**
 * What Infantry War bans: every combat vehicle and combat aircraft. Harvesters,
 * Scouts, Menders and the Condor stay (none of them fights).
 */
export const NO_VEHICLES: UnitKind[] = [
  ...GROUND_COMBAT.filter((k) => !INFANTRY_SQUADS.includes(k)),
  "wasp",
  "raptor",
  "hornet",
  "gyroptere",
  "epervier",
  "vulcain",
  "zenith"
];

export const MUTATORS: Record<MutatorId, MutatorDef> = {
  blitz: {
    id: "blitz",
    name: "Blitz",
    icon: "⚡",
    desc: tr("Chaque camp démarre avec 3 000 de charbon", "Each side starts with 3,000 coal"),
    apply: (r) => (r.startScrap = 3000)
  },
  goldrush: {
    id: "goldrush",
    name: tr("Ruée vers l'or", "Gold Rush"),
    icon: "💰",
    desc: tr("Récolte et revenu du GQG ×1,5", "Harvesting and GHQ income ×1.5"),
    apply: (r) => (r.incomeMult *= 1.5)
  },
  glass: {
    id: "glass",
    name: tr("Canons de verre", "Glass Cannons"),
    icon: "💥",
    desc: tr("Toutes les armes infligent double dégâts", "Every weapon deals double damage"),
    apply: (r) => (r.dmgMult *= 2)
  },
  rapidfab: {
    id: "rapidfab",
    name: tr("Production éclair", "Lightning Production"),
    icon: "🔧",
    desc: tr("Unités et bâtiments construits deux fois plus vite", "Units and buildings built twice as fast"),
    apply: (r) => (r.buildSpeed *= 2)
  },
  airwar: {
    id: "airwar",
    name: tr("Guerre aérienne", "Air War"),
    icon: "✈️",
    // SAM sites go too: measured, aircraft-only armies never crack a SAM line (every
    // AI-vs-AI Air War drew at 25:00); turrets and the HQ gun still shoot back.
    // Infantry and their Assembly Bay are ground combat too (the starting squad stays home,
    // so no Condor either: NO_GROUND_COMBAT)
    desc: tr("Ni unités terrestres de combat, ni Montgolfières, Forges, Manufactures ou Batteries Ruggieri : les duels aériens décident", "No ground combat units, Montgolfier Balloons, Forges, Manufactories or Ruggieri Batteries: aerial duels decide"),
    bansUnits: NO_GROUND_COMBAT,
    // (and no Goliath, which Nomads, Robot Love and Goliath Armada are about)
    conflicts: ["infantrywar", "airborne", "nomads", "robotlove", "armada"],
    bansBuildings: ["fab-plant", "assembly-bay", "sam-site"],
    apply: (r) => {
      r.bannedUnits.push(...NO_GROUND_COMBAT);
      r.bannedBuildings.push("fab-plant", "assembly-bay", "sam-site");
    }
  },
  infantrywar: {
    id: "infantrywar",
    name: tr("Guerre d'infanterie", "Infantry War"),
    icon: "🤖",
    // the Airpad stays for Condors, Scouts and Menders; Turrets and SAM sites stay too
    // (Rocket Squads crack them, and SAMs are the answer to Condor drops)
    desc: tr("Infanterie seule : ni véhicules, ni appareils de combat, ni Forges", "Infantry only: no vehicles, no combat aircraft, no Forges"),
    bansUnits: NO_VEHICLES,
    bansBuildings: ["fab-plant"],
    conflicts: ["airwar", "nomads", "robotlove", "armada"],
    apply: (r) => {
      r.bannedUnits.push(...NO_VEHICLES);
      r.bannedBuildings.push("fab-plant");
    }
  },
  airborne: {
    id: "airborne",
    name: tr("Aéroportés", "Airborne"),
    icon: "🪂",
    // the classic start already has the Trooper Squad: this adds the other two and a ride
    desc: tr("Chaque camp démarre avec une Montgolfière et une escouade de chaque type", "Each side starts with a Montgolfier Balloon and one squad of each type"),
    // (Goliath Armada starts with nothing but its Goliaths and their Condors)
    conflicts: ["airwar", "armada"],
    apply: (r) => {
      for (const k of ["condor", "rocket-squad", "sniper"] as const) if (!r.startUnits.includes(k)) r.startUnits.push(k);
    }
  },
  veterans: {
    id: "veterans",
    name: tr("Vétérans", "Veterans"),
    icon: "🎖️",
    desc: tr("Les unités de combat sortent au rang 1 (+15 % de dégâts)", "Combat units roll out at rank 1 (+15% damage)"),
    apply: (r) => (r.startRank = Math.max(r.startRank, 1))
  },
  clearskies: {
    id: "clearskies",
    name: tr("Ciel dégagé", "Clear Skies"),
    icon: "☀️",
    desc: tr("Pas de brouillard de guerre : chaque camp voit tout", "No fog of war: each side sees everything"),
    apply: (r) => (r.fogOff = true)
  },
  nomads: {
    id: "nomads",
    name: tr("Nomades", "Nomads"),
    icon: "🦿",
    // the base walks: anchored, it takes scrap, builds Harvesters and squads, and buildings go up round it
    desc: tr("Chaque camp démarre avec un Gargantua au lieu d'une base", "Each side starts with a Gargantua instead of a base"),
    conflicts: ["airwar", "infantrywar", "armada"],
    apply: (r) => (r.nomads = true)
  },
  robotlove: {
    id: "robotlove",
    name: tr("Amour mécanique", "Robot Love"),
    icon: "💘",
    desc: tr("Deux Gargantuas ennemis qui se croisent tombent amoureux : match nul", "Two enemy Gargantuas that cross paths fall in love: a draw"),
    conflicts: ["airwar", "infantrywar"],
    apply: (r) => (r.robotLove = true)
  },
  armada: {
    id: "armada",
    name: tr("Armada de Gargantuas", "Gargantua Armada"),
    icon: "🚁",
    // no base at all: anchored, the Goliaths build Harvesters and squads, and buildings go up round them
    desc: tr("Chaque camp démarre avec quatre Gargantuas en vol, portés chacun par deux Montgolfières, et rien d'autre", "Each side starts with four airborne Gargantuas, each carried by two Montgolfier Balloons, and nothing else"),
    // (Air War and Infantry War ban the Goliath; Nomads and Airborne start a side some other way)
    conflicts: ["airwar", "infantrywar", "airborne", "nomads"],
    apply: (r) => (r.armada = true)
  }
};

/** Canonical display order. */
export const MUTATOR_IDS = Object.keys(MUTATORS) as MutatorId[];

export const isMutatorId = (s: unknown): s is MutatorId => typeof s === "string" && s in MUTATORS;

/** Do these mutators all work together? */
export function mutatorsCompatible(ids: readonly MutatorId[]): boolean {
  for (const a of ids) for (const b of ids) if (a !== b && MUTATORS[a].conflicts?.includes(b)) return false;
  return true;
}

/**
 * The picker's toggle: `id` off if it is on, else on — switching off any
 * mutator it can't run with (Air War and the infantry ones). Canonical order.
 */
export function toggleMutator(on: readonly MutatorId[], id: MutatorId): MutatorId[] {
  const keep = on.includes(id) ? on.filter((m) => m !== id) : [...on.filter((m) => mutatorsCompatible([id, m])), id];
  return MUTATOR_IDS.filter((m) => keep.includes(m));
}

/**
 * Rules for a set of mutators (deduplicated, unknown ids ignored; of two that
 * conflict, the first in canonical order wins and the other is left out).
 */
export function makeRules(ids: readonly MutatorId[]): Rules {
  const r: Rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], startUnits: [], mutators: [] };
  for (const id of MUTATOR_IDS)
    if (ids.includes(id) && !r.mutators.some((m) => MUTATORS[m].conflicts?.includes(id))) {
      MUTATORS[id].apply(r);
      r.mutators.push(id);
    }
  return r;
}

/**
 * Install a match's mutators and nations (createMapWorld calls this before
 * the first tick). Neither: no rules at all, Classique as it always was.
 */
export function applyMutators(w: World, ids: readonly MutatorId[], nations?: Partial<Record<Faction, Nation>> | null): void {
  const n = matchNations(nations);
  const r = makeRules(ids.filter((id) => isMutatorId(id) && !nationBansMutator(id, n)));
  if (n) r.nations = n;
  if (r.mutators.length === 0 && !n) return;
  w.rules = r;
  for (const f of Object.values(w.factions)) f.scrap = r.startScrap;
}

/**
 * Does a match's nations rule out this mutator? Nomads and Goliath Armada
 * stand on the Gargantua, so in v1 they are Classique or Empire only (§1.10):
 * no République on either side.
 */
export function nationBansMutator(id: MutatorId, nations: Partial<Record<Faction, Nation>> | null | undefined): boolean {
  return (id === "nomads" || id === "armada") && !!nations && (nations.blue === "republique" || nations.red === "republique");
}

export const rulesOf = (w: World): Readonly<Rules> => w.rules ?? DEFAULT_RULES;

// ------------------------------------------------------------- nations ---

export const isNation = (s: unknown): s is Nation => typeof s === "string" && (NATION_IDS as string[]).includes(s);

/**
 * A match's nations: both sides', or null (Classique) — there is no
 * Classique-against-a-nation match (§1.10), so a half-given pair is dropped.
 */
export function matchNations(n: Partial<Record<Faction, unknown>> | null | undefined): Record<Faction, Nation> | null {
  return n && isNation(n.blue) && isNation(n.red) ? { blue: n.blue, red: n.red } : null;
}

/**
 * "republique,empire" (blue's, then red's; "rep"/"emp" will do) → the pair,
 * or null. The dev URL `?nations=…` and tools read nations this way.
 */
export function parseNations(s: string | null | undefined): Record<Faction, Nation> | null {
  const alias = (x: string): string => ({ rep: "republique", "république": "republique", emp: "empire" })[x] ?? x;
  const [blue, red] = (s ?? "").toLowerCase().split(",").map((x) => alias(x.trim()));
  return matchNations({ blue, red });
}

/** The nation `f` plays, or "classique". */
export const nationOf = (w: World, f: Faction): NationOrClassic => rulesOf(w).nations?.[f] ?? "classique";

/** The nation that alone fields a kind (a new unit or defence), or null for the 26 Classique kinds. */
export const kindNation = (kind: UnitKind | BuildingKind): Nation | null =>
  (kind in UNITS ? UNITS[kind as UnitKind].nation : BUILDINGS[kind as BuildingKind].nation) ?? null;

/** Does `nation` field this kind? (Classique: every kind that belongs to no nation.) */
export function inRoster(nation: NationOrClassic, kind: UnitKind | BuildingKind): boolean {
  if (nation === "classique") return kindNation(kind) === null;
  const r = ROSTERS[nation];
  return kind in UNITS ? r.units.includes(kind as UnitKind) : r.buildings.includes(kind as BuildingKind);
}

/**
 * Why a kind is outside a side's roster (null = it's in it): in Classique,
 * every nation's own kind; with nations, all the other nation fields. Without
 * `faction` in a nations match, only a kind neither side fields.
 */
export function rosterBan(w: World, kind: UnitKind | BuildingKind, faction?: Faction): string | null {
  const nations = rulesOf(w).nations;
  const reserved = (n: Nation | null) => (n ? tr(`Réservé à ${NATIONS[n].name}`, `Reserved for ${NATIONS[n].name}`) : tr("Désactivé : règles de la partie", "Disabled: match rules"));
  if (!nations) {
    const own = kindNation(kind);
    return own ? reserved(own) : null;
  }
  const allowed = faction ? [nations[faction]] : [nations.blue, nations.red];
  if (allowed.some((n) => inRoster(n, kind))) return null;
  return reserved(NATION_IDS.find((n) => inRoster(n, kind)) ?? null);
}

/** Nomads and Goliath Armada: no HQ is ever built, and a side's Goliaths are its base. */
export const goliathBase = (w: World): boolean => !!(rulesOf(w).nomads || rulesOf(w).armada);

/** True when any mutator is active (career: no map stars). */
export const isMutated = (w: World): boolean => rulesOf(w).mutators.length > 0;

/** Total income multiplier for a faction: AI handicap × mutators (× an op's per-side factor). */
export const incomeOf = (w: World, f: Faction): number => {
  const r = rulesOf(w);
  return w.factions[f].incomeMult * r.incomeMult * (r.sideIncome?.[f] ?? 1);
};

/**
 * Why a kind is disabled by this match's rules (null = allowed): outside the
 * side's roster (rosterBan: a nation's own kinds in Classique, the other
 * nation's with nations), a mutator for both sides, or (with `faction`) an
 * op's ban on that side alone.
 */
export function bannedBy(w: World, kind: UnitKind | BuildingKind, faction?: Faction): string | null {
  const roster = rosterBan(w, kind, faction);
  if (roster) return roster;
  const r = rulesOf(w);
  const isUnit = kind in UNITS;
  const inList = (units?: readonly UnitKind[], buildings?: readonly BuildingKind[]) =>
    isUnit ? !!units?.includes(kind as UnitKind) : !!buildings?.includes(kind as BuildingKind);
  const side = faction ? r.sideBans?.[faction] : undefined;
  if (!inList(r.bannedUnits, r.bannedBuildings) && !inList(side?.units, side?.buildings)) return null;
  const by = r.mutators.find((id) => inList(MUTATORS[id].bansUnits, MUTATORS[id].bansBuildings));
  return by ? tr(`Désactivé : ${MUTATORS[by].name}`, `Disabled: ${MUTATORS[by].name}`) : r.banLabel ?? tr("Désactivé : règles de la partie", "Disabled: match rules");
}

/** Veterans mutator: a freshly built combat unit starts ranked (with the XP to match). */
export function applySpawnRank(w: World, u: Unit): void {
  const rank = Math.min(COMBAT.rankXp.length, rulesOf(w).startRank);
  if (rank <= 0 || UNITS[u.kind].dps <= 0 || u.rank >= rank) return;
  u.rank = rank;
  u.xp = Math.max(u.xp, COMBAT.rankXp[rank - 1]! * UNITS[u.kind].cost);
}

/**
 * Is robot infantry this side's whole army? No Fab Plant and no combat
 * aircraft, but an Assembly Bay (Infantry War, or an op's bans to match):
 * the AI then builds Bays where its plan says Fab Plant (ai/commander.ts).
 */
export function infantryArmy(w: World, f: Faction): boolean {
  return bannedBy(w, "fab-plant", f) !== null && bannedBy(w, "wasp", f) !== null && bannedBy(w, "assembly-bay", f) === null;
}

/**
 * Can an AI personality play its plan under these rules? (An air-only
 * commander needs an Airpad and aircraft to build there; a tank plan needs
 * the Fab Plant; a ground-raid plan needs it too, or under Infantry War an
 * Assembly Bay to field its early army instead. Measured: Ironclad, playing
 * Infantry War from Bays, won 20% of 100 AI-vs-AI games; Rush 40%.)
 */
export function strategyFits(s: Strategy, r: Readonly<Rules>): boolean {
  if (s.airOnly && (r.bannedBuildings.includes("airpad") || r.bannedUnits.includes("wasp"))) return false;
  if (s.heavy && r.bannedBuildings.includes("fab-plant")) return false;
  if (s.groundRaids && r.bannedBuildings.includes("fab-plant") && r.bannedBuildings.includes("assembly-bay")) return false;
  return true;
}
