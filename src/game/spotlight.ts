/**
 * « Temps forts »: the few big moments of a single-player match given a
 * beat of their own, as the finale gives the last one (finale.ts). A
 * Goliath toppling, the first shell on the enemy HQ, a big fight won, a
 * calldown that lands square: the battle drops to slow motion for about
 * 0.6 s, the camera jolts harder than a death's shake (juice.ts), pushes in
 * a touch on the spot, and, when no other line already names the moment
 * (callouts.ts announces Goliath kills and calldown hits), a banner says it.
 *
 * Tasteful by rule: at most one every SPOTLIGHT.gapMs of play, never once
 * the match is decided (the finale has it), slow motion, shake and push-in
 * only for a moment on screen (the player's camera is never moved off what
 * they were looking at), none of the three under prefers-reduced-motion,
 * and the whole thing off with the Réglages switch (SPOTLIGHT_KEY).
 *
 * Single player only: GameScene builds one for a match against the AI,
 * never for a duel (its two phones step one world at one speed, and the slow
 * motion slows the sim too), a replay or AI vs AI. Slowing the sim there is
 * safe: the sim takes ticks, not time, so it plays the same match slower.
 *
 * Engine-free (tests/spotlight.test.ts): the scene feeds it the sim's
 * events and the frame time, and acts on what it returns.
 */
import type { Announcement } from "./announce";
import type { Faction, FxEvent } from "../sim/types";
import { tr } from "../lang";

export const SPOTLIGHT = {
  /** At most one moment per this much play (real ms, paused time not counted). */
  gapMs: 45000,
  /** A moment older than this (sim seconds) is stale: it's let go. */
  staleS: 2,
  /** The slow motion: down to `slow` in inMs, held, back to real time over outMs; `ms` in all (real ms). */
  slow: 0.35,
  inMs: 90,
  outMs: 260,
  ms: 600,
  /** The jolt: stronger than a Goliath's death shake (juice.ts shakeFor). */
  shake: { ms: 520, intensity: 0.008 },
  /** The push-in on the spot (× zoom), anchored where it happened. */
  nudge: 1.08,
  /** A battle: at least `min` deaths within `radius` tiles over the last `windowS`, quiet for quietS, won by `edge` × losses. */
  battle: { windowS: 14, radius: 9, min: 8, quietS: 2.5, edge: 2 },
  /** A calldown of ours that hit at least this many (summed over a Barrage's shells). */
  calldownHits: 5
} as const;

/** localStorage: "0" when the player switched the Temps forts off in Réglages (on by default). */
export const SPOTLIGHT_KEY = "panache.tempsforts";

type Store = Pick<Storage, "getItem" | "setItem">;

