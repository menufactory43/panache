/**
 * The adaptive soundtrack's composition rules: biome flavours (mode, chord
 * progression, timbres), voice leading, bass / drum / arp / melody patterns,
 * stinger phrases, and the battle "mood" that drives the layers. Free of
 * WebAudio and three.js so it is unit-testable (tests/music.test.ts);
 * src/game/music.ts turns the events into sound.
 *
 * Time is counted in 16th-note steps: 16 per bar, one chord per two bars.
 */
import { TICK_RATE } from "../sim/balance";
import type { Biome, Faction, FxEvent, PowerKind } from "../sim/types";
import type { Announcement } from "./announce";

export type Wave = "sine" | "square" | "sawtooth" | "triangle";
export type MusicLayer = "pad" | "bell" | "bass" | "drums" | "arp";
export const LAYERS: readonly MusicLayer[] = ["pad", "bell", "bass", "drums", "arp"];
export type MusicMode = "menu" | "battle" | "end";

export const MUSIC = {
  battleBpm: 96,
  menuBpm: 80,
  stepsPerBar: 16,
  /** One chord per two bars: a four-chord progression loops every 8 bars. */
  stepsPerChord: 32,
  /** Pad voicing range (MIDI note numbers). */
  padLo: 50,
  padHi: 74,
  /** Intensity smoothing time constants (s): quick to swell, slow to settle. */
  attackS: 0.5,
  releaseS: 6,
  /** Audible shots (earshot-weighted) in this many sim seconds… */
  shotWindowS: 4,
  /** …this many of them is a full-on fight on its own. */
  shotsForFull: 32,
  /**
   * The base alarm needs a real attack: this many hits on our buildings
   * within alarmWindowS (a stray shot at a turret doesn't count). It then
   * holds (with +0.5 intensity) until buildingHitS after the last hit.
   */
  alarmHits: 3,
  alarmWindowS: 4,
  buildingHitS: 5,
  buildingHitBoost: 0.5,
  /** The alarm motif is a warning, not a soundtrack: it sounds this long per attack. */
  alarmMaxS: 15,
  /** Spectators see the whole map unfogged: a fight needs this many times the shots. */
  spectatorShotScale: 1.5,
  /** Own losses in this window add up to +0.25. */
  deathWindowS: 10,
  deathsForFull: 3,
  deathBoost: 0.25,
  /** Our units fought anywhere in this window: the bass pulse stays in. */
  contactS: 8,
  contactFloor: 0.3,
  /**
   * Calldowns are the loudest moments in a match: an impact adds this
   * (× its earshot) and fades out over strikeFadeS. A Sky Hammer counts at
   * least strikeHammerFloor wherever it lands (its boom carries) and in full
   * when it lands on or near our things.
   */
  strikeBoost: { barrage: 0.45, emp: 0.3, droppod: 0.3, hammer: 0.85 } as Record<PowerKind, number>,
  strikeFadeS: 6,
  strikeHammerFloor: 0.5,
  /** An enemy strike telegraphed onto our things lifts the tension before it lands. */
  telegraphBoost: 0.35,
  /** Last Stand: from a wave's warning until a little after it arrives, the bass pulse stays in. */
  waveFloor: 0.35,
  waveHoldS: 6,
  /** Drums go double-time / bass drives above these levels. */
  drumsDriveAt: 0.75,
  bassDriveAt: 0.6
} as const;

export const MODES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10]
} as const;

/** (accordion, organ and fife: the Belle Époque score, score-belle.ts) */
export type BellKind = "pluck" | "oud" | "glass" | "marimba" | "pan" | "accordion" | "organ" | "fife";
export type Groove = "pulse" | "tresillo" | "chug" | "glide" | "calypso";

export interface Flavour {
  biome: Biome;
  /** MIDI note of the tonic in the bass register. */
  tonic: number;
  /** Semitone offsets of the seven modal degrees. */
  mode: readonly number[];
  /** Chord roots as scale-degree indices (0–6), one chord per two bars. */
  progression: readonly number[];
  /** Stack a seventh on each chord (lusher) rather than doubling the root. */
  sevenths: boolean;
  /** Pad: two detuned oscillators per voice through a lowpass. */
  pad: { a: Wave; b: Wave; bRatio: number; detune: number; cutoff: number; q: number };
  bell: BellKind;
  arp: Wave;
  bass: { wave: Wave; cutoff: number; drive: number; groove: Groove };
  drums: { halfTime: boolean; tabla: boolean; toms: boolean };
  /** Melody motif over a two-bar phrase: [step, length in steps, scale-step move]. */
  motif: readonly (readonly [number, number, number])[];
}

