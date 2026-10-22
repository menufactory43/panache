import { BUILDINGS, COMBAT, POWER_SETS, ROLES, ROSTERS, TERRAIN, TICK_RATE, UNITS } from "./balance";
import { createAiState, type AiState, type Difficulty, type PersonalityName, type Strategy } from "./ai/commander";
import { nearestReachableResource } from "./economy";
import { setupSurvival, wavesSurvived, type SurvivalOptions } from "./modes/survival";
import { PLURALS, displayName, isFeminine, pluralName } from "./lexicon";
import { mapById } from "./maps";
import { behaves, buildingMaxHp, holdOf, nationStart } from "./nations";
import { NO_GROUND_COMBAT, makeRules, nationOf, type MutatorId } from "./rules";
import type { BuildingKind, Faction, FxEvent, Nation, NationOrClassic, PowerKind, Unit, UnitKind, World } from "./types";
import { carrierOf, dropPoint, stowAboard } from "./transport";
import { hypot } from "./fmath";
import { setupLifeline } from "./lifeline";
import { spawnSuper } from "./goliath";
import { buildingCenter, hqOf, inBounds, moveClassOf, passable, spawnBuilding, spawnUnit, terrainAt } from "./world";

/**
 * Ops: handcrafted scenarios on the existing maps, each with a twist
 * objective and a three-star rating. An op is data — a map, an enemy (an AI
 * commander with a fixed personality, the Last Stand wave director, or
 * nobody), rules (per-side bans, a frozen economy, mutators), a setup
 * function that pre-places buildings and units, primary goals and two star
 * conditions.
 *
 * Two books of ops (PANACHE-CONCEPTION.md §2):
 *  - CAMPAIGN, « La Campagne de 1900 »: twelve missions in three acts played
 *    with the nations (République or Empire), silent-film cards before and
 *    after each, and the player's arsenal growing mission by mission
 *    (CAMPAIGN_UNLOCKS). They keep the old op ids, so records and stars carry over.
 *  - TRIALS, « Épreuves »: the eight original symmetric ops in Classique,
 *    ids suffixed `-classique`.
 *
 * Goals are pure functions of the world, evaluated once per second by
 * tickOps() (called from step() only when World.ops is set). Meeting every
 * primary goal — or destroying the enemy HQ, as ever — wins the op; failing
 * one loses it. Either way tickOps sets World.winner, so the normal end flow
 * (finale, report, career) runs unchanged. Deterministic: no Math.random.
 */

declare module "./types" {
  interface Building {
    /** Ops: a landmark's toughness (the Eiffel Tower: ×4); nations.ts buildingMaxHp multiplies by it. */
    hpMult?: number;
  }
}

// ------------------------------------------------------------------ goals ---

export type Goal =
  /** Destroy the enemy HQ. */
  | { type: "destroyHq" }
  /** Destroy `count` enemy units or buildings of a kind (only those a setup tagged `tag`, when given). */
  | { type: "destroy"; kind: UnitKind | BuildingKind; count: number; tag?: string; short?: string; done?: string; label?: string }
  /** Keep the HQ standing until the clock reaches `secs`. */
  | { type: "survive"; secs: number }
  /** Last Stand ops: survive `count` waves. */
  | { type: "waves"; count: number }
  /** Harvest (deliver to a drop-off) this much scrap. */
  | { type: "deliver"; scrap: number }
  /** Keep at least `min` of a tagged group (from setup) or of an own kind alive. */
  | { type: "protect"; tag?: string; kind?: UnitKind | BuildingKind; min: number; label: string; short?: string; lost?: string }
  /** Bring at least `count` of a tagged group within `radius` tiles of (x, y) (achieved once, then it stays done). */
  | { type: "reach"; tag: string; x: number; y: number; radius: number; count: number; label: string; short?: string }
  /** Finish before the clock reaches `secs`. */
  | { type: "within"; secs: number }
  /** Lose at most `n` units (of `kind`, or buildings when `buildings`). */
  | { type: "maxLosses"; n: number; kind?: UnitKind; buildings?: boolean };

/** done = achieved · ok = holding (a condition not yet broken) · pending = not there yet · failed = broken. */
export type GoalState = "done" | "ok" | "pending" | "failed";

export interface GoalEval {
  state: GoalState;
  /** Compact label and value for the HUD pill ("Hold", "2:41"). */
  label: string;
  value: string;
  /** 0..1 toward an achievement goal (or what's left of a timer). */
  progress: number;
}

/** Goals that must be achieved (the rest are conditions that must not break). */
const ACHIEVE = new Set<Goal["type"]>(["destroyHq", "destroy", "survive", "waves", "deliver", "reach"]);
export const isAchieveGoal = (g: Goal): boolean => ACHIEVE.has(g.type);

// --------------------------------------------------------------- op defs ---

export interface OpAi {
  strategy: PersonalityName;
  difficulty: Difficulty;
  /** Personality overrides (e.g. a commander that never attacks). */
  tweak?: Partial<Strategy>;
}

export interface OpRules {
  mutators?: MutatorId[];
  /** Kinds the player (blue) may not build (campaign: on top of what the arsenal hasn't unlocked yet). */
  playerBans?: { units?: UnitKind[]; buildings?: BuildingKind[]; powers?: PowerKind[] };
  /** Player income multiplier (0 = frozen economy: no harvesting, no HQ trickle). */
  playerIncome?: number;
  /** Enemy income multiplier (a commander that digs in rather than out-grows you). */
  enemyIncome?: number;
  /** false: no commander calldowns for either side (a fixed strike group or budget is the puzzle). */
  calldowns?: false;
  /** Powers the enemy commander may not call (Act I: no Obus Méliès on the République's prefab base yet). */
  enemyPowerBans?: PowerKind[];
}

/** The silent film around a campaign mission: 2–3 intertitles before, one after (12 words at most each). */
export interface OpCards {
  before: string[];
  win: string;
  lose: string;
  /** The campaign's last card, after the victory card (the finale: « FIN »). */
  end?: string[];
}

export interface OpDef {
  id: string;
  title: string;
  icon: string;
  /** One line for the menu card. */
  tagline: string;
  /** The briefing. */
  brief: string;
  /** A hint for the briefing (and the end screen after a failure). */
  tip: string;
  map: string;
  /** The opposition: an AI commander, the Last Stand wave director, or nobody. */
  ai: OpAi | "survival" | null;
  survival?: SurvivalOptions;
  rules?: OpRules;
  /** Player starting scrap (default: the classic 600). */
  scrap?: number;
  /** Pre-place buildings and units, tag what the goals protect. */
  setup?(w: World, o: OpSetup): void;
  /** Once a second while the op runs (scripted reinforcements, a march): deterministic, sim-side. */
  script?(w: World, st: OpsState, o: OpSetup): void;
  /** Where the camera opens (tiles; default: the player's HQ). */
  focus?: { x: number; y: number };
  /** Primary goals: achieve every achievement goal without breaking a condition. */
  goals: Goal[];
  /** ★★ and ★★★ conditions, checked when the op is won (★ = completing it). */
  stars: [Goal, Goal];
  /**
   * The Instruction (src/game/tutorial.ts): a guided lesson, not a campaign
   * op. Not in OPS (no menu card, no unlocks); its scene directs the
   * battlefield beat by beat and the goals only close it.
   */
  tutorial?: boolean;
  // ---- the campaign (§2.3)
  /** The nations played (the player is always blue); absent = Classique (the Trials). */
  nations?: { player: Nation; enemy: Nation };
  act?: 1 | 2 | 3;
  cards?: OpCards;
  /** Render dressing of the map, no effect on the sim (the Paris finale: the Eiffel Tower). */
  dressing?: "paris" | "polygone";
  /** The chapter's still (public/assets/ui/campaign/<art>.webp), shown under the first card. */
  art?: string;
  /** Tags of enemy units the commander never orders (the op's script moves them: the Colosse's parade). */
  aiHeld?: string[];
}

export interface OpResult {
  won: boolean;
  /** "Held for 4:00", "Out of time", "Our HQ has fallen"… */
  reason: string;
  /** Star bitmask: 1 = completed, 2 = ★★ condition, 4 = ★★★ condition. */
  stars: number;
  secs: number;
  /** Where the camera should look for the ending (tiles). */
  x: number;
  y: number;
  /** Ended by an objective (not an HQ kill): the finale skips the HQ blasts. */
  byGoal: boolean;
}

export interface OpsState {
  id: string;
  player: Faction;
  enemy: Faction;
  /** Entity ids a setup tagged (e.g. "bridge" turrets), and how many there were. */
  tags: Record<string, number[]>;
  /** Enemy units/buildings destroyed by kind, and our own losses by kind. */
  killed: Partial<Record<UnitKind | BuildingKind, number>>;
  lost: Partial<Record<UnitKind | BuildingKind, number>>;
  /** Tagged entities destroyed, by tag. */
  tagDeaths: Record<string, number>;
  /** Reach goals already achieved (by goal index). */
  reached: number[];
  /** Star conditions already broken (bits 2 and 4), for "star lost" notices. */
  starsLost: number;
  /** Where the last tagged entity died (camera target if the op fails on it). */
  lastTagDeath: { x: number; y: number } | null;
  /** Names a setup gave its heroes (unit id → name: « Valmont »), for the callsign registry. */
  names: Record<number, string>;
  /** Landmarks drawn in place of a building's model (building id → kind). */
  landmarks: Record<number, "eiffel">;
  /** A script's one-shot events (name → tick it happened), read by the presenter. */
  events: Record<string, number>;
  /** Enemy unit ids the commander never orders (OpDef.aiHeld): the script alone moves them. */
  held?: number[];
  result: OpResult | null;
}

export interface UnitOpts {
  /** Veterancy rank (a hero: 3). */
  rank?: number;
  /** A hero's name (shown by the callsign registry). */
  name?: string;
}

/** Setup helpers handed to OpDef.setup (positions in tiles). */
export interface OpSetup {
  building(faction: Faction, kind: BuildingKind, tx: number, ty: number, tag?: string, opts?: { hpMult?: number; landmark?: "eiffel" }): number;
  /** `n` units in a loose block around (x, y); returns their ids. */
  units(faction: Faction, kind: UnitKind, n: number, x: number, y: number, tag?: string, opts?: UnitOpts): number[];
  /** Remove every unit of a kind (e.g. the starting harvester). */
  removeUnits(faction: Faction, kind: UnitKind): void;
  /** A super-unit (Gargantua, Zénith) at (x, y). */
  superUnit(faction: Faction, kind: UnitKind, x: number, y: number, tag?: string, opts?: UnitOpts): number;
}

const ALL_UNITS = Object.keys(UNITS) as UnitKind[];
const ALL_BUILDINGS = (Object.keys(BUILDINGS) as BuildingKind[]).filter((k) => k !== "hq");
/** An enemy commander that defends but never raids or assaults. */
const DEFENSIVE: Partial<Strategy> = { assaultValue: Infinity, harassGroup: Infinity };

// ------------------------------------------------------------ the Trials ---

