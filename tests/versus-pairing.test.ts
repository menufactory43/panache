import { describe, expect, it } from "vitest";
import { PacketAir, type PacketAirOptions } from "../src/link/packet-air";
import { RoomLink } from "../src/link/room-transport";
import type { RoomSide } from "../src/link/sim/room";
import type { BandPlan, BandRole, LinkPacket, LinkTransport } from "../src/link/transport";
import { worldHash } from "../src/sim/checksum";
import { BIOMES, randomMapId } from "../src/sim/mapgen";
import { MAPS, mapBansMutator, mapById } from "../src/sim/maps";
import { OPENER_IDS, openerBlocked, type OpenerId } from "../src/sim/openers";
import { hash32 } from "../src/sim/rand";
import { MUTATOR_IDS, type MutatorId } from "../src/sim/rules";
import { setupWorld } from "../src/sim/setup";
import type { Faction } from "../src/sim/types";
import { BitWriter, CodecError } from "../src/versus/codec";
import { rxqOf } from "../src/versus/lockstep";
import {
  FAILED_MESSAGE, LOBBY_FRAME_MAX, LOBBY_PROTO, NOTHING_HEARD_MESSAGE, NOTHING_HEARD_MS, PICK_TIMEOUT_MS, Pairing,
  VERSION_MESSAGE, confHash, delayFor, matchSeed, packetMs, readLobbyFrame, readLobbyHeader, writeLobbyFrame,
  type DuelConfig, type HostOffer, type LobbyFrame, type PairingPhase, type PairingResult, type PairingState
} from "../src/versus/pairing";

/** The driver's step: how often the "session" looks at the link (ms of air time). */
const STEP = 10;
const BUILD = 0x5eed;
/** A game frame, as far as PacketAir and the pairing can tell (type 01). */
const GAME = new Uint8Array([0x40, 0, 0]);

const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0x7a11, i++) / 4294967296;
};

// ------------------------------------------------------------ the driver ---

interface PhoneSpec {
  role: BandRole;
  plan?: BandPlan;
  host?: HostOffer;
  build?: number;
  proto?: number;
  /** The nonce draw's seed. */
  seed: number;
  /** The opener this phone taps once the cards have been up `pickAfterMs` (null: never tap, the timeout picks). Default: the last one offered. */
  pick?: ((s: PairingState) => OpenerId) | null;
  pickAfterMs?: number;
  /** After the pairing starts, the match loads for this long before the first game frame replaces the GO frame. */
  loadMs?: number;
  /** What this phone hears passes through here first: duplicates, stale frames, recordings, forgeries. */
  hear?: (pks: LinkPacket[], ph: Phone) => LinkPacket[];
  /** What this phone sends passes through here (null: nothing goes out). */
  say?: (f: { bits: Uint8Array; nbits: number }, ph: Phone) => { bits: Uint8Array; nbits: number } | null;
}

interface Phone {
  spec: PhoneSpec;
  pairing: Pairing;
  link: LinkTransport;
  /** Every lobby frame this phone sent, and every packet it heard (as delivered), for replays. */
  said: { bits: Uint8Array; nbits: number; at: number }[];
  heard: LinkPacket[];
  maxBits: number;
  keyedFor: string | null;
  cardsAt: number | null;
  startedAt: number | null;
  gameOut: boolean;
  phases: Set<PairingPhase>;
}

function phone(link: LinkTransport, spec: PhoneSpec): Phone {
  const pairing = new Pairing({
    role: spec.role,
    build: spec.build ?? BUILD,
    ...(spec.proto !== undefined ? { proto: spec.proto } : {}),
    ...(spec.plan ? { plan: spec.plan } : {}),
    ...(spec.host ? { host: spec.host } : {}),
    now: () => link.now(),
    random: rng(spec.seed)
  });
  const ph: Phone = {
    spec, pairing, link, said: [], heard: [], maxBits: 0, keyedFor: null, cardsAt: null, startedAt: null, gameOut: false, phases: new Set()
  };
  send(ph); // (so the first packet carries a frame)
  return ph;
}

/** Build this phone's next frame and hand it to the link (or, once loaded, a game frame). */
function send(ph: Phone): void {
  const now = ph.link.now();
  if (ph.startedAt !== null && now >= ph.startedAt + (ph.spec.loadMs ?? 0)) {
    ph.gameOut = true;
    ph.link.send([{ bits: GAME, nbits: 24, key: 0 }]);
    return;
  }
  let f: { bits: Uint8Array; nbits: number } | null = ph.pairing.frame();
  ph.maxBits = Math.max(ph.maxBits, f.nbits);
  expect(() => readLobbyFrame(f!.bits, f!.nbits)).not.toThrow();
  if (ph.spec.say) f = ph.spec.say(f, ph);
  if (!f) return;
  ph.said.push({ ...f, at: now });
  ph.link.send([{ bits: f.bits, nbits: f.nbits, key: 0 }]);
}

/** The retry tap (or any lobby restart): reset, and hand the link a frame at once, as the session does (the frame on the link is the old pairing's, maybe its GO). */
function retry(ph: Phone): void {
  ph.pairing.reset();
  send(ph);
}

/** What the session does each time it looks: slots, then packets, then the lobby's taps. */
function drive(ph: Phone): void {
  const p = ph.pairing;
  for (const at of ph.link.slots()) {
    p.slot(at);
    send(ph);
  }
  let pks = ph.link.poll();
  ph.heard.push(...pks);
  if (ph.spec.hear) pks = ph.spec.hear(pks, ph);
  for (const pk of pks) {
    p.receive(pk);
    p.setRxq(rxqOf(pk.snrDb));
  }
  const s = p.state();
  ph.phases.add(s.phase);
  const now = ph.link.now();
  if (s.go && s.nonces) {
    const key = `${s.nonces.host}:${s.nonces.guest}`;
    if (ph.keyedFor !== key) ph.link.setSessionKey(s.nonces.host, s.nonces.guest);
    ph.keyedFor = key;
  }
  if (s.phase === "picking") {
    ph.cardsAt ??= now;
    const choose = ph.spec.pick === undefined ? (st: PairingState) => st.offered[st.offered.length - 1]! : ph.spec.pick;
    if (choose && now - ph.cardsAt >= (ph.spec.pickAfterMs ?? 300)) expect(p.pick(choose(s))).toBe(true);
  } else if (s.phase !== "waiting") ph.cardsAt = null;
  if (p.result() && ph.startedAt === null) ph.startedAt = now;
}

/** Two phones on one link, and a way to run it. */
interface Pair {
  host: Phone;
  guest: Phone;
  /** Run until `until` holds, or `limitMs` of air time; `every` runs before each look. */
  run(until: () => boolean, limitMs: number, every?: () => void): void;
}

interface Duel extends Pair {
  air: PacketAir;
}

function duel(o: { air?: PacketAirOptions; offer?: HostOffer; seed?: number; host?: Partial<PhoneSpec>; guest?: Partial<PhoneSpec> } = {}): Duel {
  const seed = o.seed ?? 1;
  const air = new PacketAir({ seed, clockOffsetMs: [0, 31_337], ...o.air });
  const host = phone(air.a, { role: "host", host: o.offer ?? { map: "riverlands", mutators: [] }, seed: seed * 2 + 1, ...o.host });
  const guest = phone(air.b, { role: "guest", seed: seed * 2 + 2, ...o.guest });
  const d: Duel = {
    air, host, guest,
    run(until, limitMs, every) {
      const end = air.now() + limitMs;
      while (!until() && air.now() < end) {
        air.advance(STEP);
        every?.();
        // (through d: a test may put a fresh phone on a link end, as a page reload does)
        drive(d.host);
        drive(d.guest);
      }
    }
  };
  return d;
}

