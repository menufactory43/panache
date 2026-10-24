/**
 * The session for duels (DUEL.md "Architecture", "Game
 * integration"): the glue between one LinkTransport and the two protocols
 * that take turns on it — the Pairing (the lobby) until the match starts, then
 * the Lockstep — with no engine of its own. It routes what the link delivers
 * to whichever protocol it belongs to, hands the link that protocol's frames,
 * keys the link at GO, keeps both protocols' receive quality current, picks
 * this phone's transmit mode during the match, and says when it is safe to
 * close.
 *
 * Engine-free: no DOM, no timers, no world. The clock is the transport's
 * now(), and nothing happens except in pump(), which the lobby and the feed
 * call every animation frame and from a fallback timer (a hidden page gets no
 * frames), and in the calls below. The nonce draw is injected.
 *
 *   const s = new Session({ transport, role, build, host: { map, mutators, hostSide }, random })
 *   every frame:  s.pump(); s.status()            (the lobby: s.pick(id), s.retry())
 *   once status().phase is "starting":  const r = s.result()!; const w = setupWorld(r.setup)
 *     s.beginMatch(parseInt(worldHash(w), 16))    (the faster phone stalls at tick D until its friend has loaded)
 *   each tick the game wants to step:  const cmds = s.commandsFor(t, drain); null: stall
 *     after stepping:  s.afterStep(t, parseInt(worldHash(w), 16), w.winner ? { winner, resigned } : null)
 *   s.speed(), s.setPaused(b), s.setHidden(b) (visibilitychange, synchronously), s.lockstep (turns, trail, debug)
 *   leaving (Leave, Menu, Rematch, an abort):  s.leave("left" | "desync"); once status().closable:  s.close()
 *
 * Phases: "pairing" (the lobby), "starting" (both phones said GO: the match
 * loads, and the GO frame stays on the air until it begins), "match", "ended"
 * (decided, left or out of sync: the frames go on, with the end report or
 * the end), "closed".
 *
 * Mode adaptation (DUEL.md is silent on it beyond the starting mode).
 * The pairing starts the match in fast mode when both phones heard each other
 * at 12 dB or better (its FAST_RXQ); during the match each phone picks its
 * own transmit mode, from what its friend says of it, so a link that is poor
 * one way only slows that way only. It goes robust when the friend's receive
 * quality of it has read 1 or less (under 6 dB) for 2 s, or when the friend's
 * game frames keep arriving but none has acknowledged anything new for 1.5 s,
 * or for the round trip and half a second where the pairing measured a longer
 * one (its packets aren't getting through, whatever the SNR says; counted from
 * when the friend's frames last started arriving, since right after an outage
 * they still carry the acks of before it). It goes back to fast once the
 * friend's quality of it has read 4 or more (12 dB, FAST_RXQ) for 10 s;
 * after a fallback the quality didn't explain, twice as long as the last time
 * (up to 80 s), until fast has held for a minute. Each wait counts from the
 * switch at the earliest, and a switch holds for at least a superframe
 * (2.05 s), which is when the modem can change mode at all. Every rule needs
 * the friend's frames to be arriving: a link that is silent both ways says
 * nothing about which way or which mode is at fault, and the stall overlays
 * already say "bring the phones closer". Its frames are its game frames, and
 * its own lobby frames while it hasn't begun (loading, or still in GO, not
 * having heard this phone's), whose rxq is the same report; the
 * acknowledgement rule takes game frames only, as a friend that hasn't begun
 * acknowledges nothing. Without the lobby frames, a phone that began in fast
 * while its fast reached no one waited at tick D for ever: its friend, still
 * in GO for want of this phone's GO or a game frame, sent only lobby frames,
 * and they moved no rule.
 *
 * The quality that sends a phone robust is where fast starts to fail, three
 * steps below the one that brings it back. Over RoomLink (pairing.ts
 * FAST_RXQ) fast delivered every packet wherever the receiver reported rxq 3
 * (9 dB) or more, 50–100% at the worst point reporting 2, by room, plan and
 * rate, and 13–50% at 1; robust 97% or more down to 1. A match keeps the D
 * of its starting mode, and robust needs more than fast. A fast start on the
 * high plan gets D = 5 at the room's 75 ms audio path, where robust (both
 * phones, from the start) stalled 0.1–1.0% of a two-minute match (3 of 7
 * rooms over 0.5%), and D = 4 at 50 ms or less, where it stalled 1.5–6.8%;
 * on the low plan it gets 8, where robust stalled 5–7% (it needs about 10).
 * D sized for robust whatever the start would spare a fallback this, at
 * 100 ms more input delay for every fast match on the high plan (pairing.ts
 * delayFor). With the host's signal at the guest dropping to 5.5–8.5 dB 30 s
 * in (1200 ticks, both plans), going robust at rxq 2 rather than 1 changed
 * neither phone's stall by more than 0.2 s, so the threshold stays low.
 *
 * A friend whose newest frame says paused acknowledges nothing that counts
 * against this phone: a hidden page may get no frames and no timers while its
 * link repeats its paused frame, and its lockstep, fed nothing, acknowledges
 * nothing (each 6 s switch away sent its friend robust for 20 s, then 40,
 * before this). A visible friend whose main thread is blocked for longer than
 * the wait looks the same and has no bit to say so: that sends this phone
 * robust (measured: a 2 s long task, robust 1.7 s in, fast again 20 s later).
 * It is left so: such a phone has frozen its own game too, and a longer wait
 * would cost every real one-way failure as much.
 *
 * Where the spec is silent:
 *  - the lobby frame is rebuilt and handed over at each slot only (and at
 *    construction, and at once after a retry), as pairing.ts drives it: a
 *    frame built between slots could miss the packet whose start its ping
 *    names, and its round trip would read a packet long. So news the lobby
 *    hears (a pick, a GO) goes out a packet later than it could;
 *  - game frames that didn't pass the session CRC (`session` false) are
 *    dropped, always: the session CRC is in force from GO on even over a link
 *    that keys nothing itself. So a transport that can't check it (a relay
 *    carrying bare frames) must emulate it, by carrying the key with each
 *    frame and comparing as PacketAir does, or by reporting game frames as
 *    session frames once setSessionKey has been called; one that honestly
 *    reports `session` false plays no match at all (tested: both phones stall
 *    at tick D on "link");
 *  - game frames that arrive before this phone's lockstep exists count only
 *    under the key of this pairing's GO (the link may pass an earlier
 *    pairing's under a key it can't unset). They are dropped, as they repeat
 *    until acknowledged, but the newest is kept, and the lockstep takes it
 *    first when it is made: a friend that left while this phone loaded has
 *    stopped sending by the time a slow load ends, and its match then ends at
 *    once. One that says the friend plays on tells the pairing the friend has
 *    started (its Start rule); one that says it left or aborted doesn't (a
 *    phone still in GO would start a match against a friend that has gone):
 *    status().peerEnded says so instead. Lobby frames that arrive after it
 *    began go to the lockstep, which takes any as "the friend is in the
 *    lobby" (after the match the friend's reloaded page, under a new nonce,
 *    is the rematch hint);
 *  - receive quality is rxqOf(stats().snrDb), the newest packet's SNR, read
 *    as 0 once nothing has arrived for over 1 s, so a friend this phone stops
 *    hearing learns of it from its frames;
 *  - the link is keyed when the pairing says GO (the next GO after a restart
 *    keys afresh), but keeps the lobby's mode (the link's at construction)
 *    until beginMatch sets the starting mode. The GO frame, and a pick that
 *    goes out with it, must reach the friend: in the lobby's mode they go the
 *    way every lobby frame went. Sent in a starting fast that had stopped
 *    getting through one way since the config froze, they never arrived, and
 *    nothing switched back (no rule runs before a friend's game frames): one
 *    phone sat in GO, the other "waiting" for the pick, or begun and held at
 *    tick D on "load". A stand-in's end (leave() before the match) goes out in
 *    the lobby's mode too, the one the friend heard the GO in;
 *  - the guest's band plan follows stats().plan while its link is locked,
 *    until GO (the pairing ignores it from then on);
 *  - background is a pause the feed doesn't have to remember: the lockstep is
 *    paused while the player paused or the page is hidden, and a change goes
 *    to the link at once (a hidden page may not pump again);
 *  - commandsFor and afterStep hand the lockstep's frames to the link as soon
 *    as they change, so a turn sealed between pumps doesn't miss a packet;
 *  - leave() before this phone's GO has nothing to tell: it stops the
 *    pairing (pump does nothing more) and the session may close at once. From
 *    GO on the friend may have started (on that GO alone, before this phone
 *    has a result), so with no match begun yet a stand-in lockstep (never
 *    stepped, setup hash 0; the side, D and map from the result, or the
 *    pairing's config before one) sends the end for 2 s: a friend that began
 *    hears "Friend left" rather than stalling into "Signal lost", and one
 *    still loading or in GO keeps the newest frame for its lockstep. After a
 *    decided match leave("left") keeps the decided frames, with their end
 *    report, on the air for the 2 s rather than turning them into "left",
 *    which would take the report off the air before the friend may have it;
 *    leave("desync") always says desync. It may close after the 2 s, or at once
 *    if the friend has left or desynced already;
 *  - a stall's `why` is "load" while the friend's newest packet was a lobby
 *    frame of its own (its role and nonce: a third phone's, a replay's or the
 *    friend's reloaded page's say nothing of this match), "paused" while its
 *    newest frame says paused (switching away pauses too: one bit can't tell
 *    "Friend switched away" from it), either only while that packet is under
 *    PEER_HEARD_MS old (a friend that paused and then went out of range is
 *    lost, not paused), and "link" otherwise, which it reads for a moment
 *    after "load" too: the friend's first game frame comes a packet before
 *    its first turn. So it does after "paused": the friend's first frame
 *    that says it plays on comes before the turn its next step seals. Its
 *    `ms` counts from the friend's last new turn, or from when its frames
 *    stopped saying paused if that is later (a paused friend owes none):
 *    counted from its last turn before the pause, that moment read as a
 *    stall as long as the pause, "Signal lost" for a pause of 5 s or more;
 *  - the transmit mode adapts only during the match: the lobby keeps the
 *    link's mode until the match begins, and the mode stays as it is once the
 *    match is over;
 *  - beginMatch doesn't wait for anything: the lobby calls it once the rig has
 *    had its 1.5 s of gap-free capture (DUEL.md "Capture");
 *  - the pairing's state after the match begins is the one it had then;
 *  - packets out counts slots (packet starts: every one carries a frame),
 *    packets in every packet polled, and ignored the game frames dropped
 *    (without the session CRC, before this phone began, or unreadable).
 */
