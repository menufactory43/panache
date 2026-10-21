import { BUILDINGS, COMBAT, ROLES, TICK_RATE, UNITS } from "../balance";
import { isInfantry, unitSeenBy } from "../infantry";
import { worldPick, worldRandom } from "../rand";
import { nationOf } from "../rules";
import type { Building, Faction, NationOrClassic, Role, Unit, UnitKind, World } from "../types";
import {
  buildingCenter,
  dist,
  distToBuilding,
  hqOf,
  inBounds,
  moveClassOf,
  passable,
  removeBuilding,
  spawnUnit,
  type MoveClass
} from "../world";
import { atan2, pow } from "../fmath";

/**
 * Last Stand: a survival mode. The red side has no base or economy; a wave
 * director spawns themed, announced red waves from the map edges and sends
 * them at the defender's base. The run ends when the defender's HQ falls;
 * the score is the number of waves survived.
 *
 * Pure and deterministic: every choice derives from the match seed through
 * rand.ts, and step() only calls into this module when World.survival is set.
 */

export type WaveTheme = "air" | "armour" | "artillery" | "mixed" | "swarm" | "boss";
/** The themes that rotate through the four regular slots of each block of five waves. */
export type RegularTheme = Exclude<WaveTheme, "boss">;
export type SurvivalDifficulty = "easy" | "normal" | "hard";

export interface SurvivalOptions {
  difficulty?: SurvivalDifficulty;
  /** Ops: seconds before the first wave, and between waves (bosses get +10 s). Default: SURVIVAL. */
  firstWave?: number;
  interval?: number;
}

/** Every tunable number of the mode (kept here so it merges cleanly). */
export const SURVIVAL = {
  /** Seconds before the first wave lands, by difficulty. */
  firstWave: { easy: 110, normal: 95, hard: 85 } as Record<SurvivalDifficulty, number>,
  /** Seconds from one wave spawning to the next. */
  interval: 50,
  /** …and after a boss wave. */
  bossInterval: 60,
  /** Once the field is clear, the next wave comes at most this many seconds later. */
  afterClear: 30,
  /** Seconds of public warning (banner, minimap arrow) before a wave spawns. */
  warn: 15,
  /** Wave budget in scrap: (base + growth · n^exp) × difficulty multiplier. */
  budgetBase: 240,
  budgetGrowth: 228,
  budgetExp: 1.4,
  budgetMult: { easy: 0.7, normal: 1, hard: 1.3 } as Record<SurvivalDifficulty, number>,
  /**
   * The regular themes. Each block of five waves plays four of them in a
   * seeded order, then a boss; with five themes one sits each block out, in
   * a seeded turn that benches every theme once per five blocks and never
   * the one its boss grows out of (no Bomber Wing without an Air Raid first).
   */
  themes: ["air", "armour", "artillery", "mixed", "swarm"] as RegularTheme[],
  /** Boss waves get this much extra budget (on top of +1 veterancy rank). */
  bossBudget: 1.1,
  /** Live wave units at once (phone frame rate); the rest wait off-map. */
  maxLive: 30,
  /** Hard cap on units planned for one wave, and on the off-map queue. */
  maxWaveUnits: 36,
  /**
   * A Bot Swarm stops growing at the live cap (30 squads, from about wave 8
   * on Normal): a wave bigger than the cap stands at its edge, waiting for
   * the units the cap holds back, until the march timeout. Only the late
   * waves of the other themes get that big; cheap squads would from wave 8.
   */
  swarmMaxUnits: 30,
  maxPending: 60,
  /** Ticks between two units of a wave entering the map. */
  spawnEvery: 2,
  /**
   * Waves march in formation: units more than `cohesion` tiles ahead of the
   * wave's rear wait for it, until the wave gets within `releaseDist` of its
   * objective, is engaged, or has marched for `marchTimeout` seconds.
   */
  cohesion: 3,
  releaseDist: 12,
  marchTimeout: 50,
  /** Scrap for clearing the field: this × wave number. */
  clearBonus: 60,
  /** Calling a wave early pays (base + perWave · n) scrap per second skipped. */
  earlyBase: 5,
  earlyPerWave: 1,
  /** Waves from which units arrive with veterancy rank 1 and 2 (bosses +1 more). */
  rankFrom: [6, 12],
  /** Idle wave units with nothing in reach get a new objective this often. */
  retaskTicks: 20,
  /** Spawn sites must be at least this fraction of the map size from the HQ. */
  siteMinDist: 0.6,
  /**
   * Wreck value of a wave unit, as a share of its cost (skirmish wrecks are
   * worth SALVAGE.share = 30%). At 30% a defender salvaged 17–116k scrap a
   * run and lasted 30–50 waves: the waves had become an economy. The clear
   * bonus already pays for a wave beaten; the defender's own losses still
   * leave normal wrecks.
   */
  waveWreckShare: 0.05
};

export interface SpawnSite {
  /** Ground entry tile centre (reachable from the defender's HQ). */
  x: number;
  y: number;
  /** Air entry point on the map edge. */
  ax: number;
  ay: number;
  /** Compass direction on the map, e.g. "north-east". */
  dir: string;
}

export interface PendingSpawn {
  kind: UnitKind;
  rank: number;
  wave: number;
  site: number;
}

/** A wave marching in formation toward the base. */
export interface March {
  wave: number;
  theme: WaveTheme;
  /** Objective (entity id and where it was). */
  id: number;
  x: number;
  y: number;
  /** Spawn site the wave enters from. */
  site: number;
  started: number;
}

