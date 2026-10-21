import { BUILDINGS, ECONOMY, GOLIATH, OBJECTIVES, UNITS } from "../balance";
import { TICK_RATE } from "../balance";
import { buildingBlocker, canPlaceBuilding, nearestReachableResource, nearestScrapTile, unitBlocker } from "../economy";
import { knownBuildings } from "../fog";
import { isInfantry } from "../infantry";
import { Terrain } from "../types";
import { earlyCallBonus, survivalHoldPoint, waveBudget } from "../modes/survival";
import { findPath } from "../movement";
import { isWoundedVeteran, veteranRetreats } from "./veterans";
import { planMenders } from "./menders";
import { bannedBy, infantryArmy, nationOf } from "../rules";
import {
  aiKinds,
  airWeight,
  buildingFor,
  isDefence,
  isGroundDefence,
  isWorker,
  needsPower,
  poweredAt,
  powerSources,
  unpoweredBuildings,
  type AiKinds
} from "./roles";
import { planSalvage } from "./salvage";
import { objectiveHolds, planObjectives } from "./objectives";
import { dodgeCalldowns, dodgingUnits, planCalldowns } from "./powers";
import { AIRBORNE_INFANTRY, condorHolds, flysGivenCondor, planCondor, wantCondor } from "./condor";
import { AIRLIFT, airliftActive, airliftHolds, airliftSquadsWanted, airliftWantsCondor, offHomeLand, planAirlift } from "./airlift";
import { AA_COVER, USELESS, aaSources, aaStrengthAt, aaWeight, effectivenessVs, seenEnemies, unitAntiAir } from "./intel";
import {
  GOLIATH_AI,
  enemyGantryBuilds,
  enemyHqGone,
  goliathBarracks,
  goliathFund,
  goliathHarvest,
  goliathHolds,
  huntGoliaths,
  liftCondors,
  liftWantsCondors,
  lostHome,
  noteGantryFailed,
  noteNoRoom,
  noteGoliathOrdered,
  noteHome,
  outpostSpot,
  outpostWanted,
  planGoliaths,
  threatValue,
  wantGantry,
  wantGoliath
} from "./goliath";
import { canWalk, distToFootprint, goliathsOf, hasGoliath, isAnchored, repairUrgency, trainableAt, unitCost } from "../goliath";
import type {
  ArmorClass,
  Building,
  BuildingKind,
  Command,
  Domain,
  Faction,
  Nation,
  NationOrClassic,
  TargetDomain,
  Unit,
  UnitKind,
  World
} from "../types";
import {
  buildingCenter,
  canGetWithin,
  dist,
  domainOf,
  hqOf,
  isResource,
  moveClassOf,
  nearestDropOff,
  regionAt,
  regionLabels,
  sideFrame,
  tileIndex
} from "../world";

export type AiMode = "buildup" | "harass" | "assault";
export type Difficulty = "easy" | "normal" | "hard";

/** A commander personality: opening, economy size, army mix, aggression. */
export interface Strategy {
  name: StrategyName;
  /** One-line description for the spectator HUD. */
  label: string;
  /** Buildings wanted, in order (duplicates = build that many). */
  buildOrder: BuildingKind[];
  harvesters: number;
  /** Army value (scrap cost) that triggers the all-in assault. */
  assaultValue: number;
  /** Idle raiders required before a harass raid launches. */
  harassGroup: number;
  /** Air force first: the Fab Plant only makes anti-air and a small home guard. */
  airOnly?: boolean;
  /** Lean on heavy tech ground units (mastodons, lancers, mortars). */
  heavy?: boolean;
  /** Early raids use stingers as well as wasps. */
  groundRaids?: boolean;
  /**
   * Share of the army's value it keeps in robot infantry once it has an
   * Assembly Bay (Troopers, with Rocket Squads against armour and air).
   * Without it, the Bay only answers what it sees: Rockets for Mastodons,
   * Snipers for enemy infantry.
   */
  infantry?: number;
  /** Rocket Squads it keeps per Mastodon of its own, as escorts (Ironclad). */
  escorts?: number;
  /** No Assembly Bay in its plans, but it builds one for Rocket Squads once it has seen heavy armour (Mastodons, Hornets). */
  bayVsArmour?: boolean;
  /**
   * A nation's own personality (§1.9: `siege`, `volta`). Its `name` is then the
   * Classique personality it plays like wherever a table is keyed by
   * personality (ai/goliath.ts, openers.ts, the Condor drops).
   */
  id?: NationStrategyName;
  /** Siege train (Empire): Mortiers de 280 in every wave, a forward Ballon captif, a scout spotting for the guns. */
  siege?: boolean;
  /** Pushes its Tours TSF (or Ballon captif) forward, toward the centre. */
  forward?: boolean;
  /** Share of the Assembly Bays' squads that are anti-tank squads (Volta: Sapeurs), whatever it has seen. */
  atShare?: number;
}

export type StrategyName = "balanced" | "rush" | "airswarm" | "boom" | "skyforce" | "ironclad";
/** The nations' own personalities (§1.9): only their nation's commanders pick them. */
export type NationStrategyName = "siege" | "volta";
export type PersonalityName = StrategyName | NationStrategyName;

export const STRATEGIES: Record<StrategyName, Strategy> = {
  /** Steady macro: factory, airpad, tech, then an Assembly Bay; standard timing, the odd Condor drop. */
  balanced: {
    name: "balanced",
    label: "Équilibré",
    buildOrder: ["fab-plant", "airpad", "turret", "tech-lab", "assembly-bay", "depot", "turret", "radar"],
    harvesters: 4,
    assaultValue: 1700,
    harassGroup: 2,
    infantry: 0.25
  },
  /**
   * Early ground pressure: Troopers from an early Assembly Bay alongside
   * Stinger raids in packs of five, two factories, the earliest and smallest
   * waves, Condor drops on the harvesters. A fifth harvester pays for it:
   * every side's starting Trooper Squad blunts the opening raids (at 4 it
   * won 18–26% of tools/pacing.ts games with infantry in; 40% at 5).
   */
  rush: {
    name: "rush",
    label: "Rush",
    buildOrder: ["fab-plant", "assembly-bay", "turret", "airpad", "fab-plant", "tech-lab"],
    harvesters: 5,
    assaultValue: 1400,
    harassGroup: 5,
    groundRaids: true,
    infantry: 0.4
  },
  /** Airpad first: relentless wasp raids, bombers later; Rocket Squads when Mastodons show up. */
  airswarm: {
    name: "airswarm",
    label: "Essaim aérien",
    buildOrder: ["airpad", "fab-plant", "turret", "tech-lab", "depot", "airpad"],
    harvesters: 4,
    assaultValue: 1700,
    harassGroup: 2,
    bayVsArmour: true
  },
  /**
   * Greedy economy: extra harvesters, a forward depot, a huge late push;
   * Rocket Squads from an Assembly Bay once Mastodons show up.
   * (The depot comes after a turret and the Tech Lab: with every side's
   * starting Trooper Squad on guard, a depot second won it 74–76% of
   * tools/pacing.ts games; 61% this way.)
   */
  boom: {
    name: "boom",
    label: "Boom",
    buildOrder: ["fab-plant", "turret", "tech-lab", "depot", "airpad", "turret", "radar", "sam-site"],
    harvesters: 4,
    assaultValue: 2000,
    harassGroup: 3,
    bayVsArmour: true
  },
  /**
   * Air force: wasps, raptors and hornets; the late Fab Plant only guards
   * home, and Rocket Squads from an Assembly Bay join it once Mastodons show up.
   */
  skyforce: {
    name: "skyforce",
    label: "Force aérienne",
    buildOrder: ["airpad", "turret", "tech-lab", "airpad", "fab-plant", "depot", "sam-site"],
    harvesters: 4,
    assaultValue: 2000,
    harassGroup: 2,
    airOnly: true,
    bayVsArmour: true
  },
  /**
   * Armoured column: rushes the Tech Lab (right after a turret) for Mastodons,
   * Lancers and Mortars, and an Assembly Bay for the Rocket Squads that
   * escort the Mastodons. (Waves at 1400: at 1500 it won 72–76% of
   * tools/pacing.ts games once infantry was in, at 1800 82%, at 1300 58%.)
   */
  ironclad: {
    name: "ironclad",
    label: "Cuirassé",
    buildOrder: ["fab-plant", "turret", "tech-lab", "assembly-bay", "airpad", "depot", "fab-plant", "sam-site"],
    harvesters: 4,
    assaultValue: 1400,
    harassGroup: 3,
    heavy: true,
    escorts: 1
  }
};

/**
 * The nations' own personalities (§1.9). Their `name` is the Classique one
 * they play like for tables keyed by personality; `id` is theirs.
 */
export const NATION_STRATEGIES: Record<NationStrategyName, Strategy> = {
  /**
   * Empire siege train: a turret and the Haut-fourneau early, Mortiers de 280
   * (two or three a wave) behind Creusots, a Ballon captif pushed forward and
   * a scout spotting for the guns (they see 6, they shoot 11).
   */
  siege: {
    name: "ironclad",
    id: "siege",
    label: "Siège",
    buildOrder: ["fab-plant", "turret", "tech-lab", "assembly-bay", "radar", "airpad", "turret", "fab-plant"],
    harvesters: 4,
    assaultValue: 2200,
    harassGroup: 4,
    heavy: true,
    siege: true,
    forward: true
  },
  /**
   * République « Volta »: Tours TSF pushed toward the centre, Sapeurs and
   * Hydroglisseurs, Jamais-Contente raids.
   */
  volta: {
    name: "rush",
    id: "volta",
    label: "Volta",
    buildOrder: ["fab-plant", "radar", "assembly-bay", "airpad", "radar", "tech-lab", "depot"],
    harvesters: 5,
    assaultValue: 1500,
    harassGroup: 3,
    infantry: 0.35,
    groundRaids: true,
    forward: true,
    atShare: 0.4
  }
};

