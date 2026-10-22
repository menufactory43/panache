import { createAiState, tickAi, type Difficulty, type PersonalityName, type Strategy } from "../src/sim/ai/commander";
import { buildingFor } from "../src/sim/ai/roles";
import { BUILDINGS, ROLES, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, nearestReachableResource, unitBlocker } from "../src/sim/economy";
import { isVisible, knownBuildings } from "../src/sim/fog";
import { isInfantry } from "../src/sim/infantry";
import { createMapWorld } from "../src/sim/maps";
import { survivalStatus } from "../src/sim/modes/survival";
import { behaves, buildingCostFor, nationKind, parallelOf } from "../src/sim/nations";
import { opAiState, opById, type OpResult } from "../src/sim/ops";
import { nationOf } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { BuildingKind, Command, Unit, UnitKind, World } from "../src/sim/types";
import { buildingCenter, dist, hqOf } from "../src/sim/world";

/**
 * Stand-in players for the Ops tests and the tuning harness (tools/ops.ts):
 * a "pilot" issues blue's commands each tick. Shared by tests/ops.test.ts.
 * Pilots speak in kinds of the player's nation; a Classique kind they name
 * (`turret`, `harvester`) becomes the nation's own (Bobine, Fourgon).
 */
export type Pilot = (w: World) => Command[];
export type PilotFactory = (w: World, seed: number) => Pilot;

/** An AI commander flying the player's side. */
export const aiPilot =
  (strategy: PersonalityName, difficulty: Difficulty = "normal", tweak?: Partial<Strategy>): PilotFactory =>
  (_w, seed) => {
    const s = createAiState(strategy, difficulty, seed, tweak);
    return (w) => tickAi(w, "blue", s);
  };

/** Does nothing (the op must still set up and run without errors). */
export const idlePilot: PilotFactory = () => () => [];

export interface OpRun {
  world: World;
  result: OpResult | null;
  secs: number;
}

/** Play an op to its end (or `maxSecs`) with a pilot on blue and the op's own enemy on red. */
export function runOp(id: string, pilot: PilotFactory, seed = 1, maxSecs = 960): OpRun {
  const op = opById(id)!;
  const w = createMapWorld(op.map, { op: id, seed });
  const red = opAiState(op, seed * 7 + 3);
  const blue = pilot(w, seed);
  for (let i = 0; i < maxSecs * TICK_RATE && !w.winner; i++)
    step(w, [...blue(w), ...(red ? tickAi(w, "red", red) : [])]);
  return { world: w, result: w.ops?.result ?? null, secs: w.tick / TICK_RATE };
}

// ------------------------------------------------------- scripted pilots ---

type Pt = { x: number; y: number };
const centroid = (us: Unit[]): Pt => ({
  x: us.reduce((a, u) => a + u.x, 0) / Math.max(1, us.length),
  y: us.reduce((a, u) => a + u.y, 0) / Math.max(1, us.length)
});
const armyValue = (us: Unit[]) => us.reduce((v, u) => v + UNITS[u.kind].cost, 0);
/** How many of these units are vehicles (not robot infantry). */
const vehicles = (us: Unit[]) => us.filter((u) => !isInfantry(u.kind)).length;
const isWorker = (k: UnitKind) => behaves(k, "harvester");
/** The player's own kind for a Classique name (Classique: the same). */
const bKind = (w: World, k: BuildingKind): BuildingKind => buildingFor(nationOf(w, "blue"), k);
const uKind = (w: World, k: UnitKind): UnitKind => nationKind(w, "blue", k);
/** Ids a setup tagged. */
const tagged = (w: World, tag: string): number[] => w.ops?.tags[tag] ?? [];

/** Closest legal spot for a building to an anchor (what a player taps). */
function spotFor(w: World, kind: BuildingKind, anchor: Pt): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  let best: { tx: number; ty: number } | null = null;
  let bd = Infinity;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const d = Math.hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
      if (d < bd && canPlaceBuilding(w, "blue", kind, tx, ty)) {
        bd = d;
        best = { tx, ty };
      }
    }
  return best;
}

export interface ScriptCfg {
  /** Buildings to construct, in order (placed near `anchor` or the HQ). */
  build: BuildingKind[];
  /** Where each kind goes (default: toward the map centre from the HQ). */
  anchor?: (w: World, kind: BuildingKind) => Pt;
  harvesters: number;
  /** What a Fab Plant / Airpad / Assembly Bay should make next (null = nothing). */
  fab?: (w: World, army: Unit[]) => UnitKind | null;
  air?: (w: World, army: Unit[]) => UnitKind | null;
  bay?: (w: World, army: Unit[]) => UnitKind | null;
  /** Where the idle army waits. */
  hold: (w: World) => Pt;
  /** Launch an all-in attack once the army is worth this much (Infinity = never). */
  attackAt: number;
  /** Known enemy building kinds to hit first, in order, before the HQ. */
  targets?: BuildingKind[];
  /** Only buildings this close to the enemy HQ count as targets. */
  targetRadius?: number;
  /** The op's own objective, before the targets and the HQ: an entity to kill, or a place to sweep. */
  objective?: (w: World) => { id?: number; x: number; y: number } | null;
  /** Tagged units that never join the push (a hero to bring home). */
  keepHome?: string[];
  /** Only these kinds push (the rest guard the base); default: every armed unit. */
  pushKinds?: UnitKind[];
  /** Fall back and regroup when the push is down to this share of `attackAt` (default: never). */
  regroupAt?: number;
  /** Gather here before the push goes in (aircraft wait for the tanks). */
  gather?: (w: World) => Pt;
  /** Tagged units another pilot flies (never commanded, never counted). */
  exclude?: string[];
  /** Economy and production only: another pilot flies the army. */
  noArmy?: boolean;
}

