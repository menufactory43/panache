import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TICK_RATE, UNITS, ZENITH, type ZenithWeapon } from "../src/sim/balance";
import type { Faction, Unit, UnitKind } from "../src/sim/types";

// WP5c (src/game/three/belle/air-emp.ts: Gyroptère, Épervier, Vulcain, Titan) and WP5e (three/zenith.ts,
// render/zenith.ts: the Zénith). Belle Époque style: theme.ts reads `location`, which Node lacks.
(globalThis as { location?: unknown }).location ??= { search: "" };
const models = await import("../src/game/three/models");
const belle = await import("../src/game/three/belle");
const { AIR_EMP } = await import("../src/game/three/belle/air-emp");
const zen = await import("../src/game/three/zenith");
const view = await import("../src/game/render/zenith");

const MINE = ["gyroptere", "epervier", "vulcain", "titan", "zenith"] as const;
const FACTIONS: Faction[] = ["blue", "red"];

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position!.count) / 3;
function defTris(d: ReturnType<typeof models.unitDef>): number {
  return tris(d.hull) + (d.turret ? tris(d.turret) : 0) + d.rotors.reduce((a, r) => a + tris(r.geo), 0) + (d.ramp ? tris(d.ramp.geo) : 0) +
    Object.values(d.parts ?? {}).reduce((a, p) => a + tris(p.geo), 0);
}

/**
 * Share of the model's top-down silhouette whose topmost surface is team colour. A marker team (pure
 * magentas: the builders' shading scales r, g, b alike, so a team vertex keeps r = b and no green) is
 * painted, then a grid of vertical rays finds the highest triangle over each point.
 */
const MARKER = { main: 0xff00ff, dark: 0x990099, light: 0xff40ff };
function teamShare(geos: { geo: THREE.BufferGeometry; at?: THREE.Vector3 }[]): number {
  const tri: { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; team: boolean }[] = [];
  const box = new THREE.Box3();
  for (const { geo, at } of geos) {
    const p = geo.attributes.position!;
    const c = geo.attributes.color!;
    for (let i = 0; i + 2 < p.count; i += 3) {
      const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, i + k).add(at ?? new THREE.Vector3()));
      const r = c.getX(i);
      const g = c.getY(i);
      const bl = c.getZ(i);
      tri.push({ a: v[0]!, b: v[1]!, c: v[2]!, team: r > 0.05 && Math.abs(r - bl) < 0.02 * Math.max(r, bl) + 0.004 && g < 0.3 * r });
      for (const x of v) box.expandByPoint(x);
    }
  }
  const N = 70;
  let hit = 0;
  let team = 0;
  const ray = new THREE.Ray();
  const out = new THREE.Vector3();
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = box.min.x + ((i + 0.5) / N) * (box.max.x - box.min.x);
      const z = box.min.z + ((j + 0.5) / N) * (box.max.z - box.min.z);
      ray.set(new THREE.Vector3(x, box.max.y + 1, z), new THREE.Vector3(0, -1, 0));
      let best = -Infinity;
      let isTeam = false;
      for (const t of tri) {
        if (!ray.intersectTriangle(t.a, t.b, t.c, false, out)) continue;
        if (out.y > best) {
          best = out.y;
          isTeam = t.team;
        }
      }
      if (best > -Infinity) {
        hit++;
        if (isTeam) team++;
      }
    }
  return team / hit;
}

