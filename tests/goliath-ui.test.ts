import { describe, expect, it } from "vitest";
import { GOLIATH } from "../src/sim/balance";
import { unitBlocker } from "../src/sim/economy";
import { createMapWorld } from "../src/sim/maps";
import type { Unit, World } from "../src/sim/types";
import { createWorld, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";
import { Controller, isRooted, pickProducer } from "../src/game/controller";
import { homeBox, startBox } from "../src/game/framing";
import { zoneAt } from "../src/game/placement-view";

/** A flat 40×40 field with a blue HQ at (4,4) and a red HQ at (32,32). */
function field(): World {
  const w = createWorld(40, 40);
  spawnBuilding(w, "hq", "blue", 4, 4);
  spawnBuilding(w, "hq", "red", 32, 32);
  return w;
}

/** Dig a Goliath in where it stands (as the sim leaves it once anchoring is done). */
const anchored = (g: Unit, mode: "anchoring" | "anchored" | "packing" = "anchored") => {
  g.goliath!.mode = mode;
  g.goliath!.modeTicks = mode === "anchored" ? 0 : 20;
  return g;
};

/** Hook Condors a and b onto Goliath g (as the sim's lift command does), still hooking or already carrying. */
const hook = (g: Unit, a: Unit, b: Unit, phase: "hooking" | "carrying" = "hooking") => {
  for (const c of [a, b]) c.order = { type: "lift", goliathId: g.id };
  g.goliath!.lift = { carriers: [a.id, b.id], phase, dest: null, setDown: false };
};

describe("Gargantua orders from taps", () => {
  it("a ground tap with only anchored Gargantuas selected sets their rally point, it doesn't pack them up", () => {
    const w = field();
    const c = new Controller(w);
    const g = anchored(spawnUnit(w, "goliath", "blue", 12, 12));
    c.selectUnits([g.id]);
    c.tapWorld(20.5, 14.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "rally", faction: "blue", buildingId: g.id, x: 20.5, y: 14.5 }]);
    expect(c.lastFeedback?.kind).toBe("rally");
    expect(c.tip).toMatch(/lève l'ancre d'abord \(G\)/i);
    // one still digging in counts as dug in
    anchored(g, "anchoring");
    c.tip = null;
    c.tapWorld(21.5, 14.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "rally", faction: "blue", buildingId: g.id, x: 21.5, y: 14.5 }]);
    expect(c.tip).toBeNull(); // (the same lesson isn't repeated straight away)
  });

  it("in a group, the army marches and the anchored Gargantua stays put", () => {
    const w = field();
    const c = new Controller(w);
    const g = anchored(spawnUnit(w, "goliath", "blue", 12, 12));
    const tank = spawnUnit(w, "stinger", "blue", 14, 12);
    const harv = spawnUnit(w, "harvester", "blue", 15, 12);
    c.selectUnits([g.id, tank.id, harv.id]);
    c.tapWorld(25.5, 20.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([
      { type: "move", faction: "blue", unitIds: [harv.id], x: 25.5, y: 20.5 },
      { type: "attackMove", faction: "blue", unitIds: [tank.id], x: 25.5, y: 20.5 }
    ]);
    expect(c.lastFeedback?.kind).toBe("move");
    expect(c.tip).toMatch(/reste en place/);
    // the same with a long-press (it isn't a drop: nothing is aboard anything)
    expect(c.dropAt(25.5, 20.5)).toBe(false);
  });

  it("a Gargantua packing up takes the move: it walks once it is free", () => {
    const w = field();
    const c = new Controller(w);
    const g = anchored(spawnUnit(w, "goliath", "blue", 12, 12), "packing");
    expect(isRooted(g)).toBe(false);
    c.selectUnits([g.id]);
    c.tapWorld(25.5, 20.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "attackMove", faction: "blue", unitIds: [g.id], x: 25.5, y: 20.5 }]);
  });

  it("⚔ Select army leaves anchored Gargantuas at their posts, and 💤 Idle never lists a busy one", () => {
    const w = field();
    const c = new Controller(w);
    const walker = spawnUnit(w, "goliath", "blue", 12, 12);
    const dug = anchored(spawnUnit(w, "goliath", "blue", 20, 12));
    const packing = anchored(spawnUnit(w, "goliath", "blue", 28, 12), "packing");
    const tank = spawnUnit(w, "stinger", "blue", 14, 14);
    c.selectArmy();
    expect([...c.selectedUnits]).toEqual([walker.id, packing.id, tank.id]);
    expect(c.armyIds()).not.toContain(dug.id);
    expect(c.idleArmy()).toEqual([walker.id, tank.id]);
  });

  it("G anchors walking Gargantuas, packs up anchored ones, and says why when the ground won't take it", () => {
    const w = field();
    const c = new Controller(w);
    const g = spawnUnit(w, "goliath", "blue", 15, 15);
    c.selectUnits([g.id]);
    expect(c.toggleAnchor()).toBe("anchor");
    expect(c.drainCommands()).toEqual([{ type: "anchor", faction: "blue", unitIds: [g.id] }]);
    expect(c.lastFeedback?.kind).toBe("anchor");
    // a tank parked under its feet
    const tank = spawnUnit(w, "stinger", "blue", 15.2, 15.2);
    expect(c.toggleAnchor()).toBeNull();
    expect(c.tip).toBe("Impossible d'ancrer ici : une unité gêne");
    expect(c.drainCommands()).toEqual([]);
    w.units.delete(tank.id);
    anchored(g);
    expect(c.toggleAnchor()).toBe("packUp");
    expect(c.drainCommands()).toEqual([{ type: "packUp", faction: "blue", unitIds: [g.id] }]);
    // a mixed pair: the walker anchors first, then both pack up
    const other = spawnUnit(w, "goliath", "blue", 25, 15);
    c.selectUnits([g.id, other.id]);
    expect(c.toggleAnchor()).toBe("anchor");
    expect(c.drainCommands()).toEqual([{ type: "anchor", faction: "blue", unitIds: [other.id] }]);
    c.spectator = true;
    expect(c.toggleAnchor()).toBeNull();
  });
});

