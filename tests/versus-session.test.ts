import { describe, expect, it } from "vitest";
import { PacketAir, type PacketAirOptions } from "../src/link/packet-air";
import type { LinkPacket, LinkStats, LinkTransport, ModemMode, OutFrame } from "../src/link/transport";
import { createAiState, tickAi, type AiState, type StrategyName } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { hash32 } from "../src/sim/rand";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { Command, Faction, World } from "../src/sim/types";
import { readGameFrame } from "../src/versus/lockstep";
import { delayFor, packetMs, readLobbyFrame, type HostOffer } from "../src/versus/pairing";
import {
  ACK_RTT_SPARE_MS, ACK_STALL_MS, END_FRAMES_MS, FAST_AFTER_MAX_MS, FAST_AFTER_MS, PEER_HEARD_MS, ROBUST_AFTER_MS, RX_SILENT_MS, SWITCH_HOLD_MS, Session, type SessionPhase,
  type SessionStatus
} from "../src/versus/session";

const BUILD = 0x5eed;
const TYPE_GAME = 1;
const TYPE_LOBBY = 2;
const typeOf = (p: { bits: Uint8Array }): number => p.bits[0]! >> 6;

const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0x5e55, i++) / 4294967296;
};

// ------------------------------------------------------------- the link ---

/**
 * A phone's link end, with a tap on it: everything the session hands over, every
 * packet it hears, the keys and modes it sets; and a way to slip packets in
 * (a replay, another pairing's frames) among what it hears.
 */
class Tap implements LinkTransport {
  readonly sent: { at: number; frames: readonly OutFrame[] }[] = [];
  readonly heard: LinkPacket[] = [];
  readonly keys: { host: number; guest: number; at: number }[] = [];
  readonly modes: { mode: ModemMode; at: number }[] = [];
  /** Packets to add to each poll (now: this link's clock). */
  hear: ((now: number) => LinkPacket[]) | null = null;
  /** Packets this phone never hears (a hand over its microphone at just the wrong moments). */
  drop: ((p: LinkPacket) => boolean) | null = null;

  constructor(readonly inner: LinkTransport) {}

  capacity(): number {
    return this.inner.capacity();
  }

  send(frames: readonly OutFrame[]): void {
    this.sent.push({ at: this.now(), frames });
    this.inner.send(frames);
  }

  poll(): LinkPacket[] {
    const drop = this.drop;
    const pks = drop ? this.inner.poll().filter((p) => !drop(p)) : this.inner.poll();
    if (this.hear) pks.push(...this.hear(this.now()));
    this.heard.push(...pks);
    return pks;
  }

  slots(): number[] {
    return this.inner.slots();
  }

  now(): number {
    return this.inner.now();
  }

  setMode(mode: ModemMode): void {
    this.modes.push({ mode, at: this.now() });
    this.inner.setMode(mode);
  }

  setSessionKey(host: number, guest: number): void {
    this.keys.push({ host, guest, at: this.now() });
    this.inner.setSessionKey(host, guest);
  }

  stats(): LinkStats {
    return this.inner.stats();
  }

  close(): void {
    this.inner.close();
  }
}

// ------------------------------------------------------- two phones ---

interface Phone {
  role: "host" | "guest";
  s: Session;
  tap: Tap;
  /** Animation frames: one every frameMs of air time. */
  frameMs: number;
  next: number;
  last: number;
  acc: number;
  /** The lobby: the cards went up at (air time), and this phone taps its pick this long after. */
  cardsAt: number | null;
  pickAfterMs: number;
  /** From the pairing's result to beginMatch (the match loading), and when the result came (this phone's clock). */
  loadMs: number;
  resultAt: number | null;
  begunAt: number | null;
  side: Faction | null;
  w: World | null;
  ai: AiState | null;
  paused: boolean;
  /** The page gets no frames and no timers (hidden, its JS suspended): no pump, no stepping; its link runs on. */
  asleep: boolean;
  /** The trail after each tick stepped. */
  trails: number[];
  /** Orders the scenario injects, drained with the AI's. */
  extra: Command[];
  /** The phases in the order seen. */
  phases: SessionPhase[];
  /** The longest wait seen, by why, and the tick it was at. */
  waited: Partial<Record<"load" | "paused" | "link", { ms: number; tick: number }>>;
  /** Every transmit mode change the session made, as its status said it (this phone's clock). */
  switchLog: { at: number; to: ModemMode; why: string }[];
}

/** What the two pages' link ends hang on (a PacketAir). */
interface Air {
  readonly a: LinkTransport;
  readonly b: LinkTransport;
  now(): number;
  advance(ms: number): void;
}

interface Run<A extends Air = PacketAir> {
  air: A;
  host: Phone;
  guest: Phone;
}

interface Scenario<A extends Air = PacketAir> {
  seed: number;
  /** Each phone steps at most this far. */
  ticks: number;
  offer?: HostOffer;
  air?: PacketAirOptions;
  /** The link (default: a PacketAir made with `air`). */
  link?: A;
  /** The driver's step (ms of air time, default 2). */
  stepMs?: number;
  /** Blue's AI and red's. */
  strategies?: [StrategyName, StrategyName];
  /** From the result to beginMatch, host's and guest's (ms). */
  loadMs?: [number, number];
  /** Before the loop (taps can be set up here). */
  prepare?: (r: Run<A>) => void;
  /** Every step, before the phones look. */
  every?: (r: Run<A>) => void;
  afterStep?: (p: Phone, tick: number, r: Run<A>) => void;
  /** Run until this holds (default: both phones at `ticks`, or ended). */
  until?: (r: Run<A>) => boolean;
}

function phone(role: "host" | "guest", link: LinkTransport, seed: number, offer: HostOffer, frameMs: number, loadMs: number, phaseMs: number): Phone {
  const tap = new Tap(link);
  const s = new Session({ transport: tap, role, build: BUILD, random: rng(seed), ...(role === "host" ? { host: offer } : {}) });
  return {
    role, s, tap, frameMs, next: phaseMs, last: 0, acc: 0, cardsAt: null, pickAfterMs: role === "host" ? 400 : 900, loadMs, resultAt: null, begunAt: null,
    side: null, w: null, ai: null, paused: false, asleep: false, trails: [], extra: [], phases: [], waited: {}, switchLog: []
  };
}

/** The page is hidden and its JS suspended (setHidden on the way out, as visibilitychange does), or it comes back. */
function sleep(p: Phone, asleep: boolean, now: number): void {
  if (asleep === p.asleep) return;
  if (asleep) p.s.setHidden(true);
  p.asleep = p.paused = asleep;
  if (!asleep) {
    p.s.setHidden(false);
    p.last = now; // (GameScene clamps the first delta after a hidden spell: no catch-up burst)
  }
}

/** A game frame's end field (0 playing, 1 left, 2 desync, 3 decided). */
const endOf = (f: { bits: Uint8Array }): number => (f.bits[0]! >> 3) & 3;
/** A lobby frame that says GO. */
const isGo = (p: { bits: Uint8Array; nbits: number }): boolean => typeOf(p) === TYPE_LOBBY && readLobbyFrame(p.bits, p.nbits).go;

/** Two phones, each with a Session on its end of the link (a PacketAir unless given): they pair, load and play, an AI on each side. */
function duel<A extends Air = PacketAir>(sc: Scenario<A>): Run<A> {
  const offer = sc.offer ?? { map: "riverlands", mutators: [] };
  const air = (sc.link ?? new PacketAir({ seed: sc.seed, clockOffsetMs: [0, 31_337], mode: "robust", ...sc.air })) as A;
  const [hl, gl] = sc.loadMs ?? [0, 0];
  const r: Run<A> = { air, host: phone("host", air.a, sc.seed * 2 + 1, offer, 16, hl, 3), guest: phone("guest", air.b, sc.seed * 2 + 2, offer, 11, gl, 0) };
  sc.prepare?.(r);
  const done = sc.until ?? ((r: Run<A>) => [r.host, r.guest].every((p) => (p.w !== null && p.w.tick >= sc.ticks) || p.s.phase === "ended" || p.s.phase === "closed"));
  const limit = air.now() + sc.ticks * 100 * 3 + 60_000;
  while (!done(r) && air.now() < limit) {
    air.advance(sc.stepMs ?? 2);
    sc.every?.(r);
    for (const p of [r.host, r.guest]) update(p, r, sc);
  }
  expect(air.now(), "the scenario ran out of time").toBeLessThan(limit);
  return r;
}

