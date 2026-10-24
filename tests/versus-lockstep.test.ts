import { describe, expect, it } from "vitest";
import { endOf, replay, type BattleRecord } from "../src/arena/record";
import { parseRecord } from "../src/game/replay";
import { PacketAir, type PacketAirOptions } from "../src/link/packet-air";
import { nextFrameIndex, type LinkTransport, type ModemMode, type OutFrame } from "../src/link/transport";
import { createAiState, tickAi, type AiState, type StrategyName } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { allowedOpener, pickAiOpener, type OpenerId } from "../src/sim/openers";
import { hash32 } from "../src/sim/rand";
import type { MutatorId } from "../src/sim/rules";
import { setupWorld, type MatchSetup } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { Command, Faction, World } from "../src/sim/types";
import { hqOf, spawnUnit } from "../src/sim/world";
import { BitWriter, C_MAX, canonicalize, commandBits, encodeCommands } from "../src/versus/codec";
import {
  AHEAD_MAX, CHECKPOINT_EVERY, END_CHECK_MS, HEADER_MAX, Lockstep, SLACK_FRAMES, TRAIL_START, foldTrail, minCapacity, readGameFrame, rxqOf, segmentsFor,
  unwrap16
} from "../src/versus/lockstep";

const MAP = { width: 56, height: 56 };

// ------------------------------------------------------------- the wire ---

/** Every frame list a lockstep hands out: at most K frames, keys ascending, each frame within capacity. */
function checkList(ls: Lockstep, frames: readonly OutFrame[]): void {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.length).toBeLessThanOrEqual(ls.segmentsMax);
  frames.forEach((f, i) => {
    expect(f.nbits).toBeLessThanOrEqual(ls.capacity);
    if (i > 0) expect(f.key).toBeGreaterThan(frames[i - 1]!.key);
  });
}

/**
 * Two Locksteps on a perfect wire: each exchange() is one packet each way, the frame after the last one sent in
 * key rotation, as a transport sends them; the clock moves with advance().
 */
function wire(o: { delay?: number; capacity?: number; setupHash?: number; segmentsMax?: number } = {}) {
  let t = 0;
  const now = () => t;
  const mk = (local: Faction) =>
    new Lockstep({
      local, delay: o.delay ?? 4, mapWidth: MAP.width, mapHeight: MAP.height, capacity: o.capacity ?? 188, setupHash: o.setupHash ?? 0x1234, now,
      segmentsMax: o.segmentsMax
    });
  const a = mk("blue");
  const b = mk("red");
  const sizes: number[] = [];
  const lastKey = new Map<Lockstep, number | null>([[a, null], [b, null]]);
  /** The frame `ls`'s next packet carries. */
  const packet = (ls: Lockstep): OutFrame => {
    const { frames } = ls.frames();
    checkList(ls, frames);
    const f = frames[nextFrameIndex(frames, lastKey.get(ls)!)]!;
    lastKey.set(ls, f.key);
    return f;
  };
  const exchange = (dir: "both" | "ab" | "ba" = "both") => {
    const fa = packet(a);
    const fb = packet(b);
    sizes.push(fa.nbits, fb.nbits);
    if (dir !== "ba") b.receive(fa.bits, fa.nbits, t);
    if (dir !== "ab") a.receive(fb.bits, fb.nbits, t);
  };
  return { a, b, exchange, packet, sizes, advance: (ms: number) => void (t += ms), now };
}


/** Step a lockstep's tick if it can, folding a stand-in world hash; returns the commands or null. */
function tryStep(ls: Lockstep, drain: () => Command[] = () => [], hash = (t: number) => hash32(t, 77), decided: (t: number) => boolean = () => false) {
  const t = ls.status().tick;
  const cmds = ls.commandsFor(t, drain);
  if (cmds) ls.afterStep(t, hash(t), decided(t) ? { winner: "blue", resigned: null } : null);
  return cmds;
}

/** A hand-built game frame, for the rejection and out-of-order cases: `turns` are absolute and ascending. */
function rawFrame(f: { type?: number; to: number; span?: number; tickLag?: number; ack?: number; nonEmpty?: number; turns?: [number, Command[]][] }) {
  const wr = new BitWriter();
  wr.bits(f.type ?? 1, 2);
  wr.bits(0, 1 + 2 + 3);
  wr.bits(f.to & 0xffff, 16);
  wr.ue(f.span ?? 0);
  wr.se(f.tickLag ?? 0);
  wr.se(f.ack ?? 0);
  const turns = f.turns ?? [];
  wr.ue(f.nonEmpty ?? turns.length);
  let next = f.to - (f.span ?? 0);
  for (const [turn, cmds] of turns) {
    wr.ue(turn - next);
    wr.ue(cmds.length - 1);
    encodeCommands(wr, cmds, MAP);
    next = turn + 1;
  }
  wr.bit(0);
  return { bits: wr.bytes(), nbits: wr.nbits };
}

