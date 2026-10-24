/**
 * Pairing for duels (DUEL.md "Pairing"): the lobby protocol that
 * turns two phones hearing each other into one agreed match. Each phone
 * repeats one lobby frame describing its whole state, rebuilt for every
 * packet; there are no requests and no replies, so a lost, repeated or late
 * frame only delays the next step, and the two phones converge on the same
 * config, seed, input delay and openers whatever the air does in between.
 *
 * The host (the phone that tapped Host) owns the config: the menu's map and
 * mutators, its side (a rematch flips it), and two things it measures — fast
 * mode from both phones' receive quality, and the input delay D from the
 * median round trip and the starting mode's packet period (delayFor). It
 * offers the config once the guest hears it, and freezes it the first time
 * it hears the guest hash the same thing. The confHash covers both nonces,
 * so an equal hash also proves the peer heard this phone's fresh nonce: a
 * recording of another session can't produce one.
 * Then both phones pick openers, set GO once they hold the peer's equal hash
 * and final pick, and start once they've sent GO and heard the peer's GO (or
 * any game frame under the session CRC: the peer started first).
 *
 * Engine-free: no DOM, no timers; the clock (the link's) and the nonce draw
 * are injected. The session drives it:
 *
 *   const pairing = new Pairing({ role, build, now: () => link.now(), random: Math.random, host: { map, mutators, hostSide }, plan })
 *   link.send([{ ...pairing.frame(), key: 0 }])           // once, so the first packet carries something
 *   for each slot at of link.slots():  pairing.slot(at); link.send([{ ...pairing.frame(), key: 0 }])
 *   for each packet p of link.poll():  pairing.receive(p); pairing.setRxq(rxqOf(p.snrDb))
 *   the guest, as plan detection settles:  pairing.setPlan(link.stats().plan)
 *   the lobby:  pairing.state(), pairing.pick(id)
 *   the retry tap (or any lobby restart):  pairing.reset(); link.send([{ ...pairing.frame(), key: 0 }])  // at once: the
 *     frame on the link is the old pairing's, maybe its GO, which the friend would accept and start on alone
 *   once state().go:  link.setSessionKey(state().nonces.host, state().nonces.guest)
 *   once result() isn't null: load the match (keep sending frame() until the first game frame)
 *
 * Lobby frame, MSB-first:
 *
 *   type 2 (10)  role 1 (0 host, 1 guest)  proto 4  build 16
 *   nonce 16 (1…65535; 0: none)  heard 16 (the peer nonce this phone hears; 0: none)  rxq 3
 *   ping 8 (link clock at the start of the packet carrying it, 10 ms units, mod 256)
 *   echo 8 (the newest peer ping heard)  hold 7 (10 ms units from hearing it to this packet's start; 127: too old, or none)
 *   hasConfig 1 (host only), then: map 4 (0–5: MAPS index; 8–12: random map of BIOMES[map − 8], then seed 32)
 *     mutators 12 (MUTATOR_IDS order, first mutator first)  delay 3 (D − 3)  hostSide 1 (0: the host plays blue)  fast 1
 *   confHash 16 (0: none yet)  pick 2 (OPENER_IDS index; 3: none)  picked 1  go 1, then theirs 2 (the peer's pick as held here)
 *   [proto 2] nations 1 (1: the extension follows), nation 2 (the nation this phone asks for: 0 Classique / none,
 *     1 République, 2 Empire), then, with a config: hostNation 2  guestNation 2 (both 0: Classique; else both 1–2)
 *
 * The longest frame (a random map and GO) is 164 bits (157 without the extension); the low plan carries 186.
 *
 * Nations (LOBBY_PROTO 2, PANACHE-CONCEPTION.md §1.10): proto 2 is proto 1's frame plus a trailing extension,
 * so its header still says 1 (WIRE_PROTO) and a proto-1 phone reads it as its own: the bits after `theirs` are
 * the modem's zero padding to it. A phone that hears the extension knows its peer speaks proto 2. The host
 * offers its menu nation, the guest asks for one in every frame (none: the host's rival); the host's config
 * names both, and they enter the confHash only when they aren't Classique, so a Classique config hashes as in
 * proto 1. A peer without the extension (proto 1) gets no nations offered: the match falls back to Classique
 * on its own, with no version error and no switch of protocol mid-pairing. A frame cut right before the
 * extension reads as one without it.
 *
 * Where the spec is silent:
 *  - a nonce is drawn at construction, at reset() (the retry tap), and when
 *    the peer gives up. A restart the peer causes otherwise keeps this
 *    phone's nonce (the peer's next incarnation has already heard it), so
 *    two phones never chase each other's changes;
 *  - a failed phone sends nonce 0 (none) with `heard` naming the phone it
 *    gave up on, until its retry tap. Only that phone starts over, and it
 *    draws a fresh nonce as it does, so a copy of the gave-up still on the
 *    air or replayed later names a nonce no longer in use. A gave-up naming
 *    anyone else (another pair's failed phone nearby, a recording, 0) does
 *    nothing;
 *  - which frames may change the peer: until the peer hears this phone,
 *    nothing is agreed and the newest nonce heard is the peer (its HELLO),
 *    so two phones that each first caught a recording still find each other.
 *    Once the peer hears this phone, only a phone that hears this phone's
 *    current nonce can take over — the peer's next incarnation after a reset
 *    or reload, the one phone that can know it — and only once 3 of its
 *    packets are heard with nothing from the peer (a newest frame that hears
 *    this phone) in between. The peer's next incarnation does that within a
 *    few packets, as the old one has gone quiet; one damaged frame, or a
 *    third phone that hears this phone while the peer is still heard, never
 *    does. The nonce replaced is retired, so its late frames are ignored,
 *    unless the phone that took over is then silent for 2 s while the
 *    retired one still hears this phone: a third phone that came and went
 *    can't strand the real peer. Every other frame (a recording, the peer
 *    before it hears this phone's new nonce) is ignored;
 *  - a GO that doesn't name this phone's current nonce in `heard` is no GO
 *    here (another phone's, or for this phone before a reset), but still its
 *    sender's HELLO: a phone whose GO is on the air when its friend resets
 *    meets the friend's next incarnation, which takes over as above. A GO
 *    that names this phone from a nonce that isn't the peer's — a phone
 *    taking over, or in the frame that introduces its nonce — is one from a
 *    nonce that never said hello: a failure;
 *  - the peer's GO is accepted only if, besides the spec's three checks, its
 *    own pick is the one this phone holds for the peer (committed in this
 *    phone's GO; before that, the peer's newest frame's, else the GO's own)
 *    and one the config allows the peer's side. Both phones then check both
 *    picks and the hash, so a phone that starts on the other's game frame
 *    starts the match the other checked;
 *  - the host offers a config once the guest hears it and it holds 3 round
 *    trips and 10 frames each way since it first heard the guest, so D has a
 *    median and fast a full window: a fast one at once, a robust one only
 *    once the windows have also said robust for 8 more of its frames in a row
 *    (ROBUST_WAIT_FRAMES: a receiver's first packets after lock read low at
 *    the modem's ±300 ppm, and would start a good link robust). It freezes on
 *    a guest hash (from a frame that hears it) equal to any of its offers
 *    since the last restart, not only the newest: the guest held that one,
 *    and D near a boundary can't then keep the two apart;
 *  - only the newest frame from the peer moves the echo, takes a round trip,
 *    counts toward the rxq window, updates the guest's copy of the config, or
 *    says where the peer stands: its pick, and whether it is ready under this
 *    phone's hash. Newest is one on time (its arrival minus its ping near the
 *    median of the peer's last frames') whose ping is ahead of the echo's. A
 *    pick is final within one pairing, but a peer that started over under the
 *    same nonce says so in its next frames, and its next pick replaces the
 *    old one; only a GO commits a pick for the match. Duplicates and late
 *    frames still count for what is final once said (hearing this phone, a
 *    hash the host freezes on, GO), so they can delay pairing, never fork it;
 *  - before picking, a frame says pick 3, picked 0. When no opener is allowed
 *    for this side, the pick is "none" at once. The peer's pick must be one
 *    the config allows its side before this phone sets GO. A restart clears
 *    both picks and restarts the 20 s;
 *  - "nothing heard" counts only frames of the other role (two phones in the
 *    same band can't hear each other, but a frame-level link delivers them);
 *  - a version error takes 3 frames of another version within 5 s, and none
 *    count while the peer is there (heard hearing this phone in the last
 *    2 s): a stray frame from a phone nearby on an old build, or a tape of
 *    one, can't end a pairing. With equal protos neither phone can say which
 *    is older;
 *  - the host's mutators go in MUTATOR_IDS order, without those its map bans
 *    (as activeMutators() gives them: setupWorld would drop them anyway);
 *  - the period is the median of the last 5 slot intervals (a superframe's
 *    sync makes one in ten longer), 200 ms before two slots; before any slot
 *    the next start is now;
 *  - a round trip is never below zero: one read up to 10 ms below (hold's
 *    rounding, near zero latency) counts as 0. The median of an even number
 *    of round trips is the mean of the middle two;
 *  - "sent GO" means a slot came after a GO frame was built. A GO on the air
 *    can't be taken back: a phone that then fails or resets may leave its
 *    friend started, and waiting for it to load;
 *  - round trips and the rxq windows measure the link, not the pairing: they
 *    survive restarts and resets. The echo and what "on time" is start over
 *    with each new peer nonce (it may be another phone, on another clock);
 *  - this phone's own rxq window takes the frames built since it heard a
 *    peer, not every frame on the air since: the one that goes out as it
 *    first hears was built before, saying rxq 0. A host that hears its guest
 *    last (the guest hearing it already, the round trips quick to come) made
 *    its first offer as its tenth frame went out, with that 0 in the window:
 *    robust, which the guest echoed and the host froze on. Over RoomLink (both
 *    plans, 20 and 40 cm, 12 rooms each, at most ±100 ppm) 10 of 48 pairings
 *    started robust with it, 2 without: a link at 9 dB, and one at 13 whose
 *    first frames, while the SNR's running mean settled, read under 12 (which
 *    ROBUST_WAIT_FRAMES now waits out);
 *
 * Deviation: `hold` is 7 bits (127: too old), not 5 (31), so the longest
 * frame is 157 bits rather than 155 (the low plan carries 186). The frame for
 * a packet is built at the slot before it, so the newest ping a phone holds
 * is from one own period plus up to one peer period before the start: 200–400
 * ms in the high plan's robust mode, 400–800 ms in the low plan's, plus a
 * peer period for each packet lost. Five bits (up to 300 ms) would discard
 * every round trip for about half the phase relationships between the two
 * phones' packets in the high plan, and all of them in the low plan, and the
 * host could never compute D. (Over PacketAir, steady holds ran 210–400 ms
 * with 200 ms packets, where 20 of 40 phase offsets fitted 5 bits, and
 * 410–800 ms with 400 ms packets, where none of 80 did.) Seven bits hold
 * 1,260 ms.
 */
