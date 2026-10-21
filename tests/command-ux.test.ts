import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { isVisible, tickFog } from "../src/sim/fog";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { placementBlocker, snapPlacement, suggestPlacement } from "../src/sim/placement";
import { Terrain, type BuildingKind, type FxEvent, type Unit, type World } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";
import { Controller } from "../src/game/controller";
import { SQUAD, Squads } from "../src/game/squads";
import { ADVISOR, COUNTERS, EnemyIntel, IdleWatch, adviceNote, counterAdvice } from "../src/game/advisor";
import { applyMutators, rulesOf } from "../src/sim/rules";

const BUILDABLE: BuildingKind[] = ["fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar"];

/** A flat 40×40 field with a blue HQ at (4,4) and a red HQ at (32,32). */
function field(): World {
  const w = createWorld(40, 40);
  spawnBuilding(w, "hq", "blue", 4, 4);
  spawnBuilding(w, "hq", "red", 32, 32);
  return w;
}

const hit = (id: number, building = false): FxEvent => ({
  type: "hit", faction: "blue", id, x: 0, y: 0, building, attackerId: 0
});

describe("placement: why not, and where instead", () => {
  it("explains exactly the spots canPlaceBuilding refuses, on every map", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      const hq = hqOf(w, "blue")!;
      // a unit parked near the HQ, so "Unit in the way" is exercised too
      spawnUnit(w, "stinger", "blue", hq.tx + 4.5, hq.ty + 1.5);
      for (const kind of ["turret", "fab-plant"] as BuildingKind[])
        for (let ty = hq.ty - 9; ty <= hq.ty + 9; ty++)
          for (let tx = hq.tx - 9; tx <= hq.tx + 9; tx++) {
            const ok = canPlaceBuilding(w, "blue", kind, tx, ty);
            const why = placementBlocker(w, "blue", kind, tx, ty);
            expect(why === null, `${def.id} ${kind} ${tx},${ty}: ${why}`).toBe(ok);
          }
    }
  });

  it("names the problem: range, ground, buildings, units, map edge", () => {
    const w = field();
    expect(placementBlocker(w, "blue", "turret", 9, 5)).toBeNull();
    expect(placementBlocker(w, "blue", "turret", 25, 5)).toBe("Trop loin de la base");
    expect(placementBlocker(w, "blue", "turret", 5, 5)).toBe("Bloqué");
    expect(placementBlocker(w, "blue", "fab-plant", -1, 5)).toBe("Hors de la carte");
    setTerrain(w, 9, 6, Terrain.Water);
    expect(placementBlocker(w, "blue", "turret", 9, 6)).toBe("Impossible sur l'eau");
    w.biome = "volcanic";
    expect(placementBlocker(w, "blue", "turret", 9, 6)).toBe("Impossible sur la lave");
    setTerrain(w, 9, 7, Terrain.Rock);
    expect(placementBlocker(w, "blue", "turret", 9, 7)).toBe("Impossible sur la roche");
    setTerrain(w, 10, 8, Terrain.Rough);
    expect(placementBlocker(w, "blue", "turret", 10, 8)).toBe("Impossible sur les cendres");
    spawnUnit(w, "mastodon", "blue", 9.5, 9.5);
    expect(placementBlocker(w, "blue", "turret", 9, 9)).toBe("Une unité gêne");
    // aircraft overhead don't block
    spawnUnit(w, "wasp", "blue", 8.5, 9.5);
    expect(placementBlocker(w, "blue", "turret", 8, 9)).toBeNull();
    // the enemy's base doesn't count as yours
    expect(placementBlocker(w, "blue", "turret", 30, 30)).toBe("Trop loin de la base");
  });

  it("suggests the valid spot nearest the view centre, inside build range", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      const hq = hqOf(w, "blue")!;
      const c = buildingCenter(hq);
      for (const kind of BUILDABLE) {
        for (const anchor of [c, { x: c.x + 3, y: c.y + 6 }, { x: w.width / 2, y: w.height / 2 }]) {
          const s = suggestPlacement(w, "blue", kind, anchor);
          expect(s, `${def.id} ${kind}`).not.toBeNull();
          expect(canPlaceBuilding(w, "blue", kind, s!.tx, s!.ty)).toBe(true);
        }
      }
    }
  });

  it("prefers the spot closest to the anchor, and is deterministic", () => {
    const w = field();
    const s = suggestPlacement(w, "blue", "turret", { x: 10.5, y: 5.5 })!;
    expect(s).toEqual({ tx: 10, ty: 5 });
    // a far-away anchor still lands at the base edge facing it
    const far = suggestPlacement(w, "blue", "turret", { x: 30, y: 5.5 })!;
    expect(canPlaceBuilding(w, "blue", "turret", far.tx, far.ty)).toBe(true);
    expect(far.tx).toBeGreaterThan(8);
    expect(Math.abs(far.ty + 0.5 - 5.5)).toBeLessThanOrEqual(2);
    expect(suggestPlacement(w, "blue", "turret", { x: 30, y: 5.5 })).toEqual(far);
    // nothing of ours, nowhere to build
    const empty = createWorld(20, 20);
    expect(suggestPlacement(empty, "blue", "turret", { x: 5, y: 5 })).toBeNull();
  });

  it("keeps lanes open for big buildings when it can", () => {
    const w = field();
    // a 2×2 pocket walled in by rock right where the player is looking
    for (let y = 3; y <= 6; y++)
      for (let x = 8; x <= 11; x++) if (!(x >= 9 && x <= 10 && y >= 4 && y <= 5)) setTerrain(w, x, y, Terrain.Rock);
    expect(canPlaceBuilding(w, "blue", "fab-plant", 9, 4)).toBe(true);
    const s = suggestPlacement(w, "blue", "fab-plant", { x: 10, y: 5 })!;
    expect(s).not.toEqual({ tx: 9, ty: 4 }); // that would seal it in
    expect(canPlaceBuilding(w, "blue", "fab-plant", s.tx, s.ty)).toBe(true);
    // a turret doesn't care
    expect(suggestPlacement(w, "blue", "turret", { x: 9.5, y: 4.5 })).toEqual({ tx: 9, ty: 4 });
  });

  it("snaps an imprecise tap one tile onto a valid spot, else leaves it", () => {
    const w = field();
    // (6,6) is inside the HQ: (6,7) is free ground right below it
    const snapped = snapPlacement(w, "blue", "turret", 6, 6);
    expect(canPlaceBuilding(w, "blue", "turret", snapped.tx, snapped.ty)).toBe(true);
    expect(Math.max(Math.abs(snapped.tx - 6), Math.abs(snapped.ty - 6))).toBe(1);
    expect(snapPlacement(w, "blue", "turret", 9, 5)).toEqual({ tx: 9, ty: 5 });
    expect(snapPlacement(w, "blue", "turret", 25, 25)).toEqual({ tx: 25, ty: 25 });
  });
});

