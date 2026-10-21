import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { goliathBarracks, goliathPhases } from "../src/sim/ai/goliath";
import { GOLIATH, TICK_RATE, UNITS, ZENITH } from "../src/sim/balance";
import {
  SUPER,
  anchorBlocker,
  canRepair,
  goliathCost,
  goliathReachAt,
  isAnchored,
  readyFirepower,
  spawnSuper,
  superKindOf,
  superView,
  trainableAt,
  trainableBy,
  unitCost,
  weaponName,
  weaponStats
} from "../src/sim/goliath";
import { liftBlocker } from "../src/sim/lift";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { Terrain, type Command, type Faction, type GoliathWeapon, type Unit, type World } from "../src/sim/types";
import { buildingCenter, domainOf, hqOf, nearestDropSite, removeBuilding, setTerrain, spawnUnit } from "../src/sim/world";
import { produceUnit } from "../src/sim/economy";

/**
 * WP2 — the Zénith (PANACHE-CONCEPTION.md §1.5): the République's
 * super-unit, an airborne Goliath (goliath.ts SUPER).
 */

const NATIONS = { blue: "republique", red: "empire" } as const;
const MOOR_TICKS = Math.round(ZENITH.anchorTime * TICK_RATE);
const CAST_OFF_TICKS = Math.round(ZENITH.packTime * TICK_RATE);

function run(w: World, n: number, cmds: Command[] = []): void {
  for (let i = 0; i < n; i++) step(w, i === 0 ? cmds : []);
}

/** A République (blue) vs Empire (red) Proving Grounds, and a blue Zénith hovering over open ground near the HQ. */
function setup(): { w: World; z: Unit } {
  const w = createMapWorld("proving-grounds", { nations: NATIONS });
  const hq = buildingCenter(hqOf(w, "blue")!);
  const z = spawnSuper(w, "zenith", "blue", 0, 0);
  // the nearest open 3×3 to the HQ, a few tiles out
  for (let r = 5; r < 20; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        z.x = Math.floor(hq.x + dx) + 0.5;
        z.y = Math.floor(hq.y + dy) + 0.5;
        if (anchorBlocker(w, z) === null) return { w, z };
      }
  throw new Error("no open ground");
}

const moor = (w: World, z: Unit, f: Faction = "blue") => run(w, MOOR_TICKS + 1, [{ type: "anchor", faction: f, unitIds: [z.id] }]);

describe("the Zénith: data and kind", () => {
  it("is the République's super-unit, flies, and fights with ZENITH's systems in the Goliath's slots", () => {
    const { w, z } = setup();
    expect(superKindOf(w, "blue")).toBe("zenith");
    expect(superKindOf(w, "red")).toBe("goliath");
    expect(superKindOf(createMapWorld("proving-grounds"), "blue")).toBe("goliath");
    expect(z.goliath).toBeDefined();
    expect(domainOf(z)).toBe("air");
    expect(weaponStats(z, "mortars")).toBe(ZENITH.weapons.branly);
    expect(weaponStats(z, "laser")).toBe(ZENITH.weapons.arc);
    expect(weaponStats(z, "cannons")).toBe(ZENITH.weapons.bombs);
    expect(weaponStats(z, "mg")).toBe(ZENITH.weapons.mg);
    expect(weaponName("mortars", "zenith")).toBe("Canons Branly de nacelle");
    expect(weaponName("mortars")).toBe(GOLIATH.weapons.mortars.name);
    // its reach: the Branly guns on the ground (7), the bow arc in the air (5)
    expect(goliathReachAt(z, "ground")).toBe(7);
    expect(goliathReachAt(z, "air")).toBe(5);
  });

  it("a Zénith spawned the plain way gets its state on the next tick", () => {
    const w = createMapWorld("proving-grounds", { nations: NATIONS });
    const z = spawnUnit(w, "zenith", "blue", 20, 20);
    run(w, 1);
    expect(z.goliath?.mode).toBe("walking");
  });

  it("costs 25% more for each Zénith already owned; the Goliath's price is its own", () => {
    const { w } = setup();
    expect(goliathCost(w, "blue")).toBe(Math.round(UNITS.zenith.cost * 1.25));
    expect(unitCost(w, "blue", "zenith")).toBe(Math.round(UNITS.zenith.cost * 1.25));
    expect(unitCost(w, "red", "goliath")).toBe(UNITS.goliath.cost);
  });

  it("is never lifted: it flies", () => {
    const { w, z } = setup();
    const c1 = spawnUnit(w, "condor", "blue", z.x + 1, z.y);
    const c2 = spawnUnit(w, "condor", "blue", z.x - 1, z.y);
    expect(liftBlocker([c1, c2], z)).toBe("Il vole déjà");
  });
});

