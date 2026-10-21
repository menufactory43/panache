/**
 * The modem's numerology (SOUND-DUEL.md "The modem" > Numerology): OFDM on a
 * 25 Hz tone grid, 40 ms useful symbols plus a 10 ms cyclic prefix, two band
 * plans with a host and a guest band each, and packets whose length in
 * symbols depends on the plan and the mode while the payload never does.
 *
 * Every duration is a whole number of samples at any rate that is a multiple
 * of 100 Hz (the symbol parts are 1/25, 1/100 and 1/20 s); the few that are
 * not (the 1.25 ms crossfade and taper, the 1 ms back-off) are rounded on
 * each phone, which never affects what the other phone hears.
 */
import { PAYLOAD_BITS, type BandPlan, type BandRole, type ModemMode } from "../transport";

/** Tone k sits at 25·k Hz: an exact DFT bin of the 40 ms symbol at 44.1 and 48 kHz alike. */
export const TONE_HZ = 25;
/** Useful symbol, cyclic prefix and whole symbol (s). */
export const TU = 0.04;
export const TCP = 0.01;
export const TS = TU + TCP;
/** A superframe is one sync symbol then this many data symbols. */
export const DATA_SYMBOLS = 40;
export const SUPERFRAME_SYMBOLS = DATA_SYMBOLS + 1;
/** Within a band, tone index i % 8 == 0 is a pilot. */
export const PILOT_EVERY = 8;
export const CRC_BITS = 16;
export const TAIL_BITS = 6;
/** Band RMS at gain 1 (dBFS, relative to a full-scale 1.0), and the most gain allowed. */
export const BAND_RMS_DBFS = -15;
export const MAX_GAIN = 1.5;
/** Transmitted samples beyond this are clipped (and counted: a fault, not a normal path). */
export const CLIP = 0.9;

/** First and last tone index of each band. */
export const BAND_TONES: Record<BandPlan, Record<BandRole, readonly [number, number]>> = {
  high: { host: [381, 500], guest: [639, 758] },
  low: { host: [201, 260], guest: [321, 380] }
};

/** Symbols per packet. */
export const PACKET_SYMBOLS: Record<BandPlan, Record<ModemMode, number>> = {
  high: { fast: 2, robust: 4 },
  low: { fast: 4, robust: 8 }
};

/** The lowest rate each plan works at (its top tone stays clear of Nyquist). */
export const MIN_RATE: Record<BandPlan, number> = { high: 44100, low: 24000 };

/** Why a sample rate can't carry a plan, or null when it can. */
export function rateProblem(sr: number, plan: BandPlan): string | null {
  if (Number.isInteger(sr) && sr % 100 === 0 && sr >= MIN_RATE[plan]) return null;
  return `L'audio de ce téléphone tourne à ${sr} Hz, inutilisable pour la liaison sonore`;
}

/** Durations in samples at one rate. */
export interface Timing {
  sr: number;
  /** Useful symbol (the DFT length), prefix and whole symbol. */
  N: number;
  cp: number;
  ts: number;
  /** Transmit crossfade into the next symbol's prefix. */
  tw: number;
  /** WOLA taper: N + beta samples are folded into the N-sample DFT. Even, so beta/2 is whole. */
  beta: number;
  /** The receive window starts this long before the end of the prefix. */
  backoff: number;
  /** Samples per superframe. */
  superframe: number;
}

export function timing(sr: number): Timing {
  const ts = Math.round(TS * sr);
  return {
    sr,
    N: Math.round(TU * sr),
    cp: Math.round(TCP * sr),
    ts,
    tw: Math.round(0.00125 * sr),
    // β/2 is a duration too (0.625 ms), rounded on its own so the fold halves are whole samples
    beta: 2 * Math.round(0.000625 * sr),
    backoff: Math.round(0.001 * sr),
    superframe: SUPERFRAME_SYMBOLS * ts
  };
}

