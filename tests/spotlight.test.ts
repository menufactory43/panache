import { describe, expect, it } from "vitest";
import { SPOTLIGHT, SPOTLIGHT_KEY, Spotlight, setSpotlight, slowAt, spotlightOn, type SpotHost } from "../src/game/spotlight";
import type { FxEvent } from "../src/sim/types";

type Death = Extract<FxEvent, { type: "death" }>;
const death = (over: Partial<Death>): Death => ({
  type: "death", id: 1, faction: "red", unitKind: "stinger", buildingKind: null, x: 20, y: 20, air: false,
  value: 150, killerId: null, killerKind: null, rank: 0, kills: 0, ...over
});
const host = (over: Partial<SpotHost> = {}): SpotHost => ({
  player: "blue", onScreen: () => true, sees: () => true, reduced: false, place: () => "au centre", isHq: (id) => id === 99, ...over
});

describe("slow motion curve", () => {
  it("eases down, holds, and comes back to real time by the end", () => {
    expect(slowAt(-1)).toBe(1);
    expect(slowAt(0)).toBe(1);
    expect(slowAt(SPOTLIGHT.inMs)).toBeCloseTo(SPOTLIGHT.slow);
    expect(slowAt(300)).toBe(SPOTLIGHT.slow);
    expect(slowAt(SPOTLIGHT.ms - 1)).toBeGreaterThan(0.95);
    expect(slowAt(SPOTLIGHT.ms)).toBe(1);
    // never faster than real time, never slower than the floor
    for (let t = 0; t < SPOTLIGHT.ms; t += 7) {
      expect(slowAt(t)).toBeGreaterThanOrEqual(SPOTLIGHT.slow - 1e-9);
      expect(slowAt(t)).toBeLessThanOrEqual(1);
    }
  });
});

