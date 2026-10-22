/**
 * Battle records (AGENT-BATTLES.md "Battle records"): a small JSON file that
 * replays a battle exactly. The sim is deterministic — the seed and the
 * commands decide everything — so a record is the setup, every non-empty
 * turn's commands in true map coordinates, and a world hash every 100 ticks
 * to prove a replay matches. Round-by-round orders, notes and radio lines
 * ride along for the viewer and for reading how each side thought.
 */
import { type OpenerId } from "../sim/openers";
import type { MutatorId } from "../sim/rules";
import { step } from "../sim/sim";
import type { Command, Faction, Nation, World } from "../sim/types";

// setup and hashing live in the sim, shared with sound duels (SOUND-DUEL.md)
export { setupWorld } from "../sim/setup";
export { worldHash } from "../sim/checksum";
import { setupWorld } from "../sim/setup";
import { worldHash } from "../sim/checksum";

export const HASH_EVERY = 100;

export interface SeatInfo {
  /** "ai:rush:hard", "scripted", "openai:gpt-6-luna", "seat" (an outside agent)… */
  player: string;
  /** Model options (reasoning effort, temperature), budgets, client versions. */
  settings?: Record<string, unknown>;
}

export interface Usage {
  input: number;
  cached: number;
  output: number;
  /** Model responses (one per tool-loop step) and tool calls. */
  responses?: number;
  toolCalls?: number;
}

/** One side's round: what it ordered (in its own frame), what came back, its notes and radio. */
export interface RoundLog {
  round: number;
  tick: number;
  side: Faction;
  orders: unknown[];
  results: string[];
  notes: string;
  radio?: string;
  /** How the round ended for this seat: it called end_round, wait, ran out of budget, or the arena ended it. */
  ended?: string;
  usage?: Usage;
}

export interface BattleEnd {
  tick: number;
  winner: Faction | null;
  /**
   * "hq": a side was beaten (its HQ and every Goliath gone); "love": a Robot Love draw (no winner);
   * "resign": a side gave up (a sound duel, SOUND-DUEL.md).
   */
  reason: "hq" | "time" | "aborted" | "love" | "resign";
}

/**
 * How a decided world ends a record: a side won, or nobody did. `resigned`
 * is the world's own: the side that gave up, null when both did on one tick
 * (a draw by "resign", not Robot Love's), unset otherwise (an HQ, or Robot
 * Love). The sound duel's duelEnd (src/versus/records.ts, which may not
 * import this) says the same; tests/resign.test.ts holds them together.
 */
export function endOf(tick: number, winner: Faction | "draw", resigned?: Faction | null): BattleEnd {
  if (winner === "draw") return { tick, winner: null, reason: resigned === null ? "resign" : "love" };
  return { tick, winner, reason: resigned ? "resign" : "hq" };
}

export interface BattleRecord {
  v: 1;
  /** The code that played it: git commit, and a hash of src/sim/**. */
  commit: string | null;
  sim: string | null;
  created: string;
  map: string;
  mutators: MutatorId[];
  seed: number;
  /** Ticks per round. */
  round: number;
  maxTicks: number;
  openers: Partial<Record<Faction, OpenerId>>;
  /** Income multiplier per side when not 1 (the built-in AI's difficulty handicap: tickAi sets it every tick). */
  income?: Partial<Record<Faction, number>>;
  /** The nation each side played (PANACHE-CONCEPTION.md §1.10); absent: Classique. setupWorld(record) reads it. */
  nations?: Partial<Record<Faction, Nation>>;
  seats: Record<Faction, SeatInfo>;
  /** Coordinates in `log` are each side's own frame; `turns` and `radio` ticks are true. */
  frames: "own";
  /** Non-empty turns only: [tick, side, commands in true map coordinates]. */
  turns: [number, Faction, Command[]][];
  radio: [number, Faction, string][];
  /** [tick, hash] every HASH_EVERY ticks. */
  hashes: [number, string][];
  log: RoundLog[];
  /** How far the battle has been played: a live record grows round by round. */
  tick: number;
  end: BattleEnd | null;
  usage: Partial<Record<Faction, Usage>>;
  /** Re-simulated on newer sim code (resimulate), oldest first: what it was before each time. */
  upgraded?: Upgrade[];
  /** A version tag of the game (v11) this record replays exactly on, checked (tools/arena.ts pin): its links go there. */
  version?: string;
}