/** Hand a phone one packet as if it had just arrived. */
function inject(ph: Phone, f: { bits: Uint8Array; nbits: number }): void {
  ph.pairing.receive({ bits: f.bits, nbits: f.nbits, snrDb: 30, at: ph.link.now(), session: false });
}

/** The newest frame a phone handed its link, decoded. */
function lastSaid(ph: Phone): LobbyFrame {
  const s = ph.said[ph.said.length - 1]!;
  return readLobbyFrame(s.bits, s.nbits);
}

const isGo = (f: { bits: Uint8Array; nbits: number }): boolean => readLobbyFrame(f.bits, f.nbits).go;

const started = (d: Pair) => () => d.host.pairing.result() !== null && d.guest.pairing.result() !== null;

/** Pair two phones to the end: both started, within `limitMs` of air time. */
function pairUp(d: Pair, limitMs = 30_000): [PairingResult, PairingResult] {
  d.run(started(d), limitMs);
  const h = d.host.pairing.result();
  const g = d.guest.pairing.result();
  expect(h, `the host didn't start (${d.host.pairing.state().phase})`).not.toBeNull();
  expect(g, `the guest didn't start (${d.guest.pairing.state().phase})`).not.toBeNull();
  return [h!, g!];
}

const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

/** Both phones hold the same match, made of the host's offer, the two picks and both nonces. */
function expectAgreed(d: Pair, h: PairingResult, g: PairingResult, offer: HostOffer): void {
  expect(h.role).toBe("host");
  expect(g.role).toBe("guest");
  expect(g.setup).toEqual(h.setup);
  expect(g.config).toEqual(h.config);
  expect([g.delay, g.fast, g.hostNonce, g.guestNonce, g.plan, g.mapId]).toEqual([h.delay, h.fast, h.hostNonce, h.guestNonce, h.plan, h.mapId]);
  expect(h.mapId).toBe(offer.map);
  expect(h.setup.map).toBe(offer.map);
  // (in MUTATOR_IDS order, without what the map bans)
  expect(h.setup.mutators).toEqual(MUTATOR_IDS.filter((m) => offer.mutators.includes(m) && !mapBansMutator(mapById(offer.map), m)));
  expect(h.local).toBe(offer.hostSide ?? "blue");
  expect(g.local).toBe(other(h.local));
  expect(h.hostNonce).toBe(d.host.pairing.state().nonce);
  expect(h.guestNonce).toBe(d.guest.pairing.state().nonce);
  expect(h.setup.seed).toBe(hash32(h.hostNonce, h.guestNonce, 1));
  // each side's opener is the one that phone picked, and the rules allow it
  const probe = setupWorld({ ...h.setup, openers: {} });
  for (const [ph, r] of [[d.host, h], [d.guest, g]] as const) {
    const s = ph.pairing.state();
    expect(s.picked).toBe(true);
    expect(h.setup.openers[r.local] ?? null).toBe(s.pick);
    if (s.pick) expect(openerBlocked(probe, r.local, s.pick)).toBeNull();
    else expect(OPENER_IDS.every((id) => openerBlocked(probe, r.local, id))).toBe(true);
  }
  expect(worldHash(setupWorld(g.setup))).toBe(worldHash(setupWorld(h.setup)));
  for (const ph of [d.host, d.guest]) expect(ph.maxBits).toBeLessThanOrEqual(LOBBY_FRAME_MAX);
}

// ------------------------------------------------------------ the frame ---

/** A random frame of any shape the writer accepts. */
function randomFrame(r: () => number): LobbyFrame {
  const int = (n: number) => Math.floor(r() * n);
  const role: BandRole = r() < 0.5 ? "host" : "guest";
  const opener = () => (r() < 0.25 ? null : OPENER_IDS[int(OPENER_IDS.length)]!);
  let config: DuelConfig | null = null;
  if (role === "host" && r() < 0.7) {
    const mapId = r() < 0.5 ? MAPS[int(MAPS.length)]!.id : randomMapId(BIOMES[int(BIOMES.length)]!, r() < 0.2 ? 0xffffffff : int(2 ** 32));
    config = { mapId, mutators: MUTATOR_IDS.filter(() => r() < 0.3), delay: 3 + int(6), hostSide: r() < 0.5 ? "blue" : "red", fast: r() < 0.5 };
  }
  const picked = r() < 0.6;
  const go = picked && r() < 0.5;
  return {
    role, proto: int(16), build: int(65536), nonce: int(65536), heard: int(65536), rxq: int(8), ping: int(256), echo: int(256),
    hold: int(128), config, confHash: int(65536), pick: picked ? opener() : null, picked, go, theirs: go ? opener() : null
  };
}

/** The bits of a frame with one field's code replaced (fields before `at` copied, `code` written, the rest copied). */
function patch(f: { bits: Uint8Array; nbits: number }, at: number, width: number, code: number): { bits: Uint8Array; nbits: number } {
  const wr = new BitWriter();
  const bit = (i: number) => (f.bits[i >> 3]! >> (7 - (i & 7))) & 1;
  for (let i = 0; i < at; i++) wr.bit(bit(i));
  wr.bits(code, width);
  for (let i = at + width; i < f.nbits; i++) wr.bit(bit(i));
  return { bits: wr.bytes(), nbits: wr.nbits };
}

