/**
 * The online duel's link ("Défier un ami (en ligne)"): the duel's
 * whole stack (pairing, lockstep, session, feed) over a WebSocket to a tiny
 * relay (relay/, a Cloudflare Worker with one Durable Object per room) in
 * place of the air. Nothing above the LinkTransport seam changes: the frames
 * a phone would play are the packets it sends here.
 *
 *   OnlineLink = RelayTransport (packets, slots, the session CRC, as ?duel=relay)
 *              + a WebSocket to wss://…/salon/ABCD?role=hote|invite&cle=…
 *
 * The packet clock is RelayTransport's: one packet every 100 ms (fast) or
 * 200 ms (robust), repeated whether or not it changed, so a lost or late
 * message costs nothing a later one doesn't fix; the pairing measures the
 * round trip through the relay and picks the input delay D from it (3–8
 * ticks, 300–800 ms: DUEL.md "Config"), so a far friend gets more
 * delay and a near one less.
 *
 * Wire: one text message per packet, `p<nbits> <base64>` (the base64 is
 * RelayTransport's: the frame, its CRC-16, the mode byte). The relay sends
 * JSON of its own (`{"t":"salut",…}`, `{"t":"pair","on":…}`), answers
 * "ping" with "pong", and forwards nothing that doesn't start with "p".
 *
 * Rooms: the host draws a code (4 letters, no I or O) and creates the room
 * (`nouveau=1`; a code in use closes 4010 and it draws another); the guest
 * joins by code (4004: no such room, 4009: full). Each seat is held by a key
 * this page draws and keeps in sessionStorage with the code, so a dropped
 * connection, a page that went to the background, or the Rematch's reload
 * takes its seat back within the relay's minute (RECONNEXION_MS).
 *
 * Reconnect: any close the relay didn't mean as final reconnects, after
 * 0.25, 0.5, 1, 1, then every 2 s, at once when the page comes back to the
 * foreground or the network comes back; a socket that has heard nothing
 * (not even its ping's pong) for SILENT_MS is taken as dead and replaced.
 * While it is down the packets go nowhere and the lockstep stalls, as it
 * would on a lost sound link; once it is back they flow again and the match
 * goes on. The relay tells each phone when the other comes and goes, which
 * the lobby and the stall pill show.
 *
 * Engine-free: the socket, timers, clock and storage come in through
 * OnlineEnv, so tests run two links through an in-memory relay.
 */
import type { BandRole, LinkPacket, LinkStats, LinkTransport, ModemMode, OutFrame } from "../link/transport";
import { RelayTransport, type RelayTimers, type RelayWindow } from "./relay-transport";
import { tr } from "../lang";

/** The relay the published game uses (relay/README.md). `?relais=` overrides it (a `wrangler dev` on localhost). */
export const RELAY_URL = "wss://panache-relais.meffysto.workers.dev";

/** Room codes: four of these (no I or O, misread as 1 and 0). The relay's ALPHABET. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[A-Z]{4}$/;

/** The relay's close codes (relay/src/salon.ts FERME). */
export const CLOSE = { replaced: 4000, origin: 4003, unknown: 4004, abuse: 4008, full: 4009, taken: 4010, expired: 4011 } as const;

/** Reconnect delays (ms), the last repeating. */
export const RETRY_MS = [250, 500, 1000, 1000, 2000];
/** The ping's period, and the silence after which an open socket is taken as dead (ms). */
export const PING_MS = 2000;
export const SILENT_MS = 6000;
/** Before the first open: give up after this many failed tries (the relay can't be reached). */
export const FIRST_TRIES = 5;

/** The room code in an invite link (`?salon=ABCD`), upper-cased, or null. */
export function codeFromSearch(search: string): string | null {
  const c = new URLSearchParams(search).get("salon")?.trim().toUpperCase() ?? "";
  return normCode(c);
}

/** A typed code, cleaned (letters only, upper case; O read as Q's neighbour is not guessed): null unless 4 letters. */
export function normCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z]/g, "");
  return CODE_RE.test(c) ? c : null;
}

/** A fresh code from `random` (uniform in [0, 1)). */
export function drawCode(random: () => number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
}

/** A seat key: 16 hex digits. */
export function drawKey(random: () => number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += Math.floor(random() * 65536).toString(16).padStart(4, "0");
  return s;
}

/** The relay to use: `?relais=` (ws:// or wss://, or http(s):// read as such), else RELAY_URL. */
export function relayBase(search: string): string {
  const r = new URLSearchParams(search).get("relais")?.trim();
  if (r && /^(wss?|https?):\/\/[^\s]+$/i.test(r)) return r.replace(/^http/i, "ws").replace(/\/+$/, "");
  return RELAY_URL;
}

