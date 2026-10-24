// One AI-vs-AI match with the pacing panel's measurements (tools/pacing.ts).
// Pure simulation: no Node APIs, so tests can import it.
import { PERSONALITIES, createAiState, tickAi, type Difficulty, type PersonalityName } from "../src/sim/ai/commander";
import { BUILDINGS, OBJECTIVES, TICK_RATE, UNITS } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { pickAiOpener } from "../src/sim/openers";
import { rulesOf } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import { behaves, buildingMaxHp } from "../src/sim/nations";
import { isSuperKind } from "../src/sim/goliath";
import type { BuildingKind, Faction, FxEvent, Nation, UnitKind, World } from "../src/sim/types";
import { buildingCenter, hqOf, tileIndex } from "../src/sim/world";
import { Terrain } from "../src/sim/types";

const COMBAT = new Set<UnitKind>([
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "mender", "trooper", "rocket-squad", "sniper"
]);
const SIDES: Faction[] = ["blue", "red"];

export interface Match {
  map: string;
  blue: PersonalityName;
  red: PersonalityName;
  seed: number;
  openers: Record<Faction, string>;
  winner: Faction | "draw";
  min: number;
  firstCombatDeath: number | null;
  /** Unit deaths in 10 bins along the blue HQ → red HQ line (all units / combat units). */
  bins: number[];
  combatBins: number[];
  /** Leader by > 200 value (units × HP share + buildings + scrap) at minute m, or null. */
  leadAt: Record<number, Faction | null>;
  /** Times the value lead (300 deadband, checked every 15 s) changed sides. */
  leadChanges: number;
  /** Was this side ever 800+ value behind? */
  wasBehind: Record<Faction, boolean>;
  /** Scrap destroyed per 10 s window. */
  series: number[];
  /** Big fights: runs of 10 s windows with ≥ 300 destroyed (a window under 150 ends one), ≥ 1000 in all. */
  fights: { start: number; end: number; destroyed: number }[];
  calldowns: Record<Faction, Record<string, number>>;
  uplinkFlips: number;
  /** Times a holder lost an Uplink (it changed hands). */
  uplinkLost: number;
  cratesLanded: number;
  cratesClaimed: number;
  /** Scrap each side had harvested by 4:00 (side-fairness check). */
  harvest4: Record<Faction, number>;
  /** Scrap value of the units each side built, by group (harvesters left out). */
  built: Record<Faction, Record<UnitGroup, number>>;
  /** Squads a Condor set down in an Uplink's zone vs anywhere else (drops, not bail-outs), and bail-outs. */
  unloads: { relay: number; elsewhere: number; bailout: number };
  /** Island Uplinks (infantry only) taken per side, how many of them from the other side, and when each side took its first (s). */
  islandCaptures: Record<Faction, number>;
  islandRetakes: Record<Faction, number>;
  firstIsland: Record<Faction, number | null>;
  /** Relay-seconds each side's island Uplinks were crewed (paying), summed over relays. */
  crewedSecs: Record<Faction, number>;
  /** Unit deaths in all, and within 8 tiles of an Uplink. */
  unitDeaths: number;
  relayDeaths: number;
  /** Condors each side lost. */
  condorsLost: Record<Faction, number>;
  /** Scrap each side harvested, and was paid by Uplinks, over the match. */
  income: Record<Faction, { harvested: number; uplinks: number }>;
  /** Wall-clock cost (only with `timing`: it makes replays differ). */
  perf?: { msPerMin: number; worstTick: number };
  /** A nations match's own measurements (PANACHE-CONCEPTION.md §1.8, WP4). */
  nat?: NationLog;
}

/** Per-kind tallies of a nations match: built, lost, and the value its killing blows took. */
export interface KindTally {
  built: number;
  /** Scrap paid for them. */
  spent: number;
  lost: number;
  /** Scrap value of enemy units / buildings it dealt the killing blow to. */
  killedUnits: number;
  killedBuildings: number;
}

