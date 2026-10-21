import { TICK_RATE, UNITS } from "../sim/balance";
import type { BuildingKind, Faction, FxEvent, PowerKind, UnitKind, World } from "../sim/types";
import { elides, isFeminine } from "../sim/lexicon";
import { buildingCenter, hqOf } from "../sim/world";
import { CalldownCredit, powerName } from "./calldown-credit";

/**
 * The match chronicle: a render-side recorder (full information — it is
 * only shown after the match) that samples army strength over time and logs
 * deaths, so the after-action report can tell the story: first blood, the
 * biggest battle, the turning point, the MVP unit and one tip.
 *
 * No three.js here: the analysis functions are pure and unit-tested.
 */

/** Sample every 5 s of game time. */
export const SAMPLE_TICKS = 50;

const FACTIONS: Faction[] = ["blue", "red"];
const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

export interface Sample {
  /** Game seconds. */
  t: number;
  /** Σ cost × hp/maxHp of each side's non-harvester units. */
  army: Record<Faction, number>;
  /** Scrap in the bank. */
  bank: Record<Faction, number>;
  harvesters: Record<Faction, number>;
}

export interface DeathRec {
  t: number;
  x: number;
  y: number;
  /** The victim's side. */
  faction: Faction;
  unitKind: UnitKind | null;
  buildingKind: BuildingKind | null;
  value: number;
  killerKind: UnitKind | null;
  /** Killed by a building (turret, SAM, HQ gun) rather than a unit. */
  byBuilding: boolean;
  /** Killed by a commander calldown (then not `byBuilding`), and which one (calldown id). */
  power?: PowerKind | null;
  strike?: number | null;
}

/** A commander calldown and what it did (both sides; full information). */
export interface StrikeRec {
  id: number;
  /** Game seconds when it was called. */
  t: number;
  faction: Faction;
  power: PowerKind;
  x: number;
  y: number;
  /** The target side's units under the reticle when it was called (what there was to dodge). */
  exposed: number;
  /** Units and buildings it hit when it landed (summed over a Barrage's shells; an EMP: what it froze). */
  hits: number;
  /** What it destroyed: units, buildings, their scrap value. */
  units: number;
  buildings: number;
  value: number;
}

export interface HeroRec {
  id: number;
  faction: Faction;
  kind: UnitKind;
  kills: number;
  rank: number;
  alive: boolean;
  /** Game seconds at death, or null if it survived. */
  diedAt: number | null;
}

/**
 * A story beat: first blood, the biggest battle, the turning point (or the
 * moment one side pulled away), the first Goliath to walk off a Gantry, an
 * HQ that fell while its Goliath fought on (GOLIATH.md: the match goes on),
 * and Robot Love's ending, two Goliaths falling in love (a draw).
 */
export type MomentKind = "first-blood" | "battle" | "turn" | "lead" | "goliath" | "hq" | "love";

export interface Moment {
  kind: MomentKind;
  /** Game seconds. */
  t: number;
  title: string;
  text: string;
  /** Who the moment favours from the reader's point of view (colours the row). */
  tone: "good" | "bad" | "neutral";
}

/** Where on the map something happened, in words. */
export interface MapRefs {
  width: number;
  height: number;
  hq: Partial<Record<Faction, { x: number; y: number }>>;
}

// ------------------------------------------------------------- recorder ---

export class Chronicle {
  readonly samples: Sample[] = [];
  readonly deaths: DeathRec[] = [];
  /** Every calldown, in order. */
  readonly strikes: StrikeRec[] = [];
  /** Units and buildings completed, per side and kind. */
  readonly built: Record<Faction, Record<string, number>> = { blue: {}, red: {} };
  /** Game second each building kind was first completed. */
  readonly firstBuilt: Record<Faction, Record<string, number>> = { blue: {}, red: {} };
  /** Goliaths each side started with (Nomads: one each, never "built"). */
  readonly startGoliaths: Record<Faction, number> = { blue: 0, red: 0 };
  /** Factory samples: total, and idle while the side could afford a unit. */
  readonly factories: Record<Faction, { total: number; idleRich: number }> = {
    blue: { total: 0, idleRich: 0 },
    red: { total: 0, idleRich: 0 }
  };
  readonly refs: MapRefs;
  /** Robot Love: when and where two enemy Goliaths fell in love and ended the match in a draw. */
  love: { t: number; x: number; y: number } | null = null;
  /** The best fallen unit per side (living units are checked at the end). */
  private fallen: Record<Faction, HeroRec | null> = { blue: null, red: null };
  private finished = false;
  private credit: CalldownCredit;

