/**
 * What a duel leaves behind (DUEL.md "Records", "Rematch"): the
 * phone's own win/loss record, the saved battle (a BattleRecord, downloaded
 * as .json), and what a Rematch tap stores for the page it reloads into.
 *
 * Win/loss. localStorage `panache.duelenligne` holds { w, l, d,
 * abandoned, noContest }. The feed adds one outcome per match as soon as it
 * is known (the match decided, or aborted; a page that goes hidden mid-match
 * counts it as abandoned until then), and moves it over: from that stand-in
 * to the match's own end, and to no contest if a decided result turns out
 * out of sync after all; practice links (?duel=loop, ?duel=relay) never
 * write it.
 *
 * Save battle. The record replays exactly through the battle viewer and the
 * arena tools: the setup the pairing agreed, every non-empty turn as the two
 * phones stepped it (blue's entry before red's on a tick) and a world hash
 * every HASH_EVERY ticks. It is built and downloaded here without loading
 * the viewer (main.ts keeps its two import("./game/replay")), and the arena
 * code is used for its types only.
 *
 * Rematch. sessionStorage `battledrones.rematch` = "duel" and
 * `battledrones.duel` = { role, plan, micMode, hostSide, mapId, mutators, nation? },
 * the host side already flipped: rematches swap sides, never roles or bands.
 * main.ts reads it at boot, before any audio context exists, and the lobby
 * pairs with it. The keys, the token and the parser live here alone: the
 * lobby re-exports them, and main.ts, which may import the duel's types only,
 * ties its literals to them by type (`typeof DuelLobby.REMATCH_KEY`), as
 * tests/versus-rematch.test.ts checks too.
 *
 * Engine-free and DOM-light: storage and the document come in as arguments,
 * so tests pass their own (or null, where storage is blocked).
 *
 * Where the spec is silent:
 *  - the outcomes: a decided match is a win, a loss or a draw; "Friend left"
 *    and this phone leaving with no result are abandoned; out of sync is no
 *    contest. A record that can't be read starts again from zero;
 *  - an aborted record ends { tick, winner: null, reason: "aborted" } at the
 *    tick reached, and maxTicks is the end tick, so the viewer's seek bar
 *    ends where the match did. Both sides resigning on one tick ends it as a
 *    draw by "resign", not "love" (the arena's endOf says the same, so a
 *    record re-simulated by tools/arena.ts upgrade keeps it);
 *  - the seats name the roles: "online-duel:host" and "online-duel:guest"
 *    ("practice-duel:" on a practice link; older records "sound-duel:"),
 *    which the battle viewer labels "Host" and "Guest" with the opener's
 *    name (src/game/replay.ts, which may not import this);
 *  - the file is named battledrones-duel-<map>-<date>.json.
 */
import type { BattleEnd, BattleRecord } from "../arena/record";
import type { BandRole } from "../link/transport";
import { isKnownMapId } from "../sim/maps";
import { isMutatorId, type MutatorId } from "../sim/rules";
import type { MatchSetup } from "../sim/setup";
import type { Command, Faction, Nation } from "../sim/types";
import { EN, tr } from "../lang";

/** A world hash goes into the saved record every this many ticks (the arena's rate: the viewer checks them). */
export const HASH_EVERY = 100;
/** localStorage: the duel's win/loss record. */
export const ONLINE_RECORD_KEY = "panache.duelenligne";
/**
 * sessionStorage: what the reloaded page starts with (the single-player end
 * screen's Rematch writes its own tokens under the same key: "1", "spectate",
 * "daily", "op:<id>"), the duel's token, and the duel it rematches.
 */
export const REMATCH_KEY = "battledrones.rematch";
export const REMATCH_DUEL = "duel";
export const DUEL_KEY = "battledrones.duel";

type Store = Pick<Storage, "getItem" | "setItem">;

// ------------------------------------------------------------ win/loss ---

export interface DuelTally {
  w: number;
  l: number;
  d: number;
  /** Matches that ended with a phone gone: the friend left, or this phone left with no result. */
  abandoned: number;
  /** Matches the two phones' worlds drifted apart in. */
  noContest: number;
}

export type DuelOutcome = "win" | "loss" | "draw" | "abandoned" | "noContest";

