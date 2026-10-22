import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { DAMAGE_VS, INFANTRY, OBJECTIVES, TERRAIN, TICK_RATE, UNITS, shotDamage } from "../src/sim/balance";
import { areaBlast, findTarget } from "../src/sim/combat";
import { tickFog } from "../src/sim/fog";
import { concealedFrom, isInfantry, squadAlive, squadFirepower, tickCrush, unitSeenBy } from "../src/sim/infantry";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { findPath, unitStepSpeed } from "../src/sim/movement";
import { presence, setupObjectives } from "../src/sim/objectives";
import { TRIALS } from "../src/sim/ops";
import { wreckValue } from "../src/sim/salvage";
import { step } from "../src/sim/sim";
import { carrierOf, dropPoint, findUnit, freeSeats, isLoaded } from "../src/sim/transport";
import { Terrain, type Command, type Faction, type FxEvent, type Unit, type World } from "../src/sim/types";
import { createWorld, distToBuilding, hqOf, passable, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

/** Step with these commands on the first tick, then `n - 1` empty ticks; returns every fx event. */
function run(w: World, n: number, cmds: Command[] = []): FxEvent[] {
  const out: FxEvent[] = [];
  for (let i = 0; i < n; i++) {
    step(w, i === 0 ? cmds : []);
    out.push(...w.fx);
  }
  return out;
}

/** EMP a unit for good: it can't move or fire (but still takes damage). */
const freeze = (w: World, u: Unit) => w.powers.stunned.set(u.id, 1e9);

/** Paint a rectangle of terrain (inclusive). */
function paint(w: World, x0: number, y0: number, x1: number, y1: number, t: Terrain): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setTerrain(w, x, y, t);
}

/** A Condor with squads already aboard (as if they had boarded). */
function loadedCondor(w: World, faction: Faction, x: number, y: number, kinds: Unit["kind"][] = ["trooper", "rocket-squad"]) {
  const c = spawnUnit(w, "condor", faction, x, y);
  const squads = kinds.map((k) => {
    const s = spawnUnit(w, k, faction, x, y);
    w.units.delete(s.id);
    c.passengers!.push(s);
    return s;
  });
  return { c, squads };
}

const mirrorPt = (w: World, p: { x: number; y: number }) => ({ x: w.width - p.x, y: w.height - p.y });

describe("squads", () => {
  it("lose a robot each time HP crosses a 1/N step", () => {
    const max = UNITS.trooper.hp; // 5 robots
    const alive = (hp: number) => squadAlive({ kind: "trooper", hp });
    expect(alive(max)).toBe(5);
    expect(alive(max * 0.8 + 0.01)).toBe(5);
    expect(alive(max * 0.8)).toBe(4);
    expect(alive(max * 0.41)).toBe(3);
    expect(alive(max * 0.4)).toBe(2);
    expect(alive(1)).toBe(1);
    expect(alive(0)).toBe(0);
    expect(squadAlive({ kind: "sniper", hp: UNITS.sniper.hp })).toBe(2);
    expect(squadAlive({ kind: "rocket-squad", hp: UNITS["rocket-squad"].hp / 2 })).toBe(2);
    // vehicles are one "robot": full firepower whatever their HP
    expect(squadFirepower({ kind: "mastodon", hp: 10 })).toBe(1);
  });

  it("deal damage in proportion to the robots still standing", () => {
    const shotAt = (hp: number) => {
      const w = createWorld(20, 20);
      const t = spawnUnit(w, "trooper", "blue", 5.5, 5.5);
      t.hp = hp;
      const target = spawnUnit(w, "harvester", "red", 7.5, 5.5); // unarmed, in range
      run(w, 1);
      return UNITS.harvester.hp - target.hp;
    };
    const full = shotAt(UNITS.trooper.hp);
    expect(full).toBeCloseTo(shotDamage(UNITS.trooper) * DAMAGE_VS.kinetic.medium, 9);
    expect(shotAt(UNITS.trooper.hp * 0.6) / full).toBeCloseTo(3 / 5, 9); // 3 of 5 robots
    expect(shotAt(UNITS.trooper.hp * 0.2) / full).toBeCloseTo(1 / 5, 9); // the last robot
    expect(squadFirepower({ kind: "trooper", hp: UNITS.trooper.hp * 0.6 })).toBeCloseTo(0.6, 9);
  });
});

describe("precision damage (Sniper Teams)", () => {
  /** One sniper shot at a frozen target; returns the HP it took. */
  function snipe(kind: Unit["kind"]): number {
    const w = createWorld(20, 20);
    spawnUnit(w, "sniper", "blue", 4.5, 5.5);
    const v = spawnUnit(w, kind, "red", 10.5, 5.5); // 6 tiles: inside the sniper's 7
    freeze(w, v);
    run(w, 1);
    return UNITS[kind].hp - v.hp;
  }

  it("takes about three Trooper robots with one shot", () => {
    const dmg = snipe("trooper");
    expect(dmg).toBeCloseTo(shotDamage(UNITS.sniper) * 3, 9); // 50 × 3 = 150
    expect(squadAlive({ kind: "trooper", hp: UNITS.trooper.hp - dmg })).toBe(2); // 5 → 2
  });

  it("wipes a full Rocket Squad with two shots", () => {
    const w = createWorld(20, 20);
    const sniper = spawnUnit(w, "sniper", "blue", 4.5, 5.5);
    const rockets = spawnUnit(w, "rocket-squad", "red", 10.5, 5.5);
    freeze(w, rockets);
    run(w, 1);
    expect(w.units.has(rockets.id)).toBe(true); // one shot leaves one robot
    expect(squadAlive(rockets)).toBe(1);
    const fx = run(w, Math.round(UNITS.sniper.shotInterval! * TICK_RATE) + 1);
    expect(w.units.has(rockets.id)).toBe(false);
    expect(fx.some((e) => e.type === "death" && e.id === rockets.id && e.killerId === sniper.id)).toBe(true);
  });

  it("is feeble against vehicles and buildings", () => {
    expect(snipe("mastodon")).toBeCloseTo(shotDamage(UNITS.sniper) * 0.25, 9);
    expect(snipe("stinger")).toBeCloseTo(shotDamage(UNITS.sniper) * 0.4, 9);
    const w = createWorld(20, 20);
    spawnUnit(w, "sniper", "blue", 4.5, 5.5);
    const depot = spawnBuilding(w, "depot", "red", 9, 5);
    const before = depot.hp;
    run(w, 1);
    expect(before - depot.hp).toBeCloseTo(shotDamage(UNITS.sniper) * 0.15, 9);
  });
});