/** Every personality, Classique's and the nations'. */
export const PERSONALITIES: Record<PersonalityName, Strategy> = { ...STRATEGIES, ...NATION_STRATEGIES };

/** A commander's personality name: a nation's own (`siege`, `volta`) or its Classique one. */
export const personalityOf = (s: Strategy): PersonalityName => s.id ?? s.name;

/**
 * Personalities each nation picks from at random, by difficulty (§1.9): the
 * République never plays Boom or Ironclad (its armour is light), the Empire
 * never Skyforce (its aviation is too dear); each has its own on Normal and
 * Hard. Any personality can still be asked for by name: all of them play
 * both nations.
 */
export const NATION_POOLS: Record<Nation, Record<Difficulty, PersonalityName[]>> = {
  republique: {
    easy: ["balanced", "rush", "airswarm"],
    normal: ["balanced", "rush", "airswarm", "skyforce", "volta"],
    hard: ["balanced", "airswarm", "skyforce", "volta"]
  },
  empire: {
    easy: ["balanced", "rush", "airswarm"],
    normal: ["balanced", "rush", "airswarm", "boom", "ironclad", "siege"],
    hard: ["balanced", "airswarm", "boom", "ironclad", "siege"]
  }
};

/** The personalities a commander of `nation` picks from (Classique: DIFFICULTY's pool). */
export const poolFor = (nation: NationOrClassic, difficulty: Difficulty): PersonalityName[] =>
  nation === "classique" ? DIFFICULTY[difficulty].pool : NATION_POOLS[nation][difficulty];

export const DIFFICULTY: Record<
  Difficulty,
  {
    label: string; interval: number; incomeMult: number; extraHarvesters: number; assaultMult: number; harass: boolean;
    /** Personalities this difficulty picks from at random. */
    pool: StrategyName[];
  }
> = {
  easy: {
    label: "Facile", interval: 3.5, incomeMult: 0.75, extraHarvesters: -1, assaultMult: 1.35, harass: false,
    // no Skyforce: its all-air wave at ~3:00 beat a scripted first-week player
    // 11 games in 15 on Easy (tools/beginner.ts); the other three lost 6 in 45
    pool: ["balanced", "rush", "airswarm"]
  },
  normal: {
    label: "Normal", interval: 2, incomeMult: 1, extraHarvesters: 0, assaultMult: 1, harass: true,
    pool: ["balanced", "rush", "airswarm", "boom", "skyforce", "ironclad"]
  },
  hard: {
    label: "Difficile", interval: 1.2, incomeMult: 1.3, extraHarvesters: 1, assaultMult: 0.9, harass: true,
    pool: ["balanced", "airswarm", "boom", "ironclad"]
  }
};

export interface AiState {
  mode: AiMode;
  strategy: Strategy;
  difficulty: Difficulty;
  lastDecisionTick: number;
  /** Rolling estimate of enemy force composition, from what we've seen. */
  seenAir: number;
  seenGround: number;
  /** Heavily armoured enemy ground units seen (mastodons, harvesters don't count). */
  seenHeavy: number;
  /** Enemy anti-air seen recently, in Flak Crawlers (intel.ts aaWeight: a Trooper Squad is 0.2). */
  seenAA: number;
  /** Enemy robot infantry squads seen recently. */
  seenInfantry: number;
  /** Tick the last scout was ordered (scouts are cheap but not free). */
  lastScoutTick: number;
  scoutLeg: number;
  /** Deterministic RNG state for tie-breaks. */
  rng: number;
  /** Extra SAM sites wanted in response to enemy air. */
  extraSams: number;
  /** Extra turrets wanted in response to enemy infantry. */
  extraTurrets: number;
  /** Extra production buildings wanted because scrap is piling up. */
  extraProduction: number;
  /** Depot build order entries we gave up on (no useful spot). */
  skippedDepots: number;
  /** Army value when the current wave launched (for retreat decisions). */
  waveValue: number;
  /**
   * Picked at random from the Classique pool (no personality asked for): in
   * a nations match the first decision pass re-picks from the nation's pool
   * (NATION_POOLS), with the commander's own seeded tie-break.
   */
  randomPick?: { tweak?: Partial<Strategy> };
  /** Staged waves launched so far, and the tick of the first (tests, tools). */
  waves?: number;
  firstWaveTick?: number;
}

/**
 * Pass a strategy for deterministic behaviour (tests); omit for random.
 * `tweak` overrides parts of the personality (Ops: a commander that never
 * attacks gets `assaultValue: Infinity, harassGroup: Infinity`).
 */
export function createAiState(strategy?: PersonalityName, difficulty: Difficulty = "normal", seed?: number, tweak?: Partial<Strategy>): AiState {
  const names = DIFFICULTY[difficulty].pool;
  const picked = strategy ?? names[Math.floor(Math.random() * names.length)]!;
  const s: AiState = {
    mode: "buildup",
    strategy: tweak ? { ...PERSONALITIES[picked], ...tweak } : PERSONALITIES[picked],
    difficulty,
    lastDecisionTick: -1000,
    seenAir: 0,
    seenGround: 0,
    seenHeavy: 0,
    seenAA: 0,
    seenInfantry: 0,
    lastScoutTick: -1e9,
    scoutLeg: 0,
    rng: seed ?? 12345,
    extraSams: 0,
    extraTurrets: 0,
    extraProduction: 0,
    skippedDepots: 0,
    waveValue: 0
  };
  if (strategy === undefined) s.randomPick = { tweak };
  return s;
}

/** A nations match: a commander whose personality was a random Classique pick takes one from its nation's pool instead. */
function pickForNation(s: AiState, nation: NationOrClassic): void {
  const pick = s.randomPick;
  if (!pick || nation === "classique") return;
  s.randomPick = undefined;
  const pool = poolFor(nation, s.difficulty);
  const name = pool[Math.min(pool.length - 1, Math.floor(rand(s) * pool.length))]!;
  s.strategy = pick.tweak ? { ...PERSONALITIES[name], ...pick.tweak } : PERSONALITIES[name];
}

const RETREAT_ARMY_VALUE = 350;
/**
 * Share of the assault threshold that must gather at the staging point
 * before a wave launches: big waves, and a lull while the next one gathers
 * (at 0.6 waves trickled out every 500–1,200 scrap, fighting never paused,
 * and the side ahead at 4:00 won 87–90%).
 */
const WAVE_LAUNCH = 0.75;
/** No raids before this: an opener's starting units guard home while both sides settle in. */
const OPENING_GRACE = 45 * TICK_RATE;
/** Enemy army value at the HQ that, if it outguns the home guard, recalls everyone. */
const HOME_ALARM_VALUE = 400;
/** Visible armed enemies this close to our buildings/harvesters are threats. */
const DEFENSE_RADIUS = 11;
const GUARD_RADIUS = 5;
const STAGE_RADIUS = 6;
/** Network towers (Tours TSF) a République commander puts up at most, build order's included. */
const MAX_TOWERS = 6;

/** Per-commander memory kept beside AiState: where the next Tour TSF goes. */
interface NetMemo {
  /** Where a Tour TSF started for the power network should stand (null: the build order's own). */
  anchor: { x: number; y: number } | null;
  /** Workers sent to mine last pass (id → kind), and the kinds found unable to (idle again: WP1's `base` not in yet). */
  sent: Map<number, UnitKind>;
  duds: Set<UnitKind>;
}
const netMemos = new WeakMap<AiState, NetMemo>();
function netMemo(s: AiState): NetMemo {
  let m = netMemos.get(s);
  if (!m) netMemos.set(s, (m = { anchor: null, sent: new Map(), duds: new Set() }));
  return m;
}

const mirror = (w: World, x: number, y: number) => ({ x: w.width - x, y: w.height - y });

const canHitDomain = (targets: TargetDomain, domain: Domain): boolean =>
  targets === "both" || targets === domain;

const value = (units: Unit[]) => units.reduce((v, u) => v + UNITS[u.kind].cost, 0);

function rand(s: AiState): number {
  s.rng = (s.rng * 1103515245 + 12345) & 0x7fffffff;
  return s.rng / 0x7fffffff;
}

/**
 * The enemy commander. Runs a decision pass every couple of seconds and
 * returns ordinary commands — it plays by the same rules (and fog) as the
 * player. Difficulty only changes its reaction speed and income.
 */