export interface NationLog {
  nations: Record<Faction, Nation>;
  /** Each side's army (non-worker units, cost × HP share; super-units apart), at the end of each minute. */
  army: Record<Faction, number[]>;
  /** Super-units' value (cost × HP share) at each minute. */
  supers: Record<Faction, number[]>;
  /** Harvest so far (scrap), at each minute. */
  harvest: Record<Faction, number[]>;
  /** Workers alive at each minute. */
  workers: Record<Faction, number[]>;
  /** Buildings' value (cost) standing at each minute. */
  base: Record<Faction, number[]>;
  /** Scrap in the bank at each minute. */
  bank: Record<Faction, number[]>;
  /** Seconds the side's Gantry (Hangar / Galerie) stood complete, its first super-unit rolled out; null: never. */
  gantryAt: Record<Faction, number | null>;
  superAt: Record<Faction, number | null>;
  superCount: Record<Faction, number>;
  /** Seconds each side's first wave launched (AiState.firstWaveTick), and waves launched. */
  firstWave: Record<Faction, number | null>;
  waves: Record<Faction, number>;
  /** Seconds each production building first stood complete. */
  firstBuilt: Record<Faction, Partial<Record<BuildingKind, number>>>;
  kinds: Record<Faction, Partial<Record<UnitKind, KindTally>>>;
  /** Share of the workers' digging time spent on radium (crystal) tiles. */
  radiumShare: Record<Faction, number>;
  /** Seconds République buildings stood unpowered (summed over buildings). */
  darkSecs: Record<Faction, number>;
  /** Calldowns fired by kind. */
  powers: Record<Faction, Record<string, number>>;
}

/** Unit groups for the value-built tally. */
export type UnitGroup = "infantry" | "condor" | "air" | "vehicles";

export function unitGroup(kind: UnitKind): UnitGroup | null {
  if (kind === "harvester") return null;
  if (kind === "condor") return "condor";
  if (UNITS[kind].squad) return "infantry";
  return UNITS[kind].domain === "air" ? "air" : "vehicles";
}

export interface PlayOptions {
  /** AI difficulty for both sides (default Normal). */
  difficulty?: Difficulty;
  /** Record wall-clock cost (Match.perf). */
  timing?: boolean;
  /** Ban the Goliath (and so its Gantry) for both sides: a match about something else, at the old pace. */
  noGoliath?: boolean;
  /** A nations match (blue's and red's nations): records `Match.nat`. */
  nations?: Record<Faction, Nation>;
  /** Minutes before a draw (default 25). */
  capMin?: number;
  /** No quick-start openers (the classic HQ-and-one-harvester start). */
  noOpeners?: boolean;
  /** No map objectives (Uplinks, supply drops). */
  noObjectives?: boolean;
  /** The commanders leave unit skills alone (sim/skills.ts). */
  noSkills?: boolean;
}

