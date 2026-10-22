/**
 * The arena (AGENT-BATTLES.md "The runner"): one process holds the only
 * copy of the world and plays it in rounds. Every round both seats see the
 * same tick and give orders without seeing each other's; then the sim runs
 * the next `roundTicks` ticks with both sides' orders applied at the first
 * of them (blue's, then red's). A seat played by the built-in AI ticks
 * every tick, as in a normal game.
 *
 * Seats:
 *  - "agent": anything that plays through the tools (an LLM through the
 *    loopback HTTP seats, a coding agent through MCP, a scripted seat in
 *    tests). Its turn is open until it calls endRound or wait.
 *  - "ai": the game's own commander, `ai:<personality>:<difficulty>`.
 *
 * Nothing here touches the network or the file system: tools/arena.ts
 * drives it, and tests drive it directly.
 */
import { DIFFICULTY, PERSONALITIES, createAiState, tickAi, type AiState, type Difficulty, type PersonalityName } from "../sim/ai/commander";
import { TICK_RATE } from "../sim/balance";
import { hash32 } from "../sim/rand";
import { OPENER_IDS, allowedOpener, pickAiOpener, type OpenerId } from "../sim/openers";
import { placementBlocker } from "../sim/placement";
import type { MutatorId } from "../sim/rules";
import { step } from "../sim/sim";
import type { Command, Faction, Nation, World } from "../sim/types";
import { MAPS, createMapWorld, isKnownMapId } from "../sim/maps";
import { tickFog } from "../sim/fog";
import { applyOpener } from "../sim/openers";
import { SideLog, type Urgent } from "./events";
import { clock, enemyOf, frameOf } from "./frame";
import { briefing, look, observeState, renderObservation } from "./observe";
import { parseOrders, suggestSpot, type BuildIntent } from "./orders";
import { HASH_EVERY, endOf, worldHash, type BattleRecord, type RoundLog, type SeatInfo, type Usage } from "./record";

export const ROUND_TICKS = 50;
/** 20:00 of game time: a battle nobody can finish is a draw. */
export const MAX_TICKS = 20 * 60 * TICK_RATE;
export const NOTES_MAX = 2000;
export const RADIO_MAX = 120;
/** If an agent never picks, it gets this opener. */
export const DEFAULT_OPENER: OpenerId = "industry";

export const SIDES: Faction[] = ["blue", "red"];

export type SeatSpec =
  | { kind: "agent"; player?: string; settings?: Record<string, unknown> }
  | { kind: "ai"; strategy: PersonalityName; difficulty: Difficulty };

/** "ai:rush:hard" → an AI seat; anything else is an agent seat named by it. */
export function parseSeat(s: string): SeatSpec {
  const m = /^ai(?::([a-z]+))?(?::([a-z]+))?$/.exec(s.trim());
  if (m) {
    const strategy = (m[1] ?? "balanced") as PersonalityName;
    const difficulty = (m[2] ?? "normal") as Difficulty;
    if (!(strategy in PERSONALITIES)) throw new Error(`unknown AI personality "${strategy}": ${Object.keys(PERSONALITIES).join(", ")}`);
    if (!(difficulty in DIFFICULTY)) throw new Error(`unknown AI difficulty "${difficulty}": ${Object.keys(DIFFICULTY).join(", ")}`);
    return { kind: "ai", strategy, difficulty };
  }
  return { kind: "agent", player: s };
}

export const seatName = (s: SeatSpec) => (s.kind === "ai" ? `ai:${s.strategy}:${s.difficulty}` : s.player ?? "agent");

export interface ArenaOptions {
  map: string;
  seed: number;
  mutators?: MutatorId[];
  /** The nations blue and red play (absent: Classique). */
  nations?: Record<Faction, Nation>;
  roundTicks?: number;
  maxTicks?: number;
  seats: Record<Faction, SeatSpec>;
  commit?: string | null;
  sim?: string | null;
  /** Called after every round (and the opener reveal) with the record: the runner rewrites the file. */
  onRound?: (a: Arena) => void;
}