export function tickAi(w: World, faction: Faction, s: AiState): Command[] {
  const diff = DIFFICULTY[s.difficulty];
  w.factions[faction].incomeMult = diff.incomeMult;
  // no HQ, no commander — unless a Goliath fights on (a side is beaten only once its HQ and all
  // its Goliaths are gone: GOLIATH.md); Last Stand's waves are the director's alone (not even the dodge reflex)
  const hq = hqOf(w, faction);
  if (!hq && !hasGoliath(w, faction)) return [];
  // calldown reflex: scatter from enemy reticles every tick, not just on decision passes
  const reflex = w.winner ? [] : dodgeCalldowns(w, faction, s);
  if (w.tick - s.lastDecisionTick < diff.interval * TICK_RATE || w.winner) return reflex;
  s.lastDecisionTick = w.tick;

  const cmds: Command[] = reflex;
  // the nation's roster, by role (ai/roles.ts; Classique: today's kinds)
  const nation = nationOf(w, faction);
  pickForNation(s, nation);
  const K = aiKinds(nation);
  const COMBAT_KINDS = K.combat;
  const INFANTRY_KINDS = K.infantry;
  const f = w.factions[faction];
  const mine = [...w.units.values()].filter((u) => u.faction === faction);
  const myBuildings = [...w.buildings.values()].filter((b) => b.faction === faction);
  // (a nation's worker kind the sim won't set mining yet is left out, and not built: see the probe below)
  const nm = nation === "classique" ? null : netMemo(s);
  if (nm) {
    for (const [id, kind] of nm.sent) if (w.units.get(id)?.order.type === "idle" && !isWorker(kind)) nm.duds.add(kind); // (WP1: every worker mines now)
    nm.sent.clear();
  }
  const harvesters = mine.filter((u) => isWorker(u.kind) && !nm?.duds.has(u.kind));
  // (island maps: squads holding an island relay, or stranded on one, are the airlift's — ai/airlift.ts —
  // never counted toward a wave they can't walk to)
  const army = mine.filter((u) => COMBAT_KINDS.includes(u.kind) && !offHomeLand(w, faction, u));
  const airlifts = airliftActive(w, faction, s);
  const armyValue = value(army);
  const count = (k: UnitKind) => mine.filter((u) => u.kind === k).length;
  // (Goliaths are their own planner's, never the army's: ai/goliath.ts)
  const goliaths = goliathsOf(w, faction).sort((a, b) => a.id - b.id);
  // (squads training at an anchored Goliath count as queued too)
  const queued = (k: UnitKind) =>
    myBuildings.reduce((n, b) => n + b.queue.filter((q) => q.kind === k).length, 0) +
    goliaths.reduce((n, g) => n + g.goliath!.queue.filter((q) => q.kind === k).length, 0);
  const have = (k: UnitKind) => count(k) + queued(k);
  const has = (k: BuildingKind) => myBuildings.some((b) => b.kind === k);

  const seen = seenEnemies(w, faction); // through fog and Sniper concealment alike
  observeEnemy(s, seen, enemyGantryBuilds(w, faction).length);

  // where our HQ stands, or stood (Nomads: where our Goliath started): the enemy's home is its
  // mirror image, and that stays put
  const origin = hq ? buildingCenter(hq) : lostHome(w, faction, s);
  if (hq) noteHome(s, origin);
  // the base: the HQ, else (lost, or Nomads) our first dug-in Goliath, else where the HQ stood
  const baseGoliath = hq ? undefined : goliaths.find(isAnchored);
  const hqC = baseGoliath ? { x: baseGoliath.x, y: baseGoliath.y } : origin;
  // island maps: the two landmasses meet only at the bridges, and a field on
  // the enemy's side of them is theirs to defend, not ours to mine
  const islandMap = !!w.rules?.islands;
  const enemyHome = mirror(w, origin.x, origin.y);
  const ourSide = (tx: number, ty: number) =>
    dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y) <= dist(tx + 0.5, ty + 0.5, enemyHome.x, enemyHome.y);
  const nearestField = nearestScrapTile(w, hqC.x, hqC.y, faction);
  const activeField = nearestField && (!islandMap || ourSide(nearestField.x, nearestField.y)) ? nearestField : null;
  /** Where the economy needs defending: the mined field, shaded toward home. */
  const guardPoint = activeField
    ? {
        x: activeField.x + 0.5 + Math.sign(hqC.x - activeField.x - 0.5) * 1.5,
        y: activeField.y + 0.5 + Math.sign(hqC.y - activeField.y - 0.5) * 1.5
      }
    : hqC;

  // --- threats: armed intruders near our buildings, harvesters or Uplinks ---
  const threats = findThreats(w, faction, seen, myBuildings, harvesters);
  threats.sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y));
  // (a Goliath counts for what it can still fire: ai/goliath.ts threatValue)
  const atHome = threats.filter((t) => dist(t.x, t.y, hqC.x, hqC.y) <= DEFENSE_RADIUS);
  const raidValue = atHome.reduce((v, t) => v + t.value, 0);
  const threatened = raidValue >= HOME_ALARM_VALUE;
  const enemyHqKnown = knownBuildings(w, faction).find((b) => b.kind === "hq");
  const net = nation === "republique" ? netMemo(s) : null;
  const enemyHqPos = enemyHqKnown ? { x: enemyHqKnown.tx + 1.5, y: enemyHqKnown.ty + 1.5 } : enemyHome;

  // --- construction: place a ready building, or start the next one -------
  // (late in a match, rich and with an army: a Gantry and whatever it needs first, ai/goliath.ts)
  // (with no HQ, lost or Nomads, there's a Gantry only while a Goliath is dug in to build round)
  const gantryWanted = (!!hq || !!baseGoliath) && wantGantry(w, faction, s, { armyValue, threatened, home: origin, enemyHome });
  /** Where a building of `kind` goes: defences by the mining line, radar forward, the Gantry behind the HQ (it is big, and always seen), the rest by the HQ. */
  const anchorFor = (kind: BuildingKind) =>
    isDefence(kind) || (kind === "depot" && !hq)
      ? guardPoint
      : kind === "radar" ? towardEnemy(w, hqC, s.strategy.forward ? 8 : 4) : kind === "gantry" ? towardEnemy(w, hqC, -5) : hqC;
  // (no HQ: every building goes up in a Goliath's ring, and a full ring is skipped, not started and refunded)
  let roomless = false;
  const fits = (kind: BuildingKind) => {
    const ok = !!findPlacementSpot(w, faction, kind, anchorFor(kind));
    if (!ok) roomless = true;
    return ok;
  };
  let wanted = nextBuilding(w, faction, myBuildings, s, gantryWanted, hq ? undefined : fits);
  if (roomless) noteNoRoom(w, s); // (the base Goliath may move on to build more: ai/goliath.ts)
  // the République's power network (§1.2): a Tour TSF first wherever the next building would stand unpowered
  if (net && hq && !f.pending) {
    const towers = myBuildings.filter((b) => b.kind === "radar").length;
    const dark = unpoweredBuildings(w, faction)[0];
    let at: { x: number; y: number } | null = null;
    if (dark) at = { x: dark.tx + dark.size / 2, y: dark.ty + dark.size / 2 };
    else if (wanted === "depot") at = depotSite(w, faction, hqC) ? null : depotSite(w, faction, hqC, true)?.field ?? null;
    else if (wanted && needsPower(nation, wanted) && !findPlacementSpot(w, faction, wanted, anchorFor(wanted))) at = anchorFor(wanted);
    if (at && towers < MAX_TOWERS && !buildingBlocker(w, faction, "radar") && findPlacementSpot(w, faction, "radar", at)) {
      net.anchor = at;
      wanted = "radar";
    }
  }
  if (f.pending?.ready) {
    const kind = f.pending.kind;
    // an outpost goes up in its Goliath's ring (ai/goliath.ts)
    let spot: { tx: number; ty: number } | null = outpostSpot(w, faction, s, kind, enemyHqPos);
    if (!spot && net?.anchor && kind === "radar") {
      spot = findPlacementSpot(w, faction, kind, net.anchor);
      net.anchor = null;
    }
    if (!spot && kind === "depot" && hq) {
      const site = depotSite(w, faction, hqC);
      spot = site ? site.spot : findPlacementSpot(w, faction, kind, guardPoint);
    } else if (!spot) spot = findPlacementSpot(w, faction, kind, anchorFor(kind));
    if (spot) cmds.push({ type: "placeBuilding", faction, tx: spot.tx, ty: spot.ty });
    else {
      cmds.push({ type: "cancelBuilding", faction }); // nowhere to put it
      if (kind === "gantry") noteGantryFailed(w, s);
      if (!hq) noteNoRoom(w, s);
    }
  } else if (!f.pending) {
    // an outpost for a dug-in Goliath first (cheap, and few), else the base's next building
    const outpost = outpostWanted(w, faction, s, f.scrap);
    if (outpost) cmds.push({ type: "startBuilding", faction, building: outpost });
    else if (wanted && f.scrap >= BUILDINGS[wanted].cost) {
      // (a network tower is started for its anchor; anything else from the plan forgets it)
      if (net && wanted !== "radar") net.anchor = null;
      // (a Gantry only with room for it: else it would go up only to be refunded)
      if (wanted === "gantry" && hq && !fits("gantry")) noteGantryFailed(w, s);
      else cmds.push({ type: "startBuilding", faction, building: wanted });
    }
  }

  // --- economy: keep the harvester count mining ---------------------------
  const depots = myBuildings.filter((b) => b.kind === "depot").length;
  // (island maps: only fields on our side of the bridges; none left, no more harvesters —
  // and no search: a search for a field that isn't there floods the whole landmass)
  const fieldsLeft = !islandMap || ownFieldLeft(w, hqC, ourSide);
  // (the République sends its Fourgons to radium first, when there is some within reach of home: §1.9)
  const radium = nation === "republique" && fieldsLeft ? radiumField(w, faction, hqC, ourSide) : null;
  const fieldFrom = (x: number, y: number) =>
    radium ??
    (!islandMap ? nearestReachableResource(w, x, y, faction) : fieldsLeft ? nearestReachableResource(w, x, y, faction, ourSide) : null);
  // the fields our dug-in Goliaths work (ai/goliath.ts): harvesters sent out, and more built for them
  const goliathFields = goliathHarvest(w, faction, s, harvesters, () => {
    const at = fieldFrom(hqC.x, hqC.y);
    return at ? { x: at.x + 0.5, y: at.y + 0.5 } : null;
  });
  cmds.push(...goliathFields.cmds);
  const wantHarvesters = Math.max(1, s.strategy.harvesters + diff.extraHarvesters + depots + goliathFields.extra);
  // (Nomads: no HQ ever — the dug-in Goliath builds them, goliath.ts trainableAt)
  const yard = hq ? { id: hq.id, queue: hq.queue } : baseGoliath && trainableAt(w, K.worker) ? { id: baseGoliath.id, queue: baseGoliath.goliath!.queue } : null;
  if (yard && fieldsLeft && !nm?.duds.has(K.worker) && harvesters.length < wantHarvesters && yard.queue.length === 0 && f.scrap >= UNITS[K.worker].cost)
    cmds.push({ type: "produce", faction, buildingId: yard.id, unit: K.worker });
  for (const h of harvesters) {
    if (goliathFields.keep.has(h.id)) continue; // (working a Goliath's field)
    const o = h.order;
    // (a dry field sends a harvester to the nearest one it can reach: never across the bridges)
    const astray = islandMap && o.type === "harvest" && !ourSide(o.fieldX, o.fieldY);
    if (h.order.type !== "idle" && !astray) continue;
    const field = fieldFrom(h.x, h.y);
    if (field) {
      cmds.push({ type: "harvest", faction, unitIds: [h.id], x: field.x + 0.5, y: field.y + 0.5 });
      nm?.sent.set(h.id, h.kind);
    }
    else if (astray) cmds.push({ type: "move", faction, unitIds: [h.id], x: hqC.x, y: hqC.y + (sideFrame(w, faction).flip ? -3 : 3) });
  }

  // --- production: adaptive counters to the enemy composition -------------
  // reserve scrap while an important building is still wanted
  const reserve =
    f.pending || wanted === null ? 0 : isGroundDefence(wanted) || wanted === "radar" ? 0 : Math.min(400, BUILDINGS[wanted].cost);
  // the Goliath savings: a share of income set aside while the Gantry waits for one (ai/goliath.ts)
  const gantry = myBuildings.find((b) => b.kind === "gantry") ?? null;
  const fundCtx = { gantry: !!gantry || f.pending?.kind === "gantry", armyValue, threatened };
  const fund = goliathFund(w, faction, s, fundCtx);
  let spendable = f.scrap - reserve - fund;
  const liftHeld = liftCondors(w, faction, s);
  /** Queue `kind` at a producer (a building, or an anchored Goliath for squads) if we can pay its price now. */
  const produce = (b: { id: number }, kind: UnitKind | null) => {
    if (!kind || unitBlocker(w, faction, kind) || spendable < unitCost(w, faction, kind)) return;
    spendable -= unitCost(w, faction, kind);
    cmds.push({ type: "produce", faction, buildingId: b.id, unit: kind });
  };
  // --- the Gantry: a Goliath once the fund (and the bank) covers its escalating price
  if (gantry && gantry.queue.length === 0 && wantGoliath(w, faction, s, { ...fundCtx, spendable: f.scrap - reserve })) {
    cmds.push({ type: "produce", faction, buildingId: gantry.id, unit: K.super });
    spendable = f.scrap - reserve - unitCost(w, faction, K.super);
    noteGoliathOrdered(w, s);
  }
  const tech = has("tech-lab");
  const enemyDefenses = knownBuildings(w, faction).filter((kb) => isDefence(kb.kind)).length;
  // anti-air on hand, in Flak Crawlers (intel.ts aaWeight: a Lancer 0.6, a Rocket Squad 1); rifle
  // squads (0.2 each) don't count — a few of them out with the army leave the harvesters bare
  const ownAA = COMBAT_KINDS.reduce((a, k) => a + (aaWeight(UNITS[k]) >= AA_COVER ? have(k) * aaWeight(UNITS[k]) : 0), 0);
  // a ground army that is mostly robot infantry: splash and rapid fire answer it, not big guns
  const infantryHeavy = s.seenInfantry >= 3 && s.seenInfantry >= 0.4 * s.seenGround;

  // floating scrap? keep queues two deep
  const depth = f.scrap > 700 ? 2 : 1;
  // --- Assembly Bay: robot infantry, mixed to what we've seen -------------
  // Rockets for armour (and Ironclad's Mastodon escorts), Snipers for enemy squads
  // (never on Easy), and the personality's share of Troopers. Under Infantry
  // War the Bays field the whole army: Rockets for the defences, more Snipers.
  // Island relays (ai/airlift.ts): squads are what holds them, so the Bays
  // come first, keep a bigger share, and make what the airlift is waiting for.
  const infantryWar = infantryArmy(w, faction);
  // (Airborne: the free Condor needs squads to fly, whatever the personality)
  const infantryShare = infantryWar
    ? 1
    : Math.max(
        s.strategy.infantry ?? 0,
        flysGivenCondor(w, faction, s) ? AIRBORNE_INFANTRY : 0,
        airlifts ? AIRLIFT.infantry : 0
      );
  const infantryValue = INFANTRY_KINDS.reduce((v, k) => v + have(k) * UNITS[k].cost, 0);
  // (the whole force, island garrisons included: the share is of everything we field)
  const forceValue = airlifts ? value(mine.filter((u) => COMBAT_KINDS.includes(u.kind))) : armyValue;
  /** Robot infantry for the Bays' queues: everything (`liftOnly` false), or only the squads the airlift is waiting for. */
  const runBays = (liftOnly = false) => {
    let liftWants = airlifts ? airliftSquadsWanted(s) - INFANTRY_KINDS.reduce((n, k) => n + queued(k), 0) : 0;
    for (const bay of myBuildings.filter((b) => b.kind === "assembly-bay")) {
      if (bay.queue.length >= depth || (liftOnly && liftWants <= 0)) continue;
      const r = rand(s);
      const wantRockets = Math.max(
        Math.round(have(K.heavy) * (s.strategy.escorts ?? 0)),
        Math.round(s.seenHeavy * 0.8),
        infantryWar ? Math.min(6, enemyDefenses) : 0
      );
      const wantSnipers =
        s.difficulty === "easy" || !tech ? 0 : Math.min(infantryWar ? 5 : 3, Math.floor(s.seenInfantry / 3));
      let kind: UnitKind;
      if (have(K.at) < wantRockets) kind = K.at;
      else if (have(K.sniper) < wantSnipers) kind = K.sniper;
      else if (liftWants > 0 || (!liftOnly && infantryValue < infantryShare * Math.max(500, forceValue)))
        // (island garrisons face the enemy's drones alone: Rocket Squads once they fly)
        kind =
          ownAA < Math.ceil(s.seenAir * 0.6) || r < 0.2 || (airlifts && s.seenAir >= 2 && r < 0.5)
            ? K.infAA
            : s.strategy.atShare && r < 0.2 + s.strategy.atShare ? K.at : K.line;
      else continue;
      liftWants--;
      produce(bay, kind);
    }
    // anchored Goliaths train the squads that stand by them (ai/goliath.ts)
    if (!liftOnly) for (const t of goliathBarracks(w, faction, s, () => rand(s), !!hq)) produce(t, t.kind);
  };
  // (island relays: tanks only reach the islands' war over the bridges, at the enemy's base —
  // a capped share of the force, the rest goes to squads, Condors and the air that holds islands)
  const vehicleCap = airlifts ? AIRLIFT.vehicles * Math.max(1000, forceValue) : Infinity;
  const vehicleValue = airlifts ? K.vehicles.reduce((v, k) => v + have(k) * UNITS[k].cost, 0) : 0;
  // healers: one per six of the army (and one for a wounded veteran), plus our super-units' (only healers repair them)
  const superMenders = Math.min(
    GOLIATH_AI.menders,
    Math.max(goliaths.length > 0 ? 1 : 0, goliaths.filter((g) => repairUrgency(g) > 0 || g.hp < UNITS[g.kind].hp * 0.85).length * 3)
  );
  const wantHealer = () =>
    have(K.healer) < Math.min(3, Math.floor(army.length / 6)) + superMenders || (have(K.healer) < 1 && army.some(isWoundedVeteran));
  /** A scout due (one at a time, a minute apart; a second spots for a siege train). */
  const siegeTrain = K.siege !== K.artillery && have(K.siege) > 0;
  const wantScout = () =>
    have(K.scout) < (nation !== "classique" && siegeTrain ? 2 : 1) && w.tick - s.lastScoutTick > 60 * TICK_RATE;
  const runFabs = () => {
    for (const fab of myBuildings.filter((b) => b.kind === "fab-plant")) {
      if (fab.queue.length >= depth) continue;
      let kind: UnitKind = K.light;
      const r = rand(s);
      if (vehicleValue >= vehicleCap && ownAA >= Math.ceil(s.seenAir * 0.6)) continue;
      // (the Empire builds its scout and its healer here: the Estafette, the Atelier roulant)
      if (K.scoutAt === "fab-plant" && wantScout()) {
        s.lastScoutTick = w.tick;
        produce(fab, K.scout);
        continue;
      }
      if (K.healerAt === "fab-plant" && !s.strategy.airOnly && wantHealer() && r < 0.5) {
        produce(fab, K.healer);
        continue;
      }
      // a siege train: two or three of its big guns a wave (Empire: Mortiers de 280)
      const siegeGuns = K.siege === K.artillery ? 0 : s.strategy.siege ? (enemyDefenses >= 2 ? 3 : 2) : enemyDefenses >= 2 ? 1 : 0;
      if (s.strategy.airOnly) {
        // home guard only: a few stingers vs raiders, flak when the skies fill
        if (ownAA < Math.ceil(s.seenAir * 0.5)) kind = K.aa;
        else if (have(K.light) >= 3) continue;
      } else if (ownAA < Math.ceil(s.seenAir * 0.6)) kind = tech && r < 0.35 ? K.techAA : K.aa;
      else if (tech && have(K.siege) < siegeGuns) kind = K.siege;
      else if (tech && have(K.artillery) < Math.min(3, 1 + enemyDefenses) && (enemyDefenses > 0 || r < 0.2))
        kind = K.artillery;
      else if (infantryHeavy && r < 0.65)
        // (a couple of Mortars for the splash; Stingers do the rest — Mortars die fast in a brawl)
        kind = tech && have(K.artillery) < Math.min(3, 1 + Math.floor(s.seenInfantry / 4)) ? K.artillery : K.light;
      else if (tech && s.seenHeavy >= 2 && r < 0.6) kind = K.antiArmour; // lasers burn through armour
      else if (tech && (s.strategy.heavy ? r < 0.45 : r < 0.25)) kind = K.heavy;
      else if (tech && r < (s.strategy.heavy ? 0.8 : 0.5)) kind = K.techArmour;
      produce(fab, kind);
    }
  };
  const runPads = () => {
    for (const pad of myBuildings.filter((b) => b.kind === "airpad")) {
      if (pad.queue.length >= depth) continue;
      // Air War mutator (no Fab Plants): play the air-only plan, and bring bombers for the defences
      const airWar = bannedBy(w, "fab-plant", faction) !== null; // (or an op's "air only")
      const airOnly = s.strategy.airOnly || airWar;
      // (island relays: the air war over the islands decides who holds them)
      const wantRaptors = Math.min(airWar ? 5 : airOnly ? 7 : airlifts ? AIRLIFT.raptors : 4, Math.ceil(s.seenAir * 0.6));
      // (Condors on, or held for, a Goliath's lift aren't the drop plan's or the airlift's)
      const condors = have(K.transport) - liftHeld.size;
      let kind: UnitKind;
      if (K.scoutAt === "airpad" && wantScout()) {
        kind = K.scout;
        s.lastScoutTick = w.tick;
      }
      else if (have(K.interceptor) < wantRaptors && !unitBlocker(w, faction, K.interceptor)) kind = K.interceptor; // (Infantry War: no fighters)
      else if (
        liftWantsCondors(w, faction, s) > queued(K.transport) ||
        (airlifts
          ? airliftWantsCondor(w, faction, s, condors)
          : wantCondor(w, faction, s, condors, K.infantry.reduce((n, k) => (k === K.sniper ? n : n + count(k)), 0)))
      )
        kind = K.transport;
      else if (K.healerAt === "airpad" && wantHealer()) kind = K.healer;
      else if (tech && (airOnly ? rand(s) < (airWar && enemyDefenses > 0 ? 0.55 : 0.4) : rand(s) < 0.25 + s.seenHeavy * 0.08))
        kind = K.bomber;
      else if (s.strategy.heavy && !airlifts && s.seenHeavy < 2 && fabCount(myBuildings) > 0 && rand(s) < 0.5) continue; // save for tanks (not with islands to clear)
      else kind = K.airStrike;
      produce(pad, kind);
    }
  };

  // (island relays: the squads the airlift is waiting for are bought first)
  if (airlifts) runBays(true);
  runFabs();
  runPads();
  runBays();

  // --- scouting -----------------------------------------------------------
  // (a siege train out: the first scout spots for its guns, ahead of them — they see 6, they shoot 11)
  const spotter = nation !== "classique" && siegeTrain ? planSpotter(w, faction, mine, K, hqC, enemyHqPos, seen, cmds) : null;
  for (const scout of mine.filter((u) => K.scouts.includes(u.kind)))
    if (scout.id !== spotter && scout.order.type === "idle") {
      const leg = scoutSweep(w, hqC, s.scoutLeg++);
      cmds.push({ type: "move", faction, unitIds: [scout.id], x: leg.x, y: leg.y });
    }

  // --- expand production when scrap piles up despite full queues ---------
  // (Infantry War: the Bays are the factories; the Airpad only makes Condors, Scouts and Menders)
  const producers = myBuildings.filter((b) =>
    infantryWar ? b.kind === "assembly-bay" : b.kind === "fab-plant" || b.kind === "airpad"
  );
  if (
    f.scrap > 1000 &&
    !f.pending &&
    wanted === null &&
    s.extraProduction < 3 &&
    producers.length > 0 &&
    producers.every((b) => b.queue.length > 0)
  )
    s.extraProduction++;

  // --- anti-air response: SAM sites when the skies fill up ---------------
  if (s.seenAir >= 4 && s.extraSams < 1) s.extraSams = 1;
  if (s.seenAir >= 8 && s.extraSams < 2) s.extraSams = 2;
  // --- …and turrets when robot infantry pours in --------------------------
  if (s.seenInfantry >= 5 && s.extraTurrets < 1) s.extraTurrets = 1;
  if (s.seenInfantry >= 9 && s.extraTurrets < 2) s.extraTurrets = 2;

  // --- mode transitions ----------------------------------------------------
  // the longer the match drags on (from 7:00, 6% a minute, down to half), the lower the bar for an all-in push
  const minutes = w.tick / TICK_RATE / 60;
  const lateGame = Math.max(0.5, 1 - Math.max(0, minutes - 7) * 0.06);
  // (island relays: a wave walks the long way round by the bridges, and an early one bleeds the
  // squads and air the islands need — no all-in below AIRLIFT.assaultFloor there)
  const assaultValue = airlifts ? Math.max(s.strategy.assaultValue, AIRLIFT.assaultFloor) : s.strategy.assaultValue;
  const assaultAt = assaultValue * diff.assaultMult * lateGame;
  const raiders = mine.filter(
    (u) => (u.kind === K.airStrike || (s.strategy.groundRaids && u.kind === K.light)) && u.order.type === "idle"
  );
  if (
    s.mode === "buildup" && diff.harass && raiders.length >= s.strategy.harassGroup &&
    s.seenAA <= raiders.length / 2 && w.tick >= OPENING_GRACE
  )
    s.mode = "harass";
  if (armyValue >= assaultAt && s.mode !== "assault") {
    s.mode = "assault";
    s.waveValue = armyValue;
  }
  if (s.mode === "assault" && armyValue < Math.max(RETREAT_ARMY_VALUE, s.waveValue * 0.25)) s.mode = "buildup";
  // Last Stand: there is no enemy base to raid or assault — defend
  if (w.survival) s.mode = "buildup";

  // ======================= tactics =========================================
  const used = new Set<number>(dodgingUnits(w, s)); // units running from a reticle stay put
  if (spotter !== null) used.add(spotter);
  // squads walking up a Condor's ramp, or dropped on a raid, follow the drop plan (ai/condor.ts)
  for (const id of condorHolds(w, s)) used.add(id);
  for (const id of airliftHolds(w, s)) used.add(id);
  const idleArmy = () => army.filter((u) => u.order.type === "idle" && !used.has(u.id));

  // --- 0. wounded veterans fall back to a Mender or the HQ ----------------
  cmds.push(...veteranRetreats(faction, army, hqC, used, w));
  // --- 0b. Menders follow whoever needs them, and come home when nobody does
  // (ai/menders.ts; no wave, guard post or sweep takes them after this; our Goliaths first)
  cmds.push(...planMenders(faction, army, myBuildings, used, hqC, enemyHqPos, goliaths, w));

  // --- 1. threat response: answer unengaged intruders with counters -------
  for (const t of threats.slice(0, 3)) {
    const wantedValue = t.value * 1.5;
    // (and can hurt it: no Sniper Team sent at a tank)
    // (and can get at it: no tank sent at a squad on an island)
    const capable = idleArmy()
      .filter(
        (u) =>
          canHitDomain(UNITS[u.kind].targets, t.domain) && effectivenessVs(u.kind, UNITS[t.kind].armor, t.domain) >= USELESS &&
          canGetWithin(w, moveClassOf(u.kind), u.x, u.y, t.x, t.y, UNITS[u.kind].range)
      )
      .sort((a, b) => dist(a.x, a.y, t.x, t.y) - dist(b.x, b.y, t.x, t.y));
    const squad: number[] = [];
    let v = 0;
    for (const u of capable) {
      if (v >= wantedValue) break;
      squad.push(u.id);
      used.add(u.id);
      v += UNITS[u.kind].cost;
    }
    if (squad.length > 0) cmds.push({ type: "attack", faction, unitIds: squad, targetId: t.id });
  }

  // --- 1b. home defence: a real attack on the base recalls the army -------
  // (with quick-start openers an 8-unit push can land at 1:00; an army out
  // raiding must not leave the HQ to die)
  const homeGuard = value(army.filter((u) => dist(u.x, u.y, hqC.x, hqC.y) <= DEFENSE_RADIUS));
  if (raidValue >= HOME_ALARM_VALUE && raidValue > homeGuard) {
    s.mode = "buildup";
    const away = army.filter(
      (u) =>
        !used.has(u.id) &&
        dist(u.x, u.y, hqC.x, hqC.y) > DEFENSE_RADIUS &&
        dist(u.x, u.y, enemyHome.x, enemyHome.y) > 8 && // about to finish the job there
        atHome.some((t) => canHitDomain(UNITS[u.kind].targets, t.domain))
    );
    if (away.length > 0) {
      away.forEach((u) => used.add(u.id));
      cmds.push({ type: "attackMove", faction, unitIds: away.map((u) => u.id), x: hqC.x, y: hqC.y });
    }
  }
  // --- 1c. Goliaths: ours dig in, hold, move on, lift, walk with a wave; theirs are hunted (ai/goliath.ts)
  // (escorts and strikes already under way stay on task)
  for (const id of goliathHolds(w, s)) used.add(id);
  const staging = towardEnemy(w, hqC, 9, enemyHqPos);
  cmds.push(
    ...planGoliaths(w, faction, s, { army, used, hqC, enemyHqPos, seen, mode: s.mode, threatened, staging, guardPoint, hasHq: !!hq })
  );
  cmds.push(...huntGoliaths(w, faction, s, { army, used, seen, enemyHqPos, mode: s.mode, threatened }));

  // Uplink garrisons, capture squads and crate runners stay on task (ai/objectives.ts)
  for (const id of objectiveHolds(w, faction, s)) used.add(id);

  // --- 1d. Condor drops on the enemy's harvesters (ai/condor.ts) ----------
  // (two cheap squads picked before the guard takes its share: the drop is a deliberate commitment)
  // (island relays: every Condor flies the airlift instead, ai/airlift.ts)
  // (never a Condor on, or held for, a Goliath's lift: ai/goliath.ts)
  const skip = liftCondors(w, faction, s);
  if (airlifts) cmds.push(...planAirlift(w, faction, s, { mine, army, used, hqC, seen, threatened, skip }));
  else cmds.push(...planCondor(w, faction, s, { army, used, hqC, threatened, skip }));

  // --- 2. economy guard: a share of the army holds the mining line --------
  const guardShare = s.mode === "assault" ? 0.15 : 0.35;
  const guardValue = value(army.filter((u) => dist(u.x, u.y, guardPoint.x, guardPoint.y) <= GUARD_RADIUS));
  if (guardValue < guardShare * armyValue) {
    let need = guardShare * armyValue - guardValue;
    const recruits = idleArmy()
      .filter((u) => !K.guns.includes(u.kind) && dist(u.x, u.y, guardPoint.x, guardPoint.y) > GUARD_RADIUS)
      .sort(
        (a, b) =>
          dist(a.x, a.y, guardPoint.x, guardPoint.y) - dist(b.x, b.y, guardPoint.x, guardPoint.y)
      );
    const squad: number[] = [];
    for (const u of recruits) {
      if (need <= 0) break;
      squad.push(u.id);
      used.add(u.id);
      need -= UNITS[u.kind].cost;
    }
    if (squad.length > 0)
      cmds.push({ type: "attackMove", faction, unitIds: squad, x: guardPoint.x, y: guardPoint.y });
  }

  // --- 2b. map objectives: take Uplinks, hold them, race for supply crates --
  cmds.push(
    ...planObjectives(w, faction, s, {
      mode: s.mode, hqC, guardPoint, guardNeed: guardShare * armyValue, army, used,
      threatened: raidValue >= HOME_ALARM_VALUE, enemyHqPos
    })
  );

  // --- 3/4. offence by mode -----------------------------------------------

  /** The wave launched this pass (ai/powers.ts: the Pression des chaudières goes with it). */
  let wave: Unit[] = [];
  if (s.mode === "harass") {
    const group = raiders.filter((u) => !used.has(u.id));
    const raid = enemyHarvestArea(w, faction, hqC, seen);
    const flying = group.filter((u) => UNITS[u.kind].domain === "air").length;
    // raiders don't fly into flak (seen now, or remembered): they wait for
    // the main assault instead
    if (flying > group.length / 2 && (aaStrengthAt(aaSources(w, faction, seen), raid.x, raid.y) >= AA_COVER || s.seenAA > group.length / 2))
      s.mode = "buildup";
    else if (group.length >= s.strategy.harassGroup) {
      const ids = group.map((u) => u.id);
      ids.forEach((id) => used.add(id));
      if (raid.targetId !== undefined)
        cmds.push({ type: "attack", faction, unitIds: ids, targetId: raid.targetId });
      else cmds.push({ type: "attackMove", faction, unitIds: ids, x: raid.x, y: raid.y });
    }
  } else if (s.mode === "assault") {
    // staged waves: gather at a forward point, launch together
    const staged = army.filter(
      (u) => !used.has(u.id) && dist(u.x, u.y, staging.x, staging.y) <= STAGE_RADIUS
    );
    // (a Goliath waiting there to walk with the wave counts for what it can fire, ai/goliath.ts, but
    // never for more than the army staged beside it: alone it would launch empty waves every pass,
    // and the rest of the army would never be called up to the staging point)
    const goliathStaged = goliaths.reduce(
      (v, g) => (canWalk(g) && dist(g.x, g.y, staging.x, staging.y) <= STAGE_RADIUS ? v + threatValue(g) : v),
      0
    );
    const stagedValue = value(staged) + Math.min(goliathStaged, value(staged));
    // Air War: fragile aircraft trickling in just feed the defences, so launch one big wave
    const airWar = bannedBy(w, "fab-plant", faction) !== null && !infantryWar;
    const launchAt = airWar ? assaultAt : Math.max(450, assaultAt * WAVE_LAUNCH);

    if (stagedValue >= launchAt) {
      const target = pickPriorityTarget(w, faction, seen, enemyHqPos);
      // robot infantry still marching up (1.6–1.8 tiles/s) goes with the wave, not left for the next one
      const marching = army.filter(
        (u) =>
          isInfantry(u.kind) && !used.has(u.id) && u.order.type === "attackMove" &&
          dist(u.order.x, u.order.y, staging.x, staging.y) < 1 && dist(u.x, u.y, staging.x, staging.y) <= 2 * STAGE_RADIUS &&
          !staged.includes(u)
      );
      launchWave(w, cmds, faction, [...staged, ...marching], target, used);
      wave = staged;
      s.waves = (s.waves ?? 0) + 1;
      s.firstWaveTick ??= w.tick;
    } else {
      for (const u of idleArmy()) {
        if (dist(u.x, u.y, enemyHqPos.x, enemyHqPos.y) < 14) {
          // already deep in enemy territory: keep fighting, don't yo-yo home
          const target = pickPriorityTarget(w, faction, seen, enemyHqPos);
          launchWave(w, cmds, faction, [u], target, used);
        } else if (dist(u.x, u.y, staging.x, staging.y) > STAGE_RADIUS) {
          used.add(u.id);
          cmds.push({ type: "attackMove", faction, unitIds: [u.id], x: staging.x, y: staging.y });
        }
      }
    }
  }

  // --- Last Stand: hold a line toward the incoming wave, engage the siege ---
  if (w.survival) {
    const hold = survivalHoldPoint(w, faction);
    if (hold) {
      const squad = idleArmy()
        .filter((u) => (hold.engage ? !K.guns.includes(u.kind) || dist(u.x, u.y, hold.x, hold.y) > 7 : true))
        .filter((u) => dist(u.x, u.y, hold.x, hold.y) > (hold.engage ? 2 : STAGE_RADIUS))
        .map((u) => u.id);
      squad.forEach((id) => used.add(id));
      if (squad.length > 0) cmds.push({ type: "attackMove", faction, unitIds: squad, x: hold.x, y: hold.y });
    }
    // strong enough for what's next and nothing on the field: bring it on
    if (earlyCallBonus(w) > 0 && armyValue >= 1.8 * waveBudget(w.survival.difficulty, w.survival.wave + 1))
      cmds.push({ type: "callWave", faction });
  }

  // --- 4b. salvage: once a fight near home is over, sweep up the wrecks ----
  cmds.push(
    ...planSalvage(w, faction, {
      army, harvesters, buildings: myBuildings, used, threatened: raidValue >= HOME_ALARM_VALUE, assault: s.mode === "assault"
    })
  );

  // --- 4c. commander calldowns (ai/powers.ts) ------------------------------
  cmds.push(...planCalldowns(w, faction, s, { mode: s.mode, hqC, guardPoint, enemyHqPos, army, threats, wave }));

  return cmds;
}

