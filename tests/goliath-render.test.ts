import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { finaleBanner } from "../src/game/finale";
import { EntityRenderer } from "../src/game/render/entities";
import type { GoliathView } from "../src/game/render/goliath";
import { clearMat, modelMat } from "../src/game/three/materials";
import { GOLIATH, TICK_RATE, UNITS } from "../src/sim/balance";
import type { Building, FxEvent, Unit, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

// The Goliath and Gantry views headless: a real scene graph, a stubbed view (flat ground), no WebGL
// (as in render.test.ts). Effects are counted by name.
const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };

const FRAME = 1000 / 60;

interface Rig {
  r: EntityRenderer;
  w: World;
  fx: Map<string, number>;
  sync: (frames?: number, alpha?: number) => void;
}

/** A renderer for blue that sees only x < 20, and draws enemy units it's shown by `shown` (default: tile in sight). */
function setup(o: { shown?: (u: Unit) => boolean } = {}): Rig {
  const w = createWorld(64, 64);
  w.tick = 50;
  const fxCalls = new Map<string, number>();
  const fx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === "liquid" ? () => false : () => fxCalls.set(String(k), (fxCalls.get(String(k)) ?? 0) + 1)),
    set: (t, k, v) => ((t[k] = v), true)
  });
  const view = {
    scene: new THREE.Scene(),
    terrain: { groundAt: () => 0, surfaceAt: () => 0, heightAt: () => 0, thinCanopy: () => {} },
    tweens: { add: () => {}, after: () => {} },
    rig: { zoom: 45, pitchFor: () => 1, onScreen: () => true, shake: () => fxCalls.set("shake", (fxCalls.get("shake") ?? 0) + 1) }
  };
  const visibleAt = (x: number) => x < 20;
  const r = new EntityRenderer(view as never, w, fx as never, visibleAt, () => false, (f) => f === "blue", o.shown ?? ((u) => visibleAt(u.x)));
  const prev = new Map<number, { x: number; y: number }>();
  return {
    r, w, fx: fxCalls,
    sync: (frames = 1, alpha = 1) => {
      for (let i = 0; i < frames; i++) r.sync(alpha, prev, FRAME);
    }
  };
}

const views = (r: EntityRenderer) => (r as unknown as { views: Map<number, { goliath: GoliathView | null; m: { root: THREE.Object3D; parts: Record<string, THREE.Object3D> } }> }).views;
const toppling = (r: EntityRenderer) => (r as unknown as { toppling: GoliathView[] }).toppling;
/** Every model mesh under `o`. */
function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh && m.userData.model) out.push(m as THREE.Mesh);
  });
  return out;
}

describe("always visible: the Gargantua and the Gantry", () => {
  it("draws an enemy Gargantua and Gantry deep in the fog, live and clear of it (fog-free twins of the model materials)", () => {
    const { r, w, sync } = setup({ shown: (u) => u.kind === "goliath" || u.x < 20 });
    const g = spawnUnit(w, "goliath", "red", 50, 50);
    const b = spawnBuilding(w, "gantry", "red", 40, 40);
    sync(2);
    const gv = views(r).get(g.id)!;
    const bv = views(r).get(b.id)!;
    expect(gv.m.root.visible).toBe(true);
    expect(bv.m.root.visible).toBe(true);
    for (const m of [...meshes(gv.m.root), ...meshes(bv.m.root)]) {
      expect(m.userData.clear).toBe(true);
      expect(m.material).toBe(clearMat("normal"));
    }
    // a hit flash keeps to the twins
    r.hitFlash(g.id);
    sync();
    expect(meshes(gv.m.root)[0]!.material).toBe(clearMat("flash"));
    expect(clearMat("flash")).not.toBe(modelMat("flash"));
    // (same program as the plain material: only a uniform differs)
    expect(clearMat("normal").customProgramCacheKey()).toBe(modelMat("normal").customProgramCacheKey());
  });

  it("an enemy Gantry destroyed out of sight goes at once, never left standing as a remembered ghost", () => {
    const { r, w, sync, fx } = setup();
    const b = spawnBuilding(w, "gantry", "red", 40, 40);
    sync(2);
    w.buildings.delete(b.id);
    sync();
    expect(views(r).has(b.id)).toBe(false);
    expect(fx.get("rubble")).toBe(1);
  });

  it("an enemy Gantry's health is shown live (it is never only remembered)", () => {
    const { r, w, sync } = setup();
    const b = spawnBuilding(w, "gantry", "red", 40, 40);
    b.hp = BUILDINGS_GANTRY_HP / 2;
    sync();
    expect(r.shownHp(b.id)).toBeCloseTo(0.5);
  });
});

