/**
 * The sound duel's command codec (SOUND-DUEL.md "Command codec"): orders as
 * few bits as a 188-bit packet allows, lossless for canonical commands and
 * stateless across turns, so a lost or repeated frame can never corrupt a
 * later one.
 *
 * The sender canonicalizes before encoding: coordinates snap to the centre
 * of a 1/16-tile cell (the tile stays the same, so harvest's Math.floor is
 * unchanged), unit lists are sorted and deduplicated, the faction is the
 * local side, anything that can't be encoded or does nothing is dropped, and
 * a long unit list is split into consecutive commands of at most C_MAX bits.
 * Both phones then run decode(encode(k)) — the sender too — so the two worlds
 * see bit-identical orders whatever the controller or the AI produced.
 *
 * One command, MSB-first (no faction: the receiver stamps the peer's side):
 *
 *   type   5  index into COMMAND_TYPES
 *   then by type:
 *     move, attackMove, harvest:     units, x, y
 *     attack:                        units, id(targetId)
 *     stop, anchor, packUp:          units
 *     produce, cancelProduce:        id(buildingId), unitKind 5
 *     startBuilding:                 buildingKind 4
 *     cancelBuilding, callWave:      –
 *     placeBuilding:                 tx, ty     (ceil(log2(size)) bits each)
 *     sell:                          id(buildingId)
 *     rally:                         id(buildingId), x, y
 *     calldown:                      power 3, x, y
 *     board:                         units, id(carrierId)
 *     unload:                        units, hasPoint 1, [x, y]
 *     lift:                          units, id(goliathId)
 *     resign:                        –
 *   units = sameAsPrevious 1 (1: the list of the previous command in this turn that had one), else
 *           UE(count − 1), UE(first), then UE(gap − 1) for each further id
 *   id    = UE
 *   x, y  = the cell index k in ceil(log2(size × 16)) bits
 *
 * The tables are explicit arrays, never Object.keys order: changing one is a
 * protocol change, so it bumps CODEC_VERSION (and the duel build hash, which
 * covers this file, stops two different builds pairing).
 *
 * Where the spec is silent:
 *  - a placeBuilding tile that isn't an integer can't be encoded: dropped;
 *  - a lift longer than C_MAX is dropped: it can't be split (the sim picks the
 *    nearest two of the Condors it names), and the controller only sends pairs;
 *  - a one-unit piece can't be split either: it passes C_MAX only with ids
 *    near 2^24, and still fits an empty turn;
 *  - the decoder also rejects an id ≥ 2^24, so whatever it accepts is
 *    canonical and could be sent again unchanged.
 */
import type { BuildingKind, Command, Faction, PowerKind, UnitKind } from "../sim/types";

export const CODEC_VERSION = 2;

/** A split piece is at most this many bits, so any command fits in an empty turn. */
export const C_MAX = 96;
/** Ids (units, buildings) must be below this: UE codes them in at most 49 bits. */
export const ID_LIMIT = 1 << 24;
/** A UE code with more leading zeros than this is garbage, not a value. */
const UE_ZEROS_MAX = 24;
const UE_MAX = 2 ** (UE_ZEROS_MAX + 1) - 2;

export const COMMAND_TYPES = [
  "move", "attackMove", "attack", "harvest", "stop", "produce", "cancelProduce", "startBuilding", "cancelBuilding",
  "placeBuilding", "sell", "rally", "callWave", "calldown", "board", "unload", "anchor", "packUp", "lift", "resign"
] as const satisfies readonly Command["type"][];

export const UNIT_KINDS = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet",
  "mender", "trooper", "rocket-squad", "sniper", "condor", "goliath",
  // the nations' (LOBBY_PROTO 2, PANACHE-CONCEPTION.md §1.5): after Classique's, whose codes don't move
  "fourgon", "jamais-contente", "de-dion", "branly", "sapeurs", "zenith",
  "estafette", "mortier-280", "gyroptere", "epervier", "vulcain", "atelier", "fusiliers", "carabiniers", "titan"
] as const satisfies readonly UnitKind[];

export const BUILDING_KINDS = [
  "hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry",
  "arsonval", "flak-battery"
] as const satisfies readonly BuildingKind[];