describe("Temps forts", () => {
  it("gives a Goliath's fall slow motion, a jolt and a push-in, but no banner of its own", () => {
    const s = new Spotlight(host());
    s.events([death({ unitKind: "goliath", value: 1500 })], 60);
    const spot = s.update(16, 60, false);
    expect(spot).toMatchObject({ kind: "goliath", slow: true, shake: true, nudge: true, banner: null });
    expect(s.timeScale).toBe(1); // (the frame it fires: the curve starts at 1)
    s.update(200, 60.2, false);
    expect(s.timeScale).toBeCloseTo(SPOTLIGHT.slow);
    s.update(SPOTLIGHT.ms, 61, false);
    expect(s.timeScale).toBe(1);
  });

  it("allows one moment per gap of play, and lets a stale one go", () => {
    const s = new Spotlight(host());
    s.events([death({ unitKind: "goliath" })], 10);
    expect(s.update(16, 10, false)).not.toBeNull();
    s.events([death({ id: 2, unitKind: "goliath" })], 20);
    expect(s.update(10_000, 20, false)).toBeNull(); // (too soon)
    // the gap passes, but that Goliath fell long ago: nothing
    expect(s.update(SPOTLIGHT.gapMs, 40, false)).toBeNull();
    s.events([death({ id: 3, unitKind: "goliath" })], 41);
    expect(s.update(16, 41, false)?.kind).toBe("goliath");
  });

  it("paused time doesn't count toward the gap", () => {
    const s = new Spotlight(host());
    s.events([death({ unitKind: "goliath" })], 10);
    s.update(16, 10, false);
    for (let i = 0; i < 100; i++) s.update(0, 10, false); // (paused: the scene passes 0)
    s.events([death({ id: 2, unitKind: "goliath" })], 11);
    expect(s.update(16, 11, false)).toBeNull();
  });

  it("off screen: no slow motion, and nothing at all for a moment with no banner", () => {
    const s = new Spotlight(host({ onScreen: () => false }));
    s.events([death({ unitKind: "goliath" })], 5);
    expect(s.update(16, 5, false)).toBeNull();
    // the first shell on their HQ has a banner: that still shows (tapping it jumps there), with no motion
    s.events([{ type: "hit", faction: "red", id: 99, x: 40, y: 40, building: true, attackerId: 3 }], 6);
    expect(s.update(16, 6, false)).toMatchObject({ kind: "hq-first", slow: false, shake: false, nudge: false, banner: { text: "Leur GQG est touché !" } });
  });

  it("under prefers-reduced-motion: banners only", () => {
    const s = new Spotlight(host({ reduced: true }));
    s.events([{ type: "hit", faction: "red", id: 99, x: 40, y: 40, building: true, attackerId: 3 }], 6);
    const spot = s.update(16, 6, false);
    expect(spot).toMatchObject({ slow: false, shake: false, nudge: false });
    expect(spot?.banner).not.toBeNull();
    expect(s.timeScale).toBe(1);
  });

  it("the first hit on their HQ is one moment a match; ours, or one in the fog, isn't", () => {
    const s = new Spotlight(host({ sees: (x) => x > 30 }));
    s.events([{ type: "hit", faction: "blue", id: 99, x: 40, y: 40, building: true, attackerId: 3 }], 1);
    s.events([{ type: "hit", faction: "red", id: 99, x: 10, y: 10, building: true, attackerId: 3 }], 1);
    expect(s.update(16, 1, false)).toBeNull();
    s.events([{ type: "hit", faction: "red", id: 99, x: 40, y: 40, building: true, attackerId: 3 }], 2);
    expect(s.update(16, 2, false)?.kind).toBe("hq-first");
    s.events([{ type: "hit", faction: "red", id: 99, x: 40, y: 40, building: true, attackerId: 3 }], 100);
    expect(s.update(SPOTLIGHT.gapMs, 100, false)).toBeNull();
  });

  it("a calldown of ours is a moment once its shells have hit enough", () => {
    const s = new Spotlight(host());
    const impact = (hits: number, faction: "blue" | "red" = "blue") =>
      ({ type: "calldownImpact", id: 4, faction, power: "barrage", x: 30, y: 30, radius: 3, hits, unitIds: [] }) as FxEvent;
    s.events([impact(2), impact(2)], 3);
    expect(s.update(16, 3, false)).toBeNull();
    s.events([impact(9, "red")], 3.1); // (theirs: never)
    expect(s.update(16, 3.1, false)).toBeNull();
    s.events([impact(1)], 3.2);
    expect(s.update(16, 3.2, false)?.kind).toBe("calldown");
  });

  it("a big fight won: once it goes quiet, with the losses in its banner", () => {
    const s = new Spotlight(host());
    const fight: FxEvent[] = [];
    for (let i = 0; i < 9; i++) fight.push(death({ id: 10 + i, faction: "red", x: 30 + (i % 3), y: 30 }));
    fight.push(death({ id: 30, faction: "blue", x: 31, y: 31 }));
    s.events(fight, 50);
    expect(s.update(16, 50, false)).toBeNull(); // (still fighting)
    for (let t = 50.1; t < 53; t += 0.1) s.events([], t);
    const spot = s.update(16, 53, false);
    expect(spot?.kind).toBe("battle");
    expect(spot?.banner?.text).toBe("Bataille remportée");
    expect(spot?.banner?.sub).toBe("Au centre : 9 pertes chez eux, 1 chez nous");
  });

  it("a fight lost, or an even one, is no moment", () => {
    const s = new Spotlight(host());
    const fight: FxEvent[] = [];
    for (let i = 0; i < 5; i++) fight.push(death({ id: 10 + i, faction: "red" }), death({ id: 20 + i, faction: "blue" }));
    s.events(fight, 50);
    for (let t = 50.1; t < 54; t += 0.1) s.events([], t);
    expect(s.update(16, 54, false)).toBeNull();
  });

  it("nothing once the match is decided: the finale has it", () => {
    const s = new Spotlight(host());
    s.events([death({ unitKind: "goliath" })], 5);
    expect(s.update(16, 5, true)).toBeNull();
    expect(s.update(16, 5, false)).toBeNull();
  });

  it("switches off in Réglages, on by default and when storage is blocked", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(spotlightOn(store)).toBe(true);
    setSpotlight(store, false);
    expect(m.get(SPOTLIGHT_KEY)).toBe("0");
    expect(spotlightOn(store)).toBe(false);
    setSpotlight(store, true);
    expect(spotlightOn(store)).toBe(true);
    expect(spotlightOn(null)).toBe(true);
    expect(spotlightOn({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
  });
});