const fabCount = (bs: Building[]) => bs.filter((b) => b.kind === "fab-plant").length;

/** Is any field left on our side (`ourSide`) of an island map, on the land our HQ stands (or stood) on? */
function ownFieldLeft(w: World, hqC: { x: number; y: number }, ourSide: (tx: number, ty: number) => boolean): boolean {
  const home = regionAt(w, Math.floor(hqC.x), Math.floor(hqC.y), "ground");
  const labels = regionLabels(w, "ground");
  for (let i = 0; i < labels.length; i++)
    if (isResource(w, i) && labels[i] === home && ourSide(i % w.width, Math.floor(i / w.width))) return true;
  return false;
}

/** A point `d` tiles from `from` toward the enemy HQ (or the map mirror). */
function towardEnemy(w: World, from: { x: number; y: number }, d: number, to?: { x: number; y: number }) {
  const target = to ?? mirror(w, from.x, from.y);
  const len = Math.max(1, dist(from.x, from.y, target.x, target.y));
  return { x: from.x + ((target.x - from.x) / len) * d, y: from.y + ((target.y - from.y) / len) * d };
}

interface PriorityTarget {
  id?: number;
  x: number;
  y: number;
  domain: Domain;
  armor: ArmorClass;
}

/**
 * Harvesters first, then production buildings, then defences, then the HQ.
 * A Gantry with a Goliath on its cradle (public: GOLIATH.md) comes before
 * all of them (killed mid-build, the progress is lost); once the enemy HQ is
 * seen gone, its Goliaths are what's left to beat, so they come first; and
 * with nothing else known, the nearest Goliath beats an empty plot.
 */