/** One animation frame of a phone: pump, the lobby's taps, loading, then the ticks the clock allows. */
function update<A extends Air>(p: Phone, r: Run<A>, sc: Scenario<A>): void {
  const now = r.air.now();
  if (now < p.next || p.asleep) return;
  const dt = now - p.last;
  p.last = now;
  p.next = now + p.frameMs;
  const s = p.s;
  s.pump();
  if (p.tap.modes.length > p.switchLog.length) p.switchLog.push({ ...s.status().mode.last! });
  const phase = s.phase;
  if (p.phases[p.phases.length - 1] !== phase) p.phases.push(phase);
  if (phase === "pairing") {
    const st = s.pairing.state();
    if (st.phase === "picking") {
      p.cardsAt ??= now;
      if (now - p.cardsAt >= p.pickAfterMs) expect(s.pick(st.offered[0]!)).toBe(true);
    } else p.cardsAt = null;
  } else if (phase === "starting" && !s.status().leaving) {
    p.resultAt ??= p.tap.now();
    if (p.tap.now() - p.resultAt >= p.loadMs) begin(p, sc);
  }
  const ls = s.lockstep;
  if (!p.w || !ls) return;
  if (!p.paused) p.acc += dt * s.speed();
  const w = p.w;
  for (let n = 0; p.acc >= 100 && n < 8 && w.tick < sc.ticks; n++) {
    const t = w.tick;
    const cmds = s.commandsFor(t, () => [...tickAi(w, p.side!, p.ai!), ...p.extra.splice(0)]);
    if (!cmds) {
      // (a turn sealed by a call that stalls is on the link already: no afterStep follows, and the next pump may be a frame away)
      if (!ls.over()) expect(newestSent(p), `${p.role} stalled at ${t}`).toBe(ls.status().newestSealed);
      p.acc = 99.9; // (GameScene: hold the pose, no catch-up burst)
      break;
    }
    step(w, cmds);
    s.afterStep(t, parseInt(worldHash(w), 16), w.winner ? { winner: w.winner, resigned: w.resigned } : null);
    p.trails[t] = ls.trail();
    p.acc -= 100;
    sc.afterStep?.(p, t, r);
    if (w.winner) break; // (GameScene stops stepping a decided world)
  }
  if (ls.status().stalled) {
    const wt = s.status().waiting;
    if (wt && wt.ms > (p.waited[wt.why]?.ms ?? -1)) p.waited[wt.why] = { ms: wt.ms, tick: w.tick };
  }
}

/** The newest turn the frames a phone last handed its link describe. */
function newestSent(p: Phone): number {
  const frames = p.tap.sent[p.tap.sent.length - 1]!.frames;
  const f = frames[frames.length - 1]!;
  return readGameFrame(f.bits, f.nbits, { width: 56, height: 56 }, p.side!, p.s.lockstep!.status().newestSealed).to;
}

/** The feed's start: the world from the agreed setup, then beginMatch with its hash. */
function begin<A extends Air>(p: Phone, sc: Scenario<A>): void {
  const res = p.s.result()!;
  const [bs, rs] = sc.strategies ?? ["balanced", "rush"];
  p.side = res.local;
  p.w = setupWorld(res.setup);
  p.ai = createAiState(res.local === "blue" ? bs : rs, "normal", hash32(sc.seed, res.local === "blue" ? 1 : 2));
  p.s.beginMatch(parseInt(worldHash(p.w), 16));
  p.begunAt = p.tap.now();
}

/** The first tick below `n` whose trails differ (−1: none). */
function firstDiff(r: { host: Phone; guest: Phone }, n: number): number {
  for (let t = 0; t < n; t++) if (r.host.trails[t] === undefined || r.host.trails[t] !== r.guest.trails[t]) return t;
  return -1;
}

/** Both phones played the same match: the same result, identical trails up to `n`, the same turns. */
function expectSameMatch(r: { host: Phone; guest: Phone }, n: number): void {
  const [h, g] = [r.host.s.result()!, r.guest.s.result()!];
  expect(g.setup).toEqual(h.setup);
  expect([g.delay, g.fast, g.hostNonce, g.guestNonce]).toEqual([h.delay, h.fast, h.hostNonce, h.guestNonce]);
  expect(g.local).not.toBe(h.local);
  expect(firstDiff(r, n)).toBe(-1);
  for (const p of [r.host, r.guest]) expect(p.s.lockstep!.status().desync).toBe(false);
}

/** The game frames a phone handed its link from its `from`-th send() on, decoded (near where it is now). */
function gameFramesSent(p: Phone, from: number): { at: number; end: string; to: number }[] {
  const out: { at: number; end: string; to: number }[] = [];
  for (const { at, frames } of p.tap.sent.slice(from))
    for (const f of frames)
      if (typeOf(f) === TYPE_GAME) {
        const g = readGameFrame(f.bits, f.nbits, { width: 56, height: 56 }, p.side!, p.s.lockstep?.status().ackThrough ?? 0);
        out.push({ at, end: g.end, to: g.to });
      }
  return out;
}

const FIVE_MINUTES = 3000;

// ------------------------------------------------------------- the tests ---

