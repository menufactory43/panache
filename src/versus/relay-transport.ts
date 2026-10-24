/**
 * RelayTransport (DUEL.md "Dev and test modes", `?duel=relay`): a
 * LinkTransport through two page functions instead of the air, so a test
 * harness (tools/duel-smoke.mjs) can wire two pages together through Node,
 * with whatever delay and loss it likes, and play a whole duel without a
 * microphone.
 *
 *   window.__duelOut(base64, nbits)   the page calls it once a packet period
 *   window.__duelIn(base64, nbits)    the harness calls it with the friend's
 *
 * Packets go out every 100 ms (fast) or 200 ms (robust), whether or not the
 * frame changed, in key rotation like the modem's (transport.ts
 * nextFrameIndex); a mode change takes effect at the next packet. Each packet
 * is a slot, stamped with now().
 *
 * The session CRC (transport.ts setSessionKey) is emulated with a real one:
 * the base64 holds the frame's ceil(nbits / 8) bytes (MSB-first), then the
 * CRC-16 the modem would send (src/link/crc.ts: 0xFFFF for lobby
 * frames, the sender's session key for game frames once keyed), then one
 * byte naming the sender's mode (0 robust, 1 fast). The receiver checks it as
 * the modem does, by the frame's type: a game frame must pass the session
 * key (none before keying), anything else 0xFFFF, else it is dropped (and
 * counted bad). Never by trying both keys on every frame: a session key can
 * be 0xFFFF itself (crcKey's fallback), and a lobby frame must still pass
 * then. The harness carries the string as it is.
 *
 * Where the spec is silent:
 *  - packets arrive as the modem delivers them: `capacity` bits (188), the
 *    payload zero-padded, stamped `at` = now() when __duelIn is called;
 *  - a relay has no SNR: each packet reports `snrDb` (30 dB unless set), so
 *    the receive quality reads as a good link and the pairing starts fast
 *    when packets flow; mode adaptation still goes robust when acks stall;
 *  - stats() reads locked while a packet came within 2.5 s; no own-signal
 *    figures (ownSnrDb and loopbackMs null), plan "high";
 *  - the packet clock is tick(): the transport ticks itself every 20 ms with
 *    the timers it is given, and on every poll() and slots(). A tick that
 *    finds more than one period missed (a throttled timer) sends one packet
 *    and starts the period over from now, as a modem that lost time would;
 *  - with no __duelOut on the page, slots still run and nothing goes out
 *    (`connected()` says so: the lobby shows "Relay not connected"); a
 *    __duelOut that throws loses that packet;
 *  - close() stops the timer and takes __duelIn off the page, if it is still
 *    this transport's.
 */
import { CRC_INIT, crc16, crcKey } from "../link/crc";
import { nextFrameIndex, type BandRole, type LinkPacket, type LinkStats, type LinkTransport, type ModemMode, type OutFrame } from "../link/transport";

/** The page functions the relay goes through. */
export interface RelayWindow {
  __duelOut?: (base64: string, nbits: number) => void;
  __duelIn?: (base64: string, nbits: number) => void;
}

export interface RelayTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface RelayOptions {
  /** This page's role: its game frames carry this role's session key. */
  role: BandRole;
  win: RelayWindow;
  /** Monotonic milliseconds (default performance.now). */
  now?: () => number;
  /** The packet clock's timer (default the window's); null: the caller ticks. */
  timers?: RelayTimers | null;
  /** Starting transmit mode (default robust, as a modem in the lobby). */
  mode?: ModemMode;
  /** Payload bits per packet (default 188, the high plan's). */
  capacity?: number;
  /** The SNR each packet reports (default 30 dB). */
  snrDb?: number;
}

/** Packet period per mode (ms), as the modem's high plan. */
export const RELAY_PERIOD_MS: Readonly<Record<ModemMode, number>> = { fast: 100, robust: 200 };
/** The packet clock's own timer (ms). */
const TICK_MS = 20;
/** No packet for this long: unlocked. */
const LOCK_MS = 2500;
const TYPE_GAME = 0b01;

