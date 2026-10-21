/**
 * The radio announcer: a commander's voice for the moments that matter
 * ("Warning: our HQ is under attack", "Enemy aircraft detected", "Double
 * kill"). It reads out every announce() banner and the radio-only lines that
 * BattleCallouts (callouts.ts) detects in the fx stream, one at a time
 * through RadioQueue: most important first, ≥ 2.5 s apart, stale lines
 * dropped.
 *
 * Delivery: a short radio squelch on the voice bus, then the browser's
 * speechSynthesis (low pitch, a little fast, an English voice preferred),
 * and a soft "over" click at the end. Where speech is missing, or the Voice
 * setting is "Chirps" (no speech), a two-tone radio code stands in for the
 * words; radio-only lines also get a small caption so nothing is lost with
 * the sound off. Speech must be unlocked from a user gesture on iOS; the
 * module primes it on the first tap.
 *
 * With the Belle Époque theme the radio is a telegraph line: the squelch is
 * a sounder's click-clack over a carbon microphone's hiss, and the code is
 * keyed on a TSF buzzer (same pitches and timing as the radio code).
 */
import type { Faction, FxEvent, World } from "../sim/types";
import { onAnnounce, announce, type Announcement, type AnnounceTone } from "./announce";
import { sfx } from "./audio";
import { BELLE_EPOQUE } from "./three/theme";
import { BattleCallouts, RadioQueue, isEndLine, speakable, type RadioCueKey, type RadioLine } from "./callouts";

/** Speech voice settings. */
export const SPEECH = {
  rate: 1.08,
  pitch: 0.6,
  volume: 0.95,
  /** Gap between the squelch and the first word, ms. */
  leadMs: 130,
  /** Music duck while a line plays, dB. */
  duckDb: 5,
  /** Give up waiting for a line's end after this long past its estimate, s. */
  overrunS: 2
} as const;

/** Rough spoken length of a line, seconds (for the music duck and the busy timeout). */
export function lineSeconds(text: string, rate: number = SPEECH.rate): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return 0.35 + (words * 0.34) / rate;
}

// --------------------------------------------------------------- speech --

type SpeechState = "unknown" | "ok" | "missing";

/** Thin wrapper around window.speechSynthesis: voice choice, iOS priming, failure detection. */
class Speech {
  private synth: SpeechSynthesis | null =
    typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  private voice: SpeechSynthesisVoice | null = null;
  private primed = false;
  private failures = 0;
  state: SpeechState = this.synth ? "unknown" : "missing";

  constructor() {
    const s = this.synth;
    if (!s || typeof window === "undefined") return;
    this.pick();
    s.addEventListener?.("voiceschanged", () => this.pick());
    // iOS only lets speech start after it was first used inside a gesture
    // (not in a sound duel's link mode: no speech then, and the listener
    // stays for the first tap after it)
    const prime = () => {
      if (this.primed || sfx.linkMode) return;
      this.primed = true;
      this.failures = 0;
      try {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        s.speak(u);
      } catch {
        /* ignore */
      }
      for (const ev of ["pointerup", "touchend", "mousedown", "keydown"]) window.removeEventListener(ev, prime, true);
    };
    for (const ev of ["pointerup", "touchend", "mousedown", "keydown"])
      window.addEventListener(ev, prime, { capture: true, passive: true });
  }

  /** Choose a voice: English, preferably on-device and male-sounding (a low commander). */
  private pick(): void {
    const all = this.synth?.getVoices() ?? [];
    if (all.length === 0) return;
    const fr = all.filter((v) => /^fr([-_]|$)/i.test(v.lang));
    const pool = fr.length ? fr : all;
    const score = (v: SpeechSynthesisVoice) =>
      (v.localService ? 2 : 0) +
      (/male|thomas|nicolas|daniel|henri|paul|jacques|antoine|mathieu|guillaume|olivier|denis|claude/i.test(v.name) && !/female/i.test(v.name) ? 3 : 0) +
      (/^fr[-_]fr/i.test(v.lang) ? 1 : 0) +
      (v.default ? 0.5 : 0);
    this.voice = [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
    this.state = "ok";
  }

  /** Can we talk right now? */
  get usable(): boolean {
    return !!this.synth && this.state !== "missing" && this.failures < 3;
  }

  /**
   * Speak `text`. `done` runs when it ends; `failed` runs instead if it errors
   * or never starts (so the caller can fall back to the radio code). Returns
   * false if speech can't be used at all.
   */
  speak(text: string, tone: AnnounceTone, done: () => void, failed: () => void): boolean {
    const s = this.synth;
    if (!s || !this.usable) return false;
    try {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang ?? "fr-FR";
      // hype lines are a touch slower and lower, warnings a touch quicker
      u.rate = tone === "epic" ? SPEECH.rate * 0.94 : tone === "bad" ? SPEECH.rate * 1.04 : SPEECH.rate;
      u.pitch = tone === "epic" ? SPEECH.pitch * 0.9 : SPEECH.pitch;
      u.volume = SPEECH.volume;
      let started = false;
      let finished = false;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(watchdog);
        if (ok) done();
        else failed();
      };
      u.onstart = () => {
        started = true;
        this.failures = 0;
      };
      u.onend = () => finish(started);
      u.onerror = (e) => {
        const err = (e as SpeechSynthesisErrorEvent).error;
        // cut short by our own cancel(): that's the end of the line, not a failure
        if (err === "interrupted" || err === "canceled") return finish(true);
        // "not-allowed" before the first gesture (iOS, Chrome autoplay rules)
        // isn't the engine's fault — priming fixes it — so it doesn't count
        if (!(err === "not-allowed" && !this.primed)) this.failures++;
        finish(false);
      };
      // a voice-less engine may never start (or report): fall back after a while
      const watchdog = window.setTimeout(() => {
        if (started) return;
        this.failures++;
        finish(false); // before cancel(), whose error event must not claim the line
        this.cancel();
      }, 1500);
      if (s.speaking || s.pending) {
        // cancel-then-speak in one go is dropped by some engines: give it a beat
        s.cancel();
        window.setTimeout(() => s.speak(u), 60);
      } else s.speak(u);
      return true;
    } catch {
      this.failures++;
      return false;
    }
  }

