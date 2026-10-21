// The modem's AudioWorklet and its main-thread side (SOUND-DUEL.md "Link
// layer", "Worklet"): WorkletTransport against a fake node, port and
// context (messages, the clock mapping and its skips, close); the real
// processor class from src/link/worklet.ts, loaded in Node under a stand-in
// for the AudioWorkletGlobalScope (channel choice, errors, close,
// allocation); two phones end to end, each a WorkletTransport talking
// through a cloning fake MessagePort to a real processor, the processors in
// the simulated room; and the rule that the worklet's import graph uses only
// the AudioWorklet's globals. (tools/worklet-smoke.mjs runs the built
// worklet in Chromium.)
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModemCore, type ModemConfig, type ModemStats, type RxPacket } from "../src/link/modem/core";
import { PACKET_SYMBOLS, timing } from "../src/link/modem/params";
import { Room, type RoomEndpoint, type RoomOptions } from "../src/link/sim/room";
import { PAYLOAD_BITS, type LinkPacket, type OutFrame } from "../src/link/transport";
import { loadWorklet, WorkletTransport } from "../src/link/worklet-transport";
import { MODEM_PROCESSOR, type FromWorklet, type ToWorklet } from "../src/link/worklet-protocol";
import { hash32 } from "../src/sim/rand";

/**
 * One end of a message channel. postMessage structured-clones (transferring
 * what it is told to, as the real one does) into the other end's queue,
 * which delivers to onmessage when flushed: messages cross between blocks,
 * never in the middle of one.
 */
class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  other: FakePort | null = null;
  /** Waiting for this end's onmessage. */
  readonly queue: unknown[] = [];
  /** Everything posted from this end, as the other end receives it. */
  readonly posted: unknown[] = [];
  postMessage(msg: unknown, transfer: Transferable[] = []): void {
    const c = structuredClone(msg, { transfer });
    this.posted.push(c);
    this.other?.queue.push(c);
  }
  flush(): void {
    while (this.queue.length) {
      const data = this.queue.shift();
      this.onmessage?.({ data });
    }
  }
}

function channel(): [FakePort, FakePort] {
  const a = new FakePort();
  const b = new FakePort();
  a.other = b;
  b.other = a;
  return [a, b];
}

