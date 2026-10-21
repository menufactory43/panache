/**
 * The online duel (src/versus/online.ts, relay/): the wire framing, the
 * relay's room logic (relay/src/salon.ts, pure: the Durable Object only
 * applies it), and two Sessions in lockstep over two OnlineLinks through an
 * in-memory relay that applies that same logic, with latency, jitter (in
 * order, as TCP delivers) and a connection that drops and comes back.
 */
import { describe, expect, it } from "vitest";
import {
  CLE_MAX, DEBIT_RAFALE, FERME, MESSAGE_MAX, RECONNEXION_MS, Seau, VIE_MAX_MS, admettre, codeDe, entrer, origineAdmise, perime, prochainReveil, relayable,
  sortir, type Etat, type Role
} from "../relay/src/salon";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { hash32 } from "../src/sim/rand";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { Command, Faction, World } from "../src/sim/types";
import {
  CODE_ALPHABET, OnlineError, OnlineLink, codeFromSearch, decodeControl, decodeWire, drawCode, drawKey, encodeWire, hostRoom, inviteUrl, joinRoom,
  normCode, relayBase, RELAY_URL, type OnlineEnv, type OnlineTimers, type SocketLike
} from "../src/versus/online";
import { encodeRelayPacket } from "../src/versus/relay-transport";
import { Session } from "../src/versus/session";

const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0x0e11, i++) / 4294967296;
};

// ------------------------------------------------------------ framing ---

