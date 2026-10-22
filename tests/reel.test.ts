import { describe, expect, it } from "vitest";
import type { ReelMoment } from "../src/arena/record";
import type { DeathRec, Sample } from "../src/game/chronicle";
import { REEL, cardText, clipDeadlines, clipsOf, endTitle, filmName, pickVideoType, recordName, reelClips, reelMoments, reelMs, videoTypes } from "../src/game/reel";

const death = (t: number, faction: "blue" | "red", x = 28, y = 28): DeathRec => ({
  t, x, y, faction, unitKind: "stinger", buildingKind: null, value: 150, killerKind: null, byBuilding: false
});
const sample = (t: number, blue: number, red: number): Sample => ({ t, army: { blue, red }, bank: { blue: 0, red: 0 }, harvesters: { blue: 3, red: 3 } });

/** A match's chronicle: first blood at 1:00, a big fight at 4:00 in the middle, the lead turning to blue at 5:00, a Goliath at 6:00. */
function chronicle() {
  const deaths: DeathRec[] = [death(60, "red", 10, 10)];
  for (let i = 0; i < 8; i++) deaths.push(death(240 + i, i % 3 ? "red" : "blue"));
  const samples: Sample[] = [];
  for (let t = 0; t <= 480; t += 5) samples.push(t < 300 ? sample(t, 400, 1200) : sample(t, 1500, 300));
  return {
    deaths, samples,
    refs: { width: 56, height: 56, hq: { blue: { x: 6, y: 6 }, red: { x: 50, y: 50 } } },
    firstBuilt: { blue: { goliath: 360 }, red: {} }
  };
}

describe("the highlight reel's moments", () => {
  it("finds first blood, the big battle, the turn, the Goliath and the end, from the player's side", () => {
    const ms = reelMoments(chronicle(), "blue", { tick: 4800, winner: "blue", x: 50, y: 50 });
    expect(ms.map((m) => m.kind)).toEqual(["first-blood", "battle", "turn", "goliath", "end"]);
    expect(ms.find((m) => m.kind === "battle")).toMatchObject({ tick: 2400, title: "La grande bataille, au centre" });
    expect(ms.find((m) => m.kind === "first-blood")).toMatchObject({ tick: 600, x: 10, y: 10 });
    expect(ms.at(-1)).toEqual({ kind: "end", tick: 4800, x: 50, y: 50, title: "La victoire" });
    // red's view of the same match
    const red = reelMoments(chronicle(), "red", { tick: 4800, winner: "blue" });
    expect(red.find((m) => m.kind === "turn")?.title).toBe("Le vent tourne");
    expect(red.find((m) => m.kind === "goliath")?.title).toBe("Leur Gargantua entre en scène");
    expect(red.at(-1)).toEqual({ kind: "end", tick: 4800, title: "La défaite" });
  });

  it("names the end for each result", () => {
    expect(endTitle("blue", "blue")).toBe("La victoire");
    expect(endTitle("blue", "red")).toBe("La défaite");
    expect(endTitle("draw", "red")).toBe("Le match nul");
    expect(endTitle("red", null)).toBe("La victoire rouge");
  });

  it("a short match with nothing but its end still has a reel", () => {
    const ms = reelMoments({ deaths: [], samples: [], refs: { width: 56, height: 56, hq: {} }, firstBuilt: { blue: {}, red: {} } }, "blue", { tick: 900, winner: "red" });
    expect(ms).toEqual([{ kind: "end", tick: 900, title: "La défaite" }]);
    expect(reelClips(ms, 900)).toHaveLength(1);
  });
});

describe("the reel's clips", () => {
  const ms = reelMoments(chronicle(), "blue", { tick: 4800, winner: "blue", x: 50, y: 50 });

  it("keeps REEL.max at most by priority, in order, none overlapping, the end last", () => {
    const clips = reelClips(ms, 4800);
    expect(clips.length).toBe(REEL.max);
    expect(clips.map((c) => c.moment.kind)).toEqual(["first-blood", "battle", "turn", "end"]); // (the Goliath gives way)
    for (let i = 1; i < clips.length; i++) expect(clips[i]!.from).toBeGreaterThanOrEqual(clips[i - 1]!.to);
    expect(clips.at(-1)).toMatchObject({ from: 4800 - REEL.endS * 10, to: 4800 });
    expect(clips[1]).toMatchObject({ from: 2400 - REEL.leadS * 10, card: "4:00 — La grande bataille, au centre" });
  });

  it("drops a moment whose clip would overlap a better one", () => {
    const close: ReelMoment[] = [
      { kind: "turn", tick: 2420, title: "Le tournant" },
      { kind: "battle", tick: 2400, title: "La grande bataille" },
      { kind: "end", tick: 6000, title: "La victoire" }
    ];
    expect(reelClips(close, 6000).map((c) => c.moment.kind)).toEqual(["battle", "end"]);
  });

  it("runs 15 to 25 s with its cards, the finale and « Fin »", () => {
    const ms4 = reelMs(reelClips(ms, 4800));
    expect(ms4).toBeLessThanOrEqual(25_000);
    expect(ms4).toBeGreaterThanOrEqual(15_000);
    // each clip's deadline (a late film cuts at it) comes in order, the last before the finale and « Fin »
    const due = clipDeadlines(reelClips(ms, 4800));
    expect([...due].sort((a, b) => a - b)).toEqual(due);
    expect(due.at(-1)! + REEL.finaleMs + REEL.finMs).toBe(ms4);
  });

  it("a saved record without moments plays its end", () => {
    const clips = clipsOf({ end: { tick: 3000, winner: "red" }, tick: 3000, played: { pov: "red" } });
    expect(clips.map((c) => c.card)).toEqual(["5:00 — La victoire"]);
    expect(cardText({ kind: "battle", tick: 2525, title: "X" })).toBe("4:12 — X");
  });
});

describe("the film", () => {
  it("picks MP4 first, then WebM, with or without sound", () => {
    expect(pickVideoType((t) => t.startsWith("video/webm"), true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickVideoType((t) => t === "video/mp4", true)).toBe("video/mp4");
    expect(pickVideoType((t) => t.includes("avc1"), false)).toBe("video/mp4;codecs=avc1.42E01E");
    expect(pickVideoType(() => false, false)).toBeNull();
    expect(pickVideoType(() => { throw new Error("nope"); }, false)).toBeNull();
    expect(videoTypes(true).every((t) => t.startsWith("video/"))).toBe(true);
  });

  it("names its files after the map and the day", () => {
    expect(filmName("riverlands", "2026-10-22T10:00:00Z", "video/mp4;codecs=avc1")).toBe("panache-riverlands-2026-10-22.mp4");
    expect(filmName("random-desert-1x", "2026-10-22T10:00:00Z", "video/webm")).toBe("panache-random-desert-1x-2026-10-22.webm");
    expect(recordName("riverlands", "2026-10-22T10:00:00Z")).toBe("panache-riverlands-2026-10-22.json");
  });
});
