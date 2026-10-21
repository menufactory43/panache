/**
 * The modem's AudioWorkletProcessor (SOUND-DUEL.md "Worklet"): ModemCore on
 * the audio thread, one process() call per render quantum (128 frames),
 * talking to WorkletTransport over its port. Everything the modem does is in
 * ModemCore; this file only picks the microphone channel, hands the block
 * and its currentFrame over, copies the output to every output channel and
 * turns what the modem reports into messages.
 *
 * Loading. WorkletTransport imports this file as `./worklet.ts?worker&url`.
 * A production build bundles it and everything it imports into one
 * self-contained IIFE asset, which addModule accepts (a module script with no
 * imports) and the PWA precaches; the dev server serves it as an ES module
 * with its imports, which addModule loads as well. tools/worklet-smoke.mjs
 * runs both in Chromium.
 *
 * Allowed globals. This file and everything it imports use only JS builtins
 * plus the AudioWorkletGlobalScope's sampleRate, currentFrame,
 * registerProcessor and AudioWorkletProcessor (and the processor's port):
 * no import.meta, dynamic import(), self, window, document, location,
 * performance, timers, TextEncoder/TextDecoder, crypto or fetch
 * (tests/link-worklet.test.ts walks the import graph to check). The
 * declarations below are module-local, never `declare global`, so nothing
 * else in the project can use them by accident.
 *
 * Input. The node takes 2 channels, "explicit" and "discrete", so a stereo
 * microphone's channels arrive as they are. Each block uses the louder
 * channel when the other is more than 40 dB quieter (a phone whose
 * microphone sits on its second channel), and channel 0 otherwise: never the
 * sum of two live microphones, which comb-filters. With nothing connected
 * yet (the microphone comes after the node) the input is silence, which
 * ModemCore counts as a capture gap.
 *
 * Skips. A context that is suspended or interrupted (or whose audio thread
 * stalls) renders nothing meanwhile, and its currentFrame carries on from
 * where it stopped: the modem would see one seamless stream while the
 * friend's has moved on. WorkletTransport notices the context's clock
 * falling behind its own and posts {t:"skip", frames}; the frames are added
 * to currentFrame from then on, so ModemCore takes them as a jump (a new
 * superframe, and a gap of known length; see WorkletTransport for what that
 * buys). Every `sample` posted back has the frames skipped so far taken off
 * again, which puts it in the context's frame domain as the context's clock
 * runs now.
 *
 * Where the spec is silent:
 *  - the modem runs at the scope's own sampleRate, whatever
 *    processorOptions.sampleRate says (the two are the same context's);
 *  - stats go out at the first block, then every sampleRate / 4 frames;
 *  - a message the modem refuses (a payload list that breaks a rule, a plan
 *    the rate can't carry, a skip that isn't a whole number ≥ 1) posts
 *    {t:"error", fatal: false} and changes nothing;
 *  - an exception anywhere in process() (the modem's block, or turning what
 *    it reports into messages) posts {t:"error", fatal: true} once and
 *    leaves the processor silent: the modem's state can't be trusted after
 *    it, and a thrown process() would take the node down with nothing for
 *    the page but a bare processorerror;
 *  - messages after {t:"close"} are ignored, and the modem is released.
 */
import { ModemCore, type ModemConfig } from "./modem/core";
import { MODEM_PROCESSOR, type FromWorklet, type ToWorklet } from "./worklet-protocol";

// The AudioWorkletGlobalScope's names, for this module only.
declare const sampleRate: number;
declare const currentFrame: number;
declare const AudioWorkletProcessor: new () => { readonly port: MessagePort };
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: ModemConfig }) => unknown): void;

/** Below this ratio of energies (−40 dB) a channel counts as quieter than the other. */
const QUIETER = 1e-4;

class ModemProcessor extends AudioWorkletProcessor {
  private modem: ModemCore | null = null;
  private closed = false;
  /** Silence for a block with no input connected (resized only if the quantum ever changes). */
  private zeros = new Float32Array(128);
  private readonly statsEvery: number;
  private nextStats = -Infinity;
  /** Frames skipped so far ({t:"skip"}): the modem's frame is currentFrame plus these. */
  private skipped = 0;

