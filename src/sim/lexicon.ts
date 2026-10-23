/**
 * French grammar for the Belle Époque names in balance.ts and powers.ts:
 * gender, number and plural of each unit, building and power, so running
 * text agrees ("ta Patrie est détruite", "les Forges sont tombées").
 * Player-visible text only: nothing here is compared, sent or saved.
 */
import { BUILDINGS, NATION_BUILDINGS, UNITS } from "./balance";
import { EN, tr } from "../lang";
import type { BuildingKind, Nation, NationOrClassic, PowerKind, UnitKind } from "./types";

export type NamedKind = UnitKind | BuildingKind | PowerKind;

/**
 * Kinds whose French name is feminine (Patrie, Escouade, Section, Montgolfière, Forges, Polytechnique, Halles, Hotchkiss, Batterie, Tour, Manufacture, Galerie, Fée;
 * the nations': Jamais-Contente, Estafette, Bobine, Pression). The Classique
 * names: a shared building kind a nation renames (NATION_BUILDINGS) takes its
 * grammar from NATION_NAMES.
 */
export const FEMININE: ReadonlySet<NamedKind> = new Set<NamedKind>([
  "scout", "trooper", "rocket-squad", "sniper", "condor",
  "fab-plant", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry",
  "emp",
  "jamais-contente", "sapeurs", "estafette", "fusiliers", "carabiniers",
  "arsonval", "flak-battery",
  "pression"
]);

/** Kinds whose French name is already plural (les Forges, les Halles). */
export const PLURAL_NOUN: ReadonlySet<NamedKind> = new Set<NamedKind>(["fab-plant", "depot"]);

/**
 * Plurals. Makers' and aviators' names stay invariable, as French does with
 * brands ("deux Panhard", "trois Blériot"); common nouns take their -s.
 */
const PLURALS_FR: Record<UnitKind | BuildingKind, string> = {
  harvester: "Fardiers",
  scout: "Patries",
  stinger: "Panhard",
  "flak-crawler": "Faucheux",
  mortar: "Canons de 75",
  mastodon: "Creusot",
  lancer: "Hydroglisseurs",
  wasp: "Éole",
  raptor: "Blériot",
  hornet: "Albatros",
  mender: "Pasteur",
  trooper: "Escouades de pioupious",
  "rocket-squad": "Escouades d'artificiers",
  sniper: "Sections de chasseurs alpins",
  condor: "Montgolfières",
  goliath: "Gargantuas",
  hq: "GQG",
  "fab-plant": "Forges",
  airpad: "Parcs de Chalais-Meudon",
  "tech-lab": "Polytechnique",
  depot: "Halles",
  turret: "Hotchkiss",
  "sam-site": "Batteries Ruggieri",
  radar: "Tours TSF",
  "assembly-bay": "Manufactures",
  gantry: "Galeries des Machines",
  // the nations' units (PANACHE-CONCEPTION.md §1.5): the makers' names stay invariable
  // (deux Fourgons Jeantaud, deux Jamais-Contente), the machines' names take their -s
  fourgon: "Fourgons Jeantaud",
  "jamais-contente": "Jamais-Contente",
  "de-dion": "Autocanons De Dion",
  branly: "Canons Branly",
  sapeurs: "Escouades de sapeurs-électriciens",
  zenith: "Zéniths",
  estafette: "Estafettes",
  "mortier-280": "Mortiers de 280",
  gyroptere: "Gyroptères",
  epervier: "Éperviers",
  vulcain: "Vulcains",
  atelier: "Ateliers roulants",
  fusiliers: "Escouades de fusiliers",
  carabiniers: "Sections de carabiniers",
  titan: "Titans",
  arsonval: "Bobines d'Arsonval",
  "flak-battery": "Batteries de 47"
};

/** The English plurals (the makers' names take their -s in English: "two Panhards"). */
const PLURALS_EN: Record<UnitKind | BuildingKind, string> = {
  harvester: "Steam Wagons",
  scout: "Patries",
  stinger: "Panhards",
  "flak-crawler": "Daddy-Longlegs",
  mortar: "French 75s",
  mastodon: "Creusots",
  lancer: "Hydrogliders",
  wasp: "Éoles",
  raptor: "Blériots",
  hornet: "Albatroses",
  mender: "Pasteurs",
  trooper: "Poilu Squads",
  "rocket-squad": "Rocketeer Squads",
  sniper: "Alpine Chasseur Sections",
  condor: "Montgolfier Balloons",
  goliath: "Gargantuas",
  hq: "GHQs",
  "fab-plant": "Forges",
  airpad: "Chalais-Meudon Airparks",
  "tech-lab": "Polytechniques",
  depot: "Market Halls",
  turret: "Hotchkisses",
  "sam-site": "Ruggieri Batteries",
  radar: "Wireless Towers",
  "assembly-bay": "Manufactories",
  gantry: "Galeries des Machines",
  fourgon: "Jeantaud Vans",
  "jamais-contente": "Jamais-Contentes",
  "de-dion": "De Dion Autocannons",
  branly: "Branly Guns",
  sapeurs: "Electric Sapper Squads",
  zenith: "Zéniths",
  estafette: "Dispatch Riders",
  "mortier-280": "280 mm Mortars",
  gyroptere: "Gyropters",
  epervier: "Sparrowhawks",
  vulcain: "Vulcans",
  atelier: "Rolling Workshops",
  fusiliers: "Fusilier Squads",
  carabiniers: "Carabinier Sections",
  titan: "Titans",
  arsonval: "d'Arsonval Coils",
  "flak-battery": "47 mm Batteries"
};

export const PLURALS: Record<UnitKind | BuildingKind, string> = tr(PLURALS_FR, PLURALS_EN);