  constructor(private w: World) {
    this.credit = new CalldownCredit(w);
    const hq: MapRefs["hq"] = {};
    for (const f of FACTIONS) {
      const b = hqOf(w, f);
      if (b) hq[f] = buildingCenter(b);
    }
    this.refs = { width: w.width, height: w.height, hq };
    for (const u of w.units.values()) if (u.goliath) this.startGoliaths[u.faction]++;
    this.sample();
  }

  private get t(): number {
    return this.w.tick / TICK_RATE;
  }

  /** Call once per sim tick (after step). */
  tick(): void {
    if (this.finished) return;
    if (this.w.tick % SAMPLE_TICKS === 0) this.sample();
  }

  onFx(ev: FxEvent): void {
    if (this.finished) return;
    const by = this.credit.see(ev);
    if (ev.type === "calldown") {
      const victim = other(ev.faction);
      let exposed = 0;
      for (const u of this.w.units.values())
        if (u.faction === victim && Math.hypot(u.x - ev.x, u.y - ev.y) <= ev.radius) exposed++;
      this.strikes.push({
        id: ev.id, t: this.t, faction: ev.faction, power: ev.power, x: ev.x, y: ev.y, exposed, hits: 0, units: 0, buildings: 0, value: 0
      });
    } else if (ev.type === "calldownImpact") {
      const st = this.strikes.find((s) => s.id === ev.id);
      if (st) st.hits += ev.hits;
    } else if (ev.type === "death") {
      this.deaths.push({
        t: this.t, x: ev.x, y: ev.y, faction: ev.faction, unitKind: ev.unitKind, buildingKind: ev.buildingKind,
        value: ev.value, killerKind: ev.killerKind, byBuilding: !by && ev.killerId !== null && ev.killerKind === null,
        power: by?.power ?? null, strike: by?.calldownId ?? null
      });
      const st = by ? this.strikes.find((s) => s.id === by.calldownId) : undefined;
      if (st) {
        if (ev.buildingKind) st.buildings++;
        else st.units++;
        st.value += ev.value;
      }
      if (ev.unitKind && ev.kills > 0) {
        const rec: HeroRec = {
          id: ev.id, faction: ev.faction, kind: ev.unitKind, kills: ev.kills, rank: ev.rank, alive: false, diedAt: this.t
        };
        if (betterHero(rec, this.fallen[ev.faction])) this.fallen[ev.faction] = rec;
      }
    } else if (ev.type === "built") {
      const kind = this.w.units.get(ev.id)?.kind ?? this.w.buildings.get(ev.id)?.kind;
      if (!kind) return;
      const b = this.built[ev.faction];
      b[kind] = (b[kind] ?? 0) + 1;
      const fb = this.firstBuilt[ev.faction];
      if (fb[kind] === undefined) fb[kind] = this.t;
    } else if (ev.type === "love") {
      this.love = { t: this.t, x: ev.x, y: ev.y };
    }
  }

  sample(): void {
    const w = this.w;
    const army = { blue: 0, red: 0 };
    const harvesters = { blue: 0, red: 0 };
    for (const u of w.units.values()) {
      if (u.kind === "harvester") harvesters[u.faction]++;
      else army[u.faction] += (UNITS[u.kind].cost * Math.max(0, u.hp)) / UNITS[u.kind].hp;
      // squads riding in a Condor still count toward the army
      for (const p of u.passengers ?? []) army[p.faction] += (UNITS[p.kind].cost * Math.max(0, p.hp)) / UNITS[p.kind].hp;
    }
    for (const b of w.buildings.values()) {
      // (no Gantry: it builds one Goliath at a time and idles between them by design)
      if (b.kind !== "fab-plant" && b.kind !== "airpad" && b.kind !== "assembly-bay") continue;
      const fc = this.factories[b.faction];
      fc.total++;
      if (b.queue.length === 0 && w.factions[b.faction].scrap >= 150) fc.idleRich++;
    }
    const s: Sample = {
      t: this.t,
      army,
      bank: { blue: Math.floor(w.factions.blue.scrap), red: Math.floor(w.factions.red.scrap) },
      harvesters
    };
    const last = this.samples[this.samples.length - 1];
    if (last && last.t === s.t) this.samples[this.samples.length - 1] = s;
    else this.samples.push(s);
  }