describe("lockstep turns and frames", () => {
  it("starts holding turns 0 … D−1, with a one-turn frame", () => {
    const { a } = wire({ delay: 5 });
    const s = a.status();
    expect([s.tick, s.newestSealed, s.ackThrough, s.peerAck, s.slack]).toEqual([0, 4, 4, 4, 4]);
    expect(a.trail()).toBe(foldTrail(TRAIL_START, 0x1234));
    const l = a.frames();
    expect(l.frames.length).toBe(1);
    const f = l.frames[0]!;
    expect(f.key).toBe(4);
    expect(f.nbits).toBeLessThanOrEqual(HEADER_MAX);
    const g = readGameFrame(f.bits, f.nbits, MAP, "blue", 4);
    expect(g).toMatchObject({ from: 4, to: 4, tickLag: 4, ack: 0, turns: [], end: "playing", paused: false, checkpoint: null });
    expect(a.frames().version).toBe(l.version); // (unchanged: no rebuild)
    expect([a.segmentsMax, segmentsFor(3), segmentsFor(4), segmentsFor(5), segmentsFor(6), segmentsFor(8)]).toEqual([3, 1, 2, 3, 4, 4]);
  });

  it("seals once per tick, and stalls at tick D without the peer", () => {
    const { a, advance } = wire({ delay: 4 });
    let drained = 0;
    const drain = () => {
      drained++;
      return [{ type: "stop", faction: "blue", unitIds: [drained] } as Command];
    };
    for (let t = 0; t < 4; t++) expect(tryStep(a, drain)).toEqual([]); // (turns 0 … D−1 are empty)
    for (let i = 0; i < 5; i++) {
      expect(tryStep(a, drain)).toBeNull();
      advance(100);
    }
    expect(drained).toBe(5); // ticks 0 … 4 sealed turns 4 … 8, once each
    const s = a.status();
    expect(s).toMatchObject({ tick: 4, stalled: true, newestSealed: 8, ackThrough: 3, slack: -1 });
    expect(s.stallMs).toBe(500);
  });

  it("steps the same decoded commands on both phones, blue's first", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    const raw: Record<Faction, Command> = {
      blue: { type: "move", faction: "blue", unitIds: [9, 3, 3], x: 10.123456, y: 7.77 },
      red: { type: "attack", faction: "blue" /* (stamped by the receiver as red) */, unitIds: [44], targetId: 3 }
    };
    const stepped: Record<Faction, Command[][]> = { blue: [], red: [] };
    for (let t = 0; t < 12; t++) {
      for (const [ls, side] of [[a, "blue"], [b, "red"]] as const) {
        const cmds = tryStep(ls, () => (t === 0 ? [raw[side]] : []));
        if (cmds) stepped[side].push(cmds);
      }
      exchange();
    }
    expect(stepped.blue).toEqual(stepped.red);
    const ctx = { width: 56, height: 56 };
    expect(stepped.blue[4]).toEqual([...canonicalize(raw.blue, { ...ctx, local: "blue" }), ...canonicalize(raw.red, { ...ctx, local: "red" })]);
    expect(stepped.blue[4]![0]).toEqual({ type: "move", faction: "blue", unitIds: [3, 9], x: 161.5 / 16, y: 124.5 / 16 });
    expect(stepped.blue[4]![1]!.faction).toBe("red");
    expect(a.turns()).toEqual(b.turns());
    expect(a.turns()).toEqual([[4, "blue", [stepped.blue[4]![0]]], [4, "red", [stepped.blue[4]![1]]]]);
    expect(a.trail()).toBe(b.trail());
  });

  it("keeps every frame within capacity, and queued orders go out as acks come back", () => {
    const { a, b, exchange, sizes } = wire({ delay: 4 });
    // 40 orders at once, many of them long lists: far more than one frame holds
    const burst: Command[] = [];
    for (let i = 0; i < 40; i++)
      burst.push(
        i % 3 === 0
          ? { type: "attackMove", faction: "blue", unitIds: Array.from({ length: 30 }, (_, j) => 300 + i * 50 + j * 7), x: i + 0.3, y: 20.7 }
          : i % 3 === 1
            ? { type: "produce", faction: "blue", buildingId: 100 + i, unit: "scout" }
            : { type: "rally", faction: "blue", buildingId: 3, x: i * 1.1, y: 4.4 }
      );
    const want = burst.flatMap((c) => canonicalize(c, { local: "blue", ...MAP }));
    expect(want.length).toBeGreaterThan(55);
    let maxQueued = 0;
    for (let t = 0; t < 400; t++) {
      tryStep(a, () => (t === 0 ? burst : []));
      tryStep(b);
      maxQueued = Math.max(maxQueued, a.status().queued);
      // acks come back three ticks later, as over the air
      if (t % 3 === 0) exchange();
    }
    expect(maxQueued).toBeGreaterThan(30);
    expect(a.status().queued).toBe(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(188);
    const got = b.turns().filter(([, side]) => side === "blue");
    for (const [, , cmds] of got) {
      expect(cmds.length).toBeLessThanOrEqual(15);
      expect(cmds.reduce((n, c) => n + commandBits(c, MAP), 0)).toBeLessThanOrEqual(a.turnMax);
    }
    expect(got.flatMap(([, , cmds]) => cmds)).toEqual(want);
    // (frames take turns in rotation, so the two may stop a tick or two apart: bring both to the same tick)
    for (let i = 0; i < 6; i++) exchange();
    while (a.status().tick < b.status().tick) tryStep(a);
    while (b.status().tick < a.status().tick) tryStep(b);
    expect(a.trail()).toBe(b.trail());
  });

  it("takes only game frames it can trust", () => {
    const { a } = wire({ delay: 4 });
    const before = a.status();
    const lobby = new Uint8Array(24);
    lobby[0] = 0b10000000;
    expect(a.receive(lobby, 188, 0)).toBe("lobby");
    expect(a.status().peerInLobby).toBe(true);
    expect(a.receive(new Uint8Array(24), 188, 0)).toBe("invalid"); // (all zeros: no payload yet)
    expect(a.receive(new Uint8Array(24).fill(255), 188, 0)).toBe("invalid");
    expect(a.status().framesBad).toBe(0);
    const ok = rawFrame({ to: 3 });
    expect(a.receive(ok.bits, 188, 0)).toBe("game");
    expect(a.status().peerInLobby).toBe(false);
    const bad = [
      { ...rawFrame({ to: 3 }), nbits: 20 }, // truncated
      rawFrame({ to: 3 + 201 }), // `to` too far from the last one
      rawFrame({ to: 70, span: 65 }), // span > 64
      rawFrame({ to: 3, span: 5 }), // from < 0
      rawFrame({ to: 10, span: 2, nonEmpty: 4 }) // more non-empty turns than turns
    ];
    for (const f of bad) expect(a.receive(f.bits, f.nbits, 0)).toBe("invalid");
    const after = a.status();
    expect(after.framesBad).toBe(bad.length);
    expect([after.ackThrough, after.peerAck, after.newestSealed]).toEqual([before.ackThrough, before.peerAck, before.newestSealed]);
    // a `to` past 65535 unwraps to the value nearest the last one
    expect(unwrap16(5, 65530)).toBe(65541);
    expect(unwrap16(65530, 5)).toBe(-6);
    expect(unwrap16(1234, 1234 + 65536 * 3)).toBe(1234 + 65536 * 3);
  });

  it("is unharmed by duplicate, stale and reordered frames", () => {
    const { a, b, advance } = wire({ delay: 5 });
    const old: { bits: Uint8Array; nbits: number }[] = [];
    let seed = 5;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let t = 0; t < 600; t++) {
      tryStep(a, () => (t % 7 === 0 ? [{ type: "attackMove", faction: "blue", unitIds: [t, t + 2], x: t % 50, y: 3 }] : []));
      tryStep(b, () => (t % 5 === 0 ? [{ type: "produce", faction: "red", buildingId: t, unit: "wasp" }] : []));
      old.push(...b.frames().frames);
      // a hears b's frames late, twice, and now and then one from the past
      if (rnd() < 0.7) {
        const f = old[Math.max(0, old.length - 1 - Math.floor(rnd() * 4))]!;
        a.receive(f.bits, f.nbits, t * 100);
        a.receive(f.bits, f.nbits, t * 100);
      }
      if (rnd() < 0.2) {
        const f = old[Math.floor(rnd() * old.length)]!;
        a.receive(f.bits, f.nbits, t * 100);
      }
      const la = a.frames().frames;
      const fa = la[Math.floor(rnd() * la.length)]!;
      if (rnd() < 0.7) b.receive(fa.bits, fa.nbits, t * 100);
      advance(100);
    }
    expect(a.status().tick).toBeGreaterThan(300);
    const n = Math.min(a.status().tick, b.status().tick);
    const upTo = (ls: Lockstep) => ls.turns().filter(([t]) => t < n);
    expect(upTo(a)).toEqual(upTo(b));
    // (frames from more than 200 turns ago are rejected, harmlessly)
    expect(a.status().framesBad).toBeGreaterThan(0);
  });

  it("pauses locally: frames say so, nothing is sealed, and the peer stalls within D ticks", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    for (let t = 0; t < 20; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    a.setPaused(true);
    let drained = 0;
    const sealed = a.status().newestSealed;
    for (let t = 0; t < 30; t++) {
      expect(tryStep(a, () => (drained++, []))).toBeNull();
      tryStep(b);
      exchange();
    }
    expect(drained).toBe(0);
    expect(a.status().newestSealed).toBe(sealed);
    for (const f of a.frames().frames) expect(readGameFrame(f.bits, f.nbits, MAP, "blue", sealed).paused).toBe(true);
    const sb = b.status();
    expect(sb).toMatchObject({ stalled: true, peerPaused: true });
    expect(sb.tick - a.status().tick).toBeLessThanOrEqual(4 + 1);
    a.setPaused(false);
    for (let t = 0; t < 30; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    expect(b.status().peerPaused).toBe(false);
    expect(a.status().tick).toBeGreaterThan(40);
    expect(a.turns()).toEqual(b.turns());
  });

  it("tells the peer a new receive quality at once, stalled or not", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    for (let t = 0; t < 10; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    // b goes quiet: a steps until it stalls, and from then on it seals nothing and no ack moves, so nothing else would
    // rebuild its frames (the peer picks its transmit mode from the quality they say)
    while (tryStep(a));
    expect(a.status().stalled).toBe(true);
    const { version } = a.frames();
    a.setRxq(5);
    const f = a.frames();
    expect(f.version).not.toBe(version);
    for (const g of f.frames) expect(readGameFrame(g.bits, g.nbits, MAP, "blue", a.status().newestSealed).rxq).toBe(5);
    // the same quality again rebuilds nothing
    a.setRxq(5.9);
    expect(a.frames().version).toBe(f.version);
    exchange("ab");
    expect(b.status().peerRxq).toBe(5);
  });

  it("trims by the slack this phone's packets said, as its friend's frames say theirs: not by its slack since", () => {
    const { a, b, exchange, advance, now } = wire({ delay: 6 });
    for (let t = 0; t < 2; t++) {
      tryStep(b);
      exchange();
    }
    exchange();
    // a's frames go out in a packet: the trim compares what they said with what b's newest said
    a.frames();
    const said = a.status().slack;
    const peer = a.status().peerSlack!;
    advance(10);
    a.slot(now());
    expect(a.speed()).toBeCloseTo(1 + 0.02 * (said - peer), 12);
    // a steps: its slack is a tick less, but its packets say what they said until the next one carries new frames
    tryStep(a);
    expect(a.status().slack).toBe(said - 1);
    expect(a.speed()).toBeCloseTo(1 + 0.02 * (said - peer), 12);
    a.frames();
    a.slot(now()); // (a packet that started as they were handed over still carried the old ones)
    expect(a.speed()).toBeCloseTo(1 + 0.02 * (said - peer), 12);
    advance(10);
    a.slot(now());
    expect(a.speed()).toBeCloseTo(1 + 0.02 * (said - 1 - peer), 12);
  });

  it("balances the two phones' slack, their speeds summing to 2", () => {
    const { a, b, exchange } = wire({ delay: 6 });
    expect(a.speed()).toBe(1); // (no peer frame yet)
    // b runs ahead: it holds fewer of a's turns than a holds of b's
    for (let t = 0; t < 2; t++) {
      tryStep(b);
      exchange();
    }
    exchange(); // (each now holds the other's current slack)
    const sa = a.status();
    const sb = b.status();
    expect(sa.peerSlack).toBe(sb.slack);
    expect(a.speed()).toBeCloseTo(1 + 0.02 * (sa.slack - sb.slack), 12);
    expect(a.speed()).toBeGreaterThan(1);
    expect(a.speed() + b.speed()).toBeCloseTo(2, 12);
    // (clamped to ±10%)
    for (let t = 0; t < 4; t++) {
      tryStep(b);
      exchange();
    }
    exchange();
    expect([a.speed(), b.speed()]).toEqual([1.1, 0.9]);
    expect(rxqOf(null)).toBe(0);
    expect([-3, 0, 8.9, 9, 20, 21, 99].map(rxqOf)).toEqual([0, 0, 2, 3, 6, 7, 7]);
  });

  it("ends both phones as desync when a checkpoint differs", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    // a's world drifts at tick 120: its trail differs from then on
    const drift = (t: number) => hash32(t, 77) ^ (t >= 120 ? 1 : 0);
    for (let i = 0; i < 300 && !(a.over() && b.over()); i++) {
      tryStep(a, undefined, drift);
      tryStep(b);
      exchange();
    }
    for (const s of [a.status(), b.status()]) expect(s.desync).toBe(true);
    expect([a.status().desyncReason, b.status().desyncReason]).toContain("checkpoint");
    expect(Math.max(a.status().tick, b.status().tick)).toBeLessThanOrEqual(150 + 4 + 2);
    // and the debug trails show where
    expect(a.debug().own.map(([t]) => t)).toEqual([0, 50, 100, 150].filter((t) => t < a.status().tick));
  });

  it("checks the end: in sync, out of sync, one-sided, unanswered", () => {
    const end = (o: { hashA?: (t: number) => number; decidedA: (t: number) => boolean; decidedB: (t: number) => boolean; deaf?: boolean }) => {
      const w = wire({ delay: 4 });
      for (let i = 0; i < 200; i++) {
        tryStep(w.a, undefined, o.hashA, o.decidedA);
        tryStep(w.b, undefined, undefined, o.decidedB);
        // (deaf: a stops hearing b once a's world is decided)
        w.exchange(o.deaf && w.a.status().end === "decided" ? "ab" : "both");
        w.advance(100);
      }
      return [w.a.status(), w.b.status()] as const;
    };
    const at = (T: number) => (t: number) => t === T;
    // both decided at 70 with equal trails
    let [sa, sb] = end({ decidedA: at(70), decidedB: at(70) });
    expect([sa.endCheck, sb.endCheck]).toEqual(["ok", "ok"]);
    expect(sa).toMatchObject({ end: "decided", peerEnd: "decided", desync: false, decided: { tick: 70, winner: "blue" } });
    // both decided at 70, but the worlds drifted at 60 (after the last checkpoint)
    [sa, sb] = end({ hashA: (t) => hash32(t, 77) + (t >= 60 ? 1 : 0), decidedA: at(70), decidedB: at(70) });
    expect([sa.desync, sb.desync]).toEqual([true, true]);
    expect([sa.endCheck, sb.endCheck]).toEqual(["mismatch", "mismatch"]);
    expect(sa.desyncReason).toBe("end");
    // only a's world is decided at 70: b steps 70 without a decision
    [sa, sb] = end({ decidedA: at(70), decidedB: () => false });
    expect([sa.desync, sb.desync]).toEqual([true, true]);
    expect(sb.desyncReason).toBe("end");
    expect(sa.desyncReason).toBe("peer");
    // a never hears b's end report: "Not verified" after 10 s
    [sa, sb] = end({ decidedA: at(70), decidedB: at(70), deaf: true });
    expect(sa.endCheck).toBe("unverified");
    expect(sb.endCheck).toBe("ok");
    expect(END_CHECK_MS).toBe(10_000);
  });

  it("gets the end report through when the turns around the decision are full", () => {
    const T = 70;
    // as many orders as a turn takes: the window rule fills turn tick + D almost to TURN_MAX
    const many = (): Command[] =>
      Array.from({ length: 15 }, (_, j): Command => ({ type: "produce", faction: "blue", buildingId: 1000 + j, unit: "scout" }));
    // the full turn is T + D (past the decision: no one steps it) or T itself (the peer needs it to check the end)
    for (const fullTurn of [T + 4, T])
      for (const oneSided of [false, true]) {
        const { a, b, exchange, advance } = wire({ delay: 4 });
        let endless = 0; // (a's frames after its decision that had to leave the end report out)
        let filled = 0; // (the orders the full turn took)
        for (let i = 0; i < 200; i++) {
          const before = a.status().tick;
          tryStep(a, () => (a.status().tick === fullTurn - 4 ? many() : []), undefined, (t) => t === T);
          if (before === fullTurn - 4) filled = 15 - a.status().queued;
          tryStep(b, undefined, undefined, (t) => !oneSided && t === T);
          if (a.status().decided && a.status().end === "decided") {
            const list = a.frames().frames;
            const g = list.map((f) => readGameFrame(f.bits, f.nbits, MAP, "blue", a.status().newestSealed));
            // (the report rides in the newest segment's frame alone)
            if (g.at(-1)!.end === "playing") endless++;
            for (const h of g.slice(0, -1)) expect(h.end).toBe("playing");
            // (past the decision every turn is described as empty)
            for (const h of g) for (const [turn] of h.turns) expect(turn).toBeLessThanOrEqual(T);
          }
          exchange();
          advance(100);
        }
        const [sa, sb] = [a.status(), b.status()];
        const label = `full turn ${fullTurn}, ${oneSided ? "one-sided" : "in sync"}`;
        // the turn really was full (and when it's T, the peer stepped it)
        expect(filled, label).toBeGreaterThanOrEqual(3);
        if (fullTurn === T) expect(b.turns().find(([t, side]) => t === T && side === "blue")?.[2].length, label).toBe(filled);
        expect(endless, label).toBeLessThanOrEqual(3);
        if (!oneSided) {
          expect([sa.endCheck, sb.endCheck], label).toEqual(["ok", "ok"]);
          expect([sa.peerEnd, sb.peerEnd], label).toEqual(["decided", "decided"]);
        } else {
          // b steps T without a decision, hears a's report and ends, instead of stalling for good at T + D + 1
          expect([sa.desync, sb.desync], label).toEqual([true, true]);
          expect([sa.desyncReason, sb.desyncReason], label).toEqual(["peer", "end"]);
          expect([sa.endCheck, sb.endCheck], label).toEqual(["mismatch", "mismatch"]);
          expect(sb.tick, label).toBe(T + 1);
          expect(b.over(), label).toBe(true);
        }
      }
  });

  it("can't be pushed out of step by garbage frames that pass the CRC", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    for (let t = 0; t < 100; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    // frames 150 turns apart, each within 200 of the one before it: had each moved the expectation, the real
    // ones would be out of reach (`to` is expected near ackThrough, which only turns taken move)
    const { ackThrough, peerAck } = a.status();
    const got = [150, 300, 450].map((d) => {
      const f = rawFrame({ to: ackThrough + d, ack: peerAck - (ackThrough + d) });
      return a.receive(f.bits, f.nbits, 0);
    });
    expect(got).toEqual(["game", "invalid", "invalid"]);
    expect(a.status()).toMatchObject({ ackThrough, peerAck, framesBad: 2 });
    for (let t = 0; t < 300; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    expect(a.status()).toMatchObject({ tick: 400, framesBad: 2, stalled: false });
    expect(b.status().tick).toBe(400);
  });

  describe("the order queue", () => {
    /** Blue's commands as the peer stepped them, [tick, command], over a wire where blue drains orders(tick) and frames cross every tick. */
    const blueSteps = (orders: (tick: number) => Command[], ticks = 150) => {
      const { a, b, exchange } = wire({ delay: 4 });
      for (let i = 0; i < ticks; i++) {
        tryStep(a, () => orders(a.status().tick));
        tryStep(b);
        exchange();
      }
      expect(a.status().queued).toBe(0);
      expect(a.turns()).toEqual(b.turns());
      return b.turns().flatMap(([t, side, cmds]) => (side === "blue" ? cmds.map((c) => [t, c] as const) : []));
    };
    const U = Array.from({ length: 30 }, (_, i) => 400 + i * 41); // (5 pieces)
    const F = Array.from({ length: 30 }, (_, i) => 3000 + i * 41); // (filler: keeps the window busy for a few ticks)
    const move = (unitIds: number[], x: number): Command => ({ type: "move", faction: "blue", unitIds, x, y: 10 });
    const idsOf = (cs: readonly Command[]) => cs.flatMap((c) => ("unitIds" in c ? c.unitIds : []));
    const at = (x: number) => (c: Command) => c.type === "move" && Math.floor(c.x) === x;

    it("lets a newer move replace the queued pieces of an older one, the longest waiting first", () => {
      const steps = blueSteps((t) => (t === 0 ? [move(U, 10)] : t === 1 ? [move(U, 20)] : []));
      const first = steps.map(([, c]) => c).filter(at(10));
      const second = steps.map(([, c]) => c).filter(at(20));
      const pieces = canonicalize(move(U, 10), { local: "blue", ...MAP }).length;
      // only what went out before the second order: its other pieces were dropped
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(pieces);
      // every unit gets the second order, the ones that lost the first one before the rest
      const sent = new Set(idsOf(first));
      expect(idsOf(second)).toEqual([...U.filter((id) => !sent.has(id)), ...U.filter((id) => sent.has(id))]);
    });

    it("keeps a queued order when anything queued after it names one of its units", () => {
      const board: Command = { type: "board", faction: "blue", unitIds: [U[29]!], carrierId: 7 };
      const steps = blueSteps((t) => (t === 0 ? [move(U, 10), board] : t === 1 ? [move(U, 20)] : [])).map(([, c]) => c);
      const firstWith = (pred: (c: Command) => boolean) => steps.findIndex((c) => pred(c) && idsOf([c]).includes(U[29]!));
      // the piece of the first move that names the boarding unit still goes out, then the board, then the second move
      expect(firstWith(at(10))).toBeGreaterThanOrEqual(0);
      expect(firstWith(at(10))).toBeLessThan(steps.indexOf(steps.find((c) => c.type === "board")!));
      expect(steps.findIndex((c) => c.type === "board")).toBeLessThan(firstWith(at(20)));
      expect(new Set(idsOf(steps.filter(at(20))))).toEqual(new Set(U));
    });

    it("replaces only what the sim overrides outright", () => {
      const V = [5, 6];
      const order = (type: Command["type"], tag: number): Command => {
        switch (type) {
          case "move":
          case "attackMove":
          case "harvest":
            return { type, faction: "blue", unitIds: V, x: tag, y: 3 };
          case "attack":
            return { type, faction: "blue", unitIds: V, targetId: tag };
          case "unload":
            return { type, faction: "blue", unitIds: V, x: tag, y: 3 };
          case "stop":
          case "anchor":
            return { type, faction: "blue", unitIds: V };
          default:
            throw new Error(type);
        }
      };
      const cases: [Command["type"], Command["type"], boolean][] = [
        ["move", "move", true], ["attack", "move", true], ["harvest", "attackMove", true], ["stop", "move", true],
        ["move", "attackMove", true], ["stop", "stop", true], ["attack", "attack", true],
        // a stop doesn't pack an anchored Goliath up, an attack leaves a lift's destination, a harvest may not apply
        ["move", "stop", false], ["move", "attack", false], ["attackMove", "attack", false], ["harvest", "harvest", false],
        ["anchor", "move", false], ["unload", "move", false]
      ];
      for (const [older, newer, replaced] of cases) {
        const steps = blueSteps((t) => (t === 0 ? [move(F, 30), order(older, 11)] : t === 1 ? [order(newer, 22)] : []), 60).map(([, c]) => c);
        const olders = steps.filter((c) => c.type === older && idsOf([c]).join() === V.join());
        expect(olders.length - (older === newer ? 1 : 0), `${older} then ${newer}`).toBe(replaced ? 0 : 1);
      }
      // and only when the newer one names every unit of the queued one
      const steps = blueSteps((t) => (t === 0 ? [move(F, 30), move([5, 6, 7], 11)] : t === 1 ? [move([5, 6], 22)] : []), 60).map(([, c]) => c);
      expect(steps.filter(at(11)).length).toBe(1);
    });

    it("puts a resign first: it lands D ticks later, whatever is waiting", () => {
      const steps = blueSteps((t) => (t === 0 ? [move(F, 30), move(U, 31)] : t === 2 ? [{ type: "resign", faction: "blue" }] : []));
      const resignAt = steps.find(([, c]) => c.type === "resign")![0];
      expect(resignAt).toBe(2 + 4);
      expect(steps.filter(([t, c]) => c.type === "move" && t > resignAt).length).toBeGreaterThan(3);
    });
  });

  it("tells the peer when this phone leaves or aborts", () => {
    for (const reason of ["left", "desync"] as const) {
      const { a, b, exchange } = wire({ delay: 4 });
      for (let t = 0; t < 30; t++) {
        tryStep(a);
        tryStep(b);
        exchange();
      }
      a.leave(reason);
      expect(a.over()).toBe(true);
      expect(tryStep(a)).toBeNull();
      exchange();
      const sb = b.status();
      expect(sb.peerEnd).toBe(reason);
      expect(b.over()).toBe(true);
      expect(tryStep(b)).toBeNull();
      expect(sb.desync).toBe(reason === "desync");
      if (reason === "desync") expect(sb.desyncReason).toBe("peer");
      // (a desync stays a desync: leaving afterwards still says so)
      a.leave("left");
      expect(a.status().end).toBe(reason);
    }
  });
});

