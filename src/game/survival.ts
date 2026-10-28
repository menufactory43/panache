import {
  THEME_COUNTERS,
  survivalStatus,
  wavesSurvived,
  type SurvivalDifficulty,
  type WaveTheme
} from "../sim/modes/survival";
import { TICK_RATE } from "../sim/balance";
import type { FxEvent, World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import { announce } from "./announce";
import { sfx } from "./audio";
import type { GroundGfx } from "./three/ground-gfx";
import { tr } from "../lang";

/**
 * Last Stand presentation: wave announcements, the on-map spawn marker,
 * and the per-map best-score records (localStorage).
 */

export const THEME_ICONS: Record<WaveTheme, string> = {
  air: "✈",
  armour: "⛓",
  artillery: "💥",
  mixed: "⚔",
  swarm: "🤖",
  boss: "☠"
};

/** Compass directions (sim data, English) as the banners say them. */
const DIR_FR: Record<string, string> = tr(
  {
    north: "nord", south: "sud", east: "est", west: "ouest",
    "north-east": "nord-est", "north-west": "nord-ouest", "south-east": "sud-est", "south-west": "sud-ouest"
  },
  {
    north: "north", south: "south", east: "east", west: "west",
    "north-east": "north-east", "north-west": "north-west", "south-east": "south-east", "south-west": "south-west"
  }
);
const dirFr = (d: string): string => DIR_FR[d] ?? d;

// ------------------------------------------------------------- records ---

const KEY = "panache.laststand";

export interface LastStandRecord {
  /** Most waves survived on this map and difficulty. */
  best: number;
  /** Kills in that best run. */
  kills: number;
  runs: number;
}

type Records = Record<string, LastStandRecord>;

const recKey = (mapId: string, difficulty: string) => `${mapId}:${difficulty}`;

function loadAll(): Records {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Records) : {};
  } catch {
    return {}; // storage blocked: no records, the mode still works
  }
}

export function loadBest(mapId: string, difficulty: string): LastStandRecord | null {
  const r = loadAll()[recKey(mapId, difficulty)];
  return r && typeof r.best === "number" ? r : null;
}

export interface RunResult {
  waves: number;
  kills: number;
  /** Best before this run (0 if none). */
  prevBest: number;
  best: number;
  isNew: boolean;
}

const finished = new WeakMap<World, RunResult>();

/**
 * Settle a finished run: save it if it beat the record. Idempotent per
 * world (the scene and the end screen both ask). Spectated runs don't count.
 */