const FIELD: Record<DuelOutcome, keyof DuelTally> = { win: "w", loss: "l", draw: "d", abandoned: "abandoned", noContest: "noContest" };

const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** The record so far (zero where there is none, it can't be read, or storage is blocked). */
export function readTally(store: Pick<Storage, "getItem"> | null, key = ONLINE_RECORD_KEY): DuelTally {
  let o: Partial<Record<keyof DuelTally, unknown>> | null = null;
  try {
    const raw = store?.getItem(key);
    if (raw) o = JSON.parse(raw) as Partial<Record<keyof DuelTally, unknown>> | null;
  } catch {
    /* blocked or junk: from zero */
  }
  const s = o && typeof o === "object" ? o : {};
  return { w: count(s.w), l: count(s.l), d: count(s.d), abandoned: count(s.abandoned), noContest: count(s.noContest) };
}

/** `t` with one more `o`. */
export const withOutcome = (t: DuelTally, o: DuelOutcome): DuelTally => ({ ...t, [FIELD[o]]: t[FIELD[o]] + 1 });

/** Count one match: returns the record as stored (as it would be, where storage is blocked). */
export function addOutcome(o: DuelOutcome, store: Store | null, key = ONLINE_RECORD_KEY): DuelTally {
  const t = withOutcome(readTally(store, key), o);
  try {
    store?.setItem(key, JSON.stringify(t));
  } catch {
    /* blocked: the report still shows it */
  }
  return t;
}

/**
 * Recount one match already counted as `from` as `to` instead (a result that
 * turned out to be no contest, or the stand-in abandoned a hidden page
 * counted, once the match ends): returns the record as stored.
 */
export function moveOutcome(from: DuelOutcome, to: DuelOutcome, store: Store | null, key = ONLINE_RECORD_KEY): DuelTally {
  const t = readTally(store, key);
  const f = FIELD[from];
  const back = withOutcome({ ...t, [f]: Math.max(0, t[f] - 1) }, to);
  try {
    store?.setItem(key, JSON.stringify(back));
  } catch {
    /* blocked: the report still shows it */
  }
  return back;
}

const plural = (n: number, one: string, many: string) => `${n} ${(EN ? n === 1 : n <= 1) ? one : many}`;

/** "3 wins · 1 loss · 0 draws", and the matches with no result when there were any. */
export function tallyLine(t: DuelTally): string {
  const parts = [plural(t.w, tr("victoire", "win"), tr("victoires", "wins")), plural(t.l, tr("défaite", "loss"), tr("défaites", "losses")), plural(t.d, tr("nul", "draw"), tr("nuls", "draws"))];
  const none = t.abandoned + t.noContest;
  if (none > 0) parts.push(tr(`${none} sans résultat`, `${none} no result`));
  return parts.join(" · ");
}

// -------------------------------------------------------- saved battle ---

/**
 * How a duel's record ends (the arena's endOf, which the duel code may not
 * import): decided, or aborted with no result (`winner` null). `resigned` is
 * the world's own: the side that resigned, null when both did (a draw), unset
 * otherwise (an HQ, or Robot Love).
 */
export function duelEnd(tick: number, winner: Faction | "draw" | null, resigned?: Faction | null): BattleEnd {
  if (winner === null) return { tick, winner: null, reason: "aborted" };
  if (winner === "draw") return { tick, winner: null, reason: resigned === null ? "resign" : "love" };
  return { tick, winner, reason: resigned ? "resign" : "hq" };
}

export interface DuelRecordInput {
  setup: MatchSetup;
  /** Which role each side's page played (the host plays hostSide). */
  seats: Record<Faction, BandRole>;
  /** The seats' prefix: "online-duel" (the default), or "practice-duel" on a practice link. */
  via?: "online-duel" | "practice-duel";
  /** Non-empty turns as stepped: [tick, side, commands], blue's before red's on a tick. */
  turns: [number, Faction, Command[]][];
  /** [tick, worldHash] every HASH_EVERY ticks. */
  hashes: [number, string][];
  /** Ticks stepped (the world's tick). */
  tick: number;
  end: BattleEnd;
  /** The sim this build plays (__SIM_HASH__), null outside a Vite build. */
  sim: string | null;
  created: string;
}

/** The match as a battle record (AGENT-BATTLES.md "Battle records"). */
export function battleRecord(o: DuelRecordInput): BattleRecord {
  const s = o.setup;
  return {
    v: 1,
    commit: null,
    sim: o.sim,
    created: o.created,
    map: s.map,
    mutators: s.mutators.slice(),
    seed: s.seed,
    round: 1,
    maxTicks: o.end.tick,
    openers: { ...s.openers },
    ...(s.income ? { income: { ...s.income } } : {}),
    // (the nations the pairing agreed: the viewer and the arena replay them, setupWorld(record))
    ...(s.nations ? { nations: { ...s.nations } } : {}),
    seats: { blue: { player: `${o.via ?? "online-duel"}:${o.seats.blue}` }, red: { player: `${o.via ?? "online-duel"}:${o.seats.red}` } },
    frames: "own",
    turns: o.turns.map(([t, f, cmds]) => [t, f, cmds]),
    radio: [],
    hashes: o.hashes.slice(),
    log: [],
    tick: o.tick,
    end: o.end,
    usage: {}
  };
}

/** battledrones-duel-<map>-<yyyy-mm-dd-hhmm>.json */
export function recordFileName(r: Pick<BattleRecord, "map" | "created">): string {
  const when = r.created.slice(0, 16).replace(/[T:]/g, "-");
  return `battledrones-duel-${r.map.replace(/[^a-z0-9-]/gi, "")}-${when}.json`;
}

/** Download the record as a .json file through a Blob link (no viewer, no network). */
export function downloadRecord(r: BattleRecord, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(r)], { type: "application/json" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = recordFileName(r);
  a.rel = "noopener";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // (the click has read it by the next task)
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------- rematch ---

/** What a Rematch tap hands the reloaded page: the same roles, the sides swapped. */
export interface RematchPlan {
  role: BandRole;
  /** The side the host plays in the rematch (flipped from this match's). */
  hostSide: Faction;
  mapId: string;
  mutators: MutatorId[];
  /** The nation this phone played (PANACHE-CONCEPTION.md §1.10): the host's offer, the guest's ask. Absent: Classique. */
  nation?: Nation;
  /** An online duel's room and this page's seat key (src/versus/online.ts): the rematch takes the same seat back. */
  online?: { code: string; key: string };
}

/** Leave the rematch for the next page. False where storage is blocked (the page then opens the menu). */
export function writeRematch(p: RematchPlan, store: Pick<Storage, "setItem"> | null): boolean {
  try {
    if (!store) return false;
    store.setItem(DUEL_KEY, JSON.stringify(p));
    store.setItem(REMATCH_KEY, REMATCH_DUEL);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stored rematch (DUEL_KEY's JSON), checked field by field; null when there
 * is none or it can't be used. Unknown mutators drop out (and the sound
 * link's old band and microphone fields are ignored): the rest still makes the
 * rematch. The lobby reads with this alone: by then main.ts has taken the
 * token.
 */
export function parseRematch(raw: string | null): RematchPlan | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof RematchPlan, unknown>> | null;
    if (!o || typeof o !== "object") return null;
    const { role, hostSide, mapId, mutators, online, nation } = o;
    if (role !== "host" && role !== "guest") return null;
    if (hostSide !== "blue" && hostSide !== "red") return null;
    if (typeof mapId !== "string" || !isKnownMapId(mapId)) return null;
    const muts = Array.isArray(mutators) ? mutators.filter((m): m is MutatorId => typeof m === "string" && isMutatorId(m)) : [];
    const r: RematchPlan = { role, hostSide, mapId, mutators: muts };
    if (nation === "republique" || nation === "empire") r.nation = nation;
    const on = online as { code?: unknown; key?: unknown } | null | undefined;
    if (on && typeof on === "object" && typeof on.code === "string" && /^[A-Z]{4}$/.test(on.code) && typeof on.key === "string" && /^[0-9a-f]{1,64}$/.test(on.key))
      r.online = { code: on.code, key: on.key };
    return r;
  } catch {
    return null;
  }
}

/** The stored rematch with its token (what the next boot sees), or null. */
export function readRematch(store: Pick<Storage, "getItem"> | null): RematchPlan | null {
  try {
    if (store?.getItem(REMATCH_KEY) !== REMATCH_DUEL) return null;
    return parseRematch(store.getItem(DUEL_KEY));
  } catch {
    return null;
  }
}