describe("mooring", () => {
  it("moors in ZENITH.anchorTime over buildable ground, and casts off in ZENITH.packTime", () => {
    const { w, z } = setup();
    run(w, MOOR_TICKS - 1, [{ type: "anchor", faction: "blue", unitIds: [z.id] }]);
    expect(z.goliath!.mode).toBe("anchoring");
    const v = superView(z)!;
    expect(v.flies).toBe(true);
    expect(v.progress).toBeGreaterThan(0.8);
    expect(v.moored).toBe(false);
    run(w, 2);
    expect(isAnchored(z)).toBe(true);
    expect(superView(z)!.moored).toBe(true);
    // the mast takes its 2×2: stamped in the occupancy grid
    const foot = z.goliath!.foot!;
    expect(w.occupancy[foot.ty * w.width + foot.tx]).toBe(z.id);
    expect(anchorBlocker(w, z)).toBe("Déjà amarré");
    run(w, CAST_OFF_TICKS + 1, [{ type: "packUp", faction: "blue", unitIds: [z.id] }]);
    expect(z.goliath!.mode).toBe("walking");
    expect(w.occupancy[foot.ty * w.width + foot.tx]).toBe(0);
  });

  it("only over buildable ground: never over water, rock, or a building", () => {
    const { w, z } = setup();
    const tx = Math.floor(z.x);
    const ty = Math.floor(z.y);
    for (let y = ty - 2; y <= ty + 2; y++) for (let x = tx - 2; x <= tx + 2; x++) setTerrain(w, x, y, Terrain.Water);
    expect(anchorBlocker(w, z)).toBe("Sol dégagé requis");
    run(w, MOOR_TICKS + 1, [{ type: "anchor", faction: "blue", unitIds: [z.id] }]);
    expect(z.goliath!.mode).toBe("walking");
    for (let y = ty - 2; y <= ty + 2; y++) for (let x = tx - 2; x <= tx + 2; x++) setTerrain(w, x, y, Terrain.Rock);
    expect(anchorBlocker(w, z)).toBe("Sol dégagé requis");
    // over its own HQ
    const hq = buildingCenter(hqOf(w, "blue")!);
    z.x = hq.x;
    z.y = hq.y;
    expect(anchorBlocker(w, z)).toBe("Bloqué");
  });

  it("moored, it is a drop-off for harvesters", () => {
    const { w, z } = setup();
    moor(w, z);
    const ds = nearestDropSite(w, "blue", z.x + 1, z.y + 1);
    expect(ds?.id).toBe(z.id);
  });
});

describe("production while moored", () => {
  it("trains Éole, Blériot, Pasteur and Patrie — not infantry — and only moored", () => {
    const { w, z } = setup();
    for (const k of ZENITH.trains) {
      expect(trainableAt(w, k), k).toBe(true);
      expect(trainableBy(w, z, k), k).toBe(true);
    }
    expect(trainableBy(w, z, "trooper")).toBe(false);
    expect(trainableBy(w, z, "sapeurs")).toBe(false);
    expect(trainableAt(w, "trooper")).toBe(false);
    // the Empire's Goliath still trains its infantry
    expect(trainableAt(w, "fusiliers")).toBe(true);
    // Classique: unchanged
    const cw = createMapWorld("proving-grounds");
    expect(trainableAt(cw, "trooper")).toBe(true);
    expect(trainableAt(cw, "wasp")).toBe(false);

    w.factions.blue.scrap = 5000;
    produceUnit(w, "blue", z.id, "wasp");
    expect(z.goliath!.queue.length).toBe(0); // not moored yet
    moor(w, z);
    produceUnit(w, "blue", z.id, "wasp");
    produceUnit(w, "blue", z.id, "trooper");
    expect(z.goliath!.queue.map((q) => q.kind)).toEqual(["wasp"]);
    const before = [...w.units.values()].filter((u) => u.kind === "wasp" && u.faction === "blue").length;
    run(w, Math.ceil(UNITS.wasp.buildTime * TICK_RATE) + 2);
    const wasps = [...w.units.values()].filter((u) => u.kind === "wasp" && u.faction === "blue");
    expect(wasps.length).toBe(before + 1);
    expect(Math.hypot(wasps[wasps.length - 1]!.x - z.x, wasps[wasps.length - 1]!.y - z.y)).toBeLessThan(4);
  });
});

