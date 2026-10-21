import { describe, expect, it } from "vitest";
import { DAILY_MUTATORS, dailyOp } from "../src/game/daily";
import { ECONOMY, GOLIATH, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, producersOf, unitBlocker } from "../src/sim/economy";
import { goliathsOf, isLifted } from "../src/sim/goliath";
import { createMapWorld } from "../src/sim/maps";
import { OPENER_IDS, allowedOpener, openerBlocked } from "../src/sim/openers";
import { powerBlocker } from "../src/sim/powers";
import { MUTATORS, MUTATOR_IDS, makeRules, mutatorsCompatible, toggleMutator } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { Command, World } from "../src/sim/types";
import { createWorld, domainOf, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";

/** Step `n` ticks, `cmds` on the first. */
function run(w: World, n: number, cmds: Command[] = []): void {
  for (let i = 0; i < n && !w.winner; i++) step(w, i === 0 ? cmds : []);
}

describe("Nomads", () => {
  it("replaces each HQ with a Gargantua anchored where it stood, mirror-placed", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    expect(hqOf(w, "blue")).toBeNull();
    expect(hqOf(w, "red")).toBeNull();
    const [b] = goliathsOf(w, "blue");
    const [r] = goliathsOf(w, "red");
    expect(b!.goliath!.mode).toBe("anchored");
    expect(r!.goliath!.mode).toBe("anchored");
    expect(b!.x + r!.x).toBeCloseTo(w.width, 9);
    expect(b!.y + r!.y).toBeCloseTo(w.height, 9);
    // the starting Harvester and Trooper Squad are still there
    for (const f of ["blue", "red"] as const) {
      expect([...w.units.values()].filter((u) => u.faction === f && u.kind === "harvester")).toHaveLength(1);
      expect([...w.units.values()].filter((u) => u.faction === f && u.kind === "trooper")).toHaveLength(1);
    }
  });

  it("builds Harvesters at the anchored Gargantua, which takes their scrap", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    const g = goliathsOf(w, "blue")[0]!;
    expect(unitBlocker(w, "blue", "harvester")).toBeNull();
    expect(producersOf(w, "blue", "harvester").map((p) => p.id)).toEqual([g.id]);
    const scrap = w.factions.blue.scrap;
    run(w, 1, [{ type: "produce", faction: "blue", buildingId: g.id, unit: "harvester" }]);
    expect(w.factions.blue.scrap).toBe(scrap - UNITS.harvester.cost);
    run(w, (UNITS.harvester.buildTime + 1) * TICK_RATE);
    expect([...w.units.values()].filter((u) => u.faction === "blue" && u.kind === "harvester")).toHaveLength(2);
    // a minute of mining pays at the Goliath (no HQ trickle, no other drop-off)
    const before = w.factions.blue.stats.scrapHarvested;
    run(w, 60 * TICK_RATE);
    expect(w.factions.blue.stats.scrapHarvested).toBeGreaterThan(before);
  });

  it("builds outposts in the Gargantua's ring, and never a second HQ", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    const g = goliathsOf(w, "blue")[0]!;
    let placed = 0;
    for (let ty = Math.floor(g.y) - 5; ty <= g.y + 5; ty++)
      for (let tx = Math.floor(g.x) - 5; tx <= g.x + 5; tx++) {
        if (canPlaceBuilding(w, "blue", "fab-plant", tx, ty)) placed++;
        expect(canPlaceBuilding(w, "blue", "hq", tx, ty)).toBe(false);
      }
    expect(placed).toBeGreaterThan(0);
    run(w, 1, [{ type: "startBuilding", faction: "blue", building: "fab-plant" }]);
    run(w, 10 * TICK_RATE + 2);
    outer: for (let ty = Math.floor(g.y) - 5; ty <= g.y + 5; ty++)
      for (let tx = Math.floor(g.x) - 5; tx <= g.x + 5; tx++)
        if (canPlaceBuilding(w, "blue", "fab-plant", tx, ty)) {
          run(w, 1, [{ type: "placeBuilding", faction: "blue", tx, ty }]);
          break outer;
        }
    const fab = [...w.buildings.values()].find((b) => b.kind === "fab-plant" && b.faction === "blue");
    expect(fab?.outpost).toBe(true);
  });

  it("lets the Gargantua call down powers in place of the HQ", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    w.powers.meter.blue = 100;
    expect(powerBlocker(w, "blue", "emp")).toBeNull();
  });

  it("hands openers out round the Gargantua", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"], openers: { blue: "blitz", red: "blitz" } });
    for (const f of ["blue", "red"] as const) {
      const fab = [...w.buildings.values()].find((b) => b.kind === "fab-plant" && b.faction === f);
      expect(fab, f).toBeDefined();
      expect(fab!.outpost).toBe(true);
      expect([...w.units.values()].filter((u) => u.faction === f && u.kind === "stinger")).toHaveLength(3);
    }
  });

  it("is lost when the side's last Gargantua falls", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    const g = goliathsOf(w, "red")[0]!;
    g.hp = 0;
    run(w, 1);
    expect(w.winner).toBe("blue");
  });

  it("stays out of Last Stand (skirmish rules only)", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"], survival: {} });
    expect(hqOf(w, "blue")).not.toBeNull();
  });
});

