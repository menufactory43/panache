import { describe, expect, it } from "vitest";
import { HASH_EVERY as ARENA_HASH_EVERY, endOf, replay, worldHash } from "../src/arena/record";
import { archiveMatch, decodeRecord, encodeRecord, loadMatch, memoryStore } from "../src/game/archive";
import { applyOpenersCanonical, composeTick } from "../src/game/local-side";
import { HASH_EVERY, MatchRecorder, soloEnd } from "../src/game/match-record";
import { DIFFICULTY, createAiState, tickAi } from "../src/sim/ai/commander";
import { tickFog } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Command, Faction, World } from "../src/sim/types";

/**
 * A single-player match as GameScene plays it: the world built from the
 * match options, the fog drawn, the openers dealt at the pick, then every
 * tick the player's commands (here an AI standing in for them, plus a drawn
 * route and a patrol) and the enemy commander's, blue's first, recorded as
 * stepped. The record must replay to the same world, hash for hash.
 */
function playSolo(player: Faction, ticks: number): { w: World; rec: MatchRecorder } {
  const enemy: Faction = player === "blue" ? "red" : "blue";
  const opts = { seed: 424242, objectives: true, mutators: ["blitz" as const] };
  const w = createMapWorld("riverlands", opts);
  const ai = createAiState("rush", "hard", 7);
  const stand = createAiState("balanced", "normal", 11);
  const rec = new MatchRecorder({
    setup: { map: w.mapId, seed: w.seed, mutators: opts.mutators, income: { [enemy]: DIFFICULTY.hard.incomeMult } },
    seats: { [player]: { player: "Toi" }, [enemy]: { player: "IA" } } as Record<Faction, { player: string }>,
    sim: null,
    created: "2026-10-22T10:00:00.000Z"
  });
  tickFog(w);
  const picks = { [player]: "industry", [enemy]: "blitz" } as const;
  applyOpenersCanonical(w, picks);
  rec.opened(picks);
  while (w.tick < ticks && !w.winner) {
    const mine: Command[] = tickAi(w, player, stand);
    // a route drawn with a finger and a patrol: the new commands, from the player's side
    const army = [...w.units.values()].filter((u) => u.faction === player && u.kind !== "harvester").map((u) => u.id);
    if (w.tick === 150 && army.length) {
      mine.push({ type: "attackMove", faction: player, unitIds: army, x: 20.5, y: 20.5 });
      mine.push({ type: "waypoint", faction: player, unitIds: army, x: 28.5, y: 24.5 });
      mine.push({ type: "patrol", faction: player, unitIds: army, x: 24.5, y: 30.5 });
    }
    const theirs = tickAi(w, enemy, ai);
    rec.step(w.tick, player === "blue" ? mine : theirs, player === "blue" ? theirs : mine);
    step(w, composeTick(player, mine, theirs));
    rec.stepped(w);
  }
  return { w, rec };
}

describe("a recorded single-player match", () => {
  it("ends and hashes as the arena's records do", () => {
    expect(HASH_EVERY).toBe(ARENA_HASH_EVERY);
    for (const [w, r] of [["blue", undefined], ["red", "red"], ["draw", null], ["draw", undefined]] as const)
      expect(soloEnd(90, w, r)).toEqual(endOf(90, w, r));
  });

  it("replays to the same final world hash, routes and patrols included", () => {
    const { w, rec } = playSolo("blue", 1400);
    const r = rec.record(w, { pov: "blue", kind: "escarmouche", result: "win", against: "IA Rush (Difficile)" });
    expect(r.turns.some(([, , cmds]) => cmds.some((c) => c.type === "patrol"))).toBe(true);
    expect(r.hashes.at(-1)).toEqual([w.tick, worldHash(w)]);
    // through its JSON, as the Archives keep it
    const back = decodeRecord(encodeRecord(r));
    const out = replay(back);
    expect(out.divergedAt).toBeNull();
    expect(out.checked).toBe(r.hashes.length);
    expect(out.world.tick).toBe(w.tick);
    expect(worldHash(out.world)).toBe(worldHash(w));
  });

  it("does so playing red too (blue's commands still stepped first)", () => {
    const { w, rec } = playSolo("red", 600);
    const out = replay(rec.record(w));
    expect(out.divergedAt).toBeNull();
    expect(worldHash(out.world)).toBe(worldHash(w));
  });

  it("goes into the Archives and back", async () => {
    const { w, rec } = playSolo("blue", 300);
    const store = memoryStore();
    const meta = await archiveMatch(store, rec.record(w));
    expect(meta).not.toBeNull();
    const back = await loadMatch(store, meta!.id);
    expect(back && worldHash(replay(back).world)).toBe(worldHash(w));
  });
});
