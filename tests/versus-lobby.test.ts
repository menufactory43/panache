import { describe, expect, it, vi } from "vitest";

// (the lobby builds the VersusFeed only once a match starts: its game code stays out of these tests)
vi.mock("../src/versus/feed", () => ({ VersusFeed: class {} }));

import { PacketAir } from "../src/link/packet-air";
import type { BandPlan, BandRole, LinkStats, LinkTransport } from "../src/link/transport";
import { worldHash } from "../src/sim/checksum";
import { PLURALS } from "../src/sim/lexicon";
import type { World } from "../src/sim/types";
import {
  LobbyMachine, QUIET_MS, REMATCH_FALLBACK_MS, TIPS_MS, openerGives, lobbyWords, nationPicker, nationsLine, parseDuelParams, parseRematch, rttLine, tipsText, type DuelRematch,
  type LobbyEnd, type LobbyEnv, type LobbyLink
} from "../src/versus/lobby";
import { OPENERS, OPENER_IDS } from "../src/sim/openers";
import { BUILDINGS } from "../src/sim/balance";
import { HeldEnd, LoopFriend, LoopLink, lobbyLatencyFor } from "../src/versus/loop-peer";
import { NOTHING_HEARD_MS, delayFor, packetMs } from "../src/versus/pairing";
import { RelayTransport, decodeRelayPacket, encodeRelayPacket, type RelayWindow } from "../src/versus/relay-transport";
import { Session } from "../src/versus/session";
import { reloadWithoutLink } from "../src/ui/fullscreen";

const BUILD = 0xd0e1;
const OFFER = { map: "riverlands", mutators: [], hostSide: "blue" as const };

/** Let pending promise callbacks run (the lobby's link is a promise). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A manual clock. */
function clock(t0 = 0) {
  const c = { t: t0, now: () => c.t };
  return c;
}

// ------------------------------------------------------- URL parameters ---

describe("the dev modes' URL parameters", () => {
  it("clamps delay, loss and latency, and reads the seat and side", () => {
    expect(parseDuelParams("")).toEqual({ mode: "none", seat: null, loop: { delay: null, loss: 0, latencyMs: 250 }, side: "blue" });
    expect(parseDuelParams("?duel=loop&delay=4&loss=0.1&latency=300&side=red")).toEqual({
      mode: "loop", seat: null, loop: { delay: 4, loss: 0.1, latencyMs: 300 }, side: "red"
    });
    expect(parseDuelParams("?duel=loop&delay=1&loss=-2&latency=-5").loop).toEqual({ delay: 3, loss: 0, latencyMs: 0 });
    expect(parseDuelParams("?duel=loop&delay=12&loss=3&latency=99999").loop).toEqual({ delay: 8, loss: 0.9, latencyMs: 2000 });
    expect(parseDuelParams("?duel=loop&delay=4.6").loop.delay).toBe(5);
    expect(parseDuelParams("?duel=loop&delay=abc&loss=&latency=x").loop).toEqual({ delay: null, loss: 0, latencyMs: 250 });
    expect(parseDuelParams("?duel=relay&seat=guest")).toMatchObject({ mode: "relay", seat: "guest" });
    expect(parseDuelParams("?duel=relay&seat=king").seat).toBeNull();
    // (a seat means nothing outside the relay, and other values of duel are the real thing)
    expect(parseDuelParams("?duel=loop&seat=host").seat).toBeNull();
    expect(parseDuelParams("?duel=sound&side=green")).toMatchObject({ mode: "none", side: "blue" });
  });

});

describe("the rematch a report stored", () => {
  const good: DuelRematch = { role: "guest", hostSide: "red", mapId: "riverlands", mutators: [] };

  it("reads back what Rematch wrote", () => {
    expect(parseRematch(JSON.stringify(good))).toEqual(good);
    const random = { ...good, mapId: "random-desert-1a2b3c", mutators: ["blitz", "nope"] };
    const r = parseRematch(JSON.stringify(random));
    expect(r?.mapId).toBe("random-desert-1a2b3c");
    expect(r?.mutators).toEqual(["blitz"]);
  });

  it("is no rematch when it doesn't read as one", () => {
    expect(parseRematch(null)).toBeNull();
    expect(parseRematch("")).toBeNull();
    expect(parseRematch("{not json")).toBeNull();
    expect(parseRematch("null")).toBeNull();
    expect(parseRematch(JSON.stringify({ ...good, role: "spectator" }))).toBeNull();
    expect(parseRematch(JSON.stringify({ ...good, hostSide: "green" }))).toBeNull();
    expect(parseRematch(JSON.stringify({ ...good, mapId: "atlantis" }))).toBeNull();
    // (an old sound duel's band and microphone fields are left behind)
    expect(parseRematch(JSON.stringify({ ...good, plan: "low", micMode: "ec" }))).toEqual(good);
  });
});

