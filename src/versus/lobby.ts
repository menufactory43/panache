/**
 * The duel's lobby (DUEL.md "The lobby", "Getting into a duel", "Rematch",
 * "Dev and test modes"): the sheet between the menu's Duel tap and the match.
 * It creates or joins the online room, shows the friend while the two pages
 * pair, offers the opener cards, and once both said GO builds the VersusFeed
 * and hands it to main.ts's start(). The lazily loaded duel chunk starts here:
 * main.ts reaches src/versus and src/link only through
 * `import("./versus/lobby")`.
 *
 * The lobby's logic is LobbyMachine (no DOM: a clock and a link factory come
 * in through LobbyEnv, so tests drive it over PacketAir); the sheet renders
 * its state() every frame and sends it the taps.
 *
 * Practice links (every build): `?duel=loop` pairs with an in-page friend
 * over PacketAir (loop-peer.ts), `?duel=relay&seat=host|guest` through the
 * page functions __duelOut / __duelIn (relay-transport.ts). Both expose
 * window.__duel = { state, tick, delay, trail(), trails(from), hash(),
 * result } for test harnesses, as an online duel does.
 *
 * Where the spec is silent:
 *  - "nothing heard": the pairing's own 8 s hint offers the one-tap role
 *    switch on the loop (an online duel and a relay seat have fixed roles);
 *    after 30 s since the role was tapped with still nothing of the other
 *    role heard, tips;
 *  - a rematch pairs at once in its stored role and falls back to the menu
 *    (onClose("fallback")) after 60 s from the tap with nothing heard;
 *  - Cancel, Back and a closed error say the end to a friend that may have
 *    started (Session.leave), keep the link on until the session is
 *    closable, then call onClose;
 *  - a friend that left once this page said GO ("Your friend left",
 *    status().peerEnded) stops the lobby there: no match is loaded;
 *  - a friend heard and then silent for 8 s (QUIET_MS) gets a line under the
 *    status ("Your friend isn't responding"), from pairing to GO;
 *  - a retry ("Pairing failed: tap to retry") starts the tips' 30 s and a
 *    rematch's 60 s again, as the pairing starts its 8 s hint again;
 *  - on the loop the round trip would be the friend's hold, which forces
 *    &delay: its line names the input delay the pairing agreed instead;
 *  - the opener cards say what each opener gives, as the single-player
 *    picker's pills do, from the same data (openerGives);
 *  - a version error names the older page when the protocols differ;
 *  - window.__duel.state is the lobby's step (LobbyStep) until the feed is
 *    built, then the session's phase; result is null until the match begins,
 *    then the lockstep's end, decision and end check.
 */
import "./lobby.css";
import { sfx } from "../game/audio";
import { gameMode } from "../game/mode";
import type { BandPlan, BandRole, LinkTransport } from "../link/transport";
import { ROLES, UNITS } from "../sim/balance";
import { displayName, pluralName } from "../sim/lexicon";
import { inRoster } from "../sim/rules";
import { nationText, type Words } from "../ui/openers";
import { portraitKind } from "../game/three/belle/placeholders";
import { worldHash } from "../sim/checksum";
import { mapById } from "../sim/maps";
import { OPENERS, type OpenerId } from "../sim/openers";
import { MUTATORS, type MutatorId } from "../sim/rules";
import type { Faction, Nation, NationOrClassic, Role, UnitKind } from "../sim/types";
import { fullscreen } from "../ui/fullscreen";
import { VersusFeed } from "./feed";
import { LoopLink, type LoopParams } from "./loop-peer";
import { FAILED_MESSAGE, NOTHING_HEARD_MESSAGE, NOTHING_HEARD_MS, VERSION_MESSAGE, configNations, rivalOf, type DuelConfig, type HostOffer, type PairingState } from "./pairing";
import { OnlineError, browserOnlineEnv, drawKey, hostRoom, inviteUrl, joinRoom, normCode, relayBase, type OnlineInfo, type OnlineLink } from "./online";
import { DUEL_KEY, parseRematch, type RematchPlan } from "./records";
import { RelayTransport } from "./relay-transport";
import { Session } from "./session";
import { LANG, tr } from "../lang";
import { shareBase } from "../native";


declare const __DUEL_HASH__: string | undefined;

// ------------------------------------------------------------ settings ---

/** The duel build hash's first 16 bits (DUEL.md "Build check"); 0 where the build defines none (tests). */
export const duelBuild = (): number => (typeof __DUEL_HASH__ === "string" ? parseInt(__DUEL_HASH__.slice(0, 4), 16) || 0 : 0);

/** ?duel=loop and ?duel=relay: a practice link. */
export type PracticeMode = "loop" | "relay";

