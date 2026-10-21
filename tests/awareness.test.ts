import { describe, expect, it } from "vitest";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { isVisible, tickFog } from "../src/sim/fog";
import { Terrain, type Faction, type FxEvent, type World } from "../src/sim/types";
import { createWorld, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";
import {
  AWARE,
  BattleMeter,
  GameSpeed,
  HeatMap,
  InboundWatch,
  TEMPO,
  TempoGuard,
  calldownThreatens,
  edgePoint,
  mergeHotspots,
  parseSpeed,
  placeOnEdge,
  planTicks,
  raidAdvice,
  tallyView,
  type Rect
} from "../src/game/awareness";
import { BattleCallouts, type RadioLine } from "../src/game/callouts";
import { CameraRig } from "../src/game/three/camera";

const TICK_MS = 1000 / TICK_RATE;

const hit = (faction: Faction, id: number, building: boolean, x: number, y: number, attackerId = 0): FxEvent => ({
  type: "hit", faction, id, x, y, building, attackerId
});
const shot = (sourceId: number, x: number, y: number, tx = x + 3, ty = y): FxEvent => ({
  type: "shot", fx: "cannon", x, y, tx, ty, fromAir: false, air: false, sourceId
});

describe("game speed", () => {
  it("runs speed × real time in whole ticks, carrying the remainder", () => {
    expect(planTicks(0, 100, 1)).toEqual({ ticks: 1, acc: 0 });
    expect(planTicks(0, 100, 2)).toEqual({ ticks: 2, acc: 0 });
    const a = planTicks(0, 100, 1.5);
    expect(a.ticks).toBe(1);
    expect(a.acc).toBeCloseTo(50);
    const b = planTicks(a.acc, 100, 1.5);
    expect(b.ticks).toBe(2);
    expect(b.acc).toBeCloseTo(0);
    // over a long run the sim keeps exact pace with speed × wall time
    let acc = 0;
    let ticks = 0;
    for (let i = 0; i < 600; i++) {
      const p = planTicks(acc, 1000 / 60, 3);
      acc = p.acc;
      ticks += p.ticks;
    }
    expect(ticks).toBeGreaterThanOrEqual(299);
    expect(ticks).toBeLessThanOrEqual(300);
  });

  it("caps ticks per frame and drops the backlog instead of spiralling", () => {
    // a 1 s hitch counts as 250 ms
    expect(planTicks(0, 1000, 1).ticks).toBe(2);
    expect(planTicks(0, 1000, 1).acc).toBeCloseTo(50);
    // 4× a long frame would be 10 ticks: capped
    const p = planTicks(0, 250, 4);
    expect(p.ticks).toBe(AWARE.maxTicksPerFrame);
    expect(p.acc).toBeLessThan(TICK_MS);
    expect(planTicks(0, -5, 2).ticks).toBe(0);
  });

  it("cycles 1× → 1.5× → 2× (spectators also 4×); holding the clock is 3×", () => {
    const s = new GameSpeed(false);
    expect(s.value).toBe(1);
    expect([s.cycle(), s.cycle(), s.cycle()]).toEqual([1.5, 2, 1]);
    s.held = true;
    expect(s.value).toBe(3);
    s.held = false;
    const w = new GameSpeed(true);
    expect([w.cycle(), w.cycle(), w.cycle(), w.cycle()]).toEqual([1.5, 2, 4, 1]);
    w.cycle();
    w.cycle();
    w.cycle();
    w.held = true;
    expect(w.value).toBe(4); // holding never slows a faster setting
  });

  it("remembers the setting separately for playing and watching, tolerating junk", () => {
    const s = new GameSpeed(false);
    s.cycle();
    const raw = s.serialize();
    expect(new GameSpeed(false, raw).base).toBe(1.5);
    expect(new GameSpeed(true, raw).base).toBe(1);
    const w = new GameSpeed(true, raw);
    w.cycle();
    w.cycle();
    w.cycle();
    expect(new GameSpeed(true, w.serialize()).base).toBe(4);
    expect(new GameSpeed(false, w.serialize()).base).toBe(1.5);
    expect(parseSpeed("{bad json")).toEqual({ play: 1, watch: 1 });
    expect(parseSpeed(JSON.stringify({ play: 4, watch: 7 }))).toEqual({ play: 1, watch: 1 }); // 4× is spectator-only
    expect(parseSpeed(null)).toEqual({ play: 1, watch: 1 });
  });
});

describe("hotspots", () => {
  const rig = (spectator = false) => {
    const w = createWorld(64, 64);
    const heat = new HeatMap({ world: w, player: "blue", spectator });
    let t = 0;
    const tick = (...fx: FxEvent[]) => {
      t += 1 / TICK_RATE;
      heat.events(fx, t);
    };
    return { w, heat, tick, now: () => t };
  };

  it("a harvester under fire becomes a 'Harvesters' hotspot after a few hits, then cools off", () => {
    const r = rig();
    const h = spawnUnit(r.w, "harvester", "blue", 40, 40);
    r.tick(hit("blue", h.id, false, 40, 40));
    r.tick(hit("blue", h.id, false, 40, 40));
    expect(r.heat.hotspots()).toEqual([]);
    r.tick(hit("blue", h.id, false, 40, 40));
    const [s] = r.heat.hotspots();
    expect(s).toMatchObject({ kind: "defend", label: "Fardiers" });
    expect(s!.x).toBeCloseTo(40);
    // 15% decay a second: gone after ~1 s below the threshold
    for (let i = 0; i < 10 * 3; i++) r.tick();
    expect(r.heat.hotspots()).toEqual([]);
  });

  it("names a fight by the most important thing hit and ranks HQ hits first", () => {
    const r = rig();
    const hq = spawnBuilding(r.w, "hq", "blue", 4, 4);
    const fab = spawnBuilding(r.w, "fab-plant", "blue", 30, 4);
    const tank = spawnUnit(r.w, "stinger", "blue", 50, 50);
    for (let i = 0; i < 4; i++)
      r.tick(hit("blue", tank.id, false, 50, 50), hit("blue", fab.id, true, 31, 5), hit("blue", hq.id, true, 5.5, 5.5));
    // a tank hit next to the HQ doesn't rename it
    r.tick(hit("blue", tank.id, false, 6, 6));
    const spots = r.heat.hotspots();
    expect(spots.map((s) => s.label)).toEqual(["GQG !", "Base", "Unités"]);
    expect(spots.every((s) => s.kind === "defend")).toBe(true);
  });

  it("our own shots (and kills) make an amber 'Attack' hotspot; enemy hits on the enemy don't count", () => {
    const r = rig();
    const me = spawnUnit(r.w, "stinger", "blue", 20, 20);
    const foe = spawnUnit(r.w, "stinger", "red", 22, 20);
    for (let i = 0; i < 3; i++) r.tick(shot(me.id, 20, 20), hit("red", foe.id, false, 22, 20), shot(foe.id, 22, 20, 20, 20));
    expect(r.heat.hotspots()).toEqual([]);
    for (let i = 0; i < 3; i++) r.tick(shot(me.id, 20, 20));
    expect(r.heat.hotspots()).toMatchObject([{ kind: "attack", label: "Attaque" }]);
  });

  it("merges nearby cells into one hotspot", () => {
    const r = rig();
    const a = spawnUnit(r.w, "stinger", "blue", 11, 11);
    for (let i = 0; i < 3; i++) r.tick(hit("blue", a.id, false, 11, 11), hit("blue", a.id, false, 13, 13), hit("blue", a.id, false, 17, 11));
    expect(r.heat.hotspots()).toHaveLength(1);
  });

  it("spectators get every fight, as neutral 'Fight' hotspots naming whose HQ is hit", () => {
    const r = rig(true);
    const a = spawnUnit(r.w, "stinger", "red", 30, 30);
    for (let i = 0; i < 3; i++) r.tick(hit("red", a.id, false, 30, 30));
    expect(r.heat.hotspots()).toMatchObject([{ kind: "fight", label: "Combat" }]);
    const hq = spawnBuilding(r.w, "hq", "red", 4, 50);
    for (let i = 0; i < 3; i++) r.tick(hit("red", hq.id, true, 5.5, 51.5));
    expect(r.heat.hotspots().map((s) => s.label)).toContain("GQG Rouge");
  });

  it("an inbound raid already being fought shows as the fight, not twice", () => {
    const fight = { key: "c1", kind: "defend" as const, x: 10, y: 10, heat: 3, label: "Base", priority: 53 };
    const raid = { key: "i1", kind: "inbound" as const, x: 12, y: 12, heat: 1, label: "Raid", priority: 40 };
    const far = { ...raid, key: "i2", x: 40, y: 40 };
    expect(mergeHotspots([fight], [raid, far]).map((s) => s.key)).toEqual(["c1", "i2"]);
  });
});

describe("inbound warning", () => {
  /** A blue base with a harvester out at the field; returns a tick driver. */
  const rig = () => {
    const w = createWorld(64, 64);
    spawnBuilding(w, "hq", "blue", 4, 4);
    spawnUnit(w, "harvester", "blue", 20, 6);
    const watch = new InboundWatch({ world: w, player: "blue" });
    let t = 0;
    const tick = (n = 1, fx: FxEvent[] = []) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        t += 1 / TICK_RATE;
        tickFog(w);
        out.push(...watch.events(i === 0 ? fx : [], t));
      }
      return out;
    };
    return { w, watch, tick, now: () => t };
  };

  it("warns once when a visible armed group comes near, with counter advice by domain", () => {
    const r = rig();
    // in the fog, far away: nothing
    const wasps = [spawnUnit(r.w, "wasp", "red", 50, 50), spawnUnit(r.w, "wasp", "red", 51, 50)];
    expect(r.tick(5)).toEqual([]);
    // visible near the harvester (its sight is 4 tiles)
    for (const [i, u] of wasps.entries()) {
      u.x = 21 + i;
      u.y = 7;
    }
    const [wn] = r.tick();
    expect(wn).toMatchObject({ domain: "air", text: "Aéronefs ennemis en approche", short: "Aéronefs en approche", first: true, loud: true, count: 2 });
    expect(wn!.advice).toMatch(/Faucheux/);
    expect(wn!.ids.sort()).toEqual(wasps.map((u) => u.id).sort());
    // the same group hanging around: no repeat
    expect(r.tick(10 * 15)).toEqual([]);
    // gone for longer than the throttle, then back: a fresh warning (no longer the first)
    for (const u of wasps) u.x = 55;
    r.tick(10 * (AWARE.inbound.throttleS + 1));
    for (const u of wasps) u.x = 21;
    const again = r.tick();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ first: false, loud: true });
  });

  it("never reveals the fog, and ignores units that can't hurt a base", () => {
    const r = rig();
    // within 12 tiles of the HQ but outside anyone's sight
    spawnUnit(r.w, "mastodon", "red", 14, 16);
    // visible, but anti-air only / unarmed
    spawnUnit(r.w, "raptor", "red", 21, 8);
    spawnUnit(r.w, "scout", "red", 21, 7);
    expect(r.tick(20)).toEqual([]);
  });

  it("names ground raids by their lead kind, and spaces out loud warnings", () => {
    const r = rig();
    spawnUnit(r.w, "mastodon", "red", 6, 12);
    spawnUnit(r.w, "stinger", "red", 7, 12);
    const [a] = r.tick();
    expect(a).toMatchObject({ domain: "ground", text: "Creusot ennemis en approche", first: true, loud: true });
    expect(a!.advice).toMatch(/Hydroglisseurs/);
    // a second, separate group a moment later: tracked (arrow), but not shouted
    spawnUnit(r.w, "wasp", "red", 21, 8);
    const [b] = r.tick(5);
    expect(b).toMatchObject({ domain: "air", loud: false, first: false });
    expect(r.watch.hotspots(r.now()).map((h) => h.label).sort()).toEqual(["Raid", "Raid aérien"]);
    // the arrows expire
    r.tick(10 * (AWARE.inbound.arrowS + 1));
    expect(r.watch.hotspots(r.now())).toEqual([]);
  });

  it("a group that has been shooting us for a while is a fight, not a raid", () => {
    const r = rig();
    const s = spawnUnit(r.w, "stinger", "red", 40, 40);
    const h = [...r.w.units.values()].find((u) => u.kind === "harvester")!;
    // it hits us from out of the zone first (e.g. chasing a harvester home)
    r.tick(1, [hit("blue", h.id, false, 20, 6, s.id)]);
    r.tick(20, [hit("blue", h.id, false, 20, 6, s.id)]);
    r.tick(1, [hit("blue", h.id, false, 20, 6, s.id)]);
    s.x = 22;
    s.y = 7;
    expect(r.tick(1, [hit("blue", h.id, false, 20, 6, s.id)])).toEqual([]);
    // one that only just opened fire still gets its warning
    const s2 = spawnUnit(r.w, "stinger", "red", 7, 12);
    expect(r.tick(1, [hit("blue", h.id, false, 20, 6, s2.id)])).toHaveLength(1);
  });

  it("advice matches the counter web", () => {
    expect(raidAdvice("air", "hornet").advice).toMatch(/Faucheux/);
    expect(raidAdvice("ground", "mastodon").advice).toMatch(/Hydroglisseurs/);
    expect(raidAdvice("ground", "mastodon").advice).toMatch(/Artificiers/);
    expect(raidAdvice("ground", "mortar").advice).toMatch(/Panhard/);
    expect(raidAdvice("mixed", "wasp").what).toBe("force de frappe");
    expect(raidAdvice("ground", "trooper")).toEqual({ what: "pioupious", enemy: "ennemis", advice: "Canons de 75, Hotchkiss ou Chasseurs alpins" });
    expect(raidAdvice("air", "condor").what).toBe("Montgolfières");
  });

  it("a Sniper Team hidden in the woods raises no warning; a Montgolfière does, loaded or not", () => {
    const r = rig();
    // in sight of the HQ, in woods, more than 3 tiles from anything of ours
    setTerrain(r.w, 11, 6, Terrain.Forest);
    const sn = spawnUnit(r.w, "sniper", "red", 11.5, 6.5);
    r.w.tick = 100;
    expect(r.tick(3)).toEqual([]);
    expect(isVisible(r.w, "blue", 11, 6)).toBe(true);
    // what a Condor carries is hidden: an empty one warns just as a loaded one would
    const c = spawnUnit(r.w, "condor", "red", 21, 9);
    const [wn] = r.tick();
    expect(wn).toMatchObject({ domain: "air", text: "Montgolfières ennemies en approche", ids: [c.id] });
    r.w.units.delete(c.id);
    const loaded = spawnUnit(r.w, "condor", "red", 21, 9);
    const t = spawnUnit(r.w, "trooper", "red", 21, 9);
    r.w.units.delete(t.id);
    loaded.passengers!.push(t);
    const [wl] = r.tick(40);
    expect(wl).toMatchObject({ domain: "air", text: "Montgolfières ennemies en approche", ids: [loaded.id] });
    // the sniper gives itself away by firing: now it counts
    sn.firedTick = r.w.tick;
    const [ws] = r.tick();
    expect(ws).toMatchObject({ lead: "sniper", text: "Chasseurs alpins ennemis en approche" });
  });

  it("an air raid warning stands in for 'Enemy aircraft detected'", () => {
    const w = createWorld(48, 48);
    const radio: RadioLine[] = [];
    const c = new BattleCallouts({ world: w, player: "blue", spectator: false, onScreen: () => false, radio: (l) => radio.push(l), announce: () => {} });
    spawnUnit(w, "stinger", "blue", 10, 10);
    c.inbound("air", 1);
    spawnUnit(w, "wasp", "red", 11, 10);
    tickFog(w);
    c.events([], 1.5);
    expect(radio.map((l) => l.key)).not.toContain("enemy-air");
  });
});