describe("the online wire", () => {
  it("carries a relay packet as `p<nbits> <base64>` and back", () => {
    const bits = new Uint8Array(24).fill(0xa5);
    bits[0] = 0x80;
    const b64 = encodeRelayPacket({ bits, nbits: 188 }, 0xffff, "fast");
    const msg = encodeWire(b64, 188);
    expect(msg.startsWith("p188 ")).toBe(true);
    expect(msg.length).toBeLessThan(MESSAGE_MAX);
    expect(relayable(msg)).toBe(true);
    expect(decodeWire(msg)).toEqual({ base64: b64, nbits: 188 });
  });

  it("takes nothing else for a packet", () => {
    for (const junk of ["", "p", "p12", "p12 ", "pong", "ping", "q12 AAAA", "p12 AA AA", "p12345 AAAA", '{"t":"pair","on":true}', "p12 <script>"])
      expect(decodeWire(junk), junk).toBeNull();
  });

  it("reads the relay's own messages", () => {
    expect(decodeControl('{"t":"salut","role":"hote","pair":true}')).toEqual({ t: "salut", pair: true });
    expect(decodeControl('{"t":"pair","on":false}')).toEqual({ t: "pair", on: false });
    expect(decodeControl("{nope")).toBeNull();
    expect(decodeControl('{"t":"autre"}')).toBeNull();
    expect(decodeControl("p12 AAAA")).toBeNull();
  });

  it("draws codes of 4 letters without I or O, reads typed and linked codes, builds the invite link", () => {
    const r = rng(1);
    for (let i = 0; i < 500; i++) {
      const c = drawCode(r);
      expect(c).toMatch(/^[A-Z]{4}$/);
      expect([...c].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
    }
    expect(drawKey(rng(2))).toMatch(/^[0-9a-f]{16}$/);
    expect(normCode(" ab-cd ")).toBe("ABCD");
    expect(normCode("abc")).toBeNull();
    expect(normCode("abcde")).toBeNull();
    expect(codeFromSearch("?salon=wxyz")).toBe("WXYZ");
    expect(codeFromSearch("?salon=12")).toBeNull();
    expect(codeFromSearch("?map=x")).toBeNull();
    expect(inviteUrl("https://menufactory43.github.io/panache/?duel=relay&seat=host&style=original#x", "QRST")).toBe(
      "https://menufactory43.github.io/panache/?style=original&salon=QRST"
    );
    expect(relayBase("")).toBe(RELAY_URL);
    expect(relayBase("?relais=http://localhost:8787/")).toBe("ws://localhost:8787");
    expect(relayBase("?relais=javascript:alert(1)")).toBe(RELAY_URL);
  });
});

// ------------------------------------------------------- relay logic ---

const none = new Set<Role>();
const only = (...r: Role[]) => new Set<Role>(r);
const VIDE: Etat = { cree: null, hote: null, invite: null };

describe("the relay's rooms", () => {
  it("lets a host create, a guest join, and no third player in", () => {
    let e = VIDE;
    expect(admettre(e, "invite", "g", false, none, 0)).toMatchObject({ ok: false, code: FERME.inconnu });
    expect(admettre(e, "hote", "h", true, none, 0)).toEqual({ ok: true });
    e = entrer(e, "hote", "h", true, 0);
    expect(e.cree).toBe(0);
    // a second host on the same code: taken (it draws another code); the same key again is a retry
    expect(admettre(e, "hote", "x", true, only("hote"), 10)).toMatchObject({ ok: false, code: FERME.pris });
    expect(admettre(e, "hote", "h", true, only("hote"), 10)).toEqual({ ok: true });
    expect(admettre(e, "invite", "g", false, only("hote"), 10)).toEqual({ ok: true });
    e = entrer(e, "invite", "g", false, 10);
    expect(admettre(e, "invite", "z", false, only("hote", "invite"), 20)).toMatchObject({ ok: false, code: FERME.complet });
    // the host's seat can't be taken without its key
    expect(admettre(e, "hote", "z", false, only("hote", "invite"), 20)).toMatchObject({ ok: false, code: FERME.complet });
  });

  it("keeps a dropped player's seat for the reconnect window, then frees the room", () => {
    let e = entrer(entrer(VIDE, "hote", "h", true, 0), "invite", "g", false, 5);
    e = sortir(e, "invite", 1000);
    // back with its key inside the minute; a stranger can't have the seat meanwhile
    expect(admettre(e, "invite", "g", false, only("hote"), 1000 + RECONNEXION_MS - 1)).toEqual({ ok: true });
    expect(admettre(e, "invite", "z", false, only("hote"), 1000 + RECONNEXION_MS - 1)).toMatchObject({ ok: false, code: FERME.complet });
    // after it, the seat is free again
    expect(admettre(e, "invite", "z", false, only("hote"), 1000 + RECONNEXION_MS)).toEqual({ ok: true });
    // the host gone too: the room lives until the last window closes, then it is dead
    e = sortir(e, "hote", 2000);
    expect(prochainReveil(e, none)).toBe(2000 + RECONNEXION_MS);
    expect(perime(e, none, 2000 + RECONNEXION_MS - 1)).toBe(false);
    expect(perime(e, none, 2000 + RECONNEXION_MS)).toBe(true);
    expect(admettre(e, "invite", "g", false, none, 2000 + RECONNEXION_MS)).toMatchObject({ ok: false, code: FERME.inconnu });
    // and a new host may create a room under the code again, from scratch
    expect(admettre(e, "hote", "n", true, none, 2000 + RECONNEXION_MS)).toEqual({ ok: true });
    expect(entrer(e, "hote", "n", true, 9e9)).toEqual({ cree: 9e9, hote: { cle: "n", vu: 9e9 }, invite: null });
  });

  it("expires a room after its maximum life, occupied or not", () => {
    const e = entrer(VIDE, "hote", "h", true, 0);
    expect(prochainReveil(e, only("hote"))).toBe(VIE_MAX_MS);
    expect(perime(e, only("hote"), VIE_MAX_MS - 1)).toBe(false);
    expect(perime(e, only("hote"), VIE_MAX_MS)).toBe(true);
    expect(admettre(e, "hote", "h", false, only("hote"), VIE_MAX_MS)).toMatchObject({ ok: false, code: FERME.expire });
  });

  it("relays only the game's packets, of a bounded size and rate", () => {
    expect(relayable("p188 AAAA")).toBe(true);
    expect(relayable('{"t":"pair","on":false}')).toBe(false);
    expect(relayable("ping")).toBe(false);
    expect(relayable("p" + "A".repeat(MESSAGE_MAX))).toBe(false);
    expect(relayable(new ArrayBuffer(4))).toBe(false);
    const s = new Seau(0);
    let ok = 0;
    for (let i = 0; i < 200; i++) if (s.prendre(0)) ok++;
    expect(ok).toBe(DEBIT_RAFALE);
    // 10 packets a second (the game's fast rate) always pass
    const g = new Seau(0);
    for (let t = 0; t < 60_000; t += 100) expect(g.prendre(t)).toBe(true);
    expect(CLE_MAX).toBeGreaterThanOrEqual(16);
  });

  it("admits the published page and local development only", () => {
    for (const o of [null, "", "https://menufactory43.github.io", "http://localhost:5302", "https://localhost", "http://127.0.0.1:4173", "https://192.168.1.20:5173", "http://10.0.0.5:5173"])
      expect(origineAdmise(o), String(o)).toBe(true);
    for (const o of ["https://evil.example", "https://menufactory43.github.io.evil.example", "http://menufactory43.github.io", "https://8.8.8.8", "null", "file://"])
      expect(origineAdmise(o), o).toBe(false);
    expect(codeDe("/salon/abcd")).toBe("ABCD");
    expect(codeDe("/salon/ABC")).toBeNull();
    expect(codeDe("/salon/ABCDE")).toBeNull();
  });
});

// ------------------------------------------------- a relay in memory ---

/** Virtual time and timers. */
class Clock implements OnlineTimers {
  t = 0;
  private n = 0;
  private q: { id: number; at: number; fn: () => void; every: number | null }[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.n;
    this.q.push({ id, at: this.t + ms, fn, every: null });
    return id;
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.n;
    this.q.push({ id, at: this.t + ms, fn, every: Math.max(1, ms) });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.q = this.q.filter((x) => x.id !== h);
  }
  clearInterval(h: unknown): void {
    this.clearTimeout(h);
  }
  /** Run time forward to `to`, every timer due on the way in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: (typeof this.q)[number] | null = null;
      for (const x of this.q) if (x.at <= end && (!next || x.at < next.at)) next = x;
      if (!next) break;
      this.t = next.at;
      if (next.every === null) this.q = this.q.filter((x) => x !== next);
      else next.at += next.every;
      next.fn();
    }
    this.t = end;
  }
}

/** One end of a connection: the client's socket, its messages carried by the relay with a delay. */
class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  role: Role | null = null;
  code = "";
  /** In-order delivery each way (TCP): the time the last message lands. */
  lastUp = 0;
  lastDown = 0;
  constructor(readonly relay: FakeRelay, readonly url: string) {}
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.relay.up(this, data);
  }
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.relay.gone(this, code, true);
  }
}