// ------------------------------------------------------ segments, rotation ---

describe("segments and rotation", () => {
  /** A 30-unit move: three pieces of 93–95 bits, one turn each. */
  const order: Command = { type: "move", faction: "blue", unitIds: Array.from({ length: 30 }, (_, i) => 200 + 5 * i), x: 20.2, y: 30.3 };
  const pieces = canonicalize(order, { local: "blue", ...MAP });

  /** `ls`'s frames as read back: key, from, to, and the turns with commands. */
  const read = (ls: Lockstep) =>
    ls.frames().frames.map((f) => {
      const g = readGameFrame(f.bits, f.nbits, MAP, ls.local, ls.status().newestSealed);
      return { key: f.key, from: g.from, to: g.to, turns: g.turns.map(([t]) => t) };
    });

  /** A frame from the peer that only says it holds `ls`'s turns through `upTo`, and that its slack is `slack`. */
  const ackTo = (ls: Lockstep, upTo: number, slack = 3, at = 0) => {
    const to = ls.status().ackThrough;
    const f = rawFrame({ to, ack: upTo - to, tickLag: slack - (upTo - to) });
    expect(ls.receive(f.bits, f.nbits, at)).toBe("game");
  };

  /** Both phones idle on the wire, a packet each way every tick: everything acknowledged, each with slack D − 1 to spare. */
  const idle = (w: ReturnType<typeof wire>) => {
    for (let i = 0; i < 20; i++) {
      tryStep(w.a);
      tryStep(w.b);
      w.exchange();
      w.advance(100);
    }
  };

  it("cuts a burst into segments as it seals it; acks only trim the oldest or drop whole segments", () => {
    expect(pieces.map((c) => commandBits(c, MAP))).toEqual([93, 93, 95]);
    const w = wire({ delay: 5 });
    idle(w);
    const { a } = w;
    expect(a.frames().frames.length).toBe(1);
    const k0 = a.frames().frames[0]!.key;
    // the peer goes quiet for a moment: a seals one piece a turn, each piece too big to share a frame
    const t0 = a.status().tick;
    const T = t0 + 5;
    tryStep(a, () => [order]);
    tryStep(a);
    tryStep(a);
    const from = a.status().peerAck + 1;
    expect(from).toBeLessThanOrEqual(T);
    expect(read(a)).toEqual([
      { key: k0, from, to: T, turns: [T] },
      { key: T + 1, from: T + 1, to: T + 1, turns: [T + 1] },
      { key: T + 2, from: T + 2, to: T + 2, turns: [T + 2] }
    ]);
    expect(a.status()).toMatchObject({ segments: 3, queued: 0 });
    // a newer turn joins the newest segment: no boundary moves
    tryStep(a);
    expect(read(a).map((f) => [f.key, f.from, f.to])).toEqual([[k0, from, T], [T + 1, T + 1, T + 1], [T + 2, T + 2, T + 3]]);
    // acks trim the oldest segment's from, then drop whole segments; keys stay where the segments were cut
    ackTo(a, T - 1);
    expect(read(a).map((f) => [f.key, f.from, f.to])).toEqual([[k0, T, T], [T + 1, T + 1, T + 1], [T + 2, T + 2, T + 3]]);
    ackTo(a, T);
    expect(read(a).map((f) => [f.key, f.from, f.to])).toEqual([[T + 1, T + 1, T + 1], [T + 2, T + 2, T + 3]]);
    ackTo(a, T + 2);
    expect(read(a).map((f) => [f.key, f.from, f.to])).toEqual([[T + 2, T + 3, T + 3]]);
    // (all held: the newest turn alone, as before segments)
    ackTo(a, T + 3);
    expect(read(a).map((f) => [f.key, f.from, f.to])).toEqual([[T + 2, T + 3, T + 3]]);
    expect(a.status().segments).toBe(1);
  });

  /** Another 30-unit move, of other units: with `order`, a burst of six pieces. */
  const other: Command = { ...order, unitIds: order.type === "move" ? order.unitIds.map((id) => id + 1000) : [] };
  /** `ls` drains the burst of six pieces and seals it over four ticks without hearing back: the segments it cuts. */
  const cut = (ls: Lockstep) => {
    for (let i = 0; i < 4; i++) tryStep(ls, () => (i ? [] : [order, other]));
    return ls.status().segments;
  };

  it("affords another segment only while the peer's slack covers one more packet of rotation", () => {
    /** The segments a burst of six pieces spreads over when the peer's newest frames say `slack`, arriving `every` ms apart. */
    const burst = (slack: number, every: number) => {
      const w = wire({ delay: 6 }); // (K = 4)
      idle(w);
      for (let i = 0; i < SLACK_FRAMES; i++) {
        w.advance(every);
        ackTo(w.a, w.a.status().peerAck, slack, w.now());
      }
      return cut(w.a);
    };
    // a packet a tick (fast): one more segment per tick of slack beyond the one kept in hand
    expect([4, 3, 2, 1, 0].map((slack) => burst(slack, 100))).toEqual([4, 3, 2, 1, 1]);
    // a packet every two ticks (robust): one per two
    expect([5, 4, 3, 2].map((slack) => burst(slack, 200))).toEqual([3, 2, 2, 1]);
  });

  it("rotates at this phone's own packet period, whatever the peer's arrivals say: modes are per direction", () => {
    /** As above, with this phone sending a packet every `own` ms (setPacketMs), and the peer's frames `every` ms apart. */
    const burst = (slack: number, every: number, own: number) => {
      const w = wire({ delay: 6 }); // (K = 4)
      idle(w);
      w.a.setPacketMs(own);
      for (let i = 0; i < SLACK_FRAMES; i++) {
        w.advance(every);
        ackTo(w.a, w.a.status().peerAck, slack, w.now());
      }
      return cut(w.a);
    };
    // robust here, the peer fast: one more segment per two ticks of slack, as when both are robust (read off the
    // peer's arrivals, 100 ms apart, it opened twice the extra segments: [4, 4, 3, 2])
    expect([5, 4, 3, 2].map((slack) => burst(slack, 100, 200))).toEqual([3, 2, 2, 1]);
    // fast here, the peer robust: one per tick, as when both are fast (read off its arrivals: [2, 2, 1, 1, 1])
    expect([4, 3, 2, 1, 0].map((slack) => burst(slack, 200, 100))).toEqual([4, 3, 2, 1, 1]);
    // a new period starts the window over (the slack the peer reported of the other mode's packets says nothing of
    // what it will have now); the same period again doesn't
    const switched = (to: number) => {
      const w = wire({ delay: 6 });
      w.a.setPacketMs(100);
      idle(w);
      w.a.setPacketMs(to);
      for (let i = 0; i < SLACK_FRAMES - 1; i++) {
        w.advance(100);
        ackTo(w.a, w.a.status().peerAck, 5, w.now());
      }
      return cut(w.a);
    };
    expect(switched(100)).toBe(4);
    expect(switched(200)).toBe(1);
    expect(() => wire().a.setPacketMs(0)).toThrow(RangeError);
  });

  it("reads the peer's slack off a full window only, which a pause on either phone or a stall here starts over", () => {
    /** Both phones step and exchange a packet each way, `n` times. */
    const play = (w: ReturnType<typeof wire>, n: number) => {
      for (let i = 0; i < n; i++) {
        tryStep(w.a);
        tryStep(w.b);
        w.exchange();
        w.advance(100);
      }
    };
    // the peer's first frames say slack D − 1 (both phones hold turns 0 … D − 1 from the start), more than latency
    // leaves it: read off two of them, the gate opened at once, and the opening seconds stalled (robust, 500 ms, D = 7:
    // 256 and 48 ms against K = 1's 48 and 0)
    let w = wire({ delay: 6 });
    play(w, SLACK_FRAMES - 1);
    expect(cut(w.a)).toBe(1);
    w = wire({ delay: 6 });
    play(w, SLACK_FRAMES);
    expect(cut(w.a)).toBe(4); // (on the wire the peer's slack really is D − 1)
    // a paused peer's slack only grows until this phone stalls, and stays high for seconds after it plays on: a frame
    // that says paused starts the window over
    w = wire({ delay: 6 });
    play(w, 20);
    w.b.setPaused(true);
    w.exchange();
    w.b.setPaused(false);
    play(w, SLACK_FRAMES - 1);
    expect(cut(w.a)).toBe(1);
    // so does a pause here: the peer runs on until it stalls, then catches up
    w = wire({ delay: 6 });
    play(w, 20);
    w.a.setPaused(true);
    w.a.setPaused(false);
    play(w, SLACK_FRAMES - 1);
    expect(cut(w.a)).toBe(1);
    // and a stall here: the peer is behind meanwhile, holding more of this phone's turns than it will keep
    w = wire({ delay: 6 });
    play(w, 20);
    while (tryStep(w.a));
    expect(w.a.status().stalled).toBe(true);
    play(w, SLACK_FRAMES - 1);
    expect(w.b.status().slack).toBeGreaterThan(6); // (b is behind: it holds more of a's turns than the D − 1 it did)
    expect(cut(w.a)).toBe(1);
  });

  it("starts no new segment for the rest of the match once the peer stalls during a rotation", () => {
    const run = (stall: boolean) => {
      const w = wire({ delay: 6 });
      idle(w);
      expect(cut(w.a)).toBe(4);
      // the peer says it is stalled on one of a's turns: in rotation a lost packet costs the newest turns a whole
      // rotation, and the gate can't see loss coming
      if (stall) {
        w.advance(100);
        ackTo(w.a, w.a.status().peerAck, -1, w.now());
      }
      // everything acknowledged and the slack back where it was, a minute later (b first catches up the four ticks)
      for (let i = 0; i < 4; i++) {
        tryStep(w.b);
        w.exchange();
        w.advance(100);
      }
      expect(w.b.status().stalled).toBe(false);
      for (let i = 0; i < 600; i++) {
        tryStep(w.a);
        tryStep(w.b);
        w.exchange();
        w.advance(100);
      }
      expect(w.a.status()).toMatchObject({ queued: 0, segments: 1 });
      return cut(w.a);
    };
    expect(run(false)).toBe(4);
    expect(run(true)).toBe(1);
  });

  it("sends the oldest segment alone in every packet once the peer has starved for it longer than a rotation and a round trip", () => {
    const w = wire({ delay: 6 });
    idle(w);
    const { a } = w;
    expect(cut(a)).toBe(4);
    const keys = a.frames().frames.map((f) => f.key);
    // the peer takes one more turn, then says it is stalled on the next, which the oldest segment carries, and takes
    // nothing more (a periodic loss can take the oldest segment's frame every time round: the rotation is periodic)
    const held = a.status().peerAck + 1;
    expect(held).toBeLessThan(keys[1]!);
    w.advance(100);
    ackTo(a, held, -1, w.now());
    const since = w.now();
    // four segments, a packet every 100 ms: (4 + 1) packets and 2D ticks
    const starve = (4 + 1) * 100 + 2 * 6 * 100;
    while (w.now() - since < starve) {
      expect(a.frames().frames.map((f) => f.key), `${w.now() - since} ms`).toEqual(keys);
      w.advance(100);
      ackTo(a, held, -1, w.now());
    }
    const alone = a.frames().frames;
    expect(alone.map((f) => f.key)).toEqual([keys[0]]);
    expect(readGameFrame(alone[0]!.bits, alone[0]!.nbits, MAP, "blue", a.status().newestSealed)).toMatchObject({ from: held + 1, to: keys[1]! - 1 });
    // until the peer holds it: then the rest go round again
    ackTo(a, keys[1]! - 1, 0, w.now());
    expect(a.frames().frames.map((f) => f.key)).toEqual(keys.slice(1));
  });

  it("counts the starving rotation at this phone's own packet period, not the peer's", () => {
    /**
     * As above with the peer's frames `every` ms apart and this phone sending a packet every `own` ms: how long
     * after the peer stalls on the oldest segment this phone sends it alone.
     */
    const starved = (every: number, own: number) => {
      const w = wire({ delay: 6 });
      const { a } = w;
      a.setPacketMs(own);
      idle(w);
      const open = cut(a); // (the idle wire's slack affords 4 segments at 100 ms, 2 at 200)
      const keys = a.frames().frames.map((f) => f.key);
      expect(keys.length).toBe(open);
      const held = a.status().peerAck + 1;
      expect(held).toBeLessThan(keys[1]!);
      w.advance(every);
      ackTo(a, held, -1, w.now());
      const since = w.now();
      while (a.frames().frames.length > 1) {
        w.advance(every);
        ackTo(a, held, -1, w.now());
      }
      expect(a.frames().frames.map((f) => f.key)).toEqual([keys[0]]);
      return { open, after: w.now() - since };
    };
    // fast here, the peer robust: (4 + 1) packets of 100 ms and 2D ticks, the first of the peer's frames past 1700 ms
    // (read off its arrivals, 200 ms apart: 2200)
    expect(starved(200, 100)).toEqual({ open: 4, after: 1800 });
    // robust here, the peer fast: (2 + 1) packets of 200 ms and 2D ticks (read off its arrivals, 100 ms apart, it
    // opened 4 segments and sent the oldest alone at 1700 ms, before a rotation of them could have brought it)
    expect(starved(100, 200)).toEqual({ open: 2, after: 1800 });
  });

  it("needs the capacity a lone largest command takes at its input delay, and always gets one through with it", () => {
    // the window always holds the empty turns latency leaves unacknowledged, so a lone 96-bit command joins the newest
    // segment, with its gap and the span at their bound 2D + 1 (at D = 8 and 176 bits it waited for ever)
    expect([3, 4, 5, 6, 7, 8].map(minCapacity)).toEqual([175, 175, 177, 177, 183, 183]);
    const lone: Command = { type: "attackMove", faction: "blue", unitIds: [100, 164, 228, 292, 356], x: 20.2, y: 30.3 };
    const [piece] = canonicalize(lone, { local: "blue", ...MAP });
    expect(commandBits(piece!, MAP)).toBe(C_MAX);
    for (let delay = 3; delay <= 8; delay++) {
      const make = (capacity: number) => () =>
        new Lockstep({ local: "blue", delay, mapWidth: MAP.width, mapHeight: MAP.height, capacity, setupHash: 1, now: () => 0 });
      expect(make(minCapacity(delay) - 1), `D ${delay}`).toThrow(RangeError);
      expect(make(minCapacity(delay)), `D ${delay}`).not.toThrow();
      // over the air at the longest latency the pairing picks this D for, K = 1
      const { a, b, run } = overAir({ delay, segmentsMax: 1, air: { latencyMs: 100 * delay - 150, capacity: minCapacity(delay) } });
      run(6_000);
      a.orders.push(lone);
      run(5_000, () => b.ls.turns().some(([, side]) => side === "blue"));
      expect(b.ls.turns().filter(([, side]) => side === "blue").map(([, , c]) => c), `D ${delay}`).toEqual([[piece]]);
    }
  });

  /**
   * Two Locksteps over PacketAir with no worlds (stand-in hashes), each stepping a tick per 100 ms of air time as
   * GameScene would (the speed trim, no catch-up after a stall). Each end drains what is pushed onto its `orders`
   * and what `drain` gives for the tick; `every` runs before each 10 ms of air. `longest`: the longest an end waited
   * for a new peer turn; `frames`: the most frames it handed over at once.
   */
  const overAir = (o: {
    delay: number; segmentsMax?: number; air?: PacketAirOptions; drain?: (side: Faction, tick: number) => Command[]; every?: (air: PacketAir) => void;
  }) => {
    const air = new PacketAir({ seed: 21, mode: "fast", ...o.air });
    const end = (local: Faction, link: LinkTransport) => ({
      ls: new Lockstep({ local, delay: o.delay, mapWidth: MAP.width, mapHeight: MAP.height, capacity: link.capacity(), setupHash: 1, now: () => link.now(), segmentsMax: o.segmentsMax }),
      link, acc: 0, sent: 0, orders: [] as Command[], longest: 0, frames: 0
    });
    const [a, b] = [end("blue", air.a), end("red", air.b)];
    const run = (ms: number, done: () => boolean = () => false) => {
      for (let t = 0; t < ms && !done(); t += 10) {
        o.every?.(air);
        air.advance(10);
        for (const e of [a, b]) {
          for (const p of e.link.poll()) e.ls.receive(p.bits, p.nbits, p.at);
          e.acc += 10 * e.ls.speed();
          while (e.acc >= 100) {
            const tick = e.ls.status().tick;
            if (!e.ls.commandsFor(tick, () => [...e.orders.splice(0), ...(o.drain?.(e.ls.local, tick) ?? [])])) {
              e.acc = 99.9;
              break;
            }
            e.ls.afterStep(tick, hash32(tick, 77), null);
            e.acc -= 100;
          }
          const s = e.ls.status();
          if (s.stalled) e.longest = Math.max(e.longest, e.link.now() - s.lastNewTurnAt);
          const f = e.ls.frames();
          if (f.version !== e.sent) {
            checkList(e.ls, f.frames);
            e.link.send(f.frames);
            e.sent = f.version;
            e.frames = Math.max(e.frames, f.frames.length);
          }
        }
      }
    };
    return { air, a, b, run };
  };

  /** From an idle window, blue drains the 30-unit order: the ticks from then until red holds every piece, and the most segments blue had. */
  const landing = (o: { delay: number; segmentsMax?: number; air?: PacketAirOptions }) => {
    const { air, a, b, run } = overAir(o);
    run(6_000);
    const before = a.ls.status().newestSealed;
    const t0 = air.now();
    a.orders.push(order);
    let last = -1;
    let most = 1;
    run(20_000, () => {
      const s = a.ls.status();
      most = Math.max(most, s.segments);
      if (last < 0 && s.newestSealed > before && s.queued === 0) last = s.newestSealed; // (the turn the last piece went in)
      return last >= 0 && b.ls.status().ackThrough >= last;
    });
    const ticks = (air.now() - t0) / 100;
    run(1_000);
    expect(b.ls.turns().filter(([, side]) => side === "blue").flatMap(([, , c]) => c)).toEqual(pieces);
    return { ticks, most, stalls: [a.ls.status().stallMs, b.ls.status().stallMs] };
  };

  it("lands a 30-unit order from an idle window within about one rotation, where the slack affords it", () => {
    // [delay, latency, mode] → ticks from the drain until the peer holds all three pieces, and the most segments
    const got = ([[7, 250, "fast"], [6, 250, "fast"], [5, 150, "fast"], [5, 250, "fast"], [7, 250, "robust"], [5, 150, "robust"]] as const).map(
      ([delay, latencyMs, mode]) => ({
        k: landing({ delay, air: { latencyMs, mode } }),
        one: landing({ delay, air: { latencyMs, mode }, segmentsMax: 1 }),
        latencyMs
      })
    );
    const [d7, d6, l150, tight, d7Robust, l150Robust] = got;
    // three segments afforded: the pieces go out in the turns after the drain, one rotation apart at most
    expect(d7!.k.most).toBe(3);
    expect(d7!.k.ticks).toBeLessThanOrEqual(1 + 2 + 250 / 100 + 3);
    // with K = 1 the second and third pieces wait a round trip each
    expect(d7!.one.ticks).toBeGreaterThanOrEqual(d7!.k.ticks + 8);
    // less slack, fewer segments: still sooner than K = 1
    for (const r of [d6!, l150!, d7Robust!]) {
      expect(r.k.most).toBe(2);
      expect(r.k.ticks).toBeLessThan(r.one.ticks - 3);
    }
    // no slack to spare (D = 5 at 250 ms, and robust at 150 ms): the gate keeps one segment, exactly as K = 1
    for (const r of [tight!, l150Robust!]) expect(r.k).toEqual(r.one);
    // and the peer never stalled for it
    for (const r of got) expect([...r.k.stalls, ...r.one.stalls]).toEqual([0, 0, 0, 0]);
  });

  it("with K = 1 the same burst waits for acks, a piece a round trip", () => {
    const w = wire({ delay: 5, segmentsMax: 1 });
    idle(w);
    const { a } = w;
    tryStep(a, () => [order]);
    tryStep(a);
    tryStep(a);
    expect(a.frames().frames.length).toBe(1);
    expect(a.status().queued).toBe(2);
  });

  it("gets a segment through a loss as periodic as the rotation", { timeout: 60_000 }, () => {
    // from 6 s on, every second packet blue sends is lost (an interferer at 5 Hz), and blue moves 30 units every 2 s:
    // with two segments in the rotation the same one rode every lost packet, and both phones waited for ever (at
    // about tick 110 of 1200). The peer starving for it sends it alone, and the peer's stall ends rotation for the match.
    const move = (t: number): Command => ({ ...order, x: 5 + (t % 40) } as Command);
    const losing = (segmentsMax?: number) => {
      const r = overAir({
        delay: 7, segmentsMax, air: { latencyMs: 250, phaseMs: [5, 55] },
        drain: (side, t) => (side === "blue" && t >= 100 && t % 20 === 0 ? [move(t)] : []),
        every: (air) => {
          if (air.now() >= 6_000 && air.now() % 200 === 0) air.outage(10, "ab"); // (blue's packets start at 5 + 100k ms)
        }
      });
      r.run(120_000);
      return r;
    };
    const k = losing();
    expect(k.a.frames).toBe(2);
    for (const e of [k.a, k.b]) expect(e.ls.status().tick).toBeGreaterThanOrEqual(1190);
    expect(k.b.longest).toBeLessThan(3_000);
    expect(k.a.ls.status().stallMs + k.b.ls.status().stallMs).toBeLessThan(5_000);
    // (K = 1 carries everything in every packet: half of them is plenty)
    const one = losing(1);
    expect([one.a.ls.status().stallMs, one.b.ls.status().stallMs]).toEqual([0, 0]);
  });

  it("keeps a segment that arrives before the one it follows: a lost packet costs one rotation", () => {
    const w = wire({ delay: 5 });
    idle(w);
    const { a, b, packet } = w;
    const T = a.status().tick + 5;
    const held = b.status().ackThrough;
    expect(held).toBe(T - 1);
    // one packet a tick, and the one carrying piece 1 (turn T) is lost
    tryStep(a, () => [order]);
    const lost = packet(a);
    tryStep(a);
    const p2 = packet(a);
    expect(b.receive(p2.bits, p2.nbits, 0)).toBe("game");
    expect(b.status().ackThrough).toBe(held); // (turn T is missing: T + 1 waits)
    tryStep(a);
    const p3 = packet(a);
    b.receive(p3.bits, p3.nbits, 0);
    expect([p2.key, p3.key]).toEqual([T + 1, T + 2]);
    expect(b.status().ackThrough).toBe(held);
    // the rotation comes back round to the lost segment, and everything after it is already held
    const p4 = packet(a);
    expect(p4.key).toBe(lost.key);
    b.receive(p4.bits, p4.nbits, 0);
    expect(b.status()).toMatchObject({ ackThrough: T + 2, framesBad: 0 });
    // a stale copy changes nothing: each turn is taken once
    b.receive(p2.bits, p2.nbits, 0);
    expect(b.status().ackThrough).toBe(T + 2);
    while (b.status().tick <= T + 2) tryStep(b);
    expect(b.turns().filter(([, side]) => side === "blue")).toEqual(pieces.map((c, i) => [T + i, "blue", [c]]));
  });

  it("takes turns from a frame up to 128 turns past ackThrough, each turn once", () => {
    const { a } = wire({ delay: 4 });
    const stop = (id: number): Command => ({ type: "stop", faction: "red", unitIds: [id] });
    expect(a.status().ackThrough).toBe(3);
    // turns 6–9 arrive before 4–5: held, but ackThrough waits for the gap
    let f = rawFrame({ to: 9, span: 3, turns: [[7, [stop(5)]]] });
    expect(a.receive(f.bits, f.nbits, 100)).toBe("game");
    expect(a.status()).toMatchObject({ ackThrough: 3, lastNewTurnAt: 0 });
    f = rawFrame({ to: 5, span: 1 });
    a.receive(f.bits, f.nbits, 200);
    expect(a.status()).toMatchObject({ ackThrough: 9, lastNewTurnAt: 200 });
    // a different turn 7 later on is ignored: the first one stands
    f = rawFrame({ to: 8, span: 1, turns: [[7, [stop(6)]]] });
    a.receive(f.bits, f.nbits, 300);
    const stepped: Command[][] = [];
    for (let t = 0; t <= 9; t++) stepped.push(tryStep(a)!);
    expect(stepped[7]).toEqual([stop(5)]);
    expect(stepped.filter((c, t) => t !== 7 && c.length)).toEqual([]);
    // 128 turns past ackThrough is the furthest a frame's turns are taken from
    const base = a.status().ackThrough;
    for (const [to, span] of [[base + AHEAD_MAX + 1, 0], [base + AHEAD_MAX, 0], [base + 64, 63], [base + AHEAD_MAX - 1, AHEAD_MAX - 66]] as const) {
      f = rawFrame({ to, span });
      expect(a.receive(f.bits, f.nbits, 400)).toBe("game");
    }
    expect(a.status().ackThrough).toBe(base + AHEAD_MAX); // (not + 129: that frame was beyond reach)
    f = rawFrame({ to: base + AHEAD_MAX + 1, span: 0 });
    a.receive(f.bits, f.nbits, 500);
    expect(a.status().ackThrough).toBe(base + AHEAD_MAX + 1); // (in reach now)
  });

  it("hands out lists that ascend by key, each frame within capacity, through random orders, loss and delays", () => {
    let seed = 99;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const randomOrder = (side: Faction): Command => {
      const n = 1 + Math.floor(rnd() * 40);
      const spacing = 1 + Math.floor(rnd() * 60);
      const unitIds = Array.from({ length: n }, (_, i) => 50 + i * spacing + Math.floor(rnd() * spacing));
      const r = rnd();
      if (r < 0.4) return { type: "move", faction: side, unitIds, x: rnd() * 56, y: rnd() * 56 };
      if (r < 0.6) return { type: "attack", faction: side, unitIds, targetId: Math.floor(rnd() * 5000) };
      if (r < 0.8) return { type: "produce", faction: side, buildingId: Math.floor(rnd() * 3000), unit: "scout" };
      return { type: "stop", faction: side, unitIds };
    };
    for (const [delay, capacity] of [[3, 188], [4, 186], [5, 188], [6, minCapacity(6)], [8, minCapacity(8)], [8, 188]] as [number, number][]) {
      const w = wire({ delay, capacity });
      let most = 0;
      for (let t = 0; t < 400; t++) {
        tryStep(w.a, () => (rnd() < 0.2 ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => randomOrder("blue")) : []));
        tryStep(w.b, () => (rnd() < 0.2 ? [randomOrder("red")] : []));
        most = Math.max(most, w.a.status().segments);
        // a packet each way most ticks, some of them lost (packet() checks every list it takes from)
        if (rnd() < 0.8) {
          const f = w.packet(w.a);
          if (rnd() < 0.8) w.b.receive(f.bits, f.nbits, t * 100);
        }
        if (rnd() < 0.8) {
          const f = w.packet(w.b);
          if (rnd() < 0.8) w.a.receive(f.bits, f.nbits, t * 100);
        }
        w.advance(100);
      }
      const n = Math.min(w.a.status().tick, w.b.status().tick);
      expect(n, `D ${delay}`).toBeGreaterThan(150);
      // (as many as the slack gate afforded: rotation came into play whenever K allowed it)
      expect(most, `D ${delay}`).toBeLessThanOrEqual(w.a.segmentsMax);
      if (delay > 3) expect(most, `D ${delay}`).toBeGreaterThan(1);
      const upTo = (ls: Lockstep) => ls.turns().filter(([t]) => t < n);
      expect(upTo(w.a), `D ${delay}`).toEqual(upTo(w.b));
    }
  });
});

