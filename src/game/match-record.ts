/**
 * « Enregistrer ses parties »: a single-player match kept as a battle
 * record (AGENT-BATTLES.md "Battle records"), so it replays exactly in the
 * battle viewer and as its highlight reel. The sim is deterministic: the
 * setup (map, seed, mutators, nations, both openers, the AI's income
 * handicap: tickAi sets it every tick, so the record carries it as the
 * arena does) and every command stepped, the player's and the AI
 * commander's alike, decide the whole match, routes and patrols included.
 * A world hash every HASH_EVERY ticks and one on the last tick prove a
 * replay matches (tests/match-record.test.ts plays one through).
 *
 * GameScene keeps one for a skirmish or the Daily Op against the AI (not
 * Last Stand, an op or the Instruction, which run on setups a record can't
 * describe yet); a duel keeps its own (src/versus/feed.ts record()).
 *
 * The arena's code loads with the battle viewer, so this uses its types only.
 *
 * Engine-free: the scene hands it the setup, each tick's commands as it
 * steps them (blue's before red's, as composeTick orders them) and the
 * world after.
 */
import type { BattleEnd, BattleRecord, PlayedInfo, ReelMoment, SeatInfo } from "../arena/record";
import { worldHash } from "../sim/checksum";
import type { OpenerId } from "../sim/openers";
import type { MatchSetup } from "../sim/setup";
import type { Command, Faction, World } from "../sim/types";

/** A world hash goes into the record every this many ticks (the arena's rate: the viewer checks them). */
export const HASH_EVERY = 100;

/**
 * How a decided match's record ends: the arena's endOf, which the game may
 * not import (the arena loads with the viewer); tests/match-record.test.ts
 * holds the two together.
 */
export function soloEnd(tick: number, winner: Faction | "draw", resigned?: Faction | null): BattleEnd {
  if (winner === "draw") return { tick, winner: null, reason: resigned === null ? "resign" : "love" };
  return { tick, winner, reason: resigned ? "resign" : "hq" };
}

declare const __SIM_HASH__: string | undefined;
/**
 * The sim this build plays (vite.config.ts), or null outside a Vite build:
 * replay.ts's BUILD_SIM, which this may not import (the viewer is a lazily
 * loaded chunk).
 */
export const BUILD_SIM_HASH: string | null = typeof __SIM_HASH__ === "undefined" ? null : __SIM_HASH__;

export class MatchRecorder {
  private turns: [number, Faction, Command[]][] = [];
  private hashes: [number, string][] = [];
  private openers: Partial<Record<Faction, OpenerId>> = {};

  constructor(
    private o: {
      /** The match as set up, openers aside (they're dealt later: opened). */
      setup: Omit<MatchSetup, "openers">;
      seats: Record<Faction, SeatInfo>;
      /** The sim this build plays (replay.ts BUILD_SIM). */
      sim: string | null;
      created: string;
    }
  ) {}

  /** The openers both sides were dealt, before the first tick (blue's applied first: local-side.ts). */
  opened(picks: Partial<Record<Faction, OpenerId>>): void {
    this.openers = { ...picks };
  }

  /** One tick's commands as stepped, before the step: each side's own (an empty side leaves no entry). */
  step(tick: number, blue: readonly Command[], red: readonly Command[]): void {
    // (copies: a command object may be reused or changed once the sim has taken it)
    if (blue.length) this.turns.push([tick, "blue", JSON.parse(JSON.stringify(blue)) as Command[]]);
    if (red.length) this.turns.push([tick, "red", JSON.parse(JSON.stringify(red)) as Command[]]);
  }

  /** After each step: a hash every HASH_EVERY ticks. */
  stepped(w: World): void {
    if (w.tick % HASH_EVERY === 0) this.hashes.push([w.tick, worldHash(w)]);
  }

  /** Commands so far (for tests and the size check). */
  get turnCount(): number {
    return this.turns.length;
  }

  /** The decided match as a record, with the last tick's hash, the player's side of it and its reel. */
  record(w: World, played?: PlayedInfo, reel?: ReelMoment[]): BattleRecord {
    const hashes = this.hashes.slice();
    if (hashes.at(-1)?.[0] !== w.tick) hashes.push([w.tick, worldHash(w)]);
    const end: BattleEnd = w.winner ? soloEnd(w.tick, w.winner, w.resigned) : { tick: w.tick, winner: null, reason: "aborted" as const };
    const s = this.o.setup;
    return {
      v: 1,
      commit: null,
      sim: this.o.sim,
      created: this.o.created,
      map: s.map,
      mutators: s.mutators.slice(),
      seed: s.seed,
      round: 1,
      maxTicks: w.tick,
      openers: { ...this.openers },
      ...(s.income && Object.keys(s.income).length ? { income: { ...s.income } } : {}),
      ...(s.nations ? { nations: { ...s.nations } } : {}),
      seats: { blue: { ...this.o.seats.blue }, red: { ...this.o.seats.red } },
      frames: "own",
      turns: this.turns.slice(),
      radio: [],
      hashes,
      log: [],
      tick: w.tick,
      end,
      usage: {},
      ...(played ? { played } : {}),
      ...(reel ? { reel } : {})
    };
  }
}
