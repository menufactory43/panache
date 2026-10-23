import { POWER_NAMES } from "../sim/powers";
import type { Faction, FxEvent, PowerKind, World } from "../sim/types";
import { hqOf } from "../sim/world";
import { EN } from "../lang";

/**
 * Which deaths a commander calldown caused. powers.ts credits calldown damage
 * to the firing side's HQ (so faction stats count it, and no unit gets the
 * XP), and its victims die in the same tick it lands, after that tick's
 * `calldownImpact` event. So a calldown kill is a death whose killer is the
 * enemy HQ — a building, no unit kind — within reach of one of that side's
 * impacts this tick. A side with no HQ standing (Nomads, or one fighting on
 * with a Goliath) still calls down strikes, with no HQ to credit: then its
 * victims die with no killer at all, and such a death within reach counts. The presentation layers (streak callouts, the
 * chronicle and report, hero toasts, hotspots) use this to name the Barrage
 * or Sky Hammer instead of crediting "defences" or the HQ.
 *
 * Engine-free and tested (tests/calldown-credit.test.ts).
 */

export interface CalldownKill {
  power: PowerKind;
  /** The side that fired it (the victim's enemy). */
  faction: Faction;
  /** The calldown's id (all shells of one Barrage share it). */
  calldownId: number;
}

type Impact = Extract<FxEvent, { type: "calldownImpact" }>;
type Death = Extract<FxEvent, { type: "death" }>;

/** Reach beyond an impact's radius: a building's centre sits inside its footprint; a unit may have moved this tick. */
const SLACK = { unit: 1, building: 2.2 } as const;

/** "Barrage", "Sky Hammer"… */
export const powerName = (p: PowerKind): string => POWER_NAMES[p];

/** "a Barrage", "an EMP", "the Sky Hammer" (in running text). */
export function powerPhrase(p: PowerKind): string {
  // (the late strikes and the nations' named powers take the definite article: "le Rayon Curie", "la Pression des chaudières")
  if (EN) return POWER_NAMES[p]; // ("Creusot destroyed by Rolling Barrage")
  if (p === "hammer") return `l'${POWER_NAMES[p]}`;
  if (p === "emp" || p === "pression") return `la ${POWER_NAMES[p]}`;
  if (p === "curie" || p === "gaz") return `le ${POWER_NAMES[p]}`;
  return `un ${POWER_NAMES[p]}`;
}

/**
 * Was `death` a calldown kill? `impacts` are this tick's impacts so far;
 * `hqId` names each side's HQ (null when it has none), `hqStanding` says
 * whether it still stands (a side without one credits its strikes to no one).
 */
export function calldownKillOf(
  death: Death,
  impacts: readonly Impact[],
  hqId: (f: Faction) => number | null,
  hqStanding: (f: Faction) => boolean = (f) => hqId(f) !== null
): CalldownKill | null {
  if (death.killerKind !== null) return null;
  const by: Faction = death.faction === "blue" ? "red" : "blue";
  if (death.killerId === null ? hqStanding(by) : death.killerId !== hqId(by)) return null;
  const slack = death.buildingKind ? SLACK.building : SLACK.unit;
  let best: Impact | null = null;
  let bestD = Infinity;
  for (const im of impacts) {
    if (im.faction !== by) continue;
    const d = Math.hypot(death.x - im.x, death.y - im.y);
    if (d <= im.radius + slack && d < bestD) {
      bestD = d;
      best = im;
    }
  }
  return best ? { power: best.power, faction: by, calldownId: best.id } : null;
}

/**
 * A per-consumer tracker: feed it every fx event in stream order (it keeps
 * the current tick's impacts) and it answers for each death. HQ ids are
 * remembered, so a strike that lands as its own HQ falls is still credited.
 */
export class CalldownCredit {
  private tick = -1;
  private impacts: Impact[] = [];
  private hqs: Partial<Record<Faction, number | null>> = {};

  constructor(private w: World) {
    this.hqId("blue");
    this.hqId("red");
  }

  private hqId(f: Faction): number | null {
    const known = this.hqs[f];
    if (known) return known;
    const id = hqOf(this.w, f)?.id ?? null;
    this.hqs[f] = id;
    return id;
  }

  /** Feed one event; for a calldown kill (a death) returns who did it with what. */
  see(ev: FxEvent): CalldownKill | null {
    if (this.w.tick !== this.tick) {
      this.tick = this.w.tick;
      this.impacts = [];
    }
    if (ev.type === "calldownImpact") {
      this.impacts.push(ev);
      return null;
    }
    if (ev.type !== "death" || this.impacts.length === 0) return null;
    return calldownKillOf(ev, this.impacts, (f) => this.hqId(f), (f) => hqOf(this.w, f) !== null);
  }

  /** One tick's events at once: death id → credit (empty when no calldown landed). */
  scan(fx: readonly FxEvent[]): Map<number, CalldownKill> {
    const out = new Map<number, CalldownKill>();
    for (const ev of fx) {
      const k = this.see(ev);
      if (k && ev.type === "death") out.set(ev.id, k);
    }
    return out;
  }
}
