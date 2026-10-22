import { describe, expect, it } from "vitest";
import { ROSTERS } from "../src/sim/balance";
import { buildingCard, buildingGroups, card, rosterOf, unitGroups } from "../src/unit-info";
import type { BuildingKind, Nation } from "../src/sim/types";

const NATIONS: Nation[] = ["republique", "empire"];

describe("unit-info: the nations' cards (WP6)", () => {
  it("lists every unit and building of each nation's roster, once", () => {
    for (const n of NATIONS) {
      expect(unitGroups(n).flatMap((g) => g.kinds).sort()).toEqual([...ROSTERS[n].units].sort());
      expect(buildingGroups(n).flatMap((g) => g.kinds).sort()).toEqual([...ROSTERS[n].buildings].sort());
    }
  });

  it("renders every card of every army with no missing number or name", () => {
    for (const n of ["classique", ...NATIONS] as const) {
      for (const k of unitGroups(n).flatMap((g) => g.kinds)) expect(card(k, { nation: n }), `${n} ${k}`).not.toMatch(/undefined|NaN/);
      for (const k of buildingGroups(n).flatMap((g) => g.kinds))
        if (k !== "uplink" && k !== "supply-crate") expect(buildingCard(k as BuildingKind, { nation: n }), `${n} ${k}`).not.toMatch(/undefined|NaN/);
    }
  });

  it("names a nation's buildings its own way, with its mechanics", () => {
    const hq = buildingCard("hq", { nation: "empire" });
    expect(hq).toContain("Citadelle");
    expect(hq).toContain("Vapeur");
    const garage = buildingCard("fab-plant", { nation: "republique" });
    expect(garage).toContain("Garage électrique Jeantaud");
    expect(garage).toContain("Hors réseau : à l'arrêt");
    expect(card("fusiliers")).toContain("Tranchées");
    expect(card("mortier-280")).toContain("guetteur");
  });

  it("matches a nation's units up against the other nation's army only", () => {
    for (const n of NATIONS) {
      const foe = rosterOf(n === "republique" ? "empire" : "republique");
      for (const k of ROSTERS[n].units) {
        const links = [...card(k, { nation: n }).matchAll(/href="#([a-z]+)-([a-z0-9-]+)"/g)];
        for (const [, army, kind] of links) {
          expect(army, `${n} ${k} → ${kind}`).not.toBe(n);
          expect(foe.has(kind as never), `${n} ${k} → ${kind}`).toBe(true);
        }
      }
    }
  });

  it("leaves Classique's cards without nation tags or nations' kinds", () => {
    const c = card("stinger");
    expect(c).not.toContain("tag nation");
    expect(c).toContain('id="stinger"');
    expect(buildingCard("fab-plant")).not.toContain("Jamais-Contente");
  });
});
