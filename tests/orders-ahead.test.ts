import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, UNITS } from "../src/sim/balance";
import { Controller, buildView, ordersAhead, pickProducer } from "../src/game/controller";
import { modeProgress } from "../src/sim/goliath";
import { step } from "../src/sim/sim";
import type { Command, Unit, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

// The Controller's reads with orders on their way (Controller.ahead(), a duel's interactive feed): the world is
// left as it is (not stepped) after each drain, as a duel's world is for D ticks after the tap. tests/versus-feed.test.ts
// plays the main taps over a real link; these are the smaller reads around them, and the in-flight bookkeeping.

/** A flat 40×40 field with a blue HQ at (4,4) and a red HQ at (32,32). */
function field(): World {
  const w = createWorld(40, 40);
  spawnBuilding(w, "hq", "blue", 4, 4);
  spawnBuilding(w, "hq", "red", 32, 32);
  return w;
}

/** A Controller as a duel's scene has it: its orders, once drained, stay on their way. */
function duel(w: World): Controller {
  const c = new Controller(w);
  c.trackInFlight();
  return c;
}

const anchored = (g: Unit) => {
  g.goliath!.mode = "anchored";
  g.goliath!.modeTicks = 0;
  return g;
};

describe("a duel's Controller reads its own orders on their way as landed", () => {
  it("counts seats promised to squads told to board", () => {
    const w = field();
    const c = duel(w);
    const condor = spawnUnit(w, "condor", "blue", 10, 10);
    const sq = [0, 1, 2].map((i) => spawnUnit(w, "trooper", "blue", 12 + i, 12));
    c.selectUnits([condor.id]);
    for (const s of sq.slice(0, UNITS.condor.capacity!)) {
      c.tapWorld(s.x, s.y, { kind: "ownUnit", id: s.id });
      expect(c.drainCommands()).toEqual([{ type: "board", faction: "blue", unitIds: [s.id], carrierId: condor.id }]);
    }
    // both seats are promised: the third tap selects the squad and says why
    c.tapWorld(sq[2]!.x, sq[2]!.y, { kind: "ownUnit", id: sq[2]!.id });
    expect(c.drainCommands()).toEqual([]);
    expect(c.tip).toBe("Montgolfière pleine : décharge-la d'abord");
    expect([...c.selectedUnits]).toEqual([sq[2]!.id]);
  });

  it("anchors, then packs up on the second ⚓, and the chip reads it digging in from the start", () => {
    const w = field();
    const c = duel(w);
    const g = spawnUnit(w, "goliath", "blue", 14, 14);
    c.selectUnits([g.id]);
    expect(c.toggleAnchor()).toBe("anchor");
    c.drainCommands();
    const [seen] = c.goliathsSelected();
    expect(seen!.goliath!.mode).toBe("anchoring");
    expect(modeProgress(seen!)).toBe(0);
    expect(g.goliath!.mode).toBe("walking"); // (the world's own is untouched)
    expect(c.armyIds()).not.toContain(g.id);
    expect(c.toggleAnchor()).toBe("packUp");
    expect(c.drainCommands()).toEqual([{ type: "packUp", faction: "blue", unitIds: [g.id] }]);
  });

  it("takes units given an order off the idle chip", () => {
    const w = field();
    const c = duel(w);
    const tanks = [spawnUnit(w, "stinger", "blue", 12, 12), spawnUnit(w, "stinger", "blue", 13, 12)];
    spawnUnit(w, "stinger", "blue", 14, 12);
    expect(c.idleArmy()).toHaveLength(3);
    c.selectUnits(tanks.map((t) => t.id));
    c.tapWorld(25.5, 25.5, { kind: "ground" });
    c.drainCommands();
    expect(c.idleArmy()).toHaveLength(1);
    // a stop on its way makes them idle again
    c.stopSelected();
    expect(c.idleArmy()).toHaveLength(3);
  });

  it("stops a Montgolfière sent somewhere to meet squads told to board it", () => {
    const w = field();
    const c = duel(w);
    const condor = spawnUnit(w, "condor", "blue", 10, 10);
    const s = spawnUnit(w, "trooper", "blue", 12, 12);
    c.selectUnits([condor.id]);
    c.tapWorld(30.5, 10.5, { kind: "ground" });
    c.drainCommands();
    c.selectUnits([s.id]);
    c.tapWorld(condor.x, condor.y, { kind: "ownUnit", id: condor.id });
    expect(c.drainCommands().map((k) => k.type)).toEqual(["board", "stop"]);
  });

  it("treats a building being sold as gone: not selected again, no unit queued there, its refund counted", () => {
    const w = field();
    const c = duel(w);
    w.factions.blue.scrap = 0;
    const pad = spawnBuilding(w, "airpad", "blue", 12, 4);
    c.tapWorld(pad.tx + 1, pad.ty + 1, { kind: "ownBuilding", id: pad.id });
    expect(c.selectedBuilding).toBe(pad.id);
    c.sellSelected();
    c.drainCommands();
    c.tapWorld(pad.tx + 1, pad.ty + 1, { kind: "ownBuilding", id: pad.id });
    expect(c.selectedBuilding).toBeNull();
    const v = c.view();
    expect(v.scrap).toBe(Math.floor(BUILDINGS.airpad.cost * ECONOMY.sellRefund));
    expect(v.closed(pad.id)).toBe(true);
    expect(pickProducer(w, "condor", c.selectedUnits, v)).toBeNull();
  });

  it("treats an anchored Gargantua packing up as no barracks, and a tap on the map moves it", () => {
    const w = field();
    const c = duel(w);
    const g = anchored(spawnUnit(w, "goliath", "blue", 14, 14));
    expect(pickProducer(w, "trooper", c.selectedUnits, c.view())?.id).toBe(g.id);
    c.selectUnits([g.id]);
    expect(c.toggleAnchor()).toBe("packUp");
    c.drainCommands();
    expect(pickProducer(w, "trooper", c.selectedUnits, c.view())).toBeNull();
    c.tapWorld(25.5, 25.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "attackMove", faction: "blue", unitIds: [g.id], x: 25.5, y: 25.5 }]);
  });

  it("shows a rally point on its way", () => {
    const w = field();
    const c = duel(w);
    const pad = spawnBuilding(w, "airpad", "blue", 12, 4);
    c.tapWorld(pad.tx + 1, pad.ty + 1, { kind: "ownBuilding", id: pad.id });
    c.tapWorld(20.5, 20.5, { kind: "ground" });
    c.drainCommands();
    expect(pad.rally).toBeNull();
    expect(c.ahead().rally(pad.id)).toEqual({ x: 20.5, y: 20.5 });
  });

  it("reads orders not even drained yet (a stall drains nothing)", () => {
    const w = field();
    const c = duel(w);
    const g = spawnUnit(w, "goliath", "blue", 14, 14);
    c.selectUnits([g.id]);
    expect(c.toggleAnchor()).toBe("anchor");
    expect(c.toggleAnchor()).toBe("packUp");
  });

  it("changes nothing in single player: the world is read as it is", () => {
    const w = field();
    const c = new Controller(w);
    const g = spawnUnit(w, "goliath", "blue", 14, 14);
    c.selectUnits([g.id]);
    expect(c.toggleAnchor()).toBe("anchor");
    // (the next tick has it: until then the world says walking, as before)
    expect(c.toggleAnchor()).toBe("anchor");
    expect(c.ahead().unit(g)).toBe(g);
    c.drainCommands();
    expect(c.inFlight).toBeNull();
    expect(c.ahead().unit(g)).toBe(g);
  });
});

