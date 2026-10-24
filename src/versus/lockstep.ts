/**
 * Lockstep for sound duels (SOUND-DUEL.md "Lockstep"): both phones run the
 * whole sim, and only the players' orders cross the air. A turn is one tick;
 * before stepping tick t a phone seals its own turn t + D, and it steps t only
 * once it holds the peer's turn t. The phone that is ahead stalls, so the two
 * never need a shared clock, and a lost packet can only stall the match,
 * never fork it.
 *
 * Frames are latest-state: together they re-describe every turn the peer
 * hasn't acknowledged, and the transport repeats them until they're replaced,
 * so there's no ARQ. The unacknowledged turns are cut into at most K segments
 * of consecutive turns, one frame each, keyed by the segment's start turn; the
 * transport sends one frame per packet in key rotation (transport.ts
 * nextFrameIndex). With no burst in flight that is one frame repeated, plain
 * latest state; a burst of orders goes out a frame per segment each rotation
 * instead of one frameful per round trip, as far as the peer's slack affords
 * (the slack gate, below). The window rule seals no more into a turn than the
 * segments can still carry, which, with the codec's split rule and a capacity
 * of at least minCapacity(D), means no command can ever be stranded. The receiver keeps turns from frames that
 * arrive out of order, so a lost packet costs one rotation. A hash trail of the
 * world, checked every 50 ticks and at the end, catches two phones drifting
 * apart.
 *
 * Segments (SOUND-DUEL.md "Segments and rotation"): a newly sealed turn joins
 * the newest segment while that segment's frame still fits with its header at
 * its bounds (tickLag in [−D−1, D], ack in [−2D−1, 3D+1], span up to 2D + 1)
 * and the 21-bit checkpoint reserve; otherwise it starts a new segment. An ack
 * only trims the oldest segment's `from` or drops whole segments, so a frame
 * never grows once its segment is cut, and every frame always fits: no turn is
 * ever left out of every frame.
 *
 * The slack gate (a deviation: the spec has K = clamp(D − 2, 1, 4) alone). The
 * newest turns ride the newest segment, which goes out once a rotation, so
 * every segment beyond the first holds them back up to a packet longer. Pairing
 * picks D with about half a tick of margin (pairing.ts delayFor; at the time
 * of these measurements, ceil((rtt / 2 + 150 ms) / 100 ms)), so a fixed K of
 * D − 2 makes the peer stall: in two-world AI duels over PacketAir
 * (250 ms, D = 5, five minutes) K = 3 stalled the two phones 160 and 36 ms in
 * fast mode where K = 1 stalled neither, 11.7 and 9.6 s in robust mode against
 * 16 and 0 ms, and 5.6 and 6.0 s at 10% loss against 0.8 and 0.5 s. So K is
 * only the cap: a turn starts another segment only while the lowest slack the
 * peer reported in its last 16 frames (the turns of this phone's it held beyond
 * its tick) covers one more packet of delay per segment beyond the first, with
 * a tick to spare. The packet period is this phone's own transmit period
 * (setPacketMs): modes are per direction, and it is this phone's rotation that
 * holds its turns back. Until the session gives one, it is the shortest gap
 * between the peer's newest arrivals, which is the same while both phones run
 * the mode the pairing started them in, and the other direction's once they
 * don't: fast one way and robust the other (300 ms, D = 8, AI orders with
 * 30-unit bursts every 10 s, three seeds) the robust sender read 100 ms and
 * opened three segments, and the fast one stalled up to 48 ms where K = 1 and
 * each phone's own period stalled neither. Only a full window of 16 counts,
 * started over by a pause on either phone, by a stall here and by a new
 * period: the peer's slack runs high while it is behind this phone (at the
 * start, both hold turns 0 … D − 1; while either is paused or this one stalls;
 * and for seconds after, while the speed trim lets it catch up), and read off
 * such frames the gate opened and the peer stalled; and what it reported of
 * one mode's packets says nothing of the other's. Where D leaves room (two or
 * more above what pairing picks: D = 6 at 250 ms in fast mode, D = 8 at 300 ms
 * in robust) the gate opens and bursts land sooner at no stall; at the D
 * pairing picks it stays shut (in none of 15 five-minute runs per condition, AI
 * orders with 30-unit bursts every 5 s, 150–550 ms, fast and robust, at 0% and
 * 10% loss, burst loss, periodic loss and pauses, did it open), and the match
 * runs exactly as with K = 1.
 *
 * Rotation under loss (also beyond the spec). In rotation a lost packet costs
 * the newest turns a whole rotation rather than a packet, and the gate can't
 * see loss coming. So the first time the peer stalls during a rotation, or
 * within 2D ticks of one (a turn's input delay and its trip), no new segment is
 * started for the rest of the match. Two D above pairing's, in fast mode with
 * 30-unit bursts every 5 s, five minutes, against K = 1: burst loss
 * (Gilbert–Elliott, 2%/30%) +449 ms of stall on average over 15 runs without
 * this, +272 with it; 10% loss +52 and −1 ms; at 0% loss nothing changes (the
 * peer never stalls), and order delay falls by 5 ticks a phone. It can't reach
 * K = 1's stall under loss: the rotation the first stall ends has cost it
 * already. And the rotation is strictly periodic, so a loss with its period (an
 * interferer killing every n-th packet) can take the same segment's frame every
 * time round: the peer stalls on it, so this phone stalls, peerAck stays put
 * and the list never changes, for ever. When the peer has starved for the
 * oldest segment (its newest frame says it is stalled, so on peerAck + 1)
 * longer than a rotation and a round trip should take, that frame goes alone in
 * every packet until the peer holds it (starving()).
 *
 * The speed trim (SOUND-DUEL.md "Pacing") compares like with like: this
 * phone's slack as its newest packet said it (slot(): the frames last handed
 * out before that packet started), not as it is now, with the peer's as its
 * newest frame said it. Each is the other phone's view of it, a copy delayed
 * by the link, so the two speeds sum to 2 on average and the match runs at 1×.
 * A frame says the slack as it is when the frame is built, at a seal (before
 * the step moves the tick on) or when turns arrive: near the top of the
 * sawtooth the slack draws between arrivals. Read live against that, each
 * phone saw its friend ahead and both slowed: over PacketAir (fast and robust,
 * both plans, 150–400 ms, six seeds each) matches ran 0.3–1.5% slow (9.85–9.97
 * ticks a second), over RoomLink 0.8–1.1%; now 9.995–10.001 (RoomLink 9.9997,
 * which is its clocks' ppm). Comparing with the newest frame built rather than
 * the one on the air overshot where a packet carries several builds (the low
 * plan's 400 ms robust packets: 1.6–2.9% fast). The cost: the phones now
 * balance their slack as their packets sample it, which sits off its average
 * by up to half a packet's turns, by where each phone's packet starts fall in
 * its sawtooth, so the slack they keep can differ by that much (the live
 * comparison halved it, and paid for it in speed). At the D pairing picks
 * that cost nothing to speak of where D covers the link (PacketAir, 150–400
 * ms, 100–400 ms packets, six seeds each: 197 ms of stall in 21,600 s of
 * play against 835 before); where it doesn't (the low plan's robust mode, D
 * capped at 8, which stalls 5–7% over the modem however it is paced) it moved
 * stall from one phone to the other run by run, 9% more in all (six RoomLink
 * runs: 117 s against 107).
 *
 * Engine-free: no DOM, no timers, no randomness; the clock is injected.
 *
 *   const ls = new Lockstep({ local, delay, mapWidth, mapHeight, capacity, setupHash: parseInt(worldHash(w), 16), now });
 *   each time the game wants to step tick t = w.tick:
 *     const cmds = ls.commandsFor(t, () => ctrl.drainCommands())  // seals turn t + D (once per tick); null: stall
 *     if (cmds) { step(w, cmds); ls.afterStep(t, parseInt(worldHash(w), 16), w.winner ? { winner: w.winner, resigned: w.resigned } : null) }
 *   for each packet:  ls.receive(p.bits, p.nbits, p.at)
 *   for each packet start (the link's slots()):  ls.slot(at)
 *   then:             const f = ls.frames(); if (f.version !== sent) { transport.send(f.frames); sent = f.version }
 *   ls.setPaused(b), ls.setRxq(rxqOf(snrDb)), ls.setPacketMs(own transmit period), ls.leave("left" | "desync"), ls.speed(), ls.status(), ls.turns()
 *
 * Game frame, MSB-first (UE/SE: Exp-Golomb, codec.ts):
 *
 *   type 2 (01)  paused 1  end 2 (0 playing, 1 left, 2 desync, 3 decided)  rxq 3  to 16 (mod 65536)
 *   span UE (to − from)  tickLag SE (to − current tick)  ack SE (ackThrough − to)  nonEmpty UE
 *     per non-empty turn, ascending: gap UE (from the previous + 1, or from `from`), count UE (− 1), commands
 *   hash 1 [hashIdx 4 (checkpoint tick / 50 mod 16), trail 16]
 *   if end = 3: endTick 16, endTrail 16
 *
 * Where the spec is silent:
 *  - once this phone's world is decided at T, its frames describe its turns
 *    past T as empty: no phone ever steps one (a phone in sync is decided at T
 *    too, and one that isn't learns of the decision from the frame that carries
 *    turn T and desyncs after stepping it). So the end report always fits once
 *    the peer holds turn T. Until then the newest segment's frame, when it
 *    can't carry the report as well as its oldest unacknowledged turn, says
 *    end = 0 for the moment: the turns come first, since the peer needs turn T
 *    to check the end. It makes room for the report by dropping its checkpoint
 *    first, then its newest turns (they go out once acks arrive);
 *  - the end report (and so end = 3) rides only in the newest segment's frame;
 *    the others say end = 0 meanwhile. left and desync ride in every frame.
 *    While the oldest segment's frame goes alone (the peer starving for it),
 *    the report waits with the newest turns: the turns come first;
 *  - a segment's key is its start turn as cut, which acks never change: had
 *    trimming the oldest segment moved its key past the last one sent, the
 *    rotation would send that segment twice running;
 *  - tickLag and ack are written clamped to their bounds, which honest frames
 *    never leave (ackThrough ≥ tick − 1 and to ≤ tick + D, so ack can only be
 *    clamped from above, understating what this phone holds: safe). So a frame
 *    can't outgrow the bits its segment was cut for, even after a garbage
 *    frame that slipped past the CRC;
 *  - the span field is counted at its bound too: with an honest peer the
 *    window peerAck + 1 … newestSealed spans at most 2D + 2 turns (the frame
 *    that brought ackThrough to A said the peer held this phone's turns
 *    through A − D − 1 at least, and newestSealed ≤ ackThrough + D + 1), so the
 *    empty turns sealed into the newest segment never outgrow its frame. Only
 *    after a garbage frame stretched the window can an empty turn start a
 *    segment past K: a turn can't be refused;
 *  - the receiver takes turns from a frame whose `from` is at most 128 turns
 *    past its ackThrough (SOUND-DUEL.md "Receiving out of order"), each turn
 *    once: whatever it holds, below ackThrough or past it, it never replaces.
 *    lastNewTurnAt moves when ackThrough does (what a stall waits for), not
 *    when a turn arrives that can't be stepped yet;
 *  - checkpoints are taken after stepping ticks 0, 50, 100…, so the first one
 *    also covers the setup world;
 *  - `to` is unwrapped against ackThrough, which only accepted turns move,
 *    rather than the newest `to` heard: then only real progress moves the
 *    expectation, and a garbage frame that slipped past the CRC can't drag it
 *    out of reach of the real ones;
 *  - receive also rejects a frame with a turn past `to`, a turn of more than
 *    15 commands, or a `from` below 0: no sender writes one;
 *  - the end check is final once it's "ok", "mismatch" or "unverified" (a
 *    late reply doesn't flip a report already shown), but a desync the peer
 *    reports (end = 2) always ends the match as one, and a decided phone that
 *    learns of a desync any way reports the end check as "mismatch";
 *  - leave("left") after a desync still says desync: it's the truer reason.
 *
 * Deviations from the spec's plain FIFO queue (the window rule lets only a few
 * full commands out per round trip, so a player re-ordering a big army every
 * couple of seconds would otherwise queue orders for tens of seconds):
 *  - a resign goes to the front of the queue: it lands D ticks later, as the
 *    spec says, whatever is waiting;
 *  - a newer move or attackMove replaces queued (not yet sealed) move,
 *    attackMove, attack, harvest, stop, waypoint and patrol orders, a newer attack replaces
 *    queued attacks, and a newer stop queued stops, when it names every unit
 *    of the queued one and nothing queued in between names any of them. The
 *    sim gives each named unit the newer order outright, so the queued one
 *    would only have been overridden on arrival (see enqueue). Of the newer
 *    order's pieces, those whose units have waited longest go first, so that
 *    while orders come faster than the link carries them, no unit waits for
 *    ever behind the rest. It happens on the sender before encoding, so it
 *    can't desync anything.
 *
 * The one exception to "outright" is the one the split rule has too: a Goliath
 * whose lift is still hooking on follows an order only when its Condors are
 * named in the same command. The sim lets pieces of one order sealed in the
 * same turn act as the whole order did (a Goliath that ignored one remembers
 * it for the rest of the tick: lift.ts HeldLiftOrders). But even an idle
 * window takes at most 109–115 bits of commands into a turn (113 at D = 5),
 * and the pieces of one split order add up to more, so they practically never
 * share a turn: they land a tick or more apart, and a hooking Goliath named in
 * an earlier piece than its Condors still waits for them.
 */
