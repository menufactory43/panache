// The game audio's band guard (SOUND-DUEL.md "Game audio guard"): the guard
// FIR's response for both plans at 44.1 and 48 kHz; the chain audio.ts
// builds around the mix (and takes down again, node for node) against a fake
// AudioContext; link mode's silence; the guard coming on while sound plays,
// rendered from the chain's own schedule through the compressor model (no
// burst from the look-ahead); and the level rule — a loud battle,
// made from the game's own recipes at the game's own levels, through a model
// of the whole guard chain, played by both phones while their modems run in
// the simulated room with the own path at +40 dB, must leave delivery at
// least 98% both ways.
//
// What the level measurement found (20 s duplex runs, the room's default
// speaker nonlinearity, robust and fast, 48/48 kHz at 20 cm and 48/44.1 kHz
// at 30 cm, gain 1 and 1.1):
//  - the room's own synthetic jammer at −20 dBFS RMS after the guard: 84–91%
//    (the spec's 84–90%); at −25 dBFS: 95–100%;
//  - this battle mix at the master: −19 dBFS RMS, peaks −3.5 dBFS. Through
//    the FIR alone it is −27.6 dBFS RMS and delivers 100%; 10 dB louder
//    (−17.6 dBFS RMS, clipping) 88–96%; 14 dB louder 8–32%;
//  - with the limiter at −24 dB (makeup taken back) and the cut at 0 (a
//    margin: every phone cuts 10 dB), a battle 20 dB louder still holds the
//    output to −19 dBFS RMS and fast delivers 99.4% at gain 1 but 98.1% at
//    1.1. At −18 dB: 94–97%;
//  - at −30 dB (shipped) every case delivers 100%: the shipped cut (10 dB)
//    leaves this battle at −37.6 dBFS RMS, and a battle 20 dB louder with the
//    cut at 0 comes out at −21.2 dBFS RMS, −7.9 dBFS peaks; at −36 dB, 100%
//    too, with the game 2 dB quieter under the limiter's ceiling.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compressorMakeupDb, GLUE, GUARD_CUT_DB, GUARD_HIGHPASS_HZ, GUARD_LIMITER, Sfx, sfx, type CompressorSettings } from "../src/game/audio";
import { firGainDb, guardFir, GUARD_SPECS, type GuardPlan } from "../src/game/guard-fir";
import { ModemCore, type RxPacket } from "../src/link/modem/core";
import { Room, type RoomOptions } from "../src/link/sim/room";
import type { ModemMode } from "../src/link/transport";
import { hash32 } from "../src/sim/rand";

// ------------------------------------------------------------------ FIR --

describe("the guard FIR", () => {
  for (const sr of [44100, 48000]) {
    for (const plan of ["high", "low"] as const) {
      it(`${plan} plan at ${sr / 1000} kHz: flat through the passband, quiet from the stopband to Nyquist`, () => {
        const taps = guardFir(sr, plan);
        const spec = GUARD_SPECS[plan];
        // odd, symmetric (linear phase), unit gain at DC
        expect(taps.length % 2).toBe(1);
        for (let i = 0; i < taps.length; i++) expect(taps[i]).toBe(taps[taps.length - 1 - i]);
        expect(Math.abs(firGainDb(taps, sr, 0))).toBeLessThan(0.001);
        let lo = Infinity;
        let hi = -Infinity;
        for (let f = 0; f <= spec.passHz; f += 2) {
          const g = firGainDb(taps, sr, f);
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
        expect(hi - lo, "passband ripple (dB)").toBeLessThan(0.05);
        expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThan(0.03);
        // a grid well under the response's lobe width (sr / length / 8 is about 40 Hz)
        let worst = -Infinity;
        for (let f = spec.stopHz; f <= sr / 2; f += 1) worst = Math.max(worst, firGainDb(taps, sr, f));
        expect(worst, "worst stopband gain (dB)").toBeLessThanOrEqual(-spec.attenDb);
        // the cut-off sits midway
        expect(firGainDb(taps, sr, (spec.passHz + spec.stopHz) / 2)).toBeCloseTo(-6.02, 1);
      });
    }
  }

  it("is about 133–145 taps for the high plan, and keeps every link band down", () => {
    expect(guardFir(44100, "high").length).toBe(133);
    expect(guardFir(48000, "high").length).toBe(143);
    expect(guardFir(44100, "low").length).toBe(167);
    expect(guardFir(48000, "low").length).toBe(181);
    // both phones' bands: high plan 9.525–18.95 kHz, low plan 5.025–9.5 kHz
    for (const sr of [44100, 48000]) {
      for (let f = 9525; f <= 18950; f += 25) expect(firGainDb(guardFir(sr, "high"), sr, f)).toBeLessThan(-70);
      for (let f = 5025; f <= 9500; f += 25) expect(firGainDb(guardFir(sr, "low"), sr, f)).toBeLessThan(-60);
    }
    // a rate the context might pick elsewhere gets a filter that meets the plan too
    const t96 = guardFir(96000, "high");
    let worst = -Infinity;
    for (let f = 9500; f <= 48000; f += 2) worst = Math.max(worst, firGainDb(t96, 96000, f));
    expect(worst).toBeLessThanOrEqual(-70);
  });

  it("is the identity where the rate can't reach the stopband, and a real filter wherever it can", () => {
    // a Bluetooth headset's call route: 16 kHz, Nyquist 8 kHz, below the high plan's 9.5 kHz
    expect(guardFir(16000, "high")).toEqual(new Float32Array([1]));
    expect(guardFir(19000, "high")).toEqual(new Float32Array([1]));
    expect(guardFir(19100, "high").length).toBeGreaterThan(1);
    const low = guardFir(16000, "low");
    let worst = -Infinity;
    for (let f = 5000; f <= 8000; f += 1) worst = Math.max(worst, firGainDb(low, 16000, f));
    expect(worst).toBeLessThanOrEqual(-60);
    expect(() => guardFir(0, "high")).toThrow(RangeError);
    expect(() => guardFir(Number.NaN, "low")).toThrow(RangeError);
  });
});

// ------------------------------------------------------- the audio chain --

/** A fake Web Audio graph: nodes record their connections, params their automation. */
class FParam {
  value: number;
  /** [kind, time, value] as scheduled. */
  readonly events: [string, number, number][] = [];
  constructor(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number): this {
    this.events.push(["set", t, v]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.events.push(["lin", t, v]);
    return this;
  }
  setTargetAtTime(v: number, t: number): this {
    this.events.push(["target", t, v]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.events.push(["exp", t, v]);
    return this;
  }
  cancelScheduledValues(): this {
    this.events.length = 0;
    return this;
  }
  /** Where its automation leaves it: the last event's value, else its own value. */
  get last(): number {
    return this.events.at(-1)?.[2] ?? this.value;
  }
  /** Where the last ramp goes. */
  get target(): number | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]![0] !== "set") return this.events[i]![2];
    return undefined;
  }
}

class FNode {
  readonly out = new Set<FNode>();
  constructor(readonly kind: string) {}
  connect<T extends FNode>(n: T): T {
    this.out.add(n);
    return n;
  }
  disconnect(n?: FNode): void {
    if (n) this.out.delete(n);
    else this.out.clear();
  }
}

class FGain extends FNode {
  readonly gain = new FParam(1);
  constructor() {
    super("gain");
  }
}

