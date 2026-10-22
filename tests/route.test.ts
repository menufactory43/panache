import { describe, expect, it } from "vitest";
import { worldHash } from "../src/sim/checksum";
import { ROUTE_MAX, ROUTE_PASS } from "../src/sim/route";
import { step } from "../src/sim/sim";
import type { Command, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";

const run = (w: World, n: number, first: Command[] = []) => {
  step(w, first);
  for (let i = 1; i < n; i++) step(w, []);
};
const route = (ids: number[], pts: [number, number][], opts: { move?: boolean; patrol?: boolean } = {}): Command[] => {
  const [[x0, y0], ...rest] = pts as [[number, number], ...[number, number][]];
  const cmds: Command[] = [{ type: opts.move ? "move" : "attackMove", faction: "blue", unitIds: ids, x: x0, y: y0 }];
  rest.forEach(([x, y], i) => {
    const last = i === rest.length - 1;
    cmds.push({ type: last && opts.patrol ? "patrol" : "waypoint", faction: "blue", unitIds: ids, x, y });
  });
  return cmds;
};

describe("routes (waypoint queue)", () => {
  it("follows the points in order, then stops at the last", () => {
    const w = createWorld(40, 40);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    step(w, route([u.id], [[20.5, 5.5], [20.5, 20.5], [5.5, 20.5]]));
    expect(u.order).toMatchObject({ type: "attackMove", x: 20.5, y: 5.5 });
    expect(u.route?.pts).toEqual([{ x: 20.5, y: 20.5 }, { x: 5.5, y: 20.5 }]);
    // the unit visits each corner in turn: x first grows, then y, then x shrinks
    let maxX = 0;
    let sawCorner2 = false;
    for (let i = 0; i < 2000 && u.order.type !== "idle"; i++) {
      step(w, []);
      maxX = Math.max(maxX, u.x);
      if (u.y > 18) sawCorner2 = true;
    }
    expect(maxX).toBeGreaterThan(20.5 - ROUTE_PASS - 0.5);
    expect(sawCorner2).toBe(true);
    expect(u.order.type).toBe("idle");
    expect(Math.hypot(u.x - 5.5, u.y - 20.5)).toBeLessThan(1);
    expect(u.route).toBeUndefined();
  });

  it("keeps plain moves for a route that began with one (⚑ Repli)", () => {
    const w = createWorld(40, 40);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    step(w, route([u.id], [[10.5, 5.5], [20.5, 5.5]], { move: true }));
    expect(u.route).toMatchObject({ move: true, loop: false });
    run(w, 400);
    expect(u.order.type).toBe("idle");
    expect(Math.hypot(u.x - 20.5, u.y - 5.5)).toBeLessThan(1);
  });

  it("a waypoint sets an idle unit off at once", () => {
    const w = createWorld(30, 30);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    step(w, [{ type: "waypoint", faction: "blue", unitIds: [u.id], x: 15.5, y: 5.5 }]);
    expect(u.order).toMatchObject({ type: "attackMove", x: 15.5, y: 5.5 });
    expect(u.route).toBeUndefined();
  });

  it("any other order drops the route", () => {
    const w = createWorld(40, 40);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    step(w, route([u.id], [[20.5, 5.5], [20.5, 20.5]]));
    expect(u.route).toBeDefined();
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 8.5, y: 8.5 }]);
    expect(u.route).toBeUndefined();
    step(w, route([u.id], [[20.5, 5.5], [20.5, 20.5]]));
    step(w, [{ type: "stop", faction: "blue", unitIds: [u.id] }]);
    expect(u.route).toBeUndefined();
  });

  it("skips a point too close to the one before it, and caps the queue", () => {
    const w = createWorld(64, 64);
    const u = spawnUnit(w, "scout", "blue", 2.5, 2.5);
    step(w, route([u.id], [[10.5, 10.5], [11, 10.5]]));
    expect(u.route).toBeUndefined();
    const many: [number, number][] = Array.from({ length: ROUTE_MAX + 6 }, (_, i) => [3.5 + i * 3, 30.5]);
    step(w, route([u.id], many));
    expect(u.route!.pts.length).toBe(ROUTE_MAX);
  });

  it("ignores the other side's units", () => {
    const w = createWorld(30, 30);
    const u = spawnUnit(w, "scout", "red", 5.5, 5.5);
    step(w, [{ type: "waypoint", faction: "blue", unitIds: [u.id], x: 15.5, y: 5.5 }]);
    expect(u.order.type).toBe("idle");
  });

  it("drops a route whose next point can't be reached instead of searching for ever", () => {
    const w = createWorld(30, 30);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    // (off the map: no path)
    step(w, route([u.id], [[8.5, 5.5], [-20, -20], [20.5, 5.5]]));
    run(w, 600);
    expect(u.order.type).toBe("idle");
    expect(u.route).toBeUndefined();
  });
});