export interface SurvivalState {
  difficulty: SurvivalDifficulty;
  /** The defending faction (the player); waves belong to the other side. */
  defender: Faction;
  /** Number of the latest wave spawned (0 before the first). */
  wave: number;
  /** Theme and spawn site of the latest wave. */
  theme: WaveTheme | null;
  site: number;
  /** Latest wave number at which the field was completely clear. */
  cleared: number;
  /** Tick at which the next wave spawns. */
  nextWaveTick: number;
  /** Has the next wave's warning gone out? */
  warned: boolean;
  /** Scrap paid for calling the next wave early (shown with its warning). */
  earlyBonus: number;
  sites: SpawnSite[];
  /** Wave units waiting off-map for a free slot under the live cap. */
  pending: PendingSpawn[];
  /** Units spawned so far (formation slot counter). */
  spawned: number;
  lastSpawnTick: number;
  /** Scrap earned from clear and early-call bonuses. */
  bonusEarned: number;
  /** Waves still marching in formation. */
  marches: March[];
  /** Wave unit id → its wave number. */
  members: Map<number, number>;
  /** Seconds between waves when an op sets its own pace (else SURVIVAL.interval). */
  interval?: number;
  /** Wreck value of a wave unit as a share of its cost (salvage.ts; SURVIVAL.waveWreckShare). */
  wreckShare: number;
}

export const THEME_NAMES: Record<WaveTheme, string> = {
  air: "Raid aérien",
  armour: "Colonne blindée",
  artillery: "Artillerie",
  mixed: "Assaut mixte",
  swarm: "Essaim d'automates",
  boss: "Boss"
};

/** What beats each theme (shown to the player ahead of the wave). */
export const THEME_COUNTERS: Record<WaveTheme, string> = {
  air: "Faucheux, Hotchkiss, Ruggieri, Blériot",
  armour: "Hydroglisseurs, Creusot, Éole",
  artillery: "fonce sur les canons avec Panhard, Éole",
  mixed: "une armée mixte, Hotchkiss",
  swarm: "Canons de 75, Hotchkiss, Albatros, Chasseurs alpins",
  boss: "tout ce que tu as"
};

const BOSS_NAMES = ["Fer de lance Creusot", "Escadre de bombardiers", "Force d'élite"];
/** The regular theme each boss grows out of: the four waves before it always include one. */
const BOSS_PREVIEW: RegularTheme[] = ["armour", "air", "mixed"];

type Pool = { kind: UnitKind; weight: number; from?: number; maxShare?: number; maxCount?: number }[];

/**
 * Weighted unit pools per theme; `from` = first wave a kind may appear in,
 * `maxShare` = most of the budget it may take, `maxCount` = most of the
 * wave's unit cap (for cheap themes that hit the cap long before the budget).
 */
const POOLS: Record<RegularTheme, Pool> = {
  air: [
    { kind: "wasp", weight: 5 },
    { kind: "hornet", weight: 2, from: 4 },
    { kind: "raptor", weight: 1, from: 5, maxShare: 0.25 }
  ],
  armour: [
    { kind: "stinger", weight: 5 },
    { kind: "lancer", weight: 2, from: 3 },
    { kind: "mastodon", weight: 2, from: 4 }
  ],
  artillery: [
    { kind: "mortar", weight: 4, maxShare: 0.6 },
    { kind: "stinger", weight: 3 },
    { kind: "lancer", weight: 1, from: 6 },
    { kind: "flak-crawler", weight: 1, from: 7, maxShare: 0.2 }
  ],
  mixed: [
    { kind: "stinger", weight: 4 },
    { kind: "wasp", weight: 2, from: 2 },
    { kind: "flak-crawler", weight: 1, from: 3, maxShare: 0.2 },
    { kind: "lancer", weight: 1, from: 4 },
    { kind: "mortar", weight: 1, from: 6 },
    { kind: "raptor", weight: 1, from: 7, maxShare: 0.2 },
    { kind: "mender", weight: 1, from: 8, maxShare: 0.15 }
  ],
  // robot infantry: rifle squads with anti-armour rockets, marksmen from wave 6
  swarm: [
    { kind: "trooper", weight: 5 },
    { kind: "rocket-squad", weight: 2 },
    { kind: "sniper", weight: 1, from: 6, maxShare: 0.15, maxCount: 0.15 }
  ]
};

/**
 * Boss waves: a core of heavy hitters plus escorts, all one rank up. The
 * ground bosses bring infantry along: Rocket Squads walk with the Mastodons,
 * and the Elite Strike Force fields every arm.
 */
const BOSS_POOLS: { core: UnitKind; share: number; escorts: Pool }[] = [
  {
    core: "mastodon",
    share: 0.55,
    escorts: [
      { kind: "stinger", weight: 3 },
      { kind: "lancer", weight: 2 },
      { kind: "flak-crawler", weight: 1, maxShare: 0.15 },
      { kind: "rocket-squad", weight: 1, maxShare: 0.15 }
    ]
  },
  { core: "hornet", share: 0.55, escorts: [{ kind: "wasp", weight: 3 }, { kind: "raptor", weight: 2, maxShare: 0.3 }] },
  {
    core: "lancer",
    share: 0.3,
    escorts: POOLS.mixed.concat([
      { kind: "mastodon", weight: 2 },
      { kind: "hornet", weight: 1 },
      { kind: "trooper", weight: 1, maxShare: 0.15 },
      { kind: "rocket-squad", weight: 1, maxShare: 0.15 }
    ])
  }
];

const COMPASS = [
  { dir: "north-west", ax: 0, ay: 0 },
  { dir: "north", ax: 0.5, ay: 0 },
  { dir: "north-east", ax: 1, ay: 0 },
  { dir: "east", ax: 1, ay: 0.5 },
  { dir: "south-east", ax: 1, ay: 1 },
  { dir: "south", ax: 0.5, ay: 1 },
  { dir: "south-west", ax: 0, ay: 1 },
  { dir: "west", ax: 0, ay: 0.5 }
];

