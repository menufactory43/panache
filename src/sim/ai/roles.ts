import { BUILDINGS, NATIONS, ROLES, UNITS } from "../balance";
import { anchoredGoliaths, distToFootprint } from "../goliath";
import { nationOf } from "../rules";
import type { BuildingKind, Faction, NationOrClassic, Role, UnitKind, World } from "../types";
import { buildingCenter } from "../world";

/**
 * The commander's roles (PANACHE-CONCEPTION.md §1.9): the AI never names a
 * unit kind, it names what it wants done — a light tank, anti-air, a siege
 * gun — and its nation's roster (ROLES in balance.ts) says which kind does
 * it. Classique reads the "classique" row, which names today's kinds, so a
 * Classique commander asks for exactly what it always did.
 *
 * `AiKinds` is that table turned into the slots commander.ts and its helpers
 * actually fill: some of them derived (the anti-air a Tech Lab unlocks,
 * where the scout and the healer are built), all of them per nation.
 */

export type { Role };

/** The behaviour a kind reuses (§0 principle 3): its `base`, else itself. */
export const baseOf = (kind: UnitKind): UnitKind => UNITS[kind].base ?? kind;

/** Does `kind` behave as `base` (a Fourgon as a harvester, a Titan as a Condor)? */
export const behaves = (kind: UnitKind, base: UnitKind): boolean => kind === base || UNITS[kind].base === base;

/** Every unit kind, Classique's first (the order of UNITS). */
const ALL_UNITS = Object.keys(UNITS) as UnitKind[];

/**
 * A shared building kind as a nation builds it (§1.9 "buildingFor"): the
 * République has no Hotchkiss (its ground defence is the Bobine d'Arsonval),
 * the Empire no Ruggieri (its anti-air is the Batterie de 47).
 */
export function buildingFor(nation: NationOrClassic, kind: BuildingKind): BuildingKind {
  if (nation === "republique" && kind === "turret") return "arsonval";
  if (nation === "empire" && kind === "sam-site") return "flak-battery";
  return kind;
}

/** Armed defences, every nation's: ground (Hotchkiss, Bobine) and anti-air (Ruggieri, Batterie de 47). */
export const GROUND_DEFENCES: readonly BuildingKind[] = ["turret", "arsonval"];
export const AA_DEFENCES: readonly BuildingKind[] = ["sam-site", "flak-battery"];
export const isDefence = (kind: BuildingKind): boolean => GROUND_DEFENCES.includes(kind) || AA_DEFENCES.includes(kind);
export const isGroundDefence = (kind: BuildingKind): boolean => GROUND_DEFENCES.includes(kind);

/** The slots the commander fills, by nation. */
export interface AiKinds {
  nation: NationOrClassic;
  roles: Readonly<Record<Role, UnitKind>>;
  /** What it builds to mine, and every kind that mines (a nation's start may hand it another's harvester). */
  worker: UnitKind;
  workers: readonly UnitKind[];
  scout: UnitKind;
  /** Where the scout is built (the République's Patrie at the Airpad, the Empire's Estafette at the Forges). */
  scoutAt: BuildingKind;
  /** Every scout kind (its own, and a starting one of another roster). */
  scouts: readonly UnitKind[];
  light: UnitKind;
  aa: UnitKind;
  /** Ground anti-air a Tech Lab unlocks (Classique: the Lancer), else the plain anti-air. */
  techAA: UnitKind;
  artillery: UnitKind;
  siege: UnitKind;
  heavy: UnitKind;
  antiArmour: UnitKind;
  /** The armour-piercer a Tech Lab unlocks (Classique: the Lancer); the heavy tank when the nation's anti-armour needs no Tech Lab. */
  techArmour: UnitKind;
  airStrike: UnitKind;
  interceptor: UnitKind;
  bomber: UnitKind;
  healer: UnitKind;
  healerAt: BuildingKind;
  line: UnitKind;
  at: UnitKind;
  /** The squad that answers aircraft (Classique: the Rocket Squad), else the line squad. */
  infAA: UnitKind;
  sniper: UnitKind;
  transport: UnitKind;
  super: UnitKind;
  /** The army: everything armed (or healing) that isn't a worker, scout, transport or super-unit. */
  combat: readonly UnitKind[];
  /** The squads among it (Classique: Troopers, Rocket Squads, Snipers — in that order). */
  infantry: readonly UnitKind[];
  /** Its ground vehicles from the factory (the airlift's vehicle cap counts these). */
  vehicles: readonly UnitKind[];
  /** Kinds that never go out with the guard or the hold line: guns that die in a brawl. */
  guns: readonly UnitKind[];
}

