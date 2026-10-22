import { describe, expect, it } from "vitest";
import { replay, setupWorld } from "../src/arena/record";
import type { MatchSetup } from "../src/sim/setup";
import { planTicks } from "../src/game/awareness";
import { Controller } from "../src/game/controller";
import type { AbortReason } from "../src/game/GameScene";
import { parseRecord } from "../src/game/replay";
import { rateProblem } from "../src/link/modem/params";
import type { LostReason, MicMode, RigState } from "../src/link/rig";
import { RoomLink, type RoomLinkOptions } from "../src/link/room-transport";
import type { RoomEndpoint } from "../src/link/sim/room";
import type { BandPlan, BandRole, LinkTransport, ModemMode } from "../src/link/transport";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { randomMapId } from "../src/sim/mapgen";
import type { OpenerId } from "../src/sim/openers";
import { hash32 } from "../src/sim/rand";
import { step } from "../src/sim/sim";
import type { Command, Faction, NationOrClassic, World } from "../src/sim/types";
import { C_MAX, commandBits } from "../src/versus/codec";
import { VersusFeed, type DuelRig, type FeedEnv } from "../src/versus/feed";
import { LobbyMachine, type LobbyEnv, type LobbyRig } from "../src/versus/lobby";
import type { HostOffer } from "../src/versus/pairing";
import { RECORD_KEY, readTally } from "../src/versus/records";
import { Session } from "../src/versus/session";

// The whole duel below GameScene, as two phones run it (SOUND-DUEL.md "Tests": "Pairing, then a 90 s duel through
// RoomLink with AIs on both phones"): two Sessions on RoomLink's two ends, the real ModemCore at each in the
// sample-level room, through pairing (the host's offer, both phones' opener picks) into the match; then VersusFeed
// as GameScene drives it, with a real Controller that a normal-difficulty AI commands on each phone, the game loop's
// planTicks and slack trim, a stall holding the pose; 900 ticks, a resign, the end check, Save battle.
//
// Each phone runs on its own clock: its link's now(), the room's frame counter at its own rate and skew. Its
// animation frames come every FRAME_MS of that clock, and the feed's 50 ms fallback pump is a timer on it too.
// Between the result and the scene's attach the match loads (LOAD_MS): the feed exists, pumped by its timer alone.
//
// The Join cases go through the lobby's taps, and each phone's modem starts at its Host or Join tap (the room plays
// silence for it until then), as the rig's worklet node does: a Join detects the plan while its Session is already
// sending lobby frames, and the rig's gap-free capture counts from the link's start.
//
// The AIs' orders are light (normal difficulty decides every 2 s, a few small commands at a time: nothing ever
// queues), so two cases add the bursts tests/versus-lockstep.test.ts gives over PacketAir: every 5 s each side
// selects all and a-moves, then moves, 30 ids (its units padded with ids nobody owns). Then the codec's split, the
// segments and the key rotation run over the modem: the rotation must open more than one segment, and every burst
// land whole on both phones. How long orders wait is reported for every case, not bounded here (lockstep.ts's).
//
// The measure. The spec asks at least 90% of ticks without a stall after the first 2 s (ticks 20 to 900: the start,
// where the phone that loaded first waits at tick D for its friend's first turn, is not the link's doing). Read both
// ways, both must hold: ticks for which commands() handed back null at least once (GameScene held the pose), and
// the time stalled over those ticks against the time they took (one long stall is one tick, but many ticks' worth
// of time). Each case reports what it measured: both stall shares, the round trip, D, the starting mode, mode
// switches, packet counts, and the orders' delay and wait, the queue and the segments at their most.
//
// A match that breaks (an abort, a desync, an end check that failed, a lobby or pairing error) fails at once, with
// where both phones stood, rather than running on to the time limit.

const BUILD = 0xd5e1;
/** The match runs this far on both phones, then blue resigns. */
const TICKS = 900;
/** Stalls count from this tick (the first 2 s). */
const SETTLED = 20;
const NEED_UNSTALLED = 0.9;
/** The driver's step (ms of true time). */
const STEP_MS = 2;
/** Animation frames, host's and guest's (60 and 90 Hz), and the time each takes to load the match (ms). */
const FRAME_MS: [number, number] = [16.7, 11.1];
const LOAD_MS: [number, number] = [900, 1400];
/** The lobby: each phone taps its pick this long after the cards go up (ms). */
const PICK_AFTER_MS: [number, number] = [600, 1300];
const CREATED = new Date("2026-10-19T12:00:00Z");
/** The lobby cases: Host and Join tapped this far into the room (true ms). */
const TAP_MS: [number, number] = [400, 1300];
/** Bursts (the cases that give them): one per side every BURST_EVERY ticks from BURST_FROM through BURST_LAST, then 30 s to land. */
const BURST_EVERY = 50;
const BURST_FROM = 50;
const BURST_LAST = TICKS - 300;
/** Burst n's orders go to cells of their own: tile column n, at the 1/16-tile rows of these (so each landed piece says which it was). */
const MOVE_Y = 20 + Math.E / 7;
const ATTACK_Y = 41.0001;
const MOVE_ROW = Math.floor(MOVE_Y * 16);
const ATTACK_ROW = Math.floor(ATTACK_Y * 16);
/** A phone's modem before its tap: nothing rendered, nothing heard. */
const SILENT: RoomEndpoint = { process: (_input, output) => void output.fill(0) };

const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0xd0e1, i++) / 4294967296;
};