import type { BandRole, LinkPacket, LinkStats, LinkTransport, ModemMode } from "../link/transport";
import { mapById } from "../sim/maps";
import type { OpenerId } from "../sim/openers";
import type { Command, Faction, NationOrClassic } from "../sim/types";
import { CodecError } from "./codec";
import { Lockstep, rxqOf, type Decision, type LockstepStatus } from "./lockstep";
import { FAST_RXQ, Pairing, packetMs, readLobbyFrame, type HostOffer, type LobbyFrame, type PairingResult, type PairingState } from "./pairing";

/** After leave(), the end goes out this long before the session may close (DUEL.md "Leaving"). */
export const END_FRAMES_MS = 2000;
/** Nothing heard for longer than this: this phone's receive quality reads 0. */
export const RX_SILENT_MS = 1000;
/** The friend's receive quality of this phone at or below this (under 6 dB) … */
export const ROBUST_RXQ = 1;
/** … for this long sends this phone robust. */
export const ROBUST_AFTER_MS = 2000;
/** The friend's game frames arriving with no new acknowledgement for this long (or the round trip and ACK_RTT_SPARE_MS, if longer) sends this phone robust. */
export const ACK_STALL_MS = 1500;
/** Two robust packets (one each way, waiting for its slot) and a margin. */
export const ACK_RTT_SPARE_MS = 500;
/** The friend's receive quality of this phone at or above FAST_RXQ for this long brings it back to fast … */
export const FAST_AFTER_MS = 10_000;
/** … or twice the last wait after a fallback the quality didn't explain, up to this … */
export const FAST_AFTER_MAX_MS = 80_000;
/** … until fast has held this long. */
export const FAST_SETTLED_MS = 60_000;
/** A mode holds at least a superframe (41 symbols of 50 ms): the modem changes mode only at one. */
export const SWITCH_HOLD_MS = 2050;
/** The friend's game frames count as arriving while none is further apart than this (and the newest is within it). */
export const PEER_GAP_MS = 1000;
/**
 * A stall waits on the friend loading or paused only while its newest packet
 * is this recent: past it, on the link. Six robust packets of the low plan, so
 * a lost packet or two never flickers the overlay; "Signal lost" counts from
 * the last new turn, so it shows at once when this runs out.
 */