describe("a session from the lobby to the end of the match", () => {
  it("pairs, keys the link at GO, loads and plays five minutes in lockstep at 0% loss", { timeout: 120_000 }, () => {
    const r = duel({ seed: 1, ticks: FIVE_MINUTES, air: { latencyMs: 250, phaseMs: [30, 170] } });
    expectSameMatch(r, FIVE_MINUTES);
    const h = r.host.s.result()!;
    expect(h.fast).toBe(true); // (30 dB both ways)
    expect(h.delay).toBe(delayFor(500, packetMs("high", "fast")));
    for (const p of [r.host, r.guest]) {
      const st = p.s.status();
      expect(p.phases).toEqual(["pairing", "starting", "match"]);
      expect(p.w!.tick).toBe(FIVE_MINUTES);
      expect(st.rttMs).toBe(500);
      expect(st.lockstep!.stallMs).toBeLessThanOrEqual(300);
      expect(st.lockstep!.framesBad).toBe(0);
      expect(st.rxq).toBe(7);
      expect(st.peerRxq).toBe(7);
      expect(st.peerStarted).toBe(true);
      // the link was keyed once, with this pairing's nonces, before the match started; then fast, and nothing else
      expect(p.tap.keys.map(({ host, guest }) => [host, guest])).toEqual([[h.hostNonce, h.guestNonce]]);
      expect(p.tap.keys[0]!.at).toBeLessThanOrEqual(p.resultAt!);
      expect(p.tap.modes.map((m) => m.mode)).toEqual(["fast"]);
      expect(st.mode).toMatchObject({ tx: "fast", air: "fast", rx: "fast", start: "fast", switches: 0, last: { to: "fast", why: "start" } });
      // a lobby frame on every slot until the match began, then game frames only
      const firstGame = p.tap.sent.findIndex(({ frames }) => typeOf(frames[0]!) === TYPE_GAME);
      expect(p.tap.sent[firstGame]!.at).toBe(p.begunAt);
      expect(p.tap.sent.slice(0, firstGame).every(({ frames }) => frames.length === 1 && frames[0]!.key === 0 && typeOf(frames[0]!) === TYPE_LOBBY)).toBe(true);
      expect(p.tap.sent.slice(firstGame).every(({ frames }) => frames.every((f) => typeOf(f) === TYPE_GAME))).toBe(true);
      // every packet heard went somewhere, but the friend's first game frames while this phone loaded
      expect(st.packets.in).toBe(p.tap.heard.length);
      expect(st.packets.ignored).toBeLessThanOrEqual(3);
      expect(st.packets.out).toBeGreaterThan(2500); // (a packet every 100 ms for five minutes)
      expect(st.closable).toBe(false);
    }
  });

  // (pairing's D allows for no loss: 5 here, from a round trip of 503–504 ms and fast's 100 ms packets, just past D =
  // 4's 500. Loss costs stalls on top: at D = 4 they ran 3.2–3.6 s at 10% and 24 s at 30%)
  for (const [loss, seed, stall] of [[0.1, 2, 3_000], [0.3, 3, 12_000]] as const)
    it(`plays in lockstep at ${loss * 100}% loss`, { timeout: 120_000 }, () => {
      const r = duel({ seed, ticks: 2000, air: { loss, latencyMs: 250 }, strategies: ["airswarm", "boom"] });
      expectSameMatch(r, 2000);
      expect(r.host.s.status().rttMs).toBeGreaterThan(500);
      expect(r.host.s.result()!.delay).toBe(5);
      for (const p of [r.host, r.guest]) {
        expect(p.w!.tick).toBe(2000);
        expect(p.s.lockstep!.status().stallMs).toBeLessThanOrEqual(stall);
        // (the SNR says fast, and loss alone shouldn't make it flap)
        expect(p.s.status().mode.switches).toBeLessThanOrEqual(2);
      }
    });

  it("plays through 3 s outages: both ways, then each way, which sends that phone robust until its friend has heard it well for a while", { timeout: 120_000 }, () => {
    // at 60 s both ways (silence says nothing of modes); at 100 s the host's packets are lost, at 160 s the guest's:
    // the friend's frames keep arriving with no new acknowledgements, so that phone's link isn't getting through
    const cuts: [number, "both" | "ab" | "ba"][] = [[60_000, "both"], [100_000, "ab"], [160_000, "ba"]];
    const cutAt: Record<string, number> = {};
    let silentRxq: number[] = [];
    const r = duel({
      seed: 4, ticks: 2400, air: { latencyMs: 250 },
      every: (r) => {
        if (!silentRxq.length && cutAt.both !== undefined && r.air.now() >= cutAt.both + 2000) silentRxq = [r.host, r.guest].map((p) => p.s.status().rxq);
        while (cuts.length && r.air.now() >= cuts[0]![0]) {
          const [at, d] = cuts.shift()!;
          cutAt[d] = at;
          r.air.outage(3000, d);
        }
      }
    });
    expect(cuts).toEqual([]);
    expectSameMatch(r, 2400);
    const stalls = [r.host, r.guest].map((p) => p.s.lockstep!.status().stallMs);
    expect(Math.max(...stalls)).toBeGreaterThan(2500); // (the outages really stalled the match)
    // hearing nothing for over a second, each phone's receive quality read 0
    expect(silentRxq).toEqual([0, 0]);
    for (const st of stalls) expect(st).toBeLessThanOrEqual(15_000);
    // each phone went robust once, in its own outage, on the acknowledgement rule, and came back to fast only after
    // twice the usual wait of good reports (the fallback wasn't the SNR's doing); the two-way outage switched nothing.
    // (The friend's reports during the cut are its frames from before it, repeated: a stalled lockstep rebuilds none,
    // so its quality of this phone reads as it was. The wait counts from the switch, and at most from the cut's end.)
    const offset = { host: 0, guest: 31_337 };
    for (const [p, d] of [[r.host, "ab"], [r.guest, "ba"]] as const) {
      const modes = p.tap.modes.map(({ mode, at }) => ({ mode, at: at - offset[p.role] }));
      expect(modes.map((m) => m.mode), p.role).toEqual(["fast", "robust", "fast"]);
      const [, robust, fast] = modes as [unknown, { at: number }, { at: number }];
      // (the cut loses packets that start in it; the friend's frames carry the acks of what it heard last)
      expect(robust.at - cutAt[d]!, p.role).toBeGreaterThanOrEqual(ACK_STALL_MS);
      expect(robust.at - cutAt[d]!, p.role).toBeLessThanOrEqual(ACK_STALL_MS + 1000);
      expect(fast.at - robust.at, p.role).toBeGreaterThanOrEqual(2 * FAST_AFTER_MS);
      expect(fast.at - (cutAt[d]! + 3000), p.role).toBeLessThanOrEqual(2 * FAST_AFTER_MS + 1500);
      expect(p.s.status().mode).toMatchObject({ switches: 2, tx: "fast", last: { to: "fast", why: "rxq" } });
    }
  });

  it("holds the phone that loaded first at tick D, \"waiting for your friend to load\", until its friend begins 3 s later", { timeout: 120_000 }, () => {
    for (const late of ["guest", "host"] as const) {
      let waitSeen: SessionStatus | null = null;
      const r = duel({
        seed: 5, ticks: 1000, loadMs: late === "guest" ? [0, 3000] : [3000, 0],
        every: (r) => {
          const early = late === "guest" ? r.host : r.guest;
          const slow = r[late];
          if (!waitSeen && slow.s.phase === "starting" && slow.resultAt !== null && slow.tap.now() - slow.resultAt >= 2500) waitSeen = early.s.status();
        }
      });
      expectSameMatch(r, 1000);
      const [early, slow] = late === "guest" ? [r.host, r.guest] : [r.guest, r.host];
      const D = r.host.s.result()!.delay;
      // what the early phone's HUD read with its friend 2.5 s into loading: stalled at tick D, its friend in the lobby
      const st = waitSeen as SessionStatus | null;
      expect(st, late).not.toBeNull();
      expect(st!.phase).toBe("match");
      expect(st!.lockstep).toMatchObject({ tick: D, stalled: true, peerInLobby: true });
      expect(st!.waiting!.why).toBe("load");
      expect(st!.waiting!.ms).toBeGreaterThanOrEqual(2500 - D * 100 - 300);
      expect(early.waited.load!.tick).toBe(D);
      // (once the friend's first game frame arrives it is no longer loading; its first turn rides the next one)
      if (early.waited.link) expect(early.waited.link.tick).toBe(D);
      // the slow phone stayed in "starting" for its 3 s, with its GO frame on the air, and the friend's game frames dropped
      expect(slow.begunAt! - slow.resultAt!).toBeGreaterThanOrEqual(3000);
      expect(slow.phases).toEqual(["pairing", "starting", "match"]);
      expect(slow.s.status().packets.ignored).toBeGreaterThan(15);
      const goFrames = slow.tap.sent.filter(({ at }) => at > slow.resultAt! && at < slow.begunAt!);
      expect(goFrames.length).toBeGreaterThan(10);
      for (const { frames } of goFrames) expect(readLobbyFrame(frames[0]!.bits, frames[0]!.nbits).go).toBe(true);
      // and the early phone's stall is the friend's load
      expect(early.s.lockstep!.status().stallMs).toBeGreaterThanOrEqual(2500);
      expect(early.s.lockstep!.status().stallMs).toBeLessThanOrEqual(3800);
      // which says nothing of either link: no acknowledgement came in those 3 s, but none could, and the wait for
      // them counts from the friend's first game frame
      for (const p of [early, slow]) expect(p.switchLog.map((x) => x.why), `${late} late, ${p.role}`).toEqual(["start"]);
    }
  });

  it("passes pause and background through: the frame says paused at once, and showing the page leaves the player's pause alone", { timeout: 120_000 }, () => {
    // the host: at 30 s the player pauses, at 33 s switches away, at 36 s comes back (still paused), at 38 s plays on;
    // at 50 s it switches away mid-play, and comes back at 53 s
    const plan: [number, (h: Phone) => void][] = [
      [30_000, (h) => h.s.setPaused(true)], [33_000, (h) => h.s.setHidden(true)], [36_000, (h) => h.s.setHidden(false)],
      [38_000, (h) => h.s.setPaused(false)], [50_000, (h) => h.s.setHidden(true)], [53_000, (h) => h.s.setHidden(false)]
    ];
    const pausedOf = (f: OutFrame) => (f.bits[0]! >> 5) & 1;
    let sealed = 0;
    const r = duel({
      seed: 22, ticks: 900,
      every: (r) => {
        const h = r.host;
        while (plan.length && r.air.now() >= plan[0]![0]) {
          const [at, act] = plan.shift()!;
          const n = h.tap.sent.length;
          act(h);
          const ls = h.s.lockstep!.status();
          // (the feed stops stepping while the session is paused or hidden, as GameScene and a hidden page do)
          h.paused = ls.paused;
          if (at === 50_000) {
            // switching away mid-play: the paused frame is on the link there and then, before any pump
            expect(h.tap.sent.length).toBe(n + 1);
            expect(h.tap.sent[n]!.frames.every((f) => pausedOf(f) === 1)).toBe(true);
          }
          expect(ls.paused, `at ${at}`).toBe(at === 30_000 || at === 33_000 || at === 36_000 || at === 50_000);
        }
      },
      afterStep: (p, t) => {
        // a sealed turn goes to the link from commandsFor itself, not at the next pump
        if (p.role !== "host" || t % 100) return;
        const sent = p.tap.sent[p.tap.sent.length - 1]!.frames;
        const newest = sent[sent.length - 1]!;
        expect(readGameFrame(newest.bits, newest.nbits, { width: 56, height: 56 }, p.side!, t).to).toBe(p.s.lockstep!.status().newestSealed);
        sealed++;
      }
    });
    expect(plan).toEqual([]);
    expectSameMatch(r, 900);
    expect(sealed).toBe(9);
    // the friend stalled on "Friend paused" (8 s of the player's pause and switching away, then 3 s)
    expect(r.guest.waited.paused!.ms).toBeGreaterThan(7000);
    // (and never long on the link: a moment at the start, while the host's first turn followed its first frame)
    expect(r.guest.waited.link?.ms ?? 0).toBeLessThan(1000);
  });

  it("starts over cleanly when the pairing restarts after GO: its frame on the link at once, still in the lobby's mode, a fresh key", { timeout: 60_000 }, () => {
    // the guest picks last, so it says GO first: it retries the moment its link is keyed, before its GO goes out
    let old: number | null = null;
    const r = duel({
      seed: 18, ticks: 300,
      prepare: (r) => {
        r.host.pickAfterMs = 200;
        r.guest.pickAfterMs = 1500;
      },
      every: (r) => {
        const g = r.guest;
        if (old !== null || g.tap.keys.length !== 1) return;
        expect(g.s.pairing.state().go).toBe(true);
        old = g.s.pairing.state().nonce;
        const n = g.tap.sent.length;
        g.s.retry();
        // (the frame the link held was the old pairing's GO: the new pairing's replaces it there and then)
        expect(g.tap.sent.length).toBe(n + 1);
        const f = g.tap.sent[n]!.frames[0]!;
        expect(readLobbyFrame(f.bits, f.nbits)).toMatchObject({ nonce: g.s.pairing.state().nonce, go: false });
        expect(g.s.pairing.state().nonce).not.toBe(old);
      }
    });
    expectSameMatch(r, 300);
    const res = r.guest.s.result()!;
    expect(r.guest.tap.keys.map(({ host, guest }) => [host, guest])).toEqual([[r.guest.tap.keys[0]!.host, old], [res.hostNonce, res.guestNonce]]);
    // (GO left the mode alone: the starting mode comes with the match, once)
    expect(r.guest.switchLog.map((x) => [x.to, x.why])).toEqual([["fast", "start"]]);
    expect(r.guest.tap.modes).toEqual([{ mode: "fast", at: r.guest.begunAt }]);
    // the host never said GO to the old nonce: it took the guest's next incarnation and paired again
    expect(r.host.tap.keys.length).toBe(1);
    expect(r.host.s.status().pairing.restarts).toBe(1);
  });
});