// ------------------------------------------------------------- PacketAir ---

/** A 10-bit frame: type then a byte. */
const tiny = (type: number, v: number) => {
  const wr = new BitWriter();
  wr.bits(type, 2);
  wr.bits(v, 8);
  return wr;
};
const byteOf = (p: { bits: Uint8Array }) => ((p.bits[0]! << 2) | (p.bits[1]! >> 6)) & 0xff;
/** A list of one frame for send(). */
const one = (wr: BitWriter, key = 0): OutFrame => ({ bits: wr.bytes(), nbits: wr.nbits, key });

describe("PacketAir", () => {
  it("sends the newest payload every period at each end's own phase, and delivers it after the latency", () => {
    const air = new PacketAir({ mode: "fast", phaseMs: [10, 60], clockOffsetMs: [0, 5000] });
    expect([air.a.capacity(), air.b.capacity()]).toEqual([188, 188]);
    air.a.send([one(tiny(2, 1))]);
    air.advance(95);
    air.a.send([one(tiny(2, 2))]); // (latched by the next packet, at 110)
    air.advance(400);
    expect(air.a.slots()).toEqual([10, 110, 210, 310, 410]);
    expect(air.b.slots()).toEqual([5060, 5160, 5260, 5360, 5460]); // (on b's own clock)
    const got = air.b.poll();
    expect(got.map((p) => p.at)).toEqual([5260, 5360, 5460]);
    expect(got.map(byteOf)).toEqual([1, 2, 2]);
    // as the modem delivers it: the whole payload, zero-padded
    for (const p of got) {
      expect(p).toMatchObject({ nbits: 188, session: false, snrDb: 30 });
      expect(p.bits.length).toBe(24);
      expect([...p.bits.slice(2)].every((b) => b === 0)).toBe(true);
    }
    expect(air.a.poll()).toEqual([]); // (b never sent anything)
    expect(() => air.a.send([{ bits: new Uint8Array(30), nbits: 189, key: 0 }])).toThrow(RangeError);
    // a mode change takes effect at the next packet
    air.a.setMode("robust");
    air.advance(1000);
    expect(air.a.slots()).toEqual([510, 710, 910, 1110, 1310]);
    expect(air.a.stats()).toMatchObject({ txMode: "robust", plan: "high" });
    expect(air.b.stats()).toMatchObject({ rxMode: "robust", rxOk: 9, rxBad: 0, locked: true }); // (the starts up to 1245 have arrived)
  });

  it("sends one frame a packet in key rotation, and keeps its place when the list is replaced", () => {
    const air = new PacketAir({ mode: "fast", latencyMs: 0, phaseMs: [0, 50] });
    air.a.send([one(tiny(2, 1), 2), one(tiny(2, 5), 5), one(tiny(2, 9), 9)]);
    air.advance(350); // (packets at 0, 100, 200 and 300)
    expect(air.b.poll().map(byteOf)).toEqual([1, 5, 9, 1]);
    // after a packet with key 2, the next carries the first key past 2
    air.a.send([one(tiny(2, 5), 5), one(tiny(2, 12), 12)]);
    air.advance(300);
    expect(air.b.poll().map(byteOf)).toEqual([5, 12, 5]);
    expect(() => air.a.send([one(tiny(2, 1), 3), one(tiny(2, 2), 3)])).toThrow(RangeError);
    expect(() => air.a.send([])).toThrow(RangeError);
  });

  it("drops game frames between ends whose session keys differ", () => {
    const deliver = (ka: [number, number] | null, kb: [number, number] | null) => {
      const air = new PacketAir({ mode: "fast", latencyMs: 0 });
      if (ka) air.a.setSessionKey(...ka);
      if (kb) air.b.setSessionKey(...kb);
      air.a.send([one(tiny(1, 9))]); // a game frame
      air.b.send([one(tiny(2, 9))]); // a lobby frame
      air.advance(1000);
      return [air.b.poll().map((p) => p.session), air.a.poll().map((p) => p.session)];
    };
    const ten = (v: boolean) => Array.from({ length: 10 }, () => v);
    expect(deliver([1, 2], [1, 2])).toEqual([ten(true), ten(false)]);
    expect(deliver([1, 2], [1, 3])).toEqual([[], ten(false)]); // (lobby frames always pass)
    expect(deliver([1, 2], null)).toEqual([[], ten(false)]);
    expect(deliver(null, null)).toEqual([ten(false), ten(false)]);
  });

  it("loses packets as seeded: Bernoulli, bursts and outages", () => {
    const losses = (o: PacketAirOptions, ms = 200_000) => {
      const air = new PacketAir({ mode: "fast", latencyMs: 0, phaseMs: [0, 50], ...o });
      air.a.send([one(tiny(2, 0))]);
      const got: boolean[] = [];
      for (let t = 0; t < ms; t += 100) {
        air.advance(100);
        got.push(air.b.poll().length > 0);
      }
      return got;
    };
    const p30 = losses({ loss: 0.3, seed: 5 });
    const rate = p30.filter((ok) => !ok).length / p30.length;
    expect(rate).toBeGreaterThan(0.27);
    expect(rate).toBeLessThan(0.33);
    expect(losses({ loss: 0.3, seed: 5 })).toEqual(p30);
    expect(losses({ loss: 0.3, seed: 6 })).not.toEqual(p30);
    // Gilbert–Elliott: losses come in runs
    const ge = losses({ burst: { pGoodToBad: 0.02, pBadToGood: 0.25 }, seed: 5 });
    let runs = 0;
    let lost = 0;
    ge.forEach((ok, i) => {
      if (!ok) lost++;
      if (!ok && (i === 0 || ge[i - 1])) runs++;
    });
    expect(lost / runs).toBeGreaterThan(3);
    // an outage cuts one way only
    const air = new PacketAir({ mode: "fast", latencyMs: 250 });
    air.a.send([one(tiny(2, 0))]);
    air.b.send([one(tiny(2, 0))]);
    air.advance(1000);
    air.a.poll();
    air.b.poll();
    air.outage(3000, "ab");
    air.advance(3000);
    expect(air.b.poll().length).toBe(2); // (the packets already in the air)
    expect(air.a.poll().length).toBe(30);
    expect(air.b.stats().rxBad).toBe(30);
    air.advance(1000);
    expect(air.b.poll().length).toBeGreaterThan(5);
    // a closed end stops sending and hearing
    air.a.slots();
    air.a.close();
    air.advance(1000);
    expect(air.a.slots().length).toBe(0);
    expect(air.a.poll()).toEqual([]);
    const landed = air.b.poll().length; // (what was already in the air still lands: 250 ms of 100 ms packets)
    expect(landed >= 2 && landed <= 3).toBe(true);
    air.advance(1000);
    expect(air.b.poll()).toEqual([]);
  });
});

