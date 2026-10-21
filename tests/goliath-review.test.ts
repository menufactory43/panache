import { describe, expect, it } from "vitest";
import { GOLIATH, UNITS } from "../src/sim/balance";
import { goliathsOf } from "../src/sim/goliath";
import { setDownPoint } from "../src/sim/lift";
import { createMapWorld } from "../src/sim/maps";
import { DEFAULT_RULES } from "../src/sim/rules";
import { wreckRestingSpot } from "../src/sim/salvage";
import { step } from "../src/sim/sim";
import { Terrain, type Faction, type FxEvent, type Unit, type World } from "../src/sim/types";
import { createWorld, hqOf, onHomeLand, regionAt, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

// Regressions for the findings of the adversarial review of the Goliath sim.

const mirror = (w: World, p: { x: number; y: number }) => ({ x: w.width - p.x, y: w.height - p.y });

/** Paint a rectangle of terrain and its point mirror (inclusive). */
function paintBoth(w: World, x0: number, y0: number, x1: number, y1: number, t: Terrain): void {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      setTerrain(w, x, y, t);
      setTerrain(w, w.width - 1 - x, w.height - 1 - y, t);
    }
}

/** A carried Goliath of `f` at (x, y), with its two Condors hooked on. */
function carried(w: World, f: Faction, x: number, y: number): { g: Unit; a: Unit; b: Unit } {
  const g = spawnUnit(w, "goliath", f, x, y);
  const a = spawnUnit(w, "condor", f, x - 1, y);
  const b = spawnUnit(w, "condor", f, x + 1, y);
  for (const c of [a, b]) c.order = { type: "lift", goliathId: g.id };
  g.goliath!.lift = { carriers: [a.id, b.id], phase: "carrying", dest: null, setDown: false };
  return { g, a, b };
}

