import { describe, expect, it } from "vitest";
import { tickAi } from "../src/sim/ai/commander";
import { BUILDINGS, TERRAIN, TICK_RATE } from "../src/sim/balance";
import { buildingBlocker, unitBlocker } from "../src/sim/economy";
import { createMapWorld } from "../src/sim/maps";
import {
  OPS,
  OPS_OPEN_AT_START,
  evalGoal,
  goalText,
  nextOp,
  opAiState,
  opById,
  opStatus,
  opsUnlocked,
  starsNow,
  type Goal
} from "../src/sim/ops";
import { step } from "../src/sim/sim";
import type { World } from "../src/sim/types";
import { hqOf, spawnUnit, terrainAt } from "../src/sim/world";
import { applyResult, emptyCareer, opUnlocked, opsCompleted, type MatchResult } from "../src/game/career";
import { PILOTS, idlePilot, runOp } from "./ops-pilots";

const opWorld = (id: string, seed = 3) => createMapWorld(opById(id)!.map, { op: id, seed });

/** Run with the op's enemy commander and nobody on blue. */
function idle(w: World, secs: number): void {
  const red = opAiState(opById(w.ops!.id)!, 5);
  for (let i = 0; i < secs * TICK_RATE && !w.winner; i++) step(w, red ? tickAi(w, "red", red) : []);
}

describe("Ops: setup", () => {
  it("leaves ordinary matches alone", () => {
    const w = createMapWorld("riverlands", { seed: 3 });
    expect(w.ops).toBeFalsy();
    expect(w.rules).toBeFalsy();
  });

  it("has 6–8 ops with unique ids, real maps and two star conditions each", () => {
    expect(OPS.length).toBeGreaterThanOrEqual(6);
    expect(OPS.length).toBeLessThanOrEqual(8);
    expect(new Set(OPS.map((o) => o.id)).size).toBe(OPS.length);
    for (const op of OPS) {
      expect(op.goals.length).toBeGreaterThan(0);
      expect(op.stars).toHaveLength(2);
      expect(op.goals.some((g) => ["destroyHq", "destroy", "survive", "waves", "deliver"].includes(g.type))).toBe(true);
      for (const g of [...op.goals, ...op.stars]) expect(goalText(g).length).toBeGreaterThan(3);
      expect(createMapWorld(op.map).mapId).toBe(op.map);
    }
  });

  for (const op of OPS)
    it(`${op.id}: places everything on legal ground and runs 60 s without errors`, () => {
      const w = opWorld(op.id);
      expect(w.ops?.id).toBe(op.id);
      expect(hqOf(w, "blue")).not.toBeNull();
      for (const b of w.buildings.values()) {
        const size = BUILDINGS[b.kind].size;
        for (let dy = 0; dy < size; dy++)
          for (let dx = 0; dx < size; dx++) {
            expect(TERRAIN[terrainAt(w, b.tx + dx, b.ty + dy)].buildable).toBe(true);
            expect(w.occupancy[(b.ty + dy) * w.width + b.tx + dx]).toBe(b.id);
          }
      }
      for (const ids of Object.values(w.ops!.tags))
        for (const id of ids) expect(w.units.has(id) || w.buildings.has(id)).toBe(true);
      idle(w, 60);
      const st = opStatus(w)!;
      expect(st.op.id).toBe(op.id);
      for (const g of [...st.goals, ...st.stars]) {
        expect(g.eval.value).not.toMatch(/NaN|undefined/);
        expect(Number.isFinite(g.eval.progress)).toBe(true);
      }
      for (const u of w.units.values()) expect(Number.isFinite(u.x) && Number.isFinite(u.y)).toBe(true);
    });
});

describe("Ops: rules", () => {
  it("bans the player's kinds without binding the enemy commander", () => {
    const w = opWorld("sky-pirates");
    expect(buildingBlocker(w, "blue", "fab-plant")).toBe("Désactivé dans cette op");
    expect(buildingBlocker(w, "red", "fab-plant")).toBeNull();
    expect(unitBlocker(w, "blue", "raptor")).toBeNull();
    // ground units banned: so is the Condor that would fly the starting squad into the fight
    expect(unitBlocker(w, "blue", "condor")).toBe("Désactivé dans cette op");
  });

  it("Decapitation: no production of any kind, and no income", () => {
    const w = opWorld("decapitation");
    expect(unitBlocker(w, "blue", "harvester")).toBe("Désactivé dans cette op");
    expect(buildingBlocker(w, "blue", "turret")).toBe("Désactivé dans cette op");
    idle(w, 20);
    expect(w.factions.blue.scrap).toBe(0);
  });

  it("Frozen Assets: the bank never grows (no harvesters, no HQ trickle)", () => {
    const w = opWorld("frozen-assets");
    expect([...w.units.values()].some((u) => u.faction === "blue" && u.kind === "harvester")).toBe(false);
    const bank = w.factions.blue.scrap;
    idle(w, 30);
    expect(w.factions.blue.scrap).toBe(bank);
    expect(w.factions.red.scrap).not.toBe(600);
  });

  it("Glass Jaw runs its mutators for both sides", () => {
    const w = opWorld("glass-jaw");
    expect(w.rules?.dmgMult).toBe(2);
    expect(w.rules?.buildSpeed).toBe(2);
  });

  it("Last Light: the wave director paces itself for the op", () => {
    const w = opWorld("last-light");
    expect(w.survival).toBeTruthy();
    expect(hqOf(w, "red")).toBeNull();
    expect(w.survival!.nextWaveTick).toBe(45 * TICK_RATE);
    expect(w.survival!.interval).toBe(40);
    expect(w.factions.blue.scrap).toBe(1200);
  });
});