describe("the lobby frame", () => {
  it("round-trips every field, within 157 bits", () => {
    const r = rng(99);
    let longest = 0;
    for (let i = 0; i < 5000; i++) {
      const f = randomFrame(r);
      const w = writeLobbyFrame(f);
      expect(w.nbits).toBeLessThanOrEqual(LOBBY_FRAME_MAX);
      longest = Math.max(longest, w.nbits);
      expect(readLobbyFrame(w.bits, w.nbits)).toEqual(f);
      expect(readLobbyHeader(w.bits, w.nbits)).toEqual({ role: f.role, proto: f.proto, build: f.build });
      // as the modem delivers it: padded with zeros to the packet
      const padded = new Uint8Array(24);
      padded.set(w.bits);
      expect(readLobbyFrame(padded, 188)).toEqual(f);
    }
    expect(longest).toBe(LOBBY_FRAME_MAX); // (a random map, and GO)
  });

  it("rejects malformed frames", () => {
    const base: LobbyFrame = {
      role: "host", proto: 1, build: 7, nonce: 5, heard: 6, rxq: 3, ping: 1, echo: 2, hold: 3,
      config: { mapId: "riverlands", mutators: [], delay: 4, hostSide: "blue", fast: false },
      confHash: 9, pick: "blitz", picked: true, go: true, theirs: "airwing"
    };
    const ok = writeLobbyFrame(base);
    const bad = (f: { bits: Uint8Array; nbits: number }) => expect(() => readLobbyFrame(f.bits, f.nbits)).toThrow(CodecError);
    // the type: 00, 01 and 11 aren't lobby frames
    for (const t of [0, 1, 3]) bad(patch(ok, 0, 2, t));
    // reads past nbits, at every length short of the frame
    for (let n = 0; n < ok.nbits; n++) bad({ bits: ok.bits, nbits: n });
    // map codes 6, 7 and 13–15 name no map
    const MAP_AT = 2 + 1 + 4 + 16 + 16 + 16 + 3 + 8 + 8 + 7 + 1;
    for (const code of [6, 7, 13, 14, 15]) bad(patch(ok, MAP_AT, 4, code));
    for (const code of [0, 5]) expect(readLobbyFrame(patch(ok, MAP_AT, 4, code).bits, ok.nbits).config!.mapId).toBe(MAPS[code]!.id);
    // delay codes 6 and 7 are D = 9 and 10
    const DELAY_AT = MAP_AT + 4 + 12;
    for (const code of [6, 7]) bad(patch(ok, DELAY_AT, 3, code));
    expect(readLobbyFrame(patch(ok, DELAY_AT, 3, 5).bits, ok.nbits).config!.delay).toBe(8);
    // a guest with a config, and GO without a pick
    bad(patch(ok, 2, 1, 1));
    const PICKED_AT = DELAY_AT + 3 + 1 + 1 + 16 + 2;
    bad(patch(ok, PICKED_AT, 1, 0)); // (go still set)
    // and the writer refuses what no frame can say
    expect(() => writeLobbyFrame({ ...base, config: { ...base.config!, mapId: "nowhere" } })).toThrow(RangeError);
    expect(() => writeLobbyFrame({ ...base, config: { ...base.config!, delay: 9 } })).toThrow(RangeError);
    expect(() => writeLobbyFrame({ ...base, role: "guest" })).toThrow(RangeError);
    expect(() => writeLobbyFrame({ ...base, hold: 128 })).toThrow(RangeError);
  });

  it("has room for every map and mutator, and its rules are the spec's", () => {
    // (a ninth built-in map, a ninth biome or a thirteenth mutator needs a wider field, and a new LOBBY_PROTO)
    expect(MAPS.length).toBeLessThanOrEqual(8);
    expect(BIOMES.length).toBeLessThanOrEqual(8);
    expect(MUTATOR_IDS.length).toBeLessThanOrEqual(12);
    for (const m of MAPS) expect(() => writeLobbyFrame({ ...randomFrame(rng(1)), role: "host", config: { mapId: m.id, mutators: [...MUTATOR_IDS], delay: 3, hostSide: "blue", fast: true } })).not.toThrow();
    // D = clamp(ceil((rtt / 2 + P + 50 ms) / 100 ms), 3, 8), P the starting mode's packet period on the plan
    expect([packetMs("high", "fast"), packetMs("high", "robust"), packetMs("low", "fast"), packetMs("low", "robust")]).toEqual([100, 200, 200, 400]);
    expect([0, 300, 301, 500, 501, 1100, 1101, 9999].map((rtt) => delayFor(rtt, 100))).toEqual([3, 3, 4, 4, 5, 7, 8, 8]);
    expect([0, 100, 101, 500, 501, 900, 901].map((rtt) => delayFor(rtt, 200))).toEqual([3, 3, 4, 5, 6, 7, 8]);
    expect([0, 100, 101, 9999].map((rtt) => delayFor(rtt, 400))).toEqual([5, 5, 6, 8]);
    expect(matchSeed(1, 2)).toBe(hash32(1, 2, 1));
    const c: DuelConfig = { mapId: "riverlands", mutators: [], delay: 4, hostSide: "blue", fast: false };
    const h = confHash(c, "high", 10, 20);
    expect(h).toBeGreaterThan(0);
    for (const changed of [confHash({ ...c, delay: 5 }, "high", 10, 20), confHash({ ...c, fast: true }, "high", 10, 20), confHash({ ...c, hostSide: "red" }, "high", 10, 20),
      confHash({ ...c, mutators: ["veterans"] }, "high", 10, 20), confHash({ ...c, mapId: "frostbite" }, "high", 10, 20), confHash(c, "low", 10, 20), confHash(c, "high", 11, 20), confHash(c, "high", 10, 21)])
      expect(changed).not.toBe(h);
  });
});

// ------------------------------------------------------------- pairing ---