describe("the two-Montgolfière lift from taps", () => {
  /** A walking Goliath at (20, 20), two empty Condors near it, a third further off and a tank. */
  function pad() {
    const w = field();
    const c = new Controller(w);
    const g = spawnUnit(w, "goliath", "blue", 20, 20);
    const near = spawnUnit(w, "condor", "blue", 22, 20);
    const mid = spawnUnit(w, "condor", "blue", 24, 20);
    const far = spawnUnit(w, "condor", "blue", 30, 20);
    const tank = spawnUnit(w, "stinger", "blue", 12, 12);
    return { w, c, g, near, mid, far, tank };
  }

  it("two or more empty Montgolfières selected + tap the Gargantua: the two nearest hook on, and the lift is the selection", () => {
    const { c, g, near, mid, far, tank } = pad();
    c.selectUnits([far.id, mid.id, near.id, tank.id]);
    c.tapWorld(20, 20, { kind: "ownUnit", id: g.id });
    expect(c.drainCommands()).toEqual([{ type: "lift", faction: "blue", unitIds: [near.id, mid.id], goliathId: g.id }]);
    expect([...c.selectedUnits]).toEqual([near.id, mid.id, g.id]);
    expect(c.lastFeedback).toEqual({ kind: "board", x: 20, y: 20 });
  });

  it("says why not, and selects the Gargantua: one Montgolfière, Montgolfières with squads aboard, a Gargantua dug in", () => {
    const { w, c, g, near, mid } = pad();
    c.selectUnits([near.id]);
    c.tapWorld(20, 20, { kind: "ownUnit", id: g.id });
    expect(c.drainCommands()).toEqual([]);
    expect(c.tip).toBe("Deux Montgolfières vides portent un Gargantua");
    expect([...c.selectedUnits]).toEqual([g.id]);
    const squad = spawnUnit(w, "trooper", "blue", 5, 5);
    w.units.delete(squad.id);
    mid.passengers!.push(squad);
    c.selectUnits([near.id, mid.id]);
    c.tapWorld(20, 20, { kind: "ownUnit", id: g.id });
    expect(c.tip).toBe("Décharge d'abord les Montgolfières");
    mid.passengers = [];
    anchored(g);
    c.selectUnits([near.id, mid.id]);
    c.tapWorld(20, 20, { kind: "ownUnit", id: g.id });
    expect(c.tip).toBe("Lève l'ancre d'abord (G)");
    expect(c.drainCommands()).toEqual([]);
  });

  it("orders given while the Montgolfières hook on wait for take-off (an order to them would call it off)", () => {
    const { c, g, near, mid } = pad();
    hook(g, near, mid);
    c.selectUnits([near.id, mid.id, g.id]);
    c.tapWorld(10.5, 30.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([]);
    expect(c.lastFeedback?.kind).toBe("move");
    c.prune();
    expect(c.drainCommands()).toEqual([]); // still hooking on
    g.goliath!.lift!.phase = "carrying";
    c.prune();
    expect(c.drainCommands()).toEqual([{ type: "move", faction: "blue", unitIds: [g.id], x: 10.5, y: 30.5 }]);
    c.prune();
    expect(c.drainCommands()).toEqual([]); // (once)
  });

  it("carried: a tap flies it, a long-press sets it down there, ⇣ / U sets it down where it hovers", () => {
    const { c, g, near, mid, tank } = pad();
    hook(g, near, mid, "carrying");
    c.selectUnits([near.id, mid.id, g.id, tank.id]);
    expect(c.liftsSelected()).toEqual([g]);
    c.tapWorld(10.5, 30.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([
      { type: "move", faction: "blue", unitIds: [g.id], x: 10.5, y: 30.5 },
      { type: "attackMove", faction: "blue", unitIds: [tank.id], x: 10.5, y: 30.5 }
    ]);
    expect(c.dropAt(12.5, 28.5)).toBe(true);
    expect(c.drainCommands()).toEqual([
      { type: "unload", faction: "blue", unitIds: [g.id], x: 12.5, y: 28.5 },
      { type: "attackMove", faction: "blue", unitIds: [tank.id], x: 12.5, y: 28.5 }
    ]);
    expect(c.lastFeedback?.kind).toBe("drop");
    expect(c.unloadSelected()).toBe(true);
    expect(c.drainCommands()).toEqual([{ type: "unload", faction: "blue", unitIds: [g.id] }]);
    // the lifted Goliath on its own flies the lift the same way
    c.selectUnits([g.id]);
    c.tapWorld(8.5, 8.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "move", faction: "blue", unitIds: [g.id], x: 8.5, y: 8.5 }]);
    // Stop: the sim hovers it
    c.stopSelected();
    expect(c.drainCommands()).toEqual([{ type: "stop", faction: "blue", unitIds: [g.id] }]);
  });

  it("a long-press with a lift still hooking on sets it down once it's up", () => {
    const { c, g, near, mid } = pad();
    hook(g, near, mid);
    c.selectUnits([near.id, mid.id, g.id]);
    expect(c.unloadSelected()).toBe(false); // (nothing in the air yet)
    expect(c.dropAt(30.5, 30.5)).toBe(true);
    expect(c.drainCommands()).toEqual([]);
    g.goliath!.lift!.phase = "carrying";
    c.prune();
    expect(c.drainCommands()).toEqual([{ type: "unload", faction: "blue", unitIds: [g.id], x: 30.5, y: 30.5 }]);
    // called off before take-off: the waiting order is dropped
    hook(g, near, mid);
    c.dropAt(5.5, 30.5);
    g.goliath!.lift = null;
    c.prune();
    expect(c.drainCommands()).toEqual([]);
  });
});

