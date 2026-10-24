/**
 * Picking an interrupted match up (src/game/resume.ts): the journal is
 * written, kept and dropped as it should, and a match rebuilt from it (its
 * setup's rolls, the player's commands, the AI thinking afresh) reaches the
 * very world the journal left, hash for hash.
 */
import { describe, expect, it } from "vitest";
import { RESUME, ResumeWriter, commandsByTick, loadResume, RESUME_KEY, type ResumeJournal, type ResumeStore } from "../src/game/resume";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld, type MatchOptions } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Command } from "../src/sim/types";

function memStore(): ResumeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const START = {
  sim: "abc",
  side: "blue" as const,
  mode: { mapId: "riverlands", difficulty: "normal" as const, mode: "skirmish" as const, mutators: [], nation: "classique" as const, rival: "opposite" as const, uncharted: false, opId: null, daily: null },
  opts: { seed: 31337, objectives: true } as MatchOptions,
  ai: { strategy: "rush" as const, difficulty: "normal" as const, seed: 7 },
  label: "Escarmouche · Terres fluviales"
};

describe("the resume journal", () => {
  it("is saved now and then, forced when the app leaves, and dropped once closed", () => {
    const store = memStore();
    const j = new ResumeWriter(START, store);
    j.save(0, true);
    expect(store.data.has(RESUME_KEY)).toBe(false); // (nothing played yet)
    j.step(0, [{ type: "stop", faction: "blue", unitIds: [1] } as Command]);
    j.stepped(1, () => "h");
    j.save(1000);
    expect(store.data.has(RESUME_KEY)).toBe(true);
    j.stepped(2, () => "h");
    j.save(2000); // (too soon after the last)
    expect((JSON.parse(store.data.get(RESUME_KEY)!) as ResumeJournal).tick).toBe(1);
    j.save(2000, true);
    expect((JSON.parse(store.data.get(RESUME_KEY)!) as ResumeJournal).tick).toBe(2);
    expect(loadResume("abc", Date.now(), store)?.cmds).toHaveLength(1);
    j.close();
    expect(store.data.has(RESUME_KEY)).toBe(false);
  });

  it("keeps a command's NaN as NaN (JSON alone would make it null)", () => {
    const store = memStore();
    const j = new ResumeWriter(START, store);
    j.step(3, [{ type: "move", faction: "blue", unitIds: [1], x: NaN, y: Infinity } as Command]);
    j.stepped(4, () => "h");
    j.save(0, true);
    const c = loadResume("abc", Date.now(), store)!.cmds[0]![1][0] as { x: number; y: number };
    expect(Number.isNaN(c.x)).toBe(true);
    expect(c.y).toBe(Infinity);
  });

  it("is only resumed by the build that wrote it, and not after a few days", () => {
    const store = memStore();
    const j = new ResumeWriter(START, store);
    j.stepped(5, () => "h");
    j.save(0, true);
    expect(loadResume("other", Date.now(), store)).toBeNull();
    expect(store.data.has(RESUME_KEY)).toBe(false); // (a foreign one is removed)
    j.stepped(6, () => "h");
    j.save(1e9, true);
    expect(loadResume("abc", Date.now() + RESUME.maxAgeMs + 1, store)).toBeNull();
    store.setItem(RESUME_KEY, "{broken");
    expect(loadResume("abc", Date.now(), store)).toBeNull();
  });
});

describe("a match rebuilt from its journal", () => {
  it("reaches the same world as the one that was left", () => {
    // the match as played: blue's commands stand for the player's taps
    const store = memStore();
    const w = createMapWorld("riverlands", START.opts);
    const player = createAiState("balanced", "normal", 3);
    const enemy = createAiState(START.ai.strategy, START.ai.difficulty, START.ai.seed);
    const j = new ResumeWriter(START, store);
    const TICKS = 4000;
    while (w.tick < TICKS) {
      const mine = tickAi(w, "blue", player);
      const theirs = tickAi(w, "red", enemy);
      j.step(w.tick, mine);
      step(w, [...mine, ...theirs]);
      j.stepped(w.tick, () => worldHash(w));
    }
    j.save(0, true);
    const left = worldHash(w);

    // picked up: the same setup, the journal's commands, the enemy thinking afresh
    const saved = loadResume("abc", Date.now(), store)!;
    expect(saved.checks.length).toBe(Math.floor(TICKS / RESUME.checkEvery));
    const w2 = createMapWorld(saved.mode.mapId, saved.opts);
    const enemy2 = createAiState(saved.ai!.strategy, saved.ai!.difficulty, saved.ai!.seed);
    const byTick = commandsByTick(saved);
    const checks = new Map(saved.checks);
    while (w2.tick < saved.tick) {
      const mine = byTick.get(w2.tick) ?? [];
      step(w2, [...mine, ...tickAi(w2, "red", enemy2)]);
      const want = checks.get(w2.tick);
      if (want !== undefined) expect(worldHash(w2), `tick ${w2.tick}`).toBe(want);
    }
    expect(worldHash(w2)).toBe(left);
  }, 120000);
});
