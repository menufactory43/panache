/**
 * Battle awareness and tempo: the engine-free rules behind the game-speed
 * chip, the "enemy inbound" warning, the off-screen hotspot arrows / jump
 * button and the on-screen battle meter. On a 6" screen you can't see the
 * fight you should react to, so the game points at it, warns before the
 * damage lands, and tells you who is winning the fight you're looking at.
 *
 * Everything here is fog-respecting: hotspots come only from hits on the
 * player's own things and shots fired by them, inbound warnings and the
 * meter only count enemies the player can currently see (never a Sniper
 * Team hidden in the woods). Spectators get everything. Detection windows and cooldowns are sim seconds, so the game
 * speed needs no special casing. Rendering and DOM live in
 * src/game/awareness-view.ts and src/ui/awareness.ts; this file is
 * unit-tested (tests/awareness.test.ts).
 */
import { behaves } from "../sim/nations";
import { BUILDINGS, ROLES, TICK_RATE, UNITS } from "../sim/balance";
import { pluralName } from "../sim/lexicon";
import { nationOf } from "../sim/rules";
import { isAnchored } from "../sim/goliath";
import { isTransport, unitSeenBy } from "../sim/infantry";
import { POWER_NAMES } from "../sim/powers";
import type { Faction, FxEvent, Unit, UnitKind, World } from "../sim/types";
import { hqOf } from "../sim/world";
import { CalldownCredit } from "./calldown-credit";

export const AWARE = {
  // ------------------------------------------------------------- speed --
  /** Speeds the chip cycles through (spectators add 4×). */
  speeds: [1, 1.5, 2],
  spectatorSpeeds: [1, 1.5, 2, 4],
  /** Press-and-hold the clock: at least this fast while held. */
  holdSpeed: 3,
  /** Sim ticks at most per rendered frame, so a slow phone can't spiral. */
  maxTicksPerFrame: 8,
  /** A frame longer than this (tab switch, GC hitch) counts as this long. */
  maxFrameMs: 250,
  // ---------------------------------------------------------- hotspots --
  /** Heat is bucketed into square cells this many tiles wide. */
  cell: 6,
  /** Heat left after one second (exponential decay). */
  decayPerS: 0.85,
  /** Heat added per event. */
  heat: { hitHq: 0.6, hitBuilding: 0.45, hitHarvester: 0.45, hitUnit: 0.35, ownShot: 0.2, ownDeath: 0.6, kill: 0.4 },
  /** A cluster of cells is a hotspot once its heat passes this. */
  hot: 1,
  /** Cells colder than this are ignored when clustering. */
  warm: 0.15,
  /** Hotspots closer than this (tiles) merge into one. */
  mergeTiles: 8,
  /** Edge arrows shown at most. */
  maxArrows: 3,
  // ----------------------------------------------------------- inbound --
  inbound: {
    /** Warn when visible armed enemies come within this many tiles of a building or harvester. */
    radius: 12,
    /** Scan this often (sim seconds): every tick, since raiders close a tile in ~0.3 s. */
    scanS: 0.1,
    /** Enemies closer than this to each other count as one group. */
    linkTiles: 5,
    /** A group (any of its units) seen in the zone within this long isn't new. */
    throttleS: 20,
    /** At most one spoken/printed warning per this long (arrows still show). */
    minGapS: 12,
    /**
     * A group that has been hitting our things for engagedForS and did so
     * within the last engagedS is a fight, not a raid on its way (one that
     * opened fire a moment ago still gets its warning and counter advice).
     */
    engagedS: 4,
    engagedForS: 1.5,
    /** An inbound hotspot (arrow) lives this long after the warning. */
    arrowS: 10
  },
  // ------------------------------------------------------------- meter --
  meter: {
    /** Units needed on each side, in view, for the meter to show. */
    minUnits: 2,
    /** …and shots fired in view within this many sim seconds. */
    shotWindowS: 3,
    /** Smoothing time constant of the displayed share, ms. */
    lerpMs: 300,
    /** "Turning point!" when the share swings this much… */
    swing: 0.2,
    /** …within this many sim seconds… */
    swingWindowS: 4,
    /** …at most this often. */
    swingCooldownS: 8,
    /** The meter lingers this long (sim s) after the fight condition lapses. */
    lingerS: 1.5
  }
} as const;

/**
 * Is this Goliath part of its side's base? An anchored one is (a drop-off,
 * a barracks, a build ring: GOLIATH.md), and once the side's HQ has fallen
 * any Goliath is: it is the last life, so the match is lost with it. Hits on
 * a base Goliath raise the same alarms as hits on a building.
 */
export function baseGoliath(w: World, u: Unit): boolean {
  return !!u.goliath && (isAnchored(u) || !hqOf(w, u.faction));
}

// ===================================================================== speed

