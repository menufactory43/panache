/**
 * Battle callouts: the engine-free rules behind the radio announcer and the
 * kill-streak banners. BattleCallouts watches the sim's fx stream (plus a
 * little world state) and decides *what* is worth saying; RadioQueue decides
 * *when* (priority, a minimum gap, stale lines dropped). announcer.ts does
 * the talking. Everything here is unit-tested (tests/voices.test.ts).
 *
 * Times are sim seconds for detection windows and cooldowns (so a faster
 * game speed needs no change) and render seconds for the delivery queue.
 */
import { BUILDINGS, TICK_RATE, UNITS } from "../sim/balance";
import { isVisible } from "../sim/fog";
import { goliathsOf } from "../sim/goliath";
import type { BuildingKind, Faction, FxEvent, GoliathWeapon, PowerKind, UnitKind, World } from "../sim/types";
import { agree } from "../sim/lexicon";
import { hqOf } from "../sim/world";
import type { Announcement, AnnounceTone } from "./announce";
import { baseGoliath, calldownThreatens } from "./awareness";
import { CalldownCredit, powerName, powerPhrase, type CalldownKill } from "./calldown-credit";

/** A line for the radio announcer. */
export interface RadioLine {
  /** Kind of line (dedupe, cooldown and debug key), e.g. "hq-attack". */
  key: string;
  /** What is said (and captioned). */
  text: string;
  /** 0 = critical … 3 = flavour. */
  priority: number;
  tone: AnnounceTone;
  /** Where it happened (tiles): tapping the caption jumps there. */
  x?: number;
  y?: number;
  /**
   * Show a small radio caption when it is delivered. False when a toast or
   * banner already shows the same news (no text spam), true when the radio
   * is the only place it appears.
   */
  caption: boolean;
  /**
   * Drop the line if it has waited this long (render seconds) — for warnings
   * that are useless once the moment has passed. Default RADIO.staleS.
   */
  staleS?: number;
}

/** Outside cues the HUD and input can send the radio. */
export type RadioCueKey = "no-scrap" | "cant-build";

export const CALLOUTS = {
  /** Per-line cooldowns, sim seconds. */
  cooldownS: {
    "hq-attack": 30,
    /** The HQ is being hit where the player can already see it: say it less often. */
    "hq-attack-seen": 60,
    "base-attack": 30,
    "units-attack": 60,
    "squad-lost": 20,
    "harvester-lost": 20,
    "unit-lost": 15,
    "structure-lost": 15,
    "structure-killed": 15,
    promoted: 25,
    "no-scrap": 8,
    "cant-build": 8,
    "enemy-barrage": 20,
    "enemy-emp": 20,
    "enemy-droppod": 20,
    /** Our Condor put its squads down / one of ours went down (bail-out or lost with them) / the enemy lands troops. */
    "troops-deployed": 20,
    "condor-down": 10,
    "enemy-drop": 20,
    // Goliaths (GOLIATH.md): a Gantry's build is public news, and so is everything a Goliath does
    "enemy-goliath-build": 20,
    "enemy-goliath-soon": 20,
    "enemy-goliath": 10,
    "goliath-ready": 10,
    "goliath-attack": 30,
    /** Our Goliath hit where the player can already see it (only said for a base or the last life). */
    "goliath-attack-seen": 60,
    "enemy-goliath-dig": 20,
    "enemy-goliath-pack": 30,
    "goliath-anchored": 15,
    /** Each weapon system's own line, per side and direction ("enemy-goliath-mortars", "goliath-laser-down"…). */
    "goliath-weapon": 20,
    "goliath-airborne": 20,
    "enemy-goliath-airborne": 20,
    "goliath-dropped": 10,
    "enemy-goliath-dropped": 10
  } as Record<string, number>,
  /**
   * An enemy calldown aimed at our units or buildings (the siren's
   * "threatened" rule). The Sky Hammer has its own spoken banner. Each line
   * is only worth saying while the reticle is still up.
   */
  calldownLines: {
    barrage: { key: "enemy-barrage", text: "Artillerie en approche !", staleS: 1.5 },
    emp: { key: "enemy-emp", text: "Fée Électricité en approche !", staleS: 1 },
    droppod: { key: "enemy-droppod", text: "Obus-capsule ennemi !", staleS: 2.5 }
  } as Partial<Record<PowerKind, { key: string; text: string; staleS: number }>>,
  /** A streak mostly made by one calldown is its own banner ("Sky Hammer: triple kill"), with this cooldown. */
  calldownStreakCooldownS: 10,
  /** "Squad lost": this many own unit deaths within the window. */
  squadDeaths: 3,
  squadWindowS: 3,
  /** Enemy combat aircraft out of sight this long re-arm "Enemy aircraft detected". */
  airRearmS: 120,
  /** Scan for newly visible aircraft every this many seconds. */
  airScanS: 0.5,
  /** Kill streaks: kills inside this sliding window… */
  streakWindowS: 4,
  /** …announced after this settle time, so a fast third kill upgrades the line. */
  streakHoldS: 0.6,
  /** Streak tiers (kills in the window) and each tier's own cooldown. */
  tiers: [
    { n: 5, key: "streak-5", text: "Carnage", tone: "epic", priority: 2, cooldownS: 45 },
    { n: 3, key: "streak-3", text: "Triplé", tone: "good", priority: 2, cooldownS: 30 },
    { n: 2, key: "streak-2", text: "Doublé", tone: "good", priority: 3, cooldownS: 30 }
  ] as { n: number; key: string; text: string; tone: AnnounceTone; priority: number; cooldownS: number }[],
  /** Kills of units worth at least this much scrap get their own banner. */
  bigKillValue: 350,
  bigKillCooldownS: 15,
  /** At least this long between any two kill banners (sparing)… */
  killBannerGapS: 6,
  /** …except a streak climbing to a higher tier, which only needs this. */
  escalateGapS: 2,
  /**
   * At most this many banners in any 60 s: past it, flavour kill banners
   * (streaks, big kills: priority 2 and 3) are dropped, while news (an HQ
   * falling, a Goliath on the field) always shows. A Goliath racking up
   * kills fed streak banners faster than the pleasantness budget allows.
   */
  bannersPerMinute: 6,
  /** Losing a unit worth this much (or a rank-2 veteran) gets a radio line. */
  bigLossValue: 350
} as const;

export interface CalloutHooks {
  world: World;
  player: Faction;
  spectator: boolean;
  /** Is the tile point inside the camera view? */
  onScreen(x: number, y: number): boolean;
  /** Hand a line to the radio announcer. */
  radio(line: RadioLine): void;
  /** Raise a banner (the HUD shows it; the announcer reads it out). */
  announce(a: Announcement): void;
}