describe("weapon systems", () => {
  it("are lost at 75 / 50 / 25% (Branly, bow arc, bombs) and the machine guns never", () => {
    const { w, z } = setup();
    w.powers.stunned.set(z.id, 1e9); // (frozen: no firing, no moving)
    const max = UNITS.zenith.hp;
    const down = (): GoliathWeapon[] => (["mortars", "laser", "cannons", "mg"] as const).filter((k) => !z.goliath!.weapons[k].online);
    z.hp = max * 0.74;
    run(w, 1);
    expect(down()).toEqual(["mortars"]);
    expect(superView(z)!.weapons.find((x) => x.slot === "mortars")).toMatchObject({ id: "branly", online: false });
    z.hp = max * 0.49;
    run(w, 1);
    expect(down()).toEqual(["mortars", "laser"]);
    z.hp = max * 0.24;
    run(w, 1);
    expect(down()).toEqual(["mortars", "laser", "cannons"]);
    z.hp = 1;
    run(w, 1);
    expect(down()).toEqual(["mortars", "laser", "cannons"]);
    expect(readyFirepower(z)).toBeCloseTo(ZENITH.weapons.mg.dps / 105, 5);
    expect(goliathReachAt(z, "ground")).toBe(ZENITH.weapons.mg.range);
  });
});

describe("repair", () => {
  it("only Pasteurs (Menders) may repair it; the Goliath takes any healer", () => {
    const { w, z } = setup();
    expect(SUPER.zenith.repairedBy).toEqual(["mender"]);
    expect(canRepair("mender", z)).toBe(true);
    expect(canRepair("atelier", z)).toBe(false);
    const g = spawnSuper(w, "goliath", "red", 10, 10);
    expect(canRepair("atelier", g)).toBe(true);
    expect(canRepair("mender", g)).toBe(true);
    const tank = spawnUnit(w, "lancer", "blue", 5, 5);
    expect(canRepair("atelier", tank)).toBe(true);
  });

  it("a Pasteur brings it back up and its systems reboot; no veteran self-repair", () => {
    const { w, z } = setup();
    z.hp = UNITS.zenith.hp * 0.7;
    z.rank = 3;
    run(w, 5 * TICK_RATE);
    expect(z.hp).toBeCloseTo(UNITS.zenith.hp * 0.7, 3); // (no self-repair, even at rank 3)
    expect(z.goliath!.weapons.mortars.online).toBe(false);
    spawnUnit(w, "mender", "blue", z.x + 1, z.y);
    let t = 0;
    while (!z.goliath!.weapons.mortars.online && t++ < 120 * TICK_RATE) step(w, []);
    expect(z.goliath!.weapons.mortars.online).toBe(true);
    expect(z.hp / UNITS.zenith.hp).toBeGreaterThanOrEqual(0.75 + ZENITH.restoreMargin);
  });
});

describe("the AI", () => {
  it("drives a Zénith: with its HQ gone it moors as the base and turns out aircraft", () => {
    const w = createMapWorld("proving-grounds", { nations: { blue: "empire", red: "republique" } });
    const hq = hqOf(w, "red")!;
    const c = buildingCenter(hq);
    removeBuilding(w, hq);
    const z = spawnSuper(w, "zenith", "red", c.x, c.y);
    w.factions.red.scrap = 4000;
    const s = createAiState("balanced", "normal", 1);
    const blueHq = hqOf(w, "blue")!;
    blueHq.hp = 1e9;
    let moored = -1;
    const trained: string[] = [];
    for (let i = 0; i < 90 * TICK_RATE && !w.winner; i++) {
      const cmds = tickAi(w, "red", s);
      for (const cmd of cmds) if (cmd.type === "produce" && cmd.buildingId === z.id) trained.push(cmd.unit);
      step(w, cmds);
      if (moored < 0 && isAnchored(z)) moored = i;
    }
    expect(moored).toBeGreaterThanOrEqual(0);
    expect(goliathPhases(s).get(z.id)).toBe("hold");
    expect(trained.length).toBeGreaterThan(0);
    for (const k of trained) expect(ZENITH.trains).toContain(k);
  }, 60000);

  it("its hangar picks aircraft, a Pasteur first when it is hurt", () => {
    const { w, z } = setup();
    moor(w, z);
    const s = createAiState("balanced", "normal", 1);
    const r = () => 0.5;
    expect(goliathBarracks(w, "blue", s, r, true).map((t) => t.kind)).toEqual(["wasp"]);
    z.hp = UNITS.zenith.hp * 0.6;
    expect(goliathBarracks(w, "blue", s, r, true).map((t) => t.kind)).toEqual(["mender"]);
  });
});
