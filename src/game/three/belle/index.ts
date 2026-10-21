import { AIR } from "./air";
import { BUILDINGS, OBJECTIVES } from "./buildings";
import { GROUND } from "./ground";
import { nationSquadDef } from "../infantry";
import { BUILDINGS_EMP } from "./buildings-emp";
import { BUILDINGS_REP } from "./buildings-rep";
import { LANDMARKS } from "./landmarks";
import type { BuildingKind, Nation } from "../../../sim/types";
import type { ModelDef, Team } from "../models";

/** The nations' squads (infantry.ts; called late: infantry.ts and this module import each other through models.ts). */
const NATION_SQUADS = {
  sapeurs: (t: Team) => nationSquadDef("sapeurs", t),
  fusiliers: (t: Team) => nationSquadDef("fusiliers", t),
  carabiniers: (t: Team) => nationSquadDef("carabiniers", t)
};

/** Belle Époque model overrides, used by models.ts when theme.ts BELLE_EPOQUE is on. */
export const BE_UNIT_MODELS = { ...GROUND, ...AIR, ...NATION_SQUADS };
export const BE_BUILDING_MODELS = BUILDINGS;
export const BE_OBJECTIVES = OBJECTIVES;

/**
 * A nation's own building models (§1.6, WP5f): for its two defences
 * (arsonval, flak-battery) and for the shared kinds it draws its own way
 * (Garage, Station de charge, Hangar du Zénith; Citadelle, Aérodrome,
 * Haut-fourneau, Ballon captif, Caserne-atelier). models.ts buildingDef(kind,
 * f, nation) paints them in NATION_TEAMS[nation][f]; a shared kind not listed
 * keeps its Belle Époque model (GQG, Forges, Halles…).
 */
export const BE_NATION_BUILDING_MODELS: Record<Nation, Partial<Record<BuildingKind, (t: Team) => ModelDef>>> = {
  republique: BUILDINGS_REP,
  empire: BUILDINGS_EMP
};

/** Campaign landmarks (the Eiffel Tower): models.ts landmarkDef. */
export const BE_LANDMARKS = LANDMARKS;
export type { LandmarkKind } from "./landmarks";

/**
 * The nations' kinds (PANACHE-CONCEPTION.md §3.2). Registration skeleton:
 * WP5a–g add their builders to GROUND / AIR / BUILDINGS (or to new modules
 * spread into BE_UNIT_MODELS / BE_BUILDING_MODELS above: ground-rep.ts,
 * ground-emp.ts, air-emp.ts, buildings-rep.ts, buildings-emp.ts…) and remove
 * the kind from PLACEHOLDER_MODEL / PLACEHOLDER_BUILDING. Until then
 * models.ts draws a new kind with its stand-in's model in nation colours.
 */
export { NATION_TEAMS, PLACEHOLDER_BUILDING, PLACEHOLDER_MODEL, STAND_IN, STAND_IN_BUILDING, buildingLookalike, lookalike } from "./placeholders";