interface Seat {
  side: Faction;
  spec: SeatSpec;
  ai: AiState | null;
  log: SideLog;
  /** This round's turn is over (or the seat is an AI, or waiting). */
  ended: boolean;
  /** Skip turns through this round (wait), unless something urgent happens. */
  waitUntil: number;
  notes: string;
  opener: OpenerId | null;
  /** Staged copy of the world this round (orders are checked against it), made on the first orders() call. */
  staged: World | null;
  commands: Command[];
  orders: unknown[];
  results: string[];
  lastResults: string[];
  build: BuildIntent | null;
  news: string[];
  radio?: string;
  endedHow?: string;
}

export class Arena {
  readonly w: World;
  readonly roundTicks: number;
  readonly maxTicks: number;
  /** 0 is the opener round; round r starts at tick (r-1) × roundTicks. */
  round = 0;
  readonly record: BattleRecord;
  private seats: Record<Faction, Seat>;
  private briefings = new Map<Faction, string>();
  private onRound?: (a: Arena) => void;

  constructor(opts: ArenaOptions) {
    // (mapById falls back to the first map for an unknown id: say so instead)
    if (!isKnownMapId(opts.map))
      throw new Error(`unknown map "${opts.map}": ${MAPS.map((m) => m.id).join(", ")}, or random-<biome>-<code>`);
    this.roundTicks = opts.roundTicks ?? ROUND_TICKS;
    this.maxTicks = opts.maxTicks ?? MAX_TICKS;
    this.onRound = opts.onRound;
    const mutators = opts.mutators ?? [];
    this.w = createMapWorld(opts.map, {
      seed: opts.seed, objectives: true, ...(mutators.length ? { mutators } : {}), ...(opts.nations ? { nations: opts.nations } : {})
    });
    tickFog(this.w); // (each side sees its own base in the opener round)
    const seat = (side: Faction): Seat => {
      const spec = opts.seats[side];
      return {
        side, spec,
        ai: spec.kind === "ai" ? createAiState(spec.strategy, spec.difficulty, hash32(opts.seed, side === "blue" ? 1 : 2)) : null,
        log: new SideLog(side),
        ended: spec.kind === "ai",
        waitUntil: 0,
        notes: "",
        opener: null,
        staged: null,
        commands: [],
        orders: [],
        results: [],
        lastResults: [],
        build: null,
        news: []
      };
    };
    this.seats = { blue: seat("blue"), red: seat("red") };
    const info = (s: Seat): SeatInfo => ({
      player: seatName(s.spec),
      ...(s.spec.kind === "agent" && s.spec.settings ? { settings: s.spec.settings } : {})
    });
    this.record = {
      v: 1,
      commit: opts.commit ?? null,
      sim: opts.sim ?? null,
      created: new Date().toISOString(),
      map: this.w.mapId,
      mutators: this.w.rules?.mutators ?? [],
      ...(opts.nations ? { nations: opts.nations } : {}),
      seed: this.w.seed,
      round: this.roundTicks,
      maxTicks: this.maxTicks,
      openers: {},
      seats: { blue: info(this.seats.blue), red: info(this.seats.red) },
      frames: "own",
      turns: [],
      radio: [],
      hashes: [],
      log: [],
      tick: 0,
      end: null,
      usage: {}
    };
    // the built-in AI's difficulty handicap (tickAi sets it every tick): in the record, so a replay without the AI matches
    for (const s of SIDES) {
      const spec = this.seats[s].spec;
      if (spec.kind !== "ai" || DIFFICULTY[spec.difficulty].incomeMult === 1) continue;
      this.w.factions[s].incomeMult = DIFFICULTY[spec.difficulty].incomeMult;
      (this.record.income ??= {})[s] = DIFFICULTY[spec.difficulty].incomeMult;
    }
    for (const s of SIDES) this.briefings.set(s, briefing(this.w, s, { roundTicks: this.roundTicks, maxTicks: this.maxTicks }));
  }

  get over(): boolean {
    return this.record.end !== null;
  }

  get lastRound(): number {
    return Math.ceil(this.maxTicks / this.roundTicks);
  }

  seatSpec(side: Faction): SeatSpec {
    return this.seats[side].spec;
  }