/** One re-simulation: the code the record had been played (or last re-simulated) by, and how it ended then. */
export interface Upgrade {
  from: { commit: string | null; sim: string | null };
  end: BattleEnd | null;
  at: string;
}


// ------------------------------------------------------------------- replay ---

export interface ReplayResult {
  world: World;
  /** First checkpoint whose hash didn't match (null: all matched). */
  divergedAt: number | null;
  checked: number;
}

/**
 * Re-run a record from its setup and commands, checking the hash trail.
 * `until` stops early (a tick); `onTick` sees the world after every step.
 */
export function replay(r: BattleRecord, opts: { until?: number; onTick?: (w: World) => void } = {}): ReplayResult {
  const w = setupWorld(r);
  const byTick = new Map<number, Command[]>();
  for (const [tick, , cmds] of r.turns) byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);
  const hashes = new Map(r.hashes);
  // (an unfinished record: as far as it was played; one from before `tick` was kept: its last checkpoint)
  const end = Math.min(opts.until ?? Infinity, r.end?.tick ?? r.tick ?? Math.max(0, ...r.hashes.map((h) => h[0])));
  let divergedAt: number | null = null;
  let checked = 0;
  while (w.tick < end && !w.winner) {
    step(w, byTick.get(w.tick) ?? []);
    opts.onTick?.(w);
    const want = hashes.get(w.tick);
    if (want !== undefined) {
      checked++;
      if (divergedAt === null && worldHash(w) !== want) divergedAt = w.tick;
    }
  }
  return { world: w, divergedAt, checked };
}

// --------------------------------------------------------------- upgrade ---

/**
 * The same battle on this sim code: the record's commands re-run from its
 * setup, with a new hash trail and ending, so a record from older sim code
 * replays (exactly, from then on) with this one. The commands were chosen
 * against the old sim's world, and they are kept as they were: a unit that
 * died a moment sooner ignores its last order, a building placed on a tile
 * now in use isn't, so a re-simulated battle can end differently, or later.
 * If no HQ has fallen by the original ending, it plays on with the standing
 * orders until one does, or until the battle's time limit (a draw). The
 * models' notes, orders and radio lines stay as they were played; `upgraded`
 * keeps what the record said before, its ending included.
 */
export function resimulate(r: BattleRecord, code: { commit: string | null; sim: string | null }): BattleRecord {
  const w = setupWorld(r);
  const byTick = new Map<number, Command[]>();
  for (const [tick, , cmds] of r.turns) byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);
  // (a draw on time stays a draw on time; a finished battle plays on until an HQ falls; an unfinished one as far as it went)
  const limit = r.end?.reason === "time" ? r.end.tick : r.end ? r.maxTicks : r.tick;
  const hashes: [number, string][] = [];
  while (w.tick < limit && !w.winner) {
    step(w, byTick.get(w.tick) ?? []);
    if (w.tick % HASH_EVERY === 0) hashes.push([w.tick, worldHash(w)]);
  }
  const end: BattleEnd | null = w.winner
    ? endOf(w.tick, w.winner, w.resigned)
    : r.end
      ? { tick: w.tick, winner: null, reason: r.end.reason === "aborted" ? "aborted" : "time" }
      : null;
  return {
    ...r,
    commit: code.commit,
    sim: code.sim,
    // (new hashes: the version it was pinned to no longer plays them)
    version: undefined,
    hashes,
    tick: w.tick,
    end,
    upgraded: [...(r.upgraded ?? []), { from: { commit: r.commit, sim: r.sim }, end: r.end, at: new Date().toISOString() }]
  };
}