/** « Épreuves »: the original eight ops, symmetric and Classique (ids suffixed `-classique`). */
export const TRIALS: OpDef[] = [
  {
    id: "bridgehead-classique",
    title: "Tête de pont",
    icon: "🌉",
    tagline: "Tiens le passage du fleuve face à un Rush",
    brief:
      "Nous tenons l'extrémité ouest du pont des Terres fluviales : deux Hotchkiss, des Halles sur le gisement de radium et une escouade de Panhard. Le commandant Rush de Rouge veut ce passage. Tiens-le 4:00.",
    tip: "Panhard et Hotchkiss déchiquettent les autos blindées du Rush. Bâtis vite des Forges et envoie des renforts par la route jusqu'au pont.",
    map: "riverlands",
    // bigger waves than a stock Rush: it masses ~1,200 scrap of tanks before each push
    // (and the four harvesters this op was tuned against: skirmish Rush now keeps five)
    ai: { strategy: "rush", difficulty: "hard", tweak: { assaultValue: 2200, harvesters: 4 } },
    focus: { x: 21, y: 34 },
    setup(w, o) {
      o.building("blue", "depot", 20, 31);
      o.building("blue", "turret", 22, 30, "bridge");
      o.building("blue", "turret", 26, 32, "bridge");
      o.units("blue", "stinger", 3, 23.5, 33.5);
      o.units("blue", "flak-crawler", 1, 21.5, 34.5);
      o.units("blue", "harvester", 1, 21.5, 29.5);
      // Rush arrives early and keeps coming: two factories and a first wave
      o.building("red", "fab-plant", 50, 10);
      o.units("red", "stinger", 6, 44, 10);
      w.factions.red.scrap = 1200;
    },
    goals: [
      { type: "survive", secs: 240 },
      { type: "protect", tag: "bridge", min: 1, label: "Garde une Hotchkiss du pont debout", short: "Hotchkiss", lost: "Hotchkiss du pont perdues" }
    ],
    stars: [
      { type: "maxLosses", n: 6 },
      { type: "protect", tag: "bridge", min: 2, label: "Les deux Hotchkiss du pont debout", short: "Hotchkiss", lost: "Hotchkiss du pont perdues" }
    ]
  },
  {
    id: "harvest-moon-classique",
    title: "Lune des moissons",
    icon: "🌙",
    tagline: "Livre 10 000 de charbon sous les raids de l'Essaim aérien",
    brief:
      "La cokerie exige 10 000 de charbon avant le départ du convoi à 5:00. L'Essaim aérien de Rouge chasse les Fardiers avec des Éole dès la première minute. Maintiens les livraisons.",
    tip: "Faucheux et Hotchkiss près du gisement éloignent les Éole de tes Fardiers. Plus de Fardiers, plus de charbon — s'ils survivent.",
    map: "dune-sea",
    ai: { strategy: "airswarm", difficulty: "hard" },
    setup(_w, o) {
      o.units("blue", "harvester", 1, 9.5, 46.5);
      o.building("blue", "turret", 10, 41);
      o.units("red", "wasp", 3, 46, 12);
    },
    goals: [
      { type: "deliver", scrap: 10000 },
      { type: "within", secs: 300 }
    ],
    stars: [
      { type: "maxLosses", n: 1, kind: "harvester" },
      { type: "within", secs: 240 }
    ]
  },
  {
    id: "decapitation-classique",
    title: "Décapitation",
    icon: "🎯",
    tagline: "Un groupe d'assaut, aucune forge, 3:00",
    brief:
      "Ni base ni renforts : deux Creusot, trois Panhard, deux Albatros, deux Blériot et un Pasteur, plus une Escouade de pioupious qui garde le GQG. Le GQG de Rouge s'abrite derrière deux Batteries Ruggieri, trois Hotchkiss, de la DCA et un écran de chasseurs. Abats-le en moins de 3:00.",
    tip: "Avance en un seul groupe — qui arrive seul meurt seul. Les Panhard tuent la DCA, les Blériot les chasseurs, les Albatros rasent les Batteries Ruggieri ; puis tout sur le GQG.",
    map: "proving-grounds",
    ai: { strategy: "balanced", difficulty: "easy", tweak: DEFENSIVE },
    focus: { x: 10, y: 39 },
    // (no calldowns: a Drop Pod or Barrage would make the fixed strike group moot, and Red's pods would reinforce it)
    rules: { playerBans: { units: ALL_UNITS, buildings: ALL_BUILDINGS }, playerIncome: 0, calldowns: false },
    scrap: 0,
    setup(w, o) {
      o.removeUnits("blue", "harvester");
      o.units("blue", "mastodon", 2, 10, 36);
      o.units("blue", "stinger", 3, 10, 37.8);
      o.units("blue", "hornet", 2, 10, 39.6);
      o.units("blue", "raptor", 2, 10, 41.4);
      o.units("blue", "mender", 1, 10, 43.2);
      o.building("red", "fab-plant", 37, 2);
      o.building("red", "airpad", 44, 10);
      o.building("red", "sam-site", 39, 9);
      o.building("red", "sam-site", 45, 4);
      o.building("red", "turret", 40, 8);
      o.building("red", "turret", 44, 8);
      o.building("red", "turret", 38, 7);
      o.units("red", "flak-crawler", 2, 42, 10.5);
      o.units("red", "raptor", 3, 38, 4);
      w.factions.red.scrap = 400;
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 180 }],
    stars: [
      { type: "maxLosses", n: 4 },
      { type: "within", secs: 120 }
    ]
  },
  {
    id: "frozen-assets-classique",
    title: "Avoirs gelés",
    icon: "❄",
    tagline: "3 000 de charbon, aucun revenu : dépense avec sagesse",
    brief:
      "Nos Fardiers sont pris dans la glace : les Forges tiennent, mais il n'y a que 3 000 de charbon en caisse et pas un de plus — ni extraction, ni récupération au GQG. Le commandant Boom de Rouge bâtit son économie. Frappe avant qu'elle ne rapporte : détruis son GQG en moins de 6:00.",
    tip: "Chaque unité compte. Frappe leurs Fardiers pour freiner le Boom, garde ton armée groupée et ne gaspille pas de charbon en défenses inutiles.",
    map: "frostbite",
    ai: { strategy: "boom", difficulty: "normal" },
    // (no calldowns: free Drop Pod crews would break the fixed budget)
    rules: { playerBans: { units: ["harvester"] }, playerIncome: 0, calldowns: false },
    scrap: 3000,
    setup(_w, o) {
      o.removeUnits("blue", "harvester");
      o.building("blue", "fab-plant", 8, 39);
      o.building("blue", "airpad", 4, 36);
      o.building("blue", "tech-lab", 8, 43);
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 360 }],
    stars: [
      { type: "destroy", kind: "harvester", count: 4 },
      { type: "within", secs: 240 }
    ]
  },
  {
    id: "sky-pirates-classique",
    title: "Pirates du ciel",
    icon: "🏴‍☠️",
    tagline: "Air seulement : coule leur GQG avant 7:00",
    brief:
      "Forges et Montgolfière interdites : c'est un raid aérien. Rouge se retranche derrière des Batteries Ruggieri que tu n'as pas encore vues, et chaque Éole montré l'incite à bâtir plus de DCA. Reconnais d'abord, puis coule son GQG avant 7:00.",
    tip: "Une Patrie repère les Batteries Ruggieri. Les Blériot battent leurs chasseurs, les Albatros rasent Ruggieri et GQG. N'envoie pas tes bombardiers un par un dans la DCA.",
    map: "ashlands",
    // a commander that digs in (never attacks) on half income: the clock is the enemy
    ai: { strategy: "balanced", difficulty: "easy", tweak: DEFENSIVE },
    // (ground units are banned too, so a Drop Pod lands Wasps and a Raptor: it stays an air raid;
    // the starting Trooper Squad stays home — no Condor to fly it — and no more infantry can be raised)
    rules: { playerBans: { units: NO_GROUND_COMBAT, buildings: ["fab-plant", "assembly-bay"] }, enemyIncome: 0.5 },
    scrap: 800,
    setup(_w, o) {
      o.building("blue", "airpad", 9, 54);
      o.building("blue", "tech-lab", 4, 51);
      o.units("blue", "harvester", 1, 9.5, 57.5);
      o.building("red", "sam-site", 52, 10);
      o.building("red", "sam-site", 59, 12);
      o.building("red", "turret", 55, 10);
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 420 }],
    stars: [
      { type: "maxLosses", n: 12 },
      { type: "within", secs: 270 }
    ]
  },
  {
    id: "glass-jaw-classique",
    title: "Mâchoire de verre",
    icon: "💥",
    tagline: "Double dégâts, double vitesse, 6:00",
    brief:
      "Canons de verre et Production éclair pour les deux camps : chaque arme frappe deux fois plus fort et tout se construit deux fois plus vite. Le commandant Rush de Rouge adore ça. Détruis son GQG en moins de 6:00.",
    tip: "Les combats durent quelques secondes : n'échange jamais au compte-gouttes. Les Hotchkiss frappent aussi deux fois plus fort — deux ou trois te laissent le temps de masser une armée.",
    map: "dune-sea",
    // (the four harvesters this op was tuned against: skirmish Rush now keeps five)
    ai: { strategy: "rush", difficulty: "hard", tweak: { harvesters: 4 } },
    rules: { mutators: ["glass", "rapidfab"] },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 360 }],
    stars: [
      { type: "maxLosses", n: 0, buildings: true },
      { type: "within", secs: 240 }
    ]
  },
  {
    id: "iron-tide-classique",
    title: "Marée d'acier",
    icon: "🛡",
    tagline: "Survis 6:00 face au Cuirassé en Difficile",
    brief:
      "Cuirassé en Difficile : Creusot, Hydroglisseurs et Canons de 75 contournent la mer gelée, avec une économie plus grosse que la tienne. Tu as des Forges et Polytechnique. Tiens 6:00.",
    tip: "Les Hydroglisseurs percent les Creusot et les Éole les frappent depuis le ciel. Les Canons de 75 portent plus loin que tes Hotchkiss — traque-les avec des Panhard.",
    map: "frostbite",
    ai: { strategy: "ironclad", difficulty: "hard" },
    setup(_w, o) {
      o.building("blue", "fab-plant", 8, 39);
      o.building("blue", "tech-lab", 4, 36);
      o.units("blue", "harvester", 1, 8.5, 42.5);
    },
    goals: [{ type: "survive", secs: 360 }],
    stars: [
      { type: "destroy", kind: "mastodon", count: 2 },
      { type: "maxLosses", n: 1, buildings: true }
    ]
  },
  {
    id: "last-light-classique",
    title: "Dernière lueur",
    icon: "🕯",
    tagline: "Survie : tiens 10 vagues rapides",
    brief:
      "La dernière base sur le fleuve. Des vagues arrivent des bords de la carte toutes les 40 secondes, chaque fois plus fortes, avec un boss toutes les cinq. Tu commences retranché. Survis à 10 vagues.",
    tip: "La barre du haut annonce le thème de la prochaine vague : prépare la riposte avant qu'elle n'arrive. Appeler une vague en avance sur un terrain dégagé rapporte du charbon — et fait gagner du temps.",
    map: "riverlands",
    ai: "survival",
    survival: { difficulty: "easy", firstWave: 45, interval: 40 },
    scrap: 1200,
    setup(_w, o) {
      o.building("blue", "fab-plant", 4, 44);
      o.building("blue", "airpad", 9, 45);
      o.building("blue", "turret", 10, 49);
      o.building("blue", "turret", 8, 43);
      o.units("blue", "harvester", 2, 9.5, 51.5);
    },
    goals: [{ type: "waves", count: 10 }],
    stars: [
      { type: "maxLosses", n: 2, buildings: true },
      { type: "within", secs: 420 }
    ]
  }
];