export function finishRun(w: World, mapId: string, difficulty: string, record = true): RunResult {
  const done = finished.get(w);
  if (done) return done;
  const waves = wavesSurvived(w);
  const kills = w.factions[w.survival?.defender ?? "blue"].stats.unitsKilled;
  const all = loadAll();
  const prev = all[recKey(mapId, difficulty)];
  const prevBest = prev?.best ?? 0;
  const isNew = record && waves > prevBest;
  if (record) {
    all[recKey(mapId, difficulty)] = {
      best: Math.max(prevBest, waves),
      kills: isNew ? kills : prev?.kills ?? kills,
      runs: (prev?.runs ?? 0) + 1
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }
  const result = { waves, kills, prevBest, best: Math.max(prevBest, waves), isNew };
  finished.set(w, result);
  return result;
}

export const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---------------------------------------------------------- presenter ---

/** Turns wave events into banners and sounds, and marks the spawn edge on the map. */
export class SurvivalPresenter {
  private prevBest: number;
  private recordAnnounced = false;
  /** Sim tick the latest wave entered the map (its marker lingers briefly). */
  private spawnedAt = -1e9;
  readonly difficulty: SurvivalDifficulty;

  constructor(
    private w: World,
    private opts: {
      mapId: string;
      difficulty: SurvivalDifficulty;
      spectator: boolean;
      ping(x: number, y: number): void;
      /** Drawn above the fog: where the waves come from is public (null: no marker). */
      gfx: GroundGfx | null;
    }
  ) {
    this.difficulty = opts.difficulty;
    this.prevBest = opts.spectator ? Infinity : loadBest(opts.mapId, opts.difficulty)?.best ?? 0;
  }

  handleFx(ev: FxEvent): boolean {
    switch (ev.type) {
      case "waveIncoming": {
        const boss = ev.theme === "boss";
        // the theme is the headline (it's what to react to), then where and when, then what beats
        // it (the wave before's "cleared" banner names it too, but wave 1 has none)
        const sub = [tr(`${THEME_ICONS[ev.theme]} ${boss ? "Vague du boss" : "Vague"} ${ev.wave} depuis le ${dirFr(ev.dir)} dans ${Math.round(ev.eta / TICK_RATE)} s`, `${THEME_ICONS[ev.theme]} ${boss ? "Boss wave" : "Wave"} ${ev.wave} from the ${dirFr(ev.dir)} in ${Math.round(ev.eta / TICK_RATE)} s`)];
        if (ev.early > 0) sub.push(tr(`+${ev.early} charbon`, `+${ev.early} coal`));
        announce({
          key: boss ? "boss-incoming" : "wave-incoming",
          text: ev.name,
          sub: `${sub.join(" · ")} — ${THEME_COUNTERS[ev.theme]}`,
          tone: boss ? "epic" : "bad",
          x: ev.x,
          y: ev.y,
          priority: 1
        });
        sfx.play("alert", 0.9);
        this.opts.ping(ev.x, ev.y);
        return true;
      }
      case "waveSpawned":
        this.spawnedAt = this.w.tick;
        this.opts.ping(ev.x, ev.y);
        this.checkRecord();
        return true;
      case "waveCleared": {
        const milestone = ev.wave % 10 === 0;
        announce({
          key: "wave-cleared",
          text: tr(milestone ? `Vague ${ev.wave} repoussée !` : `Vague ${ev.wave} repoussée`, milestone ? `Wave ${ev.wave} repelled!` : `Wave ${ev.wave} repelled`),
          sub: tr(`+${ev.bonus} charbon · suivante : ${THEME_ICONS[ev.nextTheme]} ${ev.next} — ${THEME_COUNTERS[ev.nextTheme]}`, `+${ev.bonus} coal · next: ${THEME_ICONS[ev.nextTheme]} ${ev.next} — ${THEME_COUNTERS[ev.nextTheme]}`),
          tone: milestone ? "epic" : "good",
          priority: 2
        });
        sfx.play("rank", 0.8);
        this.checkRecord();
        return true;
      }
    }
    return false;
  }

  /** Celebrate once when this run passes the stored best. */
  private checkRecord(): void {
    if (this.recordAnnounced || this.prevBest <= 0) return;
    const waves = wavesSurvived(this.w);
    if (waves <= this.prevBest) return;
    this.recordAnnounced = true;
    announce({ key: "new-record", text: tr("Nouveau record !", "New record!"), sub: tr(`${waves} vagues — ton record était ${this.prevBest}`, `${waves} waves — your record was ${this.prevBest}`), tone: "epic", priority: 2 });
  }

  /** Pulsing marker and chevrons at the edge the next (or current) wave comes from. */
  drawOverlay(now: number): void {
    const g = this.opts.gfx;
    if (!g) return;
    const st = survivalStatus(this.w);
    // shown while the wave is announced and as it enters, not for its whole life
    if (!st?.site || (!st.warned && this.w.tick - this.spawnedAt > 15 * TICK_RATE)) return;
    const boss = (st.warned ? st.nextTheme : this.w.survival?.theme) === "boss";
    const col = boss ? 0xffd66e : 0xff5a4a;
    const { x, y } = st.site;
    const t = (now % 1200) / 1200;
    g.lineStyle(2.5, col, 0.9 * (1 - t)).strokeCircle(x, y, 1 + t * 2.2);
    g.lineStyle(1.5, col, 0.55).strokeCircle(x, y, 1.1);
    // chevrons marching toward the base
    const hq = hqOf(this.w, this.w.survival?.defender ?? "blue");
    if (!hq) return;
    const c = buildingCenter(hq);
    const dx = c.x - x;
    const dy = c.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    for (let i = 0; i < 3; i++) {
      const k = ((i + t) / 3) * 3.2 + 1.6;
      const cx = x + ux * k;
      const cy = y + uy * k;
      const s = 0.55;
      const a = 0.85 * (1 - (i + t) / 3);
      g.lineStyle(3, col, a);
      g.lineBetween(cx - ux * s - uy * s, cy - uy * s + ux * s, cx, cy);
      g.lineBetween(cx, cy, cx - ux * s + uy * s, cy - uy * s - ux * s);
    }
  }
}