// ------------------------------------------------- two worlds over the air ---

interface Phone {
  side: Faction;
  w: World;
  /** null: a human, whose orders the scenario injects through `extra`. */
  ai: AiState | null;
  ls: Lockstep;
  link: LinkTransport;
  acc: number;
  last: number;
  next: number;
  frameMs: number;
  sent: number;
  /** The trail after each tick stepped. */
  trails: number[];
  /** [tick, worldHash] every 100 ticks, as a battle record keeps them. */
  hashes: [number, string][];
  /** Extra orders the scenario injects, drained with the AI's. */
  extra: Command[];
  paused: boolean;
  sawPeerPaused: boolean;
  maxFrame: number;
  desyncAt: number | null;
  /** The most orders queued, and the longest an order waited in the queue (ticks), seen after any update before the end. */
  maxQueued: number;
  maxQueuedTicks: number;
  /** The most frames handed to the transport at once. */
  maxSegments: number;
}

interface Run {
  air: PacketAir;
  setup: MatchSetup;
  blue: Phone;
  red: Phone;
}

interface Scenario {
  map: string;
  seed: number;
  mutators?: MutatorId[];
  /** Blue's and red's AI; null for a human. */
  strategies?: [StrategyName | null, StrategyName | null];
  delay?: number;
  /** Each phone steps at most this far. */
  ticks: number;
  air?: PacketAirOptions;
  /** Every 2 ms of air time. */
  every?: (r: Run) => void;
  /** After a phone steps a tick. */
  afterStep?: (p: Phone, tick: number, r: Run) => void;
  /** Run until this holds (default: both phones at `ticks`, or over). */
  until?: (r: Run) => boolean;
  /** Changes made to both worlds alike before the match starts (folded into the setup hash). */
  prepare?: (w: World) => void;
  /** K for both phones (default: segmentsFor(delay)). */
  segmentsMax?: number;
  /** Blue's and red's own transmit modes, set as the match starts (modes are per direction; default `air.mode` both ways). */
  modes?: [ModemMode, ModemMode];
  /** Each phone gives its Lockstep its own transmit period (setPacketMs) from the mode its link sends in, as the session does. */
  packetMs?: boolean;
}

