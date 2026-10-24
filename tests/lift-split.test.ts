import { describe, expect, it } from "vitest";
import { worldHash } from "../src/sim/checksum";
import { step } from "../src/sim/sim";
import type { Command, Faction, Unit, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";
import { canonicalize } from "../src/versus/codec";

// A duel splits a long unit list into several commands of one tick (DUEL.md "Canonicalize and
// split"). A Goliath whose lift is still hooking on obeys an order only when its Condors are named in the same
// command, so it remembers an order it ignored for the rest of the tick and takes it if a later command calls
// its lift off (lift.ts HeldLiftOrders): the pieces do exactly what the one command would.

/** A blue Goliath with two Condors hooking onto it, a few other units, and red's ids in between (sparse, as in a long match). */
function hooking(): { w: World; g: Unit; a: Unit; b: Unit; all: number[] } {
  const w = createWorld(48, 48);
  const ids: number[] = [];
  const blue = (kind: Parameters<typeof spawnUnit>[1], x: number, y: number) => {
    const u = spawnUnit(w, kind, "blue", x, y);
    ids.push(u.id);
    for (let i = 0; i < 40; i++) w.units.delete(spawnUnit(w, "scout", "red", 46, 46).id); // (spends ids, leaves nothing)
    return u;
  };
  const g = blue("goliath", 20, 20);
  for (let i = 0; i < 6; i++) blue("stinger", 10 + i, 30);
  const a = blue("condor", 8, 8);
  const b = blue("condor", 11, 8);
  for (let i = 0; i < 4; i++) blue("stinger", 30, 10 + i);
  step(w, [{ type: "lift", faction: "blue", unitIds: [a.id, b.id], goliathId: g.id }]);
  expect(g.goliath!.lift?.phase).toBe("hooking");
  return { w, g, a, b, all: ids };
}

/** Everything about each unit the orders could change, and the world hash. */
const snapshot = (w: World) => ({
  hash: worldHash(w),
  units: [...w.units.values()].map((u) => ({ id: u.id, x: u.x, y: u.y, order: u.order, path: u.path, lift: u.goliath?.lift ?? null }))
});

/** Step `w` with `first` (one tick), then `n` empty ticks. */
const run = (w: World, first: Command[], n = 80) => {
  step(w, first);
  const after = snapshot(w);
  for (let i = 0; i < n; i++) step(w, []);
  return { after, end: snapshot(w) };
};

const move = (unitIds: number[], faction: Faction = "blue", x = 40.5, y = 36.5): Command => ({ type: "move", faction, unitIds, x, y });

describe("a hooking Goliath and a split order", () => {
  it("a select-all split into pieces does what the one command does, in either order", () => {
    const { all, g, a } = hooking();
    // the codec's own split of the select-all: the Goliath lands in an earlier piece than its Condors
    const pieces = canonicalize(move(all), { local: "blue", width: 48, height: 48 });
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    const pieceOf = (id: number) => pieces.findIndex((p) => "unitIds" in p && p.unitIds.includes(id));
    expect(pieceOf(g.id)).toBeLessThan(pieceOf(a.id));
    for (const type of ["move", "attackMove", "stop", "unload"] as const) {
      const as = (c: Command): Command => {
        const unitIds = "unitIds" in c ? c.unitIds : [];
        return type === "stop" ? { type, faction: "blue", unitIds } : { type, faction: "blue", unitIds, x: 40.5, y: 36.5 };
      };
      const one = run(hooking().w, [as(move(all))]);
      const inOrder = run(hooking().w, pieces.map(as));
      const reversed = run(hooking().w, [...pieces].reverse().map(as));
      expect(inOrder, type).toEqual(one);
      expect(reversed, type).toEqual(one);
      // (the lift was called off, and a move reached the Goliath on the tick it was given)
      const gNow = one.after.units.find((u) => u.id === g.id)!;
      expect(gNow.lift, type).toBeNull();
      if (type === "move" || type === "attackMove") expect(gNow.order, type).toMatchObject({ type, x: 40.5, y: 36.5 });
    }
  });

  it("splits by hand: the Goliath alone first, its Condors in a later command of the same tick", () => {
    const { w, g, a, b } = hooking();
    const other = [...w.units.values()].filter((u) => u.faction === "blue" && u.kind === "stinger").map((u) => u.id);
    const ref = run(hooking().w, [move([g.id, a.id, b.id, ...other].sort((p, q) => p - q))]);
    // an unrelated command in between changes nothing
    const got = run(w, [move([g.id]), { type: "produce", faction: "blue", buildingId: 9999, unit: "scout" }, move([a.id, b.id, ...other])]);
    expect(got).toEqual(ref);
  });

  it("the newer order wins when the later command names the Goliath again", () => {
    const { w, g, a, b } = hooking();
    step(w, [move([g.id], "blue", 5.5, 5.5), move([g.id, a.id, b.id], "blue", 30.5, 30.5)]);
    expect(g.goliath!.lift).toBeNull();
    expect(g.order).toEqual({ type: "move", x: 30.5, y: 30.5 });
    // and when the later command names only the Condors, the Goliath takes the newest order it ignored
    const h = hooking();
    step(h.w, [move([h.g.id], "blue", 5.5, 5.5), move([h.g.id], "blue", 7.5, 7.5), move([h.a.id], "blue", 30.5, 30.5)]);
    expect(h.g.order).toEqual({ type: "move", x: 7.5, y: 7.5 });
    expect(h.a.order).toEqual({ type: "move", x: 30.5, y: 30.5 });
  });

  it("the Goliath-only order still waits for its Condors, and the memory ends with the tick", () => {
    const { w, g, a, b } = hooking();
    const keys = Object.keys(w).sort();
    step(w, [move([g.id]), { type: "attack", faction: "blue", unitIds: [a.id], targetId: 1 }]);
    expect(g.order).toEqual({ type: "idle" });
    expect(g.goliath!.lift?.phase).toBe("hooking");
    expect(Object.keys(w).sort()).toEqual(keys); // (nothing of the memory is in the world)
    // a later tick's order to its Condors calls the lift off, but the Goliath doesn't take last tick's order
    step(w, [move([a.id, b.id], "blue", 3.5, 3.5)]);
    expect(g.goliath!.lift).toBeNull();
    expect(g.order).toEqual({ type: "idle" });
    expect(a.order).toMatchObject({ type: "move", x: 3.5, y: 3.5 });
    // with no Condor order at all, the lift hooks on and carries it as before
    const h = hooking();
    step(h.w, [move([h.g.id]), move([h.g.id], "blue", 9.5, 9.5)]);
    for (let i = 0; i < 200 && h.g.goliath!.lift?.phase !== "carrying"; i++) step(h.w, []);
    expect(h.g.goliath!.lift?.phase).toBe("carrying");
    expect(h.g.order).toEqual({ type: "idle" });
  });

  it("only its own side's command can call the lift off for it", () => {
    const { w, g, a, b } = hooking();
    step(w, [move([g.id]), move([a.id, b.id], "red")]);
    expect(g.goliath!.lift?.phase).toBe("hooking");
    expect(g.order).toEqual({ type: "idle" });
  });

  it("leaves a carried lift's split orders as they were", () => {
    const carried = () => {
      const h = hooking();
      for (let i = 0; i < 200 && h.g.goliath!.lift?.phase !== "carrying"; i++) step(h.w, []);
      expect(h.g.goliath!.lift?.phase).toBe("carrying");
      return h;
    };
    const one = carried();
    const ref = run(one.w, [move([one.g.id, one.a.id, one.b.id])]);
    const two = carried();
    expect(run(two.w, [move([two.g.id]), move([two.a.id, two.b.id])])).toEqual(ref);
    const three = carried();
    expect(run(three.w, [move([three.a.id, three.b.id]), move([three.g.id])])).toEqual(ref);
    expect(ref.after.units.find((u) => u.id === one.g.id)!.lift).toMatchObject({ phase: "carrying", dest: { x: 40.5, y: 36.5 } });
  });
});
