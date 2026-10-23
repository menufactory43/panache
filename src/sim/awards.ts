import { UNITS } from "./balance";
import type { BuildingKind, Faction, FactionStats, PowerKind, UnitKind } from "./types";
import { tr } from "../lang";

/**
 * Medals: pure functions of an end-of-match recap (stats, the army-strength
 * timeline, the death log). No engine, no storage — the career layer
 * (src/game/career.ts) builds the recap from the match chronicle and banks
 * what these return. Thresholds are calibrated on AI-vs-AI matches so a
 * typical win earns one or two medals and the rest are goals to chase.
 */

export type MedalId =
  | "lightning"
  | "untouchable"
  | "comeback"
  | "flawless"
  | "tycoon"
  | "ace"
  | "giant-slayer"
  | "goliath-slayer"
  | "air-superiority"
  | "iron-wall"
  | "exterminator"
  | "wrecking-crew"
  | "orbital"
  | "scavenger"
  | "steady-hands"
  | "holdout"
  | "unbreakable";

export interface MedalDef {
  id: MedalId;
  name: string;
  icon: string;
  /** How to earn it (menu sheet and end screen). */
  desc: string;
  /** Which mode can award it. */
  mode: "skirmish" | "survival";
}

/** Tunables (seconds, counts, ratios). */
export const AWARDS = {
  lightningSecs: 5 * 60,
  comebackRatio: 0.5,
  /** ...and at least this far behind in army value (scrap), after the opening. */
  comebackMinGap: 800,
  comebackAfterSecs: 90,
  flawlessMaxLost: 5,
  tycoonRatio: 2,
  tycoonMin: 3000,
  aceKills: 9,
  giantMastodons: 3,
  /** Goliath Slayer: enemy Goliaths destroyed (one is a feat: it takes a real army, or a clever drop). */
  goliathKills: 1,
  airKills: 30,
  wallKills: 30,
  exterminatorKills: 60,
  wreckingBuildings: 12,
  /**
   * Orbital: one Sky Hammer destroys this much (scrap value of units and
   * buildings). Measured: its flat 700 to buildings makes "any building"
   * near-automatic once the Hammer is online, and units mostly get clear.
   */
  orbitalValue: 1000,
  /** Scavenger: scrap salvaged from wrecks in one match. */
  scavengerScrap: 3000,
  /** Steady Hands: this many enemy Barrages / Sky Hammers with our units under them (at least dodgeExposed) that hit nothing. */
  steadyDodges: 3,
  dodgeExposed: 2,
  holdoutWaves: 10,
  unbreakableWaves: 20
} as const;

/** 1500 → "1 500" */
const n = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, tr("\u00a0", ","));