/** The invite link: this page's address with `?salon=CODE` (and nothing else of its query but `relais` and `style`). */
export function inviteUrl(href: string, code: string): string {
  const u = new URL(href);
  const keep = new URLSearchParams();
  for (const k of ["relais", "style"]) {
    const v = u.searchParams.get(k);
    if (v !== null) keep.set(k, v);
  }
  keep.set("salon", code);
  u.search = keep.toString();
  u.hash = "";
  return u.href;
}

/** One packet on the wire. */
export function encodeWire(base64: string, nbits: number): string {
  return `p${nbits} ${base64}`;
}

/** A packet off the wire, or null (not a packet: the relay's own JSON, a pong, junk). */
export function decodeWire(msg: string): { base64: string; nbits: number } | null {
  const m = /^p(\d{1,4}) ([A-Za-z0-9+/=]{1,400})$/.exec(msg);
  if (!m) return null;
  return { nbits: Number(m[1]), base64: m[2]! };
}

/** The relay's own message (JSON), or null. */
export function decodeControl(msg: string): { t: "salut"; pair: boolean } | { t: "pair"; on: boolean } | null {
  if (!msg.startsWith("{")) return null;
  try {
    const o = JSON.parse(msg) as { t?: unknown; pair?: unknown; on?: unknown };
    if (o.t === "salut") return { t: "salut", pair: o.pair === true };
    if (o.t === "pair") return { t: "pair", on: o.on === true };
  } catch {
    /* not ours */
  }
  return null;
}

/** What a WebSocket is to this module (the browser's, or a test's). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface OnlineTimers extends RelayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface OnlineEnv {
  socket(url: string): SocketLike;
  now(): number;
  timers: OnlineTimers;
  /** The page coming back (visible, online): `fn` on each; returns the removal. Null: none (tests). */
  onWake: ((fn: () => void) => () => void) | null;
}

export function browserOnlineEnv(): OnlineEnv {
  return {
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    now: () => performance.now(),
    timers: {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as number),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as number)
    },
    onWake: (fn) => {
      const vis = () => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", vis);
      window.addEventListener("online", fn);
      return () => {
        document.removeEventListener("visibilitychange", vis);
        window.removeEventListener("online", fn);
      };
    }
  };
}

/** Why a room can't be had: no such room, it's full, the relay refused this page, or it can't be reached. */
export type OnlineFailure = "unknown" | "full" | "taken" | "expired" | "origin" | "unreachable" | "replaced" | "abuse";

export const FAILURE_TEXT: Record<OnlineFailure, string> = {
  unknown: tr("Aucun salon sous ce code : vérifie-le, ou demande à ton ami d'en créer un.", "No lobby under that code: check it, or ask your friend to create one."),
  full: tr("Ce salon est complet : deux joueurs y sont déjà.", "This lobby is full: two players are already in."),
  taken: tr("Ce code est déjà pris.", "That code is already taken."),
  expired: tr("Ce salon a expiré : créez-en un nouveau.", "This lobby has expired: create a new one."),
  origin: tr("Le relais refuse cette page.", "The relay refuses this page."),
  unreachable: tr("Impossible de joindre le relais : vérifie ta connexion Internet.", "Can't reach the relay: check your Internet connection."),
  replaced: tr("Ce salon a été repris depuis un autre onglet.", "This lobby was taken over from another tab."),
  abuse: tr("Le relais a coupé la liaison (trop de messages).", "The relay cut the link (too many messages).")
};

export class OnlineError extends Error {
  constructor(readonly failure: OnlineFailure) {
    super(FAILURE_TEXT[failure]);
    this.name = "OnlineError";
  }
}

const FINAL: Partial<Record<number, OnlineFailure>> = {
  [CLOSE.unknown]: "unknown",
  [CLOSE.full]: "full",
  [CLOSE.taken]: "taken",
  [CLOSE.expired]: "expired",
  [CLOSE.origin]: "origin",
  [CLOSE.replaced]: "replaced",
  [CLOSE.abuse]: "abuse"
};

export interface OnlineOptions {
  base: string;
  code: string;
  role: BandRole;
  key: string;
  /** The host creates the room (its first connection). */
  create: boolean;
  env: OnlineEnv;
}

/** The socket's state as the lobby and the stall pill show it. */
export type SocketState = "connecting" | "open" | "down" | "closed";

