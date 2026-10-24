import type { Difficulty } from "../sim/ai/commander";
import { isKnownMapId, mapBansMutator, mapById, type MatchOptions } from "../sim/maps";
import { isRandomMapId } from "../sim/mapgen";
import { isMutatorId, parseNations, type MutatorId } from "../sim/rules";
import { OP_LEVEL_IDS, opById, opHasLevel, type OpDef, type OpLevel } from "../sim/ops";
import type { Faction, Nation, NationOrClassic } from "../sim/types";
import { PLAYER, setLocalSide } from "./controller";
import type { DailyOp } from "./daily";

/** Skirmish (vs an AI commander), Last Stand (survive endless waves) or the Ops campaign. */
export type GameType = "skirmish" | "survival" | "ops";

/** Match settings, chosen on the menu before the game boots. */
export const gameMode = {
  /** AI vs AI: both factions computer-controlled, player just watches. */
  spectator: false,
  mapId: "riverlands",
  difficulty: "normal" as Difficulty,
  mode: "skirmish" as GameType,
  /** Skirmish mutators picked on the menu (saved with the settings). */
  mutators: [] as MutatorId[],
  /** Set while playing the Daily Op (never saved: it overrides map, difficulty and mutators). */
  daily: null as DailyOp | null,
  /** Set while playing an op (never saved: the op fixes map, enemy and rules). */
  op: null as OpDef | null,
  /** The op card picked on the menu (saved). */
  opId: "",
  /** The campaign's level, picked on a mission's briefing (saved): Recrue, Normal or Vétéran. */
  opLevel: "normal" as OpLevel,
  /**
   * Uncharted (saved): a generated map is played blind — no thumbnail, name
   * or preview on the menu, and nothing of it shows in the match until it's
   * scouted. Render/UI only: the sim and replays don't change.
   */
  uncharted: false,
  /**
   * The player's nation in skirmish (saved; PANACHE-CONCEPTION.md §1.10):
   * "classique" plays today's symmetric rules; a nation gives the AI the
   * other one. `?nations=` in the URL wins.
   */
  nation: "classique" as NationOrClassic,
  /**
   * The AI's nation when the player has one (saved): the other nation
   * (default), one rolled at random for each match, or the player's own (a
   * mirror).
   */
  rival: "opposite" as RivalPick
};

/** How the skirmish AI's nation is picked from the player's. */
export type RivalPick = "opposite" | "random" | "same";
export const RIVAL_PICKS: readonly RivalPick[] = ["opposite", "random", "same"];

/**
 * Set by duelSetup: a duel plays the nations its lobby agreed (LOBBY_PROTO 2,
 * versus/pairing.ts), never the menu's pick; null: Classique. (The match's
 * world is the feed's, built from the agreed setup: this keeps matchOptions
 * telling the same.)
 */
let duelMatch: { nations: Partial<Record<Faction, Nation>> | null } | null = null;
/** Is the coming (or running) match a duel? */
export const isDuelMatch = (): boolean => duelMatch !== null;

/** Is the coming match on a generated map played Uncharted (not when watching AI vs AI, an op or the Daily)? */
export const unchartedMatch = (): boolean =>
  gameMode.uncharted && isRandomMapId(gameMode.mapId) && !gameMode.spectator && !gameMode.op && !gameMode.daily;

/**
 * The mutators the next match runs with (Last Stand runs classic rules),
 * leaving out any the map can't be played with (Air War on the
 * Archipelago): the saved pick stays, for the next map that allows it.
 */
export function activeMutators(): MutatorId[] {
  if (gameMode.op) return []; // an op brings its own rules
  if (gameMode.daily) return gameMode.daily.mutators;
  if (gameMode.mode !== "skirmish") return [];
  const def = mapById(gameMode.mapId);
  return gameMode.mutators.filter((id) => !mapBansMutator(def, id));
}

/**
 * Point the coming match at a duel's agreed one (DUEL.md "Getting
 * into a duel"): its map (a MAPS id, or a generated map's id) and mutators, a
 * plain skirmish played by this phone as `local`, so startGame loads the art
 * for the map both phones play. Never saved: the menu's own picks stay.
 */
export function duelSetup(cfg: { mapId: string; mutators: MutatorId[]; local: Faction; nations?: Partial<Record<Faction, Nation>> }): void {
  gameMode.mapId = cfg.mapId;
  gameMode.mode = "skirmish";
  gameMode.mutators = cfg.mutators.slice();
  gameMode.spectator = false;
  gameMode.daily = null;
  gameMode.op = null;
  gameMode.uncharted = false;
  duelMatch = { nations: cfg.nations ? { ...cfg.nations } : null };
  setLocalSide(cfg.local);
}

/**
 * What the end screen's Rematch stores, so the reload replays the same kind of
 * match: "op:<id>", "daily", "spectate" (another AI-vs-AI match) or "1" (a
 * skirmish or Last Stand with the menu's picks). A watched Last Stand hands
 * over to the player ("▶ Your turn"), so it rematches as "1".
 */
export const rematchToken = (): string =>
  gameMode.op
    ? `op:${gameMode.op.id}`
    : gameMode.daily
      ? "daily"
      : gameMode.spectator && gameMode.mode !== "survival"
        ? "spectate"
        : "1";

