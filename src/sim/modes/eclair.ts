import { TICK_RATE } from "../balance";
import { uplinkPaying } from "../objectives";
import type { EclairState, Faction, World } from "../types";

/**
 * Éclair: a skirmish that ends within six minutes (the `eclair` mutator,
 * rules.ts). Both sides start with ECLAIR.startScrap and build twice as
 * fast, and score victory points as they go:
 *
 *   - destroying an enemy unit or building scores its cost (combat.ts
 *     creditKill calls eclairKill);
 *   - every second, each Uplink a side holds (and that pays: an island relay
 *     only while crewed) scores ECLAIR.relayPts.
 *
 * At ECLAIR.rushAtS, the last minute: every side's income doubles. At
 * ECLAIR.lengthS the side ahead on points wins, unless the lead is within
 * ECLAIR.closeShare of the leader's points (or under ECLAIR.closeMin): then
 * sudden death, where the next destruction decides (the relays score no more,
 * and both sides destroying the same value on the same tick plays on). Past
 * ECLAIR.overtimeS of it with nothing destroyed, the points decide, and equal
 * points are a draw. Destroying the enemy's HQ (with no Goliath left) still
 * wins at once, as in any skirmish.
 *
 * Old records never have the mutator, so no world of theirs has an
 * EclairState and their hashes stay what they were (checksum.ts folds it in
 * only when there is one).
 */
export const ECLAIR = {
  /** Coal each side starts with (Blitz's). */
  startScrap: 3000,
  /** Build progress per tick (Production éclair's). */
  buildSpeed: 2,
  /** The match's regular length (s). */
  lengthS: 360,
  /** The last minute starts here (s): income doubles. */
  rushAtS: 300,
  rushIncome: 2,
  /** Points a second for each Uplink held. */
  relayPts: 8,
  /** At the whistle, a lead under this share of the leader's points … */
  closeShare: 0.05,
  /** … or under this many points goes to sudden death. */
  closeMin: 150,
  /** Sudden death lasts at most this long (s). */
  overtimeS: 120
} as const;

const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

/** A fresh Éclair (maps.ts createMapWorld, for a skirmish under the mutator). */
export function createEclair(): EclairState {
  return { points: { blue: 0, red: 0 }, relays: { blue: 0, red: 0 }, phase: "play", decided: null, at: null };
}

/** Seconds left of the regular time (0 once it's over), for the HUD. */
export function eclairLeftS(w: World): number {
  return Math.max(0, ECLAIR.lengthS - w.tick / TICK_RATE);
}

/** Is a lead of `lead` points, with the leader on `top`, close enough for sudden death? */
export function eclairClose(lead: number, top: number): boolean {
  return lead < Math.max(ECLAIR.closeMin, top * ECLAIR.closeShare);
}

/** `victim`'s side lost something worth `value`: the other side scores it (combat.ts creditKill). */
export function eclairKill(w: World, victim: Faction, value: number): void {
  const e = w.eclair;
  if (!e || e.phase === "over") return;
  e.points[other(victim)] += value;
}

/** Once a tick, after combat and the Uplinks (sim.ts step). */
export function tickEclair(w: World): void {
  const e = w.eclair;
  if (!e || e.phase === "over") return;
  if (w.winner) {
    // (decided otherwise: an HQ, a resign, Robot Love)
    e.phase = "over";
    return;
  }
  const t = w.tick;
  // the relays score once a second, until sudden death
  if (e.phase !== "overtime" && (t + 1) % TICK_RATE === 0)
    for (const l of w.objectives.uplinks)
      if (l.owner && uplinkPaying(l)) {
        e.points[l.owner] += ECLAIR.relayPts;
        e.relays[l.owner] += ECLAIR.relayPts;
      }
  if (e.phase === "play" && t + 1 >= ECLAIR.rushAtS * TICK_RATE) {
    e.phase = "rush";
    if (w.rules) w.rules.incomeMult *= ECLAIR.rushIncome;
    w.fx.push({ type: "eclair", phase: "rush" });
  }
  if (e.phase === "rush" && t + 1 >= ECLAIR.lengthS * TICK_RATE) {
    const { blue, red } = e.points;
    if (blue !== red && !eclairClose(Math.abs(blue - red), Math.max(blue, red))) return end(w, e, blue > red ? "blue" : "red", "points");
    e.phase = "overtime";
    e.at = { blue, red };
    w.fx.push({ type: "eclair", phase: "overtime" });
    return;
  }
  if (e.phase === "overtime") {
    const at = e.at!;
    const gained = { blue: e.points.blue - at.blue, red: e.points.red - at.red };
    if (gained.blue !== gained.red) return end(w, e, gained.blue > gained.red ? "blue" : "red", "sudden");
    if (t + 1 >= (ECLAIR.lengthS + ECLAIR.overtimeS) * TICK_RATE) {
      const { blue, red } = e.points;
      return end(w, e, blue === red ? "draw" : blue > red ? "blue" : "red", "time");
    }
  }
}

function end(w: World, e: EclairState, winner: Faction | "draw", how: NonNullable<EclairState["decided"]>): void {
  e.phase = "over";
  e.decided = how;
  w.winner = winner;
  w.fx.push({ type: "eclair", phase: "end" });
}
