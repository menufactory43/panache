import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { EntityRenderer } from "../src/game/render/entities";
import { PowerRenderer } from "../src/game/render/powers";
import { DEFAULT_RULES } from "../src/sim/rules";
import { spawnSuper } from "../src/sim/goliath";
import type { Rules } from "../src/sim/rules";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

// The renderer's nation hooks headless (as render.test.ts): the Zénith's own view, the sandbag ring,
// the "hors réseau" cue, the Bobine's arc, the nations' power visuals.
// (Belle Époque on: the nations' own models, the Bobine's arc among them)
vi.mock("../src/game/three/theme", () => ({ BELLE_EPOQUE: true }));
const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };

const FRAME = 1000 / 60;

function setup() {
  const w = createWorld(64, 64);
  w.tick = 50;
  w.rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], startUnits: [], mutators: [], nations: { blue: "republique", red: "empire" } } as Rules;
  const fx = new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
  const gfx: unknown = new Proxy({}, { get: () => () => gfx });
  const view = {
    scene: new THREE.Scene(),
    terrain: { groundAt: () => 0, surfaceAt: () => 0, heightAt: () => 0, thinCanopy: () => {} },
    tweens: { add: () => {}, after: () => {} },
    rig: { zoom: 45, pitchFor: () => 1, shake: () => {}, onScreen: () => true },
    particles: { emit: () => {}, spawn: () => {} },
    top: gfx
  };
  const r = new EntityRenderer(view as never, w, fx as never, () => true, () => true, (f) => f === "blue", () => true);
  const prev = new Map<number, { x: number; y: number }>();
  const sync = (n = 1) => {
    for (let i = 0; i < n; i++) r.sync(1, prev, FRAME);
  };
  return { w, r, sync, view, fx };
}

type AnyView = { zenith?: unknown; goliath?: unknown; squad?: { dug: number }; m: { parts: Record<string, THREE.Object3D> }; noPower?: THREE.Sprite; variant: string };
const views = (r: EntityRenderer) => (r as unknown as { views: Map<number, AnyView> }).views;

describe("the renderer's nation hooks", () => {
  it("draws the Zénith with its own view, not the Goliath's, and crashes it when it dies", () => {
    const { w, r, sync } = setup();
    const z = spawnSuper(w, "zenith", "blue", 10, 10);
    sync(3);
    const v = views(r).get(z.id)!;
    expect(v.zenith).toBeTruthy();
    expect(v.goliath).toBeNull();
    w.fx.push({ type: "goliathWeapon", faction: "blue", id: z.id, weapon: "mortars", state: "offline" } as never);
    for (const ev of w.fx) r.onFx(ev);
    w.units.delete(z.id);
    sync(5);
    expect((r as unknown as { toppling: unknown[] }).toppling.length).toBe(1);
  });

  it("raises the sandbag ring round an entrenched squad", () => {
    const { w, r, sync } = setup();
    const s = spawnUnit(w, "fusiliers", "red", 12, 12);
    s.entrenched = true;
    sync(60);
    expect(views(r).get(s.id)!.squad!.dug).toBeGreaterThan(0.5);
  });

  it("dims an unpowered building, signs it, and puts out the Bobine's arc", () => {
    const { w, r, sync } = setup();
    const b = spawnBuilding(w, "arsonval", "blue", 20, 20);
    sync();
    const v = views(r).get(b.id)!;
    expect(v.m.parts.arc!.visible).toBe(true);
    b.unpowered = true;
    sync();
    expect(v.m.parts.arc!.visible).toBe(false);
    expect(v.variant).toBe("unpowered");
    expect(v.noPower?.visible).toBe(true);
    delete b.unpowered;
    sync();
    expect(v.noPower?.visible).toBe(false);
  });

  it("floats a Ballon-sonde over each reveal and lets it go when the reveal ends", () => {
    const { w, view, fx } = setup();
    const p = new PowerRenderer(view as never, w, fx as never, {
      player: "blue", spectator: false, visibleAt: () => true, earshot: () => 1, pos: () => null, isShown: () => true, alert: () => {}, ping: () => {}
    });
    w.nation = { reveals: [{ id: 7, faction: "blue", x: 5, y: 5, radius: 8, until: 999 }], clouds: [{ id: 8, faction: "red", x: 9, y: 9, radius: 3.5, until: 999 }], pos: new Map() };
    p.sync(FRAME, 1, null);
    const balloons = (p as unknown as { balloons: Map<number, unknown> }).balloons;
    expect(balloons.size).toBe(1);
    w.nation.reveals = [];
    p.sync(FRAME, 1, null);
    expect(balloons.size).toBe(0);
    for (const power of ["curie", "pression", "gaz", "sonde"] as const)
      p.onFx({ type: "calldownImpact", id: 9, faction: "blue", power, x: 5, y: 5, hits: 0, unitIds: [] } as never);
  });
});
