// Headless balance harness.
//   npx vite-node tools/balance.ts duels          cost-equal unit duel matrix
//   npx vite-node tools/balance.ts matches [map] [--classic] [--no-objectives]
//                                                 AI-vs-AI round robin (every map, or one), each AI
//                                                 taking its personality's opener, with Uplinks and
//                                                 supply drops (--classic: neither; --no-objectives)
//   npx vite-node tools/balance.ts passive        each strategy vs a passive foe
//   npx vite-node tools/balance.ts goliath [--menders N]
//                                                 a Goliath (plus N Menders) vs cost-equal groups
//                                                 of each unit, from both sides of the field
// `matches` also reports the Goliath numbers GOLIATH.md asks for (when the first one
// appears, what each earns and kills before it dies, outposts, lifts, how long a side
// lasts after its HQ falls); --no-goliath bans it for an A/B run.
//   npx vite-node tools/balance.ts duels --nations [--trench] [--tsf]
//                                                 République (rows) × Empire (columns) at equal cost,
//                                                 under the nations' rules (--trench: the Empire's
//                                                 squads hold dug in; --tsf: a Tour TSF behind the
//                                                 République), with each unit's mean
//   npx vite-node tools/balance.ts goliath --vs zenith [--menders N]
//                                                 Gargantua (+N Ateliers) vs Zénith (+N Pasteurs), and
//                                                 each super-unit vs cost-equal groups of the other nation
//   npx vite-node tools/balance.ts siege          each nation's siege groups vs the other's defences
//                                                 (Emp: 3 Hotchkiss + Batterie de 47; Rép: 2 Bobines +
//                                                 Ruggieri + Tour TSF), time to raze and value lost
// Any mode takes --tune '{"UNITS.trooper.hp":200}' to override exported balance numbers
// (and AI personalities: "STRATEGIES.rush.assaultValue"; the Goliath: "GOLIATH.costStep")
// for an A/B run.
import { NATION_AI, NATION_STRATEGIES, STRATEGIES, createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { CONDOR_AI } from "../src/sim/ai/condor";
import { OBJECTIVE_AI } from "../src/sim/ai/objectives";
import { GOLIATH_AI } from "../src/sim/ai/goliath";
import { MENDER_AI } from "../src/sim/ai/menders";
import * as balance from "../src/sim/balance";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { MAPS, createMapWorld, mapById } from "../src/sim/maps";
import { pickAiOpener } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import { rulesOf } from "../src/sim/rules";
import type { Faction, UnitKind, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";
import { DEFAULT_RULES } from "../src/sim/rules";
import { buildingMaxHp } from "../src/sim/nations";
import { spawnSuper } from "../src/sim/goliath";
import type { BuildingKind, Nation } from "../src/sim/types";

const COMBAT: UnitKind[] = [
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "trooper", "rocket-squad", "sniper"
];
const BUDGET = 1800;

/** Army A (blue) vs army B (red), equal scrap, attack-moving into each other. */
function duel(a: UnitKind, b: UnitKind, seed: number): number {
  const w = createWorld(40, 40);
  const spawnArmy = (kind: UnitKind, faction: "blue" | "red", x: number) => {
    const n = Math.max(1, Math.round(BUDGET / UNITS[kind].cost));
    const ids: number[] = [];
    for (let i = 0; i < n; i++)
      ids.push(spawnUnit(w, kind, faction, x + (i % 3) * 0.8 + seed * 0.01, 16 + Math.floor(i / 3) * 0.8).id);
    return ids;
  };
  const A = spawnArmy(a, "blue", 8);
  const B = spawnArmy(b, "red", 30);
  step(w, [
    { type: "attackMove", faction: "blue", unitIds: A, x: 32, y: 17 },
    { type: "attackMove", faction: "red", unitIds: B, x: 8, y: 17 }
  ]);
  for (let t = 0; t < 120 * TICK_RATE; t++) {
    step(w, []);
    const blue = [...w.units.values()].some((u) => u.faction === "blue");
    const red = [...w.units.values()].some((u) => u.faction === "red");
    if (!blue || !red) break;
    // units that can't hit anything on the other side just idle: stop early
    if (t % 50 === 0 && t > 300 && w.fx.every((f) => f.type !== "shot")) break;
  }
  const left = (f: "blue" | "red") =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  // +1 = A wiped B with nothing lost; -1 = the reverse
  return (left("blue") - left("red")) / BUDGET;
}

function duels(): void {
  const pad = (s: string, n = 8) => s.slice(0, n).padStart(n);
  console.log(`cost-equal duels (${BUDGET} scrap each): row army vs column army, + = row wins`);
  console.log(pad("") + COMBAT.map((k) => pad(k)).join(""));
  for (const a of COMBAT) {
    let row = pad(a);
    for (const b of COMBAT) row += pad(a === b ? "-" : ((duel(a, b, 0) - duel(b, a, 0)) / 2).toFixed(2));
    console.log(row);
  }
}

/**
 * One Goliath (and `menders` Menders behind it) against a cost-equal group of
 * `kind`, attack-moving into each other. The Goliath's side is blue, or red
 * when `flip` (so neither side's spawn order decides it). Returns +1 when the
 * Goliath's side wiped the other with nothing lost, −1 the reverse.
 */
function goliathDuel(kind: UnitKind, menders: number, flip: boolean): { score: number; secs: number; lost: string } {
  const w = createWorld(40, 40);
  const budget = UNITS.goliath.cost + menders * UNITS.mender.cost;
  const gSide: Faction = flip ? "red" : "blue";
  const kSide: Faction = flip ? "blue" : "red";
  const gx = flip ? 30 : 8;
  const kx = flip ? 8 : 30;
  const g = spawnUnit(w, "goliath", gSide, gx, 17);
  const gIds = [g.id];
  for (let i = 0; i < menders; i++) gIds.push(spawnUnit(w, "mender", gSide, gx + (flip ? 1.5 : -1.5), 15.5 + i).id);
  const n = Math.max(1, Math.round(budget / UNITS[kind].cost));
  const kIds: number[] = [];
  for (let i = 0; i < n; i++) kIds.push(spawnUnit(w, kind, kSide, kx + (i % 3) * 0.8, 14 + Math.floor(i / 3) * 0.8).id);
  step(w, [
    { type: "attackMove", faction: gSide, unitIds: gIds, x: kx, y: 17 },
    { type: "attackMove", faction: kSide, unitIds: kIds, x: gx, y: 17 }
  ]);
  const lost: string[] = [];
  let t = 0;
  for (; t < 180 * TICK_RATE; t++) {
    step(w, []);
    for (const e of w.fx) if (e.type === "goliathWeapon" && e.state === "offline") lost.push(e.weapon);
    const alive = (f: Faction) => [...w.units.values()].some((u) => u.faction === f);
    if (!alive("blue") || !alive("red")) break;
    if (t % 50 === 0 && t > 300 && w.fx.every((f) => f.type !== "shot")) break;
  }
  const left = (f: Faction) =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  return { score: (left(gSide) - left(kSide)) / budget, secs: t / TICK_RATE, lost: lost.map((k) => k[0]).join("") || "-" };
}

function goliathDuels(): void {
  const at = process.argv.indexOf("--menders");
  const menders = at >= 0 ? Number(process.argv[at + 1]) : 0;
  const budget = UNITS.goliath.cost + menders * UNITS.mender.cost;
  console.log(`a Goliath${menders ? ` + ${menders} Mender${menders > 1 ? "s" : ""}` : ""} vs ${budget} scrap of each unit (+ = Goliath wins; weapons lost: m/l/c)`);
  for (const k of COMBAT) {
    const a = goliathDuel(k, menders, false);
    const b = goliathDuel(k, menders, true);
    const score = (a.score + b.score) / 2;
    console.log(
      `  ${k.padEnd(13)} ${score >= 0 ? "+" : ""}${score.toFixed(2)}   ${((a.secs + b.secs) / 2).toFixed(0).padStart(3)} s   lost ${a.lost}/${b.lost}`
    );
  }
}

const classic = process.argv.includes("--classic");
const noGoliath = process.argv.includes("--no-goliath");

/** What one match did with Goliaths (GOLIATH.md "What to measure"). */
interface GoliathLog {
  /** Match seconds of each side's first rollout (null: none). */
  first: Record<Faction, number | null>;
  rollouts: number;
  gantries: number;
  /** Per dead Goliath: seconds alive, scrap of kills, scrap unloaded at it. */
  deaths: { life: number; killed: number; earned: number }[];
  /** Goliaths alive at the end, with the same tallies so far. */
  survivors: { life: number; killed: number; earned: number }[];
  outposts: number;
  /** Scrap unloaded at outpost buildings. */
  outpostScrap: number;
  lifts: number;
  anchors: number;
  /** Seconds the losing side played on after its HQ fell (null: the HQ fall decided it, or no winner). */
  afterHq: number | null;
}

/** Watch a match's events each tick and fill in a GoliathLog. */
function goliathWatch(): { log: GoliathLog; tick(w: World): void } {
  const log: GoliathLog = {
    first: { blue: null, red: null }, rollouts: 0, gantries: 0, deaths: [], survivors: [],
    outposts: 0, outpostScrap: 0, lifts: 0, anchors: 0, afterHq: null
  };
  const born = new Map<number, { t: number; killed: number; earned: number }>();
  const hqFell: Record<Faction, number | null> = { blue: null, red: null };
  return {
    log,
    tick(w: World) {
      const t = w.tick / TICK_RATE;
      for (const e of w.fx) {
        if (e.type === "goliathRollout") {
          log.rollouts++;
          if (log.first[e.faction] === null) log.first[e.faction] = t;
          born.set(e.id, { t, killed: 0, earned: 0 });
        } else if (e.type === "built") {
          const b = w.buildings.get(e.id);
          if (b?.kind === "gantry") log.gantries++;
          if (b?.outpost) log.outposts++;
        } else if (e.type === "goliathLift" && e.state === "hooked") log.lifts++;
        else if (e.type === "goliathMode" && e.mode === "anchored") log.anchors++;
        else if (e.type === "deposit") {
          for (const u of w.units.values())
            if (u.goliath && Math.abs(u.x - e.x) < 1e-6 && Math.abs(u.y - e.y) < 1e-6) {
              const r = born.get(u.id);
              if (r) r.earned += e.amount;
            }
          for (const b of w.buildings.values())
            if (b.outpost && Math.abs(b.tx + 1 - e.x) < 1e-6 && Math.abs(b.ty + 1 - e.y) < 1e-6) log.outpostScrap += e.amount;
        } else if (e.type === "death" && e.unitKind === "goliath") {
          const r = born.get(e.id);
          if (r) log.deaths.push({ life: t - r.t, killed: r.killed, earned: r.earned });
          born.delete(e.id);
        } else if (e.type === "death" && e.buildingKind === "hq") hqFell[e.faction] = t;
      }
      if (w.tick % TICK_RATE === 0)
        for (const u of w.units.values()) {
          const r = u.goliath ? born.get(u.id) : undefined;
          if (r) r.killed = u.xp;
        }
      if (w.winner) {
        const loser: Faction = w.winner === "blue" ? "red" : "blue";
        const fell = hqFell[loser];
        if (fell !== null && t - fell > 0.5) log.afterHq = t - fell;
        for (const [, r] of born) log.survivors.push({ life: t - r.t, killed: r.killed, earned: r.earned });
        born.clear();
      }
    }
  };
}
const objectives = !classic && !process.argv.includes("--no-objectives");

function match(map: string, blue: StrategyName, red: StrategyName, maxMin = 25): { winner: string; min: number; w: World; g: GoliathLog } {
  const seed = mapById(map).seed;
  const w = createMapWorld(
    map,
    classic
      ? {}
      : { objectives, openers: { blue: pickAiOpener(blue, seed, "blue"), red: pickAiOpener(red, seed, "red") } }
  );
  if (noGoliath) {
    const r = rulesOf(w);
    w.rules = { ...r, bannedUnits: [...r.bannedUnits, "goliath"], bannedBuildings: [...r.bannedBuildings, "gantry"] };
  }
  const sb = createAiState(blue, "normal", 1);
  const sr = createAiState(red, "normal", 2);
  const watch = goliathWatch();
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++) {
    step(w, [...tickAi(w, "blue", sb), ...tickAi(w, "red", sr)]);
    watch.tick(w);
  }
  if (!w.winner) for (const u of w.units.values()) if (u.goliath) watch.log.survivors.push({ life: 0, killed: u.xp, earned: 0 });
  return { winner: w.winner ?? "draw", min: w.tick / TICK_RATE / 60, w, g: watch.log };
}

/** Print what the Goliaths did over a set of matches. */
function goliathReport(logs: { map: string; g: GoliathLog; min: number }[]): void {
  const n = logs.length;
  const withG = logs.filter((l) => l.g.rollouts > 0);
  const firsts = logs.flatMap((l) => [l.g.first.blue, l.g.first.red].filter((x): x is number => x !== null)).sort((a, b) => a - b);
  const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : NaN);
  const mmss = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "-");
  console.log("\nGoliaths:");
  console.log(
    `  matches with one: ${withG.length}/${n}; Gantries ${logs.reduce((s, l) => s + l.g.gantries, 0)}, ` +
      `Goliaths ${logs.reduce((s, l) => s + l.g.rollouts, 0)}; first rollout median ${mmss(med(firsts))} (earliest ${mmss(firsts[0] ?? NaN)})`
  );
  const deaths = logs.flatMap((l) => l.g.deaths);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  if (deaths.length)
    console.log(
      `  ${deaths.length} died: lived ${mmss(avg(deaths.map((d) => d.life)))} on average, killed ${avg(deaths.map((d) => d.killed)).toFixed(0)} scrap ` +
        `and took in ${avg(deaths.map((d) => d.earned)).toFixed(0)} scrap of harvest first (list price ${UNITS.goliath.cost})`
    );
  const surv = logs.flatMap((l) => l.g.survivors);
  if (surv.length) console.log(`  ${surv.length} survived their match, having killed ${avg(surv.map((d) => d.killed)).toFixed(0)} scrap on average`);
  console.log(
    `  per match: ${(logs.reduce((s, l) => s + l.g.anchors, 0) / n).toFixed(1)} anchorings, ${(logs.reduce((s, l) => s + l.g.outposts, 0) / n).toFixed(1)} outposts ` +
      `(${(logs.reduce((s, l) => s + l.g.outpostScrap, 0) / n).toFixed(0)} scrap unloaded at them), ${(logs.reduce((s, l) => s + l.g.lifts, 0) / n).toFixed(1)} lifts`
  );
  const after = logs.map((l) => l.g.afterHq).filter((x): x is number => x !== null);
  console.log(
    `  a beaten side outlived its HQ in ${after.length}/${n} matches` +
      (after.length ? ` (by ${mmss(avg(after))} on average, longest ${mmss(Math.max(...after))})` : "")
  );
  const maps = [...new Set(logs.map((l) => l.map))];
  for (const m of maps) {
    const ls = logs.filter((l) => l.map === m);
    console.log(`  ${m.padEnd(16)} ${ls.filter((l) => l.g.rollouts > 0).length}/${ls.length} with a Goliath, mean ${(ls.reduce((s, l) => s + l.min, 0) / ls.length).toFixed(1)} min`);
  }
}

