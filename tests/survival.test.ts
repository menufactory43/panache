import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { isInfantry, squadSize } from "../src/sim/infantry";
import { MAPS, createMapWorld } from "../src/sim/maps";
import {
  SURVIVAL,
  THEME_COUNTERS,
  THEME_NAMES,
  earlyCallBonus,
  planWave,
  survivalHoldPoint,
  survivalStatus,
  waveBudget,
  waveName,
  waveRank,
  waveTheme,
  waveUnitsLeft,
  wavesSurvived,
  type SurvivalDifficulty,
  type WavePlan,
  type WaveTheme
} from "../src/sim/modes/survival";
import { findPath } from "../src/sim/movement";
import { step } from "../src/sim/sim";
import { Terrain, type FxEvent, type UnitKind, type World } from "../src/sim/types";
import { wreckValue } from "../src/sim/salvage";
import { buildingCenter, hqOf, passable, setTerrain, spawnUnit } from "../src/sim/world";
import { THEME_ICONS } from "../src/game/survival";

const lastStand = (map = "riverlands", seed = 42, difficulty: SurvivalDifficulty = "normal") =>
  createMapWorld(map, { seed, survival: { difficulty } });

/** Step with no player input until `until` matches an fx event (or the limit). */
function runUntil(w: World, until: (e: FxEvent) => boolean, maxTicks = 3000): FxEvent | null {
  for (let i = 0; i < maxTicks && !w.winner; i++) {
    step(w, []);
    const hit = w.fx.find(until);
    if (hit) return hit;
  }
  return null;
}

const red = (w: World) => [...w.units.values()].filter((u) => u.faction === "red");
/** Keep the defender's HQ standing so a test can watch many waves. */
const shieldHq = (w: World) => {
  const hq = hqOf(w, "blue")!;
  hq.hp = 1e9;
};

describe("Last Stand setup", () => {
  it("leaves skirmish worlds untouched without the option", () => {
    const w = createMapWorld("riverlands");
    expect(w.survival).toBeFalsy();
    expect(hqOf(w, "red")).not.toBeNull();
    // red keeps its starting harvester and Trooper Squad
    expect(red(w).map((u) => u.kind).sort()).toEqual(["harvester", "trooper"]);
  });

  it("removes the red base and economy and schedules wave 1", () => {
    const w = lastStand();
    expect([...w.buildings.values()].every((b) => b.faction === "blue")).toBe(true);
    expect(red(w)).toHaveLength(0);
    expect(w.factions.red.scrap).toBe(0);
    expect(hqOf(w, "blue")).not.toBeNull();
    expect([...w.units.values()].filter((u) => u.kind === "harvester")).toHaveLength(1);
    expect(w.survival!.wave).toBe(0);
    expect(w.survival!.nextWaveTick).toBe(SURVIVAL.firstWave.normal * TICK_RATE);
    expect(lastStand("riverlands", 42, "easy").survival!.nextWaveTick).toBeGreaterThan(w.survival!.nextWaveTick);
  });
});

