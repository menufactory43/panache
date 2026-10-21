/**
 * The Belle Époque score (theme.ts BELLE_EPOQUE): the same adaptive
 * machinery as score.ts (layers gated on bar lines by the battle mood,
 * voice-led chords, call-and-answer melodies, the finale's held tonic), in
 * three period styles:
 *
 *  - organ (the menu): an orgue de barbarie waltz in 3/4, flute pipes and a
 *    glockenspiel on the accents over an oom-pah-pah;
 *  - musette (a calm battle): an accordion waltz in 3/4, the reeds tuned
 *    "wet" so they beat, over a light oom-pah-pah;
 *  - march (a fight: once the drums would come in): a brisk 2/4 military
 *    march, field drum with rolls, bass drum and clash cymbals, a tuba
 *    oom-pah, a fife on the tune and bugles on the arpeggio.
 *
 * The style and the biome (each biome has its own key and progression)
 * switch on a bar line, restarting the progression on its tonic. Time is
 * still counted in 16th steps (beats every 4 steps), so a waltz bar is 12
 * steps and a march "bar" 16 (two 2/4 measures). Free of WebAudio:
 * music.ts renders the events.
 */
import type { Biome } from "../sim/types";
import {
  LAYERS,
  MUSIC,
  arpBar,
  bassRoot,
  chordPcs,
  degreeOffset,
  melodyPlays,
  phrase,
  rng,
  smoothstep,
  voiceLead,
  type DrumVoice,
  type Flavour,
  type MelodyNote,
  type MixState,
  type MusicLayer,
  type MusicMode,
  type NoteEvent
} from "./score";

export type BelleStyle = "organ" | "musette" | "march";

export const BELLE_MUSIC = {
  /** Quarter-note tempo of each style. */
  bpm: { organ: 144, musette: 160, march: 116 } as Record<BelleStyle, number>,
  /** 16th steps per bar: 3/4 for the waltzes, two 2/4 measures for the march. */
  stepsPerBar: { organ: 12, musette: 12, march: 16 } as Record<BelleStyle, number>,
  /** Bars per chord. */
  barsPerChord: { organ: 2, musette: 2, march: 1 } as Record<BelleStyle, number>,
  /** A march fill (snare roll) every this many bars at full intensity. */
  fillEvery: 4,
  /** The waltz and the march hold at least this many bars before giving way to each other. */
  minBars: 4
} as const;

const mod12 = (n: number) => ((n % 12) + 12) % 12;
const IONIAN = [0, 2, 4, 5, 7, 9, 11] as const;
const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11] as const;

/** Each biome's key and eight-chord progression (scale degrees, the V gets its seventh). */
export const BELLE_KEYS: Record<Biome, { tonic: number; mode: readonly number[]; progression: readonly number[] }> = {
  // G major: I – IV – V7 – I – vi – ii – V7 – I
  temperate: { tonic: 43, mode: IONIAN, progression: [0, 3, 4, 0, 5, 1, 4, 0] },
  // D minor, harmonic: i – iv – V7 – i – VI – iv – V7 – i (a touch of the exotic)
  desert: { tonic: 38, mode: HARMONIC_MINOR, progression: [0, 3, 4, 0, 5, 3, 4, 0] },
  // F major: I – vi – ii – V7 – I – IV – V7 – I
  arctic: { tonic: 41, mode: IONIAN, progression: [0, 5, 1, 4, 0, 3, 4, 0] },
  // E minor, harmonic: the musette's own sorrowful waltz
  volcanic: { tonic: 40, mode: HARMONIC_MINOR, progression: [0, 3, 4, 0, 5, 3, 4, 0] },
  // C major: the plainest oom-pah, I – V7 – V7 – I – IV – I – V7 – I
  tropical: { tonic: 36, mode: IONIAN, progression: [0, 4, 4, 0, 3, 0, 4, 0] }
};