import type { BandPlan, BandRole, LinkPacket, ModemMode } from "../link/transport";
import { BIOMES, parseRandomMapId, randomMapId } from "../sim/mapgen";
import { MAPS, mapBansMutator } from "../sim/maps";
import { OPENER_IDS, allowedOpener, openerBlocked, type OpenerId } from "../sim/openers";
import { hash32 } from "../sim/rand";
import { MUTATOR_IDS, isMutatorId, type MutatorId } from "../sim/rules";
import { setupWorld, type MatchSetup } from "../sim/setup";
import type { Faction, Nation, NationOrClassic, World } from "../sim/types";
import { BitReader, BitWriter, CodecError } from "./codec";
import { tr } from "../lang";

/** The lobby protocol's version: bumped with any change to the frame or the rules, so the lobby can say which phone is older. */
export const LOBBY_PROTO = 2;
/** The longest lobby frame (a random map, GO and the nations' extension). */
export const LOBBY_FRAME_MAX = 164;
/** The first protocol with the nations' extension (whose frames say proto 1: the extension trails proto 1's frame). */
const PROTO_NATIONS = 2;
/** The header a phone of this protocol writes: proto 2's frame is proto 1's, extended. */
export const wireProto = (proto: number): number => (proto === PROTO_NATIONS ? 1 : proto);
/** Round trips kept; D comes from their median. */
export const RTT_KEPT = 5;
/** Round trips the host waits for before it offers a config. */
export const RTT_MIN = 3;
/** Fast mode needs both phones' last this many frames … */
export const FAST_FRAMES = 10;
/**
 * … to report at least this rxq (12 dB): one step above the lowest at which
 * fast delivers 98% everywhere. Over RoomLink (both plans, 48/48 and 48/44.1
 * kHz, 20 and 40 cm, noise swept, both directions; 20 s of fast per point)
 * fast delivered every packet wherever the receiver reported rxq 3 (9–12 dB),
 * while the worst point reporting 2 (6–9 dB) delivered 50–100% by plan, rate
 * and distance, and at 1 13–50%. The rxq the lobby reports is of robust
 * packets; at the same noise it read as fast's within 1.5 dB (the same rxq
 * at 127 of 136 points). The session returns to fast at the same rxq.
 */
export const FAST_RXQ = 4;
/**
 * The host offers fast as soon as both windows qualify, robust only once they
 * have failed to at the frame they filled and at this many of its frames
 * after it, in a row. A receiver's SNR reads low for its first packets after
 * lock while its clock tracker converges, at a relative clock offset of
 * 500–600 ppm (the modem's ±300 per phone), and the session's running mean
 * lags it further. Over RoomLink (both plans, 10–50 cm, 48 and 44.1 kHz,
 * ±300 and ±250 ppm) those first frames read rxq 1–3 on links that settled
 * at 15–29 dB, and it took the host's window up to 6 frames to clear of them,
 * the low plan's guest's up to 2. The host freezes on the first offer the
 * guest echoes, so without this wait a window that still held them started
 * such a match robust, at robust's longer D: 27 of 45 high-plan pairings at
 * 500–600 ppm, against 6 with it (each on a link under 14 dB one way); on the
 * low plan 8 against 6, and at 0 ppm the same either way. It costs a robust
 * start these frames (1.6 s on the high plan, 3.2 s on the low) and a fast
 * one nothing.
 */
export const ROBUST_WAIT_FRAMES = 8;
/** Picking times out after this long (from the config being agreed on this phone). */
export const PICK_TIMEOUT_MS = 20_000;
/** Nothing heard for this long: the lobby suggests one phone taps Host and the other Join. */
export const NOTHING_HEARD_MS = 8_000;
/** The input delay's range (ticks). */
export const DELAY_MIN = 3;
export const DELAY_MAX = 8;
/**
 * The input delay's margin over half the round trip and a packet period (ms):
 * decoding, the gap a superframe's sync symbol (50 ms) leaves every 10–20
 * packets, the feed's frame quantization and the tick phase between the
 * phones. The smallest multiple of 10 that keeps stalls at 0.5% of the match
 * or less wherever D ≤ 8 can (see delayFor).
 */
export const DELAY_MARGIN_MS = 50;

export const VERSION_MESSAGE = tr("Ces téléphones n'ont pas la même version : recharge les deux", "These phones are on different versions: reload both");
export const FAILED_MESSAGE = tr("Échec de l'appairage : touche pour réessayer", "Pairing failed: tap to try again");
export const NOTHING_HEARD_MESSAGE = tr("Rien entendu pour l'instant. Un téléphone touche Héberger, l'autre Rejoindre", "Nothing heard yet. One phone taps Host, the other Join");

const TYPE_LOBBY = 0b10;
/** `hold` and `echo` saying nothing usable: no ping heard, or one heard too long ago. */
const HOLD_NONE = 127;
const HOLD_BITS = 7;
/** The packet period assumed before two slots have been seen (a robust packet, high plan). */
const PERIOD_GUESS_MS = 200;
/** Slot starts kept, for the period. */
const SLOTS_KEPT = 6;
/** Map codes 8… are random maps, BIOMES order. */
const MAP_RANDOM = 8;
const MUTATOR_BITS = 12;
/** type, role, proto and build: the part every protocol version shares. */
const HEADER_BITS = 2 + 1 + 4 + 16;
/**
 * An echo of a ping this phone sent longer ago than this is garbage. Up to it,
 * the newest packet stamped with that value is the right one unless a later
 * packet took the same value: at a steady 200 ms a packet that takes 12.8 s
 * (the ping advances 20 a packet); a superframe's sync can bring a value back
 * after 2.56 s, but round trips over the air are far shorter than that.
 */