describe("Robot Love", () => {
  /** A bare field with HQs far apart and Robot Love on. */
  function field(): World {
    const w = createWorld(48, 48);
    w.rules = makeRules(["robotlove"]);
    spawnBuilding(w, "hq", "blue", 2, 2);
    spawnBuilding(w, "hq", "red", 43, 43);
    return w;
  }

  it("ends the match in a draw when enemy Gargantuas come within range, naming the pair and the meeting point", () => {
    const w = field();
    const a = spawnUnit(w, "goliath", "blue", 14, 24);
    const b = spawnUnit(w, "goliath", "red", 34, 24);
    // walk them toward each other (weapons off: they would otherwise fight it out first)
    for (const u of [a, b]) for (const k of ["mortars", "laser", "cannons", "mg"] as const) u.goliath!.weapons[k].online = false;
    w.fx = [];
    const seen: { ids: number[]; x: number; y: number }[] = [];
    for (let i = 0; i < 30 * TICK_RATE && !w.winner; i++) {
      step(w, i === 0 ? [
        { type: "move", faction: "blue", unitIds: [a.id], x: 34, y: 24 },
        { type: "move", faction: "red", unitIds: [b.id], x: 14, y: 24 }
      ] : []);
      for (const e of w.fx) if (e.type === "love") seen.push(e);
    }
    expect(w.winner).toBe("draw");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ids).toEqual([a.id, b.id]);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(GOLIATH.love.range + 1e-9);
    expect(seen[0]!.x).toBeCloseTo((a.x + b.x) / 2, 9);
    expect(w.love).toMatchObject({ ids: [a.id, b.id] });
    // a decided world steps no further
    const t = w.tick;
    step(w, []);
    expect(w.tick).toBe(t);
  });

  it("only between enemies, and only with the mutator on", () => {
    const w = field();
    spawnUnit(w, "goliath", "blue", 20, 24);
    spawnUnit(w, "goliath", "blue", 23, 24);
    run(w, 5);
    expect(w.winner).toBeNull();
    const plain = createWorld(48, 48);
    spawnBuilding(plain, "hq", "blue", 2, 2);
    spawnBuilding(plain, "hq", "red", 43, 43);
    spawnUnit(plain, "goliath", "blue", 22, 24);
    spawnUnit(plain, "goliath", "red", 25, 24);
    step(plain, []);
    expect(plain.winner).toBeNull();
  });

  it("a side beaten on the same tick stays beaten", () => {
    const w = field();
    spawnUnit(w, "goliath", "blue", 22, 24);
    spawnUnit(w, "goliath", "red", 25, 24);
    w.buildings.get(hqOf(w, "red")!.id)!.hp = 0;
    // red still has its Goliath, so its HQ falling doesn't decide it: love does
    step(w, []);
    expect(w.winner).toBe("draw");
  });
});

