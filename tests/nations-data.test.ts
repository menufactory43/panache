import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import {
  BUILDINGS, NATIONS, NATION_BUILDINGS, NATION_IDS, POD_CREWS, POWERS, POWER_SETS, ROLES, ROSTERS, UNITS, ZENITH
} from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { buildingBlocker, unitBlocker } from "../src/sim/economy";
import {
  FEMININE, NATION_NAMES, PLURALS, aName, agree, displayName, elides, grammarOf, isVerb, pluralName, theName
} from "../src/sim/lexicon";
import { createMapWorld } from "../src/sim/maps";
import { POWER_NAMES } from "../src/sim/powers";
import { bannedBy, inRoster, kindNation, nationOf, parseNations, rosterBan, rulesOf } from "../src/sim/rules";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { BuildingKind, Nation, PowerKind, Role, UnitKind } from "../src/sim/types";
import { spawnBuilding, spawnUnit } from "../src/sim/world";
import { PLACEHOLDER_BUILDING, PLACEHOLDER_MODEL, STAND_IN, STAND_IN_BUILDING, lookalike, portraitKind, withStandIns } from "../src/game/three/belle/placeholders";
import { BELLE_VOICES, VOICES } from "../src/game/voices";

/** PANACHE-CONCEPTION.md §1 and §3.2 WP0: the nations' types and data, and Classique left alone. */

const ALL_UNITS = Object.keys(UNITS) as UnitKind[];
const ALL_BUILDINGS = Object.keys(BUILDINGS) as BuildingKind[];
const CLASSIC_UNITS: UnitKind[] = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet",
  "mender", "trooper", "rocket-squad", "sniper", "condor", "goliath"
];
const NEW_UNITS: UnitKind[] = [
  "fourgon", "jamais-contente", "de-dion", "branly", "sapeurs", "zenith",
  "estafette", "mortier-280", "gyroptere", "epervier", "vulcain", "atelier", "fusiliers", "carabiniers", "titan"
];
const NEW_POWERS: PowerKind[] = ["sonde", "curie", "gaz", "pression"];

