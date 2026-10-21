/**
 * Unit chirp-voices. Every unit class has its own synthesized robot voice:
 * a carrier oscillator gliding through two formant band-passes (plus a dry
 * share, so thin voices still carry on phone speakers). A unit answers when
 * it is selected or ordered, reports when it rolls off the line, sparkles
 * when promoted and lets out a falling wail when it dies in view.
 *
 * Lines are short (< 400 ms) and strictly rate-limited so they charm rather
 * than nag; they play on the voice bus, under the pause menu's Voice switch.
 * The plans (pitches, timings) and the gate are engine-free and tested
 * (tests/voices.test.ts); UnitVoices renders them with WebAudio.
 */
import type { Faction, FxEvent, Unit, UnitKind, World } from "../sim/types";
import { sfx, type AudioEngine } from "./audio";
import { BELLE_EPOQUE } from "./three/theme";
import { withStandIns } from "./three/belle/placeholders";

export type VoiceLine = "select" | "move" | "attack" | "ready" | "rank" | "death";

/** Lines the player asked for (they answer at once); the rest are unprompted. */
export const USER_LINES: ReadonlySet<VoiceLine> = new Set<VoiceLine>(["select", "move", "attack"]);

export const CHIRP = {
  /** Every line (echo included) is over by then. */
  maxMs: 380,
  /** Strict minimum between the starts of any two lines. */
  minGapMs: 250,
  /** Unprompted lines are rarer still: per-line spacing… */
  autoGapMs: { ready: 2000, rank: 1500, death: 2500 } as Partial<Record<VoiceLine, number>>,
  /** …and they keep out of the way of the player's own chirps. */
  afterUserMs: 600,
  /** Pitch jitter by unit id (± fraction), so a group sounds like a chorus. */
  jitter: 0.06,
  /** A group selection adds one echo voice this much quieter, this much later. */
  echoDb: -6,
  echoDelayMs: 90,
  /** Output level into the voice bus (lines land near −30 dBFS RMS, under an intense score). */
  level: 0.22,
  /** At most this many chirps sounding at once. */
  maxLive: 3
} as const;

export interface VoiceSpec {
  /** Base pitch, Hz. */
  f0: number;
  wave: OscillatorType;
  /** Two formant centres (Hz): the "vowel" of the voice. */
  formants: [number, number];
  /** Formant band-pass Q. */
  q: number;
  /** Nominal syllable length, ms. */
  syl: number;
  /** Unfiltered share 0–1 (sine voices are mostly dry). */
  dry: number;
  /** Buzz: frequency modulation at `hz`, depth as a fraction of the pitch. */
  fm?: { hz: number; depth: number };
  /** A second partial at this ratio of the pitch (shimmer, bell). */
  partial?: number;
  /** Percussive bell envelope instead of a sustained syllable. */
  bell?: boolean;
  /** Level trim. */
  gain: number;
}

