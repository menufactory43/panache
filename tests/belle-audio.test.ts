import { afterAll, describe, expect, it, vi } from "vitest";
import { UNITS } from "../src/sim/balance";
import type { Biome, UnitKind } from "../src/sim/types";
import { BELLE_RECIPES } from "../src/game/audio-belle";
import { sfxRecipe, type SfxName } from "../src/game/audio";
import { MUSIC, mtof, voiceLead, type MixState, type NoteEvent } from "../src/game/score";
import { BELLE_KEYS, BELLE_MUSIC, BelleComposer, belleChordPcs, belleFlavour, belleLayerTargets, marchDrums } from "../src/game/score-belle";
import { BELLE_VOICES, CHIRP, VOICES, chirpPlan, renderBelleChirp, type VoiceLine } from "../src/game/voices";

// The Belle Époque sound (audio-belle.ts, score-belle.ts, the BELLE_VOICES of voices.ts). Node has no
// `location`, so theme.ts's BELLE_EPOQUE is off here and everything else runs the original sound;
// these tests call the Belle code directly, and load the modules once per style to check the switch.

// ------------------------------------------------------- a recording AudioContext ---

/** Every started source with its start/stop times, and every scheduled value (to check for NaN). */
class Rec {
  sources: { start: number; stop: number }[] = [];
  values: number[] = [];
}

function fakeContext(rec: Rec): BaseAudioContext {
  const param = (v = 0) => {
    const p = {
      value: v,
      defaultValue: v,
      setValueAtTime: (x: number, t: number) => (rec.values.push(x, t), p),
      linearRampToValueAtTime: (x: number, t: number) => (rec.values.push(x, t), p),
      exponentialRampToValueAtTime: (x: number, t: number) => {
        if (!(x > 0)) throw new Error(`exponential ramp to ${x}`);
        rec.values.push(x, t);
        return p;
      },
      setTargetAtTime: (x: number, t: number, k: number) => (rec.values.push(x, t, k), p),
      cancelScheduledValues: () => p
    };
    return p;
  };
  const node = (extra: Record<string, unknown> = {}) => {
    const n = { connect: (to: unknown) => to, disconnect: () => {}, ...extra };
    return n;
  };
  const source = (extra: Record<string, unknown>) => {
    const s = { start: 0, stop: Infinity };
    rec.sources.push(s);
    return node({
      ...extra,
      onended: null,
      start: (t = 0, _off = 0, dur?: number) => {
        s.start = t;
        if (dur !== undefined) s.stop = Math.min(s.stop, t + dur);
      },
      stop: (t = 0) => {
        s.stop = t;
      }
    });
  };
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: "lowpass", frequency: param(350), Q: param(1), gain: param(0) }),
    createOscillator: () => source({ type: "sine", frequency: param(440), detune: param(0) }),
    createBufferSource: () => source({ buffer: null, loop: false, playbackRate: param(1) }),
    createBuffer: (_c: number, len: number, sr: number) => ({ duration: len / sr, getChannelData: () => new Float32Array(len) })
  };
  return ctx as unknown as BaseAudioContext;
}

const noise = { duration: 2 } as AudioBuffer;
const out = { connect: () => {} } as unknown as AudioNode;

describe("Belle Époque sound effects", () => {
  it("cover the battle, interface and calldown sounds", () => {
    for (const n of ["cannon", "heavy", "mg", "flak", "rocket", "missile", "laser", "shell", "bomb", "explosion", "bigExplosion", "click", "ready", "alert", "sell", "inbound", "coin", "victory", "defeat",
      // the nations' weapons (WP5g): the Branly's zap-boum, the 280's siege boom, the Bobine's arc, the Batterie de 47, the Zénith's engines
      "arcShell", "heavyShell", "arcBolt", "flak47", "zenithDrone"] as SfxName[])
      expect(BELLE_RECIPES[n], n).toBeDefined();
    // the switch: Belle when asked and available, the original otherwise
    expect(sfxRecipe("cannon", true)).toBe(BELLE_RECIPES.cannon);
    expect(sfxRecipe("cannon", false)).not.toBe(BELLE_RECIPES.cannon);
  });

  it("stop every node they start within the length they report, with finite values", () => {
    for (const [name, recipe] of Object.entries(BELLE_RECIPES)) {
      const rec = new Rec();
      const t = 1;
      const dur = recipe!(fakeContext(rec), out, t, noise, 1.2);
      expect(dur, name).toBeGreaterThan(0.03);
      expect(dur, name).toBeLessThan(3.2);
      expect(rec.sources.length, name).toBeGreaterThan(0);
      for (const s of rec.sources) {
        expect(s.start, name).toBeGreaterThanOrEqual(t);
        // audio.ts disconnects the voice 100 ms after the reported length
        expect(s.stop, name).toBeLessThanOrEqual(t + dur + 0.1);
      }
      for (const v of rec.values) expect(Number.isFinite(v), name).toBe(true);
    }
  });
});