  /** Close the record when the match ends (idempotent): a final sample. */
  finish(): void {
    if (this.finished) return;
    this.sample();
    this.finished = true;
  }

  /** The best unit per side by kills, fallen or alive. */
  mvp(): Record<Faction, HeroRec | null> {
    const best: Record<Faction, HeroRec | null> = { ...this.fallen };
    // (squads riding in a Condor are off the field, but very much alive)
    for (const u of this.w.units.values())
      for (const x of u.passengers?.length ? [u, ...u.passengers] : [u]) {
        if (x.kills <= 0) continue;
        const rec: HeroRec = { id: x.id, faction: x.faction, kind: x.kind, kills: x.kills, rank: x.rank, alive: true, diedAt: null };
        if (betterHero(rec, best[x.faction])) best[x.faction] = rec;
      }
    return best;
  }
}

/** More kills wins; then higher rank; then the survivor. */
export function betterHero(a: HeroRec, b: HeroRec | null): boolean {
  if (!b) return true;
  if (a.kills !== b.kills) return a.kills > b.kills;
  if (a.rank !== b.rank) return a.rank > b.rank;
  return a.alive && !b.alive;
}

const chronicles = new WeakMap<World, Chronicle>();

/** The match's chronicle (created on first use, at match start). */
export function chronicleOf(w: World): Chronicle {
  let c = chronicles.get(w);
  if (!c) chronicles.set(w, (c = new Chronicle(w)));
  return c;
}

// ------------------------------------------------------------- analysis ---

export const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** "au centre", "à ta base", "au nord-est"… */
export function placeName(refs: MapRefs, x: number, y: number, pov: Faction | null): string {
  for (const f of FACTIONS) {
    const h = refs.hq[f];
    if (!h || Math.hypot(h.x - x, h.y - y) > 11) continue;
    if (pov === null) return `à la base ${f === "blue" ? "bleue" : "rouge"}`;
    return f === pov ? "à ta base" : "à leur base";
  }
  const dx = x - refs.width / 2;
  const dy = y - refs.height / 2;
  if (Math.hypot(dx, dy) < Math.min(refs.width, refs.height) * 0.14) return "au centre";
  const dirs = ["au nord", "au nord-est", "à l'est", "au sud-est", "au sud", "au sud-ouest", "à l'ouest", "au nord-ouest"];
  const a = Math.atan2(dx, -dy); // 0 = north, clockwise
  const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[i]!;
}

export interface Battle {
  t: number;
  tEnd: number;
  x: number;
  y: number;
  count: number;
  lost: Record<Faction, number>;
  /** The calldown that did the most of it (≥ 2 deaths): whose losses, to what, how many. */
  strike?: { victim: Faction; power: PowerKind; n: number } | null;
}

/**
 * The biggest battle: the most deaths inside a `window`-second span within
 * `radius` tiles of one spot (anchored on each death in turn). At least
 * `min` deaths with losses on both sides, else null.
 */
export function biggestBattle(deaths: DeathRec[], window = 20, radius = 10, min = 4): Battle | null {
  let best: Battle | null = null;
  let bestScore = 0;
  for (let i = 0; i < deaths.length; i++) {
    const a = deaths[i]!;
    const group = deaths.filter((d) => d.t >= a.t && d.t <= a.t + window && Math.hypot(d.x - a.x, d.y - a.y) <= radius);
    if (group.length < min) continue;
    const lost = { blue: 0, red: 0 };
    for (const d of group) lost[d.faction]++;
    if (lost.blue === 0 || lost.red === 0) continue; // a massacre, not a battle
    // more deaths wins; value breaks ties (a mastodon brawl over a scout cull)
    const score = group.length * 10000 + group.reduce((v, d) => v + d.value, 0);
    if (score <= bestScore) continue;
    bestScore = score;
    best = {
      t: group[0]!.t,
      tEnd: group[group.length - 1]!.t,
      x: group.reduce((s, d) => s + d.x, 0) / group.length,
      y: group.reduce((s, d) => s + d.y, 0) / group.length,
      count: group.length,
      lost,
      strike: topStrike(group)
    };
  }
  return best;
}

