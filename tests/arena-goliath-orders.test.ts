import { describe, expect, it } from "vitest";
import { frameOf } from "../src/arena/frame";
import { parseOrders, suggestSpot } from "../src/arena/orders";
import { GOLIATH, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { goliathsOf } from "../src/sim/goliath";
import { createMapWorld } from "../src/sim/maps";
import { DEFAULT_RULES } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import { stowAboard } from "../src/sim/transport";
import { Terrain, type Faction, type Unit, type World } from "../src/sim/types";
import { createWorld, domainOf, setTerrain, spawnUnit } from "../src/sim/world";

function field(): { w: World; g: Unit; enemy: Unit } {
  const w = createWorld(60, 60);
  w.rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], startUnits: [], mutators: [], armada: true, fogOff: true, hqTrickle: 0 };
  const g = spawnUnit(w, "goliath", "blue", 20.5, 20.5);
  const enemy = spawnUnit(w, "goliath", "red", 50.5, 50.5);
  w.factions.blue.scrap = 5000;
  return { w, g, enemy };
}

function advanceUntil(w: World, done: () => boolean, maxTicks = 300): void {
  for (let n = 0; n < maxTicks && !done(); n++) step(w, []);
  expect(done(), `condition reached within ${maxTicks} ticks`).toBe(true);
}

function accepted(w: World, orders: unknown[], side: Faction = "blue") {
  const batch = parseOrders(w, side, orders, "play");
  expect(batch.results).toHaveLength(orders.length);
  for (const result of batch.results) expect(result).toMatch(/^\d+\. ok:/);
  return batch;
}

function anchored(): { w: World; g: Unit; enemy: Unit } {
  const setup = field();
  step(setup.w, [{ type: "anchor", faction: "blue", unitIds: [setup.g.id] }]);
  advanceUntil(setup.w, () => setup.g.goliath!.mode === "anchored");
  return setup;
}

function armada(side: Faction = "blue") {
  const w = createMapWorld("riverlands", { seed: 42, mutators: ["armada"] });
  const g = goliathsOf(w, side)[0]!;
  const carriers = g.goliath!.lift!.carriers.map((id) => w.units.get(id)!);
  return { w, g, carriers };
}

describe("arena Gargantua modes", () => {
  it.each(["pack_up", "pack"])("anchors and %s through both staging and simulation", (pack) => {
    const { w, g } = field();
    const staged = structuredClone(w);
    const anchor = accepted(staged, [{ anchor: [g.id] }]);
    expect(anchor.commands).toEqual([{ type: "anchor", faction: "blue", unitIds: [g.id] }]);
    expect(staged.units.get(g.id)!.goliath!.mode).toBe("anchoring");
    expect(g.goliath!.mode).toBe("walking");
    step(w, anchor.commands);
    advanceUntil(w, () => g.goliath!.mode === "anchored", GOLIATH.anchorTime * TICK_RATE + 1);

    const packed = structuredClone(w);
    const batch = accepted(packed, [{ [pack]: [g.id] }]);
    expect(batch.commands).toEqual([{ type: "packUp", faction: "blue", unitIds: [g.id] }]);
    expect(packed.units.get(g.id)!.goliath!.mode).toBe("packing");
    step(w, batch.commands);
    advanceUntil(w, () => g.goliath!.mode === "walking", GOLIATH.packTime * TICK_RATE + 1);
    expect(g.goliath!.foot).toBeNull();
  });

  it("refuses enemy units, ordinary units, blocked ground, and invalid mode transitions", () => {
    const { w, g, enemy } = field();
    const trooper = spawnUnit(w, "trooper", "blue", 10.5, 10.5);
    setTerrain(w, 20, 20, Terrain.Water);
    const batch = parseOrders(w, "blue", [{ anchor: [enemy.id] }, { anchor: [trooper.id] }, { anchor: [g.id] }, { pack_up: [g.id] }], "play");
    expect(batch.commands).toEqual([]);
    expect(batch.results).toHaveLength(4);
    for (const result of batch.results) expect(result).toContain("refused:");
    expect(batch.results[2]).toMatch(/sol|Bloqué/i);
    expect(batch.results[3]).toMatch(/pas ancré/i);
    expect(g.goliath!.mode).toBe("walking");

    const lifted = armada();
    const blocked = parseOrders(lifted.w, "blue", [{ anchor: [lifted.g.id] }], "play");
    expect(blocked.commands).toEqual([]);
    expect(blocked.results[0]).toMatch(/refused:.*levage/i);
  });

  it("uses the staged mode to reject duplicate anchoring and packing", () => {
    const { w, g } = field();
    const batch = parseOrders(w, "blue", [{ anchor: [g.id] }, { anchor: [g.id] }, { pack_up: [g.id] }, { pack_up: [g.id] }], "play");
    expect(batch.commands.map((c) => c.type)).toEqual(["anchor", "packUp"]);
    expect(batch.results[1]).toMatch(/refused:.*ancré/i);
    expect(batch.results[3]).toMatch(/refused:.*ancre/i);
  });
});

