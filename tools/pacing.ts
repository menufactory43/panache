// Pacing & snowball panel: the AI-vs-AI measurements behind DESIGN.md's
// "Balance & pacing" table.
//   npx vite-node tools/pacing.ts run <out.jsonl> [--seeds N] [--shard i/n] [--maps a,b] [--tune JSON]
//   npx vite-node tools/pacing.ts summary <a.jsonl> [b.jsonl ...]
// `run` plays every ordered pair of distinct personalities on every map
// (Normal vs Normal, each AI on its personality's opener, Uplinks and
// supply drops on, 25-minute cap) `--seeds` times with different match
// seeds, one JSON line per match (see pacing-match.ts). Shard it across
// processes (`--shard 0/4` … `3/4`) and feed all the files to `summary`.
// `--tune '{"POWERS.passive":0.05,"STRATEGIES.rush.assaultValue":1200}'`
// overrides exported balance numbers (and AI personalities, and the Condor drop plan:
// "CONDOR_AI.maxBuilt":0, the island airlift: "AIRLIFT.edge":1.5, and a map's own numbers:
// "MAP.archipelago.hqTrickle":4, "MAP.archipelago.uplinks.0.income":6) for an A/B run.
// `--mirror` plays each personality against itself instead (the side-fairness
// check: red's share of decided games and of harvest at 4:00, by map).
// `--with rush` keeps only the pairings that include that personality (a quick
// look at one; its pairings keep the seeds they have in the full panel).
// `--difficulty easy|hard` plays both AIs at that difficulty (default Normal).
// Every line records the match's wall-clock cost (perf: ms per sim-minute,
// worst tick), and `summary` breaks each map out on its own: length and
// draws, win rates, value built by group (infantry / Condor / air /
// vehicles), Condor drops by destination, island Uplink captures, retakes and
// crewed time, deaths near Uplinks, and the cost.
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import * as balance from "../src/sim/balance";
import { NATION_AI, NATION_POOLS, NATION_STRATEGIES, STRATEGIES, type PersonalityName, type StrategyName } from "../src/sim/ai/commander";
import { CONDOR_AI } from "../src/sim/ai/condor";
import { OBJECTIVE_AI } from "../src/sim/ai/objectives";
import { GOLIATH_AI } from "../src/sim/ai/goliath";
import { MENDER_AI } from "../src/sim/ai/menders";
import { AIRLIFT } from "../src/sim/ai/airlift";
import { MAPS } from "../src/sim/maps";
import type { Faction, Nation, UnitKind } from "../src/sim/types";
import { playMatch, type KindTally, type Match, type UnitGroup } from "./pacing-match";
import type { Difficulty } from "../src/sim/ai/commander";

const SIDES: Faction[] = ["blue", "red"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function applyTune(json: string | undefined): void {
  if (!json) return;
  const roots: Record<string, unknown> = { ...balance, STRATEGIES, NATION_STRATEGIES, NATION_AI, OBJECTIVE_AI, CONDOR_AI, GOLIATH_AI, MENDER_AI, AIRLIFT, MAP: Object.fromEntries(MAPS.map((m) => [m.id, m])) };
  for (const [path, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parts = path.split(".");
    let o = roots as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
    const last = parts[parts.length - 1]!;
    if (!o || !(last in o)) throw new Error(`no such tunable: ${path}`);
    o[last] = v;
  }
}

/** `--jobs N`: run the panel as N shard processes at once (default: one per core), then join their files. */
async function runJobs(out: string, jobs: number): Promise<void> {
  const rest = process.argv.slice(4).filter((a, i, all) => a !== "--jobs" && all[i - 1] !== "--jobs");
  const parts = Array.from({ length: jobs }, (_, i) => `${out}.part${i}`);
  const t0 = Date.now();
  await Promise.all(
    parts.map(
      (part, i) =>
        new Promise<void>((ok, fail) => {
          const c = spawn(process.execPath, [new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url).pathname, "tools/pacing.ts", "run", part, ...rest, "--shard", `${i}/${jobs}`], { stdio: ["ignore", "ignore", "inherit"] });
          c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`shard ${i} exited ${code}`))));
        })
    )
  );
  writeFileSync(out, parts.map((p) => readFileSync(p, "utf8")).join(""));
  for (const p of parts) unlinkSync(p);
  console.error(`${readFileSync(out, "utf8").split("\n").filter(Boolean).length} matches in ${((Date.now() - t0) / 1000).toFixed(0)} s on ${jobs} processes`);
}