describe("orders in flight come off", () => {
  const move = (ids: number[], x = 20.5): Extract<Command, { type: "move" }> => ({ type: "move", faction: "blue", unitIds: ids, x, y: 20.5 });

  it("as each piece of a split unit list lands, and only the order that landed", () => {
    const w = field();
    const c = duel(w);
    const ids = [0, 1, 2, 3].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10).id);
    c.enqueue(move(ids));
    c.enqueue(move(ids.slice(0, 2), 30.5));
    c.drainCommands();
    // the codec's canonical point (the 1/16-tile cell's centre), the first piece only
    c.landed([{ type: "move", faction: "blue", unitIds: ids.slice(0, 2), x: 20.53125, y: 20.53125 }]);
    expect(c.inFlight).toEqual([move(ids.slice(2)), move(ids.slice(0, 2), 30.5)]);
    c.landed([{ ...move(ids.slice(2)), x: 20.53125, y: 20.53125 }]);
    expect(c.inFlight).toEqual([move(ids.slice(0, 2), 30.5)]);
  });

  it("when the feed knows it never will (replaced while it waited in the lockstep's queue)", () => {
    const w = field();
    const c = duel(w);
    const a = spawnUnit(w, "stinger", "blue", 10, 10).id;
    c.enqueue(move([a]));
    c.drainCommands(); // (tick 0)
    w.tick = 3;
    c.enqueue(move([a], 30.5));
    c.drainCommands(); // (tick 3: it replaced the first in the queue, which never goes out)
    c.landed([{ ...move([a], 30.53125), y: 20.53125 }]);
    expect(c.inFlight).toEqual([move([a])]);
    c.settled(2);
    expect(c.inFlight).toEqual([]);
  });

  it("all at once when the match ends with no result", () => {
    const w = field();
    const c = duel(w);
    c.enqueue({ type: "startBuilding", faction: "blue", building: "fab-plant" });
    c.drainCommands();
    c.dropInFlight();
    expect(c.inFlight).toEqual([]);
    expect(c.view().pending).toBeNull();
  });
});

