/**
 * Cross-wiring between features built apart: calldown kill credit in the
 * presentation layers (callouts, chronicle, report, hotspots, music), the
 * battlefield medals, and which modes allow calldowns.
 */
import { describe, expect, it } from "vitest";


import { AWARDS, computeMedals, strikesDodged, type MatchRecap, type RecapStrike } from "../src/sim/awards";
import { POWERS, TICK_RATE } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import { OPS } from "../src/sim/ops";
import { podCrew, powerBlocker, powerStatus } from "../src/sim/powers";
import { step } from "../src/sim/sim";
import type { Command, Faction, FactionStats, FxEvent, PowerKind, World } from "../src/sim/types";
import { createWorld, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";
import type { Announcement } from "../src/game/announce";
import { HeatMap, InboundWatch } from "../src/game/awareness";
import { CalldownCredit, calldownKillOf } from "../src/game/calldown-credit";
import { BattleCallouts, CALLOUTS, RadioQueue, streakPower, type RadioLine } from "../src/game/callouts";
import { recapOf } from "../src/game/career";
import { Chronicle, moments, pickTip, type DeathRec } from "../src/game/chronicle";
import { HeroPresenter } from "../src/game/hero-fx";
import { BattleMood, MUSIC, type MoodHooks } from "../src/game/score";
import { calldownCounts, extraStatRows } from "../src/ui/report";

// ------------------------------------------------------------- helpers ---

function arena(size = 40): World {
  const w = createWorld(size, size);
  spawnBuilding(w, "hq", "blue", 2, 2);
  spawnBuilding(w, "hq", "red", size - 5, size - 5);
  w.powers.meter.blue = w.powers.meter.red = 100;
  tickFog(w);
  w.fog.blue.vis.fill(2);
  w.fog.red.vis.fill(2);
  return w;
}

const call = (faction: Faction, power: PowerKind, x: number, y: number): Command => ({ type: "calldown", faction, power, x, y });

/** Step until the calldown has landed, handing each tick's fx to `each`. */
function run(w: World, ticks: number, cmds: Command[], each: (fx: FxEvent[]) => void): void {
  for (let i = 0; i < ticks; i++) {
    step(w, i === 0 ? cmds : []);
    w.fog.blue.vis.fill(2);
    w.fog.red.vis.fill(2);
    each(w.fx);
  }
}

/** A clump of frail, harmless red units: a Barrage or Sky Hammer kills them. */
function frailClump(w: World, n: number, x: number, y: number, faction: Faction = "red") {
  return Array.from({ length: n }, (_, i) => {
    const u = spawnUnit(w, "stinger", faction, x + (i % 3) * 0.3, y + Math.floor(i / 3) * 0.3);
    u.hp = 5;
    u.cooldown = 1e9;
    return u;
  });
}

type Death = Extract<FxEvent, { type: "death" }>;
type Impact = Extract<FxEvent, { type: "calldownImpact" }>;
const death = (o: Partial<Death>): Death => ({
  type: "death", id: 900, faction: "red", unitKind: "stinger", buildingKind: null, x: 20, y: 20, air: false,
  value: 150, killerId: 1, killerKind: null, rank: 0, kills: 0, ...o
});
const impact = (o: Partial<Impact>): Impact => ({
  type: "calldownImpact", id: 77, faction: "blue", power: "barrage", x: 20, y: 20, radius: 2.9, hits: 1, unitIds: [], ...o
});

// -------------------------------------------------------- kill credit ---

describe("calldown kill credit", () => {
  it("credits a death killed by the enemy HQ near that side's impact this tick", () => {
    const hq = (f: Faction) => (f === "blue" ? 1 : 2);
    const im = [impact({})];
    expect(calldownKillOf(death({}), im, hq)).toEqual({ power: "barrage", faction: "blue", calldownId: 77 });
    // killed by a unit, a turret, or the HQ gun far from any impact: not a calldown kill
    expect(calldownKillOf(death({ killerKind: "stinger", killerId: 5 }), im, hq)).toBeNull();
    expect(calldownKillOf(death({ killerId: 33 }), im, hq)).toBeNull();
    expect(calldownKillOf(death({ x: 35, y: 35 }), im, hq)).toBeNull();
    // the victim's own side's strike doesn't count; nor does a death with no killer
    expect(calldownKillOf(death({ faction: "blue", killerId: 2 }), im, hq)).toBeNull();
    expect(calldownKillOf(death({ killerId: null }), im, hq)).toBeNull();
    // a building's centre may sit a little outside the reticle
    expect(calldownKillOf(death({ unitKind: null, buildingKind: "turret", x: 24, y: 20 }), im, hq)).not.toBeNull();
  });

  it("names the Feu roulant behind real kills in a sim run, and the tracker forgets old ticks", () => {
    const w = arena();
    const victims = frailClump(w, 4, 20, 20);
    const credit = new CalldownCredit(w);
    const got = new Map<number, PowerKind>();
    run(w, 40, [call("blue", "barrage", 20.3, 20.3)], (fx) => {
      for (const [id, k] of credit.scan(fx)) got.set(id, k.power);
    });
    expect(victims.every((u) => !w.units.has(u.id))).toBe(true);
    expect(got.size).toBe(victims.length);
    expect([...got.values()].every((p) => p === "barrage")).toBe(true);
    // a later HQ-gun kill with no impact that tick is not a calldown kill
    const later = credit.scan([death({ killerId: hqOf(w, "blue")!.id })]);
    expect(later.size).toBe(0);
  });
});

// ------------------------------------------------------------ chronicle ---

describe("chronicle and report", () => {
  it("records calldown kills as such (not defences), strikes with what they hit, and never an HQ as MVP", () => {
    const w = arena();
    frailClump(w, 4, 20, 20);
    const c = new Chronicle(w);
    run(w, 40, [call("blue", "barrage", 20.3, 20.3)], (fx) => fx.forEach((e) => c.onFx(e)));
    const kills = c.deaths.filter((d) => d.faction === "red");
    expect(kills.length).toBe(4);
    expect(kills.every((d) => d.power === "barrage" && !d.byBuilding && d.strike !== null)).toBe(true);
    expect(c.strikes).toHaveLength(1);
    expect(c.strikes[0]).toMatchObject({ faction: "blue", power: "barrage", exposed: 4, units: 4, buildings: 0, value: 600 });
    expect(c.strikes[0]!.hits).toBeGreaterThanOrEqual(4);
    expect(c.mvp().blue).toBeNull(); // the kills belong to the HQ, which is no unit
    // the recap carries the strikes for the medals
    expect(recapOf(w, c, "blue").strikes).toBe(c.strikes);
  });

  const refs = { width: 40, height: 40, hq: {} };
  const rec = (t: number, faction: Faction, extra: Partial<DeathRec> = {}): DeathRec => ({
    t, x: 20, y: 20, faction, unitKind: "stinger", buildingKind: null, value: 150, killerKind: "stinger", byBuilding: false, ...extra
  });

  it("names the calldown in first blood, the biggest battle and the turning point", () => {
    const deaths = [
      rec(30, "red", { power: "barrage", strike: 7, killerKind: null }),
      rec(31, "red", { power: "barrage", strike: 7, killerKind: null }),
      rec(31, "red", { power: "barrage", strike: 7, killerKind: null }),
      rec(32, "red", { power: "barrage", strike: 7, killerKind: null }),
      rec(33, "red"),
      rec(34, "blue"),
      rec(35, "blue")
    ];
    const m = moments({ samples: [], deaths, refs }, "blue");
    expect(m.find((x) => x.kind === "first-blood")!.text).toBe("Ton Feu roulant a éliminé leur Panhard");
    expect(m.find((x) => x.kind === "battle")!.text).toBe("Au centre : tu as perdu 2, l'ennemi a perdu 5 (dont 4 par ton Feu roulant)");
    const spec = moments({ samples: [], deaths, refs }, null);
    expect(spec.find((x) => x.kind === "battle")!.text).toContain("(dont 4 par le Feu roulant bleu)");
    // a strike just before the lead changed hands is the turn's story
    const army = (b: number, r: number) => ({ blue: b, red: r });
    const samples = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map((t) => ({
      t, army: t < 35 ? army(400, 2000) : army(2000, 400), bank: army(0, 0), harvesters: army(2, 2)
    }));
    const turn = moments({ samples, deaths, refs }, "blue").find((x) => x.kind === "turn")!;
    expect(turn.text).toMatch(/^Ton armée a dépassé la leur après ton Feu roulant/);
  });

  it("tips the player who stood in the red circles", () => {
    const struck = Array.from({ length: 7 }, (_, i) => rec(i, "blue", { power: "hammer", strike: 1, killerKind: null }));
    const tip = pickTip({
      pov: "blue", won: false, duration: 400, difficulty: "normal", built: { blue: {}, red: {} }, firstBuilt: { blue: {}, red: {} },
      deaths: struck, samples: [], factories: { blue: { total: 0, idleRich: 0 }, red: { total: 0, idleRich: 0 } }
    });
    expect(tip).toMatch(/Les frappes ennemies ont détruit 7 de tes unités/);
  });

  it("counts calldowns per side for the stats table; salvage is a core row, not an extra", () => {
    const w = arena();
    w.powers.fired.blue.barrage = 2;
    w.powers.fired.blue.hammer = 1;
    const c = calldownCounts(w);
    expect(c.blue).toEqual({ total: 3, by: [["Feu roulant", 2], ["Obus Méliès", 1]] });
    expect(c.red.total).toBe(0);
    const core: FactionStats = { unitsBuilt: 1, unitsLost: 2, unitsKilled: 3, buildingsLost: 0, buildingsKilled: 1, scrapHarvested: 500, scrapSalvaged: 240 };
    expect(extraStatRows(core, core)).toEqual([]);
  });
});

// ------------------------------------------------------------- callouts ---

function rig(w: World, opts: { spectator?: boolean } = {}) {
  const radio: RadioLine[] = [];
  const banners: Announcement[] = [];
  const c = new BattleCallouts({
    world: w, player: "blue", spectator: opts.spectator ?? false, onScreen: () => false,
    radio: (l) => radio.push(l),
    announce: (a) => banners.push(a)
  });
  return { c, radio, banners };
}

describe("callouts and calldowns", () => {
  it("a Feu roulant's kills count for first blood and make their own streak banner", () => {
    const strike = (warmup: boolean) => {
      const w = arena();
      frailClump(w, 3, 20, 20);
      const r = rig(w);
      // (first blood long before: kill banners keep 6 s apart, so it would swallow the streak)
      if (warmup) r.c.events([death({ id: 1, killerId: 99, killerKind: "stinger" })], -10);
      run(w, 60, [call("blue", "barrage", 20.3, 20.3)], (fx) => r.c.events(fx, w.tick / TICK_RATE));
      return r.banners;
    };
    expect(strike(false)[0]).toMatchObject({ key: "first-blood", sub: "Panhard ennemi détruit par un Feu roulant" });
    expect(strike(true).find((b) => b.key === "streak-3")).toMatchObject({ text: "Triplé", sub: "Feu roulant", say: "Feu roulant : triplé" });
  });

  it("streakPower: one calldown doing most of the work", () => {
    expect(streakPower(["hammer", "hammer", null])).toBe("hammer");
    expect(streakPower(["hammer", null, null])).toBeNull();
    expect(streakPower([null, null])).toBeNull();
    expect(streakPower(["barrage", "barrage", "hammer", null])).toBe("barrage");
  });

  it("warns by radio of an enemy Feu roulant, EMP or Drop Pod aimed at our things — not the Sky Hammer (its banner talks)", () => {
    const w = arena();
    spawnUnit(w, "stinger", "blue", 20, 20);
    const r = rig(w);
    let now = 0;
    const cd = (power: PowerKind, x = 20, y = 20, faction: Faction = "red"): FxEvent => ({
      type: "calldown", id: 1, faction, power, x, y, radius: POWERS[power].radius, landTick: Math.round((now + 2.5) * TICK_RATE)
    });
    r.c.events([cd("barrage")], 1);
    r.c.events([cd("barrage")], 2); // cooldown
    r.c.events([cd("emp", 35, 5)], 3); // nothing of ours there
    r.c.events([cd("hammer")], 4);
    r.c.events([cd("droppod")], 5);
    r.c.events([cd("barrage", 20, 20, "blue")], 6); // ours
    expect(r.radio.map((l) => [l.key, l.text, l.priority, l.caption])).toEqual([
      ["enemy-barrage", "Artillerie en approche !", 1, false],
      ["enemy-droppod", "Obus-capsule ennemi !", 1, false]
    ]);
    now = 1 + CALLOUTS.cooldownS["enemy-barrage"]!;
    r.c.events([cd("barrage")], now);
    expect(r.radio).toHaveLength(3);
    // its shells hitting our units off screen are the same news, not "our units are under fire"
    const unit = [...w.units.values()][0]!;
    r.c.events([{ type: "hit", faction: "blue", id: unit.id, x: 20, y: 20, building: false, attackerId: 2 }], now + 3);
    expect(r.radio).toHaveLength(3);
    r.c.events([{ type: "hit", faction: "blue", id: unit.id, x: 20, y: 20, building: false, attackerId: 2 }], now + 10);
    expect(r.radio.at(-1)!.key).toBe("units-attack");
    // spectators get no warnings
    const s = rig(w, { spectator: true });
    s.c.events([cd("barrage")], 1);
    expect(s.radio).toHaveLength(0);
  });

  it("drops a warning that has waited past its own staleness", () => {
    const q = new RadioQueue();
    q.push({ key: "x", text: "Construction complete", priority: 3, tone: "good", caption: false }, 0);
    expect(q.next(0)?.key).toBe("x");
    q.push({ key: "enemy-emp", text: "EMP inbound!", priority: 1, tone: "bad", caption: false, staleS: 1 }, 0.5);
    expect(q.next(2.6)).toBeNull(); // the gap ran out after the line went stale
    q.push({ key: "enemy-emp", text: "EMP inbound!", priority: 1, tone: "bad", caption: false, staleS: 1 }, 5);
    expect(q.next(5.5)?.key).toBe("enemy-emp");
  });
});

// ------------------------------------------------------- hotspots, heroes ---

describe("hotspots and hero toasts", () => {
  it("our calldown's kills don't heat up our own HQ (an 'Attack' arrow at home)", () => {
    const w = arena();
    frailClump(w, 4, 20, 20);
    const heat = new HeatMap({ world: w, player: "blue", spectator: false });
    run(w, 40, [call("blue", "barrage", 20.3, 20.3)], (fx) => heat.events(fx, w.tick / TICK_RATE));
    expect(heat.heatAt(3.5, 3.5)).toBe(0);
  });

  it("an enemy Drop Pod's crew is not reported again as a new raid", () => {
    const raid = (pod: boolean) => {
      const w = arena();
      spawnBuilding(w, "turret", "blue", 12, 12);
      const crew = spawnUnit(w, "stinger", "red", 16.5, 12.5);
      const watch = new InboundWatch({ world: w, player: "blue" });
      return watch.events(pod ? [impact({ faction: "red", power: "droppod", unitIds: [crew.id], x: 16.5, y: 12.5 })] : [], 30);
    };
    expect(raid(false)).toHaveLength(1);
    expect(raid(true)).toHaveLength(0);
  });

  it("names the strike that killed a hero", () => {
    const w = arena();
    const notes: string[] = [];
    const hp = new HeroPresenter(null, w, {
      player: "blue", spectator: false, seesPoint: () => true, seesUnit: () => true, unitPos: () => null,
      notify: (m) => notes.push(m)
    });
    const vet = { id: 501, faction: "blue" as Faction, rank: 2, kills: 7, killerId: hqOf(w, "red")!.id };
    hp.handleFx(impact({ faction: "red", power: "hammer", radius: 2.5 }));
    hp.handleFx(death(vet));
    hp.flush();
    expect(notes[0]).toMatch(/^✝ \w+ \([^,]+, 7 [^)]+\) détruit par la frappe .+ ennemie$/);
    // an enemy ace downed by our Barrage
    w.tick++;
    hp.handleFx(impact({ faction: "blue" }));
    hp.handleFx(death({ id: 502, rank: 3, kills: 4, killerId: hqOf(w, "blue")!.id }));
    hp.flush();
    expect(notes[1]).toMatch(/^🎯 As ennemi \w+ \([^,]+, 4 [^)]+\) abattu par ta frappe .+$/);
  });
});