const NATION_ALIAS: Record<string, Nation> = { rep: "republique", republique: "republique", emp: "empire", empire: "empire" };

/**
 * A nations panel (§1.8): `--nations rep-emp` plays every République personality
 * of the pool against every Empire one, the République on each side in turn, on
 * every map, `--seeds` times; `rep-rep` / `emp-emp` play the mirrors (every
 * ordered pair of the nation's pool, the same personality included).
 * `--pairs balanced/balanced,volta/siege` keeps only those pairings (first the
 * blue nation's personality in a mirror, the République's otherwise).
 */
function runNations(out: string, spec: string): void {
  const [a, b] = spec.split("-").map((x) => NATION_ALIAS[x]) as [Nation, Nation];
  if (!a || !b) throw new Error(`--nations rep-emp | rep-rep | emp-emp (not ${spec})`);
  const seeds = Number(arg("--seeds") ?? 1);
  const [shard, shards] = (arg("--shard") ?? "0/1").split("/").map(Number) as [number, number];
  const maps = arg("--maps")?.split(",") ?? MAPS.map((x) => x.id);
  const difficulty = (arg("--difficulty") ?? "normal") as Difficulty;
  const cap = Number(arg("--cap") ?? 25);
  const pairs = arg("--pairs")?.split(",").map((p) => p.split("/") as [PersonalityName, PersonalityName]);
  const poolA = NATION_POOLS[a][difficulty];
  const poolB = NATION_POOLS[b][difficulty];
  const seats: Faction[] = a === b ? ["blue"] : ["blue", "red"];
  writeFileSync(out, "");
  let idx = 0;
  for (let s = 0; s < seeds; s++)
    for (const map of maps)
      for (const seatA of seats)
        for (const pa of poolA)
          for (const pb of poolB) {
            const job = idx++;
            if (pairs && !pairs.some(([x, y]) => x === pa && y === pb)) continue;
            if (job % shards !== shard) continue;
            const seatB: Faction = seatA === "blue" ? "red" : "blue";
            const nations = { [seatA]: a, [seatB]: b } as Record<Faction, Nation>;
            const pers = { [seatA]: pa, [seatB]: pb } as Record<Faction, PersonalityName>;
            const m = playMatch(map, pers.blue, pers.red, 9000 + job * 17 + s * 1013, 21 + job * 2 + s * 7919, {
              difficulty, timing: true, nations, capMin: cap,
              noOpeners: process.argv.includes("--no-openers") || process.argv.includes("--bare"),
              noObjectives: process.argv.includes("--no-objectives") || process.argv.includes("--bare")
            });
            appendFileSync(out, JSON.stringify(m) + "\n");
          }
}

async function run(): Promise<void> {
  const out = process.argv[3];
  if (!out) throw new Error("usage: pacing.ts run <out.jsonl> [--seeds N] [--shard i/n] [--maps a,b] [--tune JSON]");
  const jobs = arg("--jobs");
  if (jobs !== undefined && !arg("--shard")) return runJobs(out, Number(jobs) || cpus().length);
  applyTune(arg("--tune"));
  const nations = arg("--nations");
  if (nations) return runNations(out, nations);
  const seeds = Number(arg("--seeds") ?? 1);
  const [shard, shards] = (arg("--shard") ?? "0/1").split("/").map(Number) as [number, number];
  const maps = arg("--maps")?.split(",") ?? MAPS.map((x) => x.id);
  const names = Object.keys(STRATEGIES) as StrategyName[];
  const mirror = process.argv.includes("--mirror");
  const only = arg("--with");
  const difficulty = (arg("--difficulty") ?? "normal") as Difficulty;
  writeFileSync(out, "");
  let idx = 0;
  for (let s = 0; s < seeds; s++)
    for (const map of maps)
      for (const b of names)
        for (const r of names) {
          if ((b === r) !== mirror) continue;
          const job = idx++;
          if (only && b !== only && r !== only) continue;
          if (job % shards !== shard) continue;
          const m = playMatch(map, b, r, 7000 + job * 13 + s * 1000, 11 + job * 2, { difficulty, timing: true });
          appendFileSync(out, JSON.stringify(m) + "\n");
        }
}

