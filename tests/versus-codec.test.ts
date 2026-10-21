import { beforeAll, describe, expect, it } from "vitest";
import { Arena, parseSeat } from "../src/arena/match";
import type { BattleRecord } from "../src/arena/record";
import { BUILDINGS, UNITS } from "../src/sim/balance";
import { mapById } from "../src/sim/maps";
import { POWER_KINDS as SIM_POWER_KINDS } from "../src/sim/powers";
import type { MutatorId } from "../src/sim/rules";
import type { Command, Faction } from "../src/sim/types";
import {
  BUILDING_KINDS, BitReader, BitWriter, CODEC_VERSION, COMMAND_TYPES, C_MAX, CodecError, ID_LIMIT, POWER_KINDS, TABLES_COMPLETE,
  UNIT_KINDS, bitsFor, canonicalize, commandBits, decode, decodeCommands, encode, encodeCommands, seBits, ueBits, type CanonContext
} from "../src/versus/codec";

/** The bits a writer holds, as "0101…". */
const str = (wr: BitWriter) => {
  const b = wr.bytes();
  let s = "";
  for (let i = 0; i < wr.nbits; i++) s += (b[i >> 3]! >> (7 - (i & 7))) & 1;
  return s;
};

/** A reader over a "0101…" string. */
const reader = (s: string) => {
  const wr = new BitWriter();
  for (const ch of s) wr.bit(ch === "1" ? 1 : 0);
  return new BitReader(wr.bytes(), wr.nbits);
};

/** Seeded LCG, for fuzzing. */
const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);

/** The first difference between two commands: same keys, Object.is per scalar, element-wise for unitIds. */
function diff(a: Command, b: Command): string | null {
  const ka = Object.keys(a).sort().join();
  const kb = Object.keys(b).sort().join();
  if (ka !== kb) return `keys ${ka} vs ${kb}`;
  for (const k of Object.keys(a)) {
    const va = (a as unknown as Record<string, unknown>)[k];
    const vb = (b as unknown as Record<string, unknown>)[k];
    if (Array.isArray(va) || Array.isArray(vb)) {
      if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length || va.some((v, i) => !Object.is(v, vb[i])))
        return `${k}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`;
    } else if (!Object.is(va, vb)) return `${k}: ${String(va)} vs ${String(vb)}`;
  }
  return null;
}

interface Sample {
  c: Command;
  ctx: CanonContext;
  src: string;
}

// ----------------------------------------------------------------- corpus ---

/** Short AI-vs-AI arena matches: the commands the built-in AI really issues (raw float coordinates, big unit lists). */
const MATCHES: { map: string; seed: number; mutators: MutatorId[]; blue: string; red: string; ticks: number }[] = [
  { map: "riverlands", seed: 42, mutators: [], blue: "ai:balanced:normal", red: "ai:rush:normal", ticks: 3000 },
  { map: "archipelago", seed: 7, mutators: ["airborne"], blue: "ai:airswarm:normal", red: "ai:boom:normal", ticks: 3000 },
  { map: "frostbite", seed: 11, mutators: ["nomads"], blue: "ai:ironclad:normal", red: "ai:balanced:normal", ticks: 2500 },
  { map: "dune-sea", seed: 5, mutators: ["armada"], blue: "ai:balanced:normal", red: "ai:skyforce:normal", ticks: 2500 },
  { map: "random-volcanic-k3x9a", seed: 9, mutators: ["veterans", "goldrush"], blue: "ai:rush:hard", red: "ai:boom:hard", ticks: 2500 }
];

/** Turns of a match: [side, commands] with the map they were issued on. */
type Turn = { ctx: CanonContext; cmds: Command[]; src: string };

const turns: Turn[] = [];

function arenaTurns(): void {
  for (const m of MATCHES) {
    const a = new Arena({ map: m.map, seed: m.seed, mutators: m.mutators, maxTicks: m.ticks, seats: { blue: parseSeat(m.blue), red: parseSeat(m.red) } });
    a.advance();
    for (const [tick, side, cmds] of a.record.turns)
      turns.push({ ctx: { local: side, width: a.w.width, height: a.w.height }, cmds, src: `${m.map}@${tick}` });
  }
}