import { composeTick } from "../game/local-side";
import type { OutFrame } from "../link/transport";
import type { Command, Faction } from "../sim/types";
import {
  BitReader, BitWriter, C_MAX, CodecError, canonicalize, commandBits, decodeCommands, encodeCommand, seBits, ueBits, type MapSize
} from "./codec";

/** Ticks between checkpoints (5 s). */
export const CHECKPOINT_EVERY = 50;
/** Own checkpoints kept to compare with the peer's. */
export const CHECKPOINTS_KEPT = 8;
/** The most header bits a frame describing one turn can take (tickLag and ack within their bounds, D ≤ 8). */
export const HEADER_MAX = 57;
/** Commands in one turn at most (its count is UE(count − 1) ≤ 7 bits). */
export const TURN_COMMANDS_MAX = 15;
/** A frame describes at most this many turns past `from`. */
export const SPAN_MAX = 64;
/** A frame whose `to` is further than this from ackThrough is garbage. */
export const TO_JUMP_MAX = 200;
/** The receiver takes turns from a frame whose `from` is at most this far past its ackThrough (segments arrive out of order). */
export const AHEAD_MAX = 128;
/** No reply to the end check for this long: "Not verified". */
export const END_CHECK_MS = 10_000;
/** The trail starts here (FNV-1a's offset basis), and folds each tick's world hash in. */
export const TRAIL_START = 0x811c9dc5;

const FIXED_BITS = 2 + 1 + 2 + 3 + 16;
/** The hash flag, plus hashIdx and the trail's low 16 bits when a checkpoint rides along. */
const CHECKPOINT_BITS = 1 + 4 + 16;
const END_REPORT_BITS = 16 + 16;

/**
 * The header fields a segment's frame is cut for at input delay D, at their
 * bounds (SOUND-DUEL.md "Bounds"): tickLag in [−D−1, D], ack in [−2D−1,
 * 3D+1], and the span, which reaches 2D + 1 with an honest peer (the frame
 * that brought ackThrough to A was sent at the peer's tick A − D or later, and
 * said it held this phone's turns through A − D − 1 at least; and
 * newestSealed ≤ tick + D ≤ ackThrough + 1 + D).
 */
function headerBounds(D: number) {
  const bound = (min: number, max: number) => ({ min, max, bits: Math.max(seBits(min), seBits(max)) });
  return { lag: bound(-D - 1, D), ack: bound(-2 * D - 1, 3 * D + 1), span: 2 * D + 1 };
}

