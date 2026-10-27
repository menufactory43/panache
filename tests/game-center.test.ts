import { describe, expect, it } from "vitest";
import { achievementsOf } from "../src/game/game-center";
import { emptyCareer } from "../src/game/career";
import { CAMPAIGN } from "../src/sim/ops";

const base = () => ({ career: emptyCareer(), lesson1: false, lesson2: false, duelWins: 0 });
const pct = (list: { id: string; percent: number }[], id: string) => list.find((a) => a.id === `panache.${id.replaceAll("-", "_")}`)?.percent ?? 0;

describe("Game Center achievements", () => {
  it("a new player has none", () => {
    expect(achievementsOf(base())).toEqual([]);
  });

  it("reads the lessons, the duel and the career", () => {
    const p = base();
    p.lesson1 = true;
    p.duelWins = 1;
    p.career.wins = 5;
    p.career.xp = 500;
    p.career.laststand.best = 15;
    p.career.medals["goliath-slayer"] = 1;
    p.career.records["dunes:hard"] = { w: 1, l: 0, bestSecs: 400 };
    const a = achievementsOf(p);
    expect(pct(a, "premier-jour")).toBe(100);
    expect(pct(a, "deuxieme-jour")).toBe(0);
    expect(pct(a, "duel")).toBe(100);
    expect(pct(a, "premiere-victoire")).toBe(100);
    expect(pct(a, "vingt-cinq-victoires")).toBe(20);
    expect(pct(a, "lieutenant")).toBe(50);
    expect(pct(a, "resistant")).toBe(100);
    expect(pct(a, "inebranlable")).toBe(75);
    expect(pct(a, "tueur-de-gargantua")).toBe(100);
    expect(pct(a, "difficile")).toBe(100);
  });

  it("counts the campaign by act, on any level, and its 36 stars on Normal", () => {
    const p = base();
    const act1 = CAMPAIGN.filter((o) => o.act === 1);
    p.career.ops[act1[0]!.id] = { stars: 7, bestSecs: 100, plays: 1, wins: 1 };
    p.career.ops[act1[1]!.id] = { stars: 0, cleared: true, bestSecs: null, plays: 1, wins: 1 };
    const a = achievementsOf(p);
    expect(pct(a, "acte-1")).toBe((100 * 2) / act1.length);
    expect(pct(a, "trente-six-etoiles")).toBeCloseTo((100 * 3) / 36, 1);
    for (const o of CAMPAIGN) p.career.ops[o.id] = { stars: 7, bestSecs: 100, plays: 1, wins: 1 };
    const all = achievementsOf(p);
    for (const id of ["acte-1", "acte-2", "acte-3", "trente-six-etoiles"]) expect(pct(all, id)).toBe(100);
  });
});
