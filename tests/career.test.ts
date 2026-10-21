import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRATEGIES, type StrategyName } from "../src/sim/ai/commander";
import { AWARDS, MEDALS, MEDAL_IDS, computeMedals, wasBehind, type MatchRecap, type RecapDeath } from "../src/sim/awards";
import { createMapWorld } from "../src/sim/maps";
import { makeRules, strategyFits, type MutatorId } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { FactionStats } from "../src/sim/types";
import { hqOf } from "../src/sim/world";
import {
  RANKS,
  XP,
  applyResult,
  currentStreak,
  emptyCareer,
  loadCareer,
  rankOf,
  saveCareer,
  settleMatch,
  starCount,
  starsFor,
  xpLines,
  type MatchResult
} from "../src/game/career";
import { chronicleOf } from "../src/game/chronicle";
import { DAILY_MAPS, dailyCompatible, dailyOp, dayIndexOf, dayLabel } from "../src/game/daily";

const stats = (o: Partial<FactionStats> = {}): FactionStats => ({
  unitsBuilt: 10, unitsLost: 10, unitsKilled: 10, buildingsLost: 1, buildingsKilled: 2, scrapHarvested: 4000, scrapSalvaged: 0, ...o
});

const recap = (o: Partial<MatchRecap> = {}): MatchRecap => ({
  pov: "blue",
  won: true,
  secs: 9 * 60,
  stats: { blue: stats(), red: stats() },
  samples: [],
  deaths: [],
  bestUnitKills: 3,
  ...o
});

const kills = (n: number, d: Partial<RecapDeath>): RecapDeath[] =>
  Array.from({ length: n }, (_, i) => ({ t: i, faction: "red", unitKind: "stinger", buildingKind: null, byBuilding: false, ...d }));

describe("medals", () => {
  it("an ordinary long win earns nothing special", () => {
    expect(computeMedals(recap())).toEqual([]);
  });

  it("victory medals need the win", () => {
    const fast = recap({ secs: AWARDS.lightningSecs - 1, stats: { blue: stats({ buildingsLost: 0, unitsLost: 2 }), red: stats() } });
    expect(computeMedals(fast)).toEqual(["lightning", "untouchable", "flawless"]);
    expect(computeMedals({ ...fast, won: false })).toEqual([]);
    expect(computeMedals(recap({ secs: AWARDS.lightningSecs }))).not.toContain("lightning");
  });

  it("Comeback: won after the army fell to half of theirs, after the opening", () => {
    const behind = [{ t: 200, army: { blue: 400, red: 1400 } }];
    expect(wasBehind(recap({ samples: behind }))).toBe(true);
    expect(computeMedals(recap({ samples: behind }))).toContain("comeback");
    // too early, or too small a gap, doesn't count
    expect(wasBehind(recap({ samples: [{ t: 30, army: { blue: 0, red: 1400 } }] }))).toBe(false);
    expect(wasBehind(recap({ samples: [{ t: 200, army: { blue: 100, red: 600 } }] }))).toBe(false);
    // red's point of view of the same timeline: never behind
    expect(wasBehind(recap({ pov: "red", samples: behind }))).toBe(false);
  });

  it("Tycoon needs twice the enemy's harvest and a real economy", () => {
    const rich = recap({ stats: { blue: stats({ scrapHarvested: 8000 }), red: stats({ scrapHarvested: 4000 }) } });
    expect(computeMedals(rich)).toContain("tycoon");
    const tiny = recap({ stats: { blue: stats({ scrapHarvested: 2000 }), red: stats({ scrapHarvested: 100 }) } });
    expect(computeMedals(tiny)).not.toContain("tycoon");
  });

  it("feats of arms count in defeat too", () => {
    const r = recap({
      won: false,
      bestUnitKills: AWARDS.aceKills,
      stats: { blue: stats({ unitsKilled: AWARDS.exterminatorKills, buildingsKilled: AWARDS.wreckingBuildings }), red: stats() },
      deaths: [
        ...kills(AWARDS.giantMastodons, { unitKind: "mastodon" }),
        ...kills(AWARDS.airKills, { unitKind: "wasp" }),
        ...kills(AWARDS.wallKills, { byBuilding: true })
      ]
    });
    expect(computeMedals(r)).toEqual(["ace", "giant-slayer", "air-superiority", "iron-wall", "exterminator", "wrecking-crew"]);
  });

  it("only the enemy's losses count toward kill medals", () => {
    const own = recap({ deaths: kills(40, { faction: "blue", unitKind: "mastodon", byBuilding: true }) });
    expect(computeMedals(own)).toEqual([]);
  });

  it("Last Stand medals come from waves survived", () => {
    expect(computeMedals(recap({ waves: 9 }))).toEqual([]);
    expect(computeMedals(recap({ waves: AWARDS.holdoutWaves }))).toEqual(["holdout"]);
    expect(computeMedals(recap({ waves: AWARDS.unbreakableWaves, won: false }))).toEqual(["holdout", "unbreakable"]);
  });

  it("every medal has a name, icon and description", () => {
    for (const id of MEDAL_IDS) {
      expect(MEDALS[id].id).toBe(id);
      expect(MEDALS[id].name).toBeTruthy();
      expect(MEDALS[id].desc).toBeTruthy();
    }
  });
});

