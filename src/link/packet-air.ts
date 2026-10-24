/**
 * A frame-level simulated sound link (DUEL.md "Link layer"): two
 * connected LinkTransport ends, `a` and `b`, on one injected clock —
 * advance(ms) in tests, a real timer in ?duel=loop. It models what the upper
 * layers can see of the modem and nothing below it:
 *
 *  - each end sends a packet every 100 ms (fast) or 200 ms (robust), at its
 *    own phase, carrying one of the newest frames handed to send() before the
 *    packet starts, in key rotation (transport.ts nextFrameIndex; none yet:
 *    nothing goes out); the packet's start is a slot;
 *  - each packet arrives `latencyMs` after its start (default 250), unless
 *    lost: seeded Bernoulli loss, Gilbert–Elliott bursts, or an outage.
 *    That is start to fully received, as LinkPacket.at is on every transport
 *    (transport.ts), so it includes the packet's own air time: over the modem
 *    in the room, the audio path (about 75 ms) plus one packet (100–400 ms by
 *    plan and mode). It doesn't change with the mode, which the modem's does:
 *    a latency shorter than a packet is a model, not a link. Its `at` is that
 *    arrival on the receiver's clock;
 *  - it arrives as the modem delivers it: `capacity` bits (188 unless
 *    overridden), the payload zero-padded;
 *  - game frames (type 01) are dropped between ends whose session keys
 *    differ, as the session CRC would drop them (session: true when both ends
 *    hold the same key; two ends with no key yet don't differ); lobby frames
 *    always pass (session: false);
 *  - each packet reports the SNR of its direction (setSnr changes it, each
 *    way or one way), and an end's stats() the SNR of the newest packet it
 *    received, as the modem reports the newest packet's. Only the number
 *    changes: loss is set apart from it (setLoss).
 *
 * A mode change takes effect at the end's next packet (the modem waits for
 * the next superframe). A lost packet counts as rxBad at the receiving end,
 * as a failed CRC would.
 */
import { hash32 } from "../sim/rand";
import { nextFrameIndex, type BandPlan, type LinkPacket, type LinkStats, type LinkTransport, type ModemMode, type OutFrame } from "./transport";

/** Two-state burst loss: in the bad state most packets are lost. */
export interface GilbertElliott {
  /** Per packet: the chance the link goes bad, and the chance it recovers. */
  pGoodToBad: number;
  pBadToGood: number;
  /** Loss in each state (defaults 0 and 1). */
  lossGood?: number;
  lossBad?: number;
}

export interface PacketAirOptions {
  /** Packet start to delivery, fully received: the packet's air time included (ms). Default 250. */
  latencyMs?: number;
  /** Bernoulli loss per packet, 0–1. Default 0. */
  loss?: number;
  /** Burst loss instead of `loss`. */
  burst?: GilbertElliott;
  seed?: number;
  /** Payload bits per packet. Default 188. */
  capacity?: number;
  /** Packet period per mode (ms). Default fast 100, robust 200. */
  periodMs?: Partial<Record<ModemMode, number>>;
  /** Both ends' starting transmit mode. Default robust. */
  mode?: ModemMode;
  /** Each end's first packet start (ms); default a seeded phase within one period. */
  phaseMs?: [number, number];
  /** Each end's clock reads the air's time plus this (ms): phones share no clock. Default 0. */
  clockOffsetMs?: [number, number];
  /** The SNR each packet reports (both ways, until setSnr), and each end's own-signal SNR (the route check). Defaults 30 and 40 dB. */
  snrDb?: number;
  ownSnrDb?: number;
  plan?: BandPlan;
}

/** Which way an outage cuts: "ab" is what `a` sends to `b`. */
export type AirDirection = "ab" | "ba" | "both";

interface InFlight {
  due: number;
  bits: Uint8Array;
  mode: ModemMode;
  /** A game frame (type 01), and the sender's session key when it sent it. */
  game: boolean;
  key: string | null;
}