/**
 * The smallest capacity the window rule always makes progress in at input
 * delay D: the largest single command (C_MAX) alone in the window. Even then
 * the window holds the empty turns latency leaves unacknowledged, so the
 * command joins the newest segment with its gap and the span at their bound,
 * the header at its bounds and the checkpoint reserve: 175 bits at D = 3 to
 * 183 at D = 8. (A window this phone's turns never leave can't start a
 * segment of its own: that waits for every turn before it to be acknowledged.)
 * Real links carry 186 or 188.
 */
export const minCapacity = (delay: number): number => {
  const b = headerBounds(delay);
  return FIXED_BITS + ueBits(b.span) + b.lag.bits + b.ack.bits + ueBits(1) + ueBits(b.span) + ueBits(0) + C_MAX + CHECKPOINT_BITS;
};

/**
 * Segments of unacknowledged turns at most (SOUND-DUEL.md "K"): rotation adds
 * up to K − 1 packets to the time the newest turn waits for the air. This is
 * the cap; the slack gate (see the header) decides how many it can afford.
 */
export const segmentsFor = (delay: number): number => Math.max(1, Math.min(4, delay - 2));
/** The slack gate looks at the lowest slack the peer reported in this many of its newest frames. */
export const SLACK_FRAMES = 16;
/** Ticks of slack the gate keeps in hand beyond the rotation it allows. */
const SLACK_SPARE = 1;
/** Until setPacketMs, the packet period is the shortest gap between the arrivals of this many newest game frames. */
const ARRIVALS_KEPT = 8;
/** The packet period starving() assumes before setPacketMs or the peer's arrivals give one (robust mode's, the longer). */
const ROBUST_PERIOD = 200;
/** Frame lists remembered for slot() (a few a tick, a packet's worth or so; more only while nothing reports slots). */
const HANDED_KEPT = 32;

export const foldTrail = (trail: number, worldHash32: number): number => Math.imul(trail ^ worldHash32, 0x01000193) >>> 0;

/** Receive quality in 3 bits, for game and lobby frames: clamp(floor(effective SNR dB / 3), 0, 7). */
export const rxqOf = (snrDb: number | null): number =>
  snrDb === null || Number.isNaN(snrDb) ? 0 : Math.max(0, Math.min(7, Math.floor(snrDb / 3)));

export type EndState = "playing" | "left" | "desync" | "decided";
const END_CODES: readonly EndState[] = ["playing", "left", "desync", "decided"];

/** The end check, once this phone's world is decided: "pending" until the peer's end report arrives (or before the end). */
export type EndCheck = "pending" | "ok" | "mismatch" | "unverified";

export interface Decision {
  winner: Faction | "draw";
  resigned?: Faction | null;
}

export interface LockstepOptions {
  /** The side this phone commands. */
  local: Faction;
  /** Input delay D in ticks, 3–8, fixed for the match. */
  delay: number;
  mapWidth: number;
  mapHeight: number;
  /** Payload bits per packet (LinkTransport.capacity()). */
  capacity: number;
  /** parseInt(worldHash(setup world), 16): folded into the trail before tick 0. */
  setupHash: number;
  /** Monotonic milliseconds (the link's clock). */
  now: () => number;
  /** K, the segments (frames in the rotation) the window rule allows at most; default segmentsFor(delay). 1: one frame, plain latest state. */
  segmentsMax?: number;
}

export interface LockstepStatus {
  /** The tick this phone steps next. */
  tick: number;
  delay: number;
  /** The last commandsFor() stalled waiting for a peer turn. */
  stalled: boolean;
  /** Time spent stalled so far. */
  stallMs: number;
  /** ackThrough − tick: the peer turns held beyond the one about to be stepped. */
  slack: number;
  /** The peer's slack from its newest frame (ack + tickLag); null before one arrives. */
  peerSlack: number | null;
  paused: boolean;
  peerPaused: boolean;
  /** The newest packet from the peer was a lobby frame: it is still loading. */
  peerInLobby: boolean;
  end: EndState;
  peerEnd: EndState;
  /** Commands drained but not sealed yet (they wait for acks to shrink the window). */
  queued: number;
  /** Ticks the oldest of them (or the order it replaced) has waited: the HUD shows "Orders queued" past 20 (2 s). */
  queuedTicks: number;
  newestSealed: number;
  /** The peer turns this phone holds, contiguous. */
  ackThrough: number;
  /** This phone's turns the peer holds. */
  peerAck: number;
  /** When a new peer turn last arrived (the stall overlays count from it), on the injected clock. */
  lastNewTurnAt: number;
  /** When the peer's frames last stopped saying paused (−Infinity: never): it owed no turn before (the session's waiting.ms). */
  peerResumedAt: number;
  desync: boolean;
  /** How the desync was found: a checkpoint, the end check, the peer's word (end = 2), or leave("desync"). */
  desyncReason: "checkpoint" | "end" | "peer" | "local" | null;
  endCheck: EndCheck;
  /** This phone's decided world: the tick it was decided on, and how. */
  decided: (Decision & { tick: number }) | null;
  /** The peer's receive quality of this phone (0–7), from its newest frame. */
  peerRxq: number | null;
  framesIn: number;
  /** Game frames rejected (codec errors, bounds). */
  framesBad: number;
  /** Mean ticks from an order being drained (or the queued one it replaced) to the turn it was sealed in; null before any. */
  orderDelay: number | null;
  /**
   * What a player feels of it: real time (the link's clock) from each command
   * being drained (the tick after its tap; for one that replaced queued
   * orders, the oldest of theirs, as orderDelay counts) to this phone stepping
   * the turn it was sealed in, so the queue's wait and every stall on the way
   * count. This phone's own pause doesn't (a player doesn't feel the pause
   * menu as a slow order), as stallMs leaves it out; a friend's pause stalls
   * this phone, and counts in both. Each piece of a split order counts once.
   * Mean and worst (ms); null before any. (A tap made during a stall waits in
   * the Controller until the stall ends, unseen here.)
   */
  orderWait: { meanMs: number; worstMs: number } | null;
  /** Frames in the rotation: the segments with unacknowledged turns (1 when there are none). */
  segments: number;
}

/** One game frame as read off the air (ticks unwrapped against what the receiver expects). */
export interface GameFrame {
  paused: boolean;
  end: EndState;
  rxq: number;
  from: number;
  to: number;
  tickLag: number;
  ack: number;
  /** Non-empty turns only, ascending, stamped with the sender's side. */
  turns: [number, Command[]][];
  checkpoint: { idx: number; trail16: number } | null;
  endReport: { tick16: number; trail16: number } | null;
}

/** The value ≡ v (mod 65536) nearest `expect`. */
export const unwrap16 = (v: number, expect: number): number => {
  let d = (v - expect) & 0xffff;
  if (d >= 0x8000) d -= 0x10000;
  return expect + d;
};

/**
 * Read a game frame (type 01). `expectTo` is the `to` the receiver expects
 * (its ackThrough). Throws CodecError on anything malformed: the whole frame
 * is rejected.
 */
export function readGameFrame(bits: Uint8Array, nbits: number, map: MapSize, sender: Faction, expectTo: number): GameFrame {
  const rd = new BitReader(bits, nbits);
  if (rd.bits(2) !== 1) throw new CodecError("not a game frame");
  const paused = rd.bit() === 1;
  const end = END_CODES[rd.bits(2)]!;
  const rxq = rd.bits(3);
  const to = unwrap16(rd.bits(16), expectTo);
  if (Math.abs(to - expectTo) > TO_JUMP_MAX) throw new CodecError(`to ${to} is too far from ${expectTo}`);
  const span = rd.ue();
  if (span > SPAN_MAX) throw new CodecError(`span ${span}`);
  const from = to - span;
  if (from < 0) throw new CodecError(`from ${from}`);
  const tickLag = rd.se();
  const ack = rd.se();
  const nonEmpty = rd.ue();
  if (nonEmpty > span + 1) throw new CodecError(`${nonEmpty} non-empty turns in ${span + 1}`);
  const turns: [number, Command[]][] = [];
  let next = from;
  for (let i = 0; i < nonEmpty; i++) {
    const turn = next + rd.ue();
    if (turn > to) throw new CodecError(`turn ${turn} is past to ${to}`);
    const count = rd.ue() + 1;
    if (count > TURN_COMMANDS_MAX) throw new CodecError(`${count} commands in a turn`);
    turns.push([turn, decodeCommands(rd, count, map, sender)]);
    next = turn + 1;
  }
  const checkpoint = rd.bit() ? { idx: rd.bits(4), trail16: rd.bits(16) } : null;
  const endReport = end === "decided" ? { tick16: rd.bits(16), trail16: rd.bits(16) } : null;
  return { paused, end, rxq, from, to, tickLag, ack, turns, checkpoint, endReport };
}

