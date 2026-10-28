import { TICK_RATE } from "../sim/balance";
import { MEDAL_IDS, computeMedals, type MatchRecap, type MedalId } from "../sim/awards";
import { wavesSurvived } from "../sim/modes/survival";
import { isMutated, rulesOf, type MutatorId } from "../sim/rules";
import { CAMPAIGN, OPS, TRIALS, bookOf, campaignUnlocked, isCampaignOp, opById, opsUnlocked, type OpDef, type OpLevel } from "../sim/ops";
import { mapById } from "../sim/maps";
import { isRandomMapId } from "../sim/mapgen";
import type { Faction, World } from "../sim/types";
import { chronicleOf, type Chronicle } from "./chronicle";
import { today as todayIndex } from "./daily";
import { tr } from "../lang";

/**
 * The Commander career: XP and ten ranks, medal counts, map stars per
 * map × difficulty, wins and losses, the Daily Op streak and Last Stand
 * totals. The math is pure (and unit-tested); storage is one localStorage
 * key with the same try/catch fallbacks as mode.ts — a blocked browser just
 * plays without a career. Spectated matches never touch it.
 */

// ------------------------------------------------------------------ ranks ---

export interface RankDef {
  name: string;
  /** Total XP needed to hold this rank. */
  xp: number;
}

export const RANKS: RankDef[] = [
  { name: tr("Cadet", "Cadet"), xp: 0 },
  { name: tr("Soldat", "Private"), xp: 100 },
  { name: tr("Caporal", "Corporal"), xp: 300 },
  { name: tr("Sergent", "Sergeant"), xp: 600 },
  { name: tr("Lieutenant", "Lieutenant"), xp: 1000 },
  { name: tr("Capitaine", "Captain"), xp: 1500 },
  { name: tr("Commandant", "Major"), xp: 2200 },
  { name: tr("Colonel", "Colonel"), xp: 3100 },
  { name: tr("Général", "General"), xp: 4300 },
  { name: tr("Maréchal", "Marshal"), xp: 6000 }
];

export interface RankInfo {
  index: number;
  name: string;
  /** XP where this rank starts, and where the next one does (null at the top). */
  floor: number;
  next: number | null;
  nextName: string | null;
  /** 0..1 through the current rank (1 at the top rank). */
  progress: number;
}

export function rankOf(xp: number): RankInfo {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1]!.xp) i++;
  const floor = RANKS[i]!.xp;
  const nxt = RANKS[i + 1] ?? null;
  return {
    index: i,
    name: RANKS[i]!.name,
    floor,
    next: nxt ? nxt.xp : null,
    nextName: nxt ? nxt.name : null,
    progress: nxt ? Math.max(0, Math.min(1, (xp - floor) / (nxt.xp - floor))) : 1
  };
}

// --------------------------------------------------------------------- XP ---

export const XP = {
  win: 100,
  loss: 30,
  /** A Robot Love draw: more than a loss, less than a win. */
  draw: 60,
  /** A loss (or a draw) pays in full only after this long (no farming by quitting fast). */
  lossFullSecs: 300,
  medal: 25,
  /** Last Stand: per wave survived. */
  wave: 10,
  /** First Daily Op win of the day. */
  dailyWin: 100,
  /** Ops: completing one, failing one (scaled by time like losses), first clear, each new star. */
  opWin: 60,
  opLoss: 15,
  opFirstClear: 100,
  opStar: 40,
  difficulty: { easy: 1, normal: 1.5, hard: 2.2 } as Record<string, number>
};

/** Stars per map × difficulty: win · win under 8:00 (a big map gives longer) · win without losing a building. */
export const STAR_SECS = 8 * 60;
export const STAR_LABELS = tr(["Victoire", "Victoire en moins de 8:00", "Victoire sans perdre de bâtiment"], ["Victory", "Victory in under 8:00", "Victory without losing a building"]);

/** The ★★ time on a map: 8:00, or the map's own (MapDef.starSecs). */
export const starSecsFor = (mapId: string): number => mapById(mapId).starSecs ?? STAR_SECS;

