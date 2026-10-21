/**
 * The Belle Époque sound effects (theme.ts BELLE_EPOQUE): the same events
 * as audio.ts's recipes, voiced for 1889–1910. Black-powder guns crack
 * before they boom and leave a noisy tail; the 75 sends its shell off with
 * a whistle; the Hotchkiss rattles like a crank-driven machine; Congreve
 * and Ruggieri rockets sputter and fizz with a firework crackle; the
 * Hydroglisseur's arc buzzes and snaps like a Tesla coil. The interface
 * clicks like a typewriter, rings a hotel-desk bell when production is
 * ready, sounds a bugle for alerts, a tocsin for an approaching enemy, and
 * a cash register when money comes back.
 *
 * Same contract as audio.ts's recipes: synthesise into `out` from time `t`
 * and return the length (s) after which `out` may be disconnected. Every
 * node is started and stopped inside that window. Levels were matched to
 * the original recipes by offline renders (RMS within a few dB).
 */
import type { SfxName } from "./audio";

export type Recipe = (ctx: BaseAudioContext, out: AudioNode, t: number, noise: AudioBuffer, pitch: number) => number;

// ------------------------------------------------------------- helpers ---

/** A filtered noise burst with an exponential decay (and an optional filter sweep). */
function nb(
  c: BaseAudioContext, o: AudioNode, t: number, n: AudioBuffer,
  dur: number, type: BiquadFilterType, freq: number, gain: number, freqEnd?: number, q?: number
): void {
  const src = c.createBufferSource();
  src.buffer = n;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (q !== undefined) f.Q.value = q;
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(o);
  src.start(t, Math.random() * 0.4, dur + 0.05);
}

/** An oscillator sweep with a quick attack and an exponential decay. */
function tn(
  c: BaseAudioContext, o: AudioNode, t: number, type: OscillatorType,
  f0: number, f1: number, dur: number, gain: number, delay = 0, attack = 0.008
): void {
  const osc = c.createOscillator();
  osc.type = type;
  const s = t + delay;
  osc.frequency.setValueAtTime(f0, s);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), s + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, s);
  g.gain.exponentialRampToValueAtTime(gain, s + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  osc.connect(g).connect(o);
  osc.start(s);
  osc.stop(s + dur + 0.02);
}

/**
 * A run of clicks from one noise source: crackle, ratchet, debris, a
 * sputter. `count` clicks spread over `span` seconds (jittered unless
 * `even`), each a sharp tick of `click` seconds; levels taper by `taper`.
 */
function ticks(
  c: BaseAudioContext, o: AudioNode, t: number, n: AudioBuffer, count: number, span: number,
  type: BiquadFilterType, freq: number, gain: number, opts: { click?: number; even?: boolean; taper?: number; q?: number } = {}
): void {
  const click = opts.click ?? 0.006;
  const src = c.createBufferSource();
  src.buffer = n;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (opts.q !== undefined) f.Q.value = opts.q;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  for (let i = 0; i < count; i++) {
    const k = count > 1 ? i / (count - 1) : 0;
    const at = t + (opts.even ? k * span : Math.random() * span);
    const v = gain * (1 - (opts.taper ?? 0) * k) * (opts.even ? 1 : 0.5 + Math.random() * 0.5);
    g.gain.setValueAtTime(v, at);
    g.gain.setTargetAtTime(0, at + 0.001, click / 3);
  }
  src.connect(f).connect(g).connect(o);
  src.start(t, Math.random() * 0.5, span + click * 4 + 0.05);
}

/** A struck bell: a sine with inharmonic partials (2.76×, 5.4×), long decay. */
function bell(c: BaseAudioContext, o: AudioNode, t: number, f: number, gain: number, dur: number): void {
  tn(c, o, t, "sine", f, f, dur, gain, 0, 0.002);
  tn(c, o, t, "sine", f * 2.76, f * 2.76, dur * 0.45, gain * 0.35, 0, 0.002);
  tn(c, o, t, "sine", f * 5.4, f * 5.4, dur * 0.18, gain * 0.15, 0, 0.002);
}

