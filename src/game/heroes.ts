import { UNITS } from "../sim/balance";
import { hash32 } from "../sim/rand";
import type { Faction, UnitKind, World } from "../sim/types";
import { tr } from "../lang";

/**
 * Veteran heroes: every unit has a callsign derived from its id; from rank 2
 * ("Hardened") the game uses it — in the selection panel, in toasts when it
 * is promoted or falls, and on the after-action report's MVP card.
 *
 * Presentation only (no three.js, no sim state): callsigns live in a per-world
 * registry so every HUD piece agrees on a unit's name. The first choice is a
 * pure hash of the unit id; a name the same side has already used this match
 * is skipped, so two living "Vipers" never share a squad.
 */

export const CALLSIGNS: readonly string[] = [
  "Viper", "Ironhide", "Bulldog", "Sable", "Havoc", "Rook", "Jinx", "Talon",
  "Brick", "Nova", "Vandal", "Grit", "Onyx", "Ghost", "Hammer", "Kestrel",
  "Rampart", "Mako", "Ember", "Banshee", "Diesel", "Sparrow", "Tusk", "Cobalt",
  "Wraith", "Maverick", "Anvil", "Rascal", "Hex", "Lynx", "Bastion", "Zephyr",
  "Torque", "Vixen", "Grizzly", "Comet", "Ratchet", "Spectre", "Blitz", "Flint",
  "Mantis", "Juggernaut", "Echo", "Scorch", "Bruiser", "Valkyrie", "Patch", "Thunder"
];

/** Rank at which a unit is "named" (callsign shown, deaths reported). */
export const NAMED_RANK = 2;

/** Promotion titles by rank (index 0 unused). */
export const RANK_TITLES: readonly string[] = tr(["", "VÉTÉRAN", "AGUERRI", "ÉLITE"], ["", "VETERAN", "SEASONED", "ELITE"]);

const ROMAN = ["", "", " II", " III", " IV", " V", " VI", " VII", " VIII", " IX"];

/** First-choice callsign for a unit id (pure, stable across sessions). */
export function baseCallsign(id: number): number {
  return hash32(id, 0x5ca11) % CALLSIGNS.length;
}

export class CallsignRegistry {
  private names = new Map<number, string>();
  private used: Record<Faction, Map<string, number>> = { blue: new Map(), red: new Map() };

  /** The unit's callsign, assigning one on first use. */
  name(id: number, faction: Faction): string {
    const have = this.names.get(id);
    if (have) return have;
    const used = this.used[faction];
    const base = baseCallsign(id);
    let pick: string | null = null;
    for (let i = 0; i < CALLSIGNS.length && !pick; i++) {
      const n = CALLSIGNS[(base + i) % CALLSIGNS.length]!;
      if (!used.has(n)) pick = n;
    }
    let name: string;
    if (pick) {
      used.set(pick, 1);
      name = pick;
    } else {
      // all 48 taken this match (long Last Stand runs): Viper II, Viper III…
      const root = CALLSIGNS[base]!;
      const n = (used.get(root) ?? 1) + 1;
      used.set(root, n);
      name = `${root}${ROMAN[n] ?? ` ${n}`}`;
    }
    this.names.set(id, name);
    return name;
  }

  /** Give a unit its own name (an op's hero: « Valmont »), before anything asks for one. */
  set(id: number, faction: Faction, name: string): void {
    this.names.set(id, name);
    this.used[faction].set(name, 1);
  }

  /** The callsign if one was already assigned (no side effects). */
  peek(id: number): string | undefined {
    return this.names.get(id);
  }
}

const registries = new WeakMap<World, CallsignRegistry>();

/** The match's shared callsign registry. */
export function callsigns(w: World): CallsignRegistry {
  let r = registries.get(w);
  if (!r) registries.set(w, (r = new CallsignRegistry()));
  return r;
}

export function callsignOf(w: World, u: { id: number; faction: Faction }): string {
  return callsigns(w).name(u.id, u.faction);
}

export const stars = (rank: number): string => "★".repeat(Math.max(0, Math.min(3, rank)));

export const killsLabel = (n: number): string => tr(`${n} élim.`, `${n} kills`);

/** "Viper (Lancer, 9 kills)" — the toast form. */
export function heroShort(w: World, u: { id: number; faction: Faction; kind: UnitKind; kills: number }): string {
  return `${callsignOf(w, u)} (${UNITS[u.kind].name}, ${killsLabel(u.kills)})`;
}

/** "★★ Viper · Lancer · 9 kills" — the selection-panel form. */
export function heroLine(
  w: World,
  u: { id: number; faction: Faction; kind: UnitKind; kills: number; rank: number }
): string {
  return `${stars(u.rank)} ${callsignOf(w, u)} · ${UNITS[u.kind].name} · ${killsLabel(u.kills)}`;
}