describe("review regressions", () => {
  it("a harvester bound for the side's only Gargantua waits, loaded, while it packs up and moves, then delivers", () => {
    const w = createMapWorld("proving-grounds", { mutators: ["nomads"] });
    const g = goliathsOf(w, "blue")[0]!;
    const h = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "harvester")!;
    h.cargo = 100;
    h.order = { type: "harvest", fieldX: Math.floor(h.x), fieldY: Math.floor(h.y), phase: "toBase" };
    // move the base 6 tiles: it packs up first (no drop site meanwhile), walks, and is told to dig in again
    step(w, [{ type: "move", faction: "blue", unitIds: [g.id], x: g.x, y: g.y - 6 }]);
    expect(h.order.type).toBe("harvest");
    for (let i = 0; i < 40 * 10 && g.goliath!.mode !== "walking"; i++) step(w, []);
    for (let i = 0; i < 40 * 10 && g.order.type !== "idle"; i++) step(w, []);
    expect(h.order.type).toBe("harvest"); // still waiting with its load
    const scrap = w.factions.blue.scrap;
    step(w, [{ type: "anchor", faction: "blue", unitIds: [g.id] }]);
    for (let i = 0; i < 60 * 10; i++) step(w, []);
    expect(w.factions.blue.scrap).toBeGreaterThan(scrap + 50);
  });

  it("mirror-image lifts dropped on a tile edge fall the same way (side-frame tile)", () => {
    const w = createWorld(60, 60);
    w.rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], startUnits: [], mutators: [] };
    spawnBuilding(w, "hq", "blue", 1, 1);
    spawnBuilding(w, "hq", "red", 56, 56);
    paintBoth(w, 20, 18, 29, 22, Terrain.Water);
    const blue = carried(w, "blue", 30, 20.5); // exactly on the edge of the water's last column
    const p = mirror(w, { x: 30, y: 20.5 });
    const red = carried(w, "red", p.x, p.y);
    blue.a.hp = 0;
    red.a.hp = 0;
    step(w, []);
    expect(blue.g.hp > 0).toBe(red.g.hp > 0);
    if (blue.g.hp > 0) expect(blue.g.hp).toBeCloseTo(red.g.hp, 6);
  });

  it("set-down points and building slide-offs are mirror images for the two sides", () => {
    const w = createWorld(60, 60);
    paintBoth(w, 20, 18, 29, 22, Terrain.Water);
    spawnBuilding(w, "depot", "blue", 40, 40);
    spawnBuilding(w, "depot", "red", 18, 18);
    const gb = spawnUnit(w, "goliath", "blue", 10, 10);
    const gr = spawnUnit(w, "goliath", "red", 50, 50);
    for (const at of [{ x: 30, y: 20.5 }, { x: 25, y: 20 }, { x: 24.5, y: 22 }]) {
      const b = setDownPoint(w, gb, at.x, at.y);
      const r = setDownPoint(w, gr, ...(Object.values(mirror(w, at)) as [number, number]));
      expect(r && mirror(w, r)).toEqual(b && { x: expect.closeTo(b.x, 6), y: expect.closeTo(b.y, 6) });
    }
    // a fall onto a building rests on the mirror side for red
    const b = wreckRestingSpot(w, 41, 41, "blue")!;
    const r = wreckRestingSpot(w, w.width - 41, w.height - 41, "red")!;
    expect(mirror(w, r).x).toBeCloseTo(b.x, 6);
    expect(mirror(w, r).y).toBeCloseTo(b.y, 6);
    // (no faction: exactly the old world-frame answer)
    expect(wreckRestingSpot(w, 41, 41)).toEqual(wreckRestingSpot(w, 41, 41, "blue"));
  });

  it("island home land outlives the HQ: no ordinary building or Drop Pod on an island once it falls", () => {
    const w = createMapWorld("archipelago");
    const hq = hqOf(w, "blue")!;
    // an island tile: ground in a different ground region from the HQ's
    const home = regionAt(w, hq.tx + 1, hq.ty + 1, "ground");
    let island: { x: number; y: number } | null = null;
    for (let y = 0; y < w.height && !island; y++)
      for (let x = 0; x < w.width && !island; x++) {
        const r = regionAt(w, x, y, "ground");
        if (r && r !== home) island = { x, y };
      }
    expect(island).not.toBeNull();
    expect(onHomeLand(w, "blue", island!.x, island!.y)).toBe(false);
    spawnUnit(w, "goliath", "blue", hq.tx + 6, hq.ty + 6);
    hq.hp = 0;
    step(w, []);
    expect(w.winner).toBeNull();
    expect(hqOf(w, "blue")).toBeNull();
    expect(onHomeLand(w, "blue", island!.x, island!.y)).toBe(false);
    expect(onHomeLand(w, "blue", hq.tx + 1, hq.ty + 1)).toBe(true);
    // and under Nomads, from the first tick (no HQ was ever built)
    const n = createMapWorld("archipelago", { mutators: ["nomads"] });
    expect(onHomeLand(n, "blue", island!.x, island!.y)).toBe(false);
  });

  it("a move naming a Gargantua before its still-hooking Montgolfières calls the lift off and still moves the Gargantua", () => {
    const w = createWorld(40, 40);
    const g = spawnUnit(w, "goliath", "blue", 20, 20);
    const a = spawnUnit(w, "condor", "blue", 10, 10);
    const b = spawnUnit(w, "condor", "blue", 12, 10);
    step(w, [{ type: "lift", faction: "blue", unitIds: [a.id, b.id], goliathId: g.id }]);
    expect(g.goliath!.lift?.phase).toBe("hooking");
    step(w, [{ type: "move", faction: "blue", unitIds: [g.id, a.id, b.id], x: 30, y: 30 }]);
    expect(g.goliath!.lift).toBeNull();
    expect(g.order).toMatchObject({ type: "move", x: 30, y: 30 });
  });

  it("a carried Gargantua shot down on the same tick as one of its Montgolfières is credited to its own killer", () => {
    const w = createWorld(40, 40);
    const { g, a } = carried(w, "blue", 20, 20);
    const shooter = spawnUnit(w, "raptor", "red", 30, 30);
    const flak = spawnUnit(w, "flak-crawler", "red", 32, 32);
    g.hp = -5;
    g.lastAttackerId = shooter.id;
    a.hp = 0;
    a.lastAttackerId = flak.id;
    step(w, []);
    const death = w.fx.find((e): e is Extract<FxEvent, { type: "death" }> => e.type === "death" && e.id === g.id);
    expect(death?.killerId).toBe(shooter.id);
  });

  it("a Gargantua whose mortars are down gives up an attack on a target across the water beyond its other guns", () => {
    const w = createWorld(48, 48);
    w.rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], startUnits: [], mutators: [], fogOff: true };
    spawnBuilding(w, "hq", "blue", 1, 1);
    spawnBuilding(w, "hq", "red", 44, 44);
    for (let y = 0; y < 48; y++) for (let x = 30; x <= 35; x++) setTerrain(w, x, y, Terrain.Water);
    const g = spawnUnit(w, "goliath", "blue", 28.5, 30.5);
    g.hp = UNITS.goliath.hp * (GOLIATH.weapons.mortars.lostBelow - 0.05);
    const depot = spawnBuilding(w, "depot", "red", 36, 30);
    step(w, []); // (the mortars go offline)
    step(w, [{ type: "attack", faction: "blue", unitIds: [g.id], targetId: depot.id }]);
    for (let i = 0; i < 50; i++) step(w, []);
    expect(g.order.type).toBe("idle");
  });
});

