/**
 * Game Center, in the iPhone app (native/game-center): the player is signed
 * in at boot, and the achievements are worked out from what the game already
 * keeps (the career, the two lessons, the duel record), so they catch up on
 * whatever was earned before Game Center existed, or on another device (the
 * cloud save). Everything is sent each time; the plugin skips what Game
 * Center already holds. Three leaderboards: Last Stand waves, career XP and
 * the best Éclair score. Nothing at all happens in a browser.
 *
 * The ids below are the ones created in App Store Connect
 * (tools/game-center.mjs), with the hyphens as underscores (Apple allows
 * letters, digits, "_" and "."): change one here, change it there.
 */
import { GameCenter } from "panache-game-center";
import { isApp } from "../native";
import { MEDAL_IDS } from "../sim/awards";
import { CAMPAIGN, TRIALS } from "../sim/ops";
import { RANKS, campaignCompleted, loadCareer, opCleared, starCount, type CareerData, type Settlement } from "./career";
import { tutorial2Done, tutorialState } from "./tutorial";
import type { DuelTally, ONLINE_RECORD_KEY } from "../versus/records";

export const LEADERBOARDS = {
  survival: "panache.survie",
  xp: "panache.carriere",
  eclair: "panache.eclair"
} as const;

/** What the achievements read: the career and the few things kept beside it. */
export interface Progress {
  career: CareerData;
  lesson1: boolean;
  lesson2: boolean;
  duelWins: number;
}

const act = (c: CareerData, n: 1 | 2 | 3): number => {
  const ops = CAMPAIGN.filter((o) => o.act === n);
  return (100 * ops.filter((o) => opCleared(c.ops[o.id])).length) / ops.length;
};
const upTo = (have: number, need: number): number => (100 * Math.min(have, need)) / need;

/** Each achievement's id and how far along it is (0–100). */
export function achievementsOf(p: Progress): { id: string; percent: number }[] {
  const c = p.career;
  const campaignStars = CAMPAIGN.reduce((s, o) => s + starCount(c.ops[o.id]?.stars ?? 0), 0);
  const hardWins = Object.entries(c.records).reduce((s, [k, r]) => s + (k.endsWith(":hard") ? r.w : 0), 0);
  const medalKinds = MEDAL_IDS.filter((m) => (c.medals[m] ?? 0) > 0).length;
  const list: [string, number][] = [
    ["premier-jour", p.lesson1 ? 100 : 0],
    ["deuxieme-jour", p.lesson2 ? 100 : 0],
    ["premiere-victoire", c.wins > 0 ? 100 : 0],
    ["acte-1", act(c, 1)],
    ["acte-2", act(c, 2)],
    ["acte-3", campaignCompleted(c) === CAMPAIGN.length ? 100 : act(c, 3)],
    ["trente-six-etoiles", upTo(campaignStars, CAMPAIGN.length * 3)],
    ["epreuves", upTo(TRIALS.filter((o) => opCleared(c.ops[o.id])).length, TRIALS.length)],
    ["difficile", hardWins > 0 ? 100 : 0],
    ["vingt-cinq-victoires", upTo(c.wins, 25)],
    ["lieutenant", upTo(c.xp, RANKS[4]!.xp)],
    ["colonel", upTo(c.xp, RANKS[7]!.xp)],
    ["marechal", upTo(c.xp, RANKS[9]!.xp)],
    ["resistant", upTo(c.laststand.best, 10)],
    ["inebranlable", upTo(c.laststand.best, 20)],
    ["dix-medailles", upTo(medalKinds, 10)],
    ["tueur-de-gargantua", (c.medals["goliath-slayer"] ?? 0) > 0 ? 100 : 0],
    ["voyage-dans-la-lune", (c.medals.orbital ?? 0) > 0 ? 100 : 0],
    ["sept-jours", upTo(c.daily.bestStreak, 7)],
    ["duel", p.duelWins > 0 ? 100 : 0]
  ];
  return list.filter(([, pc]) => pc > 0).map(([id, percent]) => ({ id: `panache.${id.replaceAll("-", "_")}`, percent: Math.round(percent * 100) / 100 }));
}

/** The duel's record (versus/records.ts, which src/game may not import: the duel loads apart). */
const DUEL_KEY: typeof ONLINE_RECORD_KEY = "panache.duelenligne";

function duelWins(): number {
  try {
    const t = JSON.parse(localStorage.getItem(DUEL_KEY) ?? "null") as Partial<DuelTally> | null;
    return typeof t?.w === "number" && Number.isFinite(t.w) ? t.w : 0;
  } catch {
    return 0;
  }
}

function progress(): Progress {
  return { career: loadCareer(), lesson1: tutorialState() === "done", lesson2: tutorial2Done(), duelWins: duelWins() };
}

let signedIn = false;
let started: Promise<boolean> | null = null;

/** Sign in (once per launch), then catch up on achievements and scores. */
export function startGameCenter(): Promise<boolean> {
  if (!isApp) return Promise.resolve(false);
  started ??= GameCenter.authenticate()
    .then((r) => {
      signedIn = r.signedIn;
      if (signedIn) syncGameCenter();
      return signedIn;
    })
    .catch(() => false);
  return started;
}

/** Send what the career says now (after a match, a lesson, a cloud save that came in, a return to the app). */
export function syncGameCenter(): void {
  if (!signedIn) return;
  const p = progress();
  void GameCenter.reportAchievements({ achievements: achievementsOf(p) }).catch(() => undefined);
  if (p.career.laststand.best > 0) score(LEADERBOARDS.survival, p.career.laststand.best);
  if (p.career.xp > 0) score(LEADERBOARDS.xp, p.career.xp);
}

function score(leaderboard: string, value: number): void {
  void GameCenter.submitScore({ leaderboard, score: Math.round(value) }).catch(() => undefined);
}

/** A match just banked in the career: the achievements, and Éclair's points when it was won. */
export function gameCenterAfterMatch(s: Settlement, eclairPoints: number | null): void {
  if (!signedIn) return;
  syncGameCenter();
  if (eclairPoints !== null && s.result.won && s.result.mutators.includes("eclair")) {
    void GameCenter.reportAchievements({ achievements: [{ id: "panache.eclair_gagne", percent: 100 }] }).catch(() => undefined);
    if (eclairPoints > 0) score(LEADERBOARDS.eclair, eclairPoints);
  }
}

/** Game Center's own screen (the Career sheet's button); false when the player isn't signed in. */
export async function showGameCenter(leaderboard?: string): Promise<boolean> {
  if (!(await startGameCenter())) return false;
  try {
    await GameCenter.show(leaderboard ? { leaderboard } : {});
    return true;
  } catch {
    return false;
  }
}

export const gameCenterAvailable = (): boolean => isApp;