describe("arena Gargantua lifts", () => {
  it("hooks two own Montgolfières onto a walking Gargantua", () => {
    const { w, g } = field();
    const a = spawnUnit(w, "condor", "blue", 17.5, 18.5);
    const b = spawnUnit(w, "condor", "blue", 23.5, 18.5);
    const staged = structuredClone(w);
    const batch = accepted(staged, [{ lift: [a.id, b.id], goliath: g.id }]);
    expect(batch.commands).toEqual([{ type: "lift", faction: "blue", unitIds: [a.id, b.id], goliathId: g.id }]);
    expect(staged.units.get(g.id)!.goliath!.lift).toMatchObject({ phase: "hooking", carriers: [a.id, b.id] });
    for (const c of [a, b]) expect(staged.units.get(c.id)!.order).toEqual({ type: "lift", goliathId: g.id });
    expect(g.goliath!.lift).toBeNull();
    step(w, batch.commands);
    advanceUntil(w, () => g.goliath!.lift?.phase === "carrying");
    expect(domainOf(g)).toBe("air");
  });

  it("rejects enemy targets, too few carriers, loaded carriers, and anchored targets", () => {
    const { w, g, enemy } = field();
    const a = spawnUnit(w, "condor", "blue", 17.5, 18.5);
    const b = spawnUnit(w, "condor", "blue", 23.5, 18.5);
    const enemyCarrier = spawnUnit(w, "condor", "red", 45.5, 45.5);
    const invalid = [
      { lift: [a.id, b.id], goliath: enemy.id },
      { lift: [a.id, enemyCarrier.id], goliath: g.id },
      { lift: [a.id], goliath: g.id }
    ];
    const batch = parseOrders(w, "blue", invalid, "play");
    expect(batch.commands).toEqual([]);
    for (const result of batch.results) expect(result).toContain("refused:");
    stowAboard(w, b, spawnUnit(w, "trooper", "blue", b.x, b.y));
    const loaded = parseOrders(w, "blue", [{ lift: [a.id, b.id], goliath: g.id }], "play");
    expect(loaded.commands).toEqual([]);
    expect(loaded.results[0]).toContain("refused:");

    const base = anchored();
    const c = spawnUnit(base.w, "condor", "blue", 17.5, 18.5);
    const d = spawnUnit(base.w, "condor", "blue", 23.5, 18.5);
    const anchoredBatch = parseOrders(base.w, "blue", [{ lift: [c.id, d.id], goliath: base.g.id }], "play");
    expect(anchoredBatch.commands).toEqual([]);
    expect(anchoredBatch.results[0]).toMatch(/refused:.*lève l'ancre/i);
  });

  it.each(["goliath", "first Montgolfière", "second Montgolfière"])("lands an initial Armada lift by addressing its %s", (member) => {
    const { w, g, carriers } = armada();
    const id = member === "goliath" ? g.id : carriers[member === "first Montgolfière" ? 0 : 1]!.id;
    const staged = structuredClone(w);
    const batch = accepted(staged, [{ unload: [id] }]);
    expect(batch.commands).toEqual([{ type: "unload", faction: "blue", unitIds: [id] }]);
    expect(staged.units.get(g.id)!.goliath!.lift).toMatchObject({ phase: "carrying", setDown: true });
    for (const c of carriers) expect(staged.units.get(c.id)!.order).toEqual({ type: "lift", goliathId: g.id });
    step(w, batch.commands);
    advanceUntil(w, () => !g.goliath!.lift);
    expect(domainOf(g)).toBe("ground");
    expect(g.hp).toBe(UNITS.goliath.hp);
    for (const c of carriers) expect(c.order.type).not.toBe("lift");
  });

  it.each(["blue", "red"] as const)("translates %s's destination and preserves lift linkage across move, stop and unload", (side) => {
    const { w, g, carriers } = armada(side);
    const staged = structuredClone(w);
    const destination = frameOf(w, side).center(20, 25);
    const move = accepted(staged, [{ move: [carriers[0]!.id], to: [20, 25] }], side);
    const sg = staged.units.get(g.id)!;
    expect(sg.goliath!.lift!.dest).toEqual(destination);
    for (const c of carriers) expect(staged.units.get(c.id)!.order).toEqual({ type: "lift", goliathId: g.id });
    const oldPosition = [g.x, g.y];
    step(w, move.commands);
    expect([g.x, g.y]).not.toEqual(oldPosition);
    expect(g.goliath!.lift?.phase).toBe("carrying");

    const stop = accepted(staged, [{ stop: [carriers[1]!.id] }], side);
    expect(sg.goliath!.lift!.dest).toBeNull();
    for (const c of carriers) expect(staged.units.get(c.id)!.order).toEqual({ type: "lift", goliathId: g.id });
    const stoppedAt = [g.x, g.y];
    step(w, stop.commands);
    expect([g.x, g.y]).toEqual(stoppedAt);
    const unload = accepted(staged, [{ unload: [carriers[0]!.id], at: [20, 25] }], side);
    expect(unload.commands[0]).toMatchObject({ type: "unload", x: destination.x, y: destination.y });
    expect(sg.goliath!.lift).toMatchObject({ dest: destination, setDown: true });
  });

  it("still unloads ordinary infantry from a Montgolfière", () => {
    const { w } = field();
    const c = spawnUnit(w, "condor", "blue", 10.5, 10.5);
    const squad = spawnUnit(w, "trooper", "blue", 10.5, 10.5);
    stowAboard(w, c, squad);
    const batch = accepted(structuredClone(w), [{ unload: [c.id], at: [12, 12] }]);
    step(w, batch.commands);
    advanceUntil(w, () => w.units.has(squad.id));
    expect(c.passengers).toHaveLength(0);
    expect(w.units.get(squad.id)!.hp).toBe(UNITS.trooper.hp);
  });

  it("refuses boarding a carrying Montgolfière after staging a move", () => {
    const { w, g, carriers } = armada();
    const carrier = carriers[0]!;
    const squad = spawnUnit(w, "trooper", "blue", carrier.x, carrier.y);
    const staged = structuredClone(w);
    const batch = parseOrders(staged, "blue", [
      { move: [carrier.id], to: [20, 25] },
      { board: [squad.id], condor: carrier.id }
    ], "play");
    expect(batch.results[0]).toContain("ok:");
    expect(batch.results[1]).toContain("refused:");
    expect(batch.commands.map((c) => c.type)).toEqual(["move"]);
    expect(staged.units.get(carrier.id)!.order).toEqual({ type: "lift", goliathId: g.id });
    expect(staged.units.get(squad.id)!.order).toEqual({ type: "idle" });
    expect(staged.units.get(carrier.id)!.passengers).toHaveLength(0);
  });
});

describe("arena Gargantua production and placement", () => {
  it.each([
    ["harvester", true], ["harvester", false], ["trooper", true], ["trooper", false]
  ] as const)("queues and cancels %s with explicit producer = %s", (kind, explicit) => {
    const { w, g } = anchored();
    const before = w.factions.blue.scrap;
    const staged = structuredClone(w);
    const produce = accepted(staged, [{ produce: kind, ...(explicit ? { at: g.id } : {}) }]);
    expect(produce.commands).toEqual([{ type: "produce", faction: "blue", buildingId: g.id, unit: kind }]);
    expect(staged.units.get(g.id)!.goliath!.queue.map((q) => q.kind)).toEqual([kind]);
    expect(staged.factions.blue.scrap).toBe(before - UNITS[kind].cost);
    step(w, produce.commands);
    expect(g.goliath!.queue.map((q) => q.kind)).toEqual([kind]);
    expect(w.factions.blue.scrap).toBe(before - UNITS[kind].cost);

    const updated = structuredClone(w);
    const cancel = accepted(updated, [{ rally: g.id, to: [25, 25] }, { cancel: kind, ...(explicit ? { at: g.id } : {}) }]);
    expect(updated.units.get(g.id)!.goliath!.rally).toEqual({ x: 25.5, y: 25.5 });
    expect(updated.units.get(g.id)!.goliath!.queue).toHaveLength(0);
    expect(updated.factions.blue.scrap).toBe(before);
    step(w, cancel.commands);
    expect(g.goliath!.rally).toEqual({ x: 25.5, y: 25.5 });
    expect(g.goliath!.queue).toHaveLength(0);
    expect(w.factions.blue.scrap).toBe(before);
  });

  it("finishes an accepted Gargantua production order", () => {
    const { w, g } = anchored();
    const batch = accepted(structuredClone(w), [{ produce: "harvester", at: g.id }]);
    step(w, batch.commands);
    advanceUntil(w, () => g.goliath!.queue.length === 0, UNITS.harvester.buildTime * TICK_RATE + 1);
    expect([...w.units.values()].some((u) => u.faction === "blue" && u.kind === "harvester")).toBe(true);
  });

  it("cancels a paused queue after packing, while refusing new production there", () => {
    const { w, g } = anchored();
    const before = w.factions.blue.scrap;
    const batch = parseOrders(w, "blue", [
      { produce: "trooper", at: g.id },
      { pack_up: [g.id] },
      { produce: "trooper", at: g.id },
      { cancel: "trooper" }
    ], "play");
    expect(batch.commands.map((c) => c.type)).toEqual(["produce", "packUp", "cancelProduce"]);
    expect(batch.results[2]).toContain("refused:");
    expect(batch.results[3]).toContain("ok:");
    expect(g.goliath!.queue).toHaveLength(0);
    expect(w.factions.blue.scrap).toBe(before);
  });

  it("refuses production and rally at an enemy Gargantua", () => {
    const { w, enemy } = anchored();
    const batch = parseOrders(w, "blue", [{ produce: "trooper", at: enemy.id }, { rally: enemy.id, to: [25, 25] }], "play");
    expect(batch.commands).toEqual([]);
    for (const result of batch.results) expect(result).toContain("refused:");
    expect(enemy.goliath!.queue).toHaveLength(0);
    expect(enemy.goliath!.rally).toBeNull();
  });

  it("automatically suggests a legal building spot around the first anchored Gargantua with no buildings", () => {
    const { w } = field();
    const g = spawnUnit(w, "goliath", "blue", 10.5, 30.5);
    expect(w.buildings.size).toBe(0);
    expect(suggestSpot(w, "blue", "depot")).toBeNull();
    step(w, [{ type: "anchor", faction: "blue", unitIds: [g.id] }]);
    advanceUntil(w, () => g.goliath!.mode === "anchored");
    const spot = suggestSpot(w, "blue", "depot");
    expect(spot).not.toBeNull();
    expect(canPlaceBuilding(w, "blue", "depot", spot![0], spot![1])).toBe(true);
    const batch = accepted(structuredClone(w), [{ build: "depot" }]);
    expect(batch.build).toEqual({ kind: "depot", at: null });
    step(w, batch.commands);
    advanceUntil(w, () => w.factions.blue.pending?.ready === true);
    step(w, [{ type: "placeBuilding", faction: "blue", tx: spot![0], ty: spot![1] }]);
    expect([...w.buildings.values()]).toEqual([expect.objectContaining({ kind: "depot", faction: "blue", tx: spot![0], ty: spot![1] })]);
  });
});

describe("arena lifted target validation", () => {
  it("treats a carried enemy Gargantua as an air target", () => {
    const { w } = armada();
    const target = goliathsOf(w, "red")[0]!;
    const ground = spawnUnit(w, "stinger", "blue", 15.5, 15.5);
    const antiAir = spawnUnit(w, "flak-crawler", "blue", 16.5, 15.5);
    expect(domainOf(target)).toBe("air");
    const rejected = parseOrders(structuredClone(w), "blue", [{ attack: [ground.id], target: target.id }], "play");
    expect(rejected.commands).toEqual([]);
    expect(rejected.results[0]).toMatch(/refused:.*flying target/i);
    const batch = accepted(structuredClone(w), [{ attack: [ground.id, antiAir.id], target: target.id }]);
    expect(batch.commands).toEqual([{ type: "attack", faction: "blue", unitIds: [antiAir.id], targetId: target.id }]);
    expect(batch.results[0]).toMatch(/skipped stinger/i);
  });
});