/** localStorage / sessionStorage in memory, counting writes. */
class Mem {
  readonly m = new Map<string, string>();
  readonly sets: string[] = [];
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.sets.push(k);
    this.m.set(k, v);
  }
  writes(k: string): number {
    return this.sets.filter((key) => key === k).length;
  }
}

/** The audio rig as the lobby and the feed read it: running, capturing gap-free since its link started (0 before), never lost. */
class QuietRig implements LobbyRig, DuelRig {
  state: RigState = "running";
  readonly ready = Promise.resolve("running" as const);
  readonly wakeLockSupported = true;
  readonly failures = 0;
  readonly lastError = null;
  readonly micMode: MicMode = "raw";
  constructor(
    private readonly now: () => number,
    private readonly sr: number,
    /** When the link started, on the phone's clock (null: not yet). */
    private readonly since: () => number | null
  ) {}
  captureOkMs(): number {
    const s = this.since();
    return s === null ? 0 : Math.max(0, this.now() - s);
  }
  reconnect(): Promise<boolean> {
    return Promise.resolve(true);
  }
  setMicMode(): Promise<void> {
    return Promise.resolve();
  }
  onLost(_fn: (reason: LostReason) => void): () => void {
    return () => undefined;
  }
  close(): void {
    this.state = "closed";
  }
  rateProblem(plan: BandPlan): string | null {
    return rateProblem(this.sr, plan);
  }
}

interface Phone {
  role: BandRole;
  /** The room's index of this phone (0: host). */
  idx: 0 | 1;
  link: LinkTransport;
  frameMs: number;
  next: number;
  last: number;
  acc: number;
  /** Most cases drive the Session directly; the Join cases go through the lobby's LobbyMachine, which makes it. */
  session: Session | null;
  lobby: LobbyMachine | null;
  rig: QuietRig | null;
  /** The link configs the lobby asked for, and the guard plans it set. */
  linkCfgs: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" }[];
  guards: (BandPlan | null)[];
  /** The lobby cases: the Host or Join tap and the modem's first lock (true ms), and the link's start (this phone's clock). */
  tapAt: number | null;
  lockedAt: number | null;
  linkAt: number | null;
  released: string[];
  cardsAt: number | null;
  pick: (offered: readonly OpenerId[]) => OpenerId;
  picked: OpenerId | null;
  feed: VersusFeed | null;
  /** When the feed was built (the match agreed and begun), on this phone's clock. */
  builtAt: number;
  ctrl: Controller | null;
  ai: AiState | null;
  aiTick: number;
  /** The lockstep's trail after each tick stepped. */
  trails: number[];
  /** Ticks at which commands() stalled at least once. */
  stalled: Set<number>;
  /** This side's bursts: the tick each was given at, and its ids. */
  bursts: { at: number; ids: number[] }[];
  /** The lockstep after each tick at its most: segments in the rotation, commands queued, the oldest's wait (ticks). */
  maxSegments: number;
  maxQueued: number;
  maxQueuedTicks: number;
  /** The first tick after the last burst with nothing queued. */
  drainedAt: number | null;
  /** The lockstep's stall time and this phone's clock as it first asked for tick SETTLED, and for tick TICKS. */
  from: { at: number; stallMs: number } | null;
  to: { at: number; stallMs: number } | null;
  timers: Map<number, { fn: () => void; ms: number; next: number }>;
  timerId: number;
  local: Mem;
  store: Mem;
  aborts: AbortReason[];
  exits: number;
  reloads: number;
}

interface Case {
  seed: number;
  room: RoomLinkOptions;
  /** The host's offer (its nation: absent, Classique). */
  offer: Required<Omit<HostOffer, "nation">> & Pick<HostOffer, "nation">;
  /** The guest's nation ask (LOBBY_PROTO 2). */
  guestNation?: NationOrClassic;
  /** The phones' lobby protocols, host's then guest's (default LOBBY_PROTO both). */
  protos?: [number, number];
  /** Both phones through LobbyMachine: Host, and Join detecting the plan, as the lobby runs them. */
  lobby?: boolean;
  /** Each side gives a 30-id burst every 5 s besides its AI's orders. */
  bursts?: boolean;
  /** Before anything runs. */
  prepare?: (d: Duel) => void;
  /** Every step, before the phones look: mid-match trouble. */
  every?: (d: Duel) => void;
}

interface Duel {
  link: RoomLink;
  host: Phone;
  guest: Phone;
  c: Case;
  /** True time (ms) when both phones had built their feeds. */
  agreedAt: number;
}