describe("wave schedule", () => {
  it("is a pure function of the match seed", () => {
    const a = lastStand("dune-sea", 7);
    const b = lastStand("dune-sea", 7);
    const c = lastStand("dune-sea", 8);
    const plans = (w: World) => Array.from({ length: 25 }, (_, i) => planWave(w, i + 1));
    expect(plans(a)).toEqual(plans(b));
    expect(plans(a)).not.toEqual(plans(c));
    // asking again, or out of order, changes nothing (no hidden state)
    expect(planWave(a, 12)).toEqual(plans(b)[11]);
    expect(planWave(a, 3, "hard")).toEqual(planWave(b, 3, "hard"));
  });

  it("rotates five regular themes through the four slots of each block, then a boss", () => {
    const regular = [...SURVIVAL.themes].sort();
    expect(regular).toEqual(["air", "armour", "artillery", "mixed", "swarm"]);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const w = lastStand("riverlands", seed);
      const benched: WaveTheme[] = [];
      for (let block = 0; block < 40; block++) {
        const themes = [1, 2, 3, 4].map((i) => waveTheme(w, block * 5 + i));
        expect(waveTheme(w, block * 5 + 5)).toBe("boss");
        // four different regular themes; the fifth sits this block out
        expect(new Set(themes).size).toBe(4);
        const out = regular.filter((t) => !themes.includes(t as WaveTheme));
        expect(out).toHaveLength(1);
        benched.push(out[0] as WaveTheme);
      }
      // every five blocks bench each theme once, and never one theme twice running
      for (let cycle = 0; cycle < 8; cycle++) expect([...benched.slice(cycle * 5, cycle * 5 + 5)].sort()).toEqual(regular);
      for (let i = 1; i < benched.length; i++) expect(benched[i]).not.toBe(benched[i - 1]);
      // the first block always shows the threats with their own answers (anti-air, anti-infantry)
      expect([1, 2, 3, 4].map((i) => waveTheme(w, i))).toEqual(expect.arrayContaining(["air", "swarm"]));
      // each boss is previewed in its block: an Air Raid before a Bomber Wing, and so on
      const preview: Record<string, WaveTheme> = { "Fer de lance Creusot": "armour", "Escadre de bombardiers": "air", "Force d'élite": "mixed" };
      for (let block = 0; block < 40; block++) {
        const boss = waveName(w, block * 5 + 5);
        expect([1, 2, 3, 4].map((i) => waveTheme(w, block * 5 + i)), `${boss} at ${block * 5 + 5}`).toContain(preview[boss]);
      }
      // so no theme is ever missing for more than 13 waves in a row
      for (const t of regular) {
        let last = 0;
        for (let n = 1; n <= 200; n++)
          if (waveTheme(w, n) === t) {
            expect(n - last, `${t} at ${n}`).toBeLessThanOrEqual(14);
            last = n;
          }
      }
    }
  });

  it("opens with a small ground wave and escalates", () => {
    const openers = new Set<WaveTheme>();
    for (let seed = 1; seed <= 30; seed++) {
      const w = lastStand("riverlands", seed);
      const first = planWave(w, 1);
      openers.add(first.theme);
      expect(["armour", "mixed", "swarm"]).toContain(first.theme);
      expect(first.units.every((k) => UNITS[k].domain === "ground" && UNITS[k].cost <= 200)).toBe(true);
      expect(first.units.length).toBeLessThanOrEqual(4);
    }
    expect(openers.has("swarm")).toBe(true); // a Bot Swarm may open, as small as the others
    for (let n = 1; n < 25; n++) expect(waveBudget("normal", n + 1)).toBeGreaterThan(waveBudget("normal", n) * (n % 5 === 0 ? 0.85 : 1));
    expect(waveBudget("easy", 8)).toBeLessThan(waveBudget("normal", 8));
    expect(waveBudget("hard", 8)).toBeGreaterThan(waveBudget("normal", 8));
    expect([waveRank(1), waveRank(5), waveRank(6), waveRank(10), waveRank(12)]).toEqual([0, 1, 1, 2, 2]);
  });

  it("spends close to the wave budget and respects the size limit", () => {
    const w = lastStand("ashlands", 3);
    for (let n = 1; n <= 30; n++) {
      const p = planWave(w, n);
      const spent = p.units.reduce((s, k) => s + UNITS[k].cost, 0);
      expect(spent).toBeLessThanOrEqual(p.budget + 1);
      const cap = p.theme === "swarm" ? SURVIVAL.swarmMaxUnits : SURVIVAL.maxWaveUnits;
      expect(p.units.length).toBeLessThanOrEqual(cap);
      if (p.units.length < cap) expect(p.budget - spent).toBeLessThan(300);
      if (p.theme === "artillery") expect(p.units).toContain("mortar");
    }
  });

  it("announces each wave 15 s ahead, then spawns it on time at that edge", () => {
    const w = lastStand("frostbite", 11);
    const warn = runUntil(w, (e) => e.type === "waveIncoming");
    expect(warn).toMatchObject({ type: "waveIncoming", wave: 1, eta: SURVIVAL.warn * TICK_RATE, early: 0 });
    expect(w.tick).toBe(SURVIVAL.firstWave.normal * TICK_RATE - SURVIVAL.warn * TICK_RATE + 1);
    const spawned = runUntil(w, (e) => e.type === "waveSpawned");
    expect(spawned).toMatchObject({ type: "waveSpawned", wave: 1 });
    if (warn?.type !== "waveIncoming" || spawned?.type !== "waveSpawned") throw new Error("unreachable");
    expect([spawned.x, spawned.y]).toEqual([warn.x, warn.y]);
    expect(w.tick).toBe(SURVIVAL.firstWave.normal * TICK_RATE + 1);
    for (let i = 0; i < 40; i++) step(w, []);
    expect(red(w).length).toBe(planWave(w, 1).units.length);
    // they come for the base
    for (const u of red(w)) expect(u.order.type).not.toBe("idle");
  });
});

