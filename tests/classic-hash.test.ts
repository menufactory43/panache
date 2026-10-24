import { describe, expect, it } from "vitest";
import { createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld, type MatchOptions } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { setupWorld } from "../src/sim/setup";
import type { BattleRecord } from "../src/arena/record";
import type { Command } from "../src/sim/types";

/**
 * Classique stays bit for bit what it was before the nations
 * (PANACHE-CONCEPTION.md §0, principle 1). The expected hashes below were
 * computed on commit 4eff7f6, before any nation code: the showcase battle
 * records re-run from their setup and commands, and fixed-seed AI-vs-AI
 * matches. Any change to them means a Classique world no longer plays as it
 * did — fix the code, never these numbers (unless the Classique rules are
 * meant to change, which the design forbids).
 */

/** FNV-1a over a string: a digest of every command the AIs issued. */
const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

const EVERY = 500;

/** A showcase record re-run from its setup and commands: a hash every EVERY ticks, then the end. */
function replayTrail(r: BattleRecord): string[] {
  const w = setupWorld(r);
  const byTick = new Map<number, Command[]>();
  for (const [tick, , cmds] of r.turns) byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);
  const end = r.end?.tick ?? r.tick;
  const out: string[] = [worldHash(w)];
  while (w.tick < end && !w.winner) {
    step(w, byTick.get(w.tick) ?? []);
    if (w.tick % EVERY === 0) out.push(`${w.tick}:${worldHash(w)}`);
  }
  out.push(`end ${w.tick}:${worldHash(w)}:${w.winner ?? "-"}`);
  return out;
}

/**
 * Two built-in AIs playing each other for `minutes` on a fixed seed. Without
 * unit skills (sim/skills.ts): they came after, as orders a side chooses to
 * give, like any other; with nobody using one, Classique plays as it did.
 */
function aiTrail(map: string, opts: MatchOptions, blue: StrategyName, red: StrategyName, minutes: number): string[] {
  const w = createMapWorld(map, opts);
  const sb = createAiState(blue, "normal", 1, { skills: false });
  const sr = createAiState(red, "normal", 2, { skills: false });
  const out: string[] = [worldHash(w)];
  let cmdLog = "";
  for (let i = 0; i < minutes * 600 && !w.winner; i++) {
    const cmds = [...tickAi(w, "blue", sb), ...tickAi(w, "red", sr)];
    if (cmds.length) cmdLog += `${w.tick}${JSON.stringify(cmds)}`;
    step(w, cmds);
    if (w.tick % EVERY === 0) out.push(`${w.tick}:${worldHash(w)}`);
  }
  out.push(`end ${w.tick}:${worldHash(w)}:${w.winner ?? "-"}`, `cmds ${fnv(cmdLog)}`);
  return out;
}