/** Where the Instruction's scripted pieces stand (proving-grounds tiles; src/game/tutorial-view.ts spawns them). */
export const TUTORIAL_SPOTS = {
  /** The two Panhard the lesson starts with. */
  starters: { x: 10.5, y: 44 },
  /** The flag they are sent to. */
  flag: { x: 16.5, y: 40.5 },
  /** The enemy outpost (a Hotchkiss and Halles), top-left tiles. */
  turret: { x: 27, y: 33 },
  depot: { x: 29, y: 31 }
} as const;

/**
 * L'Instruction — « Premier jour »: the guided first mission on the Proving
 * Grounds. No enemy commander: the scene brings each enemy in when the lesson
 * needs it (a patrol, a convoy for the Feu roulant, the outpost), and razing
 * the outpost — a Hotchkiss and its Halles — completes it. Every star is
 * given: the Instruction is learnt, not graded.
 */
export const TUTORIAL_OP: OpDef = {
  id: "instruction",
  title: "Premier jour",
  icon: "🎓",
  tagline: "L'instruction : un geste à la fois, 3 minutes",
  brief: "Ton premier jour au commandement : caméra, ordres, construction, production, pouvoirs. Un geste à la fois.",
  tip: "Suis la main gantée : elle montre toujours le prochain geste.",
  map: "proving-grounds",
  ai: null,
  scrap: 450,
  tutorial: true,
  focus: { x: 9, y: 41 },
  setup(w, o) {
    // a quiet field: no squads, nobody on the enemy side until the lesson calls them
    o.removeUnits("blue", "trooper");
    o.removeUnits("red", "trooper");
    o.removeUnits("red", "harvester");
    o.units("blue", "stinger", 2, TUTORIAL_SPOTS.starters.x, TUTORIAL_SPOTS.starters.y, "starters");
    w.factions.red.scrap = 0;
  },
  goals: [
    { type: "destroy", kind: "turret", count: 1 },
    { type: "destroy", kind: "depot", count: 1 }
  ],
  stars: [
    { type: "maxLosses", n: 99 },
    { type: "within", secs: 3600 }
  ]
};

// ---------------------------------------------------------- the campaign ---

const REP_EMP = { player: "republique", enemy: "empire" } as const;
/** La Dame de fer: when the Colosse's parade sets off (s). */
export const DAME_MARCH = 150;
const EMP_REP = { player: "empire", enemy: "republique" } as const;

/** République ground combat, the Montgolfière and the ground factories: an air raid (Pirates du ciel). */
const REP_AIR_RAID = {
  units: [...ROSTERS.republique.units.filter((k) => (UNITS[k].domain === "ground" && UNITS[k].dps > 0) || behaves(k, "condor"))],
  buildings: ["fab-plant", "assembly-bay"] as BuildingKind[]
};

