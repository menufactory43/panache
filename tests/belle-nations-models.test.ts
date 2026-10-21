import * as THREE from "three";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BUILDINGS, UNITS } from "../src/sim/balance";
import type { BuildingKind, Faction, Nation } from "../src/sim/types";

// WP5f / WP5d (PANACHE-CONCEPTION.md §3.2): the nations' own buildings, the Eiffel Tower and the nations'
// squads. Belle Époque is on only with a `location` (theme.ts): load the models under a stubbed one.

const had = "location" in globalThis;
const saved = (globalThis as { location?: unknown }).location;
vi.resetModules();
(globalThis as { location?: unknown }).location = { search: "" };
const m = await import("../src/game/three/models");
const inf = await import("../src/game/three/infantry");
const belle = await import("../src/game/three/belle");
const ph = await import("../src/game/three/belle/placeholders");
afterAll(() => {
  if (had) (globalThis as { location?: unknown }).location = saved;
  else delete (globalThis as { location?: unknown }).location;
});

const FACTIONS: Faction[] = ["blue", "red"];
/** Each nation building and the Classique kind whose contract (turret, parts) it keeps. */
const NATION_BUILDINGS: [Nation, BuildingKind, BuildingKind][] = [
  ["republique", "fab-plant", "fab-plant"],
  ["republique", "depot", "depot"],
  ["republique", "arsonval", "turret"],
  ["republique", "gantry", "gantry"],
  ["empire", "hq", "hq"],
  ["empire", "airpad", "airpad"],
  ["empire", "tech-lab", "tech-lab"],
  ["empire", "flak-battery", "sam-site"],
  ["empire", "radar", "radar"],
  ["empire", "assembly-bay", "assembly-bay"]
];
/**
 * Over §3.4's 1 500: the Hangar carries the Gantry's crane, booms and lamps for GantryView (the
 * Galerie: 2 976 + 31 550 in parts), the Caserne a baked Fusilier at its door (≈ 1 800; the
 * Manufacture: 5 532).
 */
const BUDGET: Partial<Record<BuildingKind, number>> = { gantry: 2500, "assembly-bay": 2700 };
const SQUADS = ["sapeurs", "fusiliers", "carabiniers"] as const;

const tris = (g?: THREE.BufferGeometry) => (g ? (g.index ? g.index.count : g.attributes.position!.count) / 3 : 0);
function size(g: THREE.BufferGeometry): THREE.Vector3 {
  g.computeBoundingBox();
  return g.boundingBox!.getSize(new THREE.Vector3());
}

describe("the nations' buildings (WP5f)", () => {
  it("registers exactly the ten new models, none left on a placeholder", () => {
    const got = Object.entries(belle.BE_NATION_BUILDING_MODELS).flatMap(([n, t]) => Object.keys(t).map((k) => `${n}/${k}`));
    expect(got.sort()).toEqual(NATION_BUILDINGS.map(([n, k]) => `${n}/${k}`).sort());
    expect(belle.PLACEHOLDER_BUILDING).toEqual({});
  });

  for (const f of FACTIONS)
    it(`draws each its own way, keeps its kind's contract and footprint (${f})`, () => {
      for (const [n, k, classic] of NATION_BUILDINGS) {
        const d = m.buildingDef(k, f, n);
        const ref = m.buildingDef(classic, f);
        expect(d, `${n} ${k}`).not.toBe(ref);
        expect(d.hull.attributes.position!.count).not.toBe(ref.hull.attributes.position!.count);
        expect(!!d.turret, `${k} turret`).toBe(!!ref.turret);
        expect(!!d.cargo || !!d.ramp, k).toBe(false);
        // every moving part the renderer drives on the Classique kind is there (the Bobine adds its arc)
        const want = Object.keys(ref.parts ?? {}).filter((p) => !p.startsWith("stage"));
        for (const p of want) expect(d.parts?.[p], `${k} part ${p}`).toBeDefined();
        for (const v of [d.mount, d.muzzle]) expect(v.every(Number.isFinite), k).toBe(true);
        expect(d.height).toBeGreaterThan(0);
        // footprint as balance.ts says: about `size` tiles across, centred
        const s = size(d.hull);
        const fp = BUILDINGS[k].size;
        for (const w of [s.x, s.z]) {
          expect(w, `${k} footprint`).toBeGreaterThan(fp * 0.8);
          expect(w, `${k} footprint`).toBeLessThan(fp * 1.05);
        }
        const c = d.hull.boundingBox!.getCenter(new THREE.Vector3());
        expect(Math.abs(c.x) + Math.abs(c.z), `${k} centred`).toBeLessThan(fp * 0.1);
        // the triangle budget (§3.4): ≤ 1 500 a building, its moving parts included (BUDGET: the exceptions)
        const parts = Object.values(d.parts ?? {}).reduce((a, p) => a + tris(p.geo), 0);
        expect(tris(d.hull) + tris(d.turret) + parts, `${k} triangles`).toBeLessThanOrEqual(BUDGET[k] ?? 1500);
      }
    });

  it("paints them in the nation's colours, shared kinds the nation doesn't redraw included", () => {
    // (the GQG keeps its model but wears the République's navy: one army, one colour, §1.1)
    expect(m.buildingDef("hq", "blue", "republique")).not.toBe(m.buildingDef("hq", "blue"));
    expect(tris(m.buildingDef("hq", "blue", "republique").hull)).toBe(tris(m.buildingDef("hq", "blue").hull));
    expect(m.buildingDef("hq", "blue", "classique")).toBe(m.buildingDef("hq", "blue"));
    expect(m.buildingDef("hq", "blue", "empire")).not.toBe(m.buildingDef("hq", "red", "empire"));
    // the nation-only defences need no nation passed
    expect(m.buildingDef("arsonval", "red")).toBe(m.buildingDef("arsonval", "red", "republique"));
    expect(m.buildingDef("flak-battery", "blue").turret).toBeDefined();
    expect(m.buildingDef("arsonval", "blue").parts?.arc).toBeDefined();
  });

  it("stands the Eiffel Tower 6 tiles tall on 3×3, flag in the holder's colour", () => {
    const d = m.landmarkDef("eiffel");
    const s = size(d.hull);
    expect(s.y).toBeGreaterThan(5.5);
    expect(s.y).toBeLessThan(6.5);
    expect(Math.max(s.x, s.z)).toBeLessThanOrEqual(3);
    expect(Math.max(s.x, s.z)).toBeGreaterThan(2.4);
    expect(tris(d.hull)).toBeLessThan(4000);
    expect(m.landmarkDef("eiffel", "blue")).not.toBe(d);
  });
});

