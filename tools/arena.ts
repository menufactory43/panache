// Agent battles (AGENT-BATTLES.md): two commanders play a Battle Drones
// skirmish in 5-second rounds, each seeing only what its side could see.
//
//   npx vite-node tools/arena.ts run --blue scripted --red ai:rush:hard --map riverlands --seed 42
//   npx vite-node tools/arena.ts serve --map riverlands --seed 42 --blue seat --red seat [--json]
//   npx vite-node tools/arena.ts series --a scripted --b ai:balanced:normal --maps all --seeds 3
//   npx vite-node tools/arena.ts replay battles/<file>.json
//   npx vite-node tools/arena.ts stats battles/*.json [--detail]
//   npx vite-node tools/arena.ts watch battles/<file>.json
//   npx vite-node tools/arena.ts upgrade battles/<file>.json [...] [--commit <sha>]
//   npx vite-node tools/arena.ts pin --version v11 battles/<file>.json [...]
//
// Seats: `ai:<personality>:<difficulty>` (the built-in commander),
// `scripted` or `scripted:<file.json>` (a fixed script, for tests), and in
// `serve` mode `seat` (an outside agent playing through the loopback HTTP or
// MCP seat URL). Models play through LLM and the llm-tools-battledrones plugin:
// `llm battledrones run --blue gpt-6-luna --red gpt-6-luna` starts `serve`
// itself. Common options: --map, --seed, --mutators a,b, --round <seconds>,
// --max-minutes <n>, --out <dir> (default battles/), --nations rep,emp (blue's, then red's; the
// record keeps them, and replays with them). AI seats take the nations' own personalities too (ai:siege, ai:volta).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { Arena, SIDES, parseSeat, type SeatSpec } from "../src/arena/match";
import { replay, resimulate, type BattleEnd, type BattleRecord } from "../src/arena/record";
import { DEFAULT_SCRIPT, playScripted, type Script } from "../src/arena/scripted";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { MAPS, isKnownMapId } from "../src/sim/maps";
import { isMutatorId, parseNations, type MutatorId } from "../src/sim/rules";
import type { Faction } from "../src/sim/types";
import { ROOT, gitCommit, readRecord, recordPath, simHash, writeRecord } from "./arena/files";
import { serveArena } from "./arena/server";

const argv = process.argv.slice(2);
const cmd = argv[0];

function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}
const FLAGS = ["json", "detail", "keep", "quiet", "here", "follow", "no-records", "force"];
const flag = (name: string) => argv.includes(`--${name}`);
/** Arguments that are neither options nor option values. */
const positional = () => argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--") && !FLAGS.includes(all[i - 1]!.slice(2))));

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** A seat from the command line: ai:…, scripted[:file], or (serve only) an outside agent. */
function seatOf(s: string, outside: boolean): { spec: SeatSpec; script?: Script } {
  if (s === "scripted" || s.startsWith("scripted:")) {
    const file = s.slice("scripted:".length);
    const script = file ? (JSON.parse(readFileSync(file, "utf8")) as Script) : DEFAULT_SCRIPT;
    return { spec: { kind: "agent", player: s }, script };
  }
  // "seat" or "seat:<name>": an outside agent (the name labels the record, e.g. seat:gpt-6-luna)
  if (outside && (s === "seat" || s.startsWith("seat:"))) return { spec: { kind: "agent", player: s.slice(5) || "seat" } };
  const spec = parseSeat(s);
  if (spec.kind === "agent" && !outside)
    die(
      `"${s}" isn't a seat this command can play. Models play through LLM:\n` +
        `  llm install -e llm-tools-battledrones\n  llm battledrones run --blue ${s} --red ai:balanced:normal\n` +
        `or serve the battle and connect any agent to the seat URLs:\n  npx vite-node tools/arena.ts serve --blue seat --red ai:balanced:normal`
    );
  return { spec };
}