const BUILDINGS_GANTRY_HP = 1200;

describe("a Gargantua's guns", () => {
  it("fires each weapon from its own muzzle: mortars from the shoulder pods, the laser from the eye, cannons from the arms", () => {
    const { r, w, sync } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    g.facing = 0;
    sync(3);
    const at = (fx: "shell" | "laser" | "heavy-cannon" | "mg") => {
      r.fired(g.id, 0, fx);
      return r.muzzle(g.id, fx)!;
    };
    const shell = at("shell");
    const shell2 = at("shell");
    const eye = at("laser");
    const cannon = at("heavy-cannon");
    const cannon2 = at("heavy-cannon");
    const mg = at("mg");
    // the pods and the eye sit high, the guns lower, and the two pods (and the two arms) take turns
    expect(shell.h).toBeGreaterThan(2);
    expect(eye.h).toBeGreaterThan(2);
    expect(cannon.h).toBeLessThan(eye.h);
    expect(mg.h).toBeLessThan(eye.h);
    expect(Math.sign(shell.x - 10)).toBe(-Math.sign(shell2.x - 10));
    expect(Math.sign(cannon.x - 10)).toBe(-Math.sign(cannon2.x - 10));
    // facing north, the cannons and the eye point ahead (north: -y)
    expect(cannon.y).toBeLessThan(9.4);
    expect(eye.y).toBeLessThan(10);
  });
});

describe("anchoring", () => {
  it("lowers the body and drives the spikes from the sim's own timer, and they bite with a thump and a shake", () => {
    const { r, w, sync, fx } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    sync(2);
    const gv = views(r).get(g.id)!.goliath!;
    const pelvis = gv.rig.j.pelvis;
    const stand = pelvis.position.y;
    const total = Math.round(GOLIATH.anchorTime * TICK_RATE);
    g.goliath!.mode = "anchoring";
    for (let t = total; t >= 0; t -= 2) {
      g.goliath!.modeTicks = t;
      sync(12);
    }
    g.goliath!.mode = "anchored";
    g.goliath!.modeTicks = 0;
    sync(60);
    expect(pelvis.position.y).toBeLessThan(stand - 0.25);
    expect(gv.rig.j.rodFL.position.y).toBeLessThan(-0.25);
    expect(fx.get("sound")).toBeGreaterThan(0);
    expect(fx.get("shake")).toBe(1);
  });
});

describe("a Gargantua's death", () => {
  it("topples, slams down and sinks away, then its view goes", () => {
    const { r, w, sync, fx } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    sync(2);
    const gv = views(r).get(g.id)!.goliath!;
    w.units.delete(g.id);
    sync();
    expect(toppling(r)).toHaveLength(1);
    sync(Math.round(1600 / FRAME));
    // (it lies on its side, about 80° over)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(gv.rig.j.body.quaternion);
    expect(up.y).toBeLessThan(0.2);
    expect(fx.get("slam")).toBe(1);
    sync(Math.round(5000 / FRAME));
    expect(toppling(r)).toHaveLength(0);
    expect(gv.root.parent).toBeNull();
  });
});