/** The relay's logic (salon.ts) over sockets in memory, with latency, jitter and drops. */
class FakeRelay {
  rooms = new Map<string, { e: Etat; socks: Map<Role, FakeSocket> }>();
  forwarded = 0;
  /** The network is down until then: connections fail (1006). */
  downUntil = 0;
  constructor(readonly clock: Clock, readonly latencyMs: number, readonly jitterMs: number, readonly rand: () => number) {}
  private delay(): number {
    return this.latencyMs + this.rand() * this.jitterMs;
  }
  private room(code: string) {
    let r = this.rooms.get(code);
    if (!r) this.rooms.set(code, (r = { e: { cree: null, hote: null, invite: null }, socks: new Map() }));
    return r;
  }
  private branches(code: string): Set<Role> {
    return new Set([...this.room(code).socks.keys()]);
  }
  connect(url: string): FakeSocket {
    const s = new FakeSocket(this, url);
    if (this.clock.t < this.downUntil) {
      this.clock.setTimeout(() => ((s.readyState = 3), s.onclose?.({ code: 1006 })), 30);
      return s;
    }
    this.clock.setTimeout(() => this.accept(s), this.delay());
    return s;
  }
  private accept(s: FakeSocket): void {
    if (s.readyState !== 0) return;
    const u = new URL(s.url);
    const code = codeDe(u.pathname)!;
    const q = u.searchParams;
    const role: Role = q.get("role") === "hote" ? "hote" : "invite";
    const cle = q.get("cle") ?? "";
    const nouveau = q.get("nouveau") === "1";
    const r = this.room(code);
    s.readyState = 1;
    s.onopen?.({});
    const ok = admettre(r.e, role, cle, nouveau, this.branches(code), this.clock.t);
    if (!ok.ok) return this.drop(s, ok.code);
    r.e = entrer(r.e, role, cle, nouveau, this.clock.t);
    const old = r.socks.get(role);
    s.role = role;
    s.code = code;
    r.socks.set(role, s);
    if (old) this.drop(old, FERME.remplace);
    const other = r.socks.get(role === "hote" ? "invite" : "hote");
    this.down(s, JSON.stringify({ t: "salut", role, pair: !!other }));
    if (other) this.down(other, JSON.stringify({ t: "pair", on: true }));
  }
  /** A message from the client, at the relay after the delay. */
  up(s: FakeSocket, data: string): void {
    const at = Math.max(s.lastUp, this.clock.t + this.delay());
    s.lastUp = at;
    this.clock.setTimeout(() => {
      if (s.readyState !== 1 || !s.role) return;
      if (data === "ping") return this.down(s, "pong");
      if (!relayable(data)) return;
      const other = this.rooms.get(s.code)?.socks.get(s.role === "hote" ? "invite" : "hote");
      if (other) {
        this.forwarded++;
        this.down(other, data);
      }
    }, at - this.clock.t);
  }
  /** A message to the client, delivered after the delay. */
  down(s: FakeSocket, data: string): void {
    const at = Math.max(s.lastDown, this.clock.t + this.delay());
    s.lastDown = at;
    this.clock.setTimeout(() => {
      if (s.readyState === 1) s.onmessage?.({ data });
    }, at - this.clock.t);
  }
  /** The relay closes `s` with `code` (the client hears it after the delay). */
  drop(s: FakeSocket, code: number): void {
    this.gone(s, code, false);
    this.clock.setTimeout(() => {
      s.readyState = 3;
      s.onclose?.({ code });
    }, this.delay());
  }
  /** The network drops `s`: the relay sees it at once, the client a little later (1006). */
  kill(s: FakeSocket): void {
    this.drop(s, 1006);
  }
  /** `s` is gone from the relay's side: its seat is kept, the other told. */
  gone(s: FakeSocket, code: number, byClient: boolean): void {
    if (byClient) this.clock.setTimeout(() => ((s.readyState = 3), s.onclose?.({ code })), 0);
    if (!s.role) return;
    const r = this.rooms.get(s.code)!;
    if (r.socks.get(s.role) !== s) return;
    r.socks.delete(s.role);
    r.e = sortir(r.e, s.role, this.clock.t);
    const other = r.socks.get(s.role === "hote" ? "invite" : "hote");
    if (other) this.down(other, JSON.stringify({ t: "pair", on: false }));
    s.role = null;
  }
  socketOf(code: string, role: Role): FakeSocket | undefined {
    return this.rooms.get(code)?.socks.get(role);
  }
}