export const SIDE: Record<Faction, string> = { blue: "Bleu", red: "Rouge" };
/** Shorter names where a banner must fit a phone ("ELITE FLAK DOWN"). */
export const SHORT: Partial<Record<UnitKind, string>> = { sniper: "Section alpine" };
const enemyOf = (f: Faction): Faction => (f === "blue" ? "red" : "blue");
/** Gender and number come from sim/lexicon.ts: agree("turret", "détruit") = "détruite", agree("fab-plant", "détruit") = "détruites". */
/** "ennemi" / "ennemie" / "ennemies". */
const hostile = (kind: UnitKind | BuildingKind | null | undefined): string => agree(kind, "ennemi");

/** The Goliath's counters, as its rollout banner names them (GOLIATH.md tunes it against these). */
export const GOLIATH_COUNTERS = "Artificiers, Éole, Hydroglisseurs, Albatros";
/** Spoken names of the weapon systems a Goliath can lose (the machine guns never go offline). */
export const GOLIATH_WORD: Partial<Record<GoliathWeapon, string>> = { mortars: "mortiers", laser: "arc électrique", cannons: "canons" };
/** The Zénith's systems, in the Goliath's slots (sim/goliath.ts ZENITH_SLOTS), and what beats it. */
const ZENITH_WORD: Partial<Record<GoliathWeapon, string>> = { mortars: "canons Branly", laser: "arc de proue", cannons: "soute à bombes" };
const ZENITH_COUNTERS = "Éperviers, Faucheux, Batteries de 47, Artificiers";
/**
 * A Goliath line reworded for the Zénith (the République's super-unit moors
 * where the Goliath anchors). No recorded clip says these yet (WP5g): they
 * show as captions and banners.
 */