function showcaseTurns(): void {
  const records = import.meta.glob("../battles/showcase/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  for (const [file, text] of Object.entries(records)) {
    const r = JSON.parse(text) as BattleRecord;
    const size = mapById(r.map).size;
    for (const [tick, side, cmds] of r.turns) turns.push({ ctx: { local: side, width: size, height: size }, cmds, src: `${file}@${tick}` });
  }
}

const SMALL: CanonContext = { local: "blue", width: 48, height: 48 };
const BIG: CanonContext = { local: "red", width: 108, height: 108 };
const TOP = ID_LIMIT - 1;

/** By hand: every command type, with the extremes (ids 0 and 2^24 − 1, coordinates off the map, the last tile). */
function handWritten(): Sample[] {
  const out: Sample[] = [];
  const add = (c: Command, ctx: CanonContext = SMALL) => out.push({ c, ctx, src: `hand:${c.type}` });
  for (const ctx of [SMALL, BIG]) {
    const f: Faction = ctx.local === "blue" ? "red" : "blue"; // (canonicalize stamps the local side over whatever it says)
    const S = ctx.width;
    for (const [x, y] of [[0, 0], [S - 1e-9, S - 1e-9], [-5, 1e9], [12.5, 7], [3.999999, 0.0625], [S / 2 + 1 / 32, S / 3]] as const) {
      add({ type: "move", faction: f, unitIds: [5, 3, 3, 9], x, y }, ctx);
      add({ type: "attackMove", faction: f, unitIds: [TOP, 0], x, y }, ctx);
      add({ type: "harvest", faction: f, unitIds: [17], x, y }, ctx);
      add({ type: "rally", faction: f, buildingId: TOP, x, y }, ctx);
      add({ type: "unload", faction: f, unitIds: [40, 41], x, y }, ctx);
      for (const power of POWER_KINDS) add({ type: "calldown", faction: f, power, x, y }, ctx);
    }
    add({ type: "attack", faction: f, unitIds: [1, 2, 3], targetId: 0 }, ctx);
    add({ type: "attack", faction: f, unitIds: [TOP], targetId: TOP }, ctx);
    for (const type of ["stop", "anchor", "packUp"] as const) add({ type, faction: f, unitIds: [0, 1, TOP] }, ctx);
    for (const unit of UNIT_KINDS) {
      add({ type: "produce", faction: f, buildingId: 12, unit }, ctx);
      add({ type: "cancelProduce", faction: f, buildingId: TOP, unit }, ctx);
    }
    for (const building of BUILDING_KINDS) add({ type: "startBuilding", faction: f, building }, ctx);
    for (const type of ["cancelBuilding", "callWave", "resign"] as const) add({ type, faction: f }, ctx);
    for (const [tx, ty] of [[0, 0], [S - 1, S - 1], [7, S - 1]] as const) add({ type: "placeBuilding", faction: f, tx, ty }, ctx);
    add({ type: "sell", faction: f, buildingId: 0 }, ctx);
    add({ type: "sell", faction: f, buildingId: TOP }, ctx);
    add({ type: "board", faction: f, unitIds: [30, 31], carrierId: TOP }, ctx);
    add({ type: "unload", faction: f, unitIds: [44] }, ctx);
    add({ type: "unload", faction: f, unitIds: [44], x: 3, y: NaN }, ctx); // (no point: both must be finite)
    add({ type: "unload", faction: f, unitIds: [44], x: Infinity, y: 2 }, ctx);
    add({ type: "lift", faction: f, unitIds: [70, 71], goliathId: 69 }, ctx);
    add({ type: "lift", faction: f, unitIds: [0, TOP], goliathId: 5 }, ctx);
    // long lists, split into pieces
    const many = Array.from({ length: 30 }, (_, i) => 400 + i * 37);
    add({ type: "attackMove", faction: f, unitIds: [...many].reverse(), x: 20.1234, y: 9.87 }, ctx);
    add({ type: "board", faction: f, unitIds: many, carrierId: 1000 }, ctx);
    add({ type: "unload", faction: f, unitIds: many }, ctx);
    add({ type: "stop", faction: f, unitIds: Array.from({ length: 200 }, (_, i) => i * 1000 + 7) }, ctx);
    add({ type: "attack", faction: f, unitIds: Array.from({ length: 64 }, (_, i) => TOP - i * 3), targetId: TOP }, ctx);
    // −0 passes as an id or a tile (it's an integer, and not below 0), but decodes as +0: canonical is +0
    add({ type: "stop", faction: f, unitIds: [-0, 4] }, ctx);
    add({ type: "move", faction: f, unitIds: [0, -0, 2], x: -0, y: -0 }, ctx);
    add({ type: "attack", faction: f, unitIds: [-0], targetId: -0 }, ctx);
    add({ type: "produce", faction: f, buildingId: -0, unit: "scout" }, ctx);
    add({ type: "sell", faction: f, buildingId: -0 }, ctx);
    add({ type: "rally", faction: f, buildingId: -0, x: 1, y: 1 }, ctx);
    add({ type: "placeBuilding", faction: f, tx: -0, ty: -0 }, ctx);
    add({ type: "board", faction: f, unitIds: [3], carrierId: -0 }, ctx);
    add({ type: "lift", faction: f, unitIds: [-0, 1], goliathId: -0 }, ctx);
  }
  return out;
}

