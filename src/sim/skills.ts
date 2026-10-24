import { TICK_RATE, UNITS } from "./balance";
import { hypot } from "./fmath";
import type { Command, Domain, SkillId, SkillState, Unit, UnitKind, World } from "./types";
import { domainOf } from "./world";

/**
 * Unit skills (« compétences »), after StarCraft 2's, made for a finger: one
 * per kind of unit at most, on a cooldown (no energy), and one tap for the
 * whole selection (`skill` commands):
 *
 *   bayonet  « Baïonnette ! »       robot squads (Troopers and what fires
 *                                   like them): fire SKILLS.bayonet.rate×
 *                                   faster for a while, at a share of their
 *                                   health (the Marines' Stim);
 *   throttle « Plein gaz »          Panhards: faster for a while (the
 *                                   Medivac's boost);
 *   battery  « Mise en batterie »   French 75s: dig in, out-range everything
 *                                   (the Siege Tank's siege mode). On and off:
 *                                   a deploy and a pack-up each take
 *                                   SKILLS.battery.shiftS, unable to move or
 *                                   fire; deployed, it can't move, and any
 *                                   move order packs it up first, as an
 *                                   anchored Goliath does;
 *   snipe    « Tir de précision »   Alpine Chasseurs: one heavy shot at a
 *                                   ground unit (the Ghost's Snipe). A
 *                                   targeted skill: the command names the one
 *                                   squad that fires (the Controller picks the
 *                                   nearest ready one: SC2's smart cast); out
 *                                   of reach, it walks up and fires once there;
 *   charge   « Charge »             Creusots: a burst of speed at the nearest
 *                                   enemy, crushing squads on the way (the
 *                                   Zealots' Charge);
 *   barrage  « Barrage antiaérien » Faucheux: fire twice as fast at aircraft
 *                                   for a while (the Cyclone's barrage).
 *
 * A nation's unit takes the skill of the Classique unit it reuses
 * (UnitStats.base): Fusiliers fix bayonets, Carabiniers snipe.
 *
 * Old records never send a `skill`, so no unit of theirs ever has a
 * SkillState and their hashes stay what they were (checksum.ts folds skills
 * in only when one exists).
 */
export const SKILLS = {
  bayonet: { cooldownS: 20, lastS: 6, rate: 1.5, hpCost: 0.1 },
  throttle: { cooldownS: 18, lastS: 4, speed: 1.6 },
  battery: { shiftS: 2, range: 3, splash: 1.5 },
  snipe: { cooldownS: 25, range: 9, damage: 140 },
  charge: { cooldownS: 15, lastS: 1.5, reach: 6, speed: 3 },
  barrage: { cooldownS: 18, lastS: 5, rate: 2 }
} as const;

/** Each skill's unit, in Classique. */
const SKILL_OF: Partial<Record<UnitKind, SkillId>> = {
  trooper: "bayonet",
  stinger: "throttle",
  mortar: "battery",
  sniper: "snipe",
  mastodon: "charge",
  "flak-crawler": "barrage"
};

/** The skill a kind of unit has (its own, or its Classique model's), or null. */
export function skillOf(kind: UnitKind): SkillId | null {
  return SKILL_OF[kind] ?? (UNITS[kind].base ? SKILL_OF[UNITS[kind].base!] ?? null : null);
}

export const SKILL_IDS = ["bayonet", "throttle", "battery", "snipe", "charge", "barrage"] as const satisfies readonly SkillId[];

const s = (sec: number) => Math.round(sec * TICK_RATE);
const state = (u: Unit): SkillState => (u.skill ??= { ready: 0, until: 0, battery: "off", shift: 0, snipe: null });

/** Can `u` use its skill this tick (it has one, it's charged, and nothing holds it)? */
export function skillReady(w: World, u: Unit): boolean {
  const id = skillOf(u.kind);
  if (!id) return false;
  if (id === "battery") return !u.skill || u.skill.shift <= w.tick;
  return !u.skill || u.skill.ready <= w.tick;
}

/** Is `u`'s timed skill running now? */
export const skillActive = (w: World, u: Unit): boolean => !!u.skill && u.skill.until > w.tick;

type SkillCommand = Extract<Command, { type: "skill" }>;

/**
 * A `skill` command, for each of `c.unitIds` that is the commanding side's,
 * has that skill and can use it now. A battery tap deploys the named French
 * 75s, or packs them all up when every one of them is deployed already. A
 * snipe needs `targetId`.
 */
export function applySkillCommand(w: World, c: SkillCommand, lifting: ReadonlySet<number>): void {
  const units: Unit[] = [];
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (u && u.faction === c.faction && !lifting.has(id) && skillOf(u.kind) === c.skill) units.push(u);
  }
  if (!units.length) return;
  const now = w.tick;
  if (c.skill === "battery") {
    const ready = units.filter((u) => skillReady(w, u));
    const allOn = ready.length > 0 && ready.every((u) => u.skill?.battery === "on");
    for (const u of ready) {
      const st = state(u);
      if (allOn) {
        st.battery = "packing";
        st.shift = now + s(SKILLS.battery.shiftS);
      } else if (st.battery === "off") {
        st.battery = "deploying";
        st.shift = now + s(SKILLS.battery.shiftS);
        u.order = { type: "idle" };
        u.path = null;
      } else continue;
      w.fx.push({ type: "skill", id: u.id, skill: "battery" });
    }
    return;
  }
  for (const u of units) {
    if (!skillReady(w, u)) continue;
    const st = state(u);
    switch (c.skill) {
      case "bayonet": {
        st.until = now + s(SKILLS.bayonet.lastS);
        st.ready = now + s(SKILLS.bayonet.cooldownS);
        u.hp = Math.max(1, u.hp - UNITS[u.kind].hp * SKILLS.bayonet.hpCost);
        break;
      }
      case "throttle":
      case "barrage": {
        const k = SKILLS[c.skill];
        st.until = now + s(k.lastS);
        st.ready = now + s(k.cooldownS);
        break;
      }
      case "charge": {
        const t = nearestEnemy(w, u, SKILLS.charge.reach);
        if (!t) continue; // (nothing to charge: the skill stays charged)
        st.until = now + s(SKILLS.charge.lastS);
        st.ready = now + s(SKILLS.charge.cooldownS);
        u.order = { type: "attack", targetId: t.id };
        u.path = null;
        break;
      }
      case "snipe": {
        const t = c.targetId === undefined ? undefined : w.units.get(c.targetId);
        if (!t || t.faction === u.faction || domainOf(t) !== "ground") continue;
        st.snipe = t.id;
        // out of reach: walk up to it (tickSkills fires once there)
        if (hypot(t.x - u.x, t.y - u.y) > SKILLS.snipe.range) {
          u.order = { type: "attack", targetId: t.id };
          u.path = null;
        }
        continue; // (the fx and the cooldown come with the shot)
      }
    }
    w.fx.push({ type: "skill", id: u.id, skill: c.skill });
  }
}

