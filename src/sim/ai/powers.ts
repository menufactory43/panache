import { BUILDINGS, POWER_SETS, POWERS, TICK_RATE, UNITS } from "../balance";
import { isVisible, knownBuildings } from "../fog";
import { canWalk } from "../goliath";
import { POWER_KINDS, calldownBlocker, isStunned, powerStatus } from "../powers";
import { nationOf } from "../rules";
import { isDefence, isWorker } from "./roles";
import type { BuildingKind, Calldown, Command, Faction, PowerKind, Unit, World } from "../types";
import { dist, domainOf, hqOf, moveClassOf, passable, regionAt } from "../world";
import type { AiMode, AiState, Difficulty } from "./commander";
import { seenEnemies } from "./intel";
import { cos, hypot, sin } from "../fmath";

/**
 * The commander's use of calldowns (powers.ts), and its reflex for getting
 * out from under the enemy's. Telegraphs are public, so the AI reads the
 * same `World.powers.active` list the player sees as reticles; it fires
 * through the same validated `calldown` command.
 */

/** Seconds before the AI notices a reticle and scatters (its reaction time). */
const REACTION: Record<Difficulty, number> = { easy: 1.1, normal: 0.6, hard: 0.4 };
/** How far (tiles) a unit runs from a reticle's centre direction. */
const DODGE_DIST = 4;
/** Visible ground clump worth barraging (scrap within the shell spread): rarer, bigger hits leave charge for EMPs and pods. */
const BARRAGE_MIN = 800;
const BARRAGE_SPREAD = 2.2;
/** Clump worth a Sky Hammer before the AI settles for buildings. */
const HAMMER_CLUMP = 700;
const HOME_RADIUS = 11;
/** Offensive EMPs only spend charge above this (keeps a Drop Pod's worth for defence). */
const OFFENCE_RESERVE = 80;

interface Memo {
  /** Enemy calldowns already reacted to. */
  seen: Set<number>;
  /** Unit id → tick until which it is busy dodging (keep other orders off it). */
  dodging: Map<number, number>;
  /**
   * A nation's power fired last pass, and its `fired` count then: if the
   * count hasn't moved since, the sim doesn't carry that power (yet), and it
   * is never asked for again (so a dud can't hold up the others).
   */
  probe?: { power: PowerKind; fired: number; tick: number };
  duds?: Set<PowerKind>;
  /** Tick of the last routine Ballon-sonde over the enemy HQ. */
  lastSonde?: number;
}

/** Per-commander reflex memory, kept beside (not inside) AiState. */
const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { seen: new Set(), dodging: new Map() };
    memos.set(s, m);
  }
  return m;
}

/** Last tick a calldown does damage (the final Barrage shell). */
const endTick = (c: Calldown) => (c.shells.length > 0 ? c.shells[c.shells.length - 1]!.tick : c.landTick);

/**
 * Per-tick dodge reflex (runs before the decision-interval gate): after a
 * difficulty-dependent reaction delay, every unit inside an enemy reticle
 * gets a move order ~4 tiles out from its centre, if there's still time.
 */