/**
 * A scripted "decent phone player": one decision a second, a fixed build
 * list, factories kept busy, harvesters topped up, the army pulled onto
 * whatever attacks the base, and one all-in push at a set army value that
 * goes for the op's objective, then known defences, then the HQ. It sees only
 * what blue has seen.
 */
export const scriptPilot =
  (cfg: ScriptCfg): PilotFactory =>
  () => {
    let attacking = false;
    let gathered = false;
    return (w) => {
      if (w.tick % TICK_RATE !== 0) return [];
      const cmds: Command[] = [];
      const f = w.factions.blue;
      const hq = hqOf(w, "blue");
      if (!hq) return cmds;
      const hqC = buildingCenter(hq);
      const other = new Set((cfg.exclude ?? []).flatMap((t) => tagged(w, t)));
      const mine = [...w.units.values()].filter((u) => u.faction === "blue" && !other.has(u.id));
      const myB = [...w.buildings.values()].filter((b) => b.faction === "blue");
      const home = new Set((cfg.keepHome ?? []).flatMap((t) => tagged(w, t)));
      const forces = mine.filter((u) => !isWorker(u.kind) && !home.has(u.id));
      const army = forces.filter((u) => UNITS[u.kind].dps > 0);
      let scrap = f.scrap;
      // construction
      if (f.pending?.ready) {
        const k = f.pending.kind;
        const s = spotFor(w, k, cfg.anchor?.(w, k) ?? { x: hqC.x + (w.width / 2 - hqC.x) * 0.12, y: hqC.y + (w.height / 2 - hqC.y) * 0.12 });
        if (s) cmds.push({ type: "placeBuilding", faction: "blue", tx: s.tx, ty: s.ty });
        else cmds.push({ type: "cancelBuilding", faction: "blue" });
      } else if (!f.pending) {
        // the first building of the list we're short of (lost ones are rebuilt)
        const have = new Map<BuildingKind, number>();
        for (const b of myB) have.set(b.kind, (have.get(b.kind) ?? 0) + 1);
        const want = new Map<BuildingKind, number>();
        let next: BuildingKind | null = null;
        for (const k0 of cfg.build) {
          const k = bKind(w, k0);
          want.set(k, (want.get(k) ?? 0) + 1);
          if ((have.get(k) ?? 0) < want.get(k)!) {
            next = k;
            break;
          }
        }
        const req = next ? BUILDINGS[next].requires : undefined;
        const cost = next ? buildingCostFor(w, "blue", next) : Infinity;
        if (next && scrap >= cost && (!req || req.some((r) => myB.some((b) => b.kind === r)))) {
          cmds.push({ type: "startBuilding", faction: "blue", building: next });
          scrap -= cost;
        }
      }
      // economy
      const worker = ROLES[nationOf(w, "blue")].worker;
      const harv = mine.filter((u) => isWorker(u.kind) && !home.has(u.id));
      if (harv.length + hq.queue.length < cfg.harvesters && scrap >= UNITS[worker].cost && !unitBlocker(w, "blue", worker)) {
        cmds.push({ type: "produce", faction: "blue", buildingId: hq.id, unit: worker });
        scrap -= UNITS[worker].cost;
      }
      for (const h of harv)
        if (h.order.type === "idle") {
          const r = nearestReachableResource(w, h.x, h.y);
          if (r) cmds.push({ type: "harvest", faction: "blue", unitIds: [h.id], x: r.x + 0.5, y: r.y + 0.5 });
        }
      // production
      const hold = cfg.hold(w);
      const deep = parallelOf(w, "blue");
      for (const b of myB) {
        if (b.queue.length >= deep || b.unpowered) continue;
        const pick = b.kind === "fab-plant" ? cfg.fab : b.kind === "airpad" ? cfg.air : b.kind === "assembly-bay" ? cfg.bay : undefined;
        const want = pick?.(w, forces);
        const kind = want ? uKind(w, want) : null;
        if (!kind || unitBlocker(w, "blue", kind) || scrap < UNITS[kind].cost) continue;
        cmds.push({ type: "produce", faction: "blue", buildingId: b.id, unit: kind });
        scrap -= UNITS[kind].cost;
        if (!b.rally) cmds.push({ type: "rally", faction: "blue", buildingId: b.id, x: hold.x, y: hold.y });
      }
      // scouts sweep the enemy half
      const eGuess = { x: w.width - hqC.x, y: w.height - hqC.y };
      for (const sc of mine.filter((u) => behaves(u.kind, "scout") && u.order.type === "idle")) {
        const leg = Math.floor(w.tick / (20 * TICK_RATE)) % 3;
        const p = leg === 0 ? eGuess : leg === 1 ? { x: eGuess.x, y: hqC.y * 0.5 + eGuess.y * 0.5 } : { x: hqC.x * 0.5 + eGuess.x * 0.5, y: eGuess.y };
        cmds.push({ type: "move", faction: "blue", unitIds: [sc.id], x: p.x, y: p.y });
      }
      if (cfg.noArmy) return cmds;
      // defence: pull idle units onto visible attackers near our stuff
      const foes = [...w.units.values()].filter(
        (u) => u.faction === "red" && UNITS[u.kind].dps > 0 && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y))
      );
      const near = foes
        .map((u) => ({ u, d: Math.min(...myB.map((b) => dist(u.x, u.y, buildingCenter(b).x, buildingCenter(b).y)), ...harv.map((h) => dist(u.x, u.y, h.x, h.y) + 4)) }))
        .filter((e) => e.d < 12)
        .sort((a, b) => a.d - b.d);
      // the hero stays by the base
      const heroes = mine.filter((u) => home.has(u.id) && u.order.type === "idle" && dist(u.x, u.y, hold.x, hold.y) > 4);
      if (heroes.length) cmds.push({ type: "move", faction: "blue", unitIds: heroes.map((u) => u.id), x: hold.x, y: hold.y });
      // offence: an all-in push (and, with regroupAt, another once the army is rebuilt)
      const guards = cfg.pushKinds ? army.filter((u) => !cfg.pushKinds!.includes(u.kind)) : [];
      const pushers = cfg.pushKinds ? army.filter((u) => cfg.pushKinds!.includes(u.kind)) : army;
      if (!attacking && armyValue(pushers) >= cfg.attackAt) attacking = true;
      if (attacking && cfg.regroupAt !== undefined && armyValue(pushers) < cfg.attackAt * cfg.regroupAt) {
        attacking = false;
        if (pushers.length) cmds.push({ type: "move", faction: "blue", unitIds: pushers.map((u) => u.id), x: hold.x, y: hold.y });
      }
      if (attacking && guards.length) {
        const idle = guards.filter((u) => u.order.type === "idle" && u.autoTargetId === null);
        if (near[0] && idle.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: idle.map((u) => u.id), x: near[0].u.x, y: near[0].u.y });
        else if (!near[0]) {
          const strays = guards.filter((u) => u.order.type === "idle" && u.autoTargetId === null && dist(u.x, u.y, hold.x, hold.y) > 5);
          if (strays.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: strays.map((u) => u.id), x: hold.x, y: hold.y });
        }
      }
      const army0 = army;
      {
      const army = attacking ? pushers : army0;
      if (attacking && !gathered && cfg.gather) {
        const g = cfg.gather(w);
        const ready = army.filter((u) => dist(u.x, u.y, g.x, g.y) < 5).length >= army.length * 0.8;
        if (ready) gathered = true;
        else {
          const off = army.filter((u) => dist(u.x, u.y, g.x, g.y) >= 3 && (u.order.type !== "move" || dist(u.order.x, u.order.y, g.x, g.y) > 1));
          if (off.length) cmds.push({ type: "move", faction: "blue", unitIds: off.map((u) => u.id), x: g.x, y: g.y });
          return cmds;
        }
      }
      if (!attacking) gathered = false;
      if (attacking && army.length > 0) {
        const enemyHq = knownBuildings(w, "blue").find((b) => b.kind === "hq");
        const eHq = enemyHq ? { x: enemyHq.tx + 1.5, y: enemyHq.ty + 1.5 } : { x: w.width - hqC.x, y: w.height - hqC.y };
        let target: { id?: number; x: number; y: number } | null = cfg.objective?.(w) ?? null;
        for (const k of target ? [] : (cfg.targets ?? [])) {
          const c = knownBuildings(w, "blue")
            .filter((b) => b.kind === k && dist(b.tx, b.ty, eHq.x, eHq.y) < (cfg.targetRadius ?? 12))
            .sort((a, b) => dist(a.tx, a.ty, centroid(army).x, centroid(army).y) - dist(b.tx, b.ty, centroid(army).x, centroid(army).y))[0];
          if (c) {
            target = { id: c.id, x: c.tx + BUILDINGS[c.kind].size / 2, y: c.ty + BUILDINGS[c.kind].size / 2 };
            break;
          }
        }
        if (!target && enemyHq) target = { id: enemyHq.id, x: eHq.x, y: eHq.y };
        const seen = (id?: number) => id !== undefined && (w.buildings.has(id) || w.units.has(id)) && knownOrVisible(w, id);
        const busy = (u: Unit) => u.order.type === "attack" && u.order.targetId === target?.id && seen(target?.id);
        const free = army.filter((u) => !busy(u));
        if (free.length) {
          const hitsGround = free.filter((u) => UNITS[u.kind].targets !== "air");
          const escorts = free.filter((u) => UNITS[u.kind].targets === "air");
          if (target && seen(target.id) && hitsGround.length) cmds.push({ type: "attack", faction: "blue", unitIds: hitsGround.map((u) => u.id), targetId: target.id! });
          else if (hitsGround.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: hitsGround.map((u) => u.id), x: target?.x ?? eHq.x, y: target?.y ?? eHq.y });
          if (escorts.length) {
            const c = centroid(hitsGround.length ? hitsGround : escorts);
            cmds.push({ type: "attackMove", faction: "blue", unitIds: escorts.map((u) => u.id), x: target?.x ?? c.x, y: target?.y ?? c.y });
          }
        }
      } else if (near[0]) {
        const idle = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null);
        if (idle.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: idle.map((u) => u.id), x: near[0].u.x, y: near[0].u.y });
      } else {
        const strays = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null && dist(u.x, u.y, hold.x, hold.y) > 5);
        if (strays.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: strays.map((u) => u.id), x: hold.x, y: hold.y });
      }
      }
      return cmds;
    };
  };

