import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Faction, FxEvent, UnitKind, World } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";
import type { Announcement } from "../src/game/announce";
import { CALLOUTS, RADIO, BattleCallouts, RadioQueue, speakable, type RadioLine } from "../src/game/callouts";
import { lineSeconds } from "../src/game/announcer";
import { CHIRP, ChirpGate, VOICES, chirpPlan, groupVoices, voicePitch, type VoiceLine } from "../src/game/voices";

const KINDS = Object.keys(VOICES) as UnitKind[];
const LINES: VoiceLine[] = ["select", "move", "attack", "ready", "rank", "death"];

describe("unit chirp-voices", () => {
  it("every line of every voice is short and well-formed", () => {
    for (const kind of KINDS)
      for (const line of LINES)
        for (const id of [1, 77, 4242]) {
          const p = chirpPlan(kind, line, id);
          expect(p.length).toBeGreaterThan(40);
          expect(p.length).toBeLessThanOrEqual(CHIRP.maxMs);
          expect(p.length).toBeLessThan(400);
          let prevEnd = -1;
          for (const s of p.syllables) {
            expect(s.at).toBeGreaterThanOrEqual(prevEnd - 1e-9);
            expect(s.at + s.dur).toBeLessThanOrEqual(p.length + 1e-9);
            expect(s.from).toBeGreaterThan(20);
            expect(s.to).toBeGreaterThan(20);
            prevEnd = s.at + s.dur;
          }
          for (const x of [p.bark, p.crackle, ...(p.sparkle ?? [])])
            if (x) expect(x.at + x.dur).toBeLessThanOrEqual(p.length + 1e-9);
        }
  });

  it("gives each line its shape: rising select, falling death, extras where promised", () => {
    const sel = chirpPlan("stinger", "select", 5);
    expect(sel.syllables).toHaveLength(2);
    expect(sel.syllables[1]!.to).toBeGreaterThan(sel.syllables[0]!.from);
    const death = chirpPlan("stinger", "death", 5);
    expect(death.syllables[0]!.to).toBeLessThan(death.syllables[0]!.from);
    expect(death.crackle).toBeDefined();
    expect(chirpPlan("wasp", "attack", 5).bark).toBeDefined();
    expect(chirpPlan("mender", "rank", 5).sparkle).toHaveLength(2);
    expect(chirpPlan("mastodon", "rank", 5).syllables).toHaveLength(4);
    expect(chirpPlan("mastodon", "move", 5).syllables.at(-1)!.to).toBeLessThan(chirpPlan("mastodon", "move", 5).syllables.at(-1)!.from);
  });

  it("heavy hulls speak low, drones and menders high", () => {
    const f = (k: UnitKind) => chirpPlan(k, "select", 1).syllables[0]!.from;
    expect(f("mastodon")).toBeLessThan(f("stinger"));
    expect(f("hornet")).toBeLessThan(f("wasp"));
    expect(f("mender")).toBeGreaterThan(f("harvester"));
  });

  it("every unit kind has a voice; troopers chirp high, rocket crews gruff, snipers low and calm", () => {
    for (const k of Object.keys(UNITS) as UnitKind[]) expect(VOICES[k], k).toBeDefined();
    const f = (k: UnitKind) => chirpPlan(k, "select", 1).syllables[0]!.from;
    expect(f("trooper")).toBeGreaterThan(f("rocket-squad"));
    expect(f("rocket-squad")).toBeGreaterThan(f("sniper"));
    expect(VOICES["rocket-squad"].fm).toBeDefined(); // a growl
    expect(VOICES.sniper.syl).toBeGreaterThan(VOICES.trooper.syl * 2); // unhurried
    expect(VOICES.condor.fm!.depth).toBeGreaterThan(0.1); // the rotor chop
    expect(f("condor")).toBeLessThan(f("trooper"));
  });

  it("jitters pitch by unit id, deterministically, within ±6%", () => {
    const seen = new Set<number>();
    for (let id = 1; id < 500; id++) {
      const p = voicePitch(id);
      expect(p).toBeGreaterThanOrEqual(1 - CHIRP.jitter);
      expect(p).toBeLessThanOrEqual(1 + CHIRP.jitter);
      expect(voicePitch(id)).toBe(p);
      seen.add(Math.round(p * 1000));
    }
    expect(seen.size).toBeGreaterThan(60); // a group sounds like a chorus, not a unison
  });

  it("rate-limits: ≥ 250 ms between lines, unprompted lines rarer still", () => {
    const g = new ChirpGate();
    expect(g.allow("select", 1000)).toBe(true);
    expect(g.allow("move", 1000 + CHIRP.minGapMs - 1)).toBe(false);
    expect(g.allow("move", 1000 + CHIRP.minGapMs)).toBe(true);
    // unprompted lines wait for the player's chirps to clear…
    expect(g.allow("ready", 1250 + CHIRP.afterUserMs - 1)).toBe(false);
    expect(g.allow("ready", 1250 + CHIRP.afterUserMs)).toBe(true);
    // …and keep their own spacing
    const t = 1250 + CHIRP.afterUserMs;
    expect(g.allow("ready", t + 300)).toBe(false);
    expect(g.allow("death", t + 300)).toBe(true);
    expect(g.allow("death", t + 300 + CHIRP.autoGapMs.death! - 1)).toBe(false);
    expect(g.allow("ready", t + CHIRP.autoGapMs.ready!)).toBe(true);
    // the player's own lines are never held back by unprompted ones beyond the base gap
    expect(g.allow("attack", t + CHIRP.autoGapMs.ready! + CHIRP.minGapMs)).toBe(true);
  });

  it("lets the majority kind lead a group, with one echo voice", () => {
    expect(groupVoices([])).toBeNull();
    expect(groupVoices([{ id: 1, kind: "mastodon" }])).toEqual({ lead: { kind: "mastodon", id: 1 }, echo: null });
    const mixed = groupVoices([
      { id: 1, kind: "wasp" }, { id: 2, kind: "mastodon" }, { id: 3, kind: "wasp" }, { id: 4, kind: "stinger" }, { id: 5, kind: "mastodon" }, { id: 6, kind: "wasp" }
    ])!;
    expect(mixed.lead).toEqual({ kind: "wasp", id: 1 });
    expect(mixed.echo?.kind).toBe("mastodon");
    const trio = groupVoices([{ id: 7, kind: "raptor" }, { id: 8, kind: "raptor" }, { id: 9, kind: "raptor" }])!;
    expect(trio.echo).toEqual({ kind: "raptor", id: 8 });
    expect(groupVoices([{ id: 7, kind: "raptor" }, { id: 8, kind: "raptor" }])!.echo).toBeNull();
  });
});