/** The nearest enemy ground unit within `reach` of `u` (ties: the lower id). */
function nearestEnemy(w: World, u: Unit, reach: number): Unit | null {
  let best: Unit | null = null;
  let bestD = reach;
  for (const o of w.units.values()) {
    if (o.faction === u.faction || domainOf(o) !== "ground") continue;
    const d = hypot(o.x - u.x, o.y - u.y);
    if (d < bestD || (d === bestD && best && o.id < best.id)) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

/**
 * Once a tick, before combat (sim.ts step): batteries finish deploying or
 * packing up, and a pending snipe in reach fires. Returns the damage to deal
 * (combat.ts applies it, with its kill credit).
 */
export function tickSkills(w: World): { attackerId: number; targetId: number; damage: number }[] {
  const shots: { attackerId: number; targetId: number; damage: number }[] = [];
  for (const u of w.units.values()) {
    const st = u.skill;
    if (!st) continue;
    if (st.battery === "deploying" && st.shift <= w.tick) st.battery = "on";
    if (st.battery === "packing" && st.shift <= w.tick) st.battery = "off";
    if (st.snipe !== null) {
      const t = w.units.get(st.snipe);
      if (!t) {
        st.snipe = null;
        continue;
      }
      if (hypot(t.x - u.x, t.y - u.y) > SKILLS.snipe.range) continue;
      shots.push({ attackerId: u.id, targetId: t.id, damage: SKILLS.snipe.damage });
      st.snipe = null;
      st.ready = w.tick + s(SKILLS.snipe.cooldownS);
      u.cooldown = Math.max(u.cooldown, s(UNITS[u.kind].shotInterval ?? 1));
      u.firedTick = w.tick;
      if (u.order.type === "attack" && u.order.targetId === t.id) u.order = { type: "idle" };
      w.fx.push({ type: "skill", id: u.id, skill: "snipe" });
      w.fx.push({ type: "shot", fx: "snipe", x: u.x, y: u.y, tx: t.x, ty: t.y, fromAir: false, air: false, sourceId: u.id });
    }
  }
  return shots;
}

/** Fire-rate multiplier from a running skill, against a target in `domain`. */
export function skillRate(w: World, u: Unit, domain: Domain): number {
  const st = u.skill;
  if (!st || st.until <= w.tick) return 1;
  const id = skillOf(u.kind);
  if (id === "bayonet") return SKILLS.bayonet.rate;
  if (id === "barrage" && domain === "air") return SKILLS.barrage.rate;
  return 1;
}

/** Speed multiplier from a running skill. */
export function skillSpeed(w: World, u: Unit): number {
  const st = u.skill;
  if (!st || st.until <= w.tick) return 1;
  const id = skillOf(u.kind);
  if (id === "throttle") return SKILLS.throttle.speed;
  if (id === "charge") return SKILLS.charge.speed;
  return 1;
}

/** A French 75 in battery (or getting in or out of it): it stays where it is. */
export const rooted = (u: Unit): boolean => !!u.skill && u.skill.battery !== "off";
/** In battery and ready: the longer reach. Deploying or packing up: it doesn't fire. */
export const inBattery = (u: Unit): boolean => u.skill?.battery === "on";
export const shifting = (u: Unit): boolean => u.skill?.battery === "deploying" || u.skill?.battery === "packing";

/**
 * A move order for `u` (sim.ts applyCommand): a deployed battery packs up
 * first, and its order waits until it has (tickMovement leaves rooted units
 * alone).
 */
export function orderedToMoveSkill(w: World, u: Unit): void {
  const st = u.skill;
  if (!st || st.battery === "off" || st.battery === "packing") return;
  st.battery = "packing";
  st.shift = w.tick + s(SKILLS.battery.shiftS);
  w.fx.push({ type: "skill", id: u.id, skill: "battery" });
}

const BATTERY_STATS = new Map<UnitKind, (typeof UNITS)[UnitKind]>();
/** A unit's weapon as it fires now: a French 75 in battery reaches further, its shells spread wider. */
export function unitStats(u: Unit): (typeof UNITS)[UnitKind] {
  const base = UNITS[u.kind];
  if (!inBattery(u)) return base;
  let st = BATTERY_STATS.get(u.kind);
  if (!st) {
    st = { ...base, range: base.range + SKILLS.battery.range, ...(base.splash ? { splash: base.splash * SKILLS.battery.splash } : {}) };
    BATTERY_STATS.set(u.kind, st);
  }
  return st;
}