describe("the nations' squads (WP5d)", () => {
  it("are no longer placeholders, and show their own portraits", () => {
    for (const k of SQUADS) {
      expect(ph.PLACEHOLDER_MODEL[k], k).toBeUndefined();
      expect(ph.lookalike(k)).toBe(k);
      expect(ph.portraitKind(k)).toBe(k);
    }
  });

  for (const f of FACTIONS)
    it(`rig every robot on the same joints, at the robots' height (${f})`, () => {
      for (const k of SQUADS) {
        const base = ph.STAND_IN[k] as "trooper" | "rocket-squad" | "sniper";
        const rig = new inf.SquadRig(k, f, 1);
        expect(rig.bots.length).toBe(UNITS[k].squad);
        for (const b of rig.bots) expect(b.b.length).toBe(Object.keys(inf.J).length);
        const h = size(inf.botStatic(k, f)).y;
        const hb = size(inf.botStatic(base, f)).y;
        expect(Math.abs(h - hb), `${k} height`).toBeLessThan(hb * 0.2);
        expect(inf.botStatic(k, f).attributes.position!.count).not.toBe(inf.botStatic(base, f).attributes.position!.count);
        // fires from a finite muzzle, ahead of the robot
        const p = rig.fire(0, new THREE.Vector3());
        expect(p && [p.x, p.y, p.z].every(Number.isFinite), k).toBe(true);
        // the unit model (the squad at ease)
        const d = m.unitDef(k, f);
        expect(d.hull.attributes.position!.count).toBeGreaterThan(0);
        expect(d.height).toBeCloseTo(inf.botHeight(k), 5);
      }
    });

  it("wear their nation's colours", () => {
    const col = (k: (typeof SQUADS)[number], f: Faction) => {
      const c = inf.botStatic(k, f).attributes.color!;
      const set = new Set<number>();
      for (let i = 0; i < c.count; i++) set.add(new THREE.Color(c.getX(i), c.getY(i), c.getZ(i)).getHex());
      return set;
    };
    const has = (s: Set<number>, hex: number) => [...s].some((c) => Math.abs((c >> 16) - (hex >> 16)) + Math.abs(((c >> 8) & 255) - ((hex >> 8) & 255)) + Math.abs((c & 255) - (hex & 255)) < 30);
    expect(has(col("sapeurs", "blue"), ph.NATION_TEAMS.republique.blue.main)).toBe(true);
    expect(has(col("fusiliers", "red"), ph.NATION_TEAMS.empire.red.main)).toBe(true);
  });

  it("raise a sandbag ring when dug in (Tranchées hook), and sink it after", () => {
    const rig = new inf.SquadRig("fusiliers", "blue", 2);
    expect(rig.root.children.length).toBe(1 + rig.bots.length);
    for (let i = 0; i < 60; i++) rig.update({ dt: 50, speed: 0, aim: 0, pitch: 0, alive: 5, entrenched: 1 });
    expect(rig.dug).toBeGreaterThan(0.95);
    const ring = rig.root.children.find((c) => (c as THREE.Mesh).isMesh && !(c as THREE.SkinnedMesh).isSkinnedMesh)!;
    expect(ring.visible).toBe(true);
    for (let i = 0; i < 80; i++) rig.update({ dt: 50, speed: 0, aim: 0, pitch: 0, alive: 5, entrenched: 0 });
    expect(rig.dug).toBe(0);
    expect(ring.visible).toBe(false);
  });
});
