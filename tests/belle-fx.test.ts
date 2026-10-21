import * as THREE from "three";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CameraRig } from "../src/game/three/camera";

// The Belle Époque weapon effects (src/game/render/belle-fx.ts, src/game/three/arcs.ts): the
// electric arcs stay within their buffers and recycle their records, and the period projectiles
// build. theme.ts reads `location`, which Node lacks: stub it so BELLE_EPOQUE is on.

const had = "location" in globalThis;
const saved = (globalThis as { location?: unknown }).location;
vi.resetModules();
(globalThis as { location?: unknown }).location = { search: "" };
const theme = await import("../src/game/three/theme");
const arcsMod = await import("../src/game/three/arcs");
const belle = await import("../src/game/render/belle-fx");

afterAll(() => {
  if (had) (globalThis as { location?: unknown }).location = saved;
  else delete (globalThis as { location?: unknown }).location;
});

function rig(): CameraRig {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 600);
  camera.position.set(10, 12, 20);
  return { camera, worldPerPx: () => 0.01 } as unknown as CameraRig;
}

describe("Belle Époque effects", () => {
  it("is on without ?style=original", () => {
    expect(theme.BELLE_EPOQUE).toBe(true);
  });

  it("draws arcs as ribbons, flickers them and lets them die", () => {
    const arcs = new arcsMod.Arcs(rig());
    arcs.bolt(0, 0.2, 0, 3, 0.4, 2, { life: 200, width: 0.1, tint: belle.ARC_BLUE, fork: 1 });
    arcs.update(16);
    expect(arcs.count).toBe(1);
    const geo = arcs.mesh.geometry as THREE.BufferGeometry;
    // 16 segments + a 4-segment fork, 6 indices a quad
    expect(geo.drawRange.count).toBe((16 + 4) * 6);
    const pos = geo.getAttribute("position").array as Float32Array;
    for (let i = 0; i < 20 * 4 * 3; i++) expect(Number.isFinite(pos[i]!)).toBe(true);
    const before = Array.from(pos.slice(0, 48));
    arcs.update(80); // past a re-roll: the kinks move
    expect(Array.from(pos.slice(0, 48))).not.toEqual(before);
    arcs.update(200);
    expect(arcs.count).toBe(0);
    expect(geo.drawRange.count).toBe(0);
  });

  it("caps the arcs in a huge brawl", () => {
    const arcs = new arcsMod.Arcs(rig());
    for (let i = 0; i < 500; i++) arcs.bolt(0, 0, 0, 1, 1, 1, { life: 1000, width: 0.1, tint: 0xffffff });
    expect(arcs.count).toBeLessThanOrEqual(80);
    arcs.update(16);
    arcs.dispose();
  });

  it("builds the period projectiles once", () => {
    const r = belle.congreveGeometry();
    const s = belle.shellGeometry();
    expect(r.getAttribute("position").count).toBeGreaterThan(0);
    expect(s.getAttribute("position").count).toBeGreaterThan(0);
    expect(belle.congreveGeometry()).toBe(r);
    // the shell points +Z (Object3D.lookAt aims +Z at the target): its nose is ahead of its base
    s.computeBoundingBox();
    expect(s.boundingBox!.max.z).toBeGreaterThan(-s.boundingBox!.min.z);
  });
});
