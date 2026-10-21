import { describe, expect, it } from "vitest";
import { replay } from "../src/arena/record";
import { planTicks } from "../src/game/awareness";
import { Controller, buildView } from "../src/game/controller";
import { ReplayFeed, parseRecord } from "../src/game/replay";
import { PacketAir } from "../src/link/packet-air";
import { RigError, type LostReason, type MicMode, type RigState } from "../src/link/rig";
import type { BandRole } from "../src/link/transport";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { BUILDINGS, POWERS, UNITS } from "../src/sim/balance";
import { OPENERS } from "../src/sim/openers";
import { worldHash } from "../src/sim/checksum";
import { cooldownTicks, powerStatus } from "../src/sim/powers";
import { hash32 } from "../src/sim/rand";
import { step } from "../src/sim/sim";
import type { Command, Faction, Unit, UnitKind, World } from "../src/sim/types";
import { hqOf, passable, regionAt, spawnUnit } from "../src/sim/world";
import { setupWorld } from "../src/sim/setup";
import type { AbortReason } from "../src/game/GameScene";
import { VersusFeed, liftGroupsFirst, type DuelRig, type FeedEnv } from "../src/versus/feed";
import type { ReportContext } from "../src/ui/report";
import { duelReportSection, orderRows } from "../src/versus/hud";
import { RECORD_KEY, REMATCH_KEY, readRematch, readTally } from "../src/versus/records";
import { Session } from "../src/versus/session";

// VersusFeed (SOUND-DUEL.md "MatchFeed and GameScene") driven as GameScene drives it: a real Controller, the
// game loop's planTicks, a null from commands() holding the pose, two Sessions paired over PacketAir on a fake
// clock. No DOM: the feed's browser pieces are stand-ins (no timers, memory storage, a counted reload, and where a
// test asks, a page whose visibility and pagehide it drives).

const BUILD = 0x5eed;
const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0xfeed, i++) / 4294967296;
};

/** sessionStorage / localStorage in memory, counting writes. */
class Mem {
  readonly m = new Map<string, string>();
  readonly sets: [string, string][] = [];
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.sets.push([k, v]);
    this.m.set(k, v);
  }
  writes(k: string): number {
    return this.sets.filter(([key]) => key === k).length;
  }
}

/**
 * A page as the feed reads it: the document's visibility and its visibilitychange listeners, the window's
 * pagehide ones (one object stands for both: each listens for its own event), and no HUD root (no overlay DOM).
 */
class FakePage {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly on = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.on.has(type)) this.on.set(type, new Set());
    this.on.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.on.get(type)?.delete(fn);
  }
  getElementById(): null {
    return null;
  }
  listeners(type: string): number {
    return this.on.get(type)?.size ?? 0;
  }
  /** The player switches away (or back): the browser sets the state, then fires visibilitychange. */
  hide(hidden: boolean): void {
    this.visibilityState = hidden ? "hidden" : "visible";
    this.fire("visibilitychange", {});
  }
  /** The page goes: into the back-forward cache (`persisted`), or for good. */
  pagehide(persisted: boolean): void {
    this.fire("pagehide", { persisted });
  }
  private fire(type: string, e: object): void {
    for (const f of [...(this.on.get(type) ?? [])]) f(e as Event);
  }
}

interface Phone {
  role: BandRole;
  s: Session;
  feed: VersusFeed | null;
  ctrl: Controller | null;
  frameMs: number;
  next: number;
  last: number;
  acc: number;
  cardsAt: number | null;
  /** Don't step (the page's game is held: its link and pump run on). */
  hold: boolean;
  /** The world tick each drain of the Controller came on. */
  drains: number[];
  /** Every non-null commands() result, by tick. */
  stepped: Map<number, Command[]>;
  aborts: { reason: AbortReason; info?: string }[];
  skips: number;
  exits: number;
  reloads: number;
  local: Mem;
  session: Mem;
  ai: AiState | null;
  aiTick: number;
}

interface Opts {
  seed: number;
  practice?: boolean;
  /** Each phone's world right after its feed is made, before any step (the same on both). */
  prepare?: (w: World) => void;
  /** AIs play both sides (their orders go through the Controller). */
  ai?: boolean;
  /** The lockstep gets the Controller's commands as drained, not through the feed's lift grouping (a control run). */
  raw?: boolean;
  /** A phone's audio rig (default none, as on a practice link). */
  rigs?: Partial<Record<BandRole, DuelRig>>;
  /** The host's map (default riverlands). */
  map?: string;
  /** A phone's page (default none: no document or window). */
  pages?: Partial<Record<BandRole, FakePage>>;
  /** This phone's game holds from the start: it never steps tick 0 (its art still loading). */
  held?: BandRole;
}

interface Run {
  air: PacketAir;
  host: Phone;
  guest: Phone;
  opts: Opts;
}

function phone(role: BandRole, air: PacketAir, seed: number, frameMs: number, map = "riverlands"): Phone {
  const link = role === "host" ? air.a : air.b;
  const s = new Session({ transport: link, role, build: BUILD, random: rng(seed), ...(role === "host" ? { host: { map, mutators: [] } } : {}) });
  return {
    role, s, feed: null, ctrl: null, frameMs, next: 0, last: 0, acc: 0, cardsAt: null, hold: false, drains: [], stepped: new Map(),
    aborts: [], skips: 0, exits: 0, reloads: 0, local: new Mem(), session: new Mem(), ai: null, aiTick: -1
  };
}

function pair(opts: Opts): Run {
  const air = new PacketAir({ seed: opts.seed, clockOffsetMs: [0, 31_337], mode: "robust", latencyMs: 250, phaseMs: [30, 170] });
  const r: Run = { air, host: phone("host", air, opts.seed * 2 + 1, 16, opts.map), guest: phone("guest", air, opts.seed * 2 + 2, 11), opts };
  r.guest.next = 5;
  runUntil(r, () => !!r.host.feed && !!r.guest.feed, 60_000);
  return r;
}

/** Advance the air in 2 ms steps, each phone getting its animation frames, until `done` (or `limitMs` of air time: fails). */
function runUntil(r: Run, done: () => boolean, limitMs: number): void {
  const end = r.air.now() + limitMs;
  while (!done()) {
    expect(r.air.now(), "ran out of time").toBeLessThan(end);
    r.air.advance(2);
    for (const p of [r.host, r.guest]) frame(p, r);
  }
}

const runFor = (r: Run, ms: number) => {
  const end = r.air.now() + ms;
  runUntil(r, () => r.air.now() >= end, ms + 10);
};

/** One animation frame: the lobby until the match is agreed, then the feed as GameScene drives it. */
function frame(p: Phone, r: Run): void {
  const now = r.air.now();
  if (now < p.next) return;
  const dt = now - p.last;
  p.last = now;
  p.next = now + p.frameMs;
  if (!p.feed) {
    p.s.pump();
    const st = p.s.pairing.state();
    if (st.phase === "picking") {
      p.cardsAt ??= now;
      if (now - p.cardsAt >= (p.role === "host" ? 300 : 700)) p.s.pick(st.offered[0]!);
    }
    if (p.s.phase === "starting") start(p, r);
    return;
  }
  const f = p.feed;
  const ctrl = p.ctrl!;
  const w = f.world;
  if (!ctrl.paused && !p.hold && !f.abortReason && !w.winner) {
    const plan = planTicks(p.acc, dt, f.speed());
    p.acc = plan.acc;
    for (let i = 0; i < plan.ticks; i++) {
      if (w.winner) break;
      if (p.ai && p.aiTick !== w.tick) {
        p.aiTick = w.tick;
        for (const c of tickAi(w, f.local, p.ai)) ctrl.enqueue(c);
      }
      const t = w.tick;
      const cmds = r.opts.raw ? f.session.commandsFor(t, () => ctrl.drainCommands()) : f.commands(t);
      if (!cmds) {
        p.acc = 100 * 0.999; // (GameScene: hold the pose, no catch-up burst)
        break;
      }
      p.stepped.set(t, cmds);
      step(w, cmds);
      f.afterTick(w);
    }
  }
  ctrl.prune(); // (GameScene, every frame: pending lift and drop orders go out from here)
  f.frame(dt);
}