export const PEER_HEARD_MS = 2500;

const TYPE_GAME = 0b01;
const TYPE_LOBBY = 0b10;
/** A game frame's end field (its first byte: type 2, paused 1, end 2, rxq 3). */
const endField = (bits: Uint8Array): number => (bits[0]! >> 3) & 3;
const END_CODES = ["playing", "left", "desync", "decided"] as const;

/** What a lockstep is made from: the side, the input delay and the map (a result, or the pairing's GO). */
interface MatchShape {
  local: Faction;
  delay: number;
  mapId: string;
}

export type SessionPhase = "pairing" | "starting" | "match" | "ended" | "closed";

/** Why the transmit mode changed: the match began (the starting mode), the friend's receive quality, or no acknowledgements. */
export type ModeReason = "start" | "rxq" | "acks";

export interface SessionOptions {
  transport: LinkTransport;
  role: BandRole;
  /** The first 16 bits of the duel build hash. */
  build: number;
  /** The lobby protocol (default LOBBY_PROTO). */
  proto?: number;
  /** Required for the host. */
  host?: HostOffer;
  /** The guest's nation ask (proto 2; default none: the host's rival). */
  nation?: NationOrClassic;
  /** Uniform in [0, 1): the pairing's nonce draw. */
  random: () => number;
  /** K for the match (default segmentsFor(D)). */
  segmentsMax?: number;
  /** Mode adaptation during the match (default on). */
  adaptMode?: boolean;
}