export function playMatch(map: string, blue: PersonalityName, red: PersonalityName, seed: number, aiSeed: number, opts: PlayOptions = {}): Match {
  const openers = { blue: pickAiOpener(PERSONALITIES[blue].name, seed, "blue"), red: pickAiOpener(PERSONALITIES[red].name, seed, "red") };
  const base = { seed, objectives: !opts.noObjectives, ...(opts.noOpeners ? {} : { openers }) };
  const w = createMapWorld(map, opts.nations ? { ...base, nations: opts.nations } : base);
  if (opts.noGoliath) {
    const r = rulesOf(w);
    w.rules = { ...r, bannedUnits: [...r.bannedUnits, "goliath"], bannedBuildings: [...r.bannedBuildings, "gantry"] };
  }
  const diff = opts.difficulty ?? "normal";
  const tweak = opts.noSkills ? { skills: false } : undefined;
  const ai = { blue: createAiState(blue, diff, aiSeed, tweak), red: createAiState(red, diff, aiSeed + 1, tweak) };
  const A = buildingCenter(hqOf(w, "blue")!);
  const B = buildingCenter(hqOf(w, "red")!);
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const vv = vx * vx + vy * vy;
  const m: Match = {
    map, blue, red, seed, openers, winner: "draw", min: 0, firstCombatDeath: null,
    bins: new Array(10).fill(0), combatBins: new Array(10).fill(0), leadAt: {}, leadChanges: 0,
    wasBehind: { blue: false, red: false }, series: [], fights: [], calldowns: { blue: {}, red: {} },
    uplinkFlips: 0, uplinkLost: 0, cratesLanded: 0, cratesClaimed: 0, harvest4: { blue: 0, red: 0 },
    built: { blue: { infantry: 0, condor: 0, air: 0, vehicles: 0 }, red: { infantry: 0, condor: 0, air: 0, vehicles: 0 } },
    unloads: { relay: 0, elsewhere: 0, bailout: 0 },
    islandCaptures: { blue: 0, red: 0 }, islandRetakes: { blue: 0, red: 0 }, firstIsland: { blue: null, red: null },
    crewedSecs: { blue: 0, red: 0 }, unitDeaths: 0, relayDeaths: 0, condorsLost: { blue: 0, red: 0 },
    income: { blue: { harvested: 0, uplinks: 0 }, red: { harvested: 0, uplinks: 0 } }
  };
  const uplinks = w.objectives.uplinks;
  const R = OBJECTIVES.uplink.radius;
  /** Uplink id → the side that last held it (a capture from the other side is a retake). */
  const lastHeld = new Map<number, Faction>();
  const t0 = opts.timing ? performance.now() : 0;
  let worstTick = 0;
  const value = (f: Faction) => {
    let v = w.factions[f].scrap;
    for (const u of w.units.values()) if (u.faction === f) v += UNITS[u.kind].cost * (u.hp / UNITS[u.kind].hp);
    for (const b of w.buildings.values()) if (b.faction === f) v += BUILDINGS[b.kind].cost;
    return v;
  };
  let leader: Faction | null = null;
  let window = 0;
  const nat = opts.nations ? natWatch(w, opts.nations) : null;
  const cap = (opts.capMin ?? 25) * 60 * TICK_RATE;
  for (let i = 0; i < cap && !w.winner; i++) {
    const tickStart = opts.timing ? performance.now() : 0;
    step(w, [...tickAi(w, "blue", ai.blue), ...tickAi(w, "red", ai.red)]);
    if (opts.timing) worstTick = Math.max(worstTick, performance.now() - tickStart);
    const t = w.tick / TICK_RATE;
    nat?.tick();
    for (const ev of w.fx as FxEvent[]) {
      if (ev.type === "death") {
        window += ev.unitKind ? UNITS[ev.unitKind].cost : BUILDINGS[ev.buildingKind!].cost || 500;
        if (!ev.unitKind) continue;
        m.unitDeaths++;
        if (uplinks.some((l) => Math.hypot(l.x - ev.x, l.y - ev.y) <= 8)) m.relayDeaths++;
        if (ev.unitKind === "condor") m.condorsLost[ev.faction]++;
        const combat = COMBAT.has(ev.unitKind);
        if (combat && m.firstCombatDeath === null) m.firstCombatDeath = t;
        const bin = Math.max(0, Math.min(9, Math.floor((((ev.x - A.x) * vx + (ev.y - A.y) * vy) / vv) * 10)));
        m.bins[bin]!++;
        if (combat) m.combatBins[bin]!++;
      } else if (ev.type === "uplinkFlip") {
        m.uplinkFlips++;
        if (ev.prev) m.uplinkLost++;
        const l = uplinks.find((u) => u.id === ev.id);
        if (ev.owner && l?.infantryOnly) {
          m.islandCaptures[ev.owner]++;
          if (lastHeld.get(ev.id) && lastHeld.get(ev.id) !== ev.owner) m.islandRetakes[ev.owner]++;
          m.firstIsland[ev.owner] ??= t;
        }
        if (ev.owner) lastHeld.set(ev.id, ev.owner);
      } else if (ev.type === "built") {
        const u = w.units.get(ev.id);
        const g = u && unitGroup(u.kind);
        if (u && g) m.built[u.faction][g] += UNITS[u.kind].cost;
      } else if (ev.type === "disembark") {
        if (ev.bailout) m.unloads.bailout += ev.unitIds.length;
        else if (uplinks.some((l) => Math.hypot(l.x - ev.x, l.y - ev.y) <= R)) m.unloads.relay += ev.unitIds.length;
        else m.unloads.elsewhere += ev.unitIds.length;
      } else if (ev.type === "crateLanded") m.cratesLanded++;
      else if (ev.type === "crateClaimed") m.cratesClaimed++;
    }
    if (w.tick % TICK_RATE === 0) for (const l of uplinks) if (l.infantryOnly && l.owner && l.crewed) m.crewedSecs[l.owner]++;
    if (w.tick % (10 * TICK_RATE) === 0) {
      m.series.push(window);
      window = 0;
    }
    if (w.tick % (15 * TICK_RATE) === 0) {
      const d = value("blue") - value("red");
      const now: Faction | null = d > 300 ? "blue" : d < -300 ? "red" : leader;
      if (leader && now !== leader) m.leadChanges++;
      leader = now;
      if (d < -800) m.wasBehind.blue = true;
      if (d > 800) m.wasBehind.red = true;
    }
    if (w.tick === 4 * 60 * TICK_RATE) for (const s of SIDES) m.harvest4[s] = w.factions[s].stats.scrapHarvested;
    if (w.tick % (60 * TICK_RATE) === 0 && w.tick <= 6 * 60 * TICK_RATE) {
      const d = value("blue") - value("red");
      m.leadAt[w.tick / (60 * TICK_RATE)] = Math.abs(d) < 200 ? null : d > 0 ? "blue" : "red";
    }
  }
  if (window > 0) m.series.push(window);
  m.winner = w.winner ?? "draw";
  m.min = w.tick / TICK_RATE / 60;
  let f: { start: number; end: number; destroyed: number } | null = null;
  m.series.forEach((d, i) => {
    if (d >= 300) {
      f ??= { start: i * 10, end: i * 10 + 10, destroyed: 0 };
      f.destroyed += d;
      f.end = i * 10 + 10;
    } else if (f && d < 150) {
      if (f.destroyed >= 1000) m.fights.push(f);
      f = null;
    } else if (f) {
      f.destroyed += d;
      f.end = i * 10 + 10;
    }
  });
  if (f && (f as { destroyed: number }).destroyed >= 1000) m.fights.push(f);
  for (const s of SIDES) {
    m.calldowns[s] = { ...w.powers.fired[s] };
    m.income[s] = { harvested: Math.round(w.factions[s].stats.scrapHarvested), uplinks: Math.round(w.objectives.stats[s].uplinkScrap) };
  }
  if (nat) {
    nat.finish();
    for (const f of SIDES) {
      nat.log.firstWave[f] = ai[f].firstWaveTick !== undefined ? ai[f].firstWaveTick! / TICK_RATE : null;
      nat.log.waves[f] = ai[f].waves ?? 0;
      nat.log.powers[f] = { ...w.powers.fired[f] };
    }
    m.nat = nat.log;
  }
  if (opts.timing) m.perf = { msPerMin: Math.round((performance.now() - t0) / Math.max(1e-9, m.min)), worstTick: Math.round(worstTick * 10) / 10 };
  return m;
}