  cancel(): void {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
  }
}

const speech = new Speech();

// ----------------------------------------------------------- radio sounds --

/** Radio squelch: a band-passed noise burst and a 1.2 kHz key-up beep. */
function squelch(open: boolean): void {
  const e = sfx.engine;
  if (!e) return;
  const { ctx, voiceIn, noise } = e;
  const t = ctx.currentTime + 0.01;
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(voiceIn);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = open ? 1700 : 2300;
  bp.Q.value = 1.1;
  const g = ctx.createGain();
  const dur = open ? 0.08 : 0.05;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.28, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.002, t + dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t, Math.random() * 1.5, dur + 0.02);
  if (BELLE_EPOQUE) {
    // the telegraph sounder: the armature's click (and its clack back, opening a line)
    bp.frequency.value = 1100;
    bp.Q.value = 0.7;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.002, t + dur);
    for (const [d, f] of open ? ([[0, 1900], [0.045, 1500]] as const) : ([[0, 1700]] as const)) {
      const k = ctx.createBufferSource();
      k.buffer = noise;
      const kf = ctx.createBiquadFilter();
      kf.type = "bandpass";
      kf.frequency.value = f;
      kf.Q.value = 4;
      const kg = ctx.createGain();
      kg.gain.setValueAtTime(0, t + d);
      kg.gain.linearRampToValueAtTime(0.5, t + d + 0.001);
      kg.gain.exponentialRampToValueAtTime(0.002, t + d + 0.025);
      k.connect(kf).connect(kg).connect(out);
      k.start(t + d, Math.random() * 1.5, 0.04);
    }
  } else if (open) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 1200;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t + 0.03);
    og.gain.linearRampToValueAtTime(0.1, t + 0.035);
    og.gain.setValueAtTime(0.1, t + 0.075);
    og.gain.linearRampToValueAtTime(0, t + 0.085);
    o.connect(og).connect(out);
    o.start(t + 0.03);
    o.stop(t + 0.1);
  }
  setTimeout(() => out.disconnect(), 400);
}

/** The two-tone code that stands in for words: falling for warnings, rising for good news. */
export const CODES: Record<AnnounceTone, number[]> = {
  bad: [988, 740, 988, 740],
  good: [740, 988],
  epic: [659, 880, 1319],
  info: [880, 880]
};

function code(tone: AnnounceTone, priority: number): number {
  const e = sfx.engine;
  if (!e) return 0;
  const { ctx, voiceIn } = e;
  // only the urgent warnings get the long four-note pattern
  const notes = tone === "bad" && priority > 1 ? CODES.bad.slice(0, 2) : CODES[tone];
  const t0 = ctx.currentTime + SPEECH.leadMs / 1000;
  const step = 0.11;
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(voiceIn);
  notes.forEach((f, i) => {
    const t = t0 + i * step;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    // the TSF buzzer: a nasal band around the note (the radio: a plain lowpass)
    lp.type = BELLE_EPOQUE ? "bandpass" : "lowpass";
    lp.frequency.value = BELLE_EPOQUE ? f * 2 : 2400;
    if (BELLE_EPOQUE) lp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.005);
    g.gain.setValueAtTime(0.09, t + step * 0.7);
    g.gain.linearRampToValueAtTime(0, t + step * 0.85);
    o.connect(lp).connect(g).connect(out);
    o.start(t);
    o.stop(t + step);
  });
  const len = SPEECH.leadMs / 1000 + notes.length * step;
  setTimeout(() => out.disconnect(), (len + 0.3) * 1000);
  return len;
}

/**
 * A quick sample after the Voice setting changes (pause menu): "Radio check"
 * in words, or the radio code in Chirps mode. Runs inside the tap, which
 * also unlocks speech on iOS.
 */
export function radioCheck(): void {
  if (!sfx.enabled("voice")) return;
  squelch(true);
  const fallback = () => code("info", 2);
  // link mode (a sound duel) speaks no words: the code stands in
  if (sfx.settings.speech && !sfx.linkMode && speech.usable) {
    if (!speech.speak("Essai radio", "info", () => squelch(false), fallback)) fallback();
  } else fallback();
}