describe("infantry terrain", () => {
  it("takes half damage in Woods (vehicles: TERRAIN cover)", () => {
    const hurt = (kind: Unit["kind"], t: Terrain) => {
      const w = createWorld(12, 12);
      setTerrain(w, 5, 5, t);
      const u = spawnUnit(w, kind, "red", 5.5, 5.5);
      areaBlast(w, "blue", 5.5, 5.5, 1, 100, "kinetic", "ground", 0);
      return UNITS[kind].hp - u.hp;
    };
    expect(INFANTRY.woodsCover).toBe(0.5);
    expect(hurt("trooper", Terrain.Forest) / hurt("trooper", Terrain.Ground)).toBeCloseTo(0.5, 9);
    expect(hurt("sniper", Terrain.Forest) / hurt("sniper", Terrain.Ground)).toBeCloseTo(0.5, 9);
    expect(hurt("stinger", Terrain.Forest) / hurt("stinger", Terrain.Ground)).toBeCloseTo(TERRAIN[Terrain.Forest].cover, 9);
  });

  it("walks at full speed through Woods and Rough, slower in Shallows, never on Water or Rock", () => {
    const w = createWorld(12, 12);
    const tiles: [Terrain, number][] = [
      [Terrain.Ground, 1], [Terrain.Forest, 1], [Terrain.Rough, 1], [Terrain.Shallows, 0.8]
    ];
    tiles.forEach(([t], i) => setTerrain(w, i, 0, t));
    setTerrain(w, 5, 0, Terrain.Water);
    setTerrain(w, 6, 0, Terrain.Rock);
    const base = UNITS.trooper.speed / TICK_RATE;
    tiles.forEach(([t, mult], i) => {
      expect(passable(w, i, 0, "foot"), `foot on ${TERRAIN[t].name}`).toBe(true);
      const u = spawnUnit(w, "trooper", "blue", i + 0.5, 0.5);
      expect(unitStepSpeed(w, u)).toBeCloseTo(base * mult, 9);
    });
    expect(passable(w, 5, 0, "foot")).toBe(false);
    expect(passable(w, 6, 0, "foot")).toBe(false);
    // a tank is slowed by the woods the squad strolls through
    const tank = spawnUnit(w, "stinger", "blue", 1.5, 0.5);
    expect(unitStepSpeed(w, tank)).toBeCloseTo((UNITS.stinger.speed / TICK_RATE) * TERRAIN[Terrain.Forest].speed, 9);
  });

  it("paths around water it can't wade", () => {
    const w = createWorld(20, 20);
    paint(w, 9, 0, 10, 15, Terrain.Water); // a river with a crossing at the south end
    const path = findPath(w, 4.5, 4.5, 15.5, 4.5, "foot", "blue")!;
    expect(path).not.toBeNull();
    expect(path.every((p) => passable(w, Math.floor(p.x), Math.floor(p.y), "foot"))).toBe(true);
    expect(Math.max(...path.map((p) => p.y))).toBeGreaterThan(15);
  });
});