class FBiquad extends FNode {
  type = "lowpass";
  readonly frequency = new FParam(350);
  readonly Q = new FParam(1);
  constructor() {
    super("biquad");
  }
}

class FComp extends FNode {
  readonly threshold = new FParam(-24);
  readonly knee = new FParam(30);
  readonly ratio = new FParam(12);
  readonly attack = new FParam(0.003);
  readonly release = new FParam(0.25);
  constructor() {
    super("comp");
  }
  /** The settings its automation leaves it at. */
  settings(): CompressorSettings {
    return { threshold: this.threshold.last, knee: this.knee.last, ratio: this.ratio.last, attack: this.attack.last, release: this.release.last };
  }
}

class FBuffer {
  private readonly data: Float32Array[];
  constructor(ch: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: ch }, () => new Float32Array(length));
  }
  getChannelData(c: number): Float32Array {
    return this.data[c]!;
  }
  copyToChannel(src: Float32Array, c: number): void {
    this.data[c]!.set(src);
  }
}

class FConvolver extends FNode {
  private norm = true;
  private buf: FBuffer | null = null;
  /** normalize as it was when the buffer was set. */
  normalizeAtBuffer: boolean | null = null;
  constructor() {
    super("convolver");
  }
  get normalize(): boolean {
    return this.norm;
  }
  set normalize(v: boolean) {
    this.norm = v;
  }
  get buffer(): FBuffer | null {
    return this.buf;
  }
  set buffer(b: FBuffer | null) {
    this.buf = b;
    this.normalizeAtBuffer = this.norm;
  }
}

