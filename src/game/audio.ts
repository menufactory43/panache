/**
 * Procedural sound effects: every sound is synthesised with WebAudio
 * (filtered noise bursts, oscillator sweeps) — zero audio assets to load.
 * Voices are rate-limited per sound and capped overall so a big battle
 * stays a rumble rather than a wall of clipping noise.
 *
 * The engine also owns the shared AudioContext and the mix: three buses
 * (sfx, music, voice) feed one master gain and the glue compressor. The
 * adaptive score (music.ts) and the announcer play into their own buses,
 * each with its own on/off setting, persisted with the master mute.
 *
 * During a sound duel the mix also wears the link guard (SOUND-DUEL.md
 * "Game audio guard", setLinkGuard): the game must not play into the bands
 * the phones' modems use, nor play so loud that the speaker's distortion and
 * a crowded microphone smear the phone's own transmission into the band it
 * listens to. While it is on, the chain is
 *
 *   master → high-pass 300 Hz → guard gain → limiter → { dry | FIR } → destination
 *
 * where the limiter is the glue compressor re-set (GUARD_LIMITER) and the
 * FIR the plan's guard low-pass (guard-fir.ts) in a ConvolverNode. Off, the
 * chain is master → glue compressor → destination again, node for node.
 *
 * Where the spec is silent:
 *  - the guard gain also takes back the limiter's makeup gain. Web Audio
 *    gives every DynamicsCompressorNode an automatic makeup of
 *    (1 / curve(1))^0.6, about +17 dB at GUARD_LIMITER's −30 dB threshold, so
 *    a plain −10 dB cut in front of it would leave sounds under the limiter
 *    7 dB louder than without the guard. With it taken back, the cut is the
 *    net change for everything the limiter leaves alone (a cut of 0 really
 *    is unchanged), and the limiter's ceiling (steady sound
 *    held near −13 dBFS whatever the cut; transients overshoot it by a few
 *    dB) bounds the rest;
 *  - turning the guard on sets linkMode and turning it off clears it (the
 *    rematch boot sets linkMode on its own, before any context exists);
 *  - setLinkGuard before unlock() is remembered and applied when the
 *    context is made. The guard is built before anything is rewired, so a
 *    browser that can't build it keeps the original chain; setLinkGuard
 *    then throws, unlock() logs it and starts audio anyway (the music and
 *    the announcer still attach);
 *  - when the guard comes on, the cut applies at once and the limiter takes
 *    over GUARD_SWITCH later. The compressor delays its input 6 ms (its
 *    look-ahead): switched together, the sound already in that delay, still
 *    uncut, would come out with the limiter's +17 dB makeup, a burst 16 dB
 *    louder than what was playing. In between, the glue compressor plays the
 *    cut sound (16–26 dB down for 60 ms; the Duel tap has just stopped the
 *    music). The dry and FIR paths, a plan change and a new cut move over
 *    50 ms; off, the FIR fades to dry over 50 ms and the original chain is
 *    put back 60 ms later (the reverse switch plays the delay's cut sound at
 *    the glue's makeup: a 6 ms dip, never a burst);
 *  - a context too slow to play into the plan's stopband (16 kHz, a
 *    Bluetooth headset's call route, for the high plan) gets the identity
 *    for its FIR (guard-fir.ts): its own Nyquist is the guard.
 */
import { BELLE_RECIPES } from "./audio-belle";
import { guardFir, type GuardPlan } from "./guard-fir";
import { BELLE_EPOQUE } from "./three/theme";

export type SfxName =
  | "cannon" | "heavy" | "mg" | "flak" | "rocket" | "missile" | "laser" | "shell" | "bomb"
  | "explosion" | "bigExplosion" | "build" | "ready" | "click" | "alert" | "heal" | "rank" | "sell"
  | "victory" | "defeat"
  | "kill" | "lost" | "coin"
  | "inbound"
  | "deny" | "squad"
  | "siren" | "emp" | "pod" | "hammer" | "charge" | "uplink"
  | "capture" | "uplinkLost" | "drop" | "crate"
  | "rifle" | "snipe" | "crush" | "clank" | "thrust"
  | "anchor" | "packup" | "stomp" | "topple" | "offline" | "reboot" | "weld" | "rollout" | "hook" | "love"
  // the nations' weapons and the Zénith (Belle Époque recipes in audio-belle.ts; the original style borrows the nearest)
  | "arcShell" | "heavyShell" | "arcBolt" | "flak47" | "zenithDrone";

export type AudioChannel = "sfx" | "music" | "voice";

/** Player audio settings: a master mute plus one switch per bus. */
export interface AudioSettings {
  muted: boolean;
  music: boolean;
  sfx: boolean;
  voice: boolean;
  /** The announcer speaks (speechSynthesis); off = "chirps only": unit voices and radio codes, no words. */
  speech: boolean;
}

export const AUDIO_SETTINGS_KEY = "battledrones.audio";
/** Pre-music builds stored only a master mute flag here. */
const LEGACY_MUTE_KEY = "battledrones.muted";

/** Parse stored settings (tolerating junk), falling back to the legacy mute flag. */
export function parseAudioSettings(raw: string | null, legacyMuted: string | null = null): AudioSettings {
  const s: AudioSettings = { muted: legacyMuted === "1", music: true, sfx: true, voice: true, speech: true };
  if (!raw) return s;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof AudioSettings, unknown>> | null;
    if (o && typeof o === "object")
      for (const k of ["muted", "music", "sfx", "voice", "speech"] as const) if (typeof o[k] === "boolean") s[k] = o[k];
  } catch {
    /* corrupt entry: defaults */
  }
  return s;
}

const MASTER_GAIN = 0.55;
/** Bus levels under the master: music ships at 60% so it sits under the battle. */
const BUS_GAIN: Record<AudioChannel, number> = { sfx: 1, music: 0.6, voice: 1 };

