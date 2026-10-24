/**
 * The in-page friend for `?duel=loop` (DUEL.md "Dev and test modes"):
 * a duel with no sound. The page's session and a second one, the
 * friend's, sit on the two ends of a PacketAir, and the friend plays its own
 * setupWorld copy of the match with a normal-difficulty AI (incomeMult 1, the
 * same as an untouched side, so the two worlds stay identical). Everything
 * above the link is the real thing: pairing, opener picks, GO, lockstep, the
 * hash trail and the end check.
 *
 * Real time drives it: pump() advances the air to performance.now() and lets
 * the friend take its frame (its session pumped, its ticks stepped as the
 * slack trim allows). The lobby pumps it every frame, the feed's onFrame
 * does in the match, and a timer of its own covers a hidden page and the art
 * loading in between.
 *
 * Where the spec is silent:
 *  - the page takes whichever role its player taps, and the friend the
 *    other. Either way the host offers the menu's map and mutators; the page
 *    plays blue unless `&side=red` (or a rematch's stored side) says red;
 *  - `&delay=D` forces the input delay without touching the pairing: both
 *    ends hold what they receive in the lobby, so the pairing measures the
 *    round trip that gives D (lobbyLatencyFor: the middle of D's 100 ms in
 *    pairing.ts delayFor, for the fast start a clean lobby link gets), and
 *    from GO on (each end's setSessionKey) the hold drops to what makes
 *    `&latency` the match's one-way latency. The air itself runs at the
 *    smaller of the two latencies. Without `&delay`, D comes from the latency
 *    as it would over the air (250 ms: D = 4). A pairing that starts over
 *    after GO keeps the match's latency. The lobby's round trip is the hold's
 *    doing, so on the loop the lobby's meter names the agreed input delay
 *    instead (lobby.ts rttLine);
 *  - `&loss` is Bernoulli loss both ways from the first GO on: the lobby
 *    pairs on a clean link, so its starting mode (fast at the air's 30 dB),
 *    and with it a forced D, comes out as asked;
 *  - the friend picks a random opener of those offered 1.2 s after the cards
 *    go up, starts its match as soon as both said GO (it loads nothing), and
 *    never pauses, resigns or leaves: after the end it keeps its end report
 *    on the air until the page closes the loop;
 *  - the friend's AI is the game's commander with a random strategy; its
 *    nonces, the air's phases and loss, its opener and strategy all come from
 *    one seed.
 */
import { PacketAir } from "../link/packet-air";
import type { BandRole, LinkPacket, LinkStats, LinkTransport, ModemMode, OutFrame } from "../link/transport";
import { createAiState, DIFFICULTY, tickAi, type AiState } from "../sim/ai/commander";
import { worldHash } from "../sim/checksum";
import { hash32 } from "../sim/rand";
import { setupWorld } from "../sim/setup";
import { step } from "../sim/sim";
import type { Faction, World } from "../sim/types";
import { DELAY_MARGIN_MS, packetMs, type HostOffer } from "./pairing";
import { Session } from "./session";

/** `?duel=loop`'s link: the input delay to force (null: what the latency gives), loss 0–0.9, one-way latency (ms). */
export interface LoopParams {
  delay: number | null;
  loss: number;
  latencyMs: number;
}

/** The sim's tick (ms). */
const TICK_MS = 100;
/** The friend catches up at most this many ticks a frame (a frame after a hidden spell holds no more). */
const CATCH_UP_TICKS = 8;
/** The loop's own timer (ms): a hidden page, and frames the feed doesn't get (the art loading). */
const TIMER_MS = 50;
/** The friend picks its opener this long after the cards go up. */
const PICK_AFTER_MS = 1200;

/**
 * The one-way latency (ms) at which the pairing measures a round trip that
 * gives input delay D with a fast start (pairing.ts delayFor: D = ceil((rtt /
 * 2 + P + M) / 100)): rtt / 2 in the middle of D's 100 ms, so the 10 ms
 * rounding of `hold` can't tip it. 120 ms for D = 3, 620 for D = 8.
 */
