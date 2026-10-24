import { DIFFICULTY, STRATEGIES, type AiState, type Difficulty, type StrategyName } from "../sim/ai/commander";
import { opAiState } from "../sim/ops";
import { MUTATORS, makeRules, rulesOf, strategyFits } from "../sim/rules";
import type { Faction, World } from "../sim/types";
import { announce } from "./announce";
import { settleMatch, type Settlement } from "./career";
import { matchKind, track } from "./stats";
import { activeMutators, gameMode } from "./mode";
import { tr } from "../lang";
import { scheduleSync } from "./account";

/**
 * Glue between the match and the meta layer (mutators, Daily Op, career):
 * the AI personality the rules allow, the opening rules banner, and banking
 * the result when the HQ falls. Kept out of GameScene so it stays a few hooks.
 */

/**
 * The AI personality for a commander: the Daily Op's, or (with mutators on)
 * a random one from the difficulty's pool whose plan survives the rules.
 * Undefined = let createAiState pick as usual.
 */
export function aiStrategy(difficulty: Difficulty): StrategyName | undefined {
  if (gameMode.daily) return gameMode.daily.strategy;
  const muts = activeMutators();
  if (muts.length === 0) return undefined;
  const rules = makeRules(muts);
  const pool = DIFFICULTY[difficulty].pool.filter((n) => strategyFits(STRATEGIES[n], rules));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "balanced";
}

/** Seed for the AI's tie-breaks: the Daily Op's (same match for everyone) or random. */
export const aiSeed = (salt: number): number =>
  gameMode.daily ? (gameMode.daily.seed + salt) | 0 : (Math.random() * 1e9) | 0;

/** "💥 Glass Cannons · ⚡ Blitz" for the active rules ("" if classic). */
export function mutatorLine(w: World, sep = " · "): string {
  return rulesOf(w)
    .mutators.map((id) => `${MUTATORS[id].icon} ${MUTATORS[id].name}`)
    .join(sep);
}

/** An op's enemy commander (null outside ops, or when the op has none: waves or no enemy). */
export const opEnemyAi = (): AiState | null => (gameMode.op ? opAiState(gameMode.op, aiSeed(1)) : null);

/** Opening banner naming the Daily Op and/or the mutators in play. */
export function announceRules(w: World): void {
  if (w.ops) return; // an op opens with its own briefing banner (game/ops.ts)
  const line = mutatorLine(w);
  const d = gameMode.daily;
  if (!line && !d) return;
  announce({
    key: "match-rules",
    text: d ? tr(`Op du jour n°${d.number}`, `Daily Op #${d.number}`) : tr("Mutateurs actifs", "Mutators active"),
    sub: line,
    tone: "info",
    priority: 1
  });
}

/** The worlds whose end was counted (game/stats.ts). */
const counted = new WeakSet<World>();

/** Bank the finished match in the career (spectators never do). */
export function settleCareer(w: World, pov: Faction): Settlement | null {
  if (gameMode.spectator) return null;
  const d = gameMode.daily;
  // (once per world, as the career: the end screen asks again)
  if (!counted.has(w)) {
    counted.add(w);
    const issue = w.survival && !w.ops ? "" : w.winner === pov ? ":victoire" : w.winner === "draw" ? ":nul" : ":defaite";
    track(`fin:${matchKind()}${issue}`);
  }
  scheduleSync(); // (the career is written just below; the Last Stand records alongside)
  return settleMatch(w, {
    pov,
    difficulty: w.survival?.difficulty ?? gameMode.difficulty,
    daily: d ? { day: d.day, number: d.number } : null
  });
}
