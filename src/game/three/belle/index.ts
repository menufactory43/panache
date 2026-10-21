import { AIR } from "./air";
import { AIR_EMP } from "./air-emp";
import { zenithModel } from "../zenith";
import { BUILDINGS, OBJECTIVES } from "./buildings";
import { GROUND } from "./ground";
import { GROUND_EMP } from "./ground-emp";
import { GROUND_REP } from "./ground-rep";

/** Belle Époque model overrides, used by models.ts when theme.ts BELLE_EPOQUE is on. */
export const BE_UNIT_MODELS = { ...GROUND, ...AIR, ...GROUND_REP, ...GROUND_EMP, ...AIR_EMP, zenith: zenithModel };
export const BE_BUILDING_MODELS = BUILDINGS;
export const BE_OBJECTIVES = OBJECTIVES;

/**
 * The nations' kinds (PANACHE-CONCEPTION.md §3.2). Registration skeleton:
 * WP5a–g add their builders to GROUND / AIR / BUILDINGS (or to new modules
 * spread into BE_UNIT_MODELS / BE_BUILDING_MODELS above: ground-rep.ts,
 * ground-emp.ts, air-emp.ts, buildings-rep.ts, buildings-emp.ts…) and remove
 * the kind from PLACEHOLDER_MODEL / PLACEHOLDER_BUILDING. Until then
 * models.ts draws a new kind with its stand-in's model in nation colours.
 */
export { NATION_TEAMS, PLACEHOLDER_BUILDING, PLACEHOLDER_MODEL, STAND_IN, buildingLookalike, lookalike } from "./placeholders";
