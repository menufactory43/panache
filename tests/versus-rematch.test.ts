import { describe, expect, it, vi } from "vitest";

// (the lobby builds the VersusFeed only once a match starts: its game code stays out of this test)
vi.mock("../src/versus/feed", () => ({ VersusFeed: class {} }));

import * as lobby from "../src/versus/lobby";
import { DUEL_KEY, REMATCH_DUEL, REMATCH_KEY, readRematch, writeRematch, type RematchPlan } from "../src/versus/records";

// The rematch's storage has one source of truth (DUEL.md "Rematch"): records.ts owns the keys, the token
// and the parser; the lobby re-exports them and reads with them; main.ts, which may import the duel's types only,
// ties its literals to them by type. This checks the round trip the reloaded page makes, and the literals.

/** Every module under src/, as text (the literals outside src/versus). */
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** sessionStorage in memory. */
class Mem {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const PLAN: RematchPlan = { role: "guest", hostSide: "red", mapId: "riverlands", mutators: ["rapidfab"] };

describe("a rematch, from the report's Rematch to the reloaded page's lobby", () => {
  it("what the records' writer stores, the lobby's parser reads back whole", () => {
    const store = new Mem();
    expect(writeRematch(PLAN, store)).toBe(true);
    // the boot's token, under the key main.ts reads
    expect(store.getItem(lobby.REMATCH_KEY)).toBe(lobby.REMATCH_DUEL);
    // (main.ts takes the token at boot: the lobby reads the rematch alone)
    store.removeItem(lobby.REMATCH_KEY);
    expect(lobby.parseRematch(store.getItem(lobby.DUEL_KEY))).toEqual(PLAN);
    for (const role of ["host", "guest"] as const) {
      const p: RematchPlan = { ...PLAN, role, hostSide: role === "host" ? "blue" : "red", mutators: [] };
      writeRematch(p, store);
      expect(lobby.parseRematch(store.getItem(lobby.DUEL_KEY))).toEqual(p);
      expect(readRematch(store)).toEqual(p);
    }
  });

  it("the lobby's keys and parser are the records' own", () => {
    expect([lobby.REMATCH_KEY, lobby.REMATCH_DUEL, lobby.DUEL_KEY]).toEqual([REMATCH_KEY, REMATCH_DUEL, DUEL_KEY]);
    expect(new Set([REMATCH_KEY, DUEL_KEY]).size).toBe(2);
    // a stored rematch without its token is no rematch for the records (a reload after one is a plain boot)
    const store = new Mem();
    writeRematch(PLAN, store);
    store.removeItem(REMATCH_KEY);
    expect(readRematch(store)).toBeNull();
    expect(readRematch(null)).toBeNull();
    expect(writeRematch(PLAN, null)).toBe(false);
  });

  it("main.ts's literals are the records' key and token, and it reads the token with them", () => {
    const main = sources["../src/main.ts"]!;
    expect(main).toBeDefined();
    const literal = (name: string, of: string) => new RegExp(`const ${name}: typeof DuelLobby\\.${of} = "([^"]*)";`).exec(main)?.[1];
    expect(literal("REMATCH_KEY", "REMATCH_KEY")).toBe(REMATCH_KEY);
    expect(literal("DUEL_REMATCH", "REMATCH_DUEL")).toBe(REMATCH_DUEL);
    expect(main).toContain("sessionStorage.getItem(REMATCH_KEY)");
    expect(main).toContain("sessionStorage.removeItem(REMATCH_KEY)");
    expect(main).toContain("token === DUEL_REMATCH");
  });

  it("no other module outside the duel names a rematch key that isn't one of these", () => {
    const keys = new Set([REMATCH_KEY, DUEL_KEY]);
    const named: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      if (path.startsWith("../src/versus/") || path.startsWith("../src/link/")) continue;
      for (const m of text.matchAll(/["'`](panache\.(?:rematch|duel)(?:[.-][\w.-]*)?)["'`]/g)) {
        named.push(`${path.slice(3)}: ${m[1]}`);
        expect(keys.has(m[1]!), `${path.slice(3)} names "${m[1]}"`).toBe(true);
      }
    }
    // (main.ts's, and the single-player end screen's writer and the reload's reader of the same token key)
    expect(named.some((n) => n.startsWith("src/main.ts: "))).toBe(true);
    expect(named.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The rematch token as modules outside the duel compare it by hand: a
   * literal on either side of === or !== against a value named rematch or
   * token, in a module that reads the rematch key. Each is the duel's token or
   * one of the single-player end screen's (src/game/mode.ts rematchToken: "1",
   * "spectate", "daily"; an op's "op:<id>" is read with startsWith).
   */
  const SINGLE_TOKENS = ["1", "spectate", "daily"];
  function tokenLiterals(src: Record<string, string>): { at: string; literal: string }[] {
    const out: { at: string; literal: string }[] = [];
    for (const [path, text] of Object.entries(src)) {
      if (path.startsWith("../src/versus/") || path.startsWith("../src/link/")) continue;
      if (!text.includes(`"${REMATCH_KEY}"`)) continue;
      const cmp = /\b(?:rematch|token)\s*[!=]==\s*"([^"]*)"|"([^"]*)"\s*[!=]==\s*(?:rematch|token)\b/g;
      for (const m of text.matchAll(cmp)) out.push({ at: path.slice(3), literal: (m[1] ?? m[2])! });
    }
    return out;
  }

  it("every module outside the duel that compares the token by hand compares it with the records' own", () => {
    const found = tokenLiterals(sources);
    // (the reload that keeps a practice rematch's ?duel= parameters, src/ui/fullscreen.ts reloadWithoutLink)
    expect(found.filter((f) => f.literal === REMATCH_DUEL).map((f) => f.at)).toContain("src/ui/fullscreen.ts");
    for (const f of found) expect([REMATCH_DUEL, ...SINGLE_TOKENS], `${f.at} compares the rematch token with "${f.literal}"`).toContain(f.literal);
    // (a duel's token that a single-player boot also took would start the wrong game)
    expect(SINGLE_TOKENS).not.toContain(REMATCH_DUEL);
    // the check sees a stale copy: the token renamed in the records alone
    const stale = { ...sources, "../src/ui/fullscreen.ts": sources["../src/ui/fullscreen.ts"]!.replace(`=== "${REMATCH_DUEL}"`, '=== "old-duel"') };
    expect(tokenLiterals(stale).filter((f) => ![REMATCH_DUEL, ...SINGLE_TOKENS].includes(f.literal))).toEqual([{ at: "src/ui/fullscreen.ts", literal: "old-duel" }]);
  });
});

describe("nations in a duel's rematch and saved battle (LOBBY_PROTO 2)", () => {
  it("the rematch keeps the nation this phone played; anything else reads as Classique", () => {
    const base = { role: "guest", hostSide: "red", mapId: "riverlands", mutators: [] };
    expect(lobby.parseRematch(JSON.stringify({ ...base, nation: "empire" }))?.nation).toBe("empire");
    expect(lobby.parseRematch(JSON.stringify({ ...base, nation: "classique" }))).not.toHaveProperty("nation");
    expect(lobby.parseRematch(JSON.stringify({ ...base, nation: "atlantis" }))).not.toHaveProperty("nation");
    expect(lobby.parseRematch(JSON.stringify(base))).not.toHaveProperty("nation");
  });

  it("a saved battle with nations replays them, and the viewer refuses nations it can't read", async () => {
    const { battleRecord } = await import("../src/versus/records");
    const { parseRecord } = await import("../src/game/replay");
    const { setupWorld, worldHash } = await import("../src/arena/record");
    const setup = { map: "riverlands", seed: 7, mutators: [], openers: {}, nations: { blue: "empire", red: "republique" } } as const;
    const rec = battleRecord({
      setup: { ...setup, mutators: [], nations: { ...setup.nations } }, seats: { blue: "host", red: "guest" }, via: "online-duel",
      turns: [], hashes: [], tick: 10, end: { tick: 10, winner: null, reason: "aborted" }, sim: null, created: "2026-10-22T00:00:00Z"
    });
    expect(rec.nations).toEqual({ blue: "empire", red: "republique" });
    const back = parseRecord(JSON.stringify(rec));
    expect(worldHash(setupWorld(back))).toBe(worldHash(setupWorld({ ...setup, mutators: [], nations: { ...setup.nations } })));
    expect(worldHash(setupWorld(back))).not.toBe(worldHash(setupWorld({ ...setup, mutators: [], nations: undefined })));
    expect(() => parseRecord(JSON.stringify({ ...rec, nations: { blue: "empire" } }))).toThrow(/nations/);
    expect(() => parseRecord(JSON.stringify({ ...rec, nations: { blue: "empire", red: "atlantis" } }))).toThrow(/nations/);
  });
});