describe("ranks and XP", () => {
  it("ten ranks from Cadet to Marshal with rising thresholds", () => {
    expect(RANKS).toHaveLength(10);
    expect(RANKS[0]!.name).toBe("Cadet");
    expect(RANKS[9]!.name).toBe("Maréchal");
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i]!.xp).toBeGreaterThan(RANKS[i - 1]!.xp);
      // each step is at least as long as the one before
      if (i > 1) expect(RANKS[i]!.xp - RANKS[i - 1]!.xp).toBeGreaterThanOrEqual(RANKS[i - 1]!.xp - RANKS[i - 2]!.xp);
    }
  });

  it("rankOf finds the rank, the next one and the progress", () => {
    expect(rankOf(0)).toMatchObject({ index: 0, name: "Cadet", next: 100, nextName: "Soldat", progress: 0 });
    expect(rankOf(99).index).toBe(0);
    expect(rankOf(100)).toMatchObject({ index: 1, name: "Soldat", floor: 100, next: 300 });
    expect(rankOf(200).progress).toBeCloseTo(0.5);
    expect(rankOf(1_000_000)).toMatchObject({ index: 9, name: "Maréchal", next: null, nextName: null, progress: 1 });
  });

  const base: MatchResult = {
    kind: "skirmish", mapId: "riverlands", difficulty: "normal", won: true, secs: 400, buildingsLost: 2, medals: [], mutators: [], daily: null
  };

  it("XP: wins and losses by difficulty, medals on top, quick losses pay less", () => {
    const total = (r: MatchResult) => xpLines(r).reduce((s, l) => s + l.xp, 0);
    expect(total(base)).toBe(150);
    expect(total({ ...base, difficulty: "easy" })).toBe(100);
    expect(total({ ...base, difficulty: "hard" })).toBe(220);
    expect(total({ ...base, medals: ["lightning", "ace"] })).toBe(150 + 2 * XP.medal);
    expect(total({ ...base, won: false })).toBe(45);
    expect(total({ ...base, won: false, secs: 150 })).toBe(Math.round(45 * 0.5));
    expect(total({ ...base, won: false, secs: 5 })).toBe(Math.round(45 * 0.2));
    expect(total({ ...base, kind: "survival", won: false, waves: 12 })).toBe(180);
  });

  it("stars: win, win under 8:00, win without losing a building; none when mutated or daily", () => {
    expect(starsFor(base)).toBe(0b011);
    expect(starsFor({ ...base, secs: 600, buildingsLost: 0 })).toBe(0b101);
    expect(starsFor({ ...base, won: false })).toBe(0);
    expect(starsFor({ ...base, mutators: ["glass"] })).toBe(0);
    // generated maps earn none: there are endlessly many
    expect(starsFor({ ...base, mapId: "random-desert-k3x9a" })).toBe(0);
    expect(starsFor({ ...base, daily: 20000 })).toBe(0);
    expect(starCount(0b111)).toBe(3);
  });

  it("applyResult banks XP, records, stars, medals and spots a promotion", () => {
    const c0 = emptyCareer();
    c0.xp = 90;
    const { career, s } = applyResult(c0, { ...base, medals: ["untouchable"], buildingsLost: 0 });
    expect(c0.xp).toBe(90); // pure
    expect(career.xp).toBe(90 + 150 + 25);
    expect(s.gained).toBe(175);
    expect(s.rankedUp).toBe(true);
    expect(s.rankBefore.name).toBe("Cadet");
    expect(s.rankAfter.name).toBe("Soldat");
    expect(career.wins).toBe(1);
    expect(career.stars["riverlands:normal"]).toBe(0b111);
    expect(s.starsBefore).toBe(0);
    expect(s.starsAfter).toBe(0b111);
    expect(career.medals.untouchable).toBe(1);
    expect(s.firstMedals).toEqual(["untouchable"]);
    expect(career.records["riverlands:normal"]).toEqual({ w: 1, l: 0, bestSecs: 400 });
    // stars accumulate: a later slow win keeps the earlier stars
    const again = applyResult(career, { ...base, secs: 900, medals: ["untouchable"] });
    expect(again.career.stars["riverlands:normal"]).toBe(0b111);
    expect(again.s.firstMedals).toEqual([]);
    expect(again.career.medals.untouchable).toBe(2);
    expect(again.career.records["riverlands:normal"]!.bestSecs).toBe(400);
  });

  it("losses and Last Stand runs are banked too", () => {
    const lost = applyResult(emptyCareer(), { ...base, won: false });
    expect(lost.career.losses).toBe(1);
    expect(lost.career.stars["riverlands:normal"]).toBeUndefined();
    const run = applyResult(emptyCareer(), { ...base, kind: "survival", won: false, waves: 11, medals: ["holdout"] });
    expect(run.career.laststand).toEqual({ runs: 1, waves: 11, best: 11 });
    expect(run.career.wins + run.career.losses).toBe(0);
    expect(run.s.gained).toBe(165 + 25);
  });

  it("the Daily Op streak grows on consecutive days, holds on replays and breaks after a gap", () => {
    const day = 20733;
    const daily = (d: number, won = true): MatchResult => ({ ...base, won, daily: d, mutators: ["glass", "blitz"] });
    let c = emptyCareer();
    let r = applyResult(c, daily(day), day, 280);
    expect(r.s.daily).toEqual({ number: 280, won: true, streak: 1, firstWinToday: true });
    expect(r.s.lines.map((l) => l.label)).toContain("Op du jour");
    c = r.career;
    r = applyResult(c, daily(day), day, 280); // a replay the same day: no bonus, no double count
    expect(r.s.daily!.firstWinToday).toBe(false);
    expect(r.s.lines.map((l) => l.label)).not.toContain("Op du jour");
    expect(r.career.daily.streak).toBe(1);
    c = applyResult(r.career, daily(day + 1), day + 1).career;
    expect(c.daily.streak).toBe(2);
    c = applyResult(c, daily(day + 2, false), day + 2).career; // a loss doesn't break it
    expect(currentStreak(c, day + 2)).toBe(2);
    expect(currentStreak(c, day + 3)).toBe(0); // a whole day without a win does
    c = applyResult(c, daily(day + 4), day + 4).career;
    expect(c.daily.streak).toBe(1);
    expect(c.daily.bestStreak).toBe(2);
    expect(c.daily.wins).toBe(3);
    expect(c.daily.plays).toBe(5);
  });
});