class FakeNode {
  onprocessorerror: (() => void) | null = null;
  readonly connected: unknown[] = [];
  disconnected = false;
  constructor(
    readonly port: FakePort,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions
  ) {}
  connect(dest: unknown): unknown {
    this.connected.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

interface FakeContext {
  sampleRate: number;
  currentTime: number;
  state: string;
  destination: { speakers: true };
  audioWorklet: { addModule: (url: string) => Promise<void> };
}

function fakeContext(sampleRate = 48000): FakeContext {
  return { sampleRate, currentTime: 0, state: "running", destination: { speakers: true }, audioWorklet: { addModule: vi.fn(async () => {}) } };
}

const asCtx = (c: FakeContext) => c as unknown as BaseAudioContext;
const cfgOf = (sampleRate = 48000, o: Partial<ModemConfig> = {}): ModemConfig => ({ sampleRate, plan: "high", tx: "host", rx: "guest", ...o });

/** A WorkletTransport on a fake context and node, on a clock the test moves. Messages to it are delivered by `worker.flush()`. */
function fakeTransport(cfg = cfgOf(), clockStart = 5000) {
  const ctx = fakeContext(cfg.sampleRate);
  const clock = { t: clockStart };
  const [main, worker] = channel();
  const nodes: FakeNode[] = [];
  const tr = new WorkletTransport(asCtx(ctx), cfg, {
    clock: () => clock.t,
    createNode: (_c, name, options) => {
      nodes.push(new FakeNode(main, name, options));
      return nodes[0] as unknown as AudioWorkletNode;
    }
  });
  /** What the worklet would have received. */
  const sent = () => worker.queue.splice(0) as ToWorklet[];
  /** Deliver messages from the worklet. */
  const from = (...msgs: FromWorklet[]) => {
    for (const m of msgs) worker.postMessage(m);
    main.flush();
  };
  return { tr, ctx, clock, node: nodes[0]!, sent, from };
}

/** A lobby-type frame (10…) naming its key in bits 8–23, then filler that depends on the key: 184 bits. */
function keyed(key: number): OutFrame {
  const bits = new Uint8Array(23);
  bits[0] = 0x80;
  bits[1] = key >> 8;
  bits[2] = key & 255;
  for (let i = 3; i < 23; i++) bits[i] = hash32(key, 98, i) & 255;
  return { bits, nbits: 184, key };
}
/** The key a keyed() frame names, once its filler checks out (-1 otherwise). */
function keyOf(p: { bits: Uint8Array; nbits: number }): number {
  const key = (p.bits[1]! << 8) | p.bits[2]!;
  const ref = keyed(key).bits;
  return p.nbits === 188 && ref.every((v, i) => p.bits[i] === v) ? key : -1;
}

/** keyed(key) at `nbits` bits (up to 188), the bits past its 184 set. */
function sized(key: number, nbits: number): OutFrame {
  const bits = new Uint8Array(24);
  bits.set(keyed(key).bits);
  bits[23] = 0xff;
  for (let i = nbits; i < 192; i++) bits[i >> 3] = bits[i >> 3]! & ~(0x80 >> (i & 7));
  return { bits, nbits, key };
}

const stats = (o: Partial<ModemStats> = {}): ModemStats => ({
  sample: 0,
  locked: true,
  plan: "high",
  rxMode: "robust",
  txMode: "fast",
  snrDb: 21.5,
  rxOk: 40,
  rxBad: 2,
  syncs: 3,
  clockPpm: 12,
  txPackets: 44,
  ownSnrDb: 33,
  loopbackMs: 75.2,
  clips: 0,
  inputPeak: 0.4,
  ...o
});

describe("loadWorklet", () => {
  it("adds the module once per context, and tries again after a failure", async () => {
    const a = fakeContext();
    const b = fakeContext();
    await Promise.all([loadWorklet(asCtx(a)), loadWorklet(asCtx(a))]);
    await loadWorklet(asCtx(a));
    await loadWorklet(asCtx(b));
    expect(a.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(b.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    const url = vi.mocked(a.audioWorklet.addModule).mock.calls[0]![0];
    expect(url).toMatch(/worklet\.ts/);
    const c = fakeContext();
    let fail = true;
    c.audioWorklet.addModule = vi.fn(async () => {
      if (fail) throw new Error("gone");
    });
    await expect(loadWorklet(asCtx(c))).rejects.toThrow("gone");
    fail = false;
    await loadWorklet(asCtx(c));
    await loadWorklet(asCtx(c));
    expect(c.audioWorklet.addModule).toHaveBeenCalledTimes(2);
  });
});

describe("WorkletTransport", () => {
  it("makes its node as the spec says, connected to the speakers, and refuses a config its context can't run", () => {
    const { node, ctx, tr } = fakeTransport(cfgOf(44100, { gain: 1.1 }));
    expect(node.name).toBe(MODEM_PROCESSOR);
    expect(node.options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: cfgOf(44100, { gain: 1.1 })
    });
    expect(node.connected).toEqual([ctx.destination]);
    expect(tr.node).toBe(node);
    expect(tr.capacity()).toBe(188);
    expect(() => new WorkletTransport(asCtx(fakeContext(48000)), cfgOf(44100))).toThrow(RangeError);
    expect(() => fakeTransport(cfgOf(32000))).toThrow(/32000 Hz/);
    expect(fakeTransport(cfgOf(32000, { plan: "low" })).tr.capacity()).toBe(186);
    // a Join detecting the plan offers what either plan carries until it locks (see the Join test below)
    expect(fakeTransport(cfgOf(48000, { plan: "low", tx: "guest", rx: "detect" })).tr.capacity()).toBe(186);
  });

  it("stamps packets, slots and gaps on its own clock from the worklet's frames", () => {
    const { tr, ctx, clock, from } = fakeTransport();
    expect(tr.now()).toBe(0);
    clock.t += 1234;
    expect(tr.now()).toBe(1234);
    // the context is 10 s in: frame 480000
    ctx.currentTime = 10;
    from(
      { t: "rx", bits: new Uint8Array([0x80, 1]), nbits: 188, mode: "fast", snrDb: 20, sample: 480000 - 4800, plan: "high", session: false },
      { t: "slot", sample: 480000 - 2400, index: 7, key: 3 },
      // a frame the main thread's currentTime hasn't reached yet counts as now
      { t: "slot", sample: 480000 + 128, index: 8, key: 5 },
      { t: "gap", sample: 480000 - 9600, frames: 0 },
      { t: "gap", sample: 480000 - 9600, frames: 4800 }
    );
    const [p, ...more] = tr.poll();
    expect(more).toEqual([]);
    // (a packet is stamped at its last sample: a fast packet of the high plan ends 91 ms after its first DFT window
    // starts, the back-off, a symbol and a useful part, so 9 ms before the frame the context has reached)
    expect(p).toEqual({ bits: new Uint8Array([0x80, 1]), nbits: 188, snrDb: 20, at: 1225, session: false });
    expect(tr.slots()).toEqual([1184, 1234]);
    expect(tr.slots()).toEqual([]);
    expect(tr.takeGaps()).toEqual([
      { at: 1034, ms: 0 },
      { at: 1034, ms: 100 }
    ]);
    // now() runs on while the context's clock stands still (suspended), and sinceRx with it
    clock.t += 500;
    expect(tr.now()).toBe(1734);
    expect(tr.stats().sinceRx).toBe(509);
    // a transport replacing this one (a rebuilt context) carries its clock on
    const next = new WorkletTransport(asCtx(fakeContext()), cfgOf(), {
      clock: () => clock.t,
      t0: tr.t0,
      createNode: (_c, name, o) => new FakeNode(new FakePort(), name, o) as unknown as AudioWorkletNode
    });
    expect(next.now()).toBe(tr.now());
  });

  it("reports the worklet's newest stats, with defaults before the first, and its errors", () => {
    const { tr, from, clock } = fakeTransport();
    expect(tr.modemStats()).toBeNull();
    expect(tr.stats()).toEqual({
      locked: false,
      snrDb: null,
      rxOk: 0,
      rxBad: 0,
      txMode: "robust",
      rxMode: null,
      sinceRx: Infinity,
      ownSnrDb: null,
      loopbackMs: null,
      plan: "high"
    });
    from({ t: "stats", ...stats({ rxOk: 1 }) }, { t: "stats", ...stats() });
    expect(tr.modemStats()).toEqual(stats());
    clock.t += 100;
    expect(tr.stats()).toEqual({ locked: true, snrDb: 21.5, rxOk: 40, rxBad: 2, txMode: "fast", rxMode: "robust", sinceRx: Infinity, ownSnrDb: 33, loopbackMs: 75.2, plan: "high" });
    // the Join's detection moved the modem to the low plan: frames sized for it from now on
    from({ t: "stats", ...stats({ plan: "low" }) });
    expect(tr.capacity()).toBe(186);
    expect(tr.stats().plan).toBe("low");
    const errors: string[] = [];
    tr.onError = (m) => errors.push(m);
    from({ t: "error", message: "no", fatal: false });
    tr.node.onprocessorerror?.call(tr.node, new Event("processorerror") as ErrorEvent);
    expect(errors).toEqual(["no", "le processeur audio de la liaison sonore a échoué"]);
  });

  it("posts copies of the frames, checks the list where it is made, and posts the spec's messages", () => {
    const { tr, sent } = fakeTransport();
    const frames = [keyed(1), keyed(4), keyed(9)];
    tr.send(frames);
    const [msg, ...rest] = sent();
    expect(rest).toEqual([]);
    expect(msg).toEqual({ t: "payload", frames: frames.map((f) => ({ ...f, bits: f.bits.slice(0, 23) })) });
    // its own copies went over (transferred), not the caller's buffers
    expect(frames.every((f) => f.bits.length === 23)).toBe(true);
    for (const bad of [[], Array.from({ length: 9 }, (_, k) => keyed(k)), [keyed(4), keyed(4)], [keyed(5), keyed(4)], [{ ...keyed(1), nbits: 189 }], [{ bits: new Uint8Array(1), nbits: 9, key: 0 }]])
      expect(() => tr.send(bad)).toThrow(RangeError);
    expect(sent()).toEqual([]);
    tr.setMode("fast");
    tr.setSessionKey(11, 22);
    tr.reconfigure({ plan: "low", rx: "host" });
    tr.setGain(1.1);
    expect(sent()).toEqual([
      { t: "mode", mode: "fast" },
      { t: "session", hostNonce: 11, guestNonce: 22 },
      { t: "config", plan: "low", tx: undefined, rx: "host", gain: undefined },
      { t: "config", gain: 1.1 }
    ]);
    expect(tr.capacity()).toBe(186);
    expect(() => tr.reconfigure({ sampleRate: 44100 })).toThrow(RangeError);
    expect(() => tr.send([{ ...keyed(1), nbits: 187 }])).toThrow(RangeError);
  });

  it("reads a report as stale once none has come for a second, or once the modem stopped", () => {
    const { tr, from, clock } = fakeTransport();
    from({ t: "stats", ...stats() });
    clock.t += 999;
    expect(tr.stats().locked).toBe(true);
    expect(tr.modemStats()).toEqual(stats());
    // a second with no report: the context isn't rendering (suspended, interrupted), so the lock is no longer known
    clock.t += 1;
    expect(tr.stats()).toEqual({ locked: false, snrDb: null, rxOk: 40, rxBad: 2, txMode: "fast", rxMode: null, sinceRx: Infinity, ownSnrDb: null, loopbackMs: 75.2, plan: "high" });
    expect(tr.modemStats()).toBeNull();
    from({ t: "stats", ...stats() });
    expect(tr.stats().locked).toBe(true);
    // a refused message changes nothing; the modem stopping makes the report stale at once, for good, and says so as onError hears it
    const stoppedAt: boolean[] = [];
    tr.onError = () => stoppedAt.push(tr.stopped);
    from({ t: "error", message: "a list of 0 payloads (1 to 8)", fatal: false });
    expect(tr.stats().locked).toBe(true);
    from({ t: "error", message: "the modem stopped: boom", fatal: true });
    expect(tr.stats()).toMatchObject({ locked: false, snrDb: null, rxMode: null, rxOk: 40 });
    expect(tr.modemStats()).toBeNull();
    expect(stoppedAt).toEqual([false, true]);
    // and so does the processor failing
    const b = fakeTransport();
    b.from({ t: "stats", ...stats() });
    b.tr.onError = () => stoppedAt.push(b.tr.stopped);
    b.tr.node.onprocessorerror?.call(b.tr.node, new Event("processorerror") as ErrorEvent);
    expect(b.tr.stats().locked).toBe(false);
    expect(stoppedAt).toEqual([false, true, true]);
  });

  it("offers a Join what either plan carries until a report of its own shows the lock, then what the plan it found carries", () => {
    const { tr, from, sent } = fakeTransport(cfgOf(48000, { tx: "guest", rx: "detect" }));
    expect(tr.capacity()).toBe(186);
    expect(() => tr.send([sized(1, 187)])).toThrow(RangeError);
    from({ t: "stats", ...stats({ locked: false, plan: "high" }) });
    expect(tr.capacity()).toBe(186);
    expect(tr.detectedPlan()).toBeNull();
    from({ t: "stats", ...stats({ locked: true, plan: "high" }) });
    expect(tr.capacity()).toBe(188);
    // (what the rig rebuilds a context's transport on)
    expect(tr.detectedPlan()).toBe("high");
    // detecting again: a lock in the reports posted before the config reached the worklet is the old one
    tr.reconfigure({ rx: "detect" });
    expect(tr.capacity()).toBe(186);
    expect(tr.detectedPlan()).toBeNull();
    from({ t: "stats", ...stats({ locked: true, plan: "high" }) });
    expect(tr.capacity()).toBe(186);
    expect(tr.detectedPlan()).toBeNull();
    from({ t: "stats", ...stats({ locked: false, plan: "high" }) }, { t: "stats", ...stats({ locked: true, plan: "low" }) });
    expect(tr.capacity()).toBe(186);
    expect(tr.detectedPlan()).toBe("low");
    // back on a plan set here: the smaller of it and the one last reported, until the worklet catches up
    tr.reconfigure({ plan: "high", rx: "host" });
    expect(tr.capacity()).toBe(186);
    expect(tr.detectedPlan()).toBeNull();
    from({ t: "stats", ...stats({ plan: "high" }) });
    expect(tr.capacity()).toBe(188);
    expect(sent().map((m) => m.t)).toEqual(["config", "config"]);
  });

  it("posts a skip when the context's clock falls behind its own and stays there; nothing for jitter, drift, a brief rise, a short stall or a suspended context", () => {
    const { tr, ctx, clock, sent, from } = fakeTransport();
    const skips = () => sent().flatMap((m) => (m.t === "skip" ? [m.frames] : []));
    /** A message from the worklet 100 ms on, read with the context's clock `behind` ms behind this one (against where it began). */
    const read = (behind: number) => {
      clock.t += 100;
      ctx.currentTime = (tr.now() - behind) / 1000;
      from({ t: "slot", sample: 0, index: 0, key: 1 });
    };
    // ten minutes of readings anywhere up to 40 ms late (a phone's audio callback), from a context 300 ppm slow: 180 ms of drift
    let level = 0;
    for (let i = 0; i < 6000; i++) read(0.0003 * 100 * i + ((i * 7919) % 41));
    level = 0.0003 * 100 * 6000;
    // a reading or two over 100 ms late, then back; a stall of 60 ms
    read(level + 150);
    read(level);
    read(level + 160);
    read(level + 170);
    for (let i = 0; i < 20; i++) read(level + (i % 5));
    level += 60;
    for (let i = 0; i < 20; i++) read(level + (i % 5));
    expect(skips()).toEqual([]);
    // (the stall moved the baseline within 20 readings, about two seconds: the skip below is measured from it)
    // suspended for 1.5 s: what arrives meanwhile counts for nothing; once it runs again, the step stands for 200 ms and goes over as a skip
    for (let i = 0; i < 300; i++) read(level + 0.1 * (i % 7));
    read(level);
    ctx.state = "suspended";
    for (let i = 1; i <= 15; i++) read(level + 100 * i);
    expect(skips()).toEqual([]);
    ctx.state = "running";
    level += 1500;
    read(level + 4);
    read(level + 2);
    expect(skips()).toEqual([]);
    read(level + 6);
    // the lowest reading since the step (2 ms over the step) against the lowest before it, and the 3 ms lead
    expect(skips()).toEqual([Math.round((1502 + 3) * 48)]);
    // the new level holds: nothing more, until the next stretch
    for (let i = 0; i < 50; i++) read(level + 2 + (i % 9));
    expect(skips()).toEqual([]);
    for (let i = 0; i < 4; i++) read(level + 402 + (i % 2));
    expect(skips()).toEqual([Math.round((400 + 3) * 48)]);
    tr.close();
    for (let i = 0; i < 4; i++) read(level + 2000);
    expect(skips()).toEqual([]);
  });

  it("skips what a stall settles at, not a reading taken while it lasted; nothing for a context that catches up", () => {
    const { tr, ctx, clock, sent, from } = fakeTransport();
    const skips = () => sent().flatMap((m) => (m.t === "skip" ? [m.frames] : []));
    /** A message from the worklet `ms` on, read with the context's clock `behind` ms behind this one (against where it began). */
    const read = (ms: number, behind: number) => {
      clock.t += ms;
      ctx.currentTime = (tr.now() - behind) / 1000;
      from({ t: "slot", sample: 0, index: 0, key: 1 });
    };
    const settle = (level: number, n = 40) => {
      for (let i = 0; i < n; i++) read(50, level + ((i * 7) % 5));
    };
    /** Readings every 50 ms around `level` until a skip goes over: when (ms after the first), and what. */
    const until = (level: number) => {
      const t0 = clock.t;
      for (let i = 0; i < 40; i++) {
        read(50, level + ((i * 3) % 5));
        const k = skips();
        if (k.length) return { ms: clock.t - t0, frames: k };
      }
      return null;
    };
    settle(0);
    // Chromium's audio service stopped for 224 ms: a message posted just before is read 127 ms into it, currentTime
    // standing still; then the context runs again, 224 ms behind for good. Taken as the step, the 127 would leave the
    // other 97 under SKIP_MIN_MS, never to go over: the step goes over once that reading is past the readings it is
    // weighed with (300 ms), at what the clock settled at
    read(50, 127);
    read(100, 224 + 2);
    expect(until(224)).toEqual({ ms: 250, frames: [Math.round((224 + 3) * 48)] });
    settle(224);
    expect(skips()).toEqual([]);
    // a render thread held up 300 ms renders what it owes faster than real time, a little at a time: the frames came,
    // late, so none of it is a skip
    for (let behind = 524; behind > 224; behind -= 12) read(50, behind + ((behind * 7) % 5));
    settle(224);
    expect(skips()).toEqual([]);
    // one whose clock runs at half speed for 600 ms, then at full speed 300 ms behind: one skip, once it stands
    for (let i = 1; i <= 12; i++) read(50, 224 + 25 * i);
    expect(skips()).toEqual([]);
    expect(until(524)).toEqual({ ms: 300, frames: [Math.round((300 + 3) * 48)] });
    settle(524);
    expect(skips()).toEqual([]);
  });

  it("posts a skip as promptly with a phone's jitter as without: the clock stands still within what its readings spread", () => {
    // readings up to 40 ms late (a phone's audio callback), the worklet's messages 100, 150 or 250 ms apart give or
    // take 30%: a suspension's step goes over at the cadence's pace, of its length within the jitter. (Held to two
    // single readings agreeing within 15 ms, 1 skip in 10 went over 0.5–1 s after the step's first reading and the
    // slowest 1.1–2.1 s after, in 300 per cadence.)
    const u = (...xs: number[]) => hash32(...xs) / 2 ** 32;
    for (const cadence of [100, 150, 250]) {
      const delays: number[] = [];
      for (let rep = 0; rep < 60; rep++) {
        const { ctx, clock, sent, from } = fakeTransport();
        const t0 = clock.t;
        let n = 0;
        const read = (at: number, behind: number) => {
          clock.t = t0 + at;
          ctx.currentTime = (at - behind) / 1000;
          from({ t: "slot", sample: 0, index: 0, key: 1 });
        };
        const gap = () => cadence * (0.7 + 0.6 * u(rep, cadence, n++, 1));
        const late = () => 40 * u(rep, cadence, n, 2);
        const step = 300 + 1200 * u(rep, cadence, 3);
        let at = 0;
        for (; at < 3000; at += gap()) read(at, late());
        // suspended (no readings), then running again `step` behind
        at += step;
        const first = at;
        let skip: number[] = [];
        for (; at < first + 3000 && !skip.length; at += gap()) {
          read(at, step + late());
          skip = sent().flatMap((m) => (m.t === "skip" ? [m.frames / 48] : []));
          if (skip.length) delays.push(at - first);
        }
        expect(skip).toHaveLength(1);
        expect(Math.abs(skip[0]! - 3 - step)).toBeLessThanOrEqual(40);
      }
      delays.sort((a, b) => a - b);
      expect(delays[Math.floor(0.9 * delays.length)]).toBeLessThanOrEqual(200 + 1.5 * cadence);
      expect(delays[delays.length - 1]).toBeLessThanOrEqual(200 + 4 * cadence);
    }
  });

  it("close posts close and disconnects; nothing comes through after it", () => {
    const { tr, node, sent, from } = fakeTransport();
    from({ t: "slot", sample: 0, index: 0, key: null });
    tr.close();
    expect(sent()).toEqual([{ t: "close" }]);
    expect(node.disconnected).toBe(true);
    expect(node.port.onmessage).toBeNull();
    expect(tr.slots()).toEqual([]);
    from({ t: "rx", bits: new Uint8Array(24), nbits: 188, mode: "robust", snrDb: 20, sample: 0, plan: "high", session: false });
    expect(tr.poll()).toEqual([]);
    tr.send([keyed(1)]);
    tr.setMode("fast");
    tr.close();
    expect(sent()).toEqual([]);
  });
});

// ——— the processor itself, under a stand-in for the AudioWorkletGlobalScope ———

interface Processor {
  readonly port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorClass = new (options: { processorOptions?: ModemConfig }) => Processor;

const scope = { sampleRate: 48000, currentFrame: 0 };
let registered: { name: string; ctor: ProcessorClass } | null = null;
/** The port the next processor gets (the node's other end). */
let nextPort: FakePort | null = null;

beforeAll(async () => {
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port: FakePort;
      constructor() {
        this.port = nextPort ?? new FakePort();
        nextPort = null;
      }
    }
  );
  vi.stubGlobal("registerProcessor", (name: string, ctor: ProcessorClass) => (registered = { name, ctor }));
  Object.defineProperty(globalThis, "sampleRate", { get: () => scope.sampleRate, configurable: true });
  Object.defineProperty(globalThis, "currentFrame", { get: () => scope.currentFrame, configurable: true });
  await import("../src/link/worklet");
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of ["sampleRate", "currentFrame"]) delete (globalThis as Record<string, unknown>)[k];
});

/** A processor as the node would make it: at `sampleRate`, with its own port (posted messages kept in port.posted). */
function processor(cfg: ModemConfig, port = new FakePort()): Processor {
  scope.sampleRate = cfg.sampleRate;
  nextPort = port;
  return new registered!.ctor({ processorOptions: cfg });
}

const kinds = (port: FakePort, t: FromWorklet["t"]) => port.posted.filter((m) => (m as FromWorklet).t === t) as FromWorklet[];

describe("the worklet's processor", () => {
  it("registers under the shared name", () => {
    expect(registered?.name).toBe(MODEM_PROCESSOR);
  });

  it("posts an error and plays silence when its sample rate can't carry the plan", () => {
    const p = processor(cfgOf(32000));
    const out = new Float32Array(128).fill(1);
    expect(p.process([[new Float32Array(128)]], [[out]])).toBe(true);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(p.port.posted).toEqual([{ t: "error", message: "L'audio de ce téléphone tourne à 32000 Hz, inutilisable pour la liaison sonore", fatal: true }]);
  });

  it("takes the louder channel only when the other is over 40 dB quieter, never their sum; plays on every output channel", () => {
    const p = processor(cfgOf());
    const loud = new Float32Array(128);
    const a = new Float32Array(128);
    const b = new Float32Array(128);
    const out = [new Float32Array(128), new Float32Array(128)];
    /** The input peak the modem saw over 0.25 s with channel levels la and lb. */
    const peak = (la: number, lb: number) => {
      // (two stats periods and more: the last report covers this call's blocks alone)
      for (let f = 0; f < 25000; f += 128) {
        for (let i = 0; i < 128; i++) {
          loud[i] = Math.sin(0.1 * (f + i));
          a[i] = la * loud[i]!;
          b[i] = lb * Math.cos(0.1 * (f + i));
        }
        scope.currentFrame += 128;
        p.process([[a, b]], [out]);
      }
      return (kinds(p.port, "stats").at(-1) as ModemStats).inputPeak;
    };
    expect(peak(0.001, 0.5)).toBeCloseTo(0.5, 4); // channel 0 54 dB down: channel 1
    expect(peak(0.01, 0.5)).toBeCloseTo(0.01, 4); // only 34 dB down: channel 0
    expect(peak(0, 0.2)).toBeCloseTo(0.2, 4); // a dead channel 0
    expect(peak(0.3, 0.0001)).toBeCloseTo(0.3, 4);
    expect(peak(0.25, 0.25)).toBeCloseTo(0.25, 4); // two live microphones: channel 0, not their sum
    // no microphone connected yet: silence, a capture gap (and no exception)
    const gaps = kinds(p.port, "gap").length;
    scope.currentFrame += 128;
    p.process([[]], [out]);
    expect(kinds(p.port, "gap").length).toBe(gaps + 1);
    // the second output channel carries what the first does
    expect(out[0]!.some((v) => v !== 0)).toBe(true);
    expect([...out[1]!]).toEqual([...out[0]!]);
  });

  it("posts stats about four times a second, and stops after close (process() returns false)", () => {
    const port = new FakePort();
    const p = processor(cfgOf(44100), port);
    const inp = new Float32Array(128).fill(1e-3);
    const out = new Float32Array(128);
    scope.currentFrame = 1_000_000;
    for (let f = 0; f < 44100 * 3; f += 128) {
      p.process([[inp]], [[out]]);
      scope.currentFrame += 128;
    }
    expect(kinds(port, "stats").length).toBeGreaterThanOrEqual(12);
    expect(kinds(port, "stats").length).toBeLessThanOrEqual(13);
    // a frame counter that went back keeps the reports coming
    scope.currentFrame = 0;
    const n = kinds(port, "stats").length;
    for (let f = 0; f < 44100; f += 128) {
      p.process([[inp]], [[out]]);
      scope.currentFrame += 128;
    }
    expect(kinds(port, "stats").length - n).toBeGreaterThanOrEqual(4);
    port.queue.push({ t: "close" } satisfies ToWorklet);
    port.flush();
    out.fill(1);
    expect(p.process([[inp]], [[out]])).toBe(false);
    port.queue.push({ t: "payload", frames: [keyed(1)] } satisfies ToWorklet);
    port.flush();
    expect(kinds(port, "error")).toEqual([]);
  });

  it("refuses a bad payload list or plan with an error message, keeping what it had", () => {
    const port = new FakePort();
    const p = processor(cfgOf(), port);
    const inp = new Float32Array(128).fill(1e-3);
    const out = new Float32Array(128);
    for (const m of [
      { t: "payload", frames: [] },
      { t: "payload", frames: [keyed(2), keyed(1)] },
      { t: "config", plan: "high", gain: 1 }
    ] satisfies ToWorklet[])
      port.queue.push(m);
    port.flush();
    expect(kinds(port, "error").map((e) => (e as { message: string }).message)).toEqual(["a list of 0 payloads (1 to 8)", "payload keys must be finite and strictly ascending"]);
    expect(p.process([[inp]], [[out]])).toBe(true);
  });

  it(
    "allocates nothing per block beyond its messages",
    async () => {
      // its own signal through a 75 ms loopback (self-test), so it locks, decodes and reports all along
      const port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        count: 0,
        postMessage() {
          this.count++;
        }
      };
      const p = processor(cfgOf(48000, { rx: "host" }), port as unknown as FakePort);
      port.onmessage!({ data: { t: "payload", frames: [keyed(1), keyed(2), keyed(3)] } satisfies ToWorklet });
      const out = new Float32Array(128);
      const inp = new Float32Array(128);
      const delay = new Float32Array(4096);
      const inputs = [[inp]];
      const outputs = [[out]];
      let f = 0;
      const step = () => {
        for (let i = 0; i < 128; i++) inp[i] = 0.3 * delay[(f + i) & 4095]! + 1e-4 * Math.sin(f + i);
        scope.currentFrame = f;
        p.process(inputs, outputs);
        for (let i = 0; i < 128; i++) delay[(f + i + 3600) & 4095] = out[i]!;
        f += 128;
      };
      while (f < 10 * 48000) step();
      const v8 = (await import(/* @vite-ignore */ "node:v8" as string)) as { getHeapSpaceStatistics(): { space_name: string; space_used_size: number }[] };
      const young = () => v8.getHeapSpaceStatistics().find((x) => x.space_name === "new_space")!.space_used_size;
      // The steady state: V8 optimizes on background threads, later on a loaded machine (CI runs test
      // files in parallel), and until then every float the hot loops touch is boxed (about 560 bytes a
      // block 10 s in, here, on Node 24). So measure 5 s windows until one is clear of that, up to 80 s,
      // and judge the lowest; a window with a scavenge in it says nothing and is skipped.
      let perBlock = Infinity;
      const posted0 = port.count;
      const f0 = f;
      for (let attempt = 0; attempt < 16 && !(perBlock < 64); attempt++) {
        const h0 = young();
        const end = f + 5 * 48000;
        while (f < end) step();
        const h1 = young();
        if (h1 >= h0) perBlock = Math.min(perBlock, (h1 - h0) / ((5 * 48000) / 128));
      }
      // about 14 messages a second (5 packets, 5 slots, 4 stats): a few hundred bytes each, ~10 bytes a block
      expect(port.count - posted0).toBeGreaterThan(10 * ((f - f0) / 48000));
      expect(perBlock, `${perBlock.toFixed(1)} bytes per block`).toBeLessThan(64);
    },
    60_000
  );

  it("takes a skip as a jump of its frame counter, and posts every sample in the context's frame domain", () => {
    const port = new FakePort();
    const p = processor(cfgOf(), port);
    const inp = new Float32Array(128).fill(1e-3);
    const out = new Float32Array(128);
    scope.currentFrame = 0;
    const block = () => {
      p.process([[inp]], [[out]]);
      scope.currentFrame += 128;
    };
    for (let i = 0; i < 100; i++) block();
    for (const frames of [0, -128, 1.5, NaN, Infinity, 4800]) port.queue.push({ t: "skip", frames } satisfies ToWorklet);
    port.flush();
    // refused: anything but a whole number of frames ≥ 1
    expect(kinds(port, "error")).toEqual(["0", "-128", "1.5", "NaN", "Infinity"].map((f) => ({ t: "error", message: `a skip of ${f} frames`, fatal: false })));
    const n = port.posted.length;
    const since = (t: FromWorklet["t"]) => (port.posted.slice(n) as FromWorklet[]).filter((m) => m.t === t);
    block();
    // the modem met frame 12800 + 4800 where it expected 12800: a gap of 4800 frames, which (on the context's clock as it runs now) began 4800 frames before this block
    expect(since("gap")).toEqual([
      { t: "gap", sample: 8000, frames: 0 },
      { t: "gap", sample: 8000, frames: 4800 }
    ]);
    while (since("stats").length === 0) block();
    expect((since("stats")[0] as ModemStats).sample).toBe(scope.currentFrame);
  });

  it("posts one fatal error for a fault in process(), and stays silent but alive", () => {
    const port = new FakePort();
    const p = processor(cfgOf(), port);
    (p as unknown as { modem: ModemCore }).modem.process = () => {
      throw new Error("boom");
    };
    const out = new Float32Array(128);
    for (let i = 0; i < 3; i++) {
      out.fill(1);
      expect(p.process([[new Float32Array(128).fill(1e-3)]], [[out]])).toBe(true);
      expect(out.every((v) => v === 0)).toBe(true);
    }
    expect(port.posted).toEqual([{ t: "error", message: "le modem s'est arrêté : boom", fatal: true }]);
  });

  it("posts the same fatal error for a fault turning what the modem reports into messages, rather than throwing out of process()", () => {
    const port = new FakePort();
    const p = processor(cfgOf(), port);
    (p as unknown as { modem: ModemCore }).modem.take = () => {
      throw new Error("boom");
    };
    const out = new Float32Array(128);
    for (let i = 0; i < 3; i++) {
      out.fill(1);
      expect(p.process([[new Float32Array(128).fill(1e-3)]], [[out]])).toBe(true);
      expect(out.every((v) => v === 0)).toBe(true);
    }
    expect(port.posted).toEqual([{ t: "error", message: "le modem s'est arrêté : boom", fatal: true }]);
  });

  it("never touches the modem's shared empty arrays", () => {
    const m = new ModemCore(cfgOf());
    for (const empty of [m.take(), m.takeSlots(), m.takeGaps()]) {
      expect(empty).toEqual([]);
      expect(Object.isFrozen(empty)).toBe(true);
    }
  });
});