describe("Bot Swarm", () => {
  /** Every Bot Swarm wave among waves 1–40 of seeds 1–15 (normal and hard). */
  const swarms = (() => {
    const out: WavePlan[] = [];
    for (let seed = 1; seed <= 15; seed++) {
      const w = lastStand("riverlands", seed);
      for (let n = 1; n <= 40; n++)
        if (waveTheme(w, n) === "swarm") out.push(planWave(w, n), planWave(w, n, "hard"));
    }
    return out;
  })();
  const cost = (units: UnitKind[], k?: UnitKind) => units.filter((u) => !k || u === k).reduce((s, u) => s + UNITS[u].cost, 0);

  it("is a named, announced theme with its counter and icon", () => {
    expect(THEME_NAMES.swarm).toBe("Essaim d'automates");
    expect(THEME_COUNTERS.swarm).toMatch(/Canons de 75/);
    expect(THEME_ICONS.swarm).toBeTruthy();
    expect(swarms.length).toBeGreaterThan(50);
    for (let seed = 1; seed <= 20; seed++) {
      const w = lastStand("riverlands", seed);
      // it always shows up in the first block, while it is small
      const n = [1, 2, 3, 4].find((i) => waveTheme(w, i) === "swarm");
      expect(n).toBeDefined();
      expect(waveName(w, n!)).toBe("Essaim d'automates");
    }
  });

  it("is Troopers and Rocket Squads, with a capped share of Sniper Teams from wave 6", () => {
    for (const p of swarms) {
      expect(p.units.every((k) => ["trooper", "rocket-squad", "sniper"].includes(k)), p.units.join()).toBe(true);
      expect(p.units.filter((k) => k === "trooper").length).toBeGreaterThanOrEqual(1);
      if (p.wave < 6) expect(p.units).not.toContain("sniper");
      else expect(cost(p.units, "sniper")).toBeLessThanOrEqual(0.15 * p.budget + 1);
      expect(p.units.filter((k) => k === "sniper").length).toBeLessThanOrEqual(0.15 * SURVIVAL.swarmMaxUnits);
      // never more squads than the live cap: a full swarm marches off at once
      expect(p.units.length).toBeLessThanOrEqual(SURVIVAL.swarmMaxUnits);
      expect(SURVIVAL.swarmMaxUnits).toBeLessThanOrEqual(SURVIVAL.maxLive);
      // Sniper Teams enter last, behind the squads
      const firstSniper = p.units.indexOf("sniper");
      if (firstSniper >= 0) expect(p.units.slice(firstSniper).every((k) => k === "sniper")).toBe(true);
    }
    const big = swarms.filter((p) => p.wave >= 3);
    expect(big.every((p) => p.units.includes("rocket-squad"))).toBe(true);
    expect(swarms.filter((p) => p.wave >= 6).some((p) => p.units.includes("sniper"))).toBe(true);
    // the marksmen stay a minority, however big the wave
    for (const p of swarms) expect(p.units.filter((k) => k === "sniper").length).toBeLessThanOrEqual(p.units.length / 5);
    expect(swarms.some((p) => p.units.length === SURVIVAL.swarmMaxUnits)).toBe(true);
  });

  it("some bosses bring infantry escorts", () => {
    const kinds = new Set<UnitKind>();
    for (let seed = 1; seed <= 6; seed++) {
      const w = lastStand("riverlands", seed);
      for (const n of [10, 15, 20, 25, 30]) for (const k of planWave(w, n).units) kinds.add(k);
    }
    expect(kinds.has("rocket-squad")).toBe(true);
    expect(kinds.has("trooper")).toBe(true);
  });

  /** A world whose next wave is the first Bot Swarm (seeds from `seed` on) whose plan passes `ok`. */
  const swarmNext = (map: string, seed: number, ok: (p: WavePlan) => boolean, difficulty: SurvivalDifficulty = "normal") => {
    for (const end = seed + 50; seed < end; seed++) {
      const w = lastStand(map, seed, difficulty);
      for (let n = 1; n <= 30; n++) {
        if (waveTheme(w, n) !== "swarm" || !ok(planWave(w, n))) continue;
        w.survival!.wave = n - 1;
        w.survival!.nextWaveTick = w.tick + 1;
        return { w, n };
      }
    }
    throw new Error("no such Bot Swarm");
  };

  it("enters on walkable ground, marches as a column, then comes for the base", () => {
    const cases = [
      // a mid-sized wave with Sniper Teams, and a full 30-squad swarm
      { map: "riverlands", difficulty: "easy", ok: (p: WavePlan) => p.units.includes("sniper") && p.units.length < SURVIVAL.swarmMaxUnits },
      { map: "ashlands", difficulty: "easy", ok: (p: WavePlan) => p.units.includes("sniper") && p.units.length < SURVIVAL.swarmMaxUnits },
      { map: "dune-sea", difficulty: "normal", ok: (p: WavePlan) => p.units.length === SURVIVAL.swarmMaxUnits }
    ] as const;
    for (const { map, difficulty, ok } of cases) {
      const { w, n } = swarmNext(map, 4, ok, difficulty);
      const s = w.survival!;
      const c = buildingCenter(hqOf(w, "blue")!);
      const seen = new Set<number>();
      let released = -1;
      let spreadMax = 0;
      for (let i = 0; i < (SURVIVAL.marchTimeout + 5) * TICK_RATE; i++) {
        shieldHq(w);
        step(w, []);
        if (s.wave === n) s.nextWaveTick = 1e9; // just this wave
        for (const u of red(w))
          if (!seen.has(u.id)) {
            seen.add(u.id);
            expect(isInfantry(u.kind)).toBe(true);
            expect(passable(w, Math.floor(u.x), Math.floor(u.y), "foot")).toBe(true);
          }
        if (s.pending.length === 0 && s.marches.length > 0) {
          const d = red(w).map((u) => Math.hypot(u.x - c.x, u.y - c.y));
          spreadMax = Math.max(spreadMax, Math.max(...d) - Math.min(...d));
        }
        if (released < 0 && s.marches.length === 0 && seen.size > 0) released = w.tick;
      }
      expect(seen.size).toBe(planWave(w, n).units.length);
      // slow walkers still move together, and the march lets go before its timeout
      expect(spreadMax).toBeLessThan(12);
      expect(released).toBeGreaterThan(0);
      expect(released - s.lastSpawnTick).toBeLessThanOrEqual(SURVIVAL.marchTimeout * TICK_RATE);
      // released toward the base: they have closed in on it
      const d = red(w).map((u) => Math.hypot(u.x - c.x, u.y - c.y));
      expect(Math.min(...d)).toBeLessThan(15);
    }
  });

  it("Sniper Teams pick off units rather than buildings, and hang back with their squads", () => {
    const w = lastStand("riverlands", 4);
    w.survival!.nextWaveTick = 1e9; // no wave: just the snipers placed here
    for (const u of [...w.units.values()]) w.units.delete(u.id);
    const c = buildingCenter(hqOf(w, "blue")!);
    // a released wave sniper with the HQ in reach and a defender squad a little farther off
    const sniper = spawnUnit(w, "sniper", "red", c.x + 7, c.y);
    const victim = spawnUnit(w, "trooper", "blue", c.x + 7, c.y - 7.5);
    sniper.order = { type: "attackMove", x: c.x, y: c.y };
    let shotHq = false;
    for (let i = 0; i < SURVIVAL.retaskTicks + 2; i++) {
      shieldHq(w);
      step(w, []);
      if (sniper.autoTargetId === hqOf(w, "blue")!.id) shotHq = true;
      victim.x = c.x + 7; // the squad stands its ground
      victim.y = c.y - 7.5;
    }
    expect(shotHq).toBe(true); // left alone it would plink at the HQ…
    expect(sniper.order).toMatchObject({ type: "attack", targetId: victim.id }); // …but the director points it at the squad
    // nothing to shoot: it rejoins the nearest walking squad instead of wandering off alone
    w.units.delete(victim.id);
    const lone = spawnUnit(w, "sniper", "red", c.x + 16, c.y);
    const squad = spawnUnit(w, "trooper", "red", c.x + 16, c.y - 8);
    spawnUnit(w, "wasp", "red", c.x + 16, c.y + 3); // aircraft are no cover for a walker
    for (let i = 0; i < SURVIVAL.retaskTicks + 2; i++) {
      shieldHq(w);
      step(w, []);
      squad.x = c.x + 16;
      squad.y = c.y - 8;
    }
    expect(lone.order).toMatchObject({ type: "attackMove", x: squad.x, y: squad.y });
  });
});