function matchArgs() {
  const map = arg("map", "riverlands")!;
  if (!isKnownMapId(map)) die(`unknown map "${map}": ${MAPS.map((m) => m.id).join(", ")}, or random-<biome>-<code>`);
  const seed = Number(arg("seed", String(1 + Math.floor(Math.random() * 99999))));
  const mutators = (arg("mutators") ?? "").split(",").filter(Boolean);
  for (const m of mutators) if (!isMutatorId(m)) die(`unknown mutator "${m}"`);
  const roundTicks = Math.round(Number(arg("round", "5")) * TICK_RATE);
  const maxTicks = Math.round(Number(arg("max-minutes", "20")) * 60 * TICK_RATE);
  const nationsArg = arg("nations");
  const nations = nationsArg ? parseNations(nationsArg) : null;
  if (nationsArg && !nations) die(`--nations wants blue's and red's nation: rep,emp | emp,rep | rep,rep | emp,emp (not ${nationsArg})`);
  return { map, seed, mutators: mutators as MutatorId[], ...(nations ? { nations } : {}), roundTicks, maxTicks, out: arg("out", join(ROOT, "battles"))! };
}

const who = (r: BattleRecord, f: Faction) => r.seats[f].player;
const clock = (t: number) => `${Math.floor(t / TICK_RATE / 60)}:${String(Math.floor(t / TICK_RATE) % 60).padStart(2, "0")}`;
const verdict = (r: BattleRecord) =>
  !r.end ? "unfinished" : r.end.winner ? `${r.end.winner} (${who(r, r.end.winner)}) wins at ${clock(r.end.tick)}${r.end.reason === "hq" ? "" : ` (${r.end.reason})`}` : `${r.end.reason === "aborted" ? "aborted" : "draw"} at ${clock(r.end.tick)}`;

/** Play a whole battle in-process (AI and scripted seats). */
function playLocal(o: ReturnType<typeof matchArgs>, blue: string, red: string, write = true): BattleRecord {
  const seats = { blue: seatOf(blue, false), red: seatOf(red, false) };
  const path = write ? recordPath(o.out, o.map, o.seed, blue, red) : null;
  const arena = new Arena({
    map: o.map, seed: o.seed, mutators: o.mutators, nations: o.nations, roundTicks: o.roundTicks, maxTicks: o.maxTicks,
    seats: { blue: seats.blue.spec, red: seats.red.spec },
    commit: gitCommit(), sim: simHash(),
    onRound: (a) => {
      if (path && (a.over || a.round % 12 === 0)) writeRecord(path, a.record);
    }
  });
  while (!arena.over) {
    for (const side of SIDES) {
      const script = seats[side].script;
      if (script) playScripted(arena, side, script);
    }
    arena.advance();
  }
  if (path) console.log(`record: ${relative(process.cwd(), path)}`);
  return arena.record;
}

async function run() {
  const o = matchArgs();
  const blue = arg("blue", "scripted")!;
  const red = arg("red", "ai:balanced:normal")!;
  const r = playLocal(o, blue, red);
  console.log(`${o.map} seed ${o.seed}: blue ${blue} (${r.openers.blue}) vs red ${red} (${r.openers.red}): ${verdict(r)}`);
}