function pickPriorityTarget(w: World, faction: Faction, seen: Unit[], fallback: { x: number; y: number }): PriorityTarget {
  const building = enemyGantryBuilds(w, faction).sort(
    (a, b) => dist(a.x, a.y, fallback.x, fallback.y) - dist(b.x, b.y, fallback.x, fallback.y) || a.id - b.id
  )[0];
  if (building) return { id: building.id, x: building.x, y: building.y, domain: "ground", armor: "structure" };
  const enemyGoliaths = seen
    .filter((u) => !!u.goliath)
    .sort((a, b) => dist(a.x, a.y, fallback.x, fallback.y) - dist(b.x, b.y, fallback.x, fallback.y) || a.id - b.id);
  const goliath = enemyGoliaths[0];
  const goliathTarget = (g: Unit): PriorityTarget => ({ id: g.id, x: g.x, y: g.y, domain: domainOf(g), armor: UNITS[g.kind].armor });
  if (goliath && enemyHqGone(w, faction, fallback)) return goliathTarget(goliath);
  let best: PriorityTarget | null = null;
  let bestD = Infinity;
  for (const u of seen) {
    if (!isWorker(u.kind)) continue;
    const d = dist(u.x, u.y, fallback.x, fallback.y);
    if (d < bestD) {
      bestD = d;
      best = { id: u.id, x: u.x, y: u.y, domain: "ground", armor: UNITS[u.kind].armor };
    }
  }
  if (best) return best;
  const known = knownBuildings(w, faction);
  for (const kinds of [["gantry", "fab-plant", "airpad", "assembly-bay", "tech-lab", "depot"], ["turret", "sam-site", "arsonval", "flak-battery", "radar"], ["hq"]] as const) {
    const cands = known.filter((kb) => (kinds as readonly string[]).includes(kb.kind));
    // by footprint centre (a top-left corner is not mirror-symmetric)
    const centre = (kb: (typeof cands)[number]) => BUILDINGS[kb.kind].size / 2;
    cands.sort(
      (a, b) =>
        dist(a.tx + centre(a), a.ty + centre(a), fallback.x, fallback.y) -
        dist(b.tx + centre(b), b.ty + centre(b), fallback.x, fallback.y)
    );
    const b = cands[0];
    if (b) {
      const size = BUILDINGS[b.kind].size;
      return { id: b.id, x: b.tx + size / 2, y: b.ty + size / 2, domain: "ground", armor: "structure" };
    }
  }
  if (goliath) return goliathTarget(goliath);
  return { x: fallback.x, y: fallback.y, domain: "ground", armor: "structure" };
}