// ---------------------------------------------------------------- radio --

const line = (key: string, priority: number, over: Partial<RadioLine> = {}): RadioLine => ({
  key, text: key, priority, tone: "info", caption: false, ...over
});

describe("radio queue", () => {
  it("delivers the most important line first, then waits out the gap", () => {
    const q = new RadioQueue();
    q.push(line("flavour", 3), 0);
    q.push(line("warning", 0), 0.1);
    expect(q.next(0.2)?.key).toBe("warning");
    expect(q.next(0.2 + RADIO.gapS - 0.01)).toBeNull();
    expect(q.next(0.2 + RADIO.gapS, true)).toBeNull(); // still talking
    expect(q.next(2.9)?.key).toBe("flavour");
  });

  it("drops stale lines (critical ones keep longer) and refreshes duplicates", () => {
    const q = new RadioQueue();
    q.push(line("a", 2), 0);
    q.push(line("crit", 0), 0);
    expect(q.next(0)?.key).toBe("crit");
    expect(q.next(RADIO.staleS + 0.1)).toBeNull(); // "a" went stale while we waited
    q.push(line("crit", 0), 10);
    q.push(line("crit", 0), 11); // refreshed, not doubled
    expect(q.size).toBe(1);
    expect(q.next(11 + RADIO.staleCriticalS - 0.1)?.key).toBe("crit");
  });

  it("keeps at most two waiting lines, losing the least important", () => {
    const q = new RadioQueue();
    q.push(line("p3", 3), 0);
    q.push(line("p1", 1), 0);
    q.push(line("p2", 2), 0);
    expect(q.size).toBe(RADIO.cap);
    expect(q.next(0)?.key).toBe("p1");
    expect(q.next(RADIO.gapS)?.key).toBe("p2");
    expect(q.next(RADIO.gapS * 2)).toBeNull();
  });

  it("budgets routine chatter but never holds back a warning", () => {
    const q = new RadioQueue();
    let t = 0;
    for (let i = 0; i < RADIO.budget.max; i++) {
      q.push(line(`r${i}`, 2), t);
      expect(q.next(t)?.key).toBe(`r${i}`);
      t += RADIO.gapS;
    }
    q.push(line("routine", 2), t);
    expect(q.next(t)).toBeNull();
    q.push(line("warn", 1), t);
    expect(q.next(t)?.key).toBe("warn");
  });

  it("lets the final line skip the gap", () => {
    const q = new RadioQueue();
    q.push(line("x", 2), 0);
    q.next(0);
    q.push(line("victory", 0), 0.5);
    expect(q.next(0.5)).toBeNull();
    expect(q.next(0.5, false, true)?.key).toBe("victory");
  });

  it("turns banner text into something worth saying", () => {
    expect(speakable("SUPPLY DROP INBOUND")).toBe("Supply drop inbound");
    expect(speakable("⚡ ENEMY HQ DESTROYED!")).toBe("Enemy HQ destroyed!");
    expect(speakable("First blood")).toBe("First blood");
    expect(speakable("⚡ GQG ENNEMI DÉTRUIT !")).toBe("GQG ennemi détruit !");
    expect(speakable("Wave 5 — Mastodons")).toBe("Wave 5 Mastodons");
    expect(lineSeconds("Warning: our HQ is under attack")).toBeGreaterThan(1.5);
    expect(lineSeconds("Squad lost")).toBeLessThan(1.2);
  });
});