describe("Ops: goals", () => {
  it("survive and within count the clock", () => {
    const w = opWorld("bridgehead");
    const st = w.ops!;
    const hold: Goal = { type: "survive", secs: 10 };
    const fast: Goal = { type: "within", secs: 10 };
    expect(evalGoal(w, st, hold).state).toBe("pending");
    expect(evalGoal(w, st, hold).value).toBe("0:10");
    w.tick = 10 * TICK_RATE;
    expect(evalGoal(w, st, hold).state).toBe("done");
    expect(evalGoal(w, st, fast).state).toBe("ok");
    w.tick = 11 * TICK_RATE;
    expect(evalGoal(w, st, fast).state).toBe("failed");
  });

  it("protect tracks the tagged group; maxLosses and destroy count deaths by kind", () => {
    const w = opWorld("bridgehead");
    const st = w.ops!;
    const [a, b] = st.tags.bridge!;
    const both: Goal = { type: "protect", tag: "bridge", min: 2, label: "Both" };
    expect(evalGoal(w, st, both)).toMatchObject({ state: "ok", value: "2/2" });
    w.buildings.get(a!)!.hp = 0;
    step(w, []);
    expect(evalGoal(w, st, both)).toMatchObject({ state: "failed", value: "1/2" });
    expect(st.lastTagDeath).not.toBeNull();
    expect(w.buildings.has(b!)).toBe(true);
    // losses and kills by kind
    const t = spawnUnit(w, "mastodon", "red", 20, 40);
    t.hp = 0;
    const s = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "stinger")!;
    s.hp = 0;
    step(w, []);
    expect(st.killed.mastodon).toBe(1);
    expect(st.lost.stinger).toBe(1);
    expect(evalGoal(w, st, { type: "destroy", kind: "mastodon", count: 2 })).toMatchObject({ state: "pending", value: "1/2" });
    expect(evalGoal(w, st, { type: "maxLosses", n: 0 }).state).toBe("failed");
    expect(evalGoal(w, st, { type: "maxLosses", n: 1, kind: "stinger" }).state).toBe("ok");
    expect(evalGoal(w, st, { type: "maxLosses", n: 0, buildings: true }).state).toBe("failed");
  });

  it("deliver reads harvested scrap; destroyHq the enemy HQ", () => {
    const w = opWorld("harvest-moon");
    const st = w.ops!;
    w.factions.blue.stats.scrapHarvested = 2500;
    expect(evalGoal(w, st, { type: "deliver", scrap: 10000 })).toMatchObject({ state: "pending", value: "2\u202f500/10\u202f000" });
    expect(evalGoal(w, st, { type: "destroyHq" }).state).toBe("pending");
  });

  it("completing the goals wins the op with stars, through the normal winner flag", () => {
    const w = opWorld("bridgehead");
    w.tick = 240 * TICK_RATE; // goals are checked on whole seconds
    step(w, []);
    expect(w.winner).toBe("blue");
    const r = w.ops!.result!;
    expect(r).toMatchObject({ won: true, reason: "Tenu 4:00", byGoal: true, stars: 7 });
    // the sim stops at the winner
    const t = w.tick;
    step(w, []);
    expect(w.tick).toBe(t);
  });

  it("breaking a condition loses it; a broken star condition is remembered", () => {
    const w = opWorld("bridgehead");
    for (const id of w.ops!.tags.bridge!) w.buildings.get(id)!.hp = 0;
    w.tick = 10;
    step(w, []);
    expect(w.winner).toBe("red");
    expect(w.ops!.result).toMatchObject({ won: false, reason: "Hotchkiss du pont perdues", stars: 0, byGoal: true });
    expect(w.ops!.starsLost & 4).toBe(4);
  });

  it("an HQ kill ends the op the classic way (no goal ending)", () => {
    const w = opWorld("glass-jaw");
    hqOf(w, "red")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("blue");
    expect(w.ops!.result).toMatchObject({ won: true, reason: "GQG ennemi détruit", byGoal: false });
    expect(starsNow(w, opById("glass-jaw")!, w.ops!) & 1).toBe(1);
    const lost = opWorld("glass-jaw");
    hqOf(lost, "blue")!.hp = 0;
    step(lost, []);
    expect(lost.ops!.result).toMatchObject({ won: false, reason: "Notre GQG est tombé" });
  });

  it("running out of time fails a timed op", () => {
    const w = opWorld("decapitation");
    w.tick = 181 * TICK_RATE;
    step(w, []);
    expect(w.winner).toBe("red");
    expect(w.ops!.result?.reason).toBe("Temps écoulé");
  });
});