export const FLAVOURS: Record<Biome, Flavour> = {
  // Riverlands / Proving Grounds: D dorian, Dm7 – Fmaj7 – Cmaj7 – G7, a
  // warm string pad and a plucked kalimba melody
  temperate: {
    biome: "temperate",
    tonic: 38,
    mode: MODES.dorian,
    progression: [0, 2, 6, 3],
    sevenths: true,
    pad: { a: "sawtooth", b: "triangle", bRatio: 1, detune: 7, cutoff: 950, q: 0.7 },
    bell: "pluck",
    arp: "triangle",
    bass: { wave: "square", cutoff: 680, drive: 0, groove: "pulse" },
    drums: { halfTime: false, tabla: false, toms: false },
    motif: [[0, 4, 0], [4, 2, 1], [6, 2, 1], [8, 6, -1], [14, 2, -1], [16, 4, 2], [20, 4, -1], [24, 8, -1]]
  },
  // Dune Sea: E phrygian dominant, E – F – Am – Dm, a nasal pad, an oud-like
  // pluck, tresillo bass and tabla
  desert: {
    biome: "desert",
    tonic: 40,
    mode: MODES.phrygianDominant,
    progression: [0, 1, 3, 6],
    sevenths: false,
    pad: { a: "sawtooth", b: "sawtooth", bRatio: 1, detune: 9, cutoff: 1250, q: 2.2 },
    bell: "oud",
    arp: "square",
    bass: { wave: "sawtooth", cutoff: 720, drive: 0, groove: "tresillo" },
    drums: { halfTime: false, tabla: true, toms: false },
    motif: [[0, 3, 0], [3, 1, 1], [4, 2, -1], [6, 2, -1], [8, 8, 0], [18, 2, 2], [20, 2, -1], [22, 2, -1], [24, 8, -1]]
  },
  // Frostbite: F lydian, Fmaj7 – G7 – Dm7 – Am7, a glassy octave pad, FM
  // bells and half-time drums
  arctic: {
    biome: "arctic",
    tonic: 41,
    mode: MODES.lydian,
    progression: [0, 1, 5, 2],
    sevenths: true,
    pad: { a: "sine", b: "triangle", bRatio: 2, detune: 5, cutoff: 2400, q: 0.5 },
    bell: "glass",
    arp: "sine",
    bass: { wave: "sawtooth", cutoff: 560, drive: 0, groove: "glide" },
    drums: { halfTime: true, tabla: false, toms: false },
    motif: [[0, 8, 0], [8, 4, 2], [12, 4, 1], [16, 12, -1], [28, 4, -2]]
  },
  // Ashlands: C aeolian, Cm – Ab – Eb – Bb, a dark wide pad, marimba,
  // distorted chugging bass and toms
  volcanic: {
    biome: "volcanic",
    tonic: 36,
    mode: MODES.aeolian,
    progression: [0, 5, 2, 6],
    sevenths: false,
    pad: { a: "sawtooth", b: "sawtooth", bRatio: 1, detune: 14, cutoff: 650, q: 1.2 },
    bell: "marimba",
    arp: "sawtooth",
    bass: { wave: "sawtooth", cutoff: 300, drive: 0.55, groove: "chug" },
    drums: { halfTime: false, tabla: false, toms: true },
    motif: [[0, 6, 0], [6, 2, -1], [8, 8, -1], [16, 6, 2], [22, 2, 1], [24, 8, -2]]
  },
  // Archipelago: G mixolydian, G – C – F – C, an island vamp: a reedy
  // melodica pad, steel pan, a calypso bass line
  tropical: {
    biome: "tropical",
    tonic: 43,
    mode: MODES.mixolydian,
    progression: [0, 3, 6, 3],
    sevenths: false,
    pad: { a: "square", b: "triangle", bRatio: 2, detune: 8, cutoff: 1700, q: 1.2 },
    bell: "pan",
    arp: "triangle",
    bass: { wave: "triangle", cutoff: 820, drive: 0, groove: "calypso" },
    drums: { halfTime: false, tabla: false, toms: false },
    motif: [[0, 3, 0], [3, 3, 1], [6, 2, 1], [8, 4, -1], [12, 2, -1], [14, 2, 2], [16, 6, 1], [22, 2, -1], [24, 8, -2]]
  }
};

export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const mod12 = (n: number) => ((n % 12) + 12) % 12;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------ harmony ---

/** Semitones above the tonic of scale degree `d` (any integer, wraps octaves). */
export function degreeOffset(f: Flavour, d: number): number {
  const oct = Math.floor(d / 7);
  return f.mode[((d % 7) + 7) % 7]! + 12 * oct;
}

/** Pitch classes (0–11, absolute) of the chord built on scale degree `d`: root first. */
export function chordPcs(f: Flavour, d: number): number[] {
  const steps = f.sevenths ? [0, 2, 4, 6] : [0, 2, 4];
  return steps.map((k) => mod12(f.tonic + degreeOffset(f, d + k)));
}

/** Bass note for a chord root: the nearest one to the tonic, a fourth below to a fifth above. */
export function bassRoot(f: Flavour, d: number): number {
  const pc = mod12(f.tonic + degreeOffset(f, d));
  for (let m = f.tonic - 5; m <= f.tonic + 7; m++) if (mod12(m) === pc) return m;
  return f.tonic;
}

/**
 * Voice a four-voice chord in [lo, hi] as close as possible to the previous
 * voicing (smooth voice leading). Triads double the root. Adjacent voices
 * stay at least a whole tone apart (a minor third at the bottom), no two
 * voices clash a minor second / ninth apart, the span stays within 19
 * semitones, and the seventh never sits in the bass. Root position is
 * preferred, then the third, then the fifth; the first voicing centres in
 * the range.
 */
