/**
 * The title screen's sounds (src/ui/title.ts), synthesised like the rest:
 * the cinématographe's clatter (the claw pulling the film down 18 times a
 * second over the motor's hum), the film leader's 1 kHz beeps, and the logo
 * slam — a timpani hit and a cymbal under a cavalry bugle's flourish in brass.
 * Everything goes through the effects bus (sfx.bus), so the player's mute and
 * Effects switch apply.
 */
import { sfx } from "./audio";

const ctxOut = (): { c: AudioContext; out: AudioNode } | null => {
  const e = sfx.engine;
  const out = sfx.bus("sfx");
  return e && out ? { c: e.ctx, out } : null;
};

/** One second of projector clatter, made once per context. */
let clatterBuf: AudioBuffer | null = null;
function clatter(c: AudioContext): AudioBuffer {
  if (clatterBuf && clatterBuf.sampleRate === c.sampleRate) return clatterBuf;
  const sr = c.sampleRate;
  const n = sr; // 1 s: 18 pull-downs loop cleanly
  const buf = c.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let seed = 1900;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  // the claw: a sharp tick then a softer one (the gate), 18 times a second
  const frames = 18;
  for (let f = 0; f < frames; f++) {
    const at = Math.floor((f / frames) * n);
    for (const [off, amp, len] of [[0, 0.9, 0.006], [0.016, 0.35, 0.004], [0.031, 0.18, 0.01]] as const) {
      const s0 = at + Math.floor(off * sr);
      const l = Math.floor(len * sr);
      const a = amp * (0.85 + 0.15 * Math.abs(rnd()));
      for (let i = 0; i < l; i++) d[(s0 + i) % n]! += rnd() * a * Math.exp((-i / l) * 4);
    }
  }
  // the shutter's whirr and the motor's hum (60 Hz with its harmonics), quiet under the ticks
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += (rnd() - lp) * 0.08;
    const t = i / sr;
    d[i]! += lp * 0.12 + 0.05 * Math.sin(2 * Math.PI * 60 * t) + 0.025 * Math.sin(2 * Math.PI * 120 * t) + 0.02 * Math.sin(2 * Math.PI * 18 * t) * lp;
  }
  clatterBuf = buf;
  return buf;
}

/** Start the projector; the returned function stops it (with a run-down). */
export function projectorStart(vol = 0.5): () => void {
  const a = ctxOut();
  if (!a) return () => undefined;
  const { c, out } = a;
  const src = c.createBufferSource();
  src.buffer = clatter(c);
  src.loop = true;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2400;
  bp.Q.value = 0.5;
  const g = c.createGain();
  const t = c.currentTime;
  // the motor spins up: the film comes up to speed in a third of a second
  src.playbackRate.setValueAtTime(0.55, t);
  src.playbackRate.exponentialRampToValueAtTime(1, t + 0.35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.12);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const s = c.currentTime;
    src.playbackRate.cancelScheduledValues(s);
    src.playbackRate.setValueAtTime(src.playbackRate.value, s);
    src.playbackRate.linearRampToValueAtTime(0.4, s + 0.35);
    g.gain.cancelScheduledValues(s);
    g.gain.setValueAtTime(g.gain.value, s);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.4);
    src.stop(s + 0.45);
  };
}

/** The film leader's beep (1 kHz), at each number of the countdown. */
export function leaderBeep(vol = 0.22): void {
  const a = ctxOut();
  if (!a) return;
  const { c, out } = a;
  const t = c.currentTime;
  const o = c.createOscillator();
  o.frequency.value = 1000;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.setValueAtTime(vol, t + 0.09);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.13);
}

/** A brass voice: two detuned saws and a square through a filter that opens on the attack (a bugle's blat). */
function brass(c: AudioContext, out: AudioNode, t: number, f: number, dur: number, vol: number): void {
  const g = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 2;
  lp.frequency.setValueAtTime(f * 1.2, t);
  lp.frequency.exponentialRampToValueAtTime(f * 6, t + 0.05);
  lp.frequency.exponentialRampToValueAtTime(f * 3.2, t + Math.min(dur, 0.4));
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.025);
  g.gain.setTargetAtTime(vol * 0.7, t + 0.05, 0.1);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.06);
  lp.connect(g).connect(out);
  const vib = c.createOscillator();
  vib.frequency.value = 5.5;
  const vg = c.createGain();
  vg.gain.setValueAtTime(0, t);
  vg.gain.linearRampToValueAtTime(dur > 0.4 ? f * 0.006 : 0, t + 0.3);
  vib.connect(vg);
  for (const [type, det, lvl] of [["sawtooth", -6, 0.5], ["sawtooth", 7, 0.5], ["square", 0, 0.25]] as const) {
    const o = c.createOscillator();
    o.type = type;
    // the lip slurs up into the note
    o.frequency.setValueAtTime(f * 0.94, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    o.detune.value = det;
    vg.connect(o.frequency);
    const og = c.createGain();
    og.gain.value = lvl;
    o.connect(og).connect(lp);
    o.start(t);
    o.stop(t + dur + 0.4);
  }
  vib.start(t);
  vib.stop(t + dur + 0.4);
}

/**
 * The logo slam: a timpani hit and a crash under a short bugle call in brass
 * (sol–do–mi–sol, then the held do–mi–sol). Returns the length in seconds.
 */
export function slamFanfare(vol = 0.9): number {
  const a = ctxOut();
  if (!a) return 0;
  const { c, out } = a;
  const t = c.currentTime + 0.01;
  const bus = c.createGain();
  bus.gain.value = vol;
  bus.connect(out);
  const noise = sfx.engine!.noise;
  // timpani: a pitched thud with a felt-mallet attack
  for (const [f, lvl] of [[87, 0.9], [131, 0.25]] as const) {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(f * 1.12, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 1.7);
  }
  const hit = (dur: number, type: BiquadFilterType, f: number, lvl: number, at = t) => {
    const s = c.createBufferSource();
    s.buffer = noise;
    const fl = c.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    const g = c.createGain();
    g.gain.setValueAtTime(lvl, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(fl).connect(g).connect(bus);
    s.start(at, Math.random() * 0.3, dur + 0.05);
  };
  hit(0.08, "lowpass", 600, 0.7); // the mallet
  hit(1.6, "highpass", 5200, 0.28); // the crash cymbal
  hit(0.5, "bandpass", 2600, 0.12);
  // the bugle call, in C: G4 C5 E5 | G5 held over C5 E5
  const G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99;
  const s = 0.11;
  brass(c, bus, t + 0.02, G4, 0.1, 0.16);
  brass(c, bus, t + 0.02 + s, C5, 0.1, 0.16);
  brass(c, bus, t + 0.02 + 2 * s, E5, 0.1, 0.16);
  const held = t + 0.02 + 3 * s;
  brass(c, bus, held, G5, 0.95, 0.17);
  brass(c, bus, held, E5, 0.95, 0.11);
  brass(c, bus, held, C5, 0.95, 0.11);
  brass(c, bus, held, C5 / 2, 0.95, 0.12);
  // a second timpani stroke under the held chord
  const o = c.createOscillator();
  o.frequency.setValueAtTime(70, held);
  o.frequency.exponentialRampToValueAtTime(65, held + 0.1);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, held);
  g.gain.exponentialRampToValueAtTime(0.6, held + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, held + 1.2);
  o.connect(g).connect(bus);
  o.start(held);
  o.stop(held + 1.3);
  const end = held + 1.6;
  setTimeout(() => bus.disconnect(), (end - c.currentTime + 0.3) * 1000);
  return end - t;
}