describe("controller: touch placement", () => {
  const ready = (w: World, kind: BuildingKind) => {
    w.factions.blue.pending = { kind, remaining: 0, ready: true };
  };

  it("moves the ghost without building, then builds on confirm", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.movePlacement(9, 5);
    expect(c.placeAt).toEqual({ tx: 9, ty: 5 });
    expect(c.drainCommands()).toEqual([]);
    expect(c.placementProblem()).toBeNull();
    expect(c.commitPlacement()).toBe(true);
    expect(c.drainCommands()).toEqual([{ type: "placeBuilding", faction: "blue", tx: 9, ty: 5 }]);
    expect(c.placing).toBeNull();
    expect(c.placeAt).toBeNull();
    expect(c.lastFeedback?.kind).toBe("place");
  });

  it("refuses a bad spot with the reason, staying in placement", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.movePlacement(25, 25);
    expect(c.placementProblem()).toBe("Trop loin de la base");
    expect(c.commitPlacement()).toBe(false);
    expect(c.denied).toEqual({ reason: "Trop loin de la base", tx: 25, ty: 25 });
    expect(c.placing).toBe("turret");
    expect(c.drainCommands()).toEqual([]);
  });

  it("keeps one-click placement for mouse taps, and denies a bad click", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.tapWorld(25.5, 25.5, { kind: "ground" });
    expect(c.denied?.reason).toBe("Trop loin de la base");
    expect(c.placing).toBe("turret");
    c.tapWorld(9.5, 5.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "placeBuilding", faction: "blue", tx: 9, ty: 5 }]);
  });

  it("drops the ghost when placement ends", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.movePlacement(9, 5);
    w.factions.blue.pending = null; // cancelled elsewhere
    c.prune();
    expect(c.placing).toBeNull();
    expect(c.placeAt).toBeNull();
  });

  it("selects units with no orders", () => {
    const w = field();
    const c = new Controller(w);
    const a = spawnUnit(w, "stinger", "blue", 10, 10);
    const b = spawnUnit(w, "stinger", "blue", 11, 10);
    spawnUnit(w, "harvester", "blue", 12, 10);
    spawnUnit(w, "stinger", "red", 13, 10);
    b.order = { type: "move", x: 20, y: 20 };
    expect(c.idleArmy()).toEqual([a.id]);
  });

  it("⚔ Select army and 💤 Idle leave out harvesters and the unarmed Montgolfière", () => {
    const w = field();
    const c = new Controller(w);
    const tank = spawnUnit(w, "stinger", "blue", 10, 10);
    const squad = spawnUnit(w, "trooper", "blue", 11, 10);
    spawnUnit(w, "harvester", "blue", 12, 10);
    spawnUnit(w, "condor", "blue", 13, 10);
    spawnUnit(w, "stinger", "red", 14, 10);
    c.selectArmy();
    expect([...c.selectedUnits]).toEqual([tank.id, squad.id]);
    expect(c.idleArmy()).toEqual([tank.id, squad.id]);
  });

  it("Shift+click adds a unit to the selection, or takes it out", () => {
    const w = field();
    const c = new Controller(w);
    const [a, b, d] = [1, 2, 3].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10));
    c.tapWorld(11, 10, { kind: "ownUnit", id: a!.id });
    c.tapWorld(12, 10, { kind: "ownUnit", id: b!.id }, true);
    expect([...c.selectedUnits]).toEqual([a!.id, b!.id]);
    c.forceMove = true;
    const before = c.selectedUnits;
    c.tapWorld(11, 10, { kind: "ownUnit", id: a!.id }, true);
    expect([...c.selectedUnits]).toEqual([b!.id]);
    expect(c.selectedUnits).toBe(before); // taking one out is quiet (no voice)
    expect(c.forceMove).toBe(true); // an armed Move only survives
    c.tapWorld(13, 10, { kind: "ownUnit", id: d!.id }, true);
    expect([...c.selectedUnits]).toEqual([b!.id, d!.id]);
    expect(c.selectedUnits).not.toBe(before); // adding one is a fresh selection: the voices answer
    // Shift only changes taps on your own units: the ground still gets the (Move only) order
    c.tapWorld(20.5, 20.5, { kind: "ground" }, true);
    expect(c.drainCommands()).toEqual([{ type: "move", faction: "blue", unitIds: [b!.id, d!.id], x: 20.5, y: 20.5 }]);
    // a Shift+click on a unit while a building is selected starts a unit selection
    const hq = hqOf(w, "blue")!;
    c.clearSelection();
    c.selectedBuilding = hq.id;
    c.tapWorld(11, 10, { kind: "ownUnit", id: a!.id }, true);
    expect(c.selectedBuilding).toBeNull();
    expect([...c.selectedUnits]).toEqual([a!.id]);
  });
});