describe("career storage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("round-trips and sanitises what it loads", () => {
    const c = emptyCareer();
    c.xp = 1234;
    c.medals.ace = 2;
    c.stars["frostbite:hard"] = 5;
    saveCareer(c);
    expect(loadCareer()).toEqual(c);
    store.set("battledrones.career", JSON.stringify({ xp: "lots", medals: { ace: 1, bogus: 9 }, stars: { "a:b": 15 } }));
    const s = loadCareer();
    expect(s.xp).toBe(0);
    expect(s.medals).toEqual({ ace: 1 });
    expect(s.stars["a:b"]).toBe(7);
    store.set("battledrones.career", "{not json");
    expect(loadCareer()).toEqual(emptyCareer());
  });

  it("settleMatch banks a finished world exactly once", () => {
    const w = createMapWorld("proving-grounds", { seed: 4 });
    const ch = chronicleOf(w);
    for (let i = 0; i < 300; i++) {
      step(w, []);
      for (const ev of w.fx) ch.onFx(ev);
      ch.tick();
    }
    hqOf(w, "red")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("blue");
    const meta = { pov: "blue" as const, difficulty: "hard", daily: null };
    const s1 = settleMatch(w, meta);
    const s2 = settleMatch(w, meta);
    expect(s2).toBe(s1);
    expect(s1.result).toMatchObject({ kind: "skirmish", won: true, mapId: "proving-grounds", difficulty: "hard" });
    expect(s1.result.medals).toContain("lightning");
    const saved = loadCareer();
    expect(saved.wins).toBe(1);
    expect(saved.xp).toBe(s1.xpAfter);
    expect(saved.stars["proving-grounds:hard"]).toBe(0b111);
  });

  it("works with storage blocked", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(loadCareer()).toEqual(emptyCareer());
    expect(() => saveCareer(emptyCareer())).not.toThrow();
  });
});