const TICK_MS = 1000 / TICK_RATE;

/**
 * How many sim ticks this frame runs, given the carried accumulator (ms of
 * sim time owed), the real frame time and the game speed. Over the cap, the
 * backlog is dropped rather than carried, so a slow device slows the game
 * down instead of spiralling into ever longer frames.
 */
export function planTicks(acc: number, deltaMs: number, speed: number): { ticks: number; acc: number } {
  let a = acc + Math.min(Math.max(0, deltaMs), AWARE.maxFrameMs) * speed;
  const ticks = Math.min(AWARE.maxTicksPerFrame, Math.floor(a / TICK_MS));
  a -= ticks * TICK_MS;
  if (a >= TICK_MS) a %= TICK_MS;
  return { ticks, acc: a };
}

export const SPEED_KEY = "battledrones.speed";

/** Stored speeds: one for playing, one for watching AI vs AI. */
export interface StoredSpeed {
  play: number;
  watch: number;
}

export function parseSpeed(raw: string | null): StoredSpeed {
  const s: StoredSpeed = { play: 1, watch: 1 };
  if (!raw) return s;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof StoredSpeed, unknown>> | null;
    if (o && typeof o === "object") {
      if (typeof o.play === "number" && (AWARE.speeds as readonly number[]).includes(o.play)) s.play = o.play;
      if (typeof o.watch === "number" && (AWARE.spectatorSpeeds as readonly number[]).includes(o.watch)) s.watch = o.watch;
    }
  } catch {
    /* junk: defaults */
  }
  return s;
}

/** The match's game speed: a chosen base speed plus hold-to-fast-forward. */
export class GameSpeed {
  /** The chip's setting (1, 1.5, 2; spectators also 4). */
  base: number;
  /** The clock is being held down. */
  held = false;
  private stored: StoredSpeed;

  constructor(readonly spectator: boolean, raw: string | null = null) {
    this.stored = parseSpeed(raw);
    this.base = spectator ? this.stored.watch : this.stored.play;
  }

  get options(): readonly number[] {
    return this.spectator ? AWARE.spectatorSpeeds : AWARE.speeds;
  }

  /** The speed the sim runs at right now. */
  get value(): number {
    return this.held ? Math.max(this.base, AWARE.holdSpeed) : this.base;
  }

  /** Step the chip to the next speed (wrapping); returns the new base. */
  cycle(): number {
    const o = this.options;
    const i = o.indexOf(this.base);
    this.base = o[(i + 1) % o.length]!;
    if (this.spectator) this.stored.watch = this.base;
    else this.stored.play = this.base;
    return this.base;
  }

  /** What to persist under SPEED_KEY. */
  serialize(): string {
    return JSON.stringify(this.stored);
  }
}

/** "1×", "1.5×", "2×". */
export const speedLabel = (s: number): string => `${s}×`;

// ================================================================== hotspots

/** What a hotspot is about. */
export type HotKind = "defend" | "attack" | "inbound" | "fight";

export interface Hotspot {
  /** Stable-ish id (cell key or inbound group id), for DOM reuse. */
  key: string;
  kind: HotKind;
  /** Heat-weighted centre, tiles. */
  x: number;
  y: number;
  heat: number;
  /** Short arrow label: "HQ!", "Base", "Harvesters", "Units", "Attack", "Air raid"… */
  label: string;
  /** Sort key: higher is more urgent. */
  priority: number;
}

/** Victim classes, most important last: index = class. */
const CLASS_LABEL = ["Attaque", "Unités", "Fardiers", "Base", "GQG !"] as const;
/** Arrow priority per class (inbound sits between harvesters and base). */
const CLASS_PRIORITY = [10, 20, 30, 50, 60] as const;
const INBOUND_PRIORITY = 40;

interface Cell {
  /** Decaying heat per class: 0 = own attack, 1 units, 2 harvesters, 3 buildings, 4 HQ. */
  byClass: number[];
  /** Decaying heat-weighted position sums. */
  sx: number;
  sy: number;
  w: number;
  /** Whose HQ was hit here (spectators: "Red HQ"). */
  hq?: Faction;
}

export interface HeatHooks {
  world: World;
  player: Faction;
  spectator: boolean;
}

/**
 * Where the action is. Each tick's hits on the player's things (and shots
 * fired by the player's units and turrets) heat up 6×6-tile cells that cool
 * by 15% a second; warm neighbouring cells cluster, and a cluster hotter
 * than 1 is a hotspot. Spectators: every hit on either side counts.
 */
export class HeatMap {
  private cells = new Map<number, Cell>();
  private t = 0;
  /** Calldown kills are credited to the firing HQ: they must not heat up our own base. */
  private credit: CalldownCredit;

  constructor(private h: HeatHooks) {
    this.credit = new CalldownCredit(h.world);
  }

