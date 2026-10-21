/**
 * The adaptive procedural soundtrack. A lookahead scheduler on the
 * AudioContext clock (not setTimeout timing) asks the Composer (score.ts)
 * for each 16th step and synthesises it: a voice-led pad that is always
 * there, a calm melody while you build, a bass pulse once units are in
 * contact, drums when a fight is on screen and an arpeggio when it gets
 * intense (with a tritone alarm while your base is hit). Each biome has
 * its own mode, progression and timbres. Stingers mark victory, defeat and
 * announced big moments; the score is ducked by big sounds (audio.ts),
 * muffled while paused, and stops when the tab is hidden. A quiet biome
 * ambience bed (ambience.ts) rides under it.
 *
 * Budget: 8 persistent pad oscillators plus at most 10 transient voices
 * (14 during a stinger); drums and ambience reuse shared noise buffers.
 *
 * With the Belle Époque theme (theme.ts BELLE_EPOQUE) the score is
 * score-belle.ts's: a barrel-organ waltz on the menu, an accordion musette
 * waltz while it is calm and a military march once a fight is on, with
 * their own instruments below (accordion, organ pipes, fife, oom-pah
 * stabs, field drum, bass drum and cymbals).
 */
import type { Biome } from "../sim/types";
import { Ambience } from "./ambience";
import { onAnnounce, type Announcement } from "./announce";
import { sfx } from "./audio";
import { BelleComposer, belleLayerTargets } from "./score-belle";
import { BELLE_EPOQUE } from "./three/theme";
import {
  Composer,
  FLAVOURS,
  LAYERS,
  MUSIC,
  layerTargets,
  mtof,
  stinger,
  stingerFor,
  type BellKind,
  type DrumVoice,
  type Flavour,
  type MusicLayer,
  type MusicMode,
  type NoteEvent,
  type StingerKind
} from "./score";

/** Seconds of music scheduled ahead of the audio clock. */
const LOOKAHEAD = 0.2;
const TICK_MS = 25;
/** Mix level of each layer at full target. */
const LEVEL: Record<MusicLayer, number> = { pad: 0.17, bell: 0.32, bass: 0.26, drums: 0.85, arp: 0.42 };
/** Transient-voice budget by priority (stingers may use the top of it). */
const CAP = { stinger: 14, bass: 10, stab: 10, drums: 10, bell: 9, arp: 8 } as const;
const NOISE_CAP = 8;
/** Swing: odd 16ths of the hats and tabla land this fraction of a step late. */
const SWING = 0.1;

export interface MusicEngine {
  ctx: BaseAudioContext;
  /** Where the music mix goes (the music bus). */
  out: AudioNode;
  /** Shared white-noise buffer (≥ 2 s). */
  noise: AudioBuffer;
}

interface Graph {
  /** Start/stop fade. */
  fade: GainNode;
  /** Pause muffle. */
  muffle: BiquadFilterNode;
  /** Layers' sum, dipped under stingers. */
  bed: GainNode;
  level: Record<MusicLayer, GainNode>;
  gate: Record<MusicLayer, GainNode>;
  padFilter: BiquadFilterNode;
  padArtic: GainNode;
  bassFilter: BiquadFilterNode;
  bassShaper: WaveShaperNode;
  arpFilter: BiquadFilterNode;
  hatFilter: BiquadFilterNode;
  snareFilter: BiquadFilterNode;
  crashFilter: BiquadFilterNode;
  takFilter: BiquadFilterNode;
  /** The Belle Époque oom-pah's chord stabs (into the bass layer). */
  stabFilter: BiquadFilterNode;
  sting: GainNode;
  reverbSend: GainNode;
  reverb: ConvolverNode;
  delaySend: GainNode;
  delay: DelayNode;
  ambience: Ambience;
}

/** What the Music class needs from a composer (score.ts's, or score-belle.ts's). */
type ScoreComposer = Pick<
  Composer,
  "flavour" | "bpm" | "step" | "voicing" | "root" | "gates" | "stepSeconds" | "setBiome" | "closeGates" | "holdTonic" | "next"
>;

interface PadVoice {
  a: OscillatorNode;
  b: OscillatorNode;
}

export interface MusicInput {
  /** Smoothed battle intensity 0–1 (BattleMood). */
  intensity: number;
  /** Our base is under fire. */
  alarm: boolean;
  paused: boolean;
}

export class Music {
  private e: MusicEngine | null = null;
  private g: Graph | null = null;
  private mode: MusicMode | "off" = "off";
  private biome: Biome = "temperate";
  private enabled = true;
  private hidden = false;
  private running = false;
  private timer = 0;
  private composer: ScoreComposer;
  private nextTime = 0;
  private pad: PadVoice[] = [];
  private padFlavour: Flavour | null = null;
  private live = 0;
  private liveNoise = 0;
  private input: MusicInput = { intensity: 0, alarm: false, paused: false };
  private bumpLevel = 0;
  private bumpUntil = 0;
  private lastLevel: Partial<Record<MusicLayer, number>> = {};
  private lastPaused: boolean | null = null;
  private stingerUntil = 0;
  private lastStinger = -Infinity;
  private finished = false;
  /** A sound duel's link mode: the reverb send is cut (its convolver idles, and nothing smears into the guard). */
  private dry = false;
  /** The next start() comes in at full level (play's `downbeat`). */
  private downbeat = false;