function matches(): void {
  const names = Object.keys(STRATEGIES) as StrategyName[];
  const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const games: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const built: Record<string, number> = {};
  let draws = 0;
  let totalMin = 0;
  let n = 0;
  let salvaged = 0;
  let harvested = 0;
  const calls: Record<string, number> = {};
  let uplinkScrap = 0;
  let crateScrap = 0;
  let captures = 0;
  let crates = 0;
  const logs: { map: string; g: GoliathLog; min: number }[] = [];
  const only = process.argv.slice(3).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--tune");
  for (const map of MAPS.filter((m) => !only || m.id === only)) {
    for (let i = 0; i < names.length; i++)
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const { winner, min, w, g } = match(map.id, names[i]!, names[j]!);
        logs.push({ map: map.id, g, min });
        n++;
        totalMin += min;
        games[names[i]!]!++;
        games[names[j]!]!++;
        if (winner === "blue") wins[names[i]!]!++;
        else if (winner === "red") wins[names[j]!]!++;
        else draws++;
        for (const f of ["blue", "red"] as const) {
          salvaged += w.factions[f].stats.scrapSalvaged;
          harvested += w.factions[f].stats.scrapHarvested;
          for (const [k, v] of Object.entries(w.powers.fired[f])) calls[k] = (calls[k] ?? 0) + v;
          const os = w.objectives.stats[f];
          uplinkScrap += os.uplinkScrap;
          crateScrap += os.crateScrap;
          captures += os.captures;
          crates += os.crates;
        }
        for (const u of w.units.values()) built[u.kind] = (built[u.kind] ?? 0) + 1;
        process.stdout.write(`${map.id} ${names[i]} vs ${names[j]}: ${winner} @ ${min.toFixed(1)}m\n`);
      }
  }
  console.log("\nwin rates:");
  for (const s of names) console.log(`  ${s.padEnd(10)} ${((100 * wins[s]!) / games[s]!).toFixed(0)}%`);
  console.log(`draws ${draws}/${n}, mean length ${(totalMin / n).toFixed(1)} min`);
  console.log(
    `salvage ${(salvaged / n).toFixed(0)} scrap per match (${((100 * salvaged) / Math.max(1, salvaged + harvested)).toFixed(1)}% of income)`
  );
  const totalCalls = Object.values(calls).reduce((a, b) => a + b, 0);
  console.log(
    `calldowns ${(totalCalls / n / 2).toFixed(1)} per AI per match (${Object.entries(calls)
      .map(([k, v]) => `${k} ${(v / n / 2).toFixed(1)}`)
      .join(", ")})`
  );
  if (objectives)
    console.log(
      `objectives per match: ${(captures / n).toFixed(1)} Uplink captures, ${(crates / n).toFixed(1)} crates claimed, ` +
        `${(uplinkScrap / n).toFixed(0)} Uplink + ${(crateScrap / n).toFixed(0)} crate scrap ` +
        `(${((100 * (uplinkScrap + crateScrap)) / Math.max(1, harvested + salvaged + uplinkScrap + crateScrap)).toFixed(1)}% of income)`
    );
  console.log("units alive at match end:", built);
  if (!noGoliath) goliathReport(logs);
}