/** A DynamicsCompressorNode's settings. */
export interface CompressorSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

/** The glue compressor: gentle compression that glues overlapping battle sounds together (knee, attack and release at Web Audio's defaults). */
export const GLUE: Readonly<CompressorSettings> = { threshold: -18, knee: 30, ratio: 4, attack: 0.003, release: 0.25 };

export type { GuardPlan } from "./guard-fir";

/**
 * The link guard's level cut (dB) for everything the limiter leaves alone
 * (SOUND-DUEL.md "Game audio guard" > Cut): the same on every phone and in
 * both microphone modes. An iPhone plays a play-and-record session's sound
 * from the loudspeaker beside its microphone, not the earpiece: WebKit sets
 * DefaultToSpeaker on every such session (AudioSessionIOS.mm, Safari 17 on;
 * later versions leave it off only for a page that picked the receiver
 * through setSinkId, which this one never does), and echo cancellation off
 * only swaps the voice-processing unit for a plain one.
 */
export const GUARD_CUT_DB = 10;

/**
 * The glue compressor's settings while the guard is on: a limiter (hard knee,
 * the largest ratio Web Audio allows). A loud battle 20 dB louder still,
 * with no cut, comes out of the FIR at −21 dBFS RMS and −8 dBFS peaks, where
 * the room model still delivers every packet with the own path at +40 dB
 * (tests/link-guard.test.ts, which has the other settings measured; game
 * audio around −17 dBFS RMS after the guard is where fast packets start to
 * go). The loud battle itself, with the 10 dB cut, plays at −38 dBFS RMS.
 */
export const GUARD_LIMITER: Readonly<CompressorSettings> = { threshold: -30, knee: 0, ratio: 20, attack: 0.002, release: 0.15 };

/** The guard's high-pass corner (Hz): the bass a phone speaker can't play only drives its distortion and the limiter. */
export const GUARD_HIGHPASS_HZ = 300;

/** The dry/FIR crossfade (s). */
const GUARD_FADE = 0.05;

/**
 * When the guard comes on, the limiter takes over this long after the cut
 * (s): the compressor's 6 ms look-ahead must have flushed the uncut sound
 * first, with room for the slack between the currentTime the page reads and
 * the audio thread's own (an audio callback or two; Firefox's main thread
 * reads a clock tens of milliseconds behind), since the cut lands whenever
 * the audio thread next looks while the switch is scheduled on the clock.
 * Modelled (tests/link-guard.test.ts), the switch stays clean while the cut
 * lands up to GUARD_SWITCH − 6 ms late.
 */
const GUARD_SWITCH = 0.06;

/**
 * The automatic makeup gain (dB) Web Audio applies in a hard-knee
 * DynamicsCompressorNode: (1 / curve(1))^0.6, where curve(1) for a signal at
 * full scale is threshold · (1 − 1/ratio) dB. (A soft knee's curve is the
 * implementation's own; the guard only uses a hard one.)
 */
export function compressorMakeupDb(c: Pick<CompressorSettings, "threshold" | "ratio">): number {
  return 0.6 * Math.max(0, -c.threshold) * (1 - 1 / c.ratio);
}

/** Options for setLinkGuard. */
export interface LinkGuardOptions {
  /** The cut (dB, default GUARD_CUT_DB, which the duel uses everywhere; others are for measurements). */
  cutDb?: number;
}

/** The guard's own nodes, between the master and the destination. */
interface GuardNodes {
  hp: BiquadFilterNode;
  cut: GainNode;
  dry: GainNode;
  /** One FIR per plan, made on first use, each behind its fade gain. */
  fir: Partial<Record<GuardPlan, { conv: ConvolverNode; gain: GainNode }>>;
  /** The restore after the fade-out, while one is pending. */
  restore: ReturnType<typeof setTimeout> | null;
}

/** What the music and voice layers need from the engine once audio is unlocked. */
export interface AudioEngine {
  ctx: AudioContext;
  /** Connect music here: it passes the duck stage and the Music on/off level. */
  musicIn: AudioNode;
  /** Connect announcer lines here (the Voice on/off level). */
  voiceIn: AudioNode;
  /** Shared 2 s white-noise buffer. */
  noise: AudioBuffer;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Record<AudioChannel, GainNode> | null = null;
  /** Music passes through this before its bus level; ducked by big sounds and voice lines. */
  private duckNode: GainNode | null = null;
  private duckUntil = 0;
  private noise: AudioBuffer | null = null;
  private last = new Map<SfxName, number>();
  private voices = 0;
  /** Game speed (awareness lane): battle sounds space out at 1.5–4×. */
  private tempo = 1;
  private readyFns = new Set<(e: AudioEngine) => void>();
  private changeFns = new Set<(s: AudioSettings) => void>();
  private wantUnlock = false;
  /** The glue compressor (the limiter while the guard is on). */
  private comp: DynamicsCompressorNode | null = null;
  private guard: GuardNodes | null = null;
  /** What setLinkGuard asked for (applied at unlock when there was no context yet). */
  private guardWant: { plan: GuardPlan; cutDb: number } | null = null;
  private link = false;
  readonly settings: AudioSettings;

