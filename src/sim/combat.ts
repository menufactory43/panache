import { shifting, skillRate, unitStats } from "./skills";
import { eclairKill } from "./modes/eclair";
import { BUILDINGS, COMBAT, DAMAGE_VS, INFANTRY, OBJECTIVES, TERRAIN, TICK_RATE, UNITS, shotDamage, type ArmedStats } from "./balance";
import { GOLIATH_WEAPONS, canRepair, canWalk, goliathReachAt, hasGoliath, repairUrgency, unplant, weaponReady, weaponStats } from "./goliath";
import { dropLifts } from "./lift";
import { concealedFrom, isInfantry, squadFirepower } from "./infantry";
import { IGNORE_TICKS, moveUnitToward } from "./movement";
import { buildingMaxHp, fireRateMult, isUnpowered, trenchCover, veiled } from "./nations";
import { isStunned } from "./powers";
import { leaveWreck, scatterGantry } from "./salvage";
import { bailOut, canBailOut } from "./transport";
import { Terrain, type ArmorClass, type Building, type Domain, type Faction, type TargetDomain, type Unit, type World } from "./types";
import { nationOf, rulesOf, sideDmg } from "./rules";
import { buildingCenter, canGetWithin, distToBuilding, domainOf, hqOf, moveClassOf, removeBuilding, terrainAt } from "./world";
import { atan2, hypot } from "./fmath";

type Attacker = { unit: Unit } | { building: Building };

export const canHit = (targets: TargetDomain, domain: Domain): boolean =>
  targets === "both" || targets === domain;

/** (A Goliath on a lift is an air target: world.ts domainOf.) */
function unitDomain(u: Unit): Domain {
  return domainOf(u);
}

interface TargetRef {
  id: number;
  x: number;
  y: number;
  dist: number;
}

/**
 * Best valid enemy (unit or building) within `radius` of (x, y): nearest,
 * with Menders preferred over everything (COMBAT.healerPriority), and armed
 * units over unarmed ones and buildings. A Sniper Team concealed from
 * `faction` in Woods (infantry.ts) is never picked.
 */
export function findTarget(
  w: World,
  faction: Faction,
  targets: TargetDomain,
  x: number,
  y: number,
  radius: number,
  minRange = 0,
  shooter?: Unit
): TargetRef | null {
  if (targets === "none") return null;
  let best: TargetRef | null = null;
  let bestScore = Infinity;
  const range = shooter ? UNITS[shooter.kind].range : Infinity;
  for (const u of w.units.values()) {
    if (u.faction === faction || !canHit(targets, unitDomain(u))) continue;
    const d = hypot(u.x - x, u.y - y);
    if (d > radius || d < minRange) continue;
    if (concealedFrom(w, faction, u)) continue;
    if (veiled(w, faction, u.x, u.y, d)) continue; // in an enemy gas cloud, too far to pick out (nations.ts)
    // out of range and out of reach (over the sea, on an island): not ours to chase
    if (shooter && d > range && (ignoring(w, shooter, u.id) || !engageable(w, shooter, u.id))) continue;
    const st = UNITS[u.kind];
    const s = d + (st.heal ? -COMBAT.healerPriority : st.targets === "none" ? 1.5 : 0);
    if (s < bestScore) {
      bestScore = s;
      best = { id: u.id, x: u.x, y: u.y, dist: d };
    }
  }
  // buildings are ground targets
  if (canHit(targets, "ground"))
    for (const b of w.buildings.values()) {
      if (b.faction === faction) continue;
      const d = distToBuilding(b, x, y);
      if (d > radius || d < minRange) continue;
      if (w.nation?.clouds.length) {
        const c = buildingCenter(b);
        if (veiled(w, faction, c.x, c.y, d)) continue;
      }
      const s = d + (BUILDINGS[b.kind].targets === "none" ? 3 : 1);
      if (s < bestScore) {
        bestScore = s;
        const c = buildingCenter(b);
        best = { id: b.id, x: c.x, y: c.y, dist: d };
      }
    }
  return best;
}

/**
 * Can unit `u` get within weapon range of target `id` at all? Aircraft always
 * can; a tank or squad can't reach a squad on an island, or a dropship
 * hovering out over the sea, so it must not lock onto one (it would sit at
 * the shore with a dead order, deaf to enemies landing next to it).
 */