beforeAll(() => {
  arenaTurns();
  showcaseTurns();
}, 180_000);

// ------------------------------------------------------------------ tests ---

describe("bit I/O and Exp-Golomb", () => {
  it("writes MSB-first", () => {
    const wr = new BitWriter();
    wr.bits(0b101, 3);
    wr.bits(0xabcd, 16);
    expect(wr.nbits).toBe(19);
    expect([...wr.bytes()]).toEqual([0b10110101, 0b01111001, 0b10100000]);
    const rd = new BitReader(wr.bytes(), wr.nbits);
    expect(rd.bits(3)).toBe(5);
    expect(rd.bits(16)).toBe(0xabcd);
    expect(() => rd.bit()).toThrow(CodecError);
  });

  it("codes UE and SE as the spec says", () => {
    const ue = (v: number) => {
      const wr = new BitWriter();
      wr.ue(v);
      return str(wr);
    };
    expect([0, 1, 2, 3, 6, 7, 14].map(ue)).toEqual(["1", "010", "011", "00100", "00111", "0001000", "0001111"]);
    const se = (v: number) => {
      const wr = new BitWriter();
      wr.se(v);
      return str(wr);
    };
    // 0, 1, −1, 2, −2 → 0, 1, 2, 3, 4
    expect([0, 1, -1, 2, -2].map(se)).toEqual([0, 1, 2, 3, 4].map(ue));
    expect(Object.is(reader("1").se(), 0)).toBe(true); // (+0, never −0)
  });

  it("round-trips any value, in the bits ueBits and seBits count", () => {
    const rnd = lcg(3);
    const wr = new BitWriter();
    const vals: number[] = [];
    let n = 0;
    for (let i = 0; i < 3000; i++) {
      const v = Math.floor(rnd() ** 4 * (2 ** 25 - 1));
      const s = Math.floor((rnd() - 0.5) * 2 ** (1 + (i % 20)));
      wr.ue(v);
      wr.se(s);
      vals.push(v, s);
      n += ueBits(v) + seBits(s);
    }
    expect(wr.nbits).toBe(n);
    const rd = new BitReader(wr.bytes(), wr.nbits);
    for (let i = 0; i < vals.length; i += 2) {
      expect(rd.ue()).toBe(vals[i]);
      expect(rd.se()).toBe(vals[i + 1]);
    }
    expect(rd.pos).toBe(rd.nbits);
  });

  it("refuses what it can't code, and rejects garbage", () => {
    const wr = new BitWriter();
    for (const v of [-1, 0.5, NaN, 2 ** 25 - 1]) expect(() => wr.ue(v)).toThrow(CodecError);
    wr.ue(2 ** 25 - 2); // the largest: 24 leading zeros
    expect(wr.nbits).toBe(49);
    expect(new BitReader(wr.bytes(), wr.nbits).ue()).toBe(2 ** 25 - 2);
    expect(() => reader("0".repeat(25) + "1" + "0".repeat(25)).ue()).toThrow(/24 leading zeros/);
    expect(() => reader("0001").ue()).toThrow(/past the end/);
    // (nbits past the buffer is clamped to it)
    expect(() => new BitReader(new Uint8Array(1), 100).bits(9)).toThrow(CodecError);
    expect([1, 2, 3, 48, 64, 108, 768, 1024, 1728].map(bitsFor)).toEqual([0, 1, 2, 6, 6, 7, 10, 10, 11]);
  });
});