/** Is an enemy entity known to blue (a building it has seen, a unit in sight)? */
function knownOrVisible(w: World, id: number): boolean {
  if (w.fog.blue.known.has(id)) return true;
  const u = w.units.get(id);
  return !!u && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y));
}

/**
 * Decapitation: micro a fixed strike group — gather short of the enemy base,
 * then fighters hunt aircraft and fly cover, ground units kill Flak first,
 * bombers take out anti-air sites and turrets, and everyone finishes the HQ.
 */
export const strikePilot: PilotFactory = () => {
  let gathered = false;
  return (w) => {
    if (w.tick % TICK_RATE !== 0) return [];
    const cmds: Command[] = [];
    const mine = [...w.units.values()].filter((u) => u.faction === "blue");
    if (!mine.length) return cmds;
    const hq = hqOf(w, "blue");
    const hqC = hq ? buildingCenter(hq) : centroid(mine);
    const known = knownBuildings(w, "blue");
    const eHqK = known.find((b) => b.kind === "hq");
    const eHq = eHqK ? { x: eHqK.tx + 1.5, y: eHqK.ty + 1.5 } : { x: w.width - hqC.x, y: w.height - hqC.y };
    const ids = (us: Unit[]) => us.map((u) => u.id);
    if (!gathered) {
      const len = Math.max(1, dist(hqC.x, hqC.y, eHq.x, eHq.y));
      const stage = { x: eHq.x + ((hqC.x - eHq.x) / len) * 13, y: eHq.y + ((hqC.y - eHq.y) / len) * 13 };
      const ready = mine.every((u) => dist(u.x, u.y, stage.x, stage.y) < 5) || w.tick > 70 * TICK_RATE;
      if (!ready) {
        if (w.tick % (5 * TICK_RATE) === 0) cmds.push({ type: "move", faction: "blue", unitIds: ids(mine), x: stage.x, y: stage.y });
        return cmds;
      }
      gathered = true;
    }
    const foes = [...w.units.values()].filter((u) => u.faction === "red" && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y)));
    const c = centroid(mine);
    const nearest = <T extends Pt>(xs: T[], p: Pt) => [...xs].sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y))[0];
    const bld = (...ks: BuildingKind[]) => known.filter((b) => ks.includes(b.kind)).map((b) => ({ id: b.id, x: b.tx + 0.5, y: b.ty + 0.5 }));
    const hqT = eHqK ? { id: eHqK.id, ...eHq } : null;
    const air = nearest(foes.filter((u) => UNITS[u.kind].domain === "air" && dist(u.x, u.y, c.x, c.y) < 12), c);
    const flak = nearest(foes.filter((u) => u.kind === "flak-crawler" || u.kind === "stinger"), c);
    const sam = nearest(bld("sam-site", "flak-battery"), c);
    const tur = nearest(bld("turret", "arsonval"), c);
    const fighters = mine.filter((u) => UNITS[u.kind].targets === "air");
    const ground = mine.filter((u) => UNITS[u.kind].domain === "ground");
    const bombers = mine.filter((u) => UNITS[u.kind].domain === "air" && UNITS[u.kind].targets !== "air" && UNITS[u.kind].dps > 0);
    const healers = mine.filter((u) => behaves(u.kind, "mender"));
    if (fighters.length)
      cmds.push(air ? { type: "attack", faction: "blue", unitIds: ids(fighters), targetId: air.id } : { type: "attackMove", faction: "blue", unitIds: ids(fighters), x: c.x, y: c.y });
    // (Rush the HQ once the first line is down: a hard commander rebuilds turrets faster than they fall)
    const gT = (flak && dist(flak.x, flak.y, c.x, c.y) < 6 ? flak : null) ?? (w.tick < 60 * TICK_RATE ? tur : null) ?? hqT ?? sam;
    if (ground.length && gT) cmds.push({ type: "attack", faction: "blue", unitIds: ids(ground), targetId: gT.id });
    else if (ground.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids(ground), x: eHq.x, y: eHq.y });
    const bT = sam ?? tur ?? hqT;
    if (bombers.length && bT) cmds.push({ type: "attack", faction: "blue", unitIds: ids(bombers), targetId: bT.id });
    else if (bombers.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids(bombers), x: eHq.x, y: eHq.y });
    if (healers.length) {
      const g = centroid(ground.length ? ground : mine);
      cmds.push({ type: "move", faction: "blue", unitIds: ids(healers), x: g.x, y: g.y });
    }
    return cmds;
  };
};