  /** Feed one tick's events at sim time `t`. */
  events(fx: readonly FxEvent[], t: number): void {
    const dt = Math.max(0, t - this.t);
    this.t = t;
    if (dt > 0) this.decay(Math.pow(AWARE.decayPerS, dt));
    const { world: w, player, spectator } = this.h;
    const H = AWARE.heat;
    for (const ev of fx) {
      const strike = this.credit.see(ev);
      if (ev.type === "hit") {
        if (!spectator && ev.faction !== player) continue;
        let cls: number;
        let heat: number;
        if (ev.building) {
          const hq = w.buildings.get(ev.id)?.kind === "hq";
          cls = hq ? 4 : 3;
          heat = hq ? H.hitHq : H.hitBuilding;
        } else {
          const u = w.units.get(ev.id);
          const harv = !!u && behaves(u.kind, "harvester");
          // (an anchored Goliath is a base: its arrow says so)
          const base = !!u?.goliath && isAnchored(u);
          cls = base ? 3 : harv ? 2 : 1;
          heat = base ? H.hitBuilding : harv ? H.hitHarvester : H.hitUnit;
        }
        this.add(ev.x, ev.y, cls, heat, cls === 4 ? ev.faction : undefined);
      } else if (ev.type === "shot" && !spectator) {
        const src = w.units.get(ev.sourceId) ?? w.buildings.get(ev.sourceId);
        if (!src || src.faction !== player) continue;
        // heat where our shooter is (we always know that), not at a target in the fog
        this.add(ev.x, ev.y, 0, H.ownShot);
      } else if (ev.type === "death" && !spectator && ev.unitKind) {
        if (ev.faction === player) this.add(ev.x, ev.y, behaves(ev.unitKind, "harvester") ? 2 : 1, H.ownDeath);
        else if (ev.killerId !== null && !strike) {
          // (our calldown's kills: we aimed it, so no "Attack" arrow — and never one at our own HQ)
          // a kill heats up where our killer stands (the victim may have been in the fog)
          const ku = w.units.get(ev.killerId);
          const kb = ku ? undefined : w.buildings.get(ev.killerId);
          if (ku?.faction === player) this.add(ku.x, ku.y, 0, H.kill);
          else if (kb?.faction === player) {
            const s = BUILDINGS[kb.kind].size / 2;
            this.add(kb.tx + s, kb.ty + s, 0, H.kill);
          }
        }
      }
    }
  }

  private add(x: number, y: number, cls: number, heat: number, hq?: Faction): void {
    const C = AWARE.cell;
    const cx = Math.floor(x / C);
    const cy = Math.floor(y / C);
    const key = cy * 4096 + cx;
    let c = this.cells.get(key);
    if (!c) {
      c = { byClass: [0, 0, 0, 0, 0], sx: 0, sy: 0, w: 0 };
      this.cells.set(key, c);
    }
    c.byClass[cls]! += heat;
    if (hq) c.hq = hq;
    c.sx += x * heat;
    c.sy += y * heat;
    c.w += heat;
  }

  private decay(k: number): void {
    for (const [key, c] of this.cells) {
      for (let i = 0; i < 5; i++) c.byClass[i]! *= k;
      c.sx *= k;
      c.sy *= k;
      c.w *= k;
      if (c.w < 0.02) this.cells.delete(key);
    }
  }

  /** Total heat of the cell holding (x, y) (debug/tests). */
  heatAt(x: number, y: number): number {
    const C = AWARE.cell;
    return this.cells.get(Math.floor(y / C) * 4096 + Math.floor(x / C))?.w ?? 0;
  }

  /** All current hotspots, most urgent first. */
  hotspots(): Hotspot[] {
    const warm = [...this.cells.entries()]
      .filter(([, c]) => c.w >= AWARE.warm)
      .sort((a, b) => b[1].w - a[1].w);
    type Cluster = { key: number; byClass: number[]; sx: number; sy: number; w: number; hq?: Faction };
    const clusters: Cluster[] = [];
    for (const [key, c] of warm) {
      const x = c.sx / c.w;
      const y = c.sy / c.w;
      const into = clusters.find((k) => Math.hypot(k.sx / k.w - x, k.sy / k.w - y) <= AWARE.mergeTiles);
      if (into) {
        for (let i = 0; i < 5; i++) into.byClass[i]! += c.byClass[i]!;
        into.sx += c.sx;
        into.sy += c.sy;
        into.w += c.w;
        into.hq ??= c.hq;
      } else clusters.push({ key, byClass: [...c.byClass], sx: c.sx, sy: c.sy, w: c.w, hq: c.hq });
    }
    const out: Hotspot[] = [];
    for (const k of clusters) {
      if (k.w < AWARE.hot) continue;
      // the most important thing being hit names it (a token hit doesn't count)
      let cls = 0;
      for (let i = 4; i >= 1; i--)
        if (k.byClass[i]! >= 0.3) {
          cls = i;
          break;
        }
      const spectator = this.h.spectator;
      const kind: HotKind = spectator ? "fight" : cls > 0 ? "defend" : "attack";
      out.push({
        key: `c${k.key}`,
        kind,
        x: k.sx / k.w,
        y: k.sy / k.w,
        heat: k.w,
        label: spectator ? (cls === 4 ? `GQG ${k.hq === "red" ? "Rouge" : "Bleu"}` : "Combat") : cls === 2 ? pluralName(ROLES[nationOf(this.h.world, this.h.player)].worker, nationOf(this.h.world, this.h.player)) : CLASS_LABEL[cls]!,
        priority: CLASS_PRIORITY[cls]! + Math.min(9, k.w)
      });
    }
    return out.sort((a, b) => b.priority - a.priority);
  }
}