// ---------------------------------------------------------------- music ---

describe("music and calldowns", () => {
  const hooks = (over: Partial<MoodHooks> = {}): MoodHooks => ({
    player: "blue", spectator: false, earshot: () => 1, sees: () => true, factionOf: () => null, ...over
  });

  it("an impact in earshot is a big moment that fades; far away it's nothing — except a Sky Hammer", () => {
    const m = new BattleMood(hooks());
    m.events([impact({ power: "barrage" })], 10);
    expect(m.raw(10)).toBeCloseTo(MUSIC.strikeBoost.barrage);
    expect(m.raw(10 + MUSIC.strikeFadeS / 2)).toBeCloseTo(MUSIC.strikeBoost.barrage / 2);
    expect(m.raw(10 + MUSIC.strikeFadeS + 0.1)).toBe(0);
    const far = new BattleMood(hooks({ earshot: () => 0 }));
    far.events([impact({ power: "barrage" })], 1);
    expect(far.raw(1)).toBe(0);
    far.events([impact({ power: "hammer" })], 2);
    expect(far.raw(2)).toBeCloseTo(MUSIC.strikeBoost.hammer * MUSIC.strikeHammerFloor);
    // a Sky Hammer on our own things counts in full, wherever the camera is
    const home = new BattleMood(hooks({ earshot: () => 0, threatened: () => true }));
    home.events([impact({ power: "hammer", faction: "red" })], 2);
    expect(home.raw(2)).toBeCloseTo(MUSIC.strikeBoost.hammer);
  });

  it("holds the tension while an enemy reticle sits on our things, and through a Last Stand wave's countdown", () => {
    const m = new BattleMood(hooks({ earshot: () => 0, threatened: () => true }));
    m.events([{ type: "calldown", id: 3, faction: "red", power: "barrage", x: 5, y: 5, radius: 2.9, landTick: 125 }], 10);
    expect(m.raw(11)).toBeCloseTo(MUSIC.telegraphBoost);
    expect(m.raw(13)).toBe(0);
    const s = new BattleMood(hooks({ earshot: () => 0 }));
    s.events([{ type: "waveIncoming", wave: 2, theme: "air", name: "Air Raid", x: 0, y: 0, dir: "north", eta: 150, early: 0 }], 20);
    expect(s.raw(30)).toBe(MUSIC.waveFloor);
    expect(s.raw(20 + 15 + MUSIC.waveHoldS + 0.5)).toBe(0);
  });
});

