/**
 * Picking up a match where the phone left it (a closed app, a page iOS
 * dropped from memory): the single-player match in progress is kept as a
 * journal, and the next launch offers « Reprendre la partie ».
 *
 * The sim is deterministic and draws nothing at random once the match is
 * set up, so the journal is small: what the setup rolled (the world's
 * options, the AI's personality and tie-break seed), the opener picks, and
 * the player's own commands tick by tick. Resuming builds the same match and
 * steps it, the AI thinking afresh, to the tick the journal reached; world
 * hashes taken on the way (`checks`) catch a match that doesn't replay
 * (another build, a bug) and drop it instead of handing over a different
 * battle.
 *
 * Kept: skirmish, the Daily Op, ops and the campaign, Last Stand. Never: a
 * duel (the friend can't wait), AI vs AI, a replay, the Instruction.
 * Engine-free (tests/resume.test.ts): the store is injectable.
 */
import type { Difficulty, PersonalityName } from "../sim/ai/commander";
import type { MatchOptions } from "../sim/maps";
import type { OpenerId } from "../sim/openers";
import type { Command, Faction, NationOrClassic } from "../sim/types";
import type { DailyOp } from "./daily";
import type { GameType, RivalPick } from "./mode";
import type { MutatorId } from "../sim/rules";

export const RESUME_KEY = "panache.resume";

export const RESUME = {
  /** A world hash goes into the journal this often (ticks): resuming checks it got the same world. */
  checkEvery: 600,
  /** The journal is written at most this often while playing (ms), and whenever the app leaves the foreground. */
  saveEveryMs: 10_000,
  /** A journal older than this is dropped (ms): nobody remembers last week's battle. */
  maxAgeMs: 3 * 24 * 3600_000,
  /** Ticks stepped per slice while resuming, between two paints of the progress bar. */
  slice: 300
} as const;

/** The menu's settings the match was started with (gameMode, op by id). */
export interface ResumeMode {
  mapId: string;
  difficulty: Difficulty;
  mode: GameType;
  mutators: MutatorId[];
  nation: NationOrClassic;
  rival: RivalPick;
  uncharted: boolean;
  opId: string | null;
  daily: DailyOp | null;
}

export interface ResumeJournal {
  v: 1;
  /** The build's sim hash (match-record.ts BUILD_SIM_HASH): another build may not replay it. */
  sim: string | null;
  /** When it was last written (ms since 1970). */
  saved: number;
  side: Faction;
  mode: ResumeMode;
  /** The world's options as rolled (seed, rival nation). */
  opts: MatchOptions;
  /** The enemy commander as rolled (null: Last Stand's waves). */
  ai: { strategy: PersonalityName; difficulty: Difficulty; seed: number } | null;
  /** The opener picks applied at the start (null: none, as in an op). */
  openers: Partial<Record<Faction, OpenerId>> | null;
  /** The player's commands, by the tick they were stepped on. */
  cmds: [number, Command[]][];
  /** World hashes after stepping these ticks. */
  checks: [number, string][];
  /** The tick the match had reached. */
  tick: number;
  /** What the menu card says: "Escarmouche · Terres fluviales". */
  label: string;
}

/** JSON that keeps NaN and ±Infinity (a command carrying one must replay as it played, not as null). */
const keepNumbers = (_k: string, v: unknown): unknown => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v);
const readNumbers = (_k: string, v: unknown): unknown =>
  v && typeof v === "object" && "$num" in v && Object.keys(v).length === 1 ? Number((v as { $num: string }).$num) : v;

export interface ResumeStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function browserStore(): ResumeStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The journal of an interrupted match this build can resume, or null (a stale or foreign one is removed). */
export function loadResume(sim: string | null, now = Date.now(), store: ResumeStore | null = browserStore()): ResumeJournal | null {
  if (!store) return null;
  let j: ResumeJournal;
  try {
    const raw = store.getItem(RESUME_KEY);
    if (!raw) return null;
    j = JSON.parse(raw, readNumbers) as ResumeJournal;
  } catch {
    clearResume(store);
    return null;
  }
  const ok = j?.v === 1 && j.sim === sim && typeof j.tick === "number" && j.tick > 0 && Array.isArray(j.cmds) && now - j.saved < RESUME.maxAgeMs;
  if (!ok) {
    clearResume(store);
    return null;
  }
  return j;
}

export function clearResume(store: ResumeStore | null = browserStore()): void {
  try {
    store?.removeItem(RESUME_KEY);
  } catch {
    /* nothing kept */
  }
}

/** The player left the match for the menu: no journal is written any more on this page, and the kept one goes. */
let abandoned = false;
export function abandonMatch(store: ResumeStore | null = browserStore()): void {
  abandoned = true;
  clearResume(store);
}

/** The match being played, written down as it goes. */
export class ResumeWriter {
  private j: ResumeJournal;
  private lastSave = -Infinity;
  private dirty = false;
  /** Stopped (the match ended, or the player left it): nothing is written any more. */
  private closed = false;

  constructor(start: Omit<ResumeJournal, "v" | "saved" | "cmds" | "checks" | "tick" | "openers"> & Partial<Pick<ResumeJournal, "cmds" | "checks" | "tick" | "openers">>, private store: ResumeStore | null = browserStore()) {
    this.j = { v: 1, saved: 0, openers: null, cmds: [], checks: [], tick: 0, ...start };
  }

  get journal(): Readonly<ResumeJournal> {
    return this.j;
  }

  opened(picks: Partial<Record<Faction, OpenerId>>): void {
    this.j.openers = { ...picks };
    this.dirty = true;
  }

  /** The player's commands stepped on `tick` (before stepping it). */
  step(tick: number, mine: readonly Command[]): void {
    if (mine.length) this.j.cmds.push([tick, mine.map((c) => structuredClone(c))]);
  }

  /** The world after stepping: its tick, and a hash every RESUME.checkEvery ticks. */
  stepped(tick: number, hash: () => string): void {
    this.j.tick = tick;
    this.dirty = true;
    if (tick % RESUME.checkEvery === 0) this.j.checks.push([tick, hash()]);
  }

  /** Write the journal if it changed and `force` or the last write is old enough. */
  save(now: number, force = false): void {
    if (this.closed || abandoned || !this.dirty || !this.store || this.j.tick === 0) return;
    if (!force && now - this.lastSave < RESUME.saveEveryMs) return;
    this.lastSave = now;
    this.dirty = false;
    this.j.saved = Date.now();
    try {
      this.store.setItem(RESUME_KEY, JSON.stringify(this.j, keepNumbers));
    } catch {
      /* full or blocked: this match won't be resumable */
    }
  }

  /** The match is over (or abandoned): forget it. */
  close(): void {
    this.closed = true;
    clearResume(this.store);
  }
}

/** The player's commands of a journal, by tick. */
export function commandsByTick(j: ResumeJournal): Map<number, Command[]> {
  const m = new Map<number, Command[]>();
  for (const [t, cmds] of j.cmds) m.set(t, [...(m.get(t) ?? []), ...cmds]);
  return m;
}

/** The journal the next match resumes (main.ts sets it, GameScene takes it). */
let pending: ResumeJournal | null = null;
export const setPendingResume = (j: ResumeJournal | null): void => void (pending = j);
export function takePendingResume(): ResumeJournal | null {
  const j = pending;
  pending = null;
  return j;
}