/**
 * Merge inbound-group hotspots into the heat hotspots (a raid that is
 * already hitting something shows as that fight), most urgent first.
 */
export function mergeHotspots(heat: Hotspot[], inbound: Hotspot[]): Hotspot[] {
  const out = [...heat];
  for (const ib of inbound)
    if (!heat.some((h) => h.kind !== "attack" && Math.hypot(h.x - ib.x, h.y - ib.y) <= AWARE.mergeTiles)) out.push(ib);
  return out.sort((a, b) => b.priority - a.priority);
}

// =================================================================== inbound

export type RaidDomain = "air" | "ground" | "mixed";

export interface InboundWarning {
  /** Group id (stable while the group is tracked). */
  id: number;
  domain: RaidDomain;
  /** The group's most expensive kind present (by total cost). */
  lead: UnitKind;
  count: number;
  /** The group's unit ids when warned. */
  ids: number[];
  /** Group centre, tiles. */
  x: number;
  y: number;
  /** "Enemy drones inbound" (ticker, radio). */
  text: string;
  /** "Drones inbound" (the shouty banner: short enough for one line on a phone). */
  short: string;
  /** "Flak, Raptors or a Turret". */
  advice: string;
  /** The first warning of this domain this match (worth a banner). */
  first: boolean;
  /** Spoken/printed (false: inside the global gap, arrow only). */
  loud: boolean;
  t: number;
}

/** What to call a raid led by `lead`, and what beats it (from the duel matrix, tools/balance.ts). */
export function raidAdvice(domain: RaidDomain, lead: UnitKind): { what: string; advice: string; enemy: string } {
  // (`enemy`: "ennemi" agreed with `what`, for "Aéronefs ennemis en approche")
  if (domain === "mixed") return { what: "force de frappe", enemy: "ennemie", advice: "Faucheux et Creusot, ou une Hotchkiss" };
  if (domain === "air") {
    if (lead === "hornet") return { what: "bombardiers", enemy: "ennemis", advice: "Faucheux, Blériot ou une Batterie Ruggieri" };
    if (lead === "condor") return { what: "Montgolfières", enemy: "ennemies", advice: "Faucheux, Blériot ou une Batterie Ruggieri" };
    return { what: "aéronefs", enemy: "ennemis", advice: "Faucheux, Blériot ou une Hotchkiss" };
  }
  switch (lead) {
    case "goliath":
      // (the answers GOLIATH.md tunes it against; its Menders are the next thing to shoot)
      return { what: "Gargantua", enemy: "ennemi", advice: "Artificiers, Éole, Hydroglisseurs ou Albatros" };
    case "mastodon":
      return { what: "Creusot", enemy: "ennemis", advice: "Artificiers, Hydroglisseurs ou Éole" };
    case "trooper":
      return { what: "pioupious", enemy: "ennemis", advice: "Canons de 75, Hotchkiss ou Chasseurs alpins" };
    case "rocket-squad":
      return { what: "artificiers", enemy: "ennemis", advice: "Pioupious, Canons de 75 ou Chasseurs alpins" };
    case "sniper":
      return { what: "chasseurs alpins", enemy: "ennemis", advice: "fonce dessus avec Panhard ou Éole" };
    case "mortar":
      return { what: "artillerie", enemy: "ennemie", advice: "approche-toi avec Panhard ou Éole" };
    case "lancer":
      return { what: "Hydroglisseurs", enemy: "ennemis", advice: "Panhard ou Albatros" };
    default:
      return { what: "blindés", enemy: "ennemis", advice: "Creusot, Éole ou une Hotchkiss" };
  }
}

export interface InboundHooks {
  world: World;
  player: Faction;
}

interface Group {
  id: number;
  ids: number[];
  x: number;
  y: number;
  /** Sim time of the warning (arrow lifetime). */
  t: number;
  domain: RaidDomain;
}