describe("two phones pairing over PacketAir", () => {
  const cases: { offer: HostOffer; note: string }[] = [
    { note: "a built-in map", offer: { map: "riverlands", mutators: [] } },
    { note: "a random map, red host", offer: { map: randomMapId("volcanic", 3141592653), mutators: ["veterans", "clearskies"], hostSide: "red" } },
    { note: "mutators that block openers", offer: { map: "dune-sea", mutators: ["airwar", "goldrush"], hostSide: "blue" } },
    { note: "a mutator the map bans", offer: { map: "archipelago", mutators: ["airwar", "goldrush"], hostSide: "blue" } },
    { note: "no opener allowed", offer: { map: randomMapId("arctic", 77), mutators: ["armada"], hostSide: "red" } },
    { note: "the first map, mutators out of order", offer: { map: "proving-grounds", mutators: ["robotlove", "blitz"], hostSide: "red" } }
  ];
  for (const [i, { offer, note }] of cases.entries())
    it(`agree on config, seed, D and openers: ${note}`, { timeout: 60_000 }, () => {
      // (packet starts on 10 ms boundaries: the round trip comes out exact)
      const d = duel({ offer, seed: 10 + i, air: { phaseMs: [30, 170] }, host: { pickAfterMs: 500 }, guest: { pick: (s) => s.offered[0]!, pickAfterMs: 1200 } });
      const [h, g] = pairUp(d);
      expectAgreed(d, h, g, offer);
      expect(h.delay).toBe(delayFor(500, packetMs("high", "fast")));
      expect(d.host.pairing.state().rtt.median).toBe(500);
      expect(h.fast).toBe(true); // (30 dB both ways)
      if (offer.mutators.includes("armada")) expect(h.setup.openers).toEqual({});
      // the phones went through the lobby's steps in order, and never failed
      for (const ph of [d.host, d.guest]) {
        const order: PairingPhase[] = ["listening", "linking", "picking", "waiting", "go", "started"];
        expect([...ph.phases]).toEqual(order.filter((p) => ph.phases.has(p)));
        expect(ph.phases.has("failed") || ph.phases.has("error")).toBe(false);
      }
      if (!offer.mutators.includes("armada")) for (const ph of [d.host, d.guest]) expect(ph.phases.has("picking")).toBe(true);
    });

  it("tracks the round trip: D from the median rtt at 0–2000 ms latency", { timeout: 120_000 }, () => {
    for (const [i, latencyMs] of [0, 100, 250, 500, 800, 2000].entries()) {
      // exact on 10 ms boundaries; within the 10 ms quantization at any phase, whatever the phones' clocks read
      for (const phaseMs of [[0, 120], undefined] as const) {
        const d = duel({ seed: 40 + i, air: { latencyMs, ...(phaseMs ? { phaseMs: [...phaseMs] as [number, number] } : {}), clockOffsetMs: [123_457, 9_876] } });
        const [h] = pairUp(d, 60_000);
        const rtt = d.host.pairing.state().rtt;
        expect(rtt.samples.length).toBe(5);
        // (30 dB both ways: the match starts fast, whose packet period D allows for)
        expect(h.fast).toBe(true);
        const P = packetMs("high", "fast");
        if (phaseMs) {
          expect(rtt.median).toBe(2 * latencyMs);
          expect(h.delay).toBe(delayFor(2 * latencyMs, P));
        } else {
          expect(Math.abs(rtt.median! - 2 * latencyMs)).toBeLessThanOrEqual(5);
          expect([delayFor(2 * latencyMs - 5, P), delayFor(2 * latencyMs + 5, P)]).toContain(h.delay);
        }
        // the guest measures the same round trip
        const gm = d.guest.pairing.state().rtt.median!;
        expect(Math.abs(gm - 2 * latencyMs)).toBeLessThanOrEqual(5);
      }
    }
    expect([100, 250, 500].map((l) => delayFor(2 * l, packetMs("high", "fast")))).toEqual([3, 4, 7]);
    // and a robust start allows for its packets, twice as long
    expect([100, 250, 500].map((l) => delayFor(2 * l, packetMs("high", "robust")))).toEqual([4, 5, 8]);
  });

  it("starts fast only when both phones' last 10 frames heard well (12 dB), with D for the starting mode's packets", { timeout: 60_000 }, () => {
    // (at 250 ms each way: D = 4 with fast's 100 ms packets to wait for, 5 with robust's 200)
    for (const [snrDb, fast, D] of [[30, true, 4], [12, true, 4], [11.9, false, 5], [6, false, 5]] as const) {
      const d = duel({ seed: 60, air: { snrDb } });
      const [h, g] = pairUp(d);
      expect([h.fast, g.fast], `${snrDb} dB`).toEqual([fast, fast]);
      expect([h.delay, g.delay], `${snrDb} dB`).toEqual([D, D]);
    }
    // one way is enough to keep it robust
    for (const way of ["ab", "ba"] as const) {
      const d = duel({ seed: 61, air: { snrDb: 30 } });
      d.air.setSnr(11.9, way);
      const [h] = pairUp(d);
      expect(h.fast, way).toBe(false);
    }
    // a phone that hears its friend last counts only frames built since: the one on the air as it first heard was
    // built before, saying rxq 0, and would make the host's first offer robust (which the guest echoes at once, and the
    // host freezes on). Robust packets (the lobby's), so its ten frames fill before the round trips' wait has passed
    for (const [way, seed] of [["ba", 62], ["ab", 63]] as const) {
      const d = duel({ seed, air: { snrDb: 30, latencyMs: 250 } });
      d.air.outage(3000, way);
      const [h, g] = pairUp(d);
      expect([h.fast, g.fast], way).toEqual([true, true]);
    }
  });

  it("waits out a receiver's warm-up: fast at once, robust only once the windows have said so for 8 more frames", { timeout: 60_000 }, () => {
    // a receiver's first packets after lock read low while its clock tracker converges (the modem at ±300 ppm): here
    // one way's first 6 packets read 6 dB, then 30. Without the wait, the host's offer as its windows filled held them
    // (its own frames, or the guest's): robust, which the guest echoed and the host froze on
    const warmUp = (pks: LinkPacket[], ph: Phone): LinkPacket[] =>
      pks.map((p, i) => (ph.heard.length - pks.length + i < 6 ? { ...p, snrDb: 6 } : p));
    for (const way of ["host", "guest"] as const) {
      const d = duel({ seed: 64, air: { phaseMs: [30, 170] }, [way]: { hear: warmUp } });
      const [h, g] = pairUp(d);
      expect([h.fast, g.fast], `${way} warming up`).toEqual([true, true]);
      expect(h.delay).toBe(delayFor(d.host.pairing.state().rtt.median!, packetMs("high", "fast")));
    }
    // a link that stays poor starts robust, its offer 8 frames (1.6 s of robust packets) after a fast one would have gone
    const firstOffer = (snrDb: number) => {
      const d = duel({ seed: 65, air: { snrDb, phaseMs: [30, 170] } });
      const [h] = pairUp(d);
      return { fast: h.fast, at: d.host.said.find((f) => readLobbyFrame(f.bits, f.nbits).config)!.at };
    };
    const [good, poor] = [firstOffer(30), firstOffer(6)];
    expect([good.fast, poor.fast]).toEqual([true, false]);
    expect(poor.at - good.at).toBe(8 * 200);
  });

  for (const loss of [0.1, 0.3])
    it(`pairs at ${loss * 100}% loss, and through bursts`, { timeout: 60_000 }, () => {
      for (const seed of [1, 2, 3]) {
        const offer: HostOffer = { map: randomMapId("desert", seed * 1000), mutators: ["rapidfab"], hostSide: seed % 2 ? "blue" : "red" };
        const d = duel({ seed: 70 + seed, offer, air: { loss, latencyMs: 250 } });
        const [h, g] = pairUp(d, 60_000);
        expectAgreed(d, h, g, offer);
        expect([4, 5]).toContain(h.delay);
      }
      const offer: HostOffer = { map: "frostbite", mutators: [] };
      const d = duel({ seed: 80, offer, air: { burst: { pGoodToBad: 0.05, pBadToGood: 0.3 } } });
      const [h, g] = pairUp(d, 60_000);
      expectAgreed(d, h, g, offer);
    });

  it("picks for a player who doesn't, after 20 s: the first opener the rules allow", { timeout: 60_000 }, () => {
    for (const [mutators, want] of [[[], "blitz"], [["airwar"], "airwing"]] as const) {
      const offer: HostOffer = { map: "dune-sea", mutators: [...mutators] };
      const d = duel({ seed: 90, offer, host: { pick: null }, guest: { pick: null } });
      let cardsAt: number | null = null;
      let left = Infinity;
      d.run(started(d), 40_000, () => {
        const s = d.guest.pairing.state();
        if (s.phase === "picking") {
          cardsAt ??= d.air.now();
          // the countdown runs down from 20 s
          expect(s.pickLeftMs).not.toBeNull();
          expect(s.pickLeftMs!).toBeLessThanOrEqual(left);
          left = s.pickLeftMs!;
        }
      });
      const [h, g] = pairUp(d, 1);
      expectAgreed(d, h, g, offer);
      expect(h.setup.openers).toEqual({ blue: want, red: want });
      expect(d.air.now() - cardsAt!).toBeGreaterThanOrEqual(PICK_TIMEOUT_MS);
      expect(d.air.now() - cardsAt!).toBeLessThan(PICK_TIMEOUT_MS + 3000);
    }
  });

  it("refuses a different build or protocol, with the right message on both phones", { timeout: 60_000 }, () => {
    const cases = [
      { host: { build: 0xbeef }, guest: { build: 0xbeee }, older: [null, null] },
      { host: { proto: LOBBY_PROTO }, guest: { proto: LOBBY_PROTO + 1 }, older: ["this", "friend"] },
      { host: { proto: LOBBY_PROTO + 2, build: 1 }, guest: { proto: LOBBY_PROTO, build: 2 }, older: ["friend", "this"] }
    ] as const;
    for (const c of cases) {
      const d = duel({ seed: 100, host: c.host, guest: c.guest });
      d.run(() => false, 8000);
      for (const [ph, older] of [[d.host, c.older[0]], [d.guest, c.older[1]]] as const) {
        const s = ph.pairing.state();
        expect(s.phase).toBe("error");
        expect(s.error).toMatchObject({ kind: "version", older });
        const which = older === "this" ? " (celle de ce téléphone est plus ancienne)" : older === "friend" ? " (celle de ton ami est plus ancienne)" : "";
        expect(s.error!.message).toBe(VERSION_MESSAGE + which);
        expect(s.peer).toMatchObject({ role: ph === d.host ? "guest" : "host" });
        expect(ph.pairing.result()).toBeNull();
        expect(ph.phases.has("picking")).toBe(false);
      }
    }
  });

  it("is unharmed by duplicate, stale and out-of-order lobby frames", { timeout: 60_000 }, () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = rng(500 + seed);
      /**
       * Each phone: every packet delivered 1–3 times; one in three held back up to 150 ms (so the next can overtake
       * it, keeping its own arrival time); and about six times a second one from 0.3–2.5 s ago, replayed now. (One
       * replayed within 150 ms of 2.56 s looks on time, as the ping wraps then: the median round trip absorbs it.)
       */
      const mess = (): PhoneSpec["hear"] => {
        const held: { pk: LinkPacket; until: number }[] = [];
        return (pks, ph) => {
          const now = ph.link.now();
          const out: LinkPacket[] = [];
          for (const pk of pks) {
            if (r() < 0.33) held.push({ pk, until: now + r() * 150 });
            else out.push(pk);
          }
          for (let i = held.length - 1; i >= 0; i--) if (held[i]!.until <= now) out.push(held.splice(i, 1)[0]!.pk);
          const old = ph.heard.filter((p) => p.at < now - 300 && p.at > now - 2500);
          if (old.length && r() < 0.06) out.push({ ...old[Math.floor(r() * old.length)]!, at: now });
          return out.flatMap((p) => Array.from({ length: 1 + Math.floor(r() * 3) }, () => p));
        };
      };
      const offer: HostOffer = { map: "ashlands", mutators: ["glass"], hostSide: seed % 2 ? "red" : "blue" };
      const d = duel({ seed: 110 + seed, offer, air: { phaseMs: [20, 90] }, host: { hear: mess() }, guest: { hear: mess() } });
      const [h, g] = pairUp(d, 60_000);
      expectAgreed(d, h, g, offer);
      // nothing reset or failed, and the round trip is the one without the mess
      for (const ph of [d.host, d.guest]) {
        expect(ph.pairing.state().restarts).toBe(0);
        expect(ph.phases.has("failed")).toBe(false);
      }
      expect(d.host.pairing.state().rtt.median).toBe(500);
      expect(h.delay).toBe(4);
    }
  });

  it("tells the lobby what to show", { timeout: 60_000 }, () => {
    const offer: HostOffer = { map: "dune-sea", mutators: ["airwar"], hostSide: "red" };
    const d = duel({ seed: 600, offer, air: { phaseMs: [0, 50] }, host: { pick: null }, guest: { pick: null } });
    expect(d.guest.pairing.state()).toMatchObject({
      phase: "listening", role: "guest", heard: false, sinceHeardMs: Infinity, peer: null, rtt: { median: null, samples: [] }, peerRxq: null,
      config: null, side: null, offered: [], pick: null, picked: false, peerPicked: false, pickLeftMs: null, go: false, peerGo: false,
      nonces: null, error: null, hint: null, restarts: 0
    });
    d.run(() => d.guest.pairing.state().phase === "picking" && d.host.pairing.state().phase === "picking", 10_000);
    const nonces = { host: d.host.pairing.state().nonce, guest: d.guest.pairing.state().nonce };
    const probe = setupWorld({ map: offer.map, seed: matchSeed(nonces.host, nonces.guest), mutators: [...offer.mutators], openers: {} });
    for (const [ph, peer, side] of [[d.host, d.guest, "red"], [d.guest, d.host, "blue"]] as const) {
      const s = ph.pairing.state();
      expect(s.heard).toBe(true);
      expect(s.sinceHeardMs).toBeLessThan(400);
      expect(s.peer).toEqual({ role: peer.spec.role, build: BUILD, proto: LOBBY_PROTO, nonce: peer.pairing.state().nonce, hearsMe: true });
      expect(s.rtt.samples.length).toBeGreaterThanOrEqual(3);
      expect(s.rtt.median).toBe(500);
      expect([s.rxq, s.peerRxq]).toEqual([7, 7]);
      expect(s.config).toEqual({ mapId: offer.map, mutators: ["airwar"], delay: 4, hostSide: "red", fast: true });
      expect(s.side).toBe(side);
      // Air War leaves the Air Wing only
      expect(s.offered).toEqual(OPENER_IDS.filter((id) => !openerBlocked(probe, side, id)));
      expect(s.offered).toEqual(["airwing"]);
      expect(s.pickLeftMs).toBeGreaterThan(PICK_TIMEOUT_MS - 2000);
      expect(s.pickLeftMs).toBeLessThanOrEqual(PICK_TIMEOUT_MS);
      expect(s.nonces).toEqual(nonces);
      expect([s.picked, s.peerPicked, s.go]).toEqual([false, false, false]);
    }
    // a blocked opener can't be picked; the friend sees that this phone picked, not what
    expect(d.guest.pairing.pick("blitz")).toBe(false);
    expect(d.guest.pairing.pick("airwing")).toBe(true);
    expect(d.guest.pairing.pick("airwing")).toBe(false);
    expect(d.guest.pairing.state()).toMatchObject({ phase: "waiting", pick: "airwing", picked: true, pickLeftMs: null });
    d.run(() => d.host.pairing.state().peerPicked, 2000);
    expect(d.host.pairing.state()).toMatchObject({ phase: "picking", peerPicked: true, go: false });
    expect(Object.keys(d.host.pairing.state()).filter((k) => /peer.*pick/i.test(k))).toEqual(["peerPicked"]);
    expect(d.host.pairing.pick("airwing")).toBe(true);
    const [h, g] = pairUp(d);
    expectAgreed(d, h, g, offer);
    expect(Object.keys(h.setup.openers)).toEqual(["blue", "red"]); // (blue's first on both phones)
  });

  it("agrees only on the band plan both phones run", { timeout: 60_000 }, () => {
    // the host runs the low plan; until the guest says it locked that plan, its hash is the high plan's
    const d = duel({ seed: 700, host: { plan: "low" } });
    d.run(() => false, 6000);
    for (const ph of [d.host, d.guest]) expect(ph.pairing.state()).toMatchObject({ phase: "linking", config: null });
    d.guest.pairing.setPlan("low");
    const [h, g] = pairUp(d);
    expectAgreed(d, h, g, { map: "riverlands", mutators: [] });
    expect([h.plan, g.plan]).toEqual(["low", "low"]);
  });

  it("tells both phones on Host (or both on Join) after 8 s of nothing heard", { timeout: 60_000 }, () => {
    for (const role of ["host", "guest"] as const) {
      const air = new PacketAir({ seed: 7 });
      const offer = role === "host" ? { host: { map: "riverlands", mutators: [] as MutatorId[] } } : {};
      // (a frame-level link hears both: the pairing ignores a frame of its own role, as the air would never carry it)
      const a = phone(air.a, { role, seed: 1, ...offer });
      const b = phone(air.b, { role, seed: 2, ...offer });
      for (let t = 0; t < 12_000; t += STEP) {
        air.advance(STEP);
        drive(a);
        drive(b);
        for (const ph of [a, b]) {
          const s = ph.pairing.state();
          expect(s.phase).toBe("listening");
          expect(s.heard).toBe(false);
          expect(s.hint).toEqual(air.now() >= NOTHING_HEARD_MS ? { kind: "switch-role", message: NOTHING_HEARD_MESSAGE } : null);
        }
      }
      // the one-tap switch: one phone becomes the other role, and they pair
      const air2 = new PacketAir({ seed: 8 });
      const h = phone(air2.a, { role: "host", seed: 3, host: { map: "riverlands", mutators: [] } });
      const g = phone(air2.b, { role: "guest", seed: 4 });
      for (let t = 0; t < 2000; t += STEP) {
        air2.advance(STEP);
        drive(h);
        drive(g);
      }
      for (const ph of [h, g]) expect(ph.pairing.state()).toMatchObject({ heard: true, hint: null });
    }
  });

  it("can't be completed by a recorded HELLO or GO from another session", { timeout: 60_000 }, () => {
    // session 1: a full pairing, every frame each phone sent recorded with its time
    const s1 = duel({ seed: 200 });
    pairUp(s1);
    const record = (ph: Phone) => ph.said.map((f) => ({ ...f, at: f.at - ph.said[0]!.at }));
    const hostTape = record(s1.host);
    const guestTape = record(s1.guest);
    expect(hostTape.some((f) => readLobbyFrame(f.bits, f.nbits).go)).toBe(true);

    /** A phone of session 2 that hears a tape played from its start (and, unless alone, its real peer too). */
    const tapeInto = (tape: typeof hostTape) => {
      let i = 0;
      let t0: number | null = null;
      return (pks: LinkPacket[], ph: Phone): LinkPacket[] => {
        const now = ph.link.now();
        t0 ??= now;
        const out = pks.slice();
        for (; i < tape.length && tape[i]!.at <= now - t0; i++) out.push({ bits: tape[i]!.bits, nbits: tape[i]!.nbits, snrDb: 30, at: now, session: false });
        return out;
      };
    };

    // a guest alone with the host's tape, and a host alone with the guest's: no pairing
    for (const [role, tape] of [["guest", hostTape], ["host", guestTape]] as const) {
      const air = new PacketAir({ seed: 201 });
      const lone = phone(air.a, { role, seed: 999, ...(role === "host" ? { host: { map: "riverlands", mutators: [] } } : {}), hear: tapeInto(tape) });
      air.outage(1e9); // (nothing real reaches it)
      for (let t = 0; t < 20_000; t += STEP) {
        air.advance(STEP);
        drive(lone);
        const s = lone.pairing.state();
        expect(["listening", "linking"]).toContain(s.phase);
        expect(s.go).toBe(false);
        if (role === "host") expect(s.config).toBeNull();
      }
      expect(lone.pairing.result()).toBeNull();
      expect(lone.pairing.state().heard).toBe(true);
    }

    // a real pairing with the other session's tapes playing into both phones: it pairs, with its own nonces
    const d = duel({ seed: 202, host: { hear: tapeInto(guestTape) }, guest: { hear: tapeInto(hostTape) } });
    const [h, g] = pairUp(d);
    expectAgreed(d, h, g, { map: "riverlands", mutators: [] });
    const old = s1.host.pairing.result()!;
    expect([h.hostNonce, h.guestNonce]).not.toContain(old.hostNonce);
    expect([h.hostNonce, h.guestNonce]).not.toContain(old.guestNonce);
    for (const ph of [d.host, d.guest]) expect(ph.phases.has("failed")).toBe(false);
  });

  it("starts over when the peer's nonce changes mid-pairing", { timeout: 60_000 }, () => {
    const offer: HostOffer = { map: "riverlands", mutators: [], hostSide: "red" };
    for (const at of ["linking", "waiting", "go"] as const) {
      // "waiting": the host picks first and waits for the guest's pick. "go": the guest picks first, so the
      // host sets GO as it picks and waits for the guest's GO, which the guest sends only on hearing that
      // (a phone that picks last sends GO in its first picked frame: once that is on the air, it can't be taken back)
      const [hostMs, guestMs] = at === "go" ? [2000, 300] : [300, 2000];
      const d = duel({ seed: 300, offer, host: { pickAfterMs: hostMs }, guest: { pickAfterMs: guestMs } });
      const old = d.guest.pairing.state().nonce;
      // the guest restarts (a new lobby, or the retry tap) once the host reaches a phase with the guest hearing it
      // (before that nothing is under way: the host just takes the newest nonce)
      const reached = () => d.host.pairing.state().phase === at && d.host.pairing.state().peer?.hearsMe === true;
      d.run(reached, 30_000);
      expect(reached()).toBe(true);
      retry(d.guest);
      expect(d.guest.pairing.state()).toMatchObject({ phase: "listening", picked: false, go: false });
      expect(d.guest.pairing.state().nonce).not.toBe(old);
      let restartedAt: string | null = null;
      d.run(started(d), 30_000, () => {
        const s = d.host.pairing.state();
        if (s.restarts && restartedAt === null) restartedAt = s.phase;
      });
      // the host forgot what it agreed with the old nonce, then paired with the new one
      expect(restartedAt).toBe("linking");
      const [h, g] = pairUp(d, 1);
      expectAgreed(d, h, g, offer);
      expect(h.guestNonce).toBe(d.guest.pairing.state().nonce);
      expect(d.host.pairing.state().restarts).toBe(1);
    }
  });

  it("starts the phone that loads slowly, and the one that never hears the other's GO", { timeout: 60_000 }, () => {
    // the guest's GO frames never reach the host: the host starts on the guest's first game frame
    const dropGo: PhoneSpec["say"] = (f) => (readLobbyFrame(f.bits, f.nbits).go ? null : f);
    const d = duel({ seed: 400, guest: { say: dropGo, loadMs: 0 }, host: { loadMs: 3000 } });
    d.run(() => d.guest.pairing.result() !== null, 30_000);
    expect(d.guest.pairing.result()).not.toBeNull();
    expect(d.host.pairing.state().phase).toBe("go");
    d.run(() => d.host.pairing.result() !== null, 5000);
    const [h, g] = pairUp(d, 1);
    expectAgreed(d, h, g, { map: "riverlands", mutators: [] });
    expect(d.guest.gameOut).toBe(true);
    // the slow host keeps sending its GO frame while it loads; the started guest takes no notice
    d.run(() => false, 2000);
    expect(d.host.gameOut).toBe(false);
    expect(d.guest.pairing.result()).toEqual(g);
    d.run(() => d.host.gameOut, 3000);
    expect(d.host.gameOut).toBe(true);
    expect(d.host.pairing.result()).toEqual(h);
  });

  it("accepts the peer's GO only with the hello nonce, its own confHash and its own pick", { timeout: 60_000 }, () => {
    /** The host's real frame made a GO that names this guest's pick, then changed one way. */
    type Forge = (f: LobbyFrame, me: PairingState) => LobbyFrame;
    const forgeries: [string, Forge, boolean][] = [
      ["the right one", (f) => f, false],
      ["the wrong theirs", (f, me) => ({ ...f, theirs: OPENER_IDS.find((id) => id !== me.pick)! }), true],
      ["the wrong confHash", (f) => ({ ...f, confHash: f.confHash ^ 1 }), true],
      ["a nonce that never said hello", (f) => ({ ...f, nonce: f.nonce ^ 0x5a5a }), true],
      ["a GO for another phone", (f, me) => ({ ...f, heard: me.nonce ^ 0x0f0f }), false]
    ];
    for (const [what, forge, fails] of forgeries) {
      // the guest is ready (picked, waiting for the host): a GO frame "from the host" arrives
      const d = duel({ seed: 500, host: { pickAfterMs: 4000 } });
      d.run(() => d.guest.pairing.state().phase === "waiting", 30_000);
      const me = d.guest.pairing.state();
      expect(me.phase).toBe("waiting");
      const real = readLobbyFrame(d.host.said[d.host.said.length - 1]!.bits, d.host.said[d.host.said.length - 1]!.nbits);
      expect(real.heard).toBe(me.nonce);
      const go = { ...real, pick: real.pick ?? "blitz", picked: true, go: true, theirs: me.pick };
      const f = writeLobbyFrame(forge(go, me));
      d.guest.pairing.receive({ bits: f.bits, nbits: f.nbits, snrDb: 30, at: d.guest.link.now(), session: false });
      const s = d.guest.pairing.state();
      if (!fails) {
        // (the right one is accepted: the guest's own GO follows, as the frame says the host picked)
        expect(s.phase, what).toBe(what === "the right one" ? "go" : "waiting");
        expect(s.peerGo, what).toBe(what === "the right one");
        continue;
      }
      expect(s.phase, what).toBe("failed");
      expect(s.error, what).toEqual({ kind: "failed", message: FAILED_MESSAGE });
      expect(s.nonce).toBe(0);
      // the host hears nonce 0 and starts over too; the retry tap pairs them afresh
      d.run(() => d.host.pairing.state().restarts > 0, 3000);
      expect(d.host.pairing.state()).toMatchObject({ phase: "linking", picked: false, go: false, restarts: 1 });
      d.run(() => false, 1000);
      expect(d.guest.pairing.state().phase).toBe("failed");
      retry(d.guest);
      const [h, g] = pairUp(d);
      expectAgreed(d, h, g, { map: "riverlands", mutators: [] });
      expect(h.guestNonce).not.toBe(me.nonce);
    }
  });
});