function phone(role: BandRole, link: RoomLink, c: Case): Phone {
  const idx = role === "host" ? 0 : 1;
  const end = idx === 0 ? link.a : link.b;
  const p: Phone = {
    role, idx, link: end, frameMs: FRAME_MS[idx], next: idx * 5, last: 0, acc: 0, session: null, lobby: null, rig: null, linkCfgs: [], guards: [],
    tapAt: null, lockedAt: null, linkAt: null, released: [], cardsAt: null,
    // (the host its last card, the guest one by the seed)
    pick: (offered) => (role === "host" ? offered[offered.length - 1]! : offered[c.seed % offered.length]!),
    picked: null, feed: null, builtAt: 0, ctrl: null, ai: null, aiTick: -1, trails: [], stalled: new Set(), bursts: [], maxSegments: 0, maxQueued: 0,
    maxQueuedTicks: 0, drainedAt: null, from: null, to: null, timers: new Map(), timerId: 0, local: new Mem(), store: new Mem(), aborts: [], exits: 0,
    reloads: 0
  };
  const random = rng(c.seed * 2 + idx);
  const offer: HostOffer = { map: c.offer.map, mutators: c.offer.mutators, hostSide: c.offer.hostSide, ...(c.offer.nation ? { nation: c.offer.nation } : {}) };
  const proto = c.protos?.[idx];
  if (!c.lobby) {
    p.session = new Session({
      transport: end, role, build: BUILD, random, ...(proto !== undefined ? { proto } : {}),
      ...(role === "host" ? { host: offer } : c.guestNation ? { nation: c.guestNation } : {})
    });
    return p;
  }
  // the modem joins the room when the lobby asks for the link (the rig connects the worklet node then): it starts at
  // whatever frame the phone's clock has reached, as a fresh node does
  const modem = end as LinkTransport & RoomEndpoint;
  link.room.setEndpoint(idx, SILENT);
  const rig = (p.rig = new QuietRig(() => end.now(), link.room.sampleRate(idx), () => p.linkAt));
  const env: LobbyEnv = {
    now: () => end.now(),
    build: BUILD,
    random,
    rig,
    practice: null,
    link: (cfg) => {
      p.linkCfgs.push(cfg);
      p.linkAt = end.now();
      link.room.setEndpoint(idx, modem);
      return Promise.resolve(end);
    },
    guard: (plan) => void p.guards.push(plan),
    // (this phone's nation: the host's offer, the guest's ask)
    offer: { map: c.offer.map, mutators: c.offer.mutators.slice(), hostSide: c.offer.hostSide, nation: (role === "host" ? c.offer.nation : c.guestNation) ?? "classique" },
    rematch: null,
    seat: null,
    prefs: { plan: c.room.plan ?? "high", micMode: "raw" },
    savePrefs: () => undefined,
    begin: (s) => {
      p.session = s;
      build(p);
    },
    released: (why) => void p.released.push(why)
  };
  p.lobby = new LobbyMachine(env);
  return p;
}

/** The match is agreed: the feed, as the lobby builds it (its constructor begins the match). */
function build(p: Phone): void {
  const env: Partial<FeedEnv> = {
    setInterval: (fn, ms) => {
      const id = ++p.timerId;
      p.timers.set(id, { fn, ms, next: p.link.now() + ms });
      return id;
    },
    clearInterval: (id) => void p.timers.delete(id as number),
    requestAnimationFrame: null,
    cancelAnimationFrame: () => undefined,
    document: null,
    window: null,
    local: p.local,
    session: p.store,
    reload: () => void p.reloads++,
    date: () => CREATED
  };
  p.feed = new VersusFeed({ session: p.session!, rig: p.rig, practice: false, onExit: () => void p.exits++, env });
  p.builtAt = p.link.now();
}

/** The scene has loaded: a Controller on the feed's world, the scene's stand-in, and this phone's AI. */
function attach(p: Phone, seed: number): void {
  const feed = p.feed!;
  const ctrl = new Controller(feed.world);
  ctrl.trackInFlight();
  feed.attach({ ctrl, abort: (reason) => void p.aborts.push(reason), skipFinale: () => undefined });
  p.ai = createAiState(feed.local === "blue" ? "balanced" : "rush", "normal", hash32(seed, feed.local === "blue" ? 1 : 2));
  p.ctrl = ctrl;
}

/** The feed's 50 ms fallback pump, on this phone's clock. */
function timers(p: Phone): void {
  const now = p.link.now();
  for (const t of p.timers.values())
    while (now >= t.next) {
      t.next += t.ms;
      t.fn();
    }
}

/** One animation frame: the lobby (its picks), the match loading, then the ticks the game loop plans. */
function frame(p: Phone, d: Duel): void {
  const now = p.link.now();
  if (now < p.next) return;
  const dt = now - p.last;
  p.last = now;
  p.next = now + p.frameMs;
  if (!p.feed) {
    lobbyFrame(p, d, now);
    return;
  }
  const f = p.feed;
  if (!p.ctrl) {
    if (now - p.builtAt >= LOAD_MS[p.idx]) attach(p, d.c.seed);
    return;
  }
  const ctrl = p.ctrl;
  const w = f.world;
  if (!ctrl.paused && !f.abortReason && !w.winner) {
    const plan = planTicks(p.acc, dt, f.speed());
    p.acc = plan.acc;
    for (let i = 0; i < plan.ticks; i++) {
      if (p.aiTick !== w.tick) {
        p.aiTick = w.tick;
        for (const cmd of tickAi(w, f.local, p.ai!)) ctrl.enqueue(cmd);
        if (d.c.bursts) burst(p, w);
      }
      const t = w.tick;
      if ((t === SETTLED && !p.from) || (t === TICKS && !p.to)) {
        const mark = { at: now, stallMs: f.session.lockstep!.status().stallMs };
        if (t === SETTLED) p.from = mark;
        else p.to = mark;
      }
      const cmds = f.commands(t);
      if (!cmds) {
        p.stalled.add(t);
        p.acc = 100 * 0.999; // (GameScene: hold the pose, no catch-up burst)
        break;
      }
      step(w, cmds);
      f.afterTick(w);
      p.trails[t] = f.session.lockstep!.trail();
      const st = f.session.lockstep!.status();
      p.maxSegments = Math.max(p.maxSegments, st.segments);
      p.maxQueued = Math.max(p.maxQueued, st.queued);
      p.maxQueuedTicks = Math.max(p.maxQueuedTicks, st.queuedTicks);
      if (d.c.bursts && t > BURST_LAST && st.queued === 0) p.drainedAt ??= t;
      if (w.winner) break; // (GameScene stops stepping a decided world)
    }
  }
  f.frame(dt);
}