describe("boarding a Condor", () => {
  it("takes a second once adjacent, and takes the squad off the field", () => {
    const w = createWorld(30, 30);
    const c = spawnUnit(w, "condor", "blue", 10.5, 10.5);
    const t = spawnUnit(w, "trooper", "blue", 11.3, 10.5);
    const fx = run(w, INFANTRY.boardTime * TICK_RATE - 1, [{ type: "board", faction: "blue", unitIds: [t.id], carrierId: c.id }]);
    expect(w.units.has(t.id)).toBe(true); // still climbing in
    expect(fx.some((e) => e.type === "embark")).toBe(false);
    const more = run(w, 2);
    expect(w.units.has(t.id)).toBe(false);
    expect(c.passengers!.map((p) => p.id)).toEqual([t.id]);
    expect(more.find((e) => e.type === "embark")).toMatchObject({ faction: "blue", carrierId: c.id, unitId: t.id });
    expect(findUnit(w, t.id)).toBe(t);
    expect(carrierOf(w, t.id)).toBe(c);
    expect(freeSeats(c)).toBe(1);
    expect(isLoaded(c)).toBe(true);
    // aboard: no vision, no presence, nothing to shoot at
    const red = spawnUnit(w, "trooper", "red", 9.5, 9.5);
    expect(findTarget(w, "red", "ground", red.x, red.y, 10)).toBeNull();
    // a board order for a squad already aboard is ignored
    const other = spawnUnit(w, "condor", "blue", 20.5, 20.5);
    run(w, 3, [{ type: "board", faction: "blue", unitIds: [t.id], carrierId: other.id }]);
    expect(carrierOf(w, t.id)).toBe(c);
  });

  it("seats two squads; a third goes idle", () => {
    const w = createWorld(30, 30);
    const c = spawnUnit(w, "condor", "blue", 10.5, 10.5);
    const squads = [
      spawnUnit(w, "trooper", "blue", 11.2, 10.5),
      spawnUnit(w, "sniper", "blue", 9.8, 10.5),
      spawnUnit(w, "rocket-squad", "blue", 10.5, 11.2)
    ];
    run(w, 3 * TICK_RATE, [{ type: "board", faction: "blue", unitIds: squads.map((s) => s.id), carrierId: c.id }]);
    expect(c.passengers).toHaveLength(UNITS.condor.capacity!);
    expect(freeSeats(c)).toBe(0);
    const left = squads.filter((s) => w.units.has(s.id));
    expect(left).toHaveLength(1);
    expect(left[0]!.order.type).toBe("idle");
  });

  it("an idle Condor comes to meet the squads boarding it", () => {
    const w = createWorld(30, 30);
    const c = spawnUnit(w, "condor", "blue", 22.5, 10.5);
    const t = spawnUnit(w, "trooper", "blue", 4.5, 10.5);
    run(w, 10, [{ type: "board", faction: "blue", unitIds: [t.id], carrierId: c.id }]);
    expect(c.x).toBeLessThan(22.5 - 2); // flying toward the squad
    run(w, 6 * TICK_RATE);
    expect(carrierOf(w, t.id)).toBe(c);
    // the squad walked part of the way too: they met in between
    expect(c.x).toBeGreaterThan(4.5 + 2);
  });

  it("only takes own infantry, and a gone carrier sends the squad idle", () => {
    const w = createWorld(30, 30);
    const c = spawnUnit(w, "condor", "blue", 10.5, 10.5);
    const tank = spawnUnit(w, "stinger", "blue", 11.5, 10.5);
    const foe = spawnUnit(w, "trooper", "red", 11.5, 11.5);
    freeze(w, foe);
    run(w, 2 * TICK_RATE, [
      { type: "board", faction: "blue", unitIds: [tank.id], carrierId: c.id },
      { type: "board", faction: "red", unitIds: [foe.id], carrierId: c.id }
    ]);
    expect(c.passengers).toHaveLength(0);
    const t = spawnUnit(w, "trooper", "blue", 3.5, 3.5);
    run(w, 1, [{ type: "board", faction: "blue", unitIds: [t.id], carrierId: c.id }]);
    expect(t.order.type).toBe("board");
    w.units.delete(c.id);
    run(w, 1);
    expect(t.order.type).toBe("idle");
  });
});