describe("ordersAhead", () => {
  it("is the world itself with no orders, and never touches the world's units", () => {
    const w = field();
    const g = spawnUnit(w, "goliath", "blue", 14, 14);
    expect(ordersAhead(w, null).unit(g)).toBe(g);
    expect(ordersAhead(w, []).unit(g)).toBe(g);
    const before = structuredClone(g);
    const a = ordersAhead(w, [{ type: "anchor", faction: "blue", unitIds: [g.id] }]);
    expect(a.unit(g).goliath!.mode).toBe("anchoring");
    expect(g).toEqual(before);
  });

  it("applies the sim's rules, in order: an order naming a hooking lift's Montgolfières calls it off", () => {
    const w = field();
    const g = spawnUnit(w, "goliath", "blue", 14, 14);
    const [a, b] = [spawnUnit(w, "condor", "blue", 16, 14), spawnUnit(w, "condor", "blue", 17, 14)] as [Unit, Unit];
    const lift: Command = { type: "lift", faction: "blue", unitIds: [a.id, b.id], goliathId: g.id };
    const up = ordersAhead(w, [lift]);
    expect(up.unit(g).goliath!.lift).toMatchObject({ carriers: [a.id, b.id], phase: "hooking" });
    expect(up.liftOf(a)?.id).toBe(g.id);
    // the Goliath alone waits for its Condors; naming them calls the lift off
    expect(ordersAhead(w, [lift, { type: "move", faction: "blue", unitIds: [g.id], x: 5.5, y: 5.5 }]).unit(g).goliath!.lift).not.toBeNull();
    const off = ordersAhead(w, [lift, { type: "stop", faction: "blue", unitIds: [a.id, b.id, g.id] }]);
    expect(off.unit(g).goliath!.lift).toBeNull();
    expect(off.liftOf(a)).toBeNull();
    expect(off.unit(a).order.type).toBe("idle");
    // the same orders, stepped, leave the world the same way
    step(w, [lift]);
    step(w, [{ type: "stop", faction: "blue", unitIds: [a.id, b.id, g.id] }]);
    expect(g.goliath!.lift).toBeNull();
    expect(a.order.type).toBe("idle");
  });

  it("leaves a lift called off by its Montgolfières' order to take that order, whichever is named first, as the sim does", () => {
    const w = field();
    // (the Condors' ids before the Gargantua's: the order names them first)
    const [a, b] = [spawnUnit(w, "condor", "blue", 16, 14), spawnUnit(w, "condor", "blue", 17, 14)] as [Unit, Unit];
    const g = spawnUnit(w, "goliath", "blue", 14, 14);
    step(w, [{ type: "lift", faction: "blue", unitIds: [a.id, b.id], goliathId: g.id }]);
    expect(g.goliath!.lift?.phase).toBe("hooking");
    const move: Command = { type: "move", faction: "blue", unitIds: [a.id, b.id, g.id], x: 30.5, y: 30.5 };
    const seen = ordersAhead(w, [move]);
    step(w, [move]);
    for (const u of [a, b, g]) {
      expect(seen.unit(u).order).toEqual({ type: "move", x: 30.5, y: 30.5 });
      expect(u.order.type).toBe("move");
    }
    expect(seen.unit(g).goliath!.lift).toBeNull();
  });

  it("matches the build bar's view of a sale (buildView)", () => {
    const w = field();
    w.factions.blue.scrap = 1000;
    const pad = spawnBuilding(w, "airpad", "blue", 12, 4);
    const orders: Command[] = [
      { type: "produce", faction: "blue", buildingId: pad.id, unit: "condor" },
      { type: "sell", faction: "blue", buildingId: pad.id },
      { type: "produce", faction: "blue", buildingId: pad.id, unit: "condor" }
    ];
    const v = buildView(w, "blue", orders);
    step(w, orders);
    expect(w.buildings.has(pad.id)).toBe(false);
    expect(v.scrap).toBe(w.factions.blue.scrap);
    expect(v.extra(pad.id)).toBe(0);
  });
});
