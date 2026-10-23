/**
 * The highlight reel's plan (« ▶ Revoir les temps forts » on the report,
 * ui/reel.ts plays it): the match's key moments, found by its chronicle as
 * it was played and kept in its record (BattleRecord.reel), and the clips
 * that show them — a few seconds of battle around each, in order, each
 * behind a silent-film intertitle (« 4:12 — La grande bataille, au centre »),
 * the end last with its finale. 15 to 25 s in all.
 *
 * Engine-free (tests/reel.test.ts).
 */
import type { ReelMoment } from "../arena/record";
import { TICK_RATE } from "../sim/balance";
import type { Faction } from "../sim/types";
import { biggestBattle, firstBlood, fmtTime, placeName, pulledAway, turningPoint, type Chronicle } from "./chronicle";
import { tr } from "../lang";

export const REEL = {
  /** A clip starts this long before its moment and runs this long (game seconds). */
  leadS: 3,
  lenS: 4.5,
  /** The end's clip: the last few seconds, then the finale. */
  endS: 4.5,
  /** Game speed while a clip plays. */
  pace: 1.6,
  /** The title card, each intertitle, the « Fin » card (real ms); the finale's own length (finale.ts FINALE.doneAt). */
  titleMs: 1500,
  cardMs: 1300,
  finMs: 1300,
  finaleMs: 2800,
  /** Clips at most (the end among them). */
  max: 4
} as const;

/** Which moments make the cut first, when there are more than REEL.max or they overlap. */
const PRIORITY: ReelMoment["kind"][] = ["end", "battle", "first-blood", "turn", "lead", "goliath"];

const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

export interface ReelEnd {
  /** The tick it was decided on. */
  tick: number;
  winner: Faction | "draw" | null;
  /** Where (the deciding HQ or Goliath), if known. */
  x?: number;
  y?: number;
}

/** The end's intertitle, from the player's point of view (null: a spectator's). */
export function endTitle(winner: Faction | "draw" | null, pov: Faction | null): string {
  if (winner === null || winner === "draw") return tr("Le match nul", "The Draw");
  if (pov === null) return winner === "blue" ? tr("La victoire bleue", "The Blue Victory") : tr("La victoire rouge", "The Red Victory");
  return winner === pov ? tr("La victoire", "The Victory") : tr("La défaite", "The Defeat");
}

/**
 * The reel's moments from a finished match's chronicle: first blood, the
 * biggest battle, the turning point (or the moment one side pulled away),
 * the first Goliath, and the end.
 */
export function reelMoments(
  c: Pick<Chronicle, "deaths" | "samples" | "refs" | "firstBuilt">,
  pov: Faction | null,
  end: ReelEnd
): ReelMoment[] {
  const tick = (t: number) => Math.max(0, Math.round(t * TICK_RATE));
  const out: ReelMoment[] = [];
  const fb = firstBlood(c.deaths);
  if (fb) out.push({ kind: "first-blood", tick: tick(fb.t), x: fb.x, y: fb.y, title: tr("Le premier sang", "The First Blood") });
  const b = biggestBattle(c.deaths);
  if (b) out.push({ kind: "battle", tick: tick(b.t), x: b.x, y: b.y, title: tr(`La grande bataille, ${placeName(c.refs, b.x, b.y, pov)}`, `The Great Battle, ${placeName(c.refs, b.x, b.y, pov)}`) });
  const turn = turningPoint(c.samples);
  if (turn) out.push({ kind: "turn", tick: tick(turn.t), title: pov === null || turn.leader === pov ? tr("Le tournant", "The Turning Point") : tr("Le vent tourne", "The Tide Turns") });
  else {
    const pa = pulledAway(c.samples);
    if (pa) out.push({ kind: "lead", tick: tick(pa.t), title: pov !== null && pa.leader !== pov ? tr("Leur échappée", "Their Breakaway") : tr("L'échappée", "The Breakaway") });
  }
  let g: { f: Faction; t: number } | null = null;
  for (const f of ["blue", "red"] as const) {
    const t = c.firstBuilt[f]["goliath"];
    if (t !== undefined && (!g || t < g.t)) g = { f, t };
  }
  if (g) out.push({ kind: "goliath", tick: tick(g.t), title: pov !== null && g.f === other(pov) ? tr("Leur Gargantua entre en scène", "Their Gargantua Takes the Stage") : tr("Le Gargantua entre en scène", "The Gargantua Takes the Stage") });
  out.push({ kind: "end", tick: end.tick, ...(end.x !== undefined && end.y !== undefined ? { x: end.x, y: end.y } : {}), title: endTitle(end.winner, pov) });
  // (nothing past the end: a chronicle sample can round a little after it)
  return out.filter((m) => m.tick <= end.tick);
}

