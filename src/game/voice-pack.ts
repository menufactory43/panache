/**
 * The recorded announcer (Panache): clips of the phrase book
 * (voice-lines.ts) fetched on first need and kept as decoded AudioBuffers,
 * played through a field-telephone line onto the voice bus. announcer.ts
 * decides when; this module only finds, loads and plays the clips.
 *
 * Clips live in assets/voice/ (English: assets/voice/en/; MP3, mono, 24 kb/s: Safari, Chrome and
 * Firefox all decode it). The common lines are fetched ahead at the start of
 * a match (prefetchCore), the rest on first use; the service worker keeps
 * them (vite.config.ts, runtime cache).
 */
import { planVoice, voiceLines, type VoiceLine } from "./voice-lines";
import { tr } from "../lang";

/** Playback tuning. */
export const VOICE = {
  /** Clip folder (relative to the page, like the other assets): the English recording in its own. */
  base: tr("assets/voice/", "assets/voice/en/"),
  /** Gain into the telephone line (the clips are normalized to -16 LUFS). */
  gain: 0.7,
  /** Silence between two fragments of one line, s (the clips are trimmed tight). */
  joinS: 0.035,
  /** How long a line may wait for its clips before it is spoken by speech synthesis instead, ms. */
  waitMs: 700,
  /** Clips fetched at once while prefetching. */
  prefetchJobs: 2,
  /** The field telephone's band, Hz, its presence peak, and the line hiss under the voice. */
  lowHz: 330,
  highHz: 3300,
  peakHz: 1800,
  peakDb: 4,
  hiss: 0.012
} as const;

/** What was fetched and played (debugging, the headless check). */
export interface VoiceStats {
  fetched: number;
  failed: number;
  played: number;
  /** Lines the book couldn't say (spoken by speech synthesis). */
  uncovered: number;
  /** Lines whose clips came too late (spoken by speech synthesis). */
  late: number;
  lastFiles: string[];
}

type Fetcher = (url: string) => Promise<ArrayBuffer>;
const defaultFetch: Fetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.arrayBuffer();
};

export class VoicePack {
  private bufs = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private broken = new Set<string>();
  private prefetched = false;
  readonly stats: VoiceStats = { fetched: 0, failed: 0, played: 0, uncovered: 0, late: 0, lastFiles: [] };

  constructor(
    private fetcher: Fetcher = defaultFetch,
    private base: string = VOICE.base
  ) {}

  /** The clips that say `text`, or null (not in the book, or a clip failed to load before). */
  plan(text: string): VoiceLine[] | null {
    const p = planVoice(text);
    if (!p || p.some((l) => this.broken.has(l.file))) return null;
    return p;
  }

  /** The plan's buffers if all are loaded already. */
  cached(plan: readonly VoiceLine[]): AudioBuffer[] | null {
    const out: AudioBuffer[] = [];
    for (const l of plan) {
      const b = this.bufs.get(l.file);
      if (!b) return null;
      out.push(b);
    }
    return out;
  }

  /** Load one clip (once); null if it can't be fetched or decoded. */
  private one(ctx: BaseAudioContext, file: string): Promise<AudioBuffer | null> {
    const have = this.bufs.get(file);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(file);
    if (!p) {
      p = this.fetcher(this.base + file)
        .then((data) => ctx.decodeAudioData(data))
        .then((b) => {
          this.bufs.set(file, b);
          this.stats.fetched++;
          return b;
        })
        .catch(() => {
          this.broken.add(file);
          this.stats.failed++;
          return null;
        })
        .finally(() => this.loading.delete(file));
      this.loading.set(file, p);
    }
    return p;
  }

  /** Load the plan's clips; null if any can't be had. */
  async load(ctx: BaseAudioContext, plan: readonly VoiceLine[]): Promise<AudioBuffer[] | null> {
    const bufs = await Promise.all(plan.map((l) => this.one(ctx, l.file)));
    return bufs.every((b): b is AudioBuffer => !!b) ? bufs : null;
  }

  /** Fetch the common lines ahead, a couple at a time (once). */
  async prefetchCore(ctx: BaseAudioContext, stop: () => boolean = () => false): Promise<void> {
    if (this.prefetched) return;
    this.prefetched = true;
    const queue = voiceLines().filter((l) => l.core);
    const worker = async () => {
      for (let l = queue.shift(); l && !stop(); l = queue.shift()) await this.one(ctx, l.file);
    };
    await Promise.all(Array.from({ length: VOICE.prefetchJobs }, worker));
  }

  /**
   * Play `bufs` back to back from `at` (context time) into `out`, through the
   * field telephone. Returns the length (s) and a stop() for a line cut short.
   */
  play(ctx: BaseAudioContext, out: AudioNode, bufs: readonly AudioBuffer[], at: number, noise?: AudioBuffer | null, files: string[] = []): { len: number; stop(): void } {
    const line = telephone(ctx, out);
    const srcs: AudioScheduledSourceNode[] = [];
    let t = at;
    bufs.forEach((b, i) => {
      if (i > 0) t += VOICE.joinS;
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(line.input);
      s.start(t);
      srcs.push(s);
      t += b.duration;
    });
    const len = t - at;
    if (noise && VOICE.hiss > 0) {
      // the carbon microphone's hiss, only while the line is open
      const n = ctx.createBufferSource();
      n.buffer = noise;
      n.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(VOICE.hiss, at + 0.04);
      g.gain.setValueAtTime(VOICE.hiss, at + len);
      g.gain.linearRampToValueAtTime(0, at + len + 0.06);
      n.connect(g).connect(line.input);
      n.start(at);
      n.stop(at + len + 0.08);
      srcs.push(n);
    }
    this.stats.played++;
    this.stats.lastFiles = files;
    const cleanup = setTimeout(() => line.output.disconnect(), (at - ctx.currentTime + len + 0.5) * 1000);
    return {
      len,
      stop: () => {
        for (const s of srcs)
          try {
            s.stop();
          } catch {
            /* not started yet */
          }
        clearTimeout(cleanup);
        line.output.disconnect();
      }
    };
  }
}

/** A field telephone line: band-limited, a little nasal, softly saturated. */
function telephone(ctx: BaseAudioContext, out: AudioNode): { input: AudioNode; output: AudioNode } {
  const input = ctx.createGain();
  input.gain.value = VOICE.gain;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = VOICE.lowHz;
  hp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = VOICE.highHz;
  lp.Q.value = 0.9;
  const peak = ctx.createBiquadFilter();
  peak.type = "peaking";
  peak.frequency.value = VOICE.peakHz;
  peak.Q.value = 1.1;
  peak.gain.value = VOICE.peakDb;
  const sat = ctx.createWaveShaper();
  sat.curve = SAT_CURVE;
  const output = ctx.createGain();
  output.gain.value = 1;
  input.connect(hp).connect(lp).connect(peak).connect(sat).connect(output).connect(out);
  return { input, output };
}

/** A gentle tanh curve: the carbon microphone's grit without audible distortion. */
const SAT_CURVE: Float32Array<ArrayBuffer> = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  const k = 1.6;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
})();

/** The game's one voice pack. */
export const voicePack = new VoicePack();