const attacker = (s: SurvivalState): Faction => (s.defender === "blue" ? "red" : "blue");

// ---------------------------------------------------------------- setup ---

/**
 * Turn a freshly created skirmish world into a Last Stand: remove the
 * attacking side's HQ and harvester, find the spawn sites, schedule wave 1.
 */
export function setupSurvival(w: World, opts: SurvivalOptions = {}, defender: Faction = "blue"): void {
  const foe: Faction = defender === "blue" ? "red" : "blue";
  for (const b of [...w.buildings.values()]) if (b.faction === foe) removeBuilding(w, b);
  for (const u of [...w.units.values()]) if (u.faction === foe) w.units.delete(u.id);
  w.factions[foe].scrap = 0;
  const difficulty = opts.difficulty ?? "normal";
  const hq = hqOf(w, defender);
  w.survival = {
    difficulty,
    defender,
    wave: 0,
    theme: null,
    site: -1,
    cleared: 0,
    nextWaveTick: (opts.firstWave ?? SURVIVAL.firstWave[difficulty]) * TICK_RATE,
    warned: false,
    earlyBonus: 0,
    sites: hq ? computeSites(w, hq) : [],
    pending: [],
    spawned: 0,
    lastSpawnTick: -1000,
    bonusEarned: 0,
    marches: [],
    members: new Map(),
    ...(opts.interval ? { interval: opts.interval } : {}),
    wreckShare: SURVIVAL.waveWreckShare
  };
}

/** Ground tiles reachable from around a building (8-way, no corner cutting). */
export function groundReach(w: World, from: Building): Uint8Array {
  const W = w.width;
  const seen = new Uint8Array(W * w.height);
  const queue: number[] = [];
  const size = BUILDINGS[from.kind].size;
  for (let dy = -1; dy <= size; dy++)
    for (let dx = -1; dx <= size; dx++) {
      const x = from.tx + dx;
      const y = from.ty + dy;
      if (!passable(w, x, y, "ground") || seen[y * W + x]) continue;
      seen[y * W + x] = 1;
      queue.push(y * W + x);
    }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!passable(w, nx, ny, "ground")) continue;
        if (dx !== 0 && dy !== 0 && (!passable(w, cx + dx, cy, "ground") || !passable(w, cx, cy + dy, "ground")))
          continue;
        const ni = ny * W + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
  }
  return seen;
}

/** Map-edge entry points far from the HQ, each snapped to reachable ground. */
function computeSites(w: World, hq: Building): SpawnSite[] {
  const c = buildingCenter(hq);
  const reach = groundReach(w, hq);
  const out: SpawnSite[] = [];
  for (const k of COMPASS) {
    const ax = k.ax * w.width;
    const ay = k.ay * w.height;
    if (dist(ax, ay, c.x, c.y) < SURVIVAL.siteMinDist * Math.max(w.width, w.height)) continue;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let ty = 1; ty < w.height - 1; ty++)
      for (let tx = 1; tx < w.width - 1; tx++) {
        if (!reach[ty * w.width + tx]) continue;
        const d = dist(tx + 0.5, ty + 0.5, ax, ay);
        if (d < bestD) {
          bestD = d;
          best = { x: tx + 0.5, y: ty + 0.5 };
        }
      }
    if (!best || bestD > 10) continue;
    out.push({
      x: best.x,
      y: best.y,
      ax: Math.min(w.width - 1.5, Math.max(1.5, ax)),
      ay: Math.min(w.height - 1.5, Math.max(1.5, ay)),
      dir: k.dir
    });
  }
  return out;
}

// ------------------------------------------------------------- planning ---