export function engageable(w: World, u: Unit, id: number, range = UNITS[u.kind].range): boolean {
  const t = targetPosition(w, id);
  if (!t) return false;
  const b = w.buildings.get(id);
  if (b) return canGetWithin(w, moveClassOf(u.kind), u.x, u.y, t.x, t.y, range, (px, py) => distToBuilding(b, px, py), BUILDINGS[b.kind].size);
  return canGetWithin(w, moveClassOf(u.kind), u.x, u.y, t.x, t.y, range);
}

/** Is `u` leaving target `id` alone for now (it found it couldn't get in range: Unit.ignore)? */
const ignoring = (w: World, u: Unit, id: number): boolean => !!u.ignore && u.ignore.id === id && w.tick < u.ignore.until;

/**
 * An idle squad crewing an island relay its side holds (or is taking): it
 * holds its post and fires from there, never chasing out of the ring after a
 * target (a Scout hovering offshore would otherwise lure it off, and an empty
 * island relay pays nothing).
 */
function crewing(w: World, u: Unit): boolean {
  if (!isInfantry(u.kind)) return false;
  const r = OBJECTIVES.uplink.radius;
  for (const l of w.objectives.uplinks)
    if (l.infantryOnly && (l.owner === u.faction || l.pushing === u.faction) && hypot(u.x - l.x, u.y - l.y) <= r) return true;
  return false;
}

function targetPosition(w: World, id: number): { x: number; y: number; domain: Domain } | null {
  const u = w.units.get(id);
  if (u) return { x: u.x, y: u.y, domain: unitDomain(u) };
  const b = w.buildings.get(id);
  if (b) {
    const c = buildingCenter(b);
    return { x: c.x, y: c.y, domain: "ground" };
  }
  return null;
}

/** Distance from (x, y) to a target: footprint edge for buildings. */
function distTo(w: World, id: number, x: number, y: number): number {
  const b = w.buildings.get(id);
  if (b) return distToBuilding(b, x, y);
  const u = w.units.get(id);
  return u ? hypot(u.x - x, u.y - y) : Infinity;
}

/**
 * Armor + cover multiplier for a hit of `dmgType` on entity `id`. Woods give
 * ground units cover; robot infantry use it best (INFANTRY.woodsCover).
 */
function damageMult(w: World, id: number, dmgType: keyof typeof DAMAGE_VS): number {
  const u = w.units.get(id);
  let armor: ArmorClass = "structure";
  let cover = 1;
  if (u) {
    armor = UNITS[u.kind].armor;
    if (unitDomain(u) === "ground") {
      const t = terrainAt(w, Math.floor(u.x), Math.floor(u.y));
      cover = t === Terrain.Forest && isInfantry(u.kind) ? INFANTRY.woodsCover : TERRAIN[t].cover;
      if (u.entrenched) cover = trenchCover(w, u, cover); // Tranchées: the better cover, never both
    }
  }
  return DAMAGE_VS[dmgType][armor] * cover;
}

/** Record of who hit whom this tick, for retaliation. */
interface Incident {
  victimId: number;
  attackerId: number;
}

function applyDamage(
  w: World,
  id: number,
  damage: number,
  attackerId: number,
  incidents: Incident[]
): void {
  const u = w.units.get(id);
  if (u) {
    u.hp -= damage;
    u.damagedTick = w.tick;
    u.lastAttackerId = attackerId;
    incidents.push({ victimId: id, attackerId });
    w.fx.push({ type: "hit", faction: u.faction, id, x: u.x, y: u.y, building: false, attackerId });
    return;
  }
  const b = w.buildings.get(id);
  if (b) {
    b.hp -= damage;
    b.damagedTick = w.tick;
    b.lastAttackerId = attackerId;
    incidents.push({ victimId: id, attackerId });
    const c = buildingCenter(b);
    w.fx.push({ type: "hit", faction: b.faction, id, x: c.x, y: c.y, building: true, attackerId });
  }
}

