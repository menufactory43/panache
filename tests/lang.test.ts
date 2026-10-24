/**
 * The player's language (src/lang.ts): how it is picked, and that it is
 * display only. A French player and an English one must play the same duel,
 * so the same match is played with the modules loaded in each language and
 * the worlds compared, hash for hash.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLang } from "../src/lang";

declare const process: { env: Record<string, string | undefined> };

describe("detectLang", () => {
  it("takes the saved pick first, then the phone's first French or English language, else English", () => {
    expect(detectLang({ saved: "en", languages: ["fr-FR"] })).toBe("en");
    expect(detectLang({ saved: null, languages: ["fr-CA", "en-US"] })).toBe("fr");
    expect(detectLang({ saved: null, languages: ["de-DE", "en-GB", "fr"] })).toBe("en");
    expect(detectLang({ saved: "xx", languages: ["ja-JP"] })).toBe("en");
    expect(detectLang({ override: "en", saved: "fr", languages: ["fr"] })).toBe("en");
  });
  it("follows the link's ?lang= when nothing is saved, before the phone's", () => {
    expect(detectLang({ saved: null, link: "en", languages: ["fr-FR"] })).toBe("en");
    expect(detectLang({ saved: "fr", link: "en", languages: ["en-US"] })).toBe("fr");
    expect(detectLang({ saved: null, link: "de", languages: ["fr-FR"] })).toBe("fr");
  });
  it("is French outside a browser", () => {
    expect(detectLang({})).toBe("fr");
  });
});

/** Two AIs playing nations against each other for `minutes`, with every module loaded in `lang`: a hash every 500 ticks. */
async function trail(lang: "fr" | "en", minutes: number, map = "riverlands"): Promise<{ hashes: string[]; names: string }> {
  vi.resetModules();
  process.env.PANACHE_LANG = lang;
  const { createMapWorld } = await import("../src/sim/maps");
  const { createAiState, tickAi } = await import("../src/sim/ai/commander");
  const { step } = await import("../src/sim/sim");
  const { worldHash } = await import("../src/sim/checksum");
  const { UNITS } = await import("../src/sim/balance");
  const w = createMapWorld(map, { seed: 99, objectives: true, nations: { blue: "republique", red: "empire" } });
  const sb = createAiState("balanced", "hard", 1);
  const sr = createAiState("ironclad", "hard", 2);
  const hashes = [worldHash(w)];
  for (let i = 0; i < minutes * 600 && !w.winner; i++) {
    step(w, [...tickAi(w, "blue", sb), ...tickAi(w, "red", sr)]);
    if (w.tick % 500 === 0) hashes.push(`${w.tick}:${worldHash(w)}`);
  }
  hashes.push(`end ${w.tick}:${worldHash(w)}:${w.winner ?? "-"}`);
  return { hashes, names: UNITS.harvester.name };
}

describe("the language is display only", () => {
  afterEach(() => {
    delete process.env.PANACHE_LANG;
    vi.resetModules();
  });
  it("a nations match plays bit for bit the same in French and in English", async () => {
    const fr = await trail("fr", 6);
    const en = await trail("en", 6);
    expect([fr.names, en.names]).toEqual(["Fardier", "Steam Wagon"]); // (the modules really were loaded in each language)
    expect(en.hashes).toEqual(fr.hashes);
  }, 300000);
  it("so does a random map (its name drawn from word lists in each language)", async () => {
    const { randomMapId } = await import("../src/sim/mapgen");
    const map = randomMapId("arctic", 4242);
    const fr = await trail("fr", 3, map);
    const en = await trail("en", 3, map);
    expect(en.hashes).toEqual(fr.hashes);
  }, 300000);
});