export interface SessionStatus {
  phase: SessionPhase;
  role: BandRole;
  /** The lobby: live until the match begins, then as it was. */
  pairing: PairingState;
  /** The match as both phones agreed it, once they did. */
  result: PairingResult | null;
  lockstep: LockstepStatus | null;
  link: LinkStats;
  /** The pairing's median round trip (ms), null before one. */
  rttMs: number | null;
  /** This phone's receive quality of the friend (0–7), and the friend's of this phone (its newest frame). */
  rxq: number;
  peerRxq: number | null;
  mode: {
    /** The transmit mode this phone chose (the link changes at its next superframe). */
    tx: ModemMode;
    /** What the link transmits and receives now. */
    air: ModemMode;
    rx: ModemMode | null;
    /** The match's starting mode (null before GO). */
    start: ModemMode | null;
    /** Mode changes during the match, and the latest (link clock). */
    switches: number;
    last: { at: number; to: ModemMode; why: ModeReason } | null;
  };
  /** Packet starts, packets polled, and game frames dropped (no session CRC, before this phone began, unreadable). */
  packets: { in: number; out: number; ignored: number };
  /** A game frame of this pairing that says the friend plays on arrived (before this phone began, or since): the friend is in the match. */
  peerStarted: boolean;
  /**
   * The friend's game frames said it left, or aborted (desync): before this
   * phone began its match (the loading screen and the lobby can say "Friend
   * left" without loading it; a match begun then ends at once), or since.
   */
  peerEnded: "left" | "desync" | null;
  /**
   * The match is stalled on a turn of the friend's: whether its newest packet
   * was a lobby frame of its own (it is still loading) or says it is paused,
   * while that packet is under PEER_HEARD_MS old, else the link; and how long
   * since its last new turn (the overlays count from it). Null while not
   * stalled.
   */
  waiting: { why: "load" | "paused" | "link"; ms: number } | null;
  /** leave() was called. */
  leaving: boolean;
  /** Nothing left to send: the end has had its 2 s (or there's nothing to tell). */
  closable: boolean;
}

export class Session {
  readonly role: BandRole;
  readonly transport: LinkTransport;
  readonly pairing: Pairing;
  private readonly segmentsMax: number | undefined;
  private readonly adapt: boolean;
  private ls: Lockstep | null = null;
  /** The lockstep only says the end: this phone left before its match began. */
  private standIn = false;
  private sent = 0;
  private closed = false;
  private leftAt: number | null = null;
  private userPaused = false;
  private hidden = false;
  /** The pairing's state when the match began. */
  private atStart: PairingState | null = null;
  private readonly counts = { in: 0, out: 0, ignored: 0 };
  private rxq = 0;

  // the friend, in the pairing the link is keyed for (forgotten when it starts over)
  /** Its nonce (0 before the link is keyed). */
  private peerNonce = 0;
  /** A game frame of its that says it plays on arrived before this phone's lockstep existed. */
  private peerStarted = false;
  /** Its newest game frame from before this phone's lockstep existed: the lockstep takes it first. */
  private early: { bits: Uint8Array; nbits: number; at: number } | null = null;
  /** What that frame said if it left or aborted: such a frame starts nothing. */
  private earlyEnd: "left" | "desync" | null = null;
  /** Its newest packet: a game frame of this pairing, or a lobby frame under its nonce (loading), and when. */
  private peerLast: { at: number; lobby: boolean } | null = null;

  // the transmit mode
  /** The nonces the link is keyed for ("host:guest"), null before GO. */
  private keyedFor: string | null = null;
  private tx: ModemMode;
  private startMode: ModemMode | null = null;
  private switchedAt = -Infinity;
  private fastSince = -Infinity;
  private fastWait = FAST_AFTER_MS;
  private switches = 0;
  private lastSwitch: { at: number; to: ModemMode; why: ModeReason } | null = null;
  // what the friend's frames say (its game frames, and its own lobby frames once this phone's match has begun): the
  // newest, the run of its receive quality of this phone at or below ROBUST_RXQ or at or above FAST_RXQ; since when
  // its game frames have arrived without a long gap, the newest, and when peerAck last moved
  private lastHeardAt = -Infinity;
  private gameSince = -Infinity;
  private lastGameAt = -Infinity;
  private lowSince: number | null = null;
  private highSince: number | null = null;
  private peerAckSeen = -1;
  private peerAckAt = -Infinity;