describe("the Daily Op", () => {
  it("is a pure function of the date", () => {
    expect(dailyOp(20733)).toEqual(dailyOp(20733));
    expect(dailyOp(20733).number).toBe(280);
    expect(dayLabel(20733)).toBe("mer. 7 oct.");
    expect(dayIndexOf(new Date(2026, 9, 7, 23, 59))).toBe(20733);
    expect(dayIndexOf(new Date(2026, 9, 8, 0, 1))).toBe(20734);
  });

  it("keeps each day's map when maps are reordered or added", () => {
    // pinned before the picker put Proving Grounds first: a fixed list, not MAPS
    const maps = Array.from({ length: 8 }, (_, i) => dailyOp(20733 + i).mapId);
    expect(maps).toEqual(["frostbite", "dune-sea", "ashlands", "proving-grounds", "proving-grounds", "frostbite", "proving-grounds", "dune-sea"]);
  });

  it("varies from day to day", () => {
    const ops = Array.from({ length: 90 }, (_, i) => dailyOp(20700 + i));
    expect(new Set(ops.map((o) => o.mapId)).size).toBe(DAILY_MAPS.length);
    expect(new Set(ops.map((o) => o.strategy)).size).toBe(Object.keys(STRATEGIES).length);
    expect(new Set(ops.map((o) => o.difficulty))).toEqual(new Set(["normal", "hard"]));
    expect(new Set(ops.map((o) => o.mutators.join("+"))).size).toBeGreaterThan(10);
    expect(new Set(ops.map((o) => o.seed)).size).toBe(90);
  });

  it("only ever deals compatible combinations", () => {
    for (let d = 20000; d < 23000; d++) {
      const op = dailyOp(d);
      expect(op.mutators).toHaveLength(2);
      expect(op.mutators[0]).not.toBe(op.mutators[1]);
      expect(dailyCompatible(op.strategy, op.mutators)).toBe(true);
      expect(strategyFits(STRATEGIES[op.strategy], makeRules(op.mutators))).toBe(true);
      if (op.mutators.includes("airwar")) expect(["rush", "ironclad"]).not.toContain(op.strategy);
    }
  });

  it("the compatibility guard rejects broken pairs", () => {
    const pair = (a: MutatorId, b: MutatorId) => [a, b];
    expect(dailyCompatible("ironclad" as StrategyName, pair("airwar", "glass"))).toBe(false);
    expect(dailyCompatible("rush", pair("airwar", "blitz"))).toBe(false);
    expect(dailyCompatible("skyforce", pair("airwar", "blitz"))).toBe(true);
    expect(dailyCompatible("balanced", pair("glass", "glass"))).toBe(false);
    expect(dailyCompatible("balanced", ["glass"])).toBe(false);
  });

  it("the daily world is the same match for everyone", () => {
    const op = dailyOp(20733);
    const a = createMapWorld(op.mapId, { seed: op.seed, mutators: op.mutators });
    const b = createMapWorld(op.mapId, { seed: op.seed, mutators: op.mutators });
    expect(a.seed).toBe(b.seed);
    expect(a.rules).toEqual(b.rules);
  });
});