describe("the Gantry's stages", () => {
  function gantry(): { rig: Rig; b: Building; parts: () => Record<string, THREE.Object3D> } {
    const rig = setup();
    const b = spawnBuilding(rig.w, "gantry", "blue", 4, 4);
    rig.sync();
    return { rig, b, parts: () => views(rig.r).get(b.id)!.m.parts };
  }
  const shown = (p: Record<string, THREE.Object3D>) => [0, 1, 2, 3].filter((i) => p[`stage${i}`]!.visible);

  it("builds the Gargantua up in four stages from the head of its queue, lights on while it works", () => {
    const { rig, b, parts } = gantry();
    expect(shown(parts())).toEqual([]);
    expect(parts().lightsOn!.visible).toBe(false);
    const total = UNITS.goliath.buildTime * TICK_RATE;
    b.queue.push({ kind: "goliath", remaining: total });
    for (const [k, stage] of [[0.1, 0], [0.3, 1], [0.6, 2], [0.9, 3]] as const) {
      b.queue[0]!.remaining = Math.round(total * (1 - k));
      rig.sync();
      expect(shown(parts())).toEqual([stage]);
    }
    expect(parts().lightsOn!.visible).toBe(true);
  });

  it("rolls out: the mech leaves the cradle as the real Gargantua, starting where it stood, and the arms swing clear", () => {
    const { rig, b, parts } = gantry();
    const total = UNITS.goliath.buildTime * TICK_RATE;
    b.queue.push({ kind: "goliath", remaining: Math.round(total * 0.05) });
    rig.sync();
    b.queue.length = 0;
    const g = spawnUnit(rig.w, "goliath", "blue", 5.5, 10.5);
    rig.r.onFx({ type: "goliathRollout", faction: "blue", id: g.id, buildingId: b.id, x: g.x, y: g.y } as FxEvent);
    rig.sync();
    expect(shown(parts())).toEqual([]);
    const gv = views(rig.r).get(g.id)!.goliath!;
    // (it starts on the cradle, at the Gantry's middle, not where the sim put it)
    expect(Math.hypot(gv.gx - 5.5, gv.gy - 5.5)).toBeLessThan(0.3);
    rig.sync(Math.round(600 / FRAME));
    expect(parts().armL!.rotation.y).toBeGreaterThan(1);
    rig.sync(Math.round(5000 / FRAME));
    expect(Math.hypot(gv.gx - 5.5, gv.gy - 10.5)).toBeLessThan(0.05);
  });

  it("holds its work still while it's EMP'd", () => {
    const { rig, b } = gantry();
    const total = UNITS.goliath.buildTime * TICK_RATE;
    b.queue.push({ kind: "goliath", remaining: Math.round(total * 0.5) });
    rig.w.powers.stunned.set(b.id, rig.w.tick + 100);
    const work = () => (views(rig.r).get(b.id) as unknown as { gantry: { work: number } }).gantry.work;
    const before = work();
    rig.sync(30, 0.5);
    expect(work()).toBe(before);
    expect(rig.fx.get("weld") ?? 0).toBe(0);
  });
});

describe("Robot Love", () => {
  it("walks the two Gargantuas to meet, eyes pink, hearts rising", () => {
    const { r, w, sync, fx } = setup();
    const a = spawnUnit(w, "goliath", "blue", 8, 10);
    const b = spawnUnit(w, "goliath", "red", 12, 10);
    sync(2);
    w.winner = "draw"; // (the sim has stopped at the draw: GameScene.playFinale)
    r.love([a.id, b.id], 10, 10);
    sync(Math.round(4200 / FRAME));
    const va = views(r).get(a.id)!.goliath!;
    const vb = views(r).get(b.id)!.goliath!;
    expect(Math.hypot(va.gx - vb.gx, va.gy - vb.gy)).toBeLessThan(2.4);
    // facing each other
    expect(Math.abs(Math.sin(va.face) - 1)).toBeLessThan(0.05);
    expect(Math.abs(Math.sin(vb.face) + 1)).toBeLessThan(0.05);
    const love = va.rig.meshes.find((m) => m.part === "eyeLove")!.mesh;
    expect(love.visible).toBe(true);
    expect(fx.get("hearts")).toBeGreaterThan(5);
  });
});