class FContext {
  static made: FContext[] = [];
  /** The next context's rate. */
  static rate = 48000;
  /** The next context has no ConvolverNode (createConvolver throws). */
  static noConvolver = false;
  private readonly convolvers = !FContext.noConvolver;
  readonly sampleRate = FContext.rate;
  currentTime = 0;
  state = "running";
  readonly destination = new FNode("destination");
  readonly nodes: FNode[] = [];
  constructor() {
    FContext.made.push(this);
  }
  private add<T extends FNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain(): FGain {
    return this.add(new FGain());
  }
  createBiquadFilter(): FBiquad {
    return this.add(new FBiquad());
  }
  createDynamicsCompressor(): FComp {
    return this.add(new FComp());
  }
  createConvolver(): FConvolver {
    if (!this.convolvers) throw new Error("NotSupportedError");
    return this.add(new FConvolver());
  }
  createBuffer(ch: number, len: number, sr: number): FBuffer {
    return new FBuffer(ch, len, sr);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

const cancelSpeech = vi.fn();
const speak = vi.fn();
const listeners: Record<string, ((e?: unknown) => void)[]> = {};
const g = globalThis as Record<string, unknown>;
const hadWindow = "window" in g;

beforeAll(() => {
  g.window = {
    AudioContext: FContext,
    speechSynthesis: {
      cancel: cancelSpeech,
      speak,
      speaking: false,
      pending: false,
      getVoices: () => [],
      addEventListener: () => undefined
    },
    addEventListener: (ev: string, fn: (e?: unknown) => void) => (listeners[ev] ??= []).push(fn),
    removeEventListener: (ev: string, fn: (e?: unknown) => void) => {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    // the announcer's watchdogs never fire here (they would outlive the stub)
    setTimeout: () => 0,
    clearTimeout: () => undefined
  };
  g.SpeechSynthesisUtterance = class {
    volume = 1;
    constructor(readonly text: string) {}
  };
});

afterAll(() => {
  if (!hadWindow) delete g.window;
  delete g.SpeechSynthesisUtterance;
});

/** The nodes a node feeds. */
const outs = (n: unknown) => [...(n as FNode).out];

describe("the guard chain (audio.ts)", () => {
  function unlocked(): { s: Sfx; ctx: FContext; master: FGain; comp: FComp } {
    FContext.made = [];
    const s = new Sfx();
    s.unlock();
    const ctx = FContext.made[0]!;
    const comp = ctx.nodes.find((n) => n instanceof FComp) as FComp;
    const master = ctx.nodes.find((n) => n instanceof FGain && n.out.has(comp)) as FGain;
    return { s, ctx, master, comp };
  }

  it("puts high-pass, cut, limiter and the plan's FIR between the master and the speakers, and takes them out again exactly", () => {
    vi.useFakeTimers();
    try {
      const { s, ctx, master, comp } = unlocked();
      const dest = ctx.destination;
      // the original chain
      expect(outs(master)).toEqual([comp]);
      expect(outs(comp)).toEqual([dest]);
      expect(comp.settings()).toEqual(GLUE);
      const before = ctx.nodes.length;
      cancelSpeech.mockClear();

      s.setLinkGuard("high");
      expect(s.linkMode).toBe(true);
      expect(cancelSpeech).toHaveBeenCalled();
      const [hp] = outs(master) as [FBiquad];
      expect(hp).toBeInstanceOf(FBiquad);
      expect(hp.type).toBe("highpass");
      expect(hp.frequency.value).toBe(GUARD_HIGHPASS_HZ);
      expect(hp.Q.value).toBeCloseTo(-3.01, 2);
      const [cut] = outs(hp) as [FGain];
      expect(outs(cut)).toEqual([comp]);
      // the cut takes back the limiter's makeup, so sounds under the limiter come out GUARD_CUT_DB down
      const makeup = compressorMakeupDb(GUARD_LIMITER);
      expect(makeup).toBeCloseTo(17.1, 1);
      expect(20 * Math.log10(cut.gain.value)).toBeCloseTo(-(GUARD_CUT_DB + makeup), 6);
      expect(comp.settings()).toEqual(GUARD_LIMITER);
      const after = outs(comp);
      expect(after).toHaveLength(2);
      const dry = after.find((n) => n instanceof FGain) as FGain;
      const conv = after.find((n) => n instanceof FConvolver) as FConvolver;
      expect(outs(dry)).toEqual([dest]);
      const [firGain] = outs(conv) as [FGain];
      expect(outs(firGain)).toEqual([dest]);
      // normalize off before the buffer, and the buffer is the plan's taps at the context's rate
      expect(conv.normalize).toBe(false);
      expect(conv.normalizeAtBuffer).toBe(false);
      expect(conv.buffer!.getChannelData(0)).toEqual(guardFir(48000, "high"));
      // dry fades out and the FIR in, over 50 ms
      expect(dry.gain.target).toBe(0);
      expect(firGain.gain.target).toBe(1);
      expect(dry.gain.events.at(-1)![1]).toBeCloseTo(0.05, 9);
      expect(firGain.gain.events.at(-1)![1]).toBeCloseTo(0.05, 9);

      // mute stays on the master alone
      s.setMuted(true);
      expect(master.gain.target).toBe(0);
      expect(cut.gain.target).toBeUndefined();
      s.setMuted(false);

      // a Join that locked the low plan: a second FIR, crossfaded
      s.setLinkGuard("low");
      const conv2 = outs(comp).find((n) => n instanceof FConvolver && n !== conv) as FConvolver;
      expect(conv2.normalizeAtBuffer).toBe(false);
      expect(conv2.buffer!.getChannelData(0)).toEqual(guardFir(48000, "low"));
      const firGain2 = outs(conv2)[0] as FGain;
      expect(firGain.gain.target).toBe(0);
      expect(firGain2.gain.target).toBe(1);
      expect(dry.gain.target).toBe(0);
      expect(s.linkGuard).toBe("low");

      // no cut (the option measurements use): the limiter's makeup still taken back
      s.setLinkGuard("low", { cutDb: 0 });
      expect(20 * Math.log10(cut.gain.target!)).toBeCloseTo(-makeup, 6);

      // off: the FIRs fade to dry, then the original chain comes back
      s.setLinkGuard(null);
      expect(s.linkMode).toBe(false);
      expect(s.linkGuard).toBeNull();
      expect(dry.gain.target).toBe(1);
      expect(firGain2.gain.target).toBe(0);
      expect(outs(master)).toEqual([hp]);
      vi.advanceTimersByTime(60);
      expect(outs(master)).toEqual([comp]);
      expect(outs(comp)).toEqual([dest]);
      expect(comp.settings()).toEqual(GLUE);
      for (const n of ctx.nodes.slice(before)) expect(outs(n), n.kind).toEqual([]);

      // and on again: the same chain rebuilt
      s.setLinkGuard("high");
      expect(outs(master)[0]).toBeInstanceOf(FBiquad);
      expect(comp.settings()).toEqual(GUARD_LIMITER);
      s.setLinkGuard(null);
      // turning it on again during the fade-out keeps the guard
      s.setLinkGuard("high");
      vi.advanceTimersByTime(100);
      expect(outs(master)[0]).toBeInstanceOf(FBiquad);
      expect(comp.settings()).toEqual(GUARD_LIMITER);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a guard asked for before audio started when it starts", () => {
    FContext.made = [];
    const s = new Sfx();
    s.setLinkGuard("high");
    expect(s.linkMode).toBe(true);
    expect(FContext.made).toHaveLength(0);
    s.unlock();
    const ctx = FContext.made[0]!;
    const comp = ctx.nodes.find((n) => n instanceof FComp) as FComp;
    expect(comp.settings()).toEqual(GUARD_LIMITER);
    expect(ctx.nodes.some((n) => n instanceof FConvolver)).toBe(true);
  });
});

describe("link mode", () => {
  it("speaks no words: radioCheck codes instead, and the speech priming waits", async () => {
    const { radioCheck } = await import("../src/game/announcer");
    const prime = listeners.pointerup?.[0];
    expect(prime).toBeDefined();
    sfx.linkMode = true;
    speak.mockClear();
    prime!();
    radioCheck();
    expect(speak).not.toHaveBeenCalled();
    // out of link mode both speak again (the primer is a silent utterance)
    sfx.linkMode = false;
    prime!();
    expect(speak).toHaveBeenCalledTimes(1);
    radioCheck();
    expect(speak).toHaveBeenCalledTimes(2);
    expect((speak.mock.calls[1]![0] as { text: string }).text).toBe("Essai radio");
  });

  it("is never saved", () => {
    const s = new Sfx();
    s.linkMode = true;
    expect(JSON.stringify(s.settings)).not.toContain("link");
  });
});

// --------------------------------------------------- the battle, rendered --

type Ev = readonly [kind: "set" | "exp" | "lin", t: number, v: number];

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An AudioParam's values for samples a … a + n − 1 under its events (setValueAtTime, then exponential or linear ramps). */
function automate(evs: readonly Ev[], sr: number, a: number, n: number): Float64Array {
  const out = new Float64Array(n);
  let v = evs[0]![2];
  let t0 = evs[0]![1];
  let i = 0;
  for (let e = 1; e <= evs.length; e++) {
    const ev = evs[e];
    const end = ev ? Math.min(n, Math.max(i, Math.ceil(ev[1] * sr) - a)) : n;
    if (!ev || ev[0] === "set") {
      out.fill(v, i, end);
      i = end;
      if (ev) [, t0, v] = ev;
      continue;
    }
    const [k, t1, v1] = ev;
    const at = (j: number) => ((a + j) / sr - t0) / (t1 - t0);
    if (k === "exp") {
      const per = Math.pow(v1 / v, 1 / ((t1 - t0) * sr));
      let x = v * Math.pow(v1 / v, at(i));
      for (; i < end; i++, x *= per) out[i] = x;
    } else for (; i < end; i++) out[i] = v + (v1 - v) * at(i);
    v = v1;
    t0 = t1;
  }
  return out;
}

/** BiquadFilterNode's response, as the Web Audio spec defines it (a lowpass/highpass Q in dB, a bandpass Q plain). */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  constructor(
    private readonly type: BiquadFilterType,
    private readonly sr: number,
    private readonly q = 1
  ) {}
  set(f: number): void {
    const w = (2 * Math.PI * Math.min(f, this.sr / 2 - 1)) / this.sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const al = this.type === "bandpass" ? s / (2 * this.q) : s / (2 * Math.pow(10, this.q / 20));
    const a0 = 1 + al;
    if (this.type === "bandpass") [this.b0, this.b1, this.b2] = [al / a0, 0, -al / a0];
    else {
      const b = this.type === "lowpass" ? (1 - c) / 2 : (1 + c) / 2;
      [this.b0, this.b1, this.b2] = [b / a0, (this.type === "lowpass" ? 2 * b : -2 * b) / a0, b / a0];
    }
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * A mono offline renderer for the game's recipes: audio.ts's noiseBurst()
 * (the shared 2 s noise at a random 0.8–1.2 rate and offset, a swept
 * biquad, an exponential decay) and tone() (a band-limited oscillator with
 * an exponential sweep and envelope), into one buffer.
 */
class Mix {
  readonly buf: Float64Array;
  private readonly noise: Float32Array;
  constructor(
    readonly sr: number,
    seconds: number,
    private readonly r: () => number
  ) {
    this.buf = new Float64Array(Math.round(seconds * sr));
    this.noise = new Float32Array(2 * sr);
    for (let i = 0; i < this.noise.length; i++) this.noise[i] = r() * 2 - 1;
  }

  noiseBurst(out: number, t: number, dur: number, type: BiquadFilterType, freq: number, gain: number, freqEnd?: number, o: { q?: number; env?: Ev[]; rate?: number; offset?: number } = {}): void {
    const sr = this.sr;
    const rate = o.rate ?? 0.8 + this.r() * 0.4;
    const off = (o.offset ?? this.r() * 0.4) * sr;
    const a = Math.round(t * sr);
    const n = Math.min(Math.round((dur + 0.05) * sr), this.buf.length - a);
    if (n <= 0) return;
    const env = automate(o.env ?? [["set", t, gain], ["exp", t + dur, 0.001]], sr, a, n);
    const fq = freqEnd ? automate([["set", t, freq], ["exp", t + dur, freqEnd]], sr, a, n) : null;
    const f = new Biquad(type, sr, o.q ?? 1);
    f.set(freq);
    for (let k = 0; k < n; k++) {
      const p = off + k * rate;
      const i = Math.floor(p);
      if (i + 1 >= this.noise.length) break;
      const x = this.noise[i]! + (p - i) * (this.noise[i + 1]! - this.noise[i]!);
      if (fq) f.set(fq[k]!);
      this.buf[a + k] = this.buf[a + k]! + out * env[k]! * f.run(x);
    }
  }

  /**
   * An oscillator from `start` to `stop`: its frequency and gain automation,
   * optionally through a biquad. Harmonics stop below 0.45·sr, or below
   * `maxHz` where a filter after it removes the rest anyway.
   */
  osc(out: number, type: OscillatorType, freq: Ev[], gain: Ev[], start: number, stop: number, filter?: { type: BiquadFilterType; hz: number; q?: number }, maxHz = Infinity): void {
    const sr = this.sr;
    const a = Math.round(start * sr);
    const n = Math.min(Math.round(stop * sr), this.buf.length) - a;
    if (n <= 0) return;
    const fq = automate(freq, sr, a, n);
    const env = automate(gain, sr, a, n);
    const bq = filter ? new Biquad(filter.type, sr, filter.q ?? 1) : null;
    bq?.set(filter!.hz);
    const top = Math.min(0.45 * sr, maxHz);
    const norm = type === "square" ? 4 / Math.PI : type === "sawtooth" ? 2 / Math.PI : 8 / (Math.PI * Math.PI);
    let ph = 0;
    for (let k = 0; k < n; k++) {
      const fr = fq[k]!;
      ph += (2 * Math.PI * fr) / sr;
      if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
      let v = 0;
      if (type === "sine") v = Math.sin(ph);
      else {
        // Σ over harmonics, sin(hφ) by the Chebyshev recurrence
        const K = Math.max(1, Math.floor(top / fr));
        const c2 = 2 * Math.cos(ph);
        let s0 = 0;
        let s1 = Math.sin(ph);
        for (let h = 1; h <= K; h++) {
          if (type === "sawtooth") v += ((h & 1 ? 1 : -1) * s1) / h;
          else if (h & 1) v += type === "square" ? s1 / h : (((h >> 1) & 1 ? -1 : 1) * s1) / (h * h);
          const s2 = c2 * s1 - s0;
          s0 = s1;
          s1 = s2;
        }
        v *= norm;
      }
      if (bq) v = bq.run(v);
      this.buf[a + k] = this.buf[a + k]! + out * env[k]! * v;
    }
  }

  /** audio.ts's tone(). */
  tone(out: number, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void {
    const s = t + delay;
    this.osc(out, type, [["set", s, f0], ["exp", s + dur, Math.max(20, f1)]], [["set", s, 0.0001], ["exp", s + 0.008, gain], ["exp", s + dur, 0.0001]], s, s + dur + 0.02);
  }
}

type Recipe = (m: Mix, vol: number, t: number) => void;

/** audio.ts's battle recipes, the loud ones: [recipe, its duration (the voice's hold), its GAP]. */
const BATTLE: Record<string, [Recipe, number, number]> = {
  rifle: [(m, o, t) => { m.noiseBurst(o, t, 0.03, "bandpass", 2800, 0.3); m.noiseBurst(o, t + 0.045, 0.025, "bandpass", 3300, 0.22); m.noiseBurst(o, t + 0.1, 0.03, "bandpass", 2500, 0.18); }, 0.14, 0.06],
  snipe: [(m, o, t) => { m.noiseBurst(o, t, 0.05, "highpass", 3000, 0.6); m.tone(o, t, "sine", 3400, 900, 0.2, 0.09); m.tone(o, t, "sawtooth", 150, 60, 0.12, 0.16); }, 0.22, 0.12],
  crush: [(m, o, t) => { m.noiseBurst(o, t, 0.18, "lowpass", 900, 0.6, 200); m.noiseBurst(o, t + 0.03, 0.08, "bandpass", 2400, 0.3); m.tone(o, t, "square", 220, 90, 0.1, 0.05); }, 0.2, 0.15],
  clank: [(m, o, t) => { m.tone(o, t, "triangle", 900, 640, 0.08, 0.08); m.noiseBurst(o, t, 0.04, "highpass", 3000, 0.16); }, 0.1, 0.07],
  cannon: [(m, o, t) => { m.noiseBurst(o, t, 0.12, "lowpass", 2200, 0.5, 300); m.tone(o, t, "sine", 160, 50, 0.12, 0.5); }, 0.15, 0.05],
  heavy: [(m, o, t) => { m.noiseBurst(o, t, 0.3, "lowpass", 1400, 0.8, 120); m.tone(o, t, "sine", 110, 32, 0.3, 0.9); }, 0.32, 0.05],
  mg: [(m, o, t) => { m.noiseBurst(o, t, 0.04, "highpass", 1800, 0.35); m.noiseBurst(o, t + 0.06, 0.04, "highpass", 1800, 0.3); }, 0.12, 0.07],
  flak: [(m, o, t) => { m.noiseBurst(o, t, 0.06, "bandpass", 1300, 0.6); m.noiseBurst(o, t + 0.08, 0.06, "bandpass", 1100, 0.5); }, 0.16, 0.06],
  rocket: [(m, o, t) => m.noiseBurst(o, t, 0.28, "bandpass", 600, 0.45, 2400), 0.3, 0.05],
  missile: [(m, o, t) => { m.noiseBurst(o, t, 0.4, "bandpass", 500, 0.4, 3000); m.tone(o, t, "triangle", 900, 1500, 0.2, 0.05); }, 0.42, 0.05],
  laser: [(m, o, t) => { m.tone(o, t, "sawtooth", 1400, 180, 0.16, 0.12); m.tone(o, t, "sine", 2200, 600, 0.12, 0.12); }, 0.18, 0.06],
  shell: [(m, o, t) => { m.noiseBurst(o, t, 0.25, "lowpass", 900, 0.8, 80); m.tone(o, t, "sine", 90, 40, 0.25, 0.8); }, 0.28, 0.05],
  explosion: [(m, o, t) => { m.noiseBurst(o, t, 0.6, "lowpass", 1600, 0.9, 90); m.tone(o, t, "sine", 90, 28, 0.45, 0.8); }, 0.62, 0.06],
  bigExplosion: [(m, o, t) => { m.noiseBurst(o, t, 1.4, "lowpass", 1200, 1, 50); m.noiseBurst(o, t + 0.12, 1.0, "lowpass", 700, 0.7, 60); m.tone(o, t, "sine", 70, 22, 1.1, 1); }, 1.45, 0.05],
  kill: [(m, o, t) => { m.noiseBurst(o, t, 0.06, "highpass", 2600, 0.25); m.tone(o, t, "sine", 1600, 1580, 0.09, 0.17); m.tone(o, t, "sine", 2400, 2380, 0.13, 0.15, 0.04); }, 0.2, 0.08],
  stomp: [(m, o, t) => { m.tone(o, t, "sine", 70, 30, 0.22, 0.6); m.noiseBurst(o, t, 0.14, "lowpass", 420, 0.4, 90); m.tone(o, t + 0.01, "triangle", 240, 180, 0.05, 0.03); }, 0.24, 0.18],
  emp: [(m, o, t) => { m.tone(o, t, "square", 2600, 70, 0.38, 0.12); m.tone(o, t, "sawtooth", 1300, 40, 0.3, 0.08, 0.03); m.noiseBurst(o, t, 0.45, "highpass", 3200, 0.45); m.noiseBurst(o, t + 0.12, 0.3, "bandpass", 5200, 0.25); m.tone(o, t, "sine", 130, 38, 0.45, 0.7); }, 0.55, 0.25],
  hammer: [(m, o, t) => { m.noiseBurst(o, t, 0.18, "highpass", 2500, 0.9); m.noiseBurst(o, t, 1.8, "lowpass", 1500, 1, 40); m.noiseBurst(o, t + 0.2, 1.4, "lowpass", 600, 0.8, 50); m.tone(o, t, "sine", 70, 18, 1.6, 1); m.tone(o, t + 0.05, "sine", 48, 16, 1.4, 0.8); }, 1.85, 0.6]
};

/** Requests a second in a big fight on screen (before audio.ts's gaps and voice cap thin them). */
const RATES: Record<string, number> = {
  mg: 7, rifle: 7, cannon: 4, flak: 2, laser: 1.5, rocket: 1.2, missile: 0.6, shell: 1.2, heavy: 0.8,
  explosion: 3, bigExplosion: 0.5, kill: 1.2, stomp: 0.6, snipe: 0.4, crush: 0.4, clank: 1.5, emp: 0.1, hammer: 0.05
};

/** render/fx.ts's level per sound (sound(name, x, y, vol)), before earshot. */
const VOL: Record<string, number> = { cannon: 0.8, mg: 0.6, flak: 0.7, rocket: 0.7, missile: 0.7, laser: 0.7, rifle: 0.55, snipe: 0.8, clank: 0.5, crush: 0.75, explosion: 0.8, stomp: 0.8 };

/** audio.ts's MASTER_GAIN and the music bus. */
const MASTER = 0.55;
const MUSIC_BUS = 0.6;

/** music.ts's battle score at full intensity (96 bpm): the pad, a bass pulse, kick, snare, hats, a crash, the arp; no reverb (link mode). */
function musicBed(sr: number, seconds: number, seed: number): Float64Array {
  const r = mulberry(seed);
  const m = new Mix(sr, seconds, r);
  const step = 60 / 96 / 4;
  const L = { pad: 0.17, bass: 0.26, drums: 0.85, arp: 0.42 };
  const mtof = (x: number) => 440 * Math.pow(2, (x - 69) / 12);
  for (const note of [50, 57, 62, 65])
    for (const [type, gn] of [["sawtooth", 0.25], ["triangle", 0.2]] as const)
      m.osc(L.pad * gn, type, [["set", 0, mtof(note)]], [["set", 0, 1]], 0, seconds, { type: "lowpass", hz: 900, q: 0.7 }, 4000);
  const hit = (t: number, peak: number, attack: number, end: number): Ev[] => [["set", t, 0.0001], ["exp", t + attack, peak], ["exp", end, 0.0001]];
  for (let s = 0; s < Math.floor(seconds / step); s++) {
    const t = s * step;
    const vel = 0.9 + r() * 0.18;
    if (s % 8 === 0 || s % 16 === 10) {
      m.osc(L.drums, "sine", [["set", t, 210], ["exp", t + 0.11, 48]], hit(t, 0.95 * vel, 0.002, t + 0.32), t, t + 0.34);
      m.noiseBurst(L.drums, t, 0.014, "bandpass", 2600, 0, undefined, { q: 2.5, env: hit(t, 0.32 * vel, 0.001, t + 0.014), rate: 1, offset: r() * 0.5 });
    }
    if (s % 8 === 4) {
      m.noiseBurst(L.drums, t, 0.18, "bandpass", 1700, 0, undefined, { q: 0.55, env: hit(t, 0.85 * vel, 0.002, t + 0.18), rate: 1, offset: r() * 0.5 });
      m.osc(L.drums, "triangle", [["set", t, 240], ["exp", t + 0.08, 170]], hit(t, 0.45 * vel, 0.002, t + 0.09), t, t + 0.1);
    }
    if (s % 2 === 0 || r() < 0.4) m.noiseBurst(L.drums, t, 0.04, "highpass", 7000, 0, undefined, { q: 0.7, env: hit(t, 0.3 * vel, 0.001, t + 0.04), rate: 1.3, offset: r() * 0.5 });
    if (s % 64 === 0) m.noiseBurst(L.drums, t, 1.7, "highpass", 4200, 0, undefined, { q: 0.5, env: hit(t, 0.2 * vel, 0.003, t + 1.7), rate: 0.9, offset: r() * 0.1 });
    if (s % 2 === 0) {
      const f = mtof(38 + [0, 0, 7, 5][(s >> 4) % 4]!);
      m.osc(L.bass, "sawtooth", [["set", t, f]], hit(t, 0.55 * vel, 0.006, t + step * 2 * 0.92), t, t + step * 2, { type: "lowpass", hz: 380, q: 2 }, 2500);
    }
    const a = mtof(62 + [0, 3, 7, 10, 12, 10, 7, 3][s % 8]!);
    m.osc(L.arp, "square", [["set", t, a]], hit(t, 0.5 * vel, 0.004, t + 0.2), t, t + 0.2, { type: "lowpass", hz: 2200, q: 1.5 }, 10000);
  }
  return m.buf;
}

/**
 * A big fight on screen, at the master's output (before the guard): the
 * battle recipes requested at RATES, thinned by audio.ts's per-sound gaps and
 * its voice cap (a new sound only while at most 14 play), each at fx.ts's
 * level times an earshot of 0.6–1; the battle score on the music bus; a
 * dropship's engine drone now and then. The gain structure is the game's, so
 * the level is too: about −19 dBFS RMS, peaks about −3.5 dBFS.
 */
function battleMix(sr: number, seconds: number, seed: number): Float64Array {
  const r = mulberry(seed);
  const fx = new Mix(sr, seconds, r);
  const last = new Map<string, number>();
  const ends: number[] = [];
  for (let t = 0; t < seconds - 0.1; t += 0.01) {
    for (let i = ends.length - 1; i >= 0; i--) if (ends[i]! <= t) ends.splice(i, 1);
    for (const [name, rate] of Object.entries(RATES)) {
      if (r() >= rate * 0.01) continue;
      const [recipe, dur, gap] = BATTLE[name]!;
      if (t - (last.get(name) ?? -1) < gap || ends.length > 14) continue;
      last.set(name, t);
      ends.push(t + dur + 0.1);
      recipe(fx, (VOL[name] ?? 1) * (0.6 + 0.4 * r()), t);
    }
  }
  // the "drop" recipe's drone: band-passed noise and a saw through 520 Hz
  for (let t = 0.3; t < seconds - 1.7; t += 3 + 2 * r()) {
    const v = 0.5 + 0.5 * r();
    fx.noiseBurst(v, t, 1.6, "bandpass", 260, 0.35, 900);
    fx.osc(v, "sawtooth", [["set", t, 92], ["lin", t + 0.8, 118], ["lin", t + 1.6, 84]], [["set", t, 0.0001], ["exp", t + 0.6, 0.14], ["exp", t + 1.6, 0.0001]], t, t + 1.65, { type: "lowpass", hz: 520 }, 2500);
  }
  const music = musicBed(sr, seconds, seed ^ 0x55aa);
  const out = new Float64Array(fx.buf.length);
  for (let i = 0; i < out.length; i++) out[i] = MASTER * (fx.buf[i]! + MUSIC_BUS * music[i]!);
  return out;
}

// ------------------------------------------------- the guard, modelled --

/**
 * A DynamicsCompressorNode's static curve at some settings, as Blink and
 * WebKit compute it: linear to the threshold, an exponential knee whose k is
 * found so its slope meets 1/ratio at threshold + knee, then the ratio; and
 * the makeup gain the Web Audio spec requires, (1 / curve(1))^0.6.
 */
class Curve {
  private readonly linT: number;
  private readonly kneeT: number;
  private readonly kneeTdb: number;
  private readonly yKneeTdb: number;
  private readonly k: number;
  private readonly slope: number;
  readonly makeup: number;

  constructor(p: CompressorSettings) {
    const lin = (d: number) => Math.pow(10, d / 20);
    const db = (x: number) => 20 * Math.log10(x);
    this.linT = lin(p.threshold);
    this.slope = 1 / p.ratio;
    const slopeAt = (x: number, k: number) => (x < this.linT ? 1 : (db(this.knee(x * 1.001, k)) - db(this.knee(x, k))) / (db(x * 1.001) - db(x)));
    let minK = 0.1;
    let maxK = 10000;
    let k = 5;
    for (let i = 0; i < 15; i++) {
      if (slopeAt(lin(p.threshold + p.knee), k) < this.slope) maxK = k;
      else minK = k;
      k = Math.sqrt(minK * maxK);
    }
    this.k = k;
    this.kneeTdb = p.threshold + p.knee;
    this.kneeT = lin(this.kneeTdb);
    this.yKneeTdb = db(this.knee(this.kneeT, k));
    this.makeup = Math.pow(1 / this.curve(1), 0.6);
  }

  private knee(x: number, k: number): number {
    return x < this.linT ? x : this.linT + (1 - Math.exp(-k * (x - this.linT))) / k;
  }

  curve(x: number): number {
    if (x < this.kneeT) return this.knee(x, this.k);
    return Math.pow(10, (this.yKneeTdb + this.slope * (20 * Math.log10(x) - this.kneeTdb)) / 20);
  }
}

/**
 * DynamicsCompressorNode as Blink and WebKit implement it
 * (DynamicsCompressorKernel), mono: a 6 ms look-ahead; a peak detector with
 * a 2.5 ms release; attack and adaptive release envelopes set every 32
 * frames; the knee curve; and the makeup gain. Its settings are k-rate: read
 * at the start of every 128-frame render quantum (settingsAt), the curve and
 * the makeup changing at once while the envelopes and the look-ahead's
 * delay line carry on. Checked once against Chromium's own node on this
 * battle mix (Playwright, OfflineAudioContext, at GUARD_LIMITER and at GLUE):
 * RMS within 0.04 dB, the same peaks, the difference 27–36 dB down.
 */
class Compressor {
  readonly makeup: number;

  constructor(
    private readonly sr: number,
    private readonly p: CompressorSettings
  ) {
    this.makeup = new Curve(p).makeup;
  }

  run(x: Float64Array, settingsAt: (frame: number) => CompressorSettings = () => this.p): Float64Array {
    const sr = this.sr;
    const y = new Float64Array(x.length);
    const pre = Math.round(0.006 * sr);
    const satRelease = 0.0025 * sr;
    let p: CompressorSettings | null = null;
    let cv = new Curve(this.p);
    let attackFrames = 0;
    let kA = 0;
    let kB = 0;
    let kC = 0;
    let kD = 0;
    let kE = 0;
    const take = (q: CompressorSettings) => {
      if (p && q.threshold === p.threshold && q.knee === p.knee && q.ratio === p.ratio && q.attack === p.attack && q.release === p.release) return;
      if (!p || q.threshold !== p.threshold || q.knee !== p.knee || q.ratio !== p.ratio) cv = new Curve(q);
      p = q;
      attackFrames = Math.max(0.001, q.attack) * sr;
      const [y1, y2, y3, y4] = [0.09, 0.16, 0.42, 0.98].map((z) => sr * q.release * z) as [number, number, number, number];
      // the release curve through four zones (x = 0 … 3 for 15 … 0 dB of compression)
      kA = 0.9999999999999998 * y1 + 1.8432219684323923e-16 * y2 - 1.9373394351676423e-16 * y3 + 8.824516011816245e-18 * y4;
      kB = -1.5788320352845888 * y1 + 2.3305837032074286 * y2 - 0.9141194204840429 * y3 + 0.1623677525612032 * y4;
      kC = 0.5334142869106424 * y1 - 1.272736789213631 * y2 + 0.9258856042207512 * y3 - 0.18656310191776226 * y4;
      kD = 0.08783463138207234 * y1 - 0.1694162967925622 * y2 + 0.08588057951595272 * y3 - 0.00429891410546283 * y4;
      kE = -0.042416883008123074 * y1 + 0.1115693827987602 * y2 - 0.09764676325265872 * y3 + 0.028494263462021576 * y4;
    };
    let det = 1;
    let gain = 1;
    let maxAttack = -1;
    for (let d = 0; d + 32 <= x.length; d += 32) {
      if (d % 128 === 0) take(settingsAt(d));
      const scaled = Math.asin(det) / (Math.PI / 2);
      let diff = 20 * Math.log10(gain / scaled);
      let rate: number;
      if (scaled > gain) {
        maxAttack = -1;
        if (!Number.isFinite(diff)) diff = -1;
        const u = 0.25 * (Math.min(0, Math.max(-12, diff)) + 12);
        rate = Math.pow(10, 5 / (kA + kB * u + kC * u * u + kD * u ** 3 + kE * u ** 4) / 20);
      } else {
        if (!Number.isFinite(diff)) diff = 1;
        if (maxAttack === -1 || maxAttack < diff) maxAttack = diff;
        rate = 1 - Math.pow(0.25 / Math.max(0.5, maxAttack), 1 / attackFrames);
      }
      for (let i = d; i < d + 32; i++) {
        const a = Math.abs(x[i]!);
        const att = a <= 0.0001 ? 1 : cv.curve(a) / a;
        const satRate = Math.pow(10, Math.max(2, -20 * Math.log10(att)) / satRelease / 20) - 1;
        det = Math.min(1, det + (att - det) * (att > det ? satRate : 1));
        if (rate < 1) gain += (scaled - gain) * rate;
        else gain = Math.min(1, gain * rate);
        y[i] = (i >= pre ? x[i - pre]! : 0) * cv.makeup * Math.sin((Math.PI / 2) * gain);
      }
    }
    return y;
  }
}

/**
 * audio.ts's guard on a looped signal, as the speaker gets it: high-pass
 * (one Butterworth section), the cut (with the limiter's makeup taken back),
 * the limiter, the FIR, and the output's clipping at ±1. The IIR stages and
 * the limiter run twice round the loop so their state wraps; the FIR is
 * circular.
 */
function guard(x: Float64Array, sr: number, plan: GuardPlan, o: { cutDb: number; limiter: CompressorSettings | null; highpass?: boolean }): Float32Array {
  const n = x.length;
  const hp = new Biquad("highpass", sr, -3.0103);
  hp.set(GUARD_HIGHPASS_HZ);
  const lim = o.limiter;
  const cut = Math.pow(10, -(o.cutDb + (lim ? compressorMakeupDb(lim) : 0)) / 20);
  const two = new Float64Array(2 * n);
  for (let i = 0; i < 2 * n; i++) two[i] = (o.highpass === false ? x[i % n]! : hp.run(x[i % n]!)) * cut;
  const c = (lim ? new Compressor(sr, lim).run(two) : two).subarray(n);
  const fir = guardFir(sr, plan);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < fir.length; k++) acc += fir[k]! * c[(i - k + n) % n]!;
    out[i] = Math.max(-1, Math.min(1, acc));
  }
  return out;
}

function level(x: ArrayLike<number>): { rmsDb: number; peakDb: number } {
  let e = 0;
  let pk = 0;
  for (let i = 0; i < x.length; i++) {
    e += x[i]! * x[i]!;
    pk = Math.max(pk, Math.abs(x[i]!));
  }
  return { rmsDb: 10 * Math.log10(e / x.length), peakDb: 20 * Math.log10(pk) };
}

// ------------------------------------------- the guard coming on, heard --

/** An FParam's values for frames a … a + n − 1: its own value, then its automation. */
const track = (p: FParam, sr: number, a: number, n: number) => automate([["set", 0, p.value], ...(p.events as unknown as Ev[])], sr, a, n);

/**
 * The speaker's signal around setLinkGuard turning the guard on at tOn, from
 * the graph it built in the fake context (the nodes, their values and their
 * automation): before tOn, master → glue compressor; from tOn, master →
 * high-pass → cut → compressor (its settings read every render quantum) →
 * dry + FIR. `x` is the master's output. `lag` (s) holds the cut's own value
 * back that long, as when the page's currentTime trails the audio thread's
 * and what was set "now" lands later than what was scheduled from it.
 */
function renderGuardOn(x: Float64Array, sr: number, tOn: number, n: { hp: FBiquad; cut: FGain; comp: FComp; dry: FGain; conv: FConvolver; fir: FGain }, lag = 0): Float64Array {
  const len = x.length;
  const on = Math.round(tOn * sr);
  const rest = len - on;
  const late = Math.round(lag * sr);
  const hp = new Biquad(n.hp.type as BiquadFilterType, sr, n.hp.Q.value);
  hp.set(n.hp.frequency.value);
  const cut = track(n.cut.gain, sr, on, rest);
  const input = new Float64Array(len);
  for (let i = 0; i < len; i++) input[i] = i < on ? x[i]! : hp.run(x[i]!) * (i - on < late ? 1 : cut[i - on]!);
  const keys = ["threshold", "knee", "ratio", "attack", "release"] as const;
  const tracks = keys.map((k) => track(n.comp[k], sr, on, rest));
  const settingsAt = (i: number): CompressorSettings => {
    if (i < on) return GLUE;
    const [threshold, knee, ratio, attack, release] = tracks.map((t) => t[i - on]!) as [number, number, number, number, number];
    return { threshold, knee, ratio, attack, release };
  };
  const c = new Compressor(sr, GLUE).run(input, settingsAt);
  const dry = track(n.dry.gain, sr, on, rest);
  const fir = track(n.fir.gain, sr, on, rest);
  const taps = n.conv.buffer!.getChannelData(0);
  const y = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < on) {
      y[i] = c[i]!;
      continue;
    }
    let acc = 0;
    for (let k = 0; k < taps.length && i - k >= on; k++) acc += taps[k]! * c[i - k]!;
    y[i] = c[i]! * dry[i - on]! + acc * fir[i - on]!;
  }
  return y;
}

/** The loudest 1 ms window's peak (dBFS) from `from` to `to` seconds. */
function peakDb(y: Float64Array, sr: number, from: number, to: number): number {
  let pk = 0;
  for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) pk = Math.max(pk, Math.abs(y[i]!));
  return 20 * Math.log10(pk);
}

describe("the guard coming on while the game plays", () => {
  /** The guard's nodes as setLinkGuard wired them. */
  function guardNodes(ctx: FContext) {
    const comp = ctx.nodes.find((n) => n instanceof FComp) as FComp;
    const master = ctx.nodes.find((n) => n instanceof FGain && outs(n)[0] instanceof FBiquad) as FGain;
    const hp = outs(master)[0] as FBiquad;
    const cut = outs(hp)[0] as FGain;
    const dry = outs(comp).find((n) => n instanceof FGain) as FGain;
    const conv = outs(comp).find((n) => n instanceof FConvolver) as FConvolver;
    const fir = outs(conv)[0] as FGain;
    return { hp, cut, comp, dry, conv, fir };
  }

  // Before the fix the cut and the limiter switched together: a −11 dBFS tone
  // (−10.1 at the speaker) burst to +5.5 dBFS for 6 ms (Chromium: +4.8).
  it("plays nothing louder than before: the compressor's look-ahead never meets the limiter's makeup", () => {
    const sr = 48000;
    for (const cutDb of [GUARD_CUT_DB, 0])
      for (const [dbfs, lag] of [[-11, 0], [-3, 0], [-3, 0.05]] as const) {
        FContext.made = [];
        const s = new Sfx();
        s.unlock();
        const ctx = FContext.made[0]!;
        ctx.currentTime = 0.5;
        s.setLinkGuard("high", { cutDb });
        // a steady tone at the master while the guard comes on
        const amp = Math.pow(10, dbfs / 20);
        const x = new Float64Array(sr);
        for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sr);
        const y = renderGuardOn(x, sr, 0.5, guardNodes(ctx), lag);
        const before = peakDb(y, sr, 0.3, 0.5);
        const after = peakDb(y, sr, 0.5, 1);
        expect(after, `cut ${cutDb} dB, tone at ${dbfs} dBFS, the cut ${lag * 1000} ms late: ${before.toFixed(1)} → ${after.toFixed(1)} dBFS`).toBeLessThanOrEqual(before + 1);
        // and it settles where the guard puts it: the cut below the glue's level, or the limiter's ceiling
        const settled = peakDb(y, sr, 0.8, 1);
        expect(settled).toBeLessThan(before - (cutDb > 0 ? 6 : 0) + 0.5);
      }
  });

  it("leaves a context too slow to play into the plan's stopband unfiltered, and never fails the unlock", () => {
    FContext.rate = 16000;
    try {
      // the Duel tap with the game on a narrowband route (a Bluetooth headset's 16 kHz)
      FContext.made = [];
      const s = new Sfx();
      s.unlock();
      expect(() => s.setLinkGuard("high")).not.toThrow();
      const n = guardNodes(FContext.made[0]!);
      expect(n.conv.buffer!.getChannelData(0)).toEqual(new Float32Array([1]));
      expect(n.fir.gain.target).toBe(1);
      // the low plan still has room for its stopband (5 kHz) at 16 kHz: a real filter
      s.setLinkGuard("low");
      const low = outs(n.comp).find((x) => x instanceof FConvolver && x !== n.conv) as FConvolver;
      expect(low.buffer!.length).toBeGreaterThan(1);
      // the rematch boot: the guard asked for before audio starts; the music and the announcer still attach
      FContext.made = [];
      const boot = new Sfx();
      const ready = vi.fn();
      boot.onReady(ready);
      boot.setLinkGuard("high");
      expect(() => boot.unlock()).not.toThrow();
      expect(ready).toHaveBeenCalledTimes(1);
      expect(guardNodes(FContext.made[0]!).comp.settings()).toEqual(GUARD_LIMITER);
    } finally {
      FContext.rate = 48000;
    }
  });

  it("keeps the original chain when the guard can't be built, and still starts audio", () => {
    FContext.noConvolver = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      FContext.made = [];
      const boot = new Sfx();
      const ready = vi.fn();
      boot.onReady(ready);
      boot.setLinkGuard("high");
      expect(() => boot.unlock()).not.toThrow();
      expect(ready).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      const ctx = FContext.made[0]!;
      const comp = ctx.nodes.find((n) => n instanceof FComp) as FComp;
      const master = ctx.nodes.find((n) => n instanceof FGain && n.out.has(comp)) as FGain;
      expect(outs(master)).toEqual([comp]);
      expect(outs(comp)).toEqual([ctx.destination]);
      expect(comp.settings()).toEqual(GLUE);
      // on a live context the caller hears about it, with the chain untouched
      expect(() => boot.setLinkGuard("low")).toThrow();
      expect(outs(master)).toEqual([comp]);
    } finally {
      FContext.noConvolver = false;
      warn.mockRestore();
    }
  });
});