/** The calldown power with the most kills among these deaths (at least 2), by victim side. */
function topStrike(group: DeathRec[]): Battle["strike"] {
  const n = new Map<string, { victim: Faction; power: PowerKind; n: number }>();
  for (const d of group) {
    if (!d.power) continue;
    const k = `${d.faction}:${d.power}`;
    const e = n.get(k) ?? { victim: d.faction, power: d.power, n: 0 };
    e.n++;
    n.set(k, e);
  }
  let best: Battle["strike"] = null;
  for (const e of n.values()) if (e.n >= 2 && (!best || e.n > best.n)) best = e;
  return best;
}

/**
 * A calldown by `by` that killed at least 2 units (or 400 scrap) in the
 * `window` seconds up to `t` (plus a few after): the strike that swung it.
 */
export function swingStrike(deaths: DeathRec[], by: Faction, t: number, window = 20): PowerKind | null {
  const tally = new Map<number, { power: PowerKind; n: number; value: number }>();
  for (const d of deaths) {
    if (!d.power || d.strike == null || d.faction === by || d.t < t - window || d.t > t + 5) continue;
    const e = tally.get(d.strike) ?? { power: d.power, n: 0, value: 0 };
    e.n++;
    e.value += d.value;
    tally.set(d.strike, e);
  }
  let best: { power: PowerKind; n: number; value: number } | null = null;
  for (const e of tally.values()) if ((e.n >= 2 || e.value >= 400) && (!best || e.value > best.value)) best = e;
  return best?.power ?? null;
}

export interface Turn {
  t: number;
  /** The side that took the lead. */
  leader: Faction;
  /** Seconds the new lead held (to the end of the samples at most). */
  held: number;
  /** Did it hold to the end? */
  toEnd: boolean;
  army: Record<Faction, number>;
}

/** Who leads on army value at a sample: null when it's too close to call. */
export function leaderAt(s: Sample): Faction | null {
  const diff = s.army.blue - s.army.red;
  const margin = Math.max(120, 0.12 * Math.max(s.army.blue, s.army.red));
  return Math.abs(diff) < margin ? null : diff > 0 ? "blue" : "red";
}

/**
 * Turning point: the last time the army-value lead passed to the other side
 * and stayed there (never trailing again) for at least `hold` seconds. A
 * brief swing that doesn't hold is noise, and the first established lead
 * isn't a turn.
 */
export function turningPoint(samples: Sample[], hold = 30): Turn | null {
  // runs of one side leading; too-close-to-call samples extend the run
  const runs: { leader: Faction; i0: number; i1: number }[] = [];
  samples.forEach((s, i) => {
    const l = leaderAt(s);
    const cur = runs[runs.length - 1];
    if (cur && (l === null || l === cur.leader)) cur.i1 = i;
    else if (l) runs.push({ leader: l, i0: i, i1: i });
  });
  let established: Faction | null = null;
  let found: Turn | null = null;
  runs.forEach((r, k) => {
    // a run lasts until the other side's next lead (or the end)
    const next = runs[k + 1];
    const endT = next ? samples[next.i0]!.t : samples[samples.length - 1]!.t;
    const held = endT - samples[r.i0]!.t;
    if (held < hold) return;
    if (established && established !== r.leader) {
      const s = samples[r.i0]!;
      found = { t: s.t, leader: r.leader, held, toEnd: !next, army: { ...s.army } };
    }
    established = r.leader;
  });
  return found;
}

/**
 * When a side pulled decisively away (≥ 1.5× and ≥ 400 ahead) and stayed
 * there to the end, for at least `hold` seconds — the story of a match whose
 * lead never changed hands.
 */