// ------------------------------------------------------------- callouts --

type Death = Extract<FxEvent, { type: "death" }>;
const death = (over: Partial<Death>): Death => ({
  type: "death", id: 900, faction: "red", unitKind: "stinger", buildingKind: null, x: 20, y: 20, air: false,
  value: 150, killerId: null, killerKind: null, rank: 0, kills: 0, ...over
});
const hit = (faction: Faction, id: number, building: boolean, x = 20, y = 20): FxEvent => ({
  type: "hit", faction, id, x, y, building, attackerId: 0
});

function rig(opts: { spectator?: boolean; onScreen?: (x: number, y: number) => boolean; world?: World } = {}) {
  const w = opts.world ?? createWorld(48, 48);
  const radio: (RadioLine & { t: number })[] = [];
  const banners: (Announcement & { t: number })[] = [];
  let now = 0;
  const c = new BattleCallouts({
    world: w, player: "blue", spectator: opts.spectator ?? false,
    onScreen: opts.onScreen ?? (() => false),
    radio: (l) => radio.push({ ...l, t: now }),
    announce: (a) => banners.push({ ...a, t: now })
  });
  const at = (t: number, ...fx: FxEvent[]) => {
    now = t;
    c.events(fx, t);
  };
  return { w, c, radio, banners, at, keys: () => radio.map((r) => r.key) };
}