const PRODUCERS: BuildingKind[] = ["fab-plant", "airpad", "tech-lab", "assembly-bay", "gantry", "depot", "radar"];

/** Watch a nations match tick by tick and fill in its NationLog. */
function natWatch(w: World, nations: Record<Faction, Nation>): { log: NationLog; tick(): void; finish(): void } {
  const per = <T,>(mk: () => T): Record<Faction, T> => ({ blue: mk(), red: mk() });
  const log: NationLog = {
    nations, army: per(() => []), supers: per(() => []), harvest: per(() => []), workers: per(() => []), base: per(() => []), bank: per(() => []),
    gantryAt: per(() => null), superAt: per(() => null), superCount: per(() => 0), firstWave: per(() => null), waves: per(() => 0),
    firstBuilt: per(() => ({})), kinds: per(() => ({})), radiumShare: per(() => 0), darkSecs: per(() => 0), powers: per(() => ({}))
  };
  const tally = (f: Faction, k: UnitKind): KindTally => (log.kinds[f][k] ??= { built: 0, spent: 0, lost: 0, killedUnits: 0, killedBuildings: 0 });
  const dig: Record<Faction, [number, number]> = { blue: [0, 0], red: [0, 0] };
  const minute = () => {
    for (const f of SIDES) {
      let army = 0;
      let sup = 0;
      let workers = 0;
      for (const u of w.units.values()) {
        if (u.faction !== f) continue;
        if (behaves(u.kind, "harvester")) workers++;
        else if (isSuperKind(u.kind)) sup += UNITS[u.kind].cost * (u.hp / UNITS[u.kind].hp);
        else army += UNITS[u.kind].cost * (u.hp / UNITS[u.kind].hp);
      }
      let base = 0;
      for (const b of w.buildings.values()) if (b.faction === f) base += BUILDINGS[b.kind].cost * Math.min(1, b.hp / buildingMaxHp(w, b));
      log.army[f].push(Math.round(army));
      log.supers[f].push(Math.round(sup));
      log.workers[f].push(workers);
      log.base[f].push(Math.round(base));
      log.harvest[f].push(Math.round(w.factions[f].stats.scrapHarvested));
      log.bank[f].push(Math.round(w.factions[f].scrap));
    }
  };
  return {
    log,
    tick() {
      const t = w.tick / TICK_RATE;
      for (const ev of w.fx as FxEvent[]) {
        if (ev.type === "built") {
          const u = w.units.get(ev.id);
          if (u) {
            const k = tally(u.faction, u.kind);
            k.built++;
            k.spent += UNITS[u.kind].cost;
            if (isSuperKind(u.kind)) {
              log.superCount[u.faction]++;
              log.superAt[u.faction] ??= t;
            }
          }
          const b = w.buildings.get(ev.id);
          if (b && PRODUCERS.includes(b.kind)) {
            log.firstBuilt[b.faction][b.kind] ??= t;
            if (b.kind === "gantry") log.gantryAt[b.faction] ??= t;
          }
        } else if (ev.type === "death") {
          if (ev.unitKind) tally(ev.faction, ev.unitKind).lost++;
          const killer = (ev as { killerId?: number | null }).killerId;
          const kk = (ev as { killerKind?: UnitKind | null }).killerKind;
          if (killer != null && kk) {
            const kf: Faction = ev.faction === "blue" ? "red" : "blue";
            const tl = tally(kf, kk);
            if (ev.unitKind) tl.killedUnits += UNITS[ev.unitKind].cost;
            else tl.killedBuildings += BUILDINGS[ev.buildingKind!].cost;
          }
        }
      }
      if (w.tick % TICK_RATE === 0) {
        for (const b of w.buildings.values()) if (b.unpowered) log.darkSecs[b.faction]++;
        for (const u of w.units.values()) {
          const o = u.order;
          if (o.type !== "harvest" || o.phase !== "harvesting") continue;
          dig[u.faction]![w.terrain[tileIndex(w, o.fieldX, o.fieldY)] === Terrain.Crystal ? 1 : 0]++;
        }
      }
      if (w.tick % (60 * TICK_RATE) === 0) minute();
    },
    finish() {
      for (const f of SIDES) log.radiumShare[f] = dig[f][0] + dig[f][1] ? dig[f][1] / (dig[f][0] + dig[f][1]) : 0;
    }
  };
}