/** Last Stand ops: a defender that counters the announced wave and fights near the base. */
export const defenderPilot: PilotFactory = (w0) => {
  const hq = hqOf(w0, "blue")!;
  const hqC = buildingCenter(hq);
  const nation = nationOf(w0, "blue");
  return scriptPilot({
    build: ["turret", "tech-lab", "sam-site", "turret", "fab-plant", "turret", "sam-site", "turret"],
    harvesters: 4,
    hold: (w) => {
      const st = survivalStatus(w);
      if (!st?.site) return hqC;
      const len = Math.max(1, dist(hqC.x, hqC.y, st.site.x, st.site.y));
      return { x: hqC.x + ((st.site.x - hqC.x) / len) * 6, y: hqC.y + ((st.site.y - hqC.y) / len) * 6 };
    },
    fab: (w, army) => {
      const air = survivalStatus(w)?.nextTheme === "air";
      const aa = ROLES[nation].aa;
      if (air && army.filter((u) => u.kind === aa).length < 4) return aa;
      if (nation === "republique") return army.length % 3 === 0 && !unitBlocker(w, "blue", "branly") ? "branly" : !unitBlocker(w, "blue", "lancer") && army.length % 3 === 1 ? "lancer" : "jamais-contente";
      return army.length % 3 === 0 && !unitBlocker(w, "blue", "mastodon") ? "mastodon" : army.length % 3 === 1 && !unitBlocker(w, "blue", "lancer") ? "lancer" : "stinger";
    },
    air: (w) => (survivalStatus(w)?.nextTheme === "air" ? "raptor" : "wasp"),
    attackAt: Infinity
  })(w0, 0);
};