/** Splash damage around a point to every enemy the weapon can hit. */
function splash(
  w: World,
  faction: Faction,
  x: number,
  y: number,
  radius: number,
  damage: number,
  dmgType: keyof typeof DAMAGE_VS,
  targets: TargetDomain,
  attackerId: number,
  incidents: Incident[]
): void {
  for (const u of w.units.values()) {
    if (u.faction === faction || !canHit(targets, unitDomain(u))) continue;
    const d = hypot(u.x - x, u.y - y);
    if (d > radius) continue;
    applyDamage(w, u.id, damage * (1 - 0.5 * (d / radius)) * damageMult(w, u.id, dmgType), attackerId, incidents);
  }
  if (canHit(targets, "ground"))
    for (const b of w.buildings.values()) {
      if (b.faction === faction) continue;
      const d = distToBuilding(b, x, y);
      if (d > radius) continue;
      applyDamage(w, b.id, damage * (1 - 0.5 * (d / radius)) * damageMult(w, b.id, dmgType), attackerId, incidents);
    }
}

/**
 * Splash damage from outside the weapon loop (commander calldowns): the same
 * falloff, armour and kill credit as a shell from `attackerId`. Returns how
 * many enemies it hit.
 */
export function areaBlast(
  w: World,
  faction: Faction,
  x: number,
  y: number,
  radius: number,
  damage: number,
  dmgType: keyof typeof DAMAGE_VS,
  targets: TargetDomain,
  attackerId: number
): number {
  const incidents: Incident[] = [];
  splash(w, faction, x, y, radius, damage, dmgType, targets, attackerId, incidents);
  retaliate(w, incidents);
  return incidents.length;
}

/** Raw damage to listed entities (the Sky Hammer), with the usual hit events and kill credit. */
export function strikeDamage(w: World, hits: { id: number; damage: number }[], attackerId: number): void {
  const incidents: Incident[] = [];
  for (const h of hits) applyDamage(w, h.id, h.damage, attackerId, incidents);
  retaliate(w, incidents);
}

/**
 * One weapon system of a multi-weapon unit (a Goliath's, goliath.ts): its
 * stats and its own clock. The shooter's torso is aimed by the caller.
 */
interface WeaponMount {
  stats: ArmedStats;
  state: { cooldown: number; firedTick: number };
}

function fire(w: World, attacker: Attacker, targetId: number, incidents: Incident[], mount?: WeaponMount): void {
  const isUnit = "unit" in attacker;
  const holder = isUnit ? attacker.unit : attacker.building;
  const clock = mount?.state ?? holder;
  if (clock.cooldown > 0) return;
  const stats: ArmedStats = mount?.stats ?? (isUnit ? unitStats(attacker.unit) : BUILDINGS[attacker.building.kind]);
  const src = isUnit ? { x: attacker.unit.x, y: attacker.unit.y } : buildingCenter(attacker.building);
  const t = targetPosition(w, targetId);
  if (!t) return;
  const interval = stats.shotInterval ?? COMBAT.shotInterval;
  // (Pression des chaudières: a boosted unit fires faster; so does a skill running, Baïonnette ! or the Barrage: skills.ts)
  const rate = isUnit ? fireRateMult(attacker.unit) * (attacker.unit.skill ? skillRate(w, attacker.unit, t.domain) : 1) : 1;
  clock.cooldown = Math.max(1, Math.round(rate === 1 ? interval * TICK_RATE : (interval * TICK_RATE) / rate));
  const angle = atan2(t.x - src.x, -(t.y - src.y));
  holder.firedTick = w.tick;
  clock.firedTick = w.tick;
  if (mount) {
    // (the caller turns a Goliath's torso)
  } else if (isUnit) {
    const u = attacker.unit;
    u.aim = angle;
    if (!UNITS[u.kind].turret) u.facing = angle;
  } else {
    attacker.building.facing = angle;
  }
  const rank = isUnit ? attacker.unit.rank : 0;
  // a squad hits as hard as the robots it still has standing (infantry.ts)
  const squad = isUnit ? squadFirepower(attacker.unit) : 1;
  const damage = shotDamage(stats) * (1 + rank * COMBAT.rankDamage) * rulesOf(w).dmgMult * sideDmg(w, isUnit ? attacker.unit.faction : attacker.building.faction) * squad;
  const dmgType = stats.dmgType ?? "kinetic";
  const fromAir = isUnit && unitDomain(attacker.unit) === "air";
  const vsAir = t.domain === "air" ? stats.airMult ?? 1 : 1;
  const fx = stats.fx ?? "cannon";
  w.fx.push({
    type: "shot", fx, x: src.x, y: src.y, tx: t.x, ty: t.y,
    fromAir, air: t.domain === "air", sourceId: holder.id
  });
  if (stats.projectileSpeed) {
    // slow simulated shell/bomb aimed at where the target is NOW (dodgeable)
    w.projectiles.push({
      id: w.nextId++, faction: holder.faction, fx,
      sx: src.x, sy: src.y, x: src.x, y: src.y, tx: t.x, ty: t.y,
      speed: stats.projectileSpeed / TICK_RATE,
      damage, splash: stats.splash ?? 0.6, dmgType, targets: stats.targets,
      sourceId: holder.id, fromAir
    });
    return;
  }
  if (stats.splash) {
    splash(w, holder.faction, t.x, t.y, stats.splash, damage, dmgType, stats.targets, holder.id, incidents);
    return;
  }
  applyDamage(w, targetId, damage * vsAir * damageMult(w, targetId, dmgType), holder.id, incidents);
}