describe("unloading", () => {
  it("drops in place from the Unload chip after a 1.5 s hover, ids preserved", () => {
    const w = createWorld(30, 30);
    const { c, squads } = loadedCondor(w, "blue", 10.5, 10.5);
    const hover = INFANTRY.unloadHover * TICK_RATE;
    const early = run(w, hover - 1, [{ type: "unload", faction: "blue", unitIds: [c.id] }]);
    expect(c.order.type).toBe("unload");
    expect(early.some((e) => e.type === "disembark")).toBe(false);
    const fx = run(w, 3);
    const drop = fx.find((e) => e.type === "disembark");
    expect(drop).toMatchObject({ faction: "blue", carrierId: c.id, unitIds: squads.map((s) => s.id), bailout: false });
    for (const s of squads) {
      expect(w.units.get(s.id)).toBe(s);
      expect(Math.hypot(s.x - 10.5, s.y - 10.5)).toBeLessThan(1);
      expect(s.order.type).toBe("idle");
    }
    expect(c.passengers).toHaveLength(0);
    // …then lifts off their heads: backs off the way it came (it faced north), and idles
    expect(c.order).toMatchObject({ type: "move", x: 10.5, y: 10.5 + INFANTRY.dropBackOff });
    run(w, TICK_RATE);
    expect(c.order.type).toBe("idle");
    for (const s of squads) expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeGreaterThan(1);
  });

  it("flies to a long-pressed point and drops there", () => {
    const w = createWorld(30, 30);
    const { c, squads } = loadedCondor(w, "blue", 5.5, 5.5);
    run(w, 1, [{ type: "unload", faction: "blue", unitIds: [c.id], x: 20.5, y: 12.5 }]);
    expect(c.order).toMatchObject({ type: "unload", x: 20.5, y: 12.5, hover: -1 });
    run(w, 10 * TICK_RATE);
    for (const s of squads) expect(Math.hypot(s.x - 20.5, s.y - 12.5)).toBeLessThan(1);
    expect(isLoaded(c)).toBe(false);
  });

  it("never drops onto Water or Rock: it snaps to the nearest tile a squad can stand on", () => {
    const w = createWorld(30, 30);
    paint(w, 10, 0, 19, 29, Terrain.Water);
    paint(w, 20, 0, 21, 29, Terrain.Rock);
    const { c, squads } = loadedCondor(w, "blue", 5.5, 5.5);
    run(w, 12 * TICK_RATE, [{ type: "unload", faction: "blue", unitIds: [c.id], x: 13.5, y: 8.5 }]);
    expect(isLoaded(c)).toBe(false);
    for (const s of squads) {
      expect(passable(w, Math.floor(s.x), Math.floor(s.y), "foot")).toBe(true);
      expect(s.x).toBeLessThan(10); // the near bank (the far one is past the rock)
    }
    expect(dropPoint(w, "blue", 4.2, 7.7)).toEqual({ x: 4.2, y: 7.7 }); // standable: the point itself
    // a drop near the shore snaps onto the beach, INFANTRY.dropClear off the water
    const sea = createWorld(30, 30);
    paint(sea, 0, 0, 29, 29, Terrain.Water);
    paint(sea, 0, 0, 3, 29, Terrain.Ground);
    expect(dropPoint(sea, "blue", 8.5, 15.5)).toEqual({ x: 4 - INFANTRY.dropClear, y: 15.5 });
    // …and out over open water with no shore within INFANTRY.dropSearch, onto the nearest one anywhere
    const far = loadedCondor(sea, "blue", 15.5, 15.5);
    expect(dropPoint(sea, "blue", 15.5, 15.5)).toEqual({ x: 4 - INFANTRY.dropClear, y: 15.5 });
    run(sea, 8 * TICK_RATE, [{ type: "unload", faction: "blue", unitIds: [far.c.id] }]);
    expect(far.c.passengers).toHaveLength(0);
    for (const s of far.squads) expect(s.x).toBeLessThanOrEqual(4 - INFANTRY.dropClear + 1e-9);
    // only with no ground anywhere does the chip do nothing
    const ocean = createWorld(12, 12);
    paint(ocean, 0, 0, 11, 11, Terrain.Water);
    expect(dropPoint(ocean, "blue", 5.5, 5.5)).toBeNull();
  });

  it("sets squads down clear of the water's edge and a squad's width apart, dropped or bailing out", () => {
    // the robots stand around the squad's centre: none of them in the water
    const clearance = (w: World, x: number, y: number) => {
      let d = Math.min(x, y, w.width - x, w.height - y);
      for (let ty = Math.floor(y) - 1; ty <= Math.floor(y) + 1; ty++)
        for (let tx = Math.floor(x) - 1; tx <= Math.floor(x) + 1; tx++)
          if (!passable(w, tx, ty, "foot"))
            d = Math.min(d, Math.hypot(Math.max(tx - x, 0, x - tx - 1), Math.max(ty - y, 0, y - ty - 1)));
      return d;
    };
    // a lake with a jagged shore, an inlet and the map's edge close by
    const shore = () => {
      const w = createWorld(24, 24);
      paint(w, 9, 0, 23, 23, Terrain.Water);
      paint(w, 7, 6, 8, 6, Terrain.Water);
      paint(w, 8, 12, 8, 13, Terrain.Rock);
      return w;
    };
    for (const f of ["blue", "red"] as const)
      for (const [x, y] of [[8.95, 8.5], [8.1, 6.9], [8.6, 12.5], [0.2, 0.3], [12.5, 4.5]] as const) {
        const w = shore();
        const { c, squads } = loadedCondor(w, f, x, y);
        run(w, 5 * TICK_RATE, [{ type: "unload", faction: f, unitIds: [c.id] }]);
        expect(c.passengers).toHaveLength(0);
        for (const s of squads) expect(clearance(w, s.x, s.y), `${f} drop at ${x},${y}`).toBeGreaterThanOrEqual(INFANTRY.dropClear - 1e-9);
        expect(Math.hypot(squads[0]!.x - squads[1]!.x, squads[0]!.y - squads[1]!.y)).toBeGreaterThanOrEqual(0.8 - 1e-9);
        // shot down right at the water's edge
        if (!passable(w, Math.floor(x), Math.floor(y), "foot")) continue;
        const w2 = shore();
        const down = loadedCondor(w2, f, x, y);
        down.c.hp = 0;
        run(w2, 1);
        for (const s of down.squads) expect(clearance(w2, s.x, s.y), `${f} bail-out at ${x},${y}`).toBeGreaterThanOrEqual(INFANTRY.dropClear - 1e-9);
      }
  });

  it("snaps drops as mirror images for the two sides", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      let n = 0;
      for (let y = 1.5; y < w.height; y += 3.7)
        for (let x = 1.5; x < w.width; x += 3.3) {
          const b = dropPoint(w, "blue", x, y);
          const m = mirrorPt(w, { x, y });
          const r = dropPoint(w, "red", m.x, m.y);
          expect(r === null ? null : mirrorPt(w, r)).toEqual(b === null ? null : { x: expect.closeTo(b.x, 9), y: expect.closeTo(b.y, 9) });
          if (b && (b.x !== x || b.y !== y)) n++;
        }
      expect(n, `snapped drops on ${def.name}`).toBeGreaterThan(0);
    }
  });

  it("is called off by stop or a new move, and pauses while the Condor is EMP'd", () => {
    const w = createWorld(30, 30);
    const { c } = loadedCondor(w, "blue", 5.5, 5.5);
    run(w, 3, [{ type: "unload", faction: "blue", unitIds: [c.id], x: 20.5, y: 5.5 }]);
    run(w, 1, [{ type: "move", faction: "blue", unitIds: [c.id], x: 5.5, y: 20.5 }]);
    expect(c.order.type).toBe("move");
    run(w, 1, [{ type: "unload", faction: "blue", unitIds: [c.id] }]);
    run(w, 1, [{ type: "stop", faction: "blue", unitIds: [c.id] }]);
    expect(c.order.type).toBe("idle");
    run(w, 3 * TICK_RATE);
    expect(c.passengers).toHaveLength(2); // nobody got off
    // EMP'd mid-hover: the clock stops until the stun wears off
    run(w, 1, [{ type: "unload", faction: "blue", unitIds: [c.id] }]);
    w.powers.stunned.set(c.id, w.tick + 3 * TICK_RATE);
    run(w, 3 * TICK_RATE - 1);
    expect(c.passengers).toHaveLength(2);
    run(w, INFANTRY.unloadHover * TICK_RATE + 2);
    expect(c.passengers).toHaveLength(0);
  });
});

