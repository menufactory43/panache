/**
 * Éclair (src/sim/modes/eclair.ts): a six-minute skirmish on victory points.
 * Its start, its points (destructions and relays), its last minute, its
 * whistle, sudden death and the draw past it; and what it leaves alone.
 */
import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld } from "../src/sim/maps";
import { ECLAIR, eclairClose } from "../src/sim/modes/eclair";
import { makeRules, rulesOf, toggleMutator } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { World } from "../src/sim/types";
import { hqOf, spawnUnit } from "../src/sim/world";

const eclair = (seed = 3): World => createMapWorld("riverlands", { seed, mutators: ["eclair"], objectives: true });
/** Step to just before tick `t` (the step that makes w.tick === t is the one that runs tick t − 1). */
const runTo = (w: World, t: number) => {
  while (w.tick < t && !w.winner) step(w, []);
};
const S = (s: number) => s * TICK_RATE;

describe("Éclair", () => {
  it("starts with Blitz's coal and Lightning Production's pace, and an empty score", () => {
    const w = eclair();
    expect(w.factions.blue.scrap).toBeGreaterThanOrEqual(ECLAIR.startScrap);
    expect(rulesOf(w).buildSpeed).toBe(ECLAIR.buildSpeed);
    expect(w.eclair).toEqual({ points: { blue: 0, red: 0 }, relays: { blue: 0, red: 0 }, phase: "play", decided: null, at: null });
    // (a skirmish without it has none)
    expect(createMapWorld("riverlands", { objectives: true }).eclair).toBeUndefined();
  });

  it("takes the place of Blitz and Lightning Production", () => {
    expect(toggleMutator(["blitz", "rapidfab", "glass"], "eclair")).toEqual(["glass", "eclair"]);
    expect(toggleMutator(["eclair"], "blitz")).toEqual(["blitz"]);
    // (both asked anyway: the first in canonical order wins, never a double dose)
    expect(makeRules(["rapidfab", "eclair"]).buildSpeed).toBe(2);
  });

  it("scores a destruction at its cost, for the other side", () => {
    const w = eclair();
    const u = spawnUnit(w, "mastodon", "red", 20.5, 20.5);
    u.hp = 0;
    step(w, []);
    expect(w.eclair!.points).toEqual({ blue: 475, red: 0 });
  });

  it("scores the relays a side holds, every second", () => {
    const w = eclair();
    const l = w.objectives.uplinks[0]!;
    l.owner = "blue";
    l.progress = 100;
    runTo(w, S(10));
    expect(w.eclair!.points.blue).toBe(10 * ECLAIR.relayPts);
    expect(w.eclair!.relays.blue).toBe(10 * ECLAIR.relayPts);
    expect(w.eclair!.points.red).toBe(0);
  });

  it("doubles the income for the last minute", () => {
    const w = eclair();
    const before = rulesOf(w).incomeMult;
    runTo(w, S(ECLAIR.rushAtS) - 1);
    expect(w.eclair!.phase).toBe("play");
    step(w, []);
    expect(w.eclair!.phase).toBe("rush");
    expect(w.fx).toContainEqual({ type: "eclair", phase: "rush" });
    expect(rulesOf(w).incomeMult).toBe(before * ECLAIR.rushIncome);
  });

  it("gives the match to the side ahead on points at the whistle", () => {
    const w = eclair();
    runTo(w, S(ECLAIR.lengthS) - 1);
    w.eclair!.points = { blue: 1000, red: 4000 };
    step(w, []);
    expect(w.winner).toBe("red");
    expect(w.eclair).toMatchObject({ phase: "over", decided: "points" });
    expect(w.fx).toContainEqual({ type: "eclair", phase: "end" });
  });

  it("goes to sudden death when it's close: the next destruction decides", () => {
    const w = eclair();
    runTo(w, S(ECLAIR.lengthS) - 1);
    w.eclair!.points = { blue: 5000, red: 5100 };
    step(w, []);
    expect(w.winner).toBeNull();
    expect(w.eclair).toMatchObject({ phase: "overtime", at: { blue: 5000, red: 5100 } });
    // the relays score no more
    const l = w.objectives.uplinks[0]!;
    l.owner = "red";
    l.progress = -100;
    runTo(w, w.tick + S(5));
    expect(w.eclair!.points).toEqual({ blue: 5000, red: 5100 });
    // blue destroys a Panhard: blue wins, though behind on points
    const u = spawnUnit(w, "stinger", "red", 20.5, 20.5);
    u.hp = 0;
    step(w, []);
    expect(w.winner).toBe("blue");
    expect(w.eclair).toMatchObject({ phase: "over", decided: "sudden" });
  });

  it("past sudden death with nothing destroyed: the points, and equal points a draw", () => {
    for (const [pts, want] of [[{ blue: 3000, red: 3050 }, "red"], [{ blue: 3000, red: 3000 }, "draw"]] as const) {
      const w = eclair();
      runTo(w, S(ECLAIR.lengthS) - 1);
      w.eclair!.points = { ...pts };
      step(w, []);
      expect(w.eclair!.phase).toBe("overtime");
      runTo(w, S(ECLAIR.lengthS + ECLAIR.overtimeS));
      expect(w.winner).toBe(want);
      expect(w.eclair!.decided).toBe("time");
    }
  });

  it("an HQ falling still ends it at once", () => {
    const w = eclair();
    hqOf(w, "red")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("blue");
    step(w, []);
    expect(w.eclair).toMatchObject({ phase: "over", decided: null });
  });

  it("calls it close within 5% of the leader's points, or 150", () => {
    expect(eclairClose(100, 1000)).toBe(true);
    expect(eclairClose(160, 1000)).toBe(false);
    expect(eclairClose(900, 20_000)).toBe(true);
    expect(eclairClose(1100, 20_000)).toBe(false);
  });

  it("replays the same, and a world without it hashes as before", () => {
    const run = () => {
      const w = eclair(9);
      runTo(w, S(30));
      return worldHash(w);
    };
    expect(run()).toBe(run());
    const plain = createMapWorld("riverlands", { seed: 9, objectives: true });
    const h = worldHash(plain);
    expect(plain.eclair).toBeUndefined();
    expect(worldHash(plain)).toBe(h);
  });
});