// ------------------------------------------------- what can't break it ---

describe("a pairing under way", () => {
  const offer: HostOffer = { map: "riverlands", mutators: [] };

  it("meets the peer's next incarnation while its own GO is on the air", { timeout: 120_000 }, () => {
    for (const goRole of ["host", "guest"] as const)
      for (const how of ["in flight", "outage", "reload"] as const) {
        const what = `${goRole} at GO, the other ${how === "reload" ? "reloads" : `resets (${how})`}`;
        // the phone that picks last sets GO as it picks (the other picked first: its own GO waits to hear that)
        const [hostMs, guestMs] = goRole === "host" ? [2000, 300] : [300, 2000];
        const d = duel({ seed: 300, offer, host: { pickAfterMs: hostMs }, guest: { pickAfterMs: guestMs } });
        const stay = () => (goRole === "host" ? d.host : d.guest);
        const leave = () => (goRole === "host" ? d.guest : d.host);
        if (how === "outage") {
          // its GO frames never reach the other phone, which resets inside the outage
          d.run(() => stay().pairing.state().go, 30_000);
          d.air.outage(1500, goRole === "host" ? "ab" : "ba");
          d.run(() => false, 1000);
        } else {
          // the first packet carrying GO started 100 ms ago: the packets before it have landed, and it alone is in
          // flight as the other phone starts over
          const first = () => stay().said.findIndex(isGo);
          d.run(() => first() >= 0 && stay().said.length > first() + 1, 30_000);
          d.run(() => false, 100);
        }
        expect(stay().pairing.state().phase, what).toBe("go");
        expect(leave().pairing.state().peerGo, what).toBe(false);
        const old = leave().pairing.state().nonce;
        if (how === "reload") {
          const ph = leave();
          const fresh = phone(ph.link, { ...ph.spec, seed: ph.spec.seed + 1000 });
          if (goRole === "host") d.guest = fresh;
          else d.host = fresh;
        } else retry(leave());
        d.run(started(d), 30_000);
        expect([d.host.pairing.state().phase, d.guest.pairing.state().phase], what).toEqual(["started", "started"]);
        const [h, g] = pairUp(d, 1);
        expectAgreed(d, h, g, offer);
        expect(leave().pairing.state().nonce, what).not.toBe(old);
        expect(stay().pairing.state().restarts, what).toBe(1);
      }
  });

  /** A failed guest's frame: nonce 0, naming the phone it gave up on. */
  const gaveUp = (ph: Phone, on: number) =>
    writeLobbyFrame({ ...lastSaid(ph), nonce: 0, heard: on, confHash: 0, pick: null, picked: false, go: false, theirs: null });

  it("starts over only on a gave-up that names it: not another pair's, not a stale one", { timeout: 60_000 }, () => {
    // one frame of a failed phone that isn't this pairing's (a neighbour, a recording), at each step and at GO
    for (const at of ["picking", "waiting", "go"] as const)
      for (const on of [0, 4242]) {
        const what = `${at}, naming ${on}`;
        const [hostMs, guestMs] = at === "go" ? [2000, 300] : at === "waiting" ? [300, 3000] : [1000, 1000];
        const d = duel({ seed: 500, offer, host: { pickAfterMs: hostMs }, guest: { pickAfterMs: guestMs } });
        d.run(() => d.host.pairing.state().phase === at, 30_000);
        if (at === "go") d.run(() => false, 250); // (its GO is on the air)
        expect(d.host.pairing.state().phase, what).toBe(at);
        inject(d.host, gaveUp(d.guest, on));
        expect(d.host.pairing.state().phase, what).toBe(at);
        const [h, g] = pairUp(d);
        expectAgreed(d, h, g, offer);
        for (const ph of [d.host, d.guest]) expect([ph.pairing.state().restarts, ph.phases.has("failed")], what).toEqual([0, false]);
      }

    // a failed phone nearby, repeating its frame until its player taps retry
    const n = duel({ seed: 501, offer });
    let next = 0;
    n.run(started(n), 30_000, () => {
      if (n.air.now() < next) return;
      inject(n.host, gaveUp(n.guest, 4242));
      next += 400;
    });
    const [nh, ng] = pairUp(n, 1);
    expectAgreed(n, nh, ng, offer);
    expect(n.host.pairing.state().restarts).toBe(0);

    // the peer's own gave-up, delivered late, after the retry tap has paired the phones afresh
    const d = duel({ seed: 502, offer, host: { pickAfterMs: 4000 } });
    d.run(() => d.guest.pairing.state().phase === "waiting", 30_000);
    const real = lastSaid(d.host);
    inject(d.guest, writeLobbyFrame({ ...real, pick: "blitz", picked: true, go: true, theirs: d.guest.pairing.state().pick, confHash: real.confHash ^ 1 }));
    expect(d.guest.pairing.state().phase).toBe("failed");
    d.run(() => false, 1500);
    const failedSaid = d.guest.said.filter((f) => readLobbyFrame(f.bits, f.nbits).nonce === 0);
    expect(failedSaid.length).toBeGreaterThan(3);
    expect(d.host.pairing.state()).toMatchObject({ phase: "linking", restarts: 1 });
    retry(d.guest);
    d.run(() => d.host.pairing.state().phase === "picking", 30_000);
    inject(d.host, failedSaid[failedSaid.length - 1]!);
    expect(d.host.pairing.state()).toMatchObject({ phase: "picking", restarts: 1 });
    const [h, g] = pairUp(d);
    expectAgreed(d, h, g, offer);
    expect(d.host.pairing.state().restarts).toBe(1);
  });

  it("keeps its peer against a phantom nonce: one damaged frame, or a third phone that comes and goes", { timeout: 60_000 }, () => {
    for (const [i, at] of (["linking", "picking", "waiting"] as const).entries()) {
      const d = duel({ seed: 600 + i, offer, host: { pickAfterMs: 300 }, guest: { pickAfterMs: 3000 } });
      d.run(() => d.host.pairing.state().phase === at && d.host.pairing.state().peer?.hearsMe === true, 30_000);
      const f = lastSaid(d.guest);
      expect(f.heard).toBe(d.host.pairing.state().nonce);
      // the guest's frame, its nonce damaged: once
      inject(d.host, writeLobbyFrame({ ...f, nonce: f.nonce ^ 0x0100, go: false, theirs: null }));
      const [h, g] = pairUp(d);
      expectAgreed(d, h, g, offer);
      expect(d.host.pairing.state().restarts, at).toBe(0);
    }

    // a third phone taps Join next to the guest: it hears the host, the host hears it, for 1.5 s; then it leaves
    const d = duel({ seed: 610, offer });
    d.run(() => d.host.pairing.state().peer?.hearsMe === true, 30_000);
    const third = new Pairing({ role: "guest", build: BUILD, now: () => d.guest.link.now(), random: rng(4321) });
    const from = d.air.now();
    const until = from + 1500;
    const clockB = (airMs: number) => airMs + d.guest.link.now() - d.air.now();
    let slotAt = from + 70; // (air time: its own phase)
    let built = third.frame();
    const flight: { due: number; f: { bits: Uint8Array; nbits: number } }[] = [];
    let namedHost = 0;
    d.guest.spec.hear = (pks) => {
      if (d.air.now() < until) for (const pk of pks) third.receive(pk);
      return pks;
    };
    d.host.spec.hear = (pks, ph) => {
      const out = pks.slice();
      while (flight.length && flight[0]!.due <= d.air.now()) {
        const x = flight.shift()!;
        if (readLobbyFrame(x.f.bits, x.f.nbits).heard === ph.pairing.state().nonce) namedHost++;
        out.push({ bits: x.f.bits, nbits: x.f.nbits, snrDb: 30, at: ph.link.now(), session: false });
      }
      return out;
    };
    d.run(started(d), 30_000, () => {
      for (; slotAt <= d.air.now() && slotAt < until; slotAt += 200) {
        third.slot(clockB(slotAt));
        flight.push({ due: slotAt + 250, f: built });
        built = third.frame();
      }
    });
    // (the host heard it, hearing the host, in most of its 1.5 s)
    expect(namedHost).toBeGreaterThanOrEqual(4);
    const [h, g] = pairUp(d, 1);
    expectAgreed(d, h, g, offer);
    expect(d.host.pairing.state().restarts).toBe(0);
  });

  it("isn't ended by a stray frame of another version, even at GO", { timeout: 60_000 }, () => {
    for (const [at, stray, times] of [
      ["linking", { build: 0x1234 }, 1], ["picking", { build: 0x1234 }, 5], ["go", { build: 0x1234 }, 1], ["go", { proto: LOBBY_PROTO + 1 }, 1]
    ] as const) {
      const what = `${at}: ${JSON.stringify(stray)} ×${times}`;
      const d = duel({ seed: 700, offer, host: { pickAfterMs: 2000 }, guest: { pickAfterMs: 300 } });
      d.run(() => d.host.pairing.state().phase === at && d.host.pairing.state().peer?.hearsMe === true, 30_000);
      if (at === "go") d.run(() => false, 250); // (its GO is on the air)
      for (let k = 0; k < times; k++) {
        if (k) d.run(() => false, 200);
        inject(d.host, writeLobbyFrame({ ...lastSaid(d.guest), ...stray, nonce: 777, heard: 4242, go: false, theirs: null }));
        expect(d.host.pairing.state().error, what).toBeNull();
      }
      const [h, g] = pairUp(d);
      expectAgreed(d, h, g, offer);
      expect(d.host.pairing.state().restarts, what).toBe(0);
    }
  });

  it("measures a round trip near zero (a relay, ?duel=loop at latency 0) at any phase", { timeout: 120_000 }, () => {
    for (let a = 0; a < 200; a += 7) {
      const d = duel({ seed: 800, air: { latencyMs: 0, phaseMs: [0, a] } });
      d.run(started(d), 20_000);
      expect(d.host.pairing.state().phase, `phase ${a} ms`).toBe("started");
      const [h] = pairUp(d, 1);
      expect(h.delay).toBe(3);
      expect(d.host.pairing.state().rtt.median!).toBeLessThanOrEqual(5);
    }
  });

  it("accepts the peer's GO only with the peer's pick it holds, and one the rules allow", { timeout: 60_000 }, () => {
    // the guest has set GO, holding the host's pick: a GO "from the host" names another
    const d = duel({ seed: 510, offer, host: { pickAfterMs: 300 }, guest: { pickAfterMs: 2000 } });
    d.run(() => d.guest.pairing.state().phase === "go", 30_000);
    const real = lastSaid(d.host);
    expect([real.picked, real.go, real.heard]).toEqual([true, false, d.guest.pairing.state().nonce]);
    const otherPick = OPENER_IDS.find((id) => id !== real.pick)!;
    inject(d.guest, writeLobbyFrame({ ...real, pick: otherPick, go: true, theirs: d.guest.pairing.state().pick }));
    expect(d.guest.pairing.state()).toMatchObject({ phase: "failed", error: { kind: "failed", message: FAILED_MESSAGE } });
    d.run(() => d.host.pairing.state().restarts > 0, 3000);
    retry(d.guest);
    const [h, g] = pairUp(d);
    expectAgreed(d, h, g, offer);

    // Air War allows the Air Wing only: a GO whose own pick is the Blitz
    const airwar: HostOffer = { map: "dune-sea", mutators: ["airwar"] };
    const e = duel({ seed: 511, offer: airwar, host: { pickAfterMs: 4000 } });
    e.run(() => e.guest.pairing.state().phase === "waiting", 30_000);
    const hostSaid = lastSaid(e.host);
    expect(hostSaid.picked).toBe(false);
    inject(e.guest, writeLobbyFrame({ ...hostSaid, pick: "blitz", picked: true, go: true, theirs: e.guest.pairing.state().pick }));
    expect(e.guest.pairing.state().phase).toBe("failed");
  });

  it("hears a peer that started over under the same nonce: its new pick, not the one it made before", { timeout: 60_000 }, () => {
    // the host picks its last card, and after starting over its first
    const pick = (s: PairingState) => (s.restarts ? s.offered[0]! : s.offered[s.offered.length - 1]!);
    const d = duel({ seed: 520, offer, host: { pickAfterMs: 300, pick }, guest: { pickAfterMs: 6000 } });
    d.run(() => d.guest.pairing.state().peerPicked, 30_000);
    const first = d.host.pairing.state().pick;
    expect(d.host.pairing.state().phase).toBe("waiting");
    // the guest goes unheard for 3 s; meanwhile a phone that hears the host (a third, briefly) takes it over, and leaves
    d.air.outage(3000, "ba");
    d.run(() => false, 500); // (what the guest sent before the outage has landed)
    const f = lastSaid(d.guest);
    for (let i = 1; i <= 3; i++) {
      d.run(() => false, 200);
      inject(d.host, writeLobbyFrame({ ...f, nonce: f.nonce ^ 0x0100, ping: (f.ping + 20 * i) & 255 }));
    }
    expect(d.host.pairing.state()).toMatchObject({ phase: "linking", restarts: 1 });
    // the guest is heard again, the host takes it back and picks again: another card, which the guest plays against
    const [h, g] = pairUp(d);
    expectAgreed(d, h, g, offer);
    expect(d.host.pairing.state().restarts).toBe(2);
    expect(h.setup.openers[h.local]).not.toBe(first);
    for (const ph of [d.host, d.guest]) expect(ph.phases.has("failed")).toBe(false);
  });
});

