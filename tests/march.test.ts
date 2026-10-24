/**
 * The march in order (src/sim/march.ts): each unit to its place on a front
 * by what it does, the group arriving together, a short or lengthwise front
 * a column, a split order deploying as one, and the codec carrying it.
 */
import { describe, expect, it } from "vitest";
import { worldHash } from "../src/sim/checksum";
import { MARCH, bandOf, marchLayout } from "../src/sim/march";
import { step } from "../src/sim/sim";
import type { Command, Unit, UnitKind, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";
import { BitReader, BitWriter, canonicalize, decodeCommands, encodeCommands } from "../src/versus/codec";

/** A mixed group standing around (x, y), south of a front drawn east–west at y = 8. */
function army(w: World, x = 20, y = 32): Unit[] {
  const kinds: UnitKind[] = ["mastodon", "stinger", "trooper", "trooper", "flak-crawler", "mortar", "sniper", "wasp", "mender"];
  return kinds.map((k, i) => spawnUnit(w, k, "blue", x - 4 + (i % 5) * 2 + 0.5, y + Math.floor(i / 5) * 2 + 0.5));
}
const march = (units: Unit[], x1: number, y1: number, x2: number, y2: number, attack = false): Command => ({
  type: "march", faction: "blue", unitIds: units.map((u) => u.id), x1, y1, x2, y2, attack
});

describe("the march in order", () => {
  it("puts armour and squads in front, anti-aircraft behind, artillery and marksmen at the back", () => {
    expect(["mastodon", "stinger", "trooper", "goliath"].map((k) => bandOf(k as UnitKind))).toEqual([0, 0, 0, 0]);
    expect(bandOf("flak-crawler")).toBe(1);
    expect(["mortar", "sniper", "harvester", "atelier"].map((k) => bandOf(k as UnitKind))).toEqual([2, 2, 2, 2]);

    const w = createWorld(40, 40);
    const us = army(w);
    const lay = marchLayout(us, { x: 10, y: 8 }, { x: 30, y: 8 }, w);
    expect(lay.column).toBe(false);
    const y = (k: UnitKind) => us.filter((u) => u.kind === k).map((u) => lay.slots.get(u.id)!.y);
    // the front faces north (away from the group): further back is further south
    for (const k of ["mastodon", "stinger", "trooper"] as const) for (const v of y(k)) expect(v).toBeCloseTo(8);
    expect(Math.min(...y("flak-crawler"))).toBeGreaterThan(8.5);
    expect(Math.min(...y("mortar"), ...y("sniper"))).toBeGreaterThan(Math.max(...y("flak-crawler")));
    // the front spreads along the line drawn
    const xs = us.filter((u) => bandOf(u.kind) === 0 && u.kind !== "wasp").map((u) => lay.slots.get(u.id)!.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(9);
    // facing north: 0
    expect(Math.abs(lay.face)).toBeLessThan(1e-9);
  });

  it("gets everyone there together, then they face the front", () => {
    const w = createWorld(40, 40);
    const us = army(w);
    step(w, [march(us, 10, 8, 30, 8)]);
    const due = us[0]!.march!.due;
    expect(us.every((u) => u.march?.due === due)).toBe(true);
    const arrived = new Map<number, number>();
    for (let i = 0; i < 1500 && arrived.size < us.length; i++) {
      step(w, []);
      for (const u of us) if (u.order.type === "idle" && !arrived.has(u.id)) arrived.set(u.id, w.tick);
    }
    expect(arrived.size).toBe(us.length);
    const ticks = [...arrived.values()];
    // the fast Panhard and the slow Creusot within a few seconds of each other (not 2× apart)
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThan(60);
    for (const u of us) {
      expect(u.march).toBeUndefined();
      expect(Math.abs(u.facing)).toBeLessThan(1e-9);
    }
  });

  it("without it the group straggles (what it fixes)", () => {
    const w = createWorld(40, 40);
    const us = army(w);
    step(w, [{ type: "move", faction: "blue", unitIds: us.filter((u) => u.kind === "stinger" || u.kind === "mastodon").map((u) => u.id), x: 20.5, y: 8.5 }]);
    const arrived = new Map<number, number>();
    for (let i = 0; i < 1500 && arrived.size < 2; i++) {
      step(w, []);
      for (const u of us) if ((u.kind === "stinger" || u.kind === "mastodon") && u.order.type === "idle" && !arrived.has(u.id)) arrived.set(u.id, w.tick);
    }
    const ticks = [...arrived.values()];
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeGreaterThan(60);
  });

  it("is a column for a short front, or one drawn along the way", () => {
    const w = createWorld(40, 40);
    const us = army(w);
    const short = marchLayout(us, { x: 20, y: 10 }, { x: 21, y: 10 }, w);
    expect(short.column).toBe(true);
    const along = marchLayout(us, { x: 20, y: 22 }, { x: 20, y: 8 }, w);
    expect(along.column).toBe(true);
    // two abreast, the head at the far end (north), armour first
    const ground = us.filter((u) => u.kind !== "wasp" && u.kind !== "mender");
    const xs = new Set(ground.map((u) => Math.round(along.slots.get(u.id)!.x * 10)));
    expect(xs.size).toBeLessThanOrEqual(3); // (two files, and an odd one out walking the middle)
    const front = us.filter((u) => bandOf(u.kind) === 0 && u.kind !== "wasp" && u.kind !== "mender");
    const back = us.filter((u) => bandOf(u.kind) === 2 && u.kind !== "wasp" && u.kind !== "mender");
    expect(Math.max(...front.map((u) => along.slots.get(u.id)!.y))).toBeLessThan(Math.min(...back.map((u) => along.slots.get(u.id)!.y)));
    expect(Math.min(...ground.map((u) => along.slots.get(u.id)!.y))).toBeCloseTo(8, 0);
  });

  it("deploys a split order as one: the later pieces join the first", () => {
    const one = createWorld(40, 40);
    const two = createWorld(40, 40);
    const a = army(one);
    const b = army(two);
    step(one, [march(a, 10, 8, 30, 8)]);
    step(two, [march(b.slice(0, 4), 10, 8, 30, 8)]);
    step(one, []);
    step(two, [march(b.slice(4), 10, 8, 30, 8)]);
    // the same places as the whole order (the layout is the group's, laid out again from where they stand)
    const lay = marchLayout(b, { x: 10, y: 8 }, { x: 30, y: 8 }, two);
    for (const u of b) {
      const o = u.order as { x: number; y: number };
      expect(o.x).toBeCloseTo(lay.slots.get(u.id)!.x);
      expect(o.y).toBeCloseTo(lay.slots.get(u.id)!.y);
    }
    expect(new Set(b.map((u) => u.march!.g)).size).toBe(1);
    // too late to join: its own march
    for (let i = 0; i < MARCH.mergeTicks + 1; i++) step(two, []);
    step(two, [march(b.slice(0, 2), 10, 8, 30, 8)]);
    expect(b[0]!.march!.g).not.toBe(b[5]!.march?.g ?? -1);
  });

  it("any other order ends the march", () => {
    const w = createWorld(40, 40);
    const us = army(w);
    step(w, [march(us, 10, 8, 30, 8, true)]);
    expect(us.find((u) => u.kind === "stinger")!.order.type).toBe("attackMove");
    step(w, [{ type: "stop", faction: "blue", unitIds: [us[0]!.id] }]);
    expect(us[0]!.march).toBeUndefined();
    expect(us[1]!.march).toBeDefined();
  });

  it("replays the same, and leaves worlds without a march hashed as before", () => {
    const run = () => {
      const w = createWorld(40, 40);
      const us = army(w);
      step(w, [march(us, 30, 10, 12, 6, true)]);
      for (let i = 0; i < 300; i++) step(w, []);
      return worldHash(w);
    };
    expect(run()).toBe(run());
    const w = createWorld(40, 40);
    army(w);
    const before = worldHash(w);
    w.marches = [];
    expect(worldHash(w)).toBe(before);
  });

  it("goes through the duel's codec, split if long, and decodes the same", () => {
    const ctx = { width: 64, height: 64, local: "blue" as const };
    const ids = Array.from({ length: 40 }, (_, i) => 3 + i * 7);
    const pieces = canonicalize({ type: "march", faction: "blue", unitIds: ids, x1: 10.3, y1: 8.1, x2: 30.7, y2: 8.9, attack: true }, ctx);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.flatMap((p) => (p as { unitIds: number[] }).unitIds)).toEqual(ids);
    const wr = new BitWriter();
    encodeCommands(wr, pieces, ctx);
    const back = decodeCommands(new BitReader(wr.bytes(), wr.nbits), pieces.length, ctx, "blue");
    expect(back).toEqual(pieces);
    expect(back[0]).toMatchObject({ type: "march", attack: true, x1: 10.28125, y1: 8.09375 });
  });
});

describe("the AI and the march", () => {
  it("marches its waves up in order only when its strategy says so", async () => {
    const { createAiState, tickAi } = await import("../src/sim/ai/commander");
    const { createMapWorld } = await import("../src/sim/maps");
    const count = (march: boolean) => {
      const w = createMapWorld("riverlands", { seed: 7919 });
      const blue = createAiState("balanced", "hard", 1, march ? { march: true } : undefined);
      const red = createAiState("balanced", "hard", 2);
      let n = 0;
      while (!w.winner && w.tick < 4000) {
        const mine = tickAi(w, "blue", blue);
        n += mine.filter((c) => c.type === "march").length;
        step(w, [...mine, ...tickAi(w, "red", red)]);
      }
      return n;
    };
    expect(count(false)).toBe(0);
    expect(count(true)).toBeGreaterThan(0);
  }, 120000);
});