// --------------------------------------------------------------- medals ---

describe("battlefield medals", () => {
  const stats = (o: Partial<FactionStats> = {}): FactionStats => ({
    unitsBuilt: 10, unitsLost: 10, unitsKilled: 10, buildingsLost: 1, buildingsKilled: 2, scrapHarvested: 4000, scrapSalvaged: 0, ...o
  });
  const recap = (o: Partial<MatchRecap> = {}): MatchRecap => ({
    pov: "blue", won: false, secs: 600, stats: { blue: stats(), red: stats() }, samples: [], deaths: [], bestUnitKills: 0, ...o
  });
  const strike = (o: Partial<RecapStrike>): RecapStrike => ({
    faction: "blue", power: "hammer", exposed: 0, hits: 0, units: 0, buildings: 0, value: 0, ...o
  });

  it("Orbital: one Sky Hammer that destroys enough", () => {
    expect(computeMedals(recap({ strikes: [strike({ value: AWARDS.orbitalValue, buildings: 3 })] }))).toEqual(["orbital"]);
    expect(computeMedals(recap({ strikes: [strike({ value: AWARDS.orbitalValue - 1 })] }))).toEqual([]);
    // not two Hammers added up, not a Barrage, not the enemy's
    expect(computeMedals(recap({ strikes: [strike({ value: 600 }), strike({ value: 600 })] }))).toEqual([]);
    expect(computeMedals(recap({ strikes: [strike({ power: "barrage", value: 2000 })] }))).toEqual([]);
    expect(computeMedals(recap({ strikes: [strike({ faction: "red", value: 2000 })] }))).toEqual([]);
  });

  it("Scavenger: salvage enough in one match (in defeat too)", () => {
    expect(computeMedals(recap({ stats: { blue: stats({ scrapSalvaged: AWARDS.scavengerScrap }), red: stats() } }))).toEqual(["scavenger"]);
    expect(computeMedals(recap({ stats: { blue: stats({ scrapSalvaged: AWARDS.scavengerScrap - 1 }), red: stats() } }))).toEqual([]);
  });

  it("Steady Hands: get clear of enough enemy Barrages / Sky Hammers before they land", () => {
    const dodge = strike({ faction: "red", power: "barrage", exposed: AWARDS.dodgeExposed, hits: 0 });
    const r = recap({ strikes: Array.from({ length: AWARDS.steadyDodges }, () => dodge) });
    expect(strikesDodged(r)).toBe(AWARDS.steadyDodges);
    expect(computeMedals(r)).toEqual(["steady-hands"]);
    // a hit, an empty reticle, an EMP or our own strike isn't a dodge
    const not = [
      { ...dodge, hits: 1 },
      { ...dodge, exposed: AWARDS.dodgeExposed - 1 },
      { ...dodge, power: "emp" as PowerKind },
      { ...dodge, faction: "blue" as Faction }
    ];
    expect(strikesDodged(recap({ strikes: [...not, dodge] }))).toBe(1);
  });
});