describe("final review regressions", () => {
  /** A flat 40×40 field with a blue HQ at (4,4) and a red HQ at (32,32). */
  function field(): World {
    const w = createWorld(40, 40);
    spawnBuilding(w, "hq", "blue", 4, 4);
    spawnBuilding(w, "hq", "red", 32, 32);
    return w;
  }

  it("a tap on an enemy Gargantua carried by Montgolfières is a tap on an air target", async () => {
    const { Controller, hitTest } = await import("../src/game/controller");
    const w = field();
    const { g } = carried(w, "red", 20, 20);
    const flak = spawnUnit(w, "flak-crawler", "blue", 14, 14);
    const stinger = spawnUnit(w, "stinger", "blue", 14, 15);
    const hit = hitTest(w, g.x, g.y, 0.6);
    expect(hit).toEqual({ kind: "enemy", id: g.id, targetsAir: true });
    const c = new Controller(w);
    c.selectUnits([flak.id, stinger.id]);
    c.tapWorld(g.x, g.y, hit);
    const cmds = c.drainCommands();
    expect(cmds[0]).toMatchObject({ type: "attack", unitIds: [flak.id], targetId: g.id });
    expect(cmds.find((x) => x.type === "attack" && x.unitIds.includes(stinger.id))).toBeUndefined();
  });

  it("an anchored Gargantua is only told to attack what its guns reach from where it stands", async () => {
    const { Controller } = await import("../src/game/controller");
    const w = field();
    const g = spawnUnit(w, "goliath", "blue", 13, 13);
    g.goliath!.mode = "anchored";
    const stinger = spawnUnit(w, "stinger", "blue", 15, 13);
    const far = spawnBuilding(w, "turret", "red", 26, 26);
    const near = spawnUnit(w, "stinger", "red", 18, 13);
    const c = new Controller(w);
    c.selectUnits([g.id, stinger.id]);
    c.tapWorld(26.5, 26.5, { kind: "enemy", id: far.id, targetsAir: false });
    const cmds = c.drainCommands();
    expect(cmds.filter((x) => "unitIds" in x && x.unitIds.includes(g.id))).toEqual([]);
    expect(cmds[0]).toMatchObject({ type: "attack", unitIds: [stinger.id] });
    c.tapWorld(near.x, near.y, { kind: "enemy", id: near.id, targetsAir: false });
    expect(c.drainCommands()[0]).toMatchObject({ type: "attack", unitIds: [g.id, stinger.id], targetId: near.id });
    // on its own, out of reach: nothing at all (no rally point at the enemy)
    c.selectUnits([g.id]);
    c.tapWorld(26.5, 26.5, { kind: "enemy", id: far.id, targetsAir: false });
    expect(c.drainCommands()).toEqual([]);
  });

  it("squads queued on a Gargantua that packed up still count, and one can still be cancelled", async () => {
    const { producersOf, queuesOf } = await import("../src/sim/economy");
    const w = field();
    const g = spawnUnit(w, "goliath", "blue", 13, 13);
    g.goliath!.mode = "anchored";
    w.factions.blue.scrap = 1000;
    step(w, [
      { type: "produce", faction: "blue", buildingId: g.id, unit: "trooper" },
      { type: "produce", faction: "blue", buildingId: g.id, unit: "trooper" }
    ]);
    const count = () => queuesOf(w, "blue", "trooper").reduce((n, p) => n + p.queue.filter((q) => q.kind === "trooper").length, 0);
    expect(count()).toBe(2);
    step(w, [{ type: "packUp", faction: "blue", unitIds: [g.id] }]);
    expect(producersOf(w, "blue", "trooper")).toEqual([]);
    expect(count()).toBe(2);
    const scrap = w.factions.blue.scrap;
    const p = queuesOf(w, "blue", "trooper").find((p) => p.queue.some((q) => q.kind === "trooper"))!;
    step(w, [{ type: "cancelProduce", faction: "blue", buildingId: p.id, unit: "trooper" }]);
    expect(count()).toBe(1);
    expect(w.factions.blue.scrap).toBeGreaterThan(scrap);
  });

  it("under Nomads, with the Gargantua on the move, the Harvester's lock says to anchor it, not to build an HQ", async () => {
    const { unitBlocker } = await import("../src/sim/economy");
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    const g = goliathsOf(w, "blue")[0]!;
    expect(unitBlocker(w, "blue", "harvester")).toBeNull();
    step(w, [{ type: "packUp", faction: "blue", unitIds: [g.id] }]);
    expect(unitBlocker(w, "blue", "harvester")).toBe("Ancre un Gargantua");
    // (an ordinary side that lost its HQ and has no Goliath is still told what it needs)
    const plain = createWorld(40, 40);
    spawnBuilding(plain, "hq", "red", 32, 32);
    expect(unitBlocker(plain, "blue", "harvester")).toBe(`Requiert GQG`);
  });
});

