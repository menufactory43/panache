/**
 * The cloud save's contents (account.ts sends it): the progress a player would
 * hate to lose, read from and written back to this device's storage. The
 * career (ranks, medals, stars, campaign), the Last Stand records, and the
 * lessons and intro already seen. Settings and Archives stay on the device.
 *
 * Two copies of a save (this device's and the cloud's, or two devices') are
 * merged, never one written over the other: every number only grows (the
 * most XP, the most wins), stars add up, best times are the shortest, a lesson
 * done is done. The merge gives the same result in either order and merging
 * twice changes nothing, so every device ends up with the same save.
 * Engine-free; the storage is injectable for tests.
 */
import { emptyCareer, sanitizeCareer, type CareerData, type OpRecord } from "./career";

/** The storage keys the save holds (career.ts, survival.ts, tutorial.ts, ui/hud.ts, ui/title.ts). */
export const SAVE_KEYS = {
  career: "panache.career",
  laststand: "panache.laststand",
  flags: ["panache.tutorial", "panache.instruction", "panache.instruction2", "panache.intro.seen"]
} as const;

/** A flag's value once it is earned (the hints' « done », the intro's « 1 »): it never goes back. */
const EARNED = new Set(["done", "1"]);

export interface LastStandBest {
  best: number;
  kills: number;
  runs: number;
}

export interface SaveData {
  v: 1;
  career: CareerData;
  /** "map:difficulty" → the best run there. */
  laststand: Record<string, LastStandBest>;
  /** A storage key → its earned value. */
  flags: Record<string, string>;
}

export interface SaveStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export const emptySave = (): SaveData => ({ v: 1, career: emptyCareer(), laststand: {}, flags: {} });

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const minTime = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** A save from anywhere (the cloud, an old device), every field checked. */
export function sanitizeSave(raw: unknown): SaveData {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<SaveData>;
  const s = emptySave();
  s.career = sanitizeCareer(o.career ?? null);
  if (o.laststand && typeof o.laststand === "object")
    for (const [k, r] of Object.entries(o.laststand))
      if (r && typeof r === "object" && k.length <= 64) s.laststand[k] = { best: num(r.best), kills: num(r.kills), runs: num(r.runs) };
  if (o.flags && typeof o.flags === "object")
    for (const k of SAVE_KEYS.flags) {
      // (a save made before the keys were renamed holds « battledrones.x », storage-rename.ts)
      const f = o.flags as Record<string, unknown>;
      const v = f[k] ?? f[k.replace(/^panache\./, "battledrones.")];
      if (typeof v === "string" && EARNED.has(v)) s.flags[k] = v;
    }
  return s;
}

function mergeOp(a: OpRecord | undefined, b: OpRecord | undefined): OpRecord {
  if (!a || !b) return { ...(a ?? b)! };
  const r: OpRecord = {
    stars: (a.stars | b.stars) & 7,
    bestSecs: minTime(a.bestSecs, b.bestSecs),
    plays: Math.max(a.plays, b.plays),
    wins: Math.max(a.wins, b.wins)
  };
  if (a.cleared || b.cleared) r.cleared = true;
  return r;
}