function passive(): void {
  for (const map of MAPS)
    for (const s of Object.keys(STRATEGIES) as StrategyName[]) {
      const w = createMapWorld(map.id);
      const st = createAiState(s, "normal", 3);
      for (let i = 0; i < 20 * 60 * TICK_RATE && !w.winner; i++) step(w, tickAi(w, "red", st));
      console.log(`${map.id.padEnd(16)} ${s.padEnd(10)} ${w.winner ?? "none"} @ ${(w.tick / 600).toFixed(1)}m`);
    }
}

function applyTune(json: string | undefined): void {
  if (!json) return;
  const roots: Record<string, unknown> = { ...balance, STRATEGIES, NATION_STRATEGIES, NATION_AI, OBJECTIVE_AI, CONDOR_AI, GOLIATH_AI, MENDER_AI };
  for (const [path, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parts = path.split(".");
    let o = roots as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
    const last = parts[parts.length - 1]!;
    if (!o || !(last in o)) throw new Error(`no such tunable: ${path}`);
    o[last] = v;
  }
}
// ------------------------------------------------------------- nations ---

const REP_COMBAT: UnitKind[] = ["jamais-contente", "de-dion", "branly", "lancer", "wasp", "raptor", "hornet", "trooper", "sapeurs", "sniper"];
const EMP_COMBAT: UnitKind[] = ["stinger", "flak-crawler", "mortar", "mortier-280", "mastodon", "gyroptere", "epervier", "vulcain", "fusiliers", "rocket-squad", "carabiniers"];

/** A bare field under the nations' rules (blue and red's nations given). */
function nationsField(blue: Nation, red: Nation, size = 40): World {
  const w = createWorld(size, size);
  w.rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], startUnits: [], mutators: [], nations: { blue, red } };
  return w;
}