const ECHO_MAX_AGE_MS = 10_000;
/** Ping values wrap after this long. */
const PING_WRAP_MS = 2560;
/** A frame is on time when its (arrival − ping) is within this of the median of the peer's last frames' (a superframe's sync makes one prediction in ten 50 ms early). */
const ON_TIME_MS = 150;
/** The peer's last frames whose (arrival − ping) set what "on time" is. */
const OFFSETS_KEPT = 7;
/** Offers the host remembers for the freeze. */
const OFFERS_KEPT = 8;
/** Retired peer nonces remembered. */
const RETIRED_KEPT = 8;
/** `hold`'s unit (ms): a round trip read this far below zero is rounding, not garbage. */
const HOLD_UNIT_MS = 10;
/** A phone that hears this phone takes over from the peer once this many of its packets (distinct pings) are heard with nothing live from the peer in between. */
const TAKEOVER_FRAMES = 3;
/** The peer counts as there while a newest frame of it that hears this phone came within this long; a nonce this phone left may come back only after the peer it took has been silent this long. */
const PEER_LIVE_MS = 2000;
/** A version mismatch takes this many frames of another version within MISMATCH_WINDOW_MS (and no peer there): one stray frame isn't a verdict. */
const MISMATCH_FRAMES = 3;
const MISMATCH_WINDOW_MS = 5000;

// ------------------------------------------------------------- the frame ---

/** What a match is played under, as both phones agree on it. */
export interface DuelConfig {
  /** The map as the game names it: a MAPS id, or randomMapId(biome, seed). */
  mapId: string;
  /** In MUTATOR_IDS order, no repeats. */
  mutators: MutatorId[];
  /** Input delay D, 3–8 ticks. */
  delay: number;
  /** The side the host plays. */
  hostSide: Faction;
  /** The match starts in fast mode. */
  fast: boolean;
  /** The nations the host's side and the guest's play (proto 2); absent: Classique. */
  nations?: { host: Nation; guest: Nation };
}

/** The part of a lobby frame every protocol version lays out the same way. */
export interface LobbyHeader {
  role: BandRole;
  proto: number;
  build: number;
}

export interface LobbyFrame extends LobbyHeader {
  nonce: number;
  heard: number;
  rxq: number;
  ping: number;
  echo: number;
  hold: number;
  /** The host's offer (null from a guest, and from a host with nothing to offer yet). */
  config: DuelConfig | null;
  confHash: number;
  /** null: none (not picked yet, or no opener allowed). */
  pick: OpenerId | null;
  picked: boolean;
  go: boolean;
  /** With GO: the peer's pick as this phone holds it (null otherwise). */
  theirs: OpenerId | null;
  /** The nations' extension (proto 2): the nation this phone asks for. Absent: a proto-1 frame. */
  nation?: NationOrClassic;
}

const ROLES: readonly BandRole[] = ["host", "guest"];
const SIDES: readonly Faction[] = ["blue", "red"];
const PICK_NONE = 3;

const pickCode = (p: OpenerId | null): number => (p === null ? PICK_NONE : OPENER_IDS.indexOf(p));
const pickOf = (code: number): OpenerId | null => OPENER_IDS[code] ?? null;
const NATION_CODES: readonly NationOrClassic[] = ["classique", "republique", "empire"];
const nationCode = (n: NationOrClassic): number => NATION_CODES.indexOf(n);
/** The other nation (a guest with no preference plays the host's rival). */
export const rivalOf = (n: Nation): Nation => (n === "republique" ? "empire" : "republique");
/** The sides' nations under a config, blue's first (absent: Classique). */
export function configNations(c: DuelConfig): Partial<Record<Faction, Nation>> | undefined {
  if (!c.nations) return undefined;
  const { host, guest } = c.nations;
  return c.hostSide === "blue" ? { blue: host, red: guest } : { blue: guest, red: host };
}
/** A config's copy, sharing nothing with it. */
const copyConfig = (c: DuelConfig): DuelConfig => ({ ...c, mutators: c.mutators.slice(), ...(c.nations ? { nations: { ...c.nations } } : {}) });

/** A map's code in the frame (and a random map's seed). Throws RangeError for a map no frame can name (a ninth built-in map needs a wider field, and a new LOBBY_PROTO). */
function mapCode(mapId: string): { code: number; seed: number | null } {
  const i = MAPS.findIndex((m) => m.id === mapId);
  if (i >= 0 && i < MAP_RANDOM) return { code: i, seed: null };
  const r = parseRandomMapId(mapId);
  const b = r ? BIOMES.indexOf(r.biome) : -1;
  if (r && b >= 0 && MAP_RANDOM + b < 16) return { code: MAP_RANDOM + b, seed: r.seed };
  throw new RangeError(`map ${mapId} can't be named in a lobby frame`);
}

function checkField(name: string, v: number, bits: number): void {
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits) throw new RangeError(`lobby frame ${name} ${v}: ${bits} bits`);
}

/** Encode a lobby frame (MSB-first). Throws RangeError on a field out of range: a bug, never the air. */
export function writeLobbyFrame(f: LobbyFrame): { bits: Uint8Array; nbits: number } {
  checkField("proto", f.proto, 4);
  checkField("build", f.build, 16);
  checkField("nonce", f.nonce, 16);
  checkField("heard", f.heard, 16);
  checkField("rxq", f.rxq, 3);
  checkField("ping", f.ping, 8);
  checkField("echo", f.echo, 8);
  checkField("hold", f.hold, HOLD_BITS);
  checkField("confHash", f.confHash, 16);
  if (f.config && f.role !== "host") throw new RangeError("only the host's frame carries a config");
  if (f.nation !== undefined && nationCode(f.nation) < 0) throw new RangeError(`no nation ${f.nation}`);
  if (f.config?.nations && f.nation === undefined) throw new RangeError("nations ride in the extension");
  if (f.go && !f.picked) throw new RangeError("GO before picking");
  const wr = new BitWriter();
  wr.bits(TYPE_LOBBY, 2);
  wr.bit(f.role === "host" ? 0 : 1);
  wr.bits(f.proto, 4);
  wr.bits(f.build, 16);
  wr.bits(f.nonce, 16);
  wr.bits(f.heard, 16);
  wr.bits(f.rxq, 3);
  wr.bits(f.ping, 8);
  wr.bits(f.echo, 8);
  wr.bits(f.hold, HOLD_BITS);
  wr.bit(f.config ? 1 : 0);
  if (f.config) {
    const c = f.config;
    const m = mapCode(c.mapId);
    wr.bits(m.code, 4);
    if (m.seed !== null) wr.bits(m.seed, 32);
    for (const id of c.mutators) if (!isMutatorId(id)) throw new RangeError(`no mutator ${id}`);
    if (MUTATOR_IDS.length > MUTATOR_BITS) throw new RangeError("more mutators than the frame's field: widen it, and bump LOBBY_PROTO");
    for (const id of MUTATOR_IDS) wr.bit(c.mutators.includes(id) ? 1 : 0);
    for (let i = MUTATOR_IDS.length; i < MUTATOR_BITS; i++) wr.bit(0);
    if (!Number.isInteger(c.delay) || c.delay < DELAY_MIN || c.delay > DELAY_MAX) throw new RangeError(`input delay ${c.delay}`);
    wr.bits(c.delay - DELAY_MIN, 3);
    wr.bit(c.hostSide === "blue" ? 0 : 1);
    wr.bit(c.fast ? 1 : 0);
  }
  wr.bits(f.confHash, 16);
  wr.bits(pickCode(f.pick), 2);
  wr.bit(f.picked ? 1 : 0);
  wr.bit(f.go ? 1 : 0);
  if (f.go) wr.bits(pickCode(f.theirs), 2);
  if (f.nation !== undefined) {
    wr.bit(1);
    wr.bits(nationCode(f.nation), 2);
    if (f.config) {
      wr.bits(f.config.nations ? nationCode(f.config.nations.host) : 0, 2);
      wr.bits(f.config.nations ? nationCode(f.config.nations.guest) : 0, 2);
    }
  }
  return { bits: wr.bytes(), nbits: wr.nbits };
}

/** The type, role, proto and build: readable whatever the sender's protocol. Throws CodecError if it isn't a lobby frame. */
export function readLobbyHeader(bits: Uint8Array, nbits: number): LobbyHeader {
  const rd = new BitReader(bits, nbits);
  if (rd.bits(2) !== TYPE_LOBBY) throw new CodecError("not a lobby frame");
  const role = ROLES[rd.bit()]!;
  return { role, proto: rd.bits(4), build: rd.bits(16) };
}

/**
 * Read a lobby frame of this protocol. Throws CodecError on anything
 * malformed: another type, a read past `nbits`, a map, mutator or delay code
 * outside its table, a config from a guest, GO without a pick.
 */
