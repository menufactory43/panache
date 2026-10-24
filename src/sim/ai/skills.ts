import { UNITS } from "../balance";
import { hypot } from "../fmath";
import { SKILLS, skillOf, skillReady } from "../skills";
import type { Command, Faction, SkillId, Unit, World } from "../types";
import { domainOf } from "../world";

/**
 * The commander's use of unit skills (sim/skills.ts), each decision pass,
 * from what its side sees (`seen`):
 *
 *   - Baïonnette !: squads with an enemy on the ground in reach, over half their health;
 *   - Plein gaz: Panhards on the attack with an enemy within a few tiles;
 *   - Mise en batterie: idle French 75s with an enemy within the battery's
 *     reach and none inside their minimum range (moving them packs them up);
 *   - Tir de précision: each ready squad at the dearest enemy ground unit in
 *     its reach (a Goliath shrugs it off: not one);
 *   - Charge: Creusots with enemy squads within reach;
 *   - Barrage antiaérien: Faucheux with aircraft in range.
 */
export function planSkills(w: World, faction: Faction, army: readonly Unit[], seen: readonly Unit[]): Command[] {
  const groups = new Map<SkillId, number[]>();
  const add = (id: SkillId, u: Unit) => {
    const g = groups.get(id) ?? [];
    g.push(u.id);
    groups.set(id, g);
  };
  const cmds: Command[] = [];
  const within = (u: Unit, r: number, test: (e: Unit) => boolean) => seen.some((e) => test(e) && hypot(e.x - u.x, e.y - u.y) <= r);
  const ground = (e: Unit) => domainOf(e) === "ground";
  for (const u of army) {
    const id = skillOf(u.kind);
    if (!id || !skillReady(w, u)) continue;
    const st = UNITS[u.kind];
    switch (id) {
      case "bayonet":
        if (u.hp > st.hp * 0.5 && within(u, st.range + 1, ground)) add(id, u);
        break;
      case "throttle":
        if ((u.order.type === "attack" || u.order.type === "attackMove") && within(u, st.range + 3, ground)) add(id, u);
        break;
      case "battery":
        if (u.skill?.battery !== "on" && u.order.type === "idle" && within(u, st.range + SKILLS.battery.range, ground) && !within(u, (st.minRange ?? 0) + 1, ground))
          add(id, u);
        break;
      case "snipe": {
        let best: Unit | null = null;
        for (const e of seen) {
          if (!ground(e) || e.goliath || hypot(e.x - u.x, e.y - u.y) > SKILLS.snipe.range) continue;
          if (!best || UNITS[e.kind].cost > UNITS[best.kind].cost || (UNITS[e.kind].cost === UNITS[best.kind].cost && e.id < best.id)) best = e;
        }
        if (best) cmds.push({ type: "skill", faction, unitIds: [u.id], skill: "snipe", targetId: best.id });
        break;
      }
      case "charge":
        if (within(u, SKILLS.charge.reach, (e) => ground(e) && !!UNITS[e.kind].squad)) add(id, u);
        break;
      case "barrage":
        if (within(u, st.range, (e) => domainOf(e) === "air")) add(id, u);
        break;
    }
  }
  for (const [skill, unitIds] of groups) cmds.push({ type: "skill", faction, unitIds, skill });
  return cmds;
}