export const MEDALS: Record<MedalId, MedalDef> = {
  lightning: { id: "lightning", name: tr("Guerre éclair", "Blitzkrieg"), icon: "⚡", desc: tr("Gagne en moins de 5:00", "Win in under 5:00"), mode: "skirmish" },
  untouchable: { id: "untouchable", name: tr("Intouchable", "Untouchable"), icon: "🛡️", desc: tr("Gagne sans perdre de bâtiment", "Win without losing a building"), mode: "skirmish" },
  comeback: { id: "comeback", name: tr("Remontada", "Comeback"), icon: "🔄", desc: tr("Gagne après être tombé à la moitié de leur armée", "Win after falling to half the enemy's army"), mode: "skirmish" },
  flawless: { id: "flawless", name: tr("Sans faute", "Flawless"), icon: "💎", desc: tr("Gagne en perdant 5 unités au plus", "Win losing 5 units at most"), mode: "skirmish" },
  tycoon: { id: "tycoon", name: tr("Magnat", "Tycoon"), icon: "💰", desc: tr("Gagne en récoltant deux fois plus de charbon que l'ennemi", "Win having harvested twice the enemy's coal"), mode: "skirmish" },
  ace: { id: "ace", name: tr("As", "Ace"), icon: "🎖️", desc: tr("Une unité totalise 9 victimes", "One unit scores 9 kills"), mode: "skirmish" },
  "giant-slayer": { id: "giant-slayer", name: tr("Tueur de géants", "Giant Slayer"), icon: "🗿", desc: tr("Détruis 3 Creusot ennemis", "Destroy 3 enemy Creusots"), mode: "skirmish" },
  "goliath-slayer": { id: "goliath-slayer", name: tr("Tueur de Gargantua", "Gargantua Slayer"), icon: "🪨", desc: tr("Abats un Gargantua ennemi", "Bring down an enemy Gargantua"), mode: "skirmish" },
  "air-superiority": { id: "air-superiority", name: tr("Supériorité aérienne", "Air Superiority"), icon: "✈️", desc: tr("Abats 30 appareils ennemis", "Shoot down 30 enemy aircraft"), mode: "skirmish" },
  "iron-wall": { id: "iron-wall", name: tr("Mur d'acier", "Wall of Steel"), icon: "🧱", desc: tr("Tes défenses détruisent 30 unités ennemies", "Your defences destroy 30 enemy units"), mode: "skirmish" },
  exterminator: { id: "exterminator", name: tr("Exterminateur", "Exterminator"), icon: "☠️", desc: tr("Détruis 60 unités ennemies", "Destroy 60 enemy units"), mode: "skirmish" },
  "wrecking-crew": { id: "wrecking-crew", name: tr("Démolisseurs", "Wrecking Crew"), icon: "🏚", desc: tr("Détruis 12 bâtiments ennemis", "Destroy 12 enemy buildings"), mode: "skirmish" },
  orbital: { id: "orbital", name: tr("Voyage dans la Lune", "A Trip to the Moon"), icon: "🛰️", desc: tr(`Détruis ${n(AWARDS.orbitalValue)} de charbon d'un seul Obus Méliès`, `Destroy ${n(AWARDS.orbitalValue)} coal with a single Méliès Shell`), mode: "skirmish" },
  scavenger: { id: "scavenger", name: tr("Charognard", "Scavenger"), icon: "♻️", desc: tr(`Récupère ${n(AWARDS.scavengerScrap)} de charbon sur les épaves`, `Salvage ${n(AWARDS.scavengerScrap)} coal from wrecks`), mode: "skirmish" },
  "steady-hands": {
    id: "steady-hands", name: tr("Sang-froid", "Cool Head"), icon: "💨", desc: tr(`Esquive ${AWARDS.steadyDodges} Feux roulants ou Obus Méliès ennemis`, `Dodge ${AWARDS.steadyDodges} enemy Rolling Barrages or Méliès Shells`), mode: "skirmish"
  },
  holdout: { id: "holdout", name: tr("Résistant", "Holdout"), icon: "🏰", desc: tr("Survie : tiens 10 vagues", "Last Stand: hold out 10 waves"), mode: "survival" },
  unbreakable: { id: "unbreakable", name: tr("Inébranlable", "Unshakeable"), icon: "🗼", desc: tr("Survie : tiens 20 vagues", "Last Stand: hold out 20 waves"), mode: "survival" }
};

export const MEDAL_IDS = Object.keys(MEDALS) as MedalId[];

export interface RecapDeath {
  /** Game seconds. */
  t: number;
  /** The victim's side. */
  faction: Faction;
  unitKind: UnitKind | null;
  buildingKind: BuildingKind | null;
  /** Killed by a building (turret, SAM, HQ gun). */
  byBuilding: boolean;
  /** Killed by a commander calldown (then not byBuilding). */
  power?: PowerKind | null;
}

/** A commander calldown and what came of it (from the chronicle). */
export interface RecapStrike {
  /** The side that called it. */
  faction: Faction;
  power: PowerKind;
  /** The target side's units under the reticle when it was called. */
  exposed: number;
  /** Units and buildings it hit when it landed (summed over a Barrage's shells). */
  hits: number;
  /** What it destroyed, and its scrap value. */
  units: number;
  buildings: number;
  value: number;
}

/** Everything the medals need, from one side's point of view. */
export interface MatchRecap {
  pov: Faction;
  /** The pov side won. A draw (Robot Love: two Goliaths fell in love) is not a win. */
  won: boolean;
  /** Match length in seconds. */
  secs: number;
  stats: Record<Faction, FactionStats>;
  /** Army strength over time (both sides). */
  samples: { t: number; army: Record<Faction, number> }[];
  deaths: RecapDeath[];
  /** Most kills scored by one of the pov side's units (alive or fallen). */
  bestUnitKills: number;
  /** Every calldown of the match, both sides (absent: none recorded). */
  strikes?: RecapStrike[];
  /** Last Stand: waves survived (null in a skirmish). */
  waves?: number | null;
}