  constructor(o: SessionOptions) {
    this.role = o.role;
    this.transport = o.transport;
    this.segmentsMax = o.segmentsMax;
    this.adapt = o.adaptMode ?? true;
    const st = o.transport.stats();
    this.tx = st.txMode;
    this.pairing = new Pairing({
      role: o.role,
      build: o.build,
      ...(o.proto !== undefined ? { proto: o.proto } : {}),
      ...(o.host ? { host: o.host } : {}),
      ...(o.nation ? { nation: o.nation } : {}),
      plan: st.plan,
      now: () => o.transport.now(),
      random: o.random
    });
    // (so the first packet carries a frame)
    this.sendLobby();
  }

  // ------------------------------------------------------------- driving ---

  /**
   * Take what the link delivered and hand it the frames due: the lobby's at
   * each packet start until the match begins, then the lockstep's whenever
   * they change. Cheap when nothing happened; call it every frame.
   */
  pump(): void {
    if (this.closed) return;
    const slots = this.transport.slots();
    this.counts.out += slots.length;
    const lobby = !this.ls && this.leftAt === null;
    if (lobby)
      for (const at of slots) {
        this.pairing.slot(at);
        this.sendLobby();
      }
    // (which frames went out: the speed trim compares the slack they said with the friend's)
    else if (this.ls) for (const at of slots) this.ls.slot(at);
    for (const p of this.transport.poll()) this.route(p, lobby);
    const st = this.transport.stats();
    this.rxq = st.sinceRx > RX_SILENT_MS ? 0 : rxqOf(st.snrDb);
    if (lobby) {
      this.pairing.setRxq(this.rxq);
      if (this.role === "guest" && st.locked) this.pairing.setPlan(st.plan);
      this.keyAtGo();
    } else if (this.ls) {
      this.ls.setRxq(this.rxq);
      // (its rotation runs at this phone's own packet period: the mode on the air, which a switch reaches only at
      // the next superframe; modes are per direction, so the friend's arrivals don't say it)
      this.ls.setPacketMs(packetMs(st.plan, st.txMode));
      this.adaptMode();
    }
    this.flush();
  }

  /** Pick an opener (the lobby's cards): false if it isn't time to, or the rules don't allow it. */
  pick(id: OpenerId): boolean {
    return !this.ls && this.leftAt === null && this.pairing.pick(id);
  }

  /** The retry tap ("Pairing failed: tap to retry"), or any lobby restart: a fresh nonce, and its frame on the link at once. */
  retry(): void {
    if (this.ls || this.leftAt !== null || this.closed) return;
    this.pairing.reset();
    // (the frame the link holds is the old pairing's, maybe its GO: the friend would start on it alone)
    this.sendLobby();
    // (and the friend of the old pairing is no one's: keyAtGo forgets it with the key)
    this.keyAtGo();
  }

  /** The match both phones agreed on (null until both said GO). */
  result(): PairingResult | null {
    return this.pairing.result();
  }

  /**
   * Begin the match, once the world is built from result().setup: `setupHash`
   * is parseInt(worldHash(world), 16). The first game frame replaces the GO
   * frame on the link at once, and the link goes to the starting mode. Throws
   * before a result, after leave(), or the second time.
   */
  beginMatch(setupHash: number): Lockstep {
    if (this.closed || this.leftAt !== null) throw new Error("the session has ended");
    if (this.ls) throw new Error("the match has begun already");
    const r = this.pairing.result();
    if (!r) throw new Error("no match agreed yet");
    this.keyAtGo();
    this.atStart = this.pairing.state();
    this.setTx(r.fast ? "fast" : "robust", "start");
    const ls = (this.ls = this.lockstepFor(r, setupHash));
    if (this.userPaused || this.hidden) ls.setPaused(true);
    ls.setRxq(this.rxq);
    this.takeEarly();
    this.flush();
    return ls;
  }

  /** The lockstep, once the match has begun (turns(), trail(), debug(), status()). */
  get lockstep(): Lockstep | null {
    return this.standIn ? null : this.ls;
  }