/** One band's tones: pilots every 8th tone, data on the rest. */
export interface Band {
  plan: BandPlan;
  role: BandRole;
  /** Absolute tone indices (tone k is at 25k Hz), and their frequencies. */
  k: Int32Array;
  hz: Float64Array;
  /** Indices into k of the pilots and of the data tones. */
  pilots: Int32Array;
  data: Int32Array;
  /** Data tones (T in the spec): 105 high, 52 low. */
  T: number;
  loHz: number;
  hiHz: number;
}

export function band(plan: BandPlan, role: BandRole): Band {
  const [k0, k1] = BAND_TONES[plan][role];
  const n = k1 - k0 + 1;
  const k = new Int32Array(n);
  const hz = new Float64Array(n);
  const pilots: number[] = [];
  const data: number[] = [];
  for (let i = 0; i < n; i++) {
    k[i] = k0 + i;
    hz[i] = TONE_HZ * (k0 + i);
    (i % PILOT_EVERY === 0 ? pilots : data).push(i);
  }
  return { plan, role, k, hz, pilots: Int32Array.from(pilots), data: Int32Array.from(data), T: data.length, loHz: TONE_HZ * k0, hiHz: TONE_HZ * k1 };
}

/** A packet's geometry for one plan and mode. */
export interface Shape {
  plan: BandPlan;
  mode: ModemMode;
  /** Symbols per packet, data tones, bits per tone. */
  P: number;
  T: number;
  b: number;
  /** Coded bits (P·T·b), trellis steps (half that: payload + CRC + tail), payload bits. */
  coded: number;
  steps: number;
  capacity: number;
  /** Interleaver constants: data tone t = (A·q + B·s) mod T. */
  ilA: number;
  ilB: number;
}

export function shape(plan: BandPlan, mode: ModemMode): Shape {
  const P = PACKET_SYMBOLS[plan][mode];
  const T = plan === "high" ? 105 : 52;
  const b = mode === "fast" ? 2 : 1;
  const coded = P * T * b;
  const steps = coded / 2;
  const capacity = steps - CRC_BITS - TAIL_BITS;
  if (capacity !== PAYLOAD_BITS[plan]) throw new Error(`modem capacity ${capacity} ≠ PAYLOAD_BITS.${plan}`);
  const [ilA, ilB] = T === 105 ? [8, 56] : [17, 4];
  return { plan, mode, P, T, b, coded, steps, capacity, ilA, ilB };
}

/**
 * The sync symbol's data-tone phases: pattern A (the superframe is robust) is
 * Newman's π·i²/T, which keeps the crest factor low; B (fast) is its mirror.
 */
export function syncPhases(T: number, mode: ModemMode): Float64Array {
  const sgn = mode === "robust" ? 1 : -1;
  return Float64Array.from({ length: T }, (_, i) => sgn * ((Math.PI * i * i) / T));
}

/**
 * The fixed pilot phases, the same in every symbol (the spec leaves the set
 * open): Newman phases over the pilot index, so the pilots alone have a low
 * crest factor too.
 */
export function pilotPhases(count: number): Float64Array {
  return Float64Array.from({ length: count }, (_, j) => (Math.PI * j * j) / count + Math.PI / 4);
}

/**
 * A gain clamped to 0 … MAX_GAIN, or `fallback` when there is none or it is
 * NaN (a gain computed on the main thread from a bad measurement must not
 * turn every output sample into NaN).
 */
export function clampGain(gain: number | undefined, fallback: number): number {
  if (gain === undefined || Number.isNaN(gain)) return fallback;
  return Math.max(0, Math.min(MAX_GAIN, gain));
}

/** Per-tone amplitude that puts a band of `tones` equal tones at BAND_RMS_DBFS × gain. */
export function toneAmplitude(tones: number, gain: number): number {
  return Math.pow(10, BAND_RMS_DBFS / 20) * clampGain(gain, 1) * Math.sqrt(2 / tones);
}