/**
 * "Enemy drones inbound": watches for visible armed enemy units (and Condors,
 * loaded or not) coming within AWARE.inbound.radius tiles of the player's buildings or harvesters
 * (or a Goliath that is a base: baseGoliath), and warns once per group (a
 * group seen in the zone within the last 20 s isn't new), with counter
 * advice by domain. Only what the player can see counts, so it never reveals
 * anything the fog hides (an enemy Goliath is always seen: it can't hide).
 */
export class InboundWatch {
  /** Last sim time each enemy unit was seen inside the zone. */
  private seen = new Map<number, number>();
  /** Each enemy unit's current spree of hits on our things: first and latest sim time. */
  private hitBy = new Map<number, { first: number; last: number }>();
  private lastScan = -Infinity;
  private lastLoud = -Infinity;
  private nextId = 1;
  private warnedDomain = new Set<RaidDomain>();
  private groups: Group[] = [];
  /** Every warning raised (debug/measurement). */
  readonly log: InboundWarning[] = [];

  constructor(private h: InboundHooks) {}

  /** Feed every tick's events at sim time `t`; returns the new warnings (usually none). */
  events(fx: readonly FxEvent[], t: number): InboundWarning[] {
    const I = AWARE.inbound;
    for (const ev of fx)
      if (ev.type === "hit" && ev.faction === this.h.player) {
        const s = this.hitBy.get(ev.attackerId);
        if (s && t - s.last <= I.engagedS) s.last = t;
        else this.hitBy.set(ev.attackerId, { first: t, last: t });
      } else if (ev.type === "calldownImpact" && ev.power === "droppod" && ev.faction !== this.h.player) {
        // an enemy Drop Pod's crew was announced by its own reticle, siren and radio line: not a new raid
        for (const id of ev.unitIds) this.seen.set(id, t);
      }
    if (t - this.lastScan < I.scanS - 1e-6) return [];
    this.lastScan = t;
    const { world: w, player } = this.h;
    // what we guard: buildings (by footprint edge), harvesters, and a Goliath that is a base
    // (anchored, or our last life once the HQ is gone)
    const guards: { x: number; y: number; r: number }[] = [];
    for (const b of w.buildings.values())
      if (b.faction === player) {
        const s = BUILDINGS[b.kind].size;
        guards.push({ x: b.tx + s / 2, y: b.ty + s / 2, r: s / 2 });
      }
    for (const u of w.units.values()) {
      if (u.faction !== player) continue;
      if (behaves(u.kind, "harvester")) guards.push({ x: u.x, y: u.y, r: 0 });
      else if (baseGoliath(w, u)) guards.push({ x: u.x, y: u.y, r: UNITS[u.kind].radius });
    }
    if (guards.length === 0) return [];
    const near: { id: number; x: number; y: number; kind: UnitKind }[] = [];
    for (const u of w.units.values()) {
      if (u.faction === player) continue;
      const st = UNITS[u.kind];
      // only what can hurt what we guard: buildings and harvesters are ground targets
      // (a Condor counts: it may bring squads to land on top of us, and what it carries is hidden)
      if ((st.targets === "none" || st.targets === "air" || st.dps <= 0) && !isTransport(u.kind)) continue;
      if (!unitSeenBy(w, player, u)) continue;
      if (!guards.some((g) => Math.hypot(g.x - u.x, g.y - u.y) - g.r <= I.radius)) continue;
      near.push({ id: u.id, x: u.x, y: u.y, kind: u.kind });
    }
    // single-link groups
    const groupOf = new Map<number, number>();
    const groups: (typeof near)[] = [];
    for (let i = 0; i < near.length; i++) {
      if (groupOf.has(i)) continue;
      const g = [near[i]!];
      groupOf.set(i, groups.length);
      for (let k = 0; k < g.length; k++)
        for (let j = 0; j < near.length; j++)
          if (!groupOf.has(j) && Math.hypot(near[j]!.x - g[k]!.x, near[j]!.y - g[k]!.y) <= I.linkTiles) {
            groupOf.set(j, groups.length);
            g.push(near[j]!);
          }
      groups.push(g);
    }
    const out: InboundWarning[] = [];
    for (const g of groups) {
      const known = g.some((m) => t - (this.seen.get(m.id) ?? -Infinity) <= I.throttleS);
      for (const m of g) this.seen.set(m.id, t);
      const cx = g.reduce((s, m) => s + m.x, 0) / g.length;
      const cy = g.reduce((s, m) => s + m.y, 0) / g.length;
      // already shooting at us: that's a fight (the hotspot arrows have it)
      const engaged = g.some((m) => {
        const s = this.hitBy.get(m.id);
        return !!s && t - s.last <= I.engagedS && t - s.first >= I.engagedForS;
      });
      if (known || engaged) {
        // follow the tracked group so its arrow points at it
        const tracked = this.groups.find((q) => q.ids.some((id) => g.some((m) => m.id === id)));
        if (tracked) {
          tracked.x = cx;
          tracked.y = cy;
          tracked.ids = g.map((m) => m.id);
        }
        continue;
      }
      // domain and lead kind by cost
      const cost = new Map<UnitKind, number>();
      let air = 0;
      let total = 0;
      for (const m of g) {
        const c = UNITS[m.kind].cost;
        cost.set(m.kind, (cost.get(m.kind) ?? 0) + c);
        total += c;
        if (UNITS[m.kind].domain === "air") air += c;
      }
      const domain: RaidDomain = air >= total * 0.7 ? "air" : air <= total * 0.3 ? "ground" : "mixed";
      const pool = [...cost].filter(([k]) => (domain === "air" ? UNITS[k].domain === "air" : domain === "ground" ? UNITS[k].domain !== "air" : true));
      const lead = pool.sort((a, b) => b[1] - a[1])[0]![0];
      const { what, advice, enemy } = raidAdvice(domain, lead);
      const Cap = `${what[0]!.toUpperCase()}${what.slice(1)}`;
      const text = `${Cap} ${enemy} en approche`;
      const short = `${Cap} en approche`;
      const loud = t - this.lastLoud >= I.minGapS;
      if (loud) this.lastLoud = t;
      const first = loud && !this.warnedDomain.has(domain === "mixed" ? "ground" : domain);
      if (first) this.warnedDomain.add(domain === "mixed" ? "ground" : domain);
      const id = this.nextId++;
      this.groups.push({ id, ids: g.map((m) => m.id), x: cx, y: cy, t, domain });
      const warning: InboundWarning = { id, domain, lead, count: g.length, ids: g.map((m) => m.id), x: cx, y: cy, text, short, advice, first, loud, t };
      out.push(warning);
      this.log.push(warning);
    }
    // forget tracked groups whose arrow has expired, and stale memory
    this.groups = this.groups.filter((q) => t - q.t <= I.arrowS);
    if (this.seen.size > 400)
      for (const [id, s] of this.seen) if (t - s > I.throttleS) this.seen.delete(id);
    if (this.hitBy.size > 400)
      for (const [id, s] of this.hitBy) if (t - s.last > I.engagedS) this.hitBy.delete(id);
    return out;
  }