describe("Empire aircraft and the Zénith (WP5c, WP5e)", () => {
  it("have models of their own: no longer drawn with a stand-in's", () => {
    for (const k of MINE) {
      expect(belle.PLACEHOLDER_MODEL[k], k).toBeUndefined();
      expect(belle.BE_UNIT_MODELS[k], k).toBeDefined();
      // (voices and portraits keep their stand-in until WP5g)
      expect(belle.STAND_IN[k], k).toBeDefined();
      const base = belle.STAND_IN[k];
      expect(models.unitDef(k, "blue").hull.attributes.position!.count, k).not.toBe(models.unitDef(base, "blue").hull.attributes.position!.count);
    }
  });

  for (const f of FACTIONS)
    it(`keep the unit model contract and the triangle budget (${f})`, () => {
      for (const k of MINE) {
        const d = models.unitDef(k, f);
        expect(d.muzzle.every(Number.isFinite) && d.mount.every(Number.isFinite), k).toBe(true);
        expect(d.height, k).toBeGreaterThan(0);
        expect(d.rotors.length, `${k} rotors`).toBeGreaterThan(0);
        for (const r of d.rotors) expect(["y", "z"]).toContain(r.axis);
        const s = models.unitScale(k);
        expect(Number.isFinite(s) && s > 0, k).toBe(true);
        // (§3.4: ≤ 600 a unit, ≤ 4 000 for the Zénith)
        expect(defTris(d), `${k} triangles`).toBeLessThanOrEqual(k === "zenith" ? 4000 : 600);
      }
      // the Titan carries squads like the Condor: the same bay ramp (CONDOR_BAY seats, the same lip)
      const t = models.unitDef("titan", f).ramp!;
      const c = models.unitDef("condor", f).ramp!;
      expect({ hinge: t.hinge, open: t.open, tip: t.tip }).toEqual({ hinge: c.hinge, open: c.open, tip: c.tip });
    });

  it("wear their nation's colours, readable from above (team ≥ 30% of the top view, §1.11)", () => {
    for (const k of ["gyroptere", "epervier", "vulcain", "titan"] as const) {
      const d = AIR_EMP[k]!(MARKER);
      const share = teamShare([{ geo: d.hull }, ...d.rotors.map((r) => ({ geo: r.geo, at: new THREE.Vector3(...r.at) }))]);
      expect(share, k).toBeGreaterThanOrEqual(0.3);
    }
    const z = zen.zenithModel(MARKER);
    expect(teamShare([{ geo: z.hull }]), "zenith").toBeGreaterThanOrEqual(0.3);
    // painted with the nation's team, not the side's: the Empire's burgundy, the République's navy
    const has = (k: UnitKind, f: Faction, hex: number) => {
      // (shading scales a colour's r, g, b alike: compare their proportions)
      const want = new THREE.Color(hex);
      const wm = Math.max(want.r, want.g, want.b);
      const c = models.unitDef(k, f).hull.attributes.color!;
      for (let i = 0; i < c.count; i++) {
        const m = Math.max(c.getX(i), c.getY(i), c.getZ(i));
        if (m > 0.02 && Math.abs(c.getX(i) / m - want.r / wm) < 0.01 && Math.abs(c.getY(i) / m - want.g / wm) < 0.01 && Math.abs(c.getZ(i) / m - want.b / wm) < 0.01) return true;
      }
      return false;
    };
    expect(has("vulcain", "blue", belle.NATION_TEAMS.empire.blue.main), "vulcain").toBe(true);
    expect(has("titan", "red", belle.NATION_TEAMS.empire.red.main), "titan").toBe(true);
    expect(has("zenith", "blue", belle.NATION_TEAMS.republique.blue.main), "zenith").toBe(true);
  });

  it("rig the Zénith: every weapon a part of its own that goes dark when lost", () => {
    const rig = new zen.ZenithRig(zen.zenithTeam("blue"), false);
    expect(rig.triangles).toBeLessThanOrEqual(4000);
    for (const g of zen.ZENITH_GUNS) {
      expect(rig.j[g], g).toBeDefined();
      expect(rig.muzzle(g, new THREE.Vector3()).toArray().every(Number.isFinite), g).toBe(true);
    }
    expect(new Set(Object.values(zen.GUN_WEAPON))).toEqual(new Set(Object.keys(ZENITH.weapons)));
    const lit = (w: ZenithWeapon) => rig.meshes.filter((m) => m.part.role === "lit" && m.part.weapon === w);
    for (const w of ["branly", "arc", "bombs"] as ZenithWeapon[]) expect(lit(w).length, w).toBeGreaterThan(0);
    const down = { ...zen.ZENITH_REST, weapons: { ...zen.ZENITH_REST.weapons, branly: { lit: false, dead: 1 }, arc: { lit: false, dead: 1 } } };
    rig.update(down);
    for (const m of [...lit("branly"), ...lit("arc")]) expect(m.mesh.visible).toBe(false);
    for (const m of lit("bombs")) expect(m.mesh.visible).toBe(true);
    // lost, the Branly barrels sag
    expect(rig.j.branlyLBarrel.rotation.x).toBeLessThan(-0.3);
    rig.update(zen.ZENITH_REST);
    for (const m of lit("branly")) expect(m.mesh.visible).toBe(true);
  });

  it("moors the Zénith on four cables down to the ground, its hangar doors open", () => {
    const rig = new zen.ZenithRig(zen.zenithTeam("red"), false);
    const cables = [0, 1, 2, 3].map((i) => rig.j[`cable${i}` as "cable0"]);
    expect(cables.every((c) => !c.visible)).toBe(true);
    rig.update({ ...zen.ZENITH_REST, moor: 1, bay: 1, drop: 2 });
    for (let i = 0; i < 4; i++) {
      expect(cables[i]!.visible).toBe(true);
      const top = rig.hardpoint(i, new THREE.Vector3());
      const foot = rig.anchorPoint(i, new THREE.Vector3());
      expect(top.y - foot.y, `cable ${i}`).toBeCloseTo(2 - 0.04, 2);
    }
    expect(Math.abs(rig.j.bayL.rotation.z)).toBeGreaterThan(1);
    expect(Math.abs(rig.j.bayR.rotation.z)).toBeGreaterThan(1);
  });

  it("reads the sim's Zénith state: the Goliath's mode machine, or plain moored/mooring fields, or HP alone", () => {
    const u = { kind: "zenith", hp: UNITS.zenith.hp } as Unit;
    expect(view.zenithMode({}).mode).toBe("walking");
    expect(view.zenithMode({ mode: "anchored", modeTicks: 0 })).toEqual({ mode: "anchored", k: 1 });
    const half = view.zenithMode({ mode: "anchoring", modeTicks: Math.round((ZENITH.anchorTime * TICK_RATE) / 2) });
    expect(half.mode).toBe("anchoring");
    expect(half.k).toBeGreaterThan(0);
    expect(half.k).toBeLessThan(1);
    expect(view.zenithMode({ moored: true }).mode).toBe("anchored");
    expect(view.zenithMode({ mooring: 0.5 })).toEqual({ mode: "anchoring", k: 0.5 });
    expect(view.zenithMode({ moored: true, mooring: 0.3 })).toEqual({ mode: "packing", k: 0.3 });
    // weapons: from the sim's flags when it gives them, else lost below their HP share
    expect(view.weaponState(u, { weapons: { branly: { online: false } } }, "branly").online).toBe(false);
    expect(view.weaponState(u, {}, "branly").online).toBe(true);
    const hurt = { ...u, hp: UNITS.zenith.hp * 0.4 } as Unit;
    expect(ZENITH_ORDER.map((k) => view.weaponState(hurt, {}, k).online)).toEqual([false, false, true, true]);
    expect(view.zenithReach(hurt, {})).toBe(Math.max(ZENITH.weapons.bombs.range, ZENITH.weapons.mg.range));
    expect(view.zenithSim({ ...u, goliath: { mode: "anchored" } } as unknown as Unit).mode).toBe("anchored");
    expect(view.zenithSim({ ...u, zenith: { moored: true } } as unknown as Unit).moored).toBe(true);
  });
});

const ZENITH_ORDER: ZenithWeapon[] = ["branly", "arc", "bombs", "mg"];