describe("the lobby's words", () => {
  it("the 30 s tips: the friend's room online, the other page or this one on a practice link", () => {
    expect(tipsText({ practice: null, online: { role: "host", code: "ABCD" } as never })).toMatch(/ABCD/);
    expect(tipsText({ practice: null, online: { role: "guest", code: "ABCD" } as never })).toMatch(/code/);
    expect(tipsText({ practice: "relay" })).toMatch(/relais/);
    expect(tipsText({ practice: "loop" })).toMatch(/Recharge la page/);
    for (const practice of ["loop", "relay"] as const) expect(tipsText({ practice })).not.toMatch(/volume|silencieux|Bluetooth|Avancé|écouteurs/i);
  });


  it("the meter's round trip, and on the loop the input delay instead", () => {
    const pairing = (delay: number | null) => ({ config: delay === null ? null : { delay } }) as unknown as NonNullable<Parameters<typeof rttLine>[0]["pairing"]>;
    const meter = (rttMs: number | null) => ({ rttMs });
    expect(rttLine({ practice: null, pairing: pairing(4), meter: meter(512.4) })).toBe("Aller-retour 512 ms");
    expect(rttLine({ practice: null, pairing: null, meter: meter(null) })).toBe("Aller-retour : mesure…");
    expect(rttLine({ practice: "relay", pairing: pairing(4), meter: meter(300) })).toBe("Aller-retour 300 ms");
    // (the loop's friend holds the lobby's packets to force &delay: 2999 ms means nothing there)
    expect(rttLine({ practice: "loop", pairing: pairing(8), meter: meter(2999) })).toBe("Liaison d'entraînement · délai d'entrée 800 ms");
    expect(rttLine({ practice: "loop", pairing: pairing(null), meter: meter(2999) })).toBe("Liaison d'entraînement");
  });

  it("the opener cards say what each gives, from the same data as the single-player picker", () => {
    expect(openerGives("blitz")).toBe(`${BUILDINGS["fab-plant"].name} · 3 Panhard · 2 Fardiers · −100 charbon`);
    for (const id of OPENER_IDS) {
      const o = OPENERS[id];
      const line = openerGives(id);
      expect(line).toContain(`${o.harvesters} Fardiers`);
      for (const k of new Set(o.units)) expect(line).toContain(`${o.units.filter((u) => u === k).length} ${PLURALS[k]}`);
      if (o.scrap === 0) expect(line).not.toMatch(/charbon/);
      else expect(line).toMatch(o.scrap > 0 ? `+${o.scrap} charbon` : `−${-o.scrap} charbon`);
    }
  });
});

describe("leaving a duel's or a replay's link behind", () => {
  const page = (href: string) => {
    const went: string[] = [];
    return { href, went, reload: () => void went.push("reload"), assign: (u: string | URL) => void went.push(String(u)) };
  };

  it("Menu from a practice duel leaves every duel parameter behind, side included", () => {
    const p = page("https://example.com/bd/?duel=loop&delay=4&loss=0.1&latency=300&side=red&seat=host&debug#x");
    reloadWithoutLink(p);
    expect(p.went).toEqual(["https://example.com/bd/?debug=#x"]);
  });

  it("a duel's Rematch keeps them, so a practice rematch is one again", () => {
    const p = page("https://example.com/bd/?duel=loop&side=red");
    reloadWithoutLink(p, "duel");
    expect(p.went).toEqual(["reload"]);
  });

  it("a single-player ?side=red page reloads as it is", () => {
    for (const token of [null, "1", "daily"]) {
      const p = page("https://example.com/bd/?side=red");
      reloadWithoutLink(p, token);
      expect(p.went).toEqual(["reload"]);
    }
  });

  it("a replay's link goes, and its side with it", () => {
    const p = page("https://example.com/bd/?replay=a.json&side=red");
    reloadWithoutLink(p);
    expect(p.went).toEqual(["https://example.com/bd/"]);
  });
});