export const POWER_KINDS = ["barrage", "emp", "droppod", "hammer", "sonde", "curie", "gaz", "pression"] as const satisfies readonly PowerKind[];

const TYPE_BITS = 5;
const UNIT_BITS = 5;
const BUILDING_BITS = 4;
const POWER_BITS = 3;

/**
 * True while every command type, unit, building and power the sim has is in
 * its table: one added to the sim and not here fails tsc on this line (add it,
 * and bump CODEC_VERSION). The nations' kinds came with LOBBY_PROTO 2
 * (PANACHE-CONCEPTION.md §1.10, WP7), after Classique's: CODEC_VERSION 2, the
 * power field 3 bits.
 */
export const TABLES_COMPLETE: [
  | Exclude<Command["type"], (typeof COMMAND_TYPES)[number]>
  | Exclude<UnitKind, (typeof UNIT_KINDS)[number]>
  | Exclude<BuildingKind, (typeof BUILDING_KINDS)[number]>
  | Exclude<PowerKind, (typeof POWER_KINDS)[number]>
] extends [never]
  ? true
  : never = true;

const indexOf = <T extends string>(table: readonly T[]) => new Map<string, number>(table.map((k, i) => [k, i]));
const TYPE_INDEX = indexOf(COMMAND_TYPES);
const UNIT_INDEX = indexOf(UNIT_KINDS);
const BUILDING_INDEX = indexOf(BUILDING_KINDS);
const POWER_INDEX = indexOf(POWER_KINDS);

/** A malformed frame or command: the whole frame is rejected. */
export class CodecError extends Error {}

// ----------------------------------------------------------------- bit I/O ---

/** UE(v) writes v + 1 in binary after floor(log2(v + 1)) zeros. */
export const ueBits = (v: number): number => 2 * (31 - Math.clz32(v + 1)) + 1;
/** SE maps 0, 1, −1, 2, −2… to 0, 1, 2, 3, 4… and writes UE. */
const seCode = (v: number): number => (v > 0 ? 2 * v - 1 : -2 * v);
export const seBits = (v: number): number => ueBits(seCode(v));
/** ceil(log2(n)): the bits that index n values. */
export const bitsFor = (n: number): number => (n <= 1 ? 0 : 32 - Math.clz32(n - 1));

/** MSB-first bit writer: bit i lands in byte i >> 3 at (7 − (i & 7)), as the modem sends it. */
export class BitWriter {
  private buf = new Uint8Array(32);
  nbits = 0;

  bit(b: number): void {
    if (this.nbits >> 3 >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    if (b) this.buf[this.nbits >> 3]! |= 0x80 >> (this.nbits & 7);
    this.nbits++;
  }

  /** The low n bits of v (n ≤ 32), most significant first. */
  bits(v: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bit((v >>> i) & 1);
  }

  ue(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > UE_MAX) throw new CodecError(`UE can't code ${v}`);
    const x = v + 1;
    const n = 32 - Math.clz32(x);
    this.bits(0, n - 1);
    this.bits(x, n);
  }

  se(v: number): void {
    if (!Number.isInteger(v)) throw new CodecError(`SE can't code ${v}`);
    this.ue(seCode(v));
  }

  /** Another writer's bits, or a stored run of them. */
  append(bits: Uint8Array, nbits: number): void {
    for (let i = 0; i < nbits; i++) this.bit((bits[i >> 3]! >> (7 - (i & 7))) & 1);
  }

  /** A copy of the bytes written (the last one zero-padded). */
  bytes(): Uint8Array {
    return this.buf.slice(0, (this.nbits + 7) >> 3);
  }
}

/** MSB-first bit reader: every read past `nbits`, and every UE with more than 24 leading zeros, throws CodecError. */
export class BitReader {
  readonly nbits: number;
  pos: number;

  constructor(private readonly buf: Uint8Array, nbits: number, pos = 0) {
    this.nbits = Math.min(nbits, buf.length * 8);
    this.pos = pos;
  }

  bit(): number {
    if (this.pos >= this.nbits) throw new CodecError("read past the end of the frame");
    const p = this.pos++;
    return (this.buf[p >> 3]! >> (7 - (p & 7))) & 1;
  }