  /** Lockstep.commandsFor, then the frames to the link if a turn was sealed. Null: stall. */
  commandsFor(tick: number, drain: () => readonly Command[]): Command[] | null {
    const cmds = this.match().commandsFor(tick, drain);
    this.flush();
    return cmds;
  }

  /** Lockstep.afterStep, then the frames to the link if a checkpoint or the decision changed them. */
  afterStep(tick: number, worldHash32: number, decided: Decision | null): void {
    this.match().afterStep(tick, worldHash32, decided);
    this.flush();
  }

  /** Game speed this frame: the slack trim (1 before the match). */
  speed(): number {
    return this.lockstep?.speed() ?? 1;
  }

  /** The player paused (the pause menu). */
  setPaused(paused: boolean): void {
    this.userPaused = paused;
    this.applyPause();
  }

  /** The page was hidden or shown (visibilitychange): hidden pauses, at once, without touching the player's pause. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.applyPause();
  }

  /**
   * Leave ("left") or abort ("desync"): the frames say so for END_FRAMES_MS,
   * then status().closable. Before this phone's GO there is nothing to tell;
   * from it until the match begins a stand-in says it; after a decided match
   * "left" keeps the end report on the air (see the header). The first call
   * counts.
   */
  leave(reason: "left" | "desync" = "left"): void {
    if (this.closed || this.leftAt !== null) return;
    this.leftAt = this.transport.now();
    if (!this.ls) {
      this.keyAtGo();
      const m = this.agreedShape();
      if (!m) return;
      // (loading, or GO on the air without a result yet: a lockstep that never steps, only to say the end to a friend
      // that may have begun)
      this.ls = this.lockstepFor(m, 0);
      this.standIn = true;
      this.takeEarly();
    }
    if (reason === "desync" || this.ls.status().end !== "decided") this.ls.leave(reason);
    this.flush();
  }

  /** Close the link. Safe at any time; status().closable says when nothing is lost by it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  // ------------------------------------------------------------- reading ---

  get phase(): SessionPhase {
    if (this.closed) return "closed";
    if (this.ls) return this.ls.over() ? "ended" : "match";
    return this.pairing.result() ? "starting" : "pairing";
  }

  status(): SessionStatus {
    const now = this.transport.now();
    const link = this.transport.stats();
    const pairing = this.atStart ?? this.pairing.state();
    const ls = this.ls?.status() ?? null;
    const shown = this.standIn ? null : ls;
    const peerEnd = ls?.peerEnd;
    // (a stall waits on the friend loading or paused only while it is still heard: past that, its packets aren't arriving)
    const heard = this.peerLast && now - this.peerLast.at <= PEER_HEARD_MS ? this.peerLast : null;
    return {
      phase: this.phase,
      role: this.role,
      pairing,
      result: this.pairing.result(),
      lockstep: ls,
      link,
      rttMs: pairing.rtt.median,
      rxq: this.rxq,
      peerRxq: shown?.peerRxq ?? pairing.peerRxq,
      mode: { tx: this.tx, air: link.txMode, rx: link.rxMode, start: this.startMode, switches: this.switches, last: this.lastSwitch },
      packets: { ...this.counts },
      peerStarted: this.peerStarted || (shown?.framesIn ?? 0) > 0,
      peerEnded: !ls ? this.earlyEnd : peerEnd === "left" || peerEnd === "desync" ? peerEnd : null,
      waiting:
        shown && shown.stalled && !this.ls!.over()
          ? { why: heard?.lobby ? "load" : heard && shown.peerPaused ? "paused" : "link", ms: now - Math.max(shown.lastNewTurnAt, shown.peerResumedAt) }
          : null,
      leaving: this.leftAt !== null,
      closable: this.closable(now, ls)
    };
  }

  private closable(now: number, ls: LockstepStatus | null): boolean {
    if (this.closed) return true;
    if (this.leftAt === null) return false;
    // (nothing to tell, or nobody to tell it: a friend that left or desynced has its end already)
    if (!ls || ls.peerEnd === "left" || ls.peerEnd === "desync") return true;
    return now - this.leftAt >= END_FRAMES_MS;
  }

  // ------------------------------------------------------------ the link ---

  private match(): Lockstep {
    const ls = this.lockstep;
    if (!ls) throw new Error("the match hasn't begun");
    return ls;
  }

  private lockstepFor(m: MatchShape, setupHash: number): Lockstep {
    const size = mapById(m.mapId).size;
    const ls = new Lockstep({
      local: m.local, delay: m.delay, mapWidth: size, mapHeight: size, capacity: this.transport.capacity(), setupHash,
      now: () => this.transport.now(), segmentsMax: this.segmentsMax
    });
    const st = this.transport.stats();
    ls.setPacketMs(packetMs(st.plan, st.txMode));
    return ls;
  }

  /**
   * The match as far as this phone has agreed to it: the result, or, once its
   * GO is set and the link keyed, the pairing's config and side (the friend
   * may have started on that GO alone). Null before.
   */
  private agreedShape(): MatchShape | null {
    const r = this.pairing.result();
    if (r) return r;
    const s = this.pairing.state();
    return s.go && s.config && s.side && this.keyedFor !== null ? { local: s.side, delay: s.config.delay, mapId: s.config.mapId } : null;
  }

