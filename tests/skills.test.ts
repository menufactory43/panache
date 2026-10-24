/**
 * Unit skills (src/sim/skills.ts): each one's effect and clock, the battery's
 * deploy and pack-up, the snipe's walk and shot, what a nation's unit
 * inherits, and the duel's codec.
 */
import { describe, expect, it } from "vitest";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { SKILLS, skillOf, skillReady, unitStats } from "../src/sim/skills";
import { step } from "../src/sim/sim";
import type { Command, SkillId, Unit, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";
import { BitReader, BitWriter, canonicalize, decodeCommands, encodeCommands } from "../src/versus/codec";

const skill = (units: Unit[], id: SkillId, targetId?: number): Command => ({ type: "skill", faction: "blue", unitIds: units.map((u) => u.id), skill: id, ...(targetId !== undefined ? { targetId } : {}) });
const run = (w: World, n: number) => {
  for (let i = 0; i < n; i++) step(w, []);
};
const S = (s: number) => Math.round(s * TICK_RATE);

describe("unit skills", () => {
  it("belong to six kinds, and a nation's unit takes its model's", () => {
    expect(["trooper", "stinger", "mortar", "sniper", "mastodon", "flak-crawler"].map((k) => skillOf(k as never))).toEqual(["bayonet", "throttle", "battery", "snipe", "charge", "barrage"]);
    expect(skillOf("fusiliers")).toBe("bayonet");
    expect(skillOf("carabiniers")).toBe("snipe");
    expect(skillOf("harvester")).toBeNull();
    expect(skillOf("goliath")).toBeNull();
  });

  it("Baïonnette !: faster fire for a while, at a share of health, then a cooldown", () => {
    const w = createWorld(30, 30);
    const u = spawnUnit(w, "trooper", "blue", 5.5, 5.5);
    const hp = u.hp;
    step(w, [skill([u], "bayonet")]);
    expect(u.hp).toBeCloseTo(hp - UNITS.trooper.hp * SKILLS.bayonet.hpCost);
    expect(skillReady(w, u)).toBe(false);
    // the enemy close by: the shots come faster than without
    const shotsWith = (on: boolean) => {
      const w2 = createWorld(30, 30);
      const a = spawnUnit(w2, "trooper", "blue", 5.5, 5.5);
      const t = spawnUnit(w2, "harvester", "red", 7.5, 5.5);
      t.hp = 1e6;
      if (on) step(w2, [skill([a], "bayonet")]);
      let shots = 0;
      for (let i = 0; i < S(5); i++) {
        step(w2, []);
        shots += w2.fx.filter((e) => e.type === "shot" && e.sourceId === a.id).length;
      }
      return shots;
    };
    expect(shotsWith(true)).toBeGreaterThan(shotsWith(false) * 1.2); // (ticks round the faster cooldown)
    // back in 20 s
    run(w, S(SKILLS.bayonet.cooldownS));
    expect(skillReady(w, u)).toBe(true);
  });

  it("Plein gaz: a Panhard covers more ground for a while", () => {
    const dist = (on: boolean) => {
      const w = createWorld(60, 20);
      const u = spawnUnit(w, "stinger", "blue", 5.5, 10.5);
      step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 55.5, y: 10.5 }, ...(on ? [skill([u], "throttle")] : [])]);
      run(w, S(3));
      return u.x;
    };
    expect(dist(true) - 5.5).toBeGreaterThan((dist(false) - 5.5) * 1.4);
  });

  it("Mise en batterie: dug in, out-ranging, and packing up before it moves", () => {
    const w = createWorld(40, 40);
    const u = spawnUnit(w, "mortar", "blue", 10.5, 10.5);
    step(w, [skill([u], "battery")]);
    expect(u.skill?.battery).toBe("deploying");
    run(w, S(SKILLS.battery.shiftS));
    expect(u.skill?.battery).toBe("on");
    expect(unitStats(u).range).toBe(UNITS.mortar.range + SKILLS.battery.range);
    // a target past its usual reach, inside the battery's
    const t = spawnUnit(w, "stinger", "red", 10.5 + UNITS.mortar.range + 2, 10.5);
    t.hp = 1e6;
    let fired = false;
    for (let i = 0; i < S(6); i++) {
      step(w, []);
      if (w.fx.some((e) => e.type === "shot" && e.sourceId === u.id)) fired = true;
    }
    expect(fired).toBe(true);
    // a move packs it up first: it stays put for the pack-up, then goes
    w.units.delete(t.id);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 30.5, y: 10.5 }]);
    expect(u.skill?.battery).toBe("packing");
    run(w, S(SKILLS.battery.shiftS) - 2);
    expect(u.x).toBe(10.5);
    run(w, S(3));
    expect(u.skill?.battery).toBe("off");
    expect(u.x).toBeGreaterThan(11);
  });

  it("a second battery tap with all deployed packs them up", () => {
    const w = createWorld(40, 40);
    const a = spawnUnit(w, "mortar", "blue", 10.5, 10.5);
    const b = spawnUnit(w, "mortar", "blue", 12.5, 10.5);
    step(w, [skill([a, b], "battery")]);
    run(w, S(SKILLS.battery.shiftS));
    step(w, [skill([a, b], "battery")]);
    expect([a.skill?.battery, b.skill?.battery]).toEqual(["packing", "packing"]);
  });

  it("Tir de précision: walks up if it must, then one heavy shot", () => {
    const w = createWorld(50, 20);
    const s = spawnUnit(w, "sniper", "blue", 5.5, 10.5);
    const t = spawnUnit(w, "mastodon", "red", 25.5, 10.5);
    const hp = t.hp;
    step(w, [skill([s], "snipe", t.id)]);
    expect(s.order).toMatchObject({ type: "attack", targetId: t.id });
    for (let i = 0; i < S(20) && t.hp === hp; i++) step(w, []);
    expect(hp - t.hp).toBeGreaterThanOrEqual(SKILLS.snipe.damage);
    expect(skillReady(w, s)).toBe(false);
  });

  it("Charge: a burst at the nearest enemy, and none with nobody near", () => {
    const w = createWorld(40, 20);
    const c = spawnUnit(w, "mastodon", "blue", 5.5, 10.5);
    step(w, [skill([c], "charge")]);
    expect(skillReady(w, c)).toBe(true); // (nobody in reach: still charged)
    const e = spawnUnit(w, "trooper", "red", 10.5, 10.5);
    step(w, [skill([c], "charge")]);
    expect(c.order).toMatchObject({ type: "attack", targetId: e.id });
    expect(skillReady(w, c)).toBe(false);
  });

  it("Barrage antiaérien: faster at aircraft only", () => {
    const shots = (on: boolean, air: boolean) => {
      const w = createWorld(30, 30);
      const f = spawnUnit(w, "flak-crawler", "blue", 5.5, 5.5);
      const t = spawnUnit(w, air ? "scout" : "harvester", "red", 8.5, 5.5);
      t.hp = 1e6;
      if (on) step(w, [skill([f], "barrage")]);
      let n = 0;
      for (let i = 0; i < S(4); i++) {
        step(w, []);
        n += w.fx.filter((e) => e.type === "shot" && e.sourceId === f.id).length;
      }
      return n;
    };
    expect(shots(true, true)).toBeGreaterThan(shots(false, true) * 1.3); // (ticks round the faster cooldown)
    expect(shots(true, false)).toBe(shots(false, false));
  });

  it("ignores units without the skill, or the other side's", () => {
    const w = createWorld(30, 30);
    const h = spawnUnit(w, "harvester", "blue", 5.5, 5.5);
    const r = spawnUnit(w, "trooper", "red", 9.5, 5.5);
    step(w, [skill([h], "bayonet"), skill([r], "bayonet")]);
    expect(h.skill).toBeUndefined();
    expect(r.skill).toBeUndefined();
  });

  it("replays the same, and leaves worlds that never used one hashed as before", () => {
    const go = () => {
      const w = createWorld(40, 40);
      const u = spawnUnit(w, "trooper", "blue", 5.5, 5.5);
      spawnUnit(w, "stinger", "red", 9.5, 5.5);
      step(w, [skill([u], "bayonet")]);
      run(w, 50);
      return worldHash(w);
    };
    expect(go()).toBe(go());
    const w = createWorld(40, 40);
    spawnUnit(w, "trooper", "blue", 5.5, 5.5);
    const before = worldHash(w);
    run(w, 1);
    expect(w.units.values().next().value!.skill).toBeUndefined();
    expect(typeof before).toBe("string");
  });

  it("goes through the duel's codec, with and without a target", () => {
    const ctx = { width: 64, height: 64, local: "blue" as const };
    const cmds = [
      ...canonicalize({ type: "skill", faction: "blue", unitIds: [9, 3], skill: "bayonet" }, ctx),
      ...canonicalize({ type: "skill", faction: "blue", unitIds: [12], skill: "snipe", targetId: 400 }, ctx)
    ];
    const wr = new BitWriter();
    encodeCommands(wr, cmds, ctx);
    expect(decodeCommands(new BitReader(wr.bytes(), wr.nbits), cmds.length, ctx, "blue")).toEqual([
      { type: "skill", faction: "blue", unitIds: [3, 9], skill: "bayonet" },
      { type: "skill", faction: "blue", unitIds: [12], skill: "snipe", targetId: 400 }
    ]);
  });
});

