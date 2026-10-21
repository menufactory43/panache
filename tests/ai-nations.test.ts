import { describe, expect, it } from "vitest";
import { BUILDINGS, ROSTERS } from "../src/sim/balance";
import { createAiState, NATION_POOLS, tickAi, type AiState, type PersonalityName } from "../src/sim/ai/commander";
import { buildingFor, poweredAt, powerSources } from "../src/sim/ai/roles";
import { createMapWorld } from "../src/sim/maps";
import { planWave } from "../src/sim/modes/survival";
import { step } from "../src/sim/sim";
import type { BuildingKind, Faction, Nation, World } from "../src/sim/types";
import { buildingCenter, hqOf, spawnUnit } from "../src/sim/world";

/**
 * WP3 (PANACHE-CONCEPTION.md §3.2): the commander plays both nations by role.
 * Every personality of each nation builds its (nation-mapped) build order and
 * launches a wave before 8:00 on Riverlands; a République-against-Empire
 * match runs 15 minutes without either commander stalling. Classique's
 * non-regression is tests/classic-hash.test.ts.
 */

const MIN = 600;
const other = (n: Nation): Nation => (n === "empire" ? "republique" : "empire");

/**
 * Do the République's Fourgons mine yet? Before WP1's `behaves()` the sim
 * only sets a "harvester" mining, so a République economy is its one starting
 * harvester; then both sides get three more stand-in harvesters, so the test
 * measures the commander, not the missing mechanic.
 */
function fourgonsMine(): boolean {
  const w = createMapWorld("riverlands", { nations: { blue: "republique", red: "empire" } });
  const c = buildingCenter(hqOf(w, "blue")!);
  const u = spawnUnit(w, "fourgon", "blue", c.x + 2.5, c.y);
  step(w, [{ type: "harvest", faction: "blue", unitIds: [u.id], x: c.x + 6, y: c.y }]);
  return u.order.type === "harvest";
}
const STAND_INS = !fourgonsMine();

function nationWorld(blue: Nation): World {
  const w = createMapWorld("riverlands", { nations: { blue, red: other(blue) } });
  if (STAND_INS)
    for (const f of ["blue", "red"] as Faction[]) {
      const c = buildingCenter(hqOf(w, f)!);
      for (let i = 0; i < 3; i++) spawnUnit(w, "harvester", f, c.x + (f === "blue" ? 2.5 : -2.5), c.y + i - 1);
    }
  return w;
}

const PERSONALITIES: Record<Nation, PersonalityName[]> = {
  republique: ["balanced", "rush", "airswarm", "boom", "skyforce", "ironclad", "volta"],
  empire: ["balanced", "rush", "airswarm", "boom", "skyforce", "ironclad", "siege"]
};

/**
 * A commander alone on Riverlands for `minutes`: what it built, and its
 * state. The other side does nothing, and its HQ is patched up every tick
 * (a won match would stop the clock before the build order is through).
 */
function solo(nation: Nation, name: PersonalityName, minutes: number): { w: World; s: AiState; built: BuildingKind[] } {
  const w = nationWorld(nation);
  const s = createAiState(name, "normal", 7);
  const seen = new Set<number>();
  const built: BuildingKind[] = [];
  const target = hqOf(w, "red")!;
  for (let t = 0; t < minutes * MIN && !w.winner; t++) {
    target.hp = BUILDINGS.hq.hp;
    step(w, tickAi(w, "blue", s));
    if (t % 10 === 0)
      for (const b of w.buildings.values())
        if (b.faction === "blue" && !seen.has(b.id)) {
          seen.add(b.id);
          built.push(b.kind);
        }
  }
  return { w, s, built };
}

