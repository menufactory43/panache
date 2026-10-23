/**
 * The Archives' saved matches: the last ARCHIVE.max matches the player
 * played (single player, and duels), each a battle record (match-record.ts,
 * src/versus/feed.ts), kept in IndexedDB — or, where it's missing or
 * blocked, in localStorage under a smaller budget, or only for this page.
 * The hub's 🎬 Archives sheet lists them (▶ Temps forts, 🎬 Revoir, ⬇ the
 * .json for the battle viewer anywhere), and the report's « Revoir les
 * temps forts » plays the newest.
 *
 * The size check: a record bigger than ARCHIVE.recordBytes isn't kept, and
 * the oldest go first once there are more than `max` or they weigh more
 * than the store's budget together (pruneArchive).
 *
 * Engine-free (tests/archive.test.ts): the stores are injectable.
 */
import type { BattleRecord, PlayedInfo } from "../arena/record";
import { TICK_RATE } from "../sim/balance";
import { tr } from "../lang";

export const ARCHIVE = {
  max: 5,
  /** One record at most (JSON characters): a long match of two busy commanders is ~0.5 MB. */
  recordBytes: 3_000_000,
  /** All of them together: IndexedDB, and the localStorage fallback (its quota is ~5 MB for the whole site). */
  totalBytes: 12_000_000,
  localBytes: 2_500_000
} as const;

/** What the list shows of a saved match, without reading its record. */
export interface ArchiveMeta {
  id: string;
  created: string;
  map: string;
  /** Match length (game seconds). */
  secs: number;
  played: PlayedInfo | null;
  /** Its JSON's length. */
  bytes: number;
  /** It has a highlight reel's moments. */
  reel: boolean;
}