/** « La Campagne de 1900 » (§2.5): twelve missions in three acts. */
export const CAMPAIGN: OpDef[] = [
  // ------------------------------------------------- ACTE I — L'Ultimatum
  {
    id: "bridgehead",
    title: "Tête de pont",
    icon: "🌉",
    act: 1,
    nations: REP_EMP,
    art: "chap-1",
    tagline: "Tiens le pont face aux Panhard du Maréchal",
    brief:
      "L'Empire de Carbonie franchit le fleuve. Deux Bobines d'Arsonval tiennent l'extrémité ouest du pont, alimentées par une Tour TSF ; trois Jamais-Contente et un De Dion les épaulent. Les Panhard du Maréchal arrivent en masse. Tiens le pont 4:00.",
    tip: "Si la Tour TSF tombe, les Bobines s'éteignent : garde-la derrière elles. Un Garage électrique près du GQG et des Jamais-Contente en renfort par la route.",
    map: "riverlands",
    ai: { strategy: "rush", difficulty: "normal", tweak: { assaultValue: 1600, harvesters: 3 } },
    focus: { x: 21, y: 32 },
    setup(w, o) {
      o.building("blue", "radar", 20, 28);
      o.building("blue", "depot", 20, 31);
      o.building("blue", "arsonval", 22, 30, "bridge");
      o.building("blue", "arsonval", 26, 32, "bridge");
      o.units("blue", "jamais-contente", 3, 23.5, 33.5);
      o.units("blue", "de-dion", 1, 21.5, 34.5);
      o.units("blue", "fourgon", 1, 21.5, 29.5);
      o.building("red", "fab-plant", 50, 10);
      o.units("red", "stinger", 6, 44, 10);
      w.factions.red.scrap = 1000;
    },
    goals: [
      { type: "survive", secs: 240 },
      { type: "protect", tag: "bridge", min: 1, label: "Garde une Bobine du pont debout", short: "Bobines", lost: "Bobines du pont perdues" }
    ],
    stars: [
      { type: "maxLosses", n: 6 },
      { type: "protect", tag: "bridge", min: 2, label: "Les deux Bobines du pont debout", short: "Bobines", lost: "Bobines du pont perdues" }
    ],
    cards: {
      before: ["Paris, 1900. L'Exposition ferme ses portes.", "L'Empire de Carbonie franchit le fleuve sans y être invité.", "Capitaine Valmont : « Personne ne passe ce pont. »"],
      win: "Le pont tient. Le Maréchal Mâchefer fronce un sourcil.",
      lose: "Le pont est tombé. Paris l'apprendra par télégraphe."
    }
  },
  {
    id: "harvest-moon",
    title: "La Caravane du radium",
    icon: "⚗",
    act: 1,
    nations: REP_EMP,
    tagline: "Livre 11 000 de charbon sous les Gyroptères",
    brief:
      "Dans la Mer de dunes, Marguerite Sablon a trouvé du radium. Le convoi part à 5:00 : il faut 11 000 de charbon d'ici là. Les Gyroptères impériaux chassent tes Fourgons dès la première minute. Une Bobine et une Batterie Ruggieri gardent le gisement.",
    tip: "Des De Dion près des Fourgons éloignent les Gyroptères. Un Parc de Chalais-Meudon donne des Blériot. Plus de Fourgons, plus de charbon — s'ils survivent.",
    map: "dune-sea",
    ai: { strategy: "airswarm", difficulty: "normal", tweak: { harassGroup: 2 } },
    setup(_w, o) {
      o.units("blue", "fourgon", 1, 9.5, 46.5);
      o.building("blue", "radar", 8, 43);
      o.building("blue", "arsonval", 10, 41);
      o.building("blue", "sam-site", 12, 43);
      o.units("red", "gyroptere", 3, 46, 12);
    },
    goals: [
      { type: "deliver", scrap: 11000 },
      { type: "within", secs: 300 }
    ],
    stars: [
      { type: "maxLosses", n: 1, kind: "fourgon" },
      { type: "within", secs: 240 }
    ],
    cards: {
      before: ["Dans le désert, Marguerite Sablon a trouvé du radium.", "Il faut le ramener avant le départ du convoi.", "Au loin, des rotors. Des Gyroptères !"],
      win: "Le convoi part. Sablon serre une fiole qui luit.",
      lose: "Les Fourgons brûlent dans les dunes. Le radium est perdu."
    }
  },
  {
    id: "granit",
    title: "Les Côtes de granit",
    icon: "🎈",
    act: 1,
    nations: REP_EMP,
    tagline: "Abats les trois ballons captifs de l'Archipel",
    brief:
      "Bretagne. Trois Ballons captifs impériaux espionnent nos côtes depuis les îles, chacun gardé par une Hotchkiss et des Fusiliers retranchés. Le Capitaine Valmont mène l'expédition à bord de son Hydroglisseur, un De Dion pour escorte. Abats les trois ballons avant 12:00 — et ramène le Capitaine : les Gyroptères le chassent dès la troisième minute.",
    tip: "Les Éole frappent les îles par les airs ; les Hydroglisseurs glissent sur les hauts-fonds. Valmont ne tient pas seul contre les Gyroptères : garde-le près de son De Dion, sous une Batterie Ruggieri, et ne l'envoie pas à l'assaut.",
    map: "archipelago",
    // (tuned before the nations' balance pass: the Empire out-produces the République, so a slower,
    // poorer commander; re-check after WP4)
    // (doc: assaultValue 2400, 85 % income — softened while the Empire out-produces the République,
    // before the nations' balance pass: re-check after WP4)
    // (harassGroup 4, not 2: pairs of Gyroptères found Valmont by the GQG at 2:40 every time, even sat at home)
    ai: { strategy: "balanced", difficulty: "normal", tweak: { assaultValue: 3600, harassGroup: 4 } },
    rules: { enemyIncome: 0.7, enemyPowerBans: ["hammer"] },
    focus: { x: 20, y: 86 },
    setup(_w, o) {
      o.units("blue", "lancer", 1, 19.5, 87.5, "valmont", { rank: 3, name: "Valmont" });
      // the Capitaine's air cover: Gyroptères hunt him from 2:30, and an Hydroglisseur alone barely scratches them
      o.units("blue", "de-dion", 1, 20.5, 88.5, "escorte");
      // the spies' balloons: the centre island, the outer isle out in the gulf, the NW gulf isle
      for (const [x, y] of [[55, 50], [22, 18], [8, 33]] as [number, number][]) {
        o.building("red", "radar", x, y, "antenne");
        o.building("red", "turret", x + 2, y + 1);
        o.units("red", "fusiliers", 1, x + 1.5, y + 2.5);
        o.units("red", "flak-crawler", 1, x - 1, y + 1.5);
      }
      // the centre island's balloon is the big one: a Batterie de 47 watches the sky
      o.building("red", "flak-battery", 53, 52);
    },
    goals: [
      { type: "destroy", kind: "radar", count: 3, tag: "antenne", short: "Ballons", done: "Les trois ballons sont crevés", label: "Abats les trois Ballons captifs" },
      { type: "within", secs: 720 },
      { type: "protect", tag: "valmont", min: 1, label: "Le Capitaine Valmont doit survivre", short: "Valmont", lost: "Le Capitaine Valmont est tombé" }
    ],
    stars: [
      { type: "maxLosses", n: 0, kind: "condor" },
      { type: "within", secs: 540 }
    ],
    cards: {
      before: ["Bretagne. Des ballons impériaux espionnent nos côtes.", "Ferrand : « Les Hydroglisseurs passent là où rien ne roule. »", "Abattez les trois ballons captifs."],
      win: "Les ballons crèvent. L'Empire est sourd et aveugle.",
      lose: "Le Capitaine boit la tasse. Les espions rient."
    }
  },
  {
    id: "carbonie",
    title: "Pendant ce temps, en Carbonie…",
    icon: "🎩",
    act: 1,
    nations: EMP_REP,
    art: "chap-carbonie",
    tagline: "Le Maréchal essaie son Mortier de 280",
    brief:
      "Intermède : tu es le Maréchal Mâchefer. Sur le plateau, un observatoire républicain — une Polytechnique gardée par trois Bobines d'Arsonval, une Batterie Ruggieri et une Tour TSF qui les alimente — espionne tes volcans. Ton Mortier de 280 porte à 11 cases : rase les trois Bobines et la Polytechnique avant 9:00.",
    tip: "Le Mortier tire plus loin qu'il ne voit : l'Estafette (ou un Ballon captif) doit repérer pour lui. Abats la Tour TSF et les Bobines s'éteignent. Les Fusiliers immobiles se retranchent.",
    map: "ashlands",
    ai: { strategy: "balanced", difficulty: "easy", tweak: DEFENSIVE },
    // (a commander that never attacks still stockpiles: on a third of the income it stays a garrison)
    rules: { enemyIncome: 0.3 },
    scrap: 1500,
    focus: { x: 12, y: 50 },
    setup(_w, o) {
      o.building("blue", "fab-plant", 9, 50);
      o.building("blue", "tech-lab", 4, 50);
      o.units("blue", "mortier-280", 1, 12, 52);
      o.units("blue", "estafette", 1, 13.5, 50.5);
      o.units("blue", "fusiliers", 2, 13, 54);
      // the observatory on the plateau
      o.building("red", "tech-lab", 50, 12, "institut");
      o.building("red", "radar", 47, 15);
      o.building("red", "arsonval", 48, 11);
      o.building("red", "arsonval", 53, 15);
      o.building("red", "arsonval", 49, 16);
      o.building("red", "sam-site", 52, 11);
      // its garrison
      o.units("red", "jamais-contente", 4, 46, 18);
      o.units("red", "trooper", 2, 50, 18);
      o.units("red", "branly", 1, 52, 9);
    },
    goals: [
      { type: "destroy", kind: "arsonval", count: 3 },
      { type: "destroy", kind: "tech-lab", count: 1, tag: "institut", short: "Observatoire", done: "L'observatoire est rasé" },
      { type: "within", secs: 540 }
    ],
    stars: [
      { type: "maxLosses", n: 5 },
      { type: "within", secs: 360 }
    ],
    cards: {
      before: ["Pendant ce temps, dans les volcans de Carbonie…", "Mâchefer : « Montrez-moi la portée de mon Mortier ! »", "Cible : l'observatoire républicain du plateau."],
      win: "Le Maréchal jubile. À Paris, on fronce les deux sourcils.",
      lose: "Le Maréchal casse sa longue-vue de dépit."
    }
  },
  // -------------------------------------------- ACTE II — La Guerre des cimes
  {
    id: "iron-tide",
    title: "Marée d'acier",
    icon: "🛡",
    act: 2,
    nations: REP_EMP,
    art: "chap-2",
    tagline: "Tiens 6:00 face aux Creusot du Cuirassé",
    brief:
      "Les Alpes. Le Cuirassé impérial descend vers la vallée : Creusot, Canons de 75 et Artificiers, avec une économie plus grosse que la tienne. Tu as un Garage électrique, Polytechnique et une Tour TSF. Tiens 6:00 : les secours arrivent.",
    tip: "Les Hydroglisseurs percent les Creusot ; les Canons Branly frappent de loin. Les Canons de 75 portent plus loin que tes Bobines — traque-les avec des Jamais-Contente.",
    map: "frostbite",
    ai: { strategy: "ironclad", difficulty: "normal", tweak: { siege: false } },
    setup(_w, o) {
      o.building("blue", "fab-plant", 8, 39);
      o.building("blue", "tech-lab", 4, 36);
      o.building("blue", "radar", 11, 36);
      o.units("blue", "fourgon", 1, 8.5, 42.5);
    },
    goals: [{ type: "survive", secs: 360 }],
    stars: [
      { type: "destroy", kind: "mastodon", count: 2 },
      { type: "maxLosses", n: 1, buildings: true }
    ],
    cards: {
      before: ["Les Alpes. Une colonne d'acier descend vers la vallée.", "Ferrand : « L'arc électrique aime l'acier épais. »", "Tenez six minutes. Les secours arrivent."],
      win: "La colonne recule dans la neige.",
      lose: "Les Creusot passent le col. La vallée est perdue."
    }
  },
  {
    id: "frozen-assets",
    title: "Avoirs gelés",
    icon: "❄",
    act: 2,
    nations: EMP_REP,
    tagline: "Le Maréchal, 3 000 de charbon et pas un de plus",
    brief:
      "Tu reprends le Maréchal : sa colonne est prise par les glaces. Forges, Aérodrome et Haut-fourneau tiennent, mais il n'y a que 3 000 de charbon et pas un de plus — ni Fardier, ni revenu, ni appui. La République bâtit son économie au radium ; une Bobine et sa Tour TSF gardent la route de son GQG. Frappe avant qu'elle ne paie : rase son GQG avant 6:00.",
    tip: "Tes usines fabriquent deux unités à la fois. Garde l'armée groupée et lance-la d'un bloc : Creusot devant, Ateliers roulants derrière. Une poignée de Panhard ne passe pas la Bobine. Frappe leurs Fourgons pour freiner l'économie.",
    map: "frostbite",
    ai: { strategy: "boom", difficulty: "normal" },
    // (after WP4 a bare GQG fell to six Panhard at 1:24 on every seed, and anything slower met a Boom
    // that out-built the 3 000 budget: a Bobine and a guard stop the snipe, half income lets the
    // whole column — Creusot, Ateliers, Gyroptères, sent in one block — grind through; sent piecemeal it still loses)
    rules: { playerBans: { units: ["harvester"] }, playerIncome: 0, enemyIncome: 0.5, calldowns: false },
    scrap: 3000,
    setup(_w, o) {
      o.removeUnits("blue", "harvester");
      o.building("blue", "fab-plant", 8, 39);
      o.building("blue", "airpad", 4, 36);
      o.building("blue", "tech-lab", 8, 43);
      // the République's GQG isn't bare: a Bobine on the road in, its Tour TSF, and a small guard
      o.building("red", "radar", 40, 9);
      o.building("red", "arsonval", 38, 6);
      o.units("red", "jamais-contente", 2, 39, 8);
      o.units("red", "lancer", 1, 41, 8);
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 360 }],
    stars: [
      { type: "destroy", kind: "fourgon", count: 4 },
      { type: "within", secs: 240 }
    ],
    cards: {
      before: ["Le Maréchal est pris dans la glace. Ses coffres aussi.", "3 000 de charbon, pas un de plus.", "Mâchefer : « Frappons avant que leur radium ne paie ! »"],
      win: "Le Maréchal s'échappe vers ses volcans, ravi.",
      lose: "Le Maréchal grelotte. Ses chaudières aussi."
    }
  },
  {
    id: "col-des-aigles",
    title: "Le Col des Aigles",
    icon: "🦅",
    act: 2,
    nations: REP_EMP,
    tagline: "Escorte le radium de Sablon jusqu'au tunnel",
    brief:
      "Le convoi de radium de Marguerite Sablon — trois Fourgons à la cale pleine — doit passer le col jusqu'au tunnel ferroviaire, au nord-ouest. Des Hotchkiss impériales en embuscade et des Fusiliers retranchés barrent la route. Escorte au moins deux Fourgons au tunnel avant 8:00.",
    tip: "Ne fais pas avancer les Fourgons avant l'escorte : Valmont et les Jamais-Contente nettoient chaque Hotchkiss, le Pasteur répare, puis le convoi suit. Un Canon Branly déloge les Fusiliers retranchés de loin.",
    map: "frostbite",
    // (after WP4 — Empire queues two deep, one more Fardier — the stock Boom took the GQG by 3:30: 1/3 for
    // the escort pilot; revenue 80 % and a later assault bring it back to 6/6, idle still lost)
    ai: { strategy: "boom", difficulty: "normal", tweak: { harassGroup: 2, assaultValue: 2400 } },
    rules: { enemyPowerBans: ["hammer"], enemyIncome: 0.8 },
    focus: { x: 8, y: 34 },
    setup(w, o) {
      for (const id of o.units("blue", "fourgon", 3, 7, 35, "convoi")) {
        const u = w.units.get(id)!;
        u.cargo = holdOf(u.kind);
        u.order = { type: "idle" };
      }
      o.units("blue", "lancer", 1, 9.5, 33, "valmont", { rank: 3, name: "Valmont" });
      o.units("blue", "jamais-contente", 2, 8.5, 31.5, "escorte");
      o.units("blue", "de-dion", 1, 6, 32, "escorte");
      o.units("blue", "mender", 1, 7, 37, "escorte");
      // the ambush along the pass, and squads dug in across the road
      o.building("red", "turret", 10, 25);
      o.building("red", "turret", 6, 20);
      o.building("red", "turret", 9, 16);
      o.building("red", "turret", 14, 8);
      o.building("red", "turret", 5, 9);
      o.units("red", "fusiliers", 1, 11.5, 21.5);
      o.units("red", "fusiliers", 1, 12, 11);
      o.units("red", "fusiliers", 1, 7, 13);
    },
    goals: [
      { type: "reach", tag: "convoi", x: 8, y: 2, radius: 3, count: 2, label: "Amène 2 Fourgons au tunnel", short: "Tunnel" },
      { type: "protect", tag: "convoi", min: 2, label: "Garde au moins 2 Fourgons du convoi", short: "Convoi", lost: "Le convoi est détruit" },
      { type: "within", secs: 480 }
    ],
    stars: [
      { type: "protect", tag: "convoi", min: 3, label: "Les trois Fourgons du convoi intacts", short: "Convoi", lost: "Un Fourgon du convoi perdu" },
      { type: "within", secs: 360 }
    ],
    cards: {
      before: ["Le radium doit passer le col avant la nuit.", "Sablon : « Doucement avec mes fioles, Capitaine ! »", "Des tranchées barrent la route."],
      win: "Le train file vers Paris, chargé de lumière.",
      lose: "Le radium est aux mains du Maréchal."
    }
  },
  {
    id: "sky-pirates",
    title: "Pirates du ciel",
    icon: "🏴‍☠️",
    act: 2,
    nations: REP_EMP,
    tagline: "Par les airs seulement : coule la Citadelle avant 7:00",
    brief:
      "Auvergne : les volcans fument, le Maréchal forge. C'est un raid aérien — ni Garage, ni Manufacture, ni Montgolfière. La Citadelle s'abrite derrière des Batteries de 47 que tu n'as pas encore vues. Reconnais d'abord, puis coule la Citadelle avant 7:00.",
    tip: "Une Patrie repère les Batteries de 47. Les Blériot battent les Éperviers, les Albatros rasent batteries et Citadelle. N'envoie pas tes bombardiers un par un dans la DCA.",
    map: "ashlands",
    ai: { strategy: "balanced", difficulty: "easy", tweak: DEFENSIVE },
    rules: { playerBans: REP_AIR_RAID, enemyIncome: 0.5 },
    scrap: 800,
    setup(_w, o) {
      o.building("blue", "airpad", 9, 54);
      o.building("blue", "tech-lab", 4, 51);
      o.units("blue", "fourgon", 1, 9.5, 57.5);
      o.building("red", "flak-battery", 52, 10);
      o.building("red", "flak-battery", 59, 12);
      o.building("red", "turret", 55, 10);
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 420 }],
    stars: [
      { type: "maxLosses", n: 12 },
      { type: "within", secs: 270 }
    ],
    cards: {
      before: ["Auvergne. Les volcans fument : le Maréchal forge.", "Ferrand : « Un Albatros tout neuf. Ne le cassez pas. »", "Par les airs, et seulement par les airs."],
      win: "La Citadelle s'écroule dans la lave. Mâchefer s'enfuit à cheval.",
      lose: "Nos ailes fondent au-dessus des cratères."
    }
  },
  // ------------------------------------------------------ ACTE III — Paris !
  {
    id: "glass-jaw",
    title: "L'Orage de radium",
    icon: "⚡",
    act: 3,
    nations: REP_EMP,
    art: "chap-3",
    tagline: "Tout frappe double, tout se bâtit double : 6:00",
    brief:
      "Un orage de radium éclate sur le désert et surcharge toutes les machines : chaque arme frappe deux fois plus fort, tout se construit deux fois plus vite, pour les deux camps. Le Rush impérial adore ça. Rase la Citadelle en moins de 6:00.",
    tip: "Les combats durent quelques secondes : n'échange jamais au compte-gouttes. Deux Bobines et une Ruggieri te donnent le temps de masser une armée — puis tout sur la Citadelle.",
    map: "dune-sea",
    ai: { strategy: "rush", difficulty: "hard", tweak: { harvesters: 4 } },
    // (enemyIncome: after WP4 the Empire's double queues out-built the scripted general, 0/3; at 80 % 6/6)
    rules: { mutators: ["glass", "rapidfab"], enemyIncome: 0.8 },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 360 }],
    stars: [
      { type: "maxLosses", n: 0, buildings: true },
      { type: "within", secs: 240 }
    ],
    cards: {
      before: ["Un orage de radium éclate sur le désert.", "Tout frappe double. Tout se bâtit double.", "Sablon : « J'ai une idée… un rayon. »"],
      win: "Le Rayon Curie est né. Le Maréchal l'a vu.",
      lose: "L'orage a tout emporté, y compris nos plans."
    }
  },
  {
    id: "decapitation",
    title: "Décapitation",
    icon: "🎯",
    act: 3,
    nations: REP_EMP,
    dressing: "polygone",
    tagline: "Un groupe d'assaut, aucune usine, 2:30",
    brief:
      "Le Polygone de Carbonie, quartier général du Maréchal. Ni base ni renforts : trois Hydroglisseurs (dont celui de Valmont), trois Jamais-Contente, deux Albatros, deux Blériot et deux Pasteur. La Citadelle s'abrite derrière une Batterie de 47, trois Hotchkiss, des Faucheux et un écran d'Éperviers. Abats-la en moins de 2:30.",
    tip: "Avance en un seul groupe. Les Jamais-Contente tuent les Faucheux, les Blériot les Éperviers, les Albatros rasent les Batteries de 47 ; puis tout sur la Citadelle. Les Éperviers chassent aussi les Pasteur : garde-les en retrait tant qu'ils volent.",
    map: "proving-grounds",
    ai: { strategy: "balanced", difficulty: "hard", tweak: DEFENSIVE },
    focus: { x: 10, y: 39 },
    rules: { playerBans: { units: ALL_UNITS, buildings: ALL_BUILDINGS }, playerIncome: 0, calldowns: false },
    scrap: 0,
    setup(w, o) {
      o.removeUnits("blue", "fourgon");
      o.units("blue", "lancer", 1, 10, 35.2, "valmont", { rank: 3, name: "Valmont" });
      o.units("blue", "lancer", 2, 11, 35.2);
      o.units("blue", "jamais-contente", 3, 10, 37);
      o.units("blue", "hornet", 2, 10, 39.6);
      o.units("blue", "raptor", 2, 10, 41.4);
      o.units("blue", "mender", 2, 10, 43.2);
      o.building("red", "fab-plant", 37, 2);
      o.building("red", "airpad", 44, 10);
      // (one Batterie de 47, not the doc's two: against Difficile, two shred the fixed air wing before it lands a bomb)
      o.building("red", "flak-battery", 45, 4);
      o.building("red", "turret", 40, 8);
      o.building("red", "turret", 44, 8);
      o.building("red", "turret", 38, 7);
      o.units("red", "flak-crawler", 2, 42, 10.5);
      o.units("red", "epervier", 3, 38, 4);
      w.factions.red.scrap = 400;
    },
    // (3:00 and 2:00 until the playtest: the strike group won in 1:06 on every seed; Difficile, the clock is tight now)
    goals: [{ type: "destroyHq" }, { type: "within", secs: 150 }],
    stars: [
      { type: "maxLosses", n: 4 },
      { type: "within", secs: 90 }
    ],
    cards: {
      before: ["Le Polygone de Carbonie. Le quartier général du Maréchal.", "Pas de renforts. Pas de seconde chance.", "Valmont : « En avant, et avec panache ! »"],
      win: "La Citadelle tombe… mais le Gargantua s'éloigne vers Paris !",
      lose: "L'assaut se brise. Le Maréchal applaudit, ironique."
    }
  },
  {
    id: "last-light",
    title: "Dernière lueur",
    icon: "🕯",
    act: 3,
    nations: REP_EMP,
    tagline: "Dix vagues impériales avant l'aube",
    brief:
      "Les faubourgs, en amont de Paris. Les colonnes impériales arrivent des bords de la carte toutes les 43 secondes, chaque fois plus fortes. Tu commences retranché : Garage, Chalais-Meudon, deux Bobines, une Ruggieri et deux Tours TSF. Ferrand termine le Zénith. Survis à 10 vagues.",
    tip: "La barre du haut annonce la prochaine vague : prépare la riposte. Le Zénith arrive après la cinquième vague — garde-le près des Tours TSF et des Pasteur. Le terrain dégagé, appelle la vague suivante en avance : du charbon, et du temps gagné.",
    map: "riverlands",
    ai: "survival",
    // (interval 43, was 40: after WP4 the defender pilot held 9/12 seeds; 11/12 now — ★★★ moved with it:
    // the tenth wave leaves at 7:12, so 7:30 was out of reach; 8:00 takes waves called in early)
    survival: { difficulty: "normal", firstWave: 45, interval: 43 },
    scrap: 1200,
    setup(_w, o) {
      o.building("blue", "radar", 9, 41);
      o.building("blue", "radar", 13, 47);
      o.building("blue", "fab-plant", 4, 44);
      o.building("blue", "airpad", 9, 45);
      o.building("blue", "arsonval", 10, 49);
      o.building("blue", "arsonval", 8, 43);
      o.building("blue", "sam-site", 12, 45);
      o.units("blue", "fourgon", 2, 9.5, 51.5);
    },
    script(w, st, o) {
      // « Ferrand l'a fini ! »: the Zénith joins after the fifth wave
      if (st.events.zenith === undefined && wavesSurvived(w) >= 5) {
        st.events.zenith = w.tick;
        const hq = hqOf(w, st.player);
        const at = hq ? buildingCenter(hq) : { x: 8, y: 46 };
        o.superUnit(st.player, "zenith", at.x + 4, at.y - 4, "zenith");
      }
    },
    goals: [{ type: "waves", count: 10 }],
    stars: [
      { type: "maxLosses", n: 2, buildings: true },
      { type: "within", secs: 480 }
    ],
    cards: {
      before: ["Les faubourgs. Paris voit déjà la fumée.", "Ferrand : « Le Zénith sera prêt. Tenez ! »", "Dix vagues avant l'aube."],
      win: "L'aube se lève. Le Zénith brille au-dessus de la Seine.",
      lose: "Les faubourgs tombent. Paris éteint ses lampes."
    }
  },
  {
    id: "dame-de-fer",
    title: "La Dame de fer",
    icon: "🗼",
    act: 3,
    nations: REP_EMP,
    dressing: "paris",
    art: "chap-paris",
    tagline: "Le Colosse marche sur la Tour Eiffel",
    brief:
      "Paris, 14 juillet. Le Gargantua du Maréchal, « le Colosse », attend sa parade sur la route du pont, de l'autre côté de la Seine. À 2:30, il marche sur le Champ-de-Mars, toute l'armée impériale derrière lui. La Tour Eiffel, coiffée d'une antenne TSF, alimente tout le quartier. Le Zénith est prêt, la base aussi, et tous les pouvoirs. Abats le Colosse avant 15:00 — et que la Dame de fer reste debout.",
    tip: "Le Colosse perd ses armes une à une : frappe-le de loin avec les Branly, le Zénith et le Rayon Curie, tiens-le à distance de la Tour avec les Hydroglisseurs. Pour la Citadelle, frappe juste avant la parade : passe le gué au sud, remonte l'autre rive, et reviens à temps.",
    map: "riverlands",
    ai: { strategy: "ironclad", difficulty: "hard", tweak: { assaultValue: 2000 } },
    scrap: 2000,
    focus: { x: 22, y: 38 },
    // the parade is the script's alone: the commander never sends the Colosse ahead on its own
    aiHeld: ["colosse", "parade"],
    setup(w, o) {
      // the Champ-de-Mars: the Tower stands in the open on our bank, by the bridge
      o.building("blue", "radar", 22, 37, "eiffel", { hpMult: 4, landmark: "eiffel" });
      o.building("blue", "fab-plant", 9, 44);
      o.building("blue", "airpad", 4, 43);
      o.building("blue", "tech-lab", 9, 48);
      o.building("blue", "assembly-bay", 13, 50);
      o.building("blue", "radar", 14, 44);
      o.building("blue", "arsonval", 20, 39);
      o.building("blue", "arsonval", 25, 40);
      o.building("blue", "sam-site", 23, 41);
      o.units("blue", "fourgon", 2, 9.5, 52.5);
      o.units("blue", "lancer", 1, 20, 42, "valmont", { rank: 3, name: "Valmont" });
      o.units("blue", "lancer", 1, 21, 42);
      o.units("blue", "branly", 2, 18, 43);
      o.units("blue", "mender", 2, 16, 44);
      o.superUnit("blue", "zenith", 14, 47);
      // the Maréchal: the Galerie des Machines, and the Colosse already marching
      o.building("red", "gantry", 44, 12);
      o.building("red", "fab-plant", 46, 3);
      o.building("red", "turret", 42, 9);
      o.building("red", "flak-battery", 47, 10);
      // the parade forms up on the road to the bridge, off the Citadelle: the Colosse, four Creusot,
      // two Canons de 75, two Faucheux and two Ateliers roulants
      o.superUnit("red", "goliath", 40, 21, "colosse", { name: "le Colosse", rank: 2 });
      o.units("red", "mastodon", 4, 37, 23, "parade");
      o.units("red", "mortar", 2, 41, 24, "parade");
      o.units("red", "flak-crawler", 2, 43, 21, "parade");
      o.units("red", "atelier", 2, 43, 24, "parade");
      w.factions.red.scrap = 500;
    },
    script(w, st) {
      // the parade sets off at MARCH — and the Maréchal's whole army falls in behind the Colosse —
      // then keeps marching on the Tower (between fights); until then it stands by the Galerie
      const tower = (st.tags.eiffel ?? []).map((id) => w.buildings.get(id)).find((b) => !!b);
      if (!tower) return;
      const marching = w.tick >= DAME_MARCH * TICK_RATE;
      if (marching && st.events.march === undefined) {
        st.events.march = w.tick;
        const held = new Set(st.held ?? []);
        for (const u of w.units.values())
          if (u.faction === st.enemy && !held.has(u.id) && UNITS[u.kind].dps > 0 && !behaves(u.kind, "harvester") && !u.goliath) {
            (st.tags.parade ??= []).push(u.id);
            held.add(u.id);
          }
        st.held = [...held];
      }
      const colosse = (st.tags.colosse ?? []).map((id) => w.units.get(id)).find((u) => !!u);
      const tc = buildingCenter(tower);
      for (const id of st.held ?? []) {
        const u = w.units.get(id);
        if (!u) continue;
        if (!marching) {
          if (u.order.type !== "idle" && u.order.type !== "attack") u.order = { type: "idle" };
          continue;
        }
        if (w.tick % (4 * TICK_RATE) !== 0) continue;
        if (u === colosse) {
          const busy = u.order.type === "attack" || u.autoTargetId !== null || (u.goliath && u.goliath.mode !== "walking");
          if (!busy) {
            u.order = { type: "attack", targetId: tower.id };
            u.path = null;
          }
          continue;
        }
        // the escort keeps step with the Colosse, a little ahead of it, fighting whatever it meets
        if (u.autoTargetId !== null || u.order.type === "attack") continue;
        const lead = colosse ?? u;
        const d = Math.max(1, hypot(tc.x - lead.x, tc.y - lead.y));
        const ahead = Math.min(3, d);
        u.order = { type: "attackMove", x: lead.x + ((tc.x - lead.x) / d) * ahead, y: lead.y + ((tc.y - lead.y) / d) * ahead };
        u.path = null;
      }
    },
    goals: [
      { type: "destroy", kind: "goliath", count: 1, tag: "colosse", short: "Colosse", done: "Le Colosse est tombé", label: "Abats le Colosse" },
      { type: "protect", tag: "eiffel", min: 1, label: "La Tour Eiffel doit rester debout", short: "Tour Eiffel", lost: "La Dame de fer est tombée" },
      { type: "within", secs: 900 }
    ],
    stars: [
      { type: "destroyHq" },
      { type: "maxLosses", n: 2, buildings: true }
    ],
    cards: {
      before: ["Paris, 14 juillet. Le Colosse marche sur le Champ-de-Mars.", "Mâchefer : « Votre Tour fera un joli tisonnier ! »", "Valmont : « Pas tant qu'il restera du panache. »"],
      win: "Le Colosse s'agenouille. La Tour salue. Vive le panache !",
      lose: "La Dame de fer chancelle. Le Maréchal ajuste son monocle.",
      end: ["FIN", "Panache — La Campagne de 1900"]
    }
  }
];