interface Sealed {
  /** The decoded form: what both phones step. */
  cmds: Command[];
  /** Its encoding, copied into every frame that describes the turn. */
  bits: Uint8Array;
  nbits: number;
  /** When each of its commands was drained (the link's clock), as the order wait counts from: see LockstepStatus.orderWait. */
  drainedAt?: number[];
}

const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

type CommandType = Command["type"];
const MOVE_REPLACES: ReadonlySet<CommandType> = new Set(["move", "attackMove", "attack", "harvest", "stop", "waypoint", "patrol", "march"]);
/**
 * The queued orders a newer one of each type replaces outright, unit by unit
 * (sim.ts applyCommand). A move or attackMove resets everything those set:
 * the order, the path, the auto-target, a lift's destination, a route's
 * waypoints or a patrol (sim/route.ts), and it packs an anchored Goliath up.
 * A waypoint or patrol replaces nothing: it adds to the order before it. An
 * attack sets less than a move (no auto-target reset, nothing for a unit on a
 * lift), so it replaces only attacks, and a stop (no pack-up) only stops. A harvest replaces nothing: the sim skips it off a
 * resource field or for a unit that isn't a harvester.
 */
const REPLACES: Partial<Record<CommandType, ReadonlySet<CommandType>>> = {
  move: MOVE_REPLACES,
  attackMove: MOVE_REPLACES,
  march: MOVE_REPLACES,
  attack: new Set(["attack"]),
  stop: new Set(["stop"])
};

/** Every unit a command names: its unit list, and a Condor boarded or a Goliath lifted. */
function namedUnits(c: Command): number[] {
  const ids = "unitIds" in c ? c.unitIds.slice() : [];
  if (c.type === "board") ids.push(c.carrierId);
  if (c.type === "lift") ids.push(c.goliathId);
  return ids;
}

export class Lockstep {
  readonly local: Faction;
  readonly peer: Faction;
  readonly delay: number;
  readonly capacity: number;
  /** Bits of commands one turn can hold: TURN_MAX = capacity − 57, so a one-turn frame always fits. */
  readonly turnMax: number;
  /** K: segments with unacknowledged turns at most (frames in the rotation). */
  readonly segmentsMax: number;
  private readonly map: MapSize;
  private readonly now: () => number;
  /** tickLag's and ack's bounds (SOUND-DUEL.md "Bounds"): frames write them clamped, and the window rule counts their widest codes. */
  private readonly lag: { min: number; max: number; bits: number };
  private readonly ackBound: { min: number; max: number; bits: number };
  /** The widest span a segment's frame reaches with an honest peer: 2D + 1 (headerBounds). */
  private readonly spanBound: number;

  private tick = 0;
  private newestSealed: number;
  private ackThrough: number;
  private peerAck: number;
  private trailValue: number;
  /** Own sealed turns (turns 0 … D−1 are empty and never stored). */
  private readonly mine = new Map<number, Sealed>();
  /** Everything below this has been pruned from `mine`. */
  private pruned = 0;
  /**
   * The segments' start turns, ascending: each is one frame, keyed by it. A
   * segment runs to the next one's start − 1, the newest to newestSealed.
   * Cut when turns are sealed; acks only drop whole segments from the front
   * (trim), and frames start at peerAck + 1 within the oldest.
   */
  private readonly segs: number[];
  /** The peer's non-empty turns not yet stepped (past ackThrough too, from frames that came out of order). */
  private readonly theirs = new Map<number, Command[]>();
  /** Peer turns past ackThrough this phone holds already, empty or not: ackThrough runs through them once the gap fills. */
  private readonly ahead = new Set<number>();
  /**
   * Canonical commands waiting to be sealed, with the tick they were drained
   * on. One that took over orders it replaced keeps, per unit, when that unit
   * started waiting (`since`), and `at` is the oldest of those.
   */
  private readonly queue: { command: Command; at: number; since?: ReadonlyMap<number, number> }[] = [];

  private paused = false;
  private rxq = 0;
  private endState: EndState = "playing";
  private decision: (Decision & { tick: number; trail: number }) | null = null;
  private decidedAt = 0;
  private endCheck: EndCheck = "pending";
  private desyncReason: LockstepStatus["desyncReason"] = null;

  /** This phone's newest checkpoints: (tick, trail). */
  private readonly checkpoints: { tick: number; trail: number }[] = [];
  /** Peer checkpoints for ticks not stepped here yet: tick → trail's low 16 bits. */
  private readonly peerPending = new Map<number, number>();
  /** Every checkpoint both ways, for "Copy debug info". */
  private readonly ownTrail: [number, number][] = [];
  private readonly peerTrail: [number, number][] = [];

  private peerFrame: { paused: boolean; rxq: number; slack: number } | null = null;
  /**
   * The slack each frame list frames() handed out reported (ack + tickLag as
   * written), and when, back to the one the newest packet carried; and that
   * packet's (null before slot() says one went out): what speed() compares.
   */
  private readonly handed: { at: number; slack: number }[] = [];
  private airSlack: number | null = null;
  /** The peer's slack from its newest frames (the slack gate), and when they arrived (the packet period until setPacketMs). */
  private readonly slacks: number[] = [];
  private readonly arrivals: number[] = [];
  /** This phone's own transmit period (setPacketMs); null: not given yet. */
  private packetMs: number | null = null;
  /** The peer's newest frame said it was stalled on this phone's turn peerAck + 1 (its slack below 0, and not paused). */
  private peerStalled = false;
  /** When peerAck last moved, and when this phone last had more than one segment open, on the link's clock. */
  private peerAckAt: number;
  private rotatedAt = -Infinity;
  /** The peer stalled during a rotation or just after one: no new segment is started for the rest of the match. */
  private rotationOff = false;
  /** The list holds the oldest segment's frame alone: the peer starves for it (starving()). */
  private focused = false;
  private peerEnd: EndState = "playing";
  private peerEndReport: { tick: number; trail16: number } | null = null;
  private peerInLobby = false;

  private stalled = false;
  private stallStart = 0;
  private stallMs = 0;
  private lastNewTurnAt: number;
  private peerResumedAt = -Infinity;
  private framesIn = 0;
  private framesBad = 0;
  private delaySum = 0;
  private delayCount = 0;
  /** The order wait: when each tick a queued command counts from drained (playClock()), and the waits of the commands stepped. */
  private readonly drainedAt = new Map<number, number>();
  private waitSum = 0;
  private waitCount = 0;
  private waitWorst = 0;
  /** This phone's pauses so far (ms, the link's clock), and when the one in force began: playClock() leaves them out. */
  private pausedMs = 0;
  private pausedAt = 0;
  private readonly stepped: [number, Faction, Command[]][] = [];

  private dirty = true;
  private version = 0;
  private current: { frames: OutFrame[]; version: number } = { frames: [], version: 0 };

  constructor(o: LockstepOptions) {
    if (!Number.isInteger(o.delay) || o.delay < 3 || o.delay > 8) throw new RangeError(`input delay ${o.delay}: 3–8 ticks`);
    if (o.capacity < minCapacity(o.delay)) throw new RangeError(`capacity ${o.capacity}: at least ${minCapacity(o.delay)} bits at input delay ${o.delay}`);
    const k = o.segmentsMax ?? segmentsFor(o.delay);
    if (!Number.isInteger(k) || k < 1) throw new RangeError(`segmentsMax ${k}: a whole number, at least 1`);
    this.local = o.local;
    this.peer = other(o.local);
    this.delay = o.delay;
    this.capacity = o.capacity;
    this.turnMax = o.capacity - HEADER_MAX;
    this.segmentsMax = k;
    this.map = { width: o.mapWidth, height: o.mapHeight };
    this.now = o.now;
    const D = o.delay;
    ({ lag: this.lag, ack: this.ackBound, span: this.spanBound } = headerBounds(D));
    // both phones hold turns 0 … D−1 (empty) from the start
    this.newestSealed = this.ackThrough = this.peerAck = D - 1;
    this.segs = [D - 1];
    this.trailValue = foldTrail(TRAIL_START, o.setupHash >>> 0);
    this.lastNewTurnAt = this.peerAckAt = o.now();
  }