export function readLobbyFrame(bits: Uint8Array, nbits: number): LobbyFrame {
  const head = readLobbyHeader(bits, nbits);
  const rd = new BitReader(bits, nbits, HEADER_BITS);
  const nonce = rd.bits(16);
  const heard = rd.bits(16);
  const rxq = rd.bits(3);
  const ping = rd.bits(8);
  const echo = rd.bits(8);
  const hold = rd.bits(HOLD_BITS);
  let config: DuelConfig | null = null;
  if (rd.bit()) {
    if (head.role !== "host") throw new CodecError("a config from the guest");
    const code = rd.bits(4);
    let mapId: string;
    if (code < MAPS.length) mapId = MAPS[code]!.id;
    else if (code >= MAP_RANDOM && code < MAP_RANDOM + BIOMES.length) mapId = randomMapId(BIOMES[code - MAP_RANDOM]!, rd.bits(32));
    else throw new CodecError(`map code ${code}`);
    const mutators: MutatorId[] = [];
    for (let i = 0; i < MUTATOR_BITS; i++) {
      if (!rd.bit()) continue;
      const id = MUTATOR_IDS[i];
      if (!id) throw new CodecError(`mutator bit ${i}`);
      mutators.push(id);
    }
    const delay = DELAY_MIN + rd.bits(3);
    if (delay > DELAY_MAX) throw new CodecError(`input delay ${delay}`);
    const hostSide = SIDES[rd.bit()]!;
    const fast = rd.bit() === 1;
    config = { mapId, mutators, delay, hostSide, fast };
  }
  const confHash = rd.bits(16);
  const pick = pickOf(rd.bits(2));
  const picked = rd.bit() === 1;
  const go = rd.bit() === 1;
  if (go && !picked) throw new CodecError("GO before picking");
  const theirs = go ? pickOf(rd.bits(2)) : null;
  const f: LobbyFrame = { ...head, nonce, heard, rxq, ping, echo, hold, config, confHash, pick, picked, go, theirs };
  // the nations' extension (proto 2): a proto-1 frame ends here, or goes on in the modem's zero padding
  if (rd.pos < rd.nbits && rd.bit() === 1) {
    const nation = (): NationOrClassic => {
      const n = NATION_CODES[rd.bits(2)];
      if (!n) throw new CodecError("nation code 3");
      return n;
    };
    f.nation = nation();
    if (config) {
      const host = nation();
      const guest = nation();
      if ((host === "classique") !== (guest === "classique")) throw new CodecError("one side Classique, the other a nation");
      if (host !== "classique" && guest !== "classique") config.nations = { host, guest };
    }
  }
  return f;
}

// ------------------------------------------------------------ the rules ---

/**
 * A packet's period in a mode on a plan (ms): 100 and 200 ms (the relay's
 * packet clock, relay-transport.ts RELAY_PERIOD_MS); 200 and 400 on the low
 * plan, a leftover of the sound link's that no link uses any more.
 */
const PACKET_MS: Record<BandPlan, Record<ModemMode, number>> = { high: { fast: 100, robust: 200 }, low: { fast: 200, robust: 400 } };
export const packetMs = (plan: BandPlan, mode: ModemMode): number => PACKET_MS[plan][mode];

/**
 * D = clamp(ceil((rtt / 2 + P + M) / 100 ms), 3, 8): rtt the round trip's
 * median (packet start to fully received, both ways: transport.ts
 * LinkPacket.at), P the starting mode's packet period on the plan (packetMs:
 * a sealed turn waits up to a packet for the next one to start), M
 * DELAY_MARGIN_MS.
 *
 * M by measurement: two Sessions over RoomLink through pairing into a match,
 * AIs on both sides, 1200 ticks, no added loss, mode adaptation off; stall
 * counted on the phone that stalled more. What binds is a robust start on the
 * high plan: its lobby packets are the match's, so a turn has M and what
 * ceil() rounds up beyond rtt / 2 + P, and nothing more. With D forced to 5
 * or 6 and both phones' audio path stepped from 10 to 180 ms (10–50 cm, 48
 * and 44.1 kHz, up to ±300 ppm; 102 runs), so that this margin, 100·D −
 * rtt / 2 − P, ran from 0 to 90 ms: under 15 ms every run stalled over 0.5%
 * (0.65–1.76%), at 15–35 ms 4 of 10, at 35–40 ms 1 of 7 (0.55%), at 40–46
 * none of 9 (0.48% at most; another review's run at 41 ms stalled 0.54%), at
 * 46–57 ms none of 35 (0.49% at most, three over 0.4%) and from 57 ms none of
 * 33 (0.22%). No packet was lost in any of them: the stall is the sync
 * symbol's gap and the phase of packets against ticks. M = 50.
 *
 * With it, at the room's 75 ms audio path (the round trip 546–557 ms on the
 * high plan, 947–956 on the low), D came out 5 for a fast start and 6 for a
 * robust one on the high plan (at most 0.17% in 6 and 0.08% in 6 runs, ±300
 * ppm among them), 4 or 5 for a fast start at 50 ms (0.08%), and 8 for both
 * on the low plan: fast 0.00% in 4, robust 5.4–7.6% in 4. The low plan's
 * robust turns need about a second (D = 10, past DELAY_MAX): its 400 ms
 * packets alone take two fifths of it. Over PacketAir with the margin exactly
 * 50 ms (latencies 150–450 ms, six phases each), no run of fast or robust on
 * either plan stalled after its first 50 ticks, and none more than 0.34% in
 * all. A latency shorter than the packet's own period (PacketAir's is start
 * to fully received) is no link, and says nothing: robust on the low plan's
 * 400 ms packets at 350 ms stalled 0.71%, at 150 ms up to 0.76%.
 *
 * The round trip holds two of the lobby's robust packets, not the match's, so
 * a fast start gets more delay than fast needs over the modem (100 ms more on
 * the high plan, 200 on the low: 5 where 4 sufficed, 8 where 6 did); over
 * PacketAir, whose latency is the same in either mode, it is what the formula
 * assumes. And a match keeps its D when the session falls back to robust,
 * so from a fast start robust's turns get 100 ms (the low plan's 200) less
 * than this would give them (session.ts).
 */
export const delayFor = (rttMs: number, periodMs: number): number =>
  Math.max(DELAY_MIN, Math.min(DELAY_MAX, Math.ceil((rttMs / 2 + periodMs + DELAY_MARGIN_MS) / 100)));

/** The hash both phones compare: the config, the band plan and both nonces, in 16 bits (never 0, which means none). */
export function confHash(c: DuelConfig, plan: BandPlan, hostNonce: number, guestNonce: number): number {
  const m = mapCode(c.mapId);
  let mask = 0;
  for (let i = 0; i < MUTATOR_IDS.length; i++) if (c.mutators.includes(MUTATOR_IDS[i]!)) mask |= 1 << i;
  let h = hash32(0x5d0c, m.code, m.seed ?? 0, mask, c.delay, c.hostSide === "blue" ? 0 : 1, c.fast ? 1 : 0, plan === "high" ? 0 : 1, hostNonce, guestNonce);
  // (nations only when there are some: a Classique config hashes as in proto 1)
  if (c.nations) h = hash32(h, 0x7a71, nationCode(c.nations.host), nationCode(c.nations.guest));
  return h & 0xffff || 0xffff;
}

/** The match seed: hash32(hostNonce, guestNonce, 1). */
export const matchSeed = (hostNonce: number, guestNonce: number): number => hash32(hostNonce, guestNonce, 1);

const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** x folded into (−1280, 1280] ms: a difference of two times known only mod the ping's wrap. */
const wrapDiff = (x: number): number => {
  const h = PING_WRAP_MS / 2;
  return ((((x + h) % PING_WRAP_MS) + PING_WRAP_MS) % PING_WRAP_MS) - h;
};

const pushKept = (xs: number[], x: number, kept: number): void => {
  xs.push(x);
  if (xs.length > kept) xs.shift();
};

// ------------------------------------------------------------- Pairing ---

/** What the host brings: the menu's map and mutators at the Duel tap, and its side. */
export interface HostOffer {
  /** shownMap(): a MAPS id or randomMapId(biome, seed). */
  map: string;
  mutators: readonly MutatorId[];
  /** The side the host plays (a rematch flips it). Default blue. */
  hostSide?: Faction;
  /** The host's nation (the menu's pick; proto 2). Default Classique: both sides play Classique. */
  nation?: NationOrClassic;
}