function mergeCareer(a: CareerData, b: CareerData): CareerData {
  const c = emptyCareer();
  c.xp = Math.max(a.xp, b.xp);
  c.wins = Math.max(a.wins, b.wins);
  c.losses = Math.max(a.losses, b.losses);
  for (const id of new Set([...Object.keys(a.medals), ...Object.keys(b.medals)]) as Set<keyof CareerData["medals"]>)
    c.medals[id] = Math.max(a.medals[id] ?? 0, b.medals[id] ?? 0);
  for (const k of new Set([...Object.keys(a.stars), ...Object.keys(b.stars)])) c.stars[k] = ((a.stars[k] ?? 0) | (b.stars[k] ?? 0)) & 7;
  for (const k of new Set([...Object.keys(a.records), ...Object.keys(b.records)])) {
    const x = a.records[k];
    const y = b.records[k];
    c.records[k] = !x || !y ? { ...(x ?? y)! } : { w: Math.max(x.w, y.w), l: Math.max(x.l, y.l), bestSecs: minTime(x.bestSecs, y.bestSecs) };
  }
  // the streak belongs to the latest win (the other side's is older, or the same one)
  const later = a.daily.lastWin > b.daily.lastWin ? a.daily : b.daily.lastWin > a.daily.lastWin ? b.daily : null;
  c.daily = {
    lastWin: Math.max(a.daily.lastWin, b.daily.lastWin),
    streak: later ? later.streak : Math.max(a.daily.streak, b.daily.streak),
    bestStreak: Math.max(a.daily.bestStreak, b.daily.bestStreak),
    wins: Math.max(a.daily.wins, b.daily.wins),
    plays: Math.max(a.daily.plays, b.daily.plays)
  };
  c.laststand = {
    runs: Math.max(a.laststand.runs, b.laststand.runs),
    waves: Math.max(a.laststand.waves, b.laststand.waves),
    best: Math.max(a.laststand.best, b.laststand.best)
  };
  for (const k of new Set([...Object.keys(a.ops), ...Object.keys(b.ops)])) c.ops[k] = mergeOp(a.ops[k], b.ops[k]);
  return c;
}

/** Two saves as one: nothing either of them earned is lost. */
export function mergeSaves(a: SaveData, b: SaveData): SaveData {
  const s = emptySave();
  s.career = mergeCareer(a.career, b.career);
  for (const k of new Set([...Object.keys(a.laststand), ...Object.keys(b.laststand)])) {
    const x = a.laststand[k];
    const y = b.laststand[k];
    if (!x || !y) s.laststand[k] = { ...(x ?? y)! };
    else {
      // the kills go with the best run (the more kills when the two best runs tie)
      const top = x.best > y.best || (x.best === y.best && x.kills >= y.kills) ? x : y;
      s.laststand[k] = { best: top.best, kills: top.kills, runs: Math.max(x.runs, y.runs) };
    }
  }
  for (const k of SAVE_KEYS.flags) {
    const v = a.flags[k] ?? b.flags[k];
    if (v) s.flags[k] = v;
  }
  return s;
}

/** A canonical text of a save: two saves with the same contents give the same text (keys sorted). */
export function saveText(s: SaveData): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(s));
}

function parse(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** This device's save, read from its storage. */
export function readSave(store: SaveStore): SaveData {
  const flags: Record<string, string> = {};
  for (const k of SAVE_KEYS.flags) {
    const v = store.getItem(k);
    if (v !== null) flags[k] = v;
  }
  return sanitizeSave({ career: parse(store.getItem(SAVE_KEYS.career)), laststand: parse(store.getItem(SAVE_KEYS.laststand)), flags });
}

/** Write a save into this device's storage (only what differs). True if anything changed. */
export function writeSave(store: SaveStore, s: SaveData): boolean {
  const here = readSave(store);
  let changed = false;
  if (saveText({ ...emptySave(), career: here.career }) !== saveText({ ...emptySave(), career: s.career })) {
    store.setItem(SAVE_KEYS.career, JSON.stringify(s.career));
    changed = true;
  }
  if (saveText({ ...emptySave(), laststand: here.laststand }) !== saveText({ ...emptySave(), laststand: s.laststand })) {
    // (the records keep any field survival.ts adds later: merged over what is there)
    const old = parse(store.getItem(SAVE_KEYS.laststand));
    const base = old && typeof old === "object" ? (old as Record<string, object>) : {};
    const all: Record<string, object> = { ...base };
    for (const [k, r] of Object.entries(s.laststand)) all[k] = { ...(base[k] ?? {}), ...r };
    store.setItem(SAVE_KEYS.laststand, JSON.stringify(all));
    changed = true;
  }
  for (const [k, v] of Object.entries(s.flags))
    if (here.flags[k] !== v) {
      store.setItem(k, v);
      changed = true;
    }
  return changed;
}
