import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, NATIONS, POWERS, TICK_RATE, UNITS } from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { areaBlast, findTarget } from "../src/sim/combat";
import { canPlaceBuilding, nearestReachableResource } from "../src/sim/economy";
import { isVisible, tickFog } from "../src/sim/fog";
import { concealedFrom } from "../src/sim/infantry";
import { createMapWorld } from "../src/sim/maps";
import { unitStepSpeed } from "../src/sim/movement";
import { behaves, buildingMaxHp, harvestRate, holdOf, nationKind, radiumValue } from "../src/sim/nations";
import { placementBlocker } from "../src/sim/placement";
import { isStunned, powerStatus } from "../src/sim/powers";
import { applyMutators } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import { Terrain, type Command, type Faction, type Nation, type PowerKind, type World } from "../src/sim/types";
import { createWorld, hqOf, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

/** An open field with nations, both HQs (placed after the rules, so with their nation's HP), meters full. */
function arena(blue: Nation, red: Nation, size = 48): World {
  const w = createWorld(size, size);
  applyMutators(w, [], { blue, red });
  spawnBuilding(w, "hq", "blue", 2, 2);
  spawnBuilding(w, "hq", "red", size - 5, size - 5);
  w.powers.meter.blue = w.powers.meter.red = 100;
  return w;
}

const run = (w: World, n: number, cmds: Command[] = []) => {
  for (let i = 0; i < n; i++) step(w, i === 0 ? cmds : []);
};
const call = (faction: Faction, power: PowerKind, x: number, y: number): Command => ({ type: "calldown", faction, power, x, y });
const seeAll = (w: World) => {
  tickFog(w);
  w.fog.blue.vis.fill(2);
  w.fog.red.vis.fill(2);
};

describe("behaves(): nation units reuse their base behaviour", () => {
  it("maps kinds to their base, and every Classique kind to itself only", () => {
    expect(behaves("fourgon", "harvester")).toBe(true);
    expect(behaves("atelier", "mender")).toBe(true);
    expect(behaves("titan", "condor")).toBe(true);
    expect(behaves("carabiniers", "sniper")).toBe(true);
    expect(behaves("fusiliers", "trooper")).toBe(true);
    expect(behaves("harvester", "harvester")).toBe(true);
    expect(behaves("stinger", "harvester")).toBe(false);
    expect(behaves("sniper", "trooper")).toBe(false);
  });

  it("nationKind swaps a Classique kind for the nation's own in the same role", () => {
    const w = arena("republique", "empire");
    expect(nationKind(w, "blue", "harvester")).toBe("fourgon");
    expect(nationKind(w, "blue", "trooper")).toBe("trooper");
    expect(nationKind(w, "red", "trooper")).toBe("fusiliers");
    expect(nationKind(w, "red", "condor")).toBe("titan");
    expect(nationKind(createWorld(8, 8), "blue", "harvester")).toBe("harvester");
  });
});

describe("starting forces", () => {
  it("each nation starts with its worker and line squad; Classique as before", () => {
    const w = createMapWorld("riverlands", { nations: { blue: "republique", red: "empire" } });
    const kinds = (f: Faction) => [...w.units.values()].filter((u) => u.faction === f).map((u) => u.kind).sort();
    expect(kinds("blue")).toEqual(["fourgon", "trooper"]);
    expect(kinds("red")).toEqual(["fusiliers", "harvester"]);
    expect(hqOf(w, "blue")!.hp).toBe(Math.round(BUILDINGS.hq.hp * NATIONS.republique.buildingHp));
    expect(hqOf(w, "red")!.hp).toBe(Math.round(BUILDINGS.hq.hp * NATIONS.empire.buildingHp));
    const c = createMapWorld("riverlands");
    expect([...c.units.values()].map((u) => u.kind).sort()).toEqual(["harvester", "harvester", "trooper", "trooper"]);
    expect(c.nation).toBeUndefined();
  });

  it("the island map's Condor is a Titan for the Empire", () => {
    const w = createMapWorld("archipelago", { nations: { blue: "republique", red: "empire" } });
    const kinds = (f: Faction) => [...w.units.values()].filter((u) => u.faction === f).map((u) => u.kind);
    expect(kinds("blue")).toContain("condor");
    expect(kinds("red")).toContain("titan");
  });

  it("Nomads and Goliath Armada are left out when the République plays", () => {
    const rep = createMapWorld("riverlands", { mutators: ["nomads"], nations: { blue: "republique", red: "empire" } });
    expect(rep.rules!.nomads).toBeFalsy();
    const emp = createMapWorld("riverlands", { mutators: ["nomads"], nations: { blue: "empire", red: "empire" } });
    expect(emp.rules!.nomads).toBe(true);
  });
});

describe("economy multipliers", () => {
  it("the Fourgon harvests on its own, holds 80, and brings it home", () => {
    const w = createMapWorld("riverlands", { nations: { blue: "republique", red: "empire" } });
    const f = [...w.units.values()].find((u) => u.kind === "fourgon")!;
    const field = nearestReachableResource(w, f.x, f.y, "blue")!;
    const before = w.factions.blue.scrap;
    let max = 0;
    step(w, [{ type: "harvest", faction: "blue", unitIds: [f.id], x: field.x + 0.5, y: field.y + 0.5 }]);
    for (let i = 0; i < 90 * TICK_RATE; i++) {
      step(w, []);
      max = Math.max(max, f.cargo);
    }
    expect(holdOf("fourgon")).toBe(80);
    expect(max).toBeCloseTo(80, 5);
    expect(w.factions.blue.stats.scrapHarvested).toBeGreaterThan(150);
    expect(w.factions.blue.scrap).toBeGreaterThan(before);
  });

  it("radium pays the République ×1.5, coal comes 15 % faster for the Empire", () => {
    const w = arena("republique", "empire");
    expect(radiumValue(w, "blue")).toBe(2.4);
    expect(radiumValue(w, "red")).toBe(ECONOMY.crystalValue);
    expect(harvestRate(w, "red", false)).toBeCloseTo(ECONOMY.harvestRate * 1.15, 9);
    expect(harvestRate(w, "red", true)).toBe(ECONOMY.harvestRate);
    // a Fourgon digging radium: 2.4 scrap in the hold per unit mined
    setTerrain(w, 20, 20, Terrain.Crystal);
    const f = spawnUnit(w, "fourgon", "blue", 20.5, 20.5);
    f.order = { type: "harvest", fieldX: 20, fieldY: 20, phase: "harvesting" };
    run(w, 10);
    expect(f.cargo).toBeCloseTo(10 * (ECONOMY.harvestRate / TICK_RATE) * 2.4, 6);
  });

  it("buildings cost, take and hold the nation's multiples; units take its build time", () => {
    const w = arena("republique", "empire");
    const s = { blue: w.factions.blue.scrap, red: w.factions.red.scrap };
    run(w, 1, [
      { type: "startBuilding", faction: "blue", building: "radar" },
      { type: "startBuilding", faction: "red", building: "fab-plant" }
    ]);
    expect(s.blue - w.factions.blue.scrap).toBe(Math.round(150 * 0.85));
    expect(s.red - w.factions.red.scrap).toBe(Math.round(300 * 1.1));
    expect(w.factions.red.pending!.remaining).toBeCloseTo(BUILDINGS["fab-plant"].buildTime * TICK_RATE * 1.15 - 1, 6);
    const fab = spawnBuilding(w, "fab-plant", "blue", 6, 2);
    expect(fab.hp).toBe(buildingMaxHp(w, fab));
    expect(fab.hp).toBe(Math.round(BUILDINGS["fab-plant"].hp * 0.8));
    w.factions.blue.scrap = 5000;
    run(w, 1, [{ type: "produce", faction: "blue", buildingId: fab.id, unit: "jamais-contente" }]);
    expect(fab.queue[0]!.remaining).toBeCloseTo(UNITS["jamais-contente"].buildTime * TICK_RATE * 0.85 - 1, 6);
  });
});

describe("Vapeur: an Empire factory builds two units at once", () => {
  it("both of the first two queue items advance together, at ×1.3 build time", () => {
    const w = arena("republique", "empire");
    const fab = spawnBuilding(w, "fab-plant", "red", 30, 30);
    w.factions.red.scrap = 5000;
    const q = (n: number): Command[] => Array.from({ length: n }, () => ({ type: "produce", faction: "red", buildingId: fab.id, unit: "stinger" }) as Command);
    run(w, 1, q(3));
    expect(fab.queue).toHaveLength(3);
    expect(fab.queue[0]!.remaining).toBe(fab.queue[1]!.remaining);
    expect(fab.queue[2]!.remaining).toBe(UNITS.stinger.buildTime * TICK_RATE * 1.3);
    const ticks = Math.ceil(UNITS.stinger.buildTime * TICK_RATE * 1.3);
    run(w, ticks);
    expect([...w.units.values()].filter((u) => u.kind === "stinger")).toHaveLength(2);
    expect(fab.queue).toHaveLength(1);
  });

  it("a République factory still builds one at a time", () => {
    const w = arena("republique", "empire");
    const fab = spawnBuilding(w, "fab-plant", "blue", 6, 2);
    w.factions.blue.scrap = 5000;
    run(w, 1, [0, 1].map(() => ({ type: "produce", faction: "blue", buildingId: fab.id, unit: "jamais-contente" }) as Command));
    expect(fab.queue[1]!.remaining).toBe(UNITS["jamais-contente"].buildTime * TICK_RATE * 0.85);
  });
});

describe("Réseau électrique", () => {
  it("République buildings go up only in reach of the GQG or a Tour TSF", () => {
    const w = arena("republique", "empire");
    // GQG at (2,2)-(5,5), centre (3.5,3.5), reach 8 to the footprint edge
    expect(canPlaceBuilding(w, "blue", "fab-plant", 10, 2)).toBe(true);
    expect(canPlaceBuilding(w, "blue", "fab-plant", 13, 2)).toBe(false);
    expect(placementBlocker(w, "blue", "fab-plant", 13, 2)).toBe("Hors du réseau électrique");
    spawnBuilding(w, "radar", "blue", 10, 4);
    expect(canPlaceBuilding(w, "blue", "fab-plant", 16, 2)).toBe(true);
    // the Empire keeps the classic 6 tiles
    expect(canPlaceBuilding(w, "red", "fab-plant", 48 - 5 - 8, 48 - 5)).toBe(false);
  });

  it("a building cut off its tower stops producing and firing; it powers up again", () => {
    const w = arena("republique", "empire");
    const tower = spawnBuilding(w, "radar", "blue", 11, 3);
    const fab = spawnBuilding(w, "fab-plant", "blue", 14, 3);
    const coil = spawnBuilding(w, "arsonval", "blue", 14, 7);
    w.factions.blue.scrap = 5000;
    run(w, TICK_RATE, [{ type: "produce", faction: "blue", buildingId: fab.id, unit: "jamais-contente" }]);
    expect(fab.unpowered).toBeUndefined();
    const progress = fab.queue[0]!.remaining;
    tower.hp = 0;
    run(w, TICK_RATE + 1);
    expect(fab.unpowered).toBe(true);
    expect(coil.unpowered).toBe(true);
    expect(hqOf(w, "blue")!.unpowered).toBeUndefined();
    const paused = fab.queue[0]!.remaining;
    expect(paused).toBeLessThan(progress);
    run(w, 30);
    expect(fab.queue[0]!.remaining).toBe(paused);
    // an enemy in the coil's reach: no shot while it is dark
    const t = spawnUnit(w, "stinger", "red", 15.5, 10);
    t.cooldown = 1e9;
    run(w, 20);
    expect(t.hp).toBe(UNITS.stinger.hp);
    spawnBuilding(w, "radar", "blue", 11, 6);
    run(w, TICK_RATE + 1);
    expect(fab.unpowered).toBeUndefined();
    expect(t.hp).toBeLessThan(UNITS.stinger.hp);
  });
});

describe("Réseau TSF", () => {
  it("République units near a Tour TSF move faster and see further", () => {
    const w = arena("republique", "empire");
    spawnBuilding(w, "radar", "blue", 20, 20);
    const near = spawnUnit(w, "jamais-contente", "blue", 24.5, 20.5);
    const far = spawnUnit(w, "jamais-contente", "blue", 40.5, 10.5);
    const enemy = spawnUnit(w, "stinger", "red", 22.5, 22.5);
    run(w, TICK_RATE);
    expect(near.tsf).toBe(true);
    expect(far.tsf).toBeUndefined();
    expect(enemy.tsf).toBeUndefined();
    const base = UNITS["jamais-contente"].speed / TICK_RATE;
    expect(unitStepSpeed(w, near) / unitStepSpeed(w, far)).toBeCloseTo(NATIONS.republique.tsf!.speed, 9);
    expect(unitStepSpeed(w, far)).toBeCloseTo(base, 9);
    tickFog(w);
    // sight 6 + 2: a tile 7.5 to the east of the boosted car is in sight
    expect(isVisible(w, "blue", 32, 20)).toBe(true);
  });
});

describe("Tranchées", () => {
  it("an Empire squad standing still digs in after 3 s, not before, and takes ×0.7", () => {
    const w = arena("republique", "empire");
    const fus = spawnUnit(w, "fusiliers", "red", 25.5, 25.5);
    const ref = spawnUnit(w, "trooper", "blue", 20.5, 25.5);
    fus.cooldown = ref.cooldown = 1e9;
    run(w, 2 * TICK_RATE);
    expect(fus.entrenched).toBeUndefined();
    run(w, 2 * TICK_RATE);
    expect(fus.entrenched).toBe(true);
    expect(ref.entrenched).toBeUndefined(); // (not the République's)
    const hp = fus.hp;
    areaBlast(w, "blue", fus.x, fus.y, 0.1, 100, "kinetic", "ground", 0);
    expect(hp - fus.hp).toBeCloseTo(100 * NATIONS.empire.trench!.mult, 6);
    // a move order and the trench is gone
    run(w, 2, [{ type: "move", faction: "red", unitIds: [fus.id], x: 30, y: 30 }]);
    expect(fus.entrenched).toBeUndefined();
  });

  it("next to an Empire Hotchkiss a squad is dug in at once", () => {
    const w = arena("republique", "empire");
    spawnBuilding(w, "turret", "red", 30, 30);
    const fus = spawnUnit(w, "fusiliers", "red", 32, 30.5);
    run(w, 3);
    expect(fus.entrenched).toBe(true);
  });
});

describe("the nations' powers", () => {
  it("each side fires only its own nation's powers", () => {
    const w = arena("republique", "empire");
    seeAll(w);
    run(w, 1, [call("blue", "barrage", 30, 30), call("red", "sonde", 10, 10)]);
    expect(w.powers.active).toHaveLength(0);
    run(w, 1, [call("blue", "sonde", 30, 30)]);
    expect(w.powers.active).toHaveLength(1);
  });

  it("Ballon-sonde reveals the area for 20 s, Snipers in Woods included", () => {
    const w = arena("republique", "empire");
    tickFog(w);
    for (let y = 28; y <= 32; y++) for (let x = 28; x <= 32; x++) setTerrain(w, x, y, Terrain.Forest);
    const sniper = spawnUnit(w, "carabiniers", "red", 30.5, 30.5);
    sniper.cooldown = 1e9;
    expect(concealedFrom(w, "blue", sniper)).toBe(true);
    run(w, POWERS.sonde.telegraph * TICK_RATE + 4, [call("blue", "sonde", 30, 30)]); // (unexplored ground: the sonde may go there)
    expect(w.nation!.reveals).toHaveLength(1);
    expect(isVisible(w, "blue", 30, 30)).toBe(true);
    expect(concealedFrom(w, "blue", sniper)).toBe(false);
    run(w, POWERS.sonde.duration * TICK_RATE);
    expect(w.nation!.reveals).toHaveLength(0);
    expect(concealedFrom(w, "blue", sniper)).toBe(true);
  });

  it("Gaz de houille: the enemy can't see into the cloud, and picks targets in it only within 2 tiles", () => {
    const w = arena("republique", "empire");
    seeAll(w);
    const fus = spawnUnit(w, "fusiliers", "red", 30.5, 30.5);
    fus.cooldown = 1e9;
    run(w, POWERS.gaz.telegraph * TICK_RATE + 1, [call("red", "gaz", 30.5, 30.5)]);
    expect(w.nation!.clouds).toHaveLength(1);
    tickFog(w);
    expect(isVisible(w, "blue", 30, 30)).toBe(false);
    expect(isVisible(w, "red", 30, 30)).toBe(true);
    // a République shooter 2.5 tiles off doesn't pick it out; 1.5 tiles off it does
    expect(findTarget(w, "blue", "ground", 33, 30.5, 6)?.id).not.toBe(fus.id);
    expect(findTarget(w, "blue", "ground", 32, 30.5, 6)?.id).toBe(fus.id);
    run(w, POWERS.gaz.duration * TICK_RATE);
    expect(w.nation!.clouds).toHaveLength(0);
    expect(findTarget(w, "blue", "ground", 33, 30.5, 6)?.id).toBe(fus.id);
  });

  it("Pression des chaudières: own ground vehicles go faster and fire faster for 10 s, then overheat 3 s", () => {
    const w = arena("republique", "empire");
    seeAll(w);
    const tank = spawnUnit(w, "stinger", "red", 30.5, 30.5);
    const squad = spawnUnit(w, "fusiliers", "red", 31.5, 30.5);
    const plain = unitStepSpeed(w, tank);
    run(w, POWERS.pression.telegraph * TICK_RATE + 1, [call("red", "pression", 30.5, 30.5)]);
    expect(tank.overdrive).toBeGreaterThan(w.tick);
    expect(squad.overdrive).toBeUndefined();
    expect(unitStepSpeed(w, tank) / plain).toBeCloseTo(POWERS.pression.speed, 9);
    run(w, POWERS.pression.duration * TICK_RATE);
    expect(tank.overdrive).toBeUndefined();
    expect(isStunned(w, tank.id)).toBe(true);
    run(w, POWERS.pression.overheat * TICK_RATE + 1);
    expect(isStunned(w, tank.id)).toBe(false);
  });

  it("Rayon Curie: locked until 6:00, then 300 × falloff on units and 450 on buildings", () => {
    const w = arena("republique", "empire");
    seeAll(w);
    expect(powerStatus(w, "blue", "curie").locked).toBeGreaterThan(0);
    w.tick = POWERS.curie.unlock * TICK_RATE;
    w.powers.readyAt.blue.curie = w.tick;
    seeAll(w);
    const t = spawnUnit(w, "mastodon", "red", 30.5, 30.5);
    const b = spawnBuilding(w, "fab-plant", "red", 32, 29);
    t.cooldown = 1e9;
    const bhp = b.hp;
    run(w, POWERS.curie.telegraph * TICK_RATE + 1, [call("blue", "curie", 30.5, 30.5)]);
    expect(UNITS.mastodon.hp - t.hp).toBeCloseTo(POWERS.curie.unitDamage, 6);
    expect(bhp - b.hp).toBeCloseTo(POWERS.curie.buildingDamage, 6);
  });
});

describe("Atelier roulant", () => {
  it("repairs ground units and buildings, never aircraft", () => {
    const w = arena("republique", "empire");
    const at = spawnUnit(w, "atelier", "red", 30.5, 30.5);
    const air = spawnUnit(w, "gyroptere", "red", 31.5, 30.5);
    air.hp = 100;
    air.order = { type: "move", x: 31.5, y: 30.5 };
    run(w, 20);
    expect(air.hp).toBe(100);
    const tank = spawnUnit(w, "stinger", "red", 30.5, 31.5);
    tank.hp = 100;
    run(w, 20);
    expect(tank.hp).toBeGreaterThan(100);
    expect(at.hp).toBe(UNITS.atelier.hp);
  });
});

describe("arc-shell and heavy-shell", () => {
  it("are simulated shells that land with their splash", () => {
    const w = arena("republique", "empire");
    const gun = spawnUnit(w, "mortier-280", "red", 30.5, 30.5);
    const t = spawnUnit(w, "jamais-contente", "blue", 30.5, 22.5);
    t.cooldown = 1e9;
    let shot = false;
    for (let i = 0; i < 60 && t.hp === UNITS["jamais-contente"].hp; i++) {
      step(w, []);
      shot ||= w.fx.some((e) => e.type === "shot" && e.fx === "heavy-shell" && e.sourceId === gun.id);
    }
    expect(shot).toBe(true);
    expect(t.hp).toBeLessThan(UNITS["jamais-contente"].hp);
  });
});

/** A scripted nations match: each side sends its worker out, builds a factory and units, fires its powers. */
function scripted(blue: Nation, red: Nation, mirror: boolean): World {
  const w = createMapWorld("riverlands", { seed: 7, nations: { blue, red } });
  w.factions.blue.scrap = w.factions.red.scrap = 3000;
  const mirrorPt = (p: { x: number; y: number }) => ({ x: w.width - p.x, y: w.height - p.y });
  for (let t = 0; t < 3 * 60 * TICK_RATE; t++) {
    const cmds: Command[] = [];
    for (const f of ["blue", "red"] as const) {
      if (t === 0)
        for (const u of w.units.values())
          if (u.faction === f && behaves(u.kind, "harvester")) {
            const fld = nearestReachableResource(w, u.x, u.y, f)!;
            cmds.push({ type: "harvest", faction: f, unitIds: [u.id], x: fld.x + 0.5, y: fld.y + 0.5 });
          }
      if (t === 5) cmds.push({ type: "startBuilding", faction: f, building: "fab-plant" });
      const pend = w.factions[f].pending;
      if (pend?.ready) {
        const hq = hqOf(w, f)!;
        const at = f === "blue" || !mirror ? { x: hq.tx + 4, y: hq.ty - 3 } : { x: hq.tx - 3, y: hq.ty + 4 };
        cmds.push({ type: "placeBuilding", faction: f, tx: at.x, ty: at.y });
      }
      if (t % 100 === 50)
        for (const b of w.buildings.values())
          if (b.faction === f && b.kind === "fab-plant") {
            const n = f === "blue" ? blue : red;
            cmds.push({ type: "produce", faction: f, buildingId: b.id, unit: n === "republique" ? "jamais-contente" : "stinger" });
          }
      if (t === 900) {
        const c = { x: 32, y: 32 };
        const p = f === "blue" ? c : mirrorPt(c);
        const n = f === "blue" ? blue : red;
        cmds.push(call(f, n === "republique" ? "sonde" : "gaz", p.x, p.y));
      }
    }
    step(w, cmds);
  }
  return w;
}

describe("determinism and symmetry", () => {
  it("two worlds fed the same commands hash the same", () => {
    const a = scripted("republique", "empire", false);
    const b = scripted("republique", "empire", false);
    expect(worldHash(a)).toBe(worldHash(b));
    expect(a.nation).toBeTruthy();
    expect([...a.units.values()].some((u) => u.kind === "jamais-contente")).toBe(true);
    expect([...a.units.values()].filter((u) => u.kind === "stinger").length).toBeGreaterThan(0);
  });

  for (const n of ["republique", "empire"] as const)
    it(`a ${n} mirror match plays as mirror images`, () => {
      const w = createMapWorld("riverlands", { seed: 3, nations: { blue: n, red: n } });
      const cmds: Command[] = [];
      for (const f of ["blue", "red"] as const)
        for (const u of w.units.values())
          if (u.faction === f && behaves(u.kind, "harvester")) {
            const fld = nearestReachableResource(w, u.x, u.y, f)!;
            cmds.push({ type: "harvest", faction: f, unitIds: [u.id], x: fld.x + 0.5, y: fld.y + 0.5 });
          }
      run(w, 2 * 60 * TICK_RATE, cmds);
      expect(w.factions.blue.stats.scrapHarvested).toBeGreaterThan(0);
      expect(w.factions.blue.stats.scrapHarvested).toBeCloseTo(w.factions.red.stats.scrapHarvested, 6);
      const pos = (f: Faction) => [...w.units.values()].filter((u) => u.faction === f).map((u) => (f === "blue" ? [u.x, u.y] : [w.width - u.x, w.height - u.y]));
      const b = pos("blue");
      const r = pos("red");
      b.forEach((p, i) => {
        expect(p[0]).toBeCloseTo(r[i]![0]!, 6);
        expect(p[1]).toBeCloseTo(r[i]![1]!, 6);
      });
    });
});