/**
 * `a` (nation na) vs `b` (nation nb), equal scrap, a on blue. `trench`: nb's
 * (the Empire's) squads hold their ground, dug in, instead of advancing;
 * `tsf`: a Tour TSF stands behind the République's army.
 */
function nationDuel(a: UnitKind, na: Nation, b: UnitKind, nb: Nation, opts: { trench: boolean; tsf: boolean }): number {
  const w = nationsField(na, nb);
  const army = (kind: UnitKind, f: Faction, x: number) => {
    const n = Math.max(1, Math.round(BUDGET / UNITS[kind].cost));
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(spawnUnit(w, kind, f, x + (i % 3) * 0.8, 16 + Math.floor(i / 3) * 0.8).id);
    return ids;
  };
  const A = army(a, "blue", 8);
  const B = army(b, "red", 30);
  for (const [f, n, x] of [["blue", na, 4], ["red", nb, 35]] as const)
    if (opts.tsf && n === "republique") spawnBuilding(w, "radar", f, x, 15);
  const holdB = opts.trench && nb === "empire" && !!UNITS[b].squad;
  const holdA = opts.trench && na === "empire" && !!UNITS[a].squad;
  if (holdA) for (const id of A) w.units.get(id)!.entrenched = true;
  if (holdB) for (const id of B) w.units.get(id)!.entrenched = true;
  step(w, [
    ...(holdA ? [] : [{ type: "attackMove" as const, faction: "blue" as const, unitIds: A, x: 32, y: 17 }]),
    ...(holdB ? [] : [{ type: "attackMove" as const, faction: "red" as const, unitIds: B, x: 8, y: 17 }])
  ]);
  let quiet = 0;
  for (let t = 0; t < 150 * TICK_RATE; t++) {
    step(w, []);
    const blue = [...w.units.values()].some((u) => u.faction === "blue");
    const red = [...w.units.values()].some((u) => u.faction === "red");
    if (!blue || !red) break;
    quiet = w.fx.some((f) => f.type === "shot") ? 0 : quiet + 1;
    if (t > 300 && quiet > 150) break; // nobody can hit anybody (or the holders' foes stay out of reach)
  }
  const left = (f: Faction) =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  return (left("blue") - left("red")) / BUDGET;
}