describe("what keeps a session to its own pairing", () => {
  /** A match's game frames as one phone handed them out, timed from its beginMatch: a tape. */
  function tapeOf(p: Phone): { rel: number; frames: readonly OutFrame[] }[] {
    return p.tap.sent.filter(({ at, frames }) => at >= p.begunAt! && typeOf(frames[0]!) === TYPE_GAME).map(({ at, frames }) => ({ rel: at - p.begunAt!, frames }));
  }

  /** Play a tape into a phone's hearing from its beginMatch on, each frame list once, as packets of the given CRC verdict. */
  function playTape(p: Phone, tape: { rel: number; frames: readonly OutFrame[] }[], session: boolean): { played: number } {
    const out = { played: 0 };
    let i = 0;
    p.tap.hear = (now) => {
      if (p.begunAt === null) return [];
      const pks: LinkPacket[] = [];
      for (; i < tape.length && tape[i]!.rel <= now - p.begunAt; i++)
        for (const f of tape[i]!.frames) {
          pks.push({ bits: f.bits, nbits: f.nbits, snrDb: 30, at: now, session });
          out.played++;
        }
      return pks;
    };
    return out;
  }

  it("ignores game frames that didn't pass the session CRC: another pairing's match can't get in", { timeout: 120_000 }, () => {
    // an earlier pairing's match on the same map: the host's frames, which describe the same turns as this match's
    const earlier = duel({ seed: 6, ticks: 800 });
    const tape = tapeOf(earlier.host);
    expect(tape.length).toBeGreaterThan(500);
    // the guest of a new pairing hears that tape as well as its own host, each frame some 250 ms ahead of the same
    // turn's real frame: on a link that keys nothing (a relay) it arrives without the session CRC
    let played = { played: 0 };
    const r = duel({ seed: 7, ticks: 800, prepare: (r) => void (played = playTape(r.guest, tape, false)) });
    expectSameMatch(r, 800);
    expect([r.host.s.result()!.hostNonce, r.host.s.result()!.guestNonce]).not.toContain(earlier.host.s.result()!.hostNonce);
    expect(played.played).toBeGreaterThan(500);
    expect(r.guest.s.status().packets.ignored).toBeGreaterThanOrEqual(played.played);
    // the control: had they passed (a CRC collision), the match would have forked, and the trail caught it
    const forked = duel({ seed: 7, ticks: 800, prepare: (r) => void playTape(r.guest, tape, true), until: (r) => r.guest.s.phase === "ended" || (r.guest.w?.tick ?? 0) >= 800 });
    expect(forked.guest.s.lockstep!.status().desync).toBe(true);
  });

  it("can't be started by lobby frames replayed from an earlier session", { timeout: 120_000 }, () => {
    // session 1: a pairing to the match, every lobby frame each phone sent taped with its time
    const s1 = duel({ seed: 8, ticks: 50 });
    const tapeOfLobby = (p: Phone) => {
      const lobby = p.tap.sent.filter(({ frames }) => typeOf(frames[0]!) === TYPE_LOBBY);
      return lobby.map(({ at, frames }) => ({ at: at - lobby[0]!.at, f: frames[0]! }));
    };
    const hostTape = tapeOfLobby(s1.host);
    const guestTape = tapeOfLobby(s1.guest);
    expect(hostTape.some(({ f }) => readLobbyFrame(f.bits, f.nbits).go)).toBe(true);
    const play = (tape: typeof hostTape) => {
      let i = 0;
      let t0: number | null = null;
      return (now: number): LinkPacket[] => {
        t0 ??= now;
        const out: LinkPacket[] = [];
        for (; i < tape.length && tape[i]!.at <= now - t0; i++) out.push({ bits: tape[i]!.f.bits, nbits: tape[i]!.f.nbits, snrDb: 30, at: now, session: false });
        return out;
      };
    };
    // a phone alone with the other's tape: nothing comes of it, and its link is never keyed
    for (const [role, tape] of [["guest", hostTape], ["host", guestTape]] as const) {
      const air = new PacketAir({ seed: 9 });
      const lone = phone(role, role === "host" ? air.a : air.b, 99, { map: "riverlands", mutators: [] }, 16, 0, 0);
      lone.tap.hear = play(tape);
      air.outage(1e9); // (nothing real reaches it)
      for (let t = 0; t < 20_000; t += 16) {
        air.advance(16);
        lone.s.pump();
        const ps = lone.s.pairing.state();
        if (ps.phase === "picking") lone.s.pick(ps.offered[0]!);
        expect(lone.s.phase).toBe("pairing");
        expect(["listening", "linking"]).toContain(ps.phase);
      }
      expect(lone.tap.keys).toEqual([]);
      expect(lone.s.status().pairing.heard).toBe(true);
    }
    // a real pairing with the tapes playing into both phones: it pairs under its own nonces and plays on
    const r = duel({
      seed: 10, ticks: 400,
      prepare: (r) => {
        r.host.tap.hear = play(guestTape);
        r.guest.tap.hear = play(hostTape);
      }
    });
    expectSameMatch(r, 400);
    const old = s1.host.s.result()!;
    expect([r.host.s.result()!.hostNonce, r.host.s.result()!.guestNonce]).not.toContain(old.hostNonce);
    expect([r.host.s.result()!.hostNonce, r.host.s.result()!.guestNonce]).not.toContain(old.guestNonce);
  });

  it("forgets the friend of a pairing it started over from: after a retry nothing says the friend has started", { timeout: 60_000 }, () => {
    // the guest loads for a minute and the host begins at once; once the guest hears the host's game frames it retries.
    // The host's frames keep coming, and the guest's link still holds the old key (no transport can unset one)
    let retriedAt: number | null = null;
    const after: SessionStatus[] = [];
    const r = duel({
      seed: 29, ticks: 100, loadMs: [0, 60_000],
      every: (r) => {
        const g = r.guest;
        if (retriedAt === null && g.s.phase === "starting" && g.s.status().peerStarted) {
          g.s.retry();
          retriedAt = r.air.now();
        }
        if (retriedAt !== null && r.air.now() % 500 === 0) after.push(g.s.status());
      },
      until: (r) => retriedAt !== null && r.air.now() >= retriedAt + 5000
    });
    expect(after.length).toBeGreaterThanOrEqual(9);
    for (const st of after) expect(st).toMatchObject({ phase: "pairing", peerStarted: false, peerEnded: null, result: null });
    // (the host's game frames did keep arriving under the old key, and went nowhere)
    const late = r.guest.tap.heard.filter((p) => typeOf(p) === TYPE_GAME && p.session && p.at - 31_337 > retriedAt!);
    expect(late.length).toBeGreaterThan(20);
    expect(r.guest.s.status().pairing.phase).toBe("listening");
  });
});