/** A bugle-like brass note: two detuned saws through a swelling lowpass. */
function brass(c: BaseAudioContext, o: AudioNode, t: number, f: number, dur: number, gain: number): void {
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(f * 1.5, t);
  lp.frequency.exponentialRampToValueAtTime(f * 5, t + 0.04);
  lp.frequency.setTargetAtTime(f * 3.2, t + 0.06, 0.08);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.025);
  g.gain.setValueAtTime(gain * 0.8, t + Math.max(0.03, dur - 0.05));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g).connect(o);
  for (const d of [-6, 7]) {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f * 0.985, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.03); // the lip slides up into the note
    osc.detune.value = d;
    osc.connect(lp);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

/** A steam whistle: two close sines (the beating of a chime whistle) and breath. */
function whistle(c: BaseAudioContext, o: AudioNode, t: number, n: AudioBuffer, f0: number, f1: number, dur: number, gain: number): void {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.04);
  g.gain.setValueAtTime(gain, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(o);
  for (const r of [1, 1.26]) {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f0 * r, t);
    osc.frequency.exponentialRampToValueAtTime(f1 * r, t + dur);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  nb(c, o, t, n, dur, "bandpass", f0 * 1.1, gain * 0.9, f1 * 1.1, 4);
}

/** A cash register: the drawer's clatter, then the bell. */
function kaChing(c: BaseAudioContext, o: AudioNode, t: number, n: AudioBuffer, gain: number): void {
  ticks(c, o, t, n, 4, 0.09, "bandpass", 3200, 0.5 * gain, { even: true, q: 2 });
  nb(c, o, t + 0.1, n, 0.08, "lowpass", 1600, 0.35 * gain);
  bell(c, o, t + 0.13, 2093, 0.16 * gain, 0.7);
  bell(c, o, t + 0.13, 2637, 0.07 * gain, 0.55);
}

// ------------------------------------------------------------- recipes ---