export function dodgeCalldowns(w: World, faction: Faction, s: AiState): Command[] {
  const active = w.powers.active;
  const m = memo(s);
  if (m.dodging.size > 0) for (const [id, until] of m.dodging) if (until <= w.tick) m.dodging.delete(id);
  if (active.length === 0) return [];
  const delay = Math.round(REACTION[s.difficulty] * TICK_RATE);
  const cmds: Command[] = [];
  const hq = hqOf(w, faction);
  for (const c of active) {
    if (c.faction === faction || m.seen.has(c.id) || w.tick - c.startTick < delay) continue;
    m.seen.add(c.id);
    const left = endTick(c) - w.tick;
    if (left < 3) continue; // too late to get anywhere
    const reach = c.radius + 0.7;
    for (const u of w.units.values()) {
      if (u.faction !== faction) continue;
      // (not a Goliath that can't walk off — a move packs a dug-in one up — nor a lift: a move to
      // one of its Condors would fly the Goliath off course)
      if (!canWalk(u) || u.order.type === "lift") continue;
      const d = hypot(u.x - c.x, u.y - c.y);
      if (d > reach) continue;
      // radially out; from dead centre, back toward home
      let dx = u.x - c.x;
      let dy = u.y - c.y;
      if (d < 0.3) {
        dx = (hq ? hq.tx + 1.5 : w.width / 2) - c.x;
        dy = (hq ? hq.ty + 1.5 : w.height / 2) - c.y;
      }
      const len = hypot(dx, dy) || 1;
      const { x, y } = dodgeSpot(w, u, dx / len, dy / len);
      cmds.push({ type: "move", faction, unitIds: [u.id], x, y });
      m.dodging.set(u.id, endTick(c) + 5);
    }
  }
  if (m.seen.size > 64) for (const id of [...m.seen].slice(0, 32)) m.seen.delete(id);
  return cmds;
}

/**
 * Where a unit runs to, DODGE_DIST along (ux, uy). On an island map a squad
 * on a small island would run into the sea (and stop at the shore, still
 * under the shells): it turns, a little at a time, until the spot is on
 * ground it can reach, or settles for a shorter run.
 */
function dodgeSpot(w: World, u: Unit, ux: number, uy: number): { x: number; y: number } {
  const at = (a: number, d: number) => {
    const c = cos(a);
    const s = sin(a);
    return {
      x: Math.min(w.width - 0.5, Math.max(0.5, u.x + (ux * c - uy * s) * d)),
      y: Math.min(w.height - 0.5, Math.max(0.5, u.y + (ux * s + uy * c) * d))
    };
  };
  const mc = moveClassOf(u.kind);
  const home = mc === "air" ? 0 : regionAt(w, Math.floor(u.x), Math.floor(u.y), mc);
  if (!w.rules?.islands || !home) return at(0, DODGE_DIST);
  for (const d of [DODGE_DIST, 3, 2])
    for (const a of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
      const p = at(a, d);
      if (regionAt(w, Math.floor(p.x), Math.floor(p.y), mc) === home) return p;
    }
  return at(0, DODGE_DIST);
}

/** Units currently running from a reticle: the decision pass leaves them be. */
export function dodgingUnits(w: World, s: AiState): number[] {
  const m = memos.get(s);
  if (!m) return [];
  return [...m.dodging].filter(([, until]) => until > w.tick).map(([id]) => id);
}

export interface CalldownContext {
  mode: AiMode;
  hqC: { x: number; y: number };
  guardPoint: { x: number; y: number };
  enemyHqPos: { x: number; y: number };
  army: Unit[];
  /** Visible armed intruders near our base or harvesters. */
  threats: { id: number; x: number; y: number }[];
  /** The units of a wave launched this pass, if any. */
  wave?: Unit[];
}

/** The nations' own powers: the ones a probe may find the sim doesn't carry yet. */
const NATION_ONLY: readonly PowerKind[] = ["sonde", "curie", "gaz", "pression"];
/** Seconds between routine Ballon-sonde looks at the enemy HQ (§1.7). */
const SONDE_EVERY = 90;
/** Own ground vehicles within the Pression's radius worth boosting (§1.7). */
const PRESSION_MIN = 4;
/** Known enemy defences within this many tiles of our column that call for the Gaz de houille (§1.7). */
const GAZ_DEFENCES = 2;
const GAZ_NEAR = 6;

interface Clump {
  x: number;
  y: number;
  value: number;
}

/**
 * Densest visible enemy clump: tries every visible unit (and the centroid
 * of its neighbours) as a centre and scores what lies within `radius`.
 */