describe("the finale's banner", () => {
  const at = { x: 1, y: 2, player: "blue" as const, spectator: false };
  it("keeps its keys, and names what decided it", () => {
    expect(finaleBanner({ ...at, cause: "hq", winner: "blue" })).toMatchObject({ key: "victory", text: "GQG ennemi détruit" });
    expect(finaleBanner({ ...at, cause: "hq", winner: "red" })).toMatchObject({ key: "defeat", text: "Notre GQG est tombé" });
    expect(finaleBanner({ ...at, cause: "goliath", winner: "blue" })).toMatchObject({ key: "victory", text: "Gargantua ennemi détruit" });
    expect(finaleBanner({ ...at, cause: "goliath", winner: "red" })).toMatchObject({ key: "defeat", text: "Notre dernier Gargantua est tombé" });
    expect(finaleBanner({ ...at, spectator: true, cause: "goliath", winner: "blue" })).toMatchObject({ key: "hq-destroyed", text: "Gargantua Rouge détruit" });
    expect(finaleBanner({ ...at, spectator: true, cause: "hq", winner: "red" })).toMatchObject({ key: "hq-destroyed", text: "GQG Bleu détruit" });
    expect(finaleBanner({ ...at, cause: "love", winner: "draw" })).toMatchObject({ key: "draw", sub: "Match nul", tone: "good" });
  });
});