  /** Hotspots for the groups warned in the last AWARE.inbound.arrowS seconds. */
  hotspots(t: number): Hotspot[] {
    return this.groups
      .filter((g) => t - g.t <= AWARE.inbound.arrowS)
      .map((g) => ({
        key: `i${g.id}`,
        kind: "inbound" as const,
        x: g.x,
        y: g.y,
        heat: 1,
        label: g.domain === "air" ? "Raid aérien" : "Raid",
        priority: INBOUND_PRIORITY
      }));
  }
}

// ===================================================================== tempo

export const TEMPO = {
  /** An enemy calldown threatens our units within its radius plus this (tiles); buildings by centre, one more. */
  reach: 1,
  /** HQ hits (or, with the HQ gone, Goliath hits) are a new attack after this long without one (sim seconds). */
  hqQuietS: 20
} as const;

/** Does a calldown at (x, y) with this radius threaten any of `player`'s units or buildings? */
export function calldownThreatens(w: World, player: Faction, x: number, y: number, radius: number): boolean {
  const reach = radius + TEMPO.reach;
  for (const u of w.units.values()) if (u.faction === player && Math.hypot(u.x - x, u.y - y) <= reach) return true;
  for (const b of w.buildings.values()) {
    if (b.faction !== player) continue;
    const s = BUILDINGS[b.kind].size;
    if (Math.hypot(b.tx + s / 2 - x, b.ty + s / 2 - y) <= reach + 1) return true;
  }
  return false;
}

export interface TempoDrop {
  cause: "calldown" | "inbound" | "hq" | "goliath";
  /** "enemy Barrage inbound", "enemy drones inbound", "HQ under attack", "Goliath under attack". */
  note: string;
  x: number;
  y: number;
}

/**
 * Tempo safety. Telegraphs are timed in sim seconds — a Barrage gives 2.5 s,
 * the Sky Hammer 3 s — so at 2× or a held 3× they're gone before a thumb can
 * move. When the game runs faster than 1× and something needs the player's
 * hands, the speed drops back to 1×: an enemy calldown aimed at their units or
 * buildings, a (spoken) inbound raid warning, or the HQ coming under a new
 * attack (first hit after `hqQuietS` without one) — and once the HQ has
 * fallen, a Goliath coming under a new attack, since losing the last one
 * loses the match. Spectators never get this.
 */
export class TempoGuard {
  private lastHqHit = -Infinity;
  private lastGoliathHit = -Infinity;