/** The match is agreed: the feed (beginMatch), a Controller on its world, and the scene's stand-in. */
function start(p: Phone, r: Run): void {
  const page = r.opts.pages?.[p.role] ?? null;
  const env: Partial<FeedEnv> = {
    setInterval: () => null, clearInterval: () => undefined, requestAnimationFrame: null,
    document: page as unknown as FeedEnv["document"], window: page as unknown as FeedEnv["window"],
    local: p.local, session: p.session, reload: () => p.reloads++
  };
  p.hold = r.opts.held === p.role;
  const feed = new VersusFeed({ session: p.s, rig: r.opts.rigs?.[p.role] ?? null, practice: !!r.opts.practice, onExit: () => p.exits++, env });
  r.opts.prepare?.(feed.world);
  const ctrl = new Controller(feed.world);
  ctrl.trackInFlight();
  const drain = ctrl.drainCommands.bind(ctrl);
  ctrl.drainCommands = () => {
    p.drains.push(feed.world.tick);
    return drain();
  };
  feed.attach({ ctrl, abort: (reason, info) => p.aborts.push({ reason, ...(info !== undefined ? { info } : {}) }), skipFinale: () => p.skips++ });
  if (r.opts.ai) p.ai = createAiState(feed.local === "blue" ? "balanced" : "rush", "normal", hash32(r.opts.seed, feed.local === "blue" ? 1 : 2));
  p.feed = feed;
  p.ctrl = ctrl;
}

const tickOf = (p: Phone) => p.feed!.world.tick;
const sideOf = (r: Run, f: Faction) => (r.host.feed!.local === f ? r.host : r.guest);
const ls = (p: Phone) => p.s.lockstep!.status();

