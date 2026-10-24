/**
 * The sound link's seam (DUEL.md "Link layer"): what the lockstep and
 * the pairing see of a link, whatever carries it — the acoustic modem in an
 * AudioWorklet (WorkletTransport), two modems in a simulated room (RoomLink),
 * a frame-level simulation (PacketAir) or a test relay. Types, and the
 * rotation rule every transport shares.
 */

/** "fast": differential QPSK, short packets; "robust": differential BPSK, packets twice as long. Same payload. */
export type ModemMode = "robust" | "fast";
/** "high": host 9.525–12.5 kHz, guest 15.975–18.95 kHz; "low": host 5.025–6.5 kHz, guest 8.025–9.5 kHz. */
export type BandPlan = "high" | "low";
/** Which phone's band: the host's or the guest's. */
export type BandRole = "host" | "guest";

/** Payload bits per packet, the same in both modes. */
export const PAYLOAD_BITS: Record<BandPlan, number> = { high: 188, low: 186 };

/**
 * One frame for the air. A transport holds a list of them and sends one per
 * packet, in key rotation (DUEL.md "Segments and rotation"): after a
 * packet carrying key k, the next carries the first frame whose key is greater
 * than k, wrapping to the first. A list of one repeats in every packet.
 */
export interface OutFrame {
  /** MSB-first: bit i is (bits[i >> 3] >> (7 - (i & 7))) & 1. */
  bits: Uint8Array;
  nbits: number;
  /** Ascending within a list (the lockstep uses each segment's start turn). */
  key: number;
}

/** A packet that arrived intact (CRC and Viterbi gate passed). */
export interface LinkPacket {
  /** MSB-first: bit i is (bits[i >> 3] >> (7 - (i & 7))) & 1. */
  bits: Uint8Array;
  nbits: number;
  /** Effective SNR of the packet (dB), when the link measures it. */
  snrDb: number | null;
  /**
   * When the packet finished arriving at this phone, on this link's clock
   * (ms): its last sample, as this phone's receiver places it, the earliest
   * anything could decode it. Every transport stamps that instant, the
   * modem's (RoomLink, WorkletTransport) as its first DFT window plus the
   * rest of the packet, PacketAir and a relay as its delivery, and never
   * later than now() when polled. A slot is a packet's start on the sender's
   * clock, so the pairing's round trip (a ping's slot to its echo's arrival,
   * less the hold) runs from packet start to fully received both ways, both
   * packets' air time included; a sealed turn also waits for the next packet
   * start (pairing.ts delayFor).
   */
  at: number;
  /**
   * It passed the session CRC (a game frame of this pairing), not the
   * default one. See LinkTransport.setSessionKey for what a transport without
   * a CRC owes here.
   */
  session: boolean;
}

export interface LinkStats {
  locked: boolean;
  snrDb: number | null;
  rxOk: number;
  rxBad: number;
  txMode: ModemMode;
  rxMode: ModemMode | null;
  /** Milliseconds since the last good packet (Infinity: none yet). */
  sinceRx: number;
  /** Effective SNR of this phone's own transmission at its own microphone (the route check), dB. */
  ownSnrDb: number | null;
  /** Speaker-to-own-microphone delay (ms). */
  loopbackMs: number | null;
  plan: BandPlan;
}

export interface LinkTransport {
  /** Payload bits per packet (constant for a band plan). */
  capacity(): number;
  /** The frames packets take from now on, one each in key rotation, until replaced. Each nbits ≤ capacity(); keys ascending; at least one. */
  send(frames: readonly OutFrame[]): void;
  /** Packets received since the last call. */
  poll(): LinkPacket[];
  /** Start times of the packets that went out since the last call, on this link's clock (ms). */
  slots(): number[];
  /** Monotonic milliseconds. */
  now(): number;
  /** The transmit mode from the next superframe on. */
  setMode(mode: ModemMode): void;
  /**
   * Turn on the session CRC for game frames (DUEL.md "Replay
   * protection"). The session drops every game frame whose `session` is
   * false, whatever the transport, so a game frame of another pairing (or of
   * none) can't get into a match. The modem enforces it with the CRC itself.
   * A transport without the modem's CRC (PacketAir, a relay) must emulate it:
   * carry the sender's key with each game frame and drop the frame at a
   * receiver whose key differs, as PacketAir does (RelayTransport carries the
   * modem's keyed CRC itself), or report `session` true only for game frames
   * the sender sent under the receiver's key. Lobby frames always pass, with
   * `session` false. One that reports `session` false for every game frame
   * plays no match at all: both phones stall at tick D. No transport can
   * unset a key: a new one replaces it.
   */
  setSessionKey(hostNonce: number, guestNonce: number): void;
  stats(): LinkStats;
  close(): void;
}

/**
 * Which of `frames` the next packet carries, given the key the previous packet
 * carried (null: none yet): the first whose key is greater, wrapping to the
 * first. Allocation-free, so the AudioWorklet can call it per packet.
 */
export function nextFrameIndex(frames: readonly { key: number }[], lastKey: number | null): number {
  if (lastKey === null) return 0;
  for (let i = 0; i < frames.length; i++) if (frames[i]!.key > lastKey) return i;
  return 0;
}
