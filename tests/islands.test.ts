import { describe, expect, it } from "vitest";
import { BUILDINGS, LIFELINE, POWERS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { isInfantry } from "../src/sim/infantry";
import { hasCondor, lifelineRoute, squadCount } from "../src/sim/lifeline";
import { MAPS, createMapWorld, mapById } from "../src/sim/maps";
import { findPath } from "../src/sim/movement";
import { mirrorPoint, presence, uplinkIncome } from "../src/sim/objectives";
import { targetBlocker } from "../src/sim/powers";
import { rulesOf } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import { carrierOf } from "../src/sim/transport";
import { Terrain, type Faction, type Unit, type World } from "../src/sim/types";
import { hqOf, onHomeLand, passable, regionAt, setTerrain, spawnUnit, terrainAt } from "../src/sim/world";

const ISLAND_MAPS = MAPS.filter((m) => m.islands);
const runTicks = (w: World, n: number) => {
  for (let i = 0; i < n; i++) step(w, []);
};
const own = (w: World, f: Faction, kind: Unit["kind"]) => [...w.units.values()].filter((u) => u.faction === f && u.kind === kind);
/** A tile just below the HQ (the HQ's own tiles are a building: no path starts there). */
const besideHq = (w: World, f: Faction) => {
  const hq = hqOf(w, f)!;
  return f === "blue" ? { x: hq.tx + 1.5, y: hq.ty + 4.5 } : { x: hq.tx + 1.5, y: hq.ty - 1.5 };
};

describe("the island map", () => {
  it("exists, last in the picker", () => {
    expect(ISLAND_MAPS.map((m) => m.id)).toEqual(["archipelago"]);
    expect(MAPS.at(-1)!.id).toBe("archipelago");
    expect(MAPS[0]!.id).toBe("proving-grounds");
  });

  for (const def of ISLAND_MAPS)
    describe(def.name, () => {
      const w = createMapWorld(def.id, { objectives: true });
      const b = besideHq(w, "blue");
      const r = besideHq(w, "red");

      it("joins the two HQs only by its bridges: cut them and nothing on the ground crosses", () => {
        expect(findPath(w, b.x, b.y, r.x, r.y)).not.toBeNull();
        const cut = createMapWorld(def.id);
        for (let i = 0; i < cut.width * cut.height; i++)
          if (cut.terrain[i] === Terrain.Bridge) setTerrain(cut, i % cut.width, Math.floor(i / cut.width), Terrain.Deep);
        for (const mc of ["ground", "foot", "hover"] as const) expect(findPath(cut, b.x, b.y, r.x, r.y, mc), mc).toBeNull();
      });

      it("puts every Uplink on an island only infantry can take, with room to land and dodge", () => {
        const ls = w.objectives.uplinks;
        expect(ls.length).toBeGreaterThanOrEqual(5);
        const home = (f: Faction) => regionAt(w, Math.floor(besideHq(w, f).x), Math.floor(besideHq(w, f).y), "foot");
        for (const l of ls) {
          expect(l.infantryOnly).toBe(true);
          const reg = regionAt(w, Math.floor(l.x), Math.floor(l.y), "foot");
          expect(reg).toBeGreaterThan(0);
          expect(reg).not.toBe(home("blue"));
          expect(reg).not.toBe(home("red"));
          // no tank, no hover tank: the island's ground and hover regions hold no HQ either
          for (const mc of ["ground", "hover"] as const) {
            const at = regionAt(w, Math.floor(l.x), Math.floor(l.y), mc);
            for (const f of ["blue", "red"] as const)
              expect(at, mc).not.toBe(regionAt(w, Math.floor(besideHq(w, f).x), Math.floor(besideHq(w, f).y), mc));
          }
          // squads can stand at least 4 tiles out from the relay all round (land two drops, dodge a Barrage)
          for (let a = 0; a < 16; a++) {
            const x = l.x + Math.cos((a / 16) * Math.PI * 2) * 3.6;
            const y = l.y + Math.sin((a / 16) * Math.PI * 2) * 3.6;
            expect(regionAt(w, Math.floor(x), Math.floor(y), "foot"), `(${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(reg);
          }
        }
      });

      it("leaves open sea round every island: at least 4 tiles of it to the next island or a coast", () => {
        // land with its shelf, 8-connected (a reef or sea stack on its own is scenery)
        const W = w.width;
        const blob = new Int32Array(W * w.height);
        let n = 0;
        for (let i = 0; i < blob.length; i++) {
          if (blob[i] || w.terrain[i] === Terrain.Deep) continue;
          blob[i] = ++n;
          for (const open = [i]; open.length; ) {
            const j = open.pop()!;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const x = (j % W) + dx;
                const y = Math.floor(j / W) + dy;
                const k = y * W + x;
                if (x < 0 || y < 0 || x >= W || y >= w.height || blob[k] || w.terrain[k] === Terrain.Deep) continue;
                blob[k] = n;
                open.push(k);
              }
          }
        }
        const at = (p: { x: number; y: number }) => blob[Math.floor(p.y) * W + Math.floor(p.x)]!;
        const isles = w.objectives.uplinks.map(at);
        const solid = new Set([at(b), ...isles]);
        expect(new Set(isles).size).toBe(isles.length); // (each relay on its own island)
        for (const isle of isles) {
          let gap = Infinity;
          for (let i = 0; i < blob.length; i++) {
            if (blob[i] !== isle) continue;
            for (let dy = -6; dy <= 6; dy++)
              for (let dx = -6; dx <= 6; dx++) {
                const x = (i % W) + dx;
                const y = Math.floor(i / W) + dy;
                const o = blob[y * W + x];
                if (x >= 0 && y >= 0 && x < W && y < w.height && o !== isle && solid.has(o!)) gap = Math.min(gap, Math.hypot(dx, dy) - 1);
              }
          }
          expect(gap).toBeGreaterThanOrEqual(4);
        }
      });

      it("has no stray specks of land: all ground is the mainland or an Uplink's island", () => {
        const foot = (p: { x: number; y: number }) => regionAt(w, Math.floor(p.x), Math.floor(p.y), "foot");
        const known = new Set([foot(b), foot(r), ...w.objectives.uplinks.map(foot)]);
        const stray: string[] = [];
        for (let ty = 0; ty < w.height; ty++)
          for (let tx = 0; tx < w.width; tx++) {
            const reg = regionAt(w, tx, ty, "foot");
            if (reg && !known.has(reg)) stray.push(`${tx},${ty}`);
          }
        expect(stray).toEqual([]);
      });

      it("has no ford anywhere: every tile of sea is water or open sea", () => {
        for (let i = 0; i < w.width * w.height; i++) expect(w.terrain[i]).not.toBe(Terrain.Shallows);
      });

      it("keeps harvesting scarce: one small field by each HQ and a couple of crystals", () => {
        let tiles = 0;
        for (let i = 0; i < w.width * w.height; i++) if (w.terrain[i] === Terrain.Scrap || w.terrain[i] === Terrain.Crystal) tiles++;
        expect(tiles / 2).toBeLessThanOrEqual(12);
      });

      it("starts each side with a free Montgolfière beside its HQ, its Trooper Squad aboard", () => {
        for (const f of ["blue", "red"] as const) {
          const [c, ...more] = own(w, f, "condor");
          expect(more).toHaveLength(0);
          expect(c!.free).toBe(true);
          expect(c!.passengers!.map((p) => p.kind)).toEqual(["trooper"]);
          expect(own(w, f, "trooper")).toHaveLength(0);
        }
        const [cb] = own(w, "blue", "condor");
        const [cr] = own(w, "red", "condor");
        const m = mirrorPoint(w, cb!.x, cb!.y);
        expect(cr!.x).toBeCloseTo(m.x, 9);
        expect(cr!.y).toBeCloseTo(m.y, 9);
        // the AI plans around a given Condor (rules.startUnits), yet the match isn't "mutated"
        expect(rulesOf(w).startUnits).toContain("condor");
        expect(rulesOf(w).mutators).toEqual([]);
      });

      it("drops Air War, and doesn't double the Montgolfière under Airborne", () => {
        const aw = createMapWorld(def.id, { mutators: ["airwar", "veterans"] });
        expect(rulesOf(aw).mutators).toEqual(["veterans"]);
        const ab = createMapWorld(def.id, { mutators: ["airborne"] });
        for (const f of ["blue", "red"] as const) expect(own(ab, f, "condor")).toHaveLength(1);
      });
    });
});

describe("island Uplinks", () => {
  const fresh = () => createMapWorld("archipelago", { objectives: true });
  const centre = (w: World) => w.objectives.uplinks.find((l) => l.x === 54 && l.y === 54)!;

  it("count only robot infantry: aircraft, the Montgolfière and hover tanks neither take nor freeze them", () => {
    const w = fresh();
    const l = centre(w);
    const red = (["condor", "scout", "wasp", "mender", "lancer", "stinger"] as const).map((k) => spawnUnit(w, k, "red", l.x + 0.5, l.y));
    expect(presence(w, l)).toEqual({ blue: 0, red: 0 });
    spawnUnit(w, "trooper", "blue", l.x - 0.5, l.y);
    expect(presence(w, l)).toEqual({ blue: 2, red: 0 });
    // the unarmed ones stay and hover over the zone: they don't freeze the bar
    for (const u of red) if (UNITS[u.kind].dps > 0) w.units.delete(u.id);
    runTicks(w, 16 * TICK_RATE);
    expect(l.owner).toBe("blue");
  });

  it("pay only while the holder's squads stand in them", () => {
    const w = fresh();
    const l = centre(w);
    const sq = spawnUnit(w, "trooper", "blue", l.x, l.y);
    runTicks(w, 16 * TICK_RATE);
    expect(l.owner).toBe("blue");
    expect(l.crewed).toBe(true);
    expect(uplinkIncome(w, "blue")).toBe(l.income! * 60);
    const s0 = w.factions.blue.scrap;
    const m0 = w.powers.meter.blue;
    runTicks(w, 10 * TICK_RATE);
    const paid = w.factions.blue.scrap - s0;
    // gone: the relay stays blue's, but pays nothing
    w.units.delete(sq.id);
    runTicks(w, 2);
    expect(l.owner).toBe("blue");
    expect(l.crewed).toBe(false);
    expect(uplinkIncome(w, "blue")).toBe(0);
    const s1 = w.factions.blue.scrap;
    const m1 = w.powers.meter.blue;
    runTicks(w, 10 * TICK_RATE);
    const trickle = (rulesOf(w).hqTrickle ?? 0) * 10;
    expect(paid).toBeCloseTo(trickle + l.income! * 10, 0);
    expect(w.factions.blue.scrap - s1).toBeCloseTo(trickle, 0);
    // the ⚡ charge stopped too: only the passive fill is left
    expect(m1 - m0).toBeGreaterThan(POWERS.passive * 10 + 0.1);
    expect(w.powers.meter.blue - m1).toBeCloseTo(POWERS.passive * 10, 1);
  });
});

describe("only a Montgolfière reaches an island", () => {
  it("no Drop Pod lands on one, even with eyes on it", () => {
    const w = createMapWorld("archipelago", { mutators: ["clearskies"] });
    runTicks(w, 1); // (the fog's first pass)
    expect(targetBlocker(w, "blue", "droppod", 56.5, 54.5)).toMatch(/île/);
    const b = besideHq(w, "blue");
    expect(targetBlocker(w, "blue", "droppod", b.x + 4, b.y - 8)).toBeNull();
  });

  it("no building goes up on one", () => {
    const w = createMapWorld("archipelago");
    // an island Ground tile, with a friendly building in range of it in every other way
    let spot: { x: number; y: number } | null = null;
    for (let y = 50; y < 58 && !spot; y++)
      for (let x = 50; x < 58 && !spot; x++)
        if (terrainAt(w, x, y) === Terrain.Ground && terrainAt(w, x + 1, y) === Terrain.Ground) spot = { x, y };
    expect(spot).not.toBeNull();
    expect(onHomeLand(w, "blue", spot!.x, spot!.y)).toBe(false);
    const hq = hqOf(w, "blue")!;
    expect(canPlaceBuilding(w, "blue", "turret", hq.tx + 4, hq.ty)).toBe(true);
    // even with a friendly building in build range of it (planted by the test: a shore outpost)
    const outpost = { ...hq, id: 99999, kind: "radar" as const, tx: spot!.x - 4, ty: spot!.y };
    w.buildings.set(outpost.id, outpost);
    expect(BUILDINGS.turret.size).toBe(1);
    expect(canPlaceBuilding(w, "blue", "turret", spot!.x, spot!.y)).toBe(false);
  });
});

describe("the free replacement Montgolfière", () => {
  const kill = (w: World, u: Unit) => {
    u.hp = 0;
    runTicks(w, 1);
  };

  it("flies in from the edge nearest the HQ after LIFELINE.delay, with a squad when the side is short", () => {
    const w = createMapWorld("archipelago");
    const [c] = own(w, "blue", "condor");
    // land the squad first so the lost Condor doesn't take it down too
    const squad = c!.passengers!.pop()!;
    squad.x = besideHq(w, "blue").x;
    squad.y = besideHq(w, "blue").y;
    w.units.set(squad.id, squad);
    const meter = w.powers.meter.blue;
    kill(w, c!);
    expect(w.wrecks.some((r) => r.kind === "condor")).toBe(false); // a free Condor leaves nothing to salvage
    expect(w.powers.meter.blue).toBeCloseTo(meter + POWERS.passive / TICK_RATE, 6); // …and charges nothing
    expect(hasCondor(w, "blue")).toBe(false);
    expect(w.lifeline!.blue.due).not.toBeNull();
    runTicks(w, LIFELINE.delay * TICK_RATE - 2);
    expect(own(w, "blue", "condor")).toHaveLength(0);
    runTicks(w, 2);
    const [fresh] = own(w, "blue", "condor");
    expect(fresh).toBeDefined();
    expect(fresh!.free).toBe(true);
    // one squad on the field (< LIFELINE.squadUnder): a free one comes aboard
    expect(squadCount(w, "blue")).toBe(2);
    expect(fresh!.passengers![0]!.free).toBe(true);
    // at the map edge, heading for the HQ
    const route = lifelineRoute(w, "blue")!;
    expect(Math.min(fresh!.x, w.width - fresh!.x, fresh!.y, w.height - fresh!.y)).toBeLessThan(LIFELINE.edgeInset + 0.5);
    expect(fresh!.order).toEqual({ type: "move", x: route.to.x, y: route.to.y });
    runTicks(w, 15 * TICK_RATE);
    expect(Math.hypot(fresh!.x - route.to.x, fresh!.y - route.to.y)).toBeLessThan(1.5);
  });

  it("brings no squad to a side that already has two, and never while a Montgolfière is being built", () => {
    const w = createMapWorld("archipelago");
    const [c] = own(w, "blue", "condor");
    spawnUnit(w, "trooper", "blue", besideHq(w, "blue").x, besideHq(w, "blue").y);
    spawnUnit(w, "rocket-squad", "blue", besideHq(w, "blue").x + 1, besideHq(w, "blue").y);
    kill(w, c!); // (its squad went down with it, over its own base: bailed out)
    const squads = squadCount(w, "blue");
    expect(squads).toBeGreaterThanOrEqual(2);
    runTicks(w, LIFELINE.delay * TICK_RATE + 1);
    const [fresh] = own(w, "blue", "condor");
    expect(fresh!.passengers).toEqual([]);
    // an Airpad building one holds the free one back
    const w2 = createMapWorld("archipelago");
    const [c2] = own(w2, "blue", "condor");
    const hq = hqOf(w2, "blue")!;
    const pad = { ...hq, id: 99998, kind: "airpad" as const, tx: hq.tx + 5, ty: hq.ty - 4, queue: [{ kind: "condor" as const, remaining: 9999 }] };
    w2.buildings.set(pad.id, pad);
    kill(w2, c2!);
    expect(w2.lifeline!.blue.due).toBeNull();
  });

  it("routes are mirror images for the two sides", () => {
    const w = createMapWorld("archipelago");
    const b = lifelineRoute(w, "blue")!;
    const r = lifelineRoute(w, "red")!;
    expect(r.from.x).toBeCloseTo(w.width - b.from.x, 9);
    expect(r.from.y).toBeCloseTo(w.height - b.from.y, 9);
    expect(r.to.x).toBeCloseTo(w.width - b.to.x, 9);
    expect(r.to.y).toBeCloseTo(w.height - b.to.y, 9);
    expect(passable(w, Math.floor(b.to.x), Math.floor(b.to.y), "air")).toBe(true);
  });

  it("isn't handed out on other maps, nor in Last Stand on this one", () => {
    expect(createMapWorld("riverlands").lifeline).toBeUndefined();
    expect(createMapWorld("archipelago", { survival: { difficulty: "normal" } }).lifeline).toBeUndefined();
    expect(mapById("archipelago").lastStand).toBe(false);
    expect(isInfantry("trooper") && UNITS.condor.capacity).toBe(2);
    expect(carrierOf(createMapWorld("riverlands"), 1)).toBeNull();
  });
});

describe("island UX", () => {
  it("a tap on an island with the loaded Montgolfière selected drops its troops there", async () => {
    const { Controller } = await import("../src/game/controller");
    const w = createMapWorld("archipelago", { objectives: true });
    const c = new Controller(w);
    const [condor] = own(w, "blue", "condor");
    c.selectUnits([condor!.id]);
    c.tapWorld(7.5, 35.5, { kind: "ground" }); // blue's home isle
    expect(c.drainCommands()).toEqual([{ type: "unload", faction: "blue", unitIds: [condor!.id], x: 7.5, y: 35.5 }]);
    expect(c.lastFeedback?.kind).toBe("drop");
  });

  it("sending a tank at an island says how islands are reached", async () => {
    const { Controller } = await import("../src/game/controller");
    const w = createMapWorld("archipelago", { objectives: true });
    const c = new Controller(w);
    const b = besideHq(w, "blue");
    const tank = spawnUnit(w, "stinger", "blue", b.x, b.y);
    c.selectUnits([tank.id]);
    c.tapWorld(54.5, 54.5, { kind: "ground" });
    expect(c.tip).toMatch(/Montgolfière/);
    expect(c.onIsland(54, 54)).toBe(true);
    expect(c.onIsland(Math.floor(b.x), Math.floor(b.y))).toBe(false);
  });

  it("gives the big map a longer ★★ time", async () => {
    const { starsFor, starSecsFor, starLabelsFor } = await import("../src/game/career");
    expect(starSecsFor("archipelago")).toBe(720);
    expect(starSecsFor("riverlands")).toBe(480);
    expect(starLabelsFor("archipelago")[1]).toBe("Victoire en moins de 12:00");
    const r = { kind: "skirmish" as const, mapId: "archipelago", difficulty: "normal", won: true, secs: 600, buildingsLost: 1, medals: [], mutators: [], daily: null };
    expect(starsFor(r)).toBe(3);
    expect(starsFor({ ...r, mapId: "riverlands" })).toBe(1);
  });
});

describe("fighting across the sea (review fixes)", () => {
  it("a shore squad ordered at a dropship it can't reach drops the order and fights what lands beside it", () => {
    const w = createMapWorld("archipelago");
    const condor = spawnUnit(w, "condor", "red", 41.54, 36.5); // parked over open sea, just off the bridge
    const t = spawnUnit(w, "trooper", "blue", 46.5, 36.5); // on the bridge
    step(w, [{ type: "attack", faction: "blue", unitIds: [t.id], targetId: condor.id }]);
    runTicks(w, 20 * TICK_RATE);
    condor.x = 41.54;
    condor.y = 36.5;
    expect(t.order.type).toBe("idle");
    const raider = spawnUnit(w, "trooper", "red", t.x + 1.8, t.y);
    runTicks(w, 8 * TICK_RATE);
    expect(w.units.get(raider.id)?.hp ?? 0).toBeLessThan(UNITS.trooper.hp);
  });

  it("a garrison isn't lured off its island relay by a Scout hovering offshore", () => {
    const w = createMapWorld("archipelago", { objectives: true });
    const l = w.objectives.uplinks.find((u) => u.x === 54 && u.y === 54)!;
    const g = spawnUnit(w, "trooper", "blue", l.x + 1.6, l.y);
    runTicks(w, 16 * TICK_RATE);
    expect(l.crewed).toBe(true);
    for (const [dx, dy] of [[5.5, 0], [0, 6], [-6.5, 1], [4, 4.5]] as const) {
      const scout = spawnUnit(w, "scout", "red", l.x + dx, l.y + dy);
      scout.hp = 1e6; // (it just hovers there, out of reach of the squad's rifles)
      for (let i = 0; i < 6 * TICK_RATE; i++) {
        scout.x = l.x + dx;
        scout.y = l.y + dy;
        step(w, []);
      }
      expect(Math.hypot(g.x - l.x, g.y - l.y)).toBeLessThanOrEqual(2.5);
      expect(l.crewed).toBe(true);
      w.units.delete(scout.id);
    }
  });

  it("separation never shoves a hover tank across a corner into water it can't leave", () => {
    const w = createMapWorld("archipelago");
    // a one-tile pocket of water that touches the shore (tile 30,76) only at a corner
    for (const [x, y] of [[31, 76], [30, 77], [32, 77], [31, 78]] as const) setTerrain(w, x, y, Terrain.Deep);
    setTerrain(w, 31, 77, Terrain.Water);
    const a = spawnUnit(w, "lancer", "blue", 30.92, 76.92);
    const b = spawnUnit(w, "lancer", "blue", 30.6, 76.6);
    const ra = regionAt(w, Math.floor(a.x), Math.floor(a.y), "hover");
    const rb = regionAt(w, Math.floor(b.x), Math.floor(b.y), "hover");
    runTicks(w, 5);
    expect(regionAt(w, Math.floor(a.x), Math.floor(a.y), "hover")).toBe(ra);
    expect(regionAt(w, Math.floor(b.x), Math.floor(b.y), "hover")).toBe(rb);
  });
});

describe("island taps (review fixes)", () => {
  const setup = async () => {
    const { Controller } = await import("../src/game/controller");
    const w = createMapWorld("archipelago", { objectives: true });
    return { w, c: new Controller(w) };
  };

  it("tapping an enemy on an island with only tanks selected doesn't fake an attack: it explains", async () => {
    const { w, c } = await setup();
    const b = besideHq(w, "blue");
    const tank = spawnUnit(w, "stinger", "blue", b.x, b.y);
    const foe = spawnUnit(w, "trooper", "red", 54.5, 54.5);
    c.selectUnits([tank.id]);
    c.tapWorld(54.5, 54.5, { kind: "enemy", id: foe.id, targetsAir: false });
    expect(c.drainCommands().some((k) => k.type === "attack")).toBe(false);
    expect(c.lastFeedback?.kind).not.toBe("attack");
    expect(c.tip).toMatch(/Montgolfière/);
  });

  it("a loaded Montgolfière with an escort, tapped onto an island enemy: the escort attacks, the Montgolfière drops", async () => {
    const { w, c } = await setup();
    const [condor] = own(w, "blue", "condor");
    const wasp = spawnUnit(w, "wasp", "blue", condor!.x + 1, condor!.y);
    const foe = spawnUnit(w, "trooper", "red", 54.5, 54.5);
    c.selectUnits([condor!.id, wasp.id]);
    c.tapWorld(54.5, 54.5, { kind: "enemy", id: foe.id, targetsAir: false });
    const cmds = c.drainCommands();
    expect(cmds).toContainEqual({ type: "attack", faction: "blue", unitIds: [wasp.id], targetId: foe.id });
    expect(cmds).toContainEqual({ type: "unload", faction: "blue", unitIds: [condor!.id], x: 54.5, y: 54.5 });
  });

  it("tapping our own island garrison with a loaded Montgolfière reinforces it instead of picking it up", async () => {
    const { w, c } = await setup();
    const [condor] = own(w, "blue", "condor");
    const garrison = spawnUnit(w, "rocket-squad", "blue", 54.5, 54.5);
    c.selectUnits([condor!.id]);
    c.tapWorld(54.6, 54.4, { kind: "ownUnit", id: garrison.id });
    const cmds = c.drainCommands();
    expect(cmds.some((k) => k.type === "board")).toBe(false);
    expect(cmds).toContainEqual({ type: "unload", faction: "blue", unitIds: [condor!.id], x: 54.5, y: 54.5 });
  });

  it("'tap the Montgolfière, then the island' straight away keeps the squad boarding and drops it once aboard", async () => {
    const { w, c } = await setup();
    const [condor] = own(w, "blue", "condor");
    // land the starting squad beside the HQ first
    const squad = condor!.passengers!.pop()!;
    const b = besideHq(w, "blue");
    squad.x = b.x;
    squad.y = b.y;
    w.units.set(squad.id, squad);
    c.selectUnits([squad.id]);
    c.tapWorld(condor!.x, condor!.y, { kind: "ownUnit", id: condor!.id }); // board
    step(w, c.drainCommands());
    c.tapWorld(54.5, 54.5, { kind: "ground" }); // the island, before it's aboard
    const now = c.drainCommands();
    expect(now.some((k) => k.type === "attackMove" || k.type === "move")).toBe(false);
    let sent = false;
    for (let i = 0; i < 20 * TICK_RATE && !sent; i++) {
      step(w, []);
      c.prune();
      sent = c.drainCommands().some((k) => k.type === "unload" && k.x === 54.5);
    }
    expect(sent).toBe(true);
  });

  it("no island tip for units that can get there: squads already on it, aircraft", async () => {
    const { w, c } = await setup();
    const sq = spawnUnit(w, "trooper", "blue", 53.5, 53.5);
    c.selectUnits([sq.id]);
    c.tapWorld(55.5, 55.5, { kind: "ground" });
    expect(c.tip).toBeNull();
    const b = besideHq(w, "blue");
    const wasp = spawnUnit(w, "wasp", "blue", b.x, b.y);
    c.selectUnits([wasp.id]);
    c.tapWorld(7.5, 35.5, { kind: "ground" });
    expect(c.tip).toBeNull();
  });
});