  // ------------------------------------------------------------ stepping ---

  /**
   * The commands to step tick `tick` with (blue's, then red's, whichever side
   * is local), or null to stall. The first call for a tick seals turn
   * tick + D from `drain()`; later calls for the same tick (a stall) drain
   * nothing. Paused, or once the match has ended, nothing is sealed and it
   * returns null.
   */
  commandsFor(tick: number, drain: () => readonly Command[]): Command[] | null {
    if (tick !== this.tick) throw new Error(`lockstep is at tick ${this.tick}, not ${tick}`);
    if (this.over() || this.paused) {
      this.endStall();
      return null;
    }
    if (this.newestSealed < tick + this.delay) this.seal(tick + this.delay, drain());
    if (this.ackThrough < tick) {
      if (!this.stalled) {
        this.stalled = true;
        this.stallStart = this.now();
      }
      // (stalled here, the peer is behind: the slack it reports meanwhile is more than it will keep)
      this.restartSlack();
      return null;
    }
    this.endStall();
    // blue's, then red's: the sim applies them in array order, and ids come from one shared counter
    return composeTick(this.local, this.mine.get(tick)?.cmds ?? [], this.theirs.get(tick) ?? []);
  }

  /** After stepping `tick` with commandsFor's commands: fold the world hash into the trail; `decided` if the world now has a winner. */
  afterStep(tick: number, worldHash32: number, decided: Decision | null): void {
    if (tick !== this.tick) throw new Error(`lockstep is at tick ${this.tick}, not ${tick}`);
    this.trailValue = foldTrail(this.trailValue, worldHash32 >>> 0);
    const sealed = this.mine.get(tick);
    if (sealed?.drainedAt) {
      const now = this.playClock();
      for (const at of sealed.drainedAt) {
        const wait = Math.max(0, now - at);
        this.waitSum += wait;
        this.waitCount++;
        this.waitWorst = Math.max(this.waitWorst, wait);
      }
    }
    const mine = sealed?.cmds ?? [];
    const theirs = this.theirs.get(tick) ?? [];
    for (const [side, cmds] of this.local === "blue" ? ([["blue", mine], ["red", theirs]] as const) : ([["blue", theirs], ["red", mine]] as const))
      if (cmds.length) this.stepped.push([tick, side, cmds]);
    this.theirs.delete(tick);
    this.tick = tick + 1;
    if (tick % CHECKPOINT_EVERY === 0) {
      this.checkpoints.push({ tick, trail: this.trailValue });
      if (this.checkpoints.length > CHECKPOINTS_KEPT) this.checkpoints.shift();
      this.ownTrail.push([tick, this.trailValue]);
      const theirsAt = this.peerPending.get(tick);
      for (const t of [...this.peerPending.keys()]) if (t <= tick) this.peerPending.delete(t);
      if (theirsAt !== undefined) this.compare(this.trailValue, theirsAt);
      this.dirty = true;
    }
    if (decided && this.endState === "playing") {
      this.decision = { winner: decided.winner, resigned: decided.resigned ?? null, tick, trail: this.trailValue };
      this.decidedAt = this.now();
      this.endState = "decided";
      this.endStall();
      this.dirty = true;
    }
    this.prune();
    this.checkEnd();
  }

  /**
   * Seal turn T: canonicalize what was drained onto the queue, then move
   * commands from its front while the window rule allows, and place T in the
   * newest segment or a new one.
   */
  private seal(T: number, drained: readonly Command[]): void {
    const ctx = { local: this.local, width: this.map.width, height: this.map.height };
    // (the order wait counts from here: enqueue stamps what it queues with this tick)
    if (drained.length) this.drainedAt.set(this.tick, this.playClock());
    for (const c of drained) this.enqueue(canonicalize(c, ctx));
    this.trim();
    // the newest segment's frame as it stands: from its oldest unacknowledged turn (T when it has none) to T − 1
    const from = Math.max(this.segs[this.segs.length - 1]!, this.peerAck + 1);
    /** Segments with unacknowledged turns before T: after trim, all but perhaps the newest. */
    const open = this.segs.length - (from >= T ? 1 : 0);
    let nonEmpty = 0;
    let body = 0;
    let last = from - 1;
    for (let u = from; u < T; u++) {
      const s = this.mine.get(u);
      if (!s?.cmds.length) continue;
      nonEmpty++;
      body += ueBits(u - last - 1) + ueBits(s.cmds.length - 1) + s.nbits;
      last = u;
    }
    /**
     * Where T goes holding `count` commands of `bits` bits: into the newest
     * segment's frame, a frame of its own, or neither. The span field is
     * counted at its widest too (spanBound), so the empty turns that join the
     * newest segment later always fit it.
     */
    const place = (count: number, bits: number): "joins" | "starts" | null => {
      const turn = count ? 1 : 0;
      const span = Math.max(T - from, this.spanBound);
      if (T - from <= SPAN_MAX && this.boundBits(span, nonEmpty + turn, body + (turn && ueBits(T - last - 1) + ueBits(count - 1) + bits)) <= this.capacity)
        return "joins";
      return this.boundBits(this.spanBound, turn, turn && 1 + ueBits(count - 1) + bits) <= this.capacity ? "starts" : null;
    };
    // (a new segment adds a packet to the rotation: the slack gate says how many the peer can afford)
    const afford = open ? this.affordable() : 1;
    const wr = new BitWriter();
    let prev: readonly number[] | null = null;
    let count = 0;
    const drainedAt: number[] = [];
    while (this.queue.length && count < TURN_COMMANDS_MAX) {
      const q = this.queue[0]!;
      const turnBits = wr.nbits + commandBits(q.command, this.map, prev);
      if (turnBits > this.turnMax) break;
      // the window: peerAck + 1 … T in at most K segments, T in the newest one or in one more
      const where = place(count + 1, turnBits);
      if (!where || (where === "joins" ? Math.max(open, 1) > this.segmentsMax : open + 1 > afford)) break;
      prev = encodeCommand(wr, q.command, this.map, prev);
      this.delaySum += T - q.at;
      this.delayCount++;
      drainedAt.push(this.drainedAt.get(q.at) ?? this.playClock());
      this.queue.shift();
      count++;
    }
    // (the drain times no queued command counts from any more: ticks go in ascending)
    const oldest = this.queue.reduce((t, q) => Math.min(t, q.at), Infinity);
    for (const t of this.drainedAt.keys()) if (t < oldest) this.drainedAt.delete(t);
    const bits = wr.bytes();
    // the decoded form, as the peer will read it: both phones step exactly this
    const cmds = count ? decodeCommands(new BitReader(bits, wr.nbits), count, this.map, this.local) : [];
    this.mine.set(T, { cmds, bits, nbits: wr.nbits, ...(count ? { drainedAt } : {}) });
    // (an empty T always joins, unless a garbage frame stretched the window past its bound: then it starts a segment
    // even past K, since a turn can't be refused)
    if (place(count, wr.nbits) !== "joins") this.segs.push(T);
    this.newestSealed = T;
    this.dirty = true;
  }

  /**
   * The most bits a segment's frame describing `span + 1` turns, `nonEmpty` of
   * them with commands taking `body` bits (gaps and counts included), can ever
   * take: tickLag and ack at their widest, with the checkpoint reserve. The
   * window rule cuts segments by it, so their frames always fit.
   */
  private boundBits(span: number, nonEmpty: number, body: number): number {
    return FIXED_BITS + ueBits(span) + this.lag.bits + this.ackBound.bits + ueBits(nonEmpty) + body + CHECKPOINT_BITS;
  }