/** Seeded Fisher–Yates shuffle (a copy). */
function shuffled<T>(w: World, items: readonly T[], salt: string, ...keys: number[]): T[] {
  const perm = [...items];
  for (let i = perm.length - 1; i > 0; i--) {
    const j = worldPick(w, i + 1, salt, ...keys, i);
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  return perm;
}

/** Themes that can open a run: ground waves the starting army can fight. */
const OPENERS: ReadonlySet<WaveTheme> = new Set(["armour", "mixed", "swarm"]);
/**
 * Themes the first block always plays: each needs its own answer (anti-air,
 * anti-infantry), so the defender meets them while they are small.
 */
const FIRST_BLOCK: ReadonlySet<WaveTheme> = new Set(["air", "swarm"]);

/**
 * Which theme (index into SURVIVAL.themes) sits out each block of a cycle of
 * `themes.length` blocks: every theme once per cycle, in a seeded order that
 * never benches a theme in the block before a boss it previews (BOSS_PREVIEW),
 * a FIRST_BLOCK theme in the first block, nor one theme twice running.
 */
function benchOrder(w: World, cycle: number): number[] {
  const all = SURVIVAL.themes;
  const L = all.length;
  const prevLast = cycle > 0 ? benchOrder(w, cycle - 1)[L - 1] : -1;
  const ok = (order: number[]) =>
    order[0] !== prevLast &&
    (cycle > 0 || !FIRST_BLOCK.has(all[order[0]!]!)) &&
    order.every((t, i) => all[t] !== BOSS_PREVIEW[bossVariant(w, (cycle * L + i) * 5 + 5)]);
  const idx = all.map((_, i) => i);
  // a few seeded draws find one: each slot rules out at most three themes, and
  // no theme is ruled out of more than three slots (bosses repeat at most twice in five)
  for (let k = 0; k < 64; k++) {
    const order = shuffled(w, idx, "wave-sitout", cycle, k);
    if (ok(order)) return order;
  }
  return shuffled(w, idx, "wave-sitout", cycle, 0);
}

/**
 * The four regular themes of block `block` (waves 5b+1 … 5b+4), in order.
 * With more themes than slots, one sits the block out (benchOrder).
 */
function blockThemes(w: World, block: number): RegularTheme[] {
  const all = SURVIVAL.themes;
  let pool = [...all];
  if (all.length > 4) {
    const out = benchOrder(w, Math.floor(block / all.length))[block % all.length]!;
    pool = pool.filter((_, i) => i !== out);
  }
  const perm = shuffled(w, pool, "wave-theme", block).slice(0, 4);
  if (block === 0) {
    // the opener is always a ground wave the starting army can fight
    const i = perm.findIndex((t) => OPENERS.has(t));
    if (i > 0) [perm[0], perm[i]] = [perm[i]!, perm[0]!];
  }
  return perm;
}

/** The theme of wave n: a boss every 5th, the others a seeded rotation (blockThemes). */
export function waveTheme(w: World, n: number): WaveTheme {
  if (n % 5 === 0) return "boss";
  const perm = blockThemes(w, Math.floor((n - 1) / 5));
  return perm[((n - 1) % 5) % perm.length]!;
}

/** Display name of wave n's theme (bosses have their own). */
export function waveName(w: World, n: number): string {
  if (waveTheme(w, n) !== "boss") return THEME_NAMES[waveTheme(w, n)];
  return BOSS_NAMES[bossVariant(w, n)]!;
}

/** Which boss wave n is: every three bosses are a seeded shuffle of the three. */
function bossVariant(w: World, n: number): number {
  const k = n / 5 - 1;
  const cycle = Math.floor(k / 3);
  const perm = [0, 1, 2];
  for (let i = 2; i > 0; i--) {
    const j = worldPick(w, i + 1, "wave-boss-order", cycle, i);
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  return perm[k % 3]!;
}

/** Spawn site index for wave n (never the same edge twice in a row). */
export function waveSite(w: World, n: number): number {
  const m = w.survival?.sites.length ?? 0;
  if (m <= 1) return 0;
  let prev = -1;
  let site = 0;
  for (let k = 1; k <= n; k++) {
    site = worldPick(w, m, "wave-site", k);
    if (site === prev) site = (site + 1 + worldPick(w, m - 1, "wave-site-alt", k)) % m;
    prev = site;
  }
  return site;
}

export function waveBudget(difficulty: SurvivalDifficulty, n: number): number {
  const base = SURVIVAL.budgetBase + SURVIVAL.budgetGrowth * pow(n, SURVIVAL.budgetExp);
  return Math.round(base * SURVIVAL.budgetMult[difficulty] * (n % 5 === 0 ? SURVIVAL.bossBudget : 1));
}

/** Veterancy of wave n's units. */
export function waveRank(n: number): number {
  const base = SURVIVAL.rankFrom.filter((from) => n >= from).length;
  return Math.min(3, base + (n % 5 === 0 ? 1 : 0));
}

export interface WavePlan {
  wave: number;
  theme: WaveTheme;
  name: string;
  site: number;
  budget: number;
  rank: number;
  units: UnitKind[];
}

/** Fill `budget` from a weighted pool, deterministically, up to `maxUnits` units in all. */
function fill(w: World, n: number, pool: Pool, budget: number, units: UnitKind[], salt: string, maxUnits = SURVIVAL.maxWaveUnits): number {
  let left = budget;
  const spent = new Map<UnitKind, number>();
  for (const k of units) spent.set(k, (spent.get(k) ?? 0) + UNITS[k].cost);
  const count = (k: UnitKind) => units.filter((u) => u === k).length;
  for (let i = 0; units.length < maxUnits; i++) {
    const cands = pool.filter(
      (p) =>
        n >= (p.from ?? 1) &&
        UNITS[p.kind].cost <= left &&
        (p.maxShare === undefined || (spent.get(p.kind) ?? 0) + UNITS[p.kind].cost <= p.maxShare * budget + 1) &&
        (p.maxCount === undefined || count(p.kind) + 1 <= p.maxCount * maxUnits)
    );
    if (cands.length === 0) break;
    const total = cands.reduce((s, p) => s + p.weight, 0);
    let r = worldRandom(w, salt, n, i) * total;
    let pick = cands[cands.length - 1]!;
    for (const p of cands) {
      r -= p.weight;
      if (r < 0) {
        pick = p;
        break;
      }
    }
    units.push(pick.kind);
    spent.set(pick.kind, (spent.get(pick.kind) ?? 0) + UNITS[pick.kind].cost);
    left -= UNITS[pick.kind].cost;
  }
  return left;
}

/**
 * Waves by role (PANACHE-CONCEPTION.md §1.9, M11): the pools above name
 * Classique kinds; against a nation's waves each one stands for its role
 * (a Stinger for the light tank, a Mortar for the artillery…) and the
 * attacking nation's roster fills it — Gyroptères and Vulcains for the
 * Empire's air, Creusots for its armour, Fusiliers for its swarm. Classique
 * keeps its pools as they are.
 */
const CLASSIC_ROLE: Partial<Record<UnitKind, Role>> = (() => {
  const out: Partial<Record<UnitKind, Role>> = {};
  for (const [role, kind] of Object.entries(ROLES.classique) as [Role, UnitKind][]) if (!out[kind]) out[kind] = role;
  return out;
})();

/** The attacking nation's kind for a Classique pool kind. */
const waveKind = (nation: NationOrClassic, kind: UnitKind): UnitKind => {
  const role = CLASSIC_ROLE[kind];
  return nation === "classique" || !role ? kind : ROLES[nation][role];
};

/** A pool in the attacking nation's kinds (the same pool in Classique); a nation's artillery waves bring its siege guns from wave 6. */
function nationPool(nation: NationOrClassic, pool: Pool, theme?: RegularTheme): Pool {
  if (nation === "classique") return pool;
  const out = pool.map((p) => ({ ...p, kind: waveKind(nation, p.kind) }));
  const siege = ROLES[nation].siege;
  if (theme === "artillery" && siege !== ROLES[nation].artillery) out.push({ kind: siege, weight: 1, from: 6, maxShare: 0.4 });
  return out;
}

/** The side the waves fight for (the defender's enemy). */
const waveNation = (w: World): NationOrClassic => nationOf(w, w.survival ? attacker(w.survival) : "red");

/** Everything about wave n, as a pure function of the seed and difficulty. */
export function planWave(w: World, n: number, difficulty: SurvivalDifficulty = w.survival?.difficulty ?? "normal"): WavePlan {
  const theme = waveTheme(w, n);
  const budget = waveBudget(difficulty, n);
  const units: UnitKind[] = [];
  const nation = waveNation(w);
  if (theme === "boss") {
    const raw = BOSS_POOLS[bossVariant(w, n)]!;
    const boss = nation === "classique" ? raw : { ...raw, core: waveKind(nation, raw.core), escorts: nationPool(nation, raw.escorts) };
    let core = budget * boss.share;
    do {
      units.push(boss.core);
      core -= UNITS[boss.core].cost;
    } while (core >= UNITS[boss.core].cost * 0.6);
    const left = budget - units.length * UNITS[boss.core].cost;
    fill(w, n, boss.escorts, left, units, "wave-boss");
  } else {
    // artillery always brings at least one gun
    const gun = waveKind(nation, "mortar");
    if (theme === "artillery") units.push(gun);
    const cap = theme === "swarm" ? SURVIVAL.swarmMaxUnits : SURVIVAL.maxWaveUnits;
    fill(w, n, nationPool(nation, POOLS[theme], theme), budget - (theme === "artillery" ? UNITS[gun].cost : 0), units, `wave-${theme}`, cap);
  }
  // front-liners enter first (rifle and rocket squads among them), support last (Sniper Teams too)
  const order = (k: UnitKind) =>
    UNITS[k].armor === "heavy" ? 0 : !isMarksman(k) && (UNITS[k].targets === "ground" || isInfantry(k)) ? 1 : 2;
  units.sort((a, b) => order(a) - order(b));
  return { wave: n, theme, name: waveName(w, n), site: waveSite(w, n), budget, rank: waveRank(n), units };
}

// ----------------------------------------------------------------- tick ---

const isWaveUnit = (s: SurvivalState, u: Unit) => u.faction !== s.defender;

/** Live wave units plus those still queued off-map. */
export function waveUnitsLeft(w: World): number {
  const s = w.survival;
  if (!s) return 0;
  let n = s.pending.length;
  for (const u of w.units.values()) if (isWaveUnit(s, u)) n++;
  return n;
}

/** Advance the wave director one tick (called from step after deaths). */
export function tickSurvival(w: World): void {
  const s = w.survival;
  if (!s || w.winner) return;
  // Last Stand is a base to hold: the run ends when the HQ falls, Goliath or not
  if (!hqOf(w, s.defender)) {
    w.winner = attacker(s);
    return;
  }
  const warnTicks = SURVIVAL.warn * TICK_RATE;

  // the field is clear: pay the bonus and bring the next wave forward
  if (s.wave > s.cleared && waveUnitsLeft(w) === 0) {
    s.cleared = s.wave;
    const bonus = SURVIVAL.clearBonus * s.wave;
    w.factions[s.defender].scrap += bonus;
    s.bonusEarned += bonus;
    if (!s.warned) s.nextWaveTick = Math.min(s.nextWaveTick, w.tick + SURVIVAL.afterClear * TICK_RATE);
    w.fx.push({ type: "waveCleared", wave: s.wave, bonus, next: waveName(w, s.wave + 1), nextTheme: waveTheme(w, s.wave + 1) });
  }

  // public warning ahead of the next wave
  if (!s.warned && w.tick >= s.nextWaveTick - warnTicks) {
    s.warned = true;
    const n = s.wave + 1;
    const site = s.sites[waveSite(w, n)];
    if (site)
      w.fx.push({
        type: "waveIncoming", wave: n, theme: waveTheme(w, n), name: waveName(w, n),
        x: site.x, y: site.y, dir: site.dir, eta: Math.max(0, s.nextWaveTick - w.tick), early: s.earlyBonus
      });
    s.earlyBonus = 0;
  }

  // the wave arrives
  if (w.tick >= s.nextWaveTick) {
    const plan = planWave(w, s.wave + 1, s.difficulty);
    s.wave = plan.wave;
    s.theme = plan.theme;
    s.site = plan.site;
    s.warned = false;
    const every = s.interval ?? SURVIVAL.interval;
    s.nextWaveTick = w.tick + (plan.theme === "boss" ? every + SURVIVAL.bossInterval - SURVIVAL.interval : every) * TICK_RATE;
    for (const kind of plan.units)
      if (s.pending.length < SURVIVAL.maxPending)
        s.pending.push({ kind, rank: plan.rank, wave: plan.wave, site: plan.site });
    const site = s.sites[plan.site];
    if (site) {
      const obj = objective(w, s, plan.theme, site.x, site.y);
      if (obj) s.marches.push({ wave: plan.wave, theme: plan.theme, id: obj.id, x: obj.x, y: obj.y, site: plan.site, started: w.tick });
      w.fx.push({
        type: "waveSpawned", wave: plan.wave, theme: plan.theme, name: plan.name,
        x: site.x, y: site.y, count: plan.units.length
      });
    }
  }

  // units stream in from the edge, a few per second, under the live cap
  if (s.pending.length > 0 && w.tick - s.lastSpawnTick >= SURVIVAL.spawnEvery) {
    let live = 0;
    for (const u of w.units.values()) if (isWaveUnit(s, u)) live++;
    if (live < SURVIVAL.maxLive) {
      const p = s.pending.shift()!;
      spawnWaveUnit(w, s, p);
      s.lastSpawnTick = w.tick;
    }
  }

  if (w.tick % TICK_RATE === 0) tickMarches(w, s);
  if (w.tick % SURVIVAL.retaskTicks === 0) retask(w, s);
}

/** Keep marching waves together; release them to fight near the base. */
function tickMarches(w: World, s: SurvivalState): void {
  for (const id of s.members.keys()) if (!w.units.has(id)) s.members.delete(id);
  for (const m of s.marches) {
    const units: Unit[] = [];
    for (const [id, wave] of s.members) if (wave === m.wave) units.push(w.units.get(id)!);
    const queued = s.pending.some((p) => p.wave === m.wave);
    if (units.length === 0) {
      if (!queued) m.started = -1; // nothing left to lead
      continue;
    }
    // the objective is gone: aim at whatever is nearest the column instead
    if (!w.buildings.has(m.id) && !w.units.has(m.id)) {
      const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
      const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
      const obj = objective(w, s, m.theme, cx, cy);
      if (!obj) continue;
      m.id = obj.id;
      m.x = obj.x;
      m.y = obj.y;
    }
    const engaged = units.some(
      (u) => u.autoTargetId !== null || u.order.type === "attack" || w.tick - u.damagedTick < 3 * TICK_RATE
    );
    const arrived = units.some((u) => dist(u.x, u.y, m.x, m.y) < SURVIVAL.releaseDist);
    if (engaged || arrived || w.tick - m.started > SURVIVAL.marchTimeout * TICK_RATE) {
      // release: every unit picks its own target from here
      for (const u of units) orderWaveUnit(u, objective(w, s, m.theme, u.x, u.y));
      m.started = -1;
      continue;
    }
    const site = s.sites[m.site];
    let rear = queued && site ? dist(site.x, site.y, m.x, m.y) : 0;
    for (const u of units) rear = Math.max(rear, dist(u.x, u.y, m.x, m.y));
    for (const u of units) {
      const ahead = dist(u.x, u.y, m.x, m.y) < rear - SURVIVAL.cohesion;
      if (ahead && u.order.type !== "idle") {
        u.order = { type: "idle" };
        u.path = null;
      } else if (!ahead && u.order.type === "idle") {
        u.order = { type: "attackMove", x: m.x, y: m.y };
        u.path = null;
      }
    }
  }
  s.marches = s.marches.filter((m) => m.started >= 0);
}

/** Is this unit still marching with its wave (not free to pick targets)? */
function marching(s: SurvivalState, u: Unit): March | null {
  const wave = s.members.get(u.id);
  return wave === undefined ? null : s.marches.find((m) => m.wave === wave) ?? null;
}

/** Small reachable formation area around a site (BFS, radius 3) for one movement class. */
function formationSlots(w: World, site: SpawnSite, mc: MoveClass): { x: number; y: number }[] {
  const sx = Math.floor(site.x);
  const sy = Math.floor(site.y);
  const out: { x: number; y: number }[] = [];
  const seen = new Set<number>([sy * w.width + sx]);
  const queue = [[sx, sy] as [number, number]];
  for (let head = 0; head < queue.length && out.length < 12; head++) {
    const [cx, cy] = queue[head]!;
    out.push({ x: cx + 0.5, y: cy + 0.5 });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(w, nx, ny) || Math.abs(nx - sx) > 3 || Math.abs(ny - sy) > 3) continue;
      if (nx < 1 || ny < 1 || nx > w.width - 2 || ny > w.height - 2) continue;
      if (seen.has(ny * w.width + nx) || !passable(w, nx, ny, mc)) continue;
      seen.add(ny * w.width + nx);
      queue.push([nx, ny]);
    }
  }
  return out;
}