/** Send a wave at a target: attackers attack it, the rest (and anything that can't hurt it, a Sniper Team at a building) escort. */
function launchWave(
  w: World,
  cmds: Command[],
  faction: Faction,
  units: Unit[],
  target: PriorityTarget,
  used: Set<number>
): void {
  // a remembered building may have died out of sight: an attack on its id
  // idles the wave on the spot, so march on its last known position instead
  // (the same place either way; arriving re-sees the footprint, forgets the ghost)
  const id = target.id !== undefined && (w.units.has(target.id) || w.buildings.has(target.id)) ? target.id : undefined;
  const attackers: number[] = [];
  const escorts: number[] = [];
  for (const u of units) {
    used.add(u.id);
    if (id !== undefined && effectivenessVs(u.kind, target.armor, target.domain) >= USELESS) attackers.push(u.id);
    else escorts.push(u.id);
  }
  if (attackers.length > 0 && id !== undefined)
    cmds.push({ type: "attack", faction, unitIds: attackers, targetId: id });
  if (escorts.length > 0)
    cmds.push({ type: "attackMove", faction, unitIds: escorts, x: target.x, y: target.y });
}

interface Threat {
  id: number;
  x: number;
  y: number;
  kind: UnitKind;
  /** Where it is now (a Goliath on a lift is in the air). */
  domain: Domain;
  /** What it's worth as a threat (ai/goliath.ts threatValue: a Goliath by what it can still fire). */
  value: number;
}