function zenithLine(text: string): string {
  return text
    .split(GOLIATH_COUNTERS).join(ZENITH_COUNTERS)
    .split("Galerie des Machines").join("Hangar du Zénith")
    .split("lève l'ancre").join("largue les amarres")
    .split("en ancrage").join("en amarrage")
    .split("ancré").join("amarré")
    .split("Gargantua").join("Zénith");
}
/** "mortars", "mortars and laser", "mortars, laser and cannons". */
export const listWords = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`;
/** "Gargantua continue le combat" / "Gargantuas continuent le combat" (after "son"/"ses", "notre"/"nos"). */
const fightsOn = (n: number): string => (n > 1 ? "Gargantuas continuent le combat" : "Gargantua continue le combat");

interface Streak {
  /** Sim times of kills inside the window… */
  kills: number[];
  /** …and the calldown behind each one (null: a unit or building got it). */
  powers: (PowerKind | null)[];
  /** Highest tier already called in this streak. */
  tier: number;
  /** Tier waiting for its hold to expire (0 = none) and when it was reached. */
  pending: number;
  pendingAt: number;
  /** A big kill to mention under the streak banner. */
  big: string | null;
  x: number;
  y: number;
}

/**
 * Turns the fx stream into announcer lines and kill banners. Feed it each
 * tick's events with events(); it also polls a little world state there
 * (construction ready, visible aircraft, the winner).
 */
export class BattleCallouts {
  private last = new Map<string, number>();
  private ownDeaths: number[] = [];
  private streaks: Record<Faction, Streak> = {
    blue: { kills: [], powers: [], tier: 0, pending: 0, pendingAt: 0, big: null, x: 0, y: 0 },
    red: { kills: [], powers: [], tier: 0, pending: 0, pendingAt: 0, big: null, x: 0, y: 0 }
  };
  /** Names the Barrage / Sky Hammer behind a kill (calldown-credit.ts). */
  private credit: CalldownCredit;
  private firstBlood = false;
  private lastKillBanner = -Infinity;
  /** When each banner went up (CALLOUTS.bannersPerMinute). */
  private shown: number[] = [];
  private lastBigKill = -Infinity;
  private wasReady = false;
  private airSeen: Record<Faction, number> = { blue: -Infinity, red: -Infinity };
  private airArmed: Record<Faction, boolean> = { blue: true, red: true };
  private lastAirScan = -Infinity;
  /** An enemy strike we warned about lands about now: its hits are that news, not new news. */
  private strikeQuietUntil = -Infinity;
  /** Squads aboard each Condor (from embark / disembark events), to tell what went down with one. */
  private aboard = new Map<number, number>();
  /** Squads already aboard when the match began (the island map) have been counted. */
  private seeded = false;
  /** Each Goliath's weapon systems as last announced, so a reboot knocked back down isn't "down" twice. */
  private weaponState = new Map<number, Partial<Record<GoliathWeapon, "online" | "offline">>>();
  /** Goliaths whose lift just dropped them to their death: their death says "lost in the drop". */
  private droppedDead = new Set<number>();
  private ended = false;
  /** Lines and banners raised, by key (debug/measurement). */
  readonly counts = new Map<string, number>();

  constructor(private h: CalloutHooks) {
    this.credit = new CalldownCredit(h.world);
  }

  /** Feed one tick's events at sim time `t` (seconds). */
  events(fx: readonly FxEvent[], t: number): void {
    if (this.ended) return;
    this.transport(fx, t); // (first: a Condor lost with its squads says so instead of "Squad lost")
    let weapons: Extract<FxEvent, { type: "goliathWeapon" }>[] | null = null;
    for (const ev of fx) {
      const by = this.credit.see(ev);
      if (ev.type === "hit") this.hit(ev, t);
      else if (ev.type === "death") this.death(ev, t, by);
      else if (ev.type === "rankUp") this.rankUp(ev.id, t);
      else if (ev.type === "calldown") this.calldown(ev, t);
      // Goliaths and Gantries are always visible to the enemy: their news needs no fog check
      else if (ev.type === "goliathBuild") this.zenithAware(this.h.world.buildings.get(ev.buildingId)?.queue[0]?.kind, () => this.goliathBuild(ev, t));
      else if (ev.type === "goliathRollout") this.zenithAware(this.h.world.units.get(ev.id)?.kind, () => this.goliathRollout(ev, t));
      else if (ev.type === "goliathMode") this.zenithAware(this.h.world.units.get(ev.id)?.kind, () => this.goliathMode(ev, t));
      else if (ev.type === "goliathLift") this.goliathLift(ev, t);
      else if (ev.type === "goliathWeapon") (weapons ??= []).push(ev); // (one line for systems lost together)
    }
    if (weapons) this.zenithAware(undefined, () => this.goliathWeapons(weapons!, t));
    this.poll(t, fx);
  }

  /**
   * The awareness layer just warned of an inbound raid (awareness.ts): an
   * aircraft raid makes "Enemy aircraft detected" redundant for a while.
   */
  inbound(domain: "air" | "ground" | "mixed", t: number): void {
    if (domain === "ground" || this.h.spectator) return;
    const f = enemyOf(this.h.player);
    this.airArmed[f] = false;
    this.airSeen[f] = t;
  }

  /** An outside cue (HUD): "no-scrap", or "cant-build" for a refused placement. */
  cue(key: RadioCueKey, t: number): void {
    if (this.h.spectator || this.ended) return;
    if (key === "no-scrap" && this.ready("no-scrap", t))
      this.say({ key, text: "Charbon insuffisant", priority: 3, tone: "info", caption: false }, t);
    if (key === "cant-build" && this.ready("cant-build", t))
      this.say({ key, text: "Construction impossible ici", priority: 3, tone: "info", caption: false }, t);
  }

  // ------------------------------------------------------------- helpers --

  /** Is the cooldown for `key` over? (Doesn't start it.) */
  private ready(key: string, t: number, cd = CALLOUTS.cooldownS[key] ?? 0): boolean {
    return t - (this.last.get(key) ?? -Infinity) >= cd;
  }

  /** The news being told is a Zénith's: say() and raise() reword it (zenithLine). */
  private zenithNews = false;
  private zenithAware(kind: UnitKind | undefined, tell: () => void): void {
    this.zenithNews = kind === "zenith";
    try {
      tell();
    } finally {
      this.zenithNews = false;
    }
  }

  private say(line: RadioLine, t: number, cdKey = line.key): void {
    if (this.zenithNews) line = { ...line, text: zenithLine(line.text) };
    this.last.set(cdKey, t);
    this.counts.set(line.key, (this.counts.get(line.key) ?? 0) + 1);
    this.h.radio(line);
  }

  private banner(a: Announcement, t: number): void {
    // (a busy minute keeps its headlines and drops the flavour)
    if ((a.priority ?? 2) >= 2 && this.bannersWithin(t) >= CALLOUTS.bannersPerMinute) return;
    this.lastKillBanner = t;
    this.counts.set(a.key, (this.counts.get(a.key) ?? 0) + 1);
    this.shown.push(t);
    this.h.announce(a);
  }

  /** A banner that is news, not a kill: it starts its cooldown but doesn't hold back the next kill banner. */
  private raise(a: Announcement, t: number, cdKey = a.key): void {
    if (this.zenithNews) a = { ...a, text: zenithLine(a.text), ...(a.sub ? { sub: zenithLine(a.sub) } : {}) };
    this.last.set(cdKey, t);
    this.counts.set(a.key, (this.counts.get(a.key) ?? 0) + 1);
    this.shown.push(t);
    this.h.announce(a);
  }

  /** Banners shown in the 60 s up to `t` (older ones are forgotten). */
  private bannersWithin(t: number): number {
    while (this.shown.length > 0 && t - this.shown[0]! >= 60) this.shown.shift();
    return this.shown.length;
  }

  // -------------------------------------------------------------- events --

  private hit(ev: Extract<FxEvent, { type: "hit" }>, t: number): void {
    const h = this.h;
    if (ev.building) {
      const b = h.world.buildings.get(ev.id);
      if (!b) return;
      if (b.kind === "hq") {
        if (h.spectator) {
          const key = `hq-attack-${b.faction}`;
          if (this.ready(key, t, 40))
            this.say({ key, text: `GQG ${SIDE[b.faction]} attaqué`, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
          return;
        }
        if (b.faction !== h.player) return;
        // in view, the player already knows: remind less often
        const seen = h.onScreen(ev.x, ev.y);
        if (this.ready("hq-attack", t, seen ? CALLOUTS.cooldownS["hq-attack-seen"] : CALLOUTS.cooldownS["hq-attack"])) {
          this.say({ key: "hq-attack", text: "Alerte : notre GQG est attaqué", priority: 0, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
          this.last.set("base-attack", t);
        }
        return;
      }
      if (h.spectator || b.faction !== h.player || t < this.strikeQuietUntil) return;
      if (!h.onScreen(ev.x, ev.y) && this.ready("base-attack", t) && this.ready("hq-attack", t, 8))
        this.say({ key: "base-attack", text: "Notre base est attaquée", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
      return;
    }
    const g = h.world.units.get(ev.id);
    if (g?.goliath) {
      this.goliathHit(ev, t);
      return;
    }
    if (h.spectator || ev.faction !== h.player || h.onScreen(ev.x, ev.y) || t < this.strikeQuietUntil) return;
    if (this.ready("units-attack", t) && this.ready("squad-lost", t, 10))
      this.say({ key: "units-attack", text: "Nos unités sont sous le feu", priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
  }

  /**
   * A Goliath under fire: "Our Goliath is under attack" off screen (on
   * screen too while it is our base or our last life), at P0 when it is the
   * last life — no HQ (fallen, or never built: Nomads) and no other Goliath —
   * since losing it loses the match. Spectators hear about a side's last life only.
   */
  private goliathHit(ev: Extract<FxEvent, { type: "hit" }>, t: number): void {
    const h = this.h;
    const w = h.world;
    const last = !hqOf(w, ev.faction) && goliathsOf(w, ev.faction).length <= 1;
    if (h.spectator) {
      const key = `goliath-attack-${ev.faction}`;
      if (last && this.ready(key, t, 40))
        this.say({ key, text: `Gargantua ${SIDE[ev.faction]} attaqué`, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
      return;
    }
    if (ev.faction !== h.player) return;
    const g = w.units.get(ev.id)!;
    const seen = h.onScreen(ev.x, ev.y);
    // a walking Goliath fighting where the player is looking is no news
    if (seen && !baseGoliath(w, g)) return;
    const cd = CALLOUTS.cooldownS[seen ? "goliath-attack-seen" : "goliath-attack"];
    if (!this.ready("goliath-attack", t, cd)) return;
    // (the HUD's own "under attack" toast shows it: no caption)
    this.say({ key: "goliath-attack", text: "Notre Gargantua est attaqué", priority: last ? 0 : 1, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
    this.last.set("units-attack", t);
  }

  private death(ev: Extract<FxEvent, { type: "death" }>, t: number, by: CalldownKill | null): void {
    const h = this.h;
    const victim = ev.faction;
    const killer = enemyOf(victim);
    if (ev.buildingKind) {
      if (ev.buildingKind === "hq") {
        this.hqFell(ev, t, by);
        return;
      }
      const name = BUILDINGS[ev.buildingKind].name;
      if (by && !h.spectator && killer === h.player) {
        // our strike flattened a building: worth a cheer, not just a radio line —
        // under the strike's own streak banner if it's about to call one
        const s = this.streaks[killer];
        if (s.pending) {
          s.big ??= `${name} ${agree(ev.buildingKind, "détruit")}`;
          this.last.set("structure-killed", t);
          return;
        }
        if (t - this.lastKillBanner >= CALLOUTS.killBannerGapS) {
          this.last.set("structure-killed", t);
          this.banner(
            { key: "calldown-hit", text: "Coup au but !", say: "Coup en plein au but !", sub: `${powerName(by.power)} : ${name} ${hostile(ev.buildingKind)} ${agree(ev.buildingKind, "détruit")}`, tone: "good", priority: 3, x: ev.x, y: ev.y },
            t
          );
          return;
        }
      }
      if (h.spectator) {
        const key = `structure-killed-${victim}`;
        if (this.ready(key, t, 20))
          this.say({ key, text: `${name} ${SIDE[victim]} ${agree(ev.buildingKind, "détruit")}`, priority: 2, tone: "info", x: ev.x, y: ev.y, caption: true }, t);
      } else if (victim === h.player) {
        if (this.ready("structure-lost", t))
          this.say({ key: "structure-lost", text: `Bâtiment perdu : ${name}`, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
      } else if (this.ready("structure-killed", t)) {
        this.say({ key: "structure-killed", text: `${name} ${hostile(ev.buildingKind)} ${agree(ev.buildingKind, "détruit")}`, priority: 2, tone: "good", x: ev.x, y: ev.y, caption: true }, t);
      }
      return;
    }
    const kind = ev.unitKind;
    if (!kind) return;
    if (kind === "goliath") this.weaponState.delete(ev.id);
    if (h.spectator || killer === h.player) this.kill(ev, killer, t, by?.power ?? null);
    // (a Goliath is always said, on screen or off, and never folded into "Squad lost")
    if (!h.spectator && victim === h.player) {
      if (kind === "goliath") this.goliathLost(ev, t);
      else this.loss(ev, t);
    }
    this.droppedDead.delete(ev.id);
  }

  /**
   * An HQ fell. When that decides the match the winner line says it; when a
   * Goliath fights on (GOLIATH.md: a side is beaten only once its HQ and all
   * its Goliaths are gone), it is a banner: ours a P0 warning, theirs a
   * cheer that names what is left to win.
   */
  private hqFell(ev: Extract<FxEvent, { type: "death" }>, t: number, by: CalldownKill | null): void {
    const h = this.h;
    const w = h.world;
    if (w.winner) return; // the winner line covers it
    const f = ev.faction;
    const n = goliathsOf(w, f).length;
    if (h.spectator)
      this.raise({ key: `hq-fell-${f}`, text: `GQG ${SIDE[f]} détruit`, sub: `${SIDE[f]} : ${n > 1 ? "ses" : "son"} ${fightsOn(n)}`, tone: "epic", priority: 1, x: ev.x, y: ev.y }, t);
    else if (f === h.player)
      this.raise({ key: "hq-fell", text: "Notre GQG est tombé", sub: `${n > 1 ? "Nos" : "Notre"} ${fightsOn(n)}`, tone: "bad", priority: 0, x: ev.x, y: ev.y }, t);
    else {
      // our kill: a banner like any other big kill (it spaces out the streak banners after it)
      this.last.set("enemy-hq-fell", t);
      this.banner(
        {
          key: "enemy-hq-fell", text: "GQG ennemi détruit", sub: `Détruis ${n > 1 ? "ses Gargantuas" : "son Gargantua"} pour gagner`, tone: "epic", priority: 1,
          x: ev.x, y: ev.y, ...(by ? { say: `GQG ennemi détruit par ${powerPhrase(by.power)}` } : {})
        },
        t
      );
    }
  }

  /** Our Goliath went down: a P1 banner (P0 once the HQ is gone and the rest of our Goliaths are all that's left). */
  private goliathLost(ev: Extract<FxEvent, { type: "death" }>, t: number): void {
    const h = this.h;
    const w = h.world;
    const dropped = this.droppedDead.has(ev.id);
    this.last.set("unit-lost", t); // (no "Goliath lost" radio line on top)
    if (w.winner) return; // our last one: the defeat line says it
    const last = !hqOf(w, h.player);
    const left = goliathsOf(w, h.player).length;
    const parts = [dropped ? "Perdu dans la chute" : null, last && left > 0 ? (left === 1 ? "Notre dernier Gargantua résiste" : `${left} Gargantuas restants`) : null];
    const sub = parts.filter((x): x is string => !!x).join(" · ");
    this.raise(
      {
        key: "goliath-lost", text: "Gargantua perdu", tone: "bad", priority: last ? 0 : 1, x: ev.x, y: ev.y,
        ...(sub ? { sub } : {}), ...(dropped ? { say: "Gargantua perdu dans la chute" } : {})
      },
      t
    );
  }

  /** One of ours died: squad losses, harvesters and expensive hulls. */
  private loss(ev: Extract<FxEvent, { type: "death" }>, t: number): void {
    const h = this.h;
    const d = this.ownDeaths;
    d.push(t);
    while (d.length && t - d[0]! > CALLOUTS.squadWindowS) d.shift();
    if (d.length >= CALLOUTS.squadDeaths && this.ready("squad-lost", t)) {
      d.length = 0;
      this.say({ key: "squad-lost", text: "Escouade perdue", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
      return;
    }
    if (h.onScreen(ev.x, ev.y) || !this.ready("squad-lost", t, 4)) return;
    const kind = ev.unitKind!;
    if (kind === "harvester") {
      if (this.ready("harvester-lost", t))
        this.say({ key: "harvester-lost", text: "Fardier perdu", priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
    } else if ((ev.value >= CALLOUTS.bigLossValue || ev.rank >= 2) && this.ready("unit-lost", t)) {
      const vet = ev.rank >= 2 ? ` ${agree(kind, "vétéran")}` : "";
      this.say({ key: "unit-lost", text: `${UNITS[kind].name}${vet} ${agree(kind, "perdu")}`, priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
    }
  }

  /** A kill credited to `killer` (`power`: by its calldown): first blood, streaks, big game. */
  private kill(ev: Extract<FxEvent, { type: "death" }>, killer: Faction, t: number, power: PowerKind | null): void {
    const h = this.h;
    const name = UNITS[ev.unitKind!].name;
    const s = this.streaks[killer];
    if (!this.firstBlood) {
      this.firstBlood = true;
      const sub = h.spectator
        ? `${SIDE[killer]} frappe en premier${power ? ` (${powerName(power)})` : ""}`
        : power
          ? `${SHORT[ev.unitKind!] ?? name} ${hostile(ev.unitKind)} ${agree(ev.unitKind, "détruit")} par ${powerPhrase(power)}`
          : `${name} ${hostile(ev.unitKind)} ${agree(ev.unitKind, "détruit")}`;
      this.banner(
        {
          key: "first-blood", text: "Premier sang", tone: "epic", priority: 2, x: ev.x, y: ev.y, sub,
          ...(h.spectator ? { say: `Premier sang pour ${SIDE[killer]}` } : {})
        },
        t
      );
    }
    // streak bookkeeping (a gap longer than the window starts a new streak)
    while (s.kills.length && t - s.kills[0]! > CALLOUTS.streakWindowS) {
      s.kills.shift();
      s.powers.shift();
    }
    if (s.kills.length === 0) s.tier = 0;
    s.kills.push(t);
    s.powers.push(power);
    s.x = ev.x;
    s.y = ev.y;
    const tier = CALLOUTS.tiers.find((x) => s.kills.length >= x.n)?.n ?? 0;
    if (tier > s.tier && tier > s.pending) {
      if (!s.pending) s.pendingAt = t;
      s.pending = tier;
    }
    if (ev.unitKind === "goliath") {
      this.goliathKill(ev, killer, t, power);
      return;
    }
    const big = ev.value >= CALLOUTS.bigKillValue || ev.rank >= 3;
    if (big) {
      const label = `${SHORT[ev.unitKind!] ?? name}${ev.rank >= 3 ? " d'élite" : ""}`;
      const k = ev.unitKind;
      if (s.pending) s.big = `${label} ${agree(k, "détruit")}`; // rides along under the streak banner
      else if (t - this.lastBigKill >= CALLOUTS.bigKillCooldownS && t - this.lastKillBanner >= CALLOUTS.killBannerGapS) {
        this.lastBigKill = t;
        // short on the banner ("MASTODON DOWN" fits a phone), complete on the radio
        const how = power ? ` par ${powerPhrase(power)}` : "";
        this.banner(
          h.spectator
            ? { key: `kill-${ev.unitKind}`, text: `${label} ${SIDE[ev.faction]} ${agree(k, "abattu")}`, sub: `${SIDE[killer]} marque${power ? ` · ${powerName(power)}` : ""}`, tone: "good", priority: 3, x: ev.x, y: ev.y }
            : {
                key: `kill-${ev.unitKind}`, text: `${label} ${agree(k, "abattu")}`, say: `${label} ${hostile(k)} ${agree(k, "détruit")}${how}`, tone: "good", priority: 3, x: ev.x, y: ev.y,
                ...(power ? { sub: powerName(power) } : {})
              },
          t
        );
      }
    }
  }

  /**
   * A Goliath destroyed: always its own epic banner, never held back by the
   * big-kill cooldowns nor folded under a streak (a streak it ends gives way
   * to it). It names what is left when the HQ is already gone. The blow that
   * decides the match is left to the winner line and the finale.
   */
  private goliathKill(ev: Extract<FxEvent, { type: "death" }>, killer: Faction, t: number, power: PowerKind | null): void {
    const h = this.h;
    const w = h.world;
    if (w.winner) return;
    this.lastBigKill = t;
    const victim = ev.faction;
    const label = ev.rank >= 3 ? "Gargantua d'élite" : "Gargantua";
    const left = goliathsOf(w, victim).length;
    const leftNote = hqOf(w, victim) || left === 0 ? null : left === 1 ? "Plus qu'un Gargantua" : `${left} Gargantuas restants`;
    const dropped = this.droppedDead.has(ev.id) ? "Lâché par ses Montgolfières" : null;
    const parts = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).join(" · ");
    if (h.spectator) {
      const sub = parts([`${SIDE[killer]} marque`, power ? powerName(power) : dropped, leftNote]);
      this.banner({ key: "kill-goliath", text: `${label} ${SIDE[victim]} abattu`, sub, tone: "epic", priority: 1, x: ev.x, y: ev.y }, t);
      return;
    }
    const sub = parts([power ? powerName(power) : dropped, leftNote]);
    const how = power ? ` par ${powerPhrase(power)}` : "";
    this.banner(
      {
        key: "kill-goliath", text: `${label} abattu`, say: `${label} ennemi détruit${how}`, tone: "epic", priority: 1, x: ev.x, y: ev.y,
        ...(sub ? { sub } : {})
      },
      t
    );
  }

  private rankUp(id: number, t: number): void {
    const h = this.h;
    if (h.spectator) return;
    const u = h.world.units.get(id);
    if (!u || u.faction !== h.player || u.rank < 2 || !this.ready("promoted", t)) return;
    const text = u.rank >= 3 ? `${UNITS[u.kind].name} ${agree(u.kind, "promu")} élite` : `${UNITS[u.kind].name} ${agree(u.kind, "promu")}`;
    this.say({ key: "promoted", text, priority: 3, tone: "good", x: u.x, y: u.y, caption: true }, t);
  }

  // ---------------------------------------------------------------- poll --

  private poll(t: number, fx: readonly FxEvent[] = []): void {
    const h = this.h;
    const w = h.world;
    if (w.winner) {
      this.ended = true;
      // an op that ends on its objective is narrated by its own op-complete /
      // op-failed banner (spoken like any banner), so say nothing over it
      if (w.ops?.result?.byGoal) return;
      if (w.winner === "draw") {
        // Robot Love (rules.ts): two enemy Goliaths met and fell in love. Nobody won and nobody lost,
        // for players and spectators alike: its own last word, never a victory or a defeat
        const text = w.love ? "Ils sont tombés amoureux. Match nul." : "Match nul.";
        this.say({ key: "draw", text, priority: 0, tone: "good", caption: false, ...(w.love ? { x: w.love.x, y: w.love.y } : {}) }, t);
        return;
      }
      // what fell last: the HQ, or (the HQ long gone, or never there: Nomads) the last Goliath — the finale banner words it the same way
      const byGoliath = decidedByGoliath(fx, enemyOf(w.winner));
      if (w.survival) {
        // (watched or played, Last Stand only ends one way: matches the banner and the lament)
        const text = byGoliath ? "Base submergée. Le dernier Gargantua est tombé." : "Base submergée. Le GQG est tombé.";
        this.say({ key: "defeat", text, priority: 0, tone: "bad", caption: false }, t);
        return;
      }
      const loser = SIDE[enemyOf(w.winner)];
      const text = h.spectator
        ? `${byGoliath ? `Dernier Gargantua ${loser} détruit. ` : ""}${SIDE[w.winner]} remporte la bataille`
        : w.winner === h.player
          ? byGoliath ? "Dernier Gargantua ennemi détruit. Victoire !" : "GQG ennemi détruit. Victoire !"
          : byGoliath ? "Notre dernier Gargantua est tombé. Mission échouée." : "Notre GQG est tombé. Mission échouée.";
      this.say({ key: w.winner === h.player || h.spectator ? "victory" : "defeat", text, priority: 0, tone: w.winner === h.player || h.spectator ? "epic" : "bad", caption: false }, t);
      return;
    }
    // streak banners whose hold has run out
    for (const f of ["blue", "red"] as Faction[]) this.flushStreak(f, t);
    if (!h.spectator) {
      const ready = !!w.factions[h.player].pending?.ready;
      if (ready && !this.wasReady)
        this.say({ key: "construction", text: "Construction terminée", priority: 3, tone: "good", caption: false }, t);
      this.wasReady = ready;
    }
    if (t - this.lastAirScan >= CALLOUTS.airScanS) {
      this.lastAirScan = t;
      this.scanAir(t);
    }
  }

  private flushStreak(f: Faction, t: number): void {
    const s = this.streaks[f];
    if (!s.pending || t - s.pendingAt < CALLOUTS.streakHoldS) return;
    const tier = CALLOUTS.tiers.find((x) => x.n === s.pending)!;
    const escalation = s.tier > 0;
    s.tier = s.pending;
    s.pending = 0;
    const big = s.big;
    s.big = null;
    // mostly one calldown's work? Then it's that strike's banner, on its own (short) cooldown:
    // calldowns are rare, and a Sky Hammer triple kill shouldn't wait out a Stinger's
    const power = streakPower(s.powers);
    const cdKey = power ? `streak-calldown-${f}` : this.h.spectator ? tier.key : `${tier.key}-${f}`;
    const cooldown = power ? CALLOUTS.calldownStreakCooldownS : tier.cooldownS;
    if (t - this.lastKillBanner < (escalation ? CALLOUTS.escalateGapS : CALLOUTS.killBannerGapS)) return;
    if (!this.ready(cdKey, t, cooldown)) {
      // the streak was called recently: a big kill inside it still gets its own line
      if (big && t - this.lastBigKill >= CALLOUTS.bigKillCooldownS) {
        this.lastBigKill = t;
        const down = big.replace(/ détruit(e?)$/, " abattu$1");
        this.banner(
          this.h.spectator
            ? { key: "kill-big", text: down, sub: `${SIDE[f]} marque`, tone: "good", priority: 3, x: s.x, y: s.y }
            : { key: "kill-big", text: down, say: big, tone: "good", priority: 3, x: s.x, y: s.y },
          t
        );
      }
      return;
    }
    this.last.set(cdKey, t);
    if (big) this.lastBigKill = t;
    // a calldown's streak names it under the title (one line on a phone) and says it: "Sky Hammer: triple kill"
    const parts = [this.h.spectator ? SIDE[f] : null, power ? powerName(power) : null, big].filter((x): x is string => !!x);
    const sub = parts.length ? parts.join(" · ") : undefined;
    const said = power ? `${powerName(power)} : ${tier.text.toLowerCase()}` : tier.text;
    this.banner(
      {
        key: tier.key, text: tier.text, tone: tier.tone, priority: tier.priority, x: s.x, y: s.y,
        ...(sub ? { sub } : {}),
        // the caster says whose streak it is
        ...(this.h.spectator ? { say: `${said} pour ${SIDE[f]}` } : power ? { say: said } : {})
      },
      t
    );
  }

  /**
   * Condor drops: ours ("Troops deployed", a flavour line), the enemy's where
   * we can see it land (a warning), and a Condor of ours shot down — its
   * squads bailing out hurt, or lost with it over water or rock.
   */
  private transport(fx: readonly FxEvent[], t: number): void {
    const h = this.h;
    if (!this.seeded) {
      // a match can start with squads already aboard (the island map): count them in
      this.seeded = true;
      for (const u of h.world.units.values()) if (u.passengers?.length && !this.aboard.has(u.id)) this.aboard.set(u.id, u.passengers.length);
    }
    let bailed: Set<number> | null = null;
    for (const ev of fx) if (ev.type === "disembark" && ev.bailout) (bailed ??= new Set()).add(ev.carrierId);
    for (const ev of fx) {
      if (ev.type === "embark") this.aboard.set(ev.carrierId, (this.aboard.get(ev.carrierId) ?? 0) + 1);
      else if (ev.type === "death" && ev.unitKind && this.aboard.has(ev.id)) {
        const n = this.aboard.get(ev.id)!;
        this.aboard.delete(ev.id);
        // (a bail-out is announced by its disembark below)
        if (n === 0 || bailed?.has(ev.id) || h.spectator || ev.faction !== h.player || !this.ready("condor-down", t)) continue;
        this.say(
          { key: "condor-down", text: `Montgolfière abattue avec ${n === 1 ? "une escouade" : `${n} escouades`} à bord`, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true },
          t
        );
        this.last.set("squad-lost", t); // (the squads' own deaths are this news)
      } else if (ev.type === "lifeline") {
        // a free replacement Condor flying in (lifeline.ts)
        if (h.spectator || ev.faction !== h.player || !this.ready("lifeline", t, 10)) continue;
        this.say(
          { key: "lifeline", text: ev.squad ? "Montgolfière de remplacement en approche, une escouade à bord" : "Montgolfière de remplacement en approche", priority: 2, tone: "good", x: ev.x, y: ev.y, caption: true },
          t
        );
      } else if (ev.type === "disembark") {
        const left = (this.aboard.get(ev.carrierId) ?? 0) - ev.unitIds.length;
        if (left > 0) this.aboard.set(ev.carrierId, left);
        else this.aboard.delete(ev.carrierId);
        this.dropped(ev, t);
      }
    }
  }

  private dropped(ev: Extract<FxEvent, { type: "disembark" }>, t: number): void {
    const h = this.h;
    if (h.spectator) {
      const key = `drop-${ev.faction}`;
      if (!ev.bailout && this.ready(key, t, 30))
        this.say({ key, text: `Débarquement ${SIDE[ev.faction]}`, priority: 3, tone: "info", x: ev.x, y: ev.y, caption: true }, t);
      return;
    }
    if (ev.faction === h.player) {
      if (ev.bailout) {
        if (this.ready("condor-down", t))
          this.say({ key: "condor-down", text: "Montgolfière abattue ! Les troupes sautent", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
      } else if (this.ready("troops-deployed", t))
        this.say({ key: "troops-deployed", text: "Troupes déployées", priority: 3, tone: "good", x: ev.x, y: ev.y, caption: !h.onScreen(ev.x, ev.y) }, t);
      return;
    }
    // the enemy lands troops where we can see it
    if (ev.bailout || !isVisible(h.world, h.player, Math.floor(ev.x), Math.floor(ev.y)) || !this.ready("enemy-drop", t)) return;
    this.say({ key: "enemy-drop", text: "Débarquement ennemi !", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true, staleS: 3 }, t);
  }

  /** An enemy calldown aimed at our units or buildings: say what's coming while there's time to move. */
  private calldown(ev: Extract<FxEvent, { type: "calldown" }>, t: number): void {
    const h = this.h;
    if (h.spectator || ev.faction === h.player) return;
    if (!calldownThreatens(h.world, h.player, ev.x, ev.y, ev.radius)) return;
    // when it lands, "our units are under fire" would only repeat the warning
    this.strikeQuietUntil = Math.max(this.strikeQuietUntil, ev.landTick / TICK_RATE + 1.5);
    const line = CALLOUTS.calldownLines[ev.power]; // (the Sky Hammer has its own spoken banner)
    if (!line || !this.ready(line.key, t)) return;
    // the siren, the red circle and (off screen) a ticker line already show it: no caption
    this.say({ key: line.key, text: line.text, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: false, staleS: line.staleS }, t);
  }

  // ------------------------------------------------------------ goliaths --
  // (A Gantry and its Goliath are always visible to the enemy, so all of this is public news.)

  /**
   * A Gantry starts a Goliath, or nears the end of one: the enemy's is a
   * warning banner, then a P1 radio line so "nearly complete" is heard over
   * any chatter. Ours needs no line: the queue shows it, "Goliath ready" says when.
   */
  private goliathBuild(ev: Extract<FxEvent, { type: "goliathBuild" }>, t: number): void {
    const h = this.h;
    const f = ev.faction;
    const started = ev.stage === "started";
    if (h.spectator) {
      const key = `${started ? "goliath-build" : "goliath-soon"}-${f}`;
      if (this.ready(key, t, 20))
        this.say(
          { key, text: `Gargantua ${SIDE[f]} ${started ? "en production" : "presque terminé"}`, priority: started ? 2 : 3, tone: "info", x: ev.x, y: ev.y, caption: true },
          t
        );
      return;
    }
    if (f === h.player) return;
    if (started) {
      if (this.ready("enemy-goliath-build", t))
        this.raise({ key: "enemy-goliath-build", text: "Gargantua ennemi en production", sub: "Leur Galerie des Machines en construit un", tone: "bad", priority: 1, x: ev.x, y: ev.y }, t);
    } else if (this.ready("enemy-goliath-soon", t))
      this.say({ key: "enemy-goliath-soon", text: "Gargantua ennemi presque terminé", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true, staleS: 6 }, t);
  }

  /**
   * A Goliath walks off its Gantry: theirs a warning banner naming its
   * counters; ours a radio line (P1, so it's heard: the player paid for it,
   * and it reports in itself, voices.ts), keeping the banners for the news
   * the player didn't make.
   */
  private goliathRollout(ev: Extract<FxEvent, { type: "goliathRollout" }>, t: number): void {
    const h = this.h;
    const f = ev.faction;
    if (h.spectator) {
      const key = `goliath-field-${f}`;
      if (this.ready(key, t, 10)) this.raise({ key, text: `Gargantua ${SIDE[f]} sur le terrain`, tone: "epic", priority: 2, x: ev.x, y: ev.y }, t);
    } else if (f === h.player) {
      if (this.ready("goliath-ready", t))
        this.say({ key: "goliath-ready", text: "Gargantua prêt", priority: 1, tone: "good", x: ev.x, y: ev.y, caption: true }, t);
    } else if (this.ready("enemy-goliath", t))
      this.raise({ key: "enemy-goliath", text: "Gargantua ennemi sur le terrain", sub: `Contre : ${GOLIATH_COUNTERS}`, tone: "bad", priority: 1, x: ev.x, y: ev.y }, t);
  }

  /**
   * Walking ⇄ anchored: an enemy Goliath digging in (a base going up, maybe
   * on our doorstep) or packing up (the moment it's vulnerable); ours
   * anchored, captioned only when it happened off screen.
   */
  private goliathMode(ev: Extract<FxEvent, { type: "goliathMode" }>, t: number): void {
    const h = this.h;
    const f = ev.faction;
    if (h.spectator) {
      const key = `goliath-dig-${f}`;
      if (ev.mode === "anchoring" && this.ready(key, t, 20))
        this.say({ key, text: `Gargantua ${SIDE[f]} en ancrage`, priority: 2, tone: "info", x: ev.x, y: ev.y, caption: true }, t);
      return;
    }
    if (f === h.player) {
      if (ev.mode === "anchored" && this.ready("goliath-anchored", t))
        this.say({ key: "goliath-anchored", text: "Gargantua ancré", priority: 3, tone: "good", x: ev.x, y: ev.y, caption: !h.onScreen(ev.x, ev.y) }, t);
      return;
    }
    if (ev.mode === "anchoring" && this.ready("enemy-goliath-dig", t))
      this.say({ key: "enemy-goliath-dig", text: "Gargantua ennemi en ancrage", priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
    else if (ev.mode === "packing" && this.ready("enemy-goliath-pack", t))
      this.say({ key: "enemy-goliath-pack", text: "Gargantua ennemi lève l'ancre", priority: 3, tone: "info", x: ev.x, y: ev.y, caption: true }, t);
  }

  /**
   * Weapon systems going offline (damage) or back online (repaired), one
   * line per Goliath and direction this tick ("Enemy Goliath: mortars and
   * laser down!"). Each system has its own key, so "mortars down" waiting in
   * the queue isn't overwritten by "laser down"; a reboot knocked back down
   * is not news (it never came back).
   */
  private goliathWeapons(list: readonly Extract<FxEvent, { type: "goliathWeapon" }>[], t: number): void {
    const h = this.h;
    if (h.world.winner) return;
    const news = new Map<string, { ev: (typeof list)[number]; weapons: GoliathWeapon[] }>();
    for (const ev of list) {
      if (ev.state === "rebooting" || !GOLIATH_WORD[ev.weapon]) continue;
      let st = this.weaponState.get(ev.id);
      if (!st) this.weaponState.set(ev.id, (st = {}));
      if ((st[ev.weapon] ?? "online") === ev.state) continue;
      st[ev.weapon] = ev.state;
      const k = `${ev.id}:${ev.state}`;
      const n = news.get(k);
      if (n) n.weapons.push(ev.weapon);
      else news.set(k, { ev, weapons: [ev.weapon] });
    }
    const cd = CALLOUTS.cooldownS["goliath-weapon"];
    for (const { ev, weapons } of news.values()) {
      const f = ev.faction;
      const down = ev.state === "offline";
      const mine = !h.spectator && f === h.player;
      // each system's own key and cooldown, per side and direction
      const keyOf = (k: GoliathWeapon) =>
        h.spectator ? `goliath-${k}-${f}` : mine ? `goliath-${k}-${down ? "down" : "up"}` : `enemy-goliath-${k}${down ? "" : "-up"}`;
      if (h.spectator && !down) continue; // (casters call the losses)
      const fresh = weapons.filter((k) => this.ready(keyOf(k), t, cd));
      if (fresh.length === 0) continue;
      for (const k of fresh) this.last.set(keyOf(k), t);
      this.zenithNews = h.world.units.get(ev.id)?.kind === "zenith";
      const what = listWords(fresh.map((k) => (this.zenithNews ? ZENITH_WORD : GOLIATH_WORD)[k]!));
      const key = fresh.map(keyOf).join("+");
      const at = { x: ev.x, y: ev.y };
      if (h.spectator) this.say({ key, text: `Gargantua ${SIDE[f]} : ${what} hors service`, priority: 2, tone: "info", ...at, caption: true }, t);
      else if (mine && down) this.say({ key, text: `Gargantua : ${what} hors ligne`, priority: 1, tone: "bad", ...at, caption: true }, t);
      else if (mine) this.say({ key, text: `Gargantua : ${what} de nouveau en ligne`, priority: 3, tone: "good", ...at, caption: !h.onScreen(ev.x, ev.y) }, t);
      else if (down) this.say({ key, text: `Gargantua ennemi : ${what} hors service !`, priority: 2, tone: "good", ...at, caption: true }, t);
      else this.say({ key, text: `Gargantua ennemi : ${what} de nouveau en ligne`, priority: 2, tone: "bad", ...at, caption: true }, t);
    }
  }

  /**
   * Two Condors carrying a Goliath: airborne, and dropped when a Condor is
   * shot down (one dropped to its death is announced by its death: "lost in
   * the drop"). A planned set-down is no news.
   */
  private goliathLift(ev: Extract<FxEvent, { type: "goliathLift" }>, t: number): void {
    const h = this.h;
    const f = ev.faction;
    if (ev.state === "setDown") return;
    if (ev.state === "dropped" && ev.destroyed) {
      this.droppedDead.add(ev.id);
      return;
    }
    const hooked = ev.state === "hooked";
    const at = { x: ev.x, y: ev.y };
    if (h.spectator) {
      const key = `goliath-${hooked ? "airborne" : "dropped"}-${f}`;
      if (this.ready(key, t, 20)) this.say({ key, text: `Gargantua ${SIDE[f]} ${hooked ? "en vol" : "lâché !"}`, priority: 2, tone: "info", ...at, caption: true }, t);
      return;
    }
    if (f === h.player) {
      if (hooked && this.ready("goliath-airborne", t))
        this.say({ key: "goliath-airborne", text: "Gargantua en vol", priority: 3, tone: "good", ...at, caption: !h.onScreen(ev.x, ev.y) }, t);
      else if (!hooked && this.ready("goliath-dropped", t))
        this.say({ key: "goliath-dropped", text: "Gargantua lâché !", priority: 1, tone: "bad", ...at, caption: true }, t);
      return;
    }
    if (hooked && this.ready("enemy-goliath-airborne", t))
      this.say({ key: "enemy-goliath-airborne", text: "Gargantua ennemi en vol", priority: 2, tone: "bad", ...at, caption: true }, t);
    else if (!hooked && this.ready("enemy-goliath-dropped", t))
      this.say({ key: "enemy-goliath-dropped", text: "Gargantua ennemi lâché !", priority: 2, tone: "good", ...at, caption: true }, t);
  }

  /** "Enemy aircraft detected": the first visible enemy combat aircraft (re-armed after a long absence). */
  private scanAir(t: number): void {
    const h = this.h;
    const w = h.world;
    const sides: Faction[] = h.spectator ? ["blue", "red"] : [enemyOf(h.player)];
    for (const f of sides) {
      let spotted: { x: number; y: number } | null = null;
      for (const u of w.units.values()) {
        if (u.faction !== f) continue;
        const st = UNITS[u.kind];
        if (st.domain !== "air" || st.targets === "none") continue;
        if (!h.spectator && !isVisible(w, h.player, Math.floor(u.x), Math.floor(u.y))) continue;
        spotted = { x: u.x, y: u.y };
        break;
      }
      if (spotted) {
        if (this.airArmed[f]) {
          this.airArmed[f] = false;
          const key = h.spectator ? `air-${f}` : "enemy-air";
          const text = h.spectator ? `Aviation ${SIDE[f]} en approche` : "Aviation ennemie détectée";
          this.say({ key, text, priority: h.spectator ? 2 : 1, tone: "bad", x: spotted.x, y: spotted.y, caption: true }, t);
        }
        this.airSeen[f] = t;
      } else if (t - this.airSeen[f] > CALLOUTS.airRearmS) this.airArmed[f] = true;
    }
  }
}

/**
 * Did the deciding tick's deaths end it with `loser`'s last Goliath rather
 * than its HQ? (A side is beaten when its HQ falls with no Goliath left, or
 * its last Goliath falls with the HQ long gone; when both go in one tick the
 * HQ is what fell last.) The radio's winner line and the finale banner word
 * the end by it.
 */
export function decidedByGoliath(fx: readonly FxEvent[], loser: Faction): boolean {
  let goliath = false;
  for (const ev of fx) {
    if (ev.type !== "death" || ev.faction !== loser) continue;
    if (ev.buildingKind === "hq") return false;
    if (ev.unitKind === "goliath") goliath = true;
  }
  return goliath;
}

/**
 * The calldown that made most of a streak (at least two kills and half of
 * them), or null when units did the work.
 */
export function streakPower(powers: readonly (PowerKind | null)[]): PowerKind | null {
  const n = new Map<PowerKind, number>();
  for (const p of powers) if (p) n.set(p, (n.get(p) ?? 0) + 1);
  let best: PowerKind | null = null;
  let most = 0;
  for (const [p, k] of n)
    if (k > most) {
      best = p;
      most = k;
    }
  return best && most >= 2 && most * 2 >= powers.length ? best : null;
}

// ---------------------------------------------------------------- queue --

export const RADIO = {
  /** Minimum time between the starts of two lines (render seconds). */
  gapS: 2.5,
  /** Lines waiting longer than this are dropped (critical ones get longer). */
  staleS: 3,
  staleCriticalS: 6,
  /** Waiting lines kept at most. */
  cap: 2,
  /**
   * Chatter budget: routine lines (priority ≥ 2) are dropped once this many
   * lines went out inside the window; warnings (0–1) always get through.
   */
  budget: { windowS: 30, max: 3 }
} as const;

/**
 * The announcer's waiting list: most important first, at least RADIO.gapS
 * between lines, stale lines dropped, a line already waiting is refreshed
 * rather than repeated.
 */
export class RadioQueue {
  private items: { line: RadioLine; at: number }[] = [];
  private lastStart = -Infinity;
  private starts: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(line: RadioLine, now: number): void {
    const same = this.items.find((i) => i.line.key === line.key);
    if (same) {
      same.line = line;
      same.at = now;
      return;
    }
    this.items.push({ line, at: now });
    while (this.items.length > RADIO.cap) {
      // overflow: lose the least important line, the oldest of those first
      let worst = 0;
      for (let i = 1; i < this.items.length; i++) {
        const a = this.items[i]!;
        const b = this.items[worst]!;
        if (a.line.priority > b.line.priority || (a.line.priority === b.line.priority && a.at < b.at)) worst = i;
      }
      this.items.splice(worst, 1);
    }
  }

  /** The line to deliver now, if any: none while `busy` or inside the gap (unless `ignoreGap`). */
  next(now: number, busy = false, ignoreGap = false): RadioLine | null {
    this.items = this.items.filter(
      (i) => now - i.at <= (i.line.staleS ?? (i.line.priority === 0 ? RADIO.staleCriticalS : RADIO.staleS))
    );
    if (busy || this.items.length === 0 || (!ignoreGap && now - this.lastStart < RADIO.gapS)) return null;
    while (this.starts.length && now - this.starts[0]! > RADIO.budget.windowS) this.starts.shift();
    const spent = this.starts.length >= RADIO.budget.max;
    if (spent) this.items = this.items.filter((i) => i.line.priority < 2);
    let best = -1;
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i]!;
      const b = best >= 0 ? this.items[best]! : null;
      if (!b || a.line.priority < b.line.priority || (a.line.priority === b.line.priority && a.at < b.at)) best = i;
    }
    if (best < 0) return null;
    this.lastStart = now;
    this.starts.push(now);
    return this.items.splice(best, 1)[0]!.line;
  }

  /** Forget everything waiting (the match ended). */
  clear(): void {
    this.items = [];
  }
}

/** The match's last word (victory, defeat, or a draw): the announcer clears the queue for it and then falls silent. */
export const isEndLine = (line: Pick<RadioLine, "key">): boolean => line.key === "victory" || line.key === "defeat" || line.key === "draw";

/**
 * Make banner text speakable: drop emoji and symbols, turn SHOUTED banner
 * text into a sentence (keeping acronyms like HQ), end with punctuation.
 */
export function speakable(text: string): string {
  let s = text
    .replace(/[^\p{L}\p{N}\s.,!?'’:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
    s = s.replace(/\b(hq|qg|gqg|tsf|sam|emp|iem|dca|ia|mvp)\b/gi, (m) => m.toUpperCase());
  }
  return s;
}