  constructor(private h: { world: World; player: Faction }) {}

  /**
   * This tick's events at sim time `t`, the inbound warnings raised this tick,
   * and whether the game is running above 1×. Returns why to drop to 1× (the
   * most urgent cause: a calldown, then the HQ, then a raid), or null.
   */
  check(fx: readonly FxEvent[], t: number, warnings: readonly InboundWarning[], fast: boolean): TempoDrop | null {
    const { world: w, player } = this.h;
    let calldown: TempoDrop | null = null;
    let hq: TempoDrop | null = null;
    for (const ev of fx) {
      if (ev.type === "hit") {
        if (ev.faction !== player) continue;
        if (!ev.building) {
          // the last life: a Goliath with no HQ behind it (with the HQ standing, it's one more thing under fire)
          const sup = w.units.get(ev.id);
          if (!sup?.goliath || hqOf(w, player)) continue;
          if (t - this.lastGoliathHit > TEMPO.hqQuietS) hq ??= { cause: "goliath", note: `${UNITS[sup.kind].name} attaqué`, x: ev.x, y: ev.y };
          this.lastGoliathHit = t;
          continue;
        }
        if (w.buildings.get(ev.id)?.kind !== "hq") continue;
        // HQ hits are tracked at any speed, so speeding up mid-siege doesn't snap back
        if (t - this.lastHqHit > TEMPO.hqQuietS) hq ??= { cause: "hq", note: "GQG attaqué", x: ev.x, y: ev.y };
        this.lastHqHit = t;
      } else if (ev.type === "calldown" && ev.faction !== player && !calldown) {
        if (calldownThreatens(w, player, ev.x, ev.y, ev.radius))
          calldown = { cause: "calldown", note: `${POWER_NAMES[ev.power]} ${ev.power === "emp" ? "ennemie" : "ennemi"} en approche`, x: ev.x, y: ev.y };
      }
    }
    if (!fast) return null;
    const raid = warnings.find((wn) => wn.loud);
    return calldown ?? hq ?? (raid ? { cause: "inbound", note: raid.text, x: raid.x, y: raid.y } : null);
  }
}

// ===================================================================== meter

/** One side's strength in view. */
export interface SideTally {
  n: number;
  /** Σ cost × hp / maxHp. */
  value: number;
}

/**
 * Who is winning the fight in view? Units (and armed defences) inside the
 * view rectangle, scored cost × remaining HP fraction. Enemies count only if
 * the player can see them (`visible`, and `seen` for the unit itself: a
 * Sniper Team hidden in the woods doesn't count) — except a kind the enemy
 * always sees (a Goliath, fog or not); harvesters and other unarmed units
 * don't count. Spectators: `player` is blue and `visible` always true.
 */
export function tallyView(
  w: World,
  player: Faction,
  inView: (x: number, y: number) => boolean,
  visible: (x: number, y: number) => boolean,
  seen: (u: Unit) => boolean = () => true
): { own: SideTally; enemy: SideTally } {
  const own: SideTally = { n: 0, value: 0 };
  const enemy: SideTally = { n: 0, value: 0 };
  for (const u of w.units.values()) {
    const st = UNITS[u.kind];
    if (st.targets === "none" || !inView(u.x, u.y)) continue;
    const mine = u.faction === player;
    if (!mine && !st.alwaysVisible && (!visible(u.x, u.y) || !seen(u))) continue;
    const side = mine ? own : enemy;
    side.n++;
    side.value += st.cost * Math.max(0, u.hp) / st.hp;
  }
  for (const b of w.buildings.values()) {
    if (b.kind !== "turret" && b.kind !== "sam-site") continue;
    const st = BUILDINGS[b.kind];
    const s = st.size / 2;
    if (!inView(b.tx + s, b.ty + s)) continue;
    const mine = b.faction === player;
    if (!mine && !visible(b.tx + s, b.ty + s)) continue;
    (mine ? own : enemy).value += st.cost * Math.max(0, b.hp) / st.hp;
  }
  return { own, enemy };
}

export interface MeterView {
  /** Show the bar. */
  shown: boolean;
  /** Displayed own share 0..1 (smoothed). */
  share: number;
  /** A big swing just happened: toward the player ("up") or away ("down"). */
  turning: "up" | "down" | null;
}

/**
 * The battle meter's state: shows while ≥ 2 armed units per side are in view
 * and shots were fired there recently; the displayed share eases toward the
 * live one; a swing of more than 0.2 within 4 s flashes "Turning point!".
 */
export class BattleMeter {
  private share = 0.5;
  private shown = false;
  private lastOk = -Infinity;
  private history: { t: number; s: number }[] = [];
  private lastTurn = -Infinity;
  private shownAt = -Infinity;