describe("training from an anchored Gargantua", () => {
  it("queues on a selected anchored Gargantua first, else the shortest queue (buildings first on a tie)", () => {
    const w = field();
    const bay = spawnBuilding(w, "assembly-bay", "blue", 10, 4);
    const g = anchored(spawnUnit(w, "goliath", "blue", 20, 20));
    const walker = spawnUnit(w, "goliath", "blue", 25, 20);
    const none = new Set<number>();
    expect(pickProducer(w, "trooper", none)?.id).toBe(bay.id);
    expect(pickProducer(w, "trooper", new Set([g.id]))?.id).toBe(g.id);
    bay.queue.push({ kind: "trooper", remaining: 100 });
    expect(pickProducer(w, "trooper", none)?.id).toBe(g.id);
    // a walking Goliath doesn't train
    expect(pickProducer(w, "trooper", new Set([walker.id]))?.id).toBe(g.id);
    // the selected one full: the others take it
    while (g.goliath!.queue.length < 6) g.goliath!.queue.push({ kind: "trooper", remaining: 100 });
    expect(pickProducer(w, "trooper", new Set([g.id]))?.id).toBe(bay.id);
    while (bay.queue.length < 6) bay.queue.push({ kind: "trooper", remaining: 100 });
    expect(pickProducer(w, "trooper", new Set([g.id]))).toBeNull();
    // no Bay at all: the Goliath is the barracks
    w.buildings.delete(bay.id);
    g.goliath!.queue.length = 0;
    expect(pickProducer(w, "rocket-squad", none)?.id).toBe(g.id);
  });

  it("under Nomads, Harvesters queue on the anchored Gargantua, and a ground tap gives it a rally point", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    expect(hqOf(w, "blue")).toBeNull();
    const g = [...w.units.values()].find((u) => u.goliath && u.faction === "blue")!;
    expect(isRooted(g)).toBe(true);
    expect(unitBlocker(w, "blue", "harvester")).toBeNull();
    expect(pickProducer(w, "harvester", new Set())?.id).toBe(g.id);
    expect(pickProducer(w, "trooper", new Set())?.id).toBe(g.id);
    const c = new Controller(w);
    c.selectUnits([g.id]);
    c.tapWorld(g.x + 4.5, g.y, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "rally", faction: "blue", buildingId: g.id, x: g.x + 4.5, y: g.y }]);
    // the opening shot frames the Goliath, the base that walks
    const box = homeBox(w, "blue")!;
    expect((box.x0 + box.x1) / 2).toBeCloseTo(g.x);
    expect((box.y0 + box.y1) / 2).toBeCloseTo(g.y);
    expect(startBox(w, "blue")).not.toBeNull();
  });

  it("a Gantry holds one Gargantua at a time", () => {
    const w = field();
    const gantry = spawnBuilding(w, "gantry", "blue", 10, 10);
    expect(pickProducer(w, "goliath", new Set())?.id).toBe(gantry.id);
    gantry.queue.push({ kind: "goliath", remaining: 100, paid: 1600 });
    expect(pickProducer(w, "goliath", new Set())).toBeNull();
  });
});