/** One voice per unit class: heavy hulls growl low, drones buzz, the Mender rings, troopers chatter. */
export const VOICES: Record<UnitKind, VoiceSpec> = withStandIns<VoiceSpec>({
  harvester: { f0: 260, wave: "triangle", formants: [620, 1400], q: 5, syl: 110, dry: 0.7, gain: 0.82 },
  scout: { f0: 560, wave: "triangle", formants: [1500, 3000], q: 6, syl: 55, dry: 0.55, gain: 1.0 },
  stinger: { f0: 320, wave: "square", formants: [800, 1800], q: 7, syl: 70, dry: 0.15, gain: 1.0 },
  "flak-crawler": { f0: 230, wave: "square", formants: [700, 1500], q: 6, syl: 80, dry: 0.12, fm: { hz: 31, depth: 0.05 }, gain: 0.6 },
  mortar: { f0: 150, wave: "sawtooth", formants: [560, 1100], q: 7, syl: 115, dry: 0.12, gain: 1.2 },
  mastodon: { f0: 80, wave: "sawtooth", formants: [500, 900], q: 6, syl: 140, dry: 0.1, gain: 1.2 },
  lancer: { f0: 440, wave: "sine", formants: [1000, 2400], q: 5, syl: 90, dry: 0.8, partial: 2.01, gain: 0.58 },
  wasp: { f0: 220, wave: "sawtooth", formants: [1200, 2600], q: 8, syl: 50, dry: 0.1, fm: { hz: 60, depth: 0.25 }, gain: 1.33 },
  raptor: { f0: 360, wave: "sawtooth", formants: [1100, 2500], q: 7, syl: 60, dry: 0.15, gain: 0.93 },
  hornet: { f0: 110, wave: "sawtooth", formants: [600, 1150], q: 6, syl: 125, dry: 0.1, fm: { hz: 38, depth: 0.12 }, gain: 1.18 },
  mender: { f0: 660, wave: "sine", formants: [1300, 2600], q: 4, syl: 120, dry: 0.9, partial: 2.76, bell: true, gain: 0.95 },
  // robot infantry: troopers chirp high in a chorus (a partial a hair sharp beats against the pitch), rocket
  // crews bark gruff and buzzy, sniper pairs murmur low and calm; the Condor drones like an engine under rotors
  trooper: { f0: 430, wave: "square", formants: [950, 2200], q: 6, syl: 55, dry: 0.3, partial: 1.012, gain: 0.85 },
  "rocket-squad": { f0: 175, wave: "sawtooth", formants: [620, 1250], q: 6, syl: 85, dry: 0.12, fm: { hz: 27, depth: 0.05 }, gain: 1.15 },
  sniper: { f0: 135, wave: "triangle", formants: [520, 1050], q: 4, syl: 135, dry: 0.65, gain: 1.15 },
  condor: { f0: 92, wave: "sawtooth", formants: [430, 900], q: 5, syl: 120, dry: 0.12, fm: { hz: 44, depth: 0.16 }, gain: 1.15 },
  // the Goliath: the deepest, slowest voice on the field, with a slow mechanical shudder
  goliath: { f0: 58, wave: "sawtooth", formants: [380, 780], q: 6, syl: 165, dry: 0.08, fm: { hz: 22, depth: 0.06 }, gain: 1.3 }
});

/**
 * Belle Époque voices (theme.ts BELLE_EPOQUE): no robot chirps but the
 * machines' own sounds, phrased like the chirps (same plans, same gate).
 * Steam machines answer with a chime whistle (a chuff for a bark, a hiss
 * for a death); the Panhard honks its bulb horn; aeroplanes rev a
 * propeller's buzz; the dirigible and the Montgolfière drone softly over a
 * creak; the Hydroglisseur buzzes like its arc; the Pasteur rings; the
 * clockwork automatons whir, tick their escapement and finish on a small
 * brass "ding" (a death unwinds the spring).
 */
export type BelleFamily = "steam" | "horn" | "prop" | "balloon" | "arc" | "bell" | "clock";

export interface BelleVoiceSpec extends VoiceSpec {
  family: BelleFamily;
}

// (the nations' new units speak with their stand-ins' voices until WP5g gives them their own)
export const BELLE_VOICES: Record<UnitKind, BelleVoiceSpec> = withStandIns<BelleVoiceSpec>({
  harvester: { family: "steam", f0: 560, wave: "sine", formants: [600, 1400], q: 5, syl: 110, dry: 1, gain: 0.42 },
  scout: { family: "balloon", f0: 150, wave: "triangle", formants: [700, 1500], q: 4, syl: 90, dry: 1, fm: { hz: 9, depth: 0.45 }, gain: 0.75 },
  stinger: { family: "horn", f0: 330, wave: "sawtooth", formants: [900, 1800], q: 3, syl: 70, dry: 0.3, gain: 1.0 },
  "flak-crawler": { family: "steam", f0: 640, wave: "sine", formants: [700, 1500], q: 6, syl: 75, dry: 1, gain: 0.4 },
  mortar: { family: "steam", f0: 470, wave: "sine", formants: [560, 1100], q: 6, syl: 115, dry: 1, gain: 0.45 },
  mastodon: { family: "steam", f0: 260, wave: "sine", formants: [500, 900], q: 6, syl: 140, dry: 1, gain: 0.4 },
  lancer: { family: "arc", f0: 120, wave: "square", formants: [1400, 2400], q: 2, syl: 90, dry: 0.4, gain: 1.05 },
  wasp: { family: "prop", f0: 150, wave: "sawtooth", formants: [900, 2000], q: 2, syl: 55, dry: 1, fm: { hz: 34, depth: 0.5 }, gain: 1.1 },
  raptor: { family: "prop", f0: 190, wave: "sawtooth", formants: [1000, 2200], q: 2, syl: 60, dry: 1, fm: { hz: 42, depth: 0.5 }, gain: 1.0 },
  hornet: { family: "prop", f0: 95, wave: "sawtooth", formants: [700, 1300], q: 2, syl: 125, dry: 1, fm: { hz: 22, depth: 0.5 }, gain: 1.25 },
  mender: { family: "bell", f0: 880, wave: "sine", formants: [1300, 2600], q: 4, syl: 120, dry: 1, partial: 2.76, bell: true, gain: 0.9 },
  trooper: { family: "clock", f0: 1320, wave: "triangle", formants: [3600, 5000], q: 4, syl: 55, dry: 1, partial: 2.76, gain: 0.58 },
  "rocket-squad": { family: "clock", f0: 990, wave: "triangle", formants: [2600, 4000], q: 4, syl: 85, dry: 1, partial: 2.76, gain: 0.6 },
  sniper: { family: "clock", f0: 740, wave: "triangle", formants: [2200, 3400], q: 4, syl: 135, dry: 1, partial: 2.76, gain: 0.78 },
  condor: { family: "balloon", f0: 110, wave: "triangle", formants: [500, 1100], q: 4, syl: 120, dry: 1, fm: { hz: 7, depth: 0.45 }, gain: 1.0 },
  goliath: { family: "steam", f0: 175, wave: "sine", formants: [380, 780], q: 6, syl: 165, dry: 1, gain: 0.4 }
});