describe("spawn sites", () => {
  for (const def of MAPS)
    it(`are valid on ${def.name}`, () => {
      const w = lastStand(def.id, 5);
      const sites = w.survival!.sites;
      expect(sites.length).toBeGreaterThanOrEqual(3);
      const c = buildingCenter(hqOf(w, "blue")!);
      for (const s of sites) {
        expect(passable(w, Math.floor(s.x), Math.floor(s.y), "ground")).toBe(true);
        expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeGreaterThan(def.size * 0.45);
        expect(s.ax).toBeGreaterThan(0);
        expect(s.ay).toBeGreaterThan(0);
        expect(s.ax).toBeLessThan(w.width);
        expect(s.ay).toBeLessThan(w.height);
        // tanks can drive, and squads walk, from every site to the base
        expect(findPath(w, s.x, s.y, c.x, c.y + 2.5)).not.toBeNull();
        expect(passable(w, Math.floor(s.x), Math.floor(s.y), "foot")).toBe(true);
        expect(findPath(w, s.x, s.y, c.x, c.y + 2.5, "foot")).not.toBeNull();
      }
    });
});

describe("live cap", () => {
  it("never has more than the cap on the map; the rest wait and stream in", () => {
    const w = lastStand("riverlands", 9);
    const s = w.survival!;
    // jump to a huge late wave
    s.wave = 24;
    s.nextWaveTick = w.tick + 1;
    let maxLive = 0;
    let sawQueue = false;
    for (let i = 0; i < 400; i++) {
      shieldHq(w);
      step(w, []);
      maxLive = Math.max(maxLive, red(w).length);
      if (s.pending.length > 0 && red(w).length >= SURVIVAL.maxLive) sawQueue = true;
    }
    expect(maxLive).toBe(SURVIVAL.maxLive);
    expect(sawQueue).toBe(true);
    // as the defenders thin them out, the queue drains
    for (let i = 0; i < 600 && waveUnitsLeft(w) > 0; i++) {
      for (const u of red(w)) u.hp = 0;
      shieldHq(w);
      step(w, []);
      expect(red(w).length).toBeLessThanOrEqual(SURVIVAL.maxLive);
    }
    expect(s.pending).toHaveLength(0);
    expect(waveUnitsLeft(w)).toBe(0);
  });

  it("counts an infantry squad once, however many robots it is drawn as", () => {
    const w = lastStand("riverlands", 9);
    const s = w.survival!;
    let n = 20;
    while (waveTheme(w, n) !== "swarm") n++;
    const plan = planWave(w, n);
    expect(plan.units).toHaveLength(SURVIVAL.swarmMaxUnits); // a full Bot Swarm: exactly the live cap
    // a few stragglers of an older wave still hold slots, far off
    const c = buildingCenter(hqOf(w, "blue")!);
    for (let i = 0; i < 4; i++) s.members.set(spawnUnit(w, "stinger", "red", w.width - c.x + i * 0.8, w.height - c.y).id, n - 1);
    s.wave = n - 1;
    s.nextWaveTick = w.tick + 1;
    let maxLive = 0;
    let maxRobots = 0;
    let sawQueue = false;
    for (let i = 0; i < 300; i++) {
      shieldHq(w);
      step(w, []);
      if (s.wave === n) s.nextWaveTick = 1e9;
      const live = red(w);
      maxLive = Math.max(maxLive, live.length);
      maxRobots = Math.max(maxRobots, live.reduce((a, u) => a + squadSize(u.kind), 0));
      if (s.pending.length > 0 && live.length >= SURVIVAL.maxLive) sawQueue = true;
    }
    // the cap is 30 squads (one sim unit each), not 30 robots: 26 squads get in, 4 wait
    expect(maxLive).toBe(SURVIVAL.maxLive);
    expect(sawQueue).toBe(true);
    expect(s.pending).toHaveLength(4);
    expect(maxRobots).toBeGreaterThan(SURVIVAL.maxLive * 2);
    expect(waveUnitsLeft(w)).toBe(plan.units.length + 4);
  });

  it("holds a wave at the edge while older waves fill the cap, and marches once they thin out", () => {
    // a ground wave of 15–30 units (it fits under the cap on its own)
    let w = lastStand("riverlands", 9);
    let n = 0;
    for (let seed = 9; n === 0 && seed < 30; seed++) {
      w = lastStand("riverlands", seed);
      for (let k = 6; k <= 15 && n === 0; k++) {
        const size = planWave(w, k).units.length;
        if (["armour", "mixed", "swarm"].includes(waveTheme(w, k)) && size >= 15 && size <= SURVIVAL.maxLive) n = k;
      }
    }
    expect(n).toBeGreaterThan(0);
    const s = w.survival!;
    // 20 stragglers of an older wave, parked far from the next wave's edge
    const site = s.sites[planWave(w, n).site]!;
    const far = s.sites.reduce((a, b) => (Math.hypot(b.x - site.x, b.y - site.y) > Math.hypot(a.x - site.x, a.y - site.y) ? b : a));
    const old = Array.from({ length: 20 }, (_, i) => spawnUnit(w, "stinger", "red", far.x + (i % 4) * 0.8 - 1.2, far.y + Math.floor(i / 4) * 0.8 - 1.6));
    for (const u of old) s.members.set(u.id, n - 1);
    s.wave = n - 1;
    s.nextWaveTick = w.tick + 1;
    const fresh = () => red(w).filter((u) => s.members.get(u.id) === n && UNITS[u.kind].domain === "ground");
    const fromEdge = () => Math.max(...fresh().map((u) => Math.hypot(u.x - site.x, u.y - site.y)));
    for (let i = 0; i < 25 * TICK_RATE; i++) {
      step(w, []);
      if (s.wave === n) s.nextWaveTick = 1e9;
    }
    expect(red(w)).toHaveLength(SURVIVAL.maxLive);
    expect(s.pending.length).toBeGreaterThan(0);
    const held = fromEdge();
    expect(held).toBeLessThan(9); // formed up within a few tiles: waiting for the rest of its wave
    // the stragglers fall: the queue comes in and the wave sets off
    for (const u of old) u.hp = 0;
    for (let i = 0; i < 20 * TICK_RATE; i++) step(w, []);
    expect(s.pending).toHaveLength(0);
    expect(fromEdge()).toBeGreaterThan(held + 5);
  });

  it("marches a wave together instead of strung out by speed", () => {
    const w = lastStand("dune-sea", 4);
    const s = w.survival!;
    s.wave = 8; // a mixed bag of fast and slow units
    s.nextWaveTick = w.tick + 1;
    for (let i = 0; i < 300; i++) step(w, []);
    const units = red(w);
    expect(units.length).toBeGreaterThan(5);
    // still marching: the spread along the way stays small
    const c = buildingCenter(hqOf(w, "blue")!);
    const d = units.map((u) => Math.hypot(u.x - c.x, u.y - c.y));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(12);
  });
});