/** Visible armed enemy units (and the Menders keeping them going) close to our buildings or harvesters. */
function findThreats(
  w: World,
  faction: Faction,
  seen: Unit[],
  myBuildings: Building[],
  harvesters: Unit[]
): Threat[] {
  const out: Threat[] = [];
  for (const u of seen) {
    if (UNITS[u.kind].dps <= 0 && !UNITS[u.kind].heal) continue;
    const nearBuilding = myBuildings.some((b) => {
      const c = buildingCenter(b);
      return dist(u.x, u.y, c.x, c.y) <= DEFENSE_RADIUS;
    });
    const nearHarvester = harvesters.some((h) => dist(u.x, u.y, h.x, h.y) <= 6);
    const nearUplink = w.objectives.uplinks.some(
      (l) => l.owner === faction && dist(u.x, u.y, l.x, l.y) <= OBJECTIVES.uplink.radius + 2
    );
    if (nearBuilding || nearHarvester || nearUplink)
      out.push({ id: u.id, x: u.x, y: u.y, kind: u.kind, domain: domainOf(u), value: threatValue(u) });
  }
  return out;
}

/**
 * Tally the enemy units we can see (`seen`: fog and Sniper concealment
 * applied) by domain, heavy armour, anti-air (in Flak, aaWeight) and robot
 * infantry. An enemy Goliath counts as GOLIATH_AI.heavyWeight heavy units
 * (the Rocket Squads, Lancers and Hornets that answer it come with that),
 * with the anti-air of the weapons it can fire now; one taking shape on a
 * Gantry (`gantryBuilds`, public) pre-arms the counters.
 */
function observeEnemy(s: AiState, seen: Unit[], gantryBuilds = 0): void {
  let air = 0;
  let ground = 0;
  let heavy = gantryBuilds * GOLIATH_AI.gantryWeight;
  let aa = 0;
  let infantry = 0;
  for (const u of seen) {
    if (isWorker(u.kind)) continue;
    if (domainOf(u) === "air") air += airWeight(u.kind);
    else ground++;
    if (u.goliath) heavy += GOLIATH_AI.heavyWeight;
    else if (UNITS[u.kind].armor === "heavy") heavy++;
    aa += unitAntiAir(u).weight;
    if (isInfantry(u.kind)) infantry++;
  }
  // ratchet up quickly, decay slowly (~1 min half-life at 2s decisions) —
  // a glimpse of a wasp pack should keep informing production for a while
  s.seenAir = Math.max(air, s.seenAir * 0.97);
  s.seenGround = Math.max(ground, s.seenGround * 0.97);
  s.seenHeavy = Math.max(heavy, s.seenHeavy * 0.97);
  s.seenAA = Math.max(aa, s.seenAA * 0.97);
  s.seenInfantry = Math.max(infantry, s.seenInfantry * 0.97);
}

/**
 * First entry of the build order (plus reactive SAMs) not yet satisfied.
 * `gantry` (ai/goliath.ts wantGantry): a Gantry after the build order, with
 * whatever it still needs of its four prerequisites first. Outposts (built
 * in a Goliath's ring, far from base) don't count toward the base's order.
 */
function nextBuilding(
  w: World,
  faction: Faction,
  myBuildings: Building[],
  s: AiState,
  gantry = false,
  fits?: (kind: BuildingKind) => boolean
): BuildingKind | null {
  const have = new Map<BuildingKind, number>();
  // (with no HQ every building is an outpost: then they're the base)
  const hasHq = !!hqOf(w, faction);
  for (const b of myBuildings) if (!b.outpost || !hasHq) have.set(b.kind, (have.get(b.kind) ?? 0) + 1);
  // Infantry War: an Assembly Bay wherever the plan says Fab Plant
  const infantryWar = infantryArmy(w, faction);
  const order = s.strategy.buildOrder.map((k): BuildingKind => (infantryWar && k === "fab-plant" ? "assembly-bay" : k));
  // Last Stand: static defences earn their keep against endless waves
  if (w.survival) order.push("turret", "sam-site", "turret", "turret", "sam-site", "turret");
  for (let i = 0; i < s.extraSams; i++) order.splice(Math.min(order.length, 2 + i), 0, "sam-site");
  for (let i = 0; i < s.extraTurrets; i++) order.splice(Math.min(order.length, 2 + i), 0, "turret");
  // Mastodons (or Hornets) seen, or a Condor to fill (Airborne): an Assembly Bay, early in the queue
  if (((s.strategy.bayVsArmour && s.seenHeavy >= 2) || flysGivenCondor(w, faction, s)) && !order.includes("assembly-bay"))
    order.splice(Math.min(order.length, 3), 0, "assembly-bay");
  // island relays (ai/airlift.ts): squads hold them, so the Assembly Bay comes
  // second; and an Airpad by third, for more Condors and the air that clears
  // islands — and a second one by sixth (the islands' war is fought in the air)
  if (airliftActive(w, faction, s)) {
    (["assembly-bay", "airpad"] as const).forEach((k, slot) => {
      const i = order.indexOf(k);
      if (i >= 0 && i <= slot + 1) return;
      if (i > 0) order.splice(i, 1);
      order.splice(Math.min(order.length, slot + 1), 0, k);
    });
    if (order.filter((k) => k === "airpad").length < 2) order.splice(Math.min(order.length, 5), 0, "airpad");
  }
  // the Gantry (and the prerequisites it lacks, all four needed) once the order is through
  if (gantry) {
    for (const k of BUILDINGS.gantry.requiresAll ?? []) if (!order.includes(k)) order.push(k);
    order.push("gantry");
  }
  // a nation builds its own defences where the plan names the shared ones (§1.9 buildingFor)
  const nation = nationOf(w, faction);
  if (nation !== "classique") for (let i = 0; i < order.length; i++) order[i] = buildingFor(nation, order[i]!);
  const fabs = order.filter((k) => k === "fab-plant").length;
  const pads = order.filter((k) => k === "airpad").length;
  const noFab = bannedBy(w, "fab-plant", faction) !== null; // Air War mutator (or an op)
  for (let i = 0; i < s.extraProduction; i++) {
    const air = s.strategy.airOnly || noFab || (!s.strategy.heavy && pads + (i % 2) <= fabs);
    order.push(infantryWar ? "assembly-bay" : air ? "airpad" : "fab-plant");
  }
  const wanted = new Map<BuildingKind, number>();
  let depotsSkipped = 0;
  for (const kind of order) {
    wanted.set(kind, (wanted.get(kind) ?? 0) + 1);
    if ((have.get(kind) ?? 0) >= wanted.get(kind)!) continue;
    if (kind === "depot" && depotsSkipped < 3) {
      // only worth it if there's a distant field we can actually reach
      const hq = hqOf(w, faction);
      if (!hq || !depotSite(w, faction, buildingCenter(hq))) {
        depotsSkipped++;
        continue;
      }
    }
    if (buildingBlocker(w, faction, kind)) continue;
    if (fits && !fits(kind)) continue; // (no room for it in any ring: the next thing that fits)
    return kind;
  }
  return null;
}