/** Every op (campaign then Trials), for lookups by id. */
export const OPS: OpDef[] = [...CAMPAIGN, ...TRIALS];

export const isCampaignOp = (op: OpDef): boolean => CAMPAIGN.includes(op);
/** The book an op belongs to. */
export const bookOf = (op: OpDef): OpDef[] => (isCampaignOp(op) ? CAMPAIGN : TRIALS);

export const opById = (id: string): OpDef | null => (id === TUTORIAL_OP.id ? TUTORIAL_OP : OPS.find((o) => o.id === id) ?? null);
/** Position in its own book (campaign mission 1–12, or Trial 1–8), from 0. */
export const opIndex = (id: string): number => {
  const op = opById(id);
  return op ? bookOf(op).indexOf(op) : -1;
};
/** The op after this one in its book (null at the end). */
export const nextOp = (id: string): OpDef | null => {
  const op = opById(id);
  return op ? (bookOf(op)[opIndex(id) + 1] ?? null) : null;
};
/** How many Trials are open: the first three, plus one more per Trial completed. */
export const OPS_OPEN_AT_START = 3;
export const opsUnlocked = (completed: number): number => Math.min(TRIALS.length, OPS_OPEN_AT_START + completed);
/** How many campaign missions are open: the first, plus one per mission won (§2.3). */
export const CAMPAIGN_OPEN_AT_START = 1;
export const campaignUnlocked = (completed: number): number => Math.min(CAMPAIGN.length, CAMPAIGN_OPEN_AT_START + completed);