/** The République × Empire matrix (+ = the République's unit wins), and each unit's mean over the other roster. */
function nationDuels(): void {
  const opts = { trench: process.argv.includes("--trench"), tsf: process.argv.includes("--tsf") };
  const pad = (s: string, n = 8) => s.slice(0, n).padStart(n);
  const cell = new Map<string, number>();
  for (const a of REP_COMBAT)
    for (const b of EMP_COMBAT)
      cell.set(`${a}|${b}`, (nationDuel(a, "republique", b, "empire", opts) - nationDuel(b, "empire", a, "republique", opts)) / 2);
  console.log(`République (rows) vs Empire (columns), ${BUDGET} scrap each, + = row wins${opts.trench ? "; Empire squads dug in" : ""}${opts.tsf ? "; Tour TSF behind the République" : ""}`);
  console.log(pad("", 10) + EMP_COMBAT.map((k) => pad(k)).join("") + pad("mean"));
  const meanOf = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
  for (const a of REP_COMBAT) {
    const row = EMP_COMBAT.map((b) => cell.get(`${a}|${b}`)!);
    console.log(pad(a, 10) + row.map((v) => pad(v.toFixed(2))).join("") + pad(meanOf(row).toFixed(2)));
  }
  console.log(pad("mean", 10) + EMP_COMBAT.map((b) => pad((-meanOf(REP_COMBAT.map((a) => cell.get(`${a}|${b}`)!))).toFixed(2))).join("") + "   (column: + = the Empire's unit wins)");
  console.log(`roster mean: République ${meanOf([...cell.values()]).toFixed(3)}`);
}