export interface Clip {
  /** Ticks shown: from (the seek lands here) to (the playhead holds here). */
  from: number;
  to: number;
  moment: ReelMoment;
  /** « 4:12 — La grande bataille, au centre ». */
  card: string;
}

/** The intertitle for a moment. */
export const cardText = (m: ReelMoment): string => `${fmtTime(m.tick / TICK_RATE)} — ${m.title}`;

/**
 * The clips: the moments that make the cut by PRIORITY, none overlapping
 * another (the lower one goes), REEL.max at most, in the match's order, the
 * end always last.
 */
export function reelClips(moments: readonly ReelMoment[], endTick: number): Clip[] {
  const R = TICK_RATE;
  const span = (m: ReelMoment): [number, number] =>
    m.kind === "end"
      ? [Math.max(0, endTick - REEL.endS * R), endTick]
      : [Math.max(0, m.tick - REEL.leadS * R), Math.min(endTick, Math.max(0, m.tick - REEL.leadS * R) + REEL.lenS * R)];
  const chosen: Clip[] = [];
  const ranked = [...moments].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.tick - b.tick);
  for (const m of ranked) {
    if (chosen.length >= REEL.max) break;
    const [from, to] = span(m);
    if (to - from < R) continue; // (a moment at the very start, or past the end)
    if (chosen.some((c) => from < c.to && c.from < to)) continue;
    chosen.push({ from, to, moment: m, card: cardText(m) });
  }
  return chosen.sort((a, b) => a.from - b.from);
}

/** How long the reel runs (real ms): the title, each card and clip at REEL.pace, the finale, « Fin ». */
export function reelMs(clips: readonly Clip[]): number {
  let ms = REEL.titleMs + REEL.finMs;
  for (const c of clips) ms += REEL.cardMs + ((c.to - c.from) / TICK_RATE / REEL.pace) * 1000 + (c.moment.kind === "end" ? REEL.finaleMs : 0);
  return Math.round(ms);
}

/**
 * When each clip should be over (real ms from the start), by plan: a film
 * running late (a slow device draws fewer frames, so the clips play slower)
 * cuts a clip short at its time, to stay within the 25 s.
 */
export function clipDeadlines(clips: readonly Clip[]): number[] {
  let ms = REEL.titleMs;
  return clips.map((c) => (ms += REEL.cardMs + ((c.to - c.from) / TICK_RATE / REEL.pace) * 1000));
}

/** The reel of a saved match: its moments as recorded, else just its end. */
export function clipsOf(r: { reel?: ReelMoment[]; end: { tick: number; winner: Faction | null } | null; tick: number; played?: { pov: Faction } }): Clip[] {
  const endTick = r.end?.tick ?? r.tick;
  const moments = r.reel?.length ? r.reel : [{ kind: "end" as const, tick: endTick, title: endTitle(r.end?.winner ?? null, r.played?.pov ?? null) }];
  return reelClips(moments, endTick);
}

// ---------------------------------------------------------------- film ---

/**
 * The film's video types, best first: MP4 shares everywhere (and Safari
 * records nothing else); Chrome and Firefox record WebM (recent Chrome MP4
 * too). With sound, the types that name an audio codec come first.
 */
export function videoTypes(audio: boolean): string[] {
  const mp4 = audio ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2"] : ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1"];
  const webm = audio ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"] : ["video/webm;codecs=vp9", "video/webm;codecs=vp8"];
  return [...mp4, "video/mp4", ...webm, "video/webm"];
}

/** The first type this browser records (MediaRecorder.isTypeSupported), or null: no film here. */
export function pickVideoType(supported: (type: string) => boolean, audio: boolean): string | null {
  for (const t of videoTypes(audio))
    try {
      if (supported(t)) return t;
    } catch {
      /* a browser that throws on a type: try the next */
    }
  return null;
}

/** The film's file name: panache-<map>-<date>.mp4 (or .webm). */
export function filmName(map: string, created: string, type: string): string {
  const d = new Date(created);
  // (the player's own day, not UTC's)
  const day = isNaN(d.getTime()) ? "partie" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `panache-${map.replace(/[^a-z0-9-]/gi, "")}-${day}.${type.startsWith("video/mp4") ? "mp4" : "webm"}`;
}

/** A saved match's file: panache-<map>-<date>.json (the battle viewer plays it: 🎬 Voir une rediffusion). */
export const recordName = (map: string, created: string): string => filmName(map, created, "").replace(/\.webm$/, ".json");

/** The film's bitrate (bits/s): ~6 MB for 25 s, crisp enough for a phone screen. */
export const FILM_BPS = 2_000_000;
/** Its longest side (px): the reel's canvas is drawn at most this big. */
export const FILM_MAX_PX = 1280;