/** Advance in-flight projectiles; detonate on arrival. */
function tickProjectiles(w: World, incidents: Incident[]): void {
  const keep = [];
  for (const p of w.projectiles) {
    const d = hypot(p.tx - p.x, p.ty - p.y);
    if (d > p.speed) {
      p.x += ((p.tx - p.x) / d) * p.speed;
      p.y += ((p.ty - p.y) / d) * p.speed;
      keep.push(p);
      continue;
    }
    splash(w, p.faction, p.tx, p.ty, p.splash, p.damage, p.dmgType, p.targets, p.sourceId, incidents);
    w.fx.push({ type: "explosion", x: p.tx, y: p.ty, size: p.splash, air: false, kind: "impact" });
  }
  w.projectiles = keep;
}

/** Menders: repair the most damaged friendly nearby. */
function tickHealer(w: World, u: Unit, engaged: Set<number>): void {
  const stats = UNITS[u.kind];
  const reach = stats.range + COMBAT.acquireBonus + (u.order.type === "idle" ? 2.5 : 0);
  let best: { id: number; x: number; y: number; d: number; unit: boolean } | null = null;
  let bestScore = Infinity;
  const groundOnly = stats.healTargets === "ground"; // (the Atelier roulant: no aircraft)
  // (a nation's menders never touch the fallen: a unit or building killed earlier this tick sits at ≤ 0 HP
  // until cleanupDeaths, and a repair there brought it back. Classique keeps its old order, bit for bit.)
  const spareDead = nationOf(w, u.faction) !== "classique";
  for (const o of w.units.values()) {
    if (o.faction !== u.faction || o.id === u.id || o.hp >= UNITS[o.kind].hp) continue;
    if (spareDead && o.hp <= 0) continue;
    if (groundOnly && unitDomain(o) === "air") continue;
    if (!canRepair(u.kind, o)) continue; // (the Zénith: Pasteur only, goliath.ts SUPER.zenith.repairedBy)
    if (o.goliath && isStunned(w, o.id)) continue; // an EMP blocks repair on a Goliath while it lasts
    const d = hypot(o.x - u.x, o.y - u.y);
    if (d > reach) continue;
    // (a Goliath with a weapon down, or about to come back, comes first)
    const s = d + (o.hp / UNITS[o.kind].hp) * 3 - (o.goliath ? repairUrgency(o) : 0);
    if (s < bestScore) {
      bestScore = s;
      best = { id: o.id, x: o.x, y: o.y, d, unit: true };
    }
  }
  for (const b of w.buildings.values()) {
    const max = buildingMaxHp(w, b);
    if (b.faction !== u.faction || b.hp >= max) continue;
    if (spareDead && b.hp <= 0) continue;
    const d = distToBuilding(b, u.x, u.y);
    if (d > reach) continue;
    const s = d + 2 + (b.hp / max) * 3;
    if (s < bestScore) {
      bestScore = s;
      const c = buildingCenter(b);
      best = { id: b.id, x: c.x, y: c.y, d, unit: false };
    }
  }
  if (!best) return;
  if (best.d > stats.range) {
    if (u.order.type === "idle") {
      moveUnitToward(w, u, best.x, best.y);
      engaged.add(u.id);
    }
    return;
  }
  engaged.add(u.id);
  u.aim = atan2(best.x - u.x, -(best.y - u.y));
  const amount = (stats.heal ?? 0) / TICK_RATE;
  if (best.unit) {
    const o = w.units.get(best.id)!;
    o.hp = Math.min(UNITS[o.kind].hp, o.hp + amount);
  } else {
    const b = w.buildings.get(best.id)!;
    b.hp = Math.min(buildingMaxHp(w, b), b.hp + amount);
  }
  if (w.tick % 5 === 0)
    w.fx.push({ type: "heal", x: u.x, y: u.y, tx: best.x, ty: best.y, sourceId: u.id, targetId: best.id });
}