// ——— two phones through their worklets, end to end ———

/**
 * Host and guest, each a WorkletTransport on a fake context whose node is a
 * real processor (worklet.ts) behind a cloning fake port, the processors in
 * the simulated room. Each phone's clock is its own frame counter (in ms);
 * its context's currentTime follows the blocks its processor has rendered,
 * never ahead of real time (Room.jump hands a phone the block after a jump
 * before its time comes). Messages to the worklet are delivered before its
 * next block, messages from it after each step (100 ms unless given).
 * suspend(side, ms) stops a phone's context for that long: its processor
 * isn't called, its speaker is silent, its frame counter and currentTime
 * stand still while its clock runs on, as a suspended or interrupted
 * context's do. suspend(side, ms, lagMs) also brings its microphone back
 * lagMs later than its context's clock says, as Chromium's MediaStream
 * input comes back (about 20 ms).
 */
function worklets(o: RoomOptions, cfgs: [Partial<ModemConfig>, Partial<ModemConfig>] = [{}, {}]) {
  const sr = [o.a?.sampleRate ?? 48000, o.b?.sampleRate ?? 48000] as const;
  let room: Room | null = null;
  const errors: string[] = [];
  const phone = (side: 0 | 1) => {
    const ctx = fakeContext(sr[side]);
    let rendered = 0;
    Object.defineProperty(ctx, "currentTime", { get: () => Math.min(rendered, room!.localMs(side) / 1000 + 128 / sr[side]) });
    const [main, worker] = channel();
    let proc: Processor | null = null;
    const cfg = cfgOf(sr[side], { tx: side ? "guest" : "host", rx: side ? "host" : "guest", ...cfgs[side] });
    const tr = new WorkletTransport(asCtx(ctx), cfg, {
      clock: () => room!.localMs(side),
      t0: 0,
      createNode: (_c, name, options) => {
        proc = processor(options.processorOptions as ModemConfig, worker);
        return new FakeNode(main, name, options) as unknown as AudioWorkletNode;
      }
    });
    tr.onError = (m) => errors.push(`${side}: ${m}`);
    const second = new Float32Array(128);
    /** Frames the context did not render (suspended): its currentFrame is the room's frame less these. */
    const held = { frames: 0 };
    /** How late its microphone comes in (frames), through a delay line. */
    const lag = { frames: 0 };
    const line = new Float32Array(1 << 16);
    const mic = new Float32Array(128);
    let w = 0;
    const endpoint: RoomEndpoint = {
      process(input, output, frame) {
        worker.flush();
        const f = frame! - held.frames;
        scope.currentFrame = f;
        for (let k = 0; k < input.length; k++) {
          line[(w + k) & 0xffff] = input[k]!;
          mic[k] = line[(w + k - lag.frames) & 0xffff]!;
        }
        w += input.length;
        proc!.process([[lag.frames ? mic : input, second]], [[output]]);
        rendered = (f + output.length) / sr[side];
      }
    };
    /** The processor's modem (null once it stopped). */
    const modem = () => (proc as unknown as { modem: ModemCore | null }).modem;
    return { tr, ctx, main, worker, endpoint, held, lag, modem };
  };
  const host = phone(0);
  const guest = phone(1);
  room = new Room(o, host.endpoint, guest.endpoint);
  const got: [LinkPacket[], LinkPacket[]] = [[], []];
  const run = (ms: number, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      room!.run(step / 1000);
      host.main.flush();
      guest.main.flush();
      got[0].push(...host.tr.poll());
      got[1].push(...guest.tr.poll());
    }
  };
  const suspend = (side: 0 | 1, ms: number, lagMs = 0) => {
    room!.jump(side, ms);
    const ph = side ? guest : host;
    ph.held.frames += Math.round((ms / 1000) * sr[side]);
    ph.lag.frames = Math.round((lagMs / 1000) * sr[side]);
  };
  return { host, guest, room, got, run, suspend, errors, sr };
}