describe("a Condor shot down", () => {
  it("over walkable ground: the squads bail out at half HP", () => {
    const w = createWorld(30, 30);
    const { c, squads } = loadedCondor(w, "blue", 8.5, 8.5);
    squads[1]!.hp = UNITS["rocket-squad"].hp * 0.3; // already below half: stays as it was
    const killer = spawnUnit(w, "trooper", "red", 25.5, 25.5);
    c.hp = 0;
    c.lastAttackerId = killer.id;
    const fx = run(w, 1);
    expect(w.units.has(c.id)).toBe(false);
    expect(fx.find((e) => e.type === "disembark")).toMatchObject({ carrierId: c.id, unitIds: squads.map((s) => s.id), bailout: true });
    expect(squads[0]!.hp).toBeCloseTo(UNITS.trooper.hp * INFANTRY.bailoutHp, 9);
    expect(squads[1]!.hp).toBeCloseTo(UNITS["rocket-squad"].hp * 0.3, 9);
    for (const s of squads) expect(w.units.get(s.id)).toBe(s);
    expect(fx.filter((e) => e.type === "death").map((e) => (e as { id: number }).id)).toEqual([c.id]);
    expect(w.factions.blue.stats.unitsLost).toBe(1);
  });

  it("over water: the squads are lost with it, and the killer gets the credit", () => {
    const w = createWorld(30, 30);
    paint(w, 5, 5, 12, 12, Terrain.Water);
    const { c, squads } = loadedCondor(w, "blue", 8.5, 8.5);
    const killer = spawnUnit(w, "rocket-squad", "red", 25.5, 25.5);
    c.hp = 0;
    c.lastAttackerId = killer.id;
    const fx = run(w, 1);
    const deaths = fx.filter((e): e is Extract<FxEvent, { type: "death" }> => e.type === "death");
    expect(deaths.map((e) => e.id).sort()).toEqual([c.id, ...squads.map((s) => s.id)].sort());
    for (const s of squads)
      expect(deaths.find((e) => e.id === s.id)).toMatchObject({ faction: "blue", unitKind: s.kind, killerId: killer.id, killerKind: "rocket-squad", value: UNITS[s.kind].cost });
    expect(fx.some((e) => e.type === "disembark")).toBe(false);
    for (const s of squads) expect(findUnit(w, s.id)).toBeNull();
    expect(w.factions.blue.stats.unitsLost).toBe(3);
    expect(w.factions.red.stats.unitsKilled).toBe(3);
    expect(killer.kills).toBe(3);
    expect(killer.xp).toBe(UNITS.condor.cost + UNITS.trooper.cost + UNITS["rocket-squad"].cost);
  });
});