describe("VersusFeed as GameScene drives it", () => {
  it("seals once per tick, and a stall consumes no input", { timeout: 60_000 }, () => {
    const r = pair({ seed: 3 });
    runUntil(r, () => tickOf(r.host) >= 40 && tickOf(r.guest) >= 40, 30_000);
    // the guest's game holds (its link and pump run on): the host stalls on its turns
    r.guest.hold = true;
    runUntil(r, () => ls(r.host).stalled && r.host.s.status().waiting !== null, 5000);
    const stalledAt = tickOf(r.host);
    const drainsAtStall = r.host.drains.length;
    const side = r.host.feed!.local;
    const hq = hqOf(r.host.feed!.world, side)!;
    // an order given while stalled: nothing drains it while the stall lasts
    r.host.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 20.5, y: 21.5 });
    runFor(r, 2000);
    expect(tickOf(r.host)).toBe(stalledAt);
    expect(r.host.drains.length).toBe(drainsAtStall);
    expect(ls(r.host).stallMs).toBeGreaterThan(1500);
    // the pause menu's ways out: "Resign and leave" while packets arrive; Leave once "Signal lost" has shown (5 s)
    expect(r.host.feed!.duel.exits()).toEqual({ resignAndLeave: true, leave: false });
    runFor(r, 3500);
    expect(r.host.feed!.duel.exits()).toEqual({ resignAndLeave: true, leave: true });
    expect(r.host.drains.length).toBe(drainsAtStall);
    r.guest.hold = false;
    runUntil(r, () => tickOf(r.host) > stalledAt + r.host.s.result()!.delay + 2, 10_000);
    // it was sealed by the next tick's drain: turn stalledAt + 1 + D
    const D = r.host.s.result()!.delay;
    const landed = [...r.host.stepped].find(([, cmds]) => cmds.some((c) => c.type === "rally"));
    expect(landed?.[0]).toBe(stalledAt + 1 + D);
    // sealing happened once per tick, on every tick commands() was asked for, in order
    for (const p of [r.host, r.guest]) {
      const n = p.drains.length;
      expect(p.drains).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(n).toBeGreaterThanOrEqual(tickOf(p));
      expect(n).toBeLessThanOrEqual(tickOf(p) + 1);
    }
  });

  it("steps blue's orders before red's on both phones, canonical, with the local side red", { timeout: 60_000 }, () => {
    const r = pair({ seed: 5 });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const red = sideOf(r, "red");
    const blue = sideOf(r, "blue");
    expect(red.feed!.local).toBe("red");
    expect(red.feed!.config.local).toBe("red");
    const units = (p: Phone, f: Faction) => [...p.feed!.world.units.values()].filter((u) => u.faction === f).map((u) => u.id);
    const [ra, rb] = units(red, "red").slice(-2) as [number, number];
    const [ba] = units(blue, "blue").slice(-1) as [number];
    // red's order: ids unsorted with a duplicate, a point off the 1/16-tile grid; blue's on the same tick
    red.ctrl!.enqueue({ type: "move", faction: "red", unitIds: [rb, ra, rb], x: 30.123, y: 20.987 });
    blue.ctrl!.enqueue({ type: "move", faction: "blue", unitIds: [ba], x: 25.5, y: 30.5 });
    runUntil(r, () => tickOf(r.host) >= 60 && tickOf(r.guest) >= 60, 20_000);
    const n = Math.min(tickOf(r.host), tickOf(r.guest));
    for (const p of [r.host, r.guest]) {
      for (const [, cmds] of p.stepped) {
        // blue's commands, then red's, whichever side this phone plays
        const firstRed = cmds.findIndex((c) => c.faction === "red");
        if (firstRed >= 0) expect(cmds.slice(firstRed).every((c) => c.faction === "red")).toBe(true);
      }
      const log = p.feed!.turnLog().filter(([t]) => t < n);
      // the turn log: blue's entry before red's on a tick, each entry one side's
      for (let i = 1; i < log.length; i++) expect(log[i]![0] > log[i - 1]![0] || (log[i - 1]![1] === "blue" && log[i]![1] === "red")).toBe(true);
      for (const [, side, cmds] of log) expect(cmds.every((c) => c.faction === side)).toBe(true);
      expect(p.feed!.turnLog()).toEqual(p.s.lockstep!.turns());
    }
    // both phones stepped exactly the same commands
    const upTo = (p: Phone) => p.feed!.turnLog().filter(([t]) => t < n);
    expect(upTo(r.host)).toEqual(upTo(r.guest));
    // red's order as stepped: canonical (sorted, no duplicate, on the grid), stamped red
    const redMove = upTo(red).find(([, side, cmds]) => side === "red" && cmds.some((c) => c.type === "move"));
    expect(redMove?.[2]).toEqual([{ type: "move", faction: "red", unitIds: [Math.min(ra, rb), Math.max(ra, rb)], x: (Math.floor(30.123 * 16) + 0.5) / 16, y: (Math.floor(20.987 * 16) + 0.5) / 16 }]);
    const blueMove = upTo(red).find(([, side, cmds]) => side === "blue" && cmds.some((c) => c.type === "move"));
    expect(blueMove?.[2]).toEqual([{ type: "move", faction: "blue", unitIds: [ba], x: 25.53125, y: 30.53125 }]);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("seals nothing while paused, and the friend sees it paused", { timeout: 60_000 }, () => {
    const r = pair({ seed: 7 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const p = r.guest;
    p.ctrl!.paused = true; // (the HUD's pause menu)
    runFor(r, 100);
    const sealed = ls(p).newestSealed;
    const drains = p.drains.length;
    expect(ls(p).paused).toBe(true);
    const side = p.feed!.local;
    p.ctrl!.enqueue({ type: "stop", faction: side, unitIds: [[...p.feed!.world.units.values()].find((u) => u.faction === side)!.id] });
    // (even if the loop asked: nothing is sealed or drained while paused)
    expect(p.feed!.commands(tickOf(p))).toBeNull();
    runFor(r, 4000);
    expect(ls(p).newestSealed).toBe(sealed);
    expect(p.drains.length).toBe(drains);
    // the friend stalls within D ticks and waits on a paused friend
    expect(ls(r.host).peerPaused).toBe(true);
    expect(r.host.s.status().waiting?.why).toBe("paused");
    p.ctrl!.paused = false;
    const at = tickOf(p);
    runUntil(r, () => tickOf(p) > at + 10 && tickOf(r.host) > at + 10, 10_000);
    expect(p.drains.length).toBeGreaterThan(drains);
    expect([...p.stepped.values()].some((cmds) => cmds.some((c) => c.type === "stop"))).toBe(true);
  });

  /** A blue Goliath first in id order, 27 blue units, then two Condors far off, with spent ids between them (a long match's gaps). */
  const army = (ids: { g: number; condors: number[]; all: number[] }) => (w: World) => {
    const hq = hqOf(w, "blue")!;
    const spend = () => {
      for (let i = 0; i < 12; i++) w.units.delete(spawnUnit(w, "scout", "red", w.width - 2, 2).id);
    };
    const blue = (kind: UnitKind, x: number, y: number): Unit => {
      const u = spawnUnit(w, kind, "blue", x, y);
      spend();
      return u;
    };
    const near = (i: number) => ({ x: hq.tx + 6 + (i % 6), y: hq.ty - 4 - Math.floor(i / 6) });
    const g = blue("goliath", hq.tx + 4, hq.ty - 8);
    const rest: Unit[] = [];
    for (let i = 0; i < 27; i++) rest.push(blue("stinger", near(i).x, near(i).y));
    const a = blue("condor", hq.tx + 20, hq.ty - 24);
    const b = blue("condor", hq.tx + 22, hq.ty - 24);
    ids.g = g.id;
    ids.condors = [a.id, b.id];
    ids.all = [g.id, ...rest.map((u) => u.id), a.id, b.id];
  };

  /** The lift, then a select-all move of the 30 while it is still hooking on (and the world as it was then). */
  function liftAndMove(raw: boolean): { r: Run; blue: Phone; ids: { g: number; condors: number[]; all: number[] }; to: { x: number; y: number }; hooking: World } {
    const ids = { g: 0, condors: [] as number[], all: [] as number[] };
    const r = pair({ seed: 11, prepare: army(ids), raw });
    const blue = sideOf(r, "blue");
    const w = blue.feed!.world;
    blue.ctrl!.enqueue({ type: "lift", faction: "blue", unitIds: ids.condors, goliathId: ids.g });
    runUntil(r, () => w.units.get(ids.g)!.goliath!.lift?.phase === "hooking", 20_000);
    const hooking = structuredClone(w);
    // open ground north-east of blue's HQ, on the codec's 1/16-tile grid
    const hq = hqOf(w, "blue")!;
    const to = { x: (Math.floor((hq.tx + 14.5) * 16) + 0.5) / 16, y: (Math.floor((hq.ty - 14.5) * 16) + 0.5) / 16 };
    blue.ctrl!.enqueue({ type: "move", faction: "blue", unitIds: ids.all, ...to });
    const named = () => {
      const seen = new Set<number>();
      for (const [, cmds] of blue.stepped) for (const c of cmds) if (c.type === "move" && c.faction === "blue") for (const id of c.unitIds) seen.add(id);
      return ids.all.every((id) => seen.has(id));
    };
    runUntil(r, named, 20_000);
    const at = tickOf(blue);
    // a few more ticks on both phones
    runUntil(r, () => tickOf(r.host) >= at + 3 && tickOf(r.guest) >= at + 3, 10_000);
    return { r, blue, ids, to, hooking };
  }

  it("hands a hooking lift to the lockstep as its own command first: a 30-unit select-all all moves", { timeout: 60_000 }, () => {
    const { r, blue, ids, to, hooking } = liftAndMove(false);
    // the codec would have split it, the Goliath into an earlier piece than its Condors
    const w = blue.feed!.world;
    const moves = [...blue.stepped.values()].flatMap((cmds) => cmds.filter((c): c is Extract<Command, { type: "move" }> => c.type === "move"));
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(moves[0]!.unitIds).toEqual([ids.g, ...ids.condors]);
    for (const p of [r.host, r.guest]) {
      const pw = p.feed!.world;
      expect(pw.units.get(ids.g)!.goliath!.lift).toBeNull();
      // (the pieces land a round trip apart: the fast Condors may be there already)
      for (const id of ids.all) {
        const u = pw.units.get(id)!;
        if (u.order.type !== "move") expect(Math.hypot(u.x - to.x, u.y - to.y), `unit ${id} (${u.kind}) is ${u.order.type}`).toBeLessThan(1.5);
        else expect(u.order, `unit ${id}`).toMatchObject({ type: "move", ...to });
      }
    }
    expect(w.units.get(ids.g)!.order.type).toBe("move");
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
    // (liftGroupsFirst by itself: the group, then the rest, nothing else touched)
    const rest = ids.all.filter((id) => id !== ids.g && !ids.condors.includes(id));
    expect(liftGroupsFirst(hooking, [{ type: "move", faction: "blue", unitIds: ids.all, x: 1.5, y: 1.5 }])).toEqual([
      { type: "move", faction: "blue", unitIds: [ids.g, ...ids.condors], x: 1.5, y: 1.5 },
      { type: "move", faction: "blue", unitIds: rest, x: 1.5, y: 1.5 }
    ]);
    // a hooking Goliath whose Condors aren't named: unchanged (it waits, as one command leaves it)
    const noCondors: Command = { type: "stop", faction: "blue", unitIds: [ids.g, ...rest] };
    expect(liftGroupsFirst(hooking, [noCondors])).toEqual([noCondors]);
    // (and once it is up, or with no lift at all, nothing changes)
    expect(liftGroupsFirst(w, [{ type: "move", faction: "blue", unitIds: ids.all, x: 1.5, y: 1.5 }])).toHaveLength(1);
  });

  it("(control) without the grouping, the hooking Gargantua misses the split order", { timeout: 60_000 }, () => {
    const { r, ids } = liftAndMove(true);
    for (const p of [r.host, r.guest]) {
      const pw = p.feed!.world;
      expect(pw.units.get(ids.g)!.order.type).not.toBe("move");
      for (const id of ids.condors) expect(pw.units.get(id)?.order.type).toBe("move");
    }
  });

  it("groups a lift still on its way the same: a select-all right after the lift tap all moves", { timeout: 60_000 }, () => {
    const ids = { g: 0, condors: [] as number[], all: [] as number[] };
    const r = pair({ seed: 11, prepare: army(ids) });
    const blue = sideOf(r, "blue");
    const w = blue.feed!.world;
    blue.ctrl!.enqueue({ type: "lift", faction: "blue", unitIds: ids.condors, goliathId: ids.g });
    const d0 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d0, 2000);
    // the lift is sealed, D ticks from landing: the world doesn't know of it yet, and the select-all comes now (an order
    // as an AI gives it: a tap on the map holds it for the lift instead, "taps that build on your own last order")
    expect(w.units.get(ids.g)!.goliath!.lift).toBeNull();
    const hq = hqOf(w, "blue")!;
    const to = { x: (Math.floor((hq.tx + 14.5) * 16) + 0.5) / 16, y: (Math.floor((hq.ty - 14.5) * 16) + 0.5) / 16 };
    blue.ctrl!.enqueue({ type: "move", faction: "blue", unitIds: ids.all, ...to });
    const d1 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d1, 2000);
    expect(w.units.get(ids.g)!.goliath!.lift).toBeNull();
    const named = () => {
      const seen = new Set<number>();
      for (const [, cmds] of blue.stepped) for (const c of cmds) if (c.type === "move" && c.faction === "blue") for (const id of c.unitIds) seen.add(id);
      return ids.all.every((id) => seen.has(id));
    };
    runUntil(r, named, 20_000);
    const at = tickOf(blue);
    runUntil(r, () => tickOf(r.host) >= at + 3 && tickOf(r.guest) >= at + 3, 10_000);
    const moves = [...blue.stepped.values()].flatMap((cmds) => cmds.filter((c): c is Extract<Command, { type: "move" }> => c.type === "move"));
    expect(moves[0]!.unitIds).toEqual([ids.g, ...ids.condors]);
    for (const p of [r.host, r.guest]) {
      const g = p.feed!.world.units.get(ids.g)!;
      // (the lift landed first, hooking on; the group called it off and took the order)
      expect(g.goliath!.lift).toBeNull();
      expect(g.order, "the Gargantua").toMatchObject({ type: "move", ...to });
    }
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
    // (liftGroupsFirst with a lift on its way, or one earlier in the same drain: the same group; one after it: nothing)
    const rest = ids.all.filter((id) => id !== ids.g && !ids.condors.includes(id));
    const lift: Command = { type: "lift", faction: "blue", unitIds: ids.condors, goliathId: ids.g };
    const move: Command = { type: "move", faction: "blue", unitIds: ids.all, x: 1.5, y: 1.5 };
    const grouped = [
      { ...move, unitIds: [ids.g, ...ids.condors] },
      { ...move, unitIds: rest }
    ];
    expect(liftGroupsFirst(w, [move], [{ goliathId: ids.g, condors: ids.condors }])).toEqual(grouped);
    expect(liftGroupsFirst(w, [lift, move])).toEqual([lift, ...grouped]);
    expect(liftGroupsFirst(w, [move, lift])).toEqual([move, lift]);
  });

  it("keeps a turn log and hashes that replay through parseRecord with no divergence", { timeout: 120_000 }, () => {
    const r = pair({ seed: 13, ai: true });
    runUntil(r, () => tickOf(r.host) >= 1250 && tickOf(r.guest) >= 1250, 300_000);
    for (const p of [r.host, r.guest]) {
      const rec = p.feed!.record();
      const hostBlue = (p.feed!.local === "blue") === (p.role === "host");
      expect(rec.seats).toEqual({ blue: { player: `sound-duel:${hostBlue ? "host" : "guest"}` }, red: { player: `sound-duel:${hostBlue ? "guest" : "host"}` } });
      expect(rec.hashes.length).toBe(Math.floor(tickOf(p) / 100));
      expect(rec.turns.length).toBeGreaterThan(50);
      expect(rec.turns).toEqual(p.s.lockstep!.turns());
      const back = parseRecord(JSON.stringify(rec));
      const res = replay(back);
      expect(res.divergedAt).toBeNull();
      expect(res.checked).toBe(rec.hashes.length);
      expect(worldHash(res.world)).toBe(worldHash(p.feed!.world));
      expect(rec.end).toEqual({ tick: tickOf(p), winner: null, reason: "aborted" });
    }
    const n = Math.min(tickOf(r.host), tickOf(r.guest));
    const upTo = (p: Phone) => p.feed!.turnLog().filter(([t]) => t < n);
    expect(upTo(r.host)).toEqual(upTo(r.guest));
    // the AIs stop: every order they gave through the Controller comes off its in-flight list (split by the codec,
    // regrouped for a lift, or replaced in the lockstep's queue before it went out)
    for (const p of [r.host, r.guest]) p.ai = null;
    runUntil(r, () => [r.host, r.guest].every((p) => p.ctrl!.inFlight!.length === 0), 10_000);
  });
});