/** The keys a list of frames rotates through after a packet carrying `last`, n packets' worth. */
function rotation(keys: number[], last: number | null, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    last = keys.find((k) => last === null || k > last) ?? keys[0]!;
    out.push(last);
  }
  return out;
}

describe("two phones through their worklets", () => {
  it(
    "carry a rotating list one way and a single frame the other, stamped on each phone's clock",
    () => {
      const w = worklets({ seed: 3, distanceCm: 20, a: { ownDb: 35 }, b: { sampleRate: 44100, ppm: 120, ownDb: 35 } });
      w.host.tr.send([keyed(10), keyed(20), keyed(30)]);
      w.guest.tr.send([keyed(77)]);
      w.run(9000);
      // the guest heard the host's three frames in turn, cycling
      const keys = w.got[1].map(keyOf);
      expect(keys.length).toBeGreaterThan(30);
      expect(keys.slice(1)).toEqual(rotation([10, 20, 30], keys[0]!, keys.length - 1));
      expect(w.got[0].map(keyOf).filter((k) => k !== 77)).toEqual([]);
      expect(w.got[0].length).toBeGreaterThan(30);
      // each packet's `at` is its last sample on the receiver's clock (its first DFT window, the back-off, P − 1
      // whole symbols and a useful part), within the block it was rendered in
      for (const side of [0, 1] as const) {
        const ph = side ? w.guest : w.host;
        const rx = kinds(ph.worker, "rx") as ({ t: "rx" } & RxPacket)[];
        const pk = w.got[side];
        const t = timing(w.sr[side]);
        expect(pk.length).toBe(rx.length);
        pk.forEach((p, i) => {
          const r = rx[i]!;
          const ms = ((r.sample + t.backoff + (PACKET_SYMBOLS[r.plan][r.mode] - 1) * t.ts + t.N) / w.sr[side]) * 1000;
          expect(p.at).toBeLessThanOrEqual(ms + 1e-6);
          expect(p.at).toBeGreaterThan(ms - (128 / w.sr[side]) * 1000 - 1e-6);
        });
        // slots likewise, one per packet sent, with the key each carried
        const slots = kinds(ph.worker, "slot") as ({ t: "slot" } & { sample: number; key: number | null })[];
        expect(slots.length).toBeGreaterThan(35);
        expect(slots.map((s) => s.key)).toEqual(side ? slots.map(() => 77) : rotation([10, 20, 30], null, slots.length));
        const at = ph.tr.slots();
        expect(at.length).toBe(slots.length);
        at.forEach((t, i) => expect(Math.abs(t - (slots[i]!.sample / w.sr[side]) * 1000)).toBeLessThan((128 / w.sr[side]) * 1000));
        // stats are at most a quarter second old
        const st = ph.tr.stats();
        expect(st.locked).toBe(true);
        expect(st.rxBad).toBe(0);
        expect(st.rxOk).toBeLessThanOrEqual(pk.length);
        expect(st.rxOk).toBeGreaterThanOrEqual(pk.length - 2);
        expect(st.sinceRx).toBeLessThan(600);
        expect(ph.tr.modemStats()!.txPackets).toBeGreaterThanOrEqual(slots.length - 2);
        // about four stats a second
        expect(Math.abs(kinds(ph.worker, "stats").length - 36)).toBeLessThanOrEqual(2);
      }
      // a new list mid-rotation continues by key; a mode switch and the session key arrive too
      w.host.tr.send([keyed(15), keyed(25)]);
      w.host.tr.setMode("fast");
      w.host.tr.setSessionKey(5, 6);
      w.guest.tr.setSessionKey(5, 6);
      const n = w.got[1].length;
      const m = kinds(w.host.worker, "slot").length;
      w.run(5000);
      // the host's packets: the old list until the new one arrived, then on by key (after 10, 15; after 20, 25; after 30, wrap to 15)
      const sentKeys = kinds(w.host.worker, "slot").map((s) => (s as { key: number }).key);
      const j = sentKeys.findIndex((k, i) => i >= m && (k === 15 || k === 25));
      expect(j).toBeGreaterThanOrEqual(m);
      expect(sentKeys.slice(0, j)).toEqual(rotation([10, 20, 30], null, j));
      expect(sentKeys.slice(j)).toEqual(rotation([15, 25], sentKeys[j - 1]!, sentKeys.length - j));
      // and the guest heard them so
      const after = w.got[1].slice(n).map(keyOf);
      const first = after.findIndex((k) => k === 15 || k === 25);
      expect(after.slice(0, first).every((k) => k === 10 || k === 20 || k === 30)).toBe(true);
      expect(after.slice(first + 1)).toEqual(rotation([15, 25], after[first]!, after.length - first - 1));
      expect(w.host.tr.stats().txMode).toBe("fast");
      expect(w.guest.tr.stats().rxMode).toBe("fast");
      expect(w.errors).toEqual([]);
      // close: the processor stops (process() returns false) and the transport hears nothing more
      w.guest.tr.close();
      w.run(500);
      expect(w.guest.tr.poll()).toEqual([]);
    },
    120_000
  );
});

