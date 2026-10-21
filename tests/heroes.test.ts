import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { VETERAN_RETREAT, isWoundedVeteran, veteranRetreats } from "../src/sim/ai/veterans";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { createSkirmishWorld } from "../src/sim/map";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Command, FactionStats, World } from "../src/sim/types";
import { buildingCenter, createWorld, dist, hqOf, setTerrain, spawnUnit } from "../src/sim/world";
import { isVisible, tickFog } from "../src/sim/fog";
import { unitSeenBy } from "../src/sim/infantry";
import { Terrain } from "../src/sim/types";
import { HeroPresenter } from "../src/game/hero-fx";
import type { View } from "../src/game/three/view";
import {
  CALLSIGNS,
  CallsignRegistry,
  baseCallsign,
  callsignOf,
  heroLine,
  heroShort
} from "../src/game/heroes";
import {
  Chronicle,
  biggestBattle,
  firstBlood,
  leaderAt,
  moments,
  pulledAway,
  pickTip,
  placeName,
  turningPoint,
  type DeathRec,
  type Sample,
  type TipInput
} from "../src/game/chronicle";
import { extraStatRows } from "../src/ui/report";

// ------------------------------------------------------------ callsigns ---

describe("veteran callsigns", () => {
  it("has 48 distinct punchy names", () => {
    expect(CALLSIGNS.length).toBe(48);
    expect(new Set(CALLSIGNS).size).toBe(48);
  });

  it("derives the first choice purely from the unit id", () => {
    for (const id of [1, 2, 77, 1234]) {
      expect(baseCallsign(id)).toBe(baseCallsign(id));
      expect(new CallsignRegistry().name(id, "blue")).toBe(CALLSIGNS[baseCallsign(id)]);
    }
    // ids spread over the list rather than marching through it
    const firsts = new Set([...Array(100).keys()].map((i) => baseCallsign(i + 1)));
    expect(firsts.size).toBeGreaterThan(40);
  });

  it("is stable per unit and never repeats a name on one side", () => {
    const r = new CallsignRegistry();
    const names = [...Array(48).keys()].map((i) => r.name(100 + i * 3, "blue"));
    expect(new Set(names).size).toBe(48);
    expect(r.name(100, "blue")).toBe(names[0]);
    expect(r.peek(100)).toBe(names[0]);
    // the 49th blue hero gets a numeral; red has its own pool
    expect(r.name(9999, "blue")).toMatch(/ II$/);
    expect(CALLSIGNS).toContain(r.name(5000, "red"));
  });

  it("shares one registry per world and formats hero lines", () => {
    const w = createSkirmishWorld();
    const u = spawnUnit(w, "lancer", "blue", 10, 10);
    u.rank = 2;
    u.kills = 9;
    const name = callsignOf(w, u);
    expect(callsignOf(w, u)).toBe(name);
    expect(heroLine(w, u)).toBe(`★★ ${name} · Hydroglisseur · 9 élim.`);
    expect(heroShort(w, u)).toBe(`${name} (Hydroglisseur, 9 élim.)`);
  });
});

// ------------------------------------------------------------- AI vets ---