/** Motifs: [step in the chord, length in steps, scale-step move]. */
const MOTIF: Record<BelleStyle, readonly (readonly [number, number, number])[]> = {
  // three quarters, then a held note and two eighths falling back (two bars of 3/4)
  musette: [[0, 4, 0], [4, 4, 1], [8, 4, 1], [12, 8, -1], [20, 2, -1], [22, 2, -1]],
  // the barrel organ: a long note, a turn, a leap
  organ: [[0, 6, 0], [6, 2, 1], [8, 4, -1], [12, 4, 2], [16, 4, -1], [20, 4, -1]],
  // dotted fife figures over two 2/4 measures
  march: [[0, 3, 0], [3, 1, 1], [4, 4, 1], [8, 3, -1], [11, 1, -1], [12, 4, 2]]
};

const STYLE: Record<BelleStyle, Pick<Flavour, "pad" | "bell" | "arp" | "bass">> = {
  // flute pipes, 8' and 4'
  organ: {
    pad: { a: "triangle", b: "sine", bRatio: 2, detune: 3, cutoff: 1700, q: 0.7 },
    bell: "organ",
    arp: "triangle",
    bass: { wave: "triangle", cutoff: 520, drive: 0, groove: "pulse" }
  },
  // the accordion's reeds, tuned apart so they beat (the musette tremolo)
  musette: {
    pad: { a: "square", b: "sawtooth", bRatio: 1, detune: 12, cutoff: 950, q: 0.8 },
    bell: "accordion",
    arp: "square",
    bass: { wave: "triangle", cutoff: 600, drive: 0, groove: "pulse" }
  },
  // soft horns under a fife, a tuba, bugles
  march: {
    pad: { a: "sawtooth", b: "sawtooth", bRatio: 1, detune: 6, cutoff: 720, q: 0.9 },
    bell: "fife",
    arp: "sawtooth",
    bass: { wave: "sawtooth", cutoff: 340, drive: 0, groove: "pulse" }
  }
};

const cache = new Map<string, Flavour>();

/** The flavour of a biome in a style (one object per pair: music.ts re-applies timbres when it changes). */
export function belleFlavour(biome: Biome, style: BelleStyle): Flavour {
  const id = `${biome}:${style}`;
  let f = cache.get(id);
  if (!f) {
    const k = BELLE_KEYS[biome];
    f = {
      biome,
      tonic: k.tonic,
      mode: k.mode,
      progression: k.progression,
      sevenths: false,
      ...STYLE[style],
      drums: { halfTime: false, tabla: false, toms: false },
      motif: MOTIF[style]
    };
    cache.set(id, f);
  }
  return f;
}

/** The chord on degree `d`: a triad, with the seventh on the dominant (V7). */
export function belleChordPcs(f: Flavour, d: number): number[] {
  const pcs = chordPcs(f, d);
  if (((d % 7) + 7) % 7 === 4) pcs.push(mod12(f.tonic + degreeOffset(f, d + 6)));
  return pcs;
}

/** Target level (0–1) of each layer: the oom-pah stays in (lightly) even when calm. */
export function belleLayerTargets(mode: MusicMode, intensity: number, alarm: boolean): Record<MusicLayer, number> {
  if (mode === "menu") return { pad: 0.55, bell: 0.75, bass: 0.65, drums: 0, arp: 0 };
  if (mode === "end") return { pad: 1, bell: 0.6, bass: 0, drums: 0, arp: 0 };
  const i = Math.max(0, Math.min(1, intensity));
  return {
    pad: 0.6 - 0.15 * smoothstep(0.45, 0.7, i),
    bell: 0.75 - 0.1 * smoothstep(0.45, 0.6, i),
    bass: 0.3 + 0.7 * smoothstep(0.12, 0.35, i),
    drums: smoothstep(0.42, 0.6, i),
    arp: Math.max(smoothstep(0.75, 0.92, i), alarm ? 0.85 : 0)
  };
}

const pat = (s: string): number[] => [...s].map((c) => (c === "X" ? 1 : c === "x" ? 0.65 : c === "o" ? 0.35 : 0));

/**
 * One march bar (two 2/4 measures) of drums: bass drum and clash cymbals on
 * the downbeats, the field drum around them; at full tilt every fourth bar
 * rolls into the next, and the first bar of a march is a roll-off.
 */