  /** The new lockstep takes the friend's newest game frame from before it existed: its turns, and whether it has gone. */
  private takeEarly(): void {
    const e = this.early;
    this.early = null;
    if (!e || !this.ls) return;
    if (this.ls.receive(e.bits, e.nbits, e.at) !== "game") return;
    // (counted as ignored when it arrived: it was taken after all)
    this.counts.ignored--;
    this.heardGame(e.at);
  }

  /** The friend of the pairing the link was keyed for is no one's now: the pairing started over, or is keyed afresh. */
  private forgetPeer(): void {
    this.peerNonce = 0;
    this.peerStarted = false;
    this.early = null;
    this.earlyEnd = null;
    this.peerLast = null;
  }

  /** A lobby frame from the friend of this pairing (its role and nonce): it hasn't begun its match. Null: someone else's, or none. */
  private fromPeer(p: LinkPacket): LobbyFrame | null {
    if (this.peerNonce === 0) return null;
    try {
      const f = readLobbyFrame(p.bits, p.nbits);
      return f.role !== this.role && f.nonce === this.peerNonce ? f : null;
    } catch (e) {
      if (e instanceof CodecError) return null;
      throw e;
    }
  }

  private sendLobby(): void {
    this.transport.send([{ ...this.pairing.frame(), key: 0 }]);
  }

  /** The lockstep's frames to the link, if they changed. */
  private flush(): void {
    if (!this.ls || this.closed) return;
    const f = this.ls.frames();
    if (f.version === this.sent) return;
    this.transport.send(f.frames);
    this.sent = f.version;
  }

  private applyPause(): void {
    if (!this.ls || this.standIn || this.closed) return;
    this.ls.setPaused(this.userPaused || this.hidden);
    this.flush();
  }

  /** One packet from the link, to the protocol it belongs to (`lobby`: the pairing still runs). */
  private route(p: LinkPacket, lobby: boolean): void {
    this.counts.in++;
    const type = p.nbits >= 2 && p.bits.length ? p.bits[0]! >> 6 : 0;
    // (the session CRC, whatever the link does: a game frame of another pairing, or of none, is nothing here)
    if (type === TYPE_GAME && !p.session) {
      this.counts.ignored++;
      return;
    }
    if (!this.ls) {
      if (type === TYPE_GAME) {
        this.counts.ignored++;
        // (only under the key of this pairing's GO: before it, or after the pairing started over, the link may still
        // pass an earlier pairing's frames as session frames, since no transport can unset a key)
        if (lobby && this.keyedFor !== null && this.heardEarly(p)) this.pairing.receive(p);
      } else if (lobby) {
        if (type === TYPE_LOBBY && this.fromPeer(p)) this.peerLast = { at: p.at, lobby: true };
        this.pairing.receive(p);
      }
      return;
    }
    const took = this.ls.receive(p.bits, p.nbits, p.at);
    if (took === "game") {
      this.heardGame(p.at);
      this.peerLast = { at: p.at, lobby: false };
    } else if (took === "lobby") {
      // (any lobby frame tells the lockstep the friend is in the lobby, which after the match is the rematch hint: a
      // reloaded page has a new nonce. During it only the friend's own GO frames mean it is still loading, and say what
      // it hears of this phone: the mode rule's report until its game frames come)
      const f = this.fromPeer(p);
      if (f) {
        this.peerLast = { at: p.at, lobby: true };
        this.heardRxq(p.at, f.rxq);
      }
    } else this.counts.ignored++;
  }

  /**
   * A game frame of this pairing before this phone's lockstep exists: the
   * friend has started. It is dropped, as it repeats until acknowledged, but
   * the newest is kept for the lockstep (a friend that has left stops sending
   * after 2 s, and this phone may load for longer). False if it says the friend
   * left or aborted: that starts nothing here (its result may never come, and
   * the friend has gone either way).
   */
  private heardEarly(p: LinkPacket): boolean {
    this.early = { bits: p.bits, nbits: p.nbits, at: p.at };
    this.peerLast = { at: p.at, lobby: false };
    const end = END_CODES[endField(p.bits)]!;
    if (end === "left" || end === "desync") this.earlyEnd ??= end;
    if (this.earlyEnd !== null) return false;
    this.peerStarted = true;
    return true;
  }