  /**
   * One update. `tally` is this frame's view tally, `lastShotT` the sim time
   * of the latest shot fired in view, `t` sim seconds now, `dtMs` the real
   * frame time, `viewJumped` true when the camera moved a lot (a swing
   * caused by panning is not a turning point).
   */
  update(
    tally: { own: SideTally; enemy: SideTally },
    lastShotT: number,
    t: number,
    dtMs: number,
    viewJumped = false
  ): MeterView {
    const M = AWARE.meter;
    const fight =
      tally.own.n >= M.minUnits && tally.enemy.n >= M.minUnits && t - lastShotT <= M.shotWindowS;
    const live = tally.own.value + tally.enemy.value > 0 ? tally.own.value / (tally.own.value + tally.enemy.value) : 0.5;
    if (fight) this.lastOk = t;
    const wasShown = this.shown;
    this.shown = t - this.lastOk <= M.lingerS;
    if (!this.shown) {
      this.history = [];
      return { shown: false, share: this.share, turning: null };
    }
    if (!wasShown) {
      // appear at the live share (no slide in from 50/50)
      this.share = live;
      this.shownAt = t;
      this.history = [];
    } else if (fight) this.share += (live - this.share) * (1 - Math.exp(-Math.max(0, dtMs) / M.lerpMs));
    if (viewJumped) this.history = [];
    let turning: MeterView["turning"] = null;
    if (fight) {
      this.history.push({ t, s: live });
      while (this.history.length && t - this.history[0]!.t > M.swingWindowS) this.history.shift();
      const oldest = this.history[0]!;
      const d = live - oldest.s;
      if (Math.abs(d) > M.swing && t - this.lastTurn >= M.swingCooldownS && t - this.shownAt >= 1) {
        this.lastTurn = t;
        turning = d > 0 ? "up" : "down";
        this.history = [{ t, s: live }];
      }
    }
    return { shown: true, share: this.share, turning };
  }
}

// ================================================================= geometry

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the ray from the rect's centre toward (tx, ty) leaves the rect, and
 * the ray's angle (radians, 0 = right, clockwise in screen space).
 */
export function edgePoint(r: Rect, tx: number, ty: number): { x: number; y: number; angle: number } {
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const angle = Math.atan2(dy, dx);
  if (dx === 0 && dy === 0) return { x: cx, y: r.y0, angle: -Math.PI / 2 };
  const hx = (r.x1 - r.x0) / 2;
  const hy = (r.y1 - r.y0) / 2;
  const k = Math.min(dx !== 0 ? hx / Math.abs(dx) : Infinity, dy !== 0 ? hy / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k, angle };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Point at perimeter distance `s` (clockwise from the top-left corner). */
function perimeterPoint(r: Rect, s: number): { x: number; y: number } {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const P = 2 * (w + h);
  s = ((s % P) + P) % P;
  if (s < w) return { x: r.x0 + s, y: r.y0 };
  if (s < w + h) return { x: r.x1, y: r.y0 + (s - w) };
  if (s < 2 * w + h) return { x: r.x1 - (s - w - h), y: r.y1 };
  return { x: r.x0, y: r.y1 - (s - 2 * w - h) };
}

function perimeterS(r: Rect, p: { x: number; y: number }): number {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const d = [Math.abs(p.y - r.y0), Math.abs(p.x - r.x1), Math.abs(p.y - r.y1), Math.abs(p.x - r.x0)];
  const side = d.indexOf(Math.min(...d));
  if (side === 0) return p.x - r.x0;
  if (side === 1) return w + (p.y - r.y0);
  if (side === 2) return w + h + (r.x1 - p.x);
  return 2 * w + h + (r.y1 - p.y);
}

/**
 * Place a `size`-px square marker on the perimeter of `r` (the rect of
 * allowed marker centres) as close as possible to `p`, sliding along the
 * edge past any of `avoid` (HUD widgets, other markers). Returns null if no
 * free spot exists within `maxSlide` px of perimeter travel.
 */
export function placeOnEdge(
  r: Rect,
  p: { x: number; y: number },
  size: number,
  avoid: readonly Rect[],
  maxSlide = Infinity,
  step = 6
): { x: number; y: number } | null {
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
  const P = 2 * (r.x1 - r.x0 + r.y1 - r.y0);
  const s0 = perimeterS(r, p);
  const half = size / 2;
  const free = (q: { x: number; y: number }) => {
    const box = { x0: q.x - half, y0: q.y - half, x1: q.x + half, y1: q.y + half };
    return !avoid.some((a) => overlaps(box, a));
  };
  const limit = Math.min(maxSlide, P / 2);
  for (let d = 0; d <= limit; d += step) {
    const a = perimeterPoint(r, s0 + d);
    if (free(a)) return a;
    if (d === 0) continue;
    const b = perimeterPoint(r, s0 - d);
    if (free(b)) return b;
  }
  return null;
}