describe("final review: integration", () => {
  it("Archipelago under Nomads: a side that loses its Montgolfière gets a free one at its Gargantua", async () => {
    const { LIFELINE, TICK_RATE } = await import("../src/sim/balance");
    const w = createMapWorld("archipelago", { seed: 3, objectives: true, mutators: ["nomads"] });
    const condor = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "condor")!;
    condor.passengers = [];
    condor.hp = 0;
    for (let i = 0; i < (LIFELINE.delay + 10) * TICK_RATE && !w.winner; i++) step(w, []);
    expect(w.lifeline!.blue.given).toBe(1);
    const fresh = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "condor")!;
    expect(fresh.free).toBe(true);
    // it sets down by the Goliath (the side's base), not off at the map's middle
    const g = goliathsOf(w, "blue")[0]!;
    expect(fresh.order.type === "move" ? Math.hypot(fresh.order.x - g.x, fresh.order.y - g.y) : 0).toBeLessThan(6);
  });

  it("calldown kills by a side with no HQ are still named as the calldown's", async () => {
    const { TICK_RATE } = await import("../src/sim/balance");
    const { CalldownCredit } = await import("../src/game/calldown-credit");
    const w = createMapWorld("riverlands", { seed: 3, mutators: ["nomads"] });
    const x = w.width / 2;
    const y = w.height / 2;
    spawnUnit(w, "scout", "blue", x, y + 4);
    const victims = [0, 1, 2, 3].map((i) => {
      const u = spawnUnit(w, "harvester", "red", x + (i % 2) * 0.4, y + Math.floor(i / 2) * 0.4);
      u.hp = 1;
      return u;
    });
    step(w, []);
    w.powers.meter.blue = 100;
    const credit = new CalldownCredit(w);
    const named = new Set<number>();
    for (let i = 0; i < 20 * TICK_RATE; i++) {
      step(w, i === 0 ? [{ type: "calldown", faction: "blue", power: "barrage", x, y }] : []);
      for (const [id, k] of credit.scan(w.fx)) if (k.power === "barrage" && k.faction === "blue") named.add(id);
    }
    expect(victims.every((v) => !w.units.has(v.id))).toBe(true);
    expect(named.size).toBe(victims.length);
  });

  it("Nomads + Veterans: the starting Gargantua rolls out at rank 1, like every other combat unit", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads", "veterans"] });
    for (const f of ["blue", "red"] as const) expect(goliathsOf(w, f)[0]!.rank).toBe(1);
  });

  it("an arena agent told the battle is over hears that two Goliaths fell in love", async () => {
    const { Arena, parseSeat } = await import("../src/arena/match");
    const a = new Arena({ map: "riverlands", seed: 1, seats: { blue: parseSeat("agent"), red: parseSeat("agent") }, mutators: ["robotlove"] });
    (a.record as { end: unknown }).end = { tick: 6000, winner: null, reason: "love" };
    expect(a.result("blue")).toMatch(/DRAW \(two Goliaths fell in love\)/);
  });
});
