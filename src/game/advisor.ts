/**
 * Build advisor: the player-side twin of the AI's adaptive production.
 * Engine-free and tested; the badges are drawn by ../ui/command.ts.
 *
 * - EnemyIntel remembers which enemy units the player has actually SEEN
 *   (fog-respecting: only units standing on tiles the player sees right
 *   now, and never a Sniper Team hidden in the woods), forgetting each one
 *   a minute after its last sighting.
 * - counterAdvice turns that into "build this": a button glows with ⚔ when
 *   the kinds it counters have been seen at least twice (one Goliath is
 *   threat enough on its own) and the player's own force of that kind
 *   doesn't already match them.
 * - IdleWatch nudges when a factory has sat idle while the player could
 *   afford something from it.
 */
import { behaves } from "../sim/nations";
import { BUILDINGS, ROLES, UNITS } from "../sim/balance";
import { unitBlocker } from "../sim/economy";
import { unitSeenBy } from "../sim/infantry";
import { PLURALS } from "../sim/lexicon";
import { bannedBy } from "../sim/rules";
import type { BuildingKind, Faction, UnitKind, World } from "../sim/types";
import { tr } from "../lang";

export const ADVISOR = {
  /** A sighting is forgotten this long after the unit was last seen (sim s). */
  memoryS: 60,
  /** Rescan visible enemies this often (sim s). */
  scanS: 0.5,
  /** Distinct sightings needed before a counter lights up. */
  minSeen: 2,
  /**
   * A sighting of something this expensive counts as one more sighting per
   * this much scrap (a lone Goliath, ~1,600, counts twice: it lights its
   * counters on its own; nothing cheaper than this is weighted).
   */
  heavyValue: 800,
  /** A counter stays lit while your own force of it is worth less than this share of the threat. */
  coverShare: 0.75,
  /** A factory with an empty queue this long (sim s) earns an "idle" badge. */
  idleS: 6,
  /** A counter that just lit pulses this long (ms, wall clock), then stays steady. */
  freshMs: 6000
};

type Threat = UnitKind | "turret" | "sam-site";

/**
 * What each build option beats, from the cost-equal duel matrix
 * (`tools/balance.ts duels`) and the info cards. Scouts and harvesters are
 * left out on purpose: seeing them shouldn't make anything glow.
 */
export const COUNTERS: Partial<Record<UnitKind | BuildingKind, Threat[]>> = {
  stinger: ["flak-crawler", "mortar", "lancer", "trooper", "sniper"],
  "flak-crawler": ["wasp", "raptor", "hornet", "mender", "condor"],
  mortar: ["turret", "sam-site", "trooper", "rocket-squad", "sniper"],
  mastodon: ["stinger", "flak-crawler", "mortar"],
  lancer: ["mastodon", "goliath"],
  wasp: ["stinger", "mortar", "mastodon", "lancer", "goliath"],
  raptor: ["wasp", "hornet", "mender", "condor"],
  hornet: ["mastodon", "mortar", "trooper", "rocket-squad", "sniper", "goliath"],
  // robot infantry (INFANTRY.md): Troopers out-trade the anti-armour Rocket Squads,
  // Rocket Squads kill Mastodons and Hornets, Snipers delete other infantry;
  // the Goliath is tuned to fall to Rocket Squads, Wasps, Lancers and Hornets (GOLIATH.md)
  trooper: ["rocket-squad"],
  "rocket-squad": ["mastodon", "hornet", "goliath"],
  sniper: ["trooper", "rocket-squad", "sniper"],
  turret: ["trooper", "rocket-squad", "sniper"],
  "sam-site": ["hornet", "wasp", "condor"]
};

/** "Faucheux", "Batteries Ruggieri", "Escouades de pioupious" (sim/lexicon.ts). */
export const plural = (k: Threat): string => PLURALS[k];

const threatCost = (k: Threat): number => (k in UNITS ? UNITS[k as UnitKind].cost : BUILDINGS[k as BuildingKind].cost);

/** How many sightings one enemy of this kind is worth toward ADVISOR.minSeen (a Goliath: two). */
export const sightingWeight = (k: Threat): number => Math.max(1, Math.floor(threatCost(k) / ADVISOR.heavyValue));

/** Fog-respecting memory of the enemy units this faction has seen. */
export class EnemyIntel {
  /** kind → unit id → sim time last seen. */
  private seen = new Map<UnitKind, Map<number, number>>();
  private nextScan = 0;

  constructor(private w: World, private faction: Faction) {}

  /** Call every tick with the sim time; scans every ADVISOR.scanS. */
  update(t: number): void {
    if (t < this.nextScan) return;
    this.nextScan = t + ADVISOR.scanS;
    for (const u of this.w.units.values()) {
      if (u.faction === this.faction || behaves(u.kind, "harvester") || isScout(u.kind)) continue;
      if (!unitSeenBy(this.w, this.faction, u)) continue;
      let m = this.seen.get(u.kind);
      if (!m) this.seen.set(u.kind, (m = new Map()));
      m.set(u.id, t);
    }
    for (const m of this.seen.values())
      for (const [id, at] of m) if (t - at > ADVISOR.memoryS) m.delete(id);
  }