describe("the command codec", () => {
  it("is lossless for canonical commands over the corpus", { timeout: 120_000 }, () => {
    const samples: Sample[] = [...handWritten()];
    for (const t of turns) for (const c of t.cmds) samples.push({ c, ctx: t.ctx, src: t.src });
    expect(turns.length).toBeGreaterThan(2000);
    const failures: string[] = [];
    const seen = new Set<string>();
    let split = 0;
    for (const { c, ctx, src } of samples) {
      const ks = canonicalize(c, ctx);
      if (ks.length > 1) split++;
      for (const k of ks) {
        seen.add(k.type);
        if (k.faction !== ctx.local) failures.push(`${src}: faction ${k.faction}`);
        const again = canonicalize(k, ctx);
        const d0 = again.length === 1 ? diff(again[0]!, k) : `canonicalize gave ${again.length}`;
        if (d0) failures.push(`${src}: canonicalize(k) ≠ k: ${d0}`);
        const e = encode(k, ctx);
        if (e.nbits !== commandBits(k, ctx)) failures.push(`${src}: ${e.nbits} bits vs commandBits ${commandBits(k, ctx)}`);
        const d1 = diff(decode(e.bits, e.nbits, ctx, ctx.local), k);
        if (d1) failures.push(`${src}: decode(encode(k)) ≠ k: ${d1}`);
        // (quantizing keeps the tile, so harvest's Math.floor is unchanged)
        if ("x" in k && k.x !== undefined && "x" in c && Number.isFinite(c.x) && c.x! >= 0 && c.x! < ctx.width && Math.floor(k.x) !== Math.floor(c.x!))
          failures.push(`${src}: x ${c.x} moved to tile ${Math.floor(k.x)}`);
      }
      if (ks.length > 1) {
        // split pieces: at most C_MAX bits each, same type and parameters, the ids in order
        const ids = [...new Set((c as { unitIds: number[] }).unitIds)].sort((a, b) => a - b);
        expect(ks.flatMap((k) => (k as { unitIds: number[] }).unitIds)).toEqual(ids);
        for (const k of ks) {
          // (a one-unit piece can't split further: past C_MAX only with ids near 2^24, still within an empty turn)
          const n = commandBits(k, ctx);
          const one = (k as { unitIds: number[] }).unitIds.length === 1;
          if (n > (one ? 186 - 57 : C_MAX)) failures.push(`${src}: a ${n}-bit piece`);
          expect({ ...k, unitIds: [] }).toEqual({ ...ks[0]!, unitIds: [] });
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect([...seen].sort()).toEqual([...COMMAND_TYPES].sort());
    expect(split).toBeGreaterThan(10);
  });

  it("codes whole turns, reusing the previous unit list", { timeout: 60_000 }, () => {
    let reused = 0;
    for (const t of turns) {
      const ks = t.cmds.flatMap((c) => canonicalize(c, t.ctx));
      if (!ks.length) continue;
      const wr = new BitWriter();
      encodeCommands(wr, ks, t.ctx);
      const alone = ks.reduce((n, k) => n + commandBits(k, t.ctx), 0);
      if (wr.nbits < alone) reused++;
      const back = decodeCommands(new BitReader(wr.bytes(), wr.nbits), ks.length, t.ctx, t.ctx.local);
      expect(back.length).toBe(ks.length);
      back.forEach((d, i) => expect(diff(d, ks[i]!), t.src).toBeNull());
    }
    expect(reused).toBeGreaterThan(0);
    // two commands for the same units: the second costs one bit for its list
    const ctx = SMALL;
    const a: Command = { type: "move", faction: "blue", unitIds: [3, 9, 27], x: 4.03125, y: 5.03125 };
    const b: Command = { type: "attack", faction: "blue", unitIds: [3, 9, 27], targetId: 99 };
    const wr = new BitWriter();
    encodeCommands(wr, [a, { type: "produce", faction: "blue", buildingId: 4, unit: "scout" }, b], ctx);
    expect(commandBits(b, ctx, a.unitIds)).toBe(5 + 1 + ueBits(99));
    expect(wr.nbits).toBe(commandBits(a, ctx) + commandBits({ type: "produce", faction: "blue", buildingId: 4, unit: "scout" }, ctx) + 5 + 1 + ueBits(99));
  });

  it("canonicalizes −0 to the +0 the decoder returns", () => {
    const ctx = SMALL;
    const plus = (v: unknown) => Object.is(v, 0);
    for (const c of [
      { type: "sell", faction: "blue", buildingId: -0 },
      { type: "placeBuilding", faction: "blue", tx: -0, ty: -0 },
      { type: "attack", faction: "blue", unitIds: [-0, 0], targetId: -0 },
      { type: "lift", faction: "blue", unitIds: [-0, 1], goliathId: -0 }
    ] as Command[]) {
      const [k] = canonicalize(c, ctx);
      for (const [key, v] of Object.entries(k!)) {
        if (Array.isArray(v)) expect(plus(v[0]), `${c.type}.${key}`).toBe(true);
        else if (typeof v === "number") expect(plus(v), `${c.type}.${key}`).toBe(true);
      }
      const e = encode(k!, ctx);
      expect(diff(decode(e.bits, e.nbits, ctx, "blue"), k!)).toBeNull();
    }
  });

  it("splits long unit lists and drops what can't be sent", () => {
    const ctx = SMALL;
    const ids = Array.from({ length: 30 }, (_, i) => 500 + i * 41);
    const pieces = canonicalize({ type: "move", faction: "red", unitIds: ids, x: 10, y: 10 }, ctx);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.flatMap((p) => (p as { unitIds: number[] }).unitIds)).toEqual(ids);
    for (const p of pieces) expect(commandBits(p, ctx)).toBeLessThanOrEqual(C_MAX);
    // greedy: every piece but the last would overflow with the next id
    for (let i = 0; i + 1 < pieces.length; i++) {
      const p = pieces[i] as Extract<Command, { type: "move" }>;
      const next = (pieces[i + 1] as Extract<Command, { type: "move" }>).unitIds[0]!;
      expect(commandBits({ ...p, unitIds: [...p.unitIds, next] }, ctx)).toBeGreaterThan(C_MAX);
    }
    // lift picks the nearest two of the Condors it names, so it never splits: one too long is dropped
    expect(canonicalize({ type: "lift", faction: "blue", unitIds: ids, goliathId: 3 }, ctx)).toEqual([]);
    // one unit can't split: past C_MAX only with ids near 2^24, and it still fits an empty turn (capacity − 57)
    const [one, ...rest] = canonicalize({ type: "attack", faction: "blue", unitIds: [TOP], targetId: TOP }, ctx);
    expect(rest).toEqual([]);
    expect(commandBits(one!, ctx)).toBeGreaterThan(C_MAX);
    expect(commandBits(one!, ctx)).toBeLessThanOrEqual(186 - 57);
  });

  it("drops commands that can't be encoded or do nothing", () => {
    const f: Faction = "blue";
    const bad: Command[] = [
      { type: "move", faction: f, unitIds: [], x: 1, y: 1 },
      { type: "move", faction: f, unitIds: [1, NaN], x: 1, y: 1 },
      { type: "move", faction: f, unitIds: [1, -2], x: 1, y: 1 },
      { type: "move", faction: f, unitIds: [1.5], x: 1, y: 1 },
      { type: "move", faction: f, unitIds: [ID_LIMIT], x: 1, y: 1 },
      { type: "move", faction: f, unitIds: [1], x: NaN, y: 1 },
      { type: "attackMove", faction: f, unitIds: [1], x: 1, y: Infinity },
      { type: "harvest", faction: f, unitIds: [1], x: undefined as unknown as number, y: 1 },
      { type: "attack", faction: f, unitIds: [1], targetId: -1 },
      { type: "stop", faction: f, unitIds: [] },
      { type: "produce", faction: f, buildingId: NaN, unit: "scout" },
      { type: "produce", faction: f, buildingId: 3, unit: "tank" as never },
      { type: "startBuilding", faction: f, building: "castle" as never },
      { type: "placeBuilding", faction: f, tx: 48, ty: 0 },
      { type: "placeBuilding", faction: f, tx: 0, ty: -1 },
      { type: "placeBuilding", faction: f, tx: 2.5, ty: 3 },
      { type: "sell", faction: f, buildingId: 2 ** 30 },
      { type: "rally", faction: f, buildingId: 4, x: NaN, y: NaN },
      { type: "calldown", faction: f, power: "nuke" as never, x: 1, y: 1 },
      { type: "board", faction: f, unitIds: [1], carrierId: 0.5 },
      { type: "unload", faction: f, unitIds: [] },
      { type: "lift", faction: f, unitIds: [1, 2], goliathId: -3 },
      { type: "teleport", faction: f } as unknown as Command,
      { type: "move", faction: f, unitIds: "1,2" as unknown as number[], x: 1, y: 1 }
    ];
    for (const c of bad) expect(canonicalize(c, SMALL), JSON.stringify(c)).toEqual([]);
  });

  it("rejects malformed input", () => {
    const ctx = SMALL; // 48 tiles: x and y in 10 bits, tiles in 6
    const bits = (...parts: [number, number][]) => {
      const wr = new BitWriter();
      for (const [v, n] of parts) wr.bits(v, n);
      return wr;
    };
    const one = (wr: BitWriter) => () => decode(wr.bytes(), wr.nbits, ctx, "red");
    const T = (t: string) => COMMAND_TYPES.indexOf(t as (typeof COMMAND_TYPES)[number]);
    // a type outside the table
    for (let t = COMMAND_TYPES.length; t < 32; t++) expect(one(bits([t, 5], [0, 40])), `type ${t}`).toThrow(/outside its table/);
    // a unit kind or building kind outside its table
    expect(one(bits([T("produce"), 5], [0b010, 3], [16, 5]))).toThrow(/outside its table/);
    expect(one(bits([T("startBuilding"), 5], [10, 4]))).toThrow(/outside its table/);
    // sameAsPrevious with no previous list
    expect(one(bits([T("stop"), 5], [1, 1]))).toThrow(/no previous/);
    // a cell off the map, a tile off the map
    expect(one(bits([T("rally"), 5], [1, 1], [768, 10], [5, 10]))).toThrow(/off a 48-tile map/);
    expect(one(bits([T("calldown"), 5], [0, 2], [5, 10], [1023, 10]))).toThrow(/off a 48-tile map/);
    expect(one(bits([T("placeBuilding"), 5], [48, 6], [0, 6]))).toThrow(/off a 48-tile map/);
    expect(one(bits([T("placeBuilding"), 5], [3, 6], [63, 6]))).toThrow(/off a 48-tile map/);
    // a UE with more than 24 leading zeros
    expect(one(bits([T("sell"), 5], [0, 25], [1, 1], [0, 25]))).toThrow(/24 leading zeros/);
    // ids no canonical command has (≥ 2^24)
    const big = new BitWriter();
    big.bits(T("sell"), 5);
    big.ue(ID_LIMIT);
    expect(one(big)).toThrow(/past 2\^24/);
    // a read past the end: every truncation of every command
    for (const { c, ctx: x } of handWritten().slice(0, 80))
      for (const k of canonicalize(c, x)) {
        const e = encode(k, x);
        for (let n = 0; n < e.nbits; n++) expect(() => decode(e.bits, n, x, "red")).toThrow(CodecError);
      }
    // the encoder refuses non-canonical lists
    expect(() => encode({ type: "stop", faction: "blue", unitIds: [5, 5] }, ctx)).toThrow(CodecError);
    expect(() => encode({ type: "stop", faction: "blue", unitIds: [6, 5] }, ctx)).toThrow(CodecError);
  });

  it("decodes random bits to valid commands or rejects them", () => {
    const rnd = lcg(11);
    let ok = 0;
    for (let i = 0; i < 20_000; i++) {
      const n = 1 + Math.floor(rnd() * 190);
      const bytes = new Uint8Array((n + 7) >> 3).map(() => Math.floor(rnd() * 256));
      const ctx = i % 2 ? SMALL : BIG;
      let cmds: Command[];
      try {
        cmds = decodeCommands(new BitReader(bytes, n), 1 + Math.floor(rnd() * 4), ctx, "red");
      } catch (e) {
        expect(e).toBeInstanceOf(CodecError);
        continue;
      }
      ok++;
      for (const c of cmds) {
        expect(c.faction).toBe("red");
        for (const [k, v] of Object.entries(c)) {
          if (k === "x" || k === "y") {
            const size = k === "x" ? ctx.width : ctx.height;
            expect(v >= 0 && v < size && Number.isInteger(v * 16 - 0.5)).toBe(true);
          } else if (k === "unitIds") {
            const ids = v as number[];
            expect(ids.length).toBeGreaterThan(0);
            ids.forEach((id, j) => expect(Number.isInteger(id) && id >= 0 && id < ID_LIMIT && (j === 0 || id > ids[j - 1]!)).toBe(true));
          } else if (k.endsWith("Id")) expect(Number.isInteger(v) && v >= 0 && v < ID_LIMIT).toBe(true);
          else if (k === "tx" || k === "ty") expect(Number.isInteger(v) && v >= 0 && v < ctx.width).toBe(true);
        }
      }
      // what was read is canonical enough to send again unchanged
      const wr = new BitWriter();
      encodeCommands(wr, cmds, ctx);
      const back = decodeCommands(new BitReader(wr.bytes(), wr.nbits), cmds.length, ctx, "red");
      back.forEach((d, j) => expect(diff(d, cmds[j]!)).toBeNull());
    }
    expect(ok).toBeGreaterThan(100);
  });

  it("has complete, explicit tables", () => {
    expect(TABLES_COMPLETE).toBe(true);
    expect(CODEC_VERSION).toBe(1);
    expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length);
    expect(COMMAND_TYPES.length).toBe(20);
    // (Classique's kinds: duels play Classique until LOBBY_PROTO 2 brings the nations, PANACHE-CONCEPTION.md §1.10)
    const classicUnits = Object.keys(UNITS).filter((k) => !UNITS[k as keyof typeof UNITS].nation);
    const classicBuildings = Object.keys(BUILDINGS).filter((k) => !BUILDINGS[k as keyof typeof BUILDINGS].nation);
    expect(new Set(UNIT_KINDS)).toEqual(new Set(classicUnits));
    expect(UNIT_KINDS.length).toBe(classicUnits.length);
    expect(new Set(BUILDING_KINDS)).toEqual(new Set(classicBuildings));
    expect(BUILDING_KINDS.length).toBe(classicBuildings.length);
    expect([...POWER_KINDS]).toEqual([...SIM_POWER_KINDS]);
    // the fields are wide enough: type 5 bits, unitKind 5, buildingKind 4, power 2
    expect(COMMAND_TYPES.length).toBeLessThanOrEqual(32);
    expect(UNIT_KINDS.length).toBeLessThanOrEqual(32);
    expect(BUILDING_KINDS.length).toBeLessThanOrEqual(16);
    expect(POWER_KINDS.length).toBeLessThanOrEqual(4);
  });
});