export function marchDrums(level: 1 | 2, bar: number): Partial<Record<DrumVoice, number[]>> {
  if (bar === 0) return { roll: pat("X..............."), kick: pat("........X......."), cym: pat("........X.......") };
  if (level === 1) return { kick: pat("X.......x......."), cym: pat("x..............."), snare: pat("..o.X.o...o.X.x.") };
  if (bar % BELLE_MUSIC.fillEvery === BELLE_MUSIC.fillEvery - 1)
    return { kick: pat("X...x..........."), cym: pat("X..............."), snare: pat("x.oxX.x.......X."), roll: pat("........x.......") };
  return { kick: pat("X...x...X...x..."), cym: pat("X.......x......."), snare: pat("x.oxX.x.x.oxX.xo") };
}

/** The oom-pah of one bar: bass notes ("oom", root then fifth) and chord stabs ("pah"). */
export function oomPah(style: BelleStyle, level: 1 | 2, barInChord: number): { bass: [number, number, number][]; stab: [number, number][] } {
  // bass: [step, interval from the root, length]; stab: [step, velocity]
  if (style === "march")
    return level === 1
      ? { bass: [[0, 0, 3], [8, -5, 3]], stab: [[4, 0.75], [12, 0.7]] }
      : { bass: [[0, 0, 2], [4, -5, 2], [8, 0, 2], [12, -5, 2]], stab: [[2, 0.7], [6, 0.6], [10, 0.7], [14, 0.6]] };
  const oom: [number, number, number][] = [[0, barInChord % 2 ? -5 : 0, 4]];
  if (level === 2 && barInChord % 2) oom.push([10, -3, 2]); // a walk back up to the root
  return { bass: oom, stab: [[4, 0.75], [8, 0.6]] };
}

export class BelleComposer {
  flavour: Flavour;
  style: BelleStyle = "musette";
  biome: Biome;
  bpm: number = BELLE_MUSIC.bpm.musette;
  /** Steps since the current style / biome began (beats every 4 steps). */
  step = 0;
  voicing: number[] = [];
  root = 0;
  readonly gates: Record<MusicLayer, boolean> = { pad: true, bell: false, bass: false, drums: false, arp: false };
  private pendingBiome: Biome | null = null;
  private inBar = 0;
  private bar = 0;
  private chordStep = 0;
  private chordIdx = 0;
  private degree = 0;
  private melody: MelodyNote[] = [];
  private lastMelody: number | null = null;
  private level: 1 | 2 = 1;
  private alarm = false;
  private hold = 0;
  private rand: () => number;

  constructor(biome: Biome, seed = 1) {
    this.biome = biome;
    this.flavour = belleFlavour(biome, this.style);
    this.rand = rng(seed);
  }

  get stepSeconds(): number {
    return 60 / this.bpm / 4;
  }

  /** Switch biome at the next bar line. */
  setBiome(b: Biome): void {
    this.pendingBiome = b === this.biome ? null : b;
  }

  closeGates(keep: readonly MusicLayer[] = ["pad"]): NoteEvent[] {
    const ev: NoteEvent[] = [];
    for (const l of LAYERS)
      if (this.gates[l] && !keep.includes(l)) {
        this.gates[l] = false;
        ev.push({ kind: "gate", layer: l, on: false });
      }
    return ev;
  }

  holdTonic(major: boolean, steps: number): Extract<NoteEvent, { kind: "chord" }> {
    const t = this.flavour.tonic;
    const pcs = [t, t + (major ? 4 : 3), t + 7].map(mod12);
    this.voicing = voiceLead(this.voicing.length ? this.voicing : null, pcs, MUSIC.padLo, MUSIC.padHi);
    this.root = mod12(t);
    this.hold = steps;
    this.melody = [];
    return { kind: "chord", notes: this.voicing, root: this.root };
  }