/** One super-unit (+ `healers`) against another army of `kind` × n, or super vs super. */
function superDuel(sup: UnitKind, sn: Nation, healers: number, foe: UnitKind, fn: Nation, foeHealers: number, flip: boolean): { score: number; secs: number } {
  const w = nationsField(flip ? fn : sn, flip ? sn : fn);
  const sSide: Faction = flip ? "red" : "blue";
  const fSide: Faction = flip ? "blue" : "red";
  const sx = flip ? 30 : 8;
  const fx = flip ? 8 : 30;
  const healer = (n: Nation): UnitKind => (n === "republique" ? "mender" : "atelier");
  const budget = UNITS[sup].cost + healers * UNITS[healer(sn)].cost;
  const sIds = [spawnSuper(w, sup, sSide, sx, 17).id];
  for (let i = 0; i < healers; i++) sIds.push(spawnUnit(w, healer(sn), sSide, sx + (flip ? 1.5 : -1.5), 15.5 + i).id);
  const fIds: number[] = [];
  if (foe === "goliath" || foe === "zenith") {
    fIds.push(spawnSuper(w, foe, fSide, fx, 17).id);
    for (let i = 0; i < foeHealers; i++) fIds.push(spawnUnit(w, healer(fn), fSide, fx + (flip ? -1.5 : 1.5), 15.5 + i).id);
  } else {
    const n = Math.max(1, Math.round(budget / UNITS[foe].cost));
    for (let i = 0; i < n; i++) fIds.push(spawnUnit(w, foe, fSide, fx + (i % 3) * 0.8, 14 + Math.floor(i / 3) * 0.8).id);
  }
  const foeBudget = foe === "goliath" || foe === "zenith" ? UNITS[foe].cost + foeHealers * UNITS[healer(fn)].cost : budget;
  step(w, [
    { type: "attackMove", faction: sSide, unitIds: sIds, x: fx, y: 17 },
    { type: "attackMove", faction: fSide, unitIds: fIds, x: sx, y: 17 }
  ]);
  let t = 0;
  let quiet = 0;
  for (; t < 240 * TICK_RATE; t++) {
    step(w, []);
    const alive = (f: Faction) => [...w.units.values()].some((u) => u.faction === f && !(UNITS[u.kind].dps === 0 && UNITS[u.kind].heal));
    if (!alive("blue") || !alive("red")) break;
    quiet = w.fx.some((f) => f.type === "shot" || f.type === "goliathWeapon") ? 0 : quiet + 1;
    if (t > 300 && quiet > 150) break;
  }
  const left = (f: Faction) =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  return { score: left(sSide) / budget - left(fSide) / foeBudget, secs: t / TICK_RATE };
}