describe("two phones pairing over the modem", () => {
  it("pair over RoomLink (the real modem in a simulated room), and meet a reset at GO", { timeout: 180_000 }, () => {
    const offer: HostOffer = { map: "riverlands", mutators: [] };
    // (the last two at the modem's clock tolerance, ±300 ppm a phone: each receiver's first packets after lock read
    // 6–14 dB, and before ROBUST_WAIT_FRAMES the host offered robust off them, at D = 6)
    const cases: [number, RoomSide, RoomSide, boolean][] = [[5, {}, { sampleRate: 44100, ppm: 100 }, false], [6, {}, {}, false], [7, {}, {}, true],
      [8, { ppm: 300 }, { ppm: -300 }, false], [7, { ppm: -300 }, { ppm: 300 }, false]];
    for (const [seed, a, b, resetAtGo] of cases) {
      const link = new RoomLink({ seed, distanceCm: 20, a, b });
      const host = phone(link.a, { role: "host", host: offer, seed: 11, pickAfterMs: resetAtGo ? 2000 : 300 });
      const guest = phone(link.b, { role: "guest", seed: 12 });
      const d: Pair = {
        host, guest,
        run(until, limitMs) {
          for (let t = 0; !until() && t < limitMs; t += STEP) {
            link.advance(STEP);
            drive(d.host);
            drive(d.guest);
          }
        }
      };
      if (resetAtGo) {
        // the guest picked first; the host sets GO as it picks, and the guest resets with that GO in flight
        d.run(() => host.pairing.state().go, 30_000);
        d.run(() => false, 100);
        expect(guest.pairing.state()).toMatchObject({ phase: "waiting", peerGo: false });
        retry(guest);
      }
      const [h, g] = pairUp(d, 30_000);
      expectAgreed(d, h, g, offer);
      // the room's round trip, packet start to fully received both ways: two speaker-to-microphone paths (75 ms each)
      // and two of the lobby's robust packets (200 ms each), about 550 ms; so D = 5 for a fast start (4 at 500 ms or
      // less, 6 for a robust one)
      const rtt = host.pairing.state().rtt;
      expect(rtt.samples.length).toBe(5);
      expect(rtt.median!).toBeGreaterThan(520);
      expect(rtt.median!).toBeLessThan(600);
      expect([h.fast, h.delay], `room ${seed}, ${a.ppm ?? 0}/${b.ppm ?? 0} ppm`).toEqual([true, 5]);
      expect(h.delay).toBe(delayFor(rtt.median!, packetMs("high", "fast")));
      expect(host.pairing.state().restarts).toBe(resetAtGo ? 1 : 0);
    }
  });
});