export interface ArchiveStore {
  /** Saved matches, newest first. */
  list(): Promise<ArchiveMeta[]>;
  get(id: string): Promise<string | null>;
  put(meta: ArchiveMeta, json: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Total bytes this store may hold. */
  readonly budget: number;
}

// ------------------------------------------------------------ encoding ---

/** A record as stored and downloaded: its JSON. */
export const encodeRecord = (r: BattleRecord): string => JSON.stringify(r);

/** A stored record back, checked enough to replay: throws on anything else. */
export function decodeRecord(text: string): BattleRecord {
  const r = JSON.parse(text) as BattleRecord;
  if (!r || typeof r !== "object" || r.v !== 1 || typeof r.map !== "string" || typeof r.seed !== "number" || !Array.isArray(r.turns) || !Array.isArray(r.hashes) || !r.seats)
    throw new Error(tr("Ce n'est pas un enregistrement de partie", "That isn't a match record"));
  for (const t of r.turns) if (!Array.isArray(t) || typeof t[0] !== "number" || (t[1] !== "blue" && t[1] !== "red") || !Array.isArray(t[2])) throw new Error(tr("Tour illisible", "Unreadable turn"));
  return r;
}

/** The list's line for a record. */
export function metaOf(r: BattleRecord, json: string, id: string): ArchiveMeta {
  const tick = r.end?.tick ?? r.tick;
  return { id, created: r.created, map: r.map, secs: Math.round(tick / TICK_RATE), played: r.played ?? null, bytes: json.length, reel: !!r.reel?.length };
}

/**
 * Which saved matches to drop so that `list` (newest first, the one just
 * added among them) keeps `max` at most and weighs `budget` at most: the
 * oldest go first, and the newest always stays.
 */
export function pruneArchive(list: readonly ArchiveMeta[], max: number = ARCHIVE.max, budget: number = ARCHIVE.totalBytes): string[] {
  const sorted = [...list].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const drop: string[] = [];
  let bytes = 0;
  sorted.forEach((m, i) => {
    bytes += m.bytes;
    if (i > 0 && (i >= max || bytes > budget)) drop.push(m.id);
  });
  return drop;
}

/** A fresh id: its creation time and a random tail. */
export const archiveId = (created: string, rnd: () => number = Math.random): string =>
  `${created.replace(/[^0-9]/g, "").slice(0, 14)}-${Math.floor(rnd() * 0xffffff).toString(36)}`;

/** Keep a match: null when it's too big or the store failed. */
export async function archiveMatch(store: ArchiveStore, r: BattleRecord): Promise<ArchiveMeta | null> {
  const json = encodeRecord(r);
  if (json.length > ARCHIVE.recordBytes || json.length > store.budget) return null;
  const meta = metaOf(r, json, archiveId(r.created));
  try {
    await store.put(meta, json);
    const list = await store.list();
    for (const id of pruneArchive(list, ARCHIVE.max, store.budget)) await store.remove(id);
    return meta;
  } catch (e) {
    console.warn("archives:", e);
    return null;
  }
}

/** A saved match's record (null: gone, or unreadable). */
export async function loadMatch(store: ArchiveStore, id: string): Promise<BattleRecord | null> {
  try {
    const json = await store.get(id);
    return json ? decodeRecord(json) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- stores ---

const newestFirst = (a: ArchiveMeta, b: ArchiveMeta) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

/** For this page only (no storage at all), and for tests. */
export function memoryStore(budget: number = ARCHIVE.totalBytes): ArchiveStore {
  const m = new Map<string, { meta: ArchiveMeta; json: string }>();
  return {
    budget,
    list: async () => [...m.values()].map((e) => e.meta).sort(newestFirst),
    get: async (id) => m.get(id)?.json ?? null,
    put: async (meta, json) => void m.set(meta.id, { meta, json }),
    remove: async (id) => void m.delete(id)
  };
}

const LOCAL_KEY = "panache.archives";

/** localStorage, under its smaller budget: one key holding them all. */
export function localStore(storage: Pick<Storage, "getItem" | "setItem">, budget: number = ARCHIVE.localBytes): ArchiveStore {
  const read = (): { meta: ArchiveMeta; json: string }[] => {
    try {
      const v = JSON.parse(storage.getItem(LOCAL_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? (v as { meta: ArchiveMeta; json: string }[]).filter((e) => e?.meta && typeof e.json === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (all: { meta: ArchiveMeta; json: string }[]) => storage.setItem(LOCAL_KEY, JSON.stringify(all));
  return {
    budget,
    list: async () => read().map((e) => e.meta).sort(newestFirst),
    get: async (id) => read().find((e) => e.meta.id === id)?.json ?? null,
    put: async (meta, json) => {
      // (over the quota: make room from the oldest first, the new one always stays)
      const all = [{ meta, json }, ...read().filter((e) => e.meta.id !== meta.id)];
      const keep = new Set(all.map((e) => e.meta.id));
      for (const id of pruneArchive(all.map((e) => e.meta), ARCHIVE.max, budget)) keep.delete(id);
      write(all.filter((e) => keep.has(e.meta.id)));
    },
    remove: async (id) => write(read().filter((e) => e.meta.id !== id))
  };
}

const DB = "panache";
const STORE = "parties";

/** IndexedDB: one object store, each entry { meta, json } under its id. */
export function idbStore(idb: IDBFactory): ArchiveStore {
  let open: Promise<IDBDatabase> | null = null;
  const db = () =>
    (open ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "meta.id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB bloquée"));
    }));
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    db().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  return {
    budget: ARCHIVE.totalBytes,
    list: async () => ((await run("readonly", (s) => s.getAll())) as { meta: ArchiveMeta }[]).map((e) => e.meta).sort(newestFirst),
    get: async (id) => ((await run("readonly", (s) => s.get(id))) as { json: string } | undefined)?.json ?? null,
    put: async (meta, json) => void (await run("readwrite", (s) => s.put({ meta, json }))),
    remove: async (id) => void (await run("readwrite", (s) => s.delete(id)))
  };
}

let shared: ArchiveStore | null = null;

/** This browser's Archives: IndexedDB, else localStorage, else this page's memory. */
export function archives(): ArchiveStore {
  if (shared) return shared;
  try {
    if (typeof indexedDB !== "undefined" && indexedDB) return (shared = fallbackTo(idbStore(indexedDB)));
  } catch {
    /* blocked */
  }
  try {
    if (typeof localStorage !== "undefined") return (shared = localStore(localStorage));
  } catch {
    /* blocked */
  }
  return (shared = memoryStore());
}

/** IndexedDB that turns out not to open (a private window in some browsers): localStorage instead, from then on. */
function fallbackTo(primary: ArchiveStore): ArchiveStore {
  let use: Promise<ArchiveStore> | null = null;
  const pick = () =>
    (use ??= primary.list().then(
      () => primary,
      () => {
        try {
          return localStore(localStorage);
        } catch {
          return memoryStore();
        }
      }
    ));
  return {
    get budget() {
      return primary.budget;
    },
    list: async () => (await pick()).list(),
    get: async (id) => (await pick()).get(id),
    put: async (m, j) => (await pick()).put(m, j),
    remove: async (id) => (await pick()).remove(id)
  };
}