  /** Is this agent seat's turn open (it should play this round)? */
  turnOpen(side: Faction): boolean {
    return !this.over && !this.seats[side].ended;
  }

  /** Every seat has ended its turn: the round can be resolved. */
  allEnded(): boolean {
    return SIDES.every((s) => this.seats[s].ended);
  }

  /** Record a seat's model id and settings (the LLM driver sends them). */
  setSeatInfo(side: Faction, info: Partial<SeatInfo>): void {
    Object.assign(this.record.seats[side], info);
  }

  /** Add token usage for a seat's round (the LLM driver sends it). */
  addUsage(side: Faction, u: Partial<Usage>, round?: number): void {
    const t = (this.record.usage[side] ??= { input: 0, cached: 0, output: 0, responses: 0, toolCalls: 0 });
    for (const k of ["input", "cached", "output", "responses", "toolCalls"] as const) t[k] = (t[k] ?? 0) + (u[k] ?? 0);
    if (round !== undefined) {
      const entry = this.record.log.find((l) => l.round === round && l.side === side);
      if (entry) entry.usage = { input: u.input ?? 0, cached: u.cached ?? 0, output: u.output ?? 0, responses: u.responses, toolCalls: u.toolCalls };
    }
  }

  // ------------------------------------------------------------- the tools ---

  briefing(side: Faction): string {
    return this.briefings.get(side)!;
  }

  observe(side: Faction): string {
    const s = this.seats[side];
    if (this.round === 0) {
      const noOpeners = allowedOpener(this.w, side, DEFAULT_OPENER) === null;
      return [
        ...(noOpeners ? [
          `ROUND 0: READY. Openers are disabled by this match's mutators. Call end_round with your plan in the notes; unit orders begin in round 1.`
        ] : [
          `ROUND 0: CHOOSE YOUR OPENER. The battle starts once both sides have picked (the picks are revealed together).`,
          `Pick with orders([{"opener": "blitz"}]) (or "industry", or "airwing"), then end_round with your plan in the notes.${s.opener ? ` You picked ${s.opener}.` : ""}`,
          `Options: ${OPENER_IDS.join(", ")} (details in the briefing). If you don't pick, you get ${DEFAULT_OPENER}.`
        ]),
        "",
        renderObservation(observeState(this.w, side), { round: 0, lastRound: this.lastRound, roundSecs: this.roundTicks / TICK_RATE, notes: s.notes })
      ].join("\n");
    }
    const placeAt = this.placeAtOwn(side);
    return renderObservation(observeState(this.w, side), {
      round: this.round,
      lastRound: this.lastRound,
      roundSecs: this.roundTicks / TICK_RATE,
      placeAt,
      news: s.news,
      results: [...s.lastResults, ...(s.results.length ? ["(this round so far)", ...s.results] : [])],
      notes: s.notes,
      waiting: Math.max(0, s.waitUntil - this.round)
    });
  }

  look(side: Faction, x: number, y: number, r?: number): string {
    return look(this.w, side, x, y, r);
  }

  orders(side: Faction, list: unknown): string {
    const s = this.seats[side];
    if (this.over) return this.result(side);
    if (s.spec.kind === "ai") return "This seat is played by the built-in AI.";
    if (s.ended) return `Your turn for round ${this.round} is over: wait for the next round.`;
    s.staged ??= structuredClone(this.w);
    const batch = parseOrders(s.staged, side, list, this.round === 0 ? "opener" : "play");
    s.commands.push(...batch.commands);
    s.orders.push(...(Array.isArray(list) ? list : [list]));
    // number results across the round's calls
    const base = s.results.length;
    const lines = batch.results.map((r) => r.replace(/^(\d+)\./, (_, n) => `${base + Number(n)}.`));
    s.results.push(...lines);
    if (batch.opener) s.opener = batch.opener;
    if (batch.cancelBuild) s.build = null;
    if (batch.build) s.build = batch.build;
    return lines.join("\n");
  }