/** Grammar of a name: its gender, whether it is already plural, and its plural. */
export interface NameGrammar {
  feminine: boolean;
  pluralNoun: boolean;
  plural: string;
}

/**
 * The names a nation gives a shared building kind (balance.ts
 * NATION_BUILDINGS) that differ from the Classique one: "le Garage
 * électrique Jeantaud", "la Citadelle", "le Haut-fourneau".
 */
export const NATION_NAMES: Readonly<Record<string, NameGrammar>> = {
  "Garage électrique Jeantaud": { feminine: false, pluralNoun: false, plural: "Garages électriques Jeantaud" },
  "Station de charge": { feminine: true, pluralNoun: false, plural: "Stations de charge" },
  "Hangar du Zénith": { feminine: false, pluralNoun: false, plural: "Hangars du Zénith" },
  Citadelle: { feminine: true, pluralNoun: false, plural: "Citadelles" },
  "Aérodrome à vapeur": { feminine: false, pluralNoun: false, plural: "Aérodromes à vapeur" },
  "Haut-fourneau": { feminine: false, pluralNoun: false, plural: "Hauts-fourneaux" },
  "Ballon captif": { feminine: false, pluralNoun: false, plural: "Ballons captifs" },
  "Caserne-atelier": { feminine: true, pluralNoun: false, plural: "Casernes-ateliers" }
};

const isUnitKind = (k: UnitKind | BuildingKind): k is UnitKind => k in UNITS;

/**
 * A unit's or building's name as `nation` calls it (§1.10): the Empire's HQ is
 * the Citadelle, the République's Fab Plant the Garage électrique Jeantaud.
 * Without a nation (Classique), the BUILDINGS / UNITS name.
 */
export function displayName(kind: UnitKind | BuildingKind, nation?: NationOrClassic | null): string {
  if (isUnitKind(kind)) return UNITS[kind].name;
  const n = nation && nation !== "classique" ? NATION_BUILDINGS[nation as Nation][kind] : undefined;
  return n?.name ?? BUILDINGS[kind].name;
}

/** The grammar of a kind's name as `nation` calls it. */
export function grammarOf(kind: UnitKind | BuildingKind, nation?: NationOrClassic | null): NameGrammar {
  const own = NATION_NAMES[displayName(kind, nation)];
  if (own && !isUnitKind(kind) && displayName(kind, nation) !== BUILDINGS[kind].name) return own;
  return { feminine: FEMININE.has(kind), pluralNoun: PLURAL_NOUN.has(kind), plural: PLURALS[kind] };
}

/** "les Citadelles", "deux Fourgons Jeantaud": a kind's plural as `nation` calls it. */
export const pluralName = (kind: UnitKind | BuildingKind, nation?: NationOrClassic | null): string => grammarOf(kind, nation).plural;

/** Names starting with an aspirated h: no elision ("la Hotchkiss", "les Halles", "le Haut-fourneau", "le Hangar du Zénith"). */
const ASPIRATED = /^(Hotchkiss|Halles|Haut|Hangar)/;
/** Does the article elide before this word? ("l'Éole", "l'Hydroglisseur", but "la Hotchkiss"). */
export const elides = (word: string): boolean => !ASPIRATED.test(word) && /^[aeiouyéèêàâîôûh]/i.test(word);

const isPowerKind = (k: NamedKind): k is PowerKind => !(k in UNITS) && !(k in BUILDINGS);

/** Gender and number of the kind's name, as `nation` (absent: Classique) calls it. */
const gram = (k: NamedKind, nation?: NationOrClassic | null): { feminine: boolean; pluralNoun: boolean } =>
  isPowerKind(k) ? { feminine: FEMININE.has(k), pluralNoun: PLURAL_NOUN.has(k) } : grammarOf(k, nation);

export const isFeminine = (k: NamedKind | null | undefined, nation?: NationOrClassic | null): boolean => !!k && gram(k, nation).feminine;
export const isPluralNoun = (k: NamedKind | null | undefined, nation?: NationOrClassic | null): boolean => !!k && gram(k, nation).pluralNoun;

/**
 * An adjective or past participle agreed with the kind: agree("turret", "détruit") = "détruite", agree("fab-plant", "détruit") = "détruites".
 * French only: English text says its own word, `tr(agree(k, "détruit"), "destroyed")`.
 */
export const agree = (k: NamedKind | null | undefined, word: string, nation?: NationOrClassic | null): string =>
  `${word}${isFeminine(k, nation) ? "e" : ""}${isPluralNoun(k, nation) ? "s" : ""}`;

/** Definite article with the noun: "le Panhard", "la Patrie", "l'Éole", "les Forges" (English: "the Panhard"). */
export const theName = (k: NamedKind, name: string, nation?: NationOrClassic | null): string =>
  EN ? `the ${name}` : isPluralNoun(k, nation) ? `les ${name}` : elides(name) ? `l'${name}` : isFeminine(k, nation) ? `la ${name}` : `le ${name}`;

/** Indefinite article with the noun: "un Panhard", "une Patrie", "des Forges" (English: "a Panhard", "an Éole", "Forges"). */
export const aName = (k: NamedKind, name: string, nation?: NationOrClassic | null): string =>
  EN ? (isPluralNoun(k, nation) ? name : /^[aeioué]/i.test(name) ? `an ${name}` : `a ${name}`) : isPluralNoun(k, nation) ? `des ${name}` : isFeminine(k, nation) ? `une ${name}` : `un ${name}`;

/** "est" / "sont" for the kind as subject. */
export const isVerb = (k: NamedKind | null | undefined, nation?: NationOrClassic | null): string => (isPluralNoun(k, nation) ? tr("sont", "are") : tr("est", "is"));