export function pulledAway(samples: Sample[], hold = 30): { t: number; leader: Faction; army: Record<Faction, number> } | null {
  if (samples.length < 2) return null;
  const decisive = (s: Sample, l: Faction) => {
    const a = s.army[l];
    const b = s.army[other(l)];
    return a >= 1.5 * b && a - b >= 400;
  };
  const last = samples[samples.length - 1]!;
  const l: Faction = last.army.blue >= last.army.red ? "blue" : "red";
  let i = samples.length;
  while (i > 0 && decisive(samples[i - 1]!, l)) i--;
  if (i >= samples.length || last.t - samples[i]!.t < hold) return null;
  return { t: samples[i]!.t, leader: l, army: { ...samples[i]!.army } };
}

export const firstBlood = (deaths: DeathRec[]): DeathRec | null => deaths.find((d) => d.unitKind !== null) ?? null;

const unitName = (k: UnitKind | null) => (k ? UNITS[k].name : "");
const shortK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** An HQ that fell this long before the end of the match was fought on without (sim seconds). */
const FOUGHT_ON_S = 5;

/** The first Goliath of the match (either side), from the first-built log. */
function firstGoliath(firstBuilt: Record<Faction, Record<string, number>> | undefined): { faction: Faction; t: number } | null {
  let best: { faction: Faction; t: number } | null = null;
  for (const f of FACTIONS) {
    const t = firstBuilt?.[f]["goliath"];
    if (t !== undefined && (!best || t < best.t)) best = { faction: f, t };
  }
  return best;
}

/**
 * The story beats, in time order, phrased for `pov` (null = spectator). With
 * `firstBuilt` (the chronicle has it) the Goliath beats join in: the first
 * one to walk off a Gantry, and an HQ that fell while its Goliath fought on.
 * One Goliath beat (the match's first, not one per side) and at most one HQ
 * beat per side, so the chart's numbered marks stay readable. With `love`, a
 * Robot Love draw is the last beat.
 */