function bestClump(
  units: Unit[],
  radius: number,
  weight: (u: Unit) => number
): Clump | null {
  let best: Clump | null = null;
  const score = (x: number, y: number) => {
    let v = 0;
    for (const o of units) if (hypot(o.x - x, o.y - y) <= radius) v += weight(o);
    return v;
  };
  for (const u of units) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const o of units)
      if (hypot(o.x - u.x, o.y - u.y) <= radius) {
        sx += o.x;
        sy += o.y;
        n++;
      }
    for (const [x, y] of [
      [u.x, u.y],
      [sx / n, sy / n]
    ] as [number, number][]) {
      const v = score(x, y);
      if (!best || v > best.value) best = { x, y, value: v };
    }
  }
  return best;
}

/** Nearest visible, open-ground tile to (x, y) — where a Drop Pod may land. */
function podSite(w: World, faction: Faction, x: number, y: number): { x: number; y: number } | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const s = faction === "red" ? -1 : 1; // scan in the side's own frame (mirror-fair ties)
  for (let r = 0; r <= 4; r++)
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const dy = i * s;
        const dx = j * s;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (!passable(w, tx, ty, "ground") || !isVisible(w, faction, tx, ty)) continue;
        // a little room around it, so the crew can step out
        let open = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (passable(w, tx + ox, ty + oy, "ground")) open++;
        if (open >= 6) return { x: tx + 0.5, y: ty + 0.5 };
      }
  return null;
}

const value = (us: Unit[]) => us.reduce((v, u) => v + UNITS[u.kind].cost, 0);
const PRODUCTION: BuildingKind[] = ["fab-plant", "airpad", "assembly-bay", "tech-lab", "gantry"];
/** A Sky Hammer's worth of a building it catches: production 1.5, a Gantry with a Goliath on the cradle (all that progress lost) 3. */
const hammerWorth = (w: World, kb: { id: number; kind: BuildingKind }): number =>
  kb.kind === "gantry" && w.buildings.get(kb.id)?.queue[0]?.kind === "goliath"
    ? 3
    : PRODUCTION.includes(kb.kind) ? 1.5 : kb.kind === "hq" ? 1.2 : 1;

/**
 * One decision pass's calldowns: at most one meter power, plus the Sky
 * Hammer when it is up. Defence first (EMP / Drop Pod against a superior
 * intrusion), then a Barrage on the best visible clump, then offence (EMP
 * the turrets in front of an assault, Drop Pod reinforcements to a wave).
 */
