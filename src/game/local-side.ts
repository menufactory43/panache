/**
 * The order a match is set up and stepped in, whichever side this device
 * commands. The sim hands out entity ids from one shared counter as it
 * applies openers and commands, so blue's always go first: in a duel
 * (DUEL.md) a phone that put its own first would give the same tank
 * another id than its friend's phone did, and the next order naming it would
 * move nothing on one of them. Single player keeps the same order, so red
 * against the AI plays the world a duel would. Engine-free.
 */
import { tickFog } from "../sim/fog";
import { applyOpener, type AppliedOpener, type OpenerId } from "../sim/openers";
import type { Command, Faction, World } from "../sim/types";

/** A tick's commands as the sim takes them: blue's, then red's, each side's in the order given. */
export function composeTick(local: Faction, mine: readonly Command[], theirs: readonly Command[]): Command[] {
  return local === "blue" ? [...mine, ...theirs] : [...theirs, ...mine];
}

/**
 * Give each side its opener, blue's first whatever order `picks` lists them
 * in, then draw the fog once: what setupWorld (sim/setup.ts) does after the
 * map, for a world already on screen behind the opener cards. Returns what
 * each side got (for the roll-out flourish).
 */
export function applyOpenersCanonical(w: World, picks: Partial<Record<Faction, OpenerId>>): Partial<Record<Faction, AppliedOpener>> {
  const applied: Partial<Record<Faction, AppliedOpener>> = {};
  for (const f of ["blue", "red"] as const) {
    const id = picks[f];
    if (id) applied[f] = applyOpener(w, f, id);
  }
  tickFog(w);
  return applied;
}