describe("crushing", () => {
  it("a moving enemy Mastodon deals 30 HP/s to a squad it rolls over", () => {
    const w = createWorld(30, 12);
    const mastodon = spawnUnit(w, "mastodon", "blue", 3.5, 5.5);
    mastodon.cooldown = 1e9; // (never fires: only the treads hurt)
    const squad = spawnUnit(w, "trooper", "red", 10.5, 5.5);
    freeze(w, squad);
    const fx = run(w, 20 * TICK_RATE, [{ type: "move", faction: "blue", unitIds: [mastodon.id], x: 20.5, y: 5.5 }]);
    expect(mastodon.x).toBeGreaterThan(18); // it drove straight through
    const lost = UNITS.trooper.hp - squad.hp;
    const hits = fx.filter((e) => e.type === "hit" && e.id === squad.id);
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeCloseTo(hits.length * (INFANTRY.crushDps / TICK_RATE), 6);
    expect(hits.every((e) => e.type === "hit" && e.attackerId === mastodon.id)).toBe(true);
    expect(fx.some((e) => e.type === "crush" && e.id === squad.id && e.attackerId === mastodon.id)).toBe(true);
    // contact lasts as long as the Mastodon takes to cross its reach and back out
    const reach = UNITS.mastodon.radius + INFANTRY.crushReach;
    expect(hits.length).toBeLessThanOrEqual(Math.ceil((2 * reach) / (UNITS.mastodon.speed / TICK_RATE)) + 1);
  });

  it("deals exactly crushDps per second under a Mastodon that keeps moving, credited to it", () => {
    const w = createWorld(30, 12);
    const mastodon = spawnUnit(w, "mastodon", "blue", 5.5, 5.5);
    const squad = spawnUnit(w, "trooper", "red", 5.6, 5.5);
    squad.hp = 100;
    for (let i = 0; i < TICK_RATE; i++) tickCrush(w, [mastodon]);
    expect(squad.hp).toBeCloseTo(100 - INFANTRY.crushDps, 9);
    squad.hp = 2;
    tickCrush(w, [mastodon]);
    mastodon.cooldown = 1e9;
    step(w, []);
    const kill = w.fx.find((e) => e.type === "death" && e.id === squad.id);
    expect(kill).toMatchObject({ killerId: mastodon.id, killerKind: "mastodon" });
    expect(mastodon.kills).toBe(1);
  });

  it("a stationary Mastodon crushes nothing", () => {
    const w = createWorld(30, 12);
    const mastodon = spawnUnit(w, "mastodon", "blue", 5.5, 5.5);
    mastodon.cooldown = 1e9;
    const squad = spawnUnit(w, "trooper", "red", 5.7, 5.5);
    freeze(w, squad);
    const fx = run(w, 3 * TICK_RATE);
    expect(squad.hp).toBe(UNITS.trooper.hp);
    expect(fx.some((e) => e.type === "crush")).toBe(false);
  });

  it("friendly squads step aside and take nothing", () => {
    const w = createWorld(30, 12);
    const mastodon = spawnUnit(w, "mastodon", "blue", 3.5, 5.5);
    const squad = spawnUnit(w, "trooper", "blue", 10.5, 5.5);
    let closest = Infinity;
    for (let i = 0; i < 20 * TICK_RATE; i++) {
      step(w, i === 0 ? [{ type: "move", faction: "blue", unitIds: [mastodon.id], x: 20.5, y: 5.5 }] : []);
      closest = Math.min(closest, Math.hypot(mastodon.x - squad.x, mastodon.y - squad.y));
      expect(w.fx.some((e) => e.type === "crush" || e.type === "hit")).toBe(false);
    }
    expect(mastodon.x).toBeGreaterThan(18); // the Mastodon was never held up
    expect(squad.hp).toBe(UNITS.trooper.hp);
    expect(Math.abs(squad.y - 5.5)).toBeGreaterThan(0.2); // the squad stepped off the line
    expect(closest).toBeGreaterThan(0.5);
  });

  it("…and so do they for a harvester at work (it drives in the economy tick, not movement)", () => {
    const w = createWorld(30, 12);
    setTerrain(w, 20, 5, Terrain.Scrap);
    const h = spawnUnit(w, "harvester", "blue", 3.5, 5.5);
    const squad = spawnUnit(w, "trooper", "blue", 10.5, 5.5);
    for (let i = 0; i < 10 * TICK_RATE; i++) {
      step(w, i === 0 ? [{ type: "harvest", faction: "blue", unitIds: [h.id], x: 20.5, y: 5.5 }] : []);
      expect(h.y).toBe(5.5); // never shouldered off its line
    }
    expect(h.x).toBeGreaterThan(18);
    expect(Math.abs(squad.y - 5.5)).toBeGreaterThan(0.2);
  });

  it("a squad walking up to a PARKED friendly vehicle shoulders past it, and arrives", () => {
    // a mixed group sent to one point: the Stinger parks on it first
    const w = createWorld(30, 30);
    const tank = spawnUnit(w, "stinger", "blue", 4.5, 10.5);
    const squad = spawnUnit(w, "trooper", "blue", 4.5, 11.5);
    run(w, 30 * TICK_RATE, [{ type: "move", faction: "blue", unitIds: [tank.id, squad.id], x: 15.5, y: 10.5 }]);
    expect(tank.order.type).toBe("idle");
    expect(squad.order.type).toBe("idle");
    // a parked Stinger, Mastodon or harvester on its way, whichever way it faces
    for (const kind of ["stinger", "mastodon", "harvester"] as const)
      for (const facing of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const w2 = createWorld(30, 30);
        const v = spawnUnit(w2, kind, "blue", 12.5, 10.5);
        v.facing = facing;
        const s = spawnUnit(w2, "trooper", "blue", 4.5, 10.5);
        run(w2, 30 * TICK_RATE, [{ type: "move", faction: "blue", unitIds: [s.id], x: 20.5, y: 10.5 }]);
        expect(s.order.type, `${kind} facing ${facing}`).toBe("idle");
        expect(Math.hypot(s.x - 20.5, s.y - 10.5)).toBeLessThan(1);
      }
  });

  it("enemy vehicles drive through squads instead of shoving them", () => {
    const w = createWorld(30, 12);
    const tank = spawnUnit(w, "stinger", "blue", 3.5, 5.5);
    tank.cooldown = 1e9;
    const squad = spawnUnit(w, "trooper", "red", 10.5, 5.5);
    freeze(w, squad);
    run(w, 10 * TICK_RATE, [{ type: "move", faction: "blue", unitIds: [tank.id], x: 20.5, y: 5.5 }]);
    expect(tank.x).toBeGreaterThan(18);
    expect(squad.x).toBe(10.5);
    expect(squad.y).toBe(5.5);
    expect(squad.hp).toBe(UNITS.trooper.hp); // only Mastodons crush
  });
});