function envOf(clock: Clock, relay: FakeRelay): OnlineEnv {
  return { socket: (url) => relay.connect(url), now: () => clock.t, timers: clock, onWake: null };
}

/** Let promises settle (the rooms' `ready`) while virtual time runs. */
async function run(clock: Clock, ms: number, slice = 10): Promise<void> {
  for (let t = 0; t < ms; t += slice) {
    clock.advance(slice);
    await Promise.resolve();
  }
}

describe("online rooms through the relay", () => {
  it("creates a room, joins it, refuses a third and an unknown code, and tells each who is there", async () => {
    const clock = new Clock();
    const relay = new FakeRelay(clock, 40, 20, rng(3));
    const env = envOf(clock, relay);
    const hostP = hostRoom({ base: "wss://r", key: "aa", env, random: rng(4) });
    await run(clock, 500);
    const host = await hostP;
    expect(host.info()).toMatchObject({ role: "host", state: "open", peer: false, peerGoneMs: null });
    const unknown = joinRoom({ base: "wss://r", key: "bb", code: host.code === "ZZZZ" ? "YYYY" : "ZZZZ", env });
    const guestP = joinRoom({ base: "wss://r", key: "bb", code: host.code, env });
    await run(clock, 500);
    await expect(unknown).rejects.toBeInstanceOf(OnlineError);
    await expect(unknown).rejects.toMatchObject({ failure: "unknown" });
    const guest = await guestP;
    expect(guest.info()).toMatchObject({ role: "guest", state: "open", peer: true });
    expect(host.info().peer).toBe(true);
    const third = joinRoom({ base: "wss://r", key: "cc", code: host.code, env });
    await run(clock, 500);
    await expect(third).rejects.toMatchObject({ failure: "full" });
    // a second host drawing the same code draws another
    const clash = hostRoom({ base: "wss://r", key: "dd", env, random: rng(4) });
    await run(clock, 2000);
    expect((await clash).code).not.toBe(host.code);
    // the guest's connection drops: the host is told, the guest comes back on its own with its key
    relay.kill(relay.socketOf(host.code, "invite")!);
    await run(clock, 200);
    expect(host.info().peer).toBe(false);
    expect(host.info().peerGoneMs).not.toBeNull();
    await run(clock, 2000);
    expect(guest.info()).toMatchObject({ state: "open", peer: true });
    expect(host.info()).toMatchObject({ peer: true, peerGoneMs: null });
    for (const l of [host, guest, await clash]) l.close();
  });

  it("gives up on a relay it can't reach", async () => {
    const clock = new Clock();
    const env: OnlineEnv = {
      socket: () => {
        const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} } as unknown as SocketLike;
        clock.setTimeout(() => s.onclose?.({ code: 1006 }), 30);
        return s;
      },
      now: () => clock.t, timers: clock, onWake: null
    };
    const l = new OnlineLink({ base: "wss://r", code: "ABCD", role: "guest", key: "k", create: false, env });
    let err: unknown = null;
    l.ready.catch((e: unknown) => (err = e));
    await run(clock, 20_000, 50);
    expect(err).toBeInstanceOf(OnlineError);
    expect((err as OnlineError).failure).toBe("unreachable");
  });
});

