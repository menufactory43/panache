import { describe, expect, it } from "vitest";
import type { BattleRecord } from "../src/arena/record";
import { ARCHIVE, archiveId, archiveMatch, decodeRecord, encodeRecord, loadMatch, localStore, memoryStore, metaOf, pruneArchive, type ArchiveMeta } from "../src/game/archive";
import { archiveLine } from "../src/ui/archives";

const record = (created: string, extra = 0): BattleRecord => ({
  v: 1, commit: null, sim: null, created, map: "riverlands", mutators: [], seed: 7, round: 1, maxTicks: 4620,
  openers: { blue: "blitz" }, seats: { blue: { player: "Toi" }, red: { player: "IA Rush (Normal)" } }, frames: "own",
  turns: [[0, "blue", [{ type: "move", faction: "blue", unitIds: [3], x: 4.5, y: 4.5, ...(extra ? { pad: "x".repeat(extra) } : {}) } as never]]],
  radio: [], hashes: [[100, "deadbeef"]], log: [], tick: 4620, end: { tick: 4620, winner: "blue", reason: "hq" }, usage: {},
  played: { pov: "blue", kind: "escarmouche", result: "win", against: "IA Rush (Normal)" },
  reel: [{ kind: "end", tick: 4620, title: "La victoire" }]
});
const meta = (id: string, created: string, bytes = 100): ArchiveMeta => ({ id, created, map: "riverlands", secs: 60, played: null, bytes, reel: false });

describe("record encoding", () => {
  it("round-trips a record", () => {
    const r = record("2026-10-22T10:00:00.000Z");
    expect(decodeRecord(encodeRecord(r))).toEqual(r);
  });

  it("refuses what isn't a record", () => {
    expect(() => decodeRecord("not json")).toThrow();
    expect(() => decodeRecord("{}")).toThrow(/enregistrement/);
    expect(() => decodeRecord(JSON.stringify({ ...record("x"), v: 2 }))).toThrow();
    expect(() => decodeRecord(JSON.stringify({ ...record("x"), turns: [[0, "green", []]] }))).toThrow(/Tour/);
  });

  it("lists a match by its result, map, day, length and opponent", () => {
    const r = record("2026-10-22T10:00:00.000Z");
    const m = metaOf(r, encodeRecord(r), "a");
    expect(m).toMatchObject({ secs: 462, reel: true, played: { result: "win" } });
    const l = archiveLine(m);
    expect(l.head).toBe("Victoire · Terres fluviales");
    expect(l.sub).toMatch(/7:42 · Escarmouche contre IA Rush \(Normal\)$/);
  });

  it("makes ids that sort by time", () => {
    const a = archiveId("2026-10-22T10:00:00.000Z", () => 0.5);
    expect(a.startsWith("20261022100000-")).toBe(true);
  });
});

describe("pruning", () => {
  it("keeps the newest `max`", () => {
    const list = [1, 2, 3, 4, 5, 6, 7].map((i) => meta(`m${i}`, `2026-10-0${i}T00:00:00Z`));
    expect(pruneArchive(list, 5).sort()).toEqual(["m1", "m2"]);
  });

  it("drops the oldest past the byte budget, but never the newest", () => {
    const list = [meta("old", "2026-01-01", 600), meta("mid", "2026-02-01", 600), meta("new", "2026-03-01", 600)];
    expect(pruneArchive(list, 5, 1300)).toEqual(["old"]);
    expect(pruneArchive([meta("huge", "2026-03-01", 9e9)], 5, 10)).toEqual([]);
  });
});

describe("the Archives", () => {
  it("keeps the last five, newest first", async () => {
    const store = memoryStore();
    for (let i = 1; i <= 7; i++) await archiveMatch(store, record(`2026-10-${10 + i}T10:00:00.000Z`));
    const list = await store.list();
    expect(list).toHaveLength(ARCHIVE.max);
    expect(list[0]!.created).toBe("2026-10-17T10:00:00.000Z");
    expect(list.at(-1)!.created).toBe("2026-10-13T10:00:00.000Z");
    const back = await loadMatch(store, list[0]!.id);
    expect(back?.created).toBe("2026-10-17T10:00:00.000Z");
  });

  it("won't keep a record over the size limit", async () => {
    const store = memoryStore();
    expect(await archiveMatch(store, record("2026-10-22T10:00:00.000Z", ARCHIVE.recordBytes))).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it("in localStorage, makes room under its budget from the oldest", async () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const store = localStore(storage, 5000);
    for (let i = 1; i <= 4; i++) await archiveMatch(store, record(`2026-10-1${i}T10:00:00.000Z`, 1500));
    const list = await store.list();
    expect(list.length).toBeLessThan(4);
    expect(list[0]!.created).toBe("2026-10-14T10:00:00.000Z");
    expect(list.reduce((s, x) => s + x.bytes, 0)).toBeLessThanOrEqual(5000);
    // a junk key reads as empty
    m.set("panache.archives", "{oops");
    expect(await store.list()).toEqual([]);
  });

  it("a missing or broken entry loads as null", async () => {
    const store = memoryStore();
    await store.put(meta("bad", "2026-10-01"), "{nope");
    expect(await loadMatch(store, "bad")).toBeNull();
    expect(await loadMatch(store, "gone")).toBeNull();
  });
});