function spawnWaveUnit(w: World, s: SurvivalState, p: PendingSpawn): void {
  const site = s.sites[p.site] ?? s.sites[0];
  if (!site) return;
  const jx = worldRandom(w, "spawn-jx", s.spawned) - 0.5;
  const jy = worldRandom(w, "spawn-jy", s.spawned) - 0.5;
  let x: number;
  let y: number;
  const mc = moveClassOf(p.kind);
  if (mc === "air") {
    x = site.ax + jx * 2;
    y = site.ay + jy * 2;
  } else {
    // squads form up on ground they can walk (sites are tank-reachable, and foot ⊇ tracks today)
    const slots = formationSlots(w, site, mc === "foot" ? "foot" : "ground");
    const slot = slots[s.spawned % Math.max(1, slots.length)] ?? site;
    x = slot.x + jx * 0.5;
    y = slot.y + jy * 0.5;
  }
  s.spawned++;
  const u = spawnUnit(w, p.kind, attacker(s), x, y);
  if (p.rank > 0) {
    u.rank = p.rank;
    u.xp = COMBAT.rankXp[p.rank - 1]! * UNITS[p.kind].cost;
  }
  const hq = hqOf(w, s.defender);
  if (hq) {
    const c = buildingCenter(hq);
    u.facing = u.aim = atan2(c.x - x, -(c.y - y));
  }
  w.factions[attacker(s)].stats.unitsBuilt++;
  s.members.set(u.id, p.wave);
  const m = marching(s, u);
  if (m) {
    u.order = { type: "attackMove", x: m.x, y: m.y };
    return;
  }
  orderWaveUnit(u, objective(w, s, waveTheme(w, p.wave), x, y));
}