describe("Sniper concealment", () => {
  /** A red Sniper Team in a patch of woods, a blue Trooper Squad `gap` tiles east of it, fog up to date. */
  function woods(gap: number) {
    const w = createWorld(30, 30);
    paint(w, 12, 12, 18, 18, Terrain.Forest);
    const sniper = spawnUnit(w, "sniper", "red", 15.5, 15.5);
    const watcher = spawnUnit(w, "trooper", "blue", 15.5 + gap, 15.5);
    w.tick = 100;
    tickFog(w);
    return { w, sniper, watcher };
  }

  it("hides a Sniper Team in Woods from enemies beyond 3 tiles", () => {
    const { w, sniper } = woods(4);
    expect(UNITS.trooper.sight).toBeGreaterThan(4); // its tile IS in sight…
    expect(concealedFrom(w, "blue", sniper)).toBe(true); // …but the woods hide it
    expect(unitSeenBy(w, "blue", sniper)).toBe(false);
    expect(unitSeenBy(w, "red", sniper)).toBe(true); // never hidden from its own side
    expect(findTarget(w, "blue", "both", 19.5, 15.5, 10)).toBeNull();
  });

  it("shows it to enemies within 3 tiles, and out of the woods", () => {
    const close = woods(INFANTRY.concealRadius - 0.1);
    expect(concealedFrom(close.w, "blue", close.sniper)).toBe(false);
    expect(unitSeenBy(close.w, "blue", close.sniper)).toBe(true);
    const near = woods(5);
    spawnBuilding(near.w, "turret", "blue", 17, 18); // a building close by sees it too
    expect(concealedFrom(near.w, "blue", near.sniper)).toBe(false);
    const open = woods(5);
    setTerrain(open.w, 15, 15, Terrain.Ground);
    expect(concealedFrom(open.w, "blue", open.sniper)).toBe(false);
  });

  it("gives it away for 2 s after every shot", () => {
    const { w, sniper } = woods(5);
    sniper.firedTick = w.tick;
    expect(concealedFrom(w, "blue", sniper)).toBe(false);
    w.tick += INFANTRY.concealAfterShot * TICK_RATE;
    expect(concealedFrom(w, "blue", sniper)).toBe(false);
    w.tick += 1;
    expect(concealedFrom(w, "blue", sniper)).toBe(true);
  });

  it("drops out of attack orders while hidden, and snipes from cover", () => {
    const { w, sniper, watcher } = woods(5);
    sniper.cooldown = 1e9; // (holding fire)
    run(w, 1, [{ type: "attack", faction: "blue", unitIds: [watcher.id], targetId: sniper.id }]);
    expect(watcher.order.type).toBe("idle"); // nothing there to shoot at
    expect(watcher.autoTargetId).toBeNull();
    // it opens fire (range 7) from cover: now it can be fought back
    sniper.cooldown = 0;
    const fx = run(w, 1, [{ type: "attack", faction: "blue", unitIds: [watcher.id], targetId: sniper.id }]);
    expect(fx.some((e) => e.type === "shot" && e.sourceId === sniper.id)).toBe(true);
    expect(watcher.order).toMatchObject({ type: "attack", targetId: sniper.id });
  });
});

describe("infantry and the map", () => {
  it("captures Uplinks twice as fast", () => {
    const w = createWorld(30, 30);
    setupObjectives(w, [[10, 10]], []);
    const [l, m] = w.objectives.uplinks;
    spawnUnit(w, "trooper", "blue", 10, 10);
    spawnUnit(w, "stinger", "red", m!.x, m!.y);
    expect(presence(w, l!).blue).toBe(INFANTRY.captureWeight);
    expect(presence(w, m!).red).toBe(1);
    run(w, TICK_RATE);
    expect(l!.progress).toBeCloseTo(OBJECTIVES.uplink.perUnit * INFANTRY.captureWeight, 6);
    expect(m!.progress).toBeCloseTo(-OBJECTIVES.uplink.perUnit, 6);
  });

  it("leaves no wrecks", () => {
    const w = createWorld(20, 20);
    for (const k of ["trooper", "rocket-squad", "sniper"] as const) {
      expect(isInfantry(k)).toBe(true);
      expect(wreckValue(k)).toBe(0);
      const u = spawnUnit(w, k, "red", 5.5, 5.5);
      u.hp = 0;
      run(w, 1);
    }
    expect(w.wrecks).toHaveLength(0);
    expect(wreckValue("condor")).toBeGreaterThan(0); // the dropship is a hull like any other
  });

  it("claims supply crates", () => {
    const w = createWorld(20, 20);
    const t = spawnUnit(w, "trooper", "blue", 8.5, 8.5);
    w.objectives.crates.push({ id: 999, x: 8.6, y: 8.5, reward: "scrap", drop: 0, announcedTick: 0, landTick: 0, expireTick: 1000 });
    const fx = run(w, 1);
    expect(fx.find((e) => e.type === "crateClaimed")).toMatchObject({ faction: "blue", collectorId: t.id });
  });
});

describe("the starting Trooper Squad", () => {
  // (on the island map it starts aboard the side's Condor: counted there)
  const troopers = (w: World, f: Faction) =>
    [...w.units.values()].flatMap((u) => [u, ...(u.passengers ?? [])]).filter((u) => u.faction === f && u.kind === "trooper");

  it("stands beside every HQ, as mirror images, on ground it can stand on", () => {
    for (const def of MAPS)
      for (const opts of [{}, { objectives: true }, { openers: { blue: "blitz" as const, red: "airwing" as const } }]) {
        const w = createMapWorld(def.id, opts);
        const [b] = troopers(w, "blue");
        const [r] = troopers(w, "red");
        expect(troopers(w, "blue")).toHaveLength(1);
        expect(troopers(w, "red")).toHaveLength(1);
        expect(mirrorPt(w, r!)).toEqual({ x: expect.closeTo(b!.x, 9), y: expect.closeTo(b!.y, 9) });
        for (const [u, f] of [[b!, "blue"], [r!, "red"]] as const) {
          if (def.squadAboard) {
            // aboard the map's Condor, parked beside the HQ
            expect(carrierOf(w, u.id)?.faction).toBe(f);
            expect(distToBuilding(hqOf(w, f)!, u.x, u.y)).toBeLessThanOrEqual(4);
          } else {
            expect(passable(w, Math.floor(u.x), Math.floor(u.y), "foot")).toBe(true);
            expect(distToBuilding(hqOf(w, f)!, u.x, u.y)).toBeLessThanOrEqual(3);
          }
          expect(u.order.type).toBe("idle");
        }
      }
  });

  it("is every player's in Ops and Last Stand (the wave side has no starting army)", () => {
    // (the Classique Trials: campaign missions field their nations' line squads, and set up more of them)
    for (const op of TRIALS) {
      const w = createMapWorld(op.map, { op: op.id });
      expect(troopers(w, "blue"), op.id).toHaveLength(1);
      expect(troopers(w, "red"), op.id).toHaveLength(hqOf(w, "red") ? 1 : 0);
    }
    const ls = createMapWorld("riverlands", { survival: { difficulty: "normal" } });
    expect(troopers(ls, "blue")).toHaveLength(1);
    expect([...ls.units.values()].filter((u) => u.faction === "red")).toHaveLength(0);
  });
});