describe("Belle Époque unit voices", () => {
  const KINDS = Object.keys(UNITS) as UnitKind[];
  const LINES: VoiceLine[] = ["select", "move", "attack", "ready", "rank", "death"];

  it("give every unit a period voice: steam whistles, propellers, clockwork automatons", () => {
    for (const k of KINDS) expect(BELLE_VOICES[k], k).toBeDefined();
    expect(BELLE_VOICES.harvester.family).toBe("steam");
    expect(BELLE_VOICES.goliath.family).toBe("steam");
    expect(BELLE_VOICES.raptor.family).toBe("prop");
    expect(BELLE_VOICES.scout.family).toBe("balloon");
    for (const k of ["trooper", "rocket-squad", "sniper"] as const) expect(BELLE_VOICES[k].family).toBe("clock");
    // the nations' units have voices of their own, not their stand-ins': the République hums, the Empire chuffs
    expect(BELLE_VOICES.fourgon).not.toBe(BELLE_VOICES.harvester);
    expect(BELLE_VOICES.fourgon.family).toBe("arc");
    expect(BELLE_VOICES.branly.family).toBe("arc");
    expect(BELLE_VOICES.estafette.family).toBe("steam");
    expect(BELLE_VOICES["mortier-280"].family).toBe("steam");
    expect(BELLE_VOICES.titan.family).toBe("balloon");
    // the original voices are untouched
    expect(VOICES.trooper.wave).toBe("square");
  });

  it("keep every line inside the chirp budget and stop all their nodes by its end", () => {
    for (const kind of KINDS)
      for (const line of LINES) {
        const plan = chirpPlan(kind, line, 11, BELLE_VOICES);
        expect(plan.length).toBeLessThanOrEqual(CHIRP.maxMs);
        const rec = new Rec();
        const at = 0.5;
        const last = renderBelleChirp(fakeContext(rec), out, noise, plan, at);
        expect(last).toBeDefined();
        for (const s of rec.sources) expect(s.stop, `${kind} ${line}`).toBeLessThanOrEqual(at + plan.length / 1000 + 0.031);
        for (const v of rec.values) expect(Number.isFinite(v), `${kind} ${line}`).toBe(true);
      }
  });
});

// ------------------------------------------------------------------- music ---

const run = (c: BelleComposer, mix: MixState, steps: number) => {
  const out: { step: number; ev: NoteEvent[]; style: string; bpm: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const ev = c.next(mix);
    // (the step these events were for: a new style restarts the count at 0)
    out.push({ step: c.step - 1, ev, style: c.style, bpm: c.bpm });
  }
  return out;
};