export function moments(
  c: {
    samples: Sample[];
    deaths: DeathRec[];
    refs: MapRefs;
    firstBuilt?: Record<Faction, Record<string, number>>;
    love?: { t: number; x: number; y: number } | null;
  },
  pov: Faction | null
): Moment[] {
  const out: Moment[] = [];
  // gender of the names used in running text ("ta Patrie", "ton Creusot") comes from sim/lexicon.ts
  const adj = (f: Faction, fem: boolean, pl: boolean) => (f === "blue" ? "bleu" + (fem ? "e" : "") : "rouge") + (pl ? "s" : "");
  /** "ton Creusot" / "leur Patrie" / "la Patrie bleue" / "l'Éole rouge" / "tes défenses"… */
  const whose = (f: Faction, noun: string, fem = false, pl = false): string => {
    const vowel = elides(noun);
    if (pov === null) {
      const art = pl ? "les " : vowel ? "l'" : fem ? "la " : "le ";
      return `${art}${noun} ${adj(f, fem, pl)}`;
    }
    if (f === pov) return `${pl ? "tes" : fem && !vowel ? "ta" : "ton"} ${noun}`;
    return `${pl ? "leurs" : "leur"} ${noun}`;
  };
  const unitOf = (f: Faction, k: UnitKind | null) => whose(f, unitName(k), isFeminine(k));
  const powerOf = (f: Faction, p: PowerKind) => whose(f, powerName(p), isFeminine(p));
  /** Subject and its "avoir": "tu as", "l'ennemi a", "Bleu a". */
  const has = (f: Faction) => (pov === null ? `${f === "blue" ? "Bleu" : "Rouge"} a` : f === pov ? "tu as" : "l'ennemi a");
  const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const toneFor = (good: Faction | null): Moment["tone"] => (good === null || pov === null ? "neutral" : good === pov ? "good" : "bad");

  const fb = firstBlood(c.deaths);
  if (fb) {
    const killer = other(fb.faction);
    const victim = unitOf(fb.faction, fb.unitKind);
    const text = fb.power
      ? `${Cap(powerOf(killer, fb.power))} a éliminé ${victim}`
      : fb.killerKind
        ? `${Cap(unitOf(killer, fb.killerKind))} a éliminé ${victim}`
        : fb.byBuilding
          ? `${Cap(whose(killer, "défenses", true, true))} ont éliminé ${victim}`
          : `${Cap(has(killer))} éliminé ${victim}`;
    out.push({ kind: "first-blood", t: fb.t, title: "Premier sang", text, tone: toneFor(killer) });
  }

  const b = biggestBattle(c.deaths);
  if (b) {
    const where = placeName(c.refs, b.x, b.y, pov);
    const p: Faction = pov ?? "blue";
    const q: Faction = other(p);
    const winner = b.lost.blue === b.lost.red ? null : b.lost.blue < b.lost.red ? "blue" : "red";
    // "l'ennemi a perdu 9 (dont 4 par ton Obus Méliès)"
    const to = (f: Faction) =>
      b.strike && b.strike.victim === f ? ` (dont ${b.strike.n} par ${powerOf(other(f), b.strike.power)})` : "";
    out.push({
      kind: "battle", t: b.t, title: "Plus grande bataille",
      text: `${Cap(where)} : ${has(p)} perdu ${b.lost[p]}${to(p)}, ${has(q)} perdu ${b.lost[q]}${to(q)}`,
      tone: toneFor(winner)
    });
  }

  const turn = turningPoint(c.samples);
  if (turn) {
    const l = turn.leader;
    const lead = `${shortK(turn.army[l])} contre ${shortK(turn.army[other(l)])}`;
    // a strike by the new leader just before the turn is the story: "… après ton Obus Méliès"
    const swing = swingStrike(c.deaths, l, turn.t);
    const after = swing ? ` après ${powerOf(l, swing)}` : "";
    const text =
      pov === null
        ? `L'armée ${adj(l, true, false)} a pris l'avantage${after} (${lead})${turn.toEnd ? " sans plus jamais le lâcher" : ""}`
        : l === pov
          ? `Ton armée a dépassé la leur${after} (${lead})${turn.toEnd ? " sans plus jamais être rattrapée" : ""}`
          : `Leur armée a dépassé la tienne${after} (${lead})${turn.toEnd ? " et a gardé l'avantage" : ""}`;
    out.push({ kind: "turn", t: turn.t, title: "Tournant", text, tone: toneFor(l) });
  } else {
    // the lead never changed hands: when did it become decisive?
    const pa = pulledAway(c.samples);
    if (pa) {
      const l = pa.leader;
      const lead = `${shortK(pa.army[l])} contre ${shortK(pa.army[other(l)])}`;
      out.push({
        kind: "lead", t: pa.t, title: "Échappée",
        text:
          pov === null
            ? `L'armée ${adj(l, true, false)} a creusé l'écart (${lead}) et l'a gardé`
            : l === pov
              ? `Ton armée a creusé l'écart (${lead}) et l'a gardé`
              : `Leur armée a creusé l'écart (${lead}) ; tu n'as jamais rattrapé ton retard`,
        tone: toneFor(l)
      });
    }
  }

  // the first Goliath to walk off a Gantry (the match's first: one beat, not one per side; under
  // Nomads the Goliaths a side starts with were never built, so "off the Gantry" still holds)
  const fg = firstGoliath(c.firstBuilt);
  if (fg) {
    const f = fg.faction;
    out.push({
      kind: "goliath", t: fg.t, title: "Gargantua",
      text: `${Cap(whose(f, "premier Gargantua"))} est sorti ${pov !== null && f !== pov ? "de leur" : "de la"} Galerie des Machines`,
      tone: toneFor(f)
    });
  }

  // an HQ that fell while the match went on: its Goliath fought on (a side that never fielded one isn't this story)
  const end = c.samples.at(-1)?.t ?? 0;
  for (const d of c.deaths) {
    if (d.buildingKind !== "hq" || end - d.t < FOUGHT_ON_S) continue;
    const had = c.firstBuilt?.[d.faction]["goliath"];
    if (had === undefined || had > d.t) continue;
    out.push({
      kind: "hq", t: d.t, title: "GQG détruit",
      text: `${Cap(whose(d.faction, "GQG"))} est tombé ; ${whose(d.faction, "Gargantua")} a tenu encore ${fmtTime(end - d.t)}`,
      tone: toneFor(other(d.faction))
    });
  }

  // Robot Love: the match ended with two Goliaths falling for each other (a draw, so nobody's beat)
  if (c.love) {
    const where = placeName(c.refs, c.love.x, c.love.y, pov);
    out.push({
      kind: "love", t: c.love.t, title: "Amour mécanique",
      text: pov === null ? `Les Gargantuas bleu et rouge sont tombés amoureux ${where} : match nul` : `Ton Gargantua et le leur sont tombés amoureux ${where} : match nul`,
      tone: "neutral"
    });
  }
  return out.sort((a, b2) => a.t - b2.t);
}

