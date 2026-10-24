import { describe, expect, it } from "vitest";
import { apparier, depouiller, ecartAdmis, nomDe, variation, type Attente } from "../relay/src/classement";

const att = (ws: string, cote: number, depuis = 0, build = 7, compte = `c-${ws}`): Attente => ({ ws, compte, cote, build, depuis });

describe("the ladder", () => {
  it("names a player from their account, always the same", () => {
    const n = nomDe("8f0e6c1a-2b3c-4d5e-8f70-1234567890ab");
    expect(n).toMatch(/^(Aspirant|Sergent|Lieutenant|Capitaine|Commandant|Colonel|Major) \S+ \d{2}$/);
    expect(nomDe("8f0e6c1a-2b3c-4d5e-8f70-1234567890ab")).toBe(n);
    const many = new Set(Array.from({ length: 200 }, (_, i) => nomDe(`compte-${i}`)));
    expect(many.size).toBeGreaterThan(190);
  });

  it("moves the rating as Elo does, faster for new players", () => {
    expect(variation(1000, 1000, 1, 20)).toBe(12);
    expect(variation(1000, 1000, 0, 20)).toBe(-12);
    expect(variation(1000, 1000, 0.5, 20)).toBe(0);
    expect(variation(1000, 1000, 1, 0)).toBe(20);
    // beating someone much stronger is worth more than beating someone weaker
    expect(variation(1000, 1400, 1, 20)).toBeGreaterThan(variation(1400, 1000, 1, 20));
    // what one wins the other loses (same K)
    expect(variation(1100, 950, 1, 20) + variation(950, 1100, 0, 20)).toBe(0);
  });

  it("pairs close ratings on the same build, widening the window with the wait", () => {
    expect(ecartAdmis(0)).toBe(100);
    expect(ecartAdmis(30_000)).toBe(400);
    expect(ecartAdmis(10 * 60_000)).toBe(600);
    const now = 100_000;
    // too far apart at first…
    expect(apparier([att("a", 1000, now), att("b", 1300, now)], now)).toEqual([]);
    // …fine once one of them has waited
    expect(apparier([att("a", 1000, now - 25_000), att("b", 1300, now)], now)).toHaveLength(1);
    // never two builds, never one account with itself
    expect(apparier([att("a", 1000, now), att("b", 1000, now, 8)], now)).toEqual([]);
    expect(apparier([att("a", 1000, now, 7, "x"), att("b", 1000, now, 7, "x")], now)).toEqual([]);
    // the longest waiting first, with the closest rating
    const p = apparier([att("new", 1010, now), att("old", 1000, now - 4000), att("mid", 1090, now - 1000), att("far", 1500, now)], now);
    expect(p.map(([a, b]) => `${a.ws}+${b.ws}`)).toEqual(["old+new"]);
  });

  it("counts a result when both sides agree, or a loss as soon as it is owned", () => {
    expect(depouiller({ bleu: "blue", rouge: "blue" }, false)).toBe("blue");
    expect(depouiller({ bleu: "draw", rouge: "draw" }, false)).toBe("draw");
    expect(depouiller({ bleu: "blue", rouge: "red" }, true)).toBeNull();
    expect(depouiller({ bleu: "red", rouge: null }, false)).toBe("red");
    expect(depouiller({ bleu: null, rouge: "blue" }, false)).toBe("blue");
    expect(depouiller({ bleu: "blue", rouge: null }, false)).toBeNull();
    expect(depouiller({ bleu: "blue", rouge: null }, true)).toBe("blue");
    expect(depouiller({ bleu: null, rouge: null }, true)).toBeNull();
  });
});