/** Classique's army, exactly as commander.ts listed it before the nations (order matters for float sums). */
const CLASSIC_COMBAT: UnitKind[] = [
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "mender",
  "trooper", "rocket-squad", "sniper"
];

const hitsAir = (k: UnitKind) => UNITS[k].targets === "air" || UNITS[k].targets === "both";

function makeKinds(nation: NationOrClassic): AiKinds {
  const r = ROLES[nation];
  const scoutKinds = [...new Set<UnitKind>([r.scout, ...(Object.values(ROLES).map((x) => x.scout))])];
  const workers = ALL_UNITS.filter((k) => behaves(k, "harvester"));
  const notArmy = (k: UnitKind) =>
    behaves(k, "harvester") || behaves(k, "condor") || behaves(k, "goliath") || scoutKinds.includes(k);
  const combat =
    nation === "classique"
      ? CLASSIC_COMBAT
      : ALL_UNITS.filter((k) => !notArmy(k) && (UNITS[k].dps > 0 || !!UNITS[k].heal));
  const infantry =
    nation === "classique"
      ? (["trooper", "rocket-squad", "sniper"] as UnitKind[])
      : combat.filter((k) => !!UNITS[k].squad);
  const vehicles =
    nation === "classique"
      ? (["stinger", "flak-crawler", "mortar", "mastodon", "lancer"] as UnitKind[])
      : combat.filter((k) => UNITS[k].builtAt === "fab-plant" && UNITS[k].domain === "ground" && !UNITS[k].squad && UNITS[k].dps > 0);
  const techAA = hitsAir(r.antiArmour) && UNITS[r.antiArmour].builtAt === "fab-plant"
    ? r.antiArmour
    : hitsAir(r.heavy) && UNITS[r.heavy].builtAt === "fab-plant" ? r.heavy : r.aa;
  return {
    nation,
    roles: r,
    worker: r.worker,
    workers,
    scout: r.scout,
    scoutAt: UNITS[r.scout].builtAt,
    scouts: scoutKinds,
    light: r.light,
    aa: r.aa,
    techAA,
    artillery: r.artillery,
    siege: r.siege,
    heavy: r.heavy,
    antiArmour: r.antiArmour,
    techArmour: UNITS[r.antiArmour].requires === "tech-lab" ? r.antiArmour : r.heavy,
    airStrike: r.airStrike,
    interceptor: r.interceptor,
    bomber: r.bomber,
    healer: r.healer,
    healerAt: UNITS[r.healer].builtAt,
    line: r.line,
    at: r.at,
    infAA: hitsAir(r.at) ? r.at : r.line,
    sniper: r.sniper,
    transport: r.transport,
    super: r.super,
    combat,
    infantry,
    vehicles,
    guns: [...new Set([r.artillery, r.siege])]
  };
}

const KINDS: Record<NationOrClassic, AiKinds> = {
  classique: makeKinds("classique"),
  republique: makeKinds("republique"),
  empire: makeKinds("empire")
};

/** The slots for a nation. */
export const aiKinds = (nation: NationOrClassic): AiKinds => KINDS[nation];

/** The slots for the nation `faction` plays. */
export const kindsOf = (w: World, faction: Faction): AiKinds => KINDS[nationOf(w, faction)];

/** Does this kind mine (a Fardier, a Fourgon)? */
export const isWorker = (kind: UnitKind): boolean => behaves(kind, "harvester");

/** Does this kind carry squads (a Condor, a Montgolfière, a Titan)? */
export const isTransport = (kind: UnitKind): boolean => behaves(kind, "condor");

/** Does this kind repair (a Mender, a Pasteur, an Atelier roulant)? */
export const isHealer = (kind: UnitKind): boolean => behaves(kind, "mender");