describe("battle callouts", () => {
  it("warns about HQ hits at P0 with a cooldown, longer when the HQ is in view", () => {
    let visible = false;
    const r = rig({ onScreen: () => visible });
    const hq = spawnBuilding(r.w, "hq", "blue", 4, 4);
    r.at(1, hit("blue", hq.id, true));
    r.at(2, hit("blue", hq.id, true));
    expect(r.radio).toHaveLength(1);
    expect(r.radio[0]).toMatchObject({ key: "hq-attack", priority: 0, tone: "bad", caption: false });
    r.at(1 + CALLOUTS.cooldownS["hq-attack"]!, hit("blue", hq.id, true));
    expect(r.radio).toHaveLength(2);
    visible = true;
    r.at(1 + 2 * CALLOUTS.cooldownS["hq-attack"]!, hit("blue", hq.id, true));
    expect(r.radio).toHaveLength(2); // in view: the longer cooldown applies
  });

  it("calls out base attacks only off screen, never for enemy buildings", () => {
    let visible = true;
    const r = rig({ onScreen: () => visible });
    const fab = spawnBuilding(r.w, "fab-plant", "blue", 4, 4);
    const enemyFab = spawnBuilding(r.w, "fab-plant", "red", 30, 30);
    r.at(1, hit("blue", fab.id, true), hit("red", enemyFab.id, true));
    expect(r.radio).toHaveLength(0);
    visible = false;
    r.at(2, hit("blue", fab.id, true));
    expect(r.keys()).toEqual(["base-attack"]);
  });

  it("reports a squad lost after three own deaths inside three seconds", () => {
    const r = rig({ onScreen: () => true });
    r.at(1, death({ faction: "blue", id: 1 }));
    r.at(2, death({ faction: "blue", id: 2 }));
    expect(r.keys()).toEqual([]);
    r.at(3.5, death({ faction: "blue", id: 3 }));
    expect(r.keys()).toEqual(["squad-lost"]);
    expect(r.radio[0]!.caption).toBe(true);
    // spread-out losses don't count
    const s = rig({ onScreen: () => true });
    s.at(1, death({ faction: "blue", id: 1 }));
    s.at(5, death({ faction: "blue", id: 2 }));
    s.at(9, death({ faction: "blue", id: 3 }));
    expect(s.keys()).toEqual([]);
  });

  it("names expensive losses and harvesters lost out of view", () => {
    const r = rig({ onScreen: () => false });
    r.at(1, death({ faction: "blue", unitKind: "mastodon", value: 475 }));
    r.at(30, death({ faction: "blue", unitKind: "harvester", value: 150 }));
    r.at(60, death({ faction: "blue", unitKind: "stinger", value: 150 }));
    expect(r.radio.map((l) => l.text)).toEqual(["Creusot perdu", "Fardier perdu"]);
  });

  it("calls first blood once, for the player's first kill", () => {
    const r = rig();
    r.at(1, death({ faction: "blue" })); // the enemy's kill: not ours
    expect(r.banners).toHaveLength(0);
    r.at(2, death({ faction: "red", unitKind: "wasp" }));
    expect(r.banners).toHaveLength(1);
    expect(r.banners[0]).toMatchObject({ key: "first-blood", text: "Premier sang", tone: "epic", sub: "Éole ennemi détruit" });
    r.at(30, death({ faction: "red" }));
    r.at(60, death({ faction: "red" }));
    expect(r.banners.filter((b) => b.key === "first-blood")).toHaveLength(1);
  });

  it("calls kill streaks after a short hold, upgrading to the highest tier", () => {
    const r = rig();
    r.at(1, death({ faction: "red" })); // first blood
    // a fast double that becomes a triple inside the hold → one "Triple kill"
    r.at(20, death({ faction: "red" }));
    r.at(20.5, death({ faction: "red" }));
    r.at(20.8, death({ faction: "red" }));
    r.at(21.5);
    expect(r.banners.map((b) => b.key)).toEqual(["first-blood", "streak-3"]);
    // two more inside the window: five → Rampage
    r.at(22, death({ faction: "red" }));
    r.at(23, death({ faction: "red" }));
    r.at(24);
    expect(r.banners.at(-1)).toMatchObject({ key: "streak-5", text: "Carnage", tone: "epic" });
    // kills too far apart never streak
    const s = rig();
    s.at(1, death({ faction: "red" }));
    s.at(10, death({ faction: "red" }));
    s.at(15, death({ faction: "red" }));
    s.at(20);
    expect(s.banners.map((b) => b.key)).toEqual(["first-blood"]);
  });

  it("keeps streak banners sparing: per-tier cooldowns and a gap between kill banners", () => {
    const r = rig();
    r.at(1, death({ faction: "red" }));
    r.at(20, death({ faction: "red" }), death({ faction: "red" }));
    r.at(21);
    r.at(30, death({ faction: "red" }), death({ faction: "red" }));
    r.at(31);
    expect(r.banners.filter((b) => b.key === "streak-2")).toHaveLength(1); // cooldown
    // a double right after first blood is swallowed by the banner gap
    const s = rig();
    s.at(1, death({ faction: "red" }), death({ faction: "red" }));
    s.at(3);
    expect(s.banners.map((b) => b.key)).toEqual(["first-blood"]);
  });

  it("gives expensive kills their own banner, or a line under a streak", () => {
    const r = rig();
    r.at(1, death({ faction: "red" }));
    r.at(20, death({ faction: "red", unitKind: "mastodon", value: 475 }));
    expect(r.banners.at(-1)).toMatchObject({ key: "kill-mastodon", text: "Creusot abattu", say: "Creusot ennemi détruit", tone: "good" });
    const s = rig();
    s.at(1, death({ faction: "red" }));
    s.at(20, death({ faction: "red" }), death({ faction: "red", unitKind: "hornet", value: 375 }));
    s.at(21);
    expect(s.banners.at(-1)).toMatchObject({ key: "streak-2", sub: "Albatros détruit" });
  });

  it("announces structures destroyed and lost", () => {
    const r = rig();
    r.at(1, death({ faction: "red", unitKind: null, buildingKind: "airpad", value: 350 }));
    r.at(2, death({ faction: "blue", unitKind: null, buildingKind: "turret", value: 225 }));
    expect(r.radio.map((l) => [l.key, l.text])).toEqual([
      ["structure-killed", "Parc de Chalais-Meudon ennemi détruit"],
      ["structure-lost", "Bâtiment perdu : Hotchkiss"]
    ]);
  });

  it("spots the first visible enemy combat aircraft, and re-arms after a long absence", () => {
    const r = rig();
    spawnUnit(r.w, "stinger", "blue", 10, 10); // our eyes
    const scout = spawnUnit(r.w, "scout", "red", 11, 10); // unarmed: not worth a warning
    const far = spawnUnit(r.w, "wasp", "red", 40, 40); // in the fog
    tickFog(r.w);
    r.at(1);
    expect(r.keys()).toEqual([]);
    far.x = 11.5;
    far.y = 11;
    tickFog(r.w);
    r.at(2);
    expect(r.radio).toHaveLength(1);
    expect(r.radio[0]).toMatchObject({ key: "enemy-air", text: "Aviation ennemie détectée", caption: true });
    r.at(10);
    expect(r.radio).toHaveLength(1);
    r.w.units.delete(far.id);
    r.w.units.delete(scout.id);
    r.at(20);
    const back = spawnUnit(r.w, "hornet", "red", 11, 11);
    tickFog(r.w);
    r.at(30);
    expect(r.radio).toHaveLength(1); // not yet re-armed
    r.w.units.delete(back.id);
    r.at(30 + CALLOUTS.airRearmS - 1);
    spawnUnit(r.w, "hornet", "red", 11, 11);
    tickFog(r.w);
    r.at(30 + CALLOUTS.airRearmS);
    expect(r.radio).toHaveLength(1); // seen again before the absence was long enough
    for (const u of [...r.w.units.values()]) if (u.faction === "red") r.w.units.delete(u.id);
    r.at(30 + 2 * CALLOUTS.airRearmS + 1); // a long absence re-arms the warning
    spawnUnit(r.w, "hornet", "red", 11, 11);
    tickFog(r.w);
    r.at(30 + 2 * CALLOUTS.airRearmS + 2);
    expect(r.radio).toHaveLength(2);
  });

  it("says construction complete once per finished structure, and promotions from rank 2", () => {
    const r = rig();
    r.w.factions.blue.pending = { kind: "fab-plant", remaining: 0, ready: true };
    r.at(1);
    r.at(2);
    expect(r.keys()).toEqual(["construction"]);
    r.w.factions.blue.pending = null;
    r.at(3);
    r.w.factions.blue.pending = { kind: "airpad", remaining: 0, ready: true };
    r.at(4);
    expect(r.keys()).toEqual(["construction", "construction"]);
    const vet = spawnUnit(r.w, "mastodon", "blue", 5, 5);
    vet.rank = 1;
    r.at(5, { type: "rankUp", id: vet.id });
    vet.rank = 2;
    r.at(6, { type: "rankUp", id: vet.id });
    expect(r.radio.at(-1)).toMatchObject({ key: "promoted", text: "Creusot promu", priority: 3 });
  });

  it("closes with victory or defeat, then falls silent", () => {
    const r = rig();
    r.w.winner = "blue";
    r.at(100);
    expect(r.radio.at(-1)).toMatchObject({ key: "victory", priority: 0, tone: "epic" });
    r.at(101, death({ faction: "red" }), death({ faction: "red" }));
    r.at(103);
    expect(r.radio).toHaveLength(1);
    expect(r.banners).toHaveLength(0);
    const l = rig();
    l.w.winner = "red";
    l.at(5);
    expect(l.radio[0]).toMatchObject({ key: "defeat", tone: "bad" });
  });

  it("speaks like a neutral caster to spectators", () => {
    const r = rig({ spectator: true });
    const redHq = spawnBuilding(r.w, "hq", "red", 30, 30);
    r.at(1, hit("red", redHq.id, true));
    expect(r.radio[0]).toMatchObject({ text: "GQG Rouge attaqué", caption: true });
    r.at(2, death({ faction: "red" }));
    expect(r.banners[0]).toMatchObject({ key: "first-blood", sub: "Bleu frappe en premier", say: "Premier sang pour Bleu" });
    r.at(20, death({ faction: "blue" }), death({ faction: "blue" }));
    r.at(21);
    expect(r.banners.at(-1)).toMatchObject({ key: "streak-2", sub: "Rouge", say: "Doublé pour Rouge" });
    r.at(30, death({ faction: "red", unitKind: null, buildingKind: "fab-plant" }));
    expect(r.radio.at(-1)!.text).toBe("Forges Rouge détruites");
    // no player-only lines for a spectator
    r.w.factions.blue.pending = { kind: "fab-plant", remaining: 0, ready: true };
    r.at(40, death({ faction: "blue" }), death({ faction: "blue" }), death({ faction: "blue" }));
    expect(r.radio.some((l) => l.key === "construction" || l.key === "squad-lost")).toBe(false);
    r.w.winner = "red";
    r.at(50);
    expect(r.radio.at(-1)!.text).toBe("Rouge remporte la bataille");
  });

  it("Montgolfière drops: ours is flavour, the enemy's a warning where we see it; shot down says what happened", () => {
    let visible = false;
    const r = rig({ onScreen: () => visible });
    const drop = (faction: Faction, carrierId: number, unitIds: number[], bailout = false, x = 20, y = 20): FxEvent => ({
      type: "disembark", faction, carrierId, unitIds, x, y, bailout
    });
    const embark = (faction: Faction, carrierId: number, unitId: number): FxEvent => ({
      type: "embark", faction, carrierId, unitId, x: 20, y: 20
    });
    r.at(1, embark("blue", 50, 51), embark("blue", 50, 52));
    r.at(10, drop("blue", 50, [51, 52]));
    expect(r.radio.at(-1)).toMatchObject({ key: "troops-deployed", priority: 3, caption: true });
    visible = true;
    r.at(12, drop("blue", 50, [51])); // (cooldown)
    expect(r.keys()).toEqual(["troops-deployed"]);
    // the enemy lands troops where we can't see: nothing; where we can: a warning
    r.at(20, drop("red", 60, [61], false, 40, 40));
    expect(r.keys()).toEqual(["troops-deployed"]);
    spawnUnit(r.w, "stinger", "blue", 40, 41);
    tickFog(r.w);
    r.at(21, drop("red", 60, [61], false, 40, 40));
    expect(r.radio.at(-1)).toMatchObject({ key: "enemy-drop", text: "Débarquement ennemi !", priority: 1, tone: "bad" });
    // our Condor shot down over land: its squads bail out
    r.at(30, embark("blue", 70, 71));
    r.at(40, death({ faction: "blue", id: 70, unitKind: "condor", value: 200 }), drop("blue", 70, [71], true));
    expect(r.radio.at(-1)).toMatchObject({ key: "condor-down", text: "Montgolfière abattue ! Les troupes sautent", priority: 1 });
    // …over water: lost with it — one line, not "Squad lost" on top
    r.at(60, embark("blue", 80, 81), embark("blue", 80, 82));
    r.at(80,
      death({ faction: "blue", id: 80, unitKind: "condor", value: 200 }),
      death({ faction: "blue", id: 81, unitKind: "trooper", value: 100 }),
      death({ faction: "blue", id: 82, unitKind: "trooper", value: 100 })
    );
    expect(r.radio.at(-1)).toMatchObject({ key: "condor-down", text: "Montgolfière abattue avec 2 escouades à bord" });
    expect(r.keys().filter((k) => k === "squad-lost")).toEqual([]);
    // an empty Condor going down is just a unit lost
    const before = r.radio.length;
    r.at(120, death({ faction: "blue", id: 90, unitKind: "condor", value: 200 }));
    expect(r.radio.length).toBe(before);
  });

  it("answers the HUD's no-scrap cue, sparingly", () => {
    const r = rig();
    r.c.cue("no-scrap", 1);
    r.c.cue("no-scrap", 2);
    expect(r.keys()).toEqual(["no-scrap"]);
    r.c.cue("no-scrap", 1 + CALLOUTS.cooldownS["no-scrap"]!);
    expect(r.keys()).toEqual(["no-scrap", "no-scrap"]);
  });

  it("stays pleasant in a busy AI-vs-AI battle: nothing fires constantly", () => {
    const w = createMapWorld("proving-grounds", { seed: 4242 });
    const blue = createAiState("rush", "normal", 11);
    const red = createAiState("boom", "normal", 12);
    const hq = buildingCenter(hqOf(w, "blue")!);
    const q = new RadioQueue();
    const delivered: { t: number; key: string }[] = [];
    const banners: { t: number; key: string }[] = [];
    let t = 0;
    let busyUntil = 0;
    const c = new BattleCallouts({
      world: w, player: "blue", spectator: false,
      onScreen: (x, y) => Math.abs(x - hq.x) <= 5.1 && Math.abs(y - hq.y) <= 8.4,
      radio: (l) => q.push(l, t),
      announce: (a) => {
        banners.push({ t, key: a.key });
        q.push({ key: `banner:${a.key}`, text: speakable(a.text), priority: a.priority ?? 2, tone: a.tone ?? "info", caption: false }, t);
      }
    });
    while (!w.winner && w.tick < 9 * 60 * TICK_RATE) {
      step(w, [...tickAi(w, "blue", blue), ...tickAi(w, "red", red)]);
      t = w.tick / TICK_RATE;
      c.events(w.fx, t);
      const l = q.next(t, t < busyUntil);
      if (l) {
        delivered.push({ t, key: l.key });
        busyUntil = t + lineSeconds(l.text) + 0.25;
      }
    }
    const mins = w.tick / TICK_RATE / 60;
    const max60 = (xs: { t: number }[]) => Math.max(0, ...xs.map((x) => xs.filter((y) => y.t >= x.t && y.t < x.t + 60).length));
    expect(mins).toBeGreaterThan(2);
    expect(delivered.length).toBeGreaterThan(5); // it does talk…
    expect(delivered.length / mins).toBeLessThan(6.5); // …but averages a line per ~10 s or less
    expect(max60(delivered)).toBeLessThanOrEqual(10);
    expect(banners.length / mins).toBeLessThan(2.5);
    expect(max60(banners)).toBeLessThanOrEqual(6);
    for (let i = 1; i < delivered.length; i++)
      expect(delivered[i]!.t - delivered[i - 1]!.t).toBeGreaterThanOrEqual(RADIO.gapS - 1e-9);
  });
});