describe("the report's order delay", () => {
  it("is the real time from the drain to this phone's step, a stall on the way included", { timeout: 60_000 }, () => {
    const r = pair({ seed: 29 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const p = r.host;
    const D = p.s.result()!.delay;
    const side = p.feed!.local;
    const hq = hqOf(p.feed!.world, side)!;
    expect(p.feed!.reportView().link.orders).toBeNull();
    const rallies = () => [...p.stepped.values()].flat().filter((c) => c.type === "rally" && c.faction === side).length;
    // an order on a clear link lands D ticks after its drain: about D × 100 ms
    p.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 20.5, y: 21.5 });
    runUntil(r, () => rallies() === 1, 3000);
    const one = p.feed!.reportView().link.orders!;
    expect(one.meanMs).toBe(one.worstMs);
    expect(Math.abs(one.meanMs - D * 100)).toBeLessThanOrEqual(60);
    // the friend's game holds (its link runs on): the host steps on through the friend's turns it holds, D past
    // the friend's tick. An order drained once the host is ahead of the friend is sealed past them, so it waits
    // out the stall: from its drain to the step, 2 s of hold and the friend's next turn's trip
    r.guest.hold = true;
    const g = tickOf(r.guest);
    runUntil(r, () => tickOf(p) > g, 2000);
    const drains = p.drains.length;
    p.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 22.5, y: 21.5 });
    runUntil(r, () => p.drains.length > drains, 1000);
    expect(p.drains.at(-1)! + D).toBeGreaterThan(ls(p).ackThrough);
    runFor(r, 2000);
    expect(rallies()).toBe(1);
    expect(ls(p).stalled).toBe(true);
    r.guest.hold = false;
    runUntil(r, () => rallies() === 2, 5000);
    const both = p.feed!.reportView().link.orders!;
    expect(both.worstMs).toBeGreaterThanOrEqual(2000);
    expect(both.worstMs).toBeLessThanOrEqual(3000);
    expect(both.meanMs).toBeCloseTo((one.meanMs + both.worstMs) / 2, 6);
    // (the lockstep's count in ticks still says D: it never sees the stall)
    expect(ls(p).orderDelay).toBe(D);
    expect(p.feed!.reportView().link.orders).toEqual(ls(p).orderWait);
  });

  it("leaves this phone's own pause out: an order drained just before the pause menu opens still reads about D × 100 ms", { timeout: 60_000 }, () => {
    const r = pair({ seed: 31 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const p = r.host;
    const D = p.s.result()!.delay;
    const side = p.feed!.local;
    const hq = hqOf(p.feed!.world, side)!;
    const rallies = () => [...p.stepped.values()].flat().filter((c) => c.type === "rally" && c.faction === side).length;
    const drains = p.drains.length;
    p.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 20.5, y: 21.5 });
    runUntil(r, () => p.drains.length > drains, 1000);
    // drained and sealed for D ticks on: the pause menu opens before it is stepped, for 10 s
    p.ctrl!.paused = true;
    runFor(r, 10_000);
    expect(rallies()).toBe(0);
    expect(ls(p).paused).toBe(true);
    p.ctrl!.paused = false;
    runUntil(r, () => rallies() === 1, 5000);
    const o = p.feed!.reportView().link.orders!;
    // (the friend's stall meanwhile is its own: this phone steps on through the D turns it holds of the friend's)
    expect(o.worstMs).toBeLessThanOrEqual(D * 100 + 100);
    expect(o.worstMs).toBeGreaterThanOrEqual(D * 100 - 100);
    // (and "Waiting on the link" leaves it out too)
    expect(p.feed!.reportView().link.stallMs).toBeLessThan(500);
  });

  it("reads as the mean and the worst", () => {
    expect(orderRows(null)).toEqual([["Délai des ordres", "–"], ["Ordre le plus lent", "–"]]);
    expect(orderRows({ meanMs: 620.4, worstMs: 1420 })).toEqual([["Délai des ordres", "620 ms en moyenne"], ["Ordre le plus lent", "1.4 s"]]);
    expect(orderRows({ meanMs: 412, worstMs: 12_400 })).toEqual([["Délai des ordres", "412 ms en moyenne"], ["Ordre le plus lent", "12 s"]]);
  });
});