class AirEnd implements LinkTransport {
  /** The frames as the modem sends them: exactly `capacity` bits each, zero-padded. */
  payloads: { bits: Uint8Array; key: number }[] | null = null;
  /** The key the last packet carried. */
  lastKey: number | null = null;
  mode: ModemMode;
  nextMode: ModemMode;
  nextSlot: number;
  key: string | null = null;
  closed = false;
  readonly inbox: LinkPacket[] = [];
  readonly slotsOut: number[] = [];
  rxOk = 0;
  rxBad = 0;
  lastRxAt: number | null = null;
  /** The SNR the newest packet received reported. */
  lastSnr: number | null = null;
  rxMode: ModemMode | null = null;

  constructor(
    private readonly air: PacketAir,
    private readonly offset: number,
    mode: ModemMode,
    firstSlot: number
  ) {
    this.mode = this.nextMode = mode;
    this.nextSlot = firstSlot;
  }

  capacity(): number {
    return this.air.cap;
  }

  send(frames: readonly OutFrame[]): void {
    if (!frames.length) throw new RangeError("send() needs at least one frame");
    this.payloads = frames.map(({ bits, nbits, key }, i) => {
      if (nbits > this.air.cap || nbits < 0) throw new RangeError(`a ${nbits}-bit frame in a ${this.air.cap}-bit packet`);
      if (i > 0 && key <= frames[i - 1]!.key) throw new RangeError("frame keys must ascend");
      const p = new Uint8Array((this.air.cap + 7) >> 3);
      for (let j = 0; j < nbits; j++) if ((bits[j >> 3]! >> (7 - (j & 7))) & 1) p[j >> 3]! |= 0x80 >> (j & 7);
      return { bits: p, key };
    });
  }

  poll(): LinkPacket[] {
    return this.inbox.splice(0);
  }

  slots(): number[] {
    return this.slotsOut.splice(0);
  }

  now(): number {
    return this.air.now() + this.offset;
  }

  clock(airMs: number): number {
    return airMs + this.offset;
  }

  setMode(mode: ModemMode): void {
    this.nextMode = mode;
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.key = `${hostNonce}:${guestNonce}`;
  }

  stats(): LinkStats {
    const since = this.lastRxAt === null ? Infinity : this.air.now() - this.lastRxAt;
    return {
      locked: since < 2500,
      snrDb: this.lastSnr,
      rxOk: this.rxOk,
      rxBad: this.rxBad,
      txMode: this.mode,
      rxMode: this.rxMode,
      sinceRx: since,
      ownSnrDb: this.closed ? null : this.air.ownSnrDb,
      loopbackMs: null,
      plan: this.air.plan
    };
  }

  close(): void {
    this.closed = true;
    this.payloads = null;
    this.inbox.length = 0;
  }
}

export class PacketAir {
  readonly a: LinkTransport;
  readonly b: LinkTransport;
  readonly cap: number;
  readonly ownSnrDb: number;
  readonly plan: BandPlan;
  private readonly ends: [AirEnd, AirEnd];
  private readonly latency: number;
  private readonly period: Record<ModemMode, number>;
  private readonly seed: number;
  private loss: number;
  private burst: GilbertElliott | null;
  /** The SNR packets report per direction (0: a → b, 1: b → a). */
  private readonly snr: [number, number];
  /** Per direction (0: a → b, 1: b → a): packets in flight, the burst state, the draw counter, outages. */
  private readonly flight: [InFlight[], InFlight[]] = [[], []];
  private readonly bad: [boolean, boolean] = [false, false];
  private readonly draws: [number, number] = [0, 0];
  private readonly outages: [[number, number][], [number, number][]] = [[], []];
  private t = 0;

  constructor(o: PacketAirOptions = {}) {
    this.cap = o.capacity ?? 188;
    this.latency = o.latencyMs ?? 250;
    this.period = { fast: o.periodMs?.fast ?? 100, robust: o.periodMs?.robust ?? 200 };
    this.seed = (o.seed ?? 1) >>> 0;
    this.loss = o.loss ?? 0;
    this.burst = o.burst ?? null;
    this.snr = [o.snrDb ?? 30, o.snrDb ?? 30];
    this.ownSnrDb = o.ownSnrDb ?? 40;
    this.plan = o.plan ?? "high";
    const mode = o.mode ?? "robust";
    const phase = (i: number) => o.phaseMs?.[i] ?? Math.floor((hash32(this.seed, 0x9a5e, i) / 4294967296) * this.period[mode]);
    const end = (i: 0 | 1) => new AirEnd(this, o.clockOffsetMs?.[i] ?? 0, mode, phase(i));
    this.ends = [end(0), end(1)];
    [this.a, this.b] = this.ends;
  }