describe("two phones through their worklets, when things go wrong", () => {
  it(
    "a phone whose context was suspended hears its friend, and is heard, within a second of running again: the stretch goes over as a skip",
    () => {
      for (const side of [0, 1] as const)
        for (const ms of [400, 1100]) {
          const label = `${side ? "guest" : "host"} suspended ${ms} ms`;
          const w = worklets({ seed: 3, distanceCm: 20, a: { ownDb: 35 }, b: { ownDb: 35, ppm: 120 } });
          w.host.tr.send([keyed(10)]);
          w.guest.tr.send([keyed(77)]);
          w.run(6000);
          expect([w.host.tr.stats().locked, w.guest.tr.stats().locked], label).toEqual([true, true]);
          for (const ph of [w.host, w.guest]) ph.tr.takeGaps();
          const n = [w.got[0].length, w.got[1].length];
          w.suspend(side, ms);
          // the true time the context runs again
          const resumed = w.room.time + ms / 1000;
          w.run(ms + 2500);
          // on each phone's clock, the first DFT window of the first packet heard that started after it (a stale lock would
          // wait for the friend's next sync instead: up to 2.4 s). In the room the input moves on by exactly the stretch, so
          // the suspended phone keeps its lock; in Chromium it comes back about 20 ms off (the next test)
          for (const s of [0, 1] as const) {
            const back = w.room.localMs(s, resumed);
            const first = w.got[s].slice(n[s]).find((p) => p.at >= back);
            expect(first, `${label}: phone ${s} heard nothing`).toBeDefined();
            expect(first!.at - back, `${label}: phone ${s}`).toBeLessThan(1000);
          }
          // the suspended phone reports the stretch as a capture gap of its length (and the lead), ending when its modem
          // took the skip; the other reports none
          const gaps = (side ? w.guest : w.host).tr.takeGaps();
          expect(gaps.map((g) => g.ms > 0), label).toEqual([false, true]);
          expect(gaps[1]!.ms, label).toBeGreaterThanOrEqual(ms);
          expect(gaps[1]!.ms, label).toBeLessThan(ms + 7);
          const end = gaps[1]!.at + gaps[1]!.ms - w.room.localMs(side, resumed);
          expect(end, label).toBeGreaterThan(0);
          expect(end, label).toBeLessThan(500);
          expect((side ? w.host : w.guest).tr.takeGaps(), label).toEqual([]);
          expect([w.host.tr.stats().locked, w.guest.tr.stats().locked], label).toEqual([true, true]);
          expect(w.errors, label).toEqual([]);
        }
    },
    120_000
  );

  it(
    "a suspended phone whose microphone comes back 20 ms off its context's clock hears its friend within 1.5 s: the friend, hearing it again, starts a new superframe",
    () => {
      // Chromium's MediaStream input comes back about 20 ms off, past the receiver's tolerance: its lock on the friend is
      // stale after the skip, and it needs a new sync. The friend's next one was up to a superframe away (2.7, 2.4 and
      // 2.4 s here); the friend re-acquiring it after more than a second sends one at once
      for (const [seed, side, ms] of [
        [1, 0, 700],
        [3, 1, 700],
        [10, 1, 1500]
      ] as const) {
        const label = `seed ${seed}, ${side ? "guest" : "host"} suspended ${ms} ms`;
        const w = worklets({ seed, distanceCm: 20, a: { ownDb: 35 }, b: { ownDb: 35, ppm: 120, sampleRate: seed % 3 ? 48000 : 44100 } });
        w.host.tr.send([keyed(10)]);
        w.guest.tr.send([keyed(77)]);
        w.run(5000 + seed * 173);
        const ph = side ? w.guest : w.host;
        const friend = side ? w.host : w.guest;
        // (packets its stale lock decodes before the skip don't count: the skip makes that lock 20 ms off)
        let skipAt = Infinity;
        const post = ph.main.postMessage.bind(ph.main);
        ph.main.postMessage = (m: unknown, x?: Transferable[]) => {
          if ((m as ToWorklet).t === "skip" && skipAt === Infinity) skipAt = ph.tr.now();
          post(m, x);
        };
        const n = [w.got[0].length, w.got[1].length];
        w.suspend(side, ms, 20);
        const resumed = w.room.time + ms / 1000;
        w.run(ms + 3500);
        const back = w.room.localMs(side, resumed);
        const heard = w.got[side].slice(n[side]).find((p) => p.at >= skipAt);
        expect(heard, `${label}: heard nothing`).toBeDefined();
        expect(heard!.at - back, label).toBeLessThan(1500);
        const other = (1 - side) as 0 | 1;
        const backF = w.room.localMs(other, resumed);
        const heardBy = w.got[other].slice(n[other]).find((p) => p.at >= backF);
        expect(heardBy!.at - backF, label).toBeLessThan(1000);
        expect([ph.tr.stats().locked, friend.tr.stats().locked], label).toEqual([true, true]);
        expect(w.errors, label).toEqual([]);
      }
    },
    120_000
  );

  it(
    "a Join's capacity() never offers more than its modem takes, through the detection and on the plan it finds",
    () => {
      for (const plan of ["low", "high"] as const) {
        const w = worklets({ seed: 5, distanceCm: 20, a: { ownDb: 35 }, b: { ownDb: 35, ppm: 90 } }, [{ plan }, { tx: "guest", rx: "detect" }]);
        w.host.tr.send([keyed(10)]);
        w.guest.tr.send([keyed(77)]);
        let lockedFor = 0;
        for (let k = 0; k < 800 && lockedFor < 100; k++) {
          w.run(10, 10);
          expect(w.guest.tr.capacity(), `${plan} plan, ${k * 10} ms`).toBeLessThanOrEqual(w.guest.modem()!.capacity());
          if (w.guest.tr.stats().locked && w.guest.tr.stats().plan === plan) lockedFor++;
        }
        expect(lockedFor, plan).toBe(100);
        // a frame as long as it now offers goes through whole
        const cap = w.guest.tr.capacity();
        expect(cap, plan).toBe(PAYLOAD_BITS[plan]);
        expect(w.guest.tr.detectedPlan(), plan).toBe(plan);
        const frame = sized(78, cap);
        w.guest.tr.send([frame]);
        const n = w.got[0].length;
        w.run(3000);
        const whole = w.got[0].slice(n).filter((p) => p.nbits === cap && p.bits.every((v, i) => v === frame.bits[i]));
        expect(whole.length, plan).toBeGreaterThan(3);
        expect(w.errors, plan).toEqual([]);
      }
    },
    120_000
  );
});

