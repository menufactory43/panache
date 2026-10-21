import { describe, expect, it } from "vitest";
import { tickAi } from "../src/sim/ai/commander";
import { BUILDINGS, TERRAIN, TICK_RATE } from "../src/sim/balance";
import { buildingBlocker, unitBlocker } from "../src/sim/economy";
import { createMapWorld } from "../src/sim/maps";
import {
  CAMPAIGN,
  CAMPAIGN_OPEN_AT_START,
  CAMPAIGN_UNLOCKS,
  OPS,
  OPS_OPEN_AT_START,
  TRIALS,
  arsenalFor,
  campaignUnlocked,
  playerBansOf,
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
import { ROSTERS } from "../src/sim/balance";
import { inRoster, nationOf } from "../src/sim/rules";
import { buildingMaxHp } from "../src/sim/nations";
import { calldownBlocker, powerBlocker } from "../src/sim/powers";
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

  it("has the 12-mission campaign, the 8 Classique Trials, unique ids, real maps and two star conditions each", () => {
    expect(CAMPAIGN).toHaveLength(12);
    expect(TRIALS).toHaveLength(8);
    expect(OPS).toHaveLength(20);
    for (const t of TRIALS) {
      expect(t.id.endsWith("-classique")).toBe(true);
      expect(t.nations).toBeUndefined();
    }
    // the campaign keeps the old op ids (records and stars carry over)
    for (const id of ["bridgehead", "harvest-moon", "iron-tide", "frozen-assets", "sky-pirates", "glass-jaw", "decapitation", "last-light"])
      expect(CAMPAIGN.some((o) => o.id === id)).toBe(true);
    for (const op of CAMPAIGN) {
      expect(op.nations).toBeDefined();
      expect(op.act).toBeDefined();
      expect(op.cards!.before.length).toBeGreaterThanOrEqual(2);
      for (const c of [...op.cards!.before, op.cards!.win, op.cards!.lose]) expect(c.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
    expect(new Set(OPS.map((o) => o.id)).size).toBe(OPS.length);
    for (const op of OPS) {
      expect(op.goals.length).toBeGreaterThan(0);
      expect(op.stars).toHaveLength(2);
      expect(op.goals.some((g) => ["destroyHq", "destroy", "survive", "waves", "deliver", "reach"].includes(g.type))).toBe(true);
      for (const g of [...op.goals, ...op.stars]) expect(goalText(g, false, op).length).toBeGreaterThan(3);
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
    const w = opWorld("sky-pirates-classique");
    expect(buildingBlocker(w, "blue", "fab-plant")).toBe("Désactivé dans cette op");
    expect(buildingBlocker(w, "red", "fab-plant")).toBeNull();
    expect(unitBlocker(w, "blue", "raptor")).toBeNull();
    // ground units banned: so is the Condor that would fly the starting squad into the fight
    expect(unitBlocker(w, "blue", "condor")).toBe("Désactivé dans cette op");
  });

  it("Decapitation: no production of any kind, and no income", () => {
    const w = opWorld("decapitation-classique");
    expect(unitBlocker(w, "blue", "harvester")).toBe("Désactivé dans cette op");
    expect(buildingBlocker(w, "blue", "turret")).toBe("Désactivé dans cette op");
    idle(w, 20);
    expect(w.factions.blue.scrap).toBe(0);
  });

  it("Frozen Assets: the bank never grows (no harvesters, no HQ trickle)", () => {
    const w = opWorld("frozen-assets-classique");
    expect([...w.units.values()].some((u) => u.faction === "blue" && u.kind === "harvester")).toBe(false);
    const bank = w.factions.blue.scrap;
    idle(w, 30);
    expect(w.factions.blue.scrap).toBe(bank);
    expect(w.factions.red.scrap).not.toBe(600);
  });

  it("Glass Jaw runs its mutators for both sides", () => {
    const w = opWorld("glass-jaw-classique");
    expect(w.rules?.dmgMult).toBe(2);
    expect(w.rules?.buildSpeed).toBe(2);
  });

  it("Last Light: the wave director paces itself for the op", () => {
    const w = opWorld("last-light-classique");
    expect(w.survival).toBeTruthy();
    expect(hqOf(w, "red")).toBeNull();
    expect(w.survival!.nextWaveTick).toBe(45 * TICK_RATE);
    expect(w.survival!.interval).toBe(40);
    expect(w.factions.blue.scrap).toBe(1200);
  });
});

describe("Ops: goals", () => {
  it("survive and within count the clock", () => {
    const w = opWorld("bridgehead-classique");
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
    const w = opWorld("bridgehead-classique");
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
    const w = opWorld("harvest-moon-classique");
    const st = w.ops!;
    w.factions.blue.stats.scrapHarvested = 2500;
    expect(evalGoal(w, st, { type: "deliver", scrap: 10000 })).toMatchObject({ state: "pending", value: "2\u202f500/10\u202f000" });
    expect(evalGoal(w, st, { type: "destroyHq" }).state).toBe("pending");
  });

  it("completing the goals wins the op with stars, through the normal winner flag", () => {
    const w = opWorld("bridgehead-classique");
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
    const w = opWorld("bridgehead-classique");
    for (const id of w.ops!.tags.bridge!) w.buildings.get(id)!.hp = 0;
    w.tick = 10;
    step(w, []);
    expect(w.winner).toBe("red");
    expect(w.ops!.result).toMatchObject({ won: false, reason: "Hotchkiss du pont perdues", stars: 0, byGoal: true });
    expect(w.ops!.starsLost & 4).toBe(4);
  });

  it("an HQ kill ends the op the classic way (no goal ending)", () => {
    const w = opWorld("glass-jaw-classique");
    hqOf(w, "red")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("blue");
    expect(w.ops!.result).toMatchObject({ won: true, reason: "GQG ennemi détruit", byGoal: false });
    expect(starsNow(w, opById("glass-jaw-classique")!, w.ops!) & 1).toBe(1);
    const lost = opWorld("glass-jaw-classique");
    hqOf(lost, "blue")!.hp = 0;
    step(lost, []);
    expect(lost.ops!.result).toMatchObject({ won: false, reason: "Notre GQG est tombé" });
  });

  it("running out of time fails a timed op", () => {
    const w = opWorld("decapitation-classique");
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

describe("Ops: progress", () => {
  it("opens three Trials, then one more per Trial completed", () => {
    expect(OPS_OPEN_AT_START).toBe(3);
    expect(opsUnlocked(0)).toBe(3);
    expect(opsUnlocked(2)).toBe(5);
    expect(opsUnlocked(99)).toBe(TRIALS.length);
    expect(nextOp(TRIALS[0]!.id)?.id).toBe(TRIALS[1]!.id);
    expect(nextOp(TRIALS[TRIALS.length - 1]!.id)).toBeNull();
  });

  it("opens the campaign one mission at a time", () => {
    expect(CAMPAIGN_OPEN_AT_START).toBe(1);
    expect(campaignUnlocked(0)).toBe(1);
    expect(campaignUnlocked(99)).toBe(12);
    expect(nextOp("bridgehead")?.id).toBe("harvest-moon");
    expect(nextOp("dame-de-fer")).toBeNull();
    let c = emptyCareer();
    expect(opUnlocked(c, "bridgehead")).toBe(true);
    expect(opUnlocked(c, "harvest-moon")).toBe(false);
    expect(opUnlocked(c, "bridgehead-classique")).toBe(true);
    const won = applyResult(c, result("bridgehead", true, 1), 100);
    c = won.career;
    expect(won.s.op?.unlocked).toBe("harvest-moon");
    expect(opUnlocked(c, "harvest-moon")).toBe(true);
    expect(opUnlocked(c, "granit")).toBe(false);
    // a campaign win opens no Trial, and the other way round
    expect(opUnlocked(c, TRIALS[3]!.id)).toBe(false);
  });

  const result = (id: string, won: boolean, stars: number, secs = 200): MatchResult => ({
    kind: "op", mapId: opById(id)!.map, difficulty: "normal", won, secs, buildingsLost: 0,
    medals: [], mutators: [], daily: null, op: { id, stars }
  });

  it("banks stars (best of all attempts), XP, and unlocks the next Trial", () => {
    let c = emptyCareer();
    expect(opUnlocked(c, TRIALS[3]!.id)).toBe(false);
    const first = applyResult(c, result(TRIALS[0]!.id, true, 3), 100);
    c = first.career;
    expect(c.ops[TRIALS[0]!.id]).toMatchObject({ stars: 3, plays: 1, wins: 1, bestSecs: 200 });
    expect(first.s.op).toMatchObject({ starsBefore: 0, starsAfter: 3, firstClear: true, unlocked: TRIALS[3]!.id });
    // 60 complete + 100 first clear + 40 for the new star
    expect(first.s.gained).toBe(200);
    expect(opsCompleted(c)).toBe(1);
    expect(opUnlocked(c, TRIALS[3]!.id)).toBe(true);
    // a worse replay keeps the stars; a new star still pays
    const again = applyResult(c, result(TRIALS[0]!.id, true, 5, 150), 100);
    expect(again.career.ops[TRIALS[0]!.id]).toMatchObject({ stars: 7, plays: 2, wins: 2, bestSecs: 150 });
    expect(again.s.op).toMatchObject({ starsBefore: 3, starsAfter: 7, firstClear: false, unlocked: null });
    expect(again.s.gained).toBe(60 + 40);
    // ops never touch skirmish records, map stars or medals
    expect(again.career.wins).toBe(0);
    expect(again.career.stars).toEqual({});
    // a failure counts the attempt only
    const fail = applyResult(again.career, result(TRIALS[1]!.id, false, 0, 30), 100);
    expect(fail.career.ops[TRIALS[1]!.id]).toMatchObject({ stars: 0, plays: 1, wins: 0 });
    expect(fail.s.gained).toBeGreaterThan(0);
    expect(fail.s.gained).toBeLessThan(20);
  });
});

describe("Campagne de 1900: nations and arsenal (§3.2 WP8)", () => {
  for (const op of CAMPAIGN)
    it(`${op.id}: each side fields only its own nation's kinds`, () => {
      const w = opWorld(op.id);
      expect(nationOf(w, "blue")).toBe(op.nations!.player);
      expect(nationOf(w, "red")).toBe(op.nations!.enemy);
      const all = [...w.units.values(), ...[...w.units.values()].flatMap((u) => u.passengers ?? []), ...w.buildings.values()];
      for (const e of all) expect(inRoster(nationOf(w, e.faction), e.kind), `${e.faction} ${e.kind}`).toBe(true);
      // the République's pre-placed buildings are on the Réseau électrique
      idle(w, 2);
      for (const b of w.buildings.values()) if (b.faction === "blue") expect(b.unpowered, `${b.kind} at ${b.tx},${b.ty}`).toBeFalsy();
    });

  it("unlocks are cumulative, per nation, and only name that nation's kinds", () => {
    for (const u of CAMPAIGN_UNLOCKS) {
      expect(CAMPAIGN.some((o) => o.id === u.op && o.nations!.player === u.nation)).toBe(true);
      for (const k of [...(u.units ?? []), ...(u.buildings ?? [])]) expect(inRoster(u.nation, k), k).toBe(true);
    }
    for (const nation of ["republique", "empire"] as const) {
      const ops = CAMPAIGN.filter((o) => o.nations!.player === nation);
      for (let i = 1; i < ops.length; i++) {
        const a = arsenalFor(ops[i - 1]!)!;
        const b = arsenalFor(ops[i]!)!;
        for (const k of a.units) expect(b.units).toContain(k);
        for (const k of a.buildings) expect(b.buildings).toContain(k);
        for (const p of a.powers) expect(b.powers).toContain(p);
      }
    }
    // M1: the first République kit; the Zénith only from Dernière lueur; Rayon Curie after L'Orage de radium
    expect(arsenalFor(CAMPAIGN[0]!)!.units).toEqual(["fourgon", "jamais-contente", "de-dion", "trooper"]);
    expect(arsenalFor(opById("decapitation")!)!.powers).toContain("curie");
    expect(arsenalFor(opById("glass-jaw")!)!.powers).not.toContain("curie");
    expect(arsenalFor(opById("last-light")!)!.units).toContain("zenith");
    expect(arsenalFor(opById("sky-pirates")!)!.units).not.toContain("zenith");
    // never for the player: the Empire's Vulcain, Carabiniers and Gargantua
    for (const k of ["vulcain", "carabiniers", "goliath"] as const) expect(arsenalFor(opById("frozen-assets")!)!.units).not.toContain(k);
    expect(arsenalFor(TRIALS[0]!)).toBeNull();
  });

  it("bans what the arsenal hasn't unlocked yet, for the player only", () => {
    const w = opWorld("bridgehead");
    expect(unitBlocker(w, "blue", "jamais-contente")).not.toBe("Pas encore disponible dans la campagne");
    expect(unitBlocker(w, "blue", "lancer")).toBe("Pas encore disponible dans la campagne");
    expect(buildingBlocker(w, "blue", "airpad")).toBe("Pas encore disponible dans la campagne");
    expect(buildingBlocker(w, "red", "airpad")).toBeNull();
    // the Rayon Curie isn't Sablon's yet: banned for blue, and its 6:00 alert never comes
    expect(playerBansOf(opById("bridgehead")!).powers).toEqual(expect.arrayContaining(["emp", "droppod", "curie"]));
    w.powers.meter.blue = 100;
    expect(powerBlocker(w, "blue", "emp")).toBe("Pas encore disponible dans la campagne");
    expect(calldownBlocker(w, "blue", "sonde", 20, 40)).toBeNull();
    for (const k of ROSTERS.republique.units) if (!arsenalFor(opById("bridgehead")!)!.units.includes(k)) expect(unitBlocker(w, "blue", k)).not.toBeNull();
  });

  it("the Paris finale: the Eiffel Tower is a tagged Tour TSF, four times as tough, drawn as the landmark", () => {
    const w = opWorld("dame-de-fer");
    const [id] = w.ops!.tags.eiffel!;
    const tower = w.buildings.get(id!)!;
    expect(tower.kind).toBe("radar");
    expect(w.ops!.landmarks[id!]).toBe("eiffel");
    expect(buildingMaxHp(w, tower)).toBe(tower.hp);
    expect(tower.hp).toBeGreaterThanOrEqual(4 * 300);
    expect(w.ops!.tags.colosse).toHaveLength(1);
    expect(w.units.get(w.ops!.tags.colosse![0]!)!.kind).toBe("goliath");
  });

  it("reach: the convoy at the tunnel wins Le Col des Aigles", () => {
    const w = opWorld("col-des-aigles");
    for (const id of w.ops!.tags.convoi!.slice(0, 2)) {
      const u = w.units.get(id)!;
      u.x = 8.5;
      u.y = 2.5;
    }
    w.tick = 10 * TICK_RATE;
    step(w, []);
    expect(w.winner).toBe("blue");
    expect(w.ops!.result).toMatchObject({ won: true, reason: "Tunnel atteint", byGoal: true });
  });

  it("Dernière lueur: the Zénith joins after the fifth wave", () => {
    const w = opWorld("last-light");
    expect([...w.units.values()].some((u) => u.kind === "zenith")).toBe(false);
    w.survival!.wave = 6;
    w.survival!.cleared = 5;
    w.tick = 50 * TICK_RATE;
    step(w, []);
    expect(w.ops!.events.zenith).toBeDefined();
    expect([...w.units.values()].some((u) => u.kind === "zenith" && u.faction === "blue")).toBe(true);
  });
});