export interface PairingOptions {
  role: BandRole;
  /** The first 16 bits of the duel build hash: parseInt(__DUEL_HASH__.slice(0, 4), 16). */
  build: number;
  /** The lobby protocol (default LOBBY_PROTO; tests play an older phone with another). */
  proto?: number;
  /** The band plan this phone transmits in (the guest: setPlan once detection settles). Default high. */
  plan?: BandPlan;
  /** Required for the host, ignored for the guest. */
  host?: HostOffer;
  /** The guest's ask (proto 2) under a host's nation. Default "classique": none, it plays the host's rival. Ignored for the host (HostOffer.nation). */
  nation?: NationOrClassic;
  /** The link's monotonic milliseconds (LinkTransport.now). */
  now: () => number;
  /** Uniform in [0, 1): the nonce draw. */
  random: () => number;
}

export type PairingPhase =
  /** Nothing heard from a phone of the other role yet (since the start or the last reset). */
  | "listening"
  /** A phone of the other role is heard; no agreed config yet. */
  | "linking"
  /** The config is agreed: the opener cards are up. */
  | "picking"
  /** Picked; waiting for the peer's pick. */
  | "waiting"
  /** This phone sent GO; waiting for the peer's. */
  | "go"
  /** Both GO: result() holds the match. */
  | "started"
  /** "Pairing failed: tap to retry" (reset() is the tap). */
  | "failed"
  /** The phones run different versions. */
  | "error";

export type PairingError =
  | { kind: "version"; /** Which phone runs the older protocol (null: same protocol, other build). */ older: "this" | "friend" | null; message: string }
  | { kind: "failed"; message: string };

export interface PairingState {
  phase: PairingPhase;
  role: BandRole;
  /** This phone's nonce (0 while failed). */
  nonce: number;
  /** A frame from a phone of the other role was heard since the start (or the last reset). */
  heard: boolean;
  /** Milliseconds since the last one (Infinity: none). */
  sinceHeardMs: number;
  /** The phone heard last: its header, and, once it's this phone's peer, its nonce and whether it hears this phone. */
  peer: { role: BandRole; build: number; proto: number; nonce: number; hearsMe: boolean } | null;
  /** Round trips (ms), oldest first, and their median. */
  rtt: { median: number | null; samples: number[] };
  /** This phone's receive quality of the peer, and the peer's of this phone (its newest frame). */
  rxq: number;
  peerRxq: number | null;
  /** The config, once agreed. */
  config: DuelConfig | null;
  /** The side this phone plays, once agreed. */
  side: Faction | null;
  /** The openers this phone may pick (empty until agreed, and when the rules allow none). */
  offered: OpenerId[];
  /** This phone's pick (null: none) once `picked`. */
  pick: OpenerId | null;
  picked: boolean;
  peerPicked: boolean;
  /** Until the pick times out (null: not picking). */
  pickLeftMs: number | null;
  go: boolean;
  peerGo: boolean;
  /** Both nonces once known: at GO the session calls transport.setSessionKey(host, guest). */
  nonces: { host: number; guest: number } | null;
  error: PairingError | null;
  /** After 8 s with nothing heard: one phone should tap Host, the other Join (the lobby offers a switch). */
  hint: { kind: "switch-role"; message: string } | null;
  /** Times pairing restarted because the peer changed its nonce or gave up. */
  restarts: number;
}

export interface PairingResult {
  role: BandRole;
  /** The side this phone commands. */
  local: Faction;
  /** setupWorld(setup) is the same world on both phones. */
  setup: MatchSetup;
  /** Input delay D (ticks). */
  delay: number;
  /** Switch the link to fast mode for the match. */
  fast: boolean;
  hostNonce: number;
  guestNonce: number;
  plan: BandPlan;
  /** The map as the game names it (gameMode.mapId). */
  mapId: string;
  config: DuelConfig;
}

interface Agreed {
  config: DuelConfig;
  hash: number;
}

export class Pairing {
  readonly role: BandRole;
  readonly build: number;
  readonly proto: number;
  /** The nation this phone asks for (the host: its offer's). */
  private readonly nation: NationOrClassic;
  /** The peer's newest frame carried the nations' extension (it speaks proto 2), and what it asked for. */
  private peerNation: NationOrClassic | null = null;
  private plan: BandPlan;
  private readonly host: { map: string; mutators: MutatorId[]; hostSide: Faction } | null;
  private readonly now: () => number;
  private readonly random: () => number;

  private nonce: number;
  /** The 8 s hint counts from here (construction or reset). */
  private startAt: number;
  private heardAny = false;
  private lastHeardAt = -Infinity;
  private peerHead: LobbyHeader | null = null;
  private versionError: PairingError | null = null;
  /** Arrival times of recent frames of another version (none while a peer is there). */
  private readonly mismatches: number[] = [];
  private failed = false;
  /** While failed: the nonce of the phone this one gave up on (its frames' `heard`; 0: none). */
  private gaveUpOn = 0;

  // the link: slots, pings and echoes, round trips, receive quality (round trips and rxq survive restarts)
  private readonly slots: number[] = [];
  /** When each ping value last went out (a slot's start), NaN: never. */
  private readonly sentAt = new Float64Array(256).fill(NaN);
  /** The newest frame built: its ping and rxq, whether it said GO, whether this phone had heard a peer then, and whether a slot has carried it yet. */
  private built: { ping: number; rxq: number; go: boolean; heard: boolean; carried: boolean } | null = null;
  /** The newest peer ping heard, and when (cleared with each new peer nonce). */
  private echo: { ping: number; at: number } | null = null;
  /** The (arrival − 10 × ping) of the peer's last pings, each at its first arrival, mod the ping's wrap. */
  private readonly offsets: number[] = [];
  /** When each peer ping value first arrived (NaN: not lately). */
  private readonly seenAt = new Float64Array(256).fill(NaN);
  private readonly rtts: number[] = [];
  private rxq = 0;
  private peerRxq: number | null = null;
  /** The rxq of this phone's last frames on the air (built since it first heard a peer), and the peer's last frames that heard this phone. */
  private readonly ownRxqs: number[] = [];
  private readonly peerRxqs: number[] = [];
  /** This phone's frames in a row at which both windows were full and didn't qualify for fast. */
  private slowRun = 0;

  // the pairing (a restart clears it)
  /** The peer's nonce, from its HELLO (0: none). */
  private peer = 0;
  private readonly retired: number[] = [];
  private hearsMe = false;
  /** When the peer's newest frame that heard this phone arrived. */
  private peerLiveAt = -Infinity;
  /** A phone that hears this phone, not the peer, and the pings of its packets heard since the peer's last live frame. */
  private challenger: { nonce: number; pings: number[] } | null = null;
  private restarts = 0;
  /** Host: the config of the newest frame, recent distinct offers, and the frozen one. */
  private offer: Agreed | null = null;
  private offers: Agreed[] = [];
  private frozen: Agreed | null = null;
  /** Guest: the host's config from its newest frame, with the host's hash; locked at GO. */
  private held: Agreed | null = null;
  private locked: Agreed | null = null;
  private agreedAt: number | null = null;
  private myPick: OpenerId | null = null;
  private picked = false;
  /** The peer's pick as its newest frame (or its GO) says it (null: not picked, as far as this phone knows). */
  private peerPick: { pick: OpenerId | null } | null = null;
  /** The peer's newest frame said picked = 1 under this phone's confHash: that hash. */
  private peerReady: number | null = null;
  private go = false;
  private theirs: OpenerId | null = null;
  private goSent = false;
  private peerGo = false;
  private peerStarted = false;
  private done: PairingResult | null = null;
  private offered: { key: string; blue: OpenerId[]; red: OpenerId[]; world: World } | null = null;

  constructor(o: PairingOptions) {
    checkField("build", o.build, 16);
    this.role = o.role;
    this.build = o.build;
    this.proto = o.proto ?? LOBBY_PROTO;
    checkField("proto", wireProto(this.proto), 4);
    this.nation = (o.role === "host" ? o.host?.nation : o.nation) ?? "classique";
    if (nationCode(this.nation) < 0) throw new RangeError(`no nation ${this.nation}`);
    this.plan = o.plan ?? "high";
    this.now = o.now;
    this.random = o.random;
    if (o.role === "host") {
      if (!o.host) throw new RangeError("the host needs a map and mutators to offer");
      for (const id of o.host.mutators) if (!isMutatorId(id)) throw new RangeError(`no mutator ${id}`);
      mapCode(o.host.map); // (throws if no frame can name it)
      // (as activeMutators() does: a mutator the map bans isn't played, so the config doesn't list it)
      const def = MAPS.find((m) => m.id === o.host!.map);
      const mutators = MUTATOR_IDS.filter((id) => o.host!.mutators.includes(id) && !(def && mapBansMutator(def, id)));
      this.host = { map: o.host.map, mutators, hostSide: o.host.hostSide ?? "blue" };
    } else this.host = null;
    this.nonce = this.draw();
    this.startAt = o.now();
  }