/**
 * A burst, as tests/versus-lockstep.test.ts gives them: a select-all order, this side's units padded with ids
 * nobody owns (sparse, as a long match's ids are: wrecks, crates and effects share the counter), to 30, raw float
 * coordinates; an attackMove, then a move of the same ids, which replaces it in the queue.
 */
function burst(p: Phone, w: World): void {
  const t = w.tick;
  if (t < BURST_FROM || t > BURST_LAST || t % BURST_EVERY) return;
  const side = p.feed!.local;
  const mine = [...w.units.values()].filter((u) => u.faction === side).map((u) => u.id);
  const ids = [...mine, ...Array.from({ length: 30 }, (_, i) => 5000 + 40 * t + 37 * i)].slice(0, 30).reverse();
  const n = p.bursts.length;
  p.bursts.push({ at: t, ids });
  p.ctrl!.enqueue({ type: "attackMove", faction: side, unitIds: ids.slice(), x: n + 0.37, y: ATTACK_Y });
  p.ctrl!.enqueue({ type: "move", faction: side, unitIds: ids.slice(), x: n + Math.PI / 10, y: MOVE_Y });
}

function lobbyFrame(p: Phone, d: Duel, now: number): void {
  if (p.lobby) {
    p.lobby.update();
    if (p.lockedAt === null && p.link.stats().locked) p.lockedAt = d.link.now();
    const v = p.lobby.state();
    if (v.step === "picking" && v.pairing && !v.pairing.picked) {
      p.cardsAt ??= now;
      if (now - p.cardsAt >= PICK_AFTER_MS[p.idx]) expect(p.lobby.pick((p.picked = p.pick(v.pairing.offered)))).toBe(true);
    }
    return;
  }
  const s = p.session!;
  s.pump();
  const st = s.pairing.state();
  if (st.phase === "picking" && !st.picked) {
    p.cardsAt ??= now;
    if (now - p.cardsAt >= PICK_AFTER_MS[p.idx]) expect(s.pick((p.picked = p.pick(st.offered)))).toBe(true);
  }
  // (the lobby builds the feed once the match is agreed and capture is steady: the room's never had a gap here)
  if (s.phase === "starting") build(p);
}

const tickOf = (p: Phone): number => p.feed?.world.tick ?? -1;
const ls = (p: Phone) => p.session!.lockstep!.status();
const sideOf = (d: Duel, f: Faction): Phone => (d.host.feed!.local === f ? d.host : d.guest);

/** What has gone wrong on a phone that no waiting will mend, or null: an abort, a desync, a failed end check, a lobby or pairing error. */
function broken(p: Phone): string | null {
  if (p.aborts.length > 0) return `the scene was aborted (${p.aborts.join(", ")})`;
  if (p.feed?.abortReason) return `the feed aborted (${p.feed.abortReason})`;
  const l = p.session?.lockstep?.status();
  if (l?.desync) return `desync (${l.desyncReason})`;
  if (l?.endCheck === "mismatch" || l?.endCheck === "unverified") return `end check ${l.endCheck}`;
  const v = !p.feed ? p.lobby?.state() : undefined;
  if (v?.step === "error" || v?.step === "closed") return `lobby ${v.step}${v.error ? `: ${v.error.message}` : ""}`;
  const pairing = !p.feed ? p.session?.pairing.state().phase : undefined;
  if (pairing === "failed" || pairing === "error") return `pairing ${pairing}`;
  return null;
}

/** Both phones as they stand, for a failure's message. */
function where(d: Duel): string {
  return [d.host, d.guest]
    .map((p) => {
      const s = p.session?.status();
      const l = s?.lockstep;
      return (
        `${p.role}: ${p.lobby && !p.feed ? `lobby ${p.lobby.state().step}, ` : ""}session ${s?.phase ?? "none"}, pairing ${s?.pairing.phase ?? "-"}, ` +
        `tick ${tickOf(p)}, abort ${p.feed?.abortReason ?? "none"}, desync ${l?.desyncReason ?? "none"}, end check ${l?.endCheck ?? "-"}, ` +
        `game frames in ${l?.framesIn ?? 0} (bad ${l?.framesBad ?? 0}), packets ${s ? `${s.packets.in} in, ${s.packets.out} out, ${s.packets.ignored} ignored` : "-"}`
      );
    })
    .join("; ");
}