  /** End this seat's turn. Notes left out keep the last round's. */
  endRound(side: Faction, notes?: string, radio?: string, how = "end_round"): string {
    const s = this.seats[side];
    if (this.over) return this.result(side);
    if (s.ended) return `Round ${this.round} already ended for you.`;
    if (typeof notes === "string") s.notes = notes.slice(0, NOTES_MAX);
    const line = typeof radio === "string" ? radio.replace(/\s+/g, " ").trim().slice(0, RADIO_MAX) : "";
    if (line) {
      s.radio = line;
      this.record.radio.push([this.w.tick, side, line]);
    }
    s.ended = true;
    s.endedHow = how;
    const cut = typeof notes === "string" && notes.length > NOTES_MAX ? ` (notes cut to ${NOTES_MAX} characters)` : "";
    const opener = allowedOpener(this.w, side, s.opener ?? DEFAULT_OPENER);
    return `Round ${this.round} submitted${cut}. ${this.round === 0 ? opener ? `Opener: ${opener}${s.opener ? "" : " (default)"}.` : "Openers are disabled." : ""}`.trim();
  }

  /** End this turn and skip the next `rounds - 1`, unless something urgent happens. */
  wait(side: Faction, rounds: number, notes?: string): string {
    const n = Math.max(1, Math.min(24, Math.floor(Number(rounds)) || 1));
    const s = this.seats[side];
    if (this.over) return this.result(side);
    if (s.ended) return `Round ${this.round} already ended for you.`;
    s.waitUntil = this.round + n - 1;
    this.endRound(side, notes, undefined, `wait ${n}`);
    return `Waiting ${n} round${n > 1 ? "s" : ""} (until ${clock((this.round + n - 1) * this.roundTicks)}), unless something urgent happens.`;
  }

  status(side: Faction) {
    const s = this.seats[side];
    return {
      side,
      round: this.round,
      tick: this.w.tick,
      time: clock(this.w.tick),
      turnOpen: this.turnOpen(side),
      waiting: Math.max(0, s.waitUntil - this.round),
      over: this.over,
      winner: this.record.end?.winner ?? null,
      reason: this.record.end?.reason ?? null,
      lastRound: this.lastRound
    };
  }

  /** How the battle ended, for this side. */
  result(side: Faction): string {
    const e = this.record.end;
    if (!e) return "The battle is still on.";
    const how =
      e.reason === "hq" ? "the enemy has no HQ or Goliaths left"
      : e.reason === "time" ? `time ran out at ${clock(e.tick)}`
      : e.reason === "love" ? "two Goliaths fell in love"
      : "the battle was stopped";
    const verdict = e.winner === null ? "DRAW" : e.winner === side ? "YOU WON" : "YOU LOST";
    const hq = e.reason === "hq" && e.winner !== side ? "you have no HQ or Goliaths left" : how;
    return `THE BATTLE IS OVER at ${clock(e.tick)}: ${verdict} (${hq}). No more orders are needed.`;
  }

  // -------------------------------------------------------------- the loop ---

  /**
   * Play the round everyone has ended: reveal the openers (round 0), or run
   * the next stretch of ticks. Seats still playing are ended as they stand
   * (a seat that ran out of budget plays the orders it gave).
   */
  resolve(): void {
    if (this.over) return;
    for (const side of SIDES) if (!this.seats[side].ended) this.endRound(side, undefined, undefined, "arena");
    const w = this.w;
    if (this.round === 0) {
      for (const side of SIDES) {
        const s = this.seats[side];
        const pick = s.ai ? pickAiOpener(s.ai.strategy.name, w.seed, side) : s.opener ?? DEFAULT_OPENER;
        const o = allowedOpener(w, side, pick);
        if (o) {
          applyOpener(w, side, o);
          this.record.openers[side] = o;
        }
      }
      tickFog(w);
      this.logRound(0);
    } else {
      const start = w.tick;
      for (let i = 0; i < this.roundTicks && !w.winner && w.tick < this.maxTicks; i++) {
        const all: Command[] = [];
        for (const side of SIDES) {
          const s = this.seats[side];
          const cmds: Command[] = s.ai ? tickAi(w, side, s.ai) : i === 0 ? [...s.commands] : [];
          if (!s.ai) cmds.push(...this.autoPlace(s));
          if (cmds.length) this.record.turns.push([w.tick, side, cmds]);
          all.push(...cmds);
        }
        step(w, all);
        for (const side of SIDES) this.seats[side].log.tick(w);
        if (w.tick % HASH_EVERY === 0) this.record.hashes.push([w.tick, worldHash(w)]);
      }
      this.logRound(start);
      if (w.winner) this.record.end = endOf(w.tick, w.winner, w.resigned);
      else if (w.tick >= this.maxTicks) this.record.end = { tick: w.tick, winner: null, reason: "time" };
    }
    this.record.tick = w.tick;
    if (!this.over) this.open(this.round + 1);
    this.onRound?.(this);
  }