describe("the nations' data", () => {
  it("keeps Classique's 16 units first, in their order, then the 15 new ones", () => {
    expect(ALL_UNITS.slice(0, 16)).toEqual(CLASSIC_UNITS);
    expect(ALL_UNITS.slice(16)).toEqual(NEW_UNITS);
    expect(ALL_BUILDINGS.slice(0, 10)).toEqual(["hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry"]);
    expect(ALL_BUILDINGS.slice(10)).toEqual(["arsonval", "flak-battery"]);
  });

  it("gives every new kind a nation, and none of Classique's", () => {
    for (const k of CLASSIC_UNITS) expect(UNITS[k].nation, k).toBeUndefined();
    for (const k of NEW_UNITS) expect(NATION_IDS, k).toContain(UNITS[k].nation);
    expect(BUILDINGS.arsonval).toMatchObject({ nation: "republique", base: "turret" });
    expect(BUILDINGS["flak-battery"]).toMatchObject({ nation: "empire", base: "sam-site" });
    // the behaviours they reuse (§1.5)
    expect(UNITS.fourgon).toMatchObject({ base: "harvester", cargo: 80 });
    expect(UNITS.zenith).toMatchObject({ base: "goliath", domain: "air" });
    expect(UNITS.atelier).toMatchObject({ base: "mender", healTargets: "ground" });
    expect(UNITS.fusiliers.base).toBe("trooper");
    expect(UNITS.carabiniers.base).toBe("sniper");
    expect(UNITS.titan).toMatchObject({ base: "condor", capacity: 3 });
    for (const k of ALL_UNITS) {
      const b = UNITS[k].base;
      if (b) expect(UNITS[b].nation, `${k}'s base ${b}`).toBeUndefined();
    }
  });

  it("splits the 16 Classique units 9 / 7 and shares none (§1.3)", () => {
    const rep = ROSTERS.republique.units;
    const emp = ROSTERS.empire.units;
    expect(rep.filter((k) => !UNITS[k].nation)).toHaveLength(9);
    expect(emp.filter((k) => !UNITS[k].nation)).toHaveLength(7);
    expect(rep.length).toBe(15);
    expect(emp.length).toBe(16);
    expect(rep.filter((k) => emp.includes(k))).toEqual([]);
    expect(new Set([...rep, ...emp])).toEqual(new Set(ALL_UNITS));
    for (const n of NATION_IDS) for (const k of ROSTERS[n].units) if (UNITS[k].nation) expect(UNITS[k].nation, k).toBe(n);
    // every factory a roster unit needs is in the roster
    for (const n of NATION_IDS)
      for (const k of ROSTERS[n].units) {
        expect(ROSTERS[n].buildings, `${n} ${k}`).toContain(UNITS[k].builtAt);
        const req = UNITS[k].requires;
        if (req) expect(ROSTERS[n].buildings, `${n} ${k}`).toContain(req);
      }
  });

  it("fills every role from each nation's own roster (§1.4, §1.9)", () => {
    const roles = Object.keys(ROLES.classique) as Role[];
    expect(roles).toHaveLength(17);
    for (const n of NATION_IDS) {
      expect(Object.keys(ROLES[n]).sort()).toEqual([...roles].sort());
      for (const r of roles) expect(ROSTERS[n].units, `${n} ${r}`).toContain(ROLES[n][r]);
    }
    for (const r of roles) expect(UNITS[ROLES.classique[r]].nation, r).toBeUndefined();
  });

  it("gives each nation its buildings: shared kinds under its names, its own defences", () => {
    expect(ROSTERS.republique.buildings).toContain("arsonval");
    expect(ROSTERS.republique.buildings).not.toContain("turret");
    expect(ROSTERS.empire.buildings).toContain("flak-battery");
    expect(ROSTERS.empire.buildings).not.toContain("sam-site");
    for (const n of NATION_IDS) {
      expect(ROSTERS[n].buildings).toContain("hq");
      for (const k of Object.keys(NATION_BUILDINGS[n]) as BuildingKind[]) expect(ROSTERS[n].buildings).toContain(k);
    }
    expect(displayName("hq", "empire")).toBe("Citadelle");
    expect(displayName("hq", "republique")).toBe("GQG");
    expect(displayName("fab-plant", "republique")).toBe("Garage électrique Jeantaud");
    expect(displayName("fab-plant", "empire")).toBe("Forges");
    expect(displayName("radar", "empire")).toBe("Ballon captif");
    expect(displayName("gantry", "republique")).toBe("Hangar du Zénith");
    expect(displayName("tech-lab", "empire")).toBe("Haut-fourneau");
    expect(displayName("fab-plant")).toBe("Forges");
    expect(displayName("fab-plant", "classique")).toBe("Forges");
    expect(displayName("zenith", "republique")).toBe("Zénith");
  });

  it("has the nations' numbers (§1.2) and the Zénith's weapons (§1.5)", () => {
    expect(NATIONS.republique).toMatchObject({ radiumValue: 2.0, buildingCost: 0.85, unitTime: 0.85, parallel: 1, towerCost: 150 });
    expect(NATIONS.empire).toMatchObject({ coalRate: 1.15, buildingHp: 1.25, unitTime: 1.3, parallel: 2 });
    expect(NATIONS.empire.trench).toEqual({ still: 3, mult: 0.9, redoubtRadius: 2.5 });
    expect(Object.keys(ZENITH.weapons)).toEqual(["branly", "arc", "bombs", "mg"]);
    expect(Object.values(ZENITH.weapons).map((x) => x.lostBelow)).toEqual([0.75, 0.5, 0.25, 0]);
    expect(ZENITH.trains).toEqual(["wasp", "raptor", "mender", "scout"]);
  });

  it("has the nations' powers (§1.7)", () => {
    expect(POWER_SETS.classique).toEqual(["barrage", "emp", "droppod", "hammer"]);
    expect(POWER_SETS.republique).toEqual(["sonde", "emp", "droppod", "curie"]);
    expect(POWER_SETS.empire).toEqual(["barrage", "gaz", "pression", "hammer"]);
    for (const p of NEW_POWERS) expect(POWER_NAMES[p], p).toBeTruthy();
    expect(POWERS.curie).toMatchObject({ unitDamage: 300, buildingDamage: 450, radius: 2.2 });
    for (const n of NATION_IDS) {
      expect(!!POD_CREWS[n], n).toBe(POWER_SETS[n].includes("droppod"));
      for (const k of [...(POD_CREWS[n]?.units ?? []), ...(POD_CREWS[n]?.techUnits ?? [])]) expect(ROSTERS[n].units, `${n} pod ${k}`).toContain(k);
    }
  });
});

