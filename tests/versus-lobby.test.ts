import { describe, expect, it, vi } from "vitest";

// (the lobby builds the VersusFeed only once a match starts: its game code stays out of these tests)
vi.mock("../src/versus/feed", () => ({ VersusFeed: class {} }));

import type { ModemStats } from "../src/link/modem/core";
import { RIG_MESSAGES, RigError, RigLink, type MicMode } from "../src/link/rig";
import { WorkletTransport } from "../src/link/worklet-transport";
import type { FromWorklet } from "../src/link/worklet-protocol";
import { PacketAir } from "../src/link/packet-air";
import type { BandPlan, BandRole, LinkStats, LinkTransport } from "../src/link/transport";
import { worldHash } from "../src/sim/checksum";
import { PLURALS } from "../src/sim/lexicon";
import type { World } from "../src/sim/types";
import {
  GAIN_MIN, GAIN_QUIET_MS, GAIN_RISE, GAIN_RISE_MS, GAIN_START, GAIN_STEP, GAIN_STEP_MS, LOUD_MS, LOUD_OWN_SNR_DB, LobbyMachine, QUIET_MS, REMATCH_FALLBACK_MS,
  ROUTE_GRACE_MS, ROUTE_MS, ROUTE_SNR_DB, TIPS_MS, openerGives, parseDuelParams, parsePrefs, parseRematch, routeText, rttLine, tipsText, type DuelRematch,
  type LobbyEnd, type LobbyEnv, type LobbyLink, type LobbyRig
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

/** A stats report from the modem (the worklet's {t:"stats"}). */
const modemStats = (o: Partial<ModemStats> = {}): ModemStats => ({
  sample: 0, locked: false, plan: "high", rxMode: null, txMode: "robust", snrDb: null, rxOk: 0, rxBad: 0, syncs: 0, clockPpm: null, txPackets: 0,
  ownSnrDb: null, loopbackMs: 40, clips: 0, inputPeak: 0.1, ...o
});

/** A manual clock. */
function clock(t0 = 0) {
  const c = { t: t0, now: () => c.t };
  return c;
}

// ------------------------------------------------------- URL parameters ---

describe("the dev modes' URL parameters", () => {
  it("clamps delay, loss and latency, and reads the seat and side", () => {
    expect(parseDuelParams("")).toEqual({ mode: "sound", seat: null, loop: { delay: null, loss: 0, latencyMs: 250 }, side: "blue" });
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
    expect(parseDuelParams("?duel=sound&side=green")).toMatchObject({ mode: "sound", side: "blue" });
  });

  it("keeps the lobby's settings, defaulting what doesn't read", () => {
    expect(parsePrefs(null)).toEqual({ plan: "high", micMode: "raw" });
    expect(parsePrefs('{"plan":"low","micMode":"ec"}')).toEqual({ plan: "low", micMode: "ec" });
    expect(parsePrefs('{"plan":"mid","micMode":7}')).toEqual({ plan: "high", micMode: "raw" });
    expect(parsePrefs("{nope")).toEqual({ plan: "high", micMode: "raw" });
  });
});

describe("the rematch a report stored", () => {
  const good: DuelRematch = { role: "guest", plan: "low", micMode: "ec", hostSide: "red", mapId: "riverlands", mutators: [] };

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
    expect(parseRematch(JSON.stringify({ ...good, plan: "mid" }))).toBeNull();
    expect(parseRematch(JSON.stringify({ ...good, hostSide: "green" }))).toBeNull();
    expect(parseRematch(JSON.stringify({ ...good, mapId: "atlantis" }))).toBeNull();
    // (a mic mode it can't read is the default one)
    expect(parseRematch(JSON.stringify({ ...good, micMode: "loud" }))?.micMode).toBe("raw");
  });
});