  /** At GO: key the link for this pairing (the starting mode waits for beginMatch: see the header); forget it if the pairing starts over after GO. */
  private keyAtGo(): void {
    const s = this.pairing.state();
    if (s.go && s.nonces && s.config) {
      const key = `${s.nonces.host}:${s.nonces.guest}`;
      if (this.keyedFor === key) return;
      this.forgetPeer();
      this.keyedFor = key;
      this.peerNonce = this.role === "host" ? s.nonces.guest : s.nonces.host;
      this.transport.setSessionKey(s.nonces.host, s.nonces.guest);
      this.startMode = s.config.fast ? "fast" : "robust";
    } else if (this.keyedFor !== null && !s.go) {
      this.forgetPeer();
      this.keyedFor = null;
      this.startMode = null;
    }
  }

  // ------------------------------------------------------- the mode rule ---

  /** A game frame the lockstep took: when the friend's game frames arrive, and what it says of this phone's signal. */
  private heardGame(at: number): void {
    if (at - this.lastGameAt > PEER_GAP_MS) this.gameSince = at;
    this.lastGameAt = at;
    this.heardRxq(at, this.ls!.status().peerRxq);
  }

  /** A frame of the friend's (a game frame, or its own lobby frame once this phone began), and its receive quality of this phone (null: none). */
  private heardRxq(at: number, q: number | null): void {
    // (after a gap the runs start over: what the friend said before it says nothing of now)
    if (at - this.lastHeardAt > PEER_GAP_MS) this.lowSince = this.highSince = null;
    this.lastHeardAt = at;
    if (q === null) return;
    if (q <= ROBUST_RXQ) {
      this.lowSince ??= at;
      this.highSince = null;
    } else if (q >= FAST_RXQ) {
      this.highSince ??= at;
      this.lowSince = null;
    } else this.lowSince = this.highSince = null;
  }

  /** This phone's transmit mode during the match (see the header). */
  private adaptMode(): void {
    const ls = this.ls!;
    if (!this.adapt || this.standIn || ls.over()) return;
    const now = this.transport.now();
    const s = ls.status();
    // (nothing outstanding counts as progress: paused, or stalled with everything sealed acknowledged; and so does a
    // paused friend, whose acknowledgements say nothing of this phone's signal: a hidden page may get no frames and no
    // timers, its lockstep fed nothing, while its link repeats the paused frame it handed over on the way out)
    if (s.peerAck !== this.peerAckSeen || s.peerAck >= s.newestSealed || s.peerPaused) {
      this.peerAckSeen = s.peerAck;
      this.peerAckAt = now;
    }
    if (this.tx === "fast" && now - this.fastSince >= FAST_SETTLED_MS) this.fastWait = FAST_AFTER_MS;
    if (now - this.switchedAt < SWITCH_HOLD_MS || now - this.lastHeardAt > PEER_GAP_MS) return;
    if (this.tx === "fast") {
      if (this.lowSince !== null && now - this.lowSince >= ROBUST_AFTER_MS) this.setTx("robust", "rxq");
      // (counted from when the friend's game frames last started arriving: right after an outage they still carry old
      // acks, for the latency and a packet; and a turn sealed after a spell with nothing outstanding is acknowledged a
      // round trip and up to two packets later, which at the longest round trips pairing allows is more than 1.5 s)
      else if (
        now - this.lastGameAt <= PEER_GAP_MS &&
        now - Math.max(this.peerAckAt, this.gameSince) >= Math.max(ACK_STALL_MS, (this.atStart?.rtt.median ?? 0) + ACK_RTT_SPARE_MS)
      ) {
        this.setTx("robust", "acks");
        this.fastWait = Math.min(FAST_AFTER_MAX_MS, this.fastWait * 2);
      }
    } else if (this.highSince !== null && now - this.highSince >= this.fastWait) this.setTx("fast", "rxq");
  }

  private setTx(mode: ModemMode, why: ModeReason): void {
    if (mode === this.tx) return;
    const now = this.transport.now();
    this.transport.setMode(mode);
    this.tx = mode;
    this.switchedAt = now;
    // (the waits count from the switch: a friend that kept saying "good" while fast failed it mustn't bring it straight back)
    this.lowSince = this.highSince = null;
    if (mode === "fast") this.fastSince = now;
    this.lastSwitch = { at: now, to: mode, why };
    if (why === "rxq" || why === "acks") this.switches++;
  }
}