function summary(): void {
  const d: Match[] = process.argv
    .slice(3)
    .flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Match));
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
  };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const mmss = (x: number) => (isNaN(x) ? "-" : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const dec = d.filter((x) => x.winner !== "draw");
  const len = dec.map((x) => x.min * 60);
  console.log(`matches ${d.length}, 25-minute draws ${d.length - dec.length} (${pct(d.length - dec.length, d.length)})`);
  console.log(`decided length: median ${mmss(q(len, 0.5))}, p10 ${mmss(q(len, 0.1))}, p90 ${mmss(q(len, 0.9))}, mean ${mmss(mean(len))}`);
  const fcd = d.map((x) => x.firstCombatDeath).filter((x): x is number => x !== null);
  console.log(`first combat-unit death: median ${mmss(q(fcd, 0.5))}`);
  const fights = dec.map((x) => x.fights.length);
  console.log(`big fights (>= 1000 destroyed) per decided match: median ${q(fights, 0.5)}, mean ${mean(fights).toFixed(1)}, >= 3 in ${pct(fights.filter((n) => n >= 3).length, fights.length)}`);
  console.log(
    "side ahead by > 200 value went on to win: " +
      [2, 3, 4, 5]
        .map((min) => {
          const led = dec.filter((x) => x.leadAt[min]);
          return `${min}:00 ${pct(led.filter((x) => x.leadAt[min] === x.winner).length, led.length)} (n=${led.length})`;
        })
        .join(", ")
  );
  console.log(
    `lead changes: median ${q(d.map((x) => x.leadChanges), 0.5)}, mean ${mean(d.map((x) => x.leadChanges)).toFixed(1)}; ` +
      `winner had been 800+ behind in ${pct(dec.filter((x) => x.wasBehind[x.winner as Faction]).length, dec.length)}`
  );
  const bins = new Array(10).fill(0);
  const cbins = new Array(10).fill(0);
  for (const x of d) x.bins.forEach((v, i) => (bins[i] += v)), x.combatBins.forEach((v, i) => (cbins[i] += v));
  const mid = (b: number[]) => pct(b.slice(3, 7).reduce((x, y) => x + y, 0), b.reduce((x, y) => x + y, 0));
  console.log(`unit deaths in the middle 40% of the HQ-HQ line: ${mid(bins)} (combat units ${mid(cbins)})`);
  const per = d.flatMap((x) => SIDES.map((s) => Object.values(x.calldowns[s]).reduce((a, b) => a + b, 0)));
  const kinds: Record<string, number> = {};
  for (const x of d) for (const s of SIDES) for (const [k, v] of Object.entries(x.calldowns[s])) kinds[k] = (kinds[k] ?? 0) + v;
  console.log(
    `calldowns per AI per match: median ${q(per, 0.5)}, mean ${mean(per).toFixed(1)}, 4-8 in ${pct(per.filter((n) => n >= 4 && n <= 8).length, per.length)} (` +
      Object.entries(kinds).map(([k, v]) => `${k} ${(v / per.length).toFixed(1)}`).join(", ") + ")"
  );
  const lost = d.map((x) => x.uplinkLost);
  console.log(
    `Uplinks: ${mean(d.map((x) => x.uplinkFlips)).toFixed(1)} flips per match, changed hands in ${pct(lost.filter((n) => n > 0).length, d.length)} of matches; ` +
      `supply crates claimed ${pct(d.reduce((a, x) => a + x.cratesClaimed, 0), d.reduce((a, x) => a + x.cratesLanded, 0))}`
  );
  const wins: Record<string, [number, number]> = {};
  for (const x of d)
    for (const s of SIDES) {
      const p = x[s];
      wins[p] ??= [0, 0];
      wins[p]![1]++;
      if (x.winner === s) wins[p]![0]++;
    }
  console.log("personality win rates: " + Object.entries(wins).map(([k, [w, n]]) => `${k} ${pct(w, n)}`).join(", "));
  // side fairness: blue and red play mirror-image starts, so both should be ~50%
  const maps = [...new Set(d.map((x) => x.map))];
  const side = (xs: Match[]) => {
    const dd = xs.filter((x) => x.winner !== "draw");
    const h = xs.filter((x) => x.harvest4);
    const hb = h.reduce((a, x) => a + x.harvest4.blue, 0);
    const hr = h.reduce((a, x) => a + x.harvest4.red, 0);
    return `${pct(dd.filter((x) => x.winner === "red").length, dd.length)} (n=${dd.length})` + (hb ? ` harvest@4:00 ${hr >= hb ? "+" : ""}${((100 * hr) / hb - 100).toFixed(1)}%` : "");
  };
  console.log("red's share of decided games: " + [...maps.map((m) => `${m} ${side(d.filter((x) => x.map === m))}`), `all ${side(d)}`].join(", "));
  for (const map of maps) perMap(d.filter((x) => x.map === map), map);
}

