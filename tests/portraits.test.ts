/**
 * The HUD portraits (ICONS.md): shots of the 3D models, blue for every kind and red for every unit
 * and building, all made by tools/model-portraits.mjs --all; the nations' (PANACHE-CONCEPTION.md
 * WP5g) by --nations: their own units and defences, and their own models of shared buildings
 * (hq@empire → hq-empire.webp, placeholders.ts portraitKind).
 */
import { describe, expect, it } from "vitest";
import { BUILDING_KINDS, UNIT_KINDS } from "../src/game/assets";
import { BUILDINGS, UNITS } from "../src/sim/balance";
import type { Nation } from "../src/sim/types";
import { NATION_PORTRAIT_BUILDINGS, portraitKind } from "../src/game/three/belle/placeholders";

const NATION_UNITS = (Object.keys(UNITS) as (keyof typeof UNITS)[]).filter((k) => UNITS[k].nation);
const NATION_ONLY = (Object.keys(BUILDINGS) as (keyof typeof BUILDINGS)[]).filter((k) => BUILDINGS[k].nation);
const NATION_SHARED = (Object.entries(NATION_PORTRAIT_BUILDINGS) as [Nation, readonly string[]][]).flatMap(([n, ks]) => ks.map((k) => `${k}-${n}`));
/** Every nation portrait's file name. */
const NATION_FILES = [...NATION_UNITS, ...NATION_ONLY, ...NATION_SHARED];

const OBJECTIVES = ["uplink", "supply-crate"];
const blue = Object.keys(import.meta.glob("../public/assets/icons/*.webp")).map((p) => p.slice(p.lastIndexOf("/") + 1, -5));
const red = Object.keys(import.meta.glob("../public/assets/icons/red/*.webp")).map((p) => p.slice(p.lastIndexOf("/") + 1, -5));
const script = Object.values(
  import.meta.glob("../tools/model-portraits.mjs", { query: "?raw", import: "default", eager: true }) as Record<string, string>
)[0]!;
// (no Node types in this project: fs is read untyped, for the files' bytes)
const fs: { readFileSync(path: string): Uint8Array } = await import(/* @vite-ignore */ ["node", "fs"].join(":"));

/** A WebP's canvas size, from its header (lossy with alpha is VP8X; plain lossy VP8; lossless VP8L). */
function webpSize(file: string): [number, number] {
  const b = fs.readFileSync(file);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
  expect(tag(0) + tag(8)).toBe("RIFFWEBP");
  const u24 = (at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
  if (tag(12) === "VP8X") return [1 + u24(24), 1 + u24(27)];
  if (tag(12) === "VP8 ") return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
  const bits = v.getUint32(21, true);
  return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
}

/** The kinds a list in tools/model-portraits.mjs names (`const NAME = [ ... ];`). */
function scriptList(name: string): string[] {
  const m = script.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  expect(m, name).not.toBeNull();
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("HUD portraits", () => {
  it("are shot for every kind: the script's lists are the game's", () => {
    expect(scriptList("UNITS")).toEqual(UNIT_KINDS);
    expect(scriptList("BUILDINGS")).toEqual(BUILDING_KINDS);
    expect(scriptList("OBJECTIVES")).toEqual(OBJECTIVES);
    expect(scriptList("NATION_UNITS").sort()).toEqual([...NATION_UNITS].sort());
    expect(scriptList("NATION_BUILDINGS").map((k) => k.replace("@", "-")).sort()).toEqual([...NATION_ONLY, ...NATION_SHARED].sort());
  });

  it("show a nation's own portrait for its own kinds and its own buildings", () => {
    expect(portraitKind("fourgon")).toBe("fourgon");
    expect(portraitKind("arsonval", "republique")).toBe("arsonval");
    expect(portraitKind("hq", "empire")).toBe("hq-empire");
    expect(portraitKind("hq", "republique")).toBe("hq");
    expect(portraitKind("hq")).toBe("hq");
    expect(portraitKind("fab-plant", "republique")).toBe("fab-plant-republique");
    expect(portraitKind("fab-plant", "classique")).toBe("fab-plant");
  });

  it("exist for every unit, building and objective, 256 px square", () => {
    expect(blue.sort()).toEqual([...UNIT_KINDS, ...BUILDING_KINDS, ...OBJECTIVES, ...NATION_FILES].sort());
    for (const k of blue) expect(webpSize(`public/assets/icons/${k}.webp`), k).toEqual([256, 256]);
  });

  it("exist in red for every unit and building (the objectives belong to no side)", () => {
    expect(red.sort()).toEqual([...UNIT_KINDS, ...BUILDING_KINDS, ...NATION_FILES].sort());
    for (const k of red) expect(webpSize(`public/assets/icons/red/${k}.webp`), k).toEqual([256, 256]);
  });
});
