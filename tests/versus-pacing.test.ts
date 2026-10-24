import { describe, expect, it } from "vitest";
import { planTicks } from "../src/game/awareness";
import { PacketAir, type PacketAirOptions } from "../src/link/packet-air";
import type { LinkTransport } from "../src/link/transport";
import { hash32 } from "../src/sim/rand";
import { Session } from "../src/versus/session";

/**
 * The speed trim over minutes (DUEL.md "Pacing"): two Sessions paired
 * over a link, driven as GameScene and VersusFeed drive them (the feed's pump
 * at the top of each animation frame and every 50 ms, the speed read, the
 * ticks the frame allows, the feed's pump after them), with stand-in world
 * hashes and no orders, so only the pacing is measured. Animation frames come
 * at 60 Hz on one phone and a hair faster on the other.
 */

interface Air {
  readonly a: LinkTransport;
  readonly b: LinkTransport;
  now(): number;
  advance(ms: number): void;
}

const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0x5e55, i++) / 4294967296;
};

/** Ticks a second each phone stepped over `seconds` once both had played `warmS`, the D pairing picked, and the stall in that span. */
function pace(air: Air, seconds: number, o: { warmS?: number; stepMs?: number } = {}) {
  const phones = (["host", "guest"] as const).map((role, i) => ({
    s: new Session({ transport: i ? air.b : air.a, role, build: 0x5eed, random: rng(i + 3), adaptMode: false, ...(i ? {} : { host: { map: "riverlands", mutators: [] } }) }),
    frameMs: i ? 16.6 : 1000 / 60, next: 0, last: 0, acc: 0, pumpAt: 0, cardsAt: null as number | null
  }));
  let from: { at: number; ticks: number[]; stalls: number[] } | null = null;
  let playing: number | null = null;
  const status = () => phones.map((p) => p.s.lockstep?.status() ?? null);
  const limit = air.now() + 60_000 + ((o.warmS ?? 20) + seconds) * 1000;
  while (air.now() < limit) {
    air.advance(o.stepMs ?? 1);
    const now = air.now();
    for (const p of phones) {
      const s = p.s;
      if (now >= p.pumpAt) {
        p.pumpAt = now + 50;
        s.pump();
      }
      if (now < p.next) continue;
      const dt = now - p.last;
      p.last = now;
      p.next += p.frameMs;
      s.pump();
      if (s.phase === "pairing") {
        const st = s.pairing.state();
        if (st.phase === "picking" && now - (p.cardsAt ??= now) > 500) s.pick(st.offered[0]!);
      } else if (s.phase === "starting") s.beginMatch(0x1234);
      const ls = s.lockstep;
      if (ls) {
        const plan = planTicks(p.acc, dt, s.speed());
        p.acc = plan.acc;
        for (let i = 0; i < plan.ticks; i++) {
          const t = ls.status().tick;
          if (!s.commandsFor(t, () => [])) {
            p.acc = 99.9; // (GameScene: no catch-up burst after a stall)
            break;
          }
          s.afterStep(t, hash32(t, 77), null);
        }
      }
      s.pump();
    }
    const st = status();
    if (playing === null && st.every((x) => x && x.tick > 0)) playing = now;
    if (!from && playing !== null && now - playing >= (o.warmS ?? 20) * 1000)
      from = { at: now, ticks: st.map((x) => x!.tick), stalls: st.map((x) => x!.stallMs) };
    if (from && now - from.at >= seconds * 1000) break;
  }
  if (!from) throw new Error("the match never got going");
  const st = status();
  const span = air.now() - from.at;
  return {
    tps: st.map((x, i) => ((x!.tick - from!.ticks[i]!) * 1000) / span),
    stallMs: st.map((x, i) => x!.stallMs - from!.stalls[i]!),
    delay: phones[0]!.s.result()!.delay
  };
}

describe("the speed trim", () => {
  // the match must run at 1× over minutes, with D leaving a tick or two of slack spare (where the trim has room to drift:
  // at the D pairing picks the slack sits near 0 and the stalls pace the match). Comparing this phone's live slack with
  // the slack the friend's newest frame reported ran all of these 0.6–1.4% slow (9.86–9.94 ticks a second): frames are
  // built at the top of the per-tick sawtooth (at a seal, before the step), so each phone saw its friend ahead.
  // Robust on the low plan (400 ms packets, four builds a packet) is the case that comparing with the newest frame
  // built, rather than the one on the air, ran fast (1.6–2.9%)
  const air = (o: PacketAirOptions) => new PacketAir({ seed: 7, clockOffsetMs: [0, 31_337], mode: "robust", ...o });
  const LOW = { plan: "low", periodMs: { fast: 200, robust: 400 } } as const;
  const cases: [string, PacketAirOptions, number][] = [
    ["fast, 400 ms", { latencyMs: 400 }, 6],
    ["robust, 250 ms", { latencyMs: 250, snrDb: 10 }, 5],
    ["robust, 400 ms", { latencyMs: 400, snrDb: 10 }, 7],
    ["the low plan's fast, 300 ms", { latencyMs: 300, ...LOW }, 6],
    ["the low plan's robust, 300 ms", { latencyMs: 300, snrDb: 10, ...LOW }, 8]
  ];
  for (const [label, o, D] of cases)
    it(`runs at 1× over three minutes with slack to spare: ${label}`, { timeout: 120_000 }, () => {
      const r = pace(air(o), 180);
      expect(r.delay).toBe(D);
      for (const tps of r.tps) expect(Math.abs(tps - 10), `${tps} ticks a second`).toBeLessThan(0.01);
      for (const ms of r.stallMs) expect(ms).toBeLessThanOrEqual(150);
    });

});