  constructor() {
    let raw: string | null = null;
    let legacy: string | null = null;
    try {
      raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
      legacy = localStorage.getItem(LEGACY_MUTE_KEY);
    } catch {
      /* ignore */
    }
    this.settings = parseAudioSettings(raw, legacy);
    if (typeof document !== "undefined") {
      // a hidden tab makes no sound and burns no battery; come back on return
      document.addEventListener("visibilitychange", () => {
        if (!this.ctx) return;
        if (document.hidden) void this.ctx.suspend();
        else void this.ctx.resume();
      });
      // Touch browsers only count pointerup/touchend (not pointerdown) as a
      // gesture that may start audio, and iOS can leave the context
      // suspended or "interrupted" after a call or an app switch: on every
      // gesture, create (once asked to) or resume the context until it runs
      const wake = () => {
        if (document.hidden) return;
        // creating the context outside an activating gesture leaves it suspended (and warns)
        const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (ua && !ua.isActive) return;
        if (!this.ctx) {
          if (this.wantUnlock) this.unlock();
        } else if (this.ctx.state !== "running") void this.ctx.resume();
      };
      // the events that count as a user gesture: mouse down, touch/pen up, keys
      for (const ev of ["mousedown", "pointerup", "touchend", "keydown"])
        window.addEventListener(ev, wake, { capture: true, passive: true });
    }
  }

  /** Master mute (one tap): silences every bus. */
  get muted(): boolean {
    return this.settings.muted;
  }

  /** The live engine, once unlock() has created it. */
  get engine(): AudioEngine | null {
    if (!this.ctx || !this.buses || !this.duckNode || !this.noise) return null;
    return { ctx: this.ctx, musicIn: this.duckNode, voiceIn: this.buses.voice, noise: this.noise };
  }

  /**
   * A bus's input, for sounds built outside the recipes (the title screen's
   * projector and fanfare, audio-title.ts): its level follows the player's
   * switches and the master mute. Null until audio is unlocked.
   */
  bus(ch: AudioChannel): AudioNode | null {
    return this.buses?.[ch] ?? null;
  }

  /**
   * A copy of the mix as heard (after the glue compressor), for a recording:
   * the highlight reel's film (ui/reel.ts). Null before audio starts, or
   * where the browser can't make one. stop() lets it go.
   */
  capture(): { track: MediaStreamTrack; stop(): void } | null {
    const ctx = this.ctx;
    const comp = this.comp;
    if (!ctx || !comp || typeof ctx.createMediaStreamDestination !== "function") return null;
    const dest = ctx.createMediaStreamDestination();
    comp.connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    const stop = () => {
      try {
        comp.disconnect(dest);
      } catch {
        /* already rewired (the link guard) */
      }
      track?.stop();
    };
    if (!track) {
      stop();
      return null;
    }
    return { track, stop };
  }

  /** Is this bus audible right now (not muted and switched on)? */
  enabled(ch: AudioChannel): boolean {
    return !this.settings.muted && this.settings[ch];
  }

  /** Start audio on the next user gesture (menu music, a rematch that skipped the menu). */
  unlockOnGesture(): void {
    this.wantUnlock = true;
  }

  /** Must be called from a user gesture (browsers block autoplay). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.settings.muted ? 0 : MASTER_GAIN;
    // gentle compression glues overlapping battle sounds together
    const comp = this.ctx.createDynamicsCompressor();
    setCompressor(comp, GLUE);
    this.comp = comp;
    this.master.connect(comp).connect(this.ctx.destination);
    const bus = (ch: AudioChannel) => {
      const g = this.ctx!.createGain();
      g.gain.value = this.settings[ch] ? BUS_GAIN[ch] : 0;
      g.connect(this.master!);
      return g;
    };
    this.buses = { sfx: bus("sfx"), music: bus("music"), voice: bus("voice") };
    this.duckNode = this.ctx.createGain();
    this.duckNode.connect(this.buses.music);
    const len = this.ctx.sampleRate * 2; // 2 s: longer than any sound + its random offset
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    try {
      // a guard asked for before audio started (the rematch boot)
      if (this.guardWant) this.applyGuard();
    } catch (err) {
      // the chain stays as it was; audio, the music and the announcer still start
      console.warn("link guard failed:", err);
    }
    const e = this.engine!;
    for (const fn of this.readyFns) fn(e);
  }

  /**
   * Link mode (a sound duel, from the Duel tap or the rematch boot until the
   * player leaves): no spoken lines (the announcer, radioCheck and the speech
   * priming skip speech; entering it cancels any line mid-word) and the
   * music skips its reverb. Transient: never saved. Changing it notifies
   * onChange subscribers.
   */
  get linkMode(): boolean {
    return this.link;
  }

  set linkMode(on: boolean) {
    if (on === this.link) return;
    this.link = on;
    if (on && typeof window !== "undefined") {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    }
    for (const fn of this.changeFns) fn(this.settings);
  }

  /**
   * The sound link's band guard (SOUND-DUEL.md "Game audio guard"): on with
   * the link's band plan, off with null. On, it also turns linkMode on; off
   * turns it off. Safe to call before unlock() (applied when audio starts),
   * and again with another plan or cut while on (both move over 50 ms).
   */
  setLinkGuard(plan: GuardPlan | null, opts: LinkGuardOptions = {}): void {
    this.guardWant = plan ? { plan, cutDb: Math.max(0, opts.cutDb ?? GUARD_CUT_DB) } : null;
    this.linkMode = plan !== null;
    this.applyGuard();
  }

  /** The guard's current state: its plan, or null when off (or fading out). */
  get linkGuard(): GuardPlan | null {
    return this.guardWant?.plan ?? null;
  }