describe("tempo safety (drop to 1× when the player must react)", () => {
  const rig = () => {
    const w = createWorld(64, 64);
    const hq = spawnBuilding(w, "hq", "blue", 4, 4);
    const tank = spawnUnit(w, "stinger", "blue", 30, 30);
    spawnBuilding(w, "hq", "red", 56, 56);
    return { w, hq, tank, guard: new TempoGuard({ world: w, player: "blue" }) };
  };
  const calldown = (faction: Faction, x: number, y: number, power: "barrage" | "hammer" = "barrage", radius = 2): FxEvent => ({
    type: "calldown", id: 1, faction, power, x, y, radius, landTick: 999
  });

  it("an enemy calldown aimed at our units or buildings drops a fast game to 1×", () => {
    const r = rig();
    expect(r.guard.check([calldown("red", 31, 30)], 10, [], true)).toMatchObject({ cause: "calldown", note: "Feu roulant ennemi en approche", x: 31, y: 30 });
    expect(r.guard.check([calldown("red", 6, 8, "hammer", 2.5)], 11, [], true)).toMatchObject({ cause: "calldown", note: "Obus Méliès ennemi en approche" });
    // far from anything of ours, or our own: no
    expect(r.guard.check([calldown("red", 45, 10)], 12, [], true)).toBeNull();
    expect(r.guard.check([calldown("blue", 31, 30)], 13, [], true)).toBeNull();
    // already at 1×: nothing to do
    expect(r.guard.check([calldown("red", 31, 30)], 14, [], false)).toBeNull();
    expect(calldownThreatens(r.w, "blue", 30, 30 + 2 + TEMPO.reach + 0.1, 2)).toBe(false);
    expect(calldownThreatens(r.w, "blue", 30, 30 + 2 + TEMPO.reach - 0.1, 2)).toBe(true);
  });

  it("the HQ coming under a new attack drops to 1×, but not every hit of the same siege", () => {
    const r = rig();
    const hqHit = (t: number, fast = true) => r.guard.check([hit("blue", r.hq.id, true, 5.5, 5.5, 99)], t, [], fast);
    expect(hqHit(20)).toMatchObject({ cause: "hq", note: "GQG attaqué" });
    // the siege goes on: the player chose to speed up again, so leave it
    expect(hqHit(25)).toBeNull();
    expect(hqHit(25 + TEMPO.hqQuietS - 1)).toBeNull();
    // a fresh attack after a quiet spell
    expect(hqHit(25 + 2 * TEMPO.hqQuietS + 1)).toMatchObject({ cause: "hq" });
    // a siege that started at 1× doesn't snap the speed back when the player speeds up mid-siege
    const s = rig();
    expect(s.guard.check([hit("blue", s.hq.id, true, 5.5, 5.5, 99)], 50, [], false)).toBeNull();
    expect(s.guard.check([hit("blue", s.hq.id, true, 5.5, 5.5, 99)], 52, [], true)).toBeNull();
    // other buildings and units don't count
    expect(s.guard.check([hit("blue", s.tank.id, false, 30, 30, 99)], 200, [], true)).toBeNull();
  });

  it("a spoken inbound warning drops to 1×; the most urgent cause wins", () => {
    const r = rig();
    const wn = {
      id: 1, domain: "air" as const, lead: "wasp" as const, count: 3, ids: [], x: 20, y: 6,
      text: "Drones ennemis en approche", short: "Drones en approche", advice: "DCA", first: false, loud: true, t: 5
    };
    expect(r.guard.check([], 5, [wn], true)).toMatchObject({ cause: "inbound", note: "Drones ennemis en approche" });
    expect(r.guard.check([], 5, [{ ...wn, loud: false }], true)).toBeNull();
    expect(r.guard.check([calldown("red", 31, 30)], 6, [wn], true)?.cause).toBe("calldown");
  });
});