/** The voices in play: the Belle Époque ones when that theme is on. */
export const ACTIVE_VOICES: Record<UnitKind, VoiceSpec> = BELLE_EPOQUE ? BELLE_VOICES : VOICES;

/** A syllable: a pitch glide `from` → `to` Hz with formants scaled by `vowel`. */
export interface Syllable {
  at: number;
  dur: number;
  from: number;
  to: number;
  vowel: number;
}

export interface ChirpPlan {
  kind: UnitKind;
  line: VoiceLine;
  pitch: number;
  syllables: Syllable[];
  /** Noise bark (attack). */
  bark?: { at: number; dur: number };
  /** High glints (promotion). */
  sparkle?: { at: number; dur: number; freq: number }[];
  /** Crackle (death). */
  crackle?: { at: number; dur: number };
  /** Total length, ms. */
  length: number;
}

/** [from ratio, to ratio, length × syl] per syllable, plus the gap between them (× syl). */
const SHAPES: Record<VoiceLine, { syl: [number, number, number][]; gap: number }> = {
  // two rising syllables: "bee-boo?"
  select: { syl: [[1, 1.12, 1], [1.18, 1.34, 1]], gap: 0.3 },
  // two short syllables then a fall: "da-da-dum"
  move: { syl: [[1.1, 1.12, 0.6], [1.16, 1.18, 0.6], [1.12, 0.8, 1.1]], gap: 0.2 },
  // three fast high syllables after a bark
  attack: { syl: [[1.25, 1.3, 0.55], [1.32, 1.36, 0.55], [1.42, 1.55, 0.7]], gap: 0.15 },
  // three rising: "ready!"
  ready: { syl: [[1, 1.04, 0.8], [1.12, 1.17, 0.8], [1.26, 1.36, 0.9]], gap: 0.2 },
  // four ascending, then sparkle
  rank: { syl: [[1, 1.02, 0.6], [1.12, 1.14, 0.6], [1.26, 1.28, 0.6], [1.5, 1.6, 0.8]], gap: 0.15 },
  // a falling wail
  death: { syl: [[1.3, 0.42, 2.4]], gap: 0 }
};