describe("the transmit mode during the match", () => {
  it("goes robust when the friend hears this phone poorly, and back to fast once it has heard it well for 10 s", { timeout: 120_000 }, () => {
    // the host's signal at the guest drops to 8 dB at 25 s, to 3 dB at 40 s, and recovers at 60 s; the guest's at the
    // host stays at 30. At 8 dB (rxq 2) fast still gets through: over the modem it delivered 99% there, and robust at
    // the D pairing picks would have stalled the match an eighth of the time (see the header)
    const changes: [number, number][] = [[25_000, 8], [40_000, 3], [60_000, 30]];
    const r = duel({
      seed: 11, ticks: 1200,
      every: (r) => {
        while (changes.length && r.air.now() >= changes[0]![0]) r.air.setSnr(changes.shift()![1], "ab");
      }
    });
    expectSameMatch(r, 1200);
    // (the host's clock is the air's)
    const modes = r.host.tap.modes;
    expect(modes.map((m) => m.mode)).toEqual(["fast", "robust", "fast"]);
    // the guest's frames say rxq 1 a packet and the latency after the drop; two seconds of that is enough
    expect(modes[1]!.at - 40_000).toBeGreaterThanOrEqual(ROBUST_AFTER_MS);
    expect(modes[1]!.at - 40_000).toBeLessThanOrEqual(ROBUST_AFTER_MS + 700);
    expect(modes[2]!.at - 60_000).toBeGreaterThanOrEqual(FAST_AFTER_MS);
    expect(modes[2]!.at - 60_000).toBeLessThanOrEqual(FAST_AFTER_MS + 900);
    expect(r.host.s.status().mode).toMatchObject({ switches: 2, tx: "fast", last: { why: "rxq" } });
    // the guest heard the host well throughout the other way round: it never left fast
    expect(r.guest.tap.modes.map((m) => m.mode)).toEqual(["fast"]);
    expect(r.guest.s.status().mode.switches).toBe(0);
    // and the link did what the session asked: robust packets from the host in between
    expect(r.host.s.status().link.txMode).toBe("fast");
  });

  it("doesn't flap: a signal that keeps dipping holds robust, and switches at most once a superframe", { timeout: 120_000 }, () => {
    // the host's signal at the guest alternates 2.5 s at 3 dB and 2.5 s at 30 dB from 30 s to 70 s, then stays good
    const r = duel({
      seed: 12, ticks: 1200,
      every: (r) => {
        const t = r.air.now();
        if (t >= 30_000 && t < 70_000) r.air.setSnr(Math.floor((t - 30_000) / 2500) % 2 ? 30 : 3, "ab");
        else if (t >= 70_000) r.air.setSnr(30, "ab");
      }
    });
    expectSameMatch(r, 1200);
    const modes = r.host.tap.modes;
    expect(modes.map((m) => m.mode)).toEqual(["fast", "robust", "fast"]);
    expect(modes[1]!.at).toBeLessThan(30_000 + 2500 + 1000);
    expect(modes[2]!.at).toBeGreaterThanOrEqual(70_000 + FAST_AFTER_MS - 2500);
    for (let i = 1; i < modes.length; i++) expect(modes[i]!.at - modes[i - 1]!.at).toBeGreaterThanOrEqual(SWITCH_HOLD_MS);
  });

  it("backs off when fast keeps failing whatever the friend says: twice as long in robust after each such fallback", { timeout: 120_000 }, () => {
    // the host's packets are lost for 70 s from 30 s: its friend's frames keep coming, none acknowledging anything new
    let cut = false;
    const r = duel({
      seed: 17, ticks: 1300,
      every: (r) => {
        if (!cut && r.air.now() >= 30_000) {
          cut = true;
          r.air.outage(70_000, "ab");
        }
      }
    });
    expectSameMatch(r, 1300);
    // (the host's clock is the air's)
    const log = r.host.switchLog;
    expect(log[0]).toMatchObject({ to: "fast", why: "start" });
    expect(log[1]).toMatchObject({ to: "robust", why: "acks" });
    expect(log[1]!.at - 30_000).toBeGreaterThanOrEqual(ACK_STALL_MS);
    expect(log[1]!.at - 30_000).toBeLessThanOrEqual(ACK_STALL_MS + 1000);
    // each switch holds a superframe; after the k-th fallback of this kind, robust holds 10 s × 2^k (at most 80 s)
    let k = 0;
    for (let i = 1; i < log.length; i++) {
      expect(log[i]!.at - log[i - 1]!.at).toBeGreaterThanOrEqual(SWITCH_HOLD_MS);
      if (log[i]!.why === "acks") k++;
      else expect(log[i]!.at - log[i - 1]!.at, `switch ${i}`).toBeGreaterThanOrEqual(Math.min(FAST_AFTER_MAX_MS, FAST_AFTER_MS * 2 ** k));
    }
    // a few tries in 70 s, not one every few seconds; and fast for good once the link is back
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(3);
    expect(log[log.length - 1]).toMatchObject({ to: "fast", why: "rxq" });
    expect(log[log.length - 1]!.at).toBeGreaterThan(100_000);
    // its friend heard nothing for those 70 s, which says nothing of its own link: it never switched
    expect(r.guest.switchLog.map((x) => x.why)).toEqual(["start"]);
  });

  it("waits a round trip for acknowledgements where the round trip is long: no fallback at 2 s, outage and all", { timeout: 120_000 }, () => {
    // at 1 s latency (D = 8) the phones stall often, and a turn sealed after a spell with nothing outstanding is
    // acknowledged a round trip and a packet or two later: over 1.5 s (with a fixed 1.5 s, both phones fell back,
    // the host 4 s into the match). A 3 s outage both ways at 40 s on top
    let cut = false;
    const r = duel({
      seed: 21, ticks: 900, air: { latencyMs: 1000 },
      every: (r) => {
        if (!cut && r.air.now() >= 40_000) {
          cut = true;
          r.air.outage(3000, "both");
        }
      }
    });
    expectSameMatch(r, 900);
    expect(r.host.s.status().rttMs! + ACK_RTT_SPARE_MS).toBeGreaterThan(ACK_STALL_MS); // (the round trip sets the wait here)
    for (const p of [r.host, r.guest]) expect(p.switchLog.map((x) => x.why), p.role).toEqual(["start"]);
  });

  it("takes no acknowledgements from a paused friend as news: a friend that switches away and stops running sends nobody robust", { timeout: 120_000 }, () => {
    // the guest switches away for 6 s at 30, 60 and 90 s: its page gets no frames and no timers (no pump, no stepping)
    // while its link repeats the paused frame it handed over on the way out. The host's turns sealed before it stalled
    // stay unacknowledged meanwhile, with the guest's frames arriving: without the paused bit that is the acks rule's
    // case exactly (each switch away sent the host robust 1.8 s in, for 20 s, then 40)
    const away = [30_000, 60_000, 90_000];
    let pausedHeardMs = 0;
    const r = duel({
      seed: 23, ticks: 1200,
      every: (r) => {
        const t = r.air.now();
        sleep(r.guest, away.some((a) => t >= a && t < a + 6000), t);
        if (r.guest.asleep && r.host.s.lockstep!.status().peerPaused) pausedHeardMs += 2;
      }
    });
    expectSameMatch(r, 1200);
    // (the friend's paused frames did arrive while it was away: about 5.7 s of each 6)
    expect(pausedHeardMs).toBeGreaterThan(3 * 5000);
    expect(r.host.waited.paused!.ms).toBeGreaterThan(5000);
    for (const p of [r.host, r.guest]) expect(p.switchLog.map((x) => x.why), p.role).toEqual(["start"]);
  });
});

