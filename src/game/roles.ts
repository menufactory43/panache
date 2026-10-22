/**
 * Role groups: the whole army of one kind of fighting, one tap away beside
 * the three saved squads (src/ui/command.ts): Infanterie (robot squads),
 * Blindés (everything else on the ground, hover included, Goliaths too) and
 * Aviation (aircraft). Harvesters and unarmed Condors are never in one:
 * the groups split ⚔ Armée (Controller.armyIds), nothing more. Engine-free
 * and tested (tests/roles.test.ts).
 */
import { UNITS } from "../sim/balance";
import { isInfantry } from "../sim/infantry";
import type { Unit, UnitKind } from "../sim/types";

export type Role = "infantry" | "armour" | "air";

export const ROLES: readonly { id: Role; label: string; short: string; glyph: string }[] = [
  { id: "infantry", label: "Infanterie", short: "Inf.", glyph: "♞" },
  { id: "armour", label: "Blindés", short: "Blind.", glyph: "⛭" },
  { id: "air", label: "Aviation", short: "Aviat.", glyph: "✈" }
];

/** The role of a unit kind. */
export function roleOf(kind: UnitKind): Role {
  if (UNITS[kind].domain === "air") return "air";
  return isInfantry(kind) ? "infantry" : "armour";
}

/** Army units by role, in the order given (ids). */
export function roleGroups(army: Iterable<Unit>): Record<Role, number[]> {
  const out: Record<Role, number[]> = { infantry: [], armour: [], air: [] };
  for (const u of army) out[roleOf(u.kind)].push(u.id);
  return out;
}

/**
 * The most common kind in a group (ties: the pricier one), for its chip's
 * portrait; null for an empty group.
 */
export function leadKind(units: Iterable<Unit>): UnitKind | null {
  const n = new Map<UnitKind, number>();
  for (const u of units) n.set(u.kind, (n.get(u.kind) ?? 0) + 1);
  let best: UnitKind | null = null;
  for (const [k, c] of n) {
    const b = best === null ? 0 : n.get(best)!;
    if (c > b || (c === b && UNITS[k].cost > UNITS[best!].cost)) best = k;
  }
  return best;
}