// ----------------------------------------------------- modes × calldowns ---

describe("which modes allow calldowns", () => {
  it("ops built on a fixed strike group or budget switch them off for both sides — no Sky Hammer either", () => {
    for (const id of ["decapitation", "frozen-assets"]) {
      const w = createMapWorld(OPS.find((o) => o.id === id)!.map, { op: id });
      expect(w.rules?.noCalldowns).toBe(true);
      for (const f of ["blue", "red"] as Faction[]) {
        w.powers.meter[f] = 100;
        expect(powerBlocker(w, f, "barrage")).toMatch(/Pas de frappes/);
        expect(powerStatus(w, f, "emp").ready).toBe(false);
      }
      w.tick = POWERS.hammer.unlock * TICK_RATE - 1;
      step(w, []);
      expect(w.fx.some((e) => e.type === "powerOnline")).toBe(false);
    }
  });

  it("other ops keep them; Sky Pirates' Drop Pod lands aircraft", () => {
    const w = createMapWorld("ashlands", { op: "sky-pirates" });
    expect(w.rules?.noCalldowns).toBeFalsy();
    expect(podCrew(w, "blue").every((k) => k === "wasp" || k === "raptor")).toBe(true);
    expect(podCrew(w, "red")).toEqual(POWERS.droppod.units);
    const bridge = createMapWorld("riverlands", { op: "bridgehead" });
    expect(bridge.rules?.noCalldowns).toBeFalsy();
  });

  it("a frozen economy (Frozen Assets) can't cash in wrecks; the enemy still can", () => {
    const w = createMapWorld("frostbite", { op: "frozen-assets" });
    const wreck = (id: number, x: number, y: number) =>
      w.wrecks.push({ id, kind: "stinger", faction: "red", x, y, facing: 0, value: 45, ttl: 600, hot: 0 });
    const blue = spawnUnit(w, "stinger", "blue", 24.5, 24.5);
    const red = spawnUnit(w, "stinger", "red", 30.5, 24.5);
    blue.cooldown = red.cooldown = 1e9;
    wreck(90001, blue.x, blue.y);
    wreck(90002, red.x, red.y);
    const before = { blue: w.factions.blue.scrap, red: w.factions.red.scrap };
    step(w, []);
    expect(w.wrecks.map((r) => r.id)).toEqual([90001]);
    expect(w.factions.blue.scrap).toBe(before.blue);
    expect(w.factions.blue.stats.scrapSalvaged).toBe(0);
    expect(w.fx.some((e) => e.type === "salvage" && e.faction === "blue")).toBe(false);
    expect(w.factions.red.stats.scrapSalvaged).toBeGreaterThan(0);
  });

  it("Last Stand keeps the player's calldowns; the waves (no HQ) have none", () => {
    const w = createMapWorld("riverlands", { survival: { difficulty: "normal" } });
    expect(w.survival).toBeTruthy();
    expect(w.rules?.noCalldowns).toBeFalsy();
    w.powers.meter.blue = 100;
    expect(powerBlocker(w, "blue", "barrage")).toBeNull();
    expect(powerBlocker(w, "red", "barrage")).toMatch(/GQG/);
  });
});