/**
 * From now on the air loses every packet one end sends in fast, while its
 * robust packets get through (the sound link had such a band, some 3.5 dB wide, where
 * fast delivers nothing and robust everything ("ab": what the host sends).
 * PacketAir draws loss per direction whatever the mode, so this wraps its own
 * draw, which runs at the packet's start with the sender's mode for it set.
 */
function loseFast(air: PacketAir, direction: "ab" | "ba"): void {
  const inner = air as unknown as { lost(d: 0 | 1): boolean; ends: { mode: ModemMode }[] };
  const lost = inner.lost.bind(air);
  const d = direction === "ab" ? 0 : 1;
  inner.lost = (x) => (x === d && inner.ends[x]!.mode === "fast") || lost(x);
}

describe("the transmit mode from GO to the match", () => {
  it("says GO in the lobby's mode, and a phone whose fast fails one way still starts and plays, robust that way", { timeout: 120_000 }, () => {
    // fast fails one way from the start (the lobby is robust, so pairing measures 30 dB and picks fast): the host's
    // packets, then the guest's, each with either phone picking last (its pick and GO go out in one frame)
    for (const direction of ["ab", "ba"] as const)
      for (const hostLast of [false, true]) {
        const label = `${direction}, ${hostLast ? "host" : "guest"} picks last`;
        const r = duel({
          seed: 41, ticks: 300,
          prepare: (r) => {
            loseFast(r.air, direction);
            r.host.pickAfterMs = hostLast ? 1500 : 200;
            r.guest.pickAfterMs = hostLast ? 200 : 1500;
          }
        });
        expectSameMatch(r, 300);
        const [weak, fine] = direction === "ab" ? [r.host, r.guest] : [r.guest, r.host];
        expect(r.host.s.result()!.fast, label).toBe(true);
        for (const p of [r.host, r.guest]) {
          // (the lobby's mode until the match began: every lobby frame, GO among them, went out in it)
          expect(p.tap.modes[0], label).toEqual({ mode: "fast", at: p.begunAt });
          expect(p.switchLog[0], label).toMatchObject({ to: "fast", why: "start" });
        }
        // the phone that isn't heard in fast went robust within a few seconds of its start; its friend never switched
        expect(weak.switchLog[1], label).toMatchObject({ to: "robust" });
        expect(weak.switchLog[1]!.at - weak.begunAt!, label).toBeLessThanOrEqual(SWITCH_HOLD_MS + ROBUST_AFTER_MS + 1500);
        expect(fine.switchLog.map((x) => x.why), label).toEqual(["start"]);
      }
  });

  it("goes robust on what the friend's lobby frames say: a friend still in GO, which never heard this phone's GO, starts once robust reaches it", { timeout: 120_000 }, () => {
    // the guest picks last, so it says GO first; the host starts on it and begins at once, while the guest never hears
    // the host's GO (a hand over its microphone at just the wrong moments), and the host's fast reaches nobody. The
    // guest, still in GO, hears nothing more from the host: its frames say so (rxq 0), and they are all the host hears
    let goneRobust: number | null = null;
    let guestPhase: string | null = null;
    const r = duel({
      seed: 42, ticks: 300,
      prepare: (r) => {
        loseFast(r.air, "ab");
        r.host.pickAfterMs = 200;
        r.guest.pickAfterMs = 1500;
        r.guest.tap.drop = isGo;
      },
      every: (r) => {
        if (goneRobust === null && r.host.tap.modes.some((m) => m.mode === "robust")) {
          goneRobust = r.air.now();
          guestPhase = r.guest.s.pairing.state().phase;
        }
      }
    });
    expectSameMatch(r, 300);
    const h = r.host;
    // the host began first, in fast, stalled at tick D on its friend "loading", and went robust on the rxq rule
    // (then fast again once the guest has heard it well for 10 s, which still fails: the match's own rules from there)
    expect(h.switchLog.slice(0, 2).map((x) => [x.to, x.why])).toEqual([["fast", "start"], ["robust", "rxq"]]);
    expect(guestPhase).toBe("go");
    expect(goneRobust! - h.begunAt!).toBeGreaterThanOrEqual(SWITCH_HOLD_MS);
    expect(goneRobust! - h.begunAt!).toBeLessThanOrEqual(RX_SILENT_MS + ROBUST_AFTER_MS + 1500);
    expect(h.waited.load!.tick).toBe(h.s.result()!.delay);
    // and the guest, started on the host's game frames, began after that and plays in fast: its own fast is fine
    expect(r.guest.begunAt! - 31_337).toBeGreaterThan(goneRobust!);
    expect(r.guest.switchLog.map((x) => x.why)).toEqual(["start"]);
  });
});