describe("final review regressions", () => {
  const group = (r: EntityRenderer) => (r as unknown as { group: THREE.Group }).group;
  /** The four lift cables (meshes tagged to draw clear of the fog, straight under the renderer's group). */
  const cables = (r: EntityRenderer) => group(r).children.filter((o) => (o as THREE.Mesh).isMesh && o.userData.clear) as THREE.Mesh[];
  /** Hook Condors a and b onto g, carrying. */
  const carry = (g: Unit, a: Unit, b: Unit) => {
    g.goliath!.lift = { carriers: [a.id, b.id], phase: "carrying", dest: null, setDown: false };
    for (const c of [a, b]) c.order = { type: "lift", goliathId: g.id };
  };

  it("a replay seek back past Robot Love ends the love scene: the Gargantuas follow the sim again", () => {
    const { r, w, sync } = setup({ shown: () => true });
    const a = spawnUnit(w, "goliath", "blue", 10, 10);
    const b = spawnUnit(w, "goliath", "red", 14, 10);
    sync(2);
    w.winner = "draw";
    r.love([a.id, b.id], 12, 10);
    sync(120);
    const va = views(r).get(a.id)!.goliath!;
    expect(va.inLove).toBe(true);
    // the seek: an earlier keyframe, before anyone met
    w.winner = null;
    w.tick = 20;
    a.x = 5;
    a.y = 30;
    b.x = 50;
    b.y = 30;
    sync(2);
    expect(va.inLove).toBe(false);
    expect(va.gx).toBeCloseTo(5, 6);
    expect(va.gy).toBeCloseTo(30, 6);
    expect(views(r).get(b.id)!.goliath!.inLove).toBe(false);
  });

  it("a replay seek back to before a Gargantua was built drops its view quietly (no topple)", () => {
    const { r, w, sync, fx } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    sync(2);
    w.units.delete(g.id);
    w.tick = 10;
    sync();
    expect(views(r).has(g.id)).toBe(false);
    expect(toppling(r)).toHaveLength(0);
    sync(Math.round(3000 / FRAME));
    expect(fx.get("slam")).toBeUndefined();
  });

  it("an enemy lift in the fog: the cables rise to where its hidden Montgolfières fly, drawn clear of the fog", () => {
    const { r, w, sync } = setup({ shown: (u) => u.kind === "goliath" || u.x < 20 });
    const g = spawnUnit(w, "goliath", "red", 40, 40);
    const a = spawnUnit(w, "condor", "red", 39.5, 40);
    const b = spawnUnit(w, "condor", "red", 40.5, 40);
    sync(2);
    carry(g, a, b);
    sync(240);
    const cs = cables(r);
    expect(cs).toHaveLength(4);
    for (const c of cs) {
      expect(c.visible).toBe(true);
      // (up toward the Condors, not down into the ground where their hidden views were last drawn)
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion).y).toBeGreaterThan(0.3);
      expect(c.material).toBe(clearMat("normal"));
    }
  });

  it("the cables hold on as a set-down Gargantua eases to the ground", () => {
    const { r, w, sync } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    const a = spawnUnit(w, "condor", "blue", 9.5, 10);
    const b = spawnUnit(w, "condor", "blue", 10.5, 10);
    sync(2);
    carry(g, a, b);
    sync(240);
    // the sim sets it down: the lift is gone at once, the view eases down
    g.goliath!.lift = null;
    a.order = b.order = { type: "idle" };
    sync(15);
    const gv = views(r).get(g.id)!.goliath!;
    expect(gv.bh).toBeGreaterThan(0.05);
    expect(cables(r).filter((c) => c.visible)).toHaveLength(4);
    sync(120);
    expect(cables(r).filter((c) => c.visible)).toHaveLength(0);
  });

  it("in love, a Gargantua that was digging in draws no progress arc and no rings", () => {
    const { r, w, sync } = setup({ shown: () => true });
    const a = spawnUnit(w, "goliath", "blue", 10, 10);
    const b = spawnUnit(w, "goliath", "red", 14, 10);
    a.goliath!.mode = "anchoring";
    a.goliath!.modeTicks = 20;
    sync(30);
    const calls: string[] = [];
    // (a stand-in for the ground overlay: counts the drawing calls; px is world tiles per CSS px)
    const gfx: unknown = new Proxy({}, {
      get: (_t, k) => (typeof k === "symbol" ? undefined : k === "px" ? () => 0.02 : () => (calls.push(String(k)), gfx))
    });
    r.goliathMarks(gfx as never, new Set([a.id]));
    expect(calls.length).toBeGreaterThan(0); // (digging in: the arc and the rings)
    w.winner = "draw";
    r.love([a.id, b.id], 12, 10);
    sync(2);
    calls.length = 0;
    r.goliathMarks(gfx as never, new Set([a.id]));
    expect(calls).toEqual([]);
  });

  it("a health-bar notch is amber while its weapon is down, not just below its line", async () => {
    // (juice-view brings in the sound, which listens to the page)
    (document as unknown as { addEventListener?: unknown }).addEventListener ??= () => {};
    (globalThis as { window?: unknown }).window ??= { addEventListener: () => {} };
    const { CombatJuice } = await import("../src/game/render/juice-view");
    const juice = new CombatJuice({ dpr: 1 } as never, {} as never);
    const fills: string[] = [];
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k === "fillRect" ? () => fills.push(String(t.fillStyle)) : k in t ? t[k] : () => {}),
      set: (t, k, v) => ((t[k] = v), true)
    });
    const marks = [0.75, 0.5, 0.25];
    // at 78%: above the mortars' line, but still offline (the restore margin), or rebooting
    juice.healthBar(ctx as never, 1, 0, 0, 100, 0.78, true, 5, marks, [true, false, false]);
    const amber = fills.filter((f) => f === "#ffb347");
    expect(amber).toHaveLength(1);
    fills.length = 0;
    juice.healthBar(ctx as never, 1, 0, 0, 100, 0.78, true, 5, marks, [false, false, false]);
    expect(fills.filter((f) => f === "#ffb347")).toHaveLength(0);
  });
});