  constructor(options: { processorOptions?: ModemConfig }) {
    super();
    this.statsEvery = Math.round(sampleRate / 4);
    try {
      const cfg = options.processorOptions;
      if (!cfg) throw new RangeError("the modem's node needs processorOptions: a ModemConfig");
      this.modem = new ModemCore({ ...cfg, sampleRate });
    } catch (e) {
      this.post({ t: "error", message: messageOf(e), fatal: true });
    }
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.receive(e.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.closed) return false;
    const out = outputs[0];
    const ch0 = out?.[0];
    if (!out || !ch0) return true;
    const modem = this.modem;
    if (!modem) {
      for (let c = 0; c < out.length; c++) out[c]!.fill(0);
      return true;
    }
    const frame = currentFrame + this.skipped;
    // (the whole block, reporting too: a throw that left process() would only reach the page as a bare processorerror)
    try {
      modem.process(this.pick(inputs[0], ch0.length), ch0, frame);
      for (let c = 1; c < out.length; c++) out[c]!.set(ch0);
      this.report(modem, frame);
    } catch (e) {
      this.modem = null;
      this.post({ t: "error", message: `le modem s'est arrêté : ${messageOf(e)}`, fatal: true });
      for (let c = 0; c < out.length; c++) out[c]!.fill(0);
    }
    return true;
  }

  /** The block's microphone: the louder channel when the other is more than 40 dB quieter, else channel 0; silence when nothing is connected. */
  private pick(chans: Float32Array[] | undefined, n: number): Float32Array {
    const a = chans?.[0];
    if (!a || a.length !== n) {
      if (this.zeros.length !== n) this.zeros = new Float32Array(n);
      return this.zeros;
    }
    const b = chans[1];
    if (!b || b.length !== n) return a;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < n; i++) {
      ea += a[i]! * a[i]!;
      eb += b[i]! * b[i]!;
    }
    // (a NaN on either side compares false: channel 0, which the modem then counts as missing input)
    return ea < QUIETER * eb ? b : a;
  }

  /**
   * What the modem has for the main thread, each `sample` taken back to the
   * context's frame domain. Nothing is built when there is nothing to say:
   * take*() return a shared empty array then.
   */
  private report(modem: ModemCore, frame: number): void {
    const off = this.skipped;
    const rx = modem.take();
    for (let i = 0; i < rx.length; i++) {
      const p = rx[i]!;
      // the bits are a fresh copy per packet: hand the buffer over rather than clone it
      this.port.postMessage({ t: "rx", ...p, sample: p.sample - off } satisfies FromWorklet, [p.bits.buffer]);
    }
    const slots = modem.takeSlots();
    for (let i = 0; i < slots.length; i++) this.post({ t: "slot", ...slots[i]!, sample: slots[i]!.sample - off });
    const gaps = modem.takeGaps();
    for (let i = 0; i < gaps.length; i++) this.post({ t: "gap", ...gaps[i]!, sample: gaps[i]!.sample - off });
    // (a frame counter that went back starts the schedule over)
    if (frame >= this.nextStats || frame < this.nextStats - this.statsEvery) {
      this.nextStats = frame + this.statsEvery;
      const st = modem.stats();
      this.post({ t: "stats", ...st, sample: st.sample - off });
    }
  }

  private receive(msg: ToWorklet): void {
    if (msg.t === "close") {
      this.closed = true;
      this.modem = null;
      return;
    }
    const m = this.modem;
    if (!m || this.closed) return;
    try {
      switch (msg.t) {
        case "payload":
          m.setPayloads(msg.frames);
          break;
        case "mode":
          m.setTxMode(msg.mode);
          break;
        case "session":
          m.setSessionKey(msg.hostNonce, msg.guestNonce);
          break;
        case "config":
          m.reconfigure({ plan: msg.plan, tx: msg.tx, rx: msg.rx, gain: msg.gain });
          break;
        case "skip":
          if (!Number.isSafeInteger(msg.frames) || msg.frames < 1) throw new RangeError(`a skip of ${msg.frames} frames`);
          this.skipped += msg.frames;
          break;
      }
    } catch (e) {
      this.post({ t: "error", message: messageOf(e), fatal: false });
    }
  }

  private post(msg: FromWorklet): void {
    this.port.postMessage(msg);
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

registerProcessor(MODEM_PROCESSOR, ModemProcessor);