interface Objective {
  id: number;
  x: number;
  y: number;
  /** Harvesters move: they get chased with an attack order. */
  mobile: boolean;
}

const PRODUCTION = new Set(["fab-plant", "airpad", "assembly-bay", "tech-lab", "depot"]);
const DEFENCES = new Set(["turret", "sam-site", "arsonval", "flak-battery"]);
/** A harvester of any roster (a Fardier, a Fourgon). */
const isMiner = (k: UnitKind) => k === "harvester" || UNITS[k].base === "harvester";
/** A marksman squad of any roster (Sniper Team, Carabiniers). */
const isMarksman = (k: UnitKind) => k === "sniper" || UNITS[k].base === "sniper";

/** Nearest defender building matching `filter` to (x, y). */
function nearestBuilding(w: World, s: SurvivalState, x: number, y: number, filter?: (b: Building) => boolean): Objective | null {
  let best: Objective | null = null;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.faction !== s.defender || (filter && !filter(b))) continue;
    const d = distToBuilding(b, x, y);
    if (d < bestD) {
      bestD = d;
      const c = buildingCenter(b);
      best = { id: b.id, x: c.x, y: c.y, mobile: false };
    }
  }
  return best;
}

function nearestHarvester(w: World, s: SurvivalState, x: number, y: number): Objective | null {
  let best: Objective | null = null;
  let bestD = Infinity;
  for (const u of w.units.values()) {
    if (u.faction !== s.defender || !isMiner(u.kind)) continue;
    const d = dist(u.x, u.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = { id: u.id, x: u.x, y: u.y, mobile: true };
    }
  }
  return best;
}