// ------------------------------------------------------- campaign pilots ---

/**
 * Le Col des Aigles: the escort sweeps the next leg of the pass while the
 * convoy waits at the last cleared one, and only rolls on once the leg has
 * stayed quiet for a few seconds (falling back if anything shoots at it).
 */
export const escortPilot =
  (route: Pt[], base?: ScriptCfg, minEscort = 10): PilotFactory =>
  (w0, seed) => {
    let leg = 0;
    let quiet = 0;
    const home = base ? scriptPilot({ ...base, exclude: ["convoi"], noArmy: true })(w0, seed) : null;
    return (w) => {
      const cmds: Command[] = home ? home(w) : [];
      if (w.tick % TICK_RATE !== 0) return cmds;
      const convoyIds = new Set(tagged(w, "convoi"));
      const convoy = [...convoyIds].map((id) => w.units.get(id)).filter((u): u is Unit => !!u);
      const escort = [...w.units.values()].filter(
        (u) => u.faction === "blue" && !convoyIds.has(u.id) && !isWorker(u.kind) && !UNITS[u.kind].squad && (UNITS[u.kind].dps > 0 || behaves(u.kind, "mender"))
      );
      const last = route.length - 1;
      const ahead = route[Math.min(leg + 1, last)]!;
      const ec = centroid(escort.length ? escort : convoy);
      const cc = centroid(convoy);
      const threats = [...w.units.values(), ...w.buildings.values()]
        .filter((e) => e.faction === "red" && ("tx" in e ? BUILDINGS[e.kind].dps > 0 : UNITS[e.kind].dps > 0))
        .map((e) => ({ id: e.id, p: "tx" in e ? buildingCenter(e) : { x: e.x, y: e.y } }))
        .filter((e) => isVisible(w, "blue", Math.floor(e.p.x), Math.floor(e.p.y)) && Math.min(dist(e.p.x, e.p.y, ec.x, ec.y), dist(e.p.x, e.p.y, cc.x, cc.y)) < 11)
        .sort((a, b) => dist(a.p.x, a.p.y, ec.x, ec.y) - dist(b.p.x, b.p.y, ec.x, ec.y));
      const fighters = escort.filter((u) => UNITS[u.kind].dps > 0);
      const guns = fighters.filter((u) => UNITS[u.kind].targets !== "air");
      const aa = fighters.filter((u) => UNITS[u.kind].targets === "air");
      const healers = escort.filter((u) => behaves(u.kind, "mender"));
      if (threats[0] && guns.length) cmds.push({ type: "attack", faction: "blue", unitIds: guns.map((u) => u.id), targetId: threats[0].id });
      else if (guns.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: guns.map((u) => u.id), x: ahead.x, y: ahead.y });
      if (aa.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: aa.map((u) => u.id), x: cc.x, y: cc.y });
      if (healers.length) cmds.push({ type: "move", faction: "blue", unitIds: healers.map((u) => u.id), x: ec.x, y: ec.y });
      // the next leg is clear once the escort has held it a few quiet seconds (and it waits for a real escort first)
      if (leg === 0 && fighters.length < minEscort && w.tick < 150 * TICK_RATE) {
        if (guns.length && !threats[0]) cmds.push({ type: "attackMove", faction: "blue", unitIds: guns.map((u) => u.id), x: route[0]!.x, y: route[0]!.y });
        return cmds;
      }
      const gc = centroid(guns.length ? guns : escort);
      quiet = threats.length === 0 && dist(gc.x, gc.y, ahead.x, ahead.y) < 3.5 ? quiet + 1 : 0;
      if (quiet >= 3 && leg < last) {
        leg++;
        quiet = 0;
      }
      // the convoy: to the last cleared leg, or back one if it's under fire
      const shot = threats.some((t) => dist(t.p.x, t.p.y, cc.x, cc.y) < 9);
      const goal = shot ? route[Math.max(0, leg - 1)]! : route[leg]!;
      if (convoy.length) cmds.push({ type: "move", faction: "blue", unitIds: convoy.map((u) => u.id), x: goal.x, y: goal.y });
      return cmds;
    };
  };

/** La Dame de fer: hold the Champ-de-Mars, everything (and the Zénith) on the Colosse when it comes. */
export const towerPilot: PilotFactory = (w0) => towerDefence(w0, (army) => (army.length % 3 === 2 ? "branly" : "lancer"));