describe("the end of a session", () => {
  it("ends both phones on the same tick when a side resigns, checks the end, and keeps the report on the air after leaving", { timeout: 120_000 }, () => {
    const r = duel({
      seed: 13, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (p.side === "red" && t === 900) p.extra.push({ type: "resign", faction: "red" });
      },
      until: (r) => [r.host, r.guest].every((p) => p.s.lockstep?.status().endCheck === "ok" || p.s.lockstep?.status().endCheck === "mismatch")
    });
    const [sh, sg] = [r.host.s.lockstep!.status(), r.guest.s.lockstep!.status()];
    expect(sh.decided).toEqual({ winner: "blue", resigned: "red", tick: sg.decided!.tick });
    expect(sh.decided!.tick).toBeGreaterThanOrEqual(900 + r.host.s.result()!.delay);
    expect([sh.endCheck, sg.endCheck]).toEqual(["ok", "ok"]);
    expect(firstDiff(r, sh.decided!.tick + 1)).toBe(-1);
    for (const p of [r.host, r.guest]) {
      expect(p.s.phase).toBe("ended");
      expect([p.w!.winner, p.w!.resigned]).toEqual(["blue", "red"]);
    }
    // both leave the report: the decided frames, end report and all, stay on the air for 2 s, then each may close
    const leftAt = r.air.now();
    for (const p of [r.host, r.guest]) p.s.leave("left");
    let closableAt: number | null = null;
    while (closableAt === null && r.air.now() < leftAt + 5000) {
      r.air.advance(2);
      for (const p of [r.host, r.guest]) p.s.pump();
      if (r.host.s.status().closable) closableAt = r.air.now();
    }
    expect(closableAt! - leftAt).toBe(END_FRAMES_MS);
    for (const p of [r.host, r.guest]) {
      expect(p.s.lockstep!.status().end).toBe("decided");
      const last = p.tap.sent[p.tap.sent.length - 1]!.frames;
      const newest = last[last.length - 1]!;
      expect(readGameFrame(newest.bits, newest.nbits, { width: 56, height: 56 }, p.side!, p.s.lockstep!.status().newestSealed).end).toBe("decided");
      p.s.close();
      expect(p.s.phase).toBe("closed");
    }
  });

  it("tells the friend at once when a phone leaves mid-match, keeps saying so for 2 s, then may close", { timeout: 60_000 }, () => {
    let leftAt: number | null = null;
    let leaver: Phone | null = null;
    let sentBefore = 0;
    const r = duel({
      seed: 14, ticks: 600,
      afterStep: (p, t, r) => {
        if (p.role === "host" && t === 300 && leftAt === null) {
          leaver = p;
          sentBefore = p.tap.sent.length;
          p.s.leave("left");
          leftAt = r.air.now();
        }
      },
      until: (r) => r.guest.s.phase === "ended"
    });
    const host = leaver as Phone | null;
    expect(host).toBe(r.host);
    // within a packet period and the latency (and a frame each side)
    expect(r.air.now() - leftAt!).toBeLessThanOrEqual(100 + 250 + 40);
    expect(r.guest.s.lockstep!.status()).toMatchObject({ peerEnd: "left", desync: false });
    expect(r.guest.w!.tick).toBeLessThanOrEqual(301 + r.host.s.result()!.delay);
    expect(r.host.s.status()).toMatchObject({ phase: "ended", leaving: true, closable: false });
    expect(r.host.s.lockstep!.status().end).toBe("left");
    // the leaver's link carries end = 1 for its 2 s, every packet; then it may close, and the air goes quiet
    const heardBefore = r.guest.tap.heard.length;
    while (!r.host.s.status().closable) {
      r.air.advance(2);
      r.host.s.pump();
      r.guest.s.pump();
    }
    expect(r.air.now() - leftAt!).toBeGreaterThanOrEqual(END_FRAMES_MS);
    expect(r.air.now() - leftAt!).toBeLessThanOrEqual(END_FRAMES_MS + 20);
    const ends = r.guest.tap.heard.slice(heardBefore).filter((p) => typeOf(p) === TYPE_GAME);
    expect(ends.length).toBeGreaterThanOrEqual(12);
    const near = r.guest.s.lockstep!.status().ackThrough;
    for (const p of ends) expect(readGameFrame(p.bits, p.nbits, { width: 56, height: 56 }, "blue", near).end).toBe("left");
    const after = gameFramesSent(r.host, sentBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((f) => f.end === "left")).toBe(true);
    // the friend may close as soon as it leaves the report: there's nobody left to tell
    r.guest.s.leave("left");
    expect(r.guest.s.status().closable).toBe(true);
    r.host.s.close();
    r.air.advance(1000);
    r.guest.s.pump();
    const quiet = r.guest.tap.heard.length;
    r.air.advance(2000);
    r.guest.s.pump();
    expect(r.guest.tap.heard.length).toBe(quiet);
  });

  it("tells a friend that began when this phone leaves while loading, and has nothing to tell before a result", { timeout: 60_000 }, () => {
    // the guest leaves 1 s into loading: the host, stalled at tick D waiting for it to load, hears that it left
    let leftAt: number | null = null;
    const r = duel({
      seed: 15, ticks: 300, loadMs: [0, 3000],
      every: (r) => {
        const g = r.guest;
        if (leftAt === null && g.resultAt !== null && g.tap.now() - g.resultAt >= 1000) {
          g.s.leave("left");
          leftAt = r.air.now();
        }
      },
      until: (r) => r.host.s.phase === "ended" && r.guest.s.status().closable
    });
    const D = r.host.s.result()!.delay;
    expect(r.host.s.lockstep!.status()).toMatchObject({ peerEnd: "left", tick: D });
    expect(r.host.waited.load).toBeDefined();
    expect(r.guest.s.phase).toBe("ended");
    expect(r.guest.s.lockstep).toBeNull(); // (a stand-in says the end; no match was begun)
    expect(() => r.guest.s.beginMatch(1)).toThrow();
    expect(r.air.now() - leftAt!).toBeGreaterThanOrEqual(END_FRAMES_MS);
    expect(r.guest.w).toBeNull();

    // leaving the lobby before any result: nothing to tell, so it may close at once, and the pairing goes no further
    const air = new PacketAir({ seed: 16 });
    const h = phone("host", air.a, 1, { map: "riverlands", mutators: [] }, 16, 0, 0);
    const g = phone("guest", air.b, 2, { map: "riverlands", mutators: [] }, 16, 0, 0);
    for (let t = 0; t < 3000; t += 16) {
      air.advance(16);
      h.s.pump();
      g.s.pump();
    }
    expect(["linking", "picking"]).toContain(g.s.pairing.state().phase);
    g.s.leave("left");
    expect(g.s.status()).toMatchObject({ phase: "pairing", leaving: true, closable: true });
    const frozen = g.s.pairing.state();
    for (let t = 0; t < 20_000; t += 16) {
      air.advance(16);
      h.s.pump();
      g.s.pump();
    }
    expect(g.s.pairing.state()).toMatchObject({ phase: frozen.phase, go: false });
    expect(h.s.phase).toBe("pairing");
    g.s.close();
    expect(g.s.status().phase).toBe("closed");
  });

  it("hears a friend that left while this phone loaded, however long it loads: \"Friend left\" before it begins, and its match ends at once", { timeout: 60_000 }, () => {
    // both phones load; the guest gives up 1 s in and closes once it may (its 2 s of end frames). The host loads 6 s,
    // so the guest has gone quiet for over a second before the host begins: only what it heard while loading tells it
    let leftAt: number | null = null;
    let closedAt: number | null = null;
    let loading: SessionStatus | null = null;
    const r = duel({
      seed: 15, ticks: 300, loadMs: [6000, 60_000],
      every: (r) => {
        const g = r.guest;
        if (leftAt === null && g.resultAt !== null && g.tap.now() - g.resultAt >= 1000) {
          g.s.leave("left");
          leftAt = r.air.now();
        }
        if (leftAt !== null && closedAt === null && g.s.status().closable) {
          g.s.close();
          closedAt = r.air.now();
        }
        if (closedAt !== null && r.host.s.phase === "starting") loading = r.host.s.status();
      },
      until: (r) => r.host.begunAt !== null
    });
    expect(closedAt! - leftAt!).toBe(END_FRAMES_MS);
    // still loading, after its friend closed: the friend's end frames said it left, and started nothing more
    const st = loading as SessionStatus | null;
    expect(st).toMatchObject({ phase: "starting", peerEnded: "left", peerStarted: false, lockstep: null });
    expect(st!.packets.ignored).toBeGreaterThanOrEqual(10);
    expect(r.host.begunAt!).toBeGreaterThan(closedAt! + 1000); // (the host's clock is the air's)
    // beginning anyway, the match is over before its first tick
    expect(r.host.s.phase).toBe("ended");
    expect(r.host.s.lockstep!.status()).toMatchObject({ peerEnd: "left", tick: 0, desync: false });
    expect(r.host.s.status()).toMatchObject({ peerEnded: "left", waiting: null });
    // and it may close at once: there is nobody left to tell
    r.host.s.leave("left");
    expect(r.host.s.status().closable).toBe(true);
  });

  it("doesn't start on the end frames of a friend that started and left: a phone still in GO hears \"Friend left\" instead", { timeout: 60_000 }, () => {
    // the guest picks last, so it says GO first; the host's GO frames never reach it. The host starts (it heard the
    // guest's GO and sent its own) and leaves at once: the end frames of its stand-in are all the guest hears of it
    let leftAt: number | null = null;
    let closedAt: number | null = null;
    const r = duel({
      seed: 24, ticks: 300,
      prepare: (r) => {
        r.host.pickAfterMs = 200;
        r.guest.pickAfterMs = 1500;
        r.guest.tap.drop = isGo;
        r.host.loadMs = 60_000;
      },
      every: (r) => {
        const h = r.host;
        if (leftAt === null && h.s.result()) {
          h.s.leave("left");
          leftAt = r.air.now();
        }
        if (leftAt !== null && closedAt === null && h.s.status().closable) {
          h.s.close();
          closedAt = r.air.now();
        }
      },
      until: (r) => closedAt !== null && r.air.now() >= closedAt + 5000
    });
    const g = r.guest;
    const ends = g.tap.heard.filter((p) => typeOf(p) === TYPE_GAME);
    expect(ends.length).toBeGreaterThanOrEqual(10);
    expect(ends.every((p) => p.session && endOf(p) === 1)).toBe(true);
    // it stays in the lobby, its GO unanswered, and knows its friend has gone
    expect(g.phases).toEqual(["pairing"]);
    expect(g.s.result()).toBeNull();
    expect(g.s.pairing.state().phase).toBe("go");
    expect(g.s.status()).toMatchObject({ phase: "pairing", peerEnded: "left", peerStarted: false });
  });

  it("tells a friend that started on this phone's GO when it leaves before its own result: GO is on the air, so the end goes out too", { timeout: 60_000 }, () => {
    // the guest says GO first, and never hears the host's: the host starts on the guest's GO alone and begins. Then the
    // guest leaves, with no result of its own
    let leftAt: number | null = null;
    let closableAt: number | null = null;
    let sentBefore = 0;
    const r = duel({
      seed: 25, ticks: 300,
      prepare: (r) => {
        r.host.pickAfterMs = 200;
        r.guest.pickAfterMs = 1500;
        r.guest.tap.drop = isGo;
      },
      every: (r) => {
        const g = r.guest;
        if (leftAt === null && r.host.begunAt !== null) {
          expect(g.s.result()).toBeNull();
          expect(g.s.pairing.state().go).toBe(true);
          sentBefore = g.tap.sent.length;
          g.s.leave("left");
          leftAt = r.air.now();
          expect(g.s.status()).toMatchObject({ phase: "ended", leaving: true, closable: false, lockstep: { end: "left" } });
        }
        if (leftAt !== null && closableAt === null && g.s.status().closable) {
          closableAt = r.air.now();
          g.s.close();
        }
      },
      until: (r) => closableAt !== null && r.air.now() >= closableAt + 3000
    });
    expect(closableAt! - leftAt!).toBe(END_FRAMES_MS);
    // the end, under the session CRC, on the link at once and for its 2 s
    const after = r.guest.tap.sent.slice(sentBefore);
    expect(after[0]!.at).toBe(leftAt! + 31_337);
    expect(after.every(({ frames }) => frames.every((f) => typeOf(f) === TYPE_GAME && endOf(f) === 1))).toBe(true);
    // the host, which would have stalled at tick D in a match its friend never began, hears that it left
    const D = r.host.s.result()!.delay;
    expect(r.host.s.phase).toBe("ended");
    expect(r.host.s.lockstep!.status()).toMatchObject({ peerEnd: "left", desync: false });
    expect(r.host.s.lockstep!.status().tick).toBeLessThanOrEqual(D);
    expect(r.guest.s.lockstep).toBeNull();
  });
});

