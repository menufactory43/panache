import { describe, expect, it } from "vitest";
import { ROUTE_DRAW, closesLoop, planRoute, rdp, simplifyRoute, trailLength, type Pt } from "../src/game/route-draw";
import { Controller, setLocalSide } from "../src/game/controller";
import { createWorld, spawnUnit } from "../src/sim/world";

/** A finger's trail through `corners`, sampled every 0.3 tiles with a little deterministic jitter. */
function trail(corners: Pt[], jitter = 0.15): Pt[] {
  const out: Pt[] = [corners[0]!];
  let k = 0;
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!;
    const b = corners[i]!;
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / ROUTE_DRAW.sampleTiles));
    for (let s = 1; s <= n; s++) {
      const j = s === n ? 0 : Math.sin(++k * 1.7) * jitter;
      out.push({ x: a.x + ((b.x - a.x) * s) / n + j, y: a.y + ((b.y - a.y) * s) / n - j });
    }
  }
  return out;
}
const near = (a: Pt, b: Pt, d = 1) => Math.hypot(a.x - b.x, a.y - b.y) <= d;

describe("polyline simplification", () => {
  it("rdp keeps the ends and the corners, drops the jitter", () => {
    const t = trail([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    const s = rdp(t, ROUTE_DRAW.epsilon);
    expect(s[0]).toEqual(t[0]);
    expect(s[s.length - 1]).toEqual(t[t.length - 1]);
    expect(s.length).toBe(3);
    expect(near(s[1]!, { x: 10, y: 0 })).toBe(true);
  });

  it("a straight line is its two ends", () => {
    expect(rdp(trail([{ x: 2, y: 2 }, { x: 20, y: 9 }]), 1)).toHaveLength(2);
    expect(rdp([{ x: 1, y: 1 }], 1)).toHaveLength(1);
  });

  it("merges corners too close together for a unit to notice", () => {
    // a zig-zag of 1-tile teeth along a 12-tile line
    const zig: Pt[] = [];
    for (let i = 0; i <= 12; i++) zig.push({ x: i, y: i % 2 ? 1.6 : 0 });
    const s = simplifyRoute(zig);
    for (let i = 1; i < s.length; i++) expect(Math.hypot(s[i]!.x - s[i - 1]!.x, s[i]!.y - s[i - 1]!.y)).toBeGreaterThanOrEqual(ROUTE_DRAW.minGap - 1e-9);
    expect(s[s.length - 1]).toEqual(zig[zig.length - 1]);
  });

  it("cuts a long squiggle down to a few waypoints", () => {
    const corners: Pt[] = [];
    for (let i = 0; i < 30; i++) corners.push({ x: i * 4, y: i % 2 ? 6 : 0 });
    const s = simplifyRoute(trail(corners));
    expect(s.length).toBeLessThanOrEqual(ROUTE_DRAW.maxPoints + 1);
    expect(s.length).toBeGreaterThan(2);
  });

  it("measures a trail", () => {
    expect(trailLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
  });
});

describe("planRoute", () => {
  it("turns an L-shaped trail into its corner and end, after the start", () => {
    const p = planRoute(trail([{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }]))!;
    expect(p.loop).toBe(false);
    expect(p.points).toHaveLength(2);
    expect(near(p.points[0]!, { x: 15, y: 5 })).toBe(true);
    expect(near(p.points[1]!, { x: 15, y: 15 }, 0.01)).toBe(true);
  });

  it("a trail too short is no route", () => {
    expect(planRoute([{ x: 5, y: 5 }, { x: 5.5, y: 5.2 }])).toBeNull();
    expect(planRoute([{ x: 5, y: 5 }])).toBeNull();
  });

  it("a short straight drag is one leg", () => {
    expect(planRoute(trail([{ x: 5, y: 5 }, { x: 9, y: 5 }]))).toEqual({ points: [{ x: 9, y: 5 }], loop: false });
  });

  it("a trail back to its start is a patrol that ends on the start itself", () => {
    const start = { x: 10, y: 10 };
    const t = trail([start, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10.8, y: 10.5 }]);
    expect(closesLoop(t)).toBe(true);
    const p = planRoute(t)!;
    expect(p.loop).toBe(true);
    expect(p.points[p.points.length - 1]).toEqual(start);
    expect(p.points.length).toBeGreaterThanOrEqual(3);
  });

  it("out and back is a patrol between the far end and the start", () => {
    const start = { x: 10, y: 10 };
    const p = planRoute(trail([start, { x: 22, y: 10 }, { x: 10.5, y: 10.4 }], 0))!;
    expect(p.loop).toBe(true);
    expect(p.points).toHaveLength(2);
    expect(near(p.points[0]!, { x: 22, y: 10 })).toBe(true);
    expect(p.points[1]).toEqual(start);
  });

  it("a little circle around the start isn't a loop (it never went anywhere)", () => {
    const t = trail([{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 10.5 }]);
    expect(closesLoop(t)).toBe(false);
  });
});

describe("Controller.routeSelected", () => {
  const setup = () => {
    setLocalSide("blue");
    const w = createWorld(40, 40);
    const s = spawnUnit(w, "stinger", "blue", 5, 5);
    const h = spawnUnit(w, "harvester", "blue", 6, 5);
    const ctrl = new Controller(w);
    ctrl.selectUnits([s.id, h.id]);
    return { w, s, h, ctrl };
  };
  const pts = [{ x: 10, y: 5 }, { x: 15, y: 10 }, { x: 5, y: 12 }];

  it("sends an attack-move to the first point, then a waypoint per point; harvesters just drive", () => {
    const { s, h, ctrl } = setup();
    expect(ctrl.routeSelected(pts, false)).toBe(true);
    const cmds = ctrl.drainCommands();
    expect(cmds.map((c) => [c.type, "unitIds" in c ? c.unitIds : null])).toEqual([
      ["attackMove", [s.id]], ["waypoint", [s.id]], ["waypoint", [s.id]],
      ["move", [h.id]], ["waypoint", [h.id]], ["waypoint", [h.id]]
    ]);
    expect(ctrl.lastFeedback).toMatchObject({ kind: "move", x: 5, y: 12, route: "route" });
  });

  it("⚑ Repli makes it plain moves, once; a loop is a patrol (attack-moving, harvesters aside)", () => {
    const { ctrl } = setup();
    ctrl.forceMove = true;
    ctrl.routeSelected(pts, false);
    expect(ctrl.drainCommands()[0]!.type).toBe("move");
    expect(ctrl.forceMove).toBe(false);
    ctrl.forceMove = true;
    ctrl.routeSelected(pts, true);
    const cmds = ctrl.drainCommands();
    expect(cmds.slice(0, 3).map((c) => c.type)).toEqual(["attackMove", "waypoint", "patrol"]);
    expect(cmds.slice(3).map((c) => c.type)).toEqual(["move", "waypoint", "waypoint"]);
  });

  it("does nothing with no selection, or for a spectator", () => {
    const { ctrl } = setup();
    ctrl.clearSelection();
    expect(ctrl.routeSelected(pts, false)).toBe(false);
    ctrl.selectUnits([1]);
    ctrl.spectator = true;
    expect(ctrl.routeSelected(pts, false)).toBe(false);
    expect(ctrl.drainCommands()).toEqual([]);
  });
});
