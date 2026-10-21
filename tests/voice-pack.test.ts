// The recorded announcer (Panache): the phrase book, its clips on disk, the
// planner that pieces templated lines together, and the announcer's use of
// the clips (queueing, falling back to speech synthesis).
import { describe, expect, it, vi } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { waveName } from "../src/sim/modes/survival";
import { step } from "../src/sim/sim";
import type { Faction, Nation } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf } from "../src/sim/world";
import { BattleCallouts, speakable } from "../src/game/callouts";
import { planVoice, voiceKey, voiceLines } from "../src/game/voice-lines";
import { VOICE } from "../src/game/voice-pack";

// ---- a fake Web Audio engine for the announcer ---------------------------------
const started: { buffer: unknown; at: number }[] = [];
const param = () => {
  const p = { value: 0, setValueAtTime: () => p, linearRampToValueAtTime: () => p, exponentialRampToValueAtTime: () => p, cancelScheduledValues: () => p };
  return p;
};
const node = () => {
  const n: Record<string, unknown> = {
    gain: param(), frequency: param(), Q: param(), type: "", buffer: null, curve: null, loop: false,
    connect: (to: unknown) => to, disconnect: () => {},
    start: (at = 0) => started.push({ buffer: n.buffer, at }), stop: () => {}
  };
  return n;
};
const ctx = {
  currentTime: 0,
  createGain: node, createBiquadFilter: node, createBufferSource: node, createOscillator: node, createWaveShaper: node,
  decodeAudioData: async (data: ArrayBuffer) => ({ duration: 0.8, data })
};
vi.mock("../src/game/audio", () => {
  const settings = { muted: false, music: true, sfx: true, voice: true, speech: true };
  return {
    sfx: {
      settings,
      linkMode: false,
      engine: { ctx, voiceIn: node(), musicIn: node(), noise: { duration: 2 } },
      enabled: (ch: string) => !settings.muted && (settings as Record<string, boolean>)[ch],
      onChange: () => () => {},
      duck: () => {}
    }
  };
});
vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} });

// (node's fs, out of sight of the type checker: the project's types are the browser's)
const fs: { readFileSync(path: string, enc: "utf8"): string; existsSync(path: string): boolean; statSync(path: string): { size: number } } =
  await import(/* @vite-ignore */ ["node", "fs"].join(":"));
const VOICE_DIR = decodeURIComponent(new URL("../public/assets/voice/", import.meta.url).pathname);

describe("voice phrase book", () => {
  const lines = voiceLines();

  it("matches the exported manifest (re-run tools/voice-manifest.ts after changing a line)", () => {
    const manifest = JSON.parse(fs.readFileSync(`${VOICE_DIR}manifest.json`, "utf8")) as { lines: { key: string; text: string; file: string }[] };
    expect(manifest.lines.map((l) => [l.key, l.text, l.file])).toEqual(lines.map((l) => [l.key, l.text, l.file]));
  });

  it("has a recorded clip for every entry (tools/voice-generate.py)", () => {
    const missing = lines.filter((l) => !fs.existsSync(VOICE_DIR + l.file) || fs.statSync(VOICE_DIR + l.file).size < 1000);
    expect(missing.map((l) => l.file)).toEqual([]);
    expect(new Set(lines.map((l) => l.file)).size).toBe(lines.length);
  });

  it("keys ignore case and punctuation", () => {
    expect(voiceKey("Gargantua lâché !")).toBe(voiceKey("GARGANTUA LÂCHÉ"));
    expect(voiceKey("Montgolfière abattue ! Les troupes sautent")).toBe("montgolfière abattue les troupes sautent");
  });

  it("says whole lines in one clip and pieces templated ones together", () => {
    expect(planVoice("Creusot ennemi détruit")!.map((l) => l.text)).toEqual(["Creusot ennemi détruit"]);
    expect(planVoice("Hotchkiss ennemie détruite")).toHaveLength(1);
    expect(planVoice("Creusot ennemi détruit par un Feu roulant")!.map((l) => l.text)).toEqual(["Creusot ennemi détruit", "par un Feu roulant"]);
    expect(planVoice("GQG ennemi détruit par l'Obus Méliès")).toHaveLength(2);
    expect(planVoice("Gargantua ennemi : canons et mortiers hors service !")!.map((l) => l.part)).toEqual(["head", "mid", "tail"]);
    expect(planVoice("Panhard promu élite")).toHaveLength(2);
    expect(planVoice("Dernier Gargantua Rouge détruit. Bleu remporte la bataille")).toHaveLength(2);
    // open lines: none
    expect(planVoice("Bleu : on tient le pont nord")).toBeNull();
    expect(planVoice("Vague 31 repoussée")).toBeNull();
    expect(planVoice("")).toBeNull();
  });

  it("covers every Last Stand wave name", () => {
    for (const seed of [1, 2, 3, 7, 42]) {
      const w = createMapWorld("proving-grounds", { seed, survival: { difficulty: "normal" } });
      for (let n = 1; n <= 45; n++) expect(planVoice(speakable(waveName(w, n))), waveName(w, n)).not.toBeNull();
    }
  });

  /** Everything a busy AI-vs-AI battle makes the radio say, as the player or a spectator. */
  function battleLines(spectator: boolean, seed: number, nations?: { blue: Nation; red: Nation }, player: Faction = "blue"): string[] {
    const w = createMapWorld("proving-grounds", { seed, ...(nations ? { nations } : {}) });
    const ais = { blue: createAiState("rush", "normal", seed + 1), red: createAiState("boom", "normal", seed + 2) };
    const hq = buildingCenter(hqOf(w, player)!);
    const said: string[] = [];
    const c = new BattleCallouts({
      world: w, player, spectator,
      onScreen: (x, y) => Math.abs(x - hq.x) <= 5 && Math.abs(y - hq.y) <= 8,
      radio: (l) => said.push(l.text),
      announce: (a) => said.push(a.say ?? speakable(a.text))
    });
    while (!w.winner && w.tick < 12 * 60 * TICK_RATE) {
      step(w, (["blue", "red"] as Faction[]).flatMap((f) => tickAi(w, f, ais[f])));
      c.events(w.fx, w.tick / TICK_RATE);
    }
    return said;
  }

  it("covers every line a real battle says, player and spectator", () => {
    const said = [...battleLines(false, 4242), ...battleLines(true, 77)];
    expect(said.length).toBeGreaterThan(20);
    const uncovered = [...new Set(said)].filter((t) => !planVoice(t));
    expect(uncovered).toEqual([]);
  }, 120_000);

  it("covers every line a République-against-Empire battle says, from either side and as a spectator", () => {
    const rep = { blue: "republique", red: "empire" } as const;
    const said = [...battleLines(false, 4242, rep), ...battleLines(false, 515, rep, "red"), ...battleLines(true, 77, rep)];
    expect(said.length).toBeGreaterThan(20);
    const uncovered = [...new Set(said)].filter((t) => !planVoice(t));
    expect(uncovered).toEqual([]);
    // (the Empire's HQ is its Citadelle: its lines are recorded too)
    for (const t of ["Alerte : notre Citadelle est attaquée", "Citadelle Rouge attaquée", "Citadelle ennemie détruite par le Rayon Curie", "Notre Citadelle est tombée"])
      expect(planVoice(t), t).not.toBeNull();
  }, 240_000);
});