describe("Belle Époque score", () => {
  it("plays a barrel-organ waltz on the menu and an accordion musette while calm, both in 3/4", () => {
    const c = new BelleComposer("temperate", 5);
    const menu = run(c, { mode: "menu", intensity: 0, alarm: false }, 48);
    expect(menu[0]!.style).toBe("organ");
    expect(c.flavour.bell).toBe("organ");
    // oom on the downbeat, pah on beats two and three
    const bassSteps = menu.filter((s) => s.ev.some((e) => e.kind === "bass")).map((s) => s.step % 12);
    const stabSteps = menu.filter((s) => s.ev.some((e) => e.kind === "stab")).map((s) => s.step % 12);
    expect(new Set(bassSteps)).toEqual(new Set([0]));
    expect(new Set(stabSteps)).toEqual(new Set([4, 8]));
    expect(menu.some((s) => s.ev.some((e) => e.kind === "drum"))).toBe(false);
    const calm = run(c, { mode: "battle", intensity: 0.1, alarm: false }, 48);
    expect(calm.at(-1)!.style).toBe("musette");
    expect(c.flavour.bell).toBe("accordion");
    expect(c.bpm).toBe(BELLE_MUSIC.bpm.musette);
  });

  it("strikes up a 2/4 march once a fight is on, on a bar line, and holds each style a few bars", () => {
    const c = new BelleComposer("volcanic", 9);
    run(c, { mode: "battle", intensity: 0.1, alarm: false }, 12 * 5);
    expect(c.style).toBe("musette");
    const fight = run(c, { mode: "battle", intensity: 0.9, alarm: false }, 16 * 2);
    const firstMarch = fight.findIndex((s) => s.style === "march");
    expect(firstMarch).toBeGreaterThanOrEqual(0);
    expect(fight[firstMarch]!.step).toBe(0); // a new style starts its own bar count
    expect(c.bpm).toBe(BELLE_MUSIC.bpm.march);
    const march = fight.slice(firstMarch);
    expect(march.some((s) => s.ev.some((e) => e.kind === "drum" && e.voice === "roll"))).toBe(true); // the roll-off
    expect(march.some((s) => s.ev.some((e) => e.kind === "drum" && e.voice === "snare"))).toBe(true);
    expect(march.some((s) => s.ev.some((e) => e.kind === "stab"))).toBe(true);
    expect(march.some((s) => s.ev.some((e) => e.kind === "drum" && e.voice === "cym"))).toBe(true);
    // the march doesn't drop back to a waltz at once, but does once it has played its bars
    const back = run(c, { mode: "battle", intensity: 0, alarm: false }, 16);
    expect(back.every((s) => s.style === "march")).toBe(true);
    const later = run(c, { mode: "battle", intensity: 0, alarm: false }, 16 * BELLE_MUSIC.minBars);
    expect(later.at(-1)!.style).toBe("musette");
  });

  it("writes each key's chords (V7 on the dominant) and voice-leads them in range", () => {
    for (const biome of Object.keys(BELLE_KEYS) as Biome[]) {
      const f = belleFlavour(biome, "musette");
      expect(belleFlavour(biome, "musette")).toBe(f); // one object per pair
      let prev: number[] | null = null;
      for (const d of f.progression) {
        const pcs = belleChordPcs(f, d);
        expect(pcs.length).toBe(d === 4 ? 4 : 3);
        const v = voiceLead(prev, pcs, MUSIC.padLo, MUSIC.padHi);
        for (const m of v) {
          expect(m).toBeGreaterThanOrEqual(MUSIC.padLo);
          expect(m).toBeLessThanOrEqual(MUSIC.padHi);
          expect(Number.isFinite(mtof(m))).toBe(true);
        }
        prev = v;
      }
    }
    // G major's dominant seventh: D F# A C
    const g = belleFlavour("temperate", "march");
    expect(belleChordPcs(g, 4).sort((a, b) => a - b)).toEqual([0, 2, 6, 9]);
  });

  it("keeps the oom-pah lightly in when calm, and the march drums for the fight", () => {
    const calm = belleLayerTargets("battle", 0, false);
    expect(calm.bass).toBeGreaterThan(0.08);
    expect(calm.drums).toBe(0);
    const fight = belleLayerTargets("battle", 0.9, true);
    expect(fight.drums).toBe(1);
    expect(fight.arp).toBeGreaterThan(0.8);
    expect(belleLayerTargets("menu", 0, false).drums).toBe(0);
    // every march bar is a full bar of 16 steps; full tilt rolls into every fourth
    for (const bar of [0, 1, 2, 3])
      for (const steps of Object.values(marchDrums(2, bar))) expect(steps).toHaveLength(16);
    expect(marchDrums(2, 3).roll!.some((v) => v > 0)).toBe(true);
  });

  it("closes the band and holds the tonic for the finale", () => {
    const c = new BelleComposer("desert", 3);
    run(c, { mode: "battle", intensity: 0.6, alarm: false }, 64);
    const closed = c.closeGates();
    expect(closed.every((e) => e.kind === "gate" && !e.on)).toBe(true);
    const ch = c.holdTonic(true, 32);
    expect(ch.root).toBe(BELLE_KEYS.desert.tonic % 12);
    const end = run(c, { mode: "end", intensity: 0, alarm: false }, 32);
    expect(end.some((s) => s.ev.some((e) => e.kind === "chord"))).toBe(false);
  });
});

// ------------------------------------------------------------- the switch ---

const had = "location" in globalThis;
const saved = (globalThis as { location?: unknown }).location;

async function load(search: string) {
  vi.resetModules();
  (globalThis as { location?: unknown }).location = { search };
  const theme = await import("../src/game/three/theme");
  const audio = await import("../src/game/audio");
  const belle = await import("../src/game/audio-belle");
  const voices = await import("../src/game/voices");
  return { theme, audio, belle, voices };
}

afterAll(() => {
  if (had) (globalThis as { location?: unknown }).location = saved;
  else delete (globalThis as { location?: unknown }).location;
});

describe("the theme switch", () => {
  it("plays the Belle Époque sound by default and the original with ?style=original", async () => {
    const b = await load("");
    expect(b.theme.BELLE_EPOQUE).toBe(true);
    expect(b.audio.sfxRecipe("shell")).toBe(b.belle.BELLE_RECIPES.shell);
    expect(b.voices.ACTIVE_VOICES).toBe(b.voices.BELLE_VOICES);
    const o = await load("?style=original");
    expect(o.theme.BELLE_EPOQUE).toBe(false);
    expect(o.audio.sfxRecipe("shell")).not.toBe(o.belle.BELLE_RECIPES.shell);
    expect(o.voices.ACTIVE_VOICES).toBe(o.voices.VOICES);
  });
});
