import { describe, expect, it } from "vitest";
import { behaves } from "../src/sim/nations";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { planSalvage } from "../src/sim/ai/salvage";
import { SALVAGE, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, nearestScrapTile } from "../src/sim/economy";
import { tickFog } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import { isInfantry } from "../src/sim/infantry";
import { pickAiOpener } from "../src/sim/openers";
import { wreckRestingSpot, wreckValue } from "../src/sim/salvage";
import { step } from "../src/sim/sim";
import { Terrain, type FxEvent, type Unit, type UnitKind, type World } from "../src/sim/types";
import { createWorld, hqOf, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

/** Kill a unit outright and advance one tick (it dies in cleanupDeaths). */
function kill(w: World, u: Unit): FxEvent[] {
  u.hp = 0;
  u.cooldown = 1e6; // no parting shot on its last tick
  step(w, []);
  return w.fx;
}

/** Step until the wrecks have cooled enough to be salvaged. */
function coolDown(w: World): FxEvent[] {
  const out: FxEvent[] = [];
  for (let i = 0; i < SALVAGE.hot * TICK_RATE + 1; i++) {
    step(w, []);
    out.push(...w.fx);
  }
  return out;
}

describe("wrecks", () => {
  it("a destroyed combat unit leaves a wreck worth ~30% of its cost where it died", () => {
    const w = createWorld(20, 20);
    const t = spawnUnit(w, "mastodon", "red", 8.3, 9.6);
    t.facing = 1.2;
    const fx = kill(w, t);
    expect(w.wrecks).toHaveLength(1);
    const r = w.wrecks[0]!;
    expect(r).toMatchObject({ id: t.id, kind: "mastodon", faction: "red", x: 8.3, y: 9.6, facing: 1.2 });
    expect(r.value).toBe(Math.round(UNITS.mastodon.cost * SALVAGE.share));
    expect(SALVAGE.share).toBeGreaterThanOrEqual(0.25);
    expect(SALVAGE.share).toBeLessThanOrEqual(0.35);
    expect(fx.some((e) => e.type === "death" && e.id === t.id)).toBe(true);
  });

  it("harvesters leave no wreck", () => {
    const w = createWorld(20, 20);
    kill(w, spawnUnit(w, "harvester", "blue", 5.5, 5.5));
    expect(w.wrecks).toHaveLength(0);
    expect(wreckValue("harvester")).toBe(0);
    // every other vehicle leaves a hull; robot infantry leave nothing either
    for (const k of Object.keys(UNITS) as UnitKind[])
      if (!behaves(k, "harvester")) expect(wreckValue(k) > 0).toBe(!isInfantry(k));
    expect(wreckValue("fourgon")).toBe(0); // (a harvester by its base)
  });

  it("aircraft wrecks land where they die, nudged onto the nearest passable ground", () => {
    const w = createWorld(20, 20);
    for (let ty = 0; ty < 20; ty++) for (let tx = 0; tx < 8; tx++) setTerrain(w, tx, ty, Terrain.Rock);
    // over open ground: lands right there
    kill(w, spawnUnit(w, "wasp", "blue", 12.4, 5.5));
    expect(w.wrecks.at(-1)).toMatchObject({ x: 12.4, y: 5.5 });
    // just over the ridge: slides off the rock onto the nearest open tile
    kill(w, spawnUnit(w, "hornet", "red", 7.5, 10.5));
    const r = w.wrecks.at(-1)!;
    expect(r.kind).toBe("hornet");
    expect(r.x).toBeGreaterThanOrEqual(8);
    expect(Math.hypot(r.x - 7.5, r.y - 10.5)).toBeLessThanOrEqual(SALVAGE.shiftRadius);
    // deep in the rock: no tank could ever reach it, so no wreck at all
    const before = w.wrecks.length;
    kill(w, spawnUnit(w, "raptor", "red", 3.5, 10.5));
    expect(w.wrecks.length).toBe(before);
  });

  it("a hover tank sunk mid-river leaves nothing; one by the bank washes ashore", () => {
    const w = createWorld(24, 24);
    for (let ty = 0; ty < 24; ty++) for (let tx = 8; tx <= 15; tx++) setTerrain(w, tx, ty, Terrain.Water);
    kill(w, spawnUnit(w, "lancer", "blue", 12, 12));
    expect(w.wrecks).toHaveLength(0);
    kill(w, spawnUnit(w, "lancer", "blue", 8.6, 12.5));
    expect(w.wrecks).toHaveLength(1);
    expect(w.wrecks[0]!.x).toBeLessThan(8);
    expect(wreckRestingSpot(w, 12, 12)).toBeNull();
  });

  it("a wreck dying onto a building slides off its footprint", () => {
    const w = createWorld(20, 20);
    spawnBuilding(w, "fab-plant", "blue", 10, 10);
    const spot = wreckRestingSpot(w, 11, 11)!;
    expect(spot).not.toBeNull();
    const inside = spot.x >= 10 && spot.x < 12 && spot.y >= 10 && spot.y < 12;
    expect(inside).toBe(false);
  });
});

describe("salvage pickup", () => {
  it("is too hot to touch at first, then the nearest ground unit scoops it up", () => {
    const w = createWorld(20, 20);
    const dead = spawnUnit(w, "stinger", "red", 10.5, 10.5);
    const near = spawnUnit(w, "flak-crawler", "blue", 10.9, 10.5); // can't shoot ground: no fight
    spawnUnit(w, "flak-crawler", "red", 11.3, 10.5); // further away: loses the race
    kill(w, dead);
    const value = w.wrecks[0]!.value;
    const scrap0 = w.factions.blue.scrap;
    step(w, []);
    expect(w.wrecks).toHaveLength(1); // still burning
    const fx = coolDown(w);
    expect(w.wrecks).toHaveLength(0);
    expect(w.factions.blue.scrap).toBeCloseTo(scrap0 + value);
    expect(w.factions.blue.stats.scrapSalvaged).toBeCloseTo(value);
    expect(w.factions.red.stats.scrapSalvaged).toBe(0);
    const ev = fx.find((e) => e.type === "salvage");
    expect(ev).toMatchObject({ type: "salvage", faction: "blue", wreckId: dead.id, collectorId: near.id, value });
  });

  it("pays out through the collector's income multiplier", () => {
    const w = createWorld(20, 20);
    w.factions.red.incomeMult = 1.3;
    kill(w, spawnUnit(w, "mastodon", "blue", 6.5, 6.5));
    spawnUnit(w, "harvester", "red", 6.5, 7.2); // harvesters salvage too
    const value = w.wrecks[0]!.value;
    coolDown(w);
    expect(w.factions.red.stats.scrapSalvaged).toBeCloseTo(value * 1.3);
  });

  it("aircraft fly over wrecks without collecting them", () => {
    const w = createWorld(20, 20);
    const dead = spawnUnit(w, "stinger", "red", 10.5, 10.5);
    spawnUnit(w, "scout", "blue", 10.5, 10.5);
    kill(w, dead);
    coolDown(w);
    expect(w.wrecks).toHaveLength(1);
  });

  it("burns out after its time is up", () => {
    const w = createWorld(20, 20);
    kill(w, spawnUnit(w, "wasp", "red", 10.5, 10.5));
    for (let i = 0; i < SALVAGE.ttl * TICK_RATE - 5; i++) step(w, []);
    expect(w.wrecks).toHaveLength(1);
    for (let i = 0; i < 10; i++) step(w, []);
    expect(w.wrecks).toHaveLength(0);
    expect(w.factions.blue.stats.scrapSalvaged + w.factions.red.stats.scrapSalvaged).toBe(0);
  });

  it("caps the wreck field: the oldest burns out first", () => {
    const w = createWorld(40, 40);
    const ids: number[] = [];
    for (let i = 0; i < SALVAGE.maxWrecks + 5; i++) {
      const u = spawnUnit(w, "stinger", "red", 2.5 + (i % 30), 2.5 + Math.floor(i / 30) * 3);
      ids.push(u.id);
      u.hp = 0;
    }
    step(w, []);
    expect(w.wrecks).toHaveLength(SALVAGE.maxWrecks);
    expect(w.wrecks[0]!.id).toBe(ids[5]);
    expect(w.wrecks.at(-1)!.id).toBe(ids.at(-1));
  });

  it("never blocks movement or building placement; a building placed on one clears it for its owner", () => {
    const w = createWorld(24, 12);
    spawnBuilding(w, "hq", "blue", 1, 4);
    kill(w, spawnUnit(w, "mastodon", "red", 7.5, 5.5));
    coolDown(w);
    expect(w.wrecks).toHaveLength(1);
    expect(canPlaceBuilding(w, "blue", "turret", 7, 5)).toBe(true);
    spawnBuilding(w, "turret", "blue", 7, 5);
    step(w, []);
    expect(w.wrecks).toHaveLength(0);
    expect(w.factions.blue.stats.scrapSalvaged).toBeGreaterThan(0);

    // a tank drives straight across a wreck: it collects and keeps going
    const w2 = createWorld(24, 12);
    kill(w2, spawnUnit(w2, "mastodon", "red", 12.5, 6.5));
    coolDown(w2);
    const s = spawnUnit(w2, "stinger", "blue", 3.5, 6.5);
    step(w2, [{ type: "move", faction: "blue", unitIds: [s.id], x: 20.5, y: 6.5 }]);
    for (let i = 0; i < 12 * TICK_RATE; i++) step(w2, []);
    expect(s.x).toBeGreaterThan(19.5);
    expect(w2.wrecks).toHaveLength(0);
    expect(w2.factions.blue.stats.scrapSalvaged).toBeGreaterThan(0);
  });

  it("is deterministic: the same match replays to the same salvage", () => {
    const run = () => {
      const w = createMapWorld("frostbite", {
        seed: 77,
        openers: { blue: pickAiOpener("rush", 77, "blue"), red: pickAiOpener("ironclad", 77, "red") }
      });
      const a = createAiState("rush", "normal", 5);
      const b = createAiState("ironclad", "normal", 6);
      let salvaged = 0;
      for (let i = 0; i < 5 * 60 * TICK_RATE && !w.winner; i++) {
        step(w, [...tickAi(w, "blue", a), ...tickAi(w, "red", b)]);
        for (const e of w.fx) if (e.type === "salvage") salvaged += e.value;
      }
      return { salvaged, wrecks: JSON.stringify(w.wrecks), tick: w.tick };
    };
    const r1 = run();
    expect(r1.salvaged).toBeGreaterThan(0);
    expect(run()).toEqual(r1);
  });
});

describe("AI salvage sweeps", () => {
  /** Red base on Proving Grounds with idle stingers and a cool blue wreck nearby. */
  function scene() {
    const w = createMapWorld("proving-grounds");
    const hq = hqOf(w, "red")!;
    const sx = hq.tx - 4.5;
    const sy = hq.ty + 1.5;
    const guards = [spawnUnit(w, "stinger", "red", sx, sy), spawnUnit(w, "stinger", "red", sx - 0.8, sy)];
    kill(w, spawnUnit(w, "stinger", "blue", sx - 4, sy - 2));
    coolDown(w);
    tickFog(w);
    const army = [...w.units.values()].filter((u) => u.faction === "red" && u.kind !== "harvester");
    const harvesters = [...w.units.values()].filter((u) => u.faction === "red" && u.kind === "harvester");
    const buildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    return { w, guards, army, harvesters, buildings, wreck: w.wrecks[0]! };
  }

  it("sends a nearby idle tank to scoop up a wreck once the fight is over", () => {
    const { w, army, harvesters, buildings, wreck } = scene();
    const used = new Set<number>();
    const cmds = planSalvage(w, "red", { army, harvesters, buildings, used, threatened: false, assault: false });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: "attackMove", faction: "red", x: wreck.x, y: wreck.y });
    expect(used.size).toBe(1);
  });

  it("leaves a wreck alone while a visible enemy is near it, or the base is under attack", () => {
    const { w, army, harvesters, buildings, wreck } = scene();
    const ctx = { army, harvesters, buildings, used: new Set<number>(), threatened: true, assault: false };
    expect(planSalvage(w, "red", ctx)).toHaveLength(0);
    spawnUnit(w, "mastodon", "blue", wreck.x + 1.5, wreck.y + 2); // in plain view of the guards
    tickFog(w);
    expect(planSalvage(w, "red", { ...ctx, threatened: false })).toHaveLength(0);
  });

  it("doesn't go sweeping while the fight there is still on (recent hits nearby)", () => {
    const { w, guards, army, harvesters, buildings } = scene();
    guards[0]!.damagedTick = w.tick - 5;
    expect(planSalvage(w, "red", { army, harvesters, buildings, used: new Set(), threatened: false, assault: false })).toHaveLength(0);
  });

  it("only knows about wrecks it can see", () => {
    const { w, army, harvesters, buildings } = scene();
    w.fog.red.vis.fill(1); // everything merely explored
    expect(planSalvage(w, "red", { army, harvesters, buildings, used: new Set(), threatened: false, assault: false })).toHaveLength(0);
  });

  it("a harvester at work diverts to a wreck close by, however full its hold", () => {
    const w = createMapWorld("proving-grounds");
    const h = [...w.units.values()].find((u) => u.faction === "red" && u.kind === "harvester")!;
    kill(w, spawnUnit(w, "wasp", "blue", h.x - 2, h.y));
    coolDown(w);
    const r = w.wrecks[0]!;
    // on its way out to the field, four tiles from the wreck
    h.x = r.x + 4;
    h.y = r.y;
    h.order = { type: "harvest", fieldX: 30, fieldY: 30, phase: "toField" };
    tickFog(w);
    const plan = () =>
      planSalvage(w, "red", { army: [], harvesters: [h], buildings: [], used: new Set(), threatened: false, assault: true });
    const divert = [{ type: "move", faction: "red", unitIds: [h.id], x: r.x, y: r.y }];
    expect(plan()).toEqual(divert);
    // a full hold heading home too: a wreck's scrap goes straight to the bank
    h.cargo = 100;
    h.order = { type: "harvest", fieldX: 30, fieldY: 30, phase: "toBase" };
    expect(plan()).toEqual(divert);
    // …but not halfway through unloading, nor from across the field
    h.order = { type: "harvest", fieldX: 30, fieldY: 30, phase: "unloading" };
    expect(plan()).toHaveLength(0);
    h.order = { type: "harvest", fieldX: 30, fieldY: 30, phase: "toField" };
    h.x = r.x + 6;
    expect(plan()).toHaveLength(0);
  });

  it("a harvester sent back to work with a full hold unloads first", () => {
    const w = createMapWorld("proving-grounds");
    const h = [...w.units.values()].find((u) => u.faction === "red" && u.kind === "harvester")!;
    const field = nearestScrapTile(w, h.x, h.y, "red")!;
    h.cargo = 100;
    step(w, [{ type: "harvest", faction: "red", unitIds: [h.id], x: field.x + 0.5, y: field.y + 0.5 }]);
    expect(h.order).toMatchObject({ type: "harvest", phase: "toBase" });
    h.cargo = 40;
    step(w, [{ type: "harvest", faction: "red", unitIds: [h.id], x: field.x + 0.5, y: field.y + 0.5 }]);
    expect(h.order).toMatchObject({ type: "harvest", phase: "toField" });
  });

  it("while an assault gathers, idle units still sweep the wrecks close by", () => {
    const { w, guards, army, harvesters, buildings, wreck } = scene();
    const plan = () =>
      planSalvage(w, "red", { army, harvesters, buildings, used: new Set(), threatened: false, assault: true });
    for (const g of guards) {
      g.x = wreck.x + 4;
      g.y = wreck.y;
    }
    expect(plan()).toHaveLength(1);
    for (const g of guards) g.x = wreck.x + 7; // (any farther waits for the wave)
    expect(plan()).toHaveLength(0);
  });

  it("the commander actually collects the wrecks of a repelled raid", () => {
    const w = createMapWorld("proving-grounds");
    const hq = hqOf(w, "red")!;
    const state = createAiState("balanced", "normal", 3);
    // a red guard at home, and the burnt-out remains of a blue raid next to it
    for (let i = 0; i < 3; i++) spawnUnit(w, "stinger", "red", hq.tx - 3.5 - i * 0.8, hq.ty + 4.5);
    for (let i = 0; i < 4; i++) kill(w, spawnUnit(w, "stinger", "blue", hq.tx - 7.5 - i, hq.ty + 6.5 - i));
    for (let i = 0; i < 25 * TICK_RATE; i++) step(w, tickAi(w, "red", state));
    expect(w.factions.red.stats.scrapSalvaged).toBeGreaterThanOrEqual(3 * wreckValue("stinger"));
  });
});