describe("the skill buttons' Controller", () => {
  it("one tap uses a skill for the selection; the snipe is aimed, and the nearest ready marksman fires", async () => {
    const { Controller } = await import("../src/game/controller");
    const w = createWorld(40, 40);
    const a = spawnUnit(w, "trooper", "blue", 5.5, 5.5);
    const b = spawnUnit(w, "trooper", "blue", 6.5, 5.5);
    const far = spawnUnit(w, "sniper", "blue", 5.5, 15.5);
    const near = spawnUnit(w, "sniper", "blue", 12.5, 5.5);
    const enemy = spawnUnit(w, "stinger", "red", 16.5, 5.5);
    const ctrl = new Controller(w);
    ctrl.selectUnits([a.id, b.id, far.id, near.id]);
    ctrl.useSkill("bayonet");
    expect(ctrl.drainCommands()).toEqual([{ type: "skill", faction: "blue", unitIds: [a.id, b.id], skill: "bayonet" }]);
    // the snipe: armed by the button, fired by the tap on the enemy
    ctrl.useSkill("snipe");
    expect(ctrl.aiming).toBe("snipe");
    expect(ctrl.drainCommands()).toEqual([]);
    ctrl.tapWorld(enemy.x, enemy.y, { kind: "enemy", id: enemy.id, targetsAir: false });
    expect(ctrl.aiming).toBeNull();
    expect(ctrl.drainCommands()).toEqual([{ type: "skill", faction: "blue", unitIds: [near.id], skill: "snipe", targetId: enemy.id }]);
    // a tap on the ground puts an armed snipe away, with no order
    ctrl.useSkill("snipe");
    ctrl.tapWorld(20.5, 20.5, { kind: "ground" });
    expect(ctrl.aiming).toBeNull();
    expect(ctrl.drainCommands()).toEqual([]);
  });
});