/** PacketAir's packet period in each mode (ms). */
const PERIOD_MS: Record<ModemMode, number> = { fast: 100, robust: 200 };

/** Two phones, each with its own world, AI and Lockstep, joined by PacketAir; each phone's AI orders only its own side. */
function duel(s: Scenario): Run {
  const [bs, rs] = s.strategies ?? ["balanced", "rush"];
  const mutators = s.mutators ?? [];
  const probe = setupWorld({ map: s.map, seed: s.seed, mutators, openers: {} });
  const openers: Partial<Record<Faction, OpenerId>> = {};
  for (const [side, strat] of [["blue", bs], ["red", rs]] as const) {
    const o = allowedOpener(probe, side, pickAiOpener(strat ?? "balanced", s.seed, side));
    if (o) openers[side] = o;
  }
  const setup: MatchSetup = { map: s.map, seed: s.seed, mutators, openers };
  const air = new PacketAir({ seed: s.seed, mode: "fast", clockOffsetMs: [0, 987_654], ...s.air });
  air.a.setSessionKey(4242, 777);
  air.b.setSessionKey(4242, 777);
  if (s.modes) {
    air.a.setMode(s.modes[0]);
    air.b.setMode(s.modes[1]);
  }
  const phone = (side: Faction, link: LinkTransport, strat: StrategyName | null, frameMs: number, phase: number): Phone => {
    const w = setupWorld(setup);
    s.prepare?.(w);
    return {
      side, w, link, frameMs,
      // (normal difficulty only: tickAi writes incomeMult, and normal's is the default both worlds have)
      ai: strat && createAiState(strat, "normal", hash32(s.seed, side === "blue" ? 1 : 2)),
      ls: new Lockstep({
        local: side, delay: s.delay ?? 5, mapWidth: w.width, mapHeight: w.height, capacity: link.capacity(), setupHash: parseInt(worldHash(w), 16),
        now: () => link.now(), segmentsMax: s.segmentsMax
      }),
      acc: 0, last: 0, next: phase, sent: 0, trails: [], hashes: [], extra: [], paused: false, sawPeerPaused: false, maxFrame: 0, desyncAt: null,
      maxQueued: 0, maxQueuedTicks: 0, maxSegments: 0
    };
  };
  const r: Run = { air, setup, blue: phone("blue", air.a, bs, 16, 3), red: phone("red", air.b, rs, 11, 0) };
  const done = s.until ?? ((r: Run) => [r.blue, r.red].every((p) => p.w.tick >= s.ticks || p.ls.over()));
  const limit = s.ticks * 100 * 3 + 60_000;
  while (!done(r) && air.now() < limit) {
    air.advance(2);
    s.every?.(r);
    for (const p of [r.blue, r.red]) update(p, r, s);
  }
  expect(air.now(), "the scenario ran out of time").toBeLessThan(limit);
  return r;
}

/** One phone's frame: take the packets, step the ticks the clock allows (stalling when the peer's turn is missing), send a new frame. */
function update(p: Phone, r: Run, s: Scenario): void {
  const now = r.air.now();
  if (now < p.next) return;
  const dt = now - p.last;
  p.last = now;
  p.next = now + p.frameMs;
  for (const pk of p.link.poll()) p.ls.receive(pk.bits, pk.nbits, pk.at);
  if (s.packetMs) p.ls.setPacketMs(PERIOD_MS[p.link.stats().txMode]);
  if (!p.paused) p.acc += dt * p.ls.speed();
  for (let n = 0; p.acc >= 100 && n < 8 && p.w.tick < s.ticks; n++) {
    const t = p.w.tick;
    const cmds = p.ls.commandsFor(t, () => [...(p.ai ? tickAi(p.w, p.side, p.ai) : []), ...p.extra.splice(0)]);
    if (!cmds) {
      p.acc = 99.9; // (GameScene: hold the pose, no catch-up burst)
      break;
    }
    step(p.w, cmds);
    p.ls.afterStep(t, parseInt(worldHash(p.w), 16), p.w.winner ? { winner: p.w.winner, resigned: p.w.resigned } : null);
    p.trails[t] = p.ls.trail();
    if (p.w.tick % 100 === 0) p.hashes.push([p.w.tick, worldHash(p.w)]);
    p.acc -= 100;
    s.afterStep?.(p, t, r);
    if (p.w.winner) break; // (GameScene stops stepping a decided world)
  }
  const st = p.ls.status();
  if (!p.ls.over()) {
    p.maxQueued = Math.max(p.maxQueued, st.queued);
    p.maxQueuedTicks = Math.max(p.maxQueuedTicks, st.queuedTicks);
  }
  if (st.stalled && st.peerPaused) p.sawPeerPaused = true;
  if (st.desync && p.desyncAt === null) p.desyncAt = p.w.tick;
  const f = p.ls.frames();
  if (f.version !== p.sent) {
    checkList(p.ls, f.frames);
    p.link.send(f.frames); // (throws past capacity)
    p.sent = f.version;
    for (const g of f.frames) p.maxFrame = Math.max(p.maxFrame, g.nbits);
    p.maxSegments = Math.max(p.maxSegments, f.frames.length);
  }
}

/** The first tick below `n` whose trails differ (−1: none). */
function firstDiff(r: Run, n: number): number {
  for (let t = 0; t < n; t++) if (r.blue.trails[t] === undefined || r.blue.trails[t] !== r.red.trails[t]) return t;
  return -1;
}

/** The match as a battle record, from the turns one phone stepped. */
function recordOf(r: Run, p: Phone): BattleRecord {
  const w = p.w;
  return {
    v: 1, commit: null, sim: null, created: "2026-10-19T00:00:00.000Z",
    map: r.setup.map, mutators: r.setup.mutators, seed: r.setup.seed, round: 1, maxTicks: w.tick, openers: r.setup.openers,
    seats: { blue: { player: "online-duel:host" }, red: { player: "online-duel:guest" } },
    frames: "own", turns: p.ls.turns(), radio: [], hashes: p.hashes, log: [], tick: w.tick,
    end: w.winner ? endOf(w.tick, w.winner, w.resigned) : null, usage: {}
  };
}