describe("clearing waves and game over", () => {
  /** Run to wave n spawned with every unit on the map. */
  const toWave = (w: World, n: number) => {
    runUntil(w, (e) => e.type === "waveSpawned" && e.wave === n, 20000);
    for (let i = 0; i < 100 && w.survival!.pending.length > 0; i++) step(w, []);
  };

  it("pays a clear bonus and brings the next wave forward", () => {
    const w = lastStand("riverlands", 21);
    toWave(w, 1);
    const scrap = w.factions.blue.scrap;
    for (const u of red(w)) u.hp = 0;
    const cleared = runUntil(w, (e) => e.type === "waveCleared", 5);
    expect(cleared).toMatchObject({ type: "waveCleared", wave: 1, bonus: SURVIVAL.clearBonus });
    expect(w.factions.blue.scrap).toBeGreaterThanOrEqual(scrap + SURVIVAL.clearBonus);
    expect(w.survival!.nextWaveTick).toBeLessThanOrEqual(w.tick + SURVIVAL.afterClear * TICK_RATE);
    expect(wavesSurvived(w)).toBe(1);
    expect(survivalStatus(w)).toMatchObject({ wave: 1, next: 2, left: 0, survived: 1 });
  });

  it("lets the defender call the next wave early for scrap, but only on a clear field", () => {
    const w = lastStand("riverlands", 22);
    expect(earlyCallBonus(w)).toBe(0); // never before wave 1
    toWave(w, 1);
    expect(earlyCallBonus(w)).toBe(0); // enemies on the field
    for (const u of red(w)) u.hp = 0;
    step(w, []);
    const bonus = earlyCallBonus(w);
    expect(bonus).toBeGreaterThan(0);
    const scrap = w.factions.blue.scrap;
    step(w, [{ type: "callWave", faction: "red" }]); // not theirs to call
    expect(w.survival!.warned).toBe(false);
    step(w, [{ type: "callWave", faction: "blue" }]);
    const warn = w.fx.find((e) => e.type === "waveIncoming");
    expect(warn).toMatchObject({ type: "waveIncoming", wave: 2 });
    expect(warn?.type === "waveIncoming" && warn.early).toBeGreaterThan(0);
    expect(w.factions.blue.scrap).toBeGreaterThan(scrap + bonus * 0.9);
    expect(w.survival!.nextWaveTick - w.tick).toBeLessThanOrEqual(SURVIVAL.warn * TICK_RATE);
    expect(earlyCallBonus(w)).toBe(0);
  });

  it("ends when the HQ falls and scores the waves survived", () => {
    const w = lastStand("proving-grounds", 23);
    toWave(w, 1);
    for (const u of red(w)) u.hp = 0;
    toWave(w, 2);
    expect(wavesSurvived(w)).toBe(1); // wave 2 is still alive
    hqOf(w, "blue")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("red");
    const tick = w.tick;
    step(w, []);
    expect(w.tick).toBe(tick); // the sim stops
    expect(wavesSurvived(w)).toBe(1);
  });

  it("finishes an undefended base", () => {
    const w = lastStand("frostbite", 24);
    for (let i = 0; i < 12 * 60 * TICK_RATE && !w.winner; i++) step(w, []);
    expect(w.winner).toBe("red");
    expect(wavesSurvived(w)).toBeLessThanOrEqual(2);
  });
});