/** One map's own panel (the island map's measurements live here). */
function perMap(d: Match[], map: string): void {
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
  };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const mmss = (x: number) => (isNaN(x) ? "-" : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`);
  const dec = d.filter((x) => x.winner !== "draw");
  const len = dec.map((x) => x.min * 60);
  console.log(`\n== ${map}: ${d.length} matches, draws ${d.length - dec.length}; decided median ${mmss(q(len, 0.5))} (p10 ${mmss(q(len, 0.1))}, p90 ${mmss(q(len, 0.9))})`);
  const wins: Record<string, [number, number]> = {};
  for (const x of d)
    for (const s of SIDES) {
      wins[x[s]] ??= [0, 0];
      wins[x[s]]![1]++;
      if (x.winner === s) wins[x[s]]![0]++;
    }
  console.log("  win rates: " + Object.entries(wins).map(([k, [w, n]]) => `${k} ${pct(w, n)}`).join(", "));
  if (!d.every((x) => x.built)) return; // (lines from before these fields)
  const groups: UnitGroup[] = ["infantry", "condor", "air", "vehicles"];
  const share = (x: Match, s: Faction, gs: UnitGroup[]) => {
    const tot = groups.reduce((a, g) => a + x.built[s][g], 0);
    return tot ? gs.reduce((a, g) => a + x.built[s][g], 0) / tot : 0;
  };
  const per = (gs: UnitGroup[]) => d.flatMap((x) => SIDES.map((s) => share(x, s, gs)));
  console.log(
    "  value built (median per side): " +
      groups.map((g) => `${g} ${Math.round(100 * q(per([g]), 0.5))}%`).join(", ") +
      `; infantry+Condor ${Math.round(100 * q(per(["infantry", "condor"]), 0.5))}% (p10 ${Math.round(100 * q(per(["infantry", "condor"]), 0.1))}%), ` +
      `air p10 ${Math.round(100 * q(per(["air"]), 0.1))}%`
  );
  const un = d.reduce((a, x) => ({ relay: a.relay + x.unloads.relay, elsewhere: a.elsewhere + x.unloads.elsewhere, bailout: a.bailout + x.unloads.bailout }), { relay: 0, elsewhere: 0, bailout: 0 });
  console.log(`  Condor drops per match: ${(un.relay / d.length).toFixed(1)} squads onto an Uplink, ${(un.elsewhere / d.length).toFixed(1)} elsewhere, ${(un.bailout / d.length).toFixed(1)} bailed out; Condors lost ${mean(d.map((x) => x.condorsLost.blue + x.condorsLost.red)).toFixed(1)}`);
  const islands = d.some((x) => x.islandCaptures.blue + x.islandCaptures.red > 0);
  if (islands) {
    const first = d.flatMap((x) => SIDES.map((s) => x.firstIsland[s] ?? Infinity));
    const both2 = d.filter((x) => SIDES.every((s) => (x.firstIsland[s] ?? Infinity) <= 120)).length;
    const caps = d.map((x) => x.islandCaptures.blue + x.islandCaptures.red);
    const retakes = d.map((x) => x.islandRetakes.blue + x.islandRetakes.red);
    console.log(
      `  island Uplinks: first capture median ${mmss(q(first, 0.5))}, both sides by 2:00 in ${pct(both2, d.length)}; ` +
        `captures per match ${mean(caps).toFixed(1)} (retakes ${mean(retakes).toFixed(1)}, ${pct(retakes.filter((n) => n >= 2).length, d.length)} with 2+); flips ${mean(d.map((x) => x.uplinkFlips)).toFixed(1)}`
    );
    const crewWin = dec.map((x) => x.crewedSecs[x.winner as Faction] / Math.max(1, x.crewedSecs.blue + x.crewedSecs.red));
    const crewMin = d.map((x) => (x.crewedSecs.blue + x.crewedSecs.red) / 60 / Math.max(1e-9, x.min));
    console.log(`  island Uplinks crewed at a time, on average: ${mean(crewMin).toFixed(1)}; the winner's share of crewed relay-time: median ${pct(q(crewWin, 0.5), 1)}`);
  }
  const near = d.reduce((a, x) => a + x.relayDeaths, 0);
  const all = d.reduce((a, x) => a + x.unitDeaths, 0);
  console.log(`  unit deaths within 8 tiles of an Uplink: ${pct(near, all)}`);
  const perf = d.filter((x) => x.perf).map((x) => x.perf!);
  if (perf.length)
    console.log(`  cost: ${Math.round(q(perf.map((p) => p.msPerMin), 0.5))} ms per sim-minute (median; max ${Math.max(...perf.map((p) => p.msPerMin))}), worst tick ${Math.max(...perf.map((p) => p.worstTick))} ms`);
}