// ------------------------------------------- lockstep over the relay ---

interface Phone {
  role: "host" | "guest";
  link: OnlineLink;
  s: Session;
  w: World | null;
  side: Faction | null;
  ai: AiState | null;
  acc: number;
  last: number;
  trails: number[];
  extra: Command[];
  picked: boolean;
}

describe("a duel over the relay", () => {
  it(
    "pairs, plays in lockstep with an AI on each side through latency, jitter and a dropped connection, and both see the resign",
    { timeout: 180_000 },
    async () => {
      const clock = new Clock();
      const relay = new FakeRelay(clock, 45, 60, rng(7));
      const env = envOf(clock, relay);
      const hostP = hostRoom({ base: "wss://r", key: "h0", env, random: rng(8) });
      await run(clock, 300);
      const hostLink = await hostP;
      const guestP = joinRoom({ base: "wss://r", key: "g0", code: hostLink.code, env });
      await run(clock, 300);
      const guestLink = await guestP;
      const mk = (role: "host" | "guest", link: OnlineLink, seed: number): Phone => ({
        role, link, w: null, side: null, ai: null, acc: 0, last: clock.t, trails: [], extra: [], picked: false,
        s: new Session({ transport: link, role, build: 0x0e1, random: rng(seed), ...(role === "host" ? { host: { map: "riverlands", mutators: [] } } : {}) })
      });
      const phones = [mk("host", hostLink, 11), mk("guest", guestLink, 12)];
      const RESIGN_AT = 1200;
      const DROP_AT = 600;
      let dropped = false;
      let stalledAtDrop = 0;
      const frame = (p: Phone) => {
        const dt = clock.t - p.last;
        p.last = clock.t;
        p.link.tick();
        p.s.pump();
        if (p.s.phase === "pairing") {
          const st = p.s.pairing.state();
          if (st.phase === "picking" && !p.picked) p.picked = p.s.pick(st.offered[0]!);
        } else if (p.s.phase === "starting" && !p.w) {
          const r = p.s.result()!;
          p.side = r.local;
          p.w = setupWorld(r.setup);
          p.ai = createAiState(r.local === "blue" ? "balanced" : "rush", "normal", hash32(7, r.local === "blue" ? 1 : 2));
          p.s.beginMatch(parseInt(worldHash(p.w), 16));
        }
        const ls = p.s.lockstep;
        const w = p.w;
        if (!w || !ls || w.winner) return;
        p.acc += dt * p.s.speed();
        for (let n = 0; p.acc >= 100 && n < 8; n++) {
          const t = w.tick;
          const cmds = p.s.commandsFor(t, () => [...tickAi(w, p.side!, p.ai!), ...p.extra.splice(0)]);
          if (!cmds) {
            p.acc = 99.9;
            break;
          }
          step(w, cmds);
          p.s.afterStep(t, parseInt(worldHash(w), 16), w.winner ? { winner: w.winner, resigned: w.resigned ?? null } : null);
          p.trails[t] = ls.trail();
          p.acc -= 100;
          if (p.role === "guest" && t === RESIGN_AT) p.extra.push({ type: "resign", faction: p.side! });
          if (w.winner) break;
        }
      };
      const limit = 400_000;
      while (clock.t < limit) {
        await run(clock, 16, 16);
        for (const p of phones) frame(p);
        const g = phones[1]!;
        if (!dropped && g.w && g.w.tick >= DROP_AT) {
          // the guest's connection drops (a tunnel, 4 s with no network): the relay keeps its seat, its link retries
          // and reconnects, and the match goes on
          dropped = true;
          stalledAtDrop = Math.max(...phones.map((p) => p.s.lockstep!.status().stallMs));
          relay.kill(relay.socketOf(hostLink.code, "invite")!);
          relay.downUntil = clock.t + 4000;
        }
        if (phones.every((p) => p.w?.winner)) break;
      }
      expect(clock.t).toBeLessThan(limit);
      const [h, g] = phones as [Phone, Phone];
      // the same match: setup, delay, nonces, sides
      const [hr, gr] = [h.s.result()!, g.s.result()!];
      expect(gr.setup).toEqual(hr.setup);
      expect([gr.delay, gr.hostNonce, gr.guestNonce]).toEqual([hr.delay, hr.hostNonce, hr.guestNonce]);
      expect(hr.local).not.toBe(gr.local);
      // the input delay follows the relay's round trip (two legs each way, 45–105 ms each): D = 3 or 4 (300–400 ms)
      expect(hr.delay).toBeGreaterThanOrEqual(3);
      expect(hr.delay).toBeLessThanOrEqual(4);
      // the guest resigned: decided on the same tick for both, the host's side winning, identical trails throughout
      expect(h.w!.winner).toBe(hr.local);
      expect(g.w!.winner).toBe(hr.local);
      expect(h.w!.tick).toBe(g.w!.tick);
      expect(h.w!.tick).toBeGreaterThan(RESIGN_AT);
      expect(worldHash(h.w!)).toBe(worldHash(g.w!));
      for (let t = 0; t < h.w!.tick; t++) expect(h.trails[t], `tick ${t}`).toBe(g.trails[t]);
      for (const p of phones) expect(p.s.lockstep!.status().desync).toBe(false);
      // the drop stalled the match for a while (the reconnect), then it went on
      expect(dropped).toBe(true);
      const stall = Math.max(...phones.map((p) => p.s.lockstep!.status().stallMs)) - stalledAtDrop;
      expect(stall).toBeGreaterThan(2500);
      expect(stall).toBeLessThan(10_000);
      expect(guestLink.info()).toMatchObject({ state: "open", peer: true });
      // the end checks agree once the end reports cross
      await run(clock, 3000);
      for (const p of phones) {
        p.link.tick();
        p.s.pump();
      }
      for (const p of phones) expect(p.s.lockstep!.status().endCheck).toBe("ok");
      for (const p of phones) p.s.close();
      expect(relay.forwarded).toBeGreaterThan(2000);
      console.log(`online duel: D ${hr.delay}, rtt ${h.s.status().rttMs} ms, ended at tick ${h.w!.tick}, stall after the drop ${stall} ms, ${relay.forwarded} packets relayed, ${(clock.t / 1000).toFixed(0)} s`);
    }
  );
});