  /**
   * `manual`: no internal timer; the caller drives pump() (offline renders).
   */
  constructor(
    private manual = false,
    /** The Belle Époque score and instruments (default: the theme's switch). */
    private belle: boolean = BELLE_EPOQUE
  ) {
    const seed = (Math.random() * 1e9) | 0;
    this.composer = belle ? new BelleComposer("temperate", seed) : new Composer(FLAVOURS.temperate, seed);
  }

  /** Hook up to an audio engine (once audio is unlocked). */
  attach(e: MusicEngine): void {
    if (this.e) return;
    this.e = e;
    this.sync();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.sync();
  }

  /** Link mode (sfx.linkMode): bypass the reverb send while a sound duel runs. */
  setLinkMode(on: boolean): void {
    if (on === this.dry) return;
    this.dry = on;
    const g = this.g;
    if (!g) return;
    if (on) g.reverbSend.disconnect(g.reverb);
    else g.reverbSend.connect(g.reverb);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!this.running || this.manual) return;
    if (hidden) this.clearTimer();
    else this.startTimer();
  }

  /**
   * Play the menu or battle score for a biome (switches on the next bar line).
   * `downbeat`: when this starts the music, it comes in at full level on its
   * first beat instead of fading in (the title screen's logo slam).
   */
  play(mode: "menu" | "battle", biome: Biome, downbeat = false): void {
    this.downbeat = downbeat;
    this.mode = mode;
    this.biome = biome;
    this.finished = false;
    this.composer.setBiome(biome);
    if (this.running && this.g && this.e) {
      if (mode === "battle") this.g.ambience.start(biome, this.e.ctx.currentTime + 0.5);
      else this.g.ambience.stop(this.e.ctx.currentTime);
    }
    this.sync();
  }

  stop(): void {
    this.mode = "off";
    this.sync();
  }

  /** Per-frame state from the game scene. */
  update(input: MusicInput): void {
    this.input = input;
    if (this.manual) return;
    // the params themselves are refreshed by the scheduler tick
  }

  /**
   * The match ended: resolve into a victory fanfare, a defeat lament or, when
   * nobody won (Robot Love's draw), a sweet sting on the tonic major, and
   * settle on a quiet coda. Returns false when music is off (play the SFX
   * jingle instead).
   *
   * `love: false` is a draw that isn't Robot Love's (a sound duel's two
   * resigns on one tick, SOUND-DUEL.md "Resign"), or a duel that ended with no
   * result (GameScene.abort): the score settles on the held tonic and its
   * coda with no sting, since the love sting would tell of hearts that never
   * showed. Victory and defeat don't change with it.
   */
  finale(kind: "victory" | "defeat" | "draw", o: { love?: boolean } = {}): boolean {
    if (this.finished) return true;
    if (!this.running || !this.e || !this.g) return false;
    this.finished = true;
    this.mode = "end";
    const t = this.nextBeat(0.04);
    this.renderEvents(this.composer.closeGates(), t);
    this.renderChord(this.composer.holdTonic(kind !== "defeat", 64), t, true);
    if (kind !== "draw" || o.love !== false) this.playStinger(kind, t, true);
    this.g.ambience.stop(t + 2);
    return true;
  }

  /** Play a stinger at the next beat (announced big moments; other systems may call it). */
  sting(kind: StingerKind): void {
    if (!this.running || !this.e || this.finished || this.mode !== "battle") return;
    const now = this.e.ctx.currentTime;
    if (now < this.stingerUntil || now - this.lastStinger < 3.5) return;
    this.playStinger(kind, this.nextBeat(0.03), false);
  }

  /** Announcements: 'epic' lines get a rising call, 'bad' ones a warning stab (and raise the tension). */
  announced(a: Announcement): void {
    const kind = stingerFor(a);
    if (!kind) return;
    if (kind === "bad" && this.e) {
      this.bumpLevel = 0.4;
      this.bumpUntil = this.e.ctx.currentTime + 8;
    }
    this.sting(kind);
  }

  /** Debug/test view of the live state. */
  get state(): {
    running: boolean;
    mode: string;
    biome: Biome;
    bpm: number;
    step: number;
    intensity: number;
    gates: Record<MusicLayer, boolean>;
    voices: number;
    noise: number;
  } {
    return {
      running: this.running,
      mode: this.mode,
      biome: this.composer.flavour.biome,
      bpm: this.composer.bpm,
      step: this.composer.step,
      intensity: this.effectiveIntensity(),
      gates: { ...this.composer.gates },
      voices: this.live + (this.g?.ambience.live ?? 0),
      noise: this.liveNoise
    };
  }

  // ------------------------------------------------------------ control ---

  private sync(): void {
    const want = !!this.e && this.enabled && this.mode !== "off";
    if (want && !this.running) this.start();
    else if (!want && this.running) this.halt();
  }

  private start(): void {
    const e = this.e!;
    if (!this.g) this.g = this.build(e);
    const g = this.g;
    const now = e.ctx.currentTime;
    this.running = true;
    g.fade.gain.cancelScheduledValues(now);
    g.fade.gain.setValueAtTime(g.fade.gain.value, now);
    g.fade.gain.setTargetAtTime(1, now, this.downbeat ? 0.015 : 0.6);
    this.downbeat = false;
    this.startPad(now);
    if (this.mode === "battle") g.ambience.start(this.biome, now + 0.3);
    this.nextTime = now + 0.08;
    this.lastLevel = {};
    this.lastPaused = null;
    if (!this.manual && !this.hidden) this.startTimer();
  }

  private halt(): void {
    const e = this.e!;
    const g = this.g!;
    const now = e.ctx.currentTime;
    this.running = false;
    this.clearTimer();
    g.fade.gain.cancelScheduledValues(now);
    g.fade.gain.setValueAtTime(g.fade.gain.value, now);
    g.fade.gain.setTargetAtTime(0, now, 0.12);
    for (const v of this.pad) {
      v.a.stop(now + 0.8);
      v.b.stop(now + 0.8);
    }
    this.pad = [];
    g.ambience.stop(now);
  }

  private startTimer(): void {
    this.clearTimer();
    this.timer = window.setInterval(() => this.pump(), TICK_MS);
    this.pump();
  }

  private clearTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private effectiveIntensity(): number {
    const now = this.e?.ctx.currentTime ?? 0;
    return Math.max(this.input.intensity, now < this.bumpUntil ? this.bumpLevel : 0);
  }

  /** The time of the next beat at least `lead` seconds from now. */
  private nextBeat(lead: number): number {
    const now = this.e!.ctx.currentTime;
    const sec = this.composer.stepSeconds;
    // nextTime is the start of composer.step; beats fall every 4 steps
    let t = this.nextTime - (this.composer.step % 4) * sec;
    while (t < now + lead) t += 4 * sec;
    return t;
  }

  /** Schedule everything up to the lookahead horizon (called every 25 ms, or by an offline driver). */
  pump(): void {
    const e = this.e;
    const g = this.g;
    if (!e || !g || !this.running) return;
    const now = e.ctx.currentTime;
    this.updateParams(now);
    // fell far behind (a stalled main thread): skip ahead rather than cram
    if (this.nextTime < now - 0.5) this.nextTime = now + 0.02;
    const horizon = now + LOOKAHEAD;
    let guard = 64;
    while (this.nextTime < horizon && guard-- > 0) {
      const t = this.nextTime;
      const step = this.composer.step;
      const ev = this.composer.next({
        mode: this.mode === "off" ? "battle" : this.mode,
        intensity: this.effectiveIntensity(),
        alarm: this.input.alarm
      });
      // a step that is already late keeps its state changes but drops its notes
      this.renderEvents(t < now - 0.01 ? ev.filter((x) => x.kind === "gate" || x.kind === "chord") : ev, Math.max(t, now), step);
      this.nextTime = t + this.composer.stepSeconds;
    }
    g.ambience.tick(horizon);
  }

  private updateParams(now: number): void {
    const g = this.g!;
    const mode = this.mode === "off" ? "battle" : this.mode;
    const I = this.effectiveIntensity();
    const tg = (this.belle ? belleLayerTargets : layerTargets)(mode, I, this.input.alarm && mode === "battle");
    for (const l of LAYERS) {
      const v = tg[l] * LEVEL[l];
      const last = this.lastLevel[l];
      if (last !== undefined && Math.abs(v - last) < 0.004) continue;
      this.lastLevel[l] = v;
      g.level[l].gain.setTargetAtTime(v, now, last === undefined ? 0.05 : 0.5);
    }
    if (this.lastPaused !== this.input.paused) {
      this.lastPaused = this.input.paused;
      const p = this.input.paused;
      g.muffle.frequency.setTargetAtTime(p ? 420 : 18000, now, p ? 0.12 : 0.3);
      g.bed.gain.setTargetAtTime(p ? 0.75 : 1, now, 0.2);
    }
    g.ambience.duck(mode === "battle" ? I : 1, now);
  }

  // -------------------------------------------------------------- graph ---

  private build(e: MusicEngine): Graph {
    const c = e.ctx;
    const gain = (v: number, to?: AudioNode) => {
      const n = c.createGain();
      n.gain.value = v;
      if (to) n.connect(to);
      return n;
    };
    const filter = (type: BiquadFilterType, f: number, q: number, to?: AudioNode) => {
      const n = c.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      if (to) n.connect(to);
      return n;
    };
    const fade = gain(0, e.out);
    const muffle = filter("lowpass", 18000, 0.7, fade);
    const mix = gain(1, muffle);
    const bed = gain(1, mix);
    const sting = gain(1, mix);

    // space: a short generated reverb and a dotted-8th echo
    const reverb = c.createConvolver();
    reverb.buffer = impulse(c, 2.2);
    const reverbSend = gain(1);
    reverb.connect(gain(0.32, mix));
    if (!this.dry) reverbSend.connect(reverb);
    sting.connect(gain(0.35, reverbSend));
    const delay = c.createDelay(1.5);
    delay.delayTime.value = (60 / MUSIC.battleBpm) * 0.75;
    const delaySend = gain(1);
    const fb = gain(0.3);
    const fbTone = filter("lowpass", 2600, 0.5);
    delaySend.connect(delay);
    delay.connect(fbTone).connect(fb).connect(delay);
    fbTone.connect(gain(0.45, mix));

    const level = {} as Record<MusicLayer, GainNode>;
    const gate = {} as Record<MusicLayer, GainNode>;
    for (const l of LAYERS) {
      gate[l] = gain(l === "pad" ? 1 : 0, bed);
      level[l] = gain(0);
      level[l].connect(gate[l]);
    }
    gate.pad.connect(gain(0.45, reverbSend));
    gate.bell.connect(gain(0.5, reverbSend));
    gate.bell.connect(gain(this.belle ? 0.1 : 0.35, delaySend));
    gate.arp.connect(gain(0.3, reverbSend));
    gate.arp.connect(gain(this.belle ? 0.12 : 0.4, delaySend));
    gate.drums.connect(gain(0.08, reverbSend));

    const padArtic = gain(1, level.pad);
    const padFilter = filter("lowpass", 900, 0.7, padArtic);
    const bassShaper = c.createWaveShaper();
    bassShaper.connect(level.bass);
    const bassFilter = filter("lowpass", 380, 2, bassShaper);
    const arpFilter = filter("lowpass", 2200, 1.5, level.arp);
    const hatFilter = filter("highpass", 7000, 0.7, level.drums);
    // (the field drum's snares are brighter and tighter than a kit snare)
    const snareFilter = this.belle ? filter("bandpass", 2600, 0.9, level.drums) : filter("bandpass", 1700, 0.55, level.drums);
    const crashFilter = filter("highpass", 4200, 0.5, level.drums);
    const takFilter = filter("bandpass", 2600, 2.5, level.drums);
    const stabFilter = filter("lowpass", 1500, 0.7, level.bass);
    const ambience = new Ambience(c, gain(1, muffle), this.belle);
    return {
      fade, muffle, bed, level, gate, padFilter, padArtic, bassFilter, bassShaper, arpFilter,
      hatFilter, snareFilter, crashFilter, takFilter, stabFilter, sting, reverbSend, reverb, delaySend, delay, ambience
    };
  }

  /** (Re)create the pad's persistent oscillators for the current flavour and voicing. */
  private startPad(at: number): void {
    const c = this.e!.ctx;
    const g = this.g!;
    const f = this.composer.flavour;
    this.padFlavour = f;
    this.applyFlavour(f, at);
    const voicing = this.composer.voicing.length ? this.composer.voicing : [50, 57, 62, 65];
    this.pad = voicing.map((m, i) => {
      const a = c.createOscillator();
      const b = c.createOscillator();
      a.type = f.pad.a;
      b.type = f.pad.b;
      a.frequency.value = mtof(m);
      b.frequency.value = mtof(m) * f.pad.bRatio;
      a.detune.value = -f.pad.detune;
      b.detune.value = f.pad.detune;
      const ga = c.createGain();
      ga.gain.value = 0.25;
      const gb = c.createGain();
      gb.gain.value = f.pad.bRatio > 1 ? 0.1 : 0.2;
      let sink: AudioNode = g.padFilter;
      if ("createStereoPanner" in c) {
        const p = c.createStereoPanner();
        p.pan.value = [-0.45, 0.15, -0.15, 0.45][i] ?? 0;
        p.connect(g.padFilter);
        sink = p;
      }
      a.connect(ga).connect(sink);
      b.connect(gb).connect(sink);
      a.start(at);
      b.start(at);
      return { a, b };
    });
  }

  /** Biome timbre settings on the persistent nodes. */
  private applyFlavour(f: Flavour, at: number): void {
    const g = this.g!;
    g.padFilter.frequency.setTargetAtTime(f.pad.cutoff, at, 0.3);
    g.padFilter.Q.setValueAtTime(f.pad.q, at);
    g.bassFilter.frequency.setValueAtTime(f.bass.cutoff, at);
    g.bassShaper.curve = f.bass.drive > 0 ? driveCurve(f.bass.drive) : null;
    g.delay.delayTime.setValueAtTime((60 / MUSIC.battleBpm) * 0.75, at);
    for (const v of this.pad) {
      v.a.type = f.pad.a;
      v.b.type = f.pad.b;
      v.a.detune.setValueAtTime(-f.pad.detune, at);
      v.b.detune.setValueAtTime(f.pad.detune, at);
    }
  }

  // ------------------------------------------------------------- render ---

  private renderEvents(ev: readonly NoteEvent[], t: number, step = 0): void {
    const g = this.g!;
    const f = this.composer.flavour;
    if (f !== this.padFlavour) {
      this.padFlavour = f;
      this.applyFlavour(f, t);
    }
    const sec = this.composer.stepSeconds;
    const swung = step % 2 === 1 ? t + SWING * sec : t;
    for (const x of ev) {
      switch (x.kind) {
        case "gate":
          g.gate[x.layer].gain.setTargetAtTime(x.on ? 1 : 0, t, x.on ? 0.03 : 0.6);
          break;
        case "chord":
          this.renderChord(x, t, false);
          break;
        case "bass":
          this.bass(t, x.midi, x.len * sec, x.vel);
          break;
        case "bell":
          this.bell(t, f.bell, x.midi, Math.max(0.5, x.len * sec), x.vel * (this.mode === "menu" ? 0.8 : 1));
          break;
        case "arp":
          this.arp(t, x.midi, x.vel);
          break;
        case "drum":
          this.drum(x.voice === "hat" || x.voice === "open" || x.voice === "tak" ? swung : t, x.voice, x.vel);
          break;
        case "stab":
          this.stab(t, x.notes, x.len * sec, x.vel);
          break;
      }
    }
    // the arp brightens with the alarm and with intensity
    if (step % 16 === 0) {
      const open = this.input.alarm && this.mode === "battle" ? 4200 : this.mode === "menu" ? 1300 : 1900 + 1200 * this.effectiveIntensity();
      g.arpFilter.frequency.setTargetAtTime(open, t, 0.4);
    }
  }

  private renderChord(x: { notes: number[] }, t: number, cancel: boolean): void {
    const g = this.g!;
    const f = this.composer.flavour;
    x.notes.forEach((m, i) => {
      const v = this.pad[i];
      if (!v) return;
      if (cancel) {
        v.a.frequency.cancelScheduledValues(t);
        v.b.frequency.cancelScheduledValues(t);
      }
      v.a.frequency.setTargetAtTime(mtof(m), t, 0.09);
      v.b.frequency.setTargetAtTime(mtof(m) * f.pad.bRatio, t, 0.09);
    });
    // each chord breathes: a small dip into the change, then a filter bloom
    const art = g.padArtic.gain;
    art.setTargetAtTime(0.78, Math.max(0, t - 0.12), 0.04);
    art.setTargetAtTime(1, t, 0.5);
    const cut = g.padFilter.frequency;
    cut.setTargetAtTime(f.pad.cutoff * 0.55, Math.max(0, t - 0.1), 0.05);
    cut.setTargetAtTime(f.pad.cutoff, t, 0.9);
  }

  /** Book a transient oscillator if the budget allows it. */
  private osc(prio: keyof typeof CAP, type: OscillatorType, freq: number, t: number, end: number): OscillatorNode | null {
    if (this.live >= CAP[prio]) return null;
    const o = this.e!.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    o.stop(end);
    this.live++;
    o.onended = () => {
      this.live--;
      o.disconnect();
    };
    return o;
  }

  private noiseSrc(t: number, end: number, rate = 1): AudioBufferSourceNode | null {
    if (this.liveNoise >= NOISE_CAP) return null;
    const s = this.e!.ctx.createBufferSource();
    s.buffer = this.e!.noise;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * 0.5, end - t + 0.02);
    this.liveNoise++;
    s.onended = () => {
      this.liveNoise--;
      s.disconnect();
    };
    return s;
  }

  /** An exponential envelope gain: quick attack to `peak`, decay to silence by `end`. */
  private env(t: number, peak: number, attack: number, end: number, to: AudioNode, hold = 0): GainNode {
    const gn = this.e!.ctx.createGain();
    const p = gn.gain;
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    if (hold > 0) p.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
    p.exponentialRampToValueAtTime(0.0001, end);
    gn.connect(to);
    return gn;
  }

  private bass(t: number, midi: number, dur: number, vel: number): void {
    const g = this.g!;
    const f = this.composer.flavour;
    const end = t + Math.max(0.12, dur * 0.92);
    const o = this.osc("bass", f.bass.wave, mtof(midi), t, end + 0.02);
    if (!o) return;
    o.connect(this.env(t, 0.55 * vel * (1 - 0.45 * f.bass.drive), 0.006, end, g.bassFilter, Math.max(0, dur * 0.92 - 0.12)));
    // a pluck on the shared filter (bass notes never overlap)
    const cut = g.bassFilter.frequency;
    const base = this.input.alarm && this.mode === "battle" ? f.bass.cutoff * 1.6 : f.bass.cutoff;
    cut.setTargetAtTime(base * 2.6, t, 0.004);
    cut.setTargetAtTime(base, t + 0.02, 0.07);
  }

  private bell(t: number, kind: BellKind, midi: number, dur: number, vel: number): void {
    const g = this.g!;
    const out = g.level.bell;
    const fr = mtof(midi);
    switch (kind) {
      case "pluck": {
        // kalimba-ish: a triangle with a quick bright octave partial
        const end = t + Math.min(1.8, dur + 0.7);
        const o = this.osc("bell", "triangle", fr, t, end);
        if (!o) return;
        o.connect(this.env(t, 0.5 * vel, 0.004, end, out));
        const o2 = this.osc("bell", "sine", fr * 2, t, t + 0.3);
        o2?.connect(this.env(t, 0.16 * vel, 0.003, t + 0.28, out));
        break;
      }
      case "oud": {
        // plucked saw through a closing filter, sliding into pitch
        const end = t + Math.min(1.2, dur + 0.35);
        const o = this.osc("bell", "sawtooth", fr, t, end);
        if (!o) return;
        o.detune.setValueAtTime(-40, t);
        o.detune.setTargetAtTime(0, t, 0.02);
        const lp = this.e!.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 3;
        lp.frequency.setValueAtTime(3400, t);
        lp.frequency.exponentialRampToValueAtTime(650, t + 0.22);
        o.connect(lp).connect(this.env(t, 0.5 * vel, 0.004, end, out));
        break;
      }
      case "glass": {
        // FM bell: sine carrier, inharmonic modulator with a decaying index
        const end = t + Math.min(2.6, dur + 1.4);
        const o = this.osc("bell", "sine", fr, t, end);
        if (!o) return;
        const m = this.osc("bell", "sine", fr * 3.5, t, end);
        if (m) {
          const idx = this.e!.ctx.createGain();
          idx.gain.setValueAtTime(fr * 1.4, t);
          idx.gain.exponentialRampToValueAtTime(fr * 0.05, t + 0.9);
          m.connect(idx).connect(o.frequency);
        }
        o.connect(this.env(t, 0.34 * vel, 0.003, end, out));
        break;
      }
      case "pan": {
        // steel pan: a sine with a short octave and a metallic third-harmonic strike,
        // blooming down into pitch
        const end = t + Math.min(1.6, dur + 0.9);
        const o = this.osc("bell", "sine", fr, t, end);
        if (!o) return;
        o.detune.setValueAtTime(18, t);
        o.detune.setTargetAtTime(0, t, 0.013);
        o.connect(this.env(t, 0.42 * vel, 0.003, end, out));
        const o2 = this.osc("bell", "sine", fr * 2, t, t + 0.5);
        o2?.connect(this.env(t, 0.2 * vel, 0.003, t + 0.48, out));
        const o3 = this.osc("bell", "sine", fr * 3, t, t + 0.12);
        o3?.connect(this.env(t, 0.08 * vel, 0.002, t + 0.11, out));
        break;
      }
      case "accordion": {
        // two reeds tuned apart (the musette's beating), a slow swell of the bellows
        const end = t + dur * 0.95 + 0.12;
        const lp = this.e!.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = Math.min(4200, fr * 5);
        lp.Q.value = 0.7;
        lp.connect(this.env(t, 0.26 * vel, 0.025, end, out, Math.max(0, dur * 0.95 - 0.05)));
        const a = this.osc("bell", "square", fr, t, end);
        if (!a) return;
        a.detune.value = -8;
        a.connect(lp);
        const b = this.osc("bell", "sawtooth", fr, t, end);
        if (b) {
          b.detune.value = 13;
          b.connect(lp);
        }
        break;
      }
      case "organ": {
        // a flute pipe and its octave; the accents ring a glockenspiel too
        const end = t + dur * 0.9 + 0.08;
        const o = this.osc("bell", "triangle", fr, t, end);
        if (!o) return;
        o.connect(this.env(t, 0.42 * vel, 0.018, end, out, Math.max(0, dur * 0.9 - 0.04)));
        const o2 = this.osc("bell", "sine", fr * 2, t, end);
        o2?.connect(this.env(t, 0.12 * vel, 0.02, end, out, Math.max(0, dur * 0.9 - 0.04)));
        if (vel >= 0.95) {
          const gl = this.osc("bell", "sine", fr * 4, t, t + 0.5);
          gl?.connect(this.env(t, 0.06, 0.002, t + 0.48, out));
        }
        break;
      }
      case "fife": {
        // a fife an octave up: a breathy triangle with a little vibrato's worth of detune
        const end = t + dur * 0.85 + 0.06;
        const o = this.osc("bell", "triangle", fr * 2, t, end);
        if (!o) return;
        o.detune.setValueAtTime(-15, t);
        o.detune.setTargetAtTime(0, t, 0.03);
        o.connect(this.env(t, 0.2 * vel, 0.02, end, out, Math.max(0, dur * 0.85 - 0.04)));
        const o2 = this.osc("bell", "sine", fr * 4, t, end);
        o2?.connect(this.env(t, 0.03 * vel, 0.02, end, out));
        break;
      }
      case "marimba": {
        // wooden: a sine with a short 4th-harmonic knock
        const end = t + Math.min(1.1, dur + 0.4);
        const o = this.osc("bell", "sine", fr, t, end);
        if (!o) return;
        o.connect(this.env(t, 0.55 * vel, 0.003, end, out));
        const k = this.osc("bell", "sine", fr * 4, t, t + 0.09);
        k?.connect(this.env(t, 0.2 * vel, 0.002, t + 0.08, out));
        break;
      }
    }
  }

  /** The "pah" of the Belle Époque oom-pah: a short chord in the style's instrument. */
  private stab(t: number, notes: readonly number[], dur: number, vel: number): void {
    const f = this.composer.flavour;
    const end = t + Math.max(0.08, dur);
    const peak = (f.bell === "fife" ? 0.3 : f.bell === "organ" ? 0.3 : 0.22) * vel;
    const wave: OscillatorType = f.bell === "fife" ? "sawtooth" : f.bell === "organ" ? "triangle" : "square";
    let env: GainNode | null = null;
    for (const m of notes) {
      const o = this.osc("stab", wave, mtof(m), t, end + 0.01);
      if (!o) break;
      env ??= this.env(t, peak / Math.sqrt(notes.length), 0.008, end, this.g!.stabFilter, Math.max(0, dur * 0.5));
      if (f.bell === "accordion") o.detune.value = 9;
      o.connect(env);
    }
  }

  private arp(t: number, midi: number, vel: number): void {
    const f = this.composer.flavour;
    const end = t + 0.2;
    const o = this.osc("arp", f.arp, mtof(midi), t, end);
    if (!o) return;
    const peak = (f.arp === "sine" ? 0.75 : f.arp === "triangle" ? 0.6 : 0.5) * vel;
    o.connect(this.env(t, peak, 0.004, end, this.g!.arpFilter));
  }

  private drum(t: number, voice: DrumVoice, vel0: number, out?: AudioNode): void {
    const g = this.g!;
    const vel = vel0 * (0.9 + Math.random() * 0.18);
    const dest = out ?? g.level.drums;
    if (this.belle && this.belleDrum(t, voice, vel, dest, out)) return;
    switch (voice) {
      case "kick": {
        const o = this.osc("drums", "sine", 210, t, t + 0.34);
        if (!o) return;
        o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
        o.connect(this.env(t, 0.95 * vel, 0.002, t + 0.32, dest));
        // the beater click is what a phone speaker actually plays
        const n = this.noiseSrc(t, t + 0.02);
        n?.connect(this.env(t, 0.32 * vel, 0.001, t + 0.014, g.takFilter));
        break;
      }
      case "snare": {
        const n = this.noiseSrc(t, t + 0.2);
        n?.connect(this.env(t, 0.85 * vel, 0.002, t + 0.18, g.snareFilter));
        const o = this.osc("drums", "triangle", 240, t, t + 0.1);
        if (o) {
          o.frequency.exponentialRampToValueAtTime(170, t + 0.08);
          o.connect(this.env(t, 0.45 * vel, 0.002, t + 0.09, dest));
        }
        break;
      }
      case "hat":
      case "open": {
        const len = voice === "open" ? 0.2 : 0.04;
        const n = this.noiseSrc(t, t + len + 0.01, 1.3);
        n?.connect(this.env(t, (voice === "open" ? 0.2 : 0.3) * vel, 0.001, t + len, g.hatFilter));
        break;
      }
      case "tak": {
        const o = this.osc("drums", "sine", 660, t, t + 0.09);
        if (o) {
          o.frequency.exponentialRampToValueAtTime(600, t + 0.06);
          o.connect(this.env(t, 0.28 * vel, 0.001, t + 0.08, dest));
        }
        const n = this.noiseSrc(t, t + 0.03);
        n?.connect(this.env(t, 0.25 * vel, 0.001, t + 0.025, g.takFilter));
        break;
      }
      case "dhum": {
        // the tabla's bass drum bends up as the palm presses
        const o = this.osc("drums", "sine", 105, t, t + 0.45);
        if (!o) return;
        o.frequency.exponentialRampToValueAtTime(150, t + 0.25);
        o.connect(this.env(t, 0.6 * vel, 0.004, t + 0.42, dest));
        break;
      }
      case "tom": {
        const o = this.osc(out ? "stinger" : "drums", "sine", 180, t, t + 0.5);
        if (!o) return;
        o.frequency.exponentialRampToValueAtTime(82, t + 0.32);
        o.connect(this.env(t, 0.8 * vel, 0.003, t + 0.48, dest));
        break;
      }
      case "crash": {
        const n = this.noiseSrc(t, t + 1.8, 0.9);
        n?.connect(this.env(t, 0.2 * vel, 0.003, t + 1.7, out ? this.highpass(out) : g.crashFilter));
        break;
      }
    }
  }

  /** The march's band percussion; false for voices it leaves to drum(). */
  private belleDrum(t: number, voice: DrumVoice, vel: number, dest: AudioNode, out?: AudioNode): boolean {
    const g = this.g!;
    switch (voice) {
      case "kick": {
        // the bass drum (grosse caisse): a soft felt beater, a long low boom
        const o = this.osc("drums", "sine", 120, t, t + 0.5);
        if (!o) return true;
        o.frequency.exponentialRampToValueAtTime(52, t + 0.16);
        o.connect(this.env(t, 1.1 * vel, 0.004, t + 0.46, dest));
        const n = this.noiseSrc(t, t + 0.04);
        n?.connect(this.env(t, 0.18 * vel, 0.002, t + 0.03, g.takFilter));
        return true;
      }
      case "snare": {
        // the field drum: a crisp head and long rattling snares
        const n = this.noiseSrc(t, t + 0.16);
        n?.connect(this.env(t, 1.0 * vel, 0.001, t + 0.15, g.snareFilter));
        const o = this.osc("drums", "triangle", 220, t, t + 0.06);
        if (o) {
          o.frequency.exponentialRampToValueAtTime(160, t + 0.05);
          o.connect(this.env(t, 0.35 * vel, 0.001, t + 0.05, dest));
        }
        return true;
      }
      case "roll": {
        // a buzz roll over a beat and a half, swelling into the next downbeat
        const len = this.composer.stepSeconds * 6;
        const n = this.noiseSrc(t, t + len + 0.05);
        if (!n) return true;
        const gn = this.e!.ctx.createGain();
        const p = gn.gain;
        p.setValueAtTime(0, t);
        const stroke = 1 / 26;
        for (let k = 0, at = t; at < t + len; k++, at += stroke) {
          p.setValueAtTime((0.22 + 0.45 * ((at - t) / len)) * vel * (k % 2 ? 0.8 : 1), at);
          p.setTargetAtTime(0.04 * vel, at + 0.004, 0.01);
        }
        p.setValueAtTime(0, t + len);
        n.connect(gn).connect(g.snareFilter);
        return true;
      }
      case "cym":
      case "crash": {
        // clash cymbals: a bright splash that dies quickly (a stinger's crash rings longer)
        const len = voice === "crash" ? (out ? 1.4 : 0.9) : 0.45;
        const n = this.noiseSrc(t, t + len + 0.05, 1.1);
        n?.connect(this.env(t, (voice === "crash" ? 0.22 : 0.16) * vel, 0.002, t + len, out ? this.highpass(out) : g.crashFilter));
        return true;
      }
    }
    return false;
  }

  private highpass(to: AudioNode): BiquadFilterNode {
    const hp = this.e!.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4200;
    hp.connect(to);
    return hp;
  }

  // ----------------------------------------------------------- stingers ---

  private playStinger(kind: StingerKind, t: number, finale: boolean): void {
    const g = this.g!;
    const c = this.e!.ctx;
    const f = this.composer.flavour;
    const beat = 60 / this.composer.bpm;
    const notes = stinger(kind, f, this.composer.root);
    const len = Math.max(...notes.map((n) => n.beat + n.len)) * beat;
    this.lastStinger = t;
    this.stingerUntil = t + len;
    // the bed steps back under the stinger
    g.bed.gain.setTargetAtTime(finale ? 0.6 : 0.55, t - 0.02, 0.05);
    g.bed.gain.setTargetAtTime(this.input.paused ? 0.75 : 1, t + len * 0.8, finale ? 1.5 : 0.4);
    const level = kind === "good" ? 0.6 : 1;
    for (const n of notes) {
      const at = t + n.beat * beat;
      const dur = n.len * beat;
      const vel = n.vel * level;
      switch (n.voice) {
        case "brass":
          this.brass(at, n.midi, dur, vel);
          break;
        case "lead":
          for (const m of n.midi) this.lead(at, m, dur, vel);
          break;
        case "bell":
          for (const m of n.midi) {
            const o = this.osc("stinger", "sine", mtof(m), at, at + dur + 1.2);
            o?.connect(this.env(at, 0.12 * vel, 0.004, at + dur + 1.2, g.sting));
          }
          break;
        case "tom":
          this.drum(at, "tom", vel, g.sting);
          break;
        case "crash":
          this.drum(at, "crash", vel, g.sting);
          break;
        case "swell": {
          // a reversed-cymbal rise into the next downbeat
          const s = this.noiseSrc(at, at + dur, 0.8);
          if (!s) break;
          const gn = c.createGain();
          gn.gain.setValueAtTime(0.0001, at);
          gn.gain.exponentialRampToValueAtTime(0.16 * vel, at + dur * 0.97);
          gn.gain.linearRampToValueAtTime(0, at + dur);
          s.connect(gn).connect(this.highpass(g.sting));
          break;
        }
      }
    }
  }

  /** A brass stab/chord: saws through one swelling lowpass. */
  private brass(t: number, midis: readonly number[], dur: number, vel: number): void {
    const c = this.e!.ctx;
    const g = this.g!;
    const end = t + dur + 0.25;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.07);
    lp.frequency.setTargetAtTime(1300, t + 0.1, 0.25);
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime((0.2 * vel) / Math.sqrt(Math.max(1, midis.length)), t + 0.04);
    amp.gain.setValueAtTime((0.17 * vel) / Math.sqrt(Math.max(1, midis.length)), t + dur);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);
    lp.connect(amp).connect(g.sting);
    midis.forEach((m, i) => {
      const o = this.osc("stinger", "sawtooth", mtof(m), t, end + 0.02);
      if (!o) return;
      o.detune.value = (i % 2 ? 1 : -1) * 6;
      o.connect(lp);
    });
  }

  /** A singing lead line (the lament): saw + vibrato through a soft filter. */
  private lead(t: number, midi: number, dur: number, vel: number): void {
    const c = this.e!.ctx;
    const g = this.g!;
    const end = t + dur + 0.3;
    const o = this.osc("stinger", "sawtooth", mtof(midi), t, end);
    if (!o) return;
    const vib = this.osc("stinger", "sine", 5.2, t, end);
    if (vib) {
      const depth = c.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(14, t + Math.min(0.6, dur));
      vib.connect(depth).connect(o.detune);
    }
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1500;
    lp.Q.value = 0.7;
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.24 * vel, t + 0.08);
    amp.gain.setValueAtTime(0.21 * vel, t + dur);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(lp).connect(amp).connect(g.sting);
  }
}

/** A stereo reverb impulse: decaying, gently darkening noise. */
function impulse(c: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len;
      // one-pole lowpass that closes as the tail decays
      const a = 0.65 - 0.5 * k;
      lp = lp + a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - k, 3.2);
    }
  }
  return buf;
}

/** Soft-clip curve for the volcanic bass. */
function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const k = 1 + drive * 9;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/** The game's soundtrack, wired to the shared audio engine and settings. */
export const music = new Music();

sfx.onReady((e) => music.attach({ ctx: e.ctx, out: e.musicIn, noise: e.noise }));
sfx.onChange(() => {
  music.setEnabled(sfx.enabled("music"));
  music.setLinkMode(sfx.linkMode);
});
music.setEnabled(sfx.enabled("music"));
music.setLinkMode(sfx.linkMode);
onAnnounce((a) => music.announced(a));
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => music.setHidden(document.hidden));