describe("rosters and bans", () => {
  const nations = (blue: Nation, red: Nation) => createMapWorld("riverlands", { seed: 3, nations: { blue, red } });

  it("Classique: no rules, every nation's own kind banned, Classique's kinds as before", () => {
    const w = createMapWorld("riverlands", { seed: 3 });
    expect(w.rules).toBeUndefined();
    expect(nationOf(w, "blue")).toBe("classique");
    for (const k of [...NEW_UNITS, "arsonval", "flak-battery"] as (UnitKind | BuildingKind)[]) {
      expect(bannedBy(w, k, "blue"), k).toMatch(/^Réservé à (la République|l'Empire de Carbonie)$/);
      expect(bannedBy(w, k), k).not.toBeNull();
    }
    for (const k of [...CLASSIC_UNITS, ...ALL_BUILDINGS.slice(0, 10)]) expect(bannedBy(w, k, "red"), k).toBeNull();
    expect(unitBlocker(w, "blue", "fourgon")).toBe("Réservé à la République");
    expect(buildingBlocker(w, "blue", "flak-battery")).toBe("Réservé à l'Empire de Carbonie");
  });

  it("nations: each side fields its own roster and nothing of the other's", () => {
    const w = nations("republique", "empire");
    expect(rulesOf(w).nations).toEqual({ blue: "republique", red: "empire" });
    expect(nationOf(w, "blue")).toBe("republique");
    expect(nationOf(w, "red")).toBe("empire");
    for (const k of ALL_UNITS) {
      expect(bannedBy(w, k, "blue") === null, `blue ${k}`).toBe(ROSTERS.republique.units.includes(k));
      expect(bannedBy(w, k, "red") === null, `red ${k}`).toBe(ROSTERS.empire.units.includes(k));
      expect(bannedBy(w, k), k).toBeNull(); // one side or the other fields every unit
    }
    expect(bannedBy(w, "harvester", "blue")).toBe("Réservé à l'Empire de Carbonie");
    expect(bannedBy(w, "turret", "blue")).toBe("Réservé à l'Empire de Carbonie");
    expect(bannedBy(w, "sam-site", "red")).toBe("Réservé à la République");
    expect(bannedBy(w, "arsonval", "blue")).toBeNull();
    // a mirror match: the other nation's kinds are banned for both
    const m = nations("empire", "empire");
    expect(bannedBy(m, "fourgon")).toBe("Réservé à la République");
    expect(bannedBy(m, "titan", "blue")).toBeNull();
  });

  it("mutators still ban under nations, with their own reason", () => {
    const w = createMapWorld("riverlands", { seed: 3, nations: { blue: "republique", red: "empire" }, mutators: ["airwar"] });
    expect(bannedBy(w, "jamais-contente", "blue")).toMatch(/Guerre aérienne/);
    expect(bannedBy(w, "fusiliers", "red")).toMatch(/Guerre aérienne/);
    expect(bannedBy(w, "jamais-contente", "red")).toBe("Réservé à la République");
  });

  it("a nations match needs both sides' nation, else it is Classique", () => {
    expect(parseNations("republique,empire")).toEqual({ blue: "republique", red: "empire" });
    expect(parseNations("emp,rep")).toEqual({ blue: "empire", red: "republique" });
    expect(parseNations("empire")).toBeNull();
    expect(parseNations("france,empire")).toBeNull();
    expect(parseNations(null)).toBeNull();
    const w = createMapWorld("riverlands", { seed: 3, nations: { blue: "empire" } });
    expect(w.rules).toBeUndefined();
  });

  it("kindNation / inRoster / rosterBan agree", () => {
    expect(kindNation("zenith")).toBe("republique");
    expect(kindNation("goliath")).toBeNull();
    expect(inRoster("classique", "goliath")).toBe(true);
    expect(inRoster("classique", "titan")).toBe(false);
    expect(inRoster("republique", "goliath")).toBe(false);
    expect(inRoster("empire", "goliath")).toBe(true);
    const w = createMapWorld("riverlands", { seed: 3 });
    expect(rosterBan(w, "mender", "blue")).toBeNull();
  });
});

describe("a nations match runs", () => {
  it("setupWorld carries the nations, deterministically", () => {
    const setup = { map: "riverlands", seed: 9, mutators: [], openers: {}, nations: { blue: "republique", red: "empire" } } as const;
    const a = setupWorld({ ...setup, mutators: [], openers: {}, nations: { ...setup.nations } });
    const b = setupWorld({ ...setup, mutators: [], openers: {}, nations: { ...setup.nations } });
    expect(nationOf(a, "red")).toBe("empire");
    const sa = createAiState("balanced", "normal", 1);
    const sb = createAiState("balanced", "normal", 1);
    const ra = createAiState("rush", "normal", 2);
    const rb = createAiState("rush", "normal", 2);
    for (let i = 0; i < 3 * 600; i++) {
      step(a, [...tickAi(a, "blue", sa), ...tickAi(a, "red", ra)]);
      step(b, [...tickAi(b, "blue", sb), ...tickAi(b, "red", rb)]);
    }
    expect(worldHash(a)).toBe(worldHash(b));
    // (the AI plays the nations through WP3: here it only must not field the other's kinds)
    for (const u of a.units.values()) expect(inRoster(nationOf(a, u.faction), u.kind) || u.kind === "harvester" || u.kind === "trooper", `${u.faction} ${u.kind}`).toBe(true);
  }, 60000);

  it("every new kind spawns, fights and dies without breaking the sim", () => {
    const w = createMapWorld("proving-grounds", { seed: 5, nations: { blue: "republique", red: "empire" } });
    const ids: number[] = [];
    NEW_UNITS.forEach((k, i) => {
      const f = UNITS[k].nation === "republique" ? "blue" : "red";
      ids.push(spawnUnit(w, k, f, 20 + (i % 5) * 1.2 + (f === "red" ? 3 : 0), 20 + Math.floor(i / 5) * 1.2).id);
    });
    spawnBuilding(w, "arsonval", "blue", 18, 24);
    spawnBuilding(w, "flak-battery", "red", 27, 24);
    for (let i = 0; i < 60 * 10; i++) step(w, []);
    expect(w.tick).toBe(600);
  });
});

describe("the nations' names in French (lexicon)", () => {
  const names = [...NEW_UNITS, "arsonval", "flak-battery"] as (UnitKind | BuildingKind)[];

  it("has a plural for every unit and building", () => {
    for (const k of [...ALL_UNITS, ...ALL_BUILDINGS]) expect(PLURALS[k], k).toBeTruthy();
    for (const n of NATION_IDS)
      for (const k of Object.keys(NATION_BUILDINGS[n]) as BuildingKind[]) {
        const name = displayName(k, n);
        if (name !== BUILDINGS[k].name) expect(NATION_NAMES[name], name).toBeDefined();
      }
  });

  it("agrees each new name's gender, number and elision", () => {
    const the = (k: UnitKind | BuildingKind, n?: Nation) => theName(k, displayName(k, n), n);
    const a = (k: UnitKind | BuildingKind, n?: Nation) => aName(k, displayName(k, n), n);
    expect(names.map((k) => the(k))).toEqual([
      "le Fourgon Jeantaud", "la Jamais-Contente", "l'Autocanon De Dion", "le Canon Branly",
      "l'Escouade de sapeurs-électriciens", "le Zénith",
      "l'Estafette", "le Mortier de 280", "le Gyroptère", "l'Épervier", "le Vulcain", "l'Atelier roulant",
      "l'Escouade de fusiliers", "la Section de carabiniers", "le Titan",
      "la Bobine d'Arsonval", "la Batterie de 47"
    ]);
    expect(names.map((k) => a(k))).toEqual([
      "un Fourgon Jeantaud", "une Jamais-Contente", "un Autocanon De Dion", "un Canon Branly",
      "une Escouade de sapeurs-électriciens", "un Zénith",
      "une Estafette", "un Mortier de 280", "un Gyroptère", "un Épervier", "un Vulcain", "un Atelier roulant",
      "une Escouade de fusiliers", "une Section de carabiniers", "un Titan",
      "une Bobine d'Arsonval", "une Batterie de 47"
    ]);
    expect(names.map((k) => pluralName(k))).toEqual([
      "Fourgons Jeantaud", "Jamais-Contente", "Autocanons De Dion", "Canons Branly",
      "Escouades de sapeurs-électriciens", "Zéniths",
      "Estafettes", "Mortiers de 280", "Gyroptères", "Éperviers", "Vulcains", "Ateliers roulants",
      "Escouades de fusiliers", "Sections de carabiniers", "Titans",
      "Bobines d'Arsonval", "Batteries de 47"
    ]);
    expect(agree("estafette", "détruit")).toBe("détruite");
    expect(agree("arsonval", "détruit")).toBe("détruite");
    expect(agree("titan", "détruit")).toBe("détruit");
  });

  it("agrees the buildings a nation renames", () => {
    const the = (k: BuildingKind, n: Nation) => theName(k, displayName(k, n), n);
    expect(the("hq", "empire")).toBe("la Citadelle");
    expect(agree("hq", "détruit", "empire")).toBe("détruite");
    expect(agree("hq", "détruit", "republique")).toBe("détruit");
    expect(the("fab-plant", "republique")).toBe("le Garage électrique Jeantaud");
    expect(agree("fab-plant", "détruit", "republique")).toBe("détruit");
    expect(isVerb("fab-plant", "republique")).toBe("est");
    expect(the("fab-plant", "empire")).toBe("les Forges");
    expect(isVerb("fab-plant", "empire")).toBe("sont");
    expect(the("depot", "republique")).toBe("la Station de charge");
    expect(the("depot", "empire")).toBe("les Halles");
    expect(the("tech-lab", "empire")).toBe("le Haut-fourneau"); // aspirated h: no elision
    expect(the("gantry", "republique")).toBe("le Hangar du Zénith");
    expect(the("airpad", "empire")).toBe("l'Aérodrome à vapeur");
    expect(the("radar", "empire")).toBe("le Ballon captif");
    expect(the("radar", "republique")).toBe("la Tour TSF");
    expect(the("assembly-bay", "empire")).toBe("la Caserne-atelier");
    expect(pluralName("tech-lab", "empire")).toBe("Hauts-fourneaux");
    expect(pluralName("assembly-bay", "empire")).toBe("Casernes-ateliers");
    expect(pluralName("hq", "empire")).toBe("Citadelles");
    expect(grammarOf("fab-plant")).toEqual({ feminine: true, pluralNoun: true, plural: "Forges" });
    expect(elides("Haut-fourneau")).toBe(false);
    expect(elides("Hydroglisseur")).toBe(true);
  });

  it("agrees the nations' powers", () => {
    const the = (p: PowerKind) => theName(p, POWER_NAMES[p]);
    expect(NEW_POWERS.map(the)).toEqual(["le Ballon-sonde", "le Rayon Curie", "le Gaz de houille", "la Pression des chaudières"]);
    expect(FEMININE.has("pression")).toBe(true);
  });
});

describe("placeholders until the models land (WP5)", () => {
  it("draws every new kind with a Classique stand-in of its domain", () => {
    expect(Object.keys(STAND_IN).sort()).toEqual([...NEW_UNITS].sort());
    // (every new kind has its own model now: no placeholder left, the renderer draws each as itself)
    expect(PLACEHOLDER_MODEL).toEqual({});
    expect(PLACEHOLDER_BUILDING).toEqual({});
    for (const k of NEW_UNITS) expect(lookalike(k as keyof typeof STAND_IN)).toBe(k);
    for (const k of NEW_UNITS) {
      const base = STAND_IN[k as keyof typeof STAND_IN];
      expect(UNITS[base].nation, k).toBeUndefined();
      expect(UNITS[base].domain, k).toBe(UNITS[k].domain);
      expect(!!UNITS[base].squad, k).toBe(!!UNITS[k].squad);
      // (its HUD portrait is its own since WP5g)
      expect(portraitKind(k)).toBe(k);
    }
    expect(STAND_IN_BUILDING).toEqual({ arsonval: "turret", "flak-battery": "sam-site" });
    expect(portraitKind("arsonval")).toBe("arsonval");
    expect(portraitKind("hq")).toBe("hq");
  });

  it("completes per-unit tables (voices) for every kind", () => {
    for (const k of ALL_UNITS) {
      expect(VOICES[k], k).toBeDefined();
      expect(BELLE_VOICES[k], k).toBeDefined();
    }
    const t = withStandIns(Object.fromEntries(CLASSIC_UNITS.map((k) => [k, k])) as Record<(typeof CLASSIC_UNITS)[number] & string, string>);
    expect(t.titan).toBe("condor");
  });
});

describe("every kind has a model (provisional or its own)", () => {
  it("builds a model and a scale for every unit and building on both sides", async () => {
    const { buildingDef, unitDef, unitScale } = await import("../src/game/three/models");
    for (const k of ALL_UNITS)
      for (const f of ["blue", "red"] as const) {
        const d = unitDef(k, f);
        expect(d.hull.attributes.position!.count, `${f} ${k}`).toBeGreaterThan(0);
        expect(Number.isFinite(unitScale(k)) && unitScale(k) > 0, k).toBe(true);
      }
    for (const k of ALL_BUILDINGS) for (const f of ["blue", "red"] as const) expect(buildingDef(k, f).hull, `${f} ${k}`).toBeDefined();
  });
});
