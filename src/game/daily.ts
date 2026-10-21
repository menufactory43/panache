import { STRATEGIES, type StrategyName } from "../sim/ai/commander";
import { mapById } from "../sim/maps";
import { hash32, saltOf } from "../sim/rand";
import { MUTATOR_IDS, makeRules, mutatorsCompatible, strategyFits, type MutatorId } from "../sim/rules";

/**
 * The Daily Op: one seeded skirmish per calendar day, identical for every
 * player — map, AI personality, Normal or Hard, two compatible mutators and
 * the match seed all come from a hash of the date. Pure (no DOM), tested.
 */

export interface DailyOp {
  /** Days since 1970-01-01 of the local calendar date (the streak's unit). */
  day: number;
  /** Op number, #1 on 2026-01-01. */
  number: number;
  /** "Wed 7 Oct" */
  label: string;
  mapId: string;
  strategy: StrategyName;
  difficulty: "normal" | "hard";
  mutators: MutatorId[];
  /** World seed and AI tie-break seed (same for everyone). */
  seed: number;
}

const MS_DAY = 86_400_000;
const EPOCH_DAY = Date.UTC(2026, 0, 1) / MS_DAY;
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** The local calendar date as a day index (so "today" flips at local midnight). */
export function dayIndexOf(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_DAY);
}

export const today = (): number => dayIndexOf(new Date());

export function dayLabel(day: number): string {
  const d = new Date(day * MS_DAY);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The maps a Daily Op can land on, in a frozen order: the op is a hash of the
 * date into this list, so reordering the map picker or adding a map must not
 * change which map any past or future day gets. Maps added later stay out
 * unless they suit any random mutator pair (Air War bans the Condor).
 */
export const DAILY_MAPS = ["riverlands", "dune-sea", "frostbite", "ashlands", "proving-grounds"] as const;

/**
 * The mutators a Daily Op draws its pair from, frozen like DAILY_MAPS: the
 * pair is a hash of the date into this list, so adding a mutator to the game
 * must not change any day's op. (Nomads, Robot Love and Goliath Armada came
 * later, and stay out: they are menu picks.)
 */
export const DAILY_MUTATORS: readonly MutatorId[] = [
  "blitz", "goldrush", "glass", "rapidfab", "airwar", "infantrywar", "airborne", "veterans", "clearskies"
];

const STRATEGY_NAMES = Object.keys(STRATEGIES) as StrategyName[];
const FALLBACK: MutatorId[] = ["blitz", "glass"];

/** Is this op playable as designed? (Mutators work together and the AI plan survives them.) */
export function dailyCompatible(strategy: StrategyName, mutators: readonly MutatorId[]): boolean {
  if (mutators.length !== 2 || mutators[0] === mutators[1]) return false;
  return mutatorsCompatible(mutators) && strategyFits(STRATEGIES[strategy], makeRules(mutators));
}

export function dailyOp(day: number): DailyOp {
  const h = (salt: string, ...k: number[]) => hash32(day, saltOf(salt), ...k);
  const map = mapById(DAILY_MAPS[h("map") % DAILY_MAPS.length]!);
  const strategy = STRATEGY_NAMES[h("ai") % STRATEGY_NAMES.length]!;
  const difficulty = h("diff") % 3 === 0 ? "hard" : "normal";
  let mutators = FALLBACK;
  for (let attempt = 0; attempt < 64; attempt++) {
    const a = DAILY_MUTATORS[h("mut-a", attempt) % DAILY_MUTATORS.length]!;
    const b = DAILY_MUTATORS[h("mut-b", attempt) % DAILY_MUTATORS.length]!;
    // canonical order, so the card reads the same way the rules list them
    const pair = MUTATOR_IDS.filter((id) => id === a || id === b);
    if (dailyCompatible(strategy, pair)) {
      mutators = pair;
      break;
    }
  }
  return {
    day,
    number: day - EPOCH_DAY + 1,
    label: dayLabel(day),
    mapId: map.id,
    strategy,
    difficulty,
    mutators,
    seed: h("seed") & 0x7fffffff
  };
}
