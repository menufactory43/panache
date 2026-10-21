import * as THREE from "three";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BUILDING_KINDS, UNIT_KINDS } from "../src/game/assets";
import type { BotKind } from "../src/game/three/infantry";
import type { Faction } from "../src/sim/types";

// The Belle Époque models (src/game/three/belle/*, the BELLE_EPOQUE branches of goliath.ts and
// infantry.ts) must keep every contract the original models give the renderer: same turret / ramp /
// cargo / moving parts, a muzzle, spinning parts where the original spins, about the same footprint
// for buildings. theme.ts reads `location`, which Node lacks (so every other test runs the original
// models): load models.ts twice, once per style, with a stubbed location.

type Models = typeof import("../src/game/three/models");
type Goliath = typeof import("../src/game/three/goliath");
type Infantry = typeof import("../src/game/three/infantry");
interface Style {
  m: Models;
  g: Goliath;
  inf: Infantry;
  theme: typeof import("../src/game/three/theme");
}

const had = "location" in globalThis;
const saved = (globalThis as { location?: unknown }).location;

async function load(search: string): Promise<Style> {
  vi.resetModules();
  (globalThis as { location?: unknown }).location = { search };
  // (one at a time: models.ts and belle/* import each other)
  const m = await import("../src/game/three/models");
  const g = await import("../src/game/three/goliath");
  const inf = await import("../src/game/three/infantry");
  const theme = await import("../src/game/three/theme");
  return { m, g, inf, theme };
}

const original = await load("?style=original");
const belle = await load("");

afterAll(() => {
  if (had) (globalThis as { location?: unknown }).location = saved;
  else delete (globalThis as { location?: unknown }).location;
});

const FACTIONS: Faction[] = ["blue", "red"];
const BOTS: BotKind[] = ["trooper", "rocket-squad", "sniper"];

function box(geo: THREE.BufferGeometry): THREE.Box3 {
  geo.computeBoundingBox();
  return geo.boundingBox!.clone();
}

function finite(v: readonly number[]): boolean {
  return v.length === 3 && v.every(Number.isFinite);
}

/** What the renderer relies on in a ModelDef, minus the geometry itself. */
function shape(d: ReturnType<Models["unitDef"]>) {
  return {
    turret: !!d.turret,
    cargo: !!d.cargo,
    ramp: d.ramp ? { hinge: d.ramp.hinge, open: d.ramp.open, tip: d.ramp.tip } : null,
    parts: Object.fromEntries(Object.entries(d.parts ?? {}).map(([k, p]) => [k, p.parent ?? null]))
  };
}

describe("Belle Époque models", () => {
  it("are switched on by default and off under ?style=original", () => {
    expect(belle.theme.BELLE_EPOQUE).toBe(true);
    expect(original.theme.BELLE_EPOQUE).toBe(false);
  });

  it("restyle every vehicle, aircraft and building (not just recolour it)", () => {
    for (const k of UNIT_KINDS) {
      if (k === "goliath" || BOTS.includes(k as BotKind)) continue;
      const a = original.m.unitDef(k, "blue").hull.attributes.position!.count;
      const b = belle.m.unitDef(k, "blue").hull.attributes.position!.count;
      expect(b, k).not.toBe(a);
    }
    for (const k of BUILDING_KINDS) {
      const a = original.m.buildingDef(k, "blue").hull.attributes.position!.count;
      const b = belle.m.buildingDef(k, "blue").hull.attributes.position!.count;
      expect(b, k).not.toBe(a);
    }
  });

  for (const f of FACTIONS) {
    it(`keep every unit's model contract (${f})`, () => {
      for (const k of UNIT_KINDS) {
        const o = original.m.unitDef(k, f);
        const b = belle.m.unitDef(k, f);
        expect(shape(b), k).toEqual(shape(o));
        // (whatever spun still spins; a restyle may add a propeller, as the Hydroglisseur does)
        if (o.rotors.length) expect(b.rotors.length, `${k} rotors`).toBeGreaterThan(0);
        expect(finite(b.muzzle), `${k} muzzle`).toBe(true);
        expect(finite(b.mount), `${k} mount`).toBe(true);
        expect(b.height, `${k} height`).toBeGreaterThan(0);
        for (const r of b.rotors) expect(["y", "z"], `${k} rotor axis`).toContain(r.axis);
        expect(Number.isFinite(belle.m.unitScale(k)) && belle.m.unitScale(k) > 0, `${k} scale`).toBe(true);
      }
    });

    it(`keep every building's contract and footprint (${f})`, () => {
      for (const k of BUILDING_KINDS) {
        const o = original.m.buildingDef(k, f);
        const b = belle.m.buildingDef(k, f);
        expect(shape(b), k).toEqual(shape(o));
        expect(finite(b.muzzle), `${k} muzzle`).toBe(true);
        expect(b.height, `${k} height`).toBeGreaterThan(0);
        const so = box(o.hull).getSize(new THREE.Vector3());
        const sb = box(b.hull).getSize(new THREE.Vector3());
        // the same ground footprint, give or take eaves and props
        expect(sb.x / so.x, `${k} width`).toBeGreaterThan(0.8);
        expect(sb.x / so.x, `${k} width`).toBeLessThan(1.25);
        expect(sb.z / so.z, `${k} depth`).toBeGreaterThan(0.8);
        expect(sb.z / so.z, `${k} depth`).toBeLessThan(1.25);
      }
    });
  }

  it("keep the objectives' and pods' contracts", () => {
    const pairs: [string, ReturnType<Models["uplinkDef"]>, ReturnType<Models["uplinkDef"]>][] = [
      ["uplink", original.m.uplinkDef(), belle.m.uplinkDef()],
      ["crate", original.m.crateDef(), belle.m.crateDef()],
      ["pod", original.m.podDef("blue"), belle.m.podDef("blue")],
      ["pod open", original.m.podDef("red", true), belle.m.podDef("red", true)]
    ];
    for (const [k, o, b] of pairs) {
      expect(shape(b), k).toEqual(shape(o));
      expect(b.hull.attributes.position!.count, k).toBeGreaterThan(0);
    }
  });

  it("give Gargantua the same rig and about the same size as the Goliath", () => {
    for (const f of FACTIONS) {
      const o = box(original.g.goliathStatic(f)).getSize(new THREE.Vector3());
      const b = box(belle.g.goliathStatic(f)).getSize(new THREE.Vector3());
      expect(Math.abs(b.x - o.x), "width").toBeLessThan(0.25);
      expect(Math.abs(b.y - o.y), "height").toBeLessThan(0.25);
      expect(belle.g.goliathStatic(f).attributes.position!.count).not.toBe(original.g.goliathStatic(f).attributes.position!.count);
    }
    expect(Object.keys(belle.g.GOLIATH_RIG)).toEqual(Object.keys(original.g.GOLIATH_RIG));
    expect(belle.g.GANTRY_STAGES).toEqual(original.g.GANTRY_STAGES);
  });

  it("dress the automatons at the robots' height", () => {
    for (const k of BOTS) {
      for (const f of FACTIONS) {
        const o = box(original.inf.botStatic(k, f)).getSize(new THREE.Vector3());
        const b = box(belle.inf.botStatic(k, f)).getSize(new THREE.Vector3());
        expect(Math.abs(b.y - o.y), `${k} height`).toBeLessThan(o.y * 0.15);
        expect(belle.inf.botStatic(k, f).attributes.position!.count, k).not.toBe(original.inf.botStatic(k, f).attributes.position!.count);
      }
      expect(belle.inf.botHeight(k)).toBeCloseTo(original.inf.botHeight(k), 3);
    }
  });
});