// ------------------------------------------------------------ announcer --

export interface AnnouncerHooks {
  world: World;
  player: Faction;
  spectator: boolean;
  /** Is the tile point inside the camera view? */
  onScreen(x: number, y: number): boolean;
  /** Show a radio caption (for lines no toast or banner already shows). */
  caption(line: RadioLine): void;
}

/** One delivered line, for debugging and the per-minute measurements. */
export interface RadioLogEntry {
  t: number;
  key: string;
  text: string;
  how: "speech" | "code" | "silent";
}

let active: Announcer | null = null;

/** Outside cues for the announcer (the HUD's "not enough scrap", a refused placement). */
export function radioCue(key: RadioCueKey): void {
  active?.cue(key);
}

/** The voice of the match: one per GameScene. */
export class Announcer {
  readonly callouts: BattleCallouts;
  private queue = new RadioQueue();
  /** Render seconds (stops while paused). */
  private clock = 0;
  private simT = 0;
  private busyUntil = 0;
  private ended = false;
  private offAnnounce: () => void;
  private offChange: () => void;
  readonly log: RadioLogEntry[] = [];

  constructor(private h: AnnouncerHooks) {
    this.callouts = new BattleCallouts({
      world: h.world, player: h.player, spectator: h.spectator, onScreen: h.onScreen,
      radio: (l) => this.push(l),
      announce
    });
    // every banner is read out too (its text is on screen, so no caption)
    this.offAnnounce = onAnnounce((a) => this.announced(a));
    // the Voice switch (or master mute, or link mode) cuts a line mid-word
    this.offChange = sfx.onChange(() => {
      if (!this.speechOn) speech.cancel();
    });
    active = this;
  }

  /** May lines be spoken (not just coded)? Never in a sound duel's link mode. */
  private get speechOn(): boolean {
    return sfx.enabled("voice") && sfx.settings.speech && !sfx.linkMode;
  }

  /** This tick's sim events at sim time `t`. */
  events(fx: readonly FxEvent[], t: number): void {
    this.simT = t;
    this.callouts.events(fx, t);
  }

  cue(key: RadioCueKey): void {
    this.callouts.cue(key, this.simT);
  }

  /** Banners: read out what the HUD shows. */
  private announced(a: Announcement): void {
    if (this.ended && a.priority !== 0) return;
    const text = a.say ?? speakable(a.text);
    if (!text) return;
    this.push({ key: `banner:${a.key}`, text, priority: a.priority ?? 2, tone: a.tone ?? "info", caption: false });
  }

  push(line: RadioLine): void {
    if (this.ended) return;
    if (isEndLine(line)) {
      // the last word: nothing else waits or talks over it
      this.ended = true;
      this.queue.clear();
      speech.cancel();
      this.busyUntil = 0;
      this.queue.push(line, this.clock);
      return;
    }
    this.queue.push(line, this.clock);
  }

  /** Call every frame with the real frame delta (ms). */
  update(deltaMs: number, paused: boolean): void {
    if (paused) return; // lines wait (and don't age) while the game is paused
    this.clock += deltaMs / 1000;
    const busy = this.clock < this.busyUntil;
    // the final line goes out at once; everything else respects the gap
    const line = this.queue.next(this.clock, busy, this.ended);
    if (line) this.deliver(line);
  }

  private deliver(line: RadioLine): void {
    if (line.caption) this.h.caption(line);
    const voiceOn = sfx.enabled("voice") && !!sfx.engine;
    let how: RadioLogEntry["how"] = "silent";
    let len = lineSeconds(line.text);
    if (voiceOn) {
      squelch(true);
      const words = this.speechOn && speech.usable;
      if (words) {
        how = "speech";
        const startAt = this.clock;
        const release = () => (this.busyUntil = Math.min(this.busyUntil, this.clock + 0.25));
        window.setTimeout(() => {
          const ok = speech.speak(
            line.text,
            line.tone,
            () => {
              // done: an "over" click, and the queue may move on shortly
              if (sfx.enabled("voice")) squelch(false);
              release();
            },
            () => {
              // no words came out: the code still tells the line apart
              if (sfx.enabled("voice") && !this.ended) code(line.tone, line.priority);
              release();
            }
          );
          if (!ok) code(line.tone, line.priority);
        }, SPEECH.leadMs);
        this.busyUntil = startAt + len + SPEECH.overrunS;
      } else {
        how = "code";
        len = code(line.tone, line.priority);
        this.busyUntil = this.clock + len + 0.2;
      }
      sfx.duck(SPEECH.duckDb, len);
    }
    this.log.push({ t: Math.round(this.simT * 10) / 10, key: line.key, text: line.text, how });
    if (this.log.length > 400) this.log.splice(0, 100);
  }

  destroy(): void {
    this.offAnnounce();
    this.offChange();
    speech.cancel();
    this.queue.clear();
    if (active === this) active = null;
  }
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) speech.cancel();
  });