  /** Stop the battle where it stands (a hung seat, Ctrl-C). */
  abort(): void {
    if (this.over) return;
    this.record.end = { tick: this.w.tick, winner: null, reason: "aborted" };
    this.onRound?.(this);
  }

  /** Run rounds while no agent seat has an open turn (AI seats, waits). Returns when someone must play or it's over. */
  advance(): void {
    while (!this.over && this.allEnded()) this.resolve();
  }

  private logRound(tick: number): void {
    for (const side of SIDES) {
      const s = this.seats[side];
      if (s.ai) continue;
      if (s.endedHow !== "waiting") {
        const entry: RoundLog = { round: this.round, tick, side, orders: s.orders, results: s.results, notes: s.notes, ended: s.endedHow };
        if (s.radio) entry.radio = s.radio;
        this.record.log.push(entry);
      }
    }
  }

  /** Start round `r`: open each agent seat's turn, unless it's waiting and nothing urgent happened. */
  private open(r: number): void {
    this.round = r;
    for (const side of SIDES) {
      const s = this.seats[side];
      s.commands = [];
      s.orders = [];
      s.staged = null;
      s.radio = undefined;
      if (s.ai) continue;
      if (s.endedHow !== "waiting") s.lastResults = s.results;
      s.results = [];
      const urgent = [...s.log.urgent];
      if (s.waitUntil >= r && urgent.length === 0) {
        s.ended = true;
        s.endedHow = "waiting";
        continue;
      }
      const cut = s.waitUntil >= r ? `Your wait was cut short: ${urgent.map(urgentText).join(", ")}.` : null;
      s.waitUntil = 0;
      s.ended = false;
      s.endedHow = undefined;
      s.news = s.log.take(this.w);
      if (cut) s.news.unshift(cut);
    }
  }

  /** The building a seat is constructing, placed the tick it's ready: where it asked, else a sensible spot. */
  private autoPlace(s: Seat): Command[] {
    const w = this.w;
    const f = w.factions[s.side];
    if (!f.pending?.ready) return [];
    const kind = f.pending.kind;
    const want = s.build?.kind === kind ? s.build.at : null;
    let spot: [number, number] | null = null;
    const fr = frameOf(w, s.side);
    if (want) {
      const why = placementBlocker(w, s.side, kind, want[0], want[1]);
      if (!why) spot = want;
      else {
        spot = suggestSpot(w, s.side, kind, { x: want[0] + 1, y: want[1] + 1 });
        s.log.say(`Your ${kind} couldn't go at ${fr.topLeft(kind, want[0], want[1]).join(",")} (${why}): placed nearby instead`);
      }
    } else spot = suggestSpot(w, s.side, kind);
    s.build = null;
    if (!spot) {
      s.log.say(`Nowhere to put your ${kind}: construction cancelled and refunded`);
      return [{ type: "cancelBuilding", faction: s.side }];
    }
    return [{ type: "placeBuilding", faction: s.side, tx: spot[0], ty: spot[1] }];
  }

  /** Where the building under construction will go, in the side's frame (if it asked for a spot). */
  private placeAtOwn(side: Faction): [number, number] | null {
    const s = this.seats[side];
    const f = this.w.factions[side];
    if (!f.pending || !s.build?.at || s.build.kind !== f.pending.kind) return null;
    return frameOf(this.w, side).topLeft(f.pending.kind, s.build.at[0], s.build.at[1]);
  }
}

const urgentText = (u: Urgent) => ({ hq: "your HQ is under attack", goliath: "your Goliath is under attack", strike: "an enemy strike was called", inbound: "enemies are near your base" })[u];

export { enemyOf };