export const lobbyLatencyFor = (delay: number): number => 100 * delay - 50 - packetMs("high", "fast") - DELAY_MARGIN_MS;

/** Uniform in [0, 1) from a seed, a stream and a counter. */
export function seededRandom(seed: number, stream: number): () => number {
  let i = 0;
  return () => hash32(seed, stream, i++) / 4294967296;
}

/**
 * One end of the air, holding what it receives for a while: `lobbyMs` until
 * the session keys the link at GO, then `matchMs` (packets keep their order).
 * `onKey` hears of the key (the loop's loss starts then).
 */
export class HeldEnd implements LinkTransport {
  private held: LinkPacket[] = [];
  private lastDue = -Infinity;
  private extra: number;

  constructor(
    readonly inner: LinkTransport,
    lobbyMs: number,
    private readonly matchMs: number,
    private readonly onKey: (() => void) | null = null
  ) {
    this.extra = lobbyMs;
  }

  capacity(): number {
    return this.inner.capacity();
  }

  send(frames: readonly OutFrame[]): void {
    this.inner.send(frames);
  }

  poll(): LinkPacket[] {
    const now = this.inner.now();
    for (const p of this.inner.poll()) {
      // (a hold that drops at GO mustn't let a later packet overtake an earlier one)
      const at = Math.max(p.at + this.extra, this.lastDue);
      this.lastDue = at;
      this.held.push({ ...p, at });
    }
    let n = 0;
    while (n < this.held.length && this.held[n]!.at <= now) n++;
    return n ? this.held.splice(0, n) : [];
  }

  slots(): number[] {
    return this.inner.slots();
  }

  now(): number {
    return this.inner.now();
  }

  setMode(mode: ModemMode): void {
    this.inner.setMode(mode);
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.extra = this.matchMs;
    this.inner.setSessionKey(hostNonce, guestNonce);
    this.onKey?.();
  }

  stats(): LinkStats {
    return this.inner.stats();
  }

  close(): void {
    this.held = [];
    this.inner.close();
  }
}

export interface LoopFriendOptions {
  transport: LinkTransport;
  role: BandRole;
  build: number;
  /** Required when the friend hosts. */
  offer?: HostOffer;
  seed: number;
  /** After each tick it steps (tests compare the two worlds). */
  onStep?: (tick: number, w: World) => void;
}

/** The friend: its own session, world and AI, stepped in real time on the link's clock. */
export class LoopFriend {
  readonly session: Session;
  /** Its world, once the match began. */
  world: World | null = null;
  side: Faction | null = null;
  private ai: AiState | null = null;
  private acc = 0;
  private last: number | null = null;
  private cardsAt: number | null = null;
  private readonly pickRandom: () => number;
  private readonly seed: number;
  private readonly onStep: ((tick: number, w: World) => void) | null;

  constructor(o: LoopFriendOptions) {
    this.seed = o.seed;
    this.onStep = o.onStep ?? null;
    this.pickRandom = seededRandom(o.seed, 0x91c4);
    this.session = new Session({
      transport: o.transport,
      role: o.role,
      build: o.build,
      ...(o.role === "host" && o.offer ? { host: o.offer } : {}),
      random: seededRandom(o.seed, 0x40ce)
    });
  }