describe("AI veterans fall back when badly hurt", () => {
  const setup = () => {
    const w = createSkirmishWorld();
    const hq = buildingCenter(hqOf(w, "red")!);
    const vet = spawnUnit(w, "mastodon", "red", 20, 24);
    vet.rank = 2;
    vet.hp = UNITS.mastodon.hp * 0.3;
    vet.order = { type: "attackMove", x: 10, y: 38 };
    return { w, hq, vet };
  };

  it("orders a wounded rank-2 unit home", () => {
    const { w, hq, vet } = setup();
    expect(isWoundedVeteran(vet)).toBe(true);
    const cmds = tickAi(w, "red", createAiState("balanced"));
    const mv = cmds.find((c): c is Extract<Command, { type: "move" }> => c.type === "move" && c.unitIds.includes(vet.id));
    expect(mv).toBeDefined();
    expect(dist(mv!.x, mv!.y, hq.x, hq.y)).toBeLessThanOrEqual(VETERAN_RETREAT.homeOffset + 0.5);
    // and nothing else grabs it in the same pass
    expect(cmds.filter((c) => "unitIds" in c && c.unitIds.includes(vet.id)).length).toBe(1);
  });

  it("prefers a Mender behind the unit, and leaves healthy or green units alone", () => {
    const { w, hq, vet } = setup();
    const m = spawnUnit(w, "mender", "red", (vet.x + hq.x) / 2, (vet.y + hq.y) / 2);
    const healthy = spawnUnit(w, "mastodon", "red", 21, 24);
    healthy.rank = 3;
    const rookie = spawnUnit(w, "stinger", "red", 22, 24);
    rookie.hp = 5;
    const army = [vet, m, healthy, rookie];
    const used = new Set<number>();
    const cmds = veteranRetreats("red", army, hq, used);
    expect(cmds).toHaveLength(1);
    const mv = cmds[0] as Extract<Command, { type: "move" }>;
    expect(mv.unitIds).toEqual([vet.id]);
    expect(dist(mv.x, mv.y, m.x, m.y)).toBeLessThan(0.01);
    expect(used.has(vet.id)).toBe(true);
    expect(used.has(healthy.id) || used.has(rookie.id)).toBe(false);
  });

  it("rests at home and calls an idle Mender over", () => {
    const { hq, vet, w } = setup();
    vet.x = hq.x + 2.5;
    vet.y = hq.y + 1;
    const m = spawnUnit(w, "mender", "red", hq.x - 8, hq.y + 6);
    const used = new Set<number>();
    const cmds = veteranRetreats("red", [vet, m], hq, used);
    // the mender is not "behind" the vet, so the vet heads for the HQ — it's already there
    expect(cmds.some((c) => "unitIds" in c && c.unitIds.includes(vet.id))).toBe(false);
    const call = cmds.find((c) => c.type === "attackMove");
    expect(call && "unitIds" in call ? call.unitIds : []).toEqual([m.id]);
  });

  it("keeps veterans alive in AI-vs-AI play without stalling the match", () => {
    const w = createMapWorld("frostbite", { seed: 7 });
    const red = createAiState("ironclad", "normal", 3);
    const blue = createAiState("rush", "normal", 4);
    for (let i = 0; i < 6 * 60 * TICK_RATE && !w.winner; i++)
      step(w, [...tickAi(w, "red", red), ...tickAi(w, "blue", blue)]);
    // no veteran sits wounded far from home without orders to retreat
    for (const u of w.units.values()) {
      if (!isWoundedVeteran(u)) continue;
      const home = buildingCenter(hqOf(w, u.faction)!);
      const far = dist(u.x, u.y, home.x, home.y) > 12;
      if (far) expect(u.order.type).toBe("move");
    }
    expect(w.tick).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ chronicle ---

const death = (t: number, x: number, y: number, faction: "blue" | "red", extra: Partial<DeathRec> = {}): DeathRec => ({
  t, x, y, faction, unitKind: "stinger", buildingKind: null, value: 100, killerKind: "stinger", byBuilding: false, ...extra
});
const sample = (t: number, blue: number, red: number): Sample => ({
  t, army: { blue, red }, bank: { blue: 0, red: 0 }, harvesters: { blue: 4, red: 4 }
});

describe("chronicle analysis", () => {
  it("finds first blood and the biggest battle with per-side losses", () => {
    const deaths = [
      death(40, 5, 5, "red", { unitKind: "harvester", killerKind: "wasp" }),
      // a skirmish
      death(100, 20, 20, "blue"), death(102, 21, 20, "red"), death(103, 20, 21, "red"),
      // the big one, mid-map
      ...[0, 1, 2, 3, 4, 5].map((i) => death(200 + i * 2, 24 + i * 0.3, 24, "red")),
      death(205, 25, 25, "blue"), death(207, 24, 23, "blue"),
      // far away, same time: not part of it
      death(204, 2, 46, "blue")
    ];
    expect(firstBlood(deaths)?.t).toBe(40);
    const b = biggestBattle(deaths)!;
    expect(b.count).toBe(8);
    expect(b.lost).toEqual({ blue: 2, red: 6 });
    expect(b.t).toBe(200);
    // one-sided deaths aren't a battle
    expect(biggestBattle([0, 1, 2, 3, 4].map((i) => death(i, 5, 5, "red")))).toBeNull();
  });

  it("detects the turning point only when the new lead holds 30 s", () => {
    // red leads early; blue overtakes at 60 and holds to the end
    const s = [0, 5, 10, 20, 30, 40, 50].map((t) => sample(t, 200, 900));
    for (let t = 60; t <= 120; t += 5) s.push(sample(t, 1500, 400));
    const turn = turningPoint(s)!;
    expect(turn.t).toBe(60);
    expect(turn.leader).toBe("blue");
    expect(turn.toEnd).toBe(true);
    // a brief flip that lasts 10 s doesn't count
    const blip = [0, 5, 10, 15].map((t) => sample(t, 200, 900));
    blip.push(sample(20, 1500, 300), sample(25, 1500, 300), sample(30, 200, 900), sample(35, 200, 900));
    for (let t = 40; t <= 100; t += 5) blip.push(sample(t, 200, 900));
    expect(turningPoint(blip)).toBeNull();
    // close values are a tie, not a lead
    expect(leaderAt(sample(0, 1000, 1050))).toBeNull();
    // no flip, but red pulled away decisively at 50 s and stayed there
    const steady = [0, 10, 20, 30, 40].map((t) => sample(t, 300, 500));
    for (let t = 50; t <= 120; t += 5) steady.push(sample(t, 300, 1600));
    expect(turningPoint(steady)).toBeNull();
    expect(pulledAway(steady)).toMatchObject({ t: 50, leader: "red" });
    const m = moments({ samples: steady, deaths: [], refs: { width: 48, height: 48, hq: {} } }, "blue");
    expect(m[0]).toMatchObject({ kind: "lead", title: "Échappée", tone: "bad" });
  });

  it("phrases moments for the player and for spectators", () => {
    const refs = { width: 48, height: 48, hq: { blue: { x: 6, y: 42 }, red: { x: 42, y: 6 } } };
    const deaths = [
      death(40, 40, 8, "red", { unitKind: "harvester", killerKind: "wasp" }),
      ...[0, 1, 2, 3].map((i) => death(200 + i, 24, 24 + i * 0.2, "red")),
      death(201, 24, 25, "blue")
    ];
    const s = [0, 5, 10, 20, 30, 40, 50].map((t) => sample(t, 200, 900));
    for (let t = 60; t <= 120; t += 5) s.push(sample(t, 1500, 400));
    const mine = moments({ samples: s, deaths, refs }, "blue");
    expect(mine.map((m) => m.kind)).toEqual(["first-blood", "turn", "battle"]);
    expect(mine[0]!.text).toBe("Ton Éole a éliminé leur Fardier");
    expect(mine[0]!.tone).toBe("good");
    expect(mine[2]!.text).toBe("Au centre : tu as perdu 1, l'ennemi a perdu 4");
    expect(mine[1]!.text).toMatch(/^Ton armée a dépassé la leur/);
    const spec = moments({ samples: s, deaths, refs }, null);
    expect(spec[0]!.text).toBe("L'Éole bleu a éliminé le Fardier rouge");
    expect(spec.every((m) => m.tone === "neutral")).toBe(true);
    expect(placeName(refs, 8, 40, "blue")).toBe("à ta base");
    expect(placeName(refs, 24, 4, null)).toBe("au nord");
  });

  it("picks one actionable tip by rule", () => {
    const base: TipInput = {
      pov: "blue", won: false, duration: 600, difficulty: "normal",
      built: { blue: { stinger: 10, "tech-lab": 1 }, red: { wasp: 5, hornet: 3 } },
      firstBuilt: { blue: { "tech-lab": 200 }, red: {} },
      deaths: [], samples: [], factories: { blue: { total: 100, idleRich: 5 }, red: { total: 100, idleRich: 0 } }
    };
    expect(pickTip(base)).toMatch(/8 aéronefs.*DCA/);
    const lostHarv = { ...base, built: { blue: { flak: 0, "flak-crawler": 4 }, red: {} }, deaths: [...Array(6)].map((_, i) => death(i, 5, 5, "blue", { unitKind: "harvester" })) };
    expect(pickTip(lostHarv)).toMatch(/perdu 6 Fardiers/);
    const idle = { ...base, built: { blue: { "flak-crawler": 3 }, red: {} }, factories: { blue: { total: 100, idleRich: 45 }, red: { total: 0, idleRich: 0 } } };
    expect(pickTip(idle)).toMatch(/arrêt .* 45 %/);
    const won = { ...base, won: true, built: { blue: { "flak-crawler": 3 }, red: {} } };
    expect(pickTip(won)).toMatch(/IA plus coriace/);
    // a swarm of robot infantry met with no splash or Snipers; Mastodons met with no Rocket Squads
    const swarm = { ...base, built: { blue: { "flak-crawler": 3, mastodon: 6 }, red: { trooper: 7, "rocket-squad": 3 } } };
    expect(pickTip(swarm)).toMatch(/10 escouades d'infanterie.*Canons de 75/);
    expect(pickTip({ ...swarm, built: { ...swarm.built, blue: { "flak-crawler": 3, mortar: 2 } } })).not.toMatch(/infanterie/);
    const mastodons = { ...base, built: { blue: { "flak-crawler": 3 }, red: { mastodon: 5 } } };
    expect(pickTip(mastodons)).toMatch(/5 Creusot.*Artificiers/);
    expect(pickTip({ ...mastodons, built: { ...mastodons.built, blue: { "flak-crawler": 3, "rocket-squad": 3 } } })).not.toMatch(/Creusot/);
  });

  it("records a real match: samples, kills, and an MVP that matches the best unit", () => {
    const w: World = createMapWorld("frostbite", { seed: 11 });
    const c = new Chronicle(w);
    const red = createAiState("rush", "normal", 1);
    const blue = createAiState("balanced", "normal", 2);
    for (let i = 0; i < 5 * 60 * TICK_RATE && !w.winner; i++) {
      step(w, [...tickAi(w, "red", red), ...tickAi(w, "blue", blue)]);
      for (const ev of w.fx) c.onFx(ev);
      c.tick();
    }
    c.finish();
    expect(c.samples.length).toBeGreaterThan(30);
    expect(c.samples.every((s, i) => i === 0 || s.t > c.samples[i - 1]!.t)).toBe(true);
    const unitDeaths = c.deaths.filter((d) => d.unitKind).length;
    expect(unitDeaths).toBe(w.factions.blue.stats.unitsLost + w.factions.red.stats.unitsLost);
    const mvp = c.mvp();
    for (const f of ["blue", "red"] as const) {
      const live = Math.max(0, ...[...w.units.values()].filter((u) => u.faction === f).map((u) => u.kills));
      if (mvp[f]) expect(mvp[f]!.kills).toBeGreaterThanOrEqual(live);
      else expect(live).toBe(0);
    }
    expect(Object.values(c.built.blue).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});

describe("chronicle: squads riding in a Montgolfière", () => {
  it("still count toward the army, and a veteran aboard can still be the MVP", () => {
    const w = createMapWorld("frostbite", { seed: 3 });
    const c = new Chronicle(w);
    const hq = buildingCenter(hqOf(w, "blue")!);
    const condor = spawnUnit(w, "condor", "blue", hq.x + 4, hq.y + 4);
    const ace = spawnUnit(w, "sniper", "blue", hq.x + 4, hq.y + 5);
    ace.kills = 7;
    ace.rank = 2;
    c.sample();
    const before = c.samples.at(-1)!.army.blue;
    w.units.delete(ace.id);
    condor.passengers!.push(ace);
    c.sample();
    expect(c.samples.at(-1)!.army.blue).toBeCloseTo(before);
    expect(c.mvp().blue).toMatchObject({ id: ace.id, kind: "sniper", kills: 7, alive: true });
  });
});

describe("promotion titles", () => {
  it("float over an enemy veteran in sight, never over a Sniper Team hidden in the woods", () => {
    const w = createWorld(32, 32);
    setTerrain(w, 10, 10, Terrain.Forest);
    spawnUnit(w, "scout", "blue", 5.5, 10.5); // 5 tiles off: the woods tile is in sight
    const sniper = spawnUnit(w, "sniper", "red", 10.5, 10.5);
    const mastodon = spawnUnit(w, "mastodon", "red", 8.5, 13.5);
    sniper.rank = mastodon.rank = 2;
    w.tick = 100;
    tickFog(w);
    expect(isVisible(w, "blue", 10, 10)).toBe(true);
    const titles: string[] = [];
    const view = {
      rig: { onScreen: () => true },
      screen: { label: (o: { text: string }) => (titles.push(o.text), { ...o }), remove: () => {} },
      tweens: { add: () => {}, kill: () => {} }
    } as unknown as View;
    const hp = new HeroPresenter(view, w, {
      player: "blue", spectator: false, seesPoint: () => true, seesUnit: (u) => unitSeenBy(w, "blue", u),
      unitPos: () => null, notify: () => {}
    });
    // (a Veterans crate promotes everything near the collector, the hidden sniper included)
    hp.handleFx({ type: "rankUp", id: sniper.id });
    expect(titles).toEqual([]);
    hp.handleFx({ type: "rankUp", id: mastodon.id });
    expect(titles).toEqual(["AGUERRI"]);
  });
});

describe("after-action report stats", () => {
  it("reads stats added by other features defensively", () => {
    const core: FactionStats = { unitsBuilt: 1, unitsLost: 2, unitsKilled: 3, buildingsLost: 0, buildingsKilled: 1, scrapHarvested: 500, scrapSalvaged: 0 };
    expect(extraStatRows(core, core)).toEqual([]);
    // (scrap salvaged is a core row now; extras are what later features add)
    const blue = { ...core, scrapSalvaged: 240, uplinkSeconds: 40, weirdThing: 3, flag: true } as unknown as FactionStats;
    const red = { ...core, scrapSalvaged: 80 } as unknown as FactionStats;
    const rows = extraStatRows(blue, red);
    expect(rows[0]).toEqual({ label: "Temps de liaison (s)", a: 40, b: 0 });
    expect(rows.some((r) => r.label === "Charbon récupérée")).toBe(false);
    expect(rows.find((r) => r.label === "Weird thing")).toEqual({ label: "Weird thing", a: 3, b: 0 });
    expect(rows.some((r) => r.label === "Flag")).toBe(false);
  });
});