  /** Distinct enemies of `kind` seen within the memory window. */
  count(kind: Threat, t: number): number {
    if (kind === "turret" || kind === "sam-site") {
      // defences are remembered on the fog map until seen destroyed
      let n = 0;
      for (const kb of this.w.fog[this.faction].known.values()) if (kb.kind === kind) n++;
      return n;
    }
    let n = 0;
    for (const at of this.seen.get(kind)?.values() ?? []) if (t - at <= ADVISOR.memoryS) n++;
    return n;
  }
}

export interface Advice {
  /** The seen kinds this option beats, most numerous first. */
  threats: { kind: Threat; count: number }[];
  /** Glow the button: enough sightings and not already answered. */
  active: boolean;
}

/** Counter advice for one build option. */
export function counterAdvice(
  w: World,
  faction: Faction,
  intel: EnemyIntel,
  kind: UnitKind | BuildingKind,
  t: number
): Advice {
  // an option this match's rules ban (a mutator, an op) counters nothing: no ⚔, no card line
  if (bannedBy(w, kind, faction)) return { threats: [], active: false };
  const threats = (COUNTERS[kind] ?? [])
    .map((k) => ({ kind: k, count: intel.count(k, t) }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const seen = threats.reduce((s, x) => s + x.count * sightingWeight(x.kind), 0);
  if (seen < ADVISOR.minSeen) return { threats, active: false };
  const threat = threats.reduce((s, x) => s + x.count * threatCost(x.kind), 0);
  return { threats, active: ownValue(w, faction, kind) < threat * ADVISOR.coverShare };
}

/** Scrap value of what the faction already has (and has queued) of `kind`. */
function ownValue(w: World, faction: Faction, kind: UnitKind | BuildingKind): number {
  let n = 0;
  if (kind in UNITS) {
    // (squads riding in a Condor are off the field, but still ours; so are those a Goliath is training)
    for (const u of w.units.values())
      if (u.faction === faction) {
        if (u.kind === kind) n++;
        for (const p of u.passengers ?? []) if (p.kind === kind) n++;
        for (const q of u.goliath?.queue ?? []) if (q.kind === kind) n++;
      }
    for (const b of w.buildings.values())
      if (b.faction === faction) for (const q of b.queue) if (q.kind === kind) n++;
    return n * UNITS[kind as UnitKind].cost;
  }
  for (const b of w.buildings.values()) if (b.faction === faction && b.kind === kind) n++;
  if (w.factions[faction].pending?.kind === kind) n++;
  return n * BUILDINGS[kind as BuildingKind].cost;
}

/** "Counters Wasps (seen ×4), Hornets (×2)" for the info card, or null. */
export function adviceNote(a: Advice): string | null {
  if (a.threats.length === 0) return null;
  const [first, ...rest] = a.threats;
  return tr(
    `Contre : ${plural(first!.kind)} (vus ×${first!.count})${rest.map((x) => `, ${plural(x.kind)} (×${x.count})`).join("")}`,
    `Counters: ${plural(first!.kind)} (seen ×${first!.count})${rest.map((x) => `, ${plural(x.kind)} (×${x.count})`).join("")}`
  );
}

/** Factory → tab: which build-bar tab an idle factory nudges. */
export type FactoryTab = "ground" | "infantry" | "air";

/**
 * The build-bar tab of each factory. (No Gantry: it builds one Goliath at a
 * time and sits idle between them by design, so it never earns an "idle".)
 */
export const FACTORY_TAB: Partial<Record<BuildingKind, FactoryTab>> = { "fab-plant": "ground", "assembly-bay": "infantry", airpad: "air" };

/** Notices factories sitting idle while their cheapest unit is affordable. */
export class IdleWatch {
  private since = new Map<number, number>();

  constructor(private w: World, private faction: Faction) {}

  /** Which tabs should show "idle" at sim time t. */
  update(t: number): Record<FactoryTab, boolean> {
    const out: Record<FactoryTab, boolean> = { ground: false, infantry: false, air: false };
    const scrap = this.w.factions[this.faction].scrap;
    const alive = new Set<number>();
    for (const b of this.w.buildings.values()) {
      const tab = FACTORY_TAB[b.kind];
      if (b.faction !== this.faction || !tab) continue;
      alive.add(b.id);
      if (b.queue.length > 0) {
        this.since.delete(b.id);
        continue;
      }
      if (!this.since.has(b.id)) this.since.set(b.id, t);
      if (t - this.since.get(b.id)! < ADVISOR.idleS) continue;
      const cheapest = cheapestUnit(this.w, this.faction, b.kind);
      if (cheapest !== null && scrap >= cheapest) out[tab] = true;
    }
    for (const id of this.since.keys()) if (!alive.has(id)) this.since.delete(id);
    return out;
  }
}

/** A scout of any roster (the Patrie, the Empire's Estafette): unarmed, it says nothing of the enemy's army. */
const isScout = (k: UnitKind): boolean => k === ROLES.classique.scout || k === ROLES.republique.scout || k === ROLES.empire.scout;

/** Cost of the cheapest unit `factory` can build right now (combat units first; scouts only if nothing else). */
function cheapestUnit(w: World, faction: Faction, factory: BuildingKind): number | null {
  let best: number | null = null;
  for (const k of Object.keys(UNITS) as UnitKind[]) {
    const u = UNITS[k];
    if (u.builtAt !== factory || isScout(k) || unitBlocker(w, faction, k)) continue;
    if (best === null || u.cost < best) best = u.cost;
  }
  return best;
}