// ——— the AudioWorklet's globals ———

describe("the worklet's import graph", () => {
  it("uses only the AudioWorklet's globals, with module-local declarations", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const code = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
    const resolve = (from: string, spec: string) => {
      const parts = from.split("/").slice(0, -1);
      for (const seg of spec.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      const path = parts.join("/");
      return path.endsWith(".ts") ? path : `${path}.ts`;
    };
    // value imports and re-exports only: `import type` and `export type` are erased
    const imports = /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?"([^"]+)"/gm;
    const graph = new Set<string>();
    const todo = ["../src/link/worklet.ts"];
    while (todo.length) {
      const file = todo.pop()!;
      if (graph.has(file)) continue;
      const src = sources[file];
      expect(src, `${file} exists`).toBeDefined();
      graph.add(file);
      for (const [, type, spec] of src!.matchAll(imports)) {
        if (type) continue;
        expect(spec!.startsWith("."), `${file} imports the package ${spec}`).toBe(true);
        todo.push(resolve(file, spec!));
      }
    }
    const files = [...graph].sort();
    expect(files).toContain("../src/link/modem/core.ts");
    expect(files).toContain("../src/link/worklet-protocol.ts");
    expect(files.filter((f) => !/^\.\.\/src\/(link|sim)\//.test(f))).toEqual([]);
    expect(files).not.toContain("../src/link/worklet-transport.ts");
    const banned =
      /\b(performance|setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|self|window|document|location|navigator|TextEncoder|TextDecoder|crypto|fetch|XMLHttpRequest|localStorage|indexedDB)\b|import\.meta|\bimport\s*\(|Math\.random|declare\s+global/;
    for (const f of files) {
      const hit = banned.exec(code(sources[f]!));
      expect(hit, `${f} uses ${hit?.[0]}`).toBeNull();
    }
    // the scope's own names are declared in worklet.ts, for it alone
    const w = code(sources["../src/link/worklet.ts"]!);
    for (const name of ["sampleRate", "currentFrame", "AudioWorkletProcessor"]) expect(w).toMatch(new RegExp(`^declare const ${name}\\b`, "m"));
    expect(w).toMatch(/^declare function registerProcessor\b/m);
  });
});