  next(mix: MixState): NoteEvent[] {
    const ev: NoteEvent[] = [];
    if (this.inBar === 0) {
      const tg = belleLayerTargets(mix.mode, mix.intensity, mix.alarm);
      for (const l of LAYERS) {
        const on = this.gates[l] ? tg[l] > 0.02 : tg[l] > 0.08;
        if (on !== this.gates[l]) {
          this.gates[l] = on;
          ev.push({ kind: "gate", layer: l, on });
        }
      }
      let style: BelleStyle = mix.mode === "menu" ? "organ" : mix.mode === "end" ? this.style : this.gates.drums ? "march" : "musette";
      // waltz and march each hold for a few bars, so a fight on the edge doesn't flip-flop
      if (style !== this.style && style !== "organ" && this.style !== "organ" && this.bar < BELLE_MUSIC.minBars) style = this.style;
      const biome = this.pendingBiome ?? this.biome;
      this.pendingBiome = null;
      if (style !== this.style || biome !== this.biome) {
        this.style = style;
        this.biome = biome;
        this.flavour = belleFlavour(biome, style);
        this.step = 0;
        this.bar = 0;
        this.chordStep = 0;
        this.chordIdx = 0;
      }
      this.bpm = BELLE_MUSIC.bpm[this.style];
      this.level = mix.intensity >= MUSIC.drumsDriveAt ? 2 : 1;
      this.alarm = mix.alarm && mix.mode === "battle";
    }
    const f = this.flavour;
    const style = this.style;
    const sb = BELLE_MUSIC.stepsPerBar[style];
    const chordLen = sb * BELLE_MUSIC.barsPerChord[style];

    if (this.hold > 0) this.hold--;
    else if (this.chordStep === 0 || this.voicing.length === 0) {
      this.degree = f.progression[this.chordIdx % f.progression.length]!;
      const pcs = belleChordPcs(f, this.degree);
      this.voicing = voiceLead(this.voicing.length ? this.voicing : null, pcs, MUSIC.padLo, MUSIC.padHi);
      this.root = pcs[0]!;
      ev.push({ kind: "chord", notes: this.voicing, root: this.root });
      this.melody = melodyPlays(this.chordIdx) ? phrase(f, this.degree, this.chordIdx, this.lastMelody, this.rand, style === "march" ? 8 : 12) : [];
      const last = this.melody[this.melody.length - 1];
      if (last) this.lastMelody = last.midi;
    }

    if (this.gates.bell)
      for (const n of this.melody) if (n.step === this.chordStep) ev.push({ kind: "bell", midi: n.midi, len: n.len, vel: n.vel });

    if (this.gates.bass) {
      const root = this.hold > 0 ? f.tonic : bassRoot(f, this.degree);
      const op = oomPah(style, this.level, Math.floor(this.chordStep / sb));
      for (const [s, iv, len] of op.bass) if (s === this.inBar) ev.push({ kind: "bass", midi: root + iv, len, vel: s === 0 ? 1 : 0.75 });
      for (const [s, vel] of op.stab)
        if (s === this.inBar) ev.push({ kind: "stab", notes: this.voicing.slice(-3), len: style === "march" ? 1.5 : 2.5, vel });
    }

    if (this.gates.drums && style === "march") {
      const db = marchDrums(this.level, this.bar);
      for (const [voice, steps] of Object.entries(db) as [DrumVoice, number[]][]) {
        const v = steps[this.inBar] ?? 0;
        if (v > 0) ev.push({ kind: "drum", voice, vel: v });
      }
    }

    if (this.gates.arp && this.inBar % 2 === 0) {
      // bugles (or, in a waltz, the reeds) on 8th notes up and down the chord
      const notes = arpBar(this.voicing, this.root, this.alarm);
      ev.push({ kind: "arp", midi: notes[this.inBar % 16]!, vel: this.inBar % 4 === 0 ? 1 : 0.62 });
    }

    this.step++;
    this.inBar = (this.inBar + 1) % sb;
    if (this.inBar === 0) this.bar++;
    if (++this.chordStep >= chordLen) {
      this.chordStep = 0;
      this.chordIdx++;
    }
    return ev;
  }
}