describe("squads", () => {
  it("saves a selection; a unit lives in one squad at a time", () => {
    const w = field();
    const c = new Controller(w);
    const [a, b, d] = [1, 2, 3].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10));
    const enemy = spawnUnit(w, "wasp", "red", 20, 20);
    c.selectUnits([a!.id, b!.id, enemy.id]);
    expect(c.assignSquad(0)).toBe(2); // enemies never join
    c.selectUnits([b!.id, d!.id]);
    c.assignSquad(1);
    expect(c.squads.ids(0, w)).toEqual([a!.id]);
    expect(c.squads.ids(1, w)).toEqual([b!.id, d!.id]);
    expect(c.squads.slotOf(b!.id)).toBe(1);
    c.clearSelection();
    expect(c.selectSquad(1)).toBe(2);
    expect([...c.selectedUnits]).toEqual([b!.id, d!.id]);
    expect(c.squads.matches(1, c.selectedUnits, w)).toBe(true);
    expect(c.squads.matches(0, c.selectedUnits, w)).toBe(false);
    expect(c.selectSquad(2)).toBe(0); // empty: selection kept
    expect(c.selectedUnits.size).toBe(2);
  });

  it("selecting a squad replaces the selection set (voices hear a new selection)", () => {
    const w = field();
    const c = new Controller(w);
    const u = spawnUnit(w, "mastodon", "blue", 10, 10);
    c.selectUnits([u.id]);
    c.assignSquad(0);
    const before = c.selectedUnits;
    c.selectSquad(0);
    expect(c.selectedUnits).not.toBe(before);
  });

  it("forgets the dead and summarises the living", () => {
    const w = field();
    const s = new Squads("blue");
    const st = [0, 1, 2].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10));
    const ti = spawnUnit(w, "mastodon", "blue", 14, 10);
    s.assign(0, [...st.map((u) => u.id), ti.id], w);
    st[0]!.hp = UNITS.stinger.hp / 2;
    let sum = s.summary(0, w)!;
    expect(sum.kind).toBe("stinger");
    expect(sum.count).toBe(4);
    const max = UNITS.stinger.hp * 3 + UNITS.mastodon.hp;
    expect(sum.hp).toBeCloseTo((max - UNITS.stinger.hp / 2) / max);
    w.units.delete(st[1]!.id);
    w.units.delete(st[2]!.id);
    s.prune(w);
    expect(s.slots[0]).toEqual([st[0]!.id, ti.id]);
    // 1 stinger vs 1 mastodon: the pricier kind is the face of the squad
    sum = s.summary(0, w)!;
    expect(sum.kind).toBe("mastodon");
    expect(sum.count).toBe(2);
    w.units.delete(st[0]!.id);
    w.units.delete(ti.id);
    expect(s.summary(0, w)).toBeNull();
    expect(s.focus(0, w)).toBeNull();
  });

  it("flies to the member nearest the middle, not empty ground between two halves", () => {
    const w = field();
    const s = new Squads("blue");
    const us = [
      spawnUnit(w, "wasp", "blue", 5, 20),
      spawnUnit(w, "wasp", "blue", 6, 20),
      spawnUnit(w, "wasp", "blue", 30, 20)
    ];
    s.assign(2, us.map((u) => u.id), w);
    expect(s.focus(2, w)).toEqual({ x: 6, y: 20 });
  });

  it("lights a chip red while a member is hit", () => {
    const w = field();
    const s = new Squads("blue");
    const u = spawnUnit(w, "stinger", "blue", 10, 10);
    const other = spawnUnit(w, "stinger", "blue", 12, 10);
    s.assign(1, [u.id], w);
    s.events([hit(other.id), hit(u.id, true)], 1000);
    expect(s.isHurt(1, 1000)).toBe(false); // not a member / a building hit
    s.events([hit(u.id)], 1000);
    expect(s.isHurt(1, 1000 + SQUAD.hurtMs - 1)).toBe(true);
    expect(s.isHurt(1, 1000 + SQUAD.hurtMs + 1)).toBe(false);
    expect(s.isHurt(0, 1000)).toBe(false);
    // red's hits on its own units don't touch blue's squads
    s.events([{ type: "hit", faction: "red", id: u.id, x: 0, y: 0, building: false, attackerId: 0 }], 5000);
    expect(s.isHurt(1, 5000)).toBe(false);
  });
});