// ---------------------------------------------------------------- relay ---

/** Two RelayTransports and a harness between them, on one manual clock: `latency` ms each way, `drop` loses packets. */
function relayPair(latency = 120, drop: (n: number) => boolean = () => false) {
  const c = clock(1000);
  const wa: RelayWindow = {};
  const wb: RelayWindow = {};
  const q: { at: number; to: RelayWindow; b64: string; nbits: number }[] = [];
  let n = 0;
  const out = (to: RelayWindow) => (b64: string, nbits: number) => {
    if (!drop(n++)) q.push({ at: c.t + latency, to, b64, nbits });
  };
  wa.__duelOut = out(wb);
  wb.__duelOut = out(wa);
  const a = new RelayTransport({ role: "host", win: wa, now: c.now, timers: null });
  const b = new RelayTransport({ role: "guest", win: wb, now: c.now, timers: null });
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i++) {
      c.t++;
      a.tick();
      b.tick();
      while (q.length && q[0]!.at <= c.t) {
        const p = q.shift()!;
        p.to.__duelIn?.(p.b64, p.nbits);
      }
    }
  };
  return { c, wa, wb, a, b, advance, sent: () => n };
}

/** A frame of `nbits` whose first two bits say its type (1 game, 2 lobby), the rest a pattern. */
function frame(type: 1 | 2, nbits: number, key = 0, fill = 0x5a) {
  const bits = new Uint8Array((nbits + 7) >> 3).fill(fill);
  bits[0] = (bits[0]! & 0x3f) | (type << 6);
  return { bits, nbits, key };
}