// ----------------------------------------------------------------- tips ---

export interface TipInput {
  pov: Faction;
  won: boolean;
  duration: number;
  difficulty: string;
  built: Record<Faction, Record<string, number>>;
  firstBuilt: Record<Faction, Record<string, number>>;
  deaths: DeathRec[];
  samples: Sample[];
  factories: Record<Faction, { total: number; idleRich: number }>;
  /** Goliaths each side started with (Nomads), on top of those built. */
  startGoliaths?: Record<Faction, number>;
}

/** One actionable tip, chosen by simple rules (the most pressing wins). */
export function pickTip(i: TipInput): string {
  const me = i.pov;
  const them = other(me);
  const n = (f: Faction, ...kinds: string[]) => kinds.reduce((s, k) => s + (i.built[f][k] ?? 0), 0);
  const tips: { score: number; text: string }[] = [];

  const enemyAir = n(them, "wasp", "raptor", "hornet");
  const myAA = n(me, "flak-crawler", "raptor", "sam-site") + n(me, "lancer") * 0.5;
  if (enemyAir >= 6 && myAA <= 1)
    tips.push({
      score: 90,
      text: `L'ennemi a aligné ${enemyAir} aéronefs ; ${myAA < 1 ? "tu n'as construit presque aucune" : "tu as construit trop peu de"} DCA. Faucheux, Blériot et Batteries Ruggieri les déchiquettent.`
    });

  // the Goliath's tuned answers (GOLIATH.md); its Menders keep it alive and its weapons coming back
  const goliaths = n(them, "goliath") + (i.startGoliaths?.[them] ?? 0);
  if (goliaths >= 1 && n(me, "rocket-squad", "wasp", "lancer", "hornet") <= 2)
    tips.push({
      score: 80,
      text: `Ils ont aligné ${goliaths === 1 ? "un Gargantua" : `${goliaths} Gargantuas`}. Artificiers, Éole, Hydroglisseurs et Albatros en viennent à bout ; abats d'abord ses Pasteur.`
    });

  const mastodons = n(them, "mastodon");
  if (mastodons >= 4 && n(me, "lancer", "wasp", "hornet", "rocket-squad") <= 2)
    tips.push({ score: 75, text: `Ils ont construit ${mastodons} Creusot. Artificiers, Hydroglisseurs et Éole percent le blindage lourd.` });

  // robot infantry: splash and Snipers are the answer (Mastodons only scratch them, unless they roll over them)
  const squads = n(them, "trooper", "rocket-squad", "sniper");
  if (squads >= 8 && n(me, "mortar", "hornet", "sniper", "turret") <= 1)
    tips.push({ score: 72, text: `Ils ont aligné ${squads} escouades d'infanterie. Canons de 75, Albatros et Chasseurs alpins déchiquettent l'infanterie automate.` });

  const harvLost = i.deaths.filter((d) => d.faction === me && d.unitKind === "harvester").length;
  if (harvLost >= 5)
    tips.push({ score: 70 + harvLost, text: `Tu as perdu ${harvLost} Fardiers. Une Hotchkiss près des gisements, ou deux escortes, se rentabilise vite.` });

  const late = i.samples.filter((s) => s.t >= 90);
  const avgHarv = late.length ? late.reduce((s, x) => s + x.harvesters[me], 0) / late.length : 4;
  if (i.duration > 240 && avgHarv < 2.5)
    tips.push({ score: 65, text: `Tu as tourné avec environ ${Math.max(1, Math.round(avgHarv))} Fardier${Math.round(avgHarv) <= 1 ? "" : "s"} presque tout le match. Les revenus gagnent les guerres : vises-en 4 ou plus dès le début.` });

  const fac = i.factories[me];
  const idle = fac.total >= 10 ? fac.idleRich / fac.total : 0;
  if (idle > 0.3)
    tips.push({ score: 60, text: `Tes ateliers sont restés à l'arrêt avec du charbon en réserve ${Math.round(idle * 100)} % du temps. Garde toujours une unité en file.` });

  const banked = i.samples.filter((s) => s.t >= 120);
  const avgBank = banked.length ? banked.reduce((s, x) => s + x.bank[me], 0) / banked.length : 0;
  if (avgBank > 800)
    tips.push({ score: 55, text: `Tu gardais en moyenne ${Math.round(avgBank / 100) * 100} de charbon. Dépense-le : ajoute d'autres Forges ou un Parc de Chalais-Meudon.` });

  const artillery = i.deaths.filter(
    (d) => d.faction === me && d.buildingKind && (d.killerKind === "mortar" || d.killerKind === "hornet")
  ).length;
  if (artillery >= 3)
    tips.push({ score: 50, text: `Canons de 75 et Albatros ont détruit ${artillery} de tes bâtiments. Les Éole chassent les Canons de 75 ; Faucheux, Blériot et Ruggieri arrêtent les Albatros.` });

  // (a Drop Pod's thump barely counts: Barrages and Sky Hammers are the ones to dodge)
  const struck = i.deaths.filter((d) => d.faction === me && d.unitKind && d.power && d.power !== "droppod").length;
  if (struck >= 6)
    tips.push({
      score: 48,
      text: `Les frappes ennemies ont détruit ${struck} de tes unités. Quand un cercle rouge apparaît, sélectionne ce qu'il contient et sors-le : un Feu roulant met 2,5 s à tomber.`
    });

  const byTowers = i.deaths.filter((d) => d.faction === me && d.unitKind && d.byBuilding).length;
  if (byTowers >= 8)
    tips.push({ score: 45, text: `Les défenses ont détruit ${byTowers} de tes unités. Casse les Hotchkiss aux Canons de 75 ou aux Albatros avant d'attaquer.` });

  const tech = i.firstBuilt[me]["tech-lab"];
  if (i.duration > 420 && (tech === undefined || tech > 360))
    tips.push({ score: 40, text: "Pas de Polytechnique à 6:00. Elle débloque Creusot, Hydroglisseurs, Canons de 75, Albatros et Chasseurs alpins." });

  if (i.won)
    tips.push({
      score: 10,
      text: i.difficulty === "hard" ? `Victoire en Difficile en ${fmtTime(i.duration)}. Peux-tu faire plus vite ?` : "Belle victoire. Prêt pour une IA plus coriace ?"
    });
  tips.push({ score: 5, text: "Repère l'ennemi tôt et construis les contres : appui long sur un bouton de construction pour voir qui bat quoi." });
  // after a win, only a serious problem outranks the congratulations
  const pool = i.won ? tips.filter((t) => t.score >= 50 || t.score === 10) : tips;
  pool.sort((a, b) => b.score - a.score);
  return pool[0]!.text;
}

/** Spectator: one line per commander. */
export function commanderStory(c: Chronicle, w: World, f: Faction, label: string): string {
  const st = w.factions[f].stats;
  const kinds = Object.entries(c.built[f]).filter(([k]) => k in UNITS && k !== "harvester");
  kinds.sort((a, b) => b[1] - a[1]);
  const top = kinds[0];
  let peak = 0;
  let peakT = 0;
  for (const s of c.samples)
    if (s.army[f] > peak) {
      peak = s.army[f];
      peakT = s.t;
    }
  const parts = [`${label}`];
  if (top) parts.push(`surtout ${UNITS[top[0] as UnitKind].name} (${top[1]})`);
  if (peak > 0) parts.push(`pic d'armée ${shortK(peak)} à ${fmtTime(peakT)}`);
  parts.push(`${st.buildingsLost} bâtiment${st.buildingsLost <= 1 ? "" : "s"} perdu${st.buildingsLost <= 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Peak army value and when (for the stats table). */
export function peakArmy(samples: Sample[], f: Faction): number {
  return samples.reduce((m, s) => Math.max(m, s.army[f]), 0);
}