describe("Ops: every op is beatable, and none is won by doing nothing", () => {
  for (const op of OPS)
    it(`${op.id}`, () => {
      // a pilot that wins on any of the first three seeds counts: one fixed
      // seed of a knife-edge op flips on any small change to unit pathing
      const pilots = Object.entries(PILOTS[op.id]!).filter(([n]) => n !== "idle");
      const firstWin = (p: (typeof pilots)[number][1]) => {
        let run = runOp(op.id, p, 1);
        for (let seed = 2; seed <= 3 && !run.result?.won; seed++) run = runOp(op.id, p, seed);
        return run;
      };
      const wins = pilots.map(([name, p]) => ({ name, run: firstWin(p) })).filter((r) => r.run.result?.won);
      expect(wins.length, `no pilot completed ${op.id}`).toBeGreaterThan(0);
      // at least one pilot earns more than the completion star
      expect(Math.max(...wins.map((r) => r.run.result!.stars))).toBeGreaterThan(1);
      const lazy = runOp(op.id, idlePilot, 1);
      expect(lazy.result?.won).toBe(false);
    }, 30_000);

  it("replays identically from the same seed", () => {
    const a = runOp("decapitation", PILOTS.decapitation!.strike!, 4);
    const b = runOp("decapitation", PILOTS.decapitation!.strike!, 4);
    expect(a.result).toEqual(b.result);
    expect(a.world.tick).toBe(b.world.tick);
  });
});

describe("Ops: campaign progress", () => {
  it("opens three ops, then one more per op completed", () => {
    expect(OPS_OPEN_AT_START).toBe(3);
    expect(opsUnlocked(0)).toBe(3);
    expect(opsUnlocked(2)).toBe(5);
    expect(opsUnlocked(99)).toBe(OPS.length);
    expect(nextOp(OPS[0]!.id)?.id).toBe(OPS[1]!.id);
    expect(nextOp(OPS[OPS.length - 1]!.id)).toBeNull();
  });

  const result = (id: string, won: boolean, stars: number, secs = 200): MatchResult => ({
    kind: "op", mapId: opById(id)!.map, difficulty: "normal", won, secs, buildingsLost: 0,
    medals: [], mutators: [], daily: null, op: { id, stars }
  });

  it("banks stars (best of all attempts), XP, and unlocks the next op", () => {
    let c = emptyCareer();
    expect(opUnlocked(c, OPS[3]!.id)).toBe(false);
    const first = applyResult(c, result(OPS[0]!.id, true, 3), 100);
    c = first.career;
    expect(c.ops[OPS[0]!.id]).toMatchObject({ stars: 3, plays: 1, wins: 1, bestSecs: 200 });
    expect(first.s.op).toMatchObject({ starsBefore: 0, starsAfter: 3, firstClear: true, unlocked: OPS[3]!.id });
    // 60 complete + 100 first clear + 40 for the new star
    expect(first.s.gained).toBe(200);
    expect(opsCompleted(c)).toBe(1);
    expect(opUnlocked(c, OPS[3]!.id)).toBe(true);
    // a worse replay keeps the stars; a new star still pays
    const again = applyResult(c, result(OPS[0]!.id, true, 5, 150), 100);
    expect(again.career.ops[OPS[0]!.id]).toMatchObject({ stars: 7, plays: 2, wins: 2, bestSecs: 150 });
    expect(again.s.op).toMatchObject({ starsBefore: 3, starsAfter: 7, firstClear: false, unlocked: null });
    expect(again.s.gained).toBe(60 + 40);
    // ops never touch skirmish records, map stars or medals
    expect(again.career.wins).toBe(0);
    expect(again.career.stars).toEqual({});
    // a failure counts the attempt only
    const fail = applyResult(again.career, result(OPS[1]!.id, false, 0, 30), 100);
    expect(fail.career.ops[OPS[1]!.id]).toMatchObject({ stars: 0, plays: 1, wins: 0 });
    expect(fail.s.gained).toBeGreaterThan(0);
    expect(fail.s.gained).toBeLessThan(20);
  });
});