/** Deterministic pitch jitter for a unit id, within ±CHIRP.jitter. */
export function voicePitch(id: number): number {
  let h = Math.imul(id | 0, 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return 1 + ((h % 10001) / 10000 - 0.5) * 2 * CHIRP.jitter;
}

/** Build one line for a unit (times in ms from the line start). Always ≤ CHIRP.maxMs. */
export function chirpPlan(kind: UnitKind, line: VoiceLine, id: number, voiceSet: Record<UnitKind, VoiceSpec> = ACTIVE_VOICES): ChirpPlan {
  const v = voiceSet[kind];
  const shape = SHAPES[line];
  const pitch = voicePitch(id);
  const f0 = v.f0 * pitch;
  const syllables: Syllable[] = [];
  let t = 0;
  const plan: ChirpPlan = { kind, line, pitch, syllables, length: 0 };
  if (line === "attack") {
    plan.bark = { at: 0, dur: Math.max(35, v.syl * 0.45) };
    t = plan.bark.dur * 0.6;
  }
  shape.syl.forEach(([a, b, len], i) => {
    const dur = v.syl * len;
    syllables.push({ at: t, dur, from: f0 * a, to: f0 * b, vowel: i % 2 === 0 ? 1 : 1.18 });
    t += dur + (i < shape.syl.length - 1 ? shape.gap * v.syl : 0);
  });
  if (line === "rank") {
    const last = syllables[syllables.length - 1]!;
    const s0 = last.at + last.dur * 0.4;
    plan.sparkle = [
      { at: s0, dur: 90, freq: 2349 },
      { at: s0 + 45, dur: 90, freq: 3136 }
    ];
    t = Math.max(t, s0 + 135);
  }
  if (line === "death") {
    const s = syllables[0]!;
    plan.crackle = { at: s.dur * 0.3, dur: s.dur * 0.7 + 30 };
    t = Math.max(t, plan.crackle.at + plan.crackle.dur);
  }
  plan.length = t;
  // squeeze long voices (the Mastodon's slow growl) into the time budget
  return scalePlan(plan, CHIRP.maxMs);
}

/** Time-compress a plan (in place) so it lasts at most `maxMs`. */
export function scalePlan(plan: ChirpPlan, maxMs: number): ChirpPlan {
  const k = Math.min(1, maxMs / plan.length);
  if (k >= 1) return plan;
  const sc = <T extends { at: number; dur: number }>(x: T) => {
    x.at *= k;
    x.dur *= k;
  };
  plan.syllables.forEach(sc);
  plan.sparkle?.forEach(sc);
  if (plan.bark) sc(plan.bark);
  if (plan.crackle) sc(plan.crackle);
  plan.length *= k;
  return plan;
}

/**
 * Rate limiter: lines start at least CHIRP.minGapMs apart; unprompted lines
 * (ready, rank, death) also keep their own spacing and stay clear of the
 * player's chirps, so a busy factory or battle never turns into chatter.
 */
export class ChirpGate {
  private lastAny = -Infinity;
  private lastUser = -Infinity;
  private lastByLine = new Map<VoiceLine, number>();

  /** May `line` start at `now` (ms)? Records it when allowed. */
  allow(line: VoiceLine, now: number): boolean {
    if (now - this.lastAny < CHIRP.minGapMs) return false;
    const user = USER_LINES.has(line);
    if (!user) {
      if (now - this.lastUser < CHIRP.afterUserMs) return false;
      if (now - (this.lastByLine.get(line) ?? -Infinity) < (CHIRP.autoGapMs[line] ?? 0)) return false;
    }
    this.lastAny = now;
    if (user) this.lastUser = now;
    this.lastByLine.set(line, now);
    return true;
  }
}

/**
 * Who speaks for a group: the majority kind leads (ties go to the pricier
 * hull); a second kind — or, for a big single-kind group, a second unit —
 * adds the quieter echo.
 */
export function groupVoices(units: readonly Pick<Unit, "id" | "kind">[]): {
  lead: { kind: UnitKind; id: number };
  echo: { kind: UnitKind; id: number } | null;
} | null {
  if (units.length === 0) return null;
  const count = new Map<UnitKind, number>();
  for (const u of units) count.set(u.kind, (count.get(u.kind) ?? 0) + 1);
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1] || VOICES[a[0]].f0 - VOICES[b[0]].f0);
  const leadKind = ranked[0]![0];
  const leadUnit = units.find((u) => u.kind === leadKind)!;
  let echo: { kind: UnitKind; id: number } | null = null;
  if (ranked.length > 1) {
    const k = ranked[1]![0];
    echo = { kind: k, id: units.find((u) => u.kind === k)!.id };
  } else if (units.length >= 3) {
    const other = units.find((u) => u.id !== leadUnit.id)!;
    echo = { kind: other.kind, id: other.id };
  }
  return { lead: { kind: leadKind, id: leadUnit.id }, echo };
}

export interface VoiceHooks {
  world: World;
  player: Faction;
  spectator: boolean;
  /** Is this tile point inside the camera view (and visible to the player)? */
  inView(x: number, y: number): boolean;
}

/** Plays chirp lines on the voice bus. One instance for the whole app. */
export class UnitVoices {
  private gate = new ChirpGate();
  private e: AudioEngine | null = null;
  private live = 0;
  private lastSel: ReadonlySet<number> | null = null;
  /** Lines actually played, by kind of line (debug/measurement). */
  readonly stats: Record<VoiceLine, number> = { select: 0, move: 0, attack: 0, ready: 0, rank: 0, death: 0 };

  constructor() {
    sfx.onReady((e) => (this.e = e));
  }