  /** n ≤ 32 bits as an unsigned number. */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > UE_ZEROS_MAX) throw new CodecError("UE with more than 24 leading zeros");
    return 2 ** zeros + this.bits(zeros) - 1;
  }

  se(): number {
    const u = this.ue();
    // (0 − x, not −x: decoding 0 must give +0, which Object.is tells from −0)
    return u % 2 === 1 ? (u + 1) / 2 : 0 - u / 2;
  }
}

// -------------------------------------------------------------- map sizes ---

export interface MapSize {
  width: number;
  height: number;
}

/** What the sender canonicalizes against: the map, and the side this phone plays. */
export interface CanonContext extends MapSize {
  local: Faction;
}

/** The cell index of a coordinate: 1/16 tile, clamped onto the map. */
const cell = (v: number, size: number): number => Math.max(0, Math.min(size * 16 - 1, Math.floor(v * 16)));
/** The centre of cell k: floor((k + 0.5) / 16) is the tile cell k is in, so the tile never changes. */
const centre = (k: number): number => (k + 0.5) / 16;

// ----------------------------------------------------------- canonicalize ---

const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < ID_LIMIT;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * An id as the decoder will read it back, or null if it can't be sent.
 * (+ 0 turns −0, which passes isId, into the +0 the decoder returns: Object.is tells them apart.)
 */
const idOf = (v: unknown): number | null => (isId(v) ? v + 0 : null);

/** Sorted, deduplicated ids; null if any id is bad or none is left. */
function unitList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const ids: number[] = [];
  for (const raw of v) {
    const id = idOf(raw);
    if (id === null) return null;
    ids.push(id);
  }
  ids.sort((a, b) => a - b);
  const out: number[] = [];
  for (const id of ids) if (out[out.length - 1] !== id) out.push(id);
  return out.length ? out : null;
}