describe("patrols", () => {
  it("goes back and forth between where it stood and the point, for ever", () => {
    const w = createWorld(40, 40);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    step(w, [{ type: "patrol", faction: "blue", unitIds: [u.id], x: 25.5, y: 5.5 }]);
    expect(u.order).toMatchObject({ type: "attackMove", x: 25.5, y: 5.5 });
    expect(u.route).toEqual({ pts: [{ x: 5.5, y: 5.5 }], move: false, loop: true });
    // count the turns at each end over a long while
    let turns = 0;
    let goal = (u.order as { x: number }).x;
    for (let i = 0; i < 3000; i++) {
      step(w, []);
      const o = u.order as { type: string; x: number };
      expect(o.type).toBe("attackMove");
      if (o.x !== goal) {
        turns++;
        goal = o.x;
      }
    }
    expect(turns).toBeGreaterThanOrEqual(4);
    expect(u.x).toBeGreaterThan(2);
    expect(u.x).toBeLessThan(28);
  });

  it("closes a drawn route into a loop, attack-moving even after ⚑ Repli", () => {
    const w = createWorld(40, 40);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    step(w, route([u.id], [[20.5, 5.5], [20.5, 20.5], [5.5, 20.5]], { move: true, patrol: true }));
    expect(u.order.type).toBe("attackMove");
    expect(u.route).toMatchObject({ loop: true, move: false });
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      step(w, []);
      const o = u.order as { x: number; y: number };
      seen.add(`${o.x},${o.y}`);
    }
    expect(seen).toEqual(new Set(["20.5,5.5", "20.5,20.5", "5.5,20.5"]));
  });

  it("patrolling units fight what they meet, then walk on", () => {
    const w = createWorld(40, 20);
    const u = spawnUnit(w, "stinger", "blue", 5.5, 10.5);
    const foe = spawnUnit(w, "harvester", "red", 18.5, 10.5);
    step(w, [{ type: "patrol", faction: "blue", unitIds: [u.id], x: 30.5, y: 10.5 }]);
    let farthest = 0;
    for (let i = 0; i < 1500; i++) {
      step(w, []);
      farthest = Math.max(farthest, u.x);
    }
    expect(w.units.has(foe.id)).toBe(false);
    expect(farthest).toBeGreaterThan(28 - ROUTE_PASS);
    expect(u.route?.loop).toBe(true);
  });

  it("harvesters never patrol", () => {
    const w = createWorld(30, 30);
    const h = spawnUnit(w, "harvester", "blue", 5.5, 5.5);
    step(w, [{ type: "patrol", faction: "blue", unitIds: [h.id], x: 15.5, y: 5.5 }]);
    expect(h.order).toMatchObject({ type: "move", x: 15.5, y: 5.5 });
    expect(h.route).toBeUndefined();
  });
});

describe("route hashing", () => {
  it("leaves a world without routes hashing as before, and tells routes apart", () => {
    const mk = () => {
      const w = createWorld(30, 30);
      spawnUnit(w, "scout", "blue", 5.5, 5.5);
      return w;
    };
    const a = mk();
    const b = mk();
    const u = [...a.units.values()][0]!;
    const v = [...b.units.values()][0]!;
    step(a, [{ type: "attackMove", faction: "blue", unitIds: [u.id], x: 20.5, y: 5.5 }]);
    step(b, [{ type: "attackMove", faction: "blue", unitIds: [v.id], x: 20.5, y: 5.5 }]);
    expect(worldHash(a)).toBe(worldHash(b));
    const before = worldHash(b);
    v.route = { pts: [{ x: 20.5, y: 20.5 }], move: false, loop: false };
    expect(worldHash(b)).not.toBe(before);
    delete v.route;
    expect(worldHash(b)).toBe(before);
  });

  it("replays the same route to the same world", () => {
    const play = () => {
      const w = createWorld(40, 40);
      const ids = [spawnUnit(w, "scout", "blue", 5.5, 5.5).id, spawnUnit(w, "stinger", "blue", 6.5, 5.5).id];
      step(w, route(ids, [[20.5, 5.5], [20.5, 20.5], [8.5, 18.5]], { patrol: true }));
      run(w, 900);
      return worldHash(w);
    };
    expect(play()).toBe(play());
  });
});
