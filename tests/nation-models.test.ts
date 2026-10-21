import * as THREE from "three";
import { afterAll, describe, expect, it, vi } from "vitest";
import { UNITS } from "../src/sim/balance";
import type { Faction, UnitKind } from "../src/sim/types";

// The nations' own ground vehicles (PANACHE-CONCEPTION.md §1.11, WP5a/WP5b: belle/ground-rep.ts and
// ground-emp.ts): each has a model of its own (not its stand-in's), keeps the renderer's contract,
// stays under the §3.4 budget of 600 triangles, and shows its team colour on at least 30 % of what the
// high camera sees from above. theme.ts reads `location`, which Node lacks: stub it (Belle Époque on).

const had = "location" in globalThis;
const saved = (globalThis as { location?: unknown }).location;
vi.resetModules();
(globalThis as { location?: unknown }).location = { search: "" };
const m = await import("../src/game/three/models");
const belle = await import("../src/game/three/belle");
const { NATION_TEAMS } = await import("../src/game/three/belle/placeholders");

afterAll(() => {
  if (had) (globalThis as { location?: unknown }).location = saved;
  else delete (globalThis as { location?: unknown }).location;
});

const KINDS: UnitKind[] = ["fourgon", "jamais-contente", "de-dion", "branly", "estafette", "mortier-280", "atelier"];
const FACTIONS: Faction[] = ["blue", "red"];
const BUDGET = 600;

const tris = (g?: THREE.BufferGeometry) => (g ? g.attributes.position!.count / 3 : 0);
const finite = (v: readonly number[]) => v.length === 3 && v.every(Number.isFinite);

/** Fraction of the model's top-down silhouette (hull and turret) whose topmost surface is team-coloured. */
function teamFromAbove(kind: UnitKind): number {
  const make = belle.BE_UNIT_MODELS[kind]!;
  // two builds in two unlikely team colours: whatever differs between them is team paint
  const a = make({ main: 0x00ff00, dark: 0x00aa00, light: 0x88ff88 });
  const b = make({ main: 0xff00ff, dark: 0xaa00aa, light: 0xff88ff });
  type Tri = { p: THREE.Vector3[]; team: boolean };
  const all: Tri[] = [];
  const add = (ga: THREE.BufferGeometry, gb: THREE.BufferGeometry, off: readonly number[]) => {
    const p = ga.attributes.position!;
    const ca = ga.attributes.color!;
    const cb = gb.attributes.color!;
    for (let i = 0; i < p.count; i += 3) {
      const pts = [0, 1, 2].map((k) => new THREE.Vector3(p.getX(i + k) + off[0]!, p.getY(i + k) + off[1]!, p.getZ(i + k) + off[2]!));
      const team = Math.abs(ca.getX(i) - cb.getX(i)) + Math.abs(ca.getY(i) - cb.getY(i)) > 0.05;
      all.push({ p: pts, team });
    }
  };
  add(a.hull, b.hull, [0, 0, 0]);
  if (a.turret && b.turret) add(a.turret, b.turret, a.mount);
  const box = new THREE.Box3();
  for (const t of all) for (const v of t.p) box.expandByPoint(v);
  const N = 90;
  let hit = 0;
  let team = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = box.min.x + ((i + 0.5) / N) * (box.max.x - box.min.x);
      const z = box.min.z + ((j + 0.5) / N) * (box.max.z - box.min.z);
      let top = -Infinity;
      let isTeam = false;
      for (const t of all) {
        const [p0, p1, p2] = t.p as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
        const d = (p1.z - p2.z) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.z - p2.z);
        if (Math.abs(d) < 1e-12) continue;
        const l0 = ((p1.z - p2.z) * (x - p2.x) + (p2.x - p1.x) * (z - p2.z)) / d;
        const l1 = ((p2.z - p0.z) * (x - p2.x) + (p0.x - p2.x) * (z - p2.z)) / d;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const y = l0 * p0.y + l1 * p1.y + l2 * p2.y;
        if (y > top) {
          top = y;
          isTeam = t.team;
        }
      }
      if (top > -Infinity) {
        hit++;
        if (isTeam) team++;
      }
    }
  return team / hit;
}

describe("the nations' ground vehicles (WP5a, WP5b)", () => {
  it("each has a model of its own, not its stand-in's", () => {
    for (const k of KINDS) {
      expect(belle.BE_UNIT_MODELS[k], k).toBeTypeOf("function");
      const stand = belle.STAND_IN[k as keyof typeof belle.STAND_IN];
      expect(tris(m.unitDef(k, "blue").hull), k).not.toBe(tris(m.unitDef(stand, "blue").hull));
    }
  });

  for (const f of FACTIONS) {
    it(`keep the renderer's contract (${f})`, () => {
      for (const k of KINDS) {
        const d = m.unitDef(k, f);
        const u = UNITS[k];
        // a turret exactly where the sim aims one; the worker carries a load; the workshop's crane turns
        expect(!!d.turret, `${k} turret`).toBe(!!u.turret);
        expect(!!d.cargo, `${k} cargo`).toBe(u.base === "harvester");
        if (u.base === "mender") expect(d.rotors.length, `${k} rotors`).toBeGreaterThan(0);
        for (const r of d.rotors) expect(["y", "z"], `${k} rotor axis`).toContain(r.axis);
        expect(finite(d.muzzle), `${k} muzzle`).toBe(true);
        expect(finite(d.mount), `${k} mount`).toBe(true);
        expect(d.height, `${k} height`).toBeGreaterThan(0);
        // origin on the ground at the hull centre, nose toward -Z
        const b = d.hull.boundingBox!.clone();
        const all = b.clone();
        if (d.turret) all.union(d.turret.boundingBox!.clone().translate(new THREE.Vector3(...d.mount)));
        expect(b.min.y, `${k} on the ground`).toBeGreaterThanOrEqual(-0.01);
        expect(b.min.y, `${k} on the ground`).toBeLessThan(0.03);
        expect(Math.abs(all.min.x + all.max.x), `${k} centred`).toBeLessThan(0.2);
        expect(Math.abs(all.min.z + all.max.z), `${k} centred`).toBeLessThan(0.2);
        if (d.turret) expect(d.muzzle[2], `${k} muzzle forward`).toBeLessThan(0);
        const s = m.unitScale(k);
        expect(Number.isFinite(s) && s > 0, `${k} scale`).toBe(true);
      }
    });
  }

  it("are painted in their nation's colours", () => {
    for (const k of KINDS) {
      const n = UNITS[k].nation!;
      for (const f of FACTIONS) {
        const own = belle.BE_UNIT_MODELS[k]!(NATION_TEAMS[n][f]);
        expect(Array.from(m.unitDef(k, f).hull.attributes.color!.array), `${k} ${f}`).toEqual(Array.from(own.hull.attributes.color!.array));
      }
    }
  });

  it("stay within the triangle budget", () => {
    for (const k of KINDS) {
      const d = m.unitDef(k, "blue");
      const n = tris(d.hull) + tris(d.turret) + tris(d.cargo) + d.rotors.reduce((a, r) => a + tris(r.geo), 0);
      expect(n, k).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("show their team colour on at least 30 % of the view from above", () => {
    for (const k of KINDS) expect(teamFromAbove(k), k).toBeGreaterThanOrEqual(0.3);
  });
});