export interface DuelParams {
  /** "none": the real thing (no ?duel, or another value). */
  mode: "none" | PracticeMode;
  /** ?duel=relay&seat=: the role this page pairs in at once (null: Host / Join as usual). */
  seat: BandRole | null;
  /** ?duel=loop's link: &delay (3–8, rounded), &loss (0–0.9), &latency (0–2000 ms). */
  loop: LoopParams;
  /** &side=red: the side a practice page plays when it hosts (the loop's friend hosts with the other). */
  side: Faction;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The dev modes' URL parameters, clamped (DUEL.md "Dev and test modes"). */
export function parseDuelParams(search: string): DuelParams {
  const q = new URLSearchParams(search);
  const d = q.get("duel");
  const mode = d === "loop" || d === "relay" ? d : "none";
  const num = (k: string): number | null => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const delay = num("delay");
  const loss = num("loss");
  const latency = num("latency");
  const seat = q.get("seat");
  return {
    mode,
    seat: mode === "relay" && (seat === "host" || seat === "guest") ? seat : null,
    loop: {
      delay: delay === null ? null : clamp(Math.round(delay), 3, 8),
      loss: loss === null ? 0 : clamp(loss, 0, 0.9),
      latencyMs: latency === null ? 250 : clamp(latency, 0, 2000)
    },
    side: q.get("side") === "red" ? "red" : "blue"
  };
}

/**
 * The rematch's storage (DUEL.md "Rematch"): sessionStorage REMATCH_KEY
 * = REMATCH_DUEL makes the next boot a duel rematch (main.ts takes it, its
 * literals tied to these by type), and DUEL_KEY holds the rematch, written
 * by records.ts writeRematch and read here with its parseRematch.
 */
export { DUEL_KEY, REMATCH_DUEL, REMATCH_KEY, parseRematch } from "./records";

/** A rematch as the report's Rematch stored it: the same roles, the sides swapped (hostSide is already the new one). */
export type DuelRematch = RematchPlan;

/** The stored rematch (`take`: and forget it, so a reload after it is a plain boot). */
function readRematch(take: boolean): DuelRematch | null {
  try {
    const r = parseRematch(sessionStorage.getItem(DUEL_KEY));
    if (take) sessionStorage.removeItem(DUEL_KEY);
    return r;
  } catch {
    return null;
  }
}

/** What the Duel tap needs before the lobby exists. */
export interface DuelTap {
  /** A practice link (?duel=loop|relay). */
  practice: PracticeMode | null;
  /** An online duel (src/versus/online.ts). */
  online: boolean;
}

/** For main.ts's Duel tap (`rematch`: the rematch's reconnect tap; `online`: the online duel's button). */
export function tapPlan(rematch = false, online = false): DuelTap {
  const p = parseDuelParams(location.search);
  const stored = rematch ? readRematch(false) : null;
  const net = rematch ? !!stored?.online : online;
  return { practice: net || p.mode === "none" ? null : p.mode, online: net };
}

/** The room code of an invite link (`?salon=ABCD`), for main.ts's boot. */
export { codeFromSearch } from "./online";

/** Uniform in [0, 1) from the platform's CSPRNG: the pairing's nonces. */
export const cryptoRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;

// ------------------------------------------------------------ the logic ---

/** Where the lobby is. */
export type LobbyStep =
  /** Host / Join (online: create a room, or join one with its code). */
  | "choose"
  /** The link is being made (the room opening). */
  | "connecting"
  /** Waiting for the friend, or linking: the hints. */
  | "pairing"
  /** Paired: the opener cards. */
  | "picking"
  /** Picked: waiting for the friend's pick. */
  | "waiting"
  /** This phone said GO: waiting for the friend's. */
  | "go"
  /** Both said GO: the match loads. */
  | "loading"
  /** The feed is built and the match starting: the lobby is done. */
  | "started"
  | "error"
  /** Cancelled or failed: the sheet is gone (the link may still be saying the end). */
  | "closed";

export interface LobbyError {
  /** "online": the relay's room can't be had. "relay": a practice relay page with no harness. */
  kind: "version" | "failed" | "relay" | "left" | "online" | "other";
  message: string;
  /** A version error: which phone runs the older protocol (null: can't tell). */
  older?: "this" | "friend" | null;
}

/** The link the lobby holds. */
export type LobbyLink = LinkTransport;

/** Why the lobby closed without a match. */
export type LobbyEnd = "cancel" | "error" | "fallback";

export interface LobbyEnv {
  /** Monotonic milliseconds (performance.now). */
  now(): number;
  build: number;
  /** The nonce draw. */
  random(): number;
  practice: PracticeMode | null;
  /** An online duel: no role switch; its room's state (onlineInfo) shows. */
  online?: boolean;
  onlineInfo?: () => OnlineInfo | null;
  /** A link in this role; `offer` is the host's, whoever hosts (the loop's friend may). Rejects with an Error named "RelayError" or "OnlineError". */
  link(cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" }, offer: HostOffer): Promise<LobbyLink>;
  /** The menu's shownMap() and activeMutators() at the tap, the side the host plays, and the menu's nation (default Classique). */
  offer: { map: string; mutators: MutatorId[]; hostSide: Faction; nation?: NationOrClassic };
  /** Pair at once: a rematch (its role, and the host's map, mutators and side), or a relay seat. */
  rematch: DuelRematch | null;
  seat: BandRole | null;
  /** The match is agreed: build the feed and start it (throws: the lobby shows the error). */
  begin(session: Session, link: LobbyLink): void;
  /** Closed with no match (the session closed). */
  released(why: LobbyEnd): void;
}

/** The link's round trip. */
export interface LobbyMeter {
  rttMs: number | null;
}

export interface LobbyView {
  step: LobbyStep;
  role: BandRole | null;
  practice: PracticeMode | null;
  /** An online duel, and its room (null before there is one). */
  isOnline: boolean;
  online: OnlineInfo | null;
  rematch: boolean;
  /** Pairing in a role it can't switch (a rematch, a relay seat). */
  fixedRole: boolean;
  /**
   * The nation this phone plays (LOBBY_PROTO 2): what it offers when it hosts, what it asks for when it joins.
   * Classique: hosting, a Classique match; joining, the host's rival nation (or Classique under a Classique host).
   */
  nation: NationOrClassic;
  error: LobbyError | null;
  /** Nothing heard for 8 s: one phone Host, the other Join (with the switch). */
  switchRole: boolean;
  /** Nothing heard for 30 s. */
  tips: boolean;
  /** The friend was heard, and nothing since for QUIET_MS (pairing to GO). */
  quiet: boolean;
  meter: LobbyMeter | null;
  pairing: PairingState | null;
  /** Back to Host / Join is still possible (before GO). */
  canBack: boolean;
}

/** Nothing heard this long after the role was tapped: tips. */
export const TIPS_MS = 30_000;
/** A rematch with nothing heard this long falls back to the menu. */
export const REMATCH_FALLBACK_MS = 60_000;
/** A friend heard and then silent this long: "Your friend's phone has gone quiet". */
export const QUIET_MS = NOTHING_HEARD_MS;

const otherRole = (r: BandRole): BandRole => (r === "host" ? "guest" : "host");

/** The lobby's logic, DOM-free: call update() every frame, read state(), and send it the taps. */
export class LobbyMachine {
  private step: LobbyStep;
  private role: BandRole | null = null;
  private session: Session | null = null;
  private link: LobbyLink | null = null;
  /** Bumped by every role start and every close: a link that resolves for an older one is let go. */
  private gen = 0;
  private fatal: LobbyError | null = null;
  private released = false;
  /** Sessions saying the end (left) until they may close. */
  private ending: Session[] = [];
  /** Cancelled or failed: the audio goes once nothing is left to say. */
  private closing: LobbyEnd | null = null;
  private sessionAt = 0;
  /** The nation this phone plays (a rematch: the one it played). */
  private nation: NationOrClassic;

  constructor(private readonly env: LobbyEnv) {
    this.nation = env.rematch ? env.rematch.nation ?? "classique" : env.offer.nation ?? "classique";
    this.step = "choose";
    this.ready();
  }

  /** The lobby is finished with: the match started, or closed. */
  get done(): boolean {
    return this.step === "started" || this.released;
  }

  // --------------------------------------------------------------- taps ---

  host(): void {
    if (this.step === "choose") void this.begin("host");
  }

  join(): void {
    if (this.step === "choose") void this.begin("guest");
  }

  /** The 8 s hint's one-tap switch: the other role, at once. */
  switchRole(): void {
    if (this.step !== "pairing" || !this.role || this.state().fixedRole) return;
    const next = otherRole(this.role);
    this.dropSession();
    void this.begin(next);
  }

  /** Back to Host / Join (before GO). */
  back(): void {
    if (!this.state().canBack) return;
    this.dropSession();
    this.role = null;
    this.step = "choose";
  }

  /** "Pairing failed: tap to retry". The tips' and a rematch's clocks start again, as the pairing's hint does. */
  retry(): void {
    if (!this.session) return;
    this.session.retry();
    this.sessionAt = this.env.now();
  }

  pick(id: OpenerId): boolean {
    return this.session?.pick(id) ?? false;
  }