function towerDefence(w0: World, fab: (army: Unit[]) => UnitKind): Pilot {
  const tower = w0.buildings.get(tagged(w0, "eiffel")[0]!)!;
  const t = buildingCenter(tower);
  const base = scriptPilot({
    build: ["fab-plant", "radar", "turret"],
    anchor: (_w, k) => (k === "turret" || k === "radar" ? { x: t.x + 2, y: t.y - 2 } : { x: 10, y: 46 }),
    harvesters: 5,
    fab: (_w, army) => fab(army),
    air: (_w, army) => (army.filter((u) => behaves(u.kind, "mender")).length < 3 ? "mender" : "wasp"),
    hold: () => ({ x: t.x + 1, y: t.y + 2 }),
    attackAt: Infinity
  })(w0, 0);
  return (w) => {
    const cmds = base(w);
    if (w.tick % TICK_RATE !== 0) return cmds;
    const colosse = tagged(w, "colosse").map((id) => w.units.get(id)).find((u): u is Unit => !!u);
    if (!colosse) return cmds;
    const army = [...w.units.values()].filter((u) => u.faction === "blue" && !isWorker(u.kind) && UNITS[u.kind].dps > 0 && UNITS[u.kind].targets !== "air");
    // once it's on our bank, everyone goes for it
    if (dist(colosse.x, colosse.y, t.x, t.y) < 16) {
      const free = army.filter((u) => !(u.order.type === "attack" && u.order.targetId === colosse.id));
      if (free.length) cmds.push({ type: "attack", faction: "blue", unitIds: free.map((u) => u.id), targetId: colosse.id });
    }
    return cmds;
  };
}

/**
 * La Dame de fer for ★★: the tower pilot, plus a raid on the Citadelle while
 * the parade still waits on the bridge road — the ground army (not Valmont)
 * crosses the southern ford, goes up the far bank, razes the Citadelle, then
 * comes home for the Colosse; the Zénith, the Éole and the Bobines hold the Tower.
 */
export const towerRaidPilot =
  (leave: number): PilotFactory =>
  (w0) => {
    const base = towerPilot(w0, 0);
    // (over the southern ford, then up the far bank, wide of the parade on the bridge road)
    const route: Pt[] = [{ x: 34, y: 42 }, { x: 46, y: 44 }, { x: 52, y: 36 }, { x: 54, y: 24 }, { x: 54, y: 14 }, { x: 52, y: 9 }];
    let leg = 0;
    let raiders: Set<number> | null = null;
    return (w) => {
      if (w.tick % TICK_RATE !== 0) return base(w);
      const eHq = hqOf(w, "red");
      if (!raiders && w.tick >= leave * TICK_RATE) {
        const hero = new Set(tagged(w, "valmont"));
        raiders = new Set(
          [...w.units.values()].filter((u) => u.faction === "blue" && !hero.has(u.id) && UNITS[u.kind].domain === "ground" && UNITS[u.kind].dps > 0 && !UNITS[u.kind].squad).map((u) => u.id)
        );
      }
      const out = !!raiders && !!eHq;
      const cmds: Command[] = [];
      for (const c of base(w)) {
        if ("unitIds" in c && out) {
          const ids = c.unitIds.filter((id) => !raiders!.has(id));
          if (ids.length) cmds.push({ ...c, unitIds: ids });
        } else cmds.push(c);
      }
      if (!out) return cmds;
      const group = [...raiders!].map((id) => w.units.get(id)).filter((u): u is Unit => !!u);
      if (!group.length) return cmds;
      const c = centroid(group);
      if (leg < route.length) {
        const p = route[leg]!;
        if (dist(c.x, c.y, p.x, p.y) < 3) leg++;
        else if (w.tick % (3 * TICK_RATE) === 0) cmds.push({ type: "move", faction: "blue", unitIds: group.map((u) => u.id), x: p.x, y: p.y });
        if (leg < route.length) return cmds;
      }
      // the Hotchkiss and the Batterie first if they're close, then the Citadelle
      const near = knownBuildings(w, "blue").filter((b) => (b.kind === "turret" || b.kind === "flak-battery") && w.buildings.has(b.id) && dist(b.tx + 0.5, b.ty + 0.5, c.x, c.y) < 6);
      const target = near[0]?.id ?? eHq!.id;
      const free = group.filter((u) => !(u.order.type === "attack" && u.order.targetId === target));
      if (free.length) cmds.push({ type: "attack", faction: "blue", unitIds: free.map((u) => u.id), targetId: target });
      return cmds;
    };
  };

