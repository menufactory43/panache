/**
 * The battle viewer (AGENT-BATTLES.md "Watching"): plays a battle record
 * from tools/arena.ts in the game's own 3D view, as an AI-vs-AI spectator
 * match fed by the record instead of the AI. main.ts loads this module only
 * when it's wanted, so it costs the menu nothing:
 *
 *   menu → 🎬 Watch a replay: paste a record, or pick its file (any build)
 *   /?replay=<record>: its link, relative to the game, any CORS-enabled URL, a GitHub file or a Gist (any build;
 *     npm run dev, then /?replay=battles/<file>.json reaches the project's own files: tools/arena.ts watch does this)
 *   /?replay=battles/<file>.json&follow                      (dev builds) a live battle: re-read every second
 *
 * It checks the world hash every 100 ticks as it plays, and says so if the
 * replay drifts from the battle. A record from other sim code, unless it's
 * pinned to this build's version (BattleRecord.version), is also played
 * through in a worker as it starts (checkAhead), so a drift shows before the
 * playhead gets there, with a link to the version the record is pinned to.
 * It keeps a copy of the world every 30 s so the seek bar can jump back; the
 * commanders' radio lines go to the ticker and the announcer; a panel shows
 * each side's orders and notes round by round.
 */
import { setupWorld, worldHash, type BattleRecord, type RoundLog } from "../arena/record";
import { TICK_RATE } from "../sim/balance";
import { isKnownMapId } from "../sim/maps";
import { OPENERS, isOpenerId } from "../sim/openers";
import type { Command, Faction, Nation, World } from "../sim/types";
import { replayPanel, type ReplayPanel } from "../ui/replay";
import type { GameScene, MatchFeed } from "./GameScene";

declare const __SIM_HASH__: string | undefined;
/** The sim this build plays (vite.config.ts; tools/arena/files.ts simHash), or null outside a Vite build. */
export const BUILD_SIM: string | null = typeof __SIM_HASH__ === "undefined" ? null : __SIM_HASH__;
declare const __VERSION_TAG__: string | null | undefined;
/** The version tag this build is (v11: tools/build-pages.mjs), or null (main, and local builds). */
export const BUILD_TAG: string | null = typeof __VERSION_TAG__ === "undefined" ? null : __VERSION_TAG__;

/** A keyframe every 30 s of game time. */
const KEYFRAME_TICKS = 30 * TICK_RATE;
/** A saved duel's seat (src/versus/records.ts, which the viewer may not import): which phone played it, over sound or online. */
const SOUND_DUEL_SEAT = /^(?:sound|online)-duel:(host|guest)$/;
/** The nations as the viewer names them (absent: Classique). */
export const NATION_NAMES: Record<Nation, string> = { republique: "République", empire: "Empire" };