describe("build advisor", () => {
  /** Blue base with vision around it; red units placed at (x, y). */
  function scene() {
    const w = field();
    spawnBuilding(w, "fab-plant", "blue", 9, 4);
    spawnBuilding(w, "airpad", "blue", 9, 7);
    tickFog(w);
    return w;
  }

  it("remembers only enemies standing where you can see, for a minute", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    const near = spawnUnit(w, "wasp", "red", 8, 9);
    spawnUnit(w, "wasp", "red", 30, 20); // in the fog
    spawnUnit(w, "scout", "red", 8, 10); // scouts are ignored
    spawnUnit(w, "harvester", "red", 9, 10); // so are harvesters
    tickFog(w);
    intel.update(0);
    expect(intel.count("wasp", 0)).toBe(1);
    expect(intel.count("scout", 0)).toBe(0);
    expect(intel.count("harvester", 0)).toBe(0);
    // seen again later: still one wasp (distinct ids)
    intel.update(10);
    expect(intel.count("wasp", 10)).toBe(1);
    // it leaves; forgotten a minute after its last sighting
    near.x = 30;
    tickFog(w);
    intel.update(20);
    expect(intel.count("wasp", 10 + ADVISOR.memoryS - 1)).toBe(1);
    intel.update(10 + ADVISOR.memoryS + 1);
    expect(intel.count("wasp", 10 + ADVISOR.memoryS + 1)).toBe(0);
  });

  it("counts enemy defences from the fog memory", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnBuilding(w, "turret", "red", 11, 10);
    spawnBuilding(w, "turret", "red", 30, 12); // never seen
    tickFog(w);
    expect(intel.count("turret", 0)).toBe(1);
  });

  it("lights the counters after two sightings, until you've answered them", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "wasp", "red", 8, 9);
    tickFog(w);
    intel.update(0);
    expect(counterAdvice(w, "blue", intel, "flak-crawler", 0).active).toBe(false); // one sighting
    spawnUnit(w, "wasp", "red", 9, 9);
    tickFog(w);
    intel.update(1);
    for (const k of ["flak-crawler", "raptor", "sam-site"] as const)
      expect(counterAdvice(w, "blue", intel, k, 1).active, k).toBe(true);
    for (const k of ["stinger", "mastodon", "wasp", "turret"] as const)
      expect(counterAdvice(w, "blue", intel, k, 1).active, k).toBe(false);
    expect(adviceNote(counterAdvice(w, "blue", intel, "flak-crawler", 1))).toBe("Contre : Éole (vus ×2)");
    // two wasps (400) vs flak: queued and built flak both count toward the answer
    const fab = [...w.buildings.values()].find((b) => b.kind === "fab-plant")!;
    fab.queue.push({ kind: "flak-crawler", remaining: 100 });
    expect(counterAdvice(w, "blue", intel, "flak-crawler", 1).active).toBe(true); // 190 < 300
    spawnUnit(w, "flak-crawler", "blue", 6, 9);
    expect(counterAdvice(w, "blue", intel, "flak-crawler", 1).active).toBe(false); // 380 ≥ 300
    // the info card still explains it
    expect(adviceNote(counterAdvice(w, "blue", intel, "flak-crawler", 1))).toBe("Contre : Éole (vus ×2)");
  });

  it("counts squads riding in Montgolfières toward the answer", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "mastodon", "red", 8, 9);
    spawnUnit(w, "mastodon", "red", 9, 9);
    tickFog(w);
    intel.update(0);
    expect(counterAdvice(w, "blue", intel, "rocket-squad", 0).active).toBe(true);
    // enough Rocket Squads on the field answer the Mastodons…
    const squads: Unit[] = [];
    while (counterAdvice(w, "blue", intel, "rocket-squad", 0).active) squads.push(spawnUnit(w, "rocket-squad", "blue", 5, 12));
    // …and still do once they're aboard Condors for a drop
    for (let i = 0; i < squads.length; i += 2) {
      const condor = spawnUnit(w, "condor", "blue", 6, 12);
      for (const u of squads.slice(i, i + 2)) {
        w.units.delete(u.id);
        condor.passengers!.push(u);
      }
    }
    expect(counterAdvice(w, "blue", intel, "rocket-squad", 0).active).toBe(false);
  });

  it("counts squads an anchored Gargantua is training toward the answer, as a Bay's queue does", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "mastodon", "red", 8, 9);
    spawnUnit(w, "mastodon", "red", 9, 9);
    tickFog(w);
    intel.update(0);
    const g = spawnUnit(w, "goliath", "blue", 5, 14);
    g.goliath!.mode = "anchored";
    for (let i = 0; i < 6 && counterAdvice(w, "blue", intel, "rocket-squad", 0).active; i++)
      g.goliath!.queue.push({ kind: "rocket-squad", remaining: 90 });
    expect(counterAdvice(w, "blue", intel, "rocket-squad", 0).active).toBe(false);
  });

  it("never suggests an option the match rules ban (Air War: no Flak, no SAM Sites)", () => {
    const w = scene();
    applyMutators(w, ["airwar"]);
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "wasp", "red", 8, 9);
    spawnUnit(w, "wasp", "red", 9, 9);
    tickFog(w);
    intel.update(0);
    for (const k of ["flak-crawler", "sam-site"] as const) {
      expect(counterAdvice(w, "blue", intel, k, 0).active, k).toBe(false);
      expect(adviceNote(counterAdvice(w, "blue", intel, k, 0)), k).toBeNull();
    }
    // the allowed answer still lights up
    expect(counterAdvice(w, "blue", intel, "raptor", 0).active).toBe(true);
    expect(adviceNote(counterAdvice(w, "blue", intel, "raptor", 0))).toBe("Contre : Éole (vus ×2)");
    // an op's one-sided ban counts too
    const op = scene();
    op.rules = { ...rulesOf(op), sideBans: { blue: { units: ["raptor"] } } };
    const intel2 = new EnemyIntel(op, "blue");
    spawnUnit(op, "wasp", "red", 8, 9);
    spawnUnit(op, "wasp", "red", 9, 9);
    tickFog(op);
    intel2.update(0);
    expect(counterAdvice(op, "blue", intel2, "raptor", 0).active).toBe(false);
    expect(counterAdvice(op, "blue", intel2, "flak-crawler", 0).active).toBe(true);
  });

  it("lists several threats, most seen first", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "hornet", "red", 8, 9);
    for (let i = 0; i < 3; i++) spawnUnit(w, "wasp", "red", 9 + i * 0.5, 10);
    tickFog(w);
    intel.update(0);
    expect(adviceNote(counterAdvice(w, "blue", intel, "raptor", 0))).toBe("Contre : Éole (vus ×3), Albatros (×1)");
    expect(adviceNote(counterAdvice(w, "blue", intel, "stinger", 0))).toBeNull();
  });

  it("every counter entry is something you can build, against something that exists", () => {
    for (const [k, threats] of Object.entries(COUNTERS)) {
      expect(k in UNITS || k in BUILDINGS).toBe(true);
      for (const t of threats!) expect(t in UNITS || t === "turret" || t === "sam-site").toBe(true);
    }
  });

  it("nudges a factory idle for a while when you can afford its units", () => {
    const w = scene();
    const idle = new IdleWatch(w, "blue");
    w.factions.blue.scrap = 1000;
    expect(idle.update(0)).toEqual({ ground: false, infantry: false, air: false });
    expect(idle.update(ADVISOR.idleS - 0.1)).toEqual({ ground: false, infantry: false, air: false });
    expect(idle.update(ADVISOR.idleS + 0.1)).toEqual({ ground: true, infantry: false, air: true });
    // busy again: the clock restarts
    const pad = [...w.buildings.values()].find((b) => b.kind === "airpad")!;
    pad.queue.push({ kind: "wasp", remaining: 50 });
    expect(idle.update(ADVISOR.idleS + 0.2).air).toBe(false);
    pad.queue.length = 0;
    expect(idle.update(ADVISOR.idleS + 1).air).toBe(false);
    expect(idle.update(2 * ADVISOR.idleS + 1.1).air).toBe(true);
    // broke: no nudge (the cheapest Fab unit costs 150)
    w.factions.blue.scrap = UNITS.stinger.cost - 1;
    expect(idle.update(100).ground).toBe(false);
    expect(ECONOMY.maxQueue).toBeGreaterThan(0);
  });

  it("nudges an idle Assembly Bay on the Infantry tab (Troopers are cheap)", () => {
    const w = scene();
    spawnBuilding(w, "assembly-bay", "blue", 12, 4);
    const idle = new IdleWatch(w, "blue");
    w.factions.blue.scrap = UNITS.trooper.cost;
    idle.update(0);
    const now = idle.update(ADVISOR.idleS + 0.1);
    expect(now.infantry).toBe(true);
    expect(now.ground).toBe(false); // (a Stinger costs more than we have)
  });

  it("answers infantry with Mortars, Hornets, Stingers, a Turret and Snipers; Mastodons with Rocket Squads", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "trooper", "red", 8, 9);
    spawnUnit(w, "trooper", "red", 9, 9);
    tickFog(w);
    intel.update(0);
    for (const k of ["mortar", "hornet", "stinger", "turret", "sniper"] as const)
      expect(counterAdvice(w, "blue", intel, k, 0).active, k).toBe(true);
    expect(counterAdvice(w, "blue", intel, "rocket-squad", 0).active).toBe(false);
    expect(adviceNote(counterAdvice(w, "blue", intel, "sniper", 0))).toBe("Contre : Escouades de pioupious (vus ×2)");
    spawnUnit(w, "mastodon", "red", 8, 10);
    spawnUnit(w, "mastodon", "red", 9, 10);
    tickFog(w);
    intel.update(1);
    expect(counterAdvice(w, "blue", intel, "rocket-squad", 1).active).toBe(true);
  });

  it("never counts a Sniper Team hidden in the woods it can't see", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    // in sight of a Scout of ours, in woods, beyond the concealment radius of anything of ours
    spawnUnit(w, "scout", "blue", 10, 14);
    setTerrain(w, 15, 11, Terrain.Forest);
    const s = spawnUnit(w, "sniper", "red", 15.5, 11.5);
    s.firedTick = -1000;
    w.tick = 100;
    tickFog(w);
    expect(isVisible(w, "blue", 15, 11)).toBe(true);
    intel.update(0);
    expect(intel.count("sniper", 0)).toBe(0);
    // it fires: the muzzle flash gives it away
    s.firedTick = w.tick;
    intel.update(1);
    expect(intel.count("sniper", 1)).toBe(1);
  });
});