describe("orders in flight", () => {
  it("count as applied in the build bar until the tick they land", { timeout: 60_000 }, () => {
    const r = pair({ seed: 23 });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const p = r.host;
    const ctrl = p.ctrl!;
    const w = p.feed!.world;
    const side = p.feed!.local;
    const f = w.factions[side];
    const hq = hqOf(w, side)!;
    expect(f.pending).toBeNull();
    // (the Controller's own PLAYER is blue in this process: view the side through buildView's rules directly)
    const view = () => buildView(w, side, ctrl.inFlight);
    ctrl.enqueue({ type: "startBuilding", faction: side, building: "fab-plant" });
    ctrl.enqueue({ type: "produce", faction: side, buildingId: hq.id, unit: "harvester" });
    const at = tickOf(p);
    runUntil(r, () => p.drains.length > at + 1, 2000);
    // drained and sealed, not applied yet: the bar shows them done
    expect(f.pending).toBeNull();
    expect(ctrl.inFlight!.map((c) => c.type)).toEqual(["startBuilding", "produce"]);
    expect(view().pending).toMatchObject({ kind: "fab-plant", ready: false });
    expect(view().extra(hq.id, "harvester")).toBe(1);
    expect(view().scrap).toBe(f.scrap - BUILDINGS["fab-plant"].cost - UNITS.harvester.cost);
    // landed: the world has them, nothing is in flight, and the bar shows the world as it is
    runUntil(r, () => f.pending !== null, 3000);
    expect(ctrl.inFlight).toEqual([]);
    expect(f.pending).toMatchObject({ kind: "fab-plant" });
    expect(hq.queue.map((q) => q.kind)).toEqual(["harvester"]);
    expect(view().extra(hq.id)).toBe(0);
    expect(view().scrap).toBe(f.scrap);
  });

  it("come off when the lockstep replaced them in its queue before they went out", { timeout: 60_000 }, () => {
    const all: number[] = [];
    const prepare = (w: World) => {
      const hq = hqOf(w, "blue")!;
      for (let i = 0; i < 30; i++) all.push(spawnUnit(w, "stinger", "blue", hq.tx + 6 + (i % 6), hq.ty - 4 - Math.floor(i / 6)).id);
    };
    const r = pair({ seed: 61, prepare });
    const blue = sideOf(r, "blue");
    const ctrl = blue.ctrl!;
    // a 30-unit move every tick for 3 s: more than a turn holds, so they queue, and each replaces the one before it
    let given = 0;
    let queued = 0;
    for (let i = 0; i < 30; i++) {
      ctrl.enqueue({ type: "move", faction: "blue", unitIds: all, x: 20.5 + (i % 2) * 4, y: 20.5 });
      given++;
      const d = blue.drains.length;
      runUntil(r, () => blue.drains.length > d, 2000);
      queued = Math.max(queued, ls(blue).queued);
    }
    expect(queued).toBeGreaterThan(0);
    runUntil(r, () => ls(blue).queued === 0, 20_000);
    // (some never went out: fewer units were moved than were told to)
    let moved = 0;
    for (const cmds of blue.stepped.values()) for (const c of cmds) if (c.type === "move" && c.faction === "blue") moved += c.unitIds.length;
    expect(moved).toBeLessThan(given * all.length);
    runUntil(r, () => ctrl.inFlight!.length === 0, 10_000);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("are nothing without an interactive feed", () => {
    const c = new Controller(setupLikeWorld());
    c.enqueue({ type: "startBuilding", faction: "blue", building: "fab-plant" });
    c.drainCommands();
    expect(c.inFlight).toBeNull();
    expect(c.view().pending).toBeNull();
  });
});

describe("taps that build on your own last order, the world D ticks behind", () => {
  // The Controller's own taps on blue's phone (this process's PLAYER), the second one while the first is sealed but
  // not stepped yet: it must do what single player does a tick after the first (Controller.ahead()).

  /** Blue's orders as its phone stepped them, in order: "type:units", or "rally:producer". */
  const blueOrders = (p: Phone): string[] =>
    [...p.stepped.values()].flat().filter((c) => c.faction === "blue").map((c) => `${c.type}:${"unitIds" in c ? c.unitIds.join(",") : c.type === "rally" ? c.buildingId : ""}`);
  const list = (...ids: number[]) => ids.sort((a, b) => a - b).join(",");
  /** The phone drains the tap just given (sealed D ticks on): `stale` checks its world doesn't have it yet. */
  function sealedNotLanded(r: Run, p: Phone, stale: () => boolean): void {
    const d = p.drains.length;
    runUntil(r, () => p.drains.length > d, 2000);
    expect(stale(), "the world already has the first tap's order").toBe(true);
  }
  /** A point on the codec's 1/16-tile grid. */
  const grid = (x: number, y: number) => ({ x: (Math.floor(x * 16) + 0.5) / 16, y: (Math.floor(y * 16) + 0.5) / 16 });
  /** Unit `id` is as `ok` says on both phones. */
  const onBoth = (r: Run, id: number, ok: (u: Unit, w: World) => boolean) =>
    [r.host, r.guest].every((p) => {
      const u = p.feed!.world.units.get(id);
      return !!u && ok(u, p.feed!.world);
    });
  /** Blue's Goliath and two empty Condors a few tiles off (riverlands). */
  const liftParty = (ids: { g: number; a: number; b: number }) => (w: World) => {
    const hq = hqOf(w, "blue")!;
    ids.g = spawnUnit(w, "goliath", "blue", hq.tx + 4, hq.ty - 8).id;
    ids.a = spawnUnit(w, "condor", "blue", hq.tx + 8, hq.ty - 9).id;
    ids.b = spawnUnit(w, "condor", "blue", hq.tx + 9, hq.ty - 9).id;
  };
  /** Open ground north-east of blue's HQ. */
  const away = (w: World) => grid(hqOf(w, "blue")!.tx + 16.3, hqOf(w, "blue")!.ty - 16.3);

  it("lift, then a tap on the map: the lift flies there once it is up", { timeout: 60_000 }, () => {
    const ids = { g: 0, a: 0, b: 0 };
    const r = pair({ seed: 41, prepare: liftParty(ids) });
    const blue = sideOf(r, "blue");
    const ctrl = blue.ctrl!;
    const w = blue.feed!.world;
    const g = w.units.get(ids.g)!;
    ctrl.selectUnits([ids.a, ids.b]);
    ctrl.tapWorld(g.x, g.y, { kind: "ownUnit", id: ids.g });
    expect(ctrl.selectedUnits).toEqual(new Set([ids.a, ids.b, ids.g]));
    sealedNotLanded(r, blue, () => g.goliath!.lift === null);
    const to = away(w);
    ctrl.tapWorld(to.x, to.y, { kind: "ground" });
    expect(ctrl.tip).toBeNull();
    runUntil(r, () => onBoth(r, ids.g, (u) => u.goliath!.lift?.phase === "carrying" && Math.hypot(u.x - to.x, u.y - to.y) < 0.5), 60_000);
    // nothing named the lift while it was on its way or hooking on (that calls it off): the move went to it once up
    expect(blueOrders(blue)).toEqual([`lift:${list(ids.a, ids.b)}`, `move:${ids.g}`]);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("stop on a lift hooking on, then a tap on the map: the lift is off and all three go", { timeout: 60_000 }, () => {
    const ids = { g: 0, a: 0, b: 0 };
    const r = pair({ seed: 43, prepare: liftParty(ids) });
    const blue = sideOf(r, "blue");
    const ctrl = blue.ctrl!;
    const w = blue.feed!.world;
    const g = w.units.get(ids.g)!;
    ctrl.selectUnits([ids.a, ids.b]);
    ctrl.tapWorld(g.x, g.y, { kind: "ownUnit", id: ids.g });
    runUntil(r, () => onBoth(r, ids.g, (u) => u.goliath!.lift?.phase === "hooking"), 10_000);
    ctrl.stopSelected();
    sealedNotLanded(r, blue, () => g.goliath!.lift?.phase === "hooking");
    const to = away(w);
    ctrl.tapWorld(to.x, to.y, { kind: "ground" });
    runUntil(r, () => blueOrders(blue).length >= 3, 10_000);
    runFor(r, 500);
    const all = list(ids.g, ids.a, ids.b);
    expect(blueOrders(blue)).toEqual([`lift:${list(ids.a, ids.b)}`, `stop:${all}`, `attackMove:${all}`]);
    for (const id of [ids.g, ids.a, ids.b]) expect(onBoth(r, id, (u) => u.order.type === "attackMove" && u.order.x === to.x && u.order.y === to.y), `unit ${id}`).toBe(true);
    expect(onBoth(r, ids.g, (u) => u.goliath!.lift === null)).toBe(true);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("anchor, then a tap on the map: it stays dug in and takes a rally point", { timeout: 60_000 }, () => {
    const ids = { g: 0, a: 0, b: 0 };
    const r = pair({ seed: 47, prepare: liftParty(ids) });
    const blue = sideOf(r, "blue");
    const ctrl = blue.ctrl!;
    const w = blue.feed!.world;
    const g = w.units.get(ids.g)!;
    ctrl.selectUnits([ids.g]);
    expect(ctrl.toggleAnchor()).toBe("anchor");
    sealedNotLanded(r, blue, () => g.goliath!.mode === "walking");
    // (what the ⚓ chip and the G key read: digging in, so a second press would pack it up)
    expect(ctrl.goliathsSelected().map((u) => u.goliath!.mode)).toEqual(["anchoring"]);
    const to = away(w);
    ctrl.tapWorld(to.x, to.y, { kind: "ground" });
    expect(ctrl.lastFeedback?.kind).toBe("rally");
    runUntil(r, () => onBoth(r, ids.g, (u) => u.goliath!.mode === "anchored"), 20_000);
    expect(blueOrders(blue)).toEqual([`anchor:${ids.g}`, `rally:${ids.g}`]);
    expect(onBoth(r, ids.g, (u) => u.order.type === "idle" && u.goliath!.rally?.x === to.x && u.goliath!.rally.y === to.y)).toBe(true);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("board, then a tap on an island: the squads drop there once aboard", { timeout: 90_000 }, () => {
    const ids = { c: 0, s: [] as number[] };
    const r = pair({
      seed: 53,
      map: "archipelago",
      prepare: (w) => {
        const hq = hqOf(w, "blue")!;
        ids.s = [spawnUnit(w, "trooper", "blue", hq.tx + 1.5, hq.ty - 3.5).id, spawnUnit(w, "trooper", "blue", hq.tx + 2.5, hq.ty - 3.5).id];
        ids.c = spawnUnit(w, "condor", "blue", hq.tx + 4.5, hq.ty - 3.5).id;
      }
    });
    const blue = sideOf(r, "blue");
    const ctrl = blue.ctrl!;
    const w = blue.feed!.world;
    const hq = hqOf(w, "blue")!;
    // the island ground nearest blue's HQ a squad can stand on
    let isl = { tx: -1, ty: -1, d: Infinity };
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++) {
        const d = Math.hypot(tx - hq.tx, ty - hq.ty);
        if (d < isl.d && ctrl.onIsland(tx, ty) && passable(w, tx, ty, "foot")) isl = { tx, ty, d };
      }
    const region = regionAt(w, isl.tx, isl.ty, "foot");
    const c = w.units.get(ids.c)!;
    ctrl.selectUnits(ids.s);
    ctrl.tapWorld(c.x, c.y, { kind: "ownUnit", id: ids.c });
    expect(ctrl.selectedUnits).toEqual(new Set(ids.s));
    sealedNotLanded(r, blue, () => ids.s.every((id) => w.units.get(id)!.order.type !== "board"));
    ctrl.tapWorld(isl.tx + 0.5, isl.ty + 0.5, { kind: "ground" });
    expect(ctrl.tip).toBe("Embarquement : largage là-bas une fois à bord");
    runUntil(r, () => ids.s.every((id) => onBoth(r, id, (u, pw) => regionAt(pw, Math.floor(u.x), Math.floor(u.y), "foot") === region)), 80_000);
    expect(blueOrders(blue)).toEqual([`board:${list(...ids.s)}`, `unload:${ids.c}`]);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("a calldown on its way reads as fired: the meter paid, the power cooling down, until it lands", { timeout: 60_000 }, () => {
    const r = pair({ seed: 59, prepare: (w) => (w.powers.meter.blue = 90) });
    const blue = sideOf(r, "blue");
    const ctrl = blue.ctrl!;
    const w = blue.feed!.world;
    const hq = hqOf(w, "blue")!;
    expect(ctrl.powerStatus("barrage").ready).toBe(true);
    ctrl.enqueue({ type: "calldown", faction: "blue", power: "barrage", x: hq.tx + 5.5, y: hq.ty - 4.5 });
    const fired = () => {
      expect(ctrl.powerStatus("barrage")).toMatchObject({ ready: false, cooldown: cooldownTicks("barrage") });
      expect(ctrl.powerBlocker("barrage")).toBe(`Feu roulant en recharge : ${POWERS.barrage.cooldown} s`);
      // (the meter trickles up meanwhile)
      expect(ctrl.powerMeter()).toBeCloseTo(w.powers.meter.blue - POWERS.barrage.cost, 9);
      expect(ctrl.powerBlocker("emp")).toBe("Fée Électricité : 40 de charge requis (30)");
    };
    // (not drained yet, then sealed: the panel offers neither again)
    fired();
    sealedNotLanded(r, blue, () => w.powers.active.length === 0);
    fired();
    runUntil(r, () => w.powers.active.length > 0, 3000);
    expect(ctrl.inFlight).toEqual([]);
    expect(ctrl.powerStatus("barrage")).toEqual(powerStatus(w, "blue", "barrage"));
    expect(ctrl.powerMeter()).toBe(w.powers.meter.blue);
    expect(Math.floor(ctrl.powerMeter())).toBe(30);
  });
});

describe("the duel's record", () => {
  /** Blue resigns; both phones step it, the end check settles. */
  function resigned(practice: boolean): Run {
    const r = pair({ seed: 17, practice });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const blue = sideOf(r, "blue");
    blue.feed!.duel.resign(false);
    expect(blue.ctrl!.locked).toBe(true);
    expect(blue.feed!.duel.resigning()).toBe(true);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    for (const p of [r.host, r.guest]) expect(p.feed!.world.winner).toBe("red");
    runFor(r, 3000);
    return r;
  }

  it("is written once, at the end, and the way out reloads once", { timeout: 60_000 }, () => {
    const r = resigned(false);
    const blue = sideOf(r, "blue");
    const red = sideOf(r, "red");
    for (const p of [r.host, r.guest]) expect(p.local.writes(RECORD_KEY)).toBe(1);
    expect(readTally(blue.local)).toEqual({ w: 0, l: 1, d: 0, abandoned: 0, noContest: 0 });
    expect(readTally(red.local)).toEqual({ w: 1, l: 0, d: 0, abandoned: 0, noContest: 0 });
    expect(blue.feed!.outcome).toBe("loss");
    expect(red.feed!.outcome).toBe("win");
    const rec = red.feed!.record();
    expect(rec.end).toEqual({ tick: tickOf(red), winner: "red", reason: "resign" });
    expect(replay(parseRecord(JSON.stringify(rec))).divergedAt).toBeNull();
    // the battle viewer labels the phones plainly; the record keeps its seats
    const viewer = new ReplayFeed(parseRecord(JSON.stringify(rec)), null, false);
    const hostSide: Faction = red.role === "host" ? "red" : "blue";
    const guestSide: Faction = hostSide === "red" ? "blue" : "red";
    expect(rec.seats[hostSide].player).toBe("sound-duel:host");
    expect(viewer.labels).toEqual({ [hostSide]: `Téléphone hôte · ${OPENERS[rec.openers[hostSide]!].name}`, [guestSide]: `Téléphone invité · ${OPENERS[rec.openers[guestSide]!].name}` });
    // Menu on blue, Rematch on red: the end goes out, then the page reloads (once), the record untouched
    blue.feed!.duel.menu();
    red.feed!.duel.rematch();
    runUntil(r, () => blue.reloads > 0 && red.reloads > 0, 5000);
    runFor(r, 1000);
    for (const p of [blue, red]) {
      expect([p.reloads, p.exits]).toEqual([1, 1]);
      expect(p.local.writes(RECORD_KEY)).toBe(1);
      expect(p.s.phase).toBe("closed");
    }
    // the rematch: same roles and band, the sides swapped
    expect(red.session.getItem(REMATCH_KEY)).toBe("duel");
    const res = red.s.result()!;
    expect(readRematch(red.session)).toEqual({ role: res.role, plan: res.plan, micMode: "raw", hostSide: res.config.hostSide === "blue" ? "red" : "blue", mapId: "riverlands", mutators: [] });
    expect(blue.session.getItem(REMATCH_KEY)).toBeNull();
    expect(blue.aborts).toEqual([]);
  });

  it("is never written on a practice link", { timeout: 60_000 }, () => {
    const r = resigned(true);
    for (const p of [r.host, r.guest]) {
      expect(p.local.writes(RECORD_KEY)).toBe(0);
      expect(p.feed!.outcome).not.toBeNull();
      p.feed!.duel.menu();
    }
    runUntil(r, () => r.host.reloads > 0 && r.guest.reloads > 0, 5000);
    for (const p of [r.host, r.guest]) expect(p.local.writes(RECORD_KEY)).toBe(0);
  });

  it("counts a friend leaving, and this phone leaving, as abandoned (once)", { timeout: 60_000 }, () => {
    const r = pair({ seed: 19 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.leave();
    expect(r.guest.aborts.map((a) => a.reason)).toEqual(["lost"]);
    runUntil(r, () => r.host.aborts.length > 0, 5000);
    runFor(r, 3000);
    expect(r.host.aborts.map((a) => a.reason)).toEqual(["left"]);
    for (const p of [r.host, r.guest]) {
      expect(p.local.writes(RECORD_KEY)).toBe(1);
      expect(readTally(p.local).abandoned).toBe(1);
      expect(p.ctrl!.inFlight).toEqual([]);
    }
    expect(r.guest.s.status().closable).toBe(true);
  });

  it("is written as soon as the match is decided, the end check still running (a phone closed then fires nothing more)", { timeout: 60_000 }, () => {
    const r = pair({ seed: 17 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const blue = sideOf(r, "blue");
    const red = sideOf(r, "red");
    blue.feed!.duel.resign(false);
    // blue's game holds once its resign is sealed: red decides first, its end check waiting on blue's report
    const d0 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d0, 2000);
    blue.hold = true;
    runUntil(r, () => ls(red).decided !== null, 10_000);
    expect(ls(red).endCheck).toBe("pending");
    expect(red.feed!.outcome).toBe("win");
    expect(readTally(red.local)).toEqual({ w: 1, l: 0, d: 0, abandoned: 0, noContest: 0 });
    expect(red.local.writes(RECORD_KEY)).toBe(1);
    blue.hold = false;
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    // in sync: nothing more to write
    expect(red.local.writes(RECORD_KEY)).toBe(1);
    expect(blue.local.writes(RECORD_KEY)).toBe(1);
    expect(readTally(blue.local)).toEqual({ w: 0, l: 1, d: 0, abandoned: 0, noContest: 0 });
  });
});

describe("the page's lifecycle", () => {
  it("switched away: paused at once, counted as abandoned until the match ends, and the friend sees it paused", { timeout: 90_000 }, () => {
    const page = new FakePage();
    const r = pair({ seed: 41, pages: { host: page } });
    expect([page.listeners("visibilitychange"), page.listeners("pagehide")]).toEqual([1, 1]);
    runUntil(r, () => tickOf(r.host) >= 40 && tickOf(r.guest) >= 40, 30_000);
    const host = r.host;
    expect(host.local.writes(RECORD_KEY)).toBe(0);
    // (a hidden page gets no animation frames: its game holds, the feed's own timer pumps on)
    page.hide(true);
    host.hold = true;
    // the frames say paused at once; the match counts as abandoned at once (a phone killed now fires nothing more)
    expect(ls(host).paused).toBe(true);
    expect(host.local.writes(RECORD_KEY)).toBe(1);
    expect(readTally(host.local)).toEqual({ w: 0, l: 0, d: 0, abandoned: 1, noContest: 0 });
    expect(host.feed!.outcome).toBeNull();
    runFor(r, 6000);
    // the friend waits on a paused friend, not a lost one
    expect(ls(r.guest).peerPaused).toBe(true);
    expect(r.guest.s.status().waiting?.why).toBe("paused");
    expect(r.guest.feed!.overlay().stall).toEqual({ kind: "paused", leave: false });
    expect(r.guest.aborts).toEqual([]);
    // back: the match goes on
    page.hide(false);
    host.hold = false;
    expect(ls(host).paused).toBe(false);
    const at = Math.max(tickOf(host), tickOf(r.guest));
    runUntil(r, () => tickOf(host) > at + 10 && tickOf(r.guest) > at + 10, 10_000);
    expect(r.guest.feed!.overlay().stall).toBeNull();
    // switched away again: counted already, nothing more
    page.hide(true);
    page.hide(false);
    expect(host.local.writes(RECORD_KEY)).toBe(1);
    // the match ends: its result takes the stand-in's place (one move); the friend counts it once
    sideOf(r, "blue").feed!.duel.resign(false);
    runUntil(r, () => [host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    const won = host.feed!.local === "red";
    expect(host.feed!.outcome).toBe(won ? "win" : "loss");
    expect(readTally(host.local)).toEqual({ w: won ? 1 : 0, l: won ? 0 : 1, d: 0, abandoned: 0, noContest: 0 });
    expect(host.local.writes(RECORD_KEY)).toBe(2);
    expect(r.guest.local.writes(RECORD_KEY)).toBe(1);
    expect(readTally(r.guest.local).abandoned).toBe(0);
  });

  it("pagehide: into the back-forward cache nothing happens; for good, the match counts and the lobby closes the rig", { timeout: 60_000 }, () => {
    const page = new FakePage();
    const r = pair({ seed: 43, pages: { guest: page } });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const g = r.guest;
    page.pagehide(true);
    runFor(r, 500);
    expect([g.local.writes(RECORD_KEY), g.exits]).toEqual([0, 0]);
    expect(g.s.phase).toBe("match");
    page.pagehide(false);
    expect(g.local.writes(RECORD_KEY)).toBe(1);
    expect(readTally(g.local)).toEqual({ w: 0, l: 0, d: 0, abandoned: 1, noContest: 0 });
    expect(g.feed!.outcome).toBe("abandoned");
    expect(g.exits).toBe(1);
    expect(g.s.phase).toBe("closed");
    expect([page.listeners("visibilitychange"), page.listeners("pagehide")]).toEqual([0, 0]);
    // (the page is going on its own: no reload of ours)
    expect(g.reloads).toBe(0);
    page.pagehide(false);
    expect([g.local.writes(RECORD_KEY), g.exits]).toEqual([1, 1]);
  });
});

describe("what a stalled or resigning player sees", () => {
  /** The host's stall pill as it changes, each with the stall's length when it did, until the stall is `untilMs` long. */
  function pill(r: Run, untilMs: number): [number, string][] {
    const seen: [number, string][] = [];
    runUntil(
      r,
      () => {
        const ms = r.host.s.status().waiting?.ms ?? 0;
        const now = JSON.stringify(r.host.feed!.overlay().stall);
        if (seen.at(-1)?.[1] !== now) seen.push([ms, now]);
        return ms >= untilMs;
      },
      untilMs + 20_000
    );
    return seen;
  }
  const within = (ms: number, from: number) => ms >= from && ms < from + 100;

  it("a friend not heard: Waiting after 0.5 s, Signal lost after 5 s, and its Leave after 30 s", { timeout: 120_000 }, () => {
    const r = pair({ seed: 3 });
    runUntil(r, () => tickOf(r.host) >= 40 && tickOf(r.guest) >= 40, 30_000);
    // the guest's packets stop reaching the host
    r.air.outage(60_000, "ba");
    const seen = pill(r, 31_000);
    expect(seen.map(([, s]) => s)).toEqual([
      "null",
      JSON.stringify({ kind: "wait", leave: false }),
      JSON.stringify({ kind: "lost", leave: false }),
      JSON.stringify({ kind: "lost", leave: true })
    ]);
    expect(within(seen[1]![0], 500) && within(seen[2]![0], 5000) && within(seen[3]![0], 30_000), JSON.stringify(seen)).toBe(true);
    // the pause menu offers Leave too, not "Resign and leave" (nothing heard)
    expect(r.host.feed!.duel.exits()).toEqual({ resignAndLeave: false, leave: true });
    // the pill's Leave: no result, counted as abandoned, the pill gone under the end screen
    r.host.feed!.duel.leave();
    expect(r.host.aborts.map((a) => a.reason)).toEqual(["lost"]);
    expect(readTally(r.host.local).abandoned).toBe(1);
    expect(r.host.feed!.overlay().stall).toBeNull();
  });

  it("a friend paused: its own words, never Signal lost, and Leave only after 60 s", { timeout: 120_000 }, () => {
    const r = pair({ seed: 7 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.ctrl!.paused = true;
    const seen = pill(r, 61_000);
    expect(seen.map(([, s]) => s)).toEqual(["null", JSON.stringify({ kind: "paused", leave: false }), JSON.stringify({ kind: "paused", leave: true })]);
    expect(within(seen[2]![0], 60_000), JSON.stringify(seen)).toBe(true);
    expect(r.host.feed!.duel.exits()).toEqual({ resignAndLeave: true, leave: true });
    // back: the pill goes
    r.guest.ctrl!.paused = false;
    const at = tickOf(r.host);
    runUntil(r, () => tickOf(r.host) > at + 2, 10_000);
    expect(r.host.feed!.overlay().stall).toBeNull();
  });

  it("a friend still loading (no turn of its own yet): \"…to load\", never Signal lost, and Leave only after 60 s", { timeout: 120_000 }, () => {
    const r = pair({ seed: 9, held: "guest" });
    expect(tickOf(r.guest)).toBe(0);
    const seen = pill(r, 61_000);
    expect(tickOf(r.guest)).toBe(0);
    expect(seen.map(([, s]) => s)).toEqual(["null", JSON.stringify({ kind: "load", leave: false }), JSON.stringify({ kind: "load", leave: true })]);
    expect(within(seen[1]![0], 500) && within(seen[2]![0], 60_000), JSON.stringify(seen)).toBe(true);
    // it loads: the match goes on
    r.guest.hold = false;
    runUntil(r, () => tickOf(r.host) > 2 * r.host.s.result()!.delay && tickOf(r.guest) > 2 * r.host.s.result()!.delay, 10_000);
    expect(r.host.feed!.overlay().stall).toBeNull();
  });

  it("\"Resign and leave\": Resigning… until it lands, then straight to the report (the friend's finale plays)", { timeout: 60_000 }, () => {
    const r = pair({ seed: 17 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const g = r.guest;
    expect(g.feed!.duel.exits().resignAndLeave).toBe(true);
    g.feed!.duel.resign(true);
    expect(g.feed!.overlay().resigning).toBe(true);
    expect(g.ctrl!.locked).toBe(true);
    // (the frame that steps the deciding tick skips the finale)
    let before = -1;
    let resigning = true;
    runUntil(
      r,
      () => {
        if (g.feed!.world.winner) return true;
        before = g.skips;
        resigning &&= g.feed!.overlay().resigning;
        return false;
      },
      10_000
    );
    expect([before, resigning]).toEqual([0, true]);
    expect(g.skips).toBeGreaterThan(0);
    expect(g.feed!.overlay().resigning).toBe(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    expect(r.host.skips).toBe(0);
    expect(g.feed!.outcome).toBe("loss");
    expect(g.aborts).toEqual([]);
  });

  it("a plain Resign plays the finale on both phones", { timeout: 60_000 }, () => {
    const r = pair({ seed: 17 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.resign(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    expect([r.host.skips, r.guest.skips]).toEqual([0, 0]);
  });

  it("\"Orders queued\" while more than 2 s of orders wait for room in a turn", { timeout: 60_000 }, () => {
    const r = pair({ seed: 5 });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const p = r.host;
    const side = p.feed!.local;
    const hq = hqOf(p.feed!.world, side)!;
    expect(p.feed!.overlay().queued).toBe(false);
    // (a robust link's turns carry a few rally points a second)
    for (let i = 0; i < 40; i++) p.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 10.5 + (i % 20), y: 12.5 + Math.floor(i / 20) });
    let most = 0;
    runUntil(
      r,
      () => {
        most = Math.max(most, ls(p).queuedTicks);
        return p.feed!.overlay().queued;
      },
      20_000
    );
    expect(most).toBeGreaterThan(20);
    // it drains: the pill goes
    runUntil(r, () => ls(p).queued === 0, 60_000);
    expect(p.feed!.overlay().queued).toBe(false);
  });
});

describe("the duel's record when the worlds drift apart", () => {
  /**
   * Red's world drifts from blue's (one scrap) and blue resigns. Blue's game holds once the resign is sealed,
   * so red is decided first, its end check waiting on blue's report; `then` runs there, and blue plays on.
   */
  function drifted(then: (r: Run, red: Phone, blue: Phone) => void): { r: Run; red: Phone } {
    const r = pair({ seed: 31 });
    runUntil(r, () => tickOf(r.host) >= 10 && tickOf(r.guest) >= 10, 30_000);
    const red = sideOf(r, "red");
    const blue = sideOf(r, "blue");
    red.feed!.world.factions.red.scrap += 1;
    blue.feed!.duel.resign(false);
    const d0 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d0, 2000);
    blue.hold = true;
    runUntil(r, () => ls(red).decided !== null, 10_000);
    expect(ls(red).endCheck).toBe("pending");
    expect(red.feed!.world.winner).toBe("red");
    then(r, red, blue);
    blue.hold = false;
    return { r, red };
  }

  it("moves the win counted at the decision to no contest when the end check fails while Rematch waits", { timeout: 60_000 }, () => {
    const { r, red } = drifted((_, p) => {
      // (counted at the decision, the end check still running)
      expect([p.feed!.outcome, p.local.writes(RECORD_KEY)]).toEqual(["win", 1]);
      p.feed!.duel.rematch();
    });
    runUntil(r, () => red.reloads > 0, 5000);
    expect(ls(red).desync).toBe(true);
    expect(red.feed!.outcome).toBe("noContest");
    expect(readTally(red.local)).toEqual({ w: 0, l: 0, d: 0, abandoned: 0, noContest: 1 });
    expect(red.local.writes(RECORD_KEY)).toBe(2);
  });

  it("turns a result still counted at Not verified into no contest when the friend then reports the desync", { timeout: 60_000 }, () => {
    // blue's packets don't reach red for 12 s: red's end check runs out first
    const { r, red } = drifted((run, _, blue) => run.air.outage(12_000, blue.role === "host" ? "ab" : "ba"));
    expect(red.feed!.outcome).toBe("win");
    runUntil(r, () => ls(red).endCheck === "unverified", 15_000);
    expect(red.feed!.outcome).toBe("win");
    expect(readTally(red.local).w).toBe(1);
    expect(red.feed!.reportView().sync).toBe("unverified");
    runUntil(r, () => red.aborts.length > 0, 10_000);
    expect(red.aborts.map((a) => a.reason)).toEqual(["desync"]);
    expect(red.feed!.outcome).toBe("noContest");
    expect(readTally(red.local)).toEqual({ w: 0, l: 0, d: 0, abandoned: 0, noContest: 1 });
    expect(red.local.writes(RECORD_KEY)).toBe(2);
    expect(red.feed!.reportView()).toMatchObject({ sync: "desync", record: "0 victoire · 0 défaite · 0 nul · 1 sans résultat" });
  });
});

/** The rig as the feed reads it: lost on demand, its reconnects working or failing as told. */
class FakeRig implements DuelRig {
  state: RigState = "running";
  failures = 0;
  lastError: RigError | null = null;
  micMode: MicMode = "raw";
  /** What the next reconnect resolves, and the reason it fails with (null: a context that didn't start, where the rig has none). */
  works = false;
  error: RigError | null = null;
  capture = 2000;
  private readonly lost = new Set<(reason: LostReason) => void>();
  onLost(fn: (reason: LostReason) => void): () => void {
    this.lost.add(fn);
    return () => this.lost.delete(fn);
  }
  lose(reason: LostReason = "context"): void {
    this.state = "lost";
    this.capture = 0;
    for (const f of this.lost) f(reason);
  }
  reconnect(): Promise<boolean> {
    if (this.works) {
      this.state = "running";
      this.failures = 0;
      this.lastError = null;
    } else {
      this.failures++;
      this.lastError = this.error;
    }
    return Promise.resolve(this.works);
  }
  captureOkMs(): number {
    return this.capture;
  }
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("the reconnect cover", () => {
  it("covers the match until the tap works, offers Leave after 2 failures, and never covers the end screen", { timeout: 60_000 }, async () => {
    const rig = new FakeRig();
    const r = pair({ seed: 37, rigs: { host: rig } });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const f = r.host.feed!;
    expect(f.overlay().reconnect).toBeNull();
    rig.lose();
    expect(f.overlay().reconnect).toEqual({ phase: "lost", leave: false, why: null });
    f.reconnect();
    expect(f.overlay().reconnect).toEqual({ phase: "trying", leave: false, why: null });
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "failed", leave: false, why: null });
    // it works: "Listening…" until capture has run gap-free for 1.5 s
    rig.works = true;
    f.reconnect();
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "settling", leave: false, why: null });
    rig.capture = 1600;
    f.pump();
    expect(f.overlay().reconnect).toBeNull();
    // lost again, and two taps fail: Leave
    rig.works = false;
    rig.lose();
    for (let i = 0; i < 2; i++) {
      f.reconnect();
      await settled();
    }
    expect(f.overlay().reconnect).toEqual({ phase: "failed", leave: true, why: null });
    // the cover's Leave: no result, and the end screen isn't covered (its Main menu is the way out)
    f.duel.leave();
    expect(r.host.aborts.map((a) => a.reason)).toEqual(["lost"]);
    expect(f.overlay().reconnect).toBeNull();
    expect(f.reportView().relink).toBeNull();
  });

  it("leaves a decided match's report uncovered: the report offers the reconnect instead", { timeout: 60_000 }, async () => {
    const rig = new FakeRig();
    const r = pair({ seed: 17, rigs: { host: rig } });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.resign(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    const f = r.host.feed!;
    expect(f.reportView().relink).toBeNull();
    rig.lose();
    f.pump();
    expect(f.overlay().reconnect).toBeNull();
    expect(f.reportView().relink).toEqual({ phase: "lost", why: null });
    for (let i = 0; i < 3; i++) {
      f.reconnect();
      await settled();
    }
    expect(f.overlay().reconnect).toBeNull();
    expect(f.reportView().relink).toEqual({ phase: "failed", why: null });
    // the report's button says why as the cover does
    rig.error = new RigError("mic-refused");
    f.reconnect();
    await settled();
    const why = "Micro refusé. Autorise le micro pour ce site dans les réglages du navigateur, puis réessaie.";
    expect(f.reportView().relink).toEqual({ phase: "failed", why });
    expect(duelReportSection(() => f.reportView(), { reconnect: () => undefined }).render({} as ReportContext)).toContain(`<small>${why}</small>`);
    rig.works = true;
    f.reconnect();
    await settled();
    expect(f.reportView().relink).toEqual({ phase: "settling", why: null });
    rig.capture = 1600;
    f.pump();
    expect(f.reportView().relink).toBeNull();
  });

  it("says why a tap failed when the rig knows, with the lobby's advice for it; Leave still after 2 failures", { timeout: 60_000 }, async () => {
    const rig = new FakeRig();
    const r = pair({ seed: 37, rigs: { host: rig } });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const f = r.host.feed!;
    rig.lose();
    // a Bluetooth headset joined: the microphone it brings runs at 16 kHz
    rig.error = new RigError("rate", "Le micro de ce téléphone tourne à 16000 Hz, inutilisable pour la liaison sonore");
    f.reconnect();
    expect(f.overlay().reconnect).toEqual({ phase: "trying", leave: false, why: null });
    await settled();
    expect(f.overlay().reconnect).toEqual({
      phase: "failed",
      leave: false,
      why: "Le micro de ce téléphone tourne à 16000 Hz, inutilisable pour la liaison sonore. Réessaie avec le casque et le Bluetooth déconnectés."
    });
    // a reason with no advice of its own: its words alone
    rig.error = new RigError("no-mic");
    f.reconnect();
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "failed", leave: true, why: "Aucun micro disponible : ferme les autres applis qui l'utilisent et réessaie." });
    // the context didn't start: the rig has no reason, so the cover's own words
    rig.error = null;
    f.reconnect();
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "failed", leave: true, why: null });
  });

  it("covers the match for a modem that stopped, as for any loss, and the tap brings it back", { timeout: 60_000 }, async () => {
    const rig = new FakeRig();
    const r = pair({ seed: 37, rigs: { host: rig } });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const f = r.host.feed!;
    rig.lose("modem");
    expect(f.overlay().reconnect).toEqual({ phase: "lost", leave: false, why: null });
    rig.works = true;
    f.reconnect();
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "settling", leave: false, why: null });
    rig.capture = 1600;
    f.pump();
    expect(f.overlay().reconnect).toBeNull();
  });
});

describe("the report after the match", () => {
  it("says when the friend is back in the lobby (its reloaded page, under a new nonce)", { timeout: 60_000 }, () => {
    const r = pair({ seed: 17 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.resign(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    const f = r.host.feed!;
    expect(f.reportView().friendInLobby).toBe(false);
    // the friend taps Rematch: its end goes out, then its page reloads
    r.guest.feed!.duel.rematch();
    runUntil(r, () => r.guest.reloads > 0, 5000);
    runFor(r, 1500);
    expect(f.reportView().friendInLobby).toBe(false);
    // the reloaded page opens the same phone's link and pairs again: lobby frames
    Object.assign(r.air.b, { closed: false });
    const again = new Session({ transport: r.air.b, role: "guest", build: BUILD, random: rng(99) });
    runUntil(r, () => (again.pump(), f.reportView().friendInLobby), 5000);
    expect(f.abortReason).toBeNull();
    expect(f.outcome).toBe("win");
  });
});

/** A world of the duels' map, no feed. */
const setupLikeWorld = (): World => setupWorld({ map: "riverlands", seed: 1, mutators: [], openers: {} });