export interface OnlineInfo {
  code: string;
  role: BandRole;
  state: SocketState;
  /** The friend's connection is in the room. */
  peer: boolean;
  /** The friend was in the room and left, this long ago (ms; null: it is there, or never came). */
  peerGoneMs: number | null;
  /** This socket has been down this long (ms; null: it's open). */
  downMs: number | null;
  failure: OnlineFailure | null;
}

/**
 * The online LinkTransport: RelayTransport's packets through a WebSocket that
 * reconnects. `ready` resolves at the relay's welcome on the first
 * connection, and rejects with an OnlineError if the room can't be had.
 */
export class OnlineLink implements LinkTransport {
  readonly code: string;
  readonly role: BandRole;
  readonly key: string;
  readonly ready: Promise<void>;
  private readonly relay: RelayTransport;
  private readonly win: RelayWindow = {};
  private readonly env: OnlineEnv;
  private readonly base: string;
  private create: boolean;
  private ws: SocketLike | null = null;
  private st: SocketState = "connecting";
  private peerOn = false;
  private peerSeen = false;
  private peerGoneAt: number | null = null;
  private downSince: number | null = null;
  private lastIn = 0;
  private tries = 0;
  private welcomed = false;
  private fail: OnlineFailure | null = null;
  private retry: unknown = null;
  private readonly pinger: unknown;
  private readonly offWake: () => void;
  private settle: { ok: () => void; no: (e: OnlineError) => void } | null = null;
  /** Messages in and out (tests and the report). */
  sent = 0;
  received = 0;

  constructor(o: OnlineOptions) {
    this.code = o.code;
    this.role = o.role;
    this.key = o.key;
    this.env = o.env;
    this.base = o.base;
    this.create = o.create;
    this.win.__duelOut = (b64, nbits) => this.out(encodeWire(b64, nbits));
    this.relay = new RelayTransport({ role: o.role, win: this.win, now: o.env.now, timers: o.env.timers, mode: "robust" });
    this.ready = new Promise<void>((ok, no) => (this.settle = { ok, no }));
    // (nobody may be waiting on it: a rejection nobody reads is not an error)
    this.ready.catch(() => undefined);
    this.pinger = o.env.timers.setInterval(() => this.ping(), PING_MS);
    this.offWake = o.env.onWake?.(() => this.wake()) ?? (() => undefined);
    this.connect();
  }

  // ------------------------------------------------------- the socket ---

  private url(): string {
    const role = this.role === "host" ? "hote" : "invite";
    return `${this.base}/salon/${this.code}?role=${role}&cle=${encodeURIComponent(this.key)}${this.create ? "&nouveau=1" : ""}`;
  }

  private connect(): void {
    if (this.st === "closed") return;
    this.retry = null;
    let ws: SocketLike;
    try {
      ws = this.env.socket(this.url());
    } catch {
      return this.lost(null, 1006);
    }
    this.ws = ws;
    if (this.st !== "open") this.st = "connecting";
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastIn = this.env.now();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      this.lastIn = this.env.now();
      this.message(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.lost(ws, ev.code);
    };
    ws.onerror = () => undefined; // (a close always follows)
  }

  private message(data: string): void {
    const p = decodeWire(data);
    if (p) {
      this.received++;
      this.win.__duelIn?.(p.base64, p.nbits);
      return;
    }
    const c = decodeControl(data);
    if (!c) return;
    if (c.t === "salut") {
      this.st = "open";
      this.tries = 0;
      this.downSince = null;
      // (the room exists now: a reconnect takes the seat back with the key, it doesn't create)
      this.create = false;
      this.setPeer(c.pair);
      if (!this.welcomed) {
        this.welcomed = true;
        this.settle?.ok();
        this.settle = null;
      }
    } else this.setPeer(c.on);
  }

  private setPeer(on: boolean): void {
    if (on) {
      this.peerSeen = true;
      this.peerGoneAt = null;
    } else if (this.peerOn || (this.peerSeen && this.peerGoneAt === null)) this.peerGoneAt = this.env.now();
    this.peerOn = on;
  }

  /** The socket closed (or couldn't be made): final, or try again. */
  private lost(ws: SocketLike | null, code: number): void {
    if (ws && this.ws !== ws) return;
    this.ws = null;
    if (this.st === "closed") return;
    const final = FINAL[code];
    // (a room this page created and then lost before the welcome, under the same key: the retry takes it back)
    if (final && !(final === "taken" && this.welcomed)) return this.give(final);
    if (this.st === "open") this.downSince = this.env.now();
    this.st = this.welcomed ? "down" : "connecting";
    this.peerOn = false;
    this.tries++;
    if (!this.welcomed && this.tries >= FIRST_TRIES) return this.give("unreachable");
    const ms = RETRY_MS[Math.min(this.tries - 1, RETRY_MS.length - 1)]!;
    this.retry = this.env.timers.setTimeout(() => this.connect(), ms);
  }