/**
 * Combat pass. Returns the set of unit ids that should NOT move this tick
 * because they are engaging (in range of their target) or healing.
 */
export function tickCombat(w: World): Set<number> {
  const engaged = new Set<number>();
  const incidents: Incident[] = [];

  // Menders on the field this tick (rarely more than a handful): auto-targeting switches to one in range
  const healers: Unit[] = [];
  for (const u of w.units.values()) if (UNITS[u.kind].heal) healers.push(u);

  for (const u of w.units.values()) {
    if (u.cooldown > 0) u.cooldown--;
    if (u.goliath) for (const k of GOLIATH_WEAPONS) if (u.goliath.weapons[k].cooldown > 0) u.goliath.weapons[k].cooldown--;
    if (isStunned(w, u.id)) {
      engaged.add(u.id); // EMP'd (powers.ts): no firing, healing or moving
      continue;
    }
    // (a French 75 getting into battery or out of it doesn't fire; in it, it reaches further: skills.ts)
    if (shifting(u)) continue;
    const stats = unitStats(u);
    // (veterans patch themselves up; a Goliath only takes a Mender's repair)
    if (u.rank >= 3 && !u.goliath && u.hp < stats.hp && w.tick % TICK_RATE === 0)
      u.hp = Math.min(stats.hp, u.hp + stats.hp * COMBAT.eliteRegen);
    if (u.goliath) {
      if (goliathWeapons(w, u, healers, incidents)) engaged.add(u.id);
      continue;
    }
    if (stats.heal) {
      tickHealer(w, u, engaged);
      continue;
    }
    if (stats.targets === "none") continue;
    const minRange = stats.minRange ?? 0;

    let targetId: number | null = null;
    if (u.order.type === "attack") {
      const t = targetPosition(w, u.order.targetId);
      if (!t || !canHit(stats.targets, t.domain) || hidden(w, u.faction, u.order.targetId)) {
        u.order = { type: "idle" }; // gone, out of reach, or vanished into the woods
      } else if (distTo(w, u.order.targetId, u.x, u.y) > stats.range && !engageable(w, u, u.order.targetId)) {
        u.order = { type: "idle" }; // across the water from us: stand down and fight what we can reach
      } else {
        targetId = u.order.targetId;
      }
    }
    if (targetId === null) {
      // auto-acquire while idle or attack-moving
      const acquire = stats.range + COMBAT.acquireBonus;
      if (u.autoTargetId !== null) {
        const d = distTo(w, u.autoTargetId, u.x, u.y);
        if (d > acquire + 0.5 || d < minRange || hidden(w, u.faction, u.autoTargetId) || lostInGas(w, u.faction, u.autoTargetId, d))
          u.autoTargetId = null;
        else if (d > stats.range && !engageable(w, u, u.autoTargetId)) u.autoTargetId = null;
        else if (healers.length > 0) {
          const cur = w.units.get(u.autoTargetId);
          if (!cur || !UNITS[cur.kind].heal) u.autoTargetId = healerInRange(u, healers, stats.range, minRange) ?? u.autoTargetId;
        }
      }
      if (u.autoTargetId === null && (u.order.type === "idle" || u.order.type === "attackMove")) {
        const found = findTarget(w, u.faction, stats.targets, u.x, u.y, acquire, minRange, u);
        u.autoTargetId = found?.id ?? null;
      }
      targetId = u.autoTargetId;
    }
    if (targetId === null) continue;
    const d = distTo(w, targetId, u.x, u.y);
    if (d <= stats.range && d >= minRange) {
      engaged.add(u.id);
      fire(w, { unit: u }, targetId, incidents);
    } else if (u.order.type === "idle" && d > stats.range && targetId === u.autoTargetId) {
      // idle units close the last short gap to something in acquire range
      // (not a squad holding an island relay: it keeps its post)
      const t = targetPosition(w, targetId);
      if (t && !crewing(w, u) && moveUnitToward(w, u, t.x, t.y) && distTo(w, targetId, u.x, u.y) > stats.range) {
        // as close as the ground goes and still out of range: leave it, fight what we can reach
        u.ignore = { id: targetId, until: w.tick + IGNORE_TICKS };
        u.autoTargetId = null;
      }
      engaged.add(u.id);
    }
  }

  for (const b of w.buildings.values()) {
    if (b.cooldown > 0) b.cooldown--;
    if (isStunned(w, b.id) || isUnpowered(b)) continue; // EMP'd, or off the Réseau électrique: guns offline
    const stats = BUILDINGS[b.kind];
    if (stats.targets === "none") continue;
    const c = buildingCenter(b);
    const found = findTarget(w, b.faction, stats.targets, c.x, c.y, stats.range + BUILDINGS[b.kind].size / 2 - 0.5);
    if (found) fire(w, { building: b }, found.id, incidents);
  }

  tickProjectiles(w, incidents);
  retaliate(w, incidents);
  return engaged;
}

