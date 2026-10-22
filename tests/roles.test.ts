import { describe, expect, it } from "vitest";
import { UNITS } from "../src/sim/balance";
import type { UnitKind } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";
import { ROLES, leadKind, roleGroups, roleOf } from "../src/game/roles";
import { Controller, setLocalSide } from "../src/game/controller";

describe("role groups", () => {
  it("sorts every kind into one role: squads, aircraft, the rest on the ground", () => {
    for (const k of Object.keys(UNITS) as UnitKind[]) {
      const r = roleOf(k);
      if (UNITS[k].domain === "air") expect(r).toBe("air");
      else if ((UNITS[k].squad ?? 0) > 0) expect(r).toBe("infantry");
      else expect(r).toBe("armour");
    }
    expect(roleOf("trooper")).toBe("infantry");
    expect(roleOf("mastodon")).toBe("armour");
    expect(roleOf("goliath")).toBe("armour");
    expect(roleOf("wasp")).toBe("air");
    expect(ROLES.map((r) => r.label)).toEqual(["Infanterie", "Blindés", "Aviation"]);
  });

  it("groups units by role and names each group's lead kind", () => {
    const w = createWorld(20, 20);
    const a = spawnUnit(w, "trooper", "blue", 2, 2);
    const b = spawnUnit(w, "stinger", "blue", 3, 2);
    const c = spawnUnit(w, "wasp", "blue", 4, 2);
    const d = spawnUnit(w, "stinger", "blue", 5, 2);
    const e = spawnUnit(w, "mastodon", "blue", 6, 2);
    expect(roleGroups([a, b, c, d, e])).toEqual({ infantry: [a.id], armour: [b.id, d.id, e.id], air: [c.id] });
    expect(leadKind([b, d, e])).toBe("stinger");
    // a tie goes to the pricier kind
    expect(leadKind([b, e])).toBe(UNITS.mastodon.cost > UNITS.stinger.cost ? "mastodon" : "stinger");
    expect(leadKind([])).toBeNull();
  });

  it("the Controller selects the whole army of a role, harvesters and Condors never", () => {
    setLocalSide("blue");
    const w = createWorld(30, 30);
    const t1 = spawnUnit(w, "trooper", "blue", 2, 2);
    const t2 = spawnUnit(w, "rocket-squad", "blue", 3, 2);
    spawnUnit(w, "harvester", "blue", 4, 2);
    spawnUnit(w, "condor", "blue", 5, 2);
    const s = spawnUnit(w, "stinger", "blue", 6, 2);
    const wasp = spawnUnit(w, "wasp", "blue", 7, 2);
    spawnUnit(w, "trooper", "red", 8, 2);
    const ctrl = new Controller(w);
    expect(ctrl.selectRole("infantry")).toBe(2);
    expect([...ctrl.selectedUnits].sort()).toEqual([t1.id, t2.id].sort());
    expect(ctrl.selectRole("armour")).toBe(1);
    expect([...ctrl.selectedUnits]).toEqual([s.id]);
    expect(ctrl.selectRole("air")).toBe(1);
    expect([...ctrl.selectedUnits]).toEqual([wasp.id]);
  });
});