describe("battle meter", () => {
  const army = (w: World, f: Faction, n: number, x: number, kind: "stinger" | "mastodon" = "stinger") =>
    Array.from({ length: n }, (_, i) => spawnUnit(w, kind, f, x, 10 + i));

  it("tallies cost × HP of armed units in view, enemies only if visible", () => {
    const w = createWorld(64, 64);
    const mine = army(w, "blue", 2, 10);
    army(w, "red", 3, 12);
    spawnUnit(w, "harvester", "blue", 11, 11); // unarmed: not counted
    spawnUnit(w, "stinger", "red", 50, 50); // out of view
    spawnBuilding(w, "turret", "blue", 9, 9);
    mine[0]!.hp = UNITS.stinger.hp / 2;
    const inView = (x: number, y: number) => x < 30 && y < 30;
    const t = tallyView(w, "blue", inView, () => true);
    expect(t.own.n).toBe(2);
    expect(t.own.value).toBeCloseTo(150 * 1.5 + 225);
    expect(t.enemy).toEqual({ n: 3, value: 450 });
    const fogged = tallyView(w, "blue", inView, (x) => x < 11);
    expect(fogged.enemy.n).toBe(0);
    // a unit the player can't see though its tile is in sight (a hidden Sniper Team) doesn't count
    const hidden = tallyView(w, "blue", inView, () => true, (u) => u.y !== 10);
    expect(hidden.enemy.n).toBe(2);
  });

  it("shows only for a real fight in view, eases toward the live share, and lingers briefly", () => {
    const m = new BattleMeter();
    const tally = (own: number, enemy: number, n = 2) => ({ own: { n, value: own }, enemy: { n, value: enemy } });
    expect(m.update(tally(300, 300, 1), 0, 0.1, 16).shown).toBe(false); // one unit a side
    expect(m.update(tally(300, 300), -10, 0.2, 16).shown).toBe(false); // no shots lately
    const a = m.update(tally(600, 200), 0.2, 0.3, 16);
    expect(a.shown).toBe(true);
    expect(a.share).toBeCloseTo(0.75); // appears at the live share
    let v = a;
    for (let i = 0; i < 60; i++) v = m.update(tally(200, 600), 0.3 + i * 0.1, 0.4 + i * 0.1, 16);
    expect(v.share).toBeLessThan(0.3);
    // the fight leaves the view: lingers, then hides
    const t0 = 6.4;
    expect(m.update(tally(0, 0, 0), 0, t0 + 1, 16).shown).toBe(true);
    expect(m.update(tally(0, 0, 0), 0, t0 + AWARE.meter.lingerS + 0.5, 16).shown).toBe(false);
  });

  it("flashes a turning point on a big swing, not on a pan", () => {
    const tally = (own: number, enemy: number) => ({ own: { n: 3, value: own }, enemy: { n: 3, value: enemy } });
    const run = (jump: boolean) => {
      const m = new BattleMeter();
      const turns: string[] = [];
      for (let i = 0; i < 30; i++) {
        const t = i * 0.1;
        const v = m.update(tally(500, 500), t, t, 16);
        if (v.turning) turns.push(v.turning);
      }
      for (let i = 30; i < 50; i++) {
        const t = i * 0.1;
        const v = m.update(tally(150, 500), t, t, 16, jump && i === 30);
        if (v.turning) turns.push(v.turning);
        if (jump) {
          // keep jumping: every sample after a pan restarts the history
          const w = m.update(tally(150, 500), t + 0.01, t + 0.01, 1, true);
          if (w.turning) turns.push(w.turning);
        }
      }
      return turns;
    };
    expect(run(false)).toEqual(["down"]);
    expect(run(true)).toEqual([]);
  });
});