describe("outposts: the build zone", () => {
  it("is base range plus the rings of anchored Gargantuas (anything but an HQ), outposts never counting", () => {
    const w = field();
    // blue HQ at (4,4)–(7,7): base range reaches a few tiles past it
    expect(zoneAt(w, "blue", "turret", 9, 5)).toBe(1);
    expect(zoneAt(w, "blue", "turret", 25, 5)).toBe(0);
    const g = spawnUnit(w, "goliath", "blue", 25, 6);
    expect(zoneAt(w, "blue", "turret", 25, 5)).toBe(0); // (walking: no ring)
    anchored(g);
    expect(zoneAt(w, "blue", "turret", 25, 5)).toBe(2);
    expect(zoneAt(w, "blue", "turret", 25 + GOLIATH.buildRing + 1, 6)).toBe(0);
    expect(zoneAt(w, "blue", "hq", 25, 5)).toBe(0);
    expect(zoneAt(w, "red", "turret", 25, 5)).toBe(0); // (ours, not theirs)
    // an outpost out there doesn't extend the zone once the Goliath moves on
    const depot = spawnBuilding(w, "depot", "blue", 26, 8);
    depot.outpost = true;
    g.goliath!.mode = "walking";
    expect(zoneAt(w, "blue", "turret", 27, 11)).toBe(0);
    depot.outpost = false; // (a normal building there would)
    expect(zoneAt(w, "blue", "turret", 27, 11)).toBe(1);
  });
});