  private applyGuard(): void {
    const ctx = this.ctx;
    const master = this.master;
    const comp = this.comp;
    if (!ctx || !master || !comp) return;
    const want = this.guardWant;
    const now = ctx.currentTime;
    const fade = (p: AudioParam, to: number) => {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(to, now + GUARD_FADE);
    };
    let g = this.guard;
    if (!want) {
      if (!g || g.restore !== null) return;
      // fade to dry, then put the original chain back
      fade(g.dry.gain, 1);
      for (const f of Object.values(g.fir)) fade(f.gain.gain, 0);
      const nodes = g;
      g.restore = setTimeout(() => {
        if (this.guard !== nodes) return;
        this.guard = null;
        master.disconnect();
        nodes.hp.disconnect();
        nodes.cut.disconnect();
        comp.disconnect();
        nodes.dry.disconnect();
        for (const f of Object.values(nodes.fir)) {
          f.conv.disconnect();
          f.gain.disconnect();
        }
        setCompressor(comp, GLUE);
        master.connect(comp).connect(ctx.destination);
      }, (GUARD_FADE + 0.01) * 1000);
      return;
    }
    const cutLevel = Math.pow(10, -(want.cutDb + compressorMakeupDb(GUARD_LIMITER)) / 20);
    // the plan's FIR (once per plan) before anything is rewired: if it fails, the chain stays as it was
    let made: { conv: ConvolverNode; gain: GainNode } | null = null;
    if (!g?.fir[want.plan]) {
      const taps = guardFir(ctx.sampleRate, want.plan);
      const conv = ctx.createConvolver();
      // before the buffer: a buffer set while normalize is on is rescaled for good
      conv.normalize = false;
      const buf = ctx.createBuffer(1, taps.length, ctx.sampleRate);
      buf.copyToChannel(taps, 0);
      conv.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      conv.connect(gain).connect(ctx.destination);
      made = { conv, gain };
    }
    if (!g) {
      // master → high-pass → cut → limiter → dry (fading to the FIR below) → destination
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = GUARD_HIGHPASS_HZ;
      // Butterworth: a lowpass/highpass Q is in dB in Web Audio (−3.01 dB is 1/√2)
      hp.Q.value = -3.0103;
      const cut = ctx.createGain();
      cut.gain.value = cutLevel;
      const dry = ctx.createGain();
      dry.gain.value = 1;
      master.disconnect();
      comp.disconnect();
      master.connect(hp).connect(cut).connect(comp);
      comp.connect(dry).connect(ctx.destination);
      // the cut is in now; the limiter (and its makeup) once the look-ahead holds only cut sound
      setCompressor(comp, GUARD_LIMITER, now + GUARD_SWITCH);
      g = { hp, cut, dry, fir: {}, restore: null };
      this.guard = g;
    } else {
      if (g.restore !== null) {
        clearTimeout(g.restore);
        g.restore = null;
      }
      fade(g.cut.gain, cutLevel);
    }
    if (made) {
      comp.connect(made.conv);
      g.fir[want.plan] = made;
    }
    fade(g.dry.gain, 0);
    for (const [plan, f] of Object.entries(g.fir)) fade(f.gain.gain, plan === want.plan ? 1 : 0);
  }

  /** Run `fn` with the engine as soon as audio is unlocked (now, if it already is). */
  onReady(fn: (e: AudioEngine) => void): () => void {
    this.readyFns.add(fn);
    const e = this.engine;
    if (e) fn(e);
    return () => this.readyFns.delete(fn);
  }

  /** Subscribe to settings changes (mute or any bus switch). */
  onChange(fn: (s: AudioSettings) => void): () => void {
    this.changeFns.add(fn);
    return () => this.changeFns.delete(fn);
  }

  setMuted(m: boolean): void {
    this.settings.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.05);
    this.saved();
  }

  /** Switch one bus (Music / SFX / Voice) on or off. */
  setChannel(ch: AudioChannel, on: boolean): void {
    this.settings[ch] = on;
    if (this.buses && this.ctx) this.buses[ch].gain.setTargetAtTime(on ? BUS_GAIN[ch] : 0, this.ctx.currentTime, 0.08);
    this.saved();
  }

  /** Announcer words on/off (off leaves unit chirps and radio codes on the voice bus). */
  setSpeech(on: boolean): void {
    this.settings.speech = on;
    this.saved();
  }

  private saved(): void {
    try {
      localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(this.settings));
      localStorage.removeItem(LEGACY_MUTE_KEY);
    } catch {
      /* ignore */
    }
    for (const fn of this.changeFns) fn(this.settings);
  }

  /**
   * Duck the music by `db` decibels for `seconds` (then recover over ~0.4 s):
   * big explosions, alarms and announcer lines cut through the score.
   */
  duck(db: number, seconds: number): void {
    const ctx = this.ctx;
    const node = this.duckNode;
    if (!ctx || !node) return;
    const now = ctx.currentTime;
    const g = node.gain;
    const level = Math.pow(10, -Math.abs(db) / 20);
    // a deeper or longer duck may extend a running one, never cut it short
    const until = Math.max(this.duckUntil, now + seconds);
    this.duckUntil = until;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(Math.min(level, g.value), now, 0.03);
    g.setTargetAtTime(1, until, 0.4);
  }

  /** Game speed: at k× the sim makes k× the shots, so battle sounds' minimum gaps stretch by k. */
  setTempo(k: number): void {
    this.tempo = Math.max(1, k);
  }

  /**
   * Play a sound at volume `vol` (0–1, already distance-attenuated by the
   * caller). `pitch` scales the recipe's frequencies where it supports it.
   */
  play(name: SfxName, vol = 1, pitch = 1): void {
    const ctx = this.ctx;
    // (`!(vol >= …)` also turns away NaN, which an AudioParam would throw on)
    if (!ctx || !this.buses || !this.enabled("sfx") || !(vol >= 0.03)) return;
    const now = ctx.currentTime;
    const minGap = (GAP[name] ?? 0.05) * (BATTLE.has(name) ? this.tempo : 1);
    if (now - (this.last.get(name) ?? -1) < minGap) return;
    // feedback cues keep two reserved voices so a loud battle can't swallow them
    if (this.voices > (PRIORITY.has(name) ? 16 : this.tempo > 1 ? 11 : 14)) return;
    this.last.set(name, now);
    const duck = DUCKS[name];
    if (duck && vol >= 0.25) this.duck(duck[0] * Math.min(1, vol), duck[1]);
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(this.buses.sfx);
    this.voices++;
    const dur = sfxRecipe(name)(ctx, out, now, this.noise!, pitch);
    setTimeout(() => {
      this.voices--;
      out.disconnect();
    }, (dur + 0.1) * 1000);
  }
}