/** A spot for a forward depot next to a field far from existing drop-offs. */
function depotSite(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  unpowered = false
): { spot: { tx: number; ty: number }; field: { x: number; y: number } } | null {
  const fr = sideFrame(w, faction); // scanned in the side's own frame (mirror-fair ties)
  let best: { x: number; y: number; d: number } | null = null;
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const drop = nearestDropOff(w, faction, tx + 0.5, ty + 0.5);
      if (!drop) continue;
      const dc = buildingCenter(drop);
      if (dist(tx + 0.5, ty + 0.5, dc.x, dc.y) < 9) continue; // already served
      const d = dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y);
      if (!best || d < best.d) best = { x: tx + 0.5, y: ty + 0.5, d };
    }
  if (!best || best.d > 24) return null;
  const spot = findPlacementSpot(w, faction, "depot", best, unpowered);
  if (!spot || dist(spot.tx + 1, spot.ty + 1, best.x, best.y) > 5) return null;
  // reachable by ground from just behind the HQ (in the side's own frame)
  if (!findPath(w, hqC.x, hqC.y + (fr.flip ? -2.5 : 2.5), best.x, best.y, "ground", faction)) return null;
  return { spot, field: { x: best.x, y: best.y } };
}

/** Closest placeable spot to `anchor` within build range of our base. */
function findPlacementSpot(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  anchor: { x: number; y: number },
  unpowered = false
): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  // the République's power network: only inside a source's radius (ai/roles.ts), unless asked where it would go anyway
  const sources = !unpowered && needsPower(nationOf(w, faction), kind) ? powerSources(w, faction) : null;
  // candidates are generated and compared in the side's own frame, so ties
  // (common: spots equidistant from the HQ) resolve as mirror images
  const fr = sideFrame(w, faction);
  const a = fr.pt(anchor);
  let best: { tx: number; ty: number } | null = null;
  let bestD = Infinity;
  // round every building of the base (outposts never give build range) and every dug-in Goliath's ring
  const centres: { c: { x: number; y: number }; r: number }[] = [];
  for (const b of w.buildings.values())
    if (b.faction === faction && !b.outpost) centres.push({ c: buildingCenter(b), r: ECONOMY.buildRadius + 2 });
  const dugIn = goliathsOf(w, faction).filter(isAnchored);
  if (kind !== "hq") for (const g of dugIn) centres.push({ c: g, r: Math.ceil(GOLIATH.buildRing + size) });
  /** A tile's lane round a dug-in Goliath's feet stays open (it walks out again once packed up). */
  const atFeet = (tx: number, ty: number) => dugIn.some((g) => distToFootprint(tx, ty, size, g.x, g.y) < GOLIATH.footprint / 2 + 1);
  for (const { c: at, r } of centres) {
    const c = fr.pt(at);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const fx = Math.round(c.x + dx - size / 2);
        const fy = Math.round(c.y + dy - size / 2);
        const d = dist(fx + size / 2, fy + size / 2, a.x, a.y);
        if (d >= bestD) continue;
        const [tx, ty] = fr.tile(fx, fy, size);
        if (sources && !poweredAt(sources, tx, ty, size)) continue;
        if (!canPlaceBuilding(w, faction, kind, tx, ty)) continue;
        // keep a lane open: don't wall the HQ in with production buildings
        if (size > 1 && tooCramped(w, tx, ty, size)) continue;
        if (dugIn.length > 0 && atFeet(tx, ty)) continue;
        best = { tx, ty };
        bestD = d;
      }
  }
  return best;
}

/** Would a building here leave no free tile along any side (walling in)? */
function tooCramped(w: World, tx: number, ty: number, size: number): boolean {
  let free = 0;
  for (let i = -1; i <= size; i++)
    for (const [x, y] of [
      [tx + i, ty - 1],
      [tx + i, ty + size],
      [tx - 1, ty + i],
      [tx + size, ty + i]
    ] as [number, number][]) {
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      if (w.occupancy[y * w.width + x] === 0) free++;
    }
  return free < (size + 2) * 2;
}

/** Corner-sweep waypoints for scouts, biased toward the far half. */
function scoutSweep(w: World, c: { x: number; y: number }, leg: number): { x: number; y: number } {
  const far = mirror(w, c.x, c.y);
  const stops = [
    far,
    { x: far.x, y: c.y },
    { x: c.x, y: far.y },
    { x: w.width / 2, y: w.height / 2 }
  ];
  return stops[leg % stops.length]!;
}

/** Where the enemy probably mines: their side's scrap, or mirror of ours. */
function enemyHarvestArea(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  seen: Unit[]
): { x: number; y: number; targetId?: number } {
  // a Gantry with a Goliath on the cradle beats anything (killed mid-build, the build is lost)
  const gantry = enemyGantryBuilds(w, faction).sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y) || a.id - b.id)[0];
  if (gantry) return { x: gantry.x, y: gantry.y, targetId: gantry.id };
  // a visible enemy harvester is the best target
  for (const u of seen) if (isWorker(u.kind)) return { x: u.x, y: u.y, targetId: u.id };
  const own = nearestScrapTile(w, hqC.x, hqC.y, faction);
  if (own) return mirror(w, own.x + 0.5, own.y + 0.5);
  return mirror(w, hqC.x, hqC.y);
}

/**
 * The nearest radium (crystal) the side can reach from home, within
 * RADIUM_REACH tiles of it (and on its side of an island map's bridges), or
 * null. The République mines it first (§1.9: its radium pays 50% more).
 */
const RADIUM_REACH = 20;
function radiumField(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  ourSide: (tx: number, ty: number) => boolean
): { x: number; y: number } | null {
  const near = (tx: number, ty: number) => dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y) <= RADIUM_REACH;
  // (only worth a search when there's crystal in reach at all: a fruitless search floods the map)
  let any = false;
  for (let ty = Math.max(0, Math.floor(hqC.y - RADIUM_REACH)); ty < Math.min(w.height, hqC.y + RADIUM_REACH) && !any; ty++)
    for (let tx = Math.max(0, Math.floor(hqC.x - RADIUM_REACH)); tx < Math.min(w.width, hqC.x + RADIUM_REACH); tx++) {
      const i = tileIndex(w, tx, ty);
      if (w.terrain[i] === Terrain.Crystal && isResource(w, i) && near(tx, ty) && ourSide(tx, ty)) {
        any = true;
        break;
      }
    }
  if (!any) return null;
  return nearestReachableResource(w, hqC.x, hqC.y, faction, (tx, ty) => {
    const i = tileIndex(w, tx, ty);
    return w.terrain[i] === Terrain.Crystal && near(tx, ty) && ourSide(tx, ty);
  });
}

/**
 * Spotting for a siege train (the Empire's Mortiers de 280 see 6 tiles and
 * shoot 11): the first scout goes ahead of the guns, to 6.5 tiles short of
 * what they'd shoot — the nearest known enemy building to them, else the
 * enemy HQ — on their side. Returns the scout's id (or null with none, or
 * with the guns still at home).
 */
function planSpotter(
  w: World,
  faction: Faction,
  mine: Unit[],
  K: AiKinds,
  hqC: { x: number; y: number },
  enemyHqPos: { x: number; y: number },
  seen: Unit[],
  cmds: Command[]
): number | null {
  const guns = mine.filter((u) => u.kind === K.siege);
  const scout = mine.filter((u) => K.scouts.includes(u.kind)).sort((a, b) => a.id - b.id)[0];
  if (!scout || guns.length === 0) return null;
  const gx = guns.reduce((a, u) => a + u.x, 0) / guns.length;
  const gy = guns.reduce((a, u) => a + u.y, 0) / guns.length;
  if (dist(gx, gy, hqC.x, hqC.y) < 8) return null; // (the guns are home: the scout scouts)
  let target = enemyHqPos;
  let bestD = Infinity;
  for (const kb of knownBuildings(w, faction)) {
    const size = BUILDINGS[kb.kind].size;
    const d = dist(kb.tx + size / 2, kb.ty + size / 2, gx, gy);
    if (d < bestD) {
      bestD = d;
      target = { x: kb.tx + size / 2, y: kb.ty + size / 2 };
    }
  }
  // (an armed enemy close by: hang back with the guns)
  const danger = seen.some((e) => UNITS[e.kind].dps > 0 && dist(e.x, e.y, scout.x, scout.y) <= UNITS[e.kind].range + 1.5);
  const d = Math.max(1, dist(target.x, target.y, gx, gy));
  const k = danger ? 0 : Math.max(0, d - 6.5) / d;
  const at = { x: gx + (target.x - gx) * k, y: gy + (target.y - gy) * k };
  const o = scout.order;
  const going = o.type === "move" && dist(o.x, o.y, at.x, at.y) <= 2;
  if (!going && dist(scout.x, scout.y, at.x, at.y) > 2) cmds.push({ type: "move", faction, unitIds: [scout.id], x: at.x, y: at.y });
  return scout.id;
}

export type { Unit };