  /**
   * The slack gate: how many segments the rotation can afford now, at most K.
   * The newest turns ride the newest segment, which goes out once a rotation,
   * so each segment beyond the first can hold them back a packet longer. The
   * peer's slack (the turns of this phone's it holds beyond the tick it is
   * on) is how early they arrive, so another segment is affordable while the
   * lowest slack it reported in its last SLACK_FRAMES frames covers one more
   * packet per extra segment, with SLACK_SPARE ticks to spare, at this
   * phone's own packet period (period()); none yet: one segment.
   *
   * Only a full window counts (restartSlack says when it starts over): the
   * peer's slack runs high while it is behind this phone, which it is at the
   * start of the match (both hold turns 0 … D − 1), while either phone is
   * paused or this one is stalled, and for seconds after, while the speed
   * trim lets it catch up. Read off a few such frames the gate opened to K
   * and the peer then stalled behind the rotation: in robust mode at 500 ms
   * and D = 7, 256 and 48 ms against K = 1's 48 and 0.
   */
  private affordable(): number {
    const P = this.period();
    if (this.rotationOff || this.slacks.length < SLACK_FRAMES || P === null) return 1;
    const slack = Math.min(...this.slacks);
    return Math.max(1, Math.min(this.segmentsMax, 1 + Math.floor(((slack - SLACK_SPARE) * 100) / P)));
  }

  /**
   * The packet period of this phone's rotation: its own transmit period, as
   * setPacketMs gave it. Before that, the shortest gap between the peer's
   * newest arrivals (null before two), which is the same while both phones
   * run the mode the pairing started them in, and no longer once either
   * adapts its own: a phone sending robust to a fast peer would read 100 ms,
   * open twice the extra segments its slack affords and send the oldest
   * segment alone before its rotation could have brought it, and one sending
   * fast to a robust peer would read 200 ms and open half of them.
   */
  private period(): number | null {
    if (this.packetMs !== null) return this.packetMs;
    let gap = Infinity;
    for (let i = 1; i < this.arrivals.length; i++) {
      const d = this.arrivals[i]! - this.arrivals[i - 1]!;
      if (d > 0) gap = Math.min(gap, d);
    }
    return gap === Infinity ? null : gap;
  }

  /** Start the slack gate's window over: the peer's slack heard so far no longer says what it will have. */
  private restartSlack(): void {
    this.slacks.length = 0;
  }

  /** Segments with turns the peer doesn't hold (at least 1: the frames always describe newestSealed). */
  private openSegments(): number {
    let n = 0;
    for (let i = 0; i < this.segs.length; i++) if ((i + 1 < this.segs.length ? this.segs[i + 1]! - 1 : this.newestSealed) > this.peerAck) n++;
    return Math.max(1, n);
  }

  /** Drop the segments the peer holds entirely. The newest stays: frames always describe at least newestSealed. */
  private trim(): void {
    while (this.segs.length > 1 && this.segs[1]! - 1 <= this.peerAck) this.segs.shift();
  }