export const BELLE_RECIPES: Partial<Record<SfxName, Recipe>> = {
  // ---- weapons ----
  // a section of automaton fusiliers: a ragged Lebel volley, and its echo off the hills
  rifle: (c, o, t, n) => {
    for (const [d, f, v] of [[0, 2300, 0.25], [0.05, 2700, 0.19], [0.11, 2100, 0.16]] as const) {
      nb(c, o, t + d, n, 0.025, "bandpass", f, v);
      nb(c, o, t + d, n, 0.06, "lowpass", 1100, v * 0.7);
    }
    nb(c, o, t + 0.09, n, 0.3, "bandpass", 700, 0.06, 400);
    return 0.42;
  },
  // a chasseur's rifle: a hard crack, a ricochet's whine and the mountain's answer
  snipe: (c, o, t, n) => {
    nb(c, o, t, n, 0.045, "highpass", 2600, 0.6);
    nb(c, o, t, n, 0.1, "lowpass", 900, 0.4);
    tn(c, o, t, "sine", 2700, 1500, 0.26, 0.06, 0.06);
    nb(c, o, t + 0.14, n, 0.4, "bandpass", 800, 0.09, 450);
    return 0.56;
  },
  // the Panhard's gun and the Hotchkiss: a black-powder crack, a short boom and a smoky tail
  cannon: (c, o, t, n) => {
    nb(c, o, t, n, 0.03, "highpass", 1800, 0.45);
    tn(c, o, t, "sine", 150, 46, 0.16, 0.5);
    nb(c, o, t, n, 0.3, "lowpass", 1700, 0.42, 180);
    return 0.32;
  },
  // the Creusot's big gun: crack, a deep boom, and the powder smoke rolling away
  heavy: (c, o, t, n) => {
    nb(c, o, t, n, 0.04, "highpass", 1500, 0.6);
    tn(c, o, t, "sine", 105, 28, 0.42, 0.95);
    nb(c, o, t, n, 0.45, "lowpass", 1200, 0.75, 100);
    nb(c, o, t + 0.08, n, 0.7, "lowpass", 320, 0.35, 90);
    return 0.8;
  },
  // a Hotchkiss machine gun: three quick reports and the click of the feed strip
  mg: (c, o, t, n) => {
    for (const d of [0, 0.05, 0.1]) {
      nb(c, o, t + d, n, 0.032, "bandpass", 1500, 0.55, undefined, 1.2);
      nb(c, o, t + d, n, 0.02, "highpass", 3000, 0.2);
    }
    ticks(c, o, t + 0.025, n, 3, 0.1, "bandpass", 4200, 0.16, { even: true, q: 6 });
    return 0.16;
  },
  // the Faucheux's pom-pom: two dull thuds going up
  flak: (c, o, t, n) => {
    for (const d of [0, 0.1]) {
      tn(c, o, t + d, "sine", 190, 70, 0.11, 0.1);
      nb(c, o, t + d, n, 0.12, "lowpass", 1400, 0.13, 300);
      nb(c, o, t + d, n, 0.025, "bandpass", 1800, 0.08);
    }
    return 0.24;
  },
  // a Congreve rocket: a sputtering fizz rising away, a little firework crackle
  rocket: (c, o, t, n) => {
    nb(c, o, t, n, 0.4, "bandpass", 700, 0.27, 2600, 1.4);
    ticks(c, o, t, n, 14, 0.36, "bandpass", 1800, 0.24, { click: 0.012, q: 0.8 });
    ticks(c, o, t + 0.28, n, 6, 0.16, "highpass", 4200, 0.14);
    return 0.5;
  },
  // a Ruggieri skyrocket: the whoosh, a screaming whistle and the crackle of its trail
  missile: (c, o, t, n) => {
    nb(c, o, t, n, 0.5, "bandpass", 500, 0.36, 3000);
    tn(c, o, t, "sine", 1100, 2400, 0.45, 0.045, 0.03, 0.05);
    ticks(c, o, t + 0.1, n, 10, 0.4, "highpass", 3800, 0.2, { taper: 0.5 });
    return 0.56;
  },
  // the Hydroglisseur's electric arc: a Tesla buzz (detuned square hum) and snapping sparks
  laser: (c, o, t, n) => {
    const lp = c.createBiquadFilter();
    lp.type = "bandpass";
    lp.frequency.value = 1200;
    lp.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.setValueAtTime(0.065, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    lp.connect(g).connect(o);
    for (const f of [118, 121.5, 237]) {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = f;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 0.28);
    }
    ticks(c, o, t, n, 9, 0.24, "highpass", 3000, 0.12, { click: 0.004 });
    nb(c, o, t, n, 0.08, "highpass", 5000, 0.04);
    return 0.3;
  },
  // the 75 fires: a sharp crack, the boom, and the shell whistling away
  shell: (c, o, t, n) => {
    nb(c, o, t, n, 0.035, "highpass", 2000, 0.65);
    tn(c, o, t, "sine", 120, 36, 0.3, 0.8);
    nb(c, o, t, n, 0.42, "lowpass", 1300, 0.6, 90);
    tn(c, o, t, "sine", 1900, 950, 0.45, 0.04, 0.1, 0.06);
    return 0.62;
  },
  // an Albatros lets its bombs go: the falling whistle
  bomb: (c, o, t) => {
    tn(c, o, t, "sine", 1500, 420, 0.55, 0.075, 0, 0.06);
    tn(c, o, t, "triangle", 3000, 840, 0.5, 0.012, 0, 0.06);
    return 0.58;
  },

  // ---- impacts and deaths ----
  // a machine blows up: boom, debris rattling down, and the boiler's steam hissing out
  explosion: (c, o, t, n) => {
    nb(c, o, t, n, 0.03, "highpass", 1600, 0.4);
    tn(c, o, t, "sine", 88, 26, 0.48, 0.8);
    nb(c, o, t, n, 0.62, "lowpass", 1500, 0.85, 85);
    ticks(c, o, t + 0.12, n, 8, 0.45, "bandpass", 2600, 0.18, { taper: 0.6, q: 3 });
    nb(c, o, t + 0.15, n, 0.55, "highpass", 4200, 0.06, 6500);
    return 0.72;
  },
  // a building comes down: a deep boom, timbers cracking, masonry and iron rattling down
  bigExplosion: (c, o, t, n) => {
    nb(c, o, t, n, 0.05, "highpass", 1400, 0.55);
    nb(c, o, t, n, 1.4, "lowpass", 1200, 1, 50);
    nb(c, o, t + 0.12, n, 1.0, "lowpass", 700, 0.7, 60);
    tn(c, o, t, "sine", 70, 22, 1.1, 1);
    ticks(c, o, t + 0.15, n, 5, 0.5, "bandpass", 1100, 0.35, { click: 0.015, q: 4 });
    ticks(c, o, t + 0.3, n, 14, 1, "bandpass", 2400, 0.16, { taper: 0.7, q: 2 });
    return 1.5;
  },
  // a Creusot rolls over automatons: crunch, a snapped mainspring, a spill of gears
  crush: (c, o, t, n) => {
    nb(c, o, t, n, 0.18, "lowpass", 900, 0.55, 200);
    tn(c, o, t + 0.03, "triangle", 1400, 380, 0.16, 0.06);
    ticks(c, o, t + 0.04, n, 7, 0.18, "bandpass", 3600, 0.22, { q: 5 });
    return 0.26;
  },
  // an automaton falls: a clank, the spring letting go, a few gear ticks
  clank: (c, o, t, n) => {
    tn(c, o, t, "triangle", 900, 640, 0.08, 0.08);
    tn(c, o, t + 0.02, "sine", 1800, 700, 0.1, 0.03);
    ticks(c, o, t + 0.03, n, 4, 0.08, "bandpass", 4200, 0.14, { q: 5 });
    return 0.14;
  },
  // a Montgolfière's burner roars as squads climb aboard or jump down
  thrust: (c, o, t, n) => {
    nb(c, o, t, n, 0.38, "bandpass", 500, 0.62, 900, 0.7);
    nb(c, o, t, n, 0.3, "lowpass", 260, 0.45);
    tn(c, o, t + 0.08, "sine", 160, 120, 0.25, 0.04);
    return 0.4;
  },

  // ---- interface ----
  // a typewriter key / a brass switch
  click: (c, o, t, n) => {
    nb(c, o, t, n, 0.014, "bandpass", 3400, 0.5, undefined, 1.5);
    tn(c, o, t, "triangle", 2200, 1900, 0.025, 0.035, 0.004, 0.002);
    return 0.05;
  },
  // building placed: a hammer on an anvil, twice
  build: (c, o, t, n) => {
    for (const [d, v] of [[0, 1], [0.13, 0.75]] as const) {
      nb(c, o, t + d, n, 0.02, "highpass", 2500, 0.4 * v);
      bell(c, o, t + d, 1250, 0.2 * v, 0.22);
    }
    return 0.4;
  },
  // production ready: the hotel-desk bell
  ready: (c, o, t, n) => {
    ticks(c, o, t, n, 1, 0.001, "bandpass", 3000, 0.2);
    bell(c, o, t + 0.005, 1975, 0.16, 0.8);
    return 0.85;
  },
  // under attack: a bugle sounds the alarm, "ta-ta-taa"
  alert: (c, o, t) => {
    brass(c, o, t, 392, 0.1, 0.05);
    brass(c, o, t + 0.13, 392, 0.1, 0.05);
    brass(c, o, t + 0.26, 523, 0.26, 0.06);
    return 0.56;
  },
  // the Pasteur at work: a wrench's ratchet and a soft rising tone
  heal: (c, o, t, n) => {
    ticks(c, o, t, n, 3, 0.1, "bandpass", 3000, 0.12, { even: true, q: 4 });
    tn(c, o, t, "sine", 800, 1200, 0.22, 0.035);
    return 0.26;
  },
  // promoted: a bugle's rising call
  rank: (c, o, t) => {
    [523, 659, 784].forEach((f, i) => brass(c, o, t + i * 0.09, f, 0.08, 0.07));
    brass(c, o, t + 0.27, 1047, 0.22, 0.07);
    return 0.52;
  },
  // sold: the cash register
  sell: (c, o, t, n) => {
    kaChing(c, o, t, n, 0.4);
    return 0.86;
  },
  // the match is won: a bugle fanfare
  victory: (c, o, t) => {
    [392, 523, 659].forEach((f, i) => brass(c, o, t + i * 0.15, f, 0.13, 0.075));
    brass(c, o, t + 0.45, 784, 0.6, 0.085);
    brass(c, o, t + 0.45, 523, 0.6, 0.045);
    return 1.08;
  },
  // the match is lost: a slow, falling bugle
  defeat: (c, o, t) => {
    [392, 330, 262].forEach((f, i) => brass(c, o, t + i * 0.24, f, 0.22, 0.12));
    brass(c, o, t + 0.72, 196, 0.6, 0.13);
    return 1.35;
  },
  // an enemy machine down where you can see it: a crunch and a small brass "ting"
  kill: (c, o, t, n) => {
    nb(c, o, t, n, 0.06, "bandpass", 2400, 0.28, undefined, 1.2);
    bell(c, o, t + 0.01, 1568, 0.11, 0.24);
    bell(c, o, t + 0.05, 2349, 0.07, 0.2);
    return 0.3;
  },
  // one of yours died: its boiler sighs out in a falling whistle, and a thud
  lost: (c, o, t, n) => {
    whistle(c, o, t, n, 760, 300, 0.4, 0.07);
    nb(c, o, t + 0.05, n, 0.35, "highpass", 3500, 0.06);
    tn(c, o, t, "sine", 200, 50, 0.32, 0.22);
    return 0.44;
  },
  // a streak of coal delivered: a coin's clink, in the score's key
  coin: (c, o, t, _n, p) => {
    bell(c, o, t, 1320 * p, 0.075, 0.14);
    bell(c, o, t + 0.045, 1760 * p, 0.08, 0.22);
    return 0.28;
  },
  // the enemy approaches: the tocsin, a hammered alarm bell
  inbound: (c, o, t) => {
    for (let i = 0; i < 4; i++) bell(c, o, t + i * 0.14, 880, i % 2 ? 0.1 : 0.13, 0.32);
    return 0.76;
  },
  // can't go there: two dull wooden knocks
  deny: (c, o, t, n) => {
    for (const d of [0, 0.09]) {
      nb(c, o, t + d, n, 0.04, "bandpass", 600, 0.55, undefined, 3);
      tn(c, o, t + d, "sine", 190, 150, 0.06, 0.12);
    }
    return 0.17;
  },
  // squad saved: a tram bell's two dings
  squad: (c, o, t) => {
    bell(c, o, t, 1318, 0.08, 0.16);
    bell(c, o, t + 0.08, 1760, 0.08, 0.2);
    return 0.3;
  },

  // ---- commander calldowns ----
  // a hand-cranked siren winding up and down, with the crank's flutter
  siren: (c, o, t) => {
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1500;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.3);
    g.gain.setValueAtTime(0.12, t + 1.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    const flutter = c.createGain();
    flutter.gain.value = 0.85;
    const lfo = c.createOscillator();
    lfo.frequency.setValueAtTime(9, t);
    lfo.frequency.linearRampToValueAtTime(16, t + 1);
    lfo.frequency.linearRampToValueAtTime(10, t + 2.1);
    const depth = c.createGain();
    depth.gain.value = 0.2;
    lfo.connect(depth).connect(flutter.gain);
    f.connect(flutter).connect(g).connect(o);
    for (const [type, mul] of [["triangle", 1], ["square", 2.002]] as const) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(300 * mul, t);
      osc.frequency.linearRampToValueAtTime(760 * mul, t + 0.6);
      osc.frequency.linearRampToValueAtTime(440 * mul, t + 1.05);
      osc.frequency.linearRampToValueAtTime(760 * mul, t + 1.6);
      osc.frequency.linearRampToValueAtTime(420 * mul, t + 2.1);
      const og = c.createGain();
      og.gain.value = type === "square" ? 0.25 : 1;
      osc.connect(og).connect(f);
      osc.start(t);
      osc.stop(t + 2.15);
    }
    lfo.start(t);
    lfo.stop(t + 2.15);
    return 2.15;
  },
  // the Fée électricité: a great arc discharge, crackling, over a 50 Hz hum and a thump
  emp: (c, o, t, n) => {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    lp.connect(g).connect(o);
    for (const f of [50, 51.3, 100.4]) {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = f;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 0.57);
    }
    ticks(c, o, t, n, 18, 0.45, "highpass", 2600, 0.55, { click: 0.005, taper: 0.5 });
    nb(c, o, t, n, 0.3, "bandpass", 5200, 0.2);
    tn(c, o, t, "sine", 130, 38, 0.45, 0.7);
    return 0.62;
  },
  // a crate lands: heavy thud, timbers cracking, an iron band ringing, dust
  pod: (c, o, t, n) => {
    tn(c, o, t, "sine", 95, 30, 0.42, 1);
    nb(c, o, t, n, 0.5, "lowpass", 1400, 0.7, 120);
    ticks(c, o, t + 0.02, n, 4, 0.12, "bandpass", 1200, 0.4, { click: 0.012, q: 4 });
    bell(c, o, t + 0.05, 520, 0.06, 0.35);
    nb(c, o, t + 0.1, n, 0.6, "bandpass", 2400, 0.16, 600);
    return 0.75;
  },
  // the big shell lands: a crack, then a long rolling boom and the rubble coming down
  hammer: (c, o, t, n) => {
    nb(c, o, t, n, 0.18, "highpass", 2500, 0.9);
    nb(c, o, t, n, 1.8, "lowpass", 1500, 1, 40);
    nb(c, o, t + 0.2, n, 1.4, "lowpass", 600, 0.8, 50);
    tn(c, o, t, "sine", 70, 18, 1.6, 1);
    tn(c, o, t + 0.05, "sine", 48, 16, 1.4, 0.8);
    ticks(c, o, t + 0.4, n, 16, 1.2, "bandpass", 2000, 0.14, { taper: 0.7, q: 2 });
    return 1.85;
  },
  // the big shell's telegraph: its whistle falling and swelling out of the sky
  charge: (c, o, t, n) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(2300, t);
    osc.frequency.exponentialRampToValueAtTime(520, t + 2.9);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 2.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.95);
    osc.connect(g).connect(o);
    osc.start(t);
    osc.stop(t + 3);
    nb(c, o, t + 1.2, n, 1.75, "bandpass", 1600, 0.05, 500, 2);
    return 3;
  },
  // your calldown is away: the telegraph sounder's click-clack and a dit-dah
  uplink: (c, o, t, n) => {
    ticks(c, o, t, n, 2, 0.06, "bandpass", 1800, 0.3, { even: true, q: 3 });
    tn(c, o, t + 0.1, "sine", 760, 760, 0.05, 0.08, 0, 0.004);
    tn(c, o, t + 0.17, "sine", 760, 760, 0.13, 0.08, 0, 0.004);
    ticks(c, o, t + 0.1, n, 2, 0.07, "bandpass", 1600, 0.25, { even: true, q: 3 });
    return 0.32;
  },

  // ---- map objectives ----
  // a TSF tower taken: a bright bugle arpeggio and a bell
  capture: (c, o, t) => {
    [523, 659, 784].forEach((f, i) => brass(c, o, t + i * 0.08, f, 0.08, 0.045));
    brass(c, o, t + 0.24, 1047, 0.3, 0.045);
    bell(c, o, t + 0.24, 2093, 0.04, 0.4);
    return 0.66;
  },
  // a TSF tower lost: a falling minor bugle call
  uplinkLost: (c, o, t) => {
    brass(c, o, t, 659, 0.14, 0.055);
    brass(c, o, t + 0.16, 523, 0.14, 0.055);
    brass(c, o, t + 0.32, 415, 0.3, 0.055);
    return 0.66;
  },
  // supply drop inbound: a dirigible's propeller droning overhead, the gondola creaking, a telegraph tap
  drop: (c, o, t, n) => {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(78, t);
    osc.frequency.linearRampToValueAtTime(96, t + 0.8);
    osc.frequency.linearRampToValueAtTime(70, t + 1.6);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 600;
    const blades = c.createGain();
    blades.gain.value = 0.6;
    const lfo = c.createOscillator();
    lfo.type = "triangle";
    lfo.frequency.setValueAtTime(14, t);
    lfo.frequency.linearRampToValueAtTime(17, t + 0.8);
    lfo.frequency.linearRampToValueAtTime(12, t + 1.6);
    const depth = c.createGain();
    depth.gain.value = 0.4;
    lfo.connect(depth).connect(blades.gain);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    osc.connect(f).connect(blades).connect(g).connect(o);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 1.65);
    lfo.stop(t + 1.65);
    nb(c, o, t, n, 1.5, "bandpass", 300, 0.2, 700);
    tn(c, o, t + 0.5, "triangle", 420, 380, 0.25, 0.02, 0, 0.08);
    ticks(c, o, t + 1.2, n, 3, 0.2, "bandpass", 1800, 0.3, { even: true, q: 3 });
    return 1.65;
  },
  // crate claimed: the lid's nails creak open, then the cash register
  crate: (c, o, t, n) => {
    ticks(c, o, t, n, 3, 0.08, "bandpass", 1300, 0.4, { click: 0.012, q: 4 });
    kaChing(c, o, t + 0.1, n, 0.42);
    return 0.95;
  },

  // ---- the Gargantua ----
  // a machine knocked out: sparks, and the steam going out of it in a falling whistle
  offline: (c, o, t, n) => {
    ticks(c, o, t, n, 4, 0.18, "highpass", 3800, 0.24);
    whistle(c, o, t + 0.05, n, 900, 260, 0.6, 0.05);
    nb(c, o, t + 0.05, n, 0.6, "highpass", 3000, 0.08);
    return 0.68;
  },
  // a machine back in action: pressure building into a short whistle toot
  reboot: (c, o, t, n) => {
    nb(c, o, t, n, 0.75, "bandpass", 600, 0.07, 2400, 1.5);
    tn(c, o, t, "sine", 120, 360, 0.75, 0.03);
    whistle(c, o, t + 0.78, n, 1046, 1046, 0.22, 0.03);
    return 1.02;
  },
  // a Gargantua walks out of its gallery: the cradle's clank and a locomotive's chord whistle
  rollout: (c, o, t, n) => {
    nb(c, o, t, n, 0.08, "highpass", 2800, 0.2);
    tn(c, o, t, "triangle", 300, 260, 0.14, 0.2);
    whistle(c, o, t + 0.15, n, 392, 392, 0.9, 0.025);
    whistle(c, o, t + 0.15, n, 494, 494, 0.9, 0.018);
    return 1.12;
  },
  // two Montgolfières hook onto a Gargantua: the hooks bite, the burners roar
  hook: (c, o, t, n) => {
    for (const d of [0, 0.09]) {
      tn(c, o, t + d, "triangle", 980, 700, 0.06, 0.08);
      nb(c, o, t + d, n, 0.04, "highpass", 3000, 0.15);
    }
    nb(c, o, t + 0.12, n, 0.7, "bandpass", 450, 0.42, 900, 0.7);
    tn(c, o, t + 0.12, "sine", 110, 140, 0.6, 0.1);
    return 0.84;
  },
  // Robot Love: a music box, a rising chime of tines
  love: (c, o, t) => {
    [1047, 1319, 1568, 2093, 2637].forEach((f, i) => {
      tn(c, o, t + i * 0.11, "sine", f, f, 0.7, 0.07, 0, 0.002);
      tn(c, o, t + i * 0.11, "sine", f * 3, f * 3, 0.12, 0.015, 0, 0.002);
    });
    tn(c, o, t + 0.2, "triangle", 262, 262, 1.2, 0.06);
    return 1.45;
  }
};