/**
 * The sim setup for the next match, built from the menu choices. A fresh
 * random seed per match (render side, so Math.random is fine here) keeps
 * seeded events varied while each match stays internally deterministic.
 * Skirmishes play with the map objectives (Uplinks, supply drops).
 */
export function matchOptions(): MatchOptions {
  if (gameMode.op)
    return {
      seed: (Math.random() * 0x7fffffff) | 0,
      op: gameMode.op.id,
      ...(opHasLevel(gameMode.op) && gameMode.opLevel !== "normal" ? { opLevel: gameMode.opLevel } : {})
    };
  const mutators = activeMutators();
  const survival = gameMode.mode === "survival";
  // (once: a random rival is rolled here)
  const picked = matchNationsPick();
  return {
    seed: (Math.random() * 0x7fffffff) | 0,
    // Uplinks and supply drops: skirmish (and the Daily Op); Last Stand has its waves
    ...(survival ? { survival: { difficulty: gameMode.difficulty } } : { objectives: true }),
    // mutators, and the Daily Op's date seed (everyone plays the same match)
    ...(mutators.length ? { mutators } : {}),
    ...(gameMode.daily ? { seed: gameMode.daily.seed } : {}),
    // nations (PANACHE-CONCEPTION.md §1.10): skirmish only (the URL's, or the menu's pick)
    ...(duelMatch
      ? duelMatch.nations ? { nations: { ...duelMatch.nations } } : {}
      : !survival && !gameMode.daily && picked ? { nations: picked } : {})
  };
}

/** The other nation (the AI's, facing the player's). */
export const rivalNation = (n: Nation): Nation => (n === "republique" ? "empire" : "republique");

/**
 * The nations of the coming skirmish, by seat: `?nations=` if given, else the
 * menu's pick for the player's seat and the other nation for the AI's.
 * Null: Classique.
 */
export function matchNationsPick(): Record<Faction, Nation> | null {
  const url = urlNations();
  if (url) return url;
  const n = gameMode.nation;
  if (n === "classique") return null;
  const other: Faction = PLAYER === "blue" ? "red" : "blue";
  return { [PLAYER]: n, [other]: rivalFor(n, gameMode.rival) } as Record<Faction, Nation>;
}

/** The AI's nation facing `n` under a rival pick ("random": a fresh roll, render side, so Math.random is fine). */
export function rivalFor(n: Nation, pick: RivalPick, random: () => number = Math.random): Nation {
  if (pick === "same") return n;
  if (pick === "random") return random() < 0.5 ? "republique" : "empire";
  return rivalNation(n);
}

/**
 * Development path to the nations before their picker exists:
 * `?nations=republique,empire` (blue's, then red's; `rep,emp` will do) plays
 * the next skirmishes with those rosters. Absent or malformed: Classique.
 */
export function urlNations(): Record<Faction, Nation> | null {
  return typeof location === "undefined" ? null : parseNations(new URLSearchParams(location.search).get("nations"));
}

const KEY = "battledrones.settings";

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as Partial<typeof gameMode>;
    // (a map this build doesn't have, or a malformed random id: back to the default)
    gameMode.mapId = typeof s.mapId === "string" && isKnownMapId(s.mapId) ? s.mapId : "riverlands";
    if (s.difficulty === "easy" || s.difficulty === "normal" || s.difficulty === "hard")
      gameMode.difficulty = s.difficulty;
    if (s.mode === "skirmish" || s.mode === "survival" || s.mode === "ops") gameMode.mode = s.mode;
    if (typeof s.opId === "string" && opById(s.opId)) gameMode.opId = s.opId;
    if (OP_LEVEL_IDS.includes(s.opLevel as OpLevel)) gameMode.opLevel = s.opLevel!;
    if (Array.isArray(s.mutators)) gameMode.mutators = s.mutators.filter(isMutatorId);
    gameMode.uncharted = s.uncharted === true;
    if (s.nation === "classique" || s.nation === "republique" || s.nation === "empire") gameMode.nation = s.nation;
    if (RIVAL_PICKS.includes(s.rival as RivalPick)) gameMode.rival = s.rival!;
  } catch {
    /* storage unavailable — defaults are fine */
  }
}

/**
 * Save the menu's mode pick from outside the menu (the Instruction's end
 * screen: "⚔ Escarmouche", "🎖 Opérations"), keeping every other saved pick.
 * `easyFirst`: a player with no saved difficulty starts on Easy.
 */
export function pickMode(mode: GameType, easyFirst = false): void {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    s.mode = mode;
    if (easyFirst && !s.difficulty) s.difficulty = "easy";
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Save the campaign's level from the briefing sheet (an op is not running yet: keeps every other saved pick). */
export function pickOpLevel(level: OpLevel): void {
  gameMode.opLevel = level;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    s.opLevel = level;
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function saveSettings(): void {
  if (gameMode.daily || gameMode.op) return; // the Daily Op's / an op's map and difficulty are not the player's picks
  try {
    localStorage.setItem(KEY, JSON.stringify({ mapId: gameMode.mapId, difficulty: gameMode.difficulty, mode: gameMode.mode, mutators: gameMode.mutators, opId: gameMode.opId, opLevel: gameMode.opLevel, uncharted: gameMode.uncharted, nation: gameMode.nation, rival: gameMode.rival }));
  } catch {
    /* ignore */
  }
}