export const clock = (tick: number) => {
  const s = Math.floor(tick / TICK_RATE);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export class ReplayFeed implements MatchFeed {
  readonly world: World;
  readonly labels: Record<Faction, string>;
  record: BattleRecord;
  /** The first tick whose hash didn't match, if any. */
  divergedAt: number | null = null;
  /** The same, found ahead of the playhead by checkAhead (null: not found, or not looked for). */
  driftsAt: number | null = null;
  scene: GameScene | null = null;
  /** Wall-clock time (ms) the record last grew, for "thinking…" in follow mode. */
  grewAt = performance.now();
  private byTick = new Map<number, Command[]>();
  private hashes = new Map<number, string>();
  private keyframes = new Map<number, World>();
  private radioNext = 0;
  private panel: ReplayPanel | null = null;
  private fetchIn = 1000;
  private fetching = false;

  /** `url`: where the record came from, if it has a link (follow: re-read it from there). */
  constructor(record: BattleRecord, readonly url: string | null, readonly follow: boolean) {
    this.record = record;
    this.world = setupWorld(record);
    this.keyframes.set(0, structuredClone(this.world));
    this.labels = { blue: this.label("blue"), red: this.label("red") };
    this.index();
  }

  private label(side: Faction): string {
    const nation = this.record.nations?.[side];
    const base = this.seatLabel(side);
    return nation ? `${NATION_NAMES[nation]} · ${base}` : base;
  }

  private seatLabel(side: Faction): string {
    const opener = this.record.openers[side];
    const player = this.record.seats[side].player;
    // a saved sound duel (src/versus/records.ts names its seats "sound-duel:host" and "sound-duel:guest"): the phone
    // and the opener as the game names them, "Host phone · Air Wing"; the record itself stays as it is
    const phone = SOUND_DUEL_SEAT.exec(player)?.[1];
    if (phone) return `Téléphone ${phone === "host" ? "hôte" : "invité"}${opener ? ` · ${isOpenerId(opener) ? OPENERS[opener].name : opener}` : ""}`;
    return `${player.replace(/^(openai|anthropic|llm):/, "")}${opener ? ` · ${opener}` : ""}`;
  }

  private index(): void {
    this.byTick.clear();
    for (const [tick, , cmds] of this.record.turns) this.byTick.set(tick, [...(this.byTick.get(tick) ?? []), ...cmds]);
    this.hashes = new Map(this.record.hashes);
  }

  /** How far the battle has been played (a live one grows). */
  get playedTo(): number {
    return this.record.end?.tick ?? this.record.tick ?? 0;
  }

  /** The round a tick falls in (round r starts at (r-1) × round ticks). */
  roundAt(tick: number): number {
    return Math.floor(tick / this.record.round) + 1;
  }

  /** A side's log entry for a round (null: it was waiting, or the round isn't played yet). */
  logFor(round: number, side: Faction): RoundLog | null {
    return this.record.log.find((l) => l.round === round && l.side === side) ?? null;
  }

  commands(tick: number): Command[] | null {
    if (tick >= this.playedTo) return null;
    return this.byTick.get(tick) ?? [];
  }

  attach(scene: GameScene): void {
    this.scene = scene;
    this.panel = replayPanel(this, scene);
    // (for tools/arena-viewer-check.mjs and the console)
    (window as unknown as Record<string, unknown>).__replay = this;
    if (!this.follow && !knownToMatch(this.record)) this.checkAhead();
  }

  /** Play the whole record through in a worker (a few seconds at most), to find where this build drifts from it, if anywhere. */
  private checkAhead(): void {
    const worker = new Worker(new URL("./replay-check.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<number | null>) => {
      this.driftsAt = e.data;
      worker.terminate();
    };
    // (the check as it plays still works)
    worker.onerror = () => worker.terminate();
    worker.postMessage(this.record);
  }

  afterTick(w: World, seeking: boolean): void {
    const want = this.hashes.get(w.tick);
    if (want !== undefined && this.divergedAt === null && worldHash(w) !== want) {
      this.divergedAt = w.tick;
      this.scene?.alert(`⚠ Ce replay a divergé à ${clock(w.tick)}`);
    }
    if (w.tick % KEYFRAME_TICKS === 0 && !this.keyframes.has(w.tick)) this.keyframes.set(w.tick, structuredClone(w));
    const radio = this.record.radio;
    while (this.radioNext < radio.length && radio[this.radioNext]![0] <= w.tick) {
      const [, side, text] = radio[this.radioNext++]!;
      if (!seeking) this.scene?.commanderRadio(side, text);
    }
  }

  frame(deltaMs: number): void {
    this.panel?.update();
    if (!this.follow || !this.url || this.record.end) return;
    this.fetchIn -= deltaMs;
    if (this.fetchIn > 0 || this.fetching) return;
    this.fetchIn = 1000;
    this.fetching = true;
    void fetchRecord(this.url)
      .then((r) => this.grow(r))
      .catch(() => {})
      .finally(() => (this.fetching = false));
  }

  /** A newer copy of a live record: same battle, more rounds. */
  private grow(r: BattleRecord): void {
    if (r.seed !== this.record.seed || r.map !== this.record.map || r.created !== this.record.created) return;
    if ((r.end?.tick ?? r.tick) === this.playedTo && !!r.end === !!this.record.end) return;
    this.record = r;
    this.grewAt = performance.now();
    this.index();
  }

  keyframe(tick: number): World | null {
    let best = -1;
    for (const k of this.keyframes.keys()) if (k <= tick && k > best) best = k;
    const kf = best >= 0 ? this.keyframes.get(best)! : null;
    if (kf) this.radioNext = this.record.radio.findIndex((x) => x[0] > kf.tick);
    if (this.radioNext < 0) this.radioNext = this.record.radio.length;
    return kf;
  }
}

/** Is this record known to replay exactly in this build: played by its sim, or pinned to its version? (If not, checkAhead looks.) */
export const knownToMatch = (r: BattleRecord): boolean => r.sim === BUILD_SIM || (!!r.version && r.version === BUILD_TAG);

/** The replay's link in the version of the game its record is pinned to (null: not pinned, it's this one, or no link). */
export function pinnedLink(feed: ReplayFeed): string | null {
  const v = feed.record.version;
  // (the record's own word: only a version tag, as tools/build-pages.mjs publishes them)
  if (!v || v === BUILD_TAG || !feed.url || !/^v[0-9][A-Za-z0-9.+-]*$/.test(v)) return null;
  // the site's root: a version's build is a folder in it (/battledrones/v11/)
  const root = new URL(BUILD_TAG ? "../" : "./", new URL(import.meta.env.BASE_URL, location.href));
  return `${new URL(`${v}/`, root).href}?replay=${encodeURIComponent(feed.url)}`;
}

/** A battle record from its JSON, checked enough to play: throws a message a person can act on. */
export function parseRecord(text: string): BattleRecord {
  let r: BattleRecord;
  try {
    r = JSON.parse(text) as BattleRecord;
  } catch {
    throw new Error("Ce n'est pas du JSON : colle tout le fichier .json écrit par une bataille dans battles/");
  }
  if (!r || typeof r !== "object" || r.v !== 1 || !Array.isArray(r.turns) || !Array.isArray(r.hashes) || !r.seats)
    throw new Error("Ce n'est pas un enregistrement de bataille (tools/arena.ts et llm battledrones les écrivent dans battles/)");
  if (!isKnownMapId(r.map)) throw new Error(`Cette bataille s'est jouée sur « ${r.map} », une carte absente de cette version du jeu`);
  if (!r.end && !r.tick) throw new Error("Cette bataille n'a pas encore dépassé son premier tour");
  // nations (PANACHE-CONCEPTION.md §1.10): both sides, each a nation this build knows, or none (Classique)
  if (r.nations !== undefined) {
    const n = r.nations as Record<string, unknown> | null;
    const ok = (v: unknown) => v === "republique" || v === "empire";
    if (!n || typeof n !== "object" || !ok(n.blue) || !ok(n.red))
      throw new Error("Les nations de cette bataille sont illisibles, ou inconnues de cette version du jeu");
  }
  return r;
}

async function fetchRecord(url: string): Promise<BattleRecord> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return parseRecord(await res.text());
}

/** A pasted (or picked) record, ready for GameScene. */
export function replayFromJson(text: string): ReplayFeed {
  return new ReplayFeed(parseRecord(text), null, false);
}

/** A Gist's page, gist.github.com/[<owner>/]<id>[/<revision>]: its raw files are served with CORS, the page isn't. */
const GIST = /^https?:\/\/gist\.github\.com\/(?:([^/]+)\/)?([0-9a-f]+)(?:\/([0-9a-f]+))?$/i;
/** A file's page on GitHub, github.com/<owner>/<repo>/blob/<ref>/<path>: raw.githubusercontent.com serves it with CORS. */
const GITHUB_FILE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i;

/**
 * The text of a battle record linked by URL: relative to the page or
 * absolute, from any server that sends CORS headers, a file's page on GitHub,
 * or a Gist (the record viewer, record-viewer.html, reads links the same way).
 * Throws a message a person can act on.
 */
export async function fetchLinkedRecord(ref: string, base = location.href): Promise<string> {
  let url: URL;
  try {
    url = new URL(ref.trim(), base);
  } catch {
    throw new Error(`« ${ref} » n'est pas une URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Seuls les liens http et https peuvent être chargés");
  const page = (url.origin + url.pathname).replace(/\/$/, "");
  const gist = GIST.exec(page);
  if (gist) {
    const [, owner, id, revision] = gist;
    // with the owner in the link, the raw file needs no API call (GitHub allows 60 an hour per address); it's the Gist's first file
    if (owner) return fetchText(`https://gist.githubusercontent.com/${owner}/${id}/raw/${revision ?? ""}`);
    const res = await fetch(`https://api.github.com/gists/${id}${revision ? `/${revision}` : ""}`).catch(() => null);
    if (!res?.ok) throw new Error(`Impossible de trouver le Gist ${id} via l'API GitHub${res ? ` (${res.status})` : ""}`);
    const files = Object.values(((await res.json()) as { files?: Record<string, { filename: string; raw_url: string }> }).files ?? {});
    const file = files.find((f) => /\.json$/i.test(f.filename)) ?? files[0];
    if (!file) throw new Error(`Le Gist ${id} n'a aucun fichier`);
    return fetchText(file.raw_url);
  }
  const blob = GITHUB_FILE.exec(page);
  return fetchText(blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}` : url.href);
}

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // (to a page, a server that doesn't allow cross-origin reads looks just like no network)
    throw new Error(`Impossible de récupérer ${url} : pas de réseau, ou son serveur interdit la lecture par d'autres sites (CORS)`);
  }
  if (!res.ok) throw new Error(`Impossible de récupérer ${url} : ${res.status} ${res.statusText}`.trim());
  return res.text();
}

/**
 * Load `?replay=<record>` (any build: fetchLinkedRecord) into a feed for
 * GameScene. `follow` (dev builds, `&follow`) re-reads a live battle's file
 * every second as it grows.
 */
export async function loadReplay(ref: string, follow: boolean): Promise<ReplayFeed> {
  if (!follow) return new ReplayFeed(parseRecord(await fetchLinkedRecord(ref)), new URL(ref.trim(), location.href).href, false);
  const url = new URL(ref, location.href).href;
  return new ReplayFeed(await fetchRecord(url), url, true);
}