  /** One frame: pump the session, pick, begin, and step the ticks the clock allows. */
  update(): void {
    const s = this.session;
    if (s.phase === "closed") return;
    const now = s.transport.now();
    const dt = this.last === null ? 0 : Math.max(0, now - this.last);
    this.last = now;
    s.pump();
    if (s.phase === "pairing") {
      const st = s.pairing.state();
      if (st.phase === "picking" && st.offered.length) {
        this.cardsAt ??= now;
        if (now - this.cardsAt >= PICK_AFTER_MS) s.pick(st.offered[Math.floor(this.pickRandom() * st.offered.length)]!);
      } else this.cardsAt = null;
    } else if (s.phase === "starting" && !s.status().leaving) this.begin();
    const ls = s.lockstep;
    const w = this.world;
    if (!ls || !w || !this.side || !this.ai) return;
    // (after a hidden spell: hold, no burst; the lockstep paces it against the page anyway)
    this.acc = Math.min(this.acc + dt * s.speed(), CATCH_UP_TICKS * TICK_MS);
    const side = this.side;
    const ai = this.ai;
    for (let n = 0; this.acc >= TICK_MS && n < CATCH_UP_TICKS && !w.winner && !ls.over(); n++) {
      const t = w.tick;
      const cmds = s.commandsFor(t, () => tickAi(w, side, ai));
      if (!cmds) {
        this.acc = TICK_MS * 0.999;
        break;
      }
      step(w, cmds);
      s.afterStep(t, parseInt(worldHash(w), 16), w.winner ? { winner: w.winner, resigned: w.resigned ?? null } : null);
      this.acc -= TICK_MS;
      this.onStep?.(t, w);
    }
  }

  close(): void {
    this.session.close();
  }

  private begin(): void {
    const r = this.session.result()!;
    const w = setupWorld(r.setup);
    this.side = r.local;
    const pool = DIFFICULTY.normal.pool;
    this.ai = createAiState(pool[Math.floor(this.pickRandom() * pool.length)], "normal", hash32(this.seed, 0xa1));
    this.session.beginMatch(parseInt(worldHash(w), 16));
    this.world = w;
  }
}

export interface LoopTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface LoopLinkOptions {
  params: LoopParams;
  /** The page's role; the friend takes the other. */
  role: BandRole;
  /** What the host offers, whichever phone hosts: the menu's map and mutators, and the host's side. */
  offer: HostOffer;
  build: number;
  /** The air's phases and loss, and everything the friend draws. */
  seed: number;
  /** Real time (default performance.now). */
  now?: () => number;
  /** The loop's own timer (default the window's); null: only pump() drives it. */
  timers?: LoopTimers | null;
}

/** The page's end of the loop and the friend on the other, on one PacketAir run in real time. */
export class LoopLink {
  readonly air: PacketAir;
  /** The page's end: its session's transport. */
  readonly page: LinkTransport;
  readonly friend: LoopFriend;
  private readonly clock: () => number;
  private readonly timers: LoopTimers | null;
  private readonly timer: unknown = null;
  private last: number;
  private closed = false;

  constructor(o: LoopLinkOptions) {
    const p = o.params;
    const forced = p.delay === null ? null : lobbyLatencyFor(p.delay);
    const base = forced === null ? p.latencyMs : Math.min(p.latencyMs, forced);
    const air = (this.air = new PacketAir({ latencyMs: base, seed: o.seed >>> 0 || 1, mode: "robust" }));
    const lobbyHold = forced === null ? 0 : forced - base;
    const matchHold = p.latencyMs - base;
    let lossy = false;
    const onKey = () => {
      if (!lossy && p.loss > 0) air.setLoss(p.loss);
      lossy = true;
    };
    const end = (t: LinkTransport) => new HeldEnd(t, lobbyHold, matchHold, onKey);
    this.page = end(this.air.a);
    this.friend = new LoopFriend({
      transport: end(this.air.b),
      role: o.role === "host" ? "guest" : "host",
      build: o.build,
      offer: o.offer,
      seed: o.seed
    });
    this.clock = o.now ?? (() => performance.now());
    this.last = this.clock();
    this.timers = o.timers === undefined ? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as number) } : o.timers;
    if (this.timers) this.timer = this.timers.setInterval(() => this.pump(), TIMER_MS);
  }

  /** Run the air up to now, then the friend's frame. Call it as often as you like. */
  pump(): void {
    if (this.closed) return;
    const now = this.clock();
    if (now > this.last) this.air.advance(now - this.last);
    this.last = Math.max(this.last, now);
    this.friend.update();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timers && this.timer !== null) this.timers.clearInterval(this.timer);
    this.friend.close();
    this.page.close();
  }
}