/**
 * A Goliath's weapon systems, each on its own clock (goliath.ts): every one
 * that is up shoots the Goliath's ordered target when it can reach it, else
 * keeps on what it was shooting while that stays in its reach (switching to
 * an enemy Mender that comes into it: kill the healer first), else takes the
 * best target in its own reach. It fires on the move. The torso turns to the
 * heaviest weapon's target. Returns true when it should hold its ground: an
 * attack order's target is under fire, or (attack-move) anything is.
 */
function goliathWeapons(w: World, u: Unit, healers: Unit[], incidents: Incident[]): boolean {
  const g = u.goliath!;
  let ordered: number | null = null;
  if (u.order.type === "attack") {
    const id = u.order.targetId;
    const t = targetPosition(w, id);
    // (the reach of the weapons it still has that can hit it: a Goliath's shrinks as they go)
    const reach = t ? goliathReachAt(u, t.domain) : 0;
    if (!t || hidden(w, u.faction, id) || reach === 0) {
      u.order = { type: "idle" }; // gone, out of reach, or vanished into the woods
    } else if (distTo(w, id, u.x, u.y) > reach && !engageable(w, u, id, reach)) {
      u.order = { type: "idle" }; // across the water from us
    } else ordered = id;
  }
  let holds = false;
  let aimAt: { x: number; y: number } | null = null;
  for (const k of GOLIATH_WEAPONS) {
    const ws = g.weapons[k];
    if (!weaponReady(u, k)) {
      ws.targetId = null;
      continue;
    }
    const st = weaponStats(u, k); // (the Zénith's own systems in the Goliath's slots)
    const minR = st.minRange ?? 0;
    const inReach = (id: number | null): id is number => {
      if (id === null) return false;
      const t = targetPosition(w, id);
      if (!t || !canHit(st.targets, t.domain) || hidden(w, u.faction, id)) return false;
      const d = distTo(w, id, u.x, u.y);
      return d <= st.range && d >= minR;
    };
    let tid: number | null = null;
    if (inReach(ordered)) tid = ordered;
    else {
      const keep = inReach(ws.targetId) ? ws.targetId : null;
      const cur = keep !== null ? w.units.get(keep) : undefined;
      if (keep !== null && (healers.length === 0 || (cur && UNITS[cur.kind].heal))) tid = keep;
      else {
        const found = findTarget(w, u.faction, st.targets, u.x, u.y, st.range, minR);
        const fu = found ? w.units.get(found.id) : undefined;
        // a Mender that came into reach takes over; otherwise keep what we had
        tid = keep !== null && !(fu && UNITS[fu.kind].heal) ? keep : found?.id ?? null;
      }
    }
    ws.targetId = tid;
    if (tid === null) continue;
    if (tid === ordered || u.order.type === "attackMove") holds = true;
    fire(w, { unit: u }, tid, incidents, { stats: st, state: ws });
    aimAt = targetPosition(w, tid);
  }
  if (aimAt) u.aim = atan2(aimAt.x - u.x, -(aimAt.y - u.y));
  return holds;
}

/** The nearest enemy Mender `u` can hit right now (within weapon range), if any. */
function healerInRange(u: Unit, healers: Unit[], range: number, minRange: number): number | null {
  const targets = UNITS[u.kind].targets;
  let best: number | null = null;
  let bestD = range;
  for (const h of healers) {
    if (h.faction === u.faction || !canHit(targets, unitDomain(h))) continue;
    const d = hypot(h.x - u.x, h.y - u.y);
    if (d <= bestD && d >= minRange) {
      bestD = d;
      best = h.id;
    }
  }
  return best;
}