export function planCalldowns(w: World, faction: Faction, s: AiState, ctx: CalldownContext): Command[] {
  const cmds: Command[] = [];
  const nation = nationOf(w, faction);
  const m = memo(s);
  // (a nation's power the sim didn't take last pass is a dud: WP1's mechanics not in yet)
  if (m.probe && w.tick > m.probe.tick) {
    if (w.powers.fired[faction][m.probe.power] === m.probe.fired) (m.duds ??= new Set()).add(m.probe.power);
    m.probe = undefined;
  }
  const owned = (p: PowerKind) =>
    nation === "classique" ? POWER_KINDS.includes(p) : POWER_SETS[nation].includes(p) && !m.duds?.has(p);
  const fire = (power: PowerKind, x: number, y: number): boolean => {
    if (calldownBlocker(w, faction, power, x, y)) return false;
    cmds.push({ type: "calldown", faction, power, x, y });
    if (NATION_ONLY.includes(power)) m.probe = { power, fired: w.powers.fired[faction][power], tick: w.tick };
    return true;
  };
  const ready = (p: PowerKind) => owned(p) && powerStatus(w, faction, p).ready;
  const visibleEnemies = seenEnemies(w, faction); // (a Sniper Team hidden in the woods isn't aimed at)
  const armed = visibleEnemies.filter((u) => UNITS[u.kind].dps > 0 || UNITS[u.kind].heal);

  // --- Sky Hammer: a rich clump, else production, else the HQ -------------
  if (ready("hammer")) {
    const t = hammerTarget(w, faction, visibleEnemies);
    if (t) fire("hammer", t.x, t.y);
  }
  // (the Rayon Curie: the same rule, its own radius and a richer clump, §1.7)
  if (ready("curie")) {
    const t = hammerTarget(w, faction, visibleEnemies, POWERS.curie.radius, CURIE_CLUMP);
    if (t) fire("curie", t.x, t.y);
  }

  // --- defence: a superior force at the base or the mining line ----------
  const homeThreat = armed.filter(
    (u) => dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) <= HOME_RADIUS || dist(u.x, u.y, ctx.guardPoint.x, ctx.guardPoint.y) <= 6
  );
  const threatValue = value(homeThreat);
  if (threatValue >= 450) {
    const guard = value(
      ctx.army.filter(
        (u) => dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) <= HOME_RADIUS || dist(u.x, u.y, ctx.guardPoint.x, ctx.guardPoint.y) <= 6
      )
    );
    if (threatValue > guard * 1.25) {
      // reinforcements that stay beat a 4 s freeze: Drop Pod first, else EMP
      if (ready("droppod")) {
        // between the HQ and the intruders, inside our own vision
        const cx = homeThreat.reduce((a, u) => a + u.x, 0) / homeThreat.length;
        const cy = homeThreat.reduce((a, u) => a + u.y, 0) / homeThreat.length;
        const d = Math.max(1, dist(cx, cy, ctx.hqC.x, ctx.hqC.y));
        const k = Math.min(1, Math.max(0, (d - 3) / d));
        const site = podSite(w, faction, ctx.hqC.x + (cx - ctx.hqC.x) * k, ctx.hqC.y + (cy - ctx.hqC.y) * k);
        if (site && fire("droppod", site.x, site.y)) return cmds;
      }
      const clump = bestClump(homeThreat, POWERS.emp.radius - 0.4, (u) => UNITS[u.kind].cost);
      if (clump && clump.value >= 350 && ready("emp") && fire("emp", clump.x, clump.y)) return cmds;
    }
  }

  // --- Pression des chaudières: a wave of vehicles going in (Empire) ------
  if (ready("pression")) {
    const vehicles = (ctx.wave?.length ? ctx.wave : ctx.army).filter(
      (u) => UNITS[u.kind].domain === "ground" && !UNITS[u.kind].squad && !u.goliath && UNITS[u.kind].dps > 0
    );
    const clump = bestClump(vehicles, POWERS.pression.radius - 0.5, () => 1);
    // (with the wave launching, or a column already in a fight)
    const engaged = clump && armed.some((e) => hypot(e.x - clump.x, e.y - clump.y) <= 8);
    if (clump && clump.value >= PRESSION_MIN && (ctx.wave?.length || engaged) && fire("pression", clump.x, clump.y)) return cmds;
  }

  // --- Gaz de houille: our column walking into known defences (Empire) ---
  if (ready("gaz") && ctx.mode === "assault") {
    const defences = knownBuildings(w, faction).filter((kb) => isDefence(kb.kind));
    const column = ctx.army.filter((u) => UNITS[u.kind].domain === "ground" && dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) > HOME_RADIUS);
    const clump = bestClump(column, POWERS.gaz.radius - 0.5, (u) => UNITS[u.kind].cost);
    if (clump && clump.value >= 400) {
      const near = defences.filter((kb) => {
        const size = BUILDINGS[kb.kind].size;
        return dist(kb.tx + size / 2, kb.ty + size / 2, clump.x, clump.y) <= GAZ_NEAR;
      }).length;
      if (near >= GAZ_DEFENCES && fire("gaz", clump.x, clump.y)) return cmds;
    }
  }

  // --- Ballon-sonde (République): shot at from out of sight, else a routine look at the enemy HQ
  if (ready("sonde")) {
    const blind = blindFire(w, faction, armed, ctx.enemyHqPos);
    if (blind && fire("sonde", blind.x, blind.y)) return cmds;
    const every = SONDE_EVERY * TICK_RATE;
    if (
      w.tick - (m.lastSonde ?? 0) >= every &&
      w.powers.meter[faction] >= OFFENCE_RESERVE - 20 &&
      !isVisible(w, faction, Math.floor(ctx.enemyHqPos.x), Math.floor(ctx.enemyHqPos.y)) &&
      fire("sonde", ctx.enemyHqPos.x, ctx.enemyHqPos.y)
    ) {
      m.lastSonde = w.tick;
      return cmds;
    }
  }

  // --- Barrage: the best visible ground clump (Easy never shells) ---------
  if (s.difficulty !== "easy" && ready("barrage")) {
    const ground = visibleEnemies.filter((u) => domainOf(u) === "ground"); // (a Goliath on a lift is in the air)
    const clump = bestClump(ground, BARRAGE_SPREAD, (u) => UNITS[u.kind].cost * (isStunned(w, u.id) ? 1.5 : 1));
    if (clump && clump.value >= BARRAGE_MIN && fire("barrage", clump.x, clump.y)) return cmds;
  }

  // --- an enemy Goliath being mended: an EMP blocks its repair and freezes its Menders
  // (only from surplus charge, and with our units there to make the most of it)
  if (ready("emp") && w.powers.meter[faction] >= OFFENCE_RESERVE) {
    for (const e of visibleEnemies) {
      if (!e.goliath || isStunned(w, e.id)) continue;
      const menders = visibleEnemies.filter((o) => UNITS[o.kind].heal && hypot(o.x - e.x, o.y - e.y) <= 3).length;
      if (menders < 2 || value(ctx.army.filter((u) => dist(u.x, u.y, e.x, e.y) <= 9)) < 550) continue;
      if (fire("emp", e.x, e.y)) return cmds;
    }
  }

  // --- offence: knock out the defences in front of a wave -----------------
  // (only from surplus charge: offence must not starve the defensive powers)
  if (ctx.mode === "assault" && ready("emp") && w.powers.meter[faction] >= OFFENCE_RESERVE) {
    const defences = knownBuildings(w, faction).filter((kb) => isDefence(kb.kind));
    let best: { x: number; y: number; v: number } | null = null;
    for (const kb of defences) {
      const st = BUILDINGS[kb.kind];
      const x = kb.tx + st.size / 2;
      const y = kb.ty + st.size / 2;
      const near = value(ctx.army.filter((u) => dist(u.x, u.y, x, y) <= st.range + 2.5));
      if (near < 550) continue;
      // centre on the defence, nudged toward a neighbouring one if it's in reach
      const v = near + defences.filter((o) => dist(o.tx, o.ty, kb.tx, kb.ty) <= POWERS.emp.radius).length * 200;
      if (!best || v > best.v) best = { x, y, v };
    }
    if (best && fire("emp", best.x, best.y)) return cmds;
    // or freeze the army our wave is fighting
    const fighting = armed.filter((u) => ctx.army.some((a) => dist(a.x, a.y, u.x, u.y) <= 6));
    const clump = bestClump(fighting, POWERS.emp.radius - 0.4, (u) => UNITS[u.kind].cost);
    if (clump && clump.value >= 900 && fire("emp", clump.x, clump.y)) return cmds;
  }

  // --- Drop Pod reinforcements for a wave in a fight away from home -------
  if (ctx.mode === "assault" && ready("droppod")) {
    const front = ctx.army.filter(
      (u) =>
        UNITS[u.kind].domain === "ground" &&
        dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) > HOME_RADIUS &&
        armed.some((e) => dist(e.x, e.y, u.x, u.y) <= 6)
    );
    const cx = front.reduce((a, u) => a + u.x, 0) / Math.max(1, front.length);
    const cy = front.reduce((a, u) => a + u.y, 0) / Math.max(1, front.length);
    // only a fight that hangs in the balance: free units for a stomp just feed the snowball
    const opposed = value(armed.filter((e) => dist(e.x, e.y, cx, cy) <= 8));
    if (value(front) >= 600 && opposed >= value(front) * 0.9) {
      // a couple of tiles behind the front, toward home
      const d = Math.max(1, dist(cx, cy, ctx.hqC.x, ctx.hqC.y));
      const site = podSite(w, faction, cx + ((ctx.hqC.x - cx) / d) * 2, cy + ((ctx.hqC.y - cy) / d) * 2);
      if (site) fire("droppod", site.x, site.y);
    }
  }
  return cmds;
}