/**
 * Set a compressor's settings: at `at` (context time) when given, else now,
 * dropping any change still scheduled (the guard's switch to the limiter, when
 * it is turned off again before the switch).
 */
function setCompressor(c: DynamicsCompressorNode, s: Readonly<CompressorSettings>, at?: number): void {
  for (const k of ["threshold", "knee", "ratio", "attack", "release"] as const) {
    const p = c[k];
    if (at !== undefined) p.setValueAtTime(s[k], at);
    else {
      p.cancelScheduledValues(0);
      p.value = s[k];
    }
  }
}

/** Sounds that duck the music: [dB, seconds]. */
const DUCKS: Partial<Record<SfxName, [number, number]>> = {
  bigExplosion: [6, 0.6],
  heavyShell: [4, 0.5],
  alert: [5, 0.6],
  inbound: [5, 0.7],
  victory: [6, 1.2],
  defeat: [6, 1.2],
  topple: [6, 0.9],
  love: [5, 1.2]
};

const GAP: Partial<Record<SfxName, number>> = {
  mg: 0.07, flak: 0.06, cannon: 0.05, laser: 0.06, explosion: 0.06, heal: 0.4, alert: 3, click: 0.02,
  kill: 0.08, lost: 0.08, coin: 0.1, inbound: 2,
  deny: 0.25, squad: 0.1,
  siren: 1.6, emp: 0.25, pod: 0.3, hammer: 0.6, charge: 1, uplink: 0.2,
  capture: 0.8, uplinkLost: 0.8, drop: 2, crate: 0.3,
  rifle: 0.06, snipe: 0.12, crush: 0.15, clank: 0.07, thrust: 0.3,
  anchor: 0.8, packup: 1, stomp: 0.18, topple: 0.6, offline: 0.4, reboot: 0.6, weld: 1.4, rollout: 2, hook: 0.6, love: 2,
  arcShell: 0.08, heavyShell: 0.3, arcBolt: 0.08, flak47: 0.08, zenithDrone: 1.2
};

/** Weapon and impact sounds: these thin out at faster game speeds (setTempo). */
const BATTLE = new Set<SfxName>([
  "cannon", "heavy", "mg", "flak", "rocket", "missile", "laser", "shell", "bomb", "explosion", "bigExplosion", "heal", "rifle", "snipe", "crush", "clank", "stomp", "weld",
  "arcShell", "heavyShell", "arcBolt", "flak47"
]);

/** Short feedback cues that may use the reserved voices above the battle cap. */
const PRIORITY = new Set<SfxName>(["kill", "lost", "coin", "alert", "inbound"]);

type Recipe = (ctx: BaseAudioContext, out: AudioNode, t: number, noise: AudioBuffer, pitch: number) => number;

/**
 * The recipe for a sound: the Belle Époque one (audio-belle.ts) when that
 * theme is on and has one, else the original. Exported for offline renders.
 */
export function sfxRecipe(name: SfxName, belle: boolean = BELLE_EPOQUE): Recipe {
  return (belle && BELLE_RECIPES[name]) || RECIPES[name];
}

function noiseBurst(
  ctx: BaseAudioContext, out: AudioNode, t: number, noise: AudioBuffer,
  dur: number, filter: BiquadFilterType, freq: number, gain: number, freqEnd?: number
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.4, dur + 0.05);
}

function tone(
  ctx: BaseAudioContext, out: AudioNode, t: number, type: OscillatorType,
  f0: number, f1: number, dur: number, gain: number, delay = 0
): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t + delay);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + delay + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t + delay);
  g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
  o.connect(g).connect(out);
  o.start(t + delay);
  o.stop(t + delay + dur + 0.02);
}