describe("recorded announcer", () => {
  async function setup(fetcher: (url: string) => Promise<ArrayBuffer>) {
    const { Announcer } = await import("../src/game/announcer");
    const { VoicePack } = await import("../src/game/voice-pack");
    const pack = new VoicePack(fetcher, "v/");
    const w = createWorld(32, 32);
    const a = new Announcer({ world: w, player: "blue", spectator: false, onScreen: () => false, caption: () => {} }, pack);
    return { a, pack };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("plays a covered line from its clips, then waits it out before the next", async () => {
    const fetched: string[] = [];
    const { a, pack } = await setup(async (url) => (fetched.push(url), new ArrayBuffer(8)));
    started.length = 0;
    a.push({ key: "base-attack", text: "Notre base est attaquée", priority: 1, tone: "bad", caption: false });
    a.push({ key: "squad-lost", text: "Escouade perdue", priority: 1, tone: "bad", caption: false });
    a.update(16, false);
    await flush();
    // (the common lines are fetched ahead as soon as the audio engine exists)
    expect(fetched).toContain("v/notre-base-est-attaquee.mp3");
    expect(fetched.length).toBe(voiceLines().filter((l) => l.core).length);
    expect(pack.stats.played).toBe(1);
    expect(a.log.at(-1)).toMatchObject({ key: "base-attack", how: "clip" });
    // the line is 0.8 s long: the queue holds the next one (busy, then the 2.5 s gap)
    a.update(500, false);
    expect(a.log).toHaveLength(1);
    a.update(2000, false);
    await flush();
    expect(a.log).toHaveLength(2);
    expect(a.log[1]).toMatchObject({ key: "squad-lost", how: "clip" });
    a.destroy();
  });

  it("pieces a templated line together from fragments, back to back", async () => {
    const { a } = await setup(async () => new ArrayBuffer(8));
    started.length = 0;
    a.push({ key: "kill", text: "Creusot ennemi détruit par un Feu roulant", priority: 2, tone: "good", caption: false });
    a.update(16, false);
    await flush();
    const voice = started.filter((s) => (s.buffer as { duration: number } | null)?.duration === 0.8);
    expect(voice).toHaveLength(2);
    expect(voice[1]!.at - voice[0]!.at).toBeCloseTo(0.8 + 0.035, 5);
    a.destroy();
  });

  it("falls back to speech synthesis for lines it can't say, or clips that don't come", async () => {
    // a clip that never comes, and one that fails
    const { a, pack } = await setup((url) => (url.includes("escouade-perdue") ? new Promise<ArrayBuffer>(() => {}) : Promise.reject(new Error("offline"))));
    a.push({ key: "commander-red", text: "Rouge : on tient le pont", priority: 1, tone: "info", caption: true });
    a.update(16, false);
    await flush();
    // (no speech engine under node: the radio code stands in, as it does on a device without voices)
    expect(a.log.at(-1)!.how).toBe("code");
    expect(pack.stats.uncovered).toBe(1);
    a.update(3000, false);
    a.push({ key: "squad-lost", text: "Escouade perdue", priority: 1, tone: "bad", caption: false });
    a.update(16, false);
    await flush();
    expect(a.log.at(-1)).toMatchObject({ key: "squad-lost", how: "clip" }); // (waiting for it…)
    await new Promise((r) => setTimeout(r, VOICE.waitMs + 50));
    expect(a.log.at(-1)).toMatchObject({ key: "squad-lost", how: "speech" }); // (…given up)
    expect(pack.stats.late).toBe(1);
    expect(pack.stats.played).toBe(0);
    // a clip that failed once isn't asked for again
    expect(pack.plan("Fardier perdu")).toBeNull();
    expect(pack.plan("Escouade perdue")).not.toBeNull();
    a.destroy();
  });
});