  // ------------------------------------------------------------- driving ---

  /** A packet started at `at` (link clock), carrying the newest frame built. */
  slot(at: number): void {
    pushKept(this.slots, at, SLOTS_KEPT);
    const b = this.built;
    if (b && !b.carried) {
      // (the first packet that carries a ping is the one the peer's echo times: a repeat doesn't move it)
      b.carried = true;
      this.sentAt[b.ping] = at;
    }
    if (b) {
      if (b.heard) {
        pushKept(this.ownRxqs, b.rxq, FAST_FRAMES);
        if (this.windowsFull()) this.slowRun = this.windowsFast() ? 0 : this.slowRun + 1;
      }
      if (b.go && this.go) this.goSent = true;
    }
    this.update();
    this.maybeStart();
  }

  /** The frame for the next packet: hand every one to transport.send() (key 0). */
  frame(): { bits: Uint8Array; nbits: number } {
    this.update();
    this.tryGo();
    const start = this.nextStart();
    const ping = Math.floor(start / 10) & 255;
    const active = !this.failed;
    let config: DuelConfig | null = null;
    if (this.role === "host" && active) {
      if (!this.frozen) this.offerNow();
      config = (this.frozen ?? this.offer)?.config ?? null;
    }
    const f: LobbyFrame = {
      role: this.role,
      proto: wireProto(this.proto),
      build: this.build,
      nonce: this.nonce,
      // (a failed phone names the phone it gave up on: that pairing alone starts over)
      heard: active ? this.peer : this.gaveUpOn,
      rxq: this.rxq,
      ping,
      echo: this.echo?.ping ?? 0,
      hold: this.echo ? Math.max(0, Math.min(HOLD_NONE, Math.round((start - this.echo.at) / 10))) : HOLD_NONE,
      config,
      confHash: active ? this.ownHash() : 0,
      pick: this.picked ? this.myPick : null,
      picked: this.picked,
      go: this.go,
      theirs: this.go ? this.theirs : null,
      ...(this.proto >= PROTO_NATIONS ? { nation: this.nation } : {})
    };
    this.built = { ping, rxq: this.rxq, go: this.go, heard: this.heardAny, carried: false };
    return writeLobbyFrame(f);
  }

  /** A packet from the link: lobby frames, and game frames (one under the session CRC means the peer has started). */
  receive(p: LinkPacket): void {
    this.update();
    if (this.done || p.nbits < 2 || !p.bits.length) return;
    const type = p.bits[0]! >> 6;
    if (type === 0b01) {
      if (p.session && this.go) {
        this.peerStarted = true;
        this.maybeStart();
      }
      return;
    }
    if (type !== TYPE_LOBBY) return;
    let head: LobbyHeader;
    try {
      head = readLobbyHeader(p.bits, p.nbits);
    } catch (e) {
      if (e instanceof CodecError) return;
      throw e;
    }
    // (a phone of this role is no peer: in the air two hosts, or two guests, can't hear each other at all)
    if (head.role === this.role) return;
    this.heardAny = true;
    this.lastHeardAt = p.at;
    if (head.proto !== wireProto(this.proto) || head.build !== this.build) {
      // (a phone of another version nearby, or a tape of one, can't end a pairing: while the peer is there it is
      // ignored, and before that it takes three of its frames within 5 s)
      if (this.peerLive(p.at)) return;
      this.peerHead = head;
      const ts = this.mismatches;
      if (ts[ts.length - 1] !== p.at) ts.push(p.at);
      while (p.at - ts[0]! > MISMATCH_WINDOW_MS) ts.shift();
      if (ts.length >= MISMATCH_FRAMES) this.mismatch(head);
      return;
    }
    let f: LobbyFrame;
    try {
      f = readLobbyFrame(p.bits, p.nbits);
    } catch (e) {
      this.peerHead = head;
      if (e instanceof CodecError) return;
      throw e;
    }
    // (a proto-1 phone ignores the extension it can't know of; the peer's protocol is what its frame shows)
    if (this.proto < PROTO_NATIONS) {
      delete f.nation;
      if (f.config) delete f.config.nations;
    }
    this.peerHead = { ...head, proto: f.nation !== undefined ? PROTO_NATIONS : head.proto };
    if (this.versionError || this.failed) {
      this.peerRxq = f.rxq;
      return;
    }
    this.lobby(f, p.at);
    this.update();
    this.tryGo();
    this.maybeStart();
  }

  /** This phone's receive quality of the peer (rxqOf(snrDb)); it rides along from the next frame. */
  setRxq(rxq: number): void {
    this.rxq = Math.max(0, Math.min(7, Math.floor(rxq) || 0));
  }

  /** The guest's plan, once it locks a host (the confHash covers it). */
  setPlan(plan: BandPlan): void {
    if (!this.go) this.plan = plan;
  }

  /** Pick an opener the config allows this phone's side. False if it isn't time to pick or the rules don't allow it. */
  pick(id: OpenerId): boolean {
    this.update();
    const a = this.agreed();
    if (!a || this.picked || this.failed || this.versionError || !this.offeredFor(a.config, this.sideOf(a.config)).includes(id)) return false;
    this.choose(id);
    return true;
  }

  /**
   * Start over with a fresh nonce: the retry tap after "Pairing failed", or
   * any restart the lobby wants. Hand frame() to the link at once: the frame
   * it holds is the old pairing's, maybe its GO, which the friend would
   * accept and start on alone.
   */
  reset(): void {
    this.restart(false);
    // (this phone's new nonce is what tells the peer's next incarnation apart now)
    this.retired.length = 0;
    this.failed = false;
    this.gaveUpOn = 0;
    this.versionError = null;
    this.mismatches.length = 0;
    this.done = null;
    this.nonce = this.draw();
    this.startAt = this.now();
    this.heardAny = false;
  }

  // ------------------------------------------------------------- reading ---

  state(): PairingState {
    this.update();
    const now = this.now();
    const a = this.agreed();
    const side = a ? this.sideOf(a.config) : null;
    const head = this.peerHead;
    const nonces = this.nonces();
    return {
      phase: this.phase(),
      role: this.role,
      nonce: this.nonce,
      heard: this.heardAny,
      sinceHeardMs: this.heardAny ? now - this.lastHeardAt : Infinity,
      peer: head && { ...head, nonce: this.peer, hearsMe: this.hearsMe },
      rtt: { median: median(this.rtts), samples: this.rtts.slice() },
      rxq: this.rxq,
      peerRxq: this.peerRxq,
      config: a ? copyConfig(a.config) : null,
      side,
      offered: a && side ? this.offeredFor(a.config, side).slice() : [],
      pick: this.myPick,
      picked: this.picked,
      peerPicked: this.peerPick !== null,
      pickLeftMs: this.agreedAt !== null && !this.picked ? Math.max(0, PICK_TIMEOUT_MS - (now - this.agreedAt)) : null,
      go: this.go,
      peerGo: this.peerGo || this.peerStarted,
      nonces: nonces && { host: nonces[0], guest: nonces[1] },
      error: this.versionError ?? (this.failed ? { kind: "failed", message: FAILED_MESSAGE } : null),
      hint:
        !this.heardAny && !this.done && now - this.startAt >= NOTHING_HEARD_MS ? { kind: "switch-role", message: NOTHING_HEARD_MESSAGE } : null,
      restarts: this.restarts
    };
  }

  /** The match, once both phones said GO (null until then). */
  result(): PairingResult | null {
    if (!this.done) return null;
    const r = this.done;
    const setup = { ...r.setup, mutators: r.setup.mutators.slice(), openers: { ...r.setup.openers }, ...(r.setup.nations ? { nations: { ...r.setup.nations } } : {}) };
    return { ...r, setup, config: copyConfig(r.config) };
  }

  // ---------------------------------------------------------- the frames ---