/** A Rayon Curie's clump: the Sky Hammer's rule, a richer one (§1.7: ≥ 800). */
const CURIE_CLUMP = 800;

/**
 * Where to look when we're being shot from out of sight (an enemy Mortar or
 * Canon beyond our vision): one of ours hurt in the last two seconds with no
 * armed enemy we can see that could reach it — 7 tiles from it toward the
 * enemy HQ. Null if none.
 */
function blindFire(w: World, faction: Faction, armed: Unit[], enemyHq: { x: number; y: number }): { x: number; y: number } | null {
  const recent = 2 * TICK_RATE;
  const hit = (x: number, y: number) => !armed.some((e) => hypot(e.x - x, e.y - y) <= UNITS[e.kind].range + 1);
  const at = (x: number, y: number) => {
    const d = Math.max(1, hypot(enemyHq.x - x, enemyHq.y - y));
    const k = Math.min(1, 7 / d);
    return { x: x + (enemyHq.x - x) * k, y: y + (enemyHq.y - y) * k };
  };
  for (const u of w.units.values())
    if (u.faction === faction && !isWorker(u.kind) && w.tick - u.damagedTick <= recent && u.damagedTick > 0 && hit(u.x, u.y)) return at(u.x, u.y);
  for (const b of w.buildings.values())
    if (b.faction === faction && w.tick - b.damagedTick <= recent && b.damagedTick > 0) {
      const c = { x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 };
      if (hit(c.x, c.y)) return at(c.x, c.y);
    }
  return null;
}