async function serve() {
  const o = matchArgs();
  const blue = arg("blue", "seat")!;
  const red = arg("red", "seat")!;
  const seats = { blue: seatOf(blue, true), red: seatOf(red, true) };
  const label = (x: string) => (x === "seat" ? "agent" : x.replace(/^seat:/, ""));
  const path = arg("record") ?? recordPath(o.out, o.map, o.seed, label(blue), label(red));
  const quiet = flag("quiet");
  const arena = new Arena({
    map: o.map, seed: o.seed, mutators: o.mutators, nations: o.nations, roundTicks: o.roundTicks, maxTicks: o.maxTicks,
    seats: { blue: seats.blue.spec, red: seats.red.spec },
    commit: gitCommit(), sim: simHash()
  });
  writeRecord(path, arena.record);
  const srv = await serveArena(arena, {
    port: Number(arg("port", "8790")),
    scripted: { ...(seats.blue.script ? { blue: seats.blue.script } : {}), ...(seats.red.script ? { red: seats.red.script } : {}) },
    turnTimeout: Number(arg("turn-timeout", "0")),
    onRound: () => writeRecord(path, arena.record),
    log: (l) => quiet || console.error(`[arena] ${l}`)
  });
  const rel = relative(process.cwd(), path);
  if (flag("json")) console.log(JSON.stringify({ ...srv.urls, record: path }));
  else {
    console.log(`Battle Drones arena: ${o.map}, seed ${o.seed}, ${o.roundTicks / TICK_RATE} s rounds, record ${rel}`);
    for (const s of SIDES) {
      const spec = seats[s].spec;
      console.log(`  ${s}: ${spec.kind === "ai" ? `ai:${spec.strategy}:${spec.difficulty}` : seats[s].script ? "scripted" : srv.urls[s]}`);
    }
    for (const s of SIDES) if (seats[s].spec.kind === "agent" && !seats[s].script) console.log(`  ${s} (MCP): ${srv.urls.mcp[s]}`);
    console.log(`  control: ${srv.urls.control}`);
  }
  const stop = async () => {
    arena.abort();
    writeRecord(path, arena.record);
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await srv.done;
  writeRecord(path, arena.record);
  console.error(`[arena] ${verdict(arena.record)}; record ${rel}`);
  if (flag("keep")) return;
  // give the seats a moment to read the result, then go
  setTimeout(() => void srv.close().then(() => process.exit(0)), Number(arg("linger", "20")) * 1000);
}

async function series() {
  const o = matchArgs();
  const a = arg("a") ?? die("series needs --a and --b");
  const b = arg("b") ?? die("series needs --a and --b");
  const mapsArg = arg("maps", o.map)!;
  const maps = mapsArg === "all" ? MAPS.map((m) => m.id) : mapsArg.split(",");
  const seeds = Number(arg("seeds", "3"));
  const firstSeed = Number(arg("seed", "1"));
  const tally: Record<string, number> = { [a]: 0, [b]: 0, draw: 0 };
  for (const map of maps)
    for (let i = 0; i < seeds; i++) {
      const seed = firstSeed + i;
      // mirror pairs: the same seed with the sides swapped
      for (const [blue, red] of [[a, b], [b, a]] as const) {
        const r = playLocal({ ...o, map, seed }, blue, red, !flag("no-records"));
        const w = r.end?.winner;
        tally[w ? (w === "blue" ? blue : red) : "draw"]!++;
        console.log(`${map} seed ${seed}: blue ${blue} vs red ${red}: ${verdict(r)}`);
      }
    }
  console.log(`\n${a}: ${tally[a]} wins, ${b}: ${tally[b]} wins, ${tally.draw} draws`);
}

/** Re-run a record, in a worktree at its commit when the sim has changed since. */
async function replayCmd() {
  const file = positional()[0] ?? die("replay <record.json>");
  const r = readRecord(file);
  const here = simHash();
  if (r.sim && r.sim !== here && !flag("here")) {
    if (!r.commit) die(`${file} was played by different sim code (${r.sim}, here ${here}) and names no commit`);
    const dir = worktreeAt(r.commit);
    console.log(`sim changed since this battle: replaying in ${relative(process.cwd(), dir)}`);
    const child = spawn("npx", ["vite-node", "tools/arena.ts", "replay", resolve(file), "--here"], { cwd: dir, stdio: "inherit" });
    await new Promise((ok) => child.on("exit", ok));
    return;
  }
  const res = replay(r);
  console.log(`${basename(file)}: ${r.map} seed ${r.seed}, ${who(r, "blue")} vs ${who(r, "red")}: ${verdict(r)}`);
  const w = res.world;
  console.log(`replayed to ${clock(w.tick)}: ${w.winner === "draw" ? "a draw" : w.winner ? `${w.winner} wins` : "no winner"}; ${res.checked} hash checks, ${res.divergedAt === null ? "all match" : `⚠ diverged at ${clock(res.divergedAt)}`}`);
  if (res.divergedAt !== null) process.exitCode = 2;
}

/** A git worktree at `commit` under .arena-builds/, sharing this checkout's node_modules. */
function worktreeAt(commit: string): string {
  const dir = join(ROOT, ".arena-builds", commit.slice(0, 12));
  if (!existsSync(dir)) {
    mkdirSync(join(ROOT, ".arena-builds"), { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", dir, commit], { cwd: ROOT, stdio: "inherit" });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  }
  return dir;
}

function stats() {
  const files = positional();
  if (!files.length) die("stats <record.json> [...]");
  const recs = files.map((f) => ({ f, r: readRecord(f) }));
  const add = (m: Map<string, number[]>, k: string, i: number) => {
    const v = m.get(k) ?? [0, 0, 0, 0];
    v[i]!++;
    m.set(k, v);
  };
  // [wins, losses, draws, games]
  const byPlayer = new Map<string, number[]>();
  const bySide = new Map<string, number[]>();
  const byMap = new Map<string, number[]>();
  const byOpener = new Map<string, number[]>();
  const tokens = new Map<string, { input: number; cached: number; output: number; games: number }>();
  for (const { f, r } of recs) {
    console.log(`${basename(f)}: ${r.map} seed ${r.seed}: ${who(r, "blue")} [${r.openers.blue ?? "-"}] vs ${who(r, "red")} [${r.openers.red ?? "-"}]: ${verdict(r)}`);
    if (flag("detail")) detail(r);
    if (!r.end || r.end.reason === "aborted") continue;
    for (const s of SIDES) {
      const res = r.end.winner === null ? 2 : r.end.winner === s ? 0 : 1;
      for (const [m, k] of [[byPlayer, who(r, s)], [bySide, s], [byMap, `${r.map} ${s}`], [byOpener, r.openers[s] ?? "-"]] as const) {
        add(m, k, res);
        add(m, k, 3);
      }
      const u = r.usage[s];
      if (u) {
        const t = tokens.get(who(r, s)) ?? { input: 0, cached: 0, output: 0, games: 0 };
        t.input += u.input;
        t.cached += u.cached;
        t.output += u.output;
        t.games++;
        tokens.set(who(r, s), t);
      }
    }
  }
  const table = (title: string, m: Map<string, number[]>) => {
    if (!m.size) return;
    console.log(`\n${title}: wins-losses-draws`);
    for (const [k, [wn, l, d, g]] of [...m].sort()) console.log(`  ${k.padEnd(28)} ${wn}-${l}-${d}  (${Math.round((100 * wn!) / g!)}% of ${g})`);
  };
  table("by player", byPlayer);
  table("by side", bySide);
  table("by map and side", byMap);
  table("by opener", byOpener);
  if (tokens.size) {
    console.log("\ntokens per game (input / cached / output)");
    for (const [k, t] of tokens) console.log(`  ${k.padEnd(28)} ${Math.round(t.input / t.games)} / ${Math.round(t.cached / t.games)} / ${Math.round(t.output / t.games)}`);
  }
}

/** Per-minute army value, scrap, harvest and Uplinks for each side (tools/pacing.ts's measures), by replaying. */
function detail(r: BattleRecord) {
  console.log("   min | blue army  scrap  mined  uplinks | red army  scrap  mined  uplinks");
  replay(r, {
    onTick: (w) => {
      if (w.tick % (60 * TICK_RATE) !== 0) return;
      const side = (f: Faction) => {
        let army = 0;
        for (const u of w.units.values()) if (u.faction === f && u.kind !== "harvester") army += UNITS[u.kind].cost * (u.hp / UNITS[u.kind].hp);
        const held = w.objectives.uplinks.filter((l) => l.owner === f).length;
        return `${String(Math.round(army)).padStart(9)} ${String(Math.floor(w.factions[f].scrap)).padStart(6)} ${String(Math.round(w.factions[f].stats.scrapHarvested)).padStart(6)} ${String(held).padStart(8)}`;
      };
      console.log(`   ${String(w.tick / 600).padStart(3)} |${side("blue")} |${side("red")}`);
    }
  });
}

/** Open a record in the dev viewer: `npm run dev` (in a worktree at the record's commit if the sim changed). */
async function watch() {
  const file = positional()[0] ?? die("watch <record.json>");
  const r = readRecord(resolve(file));
  let dir = ROOT;
  if (r.sim && r.sim !== simHash() && r.commit) {
    dir = worktreeAt(r.commit);
    console.log(`sim changed since this battle: serving the viewer from ${relative(process.cwd(), dir)}`);
  }
  // the dev server serves files from the project root; outside it, /@fs/ reaches them
  const abs = resolve(file);
  const inRoot = !relative(dir, abs).startsWith("..");
  const ref = inRoot ? relative(dir, abs).replaceAll("\\", "/") : `@fs${abs}`;
  const port = arg("port", "5173");
  const follow = flag("follow") ? "&follow" : "";
  console.log(`viewer: http://localhost:${port}/?replay=${encodeURIComponent(ref)}${follow}`);
  const child = spawn("npx", ["vite", "--port", port!, "--strictPort"], { cwd: dir, stdio: "inherit" });
  await new Promise((ok) => child.on("exit", ok));
}

/**
 * Bring records played by older sim code up to this one (in place): the same
 * commands re-simulated, a new hash trail and ending (src/arena/record.ts
 * resimulate), so they replay exactly in this build of the game, the public
 * one included. `--commit` names the commit that holds this sim (default:
 * HEAD); `--force` re-simulates records already on it.
 */
function upgrade() {
  const files = positional();
  if (!files.length) die("upgrade <record.json> [...] [--commit <sha>] [--force]");
  const sim = simHash();
  const commit = arg("commit") ?? gitCommit();
  const when = (e: BattleEnd | null) => (!e ? "unfinished" : e.winner ? `${e.winner} won at ${clock(e.tick)}` : `${e.reason === "aborted" ? "stopped" : "draw"} at ${clock(e.tick)}`);
  for (const f of files) {
    const r = readRecord(f);
    if (r.sim === sim && !flag("force")) {
      console.log(`${basename(f)}: already on this sim (${sim})`);
      continue;
    }
    const u = resimulate(r, { commit, sim });
    writeRecord(f, u);
    const moved = (u.end?.tick ?? 0) - (r.end?.tick ?? 0);
    const note = u.end?.winner !== r.end?.winner ? "  (a different ending)" : moved ? `  (${Math.abs(moved / TICK_RATE)} s ${moved > 0 ? "later" : "sooner"})` : "";
    console.log(`${basename(f)}: sim ${r.sim ?? "?"} → ${sim}; was: ${when(r.end)}; now: ${when(u.end)}${note}`);
  }
}

/**
 * Pin records to a version of the game (in place): replay each on this
 * checkout's sim, and if it replays exactly (every hash check, and the same
 * ending), write the version tag into it (BattleRecord.version). That
 * version's build then plays it with nothing to check, and its links go
 * there. The tag must hold this checkout's sim: one that exists is checked,
 * and a new one must be cut from a commit with it.
 */
function pin() {
  const files = positional();
  const version = arg("version");
  if (!files.length || !version) die("pin --version <tag> <record.json> [...]");
  if (!/^v[0-9][A-Za-z0-9.+-]*$/.test(version)) die(`${version} isn't a version tag (v11, v9.1.0…)`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, stdio: "ignore" });
  const tagged = (() => {
    try {
      git("rev-parse", "--quiet", "--verify", `refs/tags/${version}`);
      return true;
    } catch {
      return false;
    }
  })();
  if (tagged) {
    try {
      git("diff", "--quiet", version, "--", "src/sim");
    } catch {
      die(`${version} has other sim code than this checkout: check ${version} out to pin records to it`);
    }
  } else console.log(`${version} isn't tagged yet: tag a commit with this sim (${simHash()})`);
  for (const f of files) {
    const r = readRecord(f);
    const res = replay(r);
    const w = res.world;
    const won = w.winner === "draw" ? null : w.winner;
    const why =
      res.divergedAt !== null ? `diverges at ${clock(res.divergedAt)}`
      : !res.checked ? "no hash checks"
      : r.end && (w.tick !== r.end.tick || won !== r.end.winner) ? `ends differently (${verdict(r)}; here ${won ?? "no winner"} at ${clock(w.tick)})`
      : null;
    if (why) {
      console.log(`${basename(f)}: ${why}: not pinned`);
      process.exitCode = 2;
      continue;
    }
    writeRecord(f, { ...r, version });
    console.log(`${basename(f)}: ${res.checked} hash checks, all match: pinned to ${version}`);
  }
}

const commands: Record<string, () => unknown> = { run, serve, series, replay: replayCmd, stats, watch, upgrade, pin };
const fn = cmd ? commands[cmd] : undefined;
if (!fn) die(`usage: npx vite-node tools/arena.ts <${Object.keys(commands).join("|")}> [options]\nsee the header of tools/arena.ts and AGENT-BATTLES.md`);
await fn();