/**
 * Where a wave unit goes. The director knows where the base is (it's a
 * siege, not a scouting game). Air raids hunt harvesters, artillery shells
 * the defences, columns and bot swarms overrun the nearest structure,
 * bosses go for the HQ.
 */
function objective(w: World, s: SurvivalState, theme: WaveTheme, x: number, y: number): Objective | null {
  const any = () => nearestBuilding(w, s, x, y);
  const hq = () => {
    const b = hqOf(w, s.defender);
    if (!b) return null;
    const c = buildingCenter(b);
    return { id: b.id, x: c.x, y: c.y, mobile: false };
  };
  switch (theme) {
    case "air":
      return nearestHarvester(w, s, x, y) ?? nearestBuilding(w, s, x, y, (b) => PRODUCTION.has(b.kind)) ?? any();
    case "artillery":
      return nearestBuilding(w, s, x, y, (b) => DEFENCES.has(b.kind)) ?? any();
    case "mixed":
      return nearestBuilding(w, s, x, y, (b) => PRODUCTION.has(b.kind)) ?? any();
    case "boss":
      return hq() ?? any();
    case "armour":
    case "swarm":
      return any();
  }
}

function orderWaveUnit(u: Unit, obj: Objective | null): void {
  if (!obj) return;
  const st = UNITS[u.kind];
  const hitsGround = st.targets === "ground" || st.targets === "both";
  u.path = null;
  u.autoTargetId = null;
  if (obj.mobile && hitsGround) u.order = { type: "attack", targetId: obj.id };
  else u.order = { type: "attackMove", x: obj.x, y: obj.y };
}

/**
 * What a wave Sniper Team should shoot: the nearest defender ground unit it
 * can see within sight + 2 tiles, squads first (a rail-rifle barely
 * scratches armour and does next to nothing to buildings).
 */
function sniperPrey(w: World, s: SurvivalState, u: Unit): Objective | null {
  const reach = UNITS[u.kind].sight + 2;
  let best: Objective | null = null;
  let bestScore = Infinity;
  for (const o of w.units.values()) {
    if (o.faction !== s.defender || UNITS[o.kind].domain !== "ground") continue;
    const d = dist(o.x, o.y, u.x, u.y);
    if (d > reach || !unitSeenBy(w, u.faction, o)) continue;
    const score = d - (isInfantry(o.kind) ? 4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { id: o.id, x: o.x, y: o.y, mobile: true };
    }
  }
  return best;
}

/** Nearest ally a support unit should shadow (`ground`: walkers only), and how far it is. */
function nearestBuddy(w: World, u: Unit, ground: boolean): { buddy: Unit | null; d: number } {
  let buddy: Unit | null = null;
  let bestD = Infinity;
  for (const o of w.units.values()) {
    if (o.faction !== u.faction || o.id === u.id || isMarksman(o.kind)) continue;
    const ot = UNITS[o.kind].targets;
    if (ot !== "ground" && ot !== "both") continue;
    if (ground && UNITS[o.kind].domain !== "ground") continue;
    const d = dist(o.x, o.y, u.x, u.y);
    if (d < bestD) {
      bestD = d;
      buddy = o;
    }
  }
  return { buddy, d: bestD };
}

/**
 * Idle wave units with nothing in reach pick the nearest thing to destroy.
 * Sniper Teams (once their wave is released) hunt units instead: they drop
 * a building for any defender in sight, and otherwise hang back with the
 * nearest squad or tank.
 */