describe("what a stall waits on", () => {
  /** The guest's stall as its HUD would read it, sampled once a second (air time) from `from` on. */
  function sampler(from: number) {
    const seen: { at: number; why: string | null; ms: number }[] = [];
    return {
      seen,
      every: (r: Run) => {
        const t = r.air.now();
        if (t >= from && t % 1000 === 0) {
          const w = r.guest.s.status().waiting;
          seen.push({ at: t, why: w?.why ?? null, ms: w?.ms ?? 0 });
        }
      }
    };
  }

  it("says \"paused\" only while the paused friend is still heard: once its link dies the stall is the link's", { timeout: 60_000 }, () => {
    // the host pauses at 30 s, and its packets stop reaching the guest at 32 s for good (pocketed, the app killed)
    const s = sampler(31_000);
    const r = duel({
      seed: 26, ticks: 900,
      every: (r) => {
        const t = r.air.now();
        if (t === 30_000) {
          r.host.s.setPaused(true);
          r.host.paused = true;
        }
        if (t === 32_000) r.air.outage(1e9, "ab");
        s.every(r);
      },
      until: (r) => r.air.now() >= 45_000
    });
    expect(r.guest.s.lockstep!.status()).toMatchObject({ stalled: true, peerPaused: true });
    // the last packet from the host started just before 32 s and arrived 250 ms later; PEER_HEARD_MS after that, "link"
    const quiet = 32_000 + 250 + PEER_HEARD_MS;
    for (const { at, why } of s.seen) expect(why, `at ${at}`).toBe(at < quiet - 100 ? "paused" : at > quiet + 100 ? "link" : why);
    expect(s.seen.filter((x) => x.why === "link").length).toBeGreaterThanOrEqual(10);
    // (counted from the last new turn all along: the HUD's "Signal lost" shows at once once it reads "link")
    expect(s.seen[s.seen.length - 1]!.ms).toBeGreaterThan(12_000);
  });

  it("counts the wait for a friend that plays on again from then, not from its last turn before the pause", { timeout: 60_000 }, () => {
    // the host pauses at 30 s and plays on at 38 s, but its game takes a second to step again (a slow first frame): its
    // frames say it plays on, with no new turn yet. The friend owed nothing while paused, so the guest's stall is the
    // link's for that second, and as old as the resume (from the last turn before the pause it read 8 s, "Signal
    // lost", for as long as the host's next turn took: a moment, which a step's timing sometimes made)
    const seen: { at: number; why: string; ms: number }[] = [];
    const r = duel({
      seed: 26, ticks: 900,
      every: (r) => {
        const t = r.air.now();
        if (t === 30_000) r.host.s.setPaused(true);
        if (t === 38_000) r.host.s.setPaused(false);
        r.host.paused = t >= 30_000 && t < 39_000;
        const w = r.guest.s.status().waiting;
        if (t >= 38_000 && t <= 39_500 && w) seen.push({ at: t, why: w.why, ms: w.ms });
      },
      until: (r) => r.air.now() >= 45_000
    });
    expectSameMatch(r, Math.min(r.host.w!.tick, r.guest.w!.tick));
    // the guest heard the host play on, and waited on the link for its turn: never longer than since the resume
    const link = seen.filter((x) => x.why === "link");
    expect(link.length).toBeGreaterThan(200);
    for (const { at, ms } of link) expect(ms, `at ${at}`).toBeLessThanOrEqual(at - 38_000);
    // (and the match went on: the guest stood at tick 250 or so through the pause)
    expect(r.guest.w!.tick).toBeGreaterThan(280);
  });

  it("says \"load\" only for the friend's own lobby frames: a friend whose page reloaded mid-match is lost, not loading", { timeout: 60_000 }, () => {
    // at 40 s the host's page reloads: the old page is gone, and a fresh session on the same end of the link taps Host
    let fresh: Phone | null = null;
    const s = sampler(42_000);
    const r = duel({
      seed: 27, ticks: 900,
      every: (r) => {
        if (!fresh && r.air.now() >= 40_000) {
          r.host.asleep = true;
          fresh = phone("host", r.air.a, 77, { map: "riverlands", mutators: [] }, 16, 0, 0);
        }
        fresh?.s.pump();
        s.every(r);
      },
      until: (r) => r.air.now() >= 50_000
    });
    const f = fresh as Phone | null;
    // the guest hears the reloaded page's lobby frames: from the host's role, under a nonce of no pairing of its own
    expect(f!.s.pairing.state().phase).toBe("listening");
    const lobby = r.guest.tap.heard.filter((p) => typeOf(p) === TYPE_LOBBY && readLobbyFrame(p.bits, p.nbits).nonce === f!.s.pairing.state().nonce);
    expect(lobby.length).toBeGreaterThan(30);
    expect(r.guest.s.lockstep!.status()).toMatchObject({ stalled: true, peerEnd: "playing" });
    expect(s.seen.length).toBeGreaterThanOrEqual(8);
    for (const { at, why } of s.seen) expect(why, `at ${at}`).toBe("link");
  });

  it("says \"link\", not \"load\", when the friend's game frames come without the session CRC: a transport must check it, or emulate it", { timeout: 60_000 }, () => {
    // a relay that keys nothing: both ends ignore setSessionKey, so every game frame arrives with session false. Both
    // phones begin, and neither ever takes a turn of the other's
    const pa = new PacketAir({ seed: 28, clockOffsetMs: [0, 31_337], mode: "robust" });
    const unkeyed = (t: LinkTransport): LinkTransport => ({
      capacity: () => t.capacity(), send: (f) => t.send(f), poll: () => t.poll(), slots: () => t.slots(), now: () => t.now(),
      setMode: (m) => t.setMode(m), setSessionKey: () => {}, stats: () => t.stats(), close: () => t.close()
    });
    const link = { a: unkeyed(pa.a), b: unkeyed(pa.b), now: () => pa.now(), advance: (ms: number) => pa.advance(ms) };
    const r = duel({ seed: 28, ticks: 300, link, until: (r) => r.host.begunAt !== null && r.guest.begunAt !== null && r.air.now() >= Math.max(r.host.begunAt, r.guest.begunAt - 31_337) + 8000 });
    const D = r.host.s.result()!.delay;
    for (const p of [r.host, r.guest]) {
      const st = p.s.status();
      expect(st.lockstep, p.role).toMatchObject({ tick: D, stalled: true, framesIn: 0 });
      expect(st.packets.ignored, p.role).toBeGreaterThan(40);
      // (the friend's GO frames stopped when it began: its game frames, dropped, say nothing of loading)
      expect(st.waiting, p.role).toMatchObject({ why: "link" });
      expect(st.waiting!.ms, p.role).toBeGreaterThan(5000);
    }
  });
});