/** The three star labels on a map (its ★★ time spelled out). */
export function starLabelsFor(mapId: string): string[] {
  const s = starSecsFor(mapId);
  return [STAR_LABELS[0]!, tr(`Victoire en moins de ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, `Victory in under ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`), STAR_LABELS[2]!];
}

export type GameKind = "skirmish" | "survival" | "op";

export interface MatchResult {
  kind: GameKind;
  mapId: string;
  difficulty: string;
  won: boolean;
  /** Robot Love: nobody won (two Goliaths fell in love). Never set with `won`; counts as neither a win nor a loss. */
  drawn?: boolean;
  secs: number;
  buildingsLost: number;
  medals: MedalId[];
  /** Mutators active (no stars). */
  mutators: MutatorId[];
  /** Day index when this was the Daily Op, else null. */
  daily: number | null;
  /** Last Stand: waves survived. */
  waves?: number;
  /** Ops: which op, the star bitmask this attempt earned (0 when failed), and the campaign's level (absent: Normal). */
  op?: { id: string; stars: number; level?: OpLevel };
}

export interface XpLine {
  label: string;
  xp: number;
}

const DIFF_FR: Record<string, string> = tr({ easy: "Facile", normal: "Normal", hard: "Difficile" }, { easy: "Easy", normal: "Normal", hard: "Hard" });
const diffLabel = (d: string) => DIFF_FR[d] ?? d.charAt(0).toUpperCase() + d.slice(1);

/** The XP breakdown for a result (before the daily bonus, which depends on the career). */
export function xpLines(r: MatchResult): XpLine[] {
  const mult = XP.difficulty[r.difficulty] ?? 1;
  const lines: XpLine[] = [];
  if (r.kind === "op") {
    const def = opById(r.op?.id ?? "");
    const title = def?.title ?? "Op";
    const name = def && isCampaignOp(def) ? tr("Mission", "Mission") : tr("Épreuve", "Trial");
    if (r.won) lines.push({ label: tr(`${name} réussie · ${title}`, `${name} complete · ${title}`), xp: XP.opWin });
    else lines.push({ label: tr(`${name} échouée · ${title}`, `${name} failed · ${title}`), xp: Math.round(XP.opLoss * Math.max(0.2, Math.min(1, r.secs / 120))) });
  } else if (r.kind === "survival") {
    const waves = r.waves ?? 0;
    lines.push({ label: tr(`${waves} vague${waves === 1 ? "" : "s"} · ${diffLabel(r.difficulty)}`, `${waves} wave${waves === 1 ? "" : "s"} · ${diffLabel(r.difficulty)}`), xp: Math.round(XP.wave * waves * mult) });
  } else if (r.won) {
    lines.push({ label: tr(`Victoire · ${diffLabel(r.difficulty)}`, `Victory · ${diffLabel(r.difficulty)}`), xp: Math.round(XP.win * mult) });
  } else {
    // (a short match pays a fraction, a draw as a loss: no farming XP by quitting, or by a quick Robot Love)
    const k = Math.max(0.2, Math.min(1, r.secs / XP.lossFullSecs));
    if (r.drawn) lines.push({ label: tr(`Match nul · ${diffLabel(r.difficulty)}`, `Draw · ${diffLabel(r.difficulty)}`), xp: Math.round(XP.draw * mult * k) });
    else lines.push({ label: tr(`Défaite · ${diffLabel(r.difficulty)}`, `Defeat · ${diffLabel(r.difficulty)}`), xp: Math.round(XP.loss * mult * k) });
  }
  if (r.medals.length > 0)
    lines.push({ label: tr(`${r.medals.length} médaille${r.medals.length === 1 ? "" : "s"}`, `${r.medals.length} medal${r.medals.length === 1 ? "" : "s"}`), xp: XP.medal * r.medals.length });
  return lines;
}

/** Star bitmask (bit 0 win, bit 1 fast win, bit 2 no buildings lost) this result earns (none on a generated map: there are endlessly many). */
export function starsFor(r: MatchResult): number {
  if (r.kind !== "skirmish" || !r.won || r.mutators.length > 0 || r.daily !== null || isRandomMapId(r.mapId)) return 0;
  let s = 1;
  if (r.secs < starSecsFor(r.mapId)) s |= 2;
  if (r.buildingsLost === 0) s |= 4;
  return s;
}

export const starCount = (mask: number): number => (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1);

// ----------------------------------------------------------------- career ---

export interface CareerData {
  v: 1;
  xp: number;
  wins: number;
  losses: number;
  medals: Partial<Record<MedalId, number>>;
  /** "map:difficulty" → star bitmask. */
  stars: Record<string, number>;
  /** "map:difficulty" → skirmish record. */
  records: Record<string, { w: number; l: number; bestSecs: number | null }>;
  daily: {
    /** Day index of the latest Daily Op win (0 = never). */
    lastWin: number;
    streak: number;
    bestStreak: number;
    wins: number;
    plays: number;
  };
  laststand: { runs: number; waves: number; best: number };
  /** Ops campaign: op id → best star bitmask (1 complete, 2 ★★, 4 ★★★), best time, attempts. */
  ops: Record<string, OpRecord>;
}

export interface OpRecord {
  stars: number;
  /** Won on Recrue or Vétéran (no stars there): the next mission is open all the same. */
  cleared?: boolean;
  bestSecs: number | null;
  plays: number;
  wins: number;
}

/** Ops completed (any stars): both books, or one of them. */
/** Has this op been won, on any level? */
export const opCleared = (rec: OpRecord | undefined): boolean => !!rec && (!!(rec.stars & 1) || !!rec.cleared);
export const opsCompleted = (c: CareerData, book: OpDef[] = OPS): number => book.filter((o) => opCleared(c.ops[o.id])).length;
/** Campaign missions won. */
export const campaignCompleted = (c: CareerData): number => opsCompleted(c, CAMPAIGN);
/** How many of an op's book are open: the campaign's first mission plus one per mission won; the Trials' first three plus one per Trial. */
const openIn = (c: CareerData, book: OpDef[]): number => (book === CAMPAIGN ? campaignUnlocked(opsCompleted(c, CAMPAIGN)) : opsUnlocked(opsCompleted(c, TRIALS)));
/** Is this op open yet? */
export function opUnlocked(c: CareerData, id: string): boolean {
  const op = opById(id);
  if (!op) return false;
  const book = bookOf(op);
  return book.indexOf(op) < openIn(c, book);
}

export function emptyCareer(): CareerData {
  return {
    v: 1,
    xp: 0,
    wins: 0,
    losses: 0,
    medals: {},
    stars: {},
    records: {},
    daily: { lastWin: 0, streak: 0, bestStreak: 0, wins: 0, plays: 0 },
    laststand: { runs: 0, waves: 0, best: 0 },
    ops: {}
  };
}

export const recordKey = (mapId: string, difficulty: string) => `${mapId}:${difficulty}`;

/** The streak as it stands today: it survives until a whole day passes without a win. */
export function currentStreak(c: CareerData, day: number): number {
  return c.daily.lastWin >= day - 1 && c.daily.lastWin > 0 ? c.daily.streak : 0;
}

export interface Settlement {
  result: MatchResult;
  xpBefore: number;
  xpAfter: number;
  gained: number;
  lines: XpLine[];
  rankBefore: RankInfo;
  rankAfter: RankInfo;
  rankedUp: boolean;
  /** Medals earned this match, and which of them are first-ever. */
  medals: MedalId[];
  firstMedals: MedalId[];
  starsBefore: number;
  starsAfter: number;
  /** Daily Op outcome (null if this wasn't one). */
  daily: { number: number; won: boolean; streak: number; firstWinToday: boolean } | null;
  /** Ops outcome: stars before/after, a first clear, and an op this result unlocked. */
  op: { id: string; starsBefore: number; starsAfter: number; firstClear: boolean; unlocked: string | null } | null;
}

/** Bank a result: pure — returns the new career and what changed. */
export function applyResult(c0: CareerData, r: MatchResult, day = todayIndex(), opNumber = 0): { career: CareerData; s: Settlement } {
  const c: CareerData = JSON.parse(JSON.stringify(c0)) as CareerData;
  const lines = xpLines(r);
  let daily: Settlement["daily"] = null;
  if (r.daily !== null) {
    c.daily.plays++;
    const firstWinToday = r.won && c.daily.lastWin !== r.daily;
    if (firstWinToday) {
      c.daily.streak = c.daily.lastWin === r.daily - 1 ? c.daily.streak + 1 : 1;
      c.daily.lastWin = r.daily;
      c.daily.bestStreak = Math.max(c.daily.bestStreak, c.daily.streak);
      c.daily.wins++;
      lines.push({ label: tr("Op du jour", "Daily Op"), xp: XP.dailyWin });
    }
    daily = { number: opNumber, won: r.won, streak: currentStreak(c, day), firstWinToday };
  }
  const firstMedals = r.medals.filter((m) => !c.medals[m]);
  for (const m of r.medals) c.medals[m] = (c.medals[m] ?? 0) + 1;
  const key = recordKey(r.mapId, r.difficulty);
  const starsBefore = c.stars[key] ?? 0;
  let op: Settlement["op"] = null;
  if (r.kind === "op" && r.op) {
    const id = r.op.id;
    const rec: OpRecord = c.ops[id] ?? { stars: 0, bestSecs: null, plays: 0, wins: 0 };
    const before = rec.stars;
    const clearedBefore = opCleared(rec);
    const opDef = opById(id);
    const book = opDef ? bookOf(opDef) : TRIALS;
    const openBefore = openIn(c, book);
    // (stars and records only count on Normal: Recrue and Vétéran only open the way)
    const normal = (r.op.level ?? "normal") === "normal";
    rec.plays++;
    if (r.won) {
      rec.wins++;
      if (normal) {
        rec.stars |= r.op.stars | 1;
        rec.bestSecs = rec.bestSecs === null ? r.secs : Math.min(rec.bestSecs, r.secs);
      } else rec.cleared = true;
    }
    c.ops[id] = rec;
    const firstClear = r.won && !clearedBefore;
    if (firstClear) lines.push({ label: tr("Premier succès", "First clear"), xp: XP.opFirstClear });
    const newStars = starCount(rec.stars & ~before & 6);
    if (newStars > 0) lines.push({ label: tr(`${newStars} nouvelle${newStars === 1 ? "" : "s"} étoile${newStars === 1 ? "" : "s"}`, `${newStars} new star${newStars === 1 ? "" : "s"}`), xp: XP.opStar * newStars });
    const openAfter = openIn(c, book);
    op = { id, starsBefore: before, starsAfter: rec.stars, firstClear, unlocked: openAfter > openBefore ? (book[openAfter - 1]?.id ?? null) : null };
  }
  if (r.kind === "op") {
    /* ops keep their own records: no skirmish W/L, map stars or Last Stand totals */
  } else if (r.kind === "skirmish") {
    // (a draw is neither)
    if (r.won) c.wins++;
    else if (!r.drawn) c.losses++;
    const rec = c.records[key] ?? { w: 0, l: 0, bestSecs: null };
    if (r.won) {
      rec.w++;
      if (r.mutators.length === 0 && r.daily === null) rec.bestSecs = rec.bestSecs === null ? r.secs : Math.min(rec.bestSecs, r.secs);
    } else if (!r.drawn) rec.l++;
    c.records[key] = rec;
    const add = starsFor(r);
    if (add) c.stars[key] = starsBefore | add;
  } else {
    c.laststand.runs++;
    c.laststand.waves += r.waves ?? 0;
    c.laststand.best = Math.max(c.laststand.best, r.waves ?? 0);
  }
  const gained = lines.reduce((s, l) => s + l.xp, 0);
  const xpBefore = c.xp;
  c.xp += gained;
  const rankBefore = rankOf(xpBefore);
  const rankAfter = rankOf(c.xp);
  return {
    career: c,
    s: {
      result: r,
      xpBefore,
      xpAfter: c.xp,
      gained,
      lines,
      rankBefore,
      rankAfter,
      rankedUp: rankAfter.index > rankBefore.index,
      medals: r.medals,
      firstMedals,
      starsBefore,
      starsAfter: c.stars[key] ?? 0,
      daily,
      op
    }
  };
}

// ---------------------------------------------------------------- storage ---

const KEY = "panache.career";

/** A career read from anywhere (storage, the cloud save), every field checked. */
export function sanitizeCareer(raw: unknown): CareerData {
  const c = emptyCareer();
  if (!raw || typeof raw !== "object") return c;
  const o = raw as Partial<CareerData>;
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  c.xp = Math.max(0, num(o.xp));
  c.wins = num(o.wins);
  c.losses = num(o.losses);
  if (o.medals && typeof o.medals === "object")
    for (const id of MEDAL_IDS) if (num(o.medals[id]) > 0) c.medals[id] = num(o.medals[id]);
  if (o.stars && typeof o.stars === "object")
    for (const [k, v] of Object.entries(o.stars)) if (typeof v === "number") c.stars[k] = v & 7;
  if (o.records && typeof o.records === "object")
    for (const [k, v] of Object.entries(o.records))
      if (v && typeof v === "object") c.records[k] = { w: num(v.w), l: num(v.l), bestSecs: typeof v.bestSecs === "number" ? v.bestSecs : null };
  if (o.daily && typeof o.daily === "object")
    c.daily = {
      lastWin: num(o.daily.lastWin),
      streak: num(o.daily.streak),
      bestStreak: num(o.daily.bestStreak),
      wins: num(o.daily.wins),
      plays: num(o.daily.plays)
    };
  if (o.laststand && typeof o.laststand === "object")
    c.laststand = { runs: num(o.laststand.runs), waves: num(o.laststand.waves), best: num(o.laststand.best) };
  if (o.ops && typeof o.ops === "object")
    for (const [k, v] of Object.entries(o.ops))
      if (opById(k) && v && typeof v === "object")
        c.ops[k] = { stars: num(v.stars) & 7, bestSecs: typeof v.bestSecs === "number" ? v.bestSecs : null, plays: num(v.plays), wins: num(v.wins) };
  return c;
}

export function loadCareer(): CareerData {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeCareer(raw ? JSON.parse(raw) : null);
  } catch {
    return emptyCareer(); // storage blocked or corrupt: play on without a career
  }
}

export function saveCareer(c: CareerData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------- settlement ---

/** One side's medal recap from the match chronicle (full information, end of match). */
export function recapOf(w: World, chronicle: Chronicle, pov: Faction): MatchRecap {
  const mvp = chronicle.mvp();
  return {
    pov,
    won: w.winner === pov,
    secs: w.tick / TICK_RATE,
    stats: { blue: w.factions.blue.stats, red: w.factions.red.stats },
    samples: chronicle.samples,
    deaths: chronicle.deaths,
    bestUnitKills: mvp[pov]?.kills ?? 0,
    strikes: chronicle.strikes,
    waves: w.survival ? wavesSurvived(w) : null
  };
}

/** Medals each side earned (spectator end screens annotate AI-vs-AI games). */
export function medalsOf(w: World, pov: Faction): MedalId[] {
  const ch = chronicleOf(w);
  ch.finish();
  return computeMedals(recapOf(w, ch, pov));
}

export interface MatchMeta {
  pov: Faction;
  difficulty: string;
  /** Daily Op day index and number, when this match was the Daily Op. */
  daily: { day: number; number: number } | null;
}

const settled = new WeakMap<World, Settlement>();

/**
 * Bank a finished match in the career (once per world: the scene calls it
 * when the HQ falls and the end screen asks again for the result).
 */
export function settleMatch(w: World, meta: MatchMeta): Settlement {
  const done = settled.get(w);
  if (done) return done;
  const ch = chronicleOf(w);
  ch.finish();
  const recap = recapOf(w, ch, meta.pov);
  // an op is its own thing: stars per op, no medals, map stars or Last Stand records
  const op = w.ops ?? null;
  const result: MatchResult = {
    kind: op ? "op" : w.survival ? "survival" : "skirmish",
    mapId: w.mapId,
    difficulty: meta.difficulty,
    won: op ? w.winner === meta.pov : !w.survival && w.winner === meta.pov,
    ...(!op && !w.survival && w.winner === "draw" ? { drawn: true } : {}),
    secs: Math.round(recap.secs),
    buildingsLost: w.factions[meta.pov].stats.buildingsLost,
    medals: op ? [] : computeMedals(recap),
    mutators: isMutated(w) ? [...rulesOf(w).mutators] : [],
    daily: meta.daily ? meta.daily.day : null,
    ...(w.survival && !op ? { waves: recap.waves ?? 0 } : {}),
    ...(op ? { op: { id: op.id, stars: op.result?.stars ?? 0, ...(op.level ? { level: op.level } : {}) } } : {})
  };
  const { career, s } = applyResult(loadCareer(), result, todayIndex(), meta.daily?.number ?? 0);
  saveCareer(career);
  settled.set(w, s);
  return s;
}

/** The settlement for a world, if it was banked. */
export const settlementOf = (w: World): Settlement | null => settled.get(w) ?? null;