/**
 * How much an enemy aircraft counts toward the air we've seen (in Wasps): a
 * bomber two, a scout 0.3, an unarmed transport half. Classique's numbers
 * for its kinds; the nations' bombers and transports by role.
 */
export function airWeight(kind: UnitKind): number {
  if (kind === "hornet" || kind === "vulcain") return 2;
  if (kind === "scout") return 0.3;
  if (behaves(kind, "condor")) return 0.5;
  return 1;
}

// ------------------------------------------------------- power network ---

/**
 * The République's Réseau électrique (§1.2), as the commander plans for it:
 * a building other than the HQ and the Tour TSF goes up only within
 * `hqRadius` of the HQ's centre or `towerRadius` of a Tour TSF's (to the
 * footprint's nearest edge) — or a moored Zénith's. The AI holds itself to
 * it whether or not the rule is enforced yet (WP1), so its bases are the
 * same either way; every other nation's buildings need no power.
 */
export function needsPower(nation: NationOrClassic, kind: BuildingKind): boolean {
  return nation === "republique" && !!NATIONS.republique.power && kind !== "hq" && kind !== "radar";
}

export interface PowerSource {
  x: number;
  y: number;
  r: number;
}

/** The side's power sources: its HQ, its Tours TSF (outposts included), and its moored Zéniths. */
export function powerSources(w: World, faction: Faction): PowerSource[] {
  const p = NATIONS.republique.power;
  if (!p) return [];
  const out: PowerSource[] = [];
  for (const b of w.buildings.values()) {
    if (b.faction !== faction) continue;
    if (b.kind === "hq") out.push({ ...buildingCenter(b), r: p.hqRadius });
    else if (b.kind === "radar") out.push({ ...buildingCenter(b), r: p.towerRadius });
  }
  for (const g of anchoredGoliaths(w, faction)) if (g.kind === "zenith") out.push({ x: g.x, y: g.y, r: p.hqRadius });
  return out;
}

/** Is a `size` footprint at (tx, ty) inside one of `sources`' radii? */
export function poweredAt(sources: readonly PowerSource[], tx: number, ty: number, size: number): boolean {
  return sources.some((s) => distToFootprint(tx, ty, size, s.x, s.y) <= s.r);
}

/** Our buildings that need power and sit outside every source (their Tour TSF fell). */
export function unpoweredBuildings(w: World, faction: Faction): { tx: number; ty: number; size: number }[] {
  if (nationOf(w, faction) !== "republique") return [];
  const sources = powerSources(w, faction);
  const out: { tx: number; ty: number; size: number }[] = [];
  for (const b of w.buildings.values())
    if (b.faction === faction && needsPower("republique", b.kind) && !poweredAt(sources, b.tx, b.ty, BUILDINGS[b.kind].size))
      out.push({ tx: b.tx, ty: b.ty, size: BUILDINGS[b.kind].size });
  return out;
}

/** An aircraft that strikes the ground (Wasp, Hornet; Gyroptère, Vulcain), super-units aside. */
export const isAirStriker = (kind: UnitKind): boolean =>
  UNITS[kind].domain === "air" && UNITS[kind].targets === "ground" && UNITS[kind].dps > 0 && !behaves(kind, "goliath");

/** A fighter: an aircraft that only shoots aircraft (Raptor; Épervier). */
export const isInterceptor = (kind: UnitKind): boolean =>
  UNITS[kind].domain === "air" && UNITS[kind].targets === "air" && UNITS[kind].dps > 0;

/**
 * A gun: artillery that can't fire up close (Mortar; Canon Branly, Mortier de 280).
 * It never garrisons, captures nor hunts: it dies in a brawl.
 */
export const isGun = (kind: UnitKind): boolean => UNITS[kind].minRange !== undefined && !behaves(kind, "goliath");

/** Units an Uplink run or a garrison never takes: healers, guns, scouts, marksmen (Classique: Mender, Mortar, Scout, Sniper). */
export const noObjectiveDuty = (kind: UnitKind): boolean =>
  isHealer(kind) || isGun(kind) || kind === "scout" || kind === "estafette" || behaves(kind, "sniper");

/** A marksman squad (Sniper Team; Carabiniers). */
export const isSniper = (kind: UnitKind): boolean => behaves(kind, "sniper");