  /** Is the voice layer audible? (When it isn't, callers fall back to plain chimes.) */
  get active(): boolean {
    return !!this.e && sfx.enabled("voice");
  }

  /**
   * Do unit voices answer this viewer's unit cues (a fresh unit, a promotion)?
   * Spectators hear none (see events()), so they keep the plain chimes.
   */
  answers(h: Pick<VoiceHooks, "spectator">): boolean {
    return !h.spectator && this.active;
  }

  /** A unit says a line. Returns whether the voice layer owns the cue (even if rate-limited). */
  say(kind: UnitKind, line: VoiceLine, id: number, echo?: { kind: UnitKind; id: number } | null): boolean {
    if (!this.active) return false;
    if (this.live >= CHIRP.maxLive || !this.gate.allow(line, performance.now())) return true;
    this.stats[line]++;
    const at = this.e!.ctx.currentTime + 0.01;
    this.render(chirpPlan(kind, line, id), at, 1);
    if (echo) {
      // the echo comes in a beat later, squeezed so the pair stays inside the budget
      const delay = CHIRP.echoDelayMs;
      const plan = scalePlan(chirpPlan(echo.kind, line, echo.id), CHIRP.maxMs - delay);
      this.render(plan, at + delay / 1000, Math.pow(10, CHIRP.echoDb / 20));
    }
    return true;
  }

  /** A group answers (selection or order). */
  group(line: VoiceLine, units: readonly Unit[]): boolean {
    const g = groupVoices(units);
    if (!g) return this.active;
    return this.say(g.lead.kind, line, g.lead.id, g.echo);
  }

  /** Call every frame: a fresh selection gets a "select" answer. */
  watchSelection(selected: ReadonlySet<number>, world: World): void {
    if (selected === this.lastSel) return;
    const first = this.lastSel === null;
    this.lastSel = selected;
    if (first || selected.size === 0) return;
    const units: Unit[] = [];
    for (const id of selected) {
      const u = world.units.get(id);
      if (u) units.push(u);
    }
    this.group("select", units);
  }

  /** The player's order went out: the selected units acknowledge (boarding and drops answer like a move). */
  order(
    kind: "move" | "attack" | "harvest" | "rally" | "place" | "board" | "drop" | "anchor",
    selected: ReadonlySet<number>,
    world: World
  ): void {
    if (kind === "rally" || kind === "place") return;
    const units: Unit[] = [];
    for (const id of selected) {
      const u = world.units.get(id);
      if (u && (kind !== "harvest" || u.kind === "harvester")) units.push(u);
    }
    this.group(kind === "attack" ? "attack" : "move", units);
  }

  /**
   * This tick's sim events: units rolling off the line (or out of a Drop Pod
   * or a Condor), promotions, deaths in view, and our Goliath reporting in
   * once it has dug in where we can see it (it is a base now: "ready").
   */
  events(list: readonly FxEvent[], h: VoiceHooks): void {
    if (!this.answers(h)) return;
    for (const ev of list) {
      if (ev.type === "built") {
        const u = h.world.units.get(ev.id);
        if (u && u.faction === h.player) this.say(u.kind, "ready", u.id);
      } else if (ev.type === "goliathMode") {
        if (ev.mode === "anchored" && ev.faction === h.player && h.inView(ev.x, ev.y)) this.say("goliath", "ready", ev.id);
      } else if (ev.type === "rankUp") {
        const u = h.world.units.get(ev.id);
        if (u && u.faction === h.player && h.inView(u.x, u.y)) this.say(u.kind, "rank", u.id);
      } else if (ev.type === "death") {
        if (ev.faction === h.player && ev.unitKind && h.inView(ev.x, ev.y)) this.say(ev.unitKind, "death", ev.id);
      } else if (ev.type === "calldownImpact" && ev.power === "droppod" && ev.faction === h.player) {
        // our Drop Pod's crew steps out and reports in, like a fresh unit off the line
        this.reportIn(ev.unitIds, h.world);
      } else if (ev.type === "disembark" && !ev.bailout && ev.faction === h.player) {
        // so do squads a Condor just put down
        this.reportIn(ev.unitIds, h.world);
      }
    }
  }

  /** Units that just arrived together say "ready" as one group. */
  private reportIn(ids: readonly number[], world: World): void {
    const crew: Unit[] = [];
    for (const id of ids) {
      const u = world.units.get(id);
      if (u) crew.push(u);
    }
    const g = groupVoices(crew);
    if (g) this.say(g.lead.kind, "ready", g.lead.id, g.echo);
  }

  // ------------------------------------------------------------ synthesis --