// ------------------------------------------------------- nations summary ---

/** Wilson 95% interval of k successes in n, as "p% [lo–hi]". */
export function wilson(k: number, n: number): string {
  if (!n) return "-";
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${Math.round(100 * p)}% [${Math.round(100 * (c - h))}–${Math.round(100 * (c + h))}] (n=${n})`;
}

const SHORT: Record<Nation, string> = { republique: "Rép", empire: "Emp" };

/**
 * `summary --nations <files>`: wins by nation (Wilson 95% intervals), by map,
 * by seat, by personality, red's share in mirrors; army value, harvest and
 * workers by minute; super-unit timing; every kind's tallies (built, lost,
 * value its killing blows took).
 */
function nationsSummary(): void {
  const files = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  const d: Match[] = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Match)).filter((x) => x.nat);
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
  };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const mmss = (x: number | null) => (x === null || isNaN(x) ? "-" : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`);
  const nationOfSide = (x: Match, f: Faction) => x.nat!.nations[f];
  const winnerNation = (x: Match) => (x.winner === "draw" ? "draw" : nationOfSide(x, x.winner));
  const seatOf = (x: Match, n: Nation): Faction => (x.nat!.nations.blue === n ? "blue" : "red");
  const mixed = d.filter((x) => x.nat!.nations.blue !== x.nat!.nations.red);
  const mirrors = d.filter((x) => x.nat!.nations.blue === x.nat!.nations.red);
  const len = d.map((x) => x.min * 60);
  console.log(`matches ${d.length} (${mixed.length} Rép-Emp, ${mirrors.length} mirrors); draws ${d.filter((x) => x.winner === "draw").length}; ` +
    `length median ${mmss(q(len, 0.5))} (p10 ${mmss(q(len, 0.1))}, p90 ${mmss(q(len, 0.9))})`);
  const repShare = (xs: Match[]) => {
    const dec = xs.filter((x) => x.winner !== "draw");
    return wilson(dec.filter((x) => winnerNation(x) === "republique").length, dec.length) + (xs.length > dec.length ? ` +${xs.length - dec.length} draws` : "");
  };
  if (mixed.length) {
    console.log(`\nRépublique's share of decided Rép-Emp games: ${repShare(mixed)}`);
    const mixedLen = mixed.map((x) => x.min * 60);
    console.log(`  length median ${mmss(q(mixedLen, 0.5))} (p10 ${mmss(q(mixedLen, 0.1))}, p90 ${mmss(q(mixedLen, 0.9))})`);
    console.log("  by map:");
    for (const m of [...new Set(mixed.map((x) => x.map))]) {
      const xs = mixed.filter((x) => x.map === m);
      console.log(`    ${m.padEnd(16)} ${repShare(xs)}, median ${mmss(q(xs.map((x) => x.min * 60), 0.5))}`);
    }
    console.log("  by the République's seat:");
    for (const f of SIDES) console.log(`    ${f.padEnd(5)} ${repShare(mixed.filter((x) => seatOf(x, "republique") === f))}`);
    for (const n of ["republique", "empire"] as Nation[]) {
      console.log(`  ${SHORT[n]} personalities (vs the other's whole pool), own win share:`);
      const pers = [...new Set(mixed.map((x) => x[seatOf(x, n)]))];
      for (const p of pers) {
        const xs = mixed.filter((x) => x[seatOf(x, n)] === p && x.winner !== "draw");
        console.log(`    ${p.padEnd(10)} ${wilson(xs.filter((x) => winnerNation(x) === n).length, xs.length)}`);
      }
    }
    const pairs = [...new Set(mixed.map((x) => `${x[seatOf(x, "republique")]}/${x[seatOf(x, "empire")]}`))];
    if (pairs.length <= 40) {
      console.log("  pairings (Rép/Emp): Rép wins–Emp wins–draws");
      console.log("    " + pairs.map((p) => {
        const xs = mixed.filter((x) => `${x[seatOf(x, "republique")]}/${x[seatOf(x, "empire")]}` === p);
        return `${p} ${xs.filter((x) => winnerNation(x) === "republique").length}–${xs.filter((x) => winnerNation(x) === "empire").length}–${xs.filter((x) => x.winner === "draw").length}`;
      }).join(", "));
    }
  }
  if (mirrors.length) {
    for (const n of ["republique", "empire"] as Nation[]) {
      const xs = mirrors.filter((x) => x.nat!.nations.blue === n);
      if (!xs.length) continue;
      const dec = xs.filter((x) => x.winner !== "draw");
      console.log(`\n${SHORT[n]}-${SHORT[n]} mirror: red's share ${wilson(dec.filter((x) => x.winner === "red").length, dec.length)}, draws ${xs.length - dec.length}, median ${mmss(q(xs.map((x) => x.min * 60), 0.5))}`);
      for (const m of [...new Set(xs.map((x) => x.map))]) {
        const ys = xs.filter((x) => x.map === m && x.winner !== "draw");
        console.log(`    ${m.padEnd(16)} red ${wilson(ys.filter((x) => x.winner === "red").length, ys.length)}`);
      }
    }
  }
  // curves and super-units, by nation (every side of every match)
  const sides = d.flatMap((x) => SIDES.map((f) => ({ x, f, n: nationOfSide(x, f), won: x.winner === f })));
  const at = (series: number[], m: number) => series[m - 1];
  for (const n of ["republique", "empire"] as Nation[]) {
    const ss = sides.filter((s) => s.n === n);
    if (!ss.length) continue;
    console.log(`\n== ${SHORT[n]} (${ss.length} sides)`);
    const curve = (name: string, get: (s: (typeof ss)[number]) => number[]) =>
      console.log(`  ${name.padEnd(9)} ` + [2, 4, 6, 8, 10, 12, 15].map((m) => {
        const v = ss.map((s) => at(get(s), m)).filter((v): v is number => v !== undefined);
        return `${m}:00 ${v.length ? Math.round(q(v, 0.5)) : "-"}`;
      }).join("  "));
    curve("army", (s) => s.x.nat!.army[s.f]);
    curve("harvest", (s) => s.x.nat!.harvest[s.f]);
    curve("workers", (s) => s.x.nat!.workers[s.f]);
    curve("base", (s) => s.x.nat!.base[s.f]);
    curve("bank", (s) => s.x.nat!.bank[s.f]);
    const sup = ss.filter((s) => s.x.nat!.superAt[s.f] !== null);
    const gan = ss.filter((s) => s.x.nat!.gantryAt[s.f] !== null);
    console.log(`  super-unit fielded in ${Math.round((100 * sup.length) / ss.length)}% of sides (first at median ${mmss(q(sup.map((s) => s.x.nat!.superAt[s.f]!), 0.5))}), ` +
      `Gantry in ${Math.round((100 * gan.length) / ss.length)}% (median ${mmss(q(gan.map((s) => s.x.nat!.gantryAt[s.f]!), 0.5))}); ` +
      `side with one won ${Math.round((100 * sup.filter((s) => s.won).length) / Math.max(1, sup.length))}%`);
    const long = ss.filter((s) => s.x.min >= 12);
    console.log(`  in matches of 12+ min (${long.length}): super-unit in ${Math.round((100 * long.filter((s) => s.x.nat!.superAt[s.f] !== null).length) / Math.max(1, long.length))}%`);
    const fw = ss.map((s) => s.x.nat!.firstWave[s.f]).filter((v): v is number => v !== null);
    console.log(`  first wave median ${mmss(q(fw, 0.5))} (none in ${ss.length - fw.length}), waves per match ${mean(ss.map((s) => s.x.nat!.waves[s.f])).toFixed(1)}; ` +
      `radium share of digging ${Math.round(100 * mean(ss.map((s) => s.x.nat!.radiumShare[s.f])))}%; dark building-seconds ${Math.round(mean(ss.map((s) => s.x.nat!.darkSecs[s.f])))}`);
    const fb = (k: string) => {
      const v = ss.map((s) => (s.x.nat!.firstBuilt[s.f] as Record<string, number>)[k]).filter((v): v is number => v !== undefined);
      return `${k} ${mmss(q(v, 0.5))} (${Math.round((100 * v.length) / ss.length)}%)`;
    };
    console.log("  first built (median): " + ["fab-plant", "airpad", "assembly-bay", "tech-lab", "depot", "radar", "gantry"].map(fb).join(", "));
    const pw: Record<string, number> = {};
    for (const s of ss) for (const [k, v] of Object.entries(s.x.nat!.powers[s.f])) pw[k] = (pw[k] ?? 0) + v;
    console.log("  calldowns per match: " + Object.entries(pw).map(([k, v]) => `${k} ${(v / ss.length).toFixed(1)}`).join(", "));
    // per kind
    const tot: Partial<Record<UnitKind, KindTally>> = {};
    for (const s of ss)
      for (const [k, t] of Object.entries(s.x.nat!.kinds[s.f]) as [UnitKind, KindTally][]) {
        const a = (tot[k] ??= { built: 0, spent: 0, lost: 0, killedUnits: 0, killedBuildings: 0 });
        a.built += t.built; a.spent += t.spent; a.lost += t.lost; a.killedUnits += t.killedUnits; a.killedBuildings += t.killedBuildings;
      }
    console.log("  kind            built/match  spent/match  lost%   kills(units)/spent  kills(bldg)/spent  units killed/value lost");
    for (const [k, t] of (Object.entries(tot) as [UnitKind, KindTally][]).sort((a, b) => b[1].spent - a[1].spent)) {
      const lostValue = t.lost * balance.UNITS[k].cost;
      console.log(`  ${k.padEnd(16)} ${(t.built / ss.length).toFixed(2).padStart(9)}  ${Math.round(t.spent / ss.length).toString().padStart(11)}  ${(t.built ? Math.round((100 * t.lost) / t.built) : 0).toString().padStart(5)}%  ` +
        `${(t.spent ? t.killedUnits / t.spent : 0).toFixed(2).padStart(18)}  ${(t.spent ? t.killedBuildings / t.spent : 0).toFixed(2).padStart(17)}  ${(lostValue ? t.killedUnits / lostValue : 0).toFixed(2).padStart(22)}`);
    }
  }
  // the army lead at 6:00 and who won
  const lead6 = mixed.filter((x) => x.nat!.army.blue[5] !== undefined && x.winner !== "draw");
  if (lead6.length) {
    const ahead = lead6.filter((x) => (x.nat!.army.blue[5]! > x.nat!.army.red[5]! ? "blue" : "red") === x.winner).length;
    const repAhead = lead6.filter((x) => x.nat!.army[seatOf(x, "republique")][5]! > x.nat!.army[seatOf(x, "empire")][5]!).length;
    console.log(`\narmy ahead at 6:00 went on to win ${Math.round((100 * ahead) / lead6.length)}% (n=${lead6.length}); the République was ahead at 6:00 in ${Math.round((100 * repAhead) / lead6.length)}%`);
  }
  const perf = d.filter((x) => x.perf).map((x) => x.perf!.msPerMin);
  if (perf.length) console.log(`cost: ${Math.round(q(perf, 0.5))} ms per sim-minute (median)`);
}

if (process.argv[2] === "run") void run();
else if (process.argv[2] === "summary") (process.argv.includes("--nations") ? nationsSummary : summary)();
else console.log("usage: pacing.ts run <out.jsonl> [--seeds N] [--shard i/n] [--maps a,b] [--tune JSON] [--nations rep-emp|rep-rep|emp-emp] [--pairs a/b,…] [--jobs N] | summary [--nations] <files...>");