/** The pilots each op is checked with (tests: at least one must complete it). */
export const PILOTS: Record<string, Record<string, PilotFactory>> = {
  // ---- the campaign
  bridgehead: {
    idle: idlePilot,
    holder: scriptPilot({
      build: ["fab-plant", "turret", "fab-plant", "turret"],
      anchor: (_w, k) => (k === "turret" ? { x: 24, y: 31 } : { x: 8, y: 46 }),
      harvesters: 3,
      fab: (_w, army) => (army.filter((u) => u.kind === "de-dion").length < 1 ? "de-dion" : "jamais-contente"),
      hold: () => ({ x: 23.5, y: 32.5 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  "harvest-moon": {
    idle: idlePilot,
    miner: scriptPilot({
      build: ["fab-plant", "airpad", "turret", "turret"],
      anchor: (_w, k) => (k === "turret" ? { x: 13, y: 41 } : { x: 8, y: 45 }),
      harvesters: 6,
      fab: (_w, army) => (army.filter((u) => u.kind === "de-dion").length < 4 ? "de-dion" : "jamais-contente"),
      air: () => "raptor",
      hold: () => ({ x: 11, y: 43 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  granit: {
    idle: idlePilot,
    raider: scriptPilot({
      build: ["airpad", "fab-plant", "airpad", "turret"],
      anchor: (_w, k) => (k === "fab-plant" ? { x: 18, y: 84 } : k === "turret" ? { x: 20, y: 86 } : { x: 19, y: 90 }),
      harvesters: 5,
      fab: (_w, army) => (army.filter((u) => u.kind === "de-dion").length < 4 ? "de-dion" : null),
      air: (_w, army) => (army.filter((u) => u.kind === "raptor").length * 2 < army.filter((u) => u.kind === "wasp").length ? "raptor" : "wasp"),
      hold: () => ({ x: 22, y: 84 }),
      attackAt: 1500,
      regroupAt: 0.35,
      pushKinds: ["wasp", "raptor"],
      keepHome: ["valmont"],
      // each balloon in turn: its anti-air first, then the balloon
      objective: (w) => {
        const army = [...w.units.values()].filter((u) => u.faction === "blue" && UNITS[u.kind].domain === "air" && UNITS[u.kind].dps > 0);
        const c = centroid(army);
        const b = tagged(w, "antenne")
          .filter((id) => w.buildings.has(id))
          .map((id) => w.buildings.get(id)!)
          .sort((a, b) => dist(a.tx, a.ty, c.x, c.y) - dist(b.tx, b.ty, c.x, c.y))[0];
        if (!b) return null;
        const guard = [...w.units.values(), ...w.buildings.values()]
          .filter((e) => e.faction === "red" && knownOrVisible(w, e.id) && ("tx" in e ? BUILDINGS[e.kind].targets === "air" : UNITS[e.kind].targets !== "ground" && UNITS[e.kind].dps > 0))
          .map((e) => ({ id: e.id, ...("tx" in e ? { x: e.tx + 0.5, y: e.ty + 0.5 } : { x: e.x, y: e.y }) }))
          .filter((e) => dist(e.x, e.y, b.tx, b.ty) < 7)[0];
        return guard ?? { id: b.id, x: b.tx + 0.5, y: b.ty + 0.5 };
      }
    }),
    balanced: aiPilot("balanced")
  },
  carbonie: {
    idle: idlePilot,
    gunner: scriptPilot({
      build: ["fab-plant", "assembly-bay"],
      harvesters: 4,
      fab: (_w, army) => (army.filter((u) => u.kind === "mortier-280").length < 4 ? "mortier-280" : army.length % 3 ? "stinger" : "flak-crawler"),
      bay: (_w, army) => (army.filter((u) => u.kind === "fusiliers").length < 4 ? "fusiliers" : null),
      hold: () => ({ x: 14, y: 50 }),
      attackAt: 2200,
      // the observatory first (from the Mortiers' range), then the Bobines
      objective: (w) => {
        const lab = tagged(w, "institut").find((id) => w.buildings.has(id) && w.fog.blue.known.has(id));
        const b = lab !== undefined ? w.buildings.get(lab)! : null;
        return b ? { id: b.id, x: b.tx + 1, y: b.ty + 1 } : null;
      },
      targets: ["radar", "arsonval", "tech-lab"],
      targetRadius: 30
    }),
    balanced: aiPilot("balanced")
  },
  "iron-tide": {
    idle: idlePilot,
    holder: scriptPilot({
      build: ["turret", "turret", "airpad", "turret"],
      anchor: () => ({ x: 12, y: 36 }),
      harvesters: 4,
      fab: (_w, army) => (army.length % 2 === 0 ? "lancer" : "jamais-contente"),
      air: () => "wasp",
      hold: () => ({ x: 12, y: 37 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  "frozen-assets": {
    idle: idlePilot,
    rusher: scriptPilot({
      build: [],
      harvesters: 0,
      fab: (_w, f) => (vehicles(f) % 3 === 0 ? "mastodon" : "stinger"),
      air: (_w, f) => (vehicles(f) % 2 === 0 ? "gyroptere" : "epervier"),
      hold: () => ({ x: 12, y: 36 }),
      attackAt: 2600,
      targets: ["arsonval"]
    }),
    // the briefing's play: one column — Creusot in front, Ateliers roulants behind — gathered short of
    // the République's base, Fourgons first (★★), then the Bobines and the GQG
    column: scriptPilot({
      build: [],
      harvesters: 0,
      fab: (_w, f) => {
        const n = (k: UnitKind) => f.filter((u) => u.kind === k).length;
        return n("mastodon") < 4 ? (n("atelier") * 2 < n("mastodon") ? "atelier" : "mastodon") : n("atelier") < 2 ? "atelier" : "stinger";
      },
      air: (_w, f) => (f.filter((u) => u.kind === "gyroptere").length < 2 ? "gyroptere" : null),
      hold: () => ({ x: 12, y: 36 }),
      attackAt: 2500,
      gather: () => ({ x: 30, y: 5 }),
      objective: (w) => {
        const army = [...w.units.values()].filter((u) => u.faction === "blue" && UNITS[u.kind].dps > 0);
        const c = centroid(army);
        const f = [...w.units.values()]
          .filter((u) => u.faction === "red" && behaves(u.kind, "harvester") && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y)) && dist(u.x, u.y, c.x, c.y) < 9)
          .sort((a, b) => dist(a.x, a.y, c.x, c.y) - dist(b.x, b.y, c.x, c.y))[0];
        return f ? { id: f.id, x: f.x, y: f.y } : null;
      },
      targets: ["arsonval"]
    }),
    rush: aiPilot("rush")
  },
  "col-des-aigles": {
    idle: idlePilot,
    escort: escortPilot(
      [
        { x: 8, y: 33 },
        { x: 9, y: 27 },
        { x: 8, y: 21 },
        { x: 8, y: 15 },
        { x: 10, y: 9 },
        { x: 8, y: 3 }
      ],
      {
        build: ["fab-plant", "turret", "turret", "airpad"],
        anchor: (_w, k) => (k === "turret" ? { x: 12, y: 36 } : { x: 6, y: 44 }),
        harvesters: 4,
        fab: (_w, army) => (army.length % 3 === 2 ? "de-dion" : "jamais-contente"),
        air: () => "raptor",
        hold: () => ({ x: 11, y: 38 }),
        attackAt: Infinity
      }
    )
  },
  "sky-pirates": {
    idle: idlePilot,
    raider: scriptPilot({
      build: ["airpad", "radar"],
      harvesters: 4,
      air: (_w, f) =>
        !f.some((u) => u.kind === "scout") ? "scout" : f.length % 4 === 1 ? "raptor" : f.length % 4 === 3 ? "wasp" : "hornet",
      hold: () => ({ x: 12, y: 50 }),
      attackAt: 2800,
      targets: ["flak-battery", "turret"]
    }),
    skyforce: aiPilot("skyforce")
  },
  "glass-jaw": {
    idle: idlePilot,
    general: scriptPilot({
      build: ["fab-plant", "turret", "fab-plant", "turret", "tech-lab", "airpad"],
      harvesters: 5,
      fab: (w, army) => (army.length % 4 === 3 ? "de-dion" : army.length % 4 === 1 && !unitBlocker(w, "blue", "lancer") ? "lancer" : "jamais-contente"),
      air: () => "wasp",
      hold: () => ({ x: 14, y: 42 }),
      attackAt: 3600,
      regroupAt: 0.3,
      pushKinds: ["jamais-contente", "lancer", "wasp", "de-dion"],
      targets: ["turret"]
    }),
    balanced: aiPilot("balanced")
  },
  decapitation: { idle: idlePilot, strike: strikePilot },
  "last-light": { idle: idlePilot, defender: defenderPilot },
  "dame-de-fer": { idle: idlePilot, tower: towerPilot, raid: towerRaidPilot(115) },
  // ---- the Trials (Classique)
  "bridgehead-classique": {
    idle: idlePilot,
    holder: scriptPilot({
      build: ["fab-plant", "turret", "fab-plant", "turret"],
      anchor: (_w, k) => (k === "turret" ? { x: 24, y: 31 } : { x: 8, y: 46 }),
      harvesters: 3,
      fab: (_w, army) => (army.filter((u) => u.kind === "flak-crawler").length < 1 ? "flak-crawler" : "stinger"),
      hold: () => ({ x: 23.5, y: 32.5 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  "harvest-moon-classique": {
    idle: idlePilot,
    miner: scriptPilot({
      build: ["fab-plant", "turret", "turret", "airpad"],
      anchor: (_w, k) => (k === "turret" ? { x: 13, y: 41 } : { x: 8, y: 45 }),
      harvesters: 6,
      fab: (_w, army) => (army.filter((u) => u.kind === "flak-crawler").length < 4 ? "flak-crawler" : "stinger"),
      air: () => "raptor",
      hold: () => ({ x: 11, y: 43 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  "decapitation-classique": { idle: idlePilot, strike: strikePilot, balanced: aiPilot("balanced") },
  "iron-tide-classique": {
    idle: idlePilot,
    holder: scriptPilot({
      build: ["turret", "turret", "airpad", "turret"],
      anchor: () => ({ x: 12, y: 36 }),
      harvesters: 4,
      fab: (_w, army) => (army.length % 2 === 0 ? "lancer" : "stinger"),
      air: () => "wasp",
      hold: () => ({ x: 12, y: 37 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced"),
    ironclad: aiPilot("ironclad")
  },
  "sky-pirates-classique": {
    idle: idlePilot,
    raider: scriptPilot({
      build: ["airpad", "turret"],
      harvesters: 4,
      air: (_w, f) =>
        !f.some((u) => u.kind === "scout") ? "scout" : f.length % 4 === 1 ? "raptor" : f.length % 4 === 3 ? "wasp" : "hornet",
      hold: () => ({ x: 12, y: 50 }),
      attackAt: 2800,
      targets: ["sam-site", "turret"]
    }),
    skyforce: aiPilot("skyforce"),
    balanced: aiPilot("balanced")
  },
  "frozen-assets-classique": {
    idle: idlePilot,
    rusher: scriptPilot({
      build: [],
      harvesters: 0,
      // the mix alternates by vehicles built so far (the starting Trooper Squad doesn't shift it)
      fab: (_w, f) => (vehicles(f) % 3 === 0 ? "mastodon" : "stinger"),
      air: (_w, f) => (vehicles(f) % 2 === 0 ? "hornet" : "raptor"),
      hold: () => ({ x: 12, y: 36 }),
      attackAt: 2600,
      targets: ["turret"]
    }),
    rush: aiPilot("rush"),
    balanced: aiPilot("balanced")
  },
  "glass-jaw-classique": {
    idle: idlePilot,
    general: scriptPilot({
      build: ["fab-plant", "turret", "airpad", "turret"],
      harvesters: 4,
      fab: (_w, army) => (army.length % 4 === 3 ? "flak-crawler" : "stinger"),
      air: () => "wasp",
      hold: () => ({ x: 14, y: 42 }),
      attackAt: 2400,
      targets: ["turret"]
    }),
    balanced: aiPilot("balanced")
  },
  "last-light-classique": { idle: idlePilot, defender: defenderPilot, balanced: aiPilot("balanced") }
};