describe("AI nations: every personality plays both nations", () => {
  for (const nation of ["republique", "empire"] as Nation[])
    for (const name of PERSONALITIES[nation])
      it(`${nation} ${name}: builds its order and launches a wave before 8:00 (riverlands)`, () => {
        const { w, s, built } = solo(nation, name, 8);
        expect(w.winner ?? null).toBeNull();
        expect(w.tick).toBe(8 * MIN);
        // its build order, every shared kind as the nation builds it, from its own roster
        const want = s.strategy.buildOrder.map((k) => buildingFor(nation, k));
        const left = [...built];
        const missing: BuildingKind[] = [];
        for (const k of want) {
          const i = left.indexOf(k);
          if (i >= 0) left.splice(i, 1);
          else missing.push(k);
        }
        expect(missing, `built ${built.join(",")}`).toEqual([]);
        for (const k of built) expect(ROSTERS[nation].buildings).toContain(k);
        expect(s.firstWaveTick ?? Infinity).toBeLessThan(8 * MIN);
      });

  it("the République builds only inside its power network (or puts up a Tour TSF first)", () => {
    const { w } = solo("republique", "volta", 6);
    const sources = powerSources(w, "blue");
    for (const b of w.buildings.values()) {
      if (b.faction !== "blue" || b.kind === "hq" || b.kind === "radar") continue;
      expect(poweredAt(sources, b.tx, b.ty, BUILDINGS[b.kind].size), `${b.kind} at ${b.tx},${b.ty}`).toBe(true);
    }
  });

  it("the Empire's siege train fields Mortiers de 280 with a scout to spot for them", () => {
    const { w } = solo("empire", "siege", 8);
    const kinds = [...w.units.values()].filter((u) => u.faction === "blue").map((u) => u.kind);
    expect(kinds).toContain("mortier-280");
    expect(kinds).toContain("estafette");
  });

  it("a commander left to pick at random takes a personality from its nation's pool", () => {
    for (const nation of ["republique", "empire"] as Nation[])
      for (let seed = 1; seed <= 12; seed++) {
        const w = nationWorld(nation);
        const s = createAiState(undefined, "normal", seed);
        tickAi(w, "blue", s);
        expect(NATION_POOLS[nation].normal).toContain(s.strategy.id ?? s.strategy.name);
      }
  });

  for (const [rep, emp] of [["balanced", "ironclad"], ["skyforce", "siege"]] as [PersonalityName, PersonalityName][])
    it(`République ${rep} against Empire ${emp}: 15 minutes with neither commander stalling`, () => {
      const w = nationWorld("republique");
      const ai: Record<Faction, AiState> = { blue: createAiState(rep, "normal", 1), red: createAiState(emp, "normal", 2) };
      const last: Record<Faction, number> = { blue: 0, red: 0 };
      let worstGap = 0;
      for (let t = 0; t < 15 * MIN && !w.winner; t++) {
        const cmds = [];
        for (const f of ["blue", "red"] as Faction[]) {
          const c = tickAi(w, f, ai[f]);
          if (c.length > 0) last[f] = w.tick;
          else if (hqOf(w, f)) worstGap = Math.max(worstGap, w.tick - last[f]);
          cmds.push(...c);
        }
        step(w, cmds);
      }
      // the full 15 minutes, or a decided match
      expect(w.tick >= 15 * MIN || !!w.winner).toBe(true);
      // (a commander with an HQ always has something to say within a minute)
      expect(worstGap).toBeLessThan(MIN);
      expect((ai.blue.waves ?? 0) + (ai.red.waves ?? 0)).toBeGreaterThan(0);
    });
});

describe("Last Stand waves by role", () => {
  it("a nation's waves come from its own roster", () => {
    for (const nation of ["republique", "empire"] as Nation[]) {
      const w = createMapWorld("riverlands", { nations: { blue: other(nation), red: nation }, survival: { difficulty: "normal" } });
      for (let n = 1; n <= 15; n++)
        for (const k of planWave(w, n).units) expect(ROSTERS[nation].units, `wave ${n}`).toContain(k);
    }
  });
});