describe("determinism", () => {
  /** A short AI-vs-AI match with drops, boarding and crushing thrown in; returns a fingerprint. */
  function play(seed: number): string {
    const w = createMapWorld("riverlands", { seed, objectives: true });
    const ai = { blue: createAiState("balanced", "normal", seed), red: createAiState("rush", "normal", seed + 1) };
    const extra: Record<Faction, { condor: number; squads: number[]; mastodon: number }> = { blue: null!, red: null! };
    for (const f of ["blue", "red"] as const) {
      const hq = hqOf(w, f)!;
      const s = f === "blue" ? 1 : -1;
      const x = hq.tx + 1.5 + 3 * s;
      const y = hq.ty + 1.5 - 3 * s;
      extra[f] = {
        condor: spawnUnit(w, "condor", f, x, y).id,
        squads: [spawnUnit(w, "sniper", f, x + s, y).id, spawnUnit(w, "rocket-squad", f, x, y + s).id],
        mastodon: spawnUnit(w, "mastodon", f, x - s, y + s).id
      };
    }
    const lines: string[] = [];
    for (let i = 0; i < 60 * TICK_RATE && !w.winner; i++) {
      const cmds: Command[] = [...tickAi(w, "blue", ai.blue), ...tickAi(w, "red", ai.red)];
      for (const f of ["blue", "red"] as const) {
        const e = extra[f];
        if (i === 5) cmds.push({ type: "board", faction: f, unitIds: e.squads, carrierId: e.condor });
        if (i === 80) cmds.push({ type: "unload", faction: f, unitIds: [e.condor], x: 28, y: 28 });
        if (i === 90) cmds.push({ type: "attackMove", faction: f, unitIds: [e.mastodon], x: 28, y: 28 });
      }
      step(w, cmds);
      for (const ev of w.fx) if (ev.type === "embark" || ev.type === "disembark" || ev.type === "crush" || ev.type === "death") lines.push(`${w.tick} ${JSON.stringify(ev)}`);
    }
    const units = [...w.units.values()].map((u) => `${u.id} ${u.kind} ${u.x.toFixed(6)} ${u.y.toFixed(6)} ${u.hp.toFixed(4)} ${u.passengers?.map((p) => p.id).join(",") ?? ""}`);
    return [...lines, ...units, w.factions.blue.scrap.toFixed(4), w.factions.red.scrap.toFixed(4)].join("\n");
  }

  it("plays a drop on each side as mirror images", () => {
    const w = createMapWorld("riverlands");
    const side = (f: Faction) => {
      const at = (x: number, y: number) => (f === "blue" ? { x, y } : mirrorPt(w, { x, y }));
      const c = at(12.5, 44.5);
      const condor = spawnUnit(w, "condor", f, c.x, c.y);
      const squads = [at(9.5, 44.5), at(12.5, 47.5)].map((p, i) => spawnUnit(w, i ? "sniper" : "rocket-squad", f, p.x, p.y));
      return { condor, squads, drop: at(15.2, 17.7) }; // out over the river: it snaps to a bank
    };
    const b = side("blue");
    const r = side("red");
    const cmds = (s: typeof b, f: Faction): Command[] => [{ type: "board", faction: f, unitIds: s.squads.map((u) => u.id), carrierId: s.condor.id }];
    run(w, 1, [...cmds(b, "blue"), ...cmds(r, "red")]);
    run(w, 5 * TICK_RATE);
    expect(b.condor.passengers).toHaveLength(2);
    run(w, 1, [
      { type: "unload", faction: "blue", unitIds: [b.condor.id], x: b.drop.x, y: b.drop.y },
      { type: "unload", faction: "red", unitIds: [r.condor.id], x: r.drop.x, y: r.drop.y }
    ]);
    run(w, 15 * TICK_RATE);
    expect(isLoaded(b.condor)).toBe(false);
    for (const [u, v] of [[b.condor, r.condor], ...b.squads.map((s, i) => [s, r.squads[i]!])] as [Unit, Unit][]) {
      expect(mirrorPt(w, v)).toEqual({ x: expect.closeTo(u.x, 9), y: expect.closeTo(u.y, 9) });
      expect(passable(w, Math.floor(u.x), Math.floor(u.y), u.kind === "condor" ? "air" : "foot")).toBe(true);
    }
  });

  it("replays a short match with infantry and Condors identically", () => {
    const a = play(3);
    expect(a).toContain("disembark");
    expect(play(3)).toBe(a);
  });
});