describe("the lobby's words", () => {
  it("the 30 s tips: Advanced only where it is offered, and no sound advice on a practice link", () => {
    const sound = tipsText({ practice: null, rematch: false });
    expect(sound).toMatch(/monte le volume/i);
    expect(sound).toMatch(/bande Basse sur l'hôte \(Avancé\)/);
    // (a rematch keeps its band, and has no Advanced)
    const rematch = tipsText({ practice: null, rematch: true });
    expect(rematch).toMatch(/monte le volume/i);
    expect(rematch).not.toMatch(/Avancé|bande Basse/);
    for (const practice of ["loop", "relay"] as const)
      for (const r of [false, true]) expect(tipsText({ practice, rematch: r })).not.toMatch(/volume|silencieux|Bluetooth|Avancé|écouteurs/i);
  });

  it("the route warning: band Low only where it can be taken", () => {
    const view = (rematch: boolean, role: BandRole | null, plan: BandPlan) => ({ rematch, role, prefs: { plan, micMode: "raw" as const } });
    expect(routeText(view(false, "host", "high"))).toMatch(/ou passe l'hôte en bande Basse\.$/);
    expect(routeText(view(false, "guest", "high"))).toMatch(/bande Basse/);
    // (a guest can't tell the host's plan from its prefs: the advice stays)
    expect(routeText(view(false, "guest", "low"))).toMatch(/bande Basse/);
    // a rematch keeps its band and has no Advanced; a host on band Low is there already
    for (const v of [view(true, "host", "high"), view(true, "guest", "high"), view(false, "host", "low")]) {
      expect(routeText(v)).not.toMatch(/bande Basse|Avancé/);
      expect(routeText(v)).toMatch(/n'entend pas son propre signal : .* Débranche les écouteurs ou monte le volume\.$/);
    }
  });

  it("the meter's round trip, and on the loop the input delay instead", () => {
    const pairing = (delay: number | null) => ({ config: delay === null ? null : { delay } }) as unknown as NonNullable<Parameters<typeof rttLine>[0]["pairing"]>;
    const meter = (rttMs: number | null) => ({ snrDb: null, good: 0, bad: 0, rxq: 0, peerRxq: null, rttMs });
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

interface FakeRig extends LobbyRig {
  cap: number;
  closed: boolean;
  st: string;
}

function fakeRig(ready: Promise<"running" | "tap-to-start"> = Promise.resolve("running")): FakeRig {
  const rig = {
    cap: 0,
    closed: false,
    st: "running",
    get state() {
      return rig.st as LobbyRig["state"];
    },
    ready,
    wakeLockSupported: true,
    captureOkMs: () => rig.cap,
    reconnect: async () => {
      rig.st = "running";
      return true;
    },
    setMicMode: async () => undefined,
    close: () => void (rig.closed = true),
    rateProblem: () => null
  };
  ready.catch(() => undefined);
  return rig;
}

/** A link end with an own-signal SNR and a microphone peak the test sets. */
class Probe implements LobbyLink {
  own: number | null = 40;
  peak = 0;
  sample = 0;
  gains: number[] = [];
  /** Everything from the friend is lost while set. */
  deaf = false;
  /** The modem stopped: no report speaks for it (WorkletTransport's stats go stale at once). */
  dead = false;
  onError: ((message: string) => void) | null = null;
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
  stats = (): LinkStats => ({ ...this.inner.stats(), ownSnrDb: this.own });
  close = () => this.inner.close();
  setGain = (g: number) => void this.gains.push(g);
  modemStats = () => (this.dead ? null : ({ sample: this.sample, inputPeak: this.peak } as ReturnType<NonNullable<LobbyLink["modemStats"]>>));
}

interface Bench {
  c: { t: number; now: () => number };
  m: LobbyMachine;
  env: LobbyEnv;
  rig: FakeRig | null;
  guards: (BandPlan | null)[];
  ended: LobbyEnd[];
  begun: Session[];
  links: { cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" }; loop: LoopLink; probe: Probe }[];
  /** Run the clock, the loop and the machine forward. */
  run(ms: number, until?: () => boolean): Promise<void>;
}

/** The machine with a fake rig (or none) whose links are LoopLinks: a friend on the other end, all on one manual clock. */
function bench(o: { rig?: FakeRig | null; rematch?: DuelRematch | null; seat?: BandRole | null; friend?: boolean; latencyMs?: number; friendBuild?: number } = {}): Bench {
  const c = clock();
  const guards: (BandPlan | null)[] = [];
  const ended: LobbyEnd[] = [];
  const begun: Session[] = [];
  const links: Bench["links"] = [];
  const rig = o.rig === undefined ? fakeRig() : o.rig;
  let seed = 100;
  const env: LobbyEnv = {
    now: c.now,
    build: BUILD,
    random: (() => {
      let i = 1;
      return () => ((i++ * 0.6180339887) % 1);
    })(),
    rig,
    practice: rig ? null : "loop",
    link: async (cfg, offer) => {
      const loop = new LoopLink({ params: { delay: null, loss: 0, latencyMs: o.latencyMs ?? 250 }, role: cfg.tx, offer, build: o.friendBuild ?? BUILD, seed: seed++, now: c.now, timers: null });
      if (o.friend === false) loop.friend.close();
      const probe = new Probe(loop.page);
      links.push({ cfg, loop, probe });
      return probe;
    },
    guard: (plan) => void guards.push(plan),
    offer: { map: "riverlands", mutators: [], hostSide: "blue" },
    rematch: o.rematch ?? null,
    seat: o.seat ?? null,
    prefs: { plan: "high", micMode: "raw" as MicMode },
    savePrefs: () => undefined,
    begin: (s) => void begun.push(s),
    released: (why) => void ended.push(why)
  };
  const m = new LobbyMachine(env);
  const b: Bench = {
    c, m, env, rig, guards, ended, begun, links,
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
  it("goes from the rig to the match: Host, the cards, GO, then steady capture", { timeout: 30_000 }, async () => {
    const b = bench();
    expect(b.m.state().step).toBe("opening");
    await flush();
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
    expect(v.meter).toMatchObject({ good: expect.any(Number), rxq: 7, peerRxq: 7 });
    expect(Math.abs(v.meter!.rttMs! - 500)).toBeLessThanOrEqual(10);
    expect(v.canBack).toBe(true);
    expect(b.m.pick(v.pairing!.offered[0]!)).toBe(true);
    await b.run(20_000, () => b.m.state().step === "loading");
    expect(b.m.state().step).toBe("loading");
    // waits for 1.5 s of gap-free capture
    await b.run(2000);
    expect(b.begun).toEqual([]);
    b.rig!.cap = 1500;
    await b.run(100);
    expect(b.m.state().step).toBe("started");
    expect(b.begun.length).toBe(1);
    expect(b.begun[0]!.phase).toBe("starting");
    expect(b.m.done).toBe(true);
    // the guard goes on the host's plan with the link, and stays on through the match, the rig open
    expect(b.guards).toEqual(["high"]);
    expect(b.rig!.closed).toBe(false);
    expect(b.ended).toEqual([]);
    // the match's modem is the feed's: the lobby only logs what it says
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const probe = b.links[0]!.probe;
    probe.dead = true;
    probe.onError!("the modem stopped: boom");
    expect(warn).toHaveBeenCalledWith("sound link:", "the modem stopped: boom");
    expect(b.m.state().step).toBe("started");
    expect(b.rig!.closed).toBe(false);
    expect(b.ended).toEqual([]);
    warn.mockRestore();
  });

  it("a Join detects the plan; Back and Cancel before GO let the audio go at once", { timeout: 30_000 }, async () => {
    const b = bench();
    await flush();
    b.m.join();
    await flush();
    expect(b.links[0]!.cfg).toEqual({ plan: "high", tx: "guest", rx: "detect" });
    await b.run(3000);
    b.m.back();
    expect(b.m.state().step).toBe("choose");
    expect(b.ended).toEqual([]);
    b.m.cancel();
    expect(b.m.state().step).toBe("closed");
    expect(b.ended).toEqual(["cancel"]);
    expect(b.rig!.closed).toBe(true);
    // (a Join's link keeps the tap's guard until it locks, then off)
    expect(b.guards).toEqual(["high", null]);
  });

  it("Cancel after GO says the end for 2 s before letting go", { timeout: 30_000 }, async () => {
    const b = bench();
    await flush();
    b.m.host();
    await flush();
    await b.run(20_000, () => b.m.state().step === "picking");
    b.m.pick(b.m.state().pairing!.offered[0]!);
    await b.run(20_000, () => b.m.state().step === "loading");
    b.m.cancel();
    expect(b.m.state().step).toBe("closed");
    expect(b.ended).toEqual([]);
    await b.run(1500);
    expect(b.ended).toEqual([]);
    await b.run(1000);
    expect(b.ended).toEqual(["cancel"]);
    expect(b.rig!.closed).toBe(true);
  });

  it("a RigError lets the audio go at once and keeps its message up", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = bench({ rig: fakeRig(Promise.reject(new RigError("mic-refused"))) });
    await flush();
    await flush();
    const v = b.m.state();
    expect(v.step).toBe("error");
    expect(v.error).toMatchObject({ kind: "rig", reason: "mic-refused", message: RIG_MESSAGES["mic-refused"] });
    expect(b.ended).toEqual(["error"]);
    expect(b.guards).toEqual([null]);
    expect(b.m.done).toBe(true);
  });

  it("a modem that stops is an error that lets the audio go, not the route warning; one that refused a message runs on", { timeout: 30_000 }, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    const probe = b.links[0]!.probe;
    expect(probe.onError).toBeInstanceOf(Function);
    await b.run(3000);
    probe.onError!("a list of 0 payloads (1 to 8)");
    expect(warn).toHaveBeenCalledWith("sound link:", "a list of 0 payloads (1 to 8)");
    await b.run(100);
    expect(b.m.state()).toMatchObject({ step: "pairing", error: null });
    expect(b.ended).toEqual([]);
    // it stops: nothing it reported holds, and it never hears its own signal again
    probe.dead = true;
    probe.own = null;
    probe.onError!("the modem stopped: boom");
    const v = b.m.state();
    expect(v.step).toBe("error");
    expect(v.error).toEqual({ kind: "modem", message: "the modem stopped: boom" });
    expect(b.ended).toEqual(["error"]);
    expect(b.rig!.closed).toBe(true);
    expect(b.guards).toEqual(["high", null]);
    expect(b.m.done).toBe(true);
    await b.run(ROUTE_GRACE_MS + ROUTE_MS + 1000);
    expect(b.m.state()).toMatchObject({ step: "error", route: false, error: { kind: "modem" } });
    // a link the lobby let go (Back) says nothing to it either
    const c = bench({ friend: false });
    await flush();
    c.m.host();
    await flush();
    const old = c.links[0]!.probe;
    c.m.back();
    old.dead = true;
    old.onError!("the modem stopped: boom");
    expect(c.m.state()).toMatchObject({ step: "choose", error: null });
    warn.mockRestore();
  });

  it("the modem's error reaches the lobby through the rig's link: the worklet's fatal error, or the processor failing", { timeout: 30_000 }, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const way of ["error", "processorerror"] as const) {
      const c = clock();
      const port = { onmessage: null as ((e: { data: FromWorklet }) => void) | null, postMessage: () => undefined };
      const node = { port, onprocessorerror: null as (() => void) | null, connect: () => undefined, disconnect: () => undefined };
      const ctx = { sampleRate: 48000, currentTime: 0, state: "running", destination: {} };
      let link: RigLink | null = null;
      const ended: LobbyEnd[] = [];
      const rig = fakeRig();
      const m = new LobbyMachine({
        now: c.now, build: BUILD, random: () => 0.5, rig, practice: null, rematch: null, seat: null,
        prefs: { plan: "high", micMode: "raw" }, savePrefs: () => undefined, offer: OFFER, guard: () => undefined,
        begin: () => undefined, released: (why) => void ended.push(why),
        link: async (cfg) => {
          const full = { ...cfg, sampleRate: 48000 };
          const t = new WorkletTransport(ctx as unknown as BaseAudioContext, full, { clock: c.now, createNode: () => node as unknown as AudioWorkletNode });
          return (link = new RigLink(t, full));
        }
      });
      await flush();
      m.host();
      await flush();
      // the modem reports, hearing its own signal well: no route warning
      let sample = 0;
      const report = () => port.onmessage?.({ data: { t: "stats", ...modemStats({ sample: (sample += 12000), ownSnrDb: 35 }) } });
      for (let i = 0; i < 400; i++) {
        c.t += 10;
        if (i % 25 === 0) report();
        m.update();
      }
      expect(m.state()).toMatchObject({ step: "pairing", route: false, error: null });
      if (way === "error") port.onmessage?.({ data: { t: "error", message: "the modem stopped: boom", fatal: true } });
      else node.onprocessorerror?.();
      expect(m.state().error).toEqual({ kind: "modem", message: way === "error" ? "the modem stopped: boom" : "le processeur audio de la liaison sonore a échoué" });
      expect(ended).toEqual(["error"]);
      expect(rig.closed).toBe(true);
      expect(link!.isClosed).toBe(true);
    }
    warn.mockRestore();
  });

  it("a message the modem refused before its first stats report is no reason to end the lobby: only a stopped modem is", { timeout: 30_000 }, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = clock();
    const port = { onmessage: null as ((e: { data: FromWorklet }) => void) | null, postMessage: () => undefined };
    const node = { port, onprocessorerror: null as (() => void) | null, connect: () => undefined, disconnect: () => undefined };
    const ctx = { sampleRate: 48000, currentTime: 0, state: "running", destination: {} };
    let link: RigLink | null = null;
    const ended: LobbyEnd[] = [];
    const rig = fakeRig();
    const m = new LobbyMachine({
      now: c.now, build: BUILD, random: () => 0.5, rig, practice: null, rematch: null, seat: null,
      prefs: { plan: "high", micMode: "raw" }, savePrefs: () => undefined, offer: OFFER, guard: () => undefined,
      begin: () => undefined, released: (why) => void ended.push(why),
      link: async (cfg) => {
        const full = { ...cfg, sampleRate: 48000 };
        const t = new WorkletTransport(ctx as unknown as BaseAudioContext, full, { clock: c.now, createNode: () => node as unknown as AudioWorkletNode });
        return (link = new RigLink(t, full));
      }
    });
    await flush();
    m.host();
    await flush();
    // no stats report yet (modemStats() is null), and the worklet refuses a message: the modem runs on
    expect(link!.modemStats()).toBeNull();
    port.onmessage?.({ data: { t: "error", message: "a list of 0 payloads (1 to 8)", fatal: false } });
    expect(link!.stopped).toBe(false);
    expect(m.state()).toMatchObject({ step: "pairing", error: null });
    expect(ended).toEqual([]);
    expect(warn).toHaveBeenCalledWith("sound link:", "a list of 0 payloads (1 to 8)");
    // then it stops: that ends the lobby
    port.onmessage?.({ data: { t: "error", message: "the modem stopped: boom", fatal: true } });
    expect(link!.stopped).toBe(true);
    expect(m.state().error).toEqual({ kind: "modem", message: "the modem stopped: boom" });
    expect(ended).toEqual(["error"]);
    warn.mockRestore();
  });

  it("a microphone mode switch leaves the guard as it is: its cut is the same in both modes, on every phone", async () => {
    const b = bench();
    await flush();
    const switched: MicMode[] = [];
    b.rig!.setMicMode = async (mode) => void switched.push(mode);
    b.m.setMicMode("ec");
    b.m.setMicMode("raw");
    expect(switched).toEqual(["ec", "raw"]);
    expect(b.guards).toEqual([]);
    b.m.host();
    await flush();
    expect(b.guards).toEqual(["high"]);
  });

  it("waits for a tap while the context isn't running, and moves on when it starts by itself", async () => {
    const rig = fakeRig(Promise.resolve("tap-to-start"));
    rig.st = "tap-to-start";
    const b = bench({ rig });
    await flush();
    expect(b.m.state().step).toBe("tap-to-start");
    await b.run(500);
    expect(b.m.state().step).toBe("tap-to-start");
    rig.st = "running";
    await b.run(20);
    expect(b.m.state().step).toBe("choose");
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

  it("the route check: the own signal under 10 dB for 3 s, or none after the first superframe", { timeout: 30_000 }, async () => {
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    const probe = b.links[0]!.probe;
    probe.own = 25;
    await b.run(5000);
    expect(b.m.state().route).toBe(false);
    probe.own = 8;
    await b.run(ROUTE_MS - 200);
    expect(b.m.state().route).toBe(false);
    await b.run(400);
    expect(b.m.state().route).toBe(true);
    probe.own = 20;
    await b.run(20);
    expect(b.m.state().route).toBe(false);
    // no reading at all: counts from a superframe after the link started
    b.m.back();
    b.m.host();
    await flush();
    b.links[1]!.probe.own = null;
    await b.run(ROUTE_GRACE_MS + ROUTE_MS - 300);
    expect(b.m.state().route).toBe(false);
    await b.run(500);
    expect(b.m.state().route).toBe(true);
  });

  /** `n` stats reports, one every 250 ms (the worklet's rate), with this microphone peak. */
  const reports = async (b: Bench, probe: Probe, n: number, peak: number) => {
    for (let i = 0; i < n; i++) {
      probe.peak = peak;
      probe.sample++;
      await b.run(250);
    }
  };
  /** Reports in LOUD_MS: the one at its end is the first a run of loud ones acts on. */
  const RUN = LOUD_MS / 250;

  it("a loud own signal: only the own signal heard counts, and only a run of 2 s, not a transient", { timeout: 30_000 }, async () => {
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    const probe = b.links[0]!.probe;
    probe.own = 40;
    // under −6 dBFS: nothing
    await reports(b, probe, 3 * RUN, 0.3);
    // a clap, a knock, a word: loud reports for less than 2 s, then a quiet one, again and again
    for (let k = 0; k < 4; k++) {
      await reports(b, probe, RUN, 0.9);
      await reports(b, probe, 1, 0.2);
    }
    expect(probe.gains).toEqual([]);
    // loud for long, with the own signal buried (a full-scale burst, music at the microphone): not this phone's
    probe.own = ROUTE_SNR_DB - 4;
    await reports(b, probe, 4 * RUN, 1);
    // … or not heard at all
    probe.own = null;
    await reports(b, probe, 4 * RUN, 1);
    expect(probe.gains).toEqual([]);
    expect(b.m.state().loud).toBe(false);
  });

  it("a loud own signal that clips the microphone counts: clipping pulls its own SNR down to 11–24 dB", { timeout: 30_000 }, async () => {
    expect(LOUD_OWN_SNR_DB).toBe(ROUTE_SNR_DB);
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    const probe = b.links[0]!.probe;
    // (the own signal looped back at 4–6× full scale and hard-clipped: the peak pinned, ownSnrDb 11–18 dB)
    probe.own = 15;
    await reports(b, probe, RUN + 1, 1);
    expect(probe.gains).toHaveLength(1);
    expect(probe.gains[0]).toBeCloseTo(GAIN_START * GAIN_STEP, 6);
    probe.own = ROUTE_SNR_DB + 1;
    await reports(b, probe, (2 * GAIN_STEP_MS) / 250, 1);
    expect(probe.gains).toHaveLength(3);
    expect(b.m.state()).toMatchObject({ loud: true, route: false });
  });

  it("a loud own signal lowers the gain by 3 dB a second to the floor, and it climbs back by 1 dB every 2 s once quiet", { timeout: 30_000 }, async () => {
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    const probe = b.links[0]!.probe;
    probe.own = 40;
    await reports(b, probe, RUN, 0.9);
    expect(probe.gains).toEqual([]);
    expect(b.m.state().loud).toBe(false);
    // 2 s of it: −3 dB, then −3 dB a second, never below the floor
    await reports(b, probe, 1, 0.9);
    expect(probe.gains).toHaveLength(1);
    expect(probe.gains[0]).toBeCloseTo(GAIN_START * GAIN_STEP, 6);
    expect(b.m.state().loud).toBe(true);
    await reports(b, probe, (10 * GAIN_STEP_MS) / 250, 0.9);
    expect(probe.gains[1]).toBeCloseTo(GAIN_START * GAIN_STEP ** 2, 6);
    expect(probe.gains.at(-1)).toBe(GAIN_MIN);
    expect(probe.gains).toHaveLength(Math.ceil(Math.log(GAIN_MIN / GAIN_START) / Math.log(GAIN_STEP)));
    // quiet: nothing for 5 s, then 1 dB every 2 s, up to the gain chosen and no further
    const low = probe.gains.length;
    await reports(b, probe, GAIN_QUIET_MS / 250 - 1, 0.3);
    expect(probe.gains).toHaveLength(low);
    await reports(b, probe, 1, 0.3);
    expect(probe.gains).toHaveLength(low + 1);
    expect(probe.gains.at(-1)).toBeCloseTo(GAIN_MIN * GAIN_RISE, 6);
    await reports(b, probe, GAIN_RISE_MS / 250 - 1, 0.3);
    expect(probe.gains).toHaveLength(low + 1);
    await reports(b, probe, 1, 0.3);
    expect(probe.gains.at(-1)).toBeCloseTo(GAIN_MIN * GAIN_RISE ** 2, 6);
    expect(b.m.state().loud).toBe(true);
    await reports(b, probe, (8 * GAIN_RISE_MS) / 250, 0.3);
    expect(probe.gains.at(-1)).toBe(GAIN_START);
    expect(probe.gains.slice(low)).toHaveLength(Math.ceil(Math.log(GAIN_START / GAIN_MIN) / Math.log(GAIN_RISE)));
    expect(Math.min(...probe.gains)).toBe(GAIN_MIN);
    expect(Math.max(...probe.gains)).toBe(GAIN_START);
    expect(b.m.state().loud).toBe(false);
  });

  it("never says the own signal is loud while the route check says the phone can't hear it", { timeout: 30_000 }, async () => {
    const b = bench({ friend: false });
    await flush();
    b.m.host();
    await flush();
    const probe = b.links[0]!.probe;
    probe.own = 40;
    await reports(b, probe, RUN + 1, 0.9);
    expect(b.m.state()).toMatchObject({ loud: true, route: false });
    // the route goes (the sound to the earpiece, say), with the gain still down
    probe.own = 5;
    await reports(b, probe, ROUTE_MS / 250 + 1, 0.9);
    expect(probe.gains.at(-1)).toBeLessThan(GAIN_START);
    expect(b.m.state()).toMatchObject({ route: true, loud: false });
  });

  it("a rematch pairs at once in its role and plan, and falls back to the menu after 60 s with nothing heard", { timeout: 30_000 }, async () => {
    const rematch: DuelRematch = { role: "guest", plan: "low", micMode: "raw", hostSide: "red", mapId: "riverlands", mutators: [] };
    const b = bench({ rematch, friend: false });
    await flush();
    await flush();
    expect(b.m.state()).toMatchObject({ step: "pairing", role: "guest", rematch: true, fixedRole: true, canBack: false });
    expect(b.links[0]!.cfg).toEqual({ plan: "low", tx: "guest", rx: "host" });
    // (the guard follows the stored plan)
    expect(b.guards).toEqual(["low"]);
    await b.run(30_000);
    expect(b.m.state().switchRole).toBe(false);
    expect(b.ended).toEqual([]);
    await b.run(REMATCH_FALLBACK_MS - 30_000 + 100);
    expect(b.ended).toEqual(["fallback"]);
    expect(b.rig!.closed).toBe(true);
  });

  it("a retry starts the rematch's 60 s and the tips' 30 s again", { timeout: 30_000 }, async () => {
    const rematch: DuelRematch = { role: "host", plan: "high", micMode: "raw", hostSide: "red", mapId: "riverlands", mutators: [] };
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
    expect(b.rig!.closed).toBe(true);
  });

  it("a friend that goes quiet after this phone's GO: a line says so, and the meter lets go of its numbers", { timeout: 30_000 }, async () => {
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
    expect(fresh.meter).toMatchObject({ rxq: 7, peerRxq: 7, snrDb: expect.any(Number) });
    await b.run(QUIET_MS - 1000);
    // (the friend's last numbers are gone well before that)
    expect(b.m.state().meter).toMatchObject({ rxq: 0, peerRxq: null, snrDb: null });
    expect(b.m.state().meter!.good).toBeGreaterThanOrEqual(fresh.meter!.good);
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
    const rematch: DuelRematch = { role: "host", plan: "high", micMode: "raw", hostSide: "red", mapId: "random-arctic-77", mutators: [] };
    const b = bench({ rematch });
    await flush();
    await flush();
    await b.run(20_000, () => b.m.state().step === "picking");
    const p = b.m.state().pairing!;
    expect(p.config).toMatchObject({ mapId: "random-arctic-77", hostSide: "red" });
    expect(p.side).toBe("red");
  });

  it("a practice link needs no rig, has no guard, and a relay seat pairs at once", { timeout: 30_000 }, async () => {
    const b = bench({ rig: null, seat: "host" });
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
    expect(b.guards).toEqual([]);
  });

  it("phones of different versions stop at the version error, and Close lets the audio go", { timeout: 30_000 }, async () => {
    const b = bench({ friendBuild: BUILD ^ 1 });
    await flush();
    b.m.join();
    await flush();
    await b.run(10_000, () => b.m.state().step === "error");
    expect(b.m.state()).toMatchObject({ step: "error", error: { kind: "version", message: "Ces téléphones n'ont pas la même version : recharge les deux" }, canBack: false });
    expect(b.ended).toEqual([]);
    b.m.cancel();
    expect(b.ended).toEqual(["cancel"]);
    expect(b.rig!.closed).toBe(true);
  });

  it("a link that can't be made is an error: no relay", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = bench({ rig: null });
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