// -------------------------------------------------------------- arsenal ---

export interface CampaignUnlock {
  /** The first mission where these are available. */
  op: string;
  nation: Nation;
  /** Who brings them, for the card (« Ferrand », « Sablon »). */
  by?: string;
  units?: UnitKind[];
  buildings?: BuildingKind[];
  powers?: PowerKind[];
}

/**
 * The campaign's arsenal (§2.4), cumulative per nation: each row is what the
 * player may build from that mission on (the République's from M1; the
 * Empire's when the player first takes the Maréchal, M4). The rest of the
 * nation's roster is banned; the enemy is never bound by it.
 */
export const CAMPAIGN_UNLOCKS: CampaignUnlock[] = [
  {
    op: "bridgehead",
    nation: "republique",
    units: ["fourgon", "jamais-contente", "de-dion", "trooper"],
    buildings: ["hq", "fab-plant", "depot", "arsonval", "radar", "assembly-bay"],
    powers: ["sonde"]
  },
  { op: "harvest-moon", nation: "republique", by: "Ferrand", units: ["scout", "wasp", "raptor"], buildings: ["airpad"], powers: ["emp"] },
  { op: "granit", nation: "republique", by: "Ferrand", units: ["condor", "lancer", "sapeurs"], buildings: ["tech-lab", "sam-site"], powers: ["droppod"] },
  {
    op: "carbonie",
    nation: "empire",
    by: "Mâchefer",
    units: ["harvester", "estafette", "stinger", "flak-crawler", "fusiliers", "rocket-squad", "mortar", "mortier-280"],
    buildings: ["hq", "fab-plant", "depot", "turret", "flak-battery", "radar", "assembly-bay", "tech-lab"],
    powers: ["barrage", "gaz"]
  },
  { op: "iron-tide", nation: "republique", by: "Ferrand", units: ["branly", "sniper", "mender"] },
  { op: "frozen-assets", nation: "empire", by: "Mâchefer", units: ["mastodon", "atelier", "gyroptere", "epervier", "titan"], buildings: ["airpad"], powers: ["pression"] },
  { op: "sky-pirates", nation: "republique", by: "Ferrand", units: ["hornet"] },
  { op: "decapitation", nation: "republique", by: "Sablon", powers: ["curie"] },
  { op: "last-light", nation: "republique", by: "Ferrand", units: ["zenith"], buildings: ["gantry"] }
];

export interface Arsenal {
  units: UnitKind[];
  buildings: BuildingKind[];
  powers: PowerKind[];
}

/** What the player may field in a campaign mission (cumulative over the unlocks up to it), or null outside the campaign. */
export function arsenalFor(op: OpDef): Arsenal | null {
  if (!op.nations || !isCampaignOp(op)) return null;
  const n = op.nations.player;
  const at = CAMPAIGN.indexOf(op);
  const out: Arsenal = { units: [], buildings: [], powers: [] };
  for (const u of CAMPAIGN_UNLOCKS) {
    if (u.nation !== n || CAMPAIGN.findIndex((o) => o.id === u.op) > at) continue;
    out.units.push(...(u.units ?? []));
    out.buildings.push(...(u.buildings ?? []));
    out.powers.push(...(u.powers ?? []));
  }
  return out;
}

/** What winning this mission brings to the next one (for the end screen), or null. */
export function unlocksAfter(op: OpDef): CampaignUnlock | null {
  const nxt = isCampaignOp(op) ? nextOp(op.id) : null;
  return nxt ? (CAMPAIGN_UNLOCKS.find((u) => u.op === nxt.id) ?? null) : null;
}

/** The player's bans in an op: its own, plus (campaign) the nation's roster not unlocked yet. */
export function playerBansOf(op: OpDef): { units: UnitKind[]; buildings: BuildingKind[]; powers: PowerKind[] } {
  const own = op.rules?.playerBans;
  const units = new Set<UnitKind>(own?.units ?? []);
  const buildings = new Set<BuildingKind>(own?.buildings ?? []);
  const powers = new Set<PowerKind>(own?.powers ?? []);
  const ars = arsenalFor(op);
  if (ars && op.nations) {
    const r = ROSTERS[op.nations.player];
    for (const k of r.units) if (!ars.units.includes(k)) units.add(k);
    for (const k of r.buildings) if (k !== "hq" && !ars.buildings.includes(k)) buildings.add(k);
    for (const p of POWER_SETS[op.nations.player]) if (!ars.powers.includes(p)) powers.add(p);
  }
  return { units: [...units], buildings: [...buildings], powers: [...powers] };
}

// ----------------------------------------------------------------- setup ---

/** The enemy commander for an op (null when nobody commands: waves or no enemy). */
export function opAiState(op: OpDef, seed?: number): AiState | null {
  if (!op.ai || op.ai === "survival") return null;
  return createAiState(op.ai.strategy, op.ai.difficulty, seed, op.ai.tweak);
}

function spreadSpot(w: World, kind: UnitKind, x: number, y: number, i: number): { x: number; y: number } {
  // a loose 3-wide block; ground units nudge onto passable tiles nearby
  const bx = x + ((i % 3) - 1) * 0.9;
  const by = y + Math.floor(i / 3) * 0.9;
  if (UNITS[kind].domain === "air") return { x: bx, y: by };
  const mc = moveClassOf(kind);
  for (let r = 0; r <= 3; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.floor(bx) + dx;
        const ty = Math.floor(by) + dy;
        if (inBounds(w, tx, ty) && passable(w, tx, ty, mc) && w.occupancy[ty * w.width + tx] === 0)
          return { x: tx + (bx - Math.floor(bx)), y: ty + (by - Math.floor(by)) };
      }
  return { x: bx, y: by };
}

/** Can a `kind` footprint stand at (tx, ty): buildable ground, nothing there yet? */
function footprintFree(w: World, kind: BuildingKind, tx: number, ty: number): boolean {
  const size = BUILDINGS[kind].size;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!inBounds(w, x, y) || !TERRAIN[terrainAt(w, x, y)].buildable || w.occupancy[y * w.width + x] !== 0) return false;
    }
  return true;
}