describe("RelayTransport", () => {
  it("sends a packet every 200 ms robust and 100 ms fast, whether or not the frame changed", () => {
    const r = relayPair();
    r.a.send([frame(2, 120)]);
    const gaps = (s: number[]) => s.slice(1).map((t, i) => t - s[i]!);
    r.advance(1000);
    const robust = r.a.slots();
    expect(robust.length).toBe(6);
    expect(gaps(robust).slice(1)).toEqual([200, 200, 200, 200]);
    r.a.setMode("fast");
    r.advance(1000);
    const fast = r.a.slots();
    expect(gaps(fast).slice(1).every((g) => g === 100)).toBe(true);
    expect(r.sent()).toBe(robust.length + fast.length);
    expect(r.b.stats()).toMatchObject({ locked: true, rxMode: "fast", snrDb: 30, ownSnrDb: null, plan: "high" });
  });

  it("carries frames whole, zero-padded to the packet, in key rotation", () => {
    const r = relayPair();
    r.a.send([frame(2, 100, 3, 0x11), frame(2, 150, 7, 0x22), frame(2, 9, 9, 0x33)]);
    r.advance(1400);
    const got = r.b.poll();
    expect(got.length).toBeGreaterThanOrEqual(6);
    const firstByte = got.map((p) => p.bits[1]);
    expect(firstByte.slice(0, 6)).toEqual([0x11, 0x22, 0x00, 0x11, 0x22, 0x00]);
    for (const p of got) {
      expect(p.nbits).toBe(188);
      expect(p.session).toBe(false);
    }
    // (the 9-bit frame: its bits past nbits are zero on the air)
    expect(got[2]!.bits[1]! & 0x7f).toBe(0);
  });

  it("emulates the session CRC: game frames pass only between ends keyed alike", () => {
    const r = relayPair();
    r.a.send([frame(1, 150)]);
    r.advance(1000);
    expect(r.b.poll()).toEqual([]); // (no key at either end: the modem drops a game frame under the default CRC)
    expect(r.b.stats().rxBad).toBeGreaterThan(0);
    r.b.setSessionKey(11, 22);
    r.a.setSessionKey(11, 99);
    r.advance(1000);
    expect(r.b.poll()).toEqual([]);
    r.a.setSessionKey(11, 22);
    r.advance(1000);
    const got = r.b.poll();
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((p) => p.session)).toBe(true);
    // lobby frames still go under the default CRC once keyed, with session false
    r.a.send([frame(2, 150)]);
    r.advance(500);
    r.b.poll();
    r.advance(1000);
    const lobby = r.b.poll();
    expect(lobby.length).toBeGreaterThan(0);
    expect(lobby.every((p) => !p.session)).toBe(true);
  });

  it("drops what isn't a packet, and says when there is no relay", () => {
    const r = relayPair();
    const bad = r.b.stats().rxBad;
    r.wb.__duelIn!("!!!", 40);
    r.wb.__duelIn!("AAAA", 40);
    r.wb.__duelIn!(encodeRelayPacket(frame(2, 40), 0xffff, "robust").slice(0, -4) + "AAAA", 40);
    expect(r.b.poll()).toEqual([]);
    expect(r.b.stats().rxBad).toBe(bad + 3);
    expect(decodeRelayPacket(encodeRelayPacket(frame(2, 40), 0xffff, "fast"), 40)?.mode).toBe("fast");
    expect(r.a.connected()).toBe(true);
    const lone = new RelayTransport({ role: "host", win: {}, now: r.c.now, timers: null });
    expect(lone.connected()).toBe(false);
    const w = r.wa;
    r.a.close();
    expect(w.__duelIn).toBeUndefined();
  });

  it("plays a duel: two sessions pair, and two AI worlds step in lockstep with the same hashes", { timeout: 60_000 }, () => {
    // (one packet in nine lost, as a harness with loss would)
    const r = relayPair(150, (n) => n % 9 === 4);
    const hashes: Map<number, string>[] = [new Map(), new Map()];
    const phones = [
      new LoopFriend({ transport: r.a, role: "host", build: BUILD, offer: OFFER, seed: 5, onStep: (t, w) => hashes[0]!.set(t, worldHash(w)) }),
      new LoopFriend({ transport: r.b, role: "guest", build: BUILD, seed: 6, onStep: (t, w) => hashes[1]!.set(t, worldHash(w)) })
    ];
    const TICKS = 300;
    for (let i = 0; i < 120_000 && phones.some((p) => (p.world?.tick ?? 0) < TICKS); i += 10) {
      r.advance(10);
      for (const p of phones) p.update();
    }
    expect(phones.map((p) => p.world?.tick ?? 0).every((t) => t >= TICKS)).toBe(true);
    for (let t = 0; t < TICKS; t++) expect(hashes[1]!.get(t), `tick ${t}`).toBe(hashes[0]!.get(t));
    for (const p of phones) expect(p.session.lockstep!.status().desync).toBe(false);
    expect(phones[0]!.side).not.toBe(phones[1]!.side);
  });
});

// ----------------------------------------------------------------- loop ---

/** The page's end of a LoopLink played by an AI too (a LoopFriend on loop.page): both worlds' hashes per tick. */
function loopDuel(params: { delay: number | null; loss: number; latencyMs: number }, ticks: number, role: BandRole = "host") {
  const c = clock();
  const hashes: Map<number, string>[] = [new Map(), new Map()];
  const offer = { ...OFFER, hostSide: "red" as const };
  const loop = new LoopLink({ params, role, offer, build: BUILD, seed: 42, now: c.now, timers: null });
  const page = new LoopFriend({ transport: loop.page, role, build: BUILD, offer, seed: 9, onStep: (t, w) => hashes[0]!.set(t, worldHash(w)) });
  // (the friend's own steps, through its world)
  let friendTick = -1;
  const friendHash = () => {
    const w: World | null = loop.friend.world;
    if (w && w.tick - 1 > friendTick) {
      friendTick = w.tick - 1;
      hashes[1]!.set(friendTick, worldHash(w));
    }
  };
  for (let i = 0; i < 200_000 && ((page.world?.tick ?? 0) < ticks || (loop.friend.world?.tick ?? 0) < ticks); i += 5) {
    c.t += 5;
    loop.pump();
    friendHash();
    page.update();
  }
  return { loop, page, hashes };
}