/** Are the Temps forts on (storage blocked or junk: on)? */
export function spotlightOn(store: Pick<Storage, "getItem"> | null): boolean {
  try {
    return store?.getItem(SPOTLIGHT_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSpotlight(store: Store | null, on: boolean): void {
  try {
    store?.setItem(SPOTLIGHT_KEY, on ? "1" : "0");
  } catch {
    /* blocked: it stays on for this page */
  }
}

export type SpotKind = "goliath" | "hq-first" | "battle" | "calldown";

/** What the scene does for a moment. */
export interface Spot {
  kind: SpotKind;
  x: number;
  y: number;
  /** A banner of its own (null: another line already says it). */
  banner: Announcement | null;
  /** Slow motion, the jolt and the push-in: on screen, and motion allowed. */
  slow: boolean;
  shake: boolean;
  nudge: boolean;
}

export interface SpotHost {
  /** The local player's side. */
  player: Faction;
  /** Is the point on screen right now? */
  onScreen(x: number, y: number): boolean;
  /** May the player see the point (fog)? */
  sees(x: number, y: number): boolean;
  /** prefers-reduced-motion: banners only. */
  reduced: boolean;
  /** "au centre", "à leur base"… (chronicle.ts placeName). */
  place(x: number, y: number): string;
  /** Is this building id an HQ (a hit event carries only the id)? */
  isHq(id: number): boolean;
}

interface Candidate {
  kind: SpotKind;
  x: number;
  y: number;
  t: number;
  rank: number;
  banner: Announcement | null;
}

interface Death {
  t: number;
  x: number;
  y: number;
  faction: Faction;
  value: number;
}

/** How much each kind outranks the others when two are waiting. */
const RANK: Record<SpotKind, number> = { goliath: 4, battle: 3, "hq-first": 2, calldown: 1 };

/**
 * The render (and, single player, sim) time scale `ms` real ms into a
 * moment's slow motion: eased down, held, eased back to 1.
 */
export function slowAt(ms: number, S: Pick<typeof SPOTLIGHT, "slow" | "inMs" | "outMs" | "ms"> = SPOTLIGHT): number {
  if (ms < 0 || ms >= S.ms) return 1;
  if (ms < S.inMs) return 1 - (1 - S.slow) * (ms / S.inMs);
  const back = S.ms - S.outMs;
  if (ms < back) return S.slow;
  const k = (ms - back) / S.outMs;
  return S.slow + (1 - S.slow) * k * k * (3 - 2 * k);
}

export class Spotlight {
  /** Real ms of play since the last moment (Infinity: none yet, the first may come at once). */
  private since = Infinity;
  /** Real ms into the current slow motion (Infinity: none). */
  private slowMs = Infinity;
  private waiting: Candidate[] = [];
  private deaths: Death[] = [];
  /** Hits so far per calldown of ours (a Barrage's shells add up). */
  private strikes = new Map<number, number>();
  private hqHit = false;
  private lastBattleT = -Infinity;

  constructor(private h: SpotHost) {}

  /** A tick's events at sim time `t` (seconds). */
  events(fx: readonly FxEvent[], t: number): void {
    const me = this.h.player;
    for (const ev of fx) {
      if (ev.type === "death") {
        if (ev.unitKind && !ev.free) this.deaths.push({ t, x: ev.x, y: ev.y, faction: ev.faction, value: ev.value });
        // (callouts.ts banners every Goliath kill and loss already)
        if (ev.unitKind === "goliath") this.offer({ kind: "goliath", x: ev.x, y: ev.y, t, rank: RANK.goliath, banner: null });
      } else if (ev.type === "hit" && ev.building && ev.faction !== me && !this.hqHit && this.h.isHq(ev.id)) {
        // the first shell on their HQ, seen: once a match
        if (!this.h.sees(ev.x, ev.y)) continue;
        this.hqHit = true;
        this.offer({
          kind: "hq-first", x: ev.x, y: ev.y, t, rank: RANK["hq-first"],
          banner: { key: "spot-hq", text: tr("Leur GQG est touché !", "Their GHQ is hit!"), sub: tr("Le premier obus est tombé", "The first shell has landed"), tone: "epic", priority: 1, x: ev.x, y: ev.y }
        });
      } else if (ev.type === "calldownImpact" && ev.faction === me) {
        const n = (this.strikes.get(ev.id) ?? 0) + ev.hits;
        this.strikes.set(ev.id, n);
        const before = n - ev.hits;
        // (callouts.ts says "Coup au but !" for what it destroyed: this is the beat of it landing)
        if (before < SPOTLIGHT.calldownHits && n >= SPOTLIGHT.calldownHits)
          this.offer({ kind: "calldown", x: ev.x, y: ev.y, t, rank: RANK.calldown, banner: null });
      }
    }
    this.battle(t);
    // keep a short memory: deaths beyond the battle window, finished strikes
    const old = t - SPOTLIGHT.battle.windowS;
    if (this.deaths.length && this.deaths[0]!.t < old) this.deaths = this.deaths.filter((d) => d.t >= old);
    if (this.strikes.size > 32) this.strikes.clear();
  }

  /**
   * A fight just ended with many dead in one place and ours far fewer: the
   * player won it. Once per fight (a new one must start after it).
   */
  private battle(t: number): void {
    const B = SPOTLIGHT.battle;
    const ds = this.deaths;
    if (ds.length < B.min) return;
    const last = ds[ds.length - 1]!;
    // still fighting, or this fight already had its beat
    if (t - last.t < B.quietS || t - last.t > B.quietS + 1 || last.t <= this.lastBattleT) return;
    const near = ds.filter((d) => d.t > this.lastBattleT && Math.hypot(d.x - last.x, d.y - last.y) <= B.radius);
    if (near.length < B.min) return;
    const me = this.h.player;
    const lost = { mine: 0, theirs: 0, n: 0 };
    let sx = 0;
    let sy = 0;
    for (const d of near) {
      if (d.faction === me) lost.mine += d.value;
      else {
        lost.theirs += d.value;
        lost.n++;
      }
      sx += d.x;
      sy += d.y;
    }
    if (lost.theirs < B.edge * Math.max(1, lost.mine)) return;
    this.lastBattleT = last.t;
    const x = sx / near.length;
    const y = sy / near.length;
    const mine = near.length - lost.n;
    this.offer({
      kind: "battle", x, y, t, rank: RANK.battle,
      banner: {
        key: "spot-battle", text: tr("Bataille remportée", "Battle won"), sub: tr(`${cap(this.h.place(x, y))} : ${lost.n} pertes chez eux, ${mine} chez nous`, `${cap(this.h.place(x, y))}: ${lost.n} losses on their side, ${mine} on ours`),
        tone: "good", priority: 2, x, y
      }
    });
  }

  private offer(c: Candidate): void {
    this.waiting.push(c);
  }

  /**
   * Every frame: `realMs` of play (0 while paused or over), the sim time,
   * and whether the match is decided. Returns the moment to show now, if any.
   */
  update(realMs: number, t: number, decided: boolean): Spot | null {
    this.since += realMs;
    if (this.slowMs !== Infinity) {
      this.slowMs += realMs;
      if (this.slowMs >= SPOTLIGHT.ms) this.slowMs = Infinity;
    }
    if (decided) {
      this.waiting = [];
      this.slowMs = Infinity;
      return null;
    }
    this.waiting = this.waiting.filter((c) => t - c.t <= SPOTLIGHT.staleS);
    if (this.waiting.length === 0 || this.since < SPOTLIGHT.gapMs) return null;
    // the best that would show anything: a moment off screen with no banner of its own is nothing to show
    const ranked = [...this.waiting].sort((a, b) => b.rank - a.rank || b.t - a.t);
    for (const c of ranked) {
      const seen = this.h.onScreen(c.x, c.y);
      const motion = seen && !this.h.reduced;
      if (!motion && !c.banner) continue;
      this.waiting = [];
      this.since = 0;
      if (motion) this.slowMs = 0;
      return { kind: c.kind, x: c.x, y: c.y, banner: c.banner, slow: motion, shake: motion, nudge: motion };
    }
    return null;
  }

  /** The time scale now (1 outside a moment's slow motion). */
  get timeScale(): number {
    return this.slowMs === Infinity ? 1 : slowAt(this.slowMs);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