/** Has target `id`, `d` tiles off, gone into an enemy Gaz de houille cloud, too far to keep track of (nations.ts)? */
function lostInGas(w: World, faction: Faction, id: number, d: number): boolean {
  if (!w.nation?.clouds.length) return false;
  const t = targetPosition(w, id);
  return !!t && veiled(w, faction, t.x, t.y, d);
}

/** Is unit `id` an enemy Sniper Team hidden from `faction` in Woods? (Buildings never are.) */
function hidden(w: World, faction: Faction, id: number): boolean {
  const u = w.units.get(id);
  return !!u && concealedFrom(w, faction, u);
}

/** Idle victims (and idle armed neighbours) turn on whoever shot them. */
function retaliate(w: World, incidents: Incident[]): void {
  const seen = new Set<number>();
  for (const { victimId, attackerId } of incidents) {
    if (seen.has(victimId)) continue;
    seen.add(victimId);
    const attacker = targetPosition(w, attackerId);
    if (!attacker) continue;
    const victim = w.units.get(victimId) ?? null;
    const vb = victim ? null : w.buildings.get(victimId) ?? null;
    const vx = victim ? victim.x : vb ? buildingCenter(vb).x : 0;
    const vy = victim ? victim.y : vb ? buildingCenter(vb).y : 0;
    const faction = victim?.faction ?? vb?.faction;
    for (const u of w.units.values()) {
      if (u.faction !== faction || u.order.type !== "idle") continue;
      if (u.goliath && !canWalk(u)) continue; // dug in (or on a lift): its guns answer on their own
      const stats = UNITS[u.kind];
      if (stats.targets === "none" || !canHit(stats.targets, attacker.domain)) continue;
      const self = u.id === victimId;
      if (!self && hypot(u.x - vx, u.y - vy) > COMBAT.assistRadius) continue;
      if (hypot(u.x - attacker.x, u.y - attacker.y) > COMBAT.retaliateRange) continue;
      // already busy with a target in range? keep shooting that instead
      if (u.autoTargetId !== null && distTo(w, u.autoTargetId, u.x, u.y) <= stats.range) continue;
      // a shooter across the water (shore artillery, a dropship's escort) can't be answered here
      if (hypot(u.x - attacker.x, u.y - attacker.y) > stats.range && !engageable(w, u, attackerId)) continue;
      u.order = { type: "attack", targetId: attackerId };
      u.path = null;
    }
  }
}

/** XP needed for each rank, as a multiple of the unit's own cost. */
function rankFor(u: Unit): number {
  const cost = UNITS[u.kind].cost;
  let r = 0;
  for (const k of COMBAT.rankXp) if (u.xp >= k * cost) r++;
  return r;
}

/**
 * Credit a kill. The faction stat always goes to the victim's enemy (every
 * source of damage is hostile), even when the killer has since died or is a
 * building; XP and the kill count go to the killing unit if it was alive this
 * tick (one that dies on the tick of its killing blow keeps the kill).
 */
function creditKill(w: World, victimFaction: Faction, killerId: number | null, victimCost: number, building: boolean): void {
  const enemy = victimFaction === "blue" ? "red" : "blue";
  if (w.eclair) eclairKill(w, victimFaction, victimCost); // (Éclair's points: modes/eclair.ts)
  const stats = w.factions[enemy].stats;
  if (building) stats.buildingsKilled++;
  else stats.unitsKilled++;
  if (killerId === null) return;
  const k = w.units.get(killerId);
  if (!k || k.faction === victimFaction) return;
  k.kills++;
  k.xp += victimCost;
  const r = rankFor(k);
  if (r > k.rank) {
    k.rank = r;
    if (k.hp > 0) w.fx.push({ type: "rankUp", id: k.id }); // (no fanfare for the fallen)
  }
}

/** Killer id/kind if the last attacker is still alive this tick. */
function killerOf(w: World, id: number | null): { killerId: number | null; killerKind: Unit["kind"] | null } {
  if (id === null) return { killerId: null, killerKind: null };
  const u = w.units.get(id);
  if (u) return { killerId: id, killerKind: u.kind };
  return w.buildings.has(id) ? { killerId: id, killerKind: null } : { killerId: null, killerKind: null };
}