function superDuels(): void {
  const at = process.argv.indexOf("--menders");
  const n = at >= 0 ? Number(process.argv[at + 1]) : 0;
  const both = (a: UnitKind, an: Nation, ah: number, b: UnitKind, bn: Nation, bh: number) => {
    const x = superDuel(a, an, ah, b, bn, bh, false);
    const y = superDuel(a, an, ah, b, bn, bh, true);
    return { score: (x.score + y.score) / 2, secs: (x.secs + y.secs) / 2 };
  };
  const fmt = (r: { score: number; secs: number }) => `${r.score >= 0 ? "+" : ""}${r.score.toFixed(2)}  ${r.secs.toFixed(0).padStart(4)} s`;
  console.log(`Zénith${n ? ` + ${n} Pasteurs` : ""} vs Gargantua${n ? ` + ${n} Ateliers` : ""} (+ = Zénith): ${fmt(both("zenith", "republique", n, "goliath", "empire", n))}`);
  console.log(`
Zénith${n ? ` + ${n} Pasteurs` : ""} vs cost-equal Empire groups (+ = Zénith wins)`);
  for (const k of EMP_COMBAT) console.log(`  ${k.padEnd(13)} ${fmt(both("zenith", "republique", n, k, "empire", 0))}`);
  console.log(`
Gargantua${n ? ` + ${n} Ateliers` : ""} vs cost-equal République groups (+ = Gargantua wins)`);
  for (const k of REP_COMBAT) console.log(`  ${k.padEnd(13)} ${fmt(both("goliath", "empire", n, k, "republique", 0))}`);
}

/** Each nation's defences (§1.8: 3 Hotchkiss + 1 AA, or 2 Bobines + 1 Ruggieri) with what feeds them. */
const DEFENCES: Record<Nation, BuildingKind[]> = {
  empire: ["turret", "turret", "turret", "flak-battery"],
  republique: ["arsonval", "arsonval", "sam-site", "radar"]
};
const SIEGE_GROUPS: Record<Nation, UnitKind[]> = {
  republique: ["branly", "hornet", "lancer", "jamais-contente", "wasp", "sapeurs"],
  empire: ["mortier-280", "mortar", "vulcain", "mastodon", "gyroptere", "rocket-squad"]
};