describe("edge arrows geometry", () => {
  const R: Rect = { x0: 30, y0: 150, x1: 360, y1: 620 };

  it("puts the marker where the ray from the centre leaves the rect", () => {
    const c = { x: (R.x0 + R.x1) / 2, y: (R.y0 + R.y1) / 2 };
    const right = edgePoint(R, 2000, c.y);
    expect(right.x).toBeCloseTo(R.x1);
    expect(right.y).toBeCloseTo(c.y);
    expect(right.angle).toBeCloseTo(0);
    const up = edgePoint(R, c.x, -5000);
    expect(up.y).toBeCloseTo(R.y0);
    const corner = edgePoint(R, -1e4, 1e4);
    expect(corner.x === R.x0 || corner.y === R.y1).toBe(true);
  });

  it("slides along the edge past HUD widgets, and gives up when boxed in", () => {
    const p = { x: R.x1, y: 300 };
    expect(placeOnEdge(R, p, 46, [])).toEqual(p);
    const widget: Rect = { x0: 300, y0: 260, x1: 400, y1: 340 };
    const q = placeOnEdge(R, p, 46, [widget])!;
    expect(q.x).toBeCloseTo(R.x1);
    expect(q.y < 260 - 23 || q.y > 340 + 23).toBe(true);
    expect(Math.abs(q.y - 300)).toBeLessThan(80);
    const all: Rect = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
    expect(placeOnEdge(R, p, 46, [all], 200)).toBeNull();
  });

  it("points south at a fight behind the camera (the far side of a 96-tile map)", () => {
    const rig = new CameraRig();
    rig.bounds = { x0: -2, y0: -2, x1: 98, y1: 98 };
    rig.zoom = 42;
    rig.setViewport(390, 844);
    rig.centerOn(48, 10);
    const c = { x: (R.x0 + R.x1) / 2, y: (R.y0 + R.y1) / 2 };
    const aim = (x: number, y: number) => {
      const q = rig.toward(x, y, c.x, c.y);
      return Math.atan2(q.y - c.y, q.x - c.x);
    };
    // the tilted camera can't see this far south: project() mirrors these up past the horizon
    for (const x of [8, 48, 90]) expect(rig.project(x, 92).behind).toBe(true);
    expect(aim(48, 92)).toBeCloseTo(Math.PI / 2, 1);
    const se = aim(90, 92);
    expect(se > 0 && se < Math.PI / 2).toBe(true);
    const sw = aim(8, 92);
    expect(sw > Math.PI / 2 && sw < Math.PI).toBe(true);
    // the marker goes on the bottom edge, and the direction doesn't jump across the camera plane
    const q = rig.toward(48, 92, c.x, c.y);
    expect(edgePoint(R, q.x, q.y).y).toBeCloseTo(R.y1);
    let y = 60;
    while (!rig.project(70, y).behind) y += 0.5;
    expect(rig.project(70, y - 0.5).behind).toBe(false);
    expect(Math.abs(aim(70, y) - aim(70, y - 0.5))).toBeLessThan(0.05);
    // a point the camera can see comes back as drawn
    const seen = rig.project(60, 20);
    expect(rig.toward(60, 20, c.x, c.y)).toEqual({ x: seen.x, y: seen.y });
  });
});