function retask(w: World, s: SurvivalState): void {
  for (const u of w.units.values()) {
    if (!isWaveUnit(s, u) || marching(s, u)) continue;
    if (isMarksman(u.kind)) {
      const busy = (id: number | null) => id !== null && w.units.has(id);
      if (busy(u.order.type === "attack" ? u.order.targetId : null) || busy(u.autoTargetId)) continue;
      const prey = sniperPrey(w, s, u);
      if (prey) {
        orderWaveUnit(u, prey);
        continue;
      }
      if (u.order.type !== "idle" || u.autoTargetId !== null) continue;
      const { buddy, d } = nearestBuddy(w, u, true);
      if (buddy && d > 2.5) orderWaveUnit(u, { id: buddy.id, x: buddy.x, y: buddy.y, mobile: false });
      else if (!buddy) orderWaveUnit(u, objective(w, s, "boss", u.x, u.y));
      continue;
    }
    if (u.order.type !== "idle" || u.autoTargetId !== null) continue;
    const st = UNITS[u.kind];
    let obj: Objective | null;
    if (st.targets === "air" || st.targets === "none") {
      // escorts (flak, raptors, menders) shadow the nearest ground-attacking ally
      const { buddy, d } = nearestBuddy(w, u, false);
      obj = buddy && d > 2.5 ? { id: buddy.id, x: buddy.x, y: buddy.y, mobile: false } : buddy ? null : objective(w, s, "boss", u.x, u.y);
    } else {
      const h = nearestHarvester(w, s, u.x, u.y);
      const b = nearestBuilding(w, s, u.x, u.y);
      // a harvester close by is too tempting; otherwise the nearest structure
      obj = h && (!b || dist(h.x, h.y, u.x, u.y) < dist(b.x, b.y, u.x, u.y) + 4) ? h : b;
    }
    orderWaveUnit(u, obj);
  }
}

// ------------------------------------------------------- player actions ---

/**
 * Scrap the defender would get for calling the next wave right now (0 =
 * can't): only with the field clear, and not before wave 1 (the opening
 * build-up is no time for a misclick).
 */
export function earlyCallBonus(w: World): number {
  const s = w.survival;
  if (!s || w.winner || s.warned || s.wave < 1 || waveUnitsLeft(w) > 0) return 0;
  const skipped = s.nextWaveTick - SURVIVAL.warn * TICK_RATE - w.tick;
  if (skipped < 3 * TICK_RATE) return 0;
  return Math.round((skipped / TICK_RATE) * (SURVIVAL.earlyBase + SURVIVAL.earlyPerWave * (s.wave + 1)));
}

/** The defender calls the next wave now (its warning starts this tick) for a bonus. */
export function callWaveEarly(w: World, faction: Faction): void {
  const s = w.survival;
  if (!s || faction !== s.defender) return;
  const bonus = earlyCallBonus(w);
  if (bonus <= 0) return;
  w.factions[faction].scrap += bonus;
  s.bonusEarned += bonus;
  s.earlyBonus = bonus;
  s.nextWaveTick = w.tick + SURVIVAL.warn * TICK_RATE;
}

// --------------------------------------------------------------- status ---

/** Waves survived so far: every spawned wave, minus the current one unless its field was cleared. */
export function wavesSurvived(w: World): number {
  const s = w.survival;
  if (!s) return 0;
  return s.cleared >= s.wave ? s.wave : s.wave - 1;
}

export interface SurvivalStatus {
  wave: number;
  /** Units of the current wave still alive or queued. */
  left: number;
  next: number;
  nextTheme: WaveTheme;
  nextName: string;
  /** Seconds until the next wave spawns. */
  nextIn: number;
  warned: boolean;
  /** Where the next wave enters (once warned) or the current one entered. */
  site: SpawnSite | null;
  callBonus: number;
  survived: number;
}

export function survivalStatus(w: World): SurvivalStatus | null {
  const s = w.survival;
  if (!s) return null;
  const next = s.wave + 1;
  const left = waveUnitsLeft(w);
  const site = s.warned ? s.sites[waveSite(w, next)] ?? null : left > 0 ? s.sites[s.site] ?? null : null;
  return {
    wave: s.wave,
    left,
    next,
    nextTheme: waveTheme(w, next),
    nextName: waveName(w, next),
    nextIn: Math.max(0, (s.nextWaveTick - w.tick) / TICK_RATE),
    warned: s.warned,
    site,
    callBonus: earlyCallBonus(w),
    survived: wavesSurvived(w)
  };
}

/**
 * For a defending AI: a point to hold. Attackers it can see near the base
 * come first (the base is under siege); otherwise a line a few tiles out
 * toward where the next (or current) wave enters — that much is public.
 */
export function survivalHoldPoint(w: World, faction: Faction): { x: number; y: number; engage: boolean } | null {
  const s = w.survival;
  if (!s || faction !== s.defender) return null;
  const hq = hqOf(w, faction);
  if (!hq) return null;
  const c = buildingCenter(hq);
  let near: Unit | null = null;
  let bestD = Infinity;
  for (const u of w.units.values()) {
    if (!isWaveUnit(s, u) || !unitSeenBy(w, faction, u)) continue; // (a Sniper hidden in the woods is no engage point)
    let d = dist(u.x, u.y, c.x, c.y);
    for (const b of w.buildings.values())
      if (b.faction === faction) d = Math.min(d, distToBuilding(b, u.x, u.y));
    if (d < bestD) {
      bestD = d;
      near = u;
    }
  }
  if (near && bestD < 14) return { x: near.x, y: near.y, engage: true };
  const site = s.sites[s.warned || waveUnitsLeft(w) === 0 ? waveSite(w, s.wave + 1) : s.site];
  if (!site) return { x: c.x, y: c.y, engage: false };
  const d = Math.max(1, dist(c.x, c.y, site.x, site.y));
  const k = Math.min(7, d) / d;
  return { x: c.x + (site.x - c.x) * k, y: c.y + (site.y - c.y) * k, engage: false };
}