const enemyOf = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

/** Was the pov side ever down to half the enemy's army (after the opening)? */
export function wasBehind(r: MatchRecap): boolean {
  const them = enemyOf(r.pov);
  return r.samples.some(
    (s) =>
      s.t >= AWARDS.comebackAfterSecs &&
      s.army[them] - s.army[r.pov] >= AWARDS.comebackMinGap &&
      s.army[r.pov] <= s.army[them] * AWARDS.comebackRatio
  );
}

/**
 * Enemy Barrages and Sky Hammers the pov side got clear of: at least
 * AWARDS.dodgeExposed of its units under the reticle when it was called, and
 * not one unit or building hit when it landed.
 */
export function strikesDodged(r: MatchRecap): number {
  const them = enemyOf(r.pov);
  return (r.strikes ?? []).filter(
    (s) => s.faction === them && (s.power === "barrage" || s.power === "hammer") && s.exposed >= AWARDS.dodgeExposed && s.hits === 0
  ).length;
}

/** Enemy units the pov side destroyed matching a filter. */
function killsWhere(r: MatchRecap, pred: (d: RecapDeath) => boolean): number {
  const them = enemyOf(r.pov);
  let n = 0;
  for (const d of r.deaths) if (d.faction === them && d.unitKind && pred(d)) n++;
  return n;
}

/**
 * The medals this recap earns, in display order. Victory medals need the
 * win; feats of arms count in defeat and in a draw alike (a match that ends
 * with two Goliaths in love was won by nobody, but what was destroyed on the
 * way still was).
 */
export function computeMedals(r: MatchRecap): MedalId[] {
  if (r.waves !== undefined && r.waves !== null) {
    const out: MedalId[] = [];
    if (r.waves >= AWARDS.holdoutWaves) out.push("holdout");
    if (r.waves >= AWARDS.unbreakableWaves) out.push("unbreakable");
    return out;
  }
  const me = r.stats[r.pov];
  const them = r.stats[enemyOf(r.pov)];
  const out: MedalId[] = [];
  if (r.won && r.secs < AWARDS.lightningSecs) out.push("lightning");
  if (r.won && me.buildingsLost === 0) out.push("untouchable");
  if (r.won && wasBehind(r)) out.push("comeback");
  if (r.won && me.unitsLost <= AWARDS.flawlessMaxLost) out.push("flawless");
  if (r.won && me.scrapHarvested >= AWARDS.tycoonMin && me.scrapHarvested >= them.scrapHarvested * AWARDS.tycoonRatio)
    out.push("tycoon");
  // feats of arms count in defeat too: a consolation worth chasing
  if (r.bestUnitKills >= AWARDS.aceKills) out.push("ace");
  if (killsWhere(r, (d) => d.unitKind === "mastodon") >= AWARDS.giantMastodons) out.push("giant-slayer");
  if (killsWhere(r, (d) => d.unitKind === "goliath") >= AWARDS.goliathKills) out.push("goliath-slayer");
  if (killsWhere(r, (d) => UNITS[d.unitKind!].domain === "air") >= AWARDS.airKills) out.push("air-superiority");
  if (killsWhere(r, (d) => d.byBuilding) >= AWARDS.wallKills) out.push("iron-wall");
  if (me.unitsKilled >= AWARDS.exterminatorKills) out.push("exterminator");
  if ((me.buildingsKilled ?? 0) >= AWARDS.wreckingBuildings) out.push("wrecking-crew");
  // the battlefield's own feats: calldowns and salvage
  if ((r.strikes ?? []).some((s) => s.faction === r.pov && s.power === "hammer" && s.value >= AWARDS.orbitalValue)) out.push("orbital");
  if ((me.scrapSalvaged ?? 0) >= AWARDS.scavengerScrap) out.push("scavenger");
  if (strikesDodged(r) >= AWARDS.steadyDodges) out.push("steady-hands");
  return out;
}