  /**
   * A lobby frame from a phone of the other role, same version. Decides
   * whether its nonce is this phone's peer (adopting, taking over, starting
   * over or ignoring), takes the link measurements and where the peer stands
   * from the newest frame, then what the frame says that is final once said.
   */
  private lobby(f: LobbyFrame, at: number): void {
    // a GO that doesn't name this phone's nonce is no GO here (another phone's, or for this phone before a reset),
    // but its sender still says hello: a phone whose GO is on the air must be able to meet the peer's next incarnation
    if (f.go && f.heard !== this.nonce) f = { ...f, go: false, theirs: null };
    if (f.nonce === 0) {
      // a phone that gave up names the phone it gave up on: that pairing alone starts over
      if (f.heard === this.nonce) this.peerGaveUp();
      return;
    }
    const was = this.peer;
    let introduced = false;
    if (f.nonce !== this.peer) {
      const retired = this.retired.indexOf(f.nonce);
      if (this.peer !== 0 && this.hearsMe) {
        // once the peer hears this phone, only a phone that hears this phone can take over (the peer's next
        // incarnation: it alone knows this phone's nonce); anything else is another phone, a recording, or old
        if (f.heard !== this.nonce) return;
        // (a nonce this phone left stays out while the peer it took is there)
        if (retired >= 0 && at - this.peerLiveAt < PEER_LIVE_MS) return;
        // a GO naming this phone from a nonce that isn't the peer's
        if (f.go) return this.fail(was);
        if (!this.challenge(f)) return;
        if (retired >= 0) this.retired.splice(retired, 1);
        pushKept(this.retired, this.peer, RETIRED_KEPT);
        this.restart(true);
      } else if (retired >= 0) return;
      // (a peer that doesn't hear this phone yet has nothing agreed to lose: the newest voice takes over, so two
      // phones that each first caught a recording still find each other)
      this.peer = f.nonce;
      introduced = true;
      // (another nonce may be another phone, with another clock)
      this.echo = null;
      this.offsets.length = 0;
      this.seenAt.fill(NaN);
    }
    const me = f.heard === this.nonce;
    if (me) this.hearsMe = true;
    // (before the hash is compared below: from here the host's own hash is the frozen one)
    if (this.role === "host" && !this.frozen && me && f.confHash !== 0) {
      const o = this.offers.find((x) => x.hash === f.confHash);
      if (o) this.frozen = o;
    }
    if (this.newest(f, at)) {
      this.echo = { ping: f.ping, at };
      this.peerRxq = f.rxq;
      if (me) {
        pushKept(this.peerRxqs, f.rxq, FAST_FRAMES);
        this.roundTrip(f, at);
        // (the peer is there: a challenger's count starts over)
        this.peerLiveAt = at;
        this.challenger = null;
      }
      this.peerNation = f.nation ?? null;
      // (the guest holds only a config that gives it the nation it asks for: an offer made before the host heard it is stale)
      if (this.role === "guest" && f.config && !this.locked && this.nationsFit(f.config)) this.held = { config: f.config, hash: f.confHash };
      // where the peer stands now: a peer that started over under the same nonce says so here, and its next pick
      // replaces the one it made before (only its GO, or this phone's own, commits a pick for the match)
      this.peerPick = me && f.picked ? { pick: f.pick } : null;
      this.peerReady = me && f.picked && f.confHash !== 0 && f.confHash === this.ownHash() ? f.confHash : null;
    }
    if (f.go && !this.peerGo) {
      // (it names this phone: other GOs lost theirs above)
      if (introduced || !this.goHolds(f)) return this.fail(was);
      this.peerGo = true;
      this.peerPick = { pick: f.pick };
      this.peerReady = f.confHash;
    }
  }

  /**
   * The peer's GO holds what this phone holds: this phone has picked, under
   * the config both hash the same; `theirs` is this phone's pick; the peer's
   * own pick is the one this phone committed to in its GO (before that, the
   * one the peer's newest frame said, or else this GO's: a GO is final) and
   * one the config allows the peer's side. Both phones check both picks, so
   * one that starts on the other's game frame starts the match the other
   * checked.
   */
  private goHolds(f: LobbyFrame): boolean {
    const a = this.agreed();
    if (!a || !this.picked || f.confHash !== a.hash || f.theirs !== this.myPick) return false;
    const held = this.go ? this.theirs : (this.peerPick ?? f).pick;
    if (f.pick !== held) return false;
    const allowed = this.offeredFor(a.config, other(this.sideOf(a.config)));
    return f.pick === null ? allowed.length === 0 : allowed.includes(f.pick);
  }

  /**
   * A phone that hears this phone but isn't its peer: does it take over? Once
   * TAKEOVER_FRAMES of its packets are heard with nothing live from the peer
   * in between. The peer's next incarnation (a reset, a reload) does that
   * within a few packets, as the old one has gone quiet; one damaged frame, or
   * a third phone that hears this phone while the peer is still heard, never
   * does.
   */
  private challenge(f: LobbyFrame): boolean {
    let c = this.challenger;
    if (c?.nonce !== f.nonce) c = this.challenger = { nonce: f.nonce, pings: [] };
    if (!c.pings.includes(f.ping)) c.pings.push(f.ping);
    return c.pings.length >= TAKEOVER_FRAMES;
  }

  /** The peer is there: a newest frame of it that hears this phone came within PEER_LIVE_MS. */
  private peerLive(at: number): boolean {
    return this.peer !== 0 && this.hearsMe && at - this.peerLiveAt < PEER_LIVE_MS;
  }

  /**
   * Is this the newest frame heard from the peer? It must be on time: its
   * arrival minus its ping (the sender's packet start) is within 150 ms of
   * the median of the peer's last frames', which a frame replayed late, or
   * one that rode a later packet than its stamp says, is not. And its ping
   * must be ahead of the echo's, unwrapped by the time between their
   * arrivals (so a long outage can't make a new frame look old): a duplicate
   * or an older frame delivered late is not.
   */
  private newest(f: LobbyFrame, at: number): boolean {
    const o = wrapDiff(at - 10 * f.ping);
    const m = median(this.offsets.map((x) => wrapDiff(x - o)));
    // (only a ping's first arrival says what on time is: replays and repeats of it would outvote the real frames)
    const seen = this.seenAt[f.ping]!;
    if (Number.isNaN(seen) || at - seen >= PING_WRAP_MS) {
      this.seenAt[f.ping] = at;
      pushKept(this.offsets, o, OFFSETS_KEPT);
    }
    if (m !== null && Math.abs(m) > ON_TIME_MS) return false;
    const e = this.echo;
    if (!e) return true;
    const d = (f.ping - e.ping) & 255;
    return d + 256 * Math.round(((at - e.at) / 10 - d) / 256) >= 1;
  }

  /** rtt = now − pingSentAt(echo) − hold, from a frame that hears this phone. */
  private roundTrip(f: LobbyFrame, at: number): void {
    if (f.hold >= HOLD_NONE) return;
    const sent = this.sentAt[f.echo]!;
    if (Number.isNaN(sent) || at - sent > ECHO_MAX_AGE_MS) return;
    const rtt = at - sent - 10 * f.hold;
    // (hold is rounded to 10 ms, so a round trip near zero — a relay, a loop with no latency — can read up to 5 ms
    // below it: at some phases every one does, and the host would never get the round trips it needs)
    if (rtt >= -HOLD_UNIT_MS) pushKept(this.rtts, Math.max(0, rtt), RTT_KEPT);
  }

  private mismatch(head: LobbyHeader): void {
    if (this.versionError) return;
    this.restart(false);
    const mine = wireProto(this.proto);
    const older = head.proto === mine ? null : head.proto < mine ? "friend" : "this";
    const which = older === "this" ? tr(" (celle de ce téléphone est plus ancienne)", " (this phone's is older)") : older === "friend" ? tr(" (celle de ton ami est plus ancienne)", " (your friend's is older)") : "";
    this.versionError = { kind: "version", older, message: VERSION_MESSAGE + which };
  }

  /** "Pairing failed": forget the peer, and send nonce 0 naming the phone given up on (`on`) until the retry tap, so that phone starts over too. */
  private fail(on: number): void {
    this.restart(false);
    this.failed = true;
    this.nonce = 0;
    this.gaveUpOn = on;
  }

  /**
   * The peer gave up ("Pairing failed" there, until its retry tap): start
   * over, under a fresh nonce, so a copy of its gave-up still on the air (or
   * replayed) names a nonce no longer in use and can't end the next pairing.
   */
  private peerGaveUp(): void {
    if (this.peer) pushKept(this.retired, this.peer, RETIRED_KEPT);
    this.restart(true);
    this.nonce = this.draw();
  }