function expectReplays(r: Run, p: Phone): void {
  const rec = parseRecord(JSON.stringify(recordOf(r, p)));
  const res = replay(rec);
  expect(res.divergedAt).toBeNull();
  expect(res.checked).toBe(p.hashes.length);
  expect(worldHash(res.world)).toBe(worldHash(p.w));
}

const FIVE_MINUTES = 3000;

describe("two phones in lockstep over PacketAir, an AI on each", () => {
  it("keep identical hash trails at 0% loss, and the battle record replays", { timeout: 120_000 }, () => {
    const r = duel({ map: "riverlands", seed: 42, ticks: FIVE_MINUTES });
    expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
    for (const p of [r.blue, r.red]) {
      const s = p.ls.status();
      expect(p.w.tick).toBe(FIVE_MINUTES);
      expect(s.stallMs).toBeLessThanOrEqual(300);
      expect(s.framesBad).toBe(0);
      expect(s.desync).toBe(false);
      expect(p.maxFrame).toBeLessThanOrEqual(188);
    }
    expect(worldHash(r.blue.w)).toBe(worldHash(r.red.w));
    expect(r.blue.ls.turns()).toEqual(r.red.ls.turns());
    expect(r.blue.ls.turns().length).toBeGreaterThan(200);
    expectReplays(r, r.red);
  });

  for (const [loss, map, seed, mutators, strategies, delay, stall] of [
    [0.1, "archipelago", 7, ["airborne"], ["airswarm", "boom"], 5, 3_000],
    [0.3, "ashlands", 3, ["nomads"], ["ironclad", "balanced"], 6, 12_000]
  ] as const)
    it(`keep identical hash trails at ${loss * 100}% loss`, { timeout: 120_000 }, () => {
      const r = duel({ map, seed, mutators: [...mutators], strategies: [...strategies], delay, ticks: FIVE_MINUTES, air: { loss } });
      expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
      for (const p of [r.blue, r.red]) {
        expect(p.w.tick).toBe(FIVE_MINUTES);
        expect(p.ls.status().stallMs).toBeLessThanOrEqual(stall);
        expect(p.ls.status().desync).toBe(false);
      }
    });

  it("keep identical hash trails through 3 s dropouts and burst loss", { timeout: 120_000 }, () => {
    const cuts: [number, "both" | "ab" | "ba"][] = [[60_000, "both"], [150_000, "ab"], [240_000, "ba"]];
    const r = duel({
      map: "random-volcanic-k3x9a", seed: 9, mutators: ["veterans", "goldrush"], strategies: ["rush", "boom"], ticks: FIVE_MINUTES,
      air: { burst: { pGoodToBad: 0.02, pBadToGood: 0.3 } },
      every: (r) => {
        while (cuts.length && r.air.now() >= cuts[0]![0]) r.air.outage(3000, cuts.shift()![1]);
      }
    });
    expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
    expect([r.blue.w.tick, r.red.w.tick]).toEqual([FIVE_MINUTES, FIVE_MINUTES]);
    const stalls = [r.blue, r.red].map((p) => p.ls.status().stallMs);
    expect(Math.max(...stalls)).toBeGreaterThan(2500); // (the dropouts really stalled the match)
    for (const s of stalls) expect(s).toBeLessThanOrEqual(25_000);
  });

  it("rotate segments at no cost in stall against K = 1 at 0% loss, fast and robust", { timeout: 180_000 }, () => {
    const pair = (delay: number, air: PacketAirOptions) =>
      [undefined, 1].map((segmentsMax) => duel({ map: "riverlands", seed: 42, ticks: FIVE_MINUTES, delay, air, segmentsMax })) as [Run, Run];
    // where D leaves room the slack gate lets bursts out in segments, and neither phone stalls longer for it (at 250 ms
    // pairing picks D = 4; robust packets take 200 ms, so no robust link carries one in less)
    for (const [delay, air] of [[6, { mode: "fast" }], [8, { mode: "robust", latencyMs: 300 }]] as const) {
      const [k, one] = pair(delay, air);
      const label = `D ${delay}, ${air.mode}`;
      expect(Math.max(k.blue.maxSegments, k.red.maxSegments), label).toBeGreaterThan(1);
      for (const side of ["blue", "red"] as const) {
        expect(k[side].ls.status().stallMs, `${label}, ${side}`).toBeLessThanOrEqual(one[side].ls.status().stallMs);
        expect(one[side].maxSegments).toBe(1);
      }
      expect(firstDiff(k, Math.min(k.blue.w.tick, k.red.w.tick)), label).toBe(-1);
    }
    // where it leaves none (D = 5 at 250 ms, robust: a packet every two ticks), it keeps one segment: the same match
    const [k, one] = pair(5, { mode: "robust" });
    expect([k.blue.maxSegments, k.red.maxSegments]).toEqual([1, 1]);
    expect(k.blue.ls.turns()).toEqual(one.blue.ls.turns());
    expect([k.blue.ls.status().stallMs, k.red.ls.status().stallMs]).toEqual([one.blue.ls.status().stallMs, one.red.ls.status().stallMs]);
  });

  it("keep the slack gate shut at the D pairing picks in robust mode, pauses and all: the same match as K = 1", { timeout: 180_000 }, () => {
    // archipelago with airborne: the AIs' tick-0 orders overflow one turn. Read off the peer's first two frames, whose
    // slack (D − 1) latency hadn't eaten yet, the gate opened, and the opening seconds stalled: 256 and 48 ms against
    // K = 1's 48 and 0 at 500 ms. Reading the slack of a phone that had just played on after a pause (high for
    // seconds, while it catches up), it stalled the two phones 8400 and 5484 ms against 8032 and 5004.
    const pausing = (): ((r: Run) => void) => {
      const pauses: [number, "blue" | "red", number][] = [[60_000, "blue", 5_000], [150_000, "red", 8_000]];
      let paused: [Phone, number] | null = null;
      return (r) => {
        const now = r.air.now();
        if (!paused && pauses.length && now >= pauses[0]![0]) {
          const [, side, ms] = pauses.shift()!;
          paused = [r[side], now + ms];
          r[side].paused = true;
          r[side].ls.setPaused(true);
        } else if (paused && now >= paused[1]) {
          const p = paused[0];
          p.paused = false;
          p.ls.setPaused(false);
          // (what the player ordered while paused: select all, a-move)
          const army = [...p.w.units.values()].filter((u) => u.faction === p.side).map((u) => u.id);
          p.extra.push({ type: "attackMove", faction: p.side, unitIds: army, x: 10.3, y: 20.7 });
          paused = null;
        }
      };
    };
    for (const [delay, latencyMs, pauses] of [[7, 500, false], [8, 600, false], [7, 500, true]] as const) {
      const [k, one] = [undefined, 1].map((segmentsMax) =>
        duel({
          map: "archipelago", seed: 7, mutators: ["airborne"], strategies: ["airswarm", "boom"], delay, ticks: FIVE_MINUTES, segmentsMax,
          air: { mode: "robust", latencyMs, phaseMs: [5, 55] }, every: pauses ? pausing() : undefined
        })
      ) as [Run, Run];
      const label = `${latencyMs} ms, D ${delay}${pauses ? ", pauses" : ""}`;
      expect([k.blue.maxSegments, k.red.maxSegments], label).toEqual([1, 1]);
      expect(k.blue.ls.turns(), label).toEqual(one.blue.ls.turns());
      expect([k.blue.ls.status().stallMs, k.red.ls.status().stallMs], label).toEqual([one.blue.ls.status().stallMs, one.red.ls.status().stallMs]);
      expect(firstDiff(k, FIVE_MINUTES), label).toBe(-1);
    }
  });

  it("stop rotating for the match once the peer stalls in a rotation: burst loss costs little more than with K = 1", { timeout: 120_000 }, () => {
    // at 250 ms pairing picks D = 4; at 7 the gate opens. A lost packet costs the newest turns a whole rotation, and
    // the gate can't see loss coming: rotating on regardless, the two phones stalled 512 and 600 ms longer than with
    // K = 1 over these five minutes (now 96 and 120)
    const [k, one] = [undefined, 1].map((segmentsMax) =>
      duel({
        map: "riverlands", seed: 42, delay: 7, ticks: FIVE_MINUTES, segmentsMax,
        air: { latencyMs: 250, phaseMs: [5, 55], burst: { pGoodToBad: 0.02, pBadToGood: 0.3 } }
      })
    ) as [Run, Run];
    expect(Math.max(k.blue.maxSegments, k.red.maxSegments)).toBeGreaterThan(1);
    for (const side of ["blue", "red"] as const) {
      expect(one[side].ls.status().stallMs).toBeGreaterThan(2_000); // (the loss really stalled the match)
      expect(k[side].ls.status().stallMs, side).toBeLessThanOrEqual(one[side].ls.status().stallMs + 300);
    }
    // (in sync to the end: five minutes, or the tick a side won, both phones together)
    expect(k.blue.w.tick).toBe(k.red.w.tick);
    expect(firstDiff(k, Math.min(FIVE_MINUTES, k.blue.w.tick))).toBe(-1);
  });

  it("rotate at each phone's own packet period when the two directions run different modes", { timeout: 120_000 }, () => {
    // blue sends fast and red robust (modes are per direction), each giving its Lockstep the period it sends at, at
    // 300 ms with D = 8: room for the gate to open, and a 30-unit select-all order from each side every 10 s. Read off
    // the peer's arrivals instead, each phone's period was the other's: red took 100 ms and opened three segments (at
    // its own 200 ms, two at most), and blue stalled 48 ms where K = 1 stalled neither phone
    const bursts = (p: Phone, t: number) => {
      if (t % 100 !== 50 || t > FIVE_MINUTES - 300) return;
      const mine = [...p.w.units.values()].filter((u) => u.faction === p.side).map((u) => u.id);
      const ids = [...mine, ...Array.from({ length: 30 }, (_, i) => 5000 + 40 * t + 37 * i)].slice(0, 30);
      p.extra.push({ type: "move", faction: p.side, unitIds: ids, x: 10 + (t % 37), y: 20.3 });
    };
    const [k, one] = [undefined, 1].map((segmentsMax) =>
      duel({
        map: "riverlands", seed: 7, ticks: FIVE_MINUTES, delay: 8, segmentsMax, air: { latencyMs: 300 }, modes: ["fast", "robust"], packetMs: true,
        afterStep: bursts
      })
    ) as [Run, Run];
    expect(k.blue.maxSegments).toBeGreaterThan(1);
    for (const side of ["blue", "red"] as const) {
      expect(k[side].ls.status().stallMs, side).toBeLessThanOrEqual(one[side].ls.status().stallMs);
      expect(one[side].maxSegments).toBe(1);
    }
    // (the fast sender's bursts land sooner for its rotation: 20 ticks on average against K = 1's 37)
    expect(k.blue.ls.status().orderDelay!).toBeLessThan(one.blue.ls.status().orderDelay!);
    expect(firstDiff(k, FIVE_MINUTES)).toBe(-1);
    expect(firstDiff(one, FIVE_MINUTES)).toBe(-1);
  });

  it("keep identical hash trails with bursts of 30-unit orders", { timeout: 120_000 }, () => {
    // burst n's orders go to cells of their own: tile column n, at the 1/16-tile rows MOVE_ROW and ATTACK_ROW
    const MOVE_ROW = Math.floor((20 + Math.E / 7) * 16);
    const ATTACK_ROW = Math.floor(41.0001 * 16);
    const bursts: Record<Faction, { at: number; ids: number[] }[]> = { blue: [], red: [] };
    const cellOf = (c: Command) => ("x" in c && c.x !== undefined && c.y !== undefined ? { n: Math.floor(c.x), row: Math.floor(c.y * 16) } : null);
    const r = duel({
      map: "riverlands", seed: 8, strategies: ["balanced", "balanced"], delay: 4, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (t % 100 !== 50 || t > FIVE_MINUTES - 300) return;
        // a select-all order: every unit of this side, padded with ids nobody owns (sparse, as a long match's
        // ids are: wrecks, crates and effects share the counter), raw float coordinates
        const mine = [...p.w.units.values()].filter((u) => u.faction === p.side).map((u) => u.id);
        const ids = [...mine, ...Array.from({ length: 30 }, (_, i) => 5000 + 40 * t + 37 * i)].slice(0, 30).reverse();
        const n = bursts[p.side].length;
        bursts[p.side].push({ at: t, ids });
        // (an attackMove, which the move right after it replaces in the queue, then the move)
        p.extra.push({ type: "attackMove", faction: p.side, unitIds: ids, x: n + 0.37, y: 41.0001 });
        p.extra.push({ type: "move", faction: p.side, unitIds: ids, x: n + Math.PI / 10, y: 20 + Math.E / 7 });
      }
    });
    expect(bursts.blue.length + bursts.red.length).toBeGreaterThan(40);
    expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
    for (const p of [r.blue, r.red]) {
      const s = p.ls.status();
      expect(p.w.tick).toBe(FIVE_MINUTES);
      expect(p.maxFrame).toBeLessThanOrEqual(188);
      expect(s.queued).toBe(0); // (every burst went out)
      expect(s.stallMs).toBeLessThanOrEqual(3_000);
      const stepped = p.ls.turns().filter(([, side]) => side === p.side).flatMap(([t, , cmds]) => cmds.map((c) => [t, c] as const));
      let split = 0;
      bursts[p.side].forEach(({ at, ids }, n) => {
        const pieces = stepped
          .filter(([, c]) => c.type === "move" && cellOf(c)?.n === n && cellOf(c)?.row === MOVE_ROW)
          .map(([, c]) => c as Extract<Command, { type: "move" }>);
        if (pieces.length > 1) split++;
        for (const c of pieces) expect(commandBits(c, MAP)).toBeLessThanOrEqual(C_MAX);
        const got = new Set(pieces.flatMap((c) => c.unitIds));
        // the attackMove never went out: the move replaced it before either was sealed
        expect(stepped.some(([, c]) => c.type === "attackMove" && cellOf(c)?.n === n && cellOf(c)?.row === ATTACK_ROW)).toBe(false);
        // every unit got this order, or a newer move or attackMove replaced it in the queue (padding ids: never)
        for (const id of ids)
          if (!got.has(id))
            expect(stepped.some(([t, c]) => t > at && (c.type === "move" || c.type === "attackMove") && c.unitIds.includes(id)), `burst ${n} id ${id}`).toBe(true);
        for (const id of ids) if (id >= 5000) expect(got.has(id)).toBe(true);
      });
      expect(split).toBeGreaterThan(5);
    }
  });

  for (const every of [10, 20])
    it(`keep a player's orders flowing when they re-order a 30-unit army every ${every / 10} s`, { timeout: 120_000 }, () => {
      // blue is a player with no AI: from tick 100 to 1300 they select their whole army and a-move it every 1 or
      // 2 s, as often as or more often than the window rule lets one such order out; order n goes to its own cell
      // (column n % 50, row n / 50), so each landed piece says which order it was
      const orders: { at: number; ids: number[] }[] = [];
      const TICKS = 1500;
      const r = duel({
        map: "riverlands", seed: 8, strategies: [null, "balanced"], delay: 5, ticks: TICKS,
        prepare: (w) => {
          // (ids 10 apart, as in a long match: red's spare scouts take the ones between)
          for (let i = 0; i < 30; i++) {
            spawnUnit(w, "stinger", "blue", 8 + (i % 6), 40 + Math.floor(i / 6));
            for (let j = 0; j < 9; j++) spawnUnit(w, "scout", "red", 48, 8);
          }
        },
        afterStep: (p, t) => {
          if (p.side !== "blue" || t < 100 || t > 1300 || t % every) return;
          const army = [...p.w.units.values()].filter((u) => u.faction === "blue" && u.kind === "stinger").map((u) => u.id);
          const n = orders.length;
          orders.push({ at: t, ids: army });
          p.extra.push({ type: "attackMove", faction: "blue", unitIds: army, x: 0.5 + (n % 50), y: 0.5 + Math.floor(n / 50) });
        }
      });
      // (the army may well win: then both phones end on the same tick)
      const end = r.blue.w.tick;
      expect(r.red.w.tick).toBe(end);
      expect(end === TICKS || r.blue.w.winner !== null).toBe(true);
      expect(firstDiff(r, end)).toBe(-1);
      // when each unit's orders landed: [tick, order]
      const landed = new Map<number, [number, number][]>();
      for (const [t, side, cmds] of r.red.ls.turns())
        for (const c of cmds)
          if (side === "blue" && c.type === "attackMove")
            for (const id of c.unitIds) landed.set(id, [...(landed.get(id) ?? []), [t, Math.floor(c.y) * 50 + Math.floor(c.x)]]);
      // every unit hears an order at least as new as each one given within 6 s, none waiting for ever behind the
      // rest (in plain FIFO order the queue grew for as long as the orders kept coming: 20–40 s behind at 2 s)
      let worst = 0;
      const checked = orders.filter(({ at }) => at + 50 <= end);
      expect(checked.length).toBeGreaterThan(400 / every);
      for (const [n, { at, ids }] of checked.entries())
        for (const id of ids) {
          const first = landed.get(id)?.find(([, m]) => m >= n);
          expect(first, `order ${n}, unit ${id}`).toBeDefined();
          worst = Math.max(worst, first![0] - at);
        }
      expect(worst).toBeLessThanOrEqual(60);
      const s = r.blue.ls.status();
      if (end === TICKS) expect(s.queued).toBe(0);
      expect(r.blue.maxQueued).toBeLessThanOrEqual(10);
      expect(r.blue.maxQueuedTicks).toBeLessThanOrEqual(50);
      expect(s.stallMs).toBeLessThanOrEqual(1_000);
    });

  it("keep identical hash trails with pauses on both phones", { timeout: 120_000 }, () => {
    const pauses: [number, "blue" | "red", number][] = [[50_000, "red", 8_000], [120_000, "blue", 2_000]];
    let sealedAtPause = -1;
    let pausedPhone: Phone | null = null;
    let until = 0;
    const r = duel({
      map: "proving-grounds", seed: 4, strategies: ["boom", "ironclad"], delay: 4, ticks: 2000, air: { latencyMs: 150 },
      every: (r) => {
        const now = r.air.now();
        if (!pausedPhone && pauses.length && now >= pauses[0]![0]) {
          const [, side, ms] = pauses.shift()!;
          pausedPhone = r[side];
          pausedPhone.paused = true;
          pausedPhone.ls.setPaused(true);
          sealedAtPause = pausedPhone.ls.status().newestSealed;
          until = now + ms;
        } else if (pausedPhone && now >= until) {
          // nothing was sealed while paused, and the other phone got no further than D + 1 ticks ahead
          expect(pausedPhone.ls.status().newestSealed).toBe(sealedAtPause);
          const other = pausedPhone === r.blue ? r.red : r.blue;
          expect(other.w.tick - pausedPhone.w.tick).toBeLessThanOrEqual(4 + 1);
          pausedPhone.paused = false;
          pausedPhone.ls.setPaused(false);
          pausedPhone = null;
        }
      }
    });
    expect(pauses).toEqual([]);
    expect([r.blue.w.tick, r.red.w.tick]).toEqual([2000, 2000]);
    expect(firstDiff(r, 2000)).toBe(-1);
    // each saw "Friend paused" once it stalled
    expect([r.blue.sawPeerPaused, r.red.sawPeerPaused]).toEqual([true, true]);
  });

  it("end on the same tick when a side resigns, check the end, and the record replays", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (p.side === "red" && t === 900) p.extra.push({ type: "resign", faction: "red" });
      },
      until: (r) => [r.blue, r.red].every((p) => p.ls.status().endCheck !== "pending")
    });
    const [sb, sr] = [r.blue.ls.status(), r.red.ls.status()];
    expect(sb.decided!.tick).toBe(sr.decided!.tick);
    expect(sb.decided!.tick).toBeGreaterThanOrEqual(900 + 5);
    expect(sb.decided).toEqual({ winner: "blue", resigned: "red", tick: sb.decided!.tick });
    expect([sb.endCheck, sr.endCheck]).toEqual(["ok", "ok"]);
    for (const p of [r.blue, r.red]) expect([p.w.winner, p.w.resigned, p.w.tick]).toEqual(["blue", "red", sb.decided!.tick + 1]);
    expect(firstDiff(r, sb.decided!.tick + 1)).toBe(-1);
    expectReplays(r, r.blue);
  });

  it("catch a desync injected into one world at the next checkpoint", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: 1400,
      afterStep: (p, t) => {
        if (p.side === "blue" && t === 1230) p.w.factions.blue.scrap += 7;
      }
    });
    expect(firstDiff(r, 1400)).toBe(1231);
    for (const p of [r.blue, r.red]) {
      expect(p.ls.status().desync).toBe(true);
      expect(p.desyncAt!).toBeGreaterThan(1250);
      expect(p.desyncAt!).toBeLessThanOrEqual(1250 + 2 * 5 + 2);
    }
    expect([r.blue.ls.status().desyncReason, r.red.ls.status().desyncReason]).toContain("checkpoint");
    expect(CHECKPOINT_EVERY).toBe(50);
  });

  it("catch a desync after the last checkpoint at the end check", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: 1400,
      afterStep: (p, t) => {
        if (p.side === "blue" && t === 1210) p.extra.push({ type: "resign", faction: "blue" });
        if (p.side === "red" && t === 1205) p.w.factions.red.scrap += 3;
      },
      until: (r) => [r.blue, r.red].every((p) => p.ls.over() && p.ls.status().desync)
    });
    const T = r.blue.ls.status().decided?.tick ?? r.red.ls.status().decided!.tick;
    const reasons = [r.blue.ls.status().desyncReason, r.red.ls.status().desyncReason];
    // (the resign normally lands before tick 1250; if a burst held it back, checkpoint 1250 catches the drift instead)
    expect(reasons).toContain(T < 1250 ? "end" : "checkpoint");
    for (const p of [r.blue, r.red]) expect(p.ls.status().desync).toBe(true);
  });

  it("catch a world decided on one phone only", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: 1000,
      afterStep: (p, t) => {
        if (p.side === "blue" && t === 700) hqOf(p.w, "blue")!.hp = 0; // (blue's HQ falls on this phone alone: decided on the next step)
      },
      until: (r) => r.blue.ls.status().desync && r.red.ls.status().desync
    });
    // (and the decided phone's report says out of sync, not "Checking sync…" and then "Not verified")
    expect(r.blue.ls.status()).toMatchObject({ desync: true, desyncReason: "peer", decided: { tick: 701 }, endCheck: "mismatch" });
    expect(r.red.ls.status()).toMatchObject({ desync: true, desyncReason: "end", decided: null, endCheck: "mismatch" });
  });

  it("tell the other phone when one leaves or aborts", { timeout: 60_000 }, () => {
    for (const reason of ["left", "desync"] as const) {
      let leftAt = -1;
      const r = duel({
        map: "riverlands", seed: 42, ticks: 600,
        afterStep: (p, t, run) => {
          if (p.side === "blue" && t === 300) {
            p.ls.leave(reason);
            leftAt = run.air.now();
          }
        },
        until: (r) => r.red.ls.over()
      });
      const s = r.red.ls.status();
      expect(s.peerEnd).toBe(reason);
      expect(s.desync).toBe(reason === "desync");
      // within a packet period and the latency (plus a frame each side)
      expect(r.air.now() - leftAt).toBeLessThanOrEqual(100 + 250 + 40);
      expect(r.red.w.tick).toBeLessThanOrEqual(301 + 5);
    }
  });

  it("say \"Not verified\" when the peer's end report never arrives", { timeout: 120_000 }, () => {
    let cut = false;
    const r = duel({
      map: "riverlands", seed: 42, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (p.side === "red" && t === 600) p.extra.push({ type: "resign", faction: "red" });
      },
      every: (r) => {
        // blue stops hearing red the moment blue's world is decided
        if (!cut && r.blue.ls.status().end === "decided") {
          cut = true;
          r.air.outage(30_000, "ba");
        }
      },
      until: (r) => r.blue.ls.status().endCheck !== "pending" && r.red.ls.status().endCheck !== "pending"
    });
    expect(r.blue.ls.status().endCheck).toBe("unverified");
    expect(r.red.ls.status().endCheck).toBe("ok");
  });
});