/**
 * Remove dead entities, emit explosions, and settle the winner. Two passes:
 * every kill is credited while all of this tick's dead are still on the map
 * (so mutual kills credit both sides whatever the id order), then they go.
 *
 * A Condor shot down with squads aboard (transport.ts): over ground they
 * could stand on they bail out, hurt; otherwise they go down with it, each
 * a unit lost and killed with its own `death` event (the Condor's killer
 * gets the credit).
 *
 * A Goliath on a lift whose Condor fell drops first (lift.ts), so one the
 * fall destroys dies in this same pass. A side is beaten when its HQ falls
 * with no Goliath left, or its last Goliath falls with no HQ left.
 */
export function cleanupDeaths(w: World): void {
  dropLifts(w);
  const deadUnits: { u: Unit; killer: ReturnType<typeof killerOf> }[] = [];
  const deadBuildings: { b: Building; killer: ReturnType<typeof killerOf> }[] = [];
  /** Passengers lost with their Condor (over water or rock), and Condors whose squads bail out. */
  const lost: { u: Unit; carrier: Unit; killer: ReturnType<typeof killerOf> }[] = [];
  const bail: Unit[] = [];
  for (const u of w.units.values()) {
    if (u.hp > 0) continue;
    const killer = killerOf(w, u.lastAttackerId);
    deadUnits.push({ u, killer });
    creditKill(w, u.faction, u.lastAttackerId, UNITS[u.kind].cost, false);
    if (!u.passengers?.length) continue;
    if (canBailOut(w, u)) bail.push(u);
    else
      for (const p of u.passengers) {
        lost.push({ u: p, carrier: u, killer });
        creditKill(w, p.faction, u.lastAttackerId, UNITS[p.kind].cost, false);
      }
  }
  for (const b of w.buildings.values()) {
    if (b.hp > 0) continue;
    deadBuildings.push({ b, killer: killerOf(w, b.lastAttackerId) });
    creditKill(w, b.faction, b.lastAttackerId, BUILDINGS[b.kind].cost || 500, true);
  }
  for (const { u, killer } of deadUnits) {
    const id = u.id;
    w.units.delete(id);
    unplant(w, u); // (a dug-in Goliath's ground opens up)
    w.factions[u.faction].stats.unitsLost++;
    const air = unitDomain(u) === "air";
    w.fx.push({ type: "explosion", x: u.x, y: u.y, size: UNITS[u.kind].radius * 2, air, kind: "unit" });
    w.fx.push({
      type: "death", id, faction: u.faction, unitKind: u.kind, buildingKind: null,
      x: u.x, y: u.y, air, value: UNITS[u.kind].cost, ...killer, rank: u.rank, kills: u.kills,
      ...(u.free ? { free: true } : {})
    });
    leaveWreck(w, u); // combat units leave salvage (salvage.ts)
  }
  for (const c of bail) bailOut(w, c); // squads aboard jump clear
  for (const { u, carrier, killer } of lost) {
    w.factions[u.faction].stats.unitsLost++;
    w.fx.push({
      type: "death", id: u.id, faction: u.faction, unitKind: u.kind, buildingKind: null,
      x: carrier.x, y: carrier.y, air: true, value: UNITS[u.kind].cost, ...killer, rank: u.rank, kills: u.kills,
      ...(u.free ? { free: true } : {})
    });
  }
  for (const { carrier } of lost) carrier.passengers = [];
  for (const { b, killer } of deadBuildings) {
    if (b.kind === "gantry") scatterGantry(w, b); // a half-built Goliath strews scrap
    removeBuilding(w, b);
    w.factions[b.faction].stats.buildingsLost++;
    const value = BUILDINGS[b.kind].cost || 500;
    const c = buildingCenter(b);
    w.fx.push({ type: "explosion", x: c.x, y: c.y, size: BUILDINGS[b.kind].size, air: false, kind: "building" });
    w.fx.push({
      type: "death", id: b.id, faction: b.faction, unitKind: null, buildingKind: b.kind,
      x: c.x, y: c.y, air: false, value, ...killer, rank: 0, kills: 0
    });
    if (b.kind === "hq" && w.winner === null && !hasGoliath(w, b.faction))
      w.winner = b.faction === "blue" ? "red" : "blue";
  }
  // the last Goliath of a side whose HQ is already gone (not Last Stand's waves: they never had one)
  for (const { u } of deadUnits)
    if (u.goliath && w.winner === null && !hqOf(w, u.faction) && !hasGoliath(w, u.faction) && (!w.survival || u.faction === w.survival.defender))
      w.winner = u.faction === "blue" ? "red" : "blue";
}