  private give(f: OnlineFailure): void {
    this.fail = f;
    this.st = "closed";
    this.stop();
    this.settle?.no(new OnlineError(f));
    this.settle = null;
  }

  private out(msg: string): void {
    const ws = this.ws;
    if (!ws || this.st !== "open" || ws.readyState !== 1) return;
    try {
      ws.send(msg);
      this.sent++;
    } catch {
      /* closing: its close event comes */
    }
  }

  private ping(): void {
    const ws = this.ws;
    if (!ws) return;
    // (closing or closed with no close event yet: a close() with the network gone can wait a long time for one)
    if (ws.readyState >= 2 && this.st === "open") {
      this.ws = null;
      return this.lost(null, 1006);
    }
    if (ws.readyState !== 1) return;
    if (this.env.now() - this.lastIn > SILENT_MS) {
      // (a half-open socket: nothing heard, not even the pong; take it as gone)
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return this.lost(null, 1006);
    }
    try {
      ws.send("ping");
    } catch {
      /* closing */
    }
  }

  /** The page came back: a link waiting to retry tries now, and a socket that may have died meanwhile is checked. */
  private wake(): void {
    if (this.st === "closed") return;
    if (this.retry !== null) {
      this.env.timers.clearTimeout(this.retry);
      this.connect();
    } else this.ping();
  }

  private stop(): void {
    if (this.retry !== null) this.env.timers.clearTimeout(this.retry);
    this.retry = null;
    this.env.timers.clearInterval(this.pinger);
    this.offWake();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "fin");
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------- reading ---

  info(): OnlineInfo {
    const now = this.env.now();
    return {
      code: this.code,
      role: this.role,
      state: this.st,
      peer: this.peerOn,
      peerGoneMs: this.peerGoneAt === null ? null : now - this.peerGoneAt,
      downMs: this.st === "open" ? null : this.downSince === null ? null : now - this.downSince,
      failure: this.fail
    };
  }

  /** Drive the packet clock (the lobby's and the feed's frames call it too, as for ?duel=relay). */
  tick(): void {
    this.relay.tick();
  }

  // --------------------------------------------------- LinkTransport ---

  capacity(): number {
    return this.relay.capacity();
  }
  send(frames: readonly OutFrame[]): void {
    this.relay.send(frames);
  }
  poll(): LinkPacket[] {
    return this.relay.poll();
  }
  slots(): number[] {
    return this.relay.slots();
  }
  now(): number {
    return this.relay.now();
  }
  setMode(mode: ModemMode): void {
    this.relay.setMode(mode);
  }
  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.relay.setSessionKey(hostNonce, guestNonce);
  }
  stats(): LinkStats {
    return this.relay.stats();
  }
  close(): void {
    if (this.st === "closed" && !this.ws) {
      this.relay.close();
      return;
    }
    this.st = "closed";
    this.stop();
    this.relay.close();
    this.settle?.no(new OnlineError("unreachable"));
    this.settle = null;
  }
}

/**
 * The host's room: a fresh code, created; a code in use (4010) draws another,
 * up to 6 times. `code` (a rematch's): that room, taken back with `key`.
 */
export async function hostRoom(o: { base: string; key: string; code?: string; env: OnlineEnv; random: () => number }): Promise<OnlineLink> {
  if (o.code) {
    const l = new OnlineLink({ base: o.base, code: o.code, role: "host", key: o.key, create: true, env: o.env });
    await l.ready;
    return l;
  }
  let last: unknown = null;
  for (let i = 0; i < 6; i++) {
    const l = new OnlineLink({ base: o.base, code: drawCode(o.random), role: "host", key: o.key, create: true, env: o.env });
    try {
      await l.ready;
      return l;
    } catch (e) {
      last = e;
      l.close();
      if (!(e instanceof OnlineError) || e.failure !== "taken") throw e;
    }
  }
  throw last instanceof Error ? last : new OnlineError("taken");
}

/** The guest's seat in the room `code`. */
export async function joinRoom(o: { base: string; key: string; code: string; env: OnlineEnv }): Promise<OnlineLink> {
  const l = new OnlineLink({ base: o.base, code: o.code, role: "guest", key: o.key, create: false, env: o.env });
  try {
    await l.ready;
  } catch (e) {
    l.close();
    throw e;
  }
  return l;
}