/** `kind` × (the defences' cost) attacks `def`'s defences: seconds to raze them all, share of the attackers' value lost. */
function siegeRun(kind: UnitKind, att: Nation, def: Nation): { razed: boolean; secs: number; lost: number; left: number } {
  const w = nationsField(att, def, 44);
  const blds = DEFENCES[def];
  // front to back: the guns, the anti-air, then the République's Tour TSF behind them
  const spots: [number, number][] = [[29, 15], [29, 19], [27, 17], [32, 17]];
  let cost = 0;
  const ids: number[] = [];
  blds.forEach((k, i) => {
    const [x, y] = spots[i]!;
    const b = spawnBuilding(w, k, "red", x, y);
    b.hp = buildingMaxHp(w, b);
    cost += BUILDINGS[k].cost;
    ids.push(b.id);
  });
  const n = Math.max(1, Math.round(cost / UNITS[kind].cost));
  const army: number[] = [];
  for (let i = 0; i < n; i++) army.push(spawnUnit(w, kind, "blue", 6 + (i % 3) * 0.8, 15 + Math.floor(i / 3) * 0.8).id);
  const spent = n * UNITS[kind].cost;
  const cmds: Parameters<typeof step>[1] = [{ type: "attackMove", faction: "blue", unitIds: army, x: 31, y: 17 }];
  // a blind gun gets a spotter, out of the defences' reach
  if ((UNITS[kind].range ?? 0) > UNITS[kind].sight) {
    const sp = spawnUnit(w, att === "empire" ? "estafette" : "scout", "blue", 6, 20);
    cmds.push({ type: "move", faction: "blue", unitIds: [sp.id], x: 22, y: 21 });
  }
  step(w, cmds);
  let t = 0;
  let quiet = 0;
  for (; t < 300 * TICK_RATE; t++) {
    step(w, []);
    if (!ids.some((id) => w.buildings.has(id))) break;
    if (!army.some((id) => w.units.has(id))) break;
    quiet = w.fx.some((f) => f.type === "shot") ? 0 : quiet + 1;
    if (t > 300 && quiet > 300) break;
    // stragglers that lost the target: send them again
    if (t % 50 === 0) {
      const idle = army.filter((id) => w.units.get(id)?.order.type === "idle");
      const tgt = ids.find((id) => w.buildings.has(id));
      if (idle.length && tgt !== undefined) step(w, [{ type: "attack", faction: "blue", unitIds: idle, targetId: tgt }]);
    }
  }
  const left = army.reduce((s, id) => {
    const u = w.units.get(id);
    return s + (u ? (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost : 0);
  }, 0);
  const razed = !ids.some((id) => w.buildings.has(id));
  return { razed, secs: t / TICK_RATE, lost: 1 - left / spent, left: ids.filter((id) => w.buildings.has(id)).length };
}

function siege(): void {
  for (const [att, def] of [["republique", "empire"], ["empire", "republique"]] as [Nation, Nation][]) {
    const cost = DEFENCES[def].reduce((s, k) => s + BUILDINGS[k].cost, 0);
    console.log(`
${att} groups vs ${def} defences (${DEFENCES[def].join(", ")}; ${cost} scrap list)`);
    for (const k of SIEGE_GROUPS[att]) {
      const r = siegeRun(k, att, def);
      console.log(`  ${k.padEnd(13)} ${r.razed ? `razed in ${r.secs.toFixed(0)} s` : `${r.left} left after ${r.secs.toFixed(0)} s`}, lost ${Math.round(100 * r.lost)}% of its value`);
    }
  }
}

const tuneAt = process.argv.indexOf("--tune");
applyTune(tuneAt >= 0 ? process.argv[tuneAt + 1] : undefined);

const mode = process.argv[2] ?? "duels";
if (mode === "duels") (process.argv.includes("--nations") ? nationDuels : duels)();
else if (mode === "siege") siege();
else if (mode === "goliath" && process.argv.includes("--vs")) superDuels();
else if (mode === "matches") matches();
else if (mode === "passive") passive();
else if (mode === "goliath") goliathDuels();