// ------------------------------------------------------ the two phones --

/** A lobby-type frame carrying a packet counter, then filler that depends on it. */
function frameOf(k: number, side: number, nbits: number): Uint8Array {
  const b = new Uint8Array(24);
  b[0] = 0x80 | ((k >>> 24) & 0x3f);
  b[1] = (k >>> 16) & 255;
  b[2] = (k >>> 8) & 255;
  b[3] = k & 255;
  for (let i = 4; i < 24; i++) b[i] = hash32(k, side, i) & 255;
  for (let i = nbits; i < 192; i++) b[i >> 3] = b[i >> 3]! & ~(0x80 >> (i & 7));
  return b;
}
const counterOf = (p: RxPacket) => (((p.bits[0]! & 0x3f) << 24) | (p.bits[1]! << 16) | (p.bits[2]! << 8) | p.bits[3]!) >>> 0;

/** Host and guest modems in the room, each sending a fresh numbered frame in every packet; the fraction each way that arrived intact. */
function duplex(o: RoomOptions, mode: ModemMode, gain: number, seconds = 20): { ab: number; ba: number; wrong: number } {
  const sr = [o.a?.sampleRate ?? 48000, o.b?.sampleRate ?? 48000];
  const m = [
    new ModemCore({ sampleRate: sr[0]!, plan: "high", tx: "host", rx: "guest", gain }),
    new ModemCore({ sampleRate: sr[1]!, plan: "high", tx: "guest", rx: "host", gain })
  ] as const;
  const sent: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  const heard: [Set<number>, Set<number>] = [new Set(), new Set()];
  const k = [0, 0];
  let wrong = 0;
  const load = (s: 0 | 1) => m[s].setPayloads([{ bits: frameOf(k[s]!, s, m[s].capacity()), nbits: m[s].capacity(), key: 0 }]);
  for (const s of [0, 1] as const) {
    m[s].setTxMode(mode);
    load(s);
  }
  const room = new Room(o, m[0], m[1]);
  room.onBlock = (s) => {
    for (const slot of m[s].takeSlots()) {
      sent[s].set(k[s]!, room.timeOf(s, slot.sample));
      k[s]!++;
      load(s);
    }
    for (const p of m[s].take()) {
      const c = counterOf(p);
      const ref = frameOf(c, 1 - s, p.nbits);
      if (p.bits.every((v, i) => v === ref[i] || i >= 24)) heard[s].add(c);
      else wrong++;
    }
    m[s].takeGaps();
  };
  room.run(seconds);
  const frac = (from: 0 | 1) => {
    let n = 0;
    let ok = 0;
    for (const [c, t] of sent[from]) {
      if (t < 3 || t > seconds - 1) continue;
      n++;
      if (heard[1 - from]!.has(c)) ok++;
    }
    return n ? ok / n : 0;
  };
  return { ab: frac(0), ba: frac(1), wrong };
}