  /** The nation picked on the Host / Join step (not in a rematch, which keeps its own). */
  setNation(n: NationOrClassic): void {
    if (this.step === "choose" && !this.env.rematch) this.nation = n;
  }

  /** Cancel, or Close on an error: say the end to a friend that may have started, then close. */
  cancel(): void {
    if (this.step === "started" || this.step === "closed") return;
    this.close("cancel");
  }

  // ------------------------------------------------------------ driving ---

  /** Every frame (and from a fallback timer): the session and the checks. */
  update(): void {
    if (this.released || this.step === "started") return;
    const now = this.env.now();
    // (the end on the air until the friend can have it)
    this.ending = this.ending.filter((s) => {
      s.pump();
      if (!s.status().closable) return true;
      s.close();
      return false;
    });
    if (this.closing) {
      if (!this.ending.length) this.release(this.closing);
      return;
    }
    if (this.step === "closed" || this.fatal) return;
    const s = this.session;
    if (!s) return;
    s.pump();
    const st = s.status();
    const link = this.link!;
    if (st.phase === "pairing") {
      const p = st.pairing;
      this.step = p.phase === "picking" ? "picking" : p.phase === "waiting" ? "waiting" : p.phase === "go" ? "go" : "pairing";
      if (this.env.rematch && !p.heard && now - this.sessionAt >= REMATCH_FALLBACK_MS) this.close("fallback");
    } else if (st.phase === "starting") {
      this.step = "loading";
      if (st.peerEnded) return;
      this.step = "started";
      try {
        this.env.begin(s, link);
      } catch (e) {
        console.error(e);
        this.step = "error";
        this.fatal = { kind: "other", message: e instanceof Error ? e.message : String(e) };
        this.close("error");
      }
    }
  }

  state(): LobbyView {
    const env = this.env;
    const now = env.now();
    const st = this.session && !this.released ? this.session.status() : null;
    const p = st?.pairing ?? null;
    const fixedRole = env.rematch !== null || env.seat !== null;
    const live = st !== null && this.step !== "closed";
    const link = st?.link;
    const error = this.fatal ?? (live ? this.pairingError(st.pairing, st.peerEnded) : null);
    const before = this.step === "pairing" || this.step === "picking" || this.step === "waiting";
    return {
      step: error && this.step !== "closed" ? "error" : this.step,
      role: this.role,
      practice: env.practice,
      isOnline: !!env.online,
      online: env.onlineInfo?.() ?? null,
      rematch: env.rematch !== null,
      fixedRole,
      nation: this.nation,
      error,
      switchRole: live && !fixedRole && !env.online && !!p?.hint && !p.heard,
      tips: live && p !== null && !p.heard && now - this.sessionAt >= TIPS_MS,
      quiet: live && !error && (before || this.step === "go") && p !== null && p.heard && p.sinceHeardMs >= QUIET_MS,
      meter: link ? { rttMs: st.rttMs } : null,
      pairing: p,
      canBack: !fixedRole && !error && before && p !== null && !p.go
    };
  }

  // ------------------------------------------------------------- inside ---

  private pairingError(p: PairingState, peerEnded: "left" | "desync" | null): LobbyError | null {
    if (p.error?.kind === "version") {
      const older = p.error.older;
      return { kind: "version", message: VERSION_MESSAGE, older };
    }
    if (p.phase === "failed") return { kind: "failed", message: p.error?.message ?? FAILED_MESSAGE };
    // (from this phone's GO on: the friend may have started on it, and the session says it has gone)
    if (peerEnded && (p.go || this.step === "loading")) return { kind: "left", message: tr("Ton ami est parti", "Your friend left") };
    return null;
  }

  /** Pair at once (a rematch, a relay seat), or offer Host / Join. */
  private ready(): void {
    this.step = "choose";
    const role = this.env.rematch?.role ?? this.env.seat;
    if (role) void this.begin(role);
  }

  /** The host's offer, whoever hosts. */
  private offer(): HostOffer {
    const r = this.env.rematch;
    if (r) return { map: r.mapId, mutators: r.mutators, hostSide: r.hostSide, nation: this.nation };
    return { map: this.env.offer.map, mutators: this.env.offer.mutators, hostSide: this.env.offer.hostSide, nation: this.nation };
  }

  private async begin(role: BandRole): Promise<void> {
    const env = this.env;
    const gen = ++this.gen;
    this.role = role;
    this.step = "connecting";
    // (the links' band plan is a leftover of the sound link's: always the high one)
    const cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" } = { plan: "high", tx: role, rx: role === "host" ? "guest" : "host" };
    let link: LobbyLink;
    try {
      link = await env.link(cfg, this.offer());
    } catch (e) {
      if (gen === this.gen) this.fail(e);
      return;
    }
    if (gen !== this.gen || this.released || this.step !== "connecting") {
      link.close();
      return;
    }
    this.link = link;
    this.sessionAt = env.now();
    this.session = new Session({ transport: link, role, build: env.build, random: env.random, ...(role === "host" ? { host: this.offer() } : { nation: this.nation }) });
    this.step = "pairing";
  }

  private fail(e: unknown): void {
    if (this.released) return;
    console.warn("duel:", e);
    if (e instanceof Error && e.name === "RelayError") this.fatal = { kind: "relay", message: e.message };
    else if (e instanceof Error && e.name === "OnlineError") this.fatal = { kind: "online", message: e.message };
    else this.fatal = { kind: "other", message: e instanceof Error ? e.message : String(e) };
    this.step = "error";
    this.dropSession();
    this.release("error");
  }

  /**
   * Let this role's session and link go (Back, a role switch, Cancel, an
   * error). Before GO there is nothing to tell and it closes at once; from GO
   * on it says the end (a stand-in, or the match's frames) until it may close.
   */
  private dropSession(): void {
    this.gen++;
    const s = this.session;
    const link = this.link;
    this.session = null;
    this.link = null;
    if (!s) return void link?.close();
    s.leave("left");
    if (s.status().closable) s.close();
    else this.ending.push(s);
  }

  private close(why: LobbyEnd): void {
    if (this.step !== "error") this.step = "closed";
    this.closing = why;
    this.dropSession();
    if (!this.ending.length) this.release(why);
  }

