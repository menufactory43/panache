/**
 * Provisional models for the nations' new kinds (PANACHE-CONCEPTION.md §3.2
 * WP0): until WP5 builds each one its own model, a new unit or defence is
 * drawn with the Classique model of the same role, painted in its nation's
 * colours (§1.1), so the rest of the work can go on. WP5 removes entries here
 * kind by kind as real models land in GROUND / AIR / BUILDINGS (belle/index.ts).
 *
 * Kept free of three.js so the sound and UI code can read it too.
 */
import type { ClassicBuildingKind, ClassicUnitKind, Faction, Nation, NationBuildingKind, NationOrClassic, NationUnitKind } from "../../../sim/types";

/**
 * The Classique unit that stands in for each new unit in the tables written
 * per Classique unit (withStandIns). (Its voice and HUD portrait are the
 * kind's own since WP5g: voices.ts, portraitKind.) Every new unit now has a model of
 * its own (PLACEHOLDER_MODEL is empty), in both styles: `?style=original`
 * draws the nations' Belle Époque models too.
 */
export const STAND_IN: Record<NationUnitKind, ClassicUnitKind> = {
  // République
  fourgon: "harvester",
  "jamais-contente": "stinger",
  "de-dion": "flak-crawler",
  branly: "mortar",
  sapeurs: "rocket-squad",
  zenith: "hornet",
  // Empire
  estafette: "stinger",
  "mortier-280": "mortar",
  gyroptere: "wasp",
  epervier: "raptor",
  vulcain: "hornet",
  atelier: "harvester",
  fusiliers: "trooper",
  carabiniers: "sniper",
  titan: "condor"
};

/**
 * The new units with a model of their own (WP5a–e: ground-rep.ts, ground-emp.ts,
 * air-emp.ts, zenith.ts; WP5d: the squad rigs in infantry.ts).
 */
const MODELLED: readonly NationUnitKind[] = [
  "fourgon", "jamais-contente", "de-dion", "branly", "sapeurs", "zenith",
  "estafette", "mortier-280", "gyroptere", "epervier", "vulcain", "atelier", "fusiliers", "carabiniers", "titan"
];

/** The new units still drawn with their stand-in's model (none left; kept for the next new kind). */
export const PLACEHOLDER_MODEL: Partial<Record<NationUnitKind, ClassicUnitKind>> = Object.fromEntries(
  Object.entries(STAND_IN).filter(([k]) => !MODELLED.includes(k as NationUnitKind))
);

/** The Classique building that stands in for each nation-only defence (in tables written per Classique building). */
export const STAND_IN_BUILDING: Record<NationBuildingKind, ClassicBuildingKind> = {
  arsonval: "turret",
  "flak-battery": "sam-site"
};

/** The nation-only defences still drawn with their stand-in in Belle Époque (none: buildings-rep.ts / buildings-emp.ts). */
export const PLACEHOLDER_BUILDING: Partial<Record<NationBuildingKind, ClassicBuildingKind>> = {};

/** A unit kind as the renderer draws it: itself, or the stand-in it still borrows a model (or squad rig) from. */
export const lookalike = (k: ClassicUnitKind | NationUnitKind): ClassicUnitKind | NationUnitKind =>
  (PLACEHOLDER_MODEL as Record<string, ClassicUnitKind>)[k] ?? k;

/** Same for buildings. */
export const buildingLookalike = (k: ClassicBuildingKind | NationBuildingKind): ClassicBuildingKind =>
  (PLACEHOLDER_BUILDING as Record<string, ClassicBuildingKind>)[k] ?? (k as ClassicBuildingKind);

export interface NationTeam {
  main: number;
  dark: number;
  light: number;
}

/**
 * Nation colours (§1.1): a nation's own on the blue seat, and the variant the
 * red seat takes (in a mirror match it must still read as the other side).
 * Placeholders are painted with these; the full nation colouring is WP6.
 */
export const NATION_TEAMS: Record<Nation, Record<Faction, NationTeam>> = {
  republique: {
    blue: { main: 0x1f3f8a, dark: 0x12264f, light: 0x6f8fd0 },
    // bleu horizon
    red: { main: 0x5b8fc8, dark: 0x2f5480, light: 0x9fc2e8 }
  },
  empire: {
    blue: { main: 0x7a1f2b, dark: 0x431018, light: 0xc0606a },
    // ocre-rouge
    red: { main: 0xa8502a, dark: 0x5c2a14, light: 0xd8906a }
  }
};

/** A per-unit table written for the 16 Classique units, completed for the new ones with their stand-ins' entries. */
export function withStandIns<T>(table: Record<ClassicUnitKind, T>): Record<ClassicUnitKind | NationUnitKind, T> {
  const out = { ...table } as Record<ClassicUnitKind | NationUnitKind, T>;
  for (const [k, base] of Object.entries(STAND_IN) as [NationUnitKind, ClassicUnitKind][]) out[k] = table[base];
  return out;
}

/**
 * The shared buildings a nation draws its own way (belle/index.ts BE_NATION_BUILDING_MODELS, less the
 * two nation-only defences): their portraits are shot per nation (tools/model-portraits.mjs kind@nation).
 */
export const NATION_PORTRAIT_BUILDINGS: Record<Nation, readonly ClassicBuildingKind[]> = {
  republique: ["fab-plant", "depot", "gantry"],
  empire: ["hq", "airpad", "tech-lab", "radar", "assembly-bay"]
};

/**
 * The portrait a kind shows (assets/icons/<name>.webp, red/<name>.webp for red): every unit and
 * nation-only defence its own (WP5g), and a shared building the nation draws its own way its
 * nation's ("hq-empire": the Citadelle); any other kind the Classique portrait.
 */
export const portraitKind = (k: string, nation?: NationOrClassic | null): string =>
  nation && nation !== "classique" && (NATION_PORTRAIT_BUILDINGS[nation] as readonly string[]).includes(k) ? `${k}-${nation}` : k;