/** The asked spot, or the nearest free one (ring by ring) — a setup's positions survive a repainted map. */
function freeFootprint(w: World, kind: BuildingKind, tx: number, ty: number): { tx: number; ty: number } {
  for (let r = 0; r <= 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (footprintFree(w, kind, tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
  return { tx, ty };
}

/**
 * An island map's start in an op (the skirmish gets it from the map's own
 * rules, maps.ts applyMapRules): home land, the HQ trickle, the lifeline,
 * and each side's line squad aboard its nation's transport.
 */
function islandStart(w: World): void {
  const def = mapById(w.mapId);
  const r = w.rules!;
  if (def.hqTrickle !== undefined) r.hqTrickle = def.hqTrickle;
  if (!def.islands) return;
  r.islands = true;
  const hs = BUILDINGS.hq.size;
  const [hx, hy] = def.hq;
  const [rx, ry] = [def.size - hx - hs, def.size - hy - hs];
  r.homeTiles = { blue: [hx + (hs >> 1), hy + (hs >> 1)], red: [rx + (hs >> 1), ry + (hs >> 1)] };
  if (!def.startUnits?.includes("condor")) return;
  for (const f of ["blue", "red"] as const) {
    const kind = ROLES[nationOf(w, f)].transport;
    const squad = [...w.units.values()].find((u) => u.faction === f && UNITS[u.kind].squad);
    if (!squad) continue;
    const p = dropPoint(w, f, squad.x + (f === "blue" ? 1.5 : -1.5), squad.y) ?? { x: squad.x, y: squad.y };
    const c = spawnUnit(w, kind, f, p.x, p.y);
    c.free = true;
    if (def.squadAboard) stowAboard(w, c, squad);
  }
  if (def.lifeline) {
    r.lifeline = true;
    setupLifeline(w);
  }
}

/** The setup helpers of each op world, for its script (kept out of the world state). */
const scripts = new WeakMap<World, OpSetup>();

/**
 * Turn a fresh map world into an op (createMapWorld calls this last, when
 * MatchOptions.op is set): rules (and the nations), the wave director or the
 * enemy base, the op's own setup, and the OpsState that tickOps() evaluates.
 */
export function setupOp(w: World, id: string): void {
  const op = opById(id);
  if (!op) return;
  const player: Faction = "blue";
  const enemy: Faction = "red";
  const st: OpsState = {
    id: op.id, player, enemy, tags: {}, killed: {}, lost: {}, tagDeaths: {}, reached: [], starsLost: 0, lastTagDeath: null,
    names: {}, landmarks: {}, events: {}, result: null
  };
  // rules: mutators for both sides, the nations, then the player's bans and income
  const r = makeRules(op.rules?.mutators ?? []);
  if (op.nations) r.nations = { [player]: op.nations.player, [enemy]: op.nations.enemy } as Record<Faction, Nation>;
  const bans = playerBansOf(op);
  if (bans.units.length || bans.buildings.length || bans.powers.length) r.sideBans = { [player]: bans };
  if (op.rules?.enemyPowerBans?.length) r.sideBans = { ...r.sideBans, [enemy]: { powers: [...op.rules.enemyPowerBans] } };
  if (op.rules?.playerIncome !== undefined || op.rules?.enemyIncome !== undefined)
    r.sideIncome = { [player]: op.rules.playerIncome ?? 1, [enemy]: op.rules.enemyIncome ?? 1 };
  r.banLabel = isCampaignOp(op) ? "Pas encore disponible dans la campagne" : "Désactivé dans cette op";
  if (op.rules?.calldowns === false) r.noCalldowns = true;
  w.rules = r;
  for (const f of Object.values(w.factions)) f.scrap = r.startScrap;
  // the nations' starting forces (Fourgon and pioupious, Fardier and Fusiliers), their buildings' HP
  if (op.nations) {
    nationStart(w);
    islandStart(w); // (the Trials keep the classic op start, bit for bit)
  }
  if (op.ai === "survival") setupSurvival(w, op.survival ?? {}, player);
  w.factions[player].scrap = op.scrap ?? r.startScrap;
  const tag = (name: string | undefined, id: number) => {
    if (name) (st.tags[name] ??= []).push(id);
  };
  const dress = (u: Unit, t: string | undefined, opts: UnitOpts | undefined) => {
    tag(t, u.id);
    if (opts?.rank) {
      u.rank = Math.min(COMBAT.rankXp.length, opts.rank);
      u.xp = COMBAT.rankXp[u.rank - 1]! * UNITS[u.kind].cost;
    }
    if (opts?.name) st.names[u.id] = opts.name;
  };
  const helpers: OpSetup = {
    building(faction, kind, tx, ty, t, opts) {
      const at = freeFootprint(w, kind, tx, ty);
      const b = spawnBuilding(w, kind, faction, at.tx, at.ty);
      if (opts?.hpMult) b.hpMult = opts.hpMult;
      if (opts?.landmark) st.landmarks[b.id] = opts.landmark;
      tag(t, b.id);
      return b.id;
    },
    units(faction, kind, n, x, y, t, opts) {
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = spreadSpot(w, kind, x, y, i);
        const u = spawnUnit(w, kind, faction, p.x, p.y);
        if (behaves(kind, "harvester")) {
          const f = nearestReachableResource(w, u.x, u.y, u.faction);
          if (f) u.order = { type: "harvest", fieldX: f.x, fieldY: f.y, phase: "toField" };
        }
        dress(u, t, opts);
        ids.push(u.id);
      }
      return ids;
    },
    removeUnits(faction, kind) {
      for (const u of [...w.units.values()]) if (u.faction === faction && u.kind === kind) w.units.delete(u.id);
    },
    superUnit(faction, kind, x, y, t, opts) {
      const u = spawnSuper(w, kind, faction, x, y);
      dress(u, t, opts);
      return u.id;
    }
  };
  op.setup?.(w, helpers);
  if (op.aiHeld?.length) st.held = op.aiHeld.flatMap((t) => st.tags[t] ?? []);
  // the nations' building HP (and a landmark's multiplier) for everything the setup placed
  if (op.nations) nationStart(w);
  else for (const b of w.buildings.values()) if (b.hpMult) b.hp = BUILDINGS[b.kind].hp * b.hpMult;
  scripts.set(w, helpers);
  w.ops = st;
}

// ------------------------------------------------------------ evaluation ---

const secsOf = (w: World): number => w.tick / TICK_RATE;

export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const fmtNum = (n: number): string => Math.floor(n).toLocaleString("fr-FR");

/** A kind's name as the op's nation calls it (Polytechnique / Haut-fourneau, Tour TSF / Ballon captif). */
const kindName = (k: UnitKind | BuildingKind, nation?: NationOrClassic): string => displayName(k, nation);
/** "Fardier" / "Fardiers", "Bobine d'Arsonval" / "Bobines d'Arsonval" (sim/lexicon.ts). */
const plural = (k: UnitKind | BuildingKind, n: number, nation?: NationOrClassic): string =>
  n <= 1 ? kindName(k, nation) : nation && nation !== "classique" ? pluralName(k, nation) : PLURALS[k];

/** Which nation a goal's kind belongs to: the enemy's for what we destroy, ours for what we keep or lose. */
function goalNation(g: Goal, nations?: { player: NationOrClassic; enemy: NationOrClassic }): NationOrClassic | undefined {
  if (!nations) return undefined;
  return g.type === "destroy" ? nations.enemy : nations.player;
}

const stNations = (w: World, st: OpsState) => ({ player: nationOf(w, st.player), enemy: nationOf(w, st.enemy) });

const aliveIds = (w: World, ids: number[]) => ids.filter((id) => w.units.has(id) || w.buildings.has(id) || carrierOf(w, id));

/** Living members of a protect goal's group, and how many there were (squads aboard a Condor count). */
function protectCount(w: World, st: OpsState, g: Extract<Goal, { type: "protect" }>): { alive: number; total: number } {
  if (g.tag) {
    const ids = st.tags[g.tag] ?? [];
    return { alive: aliveIds(w, ids).length, total: ids.length };
  }
  let alive = 0;
  if (g.kind)
    for (const e of [...w.units.values(), ...w.buildings.values(), ...[...w.units.values()].flatMap((u) => u.passengers ?? [])])
      if (e.faction === st.player && e.kind === g.kind) alive++;
  return { alive, total: Math.max(alive, g.min) };
}

/** Tagged units within a reach goal's zone right now. */
function inZone(w: World, st: OpsState, g: Extract<Goal, { type: "reach" }>): number {
  let n = 0;
  for (const id of st.tags[g.tag] ?? []) {
    const u = w.units.get(id) ?? carrierOf(w, id);
    if (u && hypot(u.x - g.x, u.y - g.y) <= g.radius) n++;
  }
  return n;
}

/** Evaluate one goal against the world right now (pure). */
export function evalGoal(w: World, st: OpsState, g: Goal): GoalEval {
  const t = secsOf(w);
  const stats = w.factions[st.player].stats;
  const nat = goalNation(g, stNations(w, st));
  switch (g.type) {
    case "destroyHq": {
      const hq = hqOf(w, st.enemy);
      const name = displayName("hq", nationOf(w, st.enemy));
      const max = hq ? Math.max(1, hq.hp, buildingMaxHp(w, hq)) : 1;
      return { state: hq ? "pending" : "done", label: `${name} ennemi${name === "Citadelle" ? "e" : ""}`, value: hq ? `${Math.ceil((hq.hp / max) * 100)} %` : "détruit", progress: hq ? 1 - hq.hp / max : 1 };
    }
    case "destroy": {
      const n = g.tag ? (st.tagDeaths[g.tag] ?? 0) : (st.killed[g.kind] ?? 0);
      return { state: n >= g.count ? "done" : "pending", label: g.short ?? plural(g.kind, 2, nat), value: `${Math.min(n, g.count)}/${g.count}`, progress: Math.min(1, n / g.count) };
    }
    case "survive":
      return { state: t >= g.secs ? "done" : "pending", label: "Tenir", value: fmtClock(g.secs - t), progress: Math.min(1, t / g.secs) };
    case "waves": {
      const n = wavesSurvived(w);
      return { state: n >= g.count ? "done" : "pending", label: "Vagues", value: `${Math.min(n, g.count)}/${g.count}`, progress: Math.min(1, n / g.count) };
    }
    case "deliver": {
      const n = stats.scrapHarvested;
      return { state: n >= g.scrap ? "done" : "pending", label: "Charbon", value: `${fmtNum(Math.min(n, g.scrap))}/${fmtNum(g.scrap)}`, progress: Math.min(1, n / g.scrap) };
    }
    case "protect": {
      const { alive, total } = protectCount(w, st, g);
      return { state: alive >= g.min ? "ok" : "failed", label: g.short ?? plural(g.kind ?? "turret", 2, nat), value: `${alive}/${total}`, progress: total ? alive / total : 0 };
    }
    case "reach": {
      const done = st.reached.includes(goalIndex(st, g));
      const n = done ? g.count : inZone(w, st, g);
      return { state: done || n >= g.count ? "done" : "pending", label: g.short ?? "Arrivés", value: `${Math.min(n, g.count)}/${g.count}`, progress: Math.min(1, n / g.count) };
    }
    case "within":
      return { state: t > g.secs ? "failed" : "ok", label: "Temps", value: fmtClock(g.secs - t), progress: Math.max(0, 1 - t / g.secs) };
    case "maxLosses": {
      const n = g.kind ? (st.lost[g.kind] ?? 0) : g.buildings ? stats.buildingsLost : stats.unitsLost;
      return { state: n > g.n ? "failed" : "ok", label: "Pertes", value: `${n}/${g.n}`, progress: g.n > 0 ? Math.min(1, n / g.n) : n > 0 ? 1 : 0 };
    }
  }
}

/** A reach goal's index among the op's goals and stars (goals first), for OpsState.reached. */
function goalIndex(st: OpsState, g: Goal): number {
  const op = opById(st.id);
  if (!op) return -1;
  const all = [...op.goals, ...op.stars];
  return all.indexOf(g);
}

/** Plain-language goal text for the briefing and the objective list (`op` names the kinds as its nations do). */
export function goalText(g: Goal, asStar = false, op?: OpDef | null): string {
  const nat = goalNation(g, op?.nations);
  switch (g.type) {
    case "destroyHq":
      return op?.nations?.enemy === "empire" ? "Détruis la Citadelle ennemie" : "Détruis le GQG ennemi";
    case "destroy":
      if (g.label) return g.label;
      return `Détruis ${g.count} ${plural(g.kind, g.count, nat)} ${g.count > 1 ? "adverses" : "adverse"}`;
    case "survive":
      return `Tiens ${fmtClock(g.secs)}`;
    case "waves":
      return `Survis à ${g.count} vagues`;
    case "deliver":
      return `Livre ${fmtNum(g.scrap)} de charbon`;
    case "protect":
    case "reach":
      return g.label;
    case "within":
      return asStar ? `Termine en moins de ${fmtClock(g.secs)}` : `Avant ${fmtClock(g.secs)} au chrono`;
    case "maxLosses": {
      const what = g.kind ? plural(g.kind, g.n, nat) : g.buildings ? (g.n === 1 ? "bâtiment" : "bâtiments") : g.n === 1 ? "unité" : "unités";
      return g.n === 0
        ? `Ne perds aucun${g.kind ? `${isFeminine(g.kind, nat) ? "e" : ""} ${kindName(g.kind, nat)}` : g.buildings ? " bâtiment" : "e unité"}`
        : `Perds ${g.n} ${what} au plus`;
    }
  }
}

/** The objective as one line: "Détruis le GQG ennemi avant 3:00 · Garde une Hotchkiss du pont debout". */
export function objectiveLine(op: OpDef): string {
  const main = op.goals.filter(isAchieveGoal).map((g) => goalText(g, false, op));
  const limit = op.goals.find((g): g is Extract<Goal, { type: "within" }> => g.type === "within");
  const rest = op.goals.filter((g) => !isAchieveGoal(g) && g.type !== "within").map((g) => goalText(g, false, op));
  const head = `${main.join(" et ")}${limit ? ` avant ${fmtClock(limit.secs)}` : ""}`;
  return [head, ...rest].filter(Boolean).join(" · ");
}

/** Does a star condition hold right now? (achievements: done; conditions: unbroken) */
const holds = (e: GoalEval): boolean => e.state === "done" || e.state === "ok";

/** Star bitmask a win right now would earn. */
export function starsNow(w: World, op: OpDef, st: OpsState): number {
  let mask = 1;
  op.stars.forEach((g, i) => {
    if (holds(evalGoal(w, st, g))) mask |= 2 << i;
  });
  return mask;
}

/** « A, B et C ». */
const andList = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`);

/** « Citadelle ennemie détruite » / « GQG ennemi détruit ». */
const hqDownText = (w: World, st: OpsState): string =>
  `${displayName("hq", nationOf(w, st.enemy))} ennemi${nationOf(w, st.enemy) === "empire" ? "e détruite" : " détruit"}`;

/**
 * What a won op achieved, every part of it: each achievement goal done (the
 * plain kills gathered in one « Détruits : … »), and the enemy HQ if it fell
 * without being a goal (an HQ kill wins any op) — « Le Colosse est tombé ·
 * Citadelle ennemie détruite », « Détruits : 1 Hotchkiss et 1 Halles adverses ».
 */
function winReason(w: World, op: OpDef, st: OpsState): string {
  const parts: string[] = [];
  const kills: { n: number; text: string }[] = [];
  let killsAt = -1;
  for (const g of op.goals.filter(isAchieveGoal)) {
    if (evalGoal(w, st, g).state !== "done") continue;
    const nat = goalNation(g, stNations(w, st));
    switch (g.type) {
      case "survive":
        parts.push(`Tenu ${fmtClock(g.secs)}`);
        break;
      case "waves":
        parts.push(`${g.count} vagues repoussées`);
        break;
      case "deliver":
        parts.push(`Charbon livré : ${fmtNum(w.factions[st.player].stats.scrapHarvested)}`);
        break;
      case "destroy":
        if (g.done) parts.push(g.done);
        else {
          if (killsAt < 0) killsAt = parts.length;
          kills.push({ n: g.count, text: `${g.count} ${plural(g.kind, g.count, nat)}` });
        }
        break;
      case "reach":
        parts.push(`${g.short ?? "Objectif"} atteint`);
        break;
      default:
        parts.push(hqDownText(w, st));
    }
  }
  if (kills.length) {
    const many = kills.length > 1 || kills[0]!.n > 1;
    parts.splice(killsAt, 0, `Détruits : ${andList(kills.map((k) => k.text))} ${many ? "adverses" : "adverse"}`);
  }
  if ((st.killed.hq ?? 0) > 0 && !op.goals.some((g) => g.type === "destroyHq")) parts.push(hqDownText(w, st));
  return parts.length ? parts.join(" · ") : "Objectif accompli";
}

function failReason(g: Goal): string {
  switch (g.type) {
    case "within":
      return "Temps écoulé";
    case "protect":
      return g.lost ?? "Nous avons perdu ce qu'il fallait protéger";
    case "maxLosses":
      return "Trop de pertes";
    default:
      return "Objectif manqué";
  }
}

function centreOf(w: World, f: Faction): { x: number; y: number } {
  const hq = hqOf(w, f);
  return hq ? buildingCenter(hq) : { x: w.width / 2, y: w.height / 2 };
}

function finish(w: World, op: OpDef, st: OpsState, won: boolean, reason: string, at: { x: number; y: number }, byGoal: boolean): void {
  st.result = { won, reason, stars: won ? starsNow(w, op, st) : 0, secs: Math.round(secsOf(w)), x: at.x, y: at.y, byGoal };
  if (!w.winner) w.winner = won ? st.player : st.enemy;
}

/** This tick's `death` event matching `pred`, if any. */
function deathOf(w: World, pred: (ev: Extract<FxEvent, { type: "death" }>) => boolean): Extract<FxEvent, { type: "death" }> | undefined {
  for (const ev of w.fx) if (ev.type === "death" && pred(ev)) return ev;
  return undefined;
}

/** Where a goal's own ending happened (the camera's target for the finale). */
function goalSpot(w: World, st: OpsState, g: Goal | undefined): { x: number; y: number } {
  if (g?.type === "reach") return { x: g.x, y: g.y };
  if (g?.type === "destroy" && st.lastTagDeath && g.tag) return st.lastTagDeath;
  return centreOf(w, st.player);
}

/**
 * Per-tick op bookkeeping (step() calls it after deaths are cleaned up):
 * tally kills and losses, and once a second run the op's script and check the
 * goals — completing or failing the op sets World.winner.
 */
export function tickOps(w: World): void {
  const st = w.ops;
  if (!st || st.result) return;
  const op = opById(st.id);
  if (!op) return;
  for (const ev of w.fx) {
    if (ev.type !== "death") continue;
    const kind = ev.unitKind ?? ev.buildingKind;
    if (!kind) continue;
    const book = ev.faction === st.player ? st.lost : st.killed;
    book[kind] = (book[kind] ?? 0) + 1;
    for (const [name, ids] of Object.entries(st.tags))
      if (ids.includes(ev.id)) {
        st.tagDeaths[name] = (st.tagDeaths[name] ?? 0) + 1;
        st.lastTagDeath = { x: ev.x, y: ev.y };
      }
  }
  // an op is a base to hold: our HQ falling loses it, even with a Goliath still standing
  if (!w.winner && !hqOf(w, st.player)) {
    const fell = deathOf(w, (ev) => ev.buildingKind === "hq" && ev.faction === st.player);
    finish(w, op, st, false, `Notre ${displayName("hq", nationOf(w, st.player))} est tombé${nationOf(w, st.player) === "empire" ? "e" : ""}`, fell ? { x: fell.x, y: fell.y } : centreOf(w, st.player), false);
    return;
  }
  // an HQ (or an enemy's last Goliath, its HQ already gone) fell this tick: combat already named the winner
  if (w.winner) {
    const won = w.winner === st.player;
    const hq = won ? null : hqOf(w, st.player);
    const lastGoliath = won ? deathOf(w, (ev) => !!ev.unitKind && (ev.unitKind === "goliath" || ev.unitKind === "zenith") && ev.faction === st.enemy) : undefined;
    const enemyHqFell = !!deathOf(w, (ev) => ev.buildingKind === "hq" && ev.faction === st.enemy);
    const hqName = displayName("hq", nationOf(w, won ? st.enemy : st.player));
    const fem = nationOf(w, won ? st.enemy : st.player) === "empire";
    // (won: name what was achieved — the op's goals done, the HQ — else the Goliath that fell last)
    const achieved = won ? winReason(w, op, st) : "";
    const named = won && achieved !== "Objectif accompli" ? achieved : null;
    if (lastGoliath && !enemyHqFell) finish(w, op, st, true, named ?? `${displayName(lastGoliath.unitKind!, nationOf(w, st.enemy))} ennemi détruit`, { x: lastGoliath.x, y: lastGoliath.y }, false);
    else if (named) finish(w, op, st, true, named, enemyHqFell || !lastGoliath ? centreOf(w, st.enemy) : { x: lastGoliath.x, y: lastGoliath.y }, false);
    else
      finish(
        w, op, st, won,
        won ? `${hqName} ennemi${fem ? "e détruite" : " détruit"}` : `Notre ${hqName} est tombé${fem ? "e" : ""}`,
        hq ? buildingCenter(hq) : centreOf(w, won ? st.enemy : st.player), false
      );
    return;
  }
  if (w.tick % TICK_RATE !== 0) return;
  const helpers = scripts.get(w);
  if (op.script && helpers) op.script(w, st, helpers);
  // reach goals stay done once reached
  [...op.goals, ...op.stars].forEach((g, i) => {
    if (g.type === "reach" && !st.reached.includes(i) && inZone(w, st, g) >= g.count) st.reached.push(i);
  });
  // star conditions broken so far (for the HUD's "star lost" notice)
  op.stars.forEach((g, i) => {
    if (!isAchieveGoal(g) && evalGoal(w, st, g).state === "failed") st.starsLost |= 2 << i;
  });
  const evals = op.goals.map((g) => ({ g, e: evalGoal(w, st, g) }));
  const failed = evals.find((x) => x.e.state === "failed");
  const achieve = evals.filter((x) => isAchieveGoal(x.g));
  if (achieve.length > 0 && achieve.every((x) => x.e.state === "done")) {
    finish(w, op, st, true, winReason(w, op, st), goalSpot(w, st, achieve[achieve.length - 1]?.g), true);
    return;
  }
  if (failed) {
    const g = failed.g;
    const at =
      g.type === "protect" && st.lastTagDeath
        ? st.lastTagDeath
        : g.type === "within" && hqOf(w, st.enemy)
          ? centreOf(w, st.enemy)
          : centreOf(w, st.player);
    finish(w, op, st, false, failReason(g), at, true);
  }
}

/** Everything the HUD shows about the running op. */
export interface OpStatus {
  op: OpDef;
  secs: number;
  goals: { goal: Goal; eval: GoalEval }[];
  stars: { goal: Goal; eval: GoalEval }[];
  /** Live star bitmask a win now would earn (bit 1 always set). */
  starsNow: number;
  starsLost: number;
  result: OpResult | null;
}

export function opStatus(w: World): OpStatus | null {
  const st = w.ops;
  const op = st ? opById(st.id) : null;
  if (!st || !op) return null;
  return {
    op,
    secs: secsOf(w),
    goals: op.goals.map((goal) => ({ goal, eval: evalGoal(w, st, goal) })),
    stars: op.stars.map((goal) => ({ goal, eval: evalGoal(w, st, goal) })),
    starsNow: starsNow(w, op, st),
    starsLost: st.starsLost,
    result: st.result
  };
}