describe("Last Stand salvage", () => {
  it("wave units leave only scrap-light wrecks; the defender's own losses salvage as usual", () => {
    const w = lastStand("riverlands", 42);
    const mine = spawnUnit(w, "mastodon", "blue", 20.5, 40.5);
    const theirs = spawnUnit(w, "mastodon", "red", 30.5, 30.5);
    mine.hp = 0;
    theirs.hp = 0;
    step(w, []);
    const wreck = (f: string) => w.wrecks.find((r) => r.faction === f)!;
    expect(wreck("red").value).toBe(Math.round(UNITS.mastodon.cost * SURVIVAL.waveWreckShare));
    // at the skirmish's 30% a defender salvaged 17–67k a run and outlasted 25+ waves
    expect(wreck("red").value).toBeLessThanOrEqual(UNITS.mastodon.cost * 0.1);
    expect(wreck("blue").value).toBe(wreckValue("mastodon"));
    // the share lives on this world's survival state, not in a global
    expect(createMapWorld("riverlands").survival).toBeFalsy();
    expect(wreckValue("mastodon")).toBe(Math.round(UNITS.mastodon.cost * 0.3));
  });
});

describe("AI defender", () => {
  it("a Normal Balanced commander holds the opening waves, then the run concludes", () => {
    const w = lastStand("frostbite", 31);
    const ai = createAiState("balanced", "normal", 31);
    let firstLoss = -1;
    for (let i = 0; i < 30 * 60 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "blue", ai));
      if (firstLoss < 0 && w.fx.some((e) => e.type === "death" && e.faction === "blue" && e.buildingKind)) firstLoss = w.survival!.wave;
    }
    expect(w.winner).toBe("red");
    expect(wavesSurvived(w)).toBeGreaterThanOrEqual(5);
    expect(firstLoss).toBeGreaterThan(3); // no building lost in the first three waves
    expect(ai.mode).toBe("buildup"); // nothing to assault in Last Stand
  });

  it("replays identically from the same seed and commands", () => {
    const sig = () => {
      const w = lastStand("riverlands", 77);
      const ai = createAiState("balanced", "normal", 77);
      for (let i = 0; i < 5 * 60 * TICK_RATE && !w.winner; i++) step(w, tickAi(w, "blue", ai));
      return JSON.stringify([w.tick, w.survival!.wave, [...w.units.values()].map((u) => [u.id, u.kind, u.x.toFixed(3), u.y.toFixed(3), u.hp])]);
    };
    expect(sig()).toBe(sig());
  });

  it("is never pointed at a wave Sniper Team hidden in the woods", () => {
    const w = lastStand("proving-grounds");
    const s = w.survival!;
    const hq = buildingCenter(hqOf(w, s.defender)!);
    // in the woods 6 tiles out: in the HQ's sight, but no defender within 3 tiles of it
    const x = hq.x + 6.5;
    const y = hq.y - 0.5;
    setTerrain(w, Math.floor(x), Math.floor(y), Terrain.Forest);
    const sniper = spawnUnit(w, "sniper", "red", x, y);
    s.members.set(sniper.id, 1);
    for (const u of [...w.units.values()]) if (u.faction === s.defender) w.units.delete(u.id);
    tickFog(w);
    expect(survivalHoldPoint(w, s.defender)?.engage).toBe(false);
    sniper.firedTick = w.tick; // a shot gives it away
    expect(survivalHoldPoint(w, s.defender)).toMatchObject({ x, y, engage: true });
  });
});