  private render(plan: ChirpPlan, at: number, level: number): void {
    const { ctx, voiceIn, noise } = this.e!;
    const v = ACTIVE_VOICES[plan.kind];
    const out = ctx.createGain();
    out.gain.value = CHIRP.level * v.gain * level;
    out.connect(voiceIn);
    this.live++;
    const last = BELLE_EPOQUE ? renderBelleChirp(ctx, out, noise, plan, at) : renderChirp(ctx, out, noise, plan, at);
    last.onended = () => {
      this.live--;
      out.disconnect();
    };
  }
}

/**
 * Synthesise a robot chirp line into `out` (at unit level: the caller sets
 * the line's gain). Returns the source that ends last.
 */
export function renderChirp(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, plan: ChirpPlan, at: number): AudioScheduledSourceNode {
  const v = VOICES[plan.kind];
  const end = at + plan.length / 1000;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  const car = ctx.createOscillator();
  car.type = v.wave;
  car.connect(env);
  let part: OscillatorNode | null = null;
  if (v.partial) {
    part = ctx.createOscillator();
    part.type = "sine";
    const pg = ctx.createGain();
    pg.gain.value = v.bell ? 0.45 : 0.3;
    part.connect(pg).connect(env);
  }
  let mod: OscillatorNode | null = null;
  let modGain: GainNode | null = null;
  if (v.fm) {
    mod = ctx.createOscillator();
    mod.frequency.value = v.fm.hz;
    modGain = ctx.createGain();
    mod.connect(modGain).connect(car.frequency);
  }
  const dry = ctx.createGain();
  dry.gain.value = v.dry;
  env.connect(dry).connect(out);
  // formants: band-passes lose most of the energy, so the wet path is boosted
  const wet = ctx.createGain();
  wet.gain.value = (1 - v.dry) * 2.6;
  wet.connect(out);
  const f1 = ctx.createBiquadFilter();
  const f2 = ctx.createBiquadFilter();
  for (const f of [f1, f2]) {
    f.type = "bandpass";
    f.Q.value = v.q;
    env.connect(f).connect(wet);
  }

  for (const s of plan.syllables) {
    const t0 = at + s.at / 1000;
    const t1 = t0 + s.dur / 1000;
    car.frequency.setValueAtTime(s.from, t0);
    car.frequency.exponentialRampToValueAtTime(Math.max(20, s.to), t1);
    if (part) {
      part.frequency.setValueAtTime(s.from * v.partial!, t0);
      part.frequency.exponentialRampToValueAtTime(Math.max(20, s.to * v.partial!), t1);
    }
    if (modGain) modGain.gain.setValueAtTime(s.from * v.fm!.depth, t0);
    f1.frequency.setValueAtTime(v.formants[0] * s.vowel, t0);
    f2.frequency.setValueAtTime(v.formants[1] / s.vowel, t0);
    const atk = Math.min(0.012, (s.dur / 1000) * 0.2);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + atk);
    if (v.bell) env.gain.exponentialRampToValueAtTime(0.02, t1);
    else env.gain.setValueAtTime(1, Math.max(t0 + atk, t1 - 0.02));
    env.gain.linearRampToValueAtTime(0, t1);
  }
  const oscs = [car, part, mod].filter((o): o is OscillatorNode => !!o);
  for (const o of oscs) {
    o.start(at);
    o.stop(end + 0.03);
  }

  const burst = (t: number, dur: number, type: BiquadFilterType, freq: number, gain: number, choppy: boolean) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    if (choppy) {
      // radio-style crackle: random on/off steps
      const steps = Math.max(3, Math.round(dur / 0.018));
      for (let i = 0; i < steps; i++) g.gain.setValueAtTime(Math.random() < 0.55 ? gain * (1 - i / steps) : 0, t + (i * dur) / steps);
    } else {
      g.gain.linearRampToValueAtTime(gain, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    }
    g.gain.setValueAtTime(0, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5, dur + 0.02);
  };
  if (plan.bark) burst(at + plan.bark.at / 1000, plan.bark.dur / 1000, "bandpass", v.formants[0] * 1.4, 0.9, false);
  if (plan.crackle) burst(at + plan.crackle.at / 1000, plan.crackle.dur / 1000, "highpass", 2400, 0.35, true);
  for (const sp of plan.sparkle ?? []) {
    const t = at + sp.at / 1000;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = sp.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + sp.dur / 1000);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + sp.dur / 1000 + 0.02);
  }
  return car;
}