const other = (r: BandRole): BandRole => (r === "host" ? "guest" : "host");

/** MSB-first bits as one 0/1 per element, for crc16. */
function unpack(bytes: Uint8Array, nbits: number): Uint8Array {
  const out = new Uint8Array(nbits);
  for (let i = 0; i < nbits; i++) out[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1;
  return out;
}

const toBase64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

const fromBase64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** A frame for the wire: its bytes, the CRC-16 under `init`, and the mode byte (base64). */
export function encodeRelayPacket(frame: { bits: Uint8Array; nbits: number }, init: number, mode: ModemMode): string {
  const n = (frame.nbits + 7) >> 3;
  const out = new Uint8Array(n + 3);
  out.set(frame.bits.subarray(0, n));
  // (bits past nbits are not the frame's: zero them, as the modem's zero padding does)
  if (frame.nbits & 7) out[n - 1]! &= (0xff << (8 - (frame.nbits & 7))) & 0xff;
  const crc = crc16(unpack(out, frame.nbits), frame.nbits, init);
  out[n] = crc >> 8;
  out[n + 1] = crc & 0xff;
  out[n + 2] = mode === "fast" ? 1 : 0;
  return toBase64(out);
}

/** A packet off the wire: the frame, its CRC and the sender's mode (null: malformed). */
export function decodeRelayPacket(base64: string, nbits: number): { bits: Uint8Array; nbits: number; crc: number; mode: ModemMode } | null {
  if (!Number.isInteger(nbits) || nbits < 2 || typeof base64 !== "string") return null;
  let raw: Uint8Array;
  try {
    raw = fromBase64(base64);
  } catch {
    return null;
  }
  const n = (nbits + 7) >> 3;
  if (raw.length !== n + 3) return null;
  return { bits: raw.slice(0, n), nbits, crc: (raw[n]! << 8) | raw[n + 1]!, mode: raw[n + 2] === 1 ? "fast" : "robust" };
}

export class RelayTransport implements LinkTransport {
  readonly role: BandRole;
  private readonly win: RelayWindow;
  private readonly clock: () => number;
  private readonly timers: RelayTimers | null;
  private readonly timer: unknown = null;
  private readonly cap: number;
  private readonly snr: number;
  private frames: OutFrame[] | null = null;
  private lastKey: number | null = null;
  private mode: ModemMode;
  private nextMode: ModemMode;
  private nextSlot: number;
  /** The nonces once keyed: the CRC init this page sends game frames under, and the one it expects. */
  private txKey: number | null = null;
  private rxKey: number | null = null;
  private readonly inbox: LinkPacket[] = [];
  private readonly slotsOut: number[] = [];
  private rxOk = 0;
  private rxBad = 0;
  private lastRxAt: number | null = null;
  private rxMode: ModemMode | null = null;
  private closed = false;
  private readonly onIn = (base64: string, nbits: number): void => this.receive(base64, nbits);

  constructor(o: RelayOptions) {
    this.role = o.role;
    this.win = o.win;
    this.clock = o.now ?? (() => performance.now());
    this.cap = o.capacity ?? 188;
    this.snr = o.snrDb ?? 30;
    this.mode = this.nextMode = o.mode ?? "robust";
    this.nextSlot = this.clock();
    this.win.__duelIn = this.onIn;
    this.timers = o.timers === undefined ? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as number) } : o.timers;
    if (this.timers) this.timer = this.timers.setInterval(() => this.tick(), TICK_MS);
  }

  /** The page has a __duelOut to send through. */
  connected(): boolean {
    return typeof this.win.__duelOut === "function";
  }

  /** Send the packets that are due (the transport's own timer calls it; so do poll() and slots()). */
  tick(): void {
    if (this.closed) return;
    const now = this.clock();
    if (now < this.nextSlot) return;
    this.mode = this.nextMode;
    const period = RELAY_PERIOD_MS[this.mode];
    // (more than a period missed: one packet, and the period starts over from now)
    this.nextSlot = now - this.nextSlot >= period ? now + period : this.nextSlot + period;
    this.slotsOut.push(now);
    if (this.slotsOut.length > 256) this.slotsOut.shift();
    const frames = this.frames;
    if (!frames) return;
    const f = frames[nextFrameIndex(frames, this.lastKey)]!;
    this.lastKey = f.key;
    const game = f.nbits >= 2 && f.bits[0]! >> 6 === TYPE_GAME;
    const init = game && this.txKey !== null ? this.txKey : CRC_INIT;
    const out = this.win.__duelOut;
    if (typeof out !== "function") return;
    try {
      out(encodeRelayPacket(f, init, this.mode), f.nbits);
    } catch (e) {
      // (the harness's trouble is a lost packet here, as the air's would be)
      console.warn("relay:", e);
    }
  }

  capacity(): number {
    return this.cap;
  }

  send(frames: readonly OutFrame[]): void {
    if (this.closed) return;
    if (!frames.length) throw new RangeError("send() needs at least one frame");
    this.frames = frames.map(({ bits, nbits, key }, i) => {
      if (nbits > this.cap || nbits < 0) throw new RangeError(`a ${nbits}-bit frame in a ${this.cap}-bit packet`);
      if (i > 0 && key <= frames[i - 1]!.key) throw new RangeError("frame keys must ascend");
      return { bits: bits.slice(0, (nbits + 7) >> 3), nbits, key };
    });
  }

  poll(): LinkPacket[] {
    this.tick();
    return this.inbox.splice(0);
  }

  slots(): number[] {
    this.tick();
    return this.slotsOut.splice(0);
  }

  now(): number {
    return this.clock();
  }

  setMode(mode: ModemMode): void {
    if (!this.closed) this.nextMode = mode;
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    if (this.closed) return;
    this.txKey = crcKey(this.role, hostNonce, guestNonce);
    this.rxKey = crcKey(other(this.role), hostNonce, guestNonce);
  }

  stats(): LinkStats {
    const since = this.lastRxAt === null ? Infinity : this.clock() - this.lastRxAt;
    return {
      locked: !this.closed && since < LOCK_MS,
      snrDb: this.closed || this.lastRxAt === null ? null : this.snr,
      rxOk: this.rxOk,
      rxBad: this.rxBad,
      txMode: this.mode,
      rxMode: this.rxMode,
      sinceRx: since,
      ownSnrDb: null,
      loopbackMs: null,
      plan: "high"
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timers && this.timer !== null) this.timers.clearInterval(this.timer);
    if (this.win.__duelIn === this.onIn) delete this.win.__duelIn;
    this.frames = null;
    this.inbox.length = 0;
    this.slotsOut.length = 0;
  }

  /** __duelIn: a packet from the friend, checked as the modem checks its CRC. */
  private receive(base64: string, nbits: number): void {
    if (this.closed) return;
    const p = decodeRelayPacket(base64, nbits);
    if (!p || nbits > this.cap) {
      this.rxBad++;
      return;
    }
    const bitList = unpack(p.bits, p.nbits);
    // (each key only for its own type, as the modem decides: a session key of 0xFFFF must not take the lobby's frames)
    const game = p.bits[0]! >> 6 === TYPE_GAME;
    const session = game && this.rxKey !== null && crc16(bitList, p.nbits, this.rxKey) === p.crc;
    const plain = !game && crc16(bitList, p.nbits, CRC_INIT) === p.crc;
    if (!session && !plain) {
      this.rxBad++;
      return;
    }
    const bits = new Uint8Array((this.cap + 7) >> 3);
    bits.set(p.bits);
    const at = this.clock();
    this.inbox.push({ bits, nbits: this.cap, snrDb: this.snr, at, session });
    if (this.inbox.length > 256) this.inbox.shift();
    this.rxOk++;
    this.lastRxAt = at;
    this.rxMode = p.mode;
  }
}