export function voiceLead(prev: readonly number[] | null, pcs: readonly number[], lo: number, hi: number): number[] {
  const want = pcs.length >= 4 ? pcs.slice(0, 4) : [...pcs, pcs[0]!];
  const cands = want.map((pc) => {
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) if (mod12(m) === pc) out.push(m);
    return out;
  });
  /** Penalty for each chord member in the bass (seventh: not allowed). */
  const bassCost = new Map<number, number>([
    [pcs[0]!, 0],
    [pcs[1]!, 2],
    [pcs[2]!, 3]
  ]);
  const centre = (lo + hi) / 2;
  let best: number[] | null = null;
  let bestCost = Infinity;
  const pick: number[] = [];
  const walk = (i: number): void => {
    if (i === want.length) {
      const v = [...pick].sort((a, b) => a - b);
      const bc = bassCost.get(mod12(v[0]!));
      if (bc === undefined) return;
      if (v[v.length - 1]! - v[0]! > 19) return;
      if (v[0]! < 57 && v[1]! - v[0]! < 3) return;
      for (let k = 1; k < v.length; k++) if (v[k]! - v[k - 1]! < 2) return;
      for (let a = 0; a < v.length; a++)
        for (let b = a + 1; b < v.length; b++) if ((v[b]! - v[a]!) % 12 === 1) return;
      let cost: number;
      if (prev && prev.length === v.length) {
        cost = bc;
        for (let k = 0; k < v.length; k++) cost += Math.abs(v[k]! - prev[k]!);
      } else cost = 2 * Math.abs(v.reduce((a, b) => a + b, 0) / v.length - centre) + 3 * bc;
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
      return;
    }
    for (const m of cands[i]!) {
      pick.push(m);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best ?? want.map((pc, i) => lo + mod12(pc - lo) + (i >= 2 ? 12 : 0)).sort((a, b) => a - b);
}

// ------------------------------------------------------------ melody ---

export interface MelodyNote {
  /** Step within the two-bar phrase (0–31). */
  step: number;
  /** Length in steps. */
  len: number;
  midi: number;
  vel: number;
}

export const bellRange = (f: Flavour): [number, number] => [f.tonic + 24, f.tonic + 43];

function scaleNotes(f: Flavour, lo: number, hi: number): number[] {
  const pcs = new Set(f.mode.map((o) => mod12(f.tonic + o)));
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.has(mod12(m))) out.push(m);
  return out;
}