describe("the loop's in-page friend", () => {
  it("pairs over PacketAir and plays N ticks with identical hashes, D from the latency", { timeout: 60_000 }, () => {
    const { loop, page, hashes } = loopDuel({ delay: null, loss: 0, latencyMs: 250 }, 400);
    const r = page.session.result()!;
    expect(r.fast).toBe(true);
    expect(r.delay).toBe(delayFor(500, packetMs("high", "fast")));
    expect(r.local).toBe("red"); // (the host's side, as offered)
    expect(loop.friend.side).toBe("blue");
    let compared = 0;
    for (const [t, h] of hashes[1]!) {
      const mine = hashes[0]!.get(t);
      if (mine === undefined) continue;
      expect(mine, `tick ${t}`).toBe(h);
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
    expect(page.session.lockstep!.status().desync).toBe(false);
    expect(loop.friend.session.lockstep!.status().desync).toBe(false);
    loop.close();
  });

  it("forces the input delay through the lobby's round trip, then plays at the latency asked", { timeout: 60_000 }, () => {
    for (const [delay, latencyMs] of [[3, 250], [7, 100], [5, 0]] as const) {
      const { loop, page } = loopDuel({ delay, loss: 0, latencyMs }, 60, "guest");
      expect(page.session.result()!.delay, `D ${delay} at ${latencyMs} ms`).toBe(delay);
      expect(loop.friend.session.result()!.delay).toBe(delay);
      expect(page.session.lockstep!.status().desync).toBe(false);
      loop.close();
    }
    // (the middle of each D's 100 ms: the hold's 10 ms rounding can't tip it either way)
    for (let d = 3; d <= 8; d++)
      for (const err of [-10, 0, 10]) expect(delayFor(2 * lobbyLatencyFor(d) + err, packetMs("high", "fast"))).toBe(d);
  });

  it("holds received packets in order when the hold drops at GO", () => {
    const air = new PacketAir({ latencyMs: 0, phaseMs: [0, 50], mode: "fast" });
    const held = new HeldEnd(air.a, 300, 0);
    air.b.send([frame(2, 40)]);
    air.advance(250);
    expect(held.poll()).toEqual([]);
    held.setSessionKey(1, 2);
    air.advance(100);
    const got = held.poll();
    const at = got.map((p) => p.at);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect(got.length).toBeGreaterThan(0);
    expect(at.every((x) => x <= held.now())).toBe(true);
  });
});

// ---------------------------------------------------------- the machine ---

/** A link end the test can make deaf. */
class Probe implements LobbyLink {
  /** Everything from the friend is lost while set. */
  deaf = false;
  constructor(readonly inner: LinkTransport) {}
  capacity = () => this.inner.capacity();
  send: LinkTransport["send"] = (f) => this.inner.send(f);
  poll = () => {
    const got = this.inner.poll();
    return this.deaf ? [] : got;
  };
  slots = () => this.inner.slots();
  now = () => this.inner.now();
  setMode: LinkTransport["setMode"] = (m) => this.inner.setMode(m);
  setSessionKey = (h: number, g: number) => this.inner.setSessionKey(h, g);
  stats = (): LinkStats => this.inner.stats();
  close = () => this.inner.close();
}

interface Bench {
  c: { t: number; now: () => number };
  m: LobbyMachine;
  env: LobbyEnv;
  ended: LobbyEnd[];
  begun: Session[];
  links: { cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" }; loop: LoopLink; probe: Probe }[];
  /** Run the clock, the loop and the machine forward. */
  run(ms: number, until?: () => boolean): Promise<void>;
}

/** The machine whose links are LoopLinks: a friend on the other end, all on one manual clock. */
function bench(o: { practice?: "loop" | "relay" | null; rematch?: DuelRematch | null; seat?: BandRole | null; friend?: boolean; latencyMs?: number; friendBuild?: number } = {}): Bench {
  const c = clock();
  const ended: LobbyEnd[] = [];
  const begun: Session[] = [];
  const links: Bench["links"] = [];
  let seed = 100;
  const env: LobbyEnv = {
    now: c.now,
    build: BUILD,
    random: (() => {
      let i = 1;
      return () => ((i++ * 0.6180339887) % 1);
    })(),
    practice: o.practice === undefined ? "loop" : o.practice,
    link: async (cfg, offer) => {
      const loop = new LoopLink({ params: { delay: null, loss: 0, latencyMs: o.latencyMs ?? 250 }, role: cfg.tx, offer, build: o.friendBuild ?? BUILD, seed: seed++, now: c.now, timers: null });
      if (o.friend === false) loop.friend.close();
      const probe = new Probe(loop.page);
      links.push({ cfg, loop, probe });
      return probe;
    },
    offer: { map: "riverlands", mutators: [], hostSide: "blue" },
    rematch: o.rematch ?? null,
    seat: o.seat ?? null,
    begin: (s) => void begun.push(s),
    released: (why) => void ended.push(why)
  };
  const m = new LobbyMachine(env);
  const b: Bench = {
    c, m, env, ended, begun, links,
    run: async (ms, until) => {
      for (let i = 0; i < ms; i += 10) {
        c.t += 10;
        for (const l of links) l.loop.pump();
        m.update();
        if (i % 200 === 0) await flush();
        if (until?.()) return;
      }
    }
  };
  return b;
}

describe("the lobby's logic", () => {
  it("goes to the match: Host, the cards, GO", { timeout: 30_000 }, async () => {
    const b = bench();
    expect(b.m.state().step).toBe("choose");
    b.m.host();
    expect(b.m.state().step).toBe("connecting");
    await flush();
    expect(b.m.state().step).toBe("pairing");
    expect(b.links[0]!.cfg).toEqual({ plan: "high", tx: "host", rx: "guest" });
    await b.run(20_000, () => b.m.state().step === "picking");
    const v = b.m.state();
    expect(v.step).toBe("picking");
    expect(v.pairing!.offered.length).toBeGreaterThan(0);
    expect(Math.abs(v.meter!.rttMs! - 500)).toBeLessThanOrEqual(10);
    expect(v.canBack).toBe(true);
    expect(b.m.pick(v.pairing!.offered[0]!)).toBe(true);
    await b.run(20_000, () => b.m.state().step === "loading");
    await b.run(2000, () => b.m.state().step === "started");
    expect(b.m.state().step).toBe("started");
    expect(b.begun.length).toBe(1);
    expect(b.begun[0]!.phase).toBe("starting");
    expect(b.m.done).toBe(true);
    expect(b.ended).toEqual([]);
  });

  it("a Join; Back and Cancel before GO close at once", { timeout: 30_000 }, async () => {
    const b = bench();
    await flush();
    b.m.join();
    await flush();
    expect(b.links[0]!.cfg).toEqual({ plan: "high", tx: "guest", rx: "host" });
    await b.run(3000);
    b.m.back();
    expect(b.m.state().step).toBe("choose");
    expect(b.ended).toEqual([]);
    b.m.cancel();
    expect(b.m.state().step).toBe("closed");
    expect(b.ended).toEqual(["cancel"]);
  });

  it("Cancel after GO says the end for 2 s before letting go", { timeout: 30_000 }, async () => {
    const b = bench();
    await flush();
    b.m.host();
    await flush();
    await b.run(20_000, () => b.m.state().step === "picking");
    // (this page's GO, and nothing more heard of the friend: it waits there, the match not started)
    await b.run(20_000, () => b.m.state().pairing?.peerPicked === true);
    b.links[0]!.probe.deaf = true;
    b.m.pick(b.m.state().pairing!.offered[0]!);
    await b.run(5000, () => b.m.state().step === "go");
    b.m.cancel();
    expect(b.m.state().step).toBe("closed");
    expect(b.ended).toEqual([]);
    await b.run(1500);
    expect(b.ended).toEqual([]);
    await b.run(1000);
    expect(b.ended).toEqual(["cancel"]);
  });







  it("with nothing heard: the role switch at 8 s, tips at 30 s", { timeout: 30_000 }, async () => {
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    await b.run(NOTHING_HEARD_MS - 500);
    expect(b.m.state().switchRole).toBe(false);
    await b.run(1000);
    expect(b.m.state().switchRole).toBe(true);
    expect(b.m.state().tips).toBe(false);
    await b.run(TIPS_MS - NOTHING_HEARD_MS);
    expect(b.m.state().tips).toBe(true);
    b.m.switchRole();
    await flush();
    expect(b.m.state()).toMatchObject({ step: "pairing", role: "guest", switchRole: false, tips: false });
    expect(b.links[1]!.cfg.tx).toBe("guest");
  });


  it("a rematch pairs at once in its role, and falls back to the menu after 60 s with nothing heard", { timeout: 30_000 }, async () => {
    const rematch: DuelRematch = { role: "guest", hostSide: "red", mapId: "riverlands", mutators: [] };
    const b = bench({ rematch, friend: false });
    await flush();
    await flush();
    expect(b.m.state()).toMatchObject({ step: "pairing", role: "guest", rematch: true, fixedRole: true, canBack: false });
    expect(b.links[0]!.cfg).toEqual({ plan: "high", tx: "guest", rx: "host" });
    await b.run(30_000);
    expect(b.m.state().switchRole).toBe(false);
    expect(b.ended).toEqual([]);
    await b.run(REMATCH_FALLBACK_MS - 30_000 + 100);
    expect(b.ended).toEqual(["fallback"]);
  });

  it("a retry starts the rematch's 60 s and the tips' 30 s again", { timeout: 30_000 }, async () => {
    const rematch: DuelRematch = { role: "host", hostSide: "red", mapId: "riverlands", mutators: [] };
    const b = bench({ rematch });
    await flush();
    await flush();
    await b.run(20_000, () => b.m.state().pairing?.heard === true);
    // the friend goes after it was heard: no fallback while the pairing has heard it
    b.links[0]!.loop.friend.close();
    await b.run(REMATCH_FALLBACK_MS + 1000);
    expect(b.ended).toEqual([]);
    b.m.retry();
    await b.run(1000);
    expect(b.ended).toEqual([]);
    expect(b.m.state()).toMatchObject({ step: "pairing", tips: false });
    await b.run(TIPS_MS);
    expect(b.m.state().tips).toBe(true);
    expect(b.ended).toEqual([]);
    await b.run(REMATCH_FALLBACK_MS - TIPS_MS);
    expect(b.ended).toEqual(["fallback"]);
  });

  it("a friend that left while this phone waits at GO is reported, and Close lets go at once", { timeout: 30_000 }, async () => {
    const b = bench();
    await flush();
    b.m.host();
    await flush();
    const { loop, probe } = b.links[0]!;
    await b.run(20_000, () => b.m.state().pairing?.peerPicked === true);
    b.m.pick(b.m.state().pairing!.offered[0]!);
    await b.run(5000, () => b.m.state().step === "go");
    expect(b.m.state().step).toBe("go");
    // this phone hears nothing of the friend, which hears its GO and starts …
    probe.deaf = true;
    await b.run(3000);
    expect(loop.friend.session.phase).toBe("match");
    // … then leaves; its end reaches this phone, which never heard its GO
    loop.friend.session.leave("left");
    await b.run(600);
    probe.deaf = false;
    await b.run(3000, () => b.m.state().step === "error");
    const v = b.m.state();
    expect(v).toMatchObject({ step: "error", error: { kind: "left", message: "Ton ami est parti" }, canBack: false });
    expect(b.begun).toEqual([]);
    b.m.cancel();
    expect(b.ended).toEqual(["cancel"]);
  });

  it("a friend that goes quiet after this phone's GO: a line says so", { timeout: 30_000 }, async () => {
    const b = bench();
    await flush();
    b.m.host();
    await flush();
    const { loop } = b.links[0]!;
    await b.run(20_000, () => b.m.state().pairing?.peerPicked === true);
    b.m.pick(b.m.state().pairing!.offered[0]!);
    await b.run(5000, () => b.m.state().step === "go");
    // (the friend leaves before it hears this phone's pick: its leave has nothing to say)
    loop.friend.session.leave("left");
    loop.friend.close();
    const fresh = b.m.state();
    await b.run(QUIET_MS - 1000);
    expect(fresh.quiet).toBe(false);
    expect(b.m.state().quiet).toBe(false);
    await b.run(2000);
    const v = b.m.state();
    expect(v).toMatchObject({ step: "go", quiet: true, error: null });
    await b.run(60_000);
    expect(b.m.state()).toMatchObject({ step: "go", quiet: true });
    expect(b.ended).toEqual([]);
  });

  it("a rematch host offers the stored map, mutators and side", { timeout: 30_000 }, async () => {
    const rematch: DuelRematch = { role: "host", hostSide: "red", mapId: "random-arctic-77", mutators: [] };
    const b = bench({ rematch });
    await flush();
    await flush();
    await b.run(20_000, () => b.m.state().step === "picking");
    const p = b.m.state().pairing!;
    expect(p.config).toMatchObject({ mapId: "random-arctic-77", hostSide: "red" });
    expect(p.side).toBe("red");
  });

  it("a practice link: a seat pairs at once, and the loop names its input delay", { timeout: 30_000 }, async () => {
    const b = bench({ seat: "host" });
    expect(b.m.state().step).toBe("connecting");
    await flush();
    expect(b.m.state()).toMatchObject({ step: "pairing", role: "host", practice: "loop", fixedRole: true });
    expect(rttLine(b.m.state())).toBe("Liaison d'entraînement");
    await b.run(20_000, () => b.m.state().step === "picking");
    // (the loop's round trip is its friend's hold: the paired view names the input delay agreed instead)
    expect(b.m.state().meter!.rttMs).not.toBeNull();
    expect(rttLine(b.m.state())).toBe(`Liaison d'entraînement · délai d'entrée ${b.m.state().pairing!.config!.delay * 100} ms`);
    b.m.pick(b.m.state().pairing!.offered[0]!);
    await b.run(20_000, () => b.m.state().step === "started");
    expect(b.begun.length).toBe(1);
  });

  it("pages of different versions stop at the version error, and Close closes", { timeout: 30_000 }, async () => {
    const b = bench({ friendBuild: BUILD ^ 1 });
    await flush();
    b.m.join();
    await flush();
    await b.run(10_000, () => b.m.state().step === "error");
    expect(b.m.state()).toMatchObject({ step: "error", error: { kind: "version", message: "Ces téléphones n'ont pas la même version : recharge les deux" }, canBack: false });
    expect(b.ended).toEqual([]);
    b.m.cancel();
    expect(b.ended).toEqual(["cancel"]);
  });

  it("a link that can't be made is an error: no relay", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = bench();
    b.env.link = async () => {
      const e = new Error("Relay not connected");
      e.name = "RelayError";
      throw e;
    };
    b.m.host();
    await flush();
    expect(b.m.state()).toMatchObject({ step: "error", error: { kind: "relay", message: "Relay not connected" } });
    expect(b.ended).toEqual(["error"]);
  });
});

describe("the lobby's nations (LOBBY_PROTO 2)", () => {
  it("names the openers in each side's nation", () => {
    const rep = openerGives("blitz", lobbyWords("republique", "empire")).split(" · ");
    expect(rep.slice(1)).toEqual(["3 Jamais-Contente", expect.stringMatching(/^2 Fourgons/), "−100 charbon"]);
    expect(rep[0]).not.toBe(openerGives("blitz").split(" · ")[0]); // (the République's Garage, not the Forges)
    expect(openerGives("blitz", lobbyWords("empire"))).toBe(openerGives("blitz"));
    expect(openerGives("airwing", lobbyWords("empire"))).toMatch(/Gyroptère/);
  });

  it("offers the three choices, the one picked pressed, none in a rematch", () => {
    const html = nationPicker({ nation: "empire", rematch: false, isOnline: true });
    expect(html.match(/data-act="nation"/g)).toHaveLength(3);
    expect(html).toMatch(/nat-empire on"/);
    expect(nationPicker({ nation: "empire", rematch: true, isOnline: true })).toBe("");
  });

  it("says who plays what once paired", () => {
    const c = { mapId: "riverlands", mutators: [], delay: 4, hostSide: "red" as const, fast: true, nations: { host: "republique" as const, guest: "empire" as const } };
    expect(nationsLine(c, "blue")).toMatch(/Toi : <b>Empire<\/b>.*Ton ami : <b>République<\/b>/);
    expect(nationsLine(c, "red")).toMatch(/Toi : <b>République<\/b>/);
    expect(nationsLine({ ...c, nations: undefined }, "red")).toMatch(/Classique/);
  });
});