  /** The air's own time (ms since it was made). */
  now(): number {
    return this.t;
  }

  /** Change the loss from now on (Bernoulli, or bursts). */
  setLoss(loss: number, burst: GilbertElliott | null = null): void {
    this.loss = loss;
    this.burst = burst;
  }

  /** The SNR packets report from now on (on arrival), both ways or one way ("ab": what `a` sends, as `b` hears it). */
  setSnr(snrDb: number, direction: AirDirection = "both"): void {
    for (const d of direction === "both" ? [0, 1] : direction === "ab" ? [0] : [1]) this.snr[d] = snrDb;
  }

  /** Lose every packet that starts in the next `ms` (a hand over a microphone, a phone call). */
  outage(ms: number, direction: AirDirection = "both"): void {
    for (const d of direction === "both" ? [0, 1] : direction === "ab" ? [0] : [1]) this.outages[d]!.push([this.t, this.t + ms]);
  }

  /** Run the air `ms` forward: packets start, and arrive in the receivers' poll(). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next = Infinity;
      for (const e of this.ends) if (!e.closed) next = Math.min(next, e.nextSlot);
      for (const q of this.flight) if (q.length) next = Math.min(next, q[0]!.due);
      if (next > target) break;
      this.t = next;
      for (const d of [0, 1] as const) {
        const q = this.flight[d];
        while (q.length && q[0]!.due <= this.t) this.deliver(d, q.shift()!);
      }
      for (const d of [0, 1] as const) {
        const e = this.ends[d];
        if (!e.closed && e.nextSlot <= this.t) this.slot(d, e);
      }
    }
    this.t = target;
  }

  private slot(d: 0 | 1, e: AirEnd): void {
    e.mode = e.nextMode;
    e.slotsOut.push(e.clock(this.t));
    e.nextSlot = this.t + this.period[e.mode];
    if (!e.payloads) return;
    const out = e.payloads[nextFrameIndex(e.payloads, e.lastKey)]!;
    e.lastKey = out.key;
    const p: InFlight = { due: this.t + this.latency, bits: out.bits, mode: e.mode, game: out.bits[0]! >> 6 === 1, key: e.key };
    if (this.lost(d)) {
      this.ends[1 - d]!.rxBad++;
      return;
    }
    this.flight[d].push(p);
  }

  private lost(d: 0 | 1): boolean {
    const t = this.t;
    const out = this.outages[d];
    while (out.length && out[0]![1] <= t) out.shift();
    if (out.some(([s, e]) => s <= t && t < e)) return true;
    if (this.burst) {
      const g = this.burst;
      if (this.rand(d) < (this.bad[d] ? g.pBadToGood : g.pGoodToBad)) this.bad[d] = !this.bad[d];
      return this.rand(d) < (this.bad[d] ? g.lossBad ?? 1 : g.lossGood ?? 0);
    }
    return this.loss > 0 && this.rand(d) < this.loss;
  }

  private rand(d: 0 | 1): number {
    return hash32(this.seed, d + 1, this.draws[d]++) / 4294967296;
  }

  private deliver(d: 0 | 1, p: InFlight): void {
    const to = this.ends[1 - d]!;
    if (to.closed) return;
    // the session CRC: a game frame decodes only under the key both phones derived from the same nonces
    if (p.game && p.key !== to.key) {
      to.rxBad++;
      return;
    }
    to.inbox.push({ bits: p.bits.slice(), nbits: this.cap, snrDb: this.snr[d], at: to.clock(this.t), session: p.game && p.key !== null });
    to.rxOk++;
    to.lastRxAt = this.t;
    to.lastSnr = this.snr[d];
    to.rxMode = p.mode;
  }
}
