import { describe, expect, it } from "vitest";
import { endOf, replay, resimulate, setupWorld as recordSetup, worldHash as recordHash } from "../src/arena/record";
import { worldHash } from "../src/sim/checksum";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { Faction } from "../src/sim/types";
import { battleRecord, duelEnd } from "../src/versus/records";

const SETUP = { map: "riverlands", seed: 42, mutators: [], openers: { blue: "blitz", red: "airwing" } } as const;

describe("resign (duels)", () => {
  it("hands the match to the other side on the tick it's applied", () => {
    const w = setupWorld({ ...SETUP, mutators: [] });
    for (let i = 0; i < 20; i++) step(w, []);
    step(w, [{ type: "resign", faction: "red" }]);
    expect(w.winner).toBe("blue");
    expect(w.resigned).toBe("red");
    expect(w.fx).toContainEqual({ type: "resign", faction: "red" });
    const tick = w.tick;
    step(w, []);
    expect(w.tick).toBe(tick); // a decided world stands still on both phones
    expect(endOf(w.tick, w.winner!, w.resigned)).toEqual({ tick, winner: "blue", reason: "resign" });
  });

  it("is a draw when both sides resign on the same tick", () => {
    const w = setupWorld({ ...SETUP, mutators: [] });
    step(w, [
      { type: "resign", faction: "blue" },
      { type: "resign", faction: "red" }
    ]);
    expect(w.winner).toBe("draw");
    expect(w.resigned).toBeNull();
    // a draw by resign, not Robot Love's: the arena's ending and the duel's agree
    expect(endOf(w.tick, w.winner!, w.resigned)).toEqual({ tick: 1, winner: null, reason: "resign" });
    expect(duelEnd(w.tick, w.winner, w.resigned)).toEqual(endOf(w.tick, w.winner!, w.resigned));
  });

  it("leaves an HQ kill recorded as one", () => {
    expect(endOf(100, "red")).toEqual({ tick: 100, winner: "red", reason: "hq" });
    expect(endOf(100, "draw")).toEqual({ tick: 100, winner: null, reason: "love" });
  });

  it("ends a record the same in the arena and the duel, for every decided world", () => {
    // (`resigned` as the world has it: unset for an HQ or Robot Love, the side, or null for both)
    for (const winner of ["blue", "red", "draw"] as const)
      for (const resigned of [undefined, "blue", "red", null] as (Faction | null | undefined)[])
        expect(duelEnd(100, winner, resigned), `${winner} ${resigned}`).toEqual(endOf(100, winner, resigned));
  });

  it("keeps a duel record both sides resigned in a draw by resign when it is re-simulated", () => {
    const setup = { ...SETUP, mutators: [] };
    const w = setupWorld(setup);
    for (let i = 0; i < 30; i++) step(w, []);
    const both = [{ type: "resign", faction: "blue" }, { type: "resign", faction: "red" }] as const;
    step(w, [...both]);
    const end = duelEnd(w.tick, w.winner!, w.resigned);
    const rec = battleRecord({
      setup, seats: { blue: "host", red: "guest" }, turns: [[30, "blue", [both[0]]], [30, "red", [both[1]]]], hashes: [], tick: w.tick, end,
      sim: null, created: "2026-01-01T00:00:00.000Z"
    });
    expect(rec.end).toEqual({ tick: 31, winner: null, reason: "resign" });
    expect(replay(rec).world.winner).toBe("draw");
    // (tools/arena.ts upgrade: the same ending on this sim, nothing moved)
    const up = resimulate(rec, { commit: null, sim: null });
    expect(up.end).toEqual(rec.end);
    expect(up.upgraded?.[0]?.end).toEqual(rec.end);
  });
});

describe("match setup and hashing live in the sim", () => {
  it("are the same functions the battle records use", () => {
    expect(recordSetup).toBe(setupWorld);
    expect(recordHash).toBe(worldHash);
  });

  it("builds the same world every time", () => {
    const a = setupWorld({ ...SETUP, mutators: [] });
    const b = setupWorld({ ...SETUP, mutators: [] });
    expect(worldHash(a)).toBe(worldHash(b));
    for (let i = 0; i < 50; i++) {
      step(a, []);
      step(b, []);
    }
    expect(worldHash(a)).toBe(worldHash(b));
  });
});
