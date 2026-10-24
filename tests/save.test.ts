import { describe, expect, it } from "vitest";
import { emptyCareer } from "../src/game/career";
import { SAVE_KEYS, emptySave, mergeSaves, readSave, sanitizeSave, saveText, writeSave, type SaveData } from "../src/game/save";

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

function deviceA(): SaveData {
  const s = emptySave();
  s.career.xp = 1200;
  s.career.wins = 9;
  s.career.losses = 2;
  s.career.medals = { lightning: 2 } as SaveData["career"]["medals"];
  s.career.stars = { "riverlands:normal": 0b011 };
  s.career.records = { "riverlands:normal": { w: 5, l: 1, bestSecs: 410 } };
  s.career.daily = { lastWin: 300, streak: 4, bestStreak: 4, wins: 6, plays: 8 };
  s.career.ops = { "bridgehead-classique": { stars: 1, bestSecs: 600, plays: 3, wins: 1 } };
  s.laststand = { "dune-sea:hard": { best: 12, kills: 80, runs: 5 } };
  s.flags = { "battledrones.tutorial": "done" };
  return s;
}

function deviceB(): SaveData {
  const s = emptySave();
  s.career.xp = 900;
  s.career.wins = 11;
  s.career.losses = 1;
  s.career.medals = { lightning: 1, untouchable: 1 } as SaveData["career"]["medals"];
  s.career.stars = { "riverlands:normal": 0b100, "frostbite:easy": 0b001 };
  s.career.records = { "riverlands:normal": { w: 3, l: 4, bestSecs: 380 } };
  s.career.daily = { lastWin: 302, streak: 1, bestStreak: 2, wins: 3, plays: 9 };
  s.career.ops = { "bridgehead-classique": { stars: 4, cleared: true, bestSecs: null, plays: 5, wins: 2 } };
  s.laststand = { "dune-sea:hard": { best: 12, kills: 95, runs: 2 }, "ashlands:easy": { best: 3, kills: 10, runs: 1 } };
  s.flags = { "battledrones.instruction2": "done", "panache.intro.seen": "1" };
  return s;
}

describe("the cloud save", () => {
  it("merges two devices without losing anything either earned", () => {
    const m = mergeSaves(deviceA(), deviceB());
    expect(m.career.xp).toBe(1200);
    expect(m.career.wins).toBe(11);
    expect(m.career.losses).toBe(2);
    expect(m.career.medals).toEqual({ lightning: 2, untouchable: 1 });
    expect(m.career.stars).toEqual({ "riverlands:normal": 0b111, "frostbite:easy": 0b001 });
    expect(m.career.records["riverlands:normal"]).toEqual({ w: 5, l: 4, bestSecs: 380 });
    // the streak is the latest win's
    expect(m.career.daily).toEqual({ lastWin: 302, streak: 1, bestStreak: 4, wins: 6, plays: 9 });
    expect(m.career.ops["bridgehead-classique"]).toEqual({ stars: 5, cleared: true, bestSecs: 600, plays: 5, wins: 2 });
    expect(m.laststand["dune-sea:hard"]).toEqual({ best: 12, kills: 95, runs: 5 });
    expect(m.laststand["ashlands:easy"]).toEqual({ best: 3, kills: 10, runs: 1 });
    expect(m.flags).toEqual({ "battledrones.tutorial": "done", "battledrones.instruction2": "done", "panache.intro.seen": "1" });
  });

  it("gives the same save in either order, and merging again changes nothing", () => {
    const ab = mergeSaves(deviceA(), deviceB());
    expect(saveText(mergeSaves(deviceB(), deviceA()))).toBe(saveText(ab));
    expect(saveText(mergeSaves(ab, deviceA()))).toBe(saveText(ab));
    expect(saveText(mergeSaves(ab, ab))).toBe(saveText(ab));
    expect(saveText(mergeSaves(emptySave(), ab))).toBe(saveText(ab));
  });

  it("checks what comes from the cloud", () => {
    const s = sanitizeSave({ career: { xp: -5, stars: { a: 255 } }, laststand: { x: { best: "lots" } }, flags: { "battledrones.tutorial": "no", evil: "done", "panache.intro.seen": "1" } });
    expect(s.career.xp).toBe(0);
    expect(s.career.stars).toEqual({ a: 7 });
    expect(s.laststand).toEqual({ x: { best: 0, kills: 0, runs: 0 } });
    expect(s.flags).toEqual({ "panache.intro.seen": "1" });
    expect(saveText(sanitizeSave(null))).toBe(saveText(emptySave()));
    expect(saveText(sanitizeSave("garbage"))).toBe(saveText(emptySave()));
  });

  it("reads and writes this device's storage, touching only what differs", () => {
    const career = { ...emptyCareer(), xp: 50 };
    const store = mem({
      [SAVE_KEYS.career]: JSON.stringify(career),
      [SAVE_KEYS.laststand]: JSON.stringify({ "dune-sea:hard": { best: 2, kills: 5, runs: 1, extra: "kept" } }),
      "battledrones.instruction": "no"
    });
    const here = readSave(store);
    expect(here.career.xp).toBe(50);
    expect(here.flags).toEqual({});
    expect(writeSave(store, here)).toBe(false);
    const merged = mergeSaves(here, deviceA());
    expect(writeSave(store, merged)).toBe(true);
    expect(JSON.parse(store.m.get(SAVE_KEYS.career)!).xp).toBe(1200);
    expect(JSON.parse(store.m.get(SAVE_KEYS.laststand)!)["dune-sea:hard"]).toEqual({ best: 12, kills: 80, runs: 5, extra: "kept" });
    expect(store.m.get("battledrones.tutorial")).toBe("done");
    expect(store.m.get("battledrones.instruction")).toBe("no");
    expect(saveText(readSave(store))).toBe(saveText(merged));
    expect(writeSave(store, merged)).toBe(false);
  });
});