describe("level: a loud battle through the guard, own path +40 dB", () => {
  const LOOP_S = 12;
  const mixes = new Map<number, Float64Array>();
  const mix = (sr: number) => {
    let x = mixes.get(sr);
    if (!x) {
      x = battleMix(sr, LOOP_S, sr === 48000 ? 7 : 8);
      mixes.set(sr, x);
    }
    return x;
  };
  /** The game at the speaker: the battle `drive` dB louder at the master, through the guard. */
  const games = new Map<string, Float32Array>();
  const game = (sr: number, cutDb: number, drive: number, limiter: CompressorSettings | null = GUARD_LIMITER) => {
    const key = `${sr} ${cutDb} ${drive} ${limiter ? "lim" : "fir"}`;
    let y = games.get(key);
    if (!y) {
      const k = Math.pow(10, drive / 20);
      y = guard(mix(sr).map((v) => v * k), sr, "high", { cutDb, limiter });
      games.set(key, y);
    }
    return y;
  };
  const rooms = [
    { name: "48/48 kHz at 20 cm", distanceCm: 20, srB: 48000, ppm: 120, seed: 11 },
    { name: "48/44.1 kHz at 30 cm", distanceCm: 30, srB: 44100, ppm: -250, seed: 12 }
  ];
  const run = (cutDb: number, drive: number, mode: ModemMode, gain: number, c: (typeof rooms)[number], limiter: CompressorSettings | null = GUARD_LIMITER) =>
    duplex(
      {
        seed: c.seed,
        distanceCm: c.distanceCm,
        a: { ownDb: 40, game: game(48000, cutDb, drive, limiter) },
        b: { ownDb: 40, sampleRate: c.srB, ppm: c.ppm, game: game(c.srB, cutDb, drive, limiter) }
      },
      mode,
      gain
    );

  it(
    "the battle plays at the game's levels, and the limiter bounds it whatever its size",
    () => {
      const master = level(mix(48000));
      expect(master.rmsDb).toBeGreaterThan(-22);
      expect(master.peakDb).toBeGreaterThan(-6);
      // the model limiter's makeup is Web Audio's, as audio.ts takes it back
      for (const s of [GUARD_LIMITER, GLUE]) {
        const m = 20 * Math.log10(new Compressor(48000, s).makeup);
        if (s.knee === 0) expect(m).toBeCloseTo(compressorMakeupDb(s), 3);
        else expect(m).toBeCloseTo(1.1, 1);
      }
      const shipped = level(game(48000, GUARD_CUT_DB, 0));
      expect(shipped.rmsDb).toBeLessThan(-35);
      // a battle 20 dB louder, with no cut (a margin: every phone cuts 10 dB): the limiter's ceiling
      const worst = level(game(48000, 0, 20));
      expect(worst.rmsDb).toBeLessThan(-20);
      expect(worst.peakDb).toBeLessThan(-6);
    },
    180_000
  );

  it(
    "delivers at least 98% both ways with the guard as shipped, at gain 1 and the lobby's top gain 1.1",
    () => {
      for (const gain of [1, 1.1])
        for (const c of rooms)
          for (const mode of ["robust", "fast"] as const) {
            const r = run(GUARD_CUT_DB, 0, mode, gain, c);
            expect(r.ab, `A→B ${c.name} ${mode} gain ${gain}`).toBeGreaterThanOrEqual(0.98);
            expect(r.ba, `B→A ${c.name} ${mode} gain ${gain}`).toBeGreaterThanOrEqual(0.98);
            expect(r.wrong).toBe(0);
          }
    },
    180_000
  );

  it(
    "and at the limiter's ceiling: no cut and a battle 20 dB louder (a margin over the shipped guard)",
    () => {
      for (const gain of [1, 1.1])
        for (const c of rooms)
          for (const mode of ["robust", "fast"] as const) {
            const r = run(0, 20, mode, gain, c);
            expect(r.ab, `A→B ${c.name} ${mode} gain ${gain}`).toBeGreaterThanOrEqual(0.98);
            expect(r.ba, `B→A ${c.name} ${mode} gain ${gain}`).toBeGreaterThanOrEqual(0.98);
          }
    },
    180_000
  );

  it(
    "can tell: the same battle 10 dB louder through the FIR alone, with no limiter, loses packets",
    () => {
      const r = run(0, 10, "fast", 1, rooms[0]!, null);
      expect(Math.min(r.ab, r.ba)).toBeLessThan(0.98);
    },
    180_000
  );
});