/**
 * Synthesise a Belle Époque voice line (BELLE_VOICES) into `out`, same
 * contract as renderChirp: every source stops by the plan's end (+30 ms);
 * returns the one that ends last.
 */
export function renderBelleChirp(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, plan: ChirpPlan, at: number): AudioScheduledSourceNode {
  const v = BELLE_VOICES[plan.kind];
  const end = at + plan.length / 1000;
  const stopAt = end + 0.03;
  const osc = (type: OscillatorType, to: AudioNode) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.connect(to);
    o.start(at);
    o.stop(stopAt);
    return o;
  };
  const gain = (value: number, to: AudioNode | AudioParam) => {
    const g = ctx.createGain();
    g.gain.value = value;
    if ("defaultValue" in to) g.connect(to);
    else g.connect(to);
    return g;
  };
  const filter = (type: BiquadFilterType, freq: number, q: number, to: AudioNode) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(to);
    return f;
  };
  /** A run of noise ticks (escapement, ratchet, creak, sparks): times in s from `at`, each with a level. */
  const ticks = (hits: [number, number][], type: BiquadFilterType, freq: number, q: number, click = 0.004) => {
    if (!hits.length) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    for (const [d, lv] of hits) {
      g.gain.setValueAtTime(lv, at + d);
      g.gain.setTargetAtTime(0, at + d + 0.001, click / 3);
    }
    src.connect(filter(type, freq, q, g)).connect(g).connect(out);
    src.start(at, Math.random() * 1.5, plan.length / 1000 + 0.03);
  };
  /** A noise swell (chuff, hiss, burner): one burst from `t0` lasting `dur` s. */
  const burst = (t0: number, dur: number, type: BiquadFilterType, freq: number, peak: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    g.gain.setValueAtTime(0, t0 + dur);
    src.connect(filter(type, freq, 0.8, g)).connect(g).connect(out);
    src.start(t0, Math.random() * 1.5, dur + 0.02);
  };

  // the syllables' envelope, shared by the tonal parts
  const env = gain(1, out);
  env.gain.setValueAtTime(0, at);
  for (const s of plan.syllables) {
    const t0 = at + s.at / 1000;
    const t1 = t0 + s.dur / 1000;
    const atk = Math.min(v.family === "steam" ? 0.025 : 0.012, (s.dur / 1000) * 0.25);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + atk);
    if (v.bell) env.gain.exponentialRampToValueAtTime(0.02, t1);
    else env.gain.setValueAtTime(1, Math.max(t0 + atk, t1 - 0.02));
    env.gain.linearRampToValueAtTime(0, t1);
  }
  /** Glide an oscillator (or a filter) through the syllables at `ratio` × the pitch. */
  const follow = (p: AudioParam, ratio: number) => {
    for (const s of plan.syllables) {
      const t0 = at + s.at / 1000;
      p.setValueAtTime(s.from * ratio, t0);
      p.exponentialRampToValueAtTime(Math.max(20, s.to * ratio), t0 + s.dur / 1000);
    }
  };
  const syl = plan.syllables;
  const lastSyl = syl[syl.length - 1]!;
  let last: AudioScheduledSourceNode;

  switch (v.family) {
    case "steam": {
      // a chime whistle: two sines a major third apart, and breath through a band-pass on the pitch
      const a = osc("sine", env);
      const b = osc("sine", gain(0.7, env));
      follow(a.frequency, 1);
      follow(b.frequency, 1.26);
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = filter("bandpass", v.f0, 6, gain(1.4, env));
      follow(bp.frequency, 1.1);
      src.connect(bp);
      src.start(at, Math.random() * 1.5, plan.length / 1000 + 0.03);
      last = a;
      break;
    }
    case "horn": {
      // a bulb horn: a nasal reed through a resonant band
      const car = osc("sawtooth", filter("bandpass", v.formants[0], v.q, gain(2.2, env)));
      car.connect(gain(v.dry * 0.4, env));
      follow(car.frequency, 1);
      last = car;
      break;
    }
    case "prop":
    case "balloon": {
      // an engine's note chopped by the propeller blades (a triangle LFO on the level)
      const blades = gain(1 - v.fm!.depth, env);
      const car = osc(v.wave, filter("lowpass", v.family === "prop" ? 1100 : 700, 0.8, blades));
      follow(car.frequency, 1);
      const lfo = osc("triangle", gain(v.fm!.depth, blades.gain));
      lfo.frequency.value = v.fm!.hz;
      if (v.family === "balloon") {
        // the gondola's rigging creaks at the start of the line
        const n = 6;
        ticks(Array.from({ length: n }, (_, i) => [0.01 + i * 0.022 + Math.random() * 0.006, 0.25 * (1 - i / n)] as [number, number]), "bandpass", 900, 6, 0.006);
      }
      last = car;
      break;
    }
    case "arc": {
      // two detuned square hums through a band, and snapping sparks over each syllable
      const bp = filter("bandpass", v.formants[0], v.q, gain(1.6, env));
      const a = osc("square", bp);
      const b = osc("square", bp);
      follow(a.frequency, 1);
      follow(b.frequency, 1.03);
      const hits: [number, number][] = [];
      for (const s of syl) for (let i = 0; i < 4; i++) hits.push([(s.at + Math.random() * s.dur) / 1000, 0.25 + Math.random() * 0.35]);
      ticks(hits, "highpass", 3200, 0.7, 0.003);
      last = a;
      break;
    }
    case "bell": {
      // the Pasteur rings: a sine with a bell partial
      const a = osc("sine", env);
      const p = osc("sine", gain(0.45, env));
      follow(a.frequency, 1);
      follow(p.frequency, v.partial ?? 2.76);
      last = a;
      break;
    }
    case "clock": {
      // clockwork: a soft whir on the pitch, the escapement ticking through each syllable,
      // and a small brass "ding" ringing out of the last one
      const whir = osc("triangle", gain(0.22, env));
      follow(whir.frequency, 0.5);
      const hits: [number, number][] = [];
      for (const s of syl) {
        const step = 0.024;
        for (let d = 0; d < s.dur / 1000 - 0.004; d += step) hits.push([s.at / 1000 + d, hits.length % 2 ? 0.35 : 0.55]);
      }
      ticks(hits, "bandpass", v.formants[0], v.q, 0.004);
      const t0 = at + lastSyl.at / 1000;
      const ding = ctx.createGain();
      ding.gain.setValueAtTime(0.0001, t0);
      ding.gain.exponentialRampToValueAtTime(0.5, t0 + 0.003);
      ding.gain.exponentialRampToValueAtTime(0.0001, end);
      ding.connect(out);
      const d1 = osc("sine", ding);
      const d2 = osc("sine", gain(0.3, ding));
      d1.frequency.value = lastSyl.to;
      d2.frequency.value = lastSyl.to * (v.partial ?? 2.76);
      last = whir;
      break;
    }
  }

  // the attack's bark: a chuff of steam, a ratchet, a backfire or a snap
  if (plan.bark) {
    const t0 = at + plan.bark.at / 1000;
    const dur = plan.bark.dur / 1000;
    if (v.family === "clock") ticks([0, 0.012, 0.024, 0.036].map((d) => [plan.bark!.at / 1000 + d, 0.8] as [number, number]), "bandpass", 2600, 3, 0.006);
    else if (v.family === "arc") burst(t0, dur, "highpass", 3000, 0.7);
    else burst(t0, dur, "lowpass", v.family === "steam" ? 900 : 600, 1.1);
  }
  // the death: steam escaping, the mainspring unwinding, sparks, the engine coughing out
  if (plan.crackle) {
    const c0 = plan.crackle.at / 1000;
    const cd = plan.crackle.dur / 1000;
    if (v.family === "steam" || v.family === "balloon") burst(at + c0, cd, "highpass", 3400, 0.45);
    else if (v.family === "clock") {
      const hits: [number, number][] = [];
      for (let d = 0, gap = 0.012; d < cd; d += gap, gap *= 1.25) hits.push([c0 + d, 0.6]);
      ticks(hits, "bandpass", 3000, 3, 0.005);
    } else {
      const hits: [number, number][] = [];
      for (let d = 0; d < cd; d += 0.02 + Math.random() * 0.03) hits.push([c0 + d, 0.2 + Math.random() * 0.3]);
      ticks(hits, v.family === "prop" ? "lowpass" : "highpass", v.family === "prop" ? 700 : 2600, 0.7, 0.008);
    }
  }
  // a promotion: two brass dings
  for (const sp of plan.sparkle ?? []) {
    const t = at + sp.at / 1000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + sp.dur / 1000);
    g.connect(out);
    for (const r of [1, 2.76]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = (sp.freq / 1.4) * r;
      o.connect(r === 1 ? g : gain(0.25, g));
      o.start(t);
      o.stop(t + sp.dur / 1000 + 0.02);
    }
  }
  return last;
}
export const voices = new UnitVoices();