/** Run the room until `done` holds; fail at once when a phone breaks, or after `limitMs` of true time. */
function runUntil(d: Duel, done: () => boolean, limitMs: number, what: string): void {
  const end = d.link.now() + limitMs;
  while (!done()) {
    for (const p of [d.host, d.guest]) {
      const why = broken(p);
      if (why) throw new Error(`${what}: the ${p.role}: ${why} at ${Math.round(d.link.now())} ms. ${where(d)}`);
    }
    if (d.link.now() >= end) throw new Error(`${what}: ran out of time at ${Math.round(d.link.now())} ms. ${where(d)}`);
    d.link.advance(STEP_MS);
    d.c.every?.(d);
    for (const p of [d.host, d.guest]) {
      timers(p);
      frame(p, d);
    }
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Pair (directly, or through the lobby's taps), play TICKS ticks, resign, and wait for the end check. */
async function duel(c: Case): Promise<Duel> {
  const link = new RoomLink(c.room);
  const d: Duel = { link, host: phone("host", link, c), guest: phone("guest", link, c), c, agreedAt: 0 };
  c.prepare?.(d);
  if (c.lobby) {
    // the lobbies open (their rigs ready), then Host is tapped, and Join a little later; each phone's modem has run
    // nothing until its tap (stats().sample: the next frame it expects, 0 before its first block)
    await flush();
    for (const p of [d.host, d.guest]) expect(p.lobby!.state().step).toBe("choose");
    for (const p of [d.host, d.guest]) {
      runUntil(d, () => link.now() >= TAP_MS[p.idx], 2000, "the lobbies");
      expect(link.modems[p.idx].stats().sample, `${p.role}: its modem ran before the tap`).toBe(0);
      p.tapAt = link.now();
      if (p.role === "host") p.lobby!.host();
      else p.lobby!.join();
      await flush();
      expect(p.linkAt, p.role).not.toBeNull();
    }
    for (const p of [d.host, d.guest]) expect(p.lobby!.state().step).toBe("pairing");
  }
  runUntil(d, () => !!d.host.feed && !!d.guest.feed, 60_000, "pairing");
  d.agreedAt = link.now();
  runUntil(d, () => tickOf(d.host) >= TICKS && tickOf(d.guest) >= TICKS, TICKS * 100 * 1.4 + 10_000, "the match");
  // blue resigns: both phones step it D ticks later, and the end check settles
  const blue = sideOf(d, "blue");
  blue.feed!.duel.resign(false);
  runUntil(d, () => [d.host, d.guest].every((p) => ls(p).endCheck === "ok"), 20_000, "the end check");
  const settle = link.now() + 1000;
  runUntil(d, () => link.now() >= settle, 2000, "after the end");
  return d;
}

interface PhoneReport {
  role: BandRole;
  side: Faction;
  /** Ticks SETTLED…TICKS−1 with a stall, as a share (%), and how many. */
  stallPct: number;
  stalledTicks: number;
  /** Time stalled over those ticks (ms), as a share of the time they took (%). */
  stallTimeMs: number;
  stallTimePct: number;
  /** The lockstep's stall time over the whole match, the start included (ms). */
  stallMs: number;
  start: ModemMode | null;
  switches: number;
  last: string | null;
  packets: { in: number; out: number; ignored: number };
  rxOk: number;
  rxBad: number;
  /** This phone's receive SNR of its friend at the end (dB), its rxq, and the friend's rxq of it. */
  snrDb: number | null;
  rxq: number;
  peerRxq: number | null;
  framesIn: number;
  framesBad: number;
  /** Ticks from an order's drain to its turn (mean), and real time from its drain to its turn being stepped (ms). */
  orderDelay: number | null;
  orderWait: { meanMs: number; worstMs: number } | null;
  /** At their most after any tick: segments in the rotation, commands queued, and the oldest's wait (ticks). */
  maxSegments: number;
  maxQueued: number;
  maxQueuedTicks: number;
  /** Bursts given, and the first tick after the last with nothing queued (null: none, or never). */
  bursts: number;
  drainedAt: number | null;
  /** The lobby cases: the tap, and the modem's first lock (true ms). */
  tapAt: number | null;
  lockedAt: number | null;
}

function report(d: Duel, label: string): { D: number; rttMs: number | null; phones: PhoneReport[] } {
  const res = d.host.session!.result()!;
  const phones = [d.host, d.guest].map((p): PhoneReport => {
    const st = p.session!.status();
    const l = st.lockstep!;
    let n = 0;
    for (let t = SETTLED; t < TICKS; t++) if (p.stalled.has(t)) n++;
    const stallTimeMs = p.to!.stallMs - p.from!.stallMs;
    return {
      role: p.role,
      side: p.feed!.local,
      stallPct: Math.round((1000 * n) / (TICKS - SETTLED)) / 10,
      stalledTicks: n,
      stallTimeMs: Math.round(stallTimeMs),
      stallTimePct: Math.round((1000 * stallTimeMs) / (p.to!.at - p.from!.at)) / 10,
      stallMs: Math.round(l.stallMs),
      start: st.mode.start,
      switches: st.mode.switches,
      last: st.mode.last ? `${st.mode.last.to} (${st.mode.last.why}) at ${Math.round(st.mode.last.at)} ms` : null,
      packets: st.packets,
      rxOk: st.link.rxOk,
      rxBad: st.link.rxBad,
      snrDb: st.link.snrDb === null ? null : Math.round(st.link.snrDb * 10) / 10,
      rxq: st.rxq,
      peerRxq: st.peerRxq,
      framesIn: l.framesIn,
      framesBad: l.framesBad,
      orderDelay: l.orderDelay === null ? null : Math.round(l.orderDelay * 10) / 10,
      orderWait: l.orderWait && { meanMs: Math.round(l.orderWait.meanMs), worstMs: Math.round(l.orderWait.worstMs) },
      maxSegments: p.maxSegments,
      maxQueued: p.maxQueued,
      maxQueuedTicks: p.maxQueuedTicks,
      bursts: p.bursts.length,
      drainedAt: p.drainedAt,
      tapAt: p.tapAt === null ? null : Math.round(p.tapAt),
      lockedAt: p.lockedAt === null ? null : Math.round(p.lockedAt)
    };
  });
  const out = { D: res.delay, rttMs: d.host.session!.status().rttMs, phones };
  console.log(
    `[duel-fullstack] ${label}: plan ${res.plan}, map ${res.mapId}, D ${res.delay}, rtt ${Math.round(out.rttMs ?? NaN)} ms, ` +
      `start ${res.fast ? "fast" : "robust"}, agreed at ${Math.round(d.agreedAt)} ms\n` +
      phones.map((ph) => `  ${ph.role} (${ph.side}): ${JSON.stringify(ph)}`).join("\n")
  );
  return out;
}

/**
 * What every case asserts: both phones played the same match (the same result, trails identical at every tick,
 * the same turns), at least NEED_UNSTALLED of ticks SETTLED…TICKS without a stall on each, the end check "In sync"
 * after blue's resign, the result counted once, and Save battle's records equal and replaying with no divergence.
 */
function expectGoodDuel(d: Duel, label: string): ReturnType<typeof report> {
  const out = report(d, label);
  const [h, g] = [d.host.session!.result()!, d.guest.session!.result()!];
  expect(g.setup).toEqual(h.setup);
  expect([g.delay, g.fast, g.hostNonce, g.guestNonce, g.plan]).toEqual([h.delay, h.fast, h.hostNonce, h.guestNonce, h.plan]);
  expect(g.local).not.toBe(h.local);
  expect(h.mapId).toBe(d.c.offer.map);
  expect(h.setup.mutators).toEqual(d.c.offer.mutators);
  expect(h.local).toBe(d.c.offer.hostSide);
  // the opener each phone picked, in both phones' setup
  for (const p of [d.host, d.guest]) {
    expect(p.picked, p.role).not.toBeNull();
    expect(h.setup.openers[p.feed!.local], p.role).toBe(p.picked);
  }
  const end = Math.min(tickOf(d.host), tickOf(d.guest));
  expect(tickOf(d.host)).toBe(tickOf(d.guest));
  expect(end).toBeGreaterThan(TICKS);
  let diff = -1;
  for (let t = 0; t < end && diff < 0; t++) if (d.host.trails[t] === undefined || d.host.trails[t] !== d.guest.trails[t]) diff = t;
  expect(diff, "the first tick whose trails differ").toBe(-1);
  expect(d.host.feed!.turnLog()).toEqual(d.guest.feed!.turnLog());
  for (const ph of out.phones) {
    expect(1 - ph.stalledTicks / (TICKS - SETTLED), `${ph.role}: ticks without a stall`).toBeGreaterThanOrEqual(NEED_UNSTALLED);
    expect(1 - ph.stallTimePct / 100, `${ph.role}: time without a stall`).toBeGreaterThanOrEqual(NEED_UNSTALLED);
  }
  const blue = sideOf(d, "blue");
  const red = sideOf(d, "red");
  for (const p of [d.host, d.guest]) {
    const st = ls(p);
    expect(st.desync, p.role).toBe(false);
    expect(st.endCheck, p.role).toBe("ok");
    expect(st.decided, p.role).toMatchObject({ winner: "red", resigned: "blue" });
    expect(p.feed!.world.winner).toBe("red");
    expect(p.aborts, p.role).toEqual([]);
    expect(p.local.writes(RECORD_KEY), p.role).toBe(1);
  }
  expect(blue.feed!.outcome).toBe("loss");
  expect(red.feed!.outcome).toBe("win");
  expect(readTally(red.local)).toEqual({ w: 1, l: 0, d: 0, abandoned: 0, noContest: 0 });
  // Save battle: the same record on both phones, and it replays to the same world with no divergence
  const rec = d.host.feed!.record();
  expect(JSON.parse(JSON.stringify(d.guest.feed!.record()))).toEqual(JSON.parse(JSON.stringify(rec)));
  expect(rec.end).toEqual({ tick: end, winner: "red", reason: "resign" });
  expect(rec.hashes.length).toBe(Math.floor(end / 100));
  const back = replay(parseRecord(JSON.stringify(rec)));
  expect(back.divergedAt).toBeNull();
  expect(back.checked).toBe(rec.hashes.length);
  expect(worldHash(back.world)).toBe(worldHash(d.host.feed!.world));
  // every game frame the lockstep took came through the modem's session CRC, and none was rejected
  for (const p of [d.host, d.guest]) {
    const st = p.session!.status();
    expect(st.lockstep!.framesBad, p.role).toBe(0);
    expect(st.lockstep!.framesIn, p.role).toBeGreaterThan(TICKS / 4);
  }
  return out;
}

const cellOf = (c: Command) => ("x" in c && c.x !== undefined && c.y !== undefined ? { n: Math.floor(c.x), row: Math.floor(c.y * 16) } : null);

/**
 * The bursts went over the modem as the lockstep cuts them: the rotation opened more than one segment on some
 * phone; every burst's move landed in pieces of at most C_MAX bits on the friend (and so on both phones: the turn
 * logs are equal), every padding id in them, each of the side's units in it or in a newer move or attackMove that
 * replaced it in the queue; its attackMove never went out (the move replaced it); and the queue emptied after the last.
 */
function expectBurstsLanded(d: Duel): void {
  const w = d.host.feed!.world;
  const map = { width: w.width, height: w.height };
  expect(Math.max(d.host.maxSegments, d.guest.maxSegments), "segments in the rotation at the most").toBeGreaterThan(1);
  for (const p of [d.host, d.guest]) {
    const side = p.feed!.local;
    const friend = p === d.host ? d.guest : d.host;
    expect(p.bursts.length, p.role).toBe((BURST_LAST - BURST_FROM) / BURST_EVERY + 1);
    expect(p.drainedAt, `${p.role}: the queue emptied after the last burst`).not.toBeNull();
    const stepped = friend.feed!.turnLog().filter(([, s]) => s === side).flatMap(([t, , cmds]) => cmds.map((c) => [t, c] as const));
    p.bursts.forEach(({ at, ids }, n) => {
      const what = `${p.role}'s burst ${n}`;
      const pieces = stepped
        .filter(([, c]) => c.type === "move" && cellOf(c)?.n === n && cellOf(c)?.row === MOVE_ROW)
        .map(([, c]) => c as Extract<Command, { type: "move" }>);
      expect(pieces.length, `${what}: pieces`).toBeGreaterThan(1);
      for (const c of pieces) expect(commandBits(c, map), what).toBeLessThanOrEqual(C_MAX);
      expect(stepped.some(([, c]) => c.type === "attackMove" && cellOf(c)?.n === n && cellOf(c)?.row === ATTACK_ROW), `${what}: its attackMove`).toBe(false);
      const got = new Set(pieces.flatMap((c) => c.unitIds));
      for (const id of ids) {
        if (id >= 5000) expect(got.has(id), `${what}: padding id ${id}`).toBe(true);
        else if (!got.has(id))
          expect(stepped.some(([t, c]) => t > at && (c.type === "move" || c.type === "attackMove") && c.unitIds.includes(id)), `${what}: unit ${id}`).toBe(true);
      }
    });
  }
}

/** The world a setup (or a record, which is one) builds, hashed. */
const setupWorldHash = (s: MatchSetup): string => worldHash(setupWorld(s));

describe("a sound duel through the room, lobby to report", () => {
  it("high plan, 48/48 kHz, 20 cm: a built-in map", { timeout: 150_000 }, async () => {
    const d = await duel({ seed: 101, room: { seed: 101, distanceCm: 20 }, offer: { map: "riverlands", mutators: [], hostSide: "blue" } });
    const out = expectGoodDuel(d, "high 48/48 20 cm");
    expect(d.host.session!.result()!.fast).toBe(true);
    for (const ph of out.phones) expect(ph.switches).toBe(0);
  });

  it(
    "high plan, 48/44.1 kHz at ±300 ppm, 30 cm, game audio through the guard and the own path at +40 dB: a random map, bursts of 30-id orders",
    { timeout: 180_000 },
    async () => {
      const hard = { ownDb: 40, jammerDb: -30 };
      const d = await duel({
        seed: 102,
        room: { seed: 102, distanceCm: 30, a: { ...hard, ppm: 300 }, b: { ...hard, sampleRate: 44100, ppm: -300 } },
        offer: { map: randomMapId("desert", 0x1a2b3c), mutators: ["veterans"], hostSide: "red" },
        bursts: true
      });
      expectGoodDuel(d, "high 48/44.1 ±300 ppm 30 cm, jammer, own +40 dB, bursts");
      expectBurstsLanded(d);
    }
  );

  it("low plan, 48/48 kHz, 20 cm, bursts of 30-id orders", { timeout: 180_000 }, async () => {
    const d = await duel({
      seed: 103,
      room: { seed: 103, distanceCm: 20, plan: "low" },
      offer: { map: "dune-sea", mutators: ["goldrush"], hostSide: "blue" },
      bursts: true
    });
    expectGoodDuel(d, "low 48/48 20 cm, bursts");
    expect(d.host.session!.result()!.plan).toBe("low");
    expectBurstsLanded(d);
  });

  // nations (LOBBY_PROTO 2, PANACHE-CONCEPTION.md §1.10): the host offers the République, the guest asks for the
  // Empire through the lobbies; both phones play that world tick for tick, the saved battle names the nations and
  // replays to the same world
  it("République against Empire through the lobbies: the nations agreed, played in sync, saved and replayed", { timeout: 180_000 }, async () => {
    const d = await duel({
      seed: 107, lobby: true, room: { seed: 107, distanceCm: 20 },
      offer: { map: "riverlands", mutators: [], hostSide: "blue", nation: "republique" }, guestNation: "empire"
    });
    expectGoodDuel(d, "République vs Empire, through the lobby");
    const want = { blue: "republique", red: "empire" };
    for (const p of [d.host, d.guest]) {
      expect(p.session!.result()!.setup.nations, p.role).toEqual(want);
      expect(p.feed!.world.rules?.nations, p.role).toEqual(want);
      expect(p.feed!.config.nations, p.role).toEqual(want);
      expect(p.lobby!.state().pairing?.config?.nations, p.role).toEqual({ host: "republique", guest: "empire" });
    }
    // each side started with its nation's worker (Fourgon / Fardier)
    const w = d.host.feed!.world;
    expect([...w.units.values()].some((u) => u.faction === "blue" && u.kind === "fourgon")).toBe(true);
    expect([...w.units.values()].some((u) => u.faction === "red" && u.kind === "fourgon")).toBe(false);
    // the saved battle names them, and replays them (expectGoodDuel replayed it to the same world)
    expect(d.host.feed!.record().nations).toEqual(want);
    expect(setupWorldHash(d.host.feed!.record())).toBe(setupWorldHash(d.host.session!.result()!.setup));
  });

  it("a proto-1 phone with a proto-2 host offering a nation: Classique, in sync", { timeout: 150_000 }, async () => {
    const d = await duel({
      seed: 108, room: { seed: 108, distanceCm: 20 }, protos: [2, 1],
      offer: { map: "riverlands", mutators: [], hostSide: "blue", nation: "republique" }, guestNation: "empire"
    });
    expectGoodDuel(d, "proto 2 host (République) vs proto 1 guest");
    for (const p of [d.host, d.guest]) {
      expect(p.session!.result()!.setup.nations, p.role).toBeUndefined();
      expect(p.feed!.world.rules?.nations, p.role).toBeUndefined();
    }
    expect(d.host.feed!.record().nations).toBeUndefined();
  });

  it("a 1 s capture gap on one phone mid-match, and a 700 ms suspension (a frame jump) on the other", { timeout: 180_000 }, async () => {
    // 30 s in, the host's microphone gives 1 s of digital silence; 30 s later the guest's audio thread misses 700 ms
    // (nothing rendered or captured: its frame counter jumps, as the worklet's skip makes it)
    interface Trouble {
      kind: "gap" | "jump";
      idx: 0 | 1;
      atTick: number;
      ms: number;
      /** When it struck (true time), and both phones' lockstep stall time then and 8 s later. */
      at: number | null;
      before: [number, number] | null;
      after: [number, number] | null;
    }
    const trouble: Trouble[] = [
      { kind: "gap", idx: 0, atTick: 300, ms: 1000, at: null, before: null, after: null },
      { kind: "jump", idx: 1, atTick: 600, ms: 700, at: null, before: null, after: null }
    ];
    const stalls = (d: Duel): [number, number] => [ls(d.host).stallMs, ls(d.guest).stallMs];
    // what each modem said of its input: gaps (a start, then the total once capture resumes) and jumps
    const gaps: [{ sample: number; frames: number }[], { sample: number; frames: number }[]] = [[], []];
    const d = await duel({
      seed: 104,
      room: { seed: 104, distanceCm: 20, b: { ppm: 120 } },
      offer: { map: randomMapId("arctic", 77), mutators: [], hostSide: "blue" },
      prepare: (d) => {
        for (const i of [0, 1] as const) {
          const m = d.link.modems[i];
          const take = m.takeGaps.bind(m);
          m.takeGaps = () => {
            const g = take();
            for (const e of g) gaps[i].push({ ...e });
            return g;
          };
        }
      },
      every: (d) => {
        for (const e of trouble) {
          if (e.at === null && tickOf(e.idx ? d.guest : d.host) >= e.atTick) {
            e.at = d.link.now();
            e.before = stalls(d);
            if (e.kind === "gap") d.link.room.captureGap(e.idx, e.ms);
            else d.link.room.jump(e.idx, e.ms);
          }
          if (e.at !== null && !e.after && d.link.now() >= e.at + 8000) e.after = stalls(d);
        }
      }
    });
    expectGoodDuel(d, "1 s capture gap (host), 700 ms jump (guest)");
    // the modems saw them: the host's input missing for 1 s, the guest's frame counter jumping 700 ms
    expect(gaps[0]).toHaveLength(2);
    expect(gaps[0][0]!.frames).toBe(0);
    expect(Math.abs(gaps[0][1]!.frames - 48000)).toBeLessThanOrEqual(256);
    expect(gaps[1]).toEqual([
      { sample: gaps[1][0]!.sample, frames: 0 },
      { sample: gaps[1][0]!.sample, frames: 33600 }
    ]);
    // each was felt, and each phone's stall from it stayed within the trouble and the 2.5 s the spec gives the link
    // to deliver again after a gap on either phone
    for (const e of trouble) {
      const cost = [0, 1].map((i) => Math.round(e.after![i]! - e.before![i]!));
      console.log(`[duel-fullstack]   ${e.ms} ms ${e.kind} on the ${e.idx ? "guest" : "host"} at tick ${e.atTick}: stalled host ${cost[0]} ms, guest ${cost[1]} ms`);
      expect(Math.max(...cost), e.kind).toBeGreaterThan(0);
      for (const c of cost) expect(c, e.kind).toBeLessThanOrEqual(e.ms + 2500);
    }
  });

  // Host and Join tapped in the lobby, as it runs them: the host on its band plan (Advanced), the Join listening for
  // either plan's host band from the high plan's guest band from its tap on (its Session already sending lobby
  // frames), and moving to the plan it locks on
  const joins: [BandPlan, RoomLinkOptions["b"], string, HostOffer["mutators"]][] = [
    ["high", { sampleRate: 44100, ppm: -120 }, "frostbite", ["rapidfab", "veterans"]],
    ["low", { ppm: 150 }, "proving-grounds", []]
  ];
  for (const [plan, b, map, mutators] of joins) {
    it(`Join detecting the plan, the host on ${plan}, both phones through the lobby`, { timeout: 180_000 }, async () => {
      const seed = plan === "high" ? 105 : 106;
      const d = await duel({ seed, lobby: true, room: { seed, distanceCm: 20, plan, guestRx: "detect", b }, offer: { map, mutators, hostSide: "blue" } });
      expectGoodDuel(d, `Join detecting (host on ${plan}), through the lobby`);
      expect(d.host.session!.result()!.plan).toBe(plan);
      // the lobbies asked for the links a Host and a Join tap make
      expect(d.host.linkCfgs).toEqual([{ plan, tx: "host", rx: "guest" }]);
      expect(d.guest.linkCfgs).toEqual([{ plan: "high", tx: "guest", rx: "detect" }]);
      expect(d.guest.link.stats().plan).toBe(plan);
      // it detected after its Join tap, not before (the host's signal was in the room from the Host tap on)
      expect(d.guest.lockedAt!, "the Join's first lock").toBeGreaterThan(d.guest.tapAt!);
      // the Join's guard followed the plan it locked on; each phone heard its own signal (no route warning)
      expect(d.guest.guards[d.guest.guards.length - 1]).toBe(plan);
      for (const p of [d.host, d.guest]) {
        expect(p.released, p.role).toEqual([]);
        expect(p.lobby!.state(), p.role).toMatchObject({ step: "started", route: false, error: null });
      }
    });
  }
});