describe("Gargantua Armada", () => {
  it("starts each side with four Gargantuas in the air, two Montgolfières carrying each, and nothing else, mirror-placed", () => {
    const w = createMapWorld("riverlands", { mutators: ["armada"] });
    expect(w.buildings.size).toBe(0);
    for (const f of ["blue", "red"] as const) {
      const units = [...w.units.values()].filter((u) => u.faction === f);
      expect(units.filter((u) => u.kind === "goliath")).toHaveLength(4);
      expect(units.filter((u) => u.kind === "condor")).toHaveLength(8);
      expect(units).toHaveLength(12);
      const carriers = new Set<number>();
      for (const g of goliathsOf(w, f)) {
        expect(isLifted(g)).toBe(true);
        expect(domainOf(g)).toBe("air");
        for (const id of g.goliath!.lift!.carriers) {
          const c = w.units.get(id)!;
          expect(c.faction).toBe(f);
          expect(c.order).toEqual({ type: "lift", goliathId: g.id });
          carriers.add(id);
        }
      }
      expect(carriers.size).toBe(8);
      expect(w.factions[f].scrap).toBe(ECONOMY.startingScrap);
    }
    const blue = goliathsOf(w, "blue");
    const red = goliathsOf(w, "red");
    blue.forEach((b, i) => {
      expect(b.x + red[i]!.x).toBeCloseTo(w.width, 9);
      expect(b.y + red[i]!.y).toBeCloseTo(w.height, 9);
    });
  });

  it("deals no opener: every card says why", () => {
    const w = createMapWorld("riverlands", { mutators: ["armada"], openers: { blue: "blitz", red: "industry" } });
    expect(w.buildings.size).toBe(0);
    for (const id of OPENER_IDS) expect(openerBlocked(w, "blue", id)).toBe("Désactivé : Armada de Gargantuas");
    expect(allowedOpener(w, "red", "blitz")).toBeNull();
  });

  it("flies, sets down and anchors like any lift, and an anchored Gargantua builds Harvesters", () => {
    const w = createMapWorld("riverlands", { mutators: ["armada"] });
    const g = goliathsOf(w, "blue")[0]!;
    run(w, 1, [{ type: "unload", faction: "blue", unitIds: [g.id] }]);
    run(w, 10 * TICK_RATE);
    expect(g.goliath!.lift).toBeNull();
    expect(g.goliath!.mode).toBe("walking");
    run(w, 1, [{ type: "anchor", faction: "blue", unitIds: [g.id] }]);
    run(w, (GOLIATH.anchorTime + 1) * TICK_RATE);
    expect(g.goliath!.mode).toBe("anchored");
    expect(unitBlocker(w, "blue", "harvester")).toBeNull();
    expect(producersOf(w, "blue", "harvester").map((p) => p.id)).toEqual([g.id]);
  });

  it("is lost when the side's last Gargantua falls", () => {
    const w = createMapWorld("riverlands", { mutators: ["armada"] });
    const [last, ...rest] = goliathsOf(w, "red");
    for (const g of rest) g.hp = 0;
    run(w, 1);
    expect(w.winner).toBeNull();
    last!.hp = 0;
    run(w, 1);
    expect(w.winner).toBe("blue");
  });

  it("stays out of Last Stand (skirmish rules only)", () => {
    const w = createMapWorld("riverlands", { mutators: ["armada"], survival: {} });
    expect(hqOf(w, "blue")).not.toBeNull();
  });
});

describe("the mutator list", () => {
  it("keeps Nomads and Robot Love away from the mutators that ban the Gargantua, both ways round", () => {
    for (const m of ["nomads", "robotlove"] as const)
      for (const ban of ["airwar", "infantrywar"] as const) {
        expect(mutatorsCompatible([m, ban])).toBe(false);
        expect(makeRules([m, ban]).mutators).toHaveLength(1);
        expect(toggleMutator([ban], m)).toEqual([m]);
      }
    expect(mutatorsCompatible(["nomads", "robotlove"])).toBe(true);
    // Goliath Armada: no Goliath-banning mutator, and no other start (Nomads, Airborne's squads) either
    for (const other of ["airwar", "infantrywar", "nomads", "airborne"] as const) {
      expect(mutatorsCompatible(["armada", other])).toBe(false);
      expect(makeRules(["armada", other]).mutators).toEqual([other]);
      expect(toggleMutator([other], "armada")).toEqual(["armada"]);
    }
    expect(mutatorsCompatible(["armada", "robotlove", "veterans"])).toBe(true);
    for (const id of ["nomads", "robotlove", "armada"] as const) {
      expect(MUTATORS[id].name.length).toBeGreaterThan(0);
      expect(MUTATOR_IDS).toContain(id);
    }
  });

  it("leaves the Daily Op's draws as they were (new mutators are menu picks)", () => {
    expect(DAILY_MUTATORS).not.toContain("nomads");
    expect(DAILY_MUTATORS).not.toContain("robotlove");
    expect(DAILY_MUTATORS).not.toContain("armada");
    for (let day = 20300; day < 20400; day++)
      for (const m of dailyOp(day).mutators) expect(DAILY_MUTATORS).toContain(m);
  });
});

describe("a draw in the career", () => {
  it("pays between a loss and a win, and counts as neither", async () => {
    const { xpLines, applyResult, emptyCareer } = await import("../src/game/career");
    const base = { kind: "skirmish" as const, mapId: "riverlands", difficulty: "normal", secs: 600, buildingsLost: 0, medals: [], mutators: ["robotlove" as const], daily: null };
    const xp = (r: Parameters<typeof xpLines>[0]) => xpLines(r).reduce((s, l) => s + l.xp, 0);
    const draw = xp({ ...base, won: false, drawn: true });
    expect(draw).toBeGreaterThan(xp({ ...base, won: false }));
    expect(draw).toBeLessThan(xp({ ...base, won: true }));
    expect(xpLines({ ...base, won: false, drawn: true })[0]!.label).toMatch(/^Match nul/);
    const { career } = applyResult(emptyCareer(), { ...base, won: false, drawn: true }, 20300);
    expect(career.wins).toBe(0);
    expect(career.losses).toBe(0);
    // a quick meeting (Nomads + Robot Love: walk the Goliath over) pays no more than a quick loss
    const quick = { ...base, secs: 75 };
    expect(xp({ ...quick, won: false, drawn: true })).toBeLessThan(draw / 2);
  });
});