const point = (v: unknown, size: number): number | null => (finite(v) ? centre(cell(v, size)) : null);
/** A tile index on the map (+0, never −0), or null. */
const tile = (v: unknown, size: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < size ? v + 0 : null;

/** The canonical form of one command, or null to drop it (it can't be encoded, or does nothing). */
function canonical(c: Command, ctx: CanonContext): Command | null {
  const faction = ctx.local;
  const W = ctx.width;
  const H = ctx.height;
  switch (c.type) {
    case "move":
    case "attackMove":
    case "harvest": {
      const unitIds = unitList(c.unitIds);
      const x = point(c.x, W);
      const y = point(c.y, H);
      return unitIds && x !== null && y !== null ? { type: c.type, faction, unitIds, x, y } : null;
    }
    case "attack": {
      const unitIds = unitList(c.unitIds);
      const targetId = idOf(c.targetId);
      return unitIds && targetId !== null ? { type: c.type, faction, unitIds, targetId } : null;
    }
    case "stop":
    case "anchor":
    case "packUp": {
      const unitIds = unitList(c.unitIds);
      return unitIds ? { type: c.type, faction, unitIds } : null;
    }
    case "produce":
    case "cancelProduce": {
      const buildingId = idOf(c.buildingId);
      return buildingId !== null && UNIT_INDEX.has(c.unit) ? { type: c.type, faction, buildingId, unit: c.unit } : null;
    }
    case "startBuilding":
      return BUILDING_INDEX.has(c.building) ? { type: c.type, faction, building: c.building } : null;
    case "cancelBuilding":
    case "callWave":
    case "resign":
      return { type: c.type, faction };
    case "placeBuilding": {
      const tx = tile(c.tx, W);
      const ty = tile(c.ty, H);
      return tx !== null && ty !== null ? { type: c.type, faction, tx, ty } : null;
    }
    case "sell": {
      const buildingId = idOf(c.buildingId);
      return buildingId !== null ? { type: c.type, faction, buildingId } : null;
    }
    case "rally": {
      const buildingId = idOf(c.buildingId);
      const x = point(c.x, W);
      const y = point(c.y, H);
      return buildingId !== null && x !== null && y !== null ? { type: c.type, faction, buildingId, x, y } : null;
    }
    case "calldown": {
      const x = point(c.x, W);
      const y = point(c.y, H);
      return POWER_INDEX.has(c.power) && x !== null && y !== null ? { type: c.type, faction, power: c.power, x, y } : null;
    }
    case "board": {
      const unitIds = unitList(c.unitIds);
      const carrierId = idOf(c.carrierId);
      return unitIds && carrierId !== null ? { type: c.type, faction, unitIds, carrierId } : null;
    }
    case "unload": {
      const unitIds = unitList(c.unitIds);
      if (!unitIds) return null;
      // (the sim's own test for a drop point: transport.ts, lift.ts)
      if (!(Number.isFinite(c.x) && Number.isFinite(c.y))) return { type: c.type, faction, unitIds };
      return { type: c.type, faction, unitIds, x: centre(cell(c.x!, W)), y: centre(cell(c.y!, H)) };
    }
    case "lift": {
      const unitIds = unitList(c.unitIds);
      const goliathId = idOf(c.goliathId);
      return unitIds && goliathId !== null ? { type: c.type, faction, unitIds, goliathId } : null;
    }
    default:
      return null; // (a type that isn't in the table)
  }
}

/** Unit-list commands the sim applies unit by unit, so splitting one changes nothing. */
const SPLITTABLE = new Set<Command["type"]>(["move", "attackMove", "attack", "harvest", "stop", "anchor", "packUp", "board", "unload"]);

/**
 * Canonical commands for one issued command: none (dropped), one, or — for a
 * unit list too long for C_MAX bits — consecutive pieces of the same type and
 * parameters, in order. canonicalize is idempotent on its output.
 */
export function canonicalize(c: Command, ctx: CanonContext): Command[] {
  const k = canonical(c, ctx);
  if (!k) return [];
  if (!("unitIds" in k) || commandBits(k, ctx) <= C_MAX) return [k];
  // a lift names the Condors the sim picks the nearest two of: it can't be split, and one this long is never
  // the pair the controller sends, so it is dropped rather than left to block the queue
  if (!SPLITTABLE.has(k.type)) return [];
  const ids = k.unitIds;
  // the bits that aren't the list: the type, the sameAsPrevious flag and the parameters
  const fixed = commandBits({ ...k, unitIds: [0] }, ctx) - ueBits(0) - ueBits(0);
  const pieces: Command[] = [];
  let start = 0;
  while (start < ids.length) {
    let n = 1;
    let gaps = 0;
    // (a single unit is always a piece: past C_MAX only with ids near 2^24, and it still fits a turn)
    while (start + n < ids.length) {
      const g = ueBits(ids[start + n]! - ids[start + n - 1]! - 1);
      if (fixed + ueBits(n) + ueBits(ids[start]!) + gaps + g > C_MAX) break;
      gaps += g;
      n++;
    }
    pieces.push({ ...k, unitIds: ids.slice(start, start + n) });
    start += n;
  }
  return pieces;
}

// ---------------------------------------------------------------- encode ---

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function writeUnits(wr: BitWriter, ids: readonly number[], prev: readonly number[] | null): void {
  if (prev && sameList(ids, prev)) return wr.bit(1);
  wr.bit(0);
  if (!ids.length) throw new CodecError("an empty unit list");
  wr.ue(ids.length - 1);
  wr.ue(ids[0]!);
  for (let i = 1; i < ids.length; i++) wr.ue(ids[i]! - ids[i - 1]! - 1); // (throws unless sorted and unique)
}

function writeId(wr: BitWriter, id: number): void {
  if (!isId(id)) throw new CodecError(`bad id ${id}`);
  wr.ue(id);
}

function writePoint(wr: BitWriter, x: number, y: number, map: MapSize): void {
  if (!finite(x) || !finite(y)) throw new CodecError("a point that isn't finite");
  wr.bits(cell(x, map.width), bitsFor(map.width * 16));
  wr.bits(cell(y, map.height), bitsFor(map.height * 16));
}

function writeEnum(wr: BitWriter, index: Map<string, number>, v: string, n: number): void {
  const i = index.get(v);
  if (i === undefined) throw new CodecError(`"${v}" isn't in the table`);
  wr.bits(i, n);
}

/**
 * Write one canonical command. `prev` is the unit list of the previous command
 * in this turn that had one; returns the list the next command compares with.
 */
export function encodeCommand(wr: BitWriter, c: Command, map: MapSize, prev: readonly number[] | null): readonly number[] | null {
  writeEnum(wr, TYPE_INDEX, c.type, TYPE_BITS);
  switch (c.type) {
    case "move":
    case "attackMove":
    case "harvest":
      writeUnits(wr, c.unitIds, prev);
      writePoint(wr, c.x, c.y, map);
      return c.unitIds;
    case "attack":
      writeUnits(wr, c.unitIds, prev);
      writeId(wr, c.targetId);
      return c.unitIds;
    case "stop":
    case "anchor":
    case "packUp":
      writeUnits(wr, c.unitIds, prev);
      return c.unitIds;
    case "produce":
    case "cancelProduce":
      writeId(wr, c.buildingId);
      writeEnum(wr, UNIT_INDEX, c.unit, UNIT_BITS);
      return prev;
    case "startBuilding":
      writeEnum(wr, BUILDING_INDEX, c.building, BUILDING_BITS);
      return prev;
    case "cancelBuilding":
    case "callWave":
    case "resign":
      return prev;
    case "placeBuilding":
      if (tile(c.tx, map.width) === null || tile(c.ty, map.height) === null) throw new CodecError("a tile off the map");
      wr.bits(c.tx, bitsFor(map.width));
      wr.bits(c.ty, bitsFor(map.height));
      return prev;
    case "sell":
      writeId(wr, c.buildingId);
      return prev;
    case "rally":
      writeId(wr, c.buildingId);
      writePoint(wr, c.x, c.y, map);
      return prev;
    case "calldown":
      writeEnum(wr, POWER_INDEX, c.power, POWER_BITS);
      writePoint(wr, c.x, c.y, map);
      return prev;
    case "board":
      writeUnits(wr, c.unitIds, prev);
      writeId(wr, c.carrierId);
      return c.unitIds;
    case "unload": {
      writeUnits(wr, c.unitIds, prev);
      const has = Number.isFinite(c.x) && Number.isFinite(c.y);
      wr.bit(has ? 1 : 0);
      if (has) writePoint(wr, c.x!, c.y!, map);
      return c.unitIds;
    }
    case "lift":
      writeUnits(wr, c.unitIds, prev);
      writeId(wr, c.goliathId);
      return c.unitIds;
    default: {
      const never: never = c;
      throw new CodecError(`unknown command ${(never as Command).type}`);
    }
  }
}

/** A turn's commands, in order (sameAsPrevious runs within the turn only). */
export function encodeCommands(wr: BitWriter, cmds: readonly Command[], map: MapSize): void {
  let prev: readonly number[] | null = null;
  for (const c of cmds) prev = encodeCommand(wr, c, map, prev);
}

/** The bits a command takes after `prev` (null: the first with a unit list in its turn, the most it can take). */
export function commandBits(c: Command, map: MapSize, prev: readonly number[] | null = null): number {
  const wr = new BitWriter();
  encodeCommand(wr, c, map, prev);
  return wr.nbits;
}

/** One command on its own. */
export function encode(c: Command, map: MapSize): { bits: Uint8Array; nbits: number } {
  const wr = new BitWriter();
  encodeCommand(wr, c, map, null);
  return { bits: wr.bytes(), nbits: wr.nbits };
}

// ---------------------------------------------------------------- decode ---

function readUnits(rd: BitReader, prev: readonly number[] | null): number[] {
  if (rd.bit()) {
    if (!prev) throw new CodecError("sameAsPrevious with no previous unit list");
    return prev.slice();
  }
  const n = rd.ue() + 1;
  const ids = [readId(rd)];
  for (let i = 1; i < n; i++) {
    const id = ids[i - 1]! + rd.ue() + 1;
    if (id >= ID_LIMIT) throw new CodecError(`id ${id} is past 2^24`);
    ids.push(id);
  }
  return ids;
}

function readId(rd: BitReader): number {
  const id = rd.ue();
  // (no canonical command has one: rejecting it keeps every decoded command canonical)
  if (id >= ID_LIMIT) throw new CodecError(`id ${id} is past 2^24`);
  return id;
}

function readCoord(rd: BitReader, size: number): number {
  const k = rd.bits(bitsFor(size * 16));
  if (k >= size * 16) throw new CodecError(`cell ${k} is off a ${size}-tile map`);
  return centre(k);
}

function readTile(rd: BitReader, size: number): number {
  const t = rd.bits(bitsFor(size));
  if (t >= size) throw new CodecError(`tile ${t} is off a ${size}-tile map`);
  return t;
}

function readEnum<T extends string>(rd: BitReader, table: readonly T[], n: number): T {
  const i = rd.bits(n);
  const v = table[i];
  if (v === undefined) throw new CodecError(`index ${i} is outside its table`);
  return v;
}

/** Read one command, stamped with `faction` (the sender's side: never on the wire). */
export function decodeCommand(
  rd: BitReader,
  map: MapSize,
  faction: Faction,
  prev: readonly number[] | null
): { command: Command; units: readonly number[] | null } {
  const type = readEnum(rd, COMMAND_TYPES, TYPE_BITS);
  switch (type) {
    case "move":
    case "attackMove":
    case "harvest": {
      const unitIds = readUnits(rd, prev);
      const x = readCoord(rd, map.width);
      const y = readCoord(rd, map.height);
      return { command: { type, faction, unitIds, x, y }, units: unitIds };
    }
    case "attack": {
      const unitIds = readUnits(rd, prev);
      return { command: { type, faction, unitIds, targetId: readId(rd) }, units: unitIds };
    }
    case "stop":
    case "anchor":
    case "packUp": {
      const unitIds = readUnits(rd, prev);
      return { command: { type, faction, unitIds }, units: unitIds };
    }
    case "produce":
    case "cancelProduce": {
      const buildingId = readId(rd);
      return { command: { type, faction, buildingId, unit: readEnum(rd, UNIT_KINDS, UNIT_BITS) }, units: prev };
    }
    case "startBuilding":
      return { command: { type, faction, building: readEnum(rd, BUILDING_KINDS, BUILDING_BITS) }, units: prev };
    case "cancelBuilding":
    case "callWave":
    case "resign":
      return { command: { type, faction }, units: prev };
    case "placeBuilding": {
      const tx = readTile(rd, map.width);
      return { command: { type, faction, tx, ty: readTile(rd, map.height) }, units: prev };
    }
    case "sell":
      return { command: { type, faction, buildingId: readId(rd) }, units: prev };
    case "rally": {
      const buildingId = readId(rd);
      const x = readCoord(rd, map.width);
      return { command: { type, faction, buildingId, x, y: readCoord(rd, map.height) }, units: prev };
    }
    case "calldown": {
      const power = readEnum(rd, POWER_KINDS, POWER_BITS);
      const x = readCoord(rd, map.width);
      return { command: { type, faction, power, x, y: readCoord(rd, map.height) }, units: prev };
    }
    case "board": {
      const unitIds = readUnits(rd, prev);
      return { command: { type, faction, unitIds, carrierId: readId(rd) }, units: unitIds };
    }
    case "unload": {
      const unitIds = readUnits(rd, prev);
      if (!rd.bit()) return { command: { type, faction, unitIds }, units: unitIds };
      const x = readCoord(rd, map.width);
      return { command: { type, faction, unitIds, x, y: readCoord(rd, map.height) }, units: unitIds };
    }
    case "lift": {
      const unitIds = readUnits(rd, prev);
      return { command: { type, faction, unitIds, goliathId: readId(rd) }, units: unitIds };
    }
  }
}

/** A turn's `count` commands. */
export function decodeCommands(rd: BitReader, count: number, map: MapSize, faction: Faction): Command[] {
  const out: Command[] = [];
  let prev: readonly number[] | null = null;
  for (let i = 0; i < count; i++) {
    const d = decodeCommand(rd, map, faction, prev);
    out.push(d.command);
    prev = d.units;
  }
  return out;
}

/** One command on its own, as encode wrote it. */
export function decode(bits: Uint8Array, nbits: number, map: MapSize, faction: Faction): Command {
  return decodeCommand(new BitReader(bits, nbits), map, faction, null).command;
}