const RECIPES: Record<SfxName, Recipe> = {
  // a Trooper volley: a ragged crackle of light rifle shots
  rifle: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.03, "bandpass", 2800, 0.3);
    noiseBurst(c, o, t + 0.045, n, 0.025, "bandpass", 3300, 0.22);
    noiseBurst(c, o, t + 0.1, n, 0.03, "bandpass", 2500, 0.18);
    return 0.14;
  },
  // the rail rifle: a hard crack and a falling electric zing
  snipe: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.05, "highpass", 3000, 0.6);
    tone(c, o, t, "sine", 3400, 900, 0.2, 0.09);
    tone(c, o, t, "sawtooth", 150, 60, 0.12, 0.16);
    return 0.22;
  },
  // a Mastodon grinding robots under its tracks: crunch and scrape
  crush: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.18, "lowpass", 900, 0.6, 200);
    noiseBurst(c, o, t + 0.03, n, 0.08, "bandpass", 2400, 0.3);
    tone(c, o, t, "square", 220, 90, 0.1, 0.05);
    return 0.2;
  },
  // a robot hits the ground
  clank: (c, o, t, n) => {
    tone(c, o, t, "triangle", 900, 640, 0.08, 0.08);
    noiseBurst(c, o, t, n, 0.04, "highpass", 3000, 0.16);
    return 0.1;
  },
  // a dropship's lift fans gusting as squads drop or climb aboard
  thrust: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.35, "bandpass", 400, 0.35, 1400);
    tone(c, o, t, "sine", 120, 80, 0.3, 0.14);
    return 0.38;
  },
  cannon: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.12, "lowpass", 2200, 0.5, 300);
    tone(c, o, t, "sine", 160, 50, 0.12, 0.5);
    return 0.15;
  },
  heavy: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.3, "lowpass", 1400, 0.8, 120);
    tone(c, o, t, "sine", 110, 32, 0.3, 0.9);
    return 0.32;
  },
  mg: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.04, "highpass", 1800, 0.35);
    noiseBurst(c, o, t + 0.06, n, 0.04, "highpass", 1800, 0.3);
    return 0.12;
  },
  flak: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.06, "bandpass", 1300, 0.6);
    noiseBurst(c, o, t + 0.08, n, 0.06, "bandpass", 1100, 0.5);
    return 0.16;
  },
  rocket: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.28, "bandpass", 600, 0.45, 2400);
    return 0.3;
  },
  missile: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.4, "bandpass", 500, 0.4, 3000);
    tone(c, o, t, "triangle", 900, 1500, 0.2, 0.05);
    return 0.42;
  },
  laser: (c, o, t) => {
    tone(c, o, t, "sawtooth", 1400, 180, 0.16, 0.12);
    tone(c, o, t, "sine", 2200, 600, 0.12, 0.12);
    return 0.18;
  },
  shell: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.25, "lowpass", 900, 0.8, 80);
    tone(c, o, t, "sine", 90, 40, 0.25, 0.8);
    return 0.28;
  },
  bomb: (c, o, t) => {
    tone(c, o, t, "sine", 1100, 350, 0.35, 0.08);
    return 0.36;
  },
  explosion: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.6, "lowpass", 1600, 0.9, 90);
    tone(c, o, t, "sine", 90, 28, 0.45, 0.8);
    return 0.62;
  },
  bigExplosion: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 1.4, "lowpass", 1200, 1, 50);
    noiseBurst(c, o, t + 0.12, n, 1.0, "lowpass", 700, 0.7, 60);
    tone(c, o, t, "sine", 70, 22, 1.1, 1);
    return 1.45;
  },
  build: (c, o, t) => {
    tone(c, o, t, "triangle", 520, 520, 0.12, 0.25);
    tone(c, o, t, "triangle", 780, 780, 0.18, 0.25, 0.1);
    return 0.3;
  },
  ready: (c, o, t) => {
    tone(c, o, t, "sine", 660, 660, 0.1, 0.22);
    tone(c, o, t, "sine", 990, 990, 0.16, 0.22, 0.09);
    return 0.28;
  },
  click: (c, o, t) => {
    tone(c, o, t, "square", 1800, 900, 0.03, 0.06);
    return 0.05;
  },
  alert: (c, o, t) => {
    tone(c, o, t, "square", 880, 880, 0.12, 0.12);
    tone(c, o, t, "square", 660, 660, 0.12, 0.12, 0.16);
    tone(c, o, t, "square", 880, 880, 0.12, 0.12, 0.32);
    return 0.46;
  },
  heal: (c, o, t) => {
    tone(c, o, t, "sine", 700, 1100, 0.25, 0.05);
    return 0.26;
  },
  rank: (c, o, t) => {
    tone(c, o, t, "triangle", 660, 660, 0.1, 0.2);
    tone(c, o, t, "triangle", 880, 880, 0.1, 0.2, 0.08);
    tone(c, o, t, "triangle", 1320, 1320, 0.2, 0.2, 0.16);
    return 0.38;
  },
  sell: (c, o, t) => {
    tone(c, o, t, "triangle", 900, 450, 0.2, 0.2);
    return 0.22;
  },
  victory: (c, o, t) => {
    [523, 659, 784, 1046].forEach((f, i) => tone(c, o, t, "triangle", f, f, 0.35, 0.25, i * 0.14));
    return 1;
  },
  defeat: (c, o, t) => {
    [392, 330, 262, 196].forEach((f, i) => tone(c, o, t, "triangle", f, f * 0.98, 0.4, 0.25, i * 0.2));
    return 1.2;
  },
  // an enemy died where you can see it: a bright two-note "ting" over a metal crunch
  kill: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.06, "highpass", 2600, 0.25);
    tone(c, o, t, "sine", 1600, 1580, 0.09, 0.17);
    tone(c, o, t, "sine", 2400, 2380, 0.13, 0.15, 0.04);
    return 0.2;
  },
  // one of yours died: a low power-down whine
  lost: (c, o, t) => {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.35);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.24, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
    osc.connect(f).connect(g).connect(o);
    osc.start(t);
    osc.stop(t + 0.38);
    tone(c, o, t, "sine", 210, 45, 0.34, 0.2);
    return 0.4;
  },
  // scrap delivered: a coin blip whose pitch climbs on a delivery streak
  coin: (c, o, t, _n, p) => {
    tone(c, o, t, "triangle", 1320 * p, 1320 * p, 0.06, 0.1);
    tone(c, o, t, "triangle", 1760 * p, 1760 * p, 0.14, 0.1, 0.04);
    tone(c, o, t, "sine", 3520 * p, 3520 * p, 0.08, 0.025, 0.04);
    return 0.2;
  },
  // enemies approaching your base: two rising siren whoops (unlike the beeping "alert" for damage)
  inbound: (c, o, t) => {
    for (let i = 0; i < 2; i++) {
      tone(c, o, t, "sawtooth", 440, 990, 0.24, 0.06, i * 0.28);
      tone(c, o, t, "triangle", 440, 990, 0.24, 0.14, i * 0.28);
    }
    return 0.56;
  },
  // that can't go there: a short low buzz (placement refused)
  deny: (c, o, t) => {
    tone(c, o, t, "square", 140, 132, 0.12, 0.11);
    tone(c, o, t, "square", 147, 140, 0.12, 0.05);
    return 0.14;
  },
  // squad saved: two quick rising chirps
  squad: (c, o, t) => {
    tone(c, o, t, "triangle", 880, 1320, 0.07, 0.16);
    tone(c, o, t, "triangle", 1320, 1980, 0.09, 0.14, 0.07);
    return 0.18;
  },
  // ---- commander calldowns (powers) ----
  // air-raid wail: two detuned saws sweeping up and down, softened
  siren: (c, o, t) => {
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1700;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11, t + 0.12);
    g.gain.setValueAtTime(0.11, t + 1.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    f.connect(g).connect(o);
    for (const detune of [0, 7]) {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.detune.value = detune * 10;
      osc.frequency.setValueAtTime(430, t);
      osc.frequency.linearRampToValueAtTime(880, t + 0.55);
      osc.frequency.linearRampToValueAtTime(470, t + 1.05);
      osc.frequency.linearRampToValueAtTime(880, t + 1.6);
      osc.frequency.linearRampToValueAtTime(520, t + 2.1);
      osc.connect(f);
      osc.start(t);
      osc.stop(t + 2.15);
    }
    return 2.15;
  },
  // electric discharge: falling zap, crackle and a low thump
  emp: (c, o, t, n) => {
    tone(c, o, t, "square", 2600, 70, 0.38, 0.12);
    tone(c, o, t, "sawtooth", 1300, 40, 0.3, 0.08, 0.03);
    noiseBurst(c, o, t, n, 0.45, "highpass", 3200, 0.45);
    noiseBurst(c, o, t + 0.12, n, 0.3, "bandpass", 5200, 0.25);
    tone(c, o, t, "sine", 130, 38, 0.45, 0.7);
    return 0.55;
  },
  // pod touchdown: heavy thud, metal clang, dust hiss
  pod: (c, o, t, n) => {
    tone(c, o, t, "sine", 95, 30, 0.42, 1);
    noiseBurst(c, o, t, n, 0.5, "lowpass", 1400, 0.7, 120);
    tone(c, o, t + 0.05, "triangle", 620, 590, 0.35, 0.12);
    tone(c, o, t + 0.05, "triangle", 931, 900, 0.3, 0.06);
    noiseBurst(c, o, t + 0.1, n, 0.6, "bandpass", 2400, 0.18, 600);
    return 0.75;
  },
  // orbital strike: a crack, then a long rolling boom
  hammer: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.18, "highpass", 2500, 0.9);
    noiseBurst(c, o, t, n, 1.8, "lowpass", 1500, 1, 40);
    noiseBurst(c, o, t + 0.2, n, 1.4, "lowpass", 600, 0.8, 50);
    tone(c, o, t, "sine", 70, 18, 1.6, 1);
    tone(c, o, t + 0.05, "sine", 48, 16, 1.4, 0.8);
    return 1.85;
  },
  // Sky Hammer telegraph: a rising charge-up hum with a tremble
  charge: (c, o, t) => {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 2.8);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 2.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 2.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.95);
    const lfo = c.createOscillator();
    lfo.frequency.setValueAtTime(6, t);
    lfo.frequency.linearRampToValueAtTime(22, t + 2.8);
    const depth = c.createGain();
    depth.gain.value = 0.05;
    lfo.connect(depth).connect(g.gain);
    osc.connect(f).connect(g).connect(o);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 3);
    lfo.stop(t + 3);
    return 3;
  },
  // your calldown is away: a radio chirp
  uplink: (c, o, t) => {
    tone(c, o, t, "square", 1180, 1180, 0.05, 0.07);
    tone(c, o, t, "square", 1580, 1580, 0.07, 0.07, 0.07);
    tone(c, o, t, "sine", 2360, 2600, 0.12, 0.06, 0.14);
    return 0.28;
  },
  // ---- map objectives ----
  // Uplink taken: a bright rising data-burst arpeggio over a soft swell
  capture: (c, o, t) => {
    [587, 880, 1175, 1760].forEach((f, i) => tone(c, o, t, "square", f, f, 0.07, 0.06, i * 0.06));
    tone(c, o, t, "triangle", 440, 880, 0.5, 0.12);
    tone(c, o, t + 0.24, "sine", 1760, 1760, 0.35, 0.08);
    return 0.62;
  },
  // Uplink lost: the signal dies, a falling, crackling two-tone
  uplinkLost: (c, o, t, n) => {
    tone(c, o, t, "square", 988, 494, 0.32, 0.07);
    tone(c, o, t + 0.18, "square", 740, 247, 0.4, 0.07);
    noiseBurst(c, o, t + 0.1, n, 0.45, "bandpass", 2600, 0.12, 700);
    return 0.62;
  },
  // supply drop inbound: a transport's engine drone sweeping overhead, then a radio chirp
  drop: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 1.6, "bandpass", 260, 0.35, 900);
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(92, t);
    osc.frequency.linearRampToValueAtTime(118, t + 0.8);
    osc.frequency.linearRampToValueAtTime(84, t + 1.6);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 520;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    osc.connect(f).connect(g).connect(o);
    osc.start(t);
    osc.stop(t + 1.65);
    tone(c, o, t + 1.2, "square", 1320, 1320, 0.06, 0.06);
    tone(c, o, t + 1.29, "square", 1760, 1760, 0.09, 0.06);
    return 1.65;
  },
  // crate claimed: latches pop, then a sparkly reward fanfare
  crate: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.08, "highpass", 3000, 0.25);
    tone(c, o, t, "triangle", 330, 300, 0.12, 0.25);
    [784, 988, 1175, 1568].forEach((f, i) => tone(c, o, t, "triangle", f, f, 0.16, 0.16, 0.06 + i * 0.07));
    tone(c, o, t + 0.34, "sine", 2349, 2600, 0.3, 0.07);
    return 0.66;
  },
  // ---- the Goliath ----
  // stabiliser spikes driven home: two deep thuds, then the hydraulics let out a long hiss
  anchor: (c, o, t, n) => {
    for (const d of [0, 0.11]) {
      tone(c, o, t + d, "sine", 95, 34, 0.32, 0.7);
      noiseBurst(c, o, t + d, n, 0.12, "lowpass", 700, 0.45, 120);
    }
    noiseBurst(c, o, t + 0.18, n, 0.9, "highpass", 2400, 0.16, 5200);
    noiseBurst(c, o, t + 0.2, n, 0.6, "bandpass", 900, 0.08, 400);
    return 1.12;
  },
  // packing up: a burst of steam, locks clanking open one after another, a rising hydraulic groan
  packup: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.8, "highpass", 3200, 0.2, 6000);
    for (const [d, f] of [[0.1, 760], [0.26, 640], [0.4, 820]] as const) {
      tone(c, o, t + d, "triangle", f, f * 0.7, 0.07, 0.09);
      noiseBurst(c, o, t + d, n, 0.04, "highpass", 2600, 0.12);
    }
    tone(c, o, t + 0.3, "sawtooth", 70, 120, 0.8, 0.05);
    return 1.12;
  },
  // a Goliath's footfall: a heavy, muffled thump with a little metal in it
  stomp: (c, o, t, n, pitch) => {
    tone(c, o, t, "sine", 70 * pitch, 30 * pitch, 0.22, 0.6);
    noiseBurst(c, o, t, n, 0.14, "lowpass", 420, 0.4, 90);
    tone(c, o, t + 0.01, "triangle", 240 * pitch, 180 * pitch, 0.05, 0.03);
    return 0.24;
  },
  // a Goliath goes down: a long metal groan, then the crash of it hitting the ground and a rumble
  topple: (c, o, t, n) => {
    tone(c, o, t, "sawtooth", 140, 62, 0.55, 0.06);
    tone(c, o, t, "square", 210, 96, 0.5, 0.025);
    noiseBurst(c, o, t + 0.3, n, 1.3, "lowpass", 1300, 1, 45);
    tone(c, o, t + 0.3, "sine", 60, 20, 1.1, 1);
    noiseBurst(c, o, t + 0.34, n, 0.25, "highpass", 2400, 0.3);
    [0.42, 0.55, 0.7].forEach((d, i) => tone(c, o, t + d, "triangle", 620 - i * 90, 420 - i * 60, 0.08, 0.05));
    return 1.65;
  },
  // a weapon system knocked out: a crackle of sparks and a power-down whine
  offline: (c, o, t, n) => {
    for (let i = 0; i < 4; i++) noiseBurst(c, o, t + i * 0.045 + Math.random() * 0.02, n, 0.03, "highpass", 3800, 0.22);
    tone(c, o, t + 0.05, "sawtooth", 880, 90, 0.6, 0.07);
    tone(c, o, t + 0.05, "sine", 440, 60, 0.6, 0.08);
    return 0.68;
  },
  // a weapon system rebooting: a power-up whine climbing to a ready beep
  reboot: (c, o, t) => {
    tone(c, o, t, "sawtooth", 110, 880, 0.75, 0.05);
    tone(c, o, t, "sine", 220, 1320, 0.75, 0.06);
    tone(c, o, t + 0.8, "square", 1568, 1568, 0.07, 0.06);
    tone(c, o, t + 0.9, "square", 2093, 2093, 0.1, 0.06);
    return 1.02;
  },
  // a welding arc on the Gantry: a quiet buzzing sizzle
  weld: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.35, "bandpass", 5200, 0.12, 3600);
    tone(c, o, t, "square", 120, 118, 0.3, 0.012);
    return 0.38;
  },
  // a Goliath walks off its Gantry: the eye powers up with a rising chord, the cradle unlocks with a clank
  rollout: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.08, "highpass", 2800, 0.2);
    tone(c, o, t, "triangle", 300, 260, 0.14, 0.2);
    [196, 247, 294, 392].forEach((f, i) => tone(c, o, t + 0.1 + i * 0.08, "sawtooth", f, f * 2, 0.5, 0.035));
    tone(c, o, t + 0.5, "sine", 784, 784, 0.6, 0.07);
    return 1.12;
  },
  // two Condors hook onto a Goliath: clamps biting, then the rotors bite into the air with a gust
  hook: (c, o, t, n) => {
    for (const d of [0, 0.09]) {
      tone(c, o, t + d, "triangle", 980, 700, 0.06, 0.08);
      noiseBurst(c, o, t + d, n, 0.04, "highpass", 3000, 0.15);
    }
    noiseBurst(c, o, t + 0.12, n, 0.7, "bandpass", 300, 0.4, 1200);
    tone(c, o, t + 0.12, "sine", 90, 130, 0.6, 0.12);
    return 0.84;
  },
  // Robot Love: a sweet, bell-like rising chime with a soft shimmer
  love: (c, o, t) => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(c, o, t, "sine", f, f, 0.7, 0.08, i * 0.11));
    [1047, 1319, 1568].forEach((f, i) => tone(c, o, t, "triangle", f * 2, f * 2, 0.5, 0.025, 0.55 + i * 0.09));
    tone(c, o, t + 0.2, "sine", 262, 262, 1.2, 0.07);
    return 1.45;
  },
  // (the nations' weapons only exist in Belle Époque; here they borrow the nearest original sound)
  arcShell: (...a) => RECIPES.shell(...a),
  heavyShell: (...a) => RECIPES.heavy(...a),
  arcBolt: (...a) => RECIPES.laser(...a),
  flak47: (...a) => RECIPES.flak(...a),
  zenithDrone: (...a) => RECIPES.thrust(...a)
};

export const sfx = new Sfx();