function nearest(list: readonly number[], m: number, bias = 0): number {
  let best = list[0]!;
  let bd = Infinity;
  for (const n of list) {
    // a small bias breaks ties toward the direction of travel
    const d = Math.abs(n - m) - (bias !== 0 && Math.sign(n - m) === Math.sign(bias) ? 0.25 : 0);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/**
 * One two-bar melody phrase over the chord on degree `d`: the biome's motif
 * walked through the scale, strong beats landing on chord tones. Odd
 * phrases answer the even ones and resolve to the chord's root or fifth.
 */
export function phrase(f: Flavour, d: number, index: number, prev: number | null, rand: () => number, strongEvery = 8): MelodyNote[] {
  const [lo, hi] = bellRange(f);
  const scale = scaleNotes(f, lo, hi);
  const pcs = chordPcs(f, d);
  const chordTones = scale.filter((m) => pcs.includes(mod12(m)));
  const cadence = chordTones.filter((m) => mod12(m) === pcs[0] || mod12(m) === pcs[2]);
  let cur = nearest(chordTones, prev ?? (lo + hi) / 2);
  const out: MelodyNote[] = [];
  f.motif.forEach(([step, len, move], i) => {
    if (i > 0) {
      let mv = move;
      // a little variation, but never a stalled repeat
      if (rand() < 0.22) {
        const v = mv + (rand() < 0.5 ? -1 : 1);
        if (v !== 0) mv = v;
      }
      if (index % 2 === 1 && i === 1) mv = -mv; // the answer turns the contour around
      const idx = scale.indexOf(nearest(scale, cur));
      // bounce off the edges of the range rather than leaping an octave
      if (idx + mv < 0 || idx + mv >= scale.length) mv = -mv;
      const prevNote = cur;
      cur = scale[Math.max(0, Math.min(scale.length - 1, idx + mv))]!;
      const strong = step % strongEvery === 0;
      const last = i === f.motif.length - 1;
      const target = last && index % 2 === 1 ? cadence : strong ? chordTones : null;
      if (target) {
        // land on a chord tone, still moving the way the motif goes
        const ahead = mv === 0 ? target : target.filter((m) => Math.sign(m - prevNote) === Math.sign(mv));
        cur = nearest(ahead.length ? ahead : target, cur, mv);
      }
    }
    out.push({ step, len, midi: cur, vel: step % strongEvery === 0 ? 1 : 0.72 });
  });
  return out;
}

/** The calm melody plays two phrases (call and answer), then rests for two. */
export const melodyPlays = (phraseIndex: number): boolean => phraseIndex % 4 < 2;

// ------------------------------------------------------------ patterns ---

const pat = (s: string): number[] =>
  [...s].map((c) => (c === "X" ? 1 : c === "x" ? 0.65 : c === "o" ? 0.35 : 0));

/** (roll and cym: the Belle Époque march, score-belle.ts) */
export type DrumVoice = "kick" | "snare" | "hat" | "open" | "tak" | "dhum" | "tom" | "crash" | "roll" | "cym";

/** One bar of drums: a velocity (0 = rest) per step for each voice. */
export type DrumBar = Partial<Record<DrumVoice, number[]>>;

/** The drum bar for `level` 1 (a fight) or 2 (a big one); every fourth bar of a big fight ends in a fill. */
export function drumBar(f: Flavour, level: 1 | 2, bar: number): DrumBar {
  const fill = level === 2 && bar % 4 === 3;
  const d = f.drums;
  if (d.halfTime)
    return level === 1
      ? { kick: pat("X..............."), snare: pat("........X......."), hat: pat("x...o...x...o...") }
      : {
          kick: pat("X.........x....."),
          snare: pat(fill ? "........X...x.xX" : "........X......."),
          hat: pat("x.o.x.o.x.o.x.o."),
          open: pat("..............x.")
        };
  const bar1: DrumBar = {
    kick: pat("X.......X.x....."),
    snare: pat("....X.......X..."),
    hat: pat("x.o.x.o.x.o.x.o.")
  };
  const bar2: DrumBar = {
    kick: pat("X..x....X.x..x.."),
    snare: pat(fill ? "....X.......XxXX" : "....X.......X..o"),
    hat: pat(fill ? "xoxoXoxoxoxo...." : "xoxoXoxoxoxoXoxo"),
    open: pat(fill ? "................" : "..............x.")
  };
  const out = level === 1 ? bar1 : bar2;
  if (d.tabla) {
    out.tak = pat(level === 1 ? "..x..x.x..x..x.x" : ".xx.xx.x.xx.xxox");
    out.dhum = pat("X.....x....X....");
    if (level === 1) {
      out.kick = pat("X.......X.......");
      out.snare = pat("............X...");
    }
  }
  if (d.toms) {
    out.kick = pat(level === 1 ? "X.....x.X......." : "X.xX..x.X.x...x.");
    out.tom = pat(fill ? "............xxXX" : level === 2 ? "..............xx" : "................");
  }
  return out;
}

export interface BassHit {
  step: number;
  /** Semitones above the chord's bass root. */
  interval: number;
  len: number;
  vel: number;
}

const GROOVES: Record<Groove, [string, string]> = {
  // R root, F fifth, O octave; capitals accented
  pulse: ["R.r.r.r.R.r.r.O.", "R.rr.r.rR.r.rO.F"],
  tresillo: ["R..r..r.R..r..F.", "R.rr.rr.R.rr.FO."],
  chug: ["R.r.rr.rR.r.rr.F", "Rrr.rrr.Rrr.rrOF"],
  glide: ["R.......F.......", "R...r...F...r..."],
  calypso: ["R..r..F.R.r.O.F.", "R.rR.rF.R.rrO.Fr"]
};

/** One bar of bass for the biome's groove; `level` 2 drives harder. */
export function bassBar(f: Flavour, level: 1 | 2): BassHit[] {
  const s = GROOVES[f.bass.groove][level - 1]!;
  const hits: BassHit[] = [];
  const at = [...s].map((c, i) => [c, i] as const).filter(([c]) => c !== ".");
  at.forEach(([c, i], k) => {
    const next = k + 1 < at.length ? at[k + 1]![1] : 16;
    const lc = c.toLowerCase();
    hits.push({
      step: i,
      interval: lc === "f" ? 7 : lc === "o" ? 12 : 0,
      len: Math.min(next - i, f.bass.groove === "glide" ? 8 : 3),
      vel: c === c.toUpperCase() ? 1 : 0.7
    });
  });
  return hits;
}

/**
 * Arpeggio notes for one bar of 16ths: up and down the voicing an octave
 * above the pad. The alarm swaps the fifth for a tritone over the root.
 */
export function arpBar(voicing: readonly number[], rootPc: number, alarm: boolean): number[] {
  let tones = voicing.map((m) => m + 12);
  if (alarm) {
    const root = tones.find((m) => mod12(m) === rootPc) ?? tones[0]!;
    tones = [root, root + 3, root + 6, root + 12];
  }
  tones = tones.map((m) => (m > 96 ? m - 12 : m)).sort((a, b) => a - b);
  const top = tones[0]! + 12 <= 96 ? tones[0]! + 12 : tones[tones.length - 1]!;
  const ring = [...tones, top];
  const order = [0, 1, 2, 3, 4, 3, 2, 1];
  return Array.from({ length: 16 }, (_, i) => ring[order[i % 8]!]!);
}

// -------------------------------------------------------------- layers ---

/** Target level (0–1) of each layer for the current mode and battle intensity. */
export function layerTargets(mode: MusicMode, intensity: number, alarm: boolean): Record<MusicLayer, number> {
  if (mode === "menu") return { pad: 1, bell: 0.75, bass: 0, drums: 0, arp: 0.45 };
  if (mode === "end") return { pad: 1, bell: 0.6, bass: 0, drums: 0, arp: 0 };
  const i = clamp01(intensity);
  return {
    pad: 1 - 0.15 * smoothstep(0.5, 1, i),
    // the calm melody steps aside as the fight takes over
    bell: 1 - smoothstep(0.3, 0.55, i),
    bass: smoothstep(0.15, 0.35, i),
    drums: smoothstep(0.42, 0.6, i),
    arp: Math.max(smoothstep(0.72, 0.9, i), alarm ? 0.85 : 0)
  };
}

// ----------------------------------------------------------- composer ---

export type NoteEvent =
  | { kind: "gate"; layer: MusicLayer; on: boolean }
  | { kind: "chord"; notes: number[]; root: number }
  | { kind: "bass"; midi: number; len: number; vel: number }
  | { kind: "bell"; midi: number; len: number; vel: number }
  | { kind: "arp"; midi: number; vel: number }
  | { kind: "drum"; voice: DrumVoice; vel: number }
  /** The "pah" of an oom-pah: a short chord (the Belle Époque score). */
  | { kind: "stab"; notes: number[]; len: number; vel: number };

export interface MixState {
  mode: MusicMode;
  intensity: number;
  alarm: boolean;
}

/** Small deterministic PRNG (mulberry32) so phrases are reproducible in tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Turns the running mix state into note events, one 16th step at a time.
 * Layers switch on and off only on bar lines (so drums kick in on a
 * downbeat, with a crash); a new biome or tempo also waits for a bar line.
 */
export class Composer {
  flavour: Flavour;
  bpm: number = MUSIC.battleBpm;
  /** Steps since the current flavour began (drives bar / chord position). */
  step = 0;
  voicing: number[] = [];
  root = 0;
  readonly gates: Record<MusicLayer, boolean> = { pad: true, bell: false, bass: false, drums: false, arp: false };
  private pending: Flavour | null = null;
  private melody: MelodyNote[] = [];
  private lastMelody: number | null = null;
  private bassLevel: 1 | 2 = 1;
  private drumLevel: 1 | 2 = 1;
  private alarm = false;
  /** A held chord (finale) overrides the progression for this many more steps. */
  private hold = 0;
  private rand: () => number;

  constructor(flavour: Flavour, seed = 1) {
    this.flavour = flavour;
    this.rand = rng(seed);
  }

  /** Switch to a biome's flavour at the next bar line. */
  setBiome(b: Biome): void {
    this.setFlavour(FLAVOURS[b]);
  }

  /** Switch biome at the next bar line. */
  setFlavour(f: Flavour): void {
    this.pending = f === this.flavour ? null : f;
  }

  get stepSeconds(): number {
    return 60 / this.bpm / 4;
  }

  /** Close every layer but the pad at once (stingers and the finale). */
  closeGates(keep: readonly MusicLayer[] = ["pad"]): NoteEvent[] {
    const ev: NoteEvent[] = [];
    for (const l of LAYERS)
      if (this.gates[l] && !keep.includes(l)) {
        this.gates[l] = false;
        ev.push({ kind: "gate", layer: l, on: false });
      }
    return ev;
  }

  /** Glide the pad to the tonic major (victory) or minor (defeat) chord and hold it. */
  holdTonic(major: boolean, steps: number): Extract<NoteEvent, { kind: "chord" }> {
    const t = this.flavour.tonic;
    const pcs = [t, t + (major ? 4 : 3), t + 7].map(mod12);
    this.voicing = voiceLead(this.voicing.length ? this.voicing : null, pcs, MUSIC.padLo, MUSIC.padHi);
    this.root = mod12(t);
    this.hold = steps;
    this.melody = [];
    return { kind: "chord", notes: this.voicing, root: this.root };
  }

  /** The events of the next step. */
  next(mix: MixState): NoteEvent[] {
    const ev: NoteEvent[] = [];
    const sb = MUSIC.stepsPerBar;
    if (this.step % sb === 0) {
      if (this.pending) {
        this.flavour = this.pending;
        this.pending = null;
        this.step = 0;
      }
      this.bpm = mix.mode === "menu" ? MUSIC.menuBpm : MUSIC.battleBpm;
      const tg = layerTargets(mix.mode, mix.intensity, mix.alarm);
      for (const l of LAYERS) {
        // hysteresis: harder to open than to stay open
        const on = this.gates[l] ? tg[l] > 0.02 : tg[l] > 0.08;
        if (on !== this.gates[l]) {
          this.gates[l] = on;
          ev.push({ kind: "gate", layer: l, on });
          if (l === "drums" && on) ev.push({ kind: "drum", voice: "crash", vel: 0.8 });
        }
      }
      this.drumLevel = mix.intensity >= MUSIC.drumsDriveAt ? 2 : 1;
      this.bassLevel = mix.intensity >= MUSIC.bassDriveAt ? 2 : 1;
      this.alarm = mix.alarm && mix.mode === "battle";
    }
    const f = this.flavour;
    const s = this.step;
    const inBar = s % sb;
    const inChord = s % MUSIC.stepsPerChord;
    const bar = Math.floor(s / sb);
    const phraseIdx = Math.floor(s / MUSIC.stepsPerChord);
    const degree = f.progression[phraseIdx % f.progression.length]!;

    if (this.hold > 0) this.hold--;
    else if (inChord === 0 || this.voicing.length === 0) {
      this.voicing = voiceLead(this.voicing.length ? this.voicing : null, chordPcs(f, degree), MUSIC.padLo, MUSIC.padHi);
      this.root = chordPcs(f, degree)[0]!;
      ev.push({ kind: "chord", notes: this.voicing, root: this.root });
      this.melody = melodyPlays(phraseIdx) ? phrase(f, degree, phraseIdx, this.lastMelody, this.rand) : [];
      const last = this.melody[this.melody.length - 1];
      if (last) this.lastMelody = last.midi;
    }

    if (this.gates.bell)
      for (const n of this.melody)
        if (n.step === inChord) ev.push({ kind: "bell", midi: n.midi, len: n.len, vel: n.vel });

    if (this.gates.bass) {
      const root = this.hold > 0 ? f.tonic : bassRoot(f, degree);
      for (const h of bassBar(f, this.bassLevel))
        if (h.step === inBar) ev.push({ kind: "bass", midi: root + h.interval, len: h.len, vel: h.vel });
    }

    if (this.gates.drums) {
      const db = drumBar(f, this.drumLevel, bar);
      for (const [voice, steps] of Object.entries(db) as [DrumVoice, number[]][]) {
        const v = steps[inBar] ?? 0;
        if (v > 0) ev.push({ kind: "drum", voice, vel: v });
      }
    }

    if (this.gates.arp) {
      // the menu's arp is a slow 8th-note shimmer; battle runs 16ths
      const menu = mix.mode === "menu";
      if (!menu || inBar % 2 === 0) {
        const notes = arpBar(this.voicing, this.root, this.alarm);
        ev.push({ kind: "arp", midi: notes[inBar]!, vel: inBar % 4 === 0 ? 1 : 0.62 });
      }
    }

    this.step++;
    return ev;
  }
}

// ------------------------------------------------------------ stingers ---

/** The stingers: the finale's victory, defeat or draw (Robot Love), and the announced big moments. */
export type StingerKind = "victory" | "defeat" | "draw" | "epic" | "bad" | "good" | "first-blood";

/**
 * Which stinger an announcement earns (music.ts plays it at the next beat),
 * or null. Only lines at priority 2 or better get one: first blood its own,
 * 'epic' a rising call (an enemy Goliath or HQ destroyed), 'bad' a warning
 * stab (an enemy Goliath on the field, our HQ fallen), and 'good' only when
 * it is important. Kind-agnostic on purpose: a feature's banner tone and
 * priority are its music cue.
 */
export function stingerFor(a: Announcement): StingerKind | null {
  const p = a.priority ?? 2;
  if (p > 2) return null;
  if (/first.?blood/i.test(a.key)) return "first-blood";
  if (a.tone === "epic") return "epic";
  if (a.tone === "bad") return "bad";
  return a.tone === "good" && p <= 1 ? "good" : null;
}

export interface StingerNote {
  /** Start, in beats after the stinger's downbeat. */
  beat: number;
  /** Length in beats. */
  len: number;
  midi: number[];
  voice: "brass" | "lead" | "bell" | "tom" | "crash" | "swell";
  vel: number;
}

/** The notes of a stinger, in the flavour's key (`root` = current chord root pitch class). */
export function stinger(kind: StingerKind, f: Flavour, root: number): StingerNote[] {
  const t = f.tonic + 24; // brass register around the tonic, two octaves up
  const triad = (r: number, major = true) => [r, r + (major ? 4 : 3), r + 7];
  const r = t + mod12(root - f.tonic); // current chord root in the brass register
  const rr = r > t + 7 ? r - 12 : r;
  switch (kind) {
    case "victory": // I – IV – V – I fanfare in the tonic major
      return [
        { beat: 0, len: 0.42, midi: triad(t), voice: "brass", vel: 0.85 },
        { beat: 0, len: 0.5, midi: [t - 24], voice: "tom", vel: 0.9 },
        { beat: 0.5, len: 0.42, midi: triad(t + 5), voice: "brass", vel: 0.85 },
        { beat: 1, len: 0.9, midi: triad(t + 7), voice: "brass", vel: 0.95 },
        { beat: 1, len: 0.5, midi: [t - 24], voice: "tom", vel: 0.9 },
        { beat: 1, len: 1, midi: [], voice: "swell", vel: 0.6 },
        { beat: 2, len: 4, midi: [...triad(t), t + 12, t - 12], voice: "brass", vel: 1 },
        { beat: 2, len: 3, midi: [], voice: "crash", vel: 1 },
        { beat: 2, len: 0.5, midi: [t - 24], voice: "tom", vel: 1 },
        { beat: 2.5, len: 3.5, midi: [t + 19, t + 24, t + 28, t + 31], voice: "bell", vel: 0.6 }
      ];
    case "defeat": // a descending minor lament over a low tom
      return [
        { beat: 0, len: 1, midi: [t + 7], voice: "lead", vel: 0.8 },
        { beat: 0, len: 0.6, midi: [t - 24], voice: "tom", vel: 0.8 },
        { beat: 1, len: 1, midi: [t + 5], voice: "lead", vel: 0.75 },
        { beat: 2, len: 1, midi: [t + 3], voice: "lead", vel: 0.75 },
        { beat: 3, len: 1, midi: [t + 2], voice: "lead", vel: 0.7 },
        { beat: 4, len: 4, midi: [t], voice: "lead", vel: 0.8 },
        { beat: 4, len: 4, midi: [t - 12, t - 5, t + 3 - 12], voice: "brass", vel: 0.45 },
        { beat: 4, len: 0.8, midi: [t - 24], voice: "tom", vel: 0.9 }
      ];
    case "draw": // nobody won (Robot Love): bells rising sweetly over a soft held sixth chord; no fanfare, no lament, no drums
      return [
        { beat: 0, len: 1.5, midi: [], voice: "swell", vel: 0.3 },
        { beat: 0, len: 0.9, midi: [t + 16], voice: "bell", vel: 0.5 },
        { beat: 0.75, len: 0.9, midi: [t + 19], voice: "bell", vel: 0.5 },
        { beat: 1.5, len: 0.9, midi: [t + 21], voice: "bell", vel: 0.55 },
        { beat: 2.25, len: 4, midi: [t, t + 4, t + 9], voice: "brass", vel: 0.35 },
        { beat: 2.25, len: 3, midi: [t + 24, t + 28], voice: "bell", vel: 0.6 }
      ];
    case "epic": // a rising three-note call over a cymbal swell
      return [
        { beat: 0, len: 1, midi: [], voice: "swell", vel: 0.5 },
        { beat: 0, len: 0.45, midi: [rr], voice: "brass", vel: 0.7 },
        { beat: 0.5, len: 0.45, midi: [rr + 7], voice: "brass", vel: 0.75 },
        { beat: 1, len: 2.2, midi: [rr + 12, rr + 7, rr], voice: "brass", vel: 0.9 },
        { beat: 1, len: 2.2, midi: [rr + 24], voice: "bell", vel: 0.6 },
        { beat: 1, len: 2, midi: [], voice: "crash", vel: 0.7 },
        { beat: 1, len: 0.5, midi: [t - 24], voice: "tom", vel: 0.8 }
      ];
    case "bad": // two low stabs a semitone apart: trouble
      return [
        { beat: 0, len: 0.7, midi: [t - 12, t - 5], voice: "brass", vel: 0.8 },
        { beat: 0, len: 0.5, midi: [t - 24], voice: "tom", vel: 0.9 },
        { beat: 1, len: 1.4, midi: [t - 11, t - 4], voice: "brass", vel: 0.85 },
        { beat: 1, len: 0.5, midi: [t - 23], voice: "tom", vel: 0.9 },
        { beat: 1.5, len: 0.4, midi: [t - 23], voice: "tom", vel: 0.6 }
      ];
    case "good": // a light lift: fifth to octave
      return [
        { beat: 0, len: 0.5, midi: [rr + 19], voice: "bell", vel: 0.55 },
        { beat: 0.5, len: 1.5, midi: [rr + 24], voice: "bell", vel: 0.6 }
      ];
    case "first-blood": // a tom hit under a short rising stab
      return [
        { beat: 0, len: 0.5, midi: [t - 24], voice: "tom", vel: 1 },
        { beat: 0, len: 0.4, midi: [rr - 12, rr - 5], voice: "brass", vel: 0.7 },
        { beat: 0.5, len: 1.2, midi: [rr - 5, rr], voice: "brass", vel: 0.75 }
      ];
  }
}

// --------------------------------------------------------- coin tuning ---

/**
 * The income coin (audio.ts: E6 plus a fourth above) retuned into each
 * biome's key so a delivery streak climbs in harmony with the score: C or
 * Eb major pentatonic where the mode allows it; the phrygian-dominant
 * desert gets its own steps, chosen so both coin tones stay in the scale.
 */
export function coinKey(biome: Biome): { shift: number; steps: readonly number[] } {
  switch (biome) {
    case "temperate": // D dorian = the C major collection
    case "arctic": // F lydian, likewise
    case "tropical": // G mixolydian, likewise
      return { shift: -4, steps: [0, 2, 4, 7, 9, 12] };
    case "volcanic": // C aeolian = the Eb major collection
      return { shift: -1, steps: [0, 2, 4, 7, 9, 12] };
    case "desert": // E phrygian dominant
      return { shift: 0, steps: [0, 5, 7, 8, 12] };
  }
}

/** Pitch ratio for the coin on a delivery streak, in the biome's key (caps at the octave). */
export function coinPitchIn(biome: Biome, streak: number): number {
  const k = coinKey(biome);
  const i = Math.max(0, Math.min(k.steps.length - 1, streak));
  return Math.pow(2, (k.shift + k.steps[i]!) / 12);
}

// ---------------------------------------------------------------- mood ---

export interface MoodHooks {
  player: Faction;
  spectator: boolean;
  /** 0–1 loudness of a point (tiles) for the local listener; 0 out of earshot. */
  earshot(x: number, y: number): number;
  /** May the local player see this point (fog)? */
  sees(x: number, y: number): boolean;
  /** Faction of a live unit or building, if any. */
  factionOf(id: number): Faction | null;
  /** Would a strike of radius `r` at (x, y) catch any of our units or buildings? (Default: no.) */
  threatened?(x: number, y: number, r: number): boolean;
  /**
   * Is this unit of ours part of the base (awareness.ts baseGoliath: an
   * anchored Goliath, or any Goliath once the HQ is gone)? Hits on it raise
   * the base alarm like hits on a building. (Default: no.)
   */
  baseUnit?(id: number): boolean;
}

/**
 * Battle intensity for the score, from the sim's fx stream:
 *   I = clamp(audibleShots4s / 32 + 0.5·(base under sustained attack)
 *             + 0.25·min(1, ownLosses10s / 3) + strike, 0, 1),
 * where `strike` is the loudest calldown still ringing (an impact in
 * earshot, fading over 6 s: Barrage 0.45, Sky Hammer 0.85 — in full when it
 * lands on our things, at least half anywhere; an enemy reticle over our
 * things holds 0.35 until it lands). Floored at 0.3 while our units have
 * fought anywhere in the last 8 s (and from a Last Stand wave's warning
 * until it arrives), and smoothed with a quick attack and a slow release.
 * Spectators hear all on-screen combat (and on-screen deaths of either
 * side), with no alarm.
 */
export class BattleMood {
  /** Smoothed intensity, 0–1. */
  level = 0;
  private shots: { t: number; w: number }[] = [];
  private shotSum = 0;
  private deaths: number[] = [];
  private buildingHits: number[] = [];
  private buildingHitAt = -Infinity;
  private attackStart = -Infinity;
  private contactAt = -Infinity;
  /** Calldown boosts: start time, size, length (s); fading out, or held flat (a telegraph). */
  private strikes: { t: number; w: number; s: number; flat: boolean }[] = [];
  private waveUntil = -Infinity;
  private now = 0;

  constructor(private h: MoodHooks) {}

  /** Feed one sim tick's fx events at sim time `t` (seconds). */
  events(fx: readonly FxEvent[], t: number): void {
    this.now = t;
    const h = this.h;
    for (const e of fx) {
      switch (e.type) {
        case "shot": {
          const w = h.sees(e.x, e.y) || h.sees(e.tx, e.ty) ? h.earshot(e.x, e.y) : 0;
          if (w > 0.05) {
            this.shots.push({ t, w });
            this.shotSum += w;
          }
          if (!h.spectator && h.factionOf(e.sourceId) === h.player) this.contactAt = t;
          break;
        }
        case "hit":
          if (h.spectator ? e.building && h.sees(e.x, e.y) && h.earshot(e.x, e.y) > 0.3 : e.faction === h.player) {
            if (!h.spectator) this.contactAt = t;
            // (a Goliath that is our base, or our last life, sounds the alarm like a building)
            if (e.building || (!h.spectator && h.baseUnit?.(e.id))) this.buildingHit(t);
          }
          break;
        case "death":
          if (h.spectator ? h.sees(e.x, e.y) && h.earshot(e.x, e.y) > 0.3 : e.faction === h.player)
            this.deaths.push(t);
          break;
        case "calldown":
          // the reticle is up over our things: hold your breath (a Sky Hammer's charge is 3 s)
          if (!h.spectator && e.faction !== h.player && h.threatened?.(e.x, e.y, e.radius))
            this.strike(t, MUSIC.telegraphBoost, Math.max(0.5, e.landTick / TICK_RATE - t), true);
          break;
        case "calldownImpact": {
          // calldowns are public: no fog check, just how close it is (and whether it hit home)
          let k = h.earshot(e.x, e.y);
          if (e.power === "hammer") {
            k = Math.max(k, MUSIC.strikeHammerFloor);
            if (!h.spectator && h.threatened?.(e.x, e.y, e.radius)) k = 1;
          }
          if (k > 0.05) this.strike(t, MUSIC.strikeBoost[e.power] * k, MUSIC.strikeFadeS);
          break;
        }
        case "waveIncoming":
          this.waveUntil = Math.max(this.waveUntil, t + e.eta / TICK_RATE + MUSIC.waveHoldS);
          break;
      }
    }
  }

  private strike(t: number, w: number, s: number, flat = false): void {
    this.strikes.push({ t, w, s, flat });
    if (this.strikes.length > 12) this.strikes.shift();
  }

  /** The biggest calldown boost still ringing at `t` (they don't stack: three shells are one Barrage). */
  private strikeLevel(t: number): number {
    let best = 0;
    this.strikes = this.strikes.filter((b) => t - b.t <= b.s);
    for (const b of this.strikes) if (t >= b.t) best = Math.max(best, b.flat ? b.w : b.w * (1 - (t - b.t) / b.s));
    return best;
  }

  private buildingHit(t: number): void {
    const hits = this.buildingHits;
    hits.push(t);
    while (hits.length && t - hits[0]! > MUSIC.alarmWindowS) hits.shift();
    // a sustained attack (or one already running) keeps the alarm up
    const running = t - this.buildingHitAt <= MUSIC.buildingHitS;
    if (hits.length >= MUSIC.alarmHits || running) {
      if (!running) this.attackStart = t;
      this.buildingHitAt = t;
    }
  }

  /** Unsmoothed intensity at sim time `t`. */
  raw(t: number = this.now): number {
    const m = MUSIC;
    while (this.shots.length && t - this.shots[0]!.t > m.shotWindowS) this.shotSum -= this.shots.shift()!.w;
    while (this.deaths.length && t - this.deaths[0]! > m.deathWindowS) this.deaths.shift();
    if (!this.shots.length) this.shotSum = 0;
    const building = t - this.buildingHitAt <= m.buildingHitS ? (this.h.spectator ? 0.3 : m.buildingHitBoost) : 0;
    const deaths = m.deathBoost * Math.min(1, this.deaths.length / m.deathsForFull);
    const full = m.shotsForFull * (this.h.spectator ? m.spectatorShotScale : 1);
    const fight = this.shotSum / full + building + deaths + this.strikeLevel(t);
    const contact = !this.h.spectator && t - this.contactAt <= m.contactS ? m.contactFloor : 0;
    const wave = t <= this.waveUntil ? m.waveFloor : 0;
    return clamp01(Math.max(fight, contact, wave));
  }

  /**
   * Our base is under sustained attack: the alarm motif, for at most the
   * first alarmMaxS of each attack. Never for spectators.
   */
  alarm(t: number = this.now): boolean {
    return !this.h.spectator && t - this.buildingHitAt <= MUSIC.buildingHitS && t - this.attackStart <= MUSIC.alarmMaxS;
  }

  /** Advance the smoothing by `dt` real seconds; returns the new level. */
  update(dt: number, t: number = this.now): number {
    const target = this.raw(t);
    const tc = target > this.level ? MUSIC.attackS : MUSIC.releaseS;
    this.level += (target - this.level) * (1 - Math.exp(-Math.max(0, dt) / tc));
    return this.level;
  }
}