const records = import.meta.glob("../battles/showcase/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const EXPECTED_RECORDS: Record<string, string[]> = {
  "2026-10-11-archipelago-42-gpt-5.6-sol-vs-gpt-6.1-sol.json": ["f416c5f7","500:0f4df81e","1000:a986bbfd","1500:936b16b0","2000:be3f588b","2500:dc3de48d","3000:568d8da1","3500:760f2d6c","4000:6ca46b96","4500:3a7e1eec","5000:20023124","5500:55af4186","6000:10af7220","6500:4c80c107","7000:803251c9","end 7052:2921ca20:red"],
  "2026-10-11-dune-sea-7-gpt-6-luna-vs-gpt-6-luna.json": ["071636c7","500:00f5167e","1000:40a0946d","1500:d0127930","2000:0f174fc1","2500:22577ac8","3000:639a23fc","3500:004b456a","4000:b2317e33","4500:d44c0630","end 4722:302f1aff:blue"],
  "2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-astra.json": ["fdec41e7","500:4c3aa10c","1000:96283c6d","1500:7daad8f7","2000:a7864d75","2500:b09406a2","3000:0427f4a4","3500:6c3fab66","4000:724e59cd","4500:202b5958","end 4703:d7b6642f:red"],
  "2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-luna.json": ["fdec41e7","500:5afb1c20","1000:9dc98df5","1500:0f24dbc7","2000:04250102","2500:efb34010","end 2716:fb0e5718:blue"],
  "2026-10-14-archipelago-42-claude-opus-5.5-vs-gemini-4-argon.json": ["011b4b7c","500:5cba62b1","1000:5a4e93d6","1500:0e71060a","2000:86c7f8ef","2500:8b10f61d","end 2521:78692a27:blue"],
  "2026-10-14-archipelago-42-claude-opus-5.5-vs-gpt-6-astra-2.json": ["f9168afe","500:8c7d5807","1000:f28fc790","1500:d6da8350","2000:b4edfe49","2500:bf946f12","end 2818:04127f57:red"],
  "2026-10-14-frostbite-42-claude-haiku-5.5-vs-gpt-6-luna.json": ["f76a63e1","500:aa9d970f","1000:c94b8930","1500:9db8c163","2000:562185ec","2500:0e0ce22b","3000:609b8464","3500:61fd3b71","4000:e18b5ee9","4500:c88ec7b9","end 4683:24cc01d6:blue"],
  "2026-10-14-frostbite-42-claude-opus-5.5-vs-gpt-6-astra.json": ["f76a63e1","500:06cc1f23","1000:1ae277f6","1500:f39a6a06","2000:bf19af8f","2500:dee64127","end 2541:d40889b1:red"],
  "2026-10-14-riverlands-42-gpt-6-astra-vs-gemini-4-argon.json": ["3048c115","500:c8e67340","1000:fd8160fd","1500:345ac2e1","2000:de17f38b","2500:056d11ee","3000:6d4d8835","end 3358:80582549:blue"],
};
const EXPECTED_AI: Record<string, string[]> = {
  "riverlands-balanced-rush": ["0e400515","500:f4e00e35","1000:cacbccc8","1500:4f7f11f4","2000:a14fe9d4","2500:fd6afe8f","3000:7d6fd960","3500:efa027a9","4000:e7d8908c","4500:54489660","5000:13e5fac7","5500:e7e0ad31","6000:ef201dd7","end 6000:ef201dd7:-","cmds c8405c55"],
  "archipelago-airswarm-ironclad": ["93f6eaf0","500:e9865253","1000:1eac2cc3","1500:f80f3e8c","2000:7a74ba3d","2500:43088976","3000:4d0d642f","3500:32c5d64c","4000:099d3e3f","4500:9bb1b63b","5000:b591d901","5500:2ab810b7","6000:2986187b","end 6000:2986187b:-","cmds a08e52a2"],
  "frostbite-boom-skyforce-nomads": ["5ae1248a","500:1c0f6e1e","1000:86cb432d","1500:251e80ad","2000:9dbd0d22","2500:010444ca","3000:5bb89b28","3500:7f04aeb2","4000:d2f65184","4500:37225704","5000:3ca870ae","5500:212370d9","6000:80285255","end 6000:80285255:-","cmds 7382478d"],
};

const AI_MATCHES: { id: string; map: string; opts: MatchOptions; blue: StrategyName; red: StrategyName }[] = [
  { id: "riverlands-balanced-rush", map: "riverlands", opts: { seed: 1234, objectives: true }, blue: "balanced", red: "rush" },
  { id: "archipelago-airswarm-ironclad", map: "archipelago", opts: { seed: 77, objectives: true }, blue: "airswarm", red: "ironclad" },
  { id: "frostbite-boom-skyforce-nomads", map: "frostbite", opts: { seed: 5, mutators: ["nomads"] }, blue: "boom", red: "skyforce" }
];

declare const process: { env: Record<string, string | undefined> };
const PRINT = !!process.env.CLASSIC_HASH_PRINT;

describe("Classique is bit for bit unchanged", () => {
  for (const [path, json] of Object.entries(records)) {
    const name = path.split("/").pop()!;
    it(`replays ${name} to the same hashes`, () => {
      const trail = replayTrail(JSON.parse(json) as BattleRecord);
      if (PRINT) console.log(`RECORD ${JSON.stringify(name)}: ${JSON.stringify(trail)},`);
      else expect(trail).toEqual(EXPECTED_RECORDS[name]);
    }, 120000);
  }
  for (const m of AI_MATCHES)
    it(`a 10-minute AI-vs-AI match (${m.id}) plays the same`, () => {
      const trail = aiTrail(m.map, m.opts, m.blue, m.red, 10);
      if (PRINT) console.log(`AI ${JSON.stringify(m.id)}: ${JSON.stringify(trail)},`);
      else expect(trail).toEqual(EXPECTED_AI[m.id]);
    }, 300000);
});