describe("Montgolfière: boarding and drops from taps", () => {
  /** Blue Condor at (10, 10) with two Trooper Squads and a Rocket Squad near it, a Stinger alongside. */
  function bay() {
    const w = field();
    const c = new Controller(w);
    const condor = spawnUnit(w, "condor", "blue", 10, 10);
    const t1 = spawnUnit(w, "trooper", "blue", 13, 10);
    const t2 = spawnUnit(w, "trooper", "blue", 12, 10);
    const rk = spawnUnit(w, "rocket-squad", "blue", 16, 10);
    const tank = spawnUnit(w, "stinger", "blue", 12, 12);
    return { w, c, condor, t1, t2, rk, tank };
  }
  /** Put squads straight into the Condor's hold (as the sim does on embark). */
  const embark = (w: World, condor: Unit, ...us: Unit[]) => {
    for (const u of us) {
      w.units.delete(u.id);
      condor.passengers!.push(u);
    }
  };

  it("squads selected + tap an own Montgolfière: they board it, nearest first, as many as it seats", () => {
    const { w, c, condor, t1, t2, rk, tank } = bay();
    c.selectUnits([t1.id, t2.id, rk.id, tank.id]);
    c.tapWorld(10, 10, { kind: "ownUnit", id: condor.id });
    expect(c.drainCommands()).toEqual([{ type: "board", faction: "blue", unitIds: [t2.id, t1.id], carrierId: condor.id }]);
    expect(c.lastFeedback?.kind).toBe("board");
    expect(c.tip).toMatch(/Place pour 2/);
    // the selection stays as it was until they climb in; then the Condor takes their place
    expect(c.selectedUnits.size).toBe(4);
    embark(w, condor, t1, t2);
    c.prune();
    expect([...c.selectedUnits]).toEqual([rk.id, tank.id, condor.id]);
  });

  it("a flying Montgolfière stops to come and meet them; seats already promised count", () => {
    const { c, condor, t1, t2, rk } = bay();
    condor.order = { type: "move", x: 30, y: 30 };
    rk.order = { type: "board", carrierId: condor.id, ticks: 0 }; // already on its way
    c.selectUnits([t1.id, t2.id]);
    c.tapWorld(10, 10, { kind: "ownUnit", id: condor.id });
    expect(c.drainCommands()).toEqual([
      { type: "board", faction: "blue", unitIds: [t2.id], carrierId: condor.id },
      { type: "stop", faction: "blue", unitIds: [condor.id] }
    ]);
  });

  it("Montgolfière selected + tap an own squad: it boards the nearest selected Montgolfière with a seat", () => {
    const { w, c, condor, t1, t2 } = bay();
    const far = spawnUnit(w, "condor", "blue", 30, 10);
    c.selectUnits([far.id, condor.id]);
    c.tapWorld(13, 10, { kind: "ownUnit", id: t1.id });
    expect(c.drainCommands()).toEqual([{ type: "board", faction: "blue", unitIds: [t1.id], carrierId: condor.id }]);
    expect([...c.selectedUnits]).toEqual([far.id, condor.id]); // still selected: tap the next squad
    // that Condor full: the next squad goes to the other one
    embark(w, condor, t2, spawnUnit(w, "sniper", "blue", 11, 11));
    c.tapWorld(13, 10, { kind: "ownUnit", id: t1.id });
    expect(c.drainCommands()).toEqual([{ type: "board", faction: "blue", unitIds: [t1.id], carrierId: far.id }]);
  });

  it("a full Montgolfière is selected instead, with a note", () => {
    const { w, c, condor, t1, t2, rk } = bay();
    embark(w, condor, t2, rk);
    c.selectUnits([t1.id]);
    c.tapWorld(10, 10, { kind: "ownUnit", id: condor.id });
    expect(c.drainCommands()).toEqual([]);
    expect([...c.selectedUnits]).toEqual([condor.id]);
    expect(c.tip).toMatch(/plein/);
    // …and with only full Condors selected, tapping a squad just selects it
    c.tapWorld(13, 10, { kind: "ownUnit", id: t1.id });
    expect(c.drainCommands()).toEqual([]);
    expect([...c.selectedUnits]).toEqual([t1.id]);
  });

  it("ordinary selection taps are untouched: squad → squad, Montgolfière alone → Montgolfière, Shift toggles", () => {
    const { c, condor, t1, t2, tank } = bay();
    c.tapWorld(13, 10, { kind: "ownUnit", id: t1.id });
    c.tapWorld(12, 10, { kind: "ownUnit", id: t2.id });
    expect([...c.selectedUnits]).toEqual([t2.id]);
    c.tapWorld(12, 12, { kind: "ownUnit", id: tank.id });
    c.tapWorld(10, 10, { kind: "ownUnit", id: condor.id });
    expect([...c.selectedUnits]).toEqual([condor.id]);
    c.selectUnits([t1.id]);
    c.tapWorld(10, 10, { kind: "ownUnit", id: condor.id }, true); // Shift: add it, don't board
    expect([...c.selectedUnits]).toEqual([t1.id, condor.id]);
    expect(c.drainCommands()).toEqual([]);
  });

  it("the Unload chip drops where the Montgolfières are; a long-press flies them there and drops", () => {
    const { w, c, condor, t1, t2, tank } = bay();
    const empty = spawnUnit(w, "condor", "blue", 20, 20);
    c.selectUnits([condor.id, empty.id, tank.id]);
    expect(c.aboardSelected()).toBe(0);
    expect(c.unloadSelected()).toBe(false);
    expect(c.dropAt(25, 25)).toBe(false); // nothing aboard: the long-press is an ordinary box
    embark(w, condor, t1, t2);
    expect(c.aboardSelected()).toBe(2);
    expect(c.unloadSelected()).toBe(true);
    expect(c.drainCommands()).toEqual([{ type: "unload", faction: "blue", unitIds: [condor.id] }]);
    expect(c.lastFeedback).toEqual({ kind: "drop", x: condor.x, y: condor.y });
    expect(c.dropAt(25.5, 24.5)).toBe(true);
    expect(c.drainCommands()).toEqual([
      { type: "unload", faction: "blue", unitIds: [condor.id], x: 25.5, y: 24.5 },
      // the rest of the selection goes along
      { type: "attackMove", faction: "blue", unitIds: [empty.id, tank.id], x: 25.5, y: 24.5 }
    ]);
    expect(c.lastFeedback).toEqual({ kind: "drop", x: 25.5, y: 24.5 });
    // an ordinary tap on the ground still just moves
    c.tapWorld(30.5, 30.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "attackMove", faction: "blue", unitIds: [condor.id, empty.id, tank.id], x: 30.5, y: 30.5 }]);
  });

  it("an Assembly Bay takes a rally point like any factory", () => {
    const { w, c } = bay();
    const ab = spawnBuilding(w, "assembly-bay", "blue", 9, 4);
    c.tapWorld(9.5, 4.5, { kind: "ownBuilding", id: ab.id });
    expect(c.selectedBuilding).toBe(ab.id);
    c.tapWorld(14.5, 8.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "rally", faction: "blue", buildingId: ab.id, x: 14.5, y: 8.5 }]);
  });

  it("spectators can't load or drop", () => {
    const { w, c, condor, t1, t2 } = bay();
    c.spectator = true;
    c.selectUnits([t1.id]);
    c.tapWorld(10, 10, { kind: "ownUnit", id: condor.id });
    expect([...c.selectedUnits]).toEqual([condor.id]); // inspection only
    embark(w, condor, t1, t2);
    expect(c.unloadSelected()).toBe(false);
    expect(c.dropAt(20, 20)).toBe(false);
    expect(c.drainCommands()).toEqual([]);
  });

  it("squad chips keep members riding in a Montgolfière; selecting the squad selects the Montgolfière", () => {
    const { w, c, condor, t1, t2, tank } = bay();
    c.selectUnits([t1.id, t2.id, tank.id]);
    c.assignSquad(0);
    embark(w, condor, t1, t2);
    c.prune(); // the selection swaps the passengers for their Condor…
    expect([...c.selectedUnits]).toEqual([tank.id, condor.id]);
    expect(c.squads.slots[0]).toEqual([t1.id, t2.id, tank.id]); // …the squad keeps them
    const sum = c.squads.summary(0, w)!;
    expect(sum.count).toBe(3);
    expect(sum.kind).toBe("trooper");
    expect(c.selectSquad(0)).toBe(2);
    expect([...c.selectedUnits]).toEqual([condor.id, tank.id]);
    expect(c.squads.matches(0, c.selectedUnits, w)).toBe(true);
    expect(c.squads.focus(0, w)).not.toBeNull();
    // dropped again: back on the field, back in the selection
    condor.passengers = [];
    w.units.set(t1.id, t1);
    w.units.set(t2.id, t2);
    expect(c.squads.ids(0, w)).toEqual([t1.id, t2.id, tank.id]);
    // shot down over water with them aboard: gone from the squad
    embark(w, condor, t1);
    w.units.delete(condor.id);
    c.prune();
    expect(c.squads.slots[0]).toEqual([t2.id, tank.id]);
  });

  it("a squad saved with its Montgolfière selects that Montgolfière once when its riders are aboard", () => {
    const { w, c, condor, t1 } = bay();
    c.selectUnits([t1.id, condor.id]);
    c.assignSquad(0);
    embark(w, condor, t1);
    expect(c.squads.ids(0, w)).toEqual([condor.id]);
    expect(c.selectSquad(0)).toBe(1);
    expect(c.squads.matches(0, c.selectedUnits, w)).toBe(true); // (the chip lights up)
  });
});