  private release(why: LobbyEnd): void {
    if (this.released) return;
    this.released = true;
    for (const s of this.ending) s.close();
    this.ending = [];
    this.session?.close();
    this.link?.close();
    this.env.released(why);
  }
}

// ------------------------------------------------------------ the sheet ---

export interface LobbyOptions {
  /** Where the sheet goes (the menu). */
  host: HTMLElement;
  /** The menu's shownMap() and activeMutators() at the tap: what a host offers. */
  shownMap: string;
  mutators: MutatorId[];
  /** main.ts: begin(false, () => duelSetup(feed.config), feed). */
  start: (feed: VersusFeed) => void;
  /** Closed with no match (Cancel, an error, the rematch's fallback): the menu's music comes back. */
  onClose: (why: LobbyEnd) => void;
  /** An online duel (src/versus/online.ts), and the room code an invite link brought (null: none). A rematch's is its own. */
  online?: { code: string | null } | null;
}

/** The lobby, after the Duel tap. */
export function showLobby(o: LobbyOptions): void {
  run(o, null);
}

/** The rematch's "Tap to reconnect": the lobby, pairing at once with the stored role. */
export function reconnect(o: LobbyOptions): void {
  run(o, readRematch(true));
}

/** The relay smoke's window into the duel (practice links only). */
export interface DuelProbe {
  readonly state: string;
  readonly tick: number;
  /** The input delay D the pairing agreed (null before the match). */
  readonly delay: number | null;
  trail(): number | null;
  /** The hash trail after every tick stepped from `from` on: [tick, trail] (VersusFeed.trails). */
  trails(from: number): [number, number][];
  hash(): string | null;
  /** An online duel's room (null: none, or not online). */
  online(): OnlineInfo | null;
  readonly result: { end: string; winner: Faction | "draw" | null; resigned: Faction | null; tick: number | null; endCheck: string; desync: boolean } | null;
}

declare global {
  interface Window {
    __duel?: DuelProbe;
    __duelOut?: (base64: string, nbits: number) => void;
    __duelIn?: (base64: string, nbits: number) => void;
  }
}

class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayError";
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** The 30 s tips: the friend's room, or a practice link's other page (the relay) or the page itself. */
export function tipsText(v: Pick<LobbyView, "practice"> & Partial<Pick<LobbyView, "online">>): string {
  if (v.online)
    return v.online.role === "host"
      ? tr(`Toujours personne ? Vérifie que ton ami a saisi le code ${v.online.code} (ou ouvert ton lien), et qu'il est en ligne.`, `Still nobody? Check that your friend has entered the code ${v.online.code} (or opened your link), and is online.`)
      : tr("Toujours rien ? Ton ami a peut-être fermé son salon : demande-lui le code affiché sur son écran.", "Still nothing? Your friend may have closed their lobby: ask them for the code on their screen.");
  if (v.practice === "relay") return tr("Toujours rien ? Vérifie que l'autre page est dans le salon et que le relais relie les deux.", "Still nothing? Check that the other page is in the lobby and that the relay links the two.");
  return tr("Toujours rien ? Recharge la page et touche Duel à nouveau.", "Still nothing? Reload the page and tap Duel again.");
}
const QUIET_ONLINE = tr("Ton ami ne répond plus. Attends-le un instant, ou touche Annuler s'il est parti.", "Your friend isn't responding. Give them a moment, or tap Cancel if they've left.");
/** Under the online sheet's title. */
const ONLINE_NOTE = tr("Par Internet, où que soit ton ami : l'un crée un salon, l'autre entre son code (ou ouvre le lien partagé).", "Over the Internet, wherever your friend is: one creates a lobby, the other enters its code (or opens the shared link).");
const iconUrl = (kind: string, side: Faction): string => `assets/icons/${side === "red" ? "red/" : ""}${kind}.webp`;

/** The map as the paired view names it: a built-in map's name, a generated one's name and code. */
function mapLine(mapId: string, mutators: readonly MutatorId[]): string {
  const def = mapById(mapId);
  const name = def.random ? `${esc(def.name)} <span class="duel-code">#${esc(def.random.code)}</span>` : esc(def.name);
  const muts = mutators.length
    ? mutators.map((id) => `<span class="duel-mut" title="${esc(MUTATORS[id].desc)}">${MUTATORS[id].icon} ${esc(MUTATORS[id].name)}</span>`).join("")
    : `<span class="duel-mut none">${tr("Aucun mutateur", "No mutators")}</span>`;
  return `<p class="duel-map"><b>🗺 ${name}</b></p><p class="duel-muts">${muts}</p>`;
}

/** The nations as the lobby names them, with a one-line identity (PANACHE-CONCEPTION.md §1.1). */
const NATION_LABEL: Record<NationOrClassic, { name: string; line: string }> = {
  classique: { name: tr("Classique", "Classic"), line: tr("Mêmes unités", "Same units") },
  republique: { name: tr("République", "Republic"), line: tr("Rapide, aérienne, électrique", "Fast, aerial, electric") },
  empire: { name: tr("Empire", "Empire"), line: tr("Vapeur, acier, artillerie", "Steam, steel, artillery") }
};

/** A nation's crest (public/assets/ui/crest-*.webp); Classique has a scale instead. */
export function crestHtml(n: NationOrClassic, cls = "duel-crest"): string {
  return n === "classique"
    ? `<span class="${cls} classique" aria-hidden="true">⚖</span>`
    : `<img class="${cls}" src="assets/ui/crest-${n}.webp" alt="" draggable="false"/>`;
}

/**
 * The Host / Join step's nation picker (LOBBY_PROTO 2): what this phone offers
 * when it hosts, what it asks for when it joins. Not in a rematch, which keeps
 * the nations it played.
 */
export function nationPicker(v: Pick<LobbyView, "nation" | "rematch" | "isOnline">): string {
  if (v.rematch) return "";
  const btn = (n: NationOrClassic) =>
    `<button class="duel-nat nat-${n}${v.nation === n ? " on" : ""}" data-act="nation" data-v="${n}" aria-pressed="${v.nation === n}">${crestHtml(n)}<b>${NATION_LABEL[n].name}</b><small>${NATION_LABEL[n].line}</small></button>`;
  return `<div class="duel-nation">
      <p class="duel-lbl">${tr("Ta nation", "Your nation")}</p>
      <div class="duel-nats">${btn("republique")}${btn("empire")}${btn("classique")}</div>
      <p class="duel-natnote">${tr(`L'hôte décide : en Classique, les deux camps jouent Classique. Sinon chacun joue sa nation${v.nation === "classique" ? " (toi, celle qui affronte l'hôte)" : ""}.`, `The host decides: in Classic, both sides play Classic. Otherwise each plays their own nation${v.nation === "classique" ? " (you, the one facing the host)" : ""}.`)}</p>
    </div>`;
}

/** Before pairing: the nation this phone brings (a host's offer, a guest's ask). */
export function myNationLine(v: Pick<LobbyView, "nation" | "role">): string {
  const n = v.nation;
  const what =
    v.role === "host"
      ? n === "classique"
        ? tr("Partie Classique : les mêmes unités des deux côtés", "Classic match: the same units on both sides")
        : tr(`Tu joues la <b>${NATION_LABEL[n].name}</b> · ton ami choisit la sienne`, `You play the <b>${NATION_LABEL[n].name}</b> · your friend picks theirs`)
      : n === "classique"
        ? tr("Tu joueras la nation qui affronte celle de l'hôte", "You'll play the nation facing the host's")
        : tr(`Tu demandes la <b>${NATION_LABEL[n].name}</b> (si l'hôte joue une nation)`, `You ask for the <b>${NATION_LABEL[n].name}</b> (if the host plays a nation)`);
  return `<p class="duel-nations">${crestHtml(n)}<span>${what}</span></p>`;
}

/** The paired view's nations line: this phone's and the friend's, under the config agreed (null: Classique). */
export function nationsLine(config: DuelConfig | null, side: Faction | null): string {
  const n = config ? configNations(config) : undefined;
  if (!config || !side) return "";
  if (!n) return `<p class="duel-nations">${crestHtml("classique")}<span>${tr("Classique : les mêmes unités des deux côtés", "Classic: the same units on both sides")}</span></p>`;
  const mine = n[side]!;
  const theirs = n[side === "blue" ? "red" : "blue"]!;
  return `<p class="duel-nations"><span class="dn-side">${crestHtml(mine)}<span>${tr("Toi", "You")}${tr(" :", ":")} <b>${NATION_LABEL[mine].name}</b></span></span><span class="dn-vs">${tr("contre", "vs")}</span><span class="dn-side">${crestHtml(theirs)}<span>${tr("Ton ami", "Your friend")}${tr(" :", ":")} <b>${NATION_LABEL[theirs].name}</b></span></span></p>`;
}

/**
 * What an opener gives, as the single-player picker's pills say it
 * (src/ui/openers.ts), from the same data (OPENERS, and the building and unit
 * names): "Fab Plant · 3 Stingers · 2 Harvesters · −100 scrap".
 */
export function openerGives(id: OpenerId, words: Words = CLASSIC): string {
  const o = OPENERS[id];
  const n = words.nation;
  const parts = [displayName(o.building, n)];
  const counts = new Map<UnitKind, number>();
  for (const k of o.units) counts.set(words.kindFor(k), (counts.get(words.kindFor(k)) ?? 0) + 1);
  for (const [k, c] of counts) parts.push(`${c} ${c > 1 ? pluralName(k, n) : UNITS[k].name}`);
  const worker = words.kindFor("harvester");
  parts.push(`${o.harvesters} ${o.harvesters > 1 ? pluralName(worker, n) : UNITS[worker].name}`);
  if (o.scrap > 0) parts.push(tr(`+${o.scrap} charbon`, `+${o.scrap} coal`));
  if (o.scrap < 0) parts.push(tr(`−${-o.scrap} charbon`, `−${-o.scrap} coal`));
  return parts.join(" · ");
}

const CLASSIC: Words = { nation: "classique", kindFor: (k) => k };
const CLASSIC_ROLE = new Map<UnitKind, Role>();
for (const [role, kind] of Object.entries(ROLES.classique) as [Role, UnitKind][]) if (!CLASSIC_ROLE.has(kind)) CLASSIC_ROLE.set(kind, role);

/**
 * How the opener cards name things for a side's nation (sim/nations.ts
 * nationKind, without a world: the kind itself in Classique or when the
 * nation fields it, else the nation's kind for its role), and the friend's
 * workers in "leurs Fardiers".
 */
export function lobbyWords(mine: NationOrClassic, theirs: NationOrClassic = mine): Words {
  const kindFor = (n: NationOrClassic) => (k: UnitKind): UnitKind => {
    if (n === "classique" || inRoster(n, k)) return k;
    const role = CLASSIC_ROLE.get(k);
    return role ? ROLES[n][role] : k;
  };
  return {
    nation: mine,
    kindFor: kindFor(mine),
    ...(theirs !== mine ? { enemyWorker: { nation: theirs, kind: kindFor(theirs)("harvester") } } : {})
  };
}

function openerCard(id: OpenerId, side: Faction, picked: boolean, words: Words = CLASSIC): string {
  const o = OPENERS[id];
  const unit = words.kindFor(o.units[0] ?? "harvester");
  const n = o.units.length || o.harvesters;
  return `<button class="op-card op-${id}${picked ? " picked" : ""}" data-act="pick" data-id="${id}">
      <div class="op-art"><img class="op-b" src="${iconUrl(o.building, side)}" alt="" draggable="false"/><img class="op-u" src="${iconUrl(portraitKind(unit), side)}" alt="" draggable="false"/><span class="op-n">×${n}</span></div>
      <div class="op-text"><b class="op-name">${esc(o.name)}</b><span class="op-tag">${esc(nationText(o.tagline, id, words))}</span><span class="op-gives">${openerGives(id, words)
        .split(" · ")
        .map((part) => `<span>${esc(part)}</span>`)
        .join(" · ")}</span></div>
    </button>`;
}

/**
 * The meter's last line: the round trip, except on the loop, whose friend
 * holds the lobby's packets to force &delay (loop-peer.ts), so its round trip
 * can read seconds and says nothing of the match: it names the input delay
 * the pairing agreed instead.
 */
export function rttLine(v: Pick<LobbyView, "practice" | "pairing" | "meter">): string {
  if (v.practice === "loop") {
    const d = v.pairing?.config?.delay;
    return d === undefined ? tr("Liaison d'entraînement", "Practice link") : tr(`Liaison d'entraînement · délai d'entrée ${d * 100} ms`, `Practice link · input delay ${d * 100} ms`);
  }
  const rtt = v.meter?.rttMs ?? null;
  return rtt === null ? tr("Aller-retour : mesure…", "Round trip: measuring…") : tr(`Aller-retour ${Math.round(rtt)} ms`, `Round trip ${Math.round(rtt)} ms`);
}

/** The online duel's line: the relay, the friend in the room, the round trip. */
function onlineHtml(v: LobbyView): string {
  return v.isOnline ? `<p class="duel-net" data-m="net"></p>` : "";
}

/** That line's words. */
export function onlineLine(v: Pick<LobbyView, "online" | "meter" | "practice" | "pairing">): string {
  const o = v.online;
  if (!o) return tr("🌐 Connexion au relais…", "🌐 Connecting to the relay…");
  if (o.state === "closed") return tr("🌐 Hors ligne", "🌐 Offline");
  if (o.state !== "open") return tr("🌐 Relais : reconnexion…", "🌐 Relay: reconnecting…");
  const friend = o.peer ? tr("ton ami est là", "your friend is here") : o.peerGoneMs !== null ? tr("ton ami s'est déconnecté", "your friend disconnected") : tr("ton ami n'est pas encore là", "your friend isn't here yet");
  const rtt = v.meter?.rttMs ?? null;
  return tr(`🌐 Salon ${o.code} · ${friend}${o.peer && rtt !== null ? ` · aller-retour ${Math.round(rtt)} ms` : ""}`, `🌐 Lobby ${o.code} · ${friend}${o.peer && rtt !== null ? ` · round trip ${Math.round(rtt)} ms` : ""}`);
}

/** A practice link's line: the round trip (on the loop, the input delay). */
function practiceHtml(v: LobbyView): string {
  return v.practice && v.meter ? `<p class="duel-net" data-m="rtt"></p>` : "";
}

/** The link lines' words, every frame. */
function fillMeter(root: HTMLElement, v: LobbyView): void {
  const set = (k: string, text: string) => {
    const el = root.querySelector<HTMLElement>(`[data-m="${k}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  };
  set("net", onlineLine(v));
  set("rtt", rttLine(v));
}

/** What the sheet shows for a state: rebuilt only when this changes. */
function layoutKey(v: LobbyView): string {
  const p = v.pairing;
  return [
    v.step, v.role, v.error?.kind, v.switchRole, v.tips, v.quiet, v.canBack, !!v.meter,
    p?.phase, p?.pick, p?.picked, p?.offered.join(","), p?.config?.mapId, p?.side, v.online?.code, v.online?.peer, v.online?.state === "open",
    v.nation, p?.config?.nations?.host, p?.config?.nations?.guest
  ].join("|");
}

/** What the online sheet adds: the code an invite link brought, and a bad code typed. */
export interface OnlineSheet {
  linked: string | null;
  badCode: boolean;
  /** What the code box held when the sheet was last rebuilt (a nation tap rebuilds it): kept, not retyped. */
  typed?: string;
}

/** The online duel's steps where they differ from a practice link's: choosing, connecting, waiting in the room. */
function onlineBody(v: LobbyView, sheet: OnlineSheet): { body: string; actions: string } | null {
  const cancel = `<button class="cta alt" data-act="cancel">${tr("Annuler", "Cancel")}</button>`;
  const back = v.canBack ? `<button class="cta alt" data-act="back">${tr("Retour", "Back")}</button>` : "";
  const o = v.online;
  switch (v.step) {
    case "choose": {
      const linked = sheet.linked;
      const bad = sheet.badCode ? `<p class="duel-err">${tr("Un code, ce sont 4 lettres.", "A code is 4 letters.")}</p>` : "";
      const join = `<div class="duel-join">
          <p class="duel-lbl">${linked ? tr("Ton ami t'invite", "Your friend invites you") : tr("Rejoindre avec un code", "Join with a code")}</p>
          <div class="duel-joinrow"><input class="duel-codein" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="ABCD" aria-label="${tr("Code du salon", "Lobby code")}" value="${esc(sheet.typed ?? linked ?? "")}"/><button class="cta" data-act="join">${tr("Rejoindre", "Join")}</button></div>
          ${bad}
        </div>`;
      const create = `<div class="duel-roles"><button class="duel-role" data-act="host"><b>${tr("🏛 Créer un salon", "🏛 Create a lobby")}</b><small>${tr("Ta carte et tes mutateurs · un code à partager", "Your map and your mutators · a code to share")}</small></button></div>`;
      return {
        body: `<p class="sh-sub duel-place">${ONLINE_NOTE}</p>${nationPicker(v)}${linked ? join + `<p class="duel-or">${tr("ou", "or")}</p>` + create : create + `<p class="duel-or">${tr("ou", "or")}</p>` + join}`,
        actions: cancel
      };
    }
    case "connecting":
      return { body: `<p class="duel-status">${v.role === "host" ? tr("Création du salon…", "Creating the lobby…") : tr("Connexion au salon…", "Joining the lobby…")}</p>`, actions: cancel };
    case "pairing": {
      const quiet = v.quiet ? `<p class="duel-hint">${QUIET_ONLINE}</p>` : "";
      const tips = v.tips ? `<p class="duel-hint">${tipsText(v)}</p>` : "";
      if (v.role === "host") {
        const status = v.pairing?.phase === "linking" || o?.peer ? tr("Ton ami est là. Appairage…", "Your friend is here. Pairing…") : v.rematch ? tr("En attente que ton ami touche Revanche…", "Waiting for your friend to tap Rematch…") : tr("En attente de ton ami…", "Waiting for your friend…");
        return {
          body: `<p class="duel-lbl duel-codelbl">${tr("Code du salon", "Lobby code")}</p>
            <p class="duel-bigcode" data-code="${esc(o?.code ?? "")}">${esc(o?.code ?? "····")}</p>
            <div class="duel-share"><button class="cta" data-act="share">${tr("🔗 Partager le lien", "🔗 Share the link")}</button><button class="cta alt" data-act="copy">${tr("Copier", "Copy")}</button></div>
            <p class="duel-copied" hidden>${tr("Lien copié", "Link copied")}</p>
            <p class="duel-status">${status}</p>${myNationLine(v)}${quiet}${onlineHtml(v)}${tips}`,
          actions: back + cancel
        };
      }
      const status = v.pairing?.phase === "linking" || o?.peer ? tr("Ton ami est là. Appairage…", "Your friend is here. Pairing…") : v.rematch ? tr("En attente que ton ami touche Revanche…", "Waiting for your friend to tap Rematch…") : tr("En attente de l'hôte…", "Waiting for the host…");
      return { body: `<p class="duel-lbl duel-codelbl">${tr("Salon", "Lobby")}</p><p class="duel-bigcode small">${esc(o?.code ?? "")}</p><p class="duel-status">${status}</p>${myNationLine(v)}${quiet}${onlineHtml(v)}${tips}`, actions: back + cancel };
    }
    default:
      return null;
  }
}

function bodyHtml(v: LobbyView, sheet: OnlineSheet = { linked: null, badCode: false }): { body: string; actions: string } {
  if (v.isOnline && v.step !== "error") {
    const own = onlineBody(v, sheet);
    if (own) return own;
  }
  const cancel = `<button class="cta alt" data-act="cancel">${tr("Annuler", "Cancel")}</button>`;
  const back = v.canBack ? `<button class="cta alt" data-act="back">${tr("Retour", "Back")}</button>` : "";
  const link = v.isOnline ? onlineHtml(v) : practiceHtml(v);
  const quiet = v.quiet ? `<p class="duel-hint">${QUIET_ONLINE}</p>` : "";
  const p = v.pairing;
  switch (v.step) {
    case "choose":
      // (a practice link: the page itself or the relay's other page plays the friend)
      return {
        body: `<div class="duel-roles">
            <button class="duel-role" data-act="host"><b>${tr("📡 Héberger", "📡 Host")}</b><small>${tr("Ta carte et tes mutateurs", "Your map and your mutators")}</small></button>
            <button class="duel-role" data-act="join"><b>${tr("📲 Rejoindre", "📲 Join")}</b><small>${tr("Ton ami héberge", "Your friend hosts")}</small></button>
          </div>
          ${nationPicker(v)}`,
        actions: cancel
      };
    case "connecting":
      return { body: `<p class="duel-status">${tr("Connexion…", "Connecting…")}</p>`, actions: cancel };
    case "pairing": {
      const heard = p?.phase === "linking";
      const status = heard
        ? tr("Ton ami est là. Appairage…", "Your friend is here. Pairing…")
        : v.rematch
          ? tr("En attente que ton ami touche Revanche…", "Waiting for your friend to tap Rematch…")
          : v.role === "host"
            ? tr("Tu héberges. En attente que ton ami touche Rejoindre…", "You're hosting. Waiting for your friend to tap Join…")
            : tr("En attente de l'hôte…", "Waiting for the host…");
      const hint = v.switchRole
        ? `<div class="duel-hint"><p>${NOTHING_HEARD_MESSAGE}.</p><button class="cta alt" data-act="switch">${tr(`Passer à ${v.role === "host" ? "Rejoindre" : "Héberger"}`, `Switch to ${v.role === "host" ? "Join" : "Host"}`)}</button></div>`
        : "";
      const tips = v.tips ? `<p class="duel-hint">${tipsText(v)}</p>` : "";
      return {
        body: `<p class="duel-status">${status}</p>${v.rematch ? "" : myNationLine(v)}${quiet}${link}${hint}${tips}`,
        actions: back + cancel
      };
    }
    case "picking":
    case "waiting": {
      const side = p?.side ?? "blue";
      const offered = p?.offered ?? [];
      const picked = v.step === "waiting";
      const nations = p?.config ? configNations(p.config) : undefined;
      const words = nations ? lobbyWords(nations[side]!, nations[side === "blue" ? "red" : "blue"]!) : CLASSIC;
      const cards = offered.length
        ? `<div class="duel-cards${picked ? " chosen" : ""}">${offered.map((id) => openerCard(id, side, picked && p?.pick === id, words)).join("")}</div>`
        : `<p class="duel-status">${tr("Aucune ouverture n'est permise avec ces règles.", "No opening is allowed under these rules.")}</p>`;
      const head = picked ? `<p class="duel-status">${tr("En attente du choix de ton ami…", "Waiting for your friend's choice…")}</p>` : `<h3>${tr("Choisis ton ouverture", "Choose your opening")} <small data-m="pickleft"></small></h3>`;
      return {
        body: `<p class="duel-paired">${tr("✓ Appairés · tu joues", "✓ Paired · you play")} <b class="duel-side ${side}">${side === "red" ? tr("rouge", "red") : tr("bleu", "blue")}</b></p>${p?.config ? mapLine(p.config.mapId, p.config.mutators) : ""}${nationsLine(p?.config ?? null, p?.side ?? null)}${head}${quiet}${cards}${link}`,
        actions: back + cancel
      };
    }
    case "go":
      return { body: `<p class="duel-go">${tr("GO !", "GO!")}</p><p class="duel-status">${tr("En attente de ton ami…", "Waiting for your friend…")}</p>${quiet}${link}`, actions: cancel };
    case "loading":
      return { body: `<p class="duel-go">${tr("GO !", "GO!")}</p><p class="duel-status">${tr("Lancement de la partie…", "Starting the match…")}</p>${link}`, actions: cancel };
    case "error":
      return errorHtml(v);
    default:
      return { body: "", actions: "" };
  }
}

function errorHtml(v: LobbyView): { body: string; actions: string } {
  const e = v.error;
  const close = `<button class="cta alt" data-act="cancel">${tr("Fermer", "Close")}</button>`;
  if (!e) return { body: "", actions: close };
  const reload = `<button class="cta" data-act="reload">${tr("Recharger", "Reload")}</button>`;
  switch (e.kind) {
    case "failed":
      return { body: `<button class="cta big duel-tap" data-act="retry">${esc(e.message)}</button>`, actions: `<button class="cta alt" data-act="cancel">${tr("Annuler", "Cancel")}</button>` };
    case "version": {
      const who = e.older === "this" ? tr("Cet appareil a l'ancienne version.", "This device has the older version.") : e.older === "friend" ? tr("L'appareil de ton ami a l'ancienne version.", "Your friend's device has the older version.") : "";
      return { body: `<p class="duel-err">${esc(e.message)}</p>${who ? `<p class="sh-note">${who}</p>` : ""}`, actions: close + reload };
    }
    case "relay":
      return { body: `<p class="duel-err">${esc(e.message)}</p><p class="sh-note">The page has no window.__duelOut: connect it with the relay harness.</p>`, actions: close };
    case "left":
      return { body: `<p class="duel-err">${esc(e.message)}.</p>`, actions: close };
    case "online":
      return { body: `<p class="duel-err">${esc(e.message)}</p>`, actions: close };
    default:
      return { body: `<p class="duel-err">${tr("Un problème est survenu", "Something went wrong")}${tr(" :", ":")} ${esc(e.message)}</p>`, actions: close };
  }
}

/** The sheet: the machine, its env in the browser, the frame loop, the taps. */
function run(o: LobbyOptions, rematch: DuelRematch | null): void {
  const params = parseDuelParams(location.search);
  // (an online duel, from its button or its rematch, is never a practice link, whatever the URL says;
  // anything else that isn't one is an online duel, the menu's only kind)
  const practice = rematch?.online || o.online || params.mode === "none" ? null : params.mode;
  const online = practice ? null : rematch?.online ?? { code: o.online?.code ? normCode(o.online.code) : null, key: null };
  const build = duelBuild();
  let loop: LoopLink | null = null;
  let relay: RelayTransport | null = null;
  let net: OnlineLink | null = null;
  /** The seat's key (a rematch keeps its own), and the code the guest joins (typed, or the rematch's). */
  const seatKey = online?.key ?? drawKey(cryptoRandom);
  let joinCode: string | null = rematch?.online?.code ?? null;
  const sheet: OnlineSheet = { linked: rematch ? null : online?.code ?? null, badCode: false };
  let feed: VersusFeed | null = null;
  let machine: LobbyMachine | null = null;
  let timer = 0;
  let raf = 0;
  let stopped = false;

  o.host.querySelector(".duel-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap duel-wrap";
  wrap.innerHTML = `<div class="sheet duelsheet" role="dialog" aria-label="${tr("Défier un ami", "Challenge a friend")}">
      <h2>🌐 ${rematch ? tr("Revanche", "Rematch") : tr("Défier un ami", "Challenge a friend")}</h2>
      ${practice ? `<p class="duel-practice">${tr(`Liaison d'entraînement : ${practice === "loop" ? "un ami dans la page" : "le relais"}`, `Practice link: ${practice === "loop" ? "a friend in the page" : "the relay"}`)}</p>` : ""}
      <div class="duel-body"></div>
      <div class="sh-actions duel-actions"></div>
    </div>`;
  o.host.appendChild(wrap);
  const body = wrap.querySelector<HTMLElement>(".duel-body")!;
  const actions = wrap.querySelector<HTMLElement>(".duel-actions")!;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    cancelAnimationFrame(raf);
  };
  const closeSheet = () => {
    stop();
    wrap.remove();
  };
  const dropPractice = () => {
    loop?.close();
    relay?.close();
    net?.close();
    loop = null;
    relay = null;
    net = null;
  };

  const env: LobbyEnv = {
    now: () => performance.now(),
    build,
    random: cryptoRandom,
    practice,
    online: online !== null,
    onlineInfo: () => net?.info() ?? null,
    rematch,
    seat: practice === "relay" ? params.seat : null,
    offer: { map: o.shownMap, mutators: o.mutators, hostSide: practice ? params.side : "blue", nation: gameMode.nation },
    link: async (cfg, offer) => {
      if (online) {
        dropPractice();
        const base = relayBase(location.search);
        const env = browserOnlineEnv();
        let l: OnlineLink;
        if (cfg.tx === "host") l = await hostRoom({ base, key: seatKey, code: rematch?.online?.code, env, random: cryptoRandom });
        else {
          const code = joinCode;
          if (!code) throw new OnlineError("unknown");
          l = await joinRoom({ base, key: seatKey, code, env });
        }
        net = l;
        return l;
      }
      if (practice === "loop") {
        dropPractice();
        const friendOffer: HostOffer = rematch ? offer : { ...offer, hostSide: cfg.tx === "host" ? params.side : params.side === "blue" ? "red" : "blue" };
        // (the in-page friend hosting offers the nation facing this page's: a République page meets an Empire)
        if (cfg.tx === "guest" && offer.nation && offer.nation !== "classique") friendOffer.nation = rivalOf(offer.nation as Nation);
        loop = new LoopLink({ params: params.loop, role: cfg.tx, offer: friendOffer, build, seed: (cryptoRandom() * 4294967296) >>> 0 });
        return loop.page;
      }
      dropPractice();
      const r = new RelayTransport({ role: cfg.tx, win: window });
      if (!r.connected()) {
        r.close();
        throw new RelayError("Relay not connected");
      }
      relay = r;
      return r;
    },
    begin: (session) => {
      const n = net;
      const onFrame = loop ? () => loop?.pump() : relay ? () => relay?.tick() : n ? () => n.tick() : undefined;
      let exited = false;
      const f = new VersusFeed({
        session,
        practice: practice !== null,
        online: n ? { info: () => n.info(), code: n.code, key: n.key } : null,
        onExit: () => {
          if (exited) return;
          exited = true;
          dropPractice();
        },
        ...(onFrame ? { onFrame } : {})
      });
      feed = f;
      closeSheet();
      o.start(f);
      if (f.world.mapId !== gameMode.mapId) console.error(`duel: the feed's map ${f.world.mapId} isn't the game's ${gameMode.mapId}`);
    },
    released: (why) => {
      dropPractice();
      o.onClose(why);
    }
  };

  exposeProbe(() => machine, () => feed, () => net);
  const m = (machine = new LobbyMachine(env));

  let key = "";
  const render = () => {
    const v = m.state();
    if (v.step === "closed" || v.step === "started") return;
    const k = layoutKey(v);
    if (k !== key) {
      key = k;
      const typed = body.querySelector<HTMLInputElement>(".duel-codein")?.value;
      if (typed !== undefined) sheet.typed = typed;
      const html = bodyHtml(v, sheet);
      body.innerHTML = html.body;
      actions.innerHTML = html.actions;
    }
    fillMeter(body, v);
    const left = body.querySelector<HTMLElement>(`[data-m="pickleft"]`);
    const ms = v.pairing?.pickLeftMs;
    if (left) left.textContent = ms === null || ms === undefined ? "" : `${Math.ceil(ms / 1000)} s`;
  };
  const frame = () => {
    if (stopped) return;
    loop?.pump();
    m.update();
    const v = m.state();
    if (m.done) {
      // (an error stays up until it's closed; otherwise the sheet goes)
      if (v.step === "error") render();
      else closeSheet();
      stop();
      return;
    }
    // (cancelled: the sheet is gone, and the link says the end until the session may close)
    if (v.step === "closed") return void wrap.remove();
    render();
  };
  const loopFrame = () => {
    frame();
    if (!stopped) raf = requestAnimationFrame(loopFrame);
  };
  raf = requestAnimationFrame(loopFrame);
  // (a hidden page gets no frames, and the link must go on)
  timer = window.setInterval(frame, 50);

  /** The online guest's Join: the typed code (4 letters), else say so. */
  const joinTyped = () => {
    const code = normCode(body.querySelector<HTMLInputElement>(".duel-codein")?.value ?? "");
    if (!code) {
      sheet.badCode = true;
      key = "";
      return render();
    }
    sheet.badCode = false;
    sheet.linked = code;
    joinCode = code;
    m.join();
  };
  /** The invite link to the host's room, shared (Web Share) or copied. */
  const invite = async (share: boolean) => {
    const code = net?.code;
    if (!code) return;
    const url = inviteUrl(shareBase(), code, LANG);
    const copied = body.querySelector<HTMLElement>(".duel-copied");
    if (share && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: tr("Panache : un duel ?", "Panache: a duel?"), text: tr(`Viens m'affronter dans Panache ! Code du salon : ${code}`, `Come and face me in Panache! Lobby code: ${code}`), url });
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      /* no clipboard: show it */
    }
    if (copied) {
      copied.hidden = false;
      copied.textContent = ok ? tr("Lien copié : envoie-le à ton ami", "Link copied: send it to your friend") : url;
    }
  };
  if (online) {
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).classList?.contains("duel-codein")) joinTyped();
    });
    wrap.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.classList?.contains("duel-codein")) t.value = t.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    });
  }

  wrap.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || !wrap.contains(el)) return;
    switch (el.dataset.act) {
      case "host":
        return m.host();
      case "join":
        return online ? joinTyped() : m.join();
      case "share":
        return void invite(true);
      case "copy":
        return void invite(false);
      case "switch":
        return m.switchRole();
      case "back":
        return m.back();
      case "retry":
        return m.retry();
      case "nation": {
        const n = el.dataset.v;
        if (n === "classique" || n === "republique" || n === "empire") {
          m.setNation(n);
          sfx.play("click", 0.5);
        }
        return render();
      }
      case "pick":
        if (el.dataset.id && m.pick(el.dataset.id as OpenerId)) sfx.play("click", 0.5);
        return;
      case "reload":
        return fullscreen.reload();
      case "cancel":
        m.cancel();
        // (the frame loop goes on until the session may close, if it must say the end first)
        if (m.done) closeSheet();
        else wrap.remove();
        return;
    }
  });
}

/** window.__duel for the relay and loop harnesses. */
function exposeProbe(machine: () => LobbyMachine | null, feed: () => VersusFeed | null, net: () => OnlineLink | null = () => null): void {
  const probe: DuelProbe = {
    get state() {
      const f = feed();
      return f ? f.session.phase : machine()?.state().step ?? "choose";
    },
    get tick() {
      return feed()?.world.tick ?? -1;
    },
    get delay() {
      return feed()?.result.delay ?? null;
    },
    trail: () => feed()?.session.lockstep?.trail() ?? null,
    online: () => net()?.info() ?? null,
    trails: (from) => feed()?.trails(from) ?? [],
    hash: () => {
      const f = feed();
      return f ? worldHash(f.world) : null;
    },
    get result() {
      const ls = feed()?.session.lockstep;
      if (!ls) return null;
      const st = ls.status();
      return {
        end: st.end,
        winner: st.decided?.winner ?? null,
        resigned: st.decided?.resigned ?? null,
        tick: st.decided?.tick ?? null,
        endCheck: st.endCheck,
        desync: st.desync
      };
    }
  };
  window.__duel = probe;
}