/** Sky Hammer aim: a visible clump worth ≥ 700, else the best production hit, else the HQ. */
function hammerTarget(
  w: World,
  faction: Faction,
  visibleEnemies: Unit[],
  R: number = POWERS.hammer.radius,
  minClump = HAMMER_CLUMP
): { x: number; y: number } | null {
  const clump = bestClump(visibleEnemies, R * 0.8, (u) => UNITS[u.kind].cost * (isStunned(w, u.id) ? 1.3 : 1));
  if (clump && clump.value >= minClump) return clump;
  const known = knownBuildings(w, faction);
  const centre = (kb: (typeof known)[number]) => ({
    x: kb.tx + BUILDINGS[kb.kind].size / 2,
    y: kb.ty + BUILDINGS[kb.kind].size / 2
  });
  // aim at a production building, shading toward neighbours the blast also catches
  let best: { x: number; y: number; v: number } | null = null;
  for (const kb of known) {
    if (!PRODUCTION.includes(kb.kind)) continue;
    const c = centre(kb);
    for (const o of [kb, ...known]) {
      const oc = centre(o);
      const x = (c.x + oc.x) / 2;
      const y = (c.y + oc.y) / 2;
      let v = 0;
      for (const k of known) {
        const size = BUILDINGS[k.kind].size;
        const dx = Math.max(k.tx - x, 0, x - (k.tx + size));
        const dy = Math.max(k.ty - y, 0, y - (k.ty + size));
        if (hypot(dx, dy) > R - 0.2) continue;
        v += hammerWorth(w, k);
      }
      // must still catch the production building we aimed for
      const size = BUILDINGS[kb.kind].size;
      const ddx = Math.max(kb.tx - x, 0, x - (kb.tx + size));
      const ddy = Math.max(kb.ty - y, 0, y - (kb.ty + size));
      if (hypot(ddx, ddy) > R - 0.2) continue;
      if (!best || v > best.v) best = { x, y, v };
    }
  }
  if (best) return best;
  const hq = known.find((kb) => kb.kind === "hq");
  return hq ? centre(hq) : null;
}
