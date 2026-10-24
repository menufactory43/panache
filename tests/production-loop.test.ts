/**
 * ↻ Production in a loop (Controller.loopProduction): idle producers of a
 * looped kind start the next one while the coal allows, taking their looped
 * kinds in turn, and never get in the way of what the player queues by hand.
 */
import { describe, expect, it } from "vitest";
import { Controller } from "../src/game/controller";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Building, UnitKind, World } from "../src/sim/types";

function setup(scrap = 5000): { w: World; ctrl: Controller; fab: Building } {
  const w = createMapWorld("riverlands", { seed: 5 });
  const ctrl = new Controller(w);
  w.factions.blue.scrap = scrap;
  // a Forge beside the HQ, built at once
  ctrl.enqueue({ type: "startBuilding", faction: "blue", building: "fab-plant" });
  for (let i = 0; i < 2000 && !w.factions.blue.pending?.ready; i++) step(w, ctrl.drainCommands());
  const hq = [...w.buildings.values()].find((b) => b.faction === "blue" && b.kind === "hq")!;
  for (let dy = -6; dy <= 6 && w.factions.blue.pending; dy++)
    for (let dx = -6; dx <= 6 && w.factions.blue.pending; dx++) {
      step(w, [{ type: "placeBuilding", faction: "blue", tx: hq.tx + dx, ty: hq.ty + dy }]);
    }
  const fab = [...w.buildings.values()].find((b) => b.faction === "blue" && b.kind === "fab-plant")!;
  w.factions.blue.scrap = scrap;
  return { w, ctrl, fab };
}
const tick = (w: World, ctrl: Controller, n: number) => {
  for (let i = 0; i < n; i++) {
    ctrl.loopProduction();
    step(w, ctrl.drainCommands());
  }
};
const count = (w: World, kind: UnitKind) => [...w.units.values()].filter((u) => u.faction === "blue" && u.kind === kind).length;

describe("production in a loop", () => {
  it("keeps an idle producer making the looped kind, one at a time", () => {
    const { w, ctrl, fab } = setup();
    expect(fab).toBeDefined();
    const before = count(w, "stinger");
    ctrl.loops.add("stinger");
    let most = 0;
    for (let i = 0; i < 600; i++) {
      tick(w, ctrl, 1);
      most = Math.max(most, fab.queue.length);
    }
    expect(count(w, "stinger") - before).toBeGreaterThanOrEqual(3);
    expect(most).toBe(1);
  });

  it("alternates two looped kinds at one producer", () => {
    const { w, ctrl, fab } = setup();
    ctrl.loops.add("stinger");
    ctrl.loops.add("flak-crawler");
    const started: UnitKind[] = [];
    for (let i = 0; i < 1500; i++) {
      tick(w, ctrl, 1);
      const k = fab.queue[0]?.kind;
      if (k && started[started.length - 1] !== k) started.push(k);
    }
    expect(started.slice(0, 4)).toEqual(["stinger", "flak-crawler", "stinger", "flak-crawler"]);
  });

  it("leaves a producer alone while it has something queued by hand", () => {
    const { w, ctrl, fab } = setup();
    ctrl.loops.add("stinger");
    ctrl.enqueue({ type: "produce", faction: "blue", buildingId: fab.id, unit: "flak-crawler" });
    tick(w, ctrl, 1);
    expect(fab.queue.map((q) => q.kind)).toEqual(["flak-crawler"]);
  });

  it("waits for the coal, and stops when the loop is turned off", () => {
    const { w, ctrl, fab } = setup();
    w.factions.blue.scrap = 0;
    ctrl.loops.add("stinger");
    tick(w, ctrl, 5);
    expect(fab.queue).toHaveLength(0);
    ctrl.loops.delete("stinger");
    w.factions.blue.scrap = 5000;
    tick(w, ctrl, 5);
    expect(fab.queue).toHaveLength(0);
  });
});
