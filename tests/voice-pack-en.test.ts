/**
 * The English announcer (public/assets/voice/en/): the phrase book built
 * with every module loaded in English matches its manifest, and each entry
 * has its recorded clip (tools/voice-generate.py --lang en).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

declare const process: { env: Record<string, string | undefined> };

// (node's fs, out of sight of the type checker: the project's types are the browser's)
const fs: { readFileSync(path: string, enc: "utf8"): string; existsSync(path: string): boolean; statSync(path: string): { size: number } } =
  await import(/* @vite-ignore */ ["node", "fs"].join(":"));
const EN_DIR = decodeURIComponent(new URL("../public/assets/voice/en/", import.meta.url).pathname);

vi.resetModules();
process.env.PANACHE_LANG = "en";
const { planVoice, voiceLines } = await import("../src/game/voice-lines");
const lines = voiceLines();

afterAll(() => {
  delete process.env.PANACHE_LANG;
  vi.resetModules();
});

describe("the English phrase book", () => {
  it("is English and matches its manifest (PANACHE_LANG=en npx vite-node tools/voice-manifest.ts)", () => {
    expect(lines.some((l) => l.text === "Not enough coal")).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(`${EN_DIR}manifest.json`, "utf8")) as { lines: { key: string; text: string; file: string }[] };
    expect(manifest.lines.map((l) => [l.key, l.text, l.file])).toEqual(lines.map((l) => [l.key, l.text, l.file]));
  });

  it("has a recorded clip for every entry", () => {
    const missing = lines.filter((l) => !fs.existsSync(EN_DIR + l.file) || fs.statSync(EN_DIR + l.file).size < 1000);
    expect(missing.map((l) => l.file)).toEqual([]);
    expect(new Set(lines.map((l) => l.file)).size).toBe(lines.length);
  });

  it("says whole lines in one clip", () => {
    expect(planVoice("Not enough coal")!.map((l) => l.text)).toEqual(["Not enough coal"]);
    expect(planVoice("Enemy aircraft detected")).toHaveLength(1);
  });
});