  /** Forget the peer and everything agreed with it (`count`: a pairing under way restarted); the link measurements stay. */
  private restart(count: boolean): void {
    if (count && this.peer !== 0 && this.hearsMe) this.restarts++;
    this.peer = 0;
    this.hearsMe = false;
    this.peerLiveAt = -Infinity;
    this.challenger = null;
    this.offer = null;
    this.offers = [];
    this.frozen = null;
    this.held = null;
    this.locked = null;
    this.agreedAt = null;
    this.myPick = null;
    this.picked = false;
    this.peerPick = null;
    this.peerReady = null;
    this.go = false;
    this.theirs = null;
    this.goSent = false;
    this.peerGo = false;
    this.peerStarted = false;
    // (a GO frame still on the air was this pairing's: the next slot mustn't count it as sent)
    if (this.built) this.built.go = false;
  }

  // ------------------------------------------------------------ the deal ---

  /** [hostNonce, guestNonce] once both are known. */
  private nonces(): [number, number] | null {
    if (!this.peer || !this.nonce) return null;
    return this.role === "host" ? [this.nonce, this.peer] : [this.peer, this.nonce];
  }

  private hashOf(c: DuelConfig): number {
    const n = this.nonces();
    return n ? confHash(c, this.plan, n[0], n[1]) : 0;
  }

  /** The confHash this phone sends: its frozen or offered config (host), the config it holds from the host (guest); 0: none. */
  private ownHash(): number {
    if (this.role === "host") return (this.frozen ?? this.offer)?.hash ?? 0;
    if (this.locked) return this.locked.hash;
    return this.held ? this.hashOf(this.held.config) : 0;
  }

  /** The config both phones hold: the host's once frozen; the guest's once the host's hash is its own. */
  private agreed(): Agreed | null {
    if (this.role === "host") return this.frozen;
    if (this.locked) return this.locked;
    const h = this.held;
    if (!h) return null;
    const mine = this.hashOf(h.config);
    return mine !== 0 && mine === h.hash ? { config: h.config, hash: mine } : null;
  }

  /** Host: the config to offer now, once the guest hears it and D and fast have their data (null before). */
  private offerNow(): void {
    const h = this.host!;
    const rtt = median(this.rtts);
    if (!this.peer || !this.hearsMe || this.rtts.length < RTT_MIN || rtt === null || !this.windowsFull()) return;
    const fast = this.windowsFast();
    // (a receiver's first packets after lock read low: robust waits for them to leave the windows, see ROBUST_WAIT_FRAMES)
    if (!fast && this.slowRun <= ROBUST_WAIT_FRAMES) return;
    const config: DuelConfig = {
      mapId: h.map, mutators: h.mutators.slice(), delay: delayFor(rtt, packetMs(this.plan, fast ? "fast" : "robust")), hostSide: h.hostSide, fast
    };
    // nations (proto 2, a guest that speaks it): the host's, and the one the guest asks for (none: the host's rival)
    const ask = this.peerNation;
    if (this.proto >= PROTO_NATIONS && this.nation !== "classique" && ask !== null)
      config.nations = { host: this.nation, guest: ask !== "classique" ? ask : rivalOf(this.nation) };
    const hash = this.hashOf(config);
    this.offer = { config, hash };
    if (!this.offers.some((o) => o.hash === hash)) {
      this.offers.push(this.offer);
      if (this.offers.length > OFFERS_KEPT) this.offers.shift();
    }
  }

  /** Both rxq windows hold FAST_FRAMES frames. */
  private windowsFull(): boolean {
    return this.ownRxqs.length >= FAST_FRAMES && this.peerRxqs.length >= FAST_FRAMES;
  }

  /** Every frame in both windows reports FAST_RXQ or better. */
  private windowsFast(): boolean {
    return this.ownRxqs.every((q) => q >= FAST_RXQ) && this.peerRxqs.every((q) => q >= FAST_RXQ);
  }

  /** Guest: does a host's config give this phone the nation it asks for (any, when it asks for none)? */
  private nationsFit(c: DuelConfig): boolean {
    return this.nation === "classique" || !c.nations || c.nations.guest === this.nation;
  }

  private sideOf(c: DuelConfig): Faction {
    return this.role === "host" ? c.hostSide : other(c.hostSide);
  }

  /** The openers a side may pick under a config: those not blocked in setupWorld({ map, seed, mutators, openers: {} }). */
  private offeredFor(c: DuelConfig, side: Faction): OpenerId[] {
    return this.offeredWorld(c)[side];
  }

  private offeredWorld(c: DuelConfig): { blue: OpenerId[]; red: OpenerId[]; world: World } {
    const n = this.nonces()!;
    const seed = matchSeed(n[0], n[1]);
    const nations = configNations(c);
    const key = `${c.mapId}|${seed}|${c.mutators.join(",")}|${nations ? `${nations.blue},${nations.red}` : ""}`;
    if (this.offered?.key !== key) {
      const world = setupWorld({ map: c.mapId, seed, mutators: c.mutators.slice(), openers: {}, ...(nations ? { nations } : {}) });
      const allowed = (side: Faction) => OPENER_IDS.filter((id) => !openerBlocked(world, side, id));
      this.offered = { key, blue: allowed("blue"), red: allowed("red"), world };
    }
    return this.offered;
  }

  /** The config is agreed on this phone: the opener cards go up (none allowed: "none" is picked at once). */
  private agree(a: Agreed): void {
    this.agreedAt = this.now();
    if (!this.offeredFor(a.config, this.sideOf(a.config)).length) this.choose(null);
  }

  private choose(id: OpenerId | null): void {
    this.myPick = id;
    this.picked = true;
    this.tryGo();
  }

  /** The config just agreed (the cards go up, the 20 s start), and the pick timeout. */
  private update(): void {
    if (this.done || this.failed || this.versionError) return;
    const a = this.agreed();
    if (!a) return;
    if (this.agreedAt === null) this.agree(a);
    if (this.picked || this.now() - this.agreedAt! < PICK_TIMEOUT_MS) return;
    this.choose(allowedOpener(this.offeredWorld(a.config).world, this.sideOf(a.config), OPENER_IDS[0]!));
  }

  /** GO once this phone has picked and holds a peer frame with its own hash and a final pick the config allows. */
  private tryGo(): void {
    if (this.go || !this.picked || this.failed || this.versionError || !this.peerPick) return;
    const a = this.agreed();
    if (!a || this.peerReady !== a.hash) return;
    const theirs = this.peerPick.pick;
    const allowed = this.offeredFor(a.config, other(this.sideOf(a.config)));
    // (two phones of one build offer the same openers: anything else is garbage, and GO waits)
    if (theirs === null ? allowed.length > 0 : !allowed.includes(theirs)) return;
    this.go = true;
    this.theirs = theirs;
    if (this.role === "guest") this.locked = a;
  }

  private maybeStart(): void {
    if (this.done || !this.go || !this.goSent || !(this.peerGo || this.peerStarted)) return;
    const a = this.agreed()!;
    const [hostNonce, guestNonce] = this.nonces()!;
    const local = this.sideOf(a.config);
    // (blue's first on both phones, so anything that serializes the setup writes the same bytes)
    const openers: MatchSetup["openers"] = {};
    for (const side of SIDES) {
      const id = side === local ? this.myPick : this.theirs;
      if (id) openers[side] = id;
    }
    const config = copyConfig(a.config);
    const nations = configNations(config);
    this.done = {
      role: this.role,
      local,
      setup: { map: config.mapId, seed: matchSeed(hostNonce, guestNonce), mutators: config.mutators.slice(), openers, ...(nations ? { nations } : {}) },
      delay: config.delay,
      fast: config.fast,
      hostNonce,
      guestNonce,
      plan: this.plan,
      mapId: config.mapId,
      config
    };
  }

  private phase(): PairingPhase {
    if (this.versionError) return "error";
    if (this.failed) return "failed";
    if (this.done) return "started";
    if (this.go) return "go";
    if (this.agreed()) return this.picked ? "waiting" : "picking";
    return this.heardAny ? "linking" : "listening";
  }

  // ------------------------------------------------------------ the link ---

  /** The start of the packet the next frame rides: the last slot plus the period, or later if that has passed. */
  private nextStart(): number {
    const now = this.now();
    const n = this.slots.length;
    if (!n) return now;
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(this.slots[i]! - this.slots[i - 1]!);
    const m = median(gaps);
    const period = m !== null && m > 0 ? m : PERIOD_GUESS_MS;
    const last = this.slots[n - 1]!;
    return last + period * Math.max(1, Math.ceil((now - last) / period));
  }

  /** A nonce, uniform in 1…65535. */
  private draw(): number {
    const n = 1 + Math.floor(this.random() * 65535);
    return n >= 1 && n <= 65535 ? n : 1;
  }
}