  /**
   * Queue the canonical pieces of one drained command. A resign goes to the
   * front. A command that replaces others (REPLACES) first drops each queued
   * order it makes pointless: one of a type it replaces, all of whose units it
   * names, with nothing queued between them naming any of those units (that
   * order would still have to run first). Walking back from the newest, every
   * unit a kept command names is blocked, so for each unit only the run of
   * orders right before this one goes, and its own history is unchanged but
   * for orders that would have been overridden. Each piece keeps when each of
   * its units started waiting (the drain tick of the oldest order it lost),
   * and the pieces whose units have waited longest go first, so queuedTicks
   * still says how long a unit has waited for an order.
   */
  private enqueue(pieces: readonly Command[]): void {
    const head = pieces[0];
    if (!head) return;
    const at = this.tick;
    if (head.type === "resign") {
      // (the world is decided on the tick it lands: whatever waits behind it no longer matters)
      this.queue.unshift({ command: head, at });
      return;
    }
    const replaces = REPLACES[head.type];
    if (!replaces) {
      for (const k of pieces) this.queue.push({ command: k, at });
      return;
    }
    const named = new Set(pieces.flatMap(namedUnits));
    const blocked = new Set<number>();
    /** Units whose replaced order hadn't gone out, and since when they've waited for one. */
    const waiting = new Map<number, number>();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      const ids = namedUnits(q.command);
      if (!ids.some((id) => named.has(id))) continue;
      if (replaces.has(q.command.type) && ids.every((id) => named.has(id) && !blocked.has(id))) {
        this.queue.splice(i, 1);
        for (const id of ids) waiting.set(id, Math.min(waiting.get(id) ?? at, q.since?.get(id) ?? q.at));
      } else for (const id of ids) blocked.add(id);
    }
    // the units that have waited longest go first: in id order the last pieces would lose every time to the
    // first ones whenever orders come faster than the window lets one whole order out
    const queued = pieces.map((command) => {
      const since = new Map<number, number>();
      for (const id of namedUnits(command)) {
        const t = waiting.get(id);
        if (t !== undefined) since.set(id, t);
      }
      return { command, at: Math.min(at, ...since.values()), since: since.size ? since : undefined };
    });
    queued.sort((p, q) => p.at - q.at); // (stable: equal waits keep their order)
    this.queue.push(...queued);
  }

  private prune(): void {
    // frames start at min(peerAck + 1, newestSealed), and the next step needs `tick`
    const keep = Math.min(this.peerAck + 1, this.tick);
    while (this.pruned < keep) this.mine.delete(this.pruned++);
  }

  // -------------------------------------------------------------- frames ---

  /**
   * The frames for the air, one per segment, keys (start turns) ascending:
   * hand them to transport.send() when `version` changes. It changes on every
   * rebuild, and they are rebuilt whenever any of them would change (a turn
   * sealed, ackThrough or peerAck moved, a checkpoint, pause or end), or when
   * the list does (the peer starts or stops starving for the oldest segment,
   * which goes alone meanwhile: starving()).
   */
  frames(): { frames: OutFrame[]; version: number } {
    const focus = this.starving();
    if (focus !== this.focused) {
      this.focused = focus;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.current = { frames: this.build(), version: ++this.version };
      // (every segment's frame says the same slack: tickLag and ack of its `to` add up to ackThrough − tick)
      const to = this.newestSealed;
      this.handed.push({ at: this.now(), slack: this.lagOf(to) + this.ackOf(to) });
      if (this.handed.length > HANDED_KEPT) this.handed.shift();
    }
    return this.current;
  }

  /**
   * A packet started at `at` (the link's slots(), this lockstep's clock): it
   * carried the frames last handed out before then, and speed() now compares
   * the slack they said with the peer's (see the header).
   */
  slot(at: number): void {
    const h = this.handed;
    let i = -1;
    while (i + 1 < h.length && h[i + 1]!.at < at) i++;
    if (i < 0) return;
    this.airSlack = h[i]!.slack;
    // (the older lists can't go out again)
    h.splice(0, i);
  }

  /**
   * Own turn u as frames describe it, if it has commands. Past this phone's
   * decision every turn is described as empty: no phone steps one, and the
   * end report then always fits.
   */
  private described(u: number): Sealed | undefined {
    const s = this.mine.get(u);
    return s?.cmds.length && !(this.decision && u > this.decision.tick) ? s : undefined;
  }

  /** tickLag and ack as a frame ending at `to` writes them: clamped to their bounds (see the header). */
  private lagOf(to: number): number {
    return Math.max(this.lag.min, Math.min(this.lag.max, to - this.tick));
  }

  private ackOf(to: number): number {
    return Math.max(this.ackBound.min, Math.min(this.ackBound.max, this.ackThrough - to));
  }

  private frameBits(from: number, to: number, checkpoint: boolean, end: EndState): number {
    let n = 0;
    let body = 0;
    let last = from - 1;
    for (let u = from; u <= to; u++) {
      const s = this.described(u);
      if (!s) continue;
      n++;
      body += ueBits(u - last - 1) + ueBits(s.cmds.length - 1) + s.nbits;
      last = u;
    }
    return (
      FIXED_BITS + ueBits(to - from) + seBits(this.lagOf(to)) + seBits(this.ackOf(to)) + ueBits(n) + body +
      (checkpoint ? CHECKPOINT_BITS : 1) + (end === "decided" ? END_REPORT_BITS : 0)
    );
  }

  private build(): OutFrame[] {
    this.trim();
    // frames describe min(peerAck + 1, newestSealed) … newestSealed, each segment from its oldest unacknowledged turn
    const lo = Math.min(this.peerAck + 1, this.newestSealed);
    const out: OutFrame[] = [];
    for (let i = 0; i < this.segs.length; i++) {
      const key = this.segs[i]!;
      const newest = i === this.segs.length - 1;
      const f = this.frame(Math.max(key, lo), newest ? this.newestSealed : this.segs[i + 1]! - 1, newest);
      out.push({ ...f, key });
    }
    return this.focused ? out.slice(0, 1) : out;
  }

  /**
   * The peer starves for the oldest segment: its newest frame says it is
   * stalled on peerAck + 1, which the oldest segment's frame carries, and
   * peerAck hasn't moved for longer than a rotation, a round trip and a
   * packet should take ((open + 1) packets and 2D ticks: pairing's D covers
   * half a round trip). The rotation is strictly periodic, so a loss with the
   * same period (an interferer, every n-th packet) can take that frame every
   * time round, and nothing would ever change: both phones stall, peerAck
   * stays put, the list stays as it is. In a list of its own it goes in every
   * packet, as with K = 1, until the peer holds it.
   */
  private starving(): boolean {
    const open = this.peerStalled ? this.openSegments() : 1;
    if (open < 2) return false;
    return this.now() - this.peerAckAt >= (open + 1) * (this.period() ?? ROBUST_PERIOD) + 2 * this.delay * 100;
  }

  /** One segment's frame, from … to. Only the newest carries the end report. */
  private frame(from: number, to: number, newest: boolean): { bits: Uint8Array; nbits: number } {
    const cp = this.checkpoints[this.checkpoints.length - 1] ?? null;
    let end: EndState = this.endState === "decided" && !newest ? "playing" : this.endState;
    let checkpoint = cp !== null;
    if (end === "decided") {
      // room for the report: the checkpoint goes first, then the newest turns (they go out once acks arrive);
      // with no room even for the oldest unacknowledged turn, end = 0 for the moment: the turns come first (only
      // while the peer still lacks a turn up to the decision: once it holds them all, the frame describes only
      // empty turns and the report fits)
      let t = to;
      while (this.frameBits(from, t, checkpoint, end) > this.capacity) {
        if (checkpoint) checkpoint = false;
        else if (t > from) t--;
        else break;
      }
      if (this.frameBits(from, t, checkpoint, end) <= this.capacity) return this.write(from, t, checkpoint, end);
      end = "playing";
      checkpoint = cp !== null;
    }
    // (the window rule cut the segment so that its frame fits with the checkpoint, at the header's bounds)
    if (checkpoint && this.frameBits(from, to, true, end) > this.capacity) checkpoint = false;
    if (this.frameBits(from, to, checkpoint, end) > this.capacity) throw new Error(`lockstep: the frame for turns ${from}–${to} doesn't fit`);
    return this.write(from, to, checkpoint, end);
  }

  private write(from: number, to: number, checkpoint: boolean, end: EndState): { bits: Uint8Array; nbits: number } {
    const wr = new BitWriter();
    wr.bits(0b01, 2);
    wr.bit(this.paused ? 1 : 0);
    wr.bits(END_CODES.indexOf(end), 2);
    wr.bits(this.rxq, 3);
    wr.bits(to & 0xffff, 16);
    wr.ue(to - from);
    wr.se(this.lagOf(to));
    wr.se(this.ackOf(to));
    const turns: [number, Sealed][] = [];
    for (let u = from; u <= to; u++) {
      const s = this.described(u);
      if (s) turns.push([u, s]);
    }
    wr.ue(turns.length);
    let last = from - 1;
    for (const [u, s] of turns) {
      wr.ue(u - last - 1);
      wr.ue(s.cmds.length - 1);
      wr.append(s.bits, s.nbits);
      last = u;
    }
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (checkpoint && cp) {
      wr.bit(1);
      wr.bits((cp.tick / CHECKPOINT_EVERY) & 15, 4);
      wr.bits(cp.trail & 0xffff, 16);
    } else wr.bit(0);
    if (end === "decided") {
      wr.bits(this.decision!.tick & 0xffff, 16);
      wr.bits(this.decision!.trail & 0xffff, 16);
    }
    return { bits: wr.bytes(), nbits: wr.nbits };
  }

  // ------------------------------------------------------------- receive ---

  /**
   * A packet from the peer: "game" if it was a game frame this phone took,
   * "lobby" for a lobby frame (the peer is still loading), "invalid" otherwise
   * (malformed frames are counted in framesBad; all-zero packets are nothing).
   */
  receive(bits: Uint8Array, nbits: number, at: number): "game" | "lobby" | "invalid" {
    const type = nbits >= 2 && bits.length ? bits[0]! >> 6 : 0;
    if (type === 2) {
      this.peerInLobby = true;
      return "lobby";
    }
    if (type !== 1) return "invalid";
    let f: GameFrame;
    try {
      // (expected near ackThrough: only turns taken move it, so neither a stale frame nor a garbage one can)
      f = readGameFrame(bits, nbits, this.map, this.peer, this.ackThrough);
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
      this.framesBad++;
      return "invalid";
    }
    this.framesIn++;
    this.peerInLobby = false;
    if (this.peerFrame?.paused && !f.paused) this.peerResumedAt = at;
    this.peerFrame = { paused: f.paused, rxq: f.rxq, slack: f.ack + f.tickLag };
    // (a paused peer's slack only grows until this phone stalls: it says nothing of what the peer keeps once it plays on)
    if (f.paused) this.restartSlack();
    else {
      this.slacks.push(f.ack + f.tickLag);
      if (this.slacks.length > SLACK_FRAMES) this.slacks.shift();
    }
    this.arrivals.push(at);
    if (this.arrivals.length > ARRIVALS_KEPT) this.arrivals.shift();
    // (the peer can't hold a turn this phone hasn't sealed: a bad value never skips one)
    const holds = Math.min(f.ack + f.to, this.newestSealed);
    if (holds > this.peerAck) {
      this.peerAck = holds;
      this.peerAckAt = at;
      this.dirty = true;
    }
    // (a stall in the peer during a rotation, or within 2D ticks of one, a turn's input delay and its trip, ends
    // rotation for the match: the gate can't see loss coming, and in rotation a lost packet costs the newest turns a
    // whole rotation; see the header. While this phone is paused the peer stalls for that.)
    if (this.openSegments() > 1) this.rotatedAt = at;
    this.peerStalled = !f.paused && f.ack + f.tickLag < 0;
    if (this.peerStalled && !this.paused && at - this.rotatedAt <= 2 * this.delay * 100) this.rotationOff = true;
    if (f.to > this.ackThrough && f.from <= this.ackThrough + AHEAD_MAX) this.take(f, at);
    if (f.checkpoint) this.peerCheckpoint(f.checkpoint.idx, f.checkpoint.trail16);
    if (f.end === "left" || f.end === "desync") {
      if (this.peerEnd !== "left" && this.peerEnd !== "desync") this.peerEnd = f.end;
      if (f.end === "desync") this.desynced("peer");
      this.endStall();
    } else if (f.end === "decided") {
      if (this.peerEnd === "playing") this.peerEnd = "decided";
      if (!this.peerEndReport && f.endReport)
        this.peerEndReport = { tick: unwrap16(f.endReport.tick16, this.tick), trail16: f.endReport.trail16 };
      this.checkEnd();
    }
    return "game";
  }

  /**
   * Keep the turns a frame describes that this phone doesn't hold yet, empty
   * or not (each is taken once), and run ackThrough through every turn now held
   * in a row. Segments arrive in rotation, and after a lost packet a later one
   * first: its turns wait in `ahead` until the gap fills.
   */
  private take(f: GameFrame, at: number): void {
    let i = 0;
    for (let u = Math.max(f.from, this.ackThrough + 1); u <= f.to; u++) {
      while (i < f.turns.length && f.turns[i]![0] < u) i++;
      if (this.ahead.has(u)) continue;
      this.ahead.add(u);
      const t = f.turns[i];
      if (t && t[0] === u) this.theirs.set(u, t[1]);
    }
    const before = this.ackThrough;
    while (this.ahead.delete(this.ackThrough + 1)) this.ackThrough++;
    if (this.ackThrough === before) return;
    this.lastNewTurnAt = at;
    this.dirty = true;
  }

  private peerCheckpoint(idx: number, trail16: number): void {
    // the checkpoint nearest this phone's own tick / 50 with that index
    const base = this.tick / CHECKPOINT_EVERY;
    const at = (idx + 16 * Math.round((base - idx) / 16)) * CHECKPOINT_EVERY;
    if (at < 0) return;
    const lastHeard = this.peerTrail[this.peerTrail.length - 1];
    if (!lastHeard || lastHeard[0] !== at) this.peerTrail.push([at, trail16]);
    if (at < this.tick) {
      const own = this.checkpoints.find((c) => c.tick === at);
      if (own) this.compare(own.trail, trail16);
    } else this.peerPending.set(at, trail16);
  }

  private compare(trail: number, trail16: number): void {
    if ((trail & 0xffff) !== trail16) this.desynced("checkpoint");
  }

  /** Compare the peer's end report with this phone's end, once both are in (or once this phone has stepped past it). */
  private checkEnd(): void {
    this.expire();
    const r = this.peerEndReport;
    if (!r || this.endCheck !== "pending" || this.endState === "left" || this.endState === "desync") return;
    if (this.decision) {
      const ok = r.tick === this.decision.tick && (this.decision.trail & 0xffff) === r.trail16;
      this.endCheck = ok ? "ok" : "mismatch";
      if (!ok) this.desynced("end");
    } else if (r.tick < this.tick) {
      // the peer was decided at a tick this phone stepped without a decision
      this.endCheck = "mismatch";
      this.desynced("end");
    }
  }

  private expire(): void {
    if (this.decision && this.endCheck === "pending" && this.now() - this.decidedAt >= END_CHECK_MS) this.endCheck = "unverified";
  }

  private desynced(reason: NonNullable<LockstepStatus["desyncReason"]>): void {
    if (this.endState === "left" || this.endState === "desync") return;
    this.endState = "desync";
    this.desyncReason = reason;
    // (a decided phone's report says so, rather than "Checking sync…" and then "Not verified")
    if (this.decision && this.endCheck === "pending") this.endCheck = "mismatch";
    this.endStall();
    this.dirty = true;
  }

  // ------------------------------------------------------------- control ---

  /** Pause is local: frames say so, nothing new is sealed, and the peer stalls within D ticks. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pausedAt = this.now();
    else this.pausedMs += this.now() - this.pausedAt;
    this.endStall();
    this.restartSlack();
    this.dirty = true;
  }

  /**
   * This phone's receive quality of the peer (rxqOf(snrDb)). A new value
   * rebuilds the frames: a phone stalled on the peer seals nothing and moves
   * no ack, so nothing else would, and the peer, which picks its transmit mode
   * from it, would go on hearing the quality of before the stall.
   */
  setRxq(rxq: number): void {
    const v = Math.max(0, Math.min(7, Math.floor(rxq) || 0));
    if (v === this.rxq) return;
    this.rxq = v;
    this.dirty = true;
  }

  /**
   * This phone's own transmit period in ms (100 fast, 200 robust): the packet
   * period of its rotation, for the slack gate and starving(). Modes are per
   * direction, so the peer's arrivals, which the period is read off until this
   * is called, can be the other mode's. A new period starts the slack gate's
   * window over: the slack the peer reported of the other mode's packets says
   * nothing of what it will have now. Give the mode in force (the link's
   * stats().txMode), which follows setMode a superframe later: until then the
   * packets go out at the old period.
   */
  setPacketMs(ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) throw new RangeError(`packet period ${ms} ms`);
    if (ms === this.packetMs) return;
    this.packetMs = ms;
    this.restartSlack();
  }

  /** Leave ("left") or abort ("desync"): frames say so from now on (the session keeps sending them for 2 s). */
  leave(reason: "left" | "desync"): void {
    if (reason === "desync") return this.desynced("local");
    if (this.endState === "left" || this.endState === "desync") return;
    this.endState = "left";
    this.endStall();
    this.dirty = true;
  }

  /**
   * Game speed: the slack trim, clamp(1 + 0.02 × (slack − peerSlack), 0.9,
   * 1.1), with this phone's slack as its newest packet said it (live until
   * slot() reports one): like with like, so the two phones' speeds sum to 2 on
   * average (see the header).
   */
  speed(): number {
    if (!this.peerFrame) return 1;
    const slack = this.airSlack ?? this.ackThrough - this.tick;
    return Math.max(0.9, Math.min(1.1, 1 + 0.02 * (slack - this.peerFrame.slack)));
  }

  /** The match is over here: this phone's world is decided, it left or desynced, or the peer left or desynced. */
  over(): boolean {
    return this.endState !== "playing" || this.peerEnd === "left" || this.peerEnd === "desync";
  }

  /** The link's clock with this phone's pauses taken out: what the order wait counts in. */
  private playClock(): number {
    return this.now() - this.pausedMs - (this.paused ? this.now() - this.pausedAt : 0);
  }

  private endStall(): void {
    if (!this.stalled) return;
    this.stallMs += this.now() - this.stallStart;
    this.stalled = false;
  }

  // -------------------------------------------------------------- status ---

  status(): LockstepStatus {
    this.expire();
    // (the oldest drain tick: pieces that took over replaced orders keep theirs, so it isn't always the front's)
    const oldest = this.queue.reduce((t, q) => Math.min(t, q.at), this.tick);
    return {
      tick: this.tick,
      delay: this.delay,
      stalled: this.stalled,
      stallMs: this.stallMs + (this.stalled ? this.now() - this.stallStart : 0),
      slack: this.ackThrough - this.tick,
      peerSlack: this.peerFrame?.slack ?? null,
      paused: this.paused,
      peerPaused: this.peerFrame?.paused ?? false,
      peerInLobby: this.peerInLobby,
      end: this.endState,
      peerEnd: this.peerEnd,
      queued: this.queue.length,
      queuedTicks: this.tick - oldest,
      newestSealed: this.newestSealed,
      ackThrough: this.ackThrough,
      peerAck: this.peerAck,
      lastNewTurnAt: this.lastNewTurnAt,
      peerResumedAt: this.peerResumedAt,
      desync: this.endState === "desync",
      desyncReason: this.desyncReason,
      endCheck: this.endCheck,
      decided: this.decision && { winner: this.decision.winner, resigned: this.decision.resigned, tick: this.decision.tick },
      peerRxq: this.peerFrame?.rxq ?? null,
      framesIn: this.framesIn,
      framesBad: this.framesBad,
      orderDelay: this.delayCount ? this.delaySum / this.delayCount : null,
      orderWait: this.waitCount ? { meanMs: this.waitSum / this.waitCount, worstMs: this.waitWorst } : null,
      segments: this.openSegments()
    };
  }

  /** The trail after the last tick stepped. */
  trail(): number {
    return this.trailValue;
  }

  /** The turns as stepped, for Save battle: [tick, side, decoded commands], non-empty only, blue's before red's on a tick. */
  turns(): [number, Faction, Command[]][] {
    return this.stepped.slice();
  }

  /** For "Copy debug info": both trails' checkpoints (the peer's are its trails' low 16 bits) and the end. */
  debug(): { delay: number; tick: number; own: [number, number][]; peer: [number, number][]; end: { tick: number; trail: number } | null; peerEnd: { tick: number; trail16: number } | null } {
    return {
      delay: this.delay,
      tick: this.tick,
      own: this.ownTrail.slice(),
      peer: this.peerTrail.slice(),
      end: this.decision && { tick: this.decision.tick, trail: this.decision.trail },
      peerEnd: this.peerEndReport
    };
  }
}
