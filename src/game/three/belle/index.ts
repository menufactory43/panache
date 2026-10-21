import { AIR } from "./air";
import { BUILDINGS, OBJECTIVES } from "./buildings";
import { GROUND } from "./ground";

/** Belle Époque model overrides, used by models.ts when theme.ts BELLE_EPOQUE is on. */
export const BE_UNIT_MODELS = { ...GROUND, ...AIR };
export const BE_BUILDING_MODELS = BUILDINGS;
export const BE_OBJECTIVES = OBJECTIVES;
